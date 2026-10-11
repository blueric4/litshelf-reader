/**
 * 全篇扫描：多栏页上"在某一栏内纵向拖 2~3 行"是否**完全落在该栏内**（跨栏回归网）。
 *
 * 判据（**只有它算跨栏**）：选区非空，且**没有任何一条 rect 的中心**落在"按下那一栏"之外
 * （中心允许 ±15px 容差 —— 栏内自带的长行本来就会伸进栏缝，那是版式事实，不算泄漏）。
 * 这类"右端伸出栏边界"的 rect 会单独打印出来（`宽行`），便于人工确认它是不是栏内长行。
 *
 * 独立于产品实现：栏边界由**页内 DOM span 的 y 带覆盖率模型**算出（不读产品的栏带/分区日志），
 * 所以既能发现"夹取被关掉"，也能发现"夹取夹错栏"。
 *
 * 用法：`node tools/col-scan.mjs [论文名子串]`
 *   · 只跑某篇：`node tools/col-scan.mjs 苏敬勤`
 *   · 隔离数据目录：`LITSHELF_DATA_DIR`（默认 `tmp/col-scan-data`，会从真实用户数据目录
 *     只读复制 `library.json`/`settings.json`，**不复制 PDF**）
 *   · 真实文献目录：`LITSHELF_SRC_LIB`（默认 `~/Desktop/文献`）。若隔离库里没有任何中文 PDF
 *     （全新环境），脚本会用 `window.litshelf.invoke('addRoot', [目录])` 现场入库并等解析完成。
 *   · 端口：`LITSHELF_SCAN_PORT`（默认 9333）；跑前后只 kill 自己 spawn 的 Electron
 *   · 页数上限 30 页/篇；单栏页（独立模型 <2 栏）自动跳过
 * 输出：逐页一行 `页N：M栏 栏1=[a~b] 选区x=[c~d] N字 rect=K 越界rect=0 ✓｜末栏=…`，末尾给失败清单与汇总。
 * 退出码：有失败 = 1，全通过 = 0（含"跳过"不算失败）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PORT = Number(process.env.LITSHELF_SCAN_PORT || 9333);
const DATA = process.env.LITSHELF_DATA_DIR || path.join(ROOT, 'tmp', 'col-scan-data');
const NAME_FILTER = process.argv[2] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 真实用户数据目录里的 library.json / settings.json（只读复制） */
const REAL = path.join(os.homedir(), 'AppData', 'Roaming', '文献架 LitShelf');

await fs.rm(DATA, { recursive: true, force: true }).catch(() => {});
await fs.mkdir(DATA, { recursive: true });
for (const f of ['library.json', 'settings.json']) {
  await fs.copyFile(path.join(REAL, f), path.join(DATA, f)).catch(() => {});
}

const env = { ...process.env, LITSHELF_DATA_DIR: DATA };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [`--remote-debugging-port=${PORT}`, '.'], {
  cwd: ROOT,
  env,
  stdio: 'ignore',
});

let target = null;
for (let i = 0; i < 150; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (p) {
      target = p;
      break;
    }
  } catch {
    /* 还没起来 */
  }
  await sleep(400);
}
if (!target) {
  console.log('扫描中止：没等到 Electron 页面');
  process.exit(2);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  }
});
const send = (method, params = {}, ms = 120000) =>
  new Promise((resolve, reject) => {
    const i = ++seq;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => {
      if (pending.has(i)) {
        pending.delete(i);
        reject(new Error(`CDP 超时 ${method}`));
      }
    }, ms);
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};
const mouse = (type, x, y) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const pressKey = async (key, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  await sleep(1500);
};

await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
await sleep(5000);
await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('跳过')); if (b) b.click(); return true; })()`);
await sleep(800);

/** 页内独立栏模型（DOM span 的 y 带覆盖率；与产品实现无关） */
const MODEL = (pageNo) => `
  (() => {
    const page = document.querySelector('.rd-pdf-page[data-page-index="${pageNo}"]');
    if (!page) return null;
    const pr = page.getBoundingClientRect();
    const spans = [...page.querySelectorAll('.rd-pdf-text span')]
      .filter((s) => (s.textContent || '').trim().length > 1)
      .map((s) => ({ s, r: s.getBoundingClientRect() }))
      .filter((x) => x.r.width > 1 && x.r.height > 1);
    if (spans.length < 8) return null;
    const minX = Math.min(...spans.map((x) => x.r.left - pr.left));
    const maxX = Math.max(...spans.map((x) => x.r.right - pr.left));
    const hs = spans.map((x) => x.r.height).sort((a, b) => a - b);
    const medH = hs[Math.floor(hs.length / 2)] || 12;
    const minY = Math.min(...spans.map((x) => x.r.top - pr.top));
    const maxY = Math.max(...spans.map((x) => x.r.bottom - pr.top));
    const contentH = Math.max(1, maxY - minY);
    const bandSize = Math.max(medH * 2, contentH / 32);
    const bandCount = Math.max(1, Math.ceil(contentH / bandSize));
    const W = Math.ceil(maxX - minX) + 1;
    const cov = new Uint16Array(W);
    for (const { r } of spans) {
      const k0 = Math.min(bandCount - 1, Math.max(0, Math.floor((r.top - pr.top - minY) / bandSize)));
      const k1 = Math.min(bandCount - 1, Math.max(0, Math.floor((r.bottom - pr.top - minY) / bandSize)));
      const a = Math.max(0, Math.floor(r.left - pr.left - minX));
      const b = Math.min(W - 1, Math.ceil(r.right - pr.left - minX));
      for (let k = k0; k <= k1; k += 1) for (let i = a; i <= b; i += 1) cov[i] += 1;
    }
    const maxCover = Math.max(1, Math.round(bandCount * 0.35));
    const gapMin = Math.max(1, pr.width * 0.008);
    const guts = [];
    let run = 0;
    for (let i = 1; i <= W; i += 1) {
      if (i < W && cov[i] <= maxCover) { run += 1; continue; }
      if (run >= gapMin) guts.push({ s: Math.round(minX + i - run), e: Math.round(minX + i) });
      run = 0;
    }
    const bands = [];
    let st = minX;
    for (const g of guts) { bands.push({ s: Math.round(st), e: Math.round(g.s) }); st = g.e; }
    bands.push({ s: Math.round(st), e: Math.round(maxX) });
    const minBand = pr.width * 0.15;
    const kept = bands.filter((b) => b.e - b.s >= minBand);
    return { pw: Math.round(pr.width), spans: spans.length, bands: kept.length ? kept : bands };
  })()
`;

const pageExists = (n) => ev(`(() => !!document.querySelector('.rd-pdf-page[data-page-index="${n}"]'))()`);
const pageVisible = (n) =>
  ev(`(() => { const p = document.querySelector('.rd-pdf-page[data-page-index="${n}"]'); if (!p) return 0; const pr = p.getBoundingClientRect(); const sc = document.querySelector('.rd-pdf-scroll').getBoundingClientRect(); return (pr.bottom > sc.top + 80 && pr.top < sc.bottom - 80) ? 1 : 0; })()`);
const mountedPages = () => ev(`(() => [...document.querySelectorAll('.rd-pdf-page')].map((p) => Number(p.dataset.pageIndex)).sort((a, b) => a - b))()`);

/** 到第 n 页（用真实键盘翻页；只在必要方向上走） */
const gotoPage = async (n) => {
  for (let i = 0; i < 8; i += 1) {
    if (await pageVisible(n)) return true;
    const ps = await mountedPages();
    const cur = ps.length ? ps[0] : 1;
    await pressKey(cur >= n ? 'PageUp' : 'PageDown', cur >= n ? 'PageUp' : 'PageDown', cur >= n ? 33 : 34);
  }
  return !!(await pageVisible(n));
};

/** 取样：在某栏内取"竖向相隔 2~4 行"的两个 span（都在视口内、都完整落在该栏内） */
const pickPair = (pageNo, band) => ev(`
  (() => {
    const page = document.querySelector('.rd-pdf-page[data-page-index="${pageNo}"]');
    if (!page) return null;
    const pr = page.getBoundingClientRect();
    const sc = document.querySelector('.rd-pdf-scroll').getBoundingClientRect();
    const cand = [...page.querySelectorAll('.rd-pdf-text span')]
      .filter((s) => (s.textContent || '').trim().length > 3)
      .map((s) => ({ s, r: s.getBoundingClientRect() }))
      .filter((x) => {
        const l = x.r.left - pr.left, r = x.r.right - pr.left;
        return l >= ${band.s} + 2 && r <= ${band.e} - 2 && x.r.top > sc.top + 110 && x.r.bottom < sc.bottom - 70;
      });
    cand.sort((a, b) => a.r.top - b.r.top);
    if (cand.length < 2) return null;
    const y1 = cand[Math.floor(cand.length * 0.2)];
    const rest = cand.filter((x) => x.r.top - y1.r.top > y1.r.height * 1.5);
    const y2 = rest.length ? rest[Math.min(rest.length - 1, Math.floor(rest.length * 0.6))] : cand[cand.length - 1];
    return {
      a: { x: Math.round(y1.r.left + 8), y: Math.round(y1.r.top + y1.r.height / 2), t: (y1.s.textContent || '').slice(0, 8) },
      b: { x: Math.round(y2.r.left + 8), y: Math.round(y2.r.top + y2.r.height / 2), t: (y2.s.textContent || '').slice(0, 8) },
    };
  })()
`);

/**
 * 选区信息。判定口径：**每一条 rect 的中心**是否落在按下的那一栏里。
 * 只用 min/max 会把"栏内自带的长行伸进栏缝 8~10px"误判成跨栏（那是版式事实），
 * 而真正的跨栏泄漏一定表现为"有 rect 的中心落在别的栏里"。
 */
const selInfo = (pageNo, band) => ev(`
  (() => {
    const s = window.getSelection();
    const p = document.querySelector('.rd-pdf-page[data-page-index="${pageNo}"]');
    if (!p) return { len: -1, n: 0, minX: 0, maxX: 0, outside: -1 };
    const pr = p.getBoundingClientRect();
    const rs = s && s.rangeCount ? [...s.getRangeAt(0).getClientRects()] : [];
    const outside = rs.filter((q) => { const c = (q.left + q.right) / 2 - pr.left; return c < ${band.s} - 15 || c > ${band.e} + 15; }).length;
    /** 右端伸出栏边界的 rect（栏内长行的嫌疑；给出 x 区间与所属 span 文字，供人工确认版式自带） */
    const wide = rs
      .filter((q) => q.right - pr.left > ${band.e} + 6)
      .slice(0, 3)
      .map((q) => {
        const l = Math.round(q.left - pr.left), r = Math.round(q.right - pr.left);
        const hit = [...p.querySelectorAll('.rd-pdf-text span')].find((s) => { const b = s.getBoundingClientRect(); return Math.abs(b.left - pr.left - l) < 3 && Math.abs(b.right - pr.left - r) < 3; });
        return { l, r, t: hit ? (hit.textContent || '').trim().slice(0, 14) : '?' };
      });
    return {
      len: s ? s.toString().length : 0,
      n: rs.length,
      minX: rs.length ? Math.round(Math.min(...rs.map((q) => q.left - pr.left))) : 0,
      maxX: rs.length ? Math.round(Math.max(...rs.map((q) => q.right - pr.left))) : 0,
      outside,
      wide,
    };
  })()
`);

/** 真实鼠标拖选（0 字时重试一次：合成鼠标偶发"按下没落到文字上"，不是产品行为） */
const drag = async (pageNo, band, a, b) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await mouse('mousePressed', a.x, a.y);
    for (let i = 1; i <= 8; i += 1) {
      await mouse('mouseMoved', Math.round(a.x + ((b.x - a.x) * i) / 8), Math.round(a.y + ((b.y - a.y) * i) / 8));
      await sleep(30);
    }
    await mouse('mouseReleased', b.x, b.y);
    await sleep(1500);
    const s = await selInfo(pageNo, band);
    if (s.len > 0 || attempt === 1) return s;
    await sleep(400);
  }
  return { len: 0, n: 0, minX: 0, maxX: 0, outside: 0 };
};

/** 清选区：点页面左边缘空白（真实鼠标） */
const clearSel = async (pageNo) => {
  const pt = await ev(`(() => { const p = document.querySelector('.rd-pdf-page[data-page-index="${pageNo}"]'); if (!p) return null; const r = p.getBoundingClientRect(); const sc = document.querySelector('.rd-pdf-scroll').getBoundingClientRect(); const y = Math.min(Math.max(r.top + r.height * 0.5, sc.top + 50), sc.bottom - 50); return { x: Math.round(r.left + 3), y: Math.round(y) }; })()`);
  if (!pt) return;
  await mouse('mousePressed', pt.x, pt.y);
  await sleep(40);
  await mouse('mouseReleased', pt.x, pt.y);
  await sleep(350);
};

// —— 打开一篇论文 ——
const openPaper = async (name) => {
  const hasSearch = await ev(`(() => !!document.getElementById('litshelf-search'))()`);
  if (!hasSearch) {
    await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').includes('返回')); b?.click(); return true; })()`);
    for (let i = 0; i < 20; i += 1) {
      if (await ev(`(() => !!document.getElementById('litshelf-search'))()`)) break;
      await sleep(400);
    }
  }
  await ev(`(() => { const el = document.getElementById('litshelf-search'); if (el) { el.focus(); el.select(); } return !!el; })()`);
  await send('Input.insertText', { text: name.slice(0, 10) });
  await sleep(1400);
  const ok = await ev(`(() => { const rows = [...document.querySelectorAll('.row')]; const r = rows.find((x) => (x.textContent || '').includes(${JSON.stringify(name.slice(0, 10))})) || rows[0]; if (!r) return false; r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
  if (!ok) return false;
  for (let i = 0; i < 100; i += 1) {
    if (await ev(`document.querySelectorAll('.rd-pdf-text span').length > 20`)) break;
    await sleep(400);
  }
  await sleep(1600);
  for (const t of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type: t, key: '0', code: 'Digit0', windowsVirtualKeyCode: 48, modifiers: 2 });
  await sleep(1600);
  return true;
};

const items = await ev(`(async () => { const s = await window.litshelf.invoke('getSnapshot', []); return s.items.map((x) => ({ name: x.name, pages: x.pageCount, state: x.parseState })); })()`);
let papers = (items || []).filter((x) => x.state === 'ready' && /\.pdf$/i.test(x.name) && /[\u4e00-\u9fa5]/.test(x.name));
/**
 * 全新环境兜底：隔离库里没有中文 PDF 时，用 LITSHELF_SRC_LIB 现场入库（只读扫描真实目录）。
 * 默认 `~/Desktop/文献`；入库后轮询等待解析完成（最多 120 秒）。
 */
if (!papers.length) {
  const SRC = process.env.LITSHELF_SRC_LIB || path.join(os.homedir(), 'Desktop', '文献');
  console.log(`库里没有现成的中文 PDF，尝试从 LITSHELF_SRC_LIB=${SRC} 入库…`);
  if (await fs.stat(SRC).then(() => true).catch(() => false)) {
    await ev(`(async () => { await window.litshelf.invoke('addRoot', [${JSON.stringify(SRC)}, { depth: 2 }]); return true; })()`);
    for (let i = 0; i < 60; i += 1) {
      const snap = await ev(`(async () => { const s = await window.litshelf.invoke('getSnapshot', []); return s.items.map((x) => ({ name: x.name, pages: x.pageCount, state: x.parseState })); })()`);
      papers = (snap || []).filter((x) => x.state === 'ready' && /\.pdf$/i.test(x.name) && /[\u4e00-\u9fa5]/.test(x.name));
      if (papers.length) break;
      await sleep(2000);
    }
  } else {
    console.log(`LITSHELF_SRC_LIB 不存在（${SRC}），无法入库`);
  }
}
const targets = NAME_FILTER ? papers.filter((p) => p.name.includes(NAME_FILTER)) : papers;
console.log(`候选论文 ${targets.length} 篇（库内 ready 中文 PDF 共 ${papers.length} 篇）`);
console.log(`隔离数据目录：${DATA}｜端口 ${PORT}`);

const failures = [];
const skipped = [];
let tested = 0;
for (const paper of targets) {
  if (!(await openPaper(paper.name))) {
    console.log(`\n【${paper.name}】打开失败，跳过`);
    skipped.push(`${paper.name}（打开失败）`);
    continue;
  }
  const pages = Math.min(paper.pages || 1, 30);
  console.log(`\n【${paper.name}】页数=${paper.pages}`);
  for (let p = 1; p <= pages; p += 1) {
    if (!(await gotoPage(p))) {
      console.log(`  页${p}：没翻到（跳过）`);
      skipped.push(`${paper.name} p${p}（未翻到）`);
      continue;
    }
    const model = await ev(MODEL(p));
    if (!model || model.bands.length < 2) {
      console.log(`  页${p}：栏数=${model ? model.bands.length : 0}（单栏，跳过）`);
      continue;
    }
    tested += 1;
    const lines = [];
    for (const [idx, label] of [[0, '栏1'], [model.bands.length - 1, '末栏']]) {
      const band = model.bands[idx];
      const pair = await pickPair(p, band);
      if (!pair) {
        lines.push(`${label}=[${band.s}~${band.e}] 取样不足`);
        skipped.push(`${paper.name} p${p} ${label}（视口内取样不足）`);
        continue;
      }
      await clearSel(p);
      const s = await drag(p, band, pair.a, pair.b);
      const ok = s.len > 0 && s.outside === 0;
      if (!ok) failures.push({ paper: paper.name, page: p, label, band, sel: s, pair });
      const wideInfo = s.wide && s.wide.length ? ` 宽行=${s.wide.map((w) => `[${w.l}~${w.r}]「${w.t}」`).join(' ')}` : '';
      lines.push(`${label}=[${band.s}~${band.e}] 选区x=[${s.minX}~${s.maxX}] ${s.len}字 rect=${s.n} 越界rect=${s.outside} ${ok ? '✓' : '✗'}${wideInfo}`);
    }
    console.log(`  页${p}：${model.bands.length}栏 ${lines.join('｜')}`);
  }
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').includes('返回')); b?.click(); return true; })()`);
  await sleep(1500);
}

console.log(`\n===== 汇总 =====`);
console.log(`测了 ${tested} 个多栏页（每页栏 1 + 末栏各一次拖选）`);
console.log(`失败 ${failures.length} 处（判据：选区非空 且 没有任何 rect 的中心落在按下那一栏之外）：`);
for (const f of failures) {
  console.log(
    `  ✗ ${f.paper} p${f.page} ${f.label}：栏=[${f.band.s}~${f.band.e}] 选区x=[${f.sel.minX}~${f.sel.maxX}] ${f.sel.len}字 rect=${f.sel.n} 越界rect=${f.sel.outside}｜取样「${f.pair.a.t}」→「${f.pair.b.t}」`,
  );
}
if (skipped.length) {
  console.log(`跳过 ${skipped.length} 处：`);
  for (const s of skipped) console.log(`  · ${s}`);
}

try {
  ws.close();
} catch {
  /* ignore */
}
child.kill();
await sleep(600);
spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
process.exit(failures.length ? 1 : 0);

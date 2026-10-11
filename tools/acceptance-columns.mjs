/**
 * 独立验收：跨栏禁止 + 点批注跳句（task-17）。
 *
 *   node tools/acceptance-columns.mjs
 *
 * 环境：自起 Electron（端口 9444）、LITSHELF_DATA_DIR=tmp/columns-acceptance-data、
 * 真实 CNKI 论文目录只读复制到 tmp/columns-library 后再 addRoot（绝不写用户目录）。
 * 真实目录用 `LITSHELF_SRC_LIB` 指定（默认 `~/Desktop/文献`）。
 *
 * 断言：
 *   [1] 跨栏禁止（硬性）：第一栏中间横向拖到最后一栏，选区所有 rect 的 right 必须 <= 第一栏右边界 + 容差；
 *       打印「左栏 x 区间 / 选区 x 区间」（页面局部坐标）。
 *   [2] 栏内正常：同一栏内纵向拖 3~4 行 -> 字数合理、工具条出现、能落一条批注。
 *   [3] 点批注跳句：IPC 造一条「某页 y=72%」的批注 -> 点侧栏 .rd-ann-row -> 批注屏幕 y 落在视口 10%~85%；
 *       打印 scrollTop 前后与批注距视口顶像素。
 *   [4] 收尾：用户论文目录 size/mtime 未变；渲染层 console.error = 0。
 *
 * 栏位检测：CNKI 文本层里「一行」常是单个 span，会盖住栏间空白，所以不用覆盖直方图找 gutter，
 * 改用**行首 x 聚类**（多栏排版下行首会聚成两/三个窄峰），再按「够宽（>=25% 内容宽）」筛出真栏。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const PORT = 9444;
const DATA = path.join(ROOT, 'tmp', 'columns-acceptance-data');
const LIB = path.join(ROOT, 'tmp', 'columns-library');
/** 真实文献目录（只读采样）：用 LITSHELF_SRC_LIB 指定；默认是家目录下的通用位置 */
const SRC = process.env.LITSHELF_SRC_LIB || path.join(os.homedir(), 'Desktop', '文献');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
};

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    /** 全部 console 文本（用来查产品有没有打印"选区跨栏，已夹回…"这类夹取日志） */
    this.consoleLogs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
        this.consoleLogs.push(text);
        if (m.params.type === 'error') this.consoleErrors.push(text);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? 'exception');
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = (this.id += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时 ${method}`));
        }
      }, timeoutMs);
    });
  }
  fire(method, params = {}) {
    const id = (this.id += 1);
    this.ws.send(JSON.stringify({ id, method, params }));
  }
  async eval(expression, timeoutMs = 20000) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function leftDrag(cdp, x1, y1, x2, y2, steps = 8) {
  await cdp.eval('window.getSelection()?.removeAllRanges()');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x1 + ((x2 - x1) * i) / steps),
      y: Math.round(y1 + ((y2 - y1) * i) / steps),
      button: 'left',
      buttons: 1,
    });
    await sleep(30);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(700);
}

async function leftClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(500);
}

/** 当前视口附近那一页 + 栏位（页面局部坐标） */
const readPage = (cdp) =>
  cdp.eval(`
    (() => {
      const sc = document.querySelector('.rd-pdf-scroll');
      const pages = [...document.querySelectorAll('.rd-pdf-page')];
      const cy = sc ? sc.getBoundingClientRect().top + sc.clientHeight / 2 : window.innerHeight / 2;
      const page = pages.find((p) => { const r = p.getBoundingClientRect(); return r.top <= cy && r.bottom >= cy; }) ?? pages[0];
      if (!page) return null;
      const pr = page.getBoundingClientRect();
      const spans = [...page.querySelectorAll('.rd-pdf-text span')]
        .map((s) => ({ r: s.getBoundingClientRect(), t: (s.textContent || '').trim() }))
        .filter((x) => x.t.length > 0)
        .map((x) => ({ x0: x.r.left - pr.left, x1: x.r.right - pr.left, top: x.r.top, bot: x.r.bottom }));
      const base = { pageNo: Number(page.dataset.pageIndex), spanCount: spans.length, cols: [], gaps: [], rect: { left: Math.round(pr.left), top: Math.round(pr.top), width: Math.round(pr.width), height: Math.round(pr.height) } };
      if (spans.length < 20) return base;
      const use = spans.filter((s) => s.x1 - s.x0 <= pr.width * 0.62);
      const src = use.length >= 20 ? use : spans;
      const byX = [...src].sort((a, b) => a.x0 - b.x0);
      const groups = [];
      for (const s of byX) {
        const g = groups[groups.length - 1];
        if (g && s.x0 - g.last <= 25) { g.items.push(s); g.last = s.x0; } else groups.push({ items: [s], last: s.x0 });
      }
      const strong = groups.filter((g) => g.items.length >= 6).map((g) => ({
        x0: Math.min(...g.items.map((i) => i.x0)),
        x1: Math.max(...g.items.map((i) => i.x1)),
        n: g.items.length,
      }));
      const contentW = Math.max(...src.map((s) => s.x1)) - Math.min(...src.map((s) => s.x0));
      // ① 行首簇里既有"真栏"，也有段落缩进/长行造成的碎片。规则：按 x0 排序后贪心保留，
      //    只有与**上一个被保留的栏**的 x0 相差 >= max(120, 内容宽 15%) 才算新栏；
      //    否则视为同一栏的碎片而丢弃（这样既不会把 241~935 与 338~971 切成 93px 假栏，
      //    也不会把真实的双栏 138 / 557 合并掉）。
      const minGap = Math.max(120, contentW * 0.15);
      const kept = [];
      for (const c of strong.filter((x) => x.x1 - x.x0 > Math.max(80, contentW * 0.25)).sort((a, b) => a.x0 - b.x0)) {
        const prev = kept[kept.length - 1];
        if (prev && c.x0 - prev.x0 < minGap) continue;
        kept.push({ ...c });
      }
      // ② 每栏都要有**足够的可见 span**（视口纵向带内 + 水平落在该栏带内），否则不算真栏
      const visOf = (c) => src.filter((s) => s.top > 150 && s.bot < window.innerHeight - 80 && s.x0 >= c.x0 - 6 && s.x1 <= c.x1 + 6).length;
      const cols = kept.map((c, i, arr) => ({
        x0: Math.round(c.x0),
        x1: Math.round(i + 1 < arr.length ? Math.min(c.x1, arr[i + 1].x0 - 4) : c.x1),
        n: c.n,
        vis: visOf(c),
      }));
      // ③ 行结构：这一页是不是"**整页全多栏**"（不存在通栏区/单栏区）。
      //    通栏行 = 该视觉行 x 覆盖 > 80% 内容宽；连续 >=2 条通栏行算一个"通栏区"。
      const allW = Math.max(...spans.map((s) => s.x1)) - Math.min(...spans.map((s) => s.x0));
      const yLines = [];
      for (const s of [...spans].sort((a, b) => a.top - b.top)) {
        const L = yLines[yLines.length - 1];
        if (L && s.top - L.top < 6) L.items.push(s);
        else yLines.push({ top: s.top, items: [s] });
      }
      // 关键：真通栏 = **单个 x 簇**就宽 >=80% 内容宽。双栏页里左右栏的行 y 几乎相同，
      // 若按整行最左到最右量宽度，会把它误判成"通栏行"（早先 20+ 条假通栏就是这么来的）。
      const isFull = yLines.map((L) => {
        const xs = L.items.map((i) => [i.x0, i.x1]).sort((a, b) => a[0] - b[0]);
        let s0 = xs[0][0];
        let e0 = xs[0][1];
        let widest = 0;
        for (let i = 1; i < xs.length; i += 1) {
          if (xs[i][0] - e0 > 20) { widest = Math.max(widest, e0 - s0); s0 = xs[i][0]; e0 = xs[i][1]; } else e0 = Math.max(e0, xs[i][1]);
        }
        widest = Math.max(widest, e0 - s0);
        return widest > allW * 0.8;
      });
      let run = 0;
      let fullCount = 0;
      let maxRun = 0;
      for (const f of isFull) {
        if (f) { run += 1; fullCount += 1; maxRun = Math.max(maxRun, run); } else run = 0;
      }
      const uniformMulti = cols.length >= 2 && fullCount <= 1 && maxRun <= 1;
      return { ...base, contentW: Math.round(contentW), cols, colsVisOk: cols.length >= 2 && cols.every((c) => c.vis >= 15), uniformMulti, fullCount, maxRun, gaps: kept.map((c) => [Math.round(c.x0), Math.round(c.x1), c.n]) };
    })()
  `);

/** 选区：文本、rects（页面局部 x）、长度、起止页 */
const readSelection = (cdp) =>
  cdp.eval(`
    (() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      const asEl = (n) => (n && n.nodeType === 3 ? n.parentElement : n);
      const pageEl = asEl(range.startContainer)?.closest?.('.rd-pdf-page');
      const pr = pageEl?.getBoundingClientRect();
      const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
      const sPage = asEl(range.startContainer)?.closest?.('.rd-pdf-page');
      const ePage = asEl(range.endContainer)?.closest?.('.rd-pdf-page');
      return {
        text: sel.toString(),
        len: sel.toString().length,
        rects: rects.map((r) => ({ x0: Math.round(r.left - (pr?.left ?? 0)), x1: Math.round(r.right - (pr?.left ?? 0)) })),
        startPage: sPage ? Number(sPage.dataset.pageIndex) : null,
        endPage: ePage ? Number(ePage.dataset.pageIndex) : null,
      };
    })()
  `);

const toolbarCount = (cdp) =>
  cdp.eval(`(() => [...document.querySelectorAll('button')].filter((b) => /^(高亮|下划线|波浪线|删除线)$/.test((b.title || b.textContent || '').trim())).length)()`);

const anns = (cdp) => cdp.eval(`(async () => (await window.litshelf.invoke('listAllAnnotations', [])).length)()`);

async function launch() {
  const env = { ...process.env, LITSHELF_DATA_DIR: DATA };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [`--remote-debugging-port=${PORT}`, '.'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Page.bringToFront').catch(() => undefined);
        return { cdp, child, logs: logs.join('') };
      }
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error('等不到 Electron 调试端口');
}

async function snapshotSource() {
  const names = (await fs.readdir(SRC)).filter((f) => f.toLowerCase().endsWith('.pdf'));
  const out = [];
  for (const n of names) {
    const st = await fs.stat(path.join(SRC, n));
    out.push({ name: n, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
  }
  return out;
}

/** 回到文献库：阅读器在就按 Esc（最多 5 次）；不要依赖"返回"按钮是否存在 */
async function backToLibrary(cdp) {
  for (let i = 0; i < 5; i += 1) {
    const st = await cdp.eval(`({ reader: !!document.querySelector('.rd-pdf-page'), title: (document.querySelector('.topbar-title')?.textContent || '').trim() })`);
    if (!st.reader && st.title !== '设置') return true;
    cdp.fire('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    cdp.fire('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(700);
  }
  return false;
}

/** 在库里按关键词过滤并双击打开；返回 {opened, title} */
async function openByName(cdp, name) {
  const key = name.replace(/\.pdf$/i, '').split(/[——_（(]/)[0].slice(0, 10);
  await cdp.eval(`(() => { const i=document.getElementById('litshelf-search'); if (i) { i.focus(); i.select(); } return true; })()`);
  await cdp.send('Input.insertText', { text: key });
  await sleep(900);
  const opened = await cdp.eval(`
    (() => {
      const rows = [...document.querySelectorAll('.row')];
      const r = rows.find((x) => (x.textContent || '').includes(${JSON.stringify(key)})) ?? rows[0];
      if (!r) return { ok: false, rows: rows.length };
      r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return { ok: true, rows: rows.length, text: (r.textContent || '').slice(0, 30) };
    })()
  `);
  if (!opened?.ok) return { opened: false, rows: opened?.rows ?? 0 };
  for (let i = 0; i < 60; i += 1) {
    if (await cdp.eval('document.querySelectorAll(".rd-pdf-text span").length > 5')) {
      const title = await cdp.eval(`(document.querySelector('.topbar-title')?.textContent || '').trim()`);
      return { opened: true, title, key };
    }
    await sleep(500);
  }
  return { opened: true, title: '(文本层未就绪)', key };
}

async function main() {
  await fs.rm(DATA, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(LIB, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(LIB, { recursive: true });
  await fs.cp(SRC, LIB, { recursive: true });

  console.log(`隔离数据目录：${DATA}`);
  console.log(`真实论文（只读复制）：${SRC} -> ${LIB}`);
  const before = await snapshotSource();
  console.log(`源目录快照：${before.length} 个 PDF（size+mtime 已记录）`);

  const { cdp, child, logs } = await launch();
  try {
    await sleep(3000);
    await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('跳过')); b?.click(); return true; })()`);
    await sleep(800);
    await cdp.eval(`(async () => { await window.litshelf.invoke('addRoot', [${JSON.stringify(LIB)}, { depth: 2 }]); return true; })()`);

    let items = [];
    for (let i = 0; i < 80; i += 1) {
      items = await cdp.eval(`(async () => (await window.litshelf.invoke('getSnapshot', [])).items.map((x) => ({ id: x.id, name: x.name, pages: x.pageCount, state: x.parseState })))()`);
      if (items.length && items.every((x) => x.state !== 'placeholder')) break;
      await sleep(500);
    }
    console.log(`\n[A] 入库：${items.length} 篇`);
    ok(items.length >= 8, `真实论文已入库（${items.length} 篇）`);

    // 逐篇找「真的有栏」的页；想让特定文件先试，用 LITSHELF_PREFER=<文件名正则> 指定
    const preferRe = process.env.LITSHELF_PREFER ? new RegExp(process.env.LITSHELF_PREFER, 'i') : null;
    const prefer = (n) => (preferRe && preferRe.test(n) ? 0 : 1);
    const candidates = [...items].sort((a, b) => prefer(a.name) - prefer(b.name) || (b.pages ?? 0) - (a.pages ?? 0)).slice(0, 6);
    let best = null;
    let openedName = null;
    const tried = [];
    for (const cand of candidates) {
      if (best) break;
      await backToLibrary(cdp);
      const res = await openByName(cdp, cand.name);
      if (!res.opened) {
        console.log(`  · 跳过「${cand.name.slice(0, 12)}…」：库里没打开（rows=${res.rows}，key=${res.key}）`);
        continue;
      }
      if (!/span/.test(res.title) && !res.title) {
        console.log(`  · 跳过「${cand.name.slice(0, 12)}…」：文本层未就绪`);
        continue;
      }
      console.log(`  · 打开「${res.title.slice(0, 16)}…」（关键词 ${res.key}）`);
      openedName = cand.name;
      for (let p = 1; p <= Math.min(cand.pages ?? 1, 8); p += 1) {
        const info = await readPage(cdp);
        if (info && info.spanCount >= 20) {
          const desc = info.cols.map((c) => `#${c.x0}-${c.x1}(vis ${c.vis})`).join(' ');
          console.log(`  · ${cand.name.slice(0, 14)}… P${info.pageNo}：span ${info.spanCount}，行首簇 ${JSON.stringify(info.gaps)} -> ${info.cols.length} 栏 ${desc}；通栏行 ${info.fullCount}(最长连续 ${info.maxRun}) ${info.uniformMulti ? '⇒ 整页全多栏 ✓' : '⇒ 混排/单栏，不用于[1]'}`);
          // **自校验**：>=2 栏、每栏可见 span 足够、且**整页都是多栏**（跨栏断言只在纯多栏页上做）
          if (info.cols.length >= 2 && info.colsVisOk && info.uniformMulti) {
            if (!best || info.cols.length > best.cols.length) { best = info; }
            break;
          }
          if (info.cols.length >= 2) {
            tried.push(`${cand.name.slice(0, 10)}…P${info.pageNo}（栏 ${info.cols.length}，vis ${info.cols.map((c) => c.vis).join('/')}，通栏行 ${info.fullCount} 连${info.maxRun}）`);
          }
        }
        cdp.fire('Input.dispatchKeyEvent', { type: 'keyDown', key: ']', code: 'BracketRight', windowsVirtualKeyCode: 221 });
        cdp.fire('Input.dispatchKeyEvent', { type: 'keyUp', key: ']', code: 'BracketRight', windowsVirtualKeyCode: 221 });
        await sleep(900);
      }
    }
    ok(!!openedName, `打开论文：${openedName ?? '（没打开任何候选）'}`);
    if (tried.length) console.log(`  自校验跳过 ${tried.length} 处：${tried.slice(0, 6).join('；')}`);
    if (!best) {
      ok(false, `没有找到任何"自校验通过"的多栏页（试了 ${candidates.length} 篇）`);
      return;
    }
    if (openedName !== candidates[0].name) {
      console.log(`  选页自校验：首选「${candidates[0].name.slice(0, 14)}…」未通过，改用「${openedName.slice(0, 14)}…」`);
    }
    const page = best;
    const colCount = page.cols.length;
    console.log(`\n[栏位] 「${openedName.slice(0, 18)}…」第 ${page.pageNo} 页：${colCount} 栏 ` + page.cols.map((c, i) => `#${i + 1}[${c.x0}-${c.x1}] vis=${c.vis}`).join(' ') + `（页宽 ${page.rect.width}，内容宽 ${page.contentW}，span ${page.spanCount}）`);
    ok(colCount >= 2 && page.colsVisOk === true, `正文页自校验通过：${colCount} 栏且每栏可见 span 足够（阈值 15；实测 ${page.cols.map((c) => c.vis).join('/')}）`);

    const c1 = page.cols[0];
    const cLast = page.cols[colCount - 1];

    // ---------------- [1] 跨栏禁止
    console.log('\n[1] 跨栏禁止：第一栏中间横向拖到最后一栏');
    const pair = await cdp.eval(`
      (() => {
        const page = document.querySelector('.rd-pdf-page[data-page-index="${page.pageNo}"]');
        if (!page) return { none: true, why: 'no page' };
        const pr = page.getBoundingClientRect();
        const spans0 = [...page.querySelectorAll('.rd-pdf-text span')]
          .map((s) => ({ r: s.getBoundingClientRect(), t: (s.textContent || '').trim() }))
          .filter((x) => x.t.length > 4 && x.r.top > 150 && x.r.bottom < window.innerHeight - 80)
          .map((x) => ({ l: x.r.left - pr.left, rr: x.r.right - pr.left, cy: x.r.top + x.r.height / 2, t: x.t }))
          .sort((a, b) => a.cy - b.cy);
        // 锚点必须来自**多栏行簇**：同一视觉行内有 >=1 处 >20px 断档、且行宽 < 55% 内容宽。
        // 这样标题/刊名页眉（产品按 y 分区判为通栏区、本来就不夹取）不会被选成锚点。
        const contentW = Math.max(...spans0.map((s) => s.rr)) - Math.min(...spans0.map((s) => s.l));
        const lineGroups = [];
        for (const s of spans0) {
          const L = lineGroups[lineGroups.length - 1];
          if (L && Math.abs(s.cy - L.cy) < 6) L.items.push(s);
          else lineGroups.push({ cy: s.cy, items: [s] });
        }
        const lineMeta = new Map();
        for (const L of lineGroups) {
          const xs = L.items.map((i) => [i.l, i.rr]).sort((a, b) => a[0] - b[0]);
          // 同上：宽度取"最宽 x 簇"，否则双栏页的左右栏会被当成一整行
          let s0 = xs[0][0];
          let e0 = xs[0][1];
          let widest = 0;
          for (let i = 1; i < xs.length; i += 1) {
            if (xs[i][0] - e0 > 20) { widest = Math.max(widest, e0 - s0); s0 = xs[i][0]; e0 = xs[i][1]; } else e0 = Math.max(e0, xs[i][1]);
          }
          widest = Math.max(widest, e0 - s0);
          let gaps = 0;
          for (let i = 1; i < xs.length; i += 1) if (xs[i][0] - xs[i - 1][1] > 20) gaps += 1;
          for (const i of L.items) lineMeta.set(i, { w: widest, gaps });
        }
        const spans = spans0.filter((s) => { const m = lineMeta.get(s); return m && m.gaps >= 1 && m.w < contentW * 0.55; });
        const inCol = (s, c) => s.l >= c.x0 - 8 && s.rr <= c.x1 + 8;
        const n1 = spans.filter((s) => inCol(s, ${JSON.stringify(c1)})).length;
        const n2 = spans.filter((s) => inCol(s, ${JSON.stringify(cLast)})).length;
        for (const a of spans) {
          if (!inCol(a, ${JSON.stringify(c1)})) continue;
          const b = spans.find((x) => inCol(x, ${JSON.stringify(cLast)}) && Math.abs(x.cy - a.cy) < 30 && x.rr - x.l > 30);
          if (b) {
            return {
              from: { x: Math.round(pr.left + a.l + 6), y: Math.round(a.cy) },
              to: { x: Math.round(pr.left + b.rr - 6), y: Math.round(b.cy) },
              t1: a.t.slice(0, 14),
              t2: b.t.slice(0, 14),
              vis: spans.length,
              n1,
              n2,
            };
          }
        }
        return { none: true, vis: spans.length, n1, n2 };
      })()
    `);
      ok(!!pair && !!pair.t1, `锚点页自校验后 [1] 落在：「${openedName?.slice(0, 20) ?? '?'}…」第 ${page.pageNo} 页（整页全多栏）`);
    if (!pair || pair.none) {
      ok(false, '找不到「同一视觉行、栏 1 与末栏各一个可见 span」的锚点，无法做横向拖动', `可见 span=${pair?.vis ?? '?'}，栏 1 内=${pair?.n1 ?? '?'}，末栏内=${pair?.n2 ?? '?'}`);
    } else {
      console.log(`  锚点行：「${pair.t1}」（栏 1）<-> 「${pair.t2}」（末栏），拖动 (${pair.from.x}, ${pair.from.y}) -> (${pair.to.x}, ${pair.to.y})`);
      await leftDrag(cdp, pair.from.x, pair.from.y, pair.to.x, pair.to.y);
      const selX = await readSelection(cdp);
      const selMaxRight = selX && selX.rects.length ? Math.max(...selX.rects.map((r) => r.x1)) : null;
      console.log(
        `  选区 x 区间（页面局部）：${selX && selX.rects.length ? `${Math.min(...selX.rects.map((r) => r.x0))}-${selMaxRight}` : '（没有选区）'}` +
          `${selX ? `，共 ${selX.rects.length} 个 rect，${selX.len} 字` : ''}`,
      );
      ok(!!selX && selX.len > 0, `横向拖后确实产生了选区（${selX?.len ?? 0} 字）`);
      ok(selMaxRight !== null && selMaxRight <= c1.x1 + 6, `选区完全落在第一栏内（选区最右 ${selMaxRight} <= 栏右 ${c1.x1} + 6）`);
      ok(!!selX && selX.startPage === page.pageNo && selX.endPage === page.pageNo, `选区只在第 ${page.pageNo} 页内（${selX?.startPage}/${selX?.endPage}）`);
    }

    // ---------------- [1b] 混排页（整幅通栏区 + 多栏区）：本轮修复的回归保护
    console.log('\n[1b] 混排页：通栏区拖选行内不得被拆开；多栏区仍须留在按下那一栏');
    const readMixed = () => cdp.eval(`      (() => {
        const sc = document.querySelector('.rd-pdf-scroll');
        const pages = [...document.querySelectorAll('.rd-pdf-page')];
        const cy = sc ? sc.getBoundingClientRect().top + sc.clientHeight / 2 : window.innerHeight / 2;
        const page = pages.find((p) => { const r = p.getBoundingClientRect(); return r.top <= cy && r.bottom >= cy; }) ?? pages[0];
        if (!page) return null;
        const pr = page.getBoundingClientRect();
        const spans = [...page.querySelectorAll('.rd-pdf-text span')]
          .map((s) => ({ r: s.getBoundingClientRect(), t: (s.textContent || '').trim() }))
          .filter((x) => x.t.length > 0)
          .map((x) => ({ x0: x.r.left - pr.left, x1: x.r.right - pr.left, cy: x.r.top + x.r.height / 2, vx0: x.r.left, vx1: x.r.right, vy: x.r.top + x.r.height / 2, t: x.t }));
        if (spans.length < 20) return null;
        const contentW = Math.max(...spans.map((s) => s.x1)) - Math.min(...spans.map((s) => s.x0));
        // 按视觉行分组（cy 相差 < 5px 视为同一行）
        const lines = [];
        for (const s of [...spans].sort((a, b) => a.cy - b.cy)) {
          const L = lines[lines.length - 1];
          if (L && Math.abs(s.cy - L.cy) < 5) { L.items.push(s); L.cy = (L.cy * (L.items.length - 1) + s.cy) / L.items.length; }
          else lines.push({ cy: s.cy, items: [s] });
        }
        const lineStats = lines.map((L) => {
          const xs = L.items.map((i) => [i.x0, i.x1]).sort((a, b) => a[0] - b[0]);
          // 宽度取"最宽 x 簇"（真通栏=单簇就宽），否则双栏页左右栏会被当成通栏行
          let s0 = xs[0][0];
          let e0 = xs[0][1];
          let widest = 0;
          for (let i = 1; i < xs.length; i += 1) {
            if (xs[i][0] - e0 > 20) { widest = Math.max(widest, e0 - s0); s0 = xs[i][0]; e0 = xs[i][1]; } else e0 = Math.max(e0, xs[i][1]);
          }
          widest = Math.max(widest, e0 - s0);
          let gaps = 0;
          for (let i = 1; i < xs.length; i += 1) if (xs[i][0] - xs[i - 1][1] > 20) gaps += 1;
          return { cy: L.cy, n: L.items.length, w: widest, gaps, x0: Math.min(...xs.map((x) => x[0])), x1: Math.max(...xs.map((x) => x[1])) };
        });
        const inView = (y) => y > 175 && y < window.innerHeight - 90;
        const full = lineStats.filter((l) => l.w >= contentW * 0.9 && l.n >= 2 && inView(l.cy));
        const multi = lineStats.filter((l) => l.gaps >= 1 && l.w < contentW * 0.55 && inView(l.cy));
        if (full.length < 2 || !multi.length) return { pageNo: Number(page.dataset.pageIndex), contentW: Math.round(contentW), fullCount: full.length, multiCount: multi.length, isMixed: false };
        const f0 = full[0];
        const f1 = full[Math.min(1, full.length - 1)];
        const m = multi[multi.length - 1];
        return {
          pageNo: Number(page.dataset.pageIndex),
          contentW: Math.round(contentW),
          isMixed: true,
          fullCount: full.length,
          multiCount: multi.length,
          full: { y1: Math.round(f0.cy), y2: Math.round(f1.cy), x0: Math.round(f0.x0), x1: Math.round(f0.x1), w: Math.round(f0.w) },
          multiY: Math.round(m.cy),
          multiBand: { x0: Math.round(m.x0), x1: Math.round(m.x1) },
          pageLeft: Math.round(pr.left),
        };
      })()
    `);
    // [1] 的锚点页现在保证"整页全多栏"，所以混排页要**翻页去找**（通栏行 >= 90% 内容宽、且下方有多栏区）
    let mixed = null;
    let mixedDoc = null;
    const mixedTried = [];
    // 跨文献搜索：混排页可能不在 [1] 那篇里（例如红筹通篇无混排页）
    const tryDocs = [...new Set([openedName, ...[...items].map((x) => x.name)].filter(Boolean))].slice(0, 5);
    for (const docName of tryDocs) {
      if (mixed?.isMixed) break;
      if (docName !== openedName || mixedTried.length) {
        await backToLibrary(cdp);
        const res = await openByName(cdp, docName);
        if (!res.opened) { mixedTried.push(`${docName.slice(0, 8)}…(打不开)`); continue; }
      }
      for (let i = 0; i < 6; i += 1) {
        mixed = await readMixed();
        mixedTried.push(`${docName.slice(0, 8)}…P${mixed?.pageNo ?? '?'}(通栏${mixed?.fullCount ?? '?'}/多栏${mixed?.multiCount ?? '?'})`);
        if (mixed?.isMixed) { mixedDoc = docName; break; }
        cdp.fire('Input.dispatchKeyEvent', { type: 'keyDown', key: ']', code: 'BracketRight', windowsVirtualKeyCode: 221 });
        cdp.fire('Input.dispatchKeyEvent', { type: 'keyUp', key: ']', code: 'BracketRight', windowsVirtualKeyCode: 221 });
        await sleep(900);
      }
    }
    console.log(`  混排页跨文献扫描：${mixedTried.join(' -> ')}`);
    if (!mixed?.isMixed) {
      ok(false, `找不到"通栏区 + 多栏区"的混排页（当前页 通栏行 ${mixed?.fullCount ?? 0} / 多栏行 ${mixed?.multiCount ?? 0}）`);
    } else {
      console.log(`  混排页 P${mixed.pageNo}：通栏行 ${mixed.fullCount} 行（首行 x ${mixed.full.x0}-${mixed.full.x1}，宽 ${mixed.full.w}/${mixed.contentW}），多栏行 ${mixed.multiCount} 行`);
      // (a) 通栏区纵向拖 1~2 行
      const logsBefore = cdp.consoleLogs.length;
      await leftDrag(cdp, mixed.pageLeft + mixed.full.x0 + 4, mixed.full.y1, mixed.pageLeft + mixed.full.x1 - 4, mixed.full.y2, 6);
      const sFull = await cdp.eval(`
        (() => {
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed || sel.rangeCount === 0) return { none: true };
          const range = sel.getRangeAt(0);
          const asEl = (n) => (n && n.nodeType === 3 ? n.parentElement : n);
          const pageEl = asEl(range.startContainer)?.closest?.('.rd-pdf-page');
          if (!pageEl) return { none: true };
          const pr = pageEl.getBoundingClientRect();
          const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5)
            .map((r) => ({ x0: r.left - pr.left, x1: r.right - pr.left, cy: (r.top + r.bottom) / 2, top: r.top, bot: r.bottom }));
          if (!rects.length) return { none: true };
          // —— 旧口径（仅作对照保留）：按 rect 之间的像素间隔 >12px 记断档
          const linesPx = [];
          for (const r of [...rects].sort((a, b) => a.cy - b.cy)) {
            const L = linesPx[linesPx.length - 1];
            if (L && Math.abs(r.cy - L.cy) < 5) L.items.push(r);
            else linesPx.push({ cy: r.cy, items: [r] });
          }
          let breaksPx = 0;
          for (const L of linesPx) {
            const xs = L.items.map((i) => [i.x0, i.x1]).sort((a, b) => a[0] - b[0]);
            for (let i = 1; i < xs.length; i += 1) if (xs[i][0] - xs[i - 1][1] > 12) breaksPx += 1;
          }
          const selMinX = Math.min(...rects.map((r) => r.x0));
          const selMaxX = Math.max(...rects.map((r) => r.x1));
          const selTop = Math.min(...rects.map((r) => r.top));
          const selBot = Math.max(...rects.map((r) => r.bot));
          // —— 口径 A（与像素无关，采用）：某行"选全" ⟺ 该行内 x 落在选区首尾之间、y 属于该行的**所有 span 都被选中**；
          //    只有"存在未被选中的 span"才算断档（中文两端对齐行内相邻 run 的正常间距就有 10~15px，用像素阈值是度量口径错误）
          const cand = [...pageEl.querySelectorAll('.rd-pdf-text span')]
            .map((s) => ({ el: s, r: s.getBoundingClientRect(), t: (s.textContent || '').trim() }))
            .filter((x) => x.t.length > 0 && x.r.top >= selTop - 8 && x.r.bottom <= selBot + 8 && x.r.left - pr.left >= selMinX - 2 && x.r.right - pr.left <= selMaxX + 2);
          let unselected = 0;
          const holes = [];
          for (const s of cand) {
            let hit = false;
            try { hit = range.intersectsNode(s.el); } catch { hit = false; }
            if (!hit) { unselected += 1; if (holes.length < 5) holes.push([Math.round(s.r.left - pr.left), Math.round(s.r.right - pr.left), s.t.slice(0, 8)]); }
          }
          return {
            len: sel.toString().length,
            rects: rects.length,
            lines: linesPx.length,
            breaks: unselected,
            candSpans: cand.length,
            holes,
            breaksPx,
            cov: Math.round(selMaxX - selMinX),
          };
        })()
      `);
      const newLogs = cdp.consoleLogs.slice(logsBefore).filter((t) => /跨栏|夹回|clamp/i.test(t));
      console.log(`  通栏区拖选：${sFull?.len ?? 0} 字 / ${sFull?.rects ?? 0} rect / ${sFull?.lines ?? 0} 行；**断档(口径A·未选中 span)=${sFull?.breaks ?? '?'}**（候选 span ${sFull?.candSpans ?? '?'}；旧像素口径对照=${sFull?.breaksPx ?? '?'}）；x 覆盖 ${sFull?.cov ?? '?'}px（该页文字内容 x 范围 ${mixed.contentW}，占 ${sFull?.cov ? Math.round((sFull.cov / mixed.contentW) * 100) : '?'}%）`);
      if (sFull?.holes?.length) console.log(`    未选中的 span（最小证据）：${JSON.stringify(sFull.holes)}`);
      ok(!!sFull && sFull.len > 0, `通栏区拖出选区（${sFull?.len ?? 0} 字）`);
      ok(!!sFull && sFull.breaks === 0, `通栏区**行内断档 = 0**（口径 A：行内 x 落在选区首尾之间、y 属于该行的 span 里"未被选中"的数量；实测 ${sFull?.breaks ?? '?'}；旧 12px 像素口径 ${sFull?.breaksPx ?? '?'} 仅作对照，不作为判据）`);
      ok(!!sFull && sFull.cov >= mixed.contentW * 0.8, `通栏区 x 覆盖接近整幅内容宽（${sFull?.cov ?? '?'} / ${mixed.contentW} ≥ 80%，分母 = 该页文字内容 x 范围）`);
      ok(newLogs.length === 0, `通栏区没有出现"选区跨栏，已夹回…"日志（${newLogs.length} 条）`, newLogs.slice(0, 2).join(' | '));
      // (b) 多栏区里再拖一次：必须完全落在按下那一栏内
      const logsBefore2 = cdp.consoleLogs.length;
      await leftDrag(cdp, mixed.pageLeft + mixed.multiBand.x0 + 4, mixed.multiY, mixed.pageLeft + mixed.multiBand.x1 - 4, mixed.multiY + 18, 6);
      const sMulti = await cdp.eval(`
        (() => {
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed || sel.rangeCount === 0) return { none: true };
          const range = sel.getRangeAt(0);
          const asEl = (n) => (n && n.nodeType === 3 ? n.parentElement : n);
          const pr = asEl(range.startContainer)?.closest?.('.rd-pdf-page')?.getBoundingClientRect();
          const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5).map((r) => ({ x0: r.left - (pr?.left ?? 0), x1: r.right - (pr?.left ?? 0) }));
          if (!rects.length) return { none: true };
          return { len: sel.toString().length, minX: Math.round(Math.min(...rects.map((r) => r.x0))), maxX: Math.round(Math.max(...rects.map((r) => r.x1))) };
        })()
      `);
      const newLogs2 = cdp.consoleLogs.slice(logsBefore2).filter((t) => /跨栏|夹回|clamp/i.test(t));
      console.log(`  多栏区拖选：${sMulti?.len ?? 0} 字，x ${sMulti?.minX ?? '?'}-${sMulti?.maxX ?? '?'}（按下那一栏 x ${mixed.multiBand.x0}-${mixed.multiBand.x1}）`);
      ok(!!sMulti && sMulti.len > 0, `多栏区拖出选区（${sMulti?.len ?? 0} 字）`);
      ok(!!sMulti && sMulti.maxX <= mixed.multiBand.x1 + 6, `多栏区选区完全落在按下那一栏内（最右 ${sMulti?.maxX ?? '?'} ≤ ${mixed.multiBand.x1}+6）`);
      // 多栏区里横跨栏缝拖选时，产品**应当**夹取并打印这条日志 —— 它是功能生效的证据（不是缺陷）。
      // （原先这里写成"不得出现日志"是断言写反；通栏区那条"不得出现"保持不变。）
      console.log(`  ℹ 多栏区夹取日志（此处**期望**出现）：${newLogs2.length} 条${newLogs2.length ? ` — ${newLogs2[0].slice(0, 70)}` : '（本次拖选未跨栏缝，未触发）'}`);
    }

    // ---------------- [2] 栏内正常
    // [1b] 为了找混排页可能翻到别的文献，先回 [1] 那篇那一页再做栏内/跳句等用例
    console.log('\n[2] 栏内正常：同一栏内纵向拖 3~4 行');
    if (mixedDoc && mixedDoc !== openedName) {
      await backToLibrary(cdp);
      const res2 = await openByName(cdp, openedName);
      console.log(`  （[1b] 跨文献后回到「${openedName.slice(0, 18)}…」：${res2.opened ? '已重开' : '重开失败'}）`);
    }
    for (let i = 0; i < 8; i += 1) {
      const cur = await cdp.eval(`(() => { const sc=document.querySelector('.rd-pdf-scroll'); const p=[...document.querySelectorAll('.rd-pdf-page')].find((x)=>{const r=x.getBoundingClientRect(); return r.top<=window.innerHeight/2 && r.bottom>=window.innerHeight/2;}); return p ? Number(p.dataset.pageIndex) : null; })()`);
      if (cur === page.pageNo) break;
      const back = cur !== null && cur > page.pageNo;
      cdp.fire('Input.dispatchKeyEvent', { type: 'keyDown', key: back ? '[' : ']', code: back ? 'BracketLeft' : 'BracketRight', windowsVirtualKeyCode: back ? 219 : 221 });
      cdp.fire('Input.dispatchKeyEvent', { type: 'keyUp', key: back ? '[' : ']', code: back ? 'BracketLeft' : 'BracketRight', windowsVirtualKeyCode: back ? 219 : 221 });
      await sleep(800);
    }
    await cdp.eval('window.getSelection()?.removeAllRanges()');
    const lineInfo = await cdp.eval(`
      (() => {
        const page = document.querySelector('.rd-pdf-page[data-page-index="${page.pageNo}"]');
        if (!page) return { few: 0 };
        const pr = page.getBoundingClientRect();
        const spans = [...page.querySelectorAll('.rd-pdf-text span')]
          .map((s) => ({ r: s.getBoundingClientRect(), t: (s.textContent || '').trim() }))
          .filter((x) => x.t.length > 6 && x.r.left - pr.left >= ${c1.x0} - 8 && x.r.right - pr.left <= ${c1.x1} + 8 && x.r.top > 150 && x.r.bottom < window.innerHeight - 80)
          .sort((a, b) => a.r.top - b.r.top);
        if (spans.length < 4) return { few: spans.length };
        const a = spans[0];
        const b = spans[Math.min(3, spans.length - 1)];
        return { x: Math.round(a.r.left + 4), y1: Math.round(a.r.top + a.r.height / 2), y2: Math.round(b.r.top + b.r.height / 2), lines: spans.length, t1: a.t.slice(0, 12), t2: b.t.slice(0, 12) };
      })()
    `);
    const hasLines = !!lineInfo && !('few' in lineInfo) && typeof lineInfo.x === 'number';
    ok(hasLines, `在第一栏里取到可纵向拖的 3~4 行${hasLines ? `（共 ${lineInfo.lines} 行：「${lineInfo.t1}」->「${lineInfo.t2}」）` : `（可用行 ${lineInfo?.few ?? 0}）`}`);
    if (hasLines) {
      const annBefore = await anns(cdp);
      await leftDrag(cdp, lineInfo.x, lineInfo.y1, lineInfo.x, lineInfo.y2, 6);
      const selV = await readSelection(cdp);
      const tb = await toolbarCount(cdp);
      console.log(`  纵向拖结果：${selV?.len ?? 0} 字，工具条 ${tb} 个动作`);
      ok(!!selV && selV.len >= 8, `栏内纵向拖出合理字数（${selV?.len ?? 0} 字 >= 8）`);
      ok(!!selV && selV.len < 400, `没有异常超长（${selV?.len ?? 0} 字 < 400）`);
      ok(tb >= 3, `划词工具条出现（${tb} 个动作）`);
      const hit = await cdp.eval(`
        (() => { const b=[...document.querySelectorAll('button')].find((x)=>(x.title||x.textContent||'').trim()==='高亮'); if (!b) return null; const r=b.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; })()
      `);
      if (hit) await leftClick(cdp, hit.x, hit.y);
      await sleep(1000);
      const annAfter = await anns(cdp);
      ok(annAfter === annBefore + 1, `栏内选区能落批注（${annBefore} -> ${annAfter}）`);
    }

    // ---------------- [2.5] color 最小对照（UX_COLOR_AB=1 时才跑）
    if (process.env.UX_COLOR_AB === '1') {
      console.log('\n[2.5] console.error 对照：addAnnotation 的 payload 变量');
      const tgtAb = items.find((x) => x.name === openedName);
      const variants = [
        { name: 'A 不带 color、带 comment', payload: { type: 'highlight', page: page.pageNo, rects: [{ x: 0.3, y: 0.6, w: 0.2, h: 0.02 }], text: 'AB-A', anchor: { prefix: '', suffix: '', occurrence: 1 }, comment: '' } },
        { name: 'B 带 color:yellow、带 comment', payload: { type: 'highlight', color: 'yellow', page: page.pageNo, rects: [{ x: 0.3, y: 0.62, w: 0.2, h: 0.02 }], text: 'AB-B', anchor: { prefix: '', suffix: '', occurrence: 1 }, comment: '' } },
        { name: 'C 带 color:yellow、不带 comment', payload: { type: 'highlight', color: 'yellow', page: page.pageNo, rects: [{ x: 0.3, y: 0.64, w: 0.2, h: 0.02 }], text: 'AB-C', anchor: { prefix: '', suffix: '', occurrence: 1 } } },
      ];
      for (const v of variants) {
        const errBefore = cdp.consoleErrors.length;
        const made = await cdp.eval(
          `(async () => await window.litshelf.invoke('addAnnotation', [Object.assign(${JSON.stringify(v.payload)}, { itemId: ${JSON.stringify(tgtAb?.id ?? '')} })]))()`,
        );
        await cdp.eval(`(() => { const t=[...document.querySelectorAll('.rd-side-tab')].find((b)=>(b.textContent||'').trim()==='批注'); t?.click(); return !!t; })()`);
        await sleep(1200);
        const rows = await cdp.eval(`document.querySelectorAll('.rd-ann-row').length`);
        const newErrs = cdp.consoleErrors.slice(errBefore);
        console.log(`  ${v.name}：created=${!!made?.id}，批注行数=${rows}，新增 console.error=${newErrs.length}${newErrs.length ? ` -> ${newErrs[0].split('\n')[0]}` : ''}`);
      }
      // D：界面真实划词落批注
      const errBeforeD = cdp.consoleErrors.length;
      const selInfo = await cdp.eval(`
        (() => {
          const page = document.querySelector('.rd-pdf-page[data-page-index="${page.pageNo}"]');
          const spans = [...page.querySelectorAll('.rd-pdf-text span')].filter((s) => { const r = s.getBoundingClientRect(); return r.top > 200 && r.bottom < window.innerHeight - 200 && (s.textContent || '').trim().length > 8; });
          if (!spans.length) return null;
          const r = spans[0].getBoundingClientRect();
          return { x: Math.round(r.left + 4), y: Math.round(r.top + r.height / 2), x2: Math.round(r.left + Math.min(80, r.width - 4)) };
        })()
      `);
      if (selInfo) {
        await leftDrag(cdp, selInfo.x, selInfo.y, selInfo.x2, selInfo.y, 5);
        const hitD = await cdp.eval(`
          (() => { const b=[...document.querySelectorAll('button')].find((x)=>(x.title||x.textContent||'').trim()==='高亮'); if (!b) return null; const r=b.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; })()
        `);
        if (hitD) await leftClick(cdp, hitD.x, hitD.y);
        await sleep(1200);
      }
      const newErrsD = cdp.consoleErrors.slice(errBeforeD);
      console.log(`  D 界面真实划词落批注：新增 console.error=${newErrsD.length}${newErrsD.length ? ` -> ${newErrsD[0].split('\n')[0]}` : ''}`);
    }

    // ---------------- [3] 点批注跳句
    console.log('\n[3] 点批注跳句：IPC 造 y=72% 的批注 -> 点 .rd-ann-row -> 看落点');
    // 护栏 1：若阅读器已被关掉（前一步误点等），先重开再测，别把"阅读器不在"当成产品失败
    if (!(await cdp.eval('!!document.querySelector(".rd-pdf-page")'))) {
      console.log('  （阅读器已关闭 -> 先重开）');
      await cdp.eval(`(() => { const i=document.getElementById('litshelf-search'); if (i) { i.focus(); i.select(); } return true; })()`);
      await cdp.send('Input.insertText', { text: openedName ?? '' });
      await sleep(800);
      await cdp.eval(`(() => { const rows=[...document.querySelectorAll('.row')]; (rows[0])?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return true; })()`);
      for (let i = 0; i < 60; i += 1) {
        if (await cdp.eval('document.querySelectorAll(".rd-pdf-text span").length > 5')) break;
        await sleep(500);
      }
      await sleep(500);
    }
    const tgt = items.find((x) => x.name === openedName);
    // 注意：必须带合法的 color —— 宿主/面板用 HIGHLIGHT_COLORS[annotation.color].light 取色，
    // 不带 color 会让批注列表渲染抛 TypeError（就是基线里那条 reading 'light'）。
    const created = await cdp.eval(
      `(async () => await window.litshelf.invoke('addAnnotation', [{ itemId: ${JSON.stringify(tgt?.id ?? '')}, type: 'highlight', color: 'yellow', page: ${page.pageNo}, rects: [{ x: 0.35, y: 0.72, w: 0.25, h: 0.02 }], text: '跳句验收标记', anchor: { prefix: '', suffix: '', occurrence: 1 }, comment: '' }]))()`,
    );
    ok(!!created?.id, `IPC 造批注成功（id=${created?.id ?? '无'}，page=${created?.page ?? '?'}，rect y=${created?.rects?.[0]?.y ?? '?'}，color=${created?.color ?? '无'}）`);

    await cdp.eval(`(() => { const t=[...document.querySelectorAll('.rd-side-tab')].find((b)=>(b.textContent||'').trim()==='批注'); t?.click(); return !!t; })()`);
    await sleep(900);
    const rowInfo = await cdp.eval(`
      (() => {
        const rows = [...document.querySelectorAll('.rd-ann-row')];
        const r = rows.find((x) => (x.textContent || '').includes('跳句验收标记')) ?? rows[0];
        if (!r) return { none: true, classes: [...document.querySelectorAll('.rd-side-body *')].slice(0, 12).map((e) => String(e.className || e.tagName)) };
        const b = r.getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), text: (r.textContent || '').trim().slice(0, 30), count: rows.length };
      })()
    `);
    const hasRow = !!rowInfo && !rowInfo.none;
    ok(hasRow, `侧栏出现批注行（${hasRow ? rowInfo.text : `没有；侧栏 class 头 12 个：${JSON.stringify(rowInfo?.classes ?? [])}`}）`);
    const scrollBefore = await cdp.eval('(document.querySelector(".rd-pdf-scroll")?.scrollTop ?? null)');
    if (hasRow) await leftClick(cdp, rowInfo.x, rowInfo.y);
    await sleep(1300);
    const scrollAfter = await cdp.eval('(document.querySelector(".rd-pdf-scroll")?.scrollTop ?? null)');
    const at = await cdp.eval(`
      (() => {
        const page = document.querySelector('.rd-pdf-page[data-page-index="${page.pageNo}"]');
        if (!page) return null;
        const pr = page.getBoundingClientRect();
        const y = pr.top + 0.72 * pr.height;
        return { y: Math.round(y), viewportH: window.innerHeight, pageTop: Math.round(pr.top), pageH: Math.round(pr.height) };
      })()
    `);
    const lo = at ? at.viewportH * 0.1 : 0;
    const hi = at ? at.viewportH * 0.85 : 0;
    console.log(`  scrollTop：${scrollBefore} -> ${scrollAfter}`);
    console.log(`  批注屏幕 y=${at?.y}（视口高 ${at?.viewportH}，允许 ${Math.round(lo)}-${Math.round(hi)}）；页面 top=${at?.pageTop} 高=${at?.pageH}；批注行数 ${rowInfo?.count ?? '?'}`);
    ok(!!at && at.y >= lo && at.y <= hi, `批注落在视口 10%~85%（y=${at?.y ?? '?'}）`);

    // ---------------- [4] 收尾
    console.log('\n[4] 收尾校验');
    const afterSnap = await snapshotSource();
    const changed = before.filter((b, i) => !afterSnap[i] || afterSnap[i].name !== b.name || afterSnap[i].size !== b.size || afterSnap[i].mtimeMs !== b.mtimeMs);
    ok(changed.length === 0, `用户论文目录 size/mtime 未变（${before.length} 个文件，变化 ${changed.length} 个）`, changed.map((c) => c.name).join(' | '));
    const errs = cdp.consoleErrors.filter((e) => !/DevTools|Autofill|Electron Security/i.test(e));
    ok(errs.length === 0, `渲染层 console.error = 0（实际 ${errs.length}）`, errs.slice(0, 2).join(' | '));

    console.log('\n主进程日志尾部：');
    for (const l of logs.trim().split('\n').slice(-3)) console.log(`    ${l.trim()}`);
  } finally {
    cdp?.close();
    child.kill();
    await sleep(800);
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }

  console.log(`\n${failures ? `❌ 失败 ${failures} 项` : '✅ 跨栏/跳句验收全部通过'}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(`验收中止：${err?.message ?? err}`);
  process.exit(1);
});

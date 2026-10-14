/**
 * 类人快拖验收网 —— 钉住"真人不松手连续快拖"才会暴露的一类 bug：
 *   ① 1~3 个字分别形成小选区（碎片）；② 拖到两个选区重叠处"抽风"；③ 跨栏泄漏。
 *
 * 跑法：
 *   $env:LITSHELF_SRC_LIB='C:\...\文献'        # 可选；未设置则退回本脚本生成的示例库
 *   Remove-Item Env:\ELECTRON_RUN_AS_NODE
 *   node scripts/build.mjs                      # 先定死 dist（记 index-*.js 指纹，跑完复查）
 *   node tools/col-drag-scan.mjs
 *
 * 约定：
 *   - 端口 **9666**（别的队友用 9555，别抢）；LITSHELF_DATA_DIR=tmp/dragscan-data（隔离）
 *   - 论文目录**只读**：只读取 + 快照 size/mtime，绝不写
 *   - **只 kill 自己 spawn 的进程树**（child.pid -> taskkill /PID <pid> /T /F）；**不要全局清 electron**
 *   - 不改产品代码、不放宽判据：红了就如实报原始数字
 *
 * 拖动方式：mousePressed -> 连续 mouseMoved（步长 3~12px、**不加 sleep**，只等 CDP 往返）-> mouseReleased。
 * 现有验收脚本每次 mouseMoved 之间 sleep 20~50ms（等于慢拖），测不到用户那类碎片。
 */
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const PORT = 9666;
const DATA = path.join(ROOT, 'tmp', 'dragscan-data');
const SRC = process.env.LITSHELF_SRC_LIB || path.join(ROOT, 'tmp', 'dragscan-src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RNG = (() => { let s = 12345; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) pass += 1; else fail += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
};

// ------------------------------------------------------------------ 示例库（仅当没有 LITSHELF_SRC_LIB）
function twoColPdf(pageCount = 3) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objects = [];
  const kids = [];
  const pages = [];
  for (let i = 0; i < pageCount; i += 1) {
    const pageObj = 5 + i * 2;
    const out = [];
    for (const x of [60, 320]) {
      for (let l = 0; l < 20; l += 1) out.push(`BT /F1 9 Tf ${x} ${760 - l * 16} Td (${esc(`col${x === 60 ? 1 : 2}page${i + 1}line${l + 1} abcdefghijklmnop`)} ) Tj ET`);
    }
    pages.push({ pageObj, contentObj: pageObj + 1, content: `${out.join('\n')}\n` });
    kids.push(`${pageObj} 0 R`);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[3] = '<< /Title (Drag Scan Fixture) >>';
  for (const p of pages) {
    objects[p.pageObj - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${p.contentObj} 0 R >>`;
    objects[p.contentObj - 1] = `<< /Length ${Buffer.byteLength(p.content, 'latin1')} >>\nstream\n${p.content}\nendstream`;
  }
  const parts = [];
  let bytes = 0;
  const push = (s) => { parts.push(s); bytes += Buffer.byteLength(s, 'latin1'); };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offs = [];
  objects.forEach((o, i) => { offs.push(bytes); push(`${i + 1} 0 obj\n${o}\nendobj\n`); });
  const xref = bytes;
  let x = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) x += `${String(o).padStart(10, '0')} 00000 n \n`;
  push(x);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(parts.join(''), 'latin1');
}

// ------------------------------------------------------------------ CDP
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.errors.push('console.error: ' + (m.params.args ?? []).map((a) => a.value ?? '').join(' '));
      if (m.method === 'Runtime.exceptionThrown') this.errors.push('exception: ' + String(m.params.exceptionDetails?.exception?.description ?? '').split('\n')[0]);
      if (m.method === 'Runtime.consoleAPICalled') {
        const t = (m.params.args ?? []).map((a) => a.value ?? '').join(' ');
        if (/unhandledrejection/i.test(t)) this.errors.push('unhandledrejection: ' + t.slice(0, 120));
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时 ${method}`)); } }, timeoutMs);
    });
  }
  async eval(expression, timeoutMs = 30000) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/** 类人快拖：连续 mouseMoved，步长 3~12px，**不加 sleep**（只等 CDP 往返） */
async function fastDrag(cdp, x1, y1, x2, y2) {
  const dist = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.max(2, Math.round(dist / (3 + RNG() * 9)));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x1 + (x2 - x1) * t + (RNG() - 0.5) * 2),
      y: Math.round(y1 + (y2 - y1) * t + (RNG() - 0.5) * 2),
      button: 'left',
      buttons: 1,
    });
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
  return steps;
}

/**
 * 页内模型：栏边界 + 行（自己算，不读产品日志）。
 * 行宽/栏宽都取"该行最宽的 x 簇"——双栏页左右栏行 y 相近，取整行最左到最右会误判成通栏。
 */
const readModel = (cdp) =>
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
        .map((x) => ({ x0: x.r.left - pr.left, x1: x.r.right - pr.left, top: x.r.top, bot: x.r.bottom, cy: x.r.top + x.r.height / 2, vx0: x.r.left, vx1: x.r.right, t: x.t }));
      if (spans.length < 15) return null;
      // 行（按 cy 5px 聚类）＋每行的 x 簇
      const lines = [];
      for (const s of [...spans].sort((a, b) => a.cy - b.cy)) {
        const L = lines[lines.length - 1];
        if (L && Math.abs(s.cy - L.cy) < 5) L.items.push(s);
        else lines.push({ cy: s.cy, items: [s] });
      }
      const clusters = [];
      for (const L of lines) {
        const xs = L.items.map((i) => [i.x0, i.x1]).sort((a, b) => a[0] - b[0]);
        const cl = [];
        for (const [a, b] of xs) {
          const last = cl[cl.length - 1];
          if (last && a - last[1] <= 20) last[1] = Math.max(last[1], b);
          else cl.push([a, b]);
        }
        L.clusters = cl;
        for (const c of cl) clusters.push({ x0: c[0], x1: c[1], cy: L.cy });
      }
      // 栏 = 按**行首 x**（每行的第一个 x 簇起点）聚类，只有与上一栏相差 >= max(100, 内容宽 15%) 才算新栏。
      // 不能拿"每行的每个 x 簇"去聚：行内宽间隙会把单栏页切成一堆假栏（实测出现过 4 个互相重叠的假栏）。
      const contentW = Math.max(...spans.map((s) => s.x1)) - Math.min(...spans.map((s) => s.x0));
      const minGap = Math.max(100, contentW * 0.15);
      const starts = lines.map((L) => ({ x0: L.clusters[0][0], x1: Math.max(...L.clusters.map((c) => c[1])), cy: L.cy })).sort((a, b) => a.x0 - b.x0);
      const cols = [];
      for (const s of starts) {
        const last = cols[cols.length - 1];
        if (!last || s.x0 - last.x0 >= minGap) cols.push({ x0: s.x0, x1: s.x1, n: 1 });
        else { last.x1 = Math.max(last.x1, s.x1); last.n += 1; }
      }
      // 收尾：按下一栏起点裁剪右边界（消除重叠），并丢掉宽度 < 25% 内容宽的假栏。
      // （双栏页左右栏行 y 相近会被并成"一行"，于是"只有右栏有文字"的行会把行首算到右栏 —— 不裁就会切出互相重叠的假栏。）
      const kept = cols.map((c, i, arr) => ({ ...c, x1: i + 1 < arr.length ? Math.min(c.x1, arr[i + 1].x0 - 4) : c.x1 }))
        .filter((c) => c.x1 - c.x0 > Math.max(80, contentW * 0.25));
      return {
        pageNo: Number(page.dataset.pageIndex),
        contentW: Math.round(contentW),
        rect: { left: Math.round(pr.left), top: Math.round(pr.top), width: Math.round(pr.width), height: Math.round(pr.height) },
        cols: kept.map((c) => ({ x0: Math.round(c.x0), x1: Math.round(c.x1), n: c.n })),
        lines: lines.map((L) => ({
          cy: Math.round(L.cy),
          clusters: L.clusters.map((c) => [Math.round(c[0]), Math.round(c[1])]),
          x0: Math.round(Math.min(...L.items.map((i) => i.x0))),
          x1: Math.round(Math.max(...L.items.map((i) => i.x1))),
          spanCount: L.items.length,
        })).filter((L) => L.cy > pr.top + 20 && L.cy < pr.top + pr.height - 20),
        pageLeft: Math.round(pr.left),
        pageTop: Math.round(pr.top),
      };
    })()
  `);

/** 选区读数 + 三条判据（栏归属按"按下点所在栏"） */
const readCase = (cdp, cols, pressColIdx, pressX, pressY) =>
  cdp.eval(`
    (() => {
      const cols = ${JSON.stringify(cols)};
      const pressCol = cols[${pressColIdx}] ?? null;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return { none: true, rangeCount: sel ? sel.rangeCount : 0 };
      const range = sel.getRangeAt(0);
      const asEl = (n) => (n && n.nodeType === 3 ? n.parentElement : n);
      const pageEl = asEl(range.startContainer)?.closest?.('.rd-pdf-page');
      if (!pageEl) return { none: true, rangeCount: sel.rangeCount };
      const pr = pageEl.getBoundingClientRect();
      const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
      if (!rects.length) return { none: true, rangeCount: sel.rangeCount };
      // (a) 跨栏：按 rect **中心**归属栏
      const centers = rects.map((r) => r.left + r.width / 2 - pr.left);
      const centerCols = centers.map((x) => cols.findIndex((c) => x >= c.x0 - 4 && x <= c.x1 + 4));
      const outside = centers.filter((x) => !pressCol || x < pressCol.x0 - 4 || x > pressCol.x1 + 4).length;
      // (b) 碎片：逐 span 用 intersectsNode；某行"只选中 1~3 字且有未选中 span 夹在选区首尾之间"
      const selMinX = Math.min(...rects.map((r) => r.left - pr.left));
      const selMaxX = Math.max(...rects.map((r) => r.right - pr.left));
      const selTop = Math.min(...rects.map((r) => r.top));
      const selBot = Math.max(...rects.map((r) => r.bottom));
      const cand = [...pageEl.querySelectorAll('.rd-pdf-text span')]
        .map((s) => ({ el: s, r: s.getBoundingClientRect(), t: (s.textContent || '').trim() }))
        .filter((x) => x.t.length > 0 && x.r.top >= selTop - 8 && x.r.bottom <= selBot + 8 && x.r.left - pr.left >= selMinX - 2 && x.r.right - pr.left <= selMaxX + 2);
      // 爆炸选区（几百个 rect / 上千字）不做逐 span 分析：太慢，且它本身已经是失败
      const runaway = rects.length > 300 || sel.toString().length > 600;
      if (runaway) {
        return { rangeCount: sel.rangeCount, text: '', len: sel.toString().length, rects: rects.length, minX: Math.round(selMinX), maxX: Math.round(selMaxX), outside, centerCols, candSpans: cand.length, unselectedTotal: -1, fragmentLines: -1, fragSamples: ['跳过逐span分析(爆炸选区)'], pressX: ${Math.round(pressX)}, pressY: ${Math.round(pressY)} };
      }
      const byLine = new Map();
      for (const s of cand) {
        const key = Math.round((s.r.top + s.r.bottom) / 2 / 5);
        if (!byLine.has(key)) byLine.set(key, []);
        byLine.get(key).push(s);
      }
      let unselectedTotal = 0;
      let fragmentLines = 0;
      const fragSamples = [];
      for (const [, arr] of byLine) {
        let unsel = 0;
        let chars = 0;
        for (const s of arr) {
          let hit = false;
          try { hit = range.intersectsNode(s.el); } catch { hit = false; }
          if (hit) chars += s.t.length; else unsel += 1;
        }
        unselectedTotal += unsel;
        if (unsel > 0 && chars >= 1 && chars <= 3) {
          fragmentLines += 1;
          if (fragSamples.length < 3) fragSamples.push('选中' + chars + '字+未选中' + unsel + '个');
        }
      }
      return {
        rangeCount: sel.rangeCount,
        text: sel.toString(),
        len: sel.toString().length,
        rects: rects.length,
        minX: Math.round(selMinX),
        maxX: Math.round(selMaxX),
        outside,
        centerCols,
        candSpans: cand.length,
        unselectedTotal,
        fragmentLines,
        fragSamples,
        pressX: ${Math.round(pressX)},
        pressY: ${Math.round(pressY)},
      };
    })()
  `);

async function launch() {
  const env = { ...process.env, LITSHELF_DATA_DIR: DATA };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [`--remote-debugging-port=${PORT}`, '.'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        return { cdp, child };
      }
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error('等不到 Electron 调试端口 9666');
}

async function main() {
  const usingEnv = !!process.env.LITSHELF_SRC_LIB;
  if (!usingEnv) {
    await fs.mkdir(SRC, { recursive: true }).catch(() => undefined);
    const p = path.join(SRC, 'dragscan-two-col.pdf');
    if (!fss.existsSync(p)) await fs.writeFile(p, twoColPdf(3));
  }
  const names = (await fs.readdir(SRC)).filter((f) => f.toLowerCase().endsWith('.pdf'));
  if (!names.length) throw new Error(`论文目录里没有 PDF：${SRC}`);
  const snap = async () => {
    const out = [];
    for (const n of names) { const st = await fs.stat(path.join(SRC, n)); out.push(`${n}|${st.size}|${Math.round(st.mtimeMs)}`); }
    return out.join('\n');
  };
  const before = await snap();
  await fs.rm(DATA, { recursive: true, force: true }).catch(() => undefined);
  console.log(`论文目录（只读）：${SRC}（${names.length} 篇${usingEnv ? '，来自 LITSHELF_SRC_LIB' : '，示例库'}）`);
  console.log(`隔离数据目录：${DATA}｜端口 ${PORT}`);

  const { cdp, child } = await launch();
  try {
    await sleep(3000);
    await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('跳过')); b?.click(); return true; })()`);
    await sleep(600);
    await cdp.eval(`(async () => { await window.litshelf.invoke('addRoot', [${JSON.stringify(SRC)}, { depth: 1 }]); return true; })()`);
    let items = [];
    for (let i = 0; i < 80; i += 1) {
      items = await cdp.eval(`(async () => (await window.litshelf.invoke('getSnapshot', [])).items.map((x) => ({ name: x.name, state: x.parseState })))()`);
      if (items.length && items.every((x) => x.state !== 'placeholder')) break;
      await sleep(500);
    }
    console.log(`入库 ${items.length} 篇`);

    // 找多栏页：**有界扫描**（最多 3 篇 × 每篇 4 页），不做全库遍历
    const backToLibrary = async () => {
      for (let i = 0; i < 4; i += 1) {
        const r = await cdp.eval(`({ reader: !!document.querySelector('.rd-pdf-page'), t: (document.querySelector('.topbar-title')?.textContent || '').trim() })`);
        if (!r.reader && r.t !== '设置') return true;
        cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await sleep(600);
      }
      return false;
    };
    let model = null;
    for (const it of items.slice(0, 3)) {
      if (model) break;
      await backToLibrary();
      await cdp.eval(`(() => { const i=document.getElementById('litshelf-search'); if (i) { i.focus(); i.select(); } return true; })()`);
      await cdp.send('Input.insertText', { text: it.name.replace(/\.pdf$/i, '').slice(0, 10) });
      await sleep(600);
      await cdp.eval(`(() => { const rows=[...document.querySelectorAll('.row')]; (rows[0])?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return true; })()`);
      for (let i = 0; i < 40; i += 1) { if (await cdp.eval('document.querySelectorAll(".rd-pdf-text span").length > 5')) break; await sleep(400); }
      for (let p = 1; p <= 4; p += 1) {
        const m = await readModel(cdp);
        if (m && m.cols.length >= 2 && m.cols.every((c) => m.lines.filter((L) => L.x0 >= c.x0 - 6 && L.x1 <= c.x1 + 6).length >= 2)) {
          model = m;
          console.log(`  找到多栏页：${it.name.slice(0, 14)}… P${m.cols.length} 栏 P${m.pageNo}`);
          break;
        }
        cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ']', code: 'BracketRight', windowsVirtualKeyCode: 221 });
        cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ']', code: 'BracketRight', windowsVirtualKeyCode: 221 });
        await sleep(600);
      }
    }
    if (!model) throw new Error('找不到 >=2 栏的页');
    const cols = model.cols;
    console.log(`\n栏位模型（自算）：P${model.pageNo} 内容宽 ${model.contentW}｜` + cols.map((c, i) => `栏${i + 1}[${c.x0}-${c.x1}]`).join(' ') + `｜可见行 ${model.lines.length}`);

    // 可拖动行：取前两栏里、视口内的行
    const linesByCol = cols.map((c) => model.lines.filter((L) => L.x0 >= c.x0 - 6 && L.x1 <= c.x1 + 6 && L.cy > 170 && L.cy < 880));
    const cases = [];
    const pushCases = (kind, n) => {
      const usable = cols.map((_, i) => i).filter((i) => linesByCol[i].length >= 2);
      if (!usable.length) throw new Error(`没有一栏里有 >=2 条可见行（栏位模型：${cols.map((c) => `[${c.x0}-${c.x1}]`).join(' ')}）`);
      for (let k = 0; k < n; k += 1) {
        const ci = usable[k % usable.length];
        const pool = linesByCol[ci];
        const L = pool[Math.floor(k / usable.length) % pool.length];
        const y = L.cy;
        const x0 = model.pageLeft + L.x0;
        const x1 = model.pageLeft + L.x1;
        if (kind === 'short') cases.push({ kind, ci, x1: x0 + 3, y1: y, x2: x0 + 40 + (k % 3) * 20, y2: y });
        else if (kind === 'long') cases.push({ kind, ci, x1: x0 + 2, y1: y, x2: x1 - 2, y2: y });
        else if (kind === 'vertical') {
          const L2 = pool[Math.min(pool.length - 1, pool.indexOf(L) + 4)] ?? pool[pool.length - 1];
          cases.push({ kind, ci, x1: x0 + 6, y1: y, x2: x0 + 6, y2: L2.cy });
        } else if (kind === 'crosscol') {
          const targets = usable.filter((i) => i !== ci && linesByCol[i].length >= 2);
          const last = targets.length ? targets[targets.length - 1] : ci;
          const poolT = linesByCol[last];
          const L3 = poolT[k % poolT.length];
          cases.push({ kind, ci, x1: x0 + 4, y1: y, x2: model.pageLeft + L3.x0 + 4, y2: y });
        } else if (kind === 'overlap') {
          cases.push({ kind, ci, x1: x0 + 20, y1: y, x2: x0 + 140, y2: y, pre: true });
        }
      }
    };
    pushCases('short', 8);
    pushCases('long', 8);
    pushCases('vertical', 8);
    pushCases('crosscol', 8);
    pushCases('overlap', 8);
    console.log(`用例 ${cases.length} 个（short/long/vertical/crosscol/overlap 各 8）\n`);

    // overlap 类：先拖一次留下选区，再在"已有选区附近/重叠处"快拖
    let lastSel = null;
    for (const c of cases) {
      if (c.pre) {
        await fastDrag(cdp, c.x1, c.y1, c.x2, c.y2);
        await sleep(120);
        lastSel = { x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 };
        continue;
      }
      if (c.kind === 'overlap' && lastSel) {
        c.x1 = Math.round((lastSel.x1 + lastSel.x2) / 2) - 30;
        c.x2 = Math.round((lastSel.x1 + lastSel.x2) / 2) + 60;
      }
      const steps = await fastDrag(cdp, c.x1, c.y1, c.x2, c.y2);
      // (c) 松手后 500ms 内稳定：3 次采样（快，且足够判定"松手后还在变"）
      await sleep(120);
      const s1 = await cdp.eval(`(() => { const s=window.getSelection(); if(!s||!s.rangeCount) return null; return s.toString() + '|' + s.getRangeAt(0).getClientRects().length; })()`);
      let stable = true;
      for (let i = 0; i < 2; i += 1) {
        await sleep(150);
        const s2 = await cdp.eval(`(() => { const s=window.getSelection(); if(!s||!s.rangeCount) return null; return s.toString() + '|' + s.getRangeAt(0).getClientRects().length; })()`);
        if (s1 !== s2) { stable = false; break; }
      }
      const r = await readCase(cdp, cols, c.ci, c.x1, c.y1);
      if (r?.none) {
        ok(false, `[${c.kind}] P${model.pageNo} 栏${c.ci + 1}[${cols[c.ci].x0}-${cols[c.ci].x1}] 拖动后没有选区`, `按下(${c.x1},${c.y1})→松开(${c.x2},${c.y2}) steps=${steps}`);
        continue;
      }
      const noCross = r.outside === 0;
      const noFrag = r.rangeCount === 1 && r.fragmentLines === 0;
      const label = `[${c.kind}] P${model.pageNo} 栏${c.ci + 1}[${cols[c.ci].x0}-${cols[c.ci].x1}] x ${r.minX}-${r.maxX}｜${r.len}字 ${r.rects}rect`;
      ok(noCross && noFrag && stable, `${label}`, `跨栏rect=${r.outside}｜碎片行=${r.fragmentLines}${r.fragSamples?.length ? `(${r.fragSamples.join(',')})` : ''}｜未选中span=${r.unselectedTotal}｜rangeCount=${r.rangeCount}｜稳定=${stable}｜steps=${steps}`);
    }

    // (d) 收尾自检
    const errs = cdp.errors.filter((e) => !/DevTools|Autofill/i.test(e));
    ok(errs.length === 0, `console.error/unhandledrejection = 0（实际 ${errs.length}）`, errs.slice(0, 2).join(' | '));
    const after = await snap();
    ok(before === after, `论文目录 size/mtime 零变化（${names.length} 篇）`, before === after ? '' : '发生了变化');
    console.log(`\n通过 ${pass} / 失败 ${fail}`);
  } finally {
    cdp?.close();
    // 只清自己 spawn 的进程树
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    await sleep(500);
  }
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`快拖扫描中止：${err?.message ?? err}`);
  process.exit(1);
});

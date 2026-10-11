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
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
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
        .map((x) => ({ x0: x.r.left - pr.left, x1: x.r.right - pr.left }));
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
        x0: Math.round(Math.min(...g.items.map((i) => i.x0))),
        x1: Math.round(Math.max(...g.items.map((i) => i.x1))),
        n: g.items.length,
      }));
      const contentW = Math.max(...src.map((s) => s.x1)) - Math.min(...src.map((s) => s.x0));
      const cols = strong
        .filter((c) => c.x1 - c.x0 > Math.max(80, contentW * 0.25))
        .sort((a, b) => a.x0 - b.x0)
        .map((c, i, arr) => ({ x0: c.x0, x1: i + 1 < arr.length ? Math.min(c.x1, arr[i + 1].x0 - 4) : c.x1, n: c.n }));
      return { ...base, contentW: Math.round(contentW), cols, gaps: strong.map((c) => [c.x0, c.x1, c.n]) };
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
    const candidates = [...items].sort((a, b) => prefer(a.name) - prefer(b.name) || (b.pages ?? 0) - (a.pages ?? 0)).slice(0, 4);
    let best = null;
    let openedName = null;
    for (const cand of candidates) {
      await cdp.eval(`(() => { const b=[...document.querySelectorAll('.icon-btn')].find((x)=>(x.title||'')==='返回'); b?.click(); return true; })()`);
      await cdp.eval(`(() => { const i=document.getElementById('litshelf-search'); if (i) { i.focus(); i.select(); } return true; })()`);
      await cdp.send('Input.insertText', { text: cand.name });
      await sleep(800);
      const opened = await cdp.eval(`
        (() => {
          const rows = [...document.querySelectorAll('.row')];
          const r = rows.find((x) => (x.textContent || '').includes('PDF')) ?? rows[0];
          if (!r) return false;
          r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          return true;
        })()
      `);
      if (!opened) continue;
      let ready = false;
      for (let i = 0; i < 60; i += 1) {
        ready = await cdp.eval('document.querySelectorAll(".rd-pdf-text span").length > 5');
        if (ready) break;
        await sleep(500);
      }
      if (!ready) continue;
      openedName = cand.name;
      for (let p = 1; p <= Math.min(cand.pages ?? 1, 6); p += 1) {
        const info = await readPage(cdp);
        if (info && info.spanCount >= 20) {
          console.log(`  · ${cand.name.slice(0, 16)}… P${info.pageNo}：span ${info.spanCount}，行首簇 ${JSON.stringify(info.gaps)} -> ${info.cols.length} 栏`);
          if (info.cols.length >= 2) {
            if (!best || info.cols.length > best.cols.length) best = info;
            break;
          }
        }
        cdp.fire('Input.dispatchKeyEvent', { type: 'keyDown', key: ']', code: 'BracketRight', windowsVirtualKeyCode: 221 });
        cdp.fire('Input.dispatchKeyEvent', { type: 'keyUp', key: ']', code: 'BracketRight', windowsVirtualKeyCode: 221 });
        await sleep(900);
      }
      if (best) break;
    }
    ok(!!openedName, `打开论文：${openedName ?? '（没打开任何候选）'}`);
    if (!best) {
      ok(false, '没有找到任何「有栏」的正文页（cols >= 2）');
      return;
    }
    const page = best;
    const colCount = page.cols.length;
    console.log(`\n[栏位] 第 ${page.pageNo} 页：${colCount} 栏 ` + page.cols.map((c, i) => `#${i + 1}[${c.x0}-${c.x1}]`).join(' ') + `（页宽 ${page.rect.width}，内容宽 ${page.contentW}，span ${page.spanCount}）`);
    ok(colCount >= 2, `正文页至少 2 栏（实测 ${colCount} 栏；任务描述写「三栏」，若为 2 栏说明该论文是双栏排版，判据不变）`);

    const c1 = page.cols[0];
    const cLast = page.cols[colCount - 1];

    // ---------------- [1] 跨栏禁止
    console.log('\n[1] 跨栏禁止：第一栏中间横向拖到最后一栏');
    const pair = await cdp.eval(`
      (() => {
        const page = document.querySelector('.rd-pdf-page[data-page-index="${page.pageNo}"]');
        if (!page) return { none: true, why: 'no page' };
        const pr = page.getBoundingClientRect();
        const spans = [...page.querySelectorAll('.rd-pdf-text span')]
          .map((s) => ({ r: s.getBoundingClientRect(), t: (s.textContent || '').trim() }))
          .filter((x) => x.t.length > 4 && x.r.top > 150 && x.r.bottom < window.innerHeight - 80)
          .map((x) => ({ l: x.r.left - pr.left, rr: x.r.right - pr.left, cy: x.r.top + x.r.height / 2, t: x.t }))
          .sort((a, b) => a.cy - b.cy);
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
    console.log(`  左栏 x 区间（页面局部）：${c1.x0}-${c1.x1}；末栏：${cLast.x0}-${cLast.x1}；容差 6px`);
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

    // ---------------- [2] 栏内正常
    console.log('\n[2] 栏内正常：同一栏内纵向拖 3~4 行');
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
    const hasLines = !!lineInfo && !lineInfo.few;
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

/**
 * 本轮 UX 优化的**独立回归验收**（第二套阅读器交互断言，不依赖 tools/ 下其它脚本的夹具）。
 *
 * 为什么单独一套：e2e / acceptance / acceptance-cjk 覆盖的是库与阅读主干；
 * 本脚本覆盖本轮新增的键盘与右键交互：
 *   A. 夹具与入库（自造 3 页 PDF，隔离目录，不碰真实库 / 不写用户「文档」目录）
 *   B. 文献库里 `?` 打开快捷键面板 + 面板内容含本轮新增条目
 *   C. 双击进阅读器、文本层就绪
 *   D. 快速标注：拖选 → 工具条 → 按 1/2/3/4 分别落 highlight / underline / squiggly / strikeout
 *      （文字非空、工具条自动收起），并有"无选区按 1 不落库"的负向对照
 *   E. `b` 加书签 / `t` 循环阅读主题 / `[` `]` 上下翻页 / `f` 进图全屏
 *   E2. 键重复护栏：keyDown(autoRepeat) 连发不能连落多条书签
 *   F. 右键菜单：有选区 7 项、无选区 4 项、贴边不越界、Esc / 点别处 / 滚动关闭、
 *      右键不破坏选区、点「高亮」确实落库
 *   F2. 选区与 pending 不同步的兜底：拖选 → 按 1 → **不点页面** → 空白右键 → 点「高亮」，
 *       要么落库要么给提示，**不允许静默无反应**
 *   G. 快捷键面板（`?`）的 Esc 层级：Esc 只关面板、阅读器仍在
 *   G2. **真对话框**的 Esc 层级：阅读器里点顶栏「扫描中」打开扫描进度弹框（.modal-backdrop，
 *       由 Modal 自己的监听器关闭）→ Esc → 弹框关、扫描仍在进行、阅读器仍在
 *   G3. 阅读器「更多」菜单（.rd-menu）：鼠标打开 → Esc 关闭且阅读器仍在；
 *       键盘可达回归：聚焦按钮后 `Enter` / `Space` 都能打开菜单，且 `Space` 不会被当成"下一页"顺带翻页
 *   H. 渲染层零错误
 *
 * 口径说明（都是踩过的坑）：
 *   - 阅读主题必须读 `getSnapshot().settings.readerTheme`，**不能读 DOM 属性**；
 *   - 快速标注的真实类型字面量是 `squiggly`（波浪线）/ `strikeout`（删除线）；
 *   - 所有按键前先 blur 掉输入框，否则会被"正在输入"的守卫吞掉。
 *
 * 用法：node tools/acceptance-ux.mjs
 * 端口 9444（避开 e2e/acceptance 的 9222 与 acceptance-cjk 的 9111）；
 * 数据目录 tmp/ux-acceptance-data（每次运行前重建）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const PORT = 9444;
const DATA = path.join(ROOT, 'tmp', 'ux-acceptance-data');
const FIXTURE = path.join(ROOT, 'tmp', 'ux-fixture');
const SHOTS = path.join(ROOT, 'tmp', 'shots-ux');
const LIB_NAME = 'ux-acceptance-sample.pdf';
/** 第三轮：多页 + 带目录的大夹具 */
const BIG_NAME = 'ux-thumbs-sample.pdf';
const BIG_PAGES = 24;

// 只跑指定小节：`UX_SECTIONS=I` 或 `UX_SECTIONS=I,J,K`（留空 = 全跑）。
// 用来在只改了脚本判据时快速复跑 [I]–[P]，不必每次跑满 [A]–[H]。
const SECTION_FILTER = (process.env.UX_SECTIONS ?? '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const LEGACY_SECTIONS = ['B', 'C', 'D', 'E', 'E2', 'F', 'F2', 'G', 'G2', 'G3', 'H'];
const NEW_SECTIONS = ['I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'];
/** 专项压测（只跑 [A] + 专项）：UX_C_ROUNDS=5 压 [C] 文本层多轮；UX_G2_ROUNDS=5 压 [G2] 多轮 */
const C_ROUNDS = Number(process.env.UX_C_ROUNDS ?? 0);
const G2_ROUNDS = Number(process.env.UX_G2_ROUNDS ?? 0);
const STRESS_MODE = C_ROUNDS > 0 || G2_ROUNDS > 0;
const runLegacy = !STRESS_MODE && (SECTION_FILTER.length === 0 || SECTION_FILTER.some((s) => LEGACY_SECTIONS.includes(s)));
const runNew = !STRESS_MODE && (SECTION_FILTER.length === 0 || SECTION_FILTER.some((s) => NEW_SECTIONS.includes(s)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
};

// ---------------------------------------------------------------- CDP 客户端

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    /** console.warn / console.error 原文（专项压测要抓 "[reader] 第 N 页…" 那类看门狗日志） */
    this.consoleLogs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'warning' || m.params.type === 'error')) {
        this.consoleLogs.push(
          `[console.${m.params.type}] ` + (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '),
        );
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '');
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') this.errors.push(m.params.entry.text);
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
  async shot(name) {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'png' }, 20000);
      await fs.writeFile(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
      console.log(`  📷 ${name}`);
    } catch (err) {
      console.log(`  （截图 ${name} 失败：${err.message}）`);
    }
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// ------------------------------------------------- 自造 3 页 PDF 夹具（ASCII/Helvetica）

const escPdf = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** 单页内容流：与 src/core/sample.ts 同样的 /F1 Helvetica 手写写法 */
function pageContent(pageIndex, total, tag) {
  const n = pageIndex + 1;
  const lines = [
    `${tag} - Page ${n}`,
    `Page ${n} of ${total} - reader interaction checks`,
    `Marker alpha uniquepage${n} delta echo foxtrot golf hotel india.`,
    `Marker kilo lima mike november oscar papa quebec romeo sierra tango.`,
    `Marker uniform victor whiskey xray yankee zulu page${n} end.`,
  ];
  const out = [];
  let y = 742;
  lines.forEach((line, i) => {
    const size = i === 0 ? 15 : 12;
    out.push(`BT /F1 ${size} Tf 72 ${y} Td (${escPdf(line)}) Tj ET`);
    y -= i === 0 ? 26 : 22;
  });
  return `${out.join('\n')}\n`;
}

/**
 * 手写一个合法的多页 PDF（对象 + xref + trailer + startxref）。
 * opts.outline: [{ title, page }]（page 从 1 开始）→ 写一份真的 /Outlines，
 * 这样阅读器「目录」面板才有条目可点（第三轮验收的"点目录项落点"要用）。
 */
function buildPdf(pageCount, tag = 'UX Acceptance Sample', opts = {}) {
  const outline = opts.outline ?? [];
  const pages = [];
  const kids = [];
  for (let i = 0; i < pageCount; i += 1) {
    const pageObj = 5 + i * 2; // 1 Catalog / 2 Pages / 3 Font / 4 Info，之后每页两个对象
    pages.push({ pageObj, contentObj: pageObj + 1, content: pageContent(i, pageCount, tag) });
    kids.push(`${pageObj} 0 R`);
  }
  // 大纲对象接在所有页对象之后：root 编号 = 4 + 2*pageCount + 1
  const outlineRootNum = 5 + 2 * pageCount;
  const outlineFirstNum = outlineRootNum + 1;

  const objects = [];
  objects[0] = outline.length
    ? `<< /Type /Catalog /Pages 2 0 R /Outlines ${outlineRootNum} 0 R >>`
    : '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[3] =
    `<< /Title (${escPdf(tag)}) /Author (LitShelf Verifier) /Subject (reader interaction checks) ` +
    '/Creator (LitShelf UX Acceptance) /Producer (LitShelf) >>';
  for (const p of pages) {
    objects[p.pageObj - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${p.contentObj} 0 R >>`;
    objects[p.contentObj - 1] = `<< /Length ${Buffer.byteLength(p.content, 'latin1')} >>\nstream\n${p.content}\nendstream`;
  }
  if (outline.length) {
    const items = outline.map((entry, i) => {
      const objNum = outlineFirstNum + i;
      const pageObj = 5 + Math.max(0, Math.min(pageCount - 1, entry.page - 1)) * 2;
      let s = `<< /Title (${escPdf(entry.title)}) /Parent ${outlineRootNum} 0 R /Dest [${pageObj} 0 R /Fit]`;
      if (i > 0) s += ` /Prev ${objNum - 1} 0 R`;
      if (i < outline.length - 1) s += ` /Next ${objNum + 1} 0 R`;
      return `${s} >>`;
    });
    objects[outlineRootNum - 1] =
      `<< /Type /Outlines /First ${outlineFirstNum} 0 R /Last ${outlineFirstNum + outline.length - 1} 0 R ` +
      `/Count ${outline.length} >>`;
    items.forEach((s, i) => {
      objects[outlineFirstNum - 1 + i] = s;
    });
  }

  const parts = [];
  let bytes = 0;
  const push = (s) => {
    parts.push(s);
    bytes += Buffer.byteLength(s, 'latin1');
  };
  push('%PDF-1.4\n');
  push('%\xE2\xE3\xCF\xD3\n');
  const offsets = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(bytes);
    push(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
  }
  const xrefOffset = bytes;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(parts.join(''), 'latin1');
}

// ---------------------------------------------------------------- 输入模拟

/** 所有按键前必须清掉输入焦点，否则会被 "正在输入" 的守卫吞掉 */
async function blur(cdp) {
  await cdp.eval(`(() => { const el = document.activeElement; if (el && el.blur) el.blur(); return true; })()`);
}

function key(cdp, k, opts = {}) {
  const mods = opts.mods ?? 0;
  const code = opts.code ?? `Key${k.toUpperCase()}`;
  const vk = opts.vk ?? k.toUpperCase().charCodeAt(0);
  cdp.fire('Input.dispatchKeyEvent', {
    type: 'keyDown',
    modifiers: mods,
    key: k,
    code,
    windowsVirtualKeyCode: vk,
    ...(opts.text ? { text: opts.text } : {}),
  });
  cdp.fire('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, key: k, code, windowsVirtualKeyCode: vk });
}

const KEY = {
  question: { code: 'Slash', vk: 191, text: '?' },
  esc: { code: 'Escape', vk: 27 },
  one: { code: 'Digit1', vk: 49 },
  four: { code: 'Digit4', vk: 52 },
  b: { code: 'KeyB', vk: 66 },
  t: { code: 'KeyT', vk: 84 },
  f: { code: 'KeyF', vk: 70 },
  bracketL: { code: 'BracketLeft', vk: 219 },
  bracketR: { code: 'BracketRight', vk: 221 },
};

async function press(cdp, k, opts = {}) {
  await blur(cdp);
  key(cdp, k, opts);
  await sleep(opts.wait ?? 700);
}

/** 不 blur 的按键：给"聚焦某个元素后按 Enter/Space"的键盘可达性用例（blur 会把焦点弄丢） */
async function pressFocused(cdp, k, opts = {}) {
  key(cdp, k, opts);
  await sleep(opts.wait ?? 700);
}

async function leftDrag(cdp, x1, y1, x2, y2) {
  await cdp.eval('window.getSelection()?.removeAllRanges()');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 6; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: x1 + ((x2 - x1) * i) / 6,
      y: y1 + ((y2 - y1) * i) / 6,
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

async function rightClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
  await sleep(600);
}

async function wheel(cdp, x, y, dy) {
  cdp.fire('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
  await sleep(700);
}

// ---------------------------------------------------------------- DOM 读数

/** `?` 快捷键面板：.modal-backdrop + .modal-title，顺带把每一行 [说明, 键位] 抽出来 */
const panelInfo = (cdp) =>
  cdp.eval(`
    (() => {
      const backdrop = document.querySelector('.modal-backdrop');
      if (!backdrop) return null;
      const rows = [...document.querySelectorAll('.shortcut-row')].map((r) => [
        (r.children[0]?.textContent || '').trim(),
        (r.children[1]?.textContent || '').trim(),
      ]);
      return {
        title: (document.querySelector('.modal-title')?.textContent || '').trim(),
        rows,
        text: (backdrop.innerText || '').slice(0, 3000),
      };
    })()
  `);

const toolbarCount = (cdp) =>
  cdp.eval(
    `(() => [...document.querySelectorAll('button')].filter((b) => /^(高亮|下划线|波浪线|删除线)$/.test((b.title || b.textContent || '').trim())).length)()`,
  );

const anns = (cdp) =>
  cdp.eval(
    `(async () => (await window.litshelf.invoke('listAllAnnotations', [])).map((a) => ({ id: a.id, type: a.type, text: a.text || '', page: a.page, rects: a.rects?.length ?? 0 })))()`,
  );

/** 当前屏幕上的提示条文字（兜底提示要能被这里看到） */
const toastText = (cdp) => cdp.eval(`[...document.querySelectorAll('.toast-msg')].map((e) => e.textContent.trim()).join(' | ')`);

const themeOf = (cdp) => cdp.eval(`(async () => (await window.litshelf.invoke('getSnapshot', [])).settings.readerTheme)()`);

/** 页码「X / Y 页」——阅读器里唯一稳定的页位读数 */
const pageOf = (cdp) =>
  cdp.eval(`(() => { const m = document.body.innerText.match(/(\\d+)\\s*\\/\\s*(\\d+)\\s*页/); return m ? { cur: Number(m[1]), total: Number(m[2]) } : null; })()`);

const state = (cdp) =>
  cdp.eval(`
    ({
      sel: window.getSelection()?.toString() ?? '',
      toolbar: !!document.querySelector('.rd-sel-toolbar'),
      card: !!document.querySelector('.rd-ann-card'),
      menu: !!document.querySelector('.rd-ctx-menu'),
      reader: !!document.querySelector('.rd-pdf-host, .rd-root'),
      pages: document.querySelectorAll('.rd-pdf-page').length,
      spans: document.querySelectorAll('.rd-pdf-text span').length,
      fullscreen: !!document.fullscreenElement,
    })
  `);

const menuInfo = (cdp) =>
  cdp.eval(`
    (() => {
      const el = document.querySelector('.rd-ctx-menu');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const items = [...el.querySelectorAll('.rd-ctx-item')];
      return {
        role: el.getAttribute('role'),
        labels: items.map((b) => b.textContent.trim()),
        roles: items.map((b) => b.getAttribute('role')),
        titles: items.map((b) => b.title),
        separators: el.querySelectorAll('[role="separator"]').length,
        rect: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) },
        inViewport: r.left >= -0.5 && r.top >= -0.5 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      };
    })()
  `);

/** 取若干行可拖选的正文（在视口内、不被顶栏/底栏压住）；多行是为了 1/2/3/4 各选一行，互不叠高亮 */
const pickLines = (cdp) =>
  cdp.eval(`
    (() => {
      return [...document.querySelectorAll('.rd-pdf-text span')]
        .filter((s) => {
          const t = (s.textContent || '').trim();
          const r = s.getBoundingClientRect();
          return t.length >= 10 && r.width > 120 && r.top > 160 && r.bottom < window.innerHeight - 120;
        })
        .map((s) => {
          const r = s.getBoundingClientRect();
          return {
            x: Math.round(r.left + 2),
            y: Math.round(r.top + r.height / 2),
            right: Math.round(r.right),
            x2: Math.round(r.left + Math.min(90, r.width - 8)),
            text: s.textContent.slice(0, 24),
            width: Math.round(r.width),
          };
        })
        .slice(0, 6);
    })()
  `);

/** 页面里真正的空白点：优先完全不在文字层里的点，退而求其次取"在文字层容器内但不在任何 span 上"的点 */
const pickBlank = (cdp) =>
  cdp.eval(`
    (() => {
      const page = document.querySelector('.rd-pdf-page');
      if (!page) return null;
      const pr = page.getBoundingClientRect();
      const rects = [...page.querySelectorAll('.rd-pdf-text span')].map((s) => s.getBoundingClientRect());
      const lastBottom = rects.length ? Math.max(...rects.map((r) => r.bottom)) : pr.top;
      const maxY = Math.min(window.innerHeight - 30, pr.bottom - 20);
      const cands = [
        { x: Math.round(pr.right - 18), y: Math.round(Math.min(maxY, lastBottom + 45)) },
        { x: Math.round(pr.left + pr.width / 2), y: Math.round(Math.min(maxY, lastBottom + 45)) },
        { x: Math.round(pr.left + pr.width / 2), y: Math.round(Math.min(maxY, pr.top + 24)) },
        { x: Math.round(pr.left + 18), y: Math.round(Math.min(maxY, lastBottom + 60)) },
      ];
      const probe = (strict) => {
        for (const c of cands) {
          const el = document.elementFromPoint(c.x, c.y);
          const inPage = !!el?.closest?.('.rd-pdf-page');
          const onSpan = !!el?.closest?.('.rd-pdf-text span');
          const inTextLayer = !!el?.closest?.('.rd-pdf-text');
          if (inPage && !onSpan && (!strict || !inTextLayer)) {
            return { ...c, cls: el.className, inPage, onSpan, inTextLayer };
          }
        }
        return null;
      };
      return probe(true) ?? probe(false);
    })()
  `);

/** 页面可见区域右下角的贴边点（用来验证菜单不越界） */
const pickCorner = (cdp) =>
  cdp.eval(`
    (() => {
      const page = document.querySelector('.rd-pdf-page');
      if (!page) return null;
      const pr = page.getBoundingClientRect();
      const right = Math.min(pr.right, window.innerWidth);
      const bottom = Math.min(pr.bottom, window.innerHeight);
      for (let dy = 6; dy <= 300; dy += 10) {
        for (let dx = 6; dx <= 300; dx += 10) {
          const x = Math.round(right - dx);
          const y = Math.round(bottom - dy);
          if (x <= 0 || y <= 0) continue;
          const el = document.elementFromPoint(x, y);
          if (el?.closest?.('.rd-pdf-page')) return { x, y, cls: el.className };
        }
      }
      return null;
    })()
  `);

/** 造一个"够大、值得扫描一会儿"的目录：用来让顶栏进度按钮出现足够久，好验证真对话框的 Esc 层级 */
async function makeBulk(attempt, count = 300) {
  const dir = path.join(ROOT, 'tmp', `ux-bulk-${attempt}`);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(dir, { recursive: true });
  const buffers = [];
  for (let i = 0; i < count; i += 1) buffers.push(buildPdf(3, `Bulk Scan Sample ${attempt}-${i}`));
  for (let i = 0; i < buffers.length; i += 1) {
    await fs.writeFile(path.join(dir, `bulk-${String(i).padStart(3, '0')}.pdf`), buffers[i]);
  }
  return dir;
}

/**
 * 真对话框的 Esc 层级：
 *   阅读器里挂一个批量目录 → 顶栏「扫描中」出现 → 点它打开「扫描进度」弹框
 *   → 立刻 Esc → 记录前后状态。
 * 关键在 pre/post 都带 `active`（扫描是否仍在进行）：只有"按 Esc 前后扫描都在跑"，
 * 才能排除"扫描结束导致弹框自动消失"这种假绿。
 */
async function tryRealDialogEsc(cdp, bulkDir) {
  const res = await cdp.eval(`
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const p = window.litshelf.invoke('addRoot', [${JSON.stringify(bulkDir)}, { depth: 1 }]).catch(() => null);
      for (let i = 0; i < 400; i += 1) {
        const btn = document.querySelector('.topbar-progress');
        if (btn && !document.querySelector('.modal-backdrop')) {
          btn.click();
          for (let j = 0; j < 40; j += 1) {
            if (document.querySelector('.modal-backdrop')) return { clicked: true, modal: true, waitedMs: i * 15 + j * 15 };
            await sleep(15);
          }
          await p;
          return { clicked: true, modal: !!document.querySelector('.modal-backdrop') };
        }
        await sleep(15);
      }
      await p;
      return { clicked: false, modal: !!document.querySelector('.modal-backdrop') };
    })()
  `);
  if (!res?.modal) return { ...res, pre: null, post: null };
  const pre = await cdp.eval(
    `({
      modal: !!document.querySelector('.modal-backdrop'),
      active: !!document.querySelector('.topbar-progress'),
      reader: !!document.querySelector('.rd-pdf-page'),
      title: (document.querySelector('.modal-title')?.textContent || '').trim(),
    })`,
  );
  await blur(cdp);
  key(cdp, 'Escape', KEY.esc); // 不 await，尽量贴近"弹框刚打开就按 Esc"
  await sleep(500);
  const post = await cdp.eval(
    `({
      modal: !!document.querySelector('.modal-backdrop'),
      active: !!document.querySelector('.topbar-progress'),
      reader: !!document.querySelector('.rd-pdf-page'),
    })`,
  );
  return { ...res, pre, post };
}

/** 阅读器「更多」菜单是否打开 */
const moreMenuOpen = (cdp) => cdp.eval('!!document.querySelector(".rd-menu")');

// ---------------------------------------------- 第三轮（task-9）新增的读数与动作 helper

/** 库里按名字搜索并双击打开（bulk 目录有几百条，列表虚拟滚动，必须靠搜索） */
async function openByName(cdp, query) {
  await cdp.eval(`(() => { const i = document.getElementById('litshelf-search'); if (!i) return false; i.focus(); i.select(); return true; })()`);
  await cdp.send('Input.insertText', { text: query });
  await sleep(900);
  const hit = await cdp.eval(`
    (() => {
      const rows = [...document.querySelectorAll('.row')];
      const r = rows.find((x) => (x.textContent || '').includes(${JSON.stringify(query)})) ?? rows[0];
      if (!r) return null;
      r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return { rows: rows.length, text: (r.textContent || '').slice(0, 40) };
    })()
  `);
  if (!hit) return null;
  const snap = () =>
    cdp.eval(`
      ({
        rows: document.querySelectorAll('.row').length,
        search: (document.getElementById('litshelf-search')?.value ?? ''),
        reader: !!document.querySelector('.rd-pdf-page'),
        stage: !!document.querySelector('.rd-pdf-scroll'),
        canvases: document.querySelectorAll('.rd-pdf-page canvas').length,
        textDivs: document.querySelectorAll('.rd-pdf-text').length,
        spans: document.querySelectorAll('.rd-pdf-text span').length,
        topbar: (document.querySelector('.topbar-title')?.textContent || '').trim(),
      })
    `);
  for (let i = 0; i < 80; i += 1) {
    if (await cdp.eval('document.querySelectorAll(".rd-pdf-text span").length > 5')) return { ...hit, ready: true };
    await sleep(500);
  }
  // 失败时把 DOM 现场带回去：好判断是"阅读器没开"还是"开了但文本层没挂 span"
  return { ...hit, ready: false, diag: await snap() };
}

/** 只在库里做搜索过滤（不打开），配合下面的"带时延测量"的打开用 */
async function searchLibrary(cdp, query) {
  await cdp.eval(`(() => { const i = document.getElementById('litshelf-search'); if (!i) return false; i.focus(); i.select(); return true; })()`);
  await cdp.send('Input.insertText', { text: query });
  await sleep(900);
  return cdp.eval(`[...document.querySelectorAll('.row')].map((r) => (r.textContent || '').slice(0, 40))`);
}

/**
 * 双击打开 + 在**页面内**测量"从双击到可见页文本层出 span"的时延（25ms 粒度，不受 CDP 往返影响）。
 * 第三轮的硬指标：< 5000ms（修复前主进程抽取饿死 I/O 时会 15–25s）。
 */
async function openMeasured(cdp, rowMatch, maxMs = 10000) {
  return cdp.eval(
    `
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const rows = [...document.querySelectorAll('.row')];
      const row = rows.find((x) => (x.textContent || '').includes(${JSON.stringify(rowMatch)})) ?? rows[0];
      if (!row) return { ok: false, why: 'no row' };
      const t0 = performance.now();
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const marks = {};
      let firstSpanMs = null;
      for (let i = 0; i < ${Math.ceil(maxMs / 25)}; i += 1) {
        if (marks.reader === undefined && document.querySelector('.rd-pdf-page')) marks.reader = Math.round(performance.now() - t0);
        if (marks.canvas === undefined && document.querySelector('.rd-pdf-page canvas')) marks.canvas = Math.round(performance.now() - t0);
        if (marks.textDiv === undefined && document.querySelector('.rd-pdf-text')) marks.textDiv = Math.round(performance.now() - t0);
        const spans = document.querySelectorAll('.rd-pdf-text span').length;
        if (spans > 0) { firstSpanMs = Math.round(performance.now() - t0); marks.spans = spans; break; }
        await sleep(25);
      }
      return { ok: firstSpanMs !== null, firstSpanMs, marks, spans: document.querySelectorAll('.rd-pdf-text span').length };
    })()
  `,
    40000,
  );
}

/** 某一页的左边缘相对阅读器滚动容器顶部的偏移（连续布局下用来判断"停在页顶附近"） */
const pageOffsetTop = (cdp, n) =>
  cdp.eval(`
    (() => {
      const el = document.querySelector('.rd-pdf-page[data-page-index="${n}"]');
      const sc = document.querySelector('.rd-pdf-scroll');
      if (!el || !sc) return null;
      return Math.round(el.getBoundingClientRect().top - sc.getBoundingClientRect().top);
    })()
  `);

/** 点缩略图面板里的第 n 页（先把面板滚到它可见、等布局稳定、确认点击点确实落在它身上，再点） */
async function clickThumb(cdp, n) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await cdp.eval(`
      (() => {
        const root = document.querySelector('.rd-thumbs');
        const node = document.querySelector('[data-thumb-page="${n}"]');
        if (root && node) root.scrollTop = Math.max(0, node.offsetTop - root.clientHeight / 2 + node.clientHeight / 2);
        return true;
      })()
    `);
    await sleep(400); // 缩略图是异步出的，等这一屏布局稳定再量坐标
    const info = await cdp.eval(`
      (() => {
        const node = document.querySelector('[data-thumb-page="${n}"]');
        if (!node) return null;
        const r = node.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        const owner = hit?.closest?.('[data-thumb-page]');
        return { x, y, inView: r.top > 0 && r.bottom < window.innerHeight, hitPage: owner ? Number(owner.dataset.thumbPage) : null };
      })()
    `);
    if (!info) return null;
    if (info.hitPage === n && info.inView) {
      await leftClick(cdp, info.x, info.y);
      return info;
    }
    console.log(`  （缩略图第 ${n} 页坐标未命中：hit=${info.hitPage} inView=${info.inView}，重试）`);
  }
  return null;
}

/** 回到文献库视图（可能要先关阅读器、再退出设置页；搜索词会先被 Esc 清掉） */
async function goLibrary(cdp) {
  for (let i = 0; i < 6; i += 1) {
    const st = await cdp.eval(
      `({ reader: !!document.querySelector('.rd-pdf-page'), title: (document.querySelector('.topbar-title')?.textContent || '').trim() })`,
    );
    if (!st.reader && st.title !== '设置') return true;
    await press(cdp, 'Escape', KEY.esc);
    await sleep(700);
  }
  return false;
}

/** 切换阅读器侧栏 tab（'批注' / '目录' / '缩略图' / '信息'） */
async function openTab(cdp, label) {
  const okTab = await cdp.eval(`
    (() => {
      const t = [...document.querySelectorAll('.rd-side-tab')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(label)});
      t?.click();
      return !!t;
    })()
  `);
  await sleep(600);
  return okTab;
}

/** 缩放标签（.rd-zoom-value 的文本，例如 "150%"） */
const zoomLabel = (cdp) => cdp.eval(`(document.querySelector('.rd-zoom-value')?.textContent || '').trim()`);

/** 当前设置的只读快照 */
const settingsOf = (cdp) => cdp.eval(`(async () => (await window.litshelf.invoke('getSnapshot', [])).settings)()`);

/** 切阅读布局：continuous / single / double */
async function setLayout(cdp, layout) {
  await cdp.eval(`(async () => { await window.litshelf.invoke('updateSettings', [{ readerLayout: ${JSON.stringify(layout)} }]); return true; })()`);
  await sleep(900);
}

/** 页面里"文字块上方"的空白点（向上拖选用） */
const pickBlankAbove = (cdp) =>
  cdp.eval(`
    (() => {
      const page = document.querySelector('.rd-pdf-page');
      if (!page) return null;
      const pr = page.getBoundingClientRect();
      const spans = [...page.querySelectorAll('.rd-pdf-text span')].map((s) => s.getBoundingClientRect());
      const firstTop = spans.length ? Math.min(...spans.map((r) => r.top)) : pr.top;
      const cands = [
        { x: Math.round(pr.left + pr.width / 2), y: Math.round(Math.max(pr.top + 12, firstTop - 44)) },
        { x: Math.round(pr.right - 18), y: Math.round(Math.max(pr.top + 12, firstTop - 44)) },
        { x: Math.round(pr.left + 18), y: Math.round(Math.max(pr.top + 12, firstTop - 26)) },
      ];
      for (const c of cands) {
        const el = document.elementFromPoint(c.x, c.y);
        const inPage = !!el?.closest?.('.rd-pdf-page');
        const onSpan = !!el?.closest?.('.rd-pdf-text span');
        if (inPage && !onSpan) return { ...c, cls: el?.className ?? null };
      }
      return null;
    })()
  `);

/** 原生选区信息：文本、长度、起止页（反选会表现为起点跑到锚点之前/跨页） */
const selInfo = (cdp) =>
  cdp.eval(`
    (() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      const asEl = (n) => (n && n.nodeType === 3 ? n.parentElement : n);
      const startEl = asEl(range.startContainer)?.closest?.('.rd-pdf-page');
      const endEl = asEl(range.endContainer)?.closest?.('.rd-pdf-page');
      const text = sel.toString();
      return {
        text,
        len: text.length,
        startPage: startEl ? Number(startEl.dataset.pageIndex) : null,
        endPage: endEl ? Number(endEl.dataset.pageIndex) : null,
      };
    })()
  `);

/** 选区信息：额外给出"命中了锚点页里的第几个 span"，用来判"有没有反选"（比文本前缀可靠） */
const selSpanInfo = (cdp) =>
  cdp.eval(`
    (() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      const anchorEl = document.querySelector('[data-ux-anchor="1"]');
      const page = anchorEl?.closest('.rd-pdf-page') ?? null;
      const spans = page ? [...page.querySelectorAll('.rd-pdf-text span')] : [];
      const hit = spans.map((s, i) => (range.intersectsNode(s) ? i : -1)).filter((i) => i >= 0);
      const asEl = (n) => (n && n.nodeType === 3 ? n.parentElement : n);
      const startEl = asEl(range.startContainer)?.closest?.('.rd-pdf-page');
      const endEl = asEl(range.endContainer)?.closest?.('.rd-pdf-page');
      return {
        len: sel.toString().length,
        text: sel.toString(),
        intersectsAnchor: anchorEl ? range.intersectsNode(anchorEl) : null,
        firstIdx: hit.length ? hit[0] : null,
        lastIdx: hit.length ? hit[hit.length - 1] : null,
        anchorIndex: anchorEl ? spans.indexOf(anchorEl) : null,
        spanCount: spans.length,
        startPage: startEl ? Number(startEl.dataset.pageIndex) : null,
        endPage: endEl ? Number(endEl.dataset.pageIndex) : null,
      };
    })()
  `);

/** 左栏筛选项名字列表（只取第一个 .sb-section：后面的文件夹/标签行也用 .sb-item，不能一起数） */
const navNames = (cdp) =>
  cdp.eval(`
    (() => {
      const sec = document.querySelector('.sb-scroll')?.children?.[0];
      return sec ? [...sec.querySelectorAll('.sb-item .sb-label')].map((e) => e.textContent.trim()) : [];
    })()
  `);

/** 当前激活的筛选项名字（同样限定在筛选项那一段） */
const activeNav = (cdp) =>
  cdp.eval(`
    (() => {
      const sec = document.querySelector('.sb-scroll')?.children?.[0];
      return (sec?.querySelector('.sb-item.active .sb-label')?.textContent || '').trim();
    })()
  `);

// ---------------------------------------------------------------- 启动

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
        await cdp.send('Log.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Page.bringToFront').catch(() => undefined);
        return { cdp, child, logs };
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('等不到 Electron 调试端口');
}

/** 打开阅读器并等文本层出现；允许重开一次（上一轮发现过文本层偶发不挂的问题） */
async function openReader(cdp) {
  const tried = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // 按名字开：夹具目录现在有两份 PDF，列表默认按"最近添加"排序，rows[0] 不保证是小夹具
    const hit = await openByName(cdp, LIB_NAME);
    if (hit?.ready) return { ok: true, attempt };
    tried.push(hit ? { attempt, rowText: hit.text, diag: hit.diag ?? null } : { attempt, diag: 'row not found' });
    await press(cdp, 'Escape', KEY.esc);
    await sleep(600);
  }
  console.log(`  诊断（两次尝试的现场）：${JSON.stringify(tried)}`);
  return { ok: false, attempt: 2, tried };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  await fs.rm(DATA, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(FIXTURE, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(FIXTURE, { recursive: true });
  await fs.writeFile(path.join(FIXTURE, LIB_NAME), buildPdf(3));
  // 第三轮：大文档夹具（24 页 + 真目录），用来验缩略图/布局/搜索/缩放
  await fs.writeFile(
    path.join(FIXTURE, BIG_NAME),
    buildPdf(BIG_PAGES, 'UX Thumbs Sample', {
      outline: [
        { title: 'Chapter 1', page: 1 },
        { title: 'Chapter 2', page: 7 },
        { title: 'Chapter 3', page: 15 },
      ],
    }),
  );

  console.log(`隔离数据目录：${DATA}`);
  console.log(`夹具目录：${FIXTURE}（自造 ${LIB_NAME} 3 页 + ${BIG_NAME} ${BIG_PAGES} 页含目录）`);

  // 只造夹具、不启动 Electron：用来离线校验手写 PDF（含 /Outlines）是否合法
  if (process.env.UX_FIXTURES_ONLY === '1') {
    console.log('UX_FIXTURES_ONLY=1 → 只生成夹具，不启动 Electron');
    return;
  }

  let { cdp, child, logs } = await launch();
  logs = logs.join('');

  /** 同一数据目录重启应用（验"重启仍生效"用）；返回后 cdp/child/logs 都指向新实例 */
  const relaunch = async () => {
    cdp?.close();
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await sleep(1500);
    const fresh = await launch();
    cdp = fresh.cdp;
    child = fresh.child;
    logs += fresh.logs.join('');
    await sleep(2500);
    await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('跳过')); b?.click(); return true; })()`);
    await sleep(600);
    return true;
  };

  try {
    await sleep(3000);
    await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('跳过')); b?.click(); return true; })()`);
    await sleep(800);
    await cdp.eval(`(async () => { await window.litshelf.invoke('addRoot', [${JSON.stringify(FIXTURE)}, { depth: 2 }]); return true; })()`);

    let item = null;
    for (let i = 0; i < 60; i += 1) {
      item = await cdp.eval(`
        (async () => {
          const s = await window.litshelf.invoke('getSnapshot', []);
          const it = s.items.find((x) => x.name.includes('ux-acceptance-sample'));
          return it ? { name: it.name, parseState: it.parseState, pageCount: it.pageCount, state: it.state } : null;
        })()
      `);
      if (item && item.parseState && item.parseState !== 'placeholder') break;
      await sleep(500);
    }

    console.log('\n[A] 夹具与入库');
    ok(!!item, `夹具已入库：${item?.name ?? '（没有）'}`);
    ok(!!item && (item.parseState === 'ready' || item.state === 'ready'), `解析完成（parseState=${item?.parseState ?? '?'}）`);
    ok(!!item && item.pageCount === 3, `夹具是 3 页 PDF（pageCount=${item?.pageCount ?? '?'}）`);

    // ===================== 专项压测：[C] 文本层就绪耗时（看门狗 6s 自愈）多轮
    if (C_ROUNDS > 0) {
      console.log(`\n[C-STRESS] 只压 [C]：文本层就绪耗时 × ${C_ROUNDS} 轮（看门狗预期 6s 内自愈）`);
      const cResults = [];
      for (let r = 1; r <= C_ROUNDS; r += 1) {
        await goLibrary(cdp);
        await searchLibrary(cdp, LIB_NAME);
        const m = await openMeasured(cdp, 'UX Acceptance Sample', 25000);
        cResults.push({ round: r, firstSpanMs: m?.firstSpanMs ?? null, spans: m?.spans ?? 0, marks: m?.marks ?? null });
        console.log(
          `  第 ${r} 轮：firstSpan=${m?.firstSpanMs ?? '超时(>25s)'}ms  spans=${m?.spans ?? 0}  里程碑=${JSON.stringify(m?.marks ?? null)}`,
        );
        await press(cdp, 'Escape', KEY.esc);
        await sleep(700);
      }
      const bad = cResults.filter((x) => !(x.firstSpanMs !== null && x.firstSpanMs < 10000));
      const dist = {
        fast: cResults.filter((x) => x.firstSpanMs !== null && x.firstSpanMs < 1000).length,
        mid: cResults.filter((x) => x.firstSpanMs !== null && x.firstSpanMs >= 1000 && x.firstSpanMs < 6000).length,
        watchdog: cResults.filter((x) => x.firstSpanMs !== null && x.firstSpanMs >= 6000).length,
        timeout: cResults.filter((x) => x.firstSpanMs === null).length,
      };
      console.log(`  分布：<1s ${dist.fast} 轮｜1–6s ${dist.mid} 轮｜≥6s（看门狗窗口）${dist.watchdog} 轮｜>25s 超时 ${dist.timeout} 轮`);
      const warns = cdp.consoleLogs.filter((t) => /reader|文本层|重试|retry|第 \d+ 页/i.test(t));
      console.log(`  console 警告/错误共 ${cdp.consoleLogs.length} 条，阅读器相关 ${warns.length} 条：${JSON.stringify(warns.slice(0, 8))}`);
      ok(bad.length === 0, `${C_ROUNDS} 轮每轮都在 10s 内出 span（异常轮次：${JSON.stringify(bad.map((x) => ({ r: x.round, ms: x.firstSpanMs })))}）`);
    }

    // ===================== 专项压测：[G2] 扫描进度弹框 Esc 层级 多轮
    if (G2_ROUNDS > 0) {
      console.log(`\n[G2-STRESS] 只压 [G2]：扫描进度弹框 Esc × ${G2_ROUNDS} 轮`);
      await goLibrary(cdp);
      await searchLibrary(cdp, LIB_NAME);
      await openMeasured(cdp, 'UX Acceptance Sample', 15000);
      const g2All = [];
      for (let r = 1; r <= G2_ROUNDS; r += 1) {
        // 关键：每一轮都必须在**阅读器打开**的状态下测（否则测不到 deferEscape 那条路径）
        if (!(await cdp.eval('!!document.querySelector(".rd-pdf-page")'))) {
          await goLibrary(cdp);
          await searchLibrary(cdp, LIB_NAME);
          await openMeasured(cdp, 'UX Acceptance Sample', 15000);
          await sleep(500);
        }
        const bulkDir = await makeBulk(20 + r, 300);
        const res = await tryRealDialogEsc(cdp, bulkDir);
        let diag = null;
        if (res.post?.modal === true) {
          // 失败时补诊断：焦点/弹框原文，并试一次"JS 合成 Escape"以区分"没送到"与"监听器链断了"
          diag = await cdp.eval(`
            (() => {
              const ae = document.activeElement;
              const before = !!document.querySelector('.modal-backdrop');
              window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              return {
                activeElement: ae ? ae.tagName + '.' + String(ae.className || '') : null,
                modalOuter: (document.querySelector('.modal-backdrop')?.outerHTML || '').slice(0, 120),
                reader: !!document.querySelector('.rd-pdf-page'),
                syntheticEsc: { before, after: !!document.querySelector('.modal-backdrop') },
              };
            })()
          `);
        }
        console.log(`  第 ${r} 轮：pre=${JSON.stringify(res.pre)} post=${JSON.stringify(res.post)}`);
        if (diag) console.log(`          诊断=${JSON.stringify(diag)}`);
        g2All.push({ round: r, pre: res.pre, post: res.post, diag });
        // 收尾：等扫描结束让弹框自动关；仍开着就点背景强关，别污染下一轮
        for (let w = 0; w < 30; w += 1) {
          if (!(await cdp.eval('!!document.querySelector(".modal-backdrop")'))) break;
          await sleep(500);
        }
        if (await cdp.eval('!!document.querySelector(".modal-backdrop")')) {
          await cdp.eval(`(() => { const b=document.querySelector('.modal-backdrop'); b?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return true; })()`);
          await sleep(500);
        }
        await press(cdp, 'Escape', KEY.esc);
        await sleep(700);
      }
      const valid = g2All.filter((x) => x.pre?.modal === true && x.pre?.active === true);
      const closed = valid.filter((x) => x.post?.modal === false);
      console.log(
        `  明细：${JSON.stringify(g2All.map((x) => ({ r: x.round, pre: x.pre && { m: x.pre.modal, a: x.pre.active }, post: x.post && { m: x.post.modal, a: x.post.active }, syn: x.diag?.syntheticEsc ?? null, ae: x.diag?.activeElement ?? null })))}`,
      );
      ok(valid.length > 0, `有效采样 ${valid.length}/${G2_ROUNDS} 轮（对话框真开过 + Esc 前扫描仍在跑）`);
      ok(valid.length > 0 && closed.length === valid.length, `Esc 关掉对话框：${closed.length}/${valid.length} 轮`);
    }

    if (runLegacy) {
    console.log('\n[B] 文献库里的 ? 快捷键面板');
    await press(cdp, '?', KEY.question);
    let panel = await panelInfo(cdp);
    ok(!!panel && panel.title.includes('快捷键'), `按 ? 打开面板（标题：${panel?.title ?? '（没有）'}）`);
    const rowKeys = panel ? panel.rows.map((r) => r[1]) : [];
    const quickHit = panel
      ? ['1 / 2 / 3 / 4', '右键'].every((k) => panel.rows.some(([label, key]) => key === k || label.includes(k)))
      : false;
    ok(quickHit, '面板含本轮新增的快速标注 / 右键条目', panel ? panel.rows.map(([l, k]) => `${l}=${k}`).slice(-4).join(' | ') : '');
    const keyHit = ['b', 't', 'f'].every((k) => rowKeys.includes(k)) && rowKeys.some((k) => k.includes('[')) && rowKeys.some((k) => k.includes(']'));
    ok(keyHit, '面板含 [ ] / b / t / f 键位', rowKeys.join(' · '));
    if (panel) await cdp.shot('ux-01-shortcuts-library.png');
    await press(cdp, 'Escape', KEY.esc);
    ok((await panelInfo(cdp)) === null, 'Esc 关闭面板（文献库）');

    console.log('\n[C] 双击进阅读器');
    const opened = await openReader(cdp);
    ok(opened.ok, `阅读器打开且文本层就绪（第 ${opened.attempt} 次尝试）`);
    if (!opened.ok) throw new Error('文本层 30s×2 都没就绪，后续断言无法进行');
    await sleep(800);
    let st = await state(cdp);
    ok(st.reader && st.pages > 0, `阅读器已挂载（.rd-pdf-page=${st.pages}，文本 span=${st.spans}）`);
    const p0 = await pageOf(cdp);
    ok(!!p0 && p0.total === 3, `页码读数：${p0 ? `${p0.cur} / ${p0.total} 页` : '（没有）'}`);

    console.log('\n[D] 快速标注：按 1/2/3/4 分别落 highlight / underline / squiggly / strikeout');
    const lines = await pickLines(cdp);
    ok(lines.length > 0, `取到 ${lines.length} 行可拖选正文（首行「${lines[0]?.text ?? '（没有）'}」宽 ${lines[0]?.width ?? '?'}px）`);
    if (!lines.length) throw new Error('没有可拖选的正文行');
    const QUICK = [
      ['1', KEY.one, 'highlight', '高亮'],
      ['2', { code: 'Digit2', vk: 50 }, 'underline', '下划线'],
      ['3', { code: 'Digit3', vk: 51 }, 'squiggly', '波浪线'],
      ['4', KEY.four, 'strikeout', '删除线'],
    ];
    for (let i = 0; i < QUICK.length; i += 1) {
      const [k, opts, type, cn] = QUICK[i];
      const ln = lines[i % lines.length];
      await leftDrag(cdp, ln.x, ln.y, ln.x2, ln.y);
      const tb = await toolbarCount(cdp);
      ok(tb >= 3, `第 ${i + 1} 轮拖选后工具条出现（${tb} 个动作，y=${ln.y}）`);
      const before = (await anns(cdp)).length;
      await press(cdp, k, opts);
      await sleep(900);
      const listNow = await anns(cdp);
      const newest = listNow[listNow.length - 1];
      ok(listNow.length === before + 1, `按 ${k}（${cn}）后批注数 ${before} → ${listNow.length}`);
      ok(newest?.type === type, `按 ${k} 落库类型 = ${newest?.type ?? '（无）'}（期望 ${type}）`);
      ok(
        (newest?.text ?? '').length > 0,
        `按 ${k} 的批注文字非空（${newest?.text?.length ?? 0} 字：「${(newest?.text ?? '').slice(0, 16)}」）`,
      );
      ok((await toolbarCount(cdp)) === 0, `按 ${k} 之后划词工具条已自动收起`);
      if (i === 0) await cdp.shot('ux-02-quick-annotate.png');
    }

    // 负向对照：没有选区时按 1 不应该凭空建批注（否则上面的 "计数 +1" 不能证明是按键起的作用）
    const blankEarly = await pickBlank(cdp);
    if (blankEarly) {
      await leftClick(cdp, blankEarly.x, blankEarly.y);
      ok((await state(cdp)).sel.trim().length === 0, '无选区按 1 的前置条件：左键点空白已清掉选区');
      const countBefore = (await anns(cdp)).length;
      await press(cdp, '1', KEY.one);
      await sleep(900);
      ok((await anns(cdp)).length === countBefore, `无选区时按 1 不落库（批注数保持 ${countBefore}）`);
    }

    console.log('\n[E] b 书签 / t 主题 / [ ] 翻页 / f 全屏');
    const beforeB = (await anns(cdp)).length;
    await press(cdp, 'b', KEY.b);
    await sleep(900);
    const listB = await anns(cdp);
    const bm = listB[listB.length - 1];
    ok(listB.length === beforeB + 1 && bm?.type === 'bookmark', `按 b 落库书签（类型 ${bm?.type ?? '（无）'}）`);
    ok((bm?.text ?? '').length > 0, `书签带页位文字（「${bm?.text ?? ''}」page=${bm?.page ?? '?'}）`);

    console.log('\n[E2] 键重复护栏：autoRepeat 的 b 不能连落多条书签');
    await cdp.eval(`(() => {
      window.__uxKeyLog = [];
      window.addEventListener('keydown', (e) => { if (e.key === 'b') window.__uxKeyLog.push(e.repeat === true); }, true);
      return true;
    })()`);
    await blur(cdp);
    const beforeRepeat = (await anns(cdp)).length;
    cdp.fire('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 });
    await sleep(150);
    cdp.fire('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, autoRepeat: true });
    cdp.fire('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, autoRepeat: true });
    cdp.fire('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 });
    await sleep(1300);
    const afterRepeat = (await anns(cdp)).length;
    const keyLog = await cdp.eval('window.__uxKeyLog');
    ok(
      Array.isArray(keyLog) && keyLog.filter((r) => r === true).length >= 2,
      `页面确实收到 repeat=true 的重复按键（收到 ${JSON.stringify(keyLog)}）`,
    );
    ok(afterRepeat === beforeRepeat + 1, `首次按下落 1 条、重复键不再落库（${beforeRepeat} → ${afterRepeat}）`);

    const t0 = await themeOf(cdp);
    await press(cdp, 't', KEY.t);
    const t1 = await themeOf(cdp);
    await press(cdp, 't', KEY.t);
    const t2 = await themeOf(cdp);
    await press(cdp, 't', KEY.t);
    const t3 = await themeOf(cdp);
    ok(t0 !== t1 && t1 !== t2 && t2 !== t3, `t 循环阅读主题：${t0} → ${t1} → ${t2} → ${t3}`);
    ok(t3 === t0, `连按 3 次 t 回到起始主题（${t3} = ${t0}）`);

    const pA = await pageOf(cdp);
    await press(cdp, ']', KEY.bracketR);
    const pB = await pageOf(cdp);
    await press(cdp, '[', KEY.bracketL);
    const pC = await pageOf(cdp);
    ok(!!pA && !!pB && pB.cur === pA.cur + 1, `] 翻到下一页：${pA?.cur} → ${pB?.cur}（共 ${pA?.total} 页）`);
    ok(!!pC && pC.cur === pA.cur, `[ 翻回上一页：${pB?.cur} → ${pC?.cur}（期望回到 ${pA?.cur}）`);

    await press(cdp, 'f', KEY.f);
    const fs1 = (await state(cdp)).fullscreen;
    await press(cdp, 'f', KEY.f);
    const fs2 = (await state(cdp)).fullscreen;
    ok(fs1 === true, `f 进入全屏（document.fullscreenElement=${fs1}）`);
    ok(fs2 === false, `f 退出全屏（document.fullscreenElement=${fs2}）`);

    console.log('\n[F] 右键菜单');
    const fLine = lines[0];
    await leftDrag(cdp, fLine.x, fLine.y, fLine.x2, fLine.y);
    const s1 = await state(cdp);
    ok(s1.sel.trim().length > 0, `拖选出 ${s1.sel.trim().length} 个字符：「${s1.sel.trim().slice(0, 20)}」`);
    const anchor = await cdp.eval(`
      (() => {
        const r = window.getSelection()?.getRangeAt?.(0)?.getBoundingClientRect?.();
        const rect = r && r.width > 0 ? r : { left: ${fLine.x}, top: ${fLine.y} - 8, right: ${fLine.right}, bottom: ${fLine.y} + 8 };
        const x = Math.round(Math.min(window.innerWidth - 12, Math.max(12, rect.left + Math.min(60, rect.width / 2))));
        const y = Math.round(Math.min(window.innerHeight - 12, Math.max(12, rect.bottom + 10)));
        const el = document.elementFromPoint(x, y);
        return { x, y, cls: el?.className ?? null, inPage: !!el?.closest?.('.rd-pdf-page') };
      })()
    `);
    await rightClick(cdp, anchor.x, anchor.y);
    let menu = await menuInfo(cdp);
    ok(!!menu, `有选区右键弹出菜单（点 (${anchor.x}, ${anchor.y}) → ${anchor.cls}）`);
    ok(!!menu && menu.role === 'menu', `菜单容器 role=${menu?.role ?? '（没有）'}`);
    const need7 = ['高亮', '下划线', '波浪线', '删除线', '复制', '复制引用（选区 + 题录）', '在文内搜索'];
    ok(!!menu && need7.every((l) => menu.labels.includes(l)), `有选区时 7 项齐全（${menu?.labels.length ?? 0} 项）`, menu?.labels.join(' | ') ?? '');
    ok(!!menu && menu.roles.every((r) => r === 'menuitem'), '每个菜单项 role=menuitem');
    ok(!!menu && menu.titles.some((t) => (t || '').includes('选中后按 1')), `菜单项 title 带快捷键说明（${menu?.titles[0] ?? '（没有）'}）`);
    const s2 = await state(cdp);
    ok(s2.sel.trim() === s1.sel.trim(), `右键没有破坏选区（${s1.sel.trim().length} → ${s2.sel.trim().length} 字）`);
    ok(s2.toolbar, '右键没有收掉划词工具条');
    if (menu) await cdp.shot('ux-03-ctx-selection.png');

    const annBefore = (await anns(cdp)).length;
    const hit = await cdp.eval(`
      (() => {
        const b = [...document.querySelectorAll('.rd-ctx-item')].find((x) => x.textContent.trim() === '高亮');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `);
    if (hit) await leftClick(cdp, hit.x, hit.y);
    await sleep(900);
    ok((await menuInfo(cdp)) === null, '点菜单项后菜单关闭');
    const listC = await anns(cdp);
    ok(
      listC.length === annBefore + 1 && listC[listC.length - 1]?.type === 'highlight',
      `点「高亮」落库一条 highlight（${annBefore} → ${listC.length}）`,
    );

    console.log('\n[F2] 选区与 pending 不同步的兜底（不点页面直接右键）');
    const blankNoClick = await pickBlank(cdp);
    ok(!!blankNoClick, `取到用于右键的空白点：${blankNoClick ? `(${blankNoClick.x}, ${blankNoClick.y})` : '（没有）'}`);
    if (blankNoClick) {
      // 先按 1 落一条高亮：annotateSelection 会清掉 pending，但不动原生选区 → 菜单与执行依据不同步
      await leftDrag(cdp, fLine.x, fLine.y, fLine.x2, fLine.y);
      const beforeSync = (await anns(cdp)).length;
      await press(cdp, '1', KEY.one);
      await sleep(900);
      const afterSync = (await anns(cdp)).length;
      ok(afterSync === beforeSync + 1, `前置：拖选后按 1 已落库（${beforeSync} → ${afterSync}）`);
      const domSel = (await state(cdp)).sel.trim();
      await rightClick(cdp, blankNoClick.x, blankNoClick.y);
      const menuSync = await menuInfo(cdp);
      ok(
        !!menuSync,
        `不点页面直接右键：菜单弹出（${menuSync?.labels.length ?? 0} 项；DOM 选区仍有 ${domSel.length} 字）`,
      );
      const hitSyncMenu = !!menuSync && menuSync.labels.includes('高亮');
      if (hitSyncMenu) {
        const countBefore3 = (await anns(cdp)).length;
        const hitSync = await cdp.eval(`
          (() => {
            const b = [...document.querySelectorAll('.rd-ctx-item')].find((x) => x.textContent.trim() === '高亮');
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })()
        `);
        if (hitSync) await leftClick(cdp, hitSync.x, hitSync.y);
        await sleep(1100);
        const landedSync = (await anns(cdp)).length === countBefore3 + 1;
        const toastSync = await toastText(cdp);
        const warnedSync = /请重新选中文字再标注|选区已经失效/.test(toastSync);
        ok(
          landedSync || warnedSync,
          `点「高亮」不是静默无反应（落库=${landedSync}，提示=${warnedSync}）`,
          `屏幕提示：${toastSync || '（无）'}`,
        );
      } else {
        ok(false, '该场景菜单没给「高亮」项，无法验证兜底（不同步未复现，需 reviewer 复核）', menuSync?.labels.join(' | ') ?? '');
      }
      if (await menuInfo(cdp)) await press(cdp, 'Escape', KEY.esc);
    }

    const blank = await pickBlank(cdp);
    ok(
      !!blank,
      `取到页面空白点：${blank ? `(${blank.x}, ${blank.y}) → ${blank.cls}（在文字层内=${blank.inTextLayer}）` : '（没有）'}`,
    );
    if (blank) {
      await leftClick(cdp, blank.x, blank.y);
      const s3 = await state(cdp);
      ok(s3.sel.trim().length === 0, '左键点空白清掉原生选区');
      ok(!s3.toolbar, '左键点空白也收掉划词工具条');

      await rightClick(cdp, blank.x, blank.y);
      const menu2 = await menuInfo(cdp);
      ok(!!menu2, '空白处右键弹出菜单');
      const need4 = ['适应宽度', '适应页面', '加书签', '复制引用（整篇文献）'];
      ok(
        !!menu2 && need4.every((l) => menu2.labels.includes(l)) && !menu2.labels.includes('高亮'),
        `无选区时 4 项齐全且没有标注项（${menu2?.labels.length ?? 0} 项）`,
        menu2?.labels.join(' | ') ?? '',
      );
      if (menu2) await cdp.shot('ux-04-ctx-blank.png');
    }

    const corner = await pickCorner(cdp);
    ok(!!corner, `取到页面右下角贴边点：${corner ? `(${corner.x}, ${corner.y})` : '（没有）'}`);
    if (corner) {
      if (await menuInfo(cdp)) await press(cdp, 'Escape', KEY.esc);
      await rightClick(cdp, corner.x, corner.y);
      const menu3 = await menuInfo(cdp);
      ok(!!menu3, '贴边右键弹出菜单');
      if (menu3) {
        console.log(`  菜单 rect=${JSON.stringify(menu3.rect)} 视口=${JSON.stringify(menu3.viewport)}`);
        ok(menu3.inViewport, '菜单完全落在窗口内（不越界）');
        if (await menuInfo(cdp)) await press(cdp, 'Escape', KEY.esc);
      }
    }

    const anchor2 = blank ?? corner ?? fLine;
    await rightClick(cdp, anchor2.x, anchor2.y);
    ok((await menuInfo(cdp)) !== null, '菜单再次打开（准备测关闭）');
    await press(cdp, 'Escape', KEY.esc);
    const s4 = await state(cdp);
    ok((await menuInfo(cdp)) === null, 'Esc 关闭右键菜单');
    ok(s4.reader && s4.pages > 0, `Esc 关菜单没有把阅读器一起关掉（reader=${s4.reader}, pages=${s4.pages}）`);

    await rightClick(cdp, anchor2.x, anchor2.y);
    ok((await menuInfo(cdp)) !== null, '菜单再次打开（准备测点别处）');
    await leftClick(cdp, fLine.x, fLine.y);
    ok((await menuInfo(cdp)) === null, '点击菜单外关闭');

    await rightClick(cdp, anchor2.x, anchor2.y);
    ok((await menuInfo(cdp)) !== null, '菜单再次打开（准备测滚动）');
    await wheel(cdp, 700, 450, 120);
    ok((await menuInfo(cdp)) === null, '滚动后菜单关闭');

    console.log('\n[G] 快捷键面板（?）的 Esc 层级');
    await press(cdp, '?', KEY.question);
    const panel2 = await panelInfo(cdp);
    ok(!!panel2, `阅读器里按 ? 打开快捷键面板（.modal-backdrop，标题「${panel2?.title ?? ''}」）`);
    await press(cdp, 'Escape', KEY.esc);
    ok((await panelInfo(cdp)) === null, 'Esc 关闭面板');
    const s5 = await state(cdp);
    ok(s5.reader && s5.pages > 0, `Esc 关面板后阅读器仍在（reader=${s5.reader}, pages=${s5.pages}）`);

    // 观察项（不计入断言，仅供报告）：阅读器里 `?` 的开关语义。
    // 源码上这里有个"谁先注册谁生效"的隐患：ReaderView 的 `?` 是幂等打开 + stopImmediatePropagation，
    // App 的 `?` 是 toggle，而 ReaderView 的键盘 effect 依赖里含 showShortcuts（会让监听器重排）。
    // 连按两轮采样 3 次，用来判断行为是否稳定。
    const toggleObs = [];
    for (let i = 0; i < 3; i += 1) {
      await press(cdp, '?', KEY.question);
      const openedOnce = !!(await panelInfo(cdp));
      await press(cdp, '?', KEY.question);
      const stillOpen = !!(await panelInfo(cdp));
      toggleObs.push(`第${i + 1}轮 按1次=${openedOnce ? '开' : '没开'}→按2次=${stillOpen ? '仍开' : '已关'}`);
      if (stillOpen) await press(cdp, 'Escape', KEY.esc);
    }
    console.log(`  [观察] 阅读器里连按两次 ? → ${toggleObs.join('；')}`);

    console.log('\n[G2] 真对话框 Esc 层级（顶栏「扫描中」→ 扫描进度弹框 → Esc）');
    let real = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const bulkDir = await makeBulk(attempt, attempt === 1 ? 300 : 400);
      const r = await tryRealDialogEsc(cdp, bulkDir);
      console.log(`  第 ${attempt} 次：clicked=${r.clicked} modal=${r.modal} pre=${JSON.stringify(r.pre)} post=${JSON.stringify(r.post)}`);
      if (r.modal && r.pre?.active) {
        // 只要"对话框真开过、且按 Esc 前扫描仍在进行"，这一次就是**有效判据**——不论 Esc 有没有关掉它都按它判。
        // （原先"没关掉就重试"会把"Esc 关不掉"这个真失败掩盖成"弹框没打开"，属于自欺。）
        real = r;
        break;
      }
      real = real ?? r; // 连对话框都没打开的那种尝试，只当兜底结果
    }
    ok(real?.modal === true, `打开真对话框 .modal-backdrop（标题「${real?.pre?.title ?? '（没有）'}」）`);
    ok(real?.pre?.active === true, '按 Esc 之前扫描仍在进行（排除弹框已经自己关闭）');
    ok(real?.post?.modal === false, 'Esc 关闭了对话框（Modal 自己的监听器生效）');
    ok(real?.post?.active === true, '按 Esc 之后扫描仍在进行 → 排除"扫描结束导致弹框自动消失"的假绿');
    ok(real?.post?.reader === true, 'Esc 关对话框后阅读器仍在');

    console.log('\n[G3] 阅读器「更多」菜单的 Esc');
    // 注意：这个按钮在源码里**只绑了 onPointerDown**（ReaderView.tsx），
    // 用 element.click() 只会发 click 事件、开不了菜单，必须走真实指针按下。
    const moreBtn = await cdp.eval(`
      (() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.title || '') === '更多');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
      })()
    `);
    ok(!!moreBtn, `找到「更多」按钮${moreBtn ? `（(${moreBtn.x}, ${moreBtn.y}) ${moreBtn.w}px）` : '（没有）'}`);
    if (moreBtn) await leftClick(cdp, moreBtn.x, moreBtn.y);
    await sleep(400);
    ok(await moreMenuOpen(cdp), '阅读器「更多」菜单已打开（.rd-menu）');
    await press(cdp, 'Escape', KEY.esc);
    const afterMoreEsc = await cdp.eval('({ menu: !!document.querySelector(".rd-menu"), reader: !!document.querySelector(".rd-pdf-page") })');
    ok(!afterMoreEsc.menu, 'Esc 关闭「更多」菜单');
    ok(afterMoreEsc.reader, 'Esc 关「更多」菜单没有把阅读器一起关掉');

    // P3 回归（本轮修的键盘可达性）：聚焦「更多」后 Enter/Space 必须能开菜单，
    // 且 Space 不能被阅读器当成"下一页"顺带翻页（所以这里用不 blur 的 pressFocused）。
    const moreFocus = await cdp.eval(`
      (() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.title || '') === '更多');
        if (!b) return null;
        b.focus();
        return { focused: document.activeElement === b, tag: document.activeElement?.tagName ?? null };
      })()
    `);
    ok(!!moreFocus?.focused, `「更多」按钮可获得焦点（Tab 可达，activeElement=${moreFocus?.tag ?? '?'}）`);
    if (moreFocus?.focused) {
      await pressFocused(cdp, 'Enter', { code: 'Enter', vk: 13 });
      ok(await moreMenuOpen(cdp), '聚焦后按 Enter 打开「更多」菜单');
      await press(cdp, 'Escape', KEY.esc);
      ok(!(await moreMenuOpen(cdp)), 'Esc 关闭「更多」菜单（键盘路径）');

      const pageBeforeSpace = await pageOf(cdp);
      await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.title || '') === '更多'); b?.focus(); return true; })()`);
      await pressFocused(cdp, ' ', { code: 'Space', vk: 32, text: ' ' });
      const spaceOpened = await moreMenuOpen(cdp);
      const pageAfterSpace = await pageOf(cdp);
      ok(spaceOpened, '聚焦后按 Space 打开「更多」菜单');
      ok(
        !!pageBeforeSpace && !!pageAfterSpace && pageBeforeSpace.cur === pageAfterSpace.cur,
        `Space 没有顺带翻页（${pageBeforeSpace?.cur ?? '?'} → ${pageAfterSpace?.cur ?? '?'}）`,
      );
      if (spaceOpened) await press(cdp, 'Escape', KEY.esc);
    }

    console.log('\n[H] 渲染层健康检查');
    const errs = cdp.errors.filter((e) => !/DevTools|Autofill|Electron Security/i.test(e));
    ok(errs.length === 0, `渲染层零错误（${errs.length}）`, errs.slice(0, 3).join(' | '));
    } else {
      console.log('\n（UX_SECTIONS 过滤：跳过 [B]–[H]）');
    }

    if (runNew) {
    // ============================ 第三轮（task-9）新增：缩略图 / 跳页 / 布局 / 缩放 / 反选 / 侧栏

    console.log('\n[I] 换到多页大文档（24 页 + 真目录）');
    await goLibrary(cdp);
    await searchLibrary(cdp, BIG_NAME);
    let lat = await openMeasured(cdp, 'UX Thumbs Sample');
    if (!lat?.ok) {
      console.log(`  第 1 次打开大文档没出 span，现场：${JSON.stringify(lat)}`);
      await goLibrary(cdp);
      await searchLibrary(cdp, BIG_NAME);
      lat = await openMeasured(cdp, 'UX Thumbs Sample');
    }
    // 硬指标：从双击到文本层出 span 必须 < 5000ms（修复前主进程抽取饿死 I/O 时会 15–25s）
    ok(
      lat?.ok === true && lat.firstSpanMs < 5000,
      `[硬指标] 双击 → 文本层出 span：${lat?.firstSpanMs ?? '（超时）'}ms（要求 < 5000ms）`,
      `里程碑 ${JSON.stringify(lat?.marks ?? null)}`,
    );
    const bigPage = await pageOf(cdp);
    ok(bigPage?.total === BIG_PAGES, `大文档页数读数 ${bigPage?.cur} / ${bigPage?.total}（期望共 ${BIG_PAGES} 页）`);

    console.log('\n[J] 缩略图：真预览 + 快刷后自愈');
    ok(await openTab(cdp, '缩略图'), '已切到「缩略图」面板');
    const thumbTotal = await cdp.eval('document.querySelectorAll("[data-thumb-page]").length');
    ok(thumbTotal === BIG_PAGES, `缩略图面板有 ${thumbTotal} 个页位（期望 ${BIG_PAGES}）`);
    // 快速来回刷 3 趟（比人手快：每步 ~2 个缩略图、步间 60ms），制造大量"任务作废"。
    // 每一趟单独一次 evaluate（超时放宽到 60s）：既给渲染层喘息，也能定位"哪一趟把渲染层卡住"。
    for (let pass = 0; pass < 3; pass += 1) {
      const tPass = Date.now();
      try {
        const maxScroll = await cdp.eval(
          `
          (async () => {
            const root = document.querySelector('.rd-thumbs');
            if (!root) return 0;
            const max = root.scrollHeight - root.clientHeight;
            for (let i = 1; i <= 14; i += 1) { root.scrollTop = (max * i) / 14; await new Promise((r) => setTimeout(r, 60)); }
            for (let i = 13; i >= 0; i -= 1) { root.scrollTop = (max * i) / 14; await new Promise((r) => setTimeout(r, 60)); }
            return max;
          })()
        `,
          60000,
        );
        console.log(`  第 ${pass + 1} 趟刷完：${Date.now() - tPass}ms，可滚动高度 ${maxScroll}px`);
      } catch (err) {
        ok(false, `缩略图第 ${pass + 1} 趟快刷时渲染层无响应（${err.message}）`);
        break;
      }
    }
    await sleep(5000);
    const thumbStat = await cdp.eval(`
      (() => {
        const nodes = [...document.querySelectorAll('[data-thumb-page]')];
        const imgs = nodes.map((n) => n.querySelector('img')).filter(Boolean);
        const badImgs = imgs.filter((i) => !(i.naturalWidth > 20)).length;
        const ghosts = [...document.querySelectorAll('.rd-thumb-ghost:not(.is-empty)')];
        const rootRect = document.querySelector('.rd-thumbs')?.getBoundingClientRect();
        const pendingPages = ghosts.map((g) => {
          const node = g.closest('[data-thumb-page]');
          const r = node?.getBoundingClientRect();
          return { page: Number(node?.dataset.thumbPage ?? 0), inView: !!(r && rootRect && r.bottom > rootRect.top && r.top < rootRect.bottom) };
        });
        return { total: nodes.length, imgs: imgs.length, badImgs, ghosts: ghosts.length, ready: imgs.length - badImgs, pendingPages };
      })()
    `);
    console.log(`  缩略图统计：${JSON.stringify(thumbStat)}`);
    ok(thumbStat.ghosts === 0, `快刷并静置 5s 后剩余数字占位 = 0（实际 ${thumbStat.ghosts}）`, thumbStat.ghosts ? `残留 ${JSON.stringify(thumbStat.pendingPages)}` : '');
    ok(thumbStat.ready === thumbStat.total, `每页都有真预览且 naturalWidth>20（${thumbStat.ready}/${thumbStat.total}）`);
    await cdp.shot('ux-05-thumbs.png');

    console.log('\n[K] 连续跳页：不被旧链拉回');
    const kStart = await pageOf(cdp);
    key(cdp, ']', KEY.bracketR);
    await sleep(120);
    key(cdp, ']', KEY.bracketR);
    await sleep(1300);
    const kEnd = await pageOf(cdp);
    const kOffset = kEnd ? await pageOffsetTop(cdp, kEnd.cur) : null;
    ok(kEnd?.cur === (kStart?.cur ?? 0) + 2, `连按两次 ] → 最终第 ${kEnd?.cur} 页（期望 ${(kStart?.cur ?? 0) + 2}）`);
    ok(kOffset !== null && Math.abs(kOffset) < 120, `落点贴近容器顶部：offset=${kOffset}px（|offset|<120）`);

    const [tA, tB] = [10, 12];
    await clickThumb(cdp, tA - 1);
    await sleep(300);
    const thumbCenters = await cdp.eval(`
      (() => {
        const c = (n) => { const e = document.querySelector('[data-thumb-page="' + n + '"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), inView: r.top > 0 && r.bottom < window.innerHeight }; };
        return { a: c(${tA}), b: c(${tB}) };
      })()
    `);
    if (thumbCenters?.a && thumbCenters?.b) {
      for (const c of [thumbCenters.a, thumbCenters.b]) {
        cdp.fire('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y, buttons: 0 });
        cdp.fire('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 });
        cdp.fire('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', buttons: 0, clickCount: 1 });
        await sleep(120);
      }
      await sleep(1500);
      const kThumbPage = await pageOf(cdp);
      const kThumbOffset = kThumbPage ? await pageOffsetTop(cdp, kThumbPage.cur) : null;
      ok(kThumbPage?.cur === tB, `120ms 内连点第 ${tA}、${tB} 页缩略图 → 最终第 ${kThumbPage?.cur} 页（期望 ${tB}）`);
      ok(kThumbOffset !== null && Math.abs(kThumbOffset) < 120, `缩略图落点贴近容器顶部：offset=${kThumbOffset}px`);
    } else {
      ok(false, '取不到第 10/12 页缩略图的坐标（面板未就绪）');
    }

    console.log('\n[L] 三种布局下的落点一致性（缩略图 / 目录 / 文内搜索）');
    for (const layout of ['continuous', 'single', 'double']) {
      await setLayout(cdp, layout);
      // 1) 缩略图 → 第 5 页
      await openTab(cdp, '缩略图');
      await clickThumb(cdp, 5);
      await sleep(700);
      const lp1 = await pageOf(cdp);
      ok(lp1?.cur === 5, `[${layout}] 点缩略图第 5 页 → 当前页 ${lp1?.cur}`);

      // 2) 目录 → Chapter 2（第 7 页）
      await openTab(cdp, '目录');
      const outlineItems = await cdp.eval(
        `[...document.querySelectorAll('.rd-outline-title')].map((b) => ({ title: b.textContent.trim(), page: Number(b.parentElement?.querySelector('.rd-outline-page')?.textContent || 0) }))`,
      );
      const ch2 = outlineItems.find((o) => o.title.includes('Chapter 2')) ?? outlineItems.find((o) => o.page === 7);
      ok(!!ch2, `[${layout}] 目录面板有 Chapter 2（共 ${outlineItems.length} 条：${outlineItems.map((o) => `${o.title}=P${o.page}`).join(', ')}）`);
      if (ch2) {
        await cdp.eval(
          `(() => { const list=[...document.querySelectorAll('.rd-outline-title')]; const b = list.find((x) => x.textContent.trim().includes('Chapter 2')) ?? list[1]; b?.click(); return !!b; })()`,
        );
        await sleep(800);
        const lp2 = await pageOf(cdp);
        ok(lp2?.cur === 7, `[${layout}] 点目录 Chapter 2 → 当前页 ${lp2?.cur}（期望 7）`);
      }

      // 3) 文内搜索 → uniquepage9
      // 注意：全文索引设置是 "opened-only"，第 9 页没打开过就搜不到它的 token。
      // 所以先点第 9 页缩略图把它"打开"（建索引），再跳回第 5 页，最后靠搜索跳回第 9 页。
      await openTab(cdp, '缩略图');
      await clickThumb(cdp, 9);
      await sleep(700);
      await clickThumb(cdp, 5);
      await sleep(700);
      await blur(cdp);
      key(cdp, 'f', { code: 'KeyF', vk: 70, mods: 2 });
      await sleep(800);
      const hasSearch = await cdp.eval('!!document.querySelector(".rd-search-panel")');
      ok(hasSearch, `[${layout}] Ctrl+F 打开文内搜索面板`);
      await cdp.eval(`(() => { const i = document.querySelector('.rd-search-panel input'); if (i) { i.focus(); i.select(); } return !!i; })()`);
      await cdp.send('Input.insertText', { text: 'uniquepage9' });
      // 文内搜索要先建全文索引（异步），所以轮询等命中，别只等一次
      let hits = [];
      for (let w = 0; w < 16; w += 1) {
        await sleep(500);
        hits = await cdp.eval(
          `[...document.querySelectorAll('.rd-search-hitrow')].map((r) => ({ page: Number((r.querySelector('.rd-search-page')?.textContent || '').replace('P','')), text: r.textContent.trim().slice(0, 40) }))`,
        );
        if (hits.length) break;
      }
      if (!hits.length) {
        const dbg = await cdp.eval(
          `({ inputValue: document.querySelector('.rd-search-panel input')?.value ?? null, count: (document.querySelector('.rd-search-count')?.textContent || '').trim() })`,
        );
        console.log(`  搜索诊断：${JSON.stringify(dbg)}`);
      }
      ok(hits.length >= 1, `[${layout}] 文内搜索命中 ${hits.length} 条（${hits.map((h) => `P${h.page}`).join(',')}）`);
      if (hits.length) {
        const hitPos = await cdp.eval(`
          (() => {
            const rows = [...document.querySelectorAll('.rd-search-hitrow')];
            const r = rows.find((x) => Number((x.querySelector('.rd-search-page')?.textContent || '').replace('P','')) === 9) ?? rows[0];
            if (!r) return null;
            const b = r.getBoundingClientRect();
            return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), page: Number((r.querySelector('.rd-search-page')?.textContent || '').replace('P','')) };
          })()
        `);
        if (hitPos) await leftClick(cdp, hitPos.x, hitPos.y);
        await sleep(900);
        const lp3 = await pageOf(cdp);
        ok(lp3?.cur === 9, `[${layout}] 点文内搜索命中 → 当前页 ${lp3?.cur}（期望 9）`);
      }
      await press(cdp, 'Escape', KEY.esc); // 关搜索面板
      await sleep(500);
    }
    await setLayout(cdp, 'continuous');

    console.log('\n[M] 缩放档位与细步进');
    await blur(cdp);
    await cdp.eval(`(() => { document.querySelector('.rd-zoom-value')?.click(); return true; })()`); // 重置到 100%
    await sleep(500);
    const z0 = await zoomLabel(cdp);
    ok(z0 === '100%', `重置缩放后标签 = ${z0}`);
    const zseq = [z0];
    const zT0 = Date.now();
    let firstChangeMs = null;
    for (let i = 0; i < 5; i += 1) {
      const before = zseq[zseq.length - 1];
      key(cdp, '=', { code: 'Equal', vk: 187, mods: 2 });
      let changed = null;
      for (let j = 0; j < 30; j += 1) {
        await sleep(50);
        const l = await zoomLabel(cdp);
        if (l !== before) {
          changed = Date.now() - zT0;
          break;
        }
      }
      if (i === 0) firstChangeMs = changed;
      zseq.push(await zoomLabel(cdp));
    }
    ok(
      zseq[1] === '150%' && zseq[2] === '200%' && zseq[3] === '300%' && zseq[4] === '400%',
      `Ctrl+= 档位序列：${zseq.join(' → ')}（期望 100% → 150% → 200% → 300% → 400%）`,
    );
    ok(firstChangeMs !== null && firstChangeMs < 1500, `按键到标签更新 ${firstChangeMs}ms（要求 < 1500ms）`);
    key(cdp, '0', { code: 'Digit0', vk: 48, mods: 2 });
    await sleep(900);
    ok((await settingsOf(cdp)).defaultZoom === 'fit-width', `Ctrl+0 回到适应宽度（defaultZoom=${String((await settingsOf(cdp)).defaultZoom)}）`);
    await cdp.eval(`(() => { document.querySelector('.rd-zoom-value')?.click(); return true; })()`);
    await sleep(600);
    let wheelBefore = await zoomLabel(cdp);
    // 把滚轮打在当前页中心（保证事件落在阅读器 stage 内，而不是侧栏/空白处）
    const wheelPt = await cdp.eval(`
      (() => {
        const cy = window.innerHeight / 2;
        const pages = [...document.querySelectorAll('.rd-pdf-page')];
        const page = pages.find((p) => { const r = p.getBoundingClientRect(); return r.top <= cy && r.bottom >= cy; }) ?? pages[0];
        if (!page) return null;
        const r = page.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(Math.max(140, Math.min(window.innerHeight - 140, r.top + r.height / 2))) };
      })()
    `);
    if (wheelPt) cdp.fire('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wheelPt.x, y: wheelPt.y, deltaX: 0, deltaY: -120, modifiers: 2 });
    await sleep(700);
    let wheelAfter = await zoomLabel(cdp);
    if (wheelPt && wheelAfter === wheelBefore) {
      // 一次没生效（可能是上一帧合并/焦点问题）→ 再打一次，避免偶发误报
      cdp.fire('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wheelPt.x, y: wheelPt.y, deltaX: 0, deltaY: -120, modifiers: 2 });
      await sleep(700);
      wheelAfter = await zoomLabel(cdp);
    }
    const rb = parseFloat(wheelBefore);
    const ra = parseFloat(wheelAfter);
    ok(ra > rb && ra / rb <= 1.4, `Ctrl+滚轮一次 ${wheelBefore} → ${wheelAfter}（涨幅 ${((ra / rb - 1) * 100).toFixed(0)}% ≤ 40%，点位 ${JSON.stringify(wheelPt)}）`);

    console.log('\n[N] 缩放落盘防抖 + 重开恢复');
    await blur(cdp);
    key(cdp, '0', { code: 'Digit0', vk: 48, mods: 2 }); // 先稳定到 fit-width 并落盘
    await sleep(800);
    await cdp.eval(`(() => { document.querySelector('.rd-zoom-value')?.click(); return true; })()`); // 重置 100%
    await sleep(700); // 等"重置"自己那次防抖写完，否则会把它的落盘误当成连按的结果
    const beforeN = (await settingsOf(cdp)).defaultZoom;
    console.log(`  防抖基线：重置后 defaultZoom=${String(beforeN)}（期望 1）`);
    for (let i = 0; i < 3; i += 1) {
      key(cdp, '=', { code: 'Equal', vk: 187, mods: 2 });
      await sleep(100);
    }
    const immediate = (await settingsOf(cdp)).defaultZoom;
    ok(immediate === beforeN, `连按 3 次放大后"立刻"读 defaultZoom 还没变（${String(immediate)} == ${String(beforeN)}）`);
    await sleep(800);
    const settled = (await settingsOf(cdp)).defaultZoom;
    ok(settled === 3, `防抖窗口后落盘为最终档位（${String(settled)}，期望 3）`);

    console.log('\n[O] 选区方向：向下 / 向上拖到空白都不反选');
    // [N]/[M] 可能把阅读器停在放大档（上一轮 [N] 结束是 300%），可视行会不够：
    // 先回"适应宽度"，并在取不到锚点行时再重置一次重试，避免因为前面用例改了缩放而误报。
    // 24 页连续布局下 DOM 里有全部页，"第一页"通常不在视口里：
    // 所以锚点行、整页文本、上下空白点都必须**限定在锚点所在的那一页**里算。
    const readAnchorPack = () => cdp.eval(`
      (() => {
        const spans = [...document.querySelectorAll('.rd-pdf-text span')].filter((s) => {
          const t = (s.textContent || '').trim();
          const r = s.getBoundingClientRect();
          return t.length >= 10 && r.width > 120 && r.top > 160 && r.bottom < window.innerHeight - 120;
        });
        if (spans.length < 3) return null;
        const s = spans[1];
        document.querySelectorAll('[data-ux-anchor]').forEach((e) => e.removeAttribute('data-ux-anchor'));
        s.setAttribute('data-ux-anchor', '1');
        const r = s.getBoundingClientRect();
        const page = s.closest('.rd-pdf-page');
        if (!page) return null;
        const pr = page.getBoundingClientRect();
        const own = [...page.querySelectorAll('.rd-pdf-text span')]
          .map((x) => ({ t: (x.textContent || '').trim(), top: x.getBoundingClientRect().top, bottom: x.getBoundingClientRect().bottom }))
          .sort((a, b) => a.top - b.top);
        const firstTop = own.length ? own[0].top : pr.top;
        const lastBottom = own.length ? Math.max(...own.map((o) => o.bottom)) : pr.top;
        const pick = (cands) => {
          for (const c of cands) {
            const el = document.elementFromPoint(c.x, c.y);
            const inPage = !!el?.closest?.('.rd-pdf-page');
            const onSpan = !!el?.closest?.('.rd-pdf-text span');
            if (inPage && !onSpan) return c;
          }
          return null;
        };
        const maxY = Math.min(window.innerHeight - 30, pr.bottom - 20);
        const scTop = document.querySelector('.rd-pdf-scroll')?.getBoundingClientRect?.().top ?? 0;
        const minY = Math.max(pr.top + 12, scTop + 24); // 避开阅读器顶栏
        const down = pick([
          { x: Math.round(pr.left + pr.width / 2), y: Math.round(Math.min(maxY, lastBottom + 45)) },
          { x: Math.round(pr.right - 18), y: Math.round(Math.min(maxY, lastBottom + 45)) },
          { x: Math.round(pr.left + pr.width / 2), y: Math.round(Math.min(maxY, lastBottom + 24)) },
        ]);
        const up = pick([
          { x: Math.round(pr.left + pr.width / 2), y: Math.round(Math.max(minY, firstTop - 44)) },
          { x: Math.round(pr.right - 18), y: Math.round(Math.max(minY, firstTop - 44)) },
          { x: Math.round(pr.left + pr.width / 2), y: Math.round(Math.max(minY, firstTop - 26)) },
        ]);
        return {
          lineCount: spans.length,
          // 判据用 span 序号 + intersectsNode：锚点按在行 40% 处，选区本来就从行中间开始，比文本前缀可靠
          line: { x: Math.round(r.left + r.width * 0.4), y: Math.round(r.top + r.height / 2), right: Math.round(r.right), text: s.textContent || '' },
          anchorIndex: [...page.querySelectorAll('.rd-pdf-text span')].indexOf(s),
          spanCount: page.querySelectorAll('.rd-pdf-text span').length,
          pageNo: Number(page.dataset.pageIndex),
          pageTextLen: (page.querySelector('.rd-pdf-text')?.textContent || '').length,
          firstLine: own[0]?.t ?? '',
          lastLine: own.length ? own[own.length - 1].t : '',
          down,
          up,
        };
      })()
    `);
    // 先回适应宽度（前一条 [N] 结束时是 300% 放大）
    await blur(cdp);
    key(cdp, '0', { code: 'Digit0', vk: 48, mods: 2 });
    await sleep(1000);
    // 再把"当前视口所属那一页"的文字块滚到视口中间：否则可能在页边空白处，一行都取不到
    await cdp.eval(`
      (() => {
        const cy = window.innerHeight / 2;
        const pages = [...document.querySelectorAll('.rd-pdf-page')];
        const page = pages.find((p) => { const r = p.getBoundingClientRect(); return r.top <= cy && r.bottom >= cy; }) ?? pages[0];
        const spans = page ? [...page.querySelectorAll('.rd-pdf-text span')] : [];
        const mid = spans[Math.floor(spans.length / 2)] ?? spans[0];
        mid?.scrollIntoView({ block: 'center' });
        return !!mid;
      })()
    `);
    await sleep(700);
    let anchorPack = await readAnchorPack();
    if (!anchorPack) {
      console.log('  （视口内可拖选行不足 3 行 → 再 Ctrl+0 重置缩放后重试）');
      await blur(cdp);
      key(cdp, '0', { code: 'Digit0', vk: 48, mods: 2 });
      await sleep(1300);
      anchorPack = await readAnchorPack();
    }
    if (!anchorPack) {
      ok(false, '取不到锚点行（已先 Ctrl+0 回适应宽度并重试一次，视口内仍不足 3 行）');
    } else {
      const anchor = anchorPack.line;
      console.log(
        `  锚点：页 ${anchorPack.pageNo} 的第 ${anchorPack.anchorIndex + 1}/${anchorPack.spanCount} 个 span（按在 40% 处 x=${anchor.x}, y=${anchor.y}）；` +
          `下空白=${anchorPack.down ? `(${anchorPack.down.x},${anchorPack.down.y})` : '无'}；` +
          `上空白=${anchorPack.up ? `(${anchorPack.up.x},${anchorPack.up.y})` : '无'}`,
      );
      ok(!!anchorPack.down, `取到锚点页下方空白点（第 ${anchorPack.pageNo} 页，共 ${anchorPack.lineCount} 行可选）`);
      if (anchorPack.down) {
        await leftDrag(cdp, anchor.x, anchor.y, anchorPack.down.x, anchorPack.down.y);
        const sDown = await selSpanInfo(cdp);
        console.log(`  向下拖选区：「${(sDown?.text ?? '').slice(0, 40)}」`);
        ok(!!sDown && sDown.len > 0, `向下拖到空白后有选区（${sDown?.len ?? 0} 字）`);
        ok(!!sDown && sDown.intersectsAnchor === true, `向下拖选区包含锚点 span（intersectsNode=${sDown?.intersectsAnchor}）`);
        ok(
          !!sDown && sDown.firstIdx !== null && sDown.anchorIndex !== null && sDown.firstIdx >= sDown.anchorIndex,
          `没有反选：选区起点 span ${sDown?.firstIdx} ≥ 锚点 span ${sDown?.anchorIndex}（覆盖 ${sDown?.firstIdx}→${sDown?.lastIdx}）`,
        );
        ok(!!sDown && sDown.startPage === sDown.endPage && sDown.startPage === anchorPack.pageNo, `向下拖选区只在锚点页内（start=${sDown?.startPage} end=${sDown?.endPage} 期望页=${anchorPack.pageNo}）`);
        ok(!!sDown && sDown.len < anchorPack.pageTextLen, `长度 ${sDown?.len} < 整页文本 ${anchorPack.pageTextLen}（不是全选）`);
      }
      ok(!!anchorPack.up, '取到文字块上方的空白点');
      if (anchorPack.up) {
        await leftDrag(cdp, anchor.x, anchor.y, anchorPack.up.x, anchorPack.up.y);
        const sUp = await selSpanInfo(cdp);
        console.log(`  向上拖选区：「${(sUp?.text ?? '').slice(0, 40)}」`);
        ok(!!sUp && sUp.len > 0, `向上拖到空白后有选区（${sUp?.len ?? 0} 字）`);
        ok(!!sUp && sUp.intersectsAnchor === true, `向上拖选区包含锚点 span（intersectsNode=${sUp?.intersectsAnchor}）`);
        ok(
          !!sUp && sUp.lastIdx !== null && sUp.anchorIndex !== null && sUp.lastIdx <= sUp.anchorIndex,
          `没有反选：选区终点 span ${sUp?.lastIdx} ≤ 锚点 span ${sUp?.anchorIndex}（覆盖 ${sUp?.firstIdx}→${sUp?.lastIdx}）`,
        );
        ok(!!sUp && sUp.startPage === sUp.endPage && sUp.startPage === anchorPack.pageNo, `向上拖选区只在锚点页内（start=${sUp?.startPage} end=${sUp?.endPage} 期望页=${anchorPack.pageNo}）`);
      }
    }

    console.log('\n[P] 左侧导航：默认 4 项 / 勾选 / 重启 / 取消回落');
    await goLibrary(cdp);
    const baseNav = await navNames(cdp);
    ok(
      JSON.stringify(baseNav) === JSON.stringify(['全部文献', '最近添加', '在读', '星标']),
      `默认侧栏只有 4 项：${baseNav.join(' / ')}`,
    );
    /** 进设置页 →「外观」分区，找「未读」那一行的 switch 坐标 */
    const openSettingsUnreadSwitch = async () => {
      await cdp.eval(`(() => { const b=[...document.querySelectorAll('.icon-btn')].find((x)=>(x.title||'')==='设置'); b?.click(); return !!b; })()`);
      await sleep(900);
      await cdp.eval(`(() => { const t=[...document.querySelectorAll('.set-nav-item')].find((x)=>x.textContent.trim()==='外观'); t?.click(); return !!t; })()`);
      await sleep(700);
      return cdp.eval(`
        (() => {
          const sws = [...document.querySelectorAll('button.switch')];
          for (const s of sws) {
            let n = s.parentElement;
            for (let i = 0; i < 4 && n; i += 1, n = n.parentElement) {
              const t = (n.textContent || '').trim();
              if (t.length < 80 && t.includes('未读')) {
                const r = s.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), on: s.classList.contains('on') };
              }
            }
          }
          return null;
        })()
      `);
    };
    const swOn = await openSettingsUnreadSwitch();
    ok(!!swOn, `设置页找到「未读」开关（当前 on=${swOn?.on}）`);
    if (swOn) {
      await leftClick(cdp, swOn.x, swOn.y);
      await sleep(800);
      const swState = await cdp.eval(`
        (() => {
          const sws = [...document.querySelectorAll('button.switch')];
          for (const s of sws) {
            let n = s.parentElement;
            for (let i = 0; i < 4 && n; i += 1, n = n.parentElement) {
              const t = (n.textContent || '').trim();
              if (t.length < 80 && t.includes('未读')) return s.classList.contains('on');
            }
          }
          return null;
        })()
      `);
      ok(swState === true, `点开关后「未读」变成已勾选（on=${swState}）`);
      await goLibrary(cdp);
      const navOn = await navNames(cdp);
      ok(navOn.includes('未读') && navOn.length === 5, `勾选后侧栏出现「未读」：${navOn.join(' / ')}`);

      await cdp.eval(`(() => { const b=[...document.querySelectorAll('.sb-item')].find((x)=>(x.textContent||'').includes('未读')); b?.click(); return !!b; })()`);
      await sleep(600);
      ok((await activeNav(cdp)) === '未读', `点「未读」后它是当前筛选（${await activeNav(cdp)}）`);

      await relaunch();
      const navRestart = await navNames(cdp);
      ok(navRestart.includes('未读'), `重启后「未读」仍在侧栏：${navRestart.join(' / ')}`);

      await cdp.eval(`(() => { const b=[...document.querySelectorAll('.sb-item')].find((x)=>(x.textContent||'').includes('未读')); b?.click(); return !!b; })()`);
      await sleep(600);
      const swOff = await openSettingsUnreadSwitch();
      if (swOff) await leftClick(cdp, swOff.x, swOff.y);
      await sleep(900);
      await goLibrary(cdp);
      const navOff = await navNames(cdp);
      ok(!navOff.includes('未读') && navOff.length === 4, `取消勾选后「未读」消失：${navOff.join(' / ')}`);
      ok((await activeNav(cdp)) === '全部文献', `筛选回落到「全部文献」（当前 ${await activeNav(cdp)}）`);
    }

    console.log('\n[H2] 重启后的渲染层健康检查');
    const errs2 = cdp.errors.filter((e) => !/DevTools|Autofill|Electron Security/i.test(e));
    ok(errs2.length === 0, `渲染层零错误（${errs2.length}）`, errs2.slice(0, 3).join(' | '));
    } else {
      console.log('\n（UX_SECTIONS 过滤：跳过 [I]–[P]）');
    }

    console.log('\n主进程日志（末尾 6 行）：');
    for (const l of logs.trim().split('\n').slice(-6)) console.log(`    ${l.trim()}`);
  } finally {
    cdp?.close();
    child.kill();
    await sleep(700);
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }

  console.log(`\n${failures ? `❌ 失败 ${failures} 项` : '✅ UX 回归验收全部通过'}`);
  console.log(`截图：${SHOTS}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(`验收中止：${err?.message ?? err}`);
  process.exit(1);
});

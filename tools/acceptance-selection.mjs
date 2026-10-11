/**
 * 划词手感回归用例（改前 / 改后都能跑，只测真实鼠标产生的选区）。
 *
 * 为什么单独一个脚本：
 *   划词是"手感"，只能靠**真实鼠标事件**复现——JS 直接改 window.getSelection() 测不出
 *   "指针停在行间距里会不会跳到下一行""拖到页面空白会不会暴涨成整页/整篇"这两类问题。
 *   所以这里全程用 CDP 的 Input.dispatchMouseEvent 发 mousePressed → 多次 mouseMoved →
 *   mouseReleased，并且**只观察**选区（selectionchange 日志 + Range 几何），从不改写选区。
 *
 * 覆盖（对应 task-11 的 5 类场景）：
 *   [1] 普通拖选 → 划词工具条 → 高亮落库（带相对矩形）
 *   [2] 行间距：指针停在两行之间的空隙里，选区只能延伸到指针所在那一行（Word 手感）
 *   [3] 拖到空白 / 页外：不能暴涨成整页/整篇，且不跨页
 *   [4] 单击已有高亮 → 批注卡片打开；Esc 只关卡片
 *   [5] 反方向拖选（从下往上）与 Shift+点击扩选
 *
 * 数据隔离：把真实论文库**只读复制**到 tmp/selection-acceptance-library，
 * 再用 LITSHELF_DATA_DIR 指向 tmp/selection-acceptance-data 起一个独立实例。
 * 真实目录用 `LITSHELF_SRC_LIB` 指定（默认 `~/Desktop/文献`）；
 * 用户论文目录全程只读，脚本结束时会校验其中每个文件的 size/mtime 没变。
 *
 * 用法：node tools/acceptance-selection.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const PORT = 9333; // 与 acceptance.mjs(9222) / acceptance-cjk.mjs(9111) 错开，避免和别的用例抢端口
const DATA = path.join(ROOT, 'tmp', 'selection-acceptance-data');
const LIB = path.join(ROOT, 'tmp', 'selection-acceptance-library');
const SHOTS = path.join(ROOT, 'tmp', 'shots-selection');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
/** 真实文献目录（只读采样）：用 LITSHELF_SRC_LIB 指定；默认是家目录下的通用位置 */
const SRC_LIB = process.env.LITSHELF_SRC_LIB || path.join(os.homedir(), 'Desktop', '文献');
const VIEW = { w: 1440, h: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function ok(cond, label, extra = '') {
  if (!cond) failures += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
}
function info(label) {
  console.log(`   ℹ ${label}`);
}

// ---------------------------------------------------------------- 进程工具（单实例锁只认自己的数据目录，收尾时别和别人撞）

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '') + (r.stderr || '');
}
function pidsOnPort(port) {
  const pids = new Set();
  for (const line of sh('netstat', ['-ano']).split(/\r?\n/)) {
    if (!line.includes(`:${port}`) || !/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const pid = Number(cols[cols.length - 1]);
    if (pid > 0) pids.add(pid);
  }
  return [...pids];
}
function electronPids() {
  const out = sh('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV', '/NH']);
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^"electron\.exe","(\d+)"/i);
    if (m) pids.push(Number(m[1]));
  }
  return pids;
}
function killPid(pid, why) {
  if (!pid) return;
  try {
    sh('taskkill', ['/PID', String(pid), '/T', '/F']);
    info(`已清理 ${why}：pid ${pid}`);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 极简 CDP 客户端

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.warnings = [];
    this.debug = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '');
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
        // 只有 console.error 才算"渲染层错误"；warning 单独记（pdf.js 的字体告警、Electron 安全提示都属此类）
        if (m.params.type === 'error') this.errors.push(`[error] ${text}`);
        else if (m.params.type === 'warning') this.warnings.push(`[warning] ${text}`);
        else this.debug.push(`[${m.params.type}] ${text}`);
        if (this.debug.length > 60) this.debug.shift();
      }
      if (m.method === 'Log.entryAdded') {
        if (m.params.entry.level === 'error') this.errors.push(m.params.entry.text);
        else if (m.params.entry.level === 'warning') this.warnings.push(`[log] ${m.params.entry.text}`);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = (this.id += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      const timeout = method === 'Page.captureScreenshot' ? 15000 : method === 'Runtime.evaluate' ? 45000 : 30000;
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时 ${method}`));
        }
      }, timeout);
    });
  }

  /** 发出去不等应答（Esc / 滚轮这类偶尔不回包的输入） */
  fire(method, params = {}) {
    const id = (this.id += 1);
    this.ws.send(JSON.stringify({ id, method, params }));
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`页面异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }

  async shot(name) {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
      info(`截图 tmp/shots-selection/${name}`);
    } catch (err) {
      info(`截图 ${name} 失败：${err.message}`);
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

// ---------------------------------------------------------------- 页面侧探针（只观察，不改选区）

/**
 * 注入到渲染层的探针。用函数源码注入（`pageProbe.toString()`），避免模板字符串里反斜杠转义踩坑。
 * 提供的都是**只读**能力：读选区几何、读行模型、读页面几何、读工具条/批注卡片状态。
 */
function pageProbe() {
  const V = 4;
  if (window.__selh && window.__selh.v === V) return window.__selh.v;

  const nz = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
  const elOf = (n) => (!n ? null : n.nodeType === 1 ? n : n.parentElement);
  const closestSpan = (n) => {
    const el = elOf(n);
    return el && el.closest ? el.closest('.rd-pdf-text span') : null;
  };
  const round = (v) => Math.round(v * 10) / 10;
  const box = (sp) => {
    if (!sp) return null;
    const r = sp.getBoundingClientRect();
    return {
      top: round(r.top),
      bottom: round(r.bottom),
      mid: round((r.top + r.bottom) / 2),
      h: round(r.bottom - r.top),
      left: round(r.left),
      right: round(r.right),
      ch: nz(sp.textContent).length,
      txt: String(sp.textContent || '').slice(0, 14),
    };
  };
  const pageEl = (i) => document.querySelector('.rd-pdf-page[data-page-index="' + i + '"]');

  const pagesOf = (range) => {
    const out = [];
    const push = (p) => {
      if (p && out.indexOf(p) < 0) out.push(p);
    };
    let rects = [];
    try {
      rects = Array.prototype.slice.call(range.getClientRects());
    } catch {
      rects = [];
    }
    for (const el of document.querySelectorAll('.rd-pdf-page')) {
      const pr = el.getBoundingClientRect();
      const hit = rects.some(
        (r) => r.right > pr.left + 0.5 && r.left < pr.right - 0.5 && r.bottom > pr.top + 0.5 && r.top < pr.bottom - 0.5,
      );
      if (hit) push(Number(el.dataset.pageIndex));
    }
    for (const n of [range.startContainer, range.endContainer]) {
      const el = elOf(n);
      const p = el && el.closest ? el.closest('.rd-pdf-page') : null;
      if (p) push(Number(p.dataset.pageIndex));
    }
    return out.sort((a, b) => a - b);
  };

  let seq = 0;
  const log = [];
  let mark = 0;

  const snap = (kind) => {
    const sel = window.getSelection();
    const o = { kind, seq: (seq += 1), collapsed: !sel || sel.isCollapsed, len: 0, nz: 0, pages: [], text: '' };
    if (!sel) return o;
    const text = sel.toString();
    o.len = text.length;
    o.nz = nz(text).length;
    o.text = text.slice(0, 48);
    o.head = text.slice(0, 36);
    o.tail = text.slice(-36);
    if (!sel.rangeCount) return o;
    let range;
    try {
      range = sel.getRangeAt(0);
    } catch {
      return o;
    }
    o.pages = pagesOf(range);
    o.tb = !!document.querySelector('.rd-sel-toolbar'); // 拖动过程中工具条是否已经弹出来（会盖住指针）
    // 选区在屏幕上的真实覆盖范围：按 client rect 算，比"节点最近的 span"可靠得多
    let rects = [];
    try {
      rects = Array.prototype.slice.call(range.getClientRects());
    } catch {
      rects = [];
    }
    if (rects.length) {
      const first = rects[0];
      const last = rects[rects.length - 1];
      let minTop = Infinity;
      let maxBottom = -Infinity;
      const tops = [];
      for (const r of rects) {
        if (r.top < minTop) minTop = r.top;
        if (r.bottom > maxBottom) maxBottom = r.bottom;
        tops.push(r.top);
      }
      tops.sort((a, b) => a - b);
      let bands = 0;
      let prev = -1e9;
      for (const t of tops) {
        if (t - prev > 4) {
          bands += 1;
          prev = t;
        }
      }
      o.r = {
        n: rects.length,
        bands,
        firstMid: round((first.top + first.bottom) / 2),
        lastMid: round((last.top + last.bottom) / 2),
        minTop: round(minTop),
        maxBottom: round(maxBottom),
      };
    }
    if (!sel.isCollapsed) {
      o.a = box(closestSpan(sel.anchorNode));
      o.f = box(closestSpan(sel.focusNode));
      o.s = box(closestSpan(range.startContainer));
      o.e = box(closestSpan(range.endContainer));
      // 落点是哪个 span、在 DOM 里排第几、属于哪一页 —— 暴涨时用它定位"锚点跑到哪去了"
      const nodeInfo = (n) => {
        const el = elOf(n);
        const sp = el && el.closest ? el.closest('.rd-pdf-text span') : null;
        const pg = el && el.closest ? el.closest('.rd-pdf-page') : null;
        const cont = sp && sp.closest ? sp.closest('.rd-pdf-text') : null;
        return {
          page: pg ? Number(pg.dataset.pageIndex) : null,
          idx: cont && sp ? Array.prototype.indexOf.call(cont.querySelectorAll('span'), sp) : -1,
          mid: box(sp)?.mid ?? null,
          txt: sp ? String(sp.textContent || '').slice(0, 14) : '',
          node: !n ? '—' : `${n.nodeName}${el && el.className ? '.' + String(el.className).split(' ')[0] : ''}`,
        };
      };
      o.an = nodeInfo(sel.anchorNode);
      o.fo = nodeInfo(sel.focusNode);
      o.st = nodeInfo(range.startContainer);
      o.en = nodeInfo(range.endContainer);
    }
    return o;
  };

  document.addEventListener('selectionchange', () => {
    log.push(snap('change'));
    if (log.length > 260) log.splice(0, log.length - 260);
  });

  const api = {
    v: V,
    nz,
    box,
    mark() {
      mark = log.length;
      return mark;
    },
    log() {
      return log.slice(-30);
    },
    sel() {
      return snap('live');
    },
    /** 一次拖动的结果：落定选区（最后一次非空状态）+ 变更序列（诊断暴涨用） */
    result() {
      const ents = log.slice(mark);
      const nonEmpty = ents.filter((e) => !e.collapsed && e.nz > 0);
      const settled = nonEmpty.length ? nonEmpty[nonEmpty.length - 1] : ents.length ? ents[ents.length - 1] : snap('live');
      let maxNz = 0;
      for (const e of ents) if (e.nz > maxNz) maxNz = e.nz;
      return {
        live: snap('live'),
        changes: ents.length,
        seq: ents.slice(-16).map((e) => `${e.collapsed ? 0 : e.nz}${e.tb ? 'T' : ''}`),
        maxNz,
        settled,
      };
    },
    geo() {
      const pages = [];
      for (const el of document.querySelectorAll('.rd-pdf-page')) {
        const r = el.getBoundingClientRect();
        pages.push({ page: Number(el.dataset.pageIndex), top: round(r.top), bottom: round(r.bottom), left: round(r.left), right: round(r.right), w: r.width, h: r.height });
      }
      const s = document.querySelector('.rd-pdf-scroll');
      const scroller = s ? { top: Math.round(s.scrollTop), h: s.clientHeight, sh: s.scrollHeight } : null;
      return { pages, viewport: { w: window.innerWidth, h: window.innerHeight }, scroller };
    },
    /** 逐字 span → 行模型（按 top 归行，过滤掉页码/上标这类碎行） */
    lines(pageIndex) {
      const el = pageEl(pageIndex);
      if (!el) return null;
      const raw = [];
      for (const sp of el.querySelectorAll('.rd-pdf-text span')) {
        const ch = nz(sp.textContent).length;
        if (ch < 1) continue;
        const r = sp.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        raw.push({ ch, top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height });
      }
      if (!raw.length) return { page: pageIndex, lines: [], spans: 0, allChars: 0, medH: 0 };
      const hs = raw.map((x) => x.h).sort((a, b) => a - b);
      const medH = hs[Math.floor(hs.length / 2)] || 10;
      const tol = Math.max(1.5, medH * 0.45);
      raw.sort((a, b) => a.top - b.top || a.left - b.left);
      const groups = [];
      for (const it of raw) {
        const g = groups[groups.length - 1];
        if (g && Math.abs(it.top - g.topRef) <= tol) {
          g.top = Math.min(g.top, it.top);
          g.bottom = Math.max(g.bottom, it.bottom);
          g.left = Math.min(g.left, it.left);
          g.right = Math.max(g.right, it.right);
          g.chars += it.ch;
          g.n += 1;
        } else {
          groups.push({ topRef: it.top, top: it.top, bottom: it.bottom, left: it.left, right: it.right, chars: it.ch, n: 1 });
        }
      }
      const lines = groups
        .map((g) => ({
          top: round(g.top),
          bottom: round(g.bottom),
          mid: round((g.top + g.bottom) / 2),
          left: round(g.left),
          right: round(g.right),
          w: round(g.right - g.left),
          h: round(g.bottom - g.top),
          chars: g.chars,
          spans: g.n,
        }))
        .filter((l) => l.chars >= 8 && l.w >= 50)
        .sort((a, b) => a.mid - b.mid);
      return { page: pageIndex, medH: round(medH), lines, spans: raw.length, allChars: raw.reduce((n, x) => n + x.ch, 0) };
    },
    /** 某个屏幕坐标底下/最近的那个逐字 span 的盒子（判断"按下点在哪一行"） */
    spanAt(x, y) {
      const el = document.elementFromPoint(x, y);
      let sp = el && el.closest ? el.closest('.rd-pdf-text span') : null;
      let how = sp ? 'elementFromPoint' : '';
      if (!sp && document.caretRangeFromPoint) {
        const cr = document.caretRangeFromPoint(x, y);
        if (cr) {
          sp = closestSpan(cr.startContainer);
          if (sp) how = 'caretRangeFromPoint';
        }
      }
      return { box: box(sp), how, hit: el ? String(el.className || el.tagName) : '' };
    },
    /** 把某一页滚到视口里（纯滚动，不碰选区）：页面还没渲染时用它的 .rd-page-slot 占位 */
    scrollToPage(n) {
      const s = document.querySelector('.rd-pdf-scroll');
      if (!s) return null;
      const sr = s.getBoundingClientRect();
      const el = pageEl(n) || document.querySelectorAll('.rd-page-slot')[n - 1];
      if (!el) return null;
      const er = el.getBoundingClientRect();
      s.scrollTop = s.scrollTop + (er.top - sr.top) - 40;
      return Math.round(s.scrollTop);
    },
    zoomText() {
      return (document.querySelector('.rd-zoom-value')?.textContent || '').trim();
    },
    /** 本页落在 y 以下的文字总量（"拖到空白"到底该选多少字的参照） */
    charsBelow(pageIndex, y) {
      const el = pageEl(pageIndex);
      if (!el) return 0;
      let n = 0;
      for (const sp of el.querySelectorAll('.rd-pdf-text span')) {
        const ch = nz(sp.textContent).length;
        if (!ch) continue;
        const r = sp.getBoundingClientRect();
        if ((r.top + r.bottom) / 2 > y) n += ch;
      }
      return n;
    },
    toolbar() {
      const el = document.querySelector('.rd-sel-toolbar');
      if (!el) return { present: false, actions: [] };
      const r = el.getBoundingClientRect();
      const actions = Array.prototype.map
        .call(el.querySelectorAll('button'), (b) => (b.title || b.textContent || '').trim())
        .filter(Boolean);
      return { present: true, actions, rect: { left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom) } };
    },
    actionButton(label) {
      const el = document.querySelector('.rd-sel-toolbar');
      if (!el) return null;
      const b = Array.prototype.find.call(el.querySelectorAll('button'), (x) => (x.title || x.textContent || '').trim() === label);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    },
    annMarks() {
      return document.querySelectorAll('.rd-ann-layer > *').length;
    },
    cardPresent() {
      return !!document.querySelector('.rd-ann-card');
    },
    pageCount() {
      return document.querySelectorAll('.rd-pdf-page').length;
    },
  };
  window.__selh = api;
  return V;
}

const PROBE_SRC = `(${pageProbe.toString()})()`;

// ---------------------------------------------------------------- 启动 / 输入

async function launch() {
  const env = { ...process.env, LITSHELF_DATA_DIR: DATA };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, '.'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  for (let i = 0; i < 70; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Log.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEW.w, height: VIEW.h, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Page.bringToFront').catch(() => undefined);
        return { cdp, child, logs };
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`等不到 Electron 的调试端口 ${PORT}（是否有残留实例占着单实例锁？）\n${logs.slice(-6).join('')}`);
}

/** 从真实论文库**只读复制**到隔离目录；返回按体积升序（小的先试）的文件名 */
async function copyLibrary() {
  const all = (await fs.readdir(SRC_LIB)).filter((f) => f.toLowerCase().endsWith('.pdf'));
  const listed = [];
  for (const name of all) {
    const st = await fs.stat(path.join(SRC_LIB, name));
    listed.push({ name, size: st.size });
  }
  listed.sort((a, b) => a.size - b.size);
  await fs.mkdir(LIB, { recursive: true });
  for (const f of listed) await fs.copyFile(path.join(SRC_LIB, f.name), path.join(LIB, f.name));
  return listed.map((f) => f.name);
}

async function dirFingerprint(dir) {
  const out = [];
  for (const name of (await fs.readdir(dir)).sort()) {
    const st = await fs.stat(path.join(dir, name));
    out.push(`${name}|${st.size}|${Math.round(st.mtimeMs)}`);
  }
  return out.join('\n');
}

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  await fs.rm(DATA, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(LIB, { recursive: true, force: true }).catch(() => undefined);

  console.log('划词手感验收（真实鼠标事件 + 隔离数据目录）');
  console.log(`  隔离数据目录：${DATA}`);
  console.log(`  论文副本目录：${LIB}`);

  // 构建新鲜度：改完 src 忘了 build 的话，这里测的还是旧产物，必须先说清楚
  let buildSig = '';
  try {
    const assets = (await fs.readdir(path.join(ROOT, 'dist', 'renderer', 'assets'))).sort();
    buildSig = assets.join(',');
    const bundle = assets.filter((f) => f.endsWith('.js'))[0] ?? assets[0];
    const distM = (await fs.stat(path.join(ROOT, 'dist', 'renderer', 'assets', bundle))).mtime;
    const srcM = (await fs.stat(path.join(ROOT, 'src', 'renderer', 'reader', 'PdfViewer.tsx'))).mtime;
    info(`构建时间 dist/renderer/assets/${bundle} = ${distM.toLocaleString('zh-CN')}；PdfViewer.tsx = ${srcM.toLocaleString('zh-CN')}`);
    if (srcM > distM) info('⚠ 源码比构建产物新：先跑 node scripts/build.mjs，否则测的是旧代码');
  } catch (err) {
    info(`读构建时间失败：${err.message}`);
  }

  const srcBefore = await dirFingerprint(SRC_LIB);
  const copied = await copyLibrary();
  ok(copied.length >= 2, `已从真实论文库只读复制 ${copied.length} 篇到隔离目录`);

  const leftovers = electronPids();
  const stalePids = leftovers.filter((pid) => pidsOnPort(PORT).includes(pid));
  for (const pid of stalePids) killPid(pid, `上次跑剩下来占着 ${PORT} 端口的实例`);

  let session = null;
  let cdp = null;
  let child = null;
  const summary = [];
  let step = 'launch';
  const at = (s) => {
    step = s;
    info(`… ${s}`);
  };
  try {
    session = await launch();
    cdp = session.cdp;
    child = session.child;
    at('已连上渲染层，等首屏 + 跳过引导页');
    await sleep(3000);
    const skipped = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('跳过'));
      if (!b) return 'no-onboarding';
      b.click();
      return 'skipped';
    })()`);
    info(`引导页：${skipped}`);
    await sleep(800);

    at('添加文献库并等解析完成');
    await cdp.eval(`(async () => { await window.litshelf.invoke('addRoot', [${JSON.stringify(LIB)}, { depth: 2 }]); return true; })()`);
    let snapItems = [];
    for (let i = 0; i < 80; i += 1) {
      snapItems = await cdp.eval(`(async () => (await window.litshelf.invoke('getSnapshot', [])).items.map((x) => ({ id: x.id, name: x.name, pages: x.pageCount, state: x.parseState })))()`);
      if (snapItems.length >= copied.length && snapItems.every((x) => x.state !== 'placeholder')) break;
      await sleep(500);
    }
    ok(snapItems.length >= 2, `隔离库里出现 ${snapItems.length} 篇文献（解析状态：${snapItems.map((x) => x.state).join('/')}）`);
    const ready = snapItems.filter((x) => x.state === 'ready');
    ok(ready.length >= 2, `${ready.length} 篇解析完成`);
    info(`候选（按体积升序）：${copied.slice(0, 4).join(' / ')}`);

    const typeSearch = async (text) => {
      const focused = await cdp.eval(`(() => {
        const el = document.getElementById('litshelf-search');
        if (!el) return false;
        el.focus();
        el.select();
        return true;
      })()`);
      if (!focused) return null;
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await cdp.send('Input.insertText', { text });
      await sleep(700);
    };
    const clickBack = async () => {
      await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').includes('返回'));
        b?.click();
        return !!b;
      })()`);
      await sleep(1000);
    };

    // ---- 打开一篇真实中文期刊 PDF（文本层没起来就重试一次、再换下一篇） ----
    let item = null;
    let openedName = '';
    let textLayerFlakes = 0;
    for (const name of copied.slice(0, 4)) {
      for (let attempt = 1; attempt <= 2 && !openedName; attempt += 1) {
        at(`打开候选论文：${name.slice(0, 18)}…（第 ${attempt} 次）`);
        await typeSearch(name.replace(/\.pdf$/i, '').slice(0, 12));
        await sleep(400);
        const clicked = await cdp.eval(`(() => {
          const rows = [...document.querySelectorAll('.row')];
          const r = rows.find((x) => (x.textContent || '').includes(${JSON.stringify(name.slice(0, 10))})) || rows[0];
          if (!r) return false;
          r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          return true;
        })()`);
        if (!clicked) {
          info(`${name.slice(0, 14)}… 在列表里没找到，跳过`);
          break;
        }
        let spans = 0;
        for (let i = 0; i < 60; i += 1) {
          spans = await cdp.eval('document.querySelectorAll(".rd-pdf-text span").length').catch(() => 0);
          if (spans > 30) break;
          await sleep(500);
        }
        if (spans > 30) {
          openedName = name;
          break;
        }
        const dump = await cdp.eval(`({
          rows: document.querySelectorAll('.row').length,
          readerPages: document.querySelectorAll('.rd-pdf-page').length,
          stage: !!document.querySelector('.rd-pdf-stage'),
          loading: !!document.querySelector('.rd-loading-card'),
          notice: (document.querySelector('.rd-notice') || {}).textContent || '',
          searchValue: (document.getElementById('litshelf-search') || {}).value || '',
          body: document.body.innerText.slice(0, 110),
        })`);
        info(`${name.slice(0, 14)}… 第 ${attempt} 次尝试后文本层只有 ${spans} 个 span｜DOM：${JSON.stringify(dump)}`);
        info(`渲染层最近日志：${[...(cdp.errors ?? []), ...(cdp.warnings ?? []), ...(cdp.debug ?? [])].slice(-3).join(' | ') || '（无）'}`);
        if (dump?.readerPages > 0 && dump?.stage) {
          textLayerFlakes += 1;
          info('ℹ 已知间歇问题（known-issues P1）：阅读器已打开、画布已渲染，但文本层 30 秒没挂上 —— 不记为本次硬失败，重试/换下一篇继续');
        }
        await cdp.shot(`00-open-fail-${copied.indexOf(name)}-${attempt}.png`);
        await clickBack();
        await typeSearch('');
      }
    }
    ok(!!openedName, `已在软件内打开真实中文论文：《${openedName || '（没有打开成功）'}》`);
    if (!openedName) throw new Error('没有一篇能打开的中文论文，后续场景无法进行');
    await sleep(1200);

    const spansNow = await cdp.eval('document.querySelectorAll(".rd-pdf-text span").length');
    item = snapItems.find((x) => x.name === openedName) ?? null;
    info(`文本层 span 数：${spansNow}；条目 id=${item?.id ?? '?'}；总页数=${item?.pages ?? '?'}`);
    ok(spansNow > 30, `文本层就绪（${spansNow} 个逐字 span）`);
    ok(!!item, `拿到条目记录（${item?.name ?? ''}）`);
    const itemId = item?.id;

    await cdp.eval(PROBE_SRC);
    const probe = (expr) => cdp.eval(`window.__selh.${expr}`);
    const geoRatio = await cdp.eval(`(() => {
      const sp = [...document.querySelectorAll('.rd-pdf-text span')]
        .filter((s) => /[\\u4e00-\\u9fa5]/.test(s.textContent || ''))
        .sort((a, b) => (b.textContent || '').length - (a.textContent || '').length)[0];
      if (!sp) return null;
      const r = sp.getBoundingClientRect();
      const fs = parseFloat(getComputedStyle(sp).fontSize);
      return { perChar: r.width / Math.max(1, (sp.textContent || '').length), fontSize: fs, text: (sp.textContent || '').slice(0, 12) };
    })()`);
    if (geoRatio) info(`中文字宽/字号 = ${(geoRatio.perChar / geoRatio.fontSize).toFixed(2)}（1.00 左右才说明 --total-scale-factor 生效，否则坐标全偏）`);

    // ---- 输入原语 ----
    const btn = (x, y, buttons, extra = {}) =>
      cdp.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', x, y, buttons }, extra));
    const esc = async () => {
      cdp.fire('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      cdp.fire('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(450);
    };
    const wheel = async (dy) => {
      cdp.fire('Input.dispatchMouseEvent', { type: 'mouseWheel', x: VIEW.w / 2, y: VIEW.h / 2, deltaX: 0, deltaY: dy });
      await sleep(320);
    };
    const clickAt = async (x, y, modifiers = 0) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, modifiers });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers });
      await sleep(40);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers });
      await sleep(500);
    };
    const dismissToolbar = async () => {
      if (!(await probe('toolbar()')).present) return;
      await esc();
      if ((await probe('pageCount()')) === 0) info('⚠ 关工具条后阅读器不见了（Esc 被穿透？）');
    };
    /** 真实拖选：mousePressed → N 次 mouseMoved → mouseReleased（松手后等过实现的 700ms 看护窗口） */
    const drag = async (x1, y1, x2, y2, { steps = 10, modifiers = 0, settle = 950 } = {}) => {
      await dismissToolbar();
      await probe('mark()');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, buttons: 0, modifiers });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1, modifiers });
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        await btn(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, 1, { button: 'left', modifiers });
        await sleep(18);
      }
      await btn(x2, y2, 1, { button: 'left', modifiers });
      await sleep(60);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1, modifiers });
      await sleep(settle);
      return probe('result()');
    };
    const fmtSel = (s) =>
      !s
        ? '（无选区）'
        : `${s.nz} 字（起 mid=${s.s?.mid ?? s.a?.mid ?? s.r?.firstMid ?? '?'}，末 mid=${s.e?.mid ?? s.f?.mid ?? s.r?.lastMid ?? '?'}，页[${s.pages.join(',')}]${s.collapsed ? '，已塌陷' : ''}）`;
    const dragReport = (tag, res, note = '') => {
      const rr = res.settled?.r;
      const cov = rr ? `覆盖 ${rr.bands} 条文字带、y ${rr.minTop}~${rr.maxBottom}、rect ${rr.n} 个（末 rect 中心线 ${rr.lastMid}）` : '没有 rect';
      info(
        `[${tag}] 选区变更 ${res.changes} 次，序列 [${res.seq.join(', ')}]（T = 那一刻划词工具条已弹出；最大 ${res.maxNz} 字）｜落定 ${fmtSel(res.settled)}｜${cov}${res.live?.collapsed ? '｜松手后 DOM 选区已塌陷' : ''}${note ? '｜' + note : ''}`,
      );
      const s = res.settled;
      if (s && !s.collapsed) {
        const at = (n) => (n ? `页${n.page} ${n.node} span#${n.idx} mid=${n.mid}「${n.txt}」` : '—');
        info(
          `[${tag}] 锚点 ${at(s.an)} → 焦点 ${at(s.fo)}｜range 起 ${at(s.st)} → 止 ${at(s.en)}｜文字头「${(s.head ?? '').replace(/\n/g, '⏎')}」尾「${(s.tail ?? '').replace(/\n/g, '⏎')}」`,
        );
      }
    };
    /** 切"适宽 / 适页"（真点界面上的按钮，不改数据） */
    const setFit = async (label) => {
      const clicked = await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('button.rd-chip')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
        if (!b) return false;
        b.click();
        return true;
      })()`);
      await sleep(1500);
      return { clicked, zoom: await probe('zoomText()') };
    };
    /** 滚到第 n 页（纯滚动，不碰选区）并等它渲染出来 */
    const gotoPage = async (n) => {
      for (let i = 0; i < 3; i += 1) {
        await probe(`scrollToPage(${n})`);
        await sleep(1300);
        const gg = await probe('geo()');
        const hit = gg.pages.find((p) => p.page === n);
        if (hit) return { geo: gg, rect: hit };
      }
      return null;
    };
    const annList = () =>
      cdp.eval(`(async () => (await window.litshelf.invoke('listAnnotations', [${JSON.stringify(itemId)}])).map((a) => ({ id: a.id, page: a.page, type: a.type, text: a.text, rects: a.rects, createdAt: a.createdAt })))()`);
    const topMargin = 150;
    const bottomLimit = VIEW.h - 40;

    // ================================================================ [1] 普通拖选
    console.log('\n[1] 普通拖选 → 划词工具条 → 高亮落库');
    at('场景1 普通拖选');
    const fit0 = await setFit('适宽'); // 固定成默认阅读缩放，保证每次跑的几何一致
    info(`阅读缩放「适宽」：${fit0.zoom}`);
    // 用正文页：中文期刊 PDF 的第 1 页常是 CNKI 封面（标签/值两栏、文字稀疏），不适合测行手感
    const PAGE = Math.min(2, Math.max(1, item?.pages ?? 1));
    let g = (await gotoPage(PAGE))?.geo ?? (await probe('geo()'));
    let L = await probe(`lines(${PAGE})`);
    ok(!!L && L.lines.length >= 5, `正文页 ${PAGE} 解析出 ${L?.lines?.length ?? 0} 行（逐字 span ${L?.spans ?? 0} 个，共 ${L?.allChars ?? 0} 字，中位行盒高 ${L?.medH}px）`);
    if (!L || L.lines.length < 5) throw new Error('行模型不可用，后续场景无法进行');
    info(`行表（mid:字数）${L.lines.slice(0, 14).map((l) => `${l.mid}:${l.chars}`).join('  ')}`);
    const visLines = (lines) => lines.filter((l) => l.mid > topMargin && l.bottom < bottomLimit);
    let cand = visLines(L.lines);
    ok(cand.length >= 4, `视口内有 ${cand.length} 行可划词（y ∈ ${cand.length ? `${cand[0].mid}~${cand[cand.length - 1].mid}` : '—'}）`);

    let highlight = null;
    if (cand.length >= 4) {
      const i0 = Math.max(0, Math.min(cand.length - 4, Math.round(cand.length * 0.3)));
      const a = cand[i0];
      const c = cand[i0 + 3];
      const x1 = a.left + a.w * 0.1;
      const y1 = a.mid;
      const x2 = c.left + c.w * 0.55;
      const y2 = c.mid;
      const expect = cand.slice(i0, i0 + 4).reduce((n, l) => n + l.chars, 0);
      const before = (await annList()).length;
      const res = await drag(x1, y1, x2, y2);
      dragReport('普通拖选', res, `按下 (${x1.toFixed(0)},${y1.toFixed(0)}) → 松开 (${x2.toFixed(0)},${y2.toFixed(0)})；这 4 行按文本层共 ${expect} 字`);
      const tb = await probe('toolbar()');
      const toolCount = tb.actions.filter((t) => /^(高亮|下划线|波浪线|删除线|批注)$/.test(t)).length;
      ok(tb.present && toolCount >= 4, `真实鼠标拖选后划词工具条出现（${toolCount} 个标注动作：${tb.actions.join(' / ')}）`);
      ok(
        res.settled.nz >= 10 && res.settled.nz <= expect * 2.5 + 40,
        `拖过 3 行的选区字数合理：${res.settled.nz} 字（4 行文本层共 ${expect} 字，本页 ${L.allChars} 字）`,
        fmtSel(res.settled),
      );
      ok(res.settled.pages.length <= 1, `拖选只在页[${res.settled.pages.join(',')}]内`);
      await cdp.shot('01-selection-toolbar.png');

      const btnBox = await probe(`actionButton('高亮')`);
      if (btnBox) {
        await clickAt(btnBox.x, btnBox.y);
      } else {
        info('没找到「高亮」按钮，改用 DOM click');
        await cdp.eval(`(() => { const b=[...document.querySelectorAll('.rd-sel-toolbar button')].find(x=>(x.title||'').trim()==='高亮'); b?.click(); return !!b; })()`);
      }
      await sleep(1500);
      const anns = await annList();
      highlight = anns.slice().sort((p, q) => q.createdAt - p.createdAt)[0] ?? null;
      const annNz = highlight ? highlight.text.replace(/\s+/g, '').length : 0;
      ok(anns.length === before + 1, `点「高亮」后批注落库（宿主 ${before} → ${anns.length} 条）`);
      ok(!!highlight && highlight.rects.length > 0, `批注带 ${highlight?.rects?.length ?? 0} 个相对矩形（第 ${highlight?.page ?? '?'} 页）`);
      ok(annNz >= 10, `落库文字 ${annNz} 字：「${(highlight?.text ?? '').slice(0, 24)}…」`);
      ok(
        annNz > 0 && Math.abs(annNz - res.settled.nz) <= Math.max(3, res.settled.nz * 0.15),
        `落库字数与真实鼠标选区一致（原生 ${res.settled.nz} 字 vs 批注 ${annNz} 字）`,
      );
      ok((await probe('annMarks()')) > 0, `页面上画出了高亮标记（${await probe('annMarks()')} 个节点）`);
      await cdp.shot('02-highlight.png');
      summary.push(`[1] 拖过 3 行 → ${res.settled.nz} 字（4 行文本层共 ${expect} 字），落库 ${annNz} 字，${highlight?.rects?.length ?? 0} 个矩形`);
    }

    // ================================================================ [2] 行间距
    console.log('\n[2] 行间距：指针停在两行之间的空隙里，不能跳到下一行');
    at('场景2 行间距');
    await dismissToolbar();
    cand = visLines(L.lines);
    // 找"空隙最明显"的相邻两行：行中心距最大（且不是跨段落的大跳），两行都要是正文
    let pair = null;
    for (let i = 0; i + 1 < cand.length; i += 1) {
      const p = cand[i];
      const n = cand[i + 1];
      const pitch = n.mid - p.mid;
      if (pitch < 8 || pitch > 45) continue;
      if (p.chars < 15 || n.chars < 15 || p.w < 150 || n.w < 150) continue;
      const score = pitch;
      if (!pair || score > pair.score) pair = { i, p, n, pitch, score, gap: n.top - p.bottom };
    }
    ok(!!pair, pair ? `取到相邻两行：上 ${pair.p.mid}（${pair.p.chars} 字）/ 下 ${pair.n.mid}（${pair.n.chars} 字），行中心距 ${pair.pitch.toFixed(1)}px，span 盒子间空隙 ${pair.gap.toFixed(1)}px` : '找不到合适的相邻两行');
    if (pair) {
      const xa = pair.p.left + pair.p.w * 0.12;
      const xb = pair.p.left + pair.p.w * 0.62;
      const yPress = pair.p.mid;
      const yGap = pair.p.mid + (pair.n.mid - pair.p.mid) * 0.4; // 停在空隙里、离上一行更近（Word 规则：停在更近的那一行）
      const pressBox = await probe(`spanAt(${xa}, ${yPress})`);
      info(`按下点底下：${pressBox.how || '取不到 span'}（mid=${pressBox.box?.mid ?? '?'}，h=${pressBox.box?.h ?? '?'}，元素=${pressBox.hit}）`);
      const resGap = await drag(xa, yPress, xb, yGap);
      dragReport('行间距', resGap, `按下 (${xa.toFixed(0)},${yPress.toFixed(0)}) → 松手 (${xb.toFixed(0)},${yGap.toFixed(1)})，空隙带 ${pair.p.bottom.toFixed(1)}~${pair.n.top.toFixed(1)}`);
      await cdp.shot('03-line-gap.png');
      const endSpan = resGap.settled.e ?? resGap.settled.f;
      const endMid = endSpan?.mid ?? resGap.settled.r?.lastMid ?? null;
      const lineH = Math.max(pressBox.box?.h ?? 0, endSpan?.h ?? 0, L.medH || 10);
      const dMid = endMid != null && pressBox.box ? Math.abs(endMid - pressBox.box.mid) : null;
      const tol = lineH / 2;
      ok(
        dMid != null && dMid < tol,
        `选区内文字位置与按下点在同一行（中心线差 ${dMid ?? '?'}px < 半个行高 ${tol.toFixed(1)}px）`,
        `按下 span mid=${pressBox.box?.mid ?? '?'}｜选区末尾 mid=${endMid ?? '?'}（span mid=${endSpan?.mid ?? '—'} / 末 rect mid=${resGap.settled.r?.lastMid ?? '—'}）「${endSpan?.txt ?? ''}」`,
      );
      ok(
        endMid != null && Math.abs(endMid - pair.p.mid) <= Math.max(3, pair.pitch * 0.45),
        `末尾仍落在按下点那一行（|${endMid ?? '?'} - ${pair.p.mid}| ≤ ${Math.max(3, pair.pitch * 0.45).toFixed(1)}px，按行中心距模型）`,
      );
      const gapNz = resGap.settled.nz;
      ok(resGap.settled.pages.length <= 1, `行间距里拖选不跨页（页[${resGap.settled.pages.join(',')}]）`);
      // 更硬的一条：选区在屏幕上只能覆盖"按下点那一行 + 那点空隙"这点竖直范围
      const rr = resGap.settled.r;
      const spanY = rr ? rr.maxBottom - rr.minTop : null;
      const limitY = Math.max(40, pair.pitch * 1.8);
      ok(
        rr != null && rr.bands <= 3 && spanY <= limitY,
        `选区竖直范围没有暴涨（覆盖 ${spanY ?? '?'}px ≤ ${limitY.toFixed(0)}px、${rr?.bands ?? '?'} 条文字带 ≤ 3）`,
        rr ? `y ${rr.minTop}~${rr.maxBottom}，rect ${rr.n} 个；头「${resGap.settled.head ?? ''}」` : '没有 rect 数据',
      );

      // 对照：同样起止横坐标，但终点真落进下一行的文字 → 应当明显更长
      const resNext = await drag(xa, yPress, xb, pair.n.mid);
      dragReport('对照·吃到下一行', resNext);
      const nextNz = resNext.settled.nz;
      summary.push(`[2] 行间距里拖 → ${gapNz} 字（末 mid=${endMid ?? '?'}）；拖到下一行文字 → ${nextNz} 字`);
      ok(
        gapNz >= 5 && nextNz >= gapNz + 3,
        `行间距里拖选的 ${gapNz} 字明显小于吃到下一行的 ${nextNz} 字（差 ${nextNz - gapNz} 字）`,
      );

      // 镜像再来一次：从行右侧往左下拖进行间距。指针最近的 span 在按下点之后（DOM 顺序），
      // 专门压"按 DOM 顺序拼 range"这条路径——和上面从左往右拖是两种不同的拼接方向。
      const resGap2 = await drag(xb, yPress, xa, yGap);
      dragReport('行间距·从右往左', resGap2, `按下 (${xb.toFixed(0)},${yPress.toFixed(0)}) → 松手 (${xa.toFixed(0)},${yGap.toFixed(1)})`);
      const rr2 = resGap2.settled.r;
      const spanY2 = rr2 ? rr2.maxBottom - rr2.minTop : null;
      const limitY2 = Math.max(40, pair.pitch * 1.8);
      ok(
        rr2 != null && rr2.bands <= 3 && spanY2 <= limitY2,
        `反向（从右往左）拖进行间距也不暴涨（覆盖 ${spanY2 ?? '?'}px ≤ ${limitY2.toFixed(0)}px、${rr2?.bands ?? '?'} 条文字带 ≤ 3）`,
        rr2 ? `y ${rr2.minTop}~${rr2.maxBottom}，rect ${rr2.n} 个；头「${(resGap2.settled.head ?? '').replace(/\n/g, '⏎')}」` : '没有 rect 数据',
      );
      ok(resGap2.settled.pages.length <= 1, `反向拖进行间距不跨页（页[${resGap2.settled.pages.join(',')}]）`);
      summary.push(`[2] 反向（右→左）行间距拖 → ${resGap2.settled.nz} 字、覆盖 ${spanY2 ?? '?'}px/${rr2?.bands ?? '?'} 条文字带`);
    }

    // ================================================================ [3] 拖到空白
    console.log('\n[3] 拖到空白/页外：不能暴涨成整页/整篇，且不跨页');
    at('场景3 拖到空白');
    await dismissToolbar();
    // 切成"适页"：整页都在视口里，"本页空白"和"页外"才有明确坐标
    const fit = await setFit('适页');
    info(`切「适页」：${fit.clicked ? '已点击' : '没找到按钮'}，缩放 ${fit.zoom}`);
    g = (await gotoPage(PAGE))?.geo ?? (await probe('geo()'));
    L = await probe(`lines(${PAGE})`);
    const pageRect = g.pages.find((p) => p.page === PAGE);
    const allLines = L?.lines ?? [];
    const lastLine = allLines[allLines.length - 1];
    info(
      `页 ${PAGE}：top=${pageRect?.top} bottom=${pageRect?.bottom}（整页可见=${!!pageRect && pageRect.top > 40 && pageRect.bottom < VIEW.h - 20}），最后一行 mid=${lastLine?.mid}，本页共 ${L?.allChars} 字`,
    );
    ok(!!pageRect && !!lastLine, `取到第 ${PAGE} 页几何与页末行（页高 ${pageRect ? Math.round(pageRect.h) : '?'}px）`);
    if (pageRect && lastLine) {
      // 按下点：页末行上方约 120px 的那一行 —— "本页剩余字数"远小于 800，而整页/整篇会明显超
      const pressLine = allLines.slice().reverse().find((l) => l.mid >= topMargin && l.mid <= lastLine.mid - 100) ?? null;
      ok(!!pressLine, pressLine ? `起拖行选在页末行上方（mid=${pressLine.mid}，本行 ${pressLine.chars} 字，离页末行 ${(lastLine.mid - pressLine.mid).toFixed(0)}px）` : '页面太矮，找不到合适的起拖行');
      if (pressLine) {
        const x = pressLine.left + pressLine.w * 0.35;
        const yFrom = pressLine.mid;
        const charsBelow = await probe(`charsBelow(${PAGE}, ${yFrom})`);
        const blankY = Math.max(lastLine.bottom + 8, Math.min((lastLine.bottom + pageRect.bottom) / 2, VIEW.h - 10));
        const outsideY = Math.min(VIEW.h - 10, Math.max(pageRect.bottom + 40, lastLine.bottom + 60));
        info(`参照：按下点以下本页还有 ${charsBelow} 字；整页 ${L.allChars} 字；空白区 y=${blankY.toFixed(0)}（页末行底 ${lastLine.bottom}，页底 ${pageRect.bottom}），页外 y=${outsideY.toFixed(0)}`);

        const resBlank = await drag(x, yFrom, x, blankY);
        dragReport('拖到本页空白', resBlank, `松手 y=${blankY.toFixed(1)}`);
        await cdp.shot('04-drag-to-blank.png');
        ok(resBlank.settled.nz > 20, `从正文拖到空白确实选中了文字（${resBlank.settled.nz} 字）`, fmtSel(resBlank.settled));
        ok(resBlank.settled.nz < 800, `从正文拖到本页空白：选区 ${resBlank.settled.nz} 字 < 800（整页 ${L.allChars} 字）`, fmtSel(resBlank.settled));
        ok(
          resBlank.settled.nz <= charsBelow + pressLine.chars + 60,
          `没有越过本页页末（${resBlank.settled.nz} ≤ 本页剩余 ${charsBelow} + 本行 ${pressLine.chars} + 60）`,
        );
        ok(resBlank.settled.pages.length <= 1, `拖到本页空白不跨页（页[${resBlank.settled.pages.join(',')}]）`);
        summary.push(`[3] 拖到本页空白 → ${resBlank.settled.nz} 字（本页剩余 ${charsBelow} 字 / 整页 ${L.allChars} 字），跨页数 ${resBlank.settled.pages.length}`);

        // 页外：一路拖到本页下边界之外（页间灰缝 / 下一页方向）——这条专测"跨页夹回起始页"的安全网
        const resOutside = await drag(x, yFrom, x, outsideY);
        dragReport('拖出页面', resOutside, `松手 y=${outsideY.toFixed(1)}（页底 ${pageRect.bottom}）`);
        ok(resOutside.settled.nz > 20, `拖出页面外确实选中了文字（${resOutside.settled.nz} 字）`, fmtSel(resOutside.settled));
        ok(resOutside.settled.nz < 800, `拖出页面外：选区 ${resOutside.settled.nz} 字 < 800`, fmtSel(resOutside.settled));
        ok(
          resOutside.settled.pages.length <= 1,
          `拖出页面外不跨页（安全网把选区夹回起始页，页[${resOutside.settled.pages.join(',')}]）`,
        );
        summary.push(`[3] 拖出页面 → ${resOutside.settled.nz} 字，跨页数 ${resOutside.settled.pages.length}`);
      }
    }
    const back = await setFit('适宽');
    info(`切回「适宽」：缩放 ${back.zoom}`);

    // ================================================================ [4] 点击已有高亮 → 卡片 → Esc
    console.log('\n[4] 单击已有高亮 → 批注卡片；Esc 只关卡片');
    at('场景4 点击高亮开卡片');
    await dismissToolbar();
    if (highlight && highlight.rects?.length) {
      // 滚回高亮所在的页
      g = (await gotoPage(highlight.page))?.geo ?? (await probe('geo()'));
      const pg = g.pages.find((p) => p.page === highlight.page);
      const r = highlight.rects[0];
      const cx = pg ? pg.left + (r.x + r.w / 2) * pg.w : null;
      const cy = pg ? pg.top + (r.y + r.h / 2) * pg.h : null;
      info(`高亮矩形 → 视口坐标 (${cx?.toFixed(0)}, ${cy?.toFixed(0)})，屏幕内=${cy != null && cy > topMargin && cy < bottomLimit}`);
      if (cx != null && cy != null && cy > topMargin && cy < bottomLimit) {
        await clickAt(cx, cy);
        await sleep(400);
        ok(await probe('cardPresent()'), '单击已有高亮能打开批注卡片');
        await cdp.shot('05-annotation-card.png');
        await esc();
        const after = await cdp.eval('({ card: !!document.querySelector(".rd-ann-card"), pages: document.querySelectorAll(".rd-pdf-page").length })');
        ok(!after.card, '按 Esc 关闭批注卡片');
        ok(after.pages > 0, `按 Esc 没有把阅读器一起关掉（页数 ${after.pages}）`);
      } else {
        ok(false, '单击已有高亮能打开批注卡片', `高亮不在视口内（cy=${cy?.toFixed(0)}），点不到`);
      }
    } else {
      ok(false, '单击已有高亮能打开批注卡片', '前面没造出高亮，无法验证');
    }

    // ================================================================ [5] 反向拖选 + Shift 扩选
    console.log('\n[5] 反方向拖选（从下往上）与 Shift+点击扩选');
    at('场景5 反向拖选与 Shift 扩选');
    await dismissToolbar();
    g = (await gotoPage(PAGE))?.geo ?? (await probe('geo()'));
    L = await probe(`lines(${PAGE})`);
    cand = visLines(L.lines);
    if (cand.length >= 4) {
      const a = cand[1];
      const c = cand[Math.min(cand.length - 1, 4)];
      const xa = a.left + a.w * 0.12;
      const xc = c.left + c.w * 0.6;
      const fwd = await drag(xa, a.mid, xc, c.mid);
      dragReport('正向（上→下）', fwd, `行 mid ${a.mid} → ${c.mid}`);
      const fwdNz = fwd.settled.nz;
      const fwdToolbar = (await probe('toolbar()')).present;
      const rev = await drag(xc, c.mid, xa, a.mid);
      dragReport('反向（下→上）', rev, `行 mid ${c.mid} → ${a.mid}`);
      const revNz = rev.settled.nz;
      const revToolbar = (await probe('toolbar()')).present;
      await cdp.shot('06-reverse-drag.png');
      ok(revNz > 5 && revToolbar, `从下往上拖也能选中（${revNz} 字，工具条${revToolbar ? '出现' : '没出现'}）`, fmtSel(rev.settled));
      ok(
        (rev.settled.a?.mid ?? 0) > (rev.settled.f?.mid ?? 0),
        `反向拖选的锚点在下方（锚点 mid=${rev.settled.a?.mid ?? '?'} > 焦点 mid=${rev.settled.f?.mid ?? '?'}）`,
      );
      ok(
        revNz > 0 && fwdNz > 0 && Math.abs(revNz - fwdNz) <= Math.max(5, fwdNz * 0.35),
        `反向与正向选到的字数相当（反向 ${revNz} vs 正向 ${fwdNz}）`,
      );
      ok(rev.settled.pages.length <= 1, `反向拖选不跨页（页[${rev.settled.pages.join(',')}]）`);
      summary.push(`[5] 反向 ${revNz} 字 / 正向 ${fwdNz} 字，工具条 ${fwdToolbar ? '有' : '无'}/${revToolbar ? '有' : '无'}`);

      // Shift+点击扩选：先单击落一个插入点，再按住 Shift 点远处
      await dismissToolbar();
      await clickAt(xa, a.mid);
      const caretNz = (await probe('sel()')).nz;
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 8, key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
      await probe('mark()');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: xc, y: c.mid, button: 'left', buttons: 1, clickCount: 1, modifiers: 8 });
      await sleep(60);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xc, y: c.mid, button: 'left', buttons: 0, clickCount: 1, modifiers: 8 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
      await sleep(950);
      const sh = await probe('result()');
      dragReport('Shift+点击扩选', sh, `插入点 ${caretNz} 字 → 点到行 mid=${c.mid}`);
      const shNz = sh.settled.nz;
      await cdp.shot('07-shift-click.png');
      ok(shNz > 10, `Shift+点击能扩选（${caretNz} → ${shNz} 字）`, fmtSel(sh.settled));
      ok(
        shNz >= Math.max(5, fwdNz * 0.6),
        `Shift+点击扩选范围接近整段拖选（${shNz} vs 拖选 ${fwdNz} 字）`,
      );
      ok(
        Math.abs((sh.settled.e?.mid ?? 1e9) - c.mid) <= Math.max(3, (L.medH || 12)),
        `Shift+点击的终点落在被点的那一行（末 mid=${sh.settled.e?.mid ?? '?'} vs 行 mid=${c.mid}）`,
      );
      summary.push(`[5] Shift+点击 → ${shNz} 字（终点 mid=${sh.settled.e?.mid ?? '?'} / 目标行 ${c.mid}）`);
    } else {
      ok(false, '反向拖选与 Shift+点击扩选', `视口内只有 ${cand.length} 行，不够用`);
    }

    // ================================================================ 收尾
    console.log('\n[6] 收尾');
    const srcAfter = await dirFingerprint(SRC_LIB);
    ok(srcAfter === srcBefore, `用户论文目录没被改动（${srcBefore.split('\n').length} 个文件的 size/mtime 全部一致，只读）`);
    const errs = cdp.errors.filter((e) => !/DevTools|Autofill|Electron Security|beforeunload/i.test(e));
    ok(errs.length === 0, `渲染层零错误（console.error / 未捕获异常，${errs.length} 条）`, errs.slice(0, 2).join(' | '));
    const warns = cdp.warnings.filter((w) => !/Electron Security/i.test(w));
    info(`渲染层告警 ${warns.length} 条（不计失败，pdf.js 字体/Electron 安全提示属正常）：${warns.slice(-2).join(' | ') || '（无）'}`);
    if (textLayerFlakes) info(`ℹ 已知间歇问题：本轮有 ${textLayerFlakes} 次"画布已渲染但文本层 30 秒没挂上"（known-issues P1，已带自愈），未计入失败`);

    if (summary.length) {
      console.log('\n关键数据汇总：');
      for (const s of summary) console.log(`  · ${s}`);
    }
  } finally {
    try {
      const now = (await fs.readdir(path.join(ROOT, 'dist', 'renderer', 'assets'))).sort().join(',');
      if (buildSig && now !== buildSig) info('⚠⚠ 跑的过程中 dist 被重新构建了（有并发 build）：本次结果不可信，请重跑');
    } catch {
      /* ignore */
    }
    if (failures && step) info(`失败时停在步骤：${step}`);
    if (cdp?.errors?.length) info(`渲染层错误（最近 4 条）：${cdp.errors.slice(-4).join(' | ')}`);
    if (failures && cdp?.debug?.length) info(`渲染层日志（尾 6 条）：${cdp.debug.slice(-6).join(' | ')}`);
    if (session?.logs?.length) {
      const tail = session.logs.filter((l) => l.trim()).slice(-6);
      if (tail.length) info(`应用输出（尾 6 行）：${tail.map((l) => l.trim()).join(' ⏎ ')}`);
    }
    cdp?.close();
    child?.kill();
    await sleep(800);
    killPid(child?.pid, '本次实例主进程');
    for (const pid of pidsOnPort(PORT)) killPid(pid, `仍占着 ${PORT} 端口的进程`);
    // 只清"本次开跑前就存在"的残留 electron（同目录单实例锁才会撞），别人刚起的实例不动
    const still = electronPids().filter((pid) => leftovers.includes(pid));
    for (const pid of still) killPid(pid, '开跑前就在的残留 electron');
    const remain = electronPids();
    if (remain.length) info(`注意：仍有 ${remain.length} 个 electron 进程在跑（pid ${remain.join(',')}）——不是本次遗留，没动它们`);
  }

  console.log(`\n${failures ? `❌ 划词手感验收失败 ${failures} 项` : '✅ 划词手感验收全部通过'}`);
  console.log(`截图：${SHOTS}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error('划词手感验收异常：', err);
  process.exit(1);
});

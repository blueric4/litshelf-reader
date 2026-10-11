/**
 * 渲染 / 文本层生命周期稳定性压力回归（A 方案回归网）
 *
 * 压的是什么：`docs/known-issues.md` P1 #1 —— "打开某篇论文长时间空白、文本层一个 span 都不挂"。
 * 根因方向是渲染生命周期没对齐 pdf.js 上游：render 任务不 cancel / cancel 后不重建、
 * 文本层被反复重挂（缩放时重挂几百个 span 的那条路）。
 * Lead 的 A 方案：`RenderTask.cancel()` + 捕获 `AbortException` 后重建；文本层每页只建一次、
 * 缩放时按 `--scale-factor` 重建（不反复重挂）。这个脚本就是它的"改前会翻车、改后不翻车"证据。
 *
 * 覆盖（对应 task-12 的 5 类必测场景）：
 *   [1] 反复开关同一篇 12 轮：每轮 8 秒内必须挂上文本层，逐轮记耗时
 *   [1b] 恶意变体：开→300ms 内就关（在首屏渲染/文本层在飞时 cancel）+ 首屏渲染期间连打缩放
 *   [2] 连续快速缩放：Ctrl+= / Ctrl+- 交替 ≥10 次、间隔 ~120ms；几何自洽 + 无 render 冲突报错
 *   [3] 快速滚动跨多页 + 跳到最后页 + 回第 2 页：8 秒内出文本层、骨架屏不能常驻
 *   [4] 连续切换论文 6 次（A→B→A→C→B→A）：每次 8 秒内可用，渲染层 console.error/异常为 0
 *   [5] 资源不泄漏：canvas 数 ≤ 当前渲染集合 + 2、文本层容器与页一一对应、反复重建不增长
 *   [6] 收尾：用户论文目录 size/mtime 未变（只读）、构建产物跑动期间没被换掉
 *
 * 数据隔离：把真实论文库**只读复制**到 tmp/stability-acceptance-library，
 * 再用 LITSHELF_DATA_DIR 指向 tmp/stability-acceptance-data 起独立实例。
 * 真实目录用 `LITSHELF_SRC_LIB` 指定（默认 `~/Desktop/文献`），全程只读，末尾校验 size/mtime。
 *
 * 用法：node tools/acceptance-stability.mjs
 * 输出：每条断言一行 ✓/✗；失败打印关键数据与 console 原文；末尾"通过 x / 失败 y" + 退出码。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = process.cwd();
// 与 acceptance.mjs(9222) / acceptance-cjk.mjs(9111) / acceptance-selection.mjs(9333) / acceptance-ux.mjs(9444) 都错开
const PORT = 9555;
const DATA = path.join(ROOT, 'tmp', 'stability-acceptance-data');
const LIB = path.join(ROOT, 'tmp', 'stability-acceptance-library');
const SHOTS = path.join(ROOT, 'tmp', 'shots-stability');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
/** 真实文献目录（只读采样）：用 LITSHELF_SRC_LIB 指定；默认是家目录下的通用位置 */
const SRC_LIB = process.env.LITSHELF_SRC_LIB || path.join(os.homedir(), 'Desktop', '文献');
const VIEW = { w: 1440, h: 900 };
/** 一轮里"文本层算挂上了"的门槛：一个 span 都不挂是故障，挂上至少 5 个即认为文本层起来了 */
const READY_SPANS = 5;
/** 每轮的最长等待（task-12 规定 N=8） */
const ROUND_TIMEOUT = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let checks = 0;

function ok(cond, label, extra = '') {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
}
function info(label) {
  console.log(`   ℹ ${label}`);
}
function bad(label, extra = '') {
  checks += 1;
  failures += 1;
  console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
}
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;

// ---------------------------------------------------------------- 进程工具（只清自己开的实例，别人在跑就等）

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
        const d = m.params.exceptionDetails;
        this.errors.push(`[exception] ${d?.exception?.description ?? d?.text ?? ''}`);
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
        if (m.params.type === 'error') this.errors.push(`[error] ${text}`);
        else if (m.params.type === 'warning') this.warnings.push(`[warning] ${text}`);
        else this.debug.push(`[${m.params.type}] ${text}`);
        if (this.debug.length > 120) this.debug.shift();
      }
      if (m.method === 'Log.entryAdded') {
        if (m.params.entry.level === 'error') this.errors.push(`[log] ${m.params.entry.text}`);
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
      const timeout = method === 'Page.captureScreenshot' ? 15000 : method === 'Runtime.evaluate' ? 30000 : 20000;
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时 ${method}`));
        }
      }, timeout);
    });
  }

  /** 发出去不等应答（Esc / 滚轮 / 按键这类偶尔不回包的输入） */
  fire(method, params = {}) {
    const id = (this.id += 1);
    this.ws.send(JSON.stringify({ id, method, params }));
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`页面异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }

  /** 当前错误游标：用于"这一段流程里有没有新报错" */
  mark() {
    return this.errors.length;
  }

  async shot(name) {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
      info(`截图 tmp/shots-stability/${name}`);
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

// ---------------------------------------------------------------- 页面侧探针（只观察，不改产品状态）

/**
 * 注入渲染层的探针：读页/画布/文本层/骨架屏/滚动的真实状态。
 * 用函数源码注入（`pageProbe.toString()`），避免模板字符串里的反斜杠转义踩坑。
 * 另外挂 window.onerror / unhandledrejection 收集"页面自己报的错"，收尾和 CDP 的日志合并。
 */
function pageProbe() {
  const V = 3;
  if (window.__stabh && window.__stabh.v === V) return window.__stabh.v;

  const round = (v) => Math.round(v * 10) / 10;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const pageEl = (n) => document.querySelector(`.rd-pdf-page[data-page-index="${n}"]`);
  const scrollEl = () => document.querySelector('.rd-pdf-scroll');
  const pagesAll = () =>
    [...document.querySelectorAll('.rd-pdf-page')].sort(
      (a, b) => Number(a.dataset.pageIndex) - Number(b.dataset.pageIndex),
    );

  const perr = [];
  window.addEventListener('error', (e) => {
    perr.push(`[window.onerror] ${e.message || ''} @${e.filename || ''}:${e.lineno || 0}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    perr.push(`[unhandledrejection] ${r && r.name ? `${r.name}: ${r.message}` : String(r)}`);
  });

  const api = {
    v: V,
    /** 一页的渲染状态快照 */
    page(n) {
      const el = pageEl(n);
      const cv = el ? el.querySelector('canvas.rd-pdf-canvas') : null;
      const txt = el ? el.querySelector('.rd-pdf-text') : null;
      const cs = cv ? getComputedStyle(cv) : null;
      const pr = el ? el.getBoundingClientRect() : null;
      const tsfRaw = el ? getComputedStyle(el).getPropertyValue('--total-scale-factor').trim() : '';
      const hs = [];
      if (txt) {
        for (const sp of txt.querySelectorAll('span')) {
          const r = sp.getBoundingClientRect();
          if (r.height > 0.5 && (sp.textContent || '').trim()) hs.push(r.height);
        }
      }
      hs.sort((a, b) => a - b);
      return {
        page: n,
        present: !!el,
        spans: txt ? txt.querySelectorAll('span').length : 0,
        textChildren: txt ? txt.children.length : 0,
        canvases: el ? el.querySelectorAll('canvas').length : 0,
        canvasW: cs ? Math.round((parseFloat(cs.width) || 0) * 10) / 10 : 0,
        canvasH: cs ? Math.round((parseFloat(cs.height) || 0) * 10) / 10 : 0,
        boxW: pr ? round(pr.width) : 0,
        boxH: pr ? round(pr.height) : 0,
        top: pr ? round(pr.top) : 0,
        bottom: pr ? round(pr.bottom) : 0,
        tsf: tsfRaw ? num(tsfRaw) : null,
        tsfRaw,
        skeleton: el ? !!el.querySelector('.rd-page-skeleton') : false,
        medSpanH: hs.length ? Math.round(hs[Math.floor(hs.length / 2)] * 10) / 10 : 0,
        spanCount: hs.length,
      };
    },
    /** 所有已挂载页的快照 */
    pages() {
      return pagesAll().map((el) => api.page(Number(el.dataset.pageIndex)));
    },
    /** 整屏状态：页/画布/骨架/文本层容器/缩放标签/滚动 */
    state() {
      const s = scrollEl();
      return {
        stage: !!document.querySelector('.rd-pdf-stage'),
        pages: document.querySelectorAll('.rd-pdf-page').length,
        pageIdx: pagesAll().map((el) => Number(el.dataset.pageIndex)),
        slots: document.querySelectorAll('.rd-page-slot').length,
        ghosts: document.querySelectorAll('.rd-page-ghost').length,
        canvases: document.querySelectorAll('canvas').length,
        pdfCanvases: document.querySelectorAll('canvas.rd-pdf-canvas').length,
        texts: document.querySelectorAll('.rd-pdf-text').length,
        skeletons: document.querySelectorAll('.rd-page-skeleton').length,
        spans: document.querySelectorAll('.rd-pdf-text span').length,
        loadingCard: !!document.querySelector('.rd-loading-card'),
        notice: (document.querySelector('.rd-notice') || {}).textContent || '',
        zoom: (document.querySelector('.rd-zoom-value') || {}).textContent || '',
        pageInput: (document.querySelector('.rd-page-input') || {}).value || '',
        pageTotal: (document.querySelector('.rd-page-total') || {}).textContent || '',
        scroll: s ? { top: Math.round(s.scrollTop), h: s.clientHeight, sh: s.scrollHeight } : null,
        heapMB:
          typeof performance !== 'undefined' && performance.memory
            ? Math.round(performance.memory.usedJSHeapSize / 1048576)
            : null,
        body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 70),
      };
    },
    /** 一次往返同时拿到"当前页 + 它的文本层状态"（轮询用，省 CDP 往返） */
    current() {
      const cp = api.centerPage();
      const p = cp.page != null ? api.page(cp.page) : null;
      const input = (document.querySelector('.rd-page-input') || {}).value || '';
      return { center: cp, input, page: p };
    },
    /** 视口中心落在哪一页（比"最后一个可见页"可靠） */
    centerPage() {
      const s = scrollEl();
      const y = s ? s.getBoundingClientRect().top + s.clientHeight / 2 : window.innerHeight / 2;
      let best = null;
      for (const el of pagesAll()) {
        const r = el.getBoundingClientRect();
        const hit = r.top <= y && r.bottom >= y;
        const d = Math.min(Math.abs(r.top - y), Math.abs(r.bottom - y));
        if (hit) return { page: Number(el.dataset.pageIndex), how: 'contains-center' };
        if (!best || d < best.d) best = { page: Number(el.dataset.pageIndex), d: Math.round(d), how: 'nearest' };
      }
      return best ?? { page: null, how: 'none' };
    },
    /** 文本框在页里的几何自洽：最长的中文 span 的"每字宽 / font-size"应接近 1 */
    fontGeom(n) {
      const el = pageEl(n);
      const txt = el ? el.querySelector('.rd-pdf-text') : null;
      if (!txt) return null;
      let best = null;
      for (const sp of txt.querySelectorAll('span')) {
        const t = sp.textContent || '';
        const cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
        if (cjk < 4) continue;
        const r = sp.getBoundingClientRect();
        if (r.width < 8) continue;
        // 字号取**这个 span 自己的**（pdf.js 把字号写在 span 上，容器是默认 16px，取容器会算出假的比值）
        const fs = parseFloat(getComputedStyle(sp).fontSize) || 0;
        if (!best || cjk > best.cjk) best = { cjk, w: r.width, h: r.height, t: t.slice(0, 10), fs };
      }
      if (!best) return null;
      const fs = best.fs;
      return {
        page: n,
        text: best.t,
        cjk: best.cjk,
        perChar: Math.round((best.w / best.cjk) * 100) / 100,
        fontSize: Math.round(fs * 100) / 100,
        ratio: Math.round((best.w / best.cjk / Math.max(0.01, fs)) * 100) / 100,
      };
    },
    /** 某个选择器的中心点（真鼠标点击用） */
    boxOf(sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    },
    has(sel) {
      return !!document.querySelector(sel);
    },
    /** 故障注入的状态（见用例 [7]：把 pdf.js 的一次 render/getTextContent 变成"永不 settle"） */
    inj() {
      const j = window.__stabInj;
      return j ? { kind: j.kind, target: j.target, hits: j.hits(), armed: j.armed(), how: j.how } : null;
    },
    unhang() {
      if (!window.__stabInj) return false;
      window.__stabInj.undo();
      window.__stabInj = null;
      return true;
    },
    pageErrors() {
      return perr.slice(-40);
    },
    clearPageErrors() {
      perr.length = 0;
      return true;
    },
  };
  window.__stabh = api;
  return V;
}

const PROBE_SRC = `(${pageProbe.toString()})()`;

// ---------------------------------------------------------------- 构建指纹 / 源码新鲜度

async function buildFingerprint() {
  const assetsDir = path.join(ROOT, 'dist', 'renderer', 'assets');
  const assets = (await fs.readdir(assetsDir)).sort();
  const js = assets.filter((f) => f.endsWith('.js') && !f.startsWith('lib-'))[0] ?? assets.filter((f) => f.endsWith('.js'))[0];
  const full = path.join(assetsDir, js);
  const st = await fs.stat(full);
  const buf = await fs.readFile(full);
  const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
  const text = buf.toString('utf8');
  const markers = {
    '整页重挂(改前看门狗)': text.includes('整页重挂'),
    '文本层始终为空': text.includes('文本层始终为空'),
    '原地更新失败': text.includes('原地更新失败'),
    '同一个 canvas': text.includes('same canvas during multiple render'),
    AbortException: text.includes('AbortException'),
    'total-scale-factor': text.includes('total-scale-factor'),
  };
  // 源码新鲜度：reader 目录里最新改动时间 vs 产物时间
  const readerDir = path.join(ROOT, 'src', 'renderer', 'reader');
  let newest = { file: '', mtime: new Date(0) };
  for (const f of await fs.readdir(readerDir)) {
    const s = await fs.stat(path.join(readerDir, f));
    if (s.mtime > newest.mtime) newest = { file: f, mtime: s.mtime };
  }
  const mainDir = path.join(ROOT, 'src', 'main');
  for (const f of await fs.readdir(mainDir).catch(() => [])) {
    const s = await fs.stat(path.join(mainDir, f)).catch(() => null);
    if (s && s.mtime > newest.mtime) newest = { file: `main/${f}`, mtime: s.mtime };
  }
  return { js, size: st.size, mtime: st.mtime, sha, markers, newest, assets: assets.length, git: gitInfo() };
}

/**
 * 构建来源旁证（只读 git 查询）：HEAD 版本 + 工作区 PdfViewer.tsx 是否被改过。
 * 基线流程是"切回 HEAD → build"，所以这里能和 dist 指纹互相印证"测的到底是哪一版"。
 */
function gitInfo() {
  try {
    const head = sh('git', ['rev-parse', '--short', 'HEAD']).trim().split(/\r?\n/)[0] || '?';
    const st = sh('git', ['status', '--porcelain', '--', 'src/renderer/reader/PdfViewer.tsx']).trim();
    return { head, pdfViewer: st ? `已修改（${st.slice(0, 24)}）` : '未修改' };
  } catch {
    return { head: '?', pdfViewer: '未知' };
  }
}

// ---------------------------------------------------------------- 启动 / 数据准备

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

/** 从真实论文库**只读复制**到隔离目录；按体积升序返回（小的先跑，重页放最后当压力源） */
async function copyLibrary() {
  const all = (await fs.readdir(SRC_LIB)).filter((f) => f.toLowerCase().endsWith('.pdf'));
  const listed = [];
  for (const name of all) {
    const st = await fs.stat(path.join(SRC_LIB, name));
    listed.push({ name, size: st.size });
  }
  listed.sort((a, b) => a.size - b.size);
  await fs.mkdir(LIB, { recursive: true });
  // 只复制 4 篇：A/B/C 用于切换，D（最重的一篇）当压力源；少几篇能让隔离库的解析更快
  const picked = [...listed.slice(0, 3), listed[listed.length - 1]].filter(
    (v, i, arr) => arr.findIndex((x) => x.name === v.name) === i,
  );
  for (const f of picked) await fs.copyFile(path.join(SRC_LIB, f.name), path.join(LIB, f.name));
  return picked.map((f) => f);
}

async function dirFingerprint(dir) {
  const out = [];
  for (const name of (await fs.readdir(dir)).sort()) {
    const st = await fs.stat(path.join(dir, name));
    out.push(`${name}|${st.size}|${Math.round(st.mtimeMs)}`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- main

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  await fs.rm(DATA, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(LIB, { recursive: true, force: true }).catch(() => undefined);

  console.log('渲染/文本层生命周期稳定性压力回归（A 方案：cancel + AbortException 重建）');
  console.log(`  隔离数据目录：${DATA}`);
  console.log(`  论文副本目录：${LIB}（从真实库只读复制）`);

  let buildSig = '';
  let fp = null;
  try {
    fp = await buildFingerprint();
    buildSig = `${fp.js}|${fp.size}|${fp.sha}`;
    info(`构建指纹：dist/renderer/assets/${fp.js}｜大小 ${fp.size}B｜时间 ${fp.mtime.toLocaleString('zh-CN')}｜sha256:${fp.sha}`);
    info(`构建来源旁证：git HEAD=${fp.git.head}，工作区 src/renderer/reader/PdfViewer.tsx ${fp.git.pdfViewer}`);
    info(`硬化标记（在产物 JS 里探测）：${Object.entries(fp.markers).map(([k, v]) => `${k}=${v ? '有' : '无'}`).join('  ')}`);
    if (fp.newest.mtime > fp.mtime) {
      info(`⚠ 源码比产物新：${fp.newest.file} = ${fp.newest.mtime.toLocaleString('zh-CN')} → 先跑 node scripts/build.mjs，否则测的是旧代码`);
    } else {
      info(`源码不新于产物（最新：${fp.newest.file} ${fp.newest.mtime.toLocaleString('zh-CN')}）`);
    }
  } catch (err) {
    info(`读构建指纹失败：${err.message}`);
  }

  const srcBefore = await dirFingerprint(SRC_LIB);
  const picked = await copyLibrary();
  ok(picked.length >= 3, `已从真实论文库只读复制 ${picked.length} 篇到隔离目录`);
  for (const p of picked) info(`  · ${p.name}（${(p.size / 1048576).toFixed(2)}MB）`);

  // 单实例锁纪律：别人在跑 Electron 就先等（最多 120s），别把别人的实例搅了
  let waited = 0;
  for (;;) {
    const others = electronPids().filter((pid) => !pidsOnPort(PORT).includes(pid));
    if (!others.length) break;
    if (waited === 0) info(`发现 ${others.length} 个别的 electron 实例在跑（pid ${others.join(',')}），等它们结束…`);
    if (waited >= 120000) {
      info(`⚠ 等了 ${sec(waited)} 仍有别的 electron 在跑，带着风险继续（数据目录已隔离）`);
      break;
    }
    await sleep(5000);
    waited += 5000;
  }
  for (const pid of pidsOnPort(PORT)) killPid(pid, `上次跑剩下来占着 ${PORT} 端口的实例`);

  let session = null;
  let cdp = null;
  let child = null;
  const leftovers = electronPids();
  const summary = [];
  const roundsMs = [];
  const canvasPerRound = [];
  let step = 'launch';
  const at = (s) => {
    step = s;
    info(`… ${s}`);
  };
  /** 需要恢复时：关掉阅读器再打开（等于换一个文档/worker），最多重试 2 次 */
  let recover = async () => false;

  try {
    session = await launch();
    cdp = session.cdp;
    child = session.child;
    at('已连上渲染层，等首屏 + 跳过引导页 + 注入探针');
    await sleep(3000);
    const skipped = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('跳过'));
      if (!b) return 'no-onboarding';
      b.click();
      return 'skipped';
    })()`);
    info(`引导页：${skipped}`);
    await sleep(800);
    await cdp.eval(PROBE_SRC);
    await cdp.eval('window.__stabh.clearPageErrors()');
    /**
     * 读探针。`undefined` 只会在"探针没注入"时出现（页面被整体 reload 之类），
     * 这时补注入一次再读，避免后续断言因为探针丢了而集体假红。
     */
    const probe = async (expr) => {
      const v = await cdp.eval(`(window.__stabh ? window.__stabh.${expr} : undefined)`);
      if (v === undefined) {
        await cdp.eval(PROBE_SRC);
        return cdp.eval(`window.__stabh.${expr}`);
      }
      return v;
    };
    const stateOf = () => probe('state()');
    /** 等骨架屏退干净（最多 timeout）：正常渲染本来就要几百 ms，不能一看到骨架屏就判失败 */
    const waitSkeletonClear = async (timeout = 8000, poll = 200) => {
      const t0 = Date.now();
      let st = await stateOf();
      while (st.skeletons > 0 && Date.now() - t0 < timeout) {
        await sleep(poll);
        st = await stateOf();
      }
      return { ms: Date.now() - t0, st };
    };
    /**
     * 盯"画布已画好、但文本层一个 span 都不挂"这个 P1 症状（known-issues P1 #1 的原话）。
     * 注意不能瞬时判：代码里 `setPainted(true)` 在挂文本层**之前**，所以刚画完到文本层挂上之间
     * 本来就有几百 ms 的合法空窗。这里要求"连续 dwellMs 都是这个坏状态"才算抓到。
     */
    const blankWatch = async ({ windowMs = 6000, dwellMs = 3000, poll = 200 } = {}) => {
      const since = new Map();
      const t0 = Date.now();
      while (Date.now() - t0 < windowMs) {
        const ps = await probe('pages()').catch(() => []);
        const now = Date.now();
        const seen = new Set();
        for (const p of ps) {
          if (!p?.present) continue;
          seen.add(p.page);
          if (!p.skeleton && p.spans === 0) {
            if (!since.has(p.page)) since.set(p.page, now);
          } else {
            since.delete(p.page);
          }
        }
        for (const k of [...since.keys()]) if (!seen.has(k)) since.delete(k);
        await sleep(poll);
      }
      const now = Date.now();
      return [...since.entries()].filter(([, t]) => now - t >= dwellMs).map(([page, t]) => ({ page, blankMs: now - t }));
    };

    at('添加文献库并等解析完成');
    await cdp.eval(`(async () => { await window.litshelf.invoke('addRoot', [${JSON.stringify(LIB)}, { depth: 2 }]); return true; })()`);
    let snapItems = [];
    for (let i = 0; i < 80; i += 1) {
      snapItems = await cdp.eval(`(async () => (await window.litshelf.invoke('getSnapshot', [])).items.map((x) => ({ id: x.id, name: x.name, pages: x.pageCount, state: x.parseState })))()`);
      if (snapItems.length >= picked.length && snapItems.every((x) => x.state !== 'placeholder')) break;
      await sleep(500);
    }
    ok(snapItems.length >= 3, `隔离库里出现 ${snapItems.length} 篇文献（解析状态：${snapItems.map((x) => x.state).join('/')}）`);
    const ready = snapItems.filter((x) => x.state === 'ready');
    ok(ready.length >= 3, `${ready.length} 篇解析完成`);
    for (const it of snapItems) info(`  · ${it.name.slice(0, 26)}（${it.pages} 页，${it.state}）`);
    if (ready.length < 3) throw new Error('隔离库里解析完成的论文不足 3 篇，后续场景无法进行');

    // 场景用的 3 篇：A/B（小的两篇）+ C=最重的一篇；D 与 C 同篇，只作为最重的压力源再点名一次
    const byName = (n) => snapItems.find((x) => x.name === n) ?? null;
    const A = byName(picked[0].name);
    const B = byName(picked[1].name);
    const HEAVY = byName(picked[picked.length - 1].name) ?? byName(picked[2].name);
    const C = HEAVY;
    if (!A || !B || !C) throw new Error('隔离库里没凑齐 3 篇用于切换的论文');
    info(`场景用篇：A=${A?.name.slice(0, 18)}…（${A?.pages}页）｜B=${B?.name.slice(0, 18)}…（${B?.pages}页）｜C=${C?.name.slice(0, 18)}…（${C?.pages}页）`);
    info(`压力篇：D=${HEAVY?.name.slice(0, 18)}…（${HEAVY?.pages}页，体积最大）`);

    // ---------------------------------------------------------------- 输入原语
    const setSearch = async (text) => {
      const focused = await cdp.eval(`(() => {
        const el = document.getElementById('litshelf-search');
        if (!el) return false;
        el.focus();
        el.select();
        return true;
      })()`);
      if (!focused) return false;
      await cdp.send('Input.insertText', { text });
      await sleep(600);
      return true;
    };
    const rowText = async () =>
      cdp.eval(`(async () => {
        const rows = [...document.querySelectorAll('.row')];
        return rows.slice(0, 4).map((r) => (r.textContent || '').replace(/\\s+/g, ' ').slice(0, 24));
      })()`);
    const dblclickRow = async (prefix) =>
      cdp.eval(`(() => {
        const rows = [...document.querySelectorAll('.row')];
        const r = rows.find((x) => (x.textContent || '').includes(${JSON.stringify(prefix)}));
        if (!r) return false;
        r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return true;
      })()`);
    const clickBack = async () => {
      const hit = await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').includes('返回'));
        if (!b) return false;
        b.click();
        return true;
      })()`);
      for (let i = 0; i < 30; i += 1) {
        const st = await stateOf();
        if (!st.stage && st.canvases === 0) return { hit, ms: i * 150 };
        await sleep(150);
      }
      return { hit, ms: 4500, timeout: true };
    };
    /**
     * "文本层挂上了"的判据（比"有 ≥5 个 span"严得多）：
     *   ① 该页骨架屏已消失（= canvas 这一轮真的画完了，`painted=true`）；
     *   ② 该页 span 数 ≥ READY_SPANS；
     *   ③ span 数在 ≥250ms 内不再变化 —— pdf.js 的文本层会分批挂（MAX_TEXT_DIVS_TO_RENDER），
     *      一看到几个 span 就宣布"好了"会把"挂到一半"当成成功（改前基线第一版就是这么漏判的）。
     */
    let maxPageSpans = 0;
    const waitReady = async (page, timeout = ROUND_TIMEOUT, poll = 150) => {
      const t0 = Date.now();
      let st = null;
      let prevCount = -1;
      let stableSince = Date.now();
      for (;;) {
        st = await probe(`page(${page})`).catch(() => null);
        if (st?.present) {
          if (st.spans > maxPageSpans) maxPageSpans = st.spans;
          if (st.spans !== prevCount) {
            prevCount = st.spans;
            stableSince = Date.now();
          }
          if (!st.skeleton && st.spans >= READY_SPANS && Date.now() - stableSince >= 250) {
            return { ms: Date.now() - t0, st, timeout: false };
          }
        } else {
          prevCount = -1;
          stableSince = Date.now();
        }
        if (Date.now() - t0 >= timeout) return { ms: Date.now() - t0, st, timeout: true };
        await sleep(poll);
      }
    };
    /**
     * 等"视口中心那一页"文本层挂上（滚动场景用）。判据同 waitReady。
     * 关键：每一轮都重新取中心页——滚动的惯性/自动对齐会让当前页在等待期间变掉，
     * 钉死一个页码会误报"8 秒没挂上"。
     */
    const waitReadyCurrent = async (timeout = ROUND_TIMEOUT, poll = 150) => {
      const t0 = Date.now();
      let snap = null;
      let p = null;
      let prevCount = -1;
      let prevPage = null;
      let stableSince = Date.now();
      for (;;) {
        snap = await probe('current()').catch(() => null);
        p = snap?.page ?? null;
        if (p?.present) {
          if (p.spans > maxPageSpans) maxPageSpans = p.spans;
          if (p.spans !== prevCount || p.page !== prevPage) {
            prevCount = p.spans;
            prevPage = p.page;
            stableSince = Date.now();
          }
          if (!p.skeleton && p.spans >= READY_SPANS && Date.now() - stableSince >= 250) {
            return { ms: Date.now() - t0, st: p, center: snap.center, input: snap.input, timeout: false };
          }
        } else {
          prevCount = -1;
          prevPage = null;
          stableSince = Date.now();
        }
        if (Date.now() - t0 >= timeout) {
          return { ms: Date.now() - t0, st: p, center: snap?.center ?? null, input: snap?.input ?? '', timeout: true };
        }
        await sleep(poll);
      }
    };
    /**
     * 打开一篇的"前半段"：确保在列表页 → 搜索 → 双击行。
     * 两步都带一次重试：回列表后的首帧、搜索防抖都可能让第一次摸空，
     * 那不是产品故障，不该记成"文本层没挂上"。
     */
    const openRow = async (item) => {
      if (!(await probe('has("#litshelf-search")'))) await clickBack();
      const prefix = item.name.replace(/\.pdf$/i, '').slice(0, 10);
      let focused = await setSearch(prefix);
      if (!focused) {
        await sleep(700);
        focused = await setSearch(prefix);
      }
      if (!focused) return { opened: false, why: '搜索框不在 DOM 里（没能回到文献列表）' };
      let clicked = await dblclickRow(item.name.slice(0, 10));
      if (!clicked) {
        await sleep(500);
        clicked = await dblclickRow(item.name.slice(0, 10));
      }
      if (!clicked) return { opened: false, why: `列表里没有匹配「${prefix}」的行（当前行：${(await rowText()).join(' / ')}）` };
      return { opened: true, why: '' };
    };
    /**
     * 打开一篇并等"视口中心那一页"文本层挂上。
     * 不钉死第 1 页：软件会恢复上次阅读位置，钉死页码会把"正常恢复"误判成"文本层没挂上"。
     */
    const openPaper = async (item, timeout = ROUND_TIMEOUT) => {
      const pre = await openRow(item);
      if (!pre.opened) return { clicked: false, why: pre.why, ms: 0, timeout: true, st: null, page: null };
      const r = await waitReadyCurrent(timeout);
      return { clicked: true, why: '', ms: r.ms, st: r.st, page: r.center?.page ?? null, timeout: r.timeout };
    };
    recover = async (item) => {
      for (let i = 0; i < 2; i += 1) {
        await clickBack();
        const r = await openPaper(item);
        if (!r.timeout) return true;
        info(`恢复尝试 ${i + 1} 失败（${r.ms}ms）`);
      }
      return false;
    };
    /** 真键盘：Ctrl + = / - （与 ReaderView 的缩放快捷键一致） */
    const zoomKey = async (up) => {
      const key = up ? '=' : '-';
      const code = up ? 'Equal' : 'Minus';
      const vk = up ? 187 : 189;
      cdp.fire('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await sleep(25);
      cdp.fire('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    };
    const blurActive = () => cdp.eval(`(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return true; })()`);
    /**
     * 推一档缩放，并**确认真的动了**（缩放档位有上下限：已经 400% 时 Ctrl+= 是空操作，
     * 那样 effect 不会重跑、注入也不会命中）。先试 preferUp，没动就试另一个方向。
     */
    const zoomStep = async (preferUp = true) => {
      for (const up of preferUp ? [true, false] : [false, true]) {
        const before = (await stateOf()).zoom;
        await zoomKey(up);
        await sleep(700); // 覆盖 160ms 防抖 + 标签更新
        const after = (await stateOf()).zoom;
        if (after !== before) return { up, before, after, changed: true };
      }
      return { up: null, before: null, after: null, changed: false };
    };
    const wheel = async (dy, x = VIEW.w / 2, y = VIEW.h / 2, gap = 60) => {
      cdp.fire('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
      await sleep(gap);
    };
    /** 在页码输入框里真打字跳页 */
    const jumpTo = async (n) => {
      const box = await probe(`boxOf('.rd-page-input')`);
      if (!box) return false;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(40);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(120);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await cdp.send('Input.insertText', { text: String(n) });
      await sleep(80);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(200);
      return true;
    };
    /** 报错过滤：Electron/DevTools 自带噪音不算产品问题 */
    const noise = (e) => /DevTools|Autofill|Electron Security|beforeunload|favicon|net::ERR_|Failed to load resource/i.test(e);
    const newErrors = (mark) => cdp.errors.slice(mark).filter((e) => !noise(e));
    const errDigest = (mark) => {
      const list = newErrors(mark);
      return { n: list.length, head: list.slice(0, 3), text: list.join(' | ').slice(0, 400) };
    };

    // ================================================================ [1] 反复开关同一篇 ×12
    console.log(`\n[1] 反复开关同一篇 ×12（每轮 ${ROUND_TIMEOUT / 1000}s 内必须挂上文本层）`);
    at('场景1 反复开关');
    const roundDetail = [];
    for (let r = 1; r <= 12; r += 1) {
      const mark = cdp.mark();
      const opened = await openPaper(A);
      const st = opened.st ? await stateOf() : null;
      const errs = errDigest(mark);
      roundsMs.push(opened.ms);
      canvasPerRound.push(st?.canvases ?? 0);
      const detail = `第 ${opened.page ?? '?'} 页 span=${opened.st?.spans ?? 0} 画布=${st?.canvases ?? 0} 页=${st?.pages ?? 0} 骨架=${st?.skeletons ?? 0}`;
      if (opened.timeout) {
        roundDetail.push({ r, ms: opened.ms, spans: opened.st?.spans ?? 0, canvases: st?.canvases ?? 0 });
        ok(false, `第 ${r} 轮：${sec(opened.ms)} 内文本层未挂上（${detail}）`, `console:${errs.text || '（无）'}｜首页文字：${(st?.body ?? '').slice(0, 40)}`);
        await cdp.shot(`01-round-${r}-stall.png`);
        const back = await clickBack();
        info(`第 ${r} 轮失败后收尾：${back.timeout ? '关阅读器也超时' : `已回到列表（${back.ms}ms）`}`);
        if (r < 12) await recover(A);
        continue;
      }
      roundDetail.push({ r, ms: opened.ms, spans: opened.st?.spans ?? 0, canvases: st?.canvases ?? 0 });
      ok(true, `第 ${r} 轮：${opened.ms}ms 挂上文本层（${detail}）${errs.n ? `｜⚠ 新报错 ${errs.n} 条` : ''}`);
      await sleep(120);
      const back = await clickBack();
      if (back.timeout) info(`⚠ 第 ${r} 轮关阅读器超时（${back.ms}ms）`);
      await sleep(150);
    }
    const okRounds = roundDetail.filter((x) => x.ms <= ROUND_TIMEOUT && x.spans >= READY_SPANS).length;
    const times = roundDetail.map((x) => x.ms).sort((a, b) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)] : 0;
    ok(
      okRounds === 12,
      `12 轮全部在 ${ROUND_TIMEOUT / 1000}s 内挂上文本层（${okRounds}/12；最快 ${times[0] ?? '?'}ms / 最慢 ${times[times.length - 1] ?? '?'}ms / 中位 ${median}ms）`,
      roundDetail.map((x) => `#${x.r}:${x.ms}ms/${x.spans}span`).join(' '),
    );
    ok(
      roundDetail.every((x) => x.spans >= READY_SPANS),
      `每轮都真的挂上了文本层（各轮 span：${roundDetail.map((x) => x.spans).join('/')}）`,
      '（"单页能挂到上千个 span"的总量校验放在 [6]，那时已经跑过 14 页的重页）',
    );
    summary.push(`[1] 12 轮开关：${okRounds}/12 成功，耗时 ${times.map((t) => `${t}`).join('/')}ms`);

    // ================================================================ [1c] 压力篇反复开关
    console.log(`\n[1c] 压力篇（${HEAVY.pages} 页）反复开关 ×6`);
    at('场景1c 压力篇反复开关');
    const heavyRounds = [];
    for (let r = 1; r <= 6; r += 1) {
      const opened = await openPaper(HEAVY);
      heavyRounds.push({ r, ms: opened.ms, spans: opened.st?.spans ?? 0, timeout: opened.timeout });
      if (opened.timeout) {
        const st = await stateOf();
        ok(false, `压力篇第 ${r} 轮：${sec(opened.ms)} 内未回到完整态`, `span=${opened.st?.spans ?? 0} 骨架=${opened.st?.skeleton} 页=${st.pages} 画布=${st.canvases}`);
        await cdp.shot(`01c-heavy-round-${r}-stall.png`);
        await clickBack();
        await recover(HEAVY);
        continue;
      }
      ok(true, `压力篇第 ${r} 轮：${opened.ms}ms 完整挂上（span=${opened.st?.spans ?? 0}）`);
      await sleep(150);
      await clickBack();
      await sleep(150);
    }
    const heavyOK = heavyRounds.filter((x) => !x.timeout).length;
    ok(heavyOK === 6, `压力篇 6 轮全部在 ${ROUND_TIMEOUT / 1000}s 内完整挂上（${heavyOK}/6；${heavyRounds.map((x) => `${x.ms}ms`).join('/')}）`);
    summary.push(`[1c] 压力篇 6 轮：${heavyOK}/6，耗时 ${heavyRounds.map((x) => x.ms).join('/')}ms`);

    // ================================================================ [1b] 恶意变体：在飞时 cancel
    console.log('\n[1b] 恶意变体：开→300ms 内就关（渲染/文本层在飞时取消）×6，然后要求能正常打开');
    at('场景1b 快速开关');
    let quickFail = 0;
    for (let r = 1; r <= 6; r += 1) {
      const pre = await openRow(A);
      if (!pre.opened) {
        quickFail += 1;
        info(`第 ${r} 次快速开关没能打开：${pre.why}`);
        continue;
      }
      await sleep(300);
      const st = await stateOf();
      const back = await clickBack();
      info(`第 ${r} 次：打开后 300ms 状态 页=${st.pages} 画布=${st.canvases} span=${st.spans}｜关闭${back.timeout ? '超时' : ` ${back.ms}ms`}`);
      await sleep(120);
    }
    const afterQuick = await openPaper(A);
    ok(
      !afterQuick.timeout,
      `6 次"渲染中秒关"之后仍能正常打开（${afterQuick.ms}ms，span=${afterQuick.st?.spans ?? 0}）`,
      afterQuick.timeout ? '8s 内没挂上文本层 —— 疑似 cancel 后 worker/文档卡住' : '',
    );
    if (afterQuick.timeout) {
      await cdp.shot('01b-after-quick-close-stall.png');
      await recover(A);
    }
    await clickBack();
    summary.push(`[1b] 6 次秒关后打开：${afterQuick.timeout ? `✗ ${afterQuick.ms}ms 未挂上` : `✓ ${afterQuick.ms}ms`}`);

    // ================================================================ [2] 首屏渲染期间连打缩放
    console.log('\n[2] 连续快速缩放（Ctrl+= / Ctrl+- 交替 ≥10 次，间隔 ~120ms）');
    at('场景2a 首屏渲染期间连打缩放');
    const zoomBurst = await (async () => {
      const mark = cdp.mark();
      const pre = await openRow(A);
      if (!pre.opened) return { clicked: false, why: pre.why };
      // 等阅读器挂上（不等文本层）：一出现 .rd-pdf-page 就开始打缩放，专压"首屏渲染在飞时 cancel"
      for (let i = 0; i < 40; i += 1) {
        const st = await stateOf().catch(() => null);
        if (st?.stage && st.pages > 0) break;
        await sleep(50);
      }
      await blurActive();
      for (let i = 0; i < 6; i += 1) {
        await zoomKey(i % 2 === 0);
        await sleep(60);
      }
      const r = await waitReadyCurrent(ROUND_TIMEOUT);
      return { clicked: true, ...r, errs: errDigest(mark) };
    })();
    ok(
      zoomBurst.clicked && !zoomBurst.timeout,
      `首屏渲染期间连打 6 次缩放后，文本层仍在 ${ROUND_TIMEOUT / 1000}s 内挂上（${zoomBurst.ms ?? '?'}ms，span=${zoomBurst.st?.spans ?? 0}）`,
      !zoomBurst.clicked
        ? zoomBurst.why
        : zoomBurst.timeout
          ? `8s 未挂上：span=${zoomBurst.st?.spans ?? 0} 画布=${zoomBurst.st?.canvases ?? 0}｜console:${zoomBurst.errs?.text || '（无）'}`
          : '',
    );
    if (zoomBurst.timeout) {
      await cdp.shot('02-zoom-burst-stall.png');
      await recover(A);
    }

    at('场景2b 连续快速缩放 ≥10 次（间隔 ~120ms）并校验几何自洽');
    // 先确保处于一个稳定状态：关掉再打开（干净文档），缩放到"适宽"基准
    await clickBack();
    const base = await openPaper(A);
    if (base.timeout) {
      ok(false, '缩放场景起点：文档能正常打开', `8s 未挂上（span=${base.st?.spans ?? 0}）`);
      await recover(A);
    } else {
      ok(true, `缩放场景起点：文本层就绪（${base.ms}ms，span=${base.st?.spans ?? 0}）`);
    }
    await sleep(1200);
    const zoomMark = cdp.mark();
    const beforePages = (await probe('pages()')).filter((p) => p.present);
    const beforeZoomText = (await stateOf()).zoom;
    await blurActive();
    const ZOOM_N = 11; // 单数：+,-,+ … 收在"比起点高一档"，这样几何自洽检查不是自己比自己
    for (let i = 0; i < ZOOM_N; i += 1) {
      await zoomKey(i % 2 === 0);
      await sleep(120);
    }
    await sleep(1600); // 等防抖（160ms）+ 重绘落定
    const zoomErrs = errDigest(zoomMark);
    const afterPages = (await probe('pages()')).filter((p) => p.present);
    const afterState = await stateOf();
    const cur = (await probe('centerPage()')).page;
    const target = cur ?? 1;
    const before = beforePages.find((p) => p.page === target) ?? beforePages[0] ?? null;
    const after = afterPages.find((p) => p.page === target) ?? afterPages[0] ?? null;
    const spansAfter = after?.spans ?? 0;
    ok(
      !!after && spansAfter >= READY_SPANS,
      `快速缩放结束后第 ${target} 页文本层存在（span=${spansAfter}，缩放标签 ${beforeZoomText} → ${afterState.zoom}）`,
      after ? '' : `页 ${target} 不在渲染集合里（当前渲染 ${afterPages.map((p) => p.page).join(',')}）`,
    );
    /**
     * 自洽检查必须比**同一页**缩放前后：高倍缩放时 renderSet 会缩到 2 页，
     * 拿不同页（页面尺寸未必相同）比会得出假结论，所以取"前后都在渲染集合里"的那一页。
     */
    let pair = null;
    for (const a of afterPages) {
      const b = beforePages.find((x) => x.page === a.page);
      if (!b || !a.canvasW || !b.canvasW || !a.tsf || !b.tsf) continue;
      if (a.page === target) {
        pair = { a, b };
        break;
      }
      if (!pair) pair = { a, b };
    }
    const pa = pair?.a ?? null;
    const pb = pair?.b ?? null;
    // --total-scale-factor 必须与画布尺寸自洽：tsf 就是画布用的 renderScale → canvasW ≈ baseW * tsf
    if (pa && pb) {
      const ratioCanvas = pa.canvasW / pb.canvasW;
      const ratioTsf = pa.tsf / pb.tsf;
      const errPct = Math.abs(ratioCanvas - ratioTsf) / Math.max(0.0001, ratioTsf);
      ok(
        errPct <= 0.03,
        `--total-scale-factor 与画布尺寸自洽（画布比 ${ratioCanvas.toFixed(3)} vs tsf 比 ${ratioTsf.toFixed(3)}，偏差 ${(errPct * 100).toFixed(2)}% ≤ 3%）`,
        `第 ${pa.page} 页：tsf ${pb.tsf}→${pa.tsf}，画布宽 ${pb.canvasW}→${pa.canvasW}`,
      );
      const baseW = pb.canvasW / pb.tsf;
      const expectW = baseW * pa.tsf;
      ok(
        Math.abs(expectW - pa.canvasW) <= 2,
        `画布 CSS 宽度等于 baseW×tsf（期望 ${expectW.toFixed(1)}px，实际 ${pa.canvasW}px，差 ${Math.abs(expectW - pa.canvasW).toFixed(1)}px ≤ 2px）`,
        `baseW=${baseW.toFixed(2)}（由缩放前 tsf=${pb.tsf}、画布宽 ${pb.canvasW} 推得）`,
      );
      ok(
        Math.abs(pa.boxW - pa.canvasW) <= 2.5,
        `停手后页盒子宽与画布宽一致（盒子 ${pa.boxW}px vs 画布 ${pa.canvasW}px）`,
      );
      // 文本层是否真的按新比例重建：span 中位高度之比应 ≈ tsf 之比
      if (pb.medSpanH && pa.medSpanH) {
        const hRatio = pa.medSpanH / pb.medSpanH;
        const dPct = Math.abs(hRatio - ratioTsf) / Math.max(0.0001, ratioTsf);
        ok(
          dPct <= 0.12,
          `文本层按新比例重建（span 中位高比 ${hRatio.toFixed(3)} vs tsf 比 ${ratioTsf.toFixed(3)}，偏差 ${(dPct * 100).toFixed(1)}% ≤ 12%）`,
          `中位 span 高 ${pb.medSpanH}px → ${pa.medSpanH}px`,
        );
      } else {
        info(`跳过"文本层按新比例重建"检查：中位 span 高取不到（before=${pb.medSpanH} after=${pa.medSpanH}）`);
      }
    } else {
      ok(false, '--total-scale-factor 与画布尺寸自洽', `缩放前后没有同一页可比：before=${beforePages.map((p) => `${p.page}:${p.tsf}/${p.canvasW}`).join(' ')}｜after=${afterPages.map((p) => `${p.page}:${p.tsf}/${p.canvasW}`).join(' ')}`);
    }
    const fontG = await probe(`fontGeom(${target})`);
    if (fontG) {
      ok(
        fontG.ratio >= 0.6 && fontG.ratio <= 1.8,
        `缩放到 ${afterState.zoom} 后中文逐字几何仍自洽（每字宽/字号 = ${fontG.ratio}，字号 ${fontG.fontSize}px）`,
        `样本「${fontG.text}」${fontG.cjk} 字 / 每字 ${fontG.perChar}px`,
      );
    } else {
      info('取不到中文 span 样本，跳过几何自洽检查');
    }
    const zoomErrHit = newErrors(zoomMark).filter((e) => /same canvas|multiple render|AbortException|RenderingCancelled|文本层/i.test(e));
    ok(
      zoomErrHit.length === 0,
      `快速缩放期间没有 render/canvas 冲突与文本层报错（${zoomErrHit.length} 条）`,
      zoomErrHit.slice(0, 3).join(' | '),
    );
    const sk2 = await waitSkeletonClear(6000);
    ok(
      sk2.st.skeletons === 0,
      `缩放后骨架屏退干净（等 ${sk2.ms}ms 后剩 ${sk2.st.skeletons} 个；渲染页 ${sk2.st.pageIdx.join(',')}）`,
      sk2.st.skeletons ? `页=${sk2.st.pages} 画布=${sk2.st.canvases}` : '',
    );
    if (zoomErrs.n) info(`这一段的其它渲染层报错 ${zoomErrs.n} 条：${zoomErrs.text.slice(0, 240)}`);
    summary.push(
      `[2] 缩放 ${ZOOM_N} 次：${beforeZoomText}→${afterState.zoom}，第 ${target} 页 span=${spansAfter}，tsf ${before?.tsf ?? '?'}→${after?.tsf ?? '?'}，报错 ${newErrors(zoomMark).length} 条`,
    );

    // 慢速变体：间隔 320ms（> 160ms 防抖），每一档都真正落定重绘一次 —— 专压"每档都重建一次文本层"
    at('场景2c 慢速连缩 6 档（每档都落定重绘）');
    const mark2c = cdp.mark();
    const spansPerStep = [];
    for (let i = 0; i < 6; i += 1) {
      await zoomKey(i % 2 === 0);
      await sleep(420);
      const c = await probe('current()');
      spansPerStep.push(`${(await stateOf()).zoom}:${c.page?.spans ?? -1}`);
    }
    await sleep(900);
    const st2c = await stateOf();
    const cur2c = await probe('current()');
    ok(
      (cur2c.page?.spans ?? 0) >= READY_SPANS,
      `慢速连缩 6 档后当前页文本层仍在（第 ${cur2c.center?.page} 页 span=${cur2c.page?.spans ?? 0}，缩放 ${st2c.zoom}）`,
      `逐档 span：${spansPerStep.join(' → ')}`,
    );
    const errs2c = errDigest(mark2c);
    ok(errs2c.n === 0, `慢速连缩期间渲染层零报错（${errs2c.n} 条）`, errs2c.text);
    summary.push(`[2c] 慢速连缩 6 档：逐档 span ${spansPerStep.join(' → ')}`);

    // [2d] 压力篇首屏渲染期间连打 12 次缩放（40ms 间隔）：把"渲染在飞 + 缩放风暴"叠到 14 页的重页上
    at('场景2d 压力篇首屏渲染期间连打 12 次缩放（40ms 间隔）');
    await clickBack();
    const heavyBurst = await (async () => {
      const mark = cdp.mark();
      const pre = await openRow(HEAVY);
      if (!pre.opened) return { clicked: false, why: pre.why };
      for (let i = 0; i < 60; i += 1) {
        const st = await stateOf().catch(() => null);
        if (st?.stage && st.pages > 0) break;
        await sleep(40);
      }
      await blurActive();
      for (let i = 0; i < 12; i += 1) {
        await zoomKey(i % 2 === 0);
        await sleep(40);
      }
      const r = await waitReadyCurrent(ROUND_TIMEOUT);
      return { clicked: true, ...r, errs: errDigest(mark) };
    })();
    ok(
      heavyBurst.clicked && !heavyBurst.timeout,
      `压力篇首屏渲染期间连打 12 次缩放后仍在 ${ROUND_TIMEOUT / 1000}s 内回到完整态（${heavyBurst.ms ?? '?'}ms，第 ${heavyBurst.center?.page} 页 span=${heavyBurst.st?.spans ?? 0}）`,
      !heavyBurst.clicked
        ? heavyBurst.why
        : heavyBurst.timeout
          ? `8s 未回到完整态：span=${heavyBurst.st?.spans ?? 0} 骨架=${heavyBurst.st?.skeleton} 画布=${heavyBurst.st?.canvases ?? 0}｜console:${heavyBurst.errs?.text || '（无）'}`
          : '',
    );
    const errs2dReal = newErrors(0).filter((e) => /same canvas|multiple render|AbortException|RenderingCancelled|文本层/i.test(e));
    info(`缩放风暴期间 render/文本层类报错累计 ${errs2dReal.length} 条：${errs2dReal.slice(-2).join(' | ') || '（无）'}`);
    if (heavyBurst.timeout) {
      await cdp.shot('02d-heavy-zoom-storm-stall.png');
      await recover(HEAVY);
    } else {
      await clickBack();
    }
    summary.push(`[2d] 压力篇缩放风暴 12 次：${heavyBurst.timeout ? '✗ 未恢复' : `✓ ${heavyBurst.ms}ms`}`);

    // ================================================================ [3] 快速滚动跨多页 + 跳页
    console.log('\n[3] 快速滚动跨多页 + 跳到最后页 + 回第 2 页');
    at('场景3 快速滚动与跳页（换到最重的一篇，文本层 span 最多）');
    await clickBack();
    const heavyOpen = await openPaper(HEAVY);
    ok(
      !heavyOpen.timeout,
      `压力篇《${HEAVY.name.slice(0, 16)}…》（${HEAVY.pages} 页）能打开（${heavyOpen.ms}ms，span=${heavyOpen.st?.spans ?? 0}）`,
      heavyOpen.timeout ? `8s 未挂上：span=${heavyOpen.st?.spans ?? 0}` : '',
    );
    if (heavyOpen.timeout) {
      await cdp.shot('03-heavy-open-stall.png');
      await recover(HEAVY);
    }
    const scrollTotal = Number(((await stateOf()).pageTotal || '').replace(/\D/g, '')) || HEAVY.pages || 1;
    const lastPage = Math.max(2, scrollTotal);
    const mark3 = cdp.mark();
    // 3a 真实滚轮：8 次 × 大 delta，间隔 60ms → 跨多页
    for (let i = 0; i < 8; i += 1) await wheel(1400);
    const r3a = await waitReadyCurrent(ROUND_TIMEOUT);
    const p3a = r3a.center?.page ?? null;
    ok(
      !r3a.timeout,
      `快速滚动跨页后当前页（第 ${p3a} 页）在 ${ROUND_TIMEOUT / 1000}s 内出现文本层（${r3a.ms}ms，span=${r3a.st?.spans ?? 0}）`,
      r3a.timeout ? `span=${r3a.st?.spans ?? 0} 画布=${r3a.st?.canvases ?? 0} 骨架=${r3a.st?.skeleton} 页码框=${r3a.input}` : '',
    );
    if (r3a.timeout) await cdp.shot('03a-scroll-stall.png');
    // 3b 跳到最后页
    const jumpedLast = await jumpTo(lastPage);
    const r3b = await waitReadyCurrent(ROUND_TIMEOUT);
    const st3b = await stateOf();
    const p3b = r3b.center?.page ?? null;
    ok(
      jumpedLast && !r3b.timeout && p3b !== null && Math.abs(p3b - lastPage) <= 1,
      `跳到最后页（第 ${lastPage} 页）后 ${ROUND_TIMEOUT / 1000}s 内出现文本层（${r3b.ms}ms，第 ${p3b} 页 span=${r3b.st?.spans ?? 0}，页码框=${st3b.pageInput}）`,
      r3b.timeout ? `span=${r3b.st?.spans ?? 0} 骨架=${r3b.st?.skeleton} 页码框=${st3b.pageInput}` : `跳页后中心页是 ${p3b}（期望 ${lastPage}±1）`,
    );
    if (r3b.timeout) await cdp.shot('03b-lastpage-stall.png');
    // 3c 回到第 2 页
    const jumped2 = await jumpTo(2);
    const r3c = await waitReadyCurrent(ROUND_TIMEOUT);
    const st3c = await stateOf();
    const p3c = r3c.center?.page ?? null;
    ok(
      jumped2 && !r3c.timeout && p3c !== null && Math.abs(p3c - 2) <= 1,
      `跳回第 2 页后 ${ROUND_TIMEOUT / 1000}s 内出现文本层（${r3c.ms}ms，第 ${p3c} 页 span=${r3c.st?.spans ?? 0}）`,
      r3c.timeout ? `span=${r3c.st?.spans ?? 0} 骨架=${r3c.st?.skeleton}` : `跳页后中心页是 ${p3c}（期望 2±1）`,
    );
    if (r3c.timeout) await cdp.shot('03c-back-stall.png');
    await sleep(1200);
    const st3 = (await waitSkeletonClear(8000)).st;
    const badPages = (await probe('pages()')).filter((p) => p.spans < READY_SPANS).map((p) => `${p.page}(span=${p.spans})`);
    ok(
      st3.skeletons === 0,
      `滚完/跳完没有骨架屏常驻（骨架屏 ${st3.skeletons} 个，渲染页 ${st3.pageIdx.join(',')}，0 个才算干净）`,
      st3.skeletons ? `页=${st3.pages} 画布=${st3.canvases} 文本层不足的页=${badPages.join(',')}` : '',
    );
    ok(st3.spans >= READY_SPANS, `整屏还有可用文本层（span 合计 ${st3.spans}）`);
    const errs3 = errDigest(mark3);
    ok(errs3.n === 0, `滚动/跳页这一段渲染层零报错（${errs3.n} 条）`, errs3.text);
    summary.push(`[3] 滚动跨页→第${p3a}页 ${r3a.ms}ms；跳最后页(${lastPage})→第${p3b}页 ${r3b.ms}ms；回第2页→第${p3c}页 ${r3c.ms}ms；骨架屏 ${st3.skeletons}`);

    // [3d] 跳页风暴：在重页里连续乱跳 10 次，然后盯"画布画好但文本层一挂不上"的页
    at('场景3d 跳页风暴 ×10（80ms 间隔）');
    const mark3d = cdp.mark();
    for (let i = 0; i < 10; i += 1) {
      const target = 1 + ((i * 5 + 3) % Math.max(1, lastPage));
      await jumpTo(target);
      await sleep(80);
    }
    const r3d = await waitReadyCurrent(ROUND_TIMEOUT);
    ok(
      !r3d.timeout,
      `跳页风暴后当前页（第 ${r3d.center?.page} 页）在 ${ROUND_TIMEOUT / 1000}s 内回到完整态（${r3d.ms}ms，span=${r3d.st?.spans ?? 0}）`,
      r3d.timeout ? `span=${r3d.st?.spans ?? 0} 骨架=${r3d.st?.skeleton} 画布=${r3d.st?.canvases ?? 0}` : '',
    );
    if (r3d.timeout) await cdp.shot('03d-jump-storm-stall.png');
    const blanks3d = await blankWatch({ windowMs: 6000, dwellMs: 3000 });
    ok(
      blanks3d.length === 0,
      `跳页风暴后没有"画布已画好、文本层一个 span 都不挂"的页（持续 ≥3s 的页数 ${blanks3d.length}）`,
      blanks3d.map((b) => `第 ${b.page} 页空了 ${b.blankMs}ms`).join('；'),
    );
    const errs3d = errDigest(mark3d);
    ok(errs3d.n === 0, `跳页风暴这一段渲染层零报错（${errs3d.n} 条）`, errs3d.text);
    summary.push(`[3d] 跳页风暴 10 次：${r3d.timeout ? '✗ 未恢复' : `✓ ${r3d.ms}ms`}；坏状态页 ${blanks3d.length}`);

    // ================================================================ [4] 连续切换论文 6 次
    console.log('\n[4] 连续切换论文 6 次（A→B→A→C→B→A）');
    at('场景4 连续切换');
    const seq = [A, B, A, C, B, A]; // C = 最重的一篇（与 [3] 同一篇，作为压力源）
    const mark4 = cdp.mark();
    const switchMs = [];
    for (let i = 0; i < seq.length; i += 1) {
      const it = seq[i];
      const back = await clickBack();
      if (back.timeout) info(`切换 ${i + 1}：回列表超时（${back.ms}ms）`);
      const r = await openPaper(it);
      switchMs.push({ i: i + 1, name: it.name.slice(0, 12), ms: r.ms, spans: r.st?.spans ?? 0, timeout: r.timeout });
      if (r.timeout) {
        await cdp.shot(`04-switch-${i + 1}-stall.png`);
        const st = await stateOf();
        bad(
          `第 ${i + 1} 次切换（→${it.name.slice(0, 12)}…）：${ROUND_TIMEOUT / 1000}s 内文本层未挂上`,
          `span=${st.spans} 页=${st.pages} 画布=${st.canvases} 骨架=${st.skeletons} 首页文字：${st.body.slice(0, 36)}`,
        );
        await recover(it);
        continue;
      }
      ok(true, `第 ${i + 1} 次切换（→${it.name.slice(0, 12)}…，${it.pages}页）：${r.ms}ms 挂上文本层（span=${r.st?.spans ?? 0}）`);
      await sleep(300);
    }
    const errs4 = errDigest(mark4);
    const switchOK = switchMs.filter((x) => !x.timeout).length;
    ok(switchOK === 6, `6 次切换全部在 ${ROUND_TIMEOUT / 1000}s 内可用（${switchOK}/6）`, switchMs.map((x) => `#${x.i}:${x.ms}ms`).join(' '));
    ok(errs4.n === 0, `连续切换期间渲染层 console.error/异常为 0（实际 ${errs4.n} 条）`, errs4.text);
    const readerWarns = cdp.warnings.filter((w) => /文本层|重建|渲染失败|canvas|Abort/i.test(w));
    info(`切换期间的阅读器相关告警 ${readerWarns.length} 条：${readerWarns.slice(-2).join(' | ') || '（无）'}`);
    summary.push(`[4] 6 次切换：${switchOK}/6，耗时 ${switchMs.map((x) => `${x.ms}`).join('/')}ms，报错 ${errs4.n} 条`);

    // ================================================================ [5] 资源不泄漏
    console.log('\n[5] 资源不泄漏（canvas / 文本层容器 / 渲染集合 / 反复重建不增长）');
    at('场景5 泄漏检查');
    const st5 = await stateOf();
    ok(
      st5.canvases <= st5.pages + 2,
      `canvas 数不超过"当前渲染集合 + 2"（canvas ${st5.canvases} 个，渲染页 ${st5.pages} 个：${st5.pageIdx.join(',')}）`,
      st5.canvases > st5.pages + 2 ? '疑似有已卸载页的画布没回收' : '',
    );
    ok(
      st5.pdfCanvases === st5.pages && st5.texts === st5.pages,
      `每个渲染页恰好 1 个画布 + 1 个文本层容器（页 ${st5.pages} / 画布 ${st5.pdfCanvases} / 文本层 ${st5.texts}）`,
    );
    ok(
      st5.pages <= 3,
      `渲染集合被限制住（同时挂载 ${st5.pages} 页 ≤ 3，符合 renderSet 上限）`,
      st5.pages > 3 ? `挂载页 ${st5.pageIdx.join(',')}` : '',
    );
    const slots5 = st5.slots;
    const total5 = Number((st5.pageTotal || '').replace(/\D/g, '')) || null;
    ok(
      total5 === null || slots5 === total5,
      `页槽数量等于文档总页数（槽 ${slots5} 个 vs 总页 ${total5 ?? '?'}）`,
      total5 !== null && slots5 !== total5 ? '切换文档后可能有上一份文档的页槽残留' : '',
    );
    const firstCanvases = Math.max(...canvasPerRound.slice(0, 3));
    const lastCanvases = Math.max(...canvasPerRound.slice(-3));
    ok(
      lastCanvases <= firstCanvases + 2,
      `12 轮开关后画布数没有增长（前 3 轮最多 ${firstCanvases} 个，后 3 轮最多 ${lastCanvases} 个）`,
      `逐轮画布数：${canvasPerRound.join(',')}`,
    );
    const pageErrs = await cdp.eval('window.__stabh.pageErrors()');
    const workerHit = [...newErrors(0), ...(pageErrs ?? [])].filter((e) => /pdfjs|worker|Worker|AbortException|RenderingCancelled|same canvas/i.test(e));
    ok(
      workerHit.length === 0,
      `pdf.js worker 全程未抛错（命中 ${workerHit.length} 条）`,
      workerHit.slice(0, 3).join(' | '),
    );
    info(`JS 堆占用（仅参考，不作为断言）：${st5.heapMB ?? '?'}MB`);
    summary.push(`[5] canvas ${st5.canvases}/渲染页 ${st5.pages}/文本层 ${st5.texts}/骨架 ${st5.skeletons}；画布数前3轮 ${firstCanvases} → 后3轮 ${lastCanvases}`);

    // ================================================================ [7] 故障注入：pdf.js 的 promise 永不 settle
    /**
     * 为什么要注入：
     *   P1 #1 的根因是"pdf.js 的 getPage/render 悬挂"——promise **既不 resolve 也不 reject**。
     *   这种故障在开发态靠流量压力打不出来（改前构建跑完 [1]~[5] 全绿，见基线报告），
     *   只能把根因本身合成出来：让某一次 `page.render()` 返回一个永不 settle 的任务。
     *   两版都挨同样一击，比的就不是"运气"，而是"有没有超时兜底"：
     *     改前：`await prevTaskRef.current` 裸等 → 该页**永久**停在"白画布 + 骨架屏 + 旧文本层"；
     *          而且看门狗会因为"容器里还有旧 span"直接放弃（`textRef.current?.querySelector('span')` 为真）。
     *     硬化：`withTimeout(prevTaskRef.current, 3000, cancel)` → 3 秒后取消并继续 → 重新渲染成功。
     *   这是**合成故障**（故障注入），不是自然复现；自然压力那 5 类的结果另外单列。
     */
    console.log('\n[7] 故障注入：把 pdf.js 的一次 page.render() 变成"永不 settle"（合成 P1 根因，两版同一击）');
    at('场景7a 渲染任务永不 settle → 8s 内必须靠超时自愈');
    await clickBack();
    const injBase = await openPaper(A);
    ok(!injBase.timeout, `注入前先把文档打到完整态（${injBase.ms}ms，第 ${injBase.page} 页 span=${injBase.st?.spans ?? 0}）`);
    const injPage = injBase.page ?? 1;
    let sevenTimeout = null;
    const injected = await cdp.eval(`(async () => {
      const out = { ok: false, why: '', proto: '' };
      const el = document.querySelector('.rd-pdf-page') || document.querySelector('.rd-pdf-scroll') || document.querySelector('.rd-pdf-stage');
      if (!el) { out.why = '阅读器 DOM 不在（没有 .rd-pdf-page/.rd-pdf-scroll）'; return out; }
      const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
      if (!k) { out.why = 'DOM 节点上没有 __reactFiber$ 键'; return out; }
      let doc = null;
      let f = el[k];
      for (let i = 0; f && i < 120; i += 1) {
        const p = f.memoizedProps;
        if (p && p.doc && typeof p.doc.getPage === 'function') { doc = p.doc; break; }
        f = f.return;
      }
      if (!doc) { out.why = '沿 React fiber 树没找到 props.doc'; return out; }
      let page;
      try { page = await doc.getPage(${injPage}); } catch (err) { out.why = 'doc.getPage 失败：' + (err && err.message); return out; }
      const proto = Object.getPrototypeOf(page);
      if (typeof proto.render !== 'function') { out.why = 'PDFPageProxy.prototype.render 不是函数'; return out; }
      if (window.__stabInj) window.__stabInj.undo();
      const orig = proto.render;
      const state = { armed: true, hits: [] };
      proto.render = function (...args) {
        if (state.armed && this.pageNumber === ${injPage}) {
          state.armed = false;
          state.hits.push({ page: this.pageNumber, t: Date.now() });
          return { promise: new Promise(() => {}), cancel() {}, separateAnnots: false };
        }
        return orig.apply(this, args);
      };
      window.__stabInj = {
        kind: 'render', target: ${injPage}, how: (proto.constructor && proto.constructor.name) || '?',
        hits: () => state.hits.slice(), armed: () => state.armed, undo() { proto.render = orig; },
      };
      out.ok = true;
      out.proto = (proto.constructor && proto.constructor.name) || '?';
      return out;
    })()`);
    ok(
      injected.ok,
      `注入生效：第 ${injPage} 页的下一次 page.render() 永不 settle（cancel() 也无效）`,
      injected.ok ? `prototype=${injected.proto}` : `注入没生效：${injected.why}`,
    );
    if (!injected.ok) {
      ok(false, '[7] 注入无效 → 这一项不成立（需要改注入方式）', injected.why);
    } else {
      let hits = 0;
      let lastDir = true;
      for (let attempt = 1; attempt <= 3 && hits === 0; attempt += 1) {
        const z = await zoomStep(attempt % 2 === 1);
        if (z.changed) lastDir = z.up;
        hits = ((await probe('inj()'))?.hits ?? []).length;
        info(`第 ${attempt} 次缩放（${z.before}→${z.after}${z.changed ? '' : '，没动！'}）之后，注入命中渲染调用 ${hits} 次`);
      }
      ok(hits >= 1, `注入确实打在了渲染调用上（命中 ${hits} 次）`, hits ? '' : '一次都没命中 → 这一项不成立');
      // 再推一档缩放（反方向，保证一定生效）：新一代 effect 会去等那个永不 settle 的渲染任务
      const z2 = await zoomStep(!lastDir);
      info(`第二次缩放：${z2.before}→${z2.after}（${z2.changed ? '已生效' : '没动，这一项不成立'}）`);
      const r7 = await waitReady(injPage, ROUND_TIMEOUT);
      sevenTimeout = r7.timeout;
      const st7 = await probe(`page(${injPage})`);
      ok(
        !r7.timeout,
        `渲染任务卡死后，第 ${injPage} 页在 ${ROUND_TIMEOUT / 1000}s 内恢复"骨架屏消失 + 文本层挂上"（${r7.ms}ms，span=${r7.st?.spans ?? 0}）`,
        r7.timeout
          ? `8s 未恢复：骨架屏=${st7?.skeleton} span=${st7?.spans} 画布宽=${st7?.canvasW} —— 页面停在"白画布 + 骨架屏 + 旧文本层"，用户看到的就是空白页`
          : '',
      );
      if (r7.timeout) await cdp.shot('07a-injected-render-hang.png');
      const und = await probe('unhang()');
      info(`已撤销注入：${und}`);
      const recovered = await (async () => {
        await clickBack();
        return openPaper(A);
      })();
      ok(
        !recovered.timeout,
        `撤销注入后关掉重开能正常恢复（${recovered.ms}ms，第 ${recovered.page} 页 span=${recovered.st?.spans ?? 0}）`,
        recovered.timeout ? '8s 未挂上：卡死状态被带到了下一次打开' : '',
      );
      await clickBack();
    }
    const toMarkers = cdp.warnings.filter((w) => /等待上一个渲染任务超时/.test(w));
    info(`硬化版超时日志「等待上一个渲染任务超时，已取消它并继续」出现 ${toMarkers.length} 次（改前没有这条代码路径，基线为 0）：${toMarkers.slice(-1).join('').slice(0, 130) || '（无）'}`);
    if (toMarkers.length) summary.push(`[7] 硬化超时日志：${toMarkers.slice(-1)[0].slice(0, 90)}`);
    const p1Markers = cdp.warnings.filter((w) => /6 秒未挂上文本层|文本层始终挂不上，重建文档以恢复|文本层始终为空/.test(w));
    info(`改前那套自愈标记在本轮出现 ${p1Markers.length} 次（看门狗/重建文档；不计失败，只作证据）：${p1Markers.slice(-2).join(' | ') || '（无）'}`);
    summary.push(`[7] 渲染任务永不 settle：${injected.ok ? (sevenTimeout ? `✗ ${ROUND_TIMEOUT / 1000}s 未自愈` : '✓ 已自愈') : '注入未生效'}`);

    // ================================================================ [6] 收尾
    console.log('\n[6] 收尾校验');
    const srcAfter = await dirFingerprint(SRC_LIB);
    ok(srcAfter === srcBefore, `用户论文目录没被改动（${srcBefore.split('\n').length} 个文件的 size/mtime 全部一致，只读）`);
    const pageErrsAll = (await cdp.eval('window.__stabh.pageErrors()').catch(() => [])) ?? [];
    const allErrs = [...newErrors(0), ...pageErrsAll.filter((e) => !noise(e))];
    ok(allErrs.length === 0, `渲染层全程零错误（console.error / 未捕获异常 / unhandledrejection，共 ${allErrs.length} 条）`, allErrs.slice(0, 3).join(' | '));
    ok(
      maxPageSpans >= 500,
      `文本层真的挂满过（全程单页最多 ${maxPageSpans} 个 span ≥ 500；稀疏封面页只有几十个 span，所以不能拿它当"挂满"的标准）`,
    );
    const warns = cdp.warnings.filter((w) => !/Electron Security/i.test(w));
    info(`渲染层告警 ${warns.length} 条（不计失败）：${warns.slice(-3).join(' | ') || '（无）'}`);
    if (pageErrsAll.length) info(`页面侧收集到的错误 ${pageErrsAll.length} 条：${pageErrsAll.slice(-3).join(' | ')}`);

    if (summary.length) {
      console.log('\n关键数据汇总：');
      for (const s of summary) console.log(`  · ${s}`);
    }
  } catch (err) {
    ok(false, `用例执行异常：${err.message}`);
    console.error(err);
    if (cdp) {
      const st = await cdp.eval('window.__stabh.state()').catch(() => null);
      if (st) info(`异常时状态：${JSON.stringify(st)}`);
    }
  } finally {
    try {
      const after = await buildFingerprint();
      const nowSig = `${after.js}|${after.size}|${after.sha}`;
      if (buildSig && nowSig !== buildSig) info('⚠⚠ 跑的过程中 dist 被重新构建了（有并发 build）：本次结果不可信，请重跑');
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
    // 只清"本次开跑前就存在"的残留 electron，别人刚起的实例不动
    const still = electronPids().filter((pid) => leftovers.includes(pid));
    for (const pid of still) killPid(pid, '开跑前就在的残留 electron');
    const remain = electronPids();
    if (remain.length) info(`注意：仍有 ${remain.length} 个 electron 在跑（pid ${remain.join(',')}）——不是本次遗留，没动它们`);
  }

  console.log(`\n${failures ? `❌ 稳定性压力回归失败 ${failures} 项` : '✅ 稳定性压力回归全部通过'}`);
  if (fp) console.log(`构建指纹：${fp.js}｜${fp.mtime.toLocaleString('zh-CN')}｜${fp.size}B｜sha256:${fp.sha}`);
  console.log(`截图目录：${SHOTS}`);
  console.log(`通过 ${checks - failures} / ${checks}；失败 ${failures} 项`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error('稳定性压力回归异常：', err);
  process.exit(1);
});

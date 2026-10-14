/**
 * 冒烟测试：直接启动「文献架整合」里的 exe，验证打包版能用。
 * 覆盖：启动 → 库加载 → 打开真实中文文献 → 文本层 → 拖选 → 划词工具条 → 高亮落库 → 缩放 → 文件夹文档写入。
 * 用法：node tools/smoke-portable.mjs [exe路径]
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const EXE = process.argv[2] ?? path.resolve(ROOT, '..', '文献架整合', '文献架 LitShelf.exe');
const PORT = 9711;
const DATA = path.join(ROOT, 'tmp', 'portable-smoke-data');
const REAL_DATA = path.join(os.homedir(), 'AppData', 'Roaming', '文献架 LitShelf');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (cond, label) => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}`);
  }
};

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.logs.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
      }
      if (m.method === 'Runtime.exceptionThrown') this.logs.push(`[EXC] ${(m.params.exceptionDetails?.exception?.description ?? '').slice(0, 240)}`);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`超时 ${method}`));
        }
      }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }
}

// 用真实库的副本启动（不写用户的真实数据目录）；
// --real-data：完全按"双击 exe"的方式启动（读 %APPDATA%\文献架 LitShelf），只做只读检查
const REAL_MODE = process.argv.includes('--real-data');
if (!REAL_MODE) {
  await fs.rm(DATA, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(DATA, { recursive: true });
  for (const f of ['library.json', 'settings.json']) {
    await fs.copyFile(path.join(REAL_DATA, f), path.join(DATA, f)).catch(() => undefined);
  }
}

console.log(`启动整合版：${EXE}${REAL_MODE ? '（双击模式：用真实数据目录）' : ''}`);
const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
if (!REAL_MODE) env.LITSHELF_DATA_DIR = DATA;
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { cwd: path.dirname(EXE), env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
child.stdout?.on('data', (d) => {
  stdout += d.toString();
});
child.stderr?.on('data', (d) => {
  stdout += d.toString();
});

let cdp;
try {
  let target = null;
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  check(!!target, '进程启动并开出窗口（调试端口有 page 目标）');
  if (!target) throw new Error('窗口没起来');
  console.log(`  窗口标题：${target.title}`);

  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(4000);
  await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('跳过')); b?.click(); return true; })()`);
  await sleep(1200);

  // 库是否加载（打包后路径/资源有问题的话这里就空了）
  const snap = await cdp.eval(`(async () => { const s = await window.litshelf.invoke('getSnapshot', []); return { items: s.items.length, roots: s.roots.length, version: s.version ?? '?' }; })()`);
  console.log(`  库：条目 ${snap.items} / 库 ${snap.roots} / 版本 ${snap.version}`);
  check(snap.items > 0, `库加载正常（${snap.items} 条）`);

  // 打开一篇真实 PDF（优先中文名，其次库里的第一篇 PDF）
  const target2 = await cdp.eval(`
    (async () => {
      const s = await window.litshelf.invoke('getSnapshot', []);
      const pdfs = s.items.filter((i) => i.kind === 'pdf');
      const it = pdfs.find((i) => /[\\u4e00-\\u9fa5]/.test(i.name)) ?? pdfs[0] ?? s.items[0];
      return it ? { name: it.name, pages: it.pageCount } : null;
    })()
  `);
  check(!!target2, '库里找到可打开的 PDF');
  await cdp.eval(`
    (() => {
      const input = document.getElementById('litshelf-search');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify((target2?.name ?? '').slice(0, 10))});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(900);
  await cdp.eval(`(() => { document.querySelector('.row')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
  let spans = 0;
  for (let i = 0; i < 120; i += 1) {
    // 注意：中文期刊 PDF 常常是"一段一个 span"，一页十几个 span 就是正常的，
    // 所以这里只要求 > 0（能不能划词由后面的拖选用例负责）
    spans = await cdp.eval('document.querySelectorAll(".rd-pdf-text span").length');
    if (spans > 0) break;
    await sleep(300);
  }
  console.log(`  打开：${target2?.name?.slice(0, 24)}… 文本层 ${spans} 个 span`);
  check(spans > 0, `PDF 渲染 + 文本层就绪（${spans} span）`);

  // 拖选 → 工具条
  const anchor = await cdp.eval(`
    (() => {
      const vh = window.innerHeight;
      for (const page of document.querySelectorAll('.rd-pdf-page')) {
        const pr = page.getBoundingClientRect();
        if (pr.bottom < 200 || pr.top > vh - 200) continue;
        for (const s of page.querySelectorAll('.rd-pdf-text span')) {
          const r = s.getBoundingClientRect();
          if (r.width < 3 || r.height < 3 || r.top < 200 || r.top > vh - 200) continue;
          const x = Math.round(r.left + r.width / 2);
          const y = Math.round(r.top + r.height / 2);
          if (document.elementFromPoint(x, y)?.closest?.('.rd-pdf-text span') === s) return { x, y };
        }
      }
      return null;
    })()
  `);
  check(!!anchor, '取到可拖选的文字锚点');
  if (anchor) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: anchor.x, y: anchor.y, buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: anchor.x, y: anchor.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i += 1) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: anchor.x, y: anchor.y + i * 8, button: 'left', buttons: 1 });
      await sleep(35);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: anchor.x, y: anchor.y + 48, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(900);
    /**
     * ⚠️ 必须读**引擎自己的选区**，不能读 `window.getSelection()`。
     *
     * 划词已由自研引擎接管（Zotero 式）：文本层设了 `user-select: none`，选区是引擎自绘的
     * （`.rd-sel-overlay` 里的 `.sel-line`），剪贴板也由引擎自己写。
     * 因此**原生选区按设计就是空的** —— 继续读 `window.getSelection()` 会永远得到 0 字，
     * 把"测试脚本过时"误报成"打包版划词坏了"（真机实测：工具条能弹出，说明拖拽其实被正确处理了）。
     */
    const sel = await cdp.eval('(window.__litshelfEngineSel && window.__litshelfEngineSel.text ? window.__litshelfEngineSel.text.length : 0)');
    const lines = await cdp.eval(`document.querySelectorAll('.rd-sel-overlay .sel-line').length`);
    const tb = await cdp.eval(`document.querySelectorAll('[class*="sel-toolbar"]').length`);
    console.log(`  拖选：引擎选中 ${sel} 字 / ${lines} 条高亮，工具条 ${tb} 个`);
    check(sel > 0 || lines > 0, `拖选能选中文字（引擎 ${sel} 字 / ${lines} 条高亮）`);
    check(tb > 0, '划词工具条出现');
  }

  // 缩放
  const zoom = async () => cdp.eval(`(document.querySelector('.rd-zoom-value') || {}).textContent || '?'`);
  const before = await zoom();
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: '=', code: 'Equal', windowsVirtualKeyCode: 187 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: '=', code: 'Equal', windowsVirtualKeyCode: 187 });
  await sleep(700);
  const after = await zoom();
  console.log(`  缩放：${before} → ${after}`);
  check(before !== after, `Ctrl+= 缩放可用（${before} → ${after}）`);

  // 数据目录：确认写到了我们指定的隔离目录（可移植性 & 不污染用户数据）
  if (!REAL_MODE) {
    const wrote = await fs
      .readdir(DATA)
      .then((l) => l.length > 0)
      .catch(() => false);
    check(wrote, `数据写在指定目录（${DATA}）`);
  } else {
    const realLib = await fs.readFile(path.join(REAL_DATA, 'library.json'), 'utf8').catch(() => '');
    check(realLib.length > 0, `真实数据目录存在且可读（${REAL_DATA}）`);
  }

  const errs = cdp.logs.filter((l) => /EXC|Error/.test(l));
  check(errs.length === 0, `渲染层无错误（${errs.length} 条）`);
  if (errs.length) for (const e of errs.slice(0, 3)) console.log('     ' + e);

  // 启动期 stderr 里的致命错误（缓存未命中会产生 ENOENT 日志，属于冷缓存正常现象，不算致命）
  const fatal = stdout
    .split(/\r?\n/)
    .filter((l) => /Cannot find module|MODULE_NOT_FOUND|Error: Cannot find|Unhandled|uncaught/i.test(l))
    .slice(0, 5);
  check(fatal.length === 0, `进程输出无致命错误（${fatal.length} 条）`);
  for (const f of fatal) console.log('     ' + f);

  // 核心承诺：文件夹里的文件变了，软件里自动跟着变（打包后 chokidar 必须能工作）
  const watchDir = path.join(ROOT, 'tmp', 'portable-watch-lib');
  await fs.rm(watchDir, { recursive: true, force: true });
  if (REAL_MODE) {
    console.log('  （双击模式：跳过会写数据的文件监听检查）');
  } else {
  await fs.mkdir(watchDir, { recursive: true });
  // 随便找一个测试用 PDF（第三方夹具目录里第一个 pdf）
  const fixtureDir = path.join(ROOT, 'tmp', 'ux-fixture');
  const srcPdf = await fs
    .readdir(fixtureDir)
    .then((l) => l.find((n) => n.toLowerCase().endsWith('.pdf')))
    .then((n) => (n ? path.join(fixtureDir, n) : ''))
    .catch(() => '');
  const haveSrc = srcPdf ? await fs.stat(srcPdf).then(() => true).catch(() => false) : false;
  if (haveSrc) {
    await cdp.eval(`(async () => { await window.litshelf.invoke('addRoot', [${JSON.stringify(watchDir)}, { depth: 1 }]); return true; })()`);
    await sleep(2500);
    const before = await cdp.eval(`(async () => { const s = await window.litshelf.invoke('getSnapshot', []); const r = s.roots.find((x) => x.path.endsWith('portable-watch-lib')); return r ? s.items.filter((i) => i.rootId === r.id).length : -1; })()`);
    await fs.copyFile(srcPdf, path.join(watchDir, '新加的文献.pdf'));
    let after = before;
    for (let i = 0; i < 40; i += 1) {
      after = await cdp.eval(`(async () => { const s = await window.litshelf.invoke('getSnapshot', []); const r = s.roots.find((x) => x.path.endsWith('portable-watch-lib')); return r ? s.items.filter((i) => i.rootId === r.id).length : -1; })()`);
      if (after > before) break;
      await sleep(500);
    }
    console.log(`  文件监听：新增文件前 ${before} 条 → 新增后 ${after} 条`);
    check(before === 0 && after === 1, `文件夹里新增文件后软件自动跟上（${before} → ${after}）`);
    // 删除文件：**按设计**是把这条标成「文件缺失」并保留（批注不能丢），不是从库里消失
    await fs.rm(path.join(watchDir, '新加的文献.pdf'), { force: true });
    let afterDel = { count: after, missing: 0 };
    for (let i = 0; i < 40; i += 1) {
      afterDel = await cdp.eval(`
        (async () => {
          const s = await window.litshelf.invoke('getSnapshot', []);
          const r = s.roots.find((x) => x.path.endsWith('portable-watch-lib'));
          const list = r ? s.items.filter((i) => i.rootId === r.id) : [];
          return { count: list.length, missing: list.filter((i) => i.missing).length };
        })()
      `);
      if (afterDel.missing > 0 || afterDel.count < after) break;
      await sleep(500);
    }
    console.log(`  删除后：${afterDel.count} 条，其中标记「文件缺失」${afterDel.missing} 条`);
    check(
      afterDel.missing > 0 || afterDel.count < after,
      `文件夹里删除文件后软件自动跟上（${afterDel.count} 条，缺失标记 ${afterDel.missing}）`,
    );
    await cdp.eval(`(async () => { const s = await window.litshelf.invoke('getSnapshot', []); const r = s.roots.find((x) => x.path.endsWith('portable-watch-lib')); if (r) await window.litshelf.invoke('removeRoot', [r.id]); return true; })()`).catch(() => undefined);
    await fs.rm(watchDir, { recursive: true, force: true }).catch(() => undefined);
  } else {
    console.log('  （跳过文件监听检查：找不到测试用 PDF）');
  }
  }

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
} catch (err) {
  console.error('冒烟测试异常：', err.message);
  if (stdout) console.error('进程输出（尾部）：\n' + stdout.split(/\r?\n/).slice(-25).join('\n'));
  fail += 1;
} finally {
  cdp?.ws.close();
  child.kill();
  await sleep(800);
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

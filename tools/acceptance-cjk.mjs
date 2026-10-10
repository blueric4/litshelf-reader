/**
 * 中文划词 + 缩放快捷键验收（独立会话、独立数据目录，快速且稳定）。
 *
 * 为什么单独一个脚本：这几项检查需要"刚打开一篇中文 PDF"的干净状态。
 * 放进大套件里会因为前面几十步操作留下的滚动位置/浮层而抖动，单独跑则每次都稳定。
 *
 * 覆盖：
 *   A. 中文文本层几何：每字宽 ≈ 字号（--total-scale-factor 生效的判据）
 *   B. 划词精度：拖 6 个汉字就选中 6 个（修好前会"选一大堆"）
 *   C. 拖到页面空白处 / 从页间灰缝起拖：不能"全选"
 *   D. 缩放快捷键：Ctrl+滚轮、Ctrl+=、Ctrl+0
 *
 * 用法：node tools/acceptance-cjk.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const PORT = 9111;
const DATA = path.join(ROOT, 'tmp', 'cjk-acceptance-data');
const FIXTURE = path.join(ROOT, 'tmp', 'cjk-fixture');
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
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
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
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), reject(new Error(`超时 ${method}`))), 20000);
    });
  }
  fire(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }
}

await fs.rm(DATA, { recursive: true, force: true }).catch(() => undefined);
// 现场造中文夹具（Type0/Identity-H + ToUnicode，形态与国内文献导出一致）
await new Promise((resolve) => {
  const gen = spawn(process.execPath, ['tools/make-cjk-pdf.mjs', FIXTURE], { cwd: ROOT, stdio: 'ignore' });
  gen.on('close', resolve);
  gen.on('error', resolve);
});

const env = { ...process.env, LITSHELF_DATA_DIR: DATA };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [`--remote-debugging-port=${PORT}`, '.'], {
  cwd: ROOT,
  env,
  stdio: 'ignore',
});

let cdp;
try {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        cdp = await Cdp.connect(page.webSocketDebuggerUrl);
        break;
      }
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  if (!cdp) throw new Error('等不到调试端口');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.bringToFront').catch(() => undefined);
  await sleep(3000);

  await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').includes('跳过')); b?.click(); return true; })()`);
  await sleep(700);
  await cdp.eval(`(async () => { await window.litshelf.invoke('addRoot', [${JSON.stringify(FIXTURE)}, { depth: 2 }]); return true; })()`);
  for (let i = 0; i < 60; i += 1) {
    const ready = await cdp.eval(`
      (async () => {
        const s = await window.litshelf.invoke('getSnapshot', []);
        return s.items.some((x) => x.name.includes('中文文献阅读与标注测试') && x.parseState !== 'placeholder');
      })()
    `);
    if (ready) break;
    await sleep(500);
  }

  const openFixture = async () => {
    await cdp.eval(`
      (() => {
        const input = document.getElementById('litshelf-search');
        if (!input) return false;
        input.focus();
        input.select();
        return true;
      })()
    `);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await cdp.send('Input.insertText', { text: '中文文献阅读与标注测试' });
    await sleep(800);
    await cdp.eval(`
      (() => {
        const rows = [...document.querySelectorAll('.row')];
        (rows.find((r) => (r.textContent || '').includes('PDF')) || rows[0])?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return true;
      })()
    `);
    for (let i = 0; i < 60; i += 1) {
      if (await cdp.eval('document.querySelectorAll(".rd-pdf-text span").length > 5')) return true;
      await sleep(500);
    }
    return false;
  };

  console.log('\n[A] 打开中文 PDF，检查文本层几何');
  const opened = await openFixture();
  ok(opened, '中文 PDF 已打开且文本层就绪');
  await sleep(800);

  const geom = await cdp.eval(`
    (() => {
      const span = [...document.querySelectorAll('.rd-pdf-text span')].find((s) => (s.textContent || '').length >= 8 && /[\\u4e00-\\u9fa5]/.test(s.textContent));
      if (!span) return null;
      const r = span.getBoundingClientRect();
      const fs = parseFloat(getComputedStyle(span).fontSize);
      return { len: span.textContent.length, width: r.width, fontSize: fs, perChar: r.width / span.textContent.length };
    })()
  `);
  ok(!!geom, `中文字宽/字号：${JSON.stringify(geom)}`);
  ok(!!geom && Math.abs(geom.perChar / geom.fontSize - 1) < 0.25, `每字宽度 ≈ 字号（比值 ${geom ? (geom.perChar / geom.fontSize).toFixed(2) : '?'}；修好前是 0.38）`);

  const toolbarCount = () =>
    cdp.eval(`(() => [...document.querySelectorAll('button')].filter(b => /^(高亮|下划线|波浪线|删除线)$/.test((b.title||b.textContent||'').trim())).length)()`);
  const selectionInfo = () =>
    cdp.eval(`
      (() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return { len: 0, pages: [] };
        const range = sel.getRangeAt(0);
        const pages = new Set();
        for (const el of document.querySelectorAll('.rd-pdf-page')) {
          try { if (range.intersectsNode(el)) pages.add(el.dataset.pageIndex); } catch {}
        }
        return { len: sel.toString().length, pages: [...pages] };
      })()
    `);
  const dragTo = async (x1, y1, x2, y2) => {
    await cdp.eval('window.getSelection()?.removeAllRanges()');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i += 1) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / 6, y: y1 + ((y2 - y1) * i) / 6, button: 'left', buttons: 1 });
      await sleep(30);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(700);
  };
  const dismissOverlay = async () => {
    if ((await toolbarCount()) === 0) return;
    cdp.fire('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    cdp.fire('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(400);
  };

  const line = await cdp.eval(`
    (() => {
      const span = [...document.querySelectorAll('.rd-pdf-text span')].find((s) => {
        const t = s.textContent || '';
        const r = s.getBoundingClientRect();
        return t.length >= 14 && /[\\u4e00-\\u9fa5]/.test(t) && r.width > 100 && r.top >= 140 && r.bottom <= window.innerHeight - 40;
      });
      if (!span) return null;
      const r = span.getBoundingClientRect();
      const perChar = r.width / Math.max(1, span.textContent.length);
      return { x: r.left + 2, y: r.top + r.height / 2, perChar, text: span.textContent.slice(0, 20) };
    })()
  `);
  ok(!!line, `取到一行中文正文：${line?.text ?? '（没有）'}`);

  /** 点「高亮」，返回刚落库的那条批注（这是"应用实际认到了多少字"的权威口径：
   *  原生选区会被划词工具条收走，所以不能拿 window.getSelection() 当判据） */
  const highlightAndRead = async () => {
    const clicked = await cdp.eval(`
      (() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.title || x.textContent || '').trim() === '高亮');
        if (!b) return false;
        b.click();
        return true;
      })()
    `);
    if (!clicked) return null;
    await sleep(1500);
    return cdp.eval(`
      (async () => {
        const all = await window.litshelf.invoke('listAllAnnotations', []);
        const a = all.slice().sort((x, y) => y.createdAt - x.createdAt)[0];
        return a ? { text: a.text, len: (a.text || '').length, rects: a.rects.length, page: a.page, itemId: a.itemId } : null;
      })()
    `);
  };

  if (line) {
    console.log('\n[B] 划词精度（拖 6 个汉字，看落库的批注内容）');
    await dragTo(line.x, line.y, line.x + line.perChar * 6, line.y);
    const tb = await toolbarCount();
    ok(tb >= 3, `划词工具条出现（${tb} 个动作）`);
    const hl = await highlightAndRead();
    ok(!!hl, `高亮已落库：「${hl?.text ?? ''}」`);
    ok((hl?.len ?? 0) > 0 && (hl?.len ?? 0) <= 8, `拖 6 个汉字 → 实际选中 ${hl?.len ?? 0} 个（修好前会"选一大堆"）`);
    ok((hl?.rects ?? 0) > 0, `带 ${hl?.rects} 个矩形并画到页面上`);

    console.log('\n[C] 拖到空白处不能"全选"');
    const blankProbe = await cdp.eval(`
      (() => {
        const page = document.querySelector('.rd-pdf-page');
        if (!page) return null;
        const pr = page.getBoundingClientRect();
        const spans = [...page.querySelectorAll('.rd-pdf-text span')];
        const last = spans[spans.length - 1]?.getBoundingClientRect();
        if (!last) return null;
        return {
          x: spans[0].getBoundingClientRect().left + 4,
          y: spans[0].getBoundingClientRect().top + 6,
          blankY: Math.min(pr.bottom - 24, last.bottom + 160),
          gapY: Math.min(window.innerHeight - 6, pr.bottom + 14),
          pageTextAll: spans.reduce((n, s) => n + (s.textContent || '').length, 0),
        };
      })()
    `);
    ok(!!blankProbe, '取到页面几何');
    if (blankProbe) {
      // ① 从第一行文字往下拖进页面空白处
      await dragTo(blankProbe.x, blankProbe.y, blankProbe.x, blankProbe.blankY);
      const blankTb = await toolbarCount();
      const blankHl = blankTb > 0 ? await highlightAndRead() : null;
      const blankLen = blankHl?.len ?? 0;
      ok(
        blankTb === 0 || blankLen <= Math.round(blankProbe.pageTextAll * 1.35),
        `拖进空白处：${blankTb === 0 ? '没有产生可标注选区（安全）' : `落库 ${blankLen} 字 ≈ 整页 ${blankProbe.pageTextAll} 字，没有炸到别的页`}`,
      );
      const nativeSel = await selectionInfo();
      ok(nativeSel.pages.length <= 1, `拖进空白处：原生选区只在 ${nativeSel.pages.length} 页内（>1 页就是"全选"）`);
      await dismissOverlay();

      // ② 从页与页之间的灰缝起拖
      await dragTo(blankProbe.x + 200, blankProbe.gapY, blankProbe.x, blankProbe.y);
      const gapTb = await toolbarCount();
      const gapSel = await selectionInfo();
      ok(gapTb === 0, `从页间灰缝起拖：不弹工具条（${gapTb} 个）`);
      ok(gapSel.len === 0, `从页间灰缝起拖：原生选中 ${gapSel.len} 字`);
      await dismissOverlay();
    }

    console.log('\n[D] 缩放快捷键');
    const zoomOf = () => cdp.eval(`document.querySelector('.rd-zoom-value')?.textContent?.trim() ?? '?'`);
    const num = (s) => Number(String(s).replace('%', '')) || 0;
    const waitZoom = async (pred, tries = 20) => {
      let z = await zoomOf();
      for (let i = 0; i < tries; i += 1) {
        if (pred(num(z))) return z;
        await sleep(300);
        z = await zoomOf();
      }
      return z;
    };
    const z0 = await zoomOf();
    cdp.fire('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 450, deltaX: 0, deltaY: -240, modifiers: 2 });
    const zUp = await waitZoom((n) => n > num(z0));
    cdp.fire('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 450, deltaX: 0, deltaY: 240, modifiers: 2 });
    const zDown = await waitZoom((n) => n < num(zUp));
    ok(num(zUp) > num(z0), `Ctrl+滚轮上滚放大：${z0} → ${zUp}`);
    ok(num(zDown) < num(zUp), `Ctrl+滚轮下滚缩小：${zUp} → ${zDown}`);
    const key = (k, code, vk) => {
      cdp.fire('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: k, code, windowsVirtualKeyCode: vk });
      cdp.fire('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: k, code, windowsVirtualKeyCode: vk });
    };
    key('=', 'Equal', 187);
    const zKey = await waitZoom((n) => n > num(zDown));
    ok(num(zKey) > num(zDown), `Ctrl+= 放大：${zDown} → ${zKey}`);
    key('0', 'Digit0', 48);
    const zFit = await waitZoom((n) => n !== num(zKey));
    ok(zFit !== zKey, `Ctrl+0 恢复适应宽度：${zKey} → ${zFit}`);

    await fs.mkdir(path.join(ROOT, 'tmp', 'shots-cjk'), { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(ROOT, 'tmp', 'shots-cjk', 'cjk-acceptance.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n  截图：tmp/shots-cjk/cjk-acceptance.png');
  }
} catch (err) {
  console.error('中文验收异常：', err.message);
  failures += 1;
} finally {
  cdp?.ws.close();
  child.kill();
  await sleep(600);
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

console.log(`\n${failures ? `❌ 失败 ${failures} 项` : '✅ 中文划词与缩放验收全部通过'}`);
process.exitCode = failures ? 1 : 0;

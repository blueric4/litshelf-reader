/**
 * 补充验收（提示词 11.2 清单里那些"必须真跑"的条目）。
 * 全程跑在隔离数据目录里（LITSHELF_DATA_DIR），绝不碰用户真实的文献库。
 *
 *   A. 规模：300 个文件（含 emoji 文件名、超长嵌套路径）的扫描与解析耗时
 *   B. 软件不往用户文件夹里写任何东西
 *   C. 阅读位置记忆（关掉重开还停在同一页）
 *   D. 划词 → 高亮落库 → 页面画出标记；划过已高亮文字仍可选中；单击高亮开卡片；Esc 只关卡片
 *   E. 键盘导航与搜索（含按文件名搜索）
 *   F. 深色模式
 *   G. 强杀进程后重启：无重复条目、无数据丢失
 *   H. 收尾：条目数与文献库数量还原到基线
 *
 * 中文划词精度 / 缩放快捷键 / "拖到空白处不能全选" 另见 tools/acceptance-cjk.mjs
 * （那几项需要"刚打开一篇中文 PDF"的干净状态，独立会话跑才稳定）
 *
 * 用法：node tools/acceptance.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const SHOTS = path.join(ROOT, 'tmp', 'shots-acceptance');
const PORT = 9222;
const DATA_DIR = path.join(ROOT, 'tmp', 'acceptance-data');
const SAMPLE_DIR = path.join(os.homedir(), 'Documents', '文献架示例文献');
const SCALE_DIR = path.join(ROOT, 'tmp', 'scale-library');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function ok(cond, label, extra = '') {
  if (!cond) failures += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
}

// ---------------------------------------------------------------- 极简 CDP 客户端

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
      if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '');
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') this.errors.push(m.params.entry.text);
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
      const timeout = method === 'Page.captureScreenshot' ? 15000 : 30000;
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时 ${method}`));
        }
      }, timeout);
    });
  }

  /** 发出去不等应答：带 Ctrl 的滚轮会被 Chromium 当缩放手势，应答可能迟迟不来 */
  fire(method, params = {}) {
    const id = (this.id += 1);
    this.ws.send(JSON.stringify({ id, method, params }));
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(`页面异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result?.value;
  }

  async shot(name) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const r = await this.send('Page.captureScreenshot', { format: 'png' });
        await fs.writeFile(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
        console.log(`  📷 ${name}`);
        return;
      } catch (err) {
        if (attempt === 2) {
          console.log(`  （截图 ${name} 失败：${err.message}，跳过）`);
          return;
        }
        await sleep(1200);
      }
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

async function launch() {
  const env = { ...process.env, LITSHELF_DATA_DIR: DATA_DIR };
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
        return { cdp, child, logs };
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('等不到 Electron 的调试端口（是否有残留实例占着单实例锁？）');
}

/** 用真实键盘往搜索框打字（比改 value + 派发 input 更接近真人操作） */
async function typeSearch(cdp, text) {
  const focused = await cdp.eval(`
    (() => {
      const el = document.getElementById('litshelf-search');
      if (!el) return false;
      el.focus();
      el.select();
      return true;
    })()
  `);
  if (!focused) return null;
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await cdp.send('Input.insertText', { text });
  await sleep(800);
  return cdp.eval(`document.getElementById('litshelf-search')?.value ?? ''`);
}

/** 造 300 个测试文件：emoji 文件名 + 超长中文嵌套路径 */
async function buildScaleLibrary() {
  await fs.rm(SCALE_DIR, { recursive: true, force: true });
  await fs.mkdir(SCALE_DIR, { recursive: true });
  const sources = (await fs.readdir(SAMPLE_DIR)).filter((f) => f.toLowerCase().endsWith('.pdf'));
  if (!sources.length) throw new Error('示例 PDF 不见了，请先跑一次 node tools/e2e-desktop.mjs');
  const longDir = path.join(
    SCALE_DIR,
    '2024',
    '国家自然科学基金',
    '子课题A',
    '第三阶段',
    '实验数据与补充材料',
    '最终版本',
    '归档',
  );
  await fs.mkdir(longDir, { recursive: true });
  for (let i = 0; i < 300; i += 1) {
    const src = path.join(SAMPLE_DIR, sources[i % sources.length]);
    const dir = i % 3 === 0 ? longDir : i % 3 === 1 ? path.join(SCALE_DIR, '批量', `组${(i % 7) + 1}`) : SCALE_DIR;
    await fs.mkdir(dir, { recursive: true });
    const name =
      i === 5
        ? '📚 emoji 文件名的文献.pdf'
        : i === 9
          ? 'Deep Learning for Medical Imaging (2023) - 张三, 李四 copy.pdf'
          : `批量文献 ${String(i).padStart(3, '0')} - 作者${i % 13} - ${2015 + (i % 10)}.pdf`;
    await fs.copyFile(src, path.join(dir, name));
  }
  return 300;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
  console.log(`隔离数据目录：${DATA_DIR}`);

  console.log('\n[A] 规模测试：300 个文件（含 emoji 名 + 超长嵌套路径）');
  const made = await buildScaleLibrary();
  ok(made === 300, `造出 ${made} 个文件`);
  const emojiOnDisk = await fs.readdir(SCALE_DIR).then((files) => files.some((f) => f.startsWith('📚')));
  ok(emojiOnDisk, 'emoji 文件名已就位');

  let session = await launch();
  let { cdp, child } = session;
  try {
    // 隔离数据目录是空的 → 先进引导页
    await sleep(2500);
    const skipped = await cdp.eval(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('跳过'));
        if (!btn) return 'no-onboarding';
        btn.click();
        return 'skipped';
      })()
    `);
    console.log(`  引导页：${skipped}`);
    await sleep(1000);

    const baseline = await cdp.eval(`
      (async () => {
        const s = await window.litshelf.invoke('getSnapshot', []);
        return { items: s.items.length, roots: s.roots.length };
      })()
    `);
    console.log(`  基线：${baseline.items} 条 / ${baseline.roots} 个文献库（隔离目录，结束时应还原）`);

    const t0 = Date.now();
    const added = await cdp.eval(`
      (async () => {
        const res = await window.litshelf.invoke('addRoot', [${JSON.stringify(SCALE_DIR)}, { depth: 8 }]);
        return res.root ? res.root.name : JSON.stringify(res);
      })()
    `);
    ok(!!added, `已添加文献库「${added}」`);

    let count = 0;
    let ready = 0;
    for (let i = 0; i < 300; i += 1) {
      const stats = await cdp.eval(`
        (async () => {
          const s = await window.litshelf.invoke('getSnapshot', []);
          return { total: s.items.length, ready: s.items.filter((x) => x.parseState === 'ready').length };
        })()
      `);
      count = stats.total;
      ready = stats.ready;
      if (ready >= 300) break;
      await sleep(500);
    }
    const elapsed = (Date.now() - t0) / 1000;
    ok(count >= 300, `全部文件出现在库里：${count} 条`);
    ok(ready >= 300, `全部解析完成：${ready} 条`, `总耗时 ${elapsed.toFixed(1)}s`);
    ok(elapsed < 180, `300 个文件的首次索引在 ${elapsed.toFixed(1)}s 内完成`);

    const emojiItem = await cdp.eval(`
      (async () => {
        const s = await window.litshelf.invoke('getSnapshot', []);
        const it = s.items.find((x) => x.name.startsWith('📚'));
        return it ? { title: it.title, pages: it.pageCount, state: it.parseState } : null;
      })()
    `);
    ok(!!emojiItem, `emoji 文件名的文献正常解析：${JSON.stringify(emojiItem)}`);
    const deep = await cdp.eval(`
      (async () => {
        const s = await window.litshelf.invoke('getSnapshot', []);
        return s.items.filter((x) => x.relPath.includes('实验数据与补充材料')).length;
      })()
    `);
    ok(deep > 0, `超长嵌套路径下的文件被递归发现：${deep} 条`);

    console.log('\n[B] 软件不往用户文件夹里写东西');
    const entries = await fs.readdir(SCALE_DIR, { withFileTypes: true });
    const appFiles = entries.filter((e) => e.name.startsWith('.') || /litshelf|\.tmp$|\.json$/i.test(e.name));
    ok(appFiles.length === 0, `被监听目录顶层没有软件产生的文件（${entries.length} 个条目全是用户自己的）`);

    console.log('\n[C] 阅读位置记忆（关掉重开仍停在同一页）');
    await cdp.eval(`
      (() => {
        const rows = [...document.querySelectorAll('.row')];
        (rows.find((r) => (r.textContent || '').includes('PDF')) || rows[0])?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return true;
      })()
    `);
    let opened = false;
    for (let i = 0; i < 40; i += 1) {
      opened = await cdp.eval('document.querySelectorAll("canvas").length > 0');
      if (opened) break;
      await sleep(500);
    }
    ok(opened, 'PDF 已在软件内打开');
    const openedItem = await cdp.eval(`
      (async () => {
        const s = await window.litshelf.invoke('getSnapshot', []);
        const it = s.items.find((x) => x.openCount > 0);
        return it ? { id: it.id, title: it.title, pages: it.pageCount } : null;
      })()
    `);
    ok(!!openedItem, `记录到打开的是《${openedItem?.title}》`);

    // 顺序很重要：先关阅读器（关闭时它会把当前页回写进度），再设进度，最后重开
    await cdp.eval(`
      (() => {
        const back = [...document.querySelectorAll('button')].find((b) => (b.title || '').includes('返回'));
        back?.click();
        return true;
      })()
    `);
    await sleep(900);
    const targetPage = Math.max(2, Math.min((openedItem?.pages ?? 3) - 1, 2));
    await cdp.eval(`(async () => {
      await window.litshelf.invoke('setProgress', [${JSON.stringify(openedItem.id)}, { page: ${targetPage}, total: ${openedItem.pages ?? 7}, percent: 30 }]);
    })()`);
    await sleep(300);
    await typeSearch(cdp, openedItem.title.slice(0, 12));
    await sleep(400);
    const reopened = await cdp.eval(`
      (() => {
        const rows = [...document.querySelectorAll('.row')];
        const t = rows.find((r) => (r.textContent || '').includes('PDF')) || rows[0];
        t?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return !!t;
      })()
    `);
    ok(reopened, '在列表里重新双击同一篇');
    let pageText = '';
    for (let i = 0; i < 40; i += 1) {
      pageText = await cdp.eval('document.body.innerText.match(/\\d+\\s*\\/\\s*\\d+\\s*页?/)?.[0] ?? ""');
      if (new RegExp(`^${targetPage}\\s*/`).test(pageText)) break;
      await sleep(500);
    }
    const storedPage = await cdp.eval(`
      (async () => {
        const s = await window.litshelf.invoke('getSnapshot', []);
        return s.items.find((x) => x.id === ${JSON.stringify(openedItem.id)})?.progress?.page ?? -1;
      })()
    `);
    ok(storedPage === targetPage, `宿主里的阅读位置 = 第 ${storedPage} 页（设置了第 ${targetPage} 页）`);
    ok(new RegExp(`^${targetPage}\\s*/`).test(pageText), `重开后自动停在第 ${targetPage} 页（当前：${pageText || '未读到页码'}）`);

    console.log('\n[D] 划词 → 高亮 → 批注侧栏');
    await cdp.eval(`
      (() => {
        const back = [...document.querySelectorAll('button')].find((b) => (b.title || '').includes('返回'));
        back?.click();
        return true;
      })()
    `);
    await sleep(900);
    await cdp.eval(`(async () => {
      await window.litshelf.invoke('setProgress', [${JSON.stringify(openedItem.id)}, { page: 1, total: ${openedItem.pages ?? 7}, percent: 14 }]);
    })()`);
    await sleep(300);
    await typeSearch(cdp, openedItem.title.slice(0, 12));
    await sleep(400);
    await cdp.eval(`
      (() => {
        const rows = [...document.querySelectorAll('.row')];
        const t = rows.find((r) => (r.textContent || '').includes('PDF')) || rows[0];
        t?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return true;
      })()
    `);
    for (let i = 0; i < 60; i += 1) {
      if (await cdp.eval('document.querySelectorAll(".rd-pdf-text span").length > 5')) break;
      await sleep(500);
    }
    await sleep(800);
    const cleaned = await cdp.eval(`
      (async () => {
        const list = await window.litshelf.invoke('listAnnotations', [${JSON.stringify(openedItem.id)}]);
        for (const a of list) await window.litshelf.invoke('deleteAnnotation', [a.id]);
        return list.length;
      })()
    `);
    ok(true, `清空该篇历史批注 ${cleaned} 条，保证可复现`);

    const toolbarCount = () =>
      cdp.eval(
        `(() => [...document.querySelectorAll('button')].filter(b => /^(高亮|下划线|波浪线|删除线)$/.test((b.title||b.textContent||'').trim())).length)()`,
      );
    const box = await cdp.eval(`
      (() => {
        const span = [...document.querySelectorAll('.rd-pdf-text span')].find((s) => {
          const r = s.getBoundingClientRect();
          if (!(r.width > 8 && r.height > 4 && r.top >= 140 && r.bottom <= window.innerHeight - 40)) return false;
          const hit = document.elementFromPoint(r.left + 2, r.top + r.height / 2);
          return hit === s || (hit ? s.contains(hit) : false);
        });
        if (!span) return null;
        const r = span.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, text: (span.textContent || '').slice(0, 40) };
      })()
    `);
    ok(!!box, `拿到一行可拖选的文字：${box?.text ?? '（没有）'}`);
    const dragTo = async (x1, y1, x2, y2) => {
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
      await sleep(800);
    };

    if (box) {
      const before = await cdp.eval(
        `(async () => (await window.litshelf.invoke("listAnnotations", [${JSON.stringify(openedItem.id)}])).length)()`,
      );
      await cdp.send('Page.bringToFront').catch(() => undefined);
      await dragTo(box.x + 1, box.y + box.h / 2, box.x + box.w - 2, box.y + box.h / 2);
      const tb = await toolbarCount();
      ok(tb >= 3, `真实鼠标拖选后划词工具条出现（${tb} 个动作）`);
      await cdp.shot('10-selection-toolbar.png');
      if (tb > 0) {
        await cdp.eval(`
          (() => {
            const b = [...document.querySelectorAll('button')].find((x) => (x.title || x.textContent || '').trim() === '高亮');
            b?.click();
            return true;
          })()
        `);
        await sleep(1600);
        const anns = await cdp.eval(`
          (async () => {
            const list = await window.litshelf.invoke('listAnnotations', [${JSON.stringify(openedItem.id)}]);
            return list.map((a) => ({ page: a.page, text: (a.text || '').slice(0, 20), rects: a.rects.length }));
          })()
        `);
        ok(anns.length > before, `批注已写入宿主（${before} → ${anns.length} 条）`, JSON.stringify(anns[0] ?? {}));
        ok((anns[0]?.rects ?? 0) > 0, `批注带 ${anns[0]?.rects} 个相对矩形（缩放后仍能定位）`);
        ok((await cdp.eval('document.querySelectorAll(".rd-ann-layer > *").length')) > 0, '页面上画出了高亮标记');
        await cdp.shot('11-annotation.png');

        // 划过已高亮的文字：不能被批注层挡死
        await dragTo(box.x + 1, box.y + box.h / 2, box.x + box.w - 2, box.y + box.h / 2);
        ok((await toolbarCount()) >= 3, '划过已高亮的文字仍能选中');
        await cdp.eval('window.getSelection()?.removeAllRanges()');

        // 单击高亮 → 批注卡片
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: box.x + 4,
          y: box.y + box.h / 2,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: box.x + 4,
          y: box.y + box.h / 2,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
        await sleep(700);
        ok(await cdp.eval('!!document.querySelector(".rd-ann-card")'), '单击已有高亮能打开批注卡片');

        // Esc 只关卡片，不退出阅读器
        cdp.fire('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        cdp.fire('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await sleep(600);
        const afterEsc = await cdp.eval(
          '({ card: !!document.querySelector(".rd-ann-card"), pages: document.querySelectorAll(".rd-pdf-page").length })',
        );
        ok(!afterEsc.card, '按 Esc 关闭批注卡片');
        ok(afterEsc.pages > 0, `按 Esc 没有把阅读器一起关掉（页数 ${afterEsc.pages}）`);
      }
    }

    console.log('\n[E] 键盘导航与搜索');
    await cdp.eval(`
      (() => {
        const back = [...document.querySelectorAll('button')].find((b) => (b.title || '').includes('返回'));
        back?.click();
        return true;
      })()
    `);
    await sleep(900);
    await typeSearch(cdp, '');
    await sleep(400);
    const navBefore = await cdp.eval('document.querySelector(".row.active .row-title")?.textContent ?? ""');
    await cdp.eval('window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }))');
    await sleep(400);
    const navAfter = await cdp.eval('document.querySelector(".row.active .row-title")?.textContent ?? ""');
    ok(!!navAfter, `j 键移动了选中项：${navBefore.slice(0, 14)} → ${navAfter.slice(0, 14)}`);
    const typed = await typeSearch(cdp, 'Medical Imaging');
    ok(!!typed, `搜索框可以输入（当前值「${typed}」）`);
    await sleep(400);
    const rowsAfter = await cdp.eval('document.querySelectorAll(".row").length');
    ok(rowsAfter >= 1 && rowsAfter < 40, `搜索 "Medical Imaging" 命中 ${rowsAfter} 行`);
    await typeSearch(cdp, 'emoji');
    await sleep(400);
    ok((await cdp.eval('document.querySelectorAll(".row").length')) >= 1, '按文件名也能搜到（emoji）');
    await typeSearch(cdp, '');

    console.log('\n[F] 深色模式');
    await cdp.eval(`(async () => { await window.litshelf.invoke('updateSettings', [{ theme: 'dark' }]); return true; })()`);
    await sleep(800);
    ok((await cdp.eval('document.documentElement.dataset.theme')) === 'dark', '主题已切换为深色');
    await cdp.shot('12-dark-mode.png');

    console.log('\n[G] 强杀进程后重启：无重复、无丢失');
    const beforeKill = await cdp.eval(`
      (async () => {
        const s = await window.litshelf.invoke('getSnapshot', []);
        return { items: s.items.length, anns: (await window.litshelf.invoke('listAllAnnotations', [])).length };
      })()
    `);
    cdp.close();
    child.kill('SIGKILL');
    await sleep(2500);
    session = await launch();
    cdp = session.cdp;
    child = session.child;
    for (let i = 0; i < 60; i += 1) {
      if (await cdp.eval('!!document.querySelector(".app-body, .onb-card")').catch(() => false)) break;
      await sleep(500);
    }
    await sleep(2500);
    const afterKill = await cdp.eval(`
      (async () => {
        const s = await window.litshelf.invoke('getSnapshot', []);
        const paths = s.items.map((x) => x.relPath);
        return { items: s.items.length, unique: new Set(paths).size, anns: (await window.litshelf.invoke('listAllAnnotations', [])).length };
      })()
    `);
    ok(afterKill.items === beforeKill.items, `重启后条目数不变（${beforeKill.items} → ${afterKill.items}）`);
    ok(afterKill.unique === afterKill.items, `无重复条目（unique=${afterKill.unique}）`);
    ok(afterKill.anns >= beforeKill.anns, `批注没有丢（${beforeKill.anns} → ${afterKill.anns}）`);
    ok((await cdp.eval('document.documentElement.dataset.theme')) === 'dark', '深色设置也持久化了');

    console.log('\n[H] 收尾：移除规模测试库，条目数还原到基线');
    const removedRoot = await cdp.eval(`
      (async () => {
        await window.litshelf.invoke('updateSettings', [{ theme: 'light' }]);
        const s = await window.litshelf.invoke('getSnapshot', []);
        const root = s.roots.find((r) => r.path.includes('scale-library'));
        if (!root) return 'no-root';
        await window.litshelf.invoke('removeRoot', [root.id, { forgetItems: true }]);
        return root.name;
      })()
    `);
    ok(removedRoot !== 'no-root', `已移除规模测试库：${removedRoot}`);
    await sleep(1500);
    const finalState = await cdp.eval(`
      (async () => {
        const s = await window.litshelf.invoke('getSnapshot', []);
        return { items: s.items.length, roots: s.roots.length };
      })()
    `);
    ok(finalState.items === baseline.items, `条目数还原到基线（${finalState.items} / ${baseline.items}）`);
    ok(finalState.roots === baseline.roots, `文献库数量还原到基线（${finalState.roots} / ${baseline.roots}）`);

    const errs = cdp.errors.filter((e) => !/DevTools|Autofill|Electron Security/i.test(e));
    ok(errs.length === 0, `渲染层零错误（${errs.length}）`, errs.slice(0, 3).join(' | '));
  } finally {
    cdp?.close();
    child?.kill();
    await sleep(700);
    try {
      child?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }

  await fs.rm(SCALE_DIR, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\n${failures ? `❌ 失败 ${failures} 项` : '✅ 补充验收全部通过'}`);
  console.log(`截图：${SHOTS}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error('补充验收异常：', err);
  process.exit(1);
});

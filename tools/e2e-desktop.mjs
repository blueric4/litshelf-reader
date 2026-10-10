/**
 * Electron 端到端验收：启动真实桌面应用，用 CDP 驱动界面并截图。
 * 覆盖：引导页 → 生成示例文献 → 库列表 → 详情 → 阅读器 → 文件夹新增文件自动同步。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const SHOTS = path.join(ROOT, 'tmp', 'shots');
const PORT = 9222;
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
    this.consoleErrors = [];
    this.pageErrors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
        this.consoleErrors.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.pageErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? 'unknown');
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.pageErrors.push(`[log] ${msg.params.entry.text}`);
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
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`页面脚本异常：${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`);
    return res.result?.value;
  }

  async shot(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOTS, name);
    await fs.writeFile(file, Buffer.from(res.data, 'base64'));
    const size = (await fs.stat(file)).size;
    console.log(`  📷 ${name}（${(size / 1024).toFixed(0)} KB）`);
    return file;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function findTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('等不到 Electron 的调试端口，应用可能没起来');
}

// ---------------------------------------------------------------- 主流程

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });

  // 关键：用隔离的数据目录跑。绝不能重置用户真实数据目录——那会抹掉用户自己添加的文献库
  // （文件不会丢，但库注册、阅读进度、笔记会丢）。LITSHELF_DATA_DIR 由主进程读取。
  const dataDir = path.join(ROOT, 'tmp', 'e2e-data');
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`数据目录（隔离、已重置，不动真实库）：${dataDir}`);

  const env = { ...process.env, LITSHELF_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE; // 本会话环境里有这个变量，会让 electron.exe 退化成 node
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electron, [`--remote-debugging-port=${PORT}`, '.'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  let cdp;
  try {
    const target = await findTarget();
    console.log(`已连上渲染进程：${target.url.slice(0, 70)}`);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    console.log('\n[1] 首次启动：引导页');
    await sleep(2500);
    const mode = await cdp.eval('window.litshelf ? window.litshelf.mode : "no-bridge"');
    ok(mode === 'electron', `preload 桥接可用（mode=${mode}）`);
    const onbVisible = await cdp.eval('!!document.querySelector(".onb-card")');
    ok(onbVisible, '显示首次启动引导页');
    const onbText = await cdp.eval('document.querySelector(".onb-title")?.textContent ?? ""');
    ok(onbText.includes('文献架'), `引导页标题：${onbText}`);
    await cdp.shot('01-onboarding.png');

    console.log('\n[2] 点「先生成示例文献看看」');
    const clicked = await cdp.eval(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('示例'));
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    ok(clicked, '找到并点击了示例文献按钮');
    const sampleDir = path.join(os.homedir(), 'Documents', '文献架示例文献');
    await sleep(1500);
    const sampleFiles = await fs.readdir(sampleDir).catch(() => []);
    ok(sampleFiles.length >= 13, `磁盘上生成了 ${sampleFiles.length} 个顶层文件（另有子目录内的文件）`);

    console.log('\n[3] 扫描完成后的库界面');
    await cdp.eval(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('开始使用'));
        if (btn) btn.click();
        return true;
      })()
    `);
    let rows = 0;
    for (let i = 0; i < 40; i += 1) {
      rows = await cdp.eval('document.querySelectorAll(".row").length');
      if (rows >= 14) break;
      await sleep(500);
    }
    ok(rows >= 14, `列表渲染出 ${rows} 行（虚拟滚动视口内）`);
    const sidebarCount = await cdp.eval('document.querySelector(".sb-item .sb-count")?.textContent ?? ""');
    ok(String(sidebarCount).replace(/\D/g, '') === '14', `侧边栏「全部文献」计数 = ${sidebarCount}`);
    const firstTitle = await cdp.eval('document.querySelector(".row-title")?.textContent ?? ""');
    ok(firstTitle.length > 3, `列表首行标题：${firstTitle}`);
    await cdp.shot('02-library.png');

    console.log('\n[4] 点选条目 → 详情栏');
    await cdp.eval('document.querySelectorAll(".row")[1]?.click()');
    await sleep(600);
    const detailTitle = await cdp.eval('document.querySelector(".dp-title")?.textContent ?? ""');
    ok(detailTitle.length > 3, `详情栏标题：${detailTitle}`);
    const hasTags = await cdp.eval('!!document.querySelector(".tag-add")');
    ok(hasTags, '详情栏有标签编辑入口');
    const coverImg = await cdp.eval('!!document.querySelector(".dp-cover img, .dp-cover svg")');
    ok(coverImg, '详情栏显示封面或占位图');
    await cdp.shot('03-detail.png');

    console.log('\n[5] 双击打开阅读器（PDF 真实渲染）');
    const pdfIndex = await cdp.eval(`
      (() => {
        const rows = [...document.querySelectorAll('.row')];
        const idx = rows.findIndex(r => (r.textContent || '').includes('PDF'));
        const sel = document.querySelectorAll('.row')[idx];
        if (sel) sel.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return idx;
      })()
    `);
    ok(pdfIndex >= 0, `在列表第 ${pdfIndex + 1} 行找到 PDF 条目并双击`);
    let canvasCount = 0;
    for (let i = 0; i < 40; i += 1) {
      canvasCount = await cdp.eval('document.querySelectorAll("canvas").length');
      if (canvasCount > 0) break;
      await sleep(500);
    }
    ok(canvasCount > 0, `阅读器渲染出 ${canvasCount} 个 canvas`);
    const pageLabel = await cdp.eval('document.body.innerText.match(/\\d+\\s*\\/\\s*\\d+\\s*页?/)?.[0] ?? ""');
    ok(!!pageLabel, `页码显示：${pageLabel}`);
    // 文本层是异步挂的（还要等 pdf.js 取回文字）：canvas 出现 ≠ 已经可以划词。
    // 这里等就绪（最多 20s）再断言，避免用"渲染竞态"当成产品失败；真挂不上照样会红。
    let textLayer = 0;
    for (let i = 0; i < 40; i += 1) {
      textLayer = await cdp.eval('document.querySelectorAll(".rd-pdf-text span, .textLayer span").length');
      if (textLayer > 0) break;
      await sleep(500);
    }
    ok(textLayer > 0, `文本层有 ${textLayer} 个 span（可选中、可批注）`);
    const selectable = await cdp.eval(`
      (() => {
        const el = document.querySelector('.rd-pdf-text span');
        if (!el) return '';
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const rects = range.getClientRects().length;
        return (sel.toString() || '') + '|rects=' + rects;
      })()
    `);
    ok(selectable.includes('rects=') && !selectable.endsWith('rects=0'), `能用选区拿到文本与矩形：${selectable.slice(0, 40)}`);
    if (textLayer === 0) {
      const dump = await cdp.eval(`
        (() => {
          const canvas = document.querySelector('canvas');
          const page = canvas ? canvas.closest('div') : null;
          const textish = [...document.querySelectorAll('div')]
            .map(d => (typeof d.className === 'string' ? d.className : ''))
            .filter(c => /text|Text/.test(c)).slice(0, 12);
          return {
            textishClasses: textish,
            pageChildren: page ? [...page.children].map(c => c.tagName + '.' + (typeof c.className === 'string' ? c.className : '')) : [],
            spansTotal: document.querySelectorAll('span').length,
            canvasCount: document.querySelectorAll('canvas').length,
          };
        })()
      `);
      console.log('  诊断：', JSON.stringify(dump));
    }
    await cdp.shot('04-reader.png');

    console.log('\n[6] 阅读进度记忆（翻页后写回宿主）');
    await cdp.eval(`
      (() => {
        const btn = [...document.querySelectorAll('button')].find(b => /下一?页|›|→/.test(b.title || b.textContent));
        btn?.click();
        return true;
      })()
    `);
    await sleep(2500);
    const saved = await cdp.eval(`
      (async () => {
        const snap = await window.litshelf.invoke('getSnapshot', []);
        const opened = snap.items.find(i => i.openCount > 0);
        return opened ? { title: opened.title, page: opened.progress.page, openCount: opened.openCount, readState: opened.readState } : null;
      })()
    `);
    ok(!!saved, `宿主记录了打开状态：${JSON.stringify(saved)}`);
    ok(saved?.openCount >= 1 && saved?.readState !== 'unread', '打开后自动变为「在读」并累计打开次数');

    console.log('\n[7] 回到列表，验证「文件夹变了软件就变」');
    const backResult = await cdp.eval(`
      (() => {
        const back = [...document.querySelectorAll('button')].find(b => (b.title || '').includes('返回'));
        if (back) { back.click(); return 'clicked'; }
        return 'not-found:' + [...document.querySelectorAll('button')].slice(0, 12).map(b => b.title).join(',');
      })()
    `);
    console.log(`  返回按钮：${backResult}`);
    await sleep(900);

    // 真实地在磁盘上复制一个新 PDF 进文献库
    const pdfs = (await fs.readdir(sampleDir)).filter((f) => f.toLowerCase().endsWith('.pdf'));
    const src = path.join(sampleDir, pdfs[0]);
    const newName = `新拖进来的文献 ${Date.now()}.pdf`;
    await fs.copyFile(src, path.join(sampleDir, newName));
    console.log(`  已在文件夹里新增：${newName}`);

    let found = false;
    let toastText = '';
    for (let i = 0; i < 60; i += 1) {
      const state = await cdp.eval(`
        (async () => {
          const snap = await window.litshelf.invoke('getSnapshot', []);
          return {
            has: snap.items.some(i => i.name.includes('新拖进来的文献')),
            toast: document.querySelector('.toast-msg')?.textContent ?? '',
            count: snap.items.length,
          };
        })()
      `);
      if (state.toast && !toastText && /添加|同步|已添加|缺失|更新/.test(state.toast)) toastText = state.toast;
      if (state.has) {
        found = true;
        // 宿主的事件合并提示有 ~900ms 的批处理延迟，等它出现再抓
        for (let k = 0; k < 10 && !toastText; k += 1) {
          await sleep(400);
          const late = await cdp.eval('[...document.querySelectorAll(".toast-msg")].map(e => e.textContent).join(" / ")');
          const hit = String(late)
            .split(' / ')
            .find((t) => /添加|同步|已添加|更新|缺失/.test(t));
          if (hit) toastText = hit;
        }
        break;
      }
      await sleep(300);
    }
    ok(found, '软件内自动识别到新增文件（无需刷新、无需重启）');
    ok(!!toastText, `右下角自动提示：${toastText || '（没抓到，可能已被自动关闭）'}`);
    await cdp.shot('05-live-add.png');

    console.log('\n[8] 改名 → 条目原地跟随（UI 层验证）');
    const before = await cdp.eval(`
      (async () => {
        const snap = await window.litshelf.invoke('getSnapshot', []);
        const it = snap.items.find(i => i.name.includes('新拖进来的文献'));
        return it ? { id: it.id, path: it.path } : null;
      })()
    `);
    const renamedPath = path.join(sampleDir, `改过名的文献 ${Date.now()}.pdf`);
    await fs.rename(before.path, renamedPath);
    let renamedOk = false;
    for (let i = 0; i < 40; i += 1) {
      const after = await cdp.eval(`
        (async () => {
          const snap = await window.litshelf.invoke('getSnapshot', []);
          const it = snap.items.find(i => i.id === ${JSON.stringify(before.id)});
          return it ? { id: it.id, path: it.path, name: it.name } : null;
        })()
      `);
      if (after && after.path === renamedPath) {
        renamedOk = true;
        break;
      }
      await sleep(500);
    }
    ok(renamedOk, '改名后同一个条目 id 的路径已更新（用户数据不丢）');

    console.log('\n[9] 删除 → 「文件缺失」而不是消失');
    await fs.unlink(renamedPath);
    let missingOk = false;
    for (let i = 0; i < 40; i += 1) {
      const after = await cdp.eval(`
        (async () => {
          const snap = await window.litshelf.invoke('getSnapshot', []);
          const it = snap.items.find(i => i.id === ${JSON.stringify(before.id)});
          return it ? { missing: it.missing } : null;
        })()
      `);
      if (after?.missing) {
        missingOk = true;
        break;
      }
      await sleep(500);
    }
    ok(missingOk, '文件删除后条目仍在、标记为缺失');

    console.log('\n[10] 控制台健康检查');
    const errors = cdp.pageErrors.concat(cdp.consoleErrors).filter((e) => !/DevTools|Autofill|Electron Security/i.test(e));
    ok(errors.length === 0, `渲染层零错误（${errors.length} 条）`, errors.slice(0, 4).join(' | '));

    console.log('\n[11] 收尾：清掉验收过程造的测试数据');
    const removed = await cdp.eval(`
      (async () => {
        const snap = await window.litshelf.invoke('getSnapshot', []);
        const junk = snap.items.filter(i => i.name.includes('新拖进来的文献') || i.name.includes('改过名的文献'));
        if (junk.length) await window.litshelf.invoke('deleteItems', [junk.map(i => i.id)]);
        return junk.map(i => i.name);
      })()
    `);
    ok(true, `已从库中移除测试条目：${removed.length ? removed.join('、') : '（无）'}`);
    await fs.unlink(newName).catch(() => undefined);
    await fs.unlink(renamedPath).catch(() => undefined);
    const leftOnDisk = (await fs.readdir(sampleDir).catch(() => [])).filter((f) => f.includes('新拖进来') || f.includes('改过名'));
    ok(leftOnDisk.length === 0, '磁盘上的测试副本已清理');
    await sleep(1200);
    const finalCount = await cdp.eval('(async () => (await window.litshelf.invoke("getSnapshot", [])).items.length)()');
    ok(finalCount === 14, `演示库恢复为 ${finalCount} 篇示例文献`);
  } finally {
    cdp?.close();
    child.kill();
    await sleep(800);
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    const logText = logs.join('');
    const started = /已启动/.test(logText);
    console.log(`\n主进程日志${started ? '（含启动行）' : ''}：`);
    console.log(
      logText
        .split('\n')
        .filter((l) => l.trim() && !/^\s*$/.test(l))
        .slice(0, 8)
        .map((l) => `    ${l.trim().slice(0, 160)}`)
        .join('\n') || '    （无输出）',
    );
  }

  console.log(`\n${failures ? `❌ 失败 ${failures} 项` : '✅ 桌面端到端验收全部通过'}`);
  console.log(`截图目录：${SHOTS}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error('端到端验收异常：', err);
  process.exit(1);
});

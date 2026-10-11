/**
 * Electron 主进程：单实例 → Host → 窗口 → 托盘 / 菜单 / litfile 协议。
 *
 * 主进程只做"宿主适配"这一件事：业务逻辑全部在 src/core/host.ts 里，
 * 渲染层通过 preload 暴露的 window.litshelf 调 IPC（见 src/main/ipc.ts）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Menu, Tray, app, dialog, nativeImage, protocol, shell } from 'electron';
import { Host } from '../core/host';
import { defaultPickStartDir, openFoldersDialog, registerIpc } from './ipc';

/** 构建期由 scripts/build.mjs 的 define 注入 */
declare const __APP_VERSION__: string;

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
/** 产品名：同时决定 userData 目录（%APPDATA%\文献架 LitShelf） */
const APP_NAME = '文献架 LitShelf';
/** 产物目录：dist/main/index.mjs → dist/ */
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEV_SERVER_URL = process.env.LITSHELF_DEV_SERVER_URL || '';

/** 16×16 托盘图标（内嵌 PNG，避免依赖任何图标文件） */
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANUlEQVR42mNggIGq//9JwhiAbANI1YhhEBIHBpDZ2AD9DOjrm4yBR11AbxfQ3wDykvJA50YAf5zFdZ1AoNIAAAAASUVORK5CYII=';

// 必须在 app ready 之前声明：litfile:// 要能走 fetch、支持流式（PDF.js 分块加载）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'litfile',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: false,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let host: Host | null = null;
let quitting = false;
let hostStopped = false;

// 数据目录 = userData = %APPDATA%\文献架 LitShelf。
// 注意：直接用 electron 可执行文件跑 dist/main/index.mjs 时，Electron 读不到项目根 package.json
// 的 productName，userData 会退化成 %APPDATA%\Electron（甚至与别的 Electron 项目串在一起），
// 所以这里显式对齐产品名 —— 必须在 ready 之前、任何 getPath('userData') 之前完成。
//
// 另：LITSHELF_DATA_DIR 可覆盖数据目录（便携模式 / 自动化测试用隔离数据，避免动到真实文献库）。
app.setName(APP_NAME);
try {
  const override = process.env.LITSHELF_DATA_DIR?.trim();
  const userDataDir = override ? path.resolve(override) : path.join(app.getPath('appData'), APP_NAME);
  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
  if (override) console.log(`[litshelf] 使用自定义数据目录：${userDataDir}`);
} catch (err) {
  console.error('[litshelf] 设置 userData 目录失败，回退到 Electron 默认目录', err);
}

// ---------------------------------------------------------------- 小工具

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

function mimeFor(filePath: string): string {
  const ext = (filePath.split('.').pop() ?? '').toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

/** 解析 `Range: bytes=a-b`；返回 null 表示没有/不是合法区间 */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return null;
  let start: number;
  let end: number;
  if (hasStart) {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : size - 1;
  } else {
    // bytes=-N：最后 N 个字节
    const suffix = Number(m[2]);
    if (!suffix) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  if (start > end || start >= size) return null;
  return { start, end };
}

/** 把一个本地文件作为 (可能是部分的) HTTP 响应返回，支持 Range —— PDF.js 靠它分块加载 */
function fileResponse(filePath: string, rangeHeader: string | null): Response {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch (err) {
    console.error('[litshelf] 读取文件失败', filePath, err);
    return new Response('Not Found', { status: 404 });
  }
  const type = mimeFor(filePath);
  const range = parseRange(rangeHeader, size);
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  try {
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
      headers['Content-Length'] = String(range.end - range.start + 1);
      const stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 206, headers });
    }
    headers['Content-Length'] = String(size);
    const stream = fs.createReadStream(filePath);
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 200, headers });
  } catch (err) {
    console.error('[litshelf] 流式读取失败', filePath, err);
    return new Response('Internal Error', { status: 500 });
  }
}

/** litfile://item/<id>?rev=N 与 litfile://thumb/<name> */
function handleLitfile(request: Request): Response {
  if (!host) return new Response('Host not ready', { status: 503 });
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }
  const kind = url.hostname;
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name) return new Response('Bad Request', { status: 400 });

  if (kind === 'item') {
    const resolved = host.resolveFile(name);
    if (!resolved) return new Response('Not Found', { status: 404 });
    return fileResponse(resolved.path, request.headers.get('range'));
  }
  if (kind === 'thumb') {
    // 防目录穿越：只允许 thumbs 目录下的简单文件名
    if (!/^[\w.-]+$/.test(name)) return new Response('Bad Request', { status: 400 });
    return fileResponse(host.thumbPath(name), request.headers.get('range'));
  }
  return new Response('Not Found', { status: 404 });
}

// ---------------------------------------------------------------- 窗口

/** 恢复上次的窗口位置与内容区尺寸（默认 1440×900） */
function readBounds(): { x?: number; y?: number; width: number; height: number; maximized?: boolean } {
  const saved = host?.library.getSettings().windowBounds;
  return {
    x: saved?.x,
    y: saved?.y,
    width: Math.max(900, saved?.width || 1440),
    height: Math.max(600, saved?.height || 900),
    maximized: saved?.maximized,
  };
}

let saveBoundsTimer: NodeJS.Timeout | null = null;
function persistBounds(win: BrowserWindow): void {
  if (!host || win.isDestroyed()) return;
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    saveBoundsTimer = null;
    if (!host || win.isDestroyed()) return;
    const prev = host.library.getSettings().windowBounds;
    const maximized = win.isMaximized();
    const next = { ...(prev ?? { width: 1440, height: 900 }), maximized };
    if (!maximized) {
      // 位置取外框坐标、尺寸取内容区尺寸（窗口用 useContentSize 创建），这样往返不会因为
      // Windows 的隐形边框每次启动都长大几像素。
      const outer = win.getNormalBounds();
      const content = win.getContentBounds();
      next.x = outer.x;
      next.y = outer.y;
      next.width = content.width;
      next.height = content.height;
      // 几像素的取整抖动直接忽略，避免"启动一次胖一点"
      if (prev && Math.abs(prev.width - next.width) < 8 && Math.abs(prev.height - next.height) < 8 && prev.x === next.x && prev.y === next.y) return;
    } else if (prev?.maximized) {
      return;
    }
    try {
      host.updateSettings({ windowBounds: next });
    } catch (err) {
      console.error('[litshelf] 保存窗口尺寸失败', err);
    }
  }, 500);
}

async function createWindow(instance: Host): Promise<BrowserWindow> {
  const bounds = readBounds();
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    // width/height 视作内容区尺寸，与 getContentBounds() 对齐
    useContentSize: true,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#F2F2F7',
    title: '文献架 LitShelf',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(DIST_DIR, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  if (bounds.maximized) win.maximize();
  win.once('ready-to-show', () => {
    win.show();
    if (bounds.maximized) win.maximize();
  });

  win.on('resize', () => persistBounds(win));
  win.on('move', () => persistBounds(win));
  win.on('maximize', () => persistBounds(win));
  win.on('unmaximize', () => persistBounds(win));

  win.on('close', (event) => {
    persistBounds(win);
    // 托盘模式：关窗只是隐藏，右键托盘可退出
    const trayMode = instance.library.getSettings().minimizeToTray && !!tray;
    if (!quitting && trayMode) {
      event.preventDefault();
      win.hide();
      instance.pushToast('info', '文献架已最小化到托盘', '右键托盘图标可以退出', 4000);
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // 外链一律交给系统浏览器，窗口内不开新页
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch((err) => console.error('[litshelf] 打开外链失败', url, err));
    return { action: 'deny' };
  });

  if (DEV_SERVER_URL) {
    try {
      await win.loadURL(DEV_SERVER_URL);
    } catch (err) {
      await showLoadFailure(win, instance, `开发服务器地址不可用：${DEV_SERVER_URL}`, err);
    }
  } else {
    const indexPath = path.join(DIST_DIR, '../renderer/index.html');
    try {
      await win.loadFile(indexPath);
    } catch (err) {
      await showLoadFailure(win, instance, `渲染层产物不存在：${indexPath}`, err);
    }
  }
  return win;
}

/** 渲染层加载失败时不要静默白屏：日志 + 提示 + 页面内说明 */
async function showLoadFailure(win: BrowserWindow, instance: Host, detail: string, err: unknown): Promise<void> {
  console.error(`[litshelf] ${detail}`, err);
  instance.pushToast('error', '界面加载失败', `${detail}（请先运行 node scripts/build.mjs）`, 12000);
  const html =
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>文献架 LitShelf</title>' +
    '<body style="font-family:system-ui,Segoe UI,sans-serif;background:#F2F2F7;color:#1c1c1e;padding:48px;line-height:1.7">' +
    '<h2>界面加载失败</h2>' +
    `<p>${detail.replace(/[<>&]/g, '')}</p>` +
    '<p>请先构建渲染层：<code>node scripts/build.mjs</code>；开发态请用 <code>pnpm dev</code>（会自带 Vite 开发服务器）。</p>' +
    '<p style="color:#8e8e93">文献库与设置不受影响，数据目录：' +
    `${instance.dataDir.replace(/[<>&]/g, '')}</p></body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined);
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!host) return;
    void createWindow(host).then((win) => {
      mainWindow = win;
    });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------- 托盘

function createTray(instance: Host): Tray | null {
  try {
    const image = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
    if (image.isEmpty()) {
      console.error('[litshelf] 托盘图标解码失败，跳过托盘（关窗即退出）');
      return null;
    }
    const instanceTray = new Tray(image.resize({ width: 16, height: 16 }));
    instanceTray.setToolTip('文献架 LitShelf');
    instanceTray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主窗口', click: () => showMainWindow() },
        {
          // 现在是**文件**对话框（能直接看到 PDF），选中后按文件所在文件夹入库，
          // 所以标签不能再写"添加文献文件夹"，否则和实际行为对不上。
          label: '添加文献（选择文件，按所在文件夹入库）…',
          click: () => {
            void addFolderViaDialog(instance);
          },
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    instanceTray.on('click', () => showMainWindow());
    instanceTray.on('double-click', () => showMainWindow());
    return instanceTray;
  } catch (err) {
    console.error('[litshelf] 创建托盘失败，退化为普通窗口模式', err);
    return null;
  }
}

// ---------------------------------------------------------------- 菜单动作

async function addFolderViaDialog(instance: Host): Promise<void> {
  // 与界面里的「添加文献」走同一条路径：文件对话框里能直接看到 PDF 等文献文件，
  // 选中后取它所在的文件夹。起始目录用同一套规则（上次选过的 → 已有文献库 → 桌面/文档），
  // 否则 Windows 会停在上次用过的空目录里，用户一看是空的就以为功能没生效。
  const { dirs, pickedFiles } = await openFoldersDialog(defaultPickStartDir(instance));
  if (!dirs.length) return;
  if (pickedFiles > 0) {
    instance.pushToast('info', `已按文件所在的文件夹添加：${dirs[0]}`, undefined, 8000);
  }
  for (const dir of dirs) {
    try {
      const added = await instance.addRoot(dir);
      instance.pushToast('success', `已添加「${added.root.name}」`, `发现 ${added.added} 篇文献`, 6000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[litshelf] 添加文献失败', dir, err);
      instance.pushToast('error', '添加文献失败', message, 8000);
    }
  }
  showMainWindow();
}

async function exportLibraryViaMenu(instance: Host): Promise<void> {
  try {
    const result = await instance.exportLibrary({ format: 'bibtex', includeNotes: true });
    if (result.savedTo) {
      shell.showItemInFolder(result.savedTo);
      instance.pushToast('success', `已导出 ${result.count} 条文献（BibTeX）`, result.savedTo, 8000);
    } else {
      instance.pushToast('warn', '导出未产生文件', undefined, 6000);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[litshelf] 导出文献库失败', err);
    instance.pushToast('error', '导出失败', message, 8000);
  }
}

async function openDataDir(instance: Host): Promise<void> {
  const err = await shell.openPath(instance.dataDir);
  if (err) {
    console.error('[litshelf] 打开数据目录失败', instance.dataDir, err);
    instance.pushToast('error', '打开数据目录失败', err, 8000);
  }
}

function buildMenu(instance: Host): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '添加文献（选择文件，按所在文件夹入库）…', accelerator: 'CmdOrCtrl+O', click: () => void addFolderViaDialog(instance) },
        { label: '重新扫描', click: () => void instance.scanAll().catch((err) => console.error('[litshelf] 重新扫描失败', err)) },
        { label: '导出库…', click: () => void exportLibraryViaMenu(instance) },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'Alt+F4',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
        { type: 'separator' },
        // 注意：zoomIn/zoomOut/resetZoom 这三个 role 自带 Cmd/Ctrl +/-/0 加速键，会在主进程
        // 直接缩放整个 webContents，和阅读器自己的 Ctrl+滚轮 / Ctrl+= / Ctrl+- / Ctrl+0 叠加成
        // "双重缩放"（渲染层的 preventDefault 拦不住菜单加速键）。所以显式换成不冲突的加速键，
        // 主快捷键留给阅读器；菜单项仍可点，用来缩放界面本身。
        { label: '放大界面', accelerator: 'CmdOrCtrl+Shift+=', role: 'zoomIn' },
        { label: '缩小界面', accelerator: 'CmdOrCtrl+Shift+-', role: 'zoomOut' },
        { label: '界面实际大小', accelerator: 'CmdOrCtrl+Shift+0', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        { label: '开发者工具', accelerator: 'CmdOrCtrl+Shift+I', role: 'toggleDevTools' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开数据目录', click: () => void openDataDir(instance) },
        {
          label: '关于',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: '关于文献架',
              message: `文献架 LitShelf ${APP_VERSION}`,
              detail: [
                '本地文献阅读与管理软件：扫描你的文献文件夹，在软件内直接阅读 PDF。',
                '',
                `版本：${APP_VERSION}`,
                `Electron：${process.versions.electron}　Node：${process.versions.node}`,
                `数据目录：${instance.dataDir}`,
                `库内文献：${instance.stats().items} 篇`,
              ].join('\n'),
              buttons: ['好的'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- 启动

/**
 * 预载 pdf.js 在 Node 下的 fake worker。
 *
 * 背景：core/extract.ts 在加载 pdfjs 后会把 GlobalWorkerOptions.workerSrc 置为 ''，而 pdf.js v5 的
 * workerSrc getter 在值为空（"" 是假值）时会抛 `No "GlobalWorkerOptions.workerSrc" specified.`，
 * 于是所有 PDF 解析都会以 "Setting up fake worker failed" 结束。
 * 这里按 pdf.js 官方在 Node 里的做法，把 worker 模块挂到 globalThis.pdfjsWorker：loader 会优先
 * 使用它（主线程 handler），不再读 workerSrc。core 文件不在本次改动范围内，故在宿主启动时补齐。
 */
async function installPdfjsNodeWorker(): Promise<void> {
  const spec = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
  try {
    const worker = (await import(/* @vite-ignore */ spec)) as unknown;
    (globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
  } catch (err) {
    console.error('[litshelf] 预载 pdf.js worker 失败，PDF 解析可能不可用', err);
  }
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('com.litshelf.app');
  await installPdfjsNodeWorker();

  const instance = new Host({
    dataDir: app.getPath('userData'),
    mode: 'electron',
    version: APP_VERSION,
  });
  host = instance;
  // 先起 Host：窗口尺寸要从 settings.windowBounds 恢复，必须等 library 载入完成
  await instance.start();

  protocol.handle('litfile', (request) => handleLitfile(request));
  registerIpc(instance);

  mainWindow = await createWindow(instance);
  tray = createTray(instance);
  buildMenu(instance);

  console.log(`[litshelf] 已启动 v${APP_VERSION}（${instance.dataDir}）`);
  if (DEV_SERVER_URL) console.log(`[litshelf] 开发模式，渲染层来自 ${DEV_SERVER_URL}`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showMainWindow();
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 第二个实例：直接退出，由第一个实例负责聚焦
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return;
    // 托盘模式下窗口全关也不退出，用户从托盘菜单退出
    if (tray && host?.library.getSettings().minimizeToTray) return;
    app.quit();
  });

  app.on('before-quit', (event) => {
    quitting = true;
    if (hostStopped || !host) return;
    // 只拦一次：先把 Host 落盘（library / annotations / 笔记镜像），再真正退出
    event.preventDefault();
    const instance = host;
    void (async () => {
      try {
        await instance.stop();
      } catch (err) {
        console.error('[litshelf] 退出前保存失败', err);
      } finally {
        hostStopped = true;
        app.quit();
      }
    })();
  });

  app
    .whenReady()
    .then(bootstrap)
    .catch((err) => {
      console.error('[litshelf] 启动失败', err);
      dialog.showErrorBox('文献架启动失败', err instanceof Error ? err.message : String(err));
      app.exit(1);
    });
}

/**
 * 浏览器兜底形态：Node 原生 http 服务端（不引入任何新依赖）。
 *
 * 与 Electron 形态共享同一个 Host 与同一套方法白名单，端点语义一一对应：
 *   POST /api/invoke        {method, args} → {ok, result} | {ok, error}
 *   GET  /api/file/:id      PDF/文本/图片流，**支持 HTTP Range**（PDF.js 分块加载依赖它）
 *   GET  /api/thumb/:name   缩略图缓存
 *   GET  /api/events        SSE 事件流（宿主 → 渲染层）
 *   其它路径：开发态交给 Vite 中间件，生产态托管 dist/renderer（SPA 回退）
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connect, ViteDevServer } from 'vite';
import { Host } from '../core/host';
import { createSampleLibrary } from '../core/sample';
import type { Annotation, ExportOptions, Item, Settings } from '../shared/types';

/** 构建期由 scripts/build.mjs 的 define 注入 */
declare const __APP_VERSION__: string;

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
/** dist/server/index.mjs → 项目根 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RENDERER_DIR = path.join(PROJECT_ROOT, 'dist', 'renderer');
const IS_DEV = process.env.LITSHELF_DEV === '1';
const PORT = Number(process.env.LITSHELF_PORT || 7788);
const HOSTNAME = '127.0.0.1';

/** 与 Electron 形态共用同一份数据目录，可用 LITSHELF_DATA_DIR 覆盖 */
function resolveDataDir(): string {
  if (process.env.LITSHELF_DATA_DIR) return path.resolve(process.env.LITSHELF_DATA_DIR);
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, '文献架 LitShelf');
}

// ---------------------------------------------------------------- 参数窄化

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function obj<T extends object>(v: unknown): T {
  return v && typeof v === 'object' ? (v as T) : ({} as T);
}

// ---------------------------------------------------------------- 方法白名单
// 与 src/main/ipc.ts 的 HANDLERS 一一对应；浏览器形态没有系统对话框 / 资源管理器，
// 因此这几个方法返回固定值，由渲染层根据 capabilities() 决定是否展示相关入口。

type Handler = (host: Host, args: unknown[]) => unknown;

const HANDLERS: Record<string, Handler> = {
  getSnapshot: (host) => host.snapshot(),
  ready: (host) => host.snapshot(),
  capabilities: () => ({ nativeDialogs: false, revealInFolder: false, openPath: false, mode: 'web' as const }),

  pickFolder: () => {
    // 浏览器拿不到本地路径：让渲染层回退到"手动输入文件夹路径"
    throw new Error('浏览器形态下请手动输入文件夹路径');
  },
  addRoot: (host, [dir, opts]) => host.addRoot(str(dir), obj<{ depth?: number }>(opts)),
  removeRoot: (host, [rootId, opts]) => host.removeRoot(str(rootId), obj<{ forgetItems?: boolean }>(opts)),
  setRootEnabled: (host, [rootId, enabled]) => {
    host.setRootEnabled(str(rootId), bool(enabled, true));
    return null;
  },
  rescan: async (host, [rootId]) => {
    const id = str(rootId);
    if (id) await host.scanRoot(id);
    else await host.scanAll();
    return null;
  },
  rebindItem: (host, [itemId, newPath]) => host.rebindItem(str(itemId), str(newPath)),

  getItem: (host, [itemId]) => host.getItem(str(itemId)),
  updateItem: (host, [itemId, patch]) => host.updateItem(str(itemId), obj<Partial<Item>>(patch)),
  updateItems: (host, [ids, patch]) => host.updateItems(strList(ids), obj<Partial<Item>>(patch)),
  deleteItems: (host, [ids, opts]) => {
    host.deleteItems(strList(ids), obj<{ alsoDeleteFile?: boolean }>(opts));
    return null;
  },
  restoreItems: (host, [ids]) => host.restoreItems(strList(ids)),
  setReadState: (host, [ids, state]) => host.setReadState(strList(ids), str(state, 'unread') as Item['readState']),
  toggleStar: (host, [ids]) => host.toggleStar(strList(ids)),
  setProgress: (host, [itemId, progress]) => {
    host.setProgress(str(itemId), obj<Partial<Item['progress']>>(progress));
    return null;
  },
  markOpened: (host, [itemId]) => host.markOpened(str(itemId)),
  getFolderTree: (host) => host.getFolderTree(),

  listTags: (host) => host.listTags(),
  addTags: (host, [ids, tags]) => host.addTags(strList(ids), strList(tags)),
  removeTags: (host, [ids, tags]) => host.removeTags(strList(ids), strList(tags)),
  renameTag: (host, [from, to]) => {
    host.renameTag(str(from), str(to));
    return null;
  },
  deleteTag: (host, [tag]) => {
    host.deleteTag(str(tag));
    return null;
  },

  setNote: (host, [itemId, markdown]) => host.setNote(str(itemId), str(markdown)),
  listAnnotations: (host, [itemId]) => host.listAnnotations(str(itemId)),
  listAllAnnotations: (host) => host.listAllAnnotations(),
  addAnnotation: (host, [input]) =>
    host.addAnnotation(obj<Omit<Annotation, 'id' | 'createdAt' | 'updatedAt' | 'reanchored' | 'needsReview'> & { id?: string }>(input)),
  updateAnnotation: (host, [id, patch]) => host.updateAnnotation(str(id), obj<Partial<Annotation>>(patch)),
  deleteAnnotation: (host, [id]) => {
    host.deleteAnnotation(str(id));
    return null;
  },
  reanchorAnnotation: (host, [id, page, rects, text]) =>
    host.reanchorAnnotation(str(id), num(page, 1), (Array.isArray(rects) ? rects : []) as Annotation['rects'], typeof text === 'string' ? text : undefined),

  search: (host, [query, opts]) => host.search(str(query), num(obj<{ limit?: number }>(opts).limit, 300)),
  getItemText: (host, [itemId]) => host.getItemText(str(itemId)),
  indexItemText: (host, [itemId]) => host.indexItemText(str(itemId)),

  readTextFile: (host, [itemId]) => host.readTextFile(str(itemId)),
  saveThumb: (host, [itemId, dataUrl, revision]) => host.saveThumb(str(itemId), str(dataUrl), num(revision)),
  revealItem: () => false,
  openExternal: () => false,
  // 浏览器形态没有"写回真实 PDF"这件事（文件在宿主磁盘上），明确返回 null，界面会给提示
  exportAnnotatedPdf: () => null,
  openDataDir: () => false,

  completeMetadata: (host, [ids]) => host.completeMetadata(strList(ids)),

  exportLibrary: (host, [opts]) => host.exportLibrary(obj<ExportOptions>(opts)),
  copyCitation: (host, [itemId, style]) => host.copyCitation(str(itemId), str(style, 'gbt7714')),

  updateSettings: (host, [patch]) => host.updateSettings(obj<Partial<Settings>>(patch)),
  rebuildIndex: (host) => host.rebuildIndex(),
  clearCache: (host, [kind]) => host.clearCache(str(kind, 'all') as 'thumbs' | 'text' | 'all'),
  exportDiagnostics: (host) => host.exportDiagnostics(),
  getProgress: (host) => host.getProgress(),
  createSampleLibrary: async (host) => {
    const dir = path.join(os.homedir(), 'Documents', '文献架示例文献');
    const result = await createSampleLibrary(dir);
    await host.addRoot(result.dir);
    host.pushToast('success', `已生成 ${result.files} 个示例文件`, result.dir, 8000);
    return result;
  },

  // Host.undo(name) 目前只按名字匹配撤销栈；payload 由渲染层保留，宿主暂不使用。
  undo: (host, [name]) => host.undo(str(name)),
};

async function invokeHost(host: Host, method: string, args: unknown[]): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, method) ? HANDLERS[method] : undefined;
  if (!handler) return { ok: false, error: `未知的宿主方法：${method}` };
  try {
    const result = await handler(host, args);
    return { ok: true, result: result === undefined ? null : result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[litshelf] 调用 ${method} 失败`, err);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------- HTTP 工具

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  pdf: 'application/pdf',
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
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  bcmap: 'application/octet-stream',
  epub: 'application/epub+zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function mimeFor(filePath: string): string {
  const ext = (filePath.split('.').pop() ?? '').toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 解析 `Range: bytes=a-b`；返回 null 表示没有或不是合法区间 */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
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

/** 流式返回文件，支持 Range（206 + Content-Range） */
function streamFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string): void {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendJson(res, 404, { ok: false, error: '文件不存在' });
      return;
    }
    const size = stat.size;
    const range = parseRange(req.headers.range, size);
    const base: http.OutgoingHttpHeaders = {
      'Content-Type': mimeFor(filePath),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Last-Modified': stat.mtime.toUTCString(),
    };
    if (range) {
      res.writeHead(206, {
        ...base,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': String(range.end - range.start + 1),
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
      stream.on('error', (streamErr) => {
        console.error('[litshelf] 读取文件流失败', filePath, streamErr);
        res.destroy();
      });
      stream.pipe(res);
      return;
    }
    res.writeHead(200, { ...base, 'Content-Length': String(size) });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', (streamErr) => {
      console.error('[litshelf] 读取文件流失败', filePath, streamErr);
      res.destroy();
    });
    stream.pipe(res);
  });
}

function readBody(req: http.IncomingMessage, limit = 32 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 生产态静态托管 dist/renderer（SPA 回退到 index.html） */
function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { ok: false, error: '路径编码非法' });
    return;
  }
  const target = path.resolve(RENDERER_DIR, `.${rel}`);
  // 防目录穿越：必须落在 dist/renderer 之内
  if (!target.startsWith(RENDERER_DIR + path.sep) && target !== RENDERER_DIR) {
    sendJson(res, 403, { ok: false, error: '越权访问' });
    return;
  }
  fs.stat(target, (err, stat) => {
    if (!err && stat.isFile()) {
      streamFile(req, res, target);
      return;
    }
    // 看起来像静态资源（带扩展名）的请求不做 SPA 回退，否则浏览器会拿到 HTML 当 JS 用
    if (path.extname(target)) {
      sendJson(res, 404, { ok: false, error: `静态资源不存在：${rel}` });
      return;
    }
    const indexFile = path.join(RENDERER_DIR, 'index.html');
    fs.stat(indexFile, (indexErr, indexStat) => {
      if (indexErr || !indexStat.isFile()) {
        sendJson(res, 404, {
          ok: false,
          error: '渲染层产物不存在：请先运行 node scripts/build.mjs（或使用 pnpm dev:web 走 Vite 开发态）',
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME.html, 'Content-Length': String(indexStat.size), 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(indexFile).pipe(res);
    });
  });
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

async function main(): Promise<void> {
  await installPdfjsNodeWorker();
  const dataDir = resolveDataDir();
  const host = new Host({ dataDir, mode: 'web', version: APP_VERSION });
  await host.start();

  // 开发态：把 HTML/模块请求交给 Vite 中间件（HTML 入口由 Vite 处理）
  let vite: ViteDevServer | null = null;
  if (IS_DEV) {
    try {
      const { createServer } = await import('vite');
      vite = await createServer({
        configFile: path.join(PROJECT_ROOT, 'vite.config.ts'),
        server: { middlewareMode: true },
        appType: 'spa',
      });
      console.log('[litshelf] Vite 开发中间件已就绪');
    } catch (err) {
      console.error('[litshelf] Vite 开发服务器不可用（渲染层源码可能还没就绪），回退到 dist/renderer 静态托管', err);
      vite = null;
    }
  }

  const server = http.createServer((req, res) => {
    const handle = async (): Promise<void> => {
      let url: URL;
      try {
        url = new URL(req.url || '/', `http://${HOSTNAME}:${PORT}`);
      } catch {
        sendJson(res, 400, { ok: false, error: '非法 URL' });
        return;
      }
      const pathname = url.pathname;
      const method = req.method || 'GET';

      // ---- POST /api/invoke ----
      if (pathname === '/api/invoke' && (method === 'POST' || method === 'PUT')) {
        let payload: { method?: unknown; args?: unknown };
        try {
          payload = JSON.parse((await readBody(req)) || '{}') as { method?: unknown; args?: unknown };
        } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${(err as Error).message}` });
          return;
        }
        const name = str(payload.method);
        if (!name) {
          sendJson(res, 400, { ok: false, error: '缺少 method 字段' });
          return;
        }
        const result = await invokeHost(host, name, Array.isArray(payload.args) ? payload.args : []);
        sendJson(res, 200, result);
        return;
      }

      // ---- GET /api/file/:itemId?rev=N ----
      if (pathname.startsWith('/api/file/')) {
        const itemId = decodeURIComponent(pathname.slice('/api/file/'.length));
        const resolved = itemId ? host.resolveFile(itemId) : null;
        if (!resolved) {
          sendJson(res, 404, { ok: false, error: '文献不存在或文件已缺失' });
          return;
        }
        streamFile(req, res, resolved.path);
        return;
      }

      // ---- GET /api/thumb/:name ----
      if (pathname.startsWith('/api/thumb/')) {
        const name = decodeURIComponent(pathname.slice('/api/thumb/'.length));
        // 防目录穿越：只允许 thumbs 目录下的简单文件名
        if (!/^[\w.-]+$/.test(name)) {
          sendJson(res, 400, { ok: false, error: '非法缩略图名' });
          return;
        }
        streamFile(req, res, host.thumbPath(name));
        return;
      }

      // ---- GET /api/events（SSE）----
      if (pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        // 首帧补一个快照，避免渲染层在订阅前错过事件
        res.write(`data: ${JSON.stringify({ type: 'snapshot', snapshot: host.snapshot() })}\n\n`);
        const unsubscribe = host.subscribe((event) => {
          try {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch (err) {
            console.error('[litshelf] 推送事件失败', err);
          }
        });
        const heartbeat = setInterval(() => {
          res.write(': ping\n\n');
        }, 15000);
        const cleanup = (): void => {
          clearInterval(heartbeat);
          unsubscribe();
        };
        req.on('close', cleanup);
        res.on('close', cleanup);
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { ok: false, error: `未知接口：${pathname}` });
        return;
      }

      // ---- 静态资源 ----
      if (vite) {
        const next: Connect.NextFunction = (err?: unknown) => {
          if (err) {
            console.error('[litshelf] Vite 中间件出错', err);
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: '开发服务器内部错误' });
            return;
          }
          sendJson(res, 404, { ok: false, error: `未找到：${pathname}` });
        };
        vite.middlewares(req, res, next);
        return;
      }
      serveStatic(req, res, pathname);
    };

    handle().catch((err) => {
      console.error('[litshelf] 请求处理失败', req.method, req.url, err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      else res.destroy();
    });
  });

  server.on('error', (err) => {
    console.error(`[litshelf] 监听 ${HOSTNAME}:${PORT} 失败`, err);
    process.exitCode = 1;
  });

  await new Promise<void>((resolve) => {
    server.listen(PORT, HOSTNAME, () => {
      console.log(`文献架（浏览器形态）已启动：http://${HOSTNAME}:${PORT}`);
      console.log(`[litshelf] 数据目录：${dataDir}　模式：${IS_DEV ? 'dev' : 'prod'}　版本：${APP_VERSION}`);
      resolve();
    });
  });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`\n[litshelf] 收到 ${signal}，正在保存并退出…`);
    const done = async (): Promise<void> => {
      try {
        await host.stop();
      } catch (err) {
        console.error('[litshelf] 退出前保存失败', err);
      }
      process.exit(0);
    };
    server.close(() => void done());
    // 兜底：SSE 长连接可能让 close 迟迟不回调
    setTimeout(() => void done(), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[litshelf] 服务启动失败', err);
  process.exit(1);
});

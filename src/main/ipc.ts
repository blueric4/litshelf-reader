/**
 * Electron 主进程的 IPC 路由。
 *
 * 渲染层只认一个通道 `litshelf:invoke`，载荷形如 `{ method, args }`。
 * 这里用**白名单表**把 method 名映射到 Host 方法或宿主能力：绝不用
 * `host[method](...)` 这种动态取值，避免渲染层（或注入的脚本）调用任意方法。
 *
 * 返回信封：成功 `{ ok: true, result }`，失败 `{ ok: false, error }`。
 * 浏览器形态（src/server/index.ts）实现同一套语义，二者必须保持一致。
 */
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron';
import type { Host } from '../core/host';
import { createSampleLibrary } from '../core/sample';
import { IPC } from '../shared/api';
import type { Annotation, ExportOptions, Item, Settings } from '../shared/types';

/** 成功/失败信封 */
export type InvokeEnvelope = { ok: true; result: unknown } | { ok: false; error: string };

interface Ctx {
  host: Host;
}

// ---------------------------------------------------------------- 参数窄化
// IPC 来的都是 unknown，这里做最小可用校验：类型不对就给一个安全的默认值，
// 真正的业务校验仍由 Host 负责。

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

/**
 * 系统对话框：让用户挑文献。
 *
 * 为什么要用**文件对话框**而不是"选文件夹"：
 *   - 只给 `openDirectory` 时，Windows 的选择框里**一个文件都不列**（用户看到的是
 *     "没有与搜索条件匹配的项"，很容易以为找错文件夹了）；
 *   - 同时给 `openFile + openDirectory` **也不行**：`openDirectory` 会把对话框变成
 *     "只选文件夹"模式（FOS_PICKFOLDERS），文件照样不显示 —— 实测在 Windows 上就是如此。
 * 所以这里给**纯文件**对话框 + 类型筛选：列表里能直接看到 PDF/Word/Markdown/TXT，
 * 用户点一个（或多选），我们就用**它所在的文件夹**作为文献库。
 * "只想选一个还没有文献的文件夹"的场景，界面里另有「手动填写路径」入口。
 */
export interface PickedFolders {
  dirs: string[];
  /** 用户选了几个文件（>0 时给个提示，让他知道按所在文件夹处理了） */
  pickedFiles: number;
}

/** 上次成功选过的目录（本次会话内记住，用户再来一次时直接停在那儿） */
let lastPickDir = '';

/**
 * 对话框的起始目录，按优先级：
 *   ① 本次会话里上一次选过的目录；
 *   ② 已有的第一个文献库（用户多半想加它旁边的东西）；
 *   ③ **桌面**优先，其次「文档」，最后用户主目录。
 *
 * 为什么桌面优先：独立复现发现，全新用户（还没有任何文献库）时如果兜底在「文档」，
 * 而他的文献其实放在桌面，打开对话框第一眼还是"什么都没有"，看起来就像功能没修好。
 * 桌面上放文献/资料的人非常多，所以这里先桌面。
 */
export function fallbackStartDir(): string | undefined {
  for (const key of ['desktop', 'documents', 'home'] as const) {
    try {
      const p = app.getPath(key);
      if (p) return p;
    } catch {
      /* 试下一个 */
    }
  }
  return undefined;
}

function rememberPickDir(host: { snapshot: () => { roots: { path: string }[] } }): string | undefined {
  if (lastPickDir) return lastPickDir;
  try {
    const roots = host.snapshot().roots;
    if (roots.length && roots[0].path) return roots[0].path;
  } catch {
    /* 拿不到就用系统目录 */
  }
  return fallbackStartDir();
}

/** 菜单/托盘那条路径也用同一套起始目录规则（导出给 main/index.ts） */
export function defaultPickStartDir(host: { snapshot: () => { roots: { path: string }[] } }): string | undefined {
  return rememberPickDir(host);
}

export async function openFoldersDialog(defaultPath?: string): Promise<PickedFolders> {
  const options: Electron.OpenDialogOptions = {
    title: '选择文献（可多选；会按文件所在的文件夹添加）',
    buttonLabel: '添加',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '文献文件', extensions: ['pdf', 'docx', 'doc', 'md', 'markdown', 'txt', 'html', 'htm'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    // 关键：一定要给 defaultPath。不给的话 Windows 会记住"上一次用过的目录"，
    // 很可能是一个空目录（实测会停在下 载/桌面这种地方）——用户打开对话框看到空列表，
    // 就会以为"还是看不到文献"。
    ...(defaultPath ? { defaultPath } : {}),
  };
  const win = BrowserWindow.getFocusedWindow();
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths.length) return { dirs: [], pickedFiles: 0 };
  const picked: PickedPath[] = [];
  for (const p of result.filePaths) {
    const st = await stat(p).catch(() => null);
    picked.push({ path: p, isDirectory: !!st?.isDirectory() });
  }
  return foldersFromPicked(picked);
}

export interface PickedPath {
  path: string;
  isDirectory: boolean;
}

/**
 * 纯函数：把用户选中的路径折算成"要添加的文献库文件夹"。
 *   - 选的是文件夹 → 就用它；
 *   - 选的是文件 → 用**它所在的文件夹**（这就是"在对话框里直接看到 PDF 并点它"的语义）；
 *   - 去重，保持顺序。
 * 单独抽出来是为了能单测（对话框本身没法在 CI 里点）。
 */
export function foldersFromPicked(picked: PickedPath[]): PickedFolders {
  const dirs: string[] = [];
  let pickedFiles = 0;
  for (const item of picked) {
    if (item.isDirectory) {
      dirs.push(item.path);
    } else {
      pickedFiles += 1;
      dirs.push(path.dirname(item.path));
    }
  }
  return { dirs: [...new Set(dirs)], pickedFiles };
}

// ---------------------------------------------------------------- 白名单
// 键 = src/shared/api.ts 里 Api 的方法名（不含 subscribe / ready / fileUrl）。

type Handler = (ctx: Ctx, args: unknown[]) => unknown;

const HANDLERS: Record<string, Handler> = {
  // ---- 快照与能力 ----
  getSnapshot: ({ host }) => host.snapshot(),
  ready: ({ host }) => host.snapshot(),
  capabilities: () => ({ nativeDialogs: true, revealInFolder: true, openPath: true, mode: 'electron' as const }),

  // ---- 根目录 ----
  pickFolder: async ({ host }) => {
    const { dirs, pickedFiles } = await openFoldersDialog(rememberPickDir(host));
    if (dirs[0]) lastPickDir = dirs[0];
    if (pickedFiles > 0 && dirs[0]) {
      host.pushToast('info', `已按文件所在的文件夹添加：${dirs[0]}`, undefined, 8000);
    }
    return dirs;
  },
  addRoot: ({ host }, [dir, opts]) => host.addRoot(str(dir), obj<{ depth?: number }>(opts)),
  removeRoot: ({ host }, [rootId, opts]) => host.removeRoot(str(rootId), obj<{ forgetItems?: boolean }>(opts)),
  setRootEnabled: ({ host }, [rootId, enabled]) => {
    host.setRootEnabled(str(rootId), bool(enabled, true));
    return null;
  },
  rescan: async ({ host }, [rootId]) => {
    const id = str(rootId);
    if (id) await host.scanRoot(id);
    else await host.scanAll();
    return null;
  },
  rebindItem: ({ host }, [itemId, newPath]) => host.rebindItem(str(itemId), str(newPath)),

  // ---- 条目 ----
  getItem: ({ host }, [itemId]) => host.getItem(str(itemId)),
  updateItem: ({ host }, [itemId, patch]) => host.updateItem(str(itemId), obj<Partial<Item>>(patch)),
  updateItems: ({ host }, [ids, patch]) => host.updateItems(strList(ids), obj<Partial<Item>>(patch)),
  deleteItems: ({ host }, [ids, opts]) => {
    host.deleteItems(strList(ids), obj<{ alsoDeleteFile?: boolean }>(opts));
    return null;
  },
  restoreItems: ({ host }, [ids]) => host.restoreItems(strList(ids)),
  setReadState: ({ host }, [ids, state]) => host.setReadState(strList(ids), (str(state, 'unread') as Item['readState'])),
  toggleStar: ({ host }, [ids]) => host.toggleStar(strList(ids)),
  setProgress: ({ host }, [itemId, progress]) => {
    host.setProgress(str(itemId), obj<Partial<Item['progress']>>(progress));
    return null;
  },
  markOpened: ({ host }, [itemId]) => host.markOpened(str(itemId)),
  getFolderTree: ({ host }) => host.getFolderTree(),

  // ---- 标签 ----
  listTags: ({ host }) => host.listTags(),
  addTags: ({ host }, [ids, tags]) => host.addTags(strList(ids), strList(tags)),
  removeTags: ({ host }, [ids, tags]) => host.removeTags(strList(ids), strList(tags)),
  renameTag: ({ host }, [from, to]) => {
    host.renameTag(str(from), str(to));
    return null;
  },
  deleteTag: ({ host }, [tag]) => {
    host.deleteTag(str(tag));
    return null;
  },

  // ---- 笔记与批注 ----
  setNote: ({ host }, [itemId, markdown]) => host.setNote(str(itemId), str(markdown)),
  listAnnotations: ({ host }, [itemId]) => host.listAnnotations(str(itemId)),
  listAllAnnotations: ({ host }) => host.listAllAnnotations(),
  addAnnotation: ({ host }, [input]) =>
    host.addAnnotation(obj<Omit<Annotation, 'id' | 'createdAt' | 'updatedAt' | 'reanchored' | 'needsReview'> & { id?: string }>(input)),
  updateAnnotation: ({ host }, [id, patch]) => host.updateAnnotation(str(id), obj<Partial<Annotation>>(patch)),
  deleteAnnotation: ({ host }, [id]) => {
    host.deleteAnnotation(str(id));
    return null;
  },
  reanchorAnnotation: ({ host }, [id, page, rects, text]) =>
    host.reanchorAnnotation(str(id), num(page, 1), (Array.isArray(rects) ? rects : []) as Annotation['rects'], typeof text === 'string' ? text : undefined),

  // ---- 检索 ----
  search: ({ host }, [query, opts]) => host.search(str(query), num(obj<{ limit?: number }>(opts).limit, 300)),
  getItemText: ({ host }, [itemId]) => host.getItemText(str(itemId)),
  indexItemText: ({ host }, [itemId]) => host.indexItemText(str(itemId)),

  // ---- 文件访问 ----
  readTextFile: ({ host }, [itemId]) => host.readTextFile(str(itemId)),
  saveThumb: ({ host }, [itemId, dataUrl, revision]) => host.saveThumb(str(itemId), str(dataUrl), num(revision)),
  revealItem: ({ host }, [itemId]) => {
    const file = host.resolveFile(str(itemId));
    if (!file) return false;
    shell.showItemInFolder(file.path);
    return true;
  },
  openExternal: async ({ host }, [itemId]) => {
    const file = host.resolveFile(str(itemId));
    if (!file) return false;
    const err = await shell.openPath(file.path);
    if (err) {
      console.error('[litshelf] 打开文件失败', file.path, err);
      return false;
    }
    return true;
  },
  exportAnnotatedPdf: async ({ host }, [itemId]) => {
    const result = await host.exportAnnotatedPdf(str(itemId));
    if (result && result.written > 0) {
      host.pushToast('success', `已导出带批注的 PDF 副本（${result.written} 条批注）`, result.path, 9000);
    } else if (result) {
      host.pushToast('info', '这篇还没有可写回的批注', result.path, 7000);
    }
    return result;
  },
  openDataDir: async ({ host }) => {
    const err = await shell.openPath(host.dataDir);
    if (err) {
      console.error('[litshelf] 打开数据目录失败', host.dataDir, err);
      return false;
    }
    return true;
  },

  // ---- 元数据 ----
  completeMetadata: ({ host }, [ids]) => host.completeMetadata(strList(ids)),

  // ---- 导出 ----
  exportLibrary: ({ host }, [opts]) => host.exportLibrary(obj<ExportOptions>(opts)),
  copyCitation: ({ host }, [itemId, style]) => {
    const text = host.copyCitation(str(itemId), str(style, 'gbt7714'));
    if (text) clipboard.writeText(text);
    return text;
  },

  // ---- 设置与维护 ----
  updateSettings: ({ host }, [patch]) => host.updateSettings(obj<Partial<Settings>>(patch)),
  rebuildIndex: ({ host }) => host.rebuildIndex(),
  clearCache: ({ host }, [kind]) => host.clearCache((str(kind, 'all') as 'thumbs' | 'text' | 'all')),
  exportDiagnostics: ({ host }) => host.exportDiagnostics(),
  getProgress: ({ host }) => host.getProgress(),
  createSampleLibrary: async ({ host }) => {
    // 生成到"文档"目录，用户可以随时自己删掉；生成完直接加为文献库根目录
    const dir = path.join(app.getPath('documents'), '文献架示例文献');
    const result = await createSampleLibrary(dir);
    await host.addRoot(result.dir);
    host.pushToast('success', `已生成 ${result.files} 个示例文件`, result.dir, 8000);
    return result;
  },

  // ---- 撤销 ----
  // Host.undo(name) 目前只按名字匹配撤销栈；payload 由渲染层保留，宿主暂不使用。
  undo: ({ host }, [name]) => host.undo(str(name)),

  /**
   * **只写诊断文件**（把渲染层的内部结构 dump 到 tmp/sel-harness/）。
   *
   * 为什么需要它：调试划词时，"模型内部的行/块结构"这种大对象经 CDP 返回会被截断成
   * undefined（我为此白查过好几轮）；写文件没有大小限制。
   * 安全边界：只允许写到 `<cwd>/tmp/sel-harness/` 下、只接受 .json 文件名，
   * 不读文件、不执行任何东西。
   */
  writeDiag: (_ctx, [name, json]) => {
    const safeName = str(name).replace(/[^A-Za-z0-9._-]/g, '');
    if (!safeName.endsWith('.json')) return { ok: false, error: '只允许 .json' };
    const dir = path.join(process.cwd(), 'tmp', 'sel-harness');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, safeName), str(json), 'utf8');
    return { ok: true, file: path.join(dir, safeName) };
  },
};

/** 供主进程与调试使用：当前白名单覆盖的方法名 */
export function supportedMethods(): string[] {
  return Object.keys(HANDLERS).sort();
}

/** 统一的调用入口（Web 形态复用同一套语义） */
export async function invokeHost(host: Host, method: string, args: unknown[]): Promise<InvokeEnvelope> {
  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, method) ? HANDLERS[method] : undefined;
  if (!handler) return { ok: false, error: `未知的宿主方法：${method}` };
  try {
    const result = await handler({ host }, args);
    return { ok: true, result: result === undefined ? null : result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[litshelf] 调用 ${method} 失败`, err);
    return { ok: false, error: message };
  }
}

/**
 * 注册 IPC：invoke 通道 + 宿主事件广播。
 * 返回取消订阅函数（退出时清理）。
 */
export function registerIpc(host: Host): () => void {
  ipcMain.handle(IPC.invoke, async (_event, payload: unknown): Promise<InvokeEnvelope> => {
    const raw = obj<{ method?: unknown; args?: unknown }>(payload);
    const method = str(raw.method);
    if (!method) return { ok: false, error: '缺少 method 字段' };
    const args = Array.isArray(raw.args) ? raw.args : [];
    return invokeHost(host, method, args);
  });

  // 宿主事件 → 所有窗口。窗口可能在事件到达时已经销毁，必须逐个判活。
  const unsubscribe = host.subscribe((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(IPC.event, event);
    }
  });

  return () => {
    unsubscribe();
    ipcMain.removeHandler(IPC.invoke);
  };
}

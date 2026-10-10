/**
 * 文献架 LitShelf · 宿主 API 契约
 * Electron 形态走 IPC，浏览器形态走 HTTP，二者语义完全一致（见 renderer/bridge.ts）。
 */
import type {
  Annotation,
  ExportOptions,
  Item,
  LibrarySnapshot,
  Root,
  ScanProgress,
  SearchResult,
  Settings,
  Toast,
} from './types';

export interface AddRootResult {
  root: Root;
  added: number;
}

export interface Api {
  /** 首帧全量快照 */
  getSnapshot(): Promise<LibrarySnapshot>;
  /** 平台能力：Electron 形态支持系统对话框 / 在文件夹中显示 */
  capabilities(): Promise<{ nativeDialogs: boolean; revealInFolder: boolean; openPath: boolean; mode: 'electron' | 'web' }>;

  // ---- 文献库根目录 ----
  pickFolder(): Promise<string[]>;
  addRoot(path: string, opts?: { depth?: number }): Promise<AddRootResult>;
  removeRoot(rootId: string, opts?: { forgetItems?: boolean }): Promise<void>;
  setRootEnabled(rootId: string, enabled: boolean): Promise<void>;
  rescan(rootId?: string): Promise<void>;
  /** 手动把已有条目重新绑定到新路径（文件缺失后"重新定位"） */
  rebindItem(itemId: string, newPath: string): Promise<Item | null>;

  // ---- 条目 ----
  getItem(itemId: string): Promise<Item | null>;
  updateItem(itemId: string, patch: Partial<Item>): Promise<Item>;
  updateItems(ids: string[], patch: Partial<Item>): Promise<Item[]>;
  deleteItems(ids: string[], opts?: { alsoDeleteFile?: boolean }): Promise<void>;
  restoreItems(ids: string[]): Promise<void>;
  setReadState(ids: string[], state: Item['readState']): Promise<Item[]>;
  toggleStar(ids: string[]): Promise<Item[]>;
  setProgress(itemId: string, progress: Partial<Item['progress']>): Promise<void>;
  markOpened(itemId: string): Promise<Item>;
  /** 目录树（按根目录分组的相对目录） */
  getFolderTree(): Promise<{ rootId: string; rootName: string; rootPath: string; dirs: string[] }[]>;

  // ---- 标签 ----
  listTags(): Promise<string[]>;
  addTags(ids: string[], tags: string[]): Promise<Item[]>;
  removeTags(ids: string[], tags: string[]): Promise<Item[]>;
  renameTag(from: string, to: string): Promise<void>;
  deleteTag(tag: string): Promise<void>;

  // ---- 笔记与批注 ----
  setNote(itemId: string, markdown: string): Promise<Item>;
  listAnnotations(itemId: string): Promise<Annotation[]>;
  /** 一次取全库批注（用于"有批注"智能集合与全局搜索） */
  listAllAnnotations(): Promise<Annotation[]>;
  addAnnotation(input: Omit<Annotation, 'id' | 'createdAt' | 'updatedAt' | 'reanchored' | 'needsReview'> & { id?: string }): Promise<Annotation>;
  updateAnnotation(id: string, patch: Partial<Annotation>): Promise<Annotation | null>;
  deleteAnnotation(id: string): Promise<void>;
  reanchorAnnotation(id: string, page: number, rects: Annotation['rects'], text?: string): Promise<Annotation | null>;

  // ---- 检索 ----
  search(query: string, opts?: { limit?: number }): Promise<SearchResult[]>;
  /** 取某篇的正文页文本（全文检索面板 / 库内全文搜索用），未索引则返回 null */
  getItemText(itemId: string): Promise<{ pages: string[]; indexedAt: number } | null>;
  /** 立即为某篇建立/刷新全文索引 */
  indexItemText(itemId: string): Promise<{ ok: boolean; pages: number }>;

  // ---- 文件访问 ----
  /** 可直接喂给 pdf.js / <img> / fetch 的 URL（Electron 为 litfile://，Web 为 /api/file/<id>） */
  fileUrl(itemId: string, rev?: number): string;
  /** 小文本文件内容（md/txt/html），大文件请走 fileUrl */
  readTextFile(itemId: string): Promise<{ text: string; encoding: string } | null>;
  /** 保存一段二进制（用于渲染层生成的缩略图回写缓存） */
  saveThumb(itemId: string, dataUrl: string, revision: number): Promise<string | null>;
  revealItem(itemId: string): Promise<boolean>;
  openExternal(itemId: string): Promise<boolean>;
  openDataDir(): Promise<boolean>;

  // ---- 元数据 ----
  /** 手动触发联网补全（Crossref / arXiv） */
  completeMetadata(ids: string[]): Promise<{ updated: number; failed: number; skipped: number }>;

  // ---- 导出 ----
  exportLibrary(opts: ExportOptions): Promise<{ ok: boolean; content?: string; savedTo?: string; count: number }>;
  copyCitation(itemId: string, style: string): Promise<string>;

  // ---- 设置与维护 ----
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  rebuildIndex(): Promise<void>;
  clearCache(kind: 'thumbs' | 'text' | 'all'): Promise<void>;
  exportDiagnostics(): Promise<{ ok: boolean; savedTo?: string; content?: string }>;
  getProgress(): Promise<ScanProgress>;
  /** 生成示例文献（设置页 / 引导页用） */
  createSampleLibrary(): Promise<{ dir: string; files: number }>;

  // ---- 撤销 ----
  undo(name: string, payload?: unknown): Promise<boolean>;

  // ---- 宿主 -> 渲染层事件 ----
  subscribe(listener: (event: import('./types').HostEvent) => void): () => void;
  /** 渲染层就绪后调用一次，宿主补发快照 */
  ready(): Promise<LibrarySnapshot>;
}

export const IPC = {
  invoke: 'litshelf:invoke',
  event: 'litshelf:event',
} as const;

export type ApiMethod = keyof Omit<Api, 'subscribe' | 'ready' | 'fileUrl'>;

export const TOAST_DEFAULT_TTL = 5200;

/**
 * 文献架 LitShelf · 共享类型（主进程 / 后端 / 渲染层三方共用）
 * 该文件是接口契约，改动需同步 core / main / server / renderer。
 */

export type ItemKind =
  | 'pdf'
  | 'markdown'
  | 'text'
  | 'html'
  | 'image'
  | 'docx'
  | 'epub'
  | 'other';

export type ReadState = 'unread' | 'reading' | 'read';

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple';

export type ParseState = 'placeholder' | 'indexed' | 'ready' | 'failed';

export interface ReadingProgress {
  /** 上次阅读页码（1 起） */
  page: number;
  total: number;
  /** 0-100 */
  percent: number;
  /** 页内滚动位置（0-1） */
  scrollTop: number;
  zoom: number;
  updatedAt: number;
}

export interface Item {
  id: string;
  rootId: string;
  /** 绝对路径 */
  path: string;
  /** 相对根目录的路径 */
  relPath: string;
  /** 相对根目录的所在目录（'' 表示根目录本身） */
  dir: string;
  /** 文件名（含扩展名） */
  name: string;
  /** 小写扩展名，不含点 */
  ext: string;
  kind: ItemKind;
  /** 是否可内置阅读 */
  readable: boolean;
  size: number;
  mtime: number;
  ctime: number;
  /** 分块内容指纹，用于识别改名 / 移动 */
  fingerprint: string;

  // ---- 元数据 ----
  title: string;
  authors: string[];
  year: number | null;
  venue: string;
  volume: string;
  issue: string;
  pages: string;
  doi: string;
  arxivId: string;
  url: string;
  abstract: string;
  keywords: string[];
  language: string;
  pageCount: number;
  wordCount: number;
  /** 首页 / 开头文本摘要，用于列表与搜索 */
  excerpt: string;

  // ---- 用户数据 ----
  tags: string[];
  collections: string[];
  colorTag: string;
  starred: boolean;
  readState: ReadState;
  progress: ReadingProgress;
  /** Markdown 笔记（同时镜像到 notes/<id>.md） */
  note: string;
  annotationCount: number;
  /** 被用户手工编辑过、扫描时不得覆盖的字段名 */
  userEdited: string[];

  // ---- 状态 ----
  missing: boolean;
  missingSince: number | null;
  addedAt: number;
  lastOpenedAt: number | null;
  openCount: number;
  /** 缩略图缓存文件名（相对 cache/thumbs） */
  thumb: string | null;
  parseState: ParseState;
  parseError?: string;
  /** 全文是否已索引 */
  textIndexed: boolean;
  /** 最近一次内容版本（指纹变化计数），用于批注重定位判定 */
  revision: number;
}

export interface AnnotationAnchor {
  prefix: string;
  suffix: string;
  occurrence: number;
}

export interface AnnotationRect {
  /** 相对页面宽高的比例，缩放安全 */
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AnnotationType =
  | 'highlight'
  | 'underline'
  | 'squiggly'
  | 'strikeout'
  | 'note'
  | 'bookmark';

export interface Annotation {
  id: string;
  itemId: string;
  type: AnnotationType;
  /** 原文页码（1 起）；重定位后会被更新 */
  page: number;
  rects: AnnotationRect[];
  /** 被标注的原文 */
  text: string;
  anchor: AnnotationAnchor;
  comment: string;
  color: HighlightColor;
  /** 文件内容变化后是否被重新定位过 */
  reanchored: boolean;
  /** 需要人工确认（重定位失败） */
  needsReview: boolean;
  reanchorNote?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Root {
  id: string;
  /** 绝对路径 */
  path: string;
  name: string;
  enabled: boolean;
  /** 递归深度上限（1 = 仅本层） */
  depth: number;
  addedAt: number;
  lastScanAt: number | null;
  /** 根目录当前是否可访问 */
  available: boolean;
  itemCount: number;
}

/** 侧栏里默认不显示、需要在设置里打开的筛选项 */
export type SidebarExtraFilter = 'unread' | 'toread' | 'annotated' | 'noted' | 'missing';

/** 全部合法的侧栏额外筛选项（顺序与侧栏里一致） */
export const SIDEBAR_EXTRA_FILTERS: readonly SidebarExtraFilter[] = ['unread', 'toread', 'annotated', 'noted', 'missing'];

/**
 * 归一化 `sidebarExtraFilters`：settings.json 可能被手改成非数组（例如 42）或塞进未知字符串。
 * 这里统一收敛成"合法 key、按标准顺序"的数组——消费方直接 `.includes()` 也不会抛错
 * （渲染层没有错误边界，抛了就是白屏）。
 */
export function normalizeSidebarExtraFilters(value: unknown): SidebarExtraFilter[] {
  if (!Array.isArray(value)) return [];
  return SIDEBAR_EXTRA_FILTERS.filter((key) => value.includes(key));
}

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  density: 'compact' | 'comfortable';
  listView: 'list' | 'comfortable' | 'grid';
  groupBy: 'none' | 'read' | 'folder' | 'year' | 'tag' | 'added';
  sortKey: 'added' | 'title' | 'author' | 'year' | 'opened' | 'mtime' | 'size' | 'progress';
  sortDir: 'asc' | 'desc';

  defaultZoom: 'fit-width' | 'fit-page' | number;
  readerLayout: 'continuous' | 'single' | 'double';
  readerTheme: 'light' | 'sepia' | 'dark';
  readerAnimation: boolean;
  annotationColor: HighlightColor;

  fullTextIndex: 'opened-only' | 'all' | 'off';
  thumbnails: boolean;
  concurrency: number;
  onlineMetadata: boolean;
  /** 联网补全是否自动执行（默认 false，需要手动点） */
  autoMetadata: boolean;
  /** 是否收录非文献类文件（.zip/.exe 等） */
  includeOtherFiles: boolean;
  /** 一致性巡检间隔（ms），0 = 关闭 */
  reconcileIntervalMs: number;
  minimizeToTray: boolean;
  showSampleData: boolean;
  /**
   * 侧栏里额外显示的筛选项。
   * 默认只显示「全部文献 / 最近添加 / 在读 / 星标」四项，其余的要用户自己打开；
   * 老 settings.json 没有这个字段时由 DEFAULT_SETTINGS 兜成 []。
   */
  sidebarExtraFilters: SidebarExtraFilter[];

  sidebarWidth: number;
  listWidth: number;
  windowBounds: { x?: number; y?: number; width: number; height: number; maximized?: boolean };
  lastOpenedItemId: string | null;
  lastView: 'library' | 'reader' | 'settings';
  onboardingDone: boolean;
}

export interface ScanProgress {
  active: boolean;
  phase: 'idle' | 'discovering' | 'hashing' | 'extracting' | 'thumbnails' | 'done';
  discovered: number;
  processed: number;
  total: number;
  currentPath: string;
  rootId: string | null;
  startedAt: number;
  finishedAt: number | null;
  errors: number;
}

export interface LibrarySnapshot {
  items: Item[];
  roots: Root[];
  settings: Settings;
  tags: string[];
  progress: ScanProgress;
  platform: string;
  mode: 'electron' | 'web';
  dataDir: string;
  version: string;
}

export type ToastKind = 'info' | 'success' | 'warn' | 'error' | 'undo';

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  detail?: string;
  /** 可点击定位到的条目 */
  itemIds?: string[];
  /** 可撤销动作标识 */
  action?: { label: string; name: string; payload?: unknown };
  createdAt: number;
  ttl: number;
}

export type HostEvent =
  | { type: 'snapshot'; snapshot: LibrarySnapshot }
  | { type: 'items:patch'; items: Item[] }
  | { type: 'items:remove'; ids: string[] }
  | { type: 'roots:update'; roots: Root[] }
  | { type: 'settings:update'; settings: Settings }
  | { type: 'tags:update'; tags: string[] }
  | { type: 'scan:progress'; progress: ScanProgress }
  | { type: 'toast'; toast: Toast }
  | { type: 'open-item'; itemId: string; page?: number; annotationId?: string };

export type SearchSyntaxKey =
  | 'tag'
  | 'author'
  | 'year'
  | 'is'
  | 'kind'
  | 'ext'
  | 'title'
  | 'doi'
  | 'note'
  | 'ann';

export interface SearchHitContext {
  page?: number;
  snippet: string;
}

export interface SearchResult {
  item: Item;
  score: number;
  /** 命中的字段名，用于 UI 展示"命中：标题 / 笔记 / 正文 P12" */
  fields: string[];
  contexts: SearchHitContext[];
}

export interface ExportOptions {
  format: 'bibtex' | 'ris' | 'csljson' | 'csv' | 'markdown-notes';
  ids?: string[];
  /** 仅导出元数据 / 含笔记批注 */
  includeNotes?: boolean;
}

export interface CitationStyle {
  id: 'gbt7714' | 'apa' | 'ieee' | 'mla';
  label: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  density: 'comfortable',
  listView: 'list',
  groupBy: 'none',
  sortKey: 'added',
  sortDir: 'desc',
  defaultZoom: 'fit-width',
  readerLayout: 'continuous',
  readerTheme: 'light',
  readerAnimation: true,
  annotationColor: 'yellow',
  fullTextIndex: 'opened-only',
  thumbnails: true,
  concurrency: 4,
  onlineMetadata: true,
  autoMetadata: false,
  includeOtherFiles: false,
  reconcileIntervalMs: 5 * 60 * 1000,
  minimizeToTray: true,
  showSampleData: false,
  sidebarExtraFilters: [],
  sidebarWidth: 240,
  listWidth: 380,
  windowBounds: { width: 1440, height: 900 },
  lastOpenedItemId: null,
  lastView: 'library',
  onboardingDone: false,
};

export const KIND_BY_EXT: Record<string, ItemKind> = {
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  txt: 'text',
  text: 'text',
  log: 'text',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  bmp: 'image',
  tif: 'image',
  tiff: 'image',
  avif: 'image',
  docx: 'docx',
  epub: 'epub',
};

export const READABLE_KINDS: ItemKind[] = ['pdf', 'markdown', 'text', 'html', 'image', 'docx', 'epub'];

export const HIGHLIGHT_COLORS: Record<HighlightColor, { label: string; light: string; dark: string }> = {
  yellow: { label: '黄', light: '#FFE066', dark: '#8a7420' },
  green: { label: '绿', light: '#B7F0B1', dark: '#2f6b34' },
  blue: { label: '蓝', light: '#A9D6FF', dark: '#2b5a86' },
  pink: { label: '粉', light: '#FFC2D1', dark: '#7d3c50' },
  purple: { label: '紫', light: '#D9C7FF', dark: '#543f7d' },
};

export const TAG_COLORS = [
  '#FF3B30',
  '#FF9500',
  '#FFCC00',
  '#34C759',
  '#32ADE6',
  '#007AFF',
  '#AF52DE',
  '#FF2D55',
  '#8E8E93',
];

/** 依据扩展名 / 类型判断可读性 */
export function kindOf(ext: string): ItemKind {
  return KIND_BY_EXT[ext.replace(/^\./, '').toLowerCase()] ?? 'other';
}

export function isReadable(kind: ItemKind): boolean {
  return READABLE_KINDS.includes(kind);
}

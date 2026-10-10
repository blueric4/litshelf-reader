/**
 * 文献库域模型 + 文件系统对账（本软件的核心）。
 *
 * 设计要点：
 * 1. 文件系统是唯一真相，库索引只是缓存 + 用户数据容器。
 * 2. 用户数据（标签/星标/笔记/进度/手改字段）永不因重新扫描而丢失。
 * 3. 改名 / 移动靠内容指纹识别：路径变了但指纹相同 → 原地改路径，保留 id 与全部用户数据。
 * 4. 删除只标记 missing，不删条目；文件回来自动复活。
 * 5. 同路径内容变了 → revision+1，用户手改字段保留，批注交给上层重定位。
 */
import fsSync from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  kindOf,
  isReadable,
  type Item,
  type ItemKind,
  type LibrarySnapshot,
  type ReadingProgress,
  type Root,
  type Settings,
} from '../shared/types';
import { JsonFile } from './store';
import { baseNameNoExt, extOf, longPath, relativize, shortId } from './paths';
import { guessFromFileName, sanitizeTitle, titleQuality } from './naming';
import { statSafe } from './fsutil';

export interface StoredLibrary {
  version: number;
  items: Item[];
  roots: Root[];
  settings: Settings;
  collections: { id: string; name: string; query: string }[];
  savedAt: number;
}

export interface FsEntry {
  path: string;
  relPath: string;
  dir: string;
  name: string;
  ext: string;
  kind: ItemKind;
  size: number;
  mtime: number;
  ctime: number;
  /** 已计算好的内容指纹（新增/改动时才需要） */
  fingerprint: string;
}

export type EntryChange = 'added' | 'updated' | 'unchanged' | 'renamed' | 'revived';

export interface ReconcileResult {
  added: Item[];
  updated: Item[];
  renamed: { item: Item; from: string }[];
  revived: Item[];
  missing: Item[];
}

export interface EntryResult {
  item: Item;
  change: EntryChange;
  from?: string;
}

export function emptyProgress(): ReadingProgress {
  return { page: 1, total: 0, percent: 0, scrollTop: 0, zoom: 1, updatedAt: 0 };
}

const LIB_VERSION = 1;

function pathExistsSync(p: string): boolean {
  try {
    fsSync.statSync(longPath(p));
    return true;
  } catch {
    return false;
  }
}

export class Library {
  readonly file: JsonFile<StoredLibrary>;
  private byId = new Map<string, Item>();
  private byPath = new Map<string, string>();
  private byFingerprint = new Map<string, Set<string>>();
  private roots: Root[] = [];
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private collections: { id: string; name: string; query: string }[] = [];

  constructor(dataFile: string) {
    this.file = new JsonFile<StoredLibrary>({
      file: dataFile,
      defaults: () => ({
        version: LIB_VERSION,
        items: [],
        roots: [],
        settings: { ...DEFAULT_SETTINGS },
        collections: [],
        savedAt: Date.now(),
      }),
      revive: (raw) => {
        const data = raw as Partial<StoredLibrary>;
        if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
        return {
          version: typeof data.version === 'number' ? data.version : LIB_VERSION,
          items: data.items as Item[],
          roots: Array.isArray(data.roots) ? (data.roots as Root[]) : [],
          settings: { ...DEFAULT_SETTINGS, ...(data.settings as Partial<Settings> | undefined) },
          collections: Array.isArray(data.collections) ? data.collections : [],
          savedAt: typeof data.savedAt === 'number' ? data.savedAt : Date.now(),
        };
      },
      debounceMs: 800,
    });
  }

  async load(): Promise<void> {
    const data = await this.file.load();
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    this.roots = data.roots.map((r) => ({ ...r }));
    this.collections = data.collections;
    for (const item of data.items) {
      const normalized = normalizeItem(item);
      this.byId.set(normalized.id, normalized);
      this.byPath.set(normalized.path.toLowerCase(), normalized.id);
      if (normalized.fingerprint) this.addFingerprint(normalized.fingerprint, normalized.id);
    }
  }

  // ---------------------------------------------------------------- 读

  all(): Item[] {
    return [...this.byId.values()];
  }

  size(): number {
    return this.byId.size;
  }

  get(id: string): Item | null {
    return this.byId.get(id) ?? null;
  }

  getByPath(p: string): Item | null {
    const id = this.byPath.get(p.toLowerCase());
    return id ? this.byId.get(id) ?? null : null;
  }

  getRoots(): Root[] {
    return this.roots.map((r) => ({ ...r }));
  }

  getRoot(id: string): Root | null {
    const r = this.roots.find((x) => x.id === id);
    return r ? { ...r } : null;
  }

  getSettings(): Settings {
    return { ...this.settings };
  }

  getCollections(): { id: string; name: string; query: string }[] {
    return this.collections.map((c) => ({ ...c }));
  }

  tags(): string[] {
    const tags = new Set<string>();
    for (const item of this.byId.values()) for (const t of item.tags) tags.add(t);
    return [...tags].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }

  snapshotBase(): Pick<LibrarySnapshot, 'items' | 'roots' | 'settings' | 'tags'> {
    return { items: this.all(), roots: this.getRoots(), settings: this.getSettings(), tags: this.tags() };
  }

  // ---------------------------------------------------------------- 根目录

  addRoot(dirPath: string, opts: { depth?: number; name?: string } = {}): Root {
    const abs = path.resolve(dirPath);
    const existing = this.roots.find((r) => r.path.toLowerCase() === abs.toLowerCase());
    if (existing) return { ...existing };
    const root: Root = {
      id: shortId('rt_'),
      path: abs,
      name: opts.name?.trim() || path.basename(abs) || abs,
      enabled: true,
      depth: opts.depth ?? 8,
      addedAt: Date.now(),
      lastScanAt: null,
      available: true,
      itemCount: 0,
    };
    this.roots.push(root);
    this.persist();
    return { ...root };
  }

  removeRoot(rootId: string, opts: { forgetItems?: boolean } = {}): string[] {
    const exists = this.roots.some((r) => r.id === rootId);
    if (!exists) return [];
    this.roots = this.roots.filter((r) => r.id !== rootId);
    const removed: string[] = [];
    if (opts.forgetItems) {
      for (const item of [...this.byId.values()]) {
        if (item.rootId === rootId) {
          this.dropItem(item.id);
          removed.push(item.id);
        }
      }
    }
    this.persist();
    return removed;
  }

  setRootEnabled(rootId: string, enabled: boolean): void {
    const root = this.roots.find((r) => r.id === rootId);
    if (!root) return;
    root.enabled = enabled;
    this.persist();
  }

  /** 只在根目录还没有任何条目时使用：把 8.3 短路径换成长路径 */
  setRootPath(rootId: string, nextPath: string): void {
    const root = this.roots.find((r) => r.id === rootId);
    if (!root) return;
    root.path = path.resolve(nextPath);
    root.name = path.basename(root.path) || root.name;
    this.persist();
  }

  setRootAvailable(rootId: string, available: boolean): void {
    const root = this.roots.find((r) => r.id === rootId);
    if (!root || root.available === available) return;
    root.available = available;
    this.persist();
  }

  markRootScanned(rootId: string, itemCount: number): void {
    const root = this.roots.find((r) => r.id === rootId);
    if (!root) return;
    root.lastScanAt = Date.now();
    root.itemCount = itemCount;
    this.persist();
  }

  /** 找出某条路径属于哪个根目录（取最长的匹配前缀） */
  rootForPath(absPath: string): Root | null {
    const lower = absPath.toLowerCase();
    let best: Root | null = null;
    for (const root of this.roots) {
      const rp = root.path.toLowerCase();
      if (lower === rp || lower.startsWith(rp.endsWith(path.sep) ? rp : rp + path.sep)) {
        if (!best || root.path.length > best.path.length) best = root;
      }
    }
    return best ? { ...best } : null;
  }

  // ---------------------------------------------------------------- 对账

  /** 在一次"完整扫描"之后与库对账；entries 需自带指纹 */
  reconcileRoot(rootId: string, entries: FsEntry[]): ReconcileResult {
    const result: ReconcileResult = { added: [], updated: [], renamed: [], revived: [], missing: [] };
    const root = this.roots.find((r) => r.id === rootId);
    if (!root) return result;

    const seen = new Set<string>();
    const existingOfRoot = new Map<string, Item>();
    for (const item of this.byId.values()) {
      if (item.rootId === rootId) existingOfRoot.set(item.path.toLowerCase(), item);
    }
    const claimed = new Set<string>();

    for (const entry of entries) {
      const key = entry.path.toLowerCase();
      seen.add(key);
      const current = existingOfRoot.get(key);

      if (current) {
        const contentChanged = current.fingerprint !== entry.fingerprint;
        const metaChanged = current.size !== entry.size || Math.abs(current.mtime - entry.mtime) > 2;
        if (contentChanged || metaChanged) {
          this.apply(current.id, {
            size: entry.size,
            mtime: entry.mtime,
            ctime: entry.ctime,
            fingerprint: entry.fingerprint,
            revision: current.revision + 1,
            parseState: 'placeholder',
            textIndexed: false,
            thumb: null,
            missing: false,
            missingSince: null,
          });
          result.updated.push(this.byId.get(current.id)!);
        } else if (current.missing) {
          this.apply(current.id, { missing: false, missingSince: null });
          result.revived.push(this.byId.get(current.id)!);
        }
        claimed.add(current.id);
        continue;
      }

      const renamedFrom = this.findRenameCandidate(entry.fingerprint, rootId, key, claimed);
      if (renamedFrom) {
        const from = renamedFrom.path;
        const wasMissing = renamedFrom.missing;
        this.rebindPath(renamedFrom.id, entry, rootId);
        claimed.add(renamedFrom.id);
        const item = this.byId.get(renamedFrom.id)!;
        result.renamed.push({ item, from });
        if (wasMissing) result.revived.push(item);
        continue;
      }

      const item = this.createItem(rootId, entry);
      result.added.push(item);
      claimed.add(item.id);
    }

    for (const [lowerPath, item] of existingOfRoot) {
      if (seen.has(lowerPath) || claimed.has(item.id) || item.missing) continue;
      this.apply(item.id, { missing: true, missingSince: Date.now() });
      result.missing.push(this.byId.get(item.id)!);
    }

    root.itemCount = [...this.byId.values()].filter((i) => i.rootId === rootId).length;
    this.persist();
    return result;
  }

  /** 单个文件事件：新增 / 改动 / 改名 / 复活（不扫描整个根目录，O(1)） */
  reconcileEntry(rootId: string, entry: FsEntry): EntryResult {
    const key = entry.path.toLowerCase();
    const current = this.getByPath(entry.path);
    if (current) {
      const contentChanged = current.fingerprint !== entry.fingerprint;
      const metaChanged = current.size !== entry.size || Math.abs(current.mtime - entry.mtime) > 2;
      if (!contentChanged && !metaChanged) {
        if (current.missing) {
          this.apply(current.id, { missing: false, missingSince: null });
          return { item: this.byId.get(current.id)!, change: 'revived' };
        }
        return { item: current, change: 'unchanged' };
      }
      this.apply(current.id, {
        size: entry.size,
        mtime: entry.mtime,
        ctime: entry.ctime,
        fingerprint: entry.fingerprint,
        revision: current.revision + 1,
        parseState: 'placeholder',
        textIndexed: false,
        thumb: null,
        missing: false,
        missingSince: null,
      });
      return { item: this.byId.get(current.id)!, change: 'updated' };
    }

    const renamedFrom = this.findRenameCandidate(entry.fingerprint, rootId, key, new Set());
    if (renamedFrom) {
      const from = renamedFrom.path;
      const wasMissing = renamedFrom.missing;
      this.rebindPath(renamedFrom.id, entry, rootId);
      const item = this.byId.get(renamedFrom.id)!;
      this.persist();
      return { item, change: wasMissing ? 'revived' : 'renamed', from };
    }

    const item = this.createItem(rootId, entry);
    this.persist();
    return { item, change: 'added' };
  }

  /**
   * 改名识别：指纹相同、路径不同，且"旧路径此刻确实不存在"（或在库里已标记缺失）。
   * 这条"旧路径不存在"的判定很关键——否则把文件复制一份会被误判成移动。
   */
  private findRenameCandidate(fingerprint: string, rootId: string, newPathLower: string, claimed: Set<string>): Item | null {
    if (!fingerprint) return null;
    const ids = this.byFingerprint.get(fingerprint);
    if (!ids || !ids.size) return null;
    for (const id of ids) {
      const candidate = this.byId.get(id);
      if (!candidate || claimed.has(id)) continue;
      if (candidate.path.toLowerCase() === newPathLower) continue;
      if (candidate.missing || !pathExistsSync(candidate.path)) return candidate;
    }
    return null;
  }

  /** 标记路径已消失（是否真的删除由上层延迟二次确认） */
  markMissingByPath(absPath: string): Item | null {
    const item = this.getByPath(absPath);
    if (!item || item.missing) return null;
    this.apply(item.id, { missing: true, missingSince: Date.now() });
    this.persist();
    return this.byId.get(item.id)!;
  }

  /** 文件缺失后手动重新定位到新路径 */
  async rebindItem(itemId: string, newPath: string): Promise<Item | null> {
    const item = this.byId.get(itemId);
    if (!item) return null;
    const stat = await statSafe(newPath);
    if (!stat?.isFile) return null;
    const root = this.rootForPath(newPath) ?? this.getRoot(item.rootId);
    if (!root) return null;
    const { relPath, dir } = relativize(root.path, newPath);
    const name = path.basename(newPath);
    const ext = extOf(name);
    const kind = kindOf(ext);
    this.byPath.delete(item.path.toLowerCase());
    this.apply(itemId, {
      rootId: root.id,
      path: path.resolve(newPath),
      relPath,
      dir,
      name,
      ext,
      kind,
      readable: isReadable(kind),
      size: stat.size,
      mtime: stat.mtime,
      ctime: stat.ctime,
      missing: false,
      missingSince: null,
      revision: item.revision + 1,
      parseState: 'placeholder',
      textIndexed: false,
    });
    const next = this.byId.get(itemId)!;
    this.byPath.set(next.path.toLowerCase(), next.id);
    this.persist();
    return next;
  }

  private rebindPath(itemId: string, entry: FsEntry, rootId: string): void {
    const item = this.byId.get(itemId);
    if (!item) return;
    this.byPath.delete(item.path.toLowerCase());
    this.apply(
      itemId,
      {
        rootId,
        path: entry.path,
        relPath: entry.relPath,
        dir: entry.dir,
        name: entry.name,
        ext: entry.ext,
        kind: entry.kind,
        readable: isReadable(entry.kind),
        size: entry.size,
        mtime: entry.mtime,
        ctime: entry.ctime,
        fingerprint: entry.fingerprint,
        missing: false,
        missingSince: null,
        collections: entry.dir ? [entry.dir] : [],
        ...(item.userEdited.includes('title') ? {} : { title: pickTitleFromName(entry.name, item) }),
      },
    );
    const next = this.byId.get(itemId)!;
    this.byPath.set(next.path.toLowerCase(), next.id);
  }

  private createItem(rootId: string, entry: FsEntry): Item {
    const guess = guessFromFileName(entry.name);
    const item: Item = {
      id: shortId('it_'),
      rootId,
      path: entry.path,
      relPath: entry.relPath,
      dir: entry.dir,
      name: entry.name,
      ext: entry.ext,
      kind: entry.kind,
      readable: isReadable(entry.kind),
      size: entry.size,
      mtime: entry.mtime,
      ctime: entry.ctime,
      fingerprint: entry.fingerprint,
      title: guess.title || baseNameNoExt(entry.name),
      authors: guess.authors,
      year: guess.year,
      venue: '',
      volume: '',
      issue: '',
      pages: '',
      doi: guess.doi,
      arxivId: guess.arxivId,
      url: guess.doi ? `https://doi.org/${guess.doi}` : guess.arxivId ? `https://arxiv.org/abs/${guess.arxivId}` : '',
      abstract: '',
      keywords: [],
      language: '',
      pageCount: 0,
      wordCount: 0,
      excerpt: '',
      tags: [...new Set(guess.tags)],
      collections: entry.dir ? [entry.dir] : [],
      colorTag: '',
      starred: false,
      readState: 'unread',
      progress: emptyProgress(),
      note: '',
      annotationCount: 0,
      userEdited: [],
      missing: false,
      missingSince: null,
      addedAt: Date.now(),
      lastOpenedAt: null,
      openCount: 0,
      thumb: null,
      parseState: 'placeholder',
      textIndexed: false,
      revision: 1,
    };
    this.byId.set(item.id, item);
    this.byPath.set(item.path.toLowerCase(), item.id);
    if (item.fingerprint) this.addFingerprint(item.fingerprint, item.id);
    return item;
  }

  private addFingerprint(fp: string, id: string): void {
    let set = this.byFingerprint.get(fp);
    if (!set) {
      set = new Set();
      this.byFingerprint.set(fp, set);
    }
    set.add(id);
  }

  private dropItem(id: string): void {
    const item = this.byId.get(id);
    if (!item) return;
    this.byId.delete(id);
    this.byPath.delete(item.path.toLowerCase());
    if (item.fingerprint) {
      const set = this.byFingerprint.get(item.fingerprint);
      set?.delete(id);
      if (set && !set.size) this.byFingerprint.delete(item.fingerprint);
    }
  }

  // ---------------------------------------------------------------- 写

  persist(): void {
    this.file.set({
      version: LIB_VERSION,
      items: [...this.byId.values()],
      roots: this.roots,
      settings: this.settings,
      collections: this.collections,
      savedAt: Date.now(),
    });
  }

  async flush(): Promise<void> {
    this.persist();
    await this.file.flushNow();
  }

  /** 内部：改内存并维护索引，不落盘（批量时由调用方统一 persist） */
  private apply(id: string, patch: Partial<Item>): Item | null {
    const item = this.byId.get(id);
    if (!item) return null;
    const pathChanged = patch.path !== undefined && patch.path.toLowerCase() !== item.path.toLowerCase();
    if (pathChanged) this.byPath.delete(item.path.toLowerCase());
    const fpChanged = patch.fingerprint !== undefined && patch.fingerprint !== item.fingerprint;
    if (fpChanged && item.fingerprint) {
      const set = this.byFingerprint.get(item.fingerprint);
      set?.delete(id);
      if (set && !set.size) this.byFingerprint.delete(item.fingerprint);
    }
    Object.assign(item, patch);
    if (pathChanged && item.path) this.byPath.set(item.path.toLowerCase(), id);
    if (fpChanged && item.fingerprint) this.addFingerprint(item.fingerprint, id);
    return item;
  }

  patchItem(id: string, patch: Partial<Item>): Item | null {
    const item = this.apply(id, patch);
    if (item) this.persist();
    return item;
  }

  patchItems(ids: string[], patch: Partial<Item>): Item[] {
    const out: Item[] = [];
    for (const id of ids) {
      const item = this.apply(id, patch);
      if (item) out.push(item);
    }
    if (out.length) this.persist();
    return out;
  }

  /** 用户手工编辑：记录到 userEdited，扫描/联网补全都不再覆盖这些字段 */
  editItem(id: string, patch: Partial<Item>, userFields: (keyof Item)[] = []): Item | null {
    const item = this.byId.get(id);
    if (!item) return null;
    const merged = [...new Set([...item.userEdited, ...userFields.map(String)])];
    return this.patchItem(id, { ...patch, userEdited: merged });
  }

  /** 写入扫描得到的元数据：不覆盖用户手改过的字段，也不用空值抹掉已有信息 */
  applyMetadata(id: string, meta: Partial<Item>): { item: Item; applied: string[] } | null {
    const item = this.byId.get(id);
    if (!item) return null;
    const patch: Partial<Item> = {};
    const applied: string[] = [];
    for (const [key, value] of Object.entries(meta) as [string, unknown][]) {
      if (value === undefined || value === null) continue;
      if (item.userEdited.includes(key)) continue;
      if (typeof value === 'string' && value.trim() === '') {
        const existing = (item as unknown as Record<string, unknown>)[key];
        if (typeof existing === 'string' && existing.trim() !== '') continue;
      }
      if (Array.isArray(value) && value.length === 0) {
        const existing = (item as unknown as Record<string, unknown>)[key];
        if (Array.isArray(existing) && existing.length > 0) continue;
      }
      (patch as Record<string, unknown>)[key] = value;
      applied.push(key);
    }
    if (!Object.keys(patch).length) return { item, applied };
    this.patchItem(id, patch);
    return { item: this.byId.get(id)!, applied };
  }

  deleteItem(id: string): void {
    this.dropItem(id);
    this.persist();
  }

  /** 撤销删除时把条目整条放回来（保留原 id，批注才能重新挂上） */
  restoreItem(raw: Item): Item {
    const item = normalizeItem(raw);
    this.byId.set(item.id, item);
    this.byPath.set(item.path.toLowerCase(), item.id);
    if (item.fingerprint) this.addFingerprint(item.fingerprint, item.id);
    this.persist();
    return item;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.settings = {
      ...this.settings,
      ...patch,
      windowBounds: { ...this.settings.windowBounds, ...(patch.windowBounds ?? {}) },
    };
    this.persist();
    return this.getSettings();
  }

  setCollections(collections: { id: string; name: string; query: string }[]): void {
    this.collections = collections;
    this.persist();
  }
}

/** 补齐老数据缺失字段，保证 UI 永远拿到完整对象 */
export function normalizeItem(raw: Item): Item {
  const ext = raw.ext || extOf(raw.name ?? '');
  const kind = raw.kind || kindOf(ext);
  return {
    ...raw,
    ext,
    kind,
    readable: raw.readable ?? isReadable(kind),
    authors: Array.isArray(raw.authors) ? raw.authors : [],
    keywords: Array.isArray(raw.keywords) ? raw.keywords : [],
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    collections: Array.isArray(raw.collections) ? raw.collections : [],
    userEdited: Array.isArray(raw.userEdited) ? raw.userEdited : [],
    progress: { ...emptyProgress(), ...(raw.progress ?? {}) },
    note: raw.note ?? '',
    annotationCount: raw.annotationCount ?? 0,
    excerpt: raw.excerpt ?? '',
    parseState: raw.parseState ?? 'placeholder',
    revision: raw.revision ?? 1,
    textIndexed: raw.textIndexed ?? false,
    openCount: raw.openCount ?? 0,
    lastOpenedAt: raw.lastOpenedAt ?? null,
    missing: raw.missing ?? false,
    missingSince: raw.missingSince ?? null,
    starred: raw.starred ?? false,
    readState: raw.readState ?? 'unread',
    thumb: raw.thumb ?? null,
    year: raw.year ?? null,
  };
}

/** 改名后标题如何跟随：PDF 内嵌标题可信时优先，否则用新文件名解析结果 */
function pickTitleFromName(name: string, item: Item): string {
  const guess = guessFromFileName(name);
  const pdfTitle = item.title && titleQuality(item.title) >= 5 ? sanitizeTitle(item.title) : '';
  if (pdfTitle && guess.structured) return pdfTitle;
  return guess.title || baseNameNoExt(name);
}

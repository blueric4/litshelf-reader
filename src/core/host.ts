/**
 * 宿主（Host）：把扫描、监听、抽取、检索、批注、导出编排成一个统一的服务对象。
 * Electron 主进程与浏览器形态后端都直接复用这个类，保证两种形态行为一致。
 *
 * 线程模型：单进程 + 异步队列。界面永远不会被扫描阻塞——
 * S1 发现（readdir+stat）→ 立即入库并广播 → S2 指纹（只对新增/改动）→ S3 元数据/全文（后台队列）。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import type { FSWatcher } from 'chokidar';
import {
  kindOf,
  type Annotation,
  type ExportOptions,
  type HostEvent,
  type Item,
  type LibrarySnapshot,
  type Root,
  type ScanProgress,
  type SearchResult,
  type Settings,
  type Toast,
} from '../shared/types';
import { Library, type FsEntry } from './library';
import { AnnotationStore } from './annotations';
import { TextIndex } from './textindex';
import { MetadataClient, extractArxivId, extractDoi } from './metadata';
import { Journal, JsonFile } from './store';
import { fingerprintFile } from './fingerprint';
import { shouldIncludeFile, isIgnoredDirName, isTempFileName } from './ignore';
import { longPath, relativize, shortId, humanSize, mapLimit, sleep } from './paths';
import { ensureDir, exists, listDirSafe, rmSafe, statSafe, writeFileAtomicSafe } from './fsutil';
import { countWords, extractPdf, extractTextForIndex, htmlToText, readTextFileSmart } from './extract';
import { guessFromFileName, sanitizeTitle, titleQuality } from './naming';
import { searchItems, parseQuery } from './search';
import { reanchorAnnotation } from './reanchor';
import { exportContent, formatCitation, EXPORT_EXT } from './export';

export interface HostOptions {
  dataDir: string;
  mode: 'electron' | 'web';
  version: string;
  /** 是否允许发起网络请求（离线模式由设置控制） */
  online?: boolean;
}

interface UndoEntry {
  name: string;
  at: number;
  run: () => Promise<void>;
}

interface BatchCounter {
  added: number;
  updated: number;
  renamed: number;
  missing: number;
  removed: number;
  timer: NodeJS.Timeout | null;
}

const EMPTY_PROGRESS: ScanProgress = {
  active: false,
  phase: 'idle',
  discovered: 0,
  processed: 0,
  total: 0,
  currentPath: '',
  rootId: null,
  startedAt: 0,
  finishedAt: null,
  errors: 0,
};

export class Host {
  readonly library: Library;
  readonly annotations: AnnotationStore;
  readonly textIndex: TextIndex;
  readonly metadata: MetadataClient;
  readonly journal: Journal;
  readonly dataDir: string;
  readonly mode: 'electron' | 'web';
  readonly version: string;

  private listeners = new Set<(e: HostEvent) => void>();
  private watchers = new Map<string, FSWatcher>();
  private progress: ScanProgress = { ...EMPTY_PROGRESS };
  private undoStack: UndoEntry[] = [];
  private scanRunning = new Set<string>();
  private queue: { itemId: string; deep: boolean }[] = [];
  private queueRunning = false;
  private pendingTimers = new Map<string, NodeJS.Timeout>();
  private batch: BatchCounter = { added: 0, updated: 0, renamed: 0, missing: 0, removed: 0, timer: null };
  private reconcileTimer: NodeJS.Timeout | null = null;
  private toastIds = new Set<string>();
  private started = false;
  /** stop() 之后不得再创建 watcher，否则事件循环永不退出 */
  private stopping = false;
  /** 软件内改过、还没落盘的笔记（只在退出时回写这些，避免覆盖外部编辑） */
  private noteDirty = new Set<string>();
  private settingsFile: JsonFile<Settings>;

  constructor(opts: HostOptions) {
    this.dataDir = opts.dataDir;
    this.mode = opts.mode;
    this.version = opts.version;
    this.library = new Library(path.join(opts.dataDir, 'library.json'));
    this.annotations = new AnnotationStore(path.join(opts.dataDir, 'annotations.json'));
    this.textIndex = new TextIndex(path.join(opts.dataDir, 'cache'));
    this.metadata = new MetadataClient({
      cacheFile: path.join(opts.dataDir, 'cache', 'metadata.json'),
      online: opts.online !== false,
    });
    this.journal = new Journal(path.join(opts.dataDir, 'logs', 'journal.log'));
    this.settingsFile = new JsonFile<Settings>({
      file: path.join(opts.dataDir, 'settings.json'),
      defaults: () => ({ ...this.library.getSettings() }),
      revive: (raw) => (raw && typeof raw === 'object' ? ({ ...this.library.getSettings(), ...(raw as Settings) }) : null),
    });
  }

  get cacheDir(): string {
    return path.join(this.dataDir, 'cache');
  }

  get thumbsDir(): string {
    return path.join(this.cacheDir, 'thumbs');
  }

  get notesDir(): string {
    return path.join(this.dataDir, 'notes');
  }

  // ------------------------------------------------------------ 生命周期

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await ensureDir(this.dataDir);
    await ensureDir(this.cacheDir);
    await ensureDir(this.thumbsDir);
    await ensureDir(this.notesDir);
    await this.library.load();
    await this.annotations.load();
    await this.settingsFile.load();
    this.metadata.setOnline(this.library.getSettings().onlineMetadata);
    this.syncAnnotationCounts();
    this.journal.append('host:start', { mode: this.mode, items: this.library.size() });

    // 恢复笔记文件（notes/<id>.md 可能被外部编辑过）
    await this.restoreNotesFromDisk();

    for (const root of this.library.getRoots()) {
      if (!root.enabled) continue;
      const ok = await exists(root.path);
      this.library.setRootAvailable(root.id, ok);
      if (!ok) {
        this.pushToast('warn', `文献库「${root.name}」暂时打不开`, root.path, 8000);
        continue;
      }
      // 老数据可能是 8.3 短路径（如 C:\Users\ADMIN~1\...）：libuv 在这种路径上做文件监听
      // 会直接断言崩溃。只有在该根目录还没有条目时才安全替换成长路径——有条目时替换会
      // 让全部条目路径失配，被误判成"删除 + 新增"。
      const real = await fs.realpath(longPath(root.path)).catch(() => root.path);
      if (real && real !== root.path) {
        const itemCount = this.library.all().filter((i) => i.rootId === root.id).length;
        if (itemCount === 0) {
          this.journal.append('root:realpath', { from: root.path, to: real });
          this.library.setRootPath(root.id, real);
          root.path = real;
        } else {
          this.journal.append('root:shortpath-warning', { path: root.path, real });
        }
      }
      void this.scanRoot(root.id).catch(() => undefined);
      this.startWatch(root);
    }
    this.scheduleReconcile();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // 等一次 microtask：让正在创建中的 watcher（startWatch 是异步的）看到 stopping 标志，
    // 否则会出现"stop 之后才建好的 watcher"，事件循环永远不退出。
    await new Promise((r) => setTimeout(r, 0));
    for (const w of this.watchers.values()) await w.close().catch(() => undefined);
    this.watchers.clear();
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    for (const t of this.pendingTimers.values()) clearTimeout(t);
    this.pendingTimers.clear();
    await this.flushAll();
  }

  async flushAll(): Promise<void> {
    await this.library.flush();
    await this.annotations.flush();
    await this.metadata.close();
    await this.settingsFile.flushNow().catch(() => undefined);
    await this.flushDirtyNotes();
  }

  /**
   * 只回写"软件内改动过、还没落盘"的笔记。
   * 绝不能在这里无条件重写全部笔记文件——那会把用户在外部编辑器里改的内容冲掉。
   */
  private async flushDirtyNotes(): Promise<void> {
    for (const id of [...this.noteDirty]) {
      const item = this.library.get(id);
      if (item) await this.writeNoteFile(item).catch(() => undefined);
      this.noteDirty.delete(id);
    }
  }

  // ------------------------------------------------------------ 事件

  subscribe(listener: (e: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HostEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error('[litshelf] 事件监听器异常', err);
      }
    }
  }

  private emitItems(items: Item[]): void {
    if (!items.length) return;
    this.emit({ type: 'items:patch', items });
  }

  private emitRoots(): void {
    this.emit({ type: 'roots:update', roots: this.library.getRoots() });
  }

  private emitSettings(): void {
    this.emit({ type: 'settings:update', settings: this.library.getSettings() });
  }

  private emitTags(): void {
    this.emit({ type: 'tags:update', tags: this.library.tags() });
  }

  pushToast(kind: Toast['kind'], message: string, detail?: string, ttl = 5200, extra: Partial<Toast> = {}): Toast {
    const toast: Toast = {
      id: shortId('ts_'),
      kind,
      message,
      detail,
      createdAt: Date.now(),
      ttl,
      ...extra,
    };
    this.toastIds.add(toast.id);
    if (this.toastIds.size > 60) this.toastIds.clear();
    this.emit({ type: 'toast', toast });
    return toast;
  }

  private patchProgress(patch: Partial<ScanProgress>): void {
    this.progress = { ...this.progress, ...patch };
    this.emit({ type: 'scan:progress', progress: { ...this.progress } });
  }

  getProgress(): ScanProgress {
    return { ...this.progress };
  }

  snapshot(): LibrarySnapshot {
    return {
      ...this.library.snapshotBase(),
      progress: this.getProgress(),
      platform: process.platform,
      mode: this.mode,
      dataDir: this.dataDir,
      version: this.version,
    };
  }

  // ------------------------------------------------------------ 扫描

  /** S1：枚举文件（不做哈希、不解析） */
  private async discover(root: Root): Promise<{ path: string; name: string; ext: string; size: number; mtime: number; ctime: number }[]> {
    const out: { path: string; name: string; ext: string; size: number; mtime: number; ctime: number }[] = [];
    const includeOther = this.library.getSettings().includeOtherFiles;
    const stack: { dir: string; depth: number }[] = [{ dir: root.path, depth: 1 }];
    while (stack.length) {
      const { dir, depth } = stack.pop()!;
      const entries = await listDirSafe(dir);
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDir) {
          if (depth >= root.depth) continue;
          if (isIgnoredDirName(entry.name)) continue;
          stack.push({ dir: abs, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile) continue;
        const ext = (entry.name.split('.').pop() ?? '').toLowerCase();
        if (!shouldIncludeFile({ name: entry.name, ext, size: entry.size, includeOtherFiles: includeOther })) continue;
        out.push({ path: abs, name: entry.name, ext, size: entry.size, mtime: entry.mtime, ctime: entry.mtime });
        if (out.length % 400 === 0) {
          this.patchProgress({ discovered: out.length, currentPath: abs });
          await sleep(0); // 让出事件循环，保证界面可交互
        }
      }
    }
    return out;
  }

  /** 完整扫描一个根目录：发现 → 指纹 → 对账 → 广播 → 排队抽取 */
  async scanRoot(rootId: string, opts: { silent?: boolean } = {}): Promise<void> {
    const root = this.library.getRoot(rootId);
    if (!root) return;
    if (this.scanRunning.has(rootId)) return;
    this.scanRunning.add(rootId);
    const started = Date.now();
    try {
      const ok = await exists(root.path);
      this.library.setRootAvailable(rootId, ok);
      if (!ok) {
        this.emitRoots();
        return;
      }
      this.patchProgress({
        active: true,
        phase: 'discovering',
        discovered: 0,
        processed: 0,
        total: 0,
        rootId,
        startedAt: started,
        finishedAt: null,
        errors: 0,
        currentPath: root.path,
      });

      const files = await this.discover(root);
      this.patchProgress({ phase: 'hashing', discovered: files.length, total: files.length });

      const entries: FsEntry[] = [];
      let done = 0;
      await mapLimit(files, Math.max(1, this.library.getSettings().concurrency), async (f) => {
        const existing = this.library.getByPath(f.path);
        let fingerprint = '';
        let needsHash = true;
        if (existing && !existing.missing && existing.fingerprint) {
          const sameSize = existing.size === f.size;
          const sameTime = Math.abs(existing.mtime - f.mtime) < 2;
          if (sameSize && sameTime) {
            fingerprint = existing.fingerprint;
            needsHash = false;
          }
        }
        if (needsHash) {
          const hashed = await fingerprintFile(f.path);
          fingerprint = hashed?.fingerprint ?? existing?.fingerprint ?? `size:${f.size}:${f.name}`;
          if (!hashed) this.progress.errors += 1;
        }
        done += 1;
        if (done % 50 === 0 || done === files.length) {
          this.patchProgress({ processed: done, currentPath: f.path });
        }
        const { relPath, dir } = relativize(root.path, f.path);
        entries.push({
          path: f.path,
          relPath,
          dir,
          name: f.name,
          ext: f.ext,
          kind: kindOf(f.ext),
          size: f.size,
          mtime: f.mtime,
          ctime: f.ctime,
          fingerprint,
        });
      });

      const result = this.library.reconcileRoot(rootId, entries);
      this.library.markRootScanned(rootId, entries.length);
      this.emitRoots();

      const changed = [...result.added, ...result.updated, ...result.renamed.map((r) => r.item), ...result.revived, ...result.missing];
      if (changed.length) this.emitItems(changed);

      if (!opts.silent && (result.added.length || result.renamed.length || result.missing.length)) {
        const parts: string[] = [];
        if (result.added.length) parts.push(`新增 ${result.added.length} 篇`);
        if (result.renamed.length) parts.push(`移动/改名 ${result.renamed.length} 篇`);
        if (result.missing.length) parts.push(`${result.missing.length} 篇文件缺失`);
        this.pushToast('info', `「${root.name}」${parts.join('，')}`, `${entries.length} 个文件 · ${((Date.now() - started) / 1000).toFixed(1)} 秒`, 5200, {
          itemIds: result.added.slice(0, 20).map((i) => i.id),
        });
      }

      // 内容变化但保住了用户数据的条目 → 批注重定位
      for (const item of result.updated) {
        await this.reanchorForItem(item.id).catch(() => undefined);
      }

      this.patchProgress({ phase: 'extracting', total: entries.length, processed: done });
      const needParse = entries
        .map((e) => this.library.getByPath(e.path))
        .filter((i): i is Item => !!i && i.parseState !== 'ready');
      for (const item of needParse) this.enqueueExtract(item.id, false);

      this.patchProgress({
        active: this.queue.length > 0,
        phase: this.queue.length ? 'extracting' : 'done',
        total: needParse.length,
        processed: 0,
        finishedAt: Date.now(),
        currentPath: '',
      });
      this.journal.append('scan:root', { root: root.name, files: entries.length, added: result.added.length, missing: result.missing.length });
    } catch (err) {
      this.journal.append('scan:error', { rootId, message: (err as Error).message });
      this.pushToast('error', `扫描「${root.name}」失败`, (err as Error).message);
    } finally {
      this.scanRunning.delete(rootId);
      if (!this.scanRunning.size && !this.queueRunning) {
        this.patchProgress({ active: false, phase: 'done', finishedAt: Date.now() });
      }
    }
  }

  async scanAll(): Promise<void> {
    for (const root of this.library.getRoots()) {
      if (!root.enabled) continue;
      void this.scanRoot(root.id).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------ 监听

  private startWatch(root: Root): void {
    if (this.stopping || this.watchers.has(root.id)) return;
    void (async () => {
      try {
        const chokidar = await import('chokidar');
        // 动态 import 期间可能已经 stop()：这时创建的 watcher 会让进程永不退出，必须立刻关掉
        if (this.stopping) return;
        const watcher = chokidar.watch(root.path, {
          ignoreInitial: true,
          persistent: true,
          followSymlinks: false,
          depth: root.depth,
          awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
          ignored: (target: string) => {
            const base = path.basename(target);
            if (!base) return false;
            if (isTempFileName(base)) return true;
            // 目录名忽略规则：仅对没有扩展名的路径生效，避免误伤文件
            if (!base.includes('.') && isIgnoredDirName(base)) return true;
            return false;
          },
        });
        watcher.on('add', (p) => this.onFsAddOrChange(p, 'add'));
        watcher.on('change', (p) => this.onFsAddOrChange(p, 'change'));
        watcher.on('unlink', (p) => this.onFsUnlink(p));
        watcher.on('error', (err) => this.journal.append('watch:error', { root: root.name, message: String(err) }));
        if (this.stopping) {
          await watcher.close().catch(() => undefined);
          return;
        }
        this.watchers.set(root.id, watcher as unknown as FSWatcher);
        this.journal.append('watch:start', { root: root.name });
      } catch (err) {
        this.journal.append('watch:fail', { root: root.name, message: (err as Error).message });
        this.pushToast('warn', '文件夹实时监听启动失败，已退回定时巡检', `${root.name}：${(err as Error).message}`, 8000);
      }
    })();
  }

  private async closeWatch(rootId: string): Promise<void> {
    const w = this.watchers.get(rootId);
    if (!w) return;
    this.watchers.delete(rootId);
    await w.close().catch(() => undefined);
  }

  private onFsAddOrChange(absPath: string, kind: 'add' | 'change'): void {
    // 每个路径做去抖，合并"保存过程中连续触发"的事件
    const prev = this.pendingTimers.get(absPath);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.pendingTimers.delete(absPath);
      void this.handleFsChange(absPath, kind).catch((err) => this.journal.append('fs:error', { path: absPath, message: (err as Error).message }));
    }, kind === 'add' ? 350 : 600);
    this.pendingTimers.set(absPath, timer);
  }

  private async handleFsChange(absPath: string, kind: 'add' | 'change'): Promise<void> {
    const name = path.basename(absPath);
    if (isTempFileName(name)) return;
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    const stat = await statSafe(absPath);
    if (!stat?.isFile) return;
    if (!shouldIncludeFile({ name, ext, size: stat.size, includeOtherFiles: this.library.getSettings().includeOtherFiles })) return;

    const root = this.library.rootForPath(absPath);
    if (!root) return;
    const hashed = await fingerprintFile(absPath);
    if (!hashed) return;
    const { relPath, dir } = relativize(root.path, absPath);
    const entry: FsEntry = {
      path: absPath,
      relPath,
      dir,
      name,
      ext,
      kind: kindOf(ext),
      size: stat.size,
      mtime: stat.mtime,
      ctime: stat.ctime,
      fingerprint: hashed.fingerprint,
    };
    const { item, change, from } = this.library.reconcileEntry(root.id, entry);
    this.emitItems([item]);

    if (change === 'added') {
      this.batch.added += 1;
      this.enqueueExtract(item.id, false);
    } else if (change === 'updated') {
      this.batch.updated += 1;
      this.enqueueExtract(item.id, false);
      await this.reanchorForItem(item.id).catch(() => undefined);
      // 内容变了：若已有批注，提示用户
      if (item.annotationCount > 0) {
        const list = this.annotations.list(item.id);
        const review = list.filter((a) => a.needsReview).length;
        if (review) this.pushToast('warn', `《${item.title}》文件内容已更新`, `${review} 条批注需要确认位置`, 8000, { itemIds: [item.id] });
      }
    } else if (change === 'renamed') {
      this.batch.renamed += 1;
      this.pushToastDelayedRename(item, from);
    } else if (change === 'revived') {
      this.batch.added += 1;
      this.enqueueExtract(item.id, false);
    }
    this.scheduleBatchToast();
  }

  private renameNotices: Item[] = [];
  private pushToastDelayedRename(item: Item, from?: string): void {
    this.renameNotices.push(item);
    void from;
  }

  private onFsUnlink(absPath: string): void {
    const key = `unlink:${absPath}`;
    const prev = this.pendingTimers.get(key);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.pendingTimers.delete(key);
      void (async () => {
        if (await exists(absPath)) return; // 只是保存过程中的瞬时消失
        const item = this.library.markMissingByPath(absPath);
        if (item) {
          this.emitItems([item]);
          this.batch.missing += 1;
          this.scheduleBatchToast();
          this.journal.append('fs:missing', { path: absPath, title: item.title });
        }
      })().catch(() => undefined);
    }, 2000);
    this.pendingTimers.set(key, timer);
  }

  private scheduleBatchToast(): void {
    if (this.batch.timer) return;
    this.batch.timer = setTimeout(() => {
      this.batch.timer = null;
      const { added, updated, renamed, missing } = this.batch;
      this.batch.added = 0;
      this.batch.updated = 0;
      this.batch.renamed = 0;
      this.batch.missing = 0;
      const parts: string[] = [];
      const ids: string[] = [];
      if (added) parts.push(`已添加 ${added} 篇`);
      if (updated) parts.push(`${updated} 篇内容已更新`);
      if (renamed) {
        parts.push(`${renamed} 篇已移动/改名`);
        if (this.renameNotices.length) {
          const first = this.renameNotices[0];
          ids.push(first.id);
          parts[parts.length - 1] += `（如《${first.title.slice(0, 18)}》）`;
        }
        this.renameNotices = [];
      }
      if (missing) parts.push(`${missing} 篇文件缺失（条目已保留）`);
      if (!parts.length) return;
      this.refreshRootCounts();
      this.pushToast(missing ? 'warn' : 'success', parts.join('，'), '文件夹里的变化已自动同步到软件内', 6000, { itemIds: ids });
    }, 900);
  }

  private scheduleReconcile(): void {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    const interval = this.library.getSettings().reconcileIntervalMs;
    if (!interval || interval <= 0) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcileAll().catch(() => undefined);
      this.scheduleReconcile();
    }, interval);
    this.reconcileTimer.unref?.();
  }

  /** 一致性巡检：修补极端情况下丢失的文件系统事件 */
  async reconcileAll(): Promise<void> {
    for (const root of this.library.getRoots()) {
      if (!root.enabled) continue;
      await this.scanRoot(root.id, { silent: true }).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------ 抽取队列

  private enqueueExtract(itemId: string, deep: boolean): void {
    if (!this.queue.some((q) => q.itemId === itemId)) this.queue.push({ itemId, deep });
    void this.runQueue();
  }

  private async runQueue(): Promise<void> {
    if (this.queueRunning) return;
    this.queueRunning = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0, Math.max(1, this.library.getSettings().concurrency * 2));
        await mapLimit(batch, Math.max(1, this.library.getSettings().concurrency), async (task) => {
          const item = this.library.get(task.itemId);
          if (!item) return;
          await this.extractOne(item, task.deep).catch((err) => {
            this.library.patchItem(item.id, { parseState: 'failed', parseError: (err as Error).message });
          });
        });
        this.patchProgress({
          active: this.progress.active || this.queue.length > 0,
          phase: this.queue.length ? 'extracting' : 'done',
          processed: this.progress.processed + batch.length,
        });
      }
    } finally {
      this.queueRunning = false;
      if (!this.scanRunning.size) this.patchProgress({ active: false, phase: 'done', finishedAt: Date.now() });
    }
  }

  /** S3：抽取一篇的元数据（必要时含全文索引） */  private async extractOne(item: Item, deep: boolean): Promise<void> {
    if (item.missing) {
      this.library.patchItem(item.id, { parseState: 'indexed' });
      return;
    }
    const stat = await statSafe(item.path);
    if (!stat?.isFile) {
      this.library.patchItem(item.id, { missing: true, missingSince: Date.now() });
      const updated = this.library.get(item.id);
      if (updated) this.emitItems([updated]);
      return;
    }

    let patch: Partial<Item> = {};
    try {
      if (item.kind === 'pdf') {
        const info = await extractPdf(item.path, { headPages: 3 });
        if (!info.ok) {
          patch = { parseState: 'failed', parseError: info.error ?? '无法解析 PDF', pageCount: item.pageCount };
        } else {
          const nameGuess = guessFromFileName(item.name);
          const pdfTitle = sanitizeTitle(info.title);
          const usePdfTitle = titleQuality(pdfTitle) >= 4 && titleQuality(pdfTitle) >= titleQuality(nameGuess.title);
          const authors = info.author
            ? info.author
                .split(/\s*(?:;|,| and |、|，)\s*/i)
                .map((s) => s.trim())
                .filter((s) => s.length > 1 && s.length < 60)
            : [];
          const doi = extractDoi(info.headText) || extractDoi(info.subject) || extractDoi(info.keywords);
          const arxivId = extractArxivId(info.headText) || extractArxivId(item.name);
          const year = info.creationDate ? Number(info.creationDate.slice(0, 4)) : null;
          patch = {
            title: usePdfTitle ? pdfTitle : item.title,
            authors: authors.length ? authors : item.authors,
            year: year && year > 1900 && year < 2100 ? year : item.year,
            doi: doi || item.doi,
            arxivId: arxivId || item.arxivId,
            url: doi ? `https://doi.org/${doi}` : arxivId ? `https://arxiv.org/abs/${arxivId}` : item.url,
            keywords: info.keywords
              ? info.keywords
                  .split(/[;,、，]/)
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .slice(0, 24)
              : item.keywords,
            language: /[\u4e00-\u9fa5]/.test(info.headText.slice(0, 400)) ? 'zh' : item.language || 'en',
            pageCount: info.pageCount,
            excerpt: info.headText.replace(/\s+/g, ' ').slice(0, 400),
            parseState: 'ready',
            parseError: undefined,
            progress: { ...item.progress, total: info.pageCount },
          };
        }
      } else if (item.kind === 'text' || item.kind === 'markdown') {
        const { text } = await readTextFileSmart(item.path);
        const trimmed = text.slice(0, 200_000);
        const { words } = countWords(trimmed);
        const heading = item.kind === 'markdown' ? trimmed.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() : '';
        patch = {
          title: titleQuality(heading ?? '') >= 4 ? sanitizeTitle(heading!) : item.title,
          wordCount: words,
          excerpt: htmlToText(trimmed).replace(/\s+/g, ' ').slice(0, 400),
          pageCount: 1,
          parseState: 'ready',
        };
      } else if (item.kind === 'html') {
        const { text } = await readTextFileSmart(item.path);
        const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
        const plain = htmlToText(text);
        patch = {
          title: title && titleQuality(title) >= 4 ? sanitizeTitle(title) : item.title,
          wordCount: countWords(plain).words,
          excerpt: plain.replace(/\s+/g, ' ').slice(0, 400),
          pageCount: 1,
          parseState: 'ready',
        };
      } else if (item.kind === 'docx') {
        const mammoth = (await import('mammoth')) as unknown as {
          extractRawText: (i: { path: string }) => Promise<{ value: string }>;
        };
        const res = await mammoth.extractRawText({ path: longPath(item.path) });
        const text = res.value ?? '';
        patch = {
          wordCount: countWords(text).words,
          excerpt: text.replace(/\s+/g, ' ').slice(0, 400),
          pageCount: 1,
          parseState: 'ready',
        };
      } else if (item.kind === 'epub') {
        const { extractEpub } = await import('./epub');
        const book = await extractEpub(item.path);
        if (book) {
          patch = {
            title: titleQuality(book.title) >= 4 ? sanitizeTitle(book.title) : item.title,
            authors: book.authors.length ? book.authors : item.authors,
            language: book.language || item.language,
            pageCount: book.chapters.length,
            excerpt: book.chapters[0] ? htmlToText(book.chapters[0].html).slice(0, 400) : item.excerpt,
            parseState: 'ready',
            progress: { ...item.progress, total: book.chapters.length },
          };
        } else {
          patch = { parseState: 'failed', parseError: 'EPUB 解析失败' };
        }
      } else if (item.kind === 'image') {
        patch = { pageCount: 1, parseState: 'ready', excerpt: '' };
      } else {
        patch = { parseState: 'indexed' };
      }
    } catch (err) {
      patch = { parseState: 'failed', parseError: (err as Error).message };
    }

    const applied = this.library.applyMetadata(item.id, patch);
    let next = applied?.item ?? this.library.get(item.id);
    if (!next) return;

    // 联网补全（仅在允许且自动模式下）
    const settings = this.library.getSettings();
    if (settings.autoMetadata && settings.onlineMetadata && (next.doi || next.arxivId || (next.title && next.parseState === 'ready'))) {
      const filled = await this.completeOne(next).catch(() => null);
      if (filled) next = filled;
    }

    // 全文索引
    if (settings.fullTextIndex === 'all' || (settings.fullTextIndex === 'opened-only' && next.openCount > 0) || deep) {
      await this.indexText(next).catch(() => undefined);
      next = this.library.get(item.id) ?? next;
    }

    this.emitItems([next]);
  }

  private async completeOne(item: Item): Promise<Item | null> {
    let meta = null as Awaited<ReturnType<MetadataClient['lookupDoi']>> | Awaited<ReturnType<MetadataClient['lookupArxiv']>> | Awaited<ReturnType<MetadataClient['searchByTitle']>>;
    if (item.doi) meta = await this.metadata.lookupDoi(item.doi);
    else if (item.arxivId) meta = await this.metadata.lookupArxiv(item.arxivId);
    else if (item.title && titleQuality(item.title) >= 4) meta = await this.metadata.searchByTitle(item.title, item.year);
    if (!meta) return null;
    const patch: Partial<Item> = {};
    if (meta.title) patch.title = sanitizeTitle(meta.title);
    if (meta.authors?.length) patch.authors = meta.authors;
    if (meta.year) patch.year = meta.year;
    if (meta.venue) patch.venue = meta.venue;
    if (meta.volume) patch.volume = meta.volume;
    if (meta.issue) patch.issue = meta.issue;
    if (meta.pages) patch.pages = meta.pages;
    if (meta.doi) patch.doi = meta.doi;
    if (meta.url) patch.url = meta.url;
    if (meta.abstract) patch.abstract = meta.abstract;
    if (meta.keywords?.length) patch.keywords = meta.keywords;
    const res = this.library.applyMetadata(item.id, patch);
    return res?.item ?? null;
  }

  async completeMetadata(ids: string[]): Promise<{ updated: number; failed: number; skipped: number }> {
    let updated = 0;
    let failed = 0;
    let skipped = 0;
    for (const id of ids) {
      const item = this.library.get(id);
      if (!item) continue;
      if (!item.doi && !item.arxivId && titleQuality(item.title) < 4) {
        skipped += 1;
        continue;
      }
      const before = JSON.stringify([item.title, item.authors, item.year, item.venue]);
      const after = await this.completeOne(item).catch(() => null);
      if (!after) {
        failed += 1;
        continue;
      }
      const now = JSON.stringify([after.title, after.authors, after.year, after.venue]);
      if (now !== before) {
        updated += 1;
        this.emitItems([after]);
      } else {
        skipped += 1;
      }
    }
    if (updated) this.pushToast('success', `已补全 ${updated} 篇的元数据`, failed ? `${failed} 篇未找到` : undefined);
    else this.pushToast('info', '没有可补全的新信息', failed ? `联网查询失败 ${failed} 篇` : '可能是网络不通或文献不在 Crossref/arXiv 中');
    return { updated, failed, skipped };
  }

  async indexText(item: Item): Promise<{ ok: boolean; pages: number }> {
    if (!item.readable || item.missing) return { ok: false, pages: 0 };
    const text = await extractTextForIndex(item.path, item.kind);
    if (!text) return { ok: false, pages: 0 };
    await this.textIndex.write(item, text.pages);
    this.library.patchItem(item.id, {
      textIndexed: true,
      wordCount: text.wordCount || item.wordCount,
      pageCount: item.kind === 'pdf' ? item.pageCount : Math.max(item.pageCount, text.pages.length),
    });
    const next = this.library.get(item.id);
    if (next) this.emitItems([next]);
    return { ok: true, pages: text.pages.length };
  }

  async indexItemText(itemId: string): Promise<{ ok: boolean; pages: number }> {
    const item = this.library.get(itemId);
    if (!item) return { ok: false, pages: 0 };
    const res = await this.indexText(item);
    const next = this.library.get(itemId);
    if (next) this.emitItems([next]);
    return res;
  }

  async getItemText(itemId: string): Promise<{ pages: string[]; indexedAt: number } | null> {
    const pages = await this.textIndex.load(itemId);
    if (!pages) return null;
    return { pages, indexedAt: Date.now() };
  }

  // ------------------------------------------------------------ 批注重定位

  private async reanchorForItem(itemId: string): Promise<void> {
    const list = this.annotations.list(itemId);
    if (!list.length) return;
    const item = this.library.get(itemId);
    if (!item) return;
    const text = await extractTextForIndex(item.path, item.kind);
    if (!text) return;
    const nextList: Annotation[] = [];
    let changed = 0;
    for (const a of list) {
      const outcome = reanchorAnnotation(a, text.pages);
      if (outcome.changed) changed += 1;
      nextList.push(outcome.annotation);
    }
    if (changed) {
      this.annotations.replaceForItem(itemId, nextList);
      this.syncAnnotationCounts(itemId);
      const updated = this.library.get(itemId);
      if (updated) this.emitItems([updated]);
      this.journal.append('annotations:reanchored', { itemId, changed });
    }
  }

  private syncAnnotationCounts(itemId?: string): void {
    const counts = this.annotations.counts();
    const ids = itemId ? [itemId] : [...counts.keys(), ...this.library.all().filter((i) => i.annotationCount > 0).map((i) => i.id)];
    for (const id of new Set(ids)) {
      const item = this.library.get(id);
      const count = counts.get(id) ?? 0;
      if (item && item.annotationCount !== count) this.library.patchItem(id, { annotationCount: count });
    }
  }

  // ------------------------------------------------------------ 文件访问

  resolveFile(itemId: string): { path: string; size: number; ext: string; revision: number; kind: string } | null {
    const item = this.library.get(itemId);
    if (!item || item.missing) return null;
    return { path: item.path, size: item.size, ext: item.ext, revision: item.revision, kind: item.kind };
  }

  async readTextFile(itemId: string): Promise<{ text: string; encoding: string } | null> {
    const resolved = this.resolveFile(itemId);
    if (!resolved) return null;
    const stat = await statSafe(resolved.path);
    if (!stat?.isFile) return null;
    if (stat.size > 8 * 1024 * 1024) return null;
    return readTextFileSmart(resolved.path);
  }

  async saveThumb(itemId: string, dataUrl: string, revision: number): Promise<string | null> {
    const item = this.library.get(itemId);
    if (!item || item.revision !== revision) return null;
    const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    if (!match) return null;
    const ext = match[1] === 'image/png' ? 'png' : match[1] === 'image/webp' ? 'webp' : 'jpg';
    const name = `${item.id}-r${revision}.${ext}`;
    try {
      await ensureDir(this.thumbsDir);
      await writeFileAtomicSafe(path.join(this.thumbsDir, name), Buffer.from(match[2], 'base64'));
    } catch {
      return null;
    }
    this.library.patchItem(itemId, { thumb: name });
    const next = this.library.get(itemId);
    if (next) this.emitItems([next]);
    return name;
  }

  thumbPath(name: string): string {
    return path.join(this.thumbsDir, name);
  }

  // ------------------------------------------------------------ 笔记

  private async writeNoteFile(item: Item): Promise<void> {
    await ensureDir(this.notesDir);
    const file = path.join(this.notesDir, `${item.id}.md`);
    await writeFileAtomicSafe(file, `<!-- ${item.title} -->\n\n${item.note}`);
  }

  /** 把外部编辑过的笔记文件读回来（软件内与磁盘双向同步） */
  private async restoreNotesFromDisk(): Promise<void> {
    for (const item of this.library.all()) {
      const file = path.join(this.notesDir, `${item.id}.md`);
      try {
        const text = await fs.readFile(longPath(file), 'utf8');
        const body = text.replace(/^<!--[\s\S]*?-->\s*/, '');
        if (body.trim() && body.trim() !== item.note.trim()) {
          this.journal.append('note:adopt-external', { itemId: item.id, chars: body.length });
          this.library.patchItem(item.id, { note: body });
        }
      } catch {
        /* 没有笔记文件 */
      }
    }
  }

  async setNote(itemId: string, markdown: string): Promise<Item | null> {
    const item = this.library.editItem(itemId, { note: markdown }, ['note']);
    if (!item) return null;
    this.noteDirty.add(itemId);
    await this.writeNoteFile(item).catch(() => undefined);
    this.noteDirty.delete(itemId);
    this.emitItems([item]);
    return item;
  }

  // ------------------------------------------------------------ 批注 API

  listAnnotations(itemId: string): Annotation[] {
    return this.annotations.list(itemId);
  }

  listAllAnnotations(): Annotation[] {
    return this.annotations.all();
  }

  addAnnotation(input: Omit<Annotation, 'id' | 'createdAt' | 'updatedAt' | 'reanchored' | 'needsReview'> & { id?: string }): Annotation {
    const a = this.annotations.add(input);
    this.syncAnnotationCounts(a.itemId);
    const item = this.library.get(a.itemId);
    if (item) this.emitItems([item]);
    return a;
  }

  updateAnnotation(id: string, patch: Partial<Annotation>): Annotation | null {
    const a = this.annotations.update(id, patch);
    if (!a) return null;
    const item = this.library.get(a.itemId);
    if (item) this.emitItems([item]);
    return a;
  }

  deleteAnnotation(id: string): string | null {
    const itemId = this.annotations.remove(id);
    if (!itemId) return null;
    this.syncAnnotationCounts(itemId);
    const item = this.library.get(itemId);
    if (item) this.emitItems([item]);
    return itemId;
  }

  reanchorAnnotation(id: string, page: number, rects: Annotation['rects'], text?: string): Annotation | null {
    const a = this.annotations.get(id);
    if (!a) return null;
    const next = this.annotations.update(id, {
      page,
      rects,
      text: text ?? a.text,
      reanchored: true,
      needsReview: false,
      reanchorNote: `按文本重新定位到 P${page}`,
    });
    const item = this.library.get(a.itemId);
    if (item) this.emitItems([item]);
    return next;
  }

  // ------------------------------------------------------------ 检索

  async search(query: string, limit = 300): Promise<SearchResult[]> {
    const trimmed = query.trim();
    const items = this.library.all();
    if (!trimmed) {
      return items.slice(0, limit).map((item) => ({ item, score: 0, fields: [], contexts: [] }));
    }
    const annotationsFor = (id: string) => this.annotations.list(id);
    const sync = searchItems(items, trimmed, { text: (id) => this.textIndex.get(id), annotations: annotationsFor }, limit);
    if (sync.length >= limit) return sync;

    // 全文兜底：把"内存里没有、但磁盘上有索引"的条目流式读进来再搜一次
    const q = parseQuery(trimmed);
    const needsFullText = q.terms.length > 0 || q.phrases.length > 0;
    if (!needsFullText) return sync;
    const already = new Set(sync.map((r) => r.item.id));
    const candidates = items.filter((i) => i.textIndexed && !already.has(i.id));
    if (!candidates.length) return sync;

    const extra: SearchResult[] = [];
    let budget = 400; // 最多再读 400 篇的全文，避免一次搜索读爆磁盘
    for (const item of candidates) {
      if (budget-- <= 0) break;
      if (this.textIndex.has(item.id)) continue;
      const pages = await this.textIndex.load(item.id).catch(() => null);
      if (!pages) continue;
      const res = searchItems([item], trimmed, { text: () => pages, annotations: annotationsFor }, 1);
      if (res.length) extra.push(res[0]);
      if (sync.length + extra.length >= limit) break;
    }
    return [...sync, ...extra].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ------------------------------------------------------------ 导出

  async exportLibrary(opts: ExportOptions): Promise<{ ok: boolean; content?: string; savedTo?: string; count: number }> {
    const items = opts.ids?.length
      ? (opts.ids.map((id) => this.library.get(id)).filter(Boolean) as Item[])
      : this.library.all();
    const content = exportContent(items, opts, (id) => this.annotations.list(id));
    const name = `litshelf-${new Date().toISOString().slice(0, 10)}.${EXPORT_EXT[opts.format]}`;
    if (this.mode === 'electron') {
      const target = path.join(this.dataDir, 'exports', name);
      await ensureDir(path.dirname(target));
      await writeFileAtomicSafe(target, content);
      return { ok: true, content, savedTo: target, count: items.length };
    }
    return { ok: true, content, savedTo: name, count: items.length };
  }

  copyCitation(itemId: string, style: string): string {
    const item = this.library.get(itemId);
    if (!item) return '';
    return formatCitation(item, style);
  }

  // ------------------------------------------------------------ 维护

  async rebuildIndex(): Promise<void> {
    await this.textIndex.clear();
    for (const item of this.library.all()) {
      this.library.patchItem(item.id, { parseState: 'placeholder', textIndexed: false, thumb: null });
    }
    this.pushToast('info', '正在重建索引', '用户数据（标签、笔记、批注、阅读进度）不受影响');
    await this.scanAll();
  }

  async clearCache(kind: 'thumbs' | 'text' | 'all'): Promise<void> {
    if (kind === 'thumbs' || kind === 'all') {
      await rmSafe(this.thumbsDir, true);
      await ensureDir(this.thumbsDir);
      for (const item of this.library.all()) {
        if (item.thumb) this.library.patchItem(item.id, { thumb: null });
      }
    }
    if (kind === 'text' || kind === 'all') {
      await this.textIndex.clear();
      for (const item of this.library.all()) {
        if (item.textIndexed) this.library.patchItem(item.id, { textIndexed: false });
      }
    }
    this.emitItems(this.library.all());
    this.pushToast('success', '缓存已清理');
  }

  async exportDiagnostics(): Promise<{ ok: boolean; savedTo?: string; content?: string }> {
    const payload = {
      at: new Date().toISOString(),
      version: this.version,
      mode: this.mode,
      platform: process.platform,
      node: process.version,
      dataDir: this.dataDir,
      settings: this.library.getSettings(),
      roots: this.library.getRoots(),
      stats: {
        items: this.library.size(),
        missing: this.library.all().filter((i) => i.missing).length,
        ready: this.library.all().filter((i) => i.parseState === 'ready').length,
        failed: this.library.all().filter((i) => i.parseState === 'failed').length,
        textIndexed: this.library.all().filter((i) => i.textIndexed).length,
        annotations: this.annotations.all().length,
        textIndex: this.textIndex.stats(),
      },
      progress: this.getProgress(),
      journal: this.journal.tailSync(120),
    };
    const content = JSON.stringify(payload, null, 2);
    if (this.mode === 'electron') {
      const target = path.join(this.dataDir, 'exports', `litshelf-diagnostics-${Date.now()}.json`);
      await ensureDir(path.dirname(target));
      await writeFileAtomicSafe(target, content);
      return { ok: true, savedTo: target, content };
    }
    return { ok: true, content, savedTo: 'litshelf-diagnostics.json' };
  }

  // ------------------------------------------------------------ 根目录管理

  async addRoot(dirPath: string, opts: { depth?: number } = {}): Promise<{ root: Root; added: number }> {
    const stat = await statSafe(dirPath);
    if (!stat?.isDir) throw new Error(`不是有效的文件夹：${dirPath}`);
    // 统一成真实长路径：短路径（8.3）会让 libuv 的目录监听断言崩溃，
    // 而且长短路径混用会让"条目路径 vs 监听事件路径"对不上。
    const real = await fs.realpath(longPath(dirPath)).catch(() => path.resolve(dirPath));
    const root = this.library.addRoot(real, { depth: opts.depth });
    this.emitRoots();
    await this.scanRoot(root.id).catch(() => undefined);
    this.startWatch(root);
    const added = this.library.all().filter((i) => i.rootId === root.id).length;
    return { root, added };
  }

  async removeRoot(rootId: string, opts: { forgetItems?: boolean } = {}): Promise<void> {
    await this.closeWatch(rootId);
    const removed = this.library.removeRoot(rootId, opts);
    if (opts.forgetItems) {
      for (const id of removed) this.annotations.removeForItem(id);
      this.emit({ type: 'items:remove', ids: removed });
    } else {
      // 只解绑根目录：条目保留，但标记为文件缺失，等用户重新指定
      const orphanIds = this.library
        .all()
        .filter((i) => i.rootId === rootId)
        .map((i) => i.id);
      this.library.patchItems(orphanIds, { missing: true, missingSince: Date.now() });
      this.emitItems(orphanIds.map((id) => this.library.get(id)).filter(Boolean) as Item[]);
    }
    this.emitRoots();
  }

  setRootEnabled(rootId: string, enabled: boolean): void {
    this.library.setRootEnabled(rootId, enabled);
    const root = this.library.getRoot(rootId);
    if (!root) return;
    if (enabled) {
      void this.scanRoot(rootId).catch(() => undefined);
      this.startWatch(root);
    } else {
      void this.closeWatch(rootId);
    }
    this.emitRoots();
  }

  // ------------------------------------------------------------ 条目操作（含撤销）

  updateItem(itemId: string, patch: Partial<Item>): Item | null {
    const userFields: (keyof Item)[] = ['title', 'authors', 'year', 'venue', 'volume', 'issue', 'pages', 'doi', 'url', 'abstract', 'keywords']
      .filter((k) => k in patch)
      .map((k) => k as keyof Item);
    const item = userFields.length ? this.library.editItem(itemId, patch, userFields) : this.library.patchItem(itemId, patch);
    if (item) this.emitItems([item]);
    return item;
  }

  updateItems(ids: string[], patch: Partial<Item>): Item[] {
    const items = this.library.patchItems(ids, patch);
    this.emitItems(items);
    return items;
  }

  pushUndo(name: string, run: () => Promise<void>): void {
    this.undoStack.push({ name, at: Date.now(), run });
    if (this.undoStack.length > 30) this.undoStack.shift();
  }

  async undo(name: string): Promise<boolean> {
    const idx = [...this.undoStack].reverse().findIndex((u) => u.name === name);
    if (idx < 0) return false;
    const realIdx = this.undoStack.length - 1 - idx;
    const [entry] = this.undoStack.splice(realIdx, 1);
    await entry.run();
    this.undoStack = this.undoStack.filter((u) => Date.now() - u.at < 10 * 60 * 1000);
    this.journal.append('undo', { name });
    return true;
  }

  deleteItems(ids: string[], opts: { alsoDeleteFile?: boolean } = {}): void {
    const snapshot = ids
      .map((id) => ({ item: this.library.get(id), annotations: this.annotations.list(id) }))
      .filter((s): s is { item: Item; annotations: Annotation[] } => !!s.item);
    for (const id of ids) {
      this.annotations.removeForItem(id);
      this.library.deleteItem(id);
    }
    this.emit({ type: 'items:remove', ids });
    this.emitTags();
    this.pushUndo('deleteItems', async () => {
      for (const { item, annotations } of snapshot) {
        this.restoreItemInternal(item, annotations);
      }
      this.emitItems(snapshot.map((s) => s.item));
      this.emitTags();
    });
    const hint = opts.alsoDeleteFile ? '（含磁盘文件）' : '（磁盘文件未动）';
    this.pushToast('success', `已从库中移除 ${ids.length} 条`, `笔记与批注可撤销恢复${hint}`, 9000, {
      action: { label: '撤销', name: 'deleteItems' },
    });
    this.journal.append('items:delete', { ids: ids.length });
  }

  private restoreItemInternal(item: Item, annotations: Annotation[]): void {
    this.library.restoreItem(item);
    if (annotations.length) this.annotations.replaceForItem(item.id, annotations);
  }

  async rebindItem(itemId: string, newPath: string): Promise<Item | null> {
    const item = await this.library.rebindItem(itemId, newPath);
    if (!item) return null;
    this.emitItems([item]);
    this.enqueueExtract(item.id, false);
    return item;
  }

  markOpened(itemId: string): Item | null {
    const item = this.library.get(itemId);
    if (!item) return null;
    const next = this.library.patchItem(itemId, {
      openCount: item.openCount + 1,
      lastOpenedAt: Date.now(),
      readState: item.readState === 'unread' ? 'reading' : item.readState,
    });
    if (!next) return null;
    const settings = this.library.getSettings();
    if (settings.fullTextIndex !== 'off' && !next.textIndexed) {
      void this.indexText(next).catch(() => undefined);
    }
    this.emitItems([next]);
    return next;
  }

  setProgress(itemId: string, progress: Partial<Item['progress']>): void {
    const item = this.library.get(itemId);
    if (!item) return;
    const next = { ...item.progress, ...progress, updatedAt: Date.now() };
    if (next.total && next.page) next.percent = Math.min(100, Math.max(0, (next.page / next.total) * 100));
    const updated = this.library.patchItem(itemId, {
      progress: next,
      readState: item.readState === 'unread' ? 'reading' : item.readState,
    });
    // 必须广播：否则界面里的条目副本会停在旧进度（阅读器自己 patchLocal 兜住了，
    // 但任何"非阅读器发起"的进度写入都会留下陈旧状态）
    if (updated) this.emitItems([updated]);
  }

  getFolderTree(): { rootId: string; rootName: string; rootPath: string; dirs: string[] }[] {
    return this.library.getRoots().map((root) => {
      const dirs = new Set<string>();
      for (const item of this.library.all()) {
        if (item.rootId !== root.id) continue;
        if (item.dir) dirs.add(item.dir);
      }
      return {
        rootId: root.id,
        rootName: root.name,
        rootPath: root.path,
        dirs: [...dirs].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
      };
    });
  }

  /** 供设置页显示：库统计 */
  stats(): { items: number; missing: number; ready: number; failed: number; textIndexed: number; annotations: number; roots: number; diskLabel: string } {
    const items = this.library.all();
    return {
      items: items.length,
      missing: items.filter((i) => i.missing).length,
      ready: items.filter((i) => i.parseState === 'ready').length,
      failed: items.filter((i) => i.parseState === 'failed').length,
      textIndexed: items.filter((i) => i.textIndexed).length,
      annotations: this.annotations.all().length,
      roots: this.library.getRoots().length,
      diskLabel: humanSize(items.reduce((n, i) => n + i.size, 0)),
    };
  }

  // ------------------------------------------------------------ 批量条目操作

  getItem(itemId: string): Item | null {
    return this.library.get(itemId);
  }

  listTags(): string[] {
    return this.library.tags();
  }

  setReadState(ids: string[], state: Item['readState']): Item[] {
    const before = ids.map((id) => ({ id, readState: this.library.get(id)?.readState ?? 'unread' }));
    const items = this.library.patchItems(ids, { readState: state });
    this.emitItems(items);
    this.pushUndo('setReadState', async () => {
      for (const b of before) this.library.patchItem(b.id, { readState: b.readState });
      this.emitItems(before.map((b) => this.library.get(b.id)).filter(Boolean) as Item[]);
    });
    return items;
  }

  toggleStar(ids: string[]): Item[] {
    const items: Item[] = [];
    for (const id of ids) {
      const item = this.library.get(id);
      if (!item) continue;
      const next = this.library.patchItem(id, { starred: !item.starred });
      if (next) items.push(next);
    }
    this.emitItems(items);
    return items;
  }

  addTags(ids: string[], tags: string[]): Item[] {
    const clean = tags.map((t) => t.trim()).filter(Boolean);
    if (!clean.length) return [];
    const before = ids.map((id) => ({ id, tags: this.library.get(id)?.tags ?? [] }));
    const items: Item[] = [];
    for (const id of ids) {
      const item = this.library.get(id);
      if (!item) continue;
      const next = this.library.patchItem(id, { tags: [...new Set([...item.tags, ...clean])] });
      if (next) items.push(next);
    }
    this.emitItems(items);
    this.emitTags();
    this.pushUndo('addTags', async () => {
      for (const b of before) this.library.patchItem(b.id, { tags: b.tags });
      this.emitItems(before.map((b) => this.library.get(b.id)).filter(Boolean) as Item[]);
      this.emitTags();
    });
    return items;
  }

  removeTags(ids: string[], tags: string[]): Item[] {
    const drop = new Set(tags);
    const before = ids.map((id) => ({ id, tags: this.library.get(id)?.tags ?? [] }));
    const items: Item[] = [];
    for (const id of ids) {
      const item = this.library.get(id);
      if (!item) continue;
      const next = this.library.patchItem(id, { tags: item.tags.filter((t) => !drop.has(t)) });
      if (next) items.push(next);
    }
    this.emitItems(items);
    this.emitTags();
    this.pushUndo('removeTags', async () => {
      for (const b of before) this.library.patchItem(b.id, { tags: b.tags });
      this.emitItems(before.map((b) => this.library.get(b.id)).filter(Boolean) as Item[]);
      this.emitTags();
    });
    return items;
  }

  renameTag(from: string, to: string): void {
    const target = to.trim();
    const affected: { id: string; tags: string[] }[] = [];
    for (const item of this.library.all()) {
      if (!item.tags.includes(from)) continue;
      affected.push({ id: item.id, tags: item.tags });
      const next = target
        ? [...new Set(item.tags.map((t) => (t === from ? target : t)))]
        : item.tags.filter((t) => t !== from);
      this.library.patchItem(item.id, { tags: next });
    }
    this.emitItems(affected.map((a) => this.library.get(a.id)).filter(Boolean) as Item[]);
    this.emitTags();
    this.pushUndo('renameTag', async () => {
      for (const a of affected) this.library.patchItem(a.id, { tags: a.tags });
      this.emitItems(affected.map((a) => this.library.get(a.id)).filter(Boolean) as Item[]);
      this.emitTags();
    });
  }

  deleteTag(tag: string): void {
    this.renameTag(tag, '');
  }

  restoreItems(ids: string[]): Item[] {
    const items: Item[] = [];
    for (const id of ids) {
      const item = this.library.get(id);
      if (!item) continue;
      const next = this.library.patchItem(id, { missing: false, missingSince: null });
      if (next) items.push(next);
    }
    this.emitItems(items);
    return items;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.library.updateSettings(patch);
    const settings = this.library.getSettings();
    this.metadata.setOnline(settings.onlineMetadata);
    this.settingsFile.set(settings);
    void this.settingsFile.flushNow().catch(() => undefined);
    if ('reconcileIntervalMs' in patch) this.scheduleReconcile();
    if ('fullTextIndex' in patch && settings.fullTextIndex === 'all') {
      this.pushToast('info', '正在为全库建立全文索引', '可以继续正常使用，索引在后台进行');
      for (const item of this.library.all()) {
        if (!item.textIndexed && item.readable) this.enqueueExtract(item.id, true);
      }
    }
    this.emitSettings();
    return settings;
  }

  /** 批量刷新根目录计数（事件批次结束后调用一次，避免每条文件走一遍 O(n)） */
  refreshRootCounts(): void {
    for (const root of this.library.getRoots()) {
      const count = this.library.all().filter((i) => i.rootId === root.id).length;
      if (count !== root.itemCount) this.library.markRootScanned(root.id, count);
    }
    this.emitRoots();
  }
}

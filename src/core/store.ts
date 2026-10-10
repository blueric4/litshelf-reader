/**
 * 持久化：原子写 + 备份 + 崩溃恢复 + 追加式日志。
 * 不依赖任何原生模块；单文件 JSON 对单机文献库（万级条目）完全够用，
 * 且预留了 Store 抽象，未来可平滑迁移到 SQLite。
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { longPath } from './paths';

export interface JournalEntry {
  at: number;
  action: string;
  detail?: unknown;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(longPath(dir), { recursive: true });
}

/** 原子写：临时文件 + rename；写前保留 .bak */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const target = longPath(file);
  await ensureDir(path.dirname(file));
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
  try {
    await fs.copyFile(target, `${target}.bak`);
  } catch {
    /* 首次写入没有旧文件 */
  }
  await fs.rename(tmp, target);
}

export interface JsonFileOptions<T> {
  file: string;
  defaults: () => T;
  /** 校验并归一化；返回 null 表示这份数据不可用 */
  revive?: (raw: unknown) => T | null;
  pretty?: boolean;
  /** 落盘防抖（ms） */
  debounceMs?: number;
}

export class JsonFile<T> {
  private readonly opts: JsonFileOptions<T>;
  private value: T;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> | null = null;
  private loaded = false;
  /** 读取时是否发生了损坏回滚 */
  recovered = false;

  constructor(opts: JsonFileOptions<T>) {
    this.opts = opts;
    this.value = opts.defaults();
  }

  get(): T {
    return this.value;
  }

  async load(): Promise<T> {
    const file = longPath(this.opts.file);
    const tryRead = async (f: string): Promise<unknown | undefined> => {
      try {
        const text = await fs.readFile(f, 'utf8');
        if (!text.trim()) return undefined;
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    };

    let raw = await tryRead(file);
    if (raw === undefined) {
      const bak = await tryRead(`${file}.bak`);
      if (bak !== undefined) {
        raw = bak;
        this.recovered = true;
        // 把损坏的原文件留档，绝不销毁用户数据
        try {
          await fs.rename(file, `${file}.corrupt-${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
    }

    if (raw !== undefined && this.opts.revive) {
      const revived = this.opts.revive(raw);
      if (revived) {
        this.value = revived;
        this.loaded = true;
        return this.value;
      }
    }
    if (raw !== undefined && !this.opts.revive && raw && typeof raw === 'object') {
      this.value = raw as T;
      this.loaded = true;
      return this.value;
    }
    this.value = this.opts.defaults();
    this.loaded = true;
    return this.value;
  }

  set(next: T): void {
    this.value = next;
    this.dirty = true;
    this.schedule();
  }

  /** 就地修改并安排落盘 */
  mutate(fn: (draft: T) => void): T {
    fn(this.value);
    this.dirty = true;
    this.schedule();
    return this.value;
  }

  private schedule(): void {
    const ms = this.opts.debounceMs ?? 800;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, ms);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    if (this.writing) {
      await this.writing;
      if (!this.dirty) return;
    }
    this.dirty = false;
    const snapshot = JSON.stringify(this.value, null, this.opts.pretty ? 2 : 0);
    this.writing = writeFileAtomic(this.opts.file, snapshot)
      .catch((err) => {
        this.dirty = true;
        console.error('[litshelf] 落盘失败', this.opts.file, err);
      })
      .finally(() => {
        this.writing = null;
      });
    await this.writing;
  }

  async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
    if (this.writing) await this.writing;
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}

/** 追加式日志（诊断 / 崩溃后定位最近动作） */
export class Journal {
  private readonly file: string;
  private queue: JournalEntry[] = [];
  private writing = false;

  constructor(file: string, private readonly maxEntries = 200) {
    this.file = file;
  }

  append(action: string, detail?: unknown): void {
    this.queue.push({ at: Date.now(), action, detail });
    if (this.queue.length > this.maxEntries) this.queue.splice(0, this.queue.length - this.maxEntries);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.writing || this.queue.length === 0) return;
    this.writing = true;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await ensureDir(path.dirname(this.file));
      await fs.appendFile(longPath(this.file), batch.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      await this.trim();
    } catch {
      /* 日志失败不影响主流程 */
    } finally {
      this.writing = false;
      // 写盘期间 append 进来的条目只会堆在 queue 里，必须自己再排一次，
      // 否则它们要等到"下一次 append"才可能落盘（崩溃时直接丢日志）。
      if (this.queue.length) void this.drain();
    }
  }

  private async trim(): Promise<void> {
    try {
      const stat = await fs.stat(longPath(this.file));
      if (stat.size < 512 * 1024) return;
      const text = await fs.readFile(longPath(this.file), 'utf8');
      const lines = text.split('\n').filter(Boolean).slice(-this.maxEntries);
      await writeFileAtomic(this.file, lines.join('\n') + '\n');
    } catch {
      /* ignore */
    }
  }

  tailSync(limit = 50): JournalEntry[] {
    try {
      const text = fssync.readFileSync(longPath(this.file), 'utf8');
      return text
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .map((l) => {
          try {
            return JSON.parse(l) as JournalEntry;
          } catch {
            return { at: 0, action: 'unparsable' };
          }
        });
    } catch {
      return [];
    }
  }
}

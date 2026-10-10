/**
 * 全文索引缓存：每篇一个文件（cache/text/<id>.json），内存里保留有上限的 LRU。
 * 放文件而不是一个大 JSON，是为了避免库变大后整个索引文件被反复重写。
 */
import path from 'node:path';
import type { Item } from '../shared/types';
import { readJsonSafe, rmSafe, writeFileAtomicSafe, ensureDir } from './fsutil';

interface TextFile {
  itemId: string;
  revision: number;
  indexedAt: number;
  pages: string[];
  chars: number;
}

export interface TextIndexStats {
  count: number;
  chars: number;
  memoryItems: number;
  memoryChars: number;
}

export class TextIndex {
  private dir: string;
  private mem = new Map<string, TextFile>();
  private memChars = 0;
  private readonly maxMemChars: number;
  private readonly maxMemItems: number;

  constructor(cacheDir: string, opts: { maxMemChars?: number; maxMemItems?: number } = {}) {
    this.dir = path.join(cacheDir, 'text');
    this.maxMemChars = opts.maxMemChars ?? 96 * 1024 * 1024;
    this.maxMemItems = opts.maxMemItems ?? 400;
  }

  fileFor(itemId: string): string {
    return path.join(this.dir, `${itemId}.json`);
  }

  /** 内存命中（同步，供检索打分用） */
  get(itemId: string): string[] | null {
    const hit = this.mem.get(itemId);
    if (!hit) return null;
    // LRU 触碰
    this.mem.delete(itemId);
    this.mem.set(itemId, hit);
    return hit.pages;
  }

  has(itemId: string): boolean {
    return this.mem.has(itemId);
  }

  async load(itemId: string): Promise<string[] | null> {
    const mem = this.mem.get(itemId);
    if (mem) return mem.pages;
    const data = await readJsonSafe<TextFile>(this.fileFor(itemId));
    if (!data || !Array.isArray(data.pages)) return null;
    this.put(itemId, data);
    return data.pages;
  }

  private put(itemId: string, data: TextFile): void {
    const prev = this.mem.get(itemId);
    if (prev) this.memChars -= prev.chars;
    this.mem.set(itemId, data);
    this.memChars += data.chars;
    while ((this.memChars > this.maxMemChars || this.mem.size > this.maxMemItems) && this.mem.size > 1) {
      const oldest = this.mem.keys().next().value as string | undefined;
      if (!oldest) break;
      const dropped = this.mem.get(oldest);
      if (dropped) this.memChars -= dropped.chars;
      this.mem.delete(oldest);
    }
  }

  /** 写入某篇的全文索引（原子写，单文件一页一页存） */
  async write(item: Item, pages: string[]): Promise<void> {
    const chars = pages.reduce((n, p) => n + p.length, 0);
    const data: TextFile = { itemId: item.id, revision: item.revision, indexedAt: Date.now(), pages, chars };
    this.put(item.id, data);
    await ensureDir(this.dir);
    await writeFileAtomicSafe(this.fileFor(item.id), JSON.stringify(data));
  }

  async remove(itemId: string): Promise<void> {
    const hit = this.mem.get(itemId);
    if (hit) {
      this.memChars -= hit.chars;
      this.mem.delete(itemId);
    }
    await rmSafe(this.fileFor(itemId));
  }

  async clear(): Promise<void> {
    this.mem.clear();
    this.memChars = 0;
    await rmSafe(this.dir, true);
  }

  /** 是否已有索引文件（不同步读全量内容，只做存在性检查由上层负责） */
  stats(): TextIndexStats {
    return { count: this.mem.size, chars: this.memChars, memoryItems: this.mem.size, memoryChars: this.memChars };
  }
}

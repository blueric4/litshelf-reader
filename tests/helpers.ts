/**
 * 测试公共工具。
 *
 * 约定：
 * - 所有临时文件都写在 os.tmpdir() 下的唯一子目录里（fs.mkdtemp），
 *   用 tempTracker() 登记，afterEach 整体删除，绝不污染仓库目录。
 * - FsEntry 一律用 entryFor() 从真实文件生成，保证 size/mtime/fingerprint
 *   与 Library 对账时看到的一致。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fingerprintFile } from '@core/fingerprint';
import { emptyProgress, Library, type FsEntry } from '@core/library';
import { extOf, relativize } from '@core/paths';
import { kindOf, type Annotation, type Item } from '@shared/types';

// ------------------------------------------------------------------ 临时目录

export async function makeTempDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `litshelf-${label}-`));
}

export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

export interface TempTracker {
  /** 建一个唯一临时目录并登记，测试结束后自动删除 */
  make(label: string): Promise<string>;
  cleanup(): Promise<void>;
}

export function tempTracker(): TempTracker {
  const dirs: string[] = [];
  return {
    async make(label: string): Promise<string> {
      const dir = await makeTempDir(label);
      dirs.push(dir);
      return dir;
    },
    async cleanup(): Promise<void> {
      const pending = dirs.splice(0, dirs.length);
      await Promise.all(pending.map((d) => removeDir(d)));
    },
  };
}

// ------------------------------------------------------------------ 造文件

export async function writeText(file: string, text: string): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  return file;
}

export async function writeBytes(file: string, bytes: Buffer): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return file;
}

/** 确定性伪随机字节（不用 Math.random，失败可复现） */
export function pseudoRandomBytes(size: number, seed = 1): Buffer {
  const buf = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

export async function readText(file: string): Promise<string> {
  return fs.readFile(file, 'utf8');
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 目录下所有文件（相对路径，posix 分隔），用于检查临时文件是否残留 */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (cur: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(cur, e.name), rel);
      else out.push(rel);
    }
  };
  await walk(dir, '');
  return out.sort();
}

// ------------------------------------------------------------------ 造 FsEntry

/** 从磁盘上的真实文件生成一条对账输入（指纹 / 大小 / mtime 全部取自实际文件） */
export async function entryFor(rootPath: string, absPath: string): Promise<FsEntry> {
  const name = path.basename(absPath);
  const fp = await fingerprintFile(absPath);
  if (!fp) throw new Error(`fingerprintFile 失败，文件不存在？${absPath}`);
  const stat = await fs.stat(absPath);
  const { relPath, dir } = relativize(rootPath, absPath);
  const ext = extOf(name);
  const kind = kindOf(ext);
  return {
    path: absPath,
    relPath,
    dir,
    name,
    ext,
    kind,
    size: fp.size,
    mtime: fp.mtime,
    ctime: stat.ctimeMs,
    fingerprint: fp.fingerprint,
  };
}

export async function entriesFor(rootPath: string, absPaths: string[]): Promise<FsEntry[]> {
  const out: FsEntry[] = [];
  for (const p of absPaths) out.push(await entryFor(rootPath, p));
  return out;
}

// ------------------------------------------------------------------ 造 Library

/** 在 dataDir 下建一个库（library.json 与文献目录分开，避免互相干扰） */
export async function openLibrary(dataDir: string): Promise<Library> {
  const lib = new Library(path.join(dataDir, 'library.json'));
  await lib.load();
  return lib;
}

// ------------------------------------------------------------------ 造 Item / Annotation

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

/** 构造条目：progress 允许只写几个字段，其余用默认值补齐 */
export type ItemOverrides = Partial<Omit<Item, 'progress'>> & { progress?: Partial<Item['progress']> };

export function makeItem(over: ItemOverrides = {}): Item {
  const now = 1_700_000_000_000;
  const base: Item = {
    id: nextId('it_'),
    rootId: 'rt_test',
    path: 'C:\\lib\\sample.pdf',
    relPath: 'sample.pdf',
    dir: '',
    name: 'sample.pdf',
    ext: 'pdf',
    kind: 'pdf',
    readable: true,
    size: 1024,
    mtime: now,
    ctime: now,
    fingerprint: `fp-${nextId('')}`,
    title: 'Sample Title',
    authors: [],
    year: 2020,
    venue: '',
    volume: '',
    issue: '',
    pages: '',
    doi: '',
    arxivId: '',
    url: '',
    abstract: '',
    keywords: [],
    language: '',
    pageCount: 10,
    wordCount: 0,
    excerpt: '',
    tags: [],
    collections: [],
    colorTag: '',
    starred: false,
    readState: 'unread',
    progress: emptyProgress(),
    note: '',
    annotationCount: 0,
    userEdited: [],
    missing: false,
    missingSince: null,
    addedAt: now,
    lastOpenedAt: null,
    openCount: 0,
    thumb: null,
    parseState: 'placeholder',
    textIndexed: false,
    revision: 1,
  };
  const { progress, ...rest } = over;
  const merged: Item = { ...base, ...rest };
  merged.progress = { ...base.progress, ...(progress ?? {}) };
  return merged;
}

export function makeAnnotation(over: Partial<Annotation> = {}): Annotation {
  const now = 1_700_000_000_000;
  return {
    id: nextId('an_'),
    itemId: 'it_test',
    type: 'highlight',
    page: 1,
    rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }],
    text: '',
    anchor: { prefix: '', suffix: '', occurrence: 1 },
    comment: '',
    color: 'yellow',
    reanchored: false,
    needsReview: false,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

// ------------------------------------------------------------------ 其他

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** 轮询等待条件成立（用于日志/落盘这类异步副作用） */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
  stepMs = 10,
  what = '条件',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${what}`);
    await sleep(stepMs);
  }
}

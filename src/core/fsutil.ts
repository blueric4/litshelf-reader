/**
 * 文件系统小工具：一律走 longPath，一律"失败不抛"。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { longPath } from './paths';

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(longPath(dir), { recursive: true });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(longPath(p));
    return true;
  } catch {
    return false;
  }
}

export async function statSafe(p: string): Promise<{ size: number; mtime: number; ctime: number; isFile: boolean; isDir: boolean } | null> {
  try {
    const s = await fs.stat(longPath(p));
    return { size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs, isFile: s.isFile(), isDir: s.isDirectory() };
  } catch {
    return null;
  }
}

export async function writeFileAtomicSafe(file: string, content: string | Buffer): Promise<void> {
  const target = longPath(file);
  await ensureDir(path.dirname(file));
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(content);
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, target);
}

export async function readJsonSafe<T>(file: string): Promise<T | null> {
  try {
    const text = await fs.readFile(longPath(file), 'utf8');
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function rmSafe(target: string, recursive = false): Promise<void> {
  try {
    await fs.rm(longPath(target), { recursive, force: true });
  } catch {
    /* ignore */
  }
}

export async function listDirSafe(dir: string): Promise<{ name: string; isDir: boolean; isFile: boolean; size: number; mtime: number }[]> {
  try {
    const entries = await fs.readdir(longPath(dir), { withFileTypes: true });
    const out: { name: string; isDir: boolean; isFile: boolean; size: number; mtime: number }[] = [];
    for (const e of entries) {
      let size = 0;
      let mtime = 0;
      if (e.isFile()) {
        const s = await statSafe(path.join(dir, e.name));
        size = s?.size ?? 0;
        mtime = s?.mtime ?? 0;
      }
      out.push({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile(), size, mtime });
    }
    return out;
  } catch {
    return [];
  }
}

/** 目录是否可写（用于判断"只读目录"场景） */
export async function isWritable(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.litshelf-write-test-${process.pid}`);
  try {
    await fs.writeFile(longPath(probe), 'x');
    await fs.rm(longPath(probe), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 简单的串行队列，保证同一文件的写入顺序 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

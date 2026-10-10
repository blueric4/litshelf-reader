/**
 * 内容指纹：用于识别"改名 / 移动"。
 * 策略：文件大小 + 首 64KB + 尾 64KB 的 SHA-1 前 20 字节（十六进制）。
 * 小文件直接整文件哈希。既快又几乎不会碰撞到需要担心的程度。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { longPath } from './paths';

const CHUNK = 64 * 1024;

export interface FingerprintResult {
  fingerprint: string;
  size: number;
  mtime: number;
  /** 小文件整文件哈希时为 true */
  whole: boolean;
}

export async function fingerprintFile(filePath: string): Promise<FingerprintResult | null> {
  const target = longPath(filePath);
  let handle: fs.FileHandle | null = null;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return null;
    const size = stat.size;
    handle = await fs.open(target, 'r');
    const hash = createHash('sha1');
    hash.update(`v1:${size}:`);

    if (size <= CHUNK * 2) {
      const buf = Buffer.alloc(size);
      if (size > 0) await handle.read(buf, 0, size, 0);
      hash.update(buf);
      return { fingerprint: hash.digest('hex').slice(0, 40), size, mtime: stat.mtimeMs, whole: true };
    }

    const head = Buffer.alloc(CHUNK);
    await handle.read(head, 0, CHUNK, 0);
    hash.update(head);

    const tail = Buffer.alloc(CHUNK);
    await handle.read(tail, 0, CHUNK, size - CHUNK);
    hash.update(tail);

    return { fingerprint: hash.digest('hex').slice(0, 40), size, mtime: stat.mtimeMs, whole: false };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** 同一文件在两次扫描间是否"内容未变"（先用 size+mtime 快速判断） */
export function isUnchanged(
  prev: { size: number; mtime: number; fingerprint: string },
  next: { size: number; mtime: number },
): boolean {
  return prev.size === next.size && Math.abs(prev.mtime - next.mtime) < 2;
}

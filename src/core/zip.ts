/**
 * 极简 ZIP 读取器（只做"读中央目录 + inflateRaw"），用于 EPUB。
 * 不引入任何依赖：EPUB 就是 ZIP，读条目足够。
 */
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { longPath } from './paths';

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  method: number;
  offset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

export async function readZipEntries(filePath: string): Promise<ZipEntry[]> {
  const buf = await fs.readFile(longPath(filePath));
  return parseZipEntries(buf);
}

export function parseZipEntries(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  const min = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count && ptr + 46 <= buf.length; i += 1) {
    if (buf.readUInt32LE(ptr) !== CEN_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const size = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const offset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    entries.push({ name, size, compressedSize, method, offset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer | null {
  try {
    const at = entry.offset;
    if (buf.readUInt32LE(at) !== 0x04034b50) return null;
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const start = at + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) return zlib.inflateRawSync(raw);
    return null;
  } catch {
    return null;
  }
}

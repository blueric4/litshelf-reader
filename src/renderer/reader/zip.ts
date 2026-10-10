/**
 * 渲染层极简 ZIP 读取器：只解析中央目录 + 用 DecompressionStream('deflate-raw') 解压。
 * 不依赖主进程，因此浏览器形态也能读 EPUB。
 * 已知取舍：不支持 ZIP64 与加密条目（EPUB 规范禁止加密，无需处理）。
 */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export interface ZipEntry {
  /** 条目名（正斜杠分隔，UTF-8 或 CP437 还原） */
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  /** 本地文件头偏移 */
  offset: number;
  /** 是否为目录 */
  dir: boolean;
}

/** 极简 ZIP 读取器（一次性把整包读进内存） */
export class Unzip {
  private readonly bytes: Uint8Array;
  readonly entries: ZipEntry[];
  private readonly byName: Map<string, ZipEntry>;
  private readonly cache = new Map<string, Uint8Array>();

  private constructor(bytes: Uint8Array, entries: ZipEntry[]) {
    this.bytes = bytes;
    this.entries = entries;
    this.byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  }

  static async fromBlob(blob: Blob): Promise<Unzip> {
    const buffer = await blob.arrayBuffer();
    return Unzip.fromBytes(new Uint8Array(buffer));
  }

  static async fromUrl(url: string): Promise<Unzip> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`读取文件失败（HTTP ${res.status}）`);
    return Unzip.fromBlob(await res.blob());
  }

  static fromBytes(bytes: Uint8Array): Unzip {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEocd(view);
    if (eocd < 0) throw new Error('不是有效的 ZIP/EPUB 文件（找不到中央目录）');

    let count = view.getUint16(eocd + 10, true);
    let cenOffset = view.getUint32(eocd + 16, true);
    let cenSize = view.getUint32(eocd + 12, true);

    // ZIP64：条目数或偏移溢出时走 EOCD64
    if (count === 0xffff || cenOffset === 0xffffffff) {
      const loc = findSignatureBackwards(view, EOCD64_LOCATOR_SIG, eocd);
      if (loc >= 0) {
        const rec = Number(view.getBigUint64(loc + 8, true));
        if (rec >= 0 && rec + 56 <= view.byteLength && view.getUint32(rec, true) === EOCD64_SIG) {
          count = Number(view.getBigUint64(rec + 32, true));
          cenSize = Number(view.getBigUint64(rec + 40, true));
          cenOffset = Number(view.getBigUint64(rec + 48, true));
        }
      }
    }

    const entries: ZipEntry[] = [];
    let ptr = cenOffset;
    const limit = Math.min(view.byteLength, cenOffset + Math.max(cenSize, 0) + 4096);
    for (let i = 0; i < count && ptr + 46 <= limit; i += 1) {
      if (view.getUint32(ptr, true) !== CEN_SIG) break;
      const flags = view.getUint16(ptr + 8, true);
      const method = view.getUint16(ptr + 10, true);
      const compressedSize = view.getUint32(ptr + 20, true);
      const size = view.getUint32(ptr + 24, true);
      const nameLen = view.getUint16(ptr + 28, true);
      const extraLen = view.getUint16(ptr + 30, true);
      const commentLen = view.getUint16(ptr + 32, true);
      const offset = view.getUint32(ptr + 42, true);
      const nameBytes = bytes.subarray(ptr + 46, ptr + 46 + nameLen);
      const utf8 = (flags & 0x800) !== 0;
      const name = decodeName(nameBytes, utf8) || `entry-${i}`;
      entries.push({ name, method, compressedSize, size, offset, dir: name.endsWith('/') });
      ptr += 46 + nameLen + extraLen + commentLen;
    }

    return new Unzip(bytes, entries);
  }

  has(name: string): boolean {
    return this.byName.has(name.replace(/^\.\//, '').toLowerCase());
  }

  /** 读取条目原始字节；找不到返回 null */
  async read(name: string): Promise<Uint8Array | null> {
    const key = name.replace(/^\.\//, '').toLowerCase();
    const cached = this.cache.get(key);
    if (cached) return cached;
    const entry = this.byName.get(key);
    if (!entry || entry.dir) return null;
    const data = await this.extract(entry);
    if (!data) return null;
    this.cache.set(key, data);
    return data;
  }

  /** 读取文本条目（UTF-8） */
  async readText(name: string): Promise<string | null> {
    const data = await this.read(name);
    if (!data) return null;
    return new TextDecoder('utf-8').decode(data);
  }

  private async extract(entry: ZipEntry): Promise<Uint8Array | null> {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const at = entry.offset;
    if (at + 30 > view.byteLength || view.getUint32(at, true) !== LOC_SIG) {
      // 少数文件中央目录偏移失效：按条目名回退扫描本地头
      const found = this.scanLocalHeader(entry.name);
      if (found === null) return null;
      return this.extractAt(found, entry);
    }
    return this.extractAt(at, entry);
  }

  private async extractAt(localOffset: number, entry: ZipEntry): Promise<Uint8Array | null> {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const nameLen = view.getUint16(localOffset + 26, true);
    const extraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + nameLen + extraLen;
    const end = Math.min(this.bytes.byteLength, start + entry.compressedSize);
    if (start >= this.bytes.byteLength) return null;
    const raw = this.bytes.subarray(start, end);
    if (entry.method === 0) return raw.slice();
    if (entry.method === 8) return inflateRaw(raw);
    throw new Error(`不支持的压缩方式（method=${entry.method}）`);
  }

  private scanLocalHeader(name: string): number | null {
    const needle = new TextEncoder().encode(name);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    for (let i = 0; i + 30 < this.bytes.byteLength; i += 1) {
      if (view.getUint32(i, true) !== LOC_SIG) continue;
      const nameLen = view.getUint16(i + 26, true);
      if (nameLen !== needle.length) continue;
      const slice = this.bytes.subarray(i + 30, i + 30 + nameLen);
      if (slice.every((b, idx) => b === needle[idx])) return i;
    }
    return null;
  }
}

/** deflate-raw 解压；不支持时抛错让上层给出友好提示 */
export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) throw new Error('当前运行环境不支持 DecompressionStream，无法解压 EPUB');
  try {
    const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DS('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    // 某些实现只认 'deflate'（带 zlib 头）：补一个头再试
    try {
      const header = new Uint8Array([0x78, 0x01]);
      const withHeader = new Uint8Array(header.length + data.length);
      withHeader.set(header, 0);
      withHeader.set(data, header.length);
      const stream = new Blob([withHeader as unknown as BlobPart]).stream().pipeThrough(new DS('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      throw new Error(`解压失败：${(err as Error).message}`);
    }
  }
}

function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 66_000);
  for (let i = view.byteLength - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

function findSignatureBackwards(view: DataView, sig: number, from: number): number {
  const min = Math.max(0, from - 4096);
  for (let i = from; i >= min; i -= 1) {
    if (view.getUint32(i, true) === sig) return i;
  }
  return -1;
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder('utf-8').decode(bytes);
  // 非 UTF-8 标记：EPUB 里绝大多数仍是 ASCII/UTF-8，先按 UTF-8 试，失败再退回 latin1
  const asUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!asUtf8.includes('\uFFFD')) return asUtf8;
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * 路径工具：Windows 超长路径、相对路径、安全判定。
 * 约定：所有对外暴露的路径都不带 \\?\ 前缀；仅在真正调用 fs 时加前缀。
 */
import path from 'node:path';

const isWin = process.platform === 'win32';

/** 给 Windows 超长路径加 \\?\ 前缀（幂等） */
export function longPath(p: string): string {
  if (!isWin) return p;
  if (p.startsWith('\\\\?\\')) return p;
  const abs = path.resolve(p);
  if (abs.length < 248) return abs;
  if (abs.startsWith('\\\\')) return `\\\\?\\UNC\\${abs.slice(2)}`;
  return `\\\\?\\${abs}`;
}

/** 去掉 \\?\ / \\?\UNC\ 前缀，便于展示与比较 */
export function plainPath(p: string): string {
  if (!isWin) return p;
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 判断 child 是否在 parent 之内（含相等） */
export function isInside(parent: string, child: string): boolean {
  const a = path.resolve(parent).toLowerCase();
  const b = path.resolve(child).toLowerCase();
  if (a === b) return true;
  return b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

export function extOf(name: string): string {
  const e = path.extname(name);
  return e ? e.slice(1).toLowerCase() : '';
}

export function baseNameNoExt(name: string): string {
  const e = path.extname(name);
  return e ? name.slice(0, -e.length) : name;
}

/**
 * 把绝对路径拆成根目录视角的相对信息。
 */
export function relativize(rootPath: string, absPath: string): { relPath: string; dir: string } {
  const rel = path.relative(rootPath, absPath);
  const dir = path.dirname(rel);
  return {
    relPath: toPosix(rel),
    dir: dir === '.' ? '' : toPosix(dir),
  };
}

export function uniqueName(existing: Set<string>, name: string): string {
  if (!existing.has(name)) return name;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let i = 2;
  while (existing.has(`${base} (${i})${ext}`)) i += 1;
  return `${base} (${i})${ext}`;
}

/** 人类可读体积 */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 生成短 id（ULID 风格：时间前缀 + 随机），无需依赖 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function shortId(prefix = ''): string {
  let time = Date.now();
  let ts = '';
  for (let i = 0; i < 10; i += 1) {
    ts = ALPHABET[time % 32] + ts;
    time = Math.floor(time / 32);
  }
  let rand = '';
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) rand += ALPHABET[b % 32];
  return `${prefix}${ts}${rand}`;
}

/** 延迟 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 把 async 任务按并发上限跑 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length || 1))).fill(0).map(async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

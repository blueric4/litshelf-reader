/**
 * src/core/fingerprint.ts —— 内容指纹（改名 / 移动识别的唯一依据）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fingerprintFile, isUnchanged } from '@core/fingerprint';
import { entryFor, pseudoRandomBytes, tempTracker, writeBytes, writeText } from './helpers';

const tmp = tempTracker();
afterEach(() => tmp.cleanup());

const CHUNK = 64 * 1024;
const BIG = 300 * 1024; // 300KB > 128KB，走"首 64KB + 尾 64KB"分支

describe('fingerprintFile：小文件（整文件哈希）', () => {
  it('同内容、不同文件名 → 指纹相同（改名识别的基础）', async () => {
    const dir = await tmp.make('fp-small');
    const a = await writeText(path.join(dir, 'a.pdf'), 'hello litshelf');
    const b = await writeText(path.join(dir, 'renamed-copy.pdf'), 'hello litshelf');
    const fa = await fingerprintFile(a);
    const fb = await fingerprintFile(b);
    expect(fa).not.toBeNull();
    expect(fb).not.toBeNull();
    expect(fa!.fingerprint).toBe(fb!.fingerprint);
    expect(fa!.whole).toBe(true);
    expect(fa!.size).toBe(14);
  });

  it('不同内容 → 指纹不同（哪怕大小一模一样）', async () => {
    const dir = await tmp.make('fp-diff');
    const a = await writeText(path.join(dir, 'a.txt'), 'AAAA');
    const b = await writeText(path.join(dir, 'b.txt'), 'BBBB');
    const fa = await fingerprintFile(a);
    const fb = await fingerprintFile(b);
    expect(fa!.size).toBe(fb!.size);
    expect(fa!.fingerprint).not.toBe(fb!.fingerprint);
  });

  it('空文件也有稳定指纹，且不会被当成目录', async () => {
    const dir = await tmp.make('fp-empty');
    const a = await writeText(path.join(dir, 'empty.txt'), '');
    const b = await writeText(path.join(dir, 'empty2.txt'), '');
    const fa = await fingerprintFile(a);
    const fb = await fingerprintFile(b);
    expect(fa!.size).toBe(0);
    expect(fa!.fingerprint).toBe(fb!.fingerprint);
    expect(fa!.fingerprint).toMatch(/^[0-9a-f]{40}$/);
  });

  it('目录 / 不存在的路径 → null（不抛异常）', async () => {
    const dir = await tmp.make('fp-null');
    expect(await fingerprintFile(dir)).toBeNull();
    expect(await fingerprintFile(path.join(dir, 'no-such-file.pdf'))).toBeNull();
  });
});

describe('fingerprintFile：大文件（首 64KB + 尾 64KB）', () => {
  it('>128KB 的同内容文件改名后指纹仍然相同', async () => {
    const dir = await tmp.make('fp-big');
    const bytes = pseudoRandomBytes(BIG, 7);
    const a = await writeBytes(path.join(dir, 'a.pdf'), bytes);
    const b = await writeBytes(path.join(dir, 'moved', 'b.pdf'), bytes);
    const fa = await fingerprintFile(a);
    const fb = await fingerprintFile(b);
    expect(fa!.whole).toBe(false);
    expect(fa!.size).toBe(BIG);
    expect(fa!.fingerprint).toBe(fb!.fingerprint);
  });

  it('尾部内容变化 → 指纹变化', async () => {
    const dir = await tmp.make('fp-tail');
    const bytes = pseudoRandomBytes(BIG, 11);
    const a = await writeBytes(path.join(dir, 'a.pdf'), bytes);
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] = changed[changed.length - 1] ^ 0xff;
    const b = await writeBytes(path.join(dir, 'b.pdf'), changed);
    const fa = await fingerprintFile(a);
    const fb = await fingerprintFile(b);
    expect(fa!.fingerprint).not.toBe(fb!.fingerprint);
  });

  it('头部内容变化 → 指纹变化', async () => {
    const dir = await tmp.make('fp-head');
    const bytes = pseudoRandomBytes(BIG, 13);
    const a = await writeBytes(path.join(dir, 'a.pdf'), bytes);
    const changed = Buffer.from(bytes);
    changed[10] = changed[10] ^ 0xff;
    const b = await writeBytes(path.join(dir, 'b.pdf'), changed);
    expect((await fingerprintFile(a))!.fingerprint).not.toBe((await fingerprintFile(b))!.fingerprint);
  });

  it('文件大小变化 → 指纹变化（大小参与哈希）', async () => {
    const dir = await tmp.make('fp-size');
    const a = await writeBytes(path.join(dir, 'a.pdf'), pseudoRandomBytes(BIG, 17));
    const b = await writeBytes(path.join(dir, 'b.pdf'), pseudoRandomBytes(BIG + 1, 17));
    expect((await fingerprintFile(a))!.fingerprint).not.toBe((await fingerprintFile(b))!.fingerprint);
  });

  // 已知局限：只有大小 + 首尾 64KB 参与哈希，中段差异检测不到。
  // 这不会造成数据丢失（改名判定还要求"旧路径已不存在"），但值得记在案。
  it('已知局限：仅中段字节不同的大文件指纹相同', async () => {
    const dir = await tmp.make('fp-middle');
    const bytes = pseudoRandomBytes(BIG, 19);
    const a = await writeBytes(path.join(dir, 'a.pdf'), bytes);
    const changed = Buffer.from(bytes);
    const middle = Math.floor(BIG / 2); // 落在首尾 64KB 之外
    changed[middle] = changed[middle] ^ 0xff;
    const b = await writeBytes(path.join(dir, 'b.pdf'), changed);
    const fa = await fingerprintFile(a);
    const fb = await fingerprintFile(b);
    expect(fa!.size).toBe(fb!.size);
    expect(fa!.fingerprint).toBe(fb!.fingerprint);
  });
});

describe('fingerprintFile：128KB 边界', () => {
  it('恰好 128KB 仍走整文件哈希，多 1 字节就走分块哈希', async () => {
    const dir = await tmp.make('fp-boundary');
    const exact = await writeBytes(path.join(dir, 'exact.bin'), pseudoRandomBytes(CHUNK * 2, 23));
    const over = await writeBytes(path.join(dir, 'over.bin'), pseudoRandomBytes(CHUNK * 2 + 1, 23));
    const fe = await fingerprintFile(exact);
    const fo = await fingerprintFile(over);
    expect(fe!.whole).toBe(true);
    expect(fe!.size).toBe(CHUNK * 2);
    expect(fo!.whole).toBe(false);
    expect(fo!.size).toBe(CHUNK * 2 + 1);
  });

  it('返回的 size / mtime 与磁盘一致（对账时用来判断"没变"）', async () => {
    const dir = await tmp.make('fp-stat');
    const p = await writeBytes(path.join(dir, 'a.bin'), pseudoRandomBytes(4096, 29));
    const stat = await fs.stat(p);
    const fp = await fingerprintFile(p);
    expect(fp!.size).toBe(stat.size);
    expect(fp!.mtime).toBeCloseTo(stat.mtimeMs, 3);
    // 与 helpers.entryFor 产出的 FsEntry 完全一致，避免对账时出现假"内容变了"
    const entry = await entryFor(dir, p);
    expect(entry.fingerprint).toBe(fp!.fingerprint);
    expect(entry.mtime).toBe(fp!.mtime);
    expect(entry.size).toBe(fp!.size);
  });
});

describe('isUnchanged：size + mtime 快速判定', () => {
  const base = { size: 1000, mtime: 1_700_000_000_000, fingerprint: 'abc' };

  it('大小相同且 mtime 相近 → true', () => {
    expect(isUnchanged(base, { size: 1000, mtime: 1_700_000_000_000 })).toBe(true);
    expect(isUnchanged(base, { size: 1000, mtime: 1_700_000_000_001 })).toBe(true);
  });

  it('大小变了 → false', () => {
    expect(isUnchanged(base, { size: 1001, mtime: base.mtime })).toBe(false);
  });

  it('mtime 差 >= 2ms → false', () => {
    expect(isUnchanged(base, { size: 1000, mtime: base.mtime + 2 })).toBe(false);
    expect(isUnchanged(base, { size: 1000, mtime: base.mtime - 50 })).toBe(false);
  });

  it('只看 size+mtime，不比对指纹（快速预判，语义如此）', () => {
    expect(isUnchanged(base, { size: 1000, mtime: base.mtime })).toBe(true);
  });
});

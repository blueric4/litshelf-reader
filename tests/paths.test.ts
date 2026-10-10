/**
 * src/core/paths.ts —— 路径 / 体积 / 并发工具（纯函数）。
 */
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  baseNameNoExt,
  extOf,
  humanSize,
  isInside,
  longPath,
  mapLimit,
  plainPath,
  relativize,
  shortId,
  toPosix,
  uniqueName,
} from '@core/paths';
import { sleep } from './helpers';

describe('relativize：根目录 → 相对路径', () => {
  const root = path.join(os.tmpdir(), 'litshelf-root');

  it('根目录本层：dir 为空串', () => {
    const { relPath, dir } = relativize(root, path.join(root, 'a.pdf'));
    expect(relPath).toBe('a.pdf');
    expect(dir).toBe('');
  });

  it('一层子目录', () => {
    const { relPath, dir } = relativize(root, path.join(root, 'sub', 'a.pdf'));
    expect(relPath).toBe('sub/a.pdf');
    expect(dir).toBe('sub');
  });

  it('深层子目录', () => {
    const { relPath, dir } = relativize(root, path.join(root, 'sub', 'deep', 'deeper', 'a.pdf'));
    expect(relPath).toBe('sub/deep/deeper/a.pdf');
    expect(dir).toBe('sub/deep/deeper');
  });

  it('Windows 反斜杠一律转成 posix 斜杠', () => {
    const { relPath, dir } = relativize(root, path.join(root, 'a b', 'c d', '论文.pdf'));
    expect(relPath).toBe('a b/c d/论文.pdf');
    expect(dir).toBe('a b/c d');
    expect(relPath.includes('\\')).toBe(false);
    expect(dir.includes('\\')).toBe(false);
  });

  it('根目录带尾分隔符也正确', () => {
    const { relPath, dir } = relativize(`${root}${path.sep}`, path.join(root, 'sub', 'a.pdf'));
    expect(relPath).toBe('sub/a.pdf');
    expect(dir).toBe('sub');
  });
});

describe('humanSize：边界', () => {
  it('0 / 1023 / 1024 三个关键点', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(1)).toBe('1 B');
    expect(humanSize(1023)).toBe('1023 B');
    expect(humanSize(1024)).toBe('1.0 KB');
    expect(humanSize(1536)).toBe('1.5 KB');
  });

  it('MB / GB / TB 进位', () => {
    expect(humanSize(1024 * 1024)).toBe('1.0 MB');
    expect(humanSize(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
    expect(humanSize(1024 ** 4)).toBe('1.0 TB');
  });

  it('>= 100 时取整，单位到 TB 封顶', () => {
    expect(humanSize(200 * 1024 * 1024)).toBe('200 MB');
    expect(humanSize(1024 ** 5)).toBe('1024 TB');
  });

  it('非法输入返回占位符', () => {
    expect(humanSize(-1)).toBe('—');
    expect(humanSize(Number.NaN)).toBe('—');
    expect(humanSize(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('longPath / plainPath', () => {
  it('短路径只做绝对化', () => {
    expect(longPath('a.pdf')).toBe(path.resolve('a.pdf'));
    expect(longPath(path.resolve('a.pdf'))).toBe(path.resolve('a.pdf'));
  });

  it('幂等：已经带前缀就不再叠加', () => {
    const already = '\\\\?\\C:\\some\\dir\\a.pdf';
    expect(longPath(already)).toBe(already);
    expect(plainPath(already)).toBe('C:\\some\\dir\\a.pdf');
  });

  it.skipIf(process.platform !== 'win32')('超过 248 字符的 Windows 路径加 \\\\?\\ 前缀', () => {
    const deep = path.join('C:\\', 'very-long-folder-name', ...Array(12).fill('0123456789012345678901234567890123456789'), 'a.pdf');
    expect(deep.length).toBeGreaterThan(248);
    const out = longPath(deep);
    expect(out.startsWith('\\\\?\\')).toBe(true);
    expect(plainPath(out)).toBe(path.resolve(deep));
  });

  it('plainPath 处理 UNC 形式', () => {
    expect(plainPath('\\\\?\\UNC\\server\\share\\a.pdf')).toBe('\\\\server\\share\\a.pdf');
  });

  it('toPosix 把反斜杠换成斜杠', () => {
    expect(toPosix('a\\b\\c.pdf')).toBe('a/b/c.pdf');
    expect(toPosix('a/b')).toBe('a/b');
  });
});

describe('扩展名与包含判断', () => {
  it('extOf 取小写扩展名（不带点）', () => {
    expect(extOf('Paper.PDF')).toBe('pdf');
    expect(extOf('a.tar.gz')).toBe('gz');
    expect(extOf('README')).toBe('');
    expect(extOf('.gitignore')).toBe('');
  });

  it('baseNameNoExt 去掉扩展名', () => {
    expect(baseNameNoExt('Paper.pdf')).toBe('Paper');
    expect(baseNameNoExt('a b c.md')).toBe('a b c');
    expect(baseNameNoExt('README')).toBe('README');
  });

  it('isInside 判断包含关系', () => {
    const root = path.join(os.tmpdir(), 'lib');
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, path.join(root, 'sub', 'a.pdf'))).toBe(true);
    expect(isInside(root, path.join(os.tmpdir(), 'other', 'a.pdf'))).toBe(false);
    expect(isInside(root, path.join(os.tmpdir(), 'lib2', 'a.pdf'))).toBe(false);
  });

  it('uniqueName 遇到重名自动加序号', () => {
    expect(uniqueName(new Set(), 'a.pdf')).toBe('a.pdf');
    const existing = new Set(['a.pdf', 'a (2).pdf']);
    expect(uniqueName(existing, 'a.pdf')).toBe('a (3).pdf');
  });
});

describe('mapLimit：并发上限 + 结果顺序', () => {
  it('峰值并发 <= limit，且结果顺序与输入一致', async () => {
    const limit = 4;
    let active = 0;
    let peak = 0;
    let started = 0;
    const items = Array.from({ length: 24 }, (_, i) => i);

    const out = await mapLimit(items, limit, async (n, index) => {
      expect(index).toBe(n);
      started += 1;
      active += 1;
      peak = Math.max(peak, active);
      await sleep(5);
      active -= 1;
      return `r${n}`;
    });

    expect(started).toBe(items.length);
    expect(peak).toBeLessThanOrEqual(limit);
    expect(peak).toBeGreaterThan(1); // 确实并行，不是退化成一个一个跑
    expect(out).toEqual(items.map((n) => `r${n}`));
    expect(active).toBe(0);
  });

  it('limit 大于任务数时全部并行且不越界', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3], 10, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(5);
      active -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('空数组直接返回空数组，不调用回调', async () => {
    let called = 0;
    const out = await mapLimit([], 4, async () => {
      called += 1;
      return 1;
    });
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });

  it('limit <= 0 时退化为串行而不是死锁', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4], 0, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(2);
      active -= 1;
      return n;
    });
    expect(out).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(1);
  });

  it('任务抛错时整体 reject（由调用方决定降级）', async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});

describe('shortId', () => {
  it('带前缀、足够唯一、字符集固定', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i += 1) ids.add(shortId('it_'));
    expect(ids.size).toBe(500);
    for (const id of ids) {
      expect(id.startsWith('it_')).toBe(true);
      expect(id).toMatch(/^it_[0-9A-HJKMNP-TV-Z]{22}$/);
    }
  });

  it('无前缀也能用', () => {
    expect(shortId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{22}$/);
  });

  it('同一毫秒内不重复（随机后缀起作用）', () => {
    const a = shortId('x_');
    const b = shortId('x_');
    expect(a).not.toBe(b);
  });
});

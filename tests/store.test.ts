/**
 * src/core/store.ts —— 原子写 / .bak 回滚 / 损坏留档 / 追加式日志。
 */
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Journal, JsonFile, writeFileAtomic } from '@core/store';
import { exists, listFiles, readText, tempTracker, waitFor, writeText } from './helpers';

const tmp = tempTracker();
afterEach(() => tmp.cleanup());

interface Shape {
  n: number;
  list: string[];
}

function reviveShape(raw: unknown): Shape | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Partial<Shape>;
  if (typeof data.n !== 'number' || !Array.isArray(data.list)) return null;
  return { n: data.n, list: data.list.map(String) };
}

function makeJsonFile(file: string) {
  return new JsonFile<Shape>({
    file,
    defaults: () => ({ n: 0, list: [] }),
    revive: reviveShape,
    debounceMs: 5,
  });
}

describe('writeFileAtomic', () => {
  it('写入内容正确，且不残留临时文件', async () => {
    const dir = await tmp.make('atomic');
    const file = path.join(dir, 'nested', 'data.json');
    await writeFileAtomic(file, '{"ok":true}');
    expect(await readText(file)).toBe('{"ok":true}');
    expect(await listFiles(dir)).toEqual(['nested/data.json']);
  });

  it('覆盖写：旧内容进 .bak，新内容进主文件', async () => {
    const dir = await tmp.make('atomic-bak');
    const file = path.join(dir, 'data.json');
    await writeFileAtomic(file, 'v1');
    await writeFileAtomic(file, 'v2');
    expect(await readText(file)).toBe('v2');
    expect(await readText(`${file}.bak`)).toBe('v1');
    expect(await listFiles(dir)).toEqual(['data.json', 'data.json.bak']);
  });
});

describe('JsonFile：正常读写', () => {
  it('文件不存在时用 defaults，且不算"损坏回滚"', async () => {
    const dir = await tmp.make('jf-default');
    const jf = makeJsonFile(path.join(dir, 'library.json'));
    const value = await jf.load();
    expect(value).toEqual({ n: 0, list: [] });
    expect(jf.recovered).toBe(false);
    expect(jf.isLoaded()).toBe(true);
  });

  it('set + flushNow 之后磁盘内容与内存一致', async () => {
    const dir = await tmp.make('jf-write');
    const file = path.join(dir, 'library.json');
    const jf = makeJsonFile(file);
    jf.set({ n: 3, list: ['a', 'b'] });
    expect(jf.get()).toEqual({ n: 3, list: ['a', 'b'] });
    await jf.flushNow();
    expect(JSON.parse(await readText(file))).toEqual({ n: 3, list: ['a', 'b'] });
    expect(await listFiles(dir)).toEqual(['library.json']);
  });

  it('mutate 就地改并落盘', async () => {
    const dir = await tmp.make('jf-mutate');
    const file = path.join(dir, 'library.json');
    const jf = makeJsonFile(file);
    jf.mutate((d) => {
      d.n = 9;
      d.list.push('x');
    });
    await jf.flushNow();
    expect(JSON.parse(await readText(file))).toEqual({ n: 9, list: ['x'] });
  });

  it('重新加载（重启场景）读回同一份数据', async () => {
    const dir = await tmp.make('jf-reload');
    const file = path.join(dir, 'library.json');
    const jf = makeJsonFile(file);
    jf.set({ n: 42, list: ['keep'] });
    await jf.flushNow();

    const reopened = makeJsonFile(file);
    expect(await reopened.load()).toEqual({ n: 42, list: ['keep'] });
    expect(reopened.recovered).toBe(false);
  });

  it('非对象 / 校验失败的 JSON 交给 defaults（revive 返回 null）', async () => {
    const dir = await tmp.make('jf-invalid-shape');
    const file = path.join(dir, 'library.json');
    await writeText(file, '{"n":"not-a-number"}');
    const jf = makeJsonFile(file);
    expect(await jf.load()).toEqual({ n: 0, list: [] });
    expect(jf.recovered).toBe(false);
  });

  it('空文件按"没有数据"处理，直接用 defaults', async () => {
    const dir = await tmp.make('jf-blank');
    const file = path.join(dir, 'library.json');
    await writeText(file, '   \n');
    const jf = makeJsonFile(file);
    expect(await jf.load()).toEqual({ n: 0, list: [] });
    expect(jf.recovered).toBe(false);
  });

  it('没有 revive 时，合法 JSON 对象直接采用', async () => {
    const dir = await tmp.make('jf-no-revive');
    const file = path.join(dir, 'raw.json');
    await writeText(file, '{"n":7,"list":["z"]}');
    const jf = new JsonFile<Shape>({ file, defaults: () => ({ n: 0, list: [] }), debounceMs: 5 });
    expect(await jf.load()).toEqual({ n: 7, list: ['z'] });
  });
});

describe('JsonFile：损坏恢复', () => {
  it('主文件是非法 JSON 时从 .bak 回滚，recovered=true，损坏文件被改名留档', async () => {
    const dir = await tmp.make('jf-corrupt');
    const file = path.join(dir, 'library.json');

    // 第一次写没有旧文件 → 不产生 .bak
    const jf = makeJsonFile(file);
    jf.set({ n: 1, list: ['first'] });
    await jf.flushNow();
    expect(await exists(`${file}.bak`)).toBe(false);

    // 第二次写：上一份内容进 .bak
    jf.set({ n: 2, list: ['first', 'second'] });
    await jf.flushNow();
    expect(JSON.parse(await readText(file))).toEqual({ n: 2, list: ['first', 'second'] });
    expect(JSON.parse(await readText(`${file}.bak`))).toEqual({ n: 1, list: ['first'] });

    // 模拟崩溃写坏主文件
    const broken = '{ "n": 2, "list": [ "first"';
    await writeText(file, broken);

    const restarted = makeJsonFile(file);
    const value = await restarted.load();
    expect(restarted.recovered).toBe(true);
    expect(value).toEqual({ n: 1, list: ['first'] });

    // 损坏文件必须留档，不能被静默删除
    const files = await listFiles(dir);
    const archived = files.filter((f) => /^library\.json\.corrupt-\d+$/.test(f));
    expect(archived).toHaveLength(1);
    expect(await readText(path.join(dir, archived[0]))).toBe(broken);
  });

  it('没有 .bak 可回滚时退回 defaults，损坏文件原样保留', async () => {
    const dir = await tmp.make('jf-corrupt-nobak');
    const file = path.join(dir, 'library.json');
    const broken = 'not json at all';
    await writeText(file, broken);

    const jf = makeJsonFile(file);
    expect(await jf.load()).toEqual({ n: 0, list: [] });
    expect(jf.recovered).toBe(false);
    expect(await readText(file)).toBe(broken);
    expect(await listFiles(dir)).toEqual(['library.json']);
  });

  it('.bak 也是坏的 → 退回 defaults，不抛异常', async () => {
    const dir = await tmp.make('jf-both-corrupt');
    const file = path.join(dir, 'library.json');
    await writeText(file, 'garbage-1');
    await writeText(`${file}.bak`, 'garbage-2');
    const jf = makeJsonFile(file);
    expect(await jf.load()).toEqual({ n: 0, list: [] });
  });
});

describe('Journal：追加式日志', () => {
  it('append 之后能以 tailSync 读回，字段完整', async () => {
    const dir = await tmp.make('journal');
    const file = path.join(dir, 'journal.log');
    const j = new Journal(file, 200);

    j.append('scan:root', { files: 3 });
    await waitFor(() => j.tailSync(10).length === 1, 4000, 10, '日志落盘');

    const [entry] = j.tailSync(10);
    expect(entry.action).toBe('scan:root');
    expect(entry.detail).toEqual({ files: 3 });
    expect(typeof entry.at).toBe('number');
    expect(j.tailSync(10)).toHaveLength(1);
  });

  it('连续 append 的条目一条都不能卡在内存里（回归）', async () => {
    const dir = await tmp.make('journal-burst');
    const file = path.join(dir, 'journal.log');
    const j = new Journal(file, 200);

    j.append('a');
    j.append('b');
    j.append('c');
    await waitFor(() => j.tailSync(50).length === 3, 4000, 10, '3 条日志落盘');

    expect(j.tailSync(50).map((e) => e.action)).toEqual(['a', 'b', 'c']);
  });

  it('文件不存在时 tailSync 返回空数组', async () => {
    const dir = await tmp.make('journal-missing');
    const j = new Journal(path.join(dir, 'nope.log'));
    expect(j.tailSync()).toEqual([]);
  });

  it('坏行不抛异常，标成 unparsable', async () => {
    const dir = await tmp.make('journal-bad');
    const file = path.join(dir, 'journal.log');
    await writeText(file, '{"at":1,"action":"ok"}\nnot json\n');
    const j = new Journal(file);
    const tail = j.tailSync(10);
    expect(tail).toHaveLength(2);
    expect(tail[0].action).toBe('ok');
    expect(tail[1].action).toBe('unparsable');
  });

  it('超过 512KB 时按 maxEntries 截断', async () => {
    const dir = await tmp.make('journal-trim');
    const file = path.join(dir, 'journal.log');
    const max = 5;
    const old = Array.from({ length: 6000 }, (_, i) =>
      JSON.stringify({ at: i, action: `old-entry-${i}`, detail: 'x'.repeat(80) }),
    );
    await writeText(file, `${old.join('\n')}\n`);
    expect((await readText(file)).length).toBeGreaterThan(512 * 1024);

    const j = new Journal(file, max);
    j.append('fresh');
    await waitFor(() => j.tailSync(100).length === max, 5000, 20, '日志被截断到 maxEntries');

    const tail = j.tailSync(100);
    expect(tail).toHaveLength(max);
    expect(tail[tail.length - 1].action).toBe('fresh');
  });
});

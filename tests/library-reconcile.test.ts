/**
 * src/core/library.ts —— 文件系统对账状态机（本软件的核心，最容易写错的地方）。
 *
 * 覆盖：改名/移动识别、复制粘贴不误判、删除→missing→复活、同路径覆盖、
 *       单文件事件、rebindItem、手改字段保护、撤销删除、跨根目录移动。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Library } from '@core/library';
import { entriesFor, entryFor, openLibrary, sleep, tempTracker, writeText } from './helpers';

const tmp = tempTracker();
const libs: Library[] = [];

afterEach(async () => {
  // 先把防抖落盘刷干净，再删临时目录，避免清理之后又冒出一个写盘任务
  for (const lib of libs.splice(0)) {
    await lib.flush().catch(() => undefined);
  }
  await tmp.cleanup();
});

async function newLib(dataDir: string): Promise<Library> {
  const lib = await openLibrary(dataDir);
  libs.push(lib);
  return lib;
}

/** 建一个工作区：docs/ 作为文献根目录，data/ 放库文件 */
async function workspace(label: string) {
  const base = await tmp.make(label);
  const libDir = path.join(base, 'docs');
  const dataDir = path.join(base, 'data');
  await fs.mkdir(libDir, { recursive: true });
  const lib = await newLib(dataDir);
  const root = lib.addRoot(libDir);
  return { base, libDir, dataDir, lib, root };
}

// ---------------------------------------------------------------------------
// 1. 改名 / 移动识别
// ---------------------------------------------------------------------------

describe('改名 / 移动识别', () => {
  it('同一份内容改名并换目录：id 不变、path 更新、用户数据与手改标题全部保留', async () => {
    const { lib, libDir, root } = await workspace('rename');
    const from = await writeText(path.join(libDir, 'old-name.pdf'), 'PDF-CONTENT-ONE');

    const first = lib.reconcileRoot(root.id, await entriesFor(libDir, [from]));
    expect(first.added).toHaveLength(1);
    const id = first.added[0].id;

    // 造一堆用户数据 + 手改标题
    lib.patchItem(id, {
      tags: ['待精读', '深度学习'],
      starred: true,
      note: '我的阅读笔记',
      annotationCount: 3,
      colorTag: 'red',
      readState: 'reading',
      progress: { page: 7, total: 20, percent: 35, scrollTop: 0.5, zoom: 1.25, updatedAt: 1 },
    });
    lib.editItem(id, { title: '我手改过的标题' }, ['title']);

    // 改名 + 移到子目录
    const to = path.join(libDir, 'sub', 'Author - 2020 - A Brand New Name.pdf');
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);

    const res = lib.reconcileRoot(root.id, await entriesFor(libDir, [to]));
    expect(res.renamed).toHaveLength(1);
    expect(res.added).toHaveLength(0);
    expect(res.updated).toHaveLength(0);
    expect(res.missing).toHaveLength(0);
    expect(res.renamed[0].from).toBe(path.resolve(from));

    const after = lib.get(id);
    expect(after).not.toBeNull();
    expect(after!.id).toBe(id); // ← 关键：id 不能变，否则批注全丢
    expect(after!.path).toBe(path.resolve(to));
    expect(after!.relPath).toBe('sub/Author - 2020 - A Brand New Name.pdf');
    expect(after!.dir).toBe('sub');
    expect(after!.name).toBe('Author - 2020 - A Brand New Name.pdf');
    expect(after!.ext).toBe('pdf');
    expect(after!.kind).toBe('pdf');

    // 用户数据
    expect(after!.tags).toEqual(['待精读', '深度学习']);
    expect(after!.starred).toBe(true);
    expect(after!.note).toBe('我的阅读笔记');
    expect(after!.annotationCount).toBe(3);
    expect(after!.colorTag).toBe('red');
    expect(after!.readState).toBe('reading');
    expect(after!.progress.page).toBe(7);
    expect(after!.progress.total).toBe(20);
    expect(after!.progress.zoom).toBe(1.25);

    // 手改过的 title 必须赢过文件名解析
    expect(after!.userEdited).toContain('title');
    expect(after!.title).toBe('我手改过的标题');

    // 索引一致：只有一个条目，旧路径不再指向任何东西
    expect(lib.size()).toBe(1);
    expect(lib.getByPath(to)!.id).toBe(id);
    expect(lib.getByPath(from)).toBeNull();
  });

  it('没被手改过的 title 会跟着新文件名走', async () => {
    const { lib, libDir, root } = await workspace('rename-title');
    const from = await writeText(path.join(libDir, 'old.pdf'), 'CONTENT');
    const { item } = lib.reconcileEntry(root.id, await entryFor(libDir, from));
    expect(item.title).toBe('old');

    const to = path.join(libDir, 'Smith - 2021 - Attention Is All You Need.pdf');
    await fs.rename(from, to);
    const res = lib.reconcileRoot(root.id, await entriesFor(libDir, [to]));

    expect(res.renamed).toHaveLength(1);
    expect(lib.get(item.id)!.title).toBe('Attention Is All You Need');
  });

  it('同名文件原地不动 → unchanged，不该被当成改名', async () => {
    const { lib, libDir, root } = await workspace('rename-same');
    const p = await writeText(path.join(libDir, 'stay.pdf'), 'CONTENT');
    const { item } = lib.reconcileEntry(root.id, await entryFor(libDir, p));

    const res = lib.reconcileRoot(root.id, await entriesFor(libDir, [p]));
    expect(res.renamed).toHaveLength(0);
    expect(res.added).toHaveLength(0);
    expect(res.updated).toHaveLength(0);
    expect(lib.size()).toBe(1);
    expect(lib.getByPath(p)!.id).toBe(item.id);
  });
});

// ---------------------------------------------------------------------------
// 2. 复制粘贴不能误判成改名
// ---------------------------------------------------------------------------

describe('复制粘贴：两个路径同时存在', () => {
  it('同内容复制一份 → 必须是新增，不能当成改名', async () => {
    const { lib, libDir, root } = await workspace('copy');
    const original = await writeText(path.join(libDir, 'original.pdf'), 'SAME-CONTENT');
    const r1 = lib.reconcileRoot(root.id, await entriesFor(libDir, [original]));
    const idA = r1.added[0].id;
    lib.patchItem(idA, { tags: ['keep-me'], starred: true, note: 'n1' });

    const copy = path.join(libDir, 'copy-of-original.pdf');
    await fs.copyFile(original, copy);

    const r2 = lib.reconcileRoot(root.id, await entriesFor(libDir, [original, copy]));
    expect(r2.renamed).toHaveLength(0); // ← 最容易被写错的一条
    expect(r2.added).toHaveLength(1);
    expect(r2.added[0].path).toBe(path.resolve(copy));
    expect(r2.missing).toHaveLength(0);
    expect(lib.size()).toBe(2);

    const a = lib.getByPath(original)!;
    const b = lib.getByPath(copy)!;
    expect(a.id).toBe(idA);
    expect(b.id).not.toBe(idA);
    expect(a.tags).toEqual(['keep-me']); // 用户数据不会串到副本上
    expect(b.tags).toEqual([]);
    expect(b.starred).toBe(false);
    expect(b.note).toBe('');

    // 再对账一次：两者稳定共存，不会互相抢身份
    const r3 = lib.reconcileRoot(root.id, await entriesFor(libDir, [original, copy]));
    expect(r3.added).toHaveLength(0);
    expect(r3.renamed).toHaveLength(0);
    expect(r3.missing).toHaveLength(0);
    expect(lib.size()).toBe(2);
    expect(lib.getByPath(original)!.id).toBe(idA);
  });

  it('扫描顺序反过来（先看到副本）也不能误判', async () => {
    const { lib, libDir, root } = await workspace('copy-reverse');
    const original = await writeText(path.join(libDir, 'aaa.pdf'), 'SAME-CONTENT');
    lib.reconcileRoot(root.id, await entriesFor(libDir, [original]));
    const copy = path.join(libDir, 'zzz.pdf');
    await fs.copyFile(original, copy);

    const res = lib.reconcileRoot(root.id, await entriesFor(libDir, [copy, original]));
    expect(res.renamed).toHaveLength(0);
    expect(res.added).toHaveLength(1);
    expect(lib.size()).toBe(2);
  });

  it('一次扫描里两个新文件内容相同（原文件在外）→ 两条新增', async () => {
    const { lib, libDir, root } = await workspace('copy-two-new');
    const a = await writeText(path.join(libDir, 'a.pdf'), 'TWINS');
    const b = await writeText(path.join(libDir, 'b.pdf'), 'TWINS');

    const res = lib.reconcileRoot(root.id, await entriesFor(libDir, [a, b]));
    expect(res.added).toHaveLength(2);
    expect(res.renamed).toHaveLength(0);
    expect(lib.size()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. 删除 → missing → 复活
// ---------------------------------------------------------------------------

describe('删除与复活', () => {
  it('文件消失 → missing=true 但条目仍在；重复对账不重复标记', async () => {
    const { lib, libDir, root } = await workspace('missing');
    const p = await writeText(path.join(libDir, 'gone.pdf'), 'BYE');
    const r1 = lib.reconcileRoot(root.id, await entriesFor(libDir, [p]));
    const id = r1.added[0].id;
    lib.patchItem(id, { tags: ['t'], readState: 'read' });

    await fs.rm(p);
    const r2 = lib.reconcileRoot(root.id, []);
    expect(r2.missing).toHaveLength(1);
    expect(r2.missing[0].id).toBe(id);

    const item = lib.get(id);
    expect(item).not.toBeNull(); // ← 条目绝不删除
    expect(item!.missing).toBe(true);
    expect(item!.missingSince).toBeGreaterThan(0);
    expect(item!.tags).toEqual(['t']);
    expect(item!.readState).toBe('read');
    expect(lib.size()).toBe(1);

    const r3 = lib.reconcileRoot(root.id, []);
    expect(r3.missing).toHaveLength(0); // 已经 missing 的不再重复报
    expect(lib.get(id)!.missing).toBe(true);
  });

  it('文件放回后复活：missing=false，id 与用户数据不变，且不算新增', async () => {
    const { lib, libDir, root } = await workspace('revive');
    const p = await writeText(path.join(libDir, 'back.pdf'), 'BACK-AGAIN');
    const r1 = lib.reconcileRoot(root.id, await entriesFor(libDir, [p]));
    const id = r1.added[0].id;
    lib.patchItem(id, { tags: ['t'], starred: true });

    await fs.rm(p);
    expect(lib.reconcileRoot(root.id, []).missing).toHaveLength(1);
    expect(lib.get(id)!.missing).toBe(true);

    await writeText(p, 'BACK-AGAIN');
    const r2 = lib.reconcileRoot(root.id, await entriesFor(libDir, [p]));
    const item = lib.get(id)!;
    expect(item.missing).toBe(false);
    expect(item.missingSince).toBeNull();
    expect(item.tags).toEqual(['t']);
    expect(item.starred).toBe(true);
    expect(r2.added).toHaveLength(0);
    expect(lib.size()).toBe(1);
    expect(lib.getByPath(p)!.id).toBe(id);
  });

  it('markMissingByPath 后原样对账 → revived（内容未变的纯复活路径）', async () => {
    const { lib, libDir, root } = await workspace('revive-mark');
    const p = await writeText(path.join(libDir, 'x.pdf'), 'CONTENT');
    const entry = await entryFor(libDir, p);
    const { item } = lib.reconcileEntry(root.id, entry);

    const marked = lib.markMissingByPath(p);
    expect(marked).not.toBeNull();
    expect(marked!.id).toBe(item.id);
    expect(marked!.missing).toBe(true);
    expect(lib.markMissingByPath(p)).toBeNull(); // 已 missing，不再重复处理

    const res = lib.reconcileRoot(root.id, [entry]);
    expect(res.revived.map((i) => i.id)).toEqual([item.id]);
    expect(res.added).toHaveLength(0);
    expect(lib.get(item.id)!.missing).toBe(false);
    expect(lib.get(item.id)!.missingSince).toBeNull();
  });

  it('文件被删后又以同内容出现在别处 → 老条目复活，不产生第二条', async () => {
    const { lib, libDir, root } = await workspace('revive-moved');
    const p = await writeText(path.join(libDir, 'a.pdf'), 'MOVE-AWAY');
    const { item } = lib.reconcileEntry(root.id, await entryFor(libDir, p));
    lib.patchItem(item.id, { tags: ['keep'] });

    await fs.rm(p);
    lib.markMissingByPath(p);

    const q = path.join(libDir, 'sub', 'b.pdf');
    await writeText(q, 'MOVE-AWAY');
    const res = lib.reconcileEntry(root.id, await entryFor(libDir, q));

    expect(res.change).toBe('revived');
    expect(res.item.id).toBe(item.id);
    expect(res.item.tags).toEqual(['keep']);
    expect(lib.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. 同路径内容被覆盖
// ---------------------------------------------------------------------------

describe('同路径内容被覆盖', () => {
  it('revision 自增、parseState 回到 placeholder、用户数据全保留', async () => {
    const { lib, libDir, root } = await workspace('overwrite');
    const p = await writeText(path.join(libDir, 'paper.pdf'), 'VERSION-ONE');
    const r1 = lib.reconcileRoot(root.id, await entriesFor(libDir, [p]));
    const id = r1.added[0].id;
    expect(lib.get(id)!.revision).toBe(1);

    lib.patchItem(id, {
      tags: ['a'],
      starred: true,
      note: 'note',
      readState: 'read',
      progress: { page: 5, total: 9, percent: 55, scrollTop: 0.1, zoom: 1.5, updatedAt: 1 },
      parseState: 'ready',
      textIndexed: true,
      thumb: 'thumbs/x.jpg',
      annotationCount: 2,
      title: 'Stable Title',
      excerpt: '旧摘要',
    });

    await sleep(15);
    await writeText(p, 'VERSION-TWO-LONGER');
    const r2 = lib.reconcileRoot(root.id, await entriesFor(libDir, [p]));

    expect(r2.updated).toHaveLength(1);
    expect(r2.added).toHaveLength(0);
    expect(r2.renamed).toHaveLength(0);

    const item = lib.get(id)!;
    expect(item.revision).toBe(2);
    expect(item.parseState).toBe('placeholder'); // 内容变了要重新解析
    expect(item.textIndexed).toBe(false);
    expect(item.thumb).toBeNull();
    expect(item.missing).toBe(false);
    expect(item.size).toBe('VERSION-TWO-LONGER'.length);

    // 用户数据一个都不能丢
    expect(item.tags).toEqual(['a']);
    expect(item.starred).toBe(true);
    expect(item.note).toBe('note');
    expect(item.readState).toBe('read');
    expect(item.progress.page).toBe(5);
    expect(item.progress.zoom).toBe(1.5);
    expect(item.annotationCount).toBe(2);
    expect(item.title).toBe('Stable Title');
    expect(item.excerpt).toBe('旧摘要');

    // 内容没再变 → 不再自增
    const r3 = lib.reconcileRoot(root.id, await entriesFor(libDir, [p]));
    expect(r3.updated).toHaveLength(0);
    expect(r3.added).toHaveLength(0);
    expect(r3.missing).toHaveLength(0);
    expect(lib.get(id)!.revision).toBe(2);
  });

  it('reconcileEntry 覆盖保存同样回到 placeholder 并自增 revision', async () => {
    const { lib, libDir, root } = await workspace('overwrite-entry');
    const p = await writeText(path.join(libDir, 'p.pdf'), 'AAA');
    const first = lib.reconcileEntry(root.id, await entryFor(libDir, p));
    const rev0 = first.item.revision; // 返回的是库内的活对象，必须立刻取值
    lib.patchItem(first.item.id, { parseState: 'ready', tags: ['x'] });

    await sleep(15);
    await writeText(p, 'BBBB');
    const second = lib.reconcileEntry(root.id, await entryFor(libDir, p));

    expect(second.change).toBe('updated');
    expect(second.item.id).toBe(first.item.id);
    expect(second.item.revision).toBe(rev0 + 1);
    expect(second.item.parseState).toBe('placeholder');
    expect(second.item.tags).toEqual(['x']);
  });
});

// ---------------------------------------------------------------------------
// 5. reconcileEntry：单文件事件的四种结果
// ---------------------------------------------------------------------------

describe('reconcileEntry：单文件事件', () => {
  it('added → unchanged → renamed', async () => {
    const { lib, libDir, root } = await workspace('entry');
    const p = await writeText(path.join(libDir, 'a.pdf'), 'ENTRY-CONTENT');

    const added = lib.reconcileEntry(root.id, await entryFor(libDir, p));
    expect(added.change).toBe('added');
    expect(added.from).toBeUndefined();

    const unchanged = lib.reconcileEntry(root.id, await entryFor(libDir, p));
    expect(unchanged.change).toBe('unchanged');
    expect(unchanged.item.id).toBe(added.item.id);

    const q = path.join(libDir, 'renamed.pdf');
    await fs.rename(p, q);
    const renamed = lib.reconcileEntry(root.id, await entryFor(libDir, q));
    expect(renamed.change).toBe('renamed');
    expect(renamed.item.id).toBe(added.item.id);
    expect(renamed.from).toBe(path.resolve(p));
    expect(lib.size()).toBe(1);
  });

  it('文件仍在原路径时，同内容的新路径不会被当成改名（复制场景）', async () => {
    const { lib, libDir, root } = await workspace('entry-copy');
    const p = await writeText(path.join(libDir, 'a.pdf'), 'COPY-ME');
    const first = lib.reconcileEntry(root.id, await entryFor(libDir, p));

    const q = path.join(libDir, 'b.pdf');
    await fs.copyFile(p, q);
    const second = lib.reconcileEntry(root.id, await entryFor(libDir, q));

    expect(second.change).toBe('added');
    expect(second.item.id).not.toBe(first.item.id);
    expect(lib.size()).toBe(2);
  });

  it('对账不会碰别的根目录里的条目', async () => {
    const base = await tmp.make('entry-other-root');
    const dirA = path.join(base, 'A');
    const dirB = path.join(base, 'B');
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    const lib = await newLib(path.join(base, 'data'));
    const rA = lib.addRoot(dirA);
    const rB = lib.addRoot(dirB);

    const a = await writeText(path.join(dirA, 'a.pdf'), 'AAA');
    lib.reconcileEntry(rA.id, await entryFor(dirA, a));
    const b = await writeText(path.join(dirB, 'b.pdf'), 'BBB');
    lib.reconcileEntry(rB.id, await entryFor(dirB, b));

    const res = lib.reconcileRoot(rA.id, await entriesFor(dirA, [a]));
    expect(res.missing).toHaveLength(0);
    expect(lib.size()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. 跨根目录移动（条目的 rootId 必须跟着走）
// ---------------------------------------------------------------------------

describe('跨根目录移动', () => {
  it('从 A 根移到 B 根：id/用户数据保留、rootId 更新、不产生重复、不被误标 missing', async () => {
    const base = await tmp.make('cross-root');
    const dirA = path.join(base, 'A');
    const dirB = path.join(base, 'B');
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    const lib = await newLib(path.join(base, 'data'));
    const rA = lib.addRoot(dirA);
    const rB = lib.addRoot(dirB);

    const p = await writeText(path.join(dirA, 'paper.pdf'), 'MOVE-ACROSS-ROOTS');
    const { item } = lib.reconcileEntry(rA.id, await entryFor(dirA, p));
    lib.patchItem(item.id, { tags: ['keep'], starred: true, note: 'n' });

    const q = path.join(dirB, 'paper.pdf');
    await fs.rename(p, q);
    const moved = lib.reconcileEntry(rB.id, await entryFor(dirB, q));
    expect(moved.change).toBe('renamed');
    expect(moved.item.id).toBe(item.id);
    expect(lib.get(item.id)!.rootId).toBe(rB.id); // ← rootId 必须跟着走

    // A 根再扫：文件活得好好的，不能把它标成 missing
    const scanA = lib.reconcileRoot(rA.id, []);
    expect(scanA.missing).toHaveLength(0);
    // B 根再扫：不能又冒出一个新条目来（那会丢用户数据）
    const scanB = lib.reconcileRoot(rB.id, await entriesFor(dirB, [q]));
    expect(scanB.added).toHaveLength(0);
    expect(scanB.renamed).toHaveLength(0);
    expect(lib.size()).toBe(1);
    expect(lib.get(item.id)!.tags).toEqual(['keep']);
    expect(lib.get(item.id)!.starred).toBe(true);
    expect(lib.getByPath(q)!.id).toBe(item.id);
  });
});

// ---------------------------------------------------------------------------
// 7. rebindItem（手动重新定位缺失文件）
// ---------------------------------------------------------------------------

describe('rebindItem：手动重新定位', () => {
  it('指向新路径后：id 保留、用户数据保留、revision+1、回到 placeholder', async () => {
    const { lib, libDir, root } = await workspace('rebind');
    const p = await writeText(path.join(libDir, 'a.pdf'), 'REBIND-CONTENT');
    const { item } = lib.reconcileEntry(root.id, await entryFor(libDir, p));
    const rev0 = item.revision; // 活对象，先取值
    lib.patchItem(item.id, { tags: ['keep'], starred: true, parseState: 'ready', textIndexed: true });

    await fs.rm(p);
    expect(lib.markMissingByPath(p)!.missing).toBe(true);

    const moved = path.join(libDir, 'sub', 'b.pdf');
    await writeText(moved, 'REBIND-CONTENT');
    const next = await lib.rebindItem(item.id, moved);

    expect(next).not.toBeNull();
    expect(next!.id).toBe(item.id);
    expect(next!.path).toBe(path.resolve(moved));
    expect(next!.relPath).toBe('sub/b.pdf');
    expect(next!.dir).toBe('sub');
    expect(next!.missing).toBe(false);
    expect(next!.missingSince).toBeNull();
    expect(next!.revision).toBe(rev0 + 1);
    expect(next!.parseState).toBe('placeholder');
    expect(next!.textIndexed).toBe(false);
    expect(next!.tags).toEqual(['keep']);
    expect(next!.starred).toBe(true);
    expect(lib.getByPath(p)).toBeNull();
    expect(lib.getByPath(moved)!.id).toBe(item.id);
    expect(lib.size()).toBe(1);
  });

  it('指向不存在的文件 → null，条目保持原样', async () => {
    const { lib, libDir, root } = await workspace('rebind-bad');
    const p = await writeText(path.join(libDir, 'a.pdf'), 'X');
    const { item } = lib.reconcileEntry(root.id, await entryFor(libDir, p));

    expect(await lib.rebindItem(item.id, path.join(libDir, 'nope.pdf'))).toBeNull();
    expect(await lib.rebindItem('it_not_exist', p)).toBeNull();
    expect(lib.get(item.id)!.path).toBe(path.resolve(p));
  });
});

// ---------------------------------------------------------------------------
// 8. 用户手改字段保护
// ---------------------------------------------------------------------------

describe('editItem / applyMetadata：手改字段保护', () => {
  async function one(label: string) {
    const ws = await workspace(label);
    const p = await writeText(path.join(ws.libDir, 'x.pdf'), 'CONTENT');
    const { item } = ws.lib.reconcileEntry(ws.root.id, await entryFor(ws.libDir, p));
    return { ...ws, p, item };
  }

  it('editItem 记下 userEdited，之后 applyMetadata 不再覆盖该字段', async () => {
    const { lib, item } = await one('edit');
    lib.editItem(item.id, { title: '用户标题' }, ['title']);
    expect(lib.get(item.id)!.userEdited).toContain('title');
    expect(lib.get(item.id)!.title).toBe('用户标题');

    const res = lib.applyMetadata(item.id, { title: '扫描出来的标题', venue: 'Nature' });
    expect(res).not.toBeNull();
    expect(res!.applied).toEqual(['venue']);
    expect(lib.get(item.id)!.title).toBe('用户标题');
    expect(lib.get(item.id)!.venue).toBe('Nature');
  });

  it('userEdited 去重，且不会丢掉之前记过的字段', async () => {
    const { lib, item } = await one('edit-dedupe');
    lib.editItem(item.id, { title: 'T' }, ['title']);
    lib.editItem(item.id, { year: 2020 }, ['year', 'title']);
    expect(lib.get(item.id)!.userEdited).toEqual(['title', 'year']);
  });

  it('空字符串 / 空数组不会抹掉已有信息', async () => {
    const { lib, item } = await one('meta-empty');
    lib.patchItem(item.id, { venue: 'Nature', abstract: '有摘要', keywords: ['k'], tags: ['t'] });

    const res = lib.applyMetadata(item.id, { venue: '', abstract: '   ', keywords: [], tags: [] });
    expect(res!.applied).toEqual([]);
    const after = lib.get(item.id)!;
    expect(after.venue).toBe('Nature');
    expect(after.abstract).toBe('有摘要');
    expect(after.keywords).toEqual(['k']);
    expect(after.tags).toEqual(['t']);
  });

  it('原本为空的字段可以被填上；null / undefined 直接跳过', async () => {
    const { lib, item } = await one('meta-fill');
    const res = lib.applyMetadata(item.id, { venue: 'Science', year: null, doi: undefined, abstract: '新摘要' });
    expect(res!.applied).toEqual(['venue', 'abstract']);
    expect(lib.get(item.id)!.venue).toBe('Science');
    expect(lib.get(item.id)!.abstract).toBe('新摘要');
    expect(lib.get(item.id)!.year).toBe(item.year);
  });

  it('不存在的条目返回 null', async () => {
    const { lib } = await one('meta-missing');
    expect(lib.applyMetadata('it_nope', { venue: 'X' })).toBeNull();
    expect(lib.editItem('it_nope', { title: 'X' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. 删除 / 撤销删除
// ---------------------------------------------------------------------------

describe('deleteItem / restoreItem', () => {
  it('条目能原样放回：id、路径索引、指纹索引、用户数据都恢复', async () => {
    const { lib, libDir, root } = await workspace('restore');
    const p = await writeText(path.join(libDir, 'r.pdf'), 'RESTORE-ME');
    const { item } = lib.reconcileEntry(root.id, await entryFor(libDir, p));
    lib.patchItem(item.id, { tags: ['keep'], starred: true });
    const frozen = JSON.parse(JSON.stringify(lib.get(item.id)!)) as typeof item;

    lib.deleteItem(item.id);
    expect(lib.get(item.id)).toBeNull();
    expect(lib.getByPath(p)).toBeNull();
    expect(lib.size()).toBe(0);

    const restored = lib.restoreItem(frozen);
    expect(restored.id).toBe(frozen.id);
    expect(lib.get(frozen.id)).not.toBeNull();
    expect(lib.getByPath(p)!.id).toBe(frozen.id);
    expect(lib.get(frozen.id)!.tags).toEqual(['keep']);
    expect(lib.get(frozen.id)!.starred).toBe(true);

    // 恢复后立刻对账：应判为 unchanged，不能又新增一条
    const res = lib.reconcileEntry(root.id, await entryFor(libDir, p));
    expect(res.change).toBe('unchanged');
    expect(lib.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 10. 根目录管理
// ---------------------------------------------------------------------------

describe('根目录管理', () => {
  it('addRoot 幂等：同一路径重复添加返回同一个根', async () => {
    const base = await tmp.make('roots-idem');
    const dir = path.join(base, 'lib');
    await fs.mkdir(dir, { recursive: true });
    const lib = await newLib(path.join(base, 'data'));

    const a = lib.addRoot(dir);
    const b = lib.addRoot(path.resolve(dir));
    expect(b.id).toBe(a.id);
    expect(lib.getRoots()).toHaveLength(1);
    expect(a.name).toBe('lib');
    expect(a.enabled).toBe(true);
    expect(a.available).toBe(true);
  });

  it('rootForPath 取最长前缀匹配', async () => {
    const base = await tmp.make('roots-nested');
    const outer = path.join(base, 'outer');
    const inner = path.join(outer, 'inner');
    await fs.mkdir(inner, { recursive: true });
    const lib = await newLib(path.join(base, 'data'));
    const rOuter = lib.addRoot(outer);
    const rInner = lib.addRoot(inner);

    expect(lib.rootForPath(path.join(inner, 'a.pdf'))!.id).toBe(rInner.id);
    expect(lib.rootForPath(path.join(outer, 'a.pdf'))!.id).toBe(rOuter.id);
    expect(lib.rootForPath(outer)!.id).toBe(rOuter.id);
    expect(lib.rootForPath(path.join(base, 'outside.pdf'))).toBeNull();
  });

  it('removeRoot(forgetItems) 清掉该根下的条目；不带 forgetItems 时条目留下', async () => {
    const base = await tmp.make('roots-remove');
    const dirA = path.join(base, 'A');
    const dirB = path.join(base, 'B');
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    const lib = await newLib(path.join(base, 'data'));
    const rA = lib.addRoot(dirA);
    const rB = lib.addRoot(dirB);

    const a = await writeText(path.join(dirA, 'a.pdf'), 'A');
    lib.reconcileEntry(rA.id, await entryFor(dirA, a));
    const b = await writeText(path.join(dirB, 'b.pdf'), 'B');
    lib.reconcileEntry(rB.id, await entryFor(dirB, b));
    expect(lib.size()).toBe(2);

    lib.removeRoot(rB.id);
    expect(lib.getRoot(rB.id)).toBeNull();
    expect(lib.size()).toBe(2); // 默认保留条目（用户数据不能因为移除根就消失）

    const removed = lib.removeRoot(rA.id, { forgetItems: true });
    expect(removed).toHaveLength(1);
    expect(lib.size()).toBe(1);
    expect(lib.getByPath(a)).toBeNull();
  });

  it('setRootEnabled / markRootScanned / 未知 rootId 不影响条目', async () => {
    const { lib, root } = await workspace('roots-flags');
    lib.setRootEnabled(root.id, false);
    expect(lib.getRoot(root.id)!.enabled).toBe(false);
    lib.setRootAvailable(root.id, false);
    expect(lib.getRoot(root.id)!.available).toBe(false);
    lib.markRootScanned(root.id, 42);
    expect(lib.getRoot(root.id)!.itemCount).toBe(42);
    expect(lib.getRoot(root.id)!.lastScanAt).toBeGreaterThan(0);

    // 未知 rootId：对账返回空结果，不抛异常
    const res = lib.reconcileRoot('rt_nope', []);
    expect(res).toEqual({ added: [], updated: [], renamed: [], revived: [], missing: [] });
  });
});

// ---------------------------------------------------------------------------
// 11. 落盘 / 重新加载
// ---------------------------------------------------------------------------

describe('落盘与重新加载', () => {
  it('flush 后重启：条目与用户数据都还在，指纹索引也重建', async () => {
    const base = await tmp.make('persist');
    const libDir = path.join(base, 'docs');
    const dataDir = path.join(base, 'data');
    await fs.mkdir(libDir, { recursive: true });

    const lib = await newLib(dataDir);
    const root = lib.addRoot(libDir);
    const p = await writeText(path.join(libDir, 'keep.pdf'), 'PERSIST-ME');
    const { item } = lib.reconcileEntry(root.id, await entryFor(libDir, p));
    lib.patchItem(item.id, { tags: ['keep'], starred: true });
    await lib.flush();

    const reopened = await newLib(dataDir);
    expect(reopened.size()).toBe(1);
    expect(reopened.get(item.id)).not.toBeNull();
    expect(reopened.getByPath(p)!.id).toBe(item.id);
    expect(reopened.get(item.id)!.tags).toEqual(['keep']);
    expect(reopened.getRoots()).toHaveLength(1);

    // 重建的指纹索引仍能识别改名
    const q = path.join(libDir, 'renamed.pdf');
    await fs.rename(p, q);
    const res = reopened.reconcileRoot(root.id, await entriesFor(libDir, [q]));
    expect(res.renamed).toHaveLength(1);
    expect(res.renamed[0].item.id).toBe(item.id);
  });
});

// ---------------------------------------------------------------------------
// 12. 索引一致性（全量对账的稳定性）
// ---------------------------------------------------------------------------

describe('全量对账稳定性', () => {
  it('多文件混合场景：改名 + 覆盖 + 删除 + 新增，一次对账各自归位', async () => {
    const { lib, libDir, root } = await workspace('mixed');
    const renamed = await writeText(path.join(libDir, 'will-rename.pdf'), 'RENAME-CONTENT');
    const overwritten = await writeText(path.join(libDir, 'will-overwrite.pdf'), 'OLD-CONTENT');
    const deleted = await writeText(path.join(libDir, 'will-delete.pdf'), 'DELETE-CONTENT');
    const stable = await writeText(path.join(libDir, 'stable.pdf'), 'STABLE-CONTENT');

    const r1 = lib.reconcileRoot(root.id, await entriesFor(libDir, [renamed, overwritten, deleted, stable]));
    expect(r1.added).toHaveLength(4);
    const idOf = (p: string) => lib.getByPath(p)!.id;
    const renameId = idOf(renamed);
    const overwriteId = idOf(overwritten);
    const deleteId = idOf(deleted);
    const stableId = idOf(stable);

    // 依次制造四种变化
    const renamedTo = path.join(libDir, 'sub', 'renamed-now.pdf');
    await fs.mkdir(path.dirname(renamedTo), { recursive: true });
    await fs.rename(renamed, renamedTo);
    await sleep(15);
    await writeText(overwritten, 'NEW-CONTENT-DIFFERENT-LENGTH');
    await fs.rm(deleted);
    const fresh = await writeText(path.join(libDir, 'brand-new.pdf'), 'FRESH-CONTENT');

    const r2 = lib.reconcileRoot(root.id, await entriesFor(libDir, [renamedTo, overwritten, stable, fresh]));

    expect(r2.added.map((i) => i.path)).toEqual([path.resolve(fresh)]);
    expect(r2.updated.map((i) => i.id)).toEqual([overwriteId]);
    expect(r2.renamed.map((r) => r.item.id)).toEqual([renameId]);
    expect(r2.missing.map((i) => i.id)).toEqual([deleteId]);
    expect(r2.revived).toHaveLength(0);

    expect(lib.size()).toBe(5);
    expect(lib.get(renameId)!.path).toBe(path.resolve(renamedTo));
    expect(lib.get(overwriteId)!.revision).toBe(2);
    expect(lib.get(deleteId)!.missing).toBe(true);
    expect(lib.get(stableId)!.missing).toBe(false);
    expect(lib.get(stableId)!.path).toBe(path.resolve(stable));

    // 再对账一次：应该完全稳定（没有任何变化）
    const r3 = lib.reconcileRoot(root.id, await entriesFor(libDir, [renamedTo, overwritten, stable, fresh]));
    expect(r3.added).toHaveLength(0);
    expect(r3.updated).toHaveLength(0);
    expect(r3.renamed).toHaveLength(0);
    expect(r3.revived).toHaveLength(0);
    expect(r3.missing).toHaveLength(0);
    expect(lib.size()).toBe(5);
  });

  it('tags() 汇总去重并排序', async () => {
    const { lib, libDir, root } = await workspace('tags');
    const a = await writeText(path.join(libDir, 'a.pdf'), 'A');
    const b = await writeText(path.join(libDir, 'b.pdf'), 'B');
    const r = lib.reconcileRoot(root.id, await entriesFor(libDir, [a, b]));
    lib.patchItem(r.added[0].id, { tags: ['b', 'a'] });
    lib.patchItem(r.added[1].id, { tags: ['a', 'c'] });
    expect(lib.tags()).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(new Set(lib.tags()).size).toBe(lib.tags().length);
  });
});

/**
 * src/core/search.ts —— 查询语法解析 + 打分检索。
 */
import { describe, expect, it } from 'vitest';

import { itemMatchesFilters, parseQuery, searchItems } from '@core/search';
import type { Annotation, Item } from '@shared/types';
import { makeAnnotation, makeItem } from './helpers';

function ann(over: Partial<Annotation>): Annotation {
  return makeAnnotation(over);
}

describe('parseQuery：语法解析', () => {
  it('tag: / author: / is: 解析成过滤器', () => {
    expect(parseQuery('tag:待精读')).toEqual({
      terms: [],
      phrases: [],
      filters: [{ key: 'tag', value: '待精读' }],
      yearFrom: null,
      yearTo: null,
      empty: false,
    });
    expect(parseQuery('author:Zhang').filters).toEqual([{ key: 'author', value: 'Zhang' }]);
    expect(parseQuery('is:unread').filters).toEqual([{ key: 'is', value: 'unread' }]);
    expect(parseQuery('is:unread').empty).toBe(false);
  });

  it('year:2020..2024 解析成范围（不进 filters）', () => {
    const q = parseQuery('year:2020..2024');
    expect(q.yearFrom).toBe(2020);
    expect(q.yearTo).toBe(2024);
    expect(q.filters).toEqual([]);
    expect(q.empty).toBe(false);
  });

  it('year: 单年 / 半开区间都支持', () => {
    expect(parseQuery('year:2023')).toMatchObject({ yearFrom: 2023, yearTo: 2023 });
    expect(parseQuery('year:..2020')).toMatchObject({ yearFrom: null, yearTo: 2020 });
    expect(parseQuery('year:2020..')).toMatchObject({ yearFrom: 2020, yearTo: null });
  });

  it('带引号的短语单独成 phrases', () => {
    const q = parseQuery('"图 神经网络"');
    expect(q.phrases).toEqual(['图 神经网络']);
    expect(q.terms).toEqual([]);
    expect(q.empty).toBe(false);
  });

  it('单引号短语也认', () => {
    expect(parseQuery("'deep learning'").phrases).toEqual(['deep learning']);
  });

  it('混合查询：短语 + 词 + 过滤器 + 年份各就各位', () => {
    const q = parseQuery('tag:待精读 "graph neural" network author:Zhang year:2020..2024 is:unread');
    expect(q.phrases).toEqual(['graph neural']);
    expect(q.terms).toEqual(['network']);
    expect(q.yearFrom).toBe(2020);
    expect(q.yearTo).toBe(2024);
    expect(q.filters).toEqual([
      { key: 'tag', value: '待精读' },
      { key: 'author', value: 'Zhang' },
      { key: 'is', value: 'unread' },
    ]);
  });

  it('空查询 / 纯空白 → empty=true', () => {
    expect(parseQuery('').empty).toBe(true);
    expect(parseQuery('   ').empty).toBe(true);
    expect(parseQuery(undefined as unknown as string).empty).toBe(true);
    expect(parseQuery('').terms).toEqual([]);
  });

  it('未知 key 不丢内容：当成普通检索词', () => {
    const q = parseQuery('foo:bar');
    expect(q.filters).toEqual([]);
    expect(q.terms).toEqual(['foo:bar']);
    expect(q.empty).toBe(false);
  });
});

describe('parseQuery + itemMatchesFilters：过滤语义', () => {
  const item = makeItem({
    tags: ['待精读', '深度学习'],
    authors: ['张伟', 'John Smith'],
    year: 2022,
    readState: 'unread',
    starred: true,
    note: '我的笔记',
    annotationCount: 2,
    kind: 'pdf',
    ext: 'pdf',
    dir: 'sub/deep',
    relPath: 'sub/deep/a.pdf',
    missing: false,
  });

  const match = (query: string, target: Item = item, ctx = {}) => itemMatchesFilters(target, parseQuery(query), ctx);

  it('tag / author 是子串匹配（大小写不敏感）', () => {
    expect(match('tag:待精读')).toBe(true);
    expect(match('tag:精读')).toBe(true);
    expect(match('tag:不存在')).toBe(false);
    expect(match('author:张')).toBe(true);
    expect(match('author:smith')).toBe(true);
    expect(match('author:王')).toBe(false);
  });

  it('year 范围', () => {
    expect(match('year:2020..2024')).toBe(true);
    expect(match('year:2023..2024')).toBe(false);
    expect(match('year:2022')).toBe(true);
    expect(match('year:..2022')).toBe(true);
    expect(match('year:2023..')).toBe(false);
  });

  it('year 为空的条目会被年份过滤掉', () => {
    expect(match('year:2020..2024', makeItem({ year: null }))).toBe(false);
  });

  it('is: 各种标志', () => {
    expect(match('is:unread')).toBe(true);
    expect(match('is:read')).toBe(false);
    expect(match('is:starred')).toBe(true);
    expect(match('is:annotated')).toBe(true);
    expect(match('is:note')).toBe(true);
    expect(match('is:missing')).toBe(false);
    expect(match('is:pdf')).toBe(true);
    expect(match('is:markdown')).toBe(false);
    expect(match('is:nonsense')).toBe(false);
  });

  it('kind: / ext: / folder: / path: / doi: / note: 过滤', () => {
    expect(match('kind:pdf')).toBe(true);
    expect(match('kind:epub')).toBe(false);
    expect(match('ext:pdf')).toBe(true);
    expect(match('folder:deep')).toBe(true);
    expect(match('folder:nope')).toBe(false);
    expect(match('path:sub/deep')).toBe(true);
    expect(match('note:笔记')).toBe(true);
    expect(match('note:没有')).toBe(false);
    expect(match('doi:10.1/x', makeItem({ doi: '10.1/x' }))).toBe(true);
  });

  it('ann: 走上下文回调', () => {
    const withAnn = { annotations: () => [ann({ comment: '这里要重读', page: 3 })] };
    expect(match('ann:重读', item, withAnn)).toBe(true);
    expect(match('ann:重读', item, {})).toBe(false);
  });
});

describe('searchItems：打分与排序', () => {
  it('命中标题的得分高于命中摘要的', () => {
    const titleHit = makeItem({ id: 'title-hit', title: 'Graph Neural Networks', abstract: '' });
    const abstractHit = makeItem({
      id: 'abstract-hit',
      title: 'A Completely Different Paper',
      abstract: 'We discuss graph methods in this work',
    });
    const noHit = makeItem({ id: 'none', title: 'Quantum Chemistry', abstract: 'nothing relevant' });

    const res = searchItems([titleHit, abstractHit, noHit], 'graph', {});
    expect(res.map((r) => r.item.id)).toEqual(['title-hit', 'abstract-hit']);
    expect(res[0].score).toBeGreaterThan(res[1].score);
    expect(res[0].fields).toContain('标题');
    expect(res[1].fields).toContain('摘要');
  });

  it('不匹配的条目被过滤掉', () => {
    const hit = makeItem({ id: 'hit', title: 'Deep Learning' });
    const miss = makeItem({ id: 'miss', title: 'Quantum Chemistry' });
    const res = searchItems([hit, miss], 'deep learning', {});
    expect(res.map((r) => r.item.id)).toEqual(['hit']);
  });

  it('多个词是 AND 语义：缺一个就不算命中', () => {
    const both = makeItem({ id: 'both', title: 'Deep Learning for NLP' });
    const one = makeItem({ id: 'one', title: 'Deep Blue' });
    const res = searchItems([both, one], 'deep learning', {});
    expect(res.map((r) => r.item.id)).toEqual(['both']);
  });

  it('带引号短语按整串匹配', () => {
    const hit = makeItem({ id: 'hit', title: 'Graph Neural Networks' });
    const miss = makeItem({ id: 'miss', title: 'Neural Graph Networks' });
    const res = searchItems([hit, miss], '"neural networks"', {});
    expect(res.map((r) => r.item.id)).toEqual(['hit']);
  });

  it('过滤器与关键词同时生效', () => {
    const a = makeItem({ id: 'a', title: 'Graph Learning', tags: ['待精读'] });
    const b = makeItem({ id: 'b', title: 'Graph Learning', tags: ['已读'] });
    const res = searchItems([a, b], 'tag:待精读 graph', {});
    expect(res.map((r) => r.item.id)).toEqual(['a']);
  });

  it('is:unread 过滤掉已读条目，且已读条目本身降权', () => {
    const unread = makeItem({ id: 'unread', title: 'Same Title', readState: 'unread' });
    const read = makeItem({ id: 'read', title: 'Same Title', readState: 'read' });
    const all = searchItems([unread, read], 'same title', {});
    expect(all.map((r) => r.item.id)).toEqual(['unread', 'read']);
    expect(all[0].score).toBeGreaterThan(all[1].score);

    const onlyUnread = searchItems([unread, read], 'same title is:unread', {});
    expect(onlyUnread.map((r) => r.item.id)).toEqual(['unread']);
  });

  it('星标条目加分', () => {
    const starred = makeItem({ id: 'starred', title: 'Same Title', starred: true });
    const plain = makeItem({ id: 'plain', title: 'Same Title', starred: false });
    expect(searchItems([plain, starred], 'same title', {})[0].item.id).toBe('starred');
  });

  it('笔记命中带 snippet 上下文，字段名是"笔记"', () => {
    const withNote = makeItem({ id: 'n', title: 'Other', note: '我在笔记里写了 graph 相关的心得' });
    const res = searchItems([withNote], 'graph', {})[0];
    expect(res.fields).toContain('笔记');
    expect(res.contexts[0].snippet).toContain('graph');
  });

  it('批注命中带页码上下文', () => {
    const item = makeItem({ id: 'a', title: 'Other' });
    const ctx = { annotations: () => [ann({ itemId: 'a', page: 4, comment: '关于 graph 的想法' })] };
    const res = searchItems([item], 'graph', ctx)[0];
    expect(res.fields).toContain('批注');
    expect(res.contexts[0].page).toBe(4);
  });

  it('正文（全文索引）命中带页码，字段名形如"正文 P2"', () => {
    const item = makeItem({ id: 'a', title: 'Other' });
    const ctx = { text: () => ['第一页没什么', '第二页里出现了 graphs 这个词'] };
    const res = searchItems([item], 'graphs', ctx)[0];
    expect(res.fields.some((f) => f.startsWith('正文 P2'))).toBe(true);
    expect(res.contexts[0].page).toBe(2);
  });

  it('空查询返回全部条目（浏览模式），并受 limit 限制', () => {
    const items = Array.from({ length: 20 }, (_, i) => makeItem({ id: `i${i}`, title: `Paper ${i}` }));
    expect(searchItems(items, '', {})).toHaveLength(20);
    expect(searchItems(items, '', {}, 5)).toHaveLength(5);
    expect(searchItems(items, '   ', {}, 3)).toHaveLength(3);
  });

  it('得分相同时按"最近添加"排序', () => {
    const older = makeItem({ id: 'older', title: 'Same Title', addedAt: 1000 });
    const newer = makeItem({ id: 'newer', title: 'Same Title', addedAt: 2000 });
    expect(searchItems([older, newer], 'same title', {}).map((r) => r.item.id)).toEqual(['newer', 'older']);
  });
});

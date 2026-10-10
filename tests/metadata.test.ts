/**
 * src/core/metadata.ts —— 只测纯函数与"离线不联网"的契约（绝不发真实网络请求）。
 */
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MetadataClient, extractArxivId, extractDoi, similarity } from '@core/metadata';
import { exists, readText, tempTracker, writeText } from './helpers';

const tmp = tempTracker();
afterEach(() => tmp.cleanup());

describe('extractDoi', () => {
  it('裸 DOI', () => {
    expect(extractDoi('10.1000/xyz123')).toBe('10.1000/xyz123');
    expect(extractDoi('本文 DOI 10.1038/nature12373 见正文')).toBe('10.1038/nature12373');
  });

  it('带 doi: / https://doi.org/ 前缀', () => {
    expect(extractDoi('doi:10.1038/nature12373')).toBe('10.1038/nature12373');
    expect(extractDoi('DOI: 10.1038/nature12373')).toBe('10.1038/nature12373');
    expect(extractDoi('https://doi.org/10.1000/xyz123')).toBe('10.1000/xyz123');
    expect(extractDoi('http://dx.doi.org/10.1000/xyz123')).toBe('10.1000/xyz123');
  });

  it('剥掉尾部的标点', () => {
    expect(extractDoi('见 10.1038/nature12373.')).toBe('10.1038/nature12373');
    expect(extractDoi('(10.5555/abc)')).toBe('10.5555/abc');
    expect(extractDoi('10.5555/abc, and more')).toBe('10.5555/abc');
  });

  it('没有 DOI 时返回空串，不抛异常', () => {
    expect(extractDoi('本文没有标识符')).toBe('');
    expect(extractDoi('')).toBe('');
    expect(extractDoi(null)).toBe('');
    expect(extractDoi(undefined)).toBe('');
    expect(extractDoi('arXiv:1706.03762')).toBe('');
  });
});

describe('extractArxivId', () => {
  it('识别的 arXiv 号（可带版本）', () => {
    expect(extractArxivId('arXiv:1706.03762')).toBe('1706.03762');
    expect(extractArxivId('arXiv:1706.03762v5')).toBe('1706.03762');
    expect(extractArxivId('see arxiv 2401.12345 for more')).toBe('2401.12345');
    expect(extractArxivId('arXiv/1706.03762')).toBe('1706.03762');
  });

  it('没有 arXiv 号时返回空串', () => {
    expect(extractArxivId('普通正文')).toBe('');
    expect(extractArxivId(null)).toBe('');
    expect(extractArxivId(undefined)).toBe('');
  });

  it('与 naming 的差异（有意为之）：正文里必须带 arxiv 字样，裸编号不算', () => {
    expect(extractArxivId('1706.03762')).toBe('');
  });
});

describe('similarity：标题相似度（0-1）', () => {
  it('完全相同 → 1，任一侧为空 → 0', () => {
    expect(similarity('deep learning', 'deep learning')).toBe(1);
    expect(similarity('', 'deep learning')).toBe(0);
    expect(similarity('deep learning', '')).toBe(0);
    expect(similarity('', '')).toBe(0);
  });

  it('完全不同的词集 → 0', () => {
    expect(similarity('deep learning', 'quantum chemistry')).toBe(0);
  });

  it('子集关系：Jaccard + 前缀加成', () => {
    // {deep, learning} vs {deep, learning, methods} → 2/3 + 0.15
    expect(similarity('deep learning', 'deep learning methods')).toBeCloseTo(0.8167, 3);
    expect(similarity('deep learning', 'deep learning methods')).toBeGreaterThan(0.72); // Crossref 采纳阈值
  });

  it('越像分越高，且上封顶 1', () => {
    const base = 'a1 a2 a3 a4 a5 a6 a7 a8 a9 a10';
    expect(similarity('deep learning', 'deep learning methods')).toBeGreaterThan(
      similarity('deep learning', 'deep learning for quantum chemistry'),
    );
    expect(similarity(base, `${base} a11`)).toBe(1); // 0.909 + 0.15 → 截到 1
  });

  it('对称', () => {
    const a = 'graph neural networks for nlp';
    const b = 'graph neural networks';
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a), 10);
  });
});

describe('MetadataClient：离线（online:false）绝不发请求', () => {
  it('online:false 时所有查询都返回 null，并把"没有结果"记进缓存', async () => {
    const dir = await tmp.make('meta-offline');
    const cacheFile = path.join(dir, 'metadata.json');
    const client = new MetadataClient({ cacheFile, online: false });

    expect(await client.lookupDoi('10.1000/xyz123')).toBeNull();
    expect(await client.lookupArxiv('1706.03762')).toBeNull();
    expect(await client.searchByTitle('Graph Neural Networks', 2020)).toBeNull();
    // 标题太短时直接返回，连缓存都不读
    expect(await client.searchByTitle('short')).toBeNull();

    await client.close();
    expect(await exists(cacheFile)).toBe(true);
    const cache = JSON.parse(await readText(cacheFile)) as Record<string, unknown>;
    expect(Object.keys(cache)).toContain('doi:10.1000/xyz123');
    expect(Object.keys(cache)).toContain('arxiv:1706.03762');
    expect(cache['doi:10.1000/xyz123']).toMatchObject({ data: null });
  });

  it('空 DOI / 空 arXiv 号直接返回 null', async () => {
    const dir = await tmp.make('meta-empty');
    const client = new MetadataClient({ cacheFile: path.join(dir, 'metadata.json'), online: false });
    expect(await client.lookupDoi('')).toBeNull();
    expect(await client.lookupArxiv('')).toBeNull();
    expect(await client.searchByTitle('   ')).toBeNull();
    await client.close();
  });

  it('缓存文件损坏时不影响使用', async () => {
    const dir = await tmp.make('meta-corrupt');
    const cacheFile = path.join(dir, 'metadata.json');
    await writeText(cacheFile, '{not json');
    const client = new MetadataClient({ cacheFile, online: false });
    expect(await client.lookupDoi('10.1000/xyz123')).toBeNull();
    await client.close();
  });
});

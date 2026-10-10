/**
 * src/core/export.ts —— BibTeX / CSV / 引用 / Markdown 笔记导出。
 */
import { describe, expect, it } from 'vitest';

import { EXPORT_EXT, bibtexKey, exportContent, formatCitation, itemNotesMarkdown, toBibTeX, toCSV, toCSLJSON, toRIS } from '@core/export';
import { makeAnnotation, makeItem } from './helpers';

const paper = makeItem({
  id: 'it_1',
  title: '深度学习综述',
  authors: ['张伟', '李雷'],
  year: 2022,
  venue: '计算机学报',
  volume: '43',
  issue: '2',
  pages: '1-12',
  doi: '10.1234/abc',
  url: 'https://doi.org/10.1234/abc',
  abstract: '这是一篇关于深度学习的综述。',
  keywords: ['深度学习'],
  tags: ['待精读'],
  name: 'shen-du-xue-xi.pdf',
  readState: 'reading',
  starred: true,
  annotationCount: 2,
  pageCount: 20,
  note: '我的笔记',
  progress: { page: 5, percent: 40 },
});

describe('toBibTeX', () => {
  it('以 @ 开头、含标题与作者', () => {
    const bib = toBibTeX([paper]);
    expect(bib.startsWith('@')).toBe(true);
    expect(bib).toContain('title = {深度学习综述}');
    expect(bib).toContain('author = {张伟 and 李雷}');
    expect(bib).toContain('year = {2022}');
    expect(bib).toContain('journal = {计算机学报}');
    expect(bib).toContain('doi = {10.1234/abc}');
    expect(bib).toContain('file = {shen-du-xue-xi.pdf}');
    expect(bib.endsWith('}')).toBe(true);
  });

  it('条目类型与 key 合理', () => {
    expect(toBibTeX([paper])).toMatch(/^@article\{/); // 有 venue 的 pdf → article
    expect(bibtexKey(paper)).toBe('张伟2022深度学习综述');
    expect(toBibTeX([paper])).toContain('{张伟2022深度学习综述,');
    expect(toBibTeX([makeItem({ authors: [], year: null, title: 'Untitled Work', venue: '', kind: 'other' })])).toMatch(/^@misc\{anon/);
  });

  it('多条之间空行分隔；key 冲突时自动加后缀', () => {
    const a = makeItem({ authors: ['Smith'], year: 2020, title: 'Neural Nets', venue: '' });
    const b = makeItem({ authors: ['Smith'], year: 2020, title: 'Neural Nets', venue: '' });
    const bib = toBibTeX([a, b]);
    expect(bib.split('\n\n')).toHaveLength(2);
    expect(bib).toContain('{smith2020neural,');
    expect(bib).toContain('{smith2020neuralb,');
  });

  it('arXiv 条目带 eprint / archivePrefix', () => {
    const bib = toBibTeX([makeItem({ arxivId: '1706.03762', title: 'Attention', authors: ['Vaswani'] })]);
    expect(bib).toMatch(/^@misc\{/);
    expect(bib).toContain('eprint = {1706.03762}');
    expect(bib).toContain('archivePrefix = {arXiv}');
  });

  it('keywords 字段只出现一次（keywords 与 tags 合并输出）', () => {
    const bib = toBibTeX([paper]);
    expect(bib.match(/keywords = /g) ?? []).toHaveLength(1);
    expect(bib).toContain('keywords = {深度学习, 待精读}');
  });

  it('只有 keywords 或只有 tags 时也各输出一次', () => {
    const kwOnly = toBibTeX([makeItem({ title: 'T', authors: ['A'], keywords: ['k1'], tags: [] })]);
    expect(kwOnly.match(/keywords = /g) ?? []).toHaveLength(1);
    expect(kwOnly).toContain('keywords = {k1}');

    const tagOnly = toBibTeX([makeItem({ title: 'T', authors: ['A'], keywords: [], tags: ['t1'] })]);
    expect(tagOnly.match(/keywords = /g) ?? []).toHaveLength(1);
    expect(tagOnly).toContain('keywords = {t1}');

    const neither = toBibTeX([makeItem({ title: 'T', authors: ['A'], keywords: [], tags: [] })]);
    expect(neither.match(/keywords = /g) ?? []).toHaveLength(0);
  });

  it('花括号会被清掉，避免破坏 BibTeX 结构', () => {
    const bib = toBibTeX([makeItem({ title: 'A {Weird} Title', authors: ['A'] })]);
    expect(bib).toContain('title = {A Weird Title}');
  });

  it('空数组 → 空字符串', () => {
    expect(toBibTeX([])).toBe('');
  });
});

describe('toCSV', () => {
  it('以 UTF-8 BOM 开头，且行数 = 条目数 + 1', () => {
    const csv = toCSV([paper, makeItem({ title: 'B', authors: ['李四'] }), makeItem({ title: 'C' })]);
    expect(csv.startsWith('\uFEFF')).toBe(true);

    const lines = csv.split('\n');
    expect(lines[lines.length - 1]).toBe(''); // 末尾换行
    const body = lines.slice(0, -1);
    expect(body).toHaveLength(3 + 1); // 表头 + 3 行
    expect(body[0]).toContain('标题');
    expect(body[0]).toContain('DOI');
    expect(body[1]).toContain('深度学习综述');
  });

  it('笔记里的换行不会撑破行数', () => {
    const item = makeItem({ title: 'N', note: '第一行\n第二行\r\n第三行' });
    const csv = toCSV([item]);
    const body = csv.split('\n').slice(0, -1);
    expect(body).toHaveLength(2);
    expect(body[1]).toContain('第一行 第二行 第三行');
  });

  it('逗号 / 引号按 CSV 规则转义', () => {
    const csv = toCSV([makeItem({ title: 'A, B "quoted"', authors: [] })]);
    expect(csv).toContain('"A, B ""quoted"""');
  });

  it('阅读状态 / 星标 / 缺失 / 进度都落到列里', () => {
    const csv = toCSV([makeItem({ title: 'X', readState: 'read', starred: true, missing: true, progress: { percent: 55 } })]);
    const row = csv.split('\n')[1];
    expect(row).toContain('已读');
    expect(row).toContain('55%');
    expect(row.split(',')).toContain('是');
  });

  it('空数组时只剩表头（外加一个空行）', () => {
    const csv = toCSV([]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const body = csv.split('\n').filter((line) => line.length > 0);
    expect(body).toHaveLength(1);
    expect(body[0]).toContain('标题');
  });
});

describe('formatCitation：四种风格', () => {
  const styles = ['gbt7714', 'apa', 'ieee', 'mla'] as const;

  it('四种风格都非空，且含标题与年份', () => {
    for (const style of styles) {
      const out = formatCitation(paper, style);
      expect(out.length).toBeGreaterThan(10);
      expect(out).toContain('深度学习综述');
      expect(out).toContain('2022');
    }
  });

  it('gb/t 7714：超过 3 位作者用"等"', () => {
    const many = makeItem({ title: 'T', authors: ['A', 'B', 'C', 'D'], year: 2020, venue: 'V' });
    expect(formatCitation(many, 'gbt7714')).toContain('等');
    expect(formatCitation(many, 'gbt7714')).toContain('A, B, C');
    expect(formatCitation(paper, 'gbt7714')).not.toContain('等');
  });

  it('ieee：名字缩写', () => {
    expect(formatCitation(makeItem({ title: 'T', authors: ['John Smith'], year: 2020 }), 'ieee')).toContain('J. Smith');
  });

  it('mla：超过 2 位作者用 et al.', () => {
    const many = makeItem({ title: 'T', authors: ['A', 'B', 'C'], year: 2020 });
    expect(formatCitation(many, 'mla')).toContain('et al.');
    expect(formatCitation(makeItem({ title: 'T', authors: ['A', 'B'], year: 2020 }), 'mla')).not.toContain('et al.');
  });

  it('未知风格退化成 gb/t 7714；缺作者/年份有占位', () => {
    expect(formatCitation(paper, 'nope')).toBe(formatCitation(paper, 'gbt7714'));
    const bare = formatCitation(makeItem({ title: 'T', authors: [], year: null }), 'apa');
    expect(bare).toContain('佚名');
    expect(bare).toContain('n.d.');
  });

  it('默认风格是 gb/t 7714', () => {
    expect(formatCitation(paper)).toBe(formatCitation(paper, 'gbt7714'));
  });
});

describe('itemNotesMarkdown', () => {
  it('含标题、元数据、笔记与批注页码', () => {
    const item = makeItem({
      title: '深度学习综述',
      authors: ['张伟', '李雷'],
      year: 2022,
      venue: '计算机学报',
      doi: '10.1234/abc',
      tags: ['待精读'],
      name: 'a.pdf',
      pageCount: 20,
      note: '我的笔记内容',
      progress: { page: 5, percent: 25 },
    });
    const md = itemNotesMarkdown(item, [
      makeAnnotation({ type: 'highlight', page: 3, text: '被高亮的原文', comment: '这里有问题' }),
      makeAnnotation({ type: 'bookmark', page: 1, text: '', comment: '' }),
    ]);

    expect(md.startsWith('# 深度学习综述')).toBe(true);
    expect(md).toContain('**作者**：张伟、李雷');
    expect(md).toContain('**年份**：2022');
    expect(md).toContain('**DOI**：10.1234/abc');
    expect(md).toContain('**标签**：#待精读');
    expect(md).toContain('**阅读进度**：5/20 页（25%）');
    expect(md).toContain('## 我的笔记');
    expect(md).toContain('我的笔记内容');
    expect(md).toContain('## 批注与高亮');
    expect(md).toContain('### P1 · 书签');
    expect(md).toContain('### P3 · 高亮');
    expect(md).toContain('> 被高亮的原文');
    expect(md).toContain('💬 这里有问题');
    // 批注按页码升序
    expect(md.indexOf('### P1')).toBeLessThan(md.indexOf('### P3'));
  });

  it('没有笔记与批注时也不出现空章节', () => {
    const md = itemNotesMarkdown(makeItem({ title: 'T', note: '' }), []);
    expect(md).not.toContain('## 我的笔记');
    expect(md).not.toContain('## 批注与高亮');
  });

  it('reanchorNote 会作为小字附在批注下', () => {
    const md = itemNotesMarkdown(makeItem({ title: 'T' }), [
      makeAnnotation({ page: 2, text: 'X', reanchorNote: '文件更新后按文本重新定位到 P2' }),
    ]);
    expect(md).toContain('<sub>文件更新后按文本重新定位到 P2</sub>');
  });
});

describe('exportContent / 其他格式', () => {
  it('按 format 分派', () => {
    const items = [paper];
    expect(exportContent(items, { format: 'bibtex' }, () => [])).toBe(toBibTeX(items));
    expect(exportContent(items, { format: 'ris' }, () => [])).toBe(toRIS(items));
    expect(exportContent(items, { format: 'csljson' }, () => [])).toBe(toCSLJSON(items));
    expect(exportContent(items, { format: 'csv' }, () => [])).toBe(toCSV(items));
    expect(exportContent(items, { format: 'markdown-notes' }, () => []).startsWith('# 深度学习综述')).toBe(true);
    expect(EXPORT_EXT.bibtex).toBe('bib');
    expect(EXPORT_EXT.csv).toBe('csv');
    expect(EXPORT_EXT['markdown-notes']).toBe('md');
  });

  it('RIS 与 CSL-JSON 结构可用', () => {
    const ris = toRIS([paper]);
    expect(ris.startsWith('TY  - JOUR')).toBe(true);
    expect(ris).toContain('TI  - 深度学习综述');
    expect(ris).toContain('ER  -');

    const json = JSON.parse(toCSLJSON([paper])) as Record<string, unknown>[];
    expect(json).toHaveLength(1);
    expect(json[0].title).toBe('深度学习综述');
    expect(json[0].DOI).toBe('10.1234/abc');
    expect(Array.isArray(json[0].author)).toBe(true);
  });
});

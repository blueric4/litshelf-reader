/**
 * 导出：BibTeX / RIS / CSL-JSON / CSV / Markdown 笔记，以及"复制引用"。
 */
import type { Annotation, ExportOptions, Item } from '../shared/types';

function firstAuthorSurname(item: Item): string {
  const a = item.authors[0] ?? '';
  if (!a) return 'anon';
  if (/[\u4e00-\u9fa5]/.test(a)) return a.slice(0, 2);
  const parts = a.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? a).replace(/[^\p{L}]/gu, '') || 'anon';
}

export function bibtexKey(item: Item): string {
  const surname = firstAuthorSurname(item).toLowerCase();
  const year = item.year ?? 'n';
  const word = (item.title.match(/[\p{L}\p{N}]+/u)?.[0] ?? 'work').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return `${surname}${year}${word}`;
}

function bibType(item: Item): string {
  if (item.arxivId) return 'misc';
  if (item.kind === 'pdf' || item.kind === 'docx') return item.venue ? 'article' : 'misc';
  if (item.kind === 'epub') return 'book';
  return 'misc';
}

function esc(s: string): string {
  return (s ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

export function toBibTeX(items: Item[]): string {
  const seen = new Map<string, number>();
  return items
    .map((item) => {
      const base = bibtexKey(item);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const key = n > 1 ? `${base}${String.fromCharCode(96 + n)}` : base;
      const authors = item.authors.join(' and ');
      const lines = [
        `  title = {${esc(item.title)}}`,
        authors ? `  author = {${esc(authors)}}` : '',
        item.year ? `  year = {${item.year}}` : '',
        item.venue ? `  journal = {${esc(item.venue)}}` : '',
        item.volume ? `  volume = {${esc(item.volume)}}` : '',
        item.issue ? `  number = {${esc(item.issue)}}` : '',
        item.pages ? `  pages = {${esc(item.pages)}}` : '',
        item.doi ? `  doi = {${esc(item.doi)}}` : '',
        item.arxivId ? `  eprint = {${esc(item.arxivId)}}` : '',
        item.arxivId ? `  archivePrefix = {arXiv}` : '',
        item.url ? `  url = {${esc(item.url)}}` : '',
        item.abstract ? `  abstract = {${esc(item.abstract).slice(0, 1200)}}` : '',
        // keywords 与 tags 合并成同一个 BibTeX 字段；两边都有时只输出合并后的那一条，
        // 否则同一个条目里会出现两个 keywords = {}（非法 / 解析器行为不确定）。
        item.keywords.length && !item.tags.length ? `  keywords = {${esc(item.keywords.join(', '))}}` : '',
        item.tags.length ? `  keywords = {${esc([...item.keywords, ...item.tags].join(', '))}}` : '',
        `  file = {${esc(item.name)}}`,
      ].filter(Boolean);
      return `@${bibType(item)}{${key},\n${lines.join(',\n')}\n}`;
    })
    .join('\n\n');
}

export function toRIS(items: Item[]): string {
  return items
    .map((item) => {
      const lines = ['TY  - JOUR'];
      for (const a of item.authors) lines.push(`AU  - ${a}`);
      lines.push(`TI  - ${item.title}`);
      if (item.year) lines.push(`PY  - ${item.year}`);
      if (item.venue) lines.push(`JO  - ${item.venue}`);
      if (item.volume) lines.push(`VL  - ${item.volume}`);
      if (item.issue) lines.push(`IS  - ${item.issue}`);
      if (item.pages) lines.push(`SP  - ${item.pages}`);
      if (item.doi) lines.push(`DO  - ${item.doi}`);
      if (item.url) lines.push(`UR  - ${item.url}`);
      if (item.abstract) lines.push(`AB  - ${item.abstract.replace(/\s+/g, ' ')}`);
      for (const k of item.keywords) lines.push(`KW  - ${k}`);
      for (const t of item.tags) lines.push(`KW  - ${t}`);
      lines.push('ER  -');
      return lines.join('\n');
    })
    .join('\n\n');
}

export function toCSLJSON(items: Item[]): string {
  return JSON.stringify(
    items.map((item) => ({
      id: item.id,
      type: item.arxivId ? 'article' : 'article-journal',
      title: item.title,
      author: item.authors.map((a) => {
        if (/[\u4e00-\u9fa5]/.test(a)) return { literal: a };
        const parts = a.trim().split(/\s+/);
        if (parts.length === 1) return { literal: a };
        return { given: parts.slice(0, -1).join(' '), family: parts[parts.length - 1] };
      }),
      issued: item.year ? { 'date-parts': [[item.year]] } : undefined,
      'container-title': item.venue || undefined,
      volume: item.volume || undefined,
      issue: item.issue || undefined,
      page: item.pages || undefined,
      DOI: item.doi || undefined,
      URL: item.url || undefined,
      abstract: item.abstract || undefined,
      keyword: [...item.keywords, ...item.tags].join(', ') || undefined,
      note: item.note ? item.note.slice(0, 2000) : undefined,
    })),
    null,
    2,
  );
}

function csvCell(v: string): string {
  const s = (v ?? '').replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

export function toCSV(items: Item[]): string {
  const header = [
    '标题',
    '作者',
    '年份',
    '期刊/出处',
    '卷',
    '期',
    '页码',
    'DOI',
    '标签',
    '阅读状态',
    '星标',
    '页数',
    '阅读进度',
    '添加时间',
    '最近阅读',
    '文件路径',
    '文件缺失',
    '批注数',
    '笔记',
  ];
  const rows = items.map((item) =>
    [
      item.title,
      item.authors.join('; '),
      item.year ? String(item.year) : '',
      item.venue,
      item.volume,
      item.issue,
      item.pages,
      item.doi,
      item.tags.join('; '),
      { unread: '未读', reading: '在读', read: '已读' }[item.readState] ?? item.readState,
      item.starred ? '是' : '',
      item.pageCount ? String(item.pageCount) : '',
      `${Math.round(item.progress.percent)}%`,
      new Date(item.addedAt).toLocaleString('zh-CN'),
      item.lastOpenedAt ? new Date(item.lastOpenedAt).toLocaleString('zh-CN') : '',
      item.path,
      item.missing ? '是' : '',
      String(item.annotationCount),
      item.note.replace(/\s+/g, ' ').slice(0, 500),
    ]
      .map((v) => csvCell(String(v)))
      .join(','),
  );
  // 前置 BOM，Excel 打开中文不乱码
  return `\uFEFF${header.join(',')}\n${rows.join('\n')}\n`;
}

export function itemNotesMarkdown(item: Item, annotations: Annotation[]): string {
  const lines: string[] = [];
  lines.push(`# ${item.title}`);
  lines.push('');
  const meta: string[] = [];
  if (item.authors.length) meta.push(`**作者**：${item.authors.join('、')}`);
  if (item.year) meta.push(`**年份**：${item.year}`);
  if (item.venue) meta.push(`**出处**：${item.venue}`);
  if (item.doi) meta.push(`**DOI**：${item.doi}`);
  if (item.url) meta.push(`**链接**：${item.url}`);
  if (item.tags.length) meta.push(`**标签**：${item.tags.map((t) => `#${t}`).join(' ')}`);
  meta.push(`**文件**：\`${item.name}\``);
  meta.push(`**阅读进度**：${item.progress.page}/${item.pageCount || item.progress.total || '?'} 页（${Math.round(item.progress.percent)}%）`);
  lines.push(meta.join('  \n'));
  lines.push('');
  if (item.note.trim()) {
    lines.push('## 我的笔记');
    lines.push('');
    lines.push(item.note.trim());
    lines.push('');
  }
  if (annotations.length) {
    lines.push('## 批注与高亮');
    lines.push('');
    const sorted = [...annotations].sort((a, b) => a.page - b.page);
    for (const a of sorted) {
      const label = { highlight: '高亮', underline: '下划线', squiggly: '波浪线', strikeout: '删除线', note: '批注', bookmark: '书签' }[a.type] ?? a.type;
      lines.push(`### P${a.page} · ${label}`);
      lines.push('');
      if (a.text.trim()) lines.push(`> ${a.text.replace(/\n+/g, ' ')}`);
      if (a.comment.trim()) lines.push(`\n💬 ${a.comment}`);
      if (a.reanchorNote) lines.push(`\n<sub>${a.reanchorNote}</sub>`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function toNotesBundle(items: Item[], annotationsFor: (itemId: string) => Annotation[]): string {
  return items.map((item) => itemNotesMarkdown(item, annotationsFor(item.id))).join('\n\n---\n\n');
}

/** 复制引用：GB/T 7714 / APA / IEEE / MLA */
export function formatCitation(item: Item, style = 'gbt7714'): string {
  const authors = item.authors.length ? item.authors : ['佚名'];
  const year = item.year ? String(item.year) : 'n.d.';
  const title = item.title || item.name;
  const venue = item.venue || '';
  const volIssue = [item.volume, item.issue].filter(Boolean).join('(') + (item.issue ? ')' : '');
  const pages = item.pages ? `: ${item.pages}` : '';
  const doi = item.doi ? ` DOI: ${item.doi}.` : '';

  switch (style) {
    case 'apa': {
      const a = authors.map((n) => n).join(', ');
      return `${a} (${year}). ${title}. ${venue}${volIssue ? `, ${volIssue}` : ''}${pages}.${doi}`;
    }
    case 'ieee': {
      const a = authors
        .map((n) => {
          const parts = n.trim().split(/\s+/);
          if (parts.length === 1) return n;
          return `${parts.slice(0, -1).map((p) => `${p[0]}.`).join(' ')} ${parts[parts.length - 1]}`;
        })
        .join(', ');
      return `${a}, "${title}," ${venue}${volIssue ? `, vol. ${item.volume ?? ''}${item.issue ? `, no. ${item.issue}` : ''}` : ''}${pages}, ${year}.${doi}`;
    }
    case 'mla': {
      const a = authors.length > 2 ? `${authors[0]}, et al.` : authors.join(', and ');
      return `${a}. "${title}." ${venue}${volIssue ? `, vol. ${item.volume ?? ''}` : ''}, ${year}${pages}.${doi}`;
    }
    case 'gbt7714':
    default: {
      const a = authors.slice(0, 3).join(', ') + (authors.length > 3 ? ', 等' : '');
      return `${a}. ${title}[J]. ${venue}${item.year ? `, ${item.year}` : ''}${volIssue ? `, ${volIssue}` : ''}${pages}.${doi}`;
    }
  }
}

export function exportContent(
  items: Item[],
  opts: ExportOptions,
  annotationsFor: (itemId: string) => Annotation[],
): string {
  switch (opts.format) {
    case 'bibtex':
      return toBibTeX(items);
    case 'ris':
      return toRIS(items);
    case 'csljson':
      return toCSLJSON(items);
    case 'csv':
      return toCSV(items);
    case 'markdown-notes':
      return toNotesBundle(items, annotationsFor);
    default:
      return '';
  }
}

export const EXPORT_EXT: Record<ExportOptions['format'], string> = {
  bibtex: 'bib',
  ris: 'ris',
  csljson: 'json',
  csv: 'csv',
  'markdown-notes': 'md',
};

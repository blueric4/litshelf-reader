/**
 * 检索：查询语法解析 + 打分匹配。
 * 语法示例：`tag:待精读 author:张 year:2023..2025 is:unread 图神经网络`
 */
import type { Annotation, Item, SearchResult } from '../shared/types';
import { normalizeForMatch } from './reanchor';

export interface QueryFilter {
  key: string;
  value: string;
}

export interface ParsedQuery {
  terms: string[];
  phrases: string[];
  filters: QueryFilter[];
  yearFrom: number | null;
  yearTo: number | null;
  /** 是否有任何有效内容 */
  empty: boolean;
}

const FILTER_KEYS = new Set(['tag', 'author', 'year', 'is', 'kind', 'ext', 'title', 'doi', 'note', 'ann', 'folder', 'root', 'path']);

export function parseQuery(raw: string): ParsedQuery {
  const out: ParsedQuery = { terms: [], phrases: [], filters: [], yearFrom: null, yearTo: null, empty: true };
  const text = (raw ?? '').trim();
  if (!text) return out;

  const phraseRe = /"([^"]+)"|'([^']+)'/g;
  let rest = text;
  for (const m of text.matchAll(phraseRe)) {
    const phrase = (m[1] ?? m[2] ?? '').trim();
    if (phrase) {
      out.phrases.push(phrase);
      out.empty = false; // 只有短语（没有普通词）也是有效查询
    }
    rest = rest.replace(m[0], ' ');
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const idx = token.indexOf(':');
    if (idx > 0) {
      const key = token.slice(0, idx).toLowerCase();
      const value = token.slice(idx + 1).trim();
      if (FILTER_KEYS.has(key) && value) {
        if (key === 'year') {
          const range = value.match(/^(\d{4})?\.\.(\d{4})?$/);
          if (range) {
            out.yearFrom = range[1] ? Number(range[1]) : null;
            out.yearTo = range[2] ? Number(range[2]) : null;
            out.empty = false;
            continue;
          }
          const single = value.match(/^(\d{4})$/);
          if (single) {
            out.yearFrom = Number(single[1]);
            out.yearTo = Number(single[1]);
            out.empty = false;
            continue;
          }
        }
        out.filters.push({ key, value });
        out.empty = false;
        continue;
      }
    }
    if (token) {
      out.terms.push(token);
      out.empty = false;
    }
  }
  return out;
}

const IS_FLAGS = new Set([
  'unread',
  'read',
  'reading',
  'starred',
  'annotated',
  'note',
  'missing',
  'new',
  'pdf',
  'image',
  'markdown',
  'text',
  'html',
  'docx',
  'epub',
  'other',
]);

export interface SearchContext {
  /** 全文索引：返回每页文本，未索引返回 null */
  text?: (itemId: string) => string[] | null;
  annotations?: (itemId: string) => Annotation[];
}

interface Score {
  score: number;
  fields: Set<string>;
  contexts: { page?: number; snippet: string }[];
}

function snippetAround(text: string, at: number, len: number): string {
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + len + 50);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

function matchTest(haystack: string, needle: string): number {
  if (!haystack || !needle) return -1;
  return normalizeForMatch(haystack).indexOf(needle);
}

export function itemMatchesFilters(item: Item, q: ParsedQuery, ctx: SearchContext): boolean {
  if (q.yearFrom !== null || q.yearTo !== null) {
    const y = item.year ?? 0;
    if (!y) return false;
    if (q.yearFrom !== null && y < q.yearFrom) return false;
    if (q.yearTo !== null && y > q.yearTo) return false;
  }

  for (const f of q.filters) {
    const v = normalizeForMatch(f.value);
    switch (f.key) {
      case 'tag':
        if (!item.tags.some((t) => normalizeForMatch(t).includes(v))) return false;
        break;
      case 'author':
        if (!item.authors.some((a) => normalizeForMatch(a).includes(v))) return false;
        break;
      case 'title':
        if (matchTest(item.title, v) < 0) return false;
        break;
      case 'doi':
        if (!normalizeForMatch(item.doi).includes(v)) return false;
        break;
      case 'kind':
      case 'ext':
        if (item.kind !== v && item.ext !== v) return false;
        break;
      case 'folder':
        if (!normalizeForMatch(item.dir).includes(v)) return false;
        break;
      case 'root':
        if (!normalizeForMatch(item.rootId).includes(v)) return false;
        break;
      case 'path':
        if (!normalizeForMatch(item.relPath).includes(v)) return false;
        break;
      case 'note':
        if (!normalizeForMatch(item.note).includes(v)) return false;
        break;
      case 'ann': {
        const anns = ctx.annotations?.(item.id) ?? [];
        if (!anns.some((a) => normalizeForMatch(a.comment).includes(v) || normalizeForMatch(a.text).includes(v))) return false;
        break;
      }
      case 'is': {
        const flag = v;
        if (!IS_FLAGS.has(flag)) return false;
        switch (flag) {
          case 'unread':
            if (item.readState !== 'unread') return false;
            break;
          case 'read':
            if (item.readState !== 'read') return false;
            break;
          case 'reading':
            if (item.readState !== 'reading') return false;
            break;
          case 'starred':
            if (!item.starred) return false;
            break;
          case 'missing':
            if (!item.missing) return false;
            break;
          case 'annotated':
            if (item.annotationCount <= 0) return false;
            break;
          case 'note':
            if (!item.note) return false;
            break;
          case 'new': {
            const week = Date.now() - 7 * 24 * 3600 * 1000;
            if (item.addedAt < week) return false;
            break;
          }
          default:
            if (item.kind !== flag) return false;
        }
        break;
      }
      default:
        break;
    }
  }
  return true;
}

export function scoreItem(item: Item, q: ParsedQuery, ctx: SearchContext): Score | null {
  if (!itemMatchesFilters(item, q, ctx)) return null;
  const fields = new Set<string>();
  const contexts: { page?: number; snippet: string }[] = [];
  let score = 1;

  const needles = [...q.terms.map((t) => normalizeForMatch(t)), ...q.phrases.map((p) => normalizeForMatch(p))].filter(Boolean);

  if (needles.length) {
    let matchedAll = true;
    for (const needle of needles) {
      let hit = false;
      const titleAt = matchTest(item.title, needle);
      if (titleAt >= 0) {
        score += 12;
        fields.add('标题');
        hit = true;
      }
      // 文件名也参与匹配：用户常常记得的是文件名（含年份、作者、#标签），而不是内嵌标题
      if (matchTest(item.name, needle) >= 0) {
        score += 6;
        fields.add('文件名');
        hit = true;
      }
      if (item.authors.some((a) => normalizeForMatch(a).includes(needle))) {
        score += 7;
        fields.add('作者');
        hit = true;
      }
      if (item.tags.some((t) => normalizeForMatch(t).includes(needle))) {
        score += 8;
        fields.add('标签');
        hit = true;
      }
      if (normalizeForMatch(item.venue).includes(needle)) {
        score += 4;
        fields.add('期刊');
        hit = true;
      }
      if (normalizeForMatch(item.keywords.join(' ')).includes(needle)) {
        score += 3;
        fields.add('关键词');
        hit = true;
      }
      if (normalizeForMatch(item.abstract).includes(needle)) {
        score += 3;
        fields.add('摘要');
        hit = true;
      }
      if (normalizeForMatch(item.note).includes(needle)) {
        score += 5;
        fields.add('笔记');
        const at = normalizeForMatch(item.note).indexOf(needle);
        contexts.push({ snippet: snippetAround(item.note, at, needle.length) });
        hit = true;
      }
      const anns = ctx.annotations?.(item.id) ?? [];
      for (const a of anns) {
        if (normalizeForMatch(a.comment).includes(needle)) {
          score += 4;
          fields.add('批注');
          contexts.push({ page: a.page, snippet: snippetAround(a.comment, normalizeForMatch(a.comment).indexOf(needle), needle.length) });
          hit = true;
          break;
        }
        if (normalizeForMatch(a.text).includes(needle)) {
          score += 2;
          fields.add('标注原文');
          contexts.push({ page: a.page, snippet: snippetAround(a.text, normalizeForMatch(a.text).indexOf(needle), needle.length) });
          hit = true;
          break;
        }
      }
      if (normalizeForMatch(item.excerpt).includes(needle)) {
        score += 2;
        fields.add('正文开头');
        hit = true;
      }
      if (!hit) {
        const pages = ctx.text?.(item.id) ?? null;
        if (pages) {
          let foundPage = -1;
          let foundAt = -1;
          for (let i = 0; i < pages.length; i += 1) {
            const at = normalizeForMatch(pages[i]).indexOf(needle);
            if (at >= 0) {
              foundPage = i + 1;
              foundAt = at;
              break;
            }
          }
          if (foundPage > 0) {
            score += 2;
            fields.add(`正文 P${foundPage}`);
            contexts.push({ page: foundPage, snippet: snippetAround(pages[foundPage - 1], foundAt, needle.length) });
            hit = true;
          }
        }
      }
      if (!hit) matchedAll = false;
    }
    if (!matchedAll) return null;
  }

  // 已读条目略微降权，让未读的先浮上来
  if (item.readState === 'read') score -= 0.3;
  if (item.starred) score += 0.8;
  if (item.missing) score -= 0.4;

  return { score, fields, contexts: contexts.slice(0, 3) };
}

export function searchItems(items: Item[], rawQuery: string, ctx: SearchContext, limit = 300): SearchResult[] {
  const q = parseQuery(rawQuery);
  const results: SearchResult[] = [];
  for (const item of items) {
    const scored = scoreItem(item, q, ctx);
    if (!scored) continue;
    results.push({ item, score: scored.score, fields: [...scored.fields], contexts: scored.contexts });
  }
  results.sort((a, b) => b.score - a.score || b.item.addedAt - a.item.addedAt);
  return results.slice(0, limit);
}

/** 智能集合定义（可保存的筛选） */
export interface SmartCollection {
  id: string;
  name: string;
  query: string;
  builtin?: boolean;
}

export function defaultSmartCollections(now = Date.now()): { id: string; name: string; query: string; count: (items: Item[]) => number }[] {
  return [
    { id: 'recent30', name: '近 30 天添加', query: '', count: (items) => items.filter((i) => now - i.addedAt < 30 * 24 * 3600 * 1000).length },
    { id: 'starred-unread', name: '星标且未读', query: 'is:starred is:unread', count: (items) => items.filter((i) => i.starred && i.readState === 'unread').length },
    { id: 'annotated', name: '有批注的文献', query: 'is:annotated', count: (items) => items.filter((i) => i.annotationCount > 0).length },
    { id: 'noted', name: '有笔记的文献', query: 'is:note', count: (items) => items.filter((i) => i.note.trim().length > 0).length },
    { id: 'missing', name: '文件缺失', query: 'is:missing', count: (items) => items.filter((i) => i.missing).length },
  ];
}

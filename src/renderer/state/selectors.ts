/**
 * 筛选 / 排序 / 分组：纯函数，方便单测与 memo。
 */
import type { Item, Root } from '@shared/types';
import { searchItems } from '@core/search';
import type { Filter } from './store';

export interface ListResult {
  items: Item[];
  /** 搜索命中的字段名（用于行内展示"命中：标题/笔记/正文 P3"） */
  hitFields: Map<string, string[]>;
  hitSnippets: Map<string, string>;
}

export function isFolderMatch(item: Item, dir: string): boolean {
  if (!dir) return true;
  return item.dir === dir || item.dir.startsWith(`${dir}/`);
}

export function matchesFilter(item: Item, filter: Filter): boolean {
  switch (filter.kind) {
    case 'all':
      return true;
    case 'recent':
      return Date.now() - item.addedAt < 30 * 24 * 3600 * 1000;
    case 'reading':
      return item.readState === 'reading';
    case 'unread':
      return item.readState === 'unread';
    case 'starred':
      return item.starred;
    case 'toread':
      return item.starred && item.readState !== 'read';
    case 'annotated':
      return item.annotationCount > 0;
    case 'noted':
      return item.note.trim().length > 0;
    case 'missing':
      return item.missing;
    case 'tag':
      return !!filter.value && item.tags.includes(filter.value);
    case 'folder': {
      if (filter.rootId && item.rootId !== filter.rootId) return false;
      if (!filter.value) return true;
      return isFolderMatch(item, filter.value);
    }
    case 'smart':
      return true;
    default:
      return true;
  }
}

export function sortItems(items: Item[], key: Item extends never ? never : string, dir: 'asc' | 'desc'): Item[] {
  const sign = dir === 'asc' ? 1 : -1;
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  const sorted = items.slice();
  sorted.sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case 'title':
        cmp = collator.compare(a.title || a.name, b.title || b.name);
        break;
      case 'author':
        cmp = collator.compare(a.authors[0] ?? '', b.authors[0] ?? '');
        break;
      case 'year':
        cmp = (a.year ?? 0) - (b.year ?? 0);
        break;
      case 'opened':
        cmp = (a.lastOpenedAt ?? 0) - (b.lastOpenedAt ?? 0);
        break;
      case 'mtime':
        cmp = a.mtime - b.mtime;
        break;
      case 'size':
        cmp = a.size - b.size;
        break;
      case 'progress':
        cmp = a.progress.percent - b.progress.percent;
        break;
      case 'added':
      default:
        cmp = a.addedAt - b.addedAt;
        break;
    }
    if (cmp === 0) cmp = collator.compare(a.title || a.name, b.title || b.name);
    return cmp * sign;
  });
  return sorted;
}

export interface ApplyOptions {
  filter: Filter;
  query: string;
  sortKey: string;
  sortDir: 'asc' | 'desc';
  /** 宿主全文检索结果（有值时以它为准，实现"搜到正文"） */
  remoteIds?: Set<string> | null;
  remoteFields?: Map<string, string[]>;
  remoteSnippets?: Map<string, string>;
}

export function applyList(items: Item[], opts: ApplyOptions): ListResult {
  const hitFields = new Map<string, string[]>();
  const hitSnippets = new Map<string, string>();
  let pool = items.filter((item) => matchesFilter(item, opts.filter));

  const query = opts.query.trim();
  if (query) {
    if (opts.remoteIds) {
      pool = pool.filter((i) => opts.remoteIds!.has(i.id));
      for (const [id, fields] of opts.remoteFields ?? []) hitFields.set(id, fields);
      for (const [id, snippet] of opts.remoteSnippets ?? []) hitSnippets.set(id, snippet);
    } else {
      const results = searchItems(pool, query, {}, 500);
      const ids = new Set(results.map((r) => r.item.id));
      for (const r of results) {
        hitFields.set(r.item.id, r.fields);
        if (r.contexts[0]?.snippet) hitSnippets.set(r.item.id, r.contexts[0].snippet);
      }
      pool = pool.filter((i) => ids.has(i.id));
      const order = new Map(results.map((r, idx) => [r.item.id, idx]));
      pool.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      return { items: pool, hitFields, hitSnippets };
    }
  }

  return { items: sortItems(pool, opts.sortKey, opts.sortDir), hitFields, hitSnippets };
}

export interface Group {
  key: string;
  label: string;
  items: Item[];
  /** 分组右侧的补充说明 */
  hint?: string;
}

export function groupItems(items: Item[], groupBy: string, roots: Root[]): Group[] {
  if (groupBy === 'none') return [{ key: 'all', label: '', items }];

  const buckets = new Map<string, Item[]>();
  const push = (key: string, item: Item) => {
    const list = buckets.get(key) ?? [];
    list.push(item);
    buckets.set(key, list);
  };

  for (const item of items) {
    switch (groupBy) {
      case 'read':
        push(item.readState, item);
        break;
      case 'folder':
        push(item.dir || '(根目录)', item);
        break;
      case 'year':
        push(item.year ? String(item.year) : '年份未知', item);
        break;
      case 'tag':
        if (!item.tags.length) push('(无标签)', item);
        else for (const t of item.tags) push(t, item);
        break;
      case 'added': {
        const days = (Date.now() - item.addedAt) / 86400000;
        push(days < 1 ? '今天' : days < 7 ? '本周' : days < 30 ? '本月' : days < 365 ? '今年' : '更早', item);
        break;
      }
      default:
        push('all', item);
    }
  }

  const orderOf = (key: string): number => {
    switch (groupBy) {
      case 'read':
        return { unread: 0, reading: 1, read: 2 }[key] ?? 3;
      case 'added':
        return ['今天', '本周', '本月', '今年', '更早'].indexOf(key);
      case 'year':
        return -Number(key.replace(/\D/g, '') || 0);
      default:
        return 0;
    }
  };

  return [...buckets.entries()]
    .map(([key, list]) => ({
      key,
      label:
        groupBy === 'read'
          ? { unread: '未读', reading: '在读', read: '已读' }[key] ?? key
          : groupBy === 'folder' && roots.length
            ? key
            : key,
      items: list,
      hint: groupBy === 'folder' ? roots.find((r) => r.path)?.name : undefined,
    }))
    .sort((a, b) => orderOf(a.key) - orderOf(b.key) || a.label.localeCompare(b.label, 'zh-Hans-CN'));
}

export interface SidebarCounts {
  all: number;
  recent: number;
  reading: number;
  unread: number;
  starred: number;
  toread: number;
  annotated: number;
  noted: number;
  missing: number;
  tags: { name: string; count: number }[];
  folders: { rootId: string; count: number }[];
}

export function sidebarCounts(items: Item[], roots: Root[]): SidebarCounts {
  const counts: SidebarCounts = {
    all: items.length,
    recent: 0,
    reading: 0,
    unread: 0,
    starred: 0,
    toread: 0,
    annotated: 0,
    noted: 0,
    missing: 0,
    tags: [],
    folders: [],
  };
  const now = Date.now();
  const tagMap = new Map<string, number>();
  const rootMap = new Map<string, number>();
  for (const item of items) {
    if (now - item.addedAt < 30 * 24 * 3600 * 1000) counts.recent += 1;
    if (item.readState === 'reading') counts.reading += 1;
    if (item.readState === 'unread') counts.unread += 1;
    if (item.starred) counts.starred += 1;
    if (item.starred && item.readState !== 'read') counts.toread += 1;
    if (item.annotationCount > 0) counts.annotated += 1;
    if (item.note.trim()) counts.noted += 1;
    if (item.missing) counts.missing += 1;
    for (const t of item.tags) tagMap.set(t, (tagMap.get(t) ?? 0) + 1);
    rootMap.set(item.rootId, (rootMap.get(item.rootId) ?? 0) + 1);
  }
  counts.tags = [...tagMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  counts.folders = roots.map((r) => ({ rootId: r.id, count: rootMap.get(r.id) ?? 0 }));
  return counts;
}

/** 由宿主全文检索结果构造 id 集合与命中信息 */
export function remoteResultMaps(
  results: { item: Item; fields: string[]; contexts: { page?: number; snippet: string }[] }[] | null,
): { ids: Set<string> | null; fields: Map<string, string[]>; snippets: Map<string, string> } {
  if (!results) return { ids: null, fields: new Map(), snippets: new Map() };
  const ids = new Set<string>();
  const fields = new Map<string, string[]>();
  const snippets = new Map<string, string>();
  for (const r of results) {
    ids.add(r.item.id);
    fields.set(r.item.id, r.fields);
    const ctx = r.contexts[0];
    if (ctx) snippets.set(r.item.id, ctx.page ? `P${ctx.page} · ${ctx.snippet}` : ctx.snippet);
  }
  return { ids, fields, snippets };
}

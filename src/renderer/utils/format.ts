/**
 * 展示层格式化小工具。
 */
import type { Item } from '@shared/types';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDate(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const md = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return sameYear ? md : `${d.getFullYear()} 年 ${md}`;
}

export function formatRelative(ts: number | null | undefined): string {
  if (!ts) return '从未';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
  return formatDate(ts);
}

export function readStateLabel(state: Item['readState']): string {
  return { unread: '未读', reading: '在读', read: '已读' }[state] ?? state;
}

export function kindLabel(item: Item): string {
  if (item.kind === 'pdf') return item.pageCount ? `PDF · ${item.pageCount} 页` : 'PDF';
  return (
    {
      markdown: 'Markdown',
      text: '文本',
      html: '网页',
      image: '图片',
      docx: 'Word',
      epub: 'EPUB',
      other: item.ext ? item.ext.toUpperCase() : '文件',
      pdf: 'PDF',
    }[item.kind] ?? '文件'
  );
}

export function authorLine(item: Item): string {
  if (!item.authors.length) return '作者未知';
  if (item.authors.length <= 2) return item.authors.join('、');
  return `${item.authors[0]} 等 ${item.authors.length} 人`;
}

export function subtitle(item: Item): string {
  const parts = [authorLine(item)];
  if (item.year) parts.push(String(item.year));
  if (item.venue) parts.push(item.venue);
  return parts.join(' · ');
}

export function parseTagColors(tags: string[]): Map<string, string> {
  const colors = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#32ADE6', '#007AFF', '#AF52DE', '#FF2D55', '#8E8E93'];
  const map = new Map<string, string>();
  for (const tag of tags) {
    let hash = 0;
    for (let i = 0; i < tag.length; i += 1) hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
    map.set(tag, colors[hash % colors.length]);
  }
  return map;
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function modKey(): string {
  return isMac() ? '⌘' : 'Ctrl';
}

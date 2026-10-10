/**
 * 全文索引命中在页面文本层里的高亮：
 * 不注入 HTML，而是对每个文本节点算出归一化后的命中区间，用 Range.getClientRects()
 * 拿到矩形，再叠一层与批注同构的高亮条。这样完全不会破坏 pdf.js 文本层的排版。
 */
import type { PageTextMap } from './reanchor';

export interface HighlightStrip {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  current: boolean;
}

/** 归一化时被忽略（或折叠）的字符 */
function isSkippable(ch: string): boolean {
  return /[\s\u00a0\u2018\u2019\u201b\u201c\u201d\u2010-\u2015\u2212]/.test(ch);
}

interface NodeInfo {
  node: Text;
  start: number;
  /** 归一化后的文本 */
  norm: string;
  /** 归一化下标 -> 节点内原始下标 */
  map: number[];
}

function collectNodes(root: HTMLElement): NodeInfo[] {
  const out: NodeInfo[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cur = walker.nextNode();
  let start = 0;
  let prevWasSpace = false;
  while (cur) {
    const node = cur as Text;
    const raw = node.data;
    let norm = '';
    const map: number[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      if (isSkippable(ch)) {
        if (prevWasSpace) continue;
        prevWasSpace = true;
        norm += ' ';
        map.push(i);
        continue;
      }
      prevWasSpace = false;
      norm += ch.toLowerCase();
      map.push(i);
    }
    out.push({ node, start, norm, map });
    start += norm.length;
    cur = walker.nextNode();
  }
  return out;
}

function rangeFor(info: NodeInfo, from: number, to: number): Range | null {
  if (to <= from) return null;
  const startIdx = info.map[Math.max(0, Math.min(from, info.map.length - 1))];
  let endIdx: number;
  if (to >= info.map.length) {
    endIdx = info.node.data.length;
  } else {
    endIdx = info.map[to];
  }
  if (endIdx <= startIdx) return null;
  try {
    const range = document.createRange();
    range.setStart(info.node, startIdx);
    range.setEnd(info.node, endIdx);
    return range;
  } catch {
    return null;
  }
}

/**
 * 计算某页所有命中矩形（页面相对百分比）。
 * 返回顺序即"页内命中序号"，调用方用页内偏移决定哪一条是当前命中。
 */
export function findHighlightStrips(
  container: HTMLElement,
  pageEl: HTMLElement,
  query: string,
): HighlightStrip[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 1) return [];
  const pageRect = pageEl.getBoundingClientRect();
  if (pageRect.width <= 0 || pageRect.height <= 0) return [];
  const nodes = collectNodes(container);
  if (!nodes.length) return [];

  const strips: HighlightStrip[] = [];
  let hitIndex = 0;

  for (const info of nodes) {
    let from = 0;
    for (;;) {
      const at = info.norm.indexOf(needle, from);
      if (at < 0) break;
      from = at + Math.max(1, needle.length);
      const range = rangeFor(info, at, at + needle.length);
      if (!range) continue;
      const key = `${hitIndex}`;
      hitIndex += 1;
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width <= 0.5 || rect.height <= 0.5) continue;
        strips.push({
          key,
          left: ((rect.left - pageRect.left) / pageRect.width) * 100,
          top: ((rect.top - pageRect.top) / pageRect.height) * 100,
          width: (rect.width / pageRect.width) * 100,
          height: (rect.height / pageRect.height) * 100,
          current: false,
        });
      }
    }
  }
  return strips;
}

/** 页内命中数（页内 key 的最大值 + 1） */
export function hitCountOfStrips(strips: HighlightStrip[]): number {
  let max = -1;
  for (const strip of strips) max = Math.max(max, Number(strip.key));
  return max + 1;
}

/** 统计归一化文本里的命中次数（用于"第 n / N 处"） */
export function countHits(text: string, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count += 1;
    from = at + Math.max(1, needle.length);
    if (count > 5000) break;
  }
  return count;
}

/** 上下文片段 */
export function snippetAround(text: string, query: string, radius = 34): string {
  const needle = query.trim().toLowerCase();
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return text.slice(0, radius * 2);
  const from = Math.max(0, at - radius);
  const to = Math.min(text.length, at + needle.length + radius);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`;
}

export type { PageTextMap };

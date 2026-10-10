/**
 * 批注精确重定位：用 pdf.js 的文本层几何 + 文本项几何把批注重新落回页面。
 *
 * 两条路径：
 * 1) 打开文档时后台重定位 —— 目标页在文本层里找得到就取 DOM Range 的 client rects，
 *    找不到就退回 pdf.js 文本项的几何（不需要先把页面渲染出来）。
 * 2) 划词建批注 —— 直接由 DOM 选区反算 0-1 相对矩形。
 *
 * 定位失败只标记 needsReview，绝不删除数据。
 */
import type { Annotation, AnnotationAnchor, AnnotationRect } from '@shared/types';
import { buildAnchor, locateInPages, normalizeForMatch } from '@core/reanchor';
import type { PDFPageProxy } from 'pdfjs-dist';

/** 合并同一行文本项时的基线容差（PDF 点） */
const BASELINE_TOL = 3;
/** 命中矩形的最小面积（占页面比例），滤掉断行残留 */
const MIN_RECT_AREA = 1e-6;

export interface PageTextMap {
  page: number;
  pageWidth: number;
  pageHeight: number;
  container: HTMLElement;
  divs: HTMLElement[];
  /** 拼接后的页文本（div 之间用换行） */
  text: string;
  /** 归一化后的页文本 */
  normalized: string;
  /** normalized 下标 -> [div 下标, div 内文本下标] */
  offsets: { div: number; offset: number }[];
  /** 每个 div 在拼接文本里的起点 */
  starts: number[];
}

/** 取出页面文本层里的所有文本 div（TextLayer 输出，class 固定） */
export function collectTextDivs(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('span, br')).filter(
    (el) => el.tagName === 'SPAN' && (el.textContent?.length ?? 0) > 0,
  );
}

function divText(div: HTMLElement): string {
  return div.textContent ?? '';
}

/** 建立"归一化文本 -> DOM 位置"的映射，用于选区偏移与重定位 */
export function buildPageTextMap(
  page: number,
  container: HTMLElement,
  pageWidth: number,
  pageHeight: number,
): PageTextMap {
  const divs = collectTextDivs(container);
  let text = '';
  const starts: number[] = [];
  for (const div of divs) {
    starts.push(text.length);
    text += divText(div);
  }
  let normalized = '';
  const offsets: { div: number; offset: number }[] = [];
  for (let d = 0; d < divs.length; d += 1) {
    const raw = divText(divs[d]);
    for (let i = 0; i < raw.length; i += 1) {
      const ch = normalizeChar(raw[i]);
      if (ch === '') continue;
      normalized += ch;
      offsets.push({ div: d, offset: i });
    }
  }
  return { page, pageWidth, pageHeight, container, divs, text, normalized, offsets, starts };
}

/** 单个字符归一化；返回空串表示该字符被忽略（空白分别折叠成空格，这里交给调用方） */
function normalizeChar(ch: string): string {
  if (/\s/.test(ch)) return ' ';
  const mapped = ch
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u00A0/g, ' ');
  return mapped.toLowerCase();
}

/** DOM 位置（div 下标 + 字符下标）对应的归一化下标 */
export function normIndexFromDom(map: PageTextMap, divIndex: number, offsetInDiv: number): number {
  if (divIndex >= map.divs.length) return map.normalized.length;
  // 直接线性换算：offsets 是按 div 顺序排好的，二分即可
  let lo = 0;
  let hi = map.offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const at = map.offsets[mid];
    if (at.div < divIndex || (at.div === divIndex && at.offset < offsetInDiv)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 把一个 DOM 文本节点位置换算成归一化下标 */
export function normIndexFromNode(map: PageTextMap, node: Node, offset: number): number {
  for (let d = 0; d < map.divs.length; d += 1) {
    const div = map.divs[d];
    if (!div.contains(node)) continue;
    let count = 0;
    const walk = (current: Node): boolean => {
      if (current === node) {
        count += offset;
        return true;
      }
      if (current.nodeType === Node.TEXT_NODE) {
        count += (current.textContent ?? '').length;
        return false;
      }
      for (const child of Array.from(current.childNodes)) {
        if (walk(child)) return true;
      }
      return false;
    };
    walk(div);
    return normIndexFromDom(map, d, count);
  }
  return -1;
}

/** 归一化下标 -> DOM Range */
export function rangeFromNorm(map: PageTextMap, startNorm: number, endNorm: number): Range | null {
  if (startNorm < 0 || endNorm <= startNorm || startNorm >= map.offsets.length) return null;
  const from = map.offsets[startNorm];
  const to = map.offsets[Math.min(endNorm - 1, map.offsets.length - 1)];
  const startInfo = domPoint(map, from, false);
  const endInfo = domPoint(map, to, true);
  if (!startInfo || !endInfo) return null;
  try {
    const range = document.createRange();
    range.setStart(startInfo.node, startInfo.offset);
    range.setEnd(endInfo.node, endInfo.offset);
    return range;
  } catch {
    return null;
  }
}

function domPoint(
  map: PageTextMap,
  at: { div: number; offset: number },
  end: boolean,
): { node: Node; offset: number } | null {
  const div = map.divs[at.div];
  if (!div) return null;
  let remaining = at.offset + (end ? 1 : 0);
  const walk = (node: Node): { node: Node; offset: number } | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.textContent ?? '').length;
      if (remaining <= len) return { node, offset: Math.max(0, Math.min(len, remaining)) };
      remaining -= len;
      return null;
    }
    for (const child of Array.from(node.childNodes)) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(div);
}

/** client rect（视口坐标）-> 页面 0-1 相对矩形 */
export function relRectsFromClientRects(
  clientRects: { left: number; top: number; right: number; bottom: number; width: number; height: number }[],
  pageRect: { left: number; top: number; width: number; height: number },
): AnnotationRect[] {
  if (pageRect.width <= 0 || pageRect.height <= 0) return [];
  const out: AnnotationRect[] = [];
  for (const r of clientRects) {
    const w = r.width;
    const h = r.height;
    if (w <= 0 || h <= 0) continue;
    const rect: AnnotationRect = {
      x: (r.left - pageRect.left) / pageRect.width,
      y: (r.top - pageRect.top) / pageRect.height,
      w: w / pageRect.width,
      h: h / pageRect.height,
    };
    if (rect.w * rect.h < MIN_RECT_AREA) continue;
    pushMerged(out, rect);
  }
  return out.slice(0, 64);
}

/** 同一行（y 相近且 x 相接）的矩形合并，减少 DOM 数量 */
function pushMerged(list: AnnotationRect[], rect: AnnotationRect): void {
  for (const exist of list) {
    const sameLine = Math.abs(exist.y - rect.y) < 0.002 && Math.abs(exist.h - rect.h) < 0.004;
    const gap = rect.x - (exist.x + exist.w);
    const overlapOrTouch = gap > -0.004 && gap < 0.012;
    if (sameLine && overlapOrTouch) {
      const right = Math.max(exist.x + exist.w, rect.x + rect.w);
      exist.x = Math.min(exist.x, rect.x);
      exist.w = right - exist.x;
      return;
    }
  }
  list.push(rect);
}

/** 归一到 0-1 并裁掉越界部分 */
export function clampRects(rects: AnnotationRect[]): AnnotationRect[] {
  return rects
    .map((r) => ({
      x: Math.min(1, Math.max(0, r.x)),
      y: Math.min(1, Math.max(0, r.y)),
      w: Math.min(1, Math.max(0, r.w)),
      h: Math.min(1, Math.max(0, r.h)),
    }))
    .filter((r) => r.w > 0 && r.h > 0);
}

/** 由 DOM Range 算出页面相对矩形（用于文本框选） */
export function rectsFromRange(range: Range, pageEl: HTMLElement): AnnotationRect[] {
  return clampRects(relRectsFromClientRects(Array.from(range.getClientRects()), pageEl.getBoundingClientRect()));
}

/** 选区偏移（用于生成 anchor）：返回被选文字在该页文本里的起始偏移 */
export function selectionOffsets(map: PageTextMap, range: Range): { start: number; end: number } | null {
  const start = normIndexFromNode(map, range.startContainer, range.startOffset);
  const end = normIndexFromNode(map, range.endContainer, range.endOffset);
  if (start < 0) return null;
  return { start, end: end < 0 ? start : end };
}

/** 用页文本 + 偏移生成紧凑 anchor（复用 core 的 occurrence 统计口径） */
export function buildAnchorFromOffsets(text: string, start: number, length: number): AnnotationAnchor {
  return buildAnchor(text, start, length);
}

/**
 * 用"归一化下标"生成 anchor（选区的精确位置来自归一化文本，和 core 的口径一致）。
 */
export function buildAnchorFromNormalized(
  pageText: string,
  normalizedStart: number,
  normalizedEnd: number,
  selected: string,
): AnnotationAnchor {
  const marked = `${pageText.slice(0, normalizedStart)}\u0001${pageText.slice(normalizedStart, normalizedEnd)}\u0002${pageText.slice(normalizedEnd)}`;
  const normalizedMarked = normalizeForMatch(marked);
  const a = normalizedMarked.indexOf('\u0001');
  const b = normalizedMarked.indexOf('\u0002');
  if (a < 0 || b < 0 || b <= a) return buildAnchor(pageText, Math.max(0, normalizedStart), Math.max(1, selected.length));
  const prefix = normalizedMarked.slice(Math.max(0, a - 32), a).trim();
  const suffix = normalizedMarked.slice(b + 1, b + 33).trim();
  const needle = normalizedMarked.slice(a + 1, b);
  let occurrence = 1;
  if (needle) {
    let from = 0;
    for (;;) {
      const found = normalizedMarked.indexOf(needle, from);
      if (found < 0 || found >= a) break;
      occurrence += 1;
      from = found + 1;
    }
  }
  return { prefix, suffix, occurrence };
}

// ---------------------------------------------------------------------------
// 不依赖已渲染 DOM 的几何重定位（用 pdf.js 文本项的变换矩阵）
// ---------------------------------------------------------------------------

export interface LineSeg {
  start: number;
  end: number;
  /** 0-1 相对矩形 */
  rect: AnnotationRect;
}

interface LineItem {
  str: string;
  /** 文本项原点 PDF 坐标（已换算成左上原点） */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 把某页的文本项按行聚合，得到"归一化字符区间 -> 相对矩形"。
 * pageWidth/pageHeight 为未旋转页面尺寸（PDF 用户单位）。
 */
export function buildLineSegments(
  items: { str: string; transform: number[]; width: number; height: number }[],
  pageHeight: number,
  pageWidth: number,
): { text: string; normalized: string; segs: LineSeg[] } {
  const lines: LineItem[] = items
    .filter((it) => it.str && it.str.trim() !== '')
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      // PDF 的 y 是基线、原点在左下；换算成左上原点的行顶
      y: pageHeight - it.transform[5] - it.height,
      w: it.width,
      h: it.height || Math.abs(it.transform[3]) || 10,
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const merged: LineItem[] = [];
  for (const item of lines) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.y - item.y) <= BASELINE_TOL && item.x >= prev.x - 1) {
      prev.str += item.str;
      prev.w = Math.max(prev.x + prev.w, item.x + item.w) - prev.x;
      prev.h = Math.max(prev.h, item.h);
      continue;
    }
    merged.push({ ...item });
  }

  let text = '';
  const segs: LineSeg[] = [];
  for (const item of merged) {
    if (text) text += ' ';
    const start = text.length;
    text += item.str;
    segs.push({
      start,
      end: text.length,
      rect: {
        x: clamp01(item.x / pageWidth),
        y: clamp01(item.y / pageHeight),
        w: clamp01(item.w / pageWidth),
        h: clamp01(item.h / pageHeight),
      },
    });
  }
  return { text, normalized: normalizeForMatch(text), segs };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export interface GeomHit {
  page: number;
  rects: AnnotationRect[];
  text: string;
}

/**
 * 用 pdf.js 几何在指定页里找一段文字。
 * 允许跨行：needle 命中哪几段就取哪几段的矩形。
 */
export async function locateByGeometry(
  page: PDFPageProxy,
  needle: string,
  pageNumber: number,
): Promise<GeomHit | null> {
  const cleanNeedle = normalizeForMatch(needle);
  if (cleanNeedle.length < 2) return null;
  const viewport = page.getViewport({ scale: 1 });
  // 直接把页面转正会破坏坐标口径；旋转页面交给上层标 needsReview
  if (viewport.rotation % 360 !== 0) return null;

  const content = await page.getTextContent();
  const items = content.items.filter((it): it is typeof it & { str: string; transform: number[]; width: number; height: number } =>
    typeof (it as { str?: unknown }).str === 'string',
  );
  const rawDims = viewport.rawDims as { pageWidth: number; pageHeight: number };
  const built = buildLineSegments(items, rawDims.pageHeight, rawDims.pageWidth);
  const at = built.normalized.indexOf(cleanNeedle);
  if (at < 0) return null;

  // 找到覆盖 [at, at+len) 的段，并把字符区间映射回原文用于拼接可读文本
  let covered = 0;
  let firstStart = -1;
  let lastEnd = -1;
  const rects: AnnotationRect[] = [];
  for (let i = 0; i < built.segs.length; i += 1) {
    const seg = built.segs[i];
    const segNormLen = normalizeForMatch(built.text.slice(seg.start, seg.end)).length;
    if (segNormLen === 0) continue;
    const segFrom = covered;
    const segTo = covered + segNormLen;
    covered = segTo;
    if (segTo <= at || segFrom >= at + cleanNeedle.length) continue;
    if (firstStart < 0) firstStart = seg.start;
    lastEnd = seg.end;
    rects.push(seg.rect);
  }
  if (!rects.length || firstStart < 0) return null;
  return {
    page: pageNumber,
    rects: mergeRectsByLine(rects).slice(0, 32),
    text: built.text.slice(firstStart, lastEnd).replace(/\s+/g, ' ').trim(),
  };
}

export interface ReanchorPlan {
  annotation: Annotation;
  page: number;
  rects: AnnotationRect[];
  text: string;
  /** 'dom' 用文本层 DOM 精确到字，'geom' 用文本项几何到行 */
  how: 'dom' | 'geom';
}

/**
 * 为一条 needsReview 的批注规划重定位。
 * - pageTexts 来自宿主全文索引（可为 null）
 * - resolvePage 用于按需拿到某页几何（懒加载）
 */
export async function planReanchor(
  annotation: Annotation,
  pageTexts: string[] | null,
  resolvePage: (page: number) => Promise<PDFPageProxy | null>,
  /** 已经渲染好的页（可以直接用 DOM 精确取） */
  domMaps: Map<number, PageTextMap>,
): Promise<ReanchorPlan | null> {
  if (annotation.type === 'bookmark') return null;
  if (!annotation.text || annotation.text.trim().length < 2) return null;

  const needle = normalizeForMatch(annotation.text);
  const candidates: number[] = [];

  // 1) 文本索引里找最可能的页
  if (pageTexts && pageTexts.length) {
    const hit = locateInPages(pageTexts, annotation.text, annotation.anchor);
    if (hit.how !== 'none') candidates.push(hit.page);
  }
  if (!candidates.includes(annotation.page)) candidates.push(annotation.page);

  for (const pageNumber of candidates) {
    // 2a) 页面已经渲染：DOM 精确到字
    const map = domMaps.get(pageNumber);
    if (map) {
      const at = map.normalized.indexOf(needle);
      if (at >= 0) {
        const range = rangeFromNorm(map, at, at + needle.length);
        if (range) {
          const rects = rectsFromRange(range, map.container);
          if (rects.length) {
            return { annotation, page: pageNumber, rects, text: annotation.text, how: 'dom' };
          }
        }
      }
    }
    // 2b) 未渲染：用文本项几何
    const page = await resolvePage(pageNumber);
    if (!page) continue;
    const hit = await locateByGeometry(page, annotation.text, pageNumber);
    if (hit) {
      return { annotation, page: hit.page, rects: hit.rects, text: annotation.text, how: 'geom' };
    }
  }
  return null;
}

/** 合并相邻行的矩形，让整段高亮的观感更连贯 */
export function mergeRectsByLine(rects: AnnotationRect[]): AnnotationRect[] {
  const sorted = rects.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const out: AnnotationRect[] = [];
  for (const rect of sorted) pushMerged(out, rect);
  return out;
}

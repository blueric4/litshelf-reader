/**
 * 字符模型构建器（Zotero 式划词内核的第 ② 块）：把一页的文字变成"一个字符一个盒子"的模型。
 *
 * 为什么要这一层：
 *   原生选区只能给出"两个 DOM 端点"，而浏览器是**按 DOM 顺序**拉区间的 —— 多栏论文里选区就会越到
 *   相邻栏、拖一下行间距就变成整页。Zotero 的做法是：先把一页的文字变成字符数组（每字带
 *   `rect / inlineRect / rotation / 行段标记`），再把 DOM 端点映射成字符序号，最后**在字符数组上**
 *   算区间、画矩形。本文件负责前半段（模型 + 栏流），`zoteroSelection.ts` 负责后半段。
 *
 * 三条必须记住的口径（都是真实缺陷逼出来的，别再改回去）：
 *
 *   ① **坐标系**：`items[i].transform` 是 PDF 用户空间（y 向上），而且原点**不一定是 (0,0)**
 *      —— 真实 CNKI 论文的 `page.view` 左下角约 (28.35, 14.17)（CropBox 偏移）。所以 CSS 像素是
 *      `x = (e - viewBox[0]) * scale`、`yTop = (viewBox[3] - f - h) * scale`。
 *      **少了"减 viewBox 原点"这一步，整套模型会整体偏移约 54px** —— 这正是老 bug
 *      "选区右端固定在 613"的根因（docs/HANDOFF-column-selection-fix.md §2）。
 *
 *   ② **模型按 DOM 顺序建**：产品挂完文本层后会按视觉阅读顺序重排 span
 *      （`PdfViewer.tsx::reorderTextLayer`，多栏页必需，否则原生拖选会横穿整页），
 *      于是 `items` 的顺序与 DOM 里 span 的顺序**不一致**（历史上实测过 1438 vs 1392 的错位）。
 *      所以：逐个 span（DOM 顺序）建字符，文字取自 `span.textContent`，
 *      几何取自与它配对的那个文本项。顺序一致时按标配对；被物理重排过时用"文字多重集合 +
 *      组内几何排序"把置换还原回来（见 `pairSpansWithItems`）。**数量不等就整体返回 null** ——
 *      宁可不建模型（退回老行为），也不能让"模型第 i 个字符 ↔ DOM 第 i 个字符"错位。
 *
 *   ③ **单栏页绝不能被切成多条流**：整页只有一条栏带时，所有字符给同一个 flowClass，
 *      否则纵向拖过行间距会被 `anchorRunRange` 误夹（手感用例"行间距拖 31 字 / 拖到空白 308 字"）。
 *
 * 纯几何部分（`charModelFromItems`）不依赖任何 DOM 布局，可以在 node 里直接单测；
 * 只有 DOM↔字符对齐表（`TextLayerBoundaryMap`）是懒建的，需要浏览器。
 */

import type {
  ModelRegion,
  PageCharModel,
  TextLayerBoundaryMapLike,
  TextPosition,
  ZoteroChar,
} from './selectionTypes';
// rectsDist 就是 Zotero 原样移植的那一份，冻结在 selectionTypes.ts 里（本文件不复刻实现）
import { rectsDist } from './selectionTypes';
import { TextLayerBoundaryMap } from './zoteroSelection';
import { selectionDebugLog } from './selectionTypes';

/** pdf.js 文本项里我们用到的字段（结构兼容，不 import pdfjs 类型，模块保持纯净） */
interface PdfTextItemLike {
  str?: string;
  /** [a, b, c, d, e, f]：a/b 是文本方向的 cos/sin，e/f 是基线原点（PDF 用户空间，y 向上） */
  transform?: ArrayLike<number> | null;
  /** 文本方向的长度（横排）或字号（竖排） */
  width?: number;
  /** 字号（横排）或文本方向的长度（竖排） */
  height?: number;
  /** pdf.js 标记：这一项是它那一行的行尾 */
  hasEOL?: boolean;
  fontName?: string;
}

export interface SelectionModelInput {
  /** 页面序号（0 起） */
  pageIndex: number;
  /** 页面元素 .rd-pdf-page：模型 rect 全部相对它左上角（CSS 像素） */
  pageEl: HTMLElement;
  /** 文本层容器 .rd-pdf-text（取 span、懒建 DOM↔字符对齐表都用它） */
  textLayer: HTMLElement;
  /** 与 TextLayerBuilder 完全同参拿到的文本项（`page.getTextContent({includeMarkedContent:true, disableNormalization:true}).items`） */
  items: readonly unknown[];
  /**
   * 建模型时用的 span 列表（按 DOM 顺序、排除 `.markedContent`、**含空串 span**）。
   * **可以不传**：不传时由 `buildSelectionModel` 自己从 `textLayer` 里按同一条规则取
   * （推荐不传 —— 让"配对规则"只有一处实现，接线方不会因为过滤条件不同把整页模型搞没）。
   * 传的话必须与 `items` 同源同序，否则 `buildSelectionModel` 直接返回 null（宁可不建也不错位）。
   */
  spans?: readonly HTMLElement[];
  /** 该页的 viewport（pdf.js）：用 scale / width / height */
  viewport: { scale: number; width: number; height: number; transform: number[] };
  /** page.view = [x0, y0, x1, y1]（PDF 用户空间，CropBox 可能不是 0 原点） */
  viewBox: readonly number[];
  /** columnBands.ts 算好的分区（比例 0~1）；单栏页也要给（一条整幅栏带）。给了绝对像素也认，见 normalizeRegions */
  regions: readonly ModelRegion[];
}

/** 一页的几何常量（坐标换算用） */
interface PageGeometry {
  scale: number;
  /** viewBox 原点：所有坐标都要减掉它（历史真因见文件头 ①） */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 页面 CSS 像素尺寸（= viewport.width / height） */
  pageWidth: number;
  pageHeight: number;
}

/** 一个文本项换算到 CSS 像素后的几何 */
interface ItemGeometry {
  /** 文本起点 x（CSS 像素，页面元素左上为原点） */
  x: number;
  /** 基线 y（CSS 像素，y 向下） */
  baselineY: number;
  /** 文本方向长度（CSS 像素，已乘 scale） */
  length: number;
  /** 字号（CSS 像素，已乘 scale） */
  size: number;
  /** 0 / 90 / 180 / 270 */
  rotation: number;
}

/** 一个 span 与它配对到的文本项（DOM 顺序） */
interface SpanPair {
  item: PdfTextItemLike;
  text: string;
  /** 这个文本项对应的文本层 span（阅读顺序置换要对它一起排序/搬动） */
  span: HTMLElement;
}

/** 一个文本项在 chars 里的落点与盒子（DOM 顺序） */
interface PairInfo {
  item: PdfTextItemLike;
  geo: ItemGeometry;
  /** 本项占用的字符区间 [lo, hi]（含端点） */
  lo: number;
  hi: number;
  /** 首 / 末个**可见**字符（跳过软连字符这类 ignorable） */
  first: number;
  last: number;
  /** 本项的并集盒子 [x1, y1, x2, y2] */
  box: [number, number, number, number];
  /** 首字符的栏流 id（分组按视觉行时当键用） */
  flow: string | undefined;
}

/** 一条视觉行（同一行上所有字符共用一个 inlineRect） */
interface LineBucket {
  vertical: boolean;
  /** 跨轴中心：横排 = y 中心；竖排 = x 中心 */
  cross: number;
  flow: string | undefined;
  box: [number, number, number, number];
}

type Box = [number, number, number, number];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 软连字符：不参与正文（Zotero 的 `ignorable`） */
const isIgnorable = (c: string): boolean => c === '\u00AD';

/** 字符宽度权重：CJK（含全角标点）算 1，其余算 0.5 —— 中英混排按权重切区间才不会错位 */
const cjkAdvance = (c: string): number => ((c.codePointAt(0) ?? 0) > 0x2e80 ? 1 : 0.5);

const isVerticalRotation = (rotation: number): boolean => rotation === 90 || rotation === 270;

/** 把弧度角就近取整成 0 / 90 / 180 / 270 */
function normalizeRotation(rad: number): number {
  if (!Number.isFinite(rad)) return 0;
  const deg = (rad * 180) / Math.PI;
  const snapped = Math.round(deg / 90) * 90;
  return ((snapped % 360) + 360) % 360;
}

function asTextItem(raw: unknown): PdfTextItemLike | null {
  if (!raw || typeof raw !== 'object') return null;
  const it = raw as PdfTextItemLike;
  return typeof it.str === 'string' ? it : null;
}

function unionBox(target: Box, extra: readonly [number, number, number, number]): void {
  if (extra[0] < target[0]) target[0] = extra[0];
  if (extra[1] < target[1]) target[1] = extra[1];
  if (extra[2] > target[2]) target[2] = extra[2];
  if (extra[3] > target[3]) target[3] = extra[3];
}

/** 文本方向（阅读推进方向）上的区间：横排取 x，竖排取 y */
const advStart = (box: readonly [number, number, number, number], rotation: number): number =>
  isVerticalRotation(rotation) ? box[1] : box[0];
const advEnd = (box: readonly [number, number, number, number], rotation: number): number =>
  isVerticalRotation(rotation) ? box[3] : box[2];
/** 跨轴（行与行之间）区间：横排取 y，竖排取 x */
const crossStart = (box: readonly [number, number, number, number], rotation: number): number =>
  isVerticalRotation(rotation) ? box[0] : box[1];
const crossEnd = (box: readonly [number, number, number, number], rotation: number): number =>
  isVerticalRotation(rotation) ? box[2] : box[3];

// ---------------------------------------------------------------------------
// 几何：文本项 → CSS 像素
// ---------------------------------------------------------------------------

function resolvePageGeometry(
  viewport: SelectionModelInput['viewport'],
  viewBox: readonly number[],
): PageGeometry | null {
  const scale = num(viewport?.scale, 0);
  if (!(scale > 0)) return null;
  const x0 = num(viewBox?.[0], 0);
  const y0 = num(viewBox?.[1], 0);
  const x1 = num(viewBox?.[2], NaN);
  const y1 = num(viewBox?.[3], NaN);
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !(x1 > x0) || !(y1 > y0)) return null;
  const pageWidth = num(viewport?.width, 0) > 0 ? num(viewport.width, 0) : (x1 - x0) * scale;
  const pageHeight = num(viewport?.height, 0) > 0 ? num(viewport.height, 0) : (y1 - y0) * scale;
  if (!(pageWidth > 0) || !(pageHeight > 0)) return null;
  return { scale, x0, y0, x1, y1, pageWidth, pageHeight };
}

/**
 * 文本项 → CSS 像素几何。**必须减 viewBox 原点、y 必须翻转**（文件头 ①）。
 *
 * `strict = true` 时拿不到 transform 返回 null（排序键用）；
 * 建**字符**时用 `strict = false`：拿不到就退化成"一个贴页面左上的小盒子"。
 *
 * 为什么建字符不能因为一项几何缺失就整页放弃（踩过）：真实 PDF 里会有个别项
 * （标记残留、零宽 run）没有可用的 transform/尺寸，而一页有 1200+ 项 —— 为它一个人
 * 把整页模型废掉，等于**整篇论文的夹取全失效**（实测：p1 有 1221 个正常项 + 1 个病项，
 * 结果这一页夹取完全不工作）。退化盒子只影响这一项的字符位置，
 * 它附近的字符照旧正确；而"字符序号 ↔ DOM 顺序"的一一对应关系不受影响。
 */
function itemGeometry(
  item: PdfTextItemLike,
  geo: PageGeometry,
  textLength: number,
  strict = true,
): ItemGeometry | null {
  const tf = item.transform;
  const hasTf = !!tf && tf.length >= 6;
  const a = hasTf ? num(tf[0], NaN) : NaN;
  const b = hasTf ? num(tf[1], NaN) : NaN;
  const e = hasTf ? num(tf[4], NaN) : NaN;
  const f = hasTf ? num(tf[5], NaN) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(e) || !Number.isFinite(f)) {
    if (strict) return null;
    return { x: 0, baselineY: 0, length: 1, size: 1, rotation: 0 };
  }

  const sizePdf =
    Math.abs(num(item.height, 0)) || Math.abs(hasTf ? num(tf[3], 0) : 0) || Math.abs(a) || 0;
  const size = sizePdf * geo.scale;
  if (!(size > 0)) {
    if (strict) return null;
    return { x: (e - geo.x0) * geo.scale, baselineY: (geo.y1 - f) * geo.scale, length: 1, size: 1, rotation: 0 };
  }

  let length = Math.abs(num(item.width, 0)) * geo.scale;
  if (!(length > 0)) {
    // pdf.js 对某些项（纯标记 / 零宽 run）给的 width 是 0。这里给一个粗估长度，
    // 保证**字符数、字符顺序**与 DOM 仍然一一对应（宁可盒子粗一点，也不能少字）。
    length = size * Math.max(1, textLength) * 0.5;
  }

  return {
    x: (e - geo.x0) * geo.scale,
    // 基线 y：PDF 用户空间 y 向上，页面顶边是 viewBox[3]，减完原点再乘 scale
    baselineY: (geo.y1 - f) * geo.scale,
    length,
    size,
    rotation: normalizeRotation(Math.atan2(b, a)),
  };
}

/** 单个字符的盒子：沿文本方向按权重切区间，厚度 = 字号 */
function charBox(geo: ItemGeometry, d0: number, d1: number): Box {
  const { x, baselineY: y, size, rotation } = geo;
  if (rotation === 90) return [x, y - d1, x + size, y - d0]; // 文本向上
  if (rotation === 270) return [x - size, y + d0, x, y + d1]; // 文本向下
  if (rotation === 180) return [x - d1, y - size, x - d0, y]; // 文本向左
  return [x + d0, y - size, x + d1, y]; // 横排：文本向右，盒子在基线上方
}

/**
 * 把一个文本项的文字切成"每字一个盒子"。
 * pdf.js 的中文项常常一个字一项，但英文/数字是一整串，所以必须按字符宽度权重均分 `width`：
 * CJK 权重 1、非 CJK 0.5，这样中英混排（"第1章"）也不会错位。
 * 软连字符是零宽的：权重给 0，免得把后面的字整体挤偏。
 */
function charBoxesOf(geo: ItemGeometry, text: string): Box[] {
  const weights: number[] = [];
  let total = 0;
  for (let i = 0; i < text.length; i += 1) {
    const w = isIgnorable(text[i]) ? 0 : cjkAdvance(text[i]);
    weights.push(w);
    total += w;
  }
  if (!(total > 0)) {
    for (let i = 0; i < weights.length; i += 1) weights[i] = 1;
    total = Math.max(1, weights.length);
  }
  const out: Box[] = [];
  let acc = 0;
  for (let i = 0; i < weights.length; i += 1) {
    const s = acc / total;
    acc += weights[i];
    const t = acc / total;
    out.push(charBox(geo, geo.length * s, geo.length * t));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 配对：DOM 顺序的 span ↔ 非空 str 的文本项
// ---------------------------------------------------------------------------

/** 排序键（只比相对先后，不比绝对距离：缩放手势的 CSS 拉伸是整体一致的，不破坏顺序） */
interface SortKey {
  index: number;
  y: number;
  x: number;
}

const byTopLeft = (p: SortKey, q: SortKey): number => p.y - q.y || p.x - q.x;

/** span 的视觉位置（**只用来排序**；字符几何仍然取自配对到的文本项，不用 rect 量几何） */
function spanSortKey(el: HTMLElement, index: number): SortKey | null {
  try {
    const r = el.getBoundingClientRect();
    if (!r) return null;
    if (!r.width && !r.height && !r.top && !r.left) return null; // 还没布局 / 已脱离文档
    return { index, y: r.top, x: r.left };
  } catch {
    return null;
  }
}

/** 文本项在页面坐标下的位置（**只用来排序**） */
function itemSortKey(item: PdfTextItemLike, geo: PageGeometry, index: number): SortKey | null {
  const tf = item.transform;
  if (!tf || tf.length < 6) return null;
  const e = num(tf[4], NaN);
  const f = num(tf[5], NaN);
  if (!Number.isFinite(e) || !Number.isFinite(f)) return null;
  return { index, y: (geo.y1 - f) * geo.scale, x: (e - geo.x0) * geo.scale };
}

/**
 * 把"DOM 顺序的文字 span"与"文本项"配对。
 *
 * ## 为什么不按顺序配对（血泪，有真实窗口实测）
 *
 * 我按 Zotero 的思路假设"第 i 个 span ↔ 第 i 个 str 已定义的项"，并要求个数相等。真机上两件事都不成立：
 *
 *   · **个数不等**：pdf.js 渲染时会跳过一部分项（页 2：span 1780 个 vs `str` 已定义 1849 个）；
 *   · **顺序不同**：pdf.js v5 的 `TextLayer` 在渲染前会按位置给文本项排序（`#sortItems`），
 *     所以**渲染出来的 DOM 顺序 ≠ `getTextContent()` 返回的顺序**（页 2 实测：DOM 第 20 个是正文
 *     第一个字「段」，而同样文字的项出现在第 1840 项附近）。
 *
 * 这两个假设让**每一页**的模型都建不出来 → 内核拿不到模型 → 跨栏夹取一次都没运行过
 * （用户："一项都不符合"）。而 tsc、单测、我自己造的探针全都发现不了，因为探针里我用了同一套假设。
 *
 * ## 现在的做法
 *
 * 模型真正需要的不是"顺序"，而是**每个 span 对应哪个文本项的盒子**。所以：
 *   ① 先按文字做一趟**顺序匹配**（两边顺序一致时最精确，也最快）；
 *   ② 顺序匹配失败就退回**几何匹配**：拿 span 的 `getBoundingClientRect()` 中心，
 *      在还没用掉的文本项里找"算出来的盒子离它最近"的那个（只接受距离合理、且文字一致的候选）。
 *
 * 几何匹配只在真正需要时才跑（顺序一致的页面一次都不会走到那里）。文字一致是硬条件：
 * 宁可这一页不建模型（夹取退回浏览器原生行为），也不能把字配错 —— 配错的后果是**静默夹错栏**。
 */
function pairSpansWithItems(
  items: readonly unknown[],
  spans: readonly HTMLElement[],
  geo: PageGeometry,
): SpanPair[] | null {
  if (!spans?.length) return null;
  const candidates: PdfTextItemLike[] = [];
  for (const raw of items ?? []) {
    const it = asTextItem(raw);
    if (it && it.str !== undefined) candidates.push(it);
  }
  if (!candidates.length) return null;

  const texts: string[] = [];
  for (const s of spans) {
    const text = s?.textContent ?? '';
    if (!text) return null; // 传到这里的必须是文字 span
    texts.push(text);
  }

  const ordered = pairInOrder(candidates, texts, spans);
  if (ordered && ordered.length === spans.length) return ordered;

  const byGeometry = pairByGeometry(candidates, texts, spans, geo);
  if (byGeometry) {
    selectionDebugLog('配对退回几何匹配（DOM 顺序与文本项顺序不一致）', {
      spans: spans.length,
      items: candidates.length,
    });
    return byGeometry;
  }
  selectionDebugLog('配对失败：顺序匹配与几何匹配都没成', { spans: spans.length, items: candidates.length });
  return null;
}

/** 顺序匹配：两边顺序一致时最精确。允许跳过"渲染没建 span 的项"，但不允许回头。 */
function pairInOrder(
  candidates: readonly PdfTextItemLike[],
  texts: readonly string[],
  spans: readonly HTMLElement[],
): SpanPair[] | null {
  const out: SpanPair[] = [];
  let cursor = 0;
  for (let i = 0; i < texts.length; i += 1) {
    let found = -1;
    for (let j = cursor; j < candidates.length; j += 1) {
      if ((candidates[j].str ?? '') === texts[i]) {
        found = j;
        break;
      }
    }
    if (found < 0) return null;
    out.push({ item: candidates[found], text: texts[i], span: spans[i] });
    cursor = found + 1;
  }
  return out.length ? out : null;
}

/** 文本项在页面上算出来的中心点（拿不到返回 null） */
function itemCenter(item: PdfTextItemLike, geo: PageGeometry, textLength: number): { x: number; y: number } | null {
  const ig = itemGeometry(item, geo, textLength, false);
  if (!ig) return null;
  const cx = ig.rotation === 0 ? ig.x + ig.length / 2 : ig.x + ig.size / 2;
  const cy = ig.rotation === 0 ? ig.baselineY - ig.size / 2 : ig.baselineY - ig.length / 2;
  return { x: cx, y: cy };
}

/**
 * 几何匹配：span 的中心 ↔ 文本项算出来的中心。只接受**文字一致**且距离在阈值内的候选，
 * 并且是全局贪心（每次挑当前距离最小的一对），避免局部错配把后面全带偏。
 */
function pairByGeometry(
  candidates: readonly PdfTextItemLike[],
  texts: readonly string[],
  spans: readonly HTMLElement[],
  geo: PageGeometry,
): SpanPair[] | null {
  if (!geo.pageWidth || !geo.pageHeight) return null;
  const centers: ({ x: number; y: number } | null)[] = [];
  for (let k = 0; k < candidates.length; k += 1) {
    centers.push(itemCenter(candidates[k], geo, (candidates[k].str ?? '').length));
  }

  const spanCenters: ({ x: number; y: number } | null)[] = [];
  for (const s of spans) {
    try {
      const r = s.getBoundingClientRect();
      spanCenters.push({ x: r.left, y: r.top + r.height / 2 });
    } catch {
      spanCenters.push(null);
    }
  }
  // span 的中心是**客户端**坐标，文本项中心是页面坐标：用页面元素原点换算一次
  let origin: { x: number; y: number } | null = null;
  try {
    const pageEl = spans[0]?.closest('.rd-pdf-page') as HTMLElement | null;
    const pr = pageEl?.getBoundingClientRect();
    origin = pr ? { x: pr.left, y: pr.top } : null;
  } catch {
    origin = null;
  }
  if (!origin) return null;
  for (let i = 0; i < spanCenters.length; i += 1) {
    const c = spanCenters[i];
    if (c) spanCenters[i] = { x: c.x - origin.x, y: c.y - origin.y };
  }

  const used = new Set<number>();
  const result: (SpanPair | null)[] = new Array(spans.length).fill(null);
  const pairs: { si: number; ci: number; d: number }[] = [];
  for (let si = 0; si < spans.length; si += 1) {
    const sc = spanCenters[si];
    if (!sc) return null;
    for (let ci = 0; ci < candidates.length; ci += 1) {
      if ((candidates[ci].str ?? '') !== texts[si]) continue;
      const ic = centers[ci];
      if (!ic) continue;
      pairs.push({ si, ci, d: Math.hypot(ic.x - sc.x, ic.y - sc.y) });
    }
  }
  /**
   * 全局贪心：每次取当前**距离最小**的一对。
   *
   * ⚠️ **不要设距离上限**（我加过 48px，结果真机上最近的一对是 53px，整页配不上）。
   * 安全性来自"**文字必须完全一致**"这条硬条件：距离只用来在**多个同文字**的候选里挑最近的那个，
   * 挑错了也只是两个相同的字互换盒子（选区文字永远正确）。所以这里只关心"有没有同文字的项"，
   * 不关心它们离得多远（缩放、CSS 手势 transform 都会让绝对值不可靠）。
   */
  pairs.sort((a, b) => a.d - b.d);
  for (const p of pairs) {
    if (result[p.si] || used.has(p.ci)) continue;
    result[p.si] = { item: candidates[p.ci], text: texts[p.si], span: spans[p.si] };
    used.add(p.ci);
  }
  for (let i = 0; i < result.length; i += 1) {
    if (!result[i]) {
      // 把这一对的具体数字打出来（坐标差多少、同文字的项有几个）——排查几何匹配失败的唯一线索
      const sc = spanCenters[i];
      let best = Number.POSITIVE_INFINITY;
      let bestIdx = -1;
      if (sc) {
        for (let ci = 0; ci < candidates.length; ci += 1) {
          if ((candidates[ci].str ?? '') !== texts[i]) continue;
          const ic = centers[ci];
          if (!ic) continue;
          const d = Math.hypot(ic.x - sc.x, ic.y - sc.y);
          if (d < best) {
            best = d;
            bestIdx = ci;
          }
        }
      }
      selectionDebugLog('几何匹配失败在某个 span 上', {
        text: texts[i].slice(0, 12),
        spanCenter: sc ? { x: Math.round(sc.x), y: Math.round(sc.y) } : null,
        sameTextItems: candidates.filter((c) => (c.str ?? '') === texts[i]).length,
        nearest: bestIdx >= 0 ? { d: Math.round(best), str: (candidates[bestIdx].str ?? '').slice(0, 12) } : null,
        pageSize: { w: Math.round(geo.pageWidth), h: Math.round(geo.pageHeight) },
      });
      return null; // 有一个 span 配不上 → 整页不建（宁可不夹，也不夹错）
    }
  }
  return result as SpanPair[];
}

// ---------------------------------------------------------------------------
// 分区（栏带）→ 比例坐标
// ---------------------------------------------------------------------------

/**
 * 把分区归一成**比例坐标（0~1）**。契约要求传比例，但为了不让接线方踩"比例 / 绝对像素"的坑，
 * 这里做一次自适应：整组数值都不超过 1（含一点容差）就按比例用，否则按绝对像素除以页宽/页高。
 * 没有分区时给一条整幅栏带 —— 单栏语义，任何情况下都不会夹取。
 */
function normalizeRegions(
  regions: readonly ModelRegion[] | null | undefined,
  geo: PageGeometry,
): ModelRegion[] {
  // 注意：`Array.isArray(x)` 对 `readonly T[]` 会把类型窄化成 `any[]`（TS 的已知行为），
  // 所以这里必须显式标注 src 的类型，否则后面 map 回调参数全变隐式 any（noImplicitAny 直接报错）。
  const src: readonly ModelRegion[] = Array.isArray(regions) ? regions : [];
  if (!src.length) return [{ top: 0, bottom: 1, full: true, bands: [{ start: 0, end: 1 }] }];

  let ratioLike = true;
  for (const r of src) {
    const rt = num(r.top, 0);
    const rb = num(r.bottom, 1);
    if (rt > 1.0001 || rb > 1.0001 || rt < -0.0001 || rb < -0.0001) {
      ratioLike = false;
      break;
    }
    for (const bd of r.bands ?? []) {
      const bs = num(bd?.start, 0);
      const be = num(bd?.end, 1);
      if (bs > 1.0001 || be > 1.0001 || bs < -0.0001 || be < -0.0001) {
        ratioLike = false;
        break;
      }
    }
    if (!ratioLike) break;
  }
  const kx = ratioLike ? 1 : 1 / geo.pageWidth;
  const ky = ratioLike ? 1 : 1 / geo.pageHeight;

  return src.map((r) => {
    const t = clamp(num(r.top, 0) * ky, 0, 1);
    const b = clamp(num(r.bottom, 1) * ky, 0, 1);
    const rawBands: { start: number; end: number }[] = r.bands?.length ? [...r.bands] : [{ start: 0, end: 1 }];
    const bands = rawBands
      .map((bd) => ({
        start: clamp(num(bd?.start, 0) * kx, 0, 1),
        end: clamp(num(bd?.end, 1) * kx, 0, 1),
      }))
      .filter((bd) => bd.end > bd.start);
    return {
      top: Math.min(t, b),
      bottom: Math.max(t, b),
      full: !!r.full,
      bands: bands.length ? bands : [{ start: 0, end: 1 }],
    };
  });
}

/** y 比例落在哪个分区；落在分区之间的缝隙时取最近的一个 */
function regionIndexAtYRatio(regions: readonly ModelRegion[], y: number): number {
  for (let i = 0; i < regions.length; i += 1) {
    if (y >= regions[i].top && y < regions[i].bottom) return i;
  }
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < regions.length; i += 1) {
    const d = y < regions[i].top ? regions[i].top - y : y - regions[i].bottom;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** x 比例落在第几条栏带；落在栏缝里返回 -1 */
function bandIndexAtXRatio(bands: readonly { start: number; end: number }[], x: number): number {
  for (let i = 0; i < bands.length; i += 1) {
    if (x >= bands[i].start && x <= bands[i].end) return i;
  }
  return -1;
}

/** 落在栏缝里的字符：用 rectsDist 找最近的栏带（栏带矩形用该分区的 y 范围补齐） */
function nearestBandIndex(
  region: ModelRegion,
  rect: readonly [number, number, number, number],
  geo: PageGeometry,
): number {
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < region.bands.length; i += 1) {
    const b = region.bands[i];
    const bandRect: Box = [
      b.start * geo.pageWidth,
      region.top * geo.pageHeight,
      b.end * geo.pageWidth,
      region.bottom * geo.pageHeight,
    ];
    const d = rectsDist(bandRect, rect);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * 给每个字符打"栏流"（flowClass）：
 *   字符中心 → y 比例找分区 → x 比例找栏带；落在栏缝里按 rectsDist 归最近的栏。
 * **整页只要没有任何多栏分区，就整页统一成一个流（`0:0`）** —— 单栏页绝不能被切成多条流，
 * 否则纵向拖过行间距会被夹取误夹（文件头 ③）。
 */
function assignFlowClasses(chars: ZoteroChar[], regions: readonly ModelRegion[], geo: PageGeometry): void {
  const hasMultiColumn = regions.some((r) => r.bands.length >= 2);
  if (!hasMultiColumn) {
    for (const ch of chars) ch.flowClass = '0:0';
    return;
  }
  for (const ch of chars) {
    const cx = (ch.rect[0] + ch.rect[2]) / 2;
    const cy = (ch.rect[1] + ch.rect[3]) / 2;
    const ri = regionIndexAtYRatio(regions, cy / geo.pageHeight);
    const region = regions[ri];
    let bi = bandIndexAtXRatio(region.bands, cx / geo.pageWidth);
    if (bi < 0) bi = nearestBandIndex(region, ch.rect, geo);
    ch.flowClass = `${ri}:${bi}`;
  }
}

// ---------------------------------------------------------------------------
// 视觉行分组 → inlineRect
// ---------------------------------------------------------------------------

/**
 * 按视觉行分组，并把"整行矩形"回填到每个字符的 `inlineRect`（Zotero 的语义：同一行的字符共用行矩形，
 * `getRectsFromChars` 据此按行合并选区矩形）。
 *
 * 分组键里带上 flowClass：双栏页左右两栏同一 y 上的两行必须分成两条行矩形，
 * 否则行矩形会横跨栏缝，画出来的选区就是一个横贯整页的蓝条。
 */
function buildLines(chars: ZoteroChar[], infos: readonly PairInfo[]): LineBucket[] {
  const buckets: LineBucket[] = [];
  const lineOf: LineBucket[] = [];
  for (const info of infos) {
    const vertical = isVerticalRotation(info.geo.rotation);
    const cross = vertical ? (info.box[0] + info.box[2]) / 2 : (info.box[1] + info.box[3]) / 2;
    const tol = Math.max(1, info.geo.size * 0.5);
    let best: LineBucket | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const L of buckets) {
      if (L.vertical !== vertical || L.flow !== info.flow) continue;
      const d = Math.abs(L.cross - cross);
      if (d <= tol && d < bestD) {
        bestD = d;
        best = L;
      }
    }
    if (!best) {
      best = { vertical, cross, flow: info.flow, box: [...info.box] as Box };
      buckets.push(best);
    } else {
      unionBox(best.box, info.box);
    }
    lineOf.push(best);
  }
  for (let i = 0; i < infos.length; i += 1) {
    const box = lineOf[i].box;
    const info = infos[i];
    for (let k = info.lo; k <= info.hi; k += 1) {
      chars[k].inlineRect = [box[0], box[1], box[2], box[3]];
    }
  }
  return lineOf;
}

// ---------------------------------------------------------------------------
// 行 / 段 / 空格标记
// ---------------------------------------------------------------------------

/**
 * 行段标记（喂给 `getTextFromChars` 与 `getRectsFromChars`）：
 *   - `lineBreakAfter`：本项末字，且下一项不在同一视觉行 —— y 中心差 > 0.6 行高，或栏流不同；
 *     另外 pdf.js 的 `hasEOL === true` 也直接算行尾。
 *   - `paragraphBreakAfter`：相邻两项**跨栏缝**（栏流不同），或同一栏内行间距 > 1.8 倍行高。
 *   - `spaceAfter`：同一视觉行、两项之间横向间隙 > 0.25 字号。
 *   - `ignorable`：软连字符（在切字符时打）。
 */
function assignBreakFlags(chars: ZoteroChar[], infos: readonly PairInfo[], lines: readonly LineBucket[]): void {
  for (let i = 0; i < infos.length; i += 1) {
    const cur = infos[i];
    const curLine = lines[i];
    const next = i + 1 < infos.length ? infos[i + 1] : null;
    const nextLine = next ? lines[i + 1] : null;
    const curChar = chars[cur.last];
    const lineHeight = Math.max(cur.geo.size, next ? next.geo.size : 0, 1);

    let lineBreak = next === null; // 页尾：最后一个字后面也算一次换行
    let paraBreak = false;
    let space = false;

    if (next && nextLine) {
      const nextFirst = chars[next.first];
      const sameFlow = curChar.flowClass !== undefined && curChar.flowClass === nextFirst.flowClass;
      const crossDelta = Math.abs(nextLine.cross - curLine.cross);
      if (!sameFlow || crossDelta > 0.6 * lineHeight) {
        lineBreak = true;
        if (!sameFlow) {
          paraBreak = true; // 跨栏缝 = 段末
        } else {
          const gap = Math.abs(
            crossStart(next.box, cur.geo.rotation) - crossEnd(cur.box, cur.geo.rotation),
          );
          if (gap > 1.8 * lineHeight) paraBreak = true;
        }
      } else {
        const gap = Math.abs(advStart(next.box, cur.geo.rotation) - advEnd(cur.box, cur.geo.rotation));
        if (gap > 0.25 * cur.geo.size) space = true;
      }
    }

    if (cur.item.hasEOL === true) lineBreak = true;
    curChar.lineBreakAfter = lineBreak;
    if (paraBreak) curChar.paragraphBreakAfter = true;
    if (space) curChar.spaceAfter = true;
    // 末字若是 ignorable（软连字符），也把行尾标记打在它身上：读文本时跳过它也不会丢掉换行
    if (lineBreak && cur.hi !== cur.last) chars[cur.hi].lineBreakAfter = true;
  }
}

// ---------------------------------------------------------------------------
// 诊断（只在排查"模型为什么建不起来"时用；不参与产品逻辑）
// ---------------------------------------------------------------------------

/**
 * 把建模型的每一步单独跑一遍，返回每一步的结论。
 *
 * 为什么要这个：`buildSelectionModel` 失败只返回 null，而"哪一步失败的"（配对 / 几何 / 字符）
 * 从外面看不出来 —— 上一版就是因为分不清这三种失败，把"全篇失效"误当成"差不多能用"。
 */
export function __debugModelStages(
  items: readonly unknown[],
  spans: readonly HTMLElement[],
  viewport: SelectionModelInput['viewport'],
  viewBox: readonly number[],
): Record<string, unknown> {
  const geo = resolvePageGeometry(viewport, viewBox);
  const stage: Record<string, unknown> = { geo: geo ? { scale: geo.scale, x0: geo.x0, y1: geo.y1, pw: geo.pageWidth, ph: geo.pageHeight } : null };
  if (!geo) return stage;
  const pairs = pairSpansWithItems(items, spans, geo);
  stage.pairs = pairs ? pairs.length : null;
  if (!pairs) return stage;
  const bad: number[] = [];
  for (let i = 0; i < pairs.length; i += 1) {
    if (!itemGeometry(pairs[i].item, geo, pairs[i].text.length)) bad.push(i);
  }
  stage.geometryFailures = bad.slice(0, 10);
  stage.geometryFailureCount = bad.length;
  return stage;
}

// ---------------------------------------------------------------------------
// 阅读顺序（DOM 重排 + 模型顺序的**唯一**来源）
// ---------------------------------------------------------------------------

/** 排序用的一行盒子（x / top / bottom 都是页面坐标系 CSS 像素） */
interface OrderNode {
  domIndex: number;
  x: number;
  top: number;
  bottom: number;
  size: number;
}

/** 落在哪个分区（y 比例）；分区间缝隙取最近的 */
function orderRegionIndex(regions: readonly ModelRegion[], yRatio: number): number {
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < regions.length; i += 1) {
    const r = regions[i];
    const d = yRatio < r.top ? r.top - yRatio : yRatio >= r.bottom ? yRatio - r.bottom : 0;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** 落在该分区哪条栏（x 比例）；落在栏缝里取最近的一条 */
function orderBandIndex(bands: readonly { start: number; end: number }[], xRatio: number): number {
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < bands.length; i += 1) {
    const b = bands[i];
    const d = xRatio < b.start ? b.start - xRatio : xRatio > b.end ? xRatio - b.end : 0;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}



/**
 * 按阅读顺序排列**已配对**的文本项，返回置换 order[k] = "第 k 个位置放原来第几个"。
 *
 * 排序键（与 columnBands.ts 的分区 / 栏带同一套口径）：
 *   分区（上→下）→ 区内【多栏区：栏，左→右；通栏区：不切栏】→ 视觉行（上→下）→ 行内 x（左→右）
 *
 * 视觉行按**竖直重叠**归并（不是行号）：上标数字、混排西文 run 的 y 会略有不同，
 * 只要两个盒子竖直重叠超过较矮者的 50% 就算同一行 —— 这样一行里的字在顺序上一定连续。
 *
 * 为什么输入是"配对结果"而不是 items + spans：pdf.js 渲染时会跳过一部分文本项
 * （真实窗口实测：span 1780 个 vs str 已定义的项 1849 个），两者**个数不等**，
 * 所以必须先按文字配对、再排序。返回 null = 几何缺失算不出来，调用方保持原顺序。
 */
function readingOrderOfPairs(
  pairs: readonly SpanPair[],
  geo: PageGeometry,
  regions: readonly ModelRegion[],
): number[] | null {
  if (pairs.length < 2) return null;
  const normRegions = normalizeRegions(regions, geo);
  const nodes: OrderNode[] = [];
  for (let i = 0; i < pairs.length; i += 1) {
    const ig = itemGeometry(pairs[i].item, geo, pairs[i].text.length, false);
    if (!ig) return null;
    nodes.push({ domIndex: i, x: ig.x, top: ig.baselineY - ig.size, bottom: ig.baselineY, size: ig.size });
  }

  const withKey = nodes.map((n) => {
    const yRatio = (n.top + n.bottom) / 2 / geo.pageHeight;
    const ri = orderRegionIndex(normRegions, yRatio);
    const region = normRegions[ri];
    const bi = region.bands.length > 1 ? orderBandIndex(region.bands, n.x / geo.pageWidth) : 0;
    return { ...n, ri, bi };
  });

  const out: number[] = [];
  const regionIds = [...new Set(withKey.map((n) => n.ri))].sort((a, b) => a - b);
  for (const ri of regionIds) {
    const inRegion = withKey.filter((n) => n.ri === ri);
    const bandIds = [...new Set(inRegion.map((n) => n.bi))].sort((a, b) => a - b);
    for (const bi of bandIds) {
      const inBand = inRegion.filter((n) => n.bi === bi);
      const lines: (OrderNode & { ri: number; bi: number })[][] = [];
      for (const n of [...inBand].sort((a, b) => a.top - b.top || a.x - b.x)) {
        const line = lines.find((l) => {
          const ref = l[0];
          const overlap = Math.min(ref.bottom, n.bottom) - Math.max(ref.top, n.top);
          return overlap > 0.5 * Math.min(ref.size, n.size);
        });
        if (line) line.push(n);
        else lines.push([n]);
      }
      for (const line of lines) {
        out.push(...[...line].sort((a, b) => a.x - b.x).map((n) => n.domIndex));
      }
    }
  }
  if (out.length !== nodes.length) return null;
  return out;
}

// ---------------------------------------------------------------------------
// 模型构建（纯几何，不碰 DOM 布局）
// ---------------------------------------------------------------------------

/**
 * 从"DOM 顺序的 span + 同序配对的文本项 + 分区"建字符模型。不依赖 DOM 布局，可在 node 里单测。
 * 任何会导致"字符数 / 字符顺序与 DOM 对不上"的情况一律返回 null（宁可不建也不能错位）。
 */
export function charModelFromItems(
  items: readonly unknown[],
  spans: readonly HTMLElement[],
  viewport: SelectionModelInput['viewport'],
  viewBox: readonly number[],
  regions: readonly ModelRegion[] = [],
  pageIndex = 0,
): PageCharModel | null {
  const geo = resolvePageGeometry(viewport, viewBox);
  if (!geo) return null;

  const unordered = pairSpansWithItems(items, spans, geo);
  if (!unordered || !unordered.length) return null;

  const order = readingOrderOfPairs(unordered, geo, regions);
  let pairs = unordered;
  if (order && !order.every((v, i) => v === i)) {
    const orderedPairs = order.map((i) => unordered[i]);
    const orderedSpans = orderedPairs.map((p) => p.span);
    const host = orderedSpans[0]?.parentElement;
    if (host && orderedSpans.every((s) => s.parentElement === host)) {
      try {
        const frag = host.ownerDocument.createDocumentFragment();
        for (const s of orderedSpans) frag.appendChild(s);
        host.appendChild(frag);
      } catch {
        /* 拿不到 DOM（单测环境）→ 只重排数组，模型顺序仍与传入的 spans 对齐 */
      }
    }
    pairs = orderedPairs;
    selectionDebugLog('按阅读顺序重排文本层', { pairs: pairs.length });
  }

  if (!pairs || !pairs.length) return null;

  const chars: ZoteroChar[] = [];
  const infos: PairInfo[] = [];
  for (const pair of pairs) {
    // 非 strict：个别项几何残缺时给它一个退化盒子，**不要因为一个人废掉整页**（见 itemGeometry）
    const itemGeo = itemGeometry(pair.item, geo, pair.text.length, false);
    if (!itemGeo) return null;
    const boxes = charBoxesOf(itemGeo, pair.text);
    const lo = chars.length;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pair.text.length; i += 1) {
      const box = boxes[i];
      chars.push({
        c: pair.text[i],
        rect: [box[0], box[1], box[2], box[3]],
        inlineRect: [box[0], box[1], box[2], box[3]], // 先占位，buildLines 里回填成整行矩形
        rotation: itemGeo.rotation,
        ignorable: isIgnorable(pair.text[i]),
      });
      if (box[0] < minX) minX = box[0];
      if (box[1] < minY) minY = box[1];
      if (box[2] > maxX) maxX = box[2];
      if (box[3] > maxY) maxY = box[3];
    }
    const hi = chars.length - 1;
    let first = lo;
    let last = hi;
    for (let k = lo; k <= hi; k += 1) {
      if (!chars[k].ignorable) {
        first = k;
        break;
      }
    }
    for (let k = hi; k >= lo; k -= 1) {
      if (!chars[k].ignorable) {
        last = k;
        break;
      }
    }
    const box: Box = [minX, minY, maxX, maxY];
    infos.push({ item: pair.item, geo: itemGeo, lo, hi, first, last, box, flow: undefined });
  }
  if (!chars.length) return null;

  // ① 栏流（flowClass）：先定流，行分组要按流分开
  const normRegions = normalizeRegions(regions, geo);
  assignFlowClasses(chars, normRegions, geo);
  for (const info of infos) info.flow = chars[info.first]?.flowClass ?? chars[info.lo]?.flowClass;

  // ② 视觉行 → inlineRect
  const lines = buildLines(chars, infos);

  // ③ 行 / 段 / 空格标记
  assignBreakFlags(chars, infos, lines);

  return {
    pageIndex: Number.isFinite(pageIndex) ? pageIndex : 0,
    viewBox: [geo.x0, geo.y0, geo.x1, geo.y1],
    chars,
    scale: geo.scale,
    pageWidth: geo.pageWidth,
    pageHeight: geo.pageHeight,
    boundaryMap: null, // 懒建：第一次 resolveDomPosition 时再建
    regions: normRegions,
  };
}

// ---------------------------------------------------------------------------
// DOM ↔ 字符 对齐（懒建）+ SelectionModel
// ---------------------------------------------------------------------------

/** 建模型时留下的 DOM 引用（WeakMap：模型对象被回收就一起回收，也不会污染 PageCharModel 的字段） */
interface DomRefs {
  win: Window | null;
  pageEl: HTMLElement;
  textLayer: HTMLElement;
  /** 建模型时按 DOM 顺序传入的 span（懒建对齐表用） */
  spans: readonly HTMLElement[];
  /** 对齐表试建过没有：失败就不必每次都抛一遍异常 */
  boundaryTried: boolean;
}

const domRefsByModel = new WeakMap<PageCharModel, DomRefs>();

/**
 * 文本层里 **document order 的全部文字 span**。
 *
 * 规则必须与 pdf.js 建 span 的规则**同源**（这是配对的唯一依据）：
 * `TextLayer#processItems` 对每个 `str !== undefined` 的项都建 span（空串项也建，但没有文字节点）。
 * 所以这里取"排除 `.markedContent` wrapper 之后的所有 span"：
 *   · 空串项的 span 也留着 —— 它在下标上与 items 一一对应，是"同号即同项"的保证；
 *   · 它没有文字节点，对字符总数贡献 0，不影响 `domTotal === total`。
 *
 * 排除 `.markedContent`：它是 pdf.js 用来包标记内容的容器 span，里面才装着真正的文字 span；
 * 重排（`reorderTextLayer`）之后文字 span 会被提到容器下，wrapper 就空了，但**没重排过**的页面上
 * 它仍然存在且 `textContent` 非空 —— 不排除它会让 span 数比 items 多，整页模型建不起来。
 */
function collectTextSpans(textLayer: HTMLElement): HTMLElement[] {
  try {
    return Array.from(textLayer.querySelectorAll<HTMLElement>('span:not(.markedContent)'));
  } catch {
    return [];
  }
}

/**
 * 建字符模型。除了模型本体，还会把 DOM 引用记进 WeakMap 供 `SelectionModel` 懒建对齐表。
 *
 * ## 顺序（这一整套的命门，**只在这里做一次**）
 *
 * pdf.js 按**内容流顺序**建 span，而中文期刊的内容流经常"左右栏交替"，不等于阅读顺序；
 * 而跨栏硬禁止依赖"字符序号连续 = 版面上连续"。所以这里：
 *   ① 按阅读顺序算出置换（`selectionReadingOrder`，用"分区 → 栏 → 视觉行 → x"）；
 *   ② **按同一个置换重排 DOM**（span 绝对定位，改顺序不影响外观）；
 *   ③ **按同一个置换重排 items**（`E = perm(I)`）；
 *   ④ 一一配对建模型。
 *
 * ⚠️ ②只搬 DOM、③忘了搬 items，就是一手实测过的血案：DOM 变成阅读顺序、items 还是内容流顺序，
 * 于是"同号不同文"处处不匹配 → 12/13 页模型建不起来（`DOM 前 8 个 span` 与 `items 前 8 个 str`
 * 完全不同）。两者必须一起搬。
 *
 * `spans` 不传时自己从 `textLayer` 里取（按 DOM 顺序、排除 `.markedContent`、含空串 span）。
 */
export function buildSelectionModel(input: SelectionModelInput): PageCharModel | null {
  if (!input) return null;
  let domSpans = input.spans?.length ? [...input.spans] : collectTextSpans(input.textLayer);
  if (!domSpans.length) {
    selectionDebugLog('建模型失败：文本层里一个 span 都没有', { page: input.pageIndex + 1 });
    return null;
  }
  /**
   * **把文字 span 提到文本层容器下（拍平）** —— 必须在**采 span 之前**做。
   *
   * pdf.js 在带标记内容的页面上把文字 span 挂在 `.markedContent` wrapper 里，而 wrapper 是
   * `display: contents`（视觉透明）。不拍平的话：
   *   ① `.markedContent` 下的文字 span **选不出来**（`span:not(.markedContent)` 只匹配 wrapper 自身，
   *      所以采到的 span 数会比"str 已定义的文本项"少 → 整页模型 null）；
   *   ② 浏览器给的端点会落在 **wrapper 元素**上（现场实测：`anchor = SPAN.markedContent`），
   *      而不是具体的文字节点。
   * 拍平只是把 span 从 wrapper 提到容器下，绝对定位不受影响，**不动外观只改选择语义**。
   */
  try {
    const host = input.textLayer;
    const nested = input.textLayer.querySelectorAll<HTMLElement>('.markedContent span:not(.markedContent)');
    if (nested.length) {
      const frag = host.ownerDocument.createDocumentFragment();
      for (const s of [...nested]) frag.appendChild(s);
      host.appendChild(frag);
      domSpans = input.spans?.length ? [...nested, ...domSpans.filter((s) => s.parentElement === host)] : collectTextSpans(input.textLayer);
      // 拍平后重新按 DOM 顺序采一次（顺序必须与浏览器看到的一致）
      domSpans = [...host.querySelectorAll<HTMLElement>('span:not(.markedContent)')];
    }
  } catch {
    /* 拿不到 DOM（单测环境）→ 保持原样 */
  }

  /**
   * 文本项（`str !== undefined`）。**注意：个数不要求与 span 相等** ——
   * 真实窗口实测 pdf.js 渲染时会跳过一部分项（页 2：span 1780 vs 项 1849），
   * 以前在这里卡"数量不等就 null"，导致**每一页**模型都建不出来、夹取从未运行。
   * 配对交给 `pairSpansWithItems` 按文字顺序贪心对齐（有文字证据，不依赖个数）。
   */
  const definedItems: PdfTextItemLike[] = [];
  for (const raw of input.items ?? []) {
    const it = asTextItem(raw);
    if (it && it.str !== undefined) definedItems.push(it);
  }

  /**
   * ## 顺序：**唯一权威在这里**
   *
   * pdf.js 按内容流顺序建 span，中文期刊的内容流常常"左右栏交替"，不等于阅读顺序；
   * 而跨栏硬禁止用的是"锚点流 + **序号连续**"这个判据，顺序错了收窄就会切在版面上不相邻的位置。
   *
   * 所以这里算一次阅读顺序置换，交给 `charModelFromItems` **同时**用于：
   *   ① 重排 DOM span；② 重排文本项；③ 按新顺序打行/段/空格标记。
   * 三者必须用**同一个置换**（标记是"相邻两项"的函数，顺序换了就得重打）。
   *
   * ⚠️ 历史教训（两个都真实发生过，别再犯）：
   *   · 只在 `PdfViewer` 里重排 DOM、不重排文本项 → 模型建不起来（13 页里 12 页 null）；
   *   · `reorderTextLayer` 与模型内部各排一次、两套算法不一致 → DOM 顺序 ≠ 模型顺序，
   *     夹取按模型算出的端点落到**页眉**上（真实窗口实测：栏内纵向拖，选区从「第４期…」开始）。
   */
  const model = charModelFromItems(
    definedItems,
    domSpans,
    input.viewport,
    input.viewBox,
    input.regions,
    input.pageIndex,
  );
  if (!model) {
    selectionDebugLog('建模型失败：charModelFromItems 返回 null（几何 / 文字配对）', { page: input.pageIndex + 1 });
    return null;
  }
  if (input.pageEl && input.textLayer) {
    let win: Window | null = null;
    try {
      win = input.pageEl.ownerDocument?.defaultView ?? null;
    } catch {
      win = null;
    }
    domRefsByModel.set(model, {
      win,
      pageEl: input.pageEl,
      textLayer: input.textLayer,
      // 建模型时用的 span（已经按阅读顺序排过）—— 对齐表要用它算"第 i 个字符 ↔ 第 i 个文字节点"
      spans: domSpans,
      boundaryTried: false,
    });
  }
  return model;
}

/** 点 (x, y) 最近的字符序号（先按 rectsDist，再按中心距，最后按序号，保证确定性） */
function nearestCharIndex(chars: readonly ZoteroChar[], x: number, y: number): number {
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  let bestC = Number.POSITIVE_INFINITY;
  const point: Box = [x, y, x, y];
  for (let i = 0; i < chars.length; i += 1) {
    const r = chars[i].rect;
    const d = rectsDist(point, r);
    const dx = (r[0] + r[2]) / 2 - x;
    const dy = (r[1] + r[3]) / 2 - y;
    const c = dx * dx + dy * dy;
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && c < bestC)) {
      bestD = d;
      bestC = c;
      best = i;
    }
  }
  return best;
}

/** 中心落在某个矩形内的字符序号（按模型顺序） */
function charIndicesInsideRect(chars: readonly ZoteroChar[], rect: Box, pad = 1.5): number[] {
  const out: number[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const r = chars[i].rect;
    const cx = (r[0] + r[2]) / 2;
    const cy = (r[1] + r[3]) / 2;
    if (cx >= rect[0] - pad && cx <= rect[2] + pad && cy >= rect[1] - pad && cy <= rect[3] + pad) {
      out.push(i);
    }
  }
  return out;
}

/** 塌陷 Range 的插入点矩形（最准的"光标位置"）；拿不到返回 null */
function caretRectOf(node: Node, offset: number): DOMRect | null {
  try {
    const doc = node.ownerDocument;
    if (!doc || typeof doc.createRange !== 'function') return null;
    const range = doc.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    return range.getBoundingClientRect();
  } catch {
    return null;
  }
}

/**
 * 一页字符模型的操作入口：DOM 端点 ↔ 字符序号、点 → 字符、栏流、栏流夹取区间。
 *
 * 说明：`model` 可以是任意来源的 `PageCharModel`（哪怕是从缓存里反序列化出来的）。
 * 只有当它是 `buildSelectionModel` 产出的那个对象时，才拿得到 DOM 引用去懒建 Zotero 的
 * `TextLayerBoundaryMap`；拿不到就退回几何口径（node 的 rect → 最近字符 + affinity）。
 */
export class SelectionModel {
  private readonly _model: PageCharModel;

  constructor(model: PageCharModel) {
    this._model = model;
  }

  get model(): PageCharModel {
    return this._model;
  }

  /**
   * DOM 端点 → 字符序号。
   * 先走 Zotero 的 `TextLayerBoundaryMap`（懒建、缓存回 `model.boundaryMap`）；
   * 建不出来 / 映射不出来 → 几何兜底：用端点的 rect（优先塌陷 Range 的插入点）取最近字符，
   * `affinity` 决定取这个字之前（'start'）还是之后（'end'）。
   */
  resolveDomPosition(node: Node, offset: number, affinity: 'start' | 'end'): TextPosition | null {
    const chars = this._model.chars;
    if (!node || !chars.length) return null;
    /**
     * **先拦"端点在文本层容器（或它的祖先）上"**（浏览器最常见的畸形端点）：
     * 指针落在字间空隙 / 行末空白时，Chromium 给的是"容器 + 子节点序号"，不是 span 里的文字位置。
     * 这类端点必须按**语义**解析：起点 → 容器第一个字；终点 → 容器最后一个字。
     * 走对齐表会按"容器里第 N 个文字节点"折算，得到一个和指针位置无关的偏移
     * （真实窗口实测：栏 1 里纵向拖，起点被解析到**页首**，于是选中整段页眉 —— 用户报的"莫名从页首开始选"）。
     */
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    const refs = domRefsByModel.get(this._model);
    const layerEl = refs?.textLayer ?? null;
    const containerLike = !!el && (el === layerEl || (!!layerEl && el.contains(layerEl)));
    if (containerLike) {
      selectionDebugLog('端点落在文本层容器上 → 按语义取首/末字', { page: this._model.pageIndex + 1, affinity, chars: chars.length });
      return { pageIndex: this._model.pageIndex, offset: affinity === 'end' ? chars.length : 0 };
    }
    const map = this.ensureBoundaryMap();
    if (map) {
      try {
        const mapped = map.getReaderOffset(node, offset, affinity);
        if (typeof mapped === 'number' && Number.isFinite(mapped)) {
          return { pageIndex: this._model.pageIndex, offset: clamp(Math.round(mapped), 0, chars.length) };
        }
      } catch {
        /* 映射表内部出错 → 几何兜底 */
      }
    }
    return this.geometricPosition(node, offset, affinity);
  }

  /** 页面内 CSS 像素坐标 → 最近的字符序号（按下点解析锚点用） */
  positionAtPoint(x: number, y: number): TextPosition | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const chars = this._model.chars;
    if (!chars.length) return null;
    const idx = nearestCharIndex(chars, x, y);
    if (idx < 0) return null;
    return { pageIndex: this._model.pageIndex, offset: idx };
  }

  /** 锚点字符所在"栏流"的 id（flowClass）；拿不到返回 null */
  flowClassAt(offset: number): string | null {
    const chars = this._model.chars;
    if (!chars.length) return null;
    const i = clamp(Math.round(Number.isFinite(offset) ? offset : 0), 0, chars.length);
    if (i < chars.length && chars[i].flowClass) return chars[i].flowClass ?? null;
    if (i > 0 && chars[i - 1].flowClass) return chars[i - 1].flowClass ?? null;
    return null;
  }

  /**
   * 把 chars 收窄成"锚点栏流"内的连续字符（跨栏硬禁止的**唯一判据**）：返回该栏流的**极大连续区间**
   * `[lo, hi]`（含端点）—— 包含锚点、区间内每个字符的 flowClass 都等于锚点的、且再往外一个字就不是了。
   * 调用方把原生选区的头端夹进这个区间即可（单栏页会返回整段，等于不夹）。
   *
   * 纯函数式：只读 `chars[i].flowClass`，不碰 DOM 状态，可以在 node 里直接单测。
   * `headOffset` 只在锚点这一端拿不到 flowClass 时兜底（取头端的栏流）。
   */
  anchorRunRange(anchorOffset: number, headOffset: number): { lo: number; hi: number } {
    const chars = this._model.chars;
    const n = chars.length;
    if (!n) return { lo: 0, hi: 0 };
    const anchor = clamp(Math.round(Number.isFinite(anchorOffset) ? anchorOffset : 0), 0, n - 1);
    const head = clamp(Math.round(Number.isFinite(headOffset) ? headOffset : 0), 0, n - 1);
    const flow = chars[anchor].flowClass ?? chars[head].flowClass;
    if (flow === undefined) return { lo: 0, hi: n - 1 }; // 没有栏流信息 → 不夹（整段）
    let lo = anchor;
    let hi = anchor;
    while (lo > 0 && chars[lo - 1].flowClass === flow) lo -= 1;
    while (hi < n - 1 && chars[hi + 1].flowClass === flow) hi += 1;
    return { lo, hi };
  }

  /** 懒建 Zotero 的 DOM↔字符对齐表；建不出来就一直返回 null（由几何兜底接管） */
  private ensureBoundaryMap(): TextLayerBoundaryMapLike | null {
    const model = this._model;
    if (model.boundaryMap) return model.boundaryMap;
    const refs = domRefsByModel.get(model);
    if (!refs || refs.boundaryTried || !model.chars.length) return null;
    const win = refs.win;
    if (!win) return null;
    refs.boundaryTried = true;
    const candidates: HTMLElement[][] = [collectTextSpans(refs.textLayer), [...refs.spans]];
    for (const spans of candidates) {
      if (!spans.length || spans.length !== refs.spans.length) continue;
      try {
        const map: TextLayerBoundaryMapLike = new TextLayerBoundaryMap(win, refs.textLayer, spans, model.chars);
        if (map) {
          model.boundaryMap = map;
          return map;
        }
      } catch {
        /* 建不出来 → 几何兜底 */
      }
    }
    return null;
  }

  /**
   * 几何兜底：DOM 端点 → 字符序号。
   * 端点位置优先取"塌陷 Range 的插入点"（最接近光标的真实位置），拿不到才退回 node 自身的 rect 中心。
   * 若端点是文本节点，则用 `offset / 文本长度` 在"落在这个 node 矩形里的那些字符"上按比例取 ——
   * 这比单纯"最近字符"更贴 caret；元素节点（offset 是子节点序号）没有这个信息，就用最近字符 + affinity。
   */
  private geometricPosition(node: Node, offset: number, affinity: 'start' | 'end'): TextPosition | null {
    const refs = domRefsByModel.get(this._model);
    if (!refs) return null;
    const chars = this._model.chars;
    const pageRect = refs.pageEl.getBoundingClientRect();
    const isText = node.nodeType === 3; // Node.TEXT_NODE
    const isElement = node.nodeType === 1; // Node.ELEMENT_NODE
    const el = isText ? node.parentElement : isElement ? (node as Element) : null;
    const elRect = el ? el.getBoundingClientRect() : null;

    let px = NaN;
    let py = NaN;
    const caret = caretRectOf(node, offset);
    if (
      caret &&
      Number.isFinite(caret.left) &&
      (caret.width > 0 || caret.height > 0 || caret.left !== 0 || caret.top !== 0)
    ) {
      px = caret.left - pageRect.left;
      py = caret.top - pageRect.top + (caret.height || 0) / 2;
    } else if (elRect && (elRect.width > 0 || elRect.height > 0)) {
      px = elRect.left - pageRect.left + elRect.width / 2;
      py = elRect.top - pageRect.top + elRect.height / 2;
    } else {
      return null;
    }
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;

    const text = isText ? (node as Text).data : null;
    if (text && elRect && elRect.width > 0 && elRect.height > 0) {
      const run: Box = [
        elRect.left - pageRect.left,
        elRect.top - pageRect.top,
        elRect.right - pageRect.left,
        elRect.bottom - pageRect.top,
      ];
      const inside = charIndicesInsideRect(chars, run);
      if (inside.length) {
        const k = Math.round((clamp(offset, 0, text.length) / Math.max(1, text.length)) * inside.length);
        if (k >= inside.length) return { pageIndex: this._model.pageIndex, offset: inside[inside.length - 1] + 1 };
        return { pageIndex: this._model.pageIndex, offset: inside[k] };
      }
    }

    const near = nearestCharIndex(chars, px, py);
    if (near < 0) return null;
    // affinity：起点取这个字**之前**的位置，终点取**之后**的位置（与 Zotero 一致）
    return { pageIndex: this._model.pageIndex, offset: affinity === 'end' ? near + 1 : near };
  }
}

/**
 * 划词内核的**冻结接口**（Zotero 式字符模型划词）。
 *
 * 为什么单开一个只有类型/工具函数的文件：
 *   内核由三块拼成 —— ①Zotero 算法移植（`zoteroSelection.ts`）、②字符模型（`selectionModel.ts`）、
 *   ③阅读器接线（`PdfViewer.tsx`）。三块由不同的人并行写，只允许通过本文件的类型通信。
 *   本文件**不得** import 上面三块里的任何一块，也不得有副作用（纯类型 + 小工具）。
 *
 * 坐标系约定（全模块统一，别再引入第二套）：
 *   - 模型里的 `rect / inlineRect` 一律是 **CSS 像素**，相对**页面元素**（`.rd-pdf-page`）左上角；
 *   - `scale` 是 pdf.js 的 `viewport.scale`，用来把 PDF 用户空间换算成 CSS 像素；
 *   - 判断"点/字在不在某个 x 区间"时，区间用**比例**（0~1，乘 pageWidth）：
 *     这样缩放、手势 transform 都不会让夹取错位（栏带就是这么存的）。
 */

/** Zotero `selection.js` 的 `chars[i]`：一个字符（或一个不可见标记）的全部信息 */
export interface ZoteroChar {
  /** 字符本身（`ignorable` 为真时是零宽/连字符之类的占位） */
  c: string;
  /** 单元格矩形 `[x1, y1, x2, y2]`（CSS 像素，相对页面元素左上角） */
  rect: [number, number, number, number];
  /** 该行（只有这一个字符占的那一行）的矩形，用于按行合并出选区矩形 */
  inlineRect: [number, number, number, number];
  /** 0 = 横排；90 / 180 / 270 = 旋转（pdf.js 的文本项旋转角） */
  rotation: number;
  /** 这一行结束了（下一个字符换到了新的一行）→ `getRectsFromChars` 据此切行 */
  lineBreakAfter?: boolean;
  /** 段末（`getTextFromChars` 会补一个空格） */
  paragraphBreakAfter?: boolean;
  /** 字后有一个视觉空格（`getTextFromChars` 会补空格） */
  spaceAfter?: boolean;
  /** 可忽略字符（软连字符等）：不进 text、不占归一化单位 */
  ignorable?: boolean;
  /**
   * 语义流分类（Zotero `selection-flow.mjs` 的 `flowClass`）。
   * 本产品的用途是**栏流**：同一栏的文字给同一个 id，栏缝两侧必须是不同 id。
   * 单栏页给同一个 id（`'body'`）。
   */
  flowClass?: string;
}

/** 一页的字符模型 */
export interface PageCharModel {
  /** 页面序号（0 起，和 `.rd-pdf-page` 的 `data-page-index - 1` 一致） */
  pageIndex: number;
  viewBox: [number, number, number, number];
  chars: ZoteroChar[];
  /** pdf.js 的 viewport.scale：模型→CSS 像素已乘过，这个只用来换算比例 */
  scale: number;
  pageWidth: number;
  pageHeight: number;
  /** Zotero 的 DOM↔字符 对齐映射（懒建） */
  boundaryMap: TextLayerBoundaryMapLike | null;
  /** 结构化文本项算出的栏带（按 y 分区），给"栏流夹取"用；单栏页只有一条 */
  regions: ModelRegion[];
  /**
   * 这一页的页面元素（`.rd-pdf-page`）。
   * 放在模型里是为了让划词内核不需要再传一遍"页号 → 元素"的映射；
   * 它只用于**坐标换算**（模型坐标是相对它的），不参与任何判据。
   */
  pageEl?: HTMLElement | null;
}

/** 一个纵向分区里的栏带（比例坐标系，0~1，与 `columnBands.ts` 的 RegionRatio 同构） */
export interface ModelRegion {
  top: number;
  bottom: number;
  /** 区内每条栏的 x 区间（比例，按页宽）；单栏页 / 通栏区只有一条 */
  bands: { start: number; end: number }[];
  /** 通栏区（区内就一条整幅栏带） */
  full: boolean;
}

/** 一个选择端点：页面 + 字符序号（Zotero 的 `{ pageIndex, offset }`） */
export interface TextPosition {
  pageIndex: number;
  /** 0 ~ chars.length（末尾 = 光标在最后一个字之后） */
  offset: number;
}

/** 一个 DOM 端点（`window.getSelection()` 的 anchor/focus）→ 字符模型的映射能力 */
export interface TextLayerBoundaryMapLike {
  /**
   * DOM 端点 → 字符序号。
   * @param affinity 端点语义：起点取"更靠前"的字符，终点取"更靠后"的字符（与 Zotero 一致）
   * @returns 映射不出来时返回 null（调用方会退回几何兜底）
   */
  getReaderOffset(node: Node, offset: number, affinity: 'start' | 'end'): number | null;
}

/** 一次选区的计算输入（几何兜底路径用得上 rects） */
export interface SelectionRangeInput {
  anchor: TextPosition;
  head: TextPosition;
}

/** 一次选区的计算结果（Zotero `selection.js` 的 selectionRange） */
export interface ResolvedSelectionRange {
  position: {
    pageIndex: number;
    /** 选区矩形（CSS 像素，相对页面元素左上角），已按行合并 */
    rects: [number, number, number, number][];
  };
  anchorOffset: number;
  headOffset: number;
  collapsed?: boolean;
  /** 只在这一段是该页选区的锚点/头时置位（跨页时两端分属不同 range） */
  anchor?: boolean;
  head?: boolean;
  text: string;
}

/**
 * 内核内部用的 range 形状（`zoteroSelection.ts` 导出的 `ResolvedRangeLike` 与它结构一致）。
 *
 * 为什么在契约文件里单独写一条：内核只依赖"有 position.rects / anchorOffset / headOffset / collapsed"
 * 这几个字段，不需要把 Zotero 移植层的完整类型拖进来 —— 两边的类型必须能互相赋值，
 * 这里用结构类型把这件事钉死（改坏了 `zoteroSelection.ts` 的返回形状，tsc 会立刻报错）。
 */
export interface ResolvedRangeLike {
  position: { pageIndex: number; rects: [number, number, number, number][] };
  anchorOffset: number;
  headOffset: number;
  collapsed?: boolean;
  anchor?: boolean;
  head?: boolean;
  text: string;
}

/** 一个 DOM 端点（`window.getSelection()` 给的那种） */
export interface NodePosition {
  node: Node;
  offset: number;
}

/** 一页上的 DOM 端点对：都落在同一页文本层里 */
export interface DomSelectionEndpoint {
  pageIndex: number;
  /** pdf.js viewport.scale（模型坐标↔比例换算；跨页时各页可能不同，所以放在每一页上） */
  scale: number;
  start: NodePosition;
  end: NodePosition;
  /** 该页的页面元素（`.rd-pdf-page`），用来把模型坐标换算成客户端坐标 */
  pageEl: HTMLElement;
}

/** 一次原生选区的原始输入（跨页时 endpoints 有多项，按页号升序） */
export interface SelSnapshotInput {
  /** `window.getSelection()` 的锚点是不是 range 的起点（决定端点按 start/end 语义解析） */
  anchorIsStart: boolean;
  endpoints: DomSelectionEndpoint[];
}

/** 内核算完后交给产品的选区结果 */
export interface SelSnapshot {
  /** 主页面（锚点页）序号，0 起 */
  pageIndex: number;
  /** 主页面元素 */
  pageEl: HTMLElement;
  /** 选区文字（来自字符模型，不是 `selection.toString()`） */
  text: string;
  /** 每页的选区矩形（CSS 像素，相对该页页面元素左上角），已按行合并 */
  rectsByPage: { pageIndex: number; pageEl: HTMLElement; rects: Rect[] }[];
  /** 第一行的**客户端**矩形：工具条定位用 */
  clientRect: Rect | null;
}

/**
 * 划词内核：读取原生选区 → 用字符模型算合法选区 → 写回 DOM。
 *
 * 为什么接口里只有 apply/clear 两件事：Zotero 的做法是"浏览器负责拖动、模型负责定义选区"，
 * 所以内核**不需要**参与 mousemove；它只在一个原生选区出现之后把它规范化一次。
 * 任何"拖动中逐帧改写选区"的实现都会和浏览器打架（这个仓库已经踩过：快拖时出现 1~3 字碎选区）。
 */
export interface SelectionKernel {
  /**
   * 规范化一个原生选区（同一栏 / 同一个流）。
   * @returns 规范化后的快照；不需要改动时返回 null（调用方用 `read()` 拿原样结果）
   */
  apply(input: SelSnapshotInput): SelSnapshot | null;
  /** 只读地算一遍（不改写 DOM）：选区本来就合法时用它拿结果 */
  read(input: SelSnapshotInput): SelSnapshot | null;
  /** 当前选区是否由本内核拥有（诊断用） */
  ownsSelection(): boolean;
  /** 清掉内核的"上一次结果"（选区被清空、换页、重建文本层时调用） */
  clear(): void;
  /** DOM 变了（文本层重建/重排/缩放）→ 丢掉那一页的缓存 */
  invalidate(pageIndex?: number): void;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 两个矩形的最近距离（Zotero `selection.js::rectsDist` 原样移植，含它那套"先判方位再算距离"的分支）。
 * 放在这里是因为内核与模型两块都要用，而它必须**与 Zotero 完全一致** —— 手感就来自这里。
 */
export function rectsDist(
  [ax1, ay1, ax2, ay2]: readonly [number, number, number, number],
  [bx1, by1, bx2, by2]: readonly [number, number, number, number],
): number {
  const left = bx2 < ax1;
  const right = ax2 < bx1;
  const bottom = by2 < ay1;
  const top = ay2 < by1;

  if (top && left) return Math.hypot(ax1 - bx2, ay2 - by1);
  if (left && bottom) return Math.hypot(ax1 - bx2, ay1 - by2);
  if (bottom && right) return Math.hypot(ax2 - bx1, ay1 - by2);
  if (right && top) return Math.hypot(ax2 - bx1, ay2 - by1);
  if (left) return ax1 - bx2;
  if (right) return bx1 - ax2;
  if (bottom) return ay1 - by2;
  if (top) return by1 - ay2;
  return 0;
}

/** 两个矩形是否相交（Zotero `selection.js::quickIntersectRect`） */
export function quickIntersectRect(
  r1: readonly [number, number, number, number],
  r2: readonly [number, number, number, number],
): boolean {
  return !(r2[0] > r1[2] || r2[2] < r1[0] || r2[1] > r1[3] || r2[3] < r1[1]);
}

/** 退化成一个点（中心）的矩形（Zotero `selection.js::getCenterRect`） */
export function getCenterRect(r: readonly [number, number, number, number]): [number, number, number, number] {
  const cx = r[0] + (r[2] - r[0]) / 2;
  const cy = r[1] + (r[3] - r[1]) / 2;
  return [cx, cy, cx, cy];
}

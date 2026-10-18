/**
 * Zotero 划词算法移植（二）：**字符模型上的选区计算**。
 *
 * 逐字对应本机参考源码 `D:\dsh\_zot\selection.js`（Zotero reader 的真实划词实现）。
 * 每个函数上方都标了"对应 Zotero 的哪个函数"；允许的改动只有三类：
 *   1. ESM → TypeScript 类型标注；
 *   2. `pdfPages[i].chars` → 入参 `pages[i].chars`、`win` 显式传入（上游从 view/iframe 里取）；
 *   3. 注释里逐条写明的产品化改动（只有一条：跨流时收窄到锚点流，见 `selectionFlow.ts::isolateCharsToAnchorFlow`）。
 *
 * 为什么"照抄"比"自己写"好（写给下一个接手的人）：
 *   划词的手感全在这些细节里 —— `getRangeBySelection` 里"点在字符中线右侧就 +1"的取舍、
 *   `getRange` 用 `[anchorOffset, headOffset)` 半开区间、`getRectsFromChars` 按 `lineBreakAfter`
 *   切行、`getRangeByHighlight` 里"首尾矩形各取一个字符再 headOffset+1"、几何兜底里
 *   `rectsDist` 的方位分支……这些都不是能"重新设计"的东西，只能照抄。
 *
 * 上游有而本文件**故意不移植**的部分（都写在对应位置附近）：
 *   - `getSortIndex` / `formatSortIndex` / `getSortIndexRect`：给标注排序用的元信息，
 *     冻结的 `ResolvedSelectionRange` 里没有这个字段，本仓库也没有消费者（`grep sortIndex` 为空）；
 *   - `getReversedSelectionRanges`：上游给"翻转选区方向"用的辅助函数，本产品没有调用方；
 *   - `getRectRotationOnText`：取矩形内出现次数最多的 rotation，标注旋转用，本产品没有调用方；
 *   - `setTextLayerSelection`：写回 DOM 的那一步，本文件按冻结签名拆成
 *     `getNodeOffset` + `buildNativeRange`（构造 Range），写回交给接线方。
 */
import {
  getCenterRect,
  quickIntersectRect,
  rectsDist,
} from './selectionTypes';
import type {
  PageCharModel,
  ResolvedSelectionRange,
  TextPosition,
  ZoteroChar,
} from './selectionTypes';
import {
  isolateCharsToAnchorFlow,
  splitContinuousCharRuns,
} from './selectionFlow';
import type { FlowChar } from './selectionFlow';

// ── 再导出：接线方从本文件就能拿到全部所需（`TextLayerBoundaryMap` 定义在 selectionFlow.ts，
//    因为它要用那里的 alignTextUnits / buildReaderUnitMap；在这里再导出一次，两条 import 路径都可用）。
export { TextLayerBoundaryMap } from './selectionFlow';
export type { FlowChar, MappedSelectionSource } from './selectionFlow';
/** 兼容接线方早期用过的名字：与 `selectionTypes.ts::ResolvedRangeLike` 是同一个类型 */
export type { ResolvedRangeLike } from './selectionTypes';

/**
 * 一次"字符模型上的原始 range"（对应 Zotero `selection.js::getRange` 的返回值）。
 * `rects` 是**未挂页号**的纯矩形；`extractRange*` 会把它包成 `position.rects`。
 */
export interface RawRange {
  collapsed?: boolean;
  anchorOffset: number;
  headOffset: number;
  rects: [number, number, number, number][];
  text: string;
}

/** `Node.TEXT_NODE` 的数值（上游用 iframe 窗口上的 `Node.TEXT_NODE`；数值恒为 3） */
const TEXT_NODE = 3;

/* ================================================================== *
 * 一、几何：Zotero `selection.js` 的几个小工具
 * ================================================================== */

/**
 * 对应 Zotero `selection.js::isRTL` —— 上游就是个桩函数：永远返回 false（RTL 分支被关掉了）。
 * 照抄（`getRangeBySelection` 里 `rtl && (...)` 那半边因此永远不成立）。
 */
function isRTL(_c: string): boolean {
  return false;
}

/**
 * 对应 Zotero `selection.js::isDash` —— 上游定义了但**从未调用**（`selection.js:76-78`）。
 * 保留在此只为与上游一一对应，本产品也没有用它的地方。
 */
function isDash(): boolean {
  return true;
}

/**
 * 对应 Zotero `selection.js::getClosestOffset`。
 *
 * 线性扫一遍所有字符，取和 `rect` 距离最近的那个字符的序号。
 * 注意：**只比较距离，严格小于才更新**（`distance < dist`）—— 平局时保留**更靠前**的字符，
 * 这个取舍决定了"点在两个字之间时选哪个"，不能改成 `<=`。
 */
export function getClosestOffset(chars: ZoteroChar[], rect: [number, number, number, number]): number {
  let dist = Infinity;
  let idx = 0;
  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i];
    let distance = rectsDist(ch.rect, rect);
    if (distance < dist) {
      dist = distance;
      idx = i;
    }
  }
  return idx;
}

/* ================================================================== *
 * 二、端点 → range：Zotero `selection.js::getRangeBySelection`
 * ================================================================== */

/**
 * 对应 Zotero `selection.js::getRangeBySelection`（上游是模块私有函数，参数打包成一个对象；
 * 这里同样是私有的，只是把参数摊成位置参数，函数体逐字对齐）。
 *
 * `anchor` / `head` **允许 undefined**：跨页选择的**中间页**就是两端都缺省，
 * 这时 `Number.isInteger(undefined)` / `Array.isArray(undefined)` 都为假，
 * 于是保留下面的默认值 —— 正向 `anchorOffset = 0 & headOffset = chars.length`（整页选中），
 * 反向（`reverse`）调过来。`extractRange` 靠的正是这一点。
 *
 * `anchor` / `head` 各自可以是：
 *   - **字符序号**（整数，允许 0 ~ chars.length —— 末尾表示"光标在最后一个字之后"）；
 *   - **点** `[x, y]`：先 `getClosestOffset` 找最近的字符，再按"落点在字符中线哪一侧"决定要不要 +1。
 * 那个 +1 是划词手感的核心：横排文字点在字符**右半边** → 光标算在这个字**之后**（+1）；
 * 旋转文字按各自方向判（90 看 y 下半、180 看 x 左半边、270 看 y 上半）。
 *
 * `reverse`（`anchor.pageIndex > head.pageIndex`，即用户从后往前跨页拖）只影响
 * **中间页**的默认端点：正向时中间页整页选中（`[0, chars.length)`），反向时反过来。
 *
 * 注意上游的 `rtl` 分支永远不成立（`isRTL` 恒 false），照抄保留。
 */
function getRangeBySelection(
  chars: ZoteroChar[],
  anchor: number | [number, number] | undefined,
  head: number | [number, number] | undefined,
  reverse?: boolean,
): RawRange | null {
  // Note: Offsets can be between 0 and chars.length (the cursor can after the last char)
  if (!chars.length) {
    return null;
  }
  let anchorOffset = reverse ? chars.length : 0;
  let headOffset = reverse ? 0 : chars.length;
  let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
  if (Number.isInteger(anchor)) {
    anchorOffset = anchor as number;
    anchorOffset = anchorOffset < 0 ? 0 : anchorOffset;
    anchorOffset = anchorOffset > chars.length ? chars.length : anchorOffset;
  }
  else if (Array.isArray(anchor)) {
    [x1, y1] = anchor;
    anchorOffset = getClosestOffset(chars, [x1, y1, x1, y1]);
  }
  if (Number.isInteger(head)) {
    headOffset = head as number;
    headOffset = headOffset < 0 ? 0 : headOffset;
    headOffset = headOffset > chars.length ? chars.length : headOffset;
  }
  else if (Array.isArray(head)) {
    [x2, y2] = head;
    headOffset = getClosestOffset(chars, [x2, y2, x2, y2]);
  }
  if (Array.isArray(anchor)) {
    let { rotation, rect, c } = chars[anchorOffset];
    let rtl = isRTL(c);
    if (rtl && (
        !rotation && x1 < rect[0] + (rect[2] - rect[0]) / 2
      )
      || !rtl && (
        !rotation && x1 > rect[0] + (rect[2] - rect[0]) / 2
        || rotation === 90 && y1 > rect[1] + (rect[3] - rect[1]) / 2
        || rotation === 180 && x1 < rect[0] + (rect[2] - rect[0]) / 2
        || rotation === 270 && y1 < rect[1] + (rect[3] - rect[1]) / 2
      )
    ) {
      anchorOffset++;
    }
  }
  if (Array.isArray(head)) {
    let { rotation, rect, c } = chars[headOffset];
    let rtl = isRTL(c);
    if (rtl && (
        !rotation && x2 < rect[0] + (rect[2] - rect[0]) / 2
      )
      || !rtl && (
        !rotation && x2 > rect[0] + (rect[2] - rect[0]) / 2
        || rotation === 90 && y2 > rect[1] + (rect[3] - rect[1]) / 2
        || rotation === 180 && x2 < rect[0] + (rect[2] - rect[0]) / 2
        || rotation === 270 && y2 < rect[1] + (rect[3] - rect[1]) / 2
      )
    ) {
      headOffset++;
    }
  }

  return getRange(chars, anchorOffset, headOffset);
}

/**
 * **冻结签名的公开形态**：`getRangeByPosition(chars, anchor, head, reverse?)`。
 * 就是上游 `getRangeBySelection` 的转发（上游把参数打包成对象，这里已经摊平）；
 * 公开签名里不含 `undefined`（契约要求），而跨页中间页那种"两端缺省"由 `extractRange` 走私有版本。
 */
export function getRangeByPosition(
  chars: ZoteroChar[],
  anchor: number | [number, number],
  head: number | [number, number],
  reverse?: boolean,
): RawRange | null {
  return getRangeBySelection(chars, anchor, head, reverse);
}

/**
 * 对应 Zotero `selection.js::getRangeByHighlight`。
 *
 * 输入是"一串矩形"（典型来源：用户在别处高亮/拖出的一片区域，或几何兜底量到的 DOM 行矩形）：
 *   - `anchorOffset`：**第一个**矩形中心命中的第一个字符；
 *   - `headOffset`：**最后一个**矩形中心命中的最后一个字符，再 **+1**（半开区间 → 那个字被选中）。
 * 一个都没命中时 `anchorOffset` 保持 `Infinity` → 返回 null（上游用 `Infinity > headOffset` 判掉）。
 *
 * 返回值上额外写了上游的旧字段 `offset/from/to`（`selection.js:170-172`），照抄保留：
 * 本产品的消费者只读 `anchorOffset/headOffset`，但"保留上游字段"能避免移植失真。
 *
 * 【健壮性守卫，非算法改动】上游的 `rects` 必非空（调用方按页传入）；这里 `rects` 为空时直接
 * 返回 null，否则会在 `rects[0]` 抛异常。
 */
interface HighlightRange extends RawRange {
  offset?: number;
  from?: number;
  to?: number;
}

function getRangeByHighlight(
  chars: ZoteroChar[],
  rects: [number, number, number, number][],
): HighlightRange | null {
  if (!chars.length) {
    return null;
  }
  if (!rects.length) {
    return null;
  }
  let anchorOffset = Infinity;
  for (let i = 0; i < chars.length; i++) {
    let char = chars[i];
    if (quickIntersectRect(getCenterRect(char.rect), rects[0])) {
      anchorOffset = i;
      break;
    }
  }
  let headOffset = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    let char = chars[i];
    if (quickIntersectRect(getCenterRect(char.rect), rects[rects.length - 1])) {
      headOffset = i;
      break;
    }
  }

  headOffset++;

  if (anchorOffset > headOffset) {
    return null;
  }

  let range: HighlightRange = getRange(chars, anchorOffset, headOffset);
  range.offset = range.anchorOffset;
  range.from = range.anchorOffset;
  range.to = range.headOffset;
  return range;
}

/**
 * 对应 Zotero `selection.js::getLineSelectionRect`（按行给一个矩形）。
 * 本产品的选区矩形走 `getRectsFromChars`（按 `inlineRect` 合并），所以这个函数暂时没有消费者；
 * 保留移植是为了"行矩形"这条路径与上游一一对应（旋转行的口径不一样，见下）。
 */
function getLineSelectionRect(
  line: { rect: [number, number, number, number] },
  charFrom: ZoteroChar,
  charTo: ZoteroChar,
): [number, number, number, number] {
  if (charFrom.rotation) {
    return [
      line.rect[0],
      Math.min(charFrom.rect[1], charTo.rect[1]),
      line.rect[2],
      Math.max(charFrom.rect[3], charTo.rect[3])
    ];
  }
  else {
    return [
      Math.min(charFrom.rect[0], charTo.rect[0]),
      line.rect[1],
      Math.max(charFrom.rect[2], charTo.rect[2]),
      line.rect[3]
    ];
  }
}

/* ================================================================== *
 * 三、字符 → 矩形 / 文字：Zotero `selection.js::getRectsFromChars` / `getTextFromChars`
 * ================================================================== */

/**
 * 对应 Zotero `selection.js::getRectsFromChars`。
 *
 * 把一段字符按行合并成矩形：累加 `inlineRect`（**不是** `rect`），遇到 `lineBreakAfter` 就
 * 收一条矩形、开下一条。最后一段没有 `lineBreakAfter` 也要收（`if (currentLineRect) push`）。
 *
 * 这是"选区矩形从模型算、不读 DOM `getClientRects()`"的关键一步 ——
 * pdf.js 文本层里那个整层大小的 `.endOfContent` 因此再也影响不到选区矩形。
 */
export function getRectsFromChars(chars: ZoteroChar[]): [number, number, number, number][] {
  let lineRects: [number, number, number, number][] = [];
  let currentLineRect: [number, number, number, number] | null = null;
  for (let char of chars) {
    if (!currentLineRect) {
      currentLineRect = [...char.inlineRect];
    }
    currentLineRect = [
      Math.min(currentLineRect[0], char.inlineRect[0]),
      Math.min(currentLineRect[1], char.inlineRect[1]),
      Math.max(currentLineRect[2], char.inlineRect[2]),
      Math.max(currentLineRect[3], char.inlineRect[3])
    ];
    if (char.lineBreakAfter) {
      lineRects.push(currentLineRect);
      currentLineRect = null;
    }
  }
  if (currentLineRect) {
    lineRects.push(currentLineRect);
  }
  return lineRects;
}

/**
 * 对应 Zotero `selection.js::getTextFromChars`。
 *
 * 选区文字**从字符模型拼**（而不是 `selection.toString()`）：
 *   - `ignorable` 字符不进文字（软连字符之类）；
 *   - 字后有视觉空格（`spaceAfter`）或行末（`lineBreakAfter`）补一个空格；
 *   - 段末（`paragraphBreakAfter`）**再**补一个空格（OCR 出来的 PDF 常常一行就是一段，
 *     正常 PDF 只在"段落折到另一栏"时需要 —— 上游注释就是这个意思）；
 *   - 最后 `trim()`。
 *
 * 注意行末补的是**空格而不是换行**：跨行选择出来的文字是一整段，符合"复制一段话"的预期。
 */
export function getTextFromChars(chars: ZoteroChar[]): string {
  let text: string[] = [];
  for (let char of chars) {
    if (!char.ignorable) {
      text.push(char.c);
      if (char.spaceAfter || char.lineBreakAfter) {
        text.push(' ');
      }
    }
    // OCRed PDFs sometimes result in each line being a separate paragraph
    // while, normal PDFs only need this when paragraph is wrapped to another column
    if (!char.ignorable && char.paragraphBreakAfter) {
      text.push(' ');
    }
  }
  return text.join('').trim();
}

/**
 * 对应 Zotero `selection.js::getRange`。
 *
 * 把 `[anchorOffset, headOffset)` 变成一次选区：
 *   - 相等 → `collapsed`（空选区，rects/text 都空）；
 *   - 不等 → **取两者中较小的当起点、较大的当终点**（所以反向拖选也是同一条 range，
 *     方向信息只在 `anchorOffset/headOffset` 的先后上，由调用方判断）；
 *   - 矩形保留三位小数（上游为了 JSON 存储做的 `toFixed(3)`，照抄 —— 手感上无差别，
 *     但标注存盘后的数值必须与上游一致）。
 */
function getRange(chars: ZoteroChar[], anchorOffset: number, headOffset: number): RawRange {
  let charStart: number;
  let charEnd: number;
  if (anchorOffset < headOffset) {
    charStart = anchorOffset;
    charEnd = headOffset - 1;
  }
  else if (anchorOffset > headOffset) {
    charStart = headOffset;
    charEnd = anchorOffset - 1;
  }
  else {
    return { collapsed: true, anchorOffset, headOffset, rects: [], text: '' };
  }

  let rangeChars = chars.slice(charStart, charEnd + 1);
  let text = getTextFromChars(rangeChars);
  let rects = getRectsFromChars(rangeChars).map(
    rect => rect.map(value => parseFloat(value.toFixed(3))) as [number, number, number, number],
  );
  return { anchorOffset, headOffset, rects, text };
}

/* ================================================================== *
 * 四、上下行 / 词 / 行：Zotero `selection.js`
 * ================================================================== */

/**
 * 对应 Zotero `selection.js::getNextLineClosestOffset`。
 *
 * 从 `offset` 出发找"下一行里离当前字符最近的那个字符"（上下键移动焦点用）：
 *   - 当前行找不到行末 / 当前行就是最后一行 → 返回 `chars.length`（= 文档末尾）；
 *   - 距离用 `rectsDist`（横向优先，列对齐），**严格小于**才更新（平局取前面的）。
 */
function getNextLineClosestOffset(chars: ZoteroChar[], offset: number): number | null {
  let currentLineEnd = chars.findIndex((x, idx) => idx >= offset && x.lineBreakAfter);
  if (currentLineEnd === -1 || currentLineEnd === chars.length - 1) {
    return chars.length;
  }
  let nextLineStart = currentLineEnd + 1;
  let nextLineEnd = chars.findIndex((x, idx) => idx >= nextLineStart && x.lineBreakAfter);
  let closestOffset: number | null = null;
  let closestDist: number | null = null;
  let currentChar = chars[offset];
  for (let i = nextLineStart; i <= nextLineEnd; i++) {
    let char = chars[i];
    if (closestDist === null || rectsDist(char.rect, currentChar.rect) < closestDist) {
      closestDist = rectsDist(char.rect, currentChar.rect);
      closestOffset = i;
    }
  }
  return closestOffset;
}

/**
 * 对应 Zotero `selection.js::getPrevLineClosestOffset`。
 *
 * 上一行的最近字符。`offset === chars.length`（光标在末尾）时先 `offset--`，
 * 否则 `chars[offset]` 取不到字符算距离。
 */
function getPrevLineClosestOffset(chars: ZoteroChar[], offset: number): number | null {
  if (offset === chars.length) {
    offset--;
  }
  let prevLineEnd = chars.findLastIndex((x, idx) => idx < offset && x.lineBreakAfter);
  if (prevLineEnd === -1) {
    return 0;
  }
  let prevLineStart = chars.findLastIndex((x, idx) => idx < prevLineEnd && x.lineBreakAfter);
  if (prevLineStart === -1) {
    prevLineStart = 0;
  }
  else {
    prevLineStart++;
  }
  let closestOffset: number | null = null;
  let closestDist: number | null = null;
  let currentChar = chars[offset];
  for (let i = prevLineStart; i <= prevLineEnd; i++) {
    let char = chars[i];
    if (closestDist === null || rectsDist(char.rect, currentChar.rect) < closestDist) {
      closestDist = rectsDist(char.rect, currentChar.rect);
      closestOffset = i;
    }
  }
  return closestOffset;
}

/* ================================================================== *
 * 五、range → 落页的 selectionRange：Zotero `selection.js::extractRange(*)`
 * ================================================================== */

/**
 * 对应 Zotero `selection.js::extractRange`。
 * 上游是 `range.position = {pageIndex, rects}; delete range.rects;`（就地改写）；
 * 这里用解构构造一个新对象，形状完全一致（`ResolvedSelectionRange`）。
 *
 * 注意 `anchor` / `head` 允许 undefined —— 跨页选择的**中间页**两端都缺省，
 * `getRangeBySelection` 会保留自己的默认端点（整页选中）。
 */
function extractRange(
  chars: ZoteroChar[],
  pageIndex: number,
  anchor: number | [number, number] | undefined,
  head: number | [number, number] | undefined,
  reverse?: boolean,
): ResolvedSelectionRange | null {
  // 上游：`getRangeBySelection({ chars, pageIndex, anchor, head, reverse })`
  let range = getRangeBySelection(chars, anchor, head, reverse);
  if (!range) {
    return null;
  }
  return rangeToResolved(range, pageIndex);
}

/** `RawRange` → `ResolvedSelectionRange`（上游的 `range.position = {pageIndex, rects}` + `delete rects`） */
function rangeToResolved(range: RawRange, pageIndex: number): ResolvedSelectionRange {
  let { rects, ...rest } = range;
  return { ...rest, position: { pageIndex, rects } };
}

/**
 * 对应 Zotero `selection.js::extractRangeByRects`。
 * 上游在这里保留 `offset/from/to` 三个旧字段（只删 `rects`）；本产品没有消费者，
 * 这里丢掉那三个死字段（算法不受影响），其余形状一致。
 */
function extractRangeByRects(
  chars: ZoteroChar[],
  pageIndex: number,
  rects: [number, number, number, number][],
): ResolvedSelectionRange | null {
  let range = getRangeByHighlight(chars, rects);
  if (!range) {
    return null;
  }
  let { rects: rectsOut, offset: _offset, from: _from, to: _to, ...rest } = range;
  return { ...rest, position: { pageIndex, rects: rectsOut } };
}

/**
 * 对应 Zotero `selection.js::extractRangeByRects`，冻结签名的公开形态（几何兜底路径的入口）。
 *
 * 【与上游的差异，签名所限】上游的 `pageIndex` 由调用方传入；这个签名里没有页号，
 * 所以 `position.pageIndex` 固定为 0。**需要页号请用 `getSelectionRangesByPosition`**
 * （它接收 `{pageIndex, rects}` 并走同一条 `extractRangeByRects`）。
 */
export function getRangeByRects(
  chars: ZoteroChar[],
  rects: [number, number, number, number][],
): ResolvedSelectionRange | null {
  return extractRangeByRects(chars, 0, rects);
}

/* ================================================================== *
 * 六、选区 → 字符数组 / 栏流收窄：Zotero `selection.js::getCharsFromSelectionRanges` +
 *     `applySelectionRangeFlow`
 * ================================================================== */

/**
 * 对应 Zotero `selection.js::getCharsFromSelectionRanges`。
 *
 * 按 `selectionRanges` 逐页取出 `[min(anchorOffset, headOffset), max(...))` 的字符，顺序**按 range 顺序**
 * （也就是文档顺序），拼成一个扁平数组交给栏流逻辑。
 *
 * 【本移植唯一的数据模型适配】上游的字符自带 `pageIndex` / `offset`（`page.js` 建模型时写入），
 * 下游的 `isolateCharsToAnchorFlow` / `splitContinuousCharRuns` / `applySelectionRangeFlow` 全都直接读
 * `char.pageIndex` / `char.offset`。本仓库冻结的 `ZoteroChar` 不存这两个字段，所以在**这里注入**：
 *   - `offset` = 该字符在 `page.chars` 数组里的下标 —— 与 Zotero 完全等价
 *     （`pdf-view.js:1780` 就是 `chars[selectionRange.headOffset]` 这么用的）；
 *   - `pageIndex` = 页下标。
 * 注入只发生在这一个地方，下游拿到的就是"上游形状"的字符（`FlowChar`），此后逐字对齐。
 */
export function getCharsFromSelectionRanges(
  pages: (PageCharModel | null | undefined)[],
  selectionRanges: ResolvedSelectionRange[],
): FlowChar[] {
  const charsArray: FlowChar[] = [];

  // Iterate over each selectionRange to directly access characters
  selectionRanges.forEach(selection => {
    const pageIndex = selection.position.pageIndex;
    const page = pages[pageIndex];

    if (!page) return; // Skip if page is not available

    let { chars } = page;

    // Calculate character range based on anchor and head offsets
    const anchorOffset = selection.anchorOffset;
    const headOffset = selection.headOffset;
    const start = Math.min(anchorOffset, headOffset);
    const end = Math.max(anchorOffset, headOffset);

    // 上游：`charsArray.push(...chars.slice(start, end))`（字符已自带 pageIndex/offset）
    for (let i = start; i < end; i++) {
      charsArray.push({ ...chars[i], pageIndex, offset: i });
    }
  });

  return charsArray;
}

/**
 * 上游 `applySelectionRangeFlow` 里的"语义流版本"来源：`pdfPages[i].semanticFlowRevision`。
 *
 * 本仓库冻结的 `PageCharModel` 没有这个字段，所以按"这一页有没有 flowClass 元数据"折算一个**隐式版本**：
 *   - 有任一字符带 `flowClass` → 版本 1（这一页的流信息可用）；
 *   - 一个都没有 → undefined。
 * 于是上游那句守卫（`selectionRanges.map(页 → revision)` → 找整数 → 有 undefined 或不一致就**原样返回**）
 * 语义被完整保留：**流元数据不全就不动用户的选区**（上游是"语义数据还在异步重建"，
 * 本产品是"这一页没打栏流标"），区别只是版本号的来源。
 */
function getPageFlowRevision(page: PageCharModel): number | undefined {
  return page.chars.some(char => Object.prototype.hasOwnProperty.call(char, 'flowClass')) ? 1 : undefined;
}

/**
 * 对应 Zotero `selection.js::applySelectionRangeFlow`（栏流收窄 + 用字符重建 selectionRanges）。
 *
 * 步骤与上游一一对应：
 *   1. 空数组 / 第一段 collapsed → 原样返回（`[]` / `selectionRanges`）；
 *   2. **语义流版本守卫**：涉及页的版本必须全是同一个整数，否则原样返回；
 *   3. `getCharsFromSelectionRanges` 摊平字符；
 *   4. 判断**锚点在哪一端**（`start`）：第一段带 `anchor` 时看它自己 anchor/head 谁小，
 *      否则看最后一段 —— 这一步决定 `isolateCharsToAnchorFlow` 拿哪一端当"锚点流"的锚点；
 *   5. `isolateCharsToAnchorFlow(chars, start)` 收窄（null → 原样返回；空 → `[]`）；
 *      **本产品在这里与上游不同**：两端 flowClass 不同时上游返回 null（跨栏泄漏），
 *      本产品收窄到锚点流（跨栏扫动停在栏缝）。详见 `selectionFlow.ts::isolateCharsToAnchorFlow`；
 *   6. `reversed`：按**第一段**的 head < anchor 记下方向，重建完后把每段的 anchor/head 对调回去；
 *   7. 逐字符重建：换页 → 收一段、开新段（新段 `anchorOffset = headOffset = char.offset + 1`），
 *      同页 → `headOffset = char.offset + 1` 并 append 字符。首段的初始 `headOffset` 故意等于
 *      `anchorOffset`（上游如此），靠循环第一次迭代补成 `+1`；
 *   8. 标记 anchor/head：单段时两者都是 true；多段时按 `start` 决定哪端是锚点；
 *   9. 每段：`splitContinuousCharRuns` 切连续段 → 逐段 `getRectsFromChars` 合并矩形 →
 *      `position` / `text`，最后 `anchorOffset === headOffset` 的段标 `collapsed`。
 *
 * 上游在第 9 步还写 `sortIndex`（`selection.js:705`）；本产品的 `ResolvedSelectionRange`
 * 没有这个字段、也没有消费者，故不移植。
 */
function applySelectionRangeFlow(
  pages: (PageCharModel | null | undefined)[],
  selectionRanges: ResolvedSelectionRange[],
): ResolvedSelectionRange[] {
  if (!selectionRanges.length) {
    return [];
  }
  if (selectionRanges[0].collapsed === true) {
    return selectionRanges;
  }
  let semanticRevisions = selectionRanges.map(
    range => {
      const page = pages[range.position.pageIndex];
      return page ? getPageFlowRevision(page) : undefined;
    }
  );
  let semanticRevision = semanticRevisions.find(Number.isInteger);
  if (semanticRevision === undefined
      || semanticRevisions.some(revision => revision !== semanticRevision)) {
    return selectionRanges;
  }

  let chars = getCharsFromSelectionRanges(pages, selectionRanges);

  let start: boolean;
  if (selectionRanges[0].anchor) {
    if (selectionRanges[0].head) {
      start = selectionRanges[0].anchorOffset < selectionRanges[0].headOffset;
    }
    else {
      start = true;
    }
  }
  else {
    start = selectionRanges.at(-1)!.anchorOffset < selectionRanges.at(-1)!.headOffset;
  }

  let flowChars = isolateCharsToAnchorFlow(chars, start);
  if (!flowChars) {
    return selectionRanges;
  }
  // `isolateCharsToAnchorFlow` 只做 filter、不改对象，注入的 pageIndex/offset 还在；
  // 冻结签名把返回类型写成 ZoteroChar[]，这里断言回 FlowChar（上游同一个变量贯穿到底）。
  chars = flowChars as FlowChar[];

  if (chars.length === 0) return [];

  let reversed = selectionRanges[0].headOffset < selectionRanges[0].anchorOffset;

  let rebuilt: FlowSelectionRange[] = [];
  let currentRange: FlowSelectionRange = {
    pageIndex: chars[0].pageIndex,
    anchorOffset: chars[0].offset,
    headOffset: chars[0].offset,
    selectedChars: [],
  };

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];

    if (char.pageIndex !== currentRange.pageIndex) {
      // Finish the current range and add it to the array
      rebuilt.push(currentRange);

      // Start a new range
      currentRange = {
        pageIndex: char.pageIndex,
        anchorOffset: char.offset,
        headOffset: char.offset + 1,
        selectedChars: [char],
      };
    }
    else {
      // Extend the current range
      currentRange.headOffset = char.offset + 1;
      currentRange.selectedChars.push(char);
    }
  }

  // Add the last range after the loop
  rebuilt.push(currentRange);

  if (reversed) {
    for (let selectionRange of rebuilt) {
      let tmp = selectionRange.anchorOffset;
      selectionRange.anchorOffset = selectionRange.headOffset;
      selectionRange.headOffset = tmp;
    }
  }

  if (rebuilt.length === 1) {
    rebuilt[0].anchor = true;
    rebuilt[0].head = true;
  }
  else if (start) {
    rebuilt[0].anchor = true;
    rebuilt.at(-1)!.head = true;
  }
  else {
    rebuilt.at(-1)!.anchor = true;
    rebuilt[0].head = true;
  }

  for (let selectionRange of rebuilt) {
    let runs = splitContinuousCharRuns(selectionRange.selectedChars);
    let rects = runs.flatMap(run => getRectsFromChars(run));
    selectionRange.position = {
      pageIndex: selectionRange.pageIndex,
      rects
    };
    selectionRange.text = getTextFromChars(selectionRange.selectedChars);
    if (selectionRange.anchorOffset === selectionRange.headOffset) {
      selectionRange.collapsed = true;
    }
  }

  return rebuilt.map(selectionRange => ({
    position: selectionRange.position!,
    anchorOffset: selectionRange.anchorOffset,
    headOffset: selectionRange.headOffset,
    collapsed: selectionRange.collapsed,
    anchor: selectionRange.anchor,
    head: selectionRange.head,
    text: selectionRange.text ?? '',
  }));
}

/** `applySelectionRangeFlow` 重建过程中的中间形状（对应上游就地改写的 range 对象） */
interface FlowSelectionRange {
  pageIndex: number;
  anchorOffset: number;
  headOffset: number;
  selectedChars: FlowChar[];
  position?: { pageIndex: number; rects: [number, number, number, number][] };
  text?: string;
  anchor?: boolean;
  head?: boolean;
  collapsed?: boolean;
}

/* ================================================================== *
 * 七、对外入口：Zotero `selection.js::getSelectionRanges` / `getSelectionRangesByPosition`
 * ================================================================== */

/**
 * 对应 Zotero `selection.js::getSelectionRanges`。
 *
 * 从 `anchor` 到 `head` 逐页算 selectionRange：
 *   - 只有锚点页拿 `anchor` 端点、焦点页拿 `head` 端点，**中间页两端都缺省**（整页选中）；
 *   - `reverse = anchor.pageIndex > head.pageIndex`（反向跨页拖），交给下层决定中间页的默认端点；
 *   - 任一页算不出 range → **整体返回 `[]`**（上游如此：宁可没有选区，也不要半截选区）；
 *   - 缺页（`pages[i]` 为 null）跳过（Zotero 是 `if (!pdfPages[i]) continue`，我们保留同一写法）；
 *   - 最后按 `applyFlow` 决定要不要过栏流收窄（默认过）。
 *
 * 【保留上游的几何端点分支】上游允许 `anchor` / `head` 是 `{pageIndex, rects}`（没有 `offset`），
 * 这时取 `rects[0]` 的左上角当点、由 `getClosestOffset` 找最近字符。冻结签名是 `TextPosition`，
 * 但这里仍然保留同一条分支（结构化读 `offset` / `rects`）—— 接线方传几何端点也能用。
 */
export function getSelectionRanges(
  pages: (PageCharModel | null | undefined)[],
  anchor: TextPosition,
  head: TextPosition,
  { applyFlow = true }: { applyFlow?: boolean } = {},
): ResolvedSelectionRange[] {
  let selectionRanges: ResolvedSelectionRange[] = [];
  let fromPageIndex = Math.min(anchor.pageIndex, head.pageIndex);
  let toPageIndex = Math.max(anchor.pageIndex, head.pageIndex);
  let reverse = anchor.pageIndex > head.pageIndex;
  const anchorInput = anchor as TextPosition & { rects?: [number, number, number, number][] };
  const headInput = head as TextPosition & { rects?: [number, number, number, number][] };
  for (let i = fromPageIndex; i <= toPageIndex; i++) {
    const page = pages[i];
    if (!page) {
      continue;
    }
    let a: number | [number, number] | undefined;
    let h: number | [number, number] | undefined;
    if (i === anchor.pageIndex) {
      a = anchorInput.offset !== undefined ? anchorInput.offset : [anchorInput.rects![0][0], anchorInput.rects![0][1]];
    }

    if (i === head.pageIndex) {
      h = headInput.offset !== undefined ? headInput.offset : [headInput.rects![0][0], headInput.rects![0][1]];
    }

    let { chars } = page;
    let selectionRange = extractRange(chars, i, a, h, reverse);
    if (!selectionRange) {
      return [];
    }

    if (i === anchor.pageIndex) {
      selectionRange.anchor = true;
    }

    if (i === head.pageIndex) {
      selectionRange.head = true;
    }

    // 上游此处：`if (!selectionRange.collapsed) { selectionRange.sortIndex = getSortIndex(...) }`
    // —— sortIndex 不在冻结类型里、本仓库无消费者，故不移植。

    selectionRanges.push(selectionRange);
  }
  return applyFlow
    ? applySelectionRangeFlow(pages, selectionRanges)
    : selectionRanges;
}

/**
 * 对应 Zotero `selection.js::getSelectionRangesByPosition`（**几何兜底路径**）。
 *
 * 输入是"矩形串"而不是字符序号：先 `getRangeByHighlight` 在首尾矩形里各命中一个字符，
 * 再按需算下一页（上游的 `position.nextPageRects`）：
 *   - 两段 → 第一段 `anchor`、第二段 `head`；
 *   - 一段 → 同一段既是 `anchor` 也是 `head`；
 *   - 最后同样按 `applyFlow` 决定要不要过栏流收窄。
 *
 * 【保留上游的 `nextPageRects` 分支】冻结签名里只写了 `{pageIndex, rects}`，但这里结构化读一下
 * `nextPageRects` —— 接线方要处理"拖到下一页"的矩形串时就能直接用。
 */
export function getSelectionRangesByPosition(
  pages: (PageCharModel | null | undefined)[],
  position: { pageIndex: number; rects: [number, number, number, number][] },
  { applyFlow = true }: { applyFlow?: boolean } = {},
): ResolvedSelectionRange[] {
  const page = pages[position.pageIndex];
  if (!page) {
    return [];
  }
  let { chars } = page;
  let selectionRanges: ResolvedSelectionRange[] = [];
  let selectionRange = extractRangeByRects(chars, position.pageIndex, position.rects);
  if (!selectionRange) {
    return [];
  }

  selectionRanges = [selectionRange];

  const nextPageRects = (position as { nextPageRects?: [number, number, number, number][] }).nextPageRects;
  if (nextPageRects) {
    const nextPage = pages[position.pageIndex + 1];
    if (!nextPage) {
      return [];
    }
    let { chars: nextChars } = nextPage;
    selectionRange = extractRangeByRects(nextChars, position.pageIndex + 1, nextPageRects);
    if (selectionRange) {
      selectionRanges.push(selectionRange);
    }
  }

  if (selectionRanges.length === 2) {
    selectionRanges[0].anchor = true;
    selectionRanges[1].head = true;
  }
  else {
    selectionRanges[0].head = true;
    selectionRanges[0].anchor = true;
  }

  return applyFlow
    ? applySelectionRangeFlow(pages, selectionRanges)
    : selectionRanges;
}

/**
 * 对应 Zotero `selection.js::getTextFromSelectionRanges`。
 * 各段文字用 `\n` 连接（跨页/跨栏之间因此有换行）；没有选区或首段 collapsed → `''`。
 */
export function getTextFromSelectionRanges(selectionRanges: ResolvedSelectionRange[]): string {
  if (!selectionRanges.length || selectionRanges[0].collapsed) {
    return '';
  }
  return selectionRanges.map(x => x.text).join('\n');
}

/* ================================================================== *
 * 八、键盘调整选区：Zotero `selection.js::getModifiedSelectionRanges`
 * ================================================================== */

/**
 * 对应 Zotero `selection.js::getModifiedSelectionRanges`（Shift+方向键改选区）。
 *
 * 只动 **head**（焦点），anchor 不动，最后重新 `getSelectionRanges`：
 *   - `'left'`：head 在段首（offset 0）→ 退到上一页末字符（`chars.length - 1`，注意不是 length）；否则 `offset--`；
 *   - `'right'`：head 在页末（offset === chars.length）→ 进到下一页的 **offset 1**（上游这里就是 1，
 *     不是 0 —— 跨页后跳过下一页第一个字符，保持"接着选"的手感）；否则 `offset++`；
 *   - `'up'` / `'down'`：段首/页末的跨页处理同上，页内则用 `getPrevLineClosestOffset` /
 *     `getNextLineClosestOffset` 换到上/下一行的最近字符；
 *   - 传 `TextPosition` 对象时直接把它当 head（上游 `typeof modifier === 'object'` 那一支）。
 *
 * 【守卫，非算法改动】上游用 `selectionRanges.find(x => x.anchor)` 后立刻读 `range.position`，
 * 找不到就抛异常；这里找不到返回 `[]`（对调用方是"这次调整无效"，不会崩）。
 */
export function getModifiedSelectionRanges(
  pages: (PageCharModel | null | undefined)[],
  selectionRanges: ResolvedSelectionRange[],
  modifier: 'left' | 'right' | 'up' | 'down' | TextPosition,
): ResolvedSelectionRange[] {
  if (!selectionRanges.length) {
    return [];
  }

  let range = selectionRanges.find(x => x.anchor);
  if (!range) {
    return [];
  }
  let anchor: TextPosition = {
    pageIndex: range.position.pageIndex,
    offset: range.anchorOffset
  };

  range = selectionRanges.find(x => x.head);
  if (!range) {
    return [];
  }
  let head: TextPosition = {
    pageIndex: range.position.pageIndex,
    offset: range.headOffset
  };

  if (!pages[head.pageIndex]) {
    return [];
  }

  if (modifier === 'left') {
    if (head.offset === 0) {
      const prevPage = pages[head.pageIndex - 1];
      if (prevPage) {
        let { chars } = prevPage;
        if (chars.length) {
          head.pageIndex--;
          head.offset = chars.length - 1;
        }
      }
    }
    else {
      head.offset--;
    }
  }
  else if (modifier === 'right') {
    // 上面已确认 `pages[head.pageIndex]` 存在（上游同样在守卫之后才解构）
    let { chars } = pages[head.pageIndex]!;
    if (head.offset === chars.length) {
      const nextPage = pages[head.pageIndex + 1];
      if (nextPage) {
        let { chars: nextChars } = nextPage;
        if (nextChars.length) {
          head.pageIndex++;
          head.offset = 1;
        }
      }
    }
    else {
      head.offset++;
    }
  }
  else if (modifier === 'up') {
    if (head.offset === 0) {
      const prevPage = pages[head.pageIndex - 1];
      if (prevPage) {
        let { chars } = prevPage;
        if (chars.length) {
          head.pageIndex--;
          head.offset = chars.length - 1;
        }
      }
    }
    else {
      let { chars } = pages[head.pageIndex]!;
      let offset = getPrevLineClosestOffset(chars, head.offset);
      if (offset !== null) {
        head.offset = offset;
      }
    }
  }
  else if (modifier === 'down') {
    let { chars } = pages[head.pageIndex]!;
    if (head.offset === chars.length) {
      const nextPage = pages[head.pageIndex + 1];
      if (nextPage) {
        let { chars: nextChars } = nextPage;
        if (nextChars.length) {
          head.pageIndex++;
          head.offset = 1;
        }
      }
    }
    else {
      let offset = getNextLineClosestOffset(chars, head.offset);
      if (offset !== null) {
        head.offset = offset;
      }
    }
  }
  else if (typeof modifier === 'object') {
    let position = modifier;
    head = position;
  }
  return getSelectionRanges(pages, anchor, head);
}

/* ================================================================== *
 * 九、写回 DOM：Zotero `selection.js::getNodeOffset` / `setTextLayerSelection`
 * ================================================================== */

/**
 * 对应 Zotero `selection.js::getNodeOffset`。
 *
 * 把"文本层里的第 N 个**非空白**字符"翻译成 DOM 端点 `{node, offset}`：
 *   - 深度优先但**先 push 子节点再 pop**（所以顺序是文档顺序）、`Node.TEXT_NODE` 才计数；
 *   - 空白字符（`node.nodeValue[i].trim()` 为假）**不计数**，但 `charIndex` 照样前进
 *     （它就是该节点内的真实偏移）；
 *   - 每个文字节点结束时都补一次"最后一个字符之后"的判定，所以端点落在节点末尾也能命中。
 *
 * 注意：它数的是 DOM 文本里的**非空白字符**个数，与字符模型的下标能对上，靠的是同一份
 * pdf.js 文本项；对不上时（DOM 与模型字符数不一致）接线方应当**放弃纠正**，而不是硬写。
 *
 * 【等价改写】上游用 `Node.TEXT_NODE`（iframe 窗口上的常量，值恒为 3）；这里用数值 3，
 * 免得在没有全局 `Node` 的环境（纯函数自检）里炸掉。
 */
export function getNodeOffset(container: Element, offset: number): { node: Node; offset: number } | undefined {
  let charIndex = 0;
  let charIndex2 = 0;
  let nodeStack: Node[] = [container];
  let node: Node | undefined;
  while ((node = nodeStack.pop())) {
    if (node.nodeType === TEXT_NODE) {
      let value = (node as Text).nodeValue ?? '';
      charIndex = 0;
      for (let i = 0; i < value.length; i++) {
        if (value[i].trim()) {
          if (offset === charIndex2) {
            return { node, offset: charIndex };
          }
          charIndex2++;
        }
        charIndex++;
      }
      // Check for the last character
      if (offset === charIndex2) {
        return { node, offset: charIndex };
      }
    }
    else {
      let i = node.childNodes.length;
      while (i--) {
        nodeStack.push(node.childNodes[i]);
      }
    }
  }
  return undefined;
}

/**
 * 对应 Zotero `selection.js::setTextLayerSelection` 的**前半段**（构造 Range）。
 *
 * 上游在这里一共做三件事：`getNodeOffset` 找到起点/终点 DOM 端点、`createRange()` 组装、
 * 最后 `selection.removeAllRanges(); selection.addRange(range)` 写回。
 * 本函数按冻结的名字/签名只做前两件（返回 `Range`），写回交给接线方 ——
 * 因为接线方要决定"什么时候写、写完要不要重收"，这一步不能藏在算法层。
 *
 * 逐字对齐的关键点：
 *   - 起点取**第一段**的 `min(anchorOffset, headOffset)`，终点取**最后一段**的
 *     `max(anchorOffset, headOffset)`（跨页时两段分属不同页/不同 `.textLayer`）；
 *   - 选择器是 `[data-page-number="${pageIndex + 1}"] .textLayer`（页号 1 起）；
 *   - `range.setStart(container, 0); range.collapse(true);` 这两句是上游的"落点归零"技巧，
 *     用来避免在某些浏览器里 setStart 到跨节点位置时抛异常，照抄。
 *
 * 【守卫，非算法改动】上游如果拿不到 container/端点会直接抛（解构 undefined）；
 * 这里每一步都返回 null，让接线方"放弃纠正、保留原生选区"。
 */
export function buildNativeRange(win: Window, ranges: ResolvedSelectionRange[]): Range | null {
  if (!ranges.length) {
    return null;
  }
  // Anchor
  let selectionRange = ranges[0];
  let offset = Math.min(selectionRange.anchorOffset, selectionRange.headOffset);
  let container = win.document.querySelector(
    `[data-page-number="${selectionRange.position.pageIndex + 1}"] .textLayer`);
  if (!container) {
    return null;
  }
  const start = getNodeOffset(container, offset);
  if (!start) {
    return null;
  }

  // Head
  selectionRange = ranges[ranges.length - 1];
  offset = Math.max(selectionRange.anchorOffset, selectionRange.headOffset);
  container = win.document.querySelector(
    `[data-page-number="${selectionRange.position.pageIndex + 1}"] .textLayer`);
  if (!container) {
    return null;
  }
  const end = getNodeOffset(container, offset);
  if (!end) {
    return null;
  }

  let range = win.document.createRange();
  range.setStart(container, 0);
  range.collapse(true);
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

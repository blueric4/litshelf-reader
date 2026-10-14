/**
 * Zotero 划词算法移植（一）：**字符流约束** + **DOM↔字符 单位对齐**。
 *
 * 逐字对应本机参考源码：
 *   - `D:\dsh\_zot\selection-flow.mjs`
 *       `getCharacterFlowClass` / `isolateCharsToAnchorFlow` / `splitContinuousCharRuns`
 *   - `D:\dsh\_zot\native-text-selection-map.mjs`
 *       `getNormalizedUnits` / `normalizeText` / `hasMatchingRun` / `findNextAlignment` /
 *       `alignTextUnits` / `buildReaderUnitMap` / `getMappedSelectionEndpoints` /
 *       `selectionTextMatches` / `getMatchingSelectionRanges`
 *   - `D:\dsh\_zot\native-text-selection.js`
 *       `TextLayerBoundaryMap`（`_buildDOMMap` / `_buildReaderMap` / `_getNormalizedOffset` /
 *       `getReaderOffset`）—— 放在本文件是为了**避免循环依赖**（它要用本文件的
 *       `alignTextUnits` / `buildReaderUnitMap`），`zoteroSelection.ts` 会把它再导出一次，
 *       所以两条 import 路径都能用。
 *
 * 允许的改动只有三类（其余一律保持上游的写法、分支顺序、边界取舍）：
 *   1. ESM → TypeScript 类型标注；
 *   2. `pdfPages[i].chars` → 入参 `chars` / 显式传入的 `win`；
 *   3. 下面注释里逐条写明的**产品化改动**。
 *
 * 本文件里唯一的产品化改动是 `isolateCharsToAnchorFlow` 的跨流分支（跨栏泄漏的修复），
 * 见该函数上方的注释。
 */

import type { TextPosition, ZoteroChar } from './selectionTypes';

/* ================================================================== *
 * 一、字符流：Zotero `selection-flow.mjs`
 * ================================================================== */

/**
 * Zotero 的 `chars[i]` 自带 `pageIndex` / `offset` 两个字段（`page.js` 建模型时写入；
 * `pdf-view.js:1780` 也是用 `chars[selectionRange.headOffset]` 取字符的）。
 *
 * 本仓库冻结的 `ZoteroChar`（`selectionTypes.ts`）**故意不存**这两个字段 —— 因为在本模型里
 * `offset` 就是"字符在 `page.chars` 数组里的下标"、`pageIndex` 就是页下标，冗余存一份只会失真。
 * 所以移植时按需把这两个字段**挂**到字符上（由 `zoteroSelection.ts::getCharsFromSelectionRanges`
 * 显式注入，那里同时给出了"为什么等价"的证明），用 `FlowChar` 标注。
 */
export interface FlowChar extends ZoteroChar {
  /** 页下标（= 页在 `pages` 数组里的下标） */
  pageIndex: number;
  /** 字符在**本页** `chars` 数组里的下标（Zotero 里就是 `offset`） */
  offset: number;
}

/** 读 Zotero 的 `char.pageIndex`：本模型没存这个字段时退回 0（页内局部语义不受影响） */
function charPageIndex(char: ZoteroChar | undefined): number {
  return (char as Partial<FlowChar> | undefined)?.pageIndex ?? 0;
}

/** 读 Zotero 的 `char.offset`：没挂这个字段时返回 undefined，由调用方用数组下标补齐 */
function charOffset(char: ZoteroChar | undefined): number | undefined {
  return (char as Partial<FlowChar> | undefined)?.offset;
}

/**
 * 对应 Zotero `selection-flow.mjs::charOffset` 等价物 —— `char.offset`，缺失时用数组下标兜底。
 * 两者**等价**：注入的 `offset` 就是字符在 `page.chars` 里的下标（`pdf-view.js:1780` 同样口径）。
 */
function charOffsetOrIndex(char: ZoteroChar | undefined, index: number): number {
  return charOffset(char) ?? index;
}

/** 对应 Zotero `selection-flow.mjs::getCharacterFlowClass`（上游是模块私有函数） */
function getCharacterFlowClass(char: ZoteroChar | undefined): string {
  return char?.flowClass ?? 'body';
}

/**
 * 对应 Zotero `selection-flow.mjs::isolateCharsToAnchorFlow`。
 *
 * 作用：把一次（可能跨流/跨栏的）选择的字符**收窄到锚点所在的那条流**。
 *
 * 【与 Zotero 的差异 —— 本产品的"锚点栏流隔离"，这是唯一一处刻意改行为的地方】
 *   上游在 `flowClass !== getCharacterFlowClass(headChar)` 时 `return null`，语义是
 *   "这是一次跨流选择（例如正文 → 图注），保留用户完整的扫动"。对**多栏论文**来说，
 *   这个 `null` 正好就是用户抱怨的"选区越过栏缝、横穿两栏"（上游是单栏阅读器，不在意这件事）。
 *   本产品要求：两端 flowClass 不同时**不返回 null**，而是继续执行下面的 filter ——
 *   只保留**锚点那一端**的 flowClass 的字符。于是跨栏扫动会**停在栏缝上**：
 *     锚点在左栏 → 只留左栏的字；锚点在右栏 → 只留右栏的字。
 *   注意 `anchorAtStart` 的取法**与上游完全一致**：为真取 `chars[0]` 的 flowClass，
 *   否则取 `chars.at(-1)`（`.at(-1)` 而不是 `chars[chars.length - 1]`，保持上游写法）。
 *   同一流（两端 flowClass 相同）时行为与上游**完全一致**：还是那句 `filter`。
 *
 * 返回值仍然保留 `null` 表示"没有流元数据 / 没有字符"（上游的这两个早退分支一字未动）：
 *   调用方（`applySelectionRangeFlow`）据此原样保留用户的选区。
 */
export function isolateCharsToAnchorFlow(chars: ZoteroChar[], anchorAtStart: boolean): ZoteroChar[] | null {
  let hasFlowMetadata = chars.some(char => (
    Object.prototype.hasOwnProperty.call(char, 'flowClass')
  ));
  if (!hasFlowMetadata || !chars.length) {
    return null;
  }
  let anchorChar = anchorAtStart ? chars[0] : chars.at(-1);
  let headChar = anchorAtStart ? chars.at(-1) : chars[0];
  let flowClass = getCharacterFlowClass(anchorChar);
  // Zotero 在此处是：
  //   if (flowClass !== getCharacterFlowClass(headChar)) { return null; }
  // 本产品改为继续往下走（收窄到锚点流），差异与原因见上方函数注释。
  return chars.filter(char => getCharacterFlowClass(char) === flowClass);
}

/**
 * 对应 Zotero `selection-flow.mjs::splitContinuousCharRuns`。
 *
 * 把字符按"同一页 + offset 连续"切成若干段 —— `getRectsFromChars` 必须**逐段**调用：
 * 一次选择里可能夹着别页、别流的字符，不能把它们的行矩形合并在一起（否则选区矩形会横贯整页）。
 *
 * 逐字对齐处：`char.pageIndex !== previous.pageIndex || char.offset !== previous.offset + 1`
 * 这个判据、以及"新的一段 push 进 runs 后再 push 字符"的顺序，都与上游一致。
 */
export function splitContinuousCharRuns(chars: ZoteroChar[]): ZoteroChar[][] {
  let runs: ZoteroChar[][] = [];
  for (let i = 0; i < chars.length; i++) {
    let char = chars[i];
    let run = runs.at(-1);
    let previous = run?.at(-1);
    if (!run
        || charPageIndex(char) !== charPageIndex(previous)
        || charOffsetOrIndex(char, i) !== charOffsetOrIndex(previous, i - 1) + 1) {
      run = [];
      runs.push(run);
    }
    run.push(char);
  }
  return runs;
}

/* ================================================================== *
 * 二、归一化单位与对齐：Zotero `native-text-selection-map.mjs`
 * ================================================================== */

/** 对应 Zotero `native-text-selection-map.mjs` 顶部常量 */
const ALIGNMENT_LOOKAHEAD = 32;
/** 对应 Zotero `native-text-selection-map.mjs` 顶部常量 */
const ALIGNMENT_MATCH_LENGTH = 8;

/**
 * `Node.TEXT_NODE` / `NodeFilter.SHOW_TEXT` 的数值。
 * 上游写的是 iframe 窗口上的 `this._win.Node.TEXT_NODE`（运行时任何窗口都是 3）；
 * TS 的 `Window` 类型上没有 `Node` / `NodeFilter` 这两个属性（它们是全局的），所以这里直接用数值，
 * 顺带也让本文件在没有全局 DOM 的环境里能安全加载。
 */
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const SHOW_TEXT = 4;

/**
 * 对应 Zotero `native-text-selection-map.mjs::getNormalizedUnits`。
 *
 * 把一个字符串拆成"对齐单位"：逐字符 NFKD 归一化（é → e + ́）并丢掉所有空白。
 * 这是 DOM 文本（pdf.js 文本层）与字符模型（Zotero reader）之间**唯一的可比口径**：
 * 两边都各自归一化成单位序列，再对齐。
 */
export function getNormalizedUnits(text: string): string[] {
  let units: string[] = [];
  for (let character of text || '') {
    for (let normalizedCharacter of character.normalize('NFKD')) {
      if (!/\s/u.test(normalizedCharacter)) {
        units.push(normalizedCharacter);
      }
    }
  }
  return units;
}

/**
 * 对应 Zotero `native-text-selection-map.mjs::normalizeText`（上游是模块私有函数）。
 *
 * 为什么先砍连字符再归一化：pdf.js 的 `Selection.toString()` 会**保留行尾可见连字符**
 * （`inter-\nnational`），而 Zotero 的字符模型把软连字符标成 `ignorable`。
 * 不先砍掉，两边文本永远比不相等，"映射出的选区是否等于原生选区"这个校验就废了。
 */
function normalizeText(text: string): string {
  // PDF.js preserves visible line-end hyphens in Selection.toString(), while
  // Reader's character model marks discretionary hyphens as ignorable.
  text = (text || '')
    .replace(/-(?:\r\n?|\n)\s*/gu, '')
    .replace(/-$/u, '');
  return getNormalizedUnits(text).join('');
}

/** 对应 Zotero `native-text-selection-map.mjs::hasMatchingRun` */
function hasMatchingRun(a: string[], b: string[], aIndex: number, bIndex: number, length: number): boolean {
  for (let i = 0; i < length; i++) {
    if (a[aIndex + i] !== b[bIndex + i]) {
      return false;
    }
  }
  return true;
}

/** 对应 Zotero `native-text-selection-map.mjs::findNextAlignment`（二维前瞻，取代价最小的重同步点） */
function findNextAlignment(
  a: string[],
  b: string[],
  aIndex: number,
  bIndex: number,
): { aDelta: number; bDelta: number; cost: number } | null {
  let best: { aDelta: number; bDelta: number; cost: number } | null = null;
  let maxA = Math.min(ALIGNMENT_LOOKAHEAD, a.length - aIndex);
  let maxB = Math.min(ALIGNMENT_LOOKAHEAD, b.length - bIndex);
  for (let aDelta = 0; aDelta <= maxA; aDelta++) {
    for (let bDelta = 0; bDelta <= maxB; bDelta++) {
      if (!aDelta && !bDelta) {
        continue;
      }
      let cost = aDelta + bDelta;
      if (best && cost >= best.cost) {
        continue;
      }
      let availableLength = Math.min(
        a.length - aIndex - aDelta,
        b.length - bIndex - bDelta
      );
      let matchingLength = Math.min(ALIGNMENT_MATCH_LENGTH, availableLength);
      if (hasMatchingRun(a, b, aIndex + aDelta, bIndex + bDelta, matchingLength)) {
        best = { aDelta, bDelta, cost };
      }
    }
  }
  return best;
}

/**
 * 对应 Zotero `native-text-selection-map.mjs::alignTextUnits`。
 *
 * 输入：DOM 归一化单位序列、字符模型归一化单位序列；输出：`offsets[domOffset] = readerOffset`
 * （长度 `domUnits.length + 1`）。完全一致时是恒等映射；出现分歧时用 `findNextAlignment`
 * 找最近的重同步点，中间按比例插值 —— 这样**多一个/少一个字符**（pdf.js 与模型的已知差异）
 * 不会让后面的整段映射全部错位。
 */
export function alignTextUnits(domUnits: string[], readerUnits: string[]): number[] {
  let offsets: number[] = new Array(domUnits.length + 1);
  let domOffset = 0;
  let readerOffset = 0;
  offsets[0] = 0;

  while (domOffset < domUnits.length && readerOffset < readerUnits.length) {
    if (domUnits[domOffset] === readerUnits[readerOffset]) {
      domOffset++;
      readerOffset++;
      offsets[domOffset] = readerOffset;
      continue;
    }

    let alignment = findNextAlignment(domUnits, readerUnits, domOffset, readerOffset);
    if (!alignment) {
      domOffset++;
      readerOffset++;
      offsets[domOffset] = readerOffset;
      continue;
    }

    let { aDelta, bDelta } = alignment;
    for (let i = 1; i <= aDelta; i++) {
      offsets[domOffset + i] = readerOffset + Math.round(i * bDelta / aDelta);
    }
    domOffset += aDelta;
    readerOffset += bDelta;
    offsets[domOffset] = readerOffset;
  }

  while (domOffset < domUnits.length) {
    offsets[++domOffset] = readerOffset;
  }
  offsets[domUnits.length] = readerUnits.length;
  return offsets;
}

/**
 * 对应 Zotero `native-text-selection-map.mjs::buildReaderUnitMap`。
 *
 * 把字符模型摊平成"归一化单位序列"，并给出两张**下标表**（下标 = 归一化单位位置）：
 *   - `readerStartOffsets[u]`：这个单位处取"起点亲和"时该返回的**字符序号**；
 *   - `readerEndOffsets[u]`：这个单位处取"终点亲和"时该返回的**字符序号**。
 *
 * 逐字对齐处（不要"优化"）：
 *   - `ignorable` 字符不产出单位，只把当前位置的 `readerStartOffsets` 推到 `i + 1`
 *     （即：软连字符之后，起点亲和会跳到下一个字符）；
 *   - 一个字符产出多个单位时（NFKD 展开成基字母 + 组合符），段内边界
 *     `start + 1 .. normalizedOffset - 1` 的起点 = i、终点 = i + 1（宁可多选这个字符，不要漏）；
 *   - 末尾用 `??=`（不是 `=`）补 `chars.length` —— 前面已经写过的值不能被覆盖。
 */
export function buildReaderUnitMap(chars: ZoteroChar[]): {
  readerUnits: string[];
  readerStartOffsets: number[];
  readerEndOffsets: number[];
} {
  let readerUnits: string[] = [];
  let readerStartOffsets: number[] = [];
  let readerEndOffsets: number[] = [];
  let normalizedOffset = 0;
  readerStartOffsets[0] = 0;
  readerEndOffsets[0] = 0;
  for (let i = 0; i < chars.length; i++) {
    let units = chars[i].ignorable ? [] : getNormalizedUnits(chars[i].c);
    if (!units.length) {
      readerStartOffsets[normalizedOffset] = i + 1;
      continue;
    }

    let start = normalizedOffset;
    readerStartOffsets[start] = i;
    readerEndOffsets[start] = i;
    readerUnits.push(...units);
    normalizedOffset += units.length;
    for (let boundary = start + 1; boundary < normalizedOffset; boundary++) {
      readerStartOffsets[boundary] = i;
      readerEndOffsets[boundary] = i + 1;
    }
    readerStartOffsets[normalizedOffset] = i + 1;
    readerEndOffsets[normalizedOffset] = i + 1;
  }
  readerStartOffsets[normalizedOffset] ??= chars.length;
  readerEndOffsets[normalizedOffset] ??= chars.length;
  return { readerUnits, readerStartOffsets, readerEndOffsets };
}

/**
 * `native-text-selection-map.mjs::getMappedSelectionEndpoints` 的入参（DOM 端点来源）。
 *
 * 上游直接用 `selectionInfo`（`native-text-selection.js::_getSelectionInfo()` 的产物），
 * 里面用到的只有这四个字段 + `anchorIsStart` + 两端页号，所以这里收窄成最小结构，
 * 接线方随便拿一个 `window.getSelection()` 就能凑出来。
 */
export interface MappedSelectionSource {
  selection: Pick<Selection, 'anchorNode' | 'anchorOffset' | 'focusNode' | 'focusOffset'>;
  /** 锚点是不是 range 的起点（决定两端各取 start/end 亲和） */
  anchorIsStart: boolean;
  anchorPageIndex: number;
  focusPageIndex: number;
}

/**
 * 对应 Zotero `native-text-selection-map.mjs::getMappedSelectionEndpoints`。
 *
 * 这是"DOM 端点 → 字符序号"的**唯一正确姿势**：亲和方向由 `anchorIsStart` 决定 ——
 * 锚点是起点时取 `'start'`（更靠前的字符）、焦点取 `'end'`；反向拖选时两者互换。
 * 任一端映射不出来（页模型没建好、DOM 与模型对不齐）就整体返回 null，
 * 调用方（接线方）据此放弃纠正、保留浏览器原生选区。
 *
 * 【与上游的差异】上游直接 `selection.anchorNode`（DOM 类型上可能为 null）—— 这里加了一个
 * null 守卫（返回 null 而不是抛异常），其余逐字一致。
 */
export function getMappedSelectionEndpoints(
  selectionInfo: MappedSelectionSource,
  anchorMap: { getReaderOffset(node: Node, offset: number, affinity: 'start' | 'end'): number | null },
  focusMap: { getReaderOffset(node: Node, offset: number, affinity: 'start' | 'end'): number | null },
): { anchor: TextPosition; focus: TextPosition } | null {
  const { anchorNode, anchorOffset: anchorNodeOffset, focusNode, focusOffset: focusNodeOffset } = selectionInfo.selection;
  if (!anchorNode || !focusNode) {
    return null;
  }
  let anchorOffset = anchorMap.getReaderOffset(
    anchorNode,
    anchorNodeOffset,
    selectionInfo.anchorIsStart ? 'start' : 'end'
  );
  let focusOffset = focusMap.getReaderOffset(
    focusNode,
    focusNodeOffset,
    selectionInfo.anchorIsStart ? 'end' : 'start'
  );
  if (anchorOffset === null || focusOffset === null) {
    return null;
  }
  return {
    anchor: {
      pageIndex: selectionInfo.anchorPageIndex,
      offset: anchorOffset
    },
    focus: {
      pageIndex: selectionInfo.focusPageIndex,
      offset: focusOffset
    }
  };
}

/**
 * 对应 Zotero `native-text-selection-map.mjs::selectionTextMatches`。
 *
 * "原生选区的文字"与"按模型算出的选区文字"是否等价（两侧都先 `normalizeText`）。
 * 这是映射路径与几何兜底路径之间的**仲裁**：映射结果对不上原生文字，就说明映射错了，改用兜底。
 */
export function selectionTextMatches(selectionText: string, rangeText: string): boolean {
  return normalizeText(selectionText) === normalizeText(rangeText);
}

/**
 * 对应 Zotero `native-text-selection-map.mjs::getMatchingSelectionRanges`。
 *
 * 先信映射路径（`mapped`），它算出来的文字与原生选区一致就用它；
 * 否则退到几何兜底路径（`getFallback`），兜底也一致才用它；都不一致返回 null
 * （调用方会当作"这次选区不合法"处理）。
 *
 * 【与上游的差异，仅类型层面】上游写 `mappedRanges?.length`，因为 JS 里传的就是数组；
 * 冻结签名把它泛型化成 `T | null`，所以这里结构化读一下 `length`，判断语义与上游一字不差。
 */
export function getMatchingSelectionRanges<T>(
  selectionText: string,
  mapped: T | null,
  getRangeText: (ranges: T) => string,
  getFallbackRanges: () => T | null,
): T | null {
  const mappedLength = (mapped as { length?: number } | null)?.length;
  if (mappedLength && mapped !== null && selectionTextMatches(selectionText, getRangeText(mapped))) {
    return mapped;
  }
  let fallbackRanges = getFallbackRanges();
  const fallbackLength = (fallbackRanges as { length?: number } | null)?.length;
  return fallbackLength && fallbackRanges !== null
    && selectionTextMatches(selectionText, getRangeText(fallbackRanges))
    ? fallbackRanges
    : null;
}

/* ================================================================== *
 * 三、DOM ↔ 字符模型 的边界映射：Zotero `native-text-selection.js::TextLayerBoundaryMap`
 * ================================================================== */

/**
 * 对应 Zotero `native-text-selection.js::TextLayerBoundaryMap`（整类逐字移植）。
 *
 * 它解决的问题：`window.getSelection()` 给的是"某个文字节点 + 节点内偏移"，
 * 而选区的定义在**字符模型**上。类构造时做两件事：
 *   1. `_buildDOMMap(textDivs)`：按 pdf.js 的 textDiv 顺序摊平文本层里的文字节点，
 *      记录每个节点覆盖的**归一化单位区间**（`_nodeOffsets`）与每个 textDiv 的起始单位（`_textDivOffsets`）；
 *   2. `_buildReaderMap(chars)` + `alignTextUnits`：把"DOM 单位序列"对齐到"模型单位序列"，
 *      得到 `_domToReaderOffsets`。
 * 之后 `getReaderOffset(node, offset, affinity)` 就是"DOM 端点 → 字符序号"。
 *
 * 为什么必须按单位（而不是按字符数）对齐：pdf.js 的文本层与模型都可能多/少几个空白或连字符，
 * 按单位 + 前瞻重同步（`alignTextUnits`）能把局部差异吃掉，不让它污染后面的整段映射。
 *
 * `affinity`：`'start'` 取更靠前的字符、`'end'` 取更靠后的字符（`_readerStartOffsets` /
 * `_readerEndOffsets`）。调用方按"锚点/焦点"来选择，见 `getMappedSelectionEndpoints`。
 */
export class TextLayerBoundaryMap {
  private readonly _win: Window;
  private readonly _textLayer: Element;
  private readonly _nodeOffsets = new WeakMap<Text, { start: number; prefixLengths: number[] }>();
  private readonly _textDivOffsets = new WeakMap<Element, number>();
  private _domUnits: string[] = [];
  private _readerUnits: string[] = [];
  private _readerStartOffsets: number[] = [];
  private _readerEndOffsets: number[] = [];
  private _domToReaderOffsets: number[] = [];

  constructor(win: Window, textLayer: Element, textDivs: Element[], chars: ZoteroChar[]) {
    this._win = win;
    this._textLayer = textLayer;
    this._buildDOMMap(textDivs);
    this._buildReaderMap(chars);
    this._domToReaderOffsets = alignTextUnits(this._domUnits, this._readerUnits);
  }

  /**
   * 对应 Zotero `TextLayerBoundaryMap::getReaderOffset`。
   * @returns 字符序号；映射不出来（端点不在已建图的节点里、越界）返回 null。
   */
  getReaderOffset(node: Node, offset: number, affinity: 'start' | 'end'): number | null {
    let domOffset = this._getNormalizedOffset(node, offset);
    if (domOffset === null || domOffset > this._domUnits.length) {
      return null;
    }
    let normalizedOffset = this._domToReaderOffsets[domOffset];
    if (normalizedOffset === undefined || normalizedOffset > this._readerUnits.length) {
      return null;
    }
    return affinity === 'end'
      ? this._readerEndOffsets[normalizedOffset]
      : this._readerStartOffsets[normalizedOffset];
  }

  /**
   * 对应 Zotero `TextLayerBoundaryMap::_buildDOMMap`。
   *
   * 按 `textDivs` 的顺序（= pdf.js 文本项顺序）遍历每个 textDiv 里的文字节点，
   * 把节点的源文本偏移折算成**归一化单位偏移**：
   *   - `prefixLengths[sourceOffset]` = 该源偏移之前累计的单位数（`character.length` 处理代理对）；
   *   - 代理对的中间位置（`i = 1 .. characterLength - 1`）也填上"这个字符之前"的单位数，
   *     免得端点正好落在半个代理对上时读到空洞。
   * `visitedNodes` 保证同一个文字节点不会被算两次（textDiv 嵌套时上游也会遇到）。
   */
  private _buildDOMMap(textDivs: Element[]): void {
    let visitedNodes = new Set<Node>();
    for (let textDiv of textDivs) {
      if (!this._textLayer.contains(textDiv)) {
        continue;
      }
      this._textDivOffsets.set(textDiv, this._domUnits.length);
      let walker = this._win.document.createTreeWalker(
        textDiv,
        SHOW_TEXT
      );
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (visitedNodes.has(node)) {
          continue;
        }
        visitedNodes.add(node);
        let start = this._domUnits.length;
        let value = (node as Text).nodeValue ?? '';
        let prefixLengths: number[] = new Array(value.length + 1).fill(0);
        let sourceOffset = 0;
        let normalizedLength = 0;
        for (let character of value) {
          let characterLength = character.length;
          let units = getNormalizedUnits(character);
          for (let i = 1; i < characterLength; i++) {
            prefixLengths[sourceOffset + i] = normalizedLength;
          }
          normalizedLength += units.length;
          sourceOffset += characterLength;
          prefixLengths[sourceOffset] = normalizedLength;
          this._domUnits.push(...units);
        }
        this._nodeOffsets.set(node as Text, { start, prefixLengths });
      }
    }
  }

  /** 对应 Zotero `TextLayerBoundaryMap::_buildReaderMap`（本模型 → 单位表 + 两张字符序号表） */
  private _buildReaderMap(chars: ZoteroChar[]): void {
    let map = buildReaderUnitMap(chars);
    this._readerUnits = map.readerUnits;
    this._readerStartOffsets = map.readerStartOffsets;
    this._readerEndOffsets = map.readerEndOffsets;
  }

  /**
   * 对应 Zotero `TextLayerBoundaryMap::_getNormalizedOffset`：DOM 端点 → 单位偏移。
   *
   * 两条路径：
   *   1. 端点在**已建图的文字节点**里 → 直接查 `prefixLengths`（O(1)）；
   *   2. 否则（端点在 textDiv 元素上、或某个未被遍历到的节点）→ 用 Range 量
   *      "从 textDiv 开头到这个端点"的文字，归一化后数单位数（上游的兜底，能处理
   *      "端点在元素节点上"这种 `Selection` 的真实形态）。Range 抛异常时返回 null。
   */
  private _getNormalizedOffset(node: Node, offset: number): number | null {
    if (node.nodeType === TEXT_NODE) {
      let nodeOffset = this._nodeOffsets.get(node as Text);
      if (nodeOffset) {
        let value = (node as Text).nodeValue ?? '';
        let sourceOffset = Math.max(0, Math.min(offset, value.length));
        return nodeOffset.start + nodeOffset.prefixLengths[sourceOffset];
      }
    }

    let textDiv: Element | null = node.nodeType === ELEMENT_NODE ? (node as Element) : node.parentElement;
    while (textDiv && !this._textDivOffsets.has(textDiv)) {
      textDiv = textDiv.parentElement;
    }
    if (!textDiv) {
      return null;
    }
    try {
      let range = this._win.document.createRange();
      range.setStart(textDiv, 0);
      range.setEnd(node, offset);
      return this._textDivOffsets.get(textDiv)! + getNormalizedUnits(range.toString()).length;
    }
    catch (e) {
      return null;
    }
  }
}

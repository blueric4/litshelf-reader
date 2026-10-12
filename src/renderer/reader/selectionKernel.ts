/**
 * 划词内核：**Zotero 式**的"字符模型决定选区"。
 *
 * ## 这套东西为什么长这样（写给下一个接手的人）
 *
 * 这个产品的划词曾经有一条 1000+ 行的自研实现：拖动中逐帧改锚点、夹跨页、夹跨栏、
 * 松手后锁住选区 0.7~2.5 秒并定时重锁、用 MutationObserver 看护、按 DOM span 的 rect 判栏归属……
 * 结果是"按下点 / DOM 端点 / span 序号"三套坐标互相追着跑，bug 越修越多
 * （历史见 docs/HANDOFF-column-selection-fix.md、docs/review-selection.md）。
 *
 * Zotero 的做法完全不同，而且简单得多（`zotero/reader` 的 `src/pdf/native-text-selection.js`
 * + `selection.js`）：
 *   1. **拖动完全交给浏览器**（它只负责把指针变成"锚点 + 焦点"两个 DOM 端点）；
 *   2. 把这两个端点映射回**文档的字符模型**（每个字符带 rect、lineBreakAfter、flowClass）；
 *   3. 选区 = 字符模型上 `[anchorOffset, headOffset)` 这一段字符（`selection.js::getRange`）；
 *   4. 选区的矩形、文字全部**从模型算**（`getRectsFromChars` / `getTextFromChars`），
 *      不再读 DOM 的 `getClientRects()` —— 这一步顺带把 pdf.js 那个整层大小的 `.endOfContent`
 *      造成的"选区矩形横贯整页"从根上消掉了；
 *   5. 需要纠正时，只用一次 `setBaseAndExtent` 把端点挪到合法的字符边界上。
 *
 * 所以本文件只做第 2~5 步，**不参与 mousemove**。这个仓库已经用血泪证明过：
 * 任何"拖动中逐帧改写选区"的实现都会和浏览器打架（快拖时出现 1~3 字碎选区）。
 *
 * ## 与 Zotero 的唯一差异：跨栏硬禁止
 *
 * Zotero 的 `isolateCharsToAnchorFlow()` 在两端 `flowClass` 不同时返回 `null`，语义是
 * "这是一次跨流（比如正文 → 图注）的选择，保留用户完整的扫动"。对多栏 PDF 来说，
 * 这个 `null` 正好就是用户抱怨的"选区越过栏缝"。
 * 本产品改成：两端 flowClass 不同时**收窄到锚点那一栏**（见 `selectionFlow.ts` 的注释）。
 * 于是跨栏扫动会**停在栏缝上**，而不是横穿两栏。
 *
 * 判据是**离散**的（"这个字属于哪一栏"），不是几何的（"x 有没有超过栏带上界"）：
 * 两端对齐的中文行会把行末单字推进栏缝（实测「连」在 [595~613]，而栏缝是 555~595），
 * 按几何边界夹会丢掉本栏最后一个字、并在栏缝里来回跳。
 */

import type {
  DomSelectionEndpoint,
  NodePosition,
  PageCharModel,
  Rect,
  ResolvedRangeLike,
  SelSnapshot,
  SelSnapshotInput,
  SelectionKernel,
  TextPosition,
} from './selectionTypes';
import { getSelectionRanges, getTextFromSelectionRanges } from './zoteroSelection';

/**
 * DOM 端点 → 字符位置。由接线方提供（它手里有每页的 `SelectionModel`）。
 * 返回 null 表示这一端映射不出来（例如页模型还没建好）→ 内核**放弃本次纠正**，
 * 让浏览器的原生选区原样留着（宁可不夹，也不乱夹）。
 */
export type DomPositionResolver = (
  node: Node,
  offset: number,
  affinity: 'start' | 'end',
) => TextPosition | null;

export interface KernelDeps {
  /** 取某一页的字符模型（没建好返回 null） */
  getPage: (pageIndex: number) => PageCharModel | null;
  /** 把 DOM 端点映射成字符位置（跨页多端点时都走它） */
  resolveDomPosition: DomPositionResolver;
  /** 页面元素 → 客户端坐标换算：返回该页左上角的 client 坐标（拿不到就 null） */
  pageOriginOf: (pageEl: HTMLElement) => { left: number; top: number } | null;
  /** 诊断日志开关（默认关；排查划词问题时打开） */
  debug?: boolean;
}

/** 字符序号 → 该页文本层里的 DOM 端点（靠"文本层里的文字 = 模型里的字符"这一一对应关系） */
interface DomIndex {
  pageIndex: number;
  /** 按 DOM 顺序摊平的每个文字节点：它覆盖的字符区间 [start, end) */
  nodes: { node: Text; start: number; end: number }[];
  /** 模型字符总数 */
  total: number;
  /** DOM 摊平出来的字符总数（与 total 不一致 → 索引不可信） */
  domTotal: number;
}

export function createSelectionKernel(deps: KernelDeps): SelectionKernel {
  const log = (...args: unknown[]): void => {
    if (deps.debug) console.debug('[zsel]', ...args);
  };

  let owns = false;
  const domIndexCache = new Map<number, DomIndex>();

  const pageElOf = (model: PageCharModel | null): HTMLElement | null => {
    if (!model) return null;
    const el = model.pageEl ?? null;
    if (el && el.isConnected) return el;
    const doc = typeof document !== 'undefined' ? document : null;
    return doc?.querySelector<HTMLElement>(`.rd-pdf-page[data-page-index="${model.pageIndex + 1}"]`) ?? null;
  };

  const pageEntry = (pageIndex: number): { model: PageCharModel; pageEl: HTMLElement } | null => {
    const model = deps.getPage(pageIndex);
    const pageEl = pageElOf(model);
    return model && pageEl ? { model, pageEl } : null;
  };

  /** 模型上的锚点/焦点 → 一次或多次 range 计算（跨栏收窄在这里发生） */
  const computeRanges = (pair: EndpointPair): { ranges: ResolvedRangeLike[]; head: TextPosition } | null => {
    const anchorEntry = pageEntry(pair.anchorPage);
    if (!anchorEntry) return null;
    const head = clampToAnchorFlow(anchorEntry.model, pair.anchor, pair.head, log);
    const lo = Math.min(pair.anchorPage, head.pageIndex);
    const hi = Math.max(pair.anchorPage, head.pageIndex);
    const list: (PageCharModel | null | undefined)[] = [];
    for (let i = 0; i <= hi; i += 1) list[i] = pageEntry(i)?.model ?? null;
    for (let i = lo; i <= hi; i += 1) {
      if (!list[i]) {
        log('区间内第 ' + i + ' 页没有模型，放弃纠正');
        return null;
      }
    }
    const ranges = getSelectionRanges(list, pair.anchor, head);
    if (!ranges?.length || ranges[0].collapsed) return null;
    return { ranges, head };
  };

  /** 一次原生选区 → 纯计算结果（不写 DOM） */
  const computeSnapshot = (
    input: SelSnapshotInput,
  ): { snapshot: SelSnapshot | null; ranges: ResolvedRangeLike[] | null; pair: EndpointPair | null } => {
    const pair = resolveEndpoints(input, log, deps.resolveDomPosition);
    if (!pair) return { snapshot: null, ranges: null, pair: null };
    const computed = computeRanges(pair);
    if (!computed) return { snapshot: null, ranges: null, pair };

    const seen = new Set<number>();
    const rectsByPage: SelSnapshot['rectsByPage'] = [];
    for (const r of computed.ranges) {
      if (!r || r.collapsed || !r.position?.rects?.length) continue;
      if (seen.has(r.position.pageIndex)) continue;
      const entry = pageEntry(r.position.pageIndex);
      if (!entry) continue;
      seen.add(r.position.pageIndex);
      rectsByPage.push({
        pageIndex: r.position.pageIndex,
        pageEl: entry.pageEl,
        rects: toLocalRects(r.position.rects),
      });
    }
    const text = getTextFromSelectionRanges(computed.ranges as never);
    if (!rectsByPage.length || !text.trim()) return { snapshot: null, ranges: computed.ranges, pair };

    const main = rectsByPage.find((p) => p.pageIndex === pair.anchorPage) ?? rectsByPage[0];
    const anchorRange = computed.ranges.find((r) => r.anchor) ?? computed.ranges[0];
    const snapshot: SelSnapshot = {
      pageIndex: main.pageIndex,
      pageEl: main.pageEl,
      text,
      rectsByPage,
      clientRect: toClientRect(anchorRange.position.rects, main.pageEl, deps),
    };
    return { snapshot, ranges: computed.ranges, pair };
  };

  const domIndexFor = (model: PageCharModel, textLayer: HTMLElement): DomIndex => {
    const cached = domIndexCache.get(model.pageIndex);
    if (cached && cached.total === model.chars.length) return cached;
    const built = buildDomIndex(model, textLayer);
    domIndexCache.set(model.pageIndex, built);
    return built;
  };

  const apply: SelectionKernel['apply'] = (input) => {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    if (!sel) return null;
    const { snapshot, ranges, pair } = computeSnapshot(input);
    if (!snapshot || !ranges || !pair) return null;

    // 端点已经被收窄过吗？没收窄（模型文字 == 原生选区文字）→ 一个字节都不写 DOM。
    // 这条是"手感"的底线：用户拖出来的正常选区绝不能被我们动过。
    if (normalizeForCompare(sel.toString()) === normalizeForCompare(snapshot.text)) {
      log('选区本来就合法，不写 DOM', { chars: snapshot.text.length });
      owns = true;
      return null;
    }

    const entry = pageEntry(pair.anchorPage);
    const textLayer = entry?.pageEl.querySelector<HTMLElement>('.rd-pdf-text') ?? null;
    if (!entry || !textLayer) {
      log('拿不到锚点页的文本层，放弃夹取');
      return null;
    }
    const index = domIndexFor(entry.model, textLayer);
    if (index.domTotal !== index.total) {
      log('DOM 字符数与模型不一致，放弃夹取', { dom: index.domTotal, model: index.total });
      return null;
    }
    const anchorRange = ranges.find((r) => r.anchor) ?? ranges[0];
    const headRange = ranges.find((r) => r.head) ?? ranges[ranges.length - 1];
    const a = domPositionOf(index, Math.min(anchorRange.anchorOffset, anchorRange.headOffset));
    const b = domPositionOf(index, Math.max(headRange.anchorOffset, headRange.headOffset));
    if (!a || !b) {
      log('夹取后的端点建不出 DOM 位置，放弃', { a, b });
      return null;
    }
    try {
      sel.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
    } catch (err) {
      log('setBaseAndExtent 失败', err);
      return null;
    }
    owns = true;
    log('夹取：原生 → 模型', { native: sel.toString().length, model: snapshot.text.length, head: snapshot.text.slice(0, 40) });
    return snapshot;
  };

  return {
    apply,
    read: (input) => computeSnapshot(input).snapshot,
    ownsSelection: () => owns,
    clear: () => {
      owns = false;
    },
    invalidate: (pageIndex) => {
      if (pageIndex === undefined) domIndexCache.clear();
      else domIndexCache.delete(pageIndex);
    },
  };
}

/**
 * 把文本层里的文字节点按 **DOM 顺序**摊平，并记录每个节点覆盖的字符区间。
 *
 * 这里就是"DOM 序号"这一层薄薄的胶水：模型里的第 i 个字符 ↔ 文本层里的第 i 个字符
 * （pdf.js 的 span 文本与文本项 `str` 逐字相同，模型也是按同一份文本项建的）。
 * 两边数量不一致时**放弃**（`domTotal !== total`）—— 宁可夹不了，也不能按错位的映射改选区。
 */
function buildDomIndex(model: PageCharModel, textLayer: HTMLElement): DomIndex {
  const doc = textLayer.ownerDocument;
  const walker = doc.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  const nodes: DomIndex['nodes'] = [];
  let cursor = 0;
  let node: Node | null = walker.nextNode();
  while (node) {
    const t = node as Text;
    const len = t.nodeValue?.length ?? 0;
    if (len > 0) {
      nodes.push({ node: t, start: cursor, end: cursor + len });
      cursor += len;
    }
    node = walker.nextNode();
  }
  return { pageIndex: model.pageIndex, nodes, total: model.chars.length, domTotal: cursor };
}

/** 字符区间 → DOM 端点。索引不可信、或落在区间外时返回 null */
function domPositionOf(index: DomIndex, offset: number): NodePosition | null {
  if (!index.nodes.length || index.domTotal !== index.total) return null;
  if (offset < 0 || offset > index.domTotal) return null;
  for (const n of index.nodes) {
    if (offset >= n.start && offset <= n.end) return { node: n.node, offset: offset - n.start };
  }
  return null;
}

/** 模型坐标（相对页面元素）→ 客户端坐标 */
function toClientRect(
  rects: readonly (readonly [number, number, number, number])[],
  pageEl: HTMLElement,
  deps: KernelDeps,
): Rect | null {
  if (!rects.length) return null;
  const origin = deps.pageOriginOf(pageEl);
  if (!origin) return null;
  // 取**第一行**：工具条要贴在选区的起始行上（Zotero 用 position.rects[0] 定位弹窗）
  const [x1, y1, x2, y2] = rects[0];
  return { left: x1 + origin.left, top: y1 + origin.top, right: x2 + origin.left, bottom: y2 + origin.top };
}

/** 选区的矩形本来就是相对页面元素的，这里只是换结构 */
function toLocalRects(rects: readonly (readonly [number, number, number, number])[]): Rect[] {
  return rects.map(([x1, y1, x2, y2]) => ({ left: x1, top: y1, right: x2, bottom: y2 }));
}

/** 一次选区的端点归属：`anchor` 是按下的那一端（反向拖选时它不是 range 的起点） */
interface EndpointPair {
  anchor: TextPosition;
  head: TextPosition;
  anchorPage: number;
  headPage: number;
}

/**
 * 原生选区 → 模型上的锚点/焦点。
 *
 * 端点顺序从 `window.getSelection()` 自己读（Zotero `_getSelectionInfo()` 的做法）：
 * `range.startContainer` 永远是文档顺序里靠前的那一端，而**锚点**是按下的那一端，
 * 反向拖选时两者相反 —— "锚点在哪个栏"依赖这一点，搞错就会夹错栏。
 */
function resolveEndpoints(
  input: SelSnapshotInput,
  log: (...a: unknown[]) => void,
  resolveDomPosition: DomPositionResolver,
): EndpointPair | null {
  const eps = input.endpoints;
  if (!eps.length) return null;

  let anchorPos: NodePosition;
  let headPos: NodePosition;

  if (eps.length === 1) {
    const ep = eps[0];
    anchorPos = input.anchorIsStart ? ep.start : ep.end;
    headPos = input.anchorIsStart ? ep.end : ep.start;
  } else {
    // 跨页：`anchorIsStart` 为真时锚点在第一页的 start、焦点在最后一页的 end；反之对调。
    const first = eps[0];
    const last = eps[eps.length - 1];
    anchorPos = input.anchorIsStart ? first.start : last.end;
    headPos = input.anchorIsStart ? last.end : first.start;
  }

  const anchor = resolveDomPosition(anchorPos.node, anchorPos.offset, 'start');
  const head = resolveDomPosition(headPos.node, headPos.offset, 'end');
  if (!anchor || !head) {
    log('端点映射失败（原生选区不动）', { anchor, head });
    return null;
  }
  return { anchor, head, anchorPage: anchor.pageIndex, headPage: head.pageIndex };
}

/**
 * 跨栏硬禁止：把焦点收窄到"锚点所在栏流"里。
 *
 * 判据只有一条：取锚点字符的 `flowClass`，焦点所在字符若不是同一个 flowClass，
 * 就把焦点挪到**锚点流里离它最近的那个字符边界**上。
 */
function clampToAnchorFlow(
  model: PageCharModel,
  anchor: TextPosition,
  head: TextPosition,
  log: (...a: unknown[]) => void,
): TextPosition {
  const chars = model.chars;
  if (!chars.length) return head;
  const lastIdx = chars.length - 1;
  const anchorIdx = Math.max(0, Math.min(lastIdx, anchor.offset >= chars.length ? lastIdx : anchor.offset));
  const anchorFlow = chars[anchorIdx]?.flowClass;
  if (anchorFlow === undefined || anchorFlow === null) return head;

  if (head.pageIndex !== model.pageIndex) {
    // 跨页 + 锚点栏流隔离：焦点收回到锚点页该栏的末/首字
    const forward = head.pageIndex > model.pageIndex;
    const edge = edgeOffsetOfFlow(chars, anchorFlow, forward ? 'forward' : 'backward', anchorIdx);
    log('跨页焦点收回到锚点栏', { anchor: anchorIdx, headPage: head.pageIndex, edge, forward });
    return { pageIndex: model.pageIndex, offset: edge };
  }

  const headIdx = Math.max(0, Math.min(chars.length, head.offset));
  const inside =
    headIdx > anchorIdx
      ? chars.slice(anchorIdx, headIdx).every((c) => c.flowClass === anchorFlow)
      : chars.slice(headIdx, anchorIdx).every((c) => c.flowClass === anchorFlow);
  if (inside) return head;

  const forward = headIdx >= anchorIdx;
  const edge = edgeOffsetOfFlow(chars, anchorFlow, forward ? 'forward' : 'backward', anchorIdx);
  log('焦点越栏 → 收回到锚点栏边界', { anchor: anchorIdx, head: headIdx, edge, anchorFlow });
  return { pageIndex: model.pageIndex, offset: edge };
}

/**
 * 从某个字符出发沿 `direction` 走，返回"同一栏流连续区间"的边界。
 * @returns 向前走：区间**末字符序号 + 1**（正好是"选中到最后一个字"的 headOffset）；
 *          向后走：区间**首字符序号**。
 */
function edgeOffsetOfFlow(
  chars: PageCharModel['chars'],
  flow: string,
  direction: 'forward' | 'backward',
  offset: number,
): number {
  const start = Math.max(0, Math.min(chars.length - 1, offset));
  if (direction === 'forward') {
    let i = start;
    while (i < chars.length && chars[i].flowClass === flow) i += 1;
    return i;
  }
  let i = start;
  while (i >= 0 && chars[i].flowClass === flow) i -= 1;
  return i + 1;
}

/**
 * 文字比较用的宽松归一（只用于"要不要动 DOM"的判断，不参与选区内容）：
 * 空白折叠 + 去掉软连字符。
 */
function normalizeForCompare(text: string): string {
  return text.replace(/\u00AD/gu, '').replace(/\s+/gu, ' ').trim();
}

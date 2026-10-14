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
import { rectsDist, selectionDebugLog, selectionDebugState } from './selectionTypes';

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
  /**
   * 诊断日志开关。**运行时可开**，不用重新构建：
   * 在窗口控制台里执行 `__litshelfSelDebug(true)` 之后，每次划词都会打 `[zsel] …`，
   * 并把最近 200 条存在 `__litshelfSelLog` 里（用户按不了 F12 时靠它取证）。
   */
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
    if (deps.debug || selectionDebugState.enabled) selectionDebugLog(...args);
  };
  /**
   * 运行时状态面板：`window.__litshelfSelState()` 返回内核此刻的真实状态。
   *
   * 为什么要有：用户按不了 F12，而"我这边探针全绿、他那边全废"已经发生过一次 ——
   * 没有现场数据就只能猜。它回答三个最关键的问题：
   *   ① 这一页的字符模型建出来没有（`models` 里有没有这一页、多少字）；
   *   ② 上一次选区两个端点解析到了哪（`lastEndpoints`）；
   *   ③ 夹取到底跑了没有、结果是什么（`lastApply`）。
   */
  const state: {
    models: Map<number, number>;
    lastEndpoints: unknown;
    lastApply: unknown;
  } = { models: new Map(), lastEndpoints: null, lastApply: null };

  let owns = false;
  /**
   * 上一次我们写入选区的时间与"写完之后的原生文字"。
   *
   * 判据必须跟**原生文字**比，不能跟模型文字比：浏览器 `selection.toString()` 的空白
   * （换行、行末空格）与模型拼出来的文字不可能逐字相同，跟模型比就永远不相等 →
   * 每次补夹都再写一遍（真实窗口实测：1 秒内连写 9 次，选区结果对但白耗 CPU 且自激）。
   */
  const lastWrite = { at: 0, native: '' };
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
    const head = clampToAnchorColumn(anchorEntry.model, pair.anchor, pair.head, log);
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
    /**
     * **收尾夹**：把每一段的端点收进"锚点栏流的连续区间"。
     *
     * 为什么还要夹一次：`clampToAnchorFlow` 只是把**焦点位置**挪到区间边界，后面算 range 时
     * 还会经过 pdf.js 语义、flow 过滤、跨页拆分等几步，实测会多走 1~2 个字符
     * （10 个多栏页里有 3 页端点是 `[1172]` 而区间上界是 `1170`）—— 差一两个字就正好**越进隔壁栏**。
     * 这里按同一判据再收一次，保证"夹完一定在锚点流内"是**模型级不变量**，不依赖上游每一步都对。
     */
    const runOf = (anchorOffset: number): { lo: number; hi: number } | null => {
      const chars = anchorEntry.model.chars;
      if (!chars.length) return null;
      const start = Math.max(0, Math.min(chars.length - 1, anchorOffset >= chars.length ? chars.length - 1 : anchorOffset));
      const flow = chars[start]?.flowClass;
      if (flow === undefined || flow === null) return null;
      let lo = start;
      while (lo > 0 && chars[lo - 1].flowClass === flow) lo -= 1;
      let hi = start;
      while (hi < chars.length - 1 && chars[hi + 1].flowClass === flow) hi += 1;
      return { lo, hi };
    };
    const run = runOf(pair.anchor.offset);
    const trimmed = run
      ? ranges.map((r) => {
          if (!r || r.collapsed || r.position.pageIndex !== pair.anchorPage) return r;
          const lo = run.lo;
          const hi = run.hi + 1; // 端点可以等于"最后一个字之后"
          const a = Math.max(lo, Math.min(hi, r.anchorOffset));
          const h = Math.max(lo, Math.min(hi, r.headOffset));
          if (a === r.anchorOffset && h === r.headOffset) return r;
          return { ...r, anchorOffset: a, headOffset: h, collapsed: a === h };
        })
      : ranges;
    if (!trimmed.length || trimmed.every((r) => r.collapsed)) return null;
    return { ranges: trimmed, head };
  };

  /** 一次原生选区 → 纯计算结果（不写 DOM） */
  const resolveEndpoints = (
    input: SelSnapshotInput,
  ): EndpointPair | null => {
    const pair = resolveEndpointsFor(input, log, deps.resolveDomPosition);
    state.lastEndpoints = pair
      ? {
          anchor: { page: pair.anchorPage, offset: pair.anchor.offset },
          head: { page: pair.headPage, offset: pair.head.offset },
          anchorIn: pair.anchorPage + 1,
          headIn: pair.headPage + 1,
        }
      : { failed: true };
    return pair;
  };

  const computeSnapshot = (
    input: SelSnapshotInput,
  ): { snapshot: SelSnapshot | null; ranges: ResolvedRangeLike[] | null; pair: EndpointPair | null } => {
    const pair = resolveEndpoints(input);
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
    if (!snapshot || !ranges || !pair) {
      state.lastApply = { skipped: !snapshot ? 'no-snapshot' : !ranges ? 'no-ranges' : 'no-pair' };
      return null;
    }

    // 端点已经被收窄过吗？没收窄（模型文字 == 原生选区文字）→ 一个字节都不写 DOM。
    // 这条是"手感"的底线：用户拖出来的正常选区绝不能被我们动过。
    if (normalizeForCompare(sel.toString()) === normalizeForCompare(snapshot.text)) {
      log('选区本来就合法，不写 DOM', { chars: snapshot.text.length });
      state.lastApply = { skipped: 'already-valid', chars: snapshot.text.length };
      owns = true;
      lastWrite.at = 0;
      lastWrite.native = '';
      return null;
    }
    /**
     * **刚写过就别再写**（幂等）。
     *
     * 为什么要这条：浏览器 `selection.toString()` 的空白（换行、行末空格）与我们用模型拼出来的
     * 文字**不可能逐字相同**，所以上面那条"已经合法"的判据在"刚夹过"之后**永远不成立** ——
     * mouseup 后的每一拍补夹、每一条 `selectionchange` 都会再写一次
     * （真实窗口实测：1 秒内连写 9 次）。选区结果是对的，但白耗 CPU，而且每次写又会触发新的
     * `selectionchange`，形成无意义的循环。
     */
    if (
      lastWrite.at &&
      Date.now() - lastWrite.at < 400 &&
      normalizeForCompare(sel.toString()) === normalizeForCompare(lastWrite.native)
    ) {
      state.lastApply = { skipped: 'just-wrote', chars: snapshot.text.length };
      return null;
    }

    const entry = pageEntry(pair.anchorPage);
    const textLayer = entry?.pageEl.querySelector<HTMLElement>('.rd-pdf-text') ?? null;
    if (!entry || !textLayer) {
      log('拿不到锚点页的文本层，放弃夹取');
      state.lastApply = { skipped: 'no-layer' };
      return null;
    }
    const index = domIndexFor(entry.model, textLayer);
    if (index.domTotal !== index.total) {
      log('DOM 字符数与模型不一致，放弃夹取', { dom: index.domTotal, model: index.total });
      state.lastApply = { skipped: 'dom-mismatch', dom: index.domTotal, model: index.total };
      return null;
    }
    const anchorRange = ranges.find((r) => r.anchor) ?? ranges[0];
    const headRange = ranges.find((r) => r.head) ?? ranges[ranges.length - 1];
    const a = domPositionOf(index, Math.min(anchorRange.anchorOffset, anchorRange.headOffset));
    const b = domPositionOf(index, Math.max(headRange.anchorOffset, headRange.headOffset));
    if (!a || !b) {
      log('夹取后的端点建不出 DOM 位置，放弃', { a, b });
      state.lastApply = { skipped: 'no-dom-position' };
      return null;
    }
    try {
      sel.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
    } catch (err) {
      log('setBaseAndExtent 失败', err);
      state.lastApply = { skipped: 'set-failed' };
      return null;
    }
    owns = true;
    lastWrite.at = Date.now();
    lastWrite.native = sel.toString();
    state.lastApply = { wrote: true, modelChars: snapshot.text.length, head: snapshot.text.slice(0, 40) };
    log('夹取：原生 → 模型', { native: sel.toString().length, model: snapshot.text.length, head: snapshot.text.slice(0, 40) });
    return snapshot;
  };

  // 运行时状态面板（见上面 state 的注释）：
  if (typeof window !== 'undefined') {
    (window as unknown as { __litshelfSelState?: () => unknown }).__litshelfSelState = () => ({
      pages: [...state.models.entries()].map(([page, chars]) => ({ page: page + 1, chars })),
      lastEndpoints: state.lastEndpoints,
      lastApply: state.lastApply,
      owns,
    });
  }

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
function resolveEndpointsFor(
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
 * 跨栏硬禁止：把焦点收窄到**锚点所在的那一栏**。
 *
 * ## 为什么不用"锚点流的连续区间"（我做过，错的）
 *
 * 我原来是"取锚点字符的流 → 沿数组向两侧扩成连续区间 → 把焦点夹进区间"。
 * 这依赖一个隐含假设：**模型里的字符顺序 = 版面顺序**。而真实 PDF 的内容流顺序、
 * pdf.js 渲染后的 DOM 顺序、我建模型时的顺序**三者并不总是一致**，于是：
 * 真实窗口实测 —— 在栏 1 里横拖到栏 2，写回去的选区变成"**页眉 17 个字**"、矩形横跨整页。
 * 也就是说：夹取的方向对，但**夹到了完全不同的地方**。
 *
 * ## 现在的判据（纯几何，不依赖任何顺序）
 *
 * 1. 锚点字符在**哪一栏**（`flowClass`，由字符中心的 x 落在哪条栏带决定）→ `anchorBand`；
 * 2. 焦点字符不在同一栏 → 把焦点挪到**离它最近的、且属于 anchorBand 的字符边界**：
 *    · 优先"焦点所在的横向位置"那一侧（选到哪就夹到哪，不会把选区反向拉回去）；
 *    · 找不到就退化成"离焦点最近的那个同栏字符"。
 * 3. 拿不到栏信息（单栏页整页一个 flowClass）→ 原样返回，一个字节都不动。
 *
 * 这条判据只看"每个字符属于哪一栏"，与字符在数组里的先后无关 —— 顺序再乱也不会夹到别处去。
 */
function clampToAnchorColumn(
  model: PageCharModel,
  anchor: TextPosition,
  head: TextPosition,
  log: (...a: unknown[]) => void,
): TextPosition {
  const chars = model.chars;
  if (!chars.length) return head;
  const last = chars.length - 1;
  const clampIdx = (v: number): number => (v < 0 ? 0 : v > last ? last : v);
  const anchorIdx = clampIdx(anchor.offset);
  const anchorFlow = chars[anchorIdx]?.flowClass;
  if (anchorFlow === undefined || anchorFlow === null) return head;
  if (head.pageIndex !== model.pageIndex) {
    // 跨页：焦点收回到锚点栏里离它最近的字（用户的"不许跨栏"优先于"跨页"）
    const near = nearestSameColumn(chars, anchorFlow, chars[anchorIdx]);
    log('跨页焦点收回到锚点栏', { anchor: anchorIdx, headPage: head.pageIndex, to: near });
    return { pageIndex: model.pageIndex, offset: near };
  }
  const headIdx = clampIdx(head.offset >= chars.length ? last : head.offset);
  if (chars[headIdx]?.flowClass === anchorFlow) return head; // 同栏：不动
  const near = nearestSameColumn(chars, anchorFlow, chars[headIdx], chars[anchorIdx]);
  if (near < 0) return head;
  log('焦点不在锚点栏 → 收回到同栏最近的字', {
    anchor: anchorIdx,
    head: headIdx,
    anchorFlow,
    headFlow: chars[headIdx]?.flowClass,
    to: near,
  });
  return { pageIndex: model.pageIndex, offset: near };
}

/**
 * 找"属于 `flow` 的、离 `from` 最近"的字符边界。
 * 用**字符盒子的距离**（`rectsDist`）算，不看数组下标，所以顺序无关。
 * @returns 字符序号；找不到返回 -1
 */
function nearestSameColumn(
  chars: PageCharModel['chars'],
  flow: string,
  from: { rect: [number, number, number, number] },
  prefer?: { rect: [number, number, number, number] },
): number {
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  let bestPreferred = Number.POSITIVE_INFINITY;
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i].flowClass !== flow) continue;
    // 用该字符所在行的 inlineRect 比距离（单个字的盒子太窄，容易比出奇怪的结果）
    const box = chars[i].inlineRect ?? chars[i].rect;
    const d = rectsDist(from.rect, box);
    const dp = prefer ? rectsDist(prefer.rect, box) : 0;
    // 先比"离焦点近"，再比"离锚点近"（避免夹到栏里离焦点很远的那一头）
    if (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && dp < bestPreferred)) {
      bestD = d;
      bestPreferred = dp;
      best = i;
    }
  }
  return best;
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

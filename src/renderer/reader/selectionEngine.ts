/**
 * 划词选取引擎（接管型）—— **不使用浏览器的原生选区**。
 *
 * ## 为什么是"接管型"（血泪史，别改回去）
 *
 * 这个产品的划词前后修了 10 轮左右，全部翻在同一件事上：**同时存在两个"选区"**。
 *   · 浏览器原生选区：按 **DOM 顺序**扩展，而中文期刊 PDF 的**内容流顺序 ≠ 版面顺序**；
 *   · 字符模型：按几何算，知道每个字在哪一栏、哪一行。
 * 只要两者不一致，"在浏览器选区上做纠正"就必然出错（真机实测最坏结果：在栏 1 里竖着拖，
 * 写回去的选区落到页眉上、高亮横跨整页）。所以这里把浏览器从"选取"里彻底踢出去：
 *
 *   1. 文本层 `user-select: none` —— 浏览器不再产生任何选区；
 *   2. **拖动 = 指针位置**：按下点的字 = 锚点，指针当前的字 = 焦点，**每次移动重算**；
 *   3. **不许跨块**：焦点只允许落在锚点那一个"块"里（见下），跨栏在结构上不可能；
 *   4. **高亮自己画**：按行合并，一行一条矩形 —— 天然连续，不存在"逐字拼接/跳块"；
 *   5. 复制自己写剪贴板。
 *
 * ## 分块：像人一样看页面（本文件的核心）
 *
 * 人判断版面结构只用三样东西：**位置、空白、字形**（字号/行高）。分块判据因此也只有这三样，
 * **不用"宽度占比"这类自造阈值**：
 *
 *   · **栏缝**：双栏的特征不是"某一行断开"，而是**很多行在同一个 x 位置都断开**。
 *     所以栏缝判定 = "同一个 x 位置，至少 2 行在这里有宽间隙"。
 *     单栏论文永远得不出栏缝 —— 这一条同时修掉了"单栏页正文被误删"（用户报的"部分页无法选取"）。
 *   · **断块**：垂直空白（> 0.8 行高）或字号突变（标题/正文/脚注的差异）。
 *   · **并块**：垂直连续 + 字号相近 → 同一块（所以**一栏内的段落之间不断开**）。
 *   · **阅读顺序**：先上下（行带），同带内左右（栏）；双栏页得到 `页眉 → 左栏 → 右栏 → 脚注`。
 *   · **不排除任何内容**：页眉、脚注、页码、水印、"中国知网"这类标识各自成块、**都能划**、
 *     互不串（因为它们分属不同的块）。用户明确要求"Zotero 也能划"，所以不屏蔽。
 *
 * 明令禁止（写在这里防止后人再犯）：
 *   ① 禁止用"宽度 ≥ X%"判断页眉/通栏 —— 单栏论文的正文宽度同样接近页宽；
 *   ② 禁止"看起来像页眉就删掉一整块" —— 那会把正文删没。
 */

import type { PageCharModel, ZoteroChar } from './selectionTypes';

/** 一个矩形（**客户端坐标**：相对浏览器窗口内容区左上角） */
export type EngineRect = [number, number, number, number];

/** 一次可用的选区（模型坐标 + 客户端矩形） */
export interface EngineSelection {
  pageIndex: number;
  /** 起点（含）与终点（不含）的字符序号（参考值；真实顺序由块决定） */
  start: number;
  end: number;
  /** 选中的文字（按块的视觉顺序拼，行末补空格） */
  text: string;
  /** 每行一条矩形（客户端坐标）：行内取"首字左边界 → 末字右边界" */
  rects: EngineRect[];
  /** 选中的字符序号（按视觉顺序），给上层做精确映射用 */
  charIndices: number[];
}

export interface PageHandle {
  pageIndex: number;
  pageEl: HTMLElement;
  textLayer: HTMLElement;
  model: PageCharModel;
}

export interface EngineDeps {
  /** 当前可见/可选的页面（顺序无所谓，命中用几何判定） */
  pages: () => PageHandle[];
  /** 高亮层容器（**固定在视口上**，矩形是客户端坐标，直接摆进去即可） */
  overlay: () => HTMLElement | null;
  /** 选区变化时通知外部（工具条定位、上报批注等） */
  onSelection: (selection: EngineSelection | null) => void;
  /** 命中容差（CSS 像素）：指针离字多远还算"点在字上"。默认 14 */
  hitTolerance?: number;
  debug?: boolean;
}

export interface SelectionEngine {
  /** 拖动开始（在页面上按下）：用按下点定锚点（以及它所在的块） */
  begin(clientX: number, clientY: number, extend?: boolean): boolean;
  /** 拖动中：用指针当前位置定焦点（每次移动都调用，无节流也无副作用） */
  move(clientX: number, clientY: number): void;
  /** 松手：收尾（保留选区） */
  end(): void;
  /** 清空选区与高亮 */
  clear(): void;
  /** 当前选区 */
  current(): EngineSelection | null;
  /** 页面模型/尺寸变了（重建文本层、缩放）时调用 */
  refresh(): void;
  /** 销毁：摘掉高亮 */
  destroy(): void;
}

// ---------------------------------------------------------------- 小工具

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const rectOf = (c: ZoteroChar | undefined): readonly [number, number, number, number] =>
  c ? (c.inlineRect ?? c.rect) : [0, 0, 0, 0];

/** 一行（视觉行） */
interface Line {
  chars: number[];
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** 该行字盒高度的中位数（≈ 字号） */
  charHeight: number;
}

/** 一个"块"（人眼看到的一个阅读单元：一栏、页眉带、脚注、角标…） */
interface Block {
  lines: Line[];
  /** 按视觉顺序排好的字符序号 */
  order: number[];
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** 块内字高中位数（≈ 字号），用于和相邻行比"字形是否突变" */
  size: number;
}

// ---------------------------------------------------------------- 行归一

/**
 * 字 → 行。
 *
 * ⚠️ 必须按"行带纵向重叠"归行，**不能按 `inlineRect.top` 精确相等**：
 * 真实 PDF 里同一视觉行的 top 会差 1~4px（字体 ascent 不同），
 * 按 top 相等归行会把标题行拆成 3~4 行（真机实测），后面全跟着错。
 */
function buildLines(chars: readonly ZoteroChar[]): Line[] {
  const heights: number[] = [];
  const widths: number[] = [];
  for (const c of chars) {
    if (!c) continue;
    const r = rectOf(c);
    const h = r[3] - r[1];
    if (h > 0) heights.push(h);
    const w = c.rect[2] - c.rect[0];
    if (w > 0) widths.push(w);
  }
  heights.sort((a, b) => a - b);
  widths.sort((a, b) => a - b);
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  const medianW = widths.length ? widths[Math.floor(widths.length / 2)] : 8;
  /**
   * 归行时的"横向断开"阈值：同一个视觉行里的字，横向间距不会超过 2 个字宽。
   *
   * ⚠️ **只按纵向重叠归行会把左右两栏的字并成一行**（真机实测：第23篇第 1 页出现过
   * "39 个字的行"，left=280 / right=1076，横跨两栏）。后果是后面"条带内找断口"永远找不到
   * （断口被并进了行内部），左右栏并成一块 → 在栏 1 里拖会选到右栏。
   */
  const maxInnerGap = Math.max(6, medianW * 2.5);

  const order = Array.from({ length: chars.length }, (_, i) => i).filter((i) => chars[i]);
  order.sort((a, b) => rectOf(chars[a])[1] - rectOf(chars[b])[1] || rectOf(chars[a])[0] - rectOf(chars[b])[0]);

  const open: Line[] = [];
  for (const i of order) {
    const r = rectOf(chars[i]);
    const line = open.find((ln) => {
      const overlap = Math.min(ln.bottom, r[3]) - Math.max(ln.top, r[1]);
      const minH = Math.min(ln.bottom - ln.top, r[3] - r[1]);
      if (!(minH > 0 && overlap >= minH * 0.6)) return false;
      // 横向必须"接着"：与这一行已有的横向范围之间的空隙不能太大
      const gap = r[0] > ln.right ? r[0] - ln.right : ln.left > r[2] ? ln.left - r[2] : 0;
      return gap <= maxInnerGap;
    });
    if (line) {
      line.chars.push(i);
      line.top = Math.min(line.top, r[1]);
      line.bottom = Math.max(line.bottom, r[3]);
      line.left = Math.min(line.left, r[0]);
      line.right = Math.max(line.right, r[2]);
    } else {
      open.push({ chars: [i], top: r[1], bottom: r[3], left: r[0], right: r[2], charHeight: medianH });
    }
  }

  for (const ln of open) {
    ln.chars.sort((a, b) => rectOf(chars[a])[0] - rectOf(chars[b])[0]);
  }

  /**
   * **把"横跨两栏的行"切成两行**（判据只用"字距"这个字形量）。
   *
   * ## 为什么必须切
   * 双栏页里左右两栏在同一 y 上有字，归行（纵向重叠）会把它们并成一条"行"：
   * 真机实测第23篇第 1 页第 2 行 = 52 个字、横跨 178→1179（左栏 32 字 + 右栏 20 字）。
   * 后果：左右栏并成一块 → 在栏 1 里拖会选到右栏。
   *
   * ## 判据（这里踩过坑，写清楚）
   * 用"这一行内的间隙中位数"当正常字距，凡是超过 **1.8 倍字距**的间隙就切断。
   * 我一开始用 4 倍 + 绝对阈值（2.5 字宽 / 15% 页宽），真机实测**差一点点没切开**
   * （真实栏缝 71px，正常字距 20px，71/20 = 3.55 < 4）。
   * 教训：**阈值不要卡在临界值上**；中文两端对齐的字距本身就很均匀，1.8 倍足够区分栏缝。
   */
  const splitLines: Line[] = [];
  const linesBefore = open.length;
  for (const ln of open) {
    if (ln.chars.length < 2) {
      splitLines.push(ln);
      continue;
    }
    const gaps: { at: number; w: number; k: number }[] = [];
    for (let k = 1; k < ln.chars.length; k += 1) {
      const prev = rectOf(chars[ln.chars[k - 1]]);
      const cur = rectOf(chars[ln.chars[k]]);
      gaps.push({ at: (prev[2] + cur[0]) / 2, w: cur[0] - prev[2], k });
    }
    const sortedW = gaps.map((g) => g.w).sort((a, b) => a - b);
    const medianGap = sortedW[Math.floor(sortedW.length / 2)];
    const breakAt = gaps.filter((g) => g.w > Math.max(8, medianGap * 1.8)).map((g) => g.k);
    if (!breakAt.length) {
      splitLines.push(ln);
      continue;
    }
    let from = 0;
    for (const cut of [...breakAt, ln.chars.length]) {
      const part = ln.chars.slice(from, cut);
      if (part.length) splitLines.push(makeLine(part, chars, medianH));
      from = cut;
    }
  }
  open.length = 0;
  open.push(...splitLines);

  for (const ln of open) {
    const hs = ln.chars
      .map((i) => rectOf(chars[i])[3] - rectOf(chars[i])[1])
      .filter((h) => h > 0)
      .sort((a, b) => a - b);
    ln.charHeight = hs.length ? hs[Math.floor(hs.length / 2)] : medianH;
  }

  /**
   * ⚠️ 这里曾经有一段"用行内字距重算行宽、把字重新落位"的修正 —— **已删除**，原因记下来：
   * 行里混着空格/标点时，字距的**中位数**会被拉小（实测中文 22px、混空格后 10px），
   * 按这个中位数重排会把整行的字**压成一团**（真机实测：一行 38 个字全塌到同一个 x），
   * 选区跟着全乱。而它本来想解决的问题（行看起来偏宽）并不存在：
   * `buildLineRects` 用的是**首末字各自的真实边界**，行矩形本来就是准的。
   */
  open.sort((a, b) => a.top - b.top || a.left - b.left);
  return open;
}

/** 用一组字符序号造一条行（保持纵向范围/字高中位数） */
function makeLine(part: readonly number[], chars: readonly ZoteroChar[], fallbackH: number): Line {
  const rects = part.map((i) => rectOf(chars[i]));
  const hs = rects
    .map((r) => r[3] - r[1])
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  return {
    chars: part.slice().sort((a, b) => rectOf(chars[a])[0] - rectOf(chars[b])[0]),
    top: Math.min(...rects.map((r) => r[1])),
    bottom: Math.max(...rects.map((r) => r[3])),
    left: Math.min(...rects.map((r) => r[0])),
    right: Math.max(...rects.map((r) => r[2])),
    charHeight: hs.length ? hs[Math.floor(hs.length / 2)] : fallbackH,
  };
}

// ---------------------------------------------------------------- 栏缝

/**
 * 行 → 块：**像人一样分**。
 *
 * ## 判据（只有位置/空白/字形三样）
 *
 * 1. **先分"条带"（strip）**：把行按 y 排好，相邻两行之间的垂直间隙 ≤ 1.2 倍行高就归同一条带。
 *    条带 = "人眼看上去连成一片的那一块"（一栏正文、页眉那一条、脚注那一段、右下角页码）。
 * 2. **条带内再按横向间隙切分**：找这一条带里**所有行的共同横向断口**
 *    （取所有行里最宽的那个间隙位置），够宽（≥ 20% 页宽）且两侧都有字 → 切成左右两块（两栏）。
 *    单栏排版不会出现"贯穿整条带的断口"，所以单栏页永远切不出来。
 * 3. 块内字符按"行上→下、行内左→右"排 = 视觉顺序。
 * 4. 块的顺序：先上下（条带），同带内左右。
 *
 * ## 为什么不用 flowClass、也不用"全页找栏缝"
 *
 * 试错记录（真机实测）：
 *   · `flowClass`：单栏扫描件会把它切成 `4:0/4:1` 两段；单栏页的标题和正文有时同属一个 flowClass →
 *     判成"通栏"被摘掉 → **整页选不中**（用户报的"部分页无法选取"）。
 *   · "全页按间隙位置聚合找栏缝"：这批中文期刊的行距小、各行断口位置不齐，检出的"栏缝"会落在
 *     **栏中间**（实测 639，真实在 570 附近）→ 左栏被劈开 → **每行单独成块**（36~49 行各自一块）。
 *   · "按'全页相邻行的间隙'算行高"：双栏页左右栏行交错 → 间隙中位数 ≈ 1px → 并块阈值失效，
 *     每行单独成块。所以行高必须在**条带内部**算。
 *
 * 教训：判据必须落在"人眼看到的整体结构"上（条带 + 带内断口），不要用"逐行聚合出来的统计量"。
 */
function buildBlocks(lines: readonly Line[], chars: readonly ZoteroChar[], medianCharWidth: number): Block[] {
  if (!lines.length) return [];

  /** 行高：全页相邻行的垂直间隙中位数（下面用它判断"这一段结束了"） */
  const gaps: number[] = [];
  for (let k = 1; k < lines.length; k += 1) {
    const g = lines[k].top - lines[k - 1].bottom;
    if (g > 0) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const lineH = gaps.length ? Math.max(4, gaps[Math.floor(gaps.length / 2)]) : 12;

  /**
   * # 行 → 块（按方案里的规则，逐行决定"并入哪一块"）
   *
   * 并块条件（只有位置/空白/字形三样）：
   *   · 与块内某行 **纵向重叠**（同一视觉行）且 **横向基本重叠**（重叠 > 较短一边的 50%）→ 并入；
   *     左边一栏的行与右边一栏的行横向重叠很小 → 自然分成两块。
   *   · 与块 **纵向相邻**（间隙 ≤ 0.8 行高）且 **横向基本重叠** → 并入（同一栏的下一行）。
   *   · 否则新建块（页眉/标题/脚注被空白隔开，或左右栏横向分开）。
   *
   * ⚠️ 我上一版"先按纵向间隙切条带、再在带内找断口"是错的：双栏页左右栏的行**交错**排列，
   * "相邻两行的间隙"很小，于是整页被切成一条带 → 2261 字 87 行并成一块（真机实测）。
   * 教训：并块要从"行的横向位置"入手（同一栏的行横向范围一样），不要先按纵向切带。
   */
  const overlapRatio = (a: readonly [number, number], b: readonly [number, number]): number => {
    const ov = Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
    if (ov <= 0) return 0;
    const minLen = Math.min(a[1] - a[0], b[1] - b[0]);
    return minLen > 0 ? ov / minLen : 0;
  };

  const blocks: Block[] = [];
  for (const ln of lines) {
    let best: Block | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const blk of blocks) {
      const ratio = overlapRatio([blk.left, blk.right], [ln.left, ln.right]);
      if (ratio < 0.6) continue; // 横向不是同一栏
      const vOverlap = Math.min(blk.bottom, ln.bottom) - Math.max(blk.top, ln.top);
      const vGap = Math.max(blk.top, ln.top) - Math.min(blk.bottom, ln.bottom);
      if (vOverlap <= 0 && vGap > Math.max(4, lineH * 1.4)) continue; // 离得太远，是另一段（段间距通常 <= 1 行高）
      // 字号突变（标题/正文/脚注）也断开 —— 但要和"同一块里的正常波动"区分：只在差 > 30% 时断
      const hi = Math.max(blk.size, ln.charHeight);
      const lo = Math.min(blk.size, ln.charHeight);
      if (lo > 0 && hi / lo > 1.3 && vOverlap <= 0) continue;
      if (vGap < bestGap) {
        bestGap = vGap;
        best = blk;
      }
    }
    if (best) {
      best.lines.push(ln);
      best.top = Math.min(best.top, ln.top);
      best.bottom = Math.max(best.bottom, ln.bottom);
      best.left = Math.min(best.left, ln.left);
      best.right = Math.max(best.right, ln.right);
    } else {
      blocks.push({
        lines: [ln],
        order: [],
        top: ln.top,
        bottom: ln.bottom,
        left: ln.left,
        right: ln.right,
        size: ln.charHeight,
      });
    }
  }

  for (const blk of blocks) {
    blk.lines.sort((a, b) => a.top - b.top || a.left - b.left);
    blk.order = blk.lines.flatMap((r) => r.chars);
    const sizes = blk.lines.map((r) => r.charHeight).filter((h) => h > 0).sort((a, b) => a - b);
    blk.size = sizes.length ? sizes[Math.floor(sizes.length / 2)] : blk.size;
  }
  // 块的顺序：先上下，同带内左右（= 人读的顺序）
  blocks.sort((a, b) => a.top - b.top || a.left - b.left);
  if (typeof window !== 'undefined') {
    (window as unknown as { __litshelfStripDiag?: unknown }).__litshelfStripDiag = {
      lineH: Math.round(lineH),
      lines: lines.length,
      blocks: blocks.map((b) => ({ chars: b.order.length, lines: b.lines.length, left: Math.round(b.left), right: Math.round(b.right) })),
    };
  }
  return blocks;
}

/** 分块结果缓存：模型对象 + 页面像素尺寸为键（缩放后尺寸变 → 自动重算） */
const blockCache = new WeakMap<PageCharModel, { key: string; blocks: Block[] }>();

function blocksFor(model: PageCharModel, pageEl: HTMLElement): { blocks: Block[] } {
  const r = pageEl.getBoundingClientRect();
  const key = `${Math.round(r.width)}x${Math.round(r.height)}`;
  const cached = blockCache.get(model);
  if (cached && cached.key === key) return { blocks: cached.blocks };

  const chars = model.chars;
  const lines = buildLines(chars);
  const widths = chars
    .map((c) => c.rect[2] - c.rect[0])
    .filter((w) => w > 0)
    .sort((a, b) => a - b);
  const medianCharWidth = widths.length ? widths[Math.floor(widths.length / 2)] : 8;
  const blocks = buildBlocks(lines, chars, medianCharWidth);
  blockCache.set(model, { key, blocks });

  // 诊断：每块多少字、多少行（自动化验收读它）
  if (typeof window !== 'undefined') {
    (window as unknown as { __litshelfGroupDiag?: unknown }).__litshelfGroupDiag = blocks.map((b) => ({
      chars: b.order.length,
      lines: b.lines.length,
      left: Math.round(b.left),
      right: Math.round(b.right),
      top: Math.round(b.top),
    }));
  }
  return { blocks };
}

/** 客户端坐标 → 命中页面的辅助：页面必须可见（尺寸 > 0） */

// ---------------------------------------------------------------- 引擎

export function createSelectionEngine(deps: EngineDeps): SelectionEngine {
  const tol = num(deps.hitTolerance, 14);
  const log = (...args: unknown[]): void => {
    if (deps.debug) console.debug('[sel-engine]', ...args);
  };

  let anchor: { pageIndex: number; offset: number; block: Block | null } | null = null;
  let head: { pageIndex: number; offset: number } | null = null;
  let selection: EngineSelection | null = null;
  let overlayHost: HTMLElement | null = null;
  const highlights: HTMLElement[] = [];

  /** 把最后一次选区挂到 window：自动化验收（真实鼠标 + 截图）要读它；正常使用无副作用 */
  const publish = (sel: EngineSelection | null): void => {
    if (typeof window === 'undefined') return;
    (window as unknown as { __litshelfEngineSel?: EngineSelection | null }).__litshelfEngineSel = sel;
  };

  /** 指针 → 字符序号（**页面坐标系**） */
  const charIndexAt = (page: PageHandle, x: number, y: number, hitTol: number): number => {
    const chars = page.model.chars;
    if (!chars.length) return -1;
    const lineContains = (c: ZoteroChar): boolean => {
      const line = rectOf(c);
      return y >= line[1] && y <= line[3];
    };
    const scoreInLine = (c: ZoteroChar): number => {
      if (x >= c.rect[0] && x <= c.rect[2]) return 0;
      return 1 + Math.abs(x - (c.rect[0] + c.rect[2]) / 2) / 1000;
    };
    const lineDy = (c: ZoteroChar): number => {
      const line = rectOf(c);
      if (y < line[1]) return line[1] - y;
      if (y > line[3]) return y - line[3];
      return 0;
    };
    let best = -1;
    let bestKey = Number.POSITIVE_INFINITY;
    for (let k = 0; k < chars.length; k += 1) {
      const c = chars[k];
      if (lineDy(c) > hitTol) continue;
      const key = lineContains(c) ? scoreInLine(c) : 2 + lineDy(c) / 1000;
      if (key < bestKey - 1e-9) {
        bestKey = key;
        best = k;
      }
    }
    if (best >= 0) return best;
    // 容差内一个都没有（指针在行间/栏缝里）：横向为主 + 纵向重罚
    let near = -1;
    let nearKey = Number.POSITIVE_INFINITY;
    for (let k = 0; k < chars.length; k += 1) {
      const line = rectOf(chars[k]);
      const dx = x < line[0] ? line[0] - x : x > line[2] ? x - line[2] : 0;
      const dy = y < line[1] ? line[1] - y : y > line[3] ? y - line[3] : 0;
      const key = dx + dy * 8;
      if (key < nearKey) {
        nearKey = key;
        near = k;
      }
    }
    return nearKey <= Math.max(hitTol * 20, 400) ? near : -1;
  };

  /** 客户端坐标 → 命中的页面 + 页面坐标 + 字符序号 */
  const hit = (clientX: number, clientY: number): { page: PageHandle; x: number; y: number; offset: number } | null => {
    const all = deps.pages();
    if (typeof window !== 'undefined') {
      (window as unknown as { __litshelfEnginePages?: number }).__litshelfEnginePages = all.length;
    }
    for (const page of all) {
      const rect = page.pageEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (clientX < rect.left - tol || clientX > rect.right + tol || clientY < rect.top - tol || clientY > rect.bottom + tol) continue;
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const offset = charIndexAt(page, x, y, tol);
      if (offset < 0) continue;
      return { page, x, y, offset };
    }
    return null;
  };

  const blockOfChar = (blocks: readonly Block[], offset: number): Block | null => {
    for (const blk of blocks) {
      if (blk.order.includes(offset)) return blk;
    }
    return null;
  };

  /** 块内、离页面坐标点最近的字符序号（这就是"不许跨块"的落点） */
  const nearestInBlock = (blk: Block, chars: readonly ZoteroChar[], x: number, y: number): number => {
    let best = blk.order[0] ?? -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (const i of blk.order) {
      const r = chars[i].rect;
      const d = Math.hypot((r[0] + r[2]) / 2 - x, (r[1] + r[3]) / 2 - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  /** 按行合并矩形（客户端坐标）：每行一条，从该行首字左边界到末字右边界 */
  const buildLineRects = (
    chars: readonly ZoteroChar[],
    idx: readonly number[],
    origin: { left: number; top: number },
  ): EngineRect[] => {
    const byLine = new Map<number, { left: number; right: number; top: number; bottom: number }>();
    for (const i of idx) {
      const c = chars[i];
      if (!c) continue;
      const line = rectOf(c);
      const key = Math.round(line[1]);
      const cur = byLine.get(key);
      if (!cur) {
        byLine.set(key, { left: c.rect[0], right: c.rect[2], top: line[1], bottom: line[3] });
        continue;
      }
      if (c.rect[0] < cur.left) cur.left = c.rect[0];
      if (c.rect[2] > cur.right) cur.right = c.rect[2];
      if (line[1] < cur.top) cur.top = line[1];
      if (line[3] > cur.bottom) cur.bottom = line[3];
    }
    return [...byLine.values()]
      .sort((a, b) => a.top - b.top)
      .map((r) => [r.left + origin.left, r.top + origin.top, r.right + origin.left, r.bottom + origin.top] as EngineRect);
  };

  /** 选中文字（按视觉顺序拼，行末补空格） */
  const textOf = (chars: readonly ZoteroChar[], idx: readonly number[]): string => {
    const out: string[] = [];
    for (const i of idx) {
      const c = chars[i];
      if (!c || c.ignorable) continue;
      out.push(c.c);
      if (c.spaceAfter) out.push(' ');
    }
    return out.join('').trim();
  };

  const paint = (): void => {
    const host = deps.overlay() ?? overlayHost;
    if (!host) return;
    for (const el of highlights) el.remove();
    highlights.length = 0;
    if (!selection) return;
    for (const [x1, y1, x2, y2] of selection.rects) {
      const div = host.ownerDocument.createElement('div');
      div.className = 'sel-line';
      div.style.position = 'absolute';
      div.style.left = `${x1}px`;
      div.style.top = `${y1}px`;
      div.style.width = `${Math.max(1, x2 - x1)}px`;
      div.style.height = `${Math.max(1, y2 - y1)}px`;
      div.style.pointerEvents = 'none';
      host.appendChild(div);
      highlights.push(div);
    }
  };

  const clearSelection = (): void => {
    selection = null;
    paint();
    publish(null);
    deps.onSelection(null);
  };

  /** 重建选区：**只在锚点所在的块里取一段连续区间**（跨块在结构上不可能） */
  const rebuild = (): void => {
    if (!anchor || !head || !anchor.block) {
      clearSelection();
      return;
    }
    const page = deps.pages().find((p) => p.pageIndex === anchor?.pageIndex);
    if (!page) {
      clearSelection();
      return;
    }
    const chars = page.model.chars;
    const blk = anchor.block;
    const anchorPos = blk.order.indexOf(anchor.offset);
    if (anchorPos < 0) {
      clearSelection();
      return;
    }
    const headInBlock = head.pageIndex === page.pageIndex ? blk.order.indexOf(head.offset) : -1;
    const to = headInBlock < 0 ? anchorPos : headInBlock;
    const lo = Math.min(anchorPos, to);
    const hi = Math.max(anchorPos, to);
    const idx = blk.order.slice(lo, hi + 1);
    if (!idx.length) {
      clearSelection();
      return;
    }
    const rect = page.pageEl.getBoundingClientRect();
    selection = {
      pageIndex: page.pageIndex,
      start: idx[0],
      end: idx[idx.length - 1] + 1,
      text: textOf(chars, idx),
      rects: buildLineRects(chars, idx, rect),
      charIndices: idx,
    };
    paint();
    publish(selection);
    deps.onSelection(selection);
  };

  const engine: SelectionEngine = {
    begin(clientX, clientY, extend = false) {
      const h = hit(clientX, clientY);
      if (!h) {
        if (!extend) engine.clear();
        return false;
      }
      const { blocks } = blocksFor(h.page.model, h.page.pageEl);
      const blk = blockOfChar(blocks, h.offset);
      if (extend && anchor && anchor.block) {
        // Shift+点击：锚点不动，焦点挪到"锚点块内离指针最近的字"
        head = { pageIndex: anchor.pageIndex, offset: nearestInBlock(anchor.block, h.page.model.chars, h.x, h.y) };
        rebuild();
        return true;
      }
      anchor = { pageIndex: h.page.pageIndex, offset: h.offset, block: blk };
      head = { pageIndex: h.page.pageIndex, offset: h.offset };
      log('按下', { page: h.page.pageIndex, char: h.page.model.chars[h.offset]?.c, blockChars: blk ? blk.order.length : null });
      rebuild();
      return true;
    },
    move(clientX, clientY) {
      if (!anchor || !anchor.block) return;
      const page = deps.pages().find((p) => p.pageIndex === anchor?.pageIndex);
      if (!page) return;
      const rect = page.pageEl.getBoundingClientRect();
      // **只在锚点块内取最近的字** —— 跨栏/跨块在结构上不可能
      const offset = nearestInBlock(anchor.block, page.model.chars, clientX - rect.left, clientY - rect.top);
      head = { pageIndex: page.pageIndex, offset };
      rebuild();
    },
    end() {
      log('松手', selection ? { chars: selection.text.length, lines: selection.rects.length } : null);
    },
    clear() {
      anchor = null;
      head = null;
      clearSelection();
    },
    current: () => selection,
    refresh() {
      overlayHost = deps.overlay();
      // 尺寸可能变了（缩放）：分块缓存按尺寸失效；锚点要重新定位到新的块
      if (anchor) {
        const page = deps.pages().find((p) => p.pageIndex === anchor?.pageIndex);
        if (page) {
          const { blocks } = blocksFor(page.model, page.pageEl);
          anchor = { pageIndex: anchor.pageIndex, offset: anchor.offset, block: blockOfChar(blocks, anchor.offset) };
        }
      }
      rebuild();
    },
    destroy() {
      for (const el of highlights) el.remove();
      highlights.length = 0;
      anchor = null;
      head = null;
      selection = null;
    },
  };

  overlayHost = deps.overlay();

  /**
   * 诊断入口（自动化验收用）：把每页的"行数 / 栏缝 / 块规模 / 行高"打出来。
   * 有了它，验收脚本才能看到"分块到底分成了什么"，而不是只看最终选区。
   */
  if (typeof window !== 'undefined') {
    (window as unknown as { __litshelfBlocks?: () => unknown }).__litshelfBlocks = () =>
      deps.pages().map((p) => {
        const { blocks } = blocksFor(p.model, p.pageEl);
        return {
          page: p.pageIndex + 1,
          chars: p.model.chars.length,
          blocks: blocks.map((b) => ({
            chars: b.order.length,
            lines: b.lines.length,
            top: Math.round(b.top),
            bottom: Math.round(b.bottom),
            left: Math.round(b.left),
            right: Math.round(b.right),
            size: Math.round(b.size),
          })),
        };
      });
  }
  return engine;
}

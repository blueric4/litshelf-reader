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
  /**
   * 每行一条矩形（**页内坐标，单位 = 模型坐标系像素**，原点在页面左上角）。
   *
   * 为什么还要这一份：高亮现在画在**页面内部的相对坐标层**里（和批注层同一套机制），
   * 缩放（页面的 CSS 预览缩放）、翻页、切换布局时它会天然跟着页面/文字走，
   * 不需要"重算 + 交接"，从根上消除"先飘走、再跳回"的闪烁。
   * 换算成百分比 = 除以 `PageHandle.modelWidth / modelHeight`。
   */
  pageRects: EngineRect[];
  /** 选中的字符序号（按视觉顺序），给上层做精确映射用 */
  charIndices: number[];
}

export interface PageHandle {
  pageIndex: number;
  pageEl: HTMLElement;
  textLayer: HTMLElement;
  model: PageCharModel;
  /** 构建 model 时页面坐标系的宽/高（渲染像素）：用于把 pageRects 换算成百分比 */
  modelWidth: number;
  modelHeight: number;
}

export interface EngineDeps {
  /** 当前可见/可选的页面（顺序无所谓，命中用几何判定） */
  pages: () => PageHandle[];
  /**
   * 每页的**高亮容器**（页面内部的一层，坐标用页内相对百分比）。
   * 给了它就优先走"跟着页面走"的绘制方式；没给则退回旧的 fixed overlay（客户端坐标）。
   */
  highlightHost?: (pageIndex: number) => HTMLElement | null;
  /** 旧的高亮层容器（固定在视口上，矩形是客户端坐标）。仅作兜底保留 */
  overlay?: () => HTMLElement | null;
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

/**
 * **逐字矩形**（几何操作的唯一入口）。
 *
 * ⚠️⚠️ 这里曾经是 `c.inlineRect ?? c.rect` —— **这是"第23篇第1页怎么调阈值都切不开"的真正原因**，
 * 我为此白查了好几轮，必须写清楚：
 *
 * `inlineRect` 的语义是"**视觉行盒**"：由 `selectionModel.ts::buildLines`（L664-703）按
 * "同一基线（中心差 ≤ size/2）"分桶后回填的**整桶并集盒**。⚠️ 它**不是**"单个 pdf.js item 的矩形"
 * —— 这个说法曾经写在注释里、也误导过一轮排查（真机实测：第 4 页一条行盒 = x 142..945，
 * 横跨左右两栏，而左栏文字只到 x 467；纵向只有一行高）。同一个桶里的字共用同一个盒子，
 * 于是 36 个字的 `inlineRect` **完全相同**。真机实测那一条行：
 *   #0 [611,1121,1024,1142] 宽=413
 *   #1 [611,1121,1024,1142] 宽=413   ← 每个字都一样
 *   …
 * 拿它做逐字运算的后果：相邻字间隙 = 611 - 1024 = **-413**，整行间隙中位数 -413.5，
 * 阈值 `max(6, 中位×1.8)` 退化成 6，而"最大正间隙"恒为 0 → **任何栏缝都切不开**。
 * 表现就是：无论把阈值调成 8 / 6 / 1.5 倍，第 23 篇第 1 页永远不切。
 *
 * 所以：**只要问"这个字在哪 / 指针落在哪个字上"，一律用 `c.rect`**（`charRectOf`）；
 * `inlineRect` 只留给"行级"运算（见 `rectOf`）。
 */
const charRectOf = (c: ZoteroChar | undefined): readonly [number, number, number, number] =>
  c ? c.rect : [0, 0, 0, 0];

/**
 * **视行盒矩形**（= `inlineRect`，语义见上）—— 只用于**行级**运算（归行、行边界、行高、行矩形合并）。
 *
 * ⚠️ **不要用它判"指针落在哪个字上"**：它比字自己的盒子高（包住上下伸部），会把相邻字算成
 * "同一行带内"，指针明明在「２」上却选到左邻的「（」。真机实测（5 页 × 4px 网格 = 107619 点）
 * 旧判据错 333 点，改成逐字盒后错 0 点、且 0 劣化 —— 见 `charIndexAt` 的注释。
 */
const itemRectOf = (c: ZoteroChar | undefined): readonly [number, number, number, number] =>
  c ? (c.inlineRect ?? c.rect) : [0, 0, 0, 0];

/**
 * **行盒矩形**（= 视行盒 `inlineRect`）—— 归行、行边界、行高这些"行级"运算都用它。
 *
 * ⚠️ 为什么不统一用逐字盒（`charRectOf`）：真机实测，用逐字盒做归行会把**同一栏的一行拆碎**
 * （第 3 页块数 8 → 51、第 2 页 5 → 38），因为项内相邻字盒首尾相接甚至重叠，间隙是 0 或负数。
 * 而"栏缝"这个量必须用逐字盒（项内插值会把项与项之间的真实空隙抹平）——
 * 所以两者分开：行级用 `rectOf`，量栏缝用 `charRectOf`。
 */
const rectOf = (c: ZoteroChar | undefined): readonly [number, number, number, number] =>
  c ? (c.inlineRect ?? c.rect) : [0, 0, 0, 0];

/** 一行（视觉行） */
interface Line {
  chars: number[];
  /** 这一行**没有跨过**的栏缝（= 它属于哪一栏的判据）。块的合并用它当硬边界。 */
  gutters: number[];
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

/**
 * **页面级栏缝**：用"字中心点的横向直方图"找**空白走廊**。
 *
 * ## 为什么需要它（这是这篇论文最特殊的地方）
 *
 * 第23篇第 1 页是"**上半通栏 + 下半双栏**"混排：页眉/标题/作者/摘要横跨整页，
 * 下半部分（引言）是左右两栏。这种页面的行宽度**极不一致**（129..399、362..669、243..944…），
 * 于是任何"按行内字距比例"的判据都会时灵时不灵 —— 实测 52 行只切开了 47 行，
 * 剩下那几行恰好把左右两栏并成了同一块（742 字/15 行横跨 [243..944]）。
 *
 * 人怎么看这种页面？**看有没有一条竖着的空白带贯穿版心**。这里就照这个做：
 *   ① 把每个字的中心 x 落到 2px 的格子里做直方图；
 *   ② 找**连续为空的格子**（= 没有任何字落在这一列）→ 这是一条竖直空白走廊；
 *   ③ 走廊宽度 >= 12px、两侧都各有 >= 5% 的字 → 认定为栏缝。
 * 空白走廊和"字距"无关，所以对"行宽不一致"的页面同样有效。
 *
 * @returns 栏缝的 x 列表（页面坐标，已排序）
 */
function pageColumnsOf(chars: readonly ZoteroChar[]): number[] {
  if (chars.length < 40) return [];
  /** 字宽中位数（用来定"走廊至少要多宽"：中文排版正常字距 <= 字宽的 0.3 倍） */
  const ws = chars.map((c) => (c ? c.rect[2] - c.rect[0] : 0)).filter((w) => w > 0).sort((p, q) => p - q);
  const medianW = ws.length ? ws[Math.floor(ws.length / 2)] : 8;
  /**
   * ⚠️ 走廊阈值必须按**字宽**定，不能拍一个固定像素：实测定 12px 时，
   * 模型里"行内字距 17px"的普通字缝也被当成走廊 → 一页切出好几条假栏缝
   * （第2页页眉因此被切成两半）。取 2.5 个字宽（中文字距通常 <= 0.3 字宽）。
   */
  const minCorridor = Math.max(20, medianW * 2.5);
  const centers: number[] = [];
  for (const c of chars) {
    if (!c) continue;
    centers.push((c.rect[0] + c.rect[2]) / 2);
  }
  if (!centers.length) return [];
  const left = Math.min(...centers);
  const right = Math.max(...centers);
  const span = right - left;
  if (!(span > 100)) return [];
  const bin = 2;
  const n = Math.ceil(span / bin) + 1;
  const hist = new Uint32Array(n);
  for (const x of centers) {
    const i = Math.floor((x - left) / bin);
    if (i >= 0 && i < n) hist[i] += 1;
  }
  const total = centers.length;
  const minSide = Math.max(8, total * 0.05);
  const gutters: number[] = [];
  let runStart = -1;
  for (let i = 0; i <= n; i += 1) {
    const empty = i < n && hist[i] === 0;
    if (empty) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      const from = left + runStart * bin;
      const to = left + i * bin;
      const leftChars = hist.slice(0, runStart).reduce((a, b) => a + b, 0);
      const rightChars = hist.slice(i).reduce((a, b) => a + b, 0);
      // 走廊够宽、两侧都够多字、且不在页边
      if (to - from >= minCorridor && leftChars >= minSide && rightChars >= minSide && runStart > 2 && i < n - 2) {
        gutters.push((from + to) / 2);
      }
      runStart = -1;
    }
  }
  return gutters;
}

// ---------------------------------------------------------------- 行归一

/**
 * **整页栏缝**（竖直空白走廊）—— 用**逐字矩形**（`charRectOf`）算。
 *
 * 为什么要它：第 23 篇第 1 页是"页眉/标题/摘要（跨栏）+ 引言（左右两栏）"混排。
 * 归行时左右栏的行会被并成一条（栏缝夹在行内部），后面按字距切分虽然能切开，
 * **但块合并阶段又会把切开的两片并回同一块** → 在左栏里拖仍然会选到右栏
 * （真机实测：选中 50 字、高亮 x[355..959]、越过了中线 701）。
 * 所以栏缝必须作为**块的硬边界**：块不许跨缝合并。
 *
 * 判据（不用任何"字距比例"）：
 *   · 把每个字的横向范围投到 2px 格子上，连续为空 = 一条竖直走廊；
 *   · 走廊宽 ≥ 1.2 字宽；
 *   · 走廊两侧都必须有**实质文字**（各 ≥ 12 个字、各占页宽 ≥ 15%），
 *     否则只是行末留白/段首缩进，不是栏缝。
 */
/**
 * 一条**栏缝**（硬边界）。
 *
 * `at` = 缝的 x（页面坐标）；`lo..hi` = **这条缝生效的纵向范围**（它所在的那个"带"）。
 *
 * ## 为什么栏缝必须带纵向范围（这一轮的关键，别再退回"整页一条缝"）
 *
 * 第 23 篇第 4 页的真实版面是：**上半部一张通栏表格 + 下半部两栏正文**。
 * 两处的"竖直缝"性质完全不同：
 *   · 表格的列缝（实测 x≈285/440/630/800，只覆盖表格那一段高度）；
 *   · 正文的栏缝（实测走廊 `507..564`，只覆盖正文那一段高度）。
 * 把其中任何一条当成"整页硬边界"都会出事：
 *   · 拿表格列缝当整页边界 → 正文行被从中间劈开。实测 x=456 落在**左栏文字内部**
 *     （有行在 `457..507` 还有 6 个字），于是左栏被切成 `[142..455]` + `[457..507]` 两截，
 *     块碎成 114 片、拖选在碎片边界断掉；
 *   · 拿正文栏缝当整页边界 → 表格单元格被劈开。
 *
 * 人看版面本来就是"**先分带（表格带/正文带），再在带内分栏**"，这里照这个顺序做。
 */
interface Seam {
  at: number;
  lo: number;
  hi: number;
}

/** 这条缝在 y 处是否生效（带内才生效 —— 表格列缝不许去管正文行） */
function seamActiveAt(s: Seam, y: number): boolean {
  return y >= s.lo && y <= s.hi;
}

/**
 * 页面级栏缝（硬边界）：**先按纵向空白分带，再在每条带内找"多行共有的竖直缝"**。
 *
 * 判据（只用位置/空白/字形三样，跨页面自适）：
 *   ① 归行：按逐字盒的 y 聚类（容差 0.45 字高，吸收同一行不同项的 ascent 差）；
 *   ② 分带：相邻行之间出现"明显大于行距"的纵向空白就断开；
 *   ③ 带内缝投票：每行找宽度 ≥ 1.2 个字宽的横向空隙，位置取整到 5px；
 *      一个 x 要成为**带内栏缝**，必须同时满足
 *        · **多行共有**：≥ 60% 的带内行且至少 3 行（结构性的重复缝，挡掉段落缩进）；
 *        · **纵向贯穿本带**：≥ 70% 带高（挡掉表格里偶发的空隙）；
 *        · **两侧都有实质宽度**：各 ≥ 25% 带宽，且宽窄相称（0.6 ~ 1.67）——
 *          真栏缝两侧是两栏正文（实测第 1/2/3 页宽度比 ≈ 1.0），表格列缝往往一侧只有窄标签列。
 *
 * ⚠️ 历史教训（别再踩）：
 *   · "把所有缝都当硬边界"：第 4 页表格筛出 18 条 → 正文行跨过全部 18 条 → 一条都切不动，
 *     块仍是 `528字[142..955]`；
 *   · "只取跨度最大的那条缝 / 跨度是相对整页算的"：第 4 页表格占了 2/3 页高，
 *     正文栏缝只有 36% → 被 60% 门槛筛掉，最后退回"空白走廊"兜底，
 *     兜出一条 x=456（表格列缝）当栏缝 —— 左栏反而被劈碎。
 *
 * @returns 栏缝列表（带纵向范围；单栏带不产出栏缝）
 */
function pageGuttersOf(chars: readonly ZoteroChar[]): Seam[] {
  if (chars.length < 40) return [];
  const safe = chars.filter((c) => c && c.rect[2] > c.rect[0]);
  if (safe.length < 40) return [];
  const ws = safe.map((c) => charRectOf(c)[2] - charRectOf(c)[0]).sort((a, b) => a - b);
  const medianW = ws[Math.floor(ws.length / 2)] || 8;
  const hs = safe.map((c) => charRectOf(c)[3] - charRectOf(c)[1]).filter((h) => h > 0).sort((a, b) => a - b);
  const medianH = hs[Math.floor(hs.length / 2)] || 10;
  const minSeam = Math.max(8, medianW * 1.2);

  /** ① 归行：按逐字盒的 y 聚类（容差 0.45 字高，吸收同一行不同项的 ascent 差） */
  type Row = { y: number; bottom: number; chars: ZoteroChar[] };
  const rows: Row[] = [];
  for (const c of safe.slice().sort((a, b) => charRectOf(a)[1] - charRectOf(b)[1])) {
    const r = charRectOf(c);
    const last = rows[rows.length - 1];
    if (last && r[1] - last.y <= medianH * 0.45) {
      last.chars.push(c);
      if (r[3] > last.bottom) last.bottom = r[3];
      continue;
    }
    rows.push({ y: r[1], bottom: r[3], chars: [c] });
  }
  if (rows.length < 5) return [];

  /**
   * ② 空隙在 x 上的**覆盖直方图**（5px 桶）：某个 x 被多少行的"字间空隙"覆盖。
   *
   * ⚠️ 为什么不是"给空隙中点归 5px 桶、按桶投票"（我的前两版，都在真实页面上漏检）：
   *   · 中点归桶：双栏页左栏行末是**参差**的（第 4 页实测行末有 507/525/535 三种），
   *     同一条走廊的中点会落进 525/535/545 多个桶，每桶只分到一部分行 →
   *     "连续段"被打散（实测栏缝范围只剩 y901..1135，下半页退回"横向不重叠"兜底）；
   *   · 按区间贪心聚类：结果依赖空隙的排序，先来的宽空隙会把后面的窄空隙"包"进同一条走廊。
   * 直方图是**无序、可叠加**的：只要某一列空白在多数行里都出现，那里的覆盖数就会堆起来，
   * 与行的顺序、行末的参差都无关。
   */
  const pageL = Math.min(...safe.map((c) => charRectOf(c)[0]));
  const pageR = Math.max(...safe.map((c) => charRectOf(c)[2]));
  const bin = 5;
  const nb = Math.ceil((pageR - pageL) / bin) + 2;
  const cover = new Int32Array(nb);
  const gapRows: { ri: number; from: number; to: number }[] = [];
  for (let ri = 0; ri < rows.length; ri += 1) {
    const list = rows[ri].chars;
    if (list.length < 4) continue;
    const sorted = list.slice().sort((a, b) => charRectOf(a)[0] - charRectOf(b)[0]);
    for (let i = 1; i < sorted.length; i += 1) {
      const from = charRectOf(sorted[i - 1])[2];
      const to = charRectOf(sorted[i])[0];
      if (to - from < minSeam) continue;
      gapRows.push({ ri, from, to });
      const a = Math.max(0, Math.floor((from - pageL) / bin));
      const b = Math.min(nb - 1, Math.floor((to - pageL) / bin));
      for (let k = a; k <= b; k += 1) cover[k] += 1;
    }
  }

  /** ③ 取覆盖直方图的**局部峰值**当走廊候选（连续平台只留最高那格） */
  const peaks: { at: number; n: number }[] = [];
  for (let i = 0; i < nb; i += 1) {
    if (cover[i] < 3) continue;
    if (i > 0 && cover[i - 1] > cover[i]) continue;
    if (i + 1 < nb && cover[i + 1] > cover[i]) continue;
    peaks.push({ at: pageL + i * bin + bin / 2, n: cover[i] });
  }
  peaks.sort((a, b) => b.n - a.n);

  /**
   * ④ 每个候选：投票行 = "空隙覆盖了这一点"的那些行；再把投票行**聚成连续段**，
   * 段 = 这条缝真正贯穿的纵向范围（`Seam.lo/hi`）。
   *
   * ⚠️ 为什么段要按投票行算，而不是"先给整页分带、再在带内找缝"（上一版，第 1、3 页漏检）：
   * 真实页面常是"通栏元素 + 双栏正文"混排（第 1 页标题/摘要通栏 + 下半双栏；
   * 第 3 页图题通栏 + 下半双栏）。按整页纵向空白分带时通栏行和双栏行会落进**同一条带**，
   * 缝的投票率被通栏行稀释（实测 4/8、6/15 都卡在 60% 门槛下）→ 明明存在的栏缝被判没有。
   * 从缝本身出发就自然了：通栏行不投票 → 段自动断开 → 缝的范围收敛到双栏那一段。
   */
  const rowTol = Math.max(medianH * 3, 40);
  type Cand = { at: number; n: number; lo: number; hi: number; ratio: number; score: number };
  const cands: Cand[] = [];
  for (const pk of peaks) {
    const at = pk.at;
    const ys = [...new Set(gapRows.filter((g) => g.from <= at && g.to >= at).map((g) => g.ri))].sort((a, b) => a - b);
    if (ys.length < 3) continue;
    let start = 0;
    for (let i = 1; i <= ys.length; i += 1) {
      const isBreak = i === ys.length || rows[ys[i]].y - rows[ys[i - 1]].y > rowTol;
      if (!isBreak) continue;
      const cluster = ys.slice(start, i);
      start = i;
      /**
       * 至少 **5 行**共有才算"结构性缝"。
       *
       * 数字是实测标定的：第 4 页正文栏缝连续 **17 行**（y916..1382），
       * 而表格内部"凑巧对齐"的空隙只有 **2~3 行**（实测 x=545 在表格里 y510..549 三行、
       * x=435 在 y341..349 两行）→ 门槛设 3 时表格列缝会混进来把表格切碎（块数 41 → 51）。
       * 第 1 页下半双栏那一段是 5 行，所以门槛取 5 而不是 8。
       */
      if (cluster.length < 5) continue; // 至少 5 行共有才算"结构性缝"（见下）
      const lo = rows[cluster[0]].y;
      const hi = rows[cluster[cluster.length - 1]].y;
      /** 段内覆盖率：这一段 y 范围内的行里，**绝大多数行**都要在这里有空隙
       * （真栏缝实测 1.00；表格里"凑巧对齐"的缝隙只有 0.6~0.75 → 挡掉） */
      const inRange = rows.filter((r) => r.y >= lo - medianH && r.y <= hi + medianH);
      if (cluster.length / Math.max(1, inRange.length) < 0.8) continue;
      const rects = inRange.flatMap((r) => r.chars.map((c) => charRectOf(c)));
      if (rects.length < 30) continue;
      const bandL = Math.min(...rects.map((r) => r[0]));
      const bandR = Math.max(...rects.map((r) => r[2]));
      const bandW = bandR - bandL;
      if (!(bandW > 100)) continue;
      const leftRights = rects.filter((r) => r[2] <= at + 1).map((r) => r[2]);
      const leftLefts = rects.filter((r) => r[2] <= at + 1).map((r) => r[0]);
      const rightLefts = rects.filter((r) => r[0] >= at - 1).map((r) => r[0]);
      const rightRights = rects.filter((r) => r[0] >= at - 1).map((r) => r[2]);
      if (!leftRights.length || !rightLefts.length) continue;
      const leftW = Math.max(...leftRights) - Math.min(...leftLefts);
      const rightW = Math.max(...rightRights) - Math.min(...rightLefts);
      const lp = leftW / bandW;
      const rp = rightW / bandW;
      /**
       * 两侧都要有实质文字宽度，且**宽窄相称**：真栏缝两侧是两栏正文
       * （实测第 1~4 页宽度比 0.98~1.05），而表格列缝一侧往往只有窄标签列
       * （第 4 页 x=455 实测 39%/61% = 0.64、x=620 实测 1.5）→ 用 [0.75, 1.33] 挡掉它们，
       * 否则表格会被自己的列缝切碎（实测块数 39 → 50）。
       */
      if (lp < 0.25 || rp < 0.25) continue;
      const ratio = lp / rp;
      if (ratio < 0.75 || ratio > 1.33) continue;
      cands.push({ at, n: cluster.length, lo, hi, ratio, score: cluster.length - Math.abs(1 - ratio) * 2 });
    }
  }

  /** ⑤ 去重：同一条走廊的相邻峰值只留分数最高的那条 */
  cands.sort((a, b) => b.score - a.score);
  const seams: Seam[] = [];
  const minApart = Math.max(30, medianW * 3);
  for (const c of cands) {
    const dup = seams.some((s) => Math.abs(s.at - c.at) < minApart && Math.min(s.hi, c.hi) - Math.max(s.lo, c.lo) > -medianH);
    if (dup) continue;
    seams.push({ at: c.at, lo: c.lo - medianH, hi: c.hi + medianH });
  }
  return seams.sort((a, b) => a.lo - b.lo || a.at - b.at);
}

/**
 * 字 → 行。
 *
 * ⚠️ 必须按"行带纵向重叠"归行，**不能按 `inlineRect.top` 精确相等**：
 * 真实 PDF 里同一视觉行的 top 会差 1~4px（字体 ascent 不同），
 * 按 top 相等归行会把标题行拆成 3~4 行（真机实测），后面全跟着错。
 */
function buildLines(chars: readonly ZoteroChar[], seamsIn?: readonly Seam[]): Line[] {
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

  /**
   * 整页栏缝（块的硬边界）—— **带纵向范围**，见 pageGuttersOf。
   *
   * ⚠️ 由调用方（blocksFor）算好传进来：**同一页的行与块必须用同一份栏缝**。
   * 原来在 buildLines 里算、buildBlocks 里又算一次，两处都可能拿到别的页重算覆盖后的值，
   * 于是块不许跨栏缝这条约束时灵时不灵（真机实测：同一页块结构一会儿切开一会儿没切开）。
   */
  const seams = seamsIn ?? pageGuttersOf(chars);
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__litshelfPageGutters = seams.map((s) => s.at);
    const lens = seams.map((s) => chars.filter((c) => c.rect[2] <= s.at + 1).length);
    (window as unknown as Record<string, unknown>).__litshelfGutterInfo = {
      n: seams.length,
      gutters: seams.map((s) => s.at),
      bands: seams.map((s) => [Math.round(s.lo), Math.round(s.hi)]),
      leftCounts: lens,
    };
  }

  const order = Array.from({ length: chars.length }, (_, i) => i).filter((i) => chars[i]);
  order.sort((a, b) => rectOf(chars[a])[1] - rectOf(chars[b])[1] || rectOf(chars[a])[0] - rectOf(chars[b])[0]);

  const open: Line[] = [];
  /** 每一条行内已经出现过的"横向间隙"（用来定这条行允许的最大横向距离，见下） */
  const lineGaps = new Map<Line, number[]>();
  for (const i of order) {
    const r = rectOf(chars[i]);
    const line = open.find((ln) => {
      const overlap = Math.min(ln.bottom, r[3]) - Math.max(ln.top, r[1]);
      const minH = Math.min(ln.bottom - ln.top, r[3] - r[1]);
      if (!(minH > 0 && overlap >= minH * 0.6)) return false;
      /**
       * ## 人眼判据：**先看基线，再看横向**
       *
       * 人判断"这两块字是不是同一行"，第一眼看的是**它们在不在同一条水平线上**；
       * 基线对得上，才接着看"横着是不是挨着"。我原来的判据只有后半句 ——
       * 于是"横向够近"就把**左栏的行尾**和**右栏的行首**缝成了一条行
       * （用户截图实测："……满足选择标准：① 典型" 与 "成调研小组，通过现场观察……"
       * 被连成一条，横跨两栏，两栏之间的缝被压成了几十像素）。
       *
       * 这里补上第一眼：**两行的纵向中心必须接近**（差 ≤ 0.5 倍字高中位数）。
       * 两栏的行在版面上常常是错开的，这一条能挡掉大部分"跨栏缝线"，
       * 剩下的由"整页栏缝"硬边界兜底。
       */
      const cyA = (ln.top + ln.bottom) / 2;
      const cyB = (r[1] + r[3]) / 2;
      if (Math.abs(cyA - cyB) > Math.max(2, medianH * 0.5)) return false;
      /**
       * **绝不跨栏缝**：当前字与这一行已占的横向范围之间若隔着一条**在此 y 生效**的竖缝，
       * 说明它们分属左右两栏 → 不能并成同一行。
       * 这是"先分栏、再归行"的关键一步（人看版面就是这个顺序）。
       *
       * ⚠️ 必须带 `seamActiveAt` 的纵向判据：第 4 页表格带里的列缝（x≈440/630）
       * 与正文带的栏缝（x≈545）**不是一回事**，表格列缝不许去管正文行（否则正文行会被劈开）。
       */
      const cy = (r[1] + r[3]) / 2;
      for (const s of seams) {
        if (!seamActiveAt(s, cy)) continue;
        const g = s.at;
        const curLeft = r[2] <= g + 1;
        const curRight = r[0] >= g - 1;
        if (!curLeft && !curRight) continue; // 这一行本身就跨着缝（跨栏标题），不拦
        const lnLeft = ln.right <= g + 1;
        const lnRight = ln.left >= g - 1;
        if (lnLeft && curRight) return false;
        if (lnRight && curLeft) return false;
      }
      /**
       * ## 人眼判据（两个条件必须**同时**满足）
       *
       * 人判断"这两块字是不是同一行"，看的是：
       *   ① 在不在**同一条水平线上**（基线接近）；**并且**
       *   ② 横向**距离不能太远**。
       *
       * 只有 ②（我原来的代码）→ 左栏行尾与右栏行首因为"横着够近"被缝成一条行
       * （用户截图实测："……满足选择标准：① 典型" 与 "成调研小组，通过现场观察……"
       * 被连成一条，横跨两栏）。
       *
       * 这里把 ② 也定成"距离"判据：允许的最大横向距离 = **该行内已出现间隙的中位数 × 2.2**
       * （下限 1.5 个中文字宽，上限 6 个字宽）。
       * 用"该行自己的间隙中位数"当基准，是因为页面之间字号差异很大
       * （第 1 页字宽 ≈ 22px、第 2 页 ≈ 18px），拍一个固定像素必然在某页上失效。
       */
      const gap = r[0] > ln.right ? r[0] - ln.right : ln.left > r[2] ? ln.left - r[2] : 0;
      if (gap <= 0) return true; // 挨着或重叠，直接算同一行
      const gs = lineGaps.get(ln) ?? [];
      const sortedG = gs.slice().sort((a, b) => a - b);
      const medG = sortedG.length >= 3 ? sortedG[Math.floor(sortedG.length / 2)] : medianW * 0.1;
      /**
       * **距离不能太远**（人眼判据的第二条）。
       *
       * 基准不拍像素，而是**该行自己的行内间隙中位数**：
       *   · 同一句话里字与字之间的间隙 ≈ 0~2px；
       *   · 栏与栏 / 表格单元格之间是 30~80px；
       * 两者差 20 倍以上，用"中位数 × 3"就足以把后者挡在行外，
       * 而且能自适应不同页面/字号（第 1 页字宽 ≈ 22px、第 2 页 ≈ 18px、第 4 页 ≈ 15px）。
       *
       * ⚠️ 下限**必须贴着"正常字距"的量级**，不能取"1 个字宽"：
       *
       * 第 4 页实测（183% 缩放）：同一句话里的字距是 0~2px，
       * 而**两栏之间的间隙被压缩成了 ≈23px**（左栏"① 典型"结束 677 → 右栏"成调研小组"开始 700）。
       * 绝对阈值（6px / 24px / 1.2 字宽 / 2.5 字宽）我都试过，每一个都在某页上与它擦肩而过。
       *
       * 真正**稳定**的差别是**倍数**：栏缝 / 单元格缝 ≈ 正常字距的 10 倍以上。
       * 所以用**该行已有间隙的中位数 × 3**（下限 6px）当判据 —— 相对量，跨页面自适。
       */
      const limit = Math.max(medG * 3, 6);
      if (gap > limit) return false;
      gs.push(gap);
      lineGaps.set(ln, gs);
      return true;
    });
    if (line) {
      line.chars.push(i);
      line.top = Math.min(line.top, r[1]);
      line.bottom = Math.max(line.bottom, r[3]);
      line.left = Math.min(line.left, r[0]);
      line.right = Math.max(line.right, r[2]);
    } else {
      open.push({ chars: [i], gutters: [], top: r[1], bottom: r[3], left: r[0], right: r[2], charHeight: medianH });
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
    /**
     * ② 兜底：按"行内字距"切断跨栏行。
     *
     * ⚠️⚠️ **必须先按 x 排序再算间隙**（我在这里错过整整几轮，记下来）：
     * `ln.chars` 是"字符序号"数组，它的顺序**不是 x 升序** ——
     * 引擎接管时按阅读顺序重排过 DOM 与模型，中文期刊的内容流又是左右栏交替的，
     * 于是相邻两个"序号"在几何上可能天各一方。
     * 原来直接对序号相邻项相减，结果：
     *   实测 top=1184 那一行（左右栏并排、真实栏缝 52px）算出 **间距中位数 = -828.5**、
     *   **最大间隙 = 0**（负数全被忽略）→ 阈值 = max(6, 负数) = 6 → **永远切不开**。
     * 表现就是"第 23 篇第 1 页怎么调阈值都不切开"。
     * 现在：先把这一行的字符按 x 升序排好，再算相邻间隙 —— 栏缝立刻现形。
     */
    const ordered = ln.chars.slice().sort((a, b) => charRectOf(chars[a])[0] - charRectOf(chars[b])[0]);
    const gaps: { at: number; w: number; k: number }[] = [];
    for (let k = 1; k < ordered.length; k += 1) {
      // 栏缝必须用**逐字盒**量（整项盒会把项与项之间的真实空隙抹平）
      const prev = charRectOf(chars[ordered[k - 1]]);
      const cur = charRectOf(chars[ordered[k]]);
      gaps.push({ at: (prev[2] + cur[0]) / 2, w: cur[0] - prev[2], k });
    }
    const sortedW = gaps.map((g) => g.w).sort((a, b) => a - b);
    const medianGap = sortedW[Math.floor(sortedW.length / 2)];
    /**
     * 切分阈值：**minGap=6 + 1.8 倍行内字距中位数**。
     *
     * 这个数字是**离线用 PDF 真实数据标定**出来的（tmp/sel-harness/tune-split.mjs），
     * 同时满足两种版面：
     *   · 第23篇第 2 页（整页双栏）：24 行被正确切成左右两段，右栏稳定从 x=337 开始；
     *   · 第23篇第 1 页（**上半通栏 + 下半双栏**，这篇论文的特殊之处）：双栏那部分切对了。
     * 实测 minGap=8 时第 1 页切不开（栏缝 27pt 被算成 18pt，差一点点），minGap=6 足够。
     * 两侧宽度都 >= 6 个字才切 —— 防止把"行末标点"造成的空隙误当成栏缝。
     */
    const thr = Math.max(6, medianGap * 1.8);
    const breakAt: number[] = [];
    for (const g of gaps) {
      if (g.w <= thr) continue;
      const leftChars = g.k;
      const rightChars = ln.chars.length - g.k;
      /**
       * ⚠️ 两侧字数门槛**不能设成 6**：
       * 栏缝常常**紧邻行首或行尾**（表格行、段首行、行末只有标点），
       * 一侧不到 6 个字就被跳过 → 整行保持缝合。
       * 真机实测（第 4 页，x=456 那条栏缝）：46 行里有 **41 行**因为这条守卫而没被切开，
       * 于是后面的"块不许跨缝"范围约束面对的是已经缝好的行，拦不住 → 拖起来仍然跨栏。
       * 改成"两侧各至少 2 个字"（真正的窄缝由上面 `thr` 拦）。
       */
      if (leftChars >= 2 && rightChars >= 2) breakAt.push(g.k);
    }
    /**
     * 诊断（本轮修完即删）：让引擎**自报每一行的切分决策**。
     * 用途：查"栏缝明明检出（545）但 n=41 的行没切开"到底是哪一步。
     */
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __litshelfWhy2?: unknown[] };
      if (!w.__litshelfWhy2) w.__litshelfWhy2 = [];
      if (w.__litshelfWhy2.length < 120) {
        (w.__litshelfWhy2 as unknown[]).push({
          top: Math.round(ln.top),
          n: ln.chars.length,
          l: Math.round(ln.left),
          r: Math.round(ln.right),
          pageGutters: seams.map((s2) => s2.at),
          seamBands: seams.map((s2) => [Math.round(s2.lo), Math.round(s2.hi)]),
          thr: Math.round(thr * 10) / 10,
          medianGap: Math.round(medianGap * 10) / 10,
          breaks: breakAt.slice(),
          gapsHead: gaps.slice(0, 12).map((g) => Math.round(g.w)),
        });
      }
    }
    /**
     * 诊断：记录"这一行为什么没切开"（阈值、最大间隙、两侧字数）。
     * 之前我离线复算说"该切"，运行时却没切 —— 只有让引擎自报才能定案。
     */
    if (typeof window !== 'undefined') {
      type SplitWhy = { top: number; n: number; left: number; right: number; medianGap: number; thr: number; maxGap: number; maxAt: number; leftChars: number; rightChars: number; breakAt: number[]; text: string; rects: number[][]; charsText: string };
      const w0 = window as unknown as { __litshelfSplitWhy?: SplitWhy[] };
      if (!w0.__litshelfSplitWhy) w0.__litshelfSplitWhy = [];
      if (w0.__litshelfSplitWhy.length >= 400) w0.__litshelfSplitWhy.length = 0;
      {
        const sortedG = gaps.slice().sort((a, b) => a.w - b.w);
        const mg = sortedG.length ? sortedG[Math.floor(sortedG.length / 2)].w : 0;
        const thr = Math.max(6, mg * 1.8);
        let maxG = 0;
        let maxAt = -1;
        for (const g of gaps) if (g.w > maxG) { maxG = g.w; maxAt = g.k; }
        w0.__litshelfSplitWhy.push({
          top: Math.round(ln.top),
          n: ln.chars.length,
          left: Math.round(ln.left),
          right: Math.round(ln.right),
          medianGap: Math.round(mg * 10) / 10,
          thr: Math.round(thr * 10) / 10,
          maxGap: Math.round(maxG * 10) / 10,
          maxAt,
          leftChars: maxAt,
          rightChars: ln.chars.length - maxAt,
          breakAt: breakAt.slice(),
          /**
           * 该行**排序后的逐字矩形**（只取前 30 个）—— 用来直接看"栏缝到底在不在"。
           * 之前的诊断只给我 x[0]，被我误读了两轮；这里给完整 [x0,y0,x1,y1]。
           */
          rects: ordered.slice(0, 30).map((i2) => {
            const rr = rectOf(chars[i2]);
            return [Math.round(rr[0]), Math.round(rr[1]), Math.round(rr[2]), Math.round(rr[3])];
          }),
          charsText: ordered
            .slice(0, 30)
            .map((i2) => chars[i2].c)
            .join(''),
          text: ln.chars.map((i2) => chars[i2]?.c ?? '').join('').replace(/\s+/g, ' ').slice(0, 20),
        });
      }
    }
    if (typeof window !== 'undefined') {
      const w2 = window as unknown as { __litshelfSplitPath?: unknown[] };
      (w2.__litshelfSplitPath ??= []).push({ top: Math.round(ln.top), path: breakAt.length ? '②字距切开' : '②未切开', breaks: breakAt.length });
    }
    if (!breakAt.length) {
      splitLines.push(ln);
      continue;
    }
    let from = 0;
    for (const cut of [...breakAt, ordered.length]) {
      const part = ordered.slice(from, cut);
      if (part.length) splitLines.push(makeLine(part, chars, medianH, seams));
      from = cut;
    }
  }
  /**
   * ## 最后一道保险：**任何还跨着栏缝的行片，必须继续按缝切开**
   *
   * 这是"栏缝是硬边界"的完整含义，也是我这一轮才想通的地方：
   * 归行时遇到第一条缝（G1）会另起一行，于是**跨 G1 的那片自己成了一条行，而它又跨过了 G2** ——
   * 这条片依然是"横跨两栏的行"，而它的 `gutters` 是空的（因为它跨着所有缝），
   * 于是"两侧栏缝集合相同"的合并判据对它等于没约束 → 被任意合并 → 块横跨全页
   * （真机实测第 4 页：栏缝检出 18 条、切分 46 行里切开 42 行，**块却仍然横跨** `528字[142..955]`）。
   *
   * 修法：对每条切好的行片，找出它跨过的所有栏缝，**每条缝都切一刀**，
   * 然后只保留"不再跨任何缝"的片（安全兜底，最多 8 次迭代防死循环）。
   *
   * ⚠️ **两个补丁（这一轮实测后加的）**：
   *   ① 缝必须**在本片的 y 处生效**（`seamActiveAt`）—— 表格带的列缝不许切正文行，
   *      正文带的栏缝也不许切表格单元格；
   *   ② 切点处**必须真的有空隙**（`gap >= 1.2 字宽`）—— 否则会把一个**跨缝的表格单元格**
   *      （或通栏标题）从文字中间劈成两条行，选中时凭空多出一个断点。
   *      真栏缝一定是空白（左右两栏之间没有字），所以这条不会漏切真跨栏行。
   */
  const minCutGap = Math.max(6, medianW * 1.2);
  const clampPieces: Line[] = [];
  for (const ln of splitLines) {
    let pieces: Line[] = [ln];
    for (let iter = 0; iter < 8; iter += 1) {
      let changed = false;
      const next: Line[] = [];
      for (const piece of pieces) {
        // 这一片跨过的、且**在它这个 y 处生效**的栏缝
        const cy = (piece.top + piece.bottom) / 2;
        const crossed = seams.filter((s) => seamActiveAt(s, cy) && piece.left < s.at - 1 && piece.right > s.at + 1);
        if (!crossed.length) {
          next.push(piece);
          continue;
        }
        const s = crossed[0];
        const ord = piece.chars.slice().sort((a, b) => charRectOf(chars[a])[0] - charRectOf(chars[b])[0]);
        let cut = -1;
        for (let k = 1; k < ord.length; k += 1) {
          const prev = charRectOf(chars[ord[k - 1]]);
          const cur = charRectOf(chars[ord[k]]);
          if (cur[0] < s.at - 1) continue; // 还没走到缝
          if (cur[0] - prev[2] >= minCutGap) cut = k; // 缝处确有空白 → 可以切
          break; // 只看"跨过缝的那一处字距"
        }
        if (cut <= 0 || cut >= ord.length) {
          next.push(piece); // 切点无效（缝落在文字中间）→ 保持原样（避免丢字/劈开单元格）
          continue;
        }
        changed = true;
        next.push(makeLine(ord.slice(0, cut), chars, medianH, seams));
        next.push(makeLine(ord.slice(cut), chars, medianH, seams));
      }
      pieces = next;
      if (!changed) break;
    }
    for (const p2 of pieces) clampPieces.push(p2);
  }
  splitLines.length = 0;
  splitLines.push(...clampPieces);
  /**
   * 诊断：报告"哪些行被切开了、切成几段"。运行时自报，避免我在离线复算里自欺。
   */
  if (typeof window !== 'undefined') {
    (window as unknown as { __litshelfSplitSample?: () => unknown }).__litshelfSplitSample = () => ({
      before: linesBefore,
      after: splitLines.length,
      multi: splitLines.filter((l) => l.chars.length < 30).length,
      bigRows: linesBefore > 40 ? 'ok' : 'few',
      sample: splitLines
        .filter((l) => l.chars.length > 6 && l.chars.length < 45 && l.top > 900)
        .slice(0, 12)
        .map((l) => ({ top: Math.round(l.top), n: l.chars.length, l: Math.round(l.left), r: Math.round(l.right), text: l.chars.map((i) => chars[i]?.c ?? '').join('').slice(0, 18) })),
    });
  }
  /**
   * 诊断（本轮修完即删）：把"归行前每一行的间隙序列"写到磁盘。
   * 用途：用真实数字定"多大的横向距离才算栏缝/单元格缝"，不再拍脑袋调阈值。
   */
  if (typeof window !== 'undefined') {
    try {
      const rows = open.slice(0, 60).map((ln) => {
        const ord = ln.chars.slice().sort((a, b) => charRectOf(chars[a])[0] - charRectOf(chars[b])[0]);
        const gs: number[] = [];
        for (let k = 1; k < ord.length; k += 1) gs.push(Math.round(charRectOf(chars[ord[k]])[0] - charRectOf(chars[ord[k - 1]])[2]));
        return {
          top: Math.round(ln.top),
          n: ln.chars.length,
          l: Math.round(ln.left),
          r: Math.round(ln.right),
          gaps: gs,
          text: ord.map((i) => chars[i].c).join('').replace(/\s+/g, ' ').slice(0, 24),
        };
      });
      const w = window as unknown as { litshelf?: { invoke?: (m: string, a: unknown[]) => Promise<unknown> } };
      (window as unknown as { __litshelfGaps?: unknown }).__litshelfGaps = rows;
      {
        const w2 = window as unknown as { litshelf?: { invoke?: (m: string, a: unknown[]) => Promise<unknown> } };
        void w2.litshelf?.invoke?.('writeDiag', ['final-pg' + (((window as unknown as Record<string, unknown>).__litshelfPageNo as number) ?? 0) + '.json', JSON.stringify({ chars: chars.length, rows })]);
      }
      (window as unknown as Record<string, unknown>).__litshelfLinesPage = diagPageNo;
      (window as unknown as { __litshelfLines?: unknown }).__litshelfLines = open.map((ln) => ({
        t: Math.round(ln.top),
        n: ln.chars.length,
        l: Math.round(ln.left),
        r: Math.round(ln.right),
        g: ln.gutters.slice(),
        text: ln.chars
          .slice()
          .sort((a, b) => charRectOf(chars[a])[0] - charRectOf(chars[b])[0])
          .map((i) => chars[i].c)
          .join('')
          .replace(/\s+/g, ' ')
          .slice(0, 26),
      }));
    } catch {
      /* 诊断失败不影响功能 */
    }
  }
  if (typeof window !== 'undefined') {
    try {
      const w3 = window as unknown as { litshelf?: { invoke?: (m: string, a: unknown[]) => Promise<unknown> } };
      void w3.litshelf?.invoke?.('writeDiag', ['split-pg' + diagPageNo + '.json', JSON.stringify(splitLines.map((l) => ({ t: Math.round(l.top), n: l.chars.length, l: Math.round(l.left), r: Math.round(l.right), g: l.gutters.slice(), x: l.chars.slice().sort((a, b) => charRectOf(chars[a])[0] - charRectOf(chars[b])[0]).map((i) => Math.round(charRectOf(chars[i])[0])) })) )]);
    } catch { /* ignore */ }
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
  /** 诊断：把“每行的字位与间隙”列出来（自动化验收用；正常使用不会调用） */
  if (typeof window !== 'undefined') {
    (window as unknown as { __litshelfRowDiag?: () => unknown }).__litshelfRowDiag = () =>
      open.slice(0, 40).map((ln) => {
        const segs: { from: number; to: number; n: number }[] = [];
        let from = 0;
        for (let k = 1; k <= ln.chars.length; k += 1) {
          const isBreak =
            k === ln.chars.length ||
            rectOf(chars[ln.chars[k]])[0] - rectOf(chars[ln.chars[k - 1]])[2] > 3;
          if (isBreak) {
            segs.push({
              from: Math.round(rectOf(chars[ln.chars[from]])[0]),
              to: Math.round(rectOf(chars[ln.chars[k - 1]])[2]),
              n: k - from,
            });
            from = k;
          }
        }
        return {
          top: Math.round(ln.top),
          n: ln.chars.length,
          text: ln.chars.map((i) => chars[i]?.c ?? '').join('').slice(0, 30),
          segs,
        };
      });
  }
  return open;
}

/** 用一组字符序号造一条行（保持纵向范围/字高中位数） */
function makeLine(part: readonly number[], chars: readonly ZoteroChar[], fallbackH: number, seams: readonly Seam[] = []): Line {
  /**
   * ## ⚠️ 横向范围必须用**逐字盒**算（`charRectOf`），不能用行盒（`rectOf`）
   *
   * 这是队友 engine-fix 查出来的关键点（真实 dump `tmp/sel-harness/split-pg4.json`）：
   * 170 条切好的行片里 **164 条仍被判为"跨 x=456"**，而且多数片子的 `l/r` 根本不是自己字的位置 ——
   * 例如 t=96 的片 n=20、字实际在 `x 464..827`，却报 `l=157 r=938`。
   *
   * 原因：`rectOf` 是**整项矩形**（inlineRect），一个项有 36 个字时 36 个字共用同一个盒子；
   * 于是"从整项里切出来的那一小片"**继承了整项的盒子** →
   * 下游 `clampPieces` 的判据 `piece.left < g-1 && piece.right > g+1` 切完仍然为真
   * → 那个"跨缝强制切开"的 pass **永远切不完**（不是没进入，而是判据用错了几何量）。
   *
   * 纵向（top/bottom）仍用**行盒**（`rectOf`）：行的上下边界本来就是"整条视觉行的高度带"，
   * 归行/并块用的纵向间隙也依赖它（见 buildLines 的注释）。
   * 若改用逐字盒，行高会缩到字形高度、纵向间隙凭空变大 → 并块判据失效（实测块数 24 → 114）。
   */
  const rects = part.map((i) => charRectOf(chars[i]));
  const boxes = part.map((i) => rectOf(chars[i]));
  const hs = boxes
    .map((r) => r[3] - r[1])
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  const top = Math.min(...boxes.map((r) => r[1]));
  const bottom = Math.max(...boxes.map((r) => r[3]));
  const left = Math.min(...rects.map((r) => r[0]));
  const right = Math.max(...rects.map((r) => r[2]));
  const cy = (top + bottom) / 2;
  return {
    chars: part.slice().sort((a, b) => charRectOf(chars[a])[0] - charRectOf(chars[b])[0]),
    /**
     * 这一行**没有跨过**的栏缝（= 它属于哪一栏的判据，见 pageGuttersOf）。
     * 只算**在它这个 y 处生效**的缝：表格带的列缝与正文带的栏缝不是一回事。
     */
    gutters: (seams ?? [])
      .filter((s) => seamActiveAt(s, cy))
      .filter((s) => !(left < s.at - 1 && right > s.at + 1))
      .map((s) => s.at),
    top,
    bottom,
    left,
    right,
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
function buildBlocks(lines: readonly Line[], chars: readonly ZoteroChar[], medianCharWidth: number, seams: readonly Seam[] = []): Block[] {
  if (!lines.length) return [];

  /**
   * ## 行距（**必须按"同栏上下相邻两行"量**，这一条是第 4 页碎成 114 块的直接原因）
   *
   * 原来用的是"把全部行按 top 排好、相邻两行的纵向间隙取中位数"。
   * 双栏页左右栏的行是**交错**的：相邻两项常常分属左右两栏（纵向间隙 ≈ 0 或负数），
   * 于是中位数被拉到 1~8px → 阈值 `max(4, 行距×1.4)` ≈ 5px →
   * **同栏上下相邻的两行（真实间隙 13px）永远并不到一块** → 每行各自成块
   * （真机实测第 4 页 114 块、下半部 33 块，典型块只有 5~13 字；拖选在块边界就断）。
   *
   * 现在：只统计**横向重叠 ≥ 50%（= 同一栏）**的上下两行的**行距（top 差）**，
   * 取中位数当"正常行距"；并块阈值放宽到 0.85 倍行距（允许段间距并入同一栏，
   * 但"换带"那种 2 倍以上的空白仍然断得开）。
   */
  const pitchOf = (a: Line, b: Line): boolean => {
    const ov = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const minLen = Math.min(a.right - a.left, b.right - b.left);
    return minLen > 0 && ov / minLen >= 0.5;
  };
  const pitches: number[] = [];
  for (const a of lines) {
    let best = Number.POSITIVE_INFINITY;
    for (const b of lines) {
      if (b.top <= a.top + 1) continue;
      if (!pitchOf(a, b)) continue;
      const d = b.top - a.top;
      if (d < best) best = d;
    }
    if (Number.isFinite(best) && best > 0 && best < 400) pitches.push(best);
  }
  pitches.sort((a, b) => a - b);
  const linePitch = pitches.length ? pitches[Math.floor(pitches.length / 2)] : Math.max(12, medianCharWidth * 2);
  /** 纵向并块容差：小于"一个行距的 0.85 倍"的空白才算"紧跟着的下一行" */
  const vTol = Math.max(4, linePitch * 0.85);
  /** 全页 x 范围与"块宽上限"：单栏正文一般 <= 页宽的 55%，超过就说明并块过头了 */
  const pageLeft0 = Math.min(...lines.map((l) => l.left));
  const pageRight0 = Math.max(...lines.map((l) => l.right));
  const pageWidth0 = Math.max(1, pageRight0 - pageLeft0);
  const maxBlockWidth = pageWidth0 * 0.58;

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
      /**
       * 横向基准 = **这一块已累计的包围盒**（`blk.left/right`）。
       *
       * ⚠️ 这里两个方向都踩过，写清楚：
       *   · 用"开块那一行的范围"定死：段首行是**缩进**的（第 4 页左栏首行 `181..525`，
       *     其余行 `142..525`），于是段落末行 `（表１）。`（`142..213`）与它的重叠只有
       *     32/71 = 0.45 < 0.6 → 被拒 → 左栏末尾三行各自成块，**拖选到那里就断**
       *     （离线实测：`5字1行[142..213]`、`32字1行[181..524]` 独立成块）；
       *   · 用"无上限的包围盒"：一个**通栏行**（跨缝那类，`gutters=[]`）并进来后包围盒变满宽，
       *     之后左右栏的行都"重叠 ≥0.6"了 → 整页一块（历史实测 326 字横跨 `[154..1024]`）。
       *
       * 现在两头都堵住了：跨缝行与非跨缝行的 `gutters` 集合天然不同（`sameGutters` 直接拒绝，
       * 见 makeLine），而包围盒的膨胀又被下面的 `maxBlockWidth`（页宽的 58%）卡死 ——
       * 所以可以安全地用包围盒当基准，让"缩进/末行"这类窄行也能并进来。
       */
      const span: [number, number] = [blk.left, blk.right];
      /**
       * **栏缝是块的硬边界**：块与行若落在栏缝的两侧（一边跨缝、另一边不跨，或跨的不是同一条），
       * 就不许并进同一块。
       *
       * 为什么还需要这一条：按字距切分能把跨栏行**切成两行**，但合并阶段又会因为
       * "横向重叠够大"把它们并回**同一块** → 用户在第 1 页左栏里拖仍然会选到右栏
       * （真机实测：选中 50 字、高亮 x[355..959]，越过中线 701）。
       */
      if (typeof window !== 'undefined') {
        const w = window as unknown as { __litshelfMerge?: unknown[] };
        if (!w.__litshelfMerge) w.__litshelfMerge = [];
        if ((w.__litshelfMerge as unknown[]).length < 200) {
          (w.__litshelfMerge as unknown[]).push({ lineTop: Math.round(ln.top), lineL: Math.round(ln.left), lineR: Math.round(ln.right), blkL: Math.round(blk.left), blkR: Math.round(blk.right), gutters: seams.length, gA: (blk.lines[0]?.gutters ?? []).length, gB: (ln.gutters ?? []).length });
        }
      }
      const gA = blk.lines[0]?.gutters ?? [];
      const gB = ln.gutters ?? [];
      const sameGutters = gA.length === gB.length && gA.every((v, i2) => Math.abs(v - gB[i2]) < 2);
      if (!sameGutters) continue;
      /**
       * ## **块的范围不许跨过任何一条栏缝**（范围约束，比上面的集合比较有牙齿）
       *
       * 上面那条"栏缝集合不同就拒绝"有个漏洞：当一条块里**所有行都跨着同一条缝**时，
       * 两边集合相等，它等于没生效 —— 真机实测第 4 页因此出现
       * `528字[142..955]`、`241字[138..945]` 这种横跨两栏的块，拖起来就跨栏。
       *
       * 这里改成对**合并后的范围**做检查：只要合并结果跨过了某条栏缝（而原来两边都没跨过它），
       * 就不许合并。这样"块"在结构上永远只属于栏缝的一侧。
       *
       * ⚠️ 只对**在这一行 y 处生效**的缝做检查（`seamActiveAt`）：表格带里的行不受正文栏缝约束，
       * 否则表格里"跨过正文栏缝 x 的那些单元格"会连不到自己那一列上去（碎块）。
       */
      const mergedL = Math.min(blk.left, ln.left);
      const mergedR = Math.max(blk.right, ln.right);
      const cyLn = (ln.top + ln.bottom) / 2;
      let crossesNewGutter = false;
      for (const s of seams) {
        if (!seamActiveAt(s, cyLn)) continue;
        const g = s.at;
        const blkCrosses = blk.left < g - 1 && blk.right > g + 1;
        const lnCrosses = ln.left < g - 1 && ln.right > g + 1;
        const mergedCrosses = mergedL < g - 1 && mergedR > g + 1;
        if (mergedCrosses && !blkCrosses && !lnCrosses) {
          crossesNewGutter = true;
          break;
        }
      }
      if (crossesNewGutter) continue;
      const ratio = overlapRatio(span, [ln.left, ln.right]);
      if (ratio < 0.6) continue; // 横向不是同一栏
      /**
       * **块宽上限**：并入这一行之后，块的横向跨度不能超过"页宽的 58%"。
       *
       * 为什么加这条：某些块会因为"横向重叠 60%"的宽松判据而被喂进**横向错开的另一栏的行**，
       * 块的包围盒一路涨宽（真机实测第23篇第 1 页出现 326 字/7 行横跨 [154..1024]、
       * 165 字/3 行横跨 [271..1025]）。单栏正文一般不超过页宽的 55%，
       * 超过就说明"这一行其实属于另一栏"，应当开新块。
       */
      const mergedLeft = Math.min(blk.left, ln.left);
      const mergedRight = Math.max(blk.right, ln.right);
      if (mergedRight - mergedLeft > maxBlockWidth && ratio < 0.95) continue;
      const vOverlap = Math.min(blk.bottom, ln.bottom) - Math.max(blk.top, ln.top);
      const vGap = Math.max(blk.top, ln.top) - Math.min(blk.bottom, ln.bottom);
      if (vOverlap <= 0 && vGap > vTol) continue; // 离得太远，是另一段/另一带（见上面的行距说明）
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
      const created: Block = {
        lines: [ln],
        order: [],
        top: ln.top,
        bottom: ln.bottom,
        left: ln.left,
        right: ln.right,
        size: ln.charHeight,
      };
      blocks.push(created);
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
      lineH: Math.round(linePitch),
      lines: lines.length,
      blocks: blocks.map((b) => ({ chars: b.order.length, lines: b.lines.length, left: Math.round(b.left), right: Math.round(b.right) })),
    };
  }
  return blocks;
}

/** 诊断用：当前算的页号（1 起） */
let diagPageNo = 0;

/** 分块结果缓存：模型对象 + 页面像素尺寸为键（缩放后尺寸变 → 自动重算） */
const blockCache = new WeakMap<PageCharModel, { key: string; blocks: Block[] }>();

function blocksFor(model: PageCharModel, pageEl: HTMLElement): { blocks: Block[] } {
  const r = pageEl.getBoundingClientRect();
  const key = `${Math.round(r.width)}x${Math.round(r.height)}`;
  const cached = blockCache.get(model);
  if (cached && cached.key === key) return { blocks: cached.blocks };

  const chars = model.chars;
  diagPageNo = model.pageIndex + 1;
  (window as unknown as Record<string, unknown>).__litshelfPageNo = model.pageIndex + 1;
  /** 这一页的栏缝（带纵向范围）—— **只算一次**，行与块共用（避免跨页覆盖） */
  const seams = pageGuttersOf(chars);
  const lines = buildLines(chars, seams);
  const widths = chars
    .map((c) => c.rect[2] - c.rect[0])
    .filter((w) => w > 0)
    .sort((a, b) => a - b);
  const medianCharWidth = widths.length ? widths[Math.floor(widths.length / 2)] : 8;
  const blocks = buildBlocks(lines, chars, medianCharWidth, seams);
  blockCache.set(model, { key, blocks });

  // 诊断：把"行 + 行内间隙 + 分块"写到磁盘（CDP 返回值有大小限制，写文件没有）
  try {
    const dump = {
      page: model.pageIndex + 1,
      lines: lines.map((ln) => {
        const segs: { from: number; to: number; n: number }[] = [];
        let from = 0;
        for (let k = 1; k <= ln.chars.length; k += 1) {
          const brk = k === ln.chars.length || rectOf(chars[ln.chars[k]])[0] - rectOf(chars[ln.chars[k - 1]])[2] > 3;
          if (brk) {
            segs.push({ from: Math.round(rectOf(chars[ln.chars[from]])[0]), to: Math.round(rectOf(chars[ln.chars[k - 1]])[2]), n: k - from });
            from = k;
          }
        }
        return { top: Math.round(ln.top), bottom: Math.round(ln.bottom), left: Math.round(ln.left), right: Math.round(ln.right), n: ln.chars.length, segs, text: ln.chars.map((i) => chars[i]?.c ?? '').join('').slice(0, 24), xs: ln.chars.map((i) => Math.round(chars[i].rect[0])) };
      }),
      blocks: blocks.map((b) => ({ chars: b.order.length, lines: b.lines.length, left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top) })),
    };
    const w = window as unknown as { litshelf?: { invoke?: (m: string, a: unknown[]) => Promise<unknown> } };
    void w.litshelf?.invoke?.('writeDiag', ['rows-p' + (model.pageIndex + 1) + '.json', JSON.stringify(dump)]);
    /**
     * 诊断（只写盘、不影响行为）：把**模型算出的逐字盒子** dump 出来，
     * 供离线与 PDF 原始项、DOM 字形逐项对照。
     * 用途：判定"栏缝消失"发生在模型构建（itemGeometry/charBoxesOf）还是分块判据。
     *
     * 模型对象上不再有"项"的结构（PairInfo 只存在于构建期），所以这里按
     * "相邻字 x 跳变 / 换行"切出"项段"，足以做对照。
     */
    {
      const segsOut: { text: string; x0: number; x1: number; top: number }[] = [];
      let cur: number[] = [];
      const flush = (): void => {
        if (!cur.length) return;
        segsOut.push({
          text: cur.map((i2) => chars[i2].c).join('').slice(0, 24),
          x0: Math.round(Math.min(...cur.map((i2) => chars[i2].rect[0]))),
          x1: Math.round(Math.max(...cur.map((i2) => chars[i2].rect[2]))),
          top: Math.round(chars[cur[0]].rect[1]),
        });
        cur = [];
      };
      for (let i2 = 0; i2 < chars.length; i2 += 1) {
        const prev = chars[i2 - 1];
        const me = chars[i2];
        const far = !!prev && Math.abs(me.rect[0] - prev.rect[2]) > Math.max(6, medianCharWidth * 0.6);
        const otherLine = !!prev && Math.abs(me.rect[1] - prev.rect[1]) > 2;
        if (far || otherLine) flush();
        cur.push(i2);
      }
      flush();
      const dom = Array.from(pageEl.querySelectorAll('.rd-pdf-text span:not(.markedContent)'))
        .slice(0, 400)
        .map((s) => {
          const b = s.getBoundingClientRect();
          return { t: (s.textContent || '').slice(0, 20), x0: Math.round(b.left), x1: Math.round(b.right) };
        });
      void w.litshelf?.invoke?.('writeDiag', ['items-p' + (model.pageIndex + 1) + '.json', JSON.stringify({ page: model.pageIndex + 1, items: segsOut, dom })]);
    }
    const gut = pageColumnsOf(chars).map((g) => Math.round(g));
    // 直方图（用字中心、2px 格子），写盘供离线分析
    {
      const cs = chars.map((c) => (c.rect[0] + c.rect[2]) / 2).filter((v) => Number.isFinite(v));
      const lo = Math.min(...cs);
      const hi = Math.max(...cs);
      const bin = 2;
      const nb = Math.ceil((hi - lo) / bin) + 2;
      const hist = new Array(nb).fill(0);
      for (const v of cs) {
        const i2 = Math.floor((v - lo) / bin);
        if (i2 >= 0 && i2 < nb) hist[i2] += 1;
      }
      void w.litshelf?.invoke?.('writeDiag', ['hist-p' + (model.pageIndex + 1) + '.json', JSON.stringify({ page: model.pageIndex + 1, lo: Math.round(lo), bin, hist })]);
    }
    void w.litshelf?.invoke?.('writeDiag', [
      'gutters-p' + (model.pageIndex + 1) + '.json',
      JSON.stringify({ page: model.pageIndex + 1, gutters: gut, lines: lines.length, blocks: blocks.map((b) => ({ n: b.order.length, lines: b.lines.length, l: Math.round(b.left), r: Math.round(b.right) })) }),
    ]);
  } catch {
    /* 诊断失败不影响功能 */
  }
  /**
   * 诊断：把"模型坐标"和"DOM 真实字形坐标"放在一起比 —— 用来判断模型几何是否可信。
   * 页面上第一个 span 的屏幕位置 vs 模型第一个字的坐标，两者应当一致（差值 = 页面左边界）。
   */
  if (typeof window !== 'undefined') {
    (window as unknown as { __litshelfCoordCheck?: () => unknown }).__litshelfCoordCheck = () => {
      const layer = pageEl.querySelector('.rd-pdf-text');
      const firstSpan = layer ? layer.querySelector('span:not(.markedContent)') : null;
      const pr = pageEl.getBoundingClientRect();
      const sr = firstSpan ? firstSpan.getBoundingClientRect() : null;
      return {
        page: model.pageIndex + 1,
        pageRect: { l: Math.round(pr.left), t: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height) },
        domFirstSpan: sr && firstSpan ? { text: firstSpan.textContent, x: Math.round(sr.left - pr.left), y: Math.round(sr.top - pr.top), w: Math.round(sr.width) } : null,
        modelFirstChar: chars[0] ? { c: chars[0].c, x: Math.round(chars[0].rect[0]), y: Math.round(chars[0].rect[1]), w: Math.round(chars[0].rect[2] - chars[0].rect[0]) } : null,
        modelCharCount: chars.length,
        domSpanCount: layer ? layer.querySelectorAll('span:not(.markedContent)').length : -1,
      };
    };
  }
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
  /**
   * ## "按下还没开始拖"的状态（Word 式交互）
   *
   * 用户的反馈：点一下空白，它会把**最近的那一个字**选上（截图里点右侧空白，结果选中了左边的「。」），
   * 期望是 Word 那样 —— **单击 = 清空选区，只有拖动才开始选**。
   *
   * 所以按下时**只记录候选锚点、不画选区**；指针位移超过 `DRAG_THRESHOLD` 才真正开始选。
   * 松手时如果从未超过阈值（= 一次点击），什么都不选（按下时已经清过旧选区了）。
   */
  let pressAnchor: { pageIndex: number; offset: number; block: Block | null } | null = null;
  let pressX = 0;
  let pressY = 0;
  /** 是否已经越过拖动阈值、正式进入"选取中" */
  let selecting = false;
  /** 拖动阈值（px）：小于它视为单击。和浏览器/Word 的手感一致（约 4~6px） */
  const DRAG_THRESHOLD_SQ = 25;
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
    /**
     * ## ⚠️ 判"指针落在哪个字上"必须用**逐字盒**（`charRectOf`），不能用行盒（`itemRectOf`）
     *
     * `itemRectOf` 是**视觉行盒**（`selectionModel.buildLines` 回填的、同一基线所有项的并集盒，
     * 横向还会横跨左右两栏）。拿它当"这一行的高度带"的后果：多认出一圈"行内"的点 ——
     * 这些点其实落在**相邻字的盒子里**，却走了"行内按 x 打分"的分支，而 `key < bestKey - 1e-9`
     * 稳定偏向**更早的字**，于是锚点落到左邻那个字上。
     *
     * 真机实测（5 页真机模型 × 4px 网格 = **107619** 个"逐字盒含点"的点，
     * 工具 `tmp/sel-harness/hit-regress.mjs`，两个变体都是 esbuild 打真源码跑真 `begin()`）：
     *   · 旧判据命中 **99.70%**（错 333 点，全是上下标/括号这类紧邻字：指针在「２」上却选到「（」）；
     *   · 逐字盒 + "到字盒的距离"判据 **100.00%（错 0）**，且**没有任何一点由对变错**（劣化 0）。
     */
    const lineDy = (c: ZoteroChar): number => {
      const r = charRectOf(c);
      if (y < r[1]) return r[1] - y;
      if (y > r[3]) return y - r[3];
      return 0;
    };
    /** 指针到"这个字自己"的横向距离（0 = 指针在它的左右范围内） */
    const lineDx = (c: ZoteroChar): number => {
      const r = charRectOf(c);
      if (x < r[0]) return r[0] - x;
      if (x > r[2]) return x - r[2];
      return 0;
    };
    let best = -1;
    let bestKey = Number.POSITIVE_INFINITY;
    for (let k = 0; k < chars.length; k += 1) {
      const c = chars[k];
      const dy = lineDy(c);
      if (dy > hitTol) continue;
      /**
       * 指针就在这个字盒里 → 0 分（不可能更优）；否则按**到字盒的距离**打分，纵向权重 ×8
       * （与下面"容差内一个都没有"的兜底循环同一套度量）。
       *
       * ⚠️ 不要写成"先纵向、后横向"的字典序（也不要 `dy*100 + x` 这类极端权重）：那样只要某个字
       * 的 y 范围盖住指针（哪怕它在**另一栏**、横向 800px 外），就会压过同一行里横向 100px 的字。
       * 真机实测第 4 页"点在右侧页边空白"处，字典序把锚点甩到左栏 **871px** 外；
       * 距离度量选的是同一条带上 104px 外的字 —— 与人的直觉一致。
       */
      const key = lineDx(c) + dy * 8;
      if (key < bestKey - 1e-9) {
        bestKey = key;
        best = k;
      }
    }
    if (best >= 0) return best;
    // 容差内一个都没有（指针在行间/栏缝里）：到**逐字盒**的距离，横向为主 + 纵向重罚
    let near = -1;
    let nearKey = Number.POSITIVE_INFINITY;
    for (let k = 0; k < chars.length; k += 1) {
      const line = charRectOf(chars[k]);
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
      const line = itemRectOf(c);
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
    for (const el of highlights) el.remove();
    highlights.length = 0;
    if (!selection) return;

    /**
     * ## 优先：画进**页面内部**的相对坐标层（和批注层同一套机制）
     *
     * 这样缩放（页面的 CSS 预览缩放）、翻页、切换布局时，高亮天然跟着页面/文字走：
     * 页面盒子尺寸一变，百分比定位自动等比缩放，**不需要重算也不需要交接** ——
     * 从根上消除"先飘走、再跳回"的闪烁（用户逐帧录屏抓到过：y285 → y601 → y285 → y601）。
     */
    const hostFor = deps.highlightHost;
    if (hostFor) {
      const page = deps.pages().find((p) => p.pageIndex === selection?.pageIndex);
      const host = hostFor(selection.pageIndex);
      if (!page || !host || page.modelWidth <= 0 || page.modelHeight <= 0) return;
      const w = page.modelWidth;
      const h = page.modelHeight;
      for (const [x1, y1, x2, y2] of selection.pageRects) {
        const div = host.ownerDocument.createElement('div');
        div.className = 'sel-line';
        div.style.position = 'absolute';
        div.style.left = `${(x1 / w) * 100}%`;
        div.style.top = `${(y1 / h) * 100}%`;
        div.style.width = `${(Math.max(1, x2 - x1) / w) * 100}%`;
        div.style.height = `${(Math.max(1, y2 - y1) / h) * 100}%`;
        div.style.pointerEvents = 'none';
        host.appendChild(div);
        highlights.push(div);
      }
      return;
    }

    // 兜底：旧的 fixed overlay（客户端坐标）
    const host = deps.overlay?.() ?? overlayHost;
    if (!host) return;
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
      // 页内坐标（原点 = 页面左上角，单位 = 模型坐标系像素）：画进页面内部层用
      pageRects: buildLineRects(chars, idx, { left: 0, top: 0 }),
      charIndices: idx,
    };
    paint();
    publish(selection);
    deps.onSelection(selection);
  };

  const engine: SelectionEngine = {
    begin(clientX, clientY, extend = false) {
      const h = hit(clientX, clientY);
      if (extend && anchor && anchor.block) {
        // Shift+点击：锚点不动，焦点挪到"锚点块内离指针最近的字"（立即生效，不受拖动阈值影响）
        if (!h) return false;
        head = { pageIndex: anchor.pageIndex, offset: nearestInBlock(anchor.block, h.page.model.chars, h.x, h.y) };
        // ⚠️ 必须标成"选取中"：否则松手时 end() 会把它当成一次普通单击、把选区清掉
        //（实测：Shift+点击后选区闪一下就没了）
        selecting = true;
        rebuild();
        return true;
      }
      /**
       * 普通按下（Word 式）：
       *   1. **先清空旧选区** —— 单击就是"取消选择"，不该残留上一次的选区；
       *   2. 只记下候选锚点，**不画任何东西**；
       *   3. 指针移动超过阈值（`move()` 里判断）才开始真正选。
       */
      anchor = null;
      head = null;
      pressAnchor = null;
      selecting = false;
      clearSelection();
      if (!h) return false;
      const { blocks } = blocksFor(h.page.model, h.page.pageEl);
      pressAnchor = { pageIndex: h.page.pageIndex, offset: h.offset, block: blockOfChar(blocks, h.offset) };
      pressX = clientX;
      pressY = clientY;
      log('按下（待拖动）', { page: h.page.pageIndex, char: h.page.model.chars[h.offset]?.c });
      return true;
    },
    move(clientX, clientY) {
      // 还没进入"选取中"：先看位移是否超过阈值（单击 = 什么都不选）
      if (!selecting) {
        if (!pressAnchor) return;
        const dx = clientX - pressX;
        const dy = clientY - pressY;
        if (dx * dx + dy * dy < DRAG_THRESHOLD_SQ) return;
        selecting = true;
        anchor = pressAnchor;
        pressAnchor = null;
        head = { pageIndex: anchor.pageIndex, offset: anchor.offset };
        log('开始拖动', { page: anchor.pageIndex });
      }
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
      /**
       * 松手：如果整个按下-松手过程都没超过拖动阈值（= 单击），
       * 保持"没有选区"（按下时已清空）。拖动过的话选区已经在 `move()` 里定好了。
       */
      if (!selecting) {
        anchor = null;
        head = null;
        pressAnchor = null;
        clearSelection();
      }
      selecting = false;
      pressAnchor = null;
      log('松手', selection ? { chars: selection.text.length, lines: selection.rects.length } : null);
    },
    clear() {
      anchor = null;
      head = null;
      pressAnchor = null;
      selecting = false;
      clearSelection();
    },
    current: () => selection,
    refresh() {
      overlayHost = deps.overlay?.() ?? overlayHost;
      /**
       * ⚠️ 缩放 / 切换布局会**重排并重绘**页面：重绘的瞬间，本页的文本层可能被临时移除，
       * `deps.pages()` 里找不到它。这时**绝不能调 `rebuild()`** —— 它会把选区清掉
       * （用户表现：放大一下，刚选好的文字和顶部工具条一起消失）。
       * 正确做法：保持现状，等页面回来后的下一次 refresh 再按新几何重算。
       */
      if (anchor) {
        const page = deps.pages().find((p) => p.pageIndex === anchor?.pageIndex);
        if (!page) return;
        const { blocks } = blocksFor(page.model, page.pageEl);
        anchor = { pageIndex: anchor.pageIndex, offset: anchor.offset, block: blockOfChar(blocks, anchor.offset) };
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

  overlayHost = deps.overlay?.() ?? null;

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

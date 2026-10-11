/**
 * 文本层的"阅读顺序"重排。
 *
 * 为什么需要：
 * pdf.js 的 TextLayer 是按**内容流顺序**往容器里追加 span 的，而这个顺序**不等于视觉阅读顺序**
 * ——多栏排版（中文期刊常见 2～3 栏）里，同一行会先写左栏、再写中栏、再写右栏，甚至整页乱序。
 *
 * 浏览器扩展选区是**按 DOM 顺序**走的（从锚点到焦点，把 DOM 里中间的所有文字都算进来）。
 * DOM 顺序和视觉顺序不一致时，指针只是从某行挪到下一行的空隙，焦点就可能落到 DOM 里很远的
 * 一个 span 上，选区"啪"地把中间一大段全吃了 —— 用户看到的就是"莫名其妙多选一大段"。
 *
 * 修法很省事：span 都是绝对定位（transform 定坐标），**改 DOM 顺序不影响外观**，
 * 只影响选择语义。所以我们按"先分栏、栏内从上到下、行内从左到右"重排一次 DOM，
 * 浏览器的原生选择行为立刻变成 Word 那种感觉。
 */

export interface TextBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 行内判定容差：同一行的两个 span，竖直中心线差小于"行高的一半"就算一行 */
const lineTol = (boxes: TextBox[]): number => {
  const hs = boxes.map((b) => b.height).filter((h) => h > 0).sort((a, b) => a - b);
  if (!hs.length) return 1;
  const median = hs[Math.floor(hs.length / 2)];
  return Math.max(2, median * 0.5);
};

/**
 * 找纵向"空白通道"（分栏缝）：页面宽度上有一段没有任何 span 覆盖，
 * 且宽度超过阈值（默认 6px，或页宽的 0.6%）。
 *
 * 只看**窄**于页宽 70% 的盒子来算通道——整幅宽的标题/图注会横跨栏缝，
 * 把它们算进来的话栏缝就"消失"了（真实期刊里很常见）。
 */
export function findGutters(boxes: TextBox[], minWidth = 6): { start: number; end: number }[] {
  if (boxes.length < 2) return [];
  const min = Math.min(...boxes.map((b) => b.left));
  const max = Math.max(...boxes.map((b) => b.left + b.width));
  const span = max - min;
  if (span <= 0) return [];
  const wide = span * 0.7;
  const narrow = boxes.filter((b) => b.width > 0 && b.width < wide);
  if (narrow.length < 4) return [];

  const bins = new Uint8Array(Math.ceil(span) + 1);
  for (const b of narrow) {
    const from = Math.max(0, Math.floor(b.left - min));
    const to = Math.min(bins.length - 1, Math.ceil(b.left + b.width - min));
    for (let i = from; i <= to; i += 1) bins[i] = 1;
  }
  const threshold = Math.max(minWidth, span * 0.006);
  const gutters: { start: number; end: number }[] = [];
  let run = 0;
  for (let i = 1; i < bins.length; i += 1) {
    if (!bins[i]) {
      run += 1;
      continue;
    }
    // 通道必须是"内部"的（左边和右边都得有内容），页边距不算
    if (run >= threshold && i - run > 0) {
      const start = min + i - run;
      const end = min + i;
      if (isRealGutter(boxes, narrow, start, end)) gutters.push({ start, end });
    }
    run = 0;
  }
  return gutters;
}

/**
 * 真栏缝 vs 行内空隙：**栏缝必须在多数行上都成立**——缝的左边有文字、右边也有文字。
 * 反例（实测踩过）：某一行被切成两段（左边正文 + 右边一小块），中间 60px 的空隙
 * 会被误判成栏缝，于是整页被切成两栏，阅读顺序反而错乱。
 *
 * 注意：数"行"要用**全部**盒子（通栏标题、图注也算行），否则两行版式的页面会被判成行数太少，
 * 真实栏缝反而被拒掉。
 */
function isRealGutter(all: TextBox[], narrow: TextBox[], start: number, end: number): boolean {
  const rows = new Map<number, TextBox[]>();
  for (const b of all) {
    const key = Math.round(b.top / 6) * 6;
    const list = rows.get(key);
    if (list) list.push(b);
    else rows.set(key, [b]);
  }
  const total = rows.size;
  if (total < 2) return false;
  let left = 0;
  let right = 0;
  for (const list of rows.values()) {
    const n = list.filter((b) => narrow.includes(b));
    if (n.some((b) => b.left + b.width <= start + 1)) left += 1;
    if (n.some((b) => b.left >= end - 1)) right += 1;
  }
  const need = Math.max(2, Math.floor(total * 0.4));
  return left >= need && right >= need;
}

/**
 * 页面的**栏模型**：把 span 归成若干栏（纵向 x 区间）。
 *
 * 用途：划词时"选区不许跨栏"。为什么需要：文本层按阅读顺序排 DOM 之后，
 * 浏览器按 DOM 顺序扩展选区 —— 横向拖过三栏会把"左栏剩余 + 整段中栏 + 右栏开头"
 * 连成一片（用户看到的就是一条横穿三栏的高亮带，在论文版式里非常离谱）。
 * 单栏页面返回一个区间，调用方据此跳过处理。
 */
export function columnsOf(boxes: TextBox[], minGutter = 6): { start: number; end: number }[] {
  if (!boxes.length) return [];
  const min = Math.min(...boxes.map((b) => b.left));
  const max = Math.max(...boxes.map((b) => b.left + b.width));
  const gutters = findGutters(boxes, minGutter);
  if (!gutters.length) return [{ start: min, end: max }];
  const cols: { start: number; end: number }[] = [];
  let start = min;
  for (const g of gutters) {
    cols.push({ start, end: g.start });
    start = g.end;
  }
  cols.push({ start, end: max });
  return cols.filter((c) => c.end - c.start > 1);
}

/** 某个 x（页面坐标）落在第几栏；不在任何栏内（栏缝里）返回 -1 */
export function columnIndexAt(columns: { start: number; end: number }[], x: number): number {
  for (let i = 0; i < columns.length; i += 1) {
    if (x >= columns[i].start && x <= columns[i].end) return i;
  }
  return -1;
}

/**
 * 某个 x 所在的**文字块窗口**（连续有文字覆盖的 x 区间）。
 *
 * 比 `columnsOf` 稳得多，专供"划词不许跨栏"用：只看 x 方向的覆盖投影，
 * 不依赖"行"的聚类（真实期刊里 span 盒子高度虚大，按行归类很容易翻车 ——
 * 实测有一页三栏正文，`columnsOf` 只认出一栏，夹取就永远不触发）。
 * 同一栏内字与字之间的细小空隙会被跨过（`minGap` 以内视为连续）。
 */
export function xWindowOf(boxes: TextBox[], x: number, minGap = 8): { start: number; end: number } | null {
  if (!boxes.length) return null;
  const min = Math.min(...boxes.map((b) => b.left));
  const max = Math.max(...boxes.map((b) => b.left + b.width));
  if (!(max > min)) return null;
  const bins = new Uint8Array(Math.ceil(max - min) + 1);
  for (const b of boxes) {
    if (b.width <= 0) continue;
    const from = Math.max(0, Math.floor(b.left - min));
    const to = Math.min(bins.length - 1, Math.ceil(b.left + b.width - min));
    for (let i = from; i <= to; i += 1) bins[i] = 1;
  }
  const at = Math.max(0, Math.min(bins.length - 1, Math.round(x - min)));
  if (!bins[at]) return null; // 落在栏缝/页边空白里：调用方自己决定怎么办
  let s = at;
  let e = at;
  // 向左、向右扩张；遇到小于 minGap 的空洞跨过去，遇到大空洞就是窗口边界
  const expand = (dir: -1 | 1): number => {
    let i = dir === -1 ? s : e;
    for (;;) {
      const next = i + dir;
      if (next < 0 || next >= bins.length) return i;
      if (bins[next]) {
        i = next;
        continue;
      }
      // 量一下这个空洞有多宽
      let gapEnd = next;
      while (gapEnd >= 0 && gapEnd < bins.length && !bins[gapEnd]) gapEnd += dir;
      const gap = Math.abs(gapEnd - next);
      if (gapEnd < 0 || gapEnd >= bins.length || gap >= minGap) return i;
      i = gapEnd;
    }
  };
  s = expand(-1);
  e = expand(1);
  return { start: min + s, end: min + e };
}

/**
 * 返回按**阅读顺序**排列的下标数组（不改变入参）。
 *
 * 规则：
 *   ① 分栏：按找出的栏缝把页面横向切段；
 *   ② 横跨栏缝的盒子（标题、通栏图注）单独处理，按自身 top 插进结果里；
 *   ③ 栏内从上到下，同一行内从左到右。
 */
export function orderTextSpans(boxes: TextBox[]): number[] {
  const n = boxes.length;
  const identity = Array.from({ length: n }, (_, i) => i);
  if (n < 2) return identity;

  const gutters = findGutters(boxes);
  const minX = Math.min(...boxes.map((b) => b.left));
  const maxX = Math.max(...boxes.map((b) => b.left + b.width));
  const bounds = [minX, ...gutters.map((g) => (g.start + g.end) / 2), maxX];

  /** 一个盒子属于哪一栏（跨栏返回 -1） */
  const columnOf = (b: TextBox): number => {
    const cx = b.left + b.width / 2;
    for (let c = 0; c < bounds.length - 1; c += 1) {
      if (cx >= bounds[c] && cx <= bounds[c + 1]) {
        // 跨栏判定：盒子自己的左右边都越过了栏边界
        const crosses = bounds.slice(1, -1).some((g) => b.left < g && b.left + b.width > g);
        return crosses ? -1 : c;
      }
    }
    return -1;
  };

  const tol = lineTol(boxes);
  /** 栏内排序：先按行（top 近似），行内按 left */
  const sortWithin = (idx: number[]): number[] =>
    idx.slice().sort((a, b) => {
      const d = boxes[a].top - boxes[b].top;
      if (Math.abs(d) > tol) return d;
      return boxes[a].left - boxes[b].left;
    });

  const spanBoxes = identity.filter((i) => columnOf(boxes[i]) === -1);
  const columnCount = Math.max(1, bounds.length - 1);
  const columns: number[][] = Array.from({ length: columnCount }, () => []);
  for (const i of identity) {
    const c = columnOf(boxes[i]);
    if (c >= 0) columns[c].push(i);
  }

  const ordered: number[] = [];
  for (const col of columns) ordered.push(...sortWithin(col));
  if (!spanBoxes.length) return ordered;

  // 通栏盒子按 top 插回去（保持整体从上到下的阅读感）
  const merged: number[] = [];
  const extra = spanBoxes.slice().sort((a, b) => boxes[a].top - boxes[b].top);
  let e = 0;
  for (const i of ordered) {
    while (e < extra.length && boxes[extra[e]].top <= boxes[i].top) {
      merged.push(extra[e]);
      e += 1;
    }
    merged.push(i);
  }
  while (e < extra.length) {
    merged.push(extra[e]);
    e += 1;
  }
  return merged;
}

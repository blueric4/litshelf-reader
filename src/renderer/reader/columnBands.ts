/**
 * 栏带（column bands）：把一页 PDF 的正文按"栏"切成若干 x 区间，供划词**硬性禁止跨栏**。
 *
 * 为什么不再用 DOM 文本层做投影：
 * 上一版 `textOrder.ts::xWindowOf()` 拿 span 的 getBoundingClientRect 做 x 覆盖投影，
 * 真实期刊页面上只要有竖排/旋转的文字（页眉、侧边条、竖排标题），投影就会被"桥接"成一块，
 * 三栏被算成一栏，跨栏夹取永远不触发（实测横向拖选仍横穿三栏）。
 *
 * 改用 pdf.js 的**文本项**（`page.getTextContent().items`）：每项自带 transform / width / height，
 * 才知道"这一段文字往哪个方向排、有多长"：
 *   - 横排字体：`width` = 这一行的长度，`height` = 字号
 *     （pdf.js 源码：`height = Math.hypot(trm[2], trm[3])`，宽由字距累加）
 *   - 竖排字体（WMode 1）：`width` = 字号，`height` = 这一行的长度
 * 所以"高 ÷ 宽 ≥ 2.5"就是竖排项的特征——先丢掉它们再投影，栏缝就不会被桥接。
 *
 * 坐标系（两套，别混）：
 *   - 入参 items：pdf.js 原样，`transform[4]/[5]` 是 PDF 用户空间的 x/y，**y 向上**、未缩放；
 *   - 出参 BandItem / 栏区间：**页面坐标，y 向下**，并且乘过 `opts.scale`
 *     （传 `viewport.scale` 就与 DOM 的 getBoundingClientRect 同一套单位，可直接用来夹选区）。
 */

/** pdf.js 文本项里我们用到的那几个字段（结构兼容，不 import pdfjs 类型，模块保持纯净） */
export interface PdfTextItemLike {
  str?: string;
  /** [a,b,c,d,e,f]：a/b 是文本方向的 cos/sin，e/f 是基线原点（PDF 用户空间，y 向上） */
  transform?: ArrayLike<number> | null;
  /** 文本方向的长度（横排）或字号（竖排） */
  width?: number;
  /** 字号（横排）或文本方向的长度（竖排） */
  height?: number;
  fontName?: string;
}

/** `page.getTextContent().styles` 里我们用的字段（`vertical` 是字体本身是否竖排） */
export interface PdfTextStyleLike {
  vertical?: boolean;
}

export interface ColumnBandOptions {
  /** 页面高度（PDF 用户空间、**未缩放**，即 `viewport.height / viewport.scale`）；y 翻转要用 */
  pageHeight: number;
  /** 页面宽度（同上）。不给就用 items 的 x 包围盒宽度顶替（只会让"页宽百分比"阈值略偏严） */
  pageWidth?: number;
  /** 缩放：给了就把所有几何乘上它（`viewport.scale`）；默认 1（PDF 用户空间） */
  scale?: number;
  /** `page.getTextContent().styles`：给了就能按"字体是否竖排"精确判定，而不是只看宽高比 */
  styles?: Record<string, PdfTextStyleLike> | null;
  /** 栏缝最小宽度 = 页宽 × 该比例（默认 0.008，见下方注释的实测数据） */
  minGutterRatio?: number;
  /** 通道允许被"顺带压过"的行带比例（默认 0.35）：顶部通栏标题/引文压住几行不算栏缝被填满 */
  maxChannelCoverRatio?: number;
  /** 竖排判定：高 ÷ 宽 ≥ 该值即视为竖排项丢弃（默认 2.5） */
  verticalAspect?: number;
  /** 栏缝两侧各自至少要在多少个 y 带上有正文（默认 2） */
  minRowBandsEachSide?: number;
  /** 切出来的"栏"至少要有页宽的多少（默认 0.15），防止把页边注/行号切成一条窄栏 */
  minBandRatio?: number;
  /** y 直方图的带高（同一坐标系，可选）；不给按正文行高的中位数推 */
  rowBandSize?: number;
}

/** 页面坐标下的一个文本盒（y 向下、已乘 scale） */
export interface BandItem {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一个 x 区间（栏） */
export interface BandRange {
  start: number;
  end: number;
}

/**
 * 默认值。两个比例是照着**真实中文期刊 PDF 实测**定的（8 篇 CNKI 论文、逐页跑文本项）：
 *   - 两栏页面的栏缝：并集投影后剩 6~25px（页宽 540~595，即 1.0%~4.6%）；
 *   - 单栏页面：正文行内的项盒子互相重叠，投影里**一个内部空隙都没有**（连 1px 都没有）。
 * 所以 0.8% 既能切到最窄的那条真栏缝（样本文献 A（双栏）p4 的 6px），又不会把单栏页面切开。
 */
const DEFAULTS = {
  minGutterRatio: 0.008,
  // 0.35 是"顶部通栏标题/引文"与"上部整块通栏摘要"的分界线：前者只占 ~10% 行带（真两栏页，
  // 必须切）；后者常占 40%+（整页上半是通栏摘要，下半才两栏 —— 这种页面上半部分的横向选区是
  // 合法的，按整页 x 区间硬夹会误伤，所以宁可当单栏放过）。
  maxChannelCoverRatio: 0.35,
  verticalAspect: 2.5,
  minRowBandsEachSide: 2,
  minBandRatio: 0.15,
} as const;

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const countOnes = (flags: Uint8Array): number => {
  let n = 0;
  for (let i = 0; i < flags.length; i += 1) if (flags[i]) n += 1;
  return n;
};

/**
 * 把 pdf.js 的文本项归一成**页面坐标**的文本盒。
 * 顺手做两件事：丢掉竖排/旋转的长条、跳过空串项（pdf.js 会为换行、标记内容发 `str: ''` 的项）。
 */
export function bandItemsFromItems(
  items: readonly PdfTextItemLike[] | null | undefined,
  opts: ColumnBandOptions,
): BandItem[] {
  const out: BandItem[] = [];
  const scale = num(opts?.scale, 1);
  const pageHeight = num(opts?.pageHeight, 0);
  if (!items?.length || !(scale > 0) || !(pageHeight > 0)) return out;
  const verticalAspect = num(opts?.verticalAspect, DEFAULTS.verticalAspect);

  for (const it of items) {
    if (!it || typeof it.str !== 'string' || !it.str.trim()) continue;
    const tf = it.transform;
    if (!tf || tf.length < 6) continue;
    const a = Number(tf[0]);
    const b = Number(tf[1]);
    const e = Number(tf[4]);
    const f = Number(tf[5]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(e) || !Number.isFinite(f)) continue;

    const rawW = Math.abs(num(it.width, 0));
    const rawH = Math.abs(num(it.height, 0));
    if (!(rawW > 0) && !(rawH > 0)) continue;

    const style = opts?.styles && it.fontName ? opts.styles[it.fontName] : undefined;
    // 竖排字体的项一律不参与栏带判定：pdf.js 给这类项的 width 是"字号"而不是行宽，
    // 混进 x 投影只会误导（它就是用户报的竖排页眉那类东西）。给了 styles 就能精确认出来。
    if (style?.vertical) continue;
    let w = rawW;
    let h = rawH;
    // 横排字体但整行被旋转（比如 90° 的侧边标题）：宽高要按文本方向投到 x/y 轴上，
    // 才是"页面上真正占的盒子"。
    const theta = Math.atan2(b, a);
    const sin = Math.abs(Math.sin(theta));
    if (sin > 0.05) {
      const cos = Math.abs(Math.cos(theta));
      w = rawW * cos + rawH * sin;
      h = rawW * sin + rawH * cos;
    }
    if (!(w > 0)) continue;
    // 竖排项里"高远大于宽"的（整行竖排）用几何特征就能认出来，见模块头注释
    if (h >= w * verticalAspect) continue;

    // f 是基线（y 向上）；盒子从基线往上一个 h。翻成 y 向下后取顶边。
    out.push({ x: e * scale, y: (pageHeight - (f + h)) * scale, w: w * scale, h: h * scale });
  }
  return out;
}

/**
 * 找栏缝：x 方向上**在多数 y 带上都没有正文**的通道，且缝的左右两侧都在多个 y 带上都有正文。
 *
 * 三个约束缺一不可（都是真实页面逼出来的）：
 *   ① 宽度 ≥ 页宽 × minGutterRatio —— 一行之内的字距空隙（通常 ≤ 3px）不能当栏缝；
 *   ② 通道在 ≤ maxChannelCoverRatio 比例的 y 带上被文字压过 —— **不能要求"一处都没有"**：
 *      真实期刊的栏缝常被顶部的通栏标题/宽引文压住几行（实测样本文献 A（双栏）p4：标题+4 行引文
 *      只占 51 个行带里的 5 个 ≈ 10%，却把整条缝"桥接"掉，于是两栏被当成一栏、跨栏夹取不触发）。
 *      反过来，如果通道被压过的行带超过 1/3（上半页是整块通栏摘要那种版式），就不认它是栏缝。
 *   ③ 两侧在 ≥ minRowBandsEachSide 个 y 带上都有正文 —— 单独一两行短了留下的空隙不算。
 *   ④ 由调用方再要求"切出来的栏不能太窄"（见 columnBandsFromItems）。
 */
function findBandGutters(basis: readonly BandItem[], opts: ColumnBandOptions, pageW: number, minX: number, maxX: number): BandRange[] {
  const gutters: BandRange[] = [];
  const span = Math.max(1, maxX - minX);
  const width = Math.ceil(span) + 1;

  // y 直方图：把正文的 y 跨度切成若干"行带"，用于"缝两侧都有成片正文"与"通道有多空"的判定
  const heights = basis.map((b) => b.h).filter((h) => h > 0).sort((p, q) => p - q);
  const medH = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const b of basis) {
    if (b.y < minY) minY = b.y;
    const bottom = b.y + Math.max(b.h, 1);
    if (bottom > maxY) maxY = bottom;
  }
  const contentH = Math.max(1, maxY - minY);
  const scale = num(opts.scale, 1);
  const bandSize = Math.max(
    1,
    num(opts.rowBandSize, 0) > 0 ? num(opts.rowBandSize, 0) * scale : Math.max(medH * 2, contentH / 32),
  );
  const bandCount = Math.max(1, Math.ceil(contentH / bandSize));
  const needBands = Math.max(1, Math.round(num(opts.minRowBandsEachSide, DEFAULTS.minRowBandsEachSide)));
  const bandOf = (y: number): number => Math.min(bandCount - 1, Math.max(0, Math.floor((y - minY) / bandSize)));

  // 每个行带各自的 x 覆盖，再逐 x 统计"被多少个行带压过"
  const perBand: Uint8Array[] = [];
  for (let k = 0; k < bandCount; k += 1) perBand.push(new Uint8Array(width));
  for (const b of basis) {
    if (!(b.w > 0)) continue;
    const from = Math.max(0, Math.floor(b.x - minX));
    const to = Math.min(width - 1, Math.ceil(b.x + b.w - minX));
    const k0 = bandOf(b.y);
    const k1 = bandOf(b.y + Math.max(b.h, 1));
    for (let k = k0; k <= k1; k += 1) {
      const row = perBand[k];
      for (let i = from; i <= to; i += 1) row[i] = 1;
    }
  }
  const covered = new Uint16Array(width);
  for (let k = 0; k < bandCount; k += 1) {
    const row = perBand[k];
    for (let i = 0; i < width; i += 1) if (row[i]) covered[i] += 1;
  }
  const maxCover = Math.max(1, Math.round(bandCount * num(opts.maxChannelCoverRatio, DEFAULTS.maxChannelCoverRatio)));

  const gapMin = Math.max(1, pageW * num(opts.minGutterRatio, DEFAULTS.minGutterRatio));
  let run = 0;
  for (let i = 1; i <= width; i += 1) {
    if (i < width && covered[i] <= maxCover) {
      run += 1;
      continue;
    }
    if (run >= gapMin) {
      const start = minX + i - run;
      const end = minX + i;
      const left = new Uint8Array(bandCount);
      const right = new Uint8Array(bandCount);
      for (const b of basis) {
        const k = bandOf(b.y);
        if (b.x + b.w <= start) left[k] = 1;
        if (b.x >= end) right[k] = 1;
      }
      // 页边距也表现为"一整段没有文字"，但它的两侧没有正文（left/right 计数为 0）→ 自动被拒
      if (countOnes(left) >= needBands && countOnes(right) >= needBands) gutters.push({ start, end });
    }
    run = 0;
  }
  return gutters;
}

/**
 * 从 pdf.js 文本项构建栏目 x 区间（左→右）。
 *
 * 步骤：① 归一 + 丢竖排项；② 按 y 带统计每个 x 被多少行带压过；③ 取"多数行带都空"的通道当栏缝；
 * ④ 丢掉会切出"过窄的栏"的缝。
 * 单栏页面返回一个区间，调用方据此跳过跨栏处理。
 *
 * 注意：这里**不按宽度筛掉"通栏标题"**。上一版筛过，结果是样本文献 A（双栏）p4 那种页面反而漏判：
 * 顶部的标题/宽引文只有 16~23% 页宽，筛不掉，却把 x≈302 那条 6px 的栏缝在并集投影里"桥接"掉。
 * 现在改由"通道覆盖率"处理 —— 标题只占少数行带，缝照样成立；而真正的通栏正文块会占掉多数行带，
 * 缝自然不成立。
 */
export function columnBandsFromItems(
  items: readonly PdfTextItemLike[] | null | undefined,
  opts: ColumnBandOptions,
): BandRange[] {
  const all = bandItemsFromItems(items, opts);
  if (!all.length) return [];
  const scale = num(opts?.scale, 1);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const b of all) {
    if (b.x < minX) minX = b.x;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
  }
  const pageW = num(opts?.pageWidth, 0) > 0 ? num(opts?.pageWidth, 0) * scale : Math.max(1, maxX - minX);

  const gutters = findBandGutters(all, opts ?? {}, pageW, minX, maxX);
  if (!gutters.length) return [{ start: minX, end: maxX }];

  // 过窄的"栏"不要（真实数据里没有 <15% 页宽的正文栏，那种缝多半是页边注/行号造成的）
  const minBand = pageW * num(opts?.minBandRatio, DEFAULTS.minBandRatio);
  const kept: BandRange[] = [];
  let left = minX;
  for (const g of gutters) {
    if (g.start - left < minBand) continue;
    kept.push(g);
    left = g.end;
  }
  while (kept.length && maxX - kept[kept.length - 1].end < minBand) kept.pop();
  if (!kept.length) return [{ start: minX, end: maxX }];

  const bands: BandRange[] = [];
  let start = minX;
  for (const g of kept) {
    bands.push({ start, end: g.start });
    start = g.end;
  }
  bands.push({ start, end: maxX });
  return bands;
}

/** 某个 x 落在第几栏；落在栏缝/页边（不属于任何栏）返回 -1 */
export function bandIndexOf(bands: readonly BandRange[] | null | undefined, x: number): number {
  if (!bands?.length || !Number.isFinite(x)) return -1;
  for (let i = 0; i < bands.length; i += 1) {
    if (x >= bands[i].start && x <= bands[i].end) return i;
  }
  return -1;
}

/** 两个 x 是不是分属不同栏（任一端落在栏缝里时返回 false，交给调用方按锚点决定） */
export function isCrossBand(bands: readonly BandRange[] | null | undefined, x1: number, x2: number): boolean {
  const a = bandIndexOf(bands, x1);
  const b = bandIndexOf(bands, x2);
  return a >= 0 && b >= 0 && a !== b;
}

/** 落在栏缝/页边时，离它最近的那一栏（给"把端点夹回某一栏"的调用方用） */
export function nearestBandIndexOf(bands: readonly BandRange[] | null | undefined, x: number): number {
  if (!bands?.length) return -1;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < bands.length; i += 1) {
    const b = bands[i];
    const d = x < b.start ? b.start - x : x > b.end ? x - b.end : 0;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

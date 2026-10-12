/**
 * 划词选取引擎（接管型）—— **不再使用浏览器的原生选区**。
 *
 * ## 为什么要重写成"接管型"
 *
 * 这个产品的选取前后修了 7~8 轮，全部翻在同一件事上：**同时存在两个"选区"**。
 *   · 浏览器的原生选区：按 **DOM 顺序** 扩展（中文期刊的内容流顺序 ≠ 版面顺序）；
 *   · 字符模型：按几何算，知道每个字在哪一栏、哪一行。
 * 只要两者不一致，"在浏览器选区上做纠正"就必然出错，而且每次重来的路径还不一样
 * （pdf.js 重建文本层、浏览器重排 DOM、锚点失效）。实测过的最坏结果：在栏 1 里竖着拖，
 * 写回去的选区落到**页眉**上、高亮横跨整页。
 *
 * 所以这里把浏览器从"选取"里彻底踢出去（Zotero 的做法）：
 *   1. 文本层设 `user-select: none` —— 浏览器不再产生任何选区；
 *   2. **拖动 = 指针位置**：按下点的字 = 锚点，指针当前的字 = 焦点，**每帧重新算两端**；
 *      （因此不存在"扩展"，也就不存在"中间被吃掉一整块"）
 *   3. **不许跨栏是几何约束**：焦点只允许取锚点那一栏里的字 —— 跨栏在结构上不可能；
 *   4. **高亮自己画**：按行合并，每行一条矩形 —— 天然连续，不存在"逐字拼接/跳块"；
 *   5. 复制由自己写剪贴板。
 *
 * 本文件**只做引擎**（不碰 React、不碰 pdf.js）：给定页面元素 + 每页模型 + overlay 容器，
 * 就能跑。这样它可以先在隔离页里用真实鼠标验收，通过之后再接进产品。
 */

import type { PageCharModel, TextPosition, ZoteroChar } from './selectionTypes';

/** 一个矩形（页面坐标系，CSS 像素，相对页面元素左上角） */
export type EngineRect = [number, number, number, number];

/** 一次可用的选区（都是"模型坐标"） */
export interface EngineSelection {
  pageIndex: number;
  /** 起点（含）与终点（不含）的字符序号 */
  start: number;
  end: number;
  /** 选中的文字（按字符顺序拼，行末补空格） */
  text: string;
  /** 每行一条矩形（页面坐标）：行内取"首字左边界 → 末字右边界" */
  rects: EngineRect[];
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
  /** 高亮层容器（**固定在视口上**，引擎给的矩形是客户端坐标，直接摆进去即可） */
  overlay: () => HTMLElement | null;
  /** 选区变化时通知外部（工具条定位、上报批注等） */
  onSelection: (selection: EngineSelection | null) => void;
  /** 命中容差（CSS 像素）：指针离字多远还算"点在字上"。默认 14 */
  hitTolerance?: number;
  debug?: boolean;
}

export interface SelectionEngine {
  /** 拖动开始（在容器上按下）：用按下点定锚点；extend = Shift+点击（锚点不动、只挪焦点） */
  begin(clientX: number, clientY: number, extend?: boolean): boolean;
  /** 拖动中：用指针当前位置定焦点（每帧调用，无节流也无副作用） */
  move(clientX: number, clientY: number): void;
  /** 松手：收尾（保留选区） */
  end(): void;
  /** 清空选区与高亮 */
  clear(): void;
  /** 当前选区 */
  current(): EngineSelection | null;
  /** 页面模型变了（重建文本层/缩放）时调用 */
  refresh(): void;
  /** 销毁：摘掉高亮、移除监听 */
  destroy(): void;
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * 分组结果按"模型对象"缓存。拖动时每帧都要用，重算 2000+ 字的排序太浪费；
 * 模型对象在文本层重建/缩放时会换新，所以用 WeakMap 自动失效。
 */
const groupCache = new WeakMap<PageCharModel, Map<string, number[]>>();
function groupsFor(model: PageCharModel): Map<string, number[]> {
  const hit = groupCache.get(model);
  if (hit) return hit;
  const built = flowGroupsOf(model);
  groupCache.set(model, built);
  return built;
}

/** 某个字符落在哪个组（先查缓存好的分组，找不到再按"整页一组"兜底） */
function groupKeyOfChar(model: PageCharModel, charIndex: number): string {
  const groups = groupsFor(model);
  for (const [key, list] of groups) {
    if (list.includes(charIndex)) return key;
  }
  return '__all__';
}

/** 一个字符在"页面坐标系"里的中心点 */
function centerOf(c: ZoteroChar): { x: number; y: number } {
  return { x: (c.rect[0] + c.rect[2]) / 2, y: (c.rect[1] + c.rect[3]) / 2 };
}

/**
 * 把一页的字符**按"栏流"分组，组内按视觉顺序（行 top → 行内 x）排序**。
 *
 * 为什么必须有这一步（真机实测出来的）：
 * 字符模型是按 **DOM/内容流顺序**建的，而中文期刊的 PDF 内容流常常**左右栏交替**
 * （这一篇实测：页眉之后先写左栏几行 → 跳右栏 → 再回左栏）。于是"数组里相邻的两个字"
 * 在版面上可能隔着半页：
 *   · 按数组顺序"逐字走" → 走着走着就跳到另一栏/另一行去了（真机：在栏 1 竖着拖，选中的却是页眉）；
 *   · 按数组顺序"取范围" → 范围在版面上是跳的（真机：842 字的选区横跨整页）。
 *
 * 分组键就是 flowClass（栏带），组内按 inlineRect 的行 top、再按 x 排序 ——
 * **这是几何顺序，与数组顺序无关**，所以内容流怎么交错都不影响。
 * 找不到 flowClass 的字符（旧数据/单栏页）全部归到一组，行为退化成"按数组顺序"。
 */
function flowGroupsOf(model: PageCharModel): Map<string, number[]> {
  const chars = model.chars;
  const groups = new Map<string, number[]>();
  if (!chars.length) return groups;

  const lineTop = (k: number): number => {
    const c = chars[k];
    const r = c?.inlineRect ?? c?.rect;
    return r ? Math.round(r[1]) : 0;
  };
  const leftOf = (k: number): number => chars[k]?.rect[0] ?? 0;
  const rightOf = (k: number): number => chars[k]?.rect[2] ?? 0;
  const cx = (k: number): number => chars[k]?.rect[0] ?? 0;

  /**
   * # 分组 = **直接用模型里的 flowClass（栏带）**
   *
   * ## 为什么绕了一圈又回到这里（这段是试错记录，别再重复）
   *
   * 我一度不信 flowClass，自己造了三版分栏判据，**每一版都在真机上翻车**：
   *   ① "行左边界聚类，间隙 40px" → 中文排版每行左边界都不同，一栏被拆成 4~5 簇，
   *      选区塌成 0~1 个字；
   *   ② "行中心最大间隙 >= 页宽 30%" → 这一篇实测最大中心间隙只有 48px，判不出分栏，
   *      跨栏照旧；
   *   ③ "左边界聚类 或 中心间隙" → 跨栏标题行（横跨两栏）把"最大中心间隙"顶成 178px，
   *      分栏线跑到了左栏中间 → 一栏被劈开。
   *
   * 而 flowClass 是**建模型时按栏带算好的**（columnBands 那套，pdf.js 的官方口径），
   * 我兜了一圈才想起来该用它。教训：模型里已有的东西先用，别自造。
   *
   * ## 唯一需要的加工：把"通栏行"摘出去
   *
   * 页眉/页脚/跨栏标题的 flowClass 可能和正文某一栏相同（同一个栏带），
   * 它们的宽度接近整页，参与拖动就会让高亮横穿整页。所以：
   * **凡是横跨页面 >= 80% 的字，归到 `__full__` 并清空** —— 点它不产生选区，
   * 拖到它也不会把它的字带进选区。
   */
  for (let k = 0; k < chars.length; k += 1) {
    const key = chars[k]?.flowClass ?? '__all__';
    const list = groups.get(key);
    if (list) list.push(k);
    else groups.set(key, [k]);
  }

  // 每一组的水平范围（用来判"通栏"）
  const pageLeft = Math.min(...chars.map((_, k) => leftOf(k)));
  const pageRight = Math.max(...chars.map((_, k) => rightOf(k)));
  const pageWidth = Math.max(1, pageRight - pageLeft);

  const full: number[] = [];
  for (const [key, list] of [...groups]) {
    const left = Math.min(...list.map(leftOf));
    const right = Math.max(...list.map(rightOf));
    if ((right - left) / pageWidth >= 0.8) {
      full.push(...list);
      groups.delete(key);
    }
  }
  if (full.length) groups.set('__full__', []);

  // 组内按（行 top → 行内 x）排序 = 视觉顺序
  for (const list of groups.values()) {
    list.sort((a, b) => lineTop(a) - lineTop(b) || cx(a) - cx(b));
  }

  if (typeof window !== 'undefined') {
    (window as unknown as { __litshelfGroupDiag?: unknown }).__litshelfGroupDiag = [...groups.entries()].map(([k, v]) => [k, v.length]);
  }
  return groups;
}

/** 点到矩形的距离（在矩形内为 0） */
function distToRect(x: number, y: number, r: readonly [number, number, number, number]): number {
  const dx = x < r[0] ? r[0] - x : x > r[2] ? x - r[2] : 0;
  const dy = y < r[1] ? r[1] - y : y > r[3] ? y - r[3] : 0;
  return dx === 0 && dy === 0 ? 0 : Math.hypot(dx, dy);
}

/**
 * 指针 → 字符序号。
 *
 * 判据：**优先"行内最近"**（先按 y 找最近的行，再在行内按 x 找最近的字）。
 * 这样指针落在行间空隙时，会吸附到**最近那一行**，而不是跳到页面上别的行去
 * —— 老实现靠 `caretRangeFromPoint` + 容器兜底，指针一进空隙就解析成"容器开头"，
 * 于是"从页首选起"（用户报的诡异现象）。
 */
function charIndexAt(model: PageCharModel, x: number, y: number, tol: number): number {
  const chars = model.chars;
  if (!chars.length) return -1;

  /**
   * 行内评分：**0 = 指针横跨在这个字上**；否则按离字中心的距离排。
   * ⚠️ 这一条是真机实测出来的：老实现"同行内只比 y 距离"，并列时谁先扫到算谁，
   * 于是**整行都被算给行首那个字**。真实使用中"指针略高于字行"（点在行的上边缘外面）
   * 是常态，后果是：在栏 2 按下、拖到栏 1，两端都解析成行首那个字，选区塌成 1 个字。
   */
  const scoreInLine = (c: ZoteroChar): number => {
    if (x >= c.rect[0] && x <= c.rect[2]) return 0;
    return 1 + Math.abs(x - (c.rect[0] + c.rect[2]) / 2) / 1000;
  };

  /** 指针到这一行的纵向距离（0 = 就在行内） */
  const lineDy = (c: ZoteroChar): number => {
    const line = c.inlineRect ?? c.rect;
    if (y < line[1]) return line[1] - y;
    if (y > line[3]) return y - line[3];
    return 0;
  };

  /** 指针是否在"这个字的行带"里（上下都算在行内）——这是最高优先级的判据 */
  const lineContains = (c: ZoteroChar): boolean => {
    const line = c.inlineRect ?? c.rect;
    return y >= line[1] && y <= line[3];
  };

  let best = -1;
  let bestKey = Number.POSITIVE_INFINITY;
  for (let k = 0; k < chars.length; k += 1) {
    const c = chars[k];
    if (lineDy(c) > tol) continue;
    /**
     * 排序键（越小越优先）：
     *   0.x —— 指针**在这个字的行带里**且横跨这个字（最理想：点到哪就是哪）
     *   1.x —— 在行带里、但 x 在字缝上（按离字中心排）
     *   2 + dy/1000 —— 不在任何行带里（点在行间空隙），按离行的垂直距离排
     * ⚠️ 老实现把"行带包含"和"行间空隙"混在一个 y 距离里比，导致指针落在
     * 页眉与正文的空隙时被算给页眉（真机实测：反向拖的锚点跑到页眉上）。
     */
    const key = lineContains(c) ? scoreInLine(c) : 2 + lineDy(c) / 1000;
    if (key < bestKey - 1e-9) {
      bestKey = key;
      best = k;
    }
  }
  if (best >= 0) {
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __litshelfHitSample?: unknown[] };
      const top = [...chars.keys()]
        .map((k) => {
          const c = chars[k];
          const key = lineContains(c) ? scoreInLine(c) : 2 + lineDy(c) / 1000;
          return { k, ch: c.c, key: Number(key.toFixed(4)), inLine: lineContains(c), dy: lineDy(c), x: Math.round(c.rect[0]), y: Math.round(c.rect[1]) };
        })
        .filter((o) => o.key < 3)
        .sort((a, b) => a.key - b.key)
        .slice(0, 5);
      (w.__litshelfHitSample ??= []).push({ x: Math.round(x), y: Math.round(y), best, bestChar: chars[best]?.c, top });
      if ((w.__litshelfHitSample as unknown[]).length > 6) (w.__litshelfHitSample as unknown[]).shift();
    }
    return best;
  }

  /**
   * 容差内一个都没有（指针落在行间/栏缝里）：取"**横向最近**"的字，
   * 纵向距离只用来做"重罚"（超出容差越多罚越重），不能主导排序。
   *
   * ⚠️ 老实现按 `hypot(dx, dy)` 取最近，真机实测出问题：指针在"页眉与正文之间的空隙"时，
   * 页眉最后一个字（横向差 8px、纵向差 23px）会赢过正文同一 x 的那个字（横向差 0、纵向差 20px），
   * 于是"在正文里按下"被算成"点在页眉"。
   */
  let near = -1;
  let nearKey = Number.POSITIVE_INFINITY;
  for (let k = 0; k < chars.length; k += 1) {
    const c = chars[k];
    const line = c.inlineRect ?? c.rect;
    const dx = x < line[0] ? line[0] - x : x > line[2] ? x - line[2] : 0;
    const dy = y < line[1] ? line[1] - y : y > line[3] ? y - line[3] : 0;
    const key = dx + dy * 8;
    if (key < nearKey) {
      nearKey = key;
      near = k;
    }
  }
  return nearKey <= Math.max(tol * 20, 400) ? near : -1;
}

/** 某栏里的字（用 flowClass 判栏；同栏 = 同一个 flowClass） */
function sameColumn(chars: readonly ZoteroChar[], flow: string | undefined | null, i: number): boolean {
  if (!flow) return true; // 没有栏信息（单栏页）→ 不限制
  return chars[i]?.flowClass === flow;
}

/**
 * 按行合并矩形：**每行一条**，从该行首字的左边界到末字的右边界。
 *
 * 为什么不能逐字拼（用户看到的"碎块/跳过一截再拼上"就是这个）：
 * 中文两端对齐的行内字间有 10~15px 正常间距，逐字给出的矩形天生长得不连续；
 * 而且同一个"视觉行"在版面上可能被栏缝切开，逐字拼就会在两截之间断开。
 * 这里先用 `inlineRect` 的 top 把字归到行，再按行取首末边界 —— 一行必然是一条连续横条。
 *
 * ⚠️ 输出是**客户端坐标**（加了页面的 `getBoundingClientRect()` 偏移）：
 * 高亮层固定在视口上，这样滚动/缩放时只要重画就行，不用每页各挂一层。
 */
function buildLineRects(
  chars: readonly ZoteroChar[],
  idx: readonly number[],
  origin: { left: number; top: number },
): EngineRect[] {
  const rows = new Map<number, { left: number; right: number; top: number; bottom: number }>();
  for (const i of idx) {
    const c = chars[i];
    if (!c || c.ignorable) continue;
    const line = c.inlineRect ?? c.rect;
    // 行的身份：用行矩形的 top 取整（同一行的字 top 相同）
    const key = Math.round(line[1]);
    const cur = rows.get(key);
    if (!cur) {
      rows.set(key, { left: c.rect[0], right: c.rect[2], top: line[1], bottom: line[3] });
      continue;
    }
    if (c.rect[0] < cur.left) cur.left = c.rect[0];
    if (c.rect[2] > cur.right) cur.right = c.rect[2];
    if (line[1] < cur.top) cur.top = line[1];
    if (line[3] > cur.bottom) cur.bottom = line[3];
  }
  return [...rows.values()]
    .sort((a, b) => a.top - b.top)
    .map((r) => [r.left + origin.left, r.top + origin.top, r.right + origin.left, r.bottom + origin.top] as EngineRect);
}

/** 选中的文字：按字符顺序拼，行末补空格（与 `getTextFromChars` 同口径） */
function textOf(chars: readonly ZoteroChar[], idx: readonly number[]): string {
  const out: string[] = [];
  for (const i of idx) {
    const c = chars[i];
    if (!c || c.ignorable) continue;
    out.push(c.c);
    if (c.spaceAfter) out.push(' ');
  }
  return out.join('').trim();
}

export function createSelectionEngine(deps: EngineDeps): SelectionEngine {
  const tol = num(deps.hitTolerance, 14);
  const log = (...args: unknown[]): void => {
    if (deps.debug) console.debug('[sel-engine]', ...args);
  };

  let anchor: { pageIndex: number; offset: number; flow: string | null } | null = null;
  let head: { pageIndex: number; offset: number } | null = null;
  /** 诊断用：锚点/焦点的指针坐标，以及 move 的每一步（自动化验收排错用） */
  let anchorXY: { x: number; y: number } | null = null;
  let headXY: { x: number; y: number } | null = null;
  const moveSteps: unknown[] = [];
  let selection: EngineSelection | null = null;
  let overlayHost: HTMLElement | null = null;
  const highlights: HTMLElement[] = [];

  /** 客户端坐标 → 命中的页面与"页面坐标系"的点 */
  const hit = (clientX: number, clientY: number): { page: PageHandle; x: number; y: number; offset: number } | null => {
    const all = deps.pages();
    publishPages(all.length);
    if (typeof window !== 'undefined' && all[0]) {
      const g = groupsFor(all[0].model);
      (window as unknown as { __litshelfGroupDiag?: unknown }).__litshelfGroupDiag = [...g.entries()].map(([k, v]) => [k, v.length]);
    }
    for (const page of all) {
      const rect = page.pageEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (clientX < rect.left - tol || clientX > rect.right + tol || clientY < rect.top - tol || clientY > rect.bottom + tol) continue;
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const offset = charIndexAt(page.model, x, y, tol);
      if (offset < 0) continue;
      return { page, x, y, offset };
    }
    return null;
  };

  /**
   * 焦点约束：**沿拖动方向逐字前进，一旦走出锚点所在栏就停下**。
   *
   * ## 为什么不能用"全局找最近"（隔离页实测出来的）
   *
   * 我第一版写的是"焦点越栏时，在锚点栏里找**离指针最近**的字"。结果：在左栏竖着拖 5 行，
   * 选区右端跑到了 843（右栏起点 516）—— 跨栏了，而且是**往下跳了 8 行**：因为"离指针最近的
   * 左栏字"可能在第 10 行，而不是指针所在的第 2 行。
   *
   * 正确做法是**方向性**的，与人手拖动一致：
   *   · 从锚点出发，沿拖动方向**逐字前进**，每一步都还在锚点那一栏 → 继续；
   *   · 第一步就出栏（或走到头）→ 停在上一个仍在栏内的字。
   * 这样：不跨栏（几何保证）、不跳行（逐字走）、不碎片（连续区间）。
   */
  const constrain = (page: PageHandle, anchorOffset: number, anchorFlow: string | null, offset: number): number => {
    if (!anchorFlow) return offset; // 单栏页：不限制
    const chars = page.model.chars;
    const groups = groupsFor(page.model);
    const group = groups.get(anchorFlow);
    if (!group || !group.length) return offset;
    /**
     * 锚点这一组里"离某个字符**在版面上**最近"的组内位置。
     *
     * ⚠️ 必须用**几何距离**，不能用"字符序号差"（我第一版就是那么写的，真机实测出问题）：
     * 真实页面的字符序号是**内容流顺序**（左右栏交替），所以"序号差最小"经常是**另一行/另一栏**
     * 的字。后果是"反向拖"时 `constrain` 把焦点夹到了很远的字上，选区塌成 1 个字。
     * 用矩形距离（同在行内时退化成"横向最近"）才与人的直觉一致。
     */
    const nearestPos = (charIndex: number): number => {
      const ref = chars[charIndex];
      if (!ref) return 0;
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let k = 0; k < group.length; k += 1) {
        const c = chars[group[k]];
        if (!c) continue;
        const d = distToRect(c.rect[0], c.rect[1], ref.rect);
        if (d < bestD - 0.5) {
          bestD = d;
          best = k;
          continue;
        }
        // 同一行内（距离同为 0）：取横向最近的那个，保证"拖到哪就是哪"
        if (Math.abs(d - bestD) <= 0.5) {
          const cur = chars[group[best]];
          const curDx = cur ? Math.abs((cur.rect[0] + cur.rect[2]) / 2 - (ref.rect[0] + ref.rect[2]) / 2) : Number.POSITIVE_INFINITY;
          const newDx = Math.abs((c.rect[0] + c.rect[2]) / 2 - (ref.rect[0] + ref.rect[2]) / 2);
          if (newDx < curDx - 0.5) best = k;
        }
      }
      return best;
    };
    const anchorPos = nearestPos(anchorOffset);
    const pointPos = nearestPos(offset);
    const step = pointPos >= anchorPos ? 1 : -1;
    // 从锚点沿拖动方向走到底：**组边界就是栏边界**，出不去
    const limitPos = step > 0 ? group.length - 1 : 0;
    const finalPos = step > 0 ? Math.min(pointPos, limitPos) : Math.max(pointPos, limitPos);
    const result = group[finalPos] ?? anchorOffset;
    void chars;
    return result;
  };

  const paint = (): void => {
    const host = deps.overlay() ?? overlayHost;
    if (!host) return;
    for (const el of highlights) el.remove();
    highlights.length = 0;
    if (!selection) return;
    const page = deps.pages().find((p) => p.pageIndex === selection?.pageIndex);
    if (!page) return;
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

  const rebuild = (): void => {
    if (!anchor || !head) {
      selection = null;
      paint();
      publish(null);
      deps.onSelection(null);
      return;
    }
    const page = deps.pages().find((p) => p.pageIndex === anchor?.pageIndex);
    if (!page) {
      selection = null;
      paint();
      publish(null);
      deps.onSelection(null);
      return;
    }
    /**
     * **选区的边界一律走"栏流组"，不走数组下标。**
     *
     * `flowGroupsOf` 把一页的字符按栏分组、组内按视觉顺序排好；这里就只认这些组：
     *   · 没有 flowClass（单栏页 / 旧数据）→ 组键 `__all__`，"按数组顺序"退化成老行为；
     *   · 有 flowClass → 只用锚点那一组的顺序，**别的栏的字根本进不来**（跨栏不可能）；
     *   · 焦点与锚点不同组（拖到别的栏了）→ 用 `constrain()` 已经夹过；这里再兜一次底：
     *     焦点不在锚点组里就直接忽略它，选择退化成"锚点一个字"。
     * 这样"模型顺序 ≠ 版面顺序"就再也影响不到结果 —— 这是这轮最关键的改动。
     */
    const groups = groupsFor(page.model);
    const groupKey = anchor.flow ?? '__all__';
    const group = groups.get(groupKey) ?? [];
    const posOf = new Map<number, number>();
    group.forEach((charIndex, k) => posOf.set(charIndex, k));
    const anchorPos = posOf.get(anchor.offset) ?? 0;
    const headPos = posOf.get(head.offset);
    if (typeof window !== 'undefined') {
      (window as unknown as { __litshelfEngineDiag?: unknown }).__litshelfEngineDiag = {
        anchorXY: anchorXY,
        headXY: headXY,
        moveSteps: moveSteps.slice(-6),
        anchorOffset: anchor.offset,
        headOffset: head.offset,
        anchorFlow: anchor.flow,
        headFlow: page.model.chars[head.offset]?.flowClass ?? null,
        groupKey,
        groupLen: group.length,
        anchorPos,
        headPos: headPos ?? null,
        anchorChar: page.model.chars[anchor.offset]?.c ?? null,
        headChar: page.model.chars[head.offset]?.c ?? null,
      };
    }
    const to = headPos === undefined ? anchorPos : headPos;
    const lo = Math.min(anchorPos, to);
    const hi = Math.max(anchorPos, to);
    const idx = group.slice(lo, hi + 1);
    if (!idx.length) {
      selection = null;
      paint();
      publish(null);
      deps.onSelection(null);
      return;
    }
    selection = {
      pageIndex: page.pageIndex,
      start: idx[0],
      end: idx[idx.length - 1] + 1,
      text: textOf(page.model.chars, idx),
      rects: buildLineRects(page.model.chars, idx, page.pageEl.getBoundingClientRect()),
    };
    paint();
    publish(selection);
    deps.onSelection(selection);
  };

  /** 把最后一次选区挂到 window 上：自动化验收（真实鼠标 + 截图）要读它，正常使用无副作用 */
  const publish = (sel: EngineSelection | null): void => {
    if (typeof window === 'undefined') return;
    (window as unknown as { __litshelfEngineSel?: EngineSelection | null }).__litshelfEngineSel = sel;
  };

  /** 诊断：引擎这次看到几页（自动化验收用；正常使用只是一次数组长度读取） */
  const publishPages = (n: number): void => {
    if (typeof window === 'undefined') return;
    (window as unknown as { __litshelfEnginePages?: number }).__litshelfEnginePages = n;
  };

  const engine: SelectionEngine = {
    begin(clientX, clientY, extend = false) {
      const h = hit(clientX, clientY);
      if (!h) {
        if (!extend) engine.clear();
        return false;
      }
      // 锚点属于哪个「栏流组」（几何分组，比模型里的 flowClass 可靠：页眉和正文首行可能被分成同一个 flowClass）
      const flow = groupKeyOfChar(h.page.model, h.offset);
      if (extend && anchor) {
        // Shift+点击：锚点不动，只把焦点挪过去（同样受"不许跨栏"约束）
        const page = deps.pages().find((p) => p.pageIndex === anchor?.pageIndex) ?? h.page;
        const offset =
          anchor.flow && h.page.pageIndex === page.pageIndex
            ? constrain(page, anchor.offset, anchor.flow, h.offset)
            : h.offset;
        head = { pageIndex: page.pageIndex, offset };
      } else {
        anchor = { pageIndex: h.page.pageIndex, offset: h.offset, flow };
        head = { pageIndex: h.page.pageIndex, offset: h.offset };
        anchorXY = { x: clientX, y: clientY };
        headXY = { x: clientX, y: clientY };
      }
      rebuild();
      return true;
    },
    move(clientX, clientY) {
      if (!anchor) return;
      const h = hit(clientX, clientY);
      if (!h) return;
      const page = deps.pages().find((p) => p.pageIndex === anchor?.pageIndex);
      if (!page) return;
      const rawOffset = h.page.pageIndex === page.pageIndex ? h.offset : anchor.offset;
      const offset = constrain(page, anchor.offset, anchor.flow, rawOffset);
      head = { pageIndex: page.pageIndex, offset };
      headXY = { x: clientX, y: clientY };
      moveSteps.push({ x: clientX, y: clientY, hit: h.offset, page: h.page.pageIndex, offset });
      rebuild();
    },
    end() {
      log('拖动结束', selection ? { chars: selection.text.length, lines: selection.rects.length } : null);
    },
    clear() {
      anchor = null;
      head = null;
      selection = null;
      paint();
      publish(null);
      deps.onSelection(null);
    },
    current: () => selection,
    refresh() {
      overlayHost = deps.overlay();
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
  return engine;
}

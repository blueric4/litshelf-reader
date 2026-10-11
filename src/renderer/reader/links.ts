/**
 * PDF 链接注释（`subtype === 'Link'`）→ 页内归一化热区 + 跳转目标。
 *
 * 为什么单独成模块：
 * pdf.js 给的链接矩形在 **PDF 用户空间**（原点在左下角，y 轴向上，还可能带页面旋转），
 * 而渲染层画热区用的是 **屏幕坐标**（原点左上角，y 轴向下，盒子随缩放变化）。
 * 两边自己换算特别容易差一个 y 翻转或漏掉 rotation，于是统一在这里归一化成 0–1 的比例矩形：
 * 渲染层只要 `left: x*100%; top: y*100%; width: w*100%; height: h*100%`，
 * 缩放（scale）和旋转（rotation）都不用再管。
 *
 * 三条硬约定（改代码前先读）：
 * 1. 坐标转换只信 `viewport.convertToViewportRectangle()`（它已经处理 y 翻转 + rotation），
 *    **绝不要手算 `pageHeight - y`**；传进来的 viewport 必须和画布同一 rotation、不带 offset、
 *    没有 `dontFlip`（scale 随便，归一化时会约掉）。
 * 2. 归一化后的 y **向下**，与屏幕/CSS 一致；`page` 一律 **1 基**（与 `Annotation.page` 一致，
 *    pdf.js 的 `getPageIndex` 是 0 基，已在 `resolveInternalPage` 内部 +1）。
 * 3. 任何坏注释/坏 dest 都吞掉：一页可能有几十个链接（目录页尤其多），
 *    其中一条坏的不能拖垮整页的热区，更不能把异常抛进 React 渲染流程。
 *
 * 用法（接线示例见 task 报告）：
 *   1) 画热区：`const links = await loadPageLinks(doc, pageNumber, viewport)`
 *      —— 页码 1 基，viewport 必须和画布同一 rotation/scale；
 *   2) 点击：外链直接开 `link.url`；内部跳转再 `await resolveInternalPage(doc, link.dest)`
 *      拿到 1 基页码（点击时才解析，避免一页几十个链接逐条 await）。
 */
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';

/** 页内热区：0–1 比例，相对页面左上角，y 轴向下（与 CSS 一致） */
export interface LinkRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一条链接：热区 + 目标（外链给 url，内部跳转给原始 dest） */
export interface PageLink {
  /** 可能多条（QuadPoints 拆出的多块）；为空表示这条注释没有可用热区 */
  rects: LinkRect[];
  /** 外链地址（注释的 /A /URI）；内部跳转没有这个字段 */
  url?: string;
  /** pdf.js 原始跳转目标（数组或命名字符串），交给 resolveInternalPage 解析 */
  dest?: unknown;
}

/** 内部跳转目标 */
export interface LinkTarget {
  /** 目标页码，**1 基** */
  page: number;
  /** 目标 x：**PDF 用户空间**坐标（y 轴向上）；需要屏幕坐标时用 viewport.convertToViewportPoint(x, y) */
  x?: number;
  /** 目标 y：同上，PDF 用户空间 */
  y?: number;
}

/**
 * normalizeLinkRects 需要的最小 viewport 能力。
 * 真实 `PageViewport` 结构上直接满足，接线时无需转换。
 */
export interface LinkViewport {
  width: number;
  height: number;
  convertToViewportRectangle(rect: number[]): number[];
}

/** pdf.js 链接注释里我们用到的字段；全部按 unknown 收，坏值一律吞掉 */
export interface LinkAnnotationLike {
  subtype?: unknown;
  rect?: unknown;
  quadPoints?: unknown;
  url?: unknown;
  /** pdf.js 的原始 URL（未消毒）——**故意不用**，只认上面的 url */
  unsafeUrl?: unknown;
  dest?: unknown;
}

/** loadPageLinks 需要的最小页面能力（真实 `PDFPageProxy` 直接满足） */
export interface LinkPage {
  getAnnotations(params?: { intent?: string }): Promise<unknown[]>;
}

/** resolveInternalPage 需要的最小文档能力（真实 `PDFDocumentProxy` 直接满足） */
export interface LinkDestResolver {
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
  getDestination(name: string): Promise<unknown[] | null>;
  /** 可选：给定时用它拦越界页码（真实 PDFDocumentProxy 有这个字段） */
  numPages?: number;
}

/** loadPageLinks 需要的最小文档能力（真实 `PDFDocumentProxy` 直接满足） */
export interface LinkDocument extends LinkDestResolver {
  getPage(pageNumber: number): Promise<LinkPage>;
}

// 类型自检：接线时真实 pdf.js 对象必须能原样传进来。下面任一为假都会编译不过。
type Assert<T extends true> = T;
type _DocIsLinkDocument = Assert<PDFDocumentProxy extends LinkDocument ? true : false>;
type _PageIsLinkPage = Assert<PDFPageProxy extends LinkPage ? true : false>;
type _ViewportIsLinkViewport = Assert<PageViewport extends LinkViewport ? true : false>;

/** 归一化后边长小于这个值的热区直接丢弃（点不到的退化链接，常见于扫描件） */
const MIN_SIDE = 1e-4;

/** 命名目标嵌套数组的递归上限，防 `getDestination('a') → ['a']` 这类自引用死循环 */
const MAX_DEST_DEPTH = 4;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * 取前 len 个**真数字**；长度不足、类型不对、含 NaN/Infinity 一律返回 null。
 * 故意不做 `Number(value)` 强转：null → 0、'12' → 12 这种"猜"会把坏注释变成一个假热区。
 */
function toNumbers(value: unknown, len: number): number[] | null {
  if (!Array.isArray(value) || value.length < len) return null;
  const out: number[] = [];
  for (let i = 0; i < len; i += 1) {
    const n = value[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

/** 注释的 PDF 用户空间矩形：优先 /Rect，缺失/坏掉时才退回 /QuadPoints 的包围盒 */
function annotUserRects(annot: LinkAnnotationLike): number[][] {
  const rect = toNumbers(annot.rect, 4);
  if (rect) return [rect];
  const quads = annot.quadPoints;
  if (!Array.isArray(quads)) return [];
  const out: number[][] = [];
  // QuadPoints 是 4 个点 x,y 依次排列，每 8 个数一个四边形
  for (let i = 0; i + 8 <= quads.length; i += 8) {
    const q = toNumbers(quads.slice(i, i + 8), 8);
    if (!q) continue;
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return out;
}

/**
 * 把一条 pdf.js 链接注释转成归一化热区（**纯函数**，不碰 pdf.js 内部状态）。
 *
 * - 坐标一律走 `pageViewport.convertToViewportRectangle(rect)`，得到屏幕方向（y 向下）的像素盒，
 *   再除以 viewport 宽高做归一化；完全在页外的矩形被丢弃，部分超出的裁到 0–1。
 * - `url` / `dest` 原样透传（url 只收非空字符串，dest 只收非 null）。
 * - 任何坏输入（null、rect 不是 4 个有限数、viewport 宽高为 0、转换抛错）都返回 `{ rects: [] }`，不抛。
 *
 * @param annot `page.getAnnotations()` 的元素
 * @param pageViewport 与画布同一 rotation/scale 的 viewport（不带 offset）
 */
export function normalizeLinkRects(
  annot: LinkAnnotationLike | null | undefined,
  pageViewport: LinkViewport | null | undefined,
): PageLink {
  const link: PageLink = { rects: [] };
  try {
    if (!annot || typeof annot !== 'object') return link;
    // 只认 pdf.js 消毒过的 `url`（绝对化 + 协议白名单）；`unsafeUrl` 是原始串，可能带
    // `javascript:` 之类，渲染层拿到就会去开，所以这里**故意不取**。
    if (typeof annot.url === 'string' && annot.url) link.url = annot.url;
    if (annot.dest !== undefined && annot.dest !== null) link.dest = annot.dest;

    const rects = annotUserRects(annot);
    if (!rects.length) return link;
    if (!pageViewport || typeof pageViewport.convertToViewportRectangle !== 'function') return link;
    const vw = Number(pageViewport.width);
    const vh = Number(pageViewport.height);
    if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) return link;

    const out: LinkRect[] = [];
    for (const rect of rects) {
      let box: unknown;
      try {
        box = pageViewport.convertToViewportRectangle(rect);
      } catch {
        continue; // 单条转换失败：跳这条，不影响同一注释的其它矩形
      }
      const nums = toNumbers(box, 4);
      if (!nums) continue;
      // 转换结果已含 y 翻转与 rotation，这里只做 min/max 归位 → 归一化 → 裁页内
      const x1 = clamp01(Math.min(nums[0], nums[2]) / vw);
      const x2 = clamp01(Math.max(nums[0], nums[2]) / vw);
      const y1 = clamp01(Math.min(nums[1], nums[3]) / vh);
      const y2 = clamp01(Math.max(nums[1], nums[3]) / vh);
      const w = x2 - x1;
      const h = y2 - y1;
      if (w > MIN_SIDE && h > MIN_SIDE) out.push({ x: x1, y: y1, w, h });
    }
    link.rects = out;
  } catch {
    // 坏注释一律吞掉：目录页几十个链接里不能因为一条坏的整页没热区
  }
  return link;
}

/** 把 dest 规格化成 pdf.js 的 dest 数组：原样数组 / 命名字符串 → getDestination / {name} 包装 */
async function destArray(doc: LinkDestResolver, dest: unknown): Promise<unknown[] | null> {
  if (Array.isArray(dest)) return dest;
  const name =
    typeof dest === 'string'
      ? dest
      : dest && typeof dest === 'object' && typeof (dest as { name?: unknown }).name === 'string'
        ? ((dest as { name: string }).name)
        : '';
  if (!name || typeof doc.getDestination !== 'function') return null;
  const resolved = await doc.getDestination(name);
  return Array.isArray(resolved) ? resolved : null;
}

/** 从 dest 数组里取出 1 基页码；取不到（坏引用/越界）返回 null */
async function destPage(doc: LinkDestResolver, arr: unknown[], depth: number): Promise<number | null> {
  const ref = arr[0];
  // 少见但合法：dest 数组首位又是个命名目标，再解一层（递归有上限，防自引用死循环）
  if (typeof ref === 'string') {
    if (depth >= MAX_DEST_DEPTH) return null;
    const nested = await destArray(doc, ref);
    return nested ? destPage(doc, nested, depth + 1) : null;
  }

  let index: number | null = null;
  if (ref && typeof ref === 'object' && Number.isInteger((ref as { num?: unknown }).num)) {
    // 对象引用 {num, gen}：唯一可靠的做法是问文档要 0 基页下标
    const num = (ref as { num: number }).num;
    const genRaw = (ref as { gen?: unknown }).gen;
    const gen = typeof genRaw === 'number' && Number.isFinite(genRaw) ? genRaw : 0;
    const resolved = await doc.getPageIndex({ num, gen });
    if (typeof resolved === 'number' && Number.isInteger(resolved) && resolved >= 0) index = resolved;
  } else if (typeof ref === 'number' && Number.isInteger(ref) && ref >= 0) {
    // 首元素直接是整数页码：pdf.js 自己也是这么认的（`pdf_viewer.mjs` 的 goToDestination：
    // `Number.isInteger(destRef)` → `pageNumber = destRef + 1`），所以这是合法写法，不是兜底
    index = ref;
  }
  if (index === null) return null;

  const page = index + 1; // getPageIndex 是 0 基，对外一律 1 基
  const total = doc.numPages;
  if (typeof total === 'number' && Number.isFinite(total) && total > 0 && page > total) return null;
  return page;
}

/** 取 dest 第 2 项的跳转模式名（可能是字典 {name:'XYZ'} 也可能是裸字符串） */
function destMode(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') {
    return (value as { name: string }).name;
  }
  return '';
}

/**
 * 按跳转模式取显式坐标（**PDF 用户空间**，y 轴向上）。
 * 各模式的参数位（PDF 32000-1 §12.3.2.2）：
 *   [ref /XYZ  left top zoom] / [ref /FitH  top] / [ref /FitV  left] / [ref /FitR  left bottom right top]
 * 值为 null 表示"保持当前视图"，当作没有。
 */
function destPoint(arr: unknown[]): { x?: number; y?: number } {
  const at = (i: number): number | undefined => {
    const v = arr[i];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  switch (destMode(arr[1])) {
    case 'XYZ':
      return { x: at(2), y: at(3) };
    case 'FitH':
    case 'FitBH':
      return { y: at(2) };
    case 'FitV':
    case 'FitBV':
      return { x: at(2) };
    case 'FitR':
      return { x: at(2), y: at(5) };
    default:
      return {}; // /Fit 等整页模式没有坐标
  }
}

/**
 * 解析内部跳转目标 → 1 基页码（+ 可选的 PDF 用户空间坐标）。
 *
 * - `dest` 可以是数组（`[{num,gen}, {name}, ...]`）或命名字符串（走 `doc.getDestination`），
 *   也兼容 `{name:'xxx'}` 包装与"数组首位是命名目标"的少数写法。
 * - 页面引用既支持 `{num,gen}`（走 `doc.getPageIndex`，**0 基 → +1**），
 *   也支持首元素直接是整数（0 基页码；pdf.js 的 goToDestination 同样这样认）。
 * - 任何异常/坏值/越界一律返回 `null`，**绝不抛**；调用方拿到 null 就当这条链接没有内部目标。
 *
 * @param doc 文档代理（`PDFDocumentProxy`；只用到 getPageIndex/getDestination）
 * @param dest 注释的 `dest` 字段原文
 */
export async function resolveInternalPage(
  doc: LinkDestResolver | null | undefined,
  dest: unknown,
): Promise<LinkTarget | null> {
  try {
    if (!doc || typeof doc !== 'object' || typeof doc.getPageIndex !== 'function') return null;
    const arr = await destArray(doc, dest);
    if (!arr || !arr.length) return null;
    const page = await destPage(doc, arr, 0);
    if (!page) return null;
    const target: LinkTarget = { page };
    const point = destPoint(arr);
    if (point.x !== undefined) target.x = point.x;
    if (point.y !== undefined) target.y = point.y;
    return target;
  } catch {
    return null;
  }
}

/** 只有 `subtype === 'Link'` 才是链接注释（Highlight/Widget 等一律跳过） */
function isLinkAnnotation(annot: unknown): annot is LinkAnnotationLike {
  return !!annot && typeof annot === 'object' && (annot as { subtype?: unknown }).subtype === 'Link';
}

/**
 * 读一页的所有链接 → 归一化热区列表（外链/内部跳转都在内）。
 *
 * - 只用 `page.getAnnotations({ intent: 'display' })`（`noHTML` 会把链接过滤掉，别用）。
 * - **故意不解析 dest**：目录页一页能有几十个链接，逐条 `await getPageIndex` 会拖慢翻页；
 *   渲染层先画热区，点击时再 `resolveInternalPage` 一次即可。
 * - **故意不调用 `page.cleanup()`**：页面代理由渲染层共用，cleanup 会释放它正在用的意图状态；
 *   `doc.getPage()` 本身有缓存，重复调用几乎无代价。
 * - 出错（取页失败 / 注释流坏 / viewport 缺失）一律返回 `[]`，绝不抛。
 *
 * @param doc 文档代理（`PDFDocumentProxy`）
 * @param pageNumber **1 基**页码（与 `doc.getPage()` 一致）
 * @param pageViewport 与画布同一 rotation/scale 的 viewport
 */
export async function loadPageLinks(
  doc: LinkDocument | null | undefined,
  pageNumber: number,
  pageViewport: LinkViewport | null | undefined,
): Promise<PageLink[]> {
  try {
    if (!doc || typeof doc.getPage !== 'function') return [];
    if (!Number.isFinite(pageNumber) || pageNumber < 1) return [];
    const page = await doc.getPage(pageNumber);
    if (!page || typeof page.getAnnotations !== 'function') return [];
    const raw = await page.getAnnotations({ intent: 'display' });
    if (!Array.isArray(raw)) return [];

    const out: PageLink[] = [];
    for (const annot of raw) {
      try {
        if (!isLinkAnnotation(annot)) continue;
        const link = normalizeLinkRects(annot, pageViewport);
        if (!link.rects.length) continue; // 没有可用热区（页外/退化/坏 rect）
        if (!link.url && link.dest === undefined) continue; // 既没外链也没内部目标，点了也没用
        out.push(link);
      } catch {
        // 单条坏注释跳过，其余照常返回
      }
    }
    return out;
  } catch {
    return []; // 这页就当没有链接，不影响页面渲染
  }
}

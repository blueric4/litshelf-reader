/**
 * PDF 阅读器。
 *
 * 性能策略：连续滚动只渲染"可见页 ±2"，其余是等尺寸占位；页面自注册 IntersectionObserver
 * 上报可见性，父组件只维护一个 Set；canvas 内部尺寸 ×devicePixelRatio，CSS 尺寸不变。
 * 文本层用 pdf.js v5 的 TextLayer，因此文字可选中、也能被浏览器原生 Ctrl+F 命中。
 * 页面尺寸先分批预算完（占位高度与最终高度一致），这样滚动条长度不会跳。
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Annotation, AnnotationRect, AnnotationType, Item } from '@shared/types';
import { AnnotationLayer } from './AnnotationLayer';
import { PageContextMenu, type PageContextMenuItem } from './PageContextMenu';
import type { ReaderContextCommand } from './contextCommands';
import { clampZoom, type ReaderOutline } from './hooks';
import { buildAnchorFromNormalized, buildPageTextMap, normIndexFromNode, type PageTextMap } from './reanchor';
import type { TextLayerBuilder as TextLayerBuilderType } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { loadPageLinks, resolveInternalPage, type PageLink } from './links';
import { findHighlightStrips, hitCountOfStrips, type HighlightStrip } from './search';
import { bandIndexOf, columnBandsFromItems, nearestBandIndexOf } from './columnBands';
import { orderTextSpans } from './textOrder';

/**
 * pdf.js 文本层的样式契约（逐条对齐 pdfjs-dist/web/pdf_viewer.css，v5.7）。
 *
 * 关键：`--font-height` 由 pdf.js 写在每个 span 上（单位 px，PDF 用户单位下的字高），
 * 而 `--total-scale-factor` **必须由宿主自己设置**（pdf.js 的 viewer 会设，我们自研
 * 阅读器就得自己设）——它的语义是"1 个 PDF 单位等于多少 CSS 像素"，也就是当前缩放倍数。
 * 少了它 font-size 的 calc 会整体失效，span 退化成继承字号（界面 14px），
 * 文本层与画布上的字形尺寸对不上，鼠标划词就会点到别的 span、莫名选中一大段。
 */
/**
 * 位图像素上限：高倍缩放下（例如 400% 时一页宽 2400+ 像素）重绘一次要好几秒，
 * 超过上限就按上限渲染、再由 CSS 拉伸——略微软一点，但缩放立刻跟手。
 */
const MAX_CANVAS_PX = 1600;

/**
 * 是否仍启用手写的选择纠正（容器边界改锚 + 跨页夹取 + 松手后 0.7 秒看护）。
 *
 * 实测结论（同一套 45 条划词验收，只切这个开关）：
 *   · 只靠官方 `.endOfContent` + selectionchange 修正 → **3 项红**：反向（右→左）拖进行间距
 *     覆盖 1536px 暴涨、反向 11 字 vs 正向 2 字不一致、Shift+点击终点偏一行（20px）；
 *   · 两套叠加 → 全绿（正向行间距还更准：从 31 字降到 15 字）。
 * 所以**两套都要**：上游那套负责"指针在文字外时别把选区按 DOM 顺序甩出去"，
 * 我们这套负责"边界落到容器时改锚到最近一行 + 只在变短时替换 + 松手后锁 0.7 秒"。
 */
/**
 * "选区不许跨栏"：**已开启**。
 * 栏带由 pdf.js 的文本项算出（`columnBands.ts`），已在 8 篇 CNKI 论文 111 页上验证：
 * 7 页多栏全对、104 页单栏无误切；DOM 投影版（会被竖排页眉桥接）已废弃。
 * 单栏页面 `bands.length < 2` 时直接跳过，不做任何夹取。
 */
const ENABLE_COLUMN_LOCK = true;
const USE_OUR_SELECTION_FIX = true;

/**
 * 官方 web 版 viewer（`pdf_viewer.mjs`）**假定全局存在 `pdfjsLib`**：它模块一开头就
 * `const { AbortException, TextLayer, ... } = globalThis.pdfjsLib`（该文件第 113 行）。
 * 我们走 ESM 打包、没有这个全局，静态 import 一加载就抛
 * "Cannot destructure property 'AbortException' of 'globalThis.pdfjsLib' as it is undefined"（实测）。
 * 所以这里**先挂全局、再动态 import**——动态 import 能保证赋值先于它的模块求值发生
 * （静态 import 会被提升到文件顶部，顺序不可控）。
 * 顺带好处：这块 ~160KB 的代码变成按需加载，不拖累应用首屏。
 */
let textLayerBuilderModule: Promise<typeof import('pdfjs-dist/web/pdf_viewer.mjs')> | null = null;

function loadTextLayerBuilder(): Promise<typeof import('pdfjs-dist/web/pdf_viewer.mjs')> {
  textLayerBuilderModule ??= (async () => {
    (globalThis as unknown as { pdfjsLib?: unknown }).pdfjsLib = pdfjsLib;
    return import('pdfjs-dist/web/pdf_viewer.mjs');
  })();
  return textLayerBuilderModule;
}

const TEXT_LAYER_CSS = `
.rd-pdf-text {
  color-scheme: only light;
  position: absolute;
  text-align: initial;
  inset: 0;
  overflow: clip;
  opacity: 1;
  line-height: 1;
  text-size-adjust: none;
  -webkit-text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  caret-color: CanvasText;
  /* 关键：禁止"拖选变成原生拖拽"。Chromium 在文本上拖选时会启动 drag-and-drop，
     而**拖拽期间根本不派发 mouseup**：于是选区收尾逻辑永远不执行，浏览器原生选区
     一路扩到后面几页（用户报的"鼠标移到空白就全选"），划词工具条也不会弹。
     实测事件轨迹：selectstart → dragstart → drag×N → dragend（全程没有 mouseup）。 */
  -webkit-user-drag: none;
  z-index: 0;
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor, 1) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
}
.rd-pdf-text :is(span, br) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}
.rd-pdf-text > :not(.markedContent),
.rd-pdf-text .markedContent span:not(.markedContent) {
  z-index: 1;
  --font-height: 0;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  --scale-x: 1;
  --rotate: 0deg;
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}
.rd-pdf-text .markedContent { display: contents; }
.rd-pdf-text span[role='img'] { user-select: none; cursor: default; }
.rd-pdf-text ::selection { background: rgba(0, 122, 255, 0.3); }
/* 官方 pdf.js viewer 的"拖到空白"机制：文本层末尾放一个 .endOfContent，
   平时贴在文字下方（inset:100% 0 0）、不可选中；一旦这一层进入 selecting 状态就铺满整层。
   它的作用是让"指针落在文字以外的空白处"有明确的可命中目标，浏览器就不会把选区
   按 DOM 顺序一路扩到别的页去。规则照抄 pdf_viewer.css，只把类名换成我们的。 */
.rd-pdf-text .endOfContent {
  display: block;
  position: absolute;
  inset: 100% 0 0;
  z-index: 0;
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
}
.rd-pdf-text.selecting .endOfContent { top: 0; }
`;

let textLayerStylesInjected = false;

function ensureTextLayerStyles(): void {
  if (textLayerStylesInjected || typeof document === 'undefined') return;
  textLayerStylesInjected = true;
  const style = document.createElement('style');
  style.id = 'rd-pdf-text-layer-styles';
  style.textContent = TEXT_LAYER_CSS;
  document.head.appendChild(style);
}

export interface PageSize {
  width: number;
  height: number;
  rotation: number;
}

export interface PdfSelectionPayload {
  text: string;
  rect: { left: number; top: number; right: number; bottom: number };
  pageEl: HTMLElement;
  page: number;
  rects: AnnotationRect[];
  anchor: { prefix: string; suffix: string; occurrence: number };
}

export interface PdfViewerProps {
  item: Item;
  doc: PDFDocumentProxy | null;
  sizes: PageSize[];
  sizesReady: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  containerSize: { width: number; height: number };
  outline: ReaderOutline;
  annotations: Annotation[];
  loading: boolean;
  loadProgress: number;
  /** 打开时恢复到的页码（1 起） */
  initialPage: number;
  /** 缩放/适应模式变更时回调（-1 = 循环切换适应模式，>0 = 百分比） */
  onZoom: (zoom: number) => void;
  onPageChange: (page: number) => void;
  onProgress: (data: { page: number; total: number; percent: number; scrollTop: number; zoom: number }) => void;
  onSelectAnnotation: (annotation: Annotation, rect: DOMRect | null) => void;
  onSelection: (selection: PdfSelectionPayload | null) => void;
  flashId: string | null;
  searchQuery: string;
  /** 点搜索命中后自增，触发高亮重算 */
  searchVersion: number;
  /** 当前命中在整篇里的序号（0 起） */
  searchActiveIndex: number;
  onSearchHitCounts?: (counts: Map<number, number>) => void;
  onPageMaps: (maps: Map<number, PageTextMap>) => void;
  /** 右键菜单命令：菜单只负责回调，具体执行在 ReaderView */
  onContextCommand?: (cmd: ReaderContextCommand, at: { x: number; y: number }) => void;
  /** 首屏画完 */
  onFirstPaint?: () => void;
  /** 交出跳页句柄（父级据此做页码跳转/批注定位） */
  onReady?: (handle: { goToPage: (page: number) => void }) => void;
  degradedWorker?: boolean;
  /**
   * 救命通道：某页反复挂不上文本层（pdf.js 的 worker 卡住）时，请求父级**重建文档**。
   * 只是重挂那一页没用——worker 已经卡住，重建文档/worker 才能真正恢复。
   */
  onReloadDoc?: () => void;
}

interface PdfPageProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  height: number;
  scale: number;
  dpr: number;
  className: string;
  annotations: Annotation[];
  onSelectAnnotation: (annotation: Annotation, rect: DOMRect | null) => void;
  flashId: string | null;
  onVisible: (page: number, visible: boolean) => void;
  onMap: (page: number, map: PageTextMap) => void;
  onDropMap: (page: number) => void;
  registerSearchLayer: (page: number, root: HTMLElement | null, container: HTMLElement | null) => void;
  strips: HighlightStrip[] | null;
  activeOffset: number;
  onFirstPaint?: () => void;
  /** 这一页 6 秒还没挂上文本层（疑似 pdf.js 卡住）→ 请求父级换 key 重挂 */
  onStuck?: (page: number) => void;
  /** 这一页的栏带（按页宽比例）算好了，上报给父级做"划词禁止跨栏" */
  onBands?: (page: number, bands: { start: number; end: number }[]) => void;
  /** 拖选结束后由父级读取选区；这里只上报"页面元素" */
  onPageElement: (page: number, el: HTMLElement | null) => void;
  /** 文内跳转（PDF 里的引用/目录链接）用：跳到指定页 */
  goToPage: (page: number) => void;
}

const PdfPage = memo(function PdfPage(props: PdfPageProps): React.ReactElement {
  const {
    doc,
    pageNumber,
    width,
    height,
    scale,
    dpr,
    className,
    annotations,
    onSelectAnnotation,
    flashId,
    onVisible,
    onMap,
    onDropMap,
    registerSearchLayer,
    strips,
    activeOffset,
    onFirstPaint,
    onStuck,
    onPageElement,
    goToPage,
    onBands,
  } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);

  /**
   * PDF 里的链接注释（引用、目录、网址）。按**页**加载一次，与缩放无关
   * （links.ts 里已归一化成 0–1，scale 会被约掉），所以依赖只有 doc + 页码。
   */
  const [links, setLinks] = useState<PageLink[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!doc || pageNumber < 1) {
      setLinks([]);
      return;
    }
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        const list = await loadPageLinks(doc, pageNumber, page.getViewport({ scale: 1 }));
        if (!cancelled) setLinks(list);
      } catch {
        if (!cancelled) setLinks([]); // 一页的坏注释不能影响渲染
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber]);

  /** 点链接：外链交给系统浏览器（主进程已有 setWindowOpenHandler → shell.openExternal），内链跳页 */
  const openLink = useCallback(
    (link: PageLink) => {
      if (link.url) {
        window.open(link.url, '_blank', 'noopener');
        return;
      }
      if (!link.dest) return;
      void resolveInternalPage(doc, link.dest).then((target) => {
        if (target) goToPage(target.page);
      });
    },
    [doc, goToPage],
  );
  const [painted, setPainted] = useState(false);
  /** 上一次 canvas 渲染任务的 promise：新任务必须等它真正结束，避免同一 canvas 上重叠渲染 */
  const prevTaskRef = useRef<Promise<void>>(Promise.resolve());
  /** 上一次渲染任务本体：等超时就靠它 cancel()，否则"永不 settle"的渲染会把这一页永久堵住 */
  const prevRenderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  /** 渲染失败后的自愈重试次数（有上限，不会无限循环） */
  const [retryTick, setRetryTick] = useState(0);
  /**
   * 当前这一页的文本层：官方 `TextLayerBuilder`（见 paintTextLayer 的说明）。
   * 缩放时它内部走 `TextLayer.update()`，只重排已有 span、不重建节点（缩放快的关键之一）。
   */
  const textLayerRef = useRef<TextLayerBuilderType | null>(null);
  const textLayerKeyRef = useRef<string | null>(null);
  const textLayerDocRef = useRef<unknown>(null);
  /**
   * 回调一律走 ref 取用，**不进渲染 effect 的依赖**。
   * 教训：父级只要传进来一个内联箭头函数（曾经就是 onPageMaps），它的身份每次渲染都变，
   * 会让整个 canvas + 文本层被拆掉重建；拖动过程中文本层节点被替换，原生选区的锚点随之失效，
   * 表现就是"选区莫名其妙乱选/整段选中"和"文本层间歇性一个 span 都没有"。
   */
  const cbRef = useRef({ onMap, onDropMap, onFirstPaint, onStuck, onBands });
  cbRef.current = { onMap, onDropMap, onFirstPaint, onStuck, onBands };

  /**
   * 位图实际渲染用的 scale：缩放先防抖 160ms，停手后再重绘**一次**。
   * 连按 3 下放大时，老实现会重绘 3 次（每次都是一张几千像素的大画布）→ 用户体感"放大很慢"。
   */
  const [renderScale, setRenderScale] = useState(scale);
  useEffect(() => {
    if (Math.abs(renderScale - scale) < 0.002) return;
    // **首屏绝不防抖**：还没画出来时，缩放值可能在布局稳定前连续变化（恢复的阅读位置 +
    // 适应宽度重算），防抖定时器会被反复清掉 → renderScale 永不更新 → 这一页永远停在骨架屏、
    // 文本层一个 span 都没有（实测：有些中文期刊 PDF 就是这么打不开的）。首屏直接跟随。
    if (!painted) {
      setRenderScale(scale);
      return;
    }
    const t = window.setTimeout(() => setRenderScale(scale), 160);
    return () => window.clearTimeout(t);
  }, [scale, renderScale, painted]);

  /**
   * 缩放**手势期间**的视觉反馈：只对 canvas 与文本层做一次 CSS transform（合成器层面，几乎零成本），
   * 不碰 `--total-scale-factor`、不重排文本层、不重绘 canvas。
   *
   * 为什么必须这样：中文期刊 PDF 的文本层是逐字 span（实测一篇 14 页论文 22138 个 span），
   * 只要 `--total-scale-factor` 一变，浏览器就要给这两万多个元素重算 font-size → 一次缩放卡半秒。
   * 停手 160ms 后 `renderScale` 才跟上，那时才更新变量、重排文本层、重绘一次 canvas。
   */
  const paintedRef = useRef({ w: width, h: height });
  useEffect(() => {
    const canvas = canvasRef.current;
    const text = textRef.current;
    if (!canvas) return;
    const f = renderScale > 0 ? scale / renderScale : 1;
    const on = Math.abs(f - 1) > 0.002;
    canvas.style.transformOrigin = '0 0';
    canvas.style.transform = on ? `scale(${f})` : '';
    if (text) {
      text.style.transformOrigin = '0 0';
      text.style.transform = on ? `scale(${f})` : '';
      if (on) {
        // 手势期间把它钉在"已渲染尺寸"上：它 CSS 是 inset:0，不钉住就会跟着页面盒子一起变大
        text.style.inset = 'auto';
        text.style.left = '0';
        text.style.top = '0';
        text.style.width = `${paintedRef.current.w}px`;
        text.style.height = `${paintedRef.current.h}px`;
      } else {
        text.style.inset = '';
        text.style.left = '';
        text.style.top = '';
        text.style.width = '';
        text.style.height = '';
      }
    }
  }, [scale, renderScale]);

  // 可见性上报
  useEffect(() => {
    onVisible(pageNumber, true);
    return () => onVisible(pageNumber, false);
  }, [pageNumber, onVisible]);

  useEffect(() => {
    onPageElement(pageNumber, rootRef.current);
    return () => onPageElement(pageNumber, null);
  }, [pageNumber, onPageElement]);

  useEffect(() => {
    const container = textRef.current;
    if (!container) return;
    registerSearchLayer(pageNumber, rootRef.current, container);
    return () => registerSearchLayer(pageNumber, null, null);
  }, [pageNumber, registerSearchLayer]);

  /**
   * 算这一页的栏带（供"划词禁止跨栏"）。
   * 用 **pdf.js 的文本项**而不是 DOM 里 span 的 x 投影：真实 CNKI 页面左侧常有竖排页眉，
   * DOM 投影会被它桥接（三栏算成一块），而文本项自带字体方向与几何，能稳定切栏。
   * 只按 doc + 页码算（栏带是页宽比例，与缩放无关），结果缓存在父级的 map 里。
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1 });
        // pdf.js 的 items 里混有 TextMarkedContent（只有 type、没有几何），没有 str 的一律丢掉
        const textItems = content.items.filter((it) => 'str' in it);
        const bands = columnBandsFromItems(textItems as Parameters<typeof columnBandsFromItems>[0], {
          pageWidth: viewport.width,
          pageHeight: viewport.height,
          scale: 1,
          styles: content.styles,
        });
        if (cancelled || !bands.length) return;
        const rel = bands.map((b) => ({ start: b.start / viewport.width, end: b.end / viewport.width }));
        console.debug(
          `[reader] 第 ${pageNumber} 页栏带：${rel.length} 栏 ${rel.map((b) => `[${b.start.toFixed(2)}~${b.end.toFixed(2)}]`).join(' ')}`,
        );
        cbRef.current.onBands?.(pageNumber, rel);
      } catch {
        /* 拿不到栏带就不做跨栏夹取，行为退回上一版（有 45 条划词验收兜底） */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber]);

  // canvas + 文本层
  useEffect(() => {
    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;
    /** 看门狗定时器 id（见 run() 开头） */
    let watchdog = 0;
    /** 是否有一轮 page.render() 正在跑：看门狗据此决定"等"还是"救" */
    let renderInFlight = false;

    /**
     * 给"可能永远不 settle"的 pdf.js promise 加**上限**。
     *
     * 这是本轮稳定性硬化的核心：pdf.js 的 render/文本层偶尔既不 resolve 也不 reject
     * （worker 卡住、图片解码悬挂），老代码会一直 await 下去——这一页就永久停在骨架屏。
     * 现在超时就**取消对应的任务**（取消会让它的 promise reject，于是等待立刻结束），
     * 再由调用方走"有界重试 → 重建文档"的恢复链。
     */
    const withTimeout = async <T,>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> => {
      let timer = 0;
      try {
        return await Promise.race([
          p,
          new Promise<never>((_, reject) => {
            timer = window.setTimeout(() => {
              try {
                onTimeout?.();
              } catch {
                /* 取消失败也不能把整条链带崩 */
              }
              reject(new Error(`等待超时（${ms}ms）`));
            }, ms);
          }),
        ]);
      } finally {
        window.clearTimeout(timer);
      }
    };

    /** 这一代是否真的把画布画完了（看门狗据此判断"能不能放过"） */
    let paintedThisGen = false;

    const run = async () => {
      // 看门狗：pdf.js 的 render/文本层偶尔会"既不 resolve 也不 reject"（worker 卡住），
      // 这时自愈分支根本走不到，页面会永远停在骨架屏、一个 span 都没有。
      //
      // 但**绝不能打断正在跑的渲染**：重挂会 cancel() 掉在飞的 render，
      // 复杂页（比如缺字体的中文期刊页）本来 8~20 秒能画完，被每 6 秒打断一次就永远画不完
      // —— 实测日志里就是"第 1 页 6 秒未挂上文本层，第 1 次整页重挂、第 2 次…"然后一直空白。
      // 所以：6 秒时若渲染仍在进行 → 只挂一个 24 秒的兜底，不重挂；确实没有任何渲染在跑才重挂。
      //
      // 注意"有 span"不等于"这一代完成了"：换缩放档时容器里**还留着上一代的旧 span**，
      // 若只看到 span 就放过，看门狗会被旧内容骗过去、连日志都不打（故障注入复现过：
      // 页面永久停在"白画布 + 骨架屏 + 旧文本层"）。所以必须同时要求**这一代画完了**。
      const armWatchdog = (ms: number, allowRemount: boolean) => {
        watchdog = window.setTimeout(() => {
          if (cancelled) return;
          if (paintedThisGen && textRef.current?.querySelector('span')) return;
          if (renderInFlight && !allowRemount) {
            armWatchdog(24000, true); // 再等 24 秒；真卡死才重挂
            return;
          }
          cbRef.current.onStuck?.(pageNumber);
        }, ms);
      };
      armWatchdog(6000, false);

      // 同一个 canvas 上不能有两个 render 任务重叠：canvas 尺寸一变（缩放/DPR/重排）这个
      // effect 就会重跑，而上一轮的 cancel() 是**异步**的——不等它真正结束就开新任务，
      // pdf.js 会抛 "Cannot use the same canvas during multiple render() operations"，
      // 然后这一页就永远停在骨架屏、文本层一个 span 都不挂（用户表现：划不中词）。
      //
      // 但"等"也要有上限：老代码裸 await，遇到永不 settle 的渲染就把这一页永久堵死。
      // 现在最多等 3 秒；超时就把上一个任务**取消掉**（取消会让它的 promise reject，
      // 我们的 catch 兜住），canvas 随即空出来，新任务可以安全开始。
      try {
        await withTimeout(prevTaskRef.current, 3000, () => prevRenderTaskRef.current?.cancel());
      } catch {
        console.warn(`[reader] 第 ${pageNumber} 页等待上一个渲染任务超时，已取消它并继续`);
      }
      if (cancelled) {
        window.clearTimeout(watchdog);
        return;
      }

      let page;
      try {
        page = await withTimeout(doc.getPage(pageNumber), 15000, () => {
          try {
            prevRenderTaskRef.current?.cancel();
          } catch {
            /* ignore */
          }
        });
      } catch (err) {
        // 取页都超时：多半是这个文档的 worker 已经卡住。走重试通道；重试次数用尽就请求重建文档
        // （父级已有"重挂两次仍失败 → 重建文档换干净 worker"的恢复链）。
        if (!cancelled) {
          console.warn(`[reader] 第 ${pageNumber} 页取页失败或超时`, err);
          if (retryTick < 2) {
            window.setTimeout(() => {
              if (!cancelled) setRetryTick((n) => n + 1);
            }, 400);
          } else {
            cbRef.current.onStuck?.(pageNumber);
          }
        }
        return;
      }
      if (cancelled) return;
      const canvas = canvasRef.current;
      const textContainer = textRef.current;
      if (!canvas || !textContainer) return;

      // 换文档 / 换页：旧的文本层必须丢掉，别拿上一份内容
      const layerKey = `${pageNumber}`;
      if (textLayerKeyRef.current !== layerKey || textLayerDocRef.current !== doc) {
        try {
          textLayerRef.current?.cancel();
        } catch {
          /* ignore */
        }
        textLayerRef.current = null;
        textLayerKeyRef.current = layerKey;
        textLayerDocRef.current = doc;
      }

      const viewport = page.getViewport({ scale: renderScale });
      paintedRef.current = { w: viewport.width, h: viewport.height };
      // 位图上限：高倍缩放时 400% 的一页宽能到 2400+ 像素，重绘一次要好几秒。
      // 超过上限就按上限渲染再由 CSS 拉伸（略微软一点，但缩放立刻跟手）。
      const pxWidth = Math.min(Math.round(viewport.width * dpr), MAX_CANVAS_PX);
      const ratio = pxWidth / Math.max(1, viewport.width);
      canvas.width = Math.max(1, pxWidth);
      canvas.height = Math.max(1, Math.round(viewport.height * ratio));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, viewport.width, viewport.height);

      let renderErr: unknown = null;
      try {
        renderTask = page.render({ canvas, canvasContext: ctx, viewport });
        prevRenderTaskRef.current = renderTask;
        prevTaskRef.current = renderTask.promise.catch(() => undefined);
        renderInFlight = true;
        // 渲染也要有上限：复杂页正常 8~20 秒，超过 25 秒基本就是卡死了 → 取消并走重试
        await withTimeout(renderTask.promise, 25000, () => {
          try {
            renderTask?.cancel();
          } catch {
            /* ignore */
          }
        });
      } catch (err) {
        const name = (err as { name?: string })?.name;
        const aborted = name === 'RenderingCancelledException' || name === 'AbortException';
        if (!aborted && !cancelled) {
          renderErr = err;
          console.warn(`[reader] 第 ${pageNumber} 页渲染失败或超时`, err);
        }
      } finally {
        renderInFlight = false;
      }
      if (cancelled) return;
      if (renderErr) {
        // 失败过就让出去：骨架屏留着，稍后重试一次，别把这一页永久卡死
        if (!cancelled && retryTick < 2) {
          window.setTimeout(() => {
            if (!cancelled) setRetryTick((n) => n + 1);
          }, 400);
        }
        return;
      }
      setPainted(true);
      paintedThisGen = true;
      cbRef.current.onFirstPaint?.();
      // 文本层（可选中 / 可被浏览器原生查找）。用官方 TextLayerBuilder：
      //   · 缩放时它内部的 render({viewport}) 会走 TextLayer.update()，只重排 span、不重建节点；
      //   · 它自带 `.endOfContent` + selectionchange 修正（见文件里 TEXT_LAYER_CSS 的说明）。
      // 渲染完成不等于 span 一定挂上，所以 paintTextLayer 内部带校验 + 重试。
      const painted2 = await paintTextLayer(page, viewport);
      if (cancelled) return;
      if (painted2) {
        window.clearTimeout(watchdog); // 这一页搞定了，别让看门狗再触发重试
        cbRef.current.onMap(pageNumber, buildPageTextMap(pageNumber, textContainer, viewport.width, viewport.height));
      } else {
        console.warn(`[reader] 第 ${pageNumber} 页文本层始终为空（划词不可用）`);
        // 自愈：偶尔会遇到"画布渲染完成、但文本层一个 span 都没挂上"（用户表现就是"划不中词"）。
        // 走和渲染失败同一条重试通道再试（有上限）；重试用尽就请求父级重建文档换干净 worker，
        // 别让这一页在整个会话里都不可选。
        if (!cancelled) {
          if (retryTick < 2) {
            window.setTimeout(() => {
              if (!cancelled) setRetryTick((n) => n + 1);
            }, 500);
          } else {
            cbRef.current.onStuck?.(pageNumber);
          }
        }
      }
    };

    /**
     * 把文本层的 span 按**视觉阅读顺序**重排（见 textOrder.ts 的说明）。
     *
     * 为什么必须做：pdf.js 按内容流顺序追加 span，多栏页面上它不等于阅读顺序；
     * 而浏览器扩展选区是**按 DOM 顺序**走的 —— 顺序不一致时，指针从一行挪到行间距里，
     * 焦点可能落到 DOM 里很远的一个 span，选区就把中间一大段全吃了（用户报的"莫名多选"）。
     * span 都是绝对定位，改 DOM 顺序不影响外观，只让原生选择变回 Word 那种感觉。
     *
     * 两个真实坑（都有实测数据）：
     *   ① pdf.js 在带标记内容的页面上会把 span 挂在 `.markedContent` wrapper 下
     *      （样本文献 A（双栏）p4 实测 448/449 个 span 都在 wrapper 里）。老代码"所有 span 必须
     *      同一父节点"的保守分支于是**完全不重排**，DOM 顺序 = 内容流顺序 → 跨栏夹取按几何取端点时
     *      只能拿到很短的安全区间（那页 5 字，整栏应有几百字）。wrapper 是 `display: contents`、
     *      视觉透明，所以这里把 span **提到文本层容器下**再排。
     *   ② `textOrder.ts::orderTextSpans` 找栏缝靠 x 覆盖投影，顶部通栏标题会把栏缝"桥接"掉，
     *      这种页面它只会给出"按行横跨"的顺序（左栏一行、右栏一行交替）——**竖着拖左栏也会跨栏**。
     *      所以有栏带时优先按栏带排（栏带来自 pdf.js 文本项，见 columnBands.ts），
     *      拿不到栏带（单栏/取不到文本项）才退回 `orderTextSpans`。
     */
    const reorderTextLayer = (container: HTMLElement, bands: { start: number; end: number }[]): void => {
      const spans = [...container.querySelectorAll<HTMLElement>('span')].filter(
        (s) => (s.textContent ?? '').trim().length > 0,
      );
      if (spans.length < 4) return;
      const parent = spans[0].parentElement;
      const sameParent = !!parent && spans.every((s) => s.parentElement === parent);
      const boxes = spans.map((s) => {
        const r = s.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      });

      // ① 同一父节点（含"已经被我们拍平过"的页）与 wrapper 结构**共用同一个"目标顺序"**。
      //    这点很关键：如果按父节点结构走两条不同的排序路径（拍平前按栏带、拍平后按 x 投影），
      //    两次重画就会来回改写 DOM 顺序；而**同一对边界点圈住的内容变了，浏览器不会补发
      //    `selectionchange`**，看护逻辑完全没机会纠正 —— 实测夹取已经把选区锁成右栏 650 字
      //    x590~997，约 0.7 秒后同一段文字变成横跨整页 x1~1147（span 数不变、零条 selectionchange）。
      const pageRect = rootRef.current?.getBoundingClientRect();
      const canBand = bands.length >= 2 && !!pageRect && pageRect.width > 0;
      if (!canBand && !sameParent) return; // wrapper + 没有栏带：保持旧行为，别动 DOM
      let order: number[];
      if (canBand && pageRect) {
        /** 第 i 个 span 落在第几栏；栏缝/跨栏返回 -1 */
        const bandOf = (i: number): number =>
          bandIndexOf(bands, (boxes[i].left + boxes[i].width / 2 - pageRect.left) / pageRect.width);
        const normal: number[] = [];
        const crossing: number[] = [];
        for (let i = 0; i < spans.length; i += 1) (bandOf(i) >= 0 ? normal : crossing).push(i);
        normal.sort((p, q) => bandOf(p) - bandOf(q) || boxes[p].top - boxes[q].top || boxes[p].left - boxes[q].left);
        crossing.sort((p, q) => boxes[p].top - boxes[q].top);
        // 通栏项（标题/图注/落在栏缝上的盒子）按 top 插回，保持整体从上到下的观感
        order = [];
        let e = 0;
        for (const i of normal) {
          while (e < crossing.length && boxes[crossing[e]].top <= boxes[i].top) order.push(crossing[e++]);
          order.push(i);
        }
        while (e < crossing.length) order.push(crossing[e++]);
      } else {
        order = orderTextSpans(boxes);
      }
      if (order.every((v, i) => v === i)) return; // 顺序已经对了：一个节点都别动（见上）
      const target = sameParent && parent ? parent : container;
      const wrappers = new Set(
        spans.map((s) => s.parentElement).filter((p): p is HTMLElement => !!p && p !== container),
      );
      const frag = document.createDocumentFragment();
      for (const i of order) frag.appendChild(spans[i]);
      target.appendChild(frag);
      console.debug(
        `[reader] 第 ${pageNumber} 页文本层按阅读顺序重排（${spans.length} 个 span` +
          `${sameParent ? '' : `，从 ${wrappers.size} 个 markedContent 提到容器下`}` +
          `${canBand ? `，按 ${bands.length} 栏` : ''}）`,
      );
    };

    /** 当前这页的文本层元素（由 TextLayerBuilder 创建，我们给它加了 rd-pdf-text 类名） */
    const textLayerEl = (): HTMLElement | null => textRef.current?.querySelector<HTMLElement>('.rd-pdf-text') ?? null;

    /** 丢掉当前文本层（取消 + 从宿主里摘掉），下一次 paintTextLayer 会重建 */
    const dropTextLayer = (): void => {
      try {
        textLayerRef.current?.cancel();
      } catch {
        /* ignore */
      }
      textLayerRef.current = null;
      textLayerEl()?.remove();
    };

    /**
     * 挂文本层，返回是否真的挂上了 span。
     *
     * 用**官方 TextLayerBuilder**（`pdfjs-dist/web/pdf_viewer.mjs`）替换了我早先手写的那套：
     *   · 它在文本层末尾加 `.endOfContent`，并在全局 `selectionchange` 里修正
     *     "指针落在文字以外 → 焦点被解析到容器"这种畸形选区（就是我们之前手写纠正的上游版本）；
     *   · `render({ viewport })` 内部对已渲染过的层走 `TextLayer.update()`，只重排 span 不重建节点。
     * 我们只补两件它不做的事：
     *   ① 给它自己的 div 加上 `rd-pdf-text` 类名（沿用我们的样式与验收脚本的选择器）；
     *   ② 渲染完成后按**阅读顺序**重排 span（多栏页面里 pdf.js 的内容流顺序 ≠ 阅读顺序）。
     * 另外保留"校验 + 重试"：渲染完成不等于 span 一定挂上，空层对用户就是"划不中词"。
     */
    const paintTextLayer = async (page: pdfjsLib.PDFPageProxy, viewport: ReturnType<typeof page.getViewport>) => {
      const host = textRef.current;
      if (!host) return false;
      /**
       * 重排用的**栏带**（页宽比例 0~1）：来自 pdf.js 文本项，见 columnBands.ts。
       * `getTextContent()` 刚被 TextLayerBuilder 拉过，pdf.js 会缓存，这里几乎不花时间。
       * 拿不到就退化成"按行横跨"的旧排序——不会更糟。
       */
      let bands: { start: number; end: number }[] = [];
      try {
        const content = await page.getTextContent();
        const items = content.items.filter((it) => 'str' in it);
        const unscaledW = viewport.width / viewport.scale;
        bands = columnBandsFromItems(items as Parameters<typeof columnBandsFromItems>[0], {
          pageWidth: unscaledW,
          pageHeight: viewport.height / viewport.scale,
          scale: viewport.scale,
          styles: content.styles,
        }).map((b) => ({ start: b.start / viewport.width, end: b.end / viewport.width }));
      } catch {
        bands = [];
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (cancelled) return false;
        try {
          if (!textLayerRef.current) {
            const { TextLayerBuilder } = await loadTextLayerBuilder();
            textLayerRef.current = new TextLayerBuilder({
              pdfPage: page,
              onAppend: (div: HTMLDivElement) => {
                div.classList.add('rd-pdf-text');
                host.replaceChildren(div);
              },
            });
          }
          // 官方 viewer 在"不需要图片注释坐标"时就是传 null（见 pdf_viewer.mjs 的 #renderTextLayer）；
          // 这里的 .d.ts 把 images 标成必填、但运行时允许 null，所以显式断言一下。
          const noImages = null as unknown as Parameters<TextLayerBuilderType['render']>[0]['images'];
          // 取文与挂层都要有上限：卡住的文本层同样是"永不 settle"，会把这一页永久留成不可选。
          await withTimeout(
            textLayerRef.current.render({ viewport, images: noImages }),
            12000,
            () => textLayerRef.current?.cancel(),
          );
        } catch (err) {
          if (!cancelled) console.warn(`[reader] 第 ${pageNumber} 页文本层失败（第 ${attempt + 1} 次）`, err);
        }
        if (cancelled) return false;
        const layer = textLayerEl();
        if (layer?.querySelector('span')) {
          reorderTextLayer(layer, bands);
          return true;
        }
        dropTextLayer();
        await new Promise((r) => setTimeout(r, 120));
      }
      return false;
    };

    void run();

    return () => {
      cancelled = true;
      window.clearTimeout(watchdog);
      try {
        renderTask?.cancel();
      } catch {
        /* ignore */
      }
      // 上一个任务也要取消：否则它可能一直挂在"等上一个任务"那 3 秒超时上，
      // 白等不说，还会让新 mounted 的页拿不到空闲 canvas。
      try {
        prevRenderTaskRef.current?.cancel();
      } catch {
        /* ignore */
      }
      setPainted(false);
      cbRef.current.onDropMap(pageNumber);
    };
    // 依赖里**不放回调**（见 cbRef 的说明）：只有 doc/页码/缩放/DPR 与重试计数才该重建这一页
  }, [doc, pageNumber, renderScale, dpr, retryTick]);

  // 组件卸载时才真正取消文本层（缩放重跑要保留它做原地 update）
  useEffect(() => {
    return () => {
      try {
        textLayerRef.current?.cancel();
      } catch {
        /* ignore */
      }
      // 连它的 DOM 一起摘掉：TextLayerBuilder 会把这一层登记进全局选择处理表，
      // 留着空壳只会让后续的 selectionchange 白跑。
      textRef.current?.querySelector('.rd-pdf-text')?.remove();
      textLayerRef.current = null;
      textLayerKeyRef.current = null;
      textLayerDocRef.current = null;
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={`rd-pdf-page ${className}`}
      data-page-index={pageNumber}
      data-page-number={pageNumber}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        // pdf.js 文本层靠它算字号与位移；必须等于该页的**已渲染**缩放倍数。
        // 用 renderScale（防抖后的档位）而不是 scale：缩放手势期间靠 transform 拉伸，
        // 这样两万多个逐字 span 不会每按一下就重算一遍样式（那是"放大很慢"的根因）。
        ['--total-scale-factor' as string]: String(renderScale),
      }}
    >
      <canvas ref={canvasRef} className="rd-pdf-canvas" />
      <div ref={textRef} className="rd-pdf-host" data-page={pageNumber} />
      {links.length ? (
        // 链接热区压在文本层之上（与 pdf.js 的 annotationLayer 同一套做法）：容器不吃事件、
        // 只有链接本身 pointer-events:auto，所以链接可点、其它地方照常划词。
        <div className="rd-links">
          {links.flatMap((link, li) =>
            link.rects.map((r, ri) => (
              <button
                key={`${li}-${ri}`}
                type="button"
                className="rd-link"
                title={link.url ?? '跳转到文内位置'}
                aria-label={link.url ?? '文内链接'}
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                }}
                onClick={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  openLink(link);
                }}
              />
            )),
          )}
        </div>
      ) : null}
      {!painted ? <div className="rd-page-skeleton" aria-hidden /> : null}
      {strips && strips.length ? (
        <div className="rd-search-layer" aria-hidden>
          {strips.map((strip, idx) => (
            <span
              key={`${strip.key}-${idx}`}
              className={`rd-search-hit${Number(strip.key) === activeOffset ? ' is-current' : ''}`}
              style={{
                left: `${strip.left}%`,
                top: `${strip.top}%`,
                width: `${strip.width}%`,
                height: `${strip.height}%`,
              }}
            />
          ))}
        </div>
      ) : null}
      <AnnotationLayer
        annotations={annotations}
        page={pageNumber}
        onSelect={(annotation) => onSelectAnnotation(annotation, rootRef.current?.getBoundingClientRect() ?? null)}
        flashId={flashId}
      />
    </div>
  );
});

export const PdfViewer = memo(function PdfViewer(props: PdfViewerProps): React.ReactElement | null {
  const {
    item,
    doc,
    sizes,
    sizesReady,
    containerRef,
    containerSize,
    outline,
    annotations,
    loading,
    loadProgress,
    onZoom,
    onPageChange,
    onProgress,
    onSelectAnnotation,
    onSelection,
    flashId,
    searchQuery,
    searchVersion,
    searchActiveIndex,
    onSearchHitCounts,
    onPageMaps,
    onContextCommand,
    onFirstPaint,
    degradedWorker,
    onReloadDoc,
  } = props;

  ensureTextLayerStyles();

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef(1);
  const pageEls = useRef(new Map<number, HTMLElement>());
  const mapsRef = useRef<Map<number, PageTextMap>>(new Map());
  const layersRef = useRef(new Map<number, { root: HTMLElement; container: HTMLElement }>());

  const [visible, setVisible] = useState<Set<number>>(() => new Set([1]));
  const [currentPage, setCurrentPage] = useState(1);
  const [stripsByPage, setStripsByPage] = useState<Map<number, HighlightStrip[]>>(new Map());
  const [hitCounts, setHitCounts] = useState<Map<number, number>>(new Map());

  const total = doc?.numPages ?? item.pageCount ?? 0;
  const fallback: PageSize = sizes[0] ?? { width: 612, height: 792, rotation: 0 };

  const pageSizes = useMemo(() => {
    const list: PageSize[] = [];
    for (let i = 0; i < total; i += 1) list.push(sizes[i] ?? { ...fallback, rotation: 0 });
    return list;
  }, [sizes, total, fallback]);

  const base = pageSizes[0] ?? fallback;
  const layout = outline.layout;

  /** fit-page 时所有页共用同一个"最大页贴合"比例，避免每页重算 */
  const fitPageScale = useMemo(() => {
    if (containerSize.width <= 0 || containerSize.height <= 0 || base.width <= 0) return 1;
    const availW = Math.max(80, containerSize.width - outline.padding * 2 - (layout === 'double' ? outline.gutter : 0));
    const availH = Math.max(80, containerSize.height - outline.padding * 2);
    let maxW = base.width;
    let maxH = base.height;
    for (const size of pageSizes) {
      maxW = Math.max(maxW, size.width);
      maxH = Math.max(maxH, size.height);
    }
    return clampZoom(Math.min(availW / maxW, availH / maxH));
  }, [containerSize.width, containerSize.height, outline.padding, outline.gutter, layout, base.width, base.height, pageSizes]);

  /** 每页各自的显示比例：fit-width 下各页贴合同一列宽，手动缩放时统一 */
  const pageScaleOf = useCallback(
    (size: PageSize): number => {
      if (outline.fit === 'manual') return clampZoom(outline.zoom);
      if (outline.fit === 'fit-page') return fitPageScale;
      if (containerSize.width <= 0 || base.width <= 0 || size.width <= 0) return 1;
      const availW = Math.max(80, containerSize.width - outline.padding * 2 - (layout === 'double' ? outline.gutter : 0));
      const columnWidth = layout === 'double' ? base.width * 2 + 12 : base.width;
      const uniform = clampZoom(availW / columnWidth);
      return clampZoom(uniform * (base.width / size.width)) || uniform;
    },
    [outline.fit, outline.zoom, outline.padding, outline.gutter, containerSize.width, base.width, layout, fitPageScale],
  );

  const uniformScale = pageScaleOf(base);
  useLayoutEffect(() => {
    scaleRef.current = uniformScale;
  }, [uniformScale]);

  const dpr = useMemo(() => Math.min(2.5, Math.max(1, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)), []);
  const [dprLive, setDprLive] = useState(dpr);
  useEffect(() => {
    const update = () => setDprLive(Math.min(2.5, Math.max(1, window.devicePixelRatio || 1)));
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const onVisible = useCallback((page: number, isVisible: boolean) => {
    setVisible((prev) => {
      if (isVisible === prev.has(page)) return prev;
      const next = new Set(prev);
      if (isVisible) next.add(page);
      else next.delete(page);
      return next;
    });
  }, []);

  const onMap = useCallback(
    (page: number, map: PageTextMap) => {
      mapsRef.current.set(page, map);
      onPageMaps(mapsRef.current);
    },
    [onPageMaps],
  );
  const onDropMap = useCallback(
    (page: number) => {
      mapsRef.current.delete(page);
      onPageMaps(mapsRef.current);
    },
    [onPageMaps],
  );
  const registerSearchLayer = useCallback((page: number, root: HTMLElement | null, container: HTMLElement | null) => {
    if (root && container) layersRef.current.set(page, { root, container });
    else layersRef.current.delete(page);
  }, []);
  const onPageElement = useCallback((page: number, el: HTMLElement | null) => {
    if (el) pageEls.current.set(page, el);
    else pageEls.current.delete(page);
  }, []);

  /** 要渲染的页：可见页 ±2；单页/双页模式只留当前页附近 */
  const renderSet = useMemo(() => {
    const set = new Set<number>();
    /**
     * 只给"视口附近"的页挂 canvas + 文本层。
     * 中文期刊 PDF 的文本层是**逐字 span**（实测一篇 14 页的论文有 22138 个 span）：
     * 页数一多，缩放时浏览器要给这几万个元素重算样式，一次缩放能卡半秒。
     * 所以这里既要限定"哪些页"，也要**限制总数**——按离当前页的距离取最近的几页。
     */
    // 高倍缩放时只留 2 页：中文页的文本层是逐字 span，页数越少缩放越跟手
    const MAX_PAGES = uniformScale > 1.5 ? 2 : 3;
    if (layout !== 'continuous') {
      set.clear();
      // 双页模式：让 (2,3)、(4,5)… 成对显示
      const first = layout === 'double' && currentPage > 1 ? currentPage - ((currentPage - 1) % 2) : currentPage;
      set.add(first);
      if (layout === 'double') {
        if (first + 1 <= total) set.add(first + 1);
      } else {
        for (let d = -1; d <= 1; d += 1) {
          const p = currentPage + d;
          if (p >= 1 && p <= total) set.add(p);
        }
      }
      return set;
    }
    // **当前页必须在渲染集合里**（硬约束）：否则"恢复阅读位置落在未渲染页"时，
    // 只按可见集合挑页会把当前页挤掉，那一页永远不渲染 → 用户看到一片空白。
    set.add(currentPage);
    // 再依次补：下一页（往下读最常见）、上一页、以及观察器认为可见的页（按离当前页远近排）
    const rest = [...visible]
      .filter((p) => p >= 1 && p <= total)
      .sort((a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage) || a - b);
    for (const p of [currentPage + 1, currentPage - 1, ...rest]) {
      if (set.size >= MAX_PAGES) break;
      if (p >= 1 && p <= total) set.add(p);
    }
    return set;
  }, [visible, total, currentPage, layout, uniformScale]);

  const renderSetKey = useMemo(() => [...renderSet].sort((a, b) => a - b).join(','), [renderSet]);

  // 搜索高亮重算（防抖，等布局稳定）
  useEffect(() => {
    if (!searchQuery.trim()) {
      setStripsByPage((prev) => (prev.size ? new Map() : prev));
      setHitCounts((prev) => (prev.size ? new Map() : prev));
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      const next = new Map<number, HighlightStrip[]>();
      const counts = new Map<number, number>();
      for (const [page, layer] of layersRef.current) {
        try {
          const strips = findHighlightStrips(layer.container, layer.root, searchQuery);
          if (strips.length) {
            next.set(page, strips);
            counts.set(page, hitCountOfStrips(strips));
          }
        } catch {
          /* 单页失败不影响其它页 */
        }
      }
      setStripsByPage(next);
      setHitCounts(counts);
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchQuery, searchVersion, renderSetKey, uniformScale, containerSize.width]);

  useEffect(() => {
    onSearchHitCounts?.(hitCounts);
  }, [hitCounts, onSearchHitCounts]);

  /** 当前命中在该页内的序号 */
  const searchOffsetOf = useCallback(
    (page: number) => {
      if (!searchQuery.trim() || searchActiveIndex < 0) return -1;
      let head = 0;
      for (let p = 1; p < page; p += 1) head += hitCounts.get(p) ?? 0;
      const local = searchActiveIndex - head;
      const count = hitCounts.get(page) ?? 0;
      return local >= 0 && local < count ? local : -1;
    },
    [searchQuery, searchActiveIndex, hitCounts],
  );

  // -------- 滚动 -> 当前页 / 进度 --------
  const geometryRef = useRef<{ sizes: PageSize[]; scales: number[]; padding: number; gap: number }>({
    sizes: [],
    scales: [],
    padding: outline.padding,
    gap: outline.gap,
  });

  const layoutComputed = useMemo(() => {
    const scales = pageSizes.map((size) => pageScaleOf(size));
    return { scales, heights: pageSizes.map((size, idx) => size.height * scales[idx]) };
  }, [pageSizes, pageScaleOf]);

  useLayoutEffect(() => {
    geometryRef.current = { sizes: pageSizes, scales: layoutComputed.scales, padding: outline.padding, gap: outline.gap };
  }, [pageSizes, layoutComputed, outline.padding, outline.gap]);

  const currentPageRef = useRef(1);
  /** 跳页代次：连点缩略图 / 连按 ] 时，旧的重试与复校链必须自己退出（见 goToPage） */
  const jumpGenRef = useRef(0);
  /**
   * 卡死页的重挂次数（每页最多 2 次）。
   * 看门狗发现某页 6 秒还没挂上文本层时，换 key 让这一页整块重挂：新 canvas、新 ref、
   * prevTaskRef 重置——专治"上一个 render 的 promise 永不 settle 导致后续全部卡住"。
   */
  const stuckRef = useRef(new Map<number, number>());
  const [, forceRedraw] = useState(0);

  const reloadRef = useRef(false);
  /** 各页上报栏带：只写 ref，回调身份必须稳定（否则会带着页面 effect 一起重订阅） */
  const handleBands = useCallback((page: number, bands: { start: number; end: number }[]) => {
    bandsByPageRef.current.set(page, bands);
  }, []);

  const onStuck = useCallback((page: number) => {
    const n = stuckRef.current.get(page) ?? 0;
    // 重挂一两次先试（多数情况能救回来）；还是不行说明 pdf.js 的 worker 已经卡死，
    // 只重挂这一页没用 —— 请求父级重建文档（换一个干净的 worker），每次文档只做一次。
    if (n >= 2) {
      if (!reloadRef.current && onReloadDoc) {
        reloadRef.current = true;
        console.warn('[reader] 文本层始终挂不上，重建文档以恢复');
        onReloadDoc();
      }
      return;
    }
    stuckRef.current.set(page, n + 1);
    console.warn(`[reader] 第 ${page} 页 6 秒未挂上文本层，第 ${n + 1} 次整页重挂`);
    forceRedraw((v) => v + 1);
  }, [onReloadDoc]);

  // 换文档时清掉重挂计数与"已重建过"标记
  useEffect(() => {
    stuckRef.current.clear();
    reloadRef.current = false;
  }, [doc]);

  const reportScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || outline.layout !== 'continuous') return;
    const { scales, padding, gap } = geometryRef.current;
    const y = el.scrollTop;

    // 当前页判定：**先看所有页的槽位元素**（`.rd-page-slot` 对每一页都存在，含未渲染的 ghost），
    // 这样"恢复阅读位置落在未渲染页上"也能判对；槽位拿不到时才退回估算几何。
    //
    // 教训（真实文献上踩到）：只认已挂载的页会死锁——这篇有阅读位置记忆（第 3 页 / 236%），
    // 打开时视口里那一页还没渲染（是 ghost），只按已挂载的页 1、2 判就会认定"当前是第 2 页"，
    // 于是第 3 页永远不进入渲染集合，用户看到的就是**一片空白**。
    let page = 0;
    let ratio = 0;
    const viewportTop = el.getBoundingClientRect().top;
    const slots = el.querySelectorAll<HTMLElement>('.rd-page-slot');
    slots.forEach((node, index) => {
      const rect = node.getBoundingClientRect();
      const offset = rect.top - viewportTop; // 相对滚动容器顶部
      if (offset <= rect.height * 0.5 && rect.bottom - viewportTop > 0 && (!page || offset <= 8)) {
        page = index + 1;
        ratio = rect.height > 0 ? Math.max(0, Math.min(1, -offset / rect.height)) : 0;
      }
    });
    if (!page) {
      let acc = padding;
      page = 1;
      for (let i = 0; i < scales.length; i += 1) {
        const h = pageSizes[i].height * scales[i] + gap;
        if (y < acc + h) {
          page = i + 1;
          ratio = Math.max(0, Math.min(1, (y - acc) / Math.max(1, h)));
          break;
        }
        acc += h;
        page = i + 1;
      }
    }
    if (page !== currentPageRef.current) {
      currentPageRef.current = page;
      setCurrentPage(page);
      onPageChange(page);
    }
    const percent = total > 1 ? ((page - 1 + ratio) / Math.max(1, total - 1)) * 100 : 100;
    onProgress({
      page,
      total,
      percent: Math.max(0, Math.min(100, percent)),
      scrollTop: ratio,
      zoom: scales[page - 1] ?? uniformScale,
    });
  }, [pageSizes, outline.layout, total, onPageChange, onProgress, uniformScale]);

  const reportRef = useRef(reportScroll);
  useLayoutEffect(() => {
    reportRef.current = reportScroll;
  }, [reportScroll]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame: number | null = null;
    let idle: number | null = null;
    const onScroll = () => {
      if (frame === null) {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          reportRef.current();
        });
      }
      if (idle !== null) window.clearTimeout(idle);
      idle = window.setTimeout(() => reportRef.current(), 160);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (idle !== null) window.clearTimeout(idle);
    };
  }, [doc, outline.layout]);

  // -------- 跳页 --------
  const goToPage = useCallback(
    (page: number, smooth = false) => {
      const target = Math.max(1, Math.min(total || 1, Math.round(page)));
      setCurrentPage(target);
      currentPageRef.current = target;
      onPageChange(target);
      const el = scrollRef.current;
      if (!el) return;

      // 代次：连点两个缩略图 / 连按 ] 时，前一次的 80ms 复校与 60ms 重试链会把后一次的目标顶回去。
      // 每次跳页都递增代次，旧链发现自己过期就直接退出。
      const gen = (jumpGenRef.current += 1);

      /**
       * 按**真实 DOM 位置**把目标页对齐到视口顶部。
       * 原来是自己累加 `pageSizes[i].height * scales[i] + gap`，一旦几何跟实际布局有偏差
       * （fit 模式、页间距、DPR 取整、虚拟化补位）就会"跳到的页不对"——用户报的就是这个。
       * 目标页还没挂载（虚拟化）时按估算先滚过去，再重试几次等它挂上后精确校正。
       */
      const align = (attempt: number, allowSmooth: boolean) => {
        if (gen !== jumpGenRef.current) return; // 已经有更新的一次跳页，别再往回拉
        const node = pageEls.current.get(target) ?? el.querySelector<HTMLElement>(`[data-page-index="${target}"]`);
        if (node) {
          if (outline.layout === 'continuous') {
            const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
            el.scrollTo({ top: Math.max(0, top), behavior: allowSmooth && smooth && attempt === 0 ? 'smooth' : 'auto' });
          } else {
            node.scrollIntoView({ block: 'center', behavior: allowSmooth && smooth && attempt === 0 ? 'smooth' : 'auto' });
          }
          // 连续滚动下再校一次：页面高度可能在这一次渲染后才最终确定
          if (attempt === 0 && outline.layout === 'continuous') {
            window.setTimeout(() => align(1, false), 80);
          }
          return;
        }
        if (attempt >= 8) return;
        // 还没挂载：先用几何估算滚到附近（让目标页进入渲染窗口），再重试精确对齐
        if (attempt === 0 && outline.layout === 'continuous') {
          const { scales, padding, gap } = geometryRef.current;
          let top = padding;
          for (let i = 0; i < target - 1 && i < scales.length; i += 1) top += pageSizes[i].height * scales[i] + gap;
          el.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
        }
        window.setTimeout(() => align(attempt + 1, false), 60);
      };
      align(0, true);
    },
    [total, onPageChange, outline.layout, pageSizes],
  );

  const goToAnnotation = useCallback(
    (annotation: Annotation) => {
      goToPage(annotation.page, false);
    },
    [goToPage],
  );

  // 把句柄交给父级（页码跳转、批注定位）
  const onReadyRef = useRef(props.onReady);
  useLayoutEffect(() => {
    onReadyRef.current = props.onReady;
  }, [props.onReady]);
  useEffect(() => {
    onReadyRef.current?.({ goToPage });
  }, [goToPage]);
  // goToAnnotation 目前由父级通过 goToPage 使用，这里保留导出以避免重复实现
  void goToAnnotation;

  useLayoutEffect(() => {
    if (outline.layout !== 'continuous') {
      const el = scrollRef.current;
      const node = el?.querySelector<HTMLElement>(`[data-page-index="${currentPage}"]`);
      node?.scrollIntoView({ block: 'center' });
      return;
    }
    // 尺寸预算完成 / 缩放变化后，把当前页重新对位
    goToPage(currentPageRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizesReady, outline.layout, outline.fit]);

  // 初始滚动位置：容器出现后应用一次（含"上次读到第几页"）
  const initialisedRef = useRef(false);
  useLayoutEffect(() => {
    if (initialisedRef.current || !doc || !sizesReady) return;
    initialisedRef.current = true;
    goToPage(props.initialPage || 1);
  }, [doc, sizesReady, goToPage, props.initialPage]);

  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  // -------- 选区（划词） --------
  const lastSelectionRef = useRef<PdfSelectionPayload | null>(null);
  /**
   * 每页的"栏带"（按**页宽比例** 0–1 存，抗缩放与手势 transform）：由各页 PdfPage 用 pdf.js 的
   * 文本项算好（见 columnBands.ts）后上报，划词夹取据此**硬性禁止跨栏**。
   */
  const bandsByPageRef = useRef(new Map<number, { start: number; end: number }[]>());
  /**
   * 最后一次非空选区的文字（只增不清）。
   *
   * 试过用它给右键菜单兜底（"按 1 标注后 DOM 选区还在/刚被右键清掉"那种不同步场景），
   * 结果把**真正的无选区场景**也带偏了：明明没选区，菜单却给出标注项（UX 回归实测
   * "无选区时 4 项齐全且没有标注项（7 项）"变红）。所以这里只留作诊断/日志用途，
   * **不参与菜单判定**。不同步那条老问题记在 docs/known-issues.md 里。
   */
  const lastTextRef = useRef('');
  // 事件回调里要读最新的批注与选择回调，但不希望它们进依赖数组导致频繁重订阅
  const annotationsRef = useRef(props.annotations);
  annotationsRef.current = props.annotations;
  const onSelectAnnotationRef = useRef(props.onSelectAnnotation);
  onSelectAnnotationRef.current = props.onSelectAnnotation;

  const collectSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      if (lastSelectionRef.current) {
        lastSelectionRef.current = null;
        onSelectionRef.current(null);
      }
      return;
    }
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (text.length < 1) return;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.parentElement?.closest<HTMLElement>('.rd-pdf-page');
    const endEl = range.endContainer.parentElement?.closest<HTMLElement>('.rd-pdf-page');
    if (!startEl || startEl !== endEl) return; // 跨页选择暂不支持建批注
    const pageEl = startEl;
    const page = Number(pageEl.dataset.pageIndex ?? '0');
    if (!page) return;
    const pageRect = pageEl.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) return;

    const map = mapsRef.current.get(page);
    let anchor: { prefix: string; suffix: string; occurrence: number };
    if (map) {
      const normStart = normIndexFromNode(map, range.startContainer, range.startOffset);
      const normEnd = normIndexFromNode(map, range.endContainer, range.endOffset);
      anchor =
        normStart >= 0 && normEnd > normStart
          ? buildAnchorFromNormalized(map.text, normStart, normEnd, text)
          : buildAnchorFallback(text, map.text);
    } else {
      anchor = buildAnchorFallback(text, '');
    }

    const rects = clampRects(relRects(Array.from(range.getClientRects()), pageRect));
    const first = range.getClientRects()[0];
    const payload: PdfSelectionPayload = {
      text,
      rect: first
        ? { left: first.left, top: first.top, right: first.right, bottom: first.bottom }
        : { left: pageRect.left, top: pageRect.top, right: pageRect.right, bottom: pageRect.top },
      pageEl,
      page,
      rects,
      anchor,
    };
    lastSelectionRef.current = payload;
    lastTextRef.current = payload.text;
    onSelectionRef.current(payload);
    // 依赖保持空：`collectSelection` 的身份必须稳定，否则鼠标 effect 会反复重订阅，
    // 把"手动划词"等 effect 局部状态整批重置（真实后果：拖选后选区变空、工具条不弹）。
  }, []);
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;
    useEffect(() => {
      /**
       * 点在了哪条批注上（几何命中）。
       * 批注的文字标记层设成 pointer-events:none（好处：已经高亮过的文字照样能用鼠标划过选中），
       * 代价是点击不再由 DOM 事件派发，所以这里按 0-1 相对矩形自己算一遍。
       */
      const hitTestAnnotation = (pageEl: HTMLElement, clientX: number, clientY: number): Annotation | null => {
        const page = Number(pageEl.dataset.pageIndex ?? '0');
        if (!page) return null;
        const rect = pageEl.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const x = (clientX - rect.left) / rect.width;
        const y = (clientY - rect.top) / rect.height;
        const list = annotationsRef.current.filter((a) => a.page === page && a.type !== 'bookmark');
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const a = list[i];
          if (a.rects.some((r) => x >= r.x - 0.004 && x <= r.x + r.w + 0.004 && y >= r.y - 0.004 && y <= r.y + r.h + 0.004)) {
            return a;
          }
        }
        return null;
      };

      const pageOf = (node: Node | null): HTMLElement | null => {
        const el = !node ? null : node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
        return (el?.closest?.('.rd-pdf-page') as HTMLElement | null) ?? null;
      };

      /** 指针最后位置：selectionchange 里没有事件参数，只能自己记 */
      const pointerRef = { x: 0, y: 0 };

      /** 边界是否落在"文本层容器"上（而不是某个 span 里） */
      const containerBoundary = (node: Node | null): HTMLElement | null =>
        node && node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).classList?.contains('rd-pdf-text')
          ? (node as HTMLElement)
          : null;

      /** 离指针最近的 span：**竖直优先**（Word 是"停在指针所在那一行"），再比横向 */
      const nearestSpan = (spans: HTMLElement[], x: number, y: number): HTMLElement | null => {
        let best: HTMLElement | null = null;
        let bestScore = Number.POSITIVE_INFINITY;
        for (const s of spans) {
          const r = s.getBoundingClientRect();
          if (r.width <= 0 && r.height <= 0) continue;
          const dy = Math.max(0, r.top - y, y - r.bottom);
          const dx = Math.max(0, r.left - x, x - r.right);
          const score = dy * 3 + dx;
          if (score < bestScore) {
            bestScore = score;
            best = s;
          }
        }
        return best;
      };

      /**
       * 核心兜底：**边界落在文本层容器上时，把它改锚到离指针最近的 span**。
       *
       * 为什么必须有这一手（实测取证）：
       * 指针停在哪一行文字都不压的空隙（行间距）或页面空白处时，Chromium 原生会把焦点解析成
       * 文本层容器 `DIV.rd-pdf-text`（offset 0）。容器在 DOM 顺序里排在**所有 span 之前**，
       * 于是 range 被规范化成「容器开头 → 按下点所在 span」——选区从**页首**一路连到按下行：
       * 行间距拖一下 298 字 / 覆盖 1494px，拖到页脚空白 1366 字（几乎整页），就是用户说的"莫名多选"。
       * 跨页安全网拦不住它（起止都在同一页）。
       *
       * 处理原则：只替换**落在容器上**的那一端，另一端（真实按下点）原样保留；
       * 结果只在**变短**时才采用，绝不把选区改长。
       */
      const fixContainerBoundary = (): boolean => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);
        const startC = containerBoundary(range.startContainer);
        const endC = containerBoundary(range.endContainer);
        if (!startC && !endC) return false;
        const layer = startC ?? endC;
        if (!layer) return false;
        const spans = [...layer.querySelectorAll<HTMLElement>('span')].filter((s) => (s.textContent ?? '').trim().length > 0);
        if (!spans.length) return false;
        const near = nearestSpan(spans, pointerRef.x, pointerRef.y);
        const node = near?.firstChild ?? null;
        if (!near || !node) return false;
        const rect = near.getBoundingClientRect();
        const atEnd = pointerRef.x > rect.left + rect.width / 2;
        const offset = atEnd ? (node.textContent ?? '').length : 0;
        const keepNode = startC ? range.endContainer : range.startContainer;
        const keepOffset = startC ? range.endOffset : range.startOffset;
        const build = (aNode: Node, aOff: number, bNode: Node, bOff: number): Range | null => {
          const r = document.createRange();
          try {
            r.setStart(aNode, aOff);
            r.setEnd(bNode, bOff);
            return r;
          } catch {
            return null;
          }
        };
        /**
         * 两个顺序都要试：DOM 顺序与参数顺序相反时，Chromium **不抛异常**，
         * 而是返回一个**塌陷**的 Range（踩过的坑：`build(a,b) ?? build(b,a)` 永远不会走第二条）。
         */
        const fixed =
          [build(node, offset, keepNode, keepOffset), build(keepNode, keepOffset, node, offset)].find(
            (r): r is Range => !!r && !r.collapsed,
          ) ?? null;
        if (!fixed) return false;
        /**
         * **容器边界一律替换，不看长度**。
         *
         * 这是"只夹短"规则的一个例外，也是实测踩出来的：`range.startContainer` 是
         * `DIV.textLayer` 时，`getClientRects()` 会把**容器与 .endOfContent 的整页框**一起报出来
         * （27 字的选区报成 1536px 高、2 条文字带），工具栏定位与批注矩形都会被污染。
         * 而"起点/终点落在容器上"本身就代表"整页开头/结尾"，从来不是用户想要的选区 ——
         * 所以这里直接换成最近的 span；只有替换后为空才放弃。
         * 长度判断仍然保留在跨页夹取（clampCrossPage）那条路径上。
         */
        sel.removeAllRanges();
        sel.addRange(fixed);
        console.debug(`[reader] 容器边界修整：${range.toString().length} → ${fixed.toString().length} 字`);
        return true;
      };

      /**
       * 划词的全部逻辑就是这一句：**让浏览器自己选**。
       *
       * 曾经这里有一整套自研实现（拖动中每帧自己构造选区、按行取点、夹在起始页内），
       * 起因是"从正文拖到页面空白会一路吃到后面几页"。那套代码把浏览器的原生行为
       * （行间距里就近吸附、双向扩展、双击选词、Shift 扩选）全都盖掉了，手感反而不像 Word，
       * 所以现在只保留唯一的干预：**跨页时夹回按下时所在那一页**。
       *
       * 为什么只夹跨页就够：Chromium 的选区扩展是按 DOM 顺序走的，本页文字层选完就跨到下一页，
       * 跨页才是"全选"的来源；页内的任何位置（包括行间距）都交给它，那正是最接近 Word 的行为。
       * 夹取**只在变短时**替换，绝不把选区改长。
       */
      const clampCrossPage = (): void => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        const startPage = pageOf(range.startContainer);
        const endPage = pageOf(range.endContainer);
        if (!startPage || !endPage || startPage === endPage) return;
        const spans = [...startPage.querySelectorAll<HTMLElement>('.rd-pdf-text span')].filter(
          (s) => (s.textContent ?? '').length > 0,
        );
        const last = spans[spans.length - 1];
        const node = last?.firstChild;
        if (!node) return;
        const next = document.createRange();
        try {
          next.setStart(range.startContainer, range.startOffset);
          next.setEnd(node, (node.textContent ?? '').length);
        } catch {
          return;
        }
        if (next.toString().length >= range.toString().length) return;
        sel.removeAllRanges();
        sel.addRange(next);
        console.debug(
          `[reader] 跨页夹取：${startPage.dataset.pageIndex}→${endPage.dataset.pageIndex} 页，${range.toString().length} → ${next.toString().length} 字`,
        );
      };

        /**
         * 划词**硬性禁止跨栏**（用户明确要求：不想要跨栏选择）。
         *
         * 为什么需要：文本层按阅读顺序排 DOM 后，浏览器按 DOM 顺序扩展选区 —— 横向拖过栏缝会把
         * "左栏剩余 + 整段中栏 + 右栏开头"连成一条横穿三栏的高亮带，而这三段在纸面上并不相邻。
         *
         * 栏带来自 **pdf.js 的文本项**（`columnBandsFromItems`，见 columnBands.ts）：DOM 里 span 的
         * x 投影会被左侧竖排页眉"桥接"（上一版就栽在这），而文本项自带字体方向与几何，
         * 能稳定切出 1/2/3 栏（已在 8 篇 CNKI 论文 111 页上验过：7 页多栏全对、104 页单栏无误切）。
         * 栏带按**页宽比例**存，抗缩放与手势 transform。
         */
        /**
         * @param force 强制重算：DOM 被 pdf.js 动过之后，当前选区可能已经被"整体重新解释"，
         *              锚点/焦点也不再可信 —— 这时用上一次夹取记下来的**栏号、方向、按下点文字节点**
         *              重算一遍，并且跳过"同栏就不动"的早退（这正是它平时要早退的那种情况）。
         */
        const clampToAnchorColumn = (force = false): boolean => {
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
          const range = sel.getRangeAt(0);
          const spanOf = (node: Node | null): HTMLElement | null => {
            const el = !node ? null : node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
            return (el?.closest?.('.rd-pdf-text span') as HTMLElement | null) ?? null;
          };
          /**
           * 必须用 `sel.anchorNode`（**按下点**）而不是 `range.startContainer`：
           * range 的 start/end 是按 DOM 顺序归一化过的，反方向拖（从右栏往左拖）时会被对调，
           * 于是"锚点栏"会算成指针那一栏，夹取反而把选区锁到了错误的一栏。
           * 强制重算时优先用上次记下的那个按下点节点（DOM 变动后 `sel.anchorNode` 可能已落到容器上）。
           */
          const anchorSpan =
            spanOf(sel.anchorNode) ??
            (force && anchorNodeRef && document.contains(anchorNodeRef) ? spanOf(anchorNodeRef) : null);
          if (!anchorSpan) return false; // 连按下点都定不到 span：交给 fixContainerBoundary
          /**
           * 焦点**可能不在任何 span 上**：横向拖过栏缝时，浏览器的选区扩展会按 DOM 顺序一路吃到
           * 文本层容器（实测样本文献 A（双栏）p4：`sel.focusNode` 就是 `DIV.rd-pdf-text`，于是这里
           * 直接 return false，1820 字横跨两栏的选区原样留着）。
           * 所以焦点定不到 span 时**也算跨栏**，按指针位置决定夹到本栏的哪一端。
           */
          const focusSpan = spanOf(sel.focusNode);
          const page = anchorSpan.closest('.rd-pdf-page') as HTMLElement | null;
          if (!page) return false;
          if (focusSpan && focusSpan.closest('.rd-pdf-page') !== page) return false; // 跨页：交给 clampCrossPage
          // data-page-index 就是**1 基的页码**（= PdfPage 的 pageNumber，handleBands 也是按它存的），
          // 别再 +1：那会去取下一页的栏带。实测症状就是"夹取日志打了、选区却还横跨两栏"——
          // 拿错页的栏带会让跨栏的右端恰好落回锚点栏里，于是直接判定"没跨栏"而不夹。
          const pageNo = Number(page.dataset.pageIndex ?? '0');
          const bands = bandsByPageRef.current.get(pageNo);
          if (!bands || bands.length < 2) return false; // 单栏页面不用管
          const pageRect = page.getBoundingClientRect();
          if (pageRect.width <= 0) return false;
          const ratioOf = (span: HTMLElement): number => {
            const r = span.getBoundingClientRect();
            return (r.left + r.width / 2 - pageRect.left) / pageRect.width; // 0–1：抗缩放与 transform
          };
          const bandFor = (span: HTMLElement): number => {
            const x = ratioOf(span);
            const i = bandIndexOf(bands, x);
            return i >= 0 ? i : nearestBandIndexOf(bands, x);
          };
          const anchorBand = force && lockedBand >= 0 ? lockedBand : bandFor(anchorSpan);
          if (anchorBand < 0) return false;
          const focusBand = focusSpan ? bandFor(focusSpan) : -1;
          // 同栏的正常选区不动它（**强制重算时例外**：DOM 变动后它"看起来同栏"正是被重新解释的结果）；
          // 焦点定不到 span（容器）时按"跨栏"处理
          if (!force && focusSpan && focusBand === anchorBand) return false;
          const spans = [...page.querySelectorAll<HTMLElement>('.rd-pdf-text span')].filter(
            (s) => (s.textContent ?? '').trim().length > 0,
          );
          // 本栏的 span 用**严格判定**（中心点确实落在锚点栏里），别用"最近栏"兜底，
          // 否则栏缝外那一列的第一个 span 会被算进来，夹取结果会多出半栏。
          const inAnchor = spans.filter((s) => bandIndexOf(bands, ratioOf(s)) === anchorBand);
          if (!inAnchor.length) return false;
          // 往前拖（按下点在前）夹到本栏末尾，往回拖夹到本栏开头；焦点不在 span 上时用指针 x 判方向。
          // 强制重算时用上次记下的方向（DOM 变动后 compareDocumentPosition 已经不可信）。
          const anchorRect = anchorSpan.getBoundingClientRect();
          const forward =
            force && lockedForward !== null
              ? lockedForward
              : focusSpan
                ? !!(anchorSpan.compareDocumentPosition(focusSpan) & Node.DOCUMENT_POSITION_FOLLOWING)
                : pointerRef.x >= anchorRect.left + anchorRect.width / 2;
          const build = (aNode: Node, aOff: number, bNode: Node, bOff: number): Range | null => {
            const r = document.createRange();
            try {
              r.setStart(aNode, aOff);
              r.setEnd(bNode, bOff);
              return r;
            } catch {
              return null;
            }
          };
          /**
           * 取"本栏末尾/开头"这一步**不能按 DOM 顺序取**（老写法用 inAnchor[last]）。
           *
           * 真实反例（样本文献 A（双栏）p4）：该页文本层带 .markedContent 嵌套，`reorderTextLayer`
           * 的保守分支不会重排，于是 **DOM 顺序 ≠ 阅读顺序** —— DOM 里最后一个"属于左栏"的 span
           * 在纸面上靠近页面末尾，[按下点 → 它] 的区间直接把整页包进来（实测 1820 字、x 138~945，
           * 看着像没夹，其实是"夹歪了"）。
           *
           * 所以改成：按**几何**挑（往前拖取本栏最靠下、往回拖取最靠上），并且只在本轮选区**之内**挑，
           * 保证结果一定不比原来长；逐个候选试，第一个"更短且非空"的采用。
           */
          const edgeY = (el: HTMLElement): number => {
            const r = el.getBoundingClientRect();
            // 升序排：往前拖要"本栏最靠下"的排最前（取负），往回拖要"最靠上"的排最前
            return forward ? -r.bottom : r.top;
          };
          /**
           * 候选端点 = **本栏的所有 span**（不限于当前选区之内）。
           *
           * 为什么不能只看"当前选区里"的 span：浏览器按 DOM 顺序扩展，跨栏那一拖的选区可能很短
           * （实测样本文献 A p4：重排后焦点恰好挨着锚点，原生选区只有 5 字），于是候选寥寥、夹出来还是 5 字。
           * 而"往前拖到本栏末尾"本来就是要**延伸到本栏末尾**的语义 —— 安全性由下面
           * `rectsInAnchorBand`（每一段都必须整段在本栏内）保证，不靠"不许变长"。
           */
          const candidates = inAnchor.slice().sort((p, q) => edgeY(p) - edgeY(q));
          /** 这个 range 的每一段是否都**整段**落在锚点栏里（用 rect 的两端判栏，不是只看中心） */
          const rectsInAnchorBand = (r: Range): boolean => {
            const band = bands[anchorBand];
            if (!band) return false;
            let rects: DOMRect[];
            try {
              rects = [...r.getClientRects()];
            } catch {
              return false;
            }
            if (!rects.length) return false;
            const pad = pageRect.width * 0.01; // 1% 容差：字距/抗锯齿的零点几像素别误杀
            const lo = band.start * pageRect.width - pad;
            const hi = band.end * pageRect.width + pad;
            let aRects: DOMRect[] = [];
            try {
              aRects = [...anchorSpan.getClientRects()];
            } catch {
              aRects = [];
            }
            return rects.every((x) => {
              const l = x.left - pageRect.left;
              const rr = x.right - pageRect.left;
              if (l >= lo && rr <= hi) return true;
              /**
               * 唯一的例外：**按下点自己那一行**的 rect（就是 anchorSpan 自己的 client rect）。
               * 用户按在这行上，任何选区都必然包含它；这行若伸出栏带（真实页面上不少，比如横跨
               * 栏缝的公告行），严格判定会让**所有**候选都过不了 → 一个都不夹 → 跨栏选区原样留下
               * （实测样本文献 A p4 反向 650 字横跨整页）。
               * 必须按 rect 精确比对，不能只判"与锚点 rect 相交"：pdf.js 的 span 有时很高，
               * 那样等于给整页开了后门（183/184 个候选全过、最佳 650 字还是横跨整页）。
               */
              return aRects.some(
                (a) => Math.abs(a.left - x.left) < 2 && Math.abs(a.right - x.right) < 2 && Math.abs(a.top - x.top) < 4,
              );
            });
          };
          const before = range.toString();
          let bestRange: Range | null = null;
          let bestLen = -1;
          let tried = 0;
          let passed = 0;
          const buildFromAnchor = (node: Node | null, off: number): Range | null => {
            if (!node) return null;
            /**
             * 按下点那一端**只用 span 自己的文字节点**定位（按指针在 span 里的左右半边决定取头还是取尾）。
             *
             * 为什么不用 `sel.anchorNode/anchorOffset`：夹取是在松手后 ~0.4 秒才跑的，
             * 那时浏览器（和 pdf.js 自己的选区修正）可能已经把锚点解析到了**容器级节点**上；
             * 容器级的边界点极其脆弱 —— pdf.js 会在选区变化时移动 `.endOfContent`、给文本层
             * 加/去 `selecting` 类，这些都是容器子节点的增删，会让"同一对边界点"圈住的内容整体改变，
             * 而浏览器**不会**为这种变化补发 `selectionchange`（看护逻辑因此完全没机会纠正）。
             * 实测：夹取刚把选区锁成右栏 650 字 x590~997，16ms 后同一对边界点变成横跨整页 x1~1147。
             * 换成 span 内部的文字节点后，pdf.js 动它自己的节点就影响不到我们的区间了。
             */
            const tn = [...anchorSpan.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) ?? null;
            if (!tn) return null;
            const r = anchorSpan.getBoundingClientRect();
            const aOff = pointerRef.x >= r.left + r.width / 2 ? (tn.textContent ?? '').length : 0;
            return (
              [build(tn, aOff, node, off), build(node, off, tn, aOff)].find(
                (x): x is Range => !!x && !x.collapsed,
              ) ?? null
            );
          };
          for (const cand of candidates) {
            const node = cand.firstChild;
            if (!node) continue;
            const offset = forward ? (node.textContent ?? '').length : 0;
            const r = buildFromAnchor(node, offset);
            if (!r) continue;
            tried += 1;
            // **硬条件**：每一段都得整段留在锚点栏里（这就是"不许跨栏"的保证）
            if (!rectsInAnchorBand(r)) continue;
            passed += 1;
            const len = r.toString().length;
            // 在"不出栏"的候选里挑**最长**的：往前拖就一路夹到本栏末尾。
            // 这里**不做"只在变短时替换"**：重排之后 DOM = 阅读顺序，夹到本栏末尾天然是连续区间；
            // 而"只在变短时"会让"浏览器恰好只选了几个字"的情况下完全夹不动（实测样本文献 A p4 卡在 5 字）。
            if (len > bestLen) {
              bestRange = r;
              bestLen = len;
            }
          }
          if (!bestRange) {
            /**
             * 兜底：一整个候选都过不了"整段在本栏内"时（真实页面上方常有横跨栏缝的公告块/图注，
             * 反向拖的范围必然穿过它们），退到**锚点自己那个 span 的边界**——
             * 它一定在本栏内、也一定不会跨栏。宁可只夹出几个字，也绝不让跨栏选区留下。
             */
            const node = anchorSpan.firstChild;
            const r = buildFromAnchor(node, forward ? ((node?.textContent ?? '').length ?? 0) : 0);
            if (r && rectsInAnchorBand(r)) bestRange = r;
          }
          const fixed = bestRange;
          // 连兜底都过不了就不动手（宁可不夹，也绝不产出跨栏选区）
          if (!fixed) return false;
          if (fixed.toString() === before) return false;
          sel.removeAllRanges();
          sel.addRange(fixed);
          // 记下"这次夹到哪一栏、哪个方向、按下点是哪个文字节点"：DOM 被 pdf.js 动过之后，
          // 这些是唯一还可信的东西（强制重算要用，见 watchLayer）。
          lockedBand = anchorBand;
          lockedForward = forward;
          anchorNodeRef = anchorSpan.firstChild ?? null;
          console.debug(`[reader] 选区跨栏，已夹回按下时所在那一栏（第 ${pageNo} 页共 ${bands.length} 栏）`);
          return true;
        };

      let collectTimer = 0;
      /** 鼠标是否按着（拖动期间一律不干预、也不弹工具条——老实现只在松手时收集） */
      let pressed = false;
      /**
       * 松手瞬间算出的"正确选区"，在看护窗口内锁住。
       *
       * 为什么需要锁：浏览器会把**排队的 mousemove 在 mouseup 之后才应用完**，
       * 于是松手后选区还会被它改写一次（实测 27 字 → 296 字，又变回"从页首连到按下行"）。
       * 一次性修不住，得在随后 ~0.7 秒里"它改一次、我锁回一次"。
       */
      let lockedRange: Range | null = null;
      let guardUntil = 0;
      /** 看护窗口内的主动重锁定时器（见 armLock：有些改写不发 selectionchange） */
      let relockTimer = 0;
      /** 本次跨栏夹取记住的"锚点栏 / 方向 / 按下点文字节点"（强制重算用，见 watchLayer） */
      let lockedBand = -1;
      let lockedForward: boolean | null = null;
      let anchorNodeRef: Node | null = null;
      /**
       * 当前这次看护是不是"跨栏夹取"的结果。
       * 只有它才允许走**强制重算**：正常同栏选区的顺序/长度都是浏览器原生给的，
       * 绝不能因为页面里任何一次 DOM 变动就把它重算成"整栏"（那会把 45 条手感用例全带崩）。
       */
      let columnClamped = false;
      /** 看护窗口内的文本层变动监听（pdf.js 会动 `.endOfContent`、加/去 `selecting`） */
      let layerObserver: MutationObserver | null = null;
      /** 强制重算次数上限：防止"回夹 → 又变动 → 再回夹"互相触发成环 */
      let forcedReclamps = 0;
      const MAX_FORCED_RECLAMPS = 20;
      /**
       * 本次划词的看护上限。跨栏夹取成功后会把看护往后延（见 armLock），但不能无限延
       * —— 否则用户下一次点击之前一直锁着。2.5 秒足够覆盖浏览器把排队的 mousemove 应用完。
       */
      let lockDeadline = 0;

      /** 结束看护：定时器、变动监听、记住的锚点信息一起清掉 */
      const stopGuard = (): void => {
        if (relockTimer) {
          window.clearInterval(relockTimer);
          relockTimer = 0;
        }
        layerObserver?.disconnect();
        layerObserver = null;
        lockedRange = null;
        lockedBand = -1;
        lockedForward = null;
        anchorNodeRef = null;
        columnClamped = false;
      };

      /**
       * 看护窗口内盯住文本层的子节点变动。
       *
       * 为什么非要有它：pdf.js 自己会在选区变化时搬 `.endOfContent`、给文本层加/去 `selecting` 类，
       * 这些容器子节点的增删会让"同一对边界点"圈住的**内容整体改变**，而 Chromium **不会**补发
       * `selectionchange`（实测：夹取刚锁成右栏 650 字 x590~997，16ms 后同一段变成横跨整页
       * x1~1147，整条时间线里一条 selectionchange 都没有）。事件驱动与"套回旧边界点"都救不回来
       * （`cloneRange()` 只存边界点，会被同样地重新解释），所以一检测到变动就**按几何强制重算**。
       */
      const watchLayer = (): void => {
        if (layerObserver) return;
        // 盯住"按下点所在的那个文本层"（拿不到就退到滚动容器里的第一个）
        const ref = anchorNodeRef;
        const el = !ref ? null : ref.nodeType === Node.ELEMENT_NODE ? (ref as HTMLElement) : ref.parentElement;
        const host =
          (el?.closest?.('.rd-pdf-text') as HTMLElement | null) ??
          scrollRef.current?.querySelector<HTMLElement>('.rd-pdf-text') ??
          null;
        if (!host) return;
        layerObserver = new MutationObserver(() => {
          if (!lockedRange || Date.now() > guardUntil) {
            stopGuard();
            return;
          }
          if (forcedReclamps >= MAX_FORCED_RECLAMPS) {
            layerObserver?.disconnect();
            layerObserver = null;
            return;
          }
          forcedReclamps += 1;
          // 正常同栏选区：只套旧区间，绝不重算（见 columnClamped 的说明）
          if (!columnClamped) {
            applyLocked();
            parkEndOfContent();
            return;
          }
          // 跨栏夹取的结果：先试"强制重算"（绕过"同栏就不动"的早退）；算不出来才退回套旧区间
          if (clampToAnchorColumn(true)) {
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && sel.rangeCount) {
              armLock(sel.getRangeAt(0), Math.max(200, lockDeadline - Date.now()));
            }
            parkEndOfContent(); // pdf.js 刚把整页大小的 .endOfContent 插进选区 → 挪回末尾
            console.debug(
              `[reader] 文本层被改动过，已按几何重夹回按下那一栏（本次第 ${forcedReclamps} 次）`,
            );
            return;
          }
          applyLocked();
          parkEndOfContent();
        });
        layerObserver.observe(host, { childList: true, subtree: true });
      };

      /**
       * 把 pdf.js 的 `.endOfContent` 挪回文本层末尾。
       *
       * 这是**最后一块拼图**：pdf.js 在每次 `selectionchange` 里会
       * （`pdf_viewer.mjs` 的 `#enableGlobalSelectionListener`）把 `.endOfContent`
       * `insertBefore` 到**选区锚点旁边**，并把它的宽高设成**整个文本层的宽高** ——
       * 于是一个"整页大小"的块被塞进了我们的区间里：选区的**文字一个没变**，
       * `getClientRects()` 却多出一条横贯整页的矩形（实测右栏 650 字 x0.514~0.869
       * 变成 x0.001~0.999），批注矩形、工具条定位、验收判据全被这条幽灵矩形污染。
       * 我们自己重新设选区又会触发它再插一次 —— 这也是"夹取日志打了、量到还是跨栏"的真正原因。
       *
       * pdf.js 自己的 `reset()`（pointerup/blur 时）就是 `textLayer.append(end)`，
       * 所以放回末尾=回到它的规范位置，不影响它的"拖到页尾"逻辑（下一次拖动它会自己再插）。
       */
      const parkEndOfContent = (): void => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        const layers = scrollRef.current?.querySelectorAll<HTMLElement>('.rd-pdf-text');
        if (!layers) return;
        for (const layer of layers) {
          let inRange = false;
          try {
            inRange = range.intersectsNode(layer);
          } catch {
            continue;
          }
          if (!inRange) continue;
          const end = layer.querySelector<HTMLElement>('.endOfContent');
          if (!end) continue;
          /**
           * 必须**照着 pdf.js 自己的 reset() 清掉行内宽高**（`end.style.width/height = ""`）：
           * pdf.js 在选中期间会把它的宽高设成**整个文本层那么大**；只把它挪到末尾、不清尺寸，
           * 它就是一个盖住整页的可选中块 —— 下一次按下会落在它身上，拖出来是**塌陷选区**
           * （实测样本文献 A p4 正向：全新实例、按下(417,665)→松手(895,699)，结果 0 字）。
           * 清掉后它回到 `inset:100% 0 0` 的零尺寸状态，既不撑大选区也不吃鼠标。
           */
          if (end !== layer.lastElementChild) layer.append(end);
          if (end.style.width || end.style.height) {
            end.style.width = '';
            end.style.height = '';
          }
          /**
           * 还要像 pdf.js 的 `reset()` 一样**摘掉 `selecting` 类**：CSS 里
           * `.rd-pdf-text.selecting .endOfContent { top: 0 }` 会把它从"文字下方零高度的一条"
           * 变成**盖住整页的可选中层**（实测夹取成功后它的 rect 是 `1,1,1147,1622`，整个文本层大小）。
           * 留着它，下一次在这个区域按下拖动就**选不中任何文字**（实测样本文献 A p4 正向：
           * 按住(417,665)一路拖到(895,699)，全程 0 字、松手塌陷在松手点）。
           * 摘掉类名即回到 pdf.js 的 idle 状态；它下一次拖动会自己再加回来。
           */
          layer.classList.remove('selecting');
        }
      };

      /** 锁住一个选区并顺延看护窗口（不超过 lockDeadline） */
      const armLock = (range: Range, ms: number): void => {
        lockedRange = range.cloneRange();
        guardUntil = Math.min(Date.now() + ms, lockDeadline || Date.now() + ms);        /**
         * 除了"它改一次我锁回一次"（selectionchange 驱动），还要**定时主动重锁**。
         *
         * 原因同上（有些改写不发 selectionchange）。定时重锁负责"套回旧区间"，
         * 变动监听负责"旧区间也失效时按几何重算"，两者互补。
         */
        watchLayer();
        if (relockTimer) return;
        relockTimer = window.setInterval(() => {
          if (Date.now() > guardUntil || !lockedRange) {
            stopGuard();
            return;
          }
          applyLocked();
          parkEndOfContent();
        }, 120);
      };

      /** 看护窗口内：把选区套回锁定的那个（锁失效则返回 false，交回正常流程） */
      const applyLocked = (): boolean => {
        if (!lockedRange) return false;
        if (!document.contains(lockedRange.startContainer) || !document.contains(lockedRange.endContainer)) {
          stopGuard(); // 边界节点已脱离文档：锁没意义了，定时器/监听一起收掉
          return false;
        }
        const sel = window.getSelection();
        if (!sel) return false;
        const cur = sel.rangeCount ? sel.getRangeAt(0) : null;
        /**
         * "已经是它了"必须**连几何一起比**，不能只比文字。
         *
         * 实测（样本文献 A p4 反向拖，锚点在右栏）：夹取选出的 650 字在右栏 x590~997，
         * 浏览器随后改写出的选区**正好也是 650 字**、却横跨整页 x1~1147 —— 只比 `toString()`
         * 就会判定"已经锁对了"，于是放着跨栏选区不管（日志里夹取打了、量到的还是跨栏）。
         */
        const sameAsLocked = (r: Range): boolean => {
          if (!lockedRange || r.toString() !== lockedRange.toString()) return false;
          const a = [...r.getClientRects()];
          const b = [...lockedRange.getClientRects()];
          if (a.length !== b.length) return false;
          if (!a.length) return true;
          return (
            Math.abs(a[0].left - b[0].left) < 2 &&
            Math.abs(a[0].top - b[0].top) < 2 &&
            Math.abs(a[a.length - 1].right - b[b.length - 1].right) < 2
          );
        };
        if (cur && !sel.isCollapsed && sameAsLocked(cur)) return false; // 已经是它了
        sel.removeAllRanges();
        sel.addRange(lockedRange);
        // 又被浏览器改了一次 → 看护再顺延一小段（实测松手后它会分批改写好几次）
        guardUntil = Math.min(Date.now() + 400, lockDeadline || Date.now() + 400);
        return true;
      };

      /**
       * 收尾：先修"边界落在容器上"的畸形选区，再夹跨页，最后收集（顺序不能反，后两步都读当前选区）。
       * 拖动期间直接返回：让浏览器原生表现（实测拖动中一直是正常的 2→18 字），
       * 松手后再纠正最后一次跳变。
       */
      const settle = (): void => {
        collectTimer = 0;
        if (pressed) return;
        if (lockedRange && Date.now() > guardUntil) stopGuard(); // 看护结束
        if (applyLocked()) {
          parkEndOfContent();
          return;
        }
        if (USE_OUR_SELECTION_FIX) {
          fixContainerBoundary();
          const clamped = ENABLE_COLUMN_LOCK ? clampToAnchorColumn() : false;
          clampCrossPage();
          // 跨栏夹取成功后重新锁住并顺延看护：浏览器把排队的 mousemove 应用完时会把选区再扩回去
          // （实测样本文献 A（双栏）p4：夹取日志打了，0.7 秒后量到的仍是横跨两栏的 1820 字）
          if (clamped) {
            const sel = window.getSelection();
            // 锁到"本次划词的看护上限"为止（不是固定 700ms）：浏览器把排队的 mousemove
            // 应用完可能比 1 秒还晚（实测样本文献 A p4 反向：1.5 秒时量到的仍是横跨整页的 650 字），
            // 锁太短就正好漏在窗口外。
            if (sel && !sel.isCollapsed && sel.rangeCount) {
              columnClamped = true; // 允许看护期内走强制重算（见 watchLayer）
              armLock(sel.getRangeAt(0), Math.max(700, lockDeadline - Date.now()));
            }
          }
          // pdf.js 会把整页大小的 `.endOfContent` 插到选区锚点旁边（见 parkEndOfContent），
          // 每轮收尾都要把它挪回末尾，否则选区的 rect 里永远横着一条整页矩形。
          parkEndOfContent();
        }
        collectSelection();
      };
      /** 合并短时间内的多次触发：selectionchange 在拖动中会刷屏，收一次就够 */
      const schedule = (delay = 0): void => {
        if (collectTimer) window.clearTimeout(collectTimer);
        collectTimer = window.setTimeout(settle, delay);
      };

      const onSelectionChange = (): void => {
        if (pressed) return; // 拖动中不收集：工具条不该在拖动过程中就冒出来（会挡文字、还可能抢走 mousemove）
        schedule(30);
      };

      /** 拖动中记录指针位置：修容器边界时要用（"离指针最近的那一行"） */
      const onMove = (ev: Event): void => {
        const me = ev as MouseEvent;
        if (me.clientX || me.clientY) {
          pointerRef.x = me.clientX;
          pointerRef.y = me.clientY;
        }
      };

      const onUp = (ev: Event): void => {
        const me = ev as MouseEvent;
        const target = ev.target as Node | null;
        if (!target || !scrollRef.current?.contains(target)) return;
        if (typeof me.button === 'number' && me.button !== 0) return; // 右键/中键不参与划词收尾
        onMove(ev);
        pressed = false;
        // 没有选中文字时，先看是不是点在已有批注上（点批注打开卡片）
        const pageEl = (target as HTMLElement).closest?.('.rd-pdf-page') as HTMLElement | null;
        if (pageEl) {
          const selBefore = window.getSelection();
          const hasText = !!selBefore && !selBefore.isCollapsed && selBefore.toString().trim().length > 0;
          if (!hasText) {
            const ann = hitTestAnnotation(pageEl, me.clientX ?? 0, me.clientY ?? 0);
            if (ann) {
              onSelectAnnotationRef.current(ann, pageEl.getBoundingClientRect());
              return;
            }
          }
        }
        // 松手：先纠正一次（若启用手写纠正），再把结果锁住看护，并立刻收集（工具条在松手时才弹）
        stopGuard();
        forcedReclamps = 0;
        lockDeadline = Date.now() + 2500; // 本次划词的看护上限（跨栏夹取会用到）
        let clampedAtUp = false;
        if (USE_OUR_SELECTION_FIX) {
          fixContainerBoundary();
          clampedAtUp = ENABLE_COLUMN_LOCK ? clampToAnchorColumn() : false;
          clampCrossPage();
        }
        const selAtUp = window.getSelection();
        if (selAtUp && !selAtUp.isCollapsed && selAtUp.rangeCount) {
          // 跨栏夹取成功 → 守到"看护上限"（浏览器还会把排队的 mousemove 分批应用完，
          // 实测能晚到 1.5 秒之后；只守 0.7/1.5 秒会正好漏掉那一批）
          if (clampedAtUp) columnClamped = true; // 允许看护期内走强制重算（见 watchLayer）
          armLock(selAtUp.getRangeAt(0), clampedAtUp ? Math.max(900, lockDeadline - Date.now()) : 700);
        } else {
          guardUntil = Date.now() + 700;
        }
        collectSelection();
        schedule(60);
      };

      const onDown = (ev: Event): void => {
        const me = ev as MouseEvent;
        const target = ev.target as HTMLElement | null;
        /**
         * 右键：**只阻止焦点转移，不动选区**。
         *
         * 官方 TextLayerBuilder 给文本层 div 设了 `tabIndex = 0`（为了键盘可达性），
         * 于是右键按下会把焦点移到那一层上、浏览器顺手把选区清掉 —— 表现就是
         * "右键菜单里没有高亮/复制这些依赖选区的项"（UX 回归实测 6 字 → 0 字）。
         * 在 mousedown 上 preventDefault 能挡住焦点转移，而且不影响 contextmenu 照常弹出。
         */
        if (me.button === 2) {
          ev.preventDefault();
          // 右键别把"最后一次真实选区"弄丢：还有选区就刷新，已经没了就保留上一次的结果，
          // 菜单据此仍能给出标注项（见 lastTextRef 的说明）。
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && sel.toString().trim()) collectSelection();
          return;
        }
        if (me.button !== 0) return; // 中键等一律不参与划词
        onMove(ev);
        pressed = true;
        stopGuard();
        guardUntil = 0;
        lockDeadline = 0; // 新的一次按下：之前的看护全部作废
        // 点在文字层之外（画布/页边空白）：浏览器会清掉选区，等它清完再收一次，工具条跟着消失
        if (!target?.closest?.('.rd-pdf-text')) window.setTimeout(() => schedule(0), 0);
      };

      const onKeyUp = (ev: Event): void => {
        const ke = ev as KeyboardEvent;
        if (ke.shiftKey || ke.key === 'Shift' || ke.key.startsWith('Arrow')) schedule(10);
      };

      /**
       * 双保险：绝不让 Chromium 在 PDF 文本上启动原生拖拽。
       * 一旦启动 drag-and-drop，**mouseup 就不再派发**，选区收尾/工具条/批注全跟着失效。
       * （CSS 里已有 `-webkit-user-drag: none`，这里再兜一层。）
       */
      const onDragStart = (ev: Event): void => {
        if ((ev.target as HTMLElement | null)?.closest?.('.rd-pdf-page')) ev.preventDefault();
      };

      const root: EventTarget = scrollRef.current?.parentElement ?? document;
      document.addEventListener('selectionchange', onSelectionChange);
      root.addEventListener('mouseup', onUp, true);
      root.addEventListener('mousedown', onDown, true);
      root.addEventListener('mousemove', onMove);
      root.addEventListener('keyup', onKeyUp);
      root.addEventListener('dragstart', onDragStart, true);
      return () => {
        if (collectTimer) window.clearTimeout(collectTimer);
        document.removeEventListener('selectionchange', onSelectionChange);
        root.removeEventListener('mouseup', onUp, true);
        root.removeEventListener('mousedown', onDown, true);
        root.removeEventListener('mousemove', onMove);
        root.removeEventListener('keyup', onKeyUp);
        root.removeEventListener('dragstart', onDragStart, true);
      };
      // 依赖只放 collectSelection（它身份稳定）；不要把 onSelection 放进来——
      // 父级每次渲染都传新函数，会导致 effect 反复重订阅（历史 bug：拖完选不中字、工具条不弹）。
    }, [collectSelection]);

  // ---------------------------------------------------------------- 右键菜单

  const ctxCbRef = useRef(onContextCommand);
  ctxCbRef.current = onContextCommand;
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: PageContextMenuItem[] } | null>(null);

  /** 菜单内容按"有没有选区"分：有选区给标注+复制，没选区给视图/书签/整篇引用 */
  const buildContextItems = useCallback((text: string): PageContextMenuItem[] => {
    if (text) {
      return [
        { label: '高亮', hint: '选中后按 1', command: { kind: 'annotate', type: 'highlight' } },
        { label: '下划线', hint: '选中后按 2', command: { kind: 'annotate', type: 'underline' } },
        { label: '波浪线', hint: '选中后按 3', command: { kind: 'annotate', type: 'squiggly' } },
        { label: '删除线', hint: '选中后按 4', command: { kind: 'annotate', type: 'strikeout' } },
        { label: '复制', hint: 'Ctrl/⌘ + C', separatorBefore: true, command: { kind: 'copy-selection' } },
        { label: '复制引用（选区 + 题录）', command: { kind: 'copy-selection-with-citation' } },
        { label: '在文内搜索', hint: 'Ctrl/⌘ + F', command: { kind: 'search-selection', text } },
      ];
    }
    return [
      { label: '适应宽度', hint: 'Ctrl/⌘ + 0', command: { kind: 'fit', mode: 'fit-width' } },
      { label: '适应页面', command: { kind: 'fit', mode: 'fit-page' } },
      { label: '加书签', separatorBefore: true, command: { kind: 'bookmark' } },
      { label: '复制引用（整篇文献）', command: { kind: 'copy-citation' } },
    ];
  }, []);

  /**
   * 页面上的右键菜单：只在 `.rd-pdf-page` 上接管并 preventDefault，
   * 不改动当前选区、也不触发划词收集（选区完全交给浏览器原生，见上面的划词 effect）。
   * 菜单自己不知道"怎么执行"，命令一律通过 onContextCommand 回调出去。
   */
  useEffect(() => {
    const root: EventTarget = scrollRef.current?.parentElement ?? document;
    const onContextMenu = (ev: Event) => {
      const me = ev as MouseEvent;
      const target = me.target as HTMLElement | null;
      const pageEl = target?.closest?.('.rd-pdf-page') as HTMLElement | null;
      if (!pageEl) return;
      ev.preventDefault();
      const sel = window.getSelection();
      const live = sel && !sel.isCollapsed ? sel.toString() : '';
      const text = (live || lastSelectionRef.current?.text || '').trim();
      setCtxMenu({ x: me.clientX, y: me.clientY, items: buildContextItems(text) });
    };
    root.addEventListener('contextmenu', onContextMenu);
    return () => root.removeEventListener('contextmenu', onContextMenu);
  }, [buildContextItems]);

  // 缩放变化 / 换页 / 换文档后，菜单里的坐标与语义都变了，直接关掉
  useEffect(() => {
    setCtxMenu(null);
  }, [uniformScale, layout, doc, item.id, currentPage]);

  // 清理：卸载时把地图与元素表清空（避免持有已卸载 DOM）
  useEffect(() => {
    return () => {
      pageEls.current.clear();
      mapsRef.current.clear();
      layersRef.current.clear();
    };
  }, []);

  if (!doc) return null;

  const totalReady = sizesReady || total <= 40;

  return (
    <div className={`rd-pdf-stage ${degradedWorker ? 'is-degraded' : ''}`}>
      {loading ? <div className="rd-loadbar" style={{ width: `${Math.max(8, Math.min(100, loadProgress))}%` }} /> : null}
      <div
        className={`rd-pdf-scroll is-${layout}`}
        ref={scrollRef}
        tabIndex={-1}
        onDoubleClick={() => onZoom(-1)}
      >
        {!totalReady ? (
          <div className="rd-stage-center">
            <div className="rd-loading-card">
              <div className="rd-spinner" />
              <div className="rd-loading-title">正在排版文档…</div>
              <div className="rd-loading-sub">
                {sizes.length} / {total} 页
              </div>
              <div className="rd-progress">
                <i style={{ width: `${total ? Math.round((sizes.length / total) * 100) : 0}%` }} />
              </div>
            </div>
          </div>
        ) : layout === 'continuous' ? (
          pageSizes.map((size, index) => {
            const pageNumber = index + 1;
            const scale = layoutComputed.scales[index] ?? uniformScale;
            const width = size.width * scale;
            const height = size.height * scale;
            const active = renderSet.has(pageNumber);
            return (
              <div
                key={`${pageNumber}:${stuckRef.current.get(pageNumber) ?? 0}`}
                className="rd-page-slot"
                data-page-index={pageNumber - 1}
                style={{ width: `${width}px`, height: `${height}px` }}
              >
                {active ? (
                  <PdfPage
                    doc={doc}
                    pageNumber={pageNumber}
                    onStuck={onStuck}
                    width={width}
                    height={height}
                    scale={scale}
                    dpr={dprLive}
                    className=""
                    annotations={annotations}
                    onSelectAnnotation={onSelectAnnotation}
                    flashId={flashId}
                    onVisible={onVisible}
                    onMap={onMap}
                    onDropMap={onDropMap}
                    registerSearchLayer={registerSearchLayer}
                    strips={stripsByPage.get(pageNumber) ?? null}
                    activeOffset={searchOffsetOf(pageNumber)}
                    onFirstPaint={pageNumber === 1 ? onFirstPaint : undefined}
                    onPageElement={onPageElement}
                    goToPage={goToPage}
                    onBands={handleBands}
                  />
                ) : (
                  <div className="rd-page-ghost" data-page-index={pageNumber} aria-hidden />
                )}
              </div>
            );
          })
        ) : (
          <div className="rd-pages-row">
            {[...renderSet]
              .sort((a, b) => a - b)
              .map((pageNumber) => {
                const size = pageSizes[pageNumber - 1] ?? base;
                const scale = layoutComputed.scales[pageNumber - 1] ?? uniformScale;
                return (
                  <PdfPage
                    key={`${pageNumber}:${stuckRef.current.get(pageNumber) ?? 0}`}
                    doc={doc}
                    pageNumber={pageNumber}
                    width={size.width * scale}
                    height={size.height * scale}
                    scale={scale}
                    dpr={dprLive}
                    className={pageNumber === currentPage ? 'is-current' : 'is-adjacent'}
                    annotations={annotations}
                    onSelectAnnotation={onSelectAnnotation}
                    flashId={flashId}
                    onVisible={onVisible}
                    onMap={onMap}
                    onDropMap={onDropMap}
                    registerSearchLayer={registerSearchLayer}
                    strips={stripsByPage.get(pageNumber) ?? null}
                    activeOffset={searchOffsetOf(pageNumber)}
                    onFirstPaint={pageNumber === 1 ? onFirstPaint : undefined}
                    onPageElement={onPageElement}
                    goToPage={goToPage}
                    onBands={handleBands}
                  />
                );
              })}
          </div>
        )}
      </div>
      {ctxMenu ? (
        <PageContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.items}
          onPick={(cmd, at) => {
            setCtxMenu(null);
            ctxCbRef.current?.(cmd, at);
          }}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}
      {degradedWorker ? (
        <div className="rd-notice">PDF worker 未能加载，已切到主线程渲染（大文件会更慢）。</div>
      ) : null}
      <span className="rd-sr-only" aria-live="polite">
        第 {currentPage} / {total} 页
      </span>
    </div>
  );
});

/** 无文本层时的兜底 anchor */
function buildAnchorFallback(text: string, pageText: string): { prefix: string; suffix: string; occurrence: number } {
  const at = pageText.indexOf(text);
  if (at < 0) return { prefix: '', suffix: '', occurrence: 1 };
  return {
    prefix: pageText.slice(Math.max(0, at - 32), at).trim(),
    suffix: pageText.slice(at + text.length, at + text.length + 32).trim(),
    occurrence: 1,
  };
}

function relRects(
  rects: { left: number; top: number; right: number; width: number; height: number }[],
  pageRect: DOMRect,
): AnnotationRect[] {
  const out: AnnotationRect[] = [];
  for (const r of rects) {
    if (r.width <= 0.5 || r.height <= 0.5) continue;
    // 丢掉"不可能是文字行"的矩形：官方 TextLayerBuilder 的 .endOfContent（选中状态下会铺满整层）
    // 与容器边界都会被 Range.getClientRects() 报成整页高的框；混进批注里就会画出一整页高亮
    // （实测：反向拖选时出现过 1536px 高的框，而选区只有 27 字）。
    if (r.height > pageRect.height * 0.25 || r.width > pageRect.width * 1.05) continue;
    const rect: AnnotationRect = {
      x: (r.left - pageRect.left) / pageRect.width,
      y: (r.top - pageRect.top) / pageRect.height,
      w: r.width / pageRect.width,
      h: r.height / pageRect.height,
    };
    if (rect.x > 1.2 || rect.y > 1.2 || rect.x + rect.w < -0.2) continue;
    const existing = out.find(
      (e) => Math.abs(e.y - rect.y) < 0.002 && Math.abs(e.h - rect.h) < 0.004 && rect.x - (e.x + e.w) > -0.004 && rect.x - (e.x + e.w) < 0.012,
    );
    if (existing) {
      const right = Math.max(existing.x + existing.w, rect.x + rect.w);
      existing.x = Math.min(existing.x, rect.x);
      existing.w = right - existing.x;
      continue;
    }
    out.push(rect);
  }
  return out.slice(0, 64);
}

function clampRects(rects: AnnotationRect[]): AnnotationRect[] {
  return rects
    .map((r) => ({
      x: Math.min(1, Math.max(0, r.x)),
      y: Math.min(1, Math.max(0, r.y)),
      w: Math.min(1, Math.max(0, r.w)),
      h: Math.min(1, Math.max(0, r.h)),
    }))
    .filter((r) => r.w > 0.0005 && r.h > 0.0005);
}

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
import {
  bandIndexOf,
  columnBandsFromItems,
  columnRegionsFromItems,
  itemsInViewSpace,
  itemXRangesFromItems,
  nearestBandIndexOf,
  type BandRange,
} from './columnBands';
import { orderTextSpans } from './textOrder';
import { buildSelectionModel, SelectionModel } from './selectionModel';
import { createSelectionEngine, type EngineSelection, type PageHandle } from './selectionEngine';
import { createSelectionKernel, type KernelDeps } from './selectionKernel';
import type {
  DomSelectionEndpoint,
  PageCharModel,
  Rect,
  SelSnapshot,
  SelSnapshotInput,
  SelectionKernel,
} from './selectionTypes';
import { selectionDebugLog } from './selectionTypes';

/**
 * 页宽/页高**比例**坐标下的版式分区（0~1），供夹取与重排共用。
 *
 * 混排页（上整幅通栏摘要 + 下双栏正文）必须按 y 分区看：整页一套栏带会把本来就横跨整幅的
 * 摘要行判成"跨栏"，夹成碎块、重排还会把同一行拆到 DOM 的两头（用户看到的"零散蓝块"）。
 */
interface RegionRatio {
  top: number;
  bottom: number;
  /** 通栏区（区内一条栏带＝整幅内容宽）：既不夹取，也不按栏重排 */
  full: boolean;
  bands: { start: number; end: number }[];
  /** 重排时是否按本区的栏排序（整页模型多栏才为 true；单栏页保持老的 orderTextSpans 路径） */
  orderByBands?: boolean;
}

/**
 * 取文本项的参数与 TextLayerBuilder（`streamTextContent`）保持一致：文本层的 span 就是按这一份
 * 文本项一个一个建的，栏带与打标都要和它一一对应（不一致时 span 序号与文本项序号错位）。
 */
const TEXT_LAYER_PARAMS = { includeMarkedContent: true, disableNormalization: true } as const;

/** 某个 y 比例落在哪个分区；落在分区之间的缝隙时取最近的一个 */
function regionIndexAtY(regions: readonly RegionRatio[], y: number): number {
  if (!regions.length) return -1;
  for (let i = 0; i < regions.length; i += 1) {
    if (y >= regions[i].top && y < regions[i].bottom) return i;
  }
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < regions.length; i += 1) {
    const d = y < regions[i].top ? regions[i].top - y : y - regions[i].bottom;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}


/** 这一页是否值得按分区里的栏重排（只有"整页模型确实多栏"时才为 true） */
function hasMultiColumnRegion(regions: readonly RegionRatio[] | undefined): boolean {
  return !!regions?.some((r) => r.orderByBands && r.bands.length >= 2);
}


/**
 * 某个节点所在的页面元素（`.rd-pdf-page`）。
 *
 * 划词内核用它把 DOM 端点反查成页号：`data-page-index` 是 **1 起**的（模型是 0 起），
 * 这样内核不需要任何"页号 → 元素"的注册表，翻页、重建文本层、多页同时渲染都不会错位。
 */
function pageElementOf(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  return (el?.closest?.('.rd-pdf-page') as HTMLElement | null) ?? null;
}

/** 按模型页号（0 起）取页面元素 */
function pageElByIndex(pageIndex: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.rd-pdf-page[data-page-index="${pageIndex + 1}"]`);
}

/**
 * 取文本层里 **DOM 顺序**的全部文字 span —— 必须与 pdf.js 建 span 的规则同源，也必须与
 * `selectionModel.ts::collectTextSpans` 完全相同（顺序是"第 i 个字符 ↔ 第 i 个 span"的依据）：
 *   · 排除 `.markedContent` 容器 span（里面才装着真正的文字 span）；
 *   · **空串项的 span 也要留着**（pdf.js 对每个 `str !== undefined` 的项都建 span，空串只是没文字）
 *     —— 少一个就与文本项数量对不上，整页模型建不起来。
 */
function collectSpansInDomOrder(layer: HTMLElement): HTMLElement[] {
  return Array.from(layer.querySelectorAll<HTMLElement>('span:not(.markedContent)'));
}

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
 * 划词内核的诊断日志（`[zsel] …`）。
 *
 * 默认**关**：这套内核在正常选区上一个字节都不写 DOM，日志只在你排查"选区不对"时打开
 * （`console.debug` 在 DevTools 里默认折叠，但要先有 console 才看得到）。
 */
const SELECTION_DEBUG = false;

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
/* 划词已由 selectionEngine 接管：文本层**不再产生任何浏览器原生选区**。
   这是"终止两个选区互相打架"的关键一步 —— 关掉它，引擎的几何判据才说了算。 */
.rd-pdf-text, .rd-pdf-text * {
  user-select: none !important;
  -webkit-user-select: none !important;
}
.rd-pdf-text ::selection { background: transparent; }
/* 自绘高亮：一行一条（引擎按行合并后给出矩形）。
   颜色刻意和批注高亮区分：这里是"正在选的文字"，批注是"已经存下来的"。 */
.rd-sel-overlay .sel-line {
  background: rgba(0, 122, 255, 0.32);
  border-radius: 2px;
}
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
  onBands?: (page: number, regions: RegionRatio[]) => void;
  /**
   * 这一页的**划词字符模型**建好了，交给父级的划词内核（见 selectionKernel.ts）。
   * 传 null 表示这一页暂时没有可用模型（文本层没了 / 取不到文本项）→ 内核放弃纠正。
   */
  onSelectionModel?: (page: number, model: PageCharModel | null) => void;
  /**
   * 这一页的 DOM 就绪（页面元素 + 文本层），交给父级的**选取引擎**。
   * 引擎按几何命中，需要的正是这两块；传 null 表示这一页被卸载了。
   */
  onLayer?: (page: number, layer: { pageEl: HTMLElement; textLayer: HTMLElement } | null) => void;
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
    onSelectionModel,
    onLayer,
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
  const cbRef = useRef({ onMap, onDropMap, onFirstPaint, onStuck, onBands, onSelectionModel, onLayer });
  cbRef.current = { onMap, onDropMap, onFirstPaint, onStuck, onBands, onSelectionModel, onLayer };

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
        const content = await page.getTextContent(TEXT_LAYER_PARAMS);
        const viewport = page.getViewport({ scale: 1 });
        // pdf.js 的 items 里混有 TextMarkedContent（只有 type、没有几何），没有 str 的一律丢掉
        const textItems = itemsInViewSpace(content.items.filter((it) => 'str' in it), page.view);
        /**
         * 分区**始终**算（不再用"整页单栏"这种页面级结论关掉夹取 —— 有整幅图/图注/表格的页面上，
         * 图注/表格行会把栏缝覆盖统计压过、全局模型误判成 1 栏，夹取被整个关掉，于是正文里拖 2~3 行
         * 变成整页被选中）。
         *
         * 分工：
         *   · **夹取**用分区（锚点所在分区只有一条栏带 → 不夹；多栏 → 照旧硬性禁止跨栏）；
         *   · **重排**只在"整页模型确实多栏"时才接管（`orderBands`），单栏页继续走老的
         *     `orderTextSpans` —— 45 条手感里的"行间距拖 31 字""拖到空白 308 字"都依赖这条不变。
         */
        const orderBands = columnBandsFromItems(textItems as Parameters<typeof columnBandsFromItems>[0], {
          pageWidth: viewport.width,
          pageHeight: viewport.height,
          scale: 1,
          styles: content.styles,
        });
        const regions = columnRegionsFromItems(textItems as Parameters<typeof columnRegionsFromItems>[0], {
          pageWidth: viewport.width,
          pageHeight: viewport.height,
          scale: 1,
          styles: content.styles,
        });
        if (cancelled) return;
        if (!regions.length) {
          cbRef.current.onBands?.(pageNumber, []);
          return;
        }
        const rel: RegionRatio[] = regions.map((r) => ({
          top: r.top / viewport.height,
          bottom: r.bottom / viewport.height,
          full: r.full,
          bands: r.bands.map((b) => ({ start: b.start / viewport.width, end: b.end / viewport.width })),
          // 重排是否按"分区里的栏"排序：只有整页模型确实多栏时才接管（见上方注释）
          orderByBands: orderBands.length >= 2,
        }));
        console.debug(
          `[reader] 第 ${pageNumber} 页版式分区：${rel.length} 区 ` +
            rel
              .map(
                (r) =>
                  `${r.full ? '通栏' : `${r.bands.length}栏`}[y ${r.top.toFixed(2)}~${r.bottom.toFixed(2)}]${r.bands
                    .map((b) => `(${b.start.toFixed(2)}~${b.end.toFixed(2)})`)
                    .join('')}`,
              )
              .join(' '),
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
     * 把每个 span 与它的文本项横向范围绑在一起（写进 dataset，夹取时直接读）。
     *
     * pdf.js 对每个 `str` 非空的文本项恰好建一个 span，且按项序建（见 TextLayer#processItems / #appendText）；
     * 而 DOM 之后会被 reorderTextLayer 重排，所以**只能在第一次挂上、重排之前**按创建顺序打标，
     * 并用 `layer.dataset.spanGeom` 记住"已经打过"，重绘（update 路径）时不再按（已乱序的）DOM 重打。
     * 数量对不上就整层不打标——夹取会退回 DOM 判据，而不是按错位的映射去夹。
     */
    const tagTextSpans = (layer: HTMLElement, xs: readonly ({ x0: number; x1: number } | null)[]): void => {
      if (layer.dataset.spanGeom) return;
      layer.dataset.spanGeom = '1';
      const leaves = [...layer.querySelectorAll<HTMLElement>('span:not(.markedContent)')];
      if (!xs.length || leaves.length !== xs.length) {
        console.debug(`[reader] 第 ${pageNumber} 页 span 与文本项数量不一致（${leaves.length}/${xs.length}），不打横向标记`);
        return;
      }
      leaves.forEach((s, i) => {
        const g = xs[i];
        if (!g) return;
        s.dataset.x0 = String(g.x0);
        s.dataset.x1 = String(g.x1);
      });
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
    const reorderTextLayer = (container: HTMLElement, regions: RegionRatio[]): void => {
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
      /**
       * 按**分区**排序（混排页的关键）：`columnRegionsFromItems` 会把整幅通栏的标题/摘要/关键词
       * 划成"通栏区"，把正文划成"多栏区"。若整页一套栏带，通栏行会被三条栏带切成三截、DOM 里
       * 排到相隔几十个位置，选区一渲染就是零散碎块（用户截图那一片蓝块）。
       * 规则：分区（上→下）→ 区内（多栏区按栏、通栏/单栏区按行）→ top → left。
       */
      const useRegions = hasMultiColumnRegion(regions) && !!pageRect && pageRect.width > 0 && pageRect.height > 0;
      if (!useRegions && !sameParent) return; // wrapper + 没有可用分区：保持旧行为，别动 DOM
      let order: number[];
      if (useRegions && pageRect) {
        /**
         * R7：**视觉行分桶**（用户亲口要求"遇到数字和标点符号或者英文什么的，不要中断选取"）。
         *
         * 为什么必须做：人眼"同一行"的 span，y 中心可以差不少 —— 引文上标数字（`１１` `１２`）、
         * 行末被推进栏缝的标点、混排的西文 run。老排序键用的是 `(region, band, 原始 top)`：
         * 上标因为 y 略高就落进**相邻的行/分区桶**，在 DOM 里跑到几十个位置之外 →
         * DOM 顺序 ≠ 视觉顺序 → 原生拖选跨过这一行时会**跳过数字标点、把远处的字拼进来**
         * （实测苏敬勤 p2：23 字 / 34 rect / **行内断档=4**，慢拖快拖一致）。
         *
         * 做法：先按"竖直重叠"把 span 归到**视觉行**（行高 0.6 倍以内算同一行），
         * 然后 region 也用**这一行的 y** 去定（上标因此跟着它所属的那一行走），
         * 排序键变成 `(region, band, 行号, left)` —— DOM 顺序即视觉顺序。
         * 判据没有放宽：夹取那边一个字都没动。
         */
        const cyOf = (i: number): number => boxes[i].top + boxes[i].height / 2;
        const heightsSorted = boxes
          .map((b) => b.height)
          .filter((h) => h > 0)
          .sort((p, q) => p - q);
        const medH = heightsSorted.length ? heightsSorted[Math.floor(heightsSorted.length / 2)] : 10;
        const rowOf = new Array<number>(spans.length).fill(0);
        const rowCy: number[] = [];
        const rowN: number[] = [];
        for (const i of spans.map((_, idx) => idx).sort((a, b) => cyOf(a) - cyOf(b))) {
          const k = rowCy.length - 1;
          if (k >= 0 && Math.abs(cyOf(i) - rowCy[k]) <= medH * 0.6) {
            rowOf[i] = k;
            rowCy[k] = (rowCy[k] * rowN[k] + cyOf(i)) / (rowN[k] + 1);
            rowN[k] += 1;
          } else {
            rowOf[i] = rowCy.length;
            rowCy.push(cyOf(i));
            rowN.push(1);
          }
        }
        const keyOf = (i: number): [number, number, number, number] => {
          const k = rowOf[i];
          const cx = boxes[i].left + boxes[i].width / 2;
          const x = (cx - pageRect.left) / pageRect.width;
          // 分区用**这一行**的 y（不是这个 span 自己的 y）：上标跟它所属的行同区
          const yRow = (rowCy[k] - pageRect.top) / pageRect.height;
          const ri = regionIndexAtY(regions, yRow);
          const r = ri >= 0 ? regions[ri] : null;
          if (!r || r.bands.length < 2) {
            // 通栏区/单栏区：区内一律按行（行号→left），绝不按栏拆行
            return [ri < 0 ? regions.length : ri, 0, k, boxes[i].left];
          }
          const bi = bandIndexOf(r.bands, x);
          // 栏缝里的项（行末被推进栏缝的数字/标点）按**最近栏**归属，不再排到该区所有栏之后
          const bi2 = bi >= 0 ? bi : nearestBandIndexOf(r.bands, x);
          return [ri, bi2 >= 0 ? bi2 : r.bands.length, k, boxes[i].left];
        };
        const keys = spans.map((_, i) => keyOf(i));
        order = spans.map((_, i) => i).sort((p, q) => {
          const a = keys[p];
          const b = keys[q];
          return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
        });
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
          `${useRegions ? `，按 ${regions.length} 个版式分区` : ''}）`,
      );
    };

    /** 当前这页的文本层元素（由 TextLayerBuilder 创建，我们给它加了 rd-pdf-text 类名） */
    const textLayerEl = (): HTMLElement | null => textRef.current?.querySelector<HTMLElement>('.rd-pdf-text') ?? null;

    /**
     * 建这一页的**划词字符模型**并上报给父级的划词内核（见 selectionKernel.ts / selectionModel.ts）。
     *
     * 为什么要有这一层：产品的划词以前靠 DOM span 的 rect 猜"这个字属于哪一栏"，端点、span 序号、
     * 按下点三套坐标互相追着跑，越修越乱。Zotero 的做法是把一页文字变成**字符模型**，
     * 原生选区只提供两个端点，真正的选区在模型上算。模型必须建在"文本层挂好 + 重排完"之后，
     * 这样模型里的字符顺序与 DOM 里 span 的顺序一致，字符区间才能写回 DOM。
     *
     * 失败（取不到文本项 / span 与文本项逐字对不上）就上报 null：内核会放弃纠正，
     * 让浏览器的原生选区原样留着 —— 宁可不夹，也不乱夹。
     *
     * 这个函数建在 `paintTextLayer` **内部**，因为它必须拿到"这一次渲染实际用的"文本项、
     * viewport 与分区（分开取第二遍一旦参数不同就会出现 span 与文本项错位的老 bug）。
     */
    const reportSelectionModel = (
      layer: HTMLElement,
      page: pdfjsLib.PDFPageProxy,
      viewport: ReturnType<typeof page.getViewport>,
      items: readonly unknown[],
      regionList: readonly RegionRatio[],
    ): void => {
      const report = cbRef.current.onSelectionModel;
      if (!report) return;
      let model: PageCharModel | null = null;
      try {
        /**
         * ⚠️ **不要传 `spans`**：让模型构建器自己从 `textLayer` 里采（它按 pdf.js 的建 span 规则
         * 采"全部 `span:not(.markedContent)`"，**含空串项的 span**）。
         * 这里手写过滤条件的话，很容易过滤成"只留非空 span"，于是与"str 已定义的文本项"
         * 每页差几个 → 整页模型 null → 夹取从未运行（真实窗口实测：p2 是 1780 vs 1849）。
         */
        model = buildSelectionModel({
          pageIndex: pageNumber - 1,
          pageEl: rootRef.current ?? layer,
          textLayer: layer,
          items,
          viewport: {
            scale: viewport.scale,
            width: viewport.width,
            height: viewport.height,
            transform: viewport.transform as unknown as number[],
          },
          viewBox: page.view,
          regions: regionList.map((r) => ({ top: r.top, bottom: r.bottom, full: r.full, bands: r.bands })),
        });
      } catch (err) {
        if (!cancelled) console.warn(`[reader] 第 ${pageNumber} 页划词字符模型建失败`, err);
        model = null;
      }
      selectionDebugLog('上报划词模型', {
        page: pageNumber,
        model: model ? `${model.chars.length}字` : 'null',
        spans: layer.querySelectorAll('span:not(.markedContent)').length,
        items: items.length,
      });
      report(pageNumber, model);
      // 页面 DOM 就绪：把"页面元素 + 文本层"交给父级的选取引擎（引擎只按几何命中，不看 DOM 顺序）
      if (model) {
        const pageEl = rootRef.current;
        const textLayer = textLayerEl();
        if (pageEl && textLayer) cbRef.current.onLayer?.(pageNumber, { pageEl, textLayer });
      }
    };

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
       * 重排用的**版式分区**（页宽/页高比例 0~1）：来自 pdf.js 文本项，见 columnBands.ts。
       * 取文本项用的参数与 TextLayerBuilder 完全一致（TEXT_LAYER_PARAMS），两边的文本项才一一对应。
       * 拿不到就退化成"按行横跨"的旧排序——不会更糟。
       */
      let regions: RegionRatio[] = [];
      /** 每个 span（按文本项序）对应的文本项横向范围，页宽比例；拿不到就留空，夹取退回 DOM 判据 */
      let itemXs: ({ x0: number; x1: number } | null)[] = [];
      /**
       * 这一轮拿到的原始文本项：**建划词字符模型要用同一份**（同一份文本项、同一个顺序，
       * 模型与 DOM 才能逐字对齐；分开取两次一旦参数不同就会出现"1438 vs 1392"那种错位）。
       */
      let rawItems: unknown[] = [];
      try {
        const content = await page.getTextContent(TEXT_LAYER_PARAMS);
        rawItems = content.items;
        const items = itemsInViewSpace(content.items.filter((it) => 'str' in it), page.view);
        const unscaledW = viewport.width / viewport.scale;
        const unscaledH = viewport.height / viewport.scale;
        // pdf.js 只给 str 非空的项挂 span（见 TextLayer 的 #appendText：hasText 为假不入 DOM），打标与之对齐
        const drawn = items.filter((it) => (it.str ?? '') !== '');
        itemXs = itemXRangesFromItems(drawn).map((g) => (g ? { x0: g.x0 / unscaledW, x1: g.x1 / unscaledW } : null));
        // 分区照算（夹取用）；重排是否按栏排序看整页模型是否多栏（见 reorderTextLayer 的门）
        const orderBands = columnBandsFromItems(items as Parameters<typeof columnBandsFromItems>[0], {
          pageWidth: unscaledW,
          pageHeight: unscaledH,
          scale: viewport.scale,
          styles: content.styles,
        });
        regions = columnRegionsFromItems(items as Parameters<typeof columnRegionsFromItems>[0], {
          pageWidth: unscaledW,
          pageHeight: unscaledH,
          scale: viewport.scale,
          styles: content.styles,
        }).map((r) => ({
          top: r.top / viewport.height,
          bottom: r.bottom / viewport.height,
          full: r.full,
          bands: r.bands.map((b) => ({ start: b.start / viewport.width, end: b.end / viewport.width })),
          orderByBands: orderBands.length >= 2,
        }));
      } catch {
        regions = [];
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
          tagTextSpans(layer, itemXs);
          /**
           * ⚠️ **不要再调 `reorderTextLayer(layer, regions)`**（保留函数体只为诊断，见它的注释）。
           *
           * 这里曾经先按"DOM span 的 rect + 视觉行分桶"重排一次 DOM，然后字符模型又按
           * "文本项几何 + 分区/栏带"重排一次 —— **两套排序器互相不一致**，结果 DOM 顺序 ≠ 模型顺序：
           * 模型认为"第 0 个字符"在栏尾、DOM 里第 0 个 span 却是页眉，夹取按模型算出来的端点
           * 落到**页眉**上（真实窗口实测：在栏 1 里纵向拖，选区从「第４期 李 妍等：…」开始）。
           *
           * 顺序现在**只有一处权威**：`selectionModel.buildSelectionModel()` 内部的
           * `selectionReadingOrder()`（它用的是 columnBands 的分区/栏带，比 DOM rect 那套更准，
           * 而且它把 DOM 与文本项**一起**搬，天然同序）。
           */
          reportSelectionModel(layer, page, viewport, rawItems, regions);
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
      cbRef.current.onLayer?.(pageNumber, null);
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

  // -------- 选区（划词）：**由选取引擎接管，不再使用浏览器原生选区** --------
  //
  // 背景（写给下一个人）：这里以前是"浏览器原生选区 + 我们自己纠偏"，前后修了 7~8 轮都翻在
  // 同一件事上 —— 浏览器的 DOM 顺序 ≠ 版面顺序（中文期刊的内容流常常左右栏交替），
  // 两个"选区"永远在对不上。现在的做法是把浏览器从"选取"里踢出去（Zotero 的做法）：
  //   1. 文本层 `user-select: none`，浏览器不再产生任何选区；
  //   2. 拖动 = 按下点的字（锚点）→ 指针当前的字（焦点），**每帧重新算两端**；
  //   3. 焦点只允许取"锚点那一栏"里的字 → **跨栏在结构上不可能**；
  //   4. 高亮自己画（按行合并，一行一条），复制自己写剪贴板。
  // 引擎本身在 selectionEngine.ts，并已在隔离页（tmp/sel-harness）用真实鼠标 + 截图验收过。
  const layerByPageRef = useRef(new Map<number, { pageEl: HTMLElement; textLayer: HTMLElement }>());
  /** 引擎给的最后一次选区（模型坐标 + 客户端矩形） */
  const engineSelRef = useRef<EngineSelection | null>(null);

  const handleLayer = useCallback((page: number, layer: { pageEl: HTMLElement; textLayer: HTMLElement } | null) => {
    if (!layer) {
      layerByPageRef.current.delete(page);
      return;
    }
    layerByPageRef.current.set(page, layer);
  }, []);

  /** 引擎 → 产品：把引擎给的选区翻成工具条/批注要的形状（页内相对矩形 + 首行 client 矩形） */
  const reportEngineSelection = useCallback(
    (sel: EngineSelection | null) => {
      engineSelRef.current = sel;
      if (!sel) {
        if (lastSelectionRef.current) {
          lastSelectionRef.current = null;
          onSelectionRef.current(null);
        }
        return;
      }
      const layer = layerByPageRef.current.get(sel.pageIndex + 1);
      const pageEl = layer?.pageEl;
      if (!pageEl) return;
      const pageRect = pageEl.getBoundingClientRect();
      if (pageRect.width <= 0 || pageRect.height <= 0) return;
      const text = sel.text;
      if (!text) return;
      const map = mapsRef.current.get(sel.pageIndex + 1);
      const anchor = map ? buildAnchorFallback(text, map.text) : buildAnchorFallback(text, '');
      const rect: PdfSelectionPayload['rect'] = sel.rects.length
        ? { left: sel.rects[0][0], top: sel.rects[0][1], right: sel.rects[0][2], bottom: sel.rects[0][3] }
        : { left: pageRect.left, top: pageRect.top, right: pageRect.right, bottom: pageRect.top };
      const payload: PdfSelectionPayload = {
        text,
        rect,
        pageEl,
        page: sel.pageIndex + 1,
        rects: clampRects(
          normalizeRects(
            sel.rects.map(([x1, y1, x2, y2]) => ({ left: x1 - pageRect.left, top: y1 - pageRect.top, right: x2 - pageRect.left, bottom: y2 - pageRect.top })),
            pageRect,
          ),
        ),
        anchor,
      };
      lastSelectionRef.current = payload;
      onSelectionRef.current(payload);
    },
    [],
  );

  const engineOverlayRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<ReturnType<typeof createSelectionEngine> | null>(null);
  if (!engineRef.current) {
    engineRef.current = createSelectionEngine({
      pages: (): PageHandle[] => {
        const out: PageHandle[] = [];
        for (const [pageNumber, layer] of layerByPageRef.current) {
          const model = selectionModelsRef.current.get(pageNumber - 1)?.model;
          if (!model) continue;
          out.push({ pageIndex: pageNumber - 1, pageEl: layer.pageEl, textLayer: layer.textLayer, model });
        }
        return out;
      },
      overlay: () => engineOverlayRef.current,
      onSelection: (sel) => reportEngineSelection(sel),
      debug: SELECTION_DEBUG,
    });
  }

  /**
   * 引擎的鼠标接线：按下 → 移动（每帧）→ 松手。
   *
   * ⚠️ **挂在 `document` 上（capture），不挂在滚动容器上**：我第一版挂
   * `scrollRef.current?.parentElement`，结果 effect 执行时容器引用还是空的，
   * 直接 `return` 了 —— 监听器一个都没挂上，产品里"拖动一个字都选不中"（真机实测）。
   * 挂在 document 上没有挂载时机问题：引擎本来就靠 `pages()` 里的几何命中，
   * 不需要知道自己挂在哪个 DOM 上。是否属于阅读器由 target 判定。
   */
  useEffect(() => {
    let dragging = false;
    const onDown = (ev: MouseEvent): void => {
      if (ev.button !== 0) return;
      const target = ev.target as HTMLElement | null;
      if (!target?.closest?.('.rd-pdf-page')) return; // 只在页面上开始
      // 点空白也要能清选区：引擎 begin 返回 false 时会自己清
      dragging = engineRef.current?.begin(ev.clientX, ev.clientY, ev.shiftKey) ?? false;
      if (!dragging) return;
      // 原生选区彻底不用了：清掉它，避免它和自绘高亮同时出现
      window.getSelection()?.removeAllRanges();
    };
    const onMove = (ev: MouseEvent): void => {
      if (!dragging) return;
      engineRef.current?.move(ev.clientX, ev.clientY);
    };
    const onUp = (): void => {
      if (!dragging) return;
      dragging = false;
      engineRef.current?.end();
    };
    const onScroll = (): void => {
      // 滚动/缩放后矩形要重算（高亮层在视口上，坐标是客户端坐标）
      engineRef.current?.refresh();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  /** 复制：原生选区已被关掉，Ctrl+C / 右键"复制"都要我们自己写剪贴板 */
  useEffect(() => {
    const onCopy = (ev: ClipboardEvent): void => {
      const sel = engineSelRef.current;
      if (!sel?.text) return;
      ev.preventDefault();
      ev.clipboardData?.setData('text/plain', sel.text);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
        const target = ev.target as HTMLElement | null;
        if (target?.closest?.('.rd-pdf-page')) ev.preventDefault(); // 不选整个界面
      }
      if (ev.key === 'Escape') engineRef.current?.clear();
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // -------- 选区（划词） --------
  const lastSelectionRef = useRef<PdfSelectionPayload | null>(null);
  // 事件回调里要读最新的批注与选择回调，但不希望它们进依赖数组导致频繁重订阅
  const annotationsRef = useRef(props.annotations);
  annotationsRef.current = props.annotations;
  const onSelectAnnotationRef = useRef(props.onSelectAnnotation);
  onSelectAnnotationRef.current = props.onSelectAnnotation;

  const collectSelection = useCallback((snap?: SelSnapshot | null, rangeArg?: Range | null) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      if (lastSelectionRef.current) {
        lastSelectionRef.current = null;
        onSelectionRef.current(null);
      }
      return;
    }
    // 内核写过 DOM 时（`apply` 收窄了端点）它返回的 range 已经失效，必须重新读一次原生选区
    const range = rangeArg ?? sel.getRangeAt(0);
    const pageEl = pageElementOf(range.startContainer) ?? pageElementOf(range.endContainer);
    if (!pageEl) return;
    const page = Number(pageEl.dataset.pageIndex ?? '0');
    if (!page) return;
    const pageRect = pageEl.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) return;

    /**
     * 选区矩形：**优先用划词内核从字符模型算出来的**（Zotero 的做法）。
     *
     * 为什么不直接用 `range.getClientRects()`：pdf.js 会把一个整层大小的 `.endOfContent`
     * 插到选区锚点旁边，它一旦进了 range，`getClientRects()` 就会多报一条横贯整页的矩形
     * （实测：27 字的选区报成 1536px 高）—— 批注会画出一整页高亮、工具条也会定位到错的地方。
     * 模型算出来的 rects 天生只有"真正的文字行"。
     */
    const snapPage =
      snap && (snap.pageIndex === page - 1 || snap.rectsByPage.some((p) => p.pageIndex === page - 1)) ? snap : null;
    const modelRects = snapPage?.rectsByPage.find((p) => p.pageIndex === page - 1)?.rects ?? null;
    const rects = modelRects && modelRects.length
      ? clampRects(normalizeRects(modelRects, pageRect))
      : clampRects(relRects(Array.from(range.getClientRects()), pageRect));

    /**
     * 文字：**优先用模型算出来的**。
     *
     * 模型会在段落之间补空格、把行内断开的 run 接起来（`getTextFromChars`），比
     * `selection.toString()` 更接近"用户以为选到的那段话"；而且它是我们真正用来
     * 判断端点归属的那一份文本，两者必须一致，否则批注重定位会漂。
     */
    const rawText = snapPage?.text?.trim() ? snapPage.text : sel.toString();
    const text = rawText.replace(/\s+/g, ' ').trim();
    if (text.length < 1) return;

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

    /**
     * 工具条定位用的第一行矩形：模型算出来的（相对页面元素）→ 转客户端；
     * 没有模型就退回 DOM 的 `getClientRects()[0]`。
     */
    const firstLine = modelRects && modelRects.length
      ? {
          left: pageRect.left + modelRects[0].left,
          top: pageRect.top + modelRects[0].top,
          right: pageRect.left + modelRects[0].right,
          bottom: pageRect.top + modelRects[0].bottom,
        }
      : null;
    const firstDom = range.getClientRects()[0];
    const rect = firstLine ?? (firstDom
      ? { left: firstDom.left, top: firstDom.top, right: firstDom.right, bottom: firstDom.bottom }
      : { left: pageRect.left, top: pageRect.top, right: pageRect.right, bottom: pageRect.top });
    const payload: PdfSelectionPayload = {
      text,
      rect,
      pageEl,
      page,
      rects,
      anchor,
    };
    lastSelectionRef.current = payload;
    onSelectionRef.current(payload);
    // 依赖保持空：`collectSelection` 的身份必须稳定，否则鼠标 effect 会反复重订阅，
    // 把"手动划词"等 effect 局部状态整批重置（真实后果：拖选后选区变空、工具条不弹）。
  }, []);
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;
  /** 一个 DOM 位置的"文档序"（比较两个端点谁在前；`range.startContainer` 只是文档序，不等于锚点） */
  const docOrderCompare = (a: { node: Node; offset: number }, b: { node: Node; offset: number }): number => {
    try {
      const probe = document.createRange();
      probe.setStart(a.node, a.offset);
      probe.collapse(true);
      const closer = probe.comparePoint(b.node, b.offset);
      return closer >= 0 ? -1 : 1;
    } catch {
      return 0;
    }
  };

  /** 选中区域里排最前的那个 DOM 端点（用来判 `anchorIsStart`） */
  const firstNodePosition = (list: readonly DomSelectionEndpoint[]): { node: Node; offset: number } | null => {
    let best: { node: Node; offset: number } | null = null;
    for (const ep of list) {
      for (const p of [ep.start, ep.end]) {
        if (!best || docOrderCompare(p, best) < 0) best = p;
      }
    }
    return best;
  };

  /** 文本层里第一个/最后一个文字节点位置（跨页选择时把端点钉在页首/页尾） */
  const edgeTextPosition = (layer: HTMLElement | null, edge: 'first' | 'last'): { node: Node; offset: number } | null => {
    if (!layer) return null;
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    let node: Node | null = walker.nextNode();
    while (node) {
      const t = node as Text;
      if ((t.nodeValue ?? '').length > 0) {
        if (edge === 'first') return { node: t, offset: 0 };
        last = t;
      }
      node = walker.nextNode();
    }
    return last ? { node: last, offset: (last.nodeValue ?? '').length } : null;
  };

  /**
   * 各页上报的划词字符模型（0 起页号，包一层 `SelectionModel` 好带方法）。
   * 页模型被替换/丢弃时由 PdfPage 再报一次覆盖它。
   */
  const selectionModelsRef = useRef(new Map<number, SelectionModel>());

  /**
   * 划词内核（Zotero 式：原生选区只提供两个端点，真正的选区在**字符模型**上算）。
   *
   * 这一版把之前那套"自研夹取"整段删掉了：拖动中改锚点、夹跨页、按 DOM span 的 rect 判栏归属、
   * 松手后锁 0.7~2.5 秒 + MutationObserver 看护 + 7 拍补夹…… 那套东西的每一行都对应一个实测 bug，
   * 而 bug 的总数并没有减少（见 docs/HANDOFF-column-selection-fix.md）。Zotero 的做法是：
   * 浏览器负责拖动，我们把端点映射进字符模型，再按"锚点所在栏流"这个**离散**判据收窄焦点，
   * 最后只写一次 `setBaseAndExtent`。细节见 selectionKernel.ts 顶部的长注释。
   */
  const selectionKernelRef = useRef<SelectionKernel | null>(null);
  if (!selectionKernelRef.current) {
    const deps: KernelDeps = {
      getPage: (i) => selectionModelsRef.current.get(i)?.model ?? null,
      /**
       * DOM 端点 → （页号, 字符序号）。
       *
       * ⚠️ **页号基准**：`.rd-pdf-page[data-page-index]` 是 **1 起**的，而模型一律是 **0 起**
       * （`PageCharModel.pageIndex = pageNumber - 1`）。这里必须减 1 —— 我曾经漏掉这一步，
       * 结果 `get(1)` 取不到页 1 的模型（它存在 0 号键上），`resolveDomPosition` 永远返回 null、
       * 端点从头到尾映射不出来，**夹取一次都没运行过**（用户实测：一项都不符合）。
       * 模型映射表 `selectionModelsRef` 的键**统一 0 起**，任何地方要用都得先换算。
       */
      resolveDomPosition: (node, offset, affinity) => {
        const pageEl = pageElementOf(node);
        const pageNo = Number(pageEl?.dataset.pageIndex ?? '0');
        if (!pageNo) return null;
        const model = selectionModelsRef.current.get(pageNo - 1);
        if (!model) return null;
        return model.resolveDomPosition(node, offset, affinity);
      },
      pageOriginOf: (pageEl) => {
        const r = pageEl.getBoundingClientRect();
        return { left: r.left, top: r.top };
      },
      debug: SELECTION_DEBUG,
    };
    selectionKernelRef.current = createSelectionKernel(deps);
  }

  /** 各页上报的划词模型：**先包成 SelectionModel** 再存（内核只认模型本身，方法在包装层上） */
  const handleSelectionModel = useCallback((page: number, model: PageCharModel | null) => {
    // ⚠️ 键用 **0 起页号**（`page` 是 1 起的渲染页号）—— 与模型内部、内核的一致，
    // 漏掉这个换算会让后面所有 `get()` 全部落空（踩过，见 deps 里的注释）。
    const pageIndex = page - 1;
    selectionDebugLog('模型登记', { page, chars: model ? model.chars.length : null });
    selectionKernelRef.current?.invalidate(pageIndex);
    if (!model) {
      selectionModelsRef.current.delete(pageIndex);
      return;
    }
    selectionModelsRef.current.set(pageIndex, new SelectionModel(model));
  }, []);


  /**
   * 把当前原生选区收成内核要的输入（按页分组）。
   *
   * 为什么按页分组：跨页拖选是合法操作（Zotero 也支持），但**每一页的模型互不相干**，
   * 所以内核按页分别算 range。
   */
  const selectionInput = useCallback((): { input: SelSnapshotInput; range: Range } | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const startPage = pageElementOf(range.startContainer);
    const endPage = pageElementOf(range.endContainer);
    if (!startPage || !endPage) return null;
    const pageIndexOf = (el: HTMLElement): number => Number(el.dataset.pageIndex ?? '0');
    const startIdx = pageIndexOf(startPage);
    const endIdx = pageIndexOf(endPage);
    if (!startIdx || !endIdx) return null;
    const endpoints: DomSelectionEndpoint[] = [];
    if (startIdx === endIdx) {
      endpoints.push({
        pageIndex: startIdx - 1,
        scale: selectionModelsRef.current.get(startIdx - 1)?.model.scale ?? 1,
        start: { node: range.startContainer, offset: range.startOffset },
        end: { node: range.endContainer, offset: range.endOffset },
        pageEl: startPage,
      });
    } else {
      // 跨页：起点页取"range 起点 → 该页文本层末尾"，终点页取"该页文本层开头 → range 终点"。
      const startTail = edgeTextPosition(startPage.querySelector<HTMLElement>('.rd-pdf-text'), 'last');
      const endHead = edgeTextPosition(endPage.querySelector<HTMLElement>('.rd-pdf-text'), 'first');
      if (startTail) {
        endpoints.push({
          pageIndex: startIdx - 1,
          scale: selectionModelsRef.current.get(startIdx - 1)?.model.scale ?? 1,
          start: { node: range.startContainer, offset: range.startOffset },
          end: startTail,
          pageEl: startPage,
        });
      }
      if (endHead) {
        endpoints.push({
          pageIndex: endIdx - 1,
          scale: selectionModelsRef.current.get(endIdx - 1)?.model.scale ?? 1,
          start: endHead,
          end: { node: range.endContainer, offset: range.endOffset },
          pageEl: endPage,
        });
      }
    }
    if (!endpoints.length) return null;
    const first = firstNodePosition(endpoints);
    const anchorDoc = first
      ? docOrderCompare({ node: sel.anchorNode ?? range.startContainer, offset: sel.anchorOffset }, first) === 0
      : true;
    return { input: { anchorIsStart: anchorDoc, endpoints }, range };
  }, []);

  /**
   * 读一次原生选区 → 交给内核算。
   *
   * `read()` 只算不写；`apply()` 只在"端点确实越栏/越流"时才写一次 DOM。
   * 两者都用同一份输入，所以结果一定是同一个选区，不会出现"读完又变"的抖动。
   */
  const readKernelSelection = useCallback((): { snap: SelSnapshot | null; range: Range | null } => {
    const kernel = selectionKernelRef.current;
    if (!kernel) return { snap: null, range: null };
    const read = selectionInput();
    if (!read) {
      kernel.clear();
      return { snap: null, range: null };
    }
    const snap = kernel.read(read.input);
    if (!snap) return { snap: null, range: read.range };
    const applied = kernel.apply(read.input);
    if (applied) return { snap: applied, range: null };
    // `apply` 返回 null = 端点本来就合法（或映射不出来）→ 用只读那一份
    return { snap, range: read.range };
  }, [selectionInput]);

  useEffect(() => {
    /** 合并短时间内的多次触发：`selectionchange` 在拖动中会刷屏，收一次就够 */
    let collectTimer = 0;
    /** 指针是否按下 —— 拖动中只做"纠正"，不做"上报"（工具条不该在拖动过程中就冒出来） */
    let pressed = false;
    /** 指针最后位置与按下点（`selectionchange` 里没有事件参数，只能自己记） */
    const pointerRef = { x: 0, y: 0 };
    const downRef = { x: 0, y: 0 };

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

    /**
     * 浏览器**压根没拉出选区**时的兜底（整段拖动一条 `selectionchange` 都没有）。
     *
     * 这条路径与"跨栏纠正"无关（它只是把用户本来想要的选区补出来），所以保留：
     * 实测会有"按下点明明在文字上、松手却是空选区"的情况，而命中与样式都正常。
     * 只在这种情况动手，而且只朝"按下点 → 松手点"这一条走：
     *   · 已经有非空选区 → 立刻放手；
     *   · 按下/松手位移 < 6px（单击、双击选词、Shift+点击）→ 放手；
     *   · 两端必须落在同一页的文本层文字上，否则放手；
     *   · 构造出来的区间必须非空，否则放手。
     */
    const rescueEmptyDrag = (): boolean => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return false;
      const dx = pointerRef.x - downRef.x;
      const dy = pointerRef.y - downRef.y;
      if (dx * dx + dy * dy < 36) return false;
      const caretAt = (
        document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
      ).caretRangeFromPoint;
      if (typeof caretAt !== 'function') return false;
      const at = (x: number, y: number): { node: Node; off: number; span: HTMLElement } | null => {
        let r: Range | null = null;
        try {
          r = caretAt.call(document, x, y);
        } catch {
          return null;
        }
        if (!r) return null;
        const node = r.startContainer;
        const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
        const span = (el?.closest?.('.rd-pdf-text span') as HTMLElement | null) ?? null;
        if (!span || !(span.textContent ?? '').trim()) return null;
        return { node, off: r.startOffset, span };
      };
      const a = at(downRef.x, downRef.y);
      const b = at(pointerRef.x, pointerRef.y);
      if (!a || !b) return false;
      if (a.span.closest('.rd-pdf-page') !== b.span.closest('.rd-pdf-page')) return false;
      /**
       * 两个顺序都要试：DOM 顺序与参数顺序相反时 Chromium **不抛异常**，
       * 而是返回一个**塌陷**的 Range（这个坑在旧实现里踩过两次）。
       */
      const mk = (n1: Node, o1: number, n2: Node, o2: number): Range | null => {
        const r = document.createRange();
        try {
          r.setStart(n1, o1);
          r.setEnd(n2, o2);
        } catch {
          return null;
        }
        return r.collapsed ? null : r;
      };
      const fixed = mk(a.node, a.off, b.node, b.off) ?? mk(b.node, b.off, a.node, a.off);
      if (!fixed || !fixed.toString().trim()) return false;
      sel?.removeAllRanges();
      sel?.addRange(fixed);
      console.debug(`[reader] 浏览器没拉出选区，已按"按下点 → 松手点"补一个：${fixed.toString().length} 字`);
      return true;
    };

    /**
     * 收尾：读原生选区 → 内核按字符模型算合法选区（越栏就写一次端点）→ 上报给工具条。
     *
     * 顺序不能反：必须先让内核把端点收窄，再按收窄后的选区建 anchor/rects，
     * 否则批注会锚在"越栏那一版"的坐标上。
     */
    const settle = (): void => {
      collectTimer = 0;
      /**
       * **整条旧路径已停用**：划词现在完全由 selectionEngine 接管（原生选区已关掉，
       * 这里读到的永远是"空选区"）。如果还让它跑，它会拿"空选区"去把工具条清掉，
       * 反而把引擎刚上报的选区冲掉 —— 这正是"两个选区打架"的最后一块。
       *
       * 保留这段代码（不删）是因为：`readKernelSelection` / `collectSelection` 里还有
       * 工具条定位、批注坐标、anchor 生成等一堆在用逻辑，删了会牵动太多。
       * 所以只关"入口"，让引擎成为唯一触发者。
       */
      if (true) return;
      if (pressed) return;
      let { snap, range } = readKernelSelection();
      if (!snap && !range) {
        // 浏览器完全没拉出选区 → 补一个再按同一条路走一遍
        if (rescueEmptyDrag()) {
          const again = readKernelSelection();
          snap = again.snap;
          range = again.range;
        }
      }
      if (!snap) {
        if (lastSelectionRef.current) {
          lastSelectionRef.current = null;
          onSelectionRef.current(null);
        }
        return;
      }
      collectSelection(snap, range);
    };
    /** 合并短时间内的多次触发（`selectionchange` 在拖动中会刷屏） */
    const schedule = (delay = 0): void => {
      if (collectTimer) window.clearTimeout(collectTimer);
      collectTimer = window.setTimeout(settle, delay);
    };

    const onSelectionChange = (): void => {
      /**
       * 拖动中：**只纠正、不上报**。Zotero 是每个 `selectionchange` 都同步一次选区
       * （它的高亮是模型渲染的，所以不怕改）；我们用的是原生选区，所以拖动中尽量不写 DOM，
       * 只在上报时（松手后）做一次收窄 —— 这样不会和浏览器正在进行的拖动打架。
       */
      if (pressed) return;
      schedule(20);
    };

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
      settle(); // 松手立刻收一次（工具条在松手时才弹）
      /**
       * 浏览器会把**排队的 mousemove 在 mouseup 之后才应用完**（实测能晚到 1 秒之后），
       * 那一波会把选区再扩回去。所以在 1.2 秒内补几拍，复用同一条 `settle` 路径
       * （没有越栏选区时每一拍都是空操作：内核的 `read` 算出来与原生一致 → `apply` 一个字节都不写）。
       */
      for (const delay of [70, 150, 260, 420, 650, 900, 1200]) {
        window.setTimeout(() => {
          if (!pressed) schedule(0);
        }, delay);
      }
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
        if (window.getSelection()?.toString().trim()) settle();
        return;
      }
      if (me.button !== 0) return; // 中键等一律不参与划词
      onMove(ev);
      downRef.x = me.clientX ?? 0;
      downRef.y = me.clientY ?? 0;
      pressed = true;
      selectionKernelRef.current?.clear();
      lastSelectionRef.current = null;
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
  }, [collectSelection, readKernelSelection]);

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
                    onSelectionModel={handleSelectionModel}
                    onLayer={handleLayer}
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
                    onSelectionModel={handleSelectionModel}
                    onLayer={handleLayer}
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
      {/*
        划词高亮层：**固定在视口上**（引擎按行合并后给的就是客户端坐标的矩形）。
        它必须盖在页面之上、且不吃指针事件（否则拖动会被自己挡住）。
        为什么不用浏览器原生高亮：原生高亮的形状由浏览器按 DOM 顺序算，正是过去
        "碎片化 / 跳过一截再拼接 / 跨栏"的来源；这里的矩形由字符模型按行算，一行一条。
      */}
      <div
        ref={engineOverlayRef}
        className="rd-sel-overlay"
        style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 40 }}
      />
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

/**
 * 划词内核给的矩形（CSS 像素、相对页面元素）→ 批注用的 0~1 比例矩形。
 *
 * 合并规则与 `relRects()` 对齐（同一行上左右相接的两段并成一条），这样"模型算的矩形"
 * 与"DOM rect 算的矩形"在批注里长得一样；区别只在于模型那份**没有** pdf.js 那个
 * 整层大小 `.endOfContent` 造成的整页框（`relRects` 里那条 0.25 页高的过滤就是为它写的）。
 */
function normalizeRects(rects: readonly Rect[], pageRect: DOMRect): AnnotationRect[] {
  const out: AnnotationRect[] = [];
  if (pageRect.width <= 0 || pageRect.height <= 0) return out;
  for (const r of rects) {
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    if (w <= 0.5 || h <= 0.5) continue;
    if (h > pageRect.height * 0.25 || w > pageRect.width * 1.05) continue;
    const rect: AnnotationRect = {
      x: r.left / pageRect.width,
      y: r.top / pageRect.height,
      w: w / pageRect.width,
      h: h / pageRect.height,
    };
    if (rect.x > 1.2 || rect.y > 1.2 || rect.x + rect.w < -0.2) continue;
    const existing = out.find(
      (e) =>
        Math.abs(e.y - rect.y) < 0.002 &&
        Math.abs(e.h - rect.h) < 0.004 &&
        rect.x - (e.x + e.w) > -0.004 &&
        rect.x - (e.x + e.w) < 0.012,
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

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
import { findHighlightStrips, hitCountOfStrips, type HighlightStrip } from './search';

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
  /** 拖选结束后由父级读取选区；这里只上报"页面元素" */
  onPageElement: (page: number, el: HTMLElement | null) => void;
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
  } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [painted, setPainted] = useState(false);
  /** 上一次 canvas 渲染任务的 promise：新任务必须等它真正结束，避免同一 canvas 上重叠渲染 */
  const prevTaskRef = useRef<Promise<void>>(Promise.resolve());
  /** 渲染失败后的自愈重试次数（有上限，不会无限循环） */
  const [retryTick, setRetryTick] = useState(0);
  /** 当前这一页的文本层实例：缩放时用它原地 update()，避免重建几百个 span（缩放慢的主因之一） */
  const textLayerRef = useRef<InstanceType<typeof pdfjsLib.TextLayer> | null>(null);
  const textLayerKeyRef = useRef<string | null>(null);
  const textLayerDocRef = useRef<unknown>(null);
  /**
   * 回调一律走 ref 取用，**不进渲染 effect 的依赖**。
   * 教训：父级只要传进来一个内联箭头函数（曾经就是 onPageMaps），它的身份每次渲染都变，
   * 会让整个 canvas + 文本层被拆掉重建；拖动过程中文本层节点被替换，原生选区的锚点随之失效，
   * 表现就是"选区莫名其妙乱选/整段选中"和"文本层间歇性一个 span 都没有"。
   */
  const cbRef = useRef({ onMap, onDropMap, onFirstPaint, onStuck });
  cbRef.current = { onMap, onDropMap, onFirstPaint, onStuck };

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

  // canvas + 文本层
  useEffect(() => {
    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;
    /** 看门狗定时器 id（见 run() 开头） */
    let watchdog = 0;
    /** 是否有一轮 page.render() 正在跑：看门狗据此决定"等"还是"救" */
    let renderInFlight = false;

    const run = async () => {
      // 看门狗：pdf.js 的 render/文本层偶尔会"既不 resolve 也不 reject"（worker 卡住），
      // 这时自愈分支根本走不到，页面会永远停在骨架屏、一个 span 都没有。
      //
      // 但**绝不能打断正在跑的渲染**：重挂会 cancel() 掉在飞的 render，
      // 复杂页（比如缺字体的中文期刊页）本来 8~20 秒能画完，被每 6 秒打断一次就永远画不完
      // —— 实测日志里就是"第 1 页 6 秒未挂上文本层，第 1 次整页重挂、第 2 次…"然后一直空白。
      // 所以：6 秒时若渲染仍在进行 → 只挂一个 24 秒的兜底，不重挂；确实没有任何渲染在跑才重挂。
      const armWatchdog = (ms: number, allowRemount: boolean) => {
        watchdog = window.setTimeout(() => {
          if (cancelled) return;
          if (textRef.current?.querySelector('span')) return;
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
      await prevTaskRef.current;
      if (cancelled) {
        window.clearTimeout(watchdog);
        return;
      }

      let page;
      try {
        page = await doc.getPage(pageNumber);
      } catch {
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
        prevTaskRef.current = renderTask.promise.catch(() => undefined);
        renderInFlight = true;
        await renderTask.promise;
      } catch (err) {
        const name = (err as { name?: string })?.name;
        const aborted = name === 'RenderingCancelledException' || name === 'AbortException';
        if (!aborted) {
          renderErr = err;
          console.warn(`[reader] 第 ${pageNumber} 页渲染失败`, err);
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
      cbRef.current.onFirstPaint?.();
      // 文本层（可选中 / 可被浏览器原生查找）。
      // 缩放时**优先原地 update()**：pdf.js 的 TextLayer.update 只重排已有的 span，
      // 不用重新拉一遍文字、也不用重建几百个节点——这是"缩放很慢"里最贵的一段。
      // 换页/换文档/没有 span 时才走重建（重建带校验 + 重试，见下）。
      let painted2 = false;
      const live = textLayerRef.current;
      if (live && textContainer.querySelector('span')) {
        try {
          live.update({ viewport });
          painted2 = true;
        } catch (err) {
          console.warn(`[reader] 第 ${pageNumber} 页文本层原地更新失败，改为重建`, err);
        }
      }
      if (!painted2) {
        // 渲染完成了不等于 span 一定挂上：流被中途 cancel、容器被清空后没有内容都会留下空层，
        // 而空文本层对用户就是"划不中词"。所以这里渲染完要**校验 + 重试**，重试改用
        // getTextContent()（pdf.js 会缓存结果，且不依赖可被 cancel 的流）。
        painted2 = await paintTextLayer(page, viewport);
      }
      if (cancelled) return;
      if (painted2) {
        window.clearTimeout(watchdog); // 这一页搞定了，别让看门狗再触发重试
        cbRef.current.onMap(pageNumber, buildPageTextMap(pageNumber, textContainer, viewport.width, viewport.height));
      } else {
        console.warn(`[reader] 第 ${pageNumber} 页文本层始终为空（划词不可用）`);
        // 自愈：偶尔会遇到"画布渲染完成、但文本层一个 span 都没挂上"（用户表现就是"划不中词"）。
        // 走和渲染失败同一条重试通道再试（有上限），别让这一页在整个会话里都不可选。
        if (!cancelled && retryTick < 2) {
          window.setTimeout(() => {
            if (!cancelled) setRetryTick((n) => n + 1);
          }, 500);
        }
      }
    };

    /** 挂文本层；返回是否真的挂上了 span。重试一次，第二次换另一种取文方式 */
    const paintTextLayer = async (page: pdfjsLib.PDFPageProxy, viewport: ReturnType<typeof page.getViewport>) => {
      const container = textRef.current;
      if (!container) return false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (cancelled) return false;
        try {
          container.textContent = '';
          // 首选 getTextContent()：pdf.js 会把结果缓存住，且**不受"流被 cancel"影响**
          // （缩放/重排会 cancel 掉上一轮，poison 掉 streamTextContent 的流是间歇性空层的常见原因）；
          // 万一它失败，第二次再退回流式。
          const source = attempt === 0 ? await page.getTextContent() : page.streamTextContent();
          textLayerRef.current = new pdfjsLib.TextLayer({ textContentSource: source, container, viewport });
          await textLayerRef.current.render();
        } catch (err) {
          if (!cancelled) console.warn(`[reader] 第 ${pageNumber} 页文本层失败（第 ${attempt + 1} 次）`, err);
        }
        if (cancelled) return false;
        if (container.querySelector('span')) return true;
        try {
          textLayerRef.current?.cancel();
        } catch {
          /* ignore */
        }
        textLayerRef.current = null;
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
      <div ref={textRef} className="rd-pdf-text" data-page={pageNumber} />
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

  // -------- 选区（划词） --------
  const lastSelectionRef = useRef<PdfSelectionPayload | null>(null);
  /** 本次拖选的起点（用来判断"是不是从空白处开始拖的"，以及往上还是往下拖） */
  const dragRef = useRef<{ inPage: boolean; x: number; y: number } | null>(null);
  /**
   * 拖动过程中"指针真正划过的最后一段文字"。
   * 松手在空白处时用它来夹选区——而不是用松手点最近的文字（密密麻麻的中文页里那种最近文字
   * 往往就是本页最后一行，于是夹出来跟原生选区一样长，"只在变短时替换"的规则不生效，
   * 用户看到的仍是整页全选）。拖过几行就只选几行，这才是 Word 的手感。
   */
  const lastTextRef = useRef<{ node: Node; offset: number; page: HTMLElement | null } | null>(null);
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
    onSelectionRef.current(payload);
    // 依赖保持空：`collectSelection` 的身份必须稳定，否则鼠标 effect 会反复重订阅，
    // 把"手动划词"等 effect 局部状态整批重置（真实后果：拖选后选区变空、工具条不弹）。
  }, []);
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;
  useEffect(() => {
    /**
     * 点在了哪条批注上（几何命中）。
     * 批注的文字标记层设成 pointer-events:none，好处是"已经高亮过的文字照样能用鼠标划过选中"；
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

    const elOf = (node: Node | null): HTMLElement | null =>
      !node ? null : node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;

    /** 某个屏幕坐标下最近的"文字光标"位置（Chromium 的 caretRangeFromPoint） */
    const textCaretAt = (x: number, y: number): { range: Range; inText: boolean; pageEl: HTMLElement | null } | null => {
      const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
      if (typeof doc.caretRangeFromPoint !== 'function') return null;
      const range = doc.caretRangeFromPoint(x, y);
      if (!range) return null;
      const el = elOf(range.startContainer);
      const span = el?.closest?.('.rd-pdf-text span') ?? null;
      const pageEl = (span ?? el)?.closest?.('.rd-pdf-page') as HTMLElement | null;
      return { range, inText: !!span, pageEl };
    };

    /** 某页文本层里第一个 / 最后一个文字位置 */
    const edgeTextPos = (pageEl: HTMLElement, which: 'first' | 'last'): { node: Node; offset: number } | null => {
      const spans = [...pageEl.querySelectorAll<HTMLElement>('.rd-pdf-text span')].filter((s) => (s.textContent ?? '').length > 0);
      if (!spans.length) return null;
      const span = which === 'first' ? spans[0] : spans[spans.length - 1];
      const node = span.firstChild;
      if (!node) return null;
      return { node, offset: which === 'first' ? 0 : (node.textContent ?? '').length };
    };

    /** 本次拖动的锚点页（按下那一刻落在哪一页）；选区永远不跨出它 */
    let anchorPageEl: HTMLElement | null = null;
    /** 当前指针位置 / 本次拖动起点：selectionchange 看护时要用（那时没有事件参数） */
    const pointerRef = { x: 0, y: 0 };
    const dragStartRef = { x: 0, y: 0 };

    /**
     * 手动划词（关键）：
     * 浏览器原生拖选会"跟到容器内容的尽头"——从正文拖到页面空白，选区会一路吃到后面几页
     * （实测：拖动中选区 1 字 → 松手后 4668 字，跨 3 页，用户看到的就是"莫名其妙全选"）。
     * 事后夹取打不赢它：它在拖动过程中每一刻都在重新扩展，滚动还会让锚点漂到别的页。
     *
     * 所以改成：只要按下点落在文字上，就把所有文本层临时设成 `user-select:none`
     * （浏览器于是没有任何可扩展的原生选区），选区完全由我们按
     * 「按下时的文字位置 → 指针最后真正划过的文字位置」自己构造，且绝不跨出起始页。
     * 松手后恢复 user-select。复制/划词工具条/批注都照旧可用（程序化选区是等效的）。
     */
    let manual = false;
    let manualAnchor: { node: Node; offset: number } | null = null;
    let manualPage: HTMLElement | null = null;
    let manualEnd: { node: Node; offset: number } | null = null;

    /**
     * 逐字 span → **行**模型：实现 Word 那样的取字规则。
     *
     * 用户诉求（截图里那段引用块）：指针停在**行间距**里时，浏览器默认"就近吸附"会把整行/整段吃掉；
     * Word 的规则是——指针在行间距里就**停在更近的那一行**、横向跟着鼠标走，
     * 只有指针真正进入下一行的文字才继续选下一行。
     *
     * 所以划词取点不再用 `caretRangeFromPoint`，而是自己按行算：
     *   ① 把这一页所有非空 span 按 top 归成行；
     *   ② 取竖直距离最近的那一行（行边界外延到与相邻行的中线，落在间距里必然选更近的一行）；
     *   ③ 行内按指针 x 落在哪个字上，取该字前半/后半的位置。
     */
    /**
     * 指针 → 文字位置（Word 手感）。
     *
     * 只用 **Chromium 自己的 caret** 定位（它找最近文字最准），再用**那个 span 自己的盒子**
     * 判断"指针是不是真的压在这行文字上"：
     *   - 真压在上面 → 接受，正常按 x 走；
     *   - 落在行间距里（Chromium 会把它吸到最近一行，常常是下一行）→ 只有当它与"上一次所在的行"
     *     是同一行时才接受（横向仍跟着鼠标、但不跳行）；否则保持上一次的位置不动；
     *   - 指针真正进入下一行文字的盒子 → 才接受换行。
     * 这样不需要整页归行（真实期刊 PDF 里 span 盒子高度虚大，整页归行会翻车）。
     */
    const boxOf = (p: { node: Node; offset: number } | null): { mid: number; h: number } | null => {
      const el = p ? (p.node.nodeType === 1 ? (p.node as HTMLElement) : p.node.parentElement) : null;
      const sp = el?.closest?.('.rd-pdf-text span') as HTMLElement | null;
      if (!sp) return null;
      const r = sp.getBoundingClientRect();
      return { mid: (r.top + r.bottom) / 2, h: r.bottom - r.top };
    };
    const sameLine = (a: { node: Node; offset: number } | null, b: { node: Node; offset: number } | null): boolean => {
      const x = boxOf(a);
      const y = boxOf(b);
      if (!x || !y) return false;
      return Math.abs(x.mid - y.mid) <= Math.max(3, Math.max(x.h, y.h) * 0.6);
    };

    /** 在一个 span 内按 x 取文字位置（span 自己的盒子是可靠的：它就是指针底下那个元素） */
    const posInSpan = (span: HTMLElement, clientX: number): { node: Node; offset: number } | null => {
      const t = span.firstChild;
      if (!t || t.nodeType !== 3) return null;
      const r = span.getBoundingClientRect();
      const len = (t.textContent ?? '').length;
      if (len <= 1) return { node: t, offset: clientX < (r.left + r.right) / 2 ? 0 : len };
      const ratio = (clientX - r.left) / Math.max(1, r.width);
      return { node: t, offset: Math.max(0, Math.min(len, Math.round(ratio * len))) };
    };

    let lastPos: { node: Node; offset: number } | null = null;
    /**
     * 指针 → 文字位置（Word 手感）。
     *   - 指针确实压在这行文字上 → 接受；
     *   - 落在行间距里（Chromium 常吸到下一行）→ 与上一次同一行才接受，否则保持原行不动
     *     （这就是用户要的："在行间距里只继续选那一行到鼠标为止，别跳到下一行"）；
     *   - 取不到 → 返回 null，由调用方用别的手段兜底（按下时用指针底下的 span）。
     */
    const lineAwarePos = (pageEl: HTMLElement, clientX: number, clientY: number): { node: Node; offset: number } | null => {
      void pageEl;
      const caret = document.caretRangeFromPoint(clientX, clientY);
      if (!caret) return null;
      const node = caret.startContainer;
      const el = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
      const span = el?.closest?.('.rd-pdf-text span') as HTMLElement | null;
      if (!span) return null;
      const pos = { node, offset: caret.startOffset };
      const r = span.getBoundingClientRect();
      const pad = Math.max(2, r.height * 0.25);
      const reallyOnIt = clientY >= r.top - pad && clientY <= r.bottom + pad;
      if (reallyOnIt || !lastPos) {
        lastPos = pos;
        return pos;
      }
      if (sameLine(pos, lastPos)) {
        lastPos = pos;
        return pos;
      }
      return lastPos; // 行间距里且已偏向别的行 → 保持在原来那一行
    };

    /** 我们自己定的选区（松手后看护窗口内用它覆盖浏览器后来的扩展） */
    let manualRange: Range | null = null;
    let manualText = '';
    let lastManualAt = 0;
    const buildRange = (
      a: { node: Node; offset: number },
      b: { node: Node; offset: number },
    ): Range | null => {
      const mk = (x: { node: Node; offset: number }, y: { node: Node; offset: number }) => {
        const r = document.createRange();
        try {
          r.setStart(x.node, x.offset);
          r.setEnd(y.node, y.offset);
        } catch {
          return null;
        }
        return r.collapsed ? null : r;
      };
      return mk(a, b) ?? mk(b, a);
    };

    const applyManual = () => {
      if (!manual || !manualAnchor || !manualEnd) return;
      const r = buildRange(manualAnchor, manualEnd);
      if (!r) return;
      manualRange = r;
      manualText = r.toString();
      lastManualAt = Date.now();
      const sel = window.getSelection();
      if (!sel) return;
      if (sel.toString() === manualText && !sel.isCollapsed) return; // 已经是我们要的，别白折腾
      sel.removeAllRanges();
      sel.addRange(r);
    };

    /**
     * 手动划词收尾。兜底顺序很关键：
     *   ① 松手点落在文字上 → 用它当终点；
     *   ② 一个终点都没记到（例如直接拖到页面空白里，途中没经过别的文字）→
     *      按拖动方向退到**本页页首/页末**。不兜这一下会出现"向上拖到空白一个字都没选中"。
     */
    const finishManual = (mx: number, my: number) => {
      if (!manual) return;
      const dy = my - dragStartRef.y;
      const dx = mx - dragStartRef.x;
      // 只是"单击文字"（位移很小）→ 不要造选区：
      // 否则点一下正文就选中一大段，而且点已有高亮时也打不开批注卡片（批注点击靠选区为空来判断）。
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) {
        manual = false;
        manualRange = null;
        manualText = '';
        return;
      }
      const forward = Math.abs(dy) > 6 ? dy > 0 : dx >= 0;
      const relCaret = manualPage ? lineAwarePos(manualPage, mx, my) : null;
      if (relCaret) {
        manualEnd = relCaret;
      }
      applyManual();
      // 兜底：一次终点都没记到、或夹出来是空的（例如一路拖进上方空白、途中没经过别的文字），
      // 就按拖动方向退到本页页末/页首——否则用户"往上拖"会一个字都选不中。
      if ((!manualRange || manualRange.collapsed) && manualPage) {
        const edge = edgeTextPos(manualPage, forward ? 'last' : 'first');
        if (edge) {
          manualEnd = edge;
          applyManual();
        }
      }
      manual = false;
      guardUntil = Date.now() + 700;
    };

    /**
     * 把拖选**夹在起始页内**，并且只保留"指针真正划过的那部分"。
     *
     * 为什么必须在拖动过程中反复调用：浏览器的选区扩展是异步的——它会先把排队的 mousemove
     * 应用完再算最终选区。实测（用户那篇 14 页中文论文）：拖动中选区只有 1 个字，松手后
     * 变成 4668 个（跨了 3 页）——就是用户说的"移到空白处就全选"。只在 mouseup 里夹一次
     * 跑在浏览器扩展之前，等于没夹。
     *
     * 规则：
     *   1. 锚点固定在按下那一页（anchorPageRef），选区永远不跨出这一页；
     *   2. 终点优先取"指针划过的最后一段文字"（拖过几行就选几行），
     *      其次取松手点在本页最近的文字，最后才退到本页页首/页末；
     *   3. 只在**确实变短**时替换原生选区（不变短就不动，避免把正常选择改坏）。
     */
    const clampSelection = (clientX: number, clientY: number, fromX: number, fromY: number): void => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.anchorNode) return;
      const range = sel.getRangeAt(0);
      const anchorPage =
        anchorPageEl ?? (elOf(sel.anchorNode)?.closest?.('.rd-pdf-page') as HTMLElement | null);
      if (!anchorPage) return;

      const dy = clientY - fromY;
      const dx = clientX - fromX;
      const forward = Math.abs(dy) > 6 ? dy > 0 : dx >= 0;

      const anchorPos = { node: sel.anchorNode, offset: sel.anchorOffset };
      let target: { node: Node; offset: number } | null = null;

      // ① 指针划过的最后一段文字（必须仍在起始页内）
      const touched = lastTextRef.current;
      if (touched && touched.page === anchorPage) target = { node: touched.node, offset: touched.offset };
      // ② 松手点在本页最近的文字位置
      if (!target) {
        const caret = textCaretAt(clientX, clientY);
        if (caret?.inText && caret.pageEl === anchorPage) {
          target = { node: caret.range.startContainer, offset: caret.range.startOffset };
        }
      }
      // ③ 退到本页页首/页末（按拖动方向）
      if (!target) {
        const edge = edgeTextPos(anchorPage, forward ? 'last' : 'first');
        if (!edge) return;
        target = edge;
      }

      const probe = document.createRange();
      try {
        if (forward) {
          probe.setStart(anchorPos.node, anchorPos.offset);
          probe.setEnd(target.node, target.offset);
        } else {
          probe.setStart(target.node, target.offset);
          probe.setEnd(anchorPos.node, anchorPos.offset);
        }
      } catch {
        return;
      }
      if (probe.collapsed) return;
      const before = range.toString();
      const after = probe.toString();
      if (after.length >= before.length) return; // 没变短 → 不必动
      sel.removeAllRanges();
      sel.addRange(probe);
    };

    const onUp = (ev: Event) => {
      const me = ev as MouseEvent;
      const target = ev.target as Node | null;
      if (!target || !scrollRef.current?.contains(target)) return;
      if (typeof me.button === 'number' && me.button !== 0) return;

      const drag = dragRef.current;
      dragRef.current = null;
      const sel = window.getSelection();
      // 从页面外的空白处开始拖：不算选择（否则浏览器会从最近的文字锚定，一拖就一大片）
      if (drag && !drag.inPage) {
        if (sel && !sel.isCollapsed) sel.removeAllRanges();
        if (lastSelectionRef.current) {
          lastSelectionRef.current = null;
          onSelection(null);
        }
        return;
      }

      // 松手时先夹一次，**再延迟补夹一次**：浏览器会把排队的 mousemove 在 mouseup 之后才
      // 应用完（选区随之暴涨），同步那一次夹不住它。
      const mx = me.clientX ?? 0;
      const my = me.clientY ?? 0;
      pointerRef.x = mx;
      pointerRef.y = my;
      if (manual) {
        finishManual(mx, my);
        manualAnchor = null;
        manualPage = null;
        manualEnd = null;
      } else if (sel && !sel.isCollapsed) {
        // 非手动路径（例如从空白处起拖）：仍做一次夹取，并在松手后继续看护一小会儿
        guardUntil = Date.now() + 700;
        clampSelection(mx, my, drag?.x ?? mx, drag?.y ?? my);
      }
      manualAnchor = null;
      manualPage = null;
      manualEnd = null;

      // 没有选中文字时，先看是不是点在已有批注上
      const pageEl = (target as HTMLElement).closest?.('.rd-pdf-page') as HTMLElement | null;
      if (pageEl) {
        const selNow = window.getSelection();
        const hasText = !!selNow && !selNow.isCollapsed && selNow.toString().trim().length > 0;
        if (!hasText) {
          const ann = hitTestAnnotation(pageEl, me.clientX ?? 0, me.clientY ?? 0);
          if (ann) {
            onSelectAnnotationRef.current(ann, pageEl.getBoundingClientRect());
            return;
          }
        }
      }
      window.setTimeout(collectSelection, 10);
    };
    const onKeyUp = (ev: Event) => {
      const ke = ev as KeyboardEvent;
      if (ke.shiftKey || ke.key === 'Shift') window.setTimeout(collectSelection, 10);
    };
    /** 拖动过程中记录"指针划过的最后一段文字"，并**持续把选区夹在起始页内**。
     *  持续夹是必须的：浏览器的选区扩展是异步的（排队的 mousemove 会在 mouseup 之后才应用完），
     *  只在 mouseup 里夹一次等于没夹——实测松手后选区会从 1 个字暴涨到 4668 个字（跨 3 页）。*/
    let lastClampAt = 0;
    const onMove = (ev: Event) => {
      const me = ev as MouseEvent;
      const drag = dragRef.current;
      // 注意：**不要**用 `buttons & 1` 判断是否在拖动。某些输入路径（合成事件、极快的拖动）
      // 的 mousemove 不带 buttons 位，一旦因此 return，手动划词就永远拿不到终点 →
      // 表现成"选了 0 个字、划词工具条不弹"。dragRef 在 mouseup 时清空，用它判断更可靠。
      if (!drag) return;
      const x = me.clientX ?? 0;
      const y = me.clientY ?? 0;
      pointerRef.x = x;
      pointerRef.y = y;
      const caret = textCaretAt(x, y);
      if (caret?.inText) {
        lastTextRef.current = { node: caret.range.startContainer, offset: caret.range.startOffset, page: caret.pageEl };
      }
      // 手动划词：终点只跟着"指针真正划过的位置"走（按行取点），且不跨出起始页
      if (manual && manualPage) {
        const pos = lineAwarePos(manualPage, x, y);
        if (pos) manualEnd = pos;
        applyManual();
        return;
      }
      const now = Date.now();
      if (now - lastClampAt < 60) return; // 节流：逐字 span 的页面上别每一像素都算
      lastClampAt = now;
      clampSelection(x, y, drag.x, drag.y);
    };
    const onDown = (ev: Event) => {
      const me = ev as MouseEvent;
      const target = ev.target as HTMLElement | null;
      const inPage = !!target?.closest('.rd-pdf-page');
      anchorPageEl = inPage ? (target?.closest('.rd-pdf-page') as HTMLElement) : null;
      dragStartRef.x = me.clientX ?? 0;
      dragStartRef.y = me.clientY ?? 0;
      // 按下点在某一页的文字范围内 → 进入手动划词模式（按行取点，见 lineAwarePos）
      const downPage = inPage ? (target?.closest('.rd-pdf-page') as HTMLElement | null) : null;
      lastPos = null; // 新的一次拖动：起始位置必须由按下点自己决定
      let downPos = downPage ? lineAwarePos(downPage, me.clientX ?? 0, me.clientY ?? 0) : null;
      if (!downPos) {
        // 兜底：有些期刊 PDF 的 caret 会落在文本层容器上，但**指针底下那个 span** 是拿得到的
        const sp = target?.closest?.('.rd-pdf-text span') as HTMLElement | null;
        if (sp) downPos = posInSpan(sp, me.clientX ?? 0);
      }
      if (downPos) lastPos = downPos;
      if (downPos && downPage) {
        manual = true;
        manualAnchor = downPos;
        manualPage = downPage;
        manualEnd = manualAnchor;
        manualRange = null;
        manualText = '';
      } else {
        manual = false;
        manualAnchor = null;
        manualPage = null;
        manualEnd = null;
      }
      // 右键（以及中键）完全不动拖选状态与已打开的浮层：
      // 右键菜单要靠当前选区决定菜单内容，之后复制/标注也还要用它，
      // 所以这里连"把选区按塌"这个浏览器默认动作都要拦掉。
      if (typeof me.button === 'number' && me.button !== 0) {
        if (inPage) me.preventDefault();
        return;
      }
      dragRef.current = {
        inPage,
        x: me.clientX ?? 0,
        y: me.clientY ?? 0,
      };
      lastTextRef.current = null; // 新的一次拖动，清掉上一轮"划过文字"的记录
      // 任何一次按下都先收掉上一次的划词浮层（跟浏览器一样）：
      // 否则"选中 A → 工具条还在 → 单击高亮 B"会让 A 的工具条残留在卡片旁边，
      // 再点「高亮」就会为 A 重复建一条批注。
      // 例外：按在浮层自己身上（工具条/批注卡片/右键菜单）时绝不能收，
      // 否则按钮还没收到 click 就被卸载，选区也跟着没了。
      const onOverlay = !!target?.closest('.rd-sel-toolbar, .rd-ann-card, .rd-ctx-menu');
      if (!onOverlay && lastSelectionRef.current) {
        lastSelectionRef.current = null;
        onSelection(null);
      }
    };
    /** 松手后继续看护到什么时候（浏览器会把排队的移动在 mouseup 之后才应用完，实测 1 字 → 4668 字） */
    let guardUntil = 0;
    /** 夹取中标志：夹取本身会触发 selectionchange，别递归 */
    let clamping = false;

    /**
     * 选区看护：拖动中、以及松手后的看护窗口内，只要浏览器改动选区就夹一次。
     * 只靠 mousemove / mouseup 抓不住它——浏览器的扩展是异步的（见 clampSelection 注释）。
     */
    const onSelectionChange = () => {
      if (clamping) return;
      // 手动划词的选区归我们管：浏览器一改就覆盖回去（拖动中 + 松手后 0.7s）
      if (manualText && (manual || Date.now() <= guardUntil)) {
        const sel = window.getSelection();
        if (sel && sel.toString() !== manualText && manualRange && Date.now() - lastManualAt > 8) {
          clamping = true;
          try {
            sel.removeAllRanges();
            sel.addRange(manualRange);
            lastManualAt = Date.now();
          } finally {
            clamping = false;
          }
        }
        if (manual) return;
      }
      if (!dragRef.current && Date.now() > guardUntil) return;
      clamping = true;
      try {
        clampSelection(pointerRef.x, pointerRef.y, dragStartRef.x, dragStartRef.y);
      } finally {
        clamping = false;
      }
    };

    /**
     * 原生拖拽路径（实测：在 PDF 文本上拖选时 Chromium 会启动 drag-and-drop，
     * **拖拽期间完全不派发 mouseup**：selectstart → dragstart → drag×N → dragend）。
     * 于是 mouseup 收尾永远不执行，原生选区会一路扩到后面几页（用户报的"移到空白就全选"），
     * 划词工具条也不会弹。所以拖拽事件必须当成一等公民：drag 里更新终点、dragend 里收尾。
     */
    const onDrag = (ev: Event) => {
      if (!dragRef.current) return;
      const me = ev as MouseEvent;
      const x = me.clientX ?? 0;
      const y = me.clientY ?? 0;
      pointerRef.x = x;
      pointerRef.y = y;
      const caret = textCaretAt(x, y);
      if (!caret?.inText) return;
      lastTextRef.current = { node: caret.range.startContainer, offset: caret.range.startOffset, page: caret.pageEl };
      if (manual && manualPage) {
        const pos = lineAwarePos(manualPage, x, y);
        if (pos) manualEnd = pos;
        applyManual();
      }
    };

    const onDragEnd = (ev: Event) => {
      const me = ev as MouseEvent;
      const mx = me.clientX ?? pointerRef.x;
      const my = me.clientY ?? pointerRef.y;
      if (manual) {
        finishManual(mx, my);
        manualAnchor = null;
        manualPage = null;
        manualEnd = null;
      } else {
        clampSelection(mx, my, dragStartRef.x, dragStartRef.y);
        guardUntil = Date.now() + 700;
      }
      dragRef.current = null;
      manualAnchor = null;
      manualPage = null;
      manualEnd = null;
      window.setTimeout(collectSelection, 10);
    };

    /**
     * 禁止 PDF 文本层里的原生拖拽（与 CSS 的 `-webkit-user-drag: none` 双保险）。
     * 一旦让 Chromium 启动 drag-and-drop，**mouseup 就不会派发**：
     * 选区收尾、划词工具条、批注都跟着失效，而原生选区会一路扩到后面几页。
     */
    const onDragStart = (ev: Event) => {
      const target = ev.target as HTMLElement | null;
      if (!target?.closest?.('.rd-pdf-page')) return;
      // 不阻止默认行为：拦住它反而可能让 mouseup 也不来（见上面注释）。
      // 这里只把"把文字拖成外部拖拽负载"的能力收掉，避免误拖出东西。
      try {
        (ev as DragEvent).dataTransfer?.setData('text/plain', '');
      } catch {
        /* ignore */
      }
    };

    const root: EventTarget = scrollRef.current?.parentElement ?? document;
    root.addEventListener('mouseup', onUp, true);
    root.addEventListener('mousemove', onMove);
    root.addEventListener('keyup', onKeyUp);
    root.addEventListener('mousedown', onDown, true);
    document.addEventListener('selectionchange', onSelectionChange);
    root.addEventListener('dragstart', onDragStart, true);
    root.addEventListener('drag', onDrag);
    root.addEventListener('dragend', onDragEnd);
    return () => {
      root.removeEventListener('mouseup', onUp, true);
      root.removeEventListener('mousemove', onMove);
      root.removeEventListener('keyup', onKeyUp);
      root.removeEventListener('mousedown', onDown, true);
      root.removeEventListener('dragstart', onDragStart, true);
      root.removeEventListener('drag', onDrag);
      root.removeEventListener('dragend', onDragEnd);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
    // 依赖里**只放 collectSelection**（它现在身份稳定）。
    // 曾经把 onSelection 也放进来：父级每次渲染都传新函数 → 这个 effect 反复重订阅，
    // 里面所有"手动划词"的局部状态被重置，用户拖完选不中字、划词工具条也不弹。
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
   * 不改动当前选区、也不触发划词收集（选区依旧由划词逻辑与 clampSelection 掌管）。
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

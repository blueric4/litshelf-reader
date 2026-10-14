/**
 * 阅读器外壳：顶部工具栏 + 正文区 + 右侧面板 + 文内搜索面板。
 * 自己从 store 取 readerId，无 props。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation, AnnotationRect, AnnotationType, HighlightColor, Item, ReadingProgress } from '@shared/types';
import { api, copyText } from '../bridge';
import { useStore } from '../state/store';
import { formatBytes, subtitle } from '../utils/format';
import { EpubReader } from './EpubReader';
import { ImageReader } from './ImageReader';
import { PdfViewer } from './PdfViewer';
import { ReaderPanels, type OutlineEntry, type PanelTab } from './ReaderPanels';
import { AnnotationCard, SelectionToolbar } from './SelectionToolbar';
import type { ReaderContextCommand } from './contextCommands';
import { TextReader } from './TextReader';
import { useElementSize, useProgressSaver, type ReaderOutline } from './hooks';
import { countHits, snippetAround } from './search';
import { generateThumbnail, usePageGetter, usePdfDocument } from './pdf';
import { planReanchor, type PageTextMap } from './reanchor';
import type { MdHeading } from './markdown';
import './reader.css';

/** 键盘 / 工具条按钮的缩放档位：步子大一点，100% → 150% → 200% → 300% → 400% 四步到底 */
const ZOOM_STEPS = [0.25, 0.4, 0.6, 0.8, 1, 1.5, 2, 3, 4];
/** Ctrl+滚轮的细步进（乘性），滚起来跟手又不会一下跳太远 */
const WHEEL_ZOOM_RATIO = 1.15;

interface PendingSelection {
  text: string;
  rect: { left: number; top: number; right: number; bottom: number };
  pageEl: HTMLElement;
  page: number;
  rects: AnnotationRect[];
  anchor: { prefix: string; suffix: string; occurrence: number };
}

interface SearchHit {
  page: number;
  snippet: string;
}

interface ViewerHandle {
  goToPage: (page: number) => void;
}

export function ReaderView(): React.ReactElement | null {
  const readerId = useStore((s) => s.readerId);
  const readerTarget = useStore((s) => s.readerTarget);
  const item = useStore((s) => (readerId ? s.byId[readerId] ?? null : null));
  const settings = useStore((s) => s.settings);
  const capabilities = useStore((s) => s.capabilities);
  const closeReader = useStore((s) => s.closeReader);
  const jumpInReader = useStore((s) => s.jumpInReader);
  const patchLocal = useStore((s) => s.patchLocal);
  const pushToast = useStore((s) => s.pushToast);
  const updateSettings = useStore((s) => s.updateSettings);
  const allItems = useStore((s) => s.items);

  const isPdf = item?.kind === 'pdf';
  const isTextKind =
    item?.kind === 'markdown' || item?.kind === 'text' || item?.kind === 'html' || item?.kind === 'docx';

  // ---------------------------------------------------------------- 本地状态
  const [fit, setFit] = useState<'fit-width' | 'fit-page' | 'manual'>(
    typeof settings.defaultZoom === 'number' ? 'manual' : settings.defaultZoom,
  );
  const [zoom, setZoom] = useState(typeof settings.defaultZoom === 'number' ? settings.defaultZoom : 1);
  const [page, setPage] = useState(1);
  const [panelOpen, setPanelOpen] = useState(true);
  const [tab, setTab] = useState<PanelTab>('annotations');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchVersion, setSearchVersion] = useState(0);
  const [searchActive, setSearchActive] = useState(-1);
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pageInput, setPageInput] = useState('1');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationsLoading, setAnnotationsLoading] = useState(true);
  const [outline, setOutline] = useState<OutlineEntry[] | null>(null);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [mdHeadings, setMdHeadings] = useState<OutlineEntry[]>([]);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [selectedAnn, setSelectedAnn] = useState<{ annotation: Annotation; x: number; y: number } | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [hitCounts, setHitCounts] = useState<Map<number, number>>(new Map());
  /** `?` 打开的是 App 层的快捷键面板（文献库/阅读器共用同一个） */
  const showShortcuts = useStore((s) => s.showShortcuts);

  const [stageRef, stageSize] = useElementSize<HTMLDivElement>();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pdfHostRef, pdfHostSize] = useElementSize<HTMLDivElement>();
  const viewerRef = useRef<ViewerHandle | null>(null);
  const pageMapsRef = useRef<Map<number, PageTextMap>>(new Map());
  const flashTimer = useRef<number | null>(null);
  /** 缩放落盘防抖：见 applyZoom */
  const zoomWriteTimer = useRef<number | null>(null);
  const pendingZoomRef = useRef<number | null>(null);

  const pdf = usePdfDocument(isPdf ? item : null);
  const pageGetter = usePageGetter(pdf.doc);

  const themeAttr = settings.readerTheme;
  const totalPages = isPdf ? pdf.doc?.numPages ?? item?.pageCount ?? 0 : item?.kind === 'epub' ? 0 : 1;

  const outlineConfig: ReaderOutline = useMemo(
    () => ({
      total: totalPages,
      layout: isPdf ? settings.readerLayout : 'continuous',
      zoom,
      fit: isPdf ? fit : 'manual',
      gutter: 72,
      padding: 28,
      gap: 20,
    }),
    [totalPages, isPdf, settings.readerLayout, zoom, fit],
  );

  /** 展示用的实际缩放比（fit 模式下反算出来） */
  const effectiveZoom = useMemo(() => {
    if (!isPdf || fit === 'manual') return zoom;
    const size = pdf.sizes[0];
    if (!size || pdfHostSize.width <= 0) return zoom;
    const availW = Math.max(
      80,
      pdfHostSize.width - outlineConfig.padding * 2 - (settings.readerLayout === 'double' ? outlineConfig.gutter : 0),
    );
    const availH = Math.max(80, pdfHostSize.height - outlineConfig.padding * 2);
    if (fit === 'fit-page') return Math.min(availW / size.width, availH / size.height);
    const column = settings.readerLayout === 'double' ? size.width * 2 + 12 : size.width;
    return availW / column;
  }, [isPdf, fit, zoom, pdf.sizes, pdfHostSize, outlineConfig, settings.readerLayout]);

  const flash = useCallback((id: string) => {
    setFlashId(id);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashId(null), 1400);
  }, []);

  /**
   * 只写 ref，必须是稳定引用：之前这里传的是内联箭头函数，导致 PdfViewer 里
   * onMap/onDropMap 每次渲染都换身份 → 每一页的 canvas + 文本层被反复拆了重建 →
   * 拖动中选区锚点失效（"莫名乱选"）＋ 文本层间歇性空掉（"划不中词"）。
   */
  const handlePageMaps = useCallback((maps: Map<number, PageTextMap>) => {
    pageMapsRef.current = maps;
  }, []);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  // ---------------------------------------------------------------- 换文档
  useEffect(() => {
    if (!item) return;
    void api.markOpened(item.id).catch(() => undefined);
  }, [item?.id]);

  useEffect(() => {
    if (!item) return;
    const restored = item.progress?.page && item.progress.page > 0 ? item.progress.page : 1;
    setAnnotations([]);
    setAnnotationsLoading(true);
    setOutline(null);
    setSearchHits([]);
    setSearchInput('');
    setSearchQuery('');
    setSearchActive(-1);
    setSelectedAnn(null);
    setPending(null);
    setTextContent(null);
    setTextError(null);
    setPage(restored);
    setPageInput(String(restored));
    if (typeof item.progress?.zoom === 'number' && item.progress.zoom > 0 && typeof settings.defaultZoom === 'number') {
      setZoom(item.progress.zoom);
      setFit('manual');
    }
    pageMapsRef.current = new Map();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, item?.revision]);

  // ---------------------------------------------------------------- 进度
  const saveProgress = useCallback(
    (progress: Partial<ReadingProgress>) => {
      if (!item) return;
      void api.setProgress(item.id, progress).catch(() => undefined);
      patchLocal({
        ...item,
        readState: item.readState === 'unread' ? 'reading' : item.readState,
        progress: { ...item.progress, ...progress, updatedAt: Date.now() } as ReadingProgress,
      });
    },
    [item, patchLocal],
  );
  const progressSaver = useProgressSaver(item?.id ?? null, saveProgress);

  const handleProgress = useCallback(
    (data: { page: number; total: number; percent: number; scrollTop: number; zoom: number }) => {
      progressSaver.push(data);
      setPage((prev) => (prev === data.page ? prev : data.page));
    },
    [progressSaver],
  );

  // 卸载 / 换文档前 flush
  useEffect(() => () => progressSaver.flush(), [progressSaver]);

  // ---------------------------------------------------------------- 批注
  const annotationCount = item?.annotationCount ?? 0;
  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setAnnotationsLoading(true);
    api
      .listAnnotations(item.id)
      .then((list) => {
        if (!cancelled) setAnnotations(list);
      })
      .catch(() => {
        if (!cancelled) setAnnotations([]);
      })
      .finally(() => {
        if (!cancelled) setAnnotationsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item?.id, item?.revision, annotationCount]);

  const refreshAnnotations = useCallback(async () => {
    if (!item) return;
    try {
      setAnnotations(await api.listAnnotations(item.id));
    } catch {
      /* ignore */
    }
  }, [item?.id]);

  const createAnnotation = useCallback(
    async (input: {
      type: AnnotationType;
      page: number;
      rects: AnnotationRect[];
      text: string;
      anchor: { prefix: string; suffix: string; occurrence: number };
      comment?: string;
    }) => {
      if (!item) return;
      try {
        const created = await api.addAnnotation({
          itemId: item.id,
          type: input.type,
          page: input.page,
          rects: input.rects,
          text: input.text,
          anchor: input.anchor,
          comment: input.comment ?? '',
          color: settings.annotationColor,
        });
        setAnnotations((prev) => [...prev.filter((a) => a.id !== created.id), created]);
        window.getSelection()?.removeAllRanges();
        setPending(null);
        if (input.type === 'note') {
          setSelectedAnn({ annotation: created, x: window.innerWidth / 2, y: window.innerHeight / 3 });
        } else {
          pushToast({
            kind: 'success',
            message: input.type === 'bookmark' ? `已加书签：第 ${input.page} 页` : '已保存批注',
            ttl: 2000,
          });
        }
      } catch (err) {
        pushToast({ kind: 'error', message: '批注保存失败', detail: (err as Error).message });
      }
    },
    [item, settings.annotationColor, pushToast],
  );

  const updateAnnotation = useCallback(
    async (id: string, patchPartial: Partial<Annotation>) => {
      try {
        const updated = await api.updateAnnotation(id, patchPartial);
        if (updated) setAnnotations((prev) => prev.map((a) => (a.id === id ? updated : a)));
        else await refreshAnnotations();
      } catch (err) {
        pushToast({ kind: 'error', message: '批注更新失败', detail: (err as Error).message });
      }
    },
    [pushToast, refreshAnnotations],
  );

  const deleteAnnotation = useCallback(
    async (id: string) => {
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      setSelectedAnn((prev) => (prev?.annotation.id === id ? null : prev));
      try {
        await api.deleteAnnotation(id);
        if (item) patchLocal({ ...item, annotationCount: Math.max(0, item.annotationCount - 1) });
      } catch (err) {
        pushToast({ kind: 'error', message: '删除失败', detail: (err as Error).message });
        void refreshAnnotations();
      }
    },
    [item, patchLocal, pushToast, refreshAnnotations],
  );

  // ---------------------------------------------------------------- 重定位
  const reanchorStarted = useRef(false);
  useEffect(() => {
    if (!isPdf || !pdf.doc || reanchorStarted.current || annotationsLoading) return;
    const targets = annotations.filter((a) => a.needsReview && a.type !== 'bookmark');
    if (!targets.length) return;
    reanchorStarted.current = true;
    let cancelled = false;
    (async () => {
      const pageTexts = await api
        .getItemText(item!.id)
        .then((res) => res?.pages ?? null)
        .catch(() => null);
      let fixed = 0;
      for (const annotation of targets) {
        if (cancelled) return;
        try {
          const plan = await planReanchor(annotation, pageTexts, pageGetter, pageMapsRef.current);
          if (!plan) continue;
          if (plan.page === annotation.page && sameRects(plan.rects, annotation.rects)) continue;
          await api.reanchorAnnotation(annotation.id, plan.page, plan.rects, plan.text);
          fixed += 1;
        } catch {
          /* 单条失败不影响其它条 */
        }
      }
      if (!cancelled && fixed > 0) {
        await refreshAnnotations();
        pushToast({ kind: 'success', message: `已重新定位 ${fixed} 条批注`, ttl: 3600 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPdf, pdf.doc, annotations, annotationsLoading, item, pageGetter, refreshAnnotations, pushToast]);

  // ---------------------------------------------------------------- 缩略图
  const thumbStarted = useRef(false);
  useEffect(() => {
    if (!isPdf || !pdf.doc || !item || thumbStarted.current || item.thumb || !settings.thumbnails) return;
    thumbStarted.current = true;
    let cancelled = false;
    let tries = 0;
    const attempt = () => {
      tries += 1;
      // 用**当前**的条目（revision 可能已经变过）：宿主 saveThumb 在 revision 不匹配时会静默拒收，
      // 拿旧的 item 去存就是"封面偶发不生成"的常见原因。
      const fresh = useStore.getState().byId[item.id] ?? item;
      void generateThumbnail(pdf.doc as NonNullable<typeof pdf.doc>, fresh).then((saved) => {
        if (cancelled) return;
        if (saved) {
          patchLocal({ ...fresh, thumb: saved });
          return;
        }
        // 失败就退避重试（最多 3 次）；否则这一篇在整个会话里都不会有封面
        if (tries < 3) window.setTimeout(attempt, 2500 * tries);
        else thumbStarted.current = false; // 这次彻底放弃，等下次 deps 变化再试
      });
    };
    attempt();
    return () => {
      cancelled = true;
    };
  }, [isPdf, pdf.doc, item, settings.thumbnails, patchLocal]);

  // ---------------------------------------------------------------- 目录
  useEffect(() => {
    if (!isPdf || !pdf.doc) {
      setOutline(null);
      return;
    }
    let cancelled = false;
    setOutlineLoading(true);
    (async () => {
      try {
        const doc = pdf.doc!;
        const raw = await doc.getOutline();
        if (cancelled) return;
        let seq = 0;
        const convert = async (nodes: NonNullable<typeof raw>): Promise<OutlineEntry[]> => {
          const list: OutlineEntry[] = [];
          for (const node of nodes) {
            let target = 0;
            try {
              let dest = node.dest;
              if (typeof dest === 'string') dest = await doc.getDestination(dest);
              if (Array.isArray(dest) && dest.length) {
                const ref = dest[0] as unknown;
                if (ref && typeof ref === 'object' && 'num' in (ref as Record<string, unknown>)) {
                  target = (await doc.getPageIndex(ref as { num: number; gen: number })) + 1;
                } else if (typeof ref === 'number') {
                  target = ref + 1;
                }
              }
            } catch {
              target = 0;
            }
            const children = node.items?.length ? await convert(node.items as NonNullable<typeof raw>) : [];
            list.push({
              id: `o${seq++}`,
              title: (node.title ?? '').replace(/\s+/g, ' ').trim() || (target ? `第 ${target} 页` : '(未命名)'),
              page: target,
              depth: 0,
              children,
            });
          }
          return list;
        };
        const tree = await convert(raw ?? []);
        if (!cancelled) setOutline(tree);
      } catch {
        if (!cancelled) setOutline([]);
      } finally {
        if (!cancelled) setOutlineLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPdf, pdf.doc]);

  // ---------------------------------------------------------------- Markdown 标题 -> 目录面板
  const handleHeadings = useCallback((headings: MdHeading[]) => {
    setMdHeadings(headings.map((h) => ({ id: h.id, title: h.text, page: 0, depth: h.depth, children: [] })));
  }, []);

  /** 目录面板数据源：PDF 用 pdf.js outline，Markdown 用标题树 */
  const panelOutline = useMemo<OutlineEntry[] | null>(() => {
    if (isPdf) return outline;
    if (mdHeadings.length) {
      // 把标题按层级折成树
      const root: OutlineEntry[] = [];
      const stack: OutlineEntry[] = [];
      for (const entry of mdHeadings) {
        const node: OutlineEntry = { ...entry, children: [] };
        while (stack.length && stack[stack.length - 1].depth >= node.depth) stack.pop();
        if (stack.length) stack[stack.length - 1].children.push(node);
        else root.push(node);
        stack.push(node);
      }
      return root;
    }
    return outline;
  }, [isPdf, outline, mdHeadings]);

  // ---------------------------------------------------------------- 文本内容
  useEffect(() => {
    if (!item || !isTextKind) return;
    if (item.kind === 'docx') return; // docx 由 TextReader 自己取字节
    let cancelled = false;
    setTextLoading(true);
    setTextError(null);
    api
      .readTextFile(item.id)
      .then((res) => {
        if (cancelled) return;
        if (!res) {
          setTextContent(null);
          setTextError('文件太大或无法按文本读取。');
        } else {
          setTextContent(res.text);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setTextContent(null);
          setTextError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled) setTextLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item?.id, item?.revision, item?.kind, isTextKind]);

  // ---------------------------------------------------------------- 跳转目标
  const lastToken = useRef(-1);
  /**
   * 找到 PDF 真正的滚动容器。
   *
   * 血泪教训（task-14 探针实测）：上一版写的是 `document.querySelector('.rd-scroll') ?? scrollRef.current`，
   * 而 PDF 分支下**这两个都是空**：
   *   · 类名写错了 —— 真正的容器在 PdfViewer 里叫 `.rd-pdf-scroll`（grep 全仓没有 `.rd-scroll` 这个元素）；
   *   · `scrollRef` 只传给了 TextReader / EpubReader，PDF 分支下 `scrollRef.current` 是 null。
   * 于是 `scrollToPageY()` 在第一行 `if (!scroll) return` 就静默退出：页面被 `goToPage()` 跳到页首，
   * "那一句话"永远不滚进来（探针：批注距视口顶 1303px / 视口高 844px）。
   *
   * 所以这里不写死一个类名：先取 `.rd-pdf-scroll`，再从页槽往上找第一个"真的能滚"的祖先，
   * 最后才退回 scrollRef —— 以后再改 DOM 结构也不会静默失效。
   */
  const findPdfScroller = useCallback((): HTMLElement | null => {
    const canScroll = (el: HTMLElement | null): boolean =>
      !!el && el.scrollHeight > el.clientHeight + 2 && /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY);
    const direct = document.querySelector<HTMLElement>('.rd-pdf-scroll');
    if (canScroll(direct)) return direct;
    let el: HTMLElement | null =
      document.querySelector<HTMLElement>('.rd-page-slot') ?? document.querySelector<HTMLElement>('.rd-pdf-page');
    while (el && el !== document.body) {
      if (canScroll(el)) return el;
      el = el.parentElement;
    }
    if (canScroll(scrollRef.current)) return scrollRef.current;
    return direct; // 还没布局完（scrollHeight==clientHeight）：先返回它，让调用方下一拍再量
  }, []);

  /**
   * 把某一页的某个**页内纵向位置**（0–1，y 向下）**一次**滚到视口约 35% 高处。
   *
   * 为什么必须"一次"：点批注的路径里**不能再先调 `goToPage()`**。
   * `goToPage()` 会把页首对齐一次（`align(0)` + 80ms 后的复校），紧接着我们才把那句话抬到 35% 处，
   * 用户看到的就是"先跳到页首、再跳到句子"两段位移。
   * 实测（Lead 给的数字）：ΔscrollTop 2837 = 1829（页首对齐）+ 1008（句子校正），
   * 而且第一段会被 +80ms 复校顶回去，绕着校到第 5 拍（≈650ms）才停。
   *
   * 改成：按页槽几何**直接算绝对目标**，只发一次 `scrollTo({behavior:'smooth'})`
   *   target = 页槽在容器可视区内的偏移 + yRatio × 页槽高 − 0.35 × 视口高
   * 页码与渲染集合不靠这里维护：滚动上报（PdfViewer 的 scroll 监听 → onPageChange → currentPage）
   * 自然会跟上；调用方只需同时把 `page` / `pageInput` 设好。
   *
   * 只在"页槽/容器还没量出来"时短暂重试**测量**（60ms×≤10），绝不二次校正 —— 否则又是两段可见位移。
   */
  const scrollToPageY = useCallback(
    (pageNumber: number, yRatio: number) => {
      const ratio = Math.max(0, Math.min(1, Number.isFinite(yRatio) ? yRatio : 0));
      const slotSelector = `.rd-page-slot[data-page-index="${pageNumber - 1}"], .rd-pdf-page[data-page-index="${pageNumber}"]`;
      let tries = 0;
      const tick = () => {
        const scroll = findPdfScroller();
        const slot = scroll ? scroll.querySelector<HTMLElement>(slotSelector) : null;
        if (scroll && slot && slot.clientHeight > 0 && scroll.clientHeight > 0) {
          const sr = scroll.getBoundingClientRect();
          const pr = slot.getBoundingClientRect();
          // 批注那句话相对容器可视区顶部的距离（口径与探针一致：clientTop + clientHeight）
          const offsetInView = pr.top - (sr.top + scroll.clientTop) + ratio * slot.clientHeight;
          const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
          const target = Math.max(0, Math.min(max, scroll.scrollTop + offsetInView - scroll.clientHeight * 0.35));
          const from = Math.round(scroll.scrollTop);
          scroll.scrollTo({ top: target, behavior: 'smooth' });
          console.debug(
            `[reader] 批注跳转（一步到位）：第 ${pageNumber} 页 y=${ratio.toFixed(3)} → scrollTop ${from}→${Math.round(target)}（视口高 ${scroll.clientHeight}，页槽高 ${slot.clientHeight}）`,
          );
          return;
        }
        tries += 1;
        if (tries < 10) window.setTimeout(tick, 60);
      };
      tick();
    },
    [findPdfScroller],
  );

  useEffect(() => {
    if (!readerTarget || readerTarget.token === lastToken.current) return;
    lastToken.current = readerTarget.token;
    if (readerTarget.annotationId) {
      const found = annotations.find((a) => a.id === readerTarget.annotationId);
      if (found) {
        setTab('annotations');
        setPanelOpen(true);
        flash(found.id);
        if (isPdf && pdf.doc) {
          // **不调 goToPage()**：它会把页首对齐一次，用户就看到"先跳页、再跳句"两段位移。
          // 页码状态在这里直接摆正（工具条页码、书签位置都用它）；页面渲染集合与页码指示器
          // 由滚动上报（PdfViewer 的 scroll 监听 → onPageChange → currentPage）自己跟上。
          setPage(found.page);
          setPageInput(String(found.page));
          // 跳到"那一句话"而不只是那一页：按批注第一个矩形的 y 位置一次滚过去
          const y = found.rects[0]?.y ?? 0;
          scrollToPageY(found.page, y);
        }
        return;
      }
    }
    if (readerTarget.page) {
      setPage(readerTarget.page);
      setPageInput(String(readerTarget.page));
      if (isPdf && pdf.doc) viewerRef.current?.goToPage(readerTarget.page);
      else if (scrollRef.current && totalPages > 1) {
        const ratio = Math.max(0, Math.min(1, (readerTarget.page - 1) / Math.max(1, totalPages - 1)));
        const el = scrollRef.current;
        el.scrollTo({ top: ratio * (el.scrollHeight - el.clientHeight) });
      }
    }
  }, [readerTarget, annotations, isPdf, pdf.doc, totalPages, flash]);

  // ---------------------------------------------------------------- 文内搜索
  const runSearch = useCallback(
    async (raw: string, opts: { jump?: boolean } = {}) => {
      const query = raw.trim().replace(/\s+/g, ' ');
      setSearchQuery(query);
      setSearchVersion((v) => v + 1);
      if (!item || !query) {
        setSearchHits([]);
        setHitCounts(new Map());
        setSearchActive(-1);
        return;
      }
      if (!isPdf) return;
      setSearchLoading(true);
      try {
        let text = await api.getItemText(item.id);
        if (!text) {
          // 第一次搜这篇要先建索引（24 页约 0.2-1s），给个提示，别让用户以为没反应
          pushToast({ kind: 'info', message: '正在建立全文索引…', ttl: 2000 });
          await api.indexItemText(item.id);
          text = await api.getItemText(item.id);
        }
        if (!text) {
          setSearchHits([]);
          pushToast({ kind: 'warn', message: '这篇还没有全文索引，暂时列不出命中位置' });
          return;
        }
        const hits: SearchHit[] = [];
        text.pages.forEach((pageText, index) => {
          if (countHits(pageText, query) > 0) hits.push({ page: index + 1, snippet: snippetAround(pageText, query) });
        });
        setSearchHits(hits);
        setSearchActive(hits.length ? 0 : -1);
        if (hits.length && opts.jump) viewerRef.current?.goToPage(hits[0].page);
      } catch (err) {
        pushToast({ kind: 'error', message: '文内搜索失败', detail: (err as Error).message });
      } finally {
        setSearchLoading(false);
      }
    },
    [item, isPdf, pushToast],
  );

  const openSearch = useCallback(() => {
    setSearchOpen(true);    window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('.rd-search-panel input');
      input?.focus();
      input?.select();
    });
  }, []);

  const stepSearch = useCallback(
    (delta: number) => {
      if (!searchHits.length) return;
      const next = (searchActive + delta + searchHits.length) % searchHits.length;
      setSearchActive(next);
      const hit = searchHits[next];
      if (hit) viewerRef.current?.goToPage(hit.page);
    },
    [searchHits, searchActive],
  );

  /**
   * 边打边搜（防抖 300ms）。
   * 原先只有按 Enter 或点「查找」才真正搜，用户输入完看到的是"0 命中 + 计数空白"，
   * 观感就是"文内搜索坏了"。这里让输入即触发；`q === searchQuery` 判断避免自触发循环。
   */
  useEffect(() => {
    if (!searchOpen) return;
    const q = searchInput.trim();
    if (!q || q === searchQuery) return;
    const timer = window.setTimeout(() => {
      void runSearch(q);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput, searchOpen, searchQuery, runSearch]);

  // ---------------------------------------------------------------- 工具栏动作
  /**
   * 把批注写回 PDF 副本（标准 PDF 注释）。原文件不动，副本落在同一目录，
   * 成功/失败都走 toast；成功后再问一句"要不要在文件夹里显示"——不，直接给个提示就行。
   */
  const exportAnnotated = useCallback(async () => {
    if (!item) return;
    if (capabilities.mode !== 'electron') {
      pushToast({ kind: 'info', message: '浏览器形态不支持把批注写回 PDF', detail: '请用桌面版打开这一篇再导出' });
      return;
    }
    pushToast({ kind: 'info', message: '正在写入批注…', detail: item.name });
    const res = await api.exportAnnotatedPdf(item.id).catch(() => null);
    if (!res) {
      pushToast({ kind: 'warn', message: '没能写入批注副本', detail: '这一篇可能不是 PDF，或文件已不可读' });
      return;
    }
    if (res.written === 0) {
      pushToast({ kind: 'info', message: '这篇还没有可写回的批注', detail: res.path });
      return;
    }
    pushToast({
      kind: 'success',
      message: `已导出副本（${res.written} 条批注${res.skipped ? `，跳过 ${res.skipped} 条` : ''}）`,
      detail: res.path,
    });
  }, [item, capabilities.mode, pushToast]);

  const revealItem = useCallback(() => {
    if (!item) return;
    if (!capabilities.revealInFolder) {
      pushToast({ kind: 'info', message: '浏览器形态不支持在文件夹中显示', detail: item.path });
      return;
    }
    void api.revealItem(item.id).then((ok) => {
      if (!ok) pushToast({ kind: 'warn', message: '没能打开文件夹', detail: item.path });
    });
  }, [item, capabilities.revealInFolder, pushToast]);

  const openExternal = useCallback(() => {
    if (!item) return;
    if (!capabilities.openPath) {
      pushToast({ kind: 'info', message: '浏览器形态不支持调用系统程序', detail: item.path });
      return;
    }
    void api.openExternal(item.id).then((ok) => {
      if (!ok) pushToast({ kind: 'warn', message: '没能用系统程序打开', detail: item.path });
    });
  }, [item, capabilities.openPath, pushToast]);

  const copyCitation = useCallback(async () => {
    if (!item) return;
    try {
      const text = await api.copyCitation(item.id, 'gbt7714');
      const ok = await copyText(text);
      pushToast({ kind: ok ? 'success' : 'warn', message: ok ? '引用已复制' : '复制失败', detail: text.slice(0, 120) });
    } catch (err) {
      pushToast({ kind: 'error', message: '生成引用失败', detail: (err as Error).message });
    }
  }, [item, pushToast]);

  const rebuildIndex = useCallback(async () => {
    if (!item) return;
    try {
      const res = await api.indexItemText(item.id);
      patchLocal({ ...item, textIndexed: res.ok });
      pushToast({ kind: res.ok ? 'success' : 'warn', message: res.ok ? `已建立全文索引（${res.pages} 页）` : '索引失败' });
    } catch (err) {
      pushToast({ kind: 'error', message: '重建索引失败', detail: (err as Error).message });
    }
  }, [item, patchLocal, pushToast]);

  const toggleStar = useCallback(async () => {
    if (!item) return;
    const next = !item.starred;
    patchLocal({ ...item, starred: next });
    try {
      await api.updateItem(item.id, { starred: next });
    } catch {
      patchLocal({ ...item, starred: !next });
    }
  }, [item, patchLocal]);

  const cycleReadState = useCallback(async () => {
    if (!item) return;
    const order: Item['readState'][] = ['unread', 'reading', 'read'];
    const next = order[(order.indexOf(item.readState) + 1) % order.length];
    const prev = item.readState;
    patchLocal({ ...item, readState: next });
    try {
      await api.setReadState([item.id], next);
    } catch {
      patchLocal({ ...item, readState: prev });
    }
  }, [item, patchLocal]);

  const applyZoom = useCallback(
    (value: number) => {
      const next = Math.max(0.25, Math.min(4, value));
      setZoom(next);
      setFit('manual');
      // 连续缩放（按住快捷键 / 滚轮）时不要每一下都 IPC + 落盘 + 广播设置：
      // 那是"缩放很慢"的主因之一。这里只在停下来 350ms 后写一次；关阅读器时兜底 flush。
      pendingZoomRef.current = next;
      if (zoomWriteTimer.current !== null) window.clearTimeout(zoomWriteTimer.current);
      zoomWriteTimer.current = window.setTimeout(() => {
        zoomWriteTimer.current = null;
        const last = pendingZoomRef.current;
        pendingZoomRef.current = null;
        if (last !== null) void updateSettings({ defaultZoom: last });
      }, 350);
    },
    [updateSettings],
  );

  const zoomBy = useCallback(
    (dir: 1 | -1, fine = false) => {
      const current = fit === 'manual' ? zoom : effectiveZoom;
      if (fine) {
        // Ctrl+滚轮：乘性细步进，并按 1% 归整，避免出现 137.42% 这种标签
        const raw = dir > 0 ? current * WHEEL_ZOOM_RATIO : current / WHEEL_ZOOM_RATIO;
        applyZoom(Math.round(raw * 100) / 100);
        return;
      }
      let index = ZOOM_STEPS.findIndex((v) => v >= current - 0.001);
      if (index < 0) index = ZOOM_STEPS.length - 1;
      const atStep = Math.abs(ZOOM_STEPS[index] - current) < 0.005;
      const target = atStep ? index + dir : dir > 0 ? index : index - 1;
      applyZoom(ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, target))]);
    },
    [fit, zoom, effectiveZoom, applyZoom],
  );

  /**
   * Ctrl/⌘ + 滚轮缩放（和常见 PDF 阅读器一致）。
   * 必须用非 passive 监听并 preventDefault：否则 Chromium 会顺手把整个界面做浏览器级缩放，
   * 看起来就像"缩放不生效/界面变大"。
   */
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;
  useEffect(() => {
    // 触控板/高精度滚轮一秒钟能发几十个 wheel 事件：每个都缩一次会让可见页反复重启渲染，
    // 又卡又容易一下冲到 400%。这里按帧合并：同一帧里的 delta 累加，只应用一次（最多跨 2 步）。
    let pending = 0;
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (!pending) return;
      // deltaY < 0 = 往上滚 = 放大（和键盘 Ctrl+= 一致）
      const dir = pending < 0 ? 1 : -1;
      const steps = Math.min(2, Math.max(1, Math.round(Math.abs(pending) / 140)));
      pending = 0;
      for (let i = 0; i < steps; i += 1) zoomByRef.current(dir, true);
    };
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      const root = stageRef.current;
      if (!root || !root.contains(ev.target as Node)) return;
      if (ev.deltaY === 0) return;
      ev.preventDefault();
      // 单个事件钳制 ±240：触控板甩一下常给到上千，不钳就会一次冲到头
      pending += Math.max(-240, Math.min(240, ev.deltaY));
      if (!raf) raf = window.requestAnimationFrame(flush);
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('wheel', onWheel);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [stageRef]);

  // 关阅读器 / 卸载时把防抖里没写下去的缩放值补写一次，避免"刚缩完就关"丢失偏好
  useEffect(() => {
    return () => {
      if (zoomWriteTimer.current !== null) {
        window.clearTimeout(zoomWriteTimer.current);
        zoomWriteTimer.current = null;
      }
      const last = pendingZoomRef.current;
      pendingZoomRef.current = null;
      if (last !== null) void useStore.getState().updateSettings({ defaultZoom: last });
    };
  }, []);

  const addBookmark = useCallback(() => {
    if (!item) return;
    const scroller = scrollRef.current;
    const ratio =
      scroller && scroller.scrollHeight > scroller.clientHeight
        ? scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight)
        : 0;
    void createAnnotation({
      type: 'bookmark',
      page,
      rects: [{ x: 0.02, y: Math.max(0, Math.min(0.96, ratio)), w: 0.01, h: 0.01 }],
      text: `第 ${page} 页`,
      anchor: { prefix: '', suffix: '', occurrence: 1 },
      comment: '',
    });
  }, [item, page, createAnnotation]);

  const jumpTo = useCallback(
    (targetPage?: number, annotationId?: string, pageOnlyState = false) => {
      if (annotationId) {
        flash(annotationId);
        setTab('annotations');
      }
      if (targetPage) {
        setPage(targetPage);
        // pageOnlyState：只摆正页码状态，**不**把页首对齐（点批注那条路要一次滚到句子，
        // 否则先页首、再句子 = 两段可见位移；见 onOutlineJump / scrollToPageY 的说明）
        if (pageOnlyState) return;
        if (isPdf && pdf.doc) viewerRef.current?.goToPage(targetPage);
        else if (scrollRef.current && totalPages > 1) {
          const el = scrollRef.current;
          const ratio = Math.max(0, Math.min(1, (targetPage - 1) / Math.max(1, totalPages - 1)));
          el.scrollTo({ top: ratio * (el.scrollHeight - el.clientHeight), behavior: 'smooth' });
        }
      }
    },
    [flash, isPdf, pdf.doc, totalPages],
  );

  /** 目录面板点击：PDF 用页码，Markdown 用标题锚点（靠自定义事件让 TextReader 自己滚） */
  const onOutlineJump = useCallback(
    (targetPage?: number, annotationId?: string, entryId?: string) => {
      if (!isPdf && entryId) {
        window.dispatchEvent(new CustomEvent<string>('rd:scroll-to-heading', { detail: entryId }));
        setTab('outline');
        return;
      }
      // 带 annotationId（点侧栏批注）时**不要**在这里跳页：
      // `jumpTo` 会调 `goToPage()` 把页首对齐一次，紧接着 readerTarget effect 才滚到那句话，
      // 用户看到的就是"先跳页首、再跳句子"两段位移。这时只摆正页码状态，
      // 句子级的滚动交给 effect 里的 scrollToPageY（一次 smooth 到位）。
      jumpTo(targetPage, annotationId, Boolean(annotationId));
      if (annotationId) jumpInReader(targetPage, annotationId);
    },
    [isPdf, jumpTo, jumpInReader],
  );

  // ---------------------------------------------------------------- 键盘
  /**
   * 把当前划词选区标成指定类型。
   * 工具条按钮与数字键 1~4 共用同一条路径，避免两处各写一遍 rects/anchor 的组装。
   */
  const annotateSelection = useCallback(
    (type: Extract<AnnotationType, 'highlight' | 'underline' | 'squiggly' | 'strikeout'>) => {
      if (!pending) return;
      void createAnnotation({
        type,
        page: pending.page,
        rects: pending.rects,
        text: pending.text,
        anchor: pending.anchor,
      });
      setPending(null);
    },
    [pending, createAnnotation],
  );

  /**
   * 阅读器右键菜单（PdfViewer 里弹出）发回来的命令：复制/搜索/书签/适应宽度这些能力都在这一层。
   * 必须定义在 annotateSelection / addBookmark 之后——deps 数组在渲染期求值，提前引用会踩 TDZ。
   */
  const handleContextCommand = useCallback(
    (cmd: ReaderContextCommand) => {
      // 右键菜单的"有没有选区"由 PdfViewer 按 DOM 选区判断，而执行要靠这里的 pending；
      // 两者可能不同步（比如刚按 1 落过批注、pending 已清但 DOM 选区还在），
      // 所以这里必须**兜底**：能做的照做，做不了的要给出提示，绝不能静默无反应。
      const domText = () => window.getSelection()?.toString().trim() ?? '';
      switch (cmd.kind) {
        case 'annotate':
          if (pending) annotateSelection(cmd.type);
          else pushToast({ kind: 'warn', message: '这段选区已经失效，请重新选中文字再标注', ttl: 2600 });
          break;
        case 'copy-selection': {
          const text = pending?.text ?? domText();
          if (!text) {
            pushToast({ kind: 'warn', message: '没有可复制的选区', ttl: 2000 });
            break;
          }
          void copyText(text).then((ok) =>
            pushToast({ kind: ok ? 'success' : 'warn', message: ok ? '已复制选中文字' : '复制失败', ttl: 1600 }),
          );
          setPending(null);
          break;
        }
        case 'copy-selection-with-citation': {
          if (!item) break;
          const text = pending?.text ?? domText();
          if (!text) {
            pushToast({ kind: 'warn', message: '没有可复制的选区', ttl: 2000 });
            break;
          }
          void (async () => {
            try {
              const cite = await api.copyCitation(item.id, 'gbt7714');
              const ok = await copyText(`${text}\n\n${cite}`);
              pushToast({
                kind: ok ? 'success' : 'warn',
                message: ok ? '已复制（文字 + 引用）' : '复制失败',
                detail: cite.slice(0, 120),
              });
            } catch (err) {
              pushToast({ kind: 'error', message: '生成引用失败', detail: (err as Error).message });
            }
            setPending(null);
          })();
          break;
        }
        case 'search-selection': {
          const text = cmd.text || pending?.text || '';
          if (!text) break;
          setSearchInput(text);
          setSearchOpen(true);
          setPending(null);
          void runSearch(text, { jump: true });
          break;
        }
        case 'copy-citation':
          void copyCitation();
          break;
        case 'fit':
          setFit(cmd.mode);
          void updateSettings({ defaultZoom: cmd.mode });
          break;
        case 'bookmark':
          void addBookmark();
          break;
        default:
          break;
      }
    },
    [annotateSelection, pending, item, pushToast, runSearch, copyCitation, updateSettings, addBookmark],
  );

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        if (ev.key === 'Escape') target.blur();
        return;
      }
      const meta = ev.ctrlKey || ev.metaKey;
      if (meta && ev.key.toLowerCase() === 'f') {
        ev.preventDefault();
        openSearch();
        return;
      }
      if (meta && ev.key === '0') {
        ev.preventDefault();
        setFit('fit-width');
        void updateSettings({ defaultZoom: 'fit-width' });
        return;
      }
      // Ctrl/⌘ + = / - ：最常见的缩放快捷键（顺手把 Chromium 自带的整页缩放拦掉）
      if (meta && (ev.key === '=' || ev.key === '+' || ev.key === 'Add')) {
        ev.preventDefault();
        zoomBy(1);
        return;
      }
      if (meta && (ev.key === '-' || ev.key === '_' || ev.key === 'Subtract')) {
        ev.preventDefault();
        zoomBy(-1);
        return;
      }
      if (meta) return;
      // 长按不重复触发：书签 / 主题 / 全屏 / 翻页 / 快速标注都是"一次动作"，
      // 没有这道护栏时按住 b 一秒会落下十几条重复书签。
      if (ev.repeat) return;
      const scroll = scrollRef.current;
      switch (ev.key) {
        // 快速标注：选中文字后按 1~4 直接落批注，不用把鼠标甩到工具条上
        case '1':
        case '2':
        case '3':
        case '4': {
          if (!pending) break;
          const quick = (['highlight', 'underline', 'squiggly', 'strikeout'] as const)[Number(ev.key) - 1];
          ev.preventDefault();
          annotateSelection(quick);
          break;
        }
        case 'b':
        case 'B':
          ev.preventDefault();
          void addBookmark();
          break;
        case 't':
        case 'T': {
          ev.preventDefault();
          const order = ['light', 'sepia', 'dark'] as const;
          const next = order[(order.indexOf(settings.readerTheme) + 1) % order.length];
          void updateSettings({ readerTheme: next });
          pushToast({ kind: 'info', message: `阅读主题：${{ light: '浅色', sepia: '护眼', dark: '深色' }[next]}`, ttl: 1400 });
          break;
        }
        case '[':
          ev.preventDefault();
          if (isPdf && pdf.doc) viewerRef.current?.goToPage(Math.max(1, page - 1));
          else scroll?.scrollBy({ top: -scroll.clientHeight * 0.9 });
          break;
        case ']':
          ev.preventDefault();
          if (isPdf && pdf.doc) viewerRef.current?.goToPage(Math.min(totalPages, page + 1));
          else scroll?.scrollBy({ top: scroll.clientHeight * 0.9 });
          break;
        case 'f':
        case 'F':
          ev.preventDefault();
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen().catch(() => undefined);
          break;
        case '?':
          // 幂等地"打开"，不做 toggle：App 层也有一个 `?` 处理（文献库用），谁先注册会随
          // effect 重注册而变；两边都 toggle 的话会互相抵消（按一下开了又立刻关）。
          ev.preventDefault();
          ev.stopImmediatePropagation();
          useStore.setState({ showShortcuts: true });
          break;
        case 'ArrowLeft':
        case 'PageUp':
          ev.preventDefault();
          if (isPdf && pdf.doc) viewerRef.current?.goToPage(Math.max(1, page - 1));
          else scroll?.scrollBy({ top: -scroll.clientHeight * 0.9 });
          break;
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          ev.preventDefault();
          if (isPdf && pdf.doc) viewerRef.current?.goToPage(Math.min(totalPages, page + 1));
          else scroll?.scrollBy({ top: scroll.clientHeight * 0.9 });
          break;
        case 'Home':
          ev.preventDefault();
          if (isPdf && pdf.doc) viewerRef.current?.goToPage(1);
          else scroll?.scrollTo({ top: 0 });
          break;
        case 'End':
          ev.preventDefault();
          if (isPdf && pdf.doc) viewerRef.current?.goToPage(totalPages);
          else scroll?.scrollTo({ top: scroll?.scrollHeight ?? 0 });
          break;
        case '+':
        case '=':
          ev.preventDefault();
          zoomBy(1);
          break;
        case '-':
        case '_':
          ev.preventDefault();
          zoomBy(-1);
          break;
        case 'Escape': {
          // 有"自己会关"的浮层（快捷键面板 / 任何对话框）时，**必须让出**：
          // 它们的 keydown 监听器是打开时才注册的、排在我们后面，所以这里既不能拦事件
          // （stopImmediatePropagation 会把它们一起挡掉 → Esc 完全没反应），
          // 也不能顺手关别的浮层。判断依据用 DOM：面板/对话框都是 .modal-backdrop。
          const deferEscape = !!document.querySelector('.modal-backdrop') || useStore.getState().showShortcuts;
          ev.preventDefault();
          if (deferEscape) break;
          // 其余情况阅读器自己消费 Esc：先关内部浮层（更多菜单 / 搜索 / 批注卡片 / 划词工具条），
          // 都没有才返回列表。stopImmediatePropagation 是为了拦住 App 层的全局 Esc（"返回列表"），
          // 否则它会在同一按键里把整个阅读器关掉——卡片也就跟着没了。
          ev.stopImmediatePropagation();
          // 这里用 DOM 判断兜底：menuOpen 曾经漏在依赖数组里 → 闭包读到旧的 false →
          // Esc 会跳过"关菜单"直接走到 closeReader()，把阅读器一起关掉。
          if (menuOpen || document.querySelector('.rd-menu')) setMenuOpen(false);
          else if (searchOpen) setSearchOpen(false);
          else if (selectedAnn) setSelectedAnn(null);
          else if (pending) {
            setPending(null);
            window.getSelection()?.removeAllRanges();
          } else closeReader();
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    isPdf,
    pdf.doc,
    page,
    totalPages,
    zoomBy,
    searchOpen,
    selectedAnn,
    closeReader,
    openSearch,
    updateSettings,
    pending,
    annotateSelection,
    addBookmark,
    settings.readerTheme,
    pushToast,
    showShortcuts,
    menuOpen,
  ]);

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  if (!readerId || !item) return null;

  const siblings = allItems.filter((x) => x.kind === 'image' && x.dir === item.dir && !x.missing);

  const onSelectAnnotation = (annotation: Annotation, rect: DOMRect | null) => {
    setSelectedAnn({
      annotation,
      x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
      y: rect ? rect.bottom : window.innerHeight / 3,
    });
  };

  return (
    <div className="rd-root" data-reader-theme={themeAttr} ref={stageRef}>
      <header className="rd-toolbar">
        <button type="button" className="icon-btn rd-back" title="返回文献库（Esc）" onClick={closeReader}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m14 6-6 6 6 6" />
          </svg>
        </button>
        <div className="rd-title" title={item.title || item.name}>
          <div className="rd-title-main">{item.title || item.name}</div>
          <div className="rd-title-sub">{subtitle(item)}</div>
        </div>
        <button
          type="button"
          className={`icon-btn${item.starred ? ' is-star' : ''}`}
          title={item.starred ? '取消星标' : '加星标'}
          onClick={() => void toggleStar()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill={item.starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
            <path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.7l5.4-.8z" />
          </svg>
        </button>
        <button type="button" className="rd-state" title="切换阅读状态" onClick={() => void cycleReadState()}>
          {{ unread: '未读', reading: '在读', read: '已读' }[item.readState]}
        </button>

        <span className="rd-toolbar-gap" />

        {isPdf ? (
          <div className="rd-page-jump">
            {/*
              上一页 / 下一页按钮。
              为什么补这两个：这个工具栏原来**只有页码输入框**（没有翻页箭头），
              用户的原话是"必须点缩略图才能到那一页" —— 缩略图是唯一的图形化跳页入口。
              这两个按钮走同一个 goToPage，键盘/输入框的行为不变。
            */}
            <button
              type="button"
              className="icon-btn rd-page-step"
              title="上一页（↑ / PageUp）"
              disabled={page <= 1}
              onClick={() => viewerRef.current?.goToPage(Math.max(1, page - 1))}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 6-6 6 6 6" />
              </svg>
            </button>
            <input
              className="rd-page-input"
              value={pageInput}
              inputMode="numeric"
              aria-label="页码"
              onChange={(ev) => setPageInput(ev.target.value.replace(/[^\d]/g, ''))}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') {
                  const target = Number.parseInt(pageInput, 10);
                  if (Number.isFinite(target)) viewerRef.current?.goToPage(target);
                  (ev.target as HTMLInputElement).blur();
                }
              }}
              onBlur={() => setPageInput(String(page))}
            />
            <span className="rd-page-total">/ {totalPages || '—'}</span>
            <button
              type="button"
              className="icon-btn rd-page-step"
              title="下一页（↓ / PageDown）"
              disabled={!totalPages || page >= totalPages}
              onClick={() => viewerRef.current?.goToPage(Math.min(totalPages, page + 1))}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </button>
          </div>
        ) : (
          <span className="rd-page-total">{item.kind === 'epub' ? 'EPUB' : formatBytes(item.size)}</span>
        )}

        <div className="rd-zoom">
          <button type="button" className="icon-btn" title="缩小（-）" onClick={() => zoomBy(-1)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M6 12h12" />
            </svg>
          </button>
          <button type="button" className="rd-zoom-value" title="重置为 100%" onClick={() => applyZoom(1)}>
            {Math.round(effectiveZoom * 100)}%
          </button>
          <button type="button" className="icon-btn" title="放大（+）" onClick={() => zoomBy(1)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 6v12M6 12h12" />
            </svg>
          </button>
        </div>

        {isPdf ? (
          <>
            <button
              type="button"
              className={`rd-chip${fit === 'fit-width' ? ' is-on' : ''}`}
              title="适应宽度（Ctrl+0）"
              onClick={() => {
                setFit('fit-width');
                void updateSettings({ defaultZoom: 'fit-width' });
              }}
            >
              适宽
            </button>
            <button
              type="button"
              className={`rd-chip${fit === 'fit-page' ? ' is-on' : ''}`}
              title="适应页面"
              onClick={() => {
                setFit('fit-page');
                void updateSettings({ defaultZoom: 'fit-page' });
              }}
            >
              适页
            </button>
            <div className="rd-seg" role="group" aria-label="页面布局">
              {(['single', 'double', 'continuous'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={settings.readerLayout === mode ? 'is-on' : ''}
                  title={{ single: '单页', double: '双页', continuous: '连续滚动' }[mode]}
                  onClick={() => void updateSettings({ readerLayout: mode })}
                >
                  {{ single: '单', double: '双', continuous: '连' }[mode]}
                </button>
              ))}
            </div>
          </>
        ) : null}

        <button
          type="button"
          className="icon-btn"
          title="阅读主题：浅色 / 护眼 / 深色"
          onClick={() =>
            void updateSettings({
              readerTheme: settings.readerTheme === 'light' ? 'sepia' : settings.readerTheme === 'sepia' ? 'dark' : 'light',
            })
          }
        >
          {settings.readerTheme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="12" cy="12" r="4.2" />
              <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
            </svg>
          )}
        </button>
        <button type="button" className={`icon-btn${searchOpen ? ' active' : ''}`} title="文内搜索（Ctrl+F）" onClick={openSearch}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m15.5 15.5 4.5 4.5" />
          </svg>
        </button>
        <button type="button" className="icon-btn" title="加书签" onClick={addBookmark}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
            <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z" />
          </svg>
        </button>
        <button type="button" className={`icon-btn${panelOpen ? ' active' : ''}`} title="侧栏" onClick={() => setPanelOpen((v) => !v)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <path d="M15 4v16" />
          </svg>
        </button>
        <button
          type="button"
          className={`icon-btn${showShortcuts ? ' active' : ''}`}
          title="快捷键（?）"
          onClick={() => useStore.setState({ showShortcuts: true })}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.7v.3" />
            <path d="M12 17.2h.01" />
          </svg>
        </button>
        <div className="rd-more">
          <button
            type="button"
            className={`icon-btn${menuOpen ? ' active' : ''}`}
            title="更多"
            aria-expanded={menuOpen}
            onPointerDown={(ev) => {
              ev.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            // 键盘可达性：这个按钮原先只绑了 onPointerDown，Tab 聚焦后按 Enter/Space 打不开菜单。
            // 这里单独处理键盘（不再加 onClick，否则鼠标点击会 pointerdown+click 触发两次变成"开了又关"），
            // 并且 stopPropagation 免得 Space 又被阅读器当成"下一页"。
            onKeyDown={(ev) => {
              if (ev.key !== 'Enter' && ev.key !== ' ') return;
              ev.preventDefault();
              ev.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="6" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="18" cy="12" r="1.6" />
            </svg>
          </button>
          {menuOpen ? (
            <div className="rd-menu" onPointerDown={(ev) => ev.stopPropagation()}>
              <button type="button" className="menu-item" onClick={() => { setMenuOpen(false); revealItem(); }}>
                在文件夹中显示
              </button>
              <button type="button" className="menu-item" onClick={() => { setMenuOpen(false); openExternal(); }}>
                用系统程序打开
              </button>
              <div className="menu-sep" />
              <button type="button" className="menu-item" onClick={() => { setMenuOpen(false); void copyCitation(); }}>
                复制引用
              </button>
              <button
                type="button"
                className="menu-item"
                title="把这一篇的批注写成标准 PDF 注释，存成副本（原文件不动）；Acrobat / Zotero 里也能看到"
                onClick={() => { setMenuOpen(false); void exportAnnotated(); }}
              >
                导出带批注的 PDF 副本
              </button>
              <button type="button" className="menu-item" onClick={() => { setMenuOpen(false); void rebuildIndex(); }}>
                重建全文索引
              </button>
              <div className="menu-sep" />
              <div className="menu-label">阅读主题</div>
              {(['light', 'sepia', 'dark'] as const).map((theme) => (
                <button
                  key={theme}
                  type="button"
                  className="menu-item"
                  onClick={() => { setMenuOpen(false); void updateSettings({ readerTheme: theme }); }}
                >
                  {{ light: '浅色', sepia: '护眼', dark: '深色' }[theme]}
                  {settings.readerTheme === theme ? <span className="check">✓</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </header>

      <div className="rd-body">
        {searchOpen ? (
          <aside className="rd-search-panel">
            <div className="rd-search-head">
              <input
                className="input"
                placeholder="在本文中查找…"
                value={searchInput}
                onChange={(ev) => setSearchInput(ev.target.value)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') {
                    ev.preventDefault();
                    if (searchQuery === searchInput.trim() && searchHits.length) stepSearch(ev.shiftKey ? -1 : 1);
                    else void runSearch(searchInput, { jump: true });
                  }
                  if (ev.key === 'Escape') setSearchOpen(false);
                }}
              />
              <button type="button" className="icon-btn" title="关闭" onClick={() => setSearchOpen(false)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
            <div className="rd-search-actions">
              <button type="button" className="btn sm" onClick={() => void runSearch(searchInput, { jump: true })}>
                查找
              </button>
              <button type="button" className="icon-btn" title="上一处" disabled={!searchHits.length} onClick={() => stepSearch(-1)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="m6 14 6-6 6 6" />
                </svg>
              </button>
              <button type="button" className="icon-btn" title="下一处" disabled={!searchHits.length} onClick={() => stepSearch(1)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="m6 10 6 6 6-6" />
                </svg>
              </button>
              <span className="rd-search-count">
                {searchLoading ? '查找中…' : searchHits.length ? `${searchActive + 1} / ${searchHits.length} 处` : searchQuery ? '没有命中' : ''}
              </span>
            </div>
            <div className="rd-search-list">
              {searchHits.map((hit, index) => (
                <button
                  key={`${hit.page}-${index}`}
                  type="button"
                  className={`rd-search-hitrow${index === searchActive ? ' is-on' : ''}`}
                  onClick={() => {
                    setSearchActive(index);
                    viewerRef.current?.goToPage(hit.page);
                  }}
                >
                  <span className="rd-search-page">P{hit.page}</span>
                  <span className="rd-search-snippet">{hit.snippet}</span>
                </button>
              ))}
            </div>
          </aside>
        ) : null}

        <div className="rd-pane">
          {isPdf && pdf.error ? (
            <div className="rd-stage-center">
              <div className="rd-empty-card">
                <div className="rd-empty-title">这个 PDF 打不开</div>
                <div className="rd-empty-desc">{pdf.error}</div>
                <div className="rd-empty-actions">
                  <button type="button" className="btn primary" onClick={openExternal}>
                    用系统程序打开
                  </button>
                  <button type="button" className="btn" onClick={pdf.reload}>
                    重试
                  </button>
                  <button type="button" className="btn" onClick={revealItem}>
                    在文件夹中显示
                  </button>
                </div>
              </div>
            </div>
          ) : isPdf ? (
            <div className="rd-pdf-host" ref={pdfHostRef}>
              <PdfViewer
                item={item}
                doc={pdf.doc}
                sizes={pdf.sizes}
                sizesReady={pdf.sizesReady}
                containerRef={pdfHostRef}
                containerSize={pdfHostSize}
                outline={outlineConfig}
                annotations={annotations}
                loading={pdf.loading}
                loadProgress={pdf.progress}
                initialPage={page}
                degradedWorker={pdf.degraded}
                onReloadDoc={pdf.reload}
                onReady={(handle) => {
                  viewerRef.current = handle;
                }}
                onZoom={(value) => {
                  if (value === -1) {
                    setFit(fit === 'fit-width' ? 'fit-page' : 'fit-width');
                    return;
                  }
                  applyZoom(value);
                }}
                onPageChange={setPage}
                onProgress={handleProgress}
                onSelectAnnotation={onSelectAnnotation}
                onContextCommand={handleContextCommand}
                onSelection={(selection) => {
                  if (!selection) {
                    setPending((prev) => (prev ? null : prev));
                    return;
                  }
                  setPending(selection);
                }}
                flashId={flashId}
                searchQuery={searchQuery}
                searchVersion={searchVersion}
                searchActiveIndex={searchActive}
                onSearchHitCounts={setHitCounts}
                onPageMaps={handlePageMaps}
              />
            </div>
          ) : isTextKind ? (
            <div className="rd-doc-host">
              <TextReader
                item={item}
                annotations={annotations}
                text={textContent}
                loading={textLoading}
                readError={textError}
                scrollRef={scrollRef}
                zoom={zoom}
                onZoom={applyZoom}
                onSelectAnnotation={onSelectAnnotation}
                onSelection={(selection) => {
                  if (!selection) {
                    setPending((prev) => (prev ? null : prev));
                    return;
                  }
                  setPending({
                    text: selection.text,
                    rect: {
                      left: selection.rect.left,
                      top: selection.rect.top,
                      right: selection.rect.right,
                      bottom: selection.rect.bottom,
                    },
                    pageEl: selection.pageEl,
                    page: 1,
                    rects: selection.rects,
                    anchor: selection.anchor,
                  });
                }}
                flashId={flashId}
                searchQuery={searchQuery}
                searchVersion={searchVersion}
                onOpenExternal={openExternal}
                headingsOut={handleHeadings}
              />
            </div>
          ) : item.kind === 'image' ? (
            <div className="rd-doc-host">
              <ImageReader
                item={item}
                siblings={siblings}
                zoom={zoom}
                onZoom={applyZoom}
                fit={fit}
                onSelectItem={(next) => useStore.getState().openReader(next.id)}
                onOpenExternal={openExternal}
              />
            </div>
          ) : item.kind === 'epub' ? (
            <div className="rd-doc-host">
              <EpubReader
                item={item}
                scrollRef={scrollRef}
                onOpenExternal={openExternal}
                onProgress={(progress) => progressSaver.push(progress)}
                fontScale={zoom}
              />
            </div>
          ) : (
            <div className="rd-stage-center">
              <div className="rd-empty-card">
                <div className="rd-empty-title">{item.readable ? '暂时不能在这里打开' : '这种文件不能内置阅读'}</div>
                <div className="rd-empty-desc">
                  <div>{item.name}</div>
                  <div className="path-line">{item.path}</div>
                  <div>
                    {formatBytes(item.size)} · {item.ext ? item.ext.toUpperCase() : '未知类型'}
                  </div>
                </div>
                <div className="rd-empty-actions">
                  <button type="button" className="btn primary" onClick={openExternal}>
                    用系统程序打开
                  </button>
                  <button type="button" className="btn" onClick={revealItem}>
                    在文件夹中显示
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {panelOpen ? (
          <ReaderPanels
            tab={tab}
            onTab={setTab}
            item={item}
            pageGetter={pageGetter}
            annotations={annotations}
            annotationsLoading={annotationsLoading}
            outline={panelOutline}
            outlineLoading={outlineLoading}
            currentPage={page}
            totalPages={totalPages}
            activeAnnotationId={selectedAnn?.annotation.id ?? null}
            onJump={onOutlineJump}
            onDeleteAnnotation={(id) => void deleteAnnotation(id)}
            onUpdateAnnotation={(id, patchPartial) => void updateAnnotation(id, patchPartial)}
            onUpdateItem={async (patchPartial) => {
              try {
                const updated = await api.updateItem(item.id, patchPartial);
                patchLocal(updated);
                pushToast({ kind: 'success', message: '元数据已保存', ttl: 1800 });
              } catch (err) {
                pushToast({ kind: 'error', message: '保存失败', detail: (err as Error).message });
              }
            }}
            onReveal={revealItem}
            onOpenExternal={openExternal}
            onCompleteMetadata={() => {
              pushToast({ kind: 'info', message: '正在联网补全元数据…' });
              void api
                .completeMetadata([item.id])
                .then((res) => {
                  pushToast({
                    kind: res.updated ? 'success' : 'warn',
                    message: res.updated ? `元数据已更新 ${res.updated} 项` : '没有找到可用信息',
                  });
                  void api.getItem(item.id).then((fresh) => fresh && patchLocal(fresh));
                })
                .catch((err: Error) => pushToast({ kind: 'error', message: '联网补全失败', detail: err.message }));
            }}
            onRebuildIndex={() => void rebuildIndex()}
            searchOpen={searchOpen}
            hidePageTabs={item.kind === 'epub' || !item.readable}
          />
        ) : null}
      </div>

      {/* 快捷键面板由 App 层渲染（文献库与阅读器共用），这里不再单独挂一个 */}
      {pending ? (
        <SelectionToolbar
          anchor={pending.rect}
          text={pending.text}
          color={settings.annotationColor}
          onColor={(color: HighlightColor) => void updateSettings({ annotationColor: color })}
          onAnnotate={(type) => {
            if (type === 'note') {
              const rect = pending.pageEl.getBoundingClientRect();
              void createAnnotation({
                type: 'note',
                page: pending.page,
                rects: [
                  {
                    x: Math.max(0, Math.min(0.97, (pending.rect.right - rect.left) / rect.width)),
                    y: Math.max(0, Math.min(0.97, (pending.rect.top - rect.top) / rect.height)),
                    w: 0.02,
                    h: 0.02,
                  },
                ],
                text: pending.text,
                anchor: pending.anchor,
                comment: '',
              });
              return;
            }
            // 工具条只给这四种；bookmark 走独立入口（工具栏的加书签按钮），这里防御性忽略
            if (type === 'bookmark') return;
            annotateSelection(type);
          }}
          onCopy={() => {
            void copyText(pending.text).then((ok) =>
              pushToast({ kind: ok ? 'success' : 'warn', message: ok ? '已复制' : '复制失败', ttl: 1600 }),
            );
            setPending(null);
          }}
          onSearch={() => {
            setSearchInput(pending.text);
            setSearchOpen(true);
            void runSearch(pending.text, { jump: true });
            setPending(null);
          }}
          onClose={() => setPending(null)}
        />
      ) : null}

      {selectedAnn ? (
        <AnnotationCard
          annotation={selectedAnn.annotation}
          x={selectedAnn.x}
          y={selectedAnn.y}
          onClose={() => setSelectedAnn(null)}
          onSaveComment={(comment) => void updateAnnotation(selectedAnn.annotation.id, { comment })}
          onColor={(color) => void updateAnnotation(selectedAnn.annotation.id, { color })}
          onDelete={() => void deleteAnnotation(selectedAnn.annotation.id)}
        />
      ) : null}

      {pending && pending.rects.length === 0 ? (
        <div className="rd-hint-bar">这段内容没被识别成可标注区域，可以换一段，或先用「复制」。</div>
      ) : null}

      <span className="rd-sr-only" aria-live="polite">
        第 {page} / {totalPages} 页 · {item.title || item.name}
        {hitCounts.size ? ` · 命中分布在 ${hitCounts.size} 页` : ''}
      </span>
    </div>
  );
}

function sameRects(a: AnnotationRect[], b: AnnotationRect[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((rect, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      Math.abs(rect.x - other.x) < 0.002 &&
      Math.abs(rect.y - other.y) < 0.002 &&
      Math.abs(rect.w - other.w) < 0.002 &&
      Math.abs(rect.h - other.h) < 0.002
    );
  });
}

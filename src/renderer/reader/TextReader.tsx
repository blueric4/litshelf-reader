/**
 * 文本类阅读视图：Markdown / 纯文本 / HTML / Word(docx) 共用一套排版与批注层。
 * md 走 marked + highlight.js + KaTeX；html/docx 走 DOMPurify；txt 保留换行。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation, AnnotationRect, AnnotationType, Item } from '@shared/types';
import { api } from '../bridge';
import { AnnotationLayer } from './AnnotationLayer';
import { escapeHtml, looksMonospaced, renderHtmlDocument, renderMarkdown, sanitize, type MdHeading } from './markdown';
import { buildAnchorFromOffsets } from './reanchor';

export interface TextReaderProps {
  item: Item;
  annotations: Annotation[];
  text: string | null;
  loading: boolean;
  readError: string | null;
  /** 阅读区滚动容器（由 ReaderView 拥有，这里作为渲染锚点） */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  onZoom: (zoom: number) => void;
  onSelectAnnotation: (annotation: Annotation, rect: DOMRect | null) => void;
  onSelection: (
    selection: {
      text: string;
      rect: DOMRect;
      pageEl: HTMLElement;
      rects: AnnotationRect[];
      anchor: { prefix: string; suffix: string; occurrence: number };
    } | null,
  ) => void;
  flashId: string | null;
  searchQuery: string;
  searchVersion: number;
  onOpenExternal: () => void;
  headingsOut?: (headings: MdHeading[]) => void;
}

/** 遍历容器内文本节点，得到某个 DOM 位置之前的总字符数 */
function offsetOfPoint(root: HTMLElement, node: Node, offset: number): number {
  let total = 0;
  let found = false;
  const walk = (current: Node): void => {
    if (found) return;
    if (current === node) {
      total += offset;
      found = true;
      return;
    }
    if (current.nodeType === Node.TEXT_NODE) {
      total += (current.textContent ?? '').length;
      return;
    }
    for (const child of Array.from(current.childNodes)) walk(child);
  };
  walk(root);
  return found ? total : -1;
}

function relRects(rects: DOMRectList | DOMRect[], pageRect: DOMRect): AnnotationRect[] {
  const out: AnnotationRect[] = [];
  for (const r of Array.from(rects)) {
    if (r.width <= 0.5 || r.height <= 0.5) continue;
    out.push({
      x: (r.left - pageRect.left) / pageRect.width,
      y: (r.top - pageRect.top) / pageRect.height,
      w: r.width / pageRect.width,
      h: r.height / pageRect.height,
    });
  }
  return out.slice(0, 64);
}

export function TextReader({
  item,
  annotations,
  text,
  loading,
  readError,
  scrollRef,
  zoom,
  onSelectAnnotation,
  onSelection,
  flashId,
  searchQuery,
  searchVersion,
  onOpenExternal,
  headingsOut,
}: TextReaderProps): React.ReactElement {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<'rendered' | 'source'>(item.kind === 'text' ? 'source' : 'rendered');
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [docxError, setDocxError] = useState<string | null>(null);

  useEffect(() => {
    setMode(item.kind === 'text' ? 'source' : 'rendered');
    setDocxHtml(null);
    setDocxError(null);
  }, [item.id, item.revision, item.kind]);

  // docx：mammoth 在浏览器端把 ArrayBuffer 转成 HTML
  useEffect(() => {
    if (item.kind !== 'docx') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(api.fileUrl(item.id, item.revision));
        if (!res.ok) throw new Error(`读取失败（HTTP ${res.status}）`);
        const buffer = await res.arrayBuffer();
        const mammoth = await import('mammoth');
        const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
        if (cancelled) return;
        setDocxHtml(sanitize(result.value));
      } catch (err) {
        if (!cancelled) setDocxError((err as Error).message || 'Word 文档解析失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.id, item.kind, item.revision]);

  const rendered = useMemo(() => {
    if (text === null) return { html: '', headings: [] as MdHeading[] };
    if (item.kind === 'markdown') {
      if (mode === 'source') {
        return { html: `<pre class="rd-raw">${escapeHtml(text)}</pre>`, headings: [] as MdHeading[] };
      }
      const result = renderMarkdown(text, { idPrefix: `rd-${item.id.slice(0, 6)}` });
      return { html: result.html, headings: result.headings };
    }
    if (item.kind === 'html') {
      if (mode === 'source') {
        return { html: `<pre class="rd-raw">${escapeHtml(text)}</pre>`, headings: [] as MdHeading[] };
      }
      return { html: renderHtmlDocument(text), headings: [] as MdHeading[] };
    }
    return { html: '', headings: [] as MdHeading[] };
  }, [text, item.kind, item.id, mode]);

  const { html, headings } = rendered;

  useEffect(() => {
    if (headings.length) headingsOut?.(headings);
  }, [headings, headingsOut]);

  // 目录面板点标题 -> 滚到锚点
  useEffect(() => {
    const handler = (ev: Event) => {
      const id = (ev as CustomEvent<string>).detail;
      const el = surfaceRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
      const scroller = scrollRef.current;
      if (!el || !scroller) return;
      const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTo({ top: scroller.scrollTop + delta - 24, behavior: 'smooth' });
    };
    window.addEventListener('rd:scroll-to-heading', handler as EventListener);
    return () => window.removeEventListener('rd:scroll-to-heading', handler as EventListener);
  }, [scrollRef]);

  const collectSelection = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      onSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer)) {
      onSelection(null);
      return;
    }
    const value = sel.toString().replace(/\s+/g, ' ').trim();
    if (!value) {
      onSelection(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const pageRect = surface.getBoundingClientRect();
    const full = surface.textContent ?? '';
    const start = offsetOfPoint(surface, range.startContainer, range.startOffset);
    const end = offsetOfPoint(surface, range.endContainer, range.endOffset);
    const anchor =
      start >= 0 && end > start
        ? buildAnchorFromOffsets(full, start, end - start)
        : { prefix: '', suffix: '', occurrence: 1 };
    onSelection({
      text: value,
      rect,
      pageEl: surface,
      rects: relRects(range.getClientRects(), pageRect),
      anchor,
    });
  }, [onSelection]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onUp = (ev: Event) => {
      const target = ev.target as Node | null;
      if (!target || !surfaceRef.current?.contains(target)) return;
      window.setTimeout(collectSelection, 10);
    };
    el.addEventListener('mouseup', onUp);
    el.addEventListener('keyup', onUp);
    return () => {
      el.removeEventListener('mouseup', onUp);
      el.removeEventListener('keyup', onUp);
    };
  }, [scrollRef, collectSelection]);

  const mono = item.kind === 'text' && text ? looksMonospaced(text) : false;

  if (loading) {
    return (
      <div className="rd-text-scroll" ref={scrollRef}>
        <div className="rd-text-inner">
          <div className="rd-skeleton-line w60" />
          <div className="rd-skeleton-line" />
          <div className="rd-skeleton-line" />
          <div className="rd-skeleton-line w80" />
        </div>
      </div>
    );
  }

  if (readError || text === null) {
    return (
      <div className="rd-text-scroll" ref={scrollRef}>
        <div className="rd-stage-center">
          <div className="rd-empty-card">
            <div className="rd-empty-title">读不到这个文件的内容</div>
            <div className="rd-empty-desc">{readError ?? '文件可能过大，或不是纯文本。可以用系统程序打开它。'}</div>
            <div className="rd-empty-actions">
              <button type="button" className="btn primary" onClick={onOpenExternal}>
                用系统程序打开
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const busy = item.kind === 'docx' && !docxHtml && !docxError;

  return (
    <div className="rd-text-scroll" ref={scrollRef}>
      {(item.kind === 'markdown' || item.kind === 'html') && (
        <div className="rd-text-toolbar">
          <div className="rd-seg">
            <button type="button" className={mode === 'rendered' ? 'is-on' : ''} onClick={() => setMode('rendered')}>
              渲染
            </button>
            <button type="button" className={mode === 'source' ? 'is-on' : ''} onClick={() => setMode('source')}>
              源码
            </button>
          </div>
          <span className="rd-text-toolbar-info">
            {mono ? '等宽' : '衬线'} · {text.length.toLocaleString('zh-CN')} 字
          </span>
        </div>
      )}
      <div className="rd-text-inner">
        <div
          ref={surfaceRef}
          className={`rd-read-surface rd-doc-${item.kind}${mono ? ' is-mono' : ''}`}
          style={{ fontSize: `${Math.round(15 * zoom)}px` }}
        >
          {item.kind === 'docx' ? (
            busy ? (
              <div className="rd-skeleton-line" />
            ) : docxError ? (
              <div className="rd-inline-error">
                <b>Word 解析失败</b>
                <span>{docxError}</span>
                <button type="button" className="btn sm" onClick={onOpenExternal}>
                  用系统程序打开
                </button>
              </div>
            ) : (
              <div className="rd-html-body" dangerouslySetInnerHTML={{ __html: docxHtml ?? '' }} />
            )
          ) : item.kind === 'text' ? (
            <pre className="rd-raw">{text}</pre>
          ) : (
            <div className="rd-html-body" dangerouslySetInnerHTML={{ __html: html }} />
          )}
          <AnnotationLayer
            annotations={annotations}
            page={1}
            onSelect={(annotation) => onSelectAnnotation(annotation, surfaceRef.current?.getBoundingClientRect() ?? null)}
            flashId={flashId}
          />
        </div>
      </div>
      <SearchOverlay surfaceRef={surfaceRef} query={searchQuery} version={searchVersion} />
    </div>
  );
}

/** 文本框内搜索：不改 DOM，用叠加层标注命中 */
function SearchOverlay({
  surfaceRef,
  query,
  version,
}: {
  surfaceRef: React.RefObject<HTMLDivElement | null>;
  query: string;
  version: number;
}): React.ReactElement | null {
  const [strips, setStrips] = useState<{ key: string; left: number; top: number; width: number; height: number }[]>([]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !query.trim()) {
      setStrips((prev) => (prev.length ? [] : prev));
      return;
    }
    const timer = window.setTimeout(() => {
      const needle = query.toLowerCase();
      const pageRect = surface.getBoundingClientRect();
      if (pageRect.width <= 0 || pageRect.height <= 0) return;
      const found: { key: string; left: number; top: number; width: number; height: number }[] = [];
      const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      let seq = 0;
      while (node) {
        const data = (node as Text).data;
        const haystack = data.toLowerCase();
        let from = 0;
        for (;;) {
          const at = haystack.indexOf(needle, from);
          if (at < 0) break;
          from = at + Math.max(1, needle.length);
          try {
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + needle.length);
            for (const r of Array.from(range.getClientRects())) {
              if (r.width <= 1 || r.height <= 1) continue;
              found.push({
                key: `s${seq++}`,
                left: ((r.left - pageRect.left) / pageRect.width) * 100,
                top: ((r.top - pageRect.top) / pageRect.height) * 100,
                width: (r.width / pageRect.width) * 100,
                height: (r.height / pageRect.height) * 100,
              });
            }
          } catch {
            /* 单个节点失败不影响其它 */
          }
          if (found.length > 400) break;
        }
        node = walker.nextNode();
      }
      setStrips(found);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [surfaceRef, query, version]);

  if (!strips.length) return null;
  return (
    <div className="rd-search-layer is-text" aria-hidden>
      {strips.map((strip) => (
        <span
          key={strip.key}
          className="rd-search-hit"
          style={{ left: `${strip.left}%`, top: `${strip.top}%`, width: `${strip.width}%`, height: `${strip.height}%` }}
        />
      ))}
    </div>
  );
}

export type { AnnotationType };

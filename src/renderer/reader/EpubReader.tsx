/**
 * EPUB 阅读视图：渲染层自己解 ZIP（DecompressionStream）+ 解析 OPF/spine。
 * 左侧章节目录，正文经 DOMPurify 渲染；章节内的相对图片已内联为 data URI。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Item, ReadingProgress } from '@shared/types';
import { api } from '../bridge';
import { parseEpub, type EpubBook } from './epub';
import { sanitize } from './markdown';
import { useScrollActivity } from './hooks';

export interface EpubReaderProps {
  item: Item;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onOpenExternal: () => void;
  onProgress: (progress: Partial<ReadingProgress>) => void;
  fontScale: number;
}

export function EpubReader({
  item,
  scrollRef,
  onOpenExternal,
  onProgress,
  fontScale,
}: EpubReaderProps): React.ReactElement {
  const [book, setBook] = useState<EpubBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chapter, setChapter] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef(onProgress);
  progressRef.current = onProgress;

  // 打开：进度里存的 scrollTop 用来还原章节
  const initialChapter = useMemo(() => {
    const raw = item.progress?.scrollTop;
    if (typeof raw === 'number' && raw >= 0 && raw < 1) return 0;
    const stored = Number.isFinite(raw) ? Math.round(raw) : 0;
    return stored > 0 ? stored : 0;
  }, [item.id, item.progress?.scrollTop]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBook(null);
    (async () => {
      try {
        const parsed = await parseEpub(api.fileUrl(item.id, item.revision));
        if (cancelled) return;
        setBook(parsed);
        setChapter(Math.min(initialChapter, Math.max(0, parsed.chapters.length - 1)));
        void api.markOpened(item.id).catch(() => undefined);
      } catch (err) {
        if (!cancelled) setError((err as Error).message || 'EPUB 解析失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.revision]);

  const chapters = book?.chapters ?? [];
  const current = chapters[chapter];

  const html = useMemo(() => {
    if (!current) return '';
    return sanitize(current.html);
  }, [current]);

  // 章节切换后回到顶部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  }, [chapter, scrollRef, html]);

  // 进度：章节内比例写进 scrollTop，百分比写进 percent
  useScrollActivity(
    scrollRef,
    () => undefined,
    (el) => {
      const total = chapters.length || 1;
      const ratio = el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0;
      progressRef.current({
        page: chapter + 1,
        total,
        percent: Math.max(0, Math.min(100, ((chapter + ratio) / total) * 100)),
        // 借用 scrollTop 存章节号（EPUB 没有页码概念，宿主只做透传）
        scrollTop: chapter + 1,
        zoom: fontScale,
      });
    },
    400,
  );

  const goChapter = useCallback(
    (index: number) => {
      setChapter(Math.max(0, Math.min(chapters.length - 1, index)));
    },
    [chapters.length],
  );

  // 章内链接：锚点滚动 / 跨章跳转
  const onBodyClick = useCallback(
    (ev: React.MouseEvent) => {
      const anchor = (ev.target as HTMLElement).closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      ev.preventDefault();
      if (href.startsWith('#')) {
        const id = href.slice(1);
        const target = bodyRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}, [name="${CSS.escape(id)}"]`);
        target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      const fileName = href.split('#')[0];
      const found = chapters.findIndex((c) => c.href.endsWith(fileName) || c.href === fileName);
      if (found >= 0) goChapter(found);
    },
    [chapters, goChapter],
  );

  if (loading) {
    return (
      <div className="rd-epub-scroll" ref={scrollRef}>
        <div className="rd-stage-center">
          <div className="rd-loading-card">
            <div className="rd-spinner" />
            <div className="rd-loading-title">正在解析 EPUB…</div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !book) {
    return (
      <div className="rd-epub-scroll" ref={scrollRef}>
        <div className="rd-stage-center">
          <div className="rd-empty-card">
            <div className="rd-empty-title">这个 EPUB 打不开</div>
            <div className="rd-empty-desc">{error ?? '解析失败，可能是加密或非标准的 EPUB 文件。'}</div>
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

  return (
    <div className="rd-epub">
      <nav className="rd-epub-toc" aria-label="章节目录">
        <div className="rd-epub-title" title={book.title || item.title || item.name}>
          {book.title || item.title || item.name}
        </div>
        {book.authors.length ? <div className="rd-epub-author">{book.authors.join('、')}</div> : null}
        <div className="rd-epub-chapters">
          {chapters.map((entry, index) => (
            <button
              key={`${entry.id}-${index}`}
              type="button"
              className={`rd-epub-chapter${index === chapter ? ' is-on' : ''}`}
              onClick={() => goChapter(index)}
            >
              <span className="rd-epub-chapter-no">{index + 1}</span>
              <span className="rd-epub-chapter-name" title={entry.title}>
                {entry.title}
              </span>
            </button>
          ))}
        </div>
      </nav>
      <div className="rd-epub-scroll" ref={scrollRef}>
        <div className="rd-epub-inner" style={{ fontSize: `${fontScale}em` }}>
          <div
            ref={bodyRef}
            className="rd-html-body rd-epub-body"
            onClick={onBodyClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <div className="rd-epub-nav">
            <button type="button" className="btn" disabled={chapter <= 0} onClick={() => goChapter(chapter - 1)}>
              上一节
            </button>
            <span className="rd-epub-nav-info">
              {chapter + 1} / {chapters.length}
            </span>
            <button
              type="button"
              className="btn"
              disabled={chapter >= chapters.length - 1}
              onClick={() => goChapter(chapter + 1)}
            >
              下一节
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 右侧四个面板：批注 / 目录 / 缩略图 / 信息。
 * 面板只负责展示与回调，所有数据由 ReaderView 注入。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { Annotation, HighlightColor, Item, ReadingProgress } from '@shared/types';
import { HIGHLIGHT_COLORS } from '@shared/types';
import { api, thumbUrl } from '../bridge';
import { formatBytes, formatDate, kindLabel, readStateLabel } from '../utils/format';

export type PanelTab = 'annotations' | 'outline' | 'thumbs' | 'info';

export interface OutlineEntry {
  id: string;
  title: string;
  page: number;
  depth: number;
  children: OutlineEntry[];
}

export interface ReaderPanelsProps {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  item: Item;
  annotations: Annotation[];
  annotationsLoading: boolean;
  outline: OutlineEntry[] | null;
  outlineLoading: boolean;
  currentPage: number;
  totalPages: number;
  activeAnnotationId: string | null;
  /** 跳转：PDF 用页码；Markdown 目录用 entryId（锚点 id） */
  onJump: (page?: number, annotationId?: string, entryId?: string) => void;
  onDeleteAnnotation: (id: string) => void;
  onUpdateAnnotation: (id: string, patch: Partial<Annotation>) => void;
  onUpdateItem: (patch: Partial<Item>) => Promise<void> | void;
  onReveal: () => void;
  onOpenExternal: () => void;
  onCompleteMetadata: () => void;
  onRebuildIndex: () => void;
  /** 文内搜索面板由 ReaderView 渲染，这里只负责切换 */
  searchOpen: boolean;
  /** 没有页面概念时（EPUB / 其它）隐藏目录与缩略图 Tab */
  hidePageTabs?: boolean;
  /** 取某一页的 pdf 页对象（懒加载 + 内部缓存）；非 PDF 时为空 */
  pageGetter?: (page: number) => Promise<PDFPageProxy | null>;
}

const TABS: { key: PanelTab; label: string }[] = [
  { key: 'annotations', label: '批注' },
  { key: 'outline', label: '目录' },
  { key: 'thumbs', label: '缩略图' },
  { key: 'info', label: '信息' },
];

export function ReaderPanels(props: ReaderPanelsProps): React.ReactElement {
  const { tab, onTab, annotations, hidePageTabs } = props;
  const pending = annotations.filter((a) => a.needsReview).length;
  const tabs = hidePageTabs ? TABS.filter((t) => t.key === 'annotations' || t.key === 'info') : TABS;

  return (
    <aside className="rd-side">
      <div className="rd-side-tabs" role="tablist">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            className={`rd-side-tab${tab === entry.key ? ' is-on' : ''}`}
            onClick={() => onTab(entry.key)}
          >
            {entry.label}
            {entry.key === 'annotations' && annotations.length ? <i className="rd-side-badge">{annotations.length}</i> : null}
            {entry.key === 'annotations' && pending ? <i className="rd-side-badge is-warn">{pending}</i> : null}
          </button>
        ))}
      </div>
      <div className="rd-side-body">
        {tab === 'annotations' ? <AnnotationsPanel {...props} /> : null}
        {tab === 'outline' ? <OutlinePanel {...props} /> : null}
        {tab === 'thumbs' ? <ThumbsPanel {...props} /> : null}
        {tab === 'info' ? <InfoPanel {...props} /> : null}
      </div>
    </aside>
  );
}

/** ------------------------------ 批注 ------------------------------ */

const TYPE_LABEL: Record<Annotation['type'], string> = {
  highlight: '高亮',
  underline: '下划线',
  squiggly: '波浪线',
  strikeout: '删除线',
  note: '批注',
  bookmark: '书签',
};

function AnnotationsPanel({
  annotations,
  annotationsLoading,
  currentPage,
  activeAnnotationId,
  onJump,
  onDeleteAnnotation,
  onUpdateAnnotation,
  searchOpen,
}: ReaderPanelsProps): React.ReactElement {
  const groups = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const annotation of annotations) {
      const list = map.get(annotation.page) ?? [];
      list.push(annotation);
      map.set(annotation.page, list);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [annotations]);

  const pending = annotations.filter((a) => a.needsReview);
  const bookmarks = annotations.filter((a) => a.type === 'bookmark');

  if (annotationsLoading) {
    return (
      <div className="rd-panel-pad">
        <div className="rd-skeleton-line" />
        <div className="rd-skeleton-line w80" />
      </div>
    );
  }

  if (!annotations.length) {
    return (
      <div className="rd-panel-empty">
        <div className="rd-empty-title">还没有批注</div>
        <div className="rd-empty-desc">
          在正文里划一段文字，顶部栏会变成标注工具条：高亮、下划线、波浪线、写批注都可以。
          {searchOpen ? '' : ' 也能用工具条的搜索按钮在文内查找。'}
        </div>
      </div>
    );
  }

  return (
    <div className="rd-panel-scroll">
      {pending.length ? (
        <section className="rd-ann-group">
          <header className="rd-ann-group-head is-warn">
            待确认 {pending.length} 条
            <span>文件更新后没能自动定位，请人工核对</span>
          </header>
          {pending.map((annotation) => (
            <AnnotationRow
              key={annotation.id}
              annotation={annotation}
              active={annotation.id === activeAnnotationId}
              onJump={onJump}
              onDelete={onDeleteAnnotation}
              onColor={(color) => onUpdateAnnotation(annotation.id, { color })}
            />
          ))}
        </section>
      ) : null}

      {bookmarks.length ? (
        <section className="rd-ann-group">
          <header className="rd-ann-group-head">书签</header>
          {bookmarks
            .slice()
            .sort((a, b) => a.page - b.page)
            .map((annotation) => (
              <AnnotationRow
                key={annotation.id}
                annotation={annotation}
                active={annotation.id === activeAnnotationId}
                onJump={onJump}
                onDelete={onDeleteAnnotation}
                onColor={(color) => onUpdateAnnotation(annotation.id, { color })}
              />
            ))}
        </section>
      ) : null}

      {groups.map(([page, list]) => {
        const rest = list.filter((a) => a.type !== 'bookmark' && !a.needsReview);
        if (!rest.length) return null;
        return (
          <section key={page} className="rd-ann-group">
            <header className={`rd-ann-group-head${page === currentPage ? ' is-current' : ''}`}>
              第 {page} 页
              <span>{rest.length} 条</span>
            </header>
            {rest.map((annotation) => (
              <AnnotationRow
                key={annotation.id}
                annotation={annotation}
                active={annotation.id === activeAnnotationId}
                onJump={onJump}
                onDelete={onDeleteAnnotation}
                onColor={(color) => onUpdateAnnotation(annotation.id, { color })}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function AnnotationRow({
  annotation,
  active,
  onJump,
  onDelete,
  onColor,
}: {
  annotation: Annotation;
  active: boolean;
  onJump: (page?: number, annotationId?: string) => void;
  onDelete: (id: string) => void;
  onColor: (color: HighlightColor) => void;
}): React.ReactElement {
  const [menu, setMenu] = useState(false);
  return (
    <article
      className={`rd-ann-row${active ? ' is-active' : ''}${annotation.needsReview ? ' is-review' : ''}`}
      onClick={() => onJump(annotation.page, annotation.id)}
    >
      <div className="rd-ann-row-top">
        <button
          type="button"
          className="rd-ann-row-page"
          onClick={(ev) => {
            ev.stopPropagation();
            onJump(annotation.page, annotation.id);
          }}
        >
          P{annotation.page}
        </button>
        <span className="rd-ann-row-type">{TYPE_LABEL[annotation.type]}</span>
        <span className="rd-ann-row-swatch" style={{ background: HIGHLIGHT_COLORS[annotation.color].light }} />
        <span className="rd-ann-row-grow" />
        <span className="rd-ann-row-date">{formatDate(annotation.updatedAt || annotation.createdAt)}</span>
        <button
          type="button"
          className="rd-ann-row-more"
          title="更多"
          onClick={(ev) => {
            ev.stopPropagation();
            setMenu((v) => !v);
          }}
        >
          ⋯
        </button>
      </div>
      {annotation.text ? <blockquote className="rd-ann-row-quote">{annotation.text}</blockquote> : null}
      {annotation.comment ? <p className="rd-ann-row-comment">{annotation.comment}</p> : null}
      {annotation.needsReview && annotation.reanchorNote ? (
        <p className="rd-ann-row-note">{annotation.reanchorNote}</p>
      ) : null}
      {menu ? (
        <div className="rd-ann-row-menu" onClick={(ev) => ev.stopPropagation()}>
          <div className="rd-ann-row-menu-colors">
            {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((name) => (
              <button
                key={name}
                type="button"
                className={`rd-swatch${name === annotation.color ? ' is-on' : ''}`}
                style={{ background: HIGHLIGHT_COLORS[name].light }}
                title={HIGHLIGHT_COLORS[name].label}
                aria-label={`颜色 ${HIGHLIGHT_COLORS[name].label}`}
                onClick={() => {
                  onColor(name);
                  setMenu(false);
                }}
              />
            ))}
          </div>
          <button
            type="button"
            className="rd-ann-row-delete"
            onClick={() => {
              onDelete(annotation.id);
              setMenu(false);
            }}
          >
            删除这条批注
          </button>
        </div>
      ) : null}
    </article>
  );
}

/** ------------------------------ 目录 ------------------------------ */

function OutlinePanel({ outline, outlineLoading, currentPage, onJump }: ReaderPanelsProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [visibleId, setVisibleId] = useState<string | null>(null);

  const flat = useMemo(() => {
    const list: { id: string; page: number }[] = [];
    const visit = (entry: OutlineEntry) => {
      list.push({ id: entry.id, page: entry.page });
      for (const child of entry.children) visit(child);
    };
    for (const entry of outline ?? []) visit(entry);
    return list;
  }, [outline]);

  const paginated = flat.some((entry) => entry.page > 0);

  // 有页码：最后一个 page <= currentPage 的条目
  const activeId = useMemo(() => {
    if (!paginated) return visibleId;
    let found: string | null = null;
    const visit = (entry: OutlineEntry) => {
      if (entry.page && entry.page <= currentPage) found = entry.id;
      for (const child of entry.children) visit(child);
    };
    for (const entry of outline ?? []) visit(entry);
    return found;
  }, [outline, currentPage, paginated, visibleId]);

  // 没有页码（Markdown 标题）：按当前滚动位置高亮最靠上的标题
  useEffect(() => {
    if (paginated || !flat.length) return;
    const tick = () => {
      let best: string | null = null;
      let bestTop = Number.NEGATIVE_INFINITY;
      for (const entry of flat) {
        const el = document.getElementById(entry.id);
        if (!el) continue;
        const top = el.getBoundingClientRect().top;
        if (top <= 120 && top > bestTop) {
          bestTop = top;
          best = entry.id;
        }
      }
      if (!best) best = flat[0]?.id ?? null;
      setVisibleId((prev) => (prev === best ? prev : best));
    };
    tick();
    const timer = window.setInterval(tick, 350);
    return () => window.clearInterval(timer);
  }, [paginated, flat]);

  if (outlineLoading) {
    return (
      <div className="rd-panel-pad">
        <div className="rd-skeleton-line" />
        <div className="rd-skeleton-line w60" />
      </div>
    );
  }

  if (!outline || !outline.length) {
    return (
      <div className="rd-panel-empty">
        <div className="rd-empty-title">没有目录</div>
        <div className="rd-empty-desc">
          这一篇没有可用的目录结构。可以用「缩略图」按页浏览，或用工具条的加书签按钮自己标记位置。
        </div>
      </div>
    );
  }

  const renderEntries = (entries: OutlineEntry[]): React.ReactElement => (
    <ul className="rd-outline-list">
      {entries.map((entry) => {
        const isCollapsed = collapsed.has(entry.id);
        return (
          <li key={entry.id}>
            <div className={`rd-outline-row${entry.id === activeId ? ' is-active' : ''}`}>
              {entry.children.length ? (
                <button
                  type="button"
                  className={`rd-outline-caret${isCollapsed ? '' : ' is-open'}`}
                  aria-label={isCollapsed ? '展开' : '收起'}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(entry.id)) next.delete(entry.id);
                      else next.add(entry.id);
                      return next;
                    })
                  }
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </button>
              ) : (
                <span className="rd-outline-dot" />
              )}
              <button type="button" className="rd-outline-title" title={entry.title} onClick={() => onJump(entry.page, undefined, entry.id)}>
                {entry.title}
              </button>
              {entry.page ? <span className="rd-outline-page">{entry.page}</span> : null}
            </div>
            {entry.children.length && !isCollapsed ? renderEntries(entry.children) : null}
          </li>
        );
      })}
    </ul>
  );

  return <div className="rd-panel-scroll rd-outline">{renderEntries(outline)}</div>;
}

/** ------------------------------ 缩略图 ------------------------------ */

/** 缩略图渲染宽度（CSS px；面板一列约 84–140px，取中间值最清晰又省内存） */
const THUMB_WIDTH = 132;

/** 把一页画到离屏 canvas 并转成 dataURL；失败返回 null（面板保留数字占位） */
async function renderThumb(page: PDFPageProxy, width: number): Promise<string | null> {
  try {
    const base = page.getViewport({ scale: 1 });
    if (!base.width || !base.height) return null;
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const canvasContext = canvas.getContext('2d');
    if (!canvasContext) return null;
    await page.render({ canvas, canvasContext, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}

const ThumbsPanel = memo(function ThumbsPanel({ item, totalPages, currentPage, onJump, pageGetter }: ReaderPanelsProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([1]));
  /** 已生成好的缩略图（页号 → dataURL） */
  const [thumbs, setThumbs] = useState<Map<number, string>>(() => new Map());
  /** 页号 → 渲染任务（缓存的是 promise，并发/重复进入视野都不会重复渲染） */
  const cacheRef = useRef<Map<number, Promise<string | null>>>(new Map());
  /** 串行队列：同一时刻最多渲染一张，快速滚动不会几十个 render 并发 */
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  /** 当前文档 id：换文档时用它作废旧任务与缓存 */
  const docIdRef = useRef(item.id);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-thumb-page]'));
    if (!nodes.length) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(new Set(nodes.map((n) => Number(n.dataset.thumbPage))));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          let next: Set<number> | null = null;
          for (const entry of entries) {
            const page = Number((entry.target as HTMLElement).dataset.thumbPage ?? '-1');
            if (page < 0) continue;
            if (entry.isIntersecting === prev.has(page)) continue;
            if (!next) next = new Set(prev);
            if (entry.isIntersecting) next.add(page);
            else next.delete(page);
          }
          return next ?? prev;
        });
      },
      { root, rootMargin: '500px 0px' },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [totalPages, item.id, item.thumb]);

  // 换文档：清空缓存与已生成的图，避免把上一篇的缩略图串到这一篇
  useEffect(() => {
    if (docIdRef.current === item.id) return;
    docIdRef.current = item.id;
    cacheRef.current.clear();
    queueRef.current = Promise.resolve();
    setThumbs(new Map());
  }, [item.id]);

  /**
   * 懒加载：只给"进入视野"的页生成缩略图。
   * - 第 1 页优先用宿主已经生成好的封面（item.thumb），不必再渲染一次；
   * - 其余页走 pageGetter（lead 从 ReaderView 注入），串行渲染；
   * - 没拿到 pageGetter 或渲染失败时保持数字占位，绝不空着。
   */
  useEffect(() => {
    if (!pageGetter) return;
    const docId = item.id;
    let cancelled = false;
    const targets = [...visible].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
    for (const page of targets) {
      if (cacheRef.current.has(page)) continue;
      const task = queueRef.current.then(async (): Promise<string | null> => {
        if (cancelled || docIdRef.current !== docId) return null;
        const pageProxy = await pageGetter(page);
        if (!pageProxy || cancelled || docIdRef.current !== docId) return null;
        return renderThumb(pageProxy, THUMB_WIDTH);
      });
      // 队列不因为单张失败而中断
      queueRef.current = task.then(
        () => undefined,
        () => undefined,
      );
      cacheRef.current.set(page, task);
      void task.then((url) => {
        // 关键：只有**真的产出图片**才算缓存成功。此前无论成败都把 promise 塞进 cacheRef，
        // 而滚动会让上一轮 effect 的 cleanup 把 cancelled 置真 → 已入队的任务返回 null →
        // 这一页却被记成"缓存过"，之后每轮都 continue 跳过它 → 永远停在数字占位
        // （用户报的"有的页死活没预览"就是这个）。作废/失败时把缓存删掉，让它下次能重来。
        if (!url || cancelled || docIdRef.current !== docId) {
          cacheRef.current.delete(page);
          return;
        }
        setThumbs((prev) => {
          if (prev.get(page) === url) return prev;
          const next = new Map(prev);
          next.set(page, url);
          return next;
        });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [visible, totalPages, item.id, pageGetter]);

  // 当前页滚动到视野里
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const node = root.querySelector<HTMLElement>(`[data-thumb-page="${currentPage}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [currentPage, totalPages]);

  if (totalPages <= 0) {
    return (
      <div className="rd-panel-empty">
        <div className="rd-empty-title">没有可预览的页面</div>
        <div className="rd-empty-desc">这个格式没有页面概念，可以到「信息」面板查看文件详情。</div>
      </div>
    );
  }

  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  const coverUrl = item.thumb ? thumbUrl(item.thumb) : null;

  return (
    <div className="rd-panel-scroll rd-thumbs" ref={scrollRef}>
      <div className="rd-thumbs-note">共 {totalPages} 页 · 点一下跳转</div>
      {pages.map((page) => {
        const url = thumbs.get(page) ?? (page === 1 ? coverUrl : null);
        return (
          <button
            key={page}
            type="button"
            data-thumb-page={page}
            className={`rd-thumb${page === currentPage ? ' is-on' : ''}`}
            onClick={() => onJump(page)}
            title={`第 ${page} 页`}
          >
            <span className="rd-thumb-box">
              {url ? (
                <img src={url} alt="" loading="lazy" decoding="async" />
              ) : visible.has(page) ? (
                <span className="rd-thumb-ghost">{page}</span>
              ) : (
                <span className="rd-thumb-ghost is-empty" />
              )}
            </span>
            <span className="rd-thumb-no">{page}</span>
          </button>
        );
      })}
    </div>
  );
});

/** ------------------------------ 信息 ------------------------------ */

function InfoPanel({
  item,
  totalPages,
  onUpdateItem,
  onReveal,
  onOpenExternal,
  onCompleteMetadata,
  onRebuildIndex,
}: ReaderPanelsProps): React.ReactElement {
  const [draft, setDraft] = useState({
    title: item.title,
    authors: item.authors.join('、'),
    year: item.year ? String(item.year) : '',
    venue: item.venue,
    doi: item.doi,
    arxivId: item.arxivId,
  });
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft({
      title: item.title,
      authors: item.authors.join('、'),
      year: item.year ? String(item.year) : '',
      venue: item.venue,
      doi: item.doi,
      arxivId: item.arxivId,
    });
    setDirty(false);
  }, [item.id, item.title, item.authors, item.year, item.venue, item.doi, item.arxivId]);

  const patch = (key: keyof typeof draft, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await onUpdateItem({
        title: draft.title.trim(),
        authors: draft.authors
          .split(/[、,;；]/)
          .map((s) => s.trim())
          .filter(Boolean),
        year: Number.parseInt(draft.year, 10) || null,
        venue: draft.venue.trim(),
        doi: draft.doi.trim(),
        arxivId: draft.arxivId.trim(),
      });
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rd-panel-scroll rd-info">
      <div className="rd-info-cover">
        {item.thumb ? (
          <img src={thumbUrl(item.thumb)} alt="" />
        ) : (
          <span className="rd-info-cover-ph">{(item.title || item.name).slice(0, 1)}</span>
        )}
      </div>

      <label className="rd-field">
        <span>标题</span>
        <input className="input" value={draft.title} onChange={(ev) => patch('title', ev.target.value)} />
      </label>
      <label className="rd-field">
        <span>作者</span>
        <input
          className="input"
          placeholder="多位作者用、分隔"
          value={draft.authors}
          onChange={(ev) => patch('authors', ev.target.value)}
        />
      </label>
      <div className="rd-field-row">
        <label className="rd-field">
          <span>年份</span>
          <input className="input" inputMode="numeric" value={draft.year} onChange={(ev) => patch('year', ev.target.value)} />
        </label>
        <label className="rd-field">
          <span>期刊 / 会议</span>
          <input className="input" value={draft.venue} onChange={(ev) => patch('venue', ev.target.value)} />
        </label>
      </div>
      <label className="rd-field">
        <span>DOI</span>
        <input className="input" value={draft.doi} onChange={(ev) => patch('doi', ev.target.value)} />
      </label>
      <label className="rd-field">
        <span>arXiv</span>
        <input className="input" value={draft.arxivId} onChange={(ev) => patch('arxivId', ev.target.value)} />
      </label>

      <div className="rd-info-actions">
        <button type="button" className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? '保存中…' : dirty ? '保存元数据' : '已保存'}
        </button>
        <button type="button" className="btn" onClick={onCompleteMetadata}>
          联网补全
        </button>
      </div>

      <dl className="rd-facts">
        <div>
          <dt>类型</dt>
          <dd>{kindLabel(item)}</dd>
        </div>
        <div>
          <dt>大小</dt>
          <dd>{formatBytes(item.size)}</dd>
        </div>
        <div>
          <dt>页数</dt>
          <dd>{totalPages || item.pageCount || '—'}</dd>
        </div>
        <div>
          <dt>阅读进度</dt>
          <dd>
            {Math.round(item.progress.percent)}%
            {item.progress.page ? ` · P${item.progress.page}` : ''}
          </dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>{readStateLabel(item.readState)}</dd>
        </div>
        <div>
          <dt>修改时间</dt>
          <dd>{formatDate(item.mtime)}</dd>
        </div>
        <div>
          <dt>批注</dt>
          <dd>{item.annotationCount} 条</dd>
        </div>
        <div>
          <dt>全文索引</dt>
          <dd>{item.textIndexed ? '已建立' : '未建立'}</dd>
        </div>
      </dl>

      <div className="rd-info-path path-line" title={item.path}>
        {item.path}
      </div>

      <div className="rd-info-actions">
        <button type="button" className="btn" onClick={onReveal}>
          在文件夹中显示
        </button>
        <button type="button" className="btn" onClick={onOpenExternal}>
          用系统程序打开
        </button>
        <button type="button" className="btn" onClick={onRebuildIndex}>
          {item.textIndexed ? '重建全文索引' : '建立全文索引'}
        </button>
      </div>
    </div>
  );
}

export type { ReadingProgress };

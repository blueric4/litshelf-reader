/**
 * 详情栏：封面 + 可编辑元数据 + 标签 + 操作按钮 + 信息/笔记/批注三个页签。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation, Item } from '@shared/types';
import { useStore } from '../state/store';
import { api, fileUrl, copyText } from '../bridge';
import { Cover, EmptyState, ProgressBar, TagChip, TagEditor } from './Bits';
import { confirmDialog, promptDialog, usePopup, type MenuItemDef } from './Overlays';
import {
  IconBookOpen,
  IconExternal,
  IconHighlight,
  IconLink,
  IconMore,
  IconNote,
  IconRefresh,
  IconStar,
  IconTrash,
  IconWarning,
} from './Icons';
import { formatBytes, formatDate, formatRelative, kindLabel, readStateLabel } from '../utils/format';

export function DetailPane() {
  const activeId = useStore((s) => s.activeId);
  const item = useStore((s) => (activeId ? s.byId[activeId] ?? null : null));
  const selection = useStore((s) => s.selection);
  const roots = useStore((s) => s.roots);

  if (!item) {
    return (
      <section className="dp">
        <EmptyState
          art={<IconBookOpen size={26} />}
          title="选一篇文献"
          desc="在左边点一条就能看详情；双击直接在软件里打开阅读，阅读位置会自动记住。"
        />
      </section>
    );
  }

  return <DetailBody item={item} multi={selection.length > 1} rootName={roots.find((r) => r.id === item.rootId)?.name ?? ''} />;
}

function DetailBody({ item, multi, rootName }: { item: Item; multi: boolean; rootName: string }) {
  const openReader = useStore((s) => s.openReader);
  const pushToast = useStore((s) => s.pushToast);
  const refresh = useStore((s) => s.refresh);
  const tags = useStore((s) => s.tags);
  const settings = useStore((s) => s.settings);
  const [tab, setTab] = useState<'info' | 'notes' | 'annotations'>('info');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(item.title);
  const popup = usePopup();

  useEffect(() => {
    setTitleDraft(item.title);
    setEditingTitle(false);
  }, [item.id, item.title]);

  const menu: MenuItemDef[] = [
    { header: true, label: item.name.slice(0, 30) },
    { label: '打开阅读', icon: <IconBookOpen size={13} />, onClick: () => void openReader(item.id) },
    { label: item.starred ? '取消星标' : '加入星标', icon: <IconStar size={13} />, onClick: () => void api.toggleStar([item.id]) },
    {
      label: `标记为${item.readState === 'read' ? '未读' : '已读'}`,
      onClick: () => void api.setReadState([item.id], item.readState === 'read' ? 'unread' : 'read'),
    },
    { separator: true },
    { label: '在文件夹中显示', icon: <IconExternal size={13} />, onClick: () => void api.revealItem(item.id) },
    { label: '用系统程序打开', onClick: () => void api.openExternal(item.id) },
    {
      label: '重新定位文件…',
      icon: <IconRefresh size={13} />,
      onClick: async () => {
        const caps = useStore.getState().capabilities;
        let picked: string | null = null;
        if (caps.nativeDialogs) {
          const res = await api.pickFolder().catch(() => []);
          if (res.length) picked = res[0];
        } else {
          picked = await promptDialog({ title: '输入新的文件夹路径', defaultValue: item.path.replace(/[\\/][^\\/]+$/, ''), confirmLabel: '定位' });
        }
        if (!picked) return;
        // 若选的是文件夹，补上原文件名
        const target = /\.[A-Za-z0-9]{1,8}$/.test(picked) ? picked : `${picked}\\${item.name}`;
        const res = await api.rebindItem(item.id, target);
        if (res) {
          pushToast({ kind: 'success', message: '已重新定位文件', detail: target });
          await refresh();
        } else {
          pushToast({ kind: 'error', message: '定位失败', detail: `找不到文件：${target}` });
        }
      },
    },
    { separator: true },
    {
      label: '补全元数据（联网）',
      onClick: async () => {
        pushToast({ kind: 'info', message: '正在联网补全…' });
        await api.completeMetadata([item.id]);
        await refresh();
      },
    },
    {
      label: '重新建立全文索引',
      onClick: async () => {
        const res = await api.indexItemText(item.id);
        pushToast({ kind: res.ok ? 'success' : 'warn', message: res.ok ? `已索引 ${res.pages} 页` : '索引失败（可能是不支持的格式）' });
        await refresh();
      },
    },
    { separator: true },
    {
      label: '从库中移除',
      danger: true,
      icon: <IconTrash size={13} />,
      onClick: async () => {
        const ok = await confirmDialog({
          title: '从库中移除这篇文献？',
          message: (
            <>
              只移除库里的记录（含笔记与批注），<strong>磁盘上的文件不会被删除</strong>。
            </>
          ),
          confirmLabel: '移除',
          danger: true,
        });
        if (ok) {
          await api.deleteItems([item.id]);
          pushToast({ kind: 'success', message: '已移除', action: { label: '撤销', name: 'deleteItems' } });
        }
      },
    },
  ];

  const saveTitle = async () => {
    setEditingTitle(false);
    const next = titleDraft.trim();
    if (next && next !== item.title) {
      await api.updateItem(item.id, { title: next });
      pushToast({ kind: 'success', message: '标题已更新', detail: '手动改过的标题不会被扫描覆盖' });
    }
  };

  return (
    <section className="dp">
      <div className="dp-scroll">
        <div className="dp-inner">
          {item.missing ? (
            <div className="banner" style={{ borderRadius: 12, marginBottom: 14 }}>
              <IconWarning size={15} />
              <span className="grow">
                原位置找不到这个文件了（{item.path}）。条目、笔记和批注都保留着——把文件放回去就会自动恢复。
              </span>
              <button
                className="btn sm"
                onClick={() => {
                  const entry = menu.find((m) => m.label === '重新定位文件…');
                  entry?.onClick?.();
                }}
              >
                重新定位
              </button>
            </div>
          ) : null}

          <div className="dp-hero">
            <Cover item={item} />
            <div className="dp-headline">
              {editingTitle ? (
                <input
                  className="dp-title-input"
                  value={titleDraft}
                  autoFocus
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveTitle();
                    if (e.key === 'Escape') {
                      setTitleDraft(item.title);
                      setEditingTitle(false);
                    }
                  }}
                />
              ) : (
                <h1
                  className="dp-title"
                  title="双击编辑标题"
                  onDoubleClick={() => setEditingTitle(true)}
                >
                  {item.title || item.name}
                </h1>
              )}
              <div className="dp-authors">
                {item.authors.length ? item.authors.join('、') : '作者未知'}
                {multi ? ` · 已选 ${useStore.getState().selection.length} 篇` : ''}
              </div>
              <div className="dp-facts">
                {item.year ? <span>{item.year}</span> : null}
                {item.venue ? <span>{item.venue}</span> : null}
                <span>{kindLabel(item)}</span>
                <span>{formatBytes(item.size)}</span>
                {item.wordCount ? <span>{item.wordCount.toLocaleString('zh-CN')} 字</span> : null}
                {item.doi ? (
                  <a
                    href={item.doi.startsWith('http') ? item.doi : `https://doi.org/${item.doi}`}
                    onClick={(e) => {
                      e.preventDefault();
                      void api.openExternal(item.id);
                    }}
                  >
                    DOI: {item.doi}
                  </a>
                ) : null}
                {item.arxivId ? <span>arXiv:{item.arxivId}</span> : null}
              </div>
              <TagEditor
                tags={item.tags}
                allTags={tags}
                onChange={async (next) => {
                  const added = next.filter((t) => !item.tags.includes(t));
                  const removed = item.tags.filter((t) => !next.includes(t));
                  if (added.length) await api.addTags([item.id], added);
                  if (removed.length) await api.removeTags([item.id], removed);
                  await refresh();
                }}
              />
            </div>
          </div>

          <div className="dp-actions">
            <button className="btn primary" onClick={() => void openReader(item.id)}>
              <IconBookOpen size={14} />
              {item.progress.percent > 0 && item.progress.percent < 100 ? `继续阅读 · 第 ${item.progress.page} 页` : '开始阅读'}
            </button>
            <button className="btn" onClick={() => void api.toggleStar([item.id])}>
              <IconStar size={14} filled={item.starred} />
              {item.starred ? '已星标' : '星标'}
            </button>
            <button
              className="btn"
              onClick={async () => {
                const text = await api.copyCitation(item.id, 'gbt7714');
                if (text) {
                  const ok = await copyText(text);
                  pushToast({ kind: ok ? 'success' : 'warn', message: ok ? '已复制引用' : '复制失败', detail: text });
                }
              }}
            >
              <IconLink size={14} />
              复制引用
            </button>
            <button className="btn" onClick={() => void api.revealItem(item.id)}>
              <IconExternal size={14} />
              在文件夹中显示
            </button>
            <button className="icon-btn" title="更多操作" onClick={(e) => popup.openFromEvent(e, menu)}>
              <IconMore size={16} />
            </button>
          </div>

          <div className="dp-card">
            <div className="dp-card-head">
              <div className="dp-tabs">
                <button className={`dp-tab${tab === 'info' ? ' active' : ''}`} onClick={() => setTab('info')}>
                  信息
                </button>
                <button className={`dp-tab${tab === 'notes' ? ' active' : ''}`} onClick={() => setTab('notes')}>
                  笔记{item.note.trim() ? ' •' : ''}
                </button>
                <button className={`dp-tab${tab === 'annotations' ? ' active' : ''}`} onClick={() => setTab('annotations')}>
                  批注{item.annotationCount ? ` ${item.annotationCount}` : ''}
                </button>
              </div>
              <span style={{ flex: 1 }} />
              {item.starred ? (
                <span style={{ color: 'var(--c-orange)' }}>
                  <IconStar size={14} filled />
                </span>
              ) : null}
            </div>

            {tab === 'info' ? <InfoTab item={item} rootName={rootName} /> : null}
            {tab === 'notes' ? <NotesTab item={item} /> : null}
            {tab === 'annotations' ? <AnnotationsTab item={item} /> : null}
          </div>

          {settings.fullTextIndex !== 'off' ? (
            <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)' }}>
              全文索引：{item.textIndexed ? '已建立（可在搜索里搜到正文）' : '尚未建立（打开一次即自动建立）'}
            </div>
          ) : null}
        </div>
      </div>
      {popup.element}
    </section>
  );
}

function InfoTab({ item, rootName }: { item: Item; rootName: string }) {
  const refresh = useStore((s) => s.refresh);
  const pushToast = useStore((s) => s.pushToast);
  const [draft, setDraft] = useState({
    title: item.title,
    authors: item.authors.join('、'),
    year: item.year ? String(item.year) : '',
    venue: item.venue,
    volume: item.volume,
    issue: item.issue,
    pages: item.pages,
    doi: item.doi,
    url: item.url,
    abstract: item.abstract,
    keywords: item.keywords.join(', '),
  });

  useEffect(() => {
    setDraft({
      title: item.title,
      authors: item.authors.join('、'),
      year: item.year ? String(item.year) : '',
      venue: item.venue,
      volume: item.volume,
      issue: item.issue,
      pages: item.pages,
      doi: item.doi,
      url: item.url,
      abstract: item.abstract,
      keywords: item.keywords.join(', '),
    });
  }, [item.id]);

  const commit = async (patch: Partial<Item>) => {
    await api.updateItem(item.id, patch);
    await refresh();
  };

  const field = (key: keyof typeof draft, label: string, onCommit: (v: string) => void) => (
    <div className="dp-row" key={key}>
      <div className="dp-row-key">{label}</div>
      <div className="dp-row-val">
        <input
          className="input"
          value={draft[key]}
          onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          onBlur={(e) => onCommit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
    </div>
  );

  return (
    <div>
      {field('title', '标题', (v) => v.trim() && v !== item.title && void commit({ title: v.trim() }))}
      {field('authors', '作者', (v) =>
        void commit({ authors: v.split(/[、,，;；]+/).map((s) => s.trim()).filter(Boolean) }),
      )}
      {field('year', '年份', (v) => {
        const n = Number(v.replace(/\D/g, ''));
        void commit({ year: n > 1000 && n < 2200 ? n : null });
      })}
      {field('venue', '期刊/出处', (v) => void commit({ venue: v.trim() }))}
      {field('volume', '卷', (v) => void commit({ volume: v.trim() }))}
      {field('issue', '期', (v) => void commit({ issue: v.trim() }))}
      {field('pages', '页码', (v) => void commit({ pages: v.trim() }))}
      {field('doi', 'DOI', (v) => void commit({ doi: v.trim(), url: v.trim() ? `https://doi.org/${v.trim()}` : item.url }))}
      {field('keywords', '关键词', (v) => void commit({ keywords: v.split(/[,，;；]+/).map((s) => s.trim()).filter(Boolean) }))}
      <div className="dp-row">
        <div className="dp-row-key">摘要</div>
        <div className="dp-row-val">
          <textarea
            className="textarea"
            style={{ minHeight: 90, fontSize: 13 }}
            value={draft.abstract}
            placeholder="（没有摘要，可手动粘贴或联网补全）"
            onChange={(e) => setDraft({ ...draft, abstract: e.target.value })}
            onBlur={(e) => void commit({ abstract: e.target.value })}
          />
        </div>
      </div>
      <div className="dp-row">
        <div className="dp-row-key">阅读</div>
        <div className="dp-row-val" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>{readStateLabel(item.readState)}</span>
          <ProgressBar percent={item.progress.percent} done={item.readState === 'read'} />
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {item.progress.page}
            {item.pageCount ? `/${item.pageCount}` : ''} 页
          </span>
          <button className="btn sm" onClick={() => void commit({ readState: item.readState === 'read' ? 'unread' : 'read' })}>
            {item.readState === 'read' ? '标记未读' : '标记已读'}
          </button>
        </div>
      </div>
      <div className="dp-row">
        <div className="dp-row-key">文件</div>
        <div className="dp-row-val">
          <div className="path-line">{item.path}</div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            文献库：{rootName || '—'} · 相对路径：{item.relPath} · {formatBytes(item.size)} · 修改于 {formatDate(item.mtime)}
          </div>
        </div>
      </div>
      <div className="dp-row">
        <div className="dp-row-key">状态</div>
        <div className="dp-row-val" style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
          解析：{{ placeholder: '待解析', indexed: '已登记', ready: '已完成', failed: '解析失败' }[item.parseState]}
          {item.parseError ? `（${item.parseError}）` : ''} · 添加于 {formatDate(item.addedAt)} · 打开 {item.openCount} 次 ·{' '}
          {item.lastOpenedAt ? `最近 ${formatRelative(item.lastOpenedAt)}` : '尚未打开'}
          {item.userEdited.length ? ` · 手动改过：${item.userEdited.join('、')}` : ''}
          <button
            className="btn sm"
            style={{ marginLeft: 8 }}
            onClick={async () => {
              await api.updateItem(item.id, { userEdited: [] });
              pushToast({ kind: 'info', message: '已解除字段锁定', detail: '下次扫描时会用文件内嵌元数据覆盖' });
              await refresh();
            }}
            title="解除「手动改过」的锁定，让扫描结果可以覆盖这些字段"
          >
            解除字段锁定
          </button>
        </div>
      </div>
    </div>
  );
}

function NotesTab({ item }: { item: Item }) {
  const [value, setValue] = useState(item.note);
  const [saved, setSaved] = useState(true);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const timer = useRef<number | null>(null);
  const latest = useRef(item.note);

  useEffect(() => {
    setValue(item.note);
    latest.current = item.note;
    setSaved(true);
  }, [item.id]);

  const schedule = (next: string) => {
    setValue(next);
    setSaved(false);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      if (next === latest.current) {
        setSaved(true);
        return;
      }
      latest.current = next;
      await api.setNote(item.id, next);
      setSaved(true);
    }, 700);
  };

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
      if (!saved) void api.setNote(item.id, latest.current);
    },
    [item.id, saved],
  );

  const preview = useMemo(() => {
    // 极简 Markdown 预览：标题、粗体、列表、引用、代码块
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let html = esc(value);
    html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.*)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.*)$/gm, '<h1>$1</h1>');
    html = html.replace(/^\> (.*)$/gm, '<blockquote>$1</blockquote>');
    html = html.replace(/^[-*] (.*)$/gm, '<li>$1</li>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\n{2,}/g, '</p><p>');
    return `<p>${html}</p>`;
  }, [value]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div className="dp-tabs">
          <button className={`dp-tab${mode === 'edit' ? ' active' : ''}`} onClick={() => setMode('edit')}>
            编辑
          </button>
          <button className={`dp-tab${mode === 'preview' ? ' active' : ''}`} onClick={() => setMode('preview')}>
            预览
          </button>
        </div>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{saved ? '已保存' : '输入中…'}</span>
      </div>
      {mode === 'edit' ? (
        <textarea
          className="textarea"
          style={{ minHeight: 260 }}
          value={value}
          placeholder="写下这篇文献的要点、疑问、可复用结论…（支持 Markdown，也会同步保存为 notes/<id>.md）"
          onChange={(e) => schedule(e.target.value)}
        />
      ) : (
        <div className="markdown-body" dangerouslySetInnerHTML={{ __html: preview }} />
      )}
    </div>
  );
}

function AnnotationsTab({ item }: { item: Item }) {
  const [list, setList] = useState<Annotation[]>([]);
  const jumpInReader = useStore((s) => s.jumpInReader);
  const openReader = useStore((s) => s.openReader);
  const pushToast = useStore((s) => s.pushToast);

  useEffect(() => {
    void api.listAnnotations(item.id).then(setList).catch(() => setList([]));
  }, [item.id, item.annotationCount, item.revision]);

  if (!list.length) {
    return (
      <div style={{ fontSize: 13, color: 'var(--text-2)', padding: '6px 0' }}>
        还没有批注。打开阅读器后，用鼠标框选文字就能高亮、下划线或写批注。
      </div>
    );
  }

  const grouped = new Map<number, Annotation[]>();
  for (const a of list) {
    const arr = grouped.get(a.page) ?? [];
    arr.push(a);
    grouped.set(a.page, arr);
  }
  const pages = [...grouped.keys()].sort((a, b) => a - b);
  const review = list.filter((a) => a.needsReview);

  return (
    <div>
      {review.length ? (
        <div className="banner" style={{ borderRadius: 10, marginBottom: 10 }}>
          <IconWarning size={14} />
          <span className="grow">{review.length} 条批注因为文件内容更新而没能自动定位，打开阅读器会尝试重新定位。</span>
        </div>
      ) : null}
      {pages.map((page) => (
        <div key={page}>
          <div style={{ fontSize: 11.5, fontWeight: 650, color: 'var(--text-3)', margin: '10px 0 4px' }}>第 {page} 页</div>
          {grouped.get(page)!.map((a) => (
            <div
              className="dp-ann"
              key={a.id}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                if (useStore.getState().readerId === item.id) jumpInReader(a.page, a.id);
                else void openReader(item.id, { page: a.page, annotationId: a.id });
              }}
            >
              <span className="dp-ann-page" style={{ color: a.needsReview ? 'var(--c-orange)' : undefined }}>
                {a.type === 'bookmark' ? '🔖' : `P${a.page}`}
              </span>
              <div className="dp-ann-body">
                {a.text ? <div className="dp-ann-quote">{a.text}</div> : null}
                {a.comment ? <div className="dp-ann-comment">{a.comment}</div> : null}
                {!a.comment && !a.text ? <div style={{ color: 'var(--text-3)' }}>{a.type === 'bookmark' ? '书签' : '（无内容）'}</div> : null}
                {a.reanchorNote ? (
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 3 }}>
                    <IconRefresh size={11} /> {a.reanchorNote}
                  </div>
                ) : null}
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button
                    className="btn sm"
                    onClick={async (e) => {
                      e.stopPropagation();
                      await api.deleteAnnotation(a.id);
                      setList((prev) => prev.filter((x) => x.id !== a.id));
                    }}
                  >
                    <IconTrash size={12} /> 删除
                  </button>
                  <span style={{ fontSize: 11, color: 'var(--text-3)', alignSelf: 'center' }}>
                    {new Date(a.createdAt).toLocaleDateString('zh-CN')}
                  </span>
                </div>
              </div>
              <span className="sb-dot" style={{ background: a.color, marginTop: 6 }} />
            </div>
          ))}
        </div>
      ))}
      <div style={{ marginTop: 12 }}>
        <button
          className="btn sm"
          onClick={async () => {
            const md = [
              `## 批注汇总 · ${item.title}`,
              '',
              ...[...list]
                .sort((a, b) => a.page - b.page)
                .map((a) => `- **P${a.page}** ${a.text ? `「${a.text}」` : ''}${a.comment ? ` — ${a.comment}` : ''}`),
            ].join('\n');
            const ok = await copyText(md);
            pushToast({ kind: ok ? 'success' : 'warn', message: ok ? '已复制全部批注（Markdown）' : '复制失败' });
          }}
        >
          <IconHighlight size={12} /> 复制全部批注
        </button>
      </div>
    </div>
  );
}

/**
 * 列表栏：搜索 + 排序/分组/视图切换 + 虚拟滚动列表（提醒事项式行）。
 */
import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Item } from '@shared/types';
import { useStore } from '../state/store';
import { applyList, groupItems, remoteResultMaps, type Group } from '../state/selectors';
import { api, fileUrl, thumbUrl } from '../bridge';
import { confirmDialog, promptDialog, usePopup, type MenuItemDef } from './Overlays';
import { CheckRing, EmptyState, ProgressBar } from './Bits';
import {
  IconBookOpen,
  IconGrid,
  IconGroup,
  IconList,
  IconMore,
  IconSearch,
  IconSort,
  IconStar,
  IconTrash,
  IconExternal,
  IconX,
  kindIcon,
} from './Icons';
import { formatRelative, kindLabel, subtitle } from '../utils/format';
import { modKey } from '../utils/format';

type FlatRow = { type: 'group'; group: Group } | { type: 'item'; item: Item };

export function ListPane() {
  const items = useStore((s) => s.items);
  const roots = useStore((s) => s.roots);
  const filter = useStore((s) => s.filter);
  const query = useStore((s) => s.query);
  const setQuery = useStore((s) => s.setQuery);
  const sortKey = useStore((s) => s.sortKey);
  const sortDir = useStore((s) => s.sortDir);
  const setSort = useStore((s) => s.setSort);
  const groupBy = useStore((s) => s.groupBy);
  const setGroupBy = useStore((s) => s.setGroupBy);
  const listView = useStore((s) => s.listView);
  const setListView = useStore((s) => s.setListView);
  const remoteHits = useStore((s) => s.remoteHits);
  const searching = useStore((s) => s.searching);
  const progress = useStore((s) => s.progress);
  const settings = useStore((s) => s.settings);
  const pushToast = useStore((s) => s.pushToast);

  const { items: list, hitFields, hitSnippets } = useMemo(() => {
    const maps = remoteResultMaps(remoteHits);
    return applyList(items, {
      filter,
      query,
      sortKey,
      sortDir,
      remoteIds: maps.ids,
      remoteFields: maps.fields,
      remoteSnippets: maps.snippets,
    });
  }, [items, filter, query, sortKey, sortDir, remoteHits]);

  const groups = useMemo(() => groupItems(list, groupBy, roots), [list, groupBy, roots]);
  const flat = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    for (const group of groups) {
      if (groupBy !== 'none') out.push({ type: 'group', group });
      for (const item of group.items) out.push({ type: 'item', item });
    }
    return out;
  }, [groups, groupBy]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (listView === 'comfortable' ? 104 : 76),
    overscan: 10,
  });

  const selected = useStore((s) => s.selection);
  const activeId = useStore((s) => s.activeId);

  const sortPopup = usePopup();
  const groupPopup = usePopup();
  const morePopup = usePopup();

  const sortOptions: MenuItemDef[] = [
    { header: true, label: '排序方式' },
    ...(
      [
        ['added', '添加时间'],
        ['opened', '最近阅读'],
        ['title', '标题'],
        ['author', '第一作者'],
        ['year', '年份'],
        ['mtime', '文件修改时间'],
        ['size', '文件大小'],
        ['progress', '阅读进度'],
      ] as const
    ).map<MenuItemDef>(([key, label]) => ({
      label,
      checked: sortKey === key,
      onClick: () => setSort(key, key === sortKey && sortDir === 'desc' ? 'asc' : 'desc'),
    })),
    { separator: true },
    { label: '升序', checked: sortDir === 'asc', onClick: () => setSort(sortKey, 'asc') },
    { label: '降序', checked: sortDir === 'desc', onClick: () => setSort(sortKey, 'desc') },
  ];

  const groupOptions: MenuItemDef[] = [
    { header: true, label: '分组方式' },
    ...(
      [
        ['none', '不分组'],
        ['read', '按阅读状态'],
        ['folder', '按文件夹'],
        ['year', '按年份'],
        ['tag', '按标签'],
        ['added', '按添加时间'],
      ] as const
    ).map<MenuItemDef>(([key, label]) => ({ label, checked: groupBy === key, onClick: () => setGroupBy(key) })),
  ];

  const moreItems: MenuItemDef[] = [
    {
      label: '全选当前列表',
      onClick: () => {
        const ids = list.map((i) => i.id);
        useStore.setState({ selection: ids, activeId: ids[0] ?? null });
      },
    },
    { label: '全部标记为已读', onClick: () => void api.setReadState(list.map((i) => i.id), 'read') },
    { label: '全部标记为未读', onClick: () => void api.setReadState(list.map((i) => i.id), 'unread') },
    { separator: true },
    { label: '手动触发全文检索', onClick: () => void useStore.getState().runFullTextSearch(query) },
    { label: '重新扫描全部文献库', onClick: () => void api.rescan() },
    { separator: true },
    { header: true, label: '导出' },
    { label: '导出所选为 BibTeX', onClick: () => void exportAs('bibtex', idsOrAll(selected, list)) },
    { label: '导出所选为 CSV 表格', onClick: () => void exportAs('csv', idsOrAll(selected, list)) },
    { label: '导出所选笔记与批注 (Markdown)', onClick: () => void exportAs('markdown-notes', idsOrAll(selected, list)) },
    { separator: true },
    {
      label: selected.length ? `移除所选 ${selected.length} 条` : '移除当前列表全部',
      danger: true,
      icon: <IconTrash size={13} />,
      onClick: () => void removeItems(selected.length ? selected : list.map((i) => i.id), pushToast),
    },
  ];

  const idsOrAll = (sel: string[], current: Item[]) => (sel.length ? sel : current.map((i) => i.id));

  const total = list.length;
  const scanLabel =
    progress.phase === 'discovering'
      ? `正在发现文件…已发现 ${progress.discovered}`
      : progress.phase === 'hashing'
        ? `正在建立指纹 ${progress.processed}/${progress.total}`
        : progress.phase === 'extracting'
          ? `正在解析元数据…`
          : '';

  return (
    <section className="lp">
      <div className="lp-head">
        <div className="lp-title-row">
          <span className="lp-title">{filterLabel(filter.label, query)}</span>
          <span className="lp-sub">
            {total} 篇{selected.length > 1 ? ` · 已选 ${selected.length}` : ''}
          </span>
        </div>
        <div className="lp-search">
          <IconSearch size={14} />
          <input
            className="input"
            id="litshelf-search"
            value={query}
            placeholder={`搜索标题、作者、标签、笔记（${modKey()}+K）`}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void useStore.getState().runFullTextSearch(query);
              if (e.key === 'Escape') setQuery('');
            }}
          />
          {query ? (
            <button className="clear" onClick={() => setQuery('')} title="清空">
              <IconX size={12} />
            </button>
          ) : null}
        </div>
        <div className="lp-tools">
          <button className="icon-btn" title="排序" onClick={(e) => sortPopup.openFromEvent(e, sortOptions)}>
            <IconSort size={15} />
          </button>
          <button className="icon-btn" title="分组" onClick={(e) => groupPopup.openFromEvent(e, groupOptions)}>
            <IconGroup size={15} />
          </button>
          <span className="sep" />
          <button className={`icon-btn${listView === 'list' ? ' active' : ''}`} title="紧凑列表" onClick={() => setListView('list')}>
            <IconList size={15} />
          </button>
          <button
            className={`icon-btn${listView === 'comfortable' ? ' active' : ''}`}
            title="舒适列表（含摘要）"
            onClick={() => setListView('comfortable')}
          >
            <IconBookOpen size={15} />
          </button>
          <button className={`icon-btn${listView === 'grid' ? ' active' : ''}`} title="网格（封面）" onClick={() => setListView('grid')}>
            <IconGrid size={15} />
          </button>
          <span className="grow" />
          {searching ? <span className="spinner" title="正在检索全文" /> : null}
          <button className="icon-btn" title="更多" onClick={(e) => morePopup.openFromEvent(e, moreItems)}>
            <IconMore size={15} />
          </button>
        </div>
      </div>

      {progress.active && scanLabel ? (
        <div className="scanbar">
          <span className="spinner" />
          <span className="grow">{scanLabel}</span>
          {progress.total > 0 && progress.phase === 'hashing' ? (
            <span>{Math.round((progress.processed / Math.max(1, progress.total)) * 100)}%</span>
          ) : null}
        </div>
      ) : null}

      {roots.some((r) => !r.available) ? (
        <div className="banner">
          <span className="grow">
            有文献库当前打不开：{roots.filter((r) => !r.available).map((r) => r.name).join('、')}（可能是移动硬盘或网盘未挂载）
          </span>
          <button className="btn sm" onClick={() => void api.rescan()}>
            重试
          </button>
        </div>
      ) : null}

      {listView === 'grid' ? (
        <div className="lp-scroll" ref={scrollRef}>
          {flat.length === 0 ? (
            <ListEmpty hasRoots={roots.length > 0} query={query} filterLabel={filter.label} />
          ) : (
            <div className="grid">
              {list.slice(0, 600).map((item) => (
                <GridCard key={item.id} item={item} selected={selected.includes(item.id)} />
              ))}
            </div>
          )}
          {list.length > 600 ? <div className="lp-hint">网格视图最多显示 600 篇，请用搜索或筛选缩小范围</div> : null}
        </div>
      ) : (
        <div className="lp-scroll" ref={scrollRef}>
          {flat.length === 0 ? (
            <ListEmpty hasRoots={roots.length > 0} query={query} filterLabel={filter.label} />
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = flat[virtualRow.index];
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {row.type === 'group' ? (
                      <div className="group-head">
                        <span>{row.group.label}</span>
                        <span className="n">{row.group.items.length}</span>
                      </div>
                    ) : (
                      <RowItem
                        item={row.item}
                        dense={listView === 'list'}
                        comfortable={listView === 'comfortable'}
                        selected={selected.includes(row.item.id)}
                        active={activeId === row.item.id}
                        hit={hitSnippets.get(row.item.id)}
                        hitFields={hitFields.get(row.item.id)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {sortPopup.element}
      {groupPopup.element}
      {morePopup.element}
    </section>
  );
}

function filterLabel(label: string, query: string): string {
  if (query.trim()) return `搜索：${query.length > 18 ? `${query.slice(0, 18)}…` : query}`;
  return label;
}

function ListEmpty({ hasRoots, query, filterLabel: label }: { hasRoots: boolean; query: string; filterLabel: string }) {
  if (!hasRoots) {
    return (
      <EmptyState
        art={<IconBookOpen size={26} />}
        title="还没有文献库"
        desc="指到一个装着 PDF 的文件夹，文献架会自动识别里面的文件，之后文件夹有新文件也会自动出现。"
        actions={
          <button className="btn primary" onClick={() => useStore.setState({ showOnboarding: true })}>
            开始设置
          </button>
        }
      />
    );
  }
  if (query.trim()) {
    return (
      <EmptyState
        art={<IconSearch size={26} />}
        title="没有匹配的文献"
        desc={
          <>
            试试 <b>tag:待读</b>、<b>author:张</b>、<b>year:2023..2025</b>、<b>is:unread</b>，或按回车在全文里搜。
          </>
        }
      />
    );
  }
  return <EmptyState art={<IconBookOpen size={26} />} title={`「${label}」里还没有文献`} desc="换个筛选条件，或往文件夹里放几篇 PDF。" />;
}

function RowItem({
  item,
  dense,
  comfortable,
  selected,
  active,
  hit,
  hitFields,
}: {
  item: Item;
  dense: boolean;
  comfortable: boolean;
  selected: boolean;
  active: boolean;
  hit?: string;
  hitFields?: string[];
}) {
  const popup = usePopup();
  const select = useStore((s) => s.select);
  const openReader = useStore((s) => s.openReader);
  const pushToast = useStore((s) => s.pushToast);
  const refresh = useStore((s) => s.refresh);
  const selection = useStore((s) => s.selection);
  const tags = useStore((s) => s.tags);
  const Icon = kindIcon(item.kind);

  const toggleRead = () => {
    void api.setReadState([item.id], item.readState === 'read' ? 'unread' : 'read');
  };

  const menu: MenuItemDef[] = [
    { header: true, label: item.title.slice(0, 28) },
    { label: '打开阅读', onClick: () => void openReader(item.id) },
    { label: item.starred ? '取消星标' : '加入星标', onClick: () => void api.toggleStar([item.id]) },
    { label: item.readState === 'read' ? '标记为未读' : '标记为已读', onClick: toggleRead },
    { separator: true },
    {
      label: '补全元数据（联网）',
      onClick: async () => {
        pushToast({ kind: 'info', message: '正在联网补全…' });
        await api.completeMetadata([item.id]);
      },
    },
    {
      label: '重新建立全文索引',
      onClick: async () => {
        const res = await api.indexItemText(item.id);
        pushToast({ kind: res.ok ? 'success' : 'warn', message: res.ok ? `已索引 ${res.pages} 页` : '索引失败（可能是不支持的格式）' });
      },
    },
    {
      label: '在文件夹中显示',
      icon: <IconExternal size={13} />,
      onClick: () => void api.revealItem(item.id),
    },
    {
      label: '用系统程序打开',
      onClick: () => void api.openExternal(item.id),
    },
    {
      label: '复制引用（GB/T 7714）',
      onClick: async () => {
        const text = await api.copyCitation(item.id, 'gbt7714');
        if (text) {
          await navigator.clipboard.writeText(text).catch(() => undefined);
          pushToast({ kind: 'success', message: '已复制引用', detail: text });
        }
      },
    },
    { separator: true },
    {
      label: '添加标签…',
      onClick: async () => {
        const input = await promptDialog({
          title: '添加标签',
          message: '多个标签用逗号或空格分隔',
          placeholder: '例如：待精读, 方法论',
          suggestions: tags.slice(0, 10),
          confirmLabel: '添加',
        });
        if (input) {
          await api.addTags([item.id], input.split(/[,，;；\s]+/).filter(Boolean));
          await refresh();
        }
      },
    },
    { separator: true },
    {
      label: '从库中移除',
      danger: true,
      icon: <IconTrash size={13} />,
      onClick: () => void removeItems(selection.includes(item.id) ? selection : [item.id], pushToast),
    },
  ];

  return (
    <div
      className={`row${selected ? ' selected' : ''}${active ? ' active' : ''}${dense ? ' dense' : ''}${item.missing ? ' missing' : ''}${item.readState === 'read' ? ' read' : ''} fade-in`}
      onClick={(e) => select(item.id, { additive: e.metaKey || e.ctrlKey || e.shiftKey })}
      onDoubleClick={() => void openReader(item.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!selection.includes(item.id)) select(item.id);
        popup.openFromEvent(e, menu);
      }}
      role="button"
      tabIndex={-1}
    >
      <div style={{ paddingTop: 2 }}>
        <CheckRing
          state={item.readState}
          missing={item.missing}
          onClick={toggleRead}
          title={item.missing ? '文件已不在原位置' : item.readState === 'read' ? '标记为未读' : '标记为已读'}
        />
      </div>
      <div className="row-main">
        <div className="row-top">
          <span className="row-title" title={item.title}>
            {item.title || item.name}
          </span>
          {item.starred ? (
            <span className="row-star">
              <IconStar size={13} filled />
            </span>
          ) : null}
          {item.parseState === 'placeholder' ? <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> : null}
          {item.missing ? <span className="badge">文件缺失</span> : null}
        </div>
        <div className="row-sub">{subtitle(item)}</div>
        {comfortable && item.excerpt && !hit ? <div className="row-hit">{item.excerpt}</div> : null}
        {hit ? (
          <div className="row-hit">
            <mark>{hitFields?.join(' / ')}</mark> {hit}
          </div>
        ) : null}
        <div className="row-meta">
          <span className="chip plain" style={{ height: 17, fontSize: 10.5 }}>
            {kindLabel(item)}
          </span>
          {item.tags.slice(0, 3).map((t) => (
            <span key={t} className="chip" style={{ height: 17, fontSize: 10.5 }}>
              #{t}
            </span>
          ))}
          {item.annotationCount ? <span className="chip plain" style={{ height: 17, fontSize: 10.5 }}>{item.annotationCount} 条批注</span> : null}
          {item.note.trim() ? <span className="chip plain" style={{ height: 17, fontSize: 10.5 }}>有笔记</span> : null}
        </div>
        {item.progress.percent > 0 ? (
          <div className="row-progress">
            <ProgressBar percent={item.progress.percent} done={item.readState === 'read'} />
            <span className="pct">
              {item.progress.page}
              {item.pageCount ? `/${item.pageCount}` : ''} 页 · {Math.round(item.progress.percent)}%
            </span>
          </div>
        ) : null}
      </div>
      <div className="row-actions">
        <button
          className="icon-btn"
          style={{ width: 24, height: 24 }}
          title={item.starred ? '取消星标' : '加星标'}
          onClick={(e) => {
            e.stopPropagation();
            void api.toggleStar([item.id]);
          }}
        >
          <IconStar size={13} filled={item.starred} />
        </button>
        <button
          className="icon-btn"
          style={{ width: 24, height: 24 }}
          title="更多"
          onClick={(e) => {
            e.stopPropagation();
            popup.openFromEvent(e, menu);
          }}
        >
          <IconMore size={14} />
        </button>
      </div>
      {popup.element}
    </div>
  );
}

function GridCard({ item, selected }: { item: Item; selected: boolean }) {
  const select = useStore((s) => s.select);
  const openReader = useStore((s) => s.openReader);
  const Icon = kindIcon(item.kind);
  return (
    <div
      className={`grid-card${selected ? ' selected' : ''}`}
      onClick={() => select(item.id)}
      onDoubleClick={() => void openReader(item.id)}
    >
      <div className="grid-cover">
        {item.thumb ? (
          <img src={thumbUrl(item.thumb)} alt="" loading="lazy" draggable={false} />
        ) : item.kind === 'image' ? (
          <img src={fileUrl(item.id, item.revision)} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className="ph">
            <Icon size={26} />
          </span>
        )}
      </div>
      <div className="grid-title">{item.title || item.name}</div>
      <div className="grid-sub">
        {item.authors[0] ?? '作者未知'}
        {item.year ? ` · ${item.year}` : ''}
      </div>
    </div>
  );
}

async function removeItems(ids: string[], pushToast: (t: { kind: 'success' | 'info' | 'warn' | 'error'; message: string; detail?: string }) => void) {
  if (!ids.length) return;
  const ok = await confirmDialog({
    title: `从库中移除 ${ids.length} 条文献？`,
    message: (
      <>
        <strong>磁盘上的文件不会被删除</strong>，只移除库里的记录（含笔记与批注）。10 分钟内可以在提示条上点「撤销」恢复。
      </>
    ),
    confirmLabel: '移除',
    danger: true,
  });
  if (!ok) return;
  await api.deleteItems(ids, { alsoDeleteFile: false });
  pushToast({ kind: 'success', message: `已移除 ${ids.length} 条` });
}

async function exportAs(format: 'bibtex' | 'csv' | 'markdown-notes', ids: string[]) {
  const res = await api.exportLibrary({ format, ids });
  if (res.ok) {
    useStore.getState().pushToast({
      kind: 'success',
      message: `已导出 ${res.count} 篇`,
      detail: res.savedTo ? `保存到：${res.savedTo}` : undefined,
    });
  } else {
    useStore.getState().pushToast({ kind: 'error', message: '导出失败' });
  }
}

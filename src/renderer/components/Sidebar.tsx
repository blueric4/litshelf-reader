/**
 * 侧边栏：智能列表 + 文献库文件夹树 + 标签。参照 Apple 提醒事项的彩色图标行。
 */
import { useEffect, useMemo, type ReactElement } from 'react';
import { normalizeSidebarExtraFilters, type SidebarExtraFilter } from '@shared/types';
import { useStore, type Filter } from '../state/store';
import { sidebarCounts } from '../state/selectors';
import { SidebarFolders } from './SidebarFolders';
import {
  IconBook,
  IconBookOpen,
  IconChevronDown,
  IconClock,
  IconFolderPlus,
  IconHighlight,
  IconInbox,
  IconNote,
  IconSettings,
  IconStar,
  IconTag,
  IconWarning,
} from './Icons';
import { api } from '../bridge';
import { promptDialog, usePopup } from './Overlays';

interface Entry {
  key: string;
  label: string;
  icon: ReactElement;
  filter: Filter;
  count: number;
  color: string;
}

/**
 * 侧栏默认只显示这 4 项；其余（未读 / 待读清单 / 有批注 / 有笔记 / 文件缺失）
 * 要在设置里勾选 `sidebarExtraFilters` 才出现。
 */
const BASE_SIDEBAR_KEYS: readonly string[] = ['all', 'recent', 'reading', 'starred'];
/** 侧栏"列表项"的全部 key：用来判断当前筛选是不是被隐藏了（标签/文件夹筛选不在此列） */
const SIDEBAR_LIST_KEYS = new Set(['all', 'recent', 'reading', 'unread', 'starred', 'toread', 'annotated', 'noted', 'missing']);

export function Sidebar() {
  const items = useStore((s) => s.items);
  const roots = useStore((s) => s.roots);
  const tags = useStore((s) => s.tags);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const setView = useStore((s) => s.setView);
  const view = useStore((s) => s.view);
  const caps = useStore((s) => s.capabilities);
  const pushToast = useStore((s) => s.pushToast);
  const refresh = useStore((s) => s.refresh);
  const settings = useStore((s) => s.settings);
  // settings.json 可能被手改坏（非数组/未知 key），这里统一归一化，避免 .includes 抛错白屏
  const extraKeys = normalizeSidebarExtraFilters(settings.sidebarExtraFilters);

  const counts = useMemo(() => sidebarCounts(items, roots), [items, roots]);

  const lists: Entry[] = [
    { key: 'all', label: '全部文献', icon: <IconInbox size={13} />, filter: { kind: 'all', label: '全部文献' }, count: counts.all, color: 'blue' },
    { key: 'recent', label: '最近添加', icon: <IconClock size={13} />, filter: { kind: 'recent', label: '最近添加' }, count: counts.recent, color: 'teal' },
    { key: 'reading', label: '在读', icon: <IconBookOpen size={13} />, filter: { kind: 'reading', label: '在读' }, count: counts.reading, color: 'orange' },
    { key: 'unread', label: '未读', icon: <IconBook size={13} />, filter: { kind: 'unread', label: '未读' }, count: counts.unread, color: 'gray' },
    { key: 'starred', label: '星标', icon: <IconStar size={13} filled />, filter: { kind: 'starred', label: '星标' }, count: counts.starred, color: 'yellow' },
    { key: 'toread', label: '待读清单', icon: <IconStar size={13} />, filter: { kind: 'toread', label: '待读清单' }, count: counts.toread, color: 'purple' },
    { key: 'annotated', label: '有批注', icon: <IconHighlight size={13} />, filter: { kind: 'annotated', label: '有批注' }, count: counts.annotated, color: 'pink' },
    { key: 'noted', label: '有笔记', icon: <IconNote size={13} />, filter: { kind: 'noted', label: '有笔记' }, count: counts.noted, color: 'green' },
  ];
  if (counts.missing) {
    lists.push({
      key: 'missing',
      label: '文件缺失',
      icon: <IconWarning size={13} />,
      filter: { kind: 'missing', label: '文件缺失' },
      count: counts.missing,
      color: 'red',
    });
  }

  /** 默认 4 项 + 设置里勾选的；顺序沿用上面 lists 的相对顺序 */
  const shown = lists.filter((entry) => BASE_SIDEBAR_KEYS.includes(entry.key) || extraKeys.includes(entry.key as SidebarExtraFilter));
  const shownKey = shown.map((entry) => entry.key).join(',');

  // 被隐藏的筛选项正在生效时，回落到「全部文献」，别留一个看不见的激活态。
  // 只在"可见项集合"或"当前视图"变化时跑（不是每次渲染），所以不会打断用户的正常切换；
  // 把 view 放进 deps 是刻意的：让回落逻辑自身自洽，而不是依赖 Sidebar 只在 LibraryView 挂载。
  useEffect(() => {
    const state = useStore.getState();
    const kind = state.filter.kind;
    if (!SIDEBAR_LIST_KEYS.has(kind)) return;
    if (!shownKey.split(',').includes(kind)) state.setFilter({ kind: 'all', label: '全部文献' });
  }, [shownKey, view]);

  const isActive = (entry: Entry) => filter.kind === entry.key && view === 'library';

  const addRoot = async () => {
    let picked: string[] = [];
    if (caps.nativeDialogs) {
      picked = await api.pickFolder().catch(() => []);
    } else {
      const typed = await promptDialog({
        title: '添加文献文件夹',
        message: '浏览器形态下请手动填写文件夹的完整路径（例如 D:\\文献）。',
        placeholder: 'D:\\文献',
        confirmLabel: '添加',
      });
      if (typed) picked = [typed];
    }
    for (const dir of picked) {
      try {
        const res = await api.addRoot(dir, { depth: 8 });
        pushToast({ kind: 'success', message: `已添加文献库「${res.root.name}」`, detail: dir });
        await refresh();
      } catch (err) {
        pushToast({ kind: 'error', message: '添加失败', detail: (err as Error).message });
      }
    }
  };

  return (
    <aside className="sb">
      <div className="sb-brand">
        <span className="sb-brand-logo">文</span>
        <span className="sb-brand-name">文献架</span>
      </div>

      <div className="sb-scroll">
        <div className="sb-section">
          {shown.map((entry) => (
            <button
              key={entry.key}
              className={`sb-item${isActive(entry) ? ' active' : ''}`}
              onClick={() => {
                setFilter(entry.filter);
                setView('library');
              }}
              title={entry.label}
            >
              <span className={`sb-icon ${entry.color}`}>{entry.icon}</span>
              <span className="sb-label">{entry.label}</span>
              <span className="sb-count">{entry.count || ''}</span>
            </button>
          ))}
        </div>

        <SidebarFolders />

        <div className="sb-section">
          <div className="sb-section-title">
            <span>标签</span>
            {tags.length ? (
              <button
                className="icon-btn"
                style={{ width: 20, height: 20 }}
                title="管理标签"
                onClick={() => setView('settings')}
              >
                <IconChevronDown size={12} />
              </button>
            ) : null}
          </div>
          {tags.length === 0 ? (
            <div className="sb-add" style={{ color: 'var(--text-3)', cursor: 'default' }}>
              还没有标签，可在文献详情里添加
            </div>
          ) : (
            counts.tags.slice(0, 24).map(({ name, count }) => (
              <TagRow
                key={name}
                name={name}
                count={count}
                active={filter.kind === 'tag' && filter.value === name && view === 'library'}
                onSelect={() => {
                  setFilter({ kind: 'tag', value: name, label: `标签：${name}` });
                  setView('library');
                }}
              />
            ))
          )}
        </div>
      </div>

      <div className="sb-footer">
        <button
          className="sb-item"
          onClick={addRoot}
          title="选择文献文件（可多选、可按类型筛选），会按文件所在的文件夹添加；也可以只加文件夹"
        >
          <span className="sb-icon gray">
            <IconFolderPlus size={13} />
          </span>
          <span className="sb-label">添加文献文件夹</span>
        </button>
        <button
          className={`sb-item${view === 'settings' ? ' active' : ''}`}
          onClick={() => setView('settings')}
        >
          <span className="sb-icon gray">
            <IconSettings size={13} />
          </span>
          <span className="sb-label">设置</span>
        </button>
      </div>
    </aside>
  );
}

function TagRow({
  name,
  count,
  active,
  onSelect,
}: {
  name: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}) {
  const popup = usePopup();
  const setFilter = useStore((s) => s.setFilter);
  const setView = useStore((s) => s.setView);
  const pushToast = useStore((s) => s.pushToast);
  const refresh = useStore((s) => s.refresh);
  const items = useStore((s) => s.items);

  return (
    <>
      <button
        className={`sb-item${active ? ' active' : ''}`}
        onClick={onSelect}
        onContextMenu={(e) => {
          e.preventDefault();
          popup.openFromEvent(e, [
            { header: true, label: name },
            {
              label: '重命名标签…',
              onClick: async () => {
                const next = await promptDialog({ title: '重命名标签', defaultValue: name, confirmLabel: '重命名' });
                if (next && next !== name) {
                  await api.renameTag(name, next);
                  if (useStore.getState().filter.value === name) setFilter({ kind: 'tag', value: next, label: `标签：${next}` });
                  pushToast({ kind: 'success', message: `标签「${name}」已重命名为「${next}」` });
                  await refresh();
                }
              },
            },
            {
              label: '删除标签（只删标签，不删文献）',
              danger: true,
              onClick: async () => {
                await api.deleteTag(name);
                pushToast({ kind: 'success', message: `已删除标签「${name}」`, detail: `${items.filter((i) => i.tags.includes(name)).length} 篇文献的该标签被移除` });
                await refresh();
              },
            },
          ]);
        }}
      >
        <span className="sb-icon" style={{ background: '#8E8E93', width: 18, height: 18 }}>
          <IconTag size={11} />
        </span>
        <span className="sb-label">{name}</span>
        <span className="sb-count">{count}</span>
      </button>
      {popup.element}
    </>
  );
}

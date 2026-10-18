/**
 * 应用外壳：初始化、主题、视图路由、全局快捷键、提示与浮层。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './state/store';
import { applyList, remoteResultMaps } from './state/selectors';
import { LibraryView } from './views/LibraryView';
import { SettingsView } from './views/SettingsView';
import { Onboarding } from './views/Onboarding';
import { ReaderView } from './reader/ReaderView';
import { DialogHost, Modal } from './components/Overlays';
import { DropZone, Toasts } from './components/Bits';
import { IconBookOpen, IconEyeOff, IconKeyboard, IconLayers, IconSearch, IconSettings, IconX } from './components/Icons';
import { api } from './bridge';
import { modKey } from './utils/format';
import type { Item } from '@shared/types';

export function App() {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const settings = useStore((s) => s.settings);
  const showOnboarding = useStore((s) => s.showOnboarding);
  const showShortcuts = useStore((s) => s.showShortcuts);
  const roots = useStore((s) => s.roots);
  const progress = useStore((s) => s.progress);
  const filter = useStore((s) => s.filter);
  const [showDetail, setShowDetail] = useState(true);

  useEffect(() => {
    void init();
  }, [init]);

  // 主题
  useEffect(() => {
    const apply = () => {
      const dark =
        settings.theme === 'dark' || (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings.theme]);

  // 拖入文件 → 若属于某个已监听目录则立即刷新；否则提示添加所在文件夹
  const onDropFiles = useCallback(
    async (paths: string[]) => {
      const pushToast = useStore.getState().pushToast;
      const matched = paths.filter((p) => roots.some((r) => p.toLowerCase().startsWith(r.path.toLowerCase())));
      if (matched.length === paths.length) {
        pushToast({ kind: 'info', message: '文件夹里的新文件会立即被识别', detail: '监听到变化后会自动加入文献库' });
      } else {
        pushToast({
          kind: 'warn',
          message: '这些文件不在已监听的文件夹里',
          detail: `把文件放进已添加的文献库即可自动入库，或在设置里添加它所在文件夹：\n${paths[0].replace(/[\\/][^\\/]+$/, '')}`,
          ttl: 9000,
        });
      }
    },
    [roots],
  );

  // 全局快捷键
  const visible = useVisibleItems();
  useHotkeys(visible, { showDetail, setShowDetail });

  if (!ready) {
    return (
      <div className="app">
        <div className="empty" style={{ height: '100%' }}>
          <span className="spinner" />
          <div className="empty-desc">正在启动文献架…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar
        onToggleDetail={() => setShowDetail((v) => !v)}
        showDetail={showDetail}
        progressActive={progress.active}
      />

      {showOnboarding ? (
        <Onboarding />
      ) : view === 'reader' ? (
        <ReaderView />
      ) : view === 'settings' ? (
        <SettingsView />
      ) : (
        <LibraryView showDetail={showDetail} />
      )}

      <Toasts />
      <DialogHost />
      <DropZone onFiles={onDropFiles} />

      {showShortcuts ? <ShortcutsModal /> : null}
      {!roots.length && !showOnboarding ? (
        <div className="banner" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 50 }}>
          <span className="grow">还没有文献库，指到一个装着 PDF 的文件夹就能开始。</span>
          <button className="btn sm primary" onClick={() => useStore.setState({ showOnboarding: true })}>
            去添加
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 当前列表里可见的条目顺序（与列表栏同一套纯函数，保证 j/k 导航一致） */
function useVisibleItems(): Item[] {
  const items = useStore((s) => s.items);
  const filter = useStore((s) => s.filter);
  const query = useStore((s) => s.query);
  const sortKey = useStore((s) => s.sortKey);
  const sortDir = useStore((s) => s.sortDir);
  const remoteHits = useStore((s) => s.remoteHits);
  return useMemo(() => {
    const maps = remoteResultMaps(remoteHits);
    return applyList(items, {
      filter,
      query,
      sortKey,
      sortDir,
      remoteIds: maps.ids,
      remoteFields: maps.fields,
      remoteSnippets: maps.snippets,
    }).items;
  }, [items, filter, query, sortKey, sortDir, remoteHits]);
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function useHotkeys(visible: Item[], opts: { showDetail: boolean; setShowDetail: (v: boolean) => void }) {
  const stateRef = useRef({ visible, opts });
  stateRef.current = { visible, opts };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const store = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      const { visible: list } = stateRef.current;

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        store.setView('library');
        requestAnimationFrame(() => {
          const el = document.getElementById('litshelf-search') as HTMLInputElement | null;
          el?.focus();
          el?.select();
        });
        return;
      }

      if (isTypingTarget(e.target)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur();
        return;
      }

      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        useStore.setState({ showShortcuts: !useStore.getState().showShortcuts });
        return;
      }

      if (mod && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        void api.rescan();
        store.pushToast({ kind: 'info', message: '正在重新扫描全部文献库' });
        return;
      }

      if (e.key === 'Escape') {
        // 快捷键面板开着时，Esc 只关面板（否则会连带把阅读器也关了）
        if (useStore.getState().showShortcuts) {
          useStore.setState({ showShortcuts: false });
          return;
        }
        // 任何对话框（重命名、确认、选择文件夹…）开着时，Esc 交给它们自己关。
        // 它们自己的监听器注册得比我们晚（打开时才挂），所以必须由我们让出去，
        // 不然在阅读器里按 Esc 会把对话框和阅读器一起关掉。
        if (document.querySelector('.modal-backdrop')) return;
        // 阅读器里有浮层时，Esc 先交给阅读器自己处理（关批注卡片 / 划词工具条 / 文内搜索），
        // 再按一次才返回列表。这里必须判断，因为 App 的监听器注册得比阅读器早，
        // 阅读器那边 stopImmediatePropagation 拦不住我们。
        const overlayOpen =
          store.view === 'reader' &&
          !!document.querySelector('.rd-ann-card, .rd-sel-toolbar, .rd-search-panel, .rd-empty-card, .rd-menu');
        if (overlayOpen) return;
        if (store.view === 'reader') store.closeReader();
        else if (store.query) store.setQuery('');
        else if (store.view !== 'library') store.setView('library');
        return;
      }

      if (store.view !== 'library') return;

      const currentIndex = store.activeId ? list.findIndex((i) => i.id === store.activeId) : -1;
      const move = (delta: number) => {
        if (!list.length) return;
        const nextIndex = Math.max(0, Math.min(list.length - 1, currentIndex < 0 ? 0 : currentIndex + delta));
        store.select(list[nextIndex].id);
        const el = document.querySelector('.row.active');
        el?.scrollIntoView({ block: 'nearest' });
      };

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'Enter') {
        if (store.activeId) void store.openReader(store.activeId);
      } else if (e.key === ' ') {
        e.preventDefault();
        const ids = store.selection.length ? store.selection : store.activeId ? [store.activeId] : [];
        const anyUnread = ids.some((id) => store.byId[id]?.readState !== 'read');
        void api.setReadState(ids, anyUnread ? 'read' : 'unread');
      } else if (e.key === 's') {
        const ids = store.selection.length ? store.selection : store.activeId ? [store.activeId] : [];
        void api.toggleStar(ids);
      } else if (e.key === 'e') {
        useStore.setState({ detailTab: 'notes' });
      } else if (e.key === 'd') {
        stateRef.current.opts.setShowDetail(!stateRef.current.opts.showDetail);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function TopBar({
  onToggleDetail,
  showDetail,
  progressActive,
}: {
  onToggleDetail: () => void;
  showDetail: boolean;
  progressActive: boolean;
}) {
  const view = useStore((s) => s.view);
  const filter = useStore((s) => s.filter);
  const readerId = useStore((s) => s.readerId);
  const item = useStore((s) => (readerId ? s.byId[readerId] : null));
  const progress = useStore((s) => s.progress);
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const [progressOpen, setProgressOpen] = useState(false);

  const title =
    view === 'settings' ? '设置' : view === 'reader' ? item?.title ?? '阅读' : view === 'library' ? filter.label : '文献架';

  return (
    <header className="topbar">
      <span className="sb-brand-logo" style={{ width: 18, height: 18, fontSize: 10 }}>
        文
      </span>
      <span className="topbar-title" title={title}>
        {title}
      </span>
      <span className="topbar-spacer" />

      {progressActive ? (
        <button className="topbar-progress" onClick={() => setProgressOpen((v) => !v)} title="查看扫描进度">
          <span className="spinner" />
          <span>
            {progress.phase === 'discovering'
              ? `发现文件 ${progress.discovered}`
              : progress.phase === 'hashing'
                ? `指纹 ${progress.processed}/${progress.total}`
                : progress.phase === 'extracting'
                  ? '解析元数据中'
                  : '扫描中'}
          </span>
          <span className="bar">
            <i style={{ width: `${progress.total ? Math.round((progress.processed / progress.total) * 100) : 8}%` }} />
          </span>
        </button>
      ) : null}

      <button
        className="icon-btn"
        title={settings.theme === 'dark' ? '切换到浅色' : '切换到深色'}
        onClick={() => void update({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}
      >
        <IconLayers size={15} />
      </button>
      {view === 'library' ? (
        <button className={`icon-btn${showDetail ? ' active' : ''}`} title="显示/隐藏详情栏（D）" onClick={onToggleDetail}>
          {showDetail ? <IconEyeOff size={15} /> : <IconBookOpen size={15} />}
        </button>
      ) : null}
      <button className="icon-btn" title="快捷键（?）" onClick={() => useStore.setState({ showShortcuts: true })}>
        <IconKeyboard size={15} />
      </button>
      <button
        className={`icon-btn${view === 'settings' ? ' active' : ''}`}
        title="设置"
        onClick={() => useStore.getState().setView(view === 'settings' ? 'library' : 'settings')}
      >
        <IconSettings size={15} />
      </button>

      {progressOpen && progressActive ? (
        <Modal title="扫描进度" onClose={() => setProgressOpen(false)}>
          <div className="modal-body">
            <div>
              阶段：
              {
                {
                  idle: '空闲',
                  discovering: '发现文件',
                  hashing: '建立内容指纹',
                  extracting: '解析元数据',
                  thumbnails: '生成缩略图',
                  done: '完成',
                }[progress.phase]
              }
            </div>
            <div>已发现：{progress.discovered}</div>
            <div>已处理：{progress.processed}</div>
            <div style={{ marginTop: 8, wordBreak: 'break-all', fontSize: 12, color: 'var(--text-3)' }}>{progress.currentPath}</div>
          </div>
        </Modal>
      ) : null}
    </header>
  );
}

function ShortcutsModal() {
  const rows: [string, string][] = [
    [`${modKey()}+K`, '聚焦搜索框'],
    ['j / k 或 ↑ / ↓', '上下移动选择'],
    ['Enter', '打开选中的文献'],
    ['Space', '切换已读 / 未读'],
    ['s', '切换星标'],
    ['e', '跳到笔记'],
    ['d', '显示 / 隐藏详情栏'],
    ['Esc', '返回列表 / 清空搜索'],
    ['?', '打开这个面板'],
    [`${modKey()}+R`, '重新扫描全部文献库'],
    ['—— 阅读器内：翻页与定位 ——', ''],
    ['← / PageUp / [', '上一页'],
    ['→ / PageDown / Space / ]', '下一页'],
    ['Home / End', '首页 / 末页'],
    ['b', '加书签'],
    [`${modKey()}+F`, '文内搜索'],
    ['—— 阅读器内：缩放与视图 ——', ''],
    [`${modKey()} + 滚轮`, '放大 / 缩小（只缩放文献，不动界面）'],
    [`${modKey()}+= / ${modKey()}+-`, '放大 / 缩小'],
    [`${modKey()}+0`, '适应宽度'],
    ['+ / -', '放大 / 缩小'],
    ['t', '切换阅读主题（浅色 / 护眼 / 深色）'],
    ['f', '全屏'],
    [`${modKey()}+Shift+= / - / 0`, '缩放界面本身（视图菜单里的那三项）'],
    ['—— 阅读器内：划词与批注 ——', ''],
    ['1 / 2 / 3 / 4', '选中文字后直接加：高亮 / 下划线 / 波浪线 / 删除线'],
    ['右键', '选中文字或页面 → 菜单（高亮、复制、复制引用、文内搜索、适宽适页、书签）'],
    ['Esc', '关掉当前浮层（搜索 / 批注卡片 / 划词工具条），再按一次返回列表'],
    ['—— 其它 ——', ''],
    ['← / →（图片阅读器）', '上一张 / 下一张图片'],
  ];
  return (
    <Modal title="快捷键" onClose={() => useStore.setState({ showShortcuts: false })}>
      <div className="shortcuts">
        {rows.map(([key, label]) =>
          label ? (
            <div className="shortcut-row" key={key + label}>
              <span>{label}</span>
              <span className="kbd">{key}</span>
            </div>
          ) : (
            <div key={key} style={{ gridColumn: '1 / -1', fontSize: 11.5, color: 'var(--text-3)', marginTop: 6 }}>
              {key}
            </div>
          ),
        )}
      </div>
    </Modal>
  );
}

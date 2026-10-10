/**
 * 渲染层状态：宿主快照 + 增量事件驱动的单一数据源。
 * 所有派生视图（筛选/排序/分组）都是纯函数，放在 selectors.ts。
 */
import { create } from 'zustand';
import type {
  HostEvent,
  Item,
  Root,
  ScanProgress,
  SearchResult,
  Settings,
  Toast,
} from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import { api, isElectron } from '../bridge';

export type FilterKind =
  | 'all'
  | 'recent'
  | 'reading'
  | 'unread'
  | 'starred'
  | 'toread'
  | 'annotated'
  | 'noted'
  | 'missing'
  | 'tag'
  | 'folder'
  | 'smart';

export interface Filter {
  kind: FilterKind;
  value?: string;
  /** 限定在某个文献库根目录内（配合 kind:'folder' 用） */
  rootId?: string;
  label: string;
}

export interface ReaderTarget {
  page?: number;
  annotationId?: string;
  /** 每次跳转自增，阅读器据此触发副作用 */
  token: number;
}

export type ViewName = 'library' | 'reader' | 'settings';

interface State {
  ready: boolean;
  items: Item[];
  byId: Record<string, Item>;
  roots: Root[];
  folderTree: { rootId: string; rootName: string; rootPath: string; dirs: string[] }[];
  tags: string[];
  settings: Settings;
  progress: ScanProgress;
  toasts: Toast[];
  capabilities: { nativeDialogs: boolean; revealInFolder: boolean; openPath: boolean; mode: 'electron' | 'web' };
  dataDir: string;
  version: string;
  mode: 'electron' | 'web';

  view: ViewName;
  previousView: ViewName;
  filter: Filter;
  query: string;
  /** 全文检索命中（走宿主，异步）；为 null 表示用本地即时筛选 */
  remoteHits: SearchResult[] | null;
  searching: boolean;
  selection: string[];
  activeId: string | null;
  readerId: string | null;
  readerTarget: ReaderTarget | null;
  listView: 'list' | 'comfortable' | 'grid';
  groupBy: Settings['groupBy'];
  sortKey: Settings['sortKey'];
  sortDir: Settings['sortDir'];
  showOnboarding: boolean;
  showShortcuts: boolean;
  detailTab: 'info' | 'notes' | 'annotations';
  settingsSection: string;
  /** 侧边栏折叠的根目录 */
  collapsedRoots: string[];
  /** 手动展开/折叠的文件夹节点 */
  expandedFolders: string[];
}

interface Actions {
  init: () => Promise<void>;
  applyEvent: (event: HostEvent) => void;
  setFilter: (filter: Filter) => void;
  setQuery: (query: string) => void;
  runFullTextSearch: (query: string) => Promise<void>;
  setView: (view: ViewName) => void;
  select: (id: string | null, opts?: { additive?: boolean }) => void;
  openReader: (id: string, target?: { page?: number; annotationId?: string }) => Promise<void>;
  closeReader: () => void;
  jumpInReader: (page?: number, annotationId?: string) => void;
  pushToast: (toast: Partial<Toast> & { message: string }) => void;
  dismissToast: (id: string) => void;
  refresh: () => Promise<void>;
  refreshFolderTree: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  setListView: (view: 'list' | 'comfortable' | 'grid') => void;
  setGroupBy: (g: Settings['groupBy']) => void;
  setSort: (key: Settings['sortKey'], dir?: Settings['sortDir']) => void;
  toggleFolder: (path: string) => void;
  toggleRoot: (rootId: string) => void;
  setSettingsSection: (section: string) => void;
  finishOnboarding: () => Promise<void>;
  patchLocal: (item: Item) => void;
}

const initialState: State = {
  ready: false,
  items: [],
  byId: {},
  roots: [],
  folderTree: [],
  tags: [],
  settings: { ...DEFAULT_SETTINGS },
  progress: {
    active: false,
    phase: 'idle',
    discovered: 0,
    processed: 0,
    total: 0,
    currentPath: '',
    rootId: null,
    startedAt: 0,
    finishedAt: null,
    errors: 0,
  },
  toasts: [],
  capabilities: { nativeDialogs: isElectron, revealInFolder: isElectron, openPath: isElectron, mode: isElectron ? 'electron' : 'web' },
  dataDir: '',
  version: '',
  mode: isElectron ? 'electron' : 'web',

  view: 'library',
  previousView: 'library',
  filter: { kind: 'all', label: '全部文献' },
  query: '',
  remoteHits: null,
  searching: false,
  selection: [],
  activeId: null,
  readerId: null,
  readerTarget: null,
  listView: DEFAULT_SETTINGS.listView,
  groupBy: DEFAULT_SETTINGS.groupBy,
  sortKey: DEFAULT_SETTINGS.sortKey,
  sortDir: DEFAULT_SETTINGS.sortDir,
  showOnboarding: false,
  showShortcuts: false,
  detailTab: 'info',
  settingsSection: 'roots',
  collapsedRoots: [],
  expandedFolders: [],
};

export const useStore = create<State & Actions>((set, get) => ({
  ...initialState,

  init: async () => {
    try {
      const snap = await api.getSnapshot();
      const caps = await api.capabilities().catch(() => initialState.capabilities);
      set({
        ready: true,
        items: snap.items,
        byId: Object.fromEntries(snap.items.map((i) => [i.id, i])),
        roots: snap.roots,
        tags: snap.tags,
        settings: snap.settings,
        progress: snap.progress,
        capabilities: caps,
        dataDir: snap.dataDir,
        version: snap.version,
        mode: snap.mode,
        listView: snap.settings.listView,
        groupBy: snap.settings.groupBy,
        sortKey: snap.settings.sortKey,
        sortDir: snap.settings.sortDir,
        activeId: snap.items.find((i) => i.id === snap.settings.lastOpenedItemId)?.id ?? snap.items[0]?.id ?? null,
        showOnboarding: !snap.settings.onboardingDone,
      });
      await get().refreshFolderTree();

      api.subscribe((event) => get().applyEvent(event));
      window.addEventListener('beforeunload', () => {
        const id = get().readerId;
        if (id) void api.updateSettings({ lastOpenedItemId: id, lastView: 'reader' }).catch(() => undefined);
      });
    } catch (err) {
      set({ ready: true });
      get().pushToast({ kind: 'error', message: '初始化失败', detail: (err as Error).message, ttl: 12000 });
    }
  },

  applyEvent: (event) => {
    switch (event.type) {
      case 'snapshot': {
        const snap = event.snapshot;
        set({
          items: snap.items,
          byId: Object.fromEntries(snap.items.map((i) => [i.id, i])),
          roots: snap.roots,
          tags: snap.tags,
          settings: snap.settings,
          progress: snap.progress,
        });
        break;
      }
      case 'items:patch': {
        const byId = { ...get().byId };
        const indexById = new Map(get().items.map((i, idx) => [i.id, idx]));
        const items = get().items.slice();
        for (const item of event.items) {
          const existingIdx = indexById.get(item.id);
          if (existingIdx === undefined) {
            indexById.set(item.id, items.length);
            items.push(item);
          } else {
            items[existingIdx] = item;
          }
          byId[item.id] = item;
        }
        set({ items, byId });
        break;
      }
      case 'items:remove': {
        const remove = new Set(event.ids);
        const byId = { ...get().byId };
        for (const id of remove) delete byId[id];
        set({
          items: get().items.filter((i) => !remove.has(i.id)),
          byId,
          selection: get().selection.filter((id) => !remove.has(id)),
          activeId: get().activeId && remove.has(get().activeId!) ? null : get().activeId,
          readerId: get().readerId && remove.has(get().readerId!) ? null : get().readerId,
          view: get().readerId && remove.has(get().readerId!) ? 'library' : get().view,
        });
        break;
      }
      case 'roots:update':
        set({ roots: event.roots });
        void get().refreshFolderTree();
        break;
      case 'settings:update':
        set({
          settings: event.settings,
          listView: event.settings.listView,
          groupBy: event.settings.groupBy,
          sortKey: event.settings.sortKey,
          sortDir: event.settings.sortDir,
        });
        break;
      case 'tags:update':
        set({ tags: event.tags });
        break;
      case 'scan:progress':
        set({ progress: event.progress });
        break;
      case 'toast': {
        const incoming = event.toast;
        const current = get().toasts;
        // 同一条消息在短时间内重复出现（例如宿主与界面各提示一次）只保留一条
        const duplicate = current.some(
          (t) => t.message === incoming.message && (t.detail ?? '') === (incoming.detail ?? '') && Date.now() - t.createdAt < 4000,
        );
        if (duplicate) break;
        const toasts = [...current, incoming].slice(-4);
        set({ toasts });
        if (incoming.ttl > 0) {
          setTimeout(() => get().dismissToast(incoming.id), incoming.ttl);
        }
        break;
      }
      case 'open-item':
        void get().openReader(event.itemId, { page: event.page, annotationId: event.annotationId });
        break;
      default:
        break;
    }
  },

  setFilter: (filter) => set({ filter, remoteHits: null }),
  setQuery: (query) => set({ query, remoteHits: query.trim() ? get().remoteHits : null }),

  runFullTextSearch: async (query) => {
    if (!query.trim()) {
      set({ remoteHits: null, searching: false });
      return;
    }
    set({ searching: true });
    try {
      const hits = await api.search(query, { limit: 400 });
      set({ remoteHits: hits, searching: false });
    } catch (err) {
      set({ searching: false });
      get().pushToast({ kind: 'error', message: '检索失败', detail: (err as Error).message });
    }
  },

  setView: (view) => set({ previousView: get().view, view }),

  select: (id, opts) => {
    if (!id) {
      set({ selection: [], activeId: null });
      return;
    }
    if (opts?.additive) {
      const selection = get().selection.includes(id) ? get().selection.filter((x) => x !== id) : [...get().selection, id];
      set({ selection, activeId: id });
      return;
    }
    set({ selection: [id], activeId: id });
  },

  openReader: async (id, target) => {
    const item = get().byId[id];
    if (!item) return;
    if (item.missing) {
      get().pushToast({ kind: 'warn', message: '这篇文献的文件不在原位置了', detail: `${item.path}\n可以点「重新定位」指到新路径`, ttl: 8000 });
      return;
    }
    set({
      view: 'reader',
      previousView: get().view === 'reader' ? get().previousView : get().view,
      readerId: id,
      selection: [id],
      activeId: id,
      readerTarget: target ? { ...target, token: (get().readerTarget?.token ?? 0) + 1 } : { token: (get().readerTarget?.token ?? 0) + 1 },
    });
    void api.markOpened(id).catch(() => undefined);
    void api.updateSettings({ lastOpenedItemId: id, lastView: 'reader' }).catch(() => undefined);
  },

  closeReader: () => {
    const item = get().readerId ? get().byId[get().readerId!] : null;
    set({ view: get().previousView === 'reader' ? 'library' : get().previousView, readerId: null, readerTarget: null });
    if (item) void api.updateSettings({ lastView: 'library' }).catch(() => undefined);
  },

  jumpInReader: (page, annotationId) =>
    set({ readerTarget: { page, annotationId, token: (get().readerTarget?.token ?? 0) + 1 } }),

  pushToast: (toast) => {
    const full: Toast = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: toast.kind ?? 'info',
      message: toast.message,
      detail: toast.detail,
      itemIds: toast.itemIds,
      action: toast.action,
      createdAt: Date.now(),
      ttl: toast.ttl ?? 5000,
    };
    const current = get().toasts;
    const duplicate = current.some(
      (t) => t.message === full.message && (t.detail ?? '') === (full.detail ?? '') && Date.now() - t.createdAt < 4000,
    );
    if (!duplicate) set({ toasts: [...current, full].slice(-4) });
    if (full.ttl > 0) setTimeout(() => get().dismissToast(full.id), full.ttl);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  refresh: async () => {
    const snap = await api.getSnapshot();
    set({
      items: snap.items,
      byId: Object.fromEntries(snap.items.map((i) => [i.id, i])),
      roots: snap.roots,
      tags: snap.tags,
      settings: snap.settings,
      progress: snap.progress,
    });
    await get().refreshFolderTree();
  },

  refreshFolderTree: async () => {
    try {
      const tree = await api.getFolderTree();
      set({ folderTree: tree });
    } catch {
      /* ignore */
    }
  },

  updateSettings: async (patch) => {
    const next = { ...get().settings, ...patch };
    set({
      settings: next,
      listView: next.listView,
      groupBy: next.groupBy,
      sortKey: next.sortKey,
      sortDir: next.sortDir,
    });
    try {
      const saved = await api.updateSettings(patch);
      set({ settings: saved });
    } catch (err) {
      get().pushToast({ kind: 'error', message: '设置保存失败', detail: (err as Error).message });
    }
  },

  setListView: (view) => {
    set({ listView: view });
    void get().updateSettings({ listView: view });
  },
  setGroupBy: (g) => {
    set({ groupBy: g });
    void get().updateSettings({ groupBy: g });
  },
  setSort: (key, dir) => {
    const sortDir = dir ?? (get().sortKey === key && get().sortDir === 'desc' ? 'asc' : 'desc');
    set({ sortKey: key, sortDir });
    void get().updateSettings({ sortKey: key, sortDir });
  },
  toggleFolder: (p) => {
    const list = get().expandedFolders;
    set({ expandedFolders: list.includes(p) ? list.filter((x) => x !== p) : [...list, p] });
  },
  toggleRoot: (rootId) => {
    const list = get().collapsedRoots;
    set({ collapsedRoots: list.includes(rootId) ? list.filter((x) => x !== rootId) : [...list, rootId] });
  },

  setSettingsSection: (settingsSection) => set({ settingsSection }),

  finishOnboarding: async () => {
    set({ showOnboarding: false });
    await get().updateSettings({ onboardingDone: true });
  },

  patchLocal: (item) => {
    const byId = { ...get().byId, [item.id]: item };
    const items = get().items.map((i) => (i.id === item.id ? item : i));
    set({ byId, items });
  },
}));

/** 读取当前条目（含派生：由 id 拿最新对象） */
export function useItem(id: string | null | undefined): Item | null {
  return useStore((s) => (id ? s.byId[id] ?? null : null));
}

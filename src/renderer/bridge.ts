/**
 * 宿主桥：Electron 形态走 IPC，浏览器形态走 HTTP + SSE。
 * 两种形态暴露完全一样的 `api`，上层界面代码不需要知道自己跑在哪里。
 */
import type { Api } from '@shared/api';
import { IPC } from '@shared/api';
import type { HostEvent } from '@shared/types';

export interface LitShelfBridge {
  mode: 'electron';
  platform: string;
  invoke: (method: string, args?: unknown[]) => Promise<unknown>;
  on: (cb: (event: HostEvent) => void) => () => void;
  fileUrl: (itemId: string, rev?: number) => string;
  thumbUrl: (name: string) => string;
}

declare global {
  interface Window {
    litshelf?: LitShelfBridge;
  }
}

const bridge: LitShelfBridge | undefined = typeof window !== 'undefined' ? window.litshelf : undefined;

export const isElectron = !!bridge;
export const platform = bridge?.platform ?? (typeof navigator !== 'undefined' ? navigator.platform : 'unknown');

interface InvokeResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

function webInvoke<T>(method: string, args: unknown[]): Promise<T> {
  return fetch('/api/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args }),
  })
    .then(async (res) => {
      const text = await res.text();
      let data: InvokeResponse<T>;
      try {
        data = JSON.parse(text) as InvokeResponse<T>;
      } catch {
        throw new Error(`宿主返回了非 JSON 响应（HTTP ${res.status}）`);
      }
      if (!data.ok) throw new Error(data.error ?? `调用 ${method} 失败`);
      return data.result as T;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Failed to fetch')) {
        throw new Error(`连不上本地服务（${method}）。请确认后台进程还在运行。`);
      }
      throw err instanceof Error ? err : new Error(message);
    });
}

/**
 * 统一调用：宿主返回的是 JSON，类型由 Api 契约保证；
 * 这里 T 默认 any 是刻意的——IPC/HTTP 边界上再收窄类型只会带来噪音。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call<T = any>(method: string, args: unknown[] = []): Promise<T> {
  if (bridge) return bridge.invoke(method, args) as Promise<T>;
  return webInvoke<T>(method, args);
}

function subscribeEvents(listener: (event: HostEvent) => void): () => void {
  if (bridge) return bridge.on(listener);
  const source = new EventSource('/api/events');
  const handler = (ev: MessageEvent<string>) => {
    try {
      listener(JSON.parse(ev.data) as HostEvent);
    } catch {
      /* 忽略坏消息 */
    }
  };
  source.addEventListener('message', handler as EventListener);
  source.addEventListener('error', () => {
    /* 浏览器会自动重连 */
  });
  return () => {
    source.removeEventListener('message', handler as EventListener);
    source.close();
  };
}

export function fileUrl(itemId: string, rev?: number): string {
  if (bridge) return bridge.fileUrl(itemId, rev);
  return `/api/file/${encodeURIComponent(itemId)}?rev=${rev ?? 0}`;
}

export function thumbUrl(name: string): string {
  if (bridge) return bridge.thumbUrl(name);
  return `/api/thumb/${encodeURIComponent(name)}`;
}

export const api: Api = {
  getSnapshot: () => call('getSnapshot'),
  capabilities: () =>
    call('capabilities').catch(() => ({ nativeDialogs: false, revealInFolder: false, openPath: false, mode: 'web' as const })),

  pickFolder: () => call('pickFolder').catch(() => []),
  addRoot: (path, opts) => call('addRoot', [path, opts]),
  removeRoot: (rootId, opts) => call('removeRoot', [rootId, opts]),
  setRootEnabled: (rootId, enabled) => call('setRootEnabled', [rootId, enabled]),
  rescan: (rootId) => call('rescan', [rootId]),
  rebindItem: (itemId, newPath) => call('rebindItem', [itemId, newPath]),

  getItem: (itemId) => call('getItem', [itemId]),
  updateItem: (itemId, patch) => call('updateItem', [itemId, patch]),
  updateItems: (ids, patch) => call('updateItems', [ids, patch]),
  deleteItems: (ids, opts) => call('deleteItems', [ids, opts]),
  restoreItems: (ids) => call('restoreItems', [ids]),
  setReadState: (ids, state) => call('setReadState', [ids, state]),
  toggleStar: (ids) => call('toggleStar', [ids]),
  setProgress: (itemId, progress) => call('setProgress', [itemId, progress]),
  markOpened: (itemId) => call('markOpened', [itemId]),
  getFolderTree: () => call('getFolderTree'),

  listTags: () => call('listTags'),
  addTags: (ids, tags) => call('addTags', [ids, tags]),
  removeTags: (ids, tags) => call('removeTags', [ids, tags]),
  renameTag: (from, to) => call('renameTag', [from, to]),
  deleteTag: (tag) => call('deleteTag', [tag]),

  setNote: (itemId, markdown) => call('setNote', [itemId, markdown]),
  listAnnotations: (itemId) => call('listAnnotations', [itemId]),
  listAllAnnotations: () => call('listAllAnnotations'),
  addAnnotation: (input) => call('addAnnotation', [input]),
  updateAnnotation: (id, patch) => call('updateAnnotation', [id, patch]),
  deleteAnnotation: (id) => call('deleteAnnotation', [id]),
  reanchorAnnotation: (id, page, rects, text) => call('reanchorAnnotation', [id, page, rects, text]),

  search: (query, opts) => call('search', [query, opts]),
  getItemText: (itemId) => call('getItemText', [itemId]),
  indexItemText: (itemId) => call('indexItemText', [itemId]),

  fileUrl,
  readTextFile: (itemId) => call('readTextFile', [itemId]),
  saveThumb: (itemId, dataUrl, revision) => call('saveThumb', [itemId, dataUrl, revision]),
  revealItem: (itemId) => call('revealItem', [itemId]).catch(() => false),
  openExternal: (itemId) => call('openExternal', [itemId]).catch(() => false),
  openDataDir: () => call('openDataDir', []).catch(() => false),

  completeMetadata: (ids) => call('completeMetadata', [ids]),
  exportLibrary: (opts) => call('exportLibrary', [opts]),
  copyCitation: (itemId, style) => call('copyCitation', [itemId, style]),

  updateSettings: (patch) => call('updateSettings', [patch]),
  rebuildIndex: () => call('rebuildIndex', []),
  clearCache: (kind) => call('clearCache', [kind]),
  exportDiagnostics: () => call('exportDiagnostics', []),
  getProgress: () => call('getProgress', []),
  createSampleLibrary: () => call('createSampleLibrary', []),

  undo: (name, payload) => call('undo', [name, payload]),

  subscribe: subscribeEvents,
  ready: () => call('getSnapshot'),
};

export { IPC };

/** 把文本复制到剪贴板（Electron 与浏览器都可用） */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

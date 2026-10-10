/**
 * Preload：把宿主能力以最小面积暴露给渲染层（contextIsolation: true）。
 *
 * 形状与浏览器形态（src/server/index.ts 的 /api/*）完全一致，
 * 渲染层的 bridge 只依赖 `window.litshelf`，不关心自己跑在哪一种形态里。
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/api';
import type { HostEvent } from '../shared/types';

interface InvokeEnvelope {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** 调宿主方法：解包 {ok, result, error}，失败时抛出携带原始信息的 Error */
async function invoke(method: string, args: unknown[] = []): Promise<unknown> {
  const res = (await ipcRenderer.invoke(IPC.invoke, { method, args })) as InvokeEnvelope;
  if (!res || typeof res !== 'object') throw new Error(`宿主返回了无效响应：${method}`);
  if (!res.ok) throw new Error(res.error || `调用 ${method} 失败`);
  return res.result;
}

/** 订阅宿主事件，返回取消订阅函数 */
function on(callback: (event: HostEvent) => void): () => void {
  const listener = (_event: unknown, payload: HostEvent): void => {
    try {
      callback(payload);
    } catch (err) {
      // 渲染层的异常不能影响后续事件投递
      console.error('[litshelf] 事件处理失败', err);
    }
  };
  ipcRenderer.on(IPC.event, listener);
  return () => {
    ipcRenderer.removeListener(IPC.event, listener);
  };
}

/** 可直接喂给 pdf.js / <img> / fetch 的 URL（litfile:// 由主进程 protocol.handle 提供） */
function fileUrl(itemId: string, rev?: number): string {
  return `litfile://item/${encodeURIComponent(itemId)}?rev=${rev ?? 0}`;
}

function thumbUrl(name: string): string {
  return `litfile://thumb/${encodeURIComponent(name)}`;
}

const api = {
  mode: 'electron' as const,
  platform: process.platform,
  invoke,
  on,
  fileUrl,
  thumbUrl,
};

contextBridge.exposeInMainWorld('litshelf', api);

export type LitShelfBridge = typeof api;

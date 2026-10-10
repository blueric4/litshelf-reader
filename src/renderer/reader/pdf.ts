/**
 * pdf.js 文档加载 + 逐批页面尺寸预算 + 首页缩略图 + 全文索引。
 *
 * 关键设计：
 * - worker 加载失败时清空 workerSrc 重试一次（退化为"假 worker"在主线程跑），
 *   再失败就只把错误交给 UI，绝不抛到 React 之外。
 * - 页面尺寸预算分批进行（每批让出一帧），保证大文档不卡界面；
 *   算完之前的占位高度用第 1 页的宽高比，滚动条长度不会乱跳。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Item } from '@shared/types';
import { api, fileUrl, isElectron } from '../bridge';

export interface PageSize {
  width: number;
  height: number;
  rotation: number;
}

export interface PdfDocumentResult {
  doc: PDFDocumentProxy | null;
  loading: boolean;
  /** 0-100 */
  progress: number;
  error: string | null;
  /** 已算出的页面尺寸（下标 0 起） */
  sizes: PageSize[];
  /** 尺寸预算是否全部完成 */
  sizesReady: boolean;
  /** 假 worker（降级）时为 true，UI 可以提示 */
  degraded: boolean;
  reload: () => void;
}

let workerConfigured = false;

function configureWorker(): void {
  if (workerConfigured) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', document.baseURI).href;
  workerConfigured = true;
}

/**
 * worker 资源是否真的存在（构建脚本会把 pdf.worker.min.mjs 同步到 renderer/public）。
 * 不存在时直接留空走"假 worker"，省掉一整套加载失败-重试的开销。
 */
async function ensureWorkerAvailable(): Promise<boolean> {
  const url = new URL('pdf.worker.min.mjs', document.baseURI).href;
  const probe = (path: string) =>
    fetch(path, { method: 'GET', headers: { Range: 'bytes=0-0' } })
      .then((res) => res.ok || res.status === 206)
      .catch(() => false);
  try {
    if (await probe(url)) return true;
    // baseURI 可能是 file:// 或 litfile://，退回相对路径再试一次
    if (await probe('pdf.worker.min.mjs')) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** 为文档加载准备 worker；返回是否退化为主线程 */
async function prepareWorker(): Promise<boolean> {
  if (isElectron) {
    // Electron 里 CSP 只允许 'self'，静态 fetch 探活意义有限，直接按标准路径配置
    configureWorker();
    return false;
  }
  const available = await ensureWorkerAvailable();
  if (available) {
    configureWorker();
    return false;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = '';
  return true;
}

/** 按批计算页面尺寸；返回取消函数 */
export function buildSizes(
  doc: PDFDocumentProxy,
  onBatch: (sizes: PageSize[], startIndex: number) => void,
  onDone: () => void,
  signal: { cancelled: boolean },
): void {
  const total = doc.numPages;
  const batch = total > 600 ? 48 : 24;
  let index = 1;

  const step = async () => {
    if (signal.cancelled || index > total) {
      if (!signal.cancelled) onDone();
      return;
    }
    const from = index;
    const to = Math.min(total, index + batch - 1);
    const collected: PageSize[] = [];
    for (let p = from; p <= to; p += 1) {
      try {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: 1 });
        collected.push({ width: viewport.width, height: viewport.height, rotation: viewport.rotation });
        page.cleanup();
      } catch {
        collected.push({ width: 612, height: 792, rotation: 0 });
      }
    }
    if (signal.cancelled) return;
    onBatch(collected, from - 1);
    index = to + 1;
    window.setTimeout(() => void step(), 0);
  };

  void step();
}

export function usePdfDocument(item: Item | null): PdfDocumentResult {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [sizesReady, setSizesReady] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [nonce, setNonce] = useState(0);
  const docRef = useRef<PDFDocumentProxy | null>(null);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!item) {
      setDoc(null);
      setSizes([]);
      setSizesReady(false);
      setError(null);
      return;
    }
    const signal = { cancelled: false };
    let task: PDFDocumentLoadingTask | null = null;

    setLoading(true);
    setError(null);
    setDegraded(false);
    setProgress(0);
    setSizes([]);
    setSizesReady(false);

    /** 加载成功后的收尾：接管文档 + 开始预算页面尺寸 */
    const adopt = (loaded: PDFDocumentProxy, isDegraded: boolean) => {
      docRef.current = loaded;
      setDoc(loaded);
      setDegraded(isDegraded);
      setLoading(false);
      buildSizes(
        loaded,
        (batch, startIndex) => {
          if (signal.cancelled) return;
          setSizes((prev) => {
            const next = prev.slice();
            for (let i = 0; i < batch.length; i += 1) next[startIndex + i] = batch[i];
            return next;
          });
          const done = startIndex + batch.length;
          setProgress(Math.round((done / Math.max(1, loaded.numPages)) * 100));
        },
        () => {
          if (!signal.cancelled) setSizesReady(true);
        },
        signal,
      );
    };

    const load = async () => {
      const url = fileUrl(item.id, item.revision);
      const baseParams = {
        url,
        cMapUrl: new URL('cmaps/', document.baseURI).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('standard_fonts/', document.baseURI).href,
      };
      // worker 资源缺失时直接退化，省掉一次必然失败的首轮加载
      const preDegraded = await prepareWorker();
      if (signal.cancelled) return;
      try {
        task = pdfjsLib.getDocument(baseParams);
        const loaded = await task.promise;
        if (signal.cancelled) {
          void loaded.destroy();
          return;
        }
        adopt(loaded, preDegraded);
      } catch (err) {
        if (signal.cancelled) return;
        // 降级：清空 workerSrc，退到"假 worker"（主线程）再试一次
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
          setLoading(false);
          setError((err as Error)?.message || 'PDF 打开失败');
          return;
        }
        try {
          pdfjsLib.GlobalWorkerOptions.workerSrc = '';
          workerConfigured = false;
          const retryTask = pdfjsLib.getDocument(baseParams);
          task = retryTask;
          const loaded = await retryTask.promise;
          if (signal.cancelled) {
            void loaded.destroy();
            return;
          }
          adopt(loaded, true);
        } catch (retryErr) {
          if (signal.cancelled) return;
          setLoading(false);
          setError((retryErr as Error)?.message || (err as Error)?.message || 'PDF 打开失败');
        }
      }
    };

    void load();

    return () => {
      signal.cancelled = true;
      const current = docRef.current;
      docRef.current = null;
      setDoc(null);
      if (task) {
        try {
          // 正在加载时先销毁 loadingTask，否则会继续占用 worker
          void task.destroy();
        } catch {
          /* ignore */
        }
      }
      if (current) {
        try {
          void current.destroy();
        } catch {
          /* ignore */
        }
      }
    };
  }, [item?.id, item?.revision, nonce]);

  return { doc, loading, progress, error, sizes, sizesReady, degraded, reload };
}

/** 首页缩略图：只在 item.thumb 为空时生成一次 */
export async function generateThumbnail(doc: PDFDocumentProxy, item: Item, width = 200): Promise<string | null> {
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport, background: '#ffffff' }).promise;
    page.cleanup();
    let dataUrl = canvas.toDataURL('image/webp', 0.8);
    if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/png');
    const saved = await api.saveThumb(item.id, dataUrl, item.revision);
    return saved;
  } catch {
    return null;
  }
}

/** 首页渲染成功即可交出文档（供上层做批注重定位/缩略图）；取页带缓存 */
export function usePageGetter(doc: PDFDocumentProxy | null): (page: number) => Promise<PDFPageProxy | null> {
  const cache = useRef(new Map<number, Promise<PDFPageProxy | null>>());
  useEffect(() => {
    cache.current = new Map();
  }, [doc]);
  return useCallback(
    (page: number) => {
      if (!doc) return Promise.resolve(null);
      const existing = cache.current.get(page);
      if (existing) return existing;
      const promise = doc
        .getPage(page)
        .then((p) => p)
        .catch(() => null);
      cache.current.set(page, promise);
      return promise;
    },
    [doc],
  );
}

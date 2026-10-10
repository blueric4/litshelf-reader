/**
 * 阅读器公共 hooks：缩放自适应、容器尺寸、滚动节流、外点关闭、进度上报。
 * 所有 hook 都保证卸载后不再 setState（避免"内存泄漏 + 重复计时"）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Item, ReadingProgress } from '@shared/types';

/** SSR 安全 useLayoutEffect */
export const useIsoLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/** 观察元素尺寸（ResizeObserver），返回内容区宽高 */
export function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setSize((prev) =>
        Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5
          ? prev
          : { width: rect.width, height: rect.height },
      );
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, size];
}

/** 稳定的 latest-ref，用于在监听器里读最新值而不重挂监听 */
export function useLatest<T>(value: T): React.RefObject<T> {
  const ref = useRef(value);
  useIsoLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

export interface ReaderOutline {
  total: number;
  layout: 'continuous' | 'single' | 'double';
  /** 手动缩放（1 = 100%） */
  zoom: number;
  /** 'fit-width' | 'fit-page' 时忽略 zoom */
  fit: 'fit-width' | 'fit-page' | 'manual';
  /** 单页/双页模式下的两侧留白 */
  gutter: number;
  padding: number;
  /** 连续模式下的页间距 */
  gap: number;
}

export function clampZoom(zoom: number): number {
  return Math.min(4, Math.max(0.25, zoom));
}

/** 800ms 防抖的阅读进度上报；返回 flush 与 push */
export function useProgressSaver(
  itemId: string | null,
  save: (progress: Partial<ReadingProgress>) => void,
  delay = 800,
): { push: (progress: Partial<ReadingProgress>) => void; flush: () => void } {
  const latest = useRef<Partial<ReadingProgress> | null>(null);
  const timer = useRef<number | null>(null);
  const saveRef = useLatest(save);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const pending = latest.current;
    latest.current = null;
    if (pending) saveRef.current(pending);
  }, [saveRef]);

  const push = useCallback(
    (progress: Partial<ReadingProgress>) => {
      latest.current = { ...(latest.current ?? {}), ...progress };
      if (timer.current !== null) return;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        const pending = latest.current;
        latest.current = null;
        if (pending) saveRef.current(pending);
      }, delay);
    },
    [delay, saveRef],
  );

  // 换文档 / 卸载时补一次
  useEffect(() => {
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      const pending = latest.current;
      latest.current = null;
      if (pending) saveRef.current(pending);
    };
  }, [itemId, saveRef]);

  return { push, flush };
}

/** 防抖值 */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** 滚动容器：rAF 节流 + 停止滚动后的静止回调 */
export function useScrollActivity(
  ref: React.RefObject<HTMLElement | null>,
  onScroll: (el: HTMLElement) => void,
  onIdle: (el: HTMLElement) => void,
  idleDelay = 140,
): void {
  const scrollCb = useLatest(onScroll);
  const idleCb = useLatest(onIdle);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame: number | null = null;
    let timer: number | null = null;
    const handler = () => {
      if (frame === null) {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          scrollCb.current(el);
        });
      }
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        idleCb.current(el);
      }, idleDelay);
    };
    el.addEventListener('scroll', handler, { passive: true });
    return () => {
      el.removeEventListener('scroll', handler);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [ref, scrollCb, idleCb, idleDelay]);
}

/** 共享的 IntersectionObserver：页面自己注册自己，避免父组件轮询 DOM */
export interface PageVisibilityObserver {
  observe: (el: Element, pageIndex: number) => void;
  unobserve: (el: Element) => void;
}

/**
 * 在滚动容器上建一个 IntersectionObserver 并返回注册函数。
 * 每个页面组件用它上报自己的可见性，父组件只维护一个 Set。
 */
export function usePageVisibility(
  root: React.RefObject<HTMLElement | null>,
  onChange: (pageIndex: number, visible: boolean) => void,
  rootMargin = '700px 0px',
): PageVisibilityObserver {
  const cb = useLatest(onChange);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const rootEl = root.current;
    if (!rootEl || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = Number((entry.target as HTMLElement).dataset.pageIndex ?? '-1');
          if (key < 0) continue;
          cb.current(key, entry.isIntersecting);
        }
      },
      { root: rootEl, rootMargin, threshold: 0 },
    );
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [root, cb, rootMargin]);

  return useMemo<PageVisibilityObserver>(
    () => ({
      observe: (el, pageIndex) => observerRef.current?.observe(el),
      unobserve: (el) => observerRef.current?.unobserve(el),
    }),
    [],
  );
}

/** 键盘事件：输入框聚焦时不抢键 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

/** React 19 的 ref 回调清理函数：返回 cleanup */
export function useEventCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useLatest(fn);
  return useCallback((...args: A) => ref.current!(...args), [ref]) as (...args: A) => R;
}

/** 由条目派生稳定的渲染 key（revision 变化时强制重载） */
export function useItemKey(item: Item | null): string {
  return useMemo(() => (item ? `${item.id}:${item.revision}` : ''), [item]);
}

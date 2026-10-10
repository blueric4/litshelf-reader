/**
 * 图片阅读视图：缩放 / 适应 / 旋转 90° / 同目录多图左右切换。
 * 同目录条目直接取 store 里 kind === 'image' 的兄弟节点，不需要宿主新接口。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Item } from '@shared/types';
import { api, fileUrl } from '../bridge';

export interface ImageReaderProps {
  item: Item;
  siblings: Item[];
  zoom: number;
  onZoom: (zoom: number) => void;
  fit: 'fit-width' | 'fit-page' | 'manual';
  onSelectItem: (item: Item) => void;
  onOpenExternal: () => void;
}

export function ImageReader({
  item,
  siblings,
  zoom,
  onZoom,
  fit,
  onSelectItem,
  onOpenExternal,
}: ImageReaderProps): React.ReactElement {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [rotation, setRotation] = useState(0);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    setRotation(0);
    setNatural(null);
    setFailed(false);
    setOffset({ x: 0, y: 0 });
    void api.markOpened(item.id).catch(() => undefined);
  }, [item.id, item.revision]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setStage({ width: rect.width, height: rect.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const order = useMemo(() => {
    const list = [...siblings].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
    return list.length ? list : [item];
  }, [siblings, item]);

  const index = order.findIndex((x) => x.id === item.id);
  const prev = index > 0 ? order[index - 1] : null;
  const next = index >= 0 && index < order.length - 1 ? order[index + 1] : null;

  const go = useCallback(
    (target: Item | null) => {
      if (!target) return;
      onSelectItem(target);
    },
    [onSelectItem],
  );

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'ArrowLeft') go(prev);
      if (ev.key === 'ArrowRight') go(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, prev, next]);

  /** 计算显示尺寸 */
  const display = useMemo(() => {
    if (!natural) return null;
    const sw = stage.width || 800;
    const sh = stage.height || 600;
    const rotated = rotation % 180 !== 0;
    const w = rotated ? natural.height : natural.width;
    const h = rotated ? natural.width : natural.height;
    if (fit === 'manual') {
      return { width: w * zoom, height: h * zoom };
    }
    const k = fit === 'fit-width' ? (sw - 48) / w : Math.min((sw - 48) / w, (sh - 48) / h);
    const scale = Math.max(0.05, Math.min(8, k));
    return { width: w * scale, height: h * scale };
  }, [natural, stage, fit, zoom, rotation]);

  const onWheel = useCallback(
    (ev: React.WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      onZoom(zoom * (ev.deltaY < 0 ? 1.08 : 0.93));
    },
    [zoom, onZoom],
  );

  return (
    <div className="rd-image-stage" ref={stageRef} onWheel={onWheel}>
      <div className="rd-image-bar">
        <button type="button" className="icon-btn" title="上一张" disabled={!prev} onClick={() => go(prev)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="m14 6-6 6 6 6" />
          </svg>
        </button>
        <span className="rd-image-count">
          {index >= 0 ? index + 1 : 1} / {order.length}
        </span>
        <button type="button" className="icon-btn" title="下一张" disabled={!next} onClick={() => go(next)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="m10 6 6 6-6 6" />
          </svg>
        </button>
        <span className="rd-bar-sep" />
        <button
          type="button"
          className="icon-btn"
          title="旋转 90°"
          onClick={() => setRotation((r) => (r + 90) % 360)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
            <path d="M20 11a8 8 0 1 0-2.3 5.7" />
            <path d="M20 4v7h-7" />
          </svg>
        </button>
        {natural ? (
          <span className="rd-image-meta">
            {natural.width} × {natural.height}
          </span>
        ) : null}
      </div>
      <div
        className={`rd-image-canvas${natural && display && (display.width > stage.width || display.height > stage.height) ? ' is-pannable' : ''}`}
        onPointerDown={(ev) => {
          if (!display) return;
          dragRef.current = { x: ev.clientX, y: ev.clientY, ox: offset.x, oy: offset.y };
          (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
        }}
        onPointerMove={(ev) => {
          const drag = dragRef.current;
          if (!drag) return;
          setOffset({ x: drag.ox + (ev.clientX - drag.x), y: drag.oy + (ev.clientY - drag.y) });
        }}
        onPointerUp={(ev) => {
          dragRef.current = null;
          (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
        }}
        onDoubleClick={() => setOffset({ x: 0, y: 0 })}
      >
        {failed ? (
          <div className="rd-empty-card">
            <div className="rd-empty-title">这张图片打不开</div>
            <div className="rd-empty-desc">文件可能已损坏，或浏览器不支持这种格式。</div>
            <div className="rd-empty-actions">
              <button type="button" className="btn primary" onClick={onOpenExternal}>
                用系统程序打开
              </button>
            </div>
          </div>
        ) : (
          <img
            key={`${item.id}:${item.revision}`}
            src={fileUrl(item.id, item.revision)}
            alt={item.title || item.name}
            draggable={false}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) rotate(${rotation}deg)`,
              width: display ? `${display.width}px` : undefined,
              height: display ? `${display.height}px` : undefined,
            }}
            onLoad={(ev) => {
              const img = ev.currentTarget;
              setNatural({ width: img.naturalWidth, height: img.naturalHeight });
            }}
            onError={() => setFailed(true)}
          />
        )}
      </div>
      {order.length > 1 ? (
        <div className="rd-image-filmstrip">
          {order.slice(Math.max(0, index - 12), Math.max(0, index - 12) + 25).map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`rd-film-item${entry.id === item.id ? ' is-on' : ''}`}
              title={entry.name}
              onClick={() => go(entry)}
            >
              <img src={fileUrl(entry.id, entry.revision)} alt="" loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

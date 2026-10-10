/**
 * 阅读器右键菜单（浮层）。
 *
 * 只做"显示 + 回调"：菜单项由 PdfViewer 按"有没有选区"生成，选中后把命令原样交回，
 * 由 ReaderView 执行；这里不做任何业务动作，也不改动选区。
 *
 * 关闭时机：点中菜单项、Esc、点击菜单外、开始滚动/滚轮、窗口 resize（缩放变化由父级关闭）。
 * Esc 用捕获阶段拦下并 stopPropagation，避免同一按键又把阅读器/上层浮层一起关掉。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReaderContextCommand } from './contextCommands';

export interface PageContextMenuItem {
  /** 菜单文字 */
  label: string;
  /** 快捷键说明；会拼进 title，例如「高亮（选中后按 1）」 */
  hint?: string;
  /** 与上一项之间画一条分隔线 */
  separatorBefore?: boolean;
  command: ReaderContextCommand;
}

export interface PageContextMenuProps {
  /** 鼠标位置（clientX / clientY） */
  x: number;
  y: number;
  items: PageContextMenuItem[];
  /** 选中某一项：命令 + 菜单位置（与 PdfViewer 的 onContextCommand 第二个参数同义） */
  onPick: (command: ReaderContextCommand, at: { x: number; y: number }) => void;
  onClose: () => void;
}

/** 贴边时至少留出的空隙 */
const EDGE = 8;

export function PageContextMenu({ x, y, items, onPick, onClose }: PageContextMenuProps): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // 先按鼠标位置渲染，量出真实尺寸后再收进窗口内（避免超出右/下边缘）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxLeft = Math.max(EDGE, window.innerWidth - EDGE - rect.width);
    const maxTop = Math.max(EDGE, window.innerHeight - EDGE - rect.height);
    const left = Math.max(EDGE, Math.min(x, maxLeft));
    const top = Math.max(EDGE, Math.min(y, maxTop));
    setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
  }, [x, y, items.length]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      onClose();
    };
    const onDown = (ev: MouseEvent) => {
      if (!ref.current?.contains(ev.target as Node)) onClose();
    };
    const onScrollWheelResize = () => onClose();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScrollWheelResize, true);
    window.addEventListener('wheel', onScrollWheelResize, { passive: true });
    window.addEventListener('resize', onScrollWheelResize);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScrollWheelResize, true);
      window.removeEventListener('wheel', onScrollWheelResize);
      window.removeEventListener('resize', onScrollWheelResize);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="rd-ctx-menu"
      role="menu"
      aria-label="页面操作"
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      // 按住菜单不改变焦点、也不清掉页面上的选区（复制/批注都还要用它）
      onMouseDown={(ev) => ev.preventDefault()}
      onContextMenu={(ev) => ev.preventDefault()}
    >
      {items.map((item, index) => (
        <div key={`${item.command.kind}-${item.label}-${index}`} className="rd-ctx-cell">
          {item.separatorBefore && index > 0 ? <div className="rd-ctx-sep" role="separator" /> : null}
          <button
            type="button"
            role="menuitem"
            className="rd-ctx-item"
            title={item.hint ? `${item.label}（${item.hint}）` : item.label}
            onClick={() => onPick(item.command, { x, y })}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}

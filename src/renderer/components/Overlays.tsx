/**
 * 浮层：模态框 + 统一确认/输入对话框服务 + 右键菜单。
 * 确认框用单例 store，任意模块 await confirmDialog(...) 即可，不必层层传 props。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';

export interface MenuItemDef {
  label?: string;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  header?: boolean;
}

// ---------------------------------------------------------------- 模态框

export function Modal({
  title,
  children,
  actions,
  onClose,
  width,
}: {
  title?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={width ? { width } : undefined} role="dialog" aria-modal="true">
        {title ? <h2 className="modal-title">{title}</h2> : null}
        {children}
        {actions ? <div className="modal-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 对话框服务

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PromptOptions {
  title: string;
  message?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  multiline?: boolean;
  suggestions?: string[];
}

type DialogState =
  | ({ kind: 'confirm' } & ConfirmOptions)
  | ({ kind: 'prompt' } & PromptOptions)
  | null;

interface DialogStore {
  dialog: DialogState;
  resolve: ((value: unknown) => void) | null;
  open: (dialog: DialogState, resolve: (value: unknown) => void) => void;
  close: (value: unknown) => void;
}

const useDialogStore = create<DialogStore>((set, get) => ({
  dialog: null,
  resolve: null,
  open: (dialog, resolve) => set({ dialog, resolve }),
  close: (value) => {
    get().resolve?.(value);
    set({ dialog: null, resolve: null });
  },
}));

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.getState().open({ kind: 'confirm', ...options }, (v) => resolve(v === true));
  });
}

export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogStore.getState().open({ kind: 'prompt', ...options }, (v) => resolve(typeof v === 'string' ? v : null));
  });
}

export function DialogHost() {
  const dialog = useDialogStore((s) => s.dialog);
  const close = useDialogStore((s) => s.close);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  useEffect(() => {
    if (dialog) {
      setText(dialog.kind === 'prompt' ? dialog.defaultValue ?? '' : '');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [dialog]);

  if (!dialog) return null;

  if (dialog.kind === 'confirm') {
    return (
      <Modal
        title={dialog.title}
        onClose={() => close(false)}
        actions={
          <>
            <button className="btn" onClick={() => close(false)}>
              {dialog.cancelLabel ?? '取消'}
            </button>
            <button
              className={`btn ${dialog.danger ? 'danger' : 'primary'}`}
              onClick={() => close(true)}
              autoFocus
            >
              {dialog.confirmLabel ?? '确定'}
            </button>
          </>
        }
      >
        <div className="modal-body">{dialog.message}</div>
      </Modal>
    );
  }

  const submit = () => close(text.trim() ? text : dialog.defaultValue ?? '');
  return (
    <Modal
      title={dialog.title}
      onClose={() => close(null)}
      actions={
        <>
          <button className="btn" onClick={() => close(null)}>
            取消
          </button>
          <button className="btn primary" onClick={submit}>
            {dialog.confirmLabel ?? '确定'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        {dialog.message}
        {dialog.multiline ? (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            className="textarea"
            style={{ marginTop: 10, minHeight: 90 }}
            value={text}
            placeholder={dialog.placeholder}
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            className="input"
            style={{ marginTop: 10 }}
            value={text}
            placeholder={dialog.placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            onPaste={(e) => {
              // 支持"粘贴路径"：去掉引号与首尾空白
              const pasted = e.clipboardData.getData('text');
              if (pasted && /^["'].*["']$/.test(pasted.trim())) {
                e.preventDefault();
                setText(pasted.trim().replace(/^["']|["']$/g, ''));
              }
            }}
          />
        )}
        {dialog.suggestions?.length ? (
          <div className="modal-list">
            {dialog.suggestions.map((s) => (
              <button key={s} className="modal-list-item" onClick={() => setText(s)}>
                {s}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- 右键/下拉菜单

interface PopupState {
  x: number;
  y: number;
  items: MenuItemDef[];
}

export function usePopup() {
  const [popup, setPopup] = useState<PopupState | null>(null);

  useEffect(() => {
    if (!popup) return;
    const close = () => setPopup(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPopup(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', close);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('wheel', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [popup]);

  const open = (x: number, y: number, items: MenuItemDef[]) => setPopup({ x, y, items });
  const openFromEvent = (e: { clientX: number; clientY: number }, items: MenuItemDef[]) => {
    open(e.clientX, e.clientY, items);
  };

  return { open, openFromEvent, close: () => setPopup(null), element: <PopupLayer popup={popup} onClose={() => setPopup(null)} /> };
}

function PopupLayer({ popup, onClose }: { popup: PopupState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!popup) return;
    const el = ref.current;
    const pad = 8;
    const w = el?.offsetWidth ?? 200;
    const h = el?.offsetHeight ?? 200;
    let x = popup.x;
    let y = popup.y;
    if (x + w + pad > window.innerWidth) x = Math.max(pad, window.innerWidth - w - pad);
    if (y + h + pad > window.innerHeight) y = Math.max(pad, window.innerHeight - h - pad);
    setPos({ x, y });
  }, [popup]);

  if (!popup) return null;
  return (
    <div
      className="menu"
      ref={ref}
      style={{ left: pos.x, top: pos.y, visibility: pos.x ? 'visible' : 'hidden' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {popup.items.map((item, idx) => {
        if (item.separator) return <div className="menu-sep" key={`sep-${idx}`} />;
        if (item.header)
          return (
            <div className="menu-label" key={`h-${idx}`}>
              {item.label}
            </div>
          );
        return (
          <button
            key={`${item.label}-${idx}`}
            className={`menu-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            style={item.disabled ? { opacity: 0.4, cursor: 'default' } : undefined}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onClick?.();
            }}
          >
            {item.icon}
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
            {item.checked ? <span className="check">✓</span> : null}
          </button>
        );
      })}
    </div>
  );
}

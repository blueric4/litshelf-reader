/**
 * 小组件：空状态、阅读状态圆环、标签胶囊与编辑器、封面、进度条、Toast 容器。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Item, Toast } from '@shared/types';
import { useStore } from '../state/store';
import { api, thumbUrl } from '../bridge';
import { isTempFileName } from '@core/ignore';
import { IconCheck, IconInfo, IconPlus, IconWarning, IconX, kindIcon } from './Icons';
import { parseTagColors } from '../utils/format';

// ---------------------------------------------------------------- 空状态

export function EmptyState({
  art,
  title,
  desc,
  actions,
}: {
  art?: ReactNode;
  title: string;
  desc?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="empty">
      {art ? <div className="empty-art">{art}</div> : null}
      <div className="empty-title">{title}</div>
      {desc ? <div className="empty-desc">{desc}</div> : null}
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- 阅读状态圆环

export function CheckRing({ state, missing, onClick, title }: { state: Item['readState']; missing?: boolean; onClick?: () => void; title?: string }) {
  return (
    <button
      className={`checkring${missing ? ' missing' : state === 'read' ? ' read' : state === 'reading' ? ' reading' : ''}`}
      title={title ?? (state === 'read' ? '标记为未读' : '标记为已读')}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      aria-label={state === 'read' ? '标记为未读' : '标记为已读'}
    />
  );
}

// ---------------------------------------------------------------- 标签

export function TagChip({ tag, onRemove, color }: { tag: string; onRemove?: () => void; color?: string }) {
  const [bg, setBg] = useState<string | undefined>(color);
  useEffect(() => {
    if (!color) setBg(parseTagColors([tag]).get(tag));
  }, [tag, color]);
  return (
    <span className="chip" style={bg ? { background: `${bg}22`, color: bg } : undefined} title={tag}>
      {tag}
      {onRemove ? (
        <span
          className="x"
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </span>
      ) : null}
    </span>
  );
}

export function TagEditor({
  tags,
  allTags,
  onChange,
}: {
  tags: string[];
  allTags: string[];
  onChange: (next: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const addTags = (raw: string) => {
    const parts = raw
      .split(/[,，;；\s]+/)
      .map((s) => s.trim().replace(/^#/, ''))
      .filter(Boolean);
    if (!parts.length) return;
    onChange([...new Set([...tags, ...parts])]);
    setValue('');
  };

  const suggestions = allTags.filter((t) => !tags.includes(t) && (!value || t.toLowerCase().includes(value.toLowerCase()))).slice(0, 8);

  return (
    <div className="dp-tags">
      {tags.map((t) => (
        <TagChip key={t} tag={t} onRemove={() => onChange(tags.filter((x) => x !== t))} />
      ))}
      {editing ? (
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <input
            ref={inputRef}
            className="input"
            style={{ height: 22, width: 130, borderRadius: 999, fontSize: 12 }}
            value={value}
            placeholder="输入标签后回车"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addTags(value);
              } else if (e.key === 'Escape') {
                setEditing(false);
                setValue('');
              } else if (e.key === 'Backspace' && !value && tags.length) {
                onChange(tags.slice(0, -1));
              }
            }}
            onBlur={() => {
              if (value.trim()) addTags(value);
              setEditing(false);
            }}
          />
          {suggestions.length ? (
            <span
              style={{
                position: 'absolute',
                top: 26,
                left: 0,
                zIndex: 20,
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                boxShadow: 'var(--shadow-pop)',
                padding: 4,
                minWidth: 150,
              }}
            >
              {suggestions.map((s) => (
                <button
                  key={s}
                  className="menu-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addTags(s);
                  }}
                >
                  {s}
                </button>
              ))}
            </span>
          ) : null}
        </span>
      ) : (
        <button className="tag-add" onClick={() => setEditing(true)}>
          + 标签
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 封面

export function Cover({ item, size = 116 }: { item: Item; size?: number }) {
  const [failed, setFailed] = useState(false);
  const Icon = kindIcon(item.kind);
  const hasThumb = !!item.thumb && !failed;
  return (
    <div className="dp-cover" style={{ width: size, height: size * 1.34 }}>
      {hasThumb ? (
        <img src={thumbUrl(item.thumb!)} alt="" onError={() => setFailed(true)} draggable={false} />
      ) : (
        <Icon size={Math.round(size * 0.34)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 进度条

export function ProgressBar({ percent, done }: { percent: number; done?: boolean }) {
  return (
    <span className={`progressbar${done ? ' done' : ''}`}>
      <i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </span>
  );
}

// ---------------------------------------------------------------- Toast

function ToastIcon({ kind }: { kind: Toast['kind'] }) {
  if (kind === 'success') return <IconCheck size={12} />;
  if (kind === 'warn') return <IconWarning size={12} />;
  if (kind === 'error') return <IconX size={12} />;
  return <IconInfo size={12} />;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const select = useStore((s) => s.select);
  const setView = useStore((s) => s.setView);

  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="toast-icon">
            <ToastIcon kind={t.kind} />
          </span>
          <div className="toast-body">
            <div className="toast-msg">{t.message}</div>
            {t.detail ? <div className="toast-detail">{t.detail}</div> : null}
            {t.action ? (
              <button
                className="toast-action"
                onClick={async () => {
                  if (t.action!.name) await api.undo(t.action!.name, t.action!.payload).catch(() => false);
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            {t.itemIds?.length ? (
              <button
                className="toast-action"
                onClick={() => {
                  setView('library');
                  select(t.itemIds![0]);
                  if (t.itemIds!.length > 1) {
                    for (const id of t.itemIds!.slice(1)) void id;
                  }
                  dismiss(t.id);
                }}
              >
                查看
              </button>
            ) : null}
          </div>
          <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="关闭">
            <IconX size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- 拖拽接收提示

export function DropZone({ onFiles }: { onFiles: (paths: string[]) => void }) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    let depth = 0;
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth += 1;
      setActive(true);
    };
    const onDragLeave = () => {
      depth -= 1;
      if (depth <= 0) setActive(false);
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      const paths = files
        .map((f) => (f as File & { path?: string }).path)
        .filter((p): p is string => !!p && !isTempFileName(p.split(/[\\/]/).pop() ?? ''));
      if (paths.length) {
        e.preventDefault();
        onFiles(paths);
      }
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [onFiles]);

  if (!active) return null;
  return (
    <div className="dropzone">
      <span>松手即加入文献库</span>
    </div>
  );
}

// ---------------------------------------------------------------- 小按钮

export function IconButton({
  icon,
  title,
  onClick,
  active,
  size = 15,
}: {
  icon: ReactNode;
  title: string;
  onClick?: (e: React.MouseEvent) => void;
  active?: boolean;
  size?: number;
}) {
  return (
    <button className={`icon-btn${active ? ' active' : ''}`} title={title} aria-label={title} onClick={onClick} style={{ width: 28, height: 28 }}>
      <span style={{ display: 'inline-flex' }}>{icon}</span>
    </button>
  );
}

export { IconPlus };

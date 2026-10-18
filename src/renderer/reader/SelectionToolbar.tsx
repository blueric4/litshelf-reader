/**
 * 划词工具条 + 已有批注卡片。
 *
 * ## 工具条为什么改成了"顶部栏里的一行"
 *
 * 用户的原话：浮在选区上方的工具条"一划就挡在正文上，很烦、不实用"。
 * 它还会挡住正文里的字 —— 想选工具条下面的文字时会被工具条截获（已知缺陷）。
 *
 * 现在：划词时它**并进顶部的 `.rd-toolbar` 那一行**（顶替"标题 + 星标 + 在读"），
 * 不跟随选区、不覆盖正文、不改变页面布局。选中文字的内容**不再显示**（用户要求去掉）。
 * 文字只保留在无障碍属性里（`已选中 N 字`），视觉上只有按钮。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Annotation, AnnotationRect, AnnotationType, HighlightColor } from '@shared/types';
import { HIGHLIGHT_COLORS } from '@shared/types';

export interface SelectionToolbarProps {
  /** 选中的文字：**不再显示**，只用于无障碍提示（title/aria-label） */
  text: string;
  color: HighlightColor;
  onColor: (color: HighlightColor) => void;
  onAnnotate: (type: AnnotationType) => void;
  onCopy: () => void;
  onSearch: () => void;
  onClose: () => void;
}

const TOOLS: { type: AnnotationType; label: string; icon: React.ReactElement }[] = [
  {
    type: 'highlight',
    label: '高亮',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 14.5 4.5 19l1.2-4.4L15 5.3a1.8 1.8 0 0 1 2.6 0l1.1 1.1a1.8 1.8 0 0 1 0 2.6z" />
        <path d="M4.5 19h5" />
      </svg>
    ),
  },
  {
    type: 'underline',
    label: '下划线',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
        <path d="M7 4v7a5 5 0 0 0 10 0V4" />
        <path d="M5 20h14" />
      </svg>
    ),
  },
  {
    type: 'squiggly',
    label: '波浪线',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
        <path d="M4 12v3" />
        <path d="M4 20c1.4 0 2-4 3.4-4s2 4 3.4 4 2-4 3.4-4 2 4 3.4 4 2-4 3.4-4" />
      </svg>
    ),
  },
  {
    type: 'strikeout',
    label: '删除线',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
        <path d="M16 6.5C15 5.5 13.6 5 12 5 9.5 5 8 6.2 8 8s1.6 2.6 4 3" />
        <path d="M4 12h16" />
        <path d="M15.5 15.5c0 2-1.6 3.5-4 3.5-1.6 0-3-.5-4-1.4" />
      </svg>
    ),
  },
  {
    type: 'note',
    label: '批注',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
];

export function SelectionToolbar({
  text,
  color,
  onColor,
  onAnnotate,
  onCopy,
  onSearch,
  onClose,
}: SelectionToolbarProps): React.ReactElement {
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    if (!paletteOpen) return;
    const close = () => setPaletteOpen(false);
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [paletteOpen]);

  return (
    <div className="rd-sel-toolbar" role="toolbar" aria-label={`划词操作（已选中 ${text.length} 字）`} title={`已选中 ${text.length} 字`}>
      <button
        type="button"
        className="rd-sel-color"
        style={{ background: `var(--hl-${color})` }}
        title="高亮颜色"
        aria-label="高亮颜色"
        onPointerDown={(ev) => {
          ev.stopPropagation();
          setPaletteOpen((v) => !v);
        }}
      />
      {paletteOpen ? (
        <div className="rd-sel-palette">
          {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((name) => (
            <button
              key={name}
              type="button"
              className={`rd-swatch${name === color ? ' is-on' : ''}`}
              style={{ background: HIGHLIGHT_COLORS[name].light }}
              title={HIGHLIGHT_COLORS[name].label}
              aria-label={`颜色 ${HIGHLIGHT_COLORS[name].label}`}
              onClick={() => {
                onColor(name);
                setPaletteOpen(false);
              }}
            />
          ))}
        </div>
      ) : null}
      {TOOLS.map((tool) => (
        <button
          key={tool.type}
          type="button"
          className="rd-sel-btn"
          title={tool.label}
          aria-label={tool.label}
          onClick={() => onAnnotate(tool.type)}
        >
          {tool.icon}
        </button>
      ))}
      <span className="rd-sel-sep" />
      <button
        type="button"
        className="rd-sel-btn"
        title="复制"
        aria-label="复制选中文字"
        onClick={onCopy}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-7A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15" />
        </svg>
      </button>
      <button
        type="button"
        className="rd-sel-btn"
        title="在文内搜索"
        aria-label="在文内搜索选中文字"
        onClick={onSearch}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 4.5 4.5" />
        </svg>
      </button>
      <span className="rd-sel-sep" />
      <button type="button" className="rd-sel-btn rd-sel-close" title="关闭" aria-label="关闭" onClick={onClose}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}

export interface AnnotationCardProps {
  annotation: Annotation;
  /** 视口坐标 */
  x: number;
  y: number;
  onClose: () => void;
  onSaveComment: (comment: string) => void;
  onColor: (color: HighlightColor) => void;
  onDelete: () => void;
  onEditText?: () => void;
}

/** 点击已有批注后弹出的小卡片：原文 / 备注编辑 / 改色 / 删除 */
export function AnnotationCard({
  annotation,
  x,
  y,
  onClose,
  onSaveComment,
  onColor,
  onDelete,
  onEditText,
}: AnnotationCardProps): React.ReactElement {
  const [comment, setComment] = useState(annotation.comment);
  const [dirty, setDirty] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y + 8 });

  useLayoutEffect(() => {
    const el = wrapRef.current;
    const width = el?.offsetWidth ?? 320;
    const height = el?.offsetHeight ?? 200;
    setPos({
      left: Math.min(Math.max(8, x - width / 2), Math.max(8, window.innerWidth - width - 8)),
      top: Math.min(Math.max(8, y + 10), Math.max(8, window.innerHeight - height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    setComment(annotation.comment);
    setDirty(false);
  }, [annotation.id, annotation.comment]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      // 只关这张卡片：别让 Esc 顺带把整个阅读器也关了（阅读器的 Esc 是"返回列表"）
      ev.stopImmediatePropagation();
      onClose();
    };
    // 卡片先于阅读器挂载 → 监听器先注册，stopImmediatePropagation 才能拦住阅读器的处理
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const commit = () => {
    if (!dirty) return;
    onSaveComment(comment);
    setDirty(false);
  };

  return (
    <div className="rd-ann-card" ref={wrapRef} style={{ left: pos.left, top: pos.top }} onClick={(ev) => ev.stopPropagation()}>
      <div className="rd-ann-card-head">
        <span className="rd-ann-card-kind">
          {{ highlight: '高亮', underline: '下划线', squiggly: '波浪线', strikeout: '删除线', note: '批注', bookmark: '书签' }[annotation.type]}
        </span>
        <span className="rd-ann-card-page">第 {annotation.page} 页</span>
        <span className="rd-ann-card-grow" />
        <div className="rd-ann-card-swatches">
          {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((name) => (
            <button
              key={name}
              type="button"
              className={`rd-swatch${name === annotation.color ? ' is-on' : ''}`}
              style={{ background: HIGHLIGHT_COLORS[name].light }}
              title={HIGHLIGHT_COLORS[name].label}
              aria-label={`颜色 ${HIGHLIGHT_COLORS[name].label}`}
              onClick={() => onColor(name)}
            />
          ))}
        </div>
      </div>

      {annotation.needsReview ? (
        <div className="rd-ann-card-review">
          <b>需要确认位置</b>
          <span>{annotation.reanchorNote ?? '文件更新后未能自动定位到原文'}</span>
        </div>
      ) : null}

      {annotation.text ? (
        <blockquote className="rd-ann-card-quote" onClick={onEditText}>
          {annotation.text.length > 300 ? `${annotation.text.slice(0, 300)}…` : annotation.text}
        </blockquote>
      ) : null}

      <textarea
        ref={areaRef}
        className="rd-ann-card-input"
        placeholder="写点想法…"
        value={comment}
        onChange={(ev) => {
          setComment(ev.target.value);
          setDirty(true);
        }}
        onBlur={commit}
        rows={3}
      />

      <div className="rd-ann-card-actions">
        <button type="button" className="btn sm danger" onClick={onDelete}>
          删除
        </button>
        <span className="rd-ann-card-grow" />
        {dirty ? (
          <button type="button" className="btn sm primary" onClick={commit}>
            保存
          </button>
        ) : (
          <button type="button" className="btn sm" onClick={onClose}>
            完成
          </button>
        )}
      </div>
      <div className="rd-ann-card-foot">{new Date(annotation.updatedAt || annotation.createdAt).toLocaleString('zh-CN')}</div>
    </div>
  );
}

export type { AnnotationRect };

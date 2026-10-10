/**
 * 批注绘制层：按 0-1 相对矩形在页面容器上叠一层（pointer-events 交给每条批注自己）。
 * 高亮 / 下划线 / 波浪线 / 删除线 / 便签角标 / 书签，needsReview 用虚线 + 感叹号。
 */
import { memo } from 'react';
import type { Annotation, AnnotationRect } from '@shared/types';

export interface AnnotationLayerProps {
  annotations: Annotation[];
  page: number;
  onSelect?: (annotation: Annotation) => void;
  /** 跳转定位时短暂闪烁的批注 id */
  flashId?: string | null;
  /** 只读（非 PDF 视图里不给点击） */
  interactive?: boolean;
}

/** 相对矩形 -> 绝对定位样式 */
export function rectStyle(rect: AnnotationRect): React.CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.w * 100}%`,
    height: `${rect.h * 100}%`,
  };
}

function Mark({ annotation, rect, onSelect, flash }: {
  annotation: Annotation;
  rect: AnnotationRect;
  onSelect?: (annotation: Annotation) => void;
  flash: boolean;
}): React.ReactElement | null {
  const isText = annotation.type === 'highlight' || annotation.type === 'underline' || annotation.type === 'squiggly' || annotation.type === 'strikeout';
  if (!isText && annotation.type !== 'note') return null;

  const classes = ['rd-ann', `rd-ann-${annotation.type}`];
  if (annotation.needsReview) classes.push('is-review');
  if (flash) classes.push('is-flash');

  if (annotation.type === 'squiggly') {
    return (
      <span
        className={classes.join(' ')}
        style={{ ...rectStyle(rect), ['--rd-ann-color' as string]: `var(--hl-${annotation.color})` }}
        onClick={onSelect ? () => onSelect(annotation) : undefined}
        title={annotation.text}
      >
        <i className="rd-squiggle" />
      </span>
    );
  }

  if (annotation.type === 'strikeout') {
    return (
      <span
        className={classes.join(' ')}
        style={{ ...rectStyle(rect), ['--rd-ann-color' as string]: `var(--hl-${annotation.color})` }}
        onClick={onSelect ? () => onSelect(annotation) : undefined}
        title={annotation.text}
      >
        <i className="rd-strike" />
        {annotation.needsReview ? <i className="rd-ann-flag">!</i> : null}
      </span>
    );
  }

  return (
    <span
      className={classes.join(' ')}
      style={{ ...rectStyle(rect), ['--rd-ann-color' as string]: `var(--hl-${annotation.color})`, color: `var(--hl-${annotation.color})` }}
      onClick={onSelect ? () => onSelect(annotation) : undefined}
      title={annotation.text}
    >
      {annotation.needsReview ? <i className="rd-ann-flag">!</i> : null}
    </span>
  );
}

/** 便签：在页边用一个小图标表示 */
function NotePin({ annotation, onSelect, flash }: {
  annotation: Annotation;
  onSelect?: (annotation: Annotation) => void;
  flash: boolean;
}): React.ReactElement {
  const first = annotation.rects[0] ?? { x: 0.94, y: 0.04, w: 0, h: 0.02 };
  return (
    <button
      type="button"
      className={`rd-note-pin${flash ? ' is-flash' : ''}${annotation.needsReview ? ' is-review' : ''}`}
      style={{
        top: `${Math.min(0.96, Math.max(0.01, first.y)) * 100}%`,
        right: `${Math.min(6, Math.max(0, (1 - first.x - first.w) * 100 + 0.6))}%`,
        ['--rd-ann-color' as string]: `var(--hl-${annotation.color})`,
      }}
      onClick={(ev) => {
        ev.stopPropagation();
        onSelect?.(annotation);
      }}
      title={annotation.comment || annotation.text || '便签'}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8A2.5 2.5 0 0 1 17.5 16H10l-4.4 4.2A.6.6 0 0 1 4.6 20z" />
      </svg>
    </button>
  );
}

export const AnnotationLayer = memo(function AnnotationLayer({
  annotations,
  page,
  onSelect,
  flashId,
  interactive = true,
}: AnnotationLayerProps): React.ReactElement {
  const mine = annotations.filter((a) => a.page === page && a.type !== 'bookmark');
  if (!mine.length) return <div className="rd-ann-layer" aria-hidden />;
  return (
    <div className={`rd-ann-layer${interactive ? '' : ' is-static'}`}>
      {mine.map((annotation) => {
        const flash = flashId === annotation.id;
        if (annotation.type === 'note') {
          return <NotePin key={annotation.id} annotation={annotation} onSelect={interactive ? onSelect : undefined} flash={flash} />;
        }
        return (
          <span key={annotation.id} className="rd-ann-cluster">
            {annotation.rects.map((rect, idx) => (
              <Mark
                key={`${annotation.id}-${idx}`}
                annotation={annotation}
                rect={rect}
                onSelect={interactive ? onSelect : undefined}
                flash={flash}
              />
            ))}
          </span>
        );
      })}
    </div>
  );
});

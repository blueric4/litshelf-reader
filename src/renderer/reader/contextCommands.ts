/**
 * 阅读器右键菜单的命令契约（唯一来源）。
 *
 * 这里只定义"菜单能发出什么命令"，不包含任何执行逻辑：
 * PdfViewer / PageContextMenu 负责在合适的时机把命令回调出去，由 ReaderView 执行。
 *
 * 批注类型直接用仓库自己的 `AnnotationType`（字面量与之一致，接线方不需要再做映射）：
 *   highlight（高亮）/ underline（下划线）/ squiggly（波浪线）/ strikeout（删除线）。
 */
import type { AnnotationType } from '@shared/types';

/** 右键菜单里能直接落的批注类型 */
export type ReaderContextAnnotateType = Extract<AnnotationType, 'highlight' | 'underline' | 'squiggly' | 'strikeout'>;

export type ReaderContextCommand =
  | { kind: 'annotate'; type: ReaderContextAnnotateType }
  | { kind: 'copy-selection' }
  | { kind: 'copy-selection-with-citation' }
  | { kind: 'search-selection'; text: string }
  | { kind: 'copy-citation' }
  | { kind: 'fit'; mode: 'fit-width' | 'fit-page' }
  | { kind: 'bookmark' };

/**
 * 批注锚点：文本归一化 + 在"新版正文"里重新定位。
 * 宿主侧只做文本级定位（更新页码、判断是否需人工确认）；
 * 精确到坐标的重定位由渲染层在打开文档时用 pdf.js 的文本几何完成。
 */
import type { Annotation } from '../shared/types';

/** 归一化：折叠空白、统一引号破折号、拉丁转小写 */
export function normalizeForMatch(input: string): string {
  return input
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripAllSpaces(s: string): string {
  return s.replace(/\s+/g, '');
}

export interface LocateResult {
  page: number;
  confidence: number;
  /** 'context' | 'text' | 'loose' | 'none' */
  how: 'context' | 'text' | 'loose' | 'none';
  /** 命中位置在该页归一化文本中的字符偏移 */
  offset: number;
}

/**
 * 在新正文里找一段旧批注文字。
 * pages 为 1 基页码对应的纯文本数组。
 */
export function locateInPages(
  pages: string[],
  text: string,
  anchor?: { prefix?: string; suffix?: string; occurrence?: number },
): LocateResult {
  const needle = normalizeForMatch(text);
  if (!needle) return { page: 1, confidence: 0, how: 'none', offset: 0 };
  const prefix = anchor?.prefix ? normalizeForMatch(anchor.prefix) : '';
  const suffix = anchor?.suffix ? normalizeForMatch(anchor.suffix) : '';
  const occurrence = anchor?.occurrence ?? 1;

  const norm = pages.map((p) => normalizeForMatch(p));
  const matches: { page: number; offset: number; confidence: number; how: LocateResult['how'] }[] = [];

  // 1) 带上下文精确匹配
  if (prefix || suffix) {
    const ctxNeedle = `${prefix}${prefix ? ' ' : ''}${needle}${suffix ? ' ' : ''}${suffix}`.trim();
    for (let i = 0; i < norm.length; i += 1) {
      const at = norm[i].indexOf(ctxNeedle);
      if (at >= 0) matches.push({ page: i + 1, offset: at, confidence: 1, how: 'context' });
    }
  }

  // 2) 仅正文匹配
  if (!matches.length) {
    for (let i = 0; i < norm.length; i += 1) {
      let from = 0;
      for (;;) {
        const at = norm[i].indexOf(needle, from);
        if (at < 0) break;
        matches.push({ page: i + 1, offset: at, confidence: 0.85, how: 'text' });
        from = at + Math.max(1, needle.length);
        if (matches.length > 200) break;
      }
      if (matches.length > 200) break;
    }
  }

  // 3) 去掉所有空白后再试（PDF 断行/连字符造成的差异）
  if (!matches.length) {
    const flatNeedle = stripAllSpaces(needle);
    if (flatNeedle.length >= 4) {
      for (let i = 0; i < pages.length; i += 1) {
        const flat = stripAllSpaces(norm[i]);
        const at = flat.indexOf(flatNeedle);
        if (at >= 0) matches.push({ page: i + 1, offset: at, confidence: 0.6, how: 'loose' });
      }
    }
  }

  if (!matches.length) return { page: 1, confidence: 0, how: 'none', offset: 0 };

  // 多个候选：优先上下文匹配，其次按 occurrence 取第 n 个
  const byQuality = matches.slice().sort((a, b) => b.confidence - a.confidence);
  const best = byQuality[0];
  const sameQuality = matches.filter((m) => m.confidence === best.confidence);
  if (sameQuality.length > 1) {
    const idx = Math.min(occurrence - 1, sameQuality.length - 1);
    const chosen = sameQuality[Math.max(0, idx)];
    return { page: chosen.page, offset: chosen.offset, confidence: chosen.confidence - 0.1, how: chosen.how };
  }
  return { page: best.page, offset: best.offset, confidence: best.confidence, how: best.how };
}

export interface ReanchorOutcome {
  annotation: Annotation;
  changed: boolean;
  /** 需要人工确认 */
  needsReview: boolean;
  note?: string;
}

/**
 * 文件内容变化后，把一条批注重新落到新正文上。
 * - 书签只用页码/百分比锚定，永远可恢复
 * - 定位失败不删除，标记 needsReview 交给用户
 */
export function reanchorAnnotation(annotation: Annotation, pages: string[]): ReanchorOutcome {
  if (annotation.type === 'bookmark') {
    const total = pages.length || 1;
    const page = Math.min(Math.max(1, annotation.page), total);
    if (page === annotation.page) return { annotation, changed: false, needsReview: false };
    return {
      annotation: { ...annotation, page, reanchored: true, updatedAt: Date.now(), reanchorNote: `按页码百分比还原到 P${page}` },
      changed: true,
      needsReview: false,
      note: `书签已还原到 P${page}`,
    };
  }

  const result = locateInPages(pages, annotation.text, annotation.anchor);
  if (result.how === 'none') {
    return {
      annotation: {
        ...annotation,
        needsReview: true,
        reanchorNote: '文件已更新，未能自动定位到原文，请手动确认位置',
        updatedAt: Date.now(),
      },
      changed: true,
      needsReview: true,
      note: '有批注需要人工确认位置',
    };
  }

  const pageChanged = result.page !== annotation.page;
  const lowConfidence = result.confidence < 0.7;
  const next: Annotation = {
    ...annotation,
    page: result.page,
    reanchored: true,
    needsReview: lowConfidence,
    updatedAt: Date.now(),
    reanchorNote: pageChanged
      ? `文件更新后按文本重新定位到 P${result.page}${lowConfidence ? '（低置信度，位置可能不准）' : ''}`
      : `文件更新后重新定位（仍在 P${result.page}）`,
  };
  return { annotation: next, changed: true, needsReview: lowConfidence, note: next.reanchorNote };
}

/** 从正文里截取批注的上下文，用于新建批注时的锚点 */
export function buildAnchor(pageText: string, matchIndex: number, matchLength: number): Annotation['anchor'] {
  const before = pageText.slice(Math.max(0, matchIndex - 40), matchIndex);
  const after = pageText.slice(matchIndex + matchLength, matchIndex + matchLength + 40);
  const normalizedPage = normalizeForMatch(pageText);
  const normalizedNeedle = normalizeForMatch(pageText.slice(matchIndex, matchIndex + matchLength));
  let occurrence = 1;
  if (normalizedNeedle) {
    let from = 0;
    for (;;) {
      const at = normalizedPage.indexOf(normalizedNeedle, from);
      if (at < 0 || at >= normalizeForMatch(pageText.slice(0, matchIndex)).length) break;
      occurrence += 1;
      from = at + 1;
    }
  }
  return { prefix: before.trim().slice(-32), suffix: after.trim().slice(0, 32), occurrence };
}

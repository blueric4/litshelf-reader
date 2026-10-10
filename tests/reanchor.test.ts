/**
 * src/core/reanchor.ts —— 批注锚点：归一化、文本重定位、文件更新后的重定位。
 */
import { describe, expect, it } from 'vitest';

import { buildAnchor, locateInPages, normalizeForMatch, reanchorAnnotation } from '@core/reanchor';
import { makeAnnotation } from './helpers';

describe('normalizeForMatch', () => {
  it('折叠空白并转小写', () => {
    expect(normalizeForMatch('  Hello   World \n\t Foo ')).toBe('hello world foo');
    expect(normalizeForMatch('')).toBe('');
  });

  it('统一引号、破折号与不换行空格', () => {
    expect(normalizeForMatch('\u201CHi\u201D \u2018there\u2019')).toBe('"hi" \'there\'');
    expect(normalizeForMatch('a\u2010b\u2011c\u2012d\u2013e\u2014f\u2015g\u2212h')).toBe('a-b-c-d-e-f-g-h');
    expect(normalizeForMatch('a\u00A0b')).toBe('a b');
  });
});

describe('locateInPages：在新正文里找旧批注文字', () => {
  it('换页后能定位到新页码', () => {
    const pages = ['第一章 引言', '我们研究 Graph Neural Networks 的应用'];
    const r = locateInPages(pages, 'Graph Neural Networks');
    expect(r.page).toBe(2);
    expect(r.how).toBe('text');
    expect(r.confidence).toBeCloseTo(0.85, 5);
    expect(r.offset).toBeGreaterThan(0);
  });

  it('带上下文锚点时优先用上下文匹配（高置信）', () => {
    const pages = ['The quick brown fox jumps over the lazy dog.', 'brown fox again, without context'];
    const r = locateInPages(pages, 'brown fox', { prefix: 'the quick', suffix: 'jumps over', occurrence: 1 });
    expect(r.page).toBe(1);
    expect(r.how).toBe('context');
    expect(r.confidence).toBe(1);
    expect(r.offset).toBe(0);
  });

  it('上下文匹配用在第二页也一样准', () => {
    const pages = ['无关内容', 'The quick brown fox jumps over the lazy dog.'];
    const r = locateInPages(pages, 'brown fox', { prefix: 'the quick', suffix: 'jumps over' });
    expect(r.page).toBe(2);
    expect(r.how).toBe('context');
  });

  it('出现多次时按 occurrence 取第 N 个', () => {
    const pages = ['alpha beta alpha beta gamma'];
    const first = locateInPages(pages, 'alpha', { occurrence: 1 });
    const second = locateInPages(pages, 'alpha', { occurrence: 2 });
    expect(first.page).toBe(1);
    expect(second.page).toBe(1);
    expect(first.offset).toBe(0);
    expect(second.offset).toBe(11);
    // 多候选一律降置信度（0.85 - 0.1），提醒上层"不是唯一解"
    expect(first.confidence).toBeCloseTo(0.75, 5);
    expect(second.confidence).toBeCloseTo(0.75, 5);
  });

  it('页码是 1 基的：第 3 页命中就返回 3', () => {
    const pages = ['a', 'b', 'target text here', 'd', 'e'];
    expect(locateInPages(pages, 'target text').page).toBe(3);
  });

  it('去空白后仍能找到 → how=loose，置信度较低', () => {
    const r = locateInPages(['MachineLearning is fun'], 'Machine Learning');
    expect(r.page).toBe(1);
    expect(r.how).toBe('loose');
    expect(r.confidence).toBeCloseTo(0.6, 5);
  });

  it('完全找不到 → how=none，不抛异常', () => {
    const r = locateInPages(['完全不同的内容'], '这段原文不存在');
    expect(r.how).toBe('none');
    expect(r.confidence).toBe(0);
  });

  it('空文本 / 空 pages 直接判 none', () => {
    expect(locateInPages(['a'], '').how).toBe('none');
    expect(locateInPages([], 'anything').how).toBe('none');
  });
});

describe('reanchorAnnotation', () => {
  it('原文换页后更新 page，并标注 reanchored', () => {
    const annotation = makeAnnotation({ page: 1, text: 'Graph Neural Networks', reanchored: false });
    const out = reanchorAnnotation(annotation, ['引言部分', '正文里讲了 Graph Neural Networks 的用法']);

    expect(out.changed).toBe(true);
    expect(out.needsReview).toBe(false);
    expect(out.annotation.id).toBe(annotation.id);
    expect(out.annotation.page).toBe(2);
    expect(out.annotation.reanchored).toBe(true);
    expect(out.annotation.needsReview).toBe(false);
    expect(out.annotation.reanchorNote).toContain('P2');
    expect(out.note).toContain('P2');
  });

  it('原文整段消失：批注对象仍然返回，只标 needsReview，不丢数据', () => {
    const annotation = makeAnnotation({
      page: 3,
      text: '这段原文已经被作者删掉了',
      comment: '重要批注',
      rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.05 }],
    });
    const out = reanchorAnnotation(annotation, ['全新的第一页内容', '全新的第二页内容']);

    expect(out.changed).toBe(true);
    expect(out.needsReview).toBe(true);
    expect(out.annotation).toBeDefined(); // ← 绝不能返回 null / undefined
    expect(out.annotation.id).toBe(annotation.id);
    expect(out.annotation.text).toBe('这段原文已经被作者删掉了');
    expect(out.annotation.comment).toBe('重要批注');
    expect(out.annotation.rects).toEqual(annotation.rects);
    expect(out.annotation.page).toBe(3); // 页码无法确定时保持原值，交给人工确认
    expect(out.annotation.needsReview).toBe(true);
    expect(out.annotation.reanchorNote).toContain('手动确认');
    expect(out.note).toContain('人工确认');
  });

  it('低置信度定位：页码更新了但仍要求人工确认', () => {
    const annotation = makeAnnotation({ page: 4, text: 'Machine Learning' });
    const out = reanchorAnnotation(annotation, ['MachineLearning 相关章节']);

    expect(out.annotation.page).toBe(1);
    expect(out.changed).toBe(true);
    expect(out.needsReview).toBe(true);
    expect(out.annotation.needsReview).toBe(true);
    expect(out.annotation.reanchorNote).toContain('低置信度');
  });

  it('位置没变也要重新确认一次（原地重定位）', () => {
    const annotation = makeAnnotation({ page: 2, text: '稳定的一段话' });
    const out = reanchorAnnotation(annotation, ['第一页', '稳定的一段话仍然在这里']);
    expect(out.annotation.page).toBe(2);
    expect(out.changed).toBe(true);
    expect(out.needsReview).toBe(false);
    expect(out.annotation.reanchorNote).toContain('仍在 P2');
  });

  it('bookmark 只按页码锚定，永远能恢复', () => {
    const inRange = makeAnnotation({ type: 'bookmark', page: 2, text: '' });
    const same = reanchorAnnotation(inRange, ['a', 'b', 'c']);
    expect(same.changed).toBe(false);
    expect(same.needsReview).toBe(false);
    expect(same.annotation.page).toBe(2);

    const outOfRange = makeAnnotation({ type: 'bookmark', page: 9, text: '' });
    const clamped = reanchorAnnotation(outOfRange, ['a', 'b', 'c']);
    expect(clamped.changed).toBe(true);
    expect(clamped.needsReview).toBe(false);
    expect(clamped.annotation.page).toBe(3);
    expect(clamped.annotation.reanchored).toBe(true);
    expect(clamped.note).toContain('P3');

    const noPages = makeAnnotation({ type: 'bookmark', page: 5, text: '' });
    const fallback = reanchorAnnotation(noPages, []);
    expect(fallback.annotation.page).toBe(1);
    expect(fallback.needsReview).toBe(false);
  });
});

describe('buildAnchor', () => {
  it('截取上下文并数出这是第几次出现', () => {
    const page = 'Alpha beta alpha beta gamma';
    const firstIdx = page.indexOf('Alpha');
    const secondIdx = page.indexOf('alpha', 6);

    const first = buildAnchor(page, firstIdx, 5);
    expect(first.occurrence).toBe(1);
    expect(first.prefix).toBe('');
    expect(first.suffix.startsWith('beta')).toBe(true);

    const second = buildAnchor(page, secondIdx, 5);
    expect(second.occurrence).toBe(2);
    expect(second.prefix).toContain('beta');
    expect(second.suffix).toContain('beta gamma');
  });

  it('前缀后缀各自不超过 32 字符', () => {
    const page = `${'x'.repeat(80)}NEEDLE${'y'.repeat(80)}`;
    const idx = page.indexOf('NEEDLE');
    const anchor = buildAnchor(page, idx, 6);
    expect(anchor.prefix.length).toBeLessThanOrEqual(32);
    expect(anchor.suffix.length).toBeLessThanOrEqual(32);
  });

  it('用自己生成的锚点能重新定位回原页码', () => {
    const page = 'The quick brown fox jumps over the lazy dog.';
    const idx = page.indexOf('brown fox');
    const anchor = buildAnchor(page, idx, 'brown fox'.length);
    const r = locateInPages(['other page', page], 'brown fox', anchor);
    expect(r.page).toBe(2);
    expect(r.how).toBe('context');
  });
});

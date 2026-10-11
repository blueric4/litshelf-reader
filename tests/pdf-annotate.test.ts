import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { safeColor, touchedPages, writeAnnotationsIntoPdf, type PdfAnnotInput } from '../src/core/pdf-annotate';

const require = createRequire(import.meta.url);

/** 造一份两页的空白 PDF（带指定页面尺寸），用来当"原文件" */
async function makeSource(width = 595, height = 842): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  doc.addPage([width, height]);
  return doc.save({ useObjectStreams: false });
}

/** 用 pdf.js 重新打开写好的字节流，读回注释（这是"别人家的阅读器能不能看到"的等价验证） */
async function readAnnots(bytes: Uint8Array, pageNumber: number) {
  const pdfjs = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  const doc = await pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false }).promise;
  try {
    const page = await doc.getPage(pageNumber);
    return (await page.getAnnotations({ intent: 'display' })) as Array<Record<string, unknown>>;
  } finally {
    await doc.destroy();
  }
}

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe('writeAnnotationsIntoPdf', () => {
  it('写入高亮后，用 pdf.js 能读回一条 Highlight，且矩形方向正确（y 轴向上）', async () => {
    const src = await makeSource();
    const annots: PdfAnnotInput[] = [
      { page: 1, kind: 'highlight', rects: [rect(0.1, 0.2, 0.3, 0.05)], quote: '选中一句话', note: '我的批注' },
    ];
    const { bytes, written, skipped } = await writeAnnotationsIntoPdf(src, annots);
    expect(written).toBe(1);
    expect(skipped).toBe(0);

    const read = await readAnnots(bytes, 1);
    const link = read.filter((a) => a.subtype === 'Highlight');
    expect(link).toHaveLength(1);
    const a = link[0];
    // Rect: [x1, y1, x2, y2]，y 向上 → 0.2~0.25（从页顶算）应落成 0.75~0.80（从页底算）
    const r = a.rect as number[];
    expect(r[0]).toBeCloseTo(0.1 * 595, 0);
    expect(r[1]).toBeCloseTo((1 - 0.25) * 842, 0);
    expect(r[2]).toBeCloseTo(0.4 * 595, 0);
    expect(r[3]).toBeCloseTo((1 - 0.2) * 842, 0);
    expect(String((a.contentsObj as { str?: string } | undefined)?.str ?? a.contents ?? '')).toContain('我的批注');
  });

  it('四种类型都能写，并落在正确的页上', async () => {
    const src = await makeSource();
    const kinds = ['highlight', 'underline', 'squiggly', 'strikeout'] as const;
    const annots: PdfAnnotInput[] = kinds.map((kind, i) => ({
      page: i % 2 === 0 ? 1 : 2,
      kind,
      rects: [rect(0.1, 0.1 + i * 0.1, 0.4, 0.04)],
    }));
    const { bytes, written } = await writeAnnotationsIntoPdf(src, annots);
    expect(written).toBe(4);
    const p1 = (await readAnnots(bytes, 1)).map((a) => a.subtype);
    const p2 = (await readAnnots(bytes, 2)).map((a) => a.subtype);
    expect(p1.filter(Boolean)).toHaveLength(2);
    expect(p2.filter(Boolean)).toHaveLength(2);
    expect([...p1, ...p2]).toEqual(expect.arrayContaining(['Highlight', 'Underline', 'Squiggly', 'StrikeOut']));
  });

  it('多矩形（多行选区）逐行写，各自是独立注释', async () => {
    const src = await makeSource();
    const { bytes, written } = await writeAnnotationsIntoPdf(src, [
      { page: 1, kind: 'highlight', rects: [rect(0.1, 0.1, 0.5, 0.04), rect(0.1, 0.15, 0.3, 0.04)] },
    ]);
    expect(written).toBe(2);
    expect(await readAnnots(bytes, 1)).toHaveLength(2);
  });

  it('退化/页外矩形会被跳过，不会写出零面积注释', async () => {
    const src = await makeSource();
    const { bytes, written, skipped } = await writeAnnotationsIntoPdf(src, [
      { page: 1, kind: 'highlight', rects: [rect(0.1, 0.1, 0, 0.04), rect(0.1, 0.1, 0.3, 0)] },
    ]);
    expect(written).toBe(0);
    expect(skipped).toBe(2);
    expect(await readAnnots(bytes, 1)).toHaveLength(0);
  });

  it('页码越界与旋转页只跳过、不抛错（旋转页宁可不写也不写歪）', async () => {
    const doc = await PDFDocument.create();
    const rotated = doc.addPage([595, 842]);
    rotated.setRotation({ type: 'degrees', angle: 90 } as never);
    const src = await doc.save({ useObjectStreams: false });
    const { written, skipped } = await writeAnnotationsIntoPdf(src, [
      { page: 5, kind: 'highlight', rects: [rect(0.1, 0.1, 0.2, 0.05)] },
      { page: 1, kind: 'highlight', rects: [rect(0.1, 0.1, 0.2, 0.05)] },
    ]);
    expect(written).toBe(0);
    expect(skipped).toBe(2);
  });

  it('原字节流不被修改（写的是新副本）', async () => {
    const src = await makeSource();
    const before = src.slice();
    await writeAnnotationsIntoPdf(src, [{ page: 1, kind: 'highlight', rects: [rect(0.1, 0.1, 0.2, 0.05)] }]);
    expect(Array.from(src)).toEqual(Array.from(before));
  });

  it('空批注列表时也能安全返回', async () => {
    const src = await makeSource();
    const { bytes, written, skipped } = await writeAnnotationsIntoPdf(src, []);
    expect(written).toBe(0);
    expect(skipped).toBe(0);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(await readAnnots(bytes, 1)).toHaveLength(0);
  });
});

describe('辅助函数', () => {
  it('safeColor 会把越界与 NaN 夹到 0–1', () => {
    const c = safeColor([2, -1, Number.NaN]);
    expect(c).toBeDefined();
  });

  it('touchedPages 去重并升序，忽略没有矩形的批注', () => {
    expect(
      touchedPages([
        { page: 3, kind: 'highlight', rects: [rect(0.1, 0.1, 0.2, 0.05)] },
        { page: 1, kind: 'highlight', rects: [rect(0.1, 0.1, 0.2, 0.05)] },
        { page: 3, kind: 'note' as never, rects: [] },
      ]),
    ).toEqual([1, 3]);
  });
});

/**
 * 把我们的批注**写回 PDF 文件**（作为真正的 PDF 注释对象）。
 *
 * 为什么值得做：批注现在只存在我们自己的库里，用别的阅读器（Acrobat、Zotero、浏览器）
 * 打开那份 PDF 什么都看不到。写成标准的 `/Highlight` `/Underline` `/Squiggly` `/StrikeOut`
 * 注释之后，任何 PDF 阅读器都能显示，这才叫"不锁在软件里"。
 *
 * 设计取舍：
 *   · **绝不改原文件**：调用方拿到的是新字节流，由上层写成"带批注的副本"；
 *   · 只处理 `/Rotate` 为 0 的页面：旋转页需要额外的坐标变换，先明确跳过并记下来，
 *     宁可少写一页，也不要写歪（写歪比不写更糟）；
 *   · 注释颜色用**相对矩形**推算（我们的批注存的就是页内 0–1 归一化矩形，与缩放无关）。
 */
import { PDFDocument, PDFHexString, PDFName, PDFNumber, rgb, type PDFPage } from 'pdf-lib';

/** 与 `src/shared/types.ts` 的 AnnotationRect 保持一致：页内 0–1、y 轴向下 */
export interface PdfAnnotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PdfAnnotKind = 'highlight' | 'underline' | 'squiggly' | 'strikeout';

export interface PdfAnnotInput {
  /** 1 基页码（与界面一致） */
  page: number;
  kind: PdfAnnotKind;
  rects: PdfAnnotRect[];
  /** 0–1 的 RGB；缺省用高亮黄 */
  color?: [number, number, number];
  /** 批注正文（可空） */
  note?: string;
  /** 摘录的文字（写进 Contents 之前作为提示，便于别的阅读器里一眼看出选了什么） */
  quote?: string;
  /** 作者名，缺省 LitShelf */
  author?: string;
}

export interface PdfAnnotResult {
  bytes: Uint8Array;
  written: number;
  /** 因页面旋转/矩形非法而跳过的条数 */
  skipped: number;
}

const SUBTYPE: Record<PdfAnnotKind, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  squiggly: 'Squiggly',
  strikeout: 'StrikeOut',
};

const DEFAULT_COLOR: [number, number, number] = [1, 0.85, 0.2];

/** 0–1 矩形 → PDF 用户空间（y 轴向上）的 `[x, y, w, h]`；完全在页外或退化的返回 null */
function toPdfBox(rect: PdfAnnotRect, pageW: number, pageH: number): [number, number, number, number] | null {
  const x = Math.max(0, Math.min(1, rect.x));
  const y = Math.max(0, Math.min(1, rect.y));
  const w = Math.max(0, Math.min(1 - x, rect.w));
  const h = Math.max(0, Math.min(1 - y, rect.h));
  if (w <= 0.0005 || h <= 0.0005) return null;
  const xPdf = x * pageW;
  const wPdf = w * pageW;
  const hPdf = h * pageH;
  // 我们的 y 是"从页顶往下"，PDF 是"从页底往上"
  const yPdf = pageH - (y + h) * pageH;
  return [xPdf, yPdf, wPdf, hPdf];
}

/** 一条注释的 QuadPoints：每个 quad 依次是 左上、右上、左下、右下（PDF 规范顺序） */
function quadPoints([x, y, w, h]: [number, number, number, number]): number[] {
  const left = x;
  const right = x + w;
  const bottom = y;
  const top = y + h;
  return [left, top, right, top, left, bottom, right, bottom];
}

/**
 * 把批注写进 PDF 字节流，返回**新的**字节流。
 *
 * @param source 原 PDF 的字节
 * @param annots 要写入的批注（页码 1 基）
 */
export async function writeAnnotationsIntoPdf(
  source: Uint8Array,
  annots: PdfAnnotInput[],
): Promise<PdfAnnotResult> {
  const doc = await PDFDocument.load(source, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  let written = 0;
  let skipped = 0;

  for (const annot of annots) {
    const page = pages[annot.page - 1];
    if (!page || !annot.rects?.length) {
      skipped += 1;
      continue;
    }
    const rotation = page.getRotation().angle % 360;
    if (rotation !== 0) {
      // 旋转页的坐标变换先不做：宁可跳过，也不要在别人的阅读器里看到歪掉的批注
      skipped += annot.rects.length;
      continue;
    }
    const pageW = page.getWidth();
    const pageH = page.getHeight();
    const [r, g, b] = annot.color ?? DEFAULT_COLOR;

    for (const rect of annot.rects) {
      const box = toPdfBox(rect, pageW, pageH);
      if (!box) {
        skipped += 1;
        continue;
      }
      const [x, y, w, h] = box;
      const contents = [annot.quote ? `「${annot.quote}」` : '', annot.note ?? ''].filter(Boolean).join('\n');
      /**
       * 文本一律用 `PDFHexString.fromText()`（UTF-16BE + BOM）。
       * 教训：`PDFString.of()` 对中文只是按字节写下去，别的阅读器读回来是乱码（单测实测
       * 读回 `'\f\t-\u0000åÝ...'`）。PDF 规范里非 ASCII 就该用十六进制串。
       */
      const dict = doc.context.obj({
        Type: 'Annot',
        Subtype: SUBTYPE[annot.kind],
        Rect: [x, y, x + w, y + h],
        QuadPoints: quadPoints(box),
        C: [r, g, b],
        CA: annot.kind === 'highlight' ? 0.35 : 1,
        F: 4, // Print
        T: PDFHexString.fromText(annot.author ?? 'LitShelf'),
        Contents: PDFHexString.fromText(contents.slice(0, 2000)),
        NM: PDFHexString.fromText(`litshelf-${annot.page}-${Math.round(x)}-${Math.round(y)}`),
      });
      const ref = doc.context.register(dict);
      addAnnot(page, ref);
      written += 1;
    }
  }

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, written, skipped };
}

/** pdf-lib 的 PDFPageLeaf 有 addAnnot，但类型声明里没有；这里做一次带兜底的调用 */
function addAnnot(page: PDFPage, ref: ReturnType<PDFDocument['context']['register']>): void {
  const leaf = page.node as unknown as { addAnnot?: (r: unknown) => void; set?: (k: PDFName, v: unknown) => void; Annots?: () => unknown };
  if (typeof leaf.addAnnot === 'function') {
    leaf.addAnnot(ref);
    return;
  }
  // 兜底：手动往 /Annots 数组里塞
  const existing = (leaf.Annots?.() as { push?: (v: unknown) => void } | undefined) ?? undefined;
  if (existing && typeof existing.push === 'function') {
    existing.push(ref);
    return;
  }
  leaf.set?.(PDFName.of('Annots'), page.doc.context.obj([ref]));
}

/** 便于单测与调用方：把 0–1 颜色转成 pdf-lib 的 rgb（顺手校验范围） */
export function safeColor(color?: [number, number, number]) {
  const [r, g, b] = color ?? DEFAULT_COLOR;
  const clamp = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  return rgb(clamp(r), clamp(g), clamp(b));
}

/** 供上层命名"副本文件"用：解析出用于计数的页码集合（去重、升序） */
export function touchedPages(annots: PdfAnnotInput[]): number[] {
  return [...new Set(annots.filter((a) => a.rects?.length).map((a) => a.page))].sort((a, b) => a - b);
}

// 保留一个"看起来没用"的引用：PDFNumber 在部分 pdf-lib 版本里用于强制整数写法，
// 这里显式引用一次，避免打包器把它 tree-shake 掉导致类型断言失效。
void PDFNumber;

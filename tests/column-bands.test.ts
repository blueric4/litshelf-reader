import { describe, expect, it } from 'vitest';
import {
  bandIndexOf,
  bandItemsFromItems,
  columnBandsFromItems,
  isCrossBand,
  nearestBandIndexOf,
  type PdfTextItemLike,
} from '../src/renderer/reader/columnBands';

/**
 * 栏带：把一页正文按"栏"切成 x 区间，供划词**硬性禁止跨栏**（用户明确不接受跨栏选择）。
 *
 * 这里造的都是**页面坐标（y 向下）**，再由 helper 换算成 pdf.js 的文本项
 * （`transform[5]` 是基线 y，PDF 用户空间 y 向上；`width/height` 的语义见模块头注释）。
 */
const PAGE_H = 800;
const PAGE_W = 600;
const opts = { pageHeight: PAGE_H, pageWidth: PAGE_W };

/** 横排文本项：top 是盒子顶边（页面坐标） */
const line = (str: string, x: number, top: number, w: number, h = 10, pageHeight = PAGE_H): PdfTextItemLike => ({
  str,
  transform: [h, 0, 0, h, x, pageHeight - top - h],
  width: w,
  height: h,
  fontName: 'g1',
});

/** 竖排文本项：pdf.js 对竖排字体给 width = 字号（厚度）、height = 这一行的长度 */
const vertical = (str: string, x: number, top: number, length: number, thickness = 9, pageHeight = PAGE_H): PdfTextItemLike => ({
  str,
  transform: [thickness, 0, 0, thickness, x, pageHeight - top - thickness],
  width: thickness,
  height: length,
  fontName: 'g1',
});

/** 三栏正文：三栏各 150px 宽、栏缝 35px；每行拆成两段（真实页面里一行常被切成多个文本项） */
const COLS: readonly (readonly [number, number])[] = [
  [40, 190],
  [225, 375],
  [410, 560],
];
const threeColumns = (): PdfTextItemLike[] => {
  const items: PdfTextItemLike[] = [];
  for (let row = 0; row < 8; row += 1) {
    const top = 120 + row * 20;
    for (const [x0, x1] of COLS) {
      const mid = (x0 + x1) / 2;
      items.push(line('左半行正文内容', x0, top, mid - x0));
      items.push(line('右半行正文内容', mid, top, x1 - mid));
    }
  }
  return items;
};

describe('bandItemsFromItems（文本项 → 页面坐标文本盒）', () => {
  it('y 按页高翻转成"向下"，并按 scale 缩放', () => {
    const boxes = bandItemsFromItems([line('正文一行', 40, 120, 200)], { pageHeight: PAGE_H });
    expect(boxes).toEqual([{ x: 40, y: 120, w: 200, h: 10 }]);
    // pageHeight/pageWidth 用未缩放的 PDF 单位，scale 只影响输出
    const scaled = bandItemsFromItems([line('正文一行', 40, 120, 200)], { pageHeight: PAGE_H, scale: 2 });
    expect(scaled).toEqual([{ x: 80, y: 240, w: 400, h: 20 }]);
  });

  it('竖排项（宽极小、高极大）被丢掉，横排项留下', () => {
    const boxes = bandItemsFromItems([line('横排正文', 40, 120, 200), vertical('竖排页眉', 20, 100, 150)], {
      pageHeight: PAGE_H,
    });
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ x: 40, y: 120, w: 200, h: 10 });
  });

  it('给了 styles 时按"字体是否竖排"判定（短竖排项也能认出来）', () => {
    const item: PdfTextItemLike = { str: '竖', transform: [9, 0, 0, 9, 20, 700], width: 9, height: 9, fontName: 'v1' };
    expect(bandItemsFromItems([item], { pageHeight: PAGE_H, styles: { v1: { vertical: true } } })).toEqual([]);
    expect(bandItemsFromItems([item], { pageHeight: PAGE_H, styles: { v1: { vertical: false } } })).toHaveLength(1);
  });

  it('整行被旋转 90°（横排字体 + 旋转矩阵）也按"页面上的盒子"算，并被当成竖排丢掉', () => {
    const rotated: PdfTextItemLike = { str: '侧边标题', transform: [0, 10, -10, 0, 30, 700], width: 200, height: 10, fontName: 'g1' };
    expect(bandItemsFromItems([rotated], { pageHeight: PAGE_H })).toEqual([]);
  });

  it('空串项、无 transform 的项、空输入都被跳过', () => {
    expect(bandItemsFromItems([{ str: '   ' }, { str: 'x' }, { str: 'y', transform: null }], { pageHeight: PAGE_H })).toEqual([]);
    expect(bandItemsFromItems([], { pageHeight: PAGE_H })).toEqual([]);
    expect(bandItemsFromItems(null, { pageHeight: PAGE_H })).toEqual([]);
  });
});

describe('columnBandsFromItems（三栏 / 单栏 / 栏缝）', () => {
  it('三栏页面切出三栏，栏内能定位、栏缝返回 -1', () => {
    const bands = columnBandsFromItems(threeColumns(), opts);
    expect(bands).toHaveLength(3);
    expect(bandIndexOf(bands, 100)).toBe(0);
    expect(bandIndexOf(bands, 300)).toBe(1);
    expect(bandIndexOf(bands, 500)).toBe(2);
    expect(bandIndexOf(bands, 207)).toBe(-1); // 第一道栏缝 190~225
    expect(bandIndexOf(bands, 390)).toBe(-1); // 第二道栏缝 375~410
  });

  it('左侧竖排干扰项被忽略，三栏照样切出来（它本来会把第一道栏缝桥接掉）', () => {
    const bridging = vertical('网络首发时间2026', 170, 90, 300, 60); // 宽 60、高 300 → 横跨 170~230
    const bands = columnBandsFromItems([...threeColumns(), bridging], opts);
    expect(bands).toHaveLength(3);
    expect(bandIndexOf(bands, 207)).toBe(-1);
    // 对照：把竖排过滤关掉（把阈值放大）→ 投影被桥接，栏就少了
    const without = columnBandsFromItems([...threeColumns(), bridging], { ...opts, verticalAspect: 100 });
    expect(without.length).toBeLessThan(3);
  });

  it('顶部通栏标题不会把栏缝填掉（靠覆盖率，而不是按宽度硬筛）', () => {
    const title = line('一个横跨整页的大标题', 40, 60, 520, 14); // 横跨两道栏缝
    expect(columnBandsFromItems([...threeColumns(), title], opts)).toHaveLength(3);
  });

  it('通道在多数行带上被压过就不算栏缝（通栏正文块挡的地方不是栏缝）', () => {
    // 8 行里有 6 行是通栏长行（占 75% 的行带 > 允许的 50%）→ 中间那道缝不算栏缝，整页按单栏处理
    const items = threeColumns();
    for (const row of [0, 1, 3, 4, 6, 7]) items.push(line('横跨全页的整行文字', 40, 120 + row * 20, 520, 10));
    expect(columnBandsFromItems(items, opts)).toHaveLength(1);
  });

  it('单栏页面只返回一个区间（调用方据此跳过跨栏处理）', () => {
    const single: PdfTextItemLike[] = [];
    for (let row = 0; row < 8; row += 1) single.push(line('单栏正文一行', 40, 120 + row * 20, 500));
    expect(columnBandsFromItems(single, opts)).toEqual([{ start: 40, end: 540 }]);
  });

  it('单栏里小于阈值（页宽 0.8% = 4.8px）的系统小缝不算栏缝', () => {
    const items: PdfTextItemLike[] = [];
    for (let row = 0; row < 8; row += 1) {
      const top = 120 + row * 20;
      items.push(line('前半行文字', 40, top, 250));
      items.push(line('后半行文字', 293, top, 247)); // 290~293 的 3px 空隙（真实行内字距空隙就在这个量级）
    }
    expect(columnBandsFromItems(items, opts)).toHaveLength(1);
  });

  it('只有一侧成片正文时不切栏（页边注/行号不能当栏）', () => {
    const items: PdfTextItemLike[] = [line('页边注', 40, 120, 100)]; // 左侧只有一行
    for (let row = 0; row < 8; row += 1) items.push(line('正文一行', 200, 120 + row * 20, 350));
    expect(columnBandsFromItems(items, opts)).toHaveLength(1);
  });

  it('空输入返回空数组', () => {
    expect(columnBandsFromItems([], opts)).toEqual([]);
    expect(columnBandsFromItems(null, opts)).toEqual([]);
    expect(bandIndexOf([], 100)).toBe(-1);
  });

  it('全是竖排项的页面（竖排封面）切不出栏，交给调用方跳过夹取', () => {
    const items = [vertical('竖排标题', 100, 100, 300, 12), vertical('竖排正文', 140, 100, 260, 12)];
    expect(columnBandsFromItems(items, opts)).toEqual([]);
  });
});

describe('真实 CNKI 版式复刻（两栏 + 通栏标题 + 左侧竖排页眉）', () => {  // 尺寸与实测一致：页宽 540，两栏各 233px，栏缝 259~278（19px ≈ 页宽 3.5%）
  const pageW = 540;
  const pageH = 763;
  const build = (): PdfTextItemLike[] => {
    const items: PdfTextItemLike[] = [
      vertical('网络首发时间', 16, 60, 200), // 左侧竖排页眉
      line('样本文献 C 的通栏标题', 26, 40, 488, 14, pageH), // 通栏标题
    ];
    for (let row = 0; row < 12; row += 1) {
      const top = 120 + row * 16;
      items.push(line('左栏正文内容一行', 26, top, 233, 9.5, pageH));
      items.push(line('右栏正文内容一行', 278, top, 233, 9.5, pageH));
    }
    return items;
  };

  it('切出两栏，栏缝落在 259~278 一带', () => {
    const bands = columnBandsFromItems(build(), { pageHeight: pageH, pageWidth: pageW });
    expect(bands).toHaveLength(2);
    expect(bandIndexOf(bands, 100)).toBe(0);
    expect(bandIndexOf(bands, 400)).toBe(1);
    expect(bandIndexOf(bands, 268)).toBe(-1); // 栏缝
  });

  it('顶部通栏标题 + 宽引文压住栏缝时仍要切出两栏（样本文献 A p4 的真实形状）', () => {
    // 实测：标题 x 260~374、4 行宽引文 x 217~353 压在 x≈302 的栏缝上（51 个行带里只占 5 个），
    // 正文左栏 x 75~299、右栏 x 305~523 —— 栏缝只有 6px（页宽 595 的 1.0%）。
    const w = 595;
    const h = 842;
    const items: PdfTextItemLike[] = [
      line('样本文献 A 的标题行', 260, 40, 114, 14, h),
      ...[123, 164, 205, 217].map((t) => line('样本文献 A 的宽引文行', 217, t, 136, 10, h)),
    ];
    for (let row = 0; row < 26; row += 1) {
      const top = 260 + row * 20;
      items.push(line('左栏正文一行文字内容', 75, top, 224, 10, h));
      items.push(line('右栏正文一行文字内容', 305, top, 218, 10, h));
    }
    const bands = columnBandsFromItems(items, { pageHeight: h, pageWidth: w });
    expect(bands).toHaveLength(2);
    expect(bandIndexOf(bands, 200)).toBe(0);
    expect(bandIndexOf(bands, 400)).toBe(1);
    expect(bandIndexOf(bands, 302)).toBe(-1); // 6px 的栏缝：被顶部标题压过，但多数行带上是空的
  });
});

describe('bandIndexOf / isCrossBand / nearestBandIndexOf', () => {
  const bands = columnBandsFromItems(threeColumns(), opts);

  it('跨栏判定：同一栏内不算跨栏，分属两栏才算', () => {
    expect(isCrossBand(bands, 100, 150)).toBe(false);
    expect(isCrossBand(bands, 100, 300)).toBe(true);
    expect(isCrossBand(bands, 450, 500)).toBe(false);
    // 一端落在栏缝里 → 判不了，返回 false（调用方按锚点那一栏处理）
    expect(isCrossBand(bands, 100, 207)).toBe(false);
  });

  it('落在栏缝时给最近的栏（把端点夹回去要用）', () => {
    expect(nearestBandIndexOf(bands, 100)).toBe(0);
    expect(nearestBandIndexOf(bands, 195)).toBe(0); // 缝里偏左
    expect(nearestBandIndexOf(bands, 220)).toBe(1); // 缝里偏右
    expect(nearestBandIndexOf(bands, 5000)).toBe(2);
    expect(nearestBandIndexOf([], 10)).toBe(-1);
  });
});

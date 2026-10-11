import { describe, expect, it } from 'vitest';
import {
  columnIndexAt,
  columnsOf,
  findGutters,
  orderTextSpans,
  xWindowOf,
  type TextBox,
} from '../src/renderer/reader/textOrder';

/**
 * 文本层重排：让 DOM 顺序 = 视觉阅读顺序。
 * 背景：浏览器按 DOM 顺序扩展选区，pdf.js 按内容流顺序追加 span，
 * 两者不一致时拖选会"吃掉中间一大段"（用户报的核心问题）。
 */
const box = (left: number, top: number, width = 100, height = 14): TextBox => ({ left, top, width, height });

describe('orderTextSpans', () => {
  it('单栏：从上到下、行内从左到右', () => {
    const boxes = [
      box(200, 100), // 0 第一行右半
      box(40, 100), // 1 第一行左半
      box(40, 130), // 2 第二行
      box(40, 160), // 3 第三行
      box(40, 190), // 4 第四行（让"只在第一行出现的空隙"不构成栏缝）
    ];
    expect(orderTextSpans(boxes)).toEqual([1, 0, 2, 3, 4]);
  });

  it('双栏：先整栏读完再读下一栏（不是按行横跨）', () => {
    const boxes = [
      box(40, 100), // 0 左栏第 1 行
      box(600, 100), // 1 右栏第 1 行
      box(40, 130), // 2 左栏第 2 行
      box(600, 130), // 3 右栏第 2 行
      box(40, 160), // 4 左栏第 3 行
      box(600, 160), // 5 右栏第 3 行
    ];
    expect(findGutters(boxes).length).toBeGreaterThan(0);
    expect(orderTextSpans(boxes)).toEqual([0, 2, 4, 1, 3, 5]);
  });

  it('双栏 + 通栏标题：标题在最前，然后左栏、右栏', () => {
    const boxes = [
      box(600, 100), // 0 右栏第 1 行
      box(40, 100), // 1 左栏第 1 行
      box(40, 60, 660), // 2 通栏标题（横跨栏缝）
      box(600, 130), // 3 右栏第 2 行
      box(40, 130), // 4 左栏第 2 行
    ];
    expect(orderTextSpans(boxes)).toEqual([2, 1, 4, 0, 3]);
  });

  it('三栏（中文期刊常见）：栏序从左到右', () => {
    const boxes = [
      box(700, 100), // 0 第三栏
      box(40, 100), // 1 第一栏
      box(380, 100), // 2 第二栏
      box(700, 130), // 3
      box(40, 130), // 4
      box(380, 130), // 5
    ];
    expect(orderTextSpans(boxes)).toEqual([1, 4, 2, 5, 0, 3]);
  });

  it('已经是阅读顺序时原样返回（避免无谓 DOM 重排）', () => {
    const boxes = [box(40, 100), box(40, 130), box(40, 160)];
    expect(orderTextSpans(boxes)).toEqual([0, 1, 2]);
  });

  it('窄缝不算分栏（不能把行内空隙当栏缝）', () => {
    const boxes = [box(40, 100, 300), box(343, 100, 300), box(40, 130, 300), box(343, 130, 300)];
    expect(findGutters(boxes, 8)).toEqual([]);
    expect(orderTextSpans(boxes)).toEqual([0, 1, 2, 3]); // 单栏：按行从上到下、行内从左到右
  });

  it('只在一行上出现的空隙不算栏缝（真实期刊里那个 60px 的坑）', () => {
    const boxes = [box(200, 100), box(40, 100), box(40, 130), box(40, 160)];
    expect(findGutters(boxes)).toEqual([]);
    expect(orderTextSpans(boxes)).toEqual([1, 0, 2, 3]);
  });

  it('空输入与单元素不出错', () => {
    expect(orderTextSpans([])).toEqual([]);
    expect(orderTextSpans([box(10, 10)])).toEqual([0]);
  });

  it('竖向重叠但行高不同（期刊里 span 盒子高度常不一致）也能稳定排序', () => {
    const boxes = [box(40, 100, 300, 18), box(40, 101, 300, 12), box(40, 200, 300, 15), box(40, 201, 300, 20)];
    const order = orderTextSpans(boxes);
    expect(order.slice(0, 2).sort()).toEqual([0, 1]);
    expect(order.slice(2).sort()).toEqual([2, 3]);
  });
});

describe('columnsOf / columnIndexAt（划词"不许跨栏"用的栏模型）', () => {
  it('三栏页面切出三个区间，且能定位到具体哪一栏', () => {
    const boxes = [
      box(40, 100, 300), // 第一栏
      box(380, 100, 300), // 第二栏
      box(720, 100, 300), // 第三栏
      box(40, 130, 300),
      box(380, 130, 300),
      box(720, 130, 300),
      box(40, 160, 300),
      box(380, 160, 300),
      box(720, 160, 300),
    ];
    const cols = columnsOf(boxes);
    expect(cols).toHaveLength(3);
    expect(columnIndexAt(cols, 100)).toBe(0);
    expect(columnIndexAt(cols, 500)).toBe(1);
    expect(columnIndexAt(cols, 800)).toBe(2);
    // 落在这两栏之间的栏缝上 → -1（调用方据此把它归到锚点那一栏）
    expect(columnIndexAt(cols, 350)).toBe(-1);
  });

  it('单栏页面只返回一个区间（调用方跳过跨栏处理）', () => {
    const boxes = [box(40, 100, 500), box(40, 130, 500), box(40, 160, 480)];
    expect(columnsOf(boxes)).toHaveLength(1);
  });

  it('空输入返回空数组', () => {
    expect(columnsOf([])).toEqual([]);
  });
});

describe('xWindowOf（划词夹取的"文字块窗口"）', () => {
  const threeCol = [
    // 三栏，栏内每行都从 40 起、宽 300；栏缝 340~400、700~760
    ...[100, 130, 160].map((t) => box(40, t, 300)),
    ...[100, 130, 160].map((t) => box(400, t, 300)),
    ...[100, 130, 160].map((t) => box(760, t, 300)),
  ];

  it('三栏页面：栏内的 x 得到本栏窗口，跨栏缝返回 null', () => {
    expect(xWindowOf(threeCol, 100)).toEqual({ start: 40, end: 340 });
    expect(xWindowOf(threeCol, 500)).toEqual({ start: 400, end: 700 });
    expect(xWindowOf(threeCol, 800)).toEqual({ start: 760, end: 1060 });
    expect(xWindowOf(threeCol, 370)).toBeNull(); // 落在栏缝里
  });

  it('同一栏内的小于 minGap 的空隙会被跨过（不会把一行切成两块）', () => {
    const boxes = [box(40, 100, 100), box(148, 100, 100), box(256, 100, 100), box(40, 130, 300)];
    expect(xWindowOf(boxes, 100)).toEqual({ start: 40, end: 356 });
  });

  it('空输入返回 null', () => {
    expect(xWindowOf([], 100)).toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  loadPageLinks,
  normalizeLinkRects,
  resolveInternalPage,
  type LinkDestResolver,
  type LinkDocument,
  type LinkPage,
  type LinkViewport,
} from '../src/renderer/reader/links';

/**
 * 链接解析：把 pdf.js 的链接注释变成"页内归一化矩形 + 跳转目标"。
 * 重点验证两件最容易错的事：
 *   ① y 轴方向 —— PDF 用户空间 y 向上，渲染层 y 向下，靠 viewport 转换，不自算；
 *   ② 页码基 —— pdf.js `getPageIndex` 是 0 基，对外一律 1 基（差一个就是"点第 3 页跳到第 4 页"）。
 * 另外所有坏注释/坏 dest 都必须被吞掉，不能抛。
 */

/**
 * 仿 pdf.js 的 `PageViewport`（rotation 0）：
 * transform = [scale, 0, 0, -scale, 0, viewBoxHeight*scale]，
 * `convertToViewportRectangle` = 两个角点变换后取 min/max（与 pdf.js display_utils 同逻辑）。
 * 测试里用它而不是真 PageViewport，是为了不在 node 环境拉进 pdf.js 的 DOM 依赖，
 * 同时把"y 翻转 + min/max 归位"这段真实行为保留下来（不翻转的话下面的断言会立刻红）。
 */
function viewport(width: number, height: number, scale = 1): LinkViewport {
  const point = (x: number, y: number): [number, number] => [x * scale, (height - y) * scale];
  return {
    width: width * scale,
    height: height * scale,
    convertToViewportRectangle: (rect: number[]) => {
      const a = point(rect[0], rect[1]);
      const b = point(rect[2], rect[3]);
      return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    },
  };
}

/** 600x800 的页面，坐标含义一眼能算：x/600、y 从页底往上量 */
const PAGE = { width: 600, height: 800 };

/** 只实现解析 dest 需要的两个方法（resolveInternalPage 的最小依赖） */
function resolver(opts: {
  index?: number | ((ref: { num: number; gen: number }) => number | Promise<number>);
  named?: Record<string, unknown[] | null>;
  numPages?: number;
} = {}): LinkDestResolver & { getPageIndex: ReturnType<typeof vi.fn>; getDestination: ReturnType<typeof vi.fn> } {
  const getPageIndex = vi.fn(async (ref: { num: number; gen: number }) =>
    typeof opts.index === 'function' ? opts.index(ref) : (opts.index ?? 0),
  );
  const getDestination = vi.fn(async (name: string) => opts.named?.[name] ?? null);
  return { getPageIndex, getDestination, numPages: opts.numPages };
}

/** 一页链接注释 + 页面代理；`cleanup` 用来断言我们不碰它（页面正被渲染层共用） */
function pageOf(annotations: unknown[] | (() => unknown[])): { page: LinkPage; cleanup: ReturnType<typeof vi.fn> } {
  const cleanup = vi.fn();
  const getAnnotations = vi.fn(async () =>
    typeof annotations === 'function' ? annotations() : annotations,
  );
  return { page: { getAnnotations } as LinkPage, cleanup };
}

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);
/** 归一化是除法得到的浮点数（0.025 常常落成 0.024999…），逐字段按容差比，不做二进制相等 */
const expectRect = (actual: { x: number; y: number; w: number; h: number } | undefined, expected: ReturnType<typeof rect>) => {
  expect(actual).toBeDefined();
  near(actual!.x, expected.x);
  near(actual!.y, expected.y);
  near(actual!.w, expected.w);
  near(actual!.h, expected.h);
};

describe('normalizeLinkRects', () => {
  it('外链：url 透传，矩形归一化到 0–1', () => {
    // PDF 用户空间：[100,700]-[200,720]（靠近页顶），页 600x800
    const link = normalizeLinkRects({ subtype: 'Link', rect: [100, 700, 200, 720], url: 'https://a.test/p.pdf' }, viewport(600, 800));
    expect(link.url).toBe('https://a.test/p.pdf');
    expect(link.dest).toBeUndefined();
    expect(link.rects).toHaveLength(1);
    near(link.rects[0].x, 100 / 600);
    near(link.rects[0].y, 80 / 800); // 屏幕 y = 800 - 720 = 80 → y 向下
    near(link.rects[0].w, 100 / 600);
    near(link.rects[0].h, 20 / 800);
  });

  it('y 轴方向与渲染层一致：靠页顶的链接 y 小，靠页底的 y 大', () => {
    const top = normalizeLinkRects({ subtype: 'Link', rect: [100, 700, 200, 720], url: 'u' }, viewport(600, 800));
    const bottom = normalizeLinkRects({ subtype: 'Link', rect: [100, 40, 200, 60], url: 'u' }, viewport(600, 800));
    expect(top.rects[0].y).toBeLessThan(0.2); // 页顶：接近 0
    expect(bottom.rects[0].y).toBeGreaterThan(0.9); // 页底：接近 1
    for (const r of [...top.rects, ...bottom.rects]) {
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.y + r.h).toBeLessThanOrEqual(1);
    }
  });

  it('缩放不影响归一化结果（viewport 是 2 倍时结果一致）', () => {
    const a = normalizeLinkRects({ subtype: 'Link', rect: [100, 700, 200, 720], url: 'u' }, viewport(600, 800, 1));
    const b = normalizeLinkRects({ subtype: 'Link', rect: [100, 700, 200, 720], url: 'u' }, viewport(600, 800, 2));
    expect(b.rects[0]).toEqual(a.rects[0]);
  });

  it('坐标只信 viewport 的转换结果（旋转页不自算）', () => {
    // 模拟 90° 旋转后的 viewport：转换结果把 x/y 换了个方向，归一化必须跟着它走
    const rotated: LinkViewport = {
      width: 800,
      height: 600,
      convertToViewportRectangle: (r: number[]) => [r[1], r[0], r[3], r[2]],
    };
    const link = normalizeLinkRects({ subtype: 'Link', rect: [100, 700, 200, 720], url: 'u' }, rotated);
    near(link.rects[0].x, 700 / 800);
    near(link.rects[0].y, 100 / 600);
    near(link.rects[0].w, 20 / 800);
    near(link.rects[0].h, 100 / 600);
  });

  it('内部跳转：dest 原样透传，没有 url', () => {
    const dest = [{ num: 12, gen: 0 }, { name: 'XYZ' }, 72, 640, null];
    const link = normalizeLinkRects({ subtype: 'Link', rect: [10, 10, 60, 30], dest }, viewport(600, 800));
    expect(link.dest).toBe(dest);
    expect(link.url).toBeUndefined();
    expect(link.rects).toHaveLength(1);
  });

  it('rect 缺失时退回 QuadPoints 的包围盒（多个四边形 → 多个热区）', () => {
    // 两个四边形，每个 8 个数（4 个角点 x,y）
    const quadPoints = [
      100, 700, 200, 700, 200, 720, 100, 720,
      300, 700, 400, 700, 400, 720, 300, 720,
    ];
    const link = normalizeLinkRects({ subtype: 'Link', quadPoints, url: 'u' }, viewport(600, 800));
    expect(link.rects).toHaveLength(2);
    near(link.rects[0].x, 100 / 600);
    near(link.rects[1].x, 300 / 600);
    near(link.rects[1].w, 100 / 600);
    near(link.rects[1].y, 80 / 800);
  });

  it('rect 与 QuadPoints 同时存在时以 rect 为准（不重复出热区）', () => {
    const link = normalizeLinkRects(
      { subtype: 'Link', rect: [100, 700, 200, 720], quadPoints: [0, 0, 600, 0, 600, 800, 0, 800], url: 'u' },
      viewport(600, 800),
    );
    expect(link.rects).toHaveLength(1);
    expectRect(link.rects[0], rect(100 / 600, 80 / 800, 100 / 600, 20 / 800));
  });

  it('部分超出页面的矩形裁到 0–1，完全在页外的丢弃', () => {
    const vp = viewport(600, 800);
    const outside = normalizeLinkRects({ subtype: 'Link', rect: [-500, -500, -400, -400], url: 'u' }, vp);
    expect(outside.rects).toEqual([]);

    const partial = normalizeLinkRects({ subtype: 'Link', rect: [-50, -50, 200, 100], url: 'u' }, vp);
    expect(partial.rects).toHaveLength(1);
    expectRect(partial.rects[0], rect(0, 700 / 800, 200 / 600, 100 / 800));
  });

  it('退化矩形（零面积）不生成热区', () => {
    const vp = viewport(600, 800);
    expect(normalizeLinkRects({ subtype: 'Link', rect: [100, 700, 100, 720], url: 'u' }, vp).rects).toEqual([]);
    expect(normalizeLinkRects({ subtype: 'Link', rect: [100, 700, 200, 700], url: 'u' }, vp).rects).toEqual([]);
  });

  it('矩形里的 null / 字符串数字不猜成 0（否则会画出假热区）', () => {
    const vp = viewport(600, 800);
    expect(normalizeLinkRects({ subtype: 'Link', rect: [null, 700, 200, 720], url: 'u' }, vp).rects).toEqual([]);
    expect(normalizeLinkRects({ subtype: 'Link', rect: ['100', '700', '200', '720'], url: 'u' }, vp).rects).toEqual([]);
  });

  it('不取未消毒的 unsafeUrl（javascript: 之类不能变成热区目标）', () => {
    const link = normalizeLinkRects(
      { subtype: 'Link', rect: [10, 10, 60, 30], unsafeUrl: 'javascript:alert(1)' },
      viewport(600, 800),
    );
    expect(link.url).toBeUndefined();
    expect(link.rects).toHaveLength(1);
  });

  it('反序矩形（x1>x2 / y1>y2）也能转正', () => {
    const link = normalizeLinkRects({ subtype: 'Link', rect: [200, 720, 100, 700], url: 'u' }, viewport(600, 800));
    near(link.rects[0].x, 100 / 600);
    near(link.rects[0].y, 80 / 800);
    near(link.rects[0].w, 100 / 600);
    near(link.rects[0].h, 20 / 800);
  });

  it('坏输入一律不抛：坏注释、坏 viewport、NaN 矩形', () => {
    const vp = viewport(600, 800);
    const bad: unknown[] = [
      null,
      undefined,
      {},
      { subtype: 'Link' },
      { subtype: 'Link', rect: 'not-an-array' },
      { subtype: 'Link', rect: [1, 2] },
      { subtype: 'Link', rect: [1, 2, 3, 4, 5, 6] }, // 长度多也算前 4 个（合法）
      { subtype: 'Link', rect: [NaN, 0, 10, 10] },
      { subtype: 'Link', rect: [0, 0, Infinity, 10] },
      { subtype: 'Link', rect: ['a', 'b', 'c', 'd'] },
      { subtype: 'Link', rect: [0, 0, 10, 10], url: 42, dest: null },
    ];
    for (const annot of bad) {
      expect(() => normalizeLinkRects(annot as never, vp)).not.toThrow();
    }
    // 合法但坏值的字段被忽略，不进入结果
    const weird = normalizeLinkRects({ subtype: 'Link', rect: [0, 0, 10, 10], url: 42, dest: null }, vp);
    expect(weird.url).toBeUndefined();
    expect(weird.dest).toBeUndefined();
  });

  it('viewport 缺失/宽高为 0/转换抛错时返回空 rects，不抛', () => {
    const annot = { subtype: 'Link', rect: [0, 0, 10, 10], url: 'u' };
    expect(normalizeLinkRects(annot, null).rects).toEqual([]);
    expect(normalizeLinkRects(annot, undefined).rects).toEqual([]);
    expect(normalizeLinkRects(annot, { width: 0, height: 0, convertToViewportRectangle: () => [0, 0, 1, 1] }).rects).toEqual([]);
    expect(normalizeLinkRects(annot, { width: NaN, height: 800, convertToViewportRectangle: () => [0, 0, 1, 1] }).rects).toEqual([]);
    const boom: LinkViewport = {
      width: 600,
      height: 800,
      convertToViewportRectangle: () => {
        throw new Error('boom');
      },
    };
    expect(normalizeLinkRects(annot, boom).rects).toEqual([]);
  });

  it('没有可用矩形时 url 仍透传（是否使用由调用方决定）', () => {
    const link = normalizeLinkRects({ subtype: 'Link', rect: [0, 0, 0, 0], url: 'https://a.test' }, viewport(600, 800));
    expect(link.url).toBe('https://a.test');
    expect(link.rects).toEqual([]);
  });
});

describe('resolveInternalPage', () => {
  it('数组 dest + 对象引用：getPageIndex 是 0 基，返回 1 基页码', async () => {
    const doc = resolver({ index: 4 });
    const target = await resolveInternalPage(doc, [{ num: 12, gen: 0 }, { name: 'Fit' }]);
    expect(target).toEqual({ page: 5 });
    expect(doc.getPageIndex).toHaveBeenCalledWith({ num: 12, gen: 0 });
  });

  it('index 0 → 第 1 页（防差一位）', async () => {
    expect(await resolveInternalPage(resolver({ index: 0 }), [{ num: 3, gen: 0 }, { name: 'Fit' }])).toEqual({ page: 1 });
  });

  it('gen 缺失时补 0', async () => {
    const doc = resolver({ index: 2 });
    await resolveInternalPage(doc, [{ num: 7 }, { name: 'Fit' }]);
    expect(doc.getPageIndex).toHaveBeenCalledWith({ num: 7, gen: 0 });
  });

  it('数字引用按 0 基页码宽松处理', async () => {
    const doc = resolver();
    expect(await resolveInternalPage(doc, [2, { name: 'Fit' }])).toEqual({ page: 3 });
    expect(doc.getPageIndex).not.toHaveBeenCalled();
  });

  it('命名 dest（字符串）走 getDestination', async () => {
    const doc = resolver({ index: 9, named: { 'chapter-2': [{ num: 33, gen: 0 }, { name: 'Fit' }] } });
    expect(await resolveInternalPage(doc, 'chapter-2')).toEqual({ page: 10 });
    expect(doc.getDestination).toHaveBeenCalledWith('chapter-2');
  });

  it('命名 dest 也接受 {name} 包装', async () => {
    const doc = resolver({ index: 1, named: { toc: [{ num: 5, gen: 0 }, { name: 'Fit' }] } });
    expect(await resolveInternalPage(doc, { name: 'toc' })).toEqual({ page: 2 });
  });

  it('dest 数组首位又是命名目标时再解一层（自引用不会死循环）', async () => {
    const doc = resolver({ index: 3, named: { alias: [{ num: 20, gen: 0 }, { name: 'Fit' }] } });
    expect(await resolveInternalPage(doc, ['alias', { name: 'Fit' }])).toEqual({ page: 4 });

    const loop = resolver({ named: { a: ['a', { name: 'Fit' }] } });
    await expect(resolveInternalPage(loop, 'a')).resolves.toBeNull();
  });

  it('各跳转模式带上 PDF 用户空间坐标', async () => {
    const doc = resolver({ index: 5 });
    const ref = { num: 1, gen: 0 };
    expect(await resolveInternalPage(doc, [ref, { name: 'XYZ' }, 72, 640, 1.5])).toEqual({ page: 6, x: 72, y: 640 });
    expect(await resolveInternalPage(doc, [ref, { name: 'FitH' }, 500])).toEqual({ page: 6, y: 500 });
    expect(await resolveInternalPage(doc, [ref, { name: 'FitV' }, 40])).toEqual({ page: 6, x: 40 });
    expect(await resolveInternalPage(doc, [ref, { name: 'FitR' }, 10, 20, 300, 400])).toEqual({ page: 6, x: 10, y: 400 });
    expect(await resolveInternalPage(doc, [ref, 'Fit'])).toEqual({ page: 6 });
    expect(await resolveInternalPage(doc, [ref, { name: 'XYZ' }, null, null, null])).toEqual({ page: 6 });
  });

  it('越界页码返回 null（有 numPages 时兜底）', async () => {
    expect(await resolveInternalPage(resolver({ index: 20, numPages: 10 }), [{ num: 1, gen: 0 }, { name: 'Fit' }])).toBeNull();
    expect(await resolveInternalPage(resolver({ index: 9, numPages: 10 }), [{ num: 1, gen: 0 }, { name: 'Fit' }])).toEqual({ page: 10 });
  });

  it('坏 dest / 坏 doc 一律 null，不抛', async () => {
    const doc = resolver({ named: { broken: null } });
    const cases: unknown[] = [
      undefined,
      null,
      {},
      [],
      'nope',
      [{ gen: 0 }, { name: 'Fit' }], // ref 缺 num
      [{ num: 'x', gen: 0 }, { name: 'Fit' }],
      [null, { name: 'Fit' }],
      { num: 1, gen: 0 },
    ];
    for (const dest of cases) {
      await expect(resolveInternalPage(doc, dest)).resolves.toBeNull();
    }
    await expect(resolveInternalPage(null, [{ num: 1, gen: 0 }])).resolves.toBeNull();
    await expect(resolveInternalPage(undefined, 'x')).resolves.toBeNull();
  });

  it('getPageIndex / getDestination 抛错、返回负数或非整数时 null', async () => {
    const boom = resolver({
      index: () => {
        throw new Error('bad ref');
      },
    });
    await expect(resolveInternalPage(boom, [{ num: 1, gen: 0 }, { name: 'Fit' }])).resolves.toBeNull();

    const negative = resolver({ index: -1 });
    await expect(resolveInternalPage(negative, [{ num: 1, gen: 0 }, { name: 'Fit' }])).resolves.toBeNull();

    const fractional = resolver({ index: 2.5 });
    await expect(resolveInternalPage(fractional, [{ num: 1, gen: 0 }, { name: 'Fit' }])).resolves.toBeNull();

    const destBoom: LinkDestResolver = {
      getPageIndex: async () => 0,
      getDestination: async () => {
        throw new Error('no name tree');
      },
    };
    await expect(resolveInternalPage(destBoom, 'missing')).resolves.toBeNull();
  });

  it('非整数页码引用一律拒绝（不能出现"第 2.5 页"这种坏目标）', async () => {
    const doc = resolver({ index: 0 });
    await expect(resolveInternalPage(doc, [2.5, { name: 'Fit' }])).resolves.toBeNull();
    await expect(resolveInternalPage(doc, [{ num: 1.5, gen: 0 }, { name: 'Fit' }])).resolves.toBeNull();
    expect(doc.getPageIndex).not.toHaveBeenCalled();
  });
});

describe('loadPageLinks', () => {
  const link = (extra: Record<string, unknown> = {}) => ({
    subtype: 'Link',
    rect: [100, 700, 200, 720],
    ...extra,
  });

  it('只保留 Link 注释，其余类型全部过滤', async () => {
    const { page } = pageOf([
      link({ url: 'https://a.test/1' }),
      { subtype: 'Highlight', rect: [0, 0, 10, 10], url: 'https://ignored.test' },
      { subtype: 'Widget', rect: [0, 0, 10, 10] },
      null,
      'garbage',
      link({ dest: [{ num: 2, gen: 0 }, { name: 'Fit' }] }),
    ]);
    const doc: LinkDocument = { getPage: async () => page, getPageIndex: async () => 0, getDestination: async () => null };
    const links = await loadPageLinks(doc, 3, viewport(600, 800));
    expect(links).toHaveLength(2);
    expect(links[0].url).toBe('https://a.test/1');
    expect(Array.isArray(links[1].dest)).toBe(true);
  });

  it('用 intent: display 取注释（noHTML 会把链接过滤掉）', async () => {
    const { page } = pageOf([link({ url: 'u' })]);
    const getAnnotations = page.getAnnotations as unknown as ReturnType<typeof vi.fn>;
    const doc: LinkDocument = { getPage: async () => page, getPageIndex: async () => 0, getDestination: async () => null };
    await loadPageLinks(doc, 1, viewport(600, 800));
    expect(getAnnotations).toHaveBeenCalledWith({ intent: 'display' });
  });

  it('目录页几十个链接全部返回（且不为每条 dest 做 await 解析）', async () => {
    const many = Array.from({ length: 50 }, (_, i) => link({ dest: [{ num: i, gen: 0 }, { name: 'XYZ' }, 0, 700, null] }));
    const { page } = pageOf(many);
    const getPageIndex = vi.fn(async () => 0);
    const doc: LinkDocument = { getPage: async () => page, getPageIndex, getDestination: async () => null };
    const links = await loadPageLinks(doc, 2, viewport(600, 800));
    expect(links).toHaveLength(50);
    expect(getPageIndex).not.toHaveBeenCalled(); // 点击时才解析
  });

  it('混进来的坏注释不影响其它链接', async () => {
    const { page } = pageOf([
      { subtype: 'Link', rect: 'bad', url: 'u' },
      { subtype: 'Link', rect: [NaN, NaN, NaN, NaN], url: 'u' },
      { subtype: 'Link', rect: [0, 0, 0, 0], url: 'u' }, // 零面积
      { subtype: 'Link', rect: [10, 10, 60, 30] }, // 既没 url 也没 dest
      link({ url: 'https://ok.test' }),
    ]);
    const doc: LinkDocument = { getPage: async () => page, getPageIndex: async () => 0, getDestination: async () => null };
    const links = await loadPageLinks(doc, 1, viewport(600, 800));
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://ok.test');
    expect(links[0].dest).toBeUndefined();
    expectRect(links[0].rects[0], rect(100 / 600, 80 / 800, 100 / 600, 20 / 800));
  });

  it('没有可用 viewport 时返回空数组（画不出热区就不返回）', async () => {
    const { page } = pageOf([link({ url: 'u' })]);
    const doc: LinkDocument = { getPage: async () => page, getPageIndex: async () => 0, getDestination: async () => null };
    expect(await loadPageLinks(doc, 1, null)).toEqual([]);
  });

  it('取页失败 / 注释流抛错 / 参数非法 → 空数组，不抛', async () => {
    const okPage = pageOf([link({ url: 'u' })]).page;
    const throwPage = pageOf(() => {
      throw new Error('broken annotation stream');
    }).page;
    const doc: LinkDocument = { getPage: async () => throwPage, getPageIndex: async () => 0, getDestination: async () => null };
    await expect(loadPageLinks(doc, 1, viewport(600, 800))).resolves.toEqual([]);

    const pageBoom: LinkDocument = {
      getPage: async () => {
        throw new Error('page gone');
      },
      getPageIndex: async () => 0,
      getDestination: async () => null,
    };
    await expect(loadPageLinks(pageBoom, 1, viewport(600, 800))).resolves.toEqual([]);

    // 注释流不是数组
    const weird: LinkDocument = {
      getPage: async () => ({ getAnnotations: async () => null }) as unknown as LinkPage,
      getPageIndex: async () => 0,
      getDestination: async () => null,
    };
    await expect(loadPageLinks(weird, 1, viewport(600, 800))).resolves.toEqual([]);

    const normal: LinkDocument = { getPage: async () => okPage, getPageIndex: async () => 0, getDestination: async () => null };
    expect(await loadPageLinks(null, 1, viewport(600, 800))).toEqual([]);
    expect(await loadPageLinks(normal, 0, viewport(600, 800))).toEqual([]);
    expect(await loadPageLinks(normal, Number.NaN, viewport(600, 800))).toEqual([]);
  });

  it('不调用 page.cleanup（页面正被渲染层共用，cleanup 会释放它的意图状态）', async () => {
    const { page, cleanup } = pageOf([link({ url: 'u' })]);
    const doc: LinkDocument = { getPage: async () => page, getPageIndex: async () => 0, getDestination: async () => null };
    await loadPageLinks(doc, 1, viewport(600, 800));
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('页码按 1 基传给 doc.getPage', async () => {
    const { page } = pageOf([link({ url: 'u' })]);
    const getPage = vi.fn(async () => page);
    const doc: LinkDocument = { getPage, getPageIndex: async () => 0, getDestination: async () => null };
    await loadPageLinks(doc, 7, viewport(600, 800));
    expect(getPage).toHaveBeenCalledWith(7);
  });
});

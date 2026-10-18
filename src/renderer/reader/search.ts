/**
 * 全文索引命中在页面文本层里的高亮：
 * 不注入 HTML，而是对每个文本节点算出归一化后的命中区间，用 Range.getClientRects()
 * 拿到矩形，再叠一层与批注同构的高亮条。这样完全不会破坏 pdf.js 文本层的排版。
 */
import type { PageTextMap } from './reanchor';

export interface HighlightStrip {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  current: boolean;
}

/**
 * 归一化时被忽略（或折叠）的字符：
 * 空白、不换行空格、**零宽字符 / 软连字符**（PDF 抽取常插在字间，会让 "CEO" 变 "C\u200bEO" 搜不到）、
 * 各种引号与连接号。
 */
function isSkippable(ch: string): boolean {
  return /[\s\u00a0\u00ad\u200b-\u200d\u2060\ufeff\u2018\u2019\u201b\u201c\u201d\u2010-\u2015\u2212]/.test(ch);
}

/** 归一化后的一个字符 → 它来自哪个文本节点、节点内的原始下标 */
interface NormChar {
  node: Text;
  raw: number;
}

interface PageNorm {
  /** 整页归一化文本（空白折叠成一个空格、大小写统一） */
  text: string;
  /** 与 text 一一对应的「来源节点 + 节点内偏移」 */
  chars: NormChar[];
}

/**
 * 把整页文本层拼成**一条**归一化字符串，并保留「字符 → 文本节点」的映射。
 *
 * ⚠️ 必须整页拼接，**不能逐个文本节点各找各的**：
 * 中文期刊 PDF 的文本层是**逐字 span**（实测一页 2900+ 个文本节点，一个节点基本只有一个字），
 * 像"组织韧性"这种词会被拆在 4 个节点里 —— 按节点分别 indexOf 永远查不到，
 * 页内高亮就会是 0 条（用户看到"搜到了结果但页面上哪都没有标"）。
 * 拼成整页字符串后跨节点搜索，再用跨节点的 DOM Range 取矩形即可。
 */
function normalizePage(root: HTMLElement): PageNorm {
  const chars: NormChar[] = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cur = walker.nextNode();
  while (cur) {
    const node = cur as Text;
    const raw = node.data;
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      // ① 空白/标点**直接丢弃**：文内搜索应当忽略空白与换行
      //    （PDF 抽取出的文本经常把 "CEO" 拆成 "C E O" 或换行，按原样匹配会搜不到）
      // ② 先做 NFKC：中文期刊常把英文抽成**全角**（"ＣＥＯ"），不折叠就永远搜不到 "CEO"；
      //    NFKC 也可能把 1 个字符展开成多个（如 ﬁ → fi），按实际字符逐个登记，保证下标对齐
      const folded = ch.normalize('NFKC');
      for (const fc of folded) {
        if (isSkippable(fc)) continue;
        const lower = fc.toLowerCase();
        for (let k = 0; k < lower.length; k += 1) {
          text += lower[k];
          chars.push({ node, raw: i });
        }
      }
    }
    cur = walker.nextNode();
  }
  return { text, chars };
}

/** 把「整页归一化下标区间」翻成一个**跨节点**的 DOM Range */
function rangeOf(page: PageNorm, from: number, to: number): Range | null {
  if (to <= from || to > page.chars.length) return null;
  const start = page.chars[from];
  const last = page.chars[to - 1];
  if (!start || !last) return null;
  try {
    const range = document.createRange();
    range.setStart(start.node, start.raw);
    range.setEnd(last.node, last.raw + 1);
    return range;
  } catch {
    return null;
  }
}

/**
 * 把查询词归一化到和页面文本**同一套规则**：
 * NFKC（全角→半角、兼容字符折叠）+ 丢弃空白/标点 + 转小写。
 *
 * 例：查询 "CEO" 能命中页面/索引里被写成全角 "ＣＥＯ" 或被拆成 "C E O" 的正文。
 */
function normalizeNeedle(query: string): string {
  let out = '';
  for (const ch of query) {
    const folded = ch.normalize('NFKC');
    for (const fc of folded) {
      if (isSkippable(fc)) continue;
      out += fc.toLowerCase();
    }
  }
  return out;
}

/**
 * 计算某页所有命中矩形（页面相对百分比）。
 * 返回顺序即"页内命中序号"，调用方用页内偏移决定哪一条是当前命中。
 */
export function findHighlightStrips(
  container: HTMLElement,
  pageEl: HTMLElement,
  query: string,
): HighlightStrip[] {
  const needle = normalizeNeedle(query);
  if (needle.length < 1) return [];
  const pageRect = pageEl.getBoundingClientRect();
  if (pageRect.width <= 0 || pageRect.height <= 0) return [];
  const page = normalizePage(container);
  if (!page.chars.length) return [];

  const strips: HighlightStrip[] = [];
  let hitIndex = 0;

  // 在**整页**归一化文本上找命中（跨文本节点），一个命中跨行时 getClientRects 会给出多段
  for (let from = 0; ; ) {
    const at = page.text.indexOf(needle, from);
    if (at < 0) break;
    from = at + Math.max(1, needle.length);
    const range = rangeOf(page, at, at + needle.length);
    if (!range) continue;
    const key = `${hitIndex}`;
    hitIndex += 1;
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0.5 || rect.height <= 0.5) continue;
      strips.push({
        key,
        left: ((rect.left - pageRect.left) / pageRect.width) * 100,
        top: ((rect.top - pageRect.top) / pageRect.height) * 100,
        width: (rect.width / pageRect.width) * 100,
        height: (rect.height / pageRect.height) * 100,
        current: false,
      });
    }
  }
  return strips;
}

/** 页内命中数（页内 key 的最大值 + 1） */
export function hitCountOfStrips(strips: HighlightStrip[]): number {
  let max = -1;
  for (const strip of strips) max = Math.max(max, Number(strip.key));
  return max + 1;
}

/** 统计归一化文本里的命中次数（用于"第 n / N 处"） */
export function countHits(text: string, query: string): number {
  const needle = normalizeNeedle(query);
  if (!needle) return 0;
  // 索引文本里夹着空白/换行（PDF 抽取时常见），这里统一按"忽略空白"匹配
  const haystack = normalizeNeedle(text);
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count += 1;
    from = at + Math.max(1, needle.length);
    if (count > 5000) break;
  }
  return count;
}

/** 上下文片段 */
export function snippetAround(text: string, query: string, radius = 34): string {
  const needle = normalizeNeedle(query);
  if (!needle) return text.slice(0, radius * 2);
  // 建「归一化文本 → 原文下标」映射（规则与页面/索引一致），定位后回到原文截取
  let norm = '';
  const pos: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const folded = text[i].normalize('NFKC');
    for (const fc of folded) {
      if (isSkippable(fc)) continue;
      const lower = fc.toLowerCase();
      for (let k = 0; k < lower.length; k += 1) {
        norm += lower[k];
        pos.push(i);
      }
    }
  }
  const at = norm.indexOf(needle);
  if (at < 0) return text.slice(0, radius * 2);
  const hitFrom = pos[at] ?? 0;
  const hitTo = (pos[Math.min(pos.length - 1, at + needle.length - 1)] ?? hitFrom) + 1;
  const from = Math.max(0, hitFrom - radius);
  const to = Math.min(text.length, hitTo + radius);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`;
}

export type { PageTextMap };

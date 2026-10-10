/**
 * Markdown / HTML 渲染管线：
 * marked 解析 → highlight.js 代码高亮 → KaTeX 行内与块级公式 → DOMPurify 净化。
 * 输出只走 dangerouslySetInnerHTML，因此净化这一步是必需的。
 */
import { Marked } from 'marked';
import type { Token, Tokens } from 'marked';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';
import DOMPurify from 'dompurify';

export interface MdHeading {
  id: string;
  text: string;
  depth: number;
}

export interface RenderResult {
  html: string;
  headings: MdHeading[];
}

const SAFE_TAGS = [
  'div', 'span', 'p', 'br', 'hr', 'em', 'strong', 'del', 's', 'sub', 'sup', 'mark', 'small',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'kbd', 'samp',
  'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'input', 'details', 'summary', 'section', 'article', 'header', 'footer', 'aside', 'nav', 'main',
  // KaTeX 需要
  'math', 'semantics', 'annotation', 'annotation-xml', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext',
  'mspace', 'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mstyle', 'mtable', 'mtr', 'mtd',
  'mlabeledtr', 'munder', 'mover', 'munderover', 'mpadded', 'mphantom', 'menclose', 'mglyph',
  'line', 'svg', 'path', 'g', 'use', 'defs', 'rect', 'circle', 'text', 'tspan',
];

const SAFE_ATTR = [
  'href', 'title', 'alt', 'src', 'class', 'id', 'style', 'align', 'colspan', 'rowspan', 'start',
  'type', 'checked', 'disabled', 'width', 'height', 'viewBox', 'aria-hidden', 'role', 'lang',
  'xmlns', 'display', 'mathvariant', 'stretchy', 'encoding', 'd', 'fill', 'stroke', 'stroke-width',
  'x', 'y', 'x1', 'x2', 'y1', 'y2', 'transform', 'preserveAspectRatio', 'focusable',
];

let markedInstance: Marked | null = null;

function instance(): Marked {
  if (markedInstance) return markedInstance;
  const m = new Marked({ gfm: true, breaks: false });
  markedInstance = m;
  return m;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slugify(text: string, used: Set<string>): string {
  const base =
    text
      .trim()
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '-')
      .replace(/[^\w\u4e00-\u9fa5-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'section';
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function renderMath(latex: string, display: boolean): string {
  try {
    return katex.renderToString(latex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml' });
  } catch {
    return `<code class="rd-math-raw">${escapeHtml(latex)}</code>`;
  }
}

interface MathContext {
  seq: number;
  store: Map<string, string>;
}

/**
 * 在交给 marked 之前，把公式抽成占位符（每次渲染用独立上下文，互不干扰）。
 * 返回处理后的文本；渲染完再用 restoreMath 填回去。
 */
function extractMath(source: string, ctx: MathContext): string {
  const lines = source.split('\n');
  const out: string[] = [];
  let buffer: string[] | null = null;
  let inFence = false;

  const flushBlock = (latex: string) => {
    const key = `RDBLOCKMATH${ctx.seq++}`;
    ctx.store.set(key, renderMath(latex, true));
    out.push('', `<div class="rd-math-block">${key}</div>`, '');
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (buffer) {
        out.push(buffer.join('\n'));
        buffer = null;
      }
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (buffer) {
      const closing = line.match(/^(.*?)\$\$\s*$/);
      if (closing) {
        buffer.push(closing[1]);
        flushBlock(buffer.join('\n'));
        buffer = null;
      } else {
        buffer.push(line);
      }
      continue;
    }
    // 单行整块公式：$$ ... $$
    const single = line.match(/^\s*\$\$([\s\S]+?)\$\$\s*$/);
    if (single) {
      flushBlock(single[1]);
      continue;
    }
    // 跨行公式起始：$$ ...（后续行找收尾）
    if (/^\s*\$\$/.test(line)) {
      const rest = line.replace(/^\s*\$\$/, '');
      if (/\$\$\s*$/.test(rest)) {
        flushBlock(rest.replace(/\$\$\s*$/, ''));
      } else {
        buffer = [rest];
      }
      continue;
    }
    // 行内公式：$...$（要求 $ 后不是空白、$ 前不是空白，避免吃掉货币写法）
    out.push(
      line.replace(/(?<!\\)\$(?!\s)((?:\\\$|[^$\n]){1,400}?)(?<!\s)\$/g, (_whole, latex: string) => {
        const key = `RDMATH${ctx.seq++}`;
        ctx.store.set(key, renderMath(latex, false));
        return key;
      }),
    );
  }
  if (buffer) out.push(buffer.join('\n'));
  return out.join('\n');
}

function restoreMath(html: string, ctx: MathContext): string {
  let out = html;
  for (const [key, value] of ctx.store) {
    out = out.split(key).join(value);
  }
  return out;
}

function highlightCode(code: string, lang: string): string {
  const language = lang && hljs.getLanguage(lang) ? lang : '';
  try {
    if (language) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

export interface RenderOptions {
  /** 标题锚点前缀，避免与页面其它 id 冲突 */
  idPrefix?: string;
}

/** 渲染 Markdown 为 HTML（已净化）+ 抽取标题结构 */
export function renderMarkdown(source: string, options: RenderOptions = {}): RenderResult {
  const prefix = options.idPrefix ?? 'rd-h';
  const used = new Set<string>();
  const headings: MdHeading[] = [];
  const mathCtx: MathContext = { seq: 0, store: new Map() };
  const prepared = extractMath(source, mathCtx);
  const m = instance();
  let tokens: Token[];
  try {
    tokens = m.lexer(prepared);
  } catch {
    return { html: `<pre class="rd-raw">${escapeHtml(source)}</pre>`, headings };
  }

  const chunks: string[] = [];
  for (const token of tokens) {
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading;
      const id = `${prefix}-${slugify(heading.text || heading.raw, used)}`;
      // 保留 marked 已经切好的行内 token，标题里也能有公式 / 代码 / 链接
      const inner = m.Parser.parseInline(heading.tokens ?? []) as string;
      chunks.push(`<h${heading.depth} id="${id}">${inner}</h${heading.depth}>\n`);
      if (heading.depth <= 4) headings.push({ id, text: heading.text.replace(/\s+/g, ' ').trim(), depth: heading.depth });
      continue;
    }
    if (token.type === 'code') {
      const code = token as Tokens.Code;
      const lang = (code.lang ?? '').split(/\s+/)[0] ?? '';
      const body = highlightCode(code.text, lang);
      chunks.push(`<pre class="rd-code" data-lang="${escapeHtml(lang)}"><code class="hljs language-${escapeHtml(lang)}">${body}</code></pre>\n`);
      continue;
    }
    if (token.type === 'space') continue;
    try {
      chunks.push(m.parser([token]) as string);
    } catch {
      chunks.push(escapeHtml(token.raw));
    }
  }

  const html = sanitize(restoreMath(chunks.join(''), mathCtx));
  return { html, headings };
}

/** 渲染一段 HTML（已净化）。html 里如果有 id 冲突由调用方负责 */
export function renderHtmlDocument(source: string): string {
  const withoutScripts = source
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '');
  const body = withoutScripts.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? withoutScripts;
  return sanitize(body);
}

/** 净化：白名单 + 屏蔽远程图片/脚本式 URL */
export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: SAFE_TAGS,
    ALLOWED_ATTR: SAFE_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'formaction', 'srcdoc'],
  });
}

/** 纯文本阅读器排版：保留换行，代码/表格类内容用等宽 */
export function looksMonospaced(text: string): boolean {
  const sample = text.slice(0, 4000);
  if (!sample.trim()) return false;
  const lines = sample.split('\n');
  const longLines = lines.filter((l) => l.length > 100).length;
  const tabs = (sample.match(/\t/g) ?? []).length;
  return longLines / Math.max(1, lines.length) > 0.35 || tabs > 12;
}

export { escapeHtml };

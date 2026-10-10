/**
 * 文件名启发式解析：当 PDF 没有内嵌元数据（扫描件、劣质导出）时的兜底。
 * 纯函数，便于单测。
 */

export interface NameGuess {
  title: string;
  authors: string[];
  year: number | null;
  doi: string;
  arxivId: string;
  tags: string[];
  /** 该名字是否像是"作者 - 年份 - 标题"这类规范命名 */
  structured: boolean;
}

const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+)/;
const ARXIV_RE = /\b(?:arxiv[:\s_-]*)?(\d{4}\.\d{4,5})(?:v\d+)?\b/i;
const YEAR_RE = /(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/;

const SPLIT_RE = /\s*(?:--|—|–|\s-\s|_|\||;|｜)\s*/;
const TAG_RE = /(?:^|\s)#([\p{L}\p{N}_\-/]{1,24})/gu;

function clean(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/^[\s._\-–—]+|[\s._\-–—]+$/g, '')
    .trim();
}

function stripLeadingOrdinal(s: string): string {
  // 末尾的 (?!\d) 必不可少：否则 "2021 - 作者 - 标题" 会被吃掉前 3 位变成 "1 - 作者 - 标题"，
  // 导致"年份 - 作者 - 标题"形态彻底解析不出来。
  return s.replace(/^\s*(?:\[?\d{1,3}\]?[.)、]?(?!\d)|第?\d{1,3}[章节篇][\s:：-]*)\s*/, '');
}

function looksLikeAuthor(token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  if (t.length > 34) return false;
  if (/^(et al\.?|等|and|&|\/)$/i.test(t)) return true;
  if (/\bet al\.?$/i.test(t)) return true;
  // 中文姓名（2-4 字，可逗号分隔多个）
  if (/^[\p{Script=Han}]{2,4}(?:[、,，]\s*[\p{Script=Han}]{2,4})*$/u.test(t)) return true;
  // 英文姓名：Last, F. M. / First Last / Last FM
  if (/^[A-Z][\p{L}'`-]+(?:\s*,\s*(?:[A-Z]\.\s*)+)?$/u.test(t)) return true;
  if (/^(?:[A-Z]\.\s*)+[A-Z][\p{L}'`-]+$/u.test(t)) return true;
  if (/^[A-Z][\p{L}'`-]+(?:\s+[A-Z][\p{L}'`-]+){0,3}$/u.test(t) && t.split(/\s+/).length <= 4) return true;
  return false;
}

function splitAuthors(raw: string): string[] {
  return raw
    .split(/\s*(?:,|;|、|，|&|\band\b|和|与)\s*/i)
    .map((s) => clean(s))
    .filter((s) => s && !/^(et al\.?|等)$/i.test(s))
    .slice(0, 24);
}

export function guessFromFileName(fileName: string): NameGuess {
  const withoutExt = fileName.replace(/\.[A-Za-z0-9]{1,6}$/, '');
  const tags: string[] = [];
  let working = withoutExt;
  for (const m of withoutExt.matchAll(TAG_RE)) {
    tags.push(m[1]);
    working = working.replace(m[0], ' ');
  }
  working = clean(working);

  let doi = '';
  let arxivId = '';
  const doiMatch = working.match(DOI_RE);
  if (doiMatch) {
    doi = doiMatch[1];
    working = clean(working.replace(doiMatch[0], ' '));
  }
  const arxivMatch = working.match(ARXIV_RE);
  if (arxivMatch) {
    arxivId = arxivMatch[1];
    working = clean(working.replace(arxivMatch[0], ' '));
  }

  const base = stripLeadingOrdinal(working);
  const tokens = base.split(SPLIT_RE).map(clean).filter(Boolean);

  let year: number | null = null;
  const yearMatch = base.match(YEAR_RE);
  if (yearMatch) year = Number(yearMatch[1]);

  let authors: string[] = [];
  let title = '';
  let structured = false;

  // 形态一：作者 - 年份 - 标题（Zotero / EndNote 导出）
  if (tokens.length >= 3 && /^(?:19|20)\d{2}$/.test(tokens[1])) {
    authors = splitAuthors(tokens[0]);
    title = clean(tokens.slice(2).join(' '));
    structured = authors.length > 0;
  }
  // 形态二：年份 - 作者 - 标题
  else if (tokens.length >= 3 && /^(?:19|20)\d{2}$/.test(tokens[0])) {
    year = Number(tokens[0]);
    authors = splitAuthors(tokens[1]);
    title = clean(tokens.slice(2).join(' '));
    structured = authors.length > 0;
  }
  // 形态三：作者 (年份) 标题 / 标题 (年份)
  else {
    const parenYear = base.match(/[（(]\s*((?:19|20)\d{2})\s*[)）]/);
    if (parenYear && tokens.length >= 2) {
      year = Number(parenYear[1]);
      const before = clean(base.slice(0, parenYear.index ?? 0));
      const after = clean(base.slice((parenYear.index ?? 0) + parenYear[0].length));
      const candidates = [before, after].filter(Boolean);
      const authorIdx = candidates.findIndex((c) => looksLikeAuthor(c) && c.split(/\s+/).length <= 5);
      if (authorIdx >= 0) {
        authors = splitAuthors(candidates[authorIdx]);
        title = clean(candidates.filter((_, i) => i !== authorIdx).join(' ') || candidates[authorIdx]);
        structured = true;
      } else {
        title = clean(candidates.join(' '));
      }
    } else if (tokens.length >= 2 && looksLikeAuthor(tokens[0]) && tokens[0].length < 30 && !/^\d/.test(tokens[0])) {
      authors = splitAuthors(tokens[0]);
      title = clean(tokens.slice(1).join(' '));
    } else {
      title = base;
    }
  }

  if (!title) title = base || withoutExt;
  // 标题里的下划线与多余分隔符还原成空格
  title = clean(title.replace(/[_]+/g, ' '));
  // 如果标题里还残留纯年份，去掉尾部年份重复
  if (year) {
    title = clean(title.replace(new RegExp(`^[（(]?${year}[)）]?\\s*`), ''));
    title = clean(title.replace(new RegExp(`\\s*[（(]?${year}[)）]?$`), ''));
  }
  if (!title) title = base || withoutExt;

  return { title, authors, year, doi, arxivId, tags, structured };
}

/** 标题是否"看起来已经是真标题"（用于决定是否用文件名覆盖 PDF 内嵌标题） */
export function titleQuality(title: string | undefined | null): number {
  if (!title) return 0;
  const t = title.trim();
  if (t.length < 4) return 1;
  if (/^(untitled|microsoft word|document\d*|扫描|新建|无标题|pdf|adobe|print)$/i.test(t)) return 0;
  if (/\.(pdf|docx?|indd)$/i.test(t)) return 1;
  // \b 对中文字符不成立（章/篇 不是 \w），会让整个中文分支变成死代码；改用否定环视
  if (/^(?:第?\d+[章节篇]|slide|page)(?![\p{L}\p{N}])/iu.test(t)) return 2;
  if (/^[A-Za-z0-9\s.,;:'"()\-_]+$/.test(t) && t.split(/\s+/).length <= 2 && t.length < 12) return 3;
  return 5;
}

/** 清理 PDF 元数据里的标题噪音 */
export function sanitizeTitle(raw: string | null | undefined): string {
  if (!raw) return '';
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(/\.(pdf|docx?|tex|dvi)$/i, '');
  t = t.replace(/^(?:Microsoft Word|untitled|document)\s*[-–—]?\s*/i, '');
  t = t.replace(/\s*[-–—]\s*(?:Microsoft Word|LaTeX|Acrobat.*)$/i, '');
  return t.trim();
}

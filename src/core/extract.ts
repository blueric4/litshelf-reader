/**
 * 元数据与正文抽取（宿主侧）。
 * - PDF：pdfjs-dist legacy 构建（Node 可用），只取元数据/页数/前几页文本
 * - TXT/MD/HTML：编码嗅探 + 去标签
 * - DOCX：mammoth 取纯文本
 * 全部失败都返回 null / 空值，绝不抛出到调用方，保证扫描队列不中断。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { longPath, baseNameNoExt } from './paths';

export interface PdfMetadataInfo {
  ok: boolean;
  pageCount: number;
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  creationDate: string;
  modDate: string;
  /** 前 3 页纯文本（用于 DOI 识别与摘要） */
  headText: string;
  error?: string;
}

export interface ExtractedText {
  /** 每页一段（非 PDF 类型只有一"页"） */
  pages: string[];
  wordCount: number;
  charCount: number;
}

type PdfjsModule = {
  getDocument: (src: unknown) => { promise: Promise<PdfDocumentProxy> };
  GlobalWorkerOptions?: { workerSrc: string };
  version?: string;
};

interface PdfDocumentProxy {
  numPages: number;
  getMetadata: () => Promise<{ info?: Record<string, unknown>; metadata?: { get: (k: string) => unknown } | null }>;
  getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: { str?: string; hasEOL?: boolean }[] }> }>;
  destroy: () => Promise<void>;
}

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/**
 * 在 Node 里让 pdfjs 正常工作的关键：必须把 GlobalWorkerOptions.workerSrc
 * 指到 pdfjs-dist 自带的 worker 文件（file:// URL）。设为空字符串会报
 * "Setting up fake worker failed: No GlobalWorkerOptions.workerSrc specified."
 */
function resolvePdfWorker(relative: string): string {
  try {
    // createRequire 在 ESM 与 esbuild 打包产物里都可用
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve('pdfjs-dist/package.json');
    const worker = path.join(path.dirname(pkgJson), relative);
    return pathToFileURL(worker).href;
  } catch {
    return '';
  }
}

/** 依次尝试 v4/v5 的 legacy 与常规入口，任一成功即缓存 */
export async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const candidates: { spec: string; worker: string }[] = [
        { spec: 'pdfjs-dist/legacy/build/pdf.mjs', worker: 'legacy/build/pdf.worker.mjs' },
        { spec: 'pdfjs-dist/build/pdf.mjs', worker: 'build/pdf.worker.mjs' },
      ];
      const errors: string[] = [];
      for (const candidate of candidates) {
        try {
          const mod = (await import(/* @vite-ignore */ candidate.spec)) as unknown as PdfjsModule;
          if (mod && typeof mod.getDocument === 'function') {
            const workerSrc = resolvePdfWorker(candidate.worker);
            try {
              if (mod.GlobalWorkerOptions && workerSrc) mod.GlobalWorkerOptions.workerSrc = workerSrc;
            } catch {
              /* 只读属性等异常不影响主流程 */
            }
            return mod;
          }
        } catch (err) {
          errors.push(`${candidate.spec}: ${(err as Error).message}`);
        }
      }
      throw new Error(`无法加载 pdfjs-dist（${errors.join(' | ')}）`);
    })();
  }
  return pdfjsPromise;
}

/** 把 pdf.js 的文本片段拼成可读文本：CJK 之间不加空格，拉丁字母之间补空格 */
function textFromItems(items: { str?: string; hasEOL?: boolean }[]): string {
  let out = '';
  let prev = '';
  for (const it of items) {
    const s = typeof it.str === 'string' ? it.str : '';
    if (s) {
      const needSpace =
        prev.length > 0 &&
        !/\s$/.test(prev) &&
        !/^\s/.test(s) &&
        /[A-Za-z0-9)\]]$/.test(prev) &&
        /^[A-Za-z0-9([]/.test(s);
      if (needSpace) out += ' ';
      out += s;
      prev = s;
    }
    if (it.hasEOL) {
      out += '\n';
      prev = '';
    }
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const DATE_RE = /^D:(\d{4})(\d{2})?(\d{2})?/;

function pdfDate(v: unknown): string {
  if (typeof v !== 'string') return '';
  const m = v.match(DATE_RE);
  if (!m) return v;
  return `${m[1]}${m[2] ? `-${m[2]}` : ''}${m[3] ? `-${m[3]}` : ''}`;
}

function pick(info: Record<string, unknown> | undefined, keys: string[]): string {
  if (!info) return '';
  for (const k of keys) {
    const v = info[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** 读取 PDF 元数据 + 前若干页文本 */
export async function extractPdf(filePath: string, opts: { headPages?: number; withAllText?: boolean } = {}): Promise<PdfMetadataInfo> {
  const headPages = opts.headPages ?? 3;
  const empty: PdfMetadataInfo = {
    ok: false,
    pageCount: 0,
    title: '',
    author: '',
    subject: '',
    keywords: '',
    creator: '',
    producer: '',
    creationDate: '',
    modDate: '',
    headText: '',
  };
  let doc: PdfDocumentProxy | null = null;
  try {
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(await fs.readFile(longPath(filePath)));
    const task = pdfjs.getDocument({
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      // 只要文本与元数据，不渲染，无需字体资源
      verbosity: 0,
    });
    doc = await task.promise;
    const pageCount = doc.numPages;
    let info: Record<string, unknown> | undefined;
    let xmpTitle = '';
    let xmpCreator = '';
    try {
      const meta = await doc.getMetadata();
      info = meta.info ?? undefined;
      const get = meta.metadata?.get?.bind(meta.metadata);
      if (get) {
        xmpTitle = String(get('dc:title') ?? '').trim();
        xmpCreator = String(get('dc:creator') ?? '').trim();
      }
    } catch {
      /* 元数据缺失很常见 */
    }

    const limit = opts.withAllText ? pageCount : Math.min(headPages, pageCount);
    const chunks: string[] = [];
    for (let p = 1; p <= limit; p += 1) {
      try {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        chunks.push(textFromItems(content.items));
      } catch {
        chunks.push('');
      }
      // 同上：扫描阶段一篇篇抽正文时也要让出，别把主进程饿死（否则界面/IPC 会卡住）
      await new Promise((r) => setTimeout(r, 0));
    }

    return {
      ok: true,
      pageCount,
      title: pick(info, ['Title']) || xmpTitle,
      author: pick(info, ['Author']) || xmpCreator,
      subject: pick(info, ['Subject']),
      keywords: pick(info, ['Keywords']),
      creator: pick(info, ['Creator']),
      producer: pick(info, ['Producer']),
      creationDate: pdfDate(info?.CreationDate),
      modDate: pdfDate(info?.ModDate),
      headText: chunks.join('\n\n').slice(0, 200_000),
    };
  } catch (err) {
    return { ...empty, error: (err as Error).message };
  } finally {
    await doc?.destroy().catch(() => undefined);
  }
}

/** 编码嗅探：BOM 优先，其次严格 UTF-8，最后退回 GBK */
export function decodeTextBuffer(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    /* 继续 */
  }
  try {
    return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk' };
  } catch {
    return { text: buf.toString('latin1'), encoding: 'latin1' };
  }
}

export async function readTextFileSmart(filePath: string): Promise<{ text: string; encoding: string }> {
  const buf = await fs.readFile(longPath(filePath));
  return decodeTextBuffer(buf);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function countWords(text: string): { words: number; chars: number } {
  const chars = text.replace(/\s/g, '').length;
  const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length;
  const latin = (text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? []).length;
  return { words: cjk + latin, chars };
}

/** 取正文用于全文索引；返回每页/每章文本 */
export async function extractTextForIndex(filePath: string, kind: string): Promise<ExtractedText | null> {
  try {
    if (kind === 'pdf') {
      const pdfjs = await loadPdfjs();
      const data = new Uint8Array(await fs.readFile(longPath(filePath)));
      const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, verbosity: 0 });
      const doc = await task.promise;
      const pages: string[] = [];
      for (let p = 1; p <= doc.numPages; p += 1) {
        try {
          const page = await doc.getPage(p);
          const content = await page.getTextContent();
          pages.push(textFromItems(content.items));
        } catch {
          pages.push('');
        }
        // 关键：让出一次宏任务。Node 形态下 pdfjs 跑的是同线程 fake worker（微任务循环），
        // 连续 getTextContent 会把主进程的 I/O 与 IPC 饿死——表现就是"刚加完库点开文献
        // 要等十几秒才出文本层/缩略图"（渲染层取文件的请求排在后面）。
        await new Promise((r) => setTimeout(r, 0));
      }
      await doc.destroy().catch(() => undefined);
      const all = pages.join('\n');
      const { words, chars } = countWords(all);
      return { pages, wordCount: words, charCount: chars };
    }

    if (kind === 'text' || kind === 'markdown') {
      const { text } = await readTextFileSmart(filePath);
      const { words, chars } = countWords(text);
      return { pages: [text], wordCount: words, charCount: chars };
    }

    if (kind === 'html') {
      const { text } = await readTextFileSmart(filePath);
      const plain = htmlToText(text);
      const { words, chars } = countWords(plain);
      return { pages: [plain], wordCount: words, charCount: chars };
    }

    if (kind === 'docx') {
      const mammoth = (await import('mammoth')) as unknown as {
        extractRawText: (input: { path: string }) => Promise<{ value: string }>;
      };
      const res = await mammoth.extractRawText({ path: longPath(filePath) });
      const text = res.value ?? '';
      const { words, chars } = countWords(text);
      return { pages: [text], wordCount: words, charCount: chars };
    }

    if (kind === 'epub') {
      const { extractEpub } = await import('./epub');
      const book = await extractEpub(filePath);
      if (!book) return null;
      const pages = book.chapters.map((c) => htmlToText(c.html));
      const all = pages.join('\n');
      const { words, chars } = countWords(all);
      return { pages, wordCount: words, charCount: chars };
    }
  } catch {
    return null;
  }
  return null;
}

/** 供展示用的标题兜底 */
export function fallbackTitle(filePath: string): string {
  return baseNameNoExt(filePath.split(/[\\/]/).pop() ?? filePath);
}

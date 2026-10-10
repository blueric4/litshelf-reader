/**
 * 渲染层 EPUB 解析：ZIP → META-INF/container.xml → OPF → spine 章节。
 * 只做"能读"这一件事：章节正文里的相对图片内联成 data URI，取不到就静默跳过。
 */
import { Unzip } from './zip';

export interface EpubChapter {
  id: string;
  href: string;
  title: string;
  /** 已内联图片的正文 HTML（未净化，交给调用方 DOMPurify） */
  html: string;
}

export interface EpubBook {
  title: string;
  authors: string[];
  language: string;
  identifier: string;
  chapters: EpubChapter[];
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  css: 'text/css',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

/** 词法安全的 posix 路径拼接（渲染层不想引 node:path） */
function resolvePath(baseFile: string, href: string): string {
  const baseDir = baseFile.includes('/') ? baseFile.slice(0, baseFile.lastIndexOf('/')) : '';
  const raw = href.split('#')[0].split('?')[0];
  const stack = raw.startsWith('/') ? [] : baseDir ? baseDir.split('/') : [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function dirOf(p: string): string {
  return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    // 极少数 EPUB 的 XHTML 片段不合法 XML，退回 HTML 解析
    return new DOMParser().parseFromString(text, 'text/html');
  }
  return doc;
}

function firstTagText(doc: Document, tag: string): string {
  const nodes = doc.getElementsByTagName(tag);
  if (nodes.length) return nodes[0].textContent?.trim() ?? '';
  const alt = doc.getElementsByTagName(`dc:${tag}`);
  return alt.length ? alt[0].textContent?.trim() ?? '' : '';
}

function allTagText(doc: Document, tag: string): string[] {
  const out: string[] = [];
  for (const node of Array.from(doc.getElementsByTagName(tag))) {
    const text = node.textContent?.trim();
    if (text) out.push(text);
  }
  if (!out.length) {
    for (const node of Array.from(doc.getElementsByTagName(`dc:${tag}`))) {
      const text = node.textContent?.trim();
      if (text) out.push(text);
    }
  }
  return out;
}

function stripHeadNoise(doc: Document): void {
  for (const tag of ['script', 'link', 'meta', 'base']) {
    for (const node of Array.from(doc.getElementsByTagName(tag))) node.parentNode?.removeChild(node);
  }
}

/** 解析 EPUB：失败抛错（由 UI 转成友好提示） */
export async function parseEpub(url: string): Promise<EpubBook> {
  const zip = await Unzip.fromUrl(url);

  const containerText = await zip.readText('META-INF/container.xml');
  let opfPath = '';
  if (containerText) {
    const container = parseXml(containerText);
    const rootfile = container.getElementsByTagName('rootfile')[0];
    opfPath = rootfile?.getAttribute('full-path') ?? '';
  }
  if (!opfPath) {
    // 退化：直接找一个 .opf
    opfPath = zip.entries.find((e) => /\.opf$/i.test(e.name))?.name ?? '';
  }
  if (!opfPath) throw new Error('这个 EPUB 里没有找到 OPF 包描述文件');

  const opfText = await zip.readText(opfPath);
  if (!opfText) throw new Error('无法读取 EPUB 的 OPF 包描述文件');
  const opf = parseXml(opfText);
  const opfDir = dirOf(opfPath);

  const title = firstTagText(opf, 'title');
  const authors = allTagText(opf, 'creator');
  const language = firstTagText(opf, 'language');
  const identifier = firstTagText(opf, 'identifier');

  const manifest = new Map<string, { href: string; type: string; props: string }>();
  for (const item of Array.from(opf.getElementsByTagName('item'))) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href) continue;
    manifest.set(id, {
      href: opfDir ? resolvePath(`${opfDir}/x`, href) : resolvePath('x', href),
      type: item.getAttribute('media-type') ?? '',
      props: item.getAttribute('properties') ?? '',
    });
  }

  const spineIds: string[] = [];
  for (const ref of Array.from(opf.getElementsByTagName('itemref'))) {
    const idref = ref.getAttribute('idref');
    if (idref) spineIds.push(idref);
  }
  if (!spineIds.length) {
    // 没有 spine 的畸形文件：按 manifest 顺序取所有 xhtml
    for (const [id, item] of manifest) {
      if (isHtmlItem(item)) spineIds.push(id);
    }
  }

  // 目录标题：EPUB3 nav 优先，其次 EPUB2 NCX
  const titles = new Map<string, string>();
  for (const [id, item] of manifest) {
    if (!/nav/i.test(item.props) && !/nav\.x?html?$/i.test(item.href)) continue;
    if (!isHtmlItem(item)) continue;
    const navText = await zip.readText(item.href);
    if (!navText) continue;
    const nav = parseXml(navText);
    for (const anchor of Array.from(nav.getElementsByTagName('a'))) {
      const href = anchor.getAttribute('href');
      if (!href) continue;
      const label = stripTags(anchor.innerHTML || anchor.textContent || '');
      const key = resolvePath(item.href, href);
      if (label && !titles.has(key)) titles.set(key, label);
    }
    if (titles.size) break;
  }
  if (!titles.size) {
    const ncx = [...manifest.values()].find((i) => /ncx/i.test(i.type) || /\.ncx$/i.test(i.href));
    const ncxEntry = ncx?.href ?? zip.entries.find((e) => /\.ncx$/i.test(e.name))?.name;
    if (ncxEntry) {
      const ncxText = await zip.readText(ncxEntry);
      if (ncxText) {
        const doc = parseXml(ncxText);
        for (const point of Array.from(doc.getElementsByTagName('navPoint'))) {
          const label = point.getElementsByTagName('text')[0]?.textContent?.trim() ?? '';
          const src = point.getElementsByTagName('content')[0]?.getAttribute('src') ?? '';
          if (!label || !src) continue;
          const key = resolvePath(ncxEntry, src);
          if (!titles.has(key)) titles.set(key, label);
        }
      }
    }
  }

  const rawChapters: { id: string; href: string; title: string; body: string }[] = [];
  for (const id of spineIds) {
    const item = manifest.get(id);
    if (!item || !isHtmlItem(item)) continue;
    const text = await zip.readText(item.href);
    if (text === null) continue;
    const doc = parseXml(text);
    stripHeadNoise(doc);
    const body = doc.getElementsByTagName('body')[0] ?? doc.documentElement;
    rawChapters.push({
      id,
      href: item.href,
      title: titles.get(item.href) ?? '',
      body: body ? body.innerHTML : text,
    });
  }

  if (!rawChapters.length) throw new Error('这个 EPUB 里没有可显示的章节');

  // 内联图片：复用同一份解码缓存，避免重复解压
  const dataUriCache = new Map<string, string | null>();
  const toDataUri = async (target: string): Promise<string | null> => {
    const key = target.toLowerCase();
    if (dataUriCache.has(key)) return dataUriCache.get(key) ?? null;
    let result: string | null = null;
    const bytes = await zip.read(target);
    if (bytes) {
      const ext = target.includes('.') ? target.slice(target.lastIndexOf('.') + 1).toLowerCase() : '';
      const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
      result = `data:${mime};base64,${bytesToBase64(bytes)}`;
    }
    dataUriCache.set(key, result);
    return result;
  };

  const chapters: EpubChapter[] = [];
  for (let i = 0; i < rawChapters.length; i += 1) {
    const chapter = rawChapters[i];
    let html = chapter.body;
    const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    const svgImages = [...html.matchAll(/<image\b[^>]*>/gi)].map((m) => m[0]);
    for (const tag of [...imgTags, ...svgImages]) {
      const src = tag.match(/\b(?:xlink:href|src)\s*=\s*"([^"]*)"/i)?.[1] ?? tag.match(/\b(?:xlink:href|src)\s*=\s*'([^']*)'/i)?.[1];
      if (!src || /^(https?:|data:)/i.test(src)) continue;
      const resolved = resolvePath(chapter.href, src);
      const dataUri = await toDataUri(resolved);
      if (!dataUri) continue; // 取不到就跳过，不报错
      html = html.split(tag).join(tag.replace(src, dataUri));
    }
    chapters.push({
      id: chapter.id,
      href: chapter.href,
      title: chapter.title || `第 ${i + 1} 节`,
      html,
    });
  }

  return { title, authors, language, identifier, chapters };
}

function isHtmlItem(item: { href: string; type: string }): boolean {
  return /xhtml|html|xml/i.test(item.type) || /\.x?html?$/i.test(item.href);
}

/** 分块 base64，避免大图触发参数长度上限 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export { escapeHtml };

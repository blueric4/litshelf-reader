/**
 * EPUB 基础解析：container.xml → OPF → spine 章节 + 元数据。
 * 章节内的相对图片会内联为 data URI，渲染层直接当 HTML 显示。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { longPath } from './paths';
import { parseZipEntries, readZipEntry, type ZipEntry } from './zip';

export interface EpubChapter {
  id: string;
  href: string;
  title: string;
  html: string;
}

export interface EpubBook {
  title: string;
  authors: string[];
  language: string;
  identifier: string;
  chapters: EpubChapter[];
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  css: 'text/css',
};

function resolveHref(base: string, href: string): string {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(base), href));
  return joined.replace(/^\.\//, '');
}

function stripScripts(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/ on[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/ on[a-z]+\s*=\s*'[^']*'/gi, '');
}

export async function extractEpub(filePath: string): Promise<EpubBook | null> {
  try {
    const buf = await fs.readFile(longPath(filePath));
    const entries = parseZipEntries(buf);
    if (!entries.length) return null;
    const byName = new Map<string, ZipEntry>(entries.map((e) => [e.name.toLowerCase(), e]));
    const readEntry = (name: string): Buffer | null => {
      const e = byName.get(name.toLowerCase());
      return e ? readZipEntry(buf, e) : null;
    };

    const containerRaw = readEntry('META-INF/container.xml');
    if (!containerRaw) return null;
    const opfPath = containerRaw.toString('utf8').match(/full-path="([^"]+)"/i)?.[1];
    if (!opfPath) return null;
    const opfRaw = readEntry(opfPath);
    if (!opfRaw) return null;
    const opf = opfRaw.toString('utf8');

    const title = opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1]?.trim() ?? '';
    const authors = [...opf.matchAll(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/gi)].map((m) => m[1].trim()).filter(Boolean);
    const language = opf.match(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i)?.[1]?.trim() ?? '';
    const identifier = opf.match(/<dc:identifier[^>]*>([\s\S]*?)<\/dc:identifier>/i)?.[1]?.trim() ?? '';

    const manifest = new Map<string, { href: string; type: string }>();
    for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
      const tag = m[0];
      const id = tag.match(/\bid="([^"]+)"/i)?.[1];
      const href = tag.match(/\bhref="([^"]+)"/i)?.[1];
      const type = tag.match(/\bmedia-type="([^"]+)"/i)?.[1] ?? '';
      if (id && href) manifest.set(id, { href, type });
    }

    const spineIds = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/gi)].map((m) => m[1]);
    const navTitles = new Map<string, string>();
    for (const navHref of ['toc.ncx', 'nav.xhtml', 'toc.xhtml']) {
      const navEntry = entries.find((e) => e.name.toLowerCase().endsWith(navHref));
      if (!navEntry) continue;
      const raw = readZipEntry(buf, navEntry);
      if (!raw) continue;
      const text = raw.toString('utf8');
      for (const m of text.matchAll(/<navPoint[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?src="([^"#]+)/gi)) {
        navTitles.set(m[2].trim(), m[1].replace(/<[^>]+>/g, '').trim());
      }
      for (const m of text.matchAll(/<a\b[^>]*href="([^"#]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
        navTitles.set(m[1].trim(), m[2].replace(/<[^>]+>/g, '').trim());
      }
      break;
    }

    const chapters: EpubChapter[] = [];
    for (const id of spineIds) {
      const item = manifest.get(id);
      if (!item) continue;
      if (!/xhtml|html|xml/i.test(item.type) && !/\.x?html?$/i.test(item.href)) continue;
      const raw = readEntry(item.href);
      if (!raw) continue;
      let html = stripScripts(raw.toString('utf8'));
      // 内联图片
      html = html.replace(/(src|href)="([^"]+)"/gi, (whole, attr: string, href: string) => {
        if (/^(https?:|data:|#)/i.test(href)) return whole;
        if (attr.toLowerCase() === 'href' && /\.x?html?$/i.test(href)) return whole;
        const resolved = resolveHref(item.href, href);
        const data = readEntry(resolved);
        if (!data) return whole;
        const ext = path.extname(resolved).slice(1).toLowerCase();
        const mime = MIME[ext];
        if (!mime) return whole;
        return `${attr}="data:${mime};base64,${data.toString('base64')}"`;
      });
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const body = bodyMatch ? bodyMatch[1] : html;
      chapters.push({
        id,
        href: item.href,
        title: navTitles.get(item.href) ?? navTitles.get(path.posix.basename(item.href)) ?? `第 ${chapters.length + 1} 节`,
        html: body,
      });
    }

    return { title, authors, language, identifier, chapters };
  } catch {
    return null;
  }
}

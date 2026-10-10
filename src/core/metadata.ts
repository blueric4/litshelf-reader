/**
 * 标识符识别 + 联网元数据补全（Crossref / arXiv）。
 * 设计原则：可离线、可失败、可缓存、绝不阻塞界面；超时 8 秒。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { longPath } from './paths';
import { writeFileAtomicSafe } from './fsutil';

export interface OnlineMetadata {
  source: 'crossref' | 'arxiv';
  title?: string;
  authors?: string[];
  year?: number | null;
  venue?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  keywords?: string[];
  type?: string;
  publisher?: string;
}

const DOI_IN_TEXT = /\b(?:doi[:\s]*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s"'<>,;)\]]+)/i;
const ARXIV_IN_TEXT = /\barxiv[:\s/]*(\d{4}\.\d{4,5})(?:v\d+)?/i;

export function extractDoi(text: string | undefined | null): string {
  if (!text) return '';
  const m = text.match(DOI_IN_TEXT);
  if (!m) return '';
  return m[1].replace(/[.,;)\]]+$/, '');
}

export function extractArxivId(text: string | undefined | null): string {
  if (!text) return '';
  const m = text.match(ARXIV_IN_TEXT);
  return m ? m[1] : '';
}

/** 从 abstract 里剥离 JATS 标签 */
function cleanAbstract(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/<jats:[\s\S]*?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface MetadataClientOptions {
  cacheFile: string;
  timeoutMs?: number;
  /** 网络是否可用（false 时直接返回 null，不发请求） */
  online?: boolean;
  userAgent?: string;
}

interface CacheShape {
  [key: string]: { at: number; data: OnlineMetadata | null };
}

const TTL = 30 * 24 * 3600 * 1000;

export class MetadataClient {
  private cache: CacheShape = {};
  private loaded = false;
  private dirty = false;
  /** 串行化的写盘链，保证 close() 能等到最后一次写入真正结束 */
  private writing: Promise<void> = Promise.resolve();
  private readonly opts: Required<Pick<MetadataClientOptions, 'cacheFile' | 'timeoutMs' | 'userAgent'>> & { online: boolean };

  constructor(options: MetadataClientOptions) {
    this.opts = {
      cacheFile: options.cacheFile,
      timeoutMs: options.timeoutMs ?? 8000,
      userAgent: options.userAgent ?? 'LitShelf/1.0 (local literature reader; mailto:litshelf@example.com)',
      online: options.online !== false,
    };
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const text = await fs.readFile(longPath(this.opts.cacheFile), 'utf8');
      this.cache = JSON.parse(text) as CacheShape;
    } catch {
      this.cache = {};
    }
  }

  setOnline(online: boolean): void {
    this.opts.online = online;
  }

  private async persist(): Promise<void> {
    if (!this.dirty) {
      // 已有一次写盘在飞：必须等它落地，否则 close() 会"看似刷了"其实没刷
      await this.writing;
      return;
    }
    this.dirty = false;
    const payload = JSON.stringify(this.cache);
    const run = this.writing.then(async () => {
      await fs.mkdir(longPath(path.dirname(this.opts.cacheFile)), { recursive: true }).catch(() => undefined);
      await writeFileAtomicSafe(this.opts.cacheFile, payload).catch(() => undefined);
    });
    this.writing = run.catch(() => undefined);
    await this.writing;
  }

  private cacheGet(key: string): OnlineMetadata | null | undefined {
    const hit = this.cache[key];
    if (!hit) return undefined;
    if (Date.now() - hit.at > TTL) return undefined;
    return hit.data;
  }

  private cacheSet(key: string, data: OnlineMetadata | null): void {
    this.cache[key] = { at: Date.now(), data };
    this.dirty = true;
    void this.persist();
  }

  private async fetchJson(url: string): Promise<unknown | null> {
    if (!this.opts.online) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/json' },
      });
      if (!res.ok) return null;
      return (await res.json()) as unknown;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchText(url: string): Promise<string | null> {
    if (!this.opts.online) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': this.opts.userAgent } });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async lookupDoi(doi: string): Promise<OnlineMetadata | null> {
    if (!doi) return null;
    await this.load();
    const key = `doi:${doi.toLowerCase()}`;
    const cached = this.cacheGet(key);
    if (cached !== undefined) return cached;
    const json = (await this.fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)) as
      | { message?: Record<string, unknown> }
      | null;
    const msg = json?.message;
    if (!msg) {
      this.cacheSet(key, null);
      return null;
    }
    const authors = Array.isArray(msg.author)
      ? (msg.author as Record<string, unknown>[]).map((a) => {
          const given = typeof a.given === 'string' ? a.given : '';
          const family = typeof a.family === 'string' ? a.family : '';
          return [given, family].filter(Boolean).join(' ').trim() || String(a.name ?? '');
        }).filter(Boolean)
      : [];
    const issued = (msg.issued as { 'date-parts'?: number[][] } | undefined)?.['date-parts']?.[0]?.[0];
    const container = Array.isArray(msg['container-title']) ? String((msg['container-title'] as string[])[0] ?? '') : '';
    const data: OnlineMetadata = {
      source: 'crossref',
      title: Array.isArray(msg.title) ? String((msg.title as string[])[0] ?? '') : String(msg.title ?? ''),
      authors,
      year: typeof issued === 'number' ? issued : null,
      venue: container,
      volume: msg.volume ? String(msg.volume) : '',
      issue: msg.issue ? String(msg.issue) : '',
      pages: msg.page ? String(msg.page) : '',
      doi: typeof msg.DOI === 'string' ? msg.DOI : doi,
      url: typeof msg.URL === 'string' ? msg.URL : `https://doi.org/${doi}`,
      abstract: cleanAbstract(typeof msg.abstract === 'string' ? msg.abstract : ''),
      keywords: Array.isArray(msg.subject) ? (msg.subject as string[]).slice(0, 24) : [],
      type: typeof msg.type === 'string' ? msg.type : '',
      publisher: typeof msg.publisher === 'string' ? msg.publisher : '',
    };
    this.cacheSet(key, data);
    return data;
  }

  async lookupArxiv(id: string): Promise<OnlineMetadata | null> {
    if (!id) return null;
    await this.load();
    const key = `arxiv:${id}`;
    const cached = this.cacheGet(key);
    if (cached !== undefined) return cached;
    const xml = await this.fetchText(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`);
    if (!xml) {
      this.cacheSet(key, null);
      return null;
    }
    const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/i)?.[1];
    if (!entry) {
      this.cacheSet(key, null);
      return null;
    }
    const pick = (tag: string): string => {
      const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? m[1].replace(/\s+/g, ' ').trim() : '';
    };
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map((m) => m[1].trim());
    const published = pick('published');
    const data: OnlineMetadata = {
      source: 'arxiv',
      title: pick('title'),
      authors,
      year: published ? Number(published.slice(0, 4)) : null,
      venue: 'arXiv',
      doi: pick('arxiv:doi') || undefined,
      url: pick('id') || `https://arxiv.org/abs/${id}`,
      abstract: pick('summary'),
      keywords: [...entry.matchAll(/<category[^>]*term="([^"]+)"/gi)].map((m) => m[1]).slice(0, 12),
      type: 'preprint',
    };
    this.cacheSet(key, data);
    return data;
  }

  /** 用标题在 Crossref 做书目检索，取分数最高的一条 */
  async searchByTitle(title: string, year?: number | null): Promise<OnlineMetadata | null> {
    const clean = title.replace(/\s+/g, ' ').trim();
    if (clean.length < 8) return null;
    await this.load();
    const key = `title:${normalizeTitle(clean)}`;
    const cached = this.cacheGet(key);
    if (cached !== undefined) return cached;
    const url = `https://api.crossref.org/works?rows=3&select=DOI,title,author,issued,container-title,volume,issue,page,abstract,subject,type,publisher,URL&query.bibliographic=${encodeURIComponent(clean)}${year ? `&filter=from-pub-date:${year - 1}-01-01,until-pub-date:${year + 1}-12-31` : ''}`;
    const json = (await this.fetchJson(url)) as { message?: { items?: Record<string, unknown>[] } } | null;
    const items = json?.message?.items ?? [];
    if (!items.length) {
      this.cacheSet(key, null);
      return null;
    }
    const best = items[0];
    const bestTitle = Array.isArray(best.title) ? String((best.title as string[])[0] ?? '') : '';
    const sim = similarity(normalizeTitle(clean), normalizeTitle(bestTitle));
    if (sim < 0.72) {
      this.cacheSet(key, null);
      return null;
    }
    const doi = typeof best.DOI === 'string' ? best.DOI : '';
    const full = doi ? await this.lookupDoi(doi) : null;
    if (full) {
      this.cacheSet(key, full);
      return full;
    }
    this.cacheSet(key, null);
    return null;
  }

  async close(): Promise<void> {
    await this.persist();
  }
}

/** 归一化标题相似度（0-1），用词集合的 Jaccard + 前缀加成 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  const jaccard = inter / (sa.size + sb.size - inter);
  const prefix = a.startsWith(b.slice(0, 24)) || b.startsWith(a.slice(0, 24)) ? 0.15 : 0;
  return Math.min(1, jaccard + prefix);
}

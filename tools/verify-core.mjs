var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/core/paths.ts
import path from "node:path";
function longPath(p) {
  if (!isWin) return p;
  if (p.startsWith("\\\\?\\")) return p;
  const abs = path.resolve(p);
  if (abs.length < 248) return abs;
  if (abs.startsWith("\\\\")) return `\\\\?\\UNC\\${abs.slice(2)}`;
  return `\\\\?\\${abs}`;
}
function toPosix(p) {
  return p.replace(/\\/g, "/");
}
function extOf(name) {
  const e = path.extname(name);
  return e ? e.slice(1).toLowerCase() : "";
}
function baseNameNoExt(name) {
  const e = path.extname(name);
  return e ? name.slice(0, -e.length) : name;
}
function relativize(rootPath, absPath) {
  const rel = path.relative(rootPath, absPath);
  const dir = path.dirname(rel);
  return {
    relPath: toPosix(rel),
    dir: dir === "." ? "" : toPosix(dir)
  };
}
function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "\u2014";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
function shortId(prefix = "") {
  let time = Date.now();
  let ts = "";
  for (let i = 0; i < 10; i += 1) {
    ts = ALPHABET[time % 32] + ts;
    time = Math.floor(time / 32);
  }
  let rand = "";
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) rand += ALPHABET[b % 32];
  return `${prefix}${ts}${rand}`;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length || 1))).fill(0).map(async () => {
    for (; ; ) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
var isWin, ALPHABET;
var init_paths = __esm({
  "src/core/paths.ts"() {
    "use strict";
    isWin = process.platform === "win32";
    ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  }
});

// src/core/zip.ts
import zlib from "node:zlib";
function parseZipEntries(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 66e3);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count && ptr + 46 <= buf.length; i += 1) {
    if (buf.readUInt32LE(ptr) !== CEN_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const size = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const offset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");
    entries.push({ name, size, compressedSize, method, offset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
function readZipEntry(buf, entry) {
  try {
    const at = entry.offset;
    if (buf.readUInt32LE(at) !== 67324752) return null;
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const start = at + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) return zlib.inflateRawSync(raw);
    return null;
  } catch {
    return null;
  }
}
var EOCD_SIG, CEN_SIG;
var init_zip = __esm({
  "src/core/zip.ts"() {
    "use strict";
    init_paths();
    EOCD_SIG = 101010256;
    CEN_SIG = 33639248;
  }
});

// src/core/epub.ts
var epub_exports = {};
__export(epub_exports, {
  extractEpub: () => extractEpub
});
import fs5 from "node:fs/promises";
import path7 from "node:path";
function resolveHref(base, href) {
  const joined = path7.posix.normalize(path7.posix.join(path7.posix.dirname(base), href));
  return joined.replace(/^\.\//, "");
}
function stripScripts(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/ on[a-z]+\s*=\s*"[^"]*"/gi, "").replace(/ on[a-z]+\s*=\s*'[^']*'/gi, "");
}
async function extractEpub(filePath) {
  try {
    const buf = await fs5.readFile(longPath(filePath));
    const entries = parseZipEntries(buf);
    if (!entries.length) return null;
    const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
    const readEntry = (name) => {
      const e = byName.get(name.toLowerCase());
      return e ? readZipEntry(buf, e) : null;
    };
    const containerRaw = readEntry("META-INF/container.xml");
    if (!containerRaw) return null;
    const opfPath = containerRaw.toString("utf8").match(/full-path="([^"]+)"/i)?.[1];
    if (!opfPath) return null;
    const opfRaw = readEntry(opfPath);
    if (!opfRaw) return null;
    const opf = opfRaw.toString("utf8");
    const title = opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1]?.trim() ?? "";
    const authors = [...opf.matchAll(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/gi)].map((m) => m[1].trim()).filter(Boolean);
    const language = opf.match(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i)?.[1]?.trim() ?? "";
    const identifier = opf.match(/<dc:identifier[^>]*>([\s\S]*?)<\/dc:identifier>/i)?.[1]?.trim() ?? "";
    const manifest = /* @__PURE__ */ new Map();
    for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
      const tag = m[0];
      const id = tag.match(/\bid="([^"]+)"/i)?.[1];
      const href = tag.match(/\bhref="([^"]+)"/i)?.[1];
      const type = tag.match(/\bmedia-type="([^"]+)"/i)?.[1] ?? "";
      if (id && href) manifest.set(id, { href, type });
    }
    const spineIds = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/gi)].map((m) => m[1]);
    const navTitles = /* @__PURE__ */ new Map();
    for (const navHref of ["toc.ncx", "nav.xhtml", "toc.xhtml"]) {
      const navEntry = entries.find((e) => e.name.toLowerCase().endsWith(navHref));
      if (!navEntry) continue;
      const raw = readZipEntry(buf, navEntry);
      if (!raw) continue;
      const text = raw.toString("utf8");
      for (const m of text.matchAll(/<navPoint[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?src="([^"#]+)/gi)) {
        navTitles.set(m[2].trim(), m[1].replace(/<[^>]+>/g, "").trim());
      }
      for (const m of text.matchAll(/<a\b[^>]*href="([^"#]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
        navTitles.set(m[1].trim(), m[2].replace(/<[^>]+>/g, "").trim());
      }
      break;
    }
    const chapters = [];
    for (const id of spineIds) {
      const item = manifest.get(id);
      if (!item) continue;
      if (!/xhtml|html|xml/i.test(item.type) && !/\.x?html?$/i.test(item.href)) continue;
      const raw = readEntry(item.href);
      if (!raw) continue;
      let html = stripScripts(raw.toString("utf8"));
      html = html.replace(/(src|href)="([^"]+)"/gi, (whole, attr, href) => {
        if (/^(https?:|data:|#)/i.test(href)) return whole;
        if (attr.toLowerCase() === "href" && /\.x?html?$/i.test(href)) return whole;
        const resolved = resolveHref(item.href, href);
        const data = readEntry(resolved);
        if (!data) return whole;
        const ext = path7.extname(resolved).slice(1).toLowerCase();
        const mime = MIME[ext];
        if (!mime) return whole;
        return `${attr}="data:${mime};base64,${data.toString("base64")}"`;
      });
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const body = bodyMatch ? bodyMatch[1] : html;
      chapters.push({
        id,
        href: item.href,
        title: navTitles.get(item.href) ?? navTitles.get(path7.posix.basename(item.href)) ?? `\u7B2C ${chapters.length + 1} \u8282`,
        html: body
      });
    }
    return { title, authors, language, identifier, chapters };
  } catch {
    return null;
  }
}
var MIME;
var init_epub = __esm({
  "src/core/epub.ts"() {
    "use strict";
    init_paths();
    init_zip();
    MIME = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      css: "text/css"
    };
  }
});

// tools/verify-core.ts
import fs9 from "node:fs/promises";
import path11 from "node:path";

// src/core/host.ts
import path9 from "node:path";
import fs7 from "node:fs/promises";

// src/shared/types.ts
var DEFAULT_SETTINGS = {
  theme: "system",
  density: "comfortable",
  listView: "list",
  groupBy: "none",
  sortKey: "added",
  sortDir: "desc",
  defaultZoom: "fit-width",
  readerLayout: "continuous",
  readerTheme: "light",
  readerAnimation: true,
  annotationColor: "yellow",
  fullTextIndex: "opened-only",
  thumbnails: true,
  concurrency: 4,
  onlineMetadata: true,
  autoMetadata: false,
  includeOtherFiles: false,
  reconcileIntervalMs: 5 * 60 * 1e3,
  minimizeToTray: true,
  showSampleData: false,
  sidebarWidth: 240,
  listWidth: 380,
  windowBounds: { width: 1440, height: 900 },
  lastOpenedItemId: null,
  lastView: "library",
  onboardingDone: false
};
var KIND_BY_EXT = {
  pdf: "pdf",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  txt: "text",
  text: "text",
  log: "text",
  html: "html",
  htm: "html",
  xhtml: "html",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  bmp: "image",
  tif: "image",
  tiff: "image",
  avif: "image",
  docx: "docx",
  epub: "epub"
};
var READABLE_KINDS = ["pdf", "markdown", "text", "html", "image", "docx", "epub"];
function kindOf(ext) {
  return KIND_BY_EXT[ext.replace(/^\./, "").toLowerCase()] ?? "other";
}
function isReadable(kind) {
  return READABLE_KINDS.includes(kind);
}

// src/core/library.ts
import fsSync from "node:fs";
import path4 from "node:path";

// src/core/store.ts
init_paths();
import fs from "node:fs/promises";
import fssync from "node:fs";
import path2 from "node:path";
async function ensureDir(dir) {
  await fs.mkdir(longPath(dir), { recursive: true });
}
async function writeFileAtomic(file, content) {
  const target = longPath(file);
  await ensureDir(path2.dirname(file));
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync().catch(() => void 0);
  } finally {
    await handle.close();
  }
  try {
    await fs.copyFile(target, `${target}.bak`);
  } catch {
  }
  await fs.rename(tmp, target);
}
var JsonFile = class {
  opts;
  value;
  dirty = false;
  timer = null;
  writing = null;
  loaded = false;
  /** 读取时是否发生了损坏回滚 */
  recovered = false;
  constructor(opts) {
    this.opts = opts;
    this.value = opts.defaults();
  }
  get() {
    return this.value;
  }
  async load() {
    const file = longPath(this.opts.file);
    const tryRead = async (f) => {
      try {
        const text = await fs.readFile(f, "utf8");
        if (!text.trim()) return void 0;
        return JSON.parse(text);
      } catch {
        return void 0;
      }
    };
    let raw = await tryRead(file);
    if (raw === void 0) {
      const bak = await tryRead(`${file}.bak`);
      if (bak !== void 0) {
        raw = bak;
        this.recovered = true;
        try {
          await fs.rename(file, `${file}.corrupt-${Date.now()}`);
        } catch {
        }
      }
    }
    if (raw !== void 0 && this.opts.revive) {
      const revived = this.opts.revive(raw);
      if (revived) {
        this.value = revived;
        this.loaded = true;
        return this.value;
      }
    }
    if (raw !== void 0 && !this.opts.revive && raw && typeof raw === "object") {
      this.value = raw;
      this.loaded = true;
      return this.value;
    }
    this.value = this.opts.defaults();
    this.loaded = true;
    return this.value;
  }
  set(next) {
    this.value = next;
    this.dirty = true;
    this.schedule();
  }
  /** 就地修改并安排落盘 */
  mutate(fn) {
    fn(this.value);
    this.dirty = true;
    this.schedule();
    return this.value;
  }
  schedule() {
    const ms = this.opts.debounceMs ?? 800;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, ms);
    this.timer.unref?.();
  }
  async flush() {
    if (!this.dirty) return;
    if (this.writing) {
      await this.writing;
      if (!this.dirty) return;
    }
    this.dirty = false;
    const snapshot = JSON.stringify(this.value, null, this.opts.pretty ? 2 : 0);
    this.writing = writeFileAtomic(this.opts.file, snapshot).catch((err) => {
      this.dirty = true;
      console.error("[litshelf] \u843D\u76D8\u5931\u8D25", this.opts.file, err);
    }).finally(() => {
      this.writing = null;
    });
    await this.writing;
  }
  async flushNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
    if (this.writing) await this.writing;
  }
  isLoaded() {
    return this.loaded;
  }
};
var Journal = class {
  constructor(file, maxEntries = 200) {
    this.maxEntries = maxEntries;
    this.file = file;
  }
  maxEntries;
  file;
  queue = [];
  writing = false;
  append(action, detail) {
    this.queue.push({ at: Date.now(), action, detail });
    if (this.queue.length > this.maxEntries) this.queue.splice(0, this.queue.length - this.maxEntries);
    void this.drain();
  }
  async drain() {
    if (this.writing || this.queue.length === 0) return;
    this.writing = true;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await ensureDir(path2.dirname(this.file));
      await fs.appendFile(longPath(this.file), batch.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      await this.trim();
    } catch {
    } finally {
      this.writing = false;
      if (this.queue.length) void this.drain();
    }
  }
  async trim() {
    try {
      const stat = await fs.stat(longPath(this.file));
      if (stat.size < 512 * 1024) return;
      const text = await fs.readFile(longPath(this.file), "utf8");
      const lines = text.split("\n").filter(Boolean).slice(-this.maxEntries);
      await writeFileAtomic(this.file, lines.join("\n") + "\n");
    } catch {
    }
  }
  tailSync(limit = 50) {
    try {
      const text = fssync.readFileSync(longPath(this.file), "utf8");
      return text.split("\n").filter(Boolean).slice(-limit).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { at: 0, action: "unparsable" };
        }
      });
    } catch {
      return [];
    }
  }
};

// src/core/library.ts
init_paths();

// src/core/naming.ts
var DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+)/;
var ARXIV_RE = /\b(?:arxiv[:\s_-]*)?(\d{4}\.\d{4,5})(?:v\d+)?\b/i;
var YEAR_RE = /(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/;
var SPLIT_RE = /\s*(?:--|—|–|\s-\s|_|\||;|｜)\s*/;
var TAG_RE = /(?:^|\s)#([\p{L}\p{N}_\-/]{1,24})/gu;
function clean(s) {
  return s.replace(/\s+/g, " ").replace(/^[\s._\-–—]+|[\s._\-–—]+$/g, "").trim();
}
function stripLeadingOrdinal(s) {
  return s.replace(/^\s*(?:\[?\d{1,3}\]?[.)、]?(?!\d)|第?\d{1,3}[章节篇][\s:：-]*)\s*/, "");
}
function looksLikeAuthor(token) {
  const t = token.trim();
  if (!t) return false;
  if (t.length > 34) return false;
  if (/^(et al\.?|等|and|&|\/)$/i.test(t)) return true;
  if (/\bet al\.?$/i.test(t)) return true;
  if (/^[\p{Script=Han}]{2,4}(?:[、,，]\s*[\p{Script=Han}]{2,4})*$/u.test(t)) return true;
  if (/^[A-Z][\p{L}'`-]+(?:\s*,\s*(?:[A-Z]\.\s*)+)?$/u.test(t)) return true;
  if (/^(?:[A-Z]\.\s*)+[A-Z][\p{L}'`-]+$/u.test(t)) return true;
  if (/^[A-Z][\p{L}'`-]+(?:\s+[A-Z][\p{L}'`-]+){0,3}$/u.test(t) && t.split(/\s+/).length <= 4) return true;
  return false;
}
function splitAuthors(raw) {
  return raw.split(/\s*(?:,|;|、|，|&|\band\b|和|与)\s*/i).map((s) => clean(s)).filter((s) => s && !/^(et al\.?|等)$/i.test(s)).slice(0, 24);
}
function guessFromFileName(fileName) {
  const withoutExt = fileName.replace(/\.[A-Za-z0-9]{1,6}$/, "");
  const tags = [];
  let working = withoutExt;
  for (const m of withoutExt.matchAll(TAG_RE)) {
    tags.push(m[1]);
    working = working.replace(m[0], " ");
  }
  working = clean(working);
  let doi = "";
  let arxivId = "";
  const doiMatch = working.match(DOI_RE);
  if (doiMatch) {
    doi = doiMatch[1];
    working = clean(working.replace(doiMatch[0], " "));
  }
  const arxivMatch = working.match(ARXIV_RE);
  if (arxivMatch) {
    arxivId = arxivMatch[1];
    working = clean(working.replace(arxivMatch[0], " "));
  }
  const base = stripLeadingOrdinal(working);
  const tokens = base.split(SPLIT_RE).map(clean).filter(Boolean);
  let year = null;
  const yearMatch = base.match(YEAR_RE);
  if (yearMatch) year = Number(yearMatch[1]);
  let authors = [];
  let title = "";
  let structured = false;
  if (tokens.length >= 3 && /^(?:19|20)\d{2}$/.test(tokens[1])) {
    authors = splitAuthors(tokens[0]);
    title = clean(tokens.slice(2).join(" "));
    structured = authors.length > 0;
  } else if (tokens.length >= 3 && /^(?:19|20)\d{2}$/.test(tokens[0])) {
    year = Number(tokens[0]);
    authors = splitAuthors(tokens[1]);
    title = clean(tokens.slice(2).join(" "));
    structured = authors.length > 0;
  } else {
    const parenYear = base.match(/[（(]\s*((?:19|20)\d{2})\s*[)）]/);
    if (parenYear && tokens.length >= 2) {
      year = Number(parenYear[1]);
      const before = clean(base.slice(0, parenYear.index ?? 0));
      const after = clean(base.slice((parenYear.index ?? 0) + parenYear[0].length));
      const candidates = [before, after].filter(Boolean);
      const authorIdx = candidates.findIndex((c) => looksLikeAuthor(c) && c.split(/\s+/).length <= 5);
      if (authorIdx >= 0) {
        authors = splitAuthors(candidates[authorIdx]);
        title = clean(candidates.filter((_, i) => i !== authorIdx).join(" ") || candidates[authorIdx]);
        structured = true;
      } else {
        title = clean(candidates.join(" "));
      }
    } else if (tokens.length >= 2 && looksLikeAuthor(tokens[0]) && tokens[0].length < 30 && !/^\d/.test(tokens[0])) {
      authors = splitAuthors(tokens[0]);
      title = clean(tokens.slice(1).join(" "));
    } else {
      title = base;
    }
  }
  if (!title) title = base || withoutExt;
  title = clean(title.replace(/[_]+/g, " "));
  if (year) {
    title = clean(title.replace(new RegExp(`^[\uFF08(]?${year}[)\uFF09]?\\s*`), ""));
    title = clean(title.replace(new RegExp(`\\s*[\uFF08(]?${year}[)\uFF09]?$`), ""));
  }
  if (!title) title = base || withoutExt;
  return { title, authors, year, doi, arxivId, tags, structured };
}
function titleQuality(title) {
  if (!title) return 0;
  const t = title.trim();
  if (t.length < 4) return 1;
  if (/^(untitled|microsoft word|document\d*|扫描|新建|无标题|pdf|adobe|print)$/i.test(t)) return 0;
  if (/\.(pdf|docx?|indd)$/i.test(t)) return 1;
  if (/^(?:第?\d+[章节篇]|slide|page)(?![\p{L}\p{N}])/iu.test(t)) return 2;
  if (/^[A-Za-z0-9\s.,;:'"()\-_]+$/.test(t) && t.split(/\s+/).length <= 2 && t.length < 12) return 3;
  return 5;
}
function sanitizeTitle(raw) {
  if (!raw) return "";
  let t = raw.replace(/\s+/g, " ").trim();
  t = t.replace(/\.(pdf|docx?|tex|dvi)$/i, "");
  t = t.replace(/^(?:Microsoft Word|untitled|document)\s*[-–—]?\s*/i, "");
  t = t.replace(/\s*[-–—]\s*(?:Microsoft Word|LaTeX|Acrobat.*)$/i, "");
  return t.trim();
}

// src/core/fsutil.ts
init_paths();
import fs2 from "node:fs/promises";
import path3 from "node:path";
async function ensureDir2(dir) {
  await fs2.mkdir(longPath(dir), { recursive: true });
}
async function exists(p) {
  try {
    await fs2.access(longPath(p));
    return true;
  } catch {
    return false;
  }
}
async function statSafe(p) {
  try {
    const s = await fs2.stat(longPath(p));
    return { size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs, isFile: s.isFile(), isDir: s.isDirectory() };
  } catch {
    return null;
  }
}
async function writeFileAtomicSafe(file, content) {
  const target = longPath(file);
  await ensureDir2(path3.dirname(file));
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const handle = await fs2.open(tmp, "w");
  try {
    await handle.writeFile(content);
    await handle.sync().catch(() => void 0);
  } finally {
    await handle.close();
  }
  await fs2.rename(tmp, target);
}
async function readJsonSafe(file) {
  try {
    const text = await fs2.readFile(longPath(file), "utf8");
    if (!text.trim()) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
async function rmSafe(target, recursive = false) {
  try {
    await fs2.rm(longPath(target), { recursive, force: true });
  } catch {
  }
}
async function listDirSafe(dir) {
  try {
    const entries = await fs2.readdir(longPath(dir), { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      let size = 0;
      let mtime = 0;
      if (e.isFile()) {
        const s = await statSafe(path3.join(dir, e.name));
        size = s?.size ?? 0;
        mtime = s?.mtime ?? 0;
      }
      out.push({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile(), size, mtime });
    }
    return out;
  } catch {
    return [];
  }
}

// src/core/library.ts
function emptyProgress() {
  return { page: 1, total: 0, percent: 0, scrollTop: 0, zoom: 1, updatedAt: 0 };
}
var LIB_VERSION = 1;
function pathExistsSync(p) {
  try {
    fsSync.statSync(longPath(p));
    return true;
  } catch {
    return false;
  }
}
var Library = class {
  file;
  byId = /* @__PURE__ */ new Map();
  byPath = /* @__PURE__ */ new Map();
  byFingerprint = /* @__PURE__ */ new Map();
  roots = [];
  settings = { ...DEFAULT_SETTINGS };
  collections = [];
  constructor(dataFile) {
    this.file = new JsonFile({
      file: dataFile,
      defaults: () => ({
        version: LIB_VERSION,
        items: [],
        roots: [],
        settings: { ...DEFAULT_SETTINGS },
        collections: [],
        savedAt: Date.now()
      }),
      revive: (raw) => {
        const data = raw;
        if (!data || typeof data !== "object" || !Array.isArray(data.items)) return null;
        return {
          version: typeof data.version === "number" ? data.version : LIB_VERSION,
          items: data.items,
          roots: Array.isArray(data.roots) ? data.roots : [],
          settings: { ...DEFAULT_SETTINGS, ...data.settings },
          collections: Array.isArray(data.collections) ? data.collections : [],
          savedAt: typeof data.savedAt === "number" ? data.savedAt : Date.now()
        };
      },
      debounceMs: 800
    });
  }
  async load() {
    const data = await this.file.load();
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    this.roots = data.roots.map((r) => ({ ...r }));
    this.collections = data.collections;
    for (const item of data.items) {
      const normalized = normalizeItem(item);
      this.byId.set(normalized.id, normalized);
      this.byPath.set(normalized.path.toLowerCase(), normalized.id);
      if (normalized.fingerprint) this.addFingerprint(normalized.fingerprint, normalized.id);
    }
  }
  // ---------------------------------------------------------------- 读
  all() {
    return [...this.byId.values()];
  }
  size() {
    return this.byId.size;
  }
  get(id) {
    return this.byId.get(id) ?? null;
  }
  getByPath(p) {
    const id = this.byPath.get(p.toLowerCase());
    return id ? this.byId.get(id) ?? null : null;
  }
  getRoots() {
    return this.roots.map((r) => ({ ...r }));
  }
  getRoot(id) {
    const r = this.roots.find((x) => x.id === id);
    return r ? { ...r } : null;
  }
  getSettings() {
    return { ...this.settings };
  }
  getCollections() {
    return this.collections.map((c) => ({ ...c }));
  }
  tags() {
    const tags = /* @__PURE__ */ new Set();
    for (const item of this.byId.values()) for (const t of item.tags) tags.add(t);
    return [...tags].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }
  snapshotBase() {
    return { items: this.all(), roots: this.getRoots(), settings: this.getSettings(), tags: this.tags() };
  }
  // ---------------------------------------------------------------- 根目录
  addRoot(dirPath, opts = {}) {
    const abs = path4.resolve(dirPath);
    const existing = this.roots.find((r) => r.path.toLowerCase() === abs.toLowerCase());
    if (existing) return { ...existing };
    const root = {
      id: shortId("rt_"),
      path: abs,
      name: opts.name?.trim() || path4.basename(abs) || abs,
      enabled: true,
      depth: opts.depth ?? 8,
      addedAt: Date.now(),
      lastScanAt: null,
      available: true,
      itemCount: 0
    };
    this.roots.push(root);
    this.persist();
    return { ...root };
  }
  removeRoot(rootId, opts = {}) {
    const exists2 = this.roots.some((r) => r.id === rootId);
    if (!exists2) return [];
    this.roots = this.roots.filter((r) => r.id !== rootId);
    const removed = [];
    if (opts.forgetItems) {
      for (const item of [...this.byId.values()]) {
        if (item.rootId === rootId) {
          this.dropItem(item.id);
          removed.push(item.id);
        }
      }
    }
    this.persist();
    return removed;
  }
  setRootEnabled(rootId, enabled) {
    const root = this.roots.find((r) => r.id === rootId);
    if (!root) return;
    root.enabled = enabled;
    this.persist();
  }
  /** 只在根目录还没有任何条目时使用：把 8.3 短路径换成长路径 */
  setRootPath(rootId, nextPath) {
    const root = this.roots.find((r) => r.id === rootId);
    if (!root) return;
    root.path = path4.resolve(nextPath);
    root.name = path4.basename(root.path) || root.name;
    this.persist();
  }
  setRootAvailable(rootId, available) {
    const root = this.roots.find((r) => r.id === rootId);
    if (!root || root.available === available) return;
    root.available = available;
    this.persist();
  }
  markRootScanned(rootId, itemCount) {
    const root = this.roots.find((r) => r.id === rootId);
    if (!root) return;
    root.lastScanAt = Date.now();
    root.itemCount = itemCount;
    this.persist();
  }
  /** 找出某条路径属于哪个根目录（取最长的匹配前缀） */
  rootForPath(absPath) {
    const lower = absPath.toLowerCase();
    let best = null;
    for (const root of this.roots) {
      const rp = root.path.toLowerCase();
      if (lower === rp || lower.startsWith(rp.endsWith(path4.sep) ? rp : rp + path4.sep)) {
        if (!best || root.path.length > best.path.length) best = root;
      }
    }
    return best ? { ...best } : null;
  }
  // ---------------------------------------------------------------- 对账
  /** 在一次"完整扫描"之后与库对账；entries 需自带指纹 */
  reconcileRoot(rootId, entries) {
    const result = { added: [], updated: [], renamed: [], revived: [], missing: [] };
    const root = this.roots.find((r) => r.id === rootId);
    if (!root) return result;
    const seen = /* @__PURE__ */ new Set();
    const existingOfRoot = /* @__PURE__ */ new Map();
    for (const item of this.byId.values()) {
      if (item.rootId === rootId) existingOfRoot.set(item.path.toLowerCase(), item);
    }
    const claimed = /* @__PURE__ */ new Set();
    for (const entry of entries) {
      const key = entry.path.toLowerCase();
      seen.add(key);
      const current = existingOfRoot.get(key);
      if (current) {
        const contentChanged = current.fingerprint !== entry.fingerprint;
        const metaChanged = current.size !== entry.size || Math.abs(current.mtime - entry.mtime) > 2;
        if (contentChanged || metaChanged) {
          this.apply(current.id, {
            size: entry.size,
            mtime: entry.mtime,
            ctime: entry.ctime,
            fingerprint: entry.fingerprint,
            revision: current.revision + 1,
            parseState: "placeholder",
            textIndexed: false,
            thumb: null,
            missing: false,
            missingSince: null
          });
          result.updated.push(this.byId.get(current.id));
        } else if (current.missing) {
          this.apply(current.id, { missing: false, missingSince: null });
          result.revived.push(this.byId.get(current.id));
        }
        claimed.add(current.id);
        continue;
      }
      const renamedFrom = this.findRenameCandidate(entry.fingerprint, rootId, key, claimed);
      if (renamedFrom) {
        const from = renamedFrom.path;
        const wasMissing = renamedFrom.missing;
        this.rebindPath(renamedFrom.id, entry, rootId);
        claimed.add(renamedFrom.id);
        const item2 = this.byId.get(renamedFrom.id);
        result.renamed.push({ item: item2, from });
        if (wasMissing) result.revived.push(item2);
        continue;
      }
      const item = this.createItem(rootId, entry);
      result.added.push(item);
      claimed.add(item.id);
    }
    for (const [lowerPath, item] of existingOfRoot) {
      if (seen.has(lowerPath) || claimed.has(item.id) || item.missing) continue;
      this.apply(item.id, { missing: true, missingSince: Date.now() });
      result.missing.push(this.byId.get(item.id));
    }
    root.itemCount = [...this.byId.values()].filter((i) => i.rootId === rootId).length;
    this.persist();
    return result;
  }
  /** 单个文件事件：新增 / 改动 / 改名 / 复活（不扫描整个根目录，O(1)） */
  reconcileEntry(rootId, entry) {
    const key = entry.path.toLowerCase();
    const current = this.getByPath(entry.path);
    if (current) {
      const contentChanged = current.fingerprint !== entry.fingerprint;
      const metaChanged = current.size !== entry.size || Math.abs(current.mtime - entry.mtime) > 2;
      if (!contentChanged && !metaChanged) {
        if (current.missing) {
          this.apply(current.id, { missing: false, missingSince: null });
          return { item: this.byId.get(current.id), change: "revived" };
        }
        return { item: current, change: "unchanged" };
      }
      this.apply(current.id, {
        size: entry.size,
        mtime: entry.mtime,
        ctime: entry.ctime,
        fingerprint: entry.fingerprint,
        revision: current.revision + 1,
        parseState: "placeholder",
        textIndexed: false,
        thumb: null,
        missing: false,
        missingSince: null
      });
      return { item: this.byId.get(current.id), change: "updated" };
    }
    const renamedFrom = this.findRenameCandidate(entry.fingerprint, rootId, key, /* @__PURE__ */ new Set());
    if (renamedFrom) {
      const from = renamedFrom.path;
      const wasMissing = renamedFrom.missing;
      this.rebindPath(renamedFrom.id, entry, rootId);
      const item2 = this.byId.get(renamedFrom.id);
      this.persist();
      return { item: item2, change: wasMissing ? "revived" : "renamed", from };
    }
    const item = this.createItem(rootId, entry);
    this.persist();
    return { item, change: "added" };
  }
  /**
   * 改名识别：指纹相同、路径不同，且"旧路径此刻确实不存在"（或在库里已标记缺失）。
   * 这条"旧路径不存在"的判定很关键——否则把文件复制一份会被误判成移动。
   */
  findRenameCandidate(fingerprint, rootId, newPathLower, claimed) {
    if (!fingerprint) return null;
    const ids = this.byFingerprint.get(fingerprint);
    if (!ids || !ids.size) return null;
    for (const id of ids) {
      const candidate = this.byId.get(id);
      if (!candidate || claimed.has(id)) continue;
      if (candidate.path.toLowerCase() === newPathLower) continue;
      if (candidate.missing || !pathExistsSync(candidate.path)) return candidate;
    }
    return null;
  }
  /** 标记路径已消失（是否真的删除由上层延迟二次确认） */
  markMissingByPath(absPath) {
    const item = this.getByPath(absPath);
    if (!item || item.missing) return null;
    this.apply(item.id, { missing: true, missingSince: Date.now() });
    this.persist();
    return this.byId.get(item.id);
  }
  /** 文件缺失后手动重新定位到新路径 */
  async rebindItem(itemId, newPath) {
    const item = this.byId.get(itemId);
    if (!item) return null;
    const stat = await statSafe(newPath);
    if (!stat?.isFile) return null;
    const root = this.rootForPath(newPath) ?? this.getRoot(item.rootId);
    if (!root) return null;
    const { relPath, dir } = relativize(root.path, newPath);
    const name = path4.basename(newPath);
    const ext = extOf(name);
    const kind = kindOf(ext);
    this.byPath.delete(item.path.toLowerCase());
    this.apply(itemId, {
      rootId: root.id,
      path: path4.resolve(newPath),
      relPath,
      dir,
      name,
      ext,
      kind,
      readable: isReadable(kind),
      size: stat.size,
      mtime: stat.mtime,
      ctime: stat.ctime,
      missing: false,
      missingSince: null,
      revision: item.revision + 1,
      parseState: "placeholder",
      textIndexed: false
    });
    const next = this.byId.get(itemId);
    this.byPath.set(next.path.toLowerCase(), next.id);
    this.persist();
    return next;
  }
  rebindPath(itemId, entry, rootId) {
    const item = this.byId.get(itemId);
    if (!item) return;
    this.byPath.delete(item.path.toLowerCase());
    this.apply(
      itemId,
      {
        rootId,
        path: entry.path,
        relPath: entry.relPath,
        dir: entry.dir,
        name: entry.name,
        ext: entry.ext,
        kind: entry.kind,
        readable: isReadable(entry.kind),
        size: entry.size,
        mtime: entry.mtime,
        ctime: entry.ctime,
        fingerprint: entry.fingerprint,
        missing: false,
        missingSince: null,
        collections: entry.dir ? [entry.dir] : [],
        ...item.userEdited.includes("title") ? {} : { title: pickTitleFromName(entry.name, item) }
      }
    );
    const next = this.byId.get(itemId);
    this.byPath.set(next.path.toLowerCase(), next.id);
  }
  createItem(rootId, entry) {
    const guess = guessFromFileName(entry.name);
    const item = {
      id: shortId("it_"),
      rootId,
      path: entry.path,
      relPath: entry.relPath,
      dir: entry.dir,
      name: entry.name,
      ext: entry.ext,
      kind: entry.kind,
      readable: isReadable(entry.kind),
      size: entry.size,
      mtime: entry.mtime,
      ctime: entry.ctime,
      fingerprint: entry.fingerprint,
      title: guess.title || baseNameNoExt(entry.name),
      authors: guess.authors,
      year: guess.year,
      venue: "",
      volume: "",
      issue: "",
      pages: "",
      doi: guess.doi,
      arxivId: guess.arxivId,
      url: guess.doi ? `https://doi.org/${guess.doi}` : guess.arxivId ? `https://arxiv.org/abs/${guess.arxivId}` : "",
      abstract: "",
      keywords: [],
      language: "",
      pageCount: 0,
      wordCount: 0,
      excerpt: "",
      tags: [...new Set(guess.tags)],
      collections: entry.dir ? [entry.dir] : [],
      colorTag: "",
      starred: false,
      readState: "unread",
      progress: emptyProgress(),
      note: "",
      annotationCount: 0,
      userEdited: [],
      missing: false,
      missingSince: null,
      addedAt: Date.now(),
      lastOpenedAt: null,
      openCount: 0,
      thumb: null,
      parseState: "placeholder",
      textIndexed: false,
      revision: 1
    };
    this.byId.set(item.id, item);
    this.byPath.set(item.path.toLowerCase(), item.id);
    if (item.fingerprint) this.addFingerprint(item.fingerprint, item.id);
    return item;
  }
  addFingerprint(fp, id) {
    let set = this.byFingerprint.get(fp);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.byFingerprint.set(fp, set);
    }
    set.add(id);
  }
  dropItem(id) {
    const item = this.byId.get(id);
    if (!item) return;
    this.byId.delete(id);
    this.byPath.delete(item.path.toLowerCase());
    if (item.fingerprint) {
      const set = this.byFingerprint.get(item.fingerprint);
      set?.delete(id);
      if (set && !set.size) this.byFingerprint.delete(item.fingerprint);
    }
  }
  // ---------------------------------------------------------------- 写
  persist() {
    this.file.set({
      version: LIB_VERSION,
      items: [...this.byId.values()],
      roots: this.roots,
      settings: this.settings,
      collections: this.collections,
      savedAt: Date.now()
    });
  }
  async flush() {
    this.persist();
    await this.file.flushNow();
  }
  /** 内部：改内存并维护索引，不落盘（批量时由调用方统一 persist） */
  apply(id, patch) {
    const item = this.byId.get(id);
    if (!item) return null;
    const pathChanged = patch.path !== void 0 && patch.path.toLowerCase() !== item.path.toLowerCase();
    if (pathChanged) this.byPath.delete(item.path.toLowerCase());
    const fpChanged = patch.fingerprint !== void 0 && patch.fingerprint !== item.fingerprint;
    if (fpChanged && item.fingerprint) {
      const set = this.byFingerprint.get(item.fingerprint);
      set?.delete(id);
      if (set && !set.size) this.byFingerprint.delete(item.fingerprint);
    }
    Object.assign(item, patch);
    if (pathChanged && item.path) this.byPath.set(item.path.toLowerCase(), id);
    if (fpChanged && item.fingerprint) this.addFingerprint(item.fingerprint, id);
    return item;
  }
  patchItem(id, patch) {
    const item = this.apply(id, patch);
    if (item) this.persist();
    return item;
  }
  patchItems(ids, patch) {
    const out = [];
    for (const id of ids) {
      const item = this.apply(id, patch);
      if (item) out.push(item);
    }
    if (out.length) this.persist();
    return out;
  }
  /** 用户手工编辑：记录到 userEdited，扫描/联网补全都不再覆盖这些字段 */
  editItem(id, patch, userFields = []) {
    const item = this.byId.get(id);
    if (!item) return null;
    const merged = [.../* @__PURE__ */ new Set([...item.userEdited, ...userFields.map(String)])];
    return this.patchItem(id, { ...patch, userEdited: merged });
  }
  /** 写入扫描得到的元数据：不覆盖用户手改过的字段，也不用空值抹掉已有信息 */
  applyMetadata(id, meta) {
    const item = this.byId.get(id);
    if (!item) return null;
    const patch = {};
    const applied = [];
    for (const [key, value] of Object.entries(meta)) {
      if (value === void 0 || value === null) continue;
      if (item.userEdited.includes(key)) continue;
      if (typeof value === "string" && value.trim() === "") {
        const existing = item[key];
        if (typeof existing === "string" && existing.trim() !== "") continue;
      }
      if (Array.isArray(value) && value.length === 0) {
        const existing = item[key];
        if (Array.isArray(existing) && existing.length > 0) continue;
      }
      patch[key] = value;
      applied.push(key);
    }
    if (!Object.keys(patch).length) return { item, applied };
    this.patchItem(id, patch);
    return { item: this.byId.get(id), applied };
  }
  deleteItem(id) {
    this.dropItem(id);
    this.persist();
  }
  /** 撤销删除时把条目整条放回来（保留原 id，批注才能重新挂上） */
  restoreItem(raw) {
    const item = normalizeItem(raw);
    this.byId.set(item.id, item);
    this.byPath.set(item.path.toLowerCase(), item.id);
    if (item.fingerprint) this.addFingerprint(item.fingerprint, item.id);
    this.persist();
    return item;
  }
  updateSettings(patch) {
    this.settings = {
      ...this.settings,
      ...patch,
      windowBounds: { ...this.settings.windowBounds, ...patch.windowBounds ?? {} }
    };
    this.persist();
    return this.getSettings();
  }
  setCollections(collections) {
    this.collections = collections;
    this.persist();
  }
};
function normalizeItem(raw) {
  const ext = raw.ext || extOf(raw.name ?? "");
  const kind = raw.kind || kindOf(ext);
  return {
    ...raw,
    ext,
    kind,
    readable: raw.readable ?? isReadable(kind),
    authors: Array.isArray(raw.authors) ? raw.authors : [],
    keywords: Array.isArray(raw.keywords) ? raw.keywords : [],
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    collections: Array.isArray(raw.collections) ? raw.collections : [],
    userEdited: Array.isArray(raw.userEdited) ? raw.userEdited : [],
    progress: { ...emptyProgress(), ...raw.progress ?? {} },
    note: raw.note ?? "",
    annotationCount: raw.annotationCount ?? 0,
    excerpt: raw.excerpt ?? "",
    parseState: raw.parseState ?? "placeholder",
    revision: raw.revision ?? 1,
    textIndexed: raw.textIndexed ?? false,
    openCount: raw.openCount ?? 0,
    lastOpenedAt: raw.lastOpenedAt ?? null,
    missing: raw.missing ?? false,
    missingSince: raw.missingSince ?? null,
    starred: raw.starred ?? false,
    readState: raw.readState ?? "unread",
    thumb: raw.thumb ?? null,
    year: raw.year ?? null
  };
}
function pickTitleFromName(name, item) {
  const guess = guessFromFileName(name);
  const pdfTitle = item.title && titleQuality(item.title) >= 5 ? sanitizeTitle(item.title) : "";
  if (pdfTitle && guess.structured) return pdfTitle;
  return guess.title || baseNameNoExt(name);
}

// src/core/annotations.ts
init_paths();
var AnnotationStore = class {
  file;
  byItem = /* @__PURE__ */ new Map();
  byId = /* @__PURE__ */ new Map();
  dirtyCounts = /* @__PURE__ */ new Set();
  constructor(dataFile) {
    this.file = new JsonFile({
      file: dataFile,
      defaults: () => ({ version: 1, byItem: {}, savedAt: Date.now() }),
      revive: (raw) => {
        const data = raw;
        if (!data || typeof data !== "object" || typeof data.byItem !== "object" || data.byItem === null) return null;
        return { version: 1, byItem: data.byItem, savedAt: data.savedAt ?? Date.now() };
      },
      debounceMs: 600
    });
  }
  async load() {
    const data = await this.file.load();
    this.byItem.clear();
    this.byId.clear();
    for (const [itemId, list] of Object.entries(data.byItem)) {
      const clean2 = (Array.isArray(list) ? list : []).map((a) => normalizeAnnotation(a, itemId));
      this.byItem.set(itemId, clean2);
      for (const a of clean2) this.byId.set(a.id, itemId);
    }
  }
  list(itemId) {
    return (this.byItem.get(itemId) ?? []).map((a) => ({ ...a }));
  }
  all() {
    const out = [];
    for (const list of this.byItem.values()) for (const a of list) out.push({ ...a });
    return out;
  }
  count(itemId) {
    return this.byItem.get(itemId)?.length ?? 0;
  }
  counts() {
    const map = /* @__PURE__ */ new Map();
    for (const [itemId, list] of this.byItem) if (list.length) map.set(itemId, list.length);
    return map;
  }
  get(id) {
    const itemId = this.byId.get(id);
    if (!itemId) return null;
    const found = this.byItem.get(itemId)?.find((a) => a.id === id);
    return found ? { ...found } : null;
  }
  add(input) {
    const now = Date.now();
    const annotation = {
      ...input,
      id: input.id ?? shortId("an_"),
      reanchored: false,
      needsReview: false,
      createdAt: now,
      updatedAt: now
    };
    const list = this.byItem.get(annotation.itemId) ?? [];
    list.push(annotation);
    list.sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
    this.byItem.set(annotation.itemId, list);
    this.byId.set(annotation.id, annotation.itemId);
    this.dirtyCounts.add(annotation.itemId);
    this.persist();
    return { ...annotation };
  }
  update(id, patch) {
    const itemId = this.byId.get(id);
    if (!itemId) return null;
    const list = this.byItem.get(itemId) ?? [];
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) return null;
    const next = { ...list[idx], ...patch, id, itemId, updatedAt: Date.now() };
    list[idx] = next;
    list.sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
    this.dirtyCounts.add(itemId);
    this.persist();
    return { ...next };
  }
  /** 批量替换某条目的批注（重定位后回写） */
  replaceForItem(itemId, list) {
    const clean2 = list.map((a) => ({ ...a, itemId }));
    this.byItem.set(itemId, clean2);
    for (const a of clean2) this.byId.set(a.id, itemId);
    this.dirtyCounts.add(itemId);
    this.persist();
  }
  remove(id) {
    const itemId = this.byId.get(id);
    if (!itemId) return null;
    const list = this.byItem.get(itemId) ?? [];
    const next = list.filter((a) => a.id !== id);
    if (next.length) this.byItem.set(itemId, next);
    else this.byItem.delete(itemId);
    this.byId.delete(id);
    this.dirtyCounts.add(itemId);
    this.persist();
    return itemId;
  }
  removeForItem(itemId) {
    const list = this.byItem.get(itemId) ?? [];
    for (const a of list) this.byId.delete(a.id);
    this.byItem.delete(itemId);
    this.dirtyCounts.add(itemId);
    this.persist();
  }
  takeDirtyCounts() {
    const out = [...this.dirtyCounts];
    this.dirtyCounts.clear();
    return out;
  }
  persist() {
    this.file.set({ version: 1, byItem: Object.fromEntries(this.byItem), savedAt: Date.now() });
  }
  async flush() {
    this.persist();
    await this.file.flushNow();
  }
};
function normalizeAnnotation(raw, itemId) {
  return {
    ...raw,
    itemId: raw.itemId ?? itemId,
    rects: Array.isArray(raw.rects) ? raw.rects : [],
    anchor: raw.anchor ?? { prefix: "", suffix: "", occurrence: 1 },
    comment: raw.comment ?? "",
    color: raw.color ?? "yellow",
    text: raw.text ?? "",
    page: raw.page ?? 1,
    reanchored: raw.reanchored ?? false,
    needsReview: raw.needsReview ?? false,
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now()
  };
}

// src/core/textindex.ts
import path5 from "node:path";
var TextIndex = class {
  dir;
  mem = /* @__PURE__ */ new Map();
  memChars = 0;
  maxMemChars;
  maxMemItems;
  constructor(cacheDir, opts = {}) {
    this.dir = path5.join(cacheDir, "text");
    this.maxMemChars = opts.maxMemChars ?? 96 * 1024 * 1024;
    this.maxMemItems = opts.maxMemItems ?? 400;
  }
  fileFor(itemId) {
    return path5.join(this.dir, `${itemId}.json`);
  }
  /** 内存命中（同步，供检索打分用） */
  get(itemId) {
    const hit = this.mem.get(itemId);
    if (!hit) return null;
    this.mem.delete(itemId);
    this.mem.set(itemId, hit);
    return hit.pages;
  }
  has(itemId) {
    return this.mem.has(itemId);
  }
  async load(itemId) {
    const mem = this.mem.get(itemId);
    if (mem) return mem.pages;
    const data = await readJsonSafe(this.fileFor(itemId));
    if (!data || !Array.isArray(data.pages)) return null;
    this.put(itemId, data);
    return data.pages;
  }
  put(itemId, data) {
    const prev = this.mem.get(itemId);
    if (prev) this.memChars -= prev.chars;
    this.mem.set(itemId, data);
    this.memChars += data.chars;
    while ((this.memChars > this.maxMemChars || this.mem.size > this.maxMemItems) && this.mem.size > 1) {
      const oldest = this.mem.keys().next().value;
      if (!oldest) break;
      const dropped = this.mem.get(oldest);
      if (dropped) this.memChars -= dropped.chars;
      this.mem.delete(oldest);
    }
  }
  /** 写入某篇的全文索引（原子写，单文件一页一页存） */
  async write(item, pages) {
    const chars = pages.reduce((n, p) => n + p.length, 0);
    const data = { itemId: item.id, revision: item.revision, indexedAt: Date.now(), pages, chars };
    this.put(item.id, data);
    await ensureDir2(this.dir);
    await writeFileAtomicSafe(this.fileFor(item.id), JSON.stringify(data));
  }
  async remove(itemId) {
    const hit = this.mem.get(itemId);
    if (hit) {
      this.memChars -= hit.chars;
      this.mem.delete(itemId);
    }
    await rmSafe(this.fileFor(itemId));
  }
  async clear() {
    this.mem.clear();
    this.memChars = 0;
    await rmSafe(this.dir, true);
  }
  /** 是否已有索引文件（不同步读全量内容，只做存在性检查由上层负责） */
  stats() {
    return { count: this.mem.size, chars: this.memChars, memoryItems: this.mem.size, memoryChars: this.memChars };
  }
};

// src/core/metadata.ts
init_paths();
import fs3 from "node:fs/promises";
import path6 from "node:path";
var DOI_IN_TEXT = /\b(?:doi[:\s]*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/[^\s"'<>,;)\]]+)/i;
var ARXIV_IN_TEXT = /\barxiv[:\s/]*(\d{4}\.\d{4,5})(?:v\d+)?/i;
function extractDoi(text) {
  if (!text) return "";
  const m = text.match(DOI_IN_TEXT);
  if (!m) return "";
  return m[1].replace(/[.,;)\]]+$/, "");
}
function extractArxivId(text) {
  if (!text) return "";
  const m = text.match(ARXIV_IN_TEXT);
  return m ? m[1] : "";
}
function cleanAbstract(raw) {
  if (!raw) return "";
  return raw.replace(/<jats:[\s\S]*?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function normalizeTitle(t) {
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}
var TTL = 30 * 24 * 3600 * 1e3;
var MetadataClient = class {
  cache = {};
  loaded = false;
  dirty = false;
  /** 串行化的写盘链，保证 close() 能等到最后一次写入真正结束 */
  writing = Promise.resolve();
  opts;
  constructor(options) {
    this.opts = {
      cacheFile: options.cacheFile,
      timeoutMs: options.timeoutMs ?? 8e3,
      userAgent: options.userAgent ?? "LitShelf/1.0 (local literature reader; mailto:litshelf@example.com)",
      online: options.online !== false
    };
  }
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const text = await fs3.readFile(longPath(this.opts.cacheFile), "utf8");
      this.cache = JSON.parse(text);
    } catch {
      this.cache = {};
    }
  }
  setOnline(online) {
    this.opts.online = online;
  }
  async persist() {
    if (!this.dirty) {
      await this.writing;
      return;
    }
    this.dirty = false;
    const payload = JSON.stringify(this.cache);
    const run = this.writing.then(async () => {
      await fs3.mkdir(longPath(path6.dirname(this.opts.cacheFile)), { recursive: true }).catch(() => void 0);
      await writeFileAtomicSafe(this.opts.cacheFile, payload).catch(() => void 0);
    });
    this.writing = run.catch(() => void 0);
    await this.writing;
  }
  cacheGet(key) {
    const hit = this.cache[key];
    if (!hit) return void 0;
    if (Date.now() - hit.at > TTL) return void 0;
    return hit.data;
  }
  cacheSet(key, data) {
    this.cache[key] = { at: Date.now(), data };
    this.dirty = true;
    void this.persist();
  }
  async fetchJson(url) {
    if (!this.opts.online) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { "User-Agent": this.opts.userAgent, Accept: "application/json" }
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  async fetchText(url) {
    if (!this.opts.online) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { "User-Agent": this.opts.userAgent } });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  async lookupDoi(doi) {
    if (!doi) return null;
    await this.load();
    const key = `doi:${doi.toLowerCase()}`;
    const cached = this.cacheGet(key);
    if (cached !== void 0) return cached;
    const json = await this.fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
    const msg = json?.message;
    if (!msg) {
      this.cacheSet(key, null);
      return null;
    }
    const authors = Array.isArray(msg.author) ? msg.author.map((a) => {
      const given = typeof a.given === "string" ? a.given : "";
      const family = typeof a.family === "string" ? a.family : "";
      return [given, family].filter(Boolean).join(" ").trim() || String(a.name ?? "");
    }).filter(Boolean) : [];
    const issued = msg.issued?.["date-parts"]?.[0]?.[0];
    const container = Array.isArray(msg["container-title"]) ? String(msg["container-title"][0] ?? "") : "";
    const data = {
      source: "crossref",
      title: Array.isArray(msg.title) ? String(msg.title[0] ?? "") : String(msg.title ?? ""),
      authors,
      year: typeof issued === "number" ? issued : null,
      venue: container,
      volume: msg.volume ? String(msg.volume) : "",
      issue: msg.issue ? String(msg.issue) : "",
      pages: msg.page ? String(msg.page) : "",
      doi: typeof msg.DOI === "string" ? msg.DOI : doi,
      url: typeof msg.URL === "string" ? msg.URL : `https://doi.org/${doi}`,
      abstract: cleanAbstract(typeof msg.abstract === "string" ? msg.abstract : ""),
      keywords: Array.isArray(msg.subject) ? msg.subject.slice(0, 24) : [],
      type: typeof msg.type === "string" ? msg.type : "",
      publisher: typeof msg.publisher === "string" ? msg.publisher : ""
    };
    this.cacheSet(key, data);
    return data;
  }
  async lookupArxiv(id) {
    if (!id) return null;
    await this.load();
    const key = `arxiv:${id}`;
    const cached = this.cacheGet(key);
    if (cached !== void 0) return cached;
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
    const pick2 = (tag) => {
      const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return m ? m[1].replace(/\s+/g, " ").trim() : "";
    };
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map((m) => m[1].trim());
    const published = pick2("published");
    const data = {
      source: "arxiv",
      title: pick2("title"),
      authors,
      year: published ? Number(published.slice(0, 4)) : null,
      venue: "arXiv",
      doi: pick2("arxiv:doi") || void 0,
      url: pick2("id") || `https://arxiv.org/abs/${id}`,
      abstract: pick2("summary"),
      keywords: [...entry.matchAll(/<category[^>]*term="([^"]+)"/gi)].map((m) => m[1]).slice(0, 12),
      type: "preprint"
    };
    this.cacheSet(key, data);
    return data;
  }
  /** 用标题在 Crossref 做书目检索，取分数最高的一条 */
  async searchByTitle(title, year) {
    const clean2 = title.replace(/\s+/g, " ").trim();
    if (clean2.length < 8) return null;
    await this.load();
    const key = `title:${normalizeTitle(clean2)}`;
    const cached = this.cacheGet(key);
    if (cached !== void 0) return cached;
    const url = `https://api.crossref.org/works?rows=3&select=DOI,title,author,issued,container-title,volume,issue,page,abstract,subject,type,publisher,URL&query.bibliographic=${encodeURIComponent(clean2)}${year ? `&filter=from-pub-date:${year - 1}-01-01,until-pub-date:${year + 1}-12-31` : ""}`;
    const json = await this.fetchJson(url);
    const items = json?.message?.items ?? [];
    if (!items.length) {
      this.cacheSet(key, null);
      return null;
    }
    const best = items[0];
    const bestTitle = Array.isArray(best.title) ? String(best.title[0] ?? "") : "";
    const sim = similarity(normalizeTitle(clean2), normalizeTitle(bestTitle));
    if (sim < 0.72) {
      this.cacheSet(key, null);
      return null;
    }
    const doi = typeof best.DOI === "string" ? best.DOI : "";
    const full = doi ? await this.lookupDoi(doi) : null;
    if (full) {
      this.cacheSet(key, full);
      return full;
    }
    this.cacheSet(key, null);
    return null;
  }
  async close() {
    await this.persist();
  }
};
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const sa = new Set(a.split(" ").filter(Boolean));
  const sb = new Set(b.split(" ").filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  const jaccard = inter / (sa.size + sb.size - inter);
  const prefix = a.startsWith(b.slice(0, 24)) || b.startsWith(a.slice(0, 24)) ? 0.15 : 0;
  return Math.min(1, jaccard + prefix);
}

// src/core/fingerprint.ts
init_paths();
import { createHash } from "node:crypto";
import fs4 from "node:fs/promises";
var CHUNK = 64 * 1024;
async function fingerprintFile(filePath) {
  const target = longPath(filePath);
  let handle = null;
  try {
    const stat = await fs4.stat(target);
    if (!stat.isFile()) return null;
    const size = stat.size;
    handle = await fs4.open(target, "r");
    const hash = createHash("sha1");
    hash.update(`v1:${size}:`);
    if (size <= CHUNK * 2) {
      const buf = Buffer.alloc(size);
      if (size > 0) await handle.read(buf, 0, size, 0);
      hash.update(buf);
      return { fingerprint: hash.digest("hex").slice(0, 40), size, mtime: stat.mtimeMs, whole: true };
    }
    const head2 = Buffer.alloc(CHUNK);
    await handle.read(head2, 0, CHUNK, 0);
    hash.update(head2);
    const tail = Buffer.alloc(CHUNK);
    await handle.read(tail, 0, CHUNK, size - CHUNK);
    hash.update(tail);
    return { fingerprint: hash.digest("hex").slice(0, 40), size, mtime: stat.mtimeMs, whole: false };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => void 0);
  }
}

// src/core/ignore.ts
var DEFAULT_IGNORE_DIRS = new Set(
  [
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "$RECYCLE.BIN",
    "System Volume Information",
    "$WinREAgent",
    ".Trash",
    ".Trashes",
    ".Spotlight-V100",
    ".fseventsd",
    ".TemporaryItems",
    "__MACOSX",
    ".obsidian",
    ".stfolder",
    ".dropbox.cache",
    ".thumbnails",
    "dist-info",
    "__pycache__"
  ].map((s) => s.toLowerCase())
);
var TEMP_NAME_RES = [
  /^~\$/i,
  // Office 临时文件
  /^\.~/i,
  // LibreOffice
  /^\._/i,
  // macOS 资源分叉
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
  /^desktop\.ini$/i,
  /^\.goutputstream-/i,
  /^\.litshelf-tmp/i,
  /\.crdownload$/i,
  /\.download$/i,
  /\.partial$/i,
  /\.part$/i,
  /\.tmp$/i,
  /\.temp$/i,
  /\.swp$/i,
  /\.swx$/i,
  /\.lock$/i,
  /\.syncthing\./i,
  /\.!qb$/i,
  /\.aria2$/i,
  /^\.#/i,
  // emacs
  /~$/
];
function isTempFileName(name) {
  return TEMP_NAME_RES.some((re) => re.test(name));
}
function isIgnoredDirName(name, extra = []) {
  const lower = name.toLowerCase();
  if (lower.startsWith(".")) {
    if (lower === ".stversions") return true;
    return true;
  }
  if (DEFAULT_IGNORE_DIRS.has(lower)) return true;
  return extra.some((e) => e.toLowerCase() === lower);
}
var DOC_EXTENSIONS = /* @__PURE__ */ new Set([
  "pdf",
  "md",
  "markdown",
  "mdx",
  "txt",
  "text",
  "log",
  "html",
  "htm",
  "xhtml",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "avif",
  "docx",
  "epub",
  "caj",
  "nh",
  "doc",
  "rtf",
  "odt",
  "djvu",
  "tex",
  "bib"
]);
function shouldIncludeFile(input) {
  const { name, ext, size, includeOtherFiles } = input;
  if (isTempFileName(name)) return false;
  if (size === 0) return false;
  const e = ext.toLowerCase();
  if (!e) return false;
  if (input.ignoreExt?.includes(e)) return false;
  if (DOC_EXTENSIONS.has(e)) return true;
  return includeOtherFiles;
}

// src/core/host.ts
init_paths();

// src/core/extract.ts
init_paths();
import fs6 from "node:fs/promises";
import path8 from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
var pdfjsPromise = null;
function resolvePdfWorker(relative) {
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve("pdfjs-dist/package.json");
    const worker = path8.join(path8.dirname(pkgJson), relative);
    return pathToFileURL(worker).href;
  } catch {
    return "";
  }
}
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const candidates = [
        { spec: "pdfjs-dist/legacy/build/pdf.mjs", worker: "legacy/build/pdf.worker.mjs" },
        { spec: "pdfjs-dist/build/pdf.mjs", worker: "build/pdf.worker.mjs" }
      ];
      const errors = [];
      for (const candidate of candidates) {
        try {
          const mod = await import(
            /* @vite-ignore */
            candidate.spec
          );
          if (mod && typeof mod.getDocument === "function") {
            const workerSrc = resolvePdfWorker(candidate.worker);
            try {
              if (mod.GlobalWorkerOptions && workerSrc) mod.GlobalWorkerOptions.workerSrc = workerSrc;
            } catch {
            }
            return mod;
          }
        } catch (err) {
          errors.push(`${candidate.spec}: ${err.message}`);
        }
      }
      throw new Error(`\u65E0\u6CD5\u52A0\u8F7D pdfjs-dist\uFF08${errors.join(" | ")}\uFF09`);
    })();
  }
  return pdfjsPromise;
}
function textFromItems(items) {
  let out = "";
  let prev = "";
  for (const it of items) {
    const s = typeof it.str === "string" ? it.str : "";
    if (s) {
      const needSpace = prev.length > 0 && !/\s$/.test(prev) && !/^\s/.test(s) && /[A-Za-z0-9)\]]$/.test(prev) && /^[A-Za-z0-9([]/.test(s);
      if (needSpace) out += " ";
      out += s;
      prev = s;
    }
    if (it.hasEOL) {
      out += "\n";
      prev = "";
    }
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
var DATE_RE = /^D:(\d{4})(\d{2})?(\d{2})?/;
function pdfDate(v) {
  if (typeof v !== "string") return "";
  const m = v.match(DATE_RE);
  if (!m) return v;
  return `${m[1]}${m[2] ? `-${m[2]}` : ""}${m[3] ? `-${m[3]}` : ""}`;
}
function pick(info, keys) {
  if (!info) return "";
  for (const k of keys) {
    const v = info[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}
async function extractPdf(filePath, opts = {}) {
  const headPages = opts.headPages ?? 3;
  const empty = {
    ok: false,
    pageCount: 0,
    title: "",
    author: "",
    subject: "",
    keywords: "",
    creator: "",
    producer: "",
    creationDate: "",
    modDate: "",
    headText: ""
  };
  let doc = null;
  try {
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(await fs6.readFile(longPath(filePath)));
    const task = pdfjs.getDocument({
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      // 只要文本与元数据，不渲染，无需字体资源
      verbosity: 0
    });
    doc = await task.promise;
    const pageCount = doc.numPages;
    let info;
    let xmpTitle = "";
    let xmpCreator = "";
    try {
      const meta = await doc.getMetadata();
      info = meta.info ?? void 0;
      const get = meta.metadata?.get?.bind(meta.metadata);
      if (get) {
        xmpTitle = String(get("dc:title") ?? "").trim();
        xmpCreator = String(get("dc:creator") ?? "").trim();
      }
    } catch {
    }
    const limit = opts.withAllText ? pageCount : Math.min(headPages, pageCount);
    const chunks = [];
    for (let p = 1; p <= limit; p += 1) {
      try {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        chunks.push(textFromItems(content.items));
      } catch {
        chunks.push("");
      }
    }
    return {
      ok: true,
      pageCount,
      title: pick(info, ["Title"]) || xmpTitle,
      author: pick(info, ["Author"]) || xmpCreator,
      subject: pick(info, ["Subject"]),
      keywords: pick(info, ["Keywords"]),
      creator: pick(info, ["Creator"]),
      producer: pick(info, ["Producer"]),
      creationDate: pdfDate(info?.CreationDate),
      modDate: pdfDate(info?.ModDate),
      headText: chunks.join("\n\n").slice(0, 2e5)
    };
  } catch (err) {
    return { ...empty, error: err.message };
  } finally {
    await doc?.destroy().catch(() => void 0);
  }
}
function decodeTextBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 239 && buf[1] === 187 && buf[2] === 191) {
    return { text: buf.subarray(3).toString("utf8"), encoding: "utf-8-bom" };
  }
  if (buf.length >= 2 && buf[0] === 255 && buf[1] === 254) {
    return { text: new TextDecoder("utf-16le").decode(buf.subarray(2)), encoding: "utf-16le" };
  }
  if (buf.length >= 2 && buf[0] === 254 && buf[1] === 255) {
    return { text: new TextDecoder("utf-16be").decode(buf.subarray(2)), encoding: "utf-16be" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf-8" };
  } catch {
  }
  try {
    return { text: new TextDecoder("gbk").decode(buf), encoding: "gbk" };
  } catch {
    return { text: buf.toString("latin1"), encoding: "latin1" };
  }
}
async function readTextFileSmart(filePath) {
  const buf = await fs6.readFile(longPath(filePath));
  return decodeTextBuffer(buf);
}
function htmlToText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<head[\s\S]*?<\/head>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function countWords(text) {
  const chars = text.replace(/\s/g, "").length;
  const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length;
  const latin = (text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, " ").match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? []).length;
  return { words: cjk + latin, chars };
}
async function extractTextForIndex(filePath, kind) {
  try {
    if (kind === "pdf") {
      const pdfjs = await loadPdfjs();
      const data = new Uint8Array(await fs6.readFile(longPath(filePath)));
      const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, verbosity: 0 });
      const doc = await task.promise;
      const pages = [];
      for (let p = 1; p <= doc.numPages; p += 1) {
        try {
          const page = await doc.getPage(p);
          const content = await page.getTextContent();
          pages.push(textFromItems(content.items));
        } catch {
          pages.push("");
        }
      }
      await doc.destroy().catch(() => void 0);
      const all = pages.join("\n");
      const { words, chars } = countWords(all);
      return { pages, wordCount: words, charCount: chars };
    }
    if (kind === "text" || kind === "markdown") {
      const { text } = await readTextFileSmart(filePath);
      const { words, chars } = countWords(text);
      return { pages: [text], wordCount: words, charCount: chars };
    }
    if (kind === "html") {
      const { text } = await readTextFileSmart(filePath);
      const plain = htmlToText(text);
      const { words, chars } = countWords(plain);
      return { pages: [plain], wordCount: words, charCount: chars };
    }
    if (kind === "docx") {
      const mammoth = await import("mammoth");
      const res = await mammoth.extractRawText({ path: longPath(filePath) });
      const text = res.value ?? "";
      const { words, chars } = countWords(text);
      return { pages: [text], wordCount: words, charCount: chars };
    }
    if (kind === "epub") {
      const { extractEpub: extractEpub2 } = await Promise.resolve().then(() => (init_epub(), epub_exports));
      const book = await extractEpub2(filePath);
      if (!book) return null;
      const pages = book.chapters.map((c) => htmlToText(c.html));
      const all = pages.join("\n");
      const { words, chars } = countWords(all);
      return { pages, wordCount: words, charCount: chars };
    }
  } catch {
    return null;
  }
  return null;
}

// src/core/reanchor.ts
function normalizeForMatch(input) {
  return input.replace(/[\u2018\u2019\u201B]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}
function stripAllSpaces(s) {
  return s.replace(/\s+/g, "");
}
function locateInPages(pages, text, anchor) {
  const needle = normalizeForMatch(text);
  if (!needle) return { page: 1, confidence: 0, how: "none", offset: 0 };
  const prefix = anchor?.prefix ? normalizeForMatch(anchor.prefix) : "";
  const suffix = anchor?.suffix ? normalizeForMatch(anchor.suffix) : "";
  const occurrence = anchor?.occurrence ?? 1;
  const norm = pages.map((p) => normalizeForMatch(p));
  const matches = [];
  if (prefix || suffix) {
    const ctxNeedle = `${prefix}${prefix ? " " : ""}${needle}${suffix ? " " : ""}${suffix}`.trim();
    for (let i = 0; i < norm.length; i += 1) {
      const at = norm[i].indexOf(ctxNeedle);
      if (at >= 0) matches.push({ page: i + 1, offset: at, confidence: 1, how: "context" });
    }
  }
  if (!matches.length) {
    for (let i = 0; i < norm.length; i += 1) {
      let from = 0;
      for (; ; ) {
        const at = norm[i].indexOf(needle, from);
        if (at < 0) break;
        matches.push({ page: i + 1, offset: at, confidence: 0.85, how: "text" });
        from = at + Math.max(1, needle.length);
        if (matches.length > 200) break;
      }
      if (matches.length > 200) break;
    }
  }
  if (!matches.length) {
    const flatNeedle = stripAllSpaces(needle);
    if (flatNeedle.length >= 4) {
      for (let i = 0; i < pages.length; i += 1) {
        const flat = stripAllSpaces(norm[i]);
        const at = flat.indexOf(flatNeedle);
        if (at >= 0) matches.push({ page: i + 1, offset: at, confidence: 0.6, how: "loose" });
      }
    }
  }
  if (!matches.length) return { page: 1, confidence: 0, how: "none", offset: 0 };
  const byQuality = matches.slice().sort((a, b) => b.confidence - a.confidence);
  const best = byQuality[0];
  const sameQuality = matches.filter((m) => m.confidence === best.confidence);
  if (sameQuality.length > 1) {
    const idx = Math.min(occurrence - 1, sameQuality.length - 1);
    const chosen = sameQuality[Math.max(0, idx)];
    return { page: chosen.page, offset: chosen.offset, confidence: chosen.confidence - 0.1, how: chosen.how };
  }
  return { page: best.page, offset: best.offset, confidence: best.confidence, how: best.how };
}
function reanchorAnnotation(annotation, pages) {
  if (annotation.type === "bookmark") {
    const total = pages.length || 1;
    const page = Math.min(Math.max(1, annotation.page), total);
    if (page === annotation.page) return { annotation, changed: false, needsReview: false };
    return {
      annotation: { ...annotation, page, reanchored: true, updatedAt: Date.now(), reanchorNote: `\u6309\u9875\u7801\u767E\u5206\u6BD4\u8FD8\u539F\u5230 P${page}` },
      changed: true,
      needsReview: false,
      note: `\u4E66\u7B7E\u5DF2\u8FD8\u539F\u5230 P${page}`
    };
  }
  const result = locateInPages(pages, annotation.text, annotation.anchor);
  if (result.how === "none") {
    return {
      annotation: {
        ...annotation,
        needsReview: true,
        reanchorNote: "\u6587\u4EF6\u5DF2\u66F4\u65B0\uFF0C\u672A\u80FD\u81EA\u52A8\u5B9A\u4F4D\u5230\u539F\u6587\uFF0C\u8BF7\u624B\u52A8\u786E\u8BA4\u4F4D\u7F6E",
        updatedAt: Date.now()
      },
      changed: true,
      needsReview: true,
      note: "\u6709\u6279\u6CE8\u9700\u8981\u4EBA\u5DE5\u786E\u8BA4\u4F4D\u7F6E"
    };
  }
  const pageChanged = result.page !== annotation.page;
  const lowConfidence = result.confidence < 0.7;
  const next = {
    ...annotation,
    page: result.page,
    reanchored: true,
    needsReview: lowConfidence,
    updatedAt: Date.now(),
    reanchorNote: pageChanged ? `\u6587\u4EF6\u66F4\u65B0\u540E\u6309\u6587\u672C\u91CD\u65B0\u5B9A\u4F4D\u5230 P${result.page}${lowConfidence ? "\uFF08\u4F4E\u7F6E\u4FE1\u5EA6\uFF0C\u4F4D\u7F6E\u53EF\u80FD\u4E0D\u51C6\uFF09" : ""}` : `\u6587\u4EF6\u66F4\u65B0\u540E\u91CD\u65B0\u5B9A\u4F4D\uFF08\u4ECD\u5728 P${result.page}\uFF09`
  };
  return { annotation: next, changed: true, needsReview: lowConfidence, note: next.reanchorNote };
}

// src/core/search.ts
var FILTER_KEYS = /* @__PURE__ */ new Set(["tag", "author", "year", "is", "kind", "ext", "title", "doi", "note", "ann", "folder", "root", "path"]);
function parseQuery(raw) {
  const out = { terms: [], phrases: [], filters: [], yearFrom: null, yearTo: null, empty: true };
  const text = (raw ?? "").trim();
  if (!text) return out;
  const phraseRe = /"([^"]+)"|'([^']+)'/g;
  let rest = text;
  for (const m of text.matchAll(phraseRe)) {
    const phrase = (m[1] ?? m[2] ?? "").trim();
    if (phrase) {
      out.phrases.push(phrase);
      out.empty = false;
    }
    rest = rest.replace(m[0], " ");
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const idx = token.indexOf(":");
    if (idx > 0) {
      const key = token.slice(0, idx).toLowerCase();
      const value = token.slice(idx + 1).trim();
      if (FILTER_KEYS.has(key) && value) {
        if (key === "year") {
          const range = value.match(/^(\d{4})?\.\.(\d{4})?$/);
          if (range) {
            out.yearFrom = range[1] ? Number(range[1]) : null;
            out.yearTo = range[2] ? Number(range[2]) : null;
            out.empty = false;
            continue;
          }
          const single = value.match(/^(\d{4})$/);
          if (single) {
            out.yearFrom = Number(single[1]);
            out.yearTo = Number(single[1]);
            out.empty = false;
            continue;
          }
        }
        out.filters.push({ key, value });
        out.empty = false;
        continue;
      }
    }
    if (token) {
      out.terms.push(token);
      out.empty = false;
    }
  }
  return out;
}
var IS_FLAGS = /* @__PURE__ */ new Set([
  "unread",
  "read",
  "reading",
  "starred",
  "annotated",
  "note",
  "missing",
  "new",
  "pdf",
  "image",
  "markdown",
  "text",
  "html",
  "docx",
  "epub",
  "other"
]);
function snippetAround(text, at, len) {
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + len + 50);
  return `${start > 0 ? "\u2026" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "\u2026" : ""}`;
}
function matchTest(haystack, needle) {
  if (!haystack || !needle) return -1;
  return normalizeForMatch(haystack).indexOf(needle);
}
function itemMatchesFilters(item, q, ctx) {
  if (q.yearFrom !== null || q.yearTo !== null) {
    const y = item.year ?? 0;
    if (!y) return false;
    if (q.yearFrom !== null && y < q.yearFrom) return false;
    if (q.yearTo !== null && y > q.yearTo) return false;
  }
  for (const f of q.filters) {
    const v = normalizeForMatch(f.value);
    switch (f.key) {
      case "tag":
        if (!item.tags.some((t) => normalizeForMatch(t).includes(v))) return false;
        break;
      case "author":
        if (!item.authors.some((a) => normalizeForMatch(a).includes(v))) return false;
        break;
      case "title":
        if (matchTest(item.title, v) < 0) return false;
        break;
      case "doi":
        if (!normalizeForMatch(item.doi).includes(v)) return false;
        break;
      case "kind":
      case "ext":
        if (item.kind !== v && item.ext !== v) return false;
        break;
      case "folder":
        if (!normalizeForMatch(item.dir).includes(v)) return false;
        break;
      case "root":
        if (!normalizeForMatch(item.rootId).includes(v)) return false;
        break;
      case "path":
        if (!normalizeForMatch(item.relPath).includes(v)) return false;
        break;
      case "note":
        if (!normalizeForMatch(item.note).includes(v)) return false;
        break;
      case "ann": {
        const anns = ctx.annotations?.(item.id) ?? [];
        if (!anns.some((a) => normalizeForMatch(a.comment).includes(v) || normalizeForMatch(a.text).includes(v))) return false;
        break;
      }
      case "is": {
        const flag = v;
        if (!IS_FLAGS.has(flag)) return false;
        switch (flag) {
          case "unread":
            if (item.readState !== "unread") return false;
            break;
          case "read":
            if (item.readState !== "read") return false;
            break;
          case "reading":
            if (item.readState !== "reading") return false;
            break;
          case "starred":
            if (!item.starred) return false;
            break;
          case "missing":
            if (!item.missing) return false;
            break;
          case "annotated":
            if (item.annotationCount <= 0) return false;
            break;
          case "note":
            if (!item.note) return false;
            break;
          case "new": {
            const week = Date.now() - 7 * 24 * 3600 * 1e3;
            if (item.addedAt < week) return false;
            break;
          }
          default:
            if (item.kind !== flag) return false;
        }
        break;
      }
      default:
        break;
    }
  }
  return true;
}
function scoreItem(item, q, ctx) {
  if (!itemMatchesFilters(item, q, ctx)) return null;
  const fields = /* @__PURE__ */ new Set();
  const contexts = [];
  let score = 1;
  const needles = [...q.terms.map((t) => normalizeForMatch(t)), ...q.phrases.map((p) => normalizeForMatch(p))].filter(Boolean);
  if (needles.length) {
    let matchedAll = true;
    for (const needle of needles) {
      let hit = false;
      const titleAt = matchTest(item.title, needle);
      if (titleAt >= 0) {
        score += 12;
        fields.add("\u6807\u9898");
        hit = true;
      }
      if (matchTest(item.name, needle) >= 0) {
        score += 6;
        fields.add("\u6587\u4EF6\u540D");
        hit = true;
      }
      if (item.authors.some((a) => normalizeForMatch(a).includes(needle))) {
        score += 7;
        fields.add("\u4F5C\u8005");
        hit = true;
      }
      if (item.tags.some((t) => normalizeForMatch(t).includes(needle))) {
        score += 8;
        fields.add("\u6807\u7B7E");
        hit = true;
      }
      if (normalizeForMatch(item.venue).includes(needle)) {
        score += 4;
        fields.add("\u671F\u520A");
        hit = true;
      }
      if (normalizeForMatch(item.keywords.join(" ")).includes(needle)) {
        score += 3;
        fields.add("\u5173\u952E\u8BCD");
        hit = true;
      }
      if (normalizeForMatch(item.abstract).includes(needle)) {
        score += 3;
        fields.add("\u6458\u8981");
        hit = true;
      }
      if (normalizeForMatch(item.note).includes(needle)) {
        score += 5;
        fields.add("\u7B14\u8BB0");
        const at = normalizeForMatch(item.note).indexOf(needle);
        contexts.push({ snippet: snippetAround(item.note, at, needle.length) });
        hit = true;
      }
      const anns = ctx.annotations?.(item.id) ?? [];
      for (const a of anns) {
        if (normalizeForMatch(a.comment).includes(needle)) {
          score += 4;
          fields.add("\u6279\u6CE8");
          contexts.push({ page: a.page, snippet: snippetAround(a.comment, normalizeForMatch(a.comment).indexOf(needle), needle.length) });
          hit = true;
          break;
        }
        if (normalizeForMatch(a.text).includes(needle)) {
          score += 2;
          fields.add("\u6807\u6CE8\u539F\u6587");
          contexts.push({ page: a.page, snippet: snippetAround(a.text, normalizeForMatch(a.text).indexOf(needle), needle.length) });
          hit = true;
          break;
        }
      }
      if (normalizeForMatch(item.excerpt).includes(needle)) {
        score += 2;
        fields.add("\u6B63\u6587\u5F00\u5934");
        hit = true;
      }
      if (!hit) {
        const pages = ctx.text?.(item.id) ?? null;
        if (pages) {
          let foundPage = -1;
          let foundAt = -1;
          for (let i = 0; i < pages.length; i += 1) {
            const at = normalizeForMatch(pages[i]).indexOf(needle);
            if (at >= 0) {
              foundPage = i + 1;
              foundAt = at;
              break;
            }
          }
          if (foundPage > 0) {
            score += 2;
            fields.add(`\u6B63\u6587 P${foundPage}`);
            contexts.push({ page: foundPage, snippet: snippetAround(pages[foundPage - 1], foundAt, needle.length) });
            hit = true;
          }
        }
      }
      if (!hit) matchedAll = false;
    }
    if (!matchedAll) return null;
  }
  if (item.readState === "read") score -= 0.3;
  if (item.starred) score += 0.8;
  if (item.missing) score -= 0.4;
  return { score, fields, contexts: contexts.slice(0, 3) };
}
function searchItems(items, rawQuery, ctx, limit = 300) {
  const q = parseQuery(rawQuery);
  const results = [];
  for (const item of items) {
    const scored = scoreItem(item, q, ctx);
    if (!scored) continue;
    results.push({ item, score: scored.score, fields: [...scored.fields], contexts: scored.contexts });
  }
  results.sort((a, b) => b.score - a.score || b.item.addedAt - a.item.addedAt);
  return results.slice(0, limit);
}

// src/core/export.ts
function firstAuthorSurname(item) {
  const a = item.authors[0] ?? "";
  if (!a) return "anon";
  if (/[\u4e00-\u9fa5]/.test(a)) return a.slice(0, 2);
  const parts = a.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? a).replace(/[^\p{L}]/gu, "") || "anon";
}
function bibtexKey(item) {
  const surname = firstAuthorSurname(item).toLowerCase();
  const year = item.year ?? "n";
  const word = (item.title.match(/[\p{L}\p{N}]+/u)?.[0] ?? "work").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return `${surname}${year}${word}`;
}
function bibType(item) {
  if (item.arxivId) return "misc";
  if (item.kind === "pdf" || item.kind === "docx") return item.venue ? "article" : "misc";
  if (item.kind === "epub") return "book";
  return "misc";
}
function esc(s) {
  return (s ?? "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}
function toBibTeX(items) {
  const seen = /* @__PURE__ */ new Map();
  return items.map((item) => {
    const base = bibtexKey(item);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const key = n > 1 ? `${base}${String.fromCharCode(96 + n)}` : base;
    const authors = item.authors.join(" and ");
    const lines = [
      `  title = {${esc(item.title)}}`,
      authors ? `  author = {${esc(authors)}}` : "",
      item.year ? `  year = {${item.year}}` : "",
      item.venue ? `  journal = {${esc(item.venue)}}` : "",
      item.volume ? `  volume = {${esc(item.volume)}}` : "",
      item.issue ? `  number = {${esc(item.issue)}}` : "",
      item.pages ? `  pages = {${esc(item.pages)}}` : "",
      item.doi ? `  doi = {${esc(item.doi)}}` : "",
      item.arxivId ? `  eprint = {${esc(item.arxivId)}}` : "",
      item.arxivId ? `  archivePrefix = {arXiv}` : "",
      item.url ? `  url = {${esc(item.url)}}` : "",
      item.abstract ? `  abstract = {${esc(item.abstract).slice(0, 1200)}}` : "",
      // keywords 与 tags 合并成同一个 BibTeX 字段；两边都有时只输出合并后的那一条，
      // 否则同一个条目里会出现两个 keywords = {}（非法 / 解析器行为不确定）。
      item.keywords.length && !item.tags.length ? `  keywords = {${esc(item.keywords.join(", "))}}` : "",
      item.tags.length ? `  keywords = {${esc([...item.keywords, ...item.tags].join(", "))}}` : "",
      `  file = {${esc(item.name)}}`
    ].filter(Boolean);
    return `@${bibType(item)}{${key},
${lines.join(",\n")}
}`;
  }).join("\n\n");
}
function toRIS(items) {
  return items.map((item) => {
    const lines = ["TY  - JOUR"];
    for (const a of item.authors) lines.push(`AU  - ${a}`);
    lines.push(`TI  - ${item.title}`);
    if (item.year) lines.push(`PY  - ${item.year}`);
    if (item.venue) lines.push(`JO  - ${item.venue}`);
    if (item.volume) lines.push(`VL  - ${item.volume}`);
    if (item.issue) lines.push(`IS  - ${item.issue}`);
    if (item.pages) lines.push(`SP  - ${item.pages}`);
    if (item.doi) lines.push(`DO  - ${item.doi}`);
    if (item.url) lines.push(`UR  - ${item.url}`);
    if (item.abstract) lines.push(`AB  - ${item.abstract.replace(/\s+/g, " ")}`);
    for (const k of item.keywords) lines.push(`KW  - ${k}`);
    for (const t of item.tags) lines.push(`KW  - ${t}`);
    lines.push("ER  -");
    return lines.join("\n");
  }).join("\n\n");
}
function toCSLJSON(items) {
  return JSON.stringify(
    items.map((item) => ({
      id: item.id,
      type: item.arxivId ? "article" : "article-journal",
      title: item.title,
      author: item.authors.map((a) => {
        if (/[\u4e00-\u9fa5]/.test(a)) return { literal: a };
        const parts = a.trim().split(/\s+/);
        if (parts.length === 1) return { literal: a };
        return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1] };
      }),
      issued: item.year ? { "date-parts": [[item.year]] } : void 0,
      "container-title": item.venue || void 0,
      volume: item.volume || void 0,
      issue: item.issue || void 0,
      page: item.pages || void 0,
      DOI: item.doi || void 0,
      URL: item.url || void 0,
      abstract: item.abstract || void 0,
      keyword: [...item.keywords, ...item.tags].join(", ") || void 0,
      note: item.note ? item.note.slice(0, 2e3) : void 0
    })),
    null,
    2
  );
}
function csvCell(v) {
  const s = (v ?? "").replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}
function toCSV(items) {
  const header = [
    "\u6807\u9898",
    "\u4F5C\u8005",
    "\u5E74\u4EFD",
    "\u671F\u520A/\u51FA\u5904",
    "\u5377",
    "\u671F",
    "\u9875\u7801",
    "DOI",
    "\u6807\u7B7E",
    "\u9605\u8BFB\u72B6\u6001",
    "\u661F\u6807",
    "\u9875\u6570",
    "\u9605\u8BFB\u8FDB\u5EA6",
    "\u6DFB\u52A0\u65F6\u95F4",
    "\u6700\u8FD1\u9605\u8BFB",
    "\u6587\u4EF6\u8DEF\u5F84",
    "\u6587\u4EF6\u7F3A\u5931",
    "\u6279\u6CE8\u6570",
    "\u7B14\u8BB0"
  ];
  const rows = items.map(
    (item) => [
      item.title,
      item.authors.join("; "),
      item.year ? String(item.year) : "",
      item.venue,
      item.volume,
      item.issue,
      item.pages,
      item.doi,
      item.tags.join("; "),
      { unread: "\u672A\u8BFB", reading: "\u5728\u8BFB", read: "\u5DF2\u8BFB" }[item.readState] ?? item.readState,
      item.starred ? "\u662F" : "",
      item.pageCount ? String(item.pageCount) : "",
      `${Math.round(item.progress.percent)}%`,
      new Date(item.addedAt).toLocaleString("zh-CN"),
      item.lastOpenedAt ? new Date(item.lastOpenedAt).toLocaleString("zh-CN") : "",
      item.path,
      item.missing ? "\u662F" : "",
      String(item.annotationCount),
      item.note.replace(/\s+/g, " ").slice(0, 500)
    ].map((v) => csvCell(String(v))).join(",")
  );
  return `\uFEFF${header.join(",")}
${rows.join("\n")}
`;
}
function itemNotesMarkdown(item, annotations) {
  const lines = [];
  lines.push(`# ${item.title}`);
  lines.push("");
  const meta = [];
  if (item.authors.length) meta.push(`**\u4F5C\u8005**\uFF1A${item.authors.join("\u3001")}`);
  if (item.year) meta.push(`**\u5E74\u4EFD**\uFF1A${item.year}`);
  if (item.venue) meta.push(`**\u51FA\u5904**\uFF1A${item.venue}`);
  if (item.doi) meta.push(`**DOI**\uFF1A${item.doi}`);
  if (item.url) meta.push(`**\u94FE\u63A5**\uFF1A${item.url}`);
  if (item.tags.length) meta.push(`**\u6807\u7B7E**\uFF1A${item.tags.map((t) => `#${t}`).join(" ")}`);
  meta.push(`**\u6587\u4EF6**\uFF1A\`${item.name}\``);
  meta.push(`**\u9605\u8BFB\u8FDB\u5EA6**\uFF1A${item.progress.page}/${item.pageCount || item.progress.total || "?"} \u9875\uFF08${Math.round(item.progress.percent)}%\uFF09`);
  lines.push(meta.join("  \n"));
  lines.push("");
  if (item.note.trim()) {
    lines.push("## \u6211\u7684\u7B14\u8BB0");
    lines.push("");
    lines.push(item.note.trim());
    lines.push("");
  }
  if (annotations.length) {
    lines.push("## \u6279\u6CE8\u4E0E\u9AD8\u4EAE");
    lines.push("");
    const sorted = [...annotations].sort((a, b) => a.page - b.page);
    for (const a of sorted) {
      const label = { highlight: "\u9AD8\u4EAE", underline: "\u4E0B\u5212\u7EBF", squiggly: "\u6CE2\u6D6A\u7EBF", strikeout: "\u5220\u9664\u7EBF", note: "\u6279\u6CE8", bookmark: "\u4E66\u7B7E" }[a.type] ?? a.type;
      lines.push(`### P${a.page} \xB7 ${label}`);
      lines.push("");
      if (a.text.trim()) lines.push(`> ${a.text.replace(/\n+/g, " ")}`);
      if (a.comment.trim()) lines.push(`
\u{1F4AC} ${a.comment}`);
      if (a.reanchorNote) lines.push(`
<sub>${a.reanchorNote}</sub>`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
function toNotesBundle(items, annotationsFor) {
  return items.map((item) => itemNotesMarkdown(item, annotationsFor(item.id))).join("\n\n---\n\n");
}
function formatCitation(item, style = "gbt7714") {
  const authors = item.authors.length ? item.authors : ["\u4F5A\u540D"];
  const year = item.year ? String(item.year) : "n.d.";
  const title = item.title || item.name;
  const venue = item.venue || "";
  const volIssue = [item.volume, item.issue].filter(Boolean).join("(") + (item.issue ? ")" : "");
  const pages = item.pages ? `: ${item.pages}` : "";
  const doi = item.doi ? ` DOI: ${item.doi}.` : "";
  switch (style) {
    case "apa": {
      const a = authors.map((n) => n).join(", ");
      return `${a} (${year}). ${title}. ${venue}${volIssue ? `, ${volIssue}` : ""}${pages}.${doi}`;
    }
    case "ieee": {
      const a = authors.map((n) => {
        const parts = n.trim().split(/\s+/);
        if (parts.length === 1) return n;
        return `${parts.slice(0, -1).map((p) => `${p[0]}.`).join(" ")} ${parts[parts.length - 1]}`;
      }).join(", ");
      return `${a}, "${title}," ${venue}${volIssue ? `, vol. ${item.volume ?? ""}${item.issue ? `, no. ${item.issue}` : ""}` : ""}${pages}, ${year}.${doi}`;
    }
    case "mla": {
      const a = authors.length > 2 ? `${authors[0]}, et al.` : authors.join(", and ");
      return `${a}. "${title}." ${venue}${volIssue ? `, vol. ${item.volume ?? ""}` : ""}, ${year}${pages}.${doi}`;
    }
    case "gbt7714":
    default: {
      const a = authors.slice(0, 3).join(", ") + (authors.length > 3 ? ", \u7B49" : "");
      return `${a}. ${title}[J]. ${venue}${item.year ? `, ${item.year}` : ""}${volIssue ? `, ${volIssue}` : ""}${pages}.${doi}`;
    }
  }
}
function exportContent(items, opts, annotationsFor) {
  switch (opts.format) {
    case "bibtex":
      return toBibTeX(items);
    case "ris":
      return toRIS(items);
    case "csljson":
      return toCSLJSON(items);
    case "csv":
      return toCSV(items);
    case "markdown-notes":
      return toNotesBundle(items, annotationsFor);
    default:
      return "";
  }
}
var EXPORT_EXT = {
  bibtex: "bib",
  ris: "ris",
  csljson: "json",
  csv: "csv",
  "markdown-notes": "md"
};

// src/core/host.ts
var EMPTY_PROGRESS = {
  active: false,
  phase: "idle",
  discovered: 0,
  processed: 0,
  total: 0,
  currentPath: "",
  rootId: null,
  startedAt: 0,
  finishedAt: null,
  errors: 0
};
var Host = class {
  library;
  annotations;
  textIndex;
  metadata;
  journal;
  dataDir;
  mode;
  version;
  listeners = /* @__PURE__ */ new Set();
  watchers = /* @__PURE__ */ new Map();
  progress = { ...EMPTY_PROGRESS };
  undoStack = [];
  scanRunning = /* @__PURE__ */ new Set();
  queue = [];
  queueRunning = false;
  pendingTimers = /* @__PURE__ */ new Map();
  batch = { added: 0, updated: 0, renamed: 0, missing: 0, removed: 0, timer: null };
  reconcileTimer = null;
  toastIds = /* @__PURE__ */ new Set();
  started = false;
  /** stop() 之后不得再创建 watcher，否则事件循环永不退出 */
  stopping = false;
  /** 软件内改过、还没落盘的笔记（只在退出时回写这些，避免覆盖外部编辑） */
  noteDirty = /* @__PURE__ */ new Set();
  settingsFile;
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.mode = opts.mode;
    this.version = opts.version;
    this.library = new Library(path9.join(opts.dataDir, "library.json"));
    this.annotations = new AnnotationStore(path9.join(opts.dataDir, "annotations.json"));
    this.textIndex = new TextIndex(path9.join(opts.dataDir, "cache"));
    this.metadata = new MetadataClient({
      cacheFile: path9.join(opts.dataDir, "cache", "metadata.json"),
      online: opts.online !== false
    });
    this.journal = new Journal(path9.join(opts.dataDir, "logs", "journal.log"));
    this.settingsFile = new JsonFile({
      file: path9.join(opts.dataDir, "settings.json"),
      defaults: () => ({ ...this.library.getSettings() }),
      revive: (raw) => raw && typeof raw === "object" ? { ...this.library.getSettings(), ...raw } : null
    });
  }
  get cacheDir() {
    return path9.join(this.dataDir, "cache");
  }
  get thumbsDir() {
    return path9.join(this.cacheDir, "thumbs");
  }
  get notesDir() {
    return path9.join(this.dataDir, "notes");
  }
  // ------------------------------------------------------------ 生命周期
  async start() {
    if (this.started) return;
    this.started = true;
    await ensureDir2(this.dataDir);
    await ensureDir2(this.cacheDir);
    await ensureDir2(this.thumbsDir);
    await ensureDir2(this.notesDir);
    await this.library.load();
    await this.annotations.load();
    await this.settingsFile.load();
    this.metadata.setOnline(this.library.getSettings().onlineMetadata);
    this.syncAnnotationCounts();
    this.journal.append("host:start", { mode: this.mode, items: this.library.size() });
    await this.restoreNotesFromDisk();
    for (const root of this.library.getRoots()) {
      if (!root.enabled) continue;
      const ok2 = await exists(root.path);
      this.library.setRootAvailable(root.id, ok2);
      if (!ok2) {
        this.pushToast("warn", `\u6587\u732E\u5E93\u300C${root.name}\u300D\u6682\u65F6\u6253\u4E0D\u5F00`, root.path, 8e3);
        continue;
      }
      const real = await fs7.realpath(longPath(root.path)).catch(() => root.path);
      if (real && real !== root.path) {
        const itemCount = this.library.all().filter((i) => i.rootId === root.id).length;
        if (itemCount === 0) {
          this.journal.append("root:realpath", { from: root.path, to: real });
          this.library.setRootPath(root.id, real);
          root.path = real;
        } else {
          this.journal.append("root:shortpath-warning", { path: root.path, real });
        }
      }
      void this.scanRoot(root.id).catch(() => void 0);
      this.startWatch(root);
    }
    this.scheduleReconcile();
  }
  async stop() {
    this.stopping = true;
    await new Promise((r) => setTimeout(r, 0));
    for (const w of this.watchers.values()) await w.close().catch(() => void 0);
    this.watchers.clear();
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    for (const t of this.pendingTimers.values()) clearTimeout(t);
    this.pendingTimers.clear();
    await this.flushAll();
  }
  async flushAll() {
    await this.library.flush();
    await this.annotations.flush();
    await this.metadata.close();
    await this.settingsFile.flushNow().catch(() => void 0);
    await this.flushDirtyNotes();
  }
  /**
   * 只回写"软件内改动过、还没落盘"的笔记。
   * 绝不能在这里无条件重写全部笔记文件——那会把用户在外部编辑器里改的内容冲掉。
   */
  async flushDirtyNotes() {
    for (const id of [...this.noteDirty]) {
      const item = this.library.get(id);
      if (item) await this.writeNoteFile(item).catch(() => void 0);
      this.noteDirty.delete(id);
    }
  }
  // ------------------------------------------------------------ 事件
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event) {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error("[litshelf] \u4E8B\u4EF6\u76D1\u542C\u5668\u5F02\u5E38", err);
      }
    }
  }
  emitItems(items) {
    if (!items.length) return;
    this.emit({ type: "items:patch", items });
  }
  emitRoots() {
    this.emit({ type: "roots:update", roots: this.library.getRoots() });
  }
  emitSettings() {
    this.emit({ type: "settings:update", settings: this.library.getSettings() });
  }
  emitTags() {
    this.emit({ type: "tags:update", tags: this.library.tags() });
  }
  pushToast(kind, message, detail, ttl = 5200, extra = {}) {
    const toast = {
      id: shortId("ts_"),
      kind,
      message,
      detail,
      createdAt: Date.now(),
      ttl,
      ...extra
    };
    this.toastIds.add(toast.id);
    if (this.toastIds.size > 60) this.toastIds.clear();
    this.emit({ type: "toast", toast });
    return toast;
  }
  patchProgress(patch) {
    this.progress = { ...this.progress, ...patch };
    this.emit({ type: "scan:progress", progress: { ...this.progress } });
  }
  getProgress() {
    return { ...this.progress };
  }
  snapshot() {
    return {
      ...this.library.snapshotBase(),
      progress: this.getProgress(),
      platform: process.platform,
      mode: this.mode,
      dataDir: this.dataDir,
      version: this.version
    };
  }
  // ------------------------------------------------------------ 扫描
  /** S1：枚举文件（不做哈希、不解析） */
  async discover(root) {
    const out = [];
    const includeOther = this.library.getSettings().includeOtherFiles;
    const stack = [{ dir: root.path, depth: 1 }];
    while (stack.length) {
      const { dir, depth } = stack.pop();
      const entries = await listDirSafe(dir);
      for (const entry of entries) {
        const abs = path9.join(dir, entry.name);
        if (entry.isDir) {
          if (depth >= root.depth) continue;
          if (isIgnoredDirName(entry.name)) continue;
          stack.push({ dir: abs, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile) continue;
        const ext = (entry.name.split(".").pop() ?? "").toLowerCase();
        if (!shouldIncludeFile({ name: entry.name, ext, size: entry.size, includeOtherFiles: includeOther })) continue;
        out.push({ path: abs, name: entry.name, ext, size: entry.size, mtime: entry.mtime, ctime: entry.mtime });
        if (out.length % 400 === 0) {
          this.patchProgress({ discovered: out.length, currentPath: abs });
          await sleep(0);
        }
      }
    }
    return out;
  }
  /** 完整扫描一个根目录：发现 → 指纹 → 对账 → 广播 → 排队抽取 */
  async scanRoot(rootId, opts = {}) {
    const root = this.library.getRoot(rootId);
    if (!root) return;
    if (this.scanRunning.has(rootId)) return;
    this.scanRunning.add(rootId);
    const started = Date.now();
    try {
      const ok2 = await exists(root.path);
      this.library.setRootAvailable(rootId, ok2);
      if (!ok2) {
        this.emitRoots();
        return;
      }
      this.patchProgress({
        active: true,
        phase: "discovering",
        discovered: 0,
        processed: 0,
        total: 0,
        rootId,
        startedAt: started,
        finishedAt: null,
        errors: 0,
        currentPath: root.path
      });
      const files = await this.discover(root);
      this.patchProgress({ phase: "hashing", discovered: files.length, total: files.length });
      const entries = [];
      let done = 0;
      await mapLimit(files, Math.max(1, this.library.getSettings().concurrency), async (f) => {
        const existing = this.library.getByPath(f.path);
        let fingerprint = "";
        let needsHash = true;
        if (existing && !existing.missing && existing.fingerprint) {
          const sameSize = existing.size === f.size;
          const sameTime = Math.abs(existing.mtime - f.mtime) < 2;
          if (sameSize && sameTime) {
            fingerprint = existing.fingerprint;
            needsHash = false;
          }
        }
        if (needsHash) {
          const hashed = await fingerprintFile(f.path);
          fingerprint = hashed?.fingerprint ?? existing?.fingerprint ?? `size:${f.size}:${f.name}`;
          if (!hashed) this.progress.errors += 1;
        }
        done += 1;
        if (done % 50 === 0 || done === files.length) {
          this.patchProgress({ processed: done, currentPath: f.path });
        }
        const { relPath, dir } = relativize(root.path, f.path);
        entries.push({
          path: f.path,
          relPath,
          dir,
          name: f.name,
          ext: f.ext,
          kind: kindOf(f.ext),
          size: f.size,
          mtime: f.mtime,
          ctime: f.ctime,
          fingerprint
        });
      });
      const result = this.library.reconcileRoot(rootId, entries);
      this.library.markRootScanned(rootId, entries.length);
      this.emitRoots();
      const changed = [...result.added, ...result.updated, ...result.renamed.map((r) => r.item), ...result.revived, ...result.missing];
      if (changed.length) this.emitItems(changed);
      if (!opts.silent && (result.added.length || result.renamed.length || result.missing.length)) {
        const parts = [];
        if (result.added.length) parts.push(`\u65B0\u589E ${result.added.length} \u7BC7`);
        if (result.renamed.length) parts.push(`\u79FB\u52A8/\u6539\u540D ${result.renamed.length} \u7BC7`);
        if (result.missing.length) parts.push(`${result.missing.length} \u7BC7\u6587\u4EF6\u7F3A\u5931`);
        this.pushToast("info", `\u300C${root.name}\u300D${parts.join("\uFF0C")}`, `${entries.length} \u4E2A\u6587\u4EF6 \xB7 ${((Date.now() - started) / 1e3).toFixed(1)} \u79D2`, 5200, {
          itemIds: result.added.slice(0, 20).map((i) => i.id)
        });
      }
      for (const item of result.updated) {
        await this.reanchorForItem(item.id).catch(() => void 0);
      }
      this.patchProgress({ phase: "extracting", total: entries.length, processed: done });
      const needParse = entries.map((e) => this.library.getByPath(e.path)).filter((i) => !!i && i.parseState !== "ready");
      for (const item of needParse) this.enqueueExtract(item.id, false);
      this.patchProgress({
        active: this.queue.length > 0,
        phase: this.queue.length ? "extracting" : "done",
        total: needParse.length,
        processed: 0,
        finishedAt: Date.now(),
        currentPath: ""
      });
      this.journal.append("scan:root", { root: root.name, files: entries.length, added: result.added.length, missing: result.missing.length });
    } catch (err) {
      this.journal.append("scan:error", { rootId, message: err.message });
      this.pushToast("error", `\u626B\u63CF\u300C${root.name}\u300D\u5931\u8D25`, err.message);
    } finally {
      this.scanRunning.delete(rootId);
      if (!this.scanRunning.size && !this.queueRunning) {
        this.patchProgress({ active: false, phase: "done", finishedAt: Date.now() });
      }
    }
  }
  async scanAll() {
    for (const root of this.library.getRoots()) {
      if (!root.enabled) continue;
      void this.scanRoot(root.id).catch(() => void 0);
    }
  }
  // ------------------------------------------------------------ 监听
  startWatch(root) {
    if (this.stopping || this.watchers.has(root.id)) return;
    void (async () => {
      try {
        const chokidar = await import("chokidar");
        if (this.stopping) return;
        const watcher = chokidar.watch(root.path, {
          ignoreInitial: true,
          persistent: true,
          followSymlinks: false,
          depth: root.depth,
          awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
          ignored: (target) => {
            const base = path9.basename(target);
            if (!base) return false;
            if (isTempFileName(base)) return true;
            if (!base.includes(".") && isIgnoredDirName(base)) return true;
            return false;
          }
        });
        watcher.on("add", (p) => this.onFsAddOrChange(p, "add"));
        watcher.on("change", (p) => this.onFsAddOrChange(p, "change"));
        watcher.on("unlink", (p) => this.onFsUnlink(p));
        watcher.on("error", (err) => this.journal.append("watch:error", { root: root.name, message: String(err) }));
        if (this.stopping) {
          await watcher.close().catch(() => void 0);
          return;
        }
        this.watchers.set(root.id, watcher);
        this.journal.append("watch:start", { root: root.name });
      } catch (err) {
        this.journal.append("watch:fail", { root: root.name, message: err.message });
        this.pushToast("warn", "\u6587\u4EF6\u5939\u5B9E\u65F6\u76D1\u542C\u542F\u52A8\u5931\u8D25\uFF0C\u5DF2\u9000\u56DE\u5B9A\u65F6\u5DE1\u68C0", `${root.name}\uFF1A${err.message}`, 8e3);
      }
    })();
  }
  async closeWatch(rootId) {
    const w = this.watchers.get(rootId);
    if (!w) return;
    this.watchers.delete(rootId);
    await w.close().catch(() => void 0);
  }
  onFsAddOrChange(absPath, kind) {
    const prev = this.pendingTimers.get(absPath);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.pendingTimers.delete(absPath);
      void this.handleFsChange(absPath, kind).catch((err) => this.journal.append("fs:error", { path: absPath, message: err.message }));
    }, kind === "add" ? 350 : 600);
    this.pendingTimers.set(absPath, timer);
  }
  async handleFsChange(absPath, kind) {
    const name = path9.basename(absPath);
    if (isTempFileName(name)) return;
    const ext = (name.split(".").pop() ?? "").toLowerCase();
    const stat = await statSafe(absPath);
    if (!stat?.isFile) return;
    if (!shouldIncludeFile({ name, ext, size: stat.size, includeOtherFiles: this.library.getSettings().includeOtherFiles })) return;
    const root = this.library.rootForPath(absPath);
    if (!root) return;
    const hashed = await fingerprintFile(absPath);
    if (!hashed) return;
    const { relPath, dir } = relativize(root.path, absPath);
    const entry = {
      path: absPath,
      relPath,
      dir,
      name,
      ext,
      kind: kindOf(ext),
      size: stat.size,
      mtime: stat.mtime,
      ctime: stat.ctime,
      fingerprint: hashed.fingerprint
    };
    const { item, change, from } = this.library.reconcileEntry(root.id, entry);
    this.emitItems([item]);
    if (change === "added") {
      this.batch.added += 1;
      this.enqueueExtract(item.id, false);
    } else if (change === "updated") {
      this.batch.updated += 1;
      this.enqueueExtract(item.id, false);
      await this.reanchorForItem(item.id).catch(() => void 0);
      if (item.annotationCount > 0) {
        const list = this.annotations.list(item.id);
        const review = list.filter((a) => a.needsReview).length;
        if (review) this.pushToast("warn", `\u300A${item.title}\u300B\u6587\u4EF6\u5185\u5BB9\u5DF2\u66F4\u65B0`, `${review} \u6761\u6279\u6CE8\u9700\u8981\u786E\u8BA4\u4F4D\u7F6E`, 8e3, { itemIds: [item.id] });
      }
    } else if (change === "renamed") {
      this.batch.renamed += 1;
      this.pushToastDelayedRename(item, from);
    } else if (change === "revived") {
      this.batch.added += 1;
      this.enqueueExtract(item.id, false);
    }
    this.scheduleBatchToast();
  }
  renameNotices = [];
  pushToastDelayedRename(item, from) {
    this.renameNotices.push(item);
    void from;
  }
  onFsUnlink(absPath) {
    const key = `unlink:${absPath}`;
    const prev = this.pendingTimers.get(key);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.pendingTimers.delete(key);
      void (async () => {
        if (await exists(absPath)) return;
        const item = this.library.markMissingByPath(absPath);
        if (item) {
          this.emitItems([item]);
          this.batch.missing += 1;
          this.scheduleBatchToast();
          this.journal.append("fs:missing", { path: absPath, title: item.title });
        }
      })().catch(() => void 0);
    }, 2e3);
    this.pendingTimers.set(key, timer);
  }
  scheduleBatchToast() {
    if (this.batch.timer) return;
    this.batch.timer = setTimeout(() => {
      this.batch.timer = null;
      const { added, updated, renamed, missing } = this.batch;
      this.batch.added = 0;
      this.batch.updated = 0;
      this.batch.renamed = 0;
      this.batch.missing = 0;
      const parts = [];
      const ids = [];
      if (added) parts.push(`\u5DF2\u6DFB\u52A0 ${added} \u7BC7`);
      if (updated) parts.push(`${updated} \u7BC7\u5185\u5BB9\u5DF2\u66F4\u65B0`);
      if (renamed) {
        parts.push(`${renamed} \u7BC7\u5DF2\u79FB\u52A8/\u6539\u540D`);
        if (this.renameNotices.length) {
          const first = this.renameNotices[0];
          ids.push(first.id);
          parts[parts.length - 1] += `\uFF08\u5982\u300A${first.title.slice(0, 18)}\u300B\uFF09`;
        }
        this.renameNotices = [];
      }
      if (missing) parts.push(`${missing} \u7BC7\u6587\u4EF6\u7F3A\u5931\uFF08\u6761\u76EE\u5DF2\u4FDD\u7559\uFF09`);
      if (!parts.length) return;
      this.refreshRootCounts();
      this.pushToast(missing ? "warn" : "success", parts.join("\uFF0C"), "\u6587\u4EF6\u5939\u91CC\u7684\u53D8\u5316\u5DF2\u81EA\u52A8\u540C\u6B65\u5230\u8F6F\u4EF6\u5185", 6e3, { itemIds: ids });
    }, 900);
  }
  scheduleReconcile() {
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    const interval = this.library.getSettings().reconcileIntervalMs;
    if (!interval || interval <= 0) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcileAll().catch(() => void 0);
      this.scheduleReconcile();
    }, interval);
    this.reconcileTimer.unref?.();
  }
  /** 一致性巡检：修补极端情况下丢失的文件系统事件 */
  async reconcileAll() {
    for (const root of this.library.getRoots()) {
      if (!root.enabled) continue;
      await this.scanRoot(root.id, { silent: true }).catch(() => void 0);
    }
  }
  // ------------------------------------------------------------ 抽取队列
  enqueueExtract(itemId, deep) {
    if (!this.queue.some((q) => q.itemId === itemId)) this.queue.push({ itemId, deep });
    void this.runQueue();
  }
  async runQueue() {
    if (this.queueRunning) return;
    this.queueRunning = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0, Math.max(1, this.library.getSettings().concurrency * 2));
        await mapLimit(batch, Math.max(1, this.library.getSettings().concurrency), async (task) => {
          const item = this.library.get(task.itemId);
          if (!item) return;
          await this.extractOne(item, task.deep).catch((err) => {
            this.library.patchItem(item.id, { parseState: "failed", parseError: err.message });
          });
        });
        this.patchProgress({
          active: this.progress.active || this.queue.length > 0,
          phase: this.queue.length ? "extracting" : "done",
          processed: this.progress.processed + batch.length
        });
      }
    } finally {
      this.queueRunning = false;
      if (!this.scanRunning.size) this.patchProgress({ active: false, phase: "done", finishedAt: Date.now() });
    }
  }
  /** S3：抽取一篇的元数据（必要时含全文索引） */
  async extractOne(item, deep) {
    if (item.missing) {
      this.library.patchItem(item.id, { parseState: "indexed" });
      return;
    }
    const stat = await statSafe(item.path);
    if (!stat?.isFile) {
      this.library.patchItem(item.id, { missing: true, missingSince: Date.now() });
      const updated = this.library.get(item.id);
      if (updated) this.emitItems([updated]);
      return;
    }
    let patch = {};
    try {
      if (item.kind === "pdf") {
        const info = await extractPdf(item.path, { headPages: 3 });
        if (!info.ok) {
          patch = { parseState: "failed", parseError: info.error ?? "\u65E0\u6CD5\u89E3\u6790 PDF", pageCount: item.pageCount };
        } else {
          const nameGuess = guessFromFileName(item.name);
          const pdfTitle = sanitizeTitle(info.title);
          const usePdfTitle = titleQuality(pdfTitle) >= 4 && titleQuality(pdfTitle) >= titleQuality(nameGuess.title);
          const authors = info.author ? info.author.split(/\s*(?:;|,| and |、|，)\s*/i).map((s) => s.trim()).filter((s) => s.length > 1 && s.length < 60) : [];
          const doi = extractDoi(info.headText) || extractDoi(info.subject) || extractDoi(info.keywords);
          const arxivId = extractArxivId(info.headText) || extractArxivId(item.name);
          const year = info.creationDate ? Number(info.creationDate.slice(0, 4)) : null;
          patch = {
            title: usePdfTitle ? pdfTitle : item.title,
            authors: authors.length ? authors : item.authors,
            year: year && year > 1900 && year < 2100 ? year : item.year,
            doi: doi || item.doi,
            arxivId: arxivId || item.arxivId,
            url: doi ? `https://doi.org/${doi}` : arxivId ? `https://arxiv.org/abs/${arxivId}` : item.url,
            keywords: info.keywords ? info.keywords.split(/[;,、，]/).map((s) => s.trim()).filter(Boolean).slice(0, 24) : item.keywords,
            language: /[\u4e00-\u9fa5]/.test(info.headText.slice(0, 400)) ? "zh" : item.language || "en",
            pageCount: info.pageCount,
            excerpt: info.headText.replace(/\s+/g, " ").slice(0, 400),
            parseState: "ready",
            parseError: void 0,
            progress: { ...item.progress, total: info.pageCount }
          };
        }
      } else if (item.kind === "text" || item.kind === "markdown") {
        const { text } = await readTextFileSmart(item.path);
        const trimmed = text.slice(0, 2e5);
        const { words } = countWords(trimmed);
        const heading = item.kind === "markdown" ? trimmed.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() : "";
        patch = {
          title: titleQuality(heading ?? "") >= 4 ? sanitizeTitle(heading) : item.title,
          wordCount: words,
          excerpt: htmlToText(trimmed).replace(/\s+/g, " ").slice(0, 400),
          pageCount: 1,
          parseState: "ready"
        };
      } else if (item.kind === "html") {
        const { text } = await readTextFileSmart(item.path);
        const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
        const plain = htmlToText(text);
        patch = {
          title: title && titleQuality(title) >= 4 ? sanitizeTitle(title) : item.title,
          wordCount: countWords(plain).words,
          excerpt: plain.replace(/\s+/g, " ").slice(0, 400),
          pageCount: 1,
          parseState: "ready"
        };
      } else if (item.kind === "docx") {
        const mammoth = await import("mammoth");
        const res = await mammoth.extractRawText({ path: longPath(item.path) });
        const text = res.value ?? "";
        patch = {
          wordCount: countWords(text).words,
          excerpt: text.replace(/\s+/g, " ").slice(0, 400),
          pageCount: 1,
          parseState: "ready"
        };
      } else if (item.kind === "epub") {
        const { extractEpub: extractEpub2 } = await Promise.resolve().then(() => (init_epub(), epub_exports));
        const book = await extractEpub2(item.path);
        if (book) {
          patch = {
            title: titleQuality(book.title) >= 4 ? sanitizeTitle(book.title) : item.title,
            authors: book.authors.length ? book.authors : item.authors,
            language: book.language || item.language,
            pageCount: book.chapters.length,
            excerpt: book.chapters[0] ? htmlToText(book.chapters[0].html).slice(0, 400) : item.excerpt,
            parseState: "ready",
            progress: { ...item.progress, total: book.chapters.length }
          };
        } else {
          patch = { parseState: "failed", parseError: "EPUB \u89E3\u6790\u5931\u8D25" };
        }
      } else if (item.kind === "image") {
        patch = { pageCount: 1, parseState: "ready", excerpt: "" };
      } else {
        patch = { parseState: "indexed" };
      }
    } catch (err) {
      patch = { parseState: "failed", parseError: err.message };
    }
    const applied = this.library.applyMetadata(item.id, patch);
    let next = applied?.item ?? this.library.get(item.id);
    if (!next) return;
    const settings = this.library.getSettings();
    if (settings.autoMetadata && settings.onlineMetadata && (next.doi || next.arxivId || next.title && next.parseState === "ready")) {
      const filled = await this.completeOne(next).catch(() => null);
      if (filled) next = filled;
    }
    if (settings.fullTextIndex === "all" || settings.fullTextIndex === "opened-only" && next.openCount > 0 || deep) {
      await this.indexText(next).catch(() => void 0);
      next = this.library.get(item.id) ?? next;
    }
    this.emitItems([next]);
  }
  async completeOne(item) {
    let meta = null;
    if (item.doi) meta = await this.metadata.lookupDoi(item.doi);
    else if (item.arxivId) meta = await this.metadata.lookupArxiv(item.arxivId);
    else if (item.title && titleQuality(item.title) >= 4) meta = await this.metadata.searchByTitle(item.title, item.year);
    if (!meta) return null;
    const patch = {};
    if (meta.title) patch.title = sanitizeTitle(meta.title);
    if (meta.authors?.length) patch.authors = meta.authors;
    if (meta.year) patch.year = meta.year;
    if (meta.venue) patch.venue = meta.venue;
    if (meta.volume) patch.volume = meta.volume;
    if (meta.issue) patch.issue = meta.issue;
    if (meta.pages) patch.pages = meta.pages;
    if (meta.doi) patch.doi = meta.doi;
    if (meta.url) patch.url = meta.url;
    if (meta.abstract) patch.abstract = meta.abstract;
    if (meta.keywords?.length) patch.keywords = meta.keywords;
    const res = this.library.applyMetadata(item.id, patch);
    return res?.item ?? null;
  }
  async completeMetadata(ids) {
    let updated = 0;
    let failed = 0;
    let skipped = 0;
    for (const id of ids) {
      const item = this.library.get(id);
      if (!item) continue;
      if (!item.doi && !item.arxivId && titleQuality(item.title) < 4) {
        skipped += 1;
        continue;
      }
      const before = JSON.stringify([item.title, item.authors, item.year, item.venue]);
      const after = await this.completeOne(item).catch(() => null);
      if (!after) {
        failed += 1;
        continue;
      }
      const now = JSON.stringify([after.title, after.authors, after.year, after.venue]);
      if (now !== before) {
        updated += 1;
        this.emitItems([after]);
      } else {
        skipped += 1;
      }
    }
    if (updated) this.pushToast("success", `\u5DF2\u8865\u5168 ${updated} \u7BC7\u7684\u5143\u6570\u636E`, failed ? `${failed} \u7BC7\u672A\u627E\u5230` : void 0);
    else this.pushToast("info", "\u6CA1\u6709\u53EF\u8865\u5168\u7684\u65B0\u4FE1\u606F", failed ? `\u8054\u7F51\u67E5\u8BE2\u5931\u8D25 ${failed} \u7BC7` : "\u53EF\u80FD\u662F\u7F51\u7EDC\u4E0D\u901A\u6216\u6587\u732E\u4E0D\u5728 Crossref/arXiv \u4E2D");
    return { updated, failed, skipped };
  }
  async indexText(item) {
    if (!item.readable || item.missing) return { ok: false, pages: 0 };
    const text = await extractTextForIndex(item.path, item.kind);
    if (!text) return { ok: false, pages: 0 };
    await this.textIndex.write(item, text.pages);
    this.library.patchItem(item.id, {
      textIndexed: true,
      wordCount: text.wordCount || item.wordCount,
      pageCount: item.kind === "pdf" ? item.pageCount : Math.max(item.pageCount, text.pages.length)
    });
    const next = this.library.get(item.id);
    if (next) this.emitItems([next]);
    return { ok: true, pages: text.pages.length };
  }
  async indexItemText(itemId) {
    const item = this.library.get(itemId);
    if (!item) return { ok: false, pages: 0 };
    const res = await this.indexText(item);
    const next = this.library.get(itemId);
    if (next) this.emitItems([next]);
    return res;
  }
  async getItemText(itemId) {
    const pages = await this.textIndex.load(itemId);
    if (!pages) return null;
    return { pages, indexedAt: Date.now() };
  }
  // ------------------------------------------------------------ 批注重定位
  async reanchorForItem(itemId) {
    const list = this.annotations.list(itemId);
    if (!list.length) return;
    const item = this.library.get(itemId);
    if (!item) return;
    const text = await extractTextForIndex(item.path, item.kind);
    if (!text) return;
    const nextList = [];
    let changed = 0;
    for (const a of list) {
      const outcome = reanchorAnnotation(a, text.pages);
      if (outcome.changed) changed += 1;
      nextList.push(outcome.annotation);
    }
    if (changed) {
      this.annotations.replaceForItem(itemId, nextList);
      this.syncAnnotationCounts(itemId);
      const updated = this.library.get(itemId);
      if (updated) this.emitItems([updated]);
      this.journal.append("annotations:reanchored", { itemId, changed });
    }
  }
  syncAnnotationCounts(itemId) {
    const counts = this.annotations.counts();
    const ids = itemId ? [itemId] : [...counts.keys(), ...this.library.all().filter((i) => i.annotationCount > 0).map((i) => i.id)];
    for (const id of new Set(ids)) {
      const item = this.library.get(id);
      const count = counts.get(id) ?? 0;
      if (item && item.annotationCount !== count) this.library.patchItem(id, { annotationCount: count });
    }
  }
  // ------------------------------------------------------------ 文件访问
  resolveFile(itemId) {
    const item = this.library.get(itemId);
    if (!item || item.missing) return null;
    return { path: item.path, size: item.size, ext: item.ext, revision: item.revision, kind: item.kind };
  }
  async readTextFile(itemId) {
    const resolved = this.resolveFile(itemId);
    if (!resolved) return null;
    const stat = await statSafe(resolved.path);
    if (!stat?.isFile) return null;
    if (stat.size > 8 * 1024 * 1024) return null;
    return readTextFileSmart(resolved.path);
  }
  async saveThumb(itemId, dataUrl, revision) {
    const item = this.library.get(itemId);
    if (!item || item.revision !== revision) return null;
    const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    if (!match) return null;
    const ext = match[1] === "image/png" ? "png" : match[1] === "image/webp" ? "webp" : "jpg";
    const name = `${item.id}-r${revision}.${ext}`;
    try {
      await ensureDir2(this.thumbsDir);
      await writeFileAtomicSafe(path9.join(this.thumbsDir, name), Buffer.from(match[2], "base64"));
    } catch {
      return null;
    }
    this.library.patchItem(itemId, { thumb: name });
    const next = this.library.get(itemId);
    if (next) this.emitItems([next]);
    return name;
  }
  thumbPath(name) {
    return path9.join(this.thumbsDir, name);
  }
  // ------------------------------------------------------------ 笔记
  async writeNoteFile(item) {
    await ensureDir2(this.notesDir);
    const file = path9.join(this.notesDir, `${item.id}.md`);
    await writeFileAtomicSafe(file, `<!-- ${item.title} -->

${item.note}`);
  }
  /** 把外部编辑过的笔记文件读回来（软件内与磁盘双向同步） */
  async restoreNotesFromDisk() {
    for (const item of this.library.all()) {
      const file = path9.join(this.notesDir, `${item.id}.md`);
      try {
        const text = await fs7.readFile(longPath(file), "utf8");
        const body = text.replace(/^<!--[\s\S]*?-->\s*/, "");
        if (body.trim() && body.trim() !== item.note.trim()) {
          this.journal.append("note:adopt-external", { itemId: item.id, chars: body.length });
          this.library.patchItem(item.id, { note: body });
        }
      } catch {
      }
    }
  }
  async setNote(itemId, markdown) {
    const item = this.library.editItem(itemId, { note: markdown }, ["note"]);
    if (!item) return null;
    this.noteDirty.add(itemId);
    await this.writeNoteFile(item).catch(() => void 0);
    this.noteDirty.delete(itemId);
    this.emitItems([item]);
    return item;
  }
  // ------------------------------------------------------------ 批注 API
  listAnnotations(itemId) {
    return this.annotations.list(itemId);
  }
  listAllAnnotations() {
    return this.annotations.all();
  }
  addAnnotation(input) {
    const a = this.annotations.add(input);
    this.syncAnnotationCounts(a.itemId);
    const item = this.library.get(a.itemId);
    if (item) this.emitItems([item]);
    return a;
  }
  updateAnnotation(id, patch) {
    const a = this.annotations.update(id, patch);
    if (!a) return null;
    const item = this.library.get(a.itemId);
    if (item) this.emitItems([item]);
    return a;
  }
  deleteAnnotation(id) {
    const itemId = this.annotations.remove(id);
    if (!itemId) return null;
    this.syncAnnotationCounts(itemId);
    const item = this.library.get(itemId);
    if (item) this.emitItems([item]);
    return itemId;
  }
  reanchorAnnotation(id, page, rects, text) {
    const a = this.annotations.get(id);
    if (!a) return null;
    const next = this.annotations.update(id, {
      page,
      rects,
      text: text ?? a.text,
      reanchored: true,
      needsReview: false,
      reanchorNote: `\u6309\u6587\u672C\u91CD\u65B0\u5B9A\u4F4D\u5230 P${page}`
    });
    const item = this.library.get(a.itemId);
    if (item) this.emitItems([item]);
    return next;
  }
  // ------------------------------------------------------------ 检索
  async search(query, limit = 300) {
    const trimmed = query.trim();
    const items = this.library.all();
    if (!trimmed) {
      return items.slice(0, limit).map((item) => ({ item, score: 0, fields: [], contexts: [] }));
    }
    const annotationsFor = (id) => this.annotations.list(id);
    const sync = searchItems(items, trimmed, { text: (id) => this.textIndex.get(id), annotations: annotationsFor }, limit);
    if (sync.length >= limit) return sync;
    const q = parseQuery(trimmed);
    const needsFullText = q.terms.length > 0 || q.phrases.length > 0;
    if (!needsFullText) return sync;
    const already = new Set(sync.map((r) => r.item.id));
    const candidates = items.filter((i) => i.textIndexed && !already.has(i.id));
    if (!candidates.length) return sync;
    const extra = [];
    let budget = 400;
    for (const item of candidates) {
      if (budget-- <= 0) break;
      if (this.textIndex.has(item.id)) continue;
      const pages = await this.textIndex.load(item.id).catch(() => null);
      if (!pages) continue;
      const res = searchItems([item], trimmed, { text: () => pages, annotations: annotationsFor }, 1);
      if (res.length) extra.push(res[0]);
      if (sync.length + extra.length >= limit) break;
    }
    return [...sync, ...extra].sort((a, b) => b.score - a.score).slice(0, limit);
  }
  // ------------------------------------------------------------ 导出
  async exportLibrary(opts) {
    const items = opts.ids?.length ? opts.ids.map((id) => this.library.get(id)).filter(Boolean) : this.library.all();
    const content = exportContent(items, opts, (id) => this.annotations.list(id));
    const name = `litshelf-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.${EXPORT_EXT[opts.format]}`;
    if (this.mode === "electron") {
      const target = path9.join(this.dataDir, "exports", name);
      await ensureDir2(path9.dirname(target));
      await writeFileAtomicSafe(target, content);
      return { ok: true, content, savedTo: target, count: items.length };
    }
    return { ok: true, content, savedTo: name, count: items.length };
  }
  copyCitation(itemId, style) {
    const item = this.library.get(itemId);
    if (!item) return "";
    return formatCitation(item, style);
  }
  // ------------------------------------------------------------ 维护
  async rebuildIndex() {
    await this.textIndex.clear();
    for (const item of this.library.all()) {
      this.library.patchItem(item.id, { parseState: "placeholder", textIndexed: false, thumb: null });
    }
    this.pushToast("info", "\u6B63\u5728\u91CD\u5EFA\u7D22\u5F15", "\u7528\u6237\u6570\u636E\uFF08\u6807\u7B7E\u3001\u7B14\u8BB0\u3001\u6279\u6CE8\u3001\u9605\u8BFB\u8FDB\u5EA6\uFF09\u4E0D\u53D7\u5F71\u54CD");
    await this.scanAll();
  }
  async clearCache(kind) {
    if (kind === "thumbs" || kind === "all") {
      await rmSafe(this.thumbsDir, true);
      await ensureDir2(this.thumbsDir);
      for (const item of this.library.all()) {
        if (item.thumb) this.library.patchItem(item.id, { thumb: null });
      }
    }
    if (kind === "text" || kind === "all") {
      await this.textIndex.clear();
      for (const item of this.library.all()) {
        if (item.textIndexed) this.library.patchItem(item.id, { textIndexed: false });
      }
    }
    this.emitItems(this.library.all());
    this.pushToast("success", "\u7F13\u5B58\u5DF2\u6E05\u7406");
  }
  async exportDiagnostics() {
    const payload = {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      version: this.version,
      mode: this.mode,
      platform: process.platform,
      node: process.version,
      dataDir: this.dataDir,
      settings: this.library.getSettings(),
      roots: this.library.getRoots(),
      stats: {
        items: this.library.size(),
        missing: this.library.all().filter((i) => i.missing).length,
        ready: this.library.all().filter((i) => i.parseState === "ready").length,
        failed: this.library.all().filter((i) => i.parseState === "failed").length,
        textIndexed: this.library.all().filter((i) => i.textIndexed).length,
        annotations: this.annotations.all().length,
        textIndex: this.textIndex.stats()
      },
      progress: this.getProgress(),
      journal: this.journal.tailSync(120)
    };
    const content = JSON.stringify(payload, null, 2);
    if (this.mode === "electron") {
      const target = path9.join(this.dataDir, "exports", `litshelf-diagnostics-${Date.now()}.json`);
      await ensureDir2(path9.dirname(target));
      await writeFileAtomicSafe(target, content);
      return { ok: true, savedTo: target, content };
    }
    return { ok: true, content, savedTo: "litshelf-diagnostics.json" };
  }
  // ------------------------------------------------------------ 根目录管理
  async addRoot(dirPath, opts = {}) {
    const stat = await statSafe(dirPath);
    if (!stat?.isDir) throw new Error(`\u4E0D\u662F\u6709\u6548\u7684\u6587\u4EF6\u5939\uFF1A${dirPath}`);
    const real = await fs7.realpath(longPath(dirPath)).catch(() => path9.resolve(dirPath));
    const root = this.library.addRoot(real, { depth: opts.depth });
    this.emitRoots();
    await this.scanRoot(root.id).catch(() => void 0);
    this.startWatch(root);
    const added = this.library.all().filter((i) => i.rootId === root.id).length;
    return { root, added };
  }
  async removeRoot(rootId, opts = {}) {
    await this.closeWatch(rootId);
    const removed = this.library.removeRoot(rootId, opts);
    if (opts.forgetItems) {
      for (const id of removed) this.annotations.removeForItem(id);
      this.emit({ type: "items:remove", ids: removed });
    } else {
      const orphanIds = this.library.all().filter((i) => i.rootId === rootId).map((i) => i.id);
      this.library.patchItems(orphanIds, { missing: true, missingSince: Date.now() });
      this.emitItems(orphanIds.map((id) => this.library.get(id)).filter(Boolean));
    }
    this.emitRoots();
  }
  setRootEnabled(rootId, enabled) {
    this.library.setRootEnabled(rootId, enabled);
    const root = this.library.getRoot(rootId);
    if (!root) return;
    if (enabled) {
      void this.scanRoot(rootId).catch(() => void 0);
      this.startWatch(root);
    } else {
      void this.closeWatch(rootId);
    }
    this.emitRoots();
  }
  // ------------------------------------------------------------ 条目操作（含撤销）
  updateItem(itemId, patch) {
    const userFields = ["title", "authors", "year", "venue", "volume", "issue", "pages", "doi", "url", "abstract", "keywords"].filter((k) => k in patch).map((k) => k);
    const item = userFields.length ? this.library.editItem(itemId, patch, userFields) : this.library.patchItem(itemId, patch);
    if (item) this.emitItems([item]);
    return item;
  }
  updateItems(ids, patch) {
    const items = this.library.patchItems(ids, patch);
    this.emitItems(items);
    return items;
  }
  pushUndo(name, run) {
    this.undoStack.push({ name, at: Date.now(), run });
    if (this.undoStack.length > 30) this.undoStack.shift();
  }
  async undo(name) {
    const idx = [...this.undoStack].reverse().findIndex((u) => u.name === name);
    if (idx < 0) return false;
    const realIdx = this.undoStack.length - 1 - idx;
    const [entry] = this.undoStack.splice(realIdx, 1);
    await entry.run();
    this.undoStack = this.undoStack.filter((u) => Date.now() - u.at < 10 * 60 * 1e3);
    this.journal.append("undo", { name });
    return true;
  }
  deleteItems(ids, opts = {}) {
    const snapshot = ids.map((id) => ({ item: this.library.get(id), annotations: this.annotations.list(id) })).filter((s) => !!s.item);
    for (const id of ids) {
      this.annotations.removeForItem(id);
      this.library.deleteItem(id);
    }
    this.emit({ type: "items:remove", ids });
    this.emitTags();
    this.pushUndo("deleteItems", async () => {
      for (const { item, annotations } of snapshot) {
        this.restoreItemInternal(item, annotations);
      }
      this.emitItems(snapshot.map((s) => s.item));
      this.emitTags();
    });
    const hint = opts.alsoDeleteFile ? "\uFF08\u542B\u78C1\u76D8\u6587\u4EF6\uFF09" : "\uFF08\u78C1\u76D8\u6587\u4EF6\u672A\u52A8\uFF09";
    this.pushToast("success", `\u5DF2\u4ECE\u5E93\u4E2D\u79FB\u9664 ${ids.length} \u6761`, `\u7B14\u8BB0\u4E0E\u6279\u6CE8\u53EF\u64A4\u9500\u6062\u590D${hint}`, 9e3, {
      action: { label: "\u64A4\u9500", name: "deleteItems" }
    });
    this.journal.append("items:delete", { ids: ids.length });
  }
  restoreItemInternal(item, annotations) {
    this.library.restoreItem(item);
    if (annotations.length) this.annotations.replaceForItem(item.id, annotations);
  }
  async rebindItem(itemId, newPath) {
    const item = await this.library.rebindItem(itemId, newPath);
    if (!item) return null;
    this.emitItems([item]);
    this.enqueueExtract(item.id, false);
    return item;
  }
  markOpened(itemId) {
    const item = this.library.get(itemId);
    if (!item) return null;
    const next = this.library.patchItem(itemId, {
      openCount: item.openCount + 1,
      lastOpenedAt: Date.now(),
      readState: item.readState === "unread" ? "reading" : item.readState
    });
    if (!next) return null;
    const settings = this.library.getSettings();
    if (settings.fullTextIndex !== "off" && !next.textIndexed) {
      void this.indexText(next).catch(() => void 0);
    }
    this.emitItems([next]);
    return next;
  }
  setProgress(itemId, progress) {
    const item = this.library.get(itemId);
    if (!item) return;
    const next = { ...item.progress, ...progress, updatedAt: Date.now() };
    if (next.total && next.page) next.percent = Math.min(100, Math.max(0, next.page / next.total * 100));
    const updated = this.library.patchItem(itemId, {
      progress: next,
      readState: item.readState === "unread" ? "reading" : item.readState
    });
    if (updated) this.emitItems([updated]);
  }
  getFolderTree() {
    return this.library.getRoots().map((root) => {
      const dirs = /* @__PURE__ */ new Set();
      for (const item of this.library.all()) {
        if (item.rootId !== root.id) continue;
        if (item.dir) dirs.add(item.dir);
      }
      return {
        rootId: root.id,
        rootName: root.name,
        rootPath: root.path,
        dirs: [...dirs].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
      };
    });
  }
  /** 供设置页显示：库统计 */
  stats() {
    const items = this.library.all();
    return {
      items: items.length,
      missing: items.filter((i) => i.missing).length,
      ready: items.filter((i) => i.parseState === "ready").length,
      failed: items.filter((i) => i.parseState === "failed").length,
      textIndexed: items.filter((i) => i.textIndexed).length,
      annotations: this.annotations.all().length,
      roots: this.library.getRoots().length,
      diskLabel: humanSize(items.reduce((n, i) => n + i.size, 0))
    };
  }
  // ------------------------------------------------------------ 批量条目操作
  getItem(itemId) {
    return this.library.get(itemId);
  }
  listTags() {
    return this.library.tags();
  }
  setReadState(ids, state) {
    const before = ids.map((id) => ({ id, readState: this.library.get(id)?.readState ?? "unread" }));
    const items = this.library.patchItems(ids, { readState: state });
    this.emitItems(items);
    this.pushUndo("setReadState", async () => {
      for (const b of before) this.library.patchItem(b.id, { readState: b.readState });
      this.emitItems(before.map((b) => this.library.get(b.id)).filter(Boolean));
    });
    return items;
  }
  toggleStar(ids) {
    const items = [];
    for (const id of ids) {
      const item = this.library.get(id);
      if (!item) continue;
      const next = this.library.patchItem(id, { starred: !item.starred });
      if (next) items.push(next);
    }
    this.emitItems(items);
    return items;
  }
  addTags(ids, tags) {
    const clean2 = tags.map((t) => t.trim()).filter(Boolean);
    if (!clean2.length) return [];
    const before = ids.map((id) => ({ id, tags: this.library.get(id)?.tags ?? [] }));
    const items = [];
    for (const id of ids) {
      const item = this.library.get(id);
      if (!item) continue;
      const next = this.library.patchItem(id, { tags: [.../* @__PURE__ */ new Set([...item.tags, ...clean2])] });
      if (next) items.push(next);
    }
    this.emitItems(items);
    this.emitTags();
    this.pushUndo("addTags", async () => {
      for (const b of before) this.library.patchItem(b.id, { tags: b.tags });
      this.emitItems(before.map((b) => this.library.get(b.id)).filter(Boolean));
      this.emitTags();
    });
    return items;
  }
  removeTags(ids, tags) {
    const drop = new Set(tags);
    const before = ids.map((id) => ({ id, tags: this.library.get(id)?.tags ?? [] }));
    const items = [];
    for (const id of ids) {
      const item = this.library.get(id);
      if (!item) continue;
      const next = this.library.patchItem(id, { tags: item.tags.filter((t) => !drop.has(t)) });
      if (next) items.push(next);
    }
    this.emitItems(items);
    this.emitTags();
    this.pushUndo("removeTags", async () => {
      for (const b of before) this.library.patchItem(b.id, { tags: b.tags });
      this.emitItems(before.map((b) => this.library.get(b.id)).filter(Boolean));
      this.emitTags();
    });
    return items;
  }
  renameTag(from, to) {
    const target = to.trim();
    const affected = [];
    for (const item of this.library.all()) {
      if (!item.tags.includes(from)) continue;
      affected.push({ id: item.id, tags: item.tags });
      const next = target ? [...new Set(item.tags.map((t) => t === from ? target : t))] : item.tags.filter((t) => t !== from);
      this.library.patchItem(item.id, { tags: next });
    }
    this.emitItems(affected.map((a) => this.library.get(a.id)).filter(Boolean));
    this.emitTags();
    this.pushUndo("renameTag", async () => {
      for (const a of affected) this.library.patchItem(a.id, { tags: a.tags });
      this.emitItems(affected.map((a) => this.library.get(a.id)).filter(Boolean));
      this.emitTags();
    });
  }
  deleteTag(tag) {
    this.renameTag(tag, "");
  }
  restoreItems(ids) {
    const items = [];
    for (const id of ids) {
      const item = this.library.get(id);
      if (!item) continue;
      const next = this.library.patchItem(id, { missing: false, missingSince: null });
      if (next) items.push(next);
    }
    this.emitItems(items);
    return items;
  }
  updateSettings(patch) {
    this.library.updateSettings(patch);
    const settings = this.library.getSettings();
    this.metadata.setOnline(settings.onlineMetadata);
    this.settingsFile.set(settings);
    void this.settingsFile.flushNow().catch(() => void 0);
    if ("reconcileIntervalMs" in patch) this.scheduleReconcile();
    if ("fullTextIndex" in patch && settings.fullTextIndex === "all") {
      this.pushToast("info", "\u6B63\u5728\u4E3A\u5168\u5E93\u5EFA\u7ACB\u5168\u6587\u7D22\u5F15", "\u53EF\u4EE5\u7EE7\u7EED\u6B63\u5E38\u4F7F\u7528\uFF0C\u7D22\u5F15\u5728\u540E\u53F0\u8FDB\u884C");
      for (const item of this.library.all()) {
        if (!item.textIndexed && item.readable) this.enqueueExtract(item.id, true);
      }
    }
    this.emitSettings();
    return settings;
  }
  /** 批量刷新根目录计数（事件批次结束后调用一次，避免每条文件走一遍 O(n)） */
  refreshRootCounts() {
    for (const root of this.library.getRoots()) {
      const count = this.library.all().filter((i) => i.rootId === root.id).length;
      if (count !== root.itemCount) this.library.markRootScanned(root.id, count);
    }
    this.emitRoots();
  }
};

// src/core/sample.ts
init_paths();
import fs8 from "node:fs/promises";
import path10 from "node:path";
var DEFAULT_SECTIONS = [
  "Introduction",
  "Related Work",
  "Method",
  "Experiments",
  "Results",
  "Discussion",
  "Conclusion",
  "Appendix"
];
var PAPERS = [
  {
    file: "Zhang et al. - 2023 - Deep Learning for Medical Imaging.pdf",
    title: "Deep Learning for Medical Imaging: A Practical Review",
    author: "Wei Zhang, Li Chen, Marco Rossi",
    year: 2023,
    venue: "IEEE Transactions on Medical Imaging",
    pages: 6,
    doi: "10.1109/TMI.2023.3141592",
    sections: ["Introduction", "Data and Preprocessing", "Network Architectures", "Experiments", "Results", "Conclusion"]
  },
  {
    file: "2021_Wang_Graph Neural Networks.pdf",
    title: "Graph Neural Networks for Citation Analysis",
    author: "Hui Wang",
    year: 2021,
    venue: "Journal of Informetrics",
    pages: 5,
    doi: "10.1016/j.joi.2021.101234",
    sections: ["Introduction", "Message Passing", "Citation Graph Benchmark", "Ablation Study", "Conclusion"]
  },
  {
    file: "\u674E\u96F7 - 2022 - \u4E2D\u6587\u6587\u732E\u793A\u4F8B.pdf",
    title: "A Chinese Sample Paper on Local Literature Management",
    author: "Li Lei",
    year: 2022,
    venue: "Journal of Digital Libraries (China)",
    pages: 4,
    sections: ["Introduction", "Local Library Design", "Evaluation", "Conclusion"]
  },
  {
    file: "Attention Is All You Need (2017).pdf",
    title: "Attention Is All You Need",
    author: "Ashish Vaswani, Noam Shazeer, Niki Parmar",
    year: 2017,
    venue: "Advances in Neural Information Processing Systems",
    pages: 8,
    doi: "10.48550/arXiv.1706.03762",
    sections: [
      "Introduction",
      "Background",
      "Model Architecture",
      "Why Self-Attention",
      "Training",
      "Results",
      "Conclusion",
      "Attention Visualizations"
    ]
  },
  {
    file: "\u5B50\u76EE\u5F55/\u97E9\u6885\u6885 \u7B49 - 2024 - \u9762\u5411\u4E2D\u6587\u7684\u6587\u732E\u9605\u8BFB.pdf",
    title: "Reading Chinese Papers on a Local Shelf",
    author: "Han Meimei, Li Lei",
    year: 2024,
    venue: "\u4E2D\u6587\u4FE1\u606F\u5B66\u62A5 (sample)",
    pages: 3,
    sections: ["Introduction", "Layout and Typography", "Conclusion"]
  },
  {
    file: "Vaswani et al. - 2018 - Transformer Architectures Survey.pdf",
    title: "Transformer Architectures: A Survey of Variants",
    author: "Ashish Vaswani, Jakob Uszkoreit",
    year: 2018,
    venue: "arXiv preprint",
    pages: 7,
    sections: ["Introduction", "Encoder Variants", "Decoder Variants", "Efficient Attention", "Pretraining", "Open Problems", "Conclusion"]
  },
  {
    file: "2020_Chen_Contrastive Learning Survey.pdf",
    title: "Contrastive Learning: A Survey",
    author: "Ting Chen, Simon Kornblith",
    year: 2020,
    venue: "IEEE TPAMI",
    pages: 5,
    doi: "10.1109/TPAMI.2020.2988765",
    sections: ["Introduction", "Instance Discrimination", "MoCo and SimCLR", "Evaluation Protocols", "Conclusion"]
  },
  {
    file: "Smith & Jones (2019) - Reinforcement Learning Basics.pdf",
    title: "Reinforcement Learning Basics for Practitioners",
    author: "John Smith, Mary Jones",
    year: 2019,
    venue: "MIT Press (sample chapter)",
    pages: 4,
    sections: ["Markov Decision Processes", "Value Iteration", "Policy Gradients", "Conclusion"]
  }
];
var DOCS = [
  {
    file: "\u9605\u8BFB\u7B14\u8BB0 - \u6DF1\u5EA6\u5B66\u4E60\u7EFC\u8FF0.md",
    content: `# \u9605\u8BFB\u7B14\u8BB0\uFF1A\u6DF1\u5EA6\u5B66\u4E60\u7EFC\u8FF0

## \u4E00\u53E5\u8BDD\u603B\u7ED3
\u8FD9\u7BC7\u7EFC\u8FF0\u628A\u533B\u5B66\u5F71\u50CF\u91CC\u7684\u6DF1\u5EA6\u5B66\u4E60\u65B9\u6CD5\u6309"\u6570\u636E \u2192 \u7F51\u7EDC \u2192 \u8BC4\u4EF7"\u4E09\u6BB5\u505A\u4E86\u68B3\u7406\u3002

## \u8981\u70B9
1. \u6570\u636E\u9884\u5904\u7406\uFF08\u91CD\u91C7\u6837\u3001\u7A97\u5BBD\u7A97\u4F4D\u5F52\u4E00\u5316\uFF09\u5BF9\u7ED3\u679C\u7684\u5F71\u54CD\u5E38\u88AB\u4F4E\u4F30\u3002
2. \u5206\u5272\u4EFB\u52A1\u4E0A U-Net \u7CFB\u7ED3\u6784\u4ECD\u662F\u57FA\u7EBF\uFF1B\u5206\u7C7B\u4EFB\u52A1\u4E0A\u9884\u8BAD\u7EC3\u6743\u91CD\u8FC1\u79FB\u6536\u76CA\u6700\u5927\u3002
3. \u8BC4\u4EF7\u6307\u6807\u5FC5\u987B\u4E0E\u4E34\u5E8A\u76EE\u6807\u5BF9\u9F50\uFF0CAUC \u9AD8\u4E0D\u4EE3\u8868\u4E34\u5E8A\u53EF\u7528\u3002

## \u5F85\u529E
- [ ] \u590D\u73B0 Table 3 \u7684\u5B9E\u9A8C\u8BBE\u7F6E
- [ ] \u67E5\u4E00\u4E0B\u6587\u4E2D\u7684 DOI \u662F\u5426\u53EF\u89E3\u6790
- [ ] \u5728\u6587\u732E\u67B6\u91CC\u7ED9\u8FD9\u7BC7\u6253\u4E0A #\u7EFC\u8FF0 #\u533B\u5B66\u5F71\u50CF \u6807\u7B7E
`
  },
  {
    file: "2024 - Survey Notes on Graph Neural Networks.md",
    content: `# Survey Notes on Graph Neural Networks

- Message passing is the shared abstraction of most GNN variants.
- Over-smoothing: deeper stacks collapse node representations.
- Citation graphs are a natural benchmark for bibliographic tools.

> \u5907\u6CE8\uFF1A\u8FD9\u7BC7\u7684\u5F15\u7528\u683C\u5F0F\u5EFA\u8BAE\u7528 GB/T 7714\u3002
`
  },
  {
    file: "\u5B50\u76EE\u5F55/\u4E2D\u6587\u6587\u732E\u9605\u8BFB\u65B9\u6CD5.md",
    content: `# \u4E2D\u6587\u6587\u732E\u9605\u8BFB\u65B9\u6CD5

\u4E09\u904D\u8BFB\u6CD5\uFF1A
1. \u7B2C\u4E00\u904D\u770B\u6807\u9898\u3001\u6458\u8981\u3001\u56FE\u8868\uFF0C\u5224\u65AD\u8981\u4E0D\u8981\u7EE7\u7EED\u3002
2. \u7B2C\u4E8C\u904D\u770B\u65B9\u6CD5\u4E0E\u5B9E\u9A8C\u8BBE\u7F6E\uFF0C\u8BB0\u4E0B\u53EF\u590D\u73B0\u7684\u5173\u952E\u53C2\u6570\u3002
3. \u7B2C\u4E09\u904D\u9010\u6BB5\u7CBE\u8BFB\uFF0C\u628A\u6279\u6CE8\u5199\u8FDB\u9605\u8BFB\u5668\u91CC\uFF0C\u800C\u4E0D\u662F\u53E6\u5F00\u6587\u6863\u3002

\u653E\u5728\u5B50\u76EE\u5F55\u91CC\u662F\u4E3A\u4E86\u9A8C\u8BC1"\u76EE\u5F55\u6811"\u4E0E"\u6309\u6587\u4EF6\u5939\u5206\u7EC4"\u8FD9\u4E24\u5904\u754C\u9762\u3002
`
  },
  {
    file: "README - \u6587\u732E\u67B6\u4F7F\u7528\u8BF4\u660E.md",
    content: `# \u6587\u732E\u67B6 LitShelf \u793A\u4F8B\u6587\u732E

\u8FD9\u4E2A\u6587\u4EF6\u5939\u662F\u8F6F\u4EF6\u81EA\u52A8\u751F\u6210\u7684\u793A\u4F8B\u6570\u636E\uFF0C\u53EF\u4EE5\u968F\u65F6\u5220\u6389\u3002

- 8 \u7BC7 PDF \u7528\u4E8E\u9A8C\u8BC1\uFF1A\u5206\u9875\u9605\u8BFB\u3001\u9605\u8BFB\u4F4D\u7F6E\u8BB0\u5FC6\u3001\u7F29\u7565\u56FE\u3001\u5168\u6587\u68C0\u7D22\u3002
- 4 \u7BC7 Markdown \u4E0E 2 \u7BC7\u7EAF\u6587\u672C\u7528\u4E8E\u9A8C\u8BC1\uFF1A\u5185\u7F6E\u9605\u8BFB\u5668\u3001\u7B14\u8BB0\u3001\u5B57\u6570\u7EDF\u8BA1\u3002
- \u5B50\u76EE\u5F55 \u7528\u4E8E\u9A8C\u8BC1\uFF1A\u76EE\u5F55\u6811\u6D4F\u89C8\u4E0E\u6587\u4EF6\u5939\u5206\u7EC4\u3002

\u628A\u672C\u6587\u4EF6\u5939\u6DFB\u52A0\u4E3A\u6587\u732E\u5E93\u6839\u76EE\u5F55\u5373\u53EF\u5F00\u59CB\u4F53\u9A8C\u3002
`
  },
  {
    file: "\u53C2\u8003\u6587\u732E\u683C\u5F0F\u901F\u67E5.txt",
    content: `\u53C2\u8003\u6587\u732E\u683C\u5F0F\u901F\u67E5\uFF08\u793A\u4F8B\u6587\u672C\uFF09

GB/T 7714\uFF1A\u4F5C\u8005. \u9898\u540D[\u6587\u732E\u7C7B\u578B\u6807\u5FD7]. \u520A\u540D, \u5E74, \u5377(\u671F): \u8D77\u6B62\u9875\u7801.
APA\uFF1AAuthor, A. A. (Year). Title of the work. Publisher.
IEEE\uFF1A[1] A. Author, "Title of paper," Journal Name, vol. 1, no. 1, pp. 1-10, Year.

\u63D0\u793A\uFF1A\u5728\u6587\u732E\u67B6\u91CC\u9009\u4E2D\u6761\u76EE\u540E\u53EF\u4EE5\u76F4\u63A5\u590D\u5236\u5F15\u7528\u6587\u672C\u3002
`
  },
  {
    file: "2022 \u4F1A\u8BAE\u6295\u7A3F\u8981\u70B9.txt",
    content: `2022 \u4F1A\u8BAE\u6295\u7A3F\u8981\u70B9

1. \u6458\u8981\u4E0D\u8D85\u8FC7 250 \u8BCD\uFF0C\u7ED3\u8BBA\u8981\u5199\u6E05\u695A\u8D21\u732E\u70B9\u3002
2. \u56FE\u8868\u5FC5\u987B\u81EA\u89E3\u91CA\uFF0C\u56FE\u6CE8\u91CC\u5199\u6E05\u695A\u7EDF\u8BA1\u53E3\u5F84\u3002
3. \u53C2\u8003\u6587\u732E\u91CC\u540C\u4E00\u7BC7\u4F1A\u8BAE\u8BBA\u6587\u4E0D\u8981\u540C\u65F6\u51FA\u73B0 arXiv \u4E0E\u6B63\u5F0F\u7248\u672C\u3002
4. \u63D0\u4EA4\u524D\u7528\u8F6F\u4EF6\u91CC\u7684"\u5BFC\u51FA\u5E93"\u751F\u6210 BibTeX\uFF0C\u907F\u514D\u624B\u5DE5\u8A8A\u6284\u51FA\u9519\u3002
`
  }
];
function ascii(text) {
  return text.replace(/[^\x20-\x7E]/g, "?");
}
function esc2(text) {
  return ascii(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
function pageContent(spec, pageIndex) {
  const total = spec.pages;
  const section = spec.sections?.[pageIndex] ?? DEFAULT_SECTIONS[pageIndex] ?? `Section ${pageIndex + 1}`;
  const lines = [];
  lines.push(`${spec.title}`);
  lines.push(`Page ${pageIndex + 1} of ${total} - ${section}`);
  lines.push(`${spec.author} | ${spec.venue} | ${spec.year}`);
  if (pageIndex === 0 && spec.doi) lines.push(`DOI: ${spec.doi}`);
  lines.push("");
  lines.push(`Abstract (page ${pageIndex + 1}): this sample page belongs to the "${section}" part of the paper.`);
  lines.push("Each page carries distinct text so that reading position memory can be verified.");
  lines.push(`Paragraph 1. ${section} is discussed with respect to the overall argument of the paper.`);
  lines.push("Paragraph 2. We report the setup, the metrics and the main observations in plain ASCII.");
  lines.push(`Paragraph 3. Keyword markers for full text search: litshelf page ${pageIndex + 1} ${section.toLowerCase()}.`);
  const out = [];
  let y = 742;
  out.push(`BT /F1 15 Tf 72 ${y} Td (${esc2(lines[0])}) Tj ET`);
  y -= 26;
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) {
      y -= 8;
      continue;
    }
    const size = i === 1 ? 12 : 10;
    out.push(`BT /F1 ${size} Tf 72 ${y} Td (${esc2(lines[i])}) Tj ET`);
    y -= 18;
  }
  return `${out.join("\n")}
`;
}
function buildSamplePdf(spec) {
  const pageCount = Math.max(1, spec.pages);
  const kids = [];
  const pageObjects = [];
  for (let i = 0; i < pageCount; i += 1) {
    const pageObj = 5 + i * 2;
    pageObjects.push({ pageObj, contentObj: pageObj + 1, content: pageContent(spec, i) });
    kids.push(`${pageObj} 0 R`);
  }
  const objects = [];
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>`;
  objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[3] = `<< /Title (${esc2(spec.title)}) /Author (${esc2(spec.author)}) /Subject (LitShelf sample document) /Keywords (sample, litshelf, ${esc2(spec.venue)}) /Creator (LitShelf Sample Generator) /Producer (LitShelf) /CreationDate (D:${spec.year}01010000Z) >>`;
  for (const p of pageObjects) {
    objects[p.pageObj - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${p.contentObj} 0 R >>`;
    objects[p.contentObj - 1] = `<< /Length ${Buffer.byteLength(p.content, "latin1")} >>
stream
${p.content}
endstream`;
  }
  const parts = [];
  let bytes = 0;
  const push = (s) => {
    parts.push(s);
    bytes += Buffer.byteLength(s, "latin1");
  };
  push("%PDF-1.4\n");
  push("%\xE2\xE3\xCF\xD3\n");
  const offsets = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(bytes);
    push(`${i + 1} 0 obj
${objects[i]}
endobj
`);
  }
  const xrefOffset = bytes;
  let xref = `xref
0 ${objects.length + 1}
0000000000 65535 f 
`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n 
`;
  push(xref);
  push(`trailer
<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>
startxref
${xrefOffset}
%%EOF
`);
  return Buffer.from(parts.join(""), "latin1");
}
async function createSampleLibrary(dir) {
  const root = path10.resolve(dir);
  await ensureDir2(root);
  let files = 0;
  for (const spec of PAPERS) {
    const target = path10.join(root, spec.file);
    await ensureDir2(path10.dirname(target));
    await fs8.writeFile(longPath(target), buildSamplePdf(spec));
    files += 1;
  }
  for (const doc of DOCS) {
    const target = path10.join(root, doc.file);
    await ensureDir2(path10.dirname(target));
    await fs8.writeFile(longPath(target), doc.content, "utf8");
    files += 1;
  }
  return { dir: root, files };
}

// tools/verify-core.ts
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
var failures = 0;
function ok(cond, label, extra = "") {
  if (!cond) failures += 1;
  console.log(`  ${cond ? "\u2713" : "\u2717"} ${label}${extra ? ` \u2014 ${extra}` : ""}`);
}
function head(title) {
  console.log(`
${title}`);
}
async function waitFor(label, fn, timeoutMs = 9e4, interval = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep2(interval);
  }
  console.log(`  \u2717 \u8D85\u65F6\uFF1A${label}`);
  failures += 1;
  return false;
}
async function main() {
  const base = path11.join(process.cwd(), "tmp", `verify-${Date.now()}`);
  const dataDir = path11.join(base, "data");
  const libDir = path11.join(base, "\u6587\u732E\u5E93");
  await fs9.mkdir(libDir, { recursive: true });
  console.log(`\u5DE5\u4F5C\u76EE\u5F55\uFF1A${base}`);
  head("[1] \u793A\u4F8B\u6587\u732E\u751F\u6210\uFF08\u624B\u5199\u5408\u6CD5 PDF\uFF09");
  const samples = await createSampleLibrary(libDir);
  ok(samples.files === 14, `\u751F\u6210 ${samples.files} \u4E2A\u6587\u4EF6\uFF088 PDF + 4 MD + 2 TXT\uFF09`);
  const events = [];
  const host = new Host({ dataDir, mode: "web", version: "verify", online: false });
  host.subscribe((e) => events.push(e));
  await host.start();
  head("[2] \u9996\u6B21\u626B\u63CF\uFF1A\u6761\u76EE\u5148\u51FA\u73B0\uFF0C\u518D\u8865\u5143\u6570\u636E");
  const t0 = Date.now();
  const { root } = await host.addRoot(libDir);
  ok(host.library.all().length === 14, `addRoot \u540E\u7ACB\u523B\u5165\u5E93 ${host.library.all().length} \u6761`, `${Date.now() - t0}ms`);
  const allReady = await waitFor("\u5168\u90E8\u89E3\u6790\u5B8C\u6210", () => host.library.all().every((i) => i.parseState !== "placeholder"));
  ok(allReady, "\u6240\u6709\u6761\u76EE\u89E3\u6790\u7ED3\u675F");
  const failed = host.library.all().filter((i) => i.parseState === "failed");
  ok(failed.length === 0, "\u96F6\u89E3\u6790\u5931\u8D25", failed.map((f) => `${f.name}: ${f.parseError}`).join(" | "));
  const pdfs = host.library.all().filter((i) => i.kind === "pdf");
  ok(pdfs.length === 8, `\u8BC6\u522B 8 \u4E2A PDF`);
  ok(pdfs.every((p) => p.pageCount >= 3), `\u6BCF\u7BC7 PDF \u90FD\u89E3\u6790\u51FA\u9875\u6570\uFF1A${pdfs.map((p) => p.pageCount).join("/")}`);
  ok(pdfs.every((p) => p.title.length > 3), "\u6BCF\u7BC7 PDF \u90FD\u6709\u6807\u9898");
  ok(pdfs.filter((p) => p.year).length >= 6, `${pdfs.filter((p) => p.year).length}/8 \u7BC7\u89E3\u6790\u51FA\u5E74\u4EFD`);
  ok(pdfs.filter((p) => p.excerpt.length > 20).length === 8, "\u6BCF\u7BC7\u90FD\u6709\u6B63\u6587\u6458\u8981\uFF08\u4F9B\u5217\u8868\u4E0E\u641C\u7D22\u7528\uFF09");
  const cn = host.library.all().find((i) => /[\u4e00-\u9fa5]/.test(i.name));
  ok(!!cn, "\u4E2D\u6587\u6587\u4EF6\u540D\u6B63\u5E38\u5165\u5E93", cn?.name ?? "");
  ok(host.library.all().some((i) => i.dir === "\u5B50\u76EE\u5F55"), "\u5B50\u76EE\u5F55\u88AB\u9012\u5F52\u53D1\u73B0");
  ok(host.getFolderTree().some((t) => t.dirs.includes("\u5B50\u76EE\u5F55")), "\u6587\u4EF6\u5939\u6811\u5305\u542B\u5B50\u76EE\u5F55");
  head("[3] \u6587\u4EF6\u5939\u53D8\u5316 \u2192 \u8F6F\u4EF6\u81EA\u52A8\u8DDF\u7740\u53D8\uFF08\u6838\u5FC3\u9700\u6C42\uFF09");
  const target = pdfs[0];
  host.library.patchItem(target.id, { starred: true, tags: ["\u9A8C\u6536"], readState: "reading" });
  host.setNote(target.id, "## \u6211\u7684\u7B14\u8BB0\n\n\u8FD9\u6BB5\u7B14\u8BB0\u4E0D\u80FD\u88AB\u626B\u63CF\u51B2\u6389\u3002");
  host.setProgress(target.id, { page: 4, total: target.pageCount, percent: 60 });
  const renamed = path11.join(path11.dirname(target.path), `\u6539\u540D\u9A8C\u8BC1 ${Date.now()}.pdf`);
  await fs9.rename(target.path, renamed);
  const renamedOk = await waitFor("\u6539\u540D\u88AB\u8BC6\u522B", () => host.library.get(target.id)?.path === renamed, 3e4);
  const afterRename = host.library.get(target.id);
  ok(renamedOk, "\u6539\u540D\u540E\u8DEF\u5F84\u66F4\u65B0");
  ok(afterRename?.id === target.id, "\u6761\u76EE id \u672A\u53D8\uFF08\u6570\u636E\u4E0D\u4E22\u7684\u5173\u952E\uFF09");
  ok(afterRename?.starred === true, "\u661F\u6807\u4FDD\u7559");
  ok((afterRename?.tags ?? []).includes("\u9A8C\u6536"), "\u6807\u7B7E\u4FDD\u7559");
  ok((afterRename?.note ?? "").includes("\u4E0D\u80FD\u88AB\u626B\u63CF\u51B2\u6389"), "\u7B14\u8BB0\u4FDD\u7559");
  ok(afterRename?.progress.page === 4, "\u9605\u8BFB\u8FDB\u5EA6\u4FDD\u7559");
  ok(host.library.all().filter((i) => i.path === renamed).length === 1, "\u6CA1\u6709\u91CD\u590D\u6761\u76EE");
  const copyPath = path11.join(libDir, `\u526F\u672C ${Date.now()}.pdf`);
  await fs9.copyFile(renamed, copyPath);
  await waitFor("\u526F\u672C\u5165\u5E93", () => host.library.all().some((i) => i.path === copyPath), 3e4);
  const copyItem = host.library.all().find((i) => i.path === copyPath);
  ok(!!copyItem, "\u526F\u672C\u5DF2\u5165\u5E93");
  ok(copyItem?.id !== target.id, "\u526F\u672C\u662F\u72EC\u7ACB\u6761\u76EE\uFF08\u540C\u5185\u5BB9\u4E5F\u4E0D\u4F1A\u88AB\u8BEF\u5224\u6210\u6539\u540D\uFF09");
  ok(host.library.get(target.id)?.path === renamed, "\u539F\u6761\u76EE\u672A\u88AB\u62A2\u5360");
  const victimId = copyItem.id;
  await fs9.unlink(copyPath);
  await waitFor("\u5220\u9664\u88AB\u8BC6\u522B", () => host.library.get(victimId)?.missing === true, 3e4);
  ok(host.library.get(victimId)?.missing === true, "\u5220\u9664\u540E\u6761\u76EE\u4ECD\u5728\uFF0C\u6807\u8BB0\u300C\u6587\u4EF6\u7F3A\u5931\u300D");
  ok(host.library.all().some((i) => i.id === victimId), "\u6761\u76EE\u6CA1\u6709\u88AB\u5220\u6389");
  await fs9.writeFile(copyPath, await fs9.readFile(renamed));
  await waitFor("\u6587\u4EF6\u56DE\u6765\u81EA\u52A8\u590D\u6D3B", () => host.library.get(victimId)?.missing === false, 3e4);
  ok(host.library.get(victimId)?.missing === false, "\u6587\u4EF6\u653E\u56DE\u540E\u81EA\u52A8\u590D\u6D3B");
  head("[4] \u8986\u76D6\u4FDD\u5B58 \u2192 \u91CD\u89E3\u6790 + \u6279\u6CE8\u6309\u951A\u70B9\u91CD\u5B9A\u4F4D");
  const ann = host.addAnnotation({
    itemId: target.id,
    type: "highlight",
    page: 2,
    rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.02 }],
    text: "Verification Anchor Text",
    anchor: { prefix: "alpha", suffix: "omega", occurrence: 1 },
    comment: "\u8FD9\u6761\u6279\u6CE8\u5FC5\u987B\u6D3B\u4E0B\u6765",
    color: "yellow"
  });
  const revBefore = host.library.get(target.id).revision;
  const buf = await fs9.readFile(renamed);
  await fs9.writeFile(renamed, Buffer.concat([buf, Buffer.from("\n% appended by verify\n")]));
  await waitFor("\u8986\u76D6\u4FDD\u5B58\u88AB\u8BC6\u522B", () => (host.library.get(target.id)?.revision ?? 0) > revBefore, 3e4);
  ok(host.library.get(target.id).revision > revBefore, `revision ${revBefore} \u2192 ${host.library.get(target.id).revision}`);
  await sleep2(3500);
  const anns = host.listAnnotations(target.id);
  ok(anns.length === 1, "\u6279\u6CE8\u6CA1\u6709\u88AB\u9759\u9ED8\u5220\u9664");
  ok(anns[0]?.comment === "\u8FD9\u6761\u6279\u6CE8\u5FC5\u987B\u6D3B\u4E0B\u6765", "\u6279\u6CE8\u5185\u5BB9\u5B8C\u6574");
  ok(host.library.get(target.id).annotationCount === 1, "\u6279\u6CE8\u8BA1\u6570\u540C\u6B65");
  ok(host.library.get(target.id).note.includes("\u4E0D\u80FD\u88AB\u626B\u63CF\u51B2\u6389"), "\u8986\u76D6\u4FDD\u5B58\u540E\u7B14\u8BB0\u4ECD\u5728");
  head("[5] \u5168\u6587\u7D22\u5F15\u4E0E\u68C0\u7D22");
  const idx = await host.indexItemText(target.id);
  ok(idx.ok && idx.pages >= 3, `\u5EFA\u7ACB\u5168\u6587\u7D22\u5F15\uFF1A${idx.pages} \u9875`);
  const byTitle = await host.search(pdfs[1].title.slice(0, 10));
  ok(byTitle.length > 0, "\u6309\u6807\u9898\u80FD\u641C\u5230");
  const byTag = await host.search("tag:\u9A8C\u6536");
  ok(byTag.length === 1 && byTag[0].item.id === target.id, "\u6309 tag: \u8BED\u6CD5\u80FD\u641C\u5230");
  const byAnn = await host.search("\u6279\u6CE8\u5FC5\u987B\u6D3B\u4E0B\u6765");
  ok(byAnn.some((h) => h.item.id === target.id), "\u6309\u6279\u6CE8\u5185\u5BB9\u80FD\u641C\u5230");
  const byFullText = await host.search("Page 3 of");
  ok(byFullText.length > 0, "\u6309 PDF \u6B63\u6587\u80FD\u641C\u5230\uFF08\u5168\u6587\u68C0\u7D22\u751F\u6548\uFF09", `\u547D\u4E2D ${byFullText.length} \u7BC7`);
  const byYear = await host.search("year:2020..2025");
  ok(byYear.length >= 6, `year: \u8303\u56F4\u8BED\u6CD5\u751F\u6548\uFF08${byYear.length} \u7BC7\uFF09`);
  const byIs = await host.search("is:starred");
  ok(byIs.length === 1, "is:starred \u8FC7\u6EE4\u751F\u6548");
  head("[6] \u5BFC\u51FA");
  const all = host.library.all();
  const bib = toBibTeX(all);
  ok(bib.startsWith("@") && bib.includes(pdfs[1].title.slice(0, 8)), "BibTeX \u5BFC\u51FA\u6B63\u5E38");
  const csv = toCSV(all);
  ok(csv.startsWith("\uFEFF") && csv.trim().split("\n").length === all.length + 1, `CSV \u884C\u6570 = ${all.length} + \u8868\u5934`);
  const exported = await host.exportLibrary({ format: "markdown-notes", ids: [target.id] });
  ok(exported.ok && (exported.content ?? "").includes("\u6279\u6CE8"), "\u7B14\u8BB0+\u6279\u6CE8 Markdown \u5BFC\u51FA\u6B63\u5E38");
  head("[7] \u7B14\u8BB0\u6587\u4EF6\u53CC\u5411\u540C\u6B65");
  const noteFile = path11.join(dataDir, "notes", `${target.id}.md`);
  await fs9.writeFile(noteFile, "<!-- \u5916\u90E8\u7F16\u8F91\u5668\u6539\u7684 -->\n\n\u5916\u90E8\u5199\u5165\u7684\u65B0\u5185\u5BB9 XYZ");
  await host.stop();
  const host2 = new Host({ dataDir, mode: "web", version: "verify", online: false });
  await host2.start();
  const reloaded = host2.library.get(target.id);
  ok(!!reloaded, "\u91CD\u542F\u540E\u6761\u76EE\u8FD8\u5728");
  ok(reloaded?.note.includes("\u5916\u90E8\u5199\u5165\u7684\u65B0\u5185\u5BB9 XYZ"), "\u5916\u90E8\u7F16\u8F91\u7684\u7B14\u8BB0\u88AB\u8BFB\u56DE");
  ok(reloaded?.starred === true, "\u91CD\u542F\u540E\u661F\u6807\u4FDD\u7559");
  ok(reloaded?.progress.page === 4, "\u91CD\u542F\u540E\u9605\u8BFB\u8FDB\u5EA6\u4FDD\u7559");
  ok(host2.listAnnotations(target.id).length === 1, "\u91CD\u542F\u540E\u6279\u6CE8\u4FDD\u7559");
  ok(host2.library.all().length === host.library.all().length, `\u6761\u76EE\u6570\u4E00\u81F4\uFF08${host2.library.all().length}\uFF09`);
  ok(host2.library.all().filter((i) => i.missing).length === 0, "\u6CA1\u6709\u8BEF\u6807\u6587\u4EF6\u7F3A\u5931");
  head("[8] \u4E8B\u4EF6\u6D41\uFF08\u754C\u9762\u9760\u589E\u91CF\u4E8B\u4EF6\u66F4\u65B0\uFF09");
  const kinds = /* @__PURE__ */ new Map();
  for (const e of events) kinds.set(e.type, (kinds.get(e.type) ?? 0) + 1);
  console.log("  " + [...kinds.entries()].map(([k, v]) => `${k}\xD7${v}`).join(" \xB7 "));
  ok((kinds.get("items:patch") ?? 0) > 5, "items:patch \u4E8B\u4EF6\u5145\u8DB3");
  ok((kinds.get("scan:progress") ?? 0) > 0, "scan:progress \u4E8B\u4EF6\u5B58\u5728");
  ok((kinds.get("toast") ?? 0) > 0, "toast \u63D0\u793A\u5B58\u5728");
  head("[9] \u7EDF\u8BA1\u4E0E\u6536\u5C3E");
  const stats = host2.stats();
  console.log(`  \u6761\u76EE ${stats.items} \xB7 \u7F3A\u5931 ${stats.missing} \xB7 \u5DF2\u89E3\u6790 ${stats.ready} \xB7 \u5168\u6587\u7D22\u5F15 ${stats.textIndexed} \xB7 \u6279\u6CE8 ${stats.annotations}`);
  ok(stats.ready >= 14, "\u5168\u90E8\u6761\u76EE\u5B8C\u6210\u89E3\u6790");
  await host2.stop();
  console.log(`
${failures ? `\u274C \u5931\u8D25 ${failures} \u9879` : "\u2705 \u5168\u90E8\u901A\u8FC7"}`);
  console.log(`\u5DE5\u4F5C\u76EE\u5F55\u4FDD\u7559\u5728\uFF1A${base}`);
  process.exitCode = failures ? 1 : 0;
}
process.on("uncaughtException", (err) => {
  console.error("\u9A8C\u6536\u811A\u672C\u5F02\u5E38\uFF1A", err);
  process.exit(9);
});
process.on("unhandledRejection", (reason) => {
  console.error("\u672A\u5904\u7406\u7684 Promise \u62D2\u7EDD\uFF1A", reason);
  process.exit(9);
});
main().catch((err) => {
  console.error("\u9A8C\u6536\u811A\u672C\u5931\u8D25\uFF1A", err);
  process.exit(1);
});

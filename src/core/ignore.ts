/**
 * 忽略规则：只挑"这个文件该不该进文献库"，不做任何写操作。
 */

/** 永远不进入的目录名（小写比较） */
export const DEFAULT_IGNORE_DIRS = new Set(
  [
    '.git',
    '.svn',
    '.hg',
    'node_modules',
    '$RECYCLE.BIN',
    'System Volume Information',
    '$WinREAgent',
    '.Trash',
    '.Trashes',
    '.Spotlight-V100',
    '.fseventsd',
    '.TemporaryItems',
    '__MACOSX',
    '.obsidian',
    '.stfolder',
    '.dropbox.cache',
    '.thumbnails',
    'dist-info',
    '__pycache__',
  ].map((s) => s.toLowerCase()),
);

/** 明显是"写了一半"或系统噪音的文件 */
const TEMP_NAME_RES: RegExp[] = [
  /^~\$/i, // Office 临时文件
  /^\.~/i, // LibreOffice
  /^\._/i, // macOS 资源分叉
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
  /^\.#/i, // emacs
  /~$/,
];

export function isTempFileName(name: string): boolean {
  return TEMP_NAME_RES.some((re) => re.test(name));
}

export function isIgnoredDirName(name: string, extra: string[] = []): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('.')) {
    // 隐藏目录默认跳过，但允许白名单描述为"包含"的例外
    if (lower === '.stversions') return true;
    return true;
  }
  if (DEFAULT_IGNORE_DIRS.has(lower)) return true;
  return extra.some((e) => e.toLowerCase() === lower);
}

/** 文献库默认收录的扩展名 */
export const DOC_EXTENSIONS = new Set([
  'pdf',
  'md',
  'markdown',
  'mdx',
  'txt',
  'text',
  'log',
  'html',
  'htm',
  'xhtml',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'avif',
  'docx',
  'epub',
  'caj',
  'nh',
  'doc',
  'rtf',
  'odt',
  'djvu',
  'tex',
  'bib',
]);

export interface ShouldIncludeInput {
  name: string;
  ext: string;
  size: number;
  includeOtherFiles: boolean;
  ignoreExt?: string[];
}

export function shouldIncludeFile(input: ShouldIncludeInput): boolean {
  const { name, ext, size, includeOtherFiles } = input;
  if (isTempFileName(name)) return false;
  if (size === 0) return false;
  const e = ext.toLowerCase();
  if (!e) return false;
  if (input.ignoreExt?.includes(e)) return false;
  if (DOC_EXTENSIONS.has(e)) return true;
  return includeOtherFiles;
}

/** 递归深度判定：根目录本层 = 1 */
export function withinDepth(rootPath: string, dirPath: string, maxDepth: number): boolean {
  const rel = dirPath.slice(rootPath.length).replace(/^[\\/]+/, '');
  if (!rel) return true;
  const depth = rel.split(/[\\/]+/).filter(Boolean).length;
  return depth <= Math.max(1, maxDepth);
}

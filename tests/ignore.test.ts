/**
 * src/core/ignore.ts —— 收录 / 忽略规则（纯函数）。
 */
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_IGNORE_DIRS, DOC_EXTENSIONS, isIgnoredDirName, isTempFileName, shouldIncludeFile, withinDepth } from '@core/ignore';

/** 造一个 shouldIncludeFile 的入参（默认是一份 1KB 的 pdf） */
function input(over: Partial<Parameters<typeof shouldIncludeFile>[0]> = {}) {
  return { name: 'paper.pdf', ext: 'pdf', size: 1024, includeOtherFiles: false, ...over };
}

describe('isTempFileName / shouldIncludeFile：写了一半的文件', () => {
  it('Office 临时文件 ~$xx.docx 被忽略', () => {
    expect(isTempFileName('~$thesis.docx')).toBe(true);
    expect(shouldIncludeFile(input({ name: '~$thesis.docx', ext: 'docx' }))).toBe(false);
  });

  it('.DS_Store / Thumbs.db / desktop.ini 被忽略', () => {
    expect(shouldIncludeFile(input({ name: '.DS_Store', ext: '' }))).toBe(false);
    expect(shouldIncludeFile(input({ name: 'Thumbs.db', ext: 'db' }))).toBe(false);
    expect(shouldIncludeFile(input({ name: 'desktop.ini', ext: 'ini' }))).toBe(false);
  });

  it('下载中的 .crdownload / .part / .tmp / ~ 结尾被忽略', () => {
    expect(shouldIncludeFile(input({ name: 'book.pdf.crdownload', ext: 'crdownload' }))).toBe(false);
    expect(shouldIncludeFile(input({ name: 'x.pdf.tmp', ext: 'tmp' }))).toBe(false);
    expect(shouldIncludeFile(input({ name: 'x.part', ext: 'part' }))).toBe(false);
    expect(shouldIncludeFile(input({ name: 'x.syncthing.tmp', ext: 'tmp' }))).toBe(false);
    expect(isTempFileName('备份~')).toBe(true);
    expect(isTempFileName('.#lock')).toBe(true);
  });

  it('0 字节文件被忽略（再看扩展名之前）', () => {
    expect(shouldIncludeFile(input({ size: 0 }))).toBe(false);
    expect(shouldIncludeFile(input({ name: 'empty.md', ext: 'md', size: 0 }))).toBe(false);
  });

  it('正常文件不受影响', () => {
    expect(isTempFileName('paper.pdf')).toBe(false);
    expect(shouldIncludeFile(input())).toBe(true);
  });
});

describe('shouldIncludeFile：扩展名白名单', () => {
  it('未知扩展名：includeOtherFiles=false 排除，=true 收录', () => {
    expect(shouldIncludeFile(input({ name: 'setup.exe', ext: 'exe' }))).toBe(false);
    expect(shouldIncludeFile(input({ name: 'setup.exe', ext: 'exe', includeOtherFiles: true }))).toBe(true);
    expect(shouldIncludeFile(input({ name: 'data.zip', ext: 'zip' }))).toBe(false);
    expect(shouldIncludeFile(input({ name: 'data.zip', ext: 'zip', includeOtherFiles: true }))).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(shouldIncludeFile(input({ name: 'PAPER.PDF', ext: 'PDF' }))).toBe(true);
    expect(shouldIncludeFile(input({ name: 'SETUP.EXE', ext: 'EXE', includeOtherFiles: true }))).toBe(true);
  });

  it('没有扩展名 → 排除（哪怕开了 includeOtherFiles）', () => {
    expect(shouldIncludeFile(input({ name: 'README', ext: '' }))).toBe(false);
    expect(shouldIncludeFile(input({ name: 'README', ext: '', includeOtherFiles: true }))).toBe(false);
  });

  it('文档类扩展名一律收录', () => {
    for (const name of ['a.pdf', 'a.md', 'a.txt', 'a.docx', 'a.epub', 'a.html', 'a.png', 'a.caj', 'a.bib', 'a.tex']) {
      const ext = name.slice(name.indexOf('.') + 1);
      expect(DOC_EXTENSIONS.has(ext)).toBe(true);
      expect(shouldIncludeFile(input({ name, ext }))).toBe(true);
    }
  });

  it('ignoreExt 名单可再排除一层', () => {
    expect(shouldIncludeFile(input({ ignoreExt: ['pdf'] }))).toBe(false);
    expect(shouldIncludeFile(input({ name: 'a.md', ext: 'md', ignoreExt: ['pdf'] }))).toBe(true);
  });
});

describe('isIgnoredDirName', () => {
  it('隐藏目录与常见噪音目录被忽略', () => {
    for (const d of ['.git', '.svn', 'node_modules', '$RECYCLE.BIN', 'System Volume Information', '__MACOSX', '__pycache__', '.obsidian']) {
      expect(isIgnoredDirName(d)).toBe(true);
    }
  });

  it('大小写不敏感', () => {
    expect(isIgnoredDirName('NODE_MODULES')).toBe(true);
    expect(isIgnoredDirName('.GIT')).toBe(true);
  });

  it('任何点开头的目录都跳过（含 .stversions）', () => {
    expect(isIgnoredDirName('.stversions')).toBe(true);
    expect(isIgnoredDirName('.my-hidden-folder')).toBe(true);
    expect(isIgnoredDirName('.2024-论文')).toBe(true);
  });

  it('普通目录放行', () => {
    expect(isIgnoredDirName('papers')).toBe(false);
    expect(isIgnoredDirName('2024')).toBe(false);
    expect(isIgnoredDirName('机器学习')).toBe(false);
  });

  it('额外忽略名单生效（大小写不敏感）', () => {
    expect(isIgnoredDirName('drafts', ['Drafts'])).toBe(true);
    expect(isIgnoredDirName('drafts')).toBe(false);
  });
});

describe('withinDepth', () => {
  const root = path.join('C:', 'lib');

  it('根目录本层算深度 1', () => {
    expect(withinDepth(root, path.join(root, 'a.pdf'), 1)).toBe(true);
    expect(withinDepth(root, path.join(root, 'a.pdf'), 3)).toBe(true);
  });

  it('子目录按层数判定', () => {
    const sub1 = path.join(root, 'sub');
    const sub2 = path.join(root, 'sub', 'deep');
    expect(withinDepth(root, sub1, 1)).toBe(true);
    expect(withinDepth(root, sub2, 1)).toBe(false);
    expect(withinDepth(root, sub2, 2)).toBe(true);
  });

  it('根目录自身永远通过', () => {
    expect(withinDepth(root, root, 1)).toBe(true);
  });
});

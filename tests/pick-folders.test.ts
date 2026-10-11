import { describe, expect, it } from 'vitest';
import { foldersFromPicked } from '../src/main/ipc';

/**
 * 「选择文献」对话框的路径折算：用户在新对话框里看到的是**文件**（PDF 等），
 * 点一个或多个文件后，我们要用它们**所在的文件夹**作为文献库。
 * 这段逻辑决定"选文件能不能加对文件夹"，所以单独测（原生对话框本身没法在 CI 里点）。
 */
describe('foldersFromPicked', () => {
  it('选文件 → 用所在文件夹', () => {
    const r = foldersFromPicked([{ path: 'C:\\papers\\a.pdf', isDirectory: false }]);
    expect(r).toEqual({ dirs: ['C:\\papers'], pickedFiles: 1 });
  });

  it('多选同一目录下的多个文件 → 只加一次该目录', () => {
    const r = foldersFromPicked([
      { path: 'C:\\papers\\a.pdf', isDirectory: false },
      { path: 'C:\\papers\\b.pdf', isDirectory: false },
      { path: 'C:\\papers\\note.md', isDirectory: false },
    ]);
    expect(r.dirs).toEqual(['C:\\papers']);
    expect(r.pickedFiles).toBe(3);
  });

  it('多选不同目录 → 各自加一个库，顺序保持', () => {
    const r = foldersFromPicked([
      { path: 'C:\\a\\x.pdf', isDirectory: false },
      { path: 'D:\\b\\y.pdf', isDirectory: false },
      { path: 'C:\\a\\z.pdf', isDirectory: false },
    ]);
    expect(r.dirs).toEqual(['C:\\a', 'D:\\b']);
    expect(r.pickedFiles).toBe(3);
  });

  it('万一选中的是文件夹（例如未来换回文件夹模式）→ 直接用该文件夹', () => {
    const r = foldersFromPicked([{ path: 'C:\\papers', isDirectory: true }]);
    expect(r).toEqual({ dirs: ['C:\\papers'], pickedFiles: 0 });
  });

  it('混合选择：文件夹 + 文件都支持，且不重复', () => {
    const r = foldersFromPicked([
      { path: 'C:\\papers', isDirectory: true },
      { path: 'C:\\papers\\a.pdf', isDirectory: false },
      { path: 'D:\\other\\b.pdf', isDirectory: false },
    ]);
    expect(r.dirs).toEqual(['C:\\papers', 'D:\\other']);
    expect(r.pickedFiles).toBe(2);
  });

  it('空输入 → 什么都不加', () => {
    expect(foldersFromPicked([])).toEqual({ dirs: [], pickedFiles: 0 });
  });
});

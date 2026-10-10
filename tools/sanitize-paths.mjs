/**
 * 开源前的脱敏：把文档/工具里的本机绝对路径改成通用写法。
 * 用法：node tools/sanitize-paths.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const TARGETS = ['docs', 'tools', 'src', 'scripts', 'tests', 'README.md'];
const EXTS = new Set(['.md', '.mjs', '.ts', '.tsx', '.json', '.bat', '.txt']);
const REPLACEMENTS = [
  [/D:\\dsh\\litshelf\\/g, ''],
  [/D:\\dsh\\litshelf/g, '.'],
  [/D:\\dsh\\文献架整合\\/g, '文献架整合/'],
  [/D:\\dsh\\文献架整合/g, '文献架整合'],
  [/D:\\dsh\\/g, ''],
  [/C:\\Users\\Admin（无密码）\\/g, '%USERPROFILE%\\'],
];

let touched = 0;
let changes = 0;
const walk = async (target) => {
  const abs = path.join(ROOT, target);
  const st = await fs.stat(abs).catch(() => null);
  if (!st) return;
  if (st.isFile()) {
    if (!EXTS.has(path.extname(abs))) return;
    const before = await fs.readFile(abs, 'utf8');
    let after = before;
    for (const [re, to] of REPLACEMENTS) after = after.replace(re, to);
    if (after !== before) {
      await fs.writeFile(abs, after, 'utf8');
      touched += 1;
      changes += (before.match(/D:\\dsh|Users\\Admin/g) ?? []).length;
      console.log(`  改：${path.relative(ROOT, abs)}`);
    }
    return;
  }
  for (const e of await fs.readdir(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'tmp' || e.name === 'dist') continue;
    await walk(path.join(target, e.name));
  }
};

for (const t of TARGETS) await walk(t);
console.log(`\n脱敏完成：改了 ${touched} 个文件，替换 ${changes} 处本机路径`);

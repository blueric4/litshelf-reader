/**
 * 开源前的脱敏小工具：把仓库里"本机绝对路径"统一改成通用写法。
 *
 * 不写死任何人的用户名/目录：本机路径在运行时从 os.homedir() 与项目根目录推导，
 * 你换台机器也能直接用。默认只报告，加 --write 才真正改文件。
 *
 * 用法：node tools/sanitize-paths.mjs [--write]
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const HOME = os.homedir();
const WRITE = process.argv.includes('--write');
const TARGETS = ['docs', 'tools', 'src', 'scripts', 'tests', 'README.md'];
const EXTS = new Set(['.md', '.mjs', '.ts', '.tsx', '.json', '.bat', '.txt']);

// 需要替换的成本机路径（反斜杠 / 正斜杠 / JSON 转义双反斜杠三种写法都覆盖）
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ROOT_FWD = ROOT.replace(/\\/g, '/');
const ROOT_JSON = ROOT.replace(/\\/g, '\\\\');
const REPLACEMENTS = [
  [new RegExp(esc(HOME) + '\\\\', 'g'), '%USERPROFILE%\\'],
  [new RegExp(esc(HOME), 'g'), '%USERPROFILE%'],
  [new RegExp(esc(ROOT_JSON) + '\\\\\\\\', 'g'), ''],
  [new RegExp(esc(ROOT_JSON), 'g'), '.'],
  [new RegExp(esc(ROOT) + '\\\\', 'g'), ''],
  [new RegExp(esc(ROOT), 'g'), '.'],
  [new RegExp(esc(ROOT_FWD) + '/', 'g'), ''],
  [new RegExp(esc(ROOT_FWD), 'g'), '.'],
];

let touched = 0;
let hits = 0;
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
      touched += 1;
      hits += 1;
      console.log(`  ${WRITE ? '改' : '待改'}：${path.relative(ROOT, abs)}`);
      if (WRITE) await fs.writeFile(abs, after, 'utf8');
    }
    return;
  }
  for (const e of await fs.readdir(abs, { withFileTypes: true })) {
    if (['node_modules', 'tmp', 'dist', '.git'].includes(e.name)) continue;
    await walk(path.join(target, e.name));
  }
};

for (const t of TARGETS) await walk(t);
console.log(`\n${WRITE ? '已脱敏' : '扫描完成（未改动，加 --write 才会写）'}：涉及 ${touched} 个文件`);

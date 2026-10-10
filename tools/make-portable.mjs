/**
 * 打一个「绿色免安装整合版」：整包拷走/压缩发给别人就能用。
 *
 * 产物结构（Electron 标准便携布局，双击 exe 即可启动）：
 *   文献架整合/
 *     文献架 LitShelf.exe        ← 由 electron.exe 改名而来
 *     *.dll / *.pak / locales/   ← Electron 运行时
 *     resources/app/             ← 我们的程序
 *        package.json
 *        dist/**                 ← 构建产物（主进程/预加载/渲染层/pdf worker/cmaps/字体）
 *        node_modules/**         ← 主进程运行时需要的生产依赖（devDependencies 不入包）
 *     使用说明.txt
 *
 * 用法：node tools/make-portable.mjs [--no-build] [--out <目录>]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, 'package.json'));
const args = process.argv.slice(2);
const skipBuild = args.includes('--no-build');
const outArg = args.indexOf('--out');
const OUT_ROOT = outArg >= 0 ? path.resolve(args[outArg + 1]) : path.resolve(ROOT, '..', '文献架整合');
const APP_DIR = path.join(OUT_ROOT, 'resources', 'app');
const EXE_NAME = '文献架 LitShelf.exe';

const log = (m) => console.log(m);
const dirSize = async (dir) => {
  let total = 0;
  let files = 0;
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        total += (await fs.stat(p)).size;
        files += 1;
      }
    }
  };
  await walk(dir).catch(() => undefined);
  return { total, files };
};

// ---------------------------------------------------------------- 1. 构建
if (!skipBuild) {
  log('[1/6] 构建 dist …');
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build 退出码 ${code}`))));
  });
} else {
  log('[1/6] 跳过构建（--no-build）');
}

// ---------------------------------------------------------------- 2. 清空输出
log(`[2/6] 准备输出目录：${OUT_ROOT}`);
await fs.rm(OUT_ROOT, { recursive: true, force: true });
await fs.mkdir(APP_DIR, { recursive: true });

// ---------------------------------------------------------------- 3. 拷贝 Electron 运行时
log('[3/6] 拷贝 Electron 运行时 …');
const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
await fs.access(electronDist).catch(() => {
  throw new Error('找不到 node_modules/electron/dist —— 先安装依赖');
});
await fs.cp(electronDist, OUT_ROOT, { recursive: true, dereference: true });
// 用我们的 app 取代默认的 default_app.asar
await fs.rm(path.join(OUT_ROOT, 'resources', 'default_app.asar'), { force: true }).catch(() => undefined);
// 瘦身①：只留中文/英文语言包（Electron 其余 locale 用不上，能省几十 MB；缺了会自动回落英文）
const localesDir = path.join(OUT_ROOT, 'locales');
const keepLocales = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']);
let dropped = 0;
for (const f of await fs.readdir(localesDir).catch(() => [])) {
  if (keepLocales.has(f)) continue;
  await fs.rm(path.join(localesDir, f), { force: true }).catch(() => undefined);
  dropped += 1;
}
log(`      语言包裁剪：删除 ${dropped} 个，保留 ${[...keepLocales].join(', ')}`);
const srcExe = path.join(OUT_ROOT, 'electron.exe');
const dstExe = path.join(OUT_ROOT, EXE_NAME);
await fs.rename(srcExe, dstExe);
log(`      启动程序：${EXE_NAME}`);

// ---------------------------------------------------------------- 4. 程序本体
log('[4/6] 拷贝程序本体（dist + package.json）…');
await fs.cp(path.join(ROOT, 'dist'), path.join(APP_DIR, 'dist'), { recursive: true, dereference: true });
// 瘦身②：sourcemap 对使用者没用（只影响体积与源码暴露面）
let maps = 0;
const dropMaps = async (dir) => {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await dropMaps(p);
    else if (e.isFile() && e.name.endsWith('.map')) {
      await fs.rm(p, { force: true });
      maps += 1;
    }
  }
};
await dropMaps(path.join(APP_DIR, 'dist'));
log(`      删除 sourcemap ${maps} 个`);
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const appPkg = {
  name: pkg.name,
  productName: pkg.productName,
  version: pkg.version,
  private: true,
  type: pkg.type,
  description: pkg.description,
  main: pkg.main,
};
await fs.writeFile(path.join(APP_DIR, 'package.json'), JSON.stringify(appPkg, null, 2), 'utf8');

// ---------------------------------------------------------------- 5. 生产依赖（pnpm 软链接要解引用）
log('[5/6] 收集并拷贝生产依赖 …');
const prodDeps = Object.keys(pkg.dependencies ?? {});
const seen = new Map(); // 包名 → 源目录

/** 找到某个包的根目录：**在这个包自己的目录里解析**（pnpm 把传递依赖放在 .pnpm/…/node_modules 下） */
const packageDirOf = async (name, fromDir) => {
  const req = createRequire(path.join(fromDir ?? ROOT, 'package.json'));
  const candidates = [];
  try {
    candidates.push(path.dirname(req.resolve(`${name}/package.json`)));
  } catch {
    /* exports 未暴露 package.json */
  }
  try {
    let dir = path.dirname(req.resolve(name));
    for (let i = 0; i < 8; i += 1) {
      try {
        const meta = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
        if (meta.name === name) {
          candidates.push(dir);
          break;
        }
      } catch {
        /* 继续往上找 */
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    /* 入口也解析不到 */
  }
  for (const c of candidates) {
    try {
      const real = await fs.realpath(c);
      const meta = JSON.parse(await fs.readFile(path.join(real, 'package.json'), 'utf8'));
      if (meta.name === name) return real;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
};

const queue = prodDeps.map((name) => ({ name, from: null }));
const missing = [];
const skipped = [];
while (queue.length) {
  const { name, from } = queue.shift();
  if (seen.has(name)) continue;
  // 纯类型包/纯开发工具不需要进运行时
  if (name.startsWith('@types/')) {
    skipped.push(name);
    continue;
  }
  const dir = await packageDirOf(name, from);
  if (!dir) {
    missing.push(name);
    continue;
  }
  seen.set(name, dir);
  let meta = {};
  try {
    meta = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    /* ignore */
  }
  for (const dep of [...Object.keys(meta.dependencies ?? {}), ...Object.keys(meta.optionalDependencies ?? {})]) {
    if (!seen.has(dep)) queue.push({ name: dep, from: dir });
  }
}
// 可选依赖（例如 @napi-rs/canvas）装不上也不影响主流程，只提示
const hardMissing = missing.filter((m) => !m.startsWith('@napi-rs/'));
if (hardMissing.length) {
  throw new Error(`这些依赖没找到，打出来的包会缺文件：${hardMissing.join(', ')}`);
}
const nmOut = path.join(APP_DIR, 'node_modules');
for (const [name, dir] of seen) {
  const dest = path.join(nmOut, name);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(dir, dest, { recursive: true, dereference: true });
}
log(`      生产依赖 ${seen.size} 个：${[...seen.keys()].sort().join(', ')}`);

// ---------------------------------------------------------------- 6. 说明文件
log('[6/6] 写使用说明 …');
const readme = `文献架 LitShelf —— 绿色免安装版
=================================

怎么用
------
1. 双击本文件夹里的「${EXE_NAME}」就能打开软件（不需要安装任何东西）。
2. 第一次打开会让你选一个「文献文件夹」（放 PDF / Word / 文本的地方）。
   软件会自动扫描里面的文献，之后你在文件夹里增删改文件，软件里会自动跟着变。
3. 阅读时：双击列表里的文献即可打开；常用快捷键见软件里按「?」。

把这个文件夹发给别人
--------------------
整个文件夹压缩成 zip 发给对方即可，对方解压后双击同一个 exe 就能用。
对方第一次打开时自己选文献文件夹；软件的数据（书签/批注/阅读位置）存在
  %APPDATA%\\文献架 LitShelf
里，不会写进本文件夹，所以整包可以直接拷来拷去。

系统要求
--------
Windows 10/11 64 位。
`;
await fs.writeFile(path.join(OUT_ROOT, '使用说明.txt'), readme, 'utf8');

// ---------------------------------------------------------------- 完成
const { total, files } = await dirSize(OUT_ROOT);
log('');
log(`✅ 整合版已生成：${OUT_ROOT}`);
log(`   文件数 ${files}，总大小 ${(total / 1024 / 1024).toFixed(1)} MB`);
log(`   启动程序：${path.join(OUT_ROOT, EXE_NAME)}`);

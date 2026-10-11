/**
 * 构建脚本：esbuild 打主进程 / preload / 浏览器形态服务端，vite 打渲染层，并同步 pdf.js 静态资源。
 *
 *   node scripts/build.mjs                 完整构建（服务端 + 主进程 + preload + 渲染层）
 *   node scripts/build.mjs --no-renderer   只构建服务端 / 主进程 / preload（渲染层还没就绪时用）
 *   node scripts/build.mjs --server        只构建浏览器形态服务端
 *   node scripts/build.mjs --watch         常驻监听（esbuild context + watch）
 *
 * ESM/CJS 分界：主进程与 server 是 .mjs（ESM），preload 必须是 .cjs（Electron 的 preload 走 CJS）。
 * main/server 用 packages:'external' 保留第三方依赖走 node_modules；preload 无第三方依赖，全打包。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const ONLY_SERVER = argv.has('--server');
const NO_RENDERER = argv.has('--no-renderer') || ONLY_SERVER;
const WATCH = argv.has('--watch');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DEFINE = { __APP_VERSION__: JSON.stringify(pkg.version) };

const abs = (...parts) => path.join(ROOT, ...parts);

// ---------------------------------------------------------------- 资源同步

/**
 * pdf.js 的离线渲染资源。
 *
 * **wasm/ 与 iccs/ 千万别漏**：pdf.js v5 用它们解码 JPEG2000（openjpeg.wasm）、
 * JBIG2（jbig2.wasm），以及给 **CMYK JPEG 套 ICC 色彩配置**（qcms_bg.wasm + iccs/）。
 * 少了它们，中文期刊里那种 CMYK 照片会渲染成**一块灰色**（用户报的"图片显示不出来"），
 * JPX/JBIG2 图则直接不画。
 */
const ASSETS = [
  { from: abs('node_modules/pdfjs-dist/build/pdf.worker.min.mjs'), to: abs('src/renderer/public/pdf.worker.min.mjs') },
  { from: abs('node_modules/pdfjs-dist/cmaps'), to: abs('src/renderer/public/cmaps') },
  { from: abs('node_modules/pdfjs-dist/standard_fonts'), to: abs('src/renderer/public/standard_fonts') },
  { from: abs('node_modules/pdfjs-dist/wasm'), to: abs('src/renderer/public/wasm') },
  { from: abs('node_modules/pdfjs-dist/iccs'), to: abs('src/renderer/public/iccs') },
];

/** 目标已存在且不比源旧 → 跳过（幂等） */
async function isFresh(src, dest) {
  try {
    const [s, d] = await Promise.all([fsp.stat(src), fsp.stat(dest)]);
    return d.mtimeMs >= s.mtimeMs;
  } catch {
    return false;
  }
}

async function syncFile(src, dest, stats) {
  if (await isFresh(src, dest)) {
    stats.skipped += 1;
    return;
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
  stats.copied += 1;
}

async function syncDir(srcDir, destDir, stats) {
  let entries;
  try {
    entries = await fsp.readdir(srcDir, { withFileTypes: true });
  } catch (err) {
    console.error(`[build] 读取资源目录失败：${srcDir}`, err);
    stats.failed += 1;
    return;
  }
  await fsp.mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) await syncDir(src, dest, stats);
    else if (entry.isFile()) await syncFile(src, dest, stats);
  }
}

async function syncAssets() {
  const stats = { copied: 0, skipped: 0, failed: 0 };
  for (const asset of ASSETS) {
    let st;
    try {
      st = await fsp.stat(asset.from);
    } catch {
      console.error(`[build] 缺少资源：${path.relative(ROOT, asset.from)}（pdfjs-dist 是否已安装？）`);
      stats.failed += 1;
      continue;
    }
    if (st.isDirectory()) await syncDir(asset.from, asset.to, stats);
    else await syncFile(asset.from, asset.to, stats);
  }
  console.log(`[build] pdf.js 资源同步完成：新增/更新 ${stats.copied} 个，跳过 ${stats.skipped} 个${stats.failed ? `，失败 ${stats.failed} 个` : ''}`);
  return stats.failed === 0;
}

// ---------------------------------------------------------------- esbuild 配置

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  // esbuild 的 info 日志走 stderr，在 PowerShell 里会被当成错误记录；这里只保留警告，
  // 进度与体积由下面的 console.log 输出。
  logLevel: 'warning',
  define: DEFINE,
  // 第三方依赖（chokidar / pdfjs-dist / mammoth / electron ...）保持 external，由 node_modules / 运行时提供
  packages: 'external',
};

/** @type {import('esbuild').BuildOptions[]} */
const builds = [];
if (!ONLY_SERVER) {
  builds.push({ ...common, entryPoints: [abs('src/main/index.ts')], outfile: abs('dist/main/index.mjs'), format: 'esm' });
}
builds.push({ ...common, entryPoints: [abs('src/server/index.ts')], outfile: abs('dist/server/index.mjs'), format: 'esm' });
if (!ONLY_SERVER) {
  builds.push({
    entryPoints: [abs('src/preload/index.ts')],
    outfile: abs('dist/preload/index.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: true,
    logLevel: 'warning',
    define: DEFINE,
    // preload 不依赖第三方，全部打包；但 electron 必须由运行时注入
    external: ['electron'],
  });
}

// ---------------------------------------------------------------- 渲染层

async function buildRenderer() {
  if (NO_RENDERER) {
    console.log('[build] 跳过渲染层（--no-renderer / --server）');
    return;
  }
  if (!fs.existsSync(abs('src/renderer/index.html'))) {
    throw new Error('渲染层入口不存在：src/renderer/index.html（渲染层还没就绪时请用 --no-renderer）');
  }
  const { build } = await import('vite');
  await build({ configFile: abs('vite.config.ts') });
  console.log('[build] 渲染层产物：dist/renderer');
}

// ---------------------------------------------------------------- 主流程

async function reportOutputs() {
  for (const file of ['dist/main/index.mjs', 'dist/preload/index.cjs', 'dist/server/index.mjs']) {
    try {
      const st = await fsp.stat(abs(file));
      console.log(`[build] ${file}  ${(st.size / 1024).toFixed(1)} KB`);
    } catch {
      /* 该形态本次没构建 */
    }
  }
}

async function main() {
  if (!ONLY_SERVER) {
    const ok = await syncAssets();
    if (!ok) console.warn('[build] 有资源同步失败，阅读器可能缺少字体/CMap（其余产物继续构建）');
  }

  if (WATCH) {
    const contexts = [];
    for (const options of builds) {
      const ctx = await esbuild.context(options);
      await ctx.watch();
      contexts.push(ctx);
      console.log(`[build] 监听中：${path.relative(ROOT, options.outfile ?? String(options.entryPoints?.[0]))}`);
    }
    console.log('[build] watch 模式已就绪（Ctrl+C 退出）');
    const stop = async () => {
      for (const ctx of contexts) await ctx.dispose().catch(() => undefined);
      process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
    return;
  }

  for (const options of builds) {
    const out = path.relative(ROOT, String(options.outfile));
    console.log(`[build] 打包 ${path.relative(ROOT, String(options.entryPoints?.[0]))} → ${out}`);
    await esbuild.build(options);
  }
  await buildRenderer();
  await reportOutputs();
  console.log('[build] 构建完成');
}

main().catch((err) => {
  console.error('[build] 构建失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});

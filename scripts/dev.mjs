/**
 * 桌面开发态一条命令：esbuild watch（main + preload）→ Vite 开发服务器 → Electron。
 *
 *   node scripts/dev.mjs
 *
 * Vite 端口被占用时会自动顺延，这里用 resolvedUrls 拿**真实**地址再交给 Electron；
 * 主进程改动只重新打包，重启 Electron 请直接重跑本脚本。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const abs = (...parts) => path.join(ROOT, ...parts);
const children = new Set();

function killAll() {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  children.clear();
}

function shutdown(code) {
  killAll();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function track(child) {
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function waitForFile(file, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fs.existsSync(file)) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`等待 ${label} 超时：${path.relative(ROOT, file)} 未生成`));
        return;
      }
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function main() {
  if (!fs.existsSync(abs('src/renderer/index.html'))) {
    throw new Error('渲染层入口不存在：src/renderer/index.html，无法启动开发服务器');
  }

  // 1) main / preload 常驻打包
  console.log('[dev] 启动 esbuild watch（main + preload）…');
  const builder = track(
    spawn(process.execPath, [abs('scripts/build.mjs'), '--no-renderer', '--watch'], { cwd: ROOT, stdio: 'inherit' }),
  );
  builder.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`[dev] 打包进程退出，code=${code}`);
      shutdown(code);
    }
  });

  await waitForFile(abs('dist/main/index.mjs'), 60000, '主进程产物');
  await waitForFile(abs('dist/preload/index.cjs'), 60000, 'preload 产物');
  console.log('[dev] 主进程 / preload 产物就绪');

  // 2) Vite 开发服务器（端口被占用会自动换端口）
  const { createServer } = await import('vite');
  const vite = await createServer({ configFile: abs('vite.config.ts') });
  await vite.listen();
  const url = (vite.resolvedUrls?.local?.[0] ?? `http://localhost:${vite.config.server.port ?? 5173}`).replace(/\/$/, '');
  console.log(`[dev] 渲染层开发服务器：${url}`);

  // 3) Electron
  let electronPath;
  try {
    ({ default: electronPath } = await import('electron'));
  } catch (err) {
    throw new Error(`无法定位 Electron 可执行文件（node_modules/electron 是否已安装并下载二进制？）：${err.message}`);
  }
  console.log('[dev] 启动 Electron…');
  // 在 Electron 系 IDE（VS Code 等）里跑本脚本时，环境里往往带着 ELECTRON_RUN_AS_NODE=1，
  // 那会让 electron.exe 退化成普通 Node，报出莫名其妙的模块错误 —— 这里显式去掉。
  const electronEnv = { ...process.env, LITSHELF_DEV_SERVER_URL: url };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const electron = track(
    spawn(electronPath, [abs('dist/main/index.mjs')], {
      cwd: ROOT,
      stdio: 'inherit',
      env: electronEnv,
    }),
  );

  electron.on('exit', (code) => {
    console.log(`[dev] Electron 已退出（code=${code}），正在清理…`);
    void vite.close().finally(() => shutdown(code ?? 0));
  });
}

main().catch((err) => {
  console.error('[dev] 启动失败：', err instanceof Error ? err.message : err);
  shutdown(1);
});

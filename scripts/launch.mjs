/**
 * 一键启动（被 启动文献架.bat 调用）。
 *
 * 为什么逻辑放在这里而不是 .bat 里：cmd 按当前代码页逐字节解析批处理文件，
 * 含中文的 .bat（尤其是括号块里的多字节字符）会被解析错乱。批处理保持纯 ASCII，
 * 全部判断与中文提示都由 Node 输出（UTF-8，配合 chcp 65001 显示正常）。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...args) => console.log(...args);

function run(command, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', shell: false, ...opts });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

async function main() {
  log('');
  log('  ============================================');
  log('   文献架 LitShelf —— 本地文献阅读与管理');
  log('  ============================================');
  log('');

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    log(`  [错误] Node.js 版本过低（当前 ${process.version}），请安装 Node.js 20 或更高版本。`);
    log('         https://nodejs.org/');
    return 1;
  }

  if (!exists('node_modules')) {
    log('  [1/3] 首次运行，正在安装依赖（大约 1-3 分钟）…');
    const code = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts']);
    if (code !== 0) {
      log('  [错误] 依赖安装失败，请检查网络后重试。');
      return 1;
    }
    if (exists('node_modules/electron/package.json')) {
      log('        正在下载 Electron 运行时（国内镜像）…');
      await run(process.execPath, ['node_modules/electron/install.js'], {
        env: { ...process.env, ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/' },
      });
    }
  }

  if (!exists('dist/main/index.mjs') || !exists('dist/renderer/index.html')) {
    log('  [2/3] 正在构建（第一次会慢一点）…');
    const code = await run(process.execPath, ['scripts/build.mjs']);
    if (code !== 0) {
      log('  [错误] 构建失败，请把上面的报错发给开发者。');
      return 1;
    }
  }

  const electronExe =
    process.platform === 'win32'
      ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
      : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');

  const env = { ...process.env };
  // 某些 Electron 系工具会设置这个变量，它会让 electron.exe 退化成普通 Node
  delete env.ELECTRON_RUN_AS_NODE;

  if (fs.existsSync(electronExe)) {
    log('  [3/3] 正在打开文献架窗口…');
    const child = spawn(electronExe, ['.'], { cwd: ROOT, env, detached: true, stdio: 'ignore' });
    child.unref();
    log('        窗口已启动（关掉窗口默认最小化到托盘，可在设置里改）。');
    return 0;
  }

  log('  [提示] 没有找到 Electron 运行时，自动改用浏览器形态（功能与数据完全一致）。');
  let code = await run(process.execPath, ['scripts/build.mjs', '--server']);
  if (code !== 0) return 1;
  const server = spawn(process.execPath, ['dist/server/index.mjs'], { cwd: ROOT, env, detached: true, stdio: 'ignore' });
  server.unref();
  await new Promise((r) => setTimeout(r, 2500));
  const url = `http://127.0.0.1:${process.env.LITSHELF_PORT ?? 7788}`;
  log(`        浏览器形态已启动：${url}`);
  if (process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('启动失败：', err);
    process.exitCode = 1;
  });

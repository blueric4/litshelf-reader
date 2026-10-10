/**
 * 浏览器形态开发态：先构建服务端，再以 LITSHELF_DEV=1 启动（静态请求交给 Vite 中间件）。
 *
 *   node scripts/dev-web.mjs      # → http://127.0.0.1:7788
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const abs = (...parts) => path.join(ROOT, ...parts);

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', env: env ?? process.env });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

async function main() {
  console.log('[dev:web] 构建服务端…');
  const buildCode = await run(process.execPath, [abs('scripts/build.mjs'), '--server']);
  if (buildCode !== 0) {
    console.error(`[dev:web] 构建失败，code=${buildCode}`);
    process.exit(buildCode);
  }

  console.log('[dev:web] 启动浏览器形态服务端（Vite 中间件模式）…');
  const child = spawn(process.execPath, [abs('dist/server/index.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, LITSHELF_DEV: '1' },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error('[dev:web] 启动失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});

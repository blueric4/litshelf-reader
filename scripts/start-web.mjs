/**
 * 浏览器形态生产态：先构建服务端，再在同一进程内直接运行它（托管 dist/renderer）。
 *
 *   node scripts/start-web.mjs    # → http://127.0.0.1:7788
 *
 * 等价于 package.json 里的 `pnpm start:web`。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

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
  console.log('[start:web] 构建服务端…');
  const buildCode = await run(process.execPath, [abs('scripts/build.mjs'), '--server']);
  if (buildCode !== 0) {
    console.error(`[start:web] 构建失败，code=${buildCode}`);
    process.exit(buildCode);
  }

  // 生产模式：不设置 LITSHELF_DEV，服务端会托管 dist/renderer
  delete process.env.LITSHELF_DEV;
  console.log('[start:web] 启动浏览器形态服务端（生产模式）…');
  await import(pathToFileURL(abs('dist/server/index.mjs')).href);
}

main().catch((err) => {
  console.error('[start:web] 启动失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});

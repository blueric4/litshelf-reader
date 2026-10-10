/**
 * 把 tools/ 下的 TS 验收脚本用 esbuild 打包成可直接 node 运行的 .mjs。
 *   node tools/build-tools.mjs tools/verify-core.ts
 */
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.argv[2] ?? 'tools/verify-core.ts';
await esbuild.build({
  entryPoints: [path.join(root, entry)],
  outfile: path.join(root, entry.replace(/\.ts$/, '.mjs')),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: false,
  logLevel: 'warning',
});
console.log(`built ${entry.replace(/\.ts$/, '.mjs')}`);

/**
 * 验收脚本（Lead 亲自跑的那一份）：真实文件系统 + 真实 PDF + 真实监听。
 * 用法：node tmp/build-verify.mjs && node tmp/verify.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Host } from '../src/core/host';
import { createSampleLibrary } from '../src/core/sample';
import { toBibTeX, toCSV } from '../src/core/export';
import type { HostEvent } from '../src/shared/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function ok(cond: boolean, label: string, extra = '') {
  if (!cond) failures += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
}

function head(title: string) {
  console.log(`\n${title}`);
}

async function waitFor(label: string, fn: () => boolean, timeoutMs = 90000, interval = 200): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(interval);
  }
  console.log(`  ✗ 超时：${label}`);
  failures += 1;
  return false;
}

async function main() {
  const base = path.join(process.cwd(), 'tmp', `verify-${Date.now()}`);
  const dataDir = path.join(base, 'data');
  const libDir = path.join(base, '文献库');
  await fs.mkdir(libDir, { recursive: true });
  console.log(`工作目录：${base}`);

  head('[1] 示例文献生成（手写合法 PDF）');
  const samples = await createSampleLibrary(libDir);
  ok(samples.files === 14, `生成 ${samples.files} 个文件（8 PDF + 4 MD + 2 TXT）`);

  const events: HostEvent[] = [];
  const host = new Host({ dataDir, mode: 'web', version: 'verify', online: false });
  host.subscribe((e) => events.push(e));
  await host.start();

  head('[2] 首次扫描：条目先出现，再补元数据');
  const t0 = Date.now();
  const { root } = await host.addRoot(libDir);
  ok(host.library.all().length === 14, `addRoot 后立刻入库 ${host.library.all().length} 条`, `${Date.now() - t0}ms`);
  const allReady = await waitFor('全部解析完成', () => host.library.all().every((i) => i.parseState !== 'placeholder'));
  ok(allReady, '所有条目解析结束');
  const failed = host.library.all().filter((i) => i.parseState === 'failed');
  ok(failed.length === 0, '零解析失败', failed.map((f) => `${f.name}: ${f.parseError}`).join(' | '));

  const pdfs = host.library.all().filter((i) => i.kind === 'pdf');
  ok(pdfs.length === 8, `识别 8 个 PDF`);
  ok(pdfs.every((p) => p.pageCount >= 3), `每篇 PDF 都解析出页数：${pdfs.map((p) => p.pageCount).join('/')}`);
  ok(pdfs.every((p) => p.title.length > 3), '每篇 PDF 都有标题');
  ok(pdfs.filter((p) => p.year).length >= 6, `${pdfs.filter((p) => p.year).length}/8 篇解析出年份`);
  ok(pdfs.filter((p) => p.excerpt.length > 20).length === 8, '每篇都有正文摘要（供列表与搜索用）');
  const cn = host.library.all().find((i) => /[\u4e00-\u9fa5]/.test(i.name));
  ok(!!cn, '中文文件名正常入库', cn?.name ?? '');
  ok(host.library.all().some((i) => i.dir === '子目录'), '子目录被递归发现');
  ok(host.getFolderTree().some((t) => t.dirs.includes('子目录')), '文件夹树包含子目录');

  head('[3] 文件夹变化 → 软件自动跟着变（核心需求）');
  const target = pdfs[0];
  host.library.patchItem(target.id, { starred: true, tags: ['验收'], readState: 'reading' });
  host.setNote(target.id, '## 我的笔记\n\n这段笔记不能被扫描冲掉。');
  host.setProgress(target.id, { page: 4, total: target.pageCount, percent: 60 });

  const renamed = path.join(path.dirname(target.path), `改名验证 ${Date.now()}.pdf`);
  await fs.rename(target.path, renamed);
  const renamedOk = await waitFor('改名被识别', () => host.library.get(target.id)?.path === renamed, 30000);
  const afterRename = host.library.get(target.id);
  ok(renamedOk, '改名后路径更新');
  ok(afterRename?.id === target.id, '条目 id 未变（数据不丢的关键）');
  ok(afterRename?.starred === true, '星标保留');
  ok((afterRename?.tags ?? []).includes('验收'), '标签保留');
  ok((afterRename?.note ?? '').includes('不能被扫描冲掉'), '笔记保留');
  ok(afterRename?.progress.page === 4, '阅读进度保留');
  ok(host.library.all().filter((i) => i.path === renamed).length === 1, '没有重复条目');

  const copyPath = path.join(libDir, `副本 ${Date.now()}.pdf`);
  await fs.copyFile(renamed, copyPath);
  await waitFor('副本入库', () => host.library.all().some((i) => i.path === copyPath), 30000);
  const copyItem = host.library.all().find((i) => i.path === copyPath);
  ok(!!copyItem, '副本已入库');
  ok(copyItem?.id !== target.id, '副本是独立条目（同内容也不会被误判成改名）');
  ok(host.library.get(target.id)?.path === renamed, '原条目未被抢占');

  const victimId = copyItem!.id;
  await fs.unlink(copyPath);
  await waitFor('删除被识别', () => host.library.get(victimId)?.missing === true, 30000);
  ok(host.library.get(victimId)?.missing === true, '删除后条目仍在，标记「文件缺失」');
  ok(host.library.all().some((i) => i.id === victimId), '条目没有被删掉');
  await fs.writeFile(copyPath, await fs.readFile(renamed));
  await waitFor('文件回来自动复活', () => host.library.get(victimId)?.missing === false, 30000);
  ok(host.library.get(victimId)?.missing === false, '文件放回后自动复活');

  head('[4] 覆盖保存 → 重解析 + 批注按锚点重定位');
  const ann = host.addAnnotation({
    itemId: target.id,
    type: 'highlight',
    page: 2,
    rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.02 }],
    text: 'Verification Anchor Text',
    anchor: { prefix: 'alpha', suffix: 'omega', occurrence: 1 },
    comment: '这条批注必须活下来',
    color: 'yellow',
  });
  const revBefore = host.library.get(target.id)!.revision;
  const buf = await fs.readFile(renamed);
  await fs.writeFile(renamed, Buffer.concat([buf, Buffer.from('\n% appended by verify\n')]));
  await waitFor('覆盖保存被识别', () => (host.library.get(target.id)?.revision ?? 0) > revBefore, 30000);
  ok(host.library.get(target.id)!.revision > revBefore, `revision ${revBefore} → ${host.library.get(target.id)!.revision}`);
  await sleep(3500);
  const anns = host.listAnnotations(target.id);
  ok(anns.length === 1, '批注没有被静默删除');
  ok(anns[0]?.comment === '这条批注必须活下来', '批注内容完整');
  ok(host.library.get(target.id)!.annotationCount === 1, '批注计数同步');
  ok(host.library.get(target.id)!.note.includes('不能被扫描冲掉'), '覆盖保存后笔记仍在');

  head('[5] 全文索引与检索');
  const idx = await host.indexItemText(target.id);
  ok(idx.ok && idx.pages >= 3, `建立全文索引：${idx.pages} 页`);
  const byTitle = await host.search(pdfs[1].title.slice(0, 10));
  ok(byTitle.length > 0, '按标题能搜到');
  const byTag = await host.search('tag:验收');
  ok(byTag.length === 1 && byTag[0].item.id === target.id, '按 tag: 语法能搜到');
  const byAnn = await host.search('批注必须活下来');
  ok(byAnn.some((h) => h.item.id === target.id), '按批注内容能搜到');
  const byFullText = await host.search('Page 3 of');
  ok(byFullText.length > 0, '按 PDF 正文能搜到（全文检索生效）', `命中 ${byFullText.length} 篇`);
  const byYear = await host.search('year:2020..2025');
  ok(byYear.length >= 6, `year: 范围语法生效（${byYear.length} 篇）`);
  const byIs = await host.search('is:starred');
  ok(byIs.length === 1, 'is:starred 过滤生效');

  head('[6] 导出');
  const all = host.library.all();
  const bib = toBibTeX(all);
  ok(bib.startsWith('@') && bib.includes(pdfs[1].title.slice(0, 8)), 'BibTeX 导出正常');
  const csv = toCSV(all);
  ok(csv.startsWith('\uFEFF') && csv.trim().split('\n').length === all.length + 1, `CSV 行数 = ${all.length} + 表头`);
  const exported = await host.exportLibrary({ format: 'markdown-notes', ids: [target.id] });
  ok(exported.ok && (exported.content ?? '').includes('批注'), '笔记+批注 Markdown 导出正常');

  head('[7] 笔记文件双向同步');
  const noteFile = path.join(dataDir, 'notes', `${target.id}.md`);
  await fs.writeFile(noteFile, '<!-- 外部编辑器改的 -->\n\n外部写入的新内容 XYZ');
  await host.stop();
  const host2 = new Host({ dataDir, mode: 'web', version: 'verify', online: false });
  await host2.start();
  const reloaded = host2.library.get(target.id);
  ok(!!reloaded, '重启后条目还在');
  ok(reloaded?.note.includes('外部写入的新内容 XYZ'), '外部编辑的笔记被读回');
  ok(reloaded?.starred === true, '重启后星标保留');
  ok(reloaded?.progress.page === 4, '重启后阅读进度保留');
  ok(host2.listAnnotations(target.id).length === 1, '重启后批注保留');
  ok(host2.library.all().length === host.library.all().length, `条目数一致（${host2.library.all().length}）`);
  ok(host2.library.all().filter((i) => i.missing).length === 0, '没有误标文件缺失');

  head('[8] 事件流（界面靠增量事件更新）');
  const kinds = new Map<string, number>();
  for (const e of events) kinds.set(e.type, (kinds.get(e.type) ?? 0) + 1);
  console.log('  ' + [...kinds.entries()].map(([k, v]) => `${k}×${v}`).join(' · '));
  ok((kinds.get('items:patch') ?? 0) > 5, 'items:patch 事件充足');
  ok((kinds.get('scan:progress') ?? 0) > 0, 'scan:progress 事件存在');
  ok((kinds.get('toast') ?? 0) > 0, 'toast 提示存在');

  head('[9] 统计与收尾');
  const stats = host2.stats();
  console.log(`  条目 ${stats.items} · 缺失 ${stats.missing} · 已解析 ${stats.ready} · 全文索引 ${stats.textIndexed} · 批注 ${stats.annotations}`);
  ok(stats.ready >= 14, '全部条目完成解析');
  await host2.stop();

  console.log(`\n${failures ? `❌ 失败 ${failures} 项` : '✅ 全部通过'}`);
  console.log(`工作目录保留在：${base}`);
  process.exitCode = failures ? 1 : 0;
}

process.on('uncaughtException', (err) => {
  console.error('验收脚本异常：', err);
  process.exit(9);
});
process.on('unhandledRejection', (reason) => {
  console.error('未处理的 Promise 拒绝：', reason);
  process.exit(9);
});

main().catch((err) => {
  console.error('验收脚本失败：', err);
  process.exit(1);
});

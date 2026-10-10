# LitShelf 独立验收报告

- 验收员：`verifier`（独立于 `lead` / `docsmith` / `reviewer`）
- 共享任务：`task-1`（跑完整验收批次并出可复核报告）
- 执行时间：2026-10-09 20:24 – 20:33（本机本地时间）
- 工作目录：`.`
- 运行环境：Node **v24.19.0**；shell 为 **Windows PowerShell 5.1**（`>` 重定向落盘为 UTF-16LE，故落盘日志用 `Get-Content` / `Select-String` 读取，直接按文本读会被判为二进制）
- 被验构建：`dist/**` 由本报告第 2 条命令在 **20:25:07** 重新生成；`src/**` 最后一次修改为 **19:42:49**（`src/renderer/App.tsx`），即本次验收针对的是该源码状态编译出的产物
- `ELECTRON_RUN_AS_NODE=1` 在本会话环境里存在：每个桌面脚本运行**前后**都执行了 `Remove-Item Env:\ELECTRON_RUN_AS_NODE` 与 `Get-Process electron | Stop-Process -Force`，所有桌面脚本**严格串行**（一次只跑一个）

---

## 0. 结论摘要

| # | 套件 | 命令 | 期望 | 首跑实测 | 复跑实测 | 结论 |
|---|------|------|------|----------|----------|------|
| 1 | 类型检查 | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | exit 0 | exit 0，**零输出**，4.4s | — | ✅ 通过 |
| 2 | 构建 | `node scripts/build.mjs` | exit 0 | exit 0，4.3s，四个产物齐全 | — | ✅ 通过 |
| 3 | 单元测试 | `node node_modules/vitest/vitest.mjs run` | 10 文件 / 209 用例 | **10 passed (10) / 209 passed (209)**，exit 0 | — | ✅ 通过 |
| 4 | 核心逻辑 | `node tools/build-tools.mjs tools/verify-core.ts` + `node tools/verify-core.mjs` | 43 项 | **51 ✓ / 0 ✗**，exit 0 | — | ✅ 通过（**项数与卡片 43 不符，见 §4.1**） |
| 5 | 桌面端到端 | `node tools/e2e-desktop.mjs` | 26 项 | **24 ✓ / 2 ✗**，exit 1 | **26 ✓ / 0 ✗**，exit 0 | ⚠️ **首跑失败、复跑通过（间歇）** |
| 6 | 补充验收 | `node tools/acceptance.mjs` | 37 项 | **37 ✓ / 0 ✗**，exit 0 | — | ✅ 通过 |
| 7 | 中文划词/缩放 | `node tools/acceptance-cjk.mjs` | 17 项 | **0 ✓ / 4 ✗**，exit 1（A 节失败后中止，只跑到 4 项） | **17 ✓ / 0 ✗**，exit 0 | ⚠️ **首跑失败、复跑通过（间歇）** |

一句话结论：**核心链路（类型/构建/单测/核心逻辑/补充验收）全绿且可复核；两套桌面脚本在同一个构建上首跑失败、复跑全绿，失败根因经独立探针定位为「阅读器已打开、canvas 已绘制，但 PDF 文本层 span 在 30 秒内始终为 0」的应用侧间歇问题，而不是脚本没打开阅读器。**

---

## 1. 原始关键输出（逐条可复核）

所有原始日志都已落盘保留在 `tmp/v-*.txt`（UTF-16LE，用 `Get-Content` 读）。下面每条都给出「计数命令 + 原文」。

### 1.1 类型检查（第 1 条）

```
命令: node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit > tmp\v-tsc.txt 2>&1
exit=0 elapsed=4.4s
bytes=0 lines=0
```

`tmp/v-tsc.txt` 为 **0 字节**：无错误、无警告输出。exit code 0。

### 1.2 构建（第 2 条）

```
命令: node scripts/build.mjs > tmp\v-build.txt 2>&1
exit=0 elapsed=4.3s
```

原文（`tmp/v-build.txt`，节选关键行，全文 79 行）：

```
[build] pdf.js 资源同步完成：新增/更新 0 个，跳过 186 个
[build] 打包 src\main\index.ts → dist\main\index.mjs
[build] 打包 src\server\index.ts → dist\server\index.mjs
[build] 打包 src\preload\index.ts → dist\preload\index.cjs
vite v8.3.4 building client environment for production...
✓ 349 modules transformed.
dist/renderer/index.html                                           0.86 kB │ gzip:   0.46 kB
dist/renderer/assets/index-CDyhPHYT.css                           86.56 kB │ gzip:  20.46 kB
dist/renderer/assets/lib-pZpY0CmL.js                             308.06 kB │ gzip:  95.08 kB
dist/renderer/assets/index-CWDYmle7.js                         1,354.51 kB │ gzip: 417.09 kB
✓ built in 2.62s
[build] 渲染层产物：dist/renderer
[build] dist/main/index.mjs  175.8 KB
[build] dist/preload/index.cjs  2.0 KB
[build] dist/server/index.mjs  167.8 KB
[build] 构建完成
```

### 1.3 单元测试（第 3 条）

```
命令: node node_modules/vitest/vitest.mjs run > tmp\v-vitest.txt 2>&1
exit=0 elapsed=2.2s
```

`tmp/v-vitest.txt` 全文（19 行）：

```
 RUN  v5.0.3 D:/dsh/litshelf

 ✓ tests/ignore.test.ts (18 tests) 5ms
 ✓ tests/naming.test.ts (19 tests) 12ms
 ✓ tests/reanchor.test.ts (18 tests) 6ms
 ✓ tests/search.test.ts (26 tests) 12ms
 ✓ tests/metadata.test.ts (15 tests) 39ms
 ✓ tests/export.test.ts (24 tests) 49ms
 ✓ tests/fingerprint.test.ts (15 tests) 63ms
 ✓ tests/store.test.ts (17 tests) 168ms
 ✓ tests/paths.test.ts (26 tests) 169ms
 ✓ tests/library-reconcile.test.ts (31 tests) 379ms

 Test Files  10 passed (10)
      Tests  209 passed (209)
   Start at  20:25:11
   Duration  997ms (transform 43%, tests 34%, import 13%, worker 10%)
```

18+19+18+26+15+24+15+17+26+31 = **209**，与 `209 passed (209)` 自洽；10 个文件与卡片期望一致。

### 1.4 核心逻辑（第 4 条）

```
命令: node tools/build-tools.mjs tools/verify-core.ts > tmp\v-buildtools.txt 2>&1   → exit 0
原文: built tools/verify-core.mjs
命令: node tools/verify-core.mjs > tmp\v-verifycore.txt 2>&1                          → exit 0 elapsed=15.8s
计数: PASS=51  FAIL=0   （Get-Content tmp\v-verifycore.txt | Select-String '✓' / '✗'）
```

`tmp/v-verifycore.txt` 全文（75 行，含空行）：

```
工作目录：tmp\verify-1791548715518

[1] 示例文献生成（手写合法 PDF）
  ✓ 生成 14 个文件（8 PDF + 4 MD + 2 TXT）

[2] 首次扫描：条目先出现，再补元数据
  ✓ addRoot 后立刻入库 14 条 — 59ms
  ✓ 所有条目解析结束
  ✓ 零解析失败
  ✓ 识别 8 个 PDF
  ✓ 每篇 PDF 都解析出页数：5/5/8/4/7/6/4/3
  ✓ 每篇 PDF 都有标题
  ✓ 8/8 篇解析出年份
  ✓ 每篇都有正文摘要（供列表与搜索用）
  ✓ 中文文件名正常入库 — 2022 会议投稿要点.txt
  ✓ 子目录被递归发现
  ✓ 文件夹树包含子目录

[3] 文件夹变化 → 软件自动跟着变（核心需求）
  ✓ 改名后路径更新
  ✓ 条目 id 未变（数据不丢的关键）
  ✓ 星标保留
  ✓ 标签保留
  ✓ 笔记保留
  ✓ 阅读进度保留
  ✓ 没有重复条目
  ✓ 副本已入库
  ✓ 副本是独立条目（同内容也不会被误判成改名）
  ✓ 原条目未被抢占
  ✓ 删除后条目仍在，标记「文件缺失」
  ✓ 条目没有被删掉
  ✓ 文件放回后自动复活

[4] 覆盖保存 → 重解析 + 批注按锚点重定位
  ✓ revision 1 → 2
  ✓ 批注没有被静默删除
  ✓ 批注内容完整
  ✓ 批注计数同步
  ✓ 覆盖保存后笔记仍在

[5] 全文索引与检索
  ✓ 建立全文索引：5 页
  ✓ 按标题能搜到
  ✓ 按 tag: 语法能搜到
  ✓ 按批注内容能搜到
  ✓ 按 PDF 正文能搜到（全文检索生效） — 命中 5 篇
  ✓ year: 范围语法生效（8 篇）
  ✓ is:starred 过滤生效

[6] 导出
  ✓ BibTeX 导出正常
  ✓ CSV 行数 = 15 + 表头
  ✓ 笔记+批注 Markdown 导出正常

[7] 笔记文件双向同步
  ✓ 重启后条目还在
  ✓ 外部编辑的笔记被读回
  ✓ 重启后星标保留
  ✓ 重启后阅读进度保留
  ✓ 重启后批注保留
  ✓ 条目数一致（15）
  ✓ 没有误标文件缺失

[8] 事件流（界面靠增量事件更新）
  roots:update×7 · scan:progress×15 · items:patch×29 · toast×7
  ✓ items:patch 事件充足
  ✓ scan:progress 事件存在
  ✓ toast 提示存在

[9] 统计与收尾
  条目 15 · 缺失 0 · 已解析 15 · 全文索引 1 · 批注 1
  ✓ 全部条目完成解析

✅ 全部通过
工作目录保留在：tmp\verify-1791548715518
```

**为什么是 51 而不是卡片写的 43**：脚本本身不打印总数，每一条 `ok(...)` 对应一行 ✓/✗。用只读检索统计源码里的断言点：

```
只读检索 tools/verify-core.ts 中 ^\s*ok\(      → 51 处
Select-String '✓' tmp\v-verifycore.txt         → 51 行
Select-String '✗' tmp\v-verifycore.txt         → 0 行
```

即 `ok(` 调用点 **51** 个，运行输出 ✓ **51** 行，二者严格相等，且失败 0。故实测口径是 **51/51 通过**；卡片里的「43 项」应是旧版本的期望值，建议 Lead 修正（见 §4.1）。

### 1.5 桌面端到端（第 5 条）

```
命令: node tools/e2e-desktop.mjs > tmp\v-e2e.txt 2>&1        （首跑）
exit=1 elapsed=54.9s   PASS=24 FAIL=2
```

`tmp/v-e2e.txt` 关键原文（节选，全文 66 行）：

```
数据目录（隔离、已重置，不动真实库）：tmp\e2e-data
已连上渲染进程：file:///D:/dsh/litshelf/dist/renderer/index.html
...
[5] 双击打开阅读器（PDF 真实渲染）
  ✓ 在列表第 1 行找到 PDF 条目并双击
  ✓ 阅读器渲染出 3 个 canvas
  ✓ 页码显示：1 / 3 页
  ✗ 文本层有 0 个 span（可选中、可批注）
  ✗ 能用选区拿到文本与矩形：
  诊断： {"textishClasses":["rd-pdf-text","rd-pdf-text","rd-pdf-text"],"pageChildren":["CANVAS.rd-pdf-canvas","DIV.rd-pdf-text","DIV.rd-page-skeleton","DIV.rd-ann-layer"],"spansTotal":10,"canvasCount":3}
  📷 04-reader.png（124 KB）
...
[10] 控制台健康检查
  ✓ 渲染层零错误（0 条）
...
❌ 失败 2 项
截图目录：tmp\shots
```

```
命令: node tools/e2e-desktop.mjs > tmp\v-e2e-2.txt 2>&1      （复跑）
exit=0 elapsed=48.6s   PASS=26 FAIL=0
```

复跑同一节原文：

```
[5] 双击打开阅读器（PDF 真实渲染）
  ✓ 在列表第 1 行找到 PDF 条目并双击
  ✓ 阅读器渲染出 4 个 canvas
  ✓ 页码显示：1 / 3 页
  ✓ 文本层有 24 个 span（可选中、可批注）
  ✓ 能用选区拿到文本与矩形：Reading Chinese Papers on a Local Shelf|
  📷 04-reader.png（124 KB）
...
✅ 桌面端到端验收全部通过
```

### 1.6 补充验收（第 6 条）

```
命令: node tools/acceptance.mjs > tmp\v-acceptance.txt 2>&1
exit=0 elapsed=61.3s   PASS=37 FAIL=0
```

`tmp/v-acceptance.txt` 全文（62 行）：

```
隔离数据目录：tmp\acceptance-data

[A] 规模测试：300 个文件（含 emoji 名 + 超长嵌套路径）
  ✓ 造出 300 个文件
  ✓ emoji 文件名已就位
  引导页：skipped
  基线：0 条 / 0 个文献库（隔离目录，结束时应还原）
  ✓ 已添加文献库「scale-library」
  ✓ 全部文件出现在库里：300 条
  ✓ 全部解析完成：300 条 — 总耗时 0.9s
  ✓ 300 个文件的首次索引在 0.9s 内完成
  ✓ emoji 文件名的文献正常解析：{"title":"Deep Learning for Medical Imaging: A Practical Review","pages":6,"state":"ready"}
  ✓ 超长嵌套路径下的文件被递归发现：100 条

[B] 软件不往用户文件夹里写东西
  ✓ 被监听目录顶层没有软件产生的文件（102 个条目全是用户自己的）

[C] 阅读位置记忆（关掉重开仍停在同一页）
  ✓ PDF 已在软件内打开
  ✓ 记录到打开的是《Transformer Architectures: A Survey of Variants》
  ✓ 在列表里重新双击同一篇
  ✓ 宿主里的阅读位置 = 第 2 页（设置了第 2 页）
  ✓ 重开后自动停在第 2 页（当前：2 / 7 页）

[D] 划词 → 高亮 → 批注侧栏
  ✓ 清空该篇历史批注 0 条，保证可复现
  ✓ 拿到一行可拖选的文字：Transformer Architectures: A Survey of V
  ✓ 真实鼠标拖选后划词工具条出现（4 个动作）
  📷 10-selection-toolbar.png
  ✓ 批注已写入宿主（0 → 1 条） — {"page":1,"text":"Transformer Architec","rects":1}
  ✓ 批注带 1 个相对矩形（缩放后仍能定位）
  ✓ 页面上画出了高亮标记
  📷 11-annotation.png
  ✓ 划过已高亮的文字仍能选中
  ✓ 单击已有高亮能打开批注卡片
  ✓ 按 Esc 关闭批注卡片
  ✓ 按 Esc 没有把阅读器一起关掉（页数 7）

[E] 键盘导航与搜索
  ✓ j 键移动了选中项：Transformer Ar → Transformer Ar
  ✓ 搜索框可以输入（当前值「Medical Imaging」）
  ✓ 搜索 "Medical Imaging" 命中 21 行
  ✓ 按文件名也能搜到（emoji）

[F] 深色模式
  ✓ 主题已切换为深色
  📷 12-dark-mode.png

[G] 强杀进程后重启：无重复、无丢失
  ✓ 重启后条目数不变（300 → 300）
  ✓ 无重复条目（unique=300）
  ✓ 批注没有丢（1 → 1）
  ✓ 深色设置也持久化了

[H] 收尾：移除规模测试库，条目数还原到基线
  ✓ 已移除规模测试库：scale-library
  ✓ 条目数还原到基线（0 / 0）
  ✓ 文献库数量还原到基线（0 / 0）
  ✓ 渲染层零错误（0）

✅ 补充验收全部通过
截图：tmp\shots-acceptance
```

### 1.7 中文划词与缩放（第 7 条）

```
命令: node tools/acceptance-cjk.mjs > tmp\v-cjk.txt 2>&1       （首跑）
exit=1 elapsed=57.1s   PASS=0 FAIL=4
```

`tmp/v-cjk.txt` **全文**（8 行）：

```

[A] 打开中文 PDF，检查文本层几何
  ✗ 中文 PDF 已打开且文本层就绪
  ✗ 中文字宽/字号：null
  ✗ 每字宽度 ≈ 字号（比值 ?；修好前是 0.38）
  ✗ 取到一行中文正文：（没有）

❌ 失败 4 项
```

```
命令: node tools/acceptance-cjk.mjs > tmp\v-cjk-2.txt 2>&1     （复跑）
exit=0 elapsed=32.3s   PASS=17 FAIL=0
```

`tmp/v-cjk-2.txt` **全文**（29 行）：

```

[A] 打开中文 PDF，检查文本层几何
  ✓ 中文 PDF 已打开且文本层就绪
  ✓ 中文字宽/字号：{"len":11,"width":402.25537109375,"fontSize":36.5714,"perChar":36.56867009943182}
  ✓ 每字宽度 ≈ 字号（比值 1.00；修好前是 0.38）
  ✓ 取到一行中文正文：本文提出了一种面向中文学术文献的本地阅读

[B] 划词精度（拖 6 个汉字，看落库的批注内容）
  ✓ 划词工具条出现（4 个动作）
  ✓ 高亮已落库：「本文提出了一」
  ✓ 拖 6 个汉字 → 实际选中 6 个（修好前会"选一大堆"）
  ✓ 带 1 个矩形并画到页面上

[C] 拖到空白处不能"全选"
  ✓ 取到页面几何
  ✓ 拖进空白处：没有产生可标注选区（安全）
  ✓ 拖进空白处：原生选区只在 1 页内（>1 页就是"全选"）
  ✓ 从页间灰缝起拖：不弹工具条（0 个）
  ✓ 从页间灰缝起拖：原生选中 0 字

[D] 缩放快捷键
  ✓ Ctrl+滚轮上滚放大：183% → 250%
  ✓ Ctrl+滚轮下滚缩小：250% → 200%
  ✓ Ctrl+= 放大：200% → 250%
  ✓ Ctrl+0 恢复适应宽度：250% → 183%

  截图：tmp/shots-cjk/cjk-acceptance.png

✅ 中文划词与缩放验收全部通过
```

---

## 2. 失败项：原文 + 复现步骤 + 稳定性

### 2.1 F1 — `e2e-desktop.mjs` 首跑 2 项失败（文本层 0 span）

**失败断言原文**（`tmp/v-e2e.txt` 第 30–32 行）：

```
  ✗ 文本层有 0 个 span（可选中、可批注）
  ✗ 能用选区拿到文本与矩形：
  诊断： {"textishClasses":["rd-pdf-text","rd-pdf-text","rd-pdf-text"],"pageChildren":["CANVAS.rd-pdf-canvas","DIV.rd-pdf-text","DIV.rd-page-skeleton","DIV.rd-ann-layer"],"spansTotal":10,"canvasCount":3}
```

**对应断言源码**（只读查看，未修改）：

- `tools/e2e-desktop.mjs:223`：`document.querySelectorAll(".rd-pdf-text span, .textLayer span").length` → 得 0，`ok(textLayer > 0, ...)` 于 :224 失败；
- `tools/e2e-desktop.mjs:225-238`：取 `.rd-pdf-text span` 建 Range；因为上一个查询为 0，`document.querySelector('.rd-pdf-text span')` 返回 `null`，函数提前 `return ''`，于是 :238 的 `selectable.endsWith('rects=0')` 判定失败（日志里冒号后为空）。

**复现步骤**：

```powershell
Set-Location .
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
node scripts/build.mjs                       # 产物已由本次验收重建，dist 未再变动
node tools/e2e-desktop.mjs > tmp\v-e2e-repro.txt 2>&1
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
(Get-Content tmp\v-e2e-repro.txt | Select-String '✗').Count
```

**是否稳定复现**：**否，间歇**。同一份未改动的构建（`dist/**` mtime 均为 20:25:07，两次运行之间无任何构建/源码变动）连跑两次：

| 运行 | 日志文件与落盘时刻 | 耗时 | canvas 数 | 文本层 span | 结果 |
|------|--------------------|------|-----------|-------------|------|
| 首跑 | `tmp/v-e2e.txt`，20:26:17 写完 | 54.9s | 3 | **0** | exit 1，24 ✓ / 2 ✗ |
| 复跑 | `tmp/v-e2e-2.txt`，20:27:16 写完 | 48.6s | 4 | **24** | exit 0，26 ✓ / 0 ✗ |

### 2.2 F2 — `acceptance-cjk.mjs` 首跑 4 项失败（文本层始终不出现，30s 超时）

**失败断言原文**：见 §1.7 首跑全文（4 行 ✗ + `❌ 失败 4 项`）。

**失败机制（读源码得出，未修改）**：

- `tools/acceptance-cjk.mjs:144-148` 的 `openFixture()` 以 500ms 为间隔轮询 **60 次（共 30 秒）**，判据是 `document.querySelectorAll(".rd-pdf-text span").length > 5`，超时仍不满足就 `return false`；
- `:153` `ok(opened, '中文 PDF 已打开且文本层就绪')` 记为失败；
- `:156-166` 依赖 span 的几何检查因此全部拿到 `null`（`✗ 中文字宽/字号：null`、`✗ 每字宽度 ≈ 字号（比值 ?）`）；
- `:201-214` 取中文正文行同样为 `null`（`✗ 取到一行中文正文：（没有）`）；
- `:238` 起 `if (line) { … }` 把 B/C/D 三节全部跳过，所以 17 项里**只跑了 4 项**就收尾。

**排除「夹具坏了」**：首跑结束后立刻只读检查落盘数据：

```
tmp/cjk-fixture/中文文献阅读与标注测试.pdf   6372 bytes  （20:29:00 生成）
tmp/cjk-acceptance-data/library.json:
  items=1
  {"name":"中文文献阅读与标注测试.pdf","parseState":"ready","pageCount":1,
   "path":"D:\\dsh\\litshelf\\tmp\\cjk-fixture\\中文文献阅读与标注测试.pdf"}
```

即 PDF 造出来了、也入库并解析完成（`ready`），不是夹具或解析失败。

**复现步骤**：与 §2.1 同构，把最后一条换成 `node tools/acceptance-cjk.mjs`（该脚本自带隔离目录 `tmp/cjk-acceptance-data`，会自动重建）。

**是否稳定复现**：**否，间歇**。

| 运行 | 日志文件与落盘时刻 | 耗时 | 文本层 span | 结果 |
|------|--------------------|------|-------------|------|
| 首跑 | `tmp/v-cjk.txt`，20:29:38 写完 | 57.1s | 30s 内始终 0 | exit 1，0 ✓ / 4 ✗（只跑到 A 节） |
| 复跑 | `tmp/v-cjk-2.txt`，20:30:26 写完 | 32.3s | 正常（几何 len=11 / perChar≈fontSize） | exit 0，17 ✓ / 0 ✗ |

### 2.3 独立探针：失败到底是「脚本没打开阅读器」还是「应用侧文本层不出现」

为了不让结论停留在猜测，我**没有改任何产品脚本**，而是在自己的写作用域 `tmp/**` 里写了两个只读 DOM 探针（同样是串行跑、跑前后清 electron 与 `ELECTRON_RUN_AS_NODE`）：

**探针 1**：`tmp/verify-probe.mjs` → `tmp/v-probe1.txt`（复现了坏状态）

```
[0.8s] cdp connected
[4.8s] fixture item ready after 69ms
[5.7s] before dblclick {"spans":0,"divs":0,"canvas":0,"rows":1,"reader":false}
  t=5.8s {"spans":0,"divs":0,"canvas":0,"rows":0,"reader":false}
  t=6.3s {"spans":0,"divs":1,"canvas":1,"rows":0,"reader":true}     ← 阅读器已挂载、canvas 已画
  t=6.8s {"spans":0,"divs":1,"canvas":1,"rows":0,"reader":true}
  ...（每 500ms 一行，共 60 次轮询从 5.8s 到 35.7s，全部 spans=0）...
  t=35.7s {"spans":0,"divs":1,"canvas":1,"rows":0,"reader":true}
FIRST_READER_MARKER=6.3s FIRST_SPAN=null
RENDERER_EXCEPTIONS=0
```

**探针 2**：`tmp/verify-probe2.mjs` → `tmp/v-probe2.txt`、`tmp/v-probe3.txt`（两次都落到好状态）

```
PHASE idle-8s: spans appear at 6.4s {"spans":20,"divs":1,"canvas":2,"reader":true,"zoom":"183%","textLen":347,"skeleton":0,"pageEls":4}
TEXT_LAYER_EVER_APPEARED=true
RENDERER_EXCEPTIONS=0
```

结论（可复核）：

1. **不是「阅读器没打开」的脚本竞态**：坏状态下 `reader=true`、`canvas=1`、`.rd-pdf-text` 容器存在，且这个状态**稳定持续 ≥30 秒**，渲染层零异常；
2. 坏状态与好状态的可观测差异：**坏状态 canvas 数 == 页数（1 页→1 个；e2e 首跑 3 页→3 个），span=0；好状态 canvas 数 == 页数+1（1 页→2 个；e2e 复跑 3 页→4 个），span>0**。这是一条**观察到的相关性**，我没有查代码依据，供 reviewer 定位时参考，不作为结论；
3. 因此这是**应用（渲染层）侧的间歇缺陷**：`pdf.js` 文本层在部分会话里根本没有挂上 span，直接后果是「阅读器里无法划词/批注」，同时让依赖文本层的验收项失败。

**抖动率（本次验收全部桌面会话）**：8 次 Electron 会话（e2e ×2、acceptance ×1、cjk ×2、探针 ×3）中 **3 次落入坏状态**（e2e 首跑、cjk 首跑、探针 1），5 次正常。样本很小，但足以说明「单次全绿不能作为放行依据」。

### 2.4 补充对照（非本次验收所跑，仅供参考）

`tmp/` 下已有其他成员此前跑的日志，读数如下（**不是我跑的结果**，仅用于说明间歇现象并非本次独有）：

```
cjk1.txt   pass=16 fail=1  ❌ 失败 1 项
cjk2.txt   pass=16 fail=1  ❌ 失败 1 项
cjkx1.txt  pass=17 fail=0  ✅ 中文划词与缩放验收全部通过
cjkx2.txt  pass=17 fail=0  ✅ 中文划词与缩放验收全部通过
accA.txt   pass=37 fail=0  ✅ 补充验收全部通过
```

---

## 3. 收尾检查

### 3.1 进程

```
20:32:40  Get-Process electron  →  0 (none)
```

每次桌面脚本运行前后都各清一次，最后一次清理后的检查结果为 **0 个 electron 进程**，无残留占用单实例锁。

### 3.2 `tmp` 下我产生的文件（保留 / 删除）

**保留（全部作为可复核证据，我没有删除任何文件）**：

| 文件 | 内容 |
|------|------|
| `tmp/v-tsc.txt` | 第 1 条输出（0 字节，即零错误） |
| `tmp/v-build.txt` | 第 2 条输出（79 行） |
| `tmp/v-vitest.txt` | 第 3 条输出（19 行） |
| `tmp/v-buildtools.txt`、`tmp/v-buildtools-2.txt` | 第 4 条构建步骤输出 |
| `tmp/v-verifycore.txt` | 第 4 条 51 ✓ / 0 ✗ 全文（75 行） |
| `tmp/v-e2e.txt`、`tmp/v-e2e-2.txt` | 第 5 条首跑（失败）/ 复跑（通过） |
| `tmp/v-acceptance.txt` | 第 6 条 37 ✓ / 0 ✗ 全文（62 行） |
| `tmp/v-cjk.txt`、`tmp/v-cjk-2.txt` | 第 7 条首跑（失败）/ 复跑（通过） |
| `tmp/v-probe1.txt`、`tmp/v-probe2.txt`、`tmp/v-probe3.txt` | 间歇问题探针原始时间线 |
| `tmp/verify-probe.mjs`、`tmp/verify-probe2.mjs` | 我写的只读探针脚本（可重跑复现） |

**脚本自动产生、我一并留在原地的目录**（都在 `tmp/` 内，脚本自身会重置，不涉及用户真实库）：`tmp/e2e-data`、`tmp/acceptance-data`、`tmp/cjk-acceptance-data`、`tmp/cjk-fixture`、`tmp/verify-1791548715518`（第 4 条的工作目录，脚本明确提示保留）、`tmp/probe-verify-data`、`tmp/probe-verify2-data`、`tmp/shots`、`tmp/shots-acceptance`、`tmp/shots-cjk`。

**未被我触碰**：`tmp/` 下其他成员此前产生的 `acc*.txt`、`cjk1/2.txt`、`cjkx1/2.txt`、`probe-*.mjs`、`probe*.png`、`probe*-data`、`shots*`（旧内容）等，我只读不写。

### 3.3 源码改动审计与声明

**我没有修改任何 `src/**`、`tools/**`、`tests/**` 文件，也没有修改 `README.md`、`package.json`。**

可复核的审计（以本次验收开始时间 20:24:00 为界，列出 `src/`、`tools/`、`tests/` 及根配置文件里 mtime 晚于该时刻的文件）：

```
20:25:15  tools\verify-core.mjs      ← 见下方说明
20:28:26  README.md                  ← 非我所写（队友 docsmith 在刷新 README）
（src/**、tests/**、package.json、tsconfig.json、vite.config.ts、vitest.config.ts：无任何文件被改动）
```

如实披露一处：`tools/verify-core.mjs` 的 mtime 变化是**第 4 条命令 `node tools/build-tools.mjs tools/verify-core.ts` 重新生成构建产物**所致（这正是任务卡指定的命令），不是手工编辑。其源码 `tools/verify-core.ts`（mtime 17:39:13）未改动，且该生成是**字节确定**的：

```
hash_before = 42C78B53F16F66B7FA7634E4F39515686F410F1A55DA84C1AC2CE217D1C4E808
重建 exit=0 → hash_after = 42C78B53F16F66B7FA7634E4F39515686F410F1A55DA84C1AC2CE217D1C4E808
deterministic = True
```

即重新生成得到的是**同一份字节**，`tools/**` 无实质内容变化。

---

## 4. 与任务卡期望值的偏差（供 Lead 修正口径）

### 4.1 `verify-core` 期望 43 → 实测 51

- 卡片写「期望 43 项」，实测 **51 ✓ / 0 ✗**；
- 源码 `tools/verify-core.ts` 中 `^\s*ok\(` 命中 **51** 处，与输出 ✓ 行数 51 严格一致；
- 脚本没有「总数」汇总行（只在结尾打印 `✅ 全部通过` / `❌ 失败 N 项`，见 `tools/verify-core.ts:183`），所以 43 无法由本次任何输出佐证；
- 判定：**该套件本身通过（51/51）**，卡片的 43 是过期期望，建议改为 51，或由 Lead 核对是否漏跑了某个版本。

### 4.2 e2e 26 / cjk 17 是「满编项数」，失败时实际执行数更少

- `e2e-desktop.mjs`：26 = 满编断言数；首跑只通过 24（2 项失败），复跑 26/26；
- `acceptance-cjk.mjs`：17 = 满编断言数；首跑因 A 节失败触发 `if (line)` 分支跳过 B/C/D，**只执行了 4 项且全失败**，所以「0 ✓ / 4 ✗」不能与「17」直接相减；
- 建议 Lead 在验收口径里写明「项数指满编执行数；出现前置失败时以 log 的实际行数为准」。

### 4.3 稳定性口径

- 第 5、7 两条命令在同一构建上**首跑失败、复跑通过**；
- 其余 5 条命令（含 `acceptance.mjs` 37/37）本次均一次通过；
- 因此「26 项全过 / 17 项全过」只有在**至少跑两次都绿**时才成立，单次结果不足以放行。

---

## 5. 我没做的事

- 没有为了「变绿」修改任何测试、脚本或源码；两处失败都**只报告、不修复**（修复属于 Lead/reviewer 的职责）；
- 没有执行任何 `install`、没有改 `package.json` / 锁文件；
- 没有并发跑桌面脚本（严格串行，跑前跑后清 electron 与 `ELECTRON_RUN_AS_NODE`）；
- 没有用 `Get-Content` / `Set-Content` 读写任何源码或脚本文件（只对 `tmp/*.txt` 做只读 `Get-Content` / `Select-String` 统计）。

---

# 第二轮：UX 优化验收（task-5）

## R2-0. 被验构建与时序（重要）

- **本轮的批次数值对应的构建**：`dist/**` 由我在 **2026-10-09 21:08:50–51** 重新生成（`node scripts/build.mjs`），对应源码状态是 **`src/**` 最后修改 21:02:08（`src/renderer/reader/ReaderView.tsx`）**。
- **时序警告（Lead 21:1x 通知）**：在我 21:08 这次构建之后，Lead **又改了源码**（3 个 P1：对话框 Esc 让出顺序、`ev.repeat` 护栏、右键菜单兜底提示；外加 `.rd-menu` 的 Esc 名单），**尚未重建 dist**。
  → 因此 **R2-1/R2-2/R2-3 里的所有数字只对「21:08 那份构建」成立，已被后续源码取代**，不能当作最终放行依据。
  → Lead 重建 dist 后，我会按同一顺序复跑整批 + 加严版 `acceptance-ux.mjs`，把最终数字追加到 **R2-6**。
- 本轮新脚本 `tools/acceptance-ux.mjs` 的**前两次跑**（58 ✓ / 70 ✓）跑在 **21:02 构建**上（与 21:08 构建源码相同，因为期间 `src/**` 未变）。

## R2-1. 命令清单与实测（21:08 构建，严格串行）

| # | 套件 | 命令 | 期望 | 实测 | 日志 | 结论 |
|---|------|------|------|------|------|------|
| 1 | 类型检查 | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | exit 0 | exit 0，**0 字节输出**，2.9s | `tmp/ux-tsc.txt` | ✅ |
| 2 | 构建 | `node scripts/build.mjs` | exit 0 | exit 0，0.9s（vite 494ms） | `tmp/ux-build.txt` | ✅ |
| 3 | 单元测试 | `node node_modules/vitest/vitest.mjs run` | 10 文件 / 209 用例 | **10 passed (10) / 209 passed (209)**，690ms，exit 0 | `tmp/ux-vitest.txt` | ✅ |
| 4 | 核心逻辑 | `node tools/verify-core.mjs` | 51 ✓ | **51 ✓ / 0 ✗**，exit 0，15.1s | `tmp/ux-verifycore.txt` | ✅（**与 Lead 修正后的 51 一致**） |
| 5 | 桌面端到端 | `node tools/e2e-desktop.mjs` | 26 ✓ | **26 ✓ / 0 ✗**，exit 0，49.0s | `tmp/ux-e2e.txt` | ✅（**一次通过，第一轮的首跑抖动未复现**） |
| 6 | 补充验收 | `node tools/acceptance.mjs` | 37 ✓ | **37 ✓ / 0 ✗**，exit 0，61.3s | `tmp/ux-acceptance.txt` | ✅ |
| 7 | 中文划词/缩放 | `node tools/acceptance-cjk.mjs` | 17 ✓ | **17 ✓ / 0 ✗**，exit 0，32.4s | `tmp/ux-cjk.txt` | ✅（第一轮的文本层抖动未复现） |
| 8 | UX 回归（本轮新增） | `node tools/acceptance-ux.mjs` | 断言数按实际 | **58 ✓ / 0 ✗**（旧版脚本，50.9s）→ 加严后 **70 ✓ / 0 ✗**（58.8s） | `tmp/ux-run1.txt`、`tmp/ux-run2.txt` | ✅（**加严版数字待 R2-6**） |

七条既有套件 + 新脚本在 21:08 构建上**全绿**；`tools/verify-core.mjs` 是按 Lead 修正后的口径 **51** 计的（`tools/verify-core.ts` 自 17:39:13 起未再改动，故直接跑现成 `.mjs` 有效）。

## R2-2. 原始关键输出

```
# 1. tsc：0 字节、exit 0
tsc: exit=0 elapsed=2.9s bytes=0

# 2. build（节选）
[build] 打包 src\main\index.ts → dist\main\index.mjs
✓ built in 494ms
[build] dist/main/index.mjs  176.3 KB
[build] dist/preload/index.cjs  2.0 KB
[build] dist/server/index.mjs  167.8 KB
[build] 构建完成

# 3. vitest（全文尾部）
 Test Files  10 passed (10)
      Tests  209 passed (209)
   Duration  690ms (transform 41%, tests 39%, import 18%, worker 2%)

# 4. verify-core
PASS=51 FAIL=0
✅ 全部通过
工作目录保留在：tmp\verify-1791551335652

# 5. e2e-desktop（阅读器一节）
  ✓ 阅读器渲染出 4 个 canvas
  ✓ 页码显示：1 / 3 页
  ✓ 文本层有 24 个 span（可选中、可批注）
  ✓ 能用选区拿到文本与矩形：Reading Chinese Papers on a Local Shelf|
...
✅ 桌面端到端验收全部通过

# 6. acceptance（尾部）
✅ 补充验收全部通过

# 7. acceptance-cjk（尾部）
✅ 中文划词与缩放验收全部通过
```

各套件在本轮**没有失败项**，故无失败原文可贴；R2-3 给出新脚本的逐条输出。

## R2-3. 新脚本 `tools/acceptance-ux.mjs`（本轮新增的独立回归保护）

**独立性与隔离**：自带调试端口 **9444**（不与 e2e/acceptance 的 9222、acceptance-cjk 的 9111 冲突）；数据目录 `tmp/ux-acceptance-data`（每次运行前重建）；夹具是脚本**自己手写的 3 页 PDF** `tmp/ux-fixture/ux-acceptance-sample.pdf`（写法与 `src/core/sample.ts` 同源：Helvetica/WinAnsi + xref/trailer），因此**不依赖** `tools/` 下其它脚本的夹具，也**不写用户「文档」目录**（示例文献生成器会写 `~/Documents/文献架示例文献`，本脚本刻意不用它）。

**覆盖矩阵（对应 task-5 的 5 条要求）**：

| 任务要求 | 脚本里的节 | 断言要点 |
|----------|-----------|----------|
| ① `?` 面板：库里/阅读器都能开、Esc 只关面板、内容含新增条目 | `[B]`、`[G]` | 库中 `?` 开面板（标题「快捷键」）；逐行抽出 `.shortcut-row` 校验 `1 / 2 / 3 / 4`、`右键`、`[`、`]`、`b`、`t`、`f` 都在；阅读器里 `?` 打开；Esc 关面板且 `.rd-pdf-page` 仍在 |
| ② 快速标注 1~4 | `[D]` | 四轮"拖选→工具条出现→按键"，分别断言落库类型 `highlight` / `underline` / `squiggly` / `strikeout`（真实字面量）、文字非空、工具条自动收起；另有**负向对照**：无选区按 `1` 不落库 |
| ③ `b` 书签 / `t` 主题 / `[`/`]` 翻页 / `f` 全屏 | `[E]`、`[E2]` | `b` 落 `bookmark` 且带「第 N 页」；`t` 读 `getSnapshot().settings.readerTheme` 断言 `light→sepia→dark→light`（**不读 DOM 属性**）；`]`/`[` 用页码读数 `1/3 页` 断言 `1→2→1`；`f` 用 `document.fullscreenElement` 断言进/出；`E2` 用 `autoRepeat` keyDown 断言重复键不再连落书签 |
| ④ 右键菜单 | `[F]`、`[F2]` | 有选区 7 项（逐项列名）、无选区 4 项、`role=menu/menuitem`、title 带快捷键、贴边不越界（rect 全部落在 1440×900 内）、Esc/点别处/滚动三种关闭、右键不破坏选区、点「高亮」落库 |
| ⑤ 对话框 Esc 层级 | `[G]`、`[G2]`、`[G3]` | `[G]` 快捷键面板；**`[G2]` 真对话框**：顶栏「扫描中」打开「扫描进度」弹框（由 Modal 自己的监听器关闭）→ Esc → 弹框关、**扫描前后都在进行**（排除假绿）、阅读器仍在；`[G3]` 阅读器「更多」菜单（`.rd-menu`）Esc 关闭且阅读器仍在 |

**断言数**：当前脚本静态 `ok(` 调用点 **70** 处；`[D]` 的四轮循环会把其中 4 处展开成 16 条，所以**运行时条数高于静态数**。已实测的两次运行（均为**加严前**的版本）：`tmp/ux-run1.txt` **58 ✓ / 0 ✗**（50.9s）、`tmp/ux-run2.txt` **70 ✓ / 0 ✗**（58.8s，新增四轮循环与负向对照）。加严版多出 `[E2]`/`[F2]`/`[G2]`/`[G3]` 共十余条，**运行时条数见 R2-6**，口径一律以日志里 `✓` 行数为准。

**加严前后的实测输出**（跑在 21:02 构建、`src/**` 未变）：

```
[A] 夹具与入库
  ✓ 夹具已入库：ux-acceptance-sample.pdf
  ✓ 解析完成（parseState=ready）
  ✓ 夹具是 3 页 PDF（pageCount=3）
[B] 文献库里的 ? 快捷键面板
  ✓ 按 ? 打开面板（标题：快捷键）
  ✓ 面板含本轮新增的快速标注 / 右键条目
  ✓ 面板含 [ ] / b / t / f 键位 — Ctrl+K · j / k 或 ↑ / ↓ · … · ← / PageUp / [ · → / PageDown / Space / ] · … · b · … · t · f · 1 / 2 / 3 / 4 · 右键 · Esc
  ✓ Esc 关闭面板（文献库）
[C] 双击进阅读器
  ✓ 阅读器打开且文本层就绪（第 1 次尝试）
  ✓ 阅读器已挂载（.rd-pdf-page=3，文本 span=15）
  ✓ 页码读数：1 / 3 页
[D] 快速标注：按 1/2/3/4 分别落 highlight / underline / squiggly / strikeout
  ✓ 取到 5 行可拖选正文（首行「UX Acceptance Sample - P」宽 390px）
  ✓ 第 1 轮拖选后工具条出现（4 个动作，y=178）
  ✓ 按 1（高亮）后批注数 0 → 1
  ✓ 按 1 落库类型 = highlight（期望 highlight）
  ✓ 按 1 的批注文字非空（6 字：「UX Acc」）
  ✓ 按 1 之后划词工具条已自动收起
  ✓ 第 2 轮拖选后工具条出现（4 个动作，y=225）
  ✓ 按 2（下划线）后批注数 1 → 2
  ✓ 按 2 落库类型 = underline（期望 underline）
  ✓ 第 3 轮拖选后工具条出现（4 个动作，y=264）
  ✓ 按 3 落库类型 = squiggly（期望 squiggly）
  ✓ 第 4 轮拖选后工具条出现（4 个动作，y=304）
  ✓ 按 4 落库类型 = strikeout（期望 strikeout）
  ✓ 无选区按 1 的前置条件：左键点空白已清掉选区
  ✓ 无选区时按 1 不落库（批注数保持 4）
[E] b 书签 / t 主题 / [ ] 翻页 / f 全屏
  ✓ 按 b 落库书签（类型 bookmark）
  ✓ 书签带页位文字（「第 1 页」page=1）
  ✓ t 循环阅读主题：light → sepia → dark → light
  ✓ 连按 3 次 t 回到起始主题（light = light）
  ✓ ] 翻到下一页：1 → 2（共 3 页）
  ✓ [ 翻回上一页：2 → 1（期望回到 1）
  ✓ f 进入全屏（document.fullscreenElement=true）
  ✓ f 退出全屏（document.fullscreenElement=false）
[F] 右键菜单
  ✓ 拖选出 6 个字符：「UX Acc」
  ✓ 有选区右键弹出菜单（点 (193, 207) → rd-pdf-text）
  ✓ 菜单容器 role=menu
  ✓ 有选区时 7 项齐全（7 项） — 高亮 | 下划线 | 波浪线 | 删除线 | 复制 | 复制引用（选区 + 题录） | 在文内搜索
  ✓ 每个菜单项 role=menuitem
  ✓ 菜单项 title 带快捷键说明（高亮（选中后按 1））
  ✓ 右键没有破坏选区（6 → 6 字）
  ✓ 右键没有收掉划词工具条
  ✓ 点菜单项后菜单关闭
  ✓ 点「高亮」落库一条 highlight（3 → 4）
  ✓ 取到页面空白点：(1093, 398) → rd-pdf-text（在文字层内=true）
  ✓ 左键点空白清掉原生选区
  ✓ 左键点空白也收掉划词工具条
  ✓ 空白处右键弹出菜单
  ✓ 无选区时 4 项齐全且没有标注项（4 项） — 适应宽度 | 适应页面 | 加书签 | 复制引用（整篇文献）
  ✓ 取到页面右下角贴边点：(1105, 884)
  ✓ 贴边右键弹出菜单
  菜单 rect={"left":1105,"top":762,"right":1305,"bottom":895} 视口={"w":1440,"h":900}
  ✓ 菜单完全落在窗口内（不越界）
  ✓ Esc 关闭右键菜单
  ✓ Esc 关菜单没有把阅读器一起关掉（reader=true, pages=3）
  ✓ 点击菜单外关闭
  ✓ 滚动后菜单关闭
[G] 对话框 Esc 层级（阅读器里的 .modal-backdrop）
  ✓ 阅读器里按 ? 打开快捷键面板（.modal-backdrop，标题「快捷键」）
  ✓ Esc 关闭对话框
  ✓ Esc 关对话框后阅读器仍在（reader=true, pages=3）
[H] 渲染层健康检查
  ✓ 渲染层零错误（0）
✅ UX 回归验收全部通过
```

**Lead 指出的两处「假绿」已加严**（加严代码已写好、语法自检通过，实测数字待 R2-6）：

1. `[G]` 原来只用 `?` 面板——它由 App 自己的 `showShortcuts` 分支关闭，**不经过 Modal 的监听器**，绿了也证明不了 Esc 让出链路。现已新增 **`[G2]`**：阅读器里 `addRoot` 一个批量目录（300/400 个 PDF）→ 顶栏 `.topbar-progress` 出现 → 点它打开「扫描进度」`.modal-backdrop` → 立刻 Esc，四条断言：
   - `pre.modal && pre.active`（按 Esc 前对话框开着**且扫描仍在进行**）
   - `post.modal === false`（Esc 关掉了对话框）
   - `post.active === true`（**按 Esc 之后扫描仍在进行** → 排除"扫描结束导致弹框自动消失"的假绿）
   - `post.reader === true`（阅读器没被一起关掉）
   并且最多重试 2 次，每次用一个新的批量目录（保证是冷扫描、进度条出现足够久）；每次的 `pre/post` 都打进日志。
2. `[F]` 原来测空白右键**之前先左键点了空白**，那一下恰好把 `lastSelectionRef` 清干净，掩盖了"菜单按 DOM 选区判断、执行却依赖 `pending`"的不同步。现已新增 **`[F2]`**：拖选 → 按 `1` 落批注 → **不点页面** → 直接在空白处右键 → 点「高亮」→ 断言**要么落库、要么出现「请重新选中文字再标注/选区已经失效」提示**（`landed || warned`），不允许静默无反应；找不到「高亮」项则直接记失败并注明"不同步未复现，需 reviewer 复核"，避免假绿。
3. 另补 **`[E2]`**：在页面里挂监听记录 `e.repeat`，先用普通 keyDown 再用两次 `autoRepeat: true` 的 keyDown，断言"页面确实收到 repeat=true"**且**"书签只 +1"（第一轮没有这条护栏，按住 `b` 会连落多条）。
4. 另补 **`[G3]`**：阅读器「更多」菜单（`.rd-menu`）按 Esc → 菜单关、阅读器仍在（对应 Lead 修的第 4 条）。

## R2-4. 与第一轮的差异

| 观察点 | 第一轮（19:42 构建） | 第二轮（21:08 构建） |
|--------|----------------------|----------------------|
| e2e-desktop | 首跑 24/26（文本层 0 span），复跑 26/26 | **一次 26/26**，阅读器 4 canvas / 24 span |
| acceptance-cjk | 首跑 0 ✓/4 ✗（文本层 30s 没就绪），复跑 17/17 | **一次 17/17** |
| acceptance | 37/37 | 37/37 |
| verify-core | 51/51（卡片旧期望 43） | 51/51（口径已修正） |
| 新增 | — | `tools/acceptance-ux.mjs`（本轮 UX 交互回归） |

第一轮定位的"文本层间歇不挂 span"在本轮 4 次桌面会话（e2e、cjk、ux×2）里**一次都没复现**；样本小，仍建议保留"易抖套件连跑两次"的口径。

## R2-5. 我没做的事（第二轮）

- 没有修改 `src/**`、`tools/e2e-desktop.mjs`、`tools/acceptance.mjs`、`tools/acceptance-cjk.mjs`、`README.md`；
- 本轮我在 `tools/` 下**只新建了 `tools/acceptance-ux.mjs`**（task-5 的写作用域），没有改动任何既有 `tools/*.mjs`；
- 没有为了让断言变绿而放宽判据；`[F2]` 的"落库或提示"是 Lead 指定的正确契约（不许静默），不是放宽；
- 桌面脚本依旧**严格串行**，每步前后清 `ELECTRON_RUN_AS_NODE` 与 electron 进程。

## R2-6. 最终复跑（Lead 重建后，正式口径以此节为准）

### R2-6.0 被验构建与一次必要的披露

- **被验构建**：`dist/**` = Lead **21:16:27** 重建，对应 `src/**` 最后修改 **21:16:19**（`src/renderer/reader/ReaderView.tsx`）。
- 批次第 2 条命令按任务卡就是 `node scripts/build.mjs`，**我执行了它**（不执行就无法验证"构建可复现"）。为避免"重建后验的不是同一份产物"，我在跑之前对 `dist/**` 全部 255 个文件做了 SHA256 快照，跑完再比：
  ```
  files_before=255  files_after=255
  byte-identical: True (255 files, SHA256 list identical)
  dist mtime now=2026/10/9 21:17:44
  ```
  → **重建产物与 Lead 21:16:27 那份逐字节相同**（只是 mtime 变成 21:17:44），所以下面的数字对应的就是 21:16:27 的构建内容。除这一条命令外，我**没有改任何源码、没有再重建 dist**。

### R2-6.1 命令清单与实测（21:16:27 构建，严格串行）

| # | 套件 | 命令 | 期望 | 实测 | 耗时 | 日志 | 结论 |
|---|------|------|------|------|------|------|------|
| 1 | 类型检查 | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | exit 0 | exit 0，**0 字节** | 2.9s | `tmp/ux2-tsc.txt` | ✅ |
| 2 | 构建 | `node scripts/build.mjs` | exit 0 | exit 0；产物与 21:16:27 版**逐字节相同** | 0.8s | `tmp/ux2-build.txt` | ✅ |
| 3 | 单元测试 | `node node_modules/vitest/vitest.mjs run` | 10 文件 / 209 用例 | **10 passed (10) / 209 passed (209)** | 753ms | `tmp/ux2-vitest.txt` | ✅ |
| 4 | 核心逻辑 | `node tools/verify-core.mjs` | 51 ✓ | **51 ✓ / 0 ✗** | 14.9s | `tmp/ux2-verifycore.txt` | ✅ |
| 5 | 桌面端到端 | `node tools/e2e-desktop.mjs` | 26 ✓ | **26 ✓ / 0 ✗** | 49.1s | `tmp/ux2-e2e.txt` | ✅ |
| 6 | 补充验收 | `node tools/acceptance.mjs` | 37 ✓ | **37 ✓ / 0 ✗** | 61.3s | `tmp/ux2-acceptance.txt` | ✅ |
| 7 | 中文划词/缩放 | `node tools/acceptance-cjk.mjs` | 17 ✓ | **17 ✓ / 0 ✗** | 31.9s | `tmp/ux2-cjk.txt` | ✅ |
| 8 | UX 回归（加严版） | `node tools/acceptance-ux.mjs` | 断言数按实际 | 首跑 **82 ✓ / 2 ✗**（我的用例技术错误，见 R2-6.3）→ 修好后 **85 ✓ / 0 ✗**，再复跑 **85 ✓ / 0 ✗** | 68.4s / 68.7s / 72.2s | `tmp/ux2-ux.txt`、`tmp/ux2-ux-rerun.txt`、`tmp/ux2-ux-run3.txt` | ✅（含一次自纠） |

**8 条命令最终全部通过**；`tools/acceptance-ux.mjs` 的满编断言数为 **85**。

### R2-6.2 关键原始输出（加严项逐条佐证）

```
[E2] 键重复护栏：autoRepeat 的 b 不能连落多条书签
  ✓ 页面确实收到 repeat=true 的重复按键（收到 [false,true,true]）
  ✓ 首次按下落 1 条、重复键不再落库（5 → 6）

[F2] 选区与 pending 不同步的兜底（不点页面直接右键）
  ✓ 取到用于右键的空白点：(1093, 398)
  ✓ 前置：拖选后按 1 已落库（7 → 8）
  ✓ 不点页面直接右键：菜单弹出（7 项；DOM 选区仍有 0 字）
  ✓ 点「高亮」不是静默无反应（落库=false，提示=true） — 屏幕提示：这段选区已经失效，请重新选中文字再标注

[G] 快捷键面板（?）的 Esc 层级
  ✓ 阅读器里按 ? 打开快捷键面板（.modal-backdrop，标题「快捷键」）
  ✓ Esc 关闭面板
  ✓ Esc 关面板后阅读器仍在（reader=true, pages=3）
  [观察] 阅读器里连按两次 ? → 第1轮 按1次=开→按2次=已关；第2轮 …；第3轮 …（三轮一致）

[G2] 真对话框 Esc 层级（顶栏「扫描中」→ 扫描进度弹框 → Esc）
  第 1 次：clicked=true modal=true pre={"modal":true,"active":true,"reader":true,"title":"扫描进度"} post={"modal":false,"active":false,"reader":true}
  第 2 次：clicked=true modal=true pre={"modal":true,"active":true,"reader":true,"title":"扫描进度"} post={"modal":false,"active":true,"reader":true}
  ✓ 打开真对话框 .modal-backdrop（标题「扫描进度」）
  ✓ 按 Esc 之前扫描仍在进行（排除弹框已经自己关闭）
  ✓ Esc 关闭了对话框（Modal 自己的监听器生效）
  ✓ 按 Esc 之后扫描仍在进行 → 排除"扫描结束导致弹框自动消失"的假绿
  ✓ Esc 关对话框后阅读器仍在

[G3] 阅读器「更多」菜单的 Esc
  ✓ 找到「更多」按钮（(1416, 74) 28px）
  ✓ 阅读器「更多」菜单已打开（.rd-menu）
  ✓ Esc 关闭「更多」菜单
  ✓ Esc 关「更多」菜单没有把阅读器一起关掉

[H] 渲染层健康检查
  ✓ 渲染层零错误（0）
✅ UX 回归验收全部通过
```

**值得注意**：`[G2]` 第 1 次采样出现 `post.active=false`（扫描在按 Esc 前后结束了 → 判据不干净），脚本按设计自动重试第 2 次，拿到 `pre.active=true / post.active=true` 的干净判据才算通过。**如果不查 `active`，第 1 次那种情况会被误判成"Esc 生效"** —— 这条防假绿断言确实在起作用。

### R2-6.3 唯一一次失败：我的用例技术错误（不是产品缺陷），原文 + 根因 + 自纠

首跑 `tmp/ux2-ux.txt` 的失败原文：

```
[G3] 阅读器「更多」菜单的 Esc
  ✗ 阅读器「更多」菜单已打开（.rd-menu）
  ✓ Esc 关闭「更多」菜单
  ✗ Esc 关「更多」菜单没有把阅读器一起关掉
```

**根因（读源码定位）**：我第一版用 `element.click()` 去点「更多」按钮，但该按钮在 `src/renderer/reader/ReaderView.tsx:1163-1166` **只绑了 `onPointerDown`**，没有 `onClick`：

```tsx
onPointerDown={(ev) => { ev.stopPropagation(); setMenuOpen((v) => !v); }}
```

`element.click()` 只发 `click` 事件、不发 `pointerdown` → 菜单根本没打开。第二条 `✗` 是**级联**：菜单没开，此时按 Esc 属于正常"返回列表"，阅读器被关掉是**正确行为**，不是 bug。

**修复**：用例改成先量出按钮中心坐标，再用 CDP 发真实指针事件（`mousePressed` → `pointerdown`）。复跑即全绿（`tmp/ux2-ux-rerun.txt` 85 ✓ / 0 ✗），再连跑一次仍全绿（`tmp/ux2-ux-run3.txt` 85 ✓ / 0 ✗）。

**顺带发现（P3，只报告不改）**：既然该按钮只绑 `onPointerDown`，**鼠标点得开、键盘激活（聚焦后按 Enter/Space，只发 `click`）打不开**。建议 Lead 视情况补一个 `onClick`。我没有为它写断言（属体验/可达性建议，不在本轮任务口径内）。

### R2-6.4 观察项（P2，未断言）：阅读器里 `?` 的实际语义是 toggle

- **实测**（`tmp/ux2-ux-run3.txt` 三轮采样 + 专门探针 `tmp/probe-ux-toggle.mjs` → `tmp/ux2-toggle-probe.txt`）：
  ```
  阅读器已打开：true
  a) 面板关着按 t：light → sepia（阅读器键盘活着=true）
  b) 按 ? → 面板开=true
  c) 面板开着按 t：sepia → dark（阅读器键盘仍活着=true）
  d) 面板开着再按 ? → 面板开=false（被关掉）
  e) 再按一次 ? → 面板开=true
  f) Esc 后：面板开=false，阅读器在=true
  ```
  → 阅读器里 `?` **表现为 toggle**（开→关→开），**不是** Lead 描述的"只能开不能关"。
- **源码佐证不一致**：`src/renderer/App.tsx:172-175` 是 `showShortcuts: !showShortcuts`（toggle），而 `src/renderer/reader/ReaderView.tsx:888-894` 的注释与实现是"幂等地打开，不做 toggle"并 `stopImmediatePropagation()`。两处语义不同，实际生效的是哪一个取决于 `window` 监听器的注册顺序（ReaderView 的键盘 effect 依赖里含 `showShortcuts` / `menuOpen`，会反复重注册）。
- 探针的 (c) 还说明：**面板打开时阅读器键盘并没有失效**（`t` 仍能切主题），所以不是"按键被吞"，而是两处 `?` 语义不一致。
- 结论/建议：从用户角度看 toggle 反而更符合直觉，但**注释与行为已经不一致**，建议明确由谁负责 `?`（统一成 toggle 或统一成"只开"），否则以后任何一次监听器注册顺序变化都可能翻转行为。按 Lead 说明，这一条**只写进报告、不作为失败断言**。

### R2-6.5 稳定性

| 套件 | 本轮次数 | 结果 |
|------|----------|------|
| acceptance-ux（加严版） | 3 | 首跑因**我的用例错误** 82/2；修好后**连续两次 85/0** |
| e2e-desktop | 1 | 26/26（第一轮出现过"首跑 24/26、复跑 26/26"的文本层抖动，本轮未复现） |
| acceptance-cjk | 1 | 17/17（第一轮首跑曾 0/4 中止，本轮未复现） |
| verify-core / vitest / acceptance / tsc / build | 1 | 全绿 |

易抖的两套（e2e、cjk）本轮各只跑一次就全绿，但仍建议保留"这两套至少连跑两次"的放行口径——第一轮的抖动就出现在同一个项目的同一构建上。

### R2-6.6 收尾

```
Get-Process electron  →  0（每个桌面脚本前后各清一次，最后一次复查仍为 0）
```

- 本轮原始日志全部保留：`tmp/ux2-tsc.txt`、`ux2-build.txt`、`ux2-dist-before.txt`、`ux2-dist-after.txt`、`ux2-vitest.txt`、`ux2-verifycore.txt`、`ux2-e2e.txt`、`ux2-acceptance.txt`、`ux2-cjk.txt`、`ux2-ux.txt`（首跑失败原文）、`ux2-ux-rerun.txt`、`ux2-ux-run3.txt`、`ux2-toggle-probe.txt`；
- 探针脚本 `tmp/probe-ux-toggle.mjs` 保留（可重跑复现 R2-6.4）；
- 脚本自建目录：`tmp/ux-acceptance-data`、`tmp/ux-fixture`、`tmp/ux-bulk-1`、`tmp/ux-bulk-2`、`tmp/ux-toggle-probe-data`、`tmp/shots-ux`，一个都没删；未触碰他人文件。
- **本轮我改动的文件只有两个**：新建 `tools/acceptance-ux.mjs`、追加 `docs/verification-report.md`（外加 `tmp/**`）。**没有修改任何 `src/**`，也没有改动 `tools/e2e-desktop.mjs` / `tools/acceptance.mjs` / `tools/acceptance-cjk.mjs` / `README.md`。**

### R2-6.7 时序披露：批次进行中源码被再次改动（不影响本次被验产物）

跑完收尾审计时发现两处 mtime 落在我的批次窗口内（**不是我改的**）：

```
2026/10/9 21:19:25  src/renderer/App.tsx     ← 我的批次第 5 条命令（e2e，21:19 起）前后
2026/10/9 21:18:49  README.md                ← 队友 docsmith 的文档更新
```

**为什么不影响本次结论**：桌面脚本加载的是**已构建产物** `dist/renderer/index.html`（e2e 日志里能看到 `file:///D:/dsh/litshelf/dist/renderer/index.html`），而 `dist/**` 在我的批次里**没有被再次重建**：

```
dist/** vs 被验快照：unchanged: True (255/255 SHA256 still identical)
dist mtime = 2026/10/9 21:17:44
```

即：21:19:25 的 `App.tsx` 改动**不在被验产物里**；第 1–4 条（tsc / build / vitest / verify-core）跑在 21:17:44–21:18:0x，早于该改动。所以 R2-6.1 的 8 条结论仍然一致地对应 **21:16:27 构建**。

**但需要 Lead 决策**：源码树现在比被验产物新（`App.tsx` 21:19:25），任何**下一次** `build.mjs` 都会产出与本次被验产物不同的 dist。如果那处改动是本轮要交付的内容，应按同一批次口径**重建 + 复跑**（至少第 1、3、5–8 条），否则本次验收覆盖不到它。作为补充（**不属于被验构建结论**）：我对**当前源码树**单独跑了一次类型检查，`tsc --noEmit` 仍为 exit 0、0 字节输出（`tmp/ux2-tsc-currenttree.txt`），且 `App.tsx:174` 的 `?` toggle 逻辑与 21:16 版一致（未变）。

---

## R2-7. 最终构建复验（Lead 重建 21:28:07 后）

### R2-7.0 被验构建 + "这次产物真的变了"的证据

- **被验构建**：`dist/**` = **2026-10-09 21:28:07**，对应源码 `src/renderer/reader/ReaderView.tsx` **21:28:03**、`src/renderer/App.tsx` **21:19:25**。
- 与 R2-6 被验的那份（21:16:27 内容）做全量 SHA256 比对，**确实不同**（证明 Lead 的重建生效）：
  ```
  files_diff_lines=6   （3 个文件被替换：删 3 行 + 加 3 行）
  新增：dist/renderer/assets/index-Br67dvI6.js
        dist/renderer/assets/lib-BO3deHGf.js
        dist/renderer/index.html
  旧有：dist/renderer/assets/index-BuowuHRl.js
        dist/renderer/assets/lib-Pu1IIDkF.js
        dist/renderer/index.html
  ```
  变化**全部落在 `dist/renderer/**`**；`dist/main/**`、`dist/preload/**`、`dist/server/**` 及其余 252 个文件与上一份**逐字节相同**。
- 我的复跑期间产物没有再变：`dist/** vs 21:28:07 快照：unchanged: True (255/255 identical)`。
- 按 Lead 指定，**本轮没有跑第 2 条 `build.mjs`**（避免再动产物），也**没有重跑第 4 条 `verify-core`**——依据就是上面那条：`dist/main|preload|server` 与上次被验版本逐字节相同，核心/服务端行为不受本轮渲染层改动影响（`tools/verify-core.ts` 自 17:39:13 起也未改动）。

### R2-7.1 命令与实测（1 / 3 / 5 / 6 / 7 / 8，严格串行）

| # | 套件 | 命令 | 期望 | 实测 | 耗时 | 日志 | 结论 |
|---|------|------|------|------|------|------|------|
| 1 | 类型检查 | `tsc -p tsconfig.json --noEmit` | exit 0 | exit 0，**0 字节** | 2.9s | `tmp/ux3-tsc.txt` | ✅ |
| 3 | 单元测试 | `vitest run` | 10 文件 / 209 用例 | **10 passed (10) / 209 passed (209)** | 683ms | `tmp/ux3-vitest.txt` | ✅ |
| 5 | 桌面端到端 | `tools/e2e-desktop.mjs` | 26 ✓ | **26 ✓ / 0 ✗** | 48.6s | `tmp/ux3-e2e.txt` | ✅ |
| 6 | 补充验收 | `tools/acceptance.mjs` | 37 ✓ | **37 ✓ / 0 ✗** | 61.2s | `tmp/ux3-acceptance.txt` | ✅ |
| 7 | 中文划词/缩放 | `tools/acceptance-cjk.mjs` | 17 ✓ | **17 ✓ / 0 ✗** | 32.3s | `tmp/ux3-cjk.txt` | ✅ |
| 8 | UX 回归（含新键盘断言） | `tools/acceptance-ux.mjs` | 断言数按实际 | **90 ✓ / 0 ✗**，复跑 **90 ✓ / 0 ✗** | 73.7s / 74.1s | `tmp/ux3-ux.txt`、`tmp/ux3-ux-run2.txt` | ✅ |
| 2 | 构建 | `scripts/build.mjs` | — | **本轮按 Lead 指定未跑**（产物已由 Lead 于 21:28:07 重建并比对过） | — | — | — |
| 4 | 核心逻辑 | `tools/verify-core.mjs` | — | **本轮未跑**；`dist/{main,preload,server}` 与上次被验版本逐字节相同，故上次的 51 ✓ 仍然成立 | — | — | — |

### R2-7.2 新增的 P3 键盘可达回归（原文佐证）

本轮在 `tools/acceptance-ux.mjs` 的 `[G3]` 里新增 5 条断言，对应 Lead 修的"「更多」按钮只绑 `onPointerDown`、Tab 聚焦后 Enter/Space 打不开"：

```
[G3] 阅读器「更多」菜单的 Esc
  ✓ 找到「更多」按钮（(1416, 74) 28px）
  ✓ 阅读器「更多」菜单已打开（.rd-menu）
  ✓ Esc 关闭「更多」菜单
  ✓ Esc 关「更多」菜单没有把阅读器一起关掉
  ✓ 「更多」按钮可获得焦点（Tab 可达，activeElement=BUTTON）
  ✓ 聚焦后按 Enter 打开「更多」菜单
  ✓ Esc 关闭「更多」菜单（键盘路径）
  ✓ 聚焦后按 Space 打开「更多」菜单
  ✓ Space 没有顺带翻页（1 → 1）
```

实现细节（避免以后误改成假绿）：键盘用例走的是**不 blur 焦点**的 `pressFocused()`，否则 `document.activeElement.blur()` 会把焦点弄丢、按键落不到按钮上；`Space` 那条同时断言**页码不变**，用来守住 `stopPropagation`（不被阅读器当成"下一页"）。

### R2-7.3 `acceptance-ux.mjs` 断言数：85 → **90**

多出的 5 条＝"按钮可获得焦点"+Enter 开菜单+Esc 关（键盘路径）+Space 开菜单+"Space 不顺带翻页"。Lead 预估 ~88，实测 **90**（多的是上面两条必要的前置/收尾断言）。当前脚本静态 `ok(` 调用点 76 处，`[D]` 四轮循环展开后运行时 90 条，**口径以日志 `✓` 行数为准**。

### R2-7.4 稳定性（21:28:07 构建）

| 套件 | 次数 | 结果 |
|------|------|------|
| acceptance-ux（90 条） | 2 | **连续两次 90/0** |
| e2e-desktop / acceptance / acceptance-cjk | 各 1 | 26/0、37/0、17/0 |
| tsc / vitest | 各 1 | 0 字节 / 209 用例 |

第一轮定位的"文本层间歇不挂 span"在**第三份构建**上仍未复现（累计：21:08、21:16、21:28 三份构建共 6 次桌面会话全绿）。

### R2-7.5 观察项在新构建上的状态

- **P2（`?` 在阅读器里表现为 toggle）在本轮依然存在**：`tmp/ux3-ux.txt` 三轮采样仍是"按1次=开→按2次=已关"，源码两处语义（`App.tsx:174` toggle / `ReaderView.tsx:888-894` 幂等打开）未变。仍按 Lead 说明只记录、不断言。
- **P3 已闭环**：键盘可达断言在 21:28:07 构建上通过（见 R2-7.2）。

### R2-7.6 收尾

```
Get-Process electron → 0（每步前后各清一次，最后一次复查仍为 0）
dist/** → 255/255 与 21:28:07 快照一致（我全程未重建）
```

- 新增日志（保留）：`tmp/ux3-tsc.txt`、`ux3-vitest.txt`、`ux3-e2e.txt`、`ux3-acceptance.txt`、`ux3-cjk.txt`、`ux3-ux.txt`、`ux3-ux-run2.txt`、`ux3-dist-snapshot.txt`、`ux3-dist-final.txt`；
- 本轮我只改了 `tools/acceptance-ux.mjs`（加 5 条键盘断言 + `pressFocused` 辅助）与本节报告；**没有改任何 `src/**`，没有再跑 `build.mjs`**。

---

## R2-8. 第三轮：选区反选 / 缩略图 / 缩放提速 / 侧栏精简

### R2-8.0 被验构建与产物冻结

- **被验构建**：`dist/**` = **2026-10-09 22:22:26**（`dist/main` 22:22:25），对应 `src/**` 最后修改 **22:22:15**（`ReaderView.tsx`）。
- 开跑前做了全量 SHA256 快照（`tmp/ux4-dist-before.txt`，255 个文件），收尾再比对：**255/255 与快照一致**（`tmp/ux4-dist-after.txt`）→ 跑批期间产物没被改动。
- 按 task-9 要求**没有跑 `build.mjs`**；本轮四个用户 bug 的落点按 Lead 说明分布在新版 `PdfViewer.tsx`（`clampSelection`）、缩略图面板、`ReaderView.tsx` 缩放与 `Sidebar.tsx`。

### R2-8.1 六套既有套件：全绿（各跑一次）

| # | 套件 | 命令 | 期望 | 实测 | 耗时 | 日志 |
|---|------|------|------|------|------|------|
| 1 | 类型检查 | `tsc --noEmit` | exit 0 | exit 0，**0 字节** | 2.9s | `tmp/ux4-tsc.txt` |
| 3 | 单元测试 | `vitest run` | 10 / 209 | **10 passed (10) / 209 passed (209)** | 638ms | `tmp/ux4-vitest.txt` |
| 4 | 核心逻辑 | `tools/verify-core.mjs` | 51 ✓ | **51 ✓ / 0 ✗** | 14.9s | `tmp/ux4-verifycore.txt` |
| 5 | 桌面端到端 | `tools/e2e-desktop.mjs` | 26 ✓ | **26 ✓ / 0 ✗** | 48.6s | `tmp/ux4-e2e.txt` |
| 6 | 补充验收 | `tools/acceptance.mjs` | 37 ✓ | **37 ✓ / 0 ✗** | 61.2s | `tmp/ux4-acceptance.txt` |
| 7 | 中文划词/缩放 | `tools/acceptance-cjk.mjs` | 17 ✓ | **17 ✓ / 0 ✗** | 32.4s | `tmp/ux4-cjk.txt` |

### R2-8.2 扩展后的 `acceptance-ux.mjs`：满编 140 条，但**四跑都没能一次全绿**

扩展后脚本满编断言 ~140 条（静态 `ok(` 120 处，`[D]` 四轮 + `[L]` 三布局展开）。同一构建上连跑四次，**每次失败点都不同**：

| 运行 | 结果 | 中止/失败位置 | 日志 |
|------|------|----------------|------|
| run1 | 7 ✓ / 1 ✗（**中止**） | `[C]` 3 页文档文本层 40s×2 没就绪 | `tmp/ux4-ux.txt` |
| run2 | 93 ✓ / 1 ✗（**中止**） | `[I]` 24 页文档文本层 40s 没就绪；随后 `[J]` 快刷时 **CDP `Runtime.evaluate` 20s 超时** | `tmp/ux4-ux2.txt` |
| run3 | 122 ✓ / 9 ✗ | 见下表（跑完全部新节） | `tmp/ux4-ux3.txt` |
| run4 | 69 ✓ / 6 ✗（**中止**） | `[F]` 首次右键没弹出菜单（6 条级联）；`[G2]` 第 2 次采样时 **CDP 20s 超时** | `tmp/ux4-ux4.txt` |

### R2-8.3 run3 里**通过**的新断言（产品行为证据）

```
[J] 缩略图：真预览 + 快刷后自愈
  ✓ 缩略图面板有 24 个页位（期望 24）
  第 1 趟刷完：1829ms，可滚动高度 382px   （3 趟各 ~1.8s 快速来回刷）
  缩略图统计：{"total":24,"imgs":24,"badImgs":0,"ghosts":0,"ready":24,"pendingPages":[]}
  ✓ 快刷并静置 5s 后剩余数字占位 = 0（实际 0）
  ✓ 每页都有真预览且 naturalWidth>20（24/24）
[K] 连续跳页：不被旧链拉回
  ✓ 连按两次 ] → 最终第 3 页（期望 3）
  ✓ 落点贴近容器顶部：offset=0px（|offset|<120）
  ✓ 120ms 内连点第 10、12 页缩略图 → 最终第 12 页（期望 12）   ← 代次控制生效
  ✓ 缩略图落点贴近容器顶部：offset=0px
[L] 目录落点（三种布局全部通过）
  ✓ [continuous] 目录面板有 Chapter 2（共 3 条：Chapter 1=P1, Chapter 2=P7, Chapter 3=P15）
  ✓ [continuous] 点目录 Chapter 2 → 当前页 7（期望 7）
  ✓ [single] 点缩略图第 5 页 → 当前页 5
  ✓ [single] / [double] 目录 Chapter 2 → 当前页 7
  ✓ [double] 点缩略图第 5 页 → 当前页 5
[M] 缩放档位与细步进
  ✓ Ctrl+= 档位序列：100% → 150% → 200% → 300% → 400% → 400%   ← 与 Lead 口径完全一致
  ✓ 按键到标签更新 55ms（要求 < 1500ms）
  ✓ Ctrl+0 回到适应宽度（defaultZoom=fit-width）
  ✓ Ctrl+滚轮一次 100% → 115%（涨幅 15% ≤ 40%）
[N] 缩放落盘
  ✓ 防抖窗口后落盘为最终档位（3，期望 3）
[O] 选区（部分通过）
  ✓ 向下拖到空白后有选区（197 字）
  ✓ 向下拖选区只在锚点页内（start=3 end=3 期望页=3）
  ✓ 长度 197 < 整页文本 251（不是全选）
[H2] ✓ 渲染层零错误（0）
```

### R2-8.4 run3 的 9 条失败原文 + 我的定性（哪些是我的用例问题）

```
[J] （无失败：24/24 真预览、0 占位）
[L] ✗ [continuous] 点缩略图第 5 页 → 当前页 12
[L] ✗ [continuous]/[single]/[double] 文内搜索命中 0 条（）
[N] ✗ 连按 3 次放大后"立刻"读 defaultZoom 还没变（1 == fit-width）
[O] ✗ 选区以锚点行开头、不是反选（期望「Marke…」，实际「UX Thumbs Sample -」）
[O] ✗ 取到文字块上方的空白点
[P] ✗ 默认侧栏只有 4 项：全部文献 / 最近添加 / 在读 / 星标 / ux-fixture / ux-bulk-1 / ux-bulk-2 / 添加文献文件夹 / 设置
[P] ✗ 设置页找到「未读」开关（当前 on=undefined）
```

**已确认是我的用例问题（本轮已修，尚未复跑验证）**：

1. `[L]` continuous 点第 5 页落到第 12 页：缩略图是**异步出图**的，我在设置 `scrollTop` 后立刻量坐标就点，布局可能还在变。已改为「滚动 → 等 400ms → 量坐标 → 用 `elementFromPoint` 确认该点确实属于 `[data-thumb-page="5"]` → 才点 → 不命中重试一次」。
2. `[L]` 文内搜索 0 条：脚本只等一次 1400ms，而文内搜索要先异步建全文索引。已改为**轮询最多 8s**。
3. `[N]` "立刻读还没变"失败：`immediate=1` 说明读到的是**「重置到 100%」那一下自己**的落盘（它也在 350ms 防抖里），不是连按的结果。已改为「重置后先等 700ms 让它落盘 → 取基线（应为 1）→ 再连按 3 次 → 立刻读」。
4. `[P]` 侧栏项数把**文件夹行/「添加文献文件夹」/「设置」**也数进去了（它们同样用 `.sb-item`）。已改为只取 `.sb-scroll` 下第一个 `.sb-section`。
5. `[P]` 找不到「未读」开关：该分组在设置页的**「外观」分区**，脚本没切分区。已改为先点 `.set-nav-item` 里的「外观」。
6. `[O]` 取不到文字块上方空白点：候选点可能落在阅读器顶栏上。已改为用 `.rd-pdf-scroll` 的 top 做下界，并**打印锚点/上下空白的坐标**便于复核。

**需要 Lead 判断的（我不能只靠一次运行定性）**：

7. **`[O]` 向下拖选起点是页首行而不是锚点行**（选区 197 字、同页、< 整页 251）。这与"反选"的用户症状一致，但 run3 那次**没有坐标日志**（坐标打印是本轮后加的），我无法排除"拖动几何被我算歪"。run4 因为更早在 `[F]`/`[G2]` 中止，没跑到 `[O]`。→ **建议：单独重跑 `[O]`**（坐标已埋点），或由 Lead 用它自己的探针复核同场景（从中间行向下拖到空白）。
8. **偶发的"文本层不挂 span"**：run1 `[C]`（3 页文档，40s×2）、run2 `[I]`（24 页文档，40s）——现象与第一轮报告的 P1 完全一致（阅读器已开、页码/画布正常，`.rd-pdf-text span` 长时间为 0）。同一构建上我的独立探针（`tmp/ux4-diag-big.mjs`）打开 24 页文档只用了 **0.5s** 就挂上 120 个 span，说明它是**间歇**的。
9. **偶发的渲染层无响应**：run2（缩略图快刷时）与 run4（`[G2]` 扫描弹框第 2 次采样时）都出现 `CDP 超时 Runtime.evaluate`（20s 无响应）。run2 我把"一次 eval 刷 28 步"拆成"每趟一次 eval、超时放宽到 60s"后，run3 三趟快刷各 ~1.8s 正常返回；但 run4 又在新位置遇到同类超时——像是**渲染层偶发卡住**，不只是用例写法。
10. **run4 `[F]` 首次右键没弹菜单**（`✓ 拖选出 5 个字符` 之后 6 条级联失败），紧接着 `[F2]` 的右键就正常弹出了 7 项——同一次会话内、相隔几秒，前一次右键静默失败。

### R2-8.5 稳定性结论（第三轮）

- **六套既有套件在本构建上稳定全绿**（tsc / vitest / verify-core / e2e / acceptance / cjk，各一次通过）。
- **扩展后的 acceptance-ux 不稳定**：四跑分别中止于 `[C]`、`[I]+[J]`、跑完但 9 项失败、中止于 `[F]+[G2]`；失败集合每次都不同。其中 6 条已定位为我的用例问题（并已修好，待复跑），另 4 类现象（文本层不挂、渲染层无响应、右键不弹、向下拖反选）看起来是**产品侧间歇问题**，需要 Lead 判断。
- 按"不许粉饰"的口径：**本轮我不能给出"acceptance-ux 全绿"的结论**；能给的结论是「缩略图自愈、连续跳页代次控制、目录落点、缩放档位/细步进/防抖落盘这些新行为在 run3 里逐条通过」，以及「脚本自身的 6 处判据缺陷已修」。

### R2-8.6 收尾

```
Get-Process electron → 0（每次跑前跑后各清一次）
dist/** → 255/255 与 22:22:26 快照一致（全程未跑 build.mjs）
```

- 本轮新增日志：`tmp/ux4-tsc.txt`、`ux4-vitest.txt`、`ux4-verifycore.txt`、`ux4-e2e.txt`、`ux4-acceptance.txt`、`ux4-cjk.txt`、`ux4-ux.txt`、`ux4-ux2.txt`、`ux4-ux3.txt`、`ux4-ux4.txt`、`ux4-dist-before.txt`、`ux4-dist-after.txt`、`ux4-diag.txt`、`ux4-diag-big.txt` 全部保留；
- 诊断探针 `tmp/ux4-diag.mjs`、`tmp/ux4-diag-big.mjs`、`tmp/ux-fixture-check.mjs` 保留可重跑；
- 本轮我只改了 `tools/acceptance-ux.mjs`、`docs/verification-report.md`，外加 `tmp/**`；**没有改任何 `src/**`**。
- 一次操作失误如实记录：我曾用 PowerShell `Get-Content | Set-Content` 去改一份 tmp 探针副本，导致该副本 UTF-8 中文被按 GBK 写坏（已删除，原文件未受影响）；后续所有文件改动都改用文件工具完成。

### R2-8.7 复跑：Lead 修 `extract.ts` 饥饿问题 + `[O]` 改用 span 序号判据之后

- **被验构建**：`dist/**` = **2026-10-09 22:46:26**，对应 `src/core/extract.ts` **22:46:22**、`src/renderer/reader/PdfViewer.tsx` **22:39:34**。开跑前快照 `tmp/ux5-dist-before.txt`，与前一份构建比对：**7 个文件被替换**（渲染层 + 主进程产物），确认是新产物。
- **只跑新节**：给脚本加了 `UX_SECTIONS` 过滤开关（`UX_SECTIONS=I` → 跳过 `[B]`–`[H]`，只跑 `[I]`–`[P]` + `[H2]`），并新增 `searchLibrary()` / `openMeasured()`（在**页面内**用 `performance.now()` 量时延）。

**run1：52 ✓ / 3 ✗（115.8s）**、**run2：41 ✓ / 4 ✗（124.1s）**（run2 的差异见下）。

**① Lead 修的"主进程抽取饿死 I/O"——硬指标通过（本轮最大验证点）**

```
✓ [硬指标] 双击 → 文本层出 span：148ms（要求 < 5000ms）
   里程碑 {"reader":148,"canvas":148,"textDiv":148,"spans":15}
✓ [硬指标] 双击 → 文本层出 span：149ms（要求 < 5000ms）
   里程碑 {"reader":77,"canvas":77,"textDiv":77,"spans":75}
```
修复前同样场景是 15–25s（脚本给 40s 都等不到），现在是 **148/149ms**，两次复跑都稳定。`[C]` 那类"文本层始终为空"的 40s 超时也在这两跑里**再没出现**。

**② `CDP 超时 Runtime.evaluate`（渲染层无响应）——两跑都没再出现**，与 Lead "主进程被饿死导致渲染层拿不到资源"的判断一致（旧构建上出现过 2 次）。

**③ `[O]` 换成 span 序号 + `intersectsNode(锚点)` 后，判据与 Lead 的结论一致：产品是对的**

```
锚点：页 3 的第 3/5 个 span（按在 40% 处 x=252, y=300）；下空白=(567,495)；上空白=(567,120)
向下拖选区：「e3 delta echo foxtrot golf hotel india.」
  ✓ 向下拖选区包含锚点 span（intersectsNode=true）
  ✓ 没有反选：选区起点 span 2 ≥ 锚点 span 2（覆盖 2→3）
  ✓ 向下拖选区只在锚点页内（start=3 end=3 期望页=3）
向上拖选区：「UX Thumbs Sample - Page 3」
  ✓ 向上拖选区包含锚点 span（intersectsNode=true）
  ✓ 没有反选：选区终点 span 2 ≤ 锚点 span 2（覆盖 0→2）
  ✓ 向上拖选区只在锚点页内（start=3 end=3 期望页=3）
```
→ 我 R2-8.4 里那条"疑似反选"是**我的用例几何/文本前缀判据算歪了**，Lead 的复核结论成立；已按建议改为 span 序号 + `intersectsNode`。

**④ 我上一轮修的 6 处用例缺陷——全部确认修好（run1）**

```
✓ [continuous] 点缩略图第 5 页 → 当前页 5          （旧：落到第 12 页）
✓ 缩略图面板有 24 个页位 / ✓ 快刷并静置 5s 后剩余数字占位 = 0（实际 0）
   缩略图统计：{"total":24,"imgs":24,"badImgs":0,"ghosts":0,"ready":24,"pendingPages":[]}
✓ 连按两次 ] → 最终第 3 页；✓ 连点第 10、12 页缩略图 → 最终第 12 页
✓ Ctrl+= 档位序列：100% → 150% → 200% → 300% → 400% → 400%
✓ Ctrl+滚轮一次 100% → 115%（涨幅 15% ≤ 40%）
✓ 防抖基线：重置后 defaultZoom=1（期望 1）           （旧：读到重置自己那次落盘）
✓ [single]/[double] 缩略图第 5 页 → 当前页 5；三布局目录 Chapter 2 → 第 7 页
✓ 默认侧栏只有 4 项：全部文献 / 最近添加 / 在读 / 星标   （旧：把文件夹行也数进去）
✓ 勾选后侧栏出现「未读」：… 在读 / 未读 / 星标
✓ 重启后「未读」仍在侧栏
✓ 取消勾选后「未读」消失；✓ 筛选回落到「全部文献」
```

**⑤ 仍未通过：文内搜索 0 命中（3 条，跨三种布局）——这次有决定性诊断**

```
搜索诊断：{"inputValue":"uniquepage9","count":""}
✗ [continuous]/[single]/[double] 文内搜索命中 0 条（）
```
- 查询词**确实进了输入框**（`inputValue` = `uniquepage9`），但命中列表为空、`.rd-search-count` 也是空，**界面没有任何提示**（没有"还没有全文索引"之类 toast）。
- 我这一版还特意**先点第 9 页缩略图**把该页打开（`fullTextIndex` 用的是 `opened-only` 策略），再跳回第 5 页，然后搜索 —— 结果仍是 0 条，所以不是"那一页没打开过"能解释的。
- 结合源码：`ReaderView.tsx` 的 `runSearch()` 只有在 `api.getItemText()` 返回**空**时才 `indexItemText()`；如果已存在一个**部分**索引（例如只覆盖首次打开时渲染过的那几页），它不会重建也不会补页，于是查第 9 页的 token 永远是 0 命中，且**没有任何反馈**。
- 判定：这**更像产品侧（索引范围/无反馈）**，不是我的用例问题；但我本轮预算见底，**没有再做进一步定位**（没有去读索引文件、也没有试"删除索引后重建"）。建议 Lead 或 reviewer 用它自己的探针确认"查已打开页的 token 是否仍然 0 命中"，再决定是补索引策略还是加重建入口。

**⑥ run2 的额外一条失败（我的用例问题，未修完）**

```
✗ 取不到锚点行（视口内可拖选的行不足 3 行）
```
`[N]` 结束时把阅读器停在 **300% 缩放**，到 `[O]` 时视口里只剩不到 3 行可拖选，我的锚点选取要求 ≥3 行。修法很简单（`[O]` 前先 `Ctrl+0` 回适应宽度），本轮未改。

**收尾**：两跑跑前跑后都清过 electron，最后一次为 **0**；`dist/**` 与 22:46:26 快照比对一致（`tmp/ux5-dist-before.txt`）；日志 `tmp/ux5-new.txt`、`tmp/ux5-new2.txt` 保留；本轮只改 `tools/acceptance-ux.mjs`（加 `UX_SECTIONS` 开关、`openMeasured` 时延硬指标、`[O]` 改 span 序号判据）与本节报告，**没有改任何 `src/**`、没有跑 `build.mjs`**。

### R2-8.8 最终复跑：全绿（Lead 修"边打边搜"之后）

- **被验构建**：`dist/**` = **2026-10-09 22:56:35**，对应 `src/renderer/reader/ReaderView.tsx` **22:56:31**、`src/core/extract.ts` 22:46:22。
- 开跑前快照 `tmp/ux6-dist-before.txt`（与前一份构建差 6 行 = 3 个文件被替换），跑完复查 `tmp/ux6-dist-after.txt`：**255/255 逐字节一致**（全程未跑 `build.mjs`）。
- 命令：`UX_SECTIONS=I node tools/acceptance-ux.mjs`（只跑 `[A]` + `[I]`–`[P]` + `[H2]`）。

**结果：58 ✓ / 0 ✗，exit 0，191s** —— 这是 `acceptance-ux.mjs` 扩展后**第一次整轮全绿**。

```
[I] ✓ [硬指标] 双击 → 文本层出 span：164ms（要求 < 5000ms）
    里程碑 {"reader":82,"canvas":82,"textDiv":82,"spans":120}
[J] ✓ 缩略图面板有 24 个页位；✓ 快刷并静置 5s 后剩余数字占位 = 0（实际 0）；✓ 24/24 真预览
    统计 {"total":24,"imgs":24,"badImgs":0,"ghosts":0,"ready":24,"pendingPages":[]}
[K] ✓ 连按两次 ] → 第 3 页（offset 0px）；✓ 120ms 连点第 10、12 页缩略图 → 第 12 页（offset 0px）
[L] 三种布局 × 三项落点全部通过：缩略图第 5 页 → 5；目录 Chapter 2 → 7；
    ✓ 文内搜索命中 1 条（P9）→ 点命中 → 第 9 页    ← Lead 的"边打边搜"修复生效（脚本没有按 Enter）
[M] ✓ 档位 100% → 150% → 200% → 300% → 400% → 400%；✓ 按键到标签 63ms；✓ Ctrl+0；
    ✓ Ctrl+滚轮 100% → 115%（15% ≤ 40%）
[N] ✓ 立刻读仍是 1（未提前落盘）；✓ 防抖后落盘 3（300%）
[O] ✓ 向下拖：154 字、intersectsNode=true、起点 span 1 ≥ 锚点 1（覆盖 1→3）、同页 9、< 整页 251
    ✓ 向上拖：23 字、intersectsNode=true、终点 span 1 ≤ 锚点 1（覆盖 1→1）、同页 9
[P] ✓ 默认严格 4 项 → ✓ 勾选后 5 项 → ✓ 点「未读」成为当前筛选 → ✓ **真重启后仍在**
    → ✓ 取消勾选后消失 → ✓ 筛选回落「全部文献」
[H2] ✓ 渲染层零错误（0）
✅ UX 回归验收全部通过
```

**本轮同时确认**：

- ⑤ 文内搜索 0 命中**已修好**（根因是"UI 只在 Enter/查找时才触发 runSearch"，不是索引策略）：不按 Enter、仅输入防抖 300ms 即得 `1 条 / P9`，三种布局都命中并把阅读器跳到第 9 页。
- `CDP 超时 Runtime.evaluate` 在最终轮**一次都没出现**（22:22:26 构建上曾出现 2 次）——与 Lead 修的 `extract.ts` 宏任务让出、主进程不再饿死渲染层一致。
- `[I]` 硬指标三跑分别为 **148ms / 149ms / 164ms**（修复前 15–25s），这条断言现在能把这个 bug 永久钉住。

**本轮（R2-8.7→8.8）我又修的两处用例状态问题**（都属于"前面用例改了状态，后面用例没复位"）：

1. `[M]` Ctrl+滚轮偶发无效：滚轮点位原本写死 (700,450)，改为**当前页中心**，并加一次重试 → 现在稳定 100%→115%。
2. `[O]` 取不到锚点行：`[N]` 结束时停在 300% 缩放、且视口可能落在页边空白。现在 `[O]` 开头先 `Ctrl+0` 回适应宽度 → 再把当前页文字块 `scrollIntoView({block:'center'})` → 仍取不到才再重置一次重试（不再误报）。

**收尾**：`Get-Process electron` = **0**；`dist/**` 255/255 未变；日志 `tmp/ux6-new.txt`（46 ✓ / 2 ✗，暴露上述两处状态问题的那轮）、`tmp/ux6-final.txt`（58 ✓ / 0 ✗）保留；本轮只改 `tools/acceptance-ux.mjs` 与本节报告，**没有改任何 `src/**`、没有跑 `build.mjs`**。

---

## R2-9. 收尾轮：六套既有套件 + 满编 acceptance-ux（22:56:35 构建）

### R2-9.0 被验构建

`dist/**` = **2026-10-09 22:56:35**，`src/**` 最新 = **22:56:31**（`ReaderView.tsx`）；开跑前用 `tmp/ux6-dist-before.txt` 做基线，跑完复查 `tmp/ux7-dist-after.txt`：**255/255 逐字节一致**（全程未跑 `build.mjs`）。此前六套是在 22:22:26 构建上跑的，本轮全部重跑。

### R2-9.1 七套结果（严格串行，日志 `tmp/ux7-*.txt`）

| # | 套件 | 命令 | 期望 | 实测 | 耗时 | 结论 |
|---|------|------|------|------|------|------|
| 1 | 类型检查 | `tsc -p tsconfig.json --noEmit` | exit 0 | exit 0，**0 字节** | 3.0s | ✅ |
| 2 | 单元测试 | `vitest run` | 10 / 209 | **10 passed (10) / 209 passed (209)** | ~1s | ✅ |
| 3 | 核心逻辑 | `tools/verify-core.mjs` | 51 ✓ | **51 ✓ / 0 ✗** | 14.8s | ✅ |
| 4 | 桌面端到端 | `tools/e2e-desktop.mjs` | 26 ✓ | **26 ✓ / 0 ✗** | 49.1s | ✅ |
| 5 | 补充验收 | `tools/acceptance.mjs` | 37 ✓ | **37 ✓ / 0 ✗** | 62.3s | ✅ |
| 6 | 中文划词/缩放 | `tools/acceptance-cjk.mjs` | 17 ✓ | **17 ✓ / 0 ✗** | 32.7s | ✅ |
| 7 | UX 回归（满编） | `tools/acceptance-ux.mjs` | 按实际 | run1 **7 ✓ / 1 ✗（中止于 `[C]`）**；run2 **140 ✓ / 5 ✗** | 93.8s / 168.9s | ⚠️ 见 R2-9.3 / R2-9.4 |

### R2-9.2 `extract.ts` 让出宏任务对既有套件的影响（Lead 特别关注项）

- **`verify-core` 51/51 全绿**（14.8s，与 22:22 构建的 14.9s 基本一致）——真文件抽取 + 全文检索断言没有受影响。
- **`acceptance` 37/37 全绿**，其中规模测试：
  ```
  ✓ 全部解析完成：300 条 — 总耗时 1.9s
  ✓ 300 个文件的首次索引在 1.9s 内完成
  ```
  同一断言在 **22:22:26 构建上是 0.9s**，现在 **1.9s**：让出宏任务确实让 300 文件的解析+索引慢了约 **1.0s（≈2×）**。该断言的阈值是 `elapsed < 180`（`tools/acceptance.mjs:270`），**余量极大，不构成风险**；emoji 文件名解析、超长嵌套路径、搜索命中 21 行、文件名搜索等断言全部通过。
- 结论：让出改造**没有造成任何既有套件失败**，代价是规模测试的解析时长翻倍（0.9s → 1.9s）。

### R2-9.3 满编 `acceptance-ux` run1：中止于 `[C]`——文本层 0 span（残留间歇问题）

```
✗ 阅读器打开且文本层就绪（第 2 次尝试）
  诊断（两次尝试的现场）：
   [{"attempt":1,"rowText":"UX Acceptance Sample…","diag":{"rows":0,"search":"","reader":true,"stage":true,
     "canvases":3,"textDivs":3,"spans":0,"topbar":"UX Acceptance Sample"}},
    {"attempt":2,…同上：reader=true, canvases=3, textDivs=3, spans=0}]
```
- 现象与第一轮那个 P1 同类：**阅读器已打开、3 个画布都渲染出来了、`.rd-pdf-text` 容器也在，但 `.rd-pdf-text span` 连续 40s×2 保持 0**。
- 关键点：这一轮是**满编**跑（先跑 `[C]` 打开 3 页小文档）；而同一构建上只跑 `[I]`–`[P]` 时，24 页大文档的文本层 **164ms** 就出 span（R2-8.8）。也就是说 Lead 的 `paintTextLayer` 自愈（失败后重试 2 次 × 500ms）**在 `[C]` 这条路径上没有生效**。
- 稳定性：两次满编跑里出现 1 次（run1 失败、run2 通过）→ **间歇**，但这次带了完整 DOM 现场，可直接用于定位"自愈为什么没触发"。

### R2-9.4 满编 `acceptance-ux` run2：140 ✓ / 5 ✗——5 条全部来自 `[G2]`，且原始证据指向「扫描进度」弹框 Esc 关不掉

`[G2]` 的两条采样原文：
```
第 1 次：clicked=true modal=true  pre={"modal":true,"active":true,"reader":true,"title":"扫描进度"}
                                  post={"modal":true,"active":true,"reader":true}
第 2 次：clicked=false modal=false pre=null post=null
✗ 打开真对话框 .modal-backdrop（标题「（没有）」）
✗ 按 Esc 之前扫描仍在进行（排除弹框已经自己关闭）
✗ Esc 关闭了对话框（Modal 自己的监听器生效）
✗ 按 Esc 之后扫描仍在进行 → 排除"扫描结束导致弹框自动消失"的假绿
✗ Esc 关对话框后阅读器仍在
```
- **第 1 次才是有效判据**：对话框确实开着（`modal=true`、标题「扫描进度」）、按 Esc 时扫描**仍在进行**（`active=true`），**500ms 后对话框仍然开着（`post.modal=true`）** → **Esc 没能关掉这个对话框**，而不是"弹框没打开"。
- 这条在 **22:22:26 构建上是通过的**（当轮 `[G2]` 第 1 次 `post.modal=false`），所以是**回归信号**：候选回归点在 `ReaderView.tsx` 的 Esc 让出分支（`deferEscape`）与 22:39/22:56 两次改动之间。
- **我的用例缺陷（已修，未复跑）**：原来的重试条件是"没关掉就再试一次"，于是第 2 次（因为弹框还开着，我的点击守卫拒绝再点 → `clicked=false`）**覆盖了第 1 次的证据**，把"Esc 关不掉"误报成"弹框没打开"。现已改为：**只要某次"对话框真开过 + Esc 前扫描仍在跑"就以该次为准**，不再重试掩盖。
- run2 的其余 140 条全绿，包括 `[C]`、`[F]`/`[F2]` 右键、`[G]`/`[G3]`、`[I]` 硬指标 **96ms**、`[J]` 24/24 真预览 0 占位、`[K]` 连点、`[L]` 三布局文内搜索命中 P9、`[M]`/`[N]` 缩放、`[O]` 双向选区、`[P]` 侧栏 4→5→重启→回落。

### R2-9.5 收尾

```
Get-Process electron → 0（每步前后各清一次，最后一次复查仍为 0）
dist/** → 255/255 与 22:56:35 快照一致（全程未跑 build.mjs）
```
- 日志：`tmp/ux7-tsc.txt`、`ux7-vitest.txt`、`ux7-verifycore.txt`、`ux7-e2e.txt`、`ux7-acceptance.txt`、`ux7-cjk.txt`、`ux7-ux-full.txt`（run1 中止原文）、`ux7-ux-full2.txt`（run2 140/5）、`ux7-dist-after.txt`。
- 本轮我只改 `tools/acceptance-ux.mjs`（`[G2]` 结果取"首个有效判据"）+ 本节报告；**没有改任何 `src/**`、没有跑 `build.mjs`**。
- **收工口径**：六套既有套件在最终构建上**全绿**；满编 `acceptance-ux` **未能一次全绿**，剩两条都带原文与现场：① `[C]` 文本层 0 span（间歇，自愈未触发）；② `[G2]` 阅读器里「扫描进度」弹框 Esc 关不掉（候选回归，22:22 构建上是通过的）。

---

## R2-10. 两条遗留问题的专项压测（23:14:20 构建）

`dist/**` = **2026-10-09 23:14:20**（Lead 加了 `PdfViewer.tsx` 的 6 秒看门狗；未动 Esc 相关逻辑）；开跑前快照 `tmp/ux8-dist-before.txt`，与前一份构建差 6 行 = 3 个文件被替换；未跑 `build.mjs`。为压这两条，脚本新增两个专项模式：`UX_C_ROUNDS=N`、`UX_G2_ROUNDS=N`（都只跑 `[A]` + 该专项），并新增 `console.warn/error` 采集。

### R2-10.1 ① `[C]` 文本层就绪耗时 × 5 轮：全部 < 1s，未再出现 0 span

```
[C-STRESS] 只压 [C]：文本层就绪耗时 × 5 轮（看门狗预期 6s 内自愈）
  第 1 轮：firstSpan=125ms  spans=15  里程碑={"reader":125,"canvas":125,"textDiv":125,"spans":15}
  第 2 轮：firstSpan=51ms   spans=15  里程碑={"reader":51,"canvas":51,"textDiv":51,"spans":15}
  第 3 轮：firstSpan=52ms   spans=15  里程碑={"reader":52,"canvas":52,"textDiv":52,"spans":15}
  第 4 轮：firstSpan=52ms   spans=10  里程碑={"reader":52,"canvas":52,"textDiv":52,"spans":10}
  第 5 轮：firstSpan=50ms   spans=15  里程碑={"reader":50,"canvas":50,"textDiv":50,"spans":15}
  分布：<1s 5 轮｜1–6s 0 轮｜≥6s（看门狗窗口）0 轮｜>25s 超时 0 轮
  console 警告/错误共 1 条，阅读器相关 0 条：[]
  ✓ 5 轮每轮都在 10s 内出 span（异常轮次：[]）
```
- 5 轮全部在 **50–125ms** 出 span；**没有一轮落到 6s 看门狗窗口**，也没有 `>25s` 仍为 0 的情况；没有抓到 `[reader] 第 N 页…` 之类的 console 警告。
- 结论口径要谨慎：这是**"5 轮未复现"**，不等于间歇问题已消失（该现象在之前的满编跑里约 2 次中 1 次出现）。但至少**看门狗版本没有引入新的慢路径**，正常路径仍是 50–125ms。

### R2-10.2 ② `[G2]` 扫描进度弹框 Esc × 5 轮（**每轮都在阅读器打开状态下**）：5/5 关掉

```
[G2-STRESS] 只压 [G2]：扫描进度弹框 Esc × 5 轮
  第 1 轮：pre={"modal":true,"active":true,"reader":true,…} post={"modal":false,"active":true,"reader":true}
  第 2 轮：pre={…reader:true} post={"modal":false,"active":true,"reader":true}
  第 3 轮：pre={…reader:true} post={"modal":false,"active":true,"reader":true}
  第 4 轮：pre={…reader:true} post={"modal":false,"active":true,"reader":true}
  第 5 轮：pre={…reader:true} post={"modal":false,"active":true,"reader":true}
  ✓ 有效采样 5/5 轮（对话框真开过 + Esc 前扫描仍在跑）
  ✓ Esc 关掉对话框：5/5 轮
```
- 第一版压测有个**用例漏洞**：第 1 轮的收尾 Escape 把阅读器关掉了，于是第 2–5 轮其实是"没有阅读器"的状态（`reader:false`），**测不到 `deferEscape` 那条路径**。已改为**每轮开始先确保阅读器打开**（必要时重新打开）后重跑 —— 上表就是修正后的结果：**5/5 全部 `reader:true`，5/5 Esc 都把对话框关掉**。
- 所以 ② 在**孤立路径下不复现**：它更像是**满编流程里某种前置状态**导致的（例如前面小节留下的浮层/焦点状态）。给 Lead 的下一步线索：满编 run2 里 `[G]`（快捷键面板）紧挨在 `[G2]` 之前，而 `App.tsx` 的 Esc 分支是 `if (showShortcuts) { setState(false); return; }` —— **若那一轮结束时 `showShortcuts` 仍为真，Esc 会被 App 拿去关面板、进度弹框就收不到**，正好能解释 `post.modal=true`。建议：在 `[G2]` 的 pre 里顺带断言 `showShortcuts === false` 且 `.modal-backdrop` 数量为 1（我这边下一轮可以加，本轮预算已尽）。

### R2-10.3 收尾

```
Get-Process electron → 0
dist/** → 255/255 与 23:14:20 快照一致（未跑 build.mjs）
```
- 日志：`tmp/ux8-cstress.txt`（① 5 轮）、`tmp/ux8-g2stress.txt`（② 第一版，暴露"第 2–5 轮阅读器没开"的用例漏洞）、`tmp/ux8-g2stress2.txt`（② 修正后 5/5）、`tmp/ux8-dist-before.txt`。
- 本轮只改 `tools/acceptance-ux.mjs`（新增 `UX_C_ROUNDS` / `UX_G2_ROUNDS` 专项模式、`console.warn` 采集、`openMeasured` 可配超时）+ 本节报告；**没有改任何 `src/**`、没有跑 `build.mjs`**。
- 两条遗留问题的最终定性：**①[C] 在 5 轮专项里未复现（50–125ms，无看门狗触发）；②[G2] 在"每轮都开着阅读器"的 5 轮专项里 5/5 通过，孤立路径不复现 → 更像满编流程的前置状态问题，已给出可验证假设（`showShortcuts` 残留）。**


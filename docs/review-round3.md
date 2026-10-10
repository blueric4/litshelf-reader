# 对抗式复盘：第三轮修复（选区方向 / 缩略图 / 缩放 / 侧栏）

- 审查人：reviewer（对抗式审查，**只读不改**）
- 交付物：本文件（新文件）。`docs/review-selection.md`、`docs/review-ux-round.md` 均未改动。
- 审查对象（本轮）：`reader/PdfViewer.tsx`（`clampSelection` 方向判定、`goToPage` DOM 对齐、重渲染路径）、`reader/ReaderView.tsx`（`ZOOM_STEPS`/`zoomBy`/`applyZoom` 步长与落盘防抖、`pageGetter` 注入）、`reader/ReaderPanels.tsx`（缩略图真预览/懒加载/缓存/串行队列）、`components/Sidebar.tsx` + `views/SettingsView.tsx` + `shared/types.ts`（侧栏可见项设置）。

## 0. 方法与限制

| 项 | 说明 |
| --- | --- |
| 验证方式 | **只读静态审查 + 代码路径推理**。读的是本轮全部落盘后的版本：`PdfViewer.tsx` 1290 行（22:05）、`ReaderView.tsx` 1591 行（22:06）、`ReaderPanels.tsx` 751 行（22:11）、`shared/types.ts`（22:11）、`Sidebar.tsx`（22:12）、`SettingsView.tsx`（22:12）。另核对了 `reader/pdf.ts`、`core/library.ts`、`core/store.ts`、`core/host.ts`、`state/store.ts`、`node_modules/pdfjs-dist/build/pdf.mjs`、`tools/acceptance-ux.mjs`、`tmp/**/cache/thumbs` 里的真实缩略图文件。 |
| 未做 | **未启动 Electron**（docsmith / verifier 在用）。所有"运行时观感"（键鼠时序、trackpad 滚轮、React 提交时机、Electron 全屏）**标"未实测"并给桌面判定步骤**。 |
| 无 diff | 仓库不是 git 仓库，无改动前快照；本轮改动范围由 mtime + 逐段重读确认。**审查期间目标代码仍在变动**：`ReaderPanels.tsx` 在 22:11 被再改一次（把我在 §2.2 报的缩略图缓存缺陷当场修掉了），本报告已按 22:11/22:12 版本复核该修复。 |
| 结论口径 | **安全**＝代码路径可证明无问题；**有风险**＝依赖运行时行为或存在可疑分支，已给复现步骤；**已确认缺陷**＝不依赖浏览器细节即可从代码证明的错误结果；**未实测**＝需桌面验证。不使用"应该没问题"。 |

---

## 1. 选区夹取的方向判定（用户直报的"反选"）

**结论：安全。反选与夹空两条路径都有代码级防线；仅剩两类"过度夹取"的老行为（P2），不会反选。**

### 1.1 新判定逻辑（`PdfViewer.tsx:845-913`）

```ts
850:      // 拖动方向：竖直位移优先（PDF 文字自上而下），纯横向拖动用左右判断
851:      const dy = clientY - fromY;
852:      const dx = clientX - fromX;
853:      const forward = Math.abs(dy) > 6 ? dy > 0 : dx >= 0;
...
872:      const anchorPos = { node: sel.anchorNode, offset: sel.anchorOffset };
873:      let target = caret && caret.pageEl === anchorPage ? { node: caret.range.startContainer, offset: caret.range.startOffset } : null;
878:      // 目标位置必须落在"拖动方向那一侧"，否则会夹成反选
880:      if (target) { /* probe: 按 forward 试 setStart/setEnd，collapsed 或抛错就置 null */ }
895:      if (!target) target = forward ? lastPos : firstPos;
897:      const start = forward ? anchorPos : target;
898:      const end = forward ? target : anchorPos;
...
907:      if (clamped.collapsed) return;            // 夹空 → 保留原选区
908:      const before = range.toString();
909:      const after = clamped.toString();
910:      if (after.length >= before.length) return; // 没变短 → 不动
```

方向取自**鼠标位移**（按下点 `drag.x/y` → 松开点），锚点仍取 `sel.anchorNode`；`fromX/fromY` 由 `onUp` 传入 `drag?.x ?? clientX`（`:936`），而 `dragRef` 只在**左键**按下时赋值（`:1030-1038` 非左键提前 return）→ 右键/中键不会污染拖动起点 ✓。

### 1.2 三类拖动的结论（**已确认**的静态推演）

| 拖动 | `forward` | 结果 | 判定 |
| --- | --- | --- | --- |
| 同一行左→右，松手在行尾空白（页内） | `\|dy\|≤6` → `dx≥0` → true | 光标在页内时用光标位置；否则夹到 `lastPos`（本页末）。range = [锚点 → 目标] | 安全 |
| 同一行右→左，松手在行首空白（页内） | false | 同上，夹到 `firstPos`；range = [目标 → 锚点] | 安全 |
| 斜向（下+左，`\|dy\|>6`） | `dy>0` → true（竖直优先） | 夹到本页末/光标位置；横向分量不参与判定 → 与"往下拖"一致 | 安全（语义正确） |
| 由下往上拖出页面顶部（页外） | `dy<-6` → false | `target = firstPos`，range = [本页首 → 锚点] | 安全 |
| 由上往下拖出页面底部（页外） | true | `target = lastPos`，range = [锚点 → 本页末] | 安全 |

**不会反选的证明**：`forward` 决定 `start/end` 的拼接顺序，`target` 在采用前必须先通过 880-894 的 probe（按同一顺序 `setStart/setEnd`，若 DOM 顺序与预期相反，`setEnd` 落在 `setStart` 之前会让 range **折叠**（DOM 规范行为，不是抛错）→ `probe.collapsed` → `target = null` → 退回 `forward ? lastPos : firstPos`）；而 `lastPos`/`firstPos` 是页内 DOM 序的极值，与 `anchorPos`（同页内）拼出来的 range **要么非空、要么折叠**，折叠时由 907 行直接放弃替换 → 所以既不会把选区夹到锚点另一侧（反选），也不会清空选区（夹空）。这正是上一轮用户报的两个症状的两条防线。

### 1.3 仍然存在的两类"过度夹取"（P2，非本轮回归）

1. **松手落在页外时的兜底仍是"页首/页末"，不看松手位置**（`:895`；机制注释见 `:706-710` 与 `:729-734`）：横向右→左拖到页面**左侧 28px 灰边**（`reader.css:518-522` 的 padding）松开 → `caret.pageEl` 不是本页 → `target = firstPos` → 选区变成"本页第一行 → 按下点"。用户想选的是一行里的一小段，结果多选了上半页。最小复现：在某行右端按下 → 向左拖出页面左边缘 → 松开 → 看选区首端是不是本页第一行。**未实测**（是否触发取决于 `caretRangeFromPoint` 在灰边返回什么；页外时 `pageEl` 必为 null，故大概率触发）。
2. **Shift+点击**（先用 Shift 扩展选区、再点空白）：`drag.x/y` = 点击点 → `dx=0` → `forward=true`，若点击落在空白处（`inText=false`）会被当成"向下拖"夹到 `lastPos`。**未实测**，影响面小。

`caretRangeFromPoint` 返回 null / 不在本页时的兜底路径：**安全** —— `textCaretAt` 返回 null → `target=null` → 用页内极值 + 907/910 两道守卫（不空、不变长）→ 最坏情况是"没夹"（保留浏览器原选区），不会夹坏。

---

## 2. 缩略图渲染的性能与内存

**结论：内存量级安全（实测口径见下）；本轮初稿发现的"永久占位"缺陷已在 22:11 版修复，复核通过（见 §2.2）。**

### 2.1 峰值内存口径

- 每张缩略图：`renderThumb` 用 **132 CSS px 宽**（`ReaderPanels.tsx:415`）画到离屏 canvas，再 `canvas.toDataURL('image/jpeg', 0.72)`（`:417-433`）。canvas 后备缓冲 = 132 × 187 × 4 B ≈ **99 KB/张（瞬时，画完即可回收）**。
- **串行队列**保证同一时刻最多 1 个 canvas + 1 个 dataURL 在生成（`:443`、`:499-509`）→ 峰值额外内存 ≈ 0.1 MB，可忽略。
- **缓存**：`thumbs: Map<page, dataURL>`（`:439`）**没有上限、也不淘汰**（只在切 Tab / 换文档 / 关阅读器卸载组件时随 state 一起丢弃，`:478-484`）。量级：仓库里现成的封面文件（200px 宽 WebP）实测只有 **1842 B**；132px 宽 JPEG q0.72 的文字页同量级（约 2–5 KB），dataURL 再乘 base64 的 ~1.37 → **单张 3–7 KB**。
  - 300 页全滚动一遍：**约 1–2 MB**；即使是扫描件（照片型 JPEG 6–12 KB/张）：**300 页约 2.5–5 MB**；1000 页扫描件约 **8–16 MB** → 可接受但会常驻到面板关闭。
  - 结论：内存不是问题；"**无上限 + 无淘汰**"是 P2（长文档长时间挂面板时缓慢增长），可加 LRU 或按"离屏 N 页即释放"。
- **快速滚动会不会堆积任务**：每次 `visible` 变化都会把"此刻可见的页"排进队列（`:497-527`），**旧的排队任务不会取消队列项，只会被 `cancelled` 短路**（`:500`）→ 任务数上限 = 滚动过程中曾进入视野的页数；但被短路的任务是**微秒级 no-op**，真正执行的渲染只属于"最后 settle 的那一批可见页" → 不会出现几十个 `render()` 并发/堆积 ✓。

### 2.2 缩略图"永久占位"缺陷：**已在 22:11 版本修复，复核通过 ✅**

我在初稿里报的是这条（当时 `ReaderPanels.tsx` 是 22:04 版）：懒加载 effect 的 `deps` 含 `visible`，滚动一次就让上一轮 effect 的 cleanup 把 `cancelled=true`（`:528-530`），已入队的任务于是在 `:500/:502` 返回 null、或在 `:516` 丢结果；但 `cacheRef.current.set(page, task)`（`:510`）已经把这一页记成"缓存过" → 之后每轮都在 `:498 if (cacheRef.current.has(page)) continue;` 跳过它 → 该页在本文档里**永远停在数字占位**（观感正是用户报的"有的页死活没预览"）。

**22:11 版已修**（`:511-519`）：

```ts
511:      void task.then((url) => {
512:        // 关键：只有**真的产出图片**才算缓存成功……作废/失败时把缓存删掉，让它下次能重来。
516:        if (!url || cancelled || docIdRef.current !== docId) {
517:          cacheRef.current.delete(page);
518:          return;
519:        }
520:        setThumbs(...)
```

**复核结论：修得对，且没有引入新竞态。** 逐条查过：

- **不会误删"更新的任务"**：只要某一页还在 `cacheRef` 里，后续 effect 轮次都会在 `:498` 跳过它（不会覆盖成新任务）；只有该条目被删掉之后才可能新建。而删除只发生在"它自己的任务完结且没产出"这一条路上 → `delete(page)` 删的必然是它自己那条 ✓。
- **不会死循环**：被删掉的页若仍在可见集合里，下一轮会重新排队；排队任务若再被取消就再删再排 → 用户在**持续滚动**期间该页可能反复重渲染（CPU 浪费，串行队列 + 取消短路使其有界），停下来后最后一轮必然补上 ✓。
- **取消语义没变**：换文档/卸载依旧由 `docIdRef` + `cancelled` 双闸拦住 `setThumbs`（`:516`）✓。
- 唯一残留（P2）：重复渲染同一可见页的浪费；以及"作废即重排"意味着滚动时队列里会积累已作废的 no-op 任务（微秒级，可忽略）。

**修后仍建议的验收用例**（本轮无脚本覆盖，`tools/acceptance-ux.mjs` 21:31 版 grep `thumb|缩略图|jump|goToPage|ZOOM` 全无命中）：用脚本里现成的 `buildPdf(pageCount)`（`acceptance-ux.mjs:145`）造一个 **300 页单文件**，切到缩略图面板快速滚到底 → 停下等 5 秒 → 断言"可见页的 `<img>` 数量 ≥ 可见页数"（修复前会有大量 `rd-thumb-ghost` 残留）。

### 2.3 换文档 / 关阅读器时队列的取消（"会不会往已卸载组件写 state"）

**安全**。三道闸：`cancelled`（effect cleanup，`:528-530`）、`docIdRef`（换文档时在 `:478-484` 更新并清缓存）、`setThumbs` 前的 `cancelled/docId` 复查（`:516`）。卸载后 `setThumbs` 不会执行；`IntersectionObserver` 在 `:474` 断开；异步任务在文档 `destroy()`（`pdf.ts:242-248`）后 reject，被 `renderThumb` 的 `try/catch`（`:430-432`）吃掉，不会产生 unhandled rejection ✓。

---

## 3. 缩略图与主视图抢 pdf.js 页对象

**结论：安全。**

- 缩略图用**独立的离屏 canvas**（`ReaderPanels.tsx:423-425`），与主视图的 `.rd-pdf-canvas` 不是同一个元素 → 不会撞 pdf.js 的 "Cannot use the same canvas during multiple render() operations"（该错误是按 canvas 判定）✓。主视图重渲染（缩放/DPR 变化）时重建的是它自己的 canvas，缩略图的 canvas 已 `toDataURL` 完并被 GC，不存在复用/污染 ✓。
- 两个视图拿到的是**同一个 `PDFPageProxy`**：`pageGetter` 来自 `usePageGetter`（`reader/pdf.ts:275-294`，按文档缓存 `doc.getPage(page)`），而 `doc.getPage(n)` 在 pdf.js 内部也有按页缓存（`pdf.mjs:15769/15797/16182`）→ 同一页只会有一个代理对象 ✓。同一页上并发两个 `render()`（不同 canvas）是 pdf.js 支持的用法（每个 renderTask 独立，`_intentStates` 按 intent 聚合）✓。
- **没有 `page.cleanup()` 调用**：`renderThumb`（`:417-433`）全程不调 cleanup ✓，所以不会把主视图正在用的 operator list/字体清掉。（pdf.js 本身也做了保护：`cleanup()` 只在"没有在跑的 renderTask 且 operatorList 完整"时才真正清，见 `pdf.mjs:15408-15432` 的 `#tryCleanup`。）
- 唯一相关的外部调用是封面生成 `generateThumbnail` 里的 `page.cleanup()`（`reader/pdf.ts:264`，第 1 页、只在 `item.thumb` 为空时跑一次）：即使与主视图撞页，pdf.js 会推迟到渲染结束才清 → 正确性无风险，最多让第 1 页的 operator list 重解析一次（P2，且是上一轮就有的代码）。

---

## 4. 跳页精度（按真实 DOM 位置对齐）

**结论：三种布局的单次跳页都正确（含虚拟化兜底）——用户报的"跳错页"在单次操作下已修；残留两条 P2：跳页复校链无代次控制（窄窗口抢先后一次跳页）、以及"跳页用 DOM、报页仍用估算"的口径不一致。**

### 4.1 新实现（`PdfViewer.tsx:697-740`）

```ts
712:      const align = (attempt: number, allowSmooth: boolean) => {
713:        const node = pageEls.current.get(target) ?? el.querySelector<HTMLElement>(`[data-page-index="${target}"]`);
714:        if (node) {
715:          if (outline.layout === 'continuous') {
716:            const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
717:            el.scrollTo({ top: Math.max(0, top), behavior: allowSmooth && smooth && attempt === 0 ? 'smooth' : 'auto' });
718:          } else {
719:            node.scrollIntoView({ block: 'center', ... });
720:          }
722:          if (attempt === 0 && outline.layout === 'continuous') {
723:            window.setTimeout(() => align(1, false), 80);      // 再校一次
724:          }
725:          return;
726:        }
727:        if (attempt >= 8) return;
729:        if (attempt === 0 && outline.layout === 'continuous') { /* 用 geometryRef 估算先滚过去 */ }
735:        window.setTimeout(() => align(attempt + 1, false), 60);  // 每 60ms 重试，最多 8 次
736:      };
737:      align(0, true);
```

- **连续布局**：`top` 由实时 DOM rect 反推绝对滚动量（`node.top - container.top + scrollTop`）→ 与 `padding/gap/DPR/fit` 无关，**比原来的累加式准确**；且 `Math.max(0, top)` 防负值 ✓。
- **单页 / 双页**：走 `scrollIntoView({block:'center'})` ✓；目标页要等 `setCurrentPage` 触发的重渲染挂载后才存在，靠 60ms×8 的重试等到（`:735`）→ 通常第 1 次重试（60ms 后）就命中 ✓。**（未实测：仅静态推演 + React 提交时机推理）**
- **`pageEls` 里没有该页时的兜底**：不会算错。原因有两条：① 虚拟化未挂载的槽位渲染的是 `<div className="rd-page-ghost" data-page-index={pageNumber}>`（`:1181`），它 `.rd-page-slot` 内 `inset:0`，与真页**同尺寸同位置** → `el.querySelector('[data-page-index]')` 命中的几何是正确的；② 真没命中时用 `geometryRef` 估算先"滚到附近"让目标页进入渲染窗口（`renderSet = 可见页 ±2`），再靠重试精确校正（`:727-735`）→ 估算只影响"先跳到哪"，最终仍以 DOM 对齐 ✓。

### 4.2 【P2｜已确认机制，窗口较窄】前一次跳页的重试/复校会把后一次跳页"顶回去"

`align` 的重试链与 80ms 复校**没有任何"代次"或取消机制**（`:722-736`），每次 `goToPage` 都会新起一条链。窗口有多宽取决于目标页何时被找到：

- **快路径**（首次就查到节点，连续布局下靠 ghost 槽位几乎必然如此，`:1181`）：对齐一次 + **80ms 后复校一次**（`:722-724`）→ 链在 ~80ms 后结束。
- **慢路径**（节点尚未挂载，单页/双页或尺寸未就绪）：每 60ms 重试一次，最多 8 次（`:727-735`）；一旦某次查到就对一次并**立即结束**（不再排复校）→ 窗口 ≈ 60ms×k。

所以真正的抢先窗口是 **约 80–140ms**，而不是"半秒"：

**最小复现（需要手速很快，或用按键宏）**
1. 打开大 PDF（连续滚动），右侧「缩略图」；
2. 先点 **第 200 页**，在 **<150ms** 内再点 **第 5 页**（或改按 `]` 连按几次让焦点页连续前进）；
3. 观察：视图先落到第 5 页附近，随后被第 200 页那条链的复校拉回 200；而第 5 页那条链的**估算只在 attempt 0 执行一次**（`:729`），被拉走后它再也滚不回去 → 最终停在旧目标上（与"以最后一次操作为准"相反）。
4. 期望：最后一次操作胜出。**未实测（时序推理，需桌面用连点/连按复现）**。

同源但更常见的现象（P2，观感）：连按 `]` 或快速连点缩略图时，前面几条链的 80ms 复校会依次触发，画面出现 100ms 级的来回抖动；由于最后一条链的复校最晚触发，**最终位置仍然正确**，只是过程抖。
修法方向：`goToPage` 内维护自增 `genRef`，`align` 每步比对代次；或把 `setTimeout` id 存起来，在下一次 `goToPage`/卸载时 `clearTimeout`。

### 4.3 P2：80ms 复校可能把用户自己的滚动拽回

首次对齐后无条件排一次 `align(1,false)`（`:722-724`）。它算出的绝对 `top` 与第一次相同（不依赖当前滚动位置），所以若用户在这 80ms 内自己微调了滚动，会被拽回页顶。注：`smooth` 参数目前形同虚设——`ReaderView` 里 13 个 `goToPage` 调用点**全部**只传一个参数（`grep goToPage(` 全命中单参形式），所以 `behavior:'smooth'` 这一支今天走不到（"平滑动画被 80ms 复校硬切"的隐患因此不成立）。**未实测**（80ms 窗口的观感）。

### 4.4 P2：跳页用 DOM、报页仍用估算，可能在页码指示上"自己纠正回去"

`goToPage` 改成 DOM 对齐了，但 `reportScroll`（`:635-645`）仍然用 `geometryRef` 的 `pageSizes[i].height * scales[i] + gap` 累加来判定"当前是第几页"，并在滚动后回写 `setCurrentPage/onPageChange`（`:646-...`）。如果估算几何与真实布局确有偏差（`:706-710` 的注释正是这么说的），那么一次精确的跳页之后，紧接着的 scroll 事件会把页码"纠正"成估算值（可能 ±1），并把进度写到这个值上。**同一份几何两套口径**，建议一并改成 DOM 口径（用页元素的 rect 判当前页）。**未实测**：偏差到底有多大取决于具体 PDF/布局。

---

## 5. 缩放步长与落盘（"缩放太慢"）

**结论：安全（步进逻辑正确、落盘抖动已修）；两条 P2（trackpad 过冲、极小页面的标签口径）。**

### 5.1 步进逻辑（`ReaderView.tsx:25-27、650-666`）

```ts
25: const ZOOM_STEPS = [0.25, 0.4, 0.6, 0.8, 1, 1.5, 2, 3, 4];   // 16 档 → 9 档
27: const WHEEL_ZOOM_RATIO = 1.15;
652:      const current = fit === 'manual' ? zoom : effectiveZoom;
653:      if (fine) { /* 滚轮：乘性 1.15，四舍五入到 1% */ }
659:      let index = ZOOM_STEPS.findIndex((v) => v >= current - 0.001);
660:      if (index < 0) index = ZOOM_STEPS.length - 1;
661:      const atStep = Math.abs(ZOOM_STEPS[index] - current) < 0.005;
662:      const target = atStep ? index + dir : dir > 0 ? index : index - 1;
663:      applyZoom(ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, target))]);
```

逐点核验（`current` = 手动档位或 fit 反算值）：

| 当前值 | `index` | `atStep` | `dir=+1` | `dir=-1` |
| --- | --- | --- | --- | --- |
| 1.0（手动，恰在档上） | 4 | true | 1.5 ✓ | 0.8 ✓ |
| 1.32（fit 反算，档间） | 5 | false | 1.5 ✓ | 1.0 ✓ |
| 1.6（档间） | 6 | false | 2.0 ✓ | 1.5 ✓ |
| 0.65（档间） | 3 | false | 0.8 ✓ | 0.6 ✓ |
| 0.25 / 4（两端） | 0 / 8 | true | 0.25 / 4（原地，无副作用） | — |
| 14.0（极小页 fit 反算，见 5.3） | 强制 8 | false | 4.0（== 实际渲染上限，视觉不变） | 3.0 ✓ |

**结论：不会跳过用户想停的档位**（每次恰好一格；档间值方向单调正确）；`fit === 'manual' ? zoom : effectiveZoom`（`:652`）语义保持，`applyZoom` 仍 `setFit('manual')`（`:635`）→ fit↔manual 自洽 ✓。两端再按是"原地重设同值"，只多一次 `setFit('manual')` 与一次防抖写，无副作用 ✓。

**取舍要说清**：16 档 → 9 档意味着 `0.33 / 0.5 / 0.67 / 0.75 / 0.9 / 1.1 / 1.25 / 1.75 / 2.5` 这些档位**不再能通过按钮/键盘精确到达**（例如想要 75% 只能落到 80%，或改用 Ctrl+滚轮的 1% 细步）——这是本轮"步子加大"的有意取舍，不是缺陷，但 `?` 面板与 README 里"放大 / 缩小"的表述没有提到细步只走滚轮。

### 5.2 落盘防抖（`:631-648、689-700`）

每步 `updateSettings({defaultZoom})` 改成 **350ms 防抖**（只写最后一个值），卸载时兜底 flush（`:690-700`，用 `useStore.getState().updateSettings`，不依赖闭包 ✓）→ "连续快速按导致 IPC/落盘/广播抖动"**已修** ✓。残留 P2：窗口直接退出（React 不卸载）或 `Ctrl+R` 重载时，最后 ≤350ms 的缩放偏好会丢（下次打开回到上一次落盘值）。

### 5.3 两条 P2

1. **trackpad 过冲 + 每个事件一次重渲染**：`WHEEL_ZOOM_RATIO = 1.15`，一次 wheel 事件 = ±15%；鼠标滚轮一格一次事件 → 1.0→4.0 约 11 格（合理），但触控板一次轻扫会发 20–60 个事件 → 1.15^n 仍会瞬间到顶/到底（4.0 需 ~10 个事件）。而且**每个 wheel 事件都会改一次 scale**，可见页的渲染 effect 随之重启（新任务先 `await prevTaskRef.current`，见 `PdfViewer.tsx:221`）→ 一次轻扫等于把可见页渲染反复取消重启几十次，反而可能比"大步档"更卡。**未实测**：建议桌面端用触控板按住 Ctrl 轻扫一次，看是否直接冲到 400%、以及缩放过程是否掉帧。**建议方向**：用 `requestAnimationFrame` 把同一帧内的多个 wheel 事件合并成一次步进（同时解决过冲与渲染抖动）。
2. **`effectiveZoom` 未做上限收敛**（`:126-138` 没有 `clampZoom`）：极小的页面在宽窗口里 fit-width 会算出 >4 的展示值（`PdfViewer` 侧渲染已被 `clampZoom` 限制在 4）。此时工具栏标签可能显示 >400%，而按 `+` 只会把它变成 400%（视觉不变）。属上一轮遗留的标签口径问题，**未实测**（需要极小页面样本）。

---

## 6. 侧栏设置与老 settings.json 兼容

**结论：安全（老文件、未知 key、启动回落三条都对）；一条 P2 健壮性缺口（非数组类型会白屏）。** 已按落地版复核：`shared/types.ts:163、191-196、315`、`Sidebar.tsx:39-41、55、80-92`、`SettingsView.tsx:29-45、380-397`。

### 6.1 老 `settings.json`（没有新字段）→ 默认 4 项，不崩 ✓

```ts
163: export type SidebarExtraFilter = 'unread' | 'toread' | 'annotated' | 'noted' | 'missing';
196:   sidebarExtraFilters: SidebarExtraFilter[];
315:   sidebarExtraFilters: [],            // DEFAULT_SETTINGS
```
加载路径一律是"默认值打底、老数据覆盖"：库快照 `settings: { ...DEFAULT_SETTINGS, ...data.settings }`（`core/library.ts:95-121`）、settings 文件 `{ ...library.getSettings(), ...raw }`（`core/host.ts:115-118`）→ 老文件缺这个字段时拿到 `[]` → `extraKeys = settings.sidebarExtraFilters ?? []`（`Sidebar.tsx:55`）→ `shown = lists.filter(base || extraKeys.includes(key))`（`:81`）→ **只显示 全部文献/最近添加/在读/星标 4 项** ✓ 不会"全部显示"，也不会因为 `undefined` 崩 ✓。

### 6.2 未知 key / 手改 json

- **塞进未知字符串**（`["bogus"]`）：`extraKeys.includes('bogus')` 对 `lists` 里任何一条都不成立 → **完全惰性，不崩、不显示** ✓；而且下一次在设置页拨动任意开关时，写入端会用白名单重排整个数组（`SettingsView.tsx:392` 的 `EXTRA_SIDEBAR_ORDER.filter(...)`）→ **垃圾值会被自动清掉** ✓。
- **写入端确实是白名单**：设置页只可能写出 `EXTRA_SIDEBAR_ORDER` = 那 5 个 key，且顺序固定（`SettingsView.tsx:30、390-393`）；类型上 `SidebarExtraFilter` 是 5 值联合（`types.ts:163`），`EXTRA_SIDEBAR_LABELS/HINTS` 用 `Record<SidebarExtraFilter, string>` 收口 → 以后加 key 漏文案会编译不过 ✓。
- **P2｜非数组类型会白屏**（手改 json 的另一种手滑）：`"sidebarExtraFilters": 42` 时 `extraKeys.includes` 不是函数 → TypeError。`Sidebar.tsx:81`（以及 `SettingsView.tsx:382/388/390`）都会抛；渲染层**没有错误边界**（全仓 grep `componentDidCatch|ErrorBoundary|getDerivedStateFromError` 无命中）→ React 18 卸载整棵树 → **白屏，必须手改回 json 才能启动**。`"unread"` 这种字符串则会被 `String.prototype.includes` 当子串匹配（`"unread,toread"` 会误开两项），行为意外但不崩。**最小复现**：退出应用 → 编辑 `%APPDATA%\文献架 LitShelf\settings.json` 把该字段改成 `42` → 启动 → 白屏。**建议**（一行）：读取处用 `Array.isArray(x) ? x : []`，或在 `library.revive` 里做一次类型归一。**未实测**（未启动 Electron，结论由 JS 语义与"无错误边界"推得）。

### 6.3 "当前筛选被隐藏时回落"不会误触发 ✓

```ts
86:  useEffect(() => {
88:    if (state.view !== 'library') return;
90:    if (!SIDEBAR_LIST_KEYS.has(kind)) return;      // 标签/文件夹筛选不在此列
91:    if (!shownKey.split(',').includes(kind)) state.setFilter({ kind: 'all', label: '全部文献' });
92:  }, [shownKey]);
```

- **启动时不会误触发**：`filter` 根本不持久化（`state/store.ts:143` 初始恒为 `{kind:'all'}`，`Settings` 里没有 filter 字段）→ 冷启动时 `kind === 'all'`，而 `all` 永远在可见集合里 → 第 91 行不成立 ✓。
- **不会打断正常切换**：deps 只有 `shownKey`（可见 key 拼串），切换筛选不改它 → 不会在用户点筛选时把状态改回去 ✓；标签/文件夹筛选被 `SIDEBAR_LIST_KEYS` 排除 ✓。
- **"藏掉当前筛选"的路径也收得住**：Sidebar 只挂在 `LibraryView`（`LibraryView.tsx:57`；App 只在 `view==='library'` 渲染 LibraryView）→ 在设置页拨开关时 Sidebar 是**卸载**状态，effect 不跑（`:88` 让出）；用户回到文献库时 Sidebar **重新挂载** → effect 在挂载时跑一次 → 此时 `view==='library'` ✓ → 把已隐藏的筛选回落成「全部文献」✓。**这条"靠挂载时机兜住"的设计很脆**（以后若把 Sidebar 提到 App 层常驻，`view` 又不在 deps 里，就会出现"看不见的激活筛选"），建议把 `view` 加进 deps。

---

## 7. 可发现性（把导航藏进设置之后）

**结论：设置页文案到位（安全）；侧栏一侧有可发现性落差（P2）。**

- 设置页有一组明确的说明与开关（`SettingsView.tsx:379-398`）：
  - 标题：「**侧栏显示的其它筛选**」
  - 说明：「侧栏默认只有 全部文献 / 最近添加 / 在读 / 星标；**勾选下面的项目会把它们追加到侧栏**」← 正是"勾选后出现在左侧栏"的语义 ✓
  - 进度提示：「n/5 项已显示」（`:381-383`）
  - 每项都有中文名 + 一句用途（`:32-45`，如「有批注：至少有一条批注或书签」「文件缺失：有文件缺失时才出现」）✓
- **落差（P2）**：老用户升级后，侧栏里原来就有的 未读/待读清单/有批注/有笔记（以及有缺失时的「文件缺失」）会**直接消失**，而侧栏内部**没有任何"更多筛选…"入口**或一次性提示指向设置；不主动进设置的用户会以为功能被删了。建议二选一：① 侧栏列表末尾加一个「更多筛选…」按钮（跳 `setView('settings')` 并定位到该分组）② 升级后首次进入文献库给一次 toast/角标提示。**未实测**（观感）。
- 另注：`文件缺失` 是条件项（`Sidebar.tsx:69-78`，只有 `counts.missing > 0` 才进列表）——即使用户在设置里勾了它，没有缺失文件时也不会出现 ✓ 与设置页的 hint 一致 ✓。

---

## 8. 新增监听器 / 定时器 / 异步队列的泄漏

**结论：有风险（一处未受控的定时器链 → §4.2 的窄窗口竞态）；其余安全。**

| 新增物 | 位置 | 生命周期 | 判定 |
| --- | --- | --- | --- |
| `zoomWriteTimer`（350ms 防抖写设置） | `ReaderView.tsx:103、638-645` | 每次调用先清旧、卸载时清除并 flush（`:690-700`） | 安全 |
| 缩略图串行队列 `queueRef` + `cacheRef` | `ReaderPanels.tsx:441-443、499-510` | 换文档/卸载清空；任务有 `cancelled`/`docId` 双闸 | 安全（22:11 版已把"作废即删缓存"补上，见 §2.2） |
| 缩略图 `IntersectionObserver` | `ReaderPanels.tsx:456-474` | cleanup `disconnect()` | 安全 |
| **跳页重试链 `align()` 的 setTimeout** | `PdfViewer.tsx:722-736` | **无人跟踪、不随卸载/新调用取消**；快路径 ~80ms、慢路径 ≤8×60ms | **有风险（窄窗口）**：会把用户的后续跳页/滚动拽回（§4.2）；卸载后只是空转（`el.scrollTo` 落在脱离文档的元素上，不写 state、不报错），闭包保留到定时器触发为止 |
| `window` keydown / `wheel` 监听 | `ReaderView.tsx:675-687` 等 | 均有 cleanup | 安全（都在渲染进程内，与 Electron 单实例无关） |
| Sidebar / SettingsView 本轮新增 | `Sidebar.tsx:86-92`、`SettingsView.tsx:379-398` | 只多了一个 store 订阅与一个 effect（无定时器/无监听器） | 安全 |

**未实测**：`align` 竞态的实际观感需要桌面复现（步骤见 §4.2）。

---

## 9. 本轮四个用户报告 bug 的落实情况（逐条核对）

| 用户报告 | 本轮做法 | 复核结论 |
| --- | --- | --- |
| 选区**反选** | `clampSelection` 的方向改用鼠标位移判定 + probe 方向校验（`PdfViewer.tsx:850-853、880-895`） | **已修**。反选/夹空两条路径都有防线（§1）；残留同类观感问题只有"页外松手兜底到页首/页末"（P2-1） |
| 缩略图**无预览** | `ReaderPanels.tsx:417-433` 每页真渲染 132px JPEG + 懒加载 + 串行队列 | **已修**，且初稿报出的"作废即永久占位"缺陷已在 22:11 版修掉并复核通过（§2.2） |
| 缩略图**点击不灵/跳错页** | `goToPage` 改为按真实 DOM rect 对齐（`PdfViewer.tsx:712-720`），虚拟化用 ghost 槽位兜底 | **单次跳页已修**（三布局静态推演均正确，§4.1）；残留"前后两次跳页互相顶"的窄窗口竞态（P2-0）与"报页仍用估算几何"的口径不一致（P2-2） |
| 缩放**太慢** | 档位 16→9（`ReaderView.tsx:25`）、滚轮改乘性细步 1.15（`:27、655-656`）、设置写入 350ms 防抖（`:636-645`） | **已修**。步进不跳档、fit↔manual 自洽、落盘抖动消除（§5）；残留 trackpad 过冲（P2-5）与 ≤350ms 偏好丢失（P2-6） |
| 左侧导航**太挤** | 默认 4 项 + `sidebarExtraFilters` 白名单（`types.ts:163/315`、`Sidebar.tsx:39/81`、`SettingsView.tsx:379-398`） | **已修**，老 settings.json 兼容与回落逻辑都正确（§6）；残留可发现性落差（P2-11）与非数组类型白屏（P2-12） |

`reader.css` 本轮 mtime 未变（仍是 20:58 版），任务描述里"提速可能在 reader.css"没有实际发生 → 无需复核前两轮的 `user-select` / `pointer-events` 敏感规则（未动）。

---

## 10. 建议优先级清单（P0/P1/P2）

**P0：无**（未发现崩溃、数据损坏、批注/进度丢失或不可恢复状态；非数组 settings 白屏需手改 json，见 P2-12）。

**P1：无。** 初稿报出的唯一 P1（缩略图作废即永久占位）已在 22:11 版本修复，且本报告复核了修法没有引入新竞态（§2.2）。

**P2**
| # | 问题 | 依据 |
| --- | --- | --- |
| P2-0 | 前一次跳页的 80ms 复校/重试会把后一次跳页顶回旧目标（窗口约 80–140ms，需连点/连按；连按时伴随 100ms 级画面抖动） | `PdfViewer.tsx:722-736` |
| P2-1 | 页外松手时兜底夹到"页首/页末"（横向反向拖到灰边会多选大半页） | `PdfViewer.tsx:895` |
| P2-2 | 跳页后紧接着的 scroll 用估算几何回写页码，可能把精确跳转的页码"纠正"回去（跳页已 DOM 化、报页未改） | `PdfViewer.tsx:635-645` vs `:706-710` |
| P2-3 | 跳页后 80ms 会再写一次同样的 scrollTop，可能把用户这期间的微调滚动拽回 | `PdfViewer.tsx:722-724` |
| P2-4 | 缩略图缓存的 dataURL **无上限、无淘汰**（300 页约 1–2 MB、1000 页扫描件 8–16 MB，常驻到切 Tab/关面板） | `ReaderPanels.tsx:439、478-484` |
| P2-5 | trackpad Ctrl+滚轮仍可能一次轻扫冲到 400%/25%（乘性 1.15/事件、无时间节流），且每个 wheel 事件都会触发一次可见页重渲染 | `ReaderView.tsx:27、655-656、675-687` |
| P2-6 | 最后 ≤350ms 的缩放偏好在"窗口直接退出 / Ctrl+R 重载"时丢失 | `ReaderView.tsx:638-645、690-700` |
| P2-7 | `effectiveZoom` 未收敛到 4：极小页面 fit 模式下标签可显示 >400%，按 `+` 只把标签变成 400% | `ReaderView.tsx:126-138` |
| P2-8 | 本轮四个修复**零自动化覆盖**：`acceptance-ux.mjs`（21:31 版）无 thumb / jump / zoom 用例 | `tools/acceptance-ux.mjs` |
| P2-9 | 文本版阅读器仍显示「缩略图」Tab 且 `totalPages=1`（点击无意义、会白占一栏） | `ReaderView.tsx`（`totalPages`）+ `ReaderPanels.tsx:60、83` |
| P2-10 | 中键在页面区域仍被 `preventDefault`（Windows 中键自动滚动失效）——上一轮遗留 | `PdfViewer.tsx:1030-1033` |
| P2-11 | 侧栏藏项后**侧栏内没有任何入口/提示**指向设置（老用户会以为功能被删） | `Sidebar.tsx:80-92`、`SettingsView.tsx:380` |
| P2-12 | `sidebarExtraFilters` 被手改成**非数组**（如 `42`）→ `extraKeys.includes` TypeError → 无错误边界 → **白屏**；字符串则被子串误匹配 | `Sidebar.tsx:55、81`、`SettingsView.tsx:382/388/390`（建议 `Array.isArray` 守卫） |

**给 verifier 的补测建议（本轮无脚本覆盖）**：① 缩略图快刷后"可见页都有图"（复用 `acceptance-ux.mjs:145` 的 `buildPdf(300)` 造 300 页单文件）；② 缩略图极快连点两页，最终落点 = 最后一次点击；③ 三种布局（单/双/连）下点缩略图/目录项/搜索命中的落点与页码指示一致性；④ `Ctrl+=` 连按 5 次的档位序列（0.8→1→1.5→2→3→4）与 `defaultZoom` 在 350ms 后**只写一次**（可用 `getSnapshot().settings.defaultZoom` + 宿主流水）；⑤ 老 `settings.json` 三种情况：删掉新字段（应只显示 4 项）、字段为 `[]`、字段塞未知 key（应惰性且不崩）；⑥ 把该字段改成 `42` → 记录白屏现象（P2-12 的判定）。

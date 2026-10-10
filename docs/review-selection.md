# 对抗式复盘：划词 / 缩放 / 浮层改动的回归审查

- 审查人：reviewer（对抗式审查，**只读不改**）
- 审查对象：本轮"中文划词乱选 / 拖到空白全选 / Ctrl+滚轮缩放"改动
- 交付物：本文件。写作用域仅 `docs/review-selection.md`；未修改任何 `src/**`、`tools/**`、`tests/**`、`README.md`。

## 0. 方法与限制（先说清楚哪些是真验过的）

| 项 | 说明 |
| --- | --- |
| 验证方式 | **只读静态审查 + 代码路径推理**。逐行读了 `PdfViewer.tsx`(1054 行)、`reader.css`(2056 行)、`ReaderView.tsx`(1361 行)、`App.tsx`、`SelectionToolbar.tsx`、`AnnotationLayer.tsx`、`TextReader.tsx`、`EpubReader.tsx`、`ImageReader.tsx`、`host.ts`、`library.ts`、`store.ts`、`hooks.ts`、`main/index.ts`、`core/sample.ts`、`tools/acceptance*.mjs`、`node_modules/pdfjs-dist/build/pdf.mjs`、`node_modules/electron/electron.d.ts`。 |
| 未做 | **未启动 Electron**（另一队友在跑桌面验收，会撞单实例锁）。因此所有"浏览器行为"（`caretRangeFromPoint` 的吸附规则、原生选区在空白处的延伸范围、菜单加速键是否吞键）**标为"未验证"并给出桌面复现步骤**，不写成结论。 |
| 无历史对比 | 仓库**不是 git 仓库**（`git log` → `fatal: not a git repository`），`dist/` 也是本轮改完后（20:25）才构建的，`tmp/` 只有数据文件没有源码备份。**无法做"改动前/改动后"逐行 diff**，下文结论一律是"当前代码状态的正向核验"；涉及"以前怎样"的推断都以文件 mtime 作旁证并明确标注。 |
| mtime 旁证 | 本轮改动集中在 19:27–19:42：`reader.css` 19:27、`PdfViewer.tsx` 19:28、`SelectionToolbar.tsx` 19:32、`ReaderView.tsx` 19:42、`App.tsx` 19:42；`host.ts` 19:01、`main/index.ts` 18:55 更早（属前序改动，但任务要求一并审）。 |
| 判定词汇 | **安全**＝代码路径可证明无回归；**有风险**＝代码路径存在可疑分支，但触发与否依赖浏览器行为/夹具，已给最小复现步骤；**已确认缺陷**＝不依赖浏览器细节即可从代码证明的错误结果，附可复现步骤；**未验证**＝结论需要桌面实测，写明原因。 |

---

## 1. 起点在页面文本层、终点落在另一页文字上（跨页复制）

**结论：已确认缺陷（P1）。跨页拖选会被强制收回到"按下所在页"，用户无法再用拖选跨页复制文字。**

依据 `src/renderer/reader/PdfViewer.tsx:783-822`（`clampSelection`）：

```ts
794:      const movingEndSpan = elOf(anchorIsStart ? range.endContainer : range.startContainer)?.closest('.rd-pdf-text span');
795:      const movingEndInside = !!movingEndSpan && anchorPage.contains(movingEndSpan);
797:      const caret = textCaretAt(clientX, clientY);
798:      if (movingEndInside && caret?.inText && (!caret.pageEl || caret.pageEl === anchorPage)) return;
...
805:      const caretPos =
806:        caret?.inText && caret.pageEl === anchorPage
807:          ? { node: caret.range.startContainer, offset: caret.range.startOffset }
808:          : null;
809:      const target = caretPos ?? (anchorIsStart ? lastPos : firstPos);
...
820:      sel.removeAllRanges();
821:      if (!clamped.collapsed) sel.addRange(clamped);
```

推理链（**每一步都由代码确定，不依赖浏览器细节**）：

1. 从第 1 页文字按下 → `dragRef.inPage = true`（`PdfViewer.tsx:869-874`），不会被 835 行的"起点在页面外"分支清掉。
2. 拖到第 2 页文字上松开：`onUp` 的 `scrollRef.current.contains(target)` 成立（第 2 页在滚动容器内），继续往下走（`PdfViewer.tsx:824-845`）。
3. `movingEndInside` 为 **false**（移动端 span 属于第 2 页，`anchorPage.contains()` 不成立，795 行）→ 798 行的"原样保留"提前返回不生效。
4. 806-808 行要求 `caret.pageEl === anchorPage` 才使用光标位置；此时光标在第 2 页文字上，`caretPos = null`。
5. 809-811 行退化为 `target = lastPos`（向下拖）→ `clamped` 的两个端点（`anchorPos`、`lastPos`）**都在第 1 页**（`edgeTextPos` 只在 `anchorPage` 内查询，764-771 行）。
6. 820-821 行 `removeAllRanges()` 后 `addRange(clamped)` → 浏览器原有的（可能跨两页的）选区被**替换**为只含第 1 页的 range。

即：**最终选区必然只含按下那一页的文字**，与用户的落点无关。另注：即使不夹取，`collectSelection` 也明确拒绝跨页建批注（`PdfViewer.tsx:687-689`），所以这次夹取对"建批注"没有增益，只破坏了"跨页复制"。

**最小复现步骤（桌面端）**

1. 打开示例库里 7 页的 `Vaswani et al. - 2018 - Transformer Architectures Survey.pdf`（路径 `%USERPROFILE%\Documents\文献架示例文献`，见 `src/main/ipc.ts:185`、`src/core/sample.ts:116-121`），布局用「连」（连续滚动）。
2. 鼠标在第 1 页**最后一行文字**上按下，按住往下拖，拖过页间灰缝，落在**第 2 页第一行文字**上，松开。
3. 观察：选区只剩第 1 页文字，第 2 页文字没被选中（`window.getSelection().toString()` 不含第 2 页内容），且划词工具条不弹出。
4. 期望（Word / Chrome / 上一版的语义）：两页文字同属一个选区，Ctrl+C 可同时复制。
5. 机器判据（可复用 `tools/acceptance-cjk.mjs:170-182` 的 `selectionInfo()`）：`range.intersectsNode(page2El)` 应为 `true`，实际为 `false`。

**验收覆盖缺口**：现有用例结构上抓不到这一条——中文夹具 `tools/make-cjk-pdf.mjs:102` 是单页（`/Count 1`），而 `tools/acceptance-cjk.mjs:277-278` 的断言是反方向的：

```js
ok(nativeSel.pages.length <= 1, `拖进空白处：原生选区只在 ${nativeSel.pages.length} 页内（>1 页就是"全选"）`);
```

"拖到另一页文字上"这一手势**没有任何用例**（见 §11）。

---

## 2. 反向拖选（从下往上、从右往左）

**结论：分三种情形——竖直反向：安全；横向右→左落在页边/页外：有风险；夹取结果折叠时清空选区：已确认缺陷（P2）。**

**(a) 从下往上（同一页内松开在文字上）：安全。**
`caret.inText && caret.pageEl === anchorPage` → 798 行提前返回，不夹取。

**(b) 从下往上、松开在页面外（页外空白/页间灰缝）：端点对称正确。**
锚点在下方，`range.startContainer` 是上方的焦点，因此 `anchorIsStart = false`（787 行）→ `target = firstPos`（809 行）→ `start = firstPos`、`end = anchorPos`（810-811 行），range 顺序合法且方向正确（夹到本页第一个文字）。这一段是对的。

**(c) 从右往左（横向反向）：与"从下往上"共用同一分支 → 被夹到"本页第一个文字"。有风险。**
依据同一段代码：方向判定只看 **DOM 顺序**（`anchorIsStart`），完全不看松手点在页面上的**位置**：

```ts
809:      const target = caretPos ?? (anchorIsStart ? lastPos : firstPos);
```

当松手点没命中文字（`caret.inText === false`，752-761 行的 `span` 判定失败）时，横向右→左的内拖会被当成"往上拖"，端点取"本页 DOM 序第一个文字"（通常是页首左上第一行），于是选区可能从**页首**一路连到按下点，而不是"松手点左侧最近的文字"。

- 触发前提：松手点下 `document.caretRangeFromPoint` 返回的容器不是 `.rd-pdf-text span`（`PdfViewer.tsx:752-761`）。页边 28px 灰边内（`reader.css:518-522` 的 `padding: 28px`）、页间 20px 灰缝（`gap: 20px`）都满足"不是 span"，此时 `pageEl` 也常为 `null`（页外），`caretPos` 必为 `null`。
- **这一条我给"有风险"而不是"已确认缺陷"**：若 Chromium 在页边返回的是最近文字（`inText === true` 且 `pageEl === anchorPage`），806-808 行会走 `caretPos`，就不会过度夹取。这一点我**未验证**（未启动浏览器/Electron）。

**最小复现步骤（桌面端，判定用）**

1. 打开任一有文字的 PDF，缩放到 100%+（保证页左右有灰边）。
2. 在某一行文字的**右端**按下，按住往**左**拖，越过文字左端、进入页面左侧灰边（不要进右侧面板），松开。
3. 记录 `window.getSelection().toString().length` 与选区首端所在行。
   - 若首端 = 按下行（或该行附近）→ 行为正确，本条降级为安全；
   - 若首端 = **页面第一行/页首**，选区变成"整页大半" → 过度夹取（缺陷），需要按 §12 的建议改端点选择策略。

**(d) 夹取结果折叠时会清空选区：已确认缺陷（P2）。**
`PdfViewer.tsx:820-821` 先清空再加回，且加回带 `!clamped.collapsed` 判断：

```ts
820:      sel.removeAllRanges();
821:      if (!clamped.collapsed) sel.addRange(clamped);
```

当 `target` 恰好等于锚点位置时（`clamped.collapsed === true`），结果是**选区被彻底清掉**，而不是"保持不变"。

**最小复现步骤**：在页面**第一行第一个字**上按下 → 按住往上拖出页面顶部（进入滚动容器上方的灰边）→ 松开。
推演：锚点已是 `edgeTextPos(page,'first')` 的位置，`anchorIsStart = false` → `target = firstPos` = 锚点 → 折叠 → 820 行清空选区。期望：至少保留原选区（或等价的最小选区）。

---

## 3. 键盘选择（Shift+方向键、Ctrl+A）

**结论：安全（无回归）。`clampSelection` 完全不参与键盘路径，不会出现"键盘选择被夹坏/夹空"；"全选到文档末尾"不会因键盘出现。**

依据：

- `clampSelection` 唯一的调用点在 `onUp`：`PdfViewer.tsx:845`（`if (sel && !sel.isCollapsed) clampSelection(...)`）。键盘路径只走 `onKeyUp`：

```ts
862:    const onKeyUp = (ev: Event) => {
864:      if (ke.shiftKey || ke.key === 'Shift') window.setTimeout(collectSelection, 10);
```

- `Ctrl+A` 的 keyup 不带 `shiftKey` → **不触发 `collectSelection`**（`PdfViewer.tsx:683-693`），因此不会给跨页选区弹工具条，也不会因此建错批注。
- `Ctrl+A` / `Shift+方向键` 的原生选区范围由浏览器决定，但 `.rd-pdf-scroll`、`.rd-page-slot` 都是 `user-select: none`（`reader.css:325-327` 的注释与 510-543 行 section 无 `user-select`，继承 `tokens.css:141` 的 `body { user-select: none }`），可选文字只存在于 `.rd-pdf-page`/`.rd-pdf-text`（`reader.css:329-337、569、589`），因此不存在"一路选到滚动容器末尾"的容器级失控。

**关联发现（P2，非本轮新引入、无法确认新旧）**：跨页的键盘选区到达 `collectSelection` 时会在 689 行直接 `return`，**既不给新工具条、也不清掉上一次的工具条**，于是工具条可能停留在上一次选区的文字上（与 §10·E1 是同一类"陈旧工具条"问题）：

```ts
689:      if (!startEl || startEl !== endEl) return; // 跨页选择暂不支持建批注
```

**未验证**：原生 caret 在 `user-select: none` 兄弟节点间的跳转细节（例如 `Shift+↓` 在页末是否直接跳到下一页首字），需要浏览器实测；不影响本条的"无夹取回归"结论。

---

## 4. 旋转 90/270 的页面（PDF `/Rotate`）

**结论：坐标层安全；端点语义有风险；整体未实测（仓库无旋转样本）。**

**(a) 坐标一致性：安全（有据）。** 画布与文本层用的是**同一个 viewport**：

```ts
212:      const viewport = page.getViewport({ scale });          // 画布
242:          viewport: page.getViewport({ scale }),             // 文本层
282:        ['--total-scale-factor' as string]: String(scale),   // 文本层字号/位移基准
```

`page.getViewport({scale})` 已把 `/Rotate` 计入（`pdf.ts:103-104` 也是用 `getViewport({scale:1})` 得到的 `width/height/rotation` 做尺寸预算），所以旋转页上"文本层坐标 ↔ 画布"是一致的；而夹取/命中全部基于 `getBoundingClientRect()` 与 `clientX/clientY`（`PdfViewer.tsx:734-737、826-828`），与页面是否旋转无关。

**(b) 端点语义：有风险。** `edgeTextPos` 取的是 **DOM 顺序**的首/末 span：

```ts
764:    const edgeTextPos = (pageEl: HTMLElement, which: 'first' | 'last'): { node: Node; offset: number } | null => {
765:      const spans = [...pageEl.querySelectorAll<HTMLElement>('.rd-pdf-text span')].filter((s) => (s.textContent ?? '').length > 0);
767:      const span = which === 'first' ? spans[0] : spans[spans.length - 1];
```

而 pdf.js 的 TextLayer 是**按 items 顺序 append**、不做版面排序的（`node_modules/pdfjs-dist/build/pdf.mjs:14506-14538` 的 `#processItems`/`#appendText`，`14575: textDiv.textContent = geom.str`）。因此"本页第一个/最后一个 span"= 内容流首/末项，**未必是视觉上的首/末行**。这一事实与是否 `/Rotate` 无关，但在旋转页上更容易与直觉不符（旋转只是把整页做了刚体变换，流顺序通常仍是阅读顺序，但不保证）。

**未验证及原因**：仓库里没有 `/Rotate` 样本——`tools/make-cjk-pdf.mjs:96-107` 生成的夹具是 `MediaBox [0 0 595 842]`、无 `/Rotate`、单页；桌面验收脚本也没有旋转用例。没有浏览器我无法造/看渲染结果。

**建议的桌面复核**：用外部工具生成一个 `/Rotate 90` 的两栏 PDF，做"从第一行往下拖出页面底部"，看夹取端点落在哪一行（判据：选区首行是否视觉第一行）。

---

## 5. RTL / 竖排文本

**结论：有风险（未实测）。会"夹成空"的唯一路径与 §2(d) 相同；RTL/竖排的主要问题是方向映射错误导致过度夹取。**

- 方向判定用 **DOM 序**（`PdfViewer.tsx:787` 的 `anchorIsStart`、809-811 的 `first/last`），而 RTL 的"可视方向"与"逻辑方向"相反：右→左拖 = 逻辑向前，但代码把它归入 `anchorIsStart === false` 分支 → 夹到**逻辑第一个位置**（页首段首），结果是"从段首到按下点"的一大段，而不是用户想要的一小段。
- 竖排（`pdf.js` 有 `style.vertical` 处理，`pdf.mjs:14553-14555`）同理：DOM 序 = 列序，横向拖出页面被当成"向上拖"，端点取第 1 列。
- **不会**因为 RTL 而抛异常或必然变空：`Range.setStart/setEnd` 不关心 `dir` 属性（pdf.js 会把 `geom.dir` 写到 span 上，`pdf.mjs:14576`），唯一的"变空"路径是 §2(d) 的 `anchor === target` 折叠，与文字方向无关。

**未验证及原因**：仓库内没有 RTL/竖排夹具（中文夹具是横排左起），也未启动 Electron 实测。判定方法：若拿到 RTL/竖排 PDF，重复 §2(c) 的判定（松手在页边，看选区首端是"逻辑首"还是"松手点附近的文字"）。

---

## 6. 文字版 / Markdown / EPUB / 图片：收窄 CSS 后框选是否仍可用

**结论：安全。收窄只放开了"承载文字的元素"，四类阅读器的正文仍然可选；图片阅读器不适用。**

依据（当前状态正向核验）：

```css
/* reader.css:329-337 —— 收窄后的白名单 */
.rd-pdf-page,
.rd-pdf-text,
.rd-text-inner,
.rd-html-body,
.rd-epub-body,
.markdown-body { user-select: text; -webkit-user-select: text; }
```

- **文字版 / Markdown / HTML / docx**：`TextReader.tsx:249-297` 的结构是 `.rd-text-scroll > .rd-text-inner > .rd-read-surface（surfaceRef）> .rd-html-body`；`.rd-text-inner` 在白名单里（331 行），而真正兜住内容的 `.rd-read-surface` 另有独立规则 `reader.css:1592-1597 { user-select: text }`，`.markdown-body` 也有（`styles/app.css:1649-1654`）。→ 框选可用。
- **EPUB**：`EpubReader.tsx:182-186` 的结构是 `.rd-epub-scroll > .rd-epub-inner > .rd-html-body.rd-epub-body`；`.rd-epub-body`（`reader.css:2024-2026`）与 `.rd-html-body`（白名单 332 行）双重覆盖。→ 框选可用。
- **图片**：`ImageReader.tsx` 无文本层，`.rd-image-canvas img { user-select: none; -webkit-user-drag: none }`（`reader.css:1890-1891`）保持不变。→ 不适用（无文字可选）。
- 这些阅读器**不走** PdfViewer 的 clamp（`TextReader.tsx:197-211` 只做 `mouseup/keyup → collectSelection`，无夹取），所以 §1/§2 的夹取缺陷不会外溢到它们；同时因为滚动容器不再可选，它们的"拖到空白处"范围被限制在 `.rd-read-surface` 内，属于改善而非回归。

**限制声明**：仓库无 git 历史，**无法逐行对比"收窄前"**（是否删掉了某条旧规则不可考），本结论只保证"当前状态下正文元素仍显式放开可选"。若要更稳，可在桌面验收加一条断言：`getComputedStyle(document.querySelector('.rd-read-surface')).userSelect === 'text'`（其余阅读器同理）。

---

## 7. 批注层 `pointer-events: none` 之后

**结论：有风险。"点高亮开卡片"仍可用（几何命中已覆盖），note pin 仍可点，但 `!` 角标与 hover/tooltip 两处交互被削弱/失效。**

依据：

```css
/* reader.css:621-629 */
.rd-pdf-page .rd-ann { pointer-events: none; cursor: text; }
/* reader.css:696-710 */
.rd-note-pin { position: absolute; ... pointer-events: auto; ... }
```

- **单击高亮开卡片：仍可用（安全）。** 点击不再由 DOM 派发，改由 `PdfViewer.tsx:731-746` 的几何命中，容差 `±0.004`（0.4% 页宽）：

```ts
739:      for (let i = list.length - 1; i >= 0; i -= 1) {
741:        if (a.rects.some((r) => x >= r.x - 0.004 && x <= r.x + r.w + 0.004 && y >= r.y - 0.004 && y <= r.y + r.h + 0.004)) {
```

  叠放语义与旧 DOM 行为**等价**：`AnnotationLayer.tsx:120-138` 按数组顺序渲染（后者绘制在上），而命中是"从数组末尾往前找"（739 行），与浏览器取最上层命中的结果一致。验收也是真实鼠标（`tools/acceptance.mjs:465-482`），不是 `.click()`，所以这条有真实验证。

- **note pin：仍可点（安全）。** `NotePin` 直接挂在 `.rd-ann-layer` 下（`AnnotationLayer.tsx:118-124`），class 为 `rd-note-pin`（**不含** `rd-ann`），因此不受 `.rd-pdf-page .rd-ann` 规则影响，且自身 `pointer-events: auto`（`reader.css:704`）——父层 `.rd-ann-layer { pointer-events: none }`（602-607）可被子元素重新打开，这是标准行为。
- **`!`（needsReview）角标：命中面积被削（有风险）。** 角标 `.rd-ann-flag` **没有自己的 `pointer-events`**（`reader.css:679-694`），因此继承父级 `none`；且它定位在矩形**外部**：

```css
680:  top: -7px;  682:  right: -7px;  683:  width: 13px;  684:  height: 13px;
```

  几何容差只有 0.4%（595px 页宽 ≈ 2.4px），角标却有 7px 露在矩形右上角之外 → **角标外侧那半圈（约 7px 条带）点不到**；角标左下角落在矩形+容差内，仍能命中。旧代码里角标继承 `.rd-ann { pointer-events: auto }` 且点击会冒泡到父 `.rd-ann` 的 `onClick`，所以"点角标也能开卡片"是**缩小了**，不是全丢。
  **最小复现**：造一条 `needsReview` 批注（改文件内容触发重定位失败）→ 点角标**外半部分**（右上方向约 5-7px 处）→ 无反应；点角标左下部分 → 打开卡片。
- **hover 反馈与 tooltip 失效（有风险，观感类）。** `.rd-ann:hover { box-shadow: ... }`（`reader.css:666-668`）与 `title={annotation.text}`（`AnnotationLayer.tsx:47、60、73`）都依赖元素被命中；`pointer-events: none` 后二者在 PDF 页内不再生效（`cursor` 变成 `text` 是刻意的）。判定为**设计取舍**，但用户会丢失"这行有批注"的悬停提示。
- 其他依赖点击 `.rd-ann` 的地方：全仓检索只有 `App.tsx:190` 的 `querySelector`（判浮层存在性，不点击）与 `tools/acceptance.mjs:456` 的存在性断言 → **没有别处依赖点击 `.rd-ann`**；文字版/EPUB 的 `.rd-ann` 不在 `.rd-pdf-page` 下，保持 `auto`，DOM 点击路径不变（`TextReader.tsx:290-295`）。

---

## 8. `setProgress` 广播后：滚动抖动 / 循环 / sel·zoom 被重置

**结论：安全（无抖动、无回写环、不重置选区与缩放）。仅有一条性能注记（P2）。**

依据与推理：

1. `host.ts:1284-1296` 新增广播：
```ts
1295:    if (updated) this.emitItems([updated]);
```
2. 渲染层只做对象替换：`state/store.ts:216-232`（`items:patch` → 重建 `byId/items` 两个容器，不触碰 `settings`、`readerId`、UI 状态）。
3. 阅读器的"换文档重置"effect 只依赖 **id + revision**：
```ts
171:  }, [item?.id, item?.revision]);
```
   而 `patchItem` → `apply` 只做 `Object.assign(item, patch)`（`library.ts:578、584-588`），`revision` 只在**文件内容变化**时 +1（`library.ts:284-296`）→ 进度广播**不会**触发 `setAnnotations([])`/`setSelectedAnn(null)`/`setPending(null)`/`setPage(restored)`/`setZoom(...)`（`ReaderView.tsx:149-171`）。
4. 不存在"写进度 → 事件回灌 → 再写"的环：没有任何 effect 监听 `item.progress` 去调 `api.setProgress`。两个依赖整个 `item` 对象的 effect 都有一次性闩：
   - 缩略图 `ReaderView.tsx:336-342`（`thumbStarted`）；
   - 重定位 `ReaderView.tsx:300-332`（`reanchorStarted`）。
5. 不会滚动抖动：PDF 布局 memo 的依赖不含 `item`（`PdfViewer.tsx:357-397、526-533`），`PdfPage` 是 `memo`（149 行）且所有回调都是稳定 `useCallback` → 广播只带来一次廉价重渲染，不重建 DOM、不写 `scrollTop`、不重跑 `goToPage`（641-651 行的 effect 依赖 `[sizesReady, outline.layout, outline.fit]`）。
6. 唯一需要注意的是 `onSelection` 是 ReaderView 的内联箭头（`ReaderView.tsx:1128-1134`），会让 PdfViewer 的选区监听 effect（`PdfViewer.tsx:725-889`）在每次 ReaderView 重渲染时**解除再挂载**；因为 `dragRef`/`lastSelectionRef` 是 ref（666-673），且 `mouseup` 才读它们，所以不会丢状态。但这条"依赖内联箭头才能挂对节点"的巧合见 §10·E6。

**P2 注记（性能，非缺陷）**：进度每 ≤800ms 落盘一次（`hooks.ts:68-99` 的 800ms 防抖 + `PdfViewer.tsx:575-596` 的 rAF/160ms idle 上报），每次都会多一次 IPC 广播 + 全量 `items` 数组替换 → 列表与阅读器各重渲染一次。万级条目下值得在验收里看一眼滚动帧率是否受影响。

**P2 注记（同源老问题）**：`saveProgress` 用**闭包里的 `item`** 做乐观写回（`ReaderView.tsx:174-185`）；防抖窗口内若刚好收到广播，`patchLocal` 可能用旧快照覆盖刚更新的字段（`useLatest` 只保证取到"最近一次渲染"的闭包，`hooks.ts:41-47`）。概率低、影响面小（进度/readState 会被下一次写入纠正），列出仅备观察。

---

## 9. `LITSHELF_DATA_DIR` 指向不存在 / 只读路径

**结论：安全（两种情况都是可预期的降级：不存在则创建；不可创建则静默回退到默认目录；存在但只读则在启动阶段明确报错退出，不会静默写坏）。附两条 P2 提示。**

依据 `src/main/index.ts:56-65`：

```ts
56: app.setName(APP_NAME);
57: try {
58:   const override = process.env.LITSHELF_DATA_DIR?.trim();
59:   const userDataDir = override ? path.resolve(override) : path.join(app.getPath('appData'), APP_NAME);
60:   fs.mkdirSync(userDataDir, { recursive: true });
61:   app.setPath('userData', userDataDir);
62:   if (override) console.log(`[litshelf] 使用自定义数据目录：${userDataDir}`);
63: } catch (err) {
64:   console.error('[litshelf] 设置 userData 目录失败，回退到 Electron 默认目录', err);
65: }
```

- **不存在**：`mkdirSync(..., { recursive: true })` 会连多级父目录一起建 → 正常使用。
- **不能创建**（路径被文件占用 `EEXIST`、无权限、盘符不存在）：`mkdirSync` 抛错 → 进 catch，**`app.setPath` 没有被执行** → `userData` 保持 Electron 默认值；又因为 56 行已 `app.setName(APP_NAME)`，默认值就是 `%APPDATA%\文献架 LitShelf` → **回退是真实有效的**（虽然只打了一行日志、界面上无提示）。`bootstrap` 里 `Host({ dataDir: app.getPath('userData') })`（`main/index.ts:510-514`）拿到的自然也是回退后的目录。
- **已存在但只读**（最容易踩的边界）：`mkdirSync(existing, { recursive: true })` **不会报错**（目录已存在），所以 60-61 行都成功，**不会走 catch 回退**；随后 `Host.start()` 会 `ensureDir(dataDir/cache/thumbs/notes)`（`host.ts:136-148`）而抛错 → `bootstrap` reject → `main/index.ts:568-575`：
```ts
571:    .catch((err) => { dialog.showErrorBox('文献架启动失败', ...); app.exit(1); });
```
  即**弹错误框并退出**，不会在只读目录里留下半截状态、也不会静默改到别处——这是我能从代码确认的最佳降级。**"只读目录"这一条我未实测**（没启动 Electron），建议桌面验收用一条 `LITSHELF_DATA_DIR=<某个已存在且只读的目录>` 跑一次，确认弹框文案与退出码。
- **P2 提示 1**：`path.resolve(override)` 对**相对路径**按 `process.cwd()` 解析；从快捷方式启动时 cwd 不一定是安装目录，相对路径可能落到意外位置（例如 `C:\Windows\System32`，随后因权限失败回退）。使用说明里应写"必须绝对路径"，或在代码里对相对路径显式拒绝。
- **P2 提示 2**：`LITSHELF_DATA_DIR` 只被 Electron 主进程（`main/index.ts:58`）与 web/server 形态（`src/server/index.ts:32-34`，行为不同：那边直接 `path.resolve` 后不看 mkdir 结果）读取；两处语义一致（都按覆盖优先），但**没有统一的校验**。另外单实例锁（`main/index.ts:534`）绑定 userData，因此**两个不同 DATA_DIR 的实例可以并存**（按 Chromium ProcessSingleton 语义推断，未实测）；测试用没问题，日常不建议。

---

## 10. 高 DPI（2/3）与浏览器缩放（Ctrl+= 被自己接管）

**结论：坐标层安全（DPR 无关）；快捷键存在"双重缩放"风险（有风险，需桌面实测）。另有一条滚轮步进 P2。**

**(a) 坐标与 DPR：安全（有据）。**
- 命中/夹取全部用 **CSS 像素**：`getBoundingClientRect()`（`PdfViewer.tsx:734-737`）、`clientX/clientY`（`826-828`、`853`）、`caretRangeFromPoint` 也吃 CSS px（`752-755`）。`devicePixelRatio` 只用于 canvas 后备缓冲（`399-405、213-219`），不影响选区数学。
- DPR 变化（跨屏拖动/浏览器缩放）会更新 `dprLive` 并重画（`401-405`，dpr 上限 2.5），页面 CSS 尺寸不变 → 选区端点、`hitTestAnnotation` 的相对矩形全部不受影响。
- 结论：`deviceScaleFactor 2/3` 下没有"DIP 与 CSS px 混用"的错误。

**(b) Ctrl+= / Ctrl+- / Ctrl+0 的"双重缩放"风险：有风险（未实测，需真实键盘）。**
阅读器自己接管了这三组键与 Ctrl+滚轮：

```ts
// ReaderView.tsx:717-733
717:      if (meta && ev.key === '0') { ev.preventDefault(); setFit('fit-width'); ... }
724:      if (meta && (ev.key === '=' || ev.key === '+' || ev.key === 'Add')) { ev.preventDefault(); zoomBy(1); ... }
729:      if (meta && (ev.key === '-' || ev.key === '_' || ev.key === 'Subtract')) { ev.preventDefault(); zoomBy(-1); ... }
// ReaderView.tsx:640-651：window 上非 passive 的 wheel，preventDefault 挡浏览器级缩放
```

但主进程菜单里定义了三个带**默认加速键**的角色（`src/main/index.ts:443-455`）：

```ts
448:        { label: '放大', role: 'zoomIn' },
449:        { label: '缩小', role: 'zoomOut' },
450:        { label: '实际大小', role: 'resetZoom' },
```

而 Electron 自己的类型定义把这件事写得很直白（`node_modules/electron/electron.d.ts:19200-19209`）：

> "Visual zoom only applies to pinch-to-zoom behavior. **Cmd+/-/0 zoom shortcuts are controlled by the 'zoomIn', 'zoomOut', and 'resetZoom' MenuItem roles in the application Menu. To disable shortcuts, manually define the Menu and omit zoom roles from the definition.**"

菜单加速键在**浏览器进程**里处理，渲染层的 `preventDefault()` 拦不住 → `Ctrl+-`、`Ctrl+0`（以及 `Ctrl+Shift+=`，因为阅读器也认 `'+'`）可能**同时**触发"浏览器整页缩放"和"阅读器内部缩放"，表现为工具栏显示 125% 而实际视觉是 137%，且 `window.devicePixelRatio` 会跟着变。

**为什么现有验收发现不了**：`tools/acceptance-cjk.mjs:303-318` 用 CDP `Input.dispatchKeyEvent` 注入按键，而 `tmp/cjk1.txt` 里那次运行 `Ctrl+= → 250%`、`Ctrl+0 → 183%` 只反映了**内部**缩放标签；同时验收开头 `Emulation.setDeviceMetricsOverride({ deviceScaleFactor: 1 })` 会把 DPR 固定，浏览器缩放也不会体现在 DPR 上。→ 该用例无法判定本风险。

**最小复现/判定步骤（桌面端，真实键盘）**
1. 打开 PDF，记下工具栏百分比与 `window.devicePixelRatio`。
2. 用**真实键盘**按 `Ctrl+-` 两次，再按 `Ctrl+0`。
3. 若出现下列任一现象即为缺陷：(i) 整个界面（工具栏文字、图标）同步变大/变小；(ii) `devicePixelRatio` 从 1 变为 1.1/0.9 等；(iii) 工具栏百分比与实际视觉比例不一致。
4. 若确认，修法方向（供决定，不在本轮实施）：给这三个菜单项显式指定不冲突的 `accelerator`／移除 role 改为手写 click／把内部缩放统一改成 `webContents.setZoomFactor`。

**(c) P2：Ctrl+滚轮对触控板过冲。** `zoomByRef.current(ev.deltaY < 0 ? 1 : -1)`（`ReaderView.tsx:647`）**每个 wheel 事件走一档**，不看 `deltaY` 大小也不做时间节流，而 `ZOOM_STEPS` 有 16 档（`ReaderView.tsx:23`）。鼠标滚轮一格 = 一档（正常）；但触控板/平滑滚轮驱动一次轻扫会发几十个事件 → **一次手势直接冲到 400% 或 25%**。验收只发单个 `deltaY ±240` 事件（`acceptance-cjk.mjs:303-305`），抓不到。复现：触控板按住 Ctrl 轻扫一下，观察百分比是否瞬间到顶/到底。

---

## 11. 额外发现（不在 10 条清单内，但由本轮改动引入或有直接关联）

### E1【已确认缺陷 / P1】点已有高亮后，过期的划词工具条不会被清掉，可能生成错误批注

新加的几何命中分支在 856 行**直接 return**，跳过了排在后面的 `collectSelection` 调度（860 行）：

```ts
848:      const pageEl = (target as HTMLElement).closest?.('.rd-pdf-page') as HTMLElement | null;
849:      if (pageEl) {
850:        const selNow = window.getSelection();
851:        const hasText = !!selNow && !selNow.isCollapsed && selNow.toString().trim().length > 0;
852:        if (!hasText) {
853:          const ann = hitTestAnnotation(pageEl, me.clientX ?? 0, me.clientY ?? 0);
854:          if (ann) { onSelectAnnotationRef.current(ann, ...); return; }   // ← 860 行被跳过
855:        }
856:      }
860:      window.setTimeout(collectSelection, 10);
```

而"清除过期工具条"恰恰只在 `collectSelection` 的折叠分支里做（`PdfViewer.tsx:675-682` → `onSelection(null)` → `ReaderView.tsx:1128-1134` → `setPending(null)`）。`ReaderView.onSelectAnnotation`（817-823）**不清 `pending`**，`SelectionToolbar` 组件本身也没有"点外部关闭"（`SelectionToolbar.tsx:109-114` 的捕获取消只针对调色盘）。

触发链（全部由代码确定）：选中一段文字（工具条出现，`pending = P`）→ 点一下**已存在的高亮**（mousedown 在可选文字上会把选区折叠；`dragRef.inPage` 仍为 true，866-874 行的 `return` 不清 `pending`）→ `onUp` 走命中分支并 return → **卡片打开，工具条仍停在旧选区上方**。

**最小复现步骤**
1. 打开 PDF，拖选 A 处文字 → 点「高亮」→ 得到批注甲（工具条随之消失，`ReaderView.tsx:1313`）。
2. 再拖选 B 处文字 → 工具条出现（预览显示 B 的文字）。
3. 单击批注甲的高亮 → 观察：批注卡片出现，**但 B 的工具条没有消失**。
4. 点该工具条上的「高亮」→ 会为 **B** 再建一条批注（重复/错位），而不是"关掉工具条"。
5. 对比：点页面空白处（非批注）时工具条会正常消失（走了 860 行的 `collectSelection`），可见差异来自 856 行的提前 return。

### E2【P2】鼠标松开点落在 `.rd-pdf-stage` 之外时，夹取与几何命中都不执行

监听只挂在 stage 上（`PdfViewer.tsx:880-888`：`const root = scrollRef.current?.parentElement ?? document;`，`.rd-pdf-stage` 是 `.rd-pdf-scroll` 的父节点，`PdfViewer.tsx:905-912`）：
- 松开点落在**右侧批注面板 / 顶部工具栏 / 窗口外**（拖出窗口自动滚动后松手）时 `onUp` 不触发 → 本次手势**不会夹取**（§1 的"全选"风险在这个手势下重新出现）、也**不会弹工具条**；
- `dragRef.current` 会残留到下一次 mousedown 才被覆盖（866-874）。
**复现**：从页面文字往右拖到右侧面板上松开 → 选区保持浏览器原生结果、无工具条。

### E3【P2】全局 Escape 的浮层名单漏了阅读器的"更多"菜单

```ts
// App.tsx:189-191
const overlayOpen = store.view === 'reader' &&
  !!document.querySelector('.rd-ann-card, .rd-sel-toolbar, .rd-search-panel, .rd-empty-card');
```
名单覆盖了批注卡片 / 划词工具条 / 文内搜索 / 空态卡，**没有 `.rd-menu`**（阅读器右上"更多"下拉，`ReaderView.tsx:987-988`），而 `ReaderView` 的 Escape 分支也没有处理 `menuOpen`（770-782）。
**复现**：阅读器里点「更多」展开菜单 → 按 Esc → **整个阅读器退出**（预期：只关菜单）。
另注：`SelectionToolbar.tsx:252` 的注释"卡片先于阅读器挂载 → 监听器先注册"与事实相反（卡片是 ReaderView 渲染的，必然后挂载），只是结果仍然正确（ReaderView 的 Escape 分支先处理 `selectedAnn`，`ReaderView.tsx:777`）——注释会误导后续维护。

### E4【P2 潜在，当前不触发】`edgeTextPos` 假设 `span.firstChild` 是文本节点

`PdfViewer.tsx:764-771` 用 `span.firstChild` 的 `offset` 当**字符偏移**。当前安全：`PdfViewer.tsx:240` 调 `page.streamTextContent()` **不带参数**，pdf.js 默认 `includeMarkedContent = false`（`node_modules/pdfjs-dist/build/pdf.mjs:15350-15358`），所以 DOM 里不会有 `.markedContent` 包裹 span；文本 span 由 `textDiv.textContent = geom.str` 生成，`firstChild` 必为文本节点（`pdf.mjs:14575、14600-14607`）。
一旦将来开启 `includeMarkedContent`（或改用别的 textContentSource），`querySelectorAll('.rd-pdf-text span')` 会命中包裹层（其 `firstChild` 是 span 元素），此时 `setStart/setEnd` 因 offset 超出 `childNodes.length` 抛 `IndexSizeError`，被 813-819 行的 `catch { return; }` **静默吞掉 → clamp 完全失效（"拖到空白全选"回归）**。建议在该函数里加一句 `if (node.nodeType !== Node.TEXT_NODE) continue;` 式的过滤（仅建议）。

### E5【P2】`onDown` 首次挂载时可能把监听挂到 `document`

`PdfViewer.tsx:880` 的 `?? document` 兜底：`doc === null` 时组件 `return null`（900 行），`scrollRef.current` 为 `null`，effect 会把三个监听挂到 `document`。目前靠"父级传内联箭头 `onSelection`（`ReaderView.tsx:1128`）导致 effect 频繁重挂"而自愈；若哪天 `onSelection` 变成稳定引用，监听会长期留在 `document`（行为上仍有 `scrollRef.current.contains(target)` 兜底，不至于出错，但与注释语义不符）。**建议**：把 `doc` 加进该 effect 依赖，或在 `root` 为空时不注册。

### E6【信息】验收覆盖缺口清单（给 lead / verifier 排用例用）

| 缺口 | 证据 |
| --- | --- |
| 跨页拖选（§1）**无用例**，且夹具是单页 | `tools/make-cjk-pdf.mjs:102` `/Count 1`；`acceptance-cjk.mjs:277-278` 断言方向相反 |
| `Ctrl+键` 用 CDP 注入，且 DPR 被 `setDeviceMetricsOverride({deviceScaleFactor:1})` 固定 | `acceptance-cjk.mjs:303-318`、`acceptance-cjk.mjs:105` |
| `!` 角标 / hover / tooltip（§7）无断言 | `acceptance.mjs:456、482` 只查存在性与"卡片是否打开" |
| 旋转页（§4）、RTL/竖排（§5）无夹具 | 夹具生成器只造单页横排 |
| 只读 `LITSHELF_DATA_DIR`（§9）无用例 | `tools/acceptance.mjs:126`、`acceptance-cjk.mjs:79` 都指向可写临时目录 |

---

## 12. 建议优先级清单（P0 / P1 / P2）

**P0：无。** 未发现崩溃、数据损坏、批注丢失或不可恢复状态。

**P1（建议本轮修或至少给出明确结论）**

| # | 问题 | 场景 | 依据 | 复现 |
| --- | --- | --- | --- | --- |
| P1-1 | 跨页拖选被强制夹回单页，跨页复制失效 | §1 | `PdfViewer.tsx:794-798、806-811、820-821` | 第 1 页末行按下 → 拖到第 2 页文字上松开 → 选区只含第 1 页 |
| P1-2 | 点已有高亮后过期工具条残留，可误建批注 | E1 | `PdfViewer.tsx:848-860`（跳过 `collectSelection`）、`ReaderView.tsx:817-823、1128-1134` | 选 B → 点高亮甲 → 卡片与 B 的工具条并存 → 点「高亮」重复建批注 |
| P1-3 | `Ctrl+-` / `Ctrl+0`（及 `Ctrl+Shift+=`）可能与菜单 `zoomIn/zoomOut/resetZoom` 加速键冲突 → 浏览器级 + 内部双重缩放 | §10(b) | `main/index.ts:448-450`、`node_modules/electron/electron.d.ts:19200-19209`、`ReaderView.tsx:717-733` | **需真实键盘**：按 `Ctrl+-`/`Ctrl+0`，看界面是否整体缩放、`devicePixelRatio` 是否变化 |
| P1-4 | 横向右→左拖出页面后在页边松手，可能被夹到"页首"（过度夹取） | §2(c) | `PdfViewer.tsx:752-761、806-811` | 行右端按下 → 向左拖进左灰边松手 → 看选区首端是不是页首（需实测判定，未确认前按 P1 处理） |

**P2（记录在案，按需修）**

| # | 问题 | 场景 | 依据 |
| --- | --- | --- | --- |
| P2-1 | 夹取结果折叠时 `removeAllRanges()` 直接清空选区 | §2(d) | `PdfViewer.tsx:820-821` |
| P2-2 | 松手落在 `.rd-pdf-stage` 外时既不夹取也不弹工具条，`dragRef` 残留 | E2 | `PdfViewer.tsx:880-888、866-874` |
| P2-3 | 全局 Esc 名单漏 `.rd-menu`：菜单开着按 Esc 直接退阅读器 | E3 | `App.tsx:189-191`、`ReaderView.tsx:987-988、770-782` |
| P2-4 | `!` 角标外半圈点不到；hover 反馈与 `title` tooltip 失效 | §7 | `reader.css:626-629、666-668、679-694` |
| P2-5 | Ctrl+滚轮每事件一档、无节流 → 触控板一次手势冲到底/顶 | §10(c) | `ReaderView.tsx:23、647` |
| P2-6 | 进度每次落盘多一次 IPC + 全量 items 替换（性能观察项） | §8 | `host.ts:1295`、`store.ts:216-232`、`hooks.ts:68-99` |
| P2-7 | 相对路径 `LITSHELF_DATA_DIR` 按 cwd 解析；两个不同 DATA_DIR 的实例可并存 | §9 | `main/index.ts:59、534` |
| P2-8 | `edgeTextPos` 的 `firstChild` 假设（当前不触发，开启 markedContent 即失效） | E4 | `PdfViewer.tsx:764-771`、`pdf.mjs:15350-15358` |
| P2-9 | `onDown` 可能在 `doc=null` 时把监听挂到 `document`（当前被内联箭头自愈） | E5 | `PdfViewer.tsx:880` |
| P2-10 | 跨页键盘选区到 `collectSelection` 直接 return，旧工具条不被清 | §3 | `PdfViewer.tsx:689、862-865` |
| P2-11 | `saveProgress` 用闭包 `item` 乐观写回，理论上可覆盖更新字段 | §8 | `ReaderView.tsx:174-185`、`hooks.ts:41-47` |

**建议修复方向（只给方向，本轮未改任何代码）**
1. P1-1：夹取前先判断"移动端是否落在**任意**页的文字里"（`caret.inText && caret.pageEl` 且 `caret.pageEl !== anchorPage`）→ 直接放弃夹取（保留原生跨页选区）；跨页建批注本来就由 `collectSelection` 的 689 行拒绝，不需要靠夹取兜。
2. P1-2：在 856 行 return 之前补一次"清掉旧选区载荷"（或让 `onSelectAnnotation` 里 `setPending(null)`），保证卡片与工具条互斥。
3. P2-1：把 `removeAllRanges()` 挪到 `if (!clamped.collapsed)` 之内。
4. P2-4：给 `.rd-ann-flag` 显式 `pointer-events: auto` 并在几何命中里把角标外扩区域计入（或去掉角标、改用矩形内描边）。
5. P1-3：桌面实测后决定是给菜单项去掉 `zoomIn/zoomOut/resetZoom` 角色，还是保留浏览器缩放并让内部缩放让位。

---

## 13. 一句话结论

本轮改动**修好了原目标里的三件事**（中文划词精度、拖到页面内空白不再炸成全选、Ctrl+滚轮/快捷键缩放），但夹取策略是"把选区无条件收回**按下那一页**、空白处一律吸附到**本页 DOM 序首/末**"，由此引入 **1 个已确认缺陷（跨页复制被破坏，P1）**、**1 个新分支副作用缺陷（过期工具条→误建批注，P1）**，以及 1 个与 Electron 菜单角色冲突的**缩放双通道风险（P1，需真实键盘实测）**；其余 7 条场景经代码核验为安全或"依赖浏览器行为、已在报告里给出可执行的桌面复现步骤"。**未发现 P0。**

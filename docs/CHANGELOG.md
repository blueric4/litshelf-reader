# 更新日志

## 2026-10-09 — 阅读器页面重建 / 中文划词 / 空白全选 / 缩放快捷键 / Esc 层级

本轮围绕阅读器的页面重建、文本层挂载与划词交互做修复，补上缩放快捷键，另加一处宿主事件广播、一个数据目录环境变量与整套验收工具；改动后已重新构建 `dist/`。下面每条都注明涉及文件（相对仓库根）。

### 修复

1. **阅读器页面被反复重建（本轮最关键的一条）**
   - 后果：拖动选字时选区锚点失效（用户口中的「选着选着莫名其妙乱选」），文本层还会间歇性一个 span 都不挂（划不了词）。
   - 根因：`ReaderView` 传给 `PdfViewer` 的 `onPageMaps` 是内联箭头函数，每次渲染都换身份 → `PdfViewer` 里的 `onMap` / `onDropMap` 跟着变 → `PdfPage` 的渲染 effect 依赖这两个回调，于是每次渲染都重跑，把 canvas 与文本层整层拆掉重建。
   - 修复：`ReaderView` 新增稳定的 `handlePageMaps = useCallback(…)`；`PdfViewer` 的渲染 effect 改为通过 `cbRef` 取回调，依赖里不再放回调，只留 `doc / pageNumber / scale / dpr / retryTick`。
   - 连带影响：`tools/e2e-desktop.mjs` 与 `tools/acceptance-cjk.mjs` 此前会间歇性失败（同一构建首跑红、复跑绿），根因就是本条与下一条。
   - 文件：`src/renderer/reader/ReaderView.tsx`、`src/renderer/reader/PdfViewer.tsx`。

2. **同一 canvas 上渲染任务重叠 → 这一页永远停在骨架屏**
   - 根因：缩放触发的 `renderTask.cancel()` 是异步的，新任务不等旧任务收尾就开始，pdf.js 抛 `Cannot use the same canvas during multiple render() operations`，被 catch 后静默返回——该页再也不会画出 canvas，文本层也不会生成。
   - 修复：用 `prevTaskRef` 串行化渲染（新任务先 `await` 上一个任务的 promise）；渲染失败时最多自愈重试 2 次（`retryTick`）；文本层挂载后**校验容器里是否真的有 span**，为空则改用 `page.getTextContent()`（pdf.js 有缓存，且不依赖可被 cancel 的流）再挂一次。
   - 文件：`src/renderer/reader/PdfViewer.tsx`。

3. **越界夹取会把选区整个清掉；上一次的划词浮层残留会重复建批注**
   - 修复 a：`clampSelection()` 收紧为「只做缩短越界选区，绝不把合理的选区改坏」——松手点落在**任意一页**的文字上、或活动端已经到另一页时，一律不动；只在松手点不落在文字上时，才把选区夹回起始页。两条安全底线：夹出来的结果**不比原选区短就不替换**；夹出来是**空选区时保留原选区、绝不清空**（此前「从页末行往下拖」会把选区整个清掉，已修）。跨页**建批注**本来就被 `collectSelection()` 拦在单页内。
   - 附注：探针实测拖动过程中原生选区长度始终为 0、指针压着的是起始页的 `.rd-pdf-text`——跨过不可选的灰缝时是 Chromium 直接中止了选区延伸，所以「不能一次拖选跨页文字」是页面灰缝不可选的必然结果（见 README「已知限制」），`clampSelection()` 只覆盖「拖到本页空白/页外」这一支。
   - 修复 b：`onDown` 改成任何一次按下都先收掉上一次的划词浮层（与浏览器一致），但按在 `.rd-sel-toolbar` / `.rd-ann-card` 自己身上时除外，否则按钮还没收到 click 就被卸载。这样「选中 A → 单击高亮 B → 再点高亮」不会再为 A 重复建一条批注。
   - 文件：`src/renderer/reader/PdfViewer.tsx`。

4. **视图菜单加速键与阅读器缩放叠加成「双重缩放」**
   - 根因：`zoomIn / zoomOut / resetZoom` 三个 role 自带 `Cmd/Ctrl + +`、`-`、`0` 加速键，会在主进程直接缩放整个 webContents；渲染层的 `preventDefault()` 拦不住菜单加速键，于是和阅读器自己的 `Ctrl/⌘ + 滚轮` / `Ctrl/⌘ + =` / `-` / `0` 叠在一起。
   - 修复：菜单项改为 `CmdOrCtrl+Shift+=` / `CmdOrCtrl+Shift+-` / `CmdOrCtrl+Shift+0`（菜单项仍可点，用于缩放界面本身），主快捷键完全留给阅读器。
   - 文件：`src/main/index.ts`。

5. **中文划词会「莫名选中一大堆」**
   - 现象：中文 PDF 里从一个字拖到另一个字，实际落库的却是整行甚至一大段。
   - 根因：pdf.js 文本层的字号是 `calc(var(--text-scale-factor) * var(--font-height))`，而 `--text-scale-factor` 依赖 `--total-scale-factor`（语义：1 个 PDF 用户单位等于多少 CSS 像素，也就是当前缩放倍数）。`--font-height` 由 pdf.js 写在每个 span 上，`--total-scale-factor` **必须由宿主设置**——自研阅读器漏了这一步，所有 span 于是退化成继承的界面字号（14px），与 canvas 上画出的字形尺寸对不上（实测差约 2.6 倍），鼠标命中区整体错位。
   - 修复：每页在 `.rd-pdf-page` 上内联设置 `--total-scale-factor`（值 = 该页渲染缩放倍数），并把文本层 CSS 逐条对齐 `pdfjs-dist/web/pdf_viewer.css`（v5.7）。
   - 文件：`src/renderer/reader/PdfViewer.tsx`（`TEXT_LAYER_CSS`、`ensureTextLayerStyles()`、页元素 inline style）、`src/renderer/reader/reader.css`（`.rd-pdf-page`、`.rd-pdf-text`）。

6. **拖到页面空白处会「全选」**
   - 根因：① `reader.css` 把 `.rd-pdf-scroll` / `.rd-pdf-stage` / `.rd-page-host` / `.rd-page-slot` 这类**容器**也放开了 `user-select`，滚动容器整体可选后，浏览器会把选区一路延伸到容器内容的末尾；② 浏览器原生拖选会跟着光标跑到页面外的灰缝里。
   - 修复：① 只对承载文字的元素放开选中（`.rd-pdf-page`、`.rd-pdf-text`、`.rd-text-inner`、`.rd-html-body`、`.rd-epub-body`、`.markdown-body`）；② 新增 `clampSelection()` 兜底：若松手时光标不落在任何一页的文字上，就把选区夹回起始页内的文字（落在本页空白处 → 夹到离光标最近的文字；完全离开本页 → 夹到本页页首/页末），最终语义见上面第 3 条。
   - 文件：`src/renderer/reader/reader.css`、`src/renderer/reader/PdfViewer.tsx`（`clampSelection()`、`onUp`、`onDown`）。

7. **已经高亮过的文字没法再用鼠标划过选中**
   - 原因：批注标记层压在文字层之上并接收鼠标事件，划过已高亮区域时选区建立不起来。
   - 修复：PDF 页内的批注标记层对鼠标透明（`pointer-events: none`），单击改由 `hitTestAnnotation()` 按 0–1 相对矩形做几何命中——「划过仍能选中、单击仍能打开批注卡片」两者兼得；文字版 / EPUB 阅读器维持原来的 DOM 点击行为。
   - 文件：`src/renderer/reader/reader.css`（`.rd-pdf-page .rd-ann`）、`src/renderer/reader/PdfViewer.tsx`（`hitTestAnnotation()`、`onUp`）。

8. **阅读器里有浮层时按一次 Esc 会把阅读器一起关掉**
   - 修复：`ReaderView` 自己消费 Esc，按「文内搜索 → 批注卡片 → 划词工具条 → 返回列表」逐层关闭，并用 `stopImmediatePropagation()` 拦住 App 层的全局 Esc；App 层同时加 `overlayOpen` 判断兜底（App 的监听器注册得比阅读器早，单靠 `stopImmediatePropagation()` 拦不住）。
   - 文件：`src/renderer/reader/ReaderView.tsx`、`src/renderer/App.tsx`。

9. **阅读进度在界面里会留旧值**
   - 修复：`Host.setProgress()` 写库后广播 `items:patch` 事件。此前只有阅读器自己 `patchLocal` 兜住，任何「非阅读器发起」的进度写入都会在界面里留下陈旧副本。
   - 文件：`src/core/host.ts`。

### 新增

1. **缩放快捷键**（此前只有不带修饰键的 `+` / `-`）
   - `Ctrl/⌘ + 滚轮`：非 passive 监听 + `preventDefault()`，拦掉 Chromium 的整页缩放，只在指针位于阅读区时生效。
   - `Ctrl/⌘ + =`、`Ctrl/⌘ + -`、`Ctrl/⌘ + 0`（适应宽度）；缩放范围仍是 25%–400%。
   - 界面本身的缩放改由视图菜单的 `Ctrl/⌘ + Shift + =` / `-` / `0` 触发（见「修复」第 4 条），主快捷键不再和它冲突。
   - 文件：`src/renderer/reader/ReaderView.tsx`（`onWheel`、键盘分支、`applyZoom` / `zoomBy`）、`src/main/index.ts`（菜单加速键）。

2. **`LITSHELF_DATA_DIR` 环境变量**：指定数据目录（便携模式 / 自动化测试隔离数据），桌面形态与浏览器形态读同一个变量。
   - 文件：`src/main/index.ts`（`app.setPath('userData', …)`）、`src/server/index.ts`（`resolveDataDir()`）。

3. **中文划词与缩放专项验收** `tools/acceptance-cjk.mjs`（17 项断言，独立数据目录、独立调试端口 9111），配套 `tools/make-cjk-pdf.mjs` 现场生成中文 PDF 夹具（Type0/CIDFontType0 + Identity-H + ToUnicode，不嵌字体，形态与国内导出件一致）。
   - 文件：`tools/acceptance-cjk.mjs`、`tools/make-cjk-pdf.mjs`。

4. **补充验收脚本重写** `tools/acceptance.mjs`（37 项断言）：规模（300 个文件 / emoji 文件名 / 超长嵌套路径）、软件不往用户文件夹写文件、阅读位置记忆、真实鼠标划词 → 工具条 → 高亮落库 → 页面画出标记、划过已高亮文字仍可选中、单击高亮打开卡片、Esc 只关卡片不关阅读器、`j/k` 键盘导航、搜索按文件名与正文命中、深色模式、强杀进程后重启无重复无丢失、收尾把条目数还原到基线。
   - 文件：`tools/acceptance.mjs`。

5. **验收截图** `docs/screenshots/13-cjk-selection.png`：拖 6 个汉字正好选中 6 个。

### 内部改动

- 文本层 CSS 集中在 `TEXT_LAYER_CSS` 常量里，由 `ensureTextLayerStyles()` 只注入一次（`<style id="rd-pdf-text-layer-styles">`），并与 `pdfjs-dist` v5.7 的 `pdf_viewer.css` 逐条对齐（`--min-font-size`、`--min-font-size-inv`、`--scale-x`、`--rotate` 等变量一并补齐）。
  - 文件：`src/renderer/reader/PdfViewer.tsx`。
- 选区状态集中在 `PdfViewer`：`dragRef`（按下时是否落在页内）、`lastSelectionRef`、`collectSelection()`、`clampSelection()`，鼠标与键盘事件统一挂在滚动容器上。
  - 文件：`src/renderer/reader/PdfViewer.tsx`。
- 验收脚本约定：`tools/e2e-desktop.mjs` 与 `tools/acceptance.mjs` 都用调试端口 9222（必须串行跑），`tools/acceptance-cjk.mjs` 用 9111；三者各自使用隔离数据目录 `tmp/e2e-data`、`tmp/acceptance-data`、`tmp/cjk-acceptance-data`。`tools/acceptance.mjs` 复用 `tools/e2e-desktop.mjs` 生成的示例 PDF，缺夹具时会直接提示先跑前者。
  - 文件：`tools/e2e-desktop.mjs`、`tools/acceptance.mjs`、`tools/acceptance-cjk.mjs`。
- 文档核对：README 的「核心链路」断言数原写 43，实测 `node tools/verify-core.mjs` 输出 51 条断言（51 ✓ / 0 ✗），已按脚本实际数字更正；「自己验收」补齐为五套并写明隔离数据目录；同时修正示例文献构成、格式表（补 AVIF 与旋转 90°）、数据目录说明、检索语法补充项与已知限制的措辞；追加的 4 条修复（页面重建、渲染串行化、越界夹取与浮层收口、菜单加速键）也已写入本文件，并在 README 标注 ③⑤ 两套的间歇性抖动已修复。
  - 文件：`README.md`、`docs/CHANGELOG.md`。
- 改动全部落地后重新构建了 `dist/`（主进程 / preload / 服务端 / 渲染层），桌面端到端验收与 `pnpm start:web` 跑的都是这份新产物。
  - 文件：`dist/`（构建产物；构建命令见 README「快速开始」）。

---

## 2026-10-09 · 第二轮 — 使用体验优化（快捷键 / 右键菜单 / Esc 层级）

### 修复

1. **阅读器里对话框开着按 Esc，会把对话框和阅读器一起关掉**
   - 根因：对话框（`Modal`）的 keydown 监听器是打开时才挂上的，注册得比 App / 阅读器的全局监听器**晚**，所以 `stopImmediatePropagation()` 也拦不住——必须由先注册的一方主动让出。
   - 修复：App 与阅读器的 Esc 分支里先判断 `document.querySelector('.modal-backdrop')`，有对话框就把 Esc 完全交给它；顺带 App 层在 `?` 面板开着时优先只关面板。
   - 文件：`src/renderer/App.tsx`、`src/renderer/reader/ReaderView.tsx`。

2. **`?` 在两处 toggle 会互相抵消**
   - 根因：App（文献库）与阅读器各自处理 `?` 且都做 toggle，谁先注册会随 effect 重注册顺序变化，按一下可能"开了又立刻关"。
   - 修复：阅读器改成幂等的"打开"（`showShortcuts: true`）并 `stopImmediatePropagation()`；面板统一由 App 层的 `ShortcutsModal` 渲染，文献库与阅读器共用同一个。
   - 文件：`src/renderer/reader/ReaderView.tsx`。

3. **右键会把 DOM 选区按塌**
   - 现象：选中文字后右键，菜单内容是对的，但原生选区已经被清空（复制、快速标注都还要用它）。
   - 修复：`onDown` 对非左键按下直接返回，并在页面区域内 `preventDefault()`，拦掉浏览器"按下即清选区"的默认动作；左键拖选与划词逻辑完全不受影响。
   - 文件：`src/renderer/reader/PdfViewer.tsx`。

4. **「更多」菜单开着按 Esc，会把阅读器一起关掉**
   - 根因：`menuOpen` 漏在阅读器键盘 effect 的依赖数组里，Esc 分支的闭包读到的是旧的 `false`，于是跳过"关菜单"直接走到 `closeReader()`。
   - 修复：依赖数组补上 `menuOpen`；Esc 分支同时用 `menuOpen || document.querySelector('.rd-menu')` 双保险，即使状态没同步也先关菜单。
   - 文件：`src/renderer/reader/ReaderView.tsx`。

5. **Esc 让出顺序反了：阅读器里某些对话框按 Esc 完全没反应（P1）**
   - 根因：`ReaderView` 在"要不要让给对话框 / 快捷键面板"的判断**之前**就无条件 `stopImmediatePropagation()`，把注册更晚的 `Modal` 监听器一起挡掉了（第 1 条修的是"判断"，没修"顺序"）。
   - 修复：要让出时只 `preventDefault()`、**不拦事件**，让 `Modal` 自己关；只有真正由阅读器消费 Esc 时才 `stopImmediatePropagation()`（用来拦住 App 层的"返回列表"）。
   - 文件：`src/renderer/reader/ReaderView.tsx`。

6. **长按单键会连发**
   - 现象：按住 `b` 一秒会落下十几条重复书签（`t` / `f` / `[` / `]` / `1`~`4` 同理）。
   - 修复：单键动作统一加 `ev.repeat` 护栏——这些键都是"一次动作"语义，长按不再重复触发。
   - 文件：`src/renderer/reader/ReaderView.tsx`。

7. **右键菜单在选区已失效时会静默无反应**
   - 根因：菜单的"有没有选区"由 `PdfViewer` 按 DOM 选区判断，执行却要靠 `ReaderView` 的 `pending`；两者可能不同步（例如刚按 `1` 落过批注，`pending` 已清但 DOM 选区还在），此前 `annotate` 会直接什么都不做。
   - 修复：`annotate` 在 `pending` 失效时提示「这段选区已经失效，请重新选中文字再标注」；`copy-selection` 既没有 `pending` 又没有 DOM 选区时提示「没有可复制的选区」，并且复制会退回用 DOM 选区兜底——不留静默失败。
   - 文件：`src/renderer/reader/ReaderView.tsx`。

8. **阅读器「更多」按钮键盘打不开（P3，无障碍）**
   - 现象：鼠标点得开，但 Tab 聚焦后按 `Enter` / `Space` 没反应——该按钮原先只绑了 `onPointerDown`。
   - 修复：补 `onKeyDown`，`Enter` / `Space` 切换菜单并 `preventDefault()` + `stopPropagation()`（否则 `Space` 会被阅读器当成"下一页"）；**故意不加 `onClick`**——鼠标点击会 `pointerdown` + `click` 触发两次，变成"开了又关"。
   - 文件：`src/renderer/reader/ReaderView.tsx`。

### 新增

1. **阅读器快捷键**（与 `?` 面板逐条一致）
   - `1` / `2` / `3` / `4`：对当前选区直接加 高亮 / 下划线 / 波浪线 / 删除线（没有选区时不动作）。
   - `b`：加书签；`t`：循环阅读主题（浅色 → 护眼 → 深色，带 toast 提示）；`[` / `]`：上一页 / 下一页；`f`：全屏；`?`：打开快捷键面板（文献库与阅读器共用同一个面板）。
   - 文件：`src/renderer/reader/ReaderView.tsx`。

2. **阅读器右键菜单**
   - 选中文字右键：高亮 / 下划线 / 波浪线 / 删除线 / 复制 / 复制引用（选区文字 + GB/T 7714 题录，中间空一行）/ 在文内搜索。
   - 页面空白右键：适应宽度 / 适应页面 / 加书签 / 复制引用（整篇）。
   - 行为：`fixed` 定位在鼠标处、贴边自动向内收；`Esc`、点击菜单外、滚动 / 滚轮、缩放变化、换页 / 换文档都会关闭；右键不改动选区与已打开的浮层；容器 `role="menu"`、菜单项 `role="menuitem"`，`title` 写明快捷键。
   - 结构：命令契约集中在 `src/renderer/reader/contextCommands.ts`（`ReaderContextCommand`），菜单只负责回调，执行在 `ReaderView`。
   - 验证：lead 的探针确认菜单项齐全、贴边不越界、`Esc` 关闭、点「高亮」批注数 3 → 4。
   - 文件：`src/renderer/reader/contextCommands.ts`（新）、`src/renderer/reader/PageContextMenu.tsx`（新）、`src/renderer/reader/PdfViewer.tsx`、`src/renderer/reader/reader.css`。

3. **`?` 快捷键面板内容更新**：分「文献库」「阅读器内：翻页与定位 / 缩放与视图 / 划词与批注」四组，逐条与实现对齐（含上面新增的 `1`~`4`、`b`、`t`、`f`、`[`、`]` 与右键一行）；reviewer 复核又补上 3 处"实现了但没写进面板"——图片阅读器 `←` / `→` 切换同目录上一张 / 下一张、PDF **双击页面**在适应宽度 / 适应页面之间切换、界面本身缩放 `Ctrl/⌘ + Shift + =` / `-` / `0`（面板文案由 lead 在 `src/renderer/App.tsx` 的 `ShortcutsModal` 里补齐）。
   - 文件：`src/renderer/App.tsx`（`ShortcutsModal`）。

4. **UX 回归验收脚本** `tools/acceptance-ux.mjs`（90 项断言）：本轮新增的键盘与右键交互单独一套验收——`?` 面板内容、`1`/`2`/`3`/`4` 四种快速标注（含"无选区按 `1` 不落库"的负向对照）、`b` / `t` / `[` `]` / `f`、按键重复护栏、右键菜单（有选区 7 项 / 无选区 4 项 / 贴边不越界 / Esc、点别处、滚动关闭 / 右键不破坏选区 / 点「高亮」落库）、选区失效时的兜底提示、`?` 面板与真对话框与「更多」菜单三处 Esc 层级、「更多」按钮的键盘可达（Tab + `Enter` / `Space`，并断言 `Space` 不顺带翻页）、渲染层零错误。
   - 约定：调试端口 9444，数据目录 `tmp/ux-acceptance-data`，现场自造 3 页 PDF 夹具（`tmp/ux-fixture`），不依赖其它脚本的夹具、不往用户 `文档` 目录写东西。
   - 文件：`tools/acceptance-ux.mjs`（新，verifier 编写）。

## 2026-10-09 · 第三轮 — 用户报的四个问题（选区反选 / 缩略图 / 缩放 / 侧栏）

### 修复

1. **拖到空白处会"反选"（把锚点另一侧选进来）**
   - 根因：`clampSelection()` 用**原生 range 的起点是否等于锚点**判断拖动方向，而拖到不可选区域时 Chromium 会把 range 翻转 → 于是夹取方向反了，选区变成「页首 → 锚点」。
   - 修法：方向改用**鼠标位移**（`mousedown` 坐标 → `mouseup` 坐标）判断，竖直位移优先；目标位置先用临时 range 做"必须在拖动方向那一侧"的校验，不通过就退回本页页首/页末。保留两条底线：夹空不替换、不变短不替换。
   - 文件：`src/renderer/reader/PdfViewer.tsx`。
   - 验证：24 页夹具第 3/10/18 页各从中间行向下拖到空白 → 选区均**包含锚点**、起点 span 序号 ≥ 锚点序号（无反转）、只在一页内。

2. **宿主抽取正文时饿死主进程 → 刚加完库点开文献要等十几秒**
   - 根因：Node 形态下 pdf.js 跑的是**同线程 fake worker（微任务循环）**，`extractTextForIndex()` 连续 `await getPage/getTextContent` 会把主进程的宏任务队列压住 → 渲染层通过 `litfile://` 取文件、以及各 IPC 请求全部排队。
   - 修法：两处抽取循环里**每页让出一次宏任务**（`await new Promise(r => setTimeout(r, 0))`）。
   - 文件：`src/core/extract.ts`（`extractTextForIndex` / `extractPdf`）。
   - 验证：同一篇 24 页夹具、隔离数据目录、加完库立刻打开，从双击到文本层出 span：修复前 **15223 / 20087 / 25748 ms**（间歇），修复后 **257 / 260 / 259 / 256 / 264 / 264 ms**；里程碑 reader 挂载 6–8ms、画布 75–85ms。

3. **缩略图：只有第 1 页有图、点第 N 页跳错页、有的页死活不出图**
   - 每页真预览：`ThumbsPanel` 用 `pageGetter`（`usePageGetter` 注入）离屏渲染 132px JPEG，只渲染进入视野的页，**串行 + promise 缓存 + 按 `item.id` 清缓存**。
   - 「死活不出图」：任务被 effect cleanup 作废返回 `null` 时，原先仍把 promise 记进缓存 → 那一页之后每轮都跳过。改为**只有真产出 URL 才算缓存**，作废/失败就 `cacheRef.delete(page)`。
   - 第 1 页封面偶发不生成：`generateThumbnail` 保存前改为读**当前** revision（宿主在 revision 变化时会静默拒收），失败退避重试最多 3 次。
   - 跳页跳错：`goToPage()` 从"自己累加几何"改为**按真实 DOM 位置对齐**（`getBoundingClientRect` 差值），目标页未挂载时先估算再重试校正；并加**代次控制**，连点两个缩略图时旧的重试链不再把新目标顶回去。
   - 文件：`src/renderer/reader/ReaderPanels.tsx`、`src/renderer/reader/PdfViewer.tsx`、`src/renderer/reader/ReaderView.tsx`。
   - 验证：7 页文档 7/7 真预览、0 占位；点第 5 页 → 页码 5、相对滚动容器偏移 **0px**；60 页文档快刷到底再刷回 → 0 页卡占位。

4. **放大 / 缩小太慢**
   - 档位从"每次约 +10%"改成 **`[0.25, 0.4, 0.6, 0.8, 1, 1.5, 2, 3, 4]`**：100% → 150% → 200% → 300% → 400% 四步到底。
   - `Ctrl/⌘+滚轮` 改为**乘性细步进 1.15**，并**按帧合并**（同一帧内的 wheel 事件只缩一次、单事件 delta 钳在 ±240），既防触控板过冲、也不再让每个事件都重启可见页渲染。
   - 缩放**落盘防抖 350ms**（原先每按一下都 IPC + 写 settings + 广播），关闭阅读器时兜底 flush。
   - 缩放时**文本层不再重建**：复用 pdf.js `TextLayer.update({viewport})` 原地重排，只重绘 canvas。
   - 文件：`src/renderer/reader/ReaderView.tsx`、`src/renderer/reader/PdfViewer.tsx`。
   - 验证：178% →（3 次 `Ctrl+=`）→ **400%，290ms**；`Ctrl+滚轮` 一次 **+26%** 且方向正确（向上 = 放大），向下可回落。

5. **左侧导航太挤**
   - 默认只显示「全部文献 / 最近添加 / 在读 / 星标」；其余 5 项（未读 / 待读清单 / 有批注 / 有笔记 / 文件缺失）移入设置「外观」分区，由用户勾选后才出现，并保持原相对顺序。
   - 新增 `Settings.sidebarExtraFilters: SidebarExtraFilter[]`（默认 `[]`，老 `settings.json` 经 `{...DEFAULT_SETTINGS, ...data.settings}` 自动兜底）+ `normalizeSidebarExtraFilters()`（`Array.isArray` 白名单过滤，手改成非数组也不会因 TypeError 白屏）。
   - 当前筛选被隐藏时回落到「全部文献」，回落 effect 的 deps 含 `view`，不依赖挂载时机。
   - 文件：`src/renderer/components/Sidebar.tsx`、`src/renderer/views/SettingsView.tsx`、`src/shared/types.ts`。

6. **文本层偶发"一个 span 都不挂"的三层自愈**（`src/renderer/reader/PdfViewer.tsx`）
   - 第一层：`paintTextLayer` 失败后走重试通道再试 2 次（500ms 间隔）；首选取文方式改为 pdf.js 缓存的 `getTextContent()`（不受"流被 cancel"影响），失败才退回流式。
   - 第二层：**6 秒看门狗**——pdf.js 的 `render`/文本层偶尔"既不 resolve 也不 reject"，这时上面那条自愈分支根本走不到（验收里抓到过 40s×2 的实例）。
   - 第三层：看门狗到点后**让这一页整块重挂**（换 React key → 新 canvas、新 ref、`prevTaskRef` 重置，每页最多 2 次），专治"上一个 render 的 promise 永不 settle 导致后续 `await prevTaskRef.current` 永久卡死"——那种情况单纯重试是修不好的。
   - 另把两个验收脚本里"canvas 一出现就立刻查文本层"的竞态改成等待就绪（最多 20s）：去掉渲染竞态造成的假失败，真挂不上照样红。
   - 文件：`src/renderer/reader/PdfViewer.tsx`、`tools/e2e-desktop.mjs`。
   - 验证：含此修复的收尾构建上，七套（tsc / 209 单测 / 51 核心 / 26 e2e / 37 补充 / 17 中文 / 145 UX 回归）**全部通过、零失败**；UX 回归套件此前四跑都没能全绿，这一轮 145/0。

7. **滚动判页改用真实 DOM 位置**：`reportScroll()` 原按估算几何算"当前第几页"，精确跳页后可能被"纠正"成 ±1 页；现在取"顶部离容器顶部最近且已进入视口"的页，拿不到已挂载页再退回估算。文件：`src/renderer/reader/PdfViewer.tsx`。

8. **文内搜索"输入完没反应"**（verifier 在验收里发现）
   - 现象：在搜索框输入关键词后命中 0、计数栏空白、**没有任何提示**——用户观感就是"文内搜索坏了"。
   - 根因：搜索框的 `onChange` 只更新输入值，**只有按 `Enter` 或点「查找」才真正调用 `runSearch()`**；因此 `searchQuery` 始终为空，计数行那三种文案（查找中 / n 处 / 没有命中）一条都不会显示。
   - 修法：加**边打边搜**（防抖 300ms，`q === searchQuery` 防自触发循环）；首次搜某篇需要建索引时先弹「正在建立全文索引…」，别让等待显得像卡死。
   - 文件：`src/renderer/reader/ReaderView.tsx`。
   - 验证：24 页夹具输入 `uniquepage9`（**不按 Enter**）→ 计数 `1 / 1 处`、命中列表 1 条、跳转 P9；索引未建时手动 `indexItemText` 仅 269ms。

### 新增

1. **`tools/acceptance-ux.mjs` 扩展到 ~140 条断言**：新增 `[I]` 24 页带目录夹具、`[J]` 缩略图快刷后 0 占位、`[K]` 连续跳页不被旧链拉回、`[L]` 单页/双页/连续三种布局的落点一致性、`[M]` 缩放档位序列与细步进、`[N]` 落盘防抖、`[O]` 选区不反选、`[P]` 侧栏默认 4 项 + 设置开关 + 重启持久化。

### 内部改动

1. 新增探针（均在 `tmp/`，不随产品交付）：`probe-round3.mjs`（选区/缩放/缩略图/跳页）、`probe-r3-verify.mjs`（24 页夹具上的选区方向 + 文本层压力 + 打开耗时里程碑）、`sidebar-probe.mjs`、`thumbs-probe.mjs`。
2. 评审报告新增 `docs/review-round3.md`（第三轮对抗复盘，P0/P1 均无）。

## 2026-10-09 · 第四轮 — 在用户真实中文文献上实测后的修复（缩放慢 / 拖到空白全选）

> 教训：前三轮全部用自造夹具验收，**没在用户的真实 CNKI 中文论文上跑过**。这一轮改用用户库里的 8 篇真实文献复现 → 修复 → 复验。

### 根因与修复

1. **"拖到空白就全选" —— 真凶是 Chromium 的原生拖拽，不是选区的夹取逻辑**
   - 实测事件轨迹：`mousedown → selectstart → dragstart → drag×N → dragend`，**全程没有 mouseup**。
   - 后果：所有依赖 mouseup 的选区收尾（夹取、划词工具条、批注）**根本没机会执行**，而浏览器的原生选区会一路扩到后面几页 —— 用户看到的就是"全选"。前三轮"在 mouseup 里夹选区"的方案全都跑在这场拖拽之前，等于没夹。
   - 修复（`PdfViewer.tsx`）：把 **`drag`/`dragend` 当作一等公民**（`drag` 更新终点并实时重设选区，`dragend` 收尾 + 弹划词工具条）；**手动划词**（按下点落在文字上时选区完全由我们构造：锚点 → 指针真正划过的最后一段文字，且绝不跨出起始页，终点没记到就按方向退到本页页首/页末）；`mousedown`/`mouseup`/`dragstart` 全走捕获阶段，浮层的 `stopPropagation` 吞不掉；**单击（位移 <4px）不造选区**。
   - 实测（用户 8 篇真实文献）：拖动中选区 = 实际划过的字数（22/25/27/31/34/151 字…），松手后 0→1600ms **长度不变**；修复前同一操作是 4668 字（≈3 页）。

2. **"放大缩小还是很慢" —— 根因是两万个逐字 span 的样式重算**
   - 实测（用户那篇 14 页论文）：文本层是**逐字 span**，全文档 **22138 个 span**，且**所有页都挂了文本层**；缩放时 `--total-scale-factor` 一变，浏览器要给这两万多个元素重算 font-size → **每次按键 460–535ms**，连按 3 下几秒不稳。
   - 修复：只给视口附近的页挂 canvas + 文本层（高倍时 2 页，**当前页必须有**），span 22138 → 4778；缩放**手势期间**只做一次 CSS transform（零样式重算），变量与文本层重排推迟到停手 160ms 后只做一次；位图像素上限 1600px。
   - 实测：标签延迟 **460ms → 20–36ms**（按下即响应），清晰化重绘 320–400ms；档位 100→150→200→300→400%。

3. **打开论文看到一片空白（本轮引入又修掉的回归）**：库里记着"第 3 页 / 236%"的第 2 篇，打开后当前页是 ghost、文字层只有前两页。根因是上一轮把"当前页判定"改成只看已挂载页 → 恢复位置落在未渲染页时判成上一页 → 该页永远进不了渲染集合（死锁）。修复：改看**所有页的槽位元素** `.rd-page-slot`（每页都有），并把"当前页必须在渲染集合里"当硬约束。实测修复后标签 `3 / 4 页`、`已挂载=[3,4]`。

4. **拖选后选区变空 / 划词工具条不弹（本轮引入又修掉）**：鼠标 effect 的依赖里带了 `onSelection`，父级每次渲染都传新函数 → effect 反复重订阅 → effect 内部的"手动划词"状态被整批重置。修复：`collectSelection` 身份稳定（经 ref 取最新回调），effect 依赖只留它。这同时解释了"某篇选区正常但工具条不弹"与中文套件里的随机失败。

### 验证（最终构建）

| 套件 | 结果 |
|---|---|
| tsc | exit 0 |
| 单元测试 | 10 文件 / **209 通过** |
| 核心链路 | **51 ✓ / 0 ✗** |
| 桌面端到端 | **26 ✓ / 0 ✗** |
| 补充验收 | **37 ✓ / 0 ✗** |
| 中文划词与缩放 | **17 ✓ / 0 ✗** |
| UX 回归 | **145 ✓ / 0 ✗** |
| 用户真实文献（第 1/2/5 篇等） | 每篇 **5/5**：短拖选只选中划过的部分、工具条 4 个动作、高亮落库长度一致、鼠标移到空白选区不变 |

探针：`tmp/probe-real-cn.mjs`、`probe-real-cn2.mjs`、`probe-cn-workflow.mjs`、`probe-cjk-drag.mjs`、`probe-scrollstate.mjs`、`probe-jank.mjs`。

## 2026-10-10 · 第五轮 — 绿色免安装整合版（可直接双击、可整包发给别人）

### 新增

1. **`tools/make-portable.mjs`：一键打绿色免安装整合版**
   - 产物：`文献架整合/`（Electron 标准便携布局）——`文献架 LitShelf.exe`（由 `electron.exe` 改名）+ 运行时 dll/pak/locales + `resources/app/{package.json, dist/**, node_modules/**}` + `使用说明.txt`；压缩后约 172 MB，可直接转发。
   - 关键实现：① 主进程把第三方依赖保留为 external（`packages: 'external'`），所以必须把**生产依赖闭包**打进包——按 Node 真实解析规则在**每个包自己的目录里**解析它的依赖（pnpm 把传递依赖放在 `.pnpm/<pkg>/node_modules/` 下，从项目根解析会漏），拷贝时 `dereference: true` 解开 pnpm 软链接，并跳过 `@types/*` 纯类型包；② 少一个依赖就会开机崩（`chokidar` 的 `exports` 不暴露 `package.json`，第一版正是这样漏掉的）。
   - 瘦身：Electron 语言包只留 `zh-CN/zh-TW/en-US/en-GB`（删 51 个），dist 里的 sourcemap 全部删除 → 460 MB 降到 413 MB。
   - 数据目录：软件数据仍在 `%APPDATA%\文献架 LitShelf`，**不写进整合包**，所以整包可随意拷贝/搬移。
2. **`tools/smoke-portable.mjs`：整合版冒烟验收（13 项）**
   - 启动进程 → 窗口出现 → 库加载 → 打开**用户真实中文文献** → PDF 渲染 + 文本层就绪 → 拖选选中文字 → 划词工具条出现 → `Ctrl+=` 缩放 → 文件夹**新增/删除文件自动同步** → 数据写入指定目录 → 渲染层零错误 → 进程输出无致命错误。
   - 支持 `--real-data`：完全按"双击 exe"的方式启动（读真实 `%APPDATA%` 数据目录）做只读检查。

### 验证（整合版实测）

| 场景 | 结果 |
|---|---|
| 从整合版目录启动（隔离数据目录） | **13 ✓ / 0 ✗** |
| 双击模式（真实数据目录，读到用户 22 条库） | **11 ✓ / 0 ✗** |
| **整包拷到另一路径**后启动 | **13 ✓ / 0 ✗** |
| **把 zip 解压到另一路径**后启动 | **13 ✓ / 0 ✗** |
| 包内写死源码路径检查 | 主进程/预加载/渲染层 bundle 均**无**本机绝对路径 |

### 已修的问题

1. `chokidar` 等依赖漏收集 → 打出来的包一启动就崩（`Cannot find module`）。根因是 `require.resolve('<pkg>/package.json')` 对 `exports` 未暴露 package.json 的包会抛错，被 `continue` 静默跳过。改为"包内解析 + 入口回溯 + 报错不静默"。
2. pnpm 传递依赖（`readdirp`、`jszip`、`commander`、`@xmldom/xmldom` 等）从项目根解析不到 → 改为在每个包自己的目录里解析。
3. 冒烟测试误报：冷缓存时的 `cache/thumbs/*.webp ENOENT` 属于正常日志，不算致命错误；"删除文件后条目数减少"也不对——按设计是标记**文件缺失**并保留条目（批注不能丢）。两处判据都已修正。

## 2026-10-10 · 开源发布 + 隐私处理

### 发布

- 仓库：<https://github.com/blueric4/litshelf-reader>（public，MIT）；首个提交 118 个文件；GitHub Actions 跑类型检查 + 209 例单测，两次运行均通过。
- Release `v1.0.0` 附绿色免安装包 `LitShelf-v1.0.0-portable-win-x64.zip`（172 MB），下载即用。
- 仓库补齐：MIT `LICENSE`、`.gitignore` / `.gitattributes`、README 徽章与下载指引、10 个 topics（electron / pdf-reader / reference-manager / zotero-alternative…）。

### 隐私处理（发布前扫描发现并修复）

1. **界面截图里的本机路径**：6 张截图的提示条里出现过 `%USERPROFILE%\Documents\文献架示例文献`（含 Windows 账户名），详情栏「文件」行也会显示完整路径。
   - 处理：`tools/redact-shots.py` 统一对提示条区域做像素化、并裁掉底部 42px；`tools/privacy-scan-shots.py` / `tools/privacy-verify-shots.py` 用于生成核验图；处理后的截图已随提交更新。
2. **脱敏脚本自身硬编码账户名**：`tools/sanitize-paths.mjs` 第一版把账户名写进了正则。改为运行时从 `os.homedir()` 与项目根目录推导，默认只报告、`--write` 才改文件。
3. **源码注释里提到具体论文名**：改为通用表述（"有些中文期刊 PDF"）。
4. **验收报告里粘贴的原始日志含本机工作目录**：统一改为相对路径。
5. 处理方式：重写为**单一干净提交**并强推（旧提交里的泄露文件不再可达）。注意 GitHub 侧可能短时间缓存旧对象。
6. 复核：全仓扫描（账户名 / 本机路径 / 论文标题关键词）无命中；线上 `tools/sanitize-paths.mjs` 与 `docs/screenshots/02-library.png` 的 SHA256 与本地脱敏版一致；整合包内不含任何个人信息与用户数据。

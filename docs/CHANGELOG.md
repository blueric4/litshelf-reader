# 更新日志

## 2026-10-18 — 划词工具条并入顶部栏 / 删除双击与三击相关功能

### 改进

1. **划词工具条不再浮动在正文上，改为并入顶部工具栏**
   - 用户反馈：一划词就弹一个浮在选区上方的工具条，**挡住正在读的正文**，"很烦、不实用"；而且它压住的那块文字**选不中**（指针被工具条截获）。
   - 现在：划词时顶部那一行中间的「标题 + 星标 + 阅读状态」**顶替成标注工具条**（颜色 / 高亮 / 下划线 / 波浪线 / 删除线 / 批注 / 复制 / 文内搜索 / 关闭），右侧的页码 / 缩放 / 视图 / 主题等控件原样保留；取消选区或按 `Esc` 后自动恢复。
   - 按用户要求，工具条**不再显示选中文字的预览**（视觉上只有按钮，文字只保留在 `title` / `aria-label` 里供读屏）。
   - 窄窗口（最小 960px）下自动隐藏「适宽 / 适页」两个 chip，保证不换行、不溢出。
   - 文件：`src/renderer/reader/SelectionToolbar.tsx`、`ReaderView.tsx`、`reader.css`。

2. **删除「双击页面切换适宽 / 适页」**（用户明确要求删去）。
   - 文件：`src/renderer/reader/PdfViewer.tsx`（去掉 `onDoubleClick`）、`ReaderView.tsx`（去掉 `onZoom(-1)` 分支）、`src/renderer/App.tsx`（快捷键面板）、`README.md`。

3. **删除「双击选词 / 三击选行」的移植死代码**（约 155 行，全仓零调用方）。
   - 这两个手势从未实现（用户明确不需要），但 Zotero 移植时把 `getWordSelectionRanges` / `getClosestWord` / `getClosestLine` / `WordRange` 一并带了进来。
   - 文件：`src/renderer/reader/zoteroSelection.ts`、`docs/划词引擎接管说明.md`。

4. **划词交互改成 Word 式：单击 = 清空选区，拖动才开始选**
   - 用户反馈：点一下页面空白（哪怕离文字很远），它会把**最近的那一个字**选上（截图里点右侧空白，结果选中了左边的「。」），很影响使用。
   - 现在：按下时**先清空旧选区、不画任何东西**；指针位移超过 **5px** 才真正开始选；松手时若从未超过阈值（= 一次单击），保持"无选区"。
   - 点**页面之外的灰色空白**也会清空选区（Word 式）；顶部栏按钮、侧栏、菜单不受影响。
   - 附带：`Shift+点击` 的扩展路径要显式标成"选取中"，否则会被新的单击判定清掉（本轮回测抓到并修了）。
   - 文件：`src/renderer/reader/selectionEngine.ts`（begin/move/end）、`src/renderer/reader/PdfViewer.tsx`。

5. **修：缩放 / 切换布局后，划词高亮"飘"在页面上方（与选中文字错位）**
   - 用户反馈：放大/换布局后，蓝色选区条停在页面**上方的空白处**，和文字对不上。
   - 根因：高亮层画的是**视口坐标**，只靠 `engine.refresh()` 重算；而它的 ResizeObserver 在组件挂载时
     只观测"当时已存在的 `.rd-pdf-page`"——打开文档那一刻页面还没渲染，**一个都没观测到**，
     之后也不补观测 → 缩放/换布局（单↔双↔连续）**从不触发重算**，旧坐标就留在原地。
     （滚动会触发重算，所以"滚一下就好"；这就是用户看到的"飘着"。）
   - 修复：
     ① `PdfViewer.handleLayer`（页面文本层就绪/重建/删除都走它）→ 安排一次带补偿的重算（rAF + 120ms + 450ms）；
     ② 新增 effect 依赖 `[uniformScale, layout, dprLive]`，缩放/布局/DPR 变化后同样重算；
     ③ ResizeObserver 存进 ref，在 `handleLayer` 里对**新出现的页面元素**补 `observe`（持续观测）；
     ④ `selectionEngine.refresh()` 在"锚点页暂时找不到"（重绘瞬间）时**保持选区不清空**，等下一页消息再算。
   - 文件：`src/renderer/reader/PdfViewer.tsx`、`src/renderer/reader/selectionEngine.ts`。
   - 验收（真实鼠标 + 截图，`tmp/sel-harness/shots-overlay-min/`）：选中一段邮箱/作者行 →
     放大到 200%、300%、切双页、切单页，高亮均精确压在原文上（修复前 200% 就能看到蓝条飘在页面上方）。

6. **改进：缩放过程中高亮"黏在字上"（Word 手感），而不是缩放完才归位**
   - 用户反馈：上一条修好后不再错位，但高亮是"缩放完成后才重算、跳到位"，不够丝滑。
   - 机制：页面 canvas 与文本层在缩放手势期间会立刻做一次 CSS `scale(scale/renderScale)`
     （以页面左上角为原点，见 `PdfPage` 的"缩放手势期间的视觉反馈"），停手 160ms 后才按新尺寸重绘。
     高亮层是独立的 fixed 层，原来没有跟这个预览变换 → 手势期间停在旧坐标，重绘后才跳到位。
   - 修复：`PdfPage` 把预览系数 `f` 上报（`onZoomPreview`），`PdfViewer` 对**选中页**套用同一个
     `scale(f)`（transform-origin = 选中页左上角的视口坐标）；重绘完成 `f===1` 时自动清空变换。
     选区被清空时也清掉变换，避免残留缩放。
   - 文件：`src/renderer/reader/PdfViewer.tsx`。
   - 验收（真实鼠标 + 实时采样，`tmp/sel-harness/verify-smooth-zoom.mjs`）：
     点击放大后 **+81ms / +148ms 采样**，高亮层已带 `scale(1.3176)`，与文本层的重叠率
     从基准 94% → 手势期 94% → 重绘后 94%（无跳变）。修复前手势期会掉到很低。

7. **重构：划词高亮改为"页内相对坐标层"（和批注同一套机制）—— 从根上消除缩放闪烁**
   - 用户反馈：第 6 条之后不再错位，但缩放时仍会**闪一下**；要求"像 Word 一样黏在字上"。
   - 逐帧录屏（CDP `Page.startScreencast`，`tmp/sel-harness/record-zoom.mjs` + `analyze-bands.py`）
     抓到了闪烁的确切形态：高亮位置时间线 `y285 → y601 → y285 → y601` ——
     在"预览缩放 → 按新尺寸重绘"的交接处，旧坐标会被露出一帧。
   - 根因：高亮画在**固定在视口上的独立层**里（客户端坐标）。页面一重排，它就必须"重算 + 交接"，
     交接时机无论怎么调都容易露帧（第 6 条只是把窗口缩小，没法根除）。
   - 重构：高亮改画进**每页内部的 `.rd-sel-layer`**，坐标用**页内百分比**（引擎新增 `pageRects` +
     `PageHandle.modelWidth/modelHeight`）—— 和批注高亮完全相同的机制：
     · 缩放（页面的 CSS 预览缩放）：页面盒子一变，百分比定位自动等比缩放，**同一帧跟随，无需重算**；
     · 翻页 / 切换布局 / 滚动：页面怎么动它怎么动；
     · 重绘交接：高亮不挂在文本层上，文本层重建不影响它 → **没有交接窗口，不可能露帧**。
   - 顺带删掉了上一版的整套"预览系数 + 交接隐藏"临时机制（`onZoomPreview`、全局 overlay、
     `rd-sel-clip`/`rd-sel-overlay`），代码反而更简单。
   - 文件：`src/renderer/reader/selectionEngine.ts`、`src/renderer/reader/PdfViewer.tsx`。
   - 验收（逐帧录屏）：缩放前后高亮位置 `y286-305 → y601-630` **单调变化、无回跳帧**；
     用户真机确认"很完美"。

8. **修：夜晚模式只有页面四周"一圈是黑的"，纸和侧栏还是白的**
   - 用户反馈（截图）：夜晚模式下只有阅读区外面那圈背景变黑，**PDF 页面雪白、右侧栏白色** ——
     "就那么一圈是黑的，这不是扯淡吗"。
   - 实测确认：阅读主题原来只覆盖了 `--rd-stage-bg / --rd-page-bg` 等几个**底色**变量；
     PDF 画布是 pdf.js 画的（`filter:none`，永远是白纸），而侧栏 / 搜索 / 批注卡 / 菜单
     用的是 tokens.css 的**全局**调色板（`--card:#fff`、`--text:#1d1d1f`）→ 三者都没跟着变。
   - 修复：
     · **夜晚模式给 PDF 画布反色**：`.rd-pdf-canvas { filter: invert(1) hue-rotate(180deg) }`
       —— 文字页变黑底白字，彩色内容用 hue-rotate 抵消色相翻转；只作用于画布，
       透明文本层 / 划词高亮 / 批注 / 搜索命中都在 DOM 层，不受反色影响；
     · **阅读器 UI 全面跟随阅读主题**：在 `.rd-root[data-reader-theme='dark']` 内**局部覆盖**
       全局调色板 token（`--bg/--card/--text/--line/--toolbar-bg/--hl-*` 等），
       侧栏、搜索面板、批注卡、菜单、空状态一起变深；只影响阅读器，不动应用其它界面；
     · **护眼主题补全**：暖色 token + 画布 `sepia(0.18)` 轻微染色（白纸→米色），
       不再只是边框变色；
     · 深色纸上的划词高亮提亮为 `rgba(80,160,255,.42)`，搜索命中提高对比。
   - 已知取舍：PDF 里的**照片会变负片**（反色模式通行取舍，与 Zotero 一致）。
   - 文件：`src/renderer/reader/reader.css`。
   - 验收（三种主题截图，`tmp/sel-harness/shots-theme/`）：深色下页面黑底白字、侧栏/批注卡/
     顶栏全深、划词高亮清晰；护眼下纸变米色、侧栏暖色；浅色不变。

9. **修：文内搜索"搜到了但页面上找不到"**
   - 用户反馈：文内搜索功能做出来了但没用 —— 搜不到字。
   - 实测确认三层问题：
     ① **页内高亮 0 条**：`findHighlightStrips` 原来在**每个文本节点内部** `indexOf`；
        中文期刊 PDF 的文本层是**逐字 span**（一页 2900+ 个文本节点，一个节点一个字），
        "组织韧性"被拆在 4 个节点里 → 单节点永远查不到 → 页面一条高亮都画不出来。
        修复：先把整页文本按顺序拼成一条归一化字符串（保留「字符 → 节点 + 偏移」映射），
        在整页上搜索，再跨节点构造 DOM `Range` 取矩形（跨行自动多段）。
     ② **全角/空白/零宽字符**：索引里英文常被抽成全角（"ＣＥＯ"）或被空白拆开（"C E O"）。
        修复：查询词与正文统一做 NFKC（全角→半角）+ 丢弃空白/标点/零宽字符 + 小写，
        `countHits` / `snippetAround` / 页内高亮三处同一套规则 → 搜 "CEO" 能命中 "ＣＥＯ"。
     ③ **"第 n / N 处"按页计数、跳转只翻页不定位**：改为按"处"计数与逐处跳转
        （`SearchHit.count`），并自动把**当前命中滚进视野**；侧栏每页显示 `×N`。
   - 另：切页/重绘后高亮不及时 —— 新增 `layerVersion`，文本层就绪即触发搜索高亮重算。
   - 文件：`src/renderer/reader/search.ts`、`src/renderer/reader/PdfViewer.tsx`、`src/renderer/reader/ReaderView.tsx`。
   - 验收（真实鼠标 + 截图，`tmp/sel-harness/shots-search/`）：查"组织韧性/资源编排/CEO/ＣＥＯ"
     均出高亮；逐处"下一处/上一处"计数 1/26 → 5/26 正确、当前命中在视口内、跨页自动跳页。

10. **优化：搜索高亮只画"当前命中"（对齐书签思路：页面不刷屏，全貌放侧栏）**
   - 用户反馈：搜索高亮把**所有命中**都画成黄块（"资源编排"一篇 26 处、当前页就有 20+ 条），
     页面很花，还和批注高亮混在一起。建议参照"书签"的优化思路。
   - 改动：页面只画**当前那一处**（橙色 + 细描边），其余命中只在侧栏列表（每页显示 `×N`），
     靠「下一处 / 上一处」或点列表逐处定位（已有自动滚动到命中）。
   - 文件：`src/renderer/reader/PdfViewer.tsx`。
   - 验收（真实鼠标 + 截图 `tmp/sel-harness/shots-search/6-逐处跳转.png`）：
     页面只有 1 处橙色高亮；逐处跳转计数与定位正确（1/26 → 5/26，自动翻页并滚入视野）。

11. **修：分栏页"往下选着选着就选不了了"（块在段落中间被切开）**
   - 用户反馈（截图，第 7 页左栏）：往下拖选，选区只选了 4 行就停住，"居然在段中进行了分栏"。
   - 真机复现：300% 缩放下第 7 页**左栏一整栏被切成 53 个碎块**（连"在 ｜AI｜ 时代"都被切开），
     拖选锚点落进一个只有 1~3 个字的小块里 → 选区卡死。200% 正常、300% 才炸 → 用户说"有时"。
   - 两个叠加的根因：
     ① **同一条栏缝被打断成 3 段**：栏缝的 y 范围来自"投票行聚类"，中间少数行没在栏缝处留空隙
        （表格行/通栏行/两端对齐行）就把缝切成多段；而行的 `gutters` 只算"在它 y 处生效"的缝 →
        缺口段里的行 gutter 集合不同 → 并块判据 `sameGutters` 拒绝 → **块在段落中间断开**。
        修复：把**同一 x 附近、缺口 ≤ 4 倍字高**的栏缝合并回一整条。
     ② **"按字距切跨栏行"的兜底把英文空格当栏缝**：阈值 `max(6, 行内字距中位数×1.8)` 在高倍缩放下
        被 ` AI ` 两侧空格顶破（中文行内字距≈0 → 阈值退化到 6px）→ 一行正文被切成小段。
        修复：断口必须**落在已检出的栏缝附近**（`|缝位置 - 断口| ≤ max(断口宽, 2 字宽)`）才允许切。
   - 另外把 `__litshelfBlocks()` 诊断钩子补上**每页栏缝（位置 + y 范围）、行数、每块首 12 字**，
     这次就是靠它定位的（200% 1 条缝 / 300% 3 段缝，一目了然）。
   - 文件：`src/renderer/reader/selectionEngine.ts`。
   - 验收（真实鼠标 + 截图 `tmp/sel-harness/shots-columnbug/`）：
     · 第 7 页 200% 与 300% 的块结构**完全一致**（左栏 882 字/37 行一整块、右栏 908 字/37 行）；
     · 300% 从"工具直接引入课堂"往下拖：选区连续 **194 字 / 8 行**（修复前卡在 **1 个字**）；
     · 横向拖过栏缝仍**选不到右栏**（栏缝硬边界未回退）；
     · 回归《组织韧性》混排版式：第 1 页 11 块（通栏标题/摘要 + 引言双栏 + 署名）、
       第 2 页两栏各一整块、第 4 页 11 块（历史曾退化到 114 块）。

### 验收（真实鼠标 + 截图）

- 拖选后工具条在顶部栏内（`position` 非 fixed）、正文零遮挡、工具条不含文字预览；
- 点「高亮」成功创建标注；点页面内空白或按 `Esc` → 工具条消失、标题/星标/阅读状态恢复，阅读器不退出；
- 颜色面板弹在顶部栏下方、5 色齐全、完整可见；
- 窗口缩到 960px：顶部栏不换行、不溢出、右侧控件仍可见；
- 双击页面不再改变缩放（230% → 230%）；
- **单击同带空白 → 清空（不再选最近的字）；单击文字/页面外空白 → 无选区；微小拖动（3px）视为单击；
  拖动正常（56 字）；Shift+点击远处 → 选区从 56 字扩到 156 字**（8/8 场景全过，截图在 `tmp/sel-harness/shots-click/`）；
- `tsc` 零错、单元测试 292/292、构建通过。

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

## 2026-10-11 凌晨 · 图片修复 + 划词重做 + 稳定性硬化（A 方案）

> 这一轮全部来自用户实机反馈：① 选文件夹对话框看不到 PDF；② 论文里的图片是一块灰色；
> ③ 划词手感不像 Word（行间距里会"莫名多选一大段"、拖到空白会全选）。修完又按用户
> "把 A 方案干完"的要求，把阅读器的渲染/文本层生命周期对齐 pdf.js 上游做法。

### 1. 选文件夹对话框看不到 PDF（已修）

- 根因：Windows 上只给 `openDirectory` 时对话框**一个文件都不列**；而
  `openFile + openDirectory` 也不行——`openDirectory` 会把它变成"只选文件夹"模式（FOS_PICKFOLDERS）。
- 修法：改成**纯文件对话框** + 文献类型筛选（`openFile` 多选），选中文件 → 用**它所在的文件夹**入库；
  起始目录 `defaultPickStartDir()`：上次选过的 → 已有文献库 → **桌面**优先（其次文档、主目录）；
  菜单/托盘标签同步为「添加文献（选择文件，按所在文件夹入库）…」。
- 界面入口补齐（引导页 / 左侧文献库 / 设置页都给了"选择文献文件（可多选）"与"手动填写路径"，
  空文件夹也能入库）。
- 验证：同一目录同一标题的 A/B 对照——旧参数 0 个文件 + "没有与搜索条件匹配的项"，
  新参数列出全部 8 个中文 PDF；`foldersFromPicked()` 6 例单测。

### 2. PDF 里的图片渲染成一块灰色（已修）

- 根因：pdf.js v5 解码 **CMYK JPEG 要套 ICC 色彩配置**（`wasm/qcms_bg.wasm` + `iccs/`），
  JPEG2000/JBIG2 还要 `openjpeg.wasm` / `jbig2.wasm`；我们只同步了 `cmaps/` 与 `standard_fonts/`，
  也没传 `wasmUrl` / `iccUrl`。
- 修法：`scripts/build.mjs` 增补同步 `pdfjs-dist/wasm`、`pdfjs-dist/iccs`；`pdf.ts` 传
  `wasmUrl`、`iccUrl`；`.gitignore` 按构建生成物忽略这两个目录。
- 验证：同篇同页 A/B——去掉资源时那张**插图（人像照片）**是**纯灰块**（该区域 43,422 像素全为
  `rgb(204,205,207)`），带上资源是**真实照片**（唯一颜色 1,168 → 16,015）。

### 3. 划词重做成"浏览器原生"（已修）

- 根因（独立取证）：指针落在**不属于任何 span** 的位置（行间距、页面空白）时，Chromium 把焦点
  解析成**文本层容器** `DIV.rd-pdf-text`（DOM 顺序排在所有 span 之前），range 被规范化成
  「页首 → 按下行」：行间距拖一下 184 字 / 覆盖 1494px，拖到页脚空白 1366 字（几乎整页）。
  自研划词当年就是在压这个现象，但它把浏览器的原生行为全盖掉了，手感反而不像 Word。
- 修法：删掉 548 行自研划词（manual 选区、每帧 clamp、按行取点），只留三处干预：
  ① **文本层按阅读顺序重排 DOM**（新模块 `textOrder.ts`：分栏 → 栏内从上到下 → 行内从左到右；
  span 绝对定位，改 DOM 顺序不影响外观，只修选择语义）；
  ② 边界落在**文本层容器**上时，改锚到"离指针最近的 span 端点"（**竖直优先**）；
  ③ 跨页时夹回起始页。两者都**只在变短时**替换。
  松手后把正确选区**锁住看护 0.7 秒**（浏览器会把排队的 mousemove 在 mouseup 之后应用完，
  实测 27 字会被改回 296 字）；**拖动期间不干预、工具条只在松手时弹**。
  另修一个隐蔽 bug：反序时 Chromium 返回的是**塌陷 Range 而非抛异常**，`a ?? b` 的兜底永远走不到。
- 验证（独立复验，两轮逐位一致，45 条断言全绿；`node tools/acceptance-selection.mjs`）：
  行间距 184 字/1494px/31 带 → **31 字/19.8px/1 带**（末尾与按下点同行，差 0px）；
  镜像 296 → **27 字**；拖到本页空白 1366（到页首）→ **308（到页末方向）**、不跨页；
  反向 vs 正向 58/58（间歇 567/58）→ **85/85**；拖动中工具条不再出现。

### 4. 稳定性硬化（A 方案：渲染/文本层生命周期，已做）

- 目标：治"偶尔打开论文长时间空白、文本层一个 span 都不挂"（根因是 pdf.js 的 promise
  偶尔**既不 resolve 也不 reject**）。
- 做法：所有可能永不 settle 的等待都加**上限 + 超时取消任务**——等上一个渲染任务 3 秒
  （老代码裸 `await`，一旦悬挂这一页被永久堵死）、`getPage()` 15 秒、`page.render()` 25 秒
  （复杂页正常 8~20 秒）、文本层 `getTextContent()` 10 秒 / `TextLayer.render()` 10 秒；
  超时取消后走**有界重试**，重试用尽升级到"重挂该页 → 重建文档换干净 worker"。
- 回归网：`tools/acceptance-stability.mjs`（70 项断言：反复开关 12 轮 / 开关秒断 / 缩放风暴 /
  跳页风暴 / 论文切换 6 次 / canvas 不泄漏，外加 **[7] 故障注入**：从 `.rd-pdf-page` 的 React fiber
  取到 `props.doc`、打补丁让**下一次 `page.render()` 永不 settle**（`cancel()` 也无效），
  再推一档缩放让新一代 effect 去等它，两版挨同一击）。
- **A/B 结果（同一脚本、同一版用例，产物指纹都验过）**：

  | 版本 | 结果 | [7] 故障注入 |
  |---|---|---|
  | 改前 `index-DoKBH2mD.js`（sha256 `c103c16f…`） | 通过 69 / 失败 1 | **✗ 8005ms 未恢复**：骨架屏仍在、span=51（**旧的**）、画布宽 893 → 永久"白画布 + 骨架屏 + 旧文本层"，看门狗静默（自愈标记 0 次） |
  | 改后 `index-Dvsf-_MU.js`（sha256 `18714cfe…`） | **通过 70 / 失败 0** | **✓ 2357ms 恢复**（从按键起算 ≈3.06s，正是那条 3 秒超时），日志恰好一条 `[reader] 第 1 页等待上一个渲染任务超时，已取消它并继续` |

- 自然压力 5 类在**改前也全绿**（12 轮开关 471–734ms、14 页压力篇 ×6、缩放几何偏差 0.0–0.01%、
  跳页/跳页风暴、6 次切换、canvas 无增长、console.error 0 条）→ P1 #1 是**悬挂型**故障，
  流量压力打不出来，这也解释了"开发态 6 轮全 ~1 秒、打包态偶发"。
- 另修一处会让故障更隐蔽的漏洞：看门狗原来只判断"容器里有 span"，会被**上一代残留的旧 span**
  骗过去（注入用例里它连日志都没打）。现在加了 `paintedThisGen`——必须"这一代真的画完了"才算过。
  （该分支本轮未被单独注入覆盖，`[7]` 是超时兜底先救回来的；已记入 known-issues。）
- 修完在硬化版上重跑全部验收：单测 **224** / 桌面端到端 **26** / 补充验收 **37** /
  划词验收 **45** / 稳定性验收 **70**，全绿。

## 2026-10-11 · 迭代（按"只捡正收益"推进）：对齐官方文本层 + 链接可点

> 用户指示：只要有正收益的都改，先别打包整合版、先别推 GitHub，持续迭代。
> 顺序按性价比：① 官方 `TextLayerBuilder` → ② 链接可点 → ③ Ctrl+F（评估后跳过）→ ④ 批注写回（待做）。

### 先做了 spike：把官方 pdf_viewer 跑起来量了一遍

同一篇真实论文、同一页、同一套量法（`tmp/pdfviewer-spike/driver.mjs`）：

| 场景 | 官方 pdf_viewer 原生 | 我们（A 之后） |
|---|---|---|
| 行间距里拖 | 26 字 / 1 条文字带 | 31 字 / 1 条文字带 |
| 拖到本页空白 | 288 字（到页末方向） | 308 字（到页末方向） |
| 反向拖选 | 95 字 | 85 字 |
| 文本层 DOM 逆序 | **31**（未重排） | **0**（已按阅读顺序重排） |
| 跳页风暴 | 7 次 1815ms | 10 次 318ms |
| 快速缩放 | 11 档 3335ms、canvas 3–7 波动 | 12 次连打 336ms、canvas 恒为 3 |

结论：**全量迁 B 不划算**（划词打平、性能更差、还要重写 7 套回归网），
但官方有两个"值得单独拿"的模块 —— `TextLayerBuilder`（自带 `.endOfContent` + selectionchange 修正）
与 `PDFLinkService`。于是改成增量替换。

### ① 文本层换成官方 `TextLayerBuilder`（已做）

- 官方这个类在文本层末尾加 `.endOfContent`，并在全局 `selectionchange` 里修正"指针落在文字以外
  → 焦点被解析到容器"的畸形选区 —— 与我们手写的那三处纠正**是同一件事**。
- **A/B（只切开关）**：只靠官方机制 → 45 条划词验收里有 **3 项红**（反向拖进行间距覆盖
  1536px 暴涨、反向 11 字 vs 正向 2 字、Shift+点击终点偏一行）；**两套叠加 → 全绿**，
  且正向行间距更准（31 字 → 15~18 字）。所以结论是**两套都要**，不是二选一。
- 一个坑：`pdf_viewer.mjs` 一上来就 `globalThis.pdfjsLib` 解构（第 113 行），ESM 下没有这个全局会
  直接抛 `Cannot destructure property 'AbortException'`（实测启动即白屏）。改成**先挂全局再动态 import**，
  顺带把这块 159KB 变成按需 chunk（主包 1345KB，几乎没变）。
- 另一个坑：`.endOfContent` 在选中态会铺满整层，`Range.getClientRects()` 会把它的整页框一起报出来
  （27 字的选区报成 1536px 高）。处理：① 收集批注矩形时丢掉"不可能是文字行"的框
  （高 > 页高 25%）；② 容器边界**一律替换**成最近的 span（不再受"只夹短"限制，因为容器边界本身就是错的）。
- 还有个副作用：官方给文本层 div 设了 `tabIndex=0`，**右键会把焦点移过去并清掉选区**
  （UX 回归实测 6 字 → 0 字）。修法：右键 mousedown 上 `preventDefault()`，并只让左键参与划词收尾。

### ② PDF 内部链接可点（已做）

- 新模块 `src/renderer/reader/links.ts`（+ 35 例单测）：把链接注释转成页内归一化矩形与跳转目标，
  `resolveInternalPage()` 把 `dest`（数组 ref / 整数 / 命名）解析成页码。
- 渲染层：链接热区压在文本层之上、容器 `pointer-events:none`、只有链接本身可点
  （与 pdf.js 的 annotationLayer 同一套做法），所以链接可点、其它地方照常划词。
  外链走主进程已有的 `setWindowOpenHandler → shell.openExternal`；内链 `goToPage()`。
- **实测**：真实 CNKI 论文里链接注释 **0 个**（这类排版稿本来就没有）。所以另造了带链接的 fixture
  （新增 `tools/make-link-pdf.mjs`：2 页、1 个文内跳转 + 1 个外链）：应用里渲染出 2 个热区、
  标题分别是「跳转到文内位置」与 `https://example.com/`，点文内链接 `1/2 → 2/2`、
  可见文字变成 "Page 2 - arrived by internal link"，渲染层零错误。

### ③ Ctrl+F 查找条：评估后**跳过**

我们已有自己的文内搜索（防抖增量、命中计数、上下条、与文本层高亮联动），引入 `PDFFindController`
等于再造一个查找条，还要把文本层接进它的 highlighter —— 收益（"标准查找条外观"）小于风险与维护成本。
若以后要做，前提是先决定"两套搜索是否合并"。

### ④ 批注写回真实 PDF（已做）

- 目的：批注不再只锁在我们库里 —— 导出的副本里是**标准 PDF 注释**，Acrobat / Zotero / 浏览器都能看到。
- 依赖新增 `pdf-lib`（生产依赖，绿色版打包会带上）；新模块 `src/core/pdf-annotate.ts`：
  - 四种注释都写：`/Highlight` `/Underline` `/Squiggly` `/StrikeOut`，带 `/QuadPoints`、颜色、`/Contents`（摘录 + 批注正文）、作者；
  - 我们的批注矩形是"页内 0–1、y 轴向下"，转成 PDF 用户空间（y 向上）：`y_pdf = pageH - (y + h) * pageH`；
  - **绝不改原文件**：返回新字节流，宿主写成 `<原名>（LitShelf 批注）.pdf`（重名自动加 `(2)`）；
  - `/Rotate ≠ 0` 的页面**明确跳过**（宁可少写一页，也不在别人的阅读器里画出歪批注）。
- 宿主 `Host.exportAnnotatedPdf()` + IPC + 界面入口（阅读器「更多」→「导出带批注的 PDF 副本」）+ 浏览器形态返回 null 并提示。
- 坑：`Annotation` 的正文字段叫 `comment` 不是 `note`；条目的 `ext` **不带点**（"pdf"），拿 `".pdf"` 去比会永远返回 null（实测踩到，已修）；
  `/Contents` 里的中文必须用 `PDFHexString.fromText()`（UTF-16BE），用 `PDFString.of()` 别的阅读器读回是乱码。
- **单测 9 例**：写回后用 **pdf.js 重新打开**校验 subtype/矩形方向/中文内容；退化矩形跳过；旋转页跳过；原字节流不变。
- **端到端**：把一篇真实论文**复制**到 `tmp/annot-export/`（用户原目录全程只读）→ 应用里入库、经 IPC 落一条批注 →
  `exportAnnotatedPdf` 返回 `written:3`；副本 2.4MB / 14 页，里面能读出 3 条 `Highlight`（作者 LitShelf、
  中文摘录与批注正文完整）；**原文件哈希未变**；用户真实文献目录 8 个文件全程未被写入。

### 回归与已知抖动

单测 **14 文件 / 268 用例** · 划词 **45** · 稳定性 **70**（有一次 67/70、一次 68/70 抖动，均为**故障注入 7a**
那一项，复跑即绿：自愈 2372ms + 预期日志「等待上一个渲染任务超时，已取消它并继续」） · 补充验收 **37** ·
桌面端到端 **26** · 中文划词 **17** · UX **145**（1 项既有 [F2]，见 known-issues P2 #5）。

## 2026-10-11 上午 · 用户实机反馈两个 bug（一个已修、一个已诊断待重做）

### 已修：点右侧批注只跳到那一页、跳不到"那一句话"

- 根因两条：① PDF 分支下 `ReaderView` 的 `scrollRef` 是 **null**（滚动容器在 PdfViewer 内的
  `.rd-scroll`），"滚到批注位置"那段拿到 null 直接返回；② `goToPage()` 自己会在下一帧滚动，
  一次性 `scrollBy` 会被它覆盖。
- 修法：滚动容器改为按 DOM 查 `.rd-scroll`；并**循环校正**（最多 12 次、每 130ms，偏差 ≤24px 即停），
  把批注那一行放到视口约 35% 高度处。顺带给页槽补了 `data-page-index`（否则定位不到页）。
- 说明：根因经代码与探针定位，**但本轮没跑完端到端复验**（探针最后一步超时）；
  复验脚本已留好：`tmp/probe-twofix.mjs`（第二部分：点侧栏批注 → 批注是否落在视口内）。

### 已诊断、实现已就位但默认关闭：横向拖选横穿多栏

- 现象（用户截图）：三栏论文页面上横向拖一下，高亮带横穿左中右三栏。
- 原因：文本层按阅读顺序重排 DOM 后，浏览器按 DOM 顺序扩展选区，把纸面上不相邻的三段连起来。
- 已实现 `xWindowOf()`（按 x 覆盖投影找文字块窗口）+ `clampToAnchorColumn()`（跨块夹回锚点那一栏），
  单测 3 例；**但真实 CNKI 页面左侧有竖排页眉文字，x 投影被桥接 → 三栏被算成一块，夹取不触发**。
- 因此挂 `ENABLE_COLUMN_LOCK = false` 默认关闭，行为与用户当前版本一致；下一步见 known-issues P1 #0。
- 本轮回归：单测 14 文件 / **274** 用例、划词 **45**、补充验收 **37** 全绿。

## 2026-10-11 下午 · 用户两个 bug 全部修好（均带独立验证）

### Bug A：点右侧批注只跳到那一页、跳不到"那一句话" —— 已修

- **真因**：滚动容器类名写错 —— `ReaderView` 里查 `.rd-scroll`（全仓只在那句注释里出现），PDF 真正的滚动容器叫
  `.rd-pdf-scroll`（在 PdfViewer 内），且 PDF 分支下 `scrollRef` 是 null → "滚到批注位置"那段**静默退出**。
- **修法**：`findPdfScroller()`（`.rd-pdf-scroll` → 从页槽往上找第一个真能滚的祖先 → `scrollRef` 兜底，不写死类名）；
  `scrollToPageY()` 改**绝对目标** `scrollTo` + 16×130ms 循环 + **连续两次到位才算成功**（对付 `goToPage` 之后的复校）。
- **证据**（同一篇、同一条第 2 页 y=72% 批注，连跑 4 次一致）：改前距视口顶 **1303px/844px（1.544×，不在视口内）** →
  改后 **295px/844px（0.350×，✓ 在视口内）**；verifier 独立复验 scrollTop 4704 → 5534、批注 y=374 ✓。

### Bug B：横向拖选横穿多栏 —— 已修（硬性禁止跨栏）

- **栏带**改用 pdf.js 的**文本项**（新模块 `columnBands.ts`，18 例单测）：y 带覆盖率找通道（允许 ≤35% 行带被
  通栏标题压过）+ 最小缝宽页宽 0.8%；111 页真实语料里多栏页从 7 页提升到 46 页，且不影响被当单栏的验收论文。
- **夹取**（`clampToAnchorColumn`，`ENABLE_COLUMN_LOCK = true`）修掉四个具体 bug：① 页码 off-by-one；
  ② 方向用了按 DOM 归一化的端点（反向拖被对调）→ 改用 `sel.anchorNode`；③ 焦点落在文本层容器就整轮放弃 → 改为按跨栏处理；
  ④ "本栏末尾"按 DOM 顺序取（`.markedContent` 页不重排，DOM ≠ 阅读顺序 → 夹歪成整页）→ 改为**按几何**取端点、
  在"整段 rect 都落在锚点栏内"的候选里取最长者；夹取成功后重新锁住 + 顺延看护（≤2.5s）。
- **证据**：`tools/acceptance-columns.mjs`（verifier 独立写的 16 条）**✅ 全过**（选区 x 275–343，栏 1 = 138–553）；
  `acceptance-selection.mjs` 45 条 **✅ 全绿且数字与改前逐位一致**（169/31/27/308/85/85，零退化）；
  双向拖选（正 611 字 x97–416 / 反 21 字 x783–1092）与同栏纵向拖（168 字未被夹）自测通过。
- **遗留（记入 known-issues）**：带 `.markedContent` 的页面因 `reorderTextLayer` 的保守分支不重排，
  夹取只能给出很短的安全区间（该页 5 字）→ 治本需放宽重排限制，待做。
- 顺手：IPC `addAnnotation` 缺 `color` 会让批注面板渲染树崩（`HIGHLIGHT_COLORS[undefined].light`）→ host 侧 `color ?? 'yellow'` 兜底。

## 2026-10-11 傍晚 · 反向跨栏修复合并（收工前最后一项）

用户要求"不想要跨栏"，但**反向拖（末栏→左栏）**一直是漏网的：稳定态 829 字跨栏（改前 728 字，属既有问题）。

- **真因**（pdf.js 源码 `pdf_viewer.mjs` 的选区处理佐证）：每次 `selectionchange`，pdf.js 都把 `.endOfContent`
  **插到选区锚点旁**并把宽高设成**整个文本层** → 一个整页大小的块落进我们的区间：**文字一个没变、rect 却横贯整页**；
  而且这种"同一对边界点被重新解释"**不补发 `selectionchange`**，只靠事件驱动的看护永远追不上
  （`cloneRange()` 只存边界点，DOM 一变克隆体也被同样重新解释）。
- **修法**：看护窗口内挂 `MutationObserver`（只在窗口内、带 8 次收敛上限、正常同栏选区永不重算），
  检测到文本层 childList 变动就**按几何强制重算**夹回锚点栏；同时把 `.endOfContent` 挪回末尾、清掉行内宽高，
  并按 pdf.js 自己的 `reset()` 摘掉 `selecting` 类（否则它会变成盖住整层的可选中块，导致那片区域"一个字都选不中"）。
- **验证**（门槛 + 端到端，均在 main 上复跑）：
  - `tools/acceptance-columns.mjs` **16 ✅**（首条 36 字 x149~530，栏 1 = 138~553）；`acceptance-selection.mjs` **45 ✅**
    且数字与改前**逐位一致**（169/31/27/308/85/85）→ 单栏页与栏内手感零退化；`tsc` 0；`vitest` 15 文件 / 292 用例 ✅
  - 样本文献 A p4：正向 `(417,665)→(895,699)` **102 字 x151~553**（连续 3 次）✓；反向 `(757,633)→(182,761)`
    **650 字 304 rect ratio 0.514~0.869**（≥4 次）✓；"夹取后立刻再拖"仍 102 / 650 字 ✓
  - `.endOfContent` 状态：改前夹取后是盖住整层的 `1,1,1147,1622`（带 `selecting`）✗ → 改后恒为 `1,1623,1147,0` ✓
  - 样本文献 B p2（三栏）：正向 5 字（栏 1 内）✓、反向 6 字（栏 3 内）✓ —— 字数偏小是因为该页有横跨栏缝的通栏行/表，
    在"整段必须在本栏内"的硬判定下只取本栏内一小段（**宁可短、绝不跨栏**）
- **两条如实保留**：① 样本文献 A 正向那个坐标在部分轮次偶发"0 字"（整段拖动零条 `selectionchange`、命中确是第 4 页 span、
  样式与 `.endOfContent` 都正常），同构建连跑 3/3 又是 102 字 → 判为**合成鼠标输入偶发**，非应用状态问题，未据此改码；
  ② 样本文献 B p2 的字数偏小属"硬判定 + 通栏元素"的已知取舍，用户已明确"不要跨栏"优先。
- 顺带纠正一条误报：verifier 的对抗脚本报"同栏纵向 2 个 rect 落进第 2 栏"——0 容差复量后**起于第 2 栏的 rect = 0**，
  越界的 6 个 rect 左端都在第 1 栏，是**自带横跨栏缝的通栏公告行**（内容如此），属 ±4px 分类容差误判。

## 2026-10-11 夜 · 混排页（整幅摘要 + 多栏正文）修好 —— 用户报的"第 1 页零散蓝块"

- **先澄清现象**：那些蓝块**不是批注**。该库 `annotations.json` 批注总数为 0（直接读数据目录 + `listAnnotations` 独立核对），
  所以是浏览器的**实时选区**。
- **真因**：第 1 页是混排页（上方整幅通栏摘要，下方双栏正文），而栏带是**整页一套 x 区间**
  （该页 `3 栏 [0.09~0.36][0.38~0.67][0.69~0.96]`），摘要行的 span 实际横跨 `0.092~0.838`（压过 2~3 条栏带）；
  更关键的是文本层按"栏优先"重排把**同一视觉行拆开**（DOM 取证：y=595 的三段被排到相隔 40+ 个位置）
  → 选区渲染出来就是碎块。修前摘要区纵向拖：**63 字 / 16 rect**，每行只覆盖一条栏带宽度（0.17~0.25，而该行真实跨度 0.87）。
- **修法**（`columnBands.ts` + `PdfViewer.tsx`）：新增**按 y 分区** —— 逐行用"栏缝切段数"判断该行是通栏还是多栏
  （**不能只看跨度**：双栏页同一 y 行带里左右两栏各有一行，跨度天然整幅；只看跨度的第一版把多栏正文全判成通栏、
  夹取直接失效），连续同类行合并成区域；**通栏区 1 条栏带且不夹取**（通栏行横跨整页是版式事实），
  多栏区在区内重跑栏缝检测并照旧硬性禁止跨栏；**全局 < 2 栏则完全不分区**（守卫必须留：去掉它时
  `acceptance-selection` 的"拖到空白 308 字"会变成 696 字）。
- **验证**：摘要区 **63 字/16 rect（逐行被拆）→ 118 字/24 rect、逐行"行内断档 = 0"**，通栏区无夹取日志；
  同页正文栏 1 内 86 字 ratio 0.070~0.339 ✓、栏 1→栏 3 横跨 31 字被夹回栏 1 ✓；
  多栏页未退化（样本文献 B 第 2 页 3 栏 25/6 字、样本文献 A 第 4 页 2 栏反向 650 字均在按下栏内）；
  `acceptance-selection` **45/45 且数字逐位一致**；`tsc` 0；`vitest` 15 文件 / 292 用例 ✓。
- **两条度量口径澄清**（独立验收里出现的两条红，均为用例侧问题，判据未放宽）：
  ① **"行内断档 = 5/2"**：12px 阈值把中文两端对齐行里**相邻 span 的正常版式间距**（实测 2/6/8/10/15px）
  算成断档；按"断档区间里是否存在**未选中**的 span"口径实测 = **0**（逐行覆盖表：596 字/64 rect/13 行，
  6 个间隙全部"未选中 span 0"）。建议判据改为与像素无关的口径。
  ② **"x 覆盖 77%"**：分母取错了 —— 该行实测 `792/800 = 99%`（本页文字内容 x 范围 [174,974]、宽 800px），
  是整页最宽的一行，**没有被重排截断**；这一页是期刊"网络首发封面页"，版式本就非满幅。
  另 `[1]` 的锚点一度落在标题/刊名页眉上（产品按 y 分区判为通栏区、本来就不夹），改为**锚点必须属于多栏行簇**。

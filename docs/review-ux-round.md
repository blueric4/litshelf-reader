# 对抗式复盘：本轮 UX 改动（快捷键 / `?` 面板 / 右键菜单 / Esc 层级）

- 审查人：reviewer（对抗式审查，**只读不改**）
- 交付物：本文件（新文件）。上一轮的 `docs/review-selection.md` 未改动。
- 审查对象：`src/renderer/reader/ReaderView.tsx`（快捷键分支、`annotateSelection`、`handleContextCommand`、Esc 让出）、`src/renderer/App.tsx`（`useHotkeys`、Esc 让出、`ShortcutsModal`）、`src/renderer/reader/contextCommands.ts`、`PageContextMenu.tsx`、`PdfViewer.tsx`（右键菜单 + `onDown`）、`reader.css`（`.rd-ctx-menu`）。

## 0. 方法与限制

| 项 | 说明 |
| --- | --- |
| 验证方式 | **只读静态审查 + 事件分发顺序推理**。逐行读了上列文件，另核对了 `components/Overlays.tsx`、`SelectionToolbar.tsx`、`ImageReader.tsx`、`styles/app.css`、`styles/tokens.css`、`utils/format.ts`、`main/index.ts`（视图菜单）、`tools/acceptance-ux.mjs`（本轮的验收脚本，21:07 版本）。 |
| 未做 | **未启动 Electron**（verifier 正在跑 `acceptance-ux.mjs`，会撞单实例锁）。所有"浏览器/Electron 运行时行为"（键重复、中键自动滚动、HTML 全屏 vs F11、IME、`stopImmediatePropagation` 的实际拦截效果）**一律标"未实测"并给桌面复现步骤**。 |
| 无 diff | 仓库不是 git 仓库（`git log` → not a repository），没有改动前快照；本轮改动范围由 mtime 佐证：`PageContextMenu.tsx` 20:57、`contextCommands.ts` 20:58、`reader.css` 20:58、`PdfViewer.tsx` 21:00、`App.tsx` 21:00、`ReaderView.tsx` 21:02、`tools/acceptance-ux.mjs` 21:07。 |
| 结论口径 | **安全**＝代码路径可证明无问题；**有风险**＝存在可疑分支/依赖运行时行为，已给复现步骤；**已确认缺陷**＝不依赖浏览器细节即可从代码证明的错误结果；**未实测**＝需桌面验证，写明原因。**不使用"应该没问题"**。 |

### 0.1 `window` 上 7 个 keydown 监听器（逐一定位）

| # | 监听器 | 注册时机 | 阶段 | 处理的键 |
| --- | --- | --- | --- | --- |
| 1 | `App.useHotkeys`（`App.tsx:240`，effect deps `[]`，`:242`） | App 首次 commit（deps 空 → **永不再注册**） | bubble | `Ctrl+K`、`?`、`Ctrl+R`、`Esc`；`j/k/↑/↓/Enter/Space/s/e/d`（仅 library，`:207` 之后） |
| 2 | `ReaderView`（`ReaderView.tsx:930`） | 阅读器挂载时，**且每次 deps 变化都重注册**（deps 含 `page/pending/searchOpen/selectedAnn/settings.readerTheme/showShortcuts/pdf.doc`，`:932-949`） | bubble | `Ctrl+F/0/=/-`、`1~4`、`b`、`t`、`[`/`]`、`f`、`?`、`←→/PageUp/PageDown/Space/Home/End`、`+/-`、`Esc` |
| 3 | `Modal`（`Overlays.tsx:38`） | 每个对话框/模态面板打开时挂载 | bubble | `Esc` → `onClose()`（**不 stopPropagation**） |
| 4 | `usePopup`（`Overlays.tsx:227`） | 库视图右键/下拉菜单打开时（阅读器内未使用） | bubble | `Esc` → 关菜单 |
| 5 | `ImageReader`（`ImageReader.tsx:79`） | 图片条目挂载时（deps `[go,prev,next]`，换图即重注册） | bubble | `←/→` 切上一张/下一张（**不判输入框、不 preventDefault**） |
| 6 | `SelectionToolbar` 批注卡（`SelectionToolbar.tsx:253`） | 批注卡片打开时 | bubble | `Esc` → `stopImmediatePropagation()` + 关卡片 |
| 7 | `PageContextMenu`（`PageContextMenu.tsx:63`） | 右键菜单打开时 | **capture** | `Esc` → `preventDefault()`+`stopPropagation()`+关菜单 |

---

## 1. 全局 keydown 顺序敏感性（最要紧的一条）

**结论：已确认缺陷（P1，见 1.3 的 Esc 死角）；其余键位不存在"重复处理/互相抵消"，但有 3 处顺序相关的行为需要知道（1.1、1.2、1.4）。**

### 1.1 顺序事实（可证明）

- **App 恒为第一个**：`useHotkeys` 的 effect deps 是 `[]`（`App.tsx:242`），且它在 App 的**首次 commit** 就注册（`useHotkeys` 调用在 `if (!ready) return` 之前，`App.tsx:68-71`），那一刻树里只有加载占位（没有 ReaderView / DialogHost 的 Modal / 菜单）。`removeEventListener`+`addEventListener` 只在重注册时发生，App 之后永不重注册 → **它永远排在 `window` 监听队列第一位**（`main.tsx:11` 的 `React.StrictMode` 只在 dev 双调用 effect，生产构建无效，且不改变相对顺序）。
- **ReaderView 的位置是浮动的**：它的 effect deps 含 `page`、`pending`、`searchOpen`、`selectedAnn`、`settings.readerTheme`、`showShortcuts`（`ReaderView.tsx:932-949`）→ **滚动换页、划词、开关搜索、开批注卡片、按 `t`、开关 `?` 面板都会让它重新注册**，注册后它排到当前队列**末尾**。因此"ReaderView vs 后挂载的监听器（3/6/7）"的先后顺序**不固定**。
- **`PageContextMenu` 因用 capture（`:63`）恒为最早收到 Esc 的那个**（window 的捕获阶段在冒泡阶段之前），所以顺序问题不影响它。
- **批注卡片（6）的结果与顺序无关**：卡片先跑 → `stopImmediatePropagation` + `onClose()`（`SelectionToolbar.tsx:249-250`）；ReaderView 先跑 → `ev.stopImmediatePropagation()` 后 `else if (selectedAnn) setSelectedAnn(null)`（`ReaderView.tsx:914、920`）。两条路都是"关卡片、阅读器不退"。**安全**。
- **Modal（3）的结果与顺序强相关** → 见 1.3。

### 1.2 六个状态下 `?` / `1`~`4` / `b` / `t` / `f` / `[`/`]` 的归属

| 状态 | `?` | `1`~`4` | `b` `t` `f` `[` `]` | `Esc` |
| --- | --- | --- | --- | --- |
| 阅读器（无浮层） | App toggle(`:172-176`) + ReaderView 幂等 open(`:869-875`) → **净 = 打开**；面板已开时再按 = 保持打开（不会抵消，但也关不掉，见 1.4） | 仅 ReaderView(`:829-838`)，无 `pending` 时什么都不做 | 仅 ReaderView（`b:839`、`t:844`、`f:863`、`[:853`、`]:858`） | App `closeReader`(`:201`) → 回文献库（预期） |
| 对话框开（`.modal-backdrop`） | App 开面板（叠加在对话框上）+ ReaderView 再置 true | ReaderView 仍生效（焦点不在输入框时）→ **在遮罩后面悄悄建批注** | ReaderView 仍生效（换页/主题/全屏） | **App 让出(`:194`)、ReaderView 让出(`:916-918`)、Modal 被 `stopImmediatePropagation` 拦住 → 完全无反应（P1）** |
| `?` 快捷键面板开 | 保持打开（App toggle 被 ReaderView 强制 open 覆盖） | 同上（若此时仍有 `pending`） | 同上 | App 关面板(`:187-190`) ✓，ReaderView 因 `showShortcuts`/backdrop 让出 → 只关面板，阅读器不退 ✓ |
| 搜索框聚焦 | 两个监听器都在 `isTypingTarget` 处 return（`App.tsx:167-170`、`ReaderView.tsx:797-801`）→ 正常输入 `?` | 正常输入 `1`~`4` | 正常输入 `b/t/f/[/]` | 第 1 次只 `blur()`（两个监听器都只 blur 就 return），第 2 次才关搜索面板（2 次按键，见 §11-P2） |
| 批注卡片开 | 同上（打开面板，卡片留在后面） | 焦点在 textarea → 输入；焦点不在 → `pending` 已被清 → 无动作 | ReaderView 仍生效 | App 让出（`overlayOpen` 含 `.rd-ann-card`，`:198-200`）→ ReaderView/卡片关卡片 ✓ |
| 右键菜单开 | 面板叠在菜单上（菜单 z-index 84 < backdrop 100） | `pending` 还在 → **标注成功但菜单不关**；随后点菜单里的「高亮」静默无效（见 §4.3） | ReaderView 仍生效；`[`/`]` 换页会让 PdfViewer 关菜单（`:1016-1019`），`b`/`t` 不关 | 菜单 capture 先跑 → `stopPropagation` → **只关菜单**，App/ReaderView 收不到 ✓（`acceptance-ux.mjs:686-689` 已验证） |

**没有发现"同一个键被两个不同动作各处理一次"的情况**（除了 `?` 的 toggle-vs-open：净结果是打开，不抵消）——因为 App 的库快捷键被 `if (store.view !== 'library') return;`（`App.tsx:207`）挡住，而阅读器的键位 App 一个都不处理；`Space` 在阅读器只走 ReaderView，`Home/End`、`[`/`]`、`t`、`f`、`b`、`1`~`4` 同理。

### 1.3 【P1｜已确认缺陷】阅读器里"靠自身监听器关闭"的对话框会 Esc 无反应

`ReaderView` 在**让出判断之前**就无条件拦掉了事件：

```ts
909:        case 'Escape':
913:          ev.preventDefault();
914:          ev.stopImmediatePropagation();          // ← 无条件：后面的监听器全部收不到
915:          // 全局快捷键面板开着时，交给 App 层的 Esc 去关（它注册得比我们早），这里不要再动别的浮层
916:          if (useStore.getState().showShortcuts) break;
917:          // 对话框开着时同理：对话框自己的监听器注册得比我们晚，得让它去关……
918:          if (document.querySelector('.modal-backdrop')) break;
```

`stopImmediatePropagation()` 会跳过队列里排在 ReaderView 之后的所有 `window` 监听器，而对话框的 `Modal` 监听器正是在对话框打开时才注册的（`Overlays.tsx:34-40`）→ **当 ReaderView 排在 Modal 之前时，Modal 永远收不到 Esc**；同时 App（`:194`）和 ReaderView（`:918`）都基于 `.modal-backdrop` 让出 → 三边都不动，**Esc 变成完全无反应**。

顺序判定（为什么这是常态而不是极端情况）：打开对话框的那次 commit 里，ReaderView 的 deps 没有任何变化 → 它的 effect **不会**重跑 → 它保持原来的、比 Modal 更早的位置；React 同一 commit 内是"子 effect 先跑、父 effect 后跑"，只有当**同一次 commit 里 ReaderView 也重注册**才会出现 Modal 排在前面（那种情况反而正常）。也就是说：**"打开对话框期间阅读器状态没变" = 死角，"顺带变了" = 正常**——优先级完全由副作用决定，属于架构级脆弱点。

**这条为什么是"间歇性"而不是"每次都犯"**（重要，决定了复现方法）：ReaderView 的 keydown effect deps 里有 `annotateSelection`（`:944`）→ 它依赖 `createAnnotation`（`:732`）→ 后者依赖 `item`（`:279`），而 `item` 来自 `useStore((s) => s.byId[readerId])`（`:46`）——**任何一次 `items:patch` 广播（阅读进度落盘 ≤800ms 一次、批注增删改、扫描入库）都会换掉 `item` 的身份，从而让 ReaderView 把 keydown 监听器重新注册、排到队尾（即 Modal 之后）**。于是：

- 对话框打开后若**没有**任何 `items:patch` → ReaderView 仍在 Modal 之前 → **Esc 完全无反应**；
- 对话框打开后若有（哪怕一次）`items:patch` → ReaderView 排到 Modal 之后 → Esc 又能正常关对话框。

**可复现路径（当前唯一在阅读器里可达的 Modal）**：顶栏的「扫描进度」框（`App.tsx:317-338`，`Modal`）：

1. 在阅读器里按 `Ctrl+R`（App 的 `:178-183`，阅读器里也生效）触发重新扫描；
2. 点顶栏的「扫描中」进度按钮 → 弹出「扫描进度」对话框（`.modal-backdrop`）；
3. **立刻**按 `Esc`（趁还没有 `items:patch` 广播进来）→ **对话框不关、阅读器也不关，画面没有任何变化**；再按几次仍然如此，只能点遮罩关闭。
4. 最稳的复现环境：条目多的大库、扫描处于 `discovering`（只发 `scan:progress`、不发 `items:patch`）阶段——这个窗口里 ReaderView 不会重注册，死角可以稳定保持好几秒；反之若扫描正在频繁入库，Esc 又恰好能用（间歇性本身就是"行为由副作用顺序决定"的实证）。
5. 期望：第一次 Esc 关掉对话框、阅读器保留（这正是本轮"Esc 层级修复"的目标）。

**为什么现有验收没抓到**：`acceptance-ux.mjs:701-708` 的 [G] 用的是**快捷键面板**——它由 App 自己的 `showShortcuts` 分支关掉（`App.tsx:187-190`），不需要 `Modal` 的监听器，所以 [G] 全绿也证明不了"靠监听器关的对话框"这一路。**建议补用例**：起一次扫描 → 进阅读器 → 点顶栏进度按钮 → 断言 `Esc` 后 `.modal-backdrop` 为 null 且 `.rd-pdf-page` 仍在。

**另外**：因为让出判断用的是 DOM 存在性（`.modal-backdrop`）而不是"对方有没有能力处理"，**任何将来只在遮罩上点一下关闭、没注册 keydown 的浮层，都会必然出现"Esc 完全没反应"**（任务 §8 提的那种类型）。修法方向（不在本轮实施）：把 `stopImmediatePropagation()` 挪到"确实要消费这段 Esc"的分支里（即让出时不要拦），或让 App 统一负责 `.modal-backdrop` 的关闭。

### 1.4 与顺序无关但值得记的行为差异

- **`?` 在阅读器里只能开不能关**：App 先 toggle（`:174`）、ReaderView 再强制 `true`（`:874`）→ 面板开着时按 `?` 是 no-op；文献库里 `?` 是正常 toggle。面板文案写的是"打开这个面板"，所以不算错，但两处语义不一致（P2）。
- **模态并没有真正"模态"**：对话框/`?` 面板开着时（焦点不在输入框），`1`~`4`/`b`/`t`/`f`/`[`/`]` 仍然由 ReaderView 生效（表 §1.2）。例如扫描进度框开着时按 `t` 会换阅读主题、按 `f` 会进全屏、按 `1` 会在遮罩后面建批注（P2）。

---

## 2. 按键与输入冲突（含 IME）

**结论：安全。**

- 两个键位处理入口都有"输入目标"护栏：`App.tsx:139-144`（`INPUT/TEXTAREA/SELECT/isContentEditable`）、`ReaderView.tsx:797-801`（`INPUT/TEXTAREA/isContentEditable`）。
- 阅读器里所有会咬字的控件都被覆盖：搜索框 `.rd-search-panel input`、页码框 `.rd-page-input`、批注卡片备注框 `.rd-ann-card-input`（`SelectionToolbar.tsx:299-310` 的 `<textarea>`）、面板里的元数据 `.input`（`reader.css:1404-1408` 也是 input/textarea）。→ 在搜索框里打 `1`/`b`/`t`/`f`/`?`/`[` 都是**正常输入**，不会触发快捷键（`ReaderView` 与 App 都在第一行 return）。
- `contenteditable`：全仓没有 `contentEditable` 元素（grep 只有这两处判断），判断是防御性的、不影响结论。
- **`SELECT` 未在 ReaderView 侧判断**（App 侧判了）：阅读器内没有任何 `<select>`（全仓 `<select>` 只在 `SettingsView.tsx`、`Onboarding.tsx`，这两个视图在阅读器模式下不挂载）→ **不可达，安全**。
- **IME 组合输入**：两个入口都只看 `e.target`；IME 组合期间键盘事件的目标必然是那个可编辑元素（搜索框/备注框/页码框）→ 一律提前 return，不会把候选词里的数字/字母当快捷键。**安全**（`e.isComposing` 未判，但在本应用不影响结论；桌面实测可复核：切中文输入法在搜索框里连续输入 `1btf`）。
- 唯一未覆盖的是 `ImageReader` 的 `←/→` 切图监听器（`ImageReader.tsx:74-81`）：它**不判输入目标、也不 `preventDefault`**。图片阅读器里没有页码框（PDF 专属），但工具栏的搜索面板在图片模式下仍可打开（`runSearch` 对非 PDF 直接 return，面板里没有结果）→ 在搜索框里按左右方向键会**同时**移动光标并切换图片。这是**上一轮就有的代码**（`ImageReader.tsx` 本轮未改），列为 P2 观察项。

---

## 3. `1`~`4` 快速标注

**结论：基本安全（无选区不落库、rects/page 正确）；两点有风险：连按竞态（P2）、菜单开着时按会留下菜单（P2）。**

- **无选区不会误建**：`ReaderView.tsx:832-837`
  ```ts
  832:        case '4': {
  833:          if (!pending) break;                 // 没有选区载荷 → 什么都不做
  834:          const quick = (['highlight','underline','squiggly','strikeout'] as const)[Number(ev.key) - 1];
  835:          ev.preventDefault();
  836:          annotateSelection(quick);
  ```
  `pending` 只在 `PdfViewer/TextReader` 收集到**同页**选区时被置上（`ReaderView.tsx:1290-1296`（PDF）/ `:1317-1330`（文本版）、`PdfViewer.tsx:687-689` 拒绝跨页），所以"凭空按 1"不会建批注。验收 `acceptance-ux.mjs:555-564` 也做了负向对照 ✓。
- **落库的页与矩形是"当初那一页"**：`annotateSelection` 直接用捕获时的 `pending.page / pending.rects / pending.anchor / pending.text`（`ReaderView.tsx:720-733` → `createAnnotation` `:242-280`）。夹取逻辑（`PdfViewer.tsx:841-885`）只在选区落下时改 DOM 选区、不修改已捕获的载荷；`createAnnotation` 也不会按当前页重算。→ **安全**。
- **键位映射一致**：1/2/3/4 = highlight/underline/squiggly/strikeout（`:834`），与工具条按钮顺序（`SelectionToolbar.tsx:31-82`）、右键菜单提示（`PdfViewer.tsx:977-980`）、`?` 面板（`App.tsx:369`）四处一致 ✓。
- **连按两次会不会建两条**：`annotateSelection` 里 `void createAnnotation(...)` 后立刻 `setPending(null)`（`:730`）；第二次按键要重复建批注，必须命中"状态已更新但 effect 尚未重注册、旧闭包里的 `pending` 还是旧值"这个窄窗口（监听器是 effect 里注册的，闭包捕获 `pending`）。React 对离散事件会在同一个宏任务内 flush 状态、被动 effect 通常紧随其后，所以**同一次按键不会重复**，但"极快连按 1、2"（或用按键宏）理论上能踩到。**未实测**，判定方法：用 `Input.dispatchKeyEvent({ autoRepeat: false })` 连续两次紧邻（<1 帧）发送 `Digit1`+`Digit2`，数 `listAllAnnotations` 是否 +2 而同页文字只选了一次（+2 即缺陷）。建议加固方向（不在本轮实施）：在 `annotateSelection` 里用一个 ref 记录"已消费的载荷 id"。
- **右键菜单开着时按 `1`**：`pending` 仍在 → 标注成功；但菜单没有任何关闭逻辑（`PageContextMenu.tsx:52-75` 只处理 Esc/点外部/滚动/滚轮/resize）→ **菜单留在屏幕上**，而且此时再点菜单里的「高亮」会因为 `pending` 已被消费而**静默无效**（`:743` → `annotateSelection` → `:722 if (!pending) return`）。**P2**（与 §4.3 同一根因）。
- 上一轮的附带项：`pending` 不随滚动失效（工具条停在旧屏幕坐标），若此时页面已被卸载，工具条的「批注」分支用 `pending.pageEl.getBoundingClientRect()`（`ReaderView.tsx:1444`）算相对坐标 → 元素已脱离文档时 rect 全 0，通常被 `Math.min/max` 兜到 0.97，只有在分子恰为 0 时会出现 `NaN`。**上一轮代码，本轮未改**，列为 P2 观察项（不属于本轮回归）。

---

## 4. 右键菜单与选区/浮层

**结论：右键不塌选区这条修法方向正确、且命令执行有 `pending` 兜底（安全）；副作用：中键在页面区域被 `preventDefault`（P2，未实测）；核心缺陷：菜单内容与命令的数据源不同步，导致 5 个菜单项点了没反应（P1）。**

### 4.1 右键为什么不塌选区（修法复核）

```ts
// PdfViewer.tsx:929-939
929:    const onDown = (ev: Event) => {
932:      const inPage = !!target?.closest('.rd-pdf-page');
936:      if (typeof me.button === 'number' && me.button !== 0) {
937:        if (inPage) me.preventDefault();     // 右键/中键：拦掉 mousedown 默认行为（含"按塌选区"）
938:        return;                              // 也不动 dragRef / 不清 lastSelectionRef
939:      }
```
配合 `onContextMenu` 的 `ev.preventDefault()`（`:1006`）和菜单自身的 `onMouseDown preventDefault`（`PageContextMenu.tsx:85`），右键全程不碰选区，`pending` 也保留 → 菜单里的标注/复制命令能用到它。`acceptance-ux.mjs:623-625` 断言"右键没有破坏选区、也没有收掉工具条"（真实 CDP 右键）——**这条修法有效（已验证）**。

**副作用 1（P2，未实测）**：`me.button !== 0` 同时覆盖了**中键**（button 1）。中键自动滚动（Windows/Linux 的 middle-click autoscroll）由 Chromium 在 mousedown 默认动作里启动，`preventDefault()` 会把它拦掉 → 在页面区域按中键不再出现自动滚动球。判定：桌面端点页面中部按中键，看是否出现自动滚动。若确实失效，建议把 `preventDefault()` 限定为 `me.button === 2`。
**副作用 2**：右键的提前 return 也跳过了 `onOverlay` 那段"收掉上一次划词浮层"的逻辑（`:945-954`），这是刻意的（右键要留着选区）✓。

### 4.2 菜单开着时的滚动/缩放

**安全**：菜单自己监听 `scroll`(capture)/`wheel`/`resize` 关闭（`PageContextMenu.tsx:62-67`）；父级还在 `[uniformScale, layout, doc, item.id, currentPage]` 变化时关闭（`PdfViewer.tsx:1016-1019`）。验收 `acceptance-ux.mjs:696-699` 覆盖了"滚动后菜单关闭" ✓。

### 4.3 【P1｜已确认缺陷】菜单项的"有没有"和"能不能执行"用了两个数据源 → 点了没反应

- **菜单内容**由 `PdfViewer` 决定：`live = 当前 DOM 选区`，为空时回退到 `lastSelectionRef.current.text`（`:1007-1010`）：
  ```ts
  1008:      const live = sel && !sel.isCollapsed ? sel.toString() : '';
  1009:      const text = (live || lastSelectionRef.current?.text || '').trim();
  1010:      setCtxMenu({ x: me.clientX, y: me.clientY, items: buildContextItems(text) });
  ```
- **命令执行**却依赖 `ReaderView` 的 `pending`：`annotateSelection` 开头 `if (!pending) return;`（`:722`），`copy-selection` 是 `if (!pending) break;`（`:746`），`copy-selection-with-citation` 是 `if (!pending || !item) break;`（`:753`）——**三条路径都静默 return，没有任何提示**。
- 而 `lastSelectionRef` 只在一处被清（`onDown` 的左键分支，`:951-954`）；`pending` 被消费的路径却有 4 条以上：工具条「高亮/下划线/波浪线/删除线」、数字键、工具条「复制」、工具条「在文内搜索」、Esc（`ReaderView.tsx:921-923`）。`createAnnotation` 还会主动清掉 DOM 选区（`:264 window.getSelection()?.removeAllRanges()`）→ **DOM 选区没了、`lastSelectionRef` 还在、`pending` 已经没了**，三者不同步。

**最小复现（桌面端，确定性）**
1. 打开 PDF，拖选一行文字 → 按 `1`（或点工具条「高亮」）→ 批注落库、工具条收起、选区被清（`createAnnotation:264`）；
2. **不要**点页面（点了会走 `onDown` 把 `lastSelectionRef` 清掉）——直接在这一页的**空白处右键**；
3. 观察：菜单显示的是"有选区"的 7 项（高亮/下划线/波浪线/删除线/复制/复制引用（选区+题录）/在文内搜索），尽管此刻没有任何选中文字；
4. 点「高亮」→ **什么都不发生**（不落库、无 toast、菜单关闭）；点「复制」→ 同样什么都不发生，剪贴板不变。
5. 期望：要么退化成"无选区"的 4 项菜单（适应宽度/适应页面/加书签/复制引用整篇），要么真的对上次划的词生效。

**同根因的第二个表现**：右键菜单开着时按 `1`（§3）消耗掉 `pending` 后，再点菜单里的标注项同样是静默无效。

**为什么验收没抓到**：`acceptance-ux.mjs:646-667` 在测"空白处右键"之前先 `leftClick` 了空白点（`:652`），这一步的 `onDown` 恰好把 `lastSelectionRef` 清干净了 → 菜单正确地退化成 4 项。**缺"标注之后不点页面、直接右键"这一条**。
**修法方向（不在本轮实施）**：让菜单项与命令共用一个数据源——例如右键时把 `text` 与"是否可执行"一起传给命令（`search-selection` 已经这么做了，`PdfViewer.tsx:983`/`ReaderView.tsx:770`），或者 `handleContextCommand` 不再依赖 `pending`，而是在需要时用 `lastSelectionRef` 重新收集。

### 4.4 右键菜单自身的实现

- 位置贴合：`position: fixed` + 先渲染后量尺寸收进窗口（`PageContextMenu.tsx:41-50`），验收断言"完全落在窗口内"（`acceptance-ux.mjs:678`）✓。
- 命令契约单一来源：`contextCommands.ts:15-22` 的联合类型 + `PageContextMenu` 只回调不改动业务 ✓（`PageContextMenu.tsx:1-8` 注释与实现一致）。
- `onPick` 先关菜单再执行（`PdfViewer.tsx:1131-1134`），执行用 `ctxCbRef.current`（`:969-970` 每次渲染更新）→ 不存在"用旧回调"的问题 ✓（§7）。

---

## 5. `t` 主题循环

**结论：安全。**

- 取值集合确实是三值：`shared/types.ts:172 readerTheme: 'light' | 'sepia' | 'dark'`，默认 `'light'`（`:294`）。
- 写入路径只有三处，都不会写出别的值：`ReaderView.tsx:849`（`t` 键，`next` 来自同一数组）、`:1087`（工具栏主题按钮的三元表达式）、`:1170`（更多菜单里的 `theme` 常量）。SettingsView 的 `<select>`（`SettingsView.tsx:257`）也只是这三个 option（`as Settings['readerTheme']` 是类型断言，实际值来自 option）。
- `order.indexOf(...)` 返回 `-1` 时（例如手工改坏了 settings.json 塞进旧值 `auto`）：`(-1 + 1) % 3 = 0` → `next = 'light'`，并且 `updateSettings` 会把设置写回合法值；`themeAttr`（`:103`）落到 `.rd-root` 的 `data-reader-theme` 上匹配不到任何主题块 → 用基础浅色变量，不崩、不白屏。→ **安全**（`indexOf(-1)` 的行为已在 `:848` 一行内可验证）。

---

## 6. `f` 全屏

**结论：有风险（HTML 全屏与窗口全屏是两套状态，可能不同步）；失败路径无提示（P2）；全屏下 Esc 的归属未实测。**

- 代码本身健壮：`document.fullscreenElement` 有就走 `exitFullscreen()`，否则 `requestFullscreen().catch(() => undefined)`（`ReaderView.tsx:863-868`），不会抛未捕获异常；`f` 与 `Ctrl+F`（文内搜索，`:803` 先命中并 return）不冲突 ✓；焦点在输入框时不会触发 ✓。
- **与菜单 role 的关系**：主进程视图菜单里有 `{ label: '全屏', role: 'togglefullscreen' }`（`main/index.ts:456`，本轮未改）——它切换的是**窗口**全屏，而 `f` 走的是 **HTML 全屏**（`document.fullscreenElement`）。两者状态互不感知：先点菜单「全屏」再按 `f`，`document.fullscreenElement` 仍是 null → `f` 会请求 HTML 全屏（窗口已全屏，观感上"没反应"或叠加一层），再按 `f` 只退出 HTML 全屏而窗口仍是全屏 → 用户以为"`f` 关不掉全屏"，只能再按 F11/点菜单。**未实测**，判定：桌面端依次做「点菜单全屏 → 按 f → 按 f → 再按 f」，每次记录 `document.fullscreenElement` 与窗口是否全屏；两者不同步即缺陷。
- 另外两点：① `requestFullscreen()` 失败时被 `.catch(() => undefined)` 吞掉，**界面无任何反馈**（P2）；② 全屏状态下 Chromium 通常把 Esc 当"退出全屏"手势，而阅读器的 Esc 链（`:909-925`）也会消费 Esc → 按一次 Esc 可能**同时**退出全屏并关掉某个浮层/阅读器（**未实测**，判定：进全屏 → 按 Esc → 看是否同时发生两件事）。验收 `acceptance-ux.mjs:593-598` 只覆盖了"f 进/出全屏"这一条 ✓。
- 上一条与本轮相关的新增风险：菜单的界面缩放加速键改成了 `CmdOrCtrl+Shift+=/-/0`（`main/index.ts:452-454`，修的是我上一轮的 P1-3 ✓），但阅读器的 `Ctrl+Shift+=` 会命中它自己的 `ev.key === '+'` 分支（`ReaderView.tsx:815`）→ 若该按键同时到达渲染层，就会出现"界面缩放 + 文档缩放"同时发生（**未实测**：桌面端按 `Ctrl+Shift+=`，看工具栏百分比与界面尺寸是否都变）。**P2**。

---

## 7. `handleContextCommand` 的闭包新鲜度

**结论：安全（deps 齐全，且传下去的是 ref 里的最新回调）。**

- deps：`[annotateSelection, pending, item, pushToast, runSearch, copyCitation, updateSettings, addBookmark]`（`ReaderView.tsx:792`）。逐个核对函数体内用到的外部标识：`annotateSelection`✓、`pending`✓、`copyText`（模块导入，无需 dep）✓、`pushToast`✓、`api`（模块导入）✓、`item`✓、`copyCitation`✓、`setSearchInput/setSearchOpen`（state setter，稳定）✓、`runSearch`✓、`setFit`（稳定 setter）✓、`updateSettings`✓、`addBookmark`✓ → **没有遗漏**。
- 传递路径不会用到旧闭包：`PdfViewer` 把 prop 存进 `ctxCbRef.current = onContextCommand`（`:969-970`，每次渲染覆盖），菜单项点击时才读 `ctxCbRef.current`（`:1133`）→ 总是最新一次渲染的 `handleContextCommand` ✓。
- **不会"用旧 pending 复制上一段文字"**：复制类分支在 `pending` 为空时直接 `break`（`:746、753`），宁可不做也不用旧值（代价见 §4.3 的静默无效）。
- 过期的不是**回调**，而是**菜单项**：`ctxMenu.items` 在右键那一刻固化（`:1010`），之后 `pending` 变化不会重建菜单 → §4.3/§3 的两个现象。**建议**：把"当前是否有可执行选区"一并放进命令参数。
- 顺带确认 lead 提到的 TDZ 隐患确实已消除：`handleContextCommand`（`:739`）定义在 `annotateSelection`（`:720`）与 `addBookmark`（`:665`）之后，deps 数组在渲染期求值不会引用未初始化的 `const` ✓。

---

## 8. `.modal-backdrop` 让出判断

**结论：已确认缺陷（与 §1.3 同一处）——"对话框自己的监听器一定能收到 Esc"不成立；并且"有 Esc 但没注册 keydown 的浮层"会必然死角。**

- 让出逻辑本身在两处都写了：`App.tsx:194`（`if (document.querySelector('.modal-backdrop')) return;`）与 `ReaderView.tsx:918`（`break`）→ **让出是到位的**；问题在于 ReaderView 在让出**之前**已经 `stopImmediatePropagation()`（`:914`），把"应该接手的那个监听器"也一起挡了（详见 §1.3 的顺序判定与复现）。
- "有 Esc 但没注册 keydown"的浮层：App 与 ReaderView 的让出条件只判断 DOM 里有没有 `.modal-backdrop`，**不判断它有没有能力处理 Esc** → 只靠点遮罩关闭的浮层会让 Esc 彻底失效。当前所有 `.modal-backdrop` 都来自 `Overlays.tsx:43` 的 `Modal`（它一定注册 keydown，`Overlays.tsx:34-40`），所以这条目前是**结构性风险**而非实例；但它是本次"两道让出"引入的新耦合，值得在修 §1.3 时一起改成"谁消费谁拦"。
- 反面确认（做对的地方）：快捷键面板的 Esc 是 App 自己关的（`:187-190`），所以 `?` 面板不受顺序影响 ✓；批注卡片的 Esc 两条路径等价 ✓；右键菜单用捕获阶段，Esc 只关菜单 ✓（`acceptance-ux.mjs:686-689` 已验证）。

---

## 9. 新增 CSS（`.rd-ctx-menu`）主题与层级

**结论：安全（层级与配色都与既有浮层一致）；视觉对比度未实测。**

- `.rd-ctx-menu { position: fixed; z-index: 84; background: var(--card); border: 1px solid var(--line) }`（`reader.css:972-983`），菜单项 `color: var(--text)`，hover/focus 用 `background: var(--accent); color: #fff`（`:1001-1006`）。
- **层级链**（同层 stacking context，`.rd-root` 是 `position: relative` 但 `z-index: auto`、无 transform/filter，不新建上下文）：`.rd-toolbar` 6（`reader.css:60`）< `.rd-ann-layer` 3、搜索层 4 < `.rd-sel-toolbar` 80（`:771`）< `.rd-ann-card` 82（`:866`）< **`.rd-ctx-menu` 84** < `.modal-backdrop` 100（`app.css:1389`）< 通用 `.menu` 120 < `.toasts` 200 → **不会被工具栏/侧栏/批注卡遮住，也不会盖住对话框与 toast** ✓。侧栏 `.rd-side`、`.rd-search-panel` 没有 z-index，菜单在同层 DOM 之后绘制，压在上面 ✓。
- **不会被裁剪**：`.rd-root` 有 `overflow: hidden`（`reader.css:23`），但菜单是 `position: fixed`，其包含块是视口，且从它到 `.rd-root` 之间没有任何 `transform / filter / backdrop-filter / will-change / contain` 祖先（`.rd-toolbar` 的 `backdrop-filter` 是旁支，不是祖先；`.rd-pdf-page.is-adjacent` 的 `filter` 在页面内，也不是祖先）→ 固定的定位与贴边翻转不会被 `overflow: hidden` 剪掉；验收 `acceptance-ux.mjs:669-681` 也断言了"完全落在窗口内" ✓。
- **主题可读性**：菜单用的是**应用主题**变量（`tokens.css:12/17` 浅色、`:83/87` 深色），不是阅读器主题变量（`.rd-root[data-reader-theme]` 只覆盖 `--rd-*`，`reader.css:26-45`）——这与 `.rd-sel-toolbar`、`.rd-ann-card` 的取色方式完全一致，所以"阅读主题=深色 + 应用主题=浅色"时会出现浅色菜单浮在深色页面上，属**既有设计一致性**，不是本轮新引入的不一致。**未实测**：深色/护眼阅读主题下的实际观感（verifier 的 `ux-03/04` 截图可复核）。另注 hover 的 `#fff` on `--accent` 与 `.menu-item:hover`（`app.css:1489`）同款，无新增对比度风险。

---

## 10. 可发现性 / `ShortcutsModal` 与实际行为逐条核对

**结论：基本一致（无"写了没实现"）；有 3 处"实现了没写"，1 处描述不完整（均 P2）。**

逐条核对（面板 `App.tsx:344-372` ↔ 代码）：

| 面板条目 | 代码 | 结论 |
| --- | --- | --- |
| `Ctrl+K` 聚焦搜索框 | `App.tsx:156-165` | 一致（注：该分支位于输入框判断之前，在对话框输入框里按也会跳回文献库——老行为，P2） |
| `j/k 或 ↑/↓`、`Enter`、`Space`、`s`、`e`、`d` | `App.tsx:218-238` | 一致（均在 `view==='library'` 门内） |
| `Esc` 返回列表 / 清空搜索 | `App.tsx:185-204` | 一致 |
| `?` 打开这个面板 | `App.tsx:172-176` + `ReaderView.tsx:869-875` | 一致（阅读器内只能开不能关，见 1.4） |
| `Ctrl+R` 重新扫描 | `App.tsx:178-183` | 一致 |
| `←/PageUp/[`、`→/PageDown/Space/]`、`Home/End` | `ReaderView.tsx:853-862、876-898` | 一致 |
| `b` 加书签 | `ReaderView.tsx:839-843` → `addBookmark:665-680` | 一致（**无 `ev.repeat` 护栏**，见 §12-P1-3） |
| `Ctrl+F` 文内搜索 | `ReaderView.tsx:803-807` | 一致（非 PDF 会打开空面板，面板文案未说明"仅 PDF/文本"） |
| `Ctrl+滚轮`、`Ctrl+=/-`、`Ctrl+0`、`+/-` | `ReaderView.tsx:640-651、808-823、899-908` | 一致 |
| `t` 切换阅读主题 | `ReaderView.tsx:844-852` | 一致 |
| `f` 全屏 | `ReaderView.tsx:863-868` | 一致（与菜单 role 的正交关系见 §6） |
| `1/2/3/4` 选中文字后加批注 | `ReaderView.tsx:829-838` | 一致（EPUB 无划词 → 该行对 EPUB 不成立） |
| `右键` → 菜单各项 | `PdfViewer.tsx:974-992` | 一致（有选区 7 项 / 无选区 4 项，面板是并集描述） |
| `Esc` 关浮层再按返回列表 | `ReaderView.tsx:909-925` + `App.tsx:185-204` | **不完整**：没有提右键菜单（会关）、阅读器「更多」菜单（会直接退出阅读器，见 §12-P2-4）、对话框/快捷键面板的让出关系 |

**实现了但没写**：① 图片阅读器 `←/→` 切上一张/下一张（`ImageReader.tsx:74-81`）；② 在 PDF 页面上**双击**切换 适宽↔适页（`PdfViewer.tsx:1041`）；③ 本轮新设的"界面缩放"加速键 `Ctrl+Shift+=/-/0`（`main/index.ts:452-454`）。
**写到但语义易误解**：`Ctrl+滚轮` 那行写"只缩放文献，不动界面"——对滚轮成立（`:641-648` 非 passive + preventDefault），但 `Ctrl+Shift+=` 现在会去缩放界面，两条相邻行容易读成同一回事。**均 P2**。

---

## 11. 与本轮同时落地的上一轮问题（复核结果，避免误报）

- **上一轮 P1-1（跨页拖选被夹回单页）→ 已修**：`clampSelection` 现在在"松手点落在**任意**页文字上"（`PdfViewer.tsx:856`）或"活动端已在另一页"（`:857`）时一律不动选区。
- **上一轮 P1-4（页边松手过度夹取）→ 已修**：新增"只做缩短"底线 `if (after.length >= before.length) return;`（`:880-882`）。
- **上一轮 P2-1（夹取折叠时清空选区）→ 已修**：`if (clamped.collapsed) return;`（`:879`）。
- **上一轮 P1-2（点已有高亮后过期划词工具条残留）→ 已修**：`onDown` 现在任何左键按下都会收掉上一次划词浮层，按在工具条/批注卡/右键菜单上时除外（`:945-954`）。
- **上一轮 P1-3（Ctrl+/-/0 与菜单 role 叠加双重缩放）→ 已修**：`main/index.ts:448-454` 把三个 role 显式改成 `CmdOrCtrl+Shift+...`。
- **上一轮 P2-3（阅读器「更多」菜单开着按 Esc 直接退出阅读器）→ 未修**：App 的 `overlayOpen` 名单（`App.tsx:198-200`）仍没有 `.rd-menu`，ReaderView 的 Esc 分支（`:919-924`）也没有处理 `menuOpen` → 见 §12-P2-4。
- **上一轮 P2-4（`!` needsReview 角标外半圈点不到、hover/title 失效）→ 未修**：`.rd-pdf-page .rd-ann { pointer-events: none }`（`reader.css:626-629`）与 `.rd-ann-flag` 无 `pointer-events`（`:679-694`）保持原样。

---

## 12. 建议优先级清单

**P0：无。**（无崩溃、无数据损坏、无不可恢复状态。）

**P1（建议本轮修；前两条请优先看）**

| # | 问题 | 场景 | 依据 | 复现 |
| --- | --- | --- | --- | --- |
| P1-1 | 阅读器里"靠自身监听器关闭"的对话框，Esc 完全无反应（ReaderView 在让出判断之前无条件 `stopImmediatePropagation`；症状间歇，取决于期间有没有 `items:patch` 让 ReaderView 重注册） | §1.3 / §8 | `ReaderView.tsx:913-918`（拦在让出之前）、`App.tsx:194`、`Overlays.tsx:34-40`；复发链 `ReaderView.tsx:944←732←279←46` | 阅读器内 `Ctrl+R` 起扫描 → 点顶栏「扫描中」→ 弹「扫描进度」→ **立刻**按 Esc：对话框与阅读器都不动；大库的 `discovering` 阶段（无 `items:patch`）可稳定复现。**未实测（需桌面确认），顺序论证由代码给定** |
| P1-2 | 右键菜单在"上次划词已被消费"后会列出 5 个点了没反应的项（标注×4 + 复制/复制引用），且无任何提示 | §4.3 | 菜单内容源 `PdfViewer.tsx:1007-1010`（`live \|\| lastSelectionRef`）vs 命令源 `ReaderView.tsx:722、746、753`（`pending`）；`createAnnotation:264` 会清 DOM 选区 | 拖选 → 按 `1` 落批注 → **不点页面**，直接在空白处右键 → 菜单是 7 项"有选区"版 → 点「高亮」/「复制」均无反应（不落库、无 toast、剪贴板不变） |
| P1-3 | `b`（以及 `t`/`f`/`[`/`]`）没有 `ev.repeat` 护栏：按住不放会按系统重复率反复执行 | §10 / §3 | `ReaderView.tsx:839-843`（无 repeat 判断）→ `addBookmark:665-680` 每次无条件 `createAnnotation`（同页无去重） | 打开 PDF，按住 `b` 约 1 秒 → 同一页出现十几条重复书签（面板/`listAllAnnotations` 可数）；`t` 会连跳主题并连写设置，`f` 会反复进出全屏。期望：按住只算一次 |

**P2（记录在案，按需修）**

| # | 问题 | 依据 |
| --- | --- | --- |
| P2-1 | 中键（button 1）在页面区域被 `preventDefault` → 中键自动滚动失效（**未实测**；建议把条件收紧到 `button === 2`） | `PdfViewer.tsx:936-939` |
| P2-2 | 阅读器里 `?` 只能开不能关（App 先 toggle、ReaderView 再强制 open）；对话框/面板开着时 `?` 会把面板叠在对话框上 | `App.tsx:172-176`、`ReaderView.tsx:869-875` |
| P2-3 | 对话框/`?` 面板开着时（焦点不在输入框）`1`~`4`/`b`/`t`/`f`/`[`/`]` 仍生效 → 会在遮罩后面建批注、换主题、进全屏，模态语义被绕过 | `ReaderView.tsx:829-908`（无 `.modal-backdrop` 前置判断） |
| P2-4 | 阅读器「更多」菜单开着按 Esc 直接退出阅读器（上一轮遗留未修） | `App.tsx:198-200`（名单缺 `.rd-menu`）、`ReaderView.tsx:919-924`（不处理 `menuOpen`） |
| P2-5 | 右键菜单开着时按 `1`~`4` 会标注成功但菜单不关；随后点菜单项静默无效（同一根因的轻量表现） | `ReaderView.tsx:833-837`、`PageContextMenu.tsx:52-75` |
| P2-6 | 搜索框聚焦时 Esc 第一次只 `blur()`，要按两次才关搜索面板 | `App.tsx:167-170`、`ReaderView.tsx:797-801` |
| P2-7 | `f`（HTML 全屏）与菜单 `togglefullscreen`（窗口全屏）状态互不感知；全屏下 Esc 的归属未实测 | `ReaderView.tsx:863-868`、`main/index.ts:456`（**未实测**） |
| P2-8 | `Ctrl+Shift+=/-/0`（新的界面缩放键）可能同时命中阅读器的 `'+'/'_'` 分支 → 双重缩放（**未实测**） | `main/index.ts:452-454`、`ReaderView.tsx:815-823` |
| P2-9 | `requestFullscreen()` 失败被 `.catch(() => undefined)` 静默吞掉，界面无反馈 | `ReaderView.tsx:867` |
| P2-10 | 连按 `1`、`2`（同一帧内）理论上可能因旧闭包里的 `pending` 建出两条批注（**未实测**；建议加"载荷已消费"ref） | `ReaderView.tsx:930`（监听器闭包捕获 `pending`）、`:730` |
| P2-11 | 上一轮遗留：`!` needsReview 角标外半圈点不到、批注 hover/`title` 失效 | `reader.css:626-629、666-668、679-694` |
| P2-12 | 面板缺 3 条已实现行为（图片阅读器 `←/→` 切图、PDF 双击切适宽/适页、界面缩放 `Ctrl+Shift+=/-/0`）；Esc 行的浮层清单不完整 | `App.tsx:344-372`、`ImageReader.tsx:74-81`、`PdfViewer.tsx:1041` |
| P2-13 | `ImageReader` 的 `←/→` 监听不判输入目标（上一轮代码）：图片模式下在搜索框按方向键会同时移光标+切图 | `ImageReader.tsx:74-81` |
| P2-14 | `createAnnotation` 清 DOM 选区但不通知 `PdfViewer` 的 `lastSelectionRef` —— 这是 §4.3 的机制根源，建议由 PdfViewer 暴露一个"选区已消费"的通知 | `ReaderView.tsx:264`、`PdfViewer.tsx:951-954` |
| P2-15 | 阅读器 keydown 监听器随 `items:patch` 反复重注册（`item → createAnnotation → annotateSelection` 这条链进了 deps）：滚动阅读时每 ≤800ms 一次、扫描/批注增删改也各一次。本身不影响正确性，但它是 P1-1 间歇性的根源，也让"谁先收到按键"变成不可预测 | `ReaderView.tsx:944、732、279、46`、`hooks.ts:68-99` |

**建议新增验收用例（本轮 `acceptance-ux.mjs` 的覆盖缺口）**

1. **对话框 Esc**（对应 P1-1）：起扫描 → 阅读器 → 点顶栏进度 → 断言 `Esc` 后 `.modal-backdrop===null` 且阅读器仍在。**当前 [G] 用的是 `?` 面板，绕过了这条路径，会给出假绿。**
2. **过期划词的右键菜单**（P1-2）：拖选 → 按 `1` → 不点页面直接右键 → 断言菜单退化为 4 项（或点「高亮」能再落一条），而不是"7 项但点了没反应"。
3. **键重复**（P1-3）：用 `Input.dispatchKeyEvent` 带 `autoRepeat: true` 连发两次 `KeyB`，断言只 +1 条书签。
4. 菜单开着按 `1`（P2-5）、`?` 面板开着再按 `?`（P2-2）、F11↔`f` 状态同步（P2-7）、中键自动滚动（P2-1）各一条。

---

## 13. 一句话结论

本轮把 `?` 的"互相抵消"改成了幂等打开、给 Esc 加了两道让出、加了 `1`~`4`/`b`/`t`/`f`/`[`/`]` 与右键菜单，键位映射与面板文案基本自洽、输入框/IME 冲突已排除；但 **Esc 的让出写在了 `stopImmediatePropagation()` 之后**，使"靠自身监听器关闭"的对话框（当前可达的是顶栏「扫描进度」框）出现 **Esc 完全无反应的死角（P1，症状随 `items:patch` 顺序间歇）**，而现有验收 [G] 恰好只测了由 App 自己关闭的 `?` 面板、抓不到它；另有 **右键菜单内容与命令数据源不同步导致 5 个菜单项静默无效（P1）**、**`b` 缺键重复护栏会连落重复书签（P1）**。**未发现 P0。**

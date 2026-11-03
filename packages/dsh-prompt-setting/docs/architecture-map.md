# 客户端架构地图（`dsh-prompt-setting/client.js`）

**这份文档要回答的问题**：改一个功能点，该打开哪个文件？

`client.js` 是发布物（15345 行的单个 CommonJS factory），但**人不再直接编辑它** ——
它是 `src/` 的生成物（见 `CONTRACT.md` §23）。本表把「域」映射到：

**域 → `client.js` 行区间 → 段文件 → 入口函数 → CONTRACT 章节 → 测试文件**

## 坐标系（先读这一句）

表里的行号是**段真源坐标**：等于**去掉生成物头注**之后的 `client.js` 行号，也就是每个
`src/*.js` 切片自己的坐标。生成物顶部的 9 行「生成物，勿手改」头注由
`scripts/client-build.mjs` 注入、不属于任何段，所以它不参与本表的编号
（`docs/check-refs.mjs` 的 `CLIENT_HEAD_LINES` 就是这条约定的实现）。

段的划分与行数预算是 `docs/refactor-plan.md` §5.1 的**目标段表**（19 段，每段 ≤ 1200 行）。
表里的「行数」按**剥掉片段声明行之后**算，与 §5.1 的预算口径一致 —— 所以 `wc -l src/*.js`
每个文件都会多出 1 行（最大段 `13-page-a.js` 读作 1200，预算判的是 1199，见 `CONTRACT.md`
§23.2 规则 6）。
重新生成：`node scripts/client-build.mjs --write`；校验：`node scripts/client-build.mjs --check`。

## 19 段总表

| 段文件 | `client.js` 行区间 | 行数 | 域 | 主要入口函数 | CONTRACT | 测试 |
|---|---|---:|---|---|---|---|
| `00-entry.js` | 1–215 | 215 | 文件头 + load 注册 + 指纹区间 + factory guard + `buildPlugin` 头 | `buildPlugin` (212)、`fingerprintOf` (167)、`fingerprintRegion` (150) | §13, §14 | `test/build.test.mjs`、`test/boot.test.mjs` |
| `01-shared-head.js` | 216–996 | 781 | launch shape 探测 + primitives probe + 常量 | `normalizeLaunchKind` (271)、`primitivesActive` (462)、`activeRenderer` (466) | §13 | `test/launch-kind.test.mjs`、`test/client.test.mjs` |
| `02-locale.js` | 997–2196 | 1200 | locale 内联段（`locale-pack.mjs --write` 产出，生成器原样嵌入） | —（数据段） | §22 | `test/locale.test.mjs` |
| `03-facilities.js` | 2197–2798 | 602 | `token` / `fallbackT` / fallback atoms / `PRIMITIVES_UI` / `tabs` | `tabs` (2530)、`FxButton` (2272)、`FxInput` (2308)、`safeT` (2790) | §13, §16 | `test/client.test.mjs`、`test/interpolate.test.mjs` |
| `04-helpers-a.js` | 2799–3449 | 651 | pure helpers 前半：会话/工作区探测、解码、过滤、标签 | `decodeSessions` (2909)、`filterSessions` (2964)、`decodeWorkspaces` (3082) | §13 | `test/client.test.mjs`、`test/route.test.mjs` |
| `05-helpers-b.js` | 3450–4061 | 612 | pure helpers 后半：冻结状态、编辑门控、覆盖可行性、`chunkStampMap` / `buildVerdict` | `chunkStampMap` (3489)、`buildVerdict` (3527)、`editGate` (3609)、`overrideFeasibility` (3674) | §13, §14 | `test/build.test.mjs`、`test/client.test.mjs`、`test/overrides.test.mjs` |
| `06-tree.js` | 4062–4726 | 665 | 样式表 + tree builders（scrim / dialog / card / row） | `scrimStyle` (4109)、`dialogCardStyle` (4265)、`matchesNeedle` (4489) | §13 | `test/client.test.mjs`（含 `scrimStyle(1200)` 先于 `scrimStyle(1000)` 的段序断言 2538–2542） |
| `07-stage2.js` | 4727–5373 | 647 | stage 2 helpers 后半：history/overview 作用域查询、分页、预留段模型 | `historyScopeQuery` (4747)、`historyPagerInfo` (4767)、`workspaceRows` (4898)、`modeOfEntry` (5077) | §8, §13, §21 | `test/history.test.mjs`、`test/stage2.test.mjs` |
| `08-chrome-a.js` | 5374–6115 | 742 | 状态行 / 版本行 / 范围树前半 | `renderStatusLine` (5448)、`renderStatusDetail` (5546)、`scopeRowStyle` (5846) | §13, §17 | `test/client.test.mjs`、`test/update.test.mjs` |
| `09-chrome-b.js` | 6116–6910 | 795 | `scopeTreeElement` / 会话与提示块渲染 / `renderConfirm` | `scopeTreeElement` (6238)、`renderSession` (6392)、`renderPromptBlock` (6665)、`renderConfirm` (6731) | §13, §15 | `test/client.test.mjs` |
| `10-toaster-mine.js` | 6911–8080 | 1170 | g-062 装配状态 toast + `renderMinePanel` | `planAssemblyToasts` (7050)、`AssemblyToaster` (7105)、`renderMinePanel` (7632) | §15, §21 | `test/assembly-watch.test.mjs`、`test/custom.test.mjs`、`test/overrides.test.mjs` |
| `11-chunks.js` | 8081–8691 | 611 | chunk boundary（协议）：清单、加载、失败降级、tab 注册 | `loadChunk` (8390)、`chunkModule` (8495)、`chunkTab` (8620)、`renderChunkTab` (8649) | §14 | `test/build.test.mjs`、`test/client.test.mjs`、`test/assembly-watch.test.mjs` |
| `12-update.js` | 8692–9332 | 641 | 更新条 + 区域弹窗 + `renderSection` | `renderUpdateNotice` (8719)、`renderRegionDialog` (8996)、`renderSection` (9092) | §17, §18 | `test/update.test.mjs`、`test/route.test.mjs` |
| `13-page-a.js` | 9333–10531 | 1199 | `PromptSettingSection` 第 1 切：JSDoc + hooks/state | `PromptSettingSection` (9347) | §13, §15 | `test/client.test.mjs` |
| `14-page-b.js` | 10532–11729 | 1198 | `PromptSettingSection` 第 2 切：fetch / handlers | —（同一函数体内） | §10, §11, §13 | `test/client.test.mjs`、`test/transfer.test.mjs`、`test/presets.test.mjs` |
| `15-page-c.js` | 11730–12619 | 890 | `PromptSettingSection` 第 3 切：actions / model / root 树 | —（同一函数体内） | §13, §16 | `test/client.test.mjs`、`test/diff.test.mjs`、`test/history.test.mjs` |
| `16-composer-bar.js` | 12620–13776 | 1157 | g-086 会话输入框上方装配状态栏（`conversation.input.dock`）：五分区只读 + 设置快捷入口（catalog 键位派发 + 有界定位）；数据层委托给 `17` 段 | `ComposerAssemblyBar` (13383)、`composerBarIconOf` (12710)、`composerBarDispatchSettingsShortcut` (13002) | §13, §15 | `test/client.test.mjs` |
| `17-composer-bar-live.js` | 13777–14830 | 1054 | g-089 状态栏动态刷新：写广播 / 会话状态 / 可见性 / storage 四类触发，单飞 + 节流 + 可注入计时器 | `useComposerBarLiveRead` (14500)、`composerBarLiveDecision` (14146)、`composerBarNextRead` (14262) | §13, §15 | `test/client.test.mjs` |
| `18-boot.js` | 14831–15345 | 515 | `renderFailureCard` / `degradedPlugin` / boot 返回 | `renderFailureCard` (14843)、`degradedPlugin` (15274) | §7, §14 | `test/boot.test.mjs`、`test/client.test.mjs` |

**`13/14/15` 是同一个函数的三个切**：它们拼起来仍是**一个** `PromptSettingSection`
（`client.js:9348-12619`）。这是「只重切、不移动」能做到的最大粒度 —— 把一个 3257 行的
函数体拆开会让 `const` 的 TDZ 边界与函数声明的提升可见性发生变化，而没有测试能证明
那种移动无害（`CONTRACT.md` §23.2、方案 §5.1 R2-D2）。

## 常见改动落在哪

| 想改的东西 | 打开 | 备注 |
|---|---|---|
| 页面文案 / 键位 | 改 `locale/*.json`，再跑 `node scripts/locale-pack.mjs --write` | 它会写进承载 locale 的那个 `src/` 段**并重建** `client.js`（段名不硬编码，重切后自动跟随）；生成段内文本**不要手改**（§22、§23.2 规则 7） |
| 顶层 tab 的名称、计数、红点 | `03-facilities.js` | `tabs` / `mainTabStrip` / `updateOffered` |
| 会话 / 工作区列表的筛选与标签 | `04-helpers-a.js` | 纯函数，可直接单测 |
| 覆盖可行性、冻结状态、编辑门控 | `05-helpers-b.js` | `editGate` / `overrideFeasibility` / `frozenState` |
| 弹窗、卡片、行的视觉常量 | `06-tree.js` | 顺序敏感：`renderConfirm` 的 scrim 必须在 `renderRegionDialog` 之前 |
| 状态行与范围树 | `08-chrome-a.js` / `09-chrome-b.js` | 前半是数据整形，后半是元素构造 |
| 「我的 Prompt」面板与装配 toast | `10-toaster-mine.js` | `renderMinePanel` 与 §15 的写入锁同域 |
| chunk 的加载与降级 | `11-chunks.js` | 改完必须跑 `test/build.test.mjs`（清单 + 注册形态） |
| 更新检查与安装 | `12-update.js` | §17 / §18 |
| 页面状态机与请求 | `13/14/15-page-*.js` | 三段是同一个 `PromptSettingSection`；改动同时看 `src/README.md` 的切片说明 |

## 维护这份地图

段边界一旦调整（新增/合并/重切），这张表的行区间、行数、入口函数行号都要同步 ——
它们必须与 `docs/refactor-plan.md` §5.1 的目标段表一致。校验顺序：

```sh
node scripts/client-build.mjs --check        # src/ 与 client.js 逐字节一致
node scripts/locale-pack.mjs --check         # 词典生成段：src/ 的段与 client.js 同时核对
node docs/check-refs.mjs                     # §1.3 / §5.1 两张表复算 + 文档引用体检
node --test test/*.test.mjs                  # 全量用例（含段边界与行数预算）
```

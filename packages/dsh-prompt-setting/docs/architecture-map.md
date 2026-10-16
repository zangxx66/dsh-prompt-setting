# 客户端架构地图（`dsh-prompt-setting/client.js`）

**这份文档要回答的问题**：改一个功能点，该打开哪个文件？

`client.js` 是发布物（12382 行的单个 CommonJS factory），但**人不再直接编辑它** ——
它是 `src/` 的生成物（见 `CONTRACT.md` §23）。本表把「域」映射到：

**域 → `client.js` 行区间 → 段文件 → 入口函数 → CONTRACT 章节 → 测试文件**

## 坐标系（先读这一句）

表里的行号是**段真源坐标**：等于**去掉生成物头注**之后的 `client.js` 行号，也就是每个
`src/*.js` 切片自己的坐标。生成物顶部的 9 行「生成物，勿手改」头注由
`scripts/client-build.mjs` 注入、不属于任何段，所以它不参与本表的编号
（`docs/check-refs.mjs` 的 `CLIENT_HEAD_LINES` 就是这条约定的实现）。

段的划分与行数预算是 `docs/refactor-plan.md` §5.1 的**目标段表**（17 段，每段 ≤ 1200 行）。
重新生成：`node scripts/client-build.mjs --write`；校验：`node scripts/client-build.mjs --check`。

## 17 段总表

| 段文件 | `client.js` 行区间 | 行数 | 域 | 主要入口函数 | CONTRACT | 测试 |
|---|---|---:|---|---|---|---|
| `00-entry.js` | 1–215 | 215 | 文件头 + load 注册 + 指纹区间 + factory guard + `buildPlugin` 头 | `buildPlugin` (212)、`fingerprintOf` (167)、`fingerprintRegion` (150) | §13, §14 | `test/build.test.mjs`、`test/boot.test.mjs` |
| `01-shared-head.js` | 216–902 | 687 | launch shape 探测 + primitives probe + 常量 | `normalizeLaunchKind` (271)、`primitivesActive` (462)、`activeRenderer` (466) | §13 | `test/launch-kind.test.mjs`、`test/client.test.mjs` |
| `02-locale.js` | 903–2085 | 1183 | locale 内联段（`locale-pack.mjs --write` 产出，生成器原样嵌入） | —（数据段） | §22 | `test/locale.test.mjs` |
| `03-facilities.js` | 2086–2687 | 602 | `token` / `fallbackT` / fallback atoms / `PRIMITIVES_UI` / `tabs` | `tabs` (2419)、`FxButton` (2161)、`FxInput` (2197)、`safeT` (2679) | §13, §16 | `test/client.test.mjs`、`test/interpolate.test.mjs` |
| `04-helpers-a.js` | 2688–3338 | 651 | pure helpers 前半：会话/工作区探测、解码、过滤、标签 | `decodeSessions` (2798)、`filterSessions` (2853)、`decodeWorkspaces` (2971) | §13 | `test/client.test.mjs`、`test/route.test.mjs` |
| `05-helpers-b.js` | 3339–3943 | 605 | pure helpers 后半：冻结状态、编辑门控、覆盖可行性、`chunkStampMap` / `buildVerdict` | `chunkStampMap` (3378)、`buildVerdict` (3416)、`editGate` (3498)、`overrideFeasibility` (3563) | §13, §14 | `test/build.test.mjs`、`test/client.test.mjs`、`test/overrides.test.mjs` |
| `06-tree.js` | 3944–4608 | 665 | 样式表 + tree builders（scrim / dialog / card / row） | `scrimStyle` (3991)、`dialogCardStyle` (4147)、`matchesNeedle` (4371) | §13 | `test/client.test.mjs`（含 `scrimStyle(1200)` 先于 `scrimStyle(1000)` 的段序断言 2538–2542） |
| `07-stage2.js` | 4609–5255 | 647 | stage 2 helpers 后半：history/overview 作用域查询、分页、预留段模型 | `historyScopeQuery` (4629)、`historyPagerInfo` (4649)、`workspaceRows` (4780)、`modeOfEntry` (4959) | §8, §13, §21 | `test/history.test.mjs`、`test/stage2.test.mjs` |
| `08-chrome-a.js` | 5256–5997 | 742 | 状态行 / 版本行 / 范围树前半 | `renderStatusLine` (5330)、`renderStatusDetail` (5428)、`scopeRowStyle` (5728) | §13, §17 | `test/client.test.mjs`、`test/update.test.mjs` |
| `09-chrome-b.js` | 5998–6786 | 789 | `scopeTreeElement` / 会话与提示块渲染 / `renderConfirm` | `scopeTreeElement` (6120)、`renderSession` (6274)、`renderPromptBlock` (6547)、`renderConfirm` (6613) | §13, §15 | `test/client.test.mjs` |
| `10-toaster-mine.js` | 6787–7774 | 988 | g-062 装配状态 toast + `renderMinePanel` | `planAssemblyToasts` (6926)、`AssemblyToaster` (6981)、`renderMinePanel` (7329) | §15, §21 | `test/assembly-watch.test.mjs`、`test/custom.test.mjs`、`test/overrides.test.mjs` |
| `11-chunks.js` | 7775–8385 | 611 | chunk boundary（协议）：清单、加载、失败降级、tab 注册 | `loadChunk` (8084)、`chunkModule` (8189)、`chunkTab` (8314)、`renderChunkTab` (8343) | §14 | `test/build.test.mjs`、`test/client.test.mjs`、`test/assembly-watch.test.mjs` |
| `12-update.js` | 8386–9026 | 641 | 更新条 + 区域弹窗 + `renderSection` | `renderUpdateNotice` (8413)、`renderRegionDialog` (8690)、`renderSection` (8786) | §17, §18 | `test/update.test.mjs`、`test/route.test.mjs` |
| `13-page-a.js` | 9027–10226 | 1200 | `PromptSettingSection` 第 1 切：JSDoc + hooks/state | `PromptSettingSection` (9041) | §13, §15 | `test/client.test.mjs` |
| `14-page-b.js` | 10227–11424 | 1198 | `PromptSettingSection` 第 2 切：fetch / handlers | —（同一函数体内） | §10, §11, §13 | `test/client.test.mjs`、`test/transfer.test.mjs`、`test/presets.test.mjs` |
| `15-page-c.js` | 11425–12026 | 602 | `PromptSettingSection` 第 3 切：actions / model / root 树 | —（同一函数体内） | §13, §16 | `test/client.test.mjs`、`test/diff.test.mjs`、`test/history.test.mjs` |
| `16-boot.js` | 12027–12382 | 356 | `renderFailureCard` / `degradedPlugin` / boot 返回 | `renderFailureCard` (12039)、`degradedPlugin` (12311) | §7, §14 | `test/boot.test.mjs`、`test/client.test.mjs` |

**`13/14/15` 是同一个函数的三个切**：它们拼起来仍是**一个** `PromptSettingSection`
（`client.js:9041-12026`）。这是「只重切、不移动」能做到的最大粒度 —— 把一个 2986 行的
函数体拆开会让 `const` 的 TDZ 边界与函数声明的提升可见性发生变化，而没有测试能证明
那种移动无害（`CONTRACT.md` §23.2、方案 §5.1 R2-D2）。

## 常见改动落在哪

| 想改的东西 | 打开 | 备注 |
|---|---|---|
| 页面文案 / 键位 | `02-locale.js`（或 `locale/*.json` + `node scripts/locale-pack.mjs --write`） | 生成段，**不要手改段内文本**（§22） |
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
node docs/check-refs.mjs                     # §1.3 / §5.1 两张表复算 + 文档引用体检
node --test test/*.test.mjs                  # 全量用例（含段边界与行数预算）
```

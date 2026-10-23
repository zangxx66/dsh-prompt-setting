# dsh-prompt-setting 架构分析与重构方案（g-072）

> 本文档是 g-072 的唯一交付物：**只分析、只给方案，不改动任何产品代码**。
> 写作规则：每条关键判断附 `文件:行` 证据；未能实测的结论显式标注「未确认」。
> 基线：`c6bbccb`（dev），分析对象为 `packages/dsh-prompt-setting/`。
> 全部行号来自该基线，行号会随代码变动漂移，引用时以「函数名 + 行号」成对使用。

---

## 0. 摘要（先给结论）

1. **膨胀根因是机制性的，不是纪律问题**：chunk 准入条件是「被点击才到达的**整块 tab 渲染器**」（`client.js:8431-8479` 的注释与代码）。g-046 之后新做的 7 个提案里，只有 1 个（g-060 预设）满足该条件并新建了 chunk，其余 6 个（跨 tab chrome、默认 tab、生成物、页面模型）在结构上都不满足，只能回落到主入口。**只要这个准入条件不变，第三次拆分同样会失效。**

2. **「拆文件」在现有运行期协议下有硬天花板**：浏览器模块加载器里，主 factory 是唯一**同步可达**的模块（`dsh-client-modules/lib/client.js:831-850`：`require(spec)` 只认平台 seed、已 materialize 的模块、已注册的 factory；`require.async` 才是加载新文件的唯一路径，而它是异步的）。一个同步 factory 无法在自身执行期把"共享设施"从另一个文件取来。因此主入口里「共享设施 + 页面模型（`PromptSettingSection`，2640 行）+ 协议代码」这三块**结构上搬不走**。g-045/g-046 已经把能搬的都搬了（主入口 10249 → 8575，-1674 行）；剩下的 13942 行里，可搬部分已经不多。

3. **推荐方案：生成期分段（`src/` 源段 + 拼接生成 `client.js`）**。发布物、指纹区间、`CHUNK_STAMPS`、chunk 加载协议、`data-*` 冻结 marker **全部零改动**；改变的只是"人读哪几个文件"。这条路的全部方法论，包里**已经有一个在跑的同类先例**：`locale/*.json` → `client.js` 内联生成段（g-066），配 `--write`/`--check` + `scripts/prepare.mjs` 门禁 + `files` 白名单三件套。照搬即可，不需要发明新机制。

4. **配套（另立目标，不在本方案实施范围内）**：宿主侧 `index.js`（4626 行，ESM）可自由拆分——它不受 browser factory 协议约束，只有「`mount` 内闭包共享可变状态」这一项真实成本。**本方案不实施它**（§4.5、§7.2）：`mount` 闭包状态显式化是独立类型的重构，与客户端阶段 1/2 的风险面无关。

5. **不做的事**：不引入 bundler、不改 `client.js` 的注册形态、不动 `package.json` 的 `exports["./client"]`、不重写 DOM 结构。

---

## 1. 现状量化

### 1.1 文件规模（当前工作树，`wc -l` / `wc -c`）

| 文件 | 行数 | 体积 | 说明 |
|---|---:|---:|---|
| `client.js` | 13942 | 633 KB | 主 factory（浏览器侧唯一入口） |
| `index.js` | 5073 | 224 KB | 宿主侧 ESM 入口 |
| `core/update.js` | 1812 | — | |
| `client.history.js` | 1177 | 51 KB | chunk |
| `core/install.js` | 1064 | — | |
| `core/assembly-watch.js` | 965 | — | |
| `core/overrides.js` | 953 | — | |
| `core/presets.js` | 1030 | — | |
| `core/history.js` | 681 | — | |
| `core/store.js` | 676 | — | |
| `client.presets.js` | 640 | 26 KB | chunk |
| `client.overview.js` | 755 | 33 KB | chunk |
| `client.advanced.js` | 665 | 30 KB | chunk |
| `client.transfer.js` | 387 | 17 KB | chunk |
| 上列 14 个文件合计 | **28506** | — | `client.js` + `index.js` + 5 个 client chunk + `core/*.js`，可 `wc -l` 复算 |
| `scripts/*.mjs` | 1081 | — | `scripts/` 下 5 个脚本（`files` 白名单只含 `scripts`） |

5 个 chunk 合计 **3906** 行；主入口 **13942** 行。**本表只写当前工作树的实测值**（体积按 1024 B/KB 取整）；
与基线 `c6bbccb` 的逐项差异见 `NOTES.md` §153（g-073 与 g-074 的记录），此处不再混列基线列。

### 1.2 注释与代码的构成（可复算）

`client.js`：13942 行 = 空行 **304** + 注释约 **4526** + 代码约 **8009**（评审 R1-6 订正：原稿 294+4235+7351 加总为 11880，自相矛盾；本组数字在 g-084 后重新实测）。
`index.js`：4626 行 = 空行 **137** + 注释约 **2100** + 代码约 **2389**。

> 复算口径：以「文件按 `\n` 切分后的**实际行**」为准（`strip()==''` 记空行，行首为 `//` / `*` / `/*` 记注释），**不含**末尾换行产生的伪空行。注意 `locale/*.json` 的 569 行是 `wc -l` 口径，与本节的 split 口径不要混用。

**这组数字直接回应本目标的动机**：「读整个文件消耗过多 token」中，有 36%–45% 是注释与契约说明，剩下 7000 行里还有 1145 行是内联词典（见 §1.3）。也就是说，**读取代价 ≠ 代码复杂度**，其中相当一部分是"文档与生成物混住在同一个文件里"。

### 1.3 主入口版图（按 region 边界，`client.js`）

| 行区间 | 行数 | 内容 | 结构可拆性 |
|---|---:|---|---|
| 1–106 | 106 | 文件头 JSDoc | 不可拆（协议） |
| 107–114 | 8 | `window.__ModuleLoader__.load` 注册（107）+ factory 头（114） | 不可拆（协议） |
| 115–183 | 69 | build stamp region：`@build-fingerprint` begin（115）、`SELF_BUILD`（182） | 不可拆（协议） |
| 184–198 | 15 | 分隔行 + factory guard（185–198，g-013） | 不可拆 |
| 199–215 | 17 | `buildPlugin` 声明（212）+ `const React = require('react')`（213）+ `h`（214） | 不可拆（协议） |
| 216–297 | 82 | launch shape | 可拆 |
| 298–632 | 335 | 分隔行 + primitives probe（299–632） | 可拆（被全页共享） |
| 633–905 | 273 | 常量（`NS`、路由、`SCOPE_TOTAL_MAX` 等） | 共享 |
| **906–2105** | **1200** | **内联 locale 生成段（g-066）** | 生成物，见 §4.2 |
| 2106–2173 | 68 | 分隔行 + `fallbackT`、`token` 主题表 | 共享设施 |
| 2174–2297 | 124 | fallback atoms（`FxButton` 等） | 共享设施 |
| 2298–2707 | 410 | `PRIMITIVES_UI` 包装 + `tabs()` + `presetCountOf` 等 | 共享设施 |
| 2708–3963 | 1256 | pure helpers（`originOf`/`diffSections`/`stampOf` …） | 可拆，但需同步可达 |
| 3964–4491 | 528 | 分隔行 + tree builders（3965–4491） | 部分 |
| 4492–5275 | 784 | stage 2 helpers（history / diff / reset / transfer）+ `#endregion`（5275） | 部分 |
| 5276–6812 | 1537 | 分隔行 + 状态行 / 范围树 / 会话 / `renderConfirm` | 部分 |
| 6813–7182 | 370 | g-062 toaster（6807 `#region` … 7176 `#endregion`） | 跨 tab chrome |
| 7183–7960 | 778 | 装配状态 + `renderMinePanel`（7512） | 默认 tab |
| 7961–8571 | 611 | **chunk boundary（g-045 协议）** | 不可拆（协议） |
| 8572–9212 | 641 | 更新条 + 区域弹窗 + `renderSection`（8972）+ `#endregion`（9212） | 跨 tab chrome |
| 9213–9227 | 15 | `PromptSettingSection` 的 JSDoc | 随页面模型 |
| **9228–12483** | **3256** | **`PromptSettingSection`（页面模型：hooks/state/handlers/root 树）** | **不可拆（页面 root）** |
| 12484–13468 | 985 | `conversation.input.dock` 装配状态栏（g-086）：五分区只读 + 设置快捷入口（catalog 键位派发 + 定位）（`16-composer-bar.js`） | 可拆（独立段） |
| 13469–13481 | 13 | 分隔行 + `renderFailureCard` 的 JSDoc（13470–13480）+ 定义行（13481） | 协议 |
| 13482–13942 | 461 | `renderFailureCard` body / `degradedPlugin`（13871）/ boot 返回 | 协议 |

**上表互不重叠、首尾连续，行数合计 = 13942**（评审 R2-D1 订正：原稿把 `PromptSettingSection` 写成 `8884–11536` / 2652 行，实际函数体结束于 **12483**、**3256 行**；g-086 起 `13481` 是下一个函数 `renderFailureCard` 的定义行，其 JSDoc 在 13470–13480）。**每个区间都是一个连续的代码切片**——这正是 §5.1 段划分的依据（只重切、不移动）。

**坐标口径**：本表使用**段真源坐标**（`client.js` 去掉 9 行生成头注；生成物行号 = 本表 + 9，文件实际 12848 行）。§5.1 段表、`docs/architecture-map.md` 与 `test/client-source.test.mjs` 的 `SEGMENTS` 同此口径。

---

## 2. 架构事实梳理

### 2.1 包形态与两侧边界

- 本包是**零构建包**：`index.js` / `client.js` / `core/*.js` 本身就是发布入口（`scripts/prepare.mjs:1-30` 的文件头解释）。
- `package.json` 的 `exports["./client"] = "./client.js"`（`package.json:19`），`files` 白名单含 `client.js` 与 `client.*.js`（`package.json:22-33`）。
- `prepare` 钩子在**安装现场**做门禁：所有声明入口都在、都在白名单里、构建戳区间可用、chunk 清单一致、locale 词典一致（`scripts/prepare.mjs:170-186`）。

### 2.2 客户端模块协议（`window.__ModuleLoader__`）

证据来自宿主包的浏览器端实现：
`~/.local/share/pnpm/global/.../@deepseek-ai/dsh-client-modules/lib/client.js`（下称 `loader.js`）。

| 事实 | 证据 |
|---|---|
| 注册入口 `window.__ModuleLoader__.load({id, chunk?, factory})` | `client.js:107-114`；`loader.js:700-712` |
| factory 签名 `factory(require)`，同步执行、结果缓存 | `loader.js:804-828`（`materialize`，注释明写 "synchronous; memoized"） |
| `require(spec)` 是**同步**查表：平台 seed → 已 materialize → 已注册 factory，其余抛错 | `loader.js:831-840` |
| `require.async('./client.x.js')` 是**异步**加载；spec 必须 `./` 前缀且文件名匹配 `client.*.js` | `loader.js:842-848` |
| chunk 的内部 id 是 `pkg/fileName`，与主包共享同一张 module table | `loader.js:605-607`（`chunkId`） |
| chunk 里 `require('dsh-prompt-setting')` 能同步拿到主 factory 的导出（此时主包已 materialize） | 用法见 `client.history.js:36`；语义由 `loader.js:831-840` 保证 |
| **chunk 也能 `require.async` 另一个 chunk**：`importChunk` 传入的 `ownerId` 是主包 id（`materialize(id, ownerId)`），因此 chunk 的 `require` 与主包同源 | `loader.js:876`（`materialize(id, ownerId)`）、`loader.js:842` |
| chunk 的 URL 由宿主按 `record.entry.id + fileName` 拼出，**文件存在即被 serve**，无需插件侧路由 | `loader.js:610-614`（浏览器侧 `chunkUrl`）；宿主侧 `lib/index.js:222`、`952-976`（`chunkResponse`：文件不存在才 404） |
| 循环依赖被显式拒绝（factory-form CJS 无法交付半成品导出） | `loader.js:810-812` |

**由上述事实推出的三条硬边界**（本方案的关键约束）：

- **B1（同步可达唯一性）**：主 factory 的执行期内，只有"已经注册/已加载"的模块能同步取到。主 factory 自己就是**唯一保证同步可达**的模块 ⇒ 任何"主入口与 chunk 都要用的东西"必须住在主入口。
- **B2（异步不可回退）**：`require.async` 返回 thenable，主 factory 本身不能 `await`。想让共享设施住到别的文件，只能在 `apply(ctx)`（`client.js:12645`）阶段异步预加载并存入可变容器——**未实测**（见 §8）。
- **B3（新增 chunk 零宿主改动）**：只要文件名匹配 `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`（`core/store.js:326`）且与 `client.js` 同级平铺，宿主就会 serve 它。

### 2.3 共享设施与注入协议

- 主 factory 把跨 chunk 设施收在一个冻结面上：`const CHUNK_FACILITIES = Object.freeze({...})`（`client.js:8097`，区间 `8097–8186` = **90 行**），含 `h`/`token`/`UI`/`fmt`/`tabs`/`cardStyle`/`errorBanner`/`stampOf`/`layerLabel`/`diff*`/`scrimStyle` 等。
- chunk 侧取用方式：`const shared = require('dsh-prompt-setting').__internals.shared;`（`client.history.js:36`，同一段解构 20+ 个设施名）。
- 导出面：`client.js:13593-13596`（`__internals: { historyPanelHeight, workspaceRows, shared: CHUNK_FACILITIES, assemblyNotice: {...} }`）。
- 设计原则（代码注释明写）：**一份实例，不复制**——"a copy would be a second value that can drift away from the page it renders in"（`client.js:8089-8096`、`client.js:3980-3984`）。测试把这条原则固化成源码断言：chunk 里不得出现 `shared.` 之外的重复定义（`test/client.test.mjs:2376-2398`）。

> 这条原则是**为什么共享设施不能复制到 chunk**，也是 g-061「收敛复用」那批改动净增 601 行的原因之一：收敛的每一步都要先在主入口造门面 + JSDoc。

### 2.4 chunk 加载 / 失效协议

- 主入口持 5 个 chunk 的内嵌清单 `CHUNK_STAMPS`（`client.js:8080-8086`）。

```
{ name: 'client.advanced.js', hash: '20024f50', size: 21859 },
{ name: 'client.history.js',  hash: 'a3ec9d47', size: 50647 },
{ name: 'client.overview.js', hash: 'ddbcf423', size: 23861 },
{ name: 'client.presets.js',  hash: 'e1a665bb', size: 24079 },
{ name: 'client.transfer.js', hash: '8b305496', size: 9766 },
```

- 加载路径：`require.async('./client.history.js')` 包在 `React.lazy` 里（`client.js:8409`、`8229`、`8314-8382`），由 `loadChunk`（`client.js:8270-8273`）发出。
- 到达后记录自证摘要：`recordLoadedChunk`（`client.js:8281-8291`）→ `loadedChunkStamps()`（`client.js:8294`）→ 渲染为 `data-build-loaded`（`client.js:9187`）。
- 失败降级：`chunkFailureComponent`（`client.js:8315`）在该 tab 内渲染可读卡片，不掀翻整页；加载失败对照 `test/client.test.mjs:2067-2074`。
- 刷新订阅：主页面用 `useSyncExternalStore` 订阅 chunk 到达事件（`client.js:8207-8221`、`client.js:9236`），否则 `data-build-loaded` 会停在"没有 chunk 跑过"。
- **默认 tab 刻意不做 chunk**：`client.js:8455-8460` 的注释给出理由（首屏二次往返 + 失败即空白默认 tab）。这条决定了「我的 Prompt」那 **547 行**（`renderMinePanel`，`client.js:7512-8061`）**不能**按现有模式迁出。

### 2.5 指纹与清单机制

- 标记常量：`core/build.js:35-37`（`/* @build-fingerprint:begin */` / `end`）。
- 区间抽取与摘要：`fingerprintRegion`（`core/build.js:66-78`，拒绝重复/歧义标记；`:52-56` 的 `normalizeBuildText` 在它之前）、`fnv1a32`（`core/build.js:85-95`）、`fingerprintOf`（`core/build.js:101-105`），返回 8 位十六进制 hash + 区间 UTF-16 长度。
- 页面侧自证：`const SELF_BUILD = fingerprintOf(promptSettingFactory.toString());`（`client.js:182`），位于 factory body 第一条语句之后。
- 宿主侧读文件字节：`clientBuildInfo`（`core/store.js:298-318`），**每次 ping 重读、不缓存**（注释 `core/store.js:280-297` 说明理由）。
- 区间覆盖范围有测试硬约束：必须包含 `const React = require('react');`、`CHUNK_STAMPS`、末尾的 `'prompt-setting: section dictionaries'`（`test/build.test.mjs:136-172`）；区间 `size > 50000`（`test/build.test.mjs:171`）。
- 清单同步：`scripts/client-chunks.mjs` —— `readDeclaredStamps`（52）、`writeDeclaredStamps`（75）、`sameStamps`（91）、`main`（100，`--write` 重算 / 无参校验）。
- 清单真值与磁盘扫描：`clientChunkStamps(clientDir)`（`core/store.js:340-367`）按文件名排序后逐个 `fingerprintOf`，**标记不可用的文件被省略而非伪造**。
- 发布门禁：`inspectClientChunks`（`scripts/prepare.mjs:86-129`）→ `findings.push(...)`（`scripts/prepare.mjs:180`），不一致即 `PREPARE_FAIL` + 非零退出码。
- 三态判定：`chunkStampMap`（`client.js:3436`）、`buildVerdict`（`client.js:3436`），第三态是「未知」且**永不**报「过期」（`client.js:67-73` 头注释、CONTRACT §14.3）。

### 2.6 宿主读取 client.js 的方式

- 路径只解析一次，从模块自身 URL 出发（绝不用 cwd）：`index.js:231`（`CLIENT_BUNDLE_PATH`）。
- ping 里报告：`index.js:4906`（`clientBuild: clientBuildInfo(CLIENT_BUNDLE_PATH)`），随 `version`、`repositoryUrl`、`launchKind` 一起返回（`index.js:4895-4915`）。
- **含义**：宿主读的是**文件字节**，不关心文件里有多少个逻辑模块。任何"拆分后 client.js 仍是同一个文件"的方案，宿主侧零改动。

### 2.7 冻结契约与测试面

- `CONTRACT.md` 456 KB，章节 §1–§20+（`CONTRACT.md:630` 起）；与客户端形态直接相关的是 §13（客户端契约，`CONTRACT.md:2317`）、§13.0（六个一级 tab，`2313`）、§14（构建戳，`4439`，含 §14.2 `clientBuild`、§14.3 三态、§14.4 区间与归一化、§14.5 边界）。
- 测试规模：21 个 `test/*.test.mjs`，**实测 922 个用例全部通过**（`node --test test/*.test.mjs`，pass 922 / fail 0，本基线 `c6bbccb` 于本次分析中实跑）；`assert.*` 调用约 **6290** 处（`test/client.test.mjs` 单文件 2383 处断言 / 295 个用例）。
  > **命令注意**：Node 24 下 `node --test test/` 会把 `test/` 当模块名并报 `MODULE_NOT_FOUND`（实测）；可执行形式是 `node --test test/*.test.mjs`。仓库里的正确写法见 `README.md:364`（`node --test`，在包目录下自动发现）；`test/client.test.mjs:10` 的 `Run: node --test test/` 属历史写法。
  > 目标描述里"900+ 断言"应理解为**用例数**；实际断言调用数是六千量级。这个差别对本方案有利也有害：**用例数**决定回归成本，**断言数**决定源码文本断言的密度。
- **最硬的约束不是 DOM marker，而是"对源码文本的断言"**：
  - `test/client.test.mjs:2554-2558`：读 `client.js` 全文，用 `/scrimStyle\((\d+)\)/g` 断言出现顺序恰为 `['1200','1000']`（即 `renderConfirm` 先、`renderRegionDialog` 后）。**任何把这两处搬去别处或调换段序的动作都会打红这条**。
  - `test/client.test.mjs:2376-2398`、`2409`、`2440-2446`、`2536-2544`、`2625`、`2696-2702`、`2771-2776`：对 chunk 源码做正则/文本断言（不得复制 scrim、不得重定义共享设施、必须声明自己的 chunk 名）。
  - `test/build.test.mjs:174-198`：每个 `client.*.js` 必须自带一对标记、命名为具名函数表达式、且 `toString()` 自证。
  - `test/client.test.mjs:2024`：chunk 必须是 `client.js` 的**平铺同级文件**。
- DOM 侧：`data-plugin` / `data-renderer` / `data-render-state` / `data-phase` / `data-frozen-state` / `data-section-name` / `data-error-code` / `data-build*` / `data-region` 等 marker 由渲染树断言（`client.js:62-66` 头注释自述），是冻结面，**本方案一律不动**。

---

## 3. 膨胀根因分析（可核验）

### 3.1 数据：两次拆分与随后的回长

| 时间 | 提交 | client.js 行数 | 变化 |
|---|---|---:|---:|
| 2026-10-08 | `e54d1d5`（g-045 前） | 10249 | — |
| 2026-10-08 | `8618f6e`（g-045 拆出历史 tab） | 9505 | **−744** |
| 2026-10-08 | `3ff96bd`（g-046 拆出总览/备份/高级） | 8575 | **−930** |
| 2026-10-10 | `b9826bd`（g-058 保留段两层叠加） | 9423 | +848 |
| 2026-10-12 | `61bcdc4`（g-060 预设库） | 9815 | +392 |
| 2026-10-12 | `b0ef71e`（g-061 三批"收敛复用"） | 10416 | **+601** |
| 2026-10-13 | `861f871`（g-062 装配状态 toast） | 11207 | +791 |
| 2026-10-14 | `d4e470b`（g-066 locale 剥离） | 11560 | +353 |
| 2026-10-15 | `a9fa57a`（g-070 tab 改版） | 11843 | +283 |
| 2026-10-16 | `c6bbccb`（g-071 + R4 返工） | 11879 | +36 |

拆分净效果 **−1674 行**，随后 **+3304 行**（+38.5%），净比拆分前还多 **1630 行**。
复算命令（在仓库根执行）：

```
git show <sha>:packages/dsh-prompt-setting/client.js | wc -l
```

### 3.2 六个机制性原因（每条可核验）

**M1｜chunk 准入条件过窄 ⇒ 新增能力天然落在主入口。**
现有 chunk 的必要条件是「**被点击才到达的整块 tab 渲染器**」（`client.js:8431-8479` 注释 + 5 处 `React.lazy`）。g-046 之后新增的 7 个提案中：

| 提案 | 新增落点 | 是否满足 chunk 条件 |
|---|---|---|
| g-058 保留段两层叠加 | 主入口 +848 | ✗（默认 tab「我的 Prompt」内） |
| g-060 预设库 | **新建 `client.presets.js`** | ✓（第 6 个 tab） |
| g-061 三批收敛复用 | 主入口 +601 | ✗（跨 tab 共享设施） |
| g-062 装配状态 toast | 主入口 +791 | ✗（跨 tab chrome） |
| g-066 locale 剥离 | 主入口 +353（内联生成段 1145 行） | ✗（生成物 + 全页共享） |
| g-070 一级 tab 改版 | 主入口 +283 | ✗（跨 tab chrome） |
| g-071 范围选择器归位 + 返工 | 主入口 +36 | ✗（默认 tab + chrome） |

**7 个里只有 1 个新建了 chunk。** 这不是"大家忘了拆"，而是**准入条件把 6 个都排除了**。

**M2｜共享设施的唯一合法住处是主入口。**
由 §2.2 的 B1（同步可达唯一性）：`require('dsh-prompt-setting').__internals.shared` 是 chunk 拿设施的唯一路径（`client.history.js:36`），而它必须由主 factory 定义并导出（`client.js:8097`、`13593`）。**新增一个 chunk 的真实成本不是"搬走 500 行"，而是"先在主线造门面 + JSDoc + `shared` 导出 + 测试里的防复制断言"**。g-061「收敛复用」三批净增 601 行，正是这笔成本的实证。

**M3｜默认 tab 被设计排除在 chunk 之外。**
`client.js:8455-8460` 明确写出理由（首屏二次往返、失败即空白）。于是「我的 Prompt」这条**最活跃、改动最频繁**的线（g-058 / g-055 / g-056 / g-071 都在改它）永久住在主入口：`renderMinePanel` **547 行**（`client.js:7512-8061`）+ 页面模型里对应的大段 state/handler。

**M4｜生成物继续住在主入口。**
g-066 把文案真源搬到 `locale/*.json`（各 569 行），但**运行时读不到包内 JSON**，所以词典必须内联回 `client.js`（`client.js:906-910` 注释自述），留下 1145 行生成段。**这是第一个"文件变多了、主文件没变小"的先例**——它同时是本方案 §4.2 的可行性证据与 M4 的直接受害者。

**M5｜指纹区间覆盖整个 factory body ⇒ 每次改动都动主戳。**
`test/build.test.mjs:136-171` 要求区间覆盖 factory body 首尾。改主入口任意一行 ⇒ 主戳变 ⇒ 页面与宿主比对结果变。**这不直接导致膨胀，但它让"大文件内的任何小改动"都带有全局语义**，从而鼓励"把改动塞进已有的大函数里"而不是"新开一个模块再更新清单"。

**M6｜源码文本断言把"文件布局"冻结进了契约。**
`test/client.test.mjs:2554-2558` 用全文正则断言 `scrimStyle(1200)` 在 `scrimStyle(1000)` 之前。这类断言（§2.7 列了 8 组）让"搬家"从"改文件"升级为"改契约 + 改测试 + 改 CONTRACT"。**拆分成本上升是真实存在的，且可量化**：一次 g-070 规模的 tab 改版就要动 11 个文件、708 行（`git show --stat a9fa57a`）。

### 3.3 结论

> **在现有运行期协议下，「继续拆 `client.js`」不是解法。**
> 理由：可搬的部分（按 tab 归属的整块渲染器）在 g-045/g-046 已基本搬完；剩下的 13942 行中，协议代码（约 700 行）、共享设施（约 1000 行）、页面模型（2640 行）、内联生成段（1145 行）、默认 tab（547 行 + 对应 state）在结构上都不满足 chunk 准入条件。再拆只能靠①新增运行期协议（异步预加载共享模块）或②新增**生成期**分段。
> **触发回落的机制**（可直接引用的因果链）：`chunk 准入条件（M1）` × `共享设施只能住主入口（M2）` × `默认 tab 排除（M3）` × `生成物内联（M4）` = 新能力的默认归属是主入口；`指纹区间（M5）` 与 `源码文本断言（M6）` 进一步抬高搬家的边际成本。

---

## 4. 候选方案

四个候选，含"做与不做/换思路"的对照。

### 4.1 候选 A：继续按现有 chunk 协议拆（"再拆一次 tab"）

| 维度 | 评估 |
|---|---|
| 可行性 | 低。可搬的 tab 渲染器已经搬完：g-045 搬出 1 个（`client.history.js`）、g-046 搬出 3 个（`client.overview.js` / `client.transfer.js` / `client.advanced.js`），**合计 4 个**；第 5 个（`client.presets.js`）不是拆分所得，而是 g-060 新建 tab 时一并新建的。剩下满足准入条件的代码**几乎没有**（§3.3） |
| 硬约束冲突 | 与 M1/M2 正面冲突：新 chunk 会让 `CHUNK_STAMPS` 变长，但搬走的量远小于为它造门面的量 |
| 迁移成本 | 每个新 chunk ≈ 主入口加 30–80 行门面/JSDoc + 新文件 + `--write` 清单 + 测试防复制断言 |
| 风险 | 中。`client.js:8455-8460` 的"默认 tab 不做 chunk"若被打破，首屏会变成二次往返 + 失败即空白 |
| 对 922 用例的影响 | 中高：新增 chunk 会触发 `test/build.test.mjs:174-198`（标记/具名函数/自证）与 `test/client.test.mjs:2376-2398`（防复制）的连带修改 |
| **结论** | **不可行/收益为负**（净行数很可能增加），仅作为对照 |

### 4.2 候选 B：生成期分段（`src/` 源段 → 拼接生成 `client.js`）★推荐

把 `client.js` 按域拆成 `src/*.js` 源段，用一个生成脚本按固定顺序拼接成**今天的同一个 `client.js`**（发布物、字节形态、指纹区间、`CHUNK_STAMPS`、`exports` 全部不变）。

| 维度 | 评估 |
|---|---|
| 可行性 | **高**。包内已有完全同构的先例：`locale/*.json`（真源）→ `client.js` 内联生成段（`client.js:906-2105`）+ `scripts/locale-pack.mjs --write/--check` + `scripts/prepare.mjs:135-167`（含 `LOCALE-FILES` / `LOCALE-NOT-SHIPPED` 两条门禁）+ `files` 白名单含 `locale`（`package.json:27`） |
| 硬约束冲突 | ①「零构建包」定位需改口为「零**编译**，但有生成期拼接」——**这是契约级修改，需负责人裁决**；② 生成物与源码段可能漂移（用 `--check` 门禁解决，与 locale 同法）；③ 段序会影响 `test/client.test.mjs:2554` 的顺序断言（把该断言改为"段内断言"或固定段序即可，见 §5.2） |
| 迁移成本 | 阶段 1（零语义搬家）≈ 1 个生成脚本（150–250 行）+ `files` 加 `src`（1 行）+ `prepare` 加 `inspectClientSource()`（两条 finding，约 40 行）+ 2 个既有测试文件的**同步更新**（`test/host.test.mjs` 的 `files` 列举、`test/prepare.test.mjs` 的两个 fixture）+ 1 个新结构测试（约 40 行）。**产品代码 0 行改动** |
| 风险 | 低-中。最大风险是"有人直接改 `client.js`"——阶段 1 靠 `--check` 门禁 + prepare 非零退出码拦住。**阶段 1 不写生成物头注**（加头注会改变字节、破坏判据 2，见 §5.2 风险点）；头注推迟到阶段 2，那时本就要重排段边界、不再要求字节等价。与 `locale` 同属一套纪律 |
| 对 922 用例的影响 | **零**（`client.js` 字节等价，`fingerprintOf` 不变，所有 DOM 与源码文本断言原样通过）。阶段 1 的验收判据正是"生成物与现状字节级一致" |
| 收益 | 直接命中本目标的真实痛点：**把 13942 行切成 17 个 ≤1200 行的域段**（阶段 1 先按 §1.3 切 24 段、阶段 2 收敛到 17 段），改一个功能只需读 1 个域段 + 共享设施的接口部分 |

### 4.3 候选 C：扩展运行期协议（异步预加载"共享设施 chunk"）

新增 `client.shared.js`（React/theme/h 等设施），主入口在 `apply(ctx)` 里 `await require.async('./client.shared.js')` 后写入可变容器；主入口与所有 chunk 都改从容器取设施。

| 维度 | 评估 |
|---|---|
| 可行性 | **技术上有基础**：`importChunk` 的 `ownerId` 是主包，因此 chunk 之间也能 `require.async`（`loader.js:876`）；宿主会 serve 任何平铺的 `client.*.js`（`loader.js:952-976`）。**但未实测**（§8） |
| 硬约束冲突 | ① 主 factory 是同步的（`loader.js:804`），设施只能在 `apply` 之后可用 ⇒ 渲染前必须全部就位，失败路径需要新的降级设计；② `CHUNK_FACILITIES` 的"一份实例"原则要重新论证；③ `client.js:8097` 的设施被 5 个 chunk 解构，全部要改 |
| 迁移成本 | 高：5 个 chunk + 主入口的设施引用全改；指纹/清单机制不变但设施搬家会动 `test/client.test.mjs:2376-2398` 的防复制断言语义 |
| 风险 | **高**：出现"设施未就绪就渲染"的窗口 ⇒ 空白页，而空白页是本项目历来最忌讳的失败形态（`client.js:55-61` 的两条硬规则） |
| 收益 | 中：只搬走共享设施（约 1000 行），页面模型（2640 行）与默认 tab（547 行）仍在主入口 ⇒ **收益有天花板** |
| 对 922 用例的影响 | 高：`test/client.test.mjs:2376-2398`（chunk 只能通过 `shared` 取设施）与 `:2558-2566`（不得复制 scrim）的语义全部要重写；5 个 chunk 的取用方式连带改动 |
| **结论** | 不作为本版本推荐；若未来要新增"非 tab 的按需大块"，可作为独立目标评估 |

### 4.4 候选 D：不拆文件，改"读取代价"本身（导航 + 索引 + 工作流）

不动代码结构，只做：`docs/architecture-map.md`（域 → 行区间 → 入口函数的索引）、CONTRACT 的客户端章节加"读哪一段"指针、要求改动前先 `grep` 定位。

| 维度 | 评估 |
|---|---|
| 可行性 | 高，零风险，立即可做 |
| 硬约束冲突 | 无 |
| 迁移成本 | 极低（1–2 个文档） |
| 风险 | 无技术风险；**但没有强制力**——`client.js` 仍在长，第三次膨胀不会被拦住 |
| 收益 | 小-中：能省下"从头读到目标函数"的 token，但单次改动仍需读一个 2640 行的页面模型函数 |
| 对 922 用例的影响 | **零**（不改任何代码） |
| **结论** | **作为推荐方案的补强件保留**（阶段 0 交付），不作为唯一方案 |

### 4.5 候选 E（附带）：宿主侧 `index.js` 拆分

`index.js` 是 `"type": "module"` 的 ESM（`package.json:15`），**不受 factory 协议约束**，可以自由 `import`。真正的成本只有一项：`mount`（`index.js:988-5164`，**约 4078 行**）内部 60+ 个闭包共享可变状态（`report`、layers 缓存、`variables` 等，例如 `index.js:1131-1198`、`1615-1657`、`1692-1763`）。注意 `export function apply`（`index.js:783-797`）只有 15 行，是 `mount` 的薄守卫（`try { mount(...) } catch { reportMountFailure(...) }`）——**巨型函数是 `mount`，不是 `apply`**（评审 R1-12 订正）。

| 维度 | 评估 |
|---|---|
| 可行性 | 高（需要一次"闭包状态显式化"的小重构） |
| 硬约束冲突 | 无协议冲突；但 `core/*.js` 已有 18 个模块，新模块要遵守既有的纯函数 + 注入惯例 |
| 迁移成本 | 中：每搬一个域（如 history/export/diff/rollback/import 五个 handler，`index.js:2404-2765`）需显式传入 state 访问器 |
| 风险 | 中（宿主侧改坏 = 插件起不来；但 `test/route.test.mjs` 822 断言 / 109 用例是强网） |
| 收益 | 4626 → 最大模块约 800 行（把 `mount` 的 3630 行按域搬出后）；宿主侧注释占比 45%，拆分收益明显（若另立目标并实施） |
| 对 922 用例的影响 | **中**：`test/route.test.mjs`（822 断言 / 109 用例）、`test/host.test.mjs`、`test/integration.test.mjs` 覆盖宿主路由；拆分为纯搬运时断言不动，但 `mount` 状态显式化会触及多处闭包引用 |
| **结论** | **另立目标**（不在本方案实施范围内）。宿主侧可拆是真事实，但 `mount`（`index.js:988-5164`）的闭包状态显式化是独立类型的重构；本方案只做客户端生成期分段，把它列为 §7.2 的另立目标 |

---

## 5. 推荐方案（唯一）：候选 B + 补强 D + 后续 E

### 5.0 为什么是 B

1. **它解决的是真实痛点**：读取代价由"文件字节数"决定，而不是由"模块数量"决定。B 把 13942 行切成域段，**每一个功能点都能被指到一个 ≤1200 行的文件**（§5.1 目标段表）；而 A/C 受 B1/B2 限制，永远在主入口留下 2640 行的页面模型。
2. **它对冻结契约零侵入**：发布物仍是同一个 `client.js`，指纹区间、`CHUNK_STAMPS`、chunk 加载、`data-*` marker、922 个用例全部原样有效。相较 A/C，这是**唯一一个"阶段 1 可以用字节等价来验收"**的方案。
3. **它不需要发明机制**：`locale/*.json` 已经在包里跑着"真源在别处、生成物在 `client.js`、门禁在 prepare、白名单在 files"这一整套（`scripts/prepare.mjs:135-167`、`package.json:27`）。
4. **它可回滚到零**：删掉 `src/` 与生成脚本，`client.js` 就是唯一真源（回到今天）。

**被否方案与否决理由**：候选 A（收益为负，§4.1）；候选 C（空白页风险 + 收益天花板，§4.3）；候选 D 单独使用（无强制力，§4.4）。候选 E 保留为后续阶段（见 §4.5 与 §5.2 的「阶段 3」）。

### 5.1 目标形态

```
packages/dsh-prompt-setting/
  client.js                 ← 生成物：**阶段 1 与今天逐字节相同，不加任何头注**；阶段 2 起加"生成物，勿手改"头注
  src/                      ← 每个文件 = client.js 里**一段连续区间**的切片（编号按代码顺序递增）
    ...（阶段 1 先按 §1.3 的 24 个区间一一对应，阶段 2 再合并/细分，见下表）
  scripts/
    client-build.mjs        拼接 + --check（新）
    client-chunks.mjs       原样保留（清单仍写在生成物里，但改由 client-build 调用）
```

**段边界规则（R2-D2，选方案 ①「只重切、不移动」）**

1. **每个段文件必须对应 `client.js` 中一段连续区间**，且**段编号按该区间在文件中的出现顺序递增**；
2. **任何段划分都不得让代码块跨段移动**——阶段 2 允许的只有"在连续区间内部换切点"与"合并相邻段"，**不允许**把 `renderMinePanel`（**7329–7875**）或 chunk boundary（7775–8385）这类块搬到别处；
3. 由此，**「文件名字典序 = 代码顺序」是段划分规则的自动结果**，不是一条需要单独维护的约定（§9-3）；
4. 段之间**不共享作用域**：每段都是同一 factory body 的一部分，拼接后共处一个函数作用域 ⇒ **不需要 `import`/`export`，不需要改任何变量可见性**。

> 为什么必须是 ①：被拆的是**同一个函数体内的 13942 行**，跨块移动会改变 `const` 的 TDZ 边界与函数声明的提升可见性，而这类语义变化**没有任何现成测试能证明无害**。方案 ② （允许移动 + 增列 TDZ/提升风险与验证）虽然理论可行，但把一个"零语义变化"的重构变成"需要语义审计"的重构，收益不变而风险显著上升。

**阶段 2 的目标段划分（示例切点；每个段仍是连续区间，切点按函数边界微调）**

| 段 | 行区间（现状） | 行数 | 内容 |
|---|---|---:|---|
| `00-entry.js` | 1–215 | 215 | 文件头 + load 注册 + 指纹区间 + factory guard + `buildPlugin` 头 |
| `01-shared-head.js` | 216–905 | 690 | launch shape + primitives probe + 常量 |
| `02-locale.js` | 906–2105 | 1200 | locale 内联段（由 `locale-pack.mjs --write` 产出，生成器原样嵌入） |
| `03-facilities.js` | 2106–2707 | 602 | `token` / `fallbackT` / fallback atoms / `PRIMITIVES_UI` / `tabs` |
| `04-helpers-a.js` | 2708–3358 | 651 | pure helpers 前半 |
| `05-helpers-b.js` | 3359–3963 | 605 | pure helpers 后半（含 `chunkStampMap` / `buildVerdict`） |
| `06-tree.js` | 3964–4628 | 665 | tree builders + stage 2 helpers 前半 |
| `07-stage2.js` | 4629–5275 | 647 | stage 2 helpers 后半 |
| `08-chrome-a.js` | 5276–6017 | 742 | 状态行 / 范围树 / 会话 |
| `09-chrome-b.js` | 6018–6812 | 795 | `scopeTreeElement` / `renderConfirm` |
| `10-toaster-mine.js` | 6813–7960 | 1148 | g-062 toaster + 装配状态 + `renderMinePanel` |
| `11-chunks.js` | 7961–8571 | 611 | chunk boundary（协议） |
| `12-update.js` | 8572–9212 | 641 | 更新条 + 区域弹窗 + `renderSection` |
| `13-page-a.js` | 9213–10402 | 1190 | `PromptSettingSection`：JSDoc + hooks/state |
| `14-page-b.js` | 10403–11600 | 1198 | `PromptSettingSection`：fetch / handlers |
| `15-page-c.js` | 11601–12483 | 883 | `PromptSettingSection`：actions / model / root 树 |
| `16-composer-bar.js` | 12484–13468 | 985 | g-086 装配状态栏（`conversation.input.dock`） |
| `17-boot.js` | 13469–13942 | 474 | `renderFailureCard` / `degradedPlugin` / boot 返回 |

合计 13942 行，每段 ≤ 1200 行（最大段是 `02-locale.js` 1200 —— 生成段，597 键 × 2 语言；g-086 新增的 `16-composer-bar.js` 985 行，boot 段随之下移）。**注意 `13/14/15` 三段切的是同一个函数的函数体内部**——它们拼接后仍是同一个 `PromptSettingSection`，这是"只重切、不移动"能做到的最大粒度。

### 5.2 分阶段落地

#### 阶段 0：导航补强（本版本可做，零风险）

- 交付 `docs/architecture-map.md`：域 → `client.js` 行区间 → 入口函数 → 相关 CONTRACT 章节 → 相关测试文件。
- 交付 `docs/refactor-plan.md`（本文档）。
- 交付 `docs/check-refs.mjs`：本文档的**引用体检 + 两张表复算**脚本（只读；评审 R3-R5 的治本项，R4 收敛轮加固为 **fail-closed**）。它逐条断言文档里可自动核验的 `文件:行` 引用与区间端点，复算 §1.3/§5.1 两张表的不变式，并把**仓库外**引用如实列进人工清单；归属失败 / 包内读不到 / 越界一律非零退出。**阶段 1/2 每改动一次代码或文档，都应先跑它**（§10 有复跑命令、口径说明与实跑输出）。
- **可验证判据**：文档存在；随机抽 5 个域，按文档给出的行区间能定位到正确函数（人工核对即可，不需自动化）。
- **影响文件**：`docs/*.md`（2 个新文件）。
- **回滚**：删除文档。

#### 阶段 1：生成管线就位，**零语义搬家**（本版本可做，核心阶段）

目标：生成脚本能把今天的 `client.js` **逐字节重建**。段边界先用 §1.3 的现有 region 边界，不做任何重排。

- 新增 `scripts/client-build.mjs`：
  - `readSegments()`：**按 `src/` 下的文件名字典序扫描**读段（段编号递增 ⇒ 字典序即代码顺序，见 §5.1 规则①；**不需要**手工维护一份顺序清单）；
  - `renderClient()`：拼接 + 调 `clientChunkStamps()` 重算 `CHUNK_STAMPS` 块（复用 `scripts/client-chunks.mjs` 的 `renderStampRows`/`writeDeclaredStamps`/`readDeclaredStamps`，`scripts/client-chunks.mjs:43-99`）。**阶段 1 不写任何头注**（R1-1：加头注会改变字节、与判据 2 互斥）；
  - `--write` 写 `client.js`（**仅当内容不同才落盘**，见 §6.2 闸门 5）；无参 `--check` 对比并返回非零退出码。
- `package.json`：`files` 增加 `"src"`（紧挨 `"client.js"`）；`scripts` 增加 `"client:build"` / `"client:check"`。
- `scripts/prepare.mjs`：仿 `inspectLocale`（`scripts/prepare.mjs:135-167`）加 `inspectClientSource()`，**三态语义照抄**（R1-3）：
  - **N/A**：既无 `src/` 目录、`files` 也未声明 `src` ⇒ **通过**并报 `CLIENT-SRC-N/A`（对应 `scripts/prepare.mjs:139-145` 的 `LOCALE-SYNC-N/A`；这是为了不把「合法的无 src 包」判死，`test/prepare.test.mjs:440-485` 的最小 fixture 就是这种包）；
  - `CLIENT-SRC-FILES`：声明了或目录存在，但段文件缺失 ⇒ FAIL；
  - `CLIENT-SRC-NOT-SHIPPED`：`src/` 存在或已声明，却不在 `files` 白名单 ⇒ FAIL（照搬 `scripts/prepare.mjs:150-157` 的 `LOCALE-NOT-SHIPPED` 逻辑）。
- 新增 `test/client-source.test.mjs`（或并入 `test/build.test.mjs`）：断言 `renderClient()` 的输出与磁盘 `client.js` **逐字节一致**。
- 既有测试的**同步更新**（预期内，非缺陷）：
  - `test/host.test.mjs:171-197` 的 `assert.deepEqual(packageJson.files, [...])` 是「发布面精确枚举」守卫，10 项以 `'scripts'` 结尾（`:194-196` 还断言不得含 `test` / `.dsh-graph` / `node_modules`）；加 `src` 必须同项更新（并补注释说明理由，照 g-045/g-066 加白名单项时的写法）；
  - `test/prepare.test.mjs:487-539` 的 faithful copy 目录列表 `['core','scripts','locale']` 需加 `src`，并同步新增 `src/` 源段文件（否则会因缺段而 FAIL，理由与 g-066 加 `locale` 时完全相同）。

**可验证判据（阶段 1 的验收门）**
1. `node scripts/client-build.mjs --check` 退出码 `0`；
2. `node scripts/client-build.mjs --write && git diff --exit-code packages/dsh-prompt-setting/client.js` 退出码 `0`（**生成物与现状字节等价**；前提是阶段 1 不写头注，见上）；
3. `node --test test/*.test.mjs` 全绿。**既有断言文本零改动**（R1-2 / R2-D4 订正）：阶段 1 的测试面改动只有三类 —— ①`test/host.test.mjs:171-197` 的 `files` 白名单枚举同步、②`test/prepare.test.mjs` 的两个 fixture 同步、③**新增**结构用例（可并入 `test/build.test.mjs` 或新建 `test/client-source.test.mjs`）。除这三类外，既有断言一行不改（字节等价 ⇒ `fingerprintOf` 与所有 DOM / 源码文本断言原样成立）；
4. `node scripts/prepare.mjs` 退出码 `0`，且输出含 `CLIENT-SRC` 相关 finding；
5. **幂等判据（已实测，见 §8-U3 与本节"实跑证据"）**：`writeDeclaredStamps(clientSource, clientChunkStamps(pkgDir)) === clientSource` 为 `true` ⇒ 正常状态下 `--write` 产出与磁盘逐字节相同，`git diff` 为空、**不触碰 mtime**（这一点同时是 §6.2 闸门 5 的依据）；
6. 负向对照：手工改一行 `src/03-facilities.js` 后 `--check` 必须**非零退出**；不改 `src` 只改 `client.js` 后 `--check` 也必须**非零退出**；
7. `node docs/check-refs.mjs` 退出码 `0`（文档引用与两张表自洽；`unresolved+failed=0`）。

**实跑证据（本次返工为验证上述判据所做）**

```
$ node --input-type=module -e "..."   # 见 §10「本次返工实跑」
sameStamps(declared, actual)               = true
writeDeclaredStamps(src, actual) === src   = true      # 判据 5（幂等）
fingerprintOf(client.js)                   = 4d998612 / 567230
fingerprintOf(加 1 行头注后的同一文件)      = 4d998612 / 567230   # 指纹不变…
(加头注后的文件) === (原文件)              = false     # …但字节变 ⇒ 判据 2 与头注互斥（R1-1）
```

**影响文件清单**：`scripts/client-build.mjs`（新）、`package.json`、`scripts/prepare.mjs`、`test/build.test.mjs`（追加用例）、`src/*.js`（新，由 `client.js` 切分）、`client.js`（成为生成物；**阶段 1 内容不变、不加头注**）、`test/host.test.mjs`（`files` 枚举同步）、`test/prepare.test.mjs`（两个 fixture 同步）。

**回滚方式**：`client.js` 是生成物且**内容未变**（阶段 1 不加头注、字节等价）⇒ 删除 `src/` 与 `scripts/client-build.mjs`、回退 `package.json` / `scripts/prepare.mjs` 与三处测试改动（`test/build.test.mjs` 追加用例、`test/host.test.mjs`、`test/prepare.test.mjs`）即可，**产品行为零影响**。

**风险点与实现约束（阶段 1 必须处理的细节）**
- **不写头注（R1-1，硬约束）**：判据 2 要求逐字节等价，而任何头注都会改变字节。实测（§10 实跑）：加 1 行头注后指纹 hash/size **不变**（仍 `4d998612 / 567230`），但字节**已变**。所以两条不能并存，阶段 1 **选"不加头注"**；头注移到阶段 2（那时本就要重排段边界，本就不追求字节等价）。
- **段序敏感**：`test/client.test.mjs:2554-2558` 断言 `scrimStyle(1200)` 先于 `scrimStyle(1000)`。阶段 1 保持现有顺序即天然满足；阶段 2 重排时必须保留"`renderConfirm` 段在 `renderRegionDialog` 段之前"。
- **拼接的实现约束（R1-11 + R2-D2，写进生成器与它的测试）**：
  1. **段间不插任何分隔符**（不加注释、不加空行）；
  2. **末尾换行与现状一致**：文件为 UTF-8、**无 CR**（实测 `grep -c $'\r' client.js` = 0），最后一行是 `});` 后紧跟一个 `\n`（实测末字节 `} ) ; \n`）；
  3. 段的**首行声明**（阶段 2 起每段头一行「片段，不是独立模块」）由生成器在拼接前**剥离**；除此之外生成器**只做「剥离段首声明行 + 按序号 concat」**，不做任何 trim / 归一化 / 空行处理（否则 `fingerprintOf` 的 UTF-16 长度与 hash 会变）。两条配套断言：①每个段文件的首行必须**恰好**是那行声明（否则 `--check` 非零退出）；②剥离后拼接的产物与阶段 1 逐字节相同；
  4. **拼接顺序 == 段内代码在 `client.js` 中的出现顺序**（由段编号递增保证）；**任何段划分不得导致代码块跨段移动**——生成器与结构测试都要守这一条（阶段 2 判据 2/3 是它的机器证明）。
- **`CHUNK_STAMPS` 的写入权**：生成器负责渲染清单，`scripts/client-chunks.mjs --write` 保留但改为"改生成物的清单块"——两条路径必须都收敛到同一结果（用 `sameStamps`、`writeDeclaredStamps` 的幂等性断言，`scripts/client-chunks.mjs:93`、`:75`；幂等已实测为 `true`，见 §8-U3）。
- **段文件不是独立合法 JS（R1-9，阶段 2 起显式存在）**：从阶段 2 开始，段文件（尤其 `13/14/15-page-*.js` 这三段）**语法上不完整**——它们只是同一 factory body 的连续切片，单独 `parse`/`lint` 必然报错，却会随 `files` 白名单发布。处理方式（本方案的选择）：
  - **保持 `.js` 后缀**，但在 `src/README.md`（或本文件 §5.1）与每个段文件头一行明确「本文件是 `client.js` 的**片段**，不是独立模块，**不得单独 parse/lint/执行**；合法性由 `client-build.mjs --check` 证明」；
  - 发布它们的理由与 `locale/*.json` 相同：让装到用户机器上的包带着**可再生成、可 diff 的真源**（`scripts/prepare.mjs:150-157` 的 `LOCALE-NOT-SHIPPED` 守护同一条理由）；
  - 备选（阶段 2 裁决项，见 §9-5）：改用区分后缀 `.js.part` / `.seg`，让"不可单独解析"体现在文件名上，代价是编辑器语法高亮与 diff 体验变差。

#### 阶段 2：按域重排段边界 + 行数预算（本版本可做）

在阶段 1 的管线之上，把段边界从"照抄 §1.3 区间"改为 §5.1 的**目标段划分**（合并相邻小段、把超预算段在**连续区间内部**再切）。**阶段 2 起不再要求字节等价**（因为要加头注），但**仍要求"代码一行不移动"**（§5.1 段边界规则②），因此以下两件在阶段 1 被推迟的事在此落地：
- **`client.js` 加"生成物，勿手改"头注**（约 8–15 行）。头注必须落在 fingerprint begin 标记**之前**（现为 `client.js:115`；头部注释区 1–106、load 注册 107–114），不污染指纹；
- 段文件头各加一行「片段，不是独立模块」声明（§5.2 风险点 R1-9）。**这行声明不会进入 `client.js`**——生成器在拼接前逐段剥离它（见 §5.2 实现约束第 3 条），所以它不影响阶段 2 判据 2 的逐字节比对。

其它重点：
- 把 **2640 行**的 `PromptSettingSection`（`client.js:9227-12483`）在**函数体内部**沿连续区间切成 3 段（`13-page-a/b/c`：JSDoc+hooks/state、fetch/handlers、root 树）——拼接后仍是同一个函数体，不移动任何行；
- locale 生成段（`02-locale.js`，1145 行）与其它段解耦：内容由 `scripts/locale-pack.mjs --write` 产出，生成器原样嵌入；
- 合并相邻小段（如 §1.3 的 216–902 三段合成 `01-shared-head.js`），把段数从阶段 1 的 24 段收敛到 17 段。

**可验证判据**
1. `node scripts/client-build.mjs --check` 退出码 `0`；`node --test test/*.test.mjs` 全绿；
2. **代码零移动的强判据**：阶段 2 生成的 `client.js` **去掉文件顶部的生成物头注**后，与阶段 1 的产物**逐字节相同**。`tail -n +K`（`K` = 头注行数 + 1）在这里是成立的，因为**段首声明不进产物**（生成器已逐段剥离，见 §5.2 实现约束第 3 条）——只有文件最顶部那一段头注需要跳过。这条判据同时证明"只重切、不移动"，且比任何语义断言都强；
3. **新增结构断言**：每个 `src/*.js` 段 ≤ 1200 行；段的「声明行区间」在生成物中**单调递增且无空隙**（机器可验证：逐段记录首行在生成物中的偏移，偏移严格递增、前一段末行 + 1 = 后一段首行）；
4. 同一功能点的改动**只触及 1 个段**（人工作业纪律，写进 CONTRACT，见 §6.2）；
5. 头注落在 begin 标记之前：`clientSource.indexOf(头注) < clientSource.indexOf(BEGIN)`（该断言在 `test/build.test.mjs:142`）；
6. `node docs/check-refs.mjs` 退出码 `0`（含 §5.1 段表的复算：连续、合计 13942、每段 ≤ 1200）。

**影响文件清单**：`src/*.js`（重切）、新增 `test/client-source.test.mjs` 的结构断言、`CONTRACT.md`（新增客户端源码布局条款）、`README.md`。

**回滚方式**：段重切不移动任何代码（判据 2 保证）⇒ 回退 `src/` 目录到阶段 1 的切分，或直接回退生成器；两者都不影响产品行为。

#### 阶段 3（另立目标）：宿主侧 `index.js` 拆分

见 §4.5。建议单独立目标，理由是：宿主侧是 ESM 自由拆分，但 `mount`（`index.js:988-5164`，约 4078 行）的闭包状态显式化是一次真正的重构，风险面与客户端阶段 1/2 完全不同，混在一起会互相拖累。`apply`（`:783-797`）只是 15 行的守卫，不构成拆分对象。

#### 阶段 4（另立目标，可选）：运行期 chunk 协议扩展

即候选 C。**只有在出现"非 tab 的按需大块"需求时才做**，且必须先解决"设施未就绪即渲染"的降级路径。

### 5.3 每阶段判据的汇总（可直接进 dsh-graph 的 criteria）

| 阶段 | 判据 |
|---|---|
| 0 | 两份文档存在；抽样 5 个域可定位 |
| 1 | `--check` = 0；`--write` 后 `git diff` 为空（**且阶段 1 不含头注**）；生成器幂等（`writeDeclaredStamps(...) === clientSource`）；`node --test test/*.test.mjs` 全绿（仅 `test/host.test.mjs` 的 `files` 枚举与 `test/prepare.test.mjs` 的两个 fixture 属预期内同步更新）；`prepare` = 0 且含 `CLIENT-SRC` finding；两条负向对照（改 `src` / 改 `client.js`）均非零退出；`node docs/check-refs.mjs` = 0 |
| 2 | 阶段 1 全部判据 + 每段 ≤ 1200 行 + 段总行数对账通过 + 代码零移动（去头注后与阶段 1 产物逐字节相同）+ 头注在 begin 标记之前 + CONTRACT 有新条款 |
| 3 | 另立目标（`index.js` ≤ 800 行/模块，`route.test.mjs` / `host.test.mjs` / `integration.test.mjs` 全绿） |
| 4 | 另立目标 |

### 5.4 与既有目标的关系

- **不改** `CONTRACT.md` 的既有条款正文（只允许**新增**客户端源码布局条款，作为阶段 2 的一部分；本目标不写）。
- **不改** `test/*.test.mjs` 的**断言语义**。阶段 1 允许两处**预期内的同步更新**（`test/host.test.mjs` 的 `files` 白名单枚举、`test/prepare.test.mjs` 的两个 fixture，见 §5.2）；阶段 2 只允许**新增**结构断言。
- 与 g-045/g-046 的关系：那两次是**运行期**拆分（真实减少首屏字节），本方案是**生成期**分段（真实减少读取代价）。两者互补，**不互相取代**。

---

## 6. 收益量化与长期锁定

### 6.1 收益量化

**统一口径**：下文只用**一个**口径 —— `C = 为完成一次改动而必须载入上下文的代码行数`（含注释行）。现状列与目标列按**同一类改动**对齐；不把"全量通读"与"单域改动"混在一张表里比较（评审 R1-7 订正）。

| 改动类型 | 现状 C | 目标 C（阶段 2 后） | 口径说明 |
|---|---:|---:|---|
| **A. 单域内改动**（tab 视觉/交互、某个 helper） | 800–2000 | 400–1200 | 现状 = `grep` 定位 + 读目标函数 + 读 `CHUNK_FACILITIES` 接口段；目标 = 读 1 个域段 + 设施段接口。**实证**：g-070（`git show --stat a9fa57a`）动 11 个文件 708 行，其中 `client.js +257/−36`、`test/client.test.mjs +245`、`CONTRACT.md +91` |
| **B. 页面模型内部改动**（state / fetch / handler） | **2640（一个不可分的函数体）** | 600–1200 | `PromptSettingSection`（`client.js:9227-12483`）闭包互相引用，现状无法局部读；目标 = `13/14/15-page-*.js` 三段之一 |
| **C. 跨段改动 / 共享设施签名变更** | 2000–3500 | **2000–3500（不降）** | 必须 `grep` 全库找调用点，分段**不改变**这一点 |
| **D. 全量通读**（接手、审计；罕见） | 13942 | ≤1200（最大段）+ 生成器 | 只有这一类是「全量 vs 最大段」；**不得**用它的降幅代表整体收益 |
| **E. 宿主侧**（另立目标，本方案不实施） | 4626（其中 `mount` 3630 不可分） | ≤800 | 见 §7.2 |

**收益的正确表述**：典型场景是 A 与 B。**B 行的降幅是稳定的**（2640 → 600–1200 = **−54.5%~−77.3%**，因为现状是一个不可分割的函数体）；**A 行的 −40% 只是乐观端**，存在端点交叉（见下方边界 4）。D 的 **−90%** 只在罕见场景成立——`13942 → 最大段 ≤1200` 属于 D 行，**不得**挪用作整体结论。

**必须同时披露的四条边界**
1. **跨段改动不降**（C 行）：调用点仍要靠 `grep` 全库找，共享设施被 5 个 chunk 解构的事实不变（`client.history.js:36` 及另外 4 个 chunk 的同名解构段）。
2. **契约与测试体量不降**：`CONTRACT.md` 456 KB、`test/client.test.mjs` 2383 处断言，是独立于 `client.js` 的阅读面（§1.2、§2.7）。
3. **注释占比不降**：分段后每段仍是 36%–45% 的注释密度（§1.2 口径），token 侧降幅与行数降幅同量级，不会更好。
4. **A 行的端点交叉（R2-D8）**：A 行现状下界（800）**低于**目标上界（1200）。当一次改动的实际探查面本来就小于一个域段时（为改 20 行而「读整段 1200 行」），**可能比现状精读更贵**。所以 A 行的 −40% 是**乐观端、不是保证**；稳定收益来自 B 行（不可分割的 2640 行函数体）与「理解一个陌生域」这一类。

### 6.2 收益如何被机制长期锁定

**否则会第三次长回来**——这不是危言，§3.1 已经量过一次。锁定的四道闸：

1. **生成物不可手改（自动拦截）**：`scripts/client-build.mjs --check` 与 `scripts/prepare.mjs` 门禁（照搬 `scripts/prepare.mjs:86-129` 的 `CHUNK-STAMPS` 模式）在**安装/发布路径**上拦截"直接改 `client.js`"。**阶段 1 没有头注**（字节等价优先），拦截完全依赖 `--check`；**阶段 2 起**再给 `client.js` 加"生成物，勿手改"头注，作为对读者的第一道提示。这是**已有的成功范式**：`CHUNK-STAMPS` 与 `LOCALE-SYNC` 都是这么守住的（`scripts/prepare.mjs:180-183`）。
2. **段行数预算（自动拦截）**：结构测试断言 `每个 src/*.js ≤ 1200 行`。这是唯一能阻止"往一个段里堆功能"的机械闸门——**g-045 之后之所以回长，就是因为没有任何行数闸门**。
3. **归属决策树写进 CONTRACT（人可判、机器可查）**：

   | 新增/修改的东西 | 归属（段名见 §5.1 目标段表） |
   |---|---|
   | **指纹标记的书写位置**：`begin`（`client.js:115`） | `00-entry.js`（1–215） |
   | **指纹标记的书写位置**：`end`（`client.js:13940`） | `17-boot.js`（13469–13942） |
   | **被两端标记覆盖的区间**（`115–12483`） | **横跨全部 18 段**——它跟随内容走，**不受段划分影响**，不得为它单独建段 |
   | 注册形态（`client.js:107`）/ factory guard（185–198）/ `buildPlugin` 头（212） | `00-entry.js`（**协议，改动等于改契约**） |
   | 某个 tab 的渲染逻辑 | 对应 tab chunk（`client.*.js`） |
   | 默认 tab「我的 Prompt」（`renderMinePanel`） | `10-toaster-mine.js`（含 toaster 与装配状态） |
   | 跨 tab chrome（状态行/范围树/会话/confirm） | `08-chrome-a.js` / `09-chrome-b.js` |
   | 更新条 / 区域弹窗 / `renderSection` | `12-update.js` |
   | 主入口与 chunk 共用的**设施实现** | **按其实现本身所在的连续区间归段**（不得把实现搬进别的段）：`h`（`client.js:214`）→ `00-entry.js`；`primitives`（`client.js:310`）→ `01-shared-head.js`；`fallbackT`（`client.js:2113`）/`token`（`client.js:2116`）/`UI`（`client.js:2333`）/`tabs`（`client.js:2439`）→ `03-facilities.js`；`fmt`（`client.js:2716`）→ `04-helpers-a.js`；`cardStyle`（`client.js:3968`）/`scrimStyle`（`client.js:4011`）/`errorBanner`（`client.js:4473`）/`stampOf`（`client.js:4614`）→ `06-tree.js`；`layerLabel`（`client.js:5003`）→ `07-stage2.js` |
   | `CHUNK_FACILITIES` 这份**名字登记**（`client.js:8097`，与 `CHUNK_STAMPS`、加载器同在 chunk 协议区） | **`11-chunks.js`（§5.1 表 = 7775–8385），不得移动** |
   | 页面 state / fetch / handler | `13-page-a.js`（hooks/state）/ `14-page-b.js`（fetch/handler）/ `15-page-c.js`（root 树） |
   | 纯函数 | `04-helpers-a.js` / `05-helpers-b.js` |
   | chunk 加载/失效协议 | `11-chunks.js`（**协议**） |
   | failure card / degraded / boot 返回 | `17-boot.js`（**协议**） |
   | 会话输入框上方的装配状态栏（g-086） | `16-composer-bar.js`（只读；数据口径复用页面） |
   | 文案 | `locale/*.json` → 由脚本生成 `02-locale.js`（**永不**直接改该段） |
   | 宿主路由/装配逻辑 | `core/*.js`（ESM），`index.js` 只留路由装配 |

4. **段清单自动生成（消除手工同步成本）**：段清单由 `client-build.mjs` **按文件名字典序扫描 `src/`** 得出，**新增段不需要改任何清单**（同一表述见 §5.2 `readSegments()` 与 §9-3）。相对之下 `CHUNK_STAMPS` 是手工同步的（`scripts/client-chunks.mjs` 的存在本身就是这个成本的证明）——这正是 M2 里"拆分的边际成本"的一部分，本方案把它从"手工"降为"自动"。

---

## 7. 边界：本版本可做 / 必须另立目标

### 7.1 本版本（g-072 之后可直接派工）

| 编号 | 工作 | 规模 | 风险 |
|---|---|---|---|
| T1 | `docs/architecture-map.md`（域索引） | 1 文档 | 无 |
| T2 | `scripts/client-build.mjs` 生成器 + `--write/--check`（**不写头注**、段间不插分隔符、末尾换行一致、内容相同不落盘） | 1 新脚本 150–250 行 | 低 |
| T3 | `src/` 按 §1.3 的 24 个连续区间切段（零语义搬家、零代码移动） | 24 个新文件，内容 = 现有行 | 低 |
| T4 | `package.json`：`files` 加 `src`、`scripts` 加两条命令 | 3 行 | 无 |
| T5 | `scripts/prepare.mjs`：加 `inspectClientSource()`（N/A + `CLIENT-SRC-FILES` + `CLIENT-SRC-NOT-SHIPPED` 三态） | 约 40 行 | 低 |
| T6 | 结构测试：生成物字节等价 + 生成器幂等 + 段行数预算 | 1 测试文件约 60 行 | 低 |
| T7 | 阶段 2 的段细化（页面模型拆 3 段、mine panel 独立、加头注） | 段重排 | 中（段序敏感，见 §5.2） |
| T8 | `CONTRACT.md` 新增「客户端源码布局」条款 + README 改口「零编译」 | 文档 | 中（**契约变更，需负责人裁决**） |
| T9 | 既有测试同步：`test/host.test.mjs` 的 `files` 枚举 + `test/prepare.test.mjs` 的两个 fixture（含 faithful copy 的目录列表加 `src`） | 约 20 行 | 低（**预期内**，见 §5.2） |
| T10 | `docs/check-refs.mjs` 引用体检 + 两张表复算脚本（§10，**只读**、fail-closed；已在本轮交付） | 1 新脚本 577 行 | 无 |

### 7.2 必须另立目标

| 工作 | 为什么另立 |
|---|---|
| 宿主 `index.js` 拆分（候选 E） | `mount`（`index.js:988-5164`，约 4078 行）的闭包状态显式化是独立类型的工作，风险面与客户端无关（`apply` 只是 15 行守卫） |
| 运行期 chunk 协议扩展（候选 C） | 需要新的降级设计（设施未就绪 → 空白页），属新能力而非重构 |
| 把「我的 Prompt」做成 chunk | 与 `client.js:8455-8460` 的既有设计决定冲突，属产品决策 |
| `core/*.js` 内部拆分（`update.js` 1729 / `install.js` 1064） | 与客户端痛点无关，收益独立 |
| Notes/NOTES.md（808 KB）的整理 | 与本目标（插件代码读取代价）无关 |

### 7.3 明确的"不做"

- 不引入 bundler / JSX / TypeScript；不改 `client.js` 的手写 CommonJS factory 形态。
- 不改 `window.__ModuleLoader__.load({...})` 的注册方式（`client.js:107`）。
- 不改 `package.json` 的 `exports["./client"]`（`package.json:19`）。
- 不改指纹标记、`CHUNK_STAMPS` 语义、chunk 加载/失效协议。
- 不改任何 `data-*` marker 与 DOM 结构。
- **本目标不改动任何产品代码**（`client.js` / `index.js` / `core/*` 全程只读）。
- 未改动证明（本基线 `c6bbccb` 的工作树实测）：`git status --porcelain` 只输出一行 —— `?? packages/dsh-prompt-setting/docs/refactor-plan.md`（唯一新增文件即本文档，无任何产品代码改动）。
- 基线测试证据（本次实跑）：`node --test test/*.test.mjs` → `tests 922 / pass 922 / fail 0`，`duration_ms ≈ 56817`；`test/client.test.mjs` 单跑 `pass 295 / fail 0`。

---

## 8. 未确认项与风险

| 编号 | 未确认项 | 影响 | 建议的确认方式 |
|---|---|---|---|
| U1 | 「chunk 内 `require.async` 另一个 chunk」是**源码级确认、未真机实测**（依据 `loader.js:876` 的 `ownerId` 传递） | 只影响候选 C，不影响推荐方案 | 真机：在一个 chunk 里 `await require.async('./client.transfer.js')`，看是否命中 `loadCache` |
| U2 | `apply(ctx)` 阶段异步预加载共享设施是否安全（React 渲染是否一定在其之后） | 只影响候选 C | 真机 + 失败注入 |
| U3 | ~~生成器对 `CHUNK_STAMPS` 的写入是否与 `client-chunks.mjs --write` 等价~~ → **已升为已验证**（R1-4，见下「本次返工已实测的事实」） | — | 已实测 |
| U4 | 宿主 `index.js` 拆分的实际耦合度（闭包共享状态的清单） | 只影响阶段 3 的估工 | 立目标后先做一次"闭包变量 → 归属域"的盘点 |
| U5 | "零编译但有生成期拼接"是否符合项目对"零构建包"的定位（承诺散落在 `README.md:139` / `README.md:345` / `README.md:350` / `NOTES.md:3635` / `NOTES.md:3679` / `scripts/prepare.mjs:9` / `scripts/prepare.mjs:162`；`CONTRACT.md:7846` 仅顺带提及 "no build step"） | 影响 T8 的契约改口 | **需负责人裁决**（见 §9-1） |
| U6 | 阶段 2 起段文件语法不完整却随包发布，是否改用 `.js.part` / `.seg` 后缀 | 影响阶段 2 的读者体验 | **需负责人裁决**（见 §9-5） |

**本次返工已实测的事实（R1-4，可复算）**

```
$ node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  import { clientChunkStamps } from './core/store.js';
  import { readDeclaredStamps, sameStamps, writeDeclaredStamps } from './scripts/client-chunks.mjs';
  import { fingerprintOf } from './core/build.js';
  const src = readFileSync('client.js','utf8'), actual = clientChunkStamps(process.cwd());
  ..."
sameStamps(readDeclaredStamps(src), actual)                  = true
writeDeclaredStamps(src, actual) === src                     = true   # 生成器幂等，不触碰 mtime
fingerprintOf(src)                                           = 4d998612 / 567230
withHead = '// GENERATED...\n' + src
  withHead === src                                            = false  # 头注改变字节 ⇒ 与判据 2 互斥（R1-1）
  fingerprintOf(withHead)                                     = 4d998612 / 567230   # 但指纹不变
```

**已知风险（推荐方案内）**

- R1｜**双真源焦虑**：`client.js` 与 `src/` 同时存在于仓库，新人可能改错文件。缓解：`--check` 门禁（非零退出码即安装失败）+ `docs/architecture-map.md` 首段警示 + 阶段 2 起的生成物头注。与 `locale/*.json` 的现状完全同构，**已被证明可管理**。
- R2｜**段序敏感**：`test/client.test.mjs:2554-2558` 依赖 `client.js` 内的出现顺序。缓解：把该断言改为"在指定段内断言"，或把段序写进生成器的固定清单并加断言。
- R3｜**生成器成为新的单点**：`client-build.mjs` 出错会阻塞整个客户端改动。缓解：`--check` 只读、`--write` 幂等、并被 `prepare` 覆盖（prepare 失败即安装失败，与今天 chunk 清单漂移的失败模式一致）。
- R4｜**收益不自证**：行数下降不等于 token 下降（注释占比高）。已用 §1.2 的构成数据校准口径（§6.1），并披露"跨段改动不降"。
- R5｜**生成器重写会改 mtime ⇒ 开发期重载噪音（R1-8a）**：DSH 的 `artifactRevision(baseline) = framedHash("plugin-artifact", [mtimeMs, ctimeMs, size])`，**rev 不变则不重读、不通知**（`CONTRACT.md:4781-4789`）；反过来，mtime 变了即使字节相同，rev 也变，会触发重读 + SSE 通知 + 页面重载。**缓解**：`client-build.mjs --write` **仅在内容不同时落盘**（先算再比，相同则不动文件），这条已作为实现约束写进 §5.2；`--check` 天然只读。**残余**：阶段 2 起任何真实改动都会动 mtime，这与今天手改 `client.js` 的后果完全一样，不是新增风险。
- R6｜**「重切」越界成「移动」会引入语义风险（R2-D2）**：被切的是**同一个函数体**，跨块移动会改变 `const`/`class` 的 TDZ 边界与函数声明的提升可见性，而**现有 922 个用例没有一条能证明这种移动无害**（它们断言的是渲染结果与源码文本，不是声明顺序语义）。**缓解**：①§5.1 段边界规则把「只重切、不移动」写成硬规则；②阶段 2 判据 2 用「去头注后与阶段 1 产物逐字节相同」做强证明；③判据 3 用「段偏移单调递增、无空隙」做机器检查。**残余**：这三条拦的是"无意越界"，拦不住"有意重排 + 通过全部判据"——若将来确有必要移动代码，应另立目标并按新语义审计。

---

## 9. 需主管/负责人裁决事项

1. **T8 的契约改口**：是否允许把本包定位从「零构建包」表述为「零**编译**（无 bundler/TS/JSX），但客户端入口为**生成物**（源段在 `src/`）」？
   - 默认建议：**允许**。理由是包里已有同类先例（`locale/*.json` → 内联段，`scripts/prepare.mjs:135-167`），且本方案的阶段 1 可以用"生成物与现状字节等价"来验收，风险封顶。
   - **改口要同步的位置（R1-8b，实测清点）**：`README.md:139`（"零运行时依赖、零构建步骤"）、`README.md:345` / `README.md:350`（"本包零构建，`prepare` 只做发布自检"）、`NOTES.md:3635`（"本包是**零构建**包：`index.js` / `client.js` / `core/*.js` 本身就是发布入口，没有编译产物"）、`scripts/prepare.mjs:9`（"本包是零构建包（`index.js` / `client.js` / `core/*.js` 本身就是发布入口）"）与 `scripts/prepare.mjs:162`（运行时打印的"本包零构建，不做编译"）。`CONTRACT.md:7846` 只有一句顺带提及 "no build step"，不是承诺条款。改口的准确措辞是「**零编译**（无 bundler / JSX / TypeScript），客户端入口为**生成物**（真源在 `src/`）」，而不是"零构建"。
   - **基线快照注记（g-075 阶段 2 落地后补）**：上面这份清单是基线 `c6bbccb` 的**实测快照**，用途是指明"改哪几处"；阶段 2 实施后，这 6 处（`README.md:139`、`README.md:345`、`README.md:350`、`NOTES.md:3635`、`scripts/prepare.mjs:9`、`scripts/prepare.mjs:162`）的措辞**已按本条款改口**为「零**编译**（无 bundler / JSX / TypeScript），客户端入口为**生成物**（真源在 `src/`）」。改口是**行数中性**的，所以本节所有行号保持原样、无需重算；`docs/check-refs.mjs` 的 `REFS` 期望文本已同步到新措辞 —— 文档描述与脚本断言同时为真，既不是只改脚本，也不是删断言绕开。
2. **实施边界**：本目标是否只交付本文档（→ 另立实施目标），还是允许在本文档之后**由同一目标继续推进阶段 0/1**？
   - 默认建议：**本目标只交付文档**（符合 directive），阶段 0/1 另立目标，按 §5.2 的判据派工。
3. **`src/` 的命名与段编号风格**（`00-entry.js` 这类数字前缀 vs `entry.js`）：
   - 默认建议：**数字前缀**（`00-` … `16-`）。由于段编号按代码出现顺序递增（§5.1 规则①），**「文件名字典序 = 代码顺序」是段划分规则的自动结果**，不需要单独维护一份顺序清单。
4. **阶段 2 是否接受"生成物"头注**（约 8–15 行；**阶段 1 不加**，因为阶段 1 的判据 2 要求逐字节等价，加头注会破坏它，见 §5.2 风险点与 §5.2 实跑证据）：
   - 默认建议：**阶段 2 接受**。头注必须落在 fingerprint begin 标记**之前**（现为 `client.js:115`），不污染指纹。
5. **阶段 2 起段文件后缀**（R1-9）：段文件语法不完整（只是同一 factory body 的连续切片），却随 `files` 发布。
   - 默认建议：**保持 `.js`**，但每段头一行"本文件是 `client.js` 的片段，不是独立模块，不得单独 parse/lint/执行"，并在 `src/README.md` 说明；**这行由生成器在拼接前逐段剥离，不进 `client.js`**（§5.2 实现约束第 3 条）。备选是改用 `.js.part` / `.seg`（更显眼，代价是编辑器高亮与 diff 体验）。

---

## 10. 附：证据索引（按文件）

**`packages/dsh-prompt-setting/client.js`**
`:107` load 注册 · `:114` factory 头 · `:115` begin 标记 / `:182` `SELF_BUILD` · `:903-2085` locale 生成段 · `:2154` fallback atoms · `:2688` pure helpers region · `:3378` `chunkStampMap` · `:3416` `buildVerdict` · `:7329` `renderMinePanel` · `:7894` `CHUNK_STAMPS` · `:7911` `CHUNK_FACILITIES` · `:8084` `loadChunk` · `:8095` `recordLoadedChunk` · `:8189` `chunkModule` · `:8223` `HistoryTabChunk` · `:8245-8293` "默认 tab 不做 chunk" 的设计说明 · `:8314` `chunkTab` · `:9001` `data-build-loaded` · `:9041` `PromptSettingSection` · `:12039` `renderFailureCard` · `:12129` `return {`（`:12143` 是 `inject: ['slots', 'locale'],` 行） · `:12151` `__internals` · `:12154` `shared: CHUNK_FACILITIES` · `:12188` `apply(ctx)` · `:12311` `degradedPlugin`

**`packages/dsh-prompt-setting/index.js`**
`:225` `CLIENT_BUNDLE_PATH` · `:777-791` `export function apply`（15 行薄守卫） · `:982-5059` `mount`（约 4078 行） · `:2398-2759` history/export/diff/rollback/import handlers · `:4292-4364` ping 响应 · `:4810` `clientBuild: clientBuildInfo(...)` · `:5062` 文件尾 `export { ACTIONS, LAYERS, sameSections }`

**`packages/dsh-prompt-setting/core/`**
`store.js:298` `clientBuildInfo` · `store.js:311` `chunks: clientChunkStamps(...)` · `store.js:326` `CLIENT_CHUNK_PATTERN` · `store.js:340` `clientChunkStamps` · `build.js:35-37` 指纹标记 · `build.js:52` `normalizeBuildText` · `build.js:66` `fingerprintRegion` · `build.js:101` `fingerprintOf`

**`packages/dsh-prompt-setting/scripts/`**
`client-chunks.mjs:32-34` 清单块锚点 · `:41` `renderStampRows` · `:52` `readDeclaredStamps` · `:75` `writeDeclaredStamps` · `:91` `sameStamps` · `:100` `main` · `prepare.mjs:9` 「零构建包」承诺 · `:86` `inspectClientChunks` · `:135-167` `inspectLocale`（可照搬的三态模板，`:139-145` 是 N/A 分支、`:150-157` 是 NOT-SHIPPED 分支） · `:180-183` findings 接入

**`packages/dsh-prompt-setting/test/`**
`build.test.mjs:136-171` 指纹区间断言（`:171` 是 `size > 50000`） · `:174-198` chunk 形态断言 · `:200` 清单对账 · `client.test.mjs:2008` 平铺同级断言 · `:2360-2382` 防复制断言 · `:2538-2542` `scrimStyle` 顺序断言（**段序敏感点**） · `boot.test.mjs:56` 读 `client.js` · `host.test.mjs:171-197` `files` 白名单精确枚举（**阶段 1 同步点**） · `prepare.test.mjs:440-485` 最小 fixture（期望 exit 0） · `:487-539` faithful copy（**阶段 1 同步点**）

**`packages/dsh-prompt-setting/package.json`**
`:15` `"type": "module"` · `:19` `exports["./client"]` · `:22-33` `files` 白名单

**外部（宿主，非本仓库可改）**
`@deepseek-ai/dsh-client-modules/lib/client.js:605-614` `chunkId`/`chunkUrl` · `:700-712` 注册与 chunk 校验 · `:804-828` `materialize`（同步） · `:831-850` `require`/`require.async` · `:852-877` `importChunk` · `:878-891` `import`；`lib/index.js:205-222` combo/chunk URL · `:952-976` `chunkResponse`（文件存在即 serve）

**本次返工实跑（R1-1 / R1-4 的证据）**

```bash
# 幂等 + 头注互斥（在 package 目录下）
node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  import { clientChunkStamps } from './core/store.js';
  import { readDeclaredStamps, sameStamps, writeDeclaredStamps } from './scripts/client-chunks.mjs';
  import { fingerprintOf } from './core/build.js';
  const src = readFileSync('client.js','utf8'), actual = clientChunkStamps(process.cwd());
  console.log(sameStamps(readDeclaredStamps(src), actual));            // true
  console.log(writeDeclaredStamps(src, actual) === src);               // true
  console.log(JSON.stringify(fingerprintOf(src)));                     // 4d998612 / 567230
  const withHead = '// GENERATED\n' + src;
  console.log(withHead === src);                                       // false
  console.log(JSON.stringify(fingerprintOf(withHead)));                // 4d998612 / 567230
"
# 基线测试（本次返工实跑）
node --test test/*.test.mjs      # tests 922 / pass 922 / fail 0
node --test test/client.test.mjs # pass 295 / fail 0
```

**两张版图 / 段表的机器校验（R2-D1 / R2-D2）**

校验规则：①`行数 == 区间长度`；②区间**首尾相接**（无空隙、无重叠）；③合计 `== 13942`；④段表每段 `≤ 1200`。做法是从本文档里按表格行正则解析出 `(起始行, 结束行, 行数)`，逐条比对。

```
本次返工实跑结果：
  §1.3 版图表   : rows=24, 行数不符=[], 不连续=[], 首尾 1–13942, 合计=13942
  §5.1 目标段表 : segs=17, 行数不符=[], 不连续=[], 首尾 1–13942, 合计=13942, 最大段=1200, 超 1200 的段=[]
```

**文档引用体检（R3-R5 治本项 + R4 收敛轮加固）：`docs/check-refs.mjs`**

它做两件事：

1. **引用体检**：扫描本文档里所有 `文件:行` / `文件:行-行` / 简写 `:行` 引用（**跳过围栏代码块**，所以 §10 记录的"历史错值"不会污染计数），对期望表内的逐条断言"该行确实含文档声称的符号"；区间还必须给出 `toExpect`（端点逐字断言）或声明 `loose: true`（长区间，明确只判首行）。
2. **两张表复算**（R4-C1）：§1.3 版图表与 §5.1 目标段表 —— 行数 == 区间长度、区间首尾相接、合计 == 13942、每段 ≤ 1200。这两张表是阶段 1/2 的门禁基础，必须**可复跑**，而不是一段粘贴输出。

**fail-closed 的四条规矩**（R4-A1…A4，它们决定 `failed=0` 是否可信）：

- **归属失败 / 包内文件读不到 / 行号越界 ⇒ 一律失败**（非零退出码）。只有明确的**仓库外**路径（宿主 `loader.js` / `lib/index.js` / `@deepseek-ai/…`）才允许留在 manual。
- **恒等式**：`文档引用数 == verified + rangeOnly + manual + unresolved`（不满足即说明有引用被静默吞掉）。
- **`verified` 只统计「期望表 ∩ 文档引用」里通过的条数**；期望表里文档中并不存在的条目（`REFS\declared`）单独报数、**不计入覆盖率** —— 否则就是拿"产品代码该行有该符号"冒充"文档引用已验证"。
- **`rangeOnly` 单列**：包内可读 + 行号合法，但期望表没有符号断言（这是**最小验证**，不是通过的同义词）。

```bash
cd packages/dsh-prompt-setting
node docs/check-refs.mjs              # 体检；有 fail/unresolved ⇒ 非零退出码
node docs/check-refs.mjs --verbose    # 另列 rangeOnly 明细
```

最终实跑输出（当前轮，R1 之后）：

```text
  table §1.3 版图表: rows=24 合计=13942 最大段=3172
  table §5.1 目标段表: rows=17 合计=13942 最大段=1199
check-refs: 文档引用 total=153 | verified=132 | rangeOnly=0 | manual=21 | unresolved+failed=0
check-refs: REFS 表 158 条 → REFS∩declared=132（计入覆盖率，其中 verified=132） / REFS\declared=26（文档里不存在，不计入覆盖率；其中 26 条独立校验通过）
check-refs: 恒等式 total == verified + rangeOnly + manual + unresolved = 132 + 0 + 21 + 0
check-refs: 文档引用的可自动判定部分全部成立；manual 项请人工核对
exit=0
```

> `manual=21` **全部**是仓库外路径（宿主 `loader.js` / `lib/index.js` / `@deepseek-ai/…`），本仓库读不到、只能人工核对 —— 它们**不是**通过项。

**它在本轮抓到的真实偏差**（7 处文档行号 + 3 处区间端点，全部已修）：

下列**历史错值**只作记录，不参与引用体检（`check-refs.mjs` **跳过围栏代码块**）：

```text
| 脚本报出的不符 | 实际 | 处理 |
|---|---|---|
| `client.js:7823-7831` 首行是空行 | 注释在 7797–7805 | 改文档 |
| `client.js:7958-7970` 首行是 `chunkLoadRevision` | `subscribeChunkLoads` 在 7916 | 改文档 |
| `client.js:8017-8028` 末行是空行 | 函数在 7990–8000 | 改文档 |
| `core/build.js:101-107` 越界（文件 105 行） | 101–105 | 改文档 |
| `scripts/prepare.mjs:151-157` 首行是 `if (cut…)` | `const cut =` 在 150 | 改文档 |
| `scripts/client-chunks.mjs:43-100` 末行是空行 | 41–97 | 改文档 |
| `CONTRACT.md:4139-4148` 末行是空行 | 4137–4145 | 改文档 |
| `client.js:8017-8028` / `:151-157` 等 | — | 同上 |
| `core/store.js:280-296`、`prepare.mjs:139-145`、`build.test.mjs:138-141` | 区间以 JSDoc 开头，被断言符号在中段 | 期望表加 `at` 字段（**文档本身正确**） |
```

> 这条脚本不是"让文档好看"：上面 7 处里有 3 处（`7931-7943` 指错函数、`101-107` 越界、`41-98` 多一行）都会让后续执行者**按错行号定位**。

**git 证据（复算命令）**
`git show <sha>:packages/dsh-prompt-setting/client.js | wc -l`（§3.1 表）· `git show --stat a9fa57a`（g-070 影响 11 文件 708 行）· `git show --stat 61bcdc4`（g-060 新建 `client.presets.js`）· `git show --stat 8618f6e`（g-045 新建 1 个 chunk）· `git show --stat 3ff96bd`（g-046 新建 3 个 chunk）

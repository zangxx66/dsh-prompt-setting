# dsh-prompt-setting（插件包）

DSH 默认 System Prompt 管理插件。**阶段一（A/B/C）与阶段二已交付**：宿主侧装配快照 +
覆盖引擎 + 两层持久化 + 版本历史 + diff + 导出/导入，客户端侧设置页 Prompt 管理器
（分段浏览、全文检索、就地编辑、覆盖管理、历史与版本对比、恢复默认、导出下载与导入预览）。
编辑是**行内就地展开**：点某段行的「编辑」，表单就在**那一行内部**渲染；「新增一段」没有目标行，
固定留在列表上方槽位；编辑中该行被筛选藏掉、被切走视图或重载后不再返回时，表单**回退到该槽位**
并带 `data-editor-fallback="row-hidden"`，已输入内容不丢。
那行的「编辑」同时是**开关**（对齐 DSH「设置 → 模型」的行展开：同一个按钮开/关，`aria-expanded` 报告
状态；本插件只允许一个表单，所以打开另一行是切换而非叠加），展开时用 `scrollIntoView({ block: 'nearest' })`
把表单**最小滚动**带进视口（详见 `NOTES.md` §90 七、八节）。

本文件讲的是**这个包怎么装、怎么改**；仓库整体目标与路线图见仓库根 `README.md`，
REST 契约见同目录 [`CONTRACT.md`](./CONTRACT.md)（已冻结，客户端照它写），
阶段一 A 的设计取舍、探针实测方式与未验证项见 [`NOTES.md`](./NOTES.md)。

## 包内容

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半：`/prompt-setting` 前缀路由（ping / snapshot / overrides / history / diff / export / import）+ `system-prompt/assemble` 覆盖监听器 |
| `core/overrides.js` | **纯函数内核**：配置校验、两层合并、分段变换、`complete` 推导、快照投影、渲染。零 IO、零 `ctx` |
| `core/history.js` | **纯函数**：历史记录的构造与校验、jsonl 解析（容错）、裁剪上界、查询分页、SHA-256 指纹 |
| `core/diff.js` | **纯函数**：段级快照比较 + 行级 diff（精确 LCS，超预算退化为有界比较并明示） |
| `core/transfer.js` | **纯函数**：导出文档构造、导入文档的 schema/版本/字段校验、冲突策略与变更计划 |
| `core/store.js` | **唯一碰文件系统**的模块：两层路径解析 + 原子写（临时文件 + `rename`）+ 读时校验 + `history.jsonl` 追加与裁剪 + 多文件原子替换（导入） |
| `core/experiments.js` | E1–E5 的**实测结论**（由集成测试产出，快照与 CONTRACT.md 共用同一份文案） |
| `client.js` | 客户端半：「设置」里的独立一栏：状态条 / 会话选择器 / 分段视图（含 `origin` 标注与筛选）/ 全文视图（搜索高亮 + `base`↔`effective` 对比）/ 编辑面板（**行内就地展开**：`data-editor-row` 标归属行，行不可见时回退槽位并标 `data-editor-fallback`；保存前可行性校验）/ 覆盖管理 / 历史列表与版本对比（官方 `DiffBlock` + 自绘降级）/ 恢复默认（单段与整层，均二次确认）/ 导出下载与导入（先干跑预览再二次确认） |
| `cordis.patch.yml` | bundle 层：一条 `insert` 行同时承载两个半边 |
| `package.json` | 包契约：`dsh.bundle.patch` + `dsh.client.platform: "web"` + `exports["./client"]` |
| `CONTRACT.md` | 冻结的 REST 契约：每个字段、每个 4xx、动作枚举、字段上限 |

零运行时依赖、零构建步骤。客户端半是手写 CJS 工厂（`window.__ModuleLoader__.load`），
**不要**引入 bundler / TypeScript / JSX——`react` 由浏览器 seed 模块表提供。

## 分层原则（改代码前先读）

宿主进程的改动**必须重启才能生效**，所以逻辑尽量放在可离线测试的模块里：

- `core/overrides.js`、`core/history.js`、`core/diff.js`、`core/transfer.js` 是纯数据进、纯数据出；
  单测直接测它们，不碰 `ctx`（`core/history.js` 只用确定性的 `node:crypto` 算指纹）；
- `core/store.js` 承担全部 IO，且**不在装配路径上**（挂载时读、路由请求时刷新、之后只在内存里读）；
- `index.js` 只是薄适配层：一个 waterfall 监听器 + 路由分派。

导入的原子性由分层保证：**解析 → schema/版本/字段校验 → 冲突策略 → 临时文件写入 → 校验通过 →
原子替换**，前四步全在纯函数层与内存里，所以「任何一步失败 ⇒ 现有配置文件逐字节不变」
是可单测的事实（对配置文件与历史文件做 SHA-256 前后比对），不依赖宿主的失败注入。

装配路径上的监听器**只读内存**，并且始终调用 `next()`（不否决其它监听器），
无覆盖时按**同一对象引用**原样返回。

## 安装

由 DSH 的 plugin manager 以**绝对路径**安装本目录，不要手工编辑 profile 配置文件：

```
plugin_manager(action: "install_bundle", target: "<仓库绝对路径>/packages/dsh-prompt-setting")
```

安装后：

1. 在设置里应出现独立一栏「Prompt 管理 / Prompt settings」（`id: prompt-setting`，`order: 30`）；
2. 宿主行 id 为 `prompt-setting`，可用 `cordis_inspect_query`（host `Config.listConfigs`，`name: dsh-prompt-setting`）确认已挂载；
3. 探针可验证宿主半是否挂上：**页面上「原始响应」区显示 `GET /prompt-setting/ping` 的返回 JSON**，
   其中 `clientRenderer` 即浏览器实际走的渲染分支（`primitives` / `fallback` / `null`）——
   这是判定「外部 bundle 能否 require `dsh-client-ui-primitives`」的机器可读结论；
   `clientBuild` 是宿主**现场**对自己发布的 `client.js` 算出的构建戳（`{hash, size, mtime}`，
   读不到文件时为 `null`），用法见下节「构建戳怎么读」；
   也可在页面控制台跑 `await (await fetch('/prompt-setting/ping')).json()`。
   **裸 `curl` 会被拒绝（401）**：`requestRejection` 第二段是浏览器 cookie 认证，缺少它即 401，
   这是预期行为，不是路由没挂上（细节见 [NOTES.md](./NOTES.md) §4）。

## 开发

```bash
cd packages/dsh-prompt-setting
node --check index.js && node --check client.js && for f in core/*.js; do node --check "$f"; done
node --test                                       # 305 项断言，0 skipped
npm pack --dry-run                                # 确认产物干净（无 test/、无 .dsh-graph）
```

> `node --test`（在本目录下自动发现 `test/`）是本包的规范命令。Node 24 会拒绝把目录当位置参数
> 传进去（`node --test test/` ⇒ `MODULE_NOT_FOUND`），这不是本包的问题；等价写法是
> `node --test test/*.test.mjs`。

`node --test` 的十一个套件：

| 套件 | 覆盖 |
| --- | --- |
| `test/overrides.test.mjs` | 纯函数内核：校验/合并/变换/frozen 推导/投影/渲染 |
| `test/history.test.mjs` | 历史内核与持久化：记录校验、jsonl 容错解析、裁剪上界、分页/过滤、可配置 N、追加写不重写、导入的多文件原子替换 |
| `test/diff.test.mjs` | diff 内核：空文本、CRLF、超长单行、有界退化与预算、段级状态、焦点段选择 |
| `test/transfer.test.mjs` | 导出文档形状、导入校验的每一条拒绝码、merge/replace 冲突策略、dryRun 计数 |
| `test/build.test.mjs` | **构建戳纯函数**：FNV-1a 32 官方向量、归一化（BOM/CRLF）、标记缺失/错序/重复 ⇒ null、区域内改 1 字符 ⇒ 摘要变、真实 `client.js` 的区域覆盖整个 factory 正文 |
| `test/store.test.mjs` | 路径解析、读时校验、**原子写**（硬链接见证旧文件未被就地改写）、`clientBuildInfo` 的每次重读与不可读 ⇒ null |
| `test/route.test.mjs` | 全套宿主面：栅栏、405/404、两层、frozen、全部 4xx、D1/D2 回归（用复刻真语义含 scope 父链的假 Host）、**ping 的 `clientBuild` 与「改文件即变」的独立复算** |
| `test/stage2.test.mjs` | 阶段二路由：历史追加与裁剪、整层重置、diff 选择器、导出/导入、**导入失败的哈希原子性断言** |
| `test/host.test.mjs` | 阶段一 A 的既有套件：清单契约、ping、信任栅栏、405/404（**行为未变，断言仍在**） |
| `test/client.test.mjs` | 客户端半：vm 沙箱 + 递归展开函数组件的迷你渲染器 + fetch 路由桩（含 `useSessions` 缺失降级、`frozenScope` 三态、保存前可行性校验、历史/对比/恢复默认/导出导入面板与 `DiffBlock` 分支、**构建戳三态与自证指纹的独立复算**） |
| `test/integration.test.mjs` | **E1–E4 对照实验 + 插件端到端**：真 `@deepseek-ai/dsh-system-prompt` + 真 `@deepseek-ai/cordis` + 真 Cordis 上下文 |

集成测试从 DSH 全局安装根解析真包（`DSH_INSTALL_ROOT` / `DSH_PROFILE_DIR` / pnpm 全局 store）。
解析不到时该套件 `skip` 并打印原因，所以没有 DSH 的机器上 `node --test` 仍全绿；
**本机必须看到它 pass 而不是 skip**——skip 即证据缺失。

测试不需要浏览器：`client.js` 被放进 `node:vm` 沙箱里跑，`require` / React / `fetch` 全部是桩，
因此「primitives 可用 / 不可用」「探针成功 / HTTP 错误 / 网络错误」四条路径都可离线断言。

`test/host.test.mjs`、`test/route.test.mjs` 与 `test/integration.test.mjs` 都会把 `$DSH_HOME`
指向临时目录，绝不读写真实的 `~/.dsh`。

> `npm pack` 若报 `Log files were not written ... /Users/<you>/.npm/_logs`，
> 是本机 npm 缓存目录不可写，加 `npm_config_cache=/tmp/npm-cache` 即可，与包本身无关。

### 代码改动怎么生效（本机实测，2026-09-28；**修订版，先前的版本是错的**）

本包以 `link:` 装进 profile，但两半的生效方式**不同**：

- **客户端半（`client.js`）**：**正常不需要任何手工操作**，也不需要重启进程。
  - **修订（2026-09-28 23:48–23:51 真机实测，推翻了本节早先的写法）**：DSH 0.1.7-rc.2 自带客户端插件
    HMR —— 浏览器侧订阅 SSE `/plugins/events`，收到本插件的 `rebuilt` 事件就重载该模块条目并重新
    import（源码：`@deepseek-ai/dsh-client-hmr/lib/client.js`、`@deepseek-ai/dsh-client-modules/lib/client.js`），
    所以**已经打开的标签页会被毫秒级热替换**，不必重载文档。实测：在 `client.js` 区域内改 1 处后，
    页面**没有任何操作**时 `data-build` 就从 `63cf17c0` 变成 `77134de7`，而 `performance.timeOrigin`
    恒为 `23:36:50`（文档未重载）。
  - **页面落后于磁盘只发生在**：HMR 没做成（`/plugins/events` 事件流断/被阻断、该页 boot 时通道不
    健康），或**写入与 `rebuilt` 之间**的那一小段窗口。
  - 本机 **`Cmd+Shift+R` 被 DSH 快捷键接管**，所以「硬刷新」不一定可用；需要重新加载时，**新开一个
    标签页**（`Cmd+T` → `http://127.0.0.1:3080`）仍是最可靠的兜底手段。
  - 判别「我跑的是哪个 bundle」：**先看状态条上的「构建戳」**（见下节）——`与宿主一致` /
    `页面版本已过期` / `构建戳未知` 三态就是为这一问准备的；也可以 `grep` 安装副本里有没有新标记。
- **宿主半（`index.js` / `core/**`）**：**需要重启 `dsh web`**，代码不会自动重载。实测依据（三点一致）：
  1. 阶段二（g-005）的宿主能力是在**重启之后**才在真机可用的（`history.jsonl` 首次在重启后的保存中出现）；
  2. 阶段一 B 的 `/snapshot` 路由在本机「看起来无需重启」曾被我误读为热重载，复查 pid 时间线发现**中间确实发生过一次重启**（19:25 仍为旧 pid、19:27 变新 pid、19:29 才验证成功）；
  3. 最后反证：g-007 的宿主改动（用户层每请求重读）在**未重启**的进程上完全不起作用——直接改写 `~/.dsh/prompt-setting/overrides.json` 后，页面刷新与下一轮装配都看不到外部改动。

⇒ 正确姿势：改 `client.js` 什么都不用做（正常由 HMR 热替换）；改 `index.js` / `core/**` 必须重启。
排障顺序：

1. 改动只涉及 **`client.js`** ⇒ 直接保存；**先看构建戳**：显示 `与宿主一致` 即已生效；只有显示
   `页面版本已过期` 时才需要刷新/新开标签，而刷新后仍为 `过期` 说明 **DSH 侧没有重建或事件流不健康**
   （`/plugins/events` 断/被阻断），那不是本插件能修的；
2. 改动涉及 **`index.js` / `core/**`** ⇒ **必须重启 `dsh web`**（再开新标签）；
3. 配置类字段（`cordis.patch.yml` / `package.json` 的 config）改动本就热生效。

**换包本身**（改名、换依赖 spec（`link:` ↔ tarball）、换安装目标）同样必须重启，`plugin_manager` 的
返回值会明说 `application: "restart-required"`。

> ⚠️ **重启的代价（负责人 2026-09-28 纠正，先前的说法不准确）**：停止/重启 `dsh web` 会
> **终止所有等待确认的会话**——**重开标签页不会把那个会话找回来**。所以第 2 条不是「随手重启」：
> 重启前先落盘交接（本仓库 `graph_handoff` → `.dsh-graph/HANDOFF.md`，新会话 `graph_claim_supervisor` 接手），
> 宿主半改动尽量**攒批**；能在 `client.js` 一侧解决的就别动宿主半（客户端半正常由 HMR 热替换，连刷新都不需要）。

### 构建戳怎么读（Revision 6）

页面「状态」卡的第三行就是构建戳，它为「我这一页是不是当前字节」给出一个可读、也可机器核验的答案：

| 显示 | `data-build-match` | 含义 | 该做什么 |
| --- | --- | --- | --- |
| 与宿主一致 | `true` | 本页运行的 `client.js` 与宿主**此刻发布**的字节逐字节相同（同一区域同一算法同一摘要） | 不用动 |
| 页面版本已过期 | `false` | 两边都给出了真实摘要且**不相同** ⇒ 本页确实不是当前字节（HMR 没做成，或正处在「写入 → `rebuilt`」的窗口里） | **先刷新页面**（新标签最稳）。仍是 `false` 说明 DSH 没重建/事件流不健康 —— 这属于 DSH 侧，不要指望「刷新必然拿到新字节」 |
| 构建戳未知 | `unknown` | 旧宿主没有 `clientBuild`、宿主读不到文件、标记被改坏、或 ping 失败 | 不能下结论：**这一态永远不会被当作「过期」**，请按本机常规办法核对（新标签 / 重启） |

三个数字都能直接读，都在页面根容器上（`node --test` 断言的也是它们）：

- `data-build`：**本页**自身的摘要（宿主无关，页面自己算自己的源码）；
- `data-build-server`：**宿主**在 `GET /prompt-setting/ping` 的 `clientBuild` 里报的摘要；
- `data-build-match`：`true` / `false` / `unknown`，即上表第一列。

控制台一条命令即可拿到结论（不需要看 UI）：

```js
await (await fetch('/prompt-setting/ping')).json()   // → clientBuild: {hash, size, mtime}
document.querySelector('[data-plugin="dsh-prompt-setting"]').dataset.buildMatch   // "true" | "false" | "unknown"
```

摘要的区域由 `client.js` 里一对注释标记界定（`/* @build-fingerprint:begin */` …
`/* @build-fingerprint:end */`），覆盖 factory 的**整段正文**；两侧在哈希前统一去掉 BOM、把
`\r\n?` 折成 `\n`，所以「换行归一化」不会造成假的「过期」。算法是 32 位 FNV-1a（8 位 hex），
客户端不能 import 宿主代码，因此 `client.js` 内联了一份等价实现，测试断言两者对**真实文件**
逐位相等。契约细节见 [`CONTRACT.md`](./CONTRACT.md) §14，未验证项与已接受的限制见
[`NOTES.md`](./NOTES.md) §81。

**两侧的语义并不对称（别把它读成「刷新一定变新」）**：`clientBuild` 是**内容指纹**，每次 ping 现场
读磁盘；而页面跑的是 **DSH 在最近一次 `rebuilt` 时捕获的 bundle**，换新触发基于 **mtime/ctime/size**
的元数据，rev 没变就不读文件、不发通知。所以「写入后、`rebuilt` 前」判 `false` 是正确的（页面确实
不是当前文件），但此时刷新也可能拿到同一份旧 artifact。详见 CONTRACT §14.5。

## 可访问性：查看范围是一棵标准 ARIA 树

「查看范围」的工作区树（`role="tree"`，`data-region="session-tree"`）现在有标准树语义，观感与交互不变：

- `tree` 的**直接子项只有** `treeitem`（工作区节点，`aria-level="1"`，`aria-expanded`）和 `group`
  （该工作区的会话容器，`aria-label` = 工作区标题）；**没有无名分组**，也没有裸 `div` 夹层；
- 会话条目是 `role="treeitem"`、`aria-level="2"`、`aria-selected`（当前选中）；分页/排序/可见性、
  ↑↓、Enter/Space、色条 + ✓、hover/focus 环、全部 `data-*` 标记一律不变；
- 「显示更多」与到渲染上限的提示不是树节点，它们留在所属 `group` 内（提为 `tree` 的直接子项反而
  会破坏上面的规则）；
- **扁平降级路径（无 `useWorkspaces`）明确不宣称树**：它仍是 `role="listbox"` + `role="option"`
  的可搜索列表，带可访问名，条目**不带** `aria-level` —— 二选一里选了「不假装有层级」，因为降级
  分支没有工作区分组可言，硬套 `tree` 只会多出一层假层级。

真机屏幕阅读器（VoiceOver）**未测**（本机验证手段只有渲染树断言），细节与取舍见
[`NOTES.md`](./NOTES.md) §87。

## 文案与语言（i18n）

客户端半的**全部**文案走 `ctx.locale` 的命名空间词典（`settings.promptSetting`，zh/en 两套内联在
`client.js` 顶部），所以 DSH 语言切到 English 时本页即英文，不需要刷新或重启（client 半由 HMR 热替换）。
`client.js` 里**不允许**出现硬编码的界面文案：一切可读文本都从 `t(key)` 取，两套词典键位必须相等。

自动化保障（`test/client.test.mjs`）：

| 用例 | 断言 |
| --- | --- |
| `client: injects the locale namespace thunk and declares zh/en dictionaries` | zh/en **键位集合完全相等** |
| `client: every documented rejection code has distinct zh/en copy` | 每个错误码都有**互不相同**的中英文案 |
| `client: the english render sweep shows no CJK and no bare key, in any branch` | 用 **en** 词典渲染 **34 个场景**（全部视图与关键状态，10980 条渲染字符串，含 `placeholder`/`title`/`aria-label`），断言**零 CJK**、**无裸 key 回落**、en 词典非空且值不等于 key |
| `client: the english sweep really walked every required branch marker` | **59 个 `data-*` 分支标记**必达（含 19 个 `data-warning`、构建戳三态、冻结三态、错误码横幅），少一个就红 |

覆盖范围、负向对照与**刻意不覆盖**的部分（原生控件文案、DSH 自带 UI 文案、宿主返回的 `message`/`reason`
原文、真机 SR 与热替换时序）见 [`NOTES.md`](./NOTES.md) §89。

## 阶段边界

阶段一 B 交付宿主侧全部能力：`GET /prompt-setting/snapshot`、
`GET|PUT|DELETE /prompt-setting/overrides`、覆盖引擎与两层持久化（见
[`CONTRACT.md`](./CONTRACT.md)）。`GET /prompt-setting/ping`、信任栅栏与未知子路径 404
的行为与阶段一 A **逐字节保持不变**。

快照的 `frozen` 判定**按目标作用域探测**：带 `?session=` 时用该会话自己的 Agent scope
（与真实回合 `assembleContextFor` 同形），不带时用本插件私有的探针 scope；响应里的
`frozenScope` / `frozenScopeReason` 明说该判定描述哪个作用域。`complete` 是按 scope 生效的，
所以同一个 mount 对某个会话可以报 `frozen:true`、对全局视图报 `frozen:false` —— 这是设计，
不是不一致。**UI 在 `frozenScope:"global"` 且 `frozenScopeReason` 非 null 时必须按
「本会话未知」呈现，不能当作「未冻结」。**

`frozen` **只**由「本插件追加的探针段是否幸存」决定，**不做任何段数比较** ——
别的插件在自己的 `system-prompt/assemble` 监听器里增删段是正常现象（真机上
`dsh-expression` 就追加了一段），不得被读成冻结。此类段在 `effective[].origin` 里标为
`downstream-added`，UI 应呈现为「其它插件在后处理阶段加入的段」，且它**仍然可覆盖**。

`rendered` 对缺值变量**保留字面量 `{{name}}`**，绝不输出裸 `undefined`；
`renderedResolved` 与 `unresolvedVariables` 如实报告哪些变量缺少上下文。
带 `?session=` 时探针 context 含 `agent`，agent 侧变量可解析；无 session 时不能。

阶段二新增：`GET /prompt-setting/history`、`GET /prompt-setting/diff`、
`GET /prompt-setting/export`、`POST /prompt-setting/import`，以及
`DELETE /prompt-setting/overrides?reset=true`（整层重置）。**既有的
`PUT` / `DELETE` 响应体逐字节不变**（历史写入的结果通过 `GET /history` 的 `lastError` 暴露），
405 的 `allow` 语义、字段含义与状态码全部保持。历史保留最近 N 条（默认 100，可用
`apply(ctx, {historyLimit})` 或环境变量 `DSH_PROMPT_SETTING_HISTORY_LIMIT` 配置，钳制在 10–10000）。

已知边界（详细理由见 [`CONTRACT.md`](./CONTRACT.md) §7 与 [`NOTES.md`](./NOTES.md)）：

- 快照取**无 scope 的全局装配**；agent-scoped 段不在首版范围（监听器本身对 scope 是正确的）；
- `rendered` 对未知 `{{变量}}` 保留字面量，而真实回合会抛错（快照绝不能因渲染失败而报错）；
- 挂载后新建的工作区，在下次路由请求刷新缓存前不贡献覆盖。

阶段二的已知边界（同样详见 `CONTRACT.md` §7）：

- 历史记录携带**全文**，单文件上界是「条数」而不是「字节数」；
- 导入的提交是**逐文件**原子的，不是跨文件事务（rename 之间的文件系统错误会留下已替换的层，
  错误信息会写明程度）；任何发生在 rename 之前的失败都不可能留下半成品；
- diff 的段级结果来自两条记录的**摘要快照**（无文本），只有被聚焦的那一段做行级比较。

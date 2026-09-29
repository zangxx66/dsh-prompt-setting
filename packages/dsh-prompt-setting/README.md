# dsh-prompt-setting（插件包）

DSH 默认 System Prompt 管理插件。**阶段一（A/B/C）与阶段二已交付**：宿主侧装配快照 +
覆盖引擎 + 两层持久化 + 版本历史 + diff + 导出/导入；客户端侧设置页 Prompt 管理器，
自 g-015 起是**四个一级 tab**（默认第一个）：

1. **「我的 Prompt」** — 唯一写入口：层选择 + 文本框 + 保存 / 恢复默认；
2. **「提示词总览」** — 纯只读：装配后的段列表（状态标记 + 搜索 + 筛选 + 复制）+ 全文与 base↔effective 对比；
3. **「历史与备份」** — 历史列表 + 版本对比 + 导出下载 / 导入预览；
4. **「高级」** — 旧覆盖只读列表 +「清除全部覆盖」(`legacy=true`) /「整层恢复默认」(`reset=true`) 两个二次确认按钮 + 状态区。

Revision 6 的**行内编辑 / 新建覆盖 UI 已整块删除**（任意段名、`hide`/`append`、动作 tab、层 tab、可行性校验、
`data-editor-row` 归属与回退槽位、`scrollIntoView` 表单入视口都不存在了）：写入面收窄到一个名字之后，
再多的写入口只是宿主必然拒绝的路径。四个 tab 的标记、默认值与删除映射见下文
「设置页的四个一级 tab」、[`CONTRACT.md`](./CONTRACT.md) §13、[`NOTES.md`](./NOTES.md) §93。

**Revision 7（本包当前形态）：插件自己注册一段 Prompt，写入面收窄到这一段。**
宿主半在 `apply` 期间用 `ctx.systemPrompt.section()` 注册**自己的**一段
（保留名 `prompt-setting:custom-prompt`、`order: 1000000`、`interpolate: false`、空文本注册）；
用户在「我的 Prompt」里写的文本，通过**既有覆盖引擎**的 `replace` 落到这一段上，排在所有
DSH 仓库内置段之后。未配置时这一段对最终 prompt **零贡献**（空段被渲染器丢弃），
所以「装了但没写」与「没装」渲染出的 prompt 逐字节相同。
写入面同时收窄：`PUT`／单名 `DELETE`／`import` 只接受保留名（其他名字一律
`403 write-locked`，拒绝时不碰文件一个字节）；`export` 只导出保留名条目并显式声明省略条数
（`exportScope`）；新增 `DELETE ...&legacy=true` 只清旧覆盖（保留「我的 Prompt」），
`?reset=true` 仍清整层。旧覆盖（其他名字）**行为零变化、但冻结只读**：UI 只能看与整批清除，
改单条要手工编辑层文件（该文件仍是唯一事实来源，每次路由请求都会重读）。
`interpolate: false` 不是风格选择：用户文本是任意文本，一旦参与插值，写一个 `{{不存在的变量}}`
就会让之后**每一轮**装配抛错。
完整契约见 [`CONTRACT.md`](./CONTRACT.md) §15，设计取舍与实测出处见 [`NOTES.md`](./NOTES.md) §92。

本文件讲的是**这个包怎么装、怎么改**；仓库整体目标与路线图见仓库根 `README.md`，
REST 契约见同目录 [`CONTRACT.md`](./CONTRACT.md)（已冻结，客户端照它写），
阶段一 A 的设计取舍、探针实测方式与未验证项见 [`NOTES.md`](./NOTES.md)。

## 包内容

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半：`/prompt-setting` 前缀路由（ping / snapshot / overrides / history / diff / export / import）+ `system-prompt/assemble` 覆盖监听器 + 注册保留段 `prompt-setting:custom-prompt` |
| `core/custom.js` | **纯函数策略**（Revision 7）：保留段名/`order`/`interpolate` 常量、写入面判定（`403 write-locked` / `400 unsupported-action`）、`legacyPlan`、导出范围声明、导入文档的名字闸门。零 IO、零 `ctx` |
| `core/overrides.js` | **纯函数内核**：配置校验、两层合并、分段变换、`complete` 推导、快照投影、渲染。零 IO、零 `ctx` |
| `core/history.js` | **纯函数**：历史记录的构造与校验、jsonl 解析（容错）、裁剪上界、查询分页、SHA-256 指纹 |
| `core/diff.js` | **纯函数**：段级快照比较 + 行级 diff（精确 LCS，超预算退化为有界比较并明示） |
| `core/transfer.js` | **纯函数**：导出文档构造、导入文档的 schema/版本/字段校验、冲突策略与变更计划 |
| `core/store.js` | **唯一碰文件系统**的模块：两层路径解析 + 原子写（临时文件 + `rename`）+ 读时校验 + `history.jsonl` 追加与裁剪 + 多文件原子替换（导入） |
| `core/compat.js` | **boot 兼容性**：semver 解析/比较/范围判定（纯函数）+ DSH 版本探测（best-effort、多锚点、绝不抛）+ 三分支文案（范围内静默 / 超范围 / 探测失败）与 `apply` 失败文案 |
| `core/experiments.js` | E1–E5 的**实测结论**（由集成测试产出，快照与 CONTRACT.md 共用同一份文案） |
| `client.js` | 客户端半：「设置」里的独立一栏，**四个一级 tab**（默认「我的 Prompt」）：一行状态摘要（挂载 / 冻结三态 / 构建戳）+ 共用的会话选择器 +「我的 Prompt」写面板（唯一写入口：保留名 + `replace`，含恢复默认的二次确认）/「提示词总览」只读段列表与全文视图（搜索高亮 + `base`↔`effective` 对比，无任何写入口）/「历史与备份」（历史列表 + 版本对比，官方 `DiffBlock` + 自绘降级 + 导出下载与导入预览）/「高级」（旧覆盖只读列表 + `legacy=true` 与 `reset=true` 两个二次确认按钮 + 完整状态区与渲染器自检） |
| `cordis.patch.yml` | bundle 层：一条 `insert` 行同时承载两个半边 |
| `scripts/check-compat.mjs` | **只读兼容性自检**（`node scripts/check-compat.mjs`）：本插件版本 / 已装 DSH 版本 / peer 范围结论 / 四种 boot 失败形态的终端签名 / 救援步骤。零依赖、不联网、永不抛、退出码恒 0 |
| `package.json` | 包契约：`dsh.bundle.patch` + `dsh.client.platform: "web"` + `exports["./client"]` |
| `CONTRACT.md` | 冻结的 REST 契约：每个字段、每个 4xx、动作枚举、字段上限 |

零运行时依赖、零构建步骤。客户端半是手写 CJS 工厂（`window.__ModuleLoader__.load`），
**不要**引入 bundler / TypeScript / JSX——`react` 由浏览器 seed 模块表提供。

## 分层原则（改代码前先读）

宿主进程的改动**必须重启才能生效**，所以逻辑尽量放在可离线测试的模块里：

- `core/overrides.js`、`core/custom.js`、`core/history.js`、`core/diff.js`、`core/transfer.js` 是纯数据进、纯数据出；
  单测直接测它们，不碰 `ctx`（`core/history.js` 只用确定性的 `node:crypto` 算指纹）；
- `core/store.js` 承担全部 IO，且**不在装配路径上**（挂载时读、路由请求时刷新、之后只在内存里读）；
- `index.js` 只是薄适配层：**一个注册的 Prompt 段 + 一个 waterfall 监听器 + 路由分派**。
  段的注册走与路由、监听器同一个 `registerEffect` 台账（卸载或后续步骤失败都会撤销，注册失败按 g-013 只留一条可读信息、绝不让 DSH 启动失败），且**排在最后**注册：越可能失败的越先注册，失败时要撤销的东西最少。

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
node --check index.js && node --check client.js && for f in core/*.js scripts/*.mjs; do node --check "$f"; done
node --test                                       # 349 项断言，0 skipped
node scripts/check-compat.mjs                     # 只读兼容性自检（不联网、永不抛）
npm pack --dry-run                                # 确认产物干净（16 个文件、无 test/、无 .dsh-graph）
```

> `node --test`（在本目录下自动发现 `test/`）是本包的规范命令。Node 24 会拒绝把目录当位置参数
> 传进去（`node --test test/` ⇒ `MODULE_NOT_FOUND`），这不是本包的问题；等价写法是
> `node --test test/*.test.mjs`。

`node --test` 的十二个套件：

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
| `test/boot.test.mjs` | **boot 韧性（g-013）**：导入期自检三分支（范围内静默 / 超范围一条 / 探测失败一条，且都不抛）、版本探测的多锚点与失败原因、`apply` 在「服务方法缺失 / 抛错 / 返回形状不符 / `ctx.effect` 缺失」下不抛且只打印一条、**半挂载回滚**（先注册的路由被 dispose、`live` 路由表为空）、失败的 disposer 被收容、**boot 连续性**（同管线下一个插件照常挂载）、客户端 factory 抛错不抛回 loader 且降级卡保留标记、自检脚本的终端签名与「无 DSH 也退出 0」 |

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

## 兼容性与救援（g-013）

**一句话**：本插件挂掉**不会**影响 DSH 启动与界面，但**终端是唯一的信号渠道** —— 不看启动终端，
你只会觉得「插件没生效」。

「不影响启动与界面」不是推断，而是主管在本机 DSH `0.1.7-rc.2` 上用功能探针实测的对照结论：
干净 profile / `inject` 服务不存在 / `apply` 期抛错三个临时实例，web UI 都是
**HTTP 200、34,240 B、含 `id="root"` 挂载点、67 条 `__DSH_BOOT__` 清单条目、64 个核心客户端模块**，
核心模块清单逐条 `diff` **完全相同**，清单里第一个 `plugins/??…client.js&rev=…` 资源同样 200 / JS /
33,930 B（原文见 `NOTES.md` §91 二）。

### 超出范围时的**实际**终端输出（2026-09-29 主管本机实测，DSH `0.1.7-rc.2`）

`…` 是抓取时的省略，其余逐字：

```text
dsh: skipping profile bundle "dsh-prompt-setting": Error: Plugin dsh-prompt-setting@0.1.0 is incompatible with dsh 0.1.7-rc.2: peerDependencies {"@deepseek-ai/dsh":">=9.0.0"}. Running it may cause crashes and data loss. … To accept this risk explicitly, grant the exact-version exemption …
dsh web: http://127.0.0.1:3087/?token=…
```

⇒ DSH **仍然正常启动**，只是本插件被整条跳过。原因（源码）：`@deepseek-ai/dsh-app-boot` 在**读 profile 的
`dsh.profile.bundles` 时**就对每个 bundle 跑 `evaluatePluginCompatibility()`，不通过就跳过并写 stderr
（`dsh-app-boot/lib/index.js:919-953`、`:322`、`:516`）；这一步发生在 `mountRootInclude()`（真正开始 import 插件）
**之前**，所以**我们的导入期「超范围」警告在 0.1.7-rc.2 上被抢占、观测不到**。安装期（`dsh plugin add` /
plugin manager）用的是同一套检查，会直接拒绝安装并给出 `dsh plugin allow-version` 的豁免指引。

### 本插件自己会说什么

| 时机 | 终端输出 | 说明 |
| --- | --- | --- |
| 导入期 · DSH 在已测试范围内 | **什么都不打印** | 范围内静默是设计：不给每次 boot 加噪音 |
| 导入期 · 超出 `peerDependencies` 范围 | **在这台平台上轮不到我们**：平台先跳过整个 bundle 并点名（逐字见下），本包根本不会被 import。若你看到的是我们那条 `[dsh-prompt-setting] 本插件 <版本> … 超出已测试范围 …`，说明平台的这道闸门没生效（更老的/改过的宿主） | 两条都是「只警告、绝不抛、boot 继续」；我们保留自己的分支作为**兜底/防御纵深**，但它**不是** 0.1.7-rc.2 上的实际观察 |
| 导入期 · 探测不到 DSH 版本 | 一条 `… 无法探测已安装的 DSH 版本（期望范围 …）：探测结果：<原因>。…` | 同上；范围内的判定逻辑与消息在 `core/compat.js`，可离线单测 |
| `apply` 失败（服务方法改名/缺失、方法抛错、返回形状不符…） | 一条 `… 挂载失败，本插件已停用，DSH 其余功能不受影响。检测到的 DSH：… 首因：… 已撤销 N 项已注册 effect，不会留下半挂载。…` | 先撤销本次已注册的 effect（**不留半挂载**）再打印；**同时**写终端（`stderr`）与 `ctx.logger.error`；**不把异常抛回 loader** |
| 客户端半加载失败（`require('react')` 失败、指纹逻辑异常…） | 一条 `… 客户端半加载失败：设置页将以降级提示卡呈现…` | `console.error` 一条，**不抛回 loader**；能用 React 就注册降级卡片，连 React 都没有就什么都不注册；渲染期失败仍走既有 `renderFailureCard` |

终端消息在哪看：**`dsh web` 的前台输出**（启动时打印的那一行 web URL 也在同一处）。
设置页里看不到 boot 期消息，所以排查 boot 问题必须看启动终端。

> **为什么失败信息「同时」写终端和 logger（源码级依据，写进 `NOTES.md` §91 六）**：本 profile 里
> `ctx.logger` **没有终端出口** —— 唯一注册给它的 exporter（`@deepseek-ai/dsh-app-boot` 的）只是把
> `warn`/`error` 塞进 `startupLogs`，而 `startupLogs` 只在**启动失败**时才被挂到 `StartupError` 上；
> cordis 自带的 exporter 只写内存环形缓冲。平台自己的告警因此是**直接 `process.stderr.write`** 的。
> 所以只走 `ctx.logger` = 终端里**什么都看不到** ⇒ 我们两个渠道都写（宁可极端情况下重复一次，
> 也不能让信息消失）。

### 三条边界（插件内做不到的事，别指望它）

① **`inject` 的服务消失** ⇒ 我们的 `apply` **根本不会执行**（Cordis 等服务齐了才调用它）；终端只有
   `<id> (<name>): pending (waiting for service: <service>)`。这一种**插件内无法捕获**（代码没跑），
   只能靠导入期自检 + 本文档。
② **`cordis.patch.yml` 因 schema 变动而不合法**（例如写错 verb）⇒ 失败发生在 **profile 组合层**、
   早于本插件任何代码，而且**终端完全没有输出**（插件静默不激活，平台不报 —— 最糟的一种）。
   插件**无法自救**，只能靠下面的自检脚本 + `dsh --dump-config`。
③ **信号只在终端里**：没有 UI 提示、没有远程上报（非目标）。不看终端 = 没有信号。

### 插件没出现、但终端也没有任何报错时怎么办

先跑本包自带的**只读自检**（随包发布：`files` 含 `scripts`；零依赖、不联网、**永不抛**、退出码恒 0）：

```bash
node scripts/check-compat.mjs        # 等价：npm run check-compat
```

它会打印：本插件版本、`peerDependencies` 声明的 DSH 范围、探测到的 DSH 版本**与来源**、范围内 / 超范围 /
探测失败的结论、**四种 boot 失败形态的终端签名**（逐字，用于比对）、以及下面的救援步骤。探测不到 DSH 时
可用 `DSH_INSTALL_ROOT=<DSH 安装根> node scripts/check-compat.mjs` 再跑一次。

然后**只读**看组合结果（不启动、不改任何东西）：

```bash
dsh --profile web --dump-config          # 组合后的 profile 树：本插件条目在不在、patch 有没有生效
dsh --profile web --dump-default-config  # 不含用户层与 --patch 的结果，用来对比
dsh --profile web --dump-config-schema   # 条目/补丁的 JSON Schema（写 --patch 前先对字段）
```

### 救援步骤（按侵入性从小到大）

1. **摘掉本包即可恢复**（需重启 `dsh web`）：编辑 `$DSH_HOME/profiles/web/package.json`，从
   `dsh.profile.bundles` 里去掉 `dsh-prompt-setting`；或 `dsh plugin --profile web remove dsh-prompt-setting`。
2. **用 `--patch` 临时覆盖**（不改 profile 文件，可重复、叠加在 profile 层之后）：
   `dsh web --patch ./off.yml`，在 `off.yml` 里按 Loader 方言覆盖/禁用本插件对应的条目。
3. **换一个干净 profile 先把 DSH 起起来**：`dsh rescue --from-default-profile web`。
4. 修好后：宿主半（`index.js` / `core/**`）必须重启 `dsh web`；客户端半（`client.js`）由 HMR 热替换。

> 三种「DSH 更新后本插件坏了」的处置都指向同一个动作：**先把本包摘掉让 DSH 可用，再等本包跟进**。
> 本插件不做自动降级重试、不做远程上报（非目标）。

## 设置页的四个一级 tab（g-015）

页面顶部只有三件东西：标题、**一行**关键状态摘要（挂载 / 冻结三态 / 构建戳）+ 刷新、以及所有 tab
共用的会话选择器。其余按功能与使用频率分成四个 tab，顺序固定、默认打开第一个：

| # | `data-tab-value` | tab | 内容 |
| --- | --- | --- | --- |
| 1 | `mine` | **我的 Prompt** | **唯一写入口**：层选择（用户级 / 工作区级，工作区级需会话）+ 文本框 + 保存 + 恢复默认。写的是契约保留段 `prompt-setting:custom-prompt` + `action=replace`，下一轮生效；该段 `interpolate:false`，写进去的 `{{变量}}` 原样交给模型 |
| 2 | `overview` | **提示词总览** | **纯只读**：装配后的段列表（状态标记：已覆盖 / 已隐藏 / 追加 / 下游新增 / 未命中覆盖）+ 搜索 + 筛选 + 复制，以及渲染文本与 base↔effective 对比。渲染树里**不存在任何编辑/新建/删除入口** |
| 3 | `history` | **历史与备份** | 历史列表 + 版本对比 + 导出 / 导入 + 二次确认。不开这个 tab 不发历史/差异请求 |
| 4 | `advanced` | **高级** | 旧覆盖只读列表（名字 / 动作 / 层 / 生效状态 / 原因）+「清除全部覆盖」(`legacy=true`，保留「我的 Prompt」) 与「整层恢复默认」(`reset=true`) 两个各自二次确认的按钮 + 状态区（挂载 / 冻结 / 构建戳 / 渲染器 / 自检） |

**只读总览不含保留段**：它是「我的 Prompt」的东西，tab 里有一行说明指过去，不重复展示。
**机器可读标记**：`data-region="tabs"` + `data-active-tab="<值>"`（根容器上同样有）、每个 tab 控件的
`data-tab-value`（分组标记 `data-tab-group="main"` 在两个渲染器分支都存在）、以及**唯一**一个
`data-region="tab-panel"` + `data-tab-value="<值>"`。切 tab 只渲染对应面板。

Revision 6 的**行内编辑/新建覆盖 UI 已整块删除**（行内表单、动作 tab、层 tab、可行性校验、编辑/新建/删除
入口按钮），因为写入面已经是「一个名字宽」：一个提供更多写入口的 UI，就是一个提供宿主必然拒绝的写入口的
UI。逐条删除映射见 [`NOTES.md`](./NOTES.md) §93 第三节，契约见 [`CONTRACT.md`](./CONTRACT.md) §13。

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
| `client: the english render sweep shows no CJK and no bare key, in any branch` | 用 **en** 词典渲染 **39 个场景**（四个一级 tab、全部面板与关键状态，6946 条渲染字符串，含 `placeholder`/`title`/`aria-label`），断言**零 CJK**、**无裸 key 回落**、en 词典非空且值不等于 key |
| `client: the english sweep really walked every required branch marker` | **80 个 `data-*` 分支标记**必达（含四个 tab 的 `data-active-tab`、`data-mine-state` 五态、四种 `data-confirm-kind`、19 个 `data-warning`、构建戳三态、冻结三态、错误码横幅），少一个就红 |

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

## Revision 7 边界（宿主半 + 契约 + g-015 的客户端重排）

- **注册段的真机生效未验证**：注册本身是在**真实** `@deepseek-ai/dsh-system-prompt` 服务与真实
  Cordis context 上做的，真实 `renderPrompt` 也逐字节验证了文本与「空段零贡献」；但「重启后的
  `dsh web` 把这一段装配进最终 prompt」需要重启宿主才能观察，本轮**没有重启**，故按未验证项记录
  （`CONTRACT.md` §15.9、`NOTES.md` §92.6）。
- **`order: 1000000` 不是对第三方的保证**：本插件承诺的是排在**所有 DSH 仓库内置段**之后
  （内置位置表最大 `DEPLOYMENT_PERSONA_SUFFIX = 10200`）；另一个插件仍可用更大的有限值排到本段之后。
- **`complete: true` 的 scope 会丢掉用户文本**：整段列表被替换为该 complete 段，本插件的段不在最终
  prompt 里。快照如实报告（`frozen` + `frozenReason`，本段 `applied:false`、
  `reason: "the section was removed from the assembled result"`），UI 必须在「我的 Prompt」面板明说。
- **空段会出现在快照视图里**：`base.sections` / `effective.sections` 恒多一条（本段、空、最后）。
  最终 prompt 不受影响，但拿 Revision 6 的数组逐项对比的消费者要预期这条差异。
- **~~客户端半仍是 Revision 6 的编辑器~~（g-015 已解决）**：设置页现在是上文四个一级 tab，
  唯一写入口「我的 Prompt」写的就是保留名 + `replace`，因此不存在「UI 能发起、宿主必然拒绝」的写入路径。
- **`interpolate: false` 的代价**：用户在「我的 Prompt」里写的 `{{变量}}` **永不替换**，原样进入
  prompt。这是刻意的取舍（自由文本，不是模板语言）。

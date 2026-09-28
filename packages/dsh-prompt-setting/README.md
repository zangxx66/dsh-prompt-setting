# dsh-prompt-setting（插件包）

DSH 默认 System Prompt 管理插件。**阶段一（A/B/C）与阶段二已交付**：宿主侧装配快照 +
覆盖引擎 + 两层持久化 + 版本历史 + diff + 导出/导入，客户端侧设置页 Prompt 管理器
（分段浏览、全文检索、就地编辑、覆盖管理、历史与版本对比、恢复默认、导出下载与导入预览）。

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
| `client.js` | 客户端半：「设置」里的独立一栏：状态条 / 会话选择器 / 分段视图（含 `origin` 标注与筛选）/ 全文视图（搜索高亮 + `base`↔`effective` 对比）/ 编辑面板（保存前可行性校验）/ 覆盖管理 / 历史列表与版本对比（官方 `DiffBlock` + 自绘降级）/ 恢复默认（单段与整层，均二次确认）/ 导出下载与导入（先干跑预览再二次确认） |
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
   也可在页面控制台跑 `await (await fetch('/prompt-setting/ping')).json()`。
   **裸 `curl` 会被拒绝（401）**：`requestRejection` 第二段是浏览器 cookie 认证，缺少它即 401，
   这是预期行为，不是路由没挂上（细节见 [NOTES.md](./NOTES.md) §4）。

## 开发

```bash
cd packages/dsh-prompt-setting
node --check index.js && node --check client.js && for f in core/*.js; do node --check "$f"; done
node --test                                       # 276 项断言，0 skipped
npm pack --dry-run                                # 确认产物干净（无 test/、无 .dsh-graph）
```

`node --test` 的十个套件：

| 套件 | 覆盖 |
| --- | --- |
| `test/overrides.test.mjs` | 纯函数内核：校验/合并/变换/frozen 推导/投影/渲染 |
| `test/history.test.mjs` | 历史内核与持久化：记录校验、jsonl 容错解析、裁剪上界、分页/过滤、可配置 N、追加写不重写、导入的多文件原子替换 |
| `test/diff.test.mjs` | diff 内核：空文本、CRLF、超长单行、有界退化与预算、段级状态、焦点段选择 |
| `test/transfer.test.mjs` | 导出文档形状、导入校验的每一条拒绝码、merge/replace 冲突策略、dryRun 计数 |
| `test/store.test.mjs` | 路径解析、读时校验、**原子写**（硬链接见证旧文件未被就地改写） |
| `test/route.test.mjs` | 全套宿主面：栅栏、405/404、两层、frozen、全部 4xx、D1/D2 回归（用复刻真语义含 scope 父链的假 Host） |
| `test/stage2.test.mjs` | 阶段二路由：历史追加与裁剪、整层重置、diff 选择器、导出/导入、**导入失败的哈希原子性断言** |
| `test/host.test.mjs` | 阶段一 A 的既有套件：清单契约、ping、信任栅栏、405/404（**行为未变，断言仍在**） |
| `test/client.test.mjs` | 客户端半：vm 沙箱 + 递归展开函数组件的迷你渲染器 + fetch 路由桩（含 `useSessions` 缺失降级、`frozenScope` 三态、保存前可行性校验、历史/对比/恢复默认/导出导入面板与 `DiffBlock` 分支） |
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

- **客户端半（`client.js`）**：**刷新页面即生效**，无需重启。实测依据：pid 未变的情况下合并新版本，阶段一 C 的整套 UI、以及后续两轮交互重构都是靠刷新上线的（浏览器会重新拉取 bundle）。
- **宿主半（`index.js` / `core/**`）**：**需要重启 `dsh web`**，代码不会自动重载。实测依据（三点一致）：
  1. 阶段二（g-005）的宿主能力是在**重启之后**才在真机可用的（`history.jsonl` 首次在重启后的保存中出现）；
  2. 阶段一 B 的 `/snapshot` 路由在本机「看起来无需重启」曾被我误读为热重载，复查 pid 时间线发现**中间确实发生过一次重启**（19:25 仍为旧 pid、19:27 变新 pid、19:29 才验证成功）；
  3. 最后反证：g-007 的宿主改动（用户层每请求重读）在**未重启**的进程上完全不起作用——直接改写 `~/.dsh/prompt-setting/overrides.json` 后，页面刷新与下一轮装配都看不到外部改动。

⇒ 正确姿势：改 `client.js` 只需刷新；改 `index.js` / `core/**` 必须重启。排障顺序：

1. 改动只涉及 **`client.js`** ⇒ **强制刷新页面**即可（浏览器端 `__ModuleLoader__` 可能持有同 id 的旧模块）；
2. 改动涉及 **`index.js` / `core/**`** ⇒ **必须重启 `dsh web`**（再刷新页面）；
3. 配置类字段（`cordis.patch.yml` / `package.json` 的 config）改动本就热生效。

**换包本身**（改名、换依赖 spec（`link:` ↔ tarball）、换安装目标）同样必须重启，`plugin_manager` 的
返回值会明说 `application: "restart-required"`。

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

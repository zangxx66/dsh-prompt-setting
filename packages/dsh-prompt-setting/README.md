# dsh-prompt-setting（插件包）

DSH 默认 System Prompt 管理插件。**当前为阶段一 B：装配快照 + 覆盖引擎 + 两层持久化**
（客户端 UI 仍是阶段一 A 的占位页，阶段一 C 才改）。

本文件讲的是**这个包怎么装、怎么改**；仓库整体目标与路线图见仓库根 `README.md`，
REST 契约见同目录 [`CONTRACT.md`](./CONTRACT.md)（已冻结，客户端照它写），
阶段一 A 的设计取舍、探针实测方式与未验证项见 [`NOTES.md`](./NOTES.md)。

## 包内容

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半：`/prompt-setting` 前缀路由（ping / snapshot / overrides）+ `system-prompt/assemble` 覆盖监听器 |
| `core/overrides.js` | **纯函数内核**：配置校验、两层合并、分段变换、`complete` 推导、快照投影、渲染。零 IO、零 `ctx` |
| `core/store.js` | **唯一碰文件系统**的模块：两层路径解析 + 原子写（临时文件 + `rename`）+ 读时校验 |
| `core/experiments.js` | E1–E5 的**实测结论**（由集成测试产出，快照与 CONTRACT.md 共用同一份文案） |
| `client.js` | 客户端半：注册「设置」里的独立一栏 + 占位页 + 探针状态区（阶段一 C 才改） |
| `cordis.patch.yml` | bundle 层：一条 `insert` 行同时承载两个半边 |
| `package.json` | 包契约：`dsh.bundle.patch` + `dsh.client.platform: "web"` + `exports["./client"]` |
| `CONTRACT.md` | 冻结的 REST 契约：每个字段、每个 4xx、动作枚举、字段上限 |

零运行时依赖、零构建步骤。客户端半是手写 CJS 工厂（`window.__ModuleLoader__.load`），
**不要**引入 bundler / TypeScript / JSX——`react` 由浏览器 seed 模块表提供。

## 分层原则（改代码前先读）

宿主进程的改动**必须重启才能生效**，所以逻辑尽量放在可离线测试的模块里：

- `core/overrides.js` 是纯数据进、纯数据出；单测直接测它，不碰 `ctx`；
- `core/store.js` 承担全部 IO，且**不在装配路径上**（挂载时读、路由请求时刷新、之后只在内存里读）；
- `index.js` 只是薄适配层：一个 waterfall 监听器 + 四条路由。

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
node --check index.js && node --check core/overrides.js && node --check core/store.js
node --test                                       # 103 项断言，0 skipped
npm pack --dry-run                                # 确认产物干净（无 test/、无 .dsh-graph）
```

`node --test` 的四个套件：

| 套件 | 覆盖 |
| --- | --- |
| `test/overrides.test.mjs` | 纯函数内核：校验/合并/变换/frozen 推导/投影/渲染 |
| `test/store.test.mjs` | 路径解析、读时校验、**原子写**（硬链接见证旧文件未被就地改写） |
| `test/route.test.mjs` | 全套宿主面：栅栏、405/404、两层、frozen、全部 4xx（用复刻真语义的假 Host） |
| `test/host.test.mjs` | 阶段一 A 的既有套件：清单契约、ping、信任栅栏、405/404（**行为未变，断言仍在**） |
| `test/client.test.mjs` | 阶段一 A 的客户端套件（`node:vm` 沙箱，本阶段未改 `client.js`） |
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

### ⚠️ 改包 JS 实体后必须重启 `dsh web`

`client.js` / `index.js` 是**交到运行时的 JS 实体**，不是配置：

- **改 `cordis.patch.yml` 或 `package.json` 的 config 类字段** → 可热生效（`patchReload: live`，重载页面即可）；
- **改 `client.js` / `index.js` 的代码** → **必须重启 `dsh web` 进程**，并强制刷新浏览器，
  否则页面跑的还是旧模块（浏览器端 `__ModuleLoader__` 已有同 id 模块，不会重新拉取）。

排障时先确认这一步，否则会误判成「代码没生效」。

## 阶段边界

阶段一 B 交付宿主侧全部能力：`GET /prompt-setting/snapshot`、
`GET|PUT|DELETE /prompt-setting/overrides`、覆盖引擎与两层持久化（见
[`CONTRACT.md`](./CONTRACT.md)）。`GET /prompt-setting/ping`、信任栅栏与未知子路径 404
的行为与阶段一 A **逐字节保持不变**。

阶段一 C 才动 `client.js`：分段编辑界面、frozen 时的禁用与原因提示都在那时接上。
本阶段**没有**改动 `client.js`。

已知边界（详细理由见 [`CONTRACT.md`](./CONTRACT.md) §7 与 [`NOTES.md`](./NOTES.md)）：

- 快照取**无 scope 的全局装配**；agent-scoped 段不在首版范围（监听器本身对 scope 是正确的）；
- `rendered` 对未知 `{{变量}}` 保留字面量，而真实回合会抛错（快照绝不能因渲染失败而报错）；
- 挂载后新建的工作区，在下次路由请求刷新缓存前不贡献覆盖。

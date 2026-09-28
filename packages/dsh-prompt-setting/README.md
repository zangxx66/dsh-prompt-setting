# dsh-prompt-setting（插件包）

DSH 默认 System Prompt 管理插件。**当前为阶段一 A：骨架 + 只读探针 + 设置页占位。**

本文件讲的是**这个包怎么装、怎么改**；仓库整体目标与路线图见仓库根 `README.md`，
阶段一 A 的设计取舍、探针实测方式与未验证项见同目录 [`NOTES.md`](./NOTES.md)。

## 包内容

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半：`GET /prompt-setting/ping` 只读探针路由（含信任栅栏） |
| `client.js` | 客户端半：注册「设置」里的独立一栏 + 占位页 + 探针状态区 |
| `cordis.patch.yml` | bundle 层：一条 `insert` 行同时承载两个半边 |
| `package.json` | 包契约：`dsh.bundle.patch` + `dsh.client.platform: "web"` + `exports["./client"]` |

零运行时依赖、零构建步骤。客户端半是手写 CJS 工厂（`window.__ModuleLoader__.load`），
**不要**引入 bundler / TypeScript / JSX——`react` 由浏览器 seed 模块表提供。

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
node --check index.js && node --check client.js   # 语法
node --test                                       # 31 项断言（宿主路由/信任栅栏/上报 + 客户端注册/渲染分支/locale 退化）
npm pack --dry-run                                # 确认产物干净
```

测试不需要浏览器：`client.js` 被放进 `node:vm` 沙箱里跑，`require` / React / `fetch` 全部是桩，
因此「primitives 可用 / 不可用」「探针成功 / HTTP 错误 / 网络错误」四条路径都可离线断言。

> `npm pack` 若报 `Log files were not written ... /Users/<you>/.npm/_logs`，
> 是本机 npm 缓存目录不可写，加 `npm_config_cache=/tmp/npm-cache` 即可，与包本身无关。

### ⚠️ 改包 JS 实体后必须重启 `dsh web`

`client.js` / `index.js` 是**交到运行时的 JS 实体**，不是配置：

- **改 `cordis.patch.yml` 或 `package.json` 的 config 类字段** → 可热生效（`patchReload: live`，重载页面即可）；
- **改 `client.js` / `index.js` 的代码** → **必须重启 `dsh web` 进程**，并强制刷新浏览器，
  否则页面跑的还是旧模块（浏览器端 `__ModuleLoader__` 已有同 id 模块，不会重新拉取）。

排障时先确认这一步，否则会误判成「代码没生效」。

## 阶段边界

阶段一 A **只有**一条只读探针路由。装配快照、`system-prompt/assemble` 覆盖引擎、
分段编辑与持久化在阶段一 B / C 加入，届时新增路由一律挂在 `/prompt-setting` 前缀下，
`index.js` 里的信任栅栏、JSON 应答与未知子路径 404 保持不变。

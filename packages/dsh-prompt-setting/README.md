# dsh-prompt-setting

> DSH（DeepSeek Harness）的系统提示词管理插件 —— 在 Web GUI 的「设置」里看得见、写得动、可回滚。
> System Prompt management for DSH (DeepSeek Harness) — see it, write it, roll it back, from the Web GUI's Settings.

## 这是什么 / What it is

**问题**：DSH 每一轮会话都会注入一段由 `@deepseek-ai/dsh-system-prompt` 装配出来的基座系统提示词。
想改它，以前只有一条路 —— 去 pnpm 全局 `node_modules` 里硬改文件：升级就被覆盖、污染全局安装、
改了什么没法回溯，而且**根本看不到最终拼出来的 prompt 到底长什么样**。

> **The problem**: every DSH turn is injected with a base system prompt assembled by
> `@deepseek-ai/dsh-system-prompt`. The only way to change it used to be hand-editing the global pnpm
> `node_modules` — overwritten by the next upgrade, globally polluted, no record of what changed, and
> **no way at all to see what the finally assembled prompt looks like**.

**这个插件**把这件事搬进设置页：装配结果按段展开；你自己写的那部分单独成段、稳定排在最后；
其余内置段保持只读。改动有历史、可 diff、可导出 / 导入。**全程不碰 DSH 安装包**，
配置只写插件自己的数据目录，升级 / 重装 DSH 不会丢。

> **This plugin** moves that into Settings: the assembly is laid out section by section; the text you
> write is its own section, pinned to the end; every other built-in section stays read-only. Changes
> come with history, diffs and export / import. **Nothing in the DSH install is touched** —
> configuration is written only to the plugin's own data directory, so upgrading or reinstalling DSH
> never loses it.

## 功能 / Features

设置页里会多出一栏 **「Prompt settings」**（`id: prompt-setting`），四个一级 tab：

- **我的 Prompt / My Prompt** —— 唯一写入口：写下你自己的系统级指令（选层 → 编辑 → 保存），
  一键恢复默认。这段文本**排在所有内置段之后**。
  > The only write surface: your own system-level instructions (pick a layer → edit → save), with a
  > one-click restore. The text is **placed after every built-in section**.

- **提示词总览 / Prompt overview** —— 纯只读：分段列表（状态标记 / 搜索 / 筛选 / 复制）、完整全文，
  以及 `base ↔ effective` 对比，一眼看出你的改动究竟改变了什么。
  > Read-only: the assembled section list (status marks / search / filters / copy), the full text, and a
  > `base ↔ effective` diff, so you can see exactly what your change did.

- **历史与备份 / History & backup** —— 历史列表 + 行级版本对比；配置导出下载、导入预览
  （先看变更计划，确认后才落盘）。
  > History list + line-level diffs; export the configuration for download, and preview an import —
  > the change plan is shown before anything is written.

- **高级 / Advanced** —— 旧版覆盖的只读列表、「清除全部覆盖」与「整层恢复默认」两个二次确认按钮，
  以及完整状态区（挂载情况 / 构建戳 / 渲染器自检）。
  > A read-only list of legacy overrides, two double-confirm buttons ("clear all overrides", "reset the
  > whole layer"), and a full status area (mount state / build fingerprint / renderer self-check).

其它特性 / More:

- **两层作用域 / Two layers** —— 用户级默认 + 工作区级覆盖，**工作区级优先**。
  > A user-level default plus a workspace-level override; **the workspace wins**.
- **零运行时依赖、零构建步骤 / Zero runtime dependencies, zero build step** —— 一包纯 JS，不拉依赖、不编译。
  > One package of plain JS — nothing to fetch, nothing to compile.
- **界面文案跟随 DSH 语言 / UI copy follows DSH** —— DSH 切到中文，这一页就是中文，不需要刷新或重启。
  > Switch DSH to Chinese and this page turns Chinese, with no refresh or restart.
- **装了但没写 = 等于没装 / Installed but empty = not installed** —— 未填写时这一段对最终 prompt
  零贡献，渲染结果逐字节相同。
  > With no text the section contributes nothing to the final prompt; the rendering is byte-for-byte identical.

## 安装 / Install

用 DSH 的 plugin manager 以**绝对路径**安装本目录（**不要**手工编辑 profile 配置文件）：
需要 DSH `>= 0.1.7-rc.2 < 0.1.8`。

> Install this directory by **absolute path** with DSH's plugin manager (**do not** hand-edit profile
> config files). Requires DSH `>= 0.1.7-rc.2 < 0.1.8`.

```
plugin_manager(action: "install_bundle", target: "<绝对路径 absolute path>/packages/dsh-prompt-setting")
```

也可以直接从 GitHub 装（本仓库是 monorepo，**必须带 `#path:`**）：

> Or install straight from GitHub — this repository is a monorepo, so the **`#path:` part is required**:

```sh
dsh plugin --profile demo add 'github:zangxx66/dsh-prompt-setting#path:/packages/dsh-prompt-setting'
```

pnpm ≥10 默认不运行 git 依赖的构建脚本，第一次会失败并打印一个**确切的包键**；把它复制进该 profile 的
`pnpm-workspace.yaml` 的 `allowBuilds` 再重跑即可。**该授权 = 允许该包的代码在安装时于你的机器上执行**
（本包零构建，`prepare` 只做发布自检）。不想授权就用 `pnpm pack` 打 tarball 再 `add`，功能一致。

> pnpm ≥10 does not run a git dependency's build scripts by default: the first attempt fails and prints an
> **exact package key** — copy it into the profile's `pnpm-workspace.yaml` under `allowBuilds` and re-run.
> **That grant means this package's code may execute on your machine at install time** (this package is
> zero-build; `prepare` only runs a release self-check). To avoid the grant, `pnpm pack` a tarball and
> `add` that instead — identical behaviour.

安装后：打开「设置」应看到这一栏；想确认宿主半挂上了，页面的「原始响应」区会显示
`GET /prompt-setting/ping` 的返回 JSON（裸 `curl` 会被 `401` 拒绝，那是浏览器 cookie 认证，属预期行为）。

> After installing: the pane should appear in Settings. To confirm the host half is mounted, the page's
> "raw response" area shows the JSON from `GET /prompt-setting/ping` (a bare `curl` gets `401` — that is
> the browser cookie check, and expected).

## 给维护者 / For maintainers

```bash
cd packages/dsh-prompt-setting
node --test                    # 十四个套件（含真实 DSH 包的对照实验，须为 pass 而非 skip）
node scripts/check-compat.mjs  # 只读兼容性自检：不联网、永不抛、退出码恒 0
node scripts/prepare.mjs       # prepare 门禁：pnpm 从 git 安装时会自动跑它
npm pack --dry-run             # 确认发布产物干净（20 个文件、无 test/）
```

- **改动怎么生效 / How a change takes effect**：改 `client.js` 什么都不用做（DSH 自带客户端 HMR，
  已打开的标签页会被热替换）；改 `index.js` / `core/**` **必须重启 `dsh web`**；换包（改名、换 spec、
  换安装目标）同样必须重启。
  > `client.js` changes need nothing (DSH ships client HMR, open tabs are hot-swapped); `index.js` /
  > `core/**` changes **require restarting `dsh web`**; swapping the package itself does too.
- **重启的代价 / The cost of a restart**：重启会**终止所有等待确认的会话**，重开标签页找不回来 ——
  宿主半改动请攒批，能在 `client.js` 一侧解决的就别动宿主半。
  > A restart **kills every session waiting for confirmation**, and reopening the tab will not bring it
  > back — batch host-side changes, and prefer solving things on the `client.js` side.
- **构建戳 / Build fingerprint**：页面「状态」卡的构建戳有三态 —— `与宿主一致` / `页面版本已过期` /
  `构建戳未知`；`data-build-match` 就是它（`unknown` 永远不会被当成过期）。一条命令即可核对：
  > The status card's build fingerprint has three states, and `unknown` is never treated as stale. Check it with:
  ```js
  await (await fetch('/prompt-setting/ping')).json()   // → clientBuild: {hash, size, mtime}
  document.querySelector('[data-plugin="dsh-prompt-setting"]').dataset.buildMatch   // "true" | "false" | "unknown"
  ```

## 出问题时 / When something goes wrong

插件挂掉**不会**影响 DSH 启动与界面，所以**终端是唯一的信号渠道** —— 不看启动终端，你只会觉得
「插件没生效」。先跑只读自检，它会打印四种 boot 失败形态的终端签名、peer 范围结论与救援步骤：

> A broken plugin never affects DSH startup or the UI, which makes **the terminal the only signal**.
> Run the read-only self-check first: it prints the terminal signature of the four boot failure modes, the
> peer-range verdict and the rescue steps.

```bash
node scripts/check-compat.mjs
```

## 文档 / Docs

| 文档 / Document | 内容 / Contents |
| --- | --- |
| [CONTRACT.md](https://github.com/zangxx66/dsh-prompt-setting/blob/main/packages/dsh-prompt-setting/CONTRACT.md) | 冻结的 REST 契约：每个字段、动作枚举、字段上限、每一个 4xx。<br>The frozen REST contract: every field, action enum, size limit and 4xx. |
| [NOTES.md](https://github.com/zangxx66/dsh-prompt-setting/blob/main/packages/dsh-prompt-setting/NOTES.md) | 设计取舍与真机实测记录（含未验证项、已推翻的旧结论）。<br>Design trade-offs and on-machine measurements (including untested items). |
| [CHANGELOG.md](https://github.com/zangxx66/dsh-prompt-setting/blob/main/CHANGELOG.md) | 每个版本的用户可感知变更（中英对照）。<br>User-visible changes per release (bilingual). |
| [README_zh.md](https://github.com/zangxx66/dsh-prompt-setting/blob/main/README_zh.md) / [README.md](https://github.com/zangxx66/dsh-prompt-setting/blob/main/README.md) | 仓库总体说明（中文 / English）。<br>The repository-level overview (Chinese / English). |

## 许可证 / License

MIT —— 见 [LICENSE](https://github.com/zangxx66/dsh-prompt-setting/blob/main/LICENSE)
（`LICENSE` 随本包一起发布 / shipped with the package）。

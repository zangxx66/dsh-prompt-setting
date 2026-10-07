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

设置页里会多出一栏 **「Prompt settings」**（`id: prompt-setting`），五个一级 tab：

- **我的 Prompt / My Prompt** —— 唯一写入口：写下你自己的系统级指令（选层 → 编辑 → 保存），
  一键恢复默认。这段文本**排在所有内置段之后**。
  > The only write surface: your own system-level instructions (pick a layer → edit → save), with a
  > one-click restore. The text is **placed after every built-in section**.

- **提示词总览 / Prompt overview** —— 纯只读：分段列表（状态标记 / 搜索 / 筛选 / 复制）、完整全文，
  以及 `base ↔ effective` 对比，一眼看出你的改动究竟改变了什么。
  > Read-only: the assembled section list (status marks / search / filters / copy), the full text, and a
  > `base ↔ effective` diff, so you can see exactly what your change did.

- **版本历史 / Version history** —— 历史列表（定高内滚 + 翻页，默认每页 50）与行级版本对比。
  历史有自己的**作用域选择器**（工作区维度），与上方「查看范围」互不影响：用户层历史是全局的，
  不按会话过滤。
  > The history list (fixed-height, internally scrolling, paged) and line-level diffs. The log has its
  > **own** scope selector (workspace dimension), independent of the「查看范围」selector above: the user
  > layer's log is global and is never sliced by session.

- **备份与恢复 / Backup & restore** —— 配置导出下载、导入预览（先看变更计划，确认后才落盘）。
  > Export the configuration for download, and preview an import — the change plan is shown before
  > anything is written.

- **高级 / Advanced** —— 旧版覆盖的只读列表、「清除全部覆盖」与「整层恢复默认」两个二次确认按钮、
  **「检查更新」开关**（默认开启；关闭后本插件**完全不再联网**）、**「立即更新」**（把提示条里的版本
  交给宿主安装，装完需要你**手动重启**：命令行启动就重新运行 `dsh web`，官方桌面端就退出并重新
  打开 DeepSeek Harness），以及完整状态区（挂载情况 / 构建戳 / 渲染器自检）。
  > A read-only list of legacy overrides, two double-confirm buttons ("clear all overrides", "reset the
  > whole layer"), the **"Check for updates" switch** (on by default; off means this plugin makes **no
  > network request at all**), an **"Update now"** button (the host installs the version the banner named;
  > you restart yourself — re-run `dsh web` after a command-line start, or quit and reopen DeepSeek
  > Harness in the desktop app), and a full status area (mount state / build fingerprint / renderer
  > self-check).

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

## 联网检查更新 / Network access

**这个插件会主动联网 —— 只有一个请求，且可以关掉。**

> **This plugin does make network requests — exactly one, and you can turn it off.**

- **什么时候**：打开设置页时（本插件的那一栏挂载后）检查一次上游有没有新版本；同一进程内 6 小时内
  不会重复请求（「高级 → 立即重查」会强制重查一次）。
  > **When**: once when the settings page mounts, and not again for six hours in the same process (the
  > "Check now" button forces one).
- **请求什么**：由**宿主**（Node 侧）发一个 `GET`
  `https://api.github.com/repos/zangxx66/dsh-prompt-setting/releases/latest`，
  地址从本包 `package.json` 的 `repository.url` 解析而来。**只读**：没有 body、没有 cookie、
  不带任何本机 / 会话 / 工作区数据；`User-Agent` 是 `dsh-prompt-setting/<版本>`，5 秒超时。
  > **What**: the **host** (Node side) sends one `GET` to that GitHub Releases API URL, derived from
  > this package's `package.json`. Read-only: no body, no cookies, no local/session/workspace data;
  > `User-Agent: dsh-prompt-setting/<version>`; 5-second timeout.
- **结果怎么用**：只有「确实有更新」时，页面顶部才出现一条**可关闭**的提示（新版本号 + 发布页链接 +
  **「立即更新」**按钮）。没有更新、仓库还没发 release、请求失败 —— 页面顶部**一律零提示、零报错**；
  其中「仓库还没发 release / 版本号不可解析」是**上游事实**，只在「高级」的开关卡片里用一句中性
  文案说明（**检查失败不显示该句**）。
  > **What it does with the answer**: only a confirmed newer release shows a **dismissible** banner
  > (the version, a link to the release page, and an **"Update now"** button). No update, no release
  > yet, or a failed request shows **nothing at all** at the top of the page — no error either. "No
  > release yet / unparsable tag" is a *fact about upstream*, so it gets one neutral line inside the
  > Advanced switch card; a **failed** check does not get that line.
- **怎么关**：设置 →「Prompt 管理」→「高级」→ 关闭**「检查更新」**。关闭后**零请求**（包括打开
  设置页时：页面本地就知道不该问，连这个请求都不会发），并写入
  `$DSH_HOME/prompt-setting/preferences.json` 的 `{"updateCheck": false}`。想手工改也一样：
  把该值改成 `false`，或删掉整个文件回到默认（开启）。
  > **How to turn it off**: Settings → Prompt settings → Advanced → turn **"Check for updates"** off.
  > Then **zero requests** are made (including on page load — the page knows locally not to ask, so the
  > request is never sent), and `<DSH_HOME>/prompt-setting/preferences.json` gets
  > `{"updateCheck": false}`. Hand-editing works the same way: set it to `false`, or delete the file to
  > return to the default (on).
- **它不做什么**：不自动下载、不自动安装、**不自动重启**，也不检查 DSH 平台版本。
  > **What it never does**: no automatic download, no automatic install, **no automatic restart**, and
  > no DSH platform version check.

## 「立即更新」/ Update now

**装了新版本，重启还是你自己来 —— 而且提示会说清怎么重启。** 提示条上的「立即更新」会先弹一次
二次确认（写明装完要手动重启），确认后由**宿主**通过官方插件管理器把那个 Release 的 `.tgz` 包装进
当前 profile。装完页面按**启动形态**给对应的一句话：命令行启动的宿主说「已安装 vX.Y.Z，请手动重新
运行 `dsh web` 生效」；官方桌面端说「请退出并重新打开 DeepSeek Harness 生效」（桌面端用户看不到
终端，所以这里**不会**出现 `dsh web`）；形态无法判定时给两种形态都读得通的中性文案。
**这个插件不会重启任何东西。**

> **The new version gets installed; the restart is still yours — and the page says how.** "Update now"
> opens a second confirmation first (which says the restart is manual); on confirm the **host** installs
> that release's `.tgz` into the current profile through the official plugin manager. Afterwards the page
> answers for the **launch shape** it is talking to: a command-line host says "vX.Y.Z is installed —
> restart `dsh web` yourself", the official desktop app says "quit and reopen DeepSeek Harness" (a
> desktop user has no terminal, so `dsh web` never appears there), and an undecidable shape falls back to
> copy both readers can follow. **Nothing in this plugin restarts anything.**

- **装的是什么**：`https://github.com/zangxx66/dsh-prompt-setting/releases/download/<tag>/dsh-prompt-setting-<version>.tgz`，
  `<tag>`/`<version>` 取自**同一次**更新检查（所以「提示的版本 = 安装的版本」，且命中 6 小时缓存时
  **零外呼**）。这是 release 资产，安装时**不需要** pnpm 的构建脚本审批。
  > **What**: that release **asset** URL, whose `<tag>`/`<version>` come from the *same* update check
  > (so the version announced is the version installed, and a cached check costs zero outbound
  > requests). Installing it needs no pnpm build-script approval.
- **怎么进行**：点击后立刻返回一个 `requestId`，页面每隔 1.5～5 秒查一次进度（最长 16 分钟），
  期间可以**取消**；失败会给出分类原因（资产缺失 404 / 构建被拦 / 网络 / 缺 pnpm …）+ 重试按钮，
  **绝不自动重试、绝不自动重启**。
  > **How**: the click returns a `requestId` at once and the page polls it every 1.5–5 s (up to 16
  > minutes), with a **cancel** button while it runs. A failure names its category (asset missing 404 /
  > build blocked / network / pnpm missing / …) and offers retry — **never an automatic retry, never an
  > automatic restart**.
- **`link:` 安装会被拒绝**：如果这个 profile 里的 `dsh-prompt-setting` 是 `link:`/本地路径（也就是
  开发工作树），按钮会**拒绝执行**并给出手动更新指引 —— 绝不会把开发链接覆盖成一个发布版本。
  > **A `link:` install is refused**: if the profile holds this package as a `link:`/local path (a
  > development working tree), the button refuses and points at the manual route — it never overwrites
  > that link with a published version.
- **发布方需要知道的一件事**：每个 release 都必须把 `npm pack` 产物作为资产上传，命名固定
  `dsh-prompt-setting-<version>.tgz`；本包**不得**新增 `postinstall`/`install` 脚本（带它们的
  tarball 会被 pnpm 的构建门禁拦下）。做法见 `NOTES.md` §107 第六节。
  > **One thing a releaser must know**: every release must upload its `npm pack` asset, named exactly
  > `dsh-prompt-setting-<version>.tgz`, and this package must **not** add `postinstall`/`install`
  > scripts (a tarball carrying one is stopped by pnpm's build gate). See `NOTES.md` §107.

## 「我的 Prompt」的生效范围与边界 / What "My Prompt" does — and does not do

**它做的是「注入文本」，不是「切换行为」。** 你写的文字会被放进最终 system prompt 的**末尾**，
排在所有内置段之后（2026-09-30 21:32 之后的本机 `standard` 会话实测：注入命中率与末位率都是 100%）；
它**不会**强制模型改变行为方式，也**不是**一个能保证结果的开关。

> It **injects text**; it does not **switch behaviour**. Your text goes to the **end** of the final system
> prompt, after every built-in section (measured on this machine: 100% present and 100% last across
> `standard` sessions since 2026-09-30 21:32). It does not force a behaviour change, and it is not a
> switch that guarantees an outcome.

- **表层风格（输出语言这类）通常有效。** 比如让回答说中文，一般看得到效果。
  > **Surface style (output language and the like) usually works.** Asking for Chinese answers is
  > normally visible.
- **深层行为（reasoning / 内部思考语言）不稳定，由模型与平台决定。** 实测里出现过可见输出为中文、
  同一会话 reasoning 却全英文，也会随会话与模型变化。写的是中文指令，不代表模型**必然**用中文思考。
  > **Deep behaviour (reasoning / internal-thinking language) is not reliable — the model and the
  > platform decide.** We measured visible Chinese output next to fully-English reasoning in the same
  > session, and it varies by session and model. A Chinese instruction does not mean the model
  > **must** think in Chinese.

### 本会话自证 / Prove it for this session

**路径一（最硬）：直接读该会话落盘的最终 prompt。**

```bash
ls ~/.dsh/sessions                              # 先找到你的工作区目录（转义形式，非 ASCII 变成 ~XXXX~）
F=~/.dsh/sessions/<工作区目录>/<会话id>/session.v4.jsonl.zstd   # 例：--Users-me-Documents-proj--
zstd -dc "$F" | jq -r 'select(.type=="system/message") | .data.message.content[0].text[-200:]'
```

末位能看到你写的那几句 ⇒ **注入正常**（此时模型若不照做，原因在模型遵从或 agent preset 冻结，不在注入）；
末尾找不到、或整条为空 ⇒ 先查该会话的 `agentPreset` 与「冻结状态」，见下一节。

> **Path 1 (hardest evidence): read the session's persisted prompt.** If your lines appear at the end,
> injection is fine — if the model still ignores them, the cause is model compliance or a frozen preset,
> not the injection. If the tail does not contain them (or the text is empty), check that session's
> `agentPreset` and freeze state first.

**路径二（GUI）：** 设置 → **Prompt settings** →「我的 Prompt」面板看**冻结提示**；「高级」页的
状态卡看**冻结状态**与**构建戳**（`与宿主一致` / `页面版本已过期` / `构建戳未知`；显示过期说明页面是旧的，刷新即可）。

> **Path 2 (GUI):** Settings → **Prompt settings** → the "My Prompt" panel for the freeze warning, and the
> Advanced tab's status card for the freeze state and the build fingerprint (`matches host` / `page is
> stale` / `unknown`; "stale" only means the page is old — refresh).

### 两种「必然不生效」，别和「模型不遵从」混为一谈 / Two cases where it provably cannot take effect

1. **该会话的 agent preset 声明了 `complete: true`**（DSH 内置 `minimal`，本机的「梁神模式」也如此）：
   平台会在 waterfall 之后把装配强制压成单段，本插件的段**必然进不了**最终 prompt —— 这是平台语义，
   不是注入 bug。设置页遇到这种情况会给**阻断级提示**（写着「不会生效」时就是这一类）。
   > The session's agent preset declares `complete: true` (DSH's built-in `minimal`, and this machine's
   > "梁神模式"): after the waterfall the platform collapses the assembly into a single section, so this
   > plugin's section **cannot** enter the final prompt. That is platform semantics, not an injection bug;
   > the Settings page shows a blocking notice in that case.
2. **插件整体没加载**：插件挂掉不影响 DSH 启动，**终端是唯一的信号渠道** —— 先跑
   `node scripts/check-compat.mjs`，看它打印的 boot 失败形态与 peer 范围结论。
   > **The plugin is not loaded at all**: a broken plugin never affects DSH startup, which makes **the
   > terminal the only signal** — run `node scripts/check-compat.mjs` first for the boot-failure
   > signatures and the peer-range verdict.

## 安装 / Install

**首选从 npm 装**（本包已发布，npm 上的当前版本是 `0.1.5`，`latest`）。需要 DSH
`>= 0.1.7-rc.2 < 0.2.0 || >= 0.2.0-0 < 0.2.1-0`：`0.1.7-rc.2` 起的 0.1.x、`0.2.0` 的全部预发布
（`0.2.0-0` / `alpha` / `beta` / `rc.N`）与 **`0.2.0` 正式版**都在范围内；`0.2.1-0` 及以后出界。

> **Install from npm** — the primary route (this package is published; npm `latest` is `0.1.5`). Requires
> DSH `>= 0.1.7-rc.2 < 0.2.0 || >= 0.2.0-0 < 0.2.1-0`: every 0.1.x from `0.1.7-rc.2` on, every `0.2.0`
> prerelease (`0.2.0-0`, `alpha`, `beta`, `rc.N`) and the **`0.2.0` release itself** are in range;
> `0.2.1-0` and later are out.

```sh
dsh plugin --profile <profile> add dsh-prompt-setting
```

Web GUI 的 profile 名是 `web`；也可以走 GUI 的 Plugins 页（侧边栏 → Plugins → Add plugin），spec 直接填
包名 `dsh-prompt-setting`，或在会话里让 Creator 模式的 AI 调用：

> The Web GUI's profile is `web`; or use the GUI's Plugins page (sidebar → Plugins → Add plugin) and type the
> package name `dsh-prompt-setting`, or have the agent call this in Creator mode:

```
plugin_manager(action: "install_bundle", target: "dsh-prompt-setting")
```

**不要**手工编辑 profile 配置文件。

> **Do not** hand-edit profile config files.

### 开发与离线安装 / Development and offline installs

以下三条供**开发 / 离线 / 备用**使用：本地目录（绝对路径；装成 `link:`——插件的「立即更新」会刻意拒绝把它
覆盖成发布版本，这种安装请用 `git pull` 更新）、GitHub（本仓库是 monorepo，**必须带 `#path:`**）、以及 tarball：

> The three routes below are for **development / offline / fallback** use: a local directory (absolute path;
> installed as `link:` — the plugin's "Update now" deliberately refuses to overwrite it with a published
> version, so update such an install with `git pull`), GitHub (this repository is a monorepo, so the
> **`#path:` part is required**), and a tarball:

```
plugin_manager(action: "install_bundle", target: "<绝对路径 absolute path>/packages/dsh-prompt-setting")
```

```sh
dsh plugin --profile <profile> add 'github:zangxx66/dsh-prompt-setting#path:/packages/dsh-prompt-setting'

# 离线：先在包目录里打包，再装 tarball / offline: pack first, then add the tarball
cd packages/dsh-prompt-setting && pnpm pack
dsh plugin --profile <profile> add '<absolute path to the .tgz>'
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
node --test                    # 十八个套件（含真实 DSH 包的对照实验，须为 pass 而非 skip）
node scripts/check-compat.mjs  # 只读兼容性自检：不联网、永不抛、退出码恒 0
node scripts/prepare.mjs       # prepare 门禁：pnpm 从 git 安装时会自动跑它
npm pack --dry-run             # 确认发布产物干净（24 个文件、无 test/）
```

- **改动怎么生效 / How a change takes effect**：改 `client.js` 什么都不用做（DSH 自带客户端 HMR，
  已打开的标签页会被热替换）；改 `index.js` / `core/**` **必须重启宿主**（命令行启动的宿主就重新
  运行 `dsh web`，官方桌面端就退出并重新打开 DeepSeek Harness）；换包（改名、换 spec、换安装目标）
  同样必须重启。
  > `client.js` changes need nothing (DSH ships client HMR, open tabs are hot-swapped); `index.js` /
  > `core/**` changes **require restarting the host** (re-run `dsh web` after a command-line start, or
  > quit and reopen DeepSeek Harness in the desktop app); swapping the package itself does too.
- **重启的代价 / The cost of a restart**：重启会**终止所有等待确认的会话**，重开标签页找不回来 ——
  宿主半改动请攒批，能在 `client.js` 一侧解决的就别动宿主半。
  > A restart **kills every session waiting for confirmation**, and reopening the tab will not bring it
  > back — batch host-side changes, and prefer solving things on the `client.js` side.
- **构建戳 / Build fingerprint**：页面「状态」卡的构建戳有三态 —— `与宿主一致` / `页面版本已过期` /
  `构建戳未知`；`data-build-match` 就是它（`unknown` 永远不会被当成过期）。一条命令即可核对：
  > The status card's build fingerprint has three states, and `unknown` is never treated as stale. Check it with:
  ```js
  await (await fetch('/prompt-setting/ping')).json()   // → clientBuild: {hash, size, mtime}, launchKind: "cli" | "desktop" | "unknown"
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

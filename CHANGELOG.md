# Changelog 变更日志

本文件记录本项目的所有重要变更，按版本倒序。
All notable changes to this project are documented in this file, newest first.

格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)。
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added 新增

- **上游更新检查（g-030）**：打开设置页时由**宿主**向 GitHub Releases API 发一个 `GET`（地址从本包
  `package.json` 的 `repository.url` 解析，不硬编码第二份）；最新版本高于当前版本时，页面顶部出现
  **可关闭**的提示条（新版本号 + 发布页链接）。**默认开启、可关闭**：设置 →「Prompt 管理」→「高级」→
  「检查更新」；关闭后**零对外请求**（含打开设置页时），偏好写入
  `<DSH_HOME>/prompt-setting/preferences.json`（`{"updateCheck": false}`）。判定**绝不误报**：相等或更旧
  ⇒ 无提示；tag 解析失败或无 release（404）⇒「无可用信息」，同样静默；网络错误 / 超时 / HTTP 错误一律
  静默且**绝不 5xx**（路由恒答 200 + 结构化 `error`）。请求只有这一个 `GET`、不带任何本机 / 会话数据
  （`User-Agent: dsh-prompt-setting/<版本>`），5 秒超时，同一进程缓存 6 小时（`?force=1` 可绕过）。
  新路由 `GET|PUT /prompt-setting/update-check`（沿用既有前缀路由与信任栅栏）；不自动下载、不自动安装、
  不做自更新、不检查 DSH 平台版本，零新依赖（Node 内置 `fetch`）。契约见 `CONTRACT.md` §17 / §13.9。
  **Upstream update check (g-030)**: when the settings page opens, the **host** sends one `GET` to the GitHub
  Releases API (URL derived from this package's `package.json`, never hardcoded twice), and a **dismissible**
  banner appears at the top of the page (new version + release-page link) only when a newer release is confirmed.
  It is **on by default and switchable** (Settings → Prompt settings → Advanced → "Check for updates"); with it
  off there are **zero outbound requests**, including on page load, and the preference lives in
  `<DSH_HOME>/prompt-setting/preferences.json` (`{"updateCheck": false}`). The verdict can never be a false
  positive: equal or older ⇒ no banner, an unparsable tag or no release (404) ⇒ "no usable information" and still
  silent, and a network error / timeout / HTTP error is silent too — never a `5xx` (the route always answers 200
  with a structured `error`). The request is a single `GET` carrying no local or session data
  (`User-Agent: dsh-prompt-setting/<version>`), with a 5-second timeout and a six-hour cache (`?force=1` bypasses
  it). New route `GET|PUT /prompt-setting/update-check` on the existing prefix route and trust fence; no automatic
  download, install or self-update, no DSH platform check, and no new dependency (Node's built-in `fetch`).
  Contract: `CONTRACT.md` §17 / §13.9.

- **设置页显示插件版本号，并可点击跳转仓库**：版本号取自宿主 `GET /prompt-setting/ping` 的 `version`
  （= `index.js` 的 `PLUGIN_VERSION`，**单一来源**——客户端不携带任何版本字面量），渲染在**设置页标题旁**；
  点击在新标签打开本插件仓库（`repositoryUrl` 同样由宿主从自身 `package.json` 派生：`repository.url` /
  裸 `repository` 字符串清洗后必须是 http(s)，否则回落 `homepage`，都不行则 `null`；客户端**不硬编码 URL**，
  无 URL 时退化为**不可点的纯文本**）。ping 失败 / 无字段 / 非字符串 / 空串 / 纯空白一律显示
  「版本未知」，**绝不伪造版本号**；机器可读标记 `data-plugin-version` 仍留在根容器（两张失败卡为 `unknown`）。
  **The settings page shows the plugin version and links it to the repository**: the version comes from the host's
  `GET /prompt-setting/ping` `version` (single source — the client carries no version literal) and renders beside
  the page title, linking to this plugin's repository in a new tab. `repositoryUrl` is likewise derived by the host
  from its own `package.json` (cleaned `repository.url` / bare `repository`, must be http(s), else `homepage`, else
  `null`) and is never hardcoded in the client; without a URL the version degrades to plain, unclickable text. A
  missing or unusable answer renders 「版本未知」/`Version unknown` rather than an invented version, and the
  machine-readable `data-plugin-version` stays on the root container (`unknown` on both failure cards).

### Fixed 修复

- **未配置状态误报「该作用域已被冻结」**（[issue #1](https://github.com/zangxx66/dsh-prompt-setting/issues/1)）：
  「我的 Prompt」把保留段的 `applied: false` 直接当作冻结证据，而宿主对「这一段没有任何配置覆盖」正是报
  `applied: false` + `reason: null`（正常态），于是刚装好、什么都还没写时就出现红色阻断块，与同页状态卡
  「本会话未冻结」自相矛盾。冻结判定现在只认快照的 `frozen` / `frozenScope`。连带修掉两处同源误述：
  非冻结的应用失败（`replace` / `hide` 未命中、段被流水线丢弃）不再被说成「被 complete 段冻结」，
  `frozenScope: "global"` + 选中会话的「未知」态也不会被保留段升格为「确定冻结」。契约 §2.4 / §13.1 同步收紧。
  **An unconfigured install no longer claims "this scope is frozen"**
  ([issue #1](https://github.com/zangxx66/dsh-prompt-setting/issues/1)): the panel read the reserved section's
  `applied: false` as proof of a freeze, while the host reports exactly that — with `reason: null` — for
  "this section has no override at all". The freeze verdict now comes from the snapshot's `frozen` /
  `frozenScope` alone; a non-frozen override failure is no longer called "frozen by a complete section", and the
  `frozenScope: "global"` + selected-session "unknown" case can no longer be upgraded to a certain freeze by the
  reserved entry. Contract §2.4 / §13.1 tightened to match.

### Changed 变更

- **确认弹窗改为视口居中模态**：破坏性操作的确认卡原先渲染在整页 `children` 里（tabs 之下、面板之上）、
  没有定位，于是「恢复默认」的确认卡出现在触发按钮**上方**——页面滚动后落在视口之外，看起来像「点了没反应」，
  出现时还把面板整体下推。现在确认卡渲染在 `data-region="confirm-overlay"`（`position: fixed`、四边 `0`、
  双向居中、`z-index: 1000`）内，并带 `role="dialog"` / `aria-modal="true"`；遮罩只是背景，点它不关闭任何东西，
  出口仍是「确认 / 取消」。契约 §13.5 同步写明。
  **The confirmation is a viewport-anchored modal**: the destructive-action card used to sit in the page flow
  (below the tabs, above the panel) with no positioning, so the 「恢复默认」 confirmation appeared *above* the
  button that opened it — off-screen on a scrolled page, which reads as "nothing happened" — and pushed the panel
  down as it appeared. It now renders inside `data-region="confirm-overlay"` (`position: fixed`, all insets `0`,
  centred both ways, `z-index: 1000`) with `role="dialog"` / `aria-modal="true"`; the backdrop closes nothing by
  itself, so the exits are still 确认 / 取消. Contract §13.5 updated to match.

- **确认弹窗的文字排版重做，并去掉重复的「不可撤销」**：原本标题与正文同为 13px、正文没有行高，卡片里
  标题 / 正文两行 / 警示句 / 按钮行全部只靠一个 `gap: 6` 分隔，正文里还已经写过一遍「删除不可撤销」
  而底下又单独重复一行红字。现在分三层并结构化分组：标题 `14px/600/1.4`；`data-role="confirm-body"`
  里首句 `13px/500/labelPrimary` 与说明句 `13px/labelSecondary` 均为 `lineHeight 1.6`（组内 `gap: 4`）；
  `data-role="confirm-irreversible"` 是 `12px/1.5` 的左侧红色色条警示块，**唯一**声明不可撤销；
  `data-role="confirm-actions"` 与文案之间加顶部分隔线。卡片内边距改为 `16px 18px`。
  **Confirmation dialog typography reworked, and the repeated "cannot be undone" copy removed**: the title and
  the body were both 13px with no stated line height, one uniform `gap: 6` separated title / two body sentences /
  warning / buttons, and the irreversibility was stated twice. Three levels now group structurally — title
  `14px/600/1.4`; `data-role="confirm-body"` with a 13px/500 lead and a 13px secondary explanation, both at
  `lineHeight 1.6` (`gap: 4` inside the group); `data-role="confirm-irreversible"` as a 12px red-bordered strip
  that states it **once**; `data-role="confirm-actions"` behind a top divider. Card padding is now `16px 18px`.

---

## [0.1.1] - 2026-10-02

**维护版本：让「我的 Prompt」里的变量真正可用 / Maintenance release: make variables in My Prompt actually work.**

### Added 新增

- **变量替换开关（默认关闭）**：「我的 Prompt」可按层显式开启；开启后 `{{model}}` / `{{cwd}}` / `{{provider}}`
  被替换为该轮会话的真实值。替换由插件自己在装配阶段完成（DSH 的严格插值器不参与），**取不到值的引用保留字面量**，
  因此写进「我的 Prompt」的任何内容都不会让会话的 prompt 组装失败。
  **Variable substitution switch (off by default)**, opt-in per layer: `{{model}}` / `{{cwd}}` / `{{provider}}`
  are replaced with that turn's real values. The plugin expands the text itself during assembly — the shipped
  interpolator is never involved — and a reference without a value stays literal, so nothing written here can
  break a session's prompt assembly.
- **「取消」按钮**：丢弃「我的 Prompt」里未保存的草稿、回到该层已保存的文本（不写盘、无二次确认）。
  **Cancel button**: discards the unsaved draft and restores the layer's saved text (no write, no confirmation).
- **未解析引用分级**：快照新增 `unresolvedThrowing` / `unresolvedLiteral`，「提示词总览 → 完整渲染」据此区分
  「真实装配会失败」与「真实 prompt 就是这串字面量」。
  **Graded unresolved references** (`unresolvedThrowing` / `unresolvedLiteral`) in the snapshot, surfaced by the
  overview tab.
- **变量台账文档** `docs/prompt-variables.md`：DSH 提示词变量清单、引用与注册的双向差集、插值语义与复现命令。
  **Variable ledger** `docs/prompt-variables.md`.

### Changed 变更

- 冻结态提示升级：「完整装配已冻结」时「我的 Prompt」给出阻断级说明，避免被误读为「没保存成功」。
  The frozen-scope notice on the My Prompt panel is now blocking-level.
- 文档补充：自定义指令能约束**输出语言**，而 reasoning 语言由模型决定。
  Docs: custom instructions constrain the output language; the reasoning language is the model's own.
- 「提示词总览 → 完整渲染」的未解析提示改为分级措辞（旧文案一律「请勿据此判断真实 prompt」）。
  The unresolved notice in the overview tab is now graded instead of uniformly cautious.

### Fixed 修复

- `peerDependencies` 上界收紧为 `<0.2.1-0`，把 DSH 0.2.0 正式版纳入支持范围（避免 GA 当天插件被平台跳过加载）。
  Peer upper bound tightened to include DSH 0.2.0 GA, so the bundle is not skipped on GA day.

### Notes 说明

- 版本号 `0.1.1` 已在 `packages/dsh-prompt-setting/package.json` 中声明；发布到 npm 与打 tag 后，本节日期即为发布日。
  The version `0.1.1` is declared in the package manifest; once it is published and tagged, this entry's date
  becomes the release date.
- **默认行为与 0.1.0 一致**：开关不开启时，「我的 Prompt」的文本仍按字面量注入（`{{...}}` 原样交给模型）。
  **Default behaviour is unchanged from 0.1.0**: with the switch closed, the text is injected literally.

---

## [0.1.0] - 2026-09-30

**首个版本，尚未发布到 npm / First release, not yet published to npm.**
下面的内容就是首次发布所包含的全部能力。

### Added 新增

**设置页 Prompt 管理器：四个一级 tab / Settings Prompt manager: four top-level tabs**

- **我的 Prompt**：唯一写入口，写下你自己的系统级指令（选层 → 编辑 → 保存），一键恢复默认；
  这段文本排在所有内置段之后。
  **My Prompt**: the only write surface — your own system-level instructions (pick a layer → edit → save)
  with a one-click restore; the text is placed after every built-in section.
- **提示词总览**：只读的分段列表（状态标记 / 搜索 / 筛选 / 复制）、完整全文、`base ↔ effective` 对比。
  **Prompt overview**: a read-only section list (status marks / search / filters / copy), the full text,
  and a `base ↔ effective` diff.
- **历史与备份**：历史列表 + 行级版本对比；配置导出下载、导入预览（先看变更计划，确认后才写盘）。
  **History & backup**: history list + line-level diffs; export the configuration, and preview an import
  before anything is written.
- **高级**：旧版覆盖的只读列表、「清除全部覆盖」与「整层恢复默认」两个二次确认按钮、完整状态区。
  **Advanced**: a read-only list of legacy overrides, two double-confirm buttons, and a full status area.

**看得见最终 prompt / See the final prompt**

- 宿主侧按段快照最终装配结果（`sections[{name,text}]` + 全文），并给出 `base ↔ effective` 差异。
  A host-side per-section snapshot of the final assembly, plus the `base ↔ effective` diff.

**写得动，但不碰安装包 / Writable, without touching the install**

- 插件自注册保留段 `prompt-setting:custom-prompt`，用户文本通过既有覆盖引擎落到这一段；
  一个最外层监听器把它搬到最终装配的**最后**。
  The plugin registers its own reserved section; user text lands on it through the existing override
  engine, and an outermost listener moves it to the **end** of the final assembly.
- 两层作用域：用户级默认 + 工作区级覆盖，工作区级优先。
  Two layers: a user-level default plus a workspace-level override; the workspace wins.
- 该段 `interpolate: false`：用户文本是任意文本，一旦参与插值，写一个不存在的变量就会让之后每一轮装配抛错。
  The section uses `interpolate: false`: user text is arbitrary, and one unknown variable reference would
  otherwise make every later assembly throw.
- 未配置时对最终 prompt **零贡献**，渲染结果与未安装时逐字节相同。
  Unconfigured, it contributes **nothing** to the final prompt — byte-for-byte identical to not installing.

**健壮性 / Robustness**

- boot 韧性：导入期做 DSH 版本自检（范围内静默 / 超范围一条 / 探测失败一条，均不抛）；`apply` 失败
  会回滚已注册的 effect，不留半挂载；客户端 factory 抛错不会抛回 loader。
  Boot resilience: an import-time DSH version self-check; a failed `apply` rolls back the effects it
  registered; a throwing client factory is not propagated back to the loader.
- 客户端构建戳：宿主在 ping 里报告现场指纹，页面自证并三态呈现（与宿主一致 / 页面版本已过期 / 构建戳未知）。
  Client build fingerprint: the host reports a live fingerprint in `ping`, and the page self-verifies with
  three states (matches host / stale page / unknown).
- 用户层每请求重读：外部直接改写层文件后，下一次请求即可见。
  The user layer is re-read on every request, so an out-of-band edit shows up on the next request.

**工具 / Tooling**

- `scripts/check-compat.mjs`：只读兼容性自检 —— 本插件版本 / 已装 DSH 版本 / peer 范围结论 /
  四种 boot 失败形态的终端签名 / 救援步骤。零依赖、不联网、永不抛、退出码恒 0。
  A read-only compatibility self-check: versions, peer-range verdict, the terminal signature of the four
  boot failure modes, and rescue steps. No network, never throws, always exits 0.
- `scripts/prepare.mjs`：从 git 安装时的发布就绪门禁 —— 声明入口是否齐全、是否都在 `files` 白名单里、
  bundle patch 每一行能否解析、构建戳区间是否可用；不通过则 `exit 1`。
  A release-readiness gate for git installs: every declared entry point present and inside the `files`
  allowlist, every patch row resolvable, a usable fingerprint region — non-zero exit when it fails.

**可访问性与国际化 / Accessibility and i18n**

- 「查看范围」是一棵标准 ARIA 树（`tree > treeitem`、`group > treeitem`），支持键盘操作。
  The scope view is a standard ARIA tree (`tree > treeitem`, `group > treeitem`) with keyboard support.
- 界面文案全量 zh/en 两套内联，跟随 DSH 语言切换，无需刷新或重启；英文渲染横扫保证零 CJK、无裸 key 回落。
  All UI copy ships inline in zh/en, following DSH's language with no refresh or restart; an English render
  sweep enforces zero CJK and no raw-key fallback.

**文档 / Documentation**

- `CONTRACT.md`：冻结的 REST 契约（当前 Revision 8）。
  The frozen REST contract (currently Revision 8).
- `NOTES.md`：设计取舍、真机实测记录、未验证项与已推翻的旧结论。
  Design trade-offs, on-machine measurements, untested items and retracted conclusions.
- `README.md`（English）/ `README_zh.md`（中文）：仓库总体说明。
  The repository-level overview, in English and Chinese.
- 插件包 `README.md`：中英对照的简介、功能、安装与维护者要点。
  The package README: a bilingual summary, features, install and maintainer notes.
- MIT `LICENSE`（仓库根 + 包内各一份，内容相同）。
  The MIT license (repository root and inside the package, identical).

### Changed 变更

- 设置页由「编辑 / 新建覆盖」UI 重排为四个一级 tab；行内「编辑」改为就地展开，
  「查看范围」默认收成一行摘要。
  Settings was rearranged from the old edit/create-override UI into four top-level tabs; row-level editing
  became in-place expansion, and the scope view collapsed to a one-line summary by default.
- 写入面收窄到保留段「我的 Prompt」，其余段只读。
  The write surface was narrowed to the reserved "My Prompt" section; every other section is read-only.
- DSH peer 范围放宽：上界从 `0.1.8-0` 改为 `< 0.2.0`（即 `>=0.1.7-rc.2 <0.2.0`）。更晚的 0.1.x 版本
  （含 prerelease）不再触发「超出已测试范围」提示。**这是宽松预期，不是已验证兼容** ——
  唯一在真机上验证过的版本仍然是 `0.1.7-rc.2`。
  The DSH peer range was widened to `>=0.1.7-rc.2 <0.2.0`: later 0.1.x versions (prereleases included) no
  longer trigger the out-of-range notice. **This is a permissive bound, not verified compatibility** — the
  only version verified on a real machine is still `0.1.7-rc.2`.
- DSH peer 范围再修订为 `>=0.1.7-rc.2 <0.2.0 || >=0.2.0-rc.2 <0.2.0`，**显式纳入 `0.2.0-rc.2`**。
  平台的兼容闸门用的是 `includePrerelease: true`，前半段本来就已经放行它；补第二个 `||` 分支是为了
  **严格** `node-semver`（npm / pnpm 安装期 peer 解析，会拒绝「范围里没有同号 prerelease 比较器」的预发布版）。
  本机实测：插件正运行在 DSH `0.2.0-rc.2` 上（`/prompt-setting/` 前缀路由已注册、存储持续写入）。
  The DSH peer range is now `>=0.1.7-rc.2 <0.2.0 || >=0.2.0-rc.2 <0.2.0`, naming `0.2.0-rc.2` explicitly.
  The platform's gate passes `includePrerelease: true` and already admitted it; the extra `||` branch is for
  **strict** `node-semver` (npm / pnpm peer resolution). Measured on this machine: the plugin is running on
  DSH `0.2.0-rc.2`.
- DSH peer 范围再修订：第二个 `||` 分支的下界从 `0.2.0-rc.2` 降到 **`0.2.0-0`**，即
  `>=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.0`。严格 `node-semver` 的白名单规则只看 `[0,2,0]` 元组
  **有没有**同号 prerelease 比较器、**不看它排第几**；旧写法把下界钉在 `rc.2`，于是 `0.2.0-0`、`alpha`、
  `beta`、`rc.1` 在安装期 peer 检查里全部落空（`0.2.0-alpha` 实测 false）。取 `0.2.0-0`（0.2.0 的最小
  预发布）即覆盖整条 0.2.0 预发布线，`0.2.0` 正式版依旧出界。**运行期无变化**：平台闸门
  （`includePrerelease: true`）与本插件自检本来就对它们全部放行，本轮改的是声明口径的自洽性。
  The second `||` branch now starts at `0.2.0-0` instead of `0.2.0-rc.2`:
  `>=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.0`. Strict `node-semver` whitelists the `[0,2,0]` tuple without
  ranking it, so pinning the bound at `rc.2` silently excluded `0.2.0-0`, `alpha`, `beta` and `rc.1` from the
  install-time peer check (`0.2.0-alpha` measured false). `0.2.0` itself stays out. **Nothing changes at
  runtime**: the platform gate (`includePrerelease: true`) and the plugin's own check admitted them all along.
- DSH peer 范围上界从严修订：`<0.2.0` → **`<0.2.1-0`**，即
  `>=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.1-0`。原因是 P0 级 GA 阻塞：平台在 profile boot 期逐条跑兼容性
  闸门（`dsh-app-boot` 判定后**跳过整个 bundle** 并写 stderr，运行期另一路径把该条置为 `disabled`），
  不满足即**根本不会 import 本包**，插件自检救不了 —— 而旧范围的两个分支都不含 `0.2.0` 正式版，
  于是 `0.2.0` 发布当天本插件会直接消失。现在 **`0.2.0` 正式版与其全部预发布都在范围内**，
  `0.2.1-0` 及以后一律拒绝（新的 minor 重新评估，上界写法对齐本机 `dsh-graph@0.17.0` 的既有实践）。
  双解析器（自带 `satisfiesRange` 与 `semver@7.8.5` 的 `includePrerelease: true` 平台口径）逐版本实测一致。
  The DSH peer range's upper bound moved from `<0.2.0` to **`<0.2.1-0`**:
  `>=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.1-0`. This was a P0 GA blocker: the platform runs a compatibility
  gate per profile bundle at boot and **skips the whole bundle** (stderr line; another runtime path marks the
  row `disabled`), so an out-of-range plugin is never imported and cannot self-check — while the old range
  admitted no `0.2.0` release at all. **The `0.2.0` release and its whole prerelease line are now in range**;
  `0.2.1-0` and later are refused (a new minor is re-evaluated, matching this machine's `dsh-graph@0.17.0`).
  Both parsers (our `satisfiesRange` and `semver@7.8.5` with `includePrerelease: true`) agree version by version.

### Fixed 修复

- `frozen` 误报：判定改为「探针段是否幸存」。
  False `frozen` reports: the verdict now depends on whether the probe section survived.
- 缺值变量不再被渲染成裸 `undefined`。
  Missing variables are no longer rendered as a bare `undefined`.
- 保存前校验覆盖是否可能生效，杜绝静默无效写入。
  Saves now check whether an override can take effect at all, ruling out silently ineffective writes.
- 英文界面残留中文的 i18n 泄漏。
  i18n leaks where the English UI still showed Chinese.
- 运行时文案里的失效文档指向：终端与控制台消息原让用户去看 README「兼容性与救援」，而包内 README 已把
  该内容并成「出问题时 / When something goes wrong」一节 —— 五处文案与测试常量同步更新。
  Stale doc pointers in runtime copy: the terminal and console messages pointed at a README section that no
  longer exists; five messages and the test constant now name the current section.
- 冻结态的「我的 Prompt」把「已保存」误读成「已生效」：`complete: true` 的作用域里写入必然不进 prompt，
  面板原来只有一行红字、保存按钮照旧、成功文案照旧。现在冻结块（`data-mine-frozen="true"` + 保留的
  `data-warning="mine-frozen"`）写明「文本存进了配置 / 该作用域被冻结，不会生效 / 换用未声明 `complete`
  的 preset 或去掉该声明」，状态行新增 `data-mine-effect`（确定冻结 `none`、未知 `unknown`、否则
  `next-turn`），容器新增 `data-mine-frozen-certainty`；冻结态的成功文案一律带条件前缀
  （`mineSavedFrozen`/`mineSavedUnknown`、`savedNoticeFrozen`/`savedNoticeUnknown`）。「全局冻结 + 选中会话」
  这一**未知**态另有独立文案，不被写成「本会话已冻结」。写入能力保留（方案 A）：冻结挡的是生效，不是配置。
  A frozen "My Prompt" no longer lets "saved" read as "effective": in a `complete: true` scope the write can
  never reach the prompt, yet the panel showed one red line while the save button and the success copy were
  unchanged. The frozen block (`data-mine-frozen="true"`, keeping `data-warning="mine-frozen"`) now states
  where the text went, that it does not take effect in this scope, and how to fix it; the state line adds
  `data-mine-effect` (`none` when certainly frozen, `unknown` for the unknown case, `next-turn` otherwise) and
  the block adds `data-mine-frozen-certainty`; and every frozen success wording is the conditional form. The
  global-freeze-with-a-session case is *unknown*, and is never worded as a frozen session. The write itself
  stays enabled: a freeze blocks the effect, not the configuration.

### Security 安全

- 写入面收窄到保留名：`PUT`、单名 `DELETE`、`import` 对其他名字一律拒绝（`403 write-locked`），
  拒绝时不碰文件一个字节。
  The write surface is limited to the reserved name: `PUT`, single-name `DELETE` and `import` refuse any
  other name (`403 write-locked`) without touching a single byte of the files.
- 导入原子性：解析 → 校验 → 冲突策略 → 临时写入 → 原子替换，任何一步失败都保证现有配置逐字节不变。
  Import atomicity: parse → validate → conflict policy → temp write → atomic replace, with existing
  configuration guaranteed byte-identical on any failure.
- 路由信任栅栏：要求浏览器 cookie 认证，裸 `curl` 一律 `401`。
  A route trust fence: browser cookie authentication is required, so a bare `curl` always gets `401`.

### Notes 说明

- `0.1.0` 是该条目首次声明的版本号（清单当前版本见上方的 `0.1.1` 条目）；发布到 npm 与打 tag 后，
  本节日期即为发布日。
  `0.1.0` was the version this entry first declared (the manifest now carries `0.1.1`, see the entry above);
  once it is published and tagged, this entry's date becomes the release date.
- 变更颗粒度较大：本项目按目标（看板 `g-0xx`）开发，一个目标一个提交，上面的条目对应一组这样的目标。
  Changes are coarse-grained: the project is developed goal by goal (board `g-0xx`), one commit per goal.

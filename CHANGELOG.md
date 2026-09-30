# Changelog 变更日志

本文件记录本项目的所有重要变更，按版本倒序。
All notable changes to this project are documented in this file, newest first.

格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)。
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Fixed 修复

- `frozen` 误报：判定改为「探针段是否幸存」。
  False `frozen` reports: the verdict now depends on whether the probe section survived.
- 缺值变量不再被渲染成裸 `undefined`。
  Missing variables are no longer rendered as a bare `undefined`.
- 保存前校验覆盖是否可能生效，杜绝静默无效写入。
  Saves now check whether an override can take effect at all, ruling out silently ineffective writes.
- 英文界面残留中文的 i18n 泄漏。
  i18n leaks where the English UI still showed Chinese.

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

- 版本号 `0.1.0` 已在 `packages/dsh-prompt-setting/package.json` 中声明；发布到 npm 与打 tag 后，
  本节日期即为发布日。
  The version `0.1.0` is already declared in the package manifest; once it is published and tagged, this
  entry's date becomes the release date.
- 变更颗粒度较大：本项目按目标（看板 `g-0xx`）开发，一个目标一个提交，上面的条目对应一组这样的目标。
  Changes are coarse-grained: the project is developed goal by goal (board `g-0xx`), one commit per goal.

# Changelog 变更日志

本文件记录本项目的所有重要变更，按版本倒序。
All notable changes to this project are documented in this file, newest first.

格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)。
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.4] - 2026-10-18

**功能版本：删除预设时一并还原它已应用的工作区，备份与恢复改为整机全量并解除导入写锁，全部用户文案迁出
bundle（`locale/*.json` 成为唯一真源），「查看范围」收归「我的 Prompt」专用、四个 tab 各自解耦，主 tab
换成纯文字 + 选中下划线样式，「高级」显示更新红点；此外按真实变量表探测 DSH 的 `cwd` 变量弃用。底层完成
客户端生成期分段重构（`src/` 17 段真源）并新增发布前 `verify` 聚合门禁。 / Feature release: deleting a
preset now also restores every workspace it was applied to, backup/restore became a whole-installation full
document with the import write lock removed, every user-visible string moved out of the bundle into
`locale/*.json` as the single source, the view scope now serves "My prompt" alone with the four other tabs
decoupled, the main tabs became plain text with an accent underline, "Advanced" carries an update dot, and the
host's `cwd` variable retirement is detected from the live variable table rather than a version guess.
Underneath, the client half was rebuilt as 17 generated segments and a pre-release `verify` gate was added.**

（本次发布覆盖 g-065…g-080。v0.2.3 **从未发布**，它的全部条目并入本版；范围经 `git merge-base
--is-ancestor` 逐项核实——每个目标的代表提交都是 `dev`（`d95e879`）的祖先、都不是 `main`（`1d2543a`）
的祖先，`merge-base(main,dev) = 445ad6d`。 / This release covers g-065…g-080. v0.2.3 was **never
released**, so all of its entries ship here; the range was verified with `git merge-base --is-ancestor` —
every target's representative commit is an ancestor of `dev` (`d95e879`) and none is an ancestor of `main`
(`1d2543a`), with `merge-base(main,dev) = 445ad6d`.）

### Added 新增

- **文案真源迁出 bundle：`locale/*.json` + `scripts/locale-pack.mjs`（g-066）**：插件全部用户可见文案
  （564 键/语言 = 513 主词典 + 51 个 `error.<code>`）从 `client.js` 搬到 `locale/zh.json` 与
  `locale/en.json`，成为**唯一人工真源**；`client.js` 里的 `zh`/`en` 两段改为**生成物**，由
  `node scripts/locale-pack.mjs --write` 渲染、`--check` 校验（`prepare` 门禁也跑同一条检查）。浏览器
  运行时**不读**这两份 JSON（bundle 是 classic script、宿主零转译、插件路由不服务子目录），因此
  `ctx.locale.register(NS, {zh, en})` 仍是**同步**调用：首帧文案不变，也没有新增网络请求。`files` 纳入
  `locale`，`npm pack --dry-run` 实测 36 个文件（含两份 JSON 与生成脚本）。文案与键名一字未改。
  **Copy moved out of the bundle (g-066)**: every user-visible string (564 keys per language = 513 main
  + 51 `error.<code>`) now lives in `locale/zh.json` / `locale/en.json` as the single human source; the
  `zh`/`en` blocks inside `client.js` became a generated artifact produced and checked by
  `scripts/locale-pack.mjs` (the same check runs on the `prepare` gate). The JSON is **not** fetched at
  runtime — the bundle is a classic script, the Host does not transpile it, and the plugin route serves
  no subdirectories — so `ctx.locale.register(NS, {zh, en})` stays **synchronous**: the first frame is
  unchanged and no request was added. `files` now includes `locale`, and `npm pack --dry-run` measures
  36 files including both JSONs and the generator.

### Changed 变更

- **版本号 `0.2.2` → `0.2.4`（跳过从未发布的 `0.2.3`）**：同步表示「本包当前版本」的每一处——本包
  `package.json` 的 `version`、`index.js` 的 `PLUGIN_VERSION`、三份 README 的徽章与「本仓库为 X」
  （同时校正过时的 npm `latest` 事实：`0.1.5` → `0.2.2`，2026-10-18 实测）、`CONTRACT.md` 的 export /
  ping / 版本节点示例，以及测试中表示本包版本的硬字面量；配套的「更新
  目标」夹具按语义整体上移（`0.2.3` → `0.2.5`，必须高于本包版本，否则 `hasUpdate` 翻假）。v0.2.3
  从未发布，它的全部条目与 v0.2.4 一起记在本段（`0.2.3` 只是升版前的夹具值，不是发布过的版本）。
  版本号本身**不引入任何行为变更**：本版的行为变化全部是下面的条目，版本号不改变路由、落盘内容
  或既有响应字段。`npm publish` / `git tag` / `git push` / 合入 `main` 仍是人工 gate，不在本次变更内。
  **Version `0.2.2` → `0.2.4`, skipping the never-published `0.2.3`**: every place that states "the
  version this package currently is" was moved together — this package's `package.json`, the host's
  `PLUGIN_VERSION`, the badges and "this repository is" lines in all three READMEs (also correcting the
  stale npm `latest` fact, `0.1.5` → `0.2.2`, measured on 2026-10-18), the export / ping / version-node
  examples in `CONTRACT.md`, and the test literals that assert the package version. The
  "update target" fixtures moved by semantics (`0.2.3` → `0.2.5`, which must stay above the package's own
  version or `hasUpdate` flips false). `0.2.3` was never released, so its entries ship here together with
  v0.2.4's. The bump itself introduces **no behaviour change**: no route, no stored content and no
  existing response field moves with the version number; `npm publish`, `git tag`, `git push` and the
  merge into `main` remain manual gates.
- **内部工程：客户端生成期分段与发布前门禁（g-072、g-075–g-079）**：`client.js` 自本版起由 `src/`
  的 17 段真源经 `scripts/client-build.mjs` 生成（生成物与旧文件逐字节等价，头注标明「生成物，勿
  手改」）；`prepare` 增「段 ↔ 产物」字节一致与段集合门禁；新增 `scripts/verify.mjs` —— 一条命令
  跑全量测试 + 四道门禁 + 文档引用体检，`docs/check-refs.mjs` 对 `docs/refactor-plan.md` 的上百条
  `文件:行` 引用做 fail-closed 校验；`.gitattributes` 固定跨平台 LF。**用户可见行为零变化**：改动只在
  开发者工作流与发布前防线；g-072 是方案文档本身，g-068 是调查（结论落在 g-069 的条目里）。
  **Internal engineering: generated client segments and pre-release gates (g-072, g-075–g-079)**:
  `client.js` is now generated from the 17 `src/` segments by `scripts/client-build.mjs` (byte-identical
  to the previous file, with a "generated, do not edit" banner); `prepare` gains a segment ⇄ artifact
  byte-equality and segment-set gate; `scripts/verify.mjs` runs the full test suite plus the four gates
  plus the documentation reference check in one command, with `docs/check-refs.mjs` validating the
  hundreds of `file:line` references fail-closed; `.gitattributes` pins LF across platforms. **Nothing
  user-visible changes** — only the developer workflow and the pre-release line of defence; g-072 is the
  design document itself and g-068 is the investigation whose conclusions live in the g-069 entry.
- **`cwd` 变量弃用的探测：按真实变量表适配，不按版本号猜（g-080，DSH 0.2.1-rc.1 起）**：上游
  `dsh-agent-loop` 不再注册 `cwd`，shipped preset 也不再发 `Your working directory is {{cwd}}.`。插件把
  `GET /prompt-setting/interpolate` 早已返回的 `variables`（一次真实 `assemble()` 的键集，已按 mount
  缓存）接到「我的 Prompt」面板：注记里的变量列表**按当前实际注册名渲染**——旧版 DSH 仍列出
  `{{cwd}}`，0.2.1-rc.1 及以后不列并在同一段文案里点名其弃用与「保持字面量 / 保存被拒」两个后果；
  探测失败（`variables: null`）显示 `?`，不编造可用集合。写入/开启校验在拒绝**未注册**的 `{{cwd}}`
  时追加一句迁移提示（表里仍有 `cwd` 时一字不加），状态码、错误码与零字节保证均不变。旧版 DSH 的
  行为、文案与判定方向逐字不变；已有文本照常进入 prompt（保留段永不插值、插件展开宽松，绝不抛错）。
  零新增路由/字段；每页加载/重载多一次已缓存的 `GET /interpolate`（不触发新的 `assemble()`）。
  `client.js` 保持 **12382** 行（行数中性改写），`docs/refactor-plan.md` 的段表与引用行号零漂移。
  **The `cwd` retirement is detected from the live variable table, never from a version string (g-080,
  DSH 0.2.1-rc.1+)** — the panel's note renders the names this assembly really registers, so an older
  DSH still lists `{{cwd}}` while the 0.2.1 line omits it and names the retirement (literal stays
  literal, an armed save is refused); a failed probe prints `?`. The refusal gains one migration
  sentence only when the unknown name is `cwd` and the table lacks it. Same code, same status, same
  zero-byte guarantee; old hosts are byte-for-byte unchanged in behaviour and copy. No new route or
  field; one already-cached `GET /interpolate` per page load and `client.js` stays 12382 lines.
- **作用域模型收敛：页面「查看范围」只服务「我的 Prompt」（g-073，Revision 55）**：负责人 2026-10-16 目视后
  要求页面级作用域只管「我的 Prompt」，其余 tab 各自解耦——g-074 先交付全量备份，本次处理行为层。四个落点：
  ①「我的预设」的库读取不再携带 `?session=`（库是全局文件，与页面作用域无直接关联；apply / unapply 仍按对话框里
  选中的工作区生效，行为未变）；②「提示词总览」自带作用域切换组件——**按工作区分组、可选到具体会话**，切换后按
  该作用域重新读取快照，页面「查看范围」不再影响它。取值**不照抄**「版本历史」的「每个工作区取首个会话 id」：
  `/snapshot` 的 `session` 同时定位工作区层文件并在该会话自身作用域里探测装配，frozen 判定与变量解析是 per-scope
  事实，用替身会让页面显示用户没选的会话的结论；③「高级」自带**工作区**选择器（`?reset=true` / `?legacy=true`
  清的是整个工作区文件、该工作区所有会话共享，所以选择器的语义是"选工作区"而非"选会话"），旧版覆盖列表、层计数与
  装配状态都按它自己的作用域取数，用户层仍是全局；④页面作用域 `m.sessionArg` 的消费点收敛为只剩「我的 Prompt」
  （快照 + 覆盖读取 + 面板自己的写入目标展示），`/export`、`/import`、`/presets` 不再携带它（备份自 Revision 53
  起已是全量）。总览与高级的读都在**首次打开该 tab / 作用域变化 / reload** 时才发（每次 `/snapshot` 要跑两次
  `assemble()`），切走再切回**复用已有数据**——不发请求、也不再闪一下「加载中」；面板渲染门控按各 tab 自己的
  数据源，页面作用域的读失败不会再让别的 tab 空白。新增契约 §13.10「作用域模型」总表与 7 条不变式；
  §13.0 / §13.2 / §13.3a / §13.4 / §13.7 / §20.2 同步；词典新增 13 键（**586 键/语言** = 535 主 +
  51 `error.<code>`），并修正两条随之过时的文案。
  **The scope model converges: the page-level "View scope" serves「My Prompt」alone (g-073, Revision 55)**:
  the four decouplings are — the preset library is read without `?session=`; 「Prompt overview」gets its own
  switcher, **grouped by workspace and resolving down to a concrete session** (never the workspace's first
  session: `/snapshot`'s `session` locates the workspace layer *and* probes the assembly in that session's
  own scope, so the frozen verdict and the variable resolution are per-scope facts); 「Advanced」gets its own
  **workspace** selector (both layer-wide clears act on a whole workspace file shared by every session in
  it), with the legacy list, the layer counts and the assembly status all read in that scope and the user
  layer still global; and `m.sessionArg` is left scoping「My Prompt」alone, so `/export`, `/import` and
  `/presets` no longer carry it. Both tab-owned reads happen on their tab's first open, on a scope change and
  on a reload — coming back to a tab reuses what is on screen (no request, no loading frame) — because every `/snapshot`
  costs two `assemble()` runs) and each panel is gated on its own data source, so a failing page-scoped read
  can no longer blank another tab. Contract gains §13.10 (the model, with six invariants); §13.0 / §13.2 /
  §13.3a / §13.4 / §13.7 / §20.2 updated; the dictionaries grow to **586 keys per language** (535 main +
  51 `error.<code>`), with two now-stale strings corrected.

- **跨机备份恢复改为「跳过」语义 + 导入预览提示「整份替换」（g-074 att-002，Revision 54）**：负责人 2026-10-16
  追加指示「如果不是本机已注册的则跳过」。`POST /import` 过去对「路径形状合法但本机注册表未包含」的工作区
  root 整体 `400 unknown-workspace-root` 拒绝，现在改为**跳过并在响应 `skipped[]` 中如实声明**
  （`{layer, reason, entries}`，沿用 R6 已钉住的形状，不新增字段）：`workspaces[]` 里这类条目
  `layer` 为 `workspace:<root>`、`entries` 为该条目的覆盖数；`presets.applied[]` 里这类记录
  `layer` 为 `presets.applied:<root>`、`entries` 为 `1`，且该记录**被丢弃、绝不落库**（R1 关掉的那条
  任意路径写入原语保持关闭）。文档其余部分——两层视图、**已注册**的工作区层、预设库、偏好设置——
  照常导入，被跳过项的零写入不变式仍有 SHA-256 断言。**形状非法**（相对路径 / `..` / 控制字符 / 卷根）
  仍按畸形文档**整体拒绝**、零写入，两刀不混同。前端「备份与恢复」预览补齐三块：预设库与偏好设置将被
  **整份替换**（不是合并）的明确警示、本文档涉及的 `workspaces` 变更（含是否真有改动）、以及被跳过的
  条目列表（`layer`/`reason`/`entries` 计数）。契约 §11.1、§11.2（`skipped` 来源表 4 → 6 行）、§11.7、
  §15.7、§10、§4.4 错误码表与 §22 locale 计数同步为 Revision 54；新增 §11.8 记录预览契约。
  **Cross-machine restore now skips, and the preview says what is replaced (g-074 att-002, Revision 54)**:
  a workspace root that is a legal path but is not registered on this machine is no longer refused whole;
  the entry is skipped, declared in `skipped[]` (`{layer, reason, entries}`, the R6 shape, no new field) and
  never written, while the rest of the document — both layer views, the **registered** workspace layers,
  the library and the preferences — imports normally. A malformed root (relative, `..`, control character,
  volume root) is still refused whole with zero writes. The import preview now warns that the preset
  library and the preferences are replaced **as a whole** (not merged), lists the workspace layers the
  document touches, and lists every skipped entry with its count.

- **「查看范围」移入「我的 Prompt」（g-071，Revision 52）**：会话范围选择器
  （含树体/手动输入/展开收起与全部既有 marker）不再渲染在 tab bar 上方，而是作为「我的 Prompt」面板内、
  面板标题之下的第一块（`data-region="prompt-block"` 现在只存在于 `data-region="mine"` 内部）。据此，
  tab bar 上方的页面 chrome 只剩两样：标题行（含插件版本）与状态行；首屏预算由 g-055 的实测值（含该区块
  的 220px + 4px）重新推导为 **128px + 4px**（`chromeAboveTabsPx` 断言），硬上限 310px 不变。**其他 tab
  不再显示页面作用域**：g-071 初版曾在四个 tab（「我的预设」「提示词总览」「备份与恢复」「高级」）面板顶部
  各加一行只读范围提示，负责人真机目视后**否决**——每个 tab 有自己的作用域语义（总览将自带切换器、备份
  应为全量导出、高级不受作用域影响、预设与该范围无直接关联），保留该行等于交付一个已被否决的 UI 元素；
  四个 tab 与页面作用域的**解耦另立 g-073**，本次为纯撤回（该键在发布前撤回，词典回到 567 键 =
  516 主 + 51 `error.<code>`）。页面级 scope 语义一字未改：`m.sessionArg` 仍作用于快照、覆盖读取、导入
  导出、预设请求与 mine 写入层（过渡期四个 tab 仍按页面 scope 取数，与 g-071 之前的既有行为一致）。
  「版本历史」自 Revision 19（g-038）起有自己的 scope，由 `data-region="history-scope-summary"` 陈述。
  **The scope picker moved into「My Prompt」(g-071, Revision 52)**: the session-scope selector no longer
  renders above the tab bar — it is the first block inside the「My Prompt」panel, under that panel's own
  title (`data-region="prompt-block"` now exists only inside `data-region="mine"`). The chrome above the
  tabs is down to the title row and the status line, and the first-screen budget was re-derived from the
  smaller spend (128px + 4px slack, hard ceiling unchanged). **No other tab shows the page scope**: the
  first cut of g-071 added a read-only scope line to the top of the four other tabs, and the owner's
  real-machine review **rejected** it — each of those tabs has its own scope semantics (overview will
  carry its own switcher, backup should export everything, advanced is not scope-dependent, and presets
  are not tied to this scope), so keeping the line would have shipped a surface the owner refused;
  decoupling those tabs from the page-level value is **g-073**. The page-level scope value, every frozen
  marker and the write path are unchanged.
- **「一级 tab」换成纯文字 + 选中下划线，并加计数与更新红点（g-070，Revision 51）**：设置页**主 tab**
  （`data-tab-group="main"`）不再是一排 chip，而是参考图那样的一行纯文字：无底色、无边框、无圆角，
  未选中用次要色、选中项文字变亮并在**下方**压一条 2px 下划线（强调色 token），整条栏底部是一条最弱边框色
  的淡分隔线。六个中文标签**单行不折行**：`flex-wrap:nowrap` + `overflow-x:auto`，每个按钮按自己标签宽度
  （`flex:0 0 auto`），**没有**等分列、没有 `max-content`，也不会撑宽祖先（滚动容器只占父级给的宽度）。
  「我的预设」带库条数后缀 `(N)`；N 取自主入口 mount 时**已有的**一次 `GET /prompt-setting/presets`
  （同一个 `?session=`，**零新增请求、零轮询**），且只有确实读到库时才显示——「还在加载 / 请求失败 /
  库文件读不出来」**不显示任何数字**，`(0)` 只表示真的空库。「高级」在确有可用新版本时显示一个红点
  （危险色 token + 可读的 `title`/`aria-label`）；它**与提示条的 `dismissed` 独立**——关掉提示条不会
  清掉红点。`role=tablist/tab`、`aria-selected`、`tabIndex`、`data-tab-*` 与「我的 Prompt」内的层选择器
  （仍是 chip，`data-tab-group="mine-layer"`）全部未动。新增文案 `tabUpdateBadge`（有可用更新 /
  Update available）走 `locale/*.json` 真源，键数 566 → **567（516 主 + 51 `error.<code>`）**。
  **Plain-text top-level tabs with an underline, a count and an update dot (g-070, Revision 51)**: the
  first-level bar is no longer a row of chips — it is plain text (no fill, no border, no radius), the
  selected label brightens with a 2px accent underline pressed against a faint rule under the whole
  bar, and the six Chinese labels stay on one line (`flex-wrap:nowrap` + `overflow-x:auto`, every button
  `flex:0 0 auto`) — no equal fractions, no `max-content`, and nothing that can widen an ancestor.
  「My presets」carries its library size as `(N)`, read from the request the page already makes on mount
  (no new request, no polling) and shown **only** when that size is really known — never a placeholder
  `(0)`. 「Advanced」shows a red dot (danger token, with a readable `title`/`aria-label`) while a newer
  release is on offer, and it is **independent** of the banner's dismissal. Every tab marker, the ARIA
  and every chip-family sub-group selector `tabs()` still draws (「My Prompt」's layer selector, and the
  chunk-level group selectors) are unchanged; the one new locale key brings the dictionaries to 567.
- **删除预设＝对每个已应用的工作区取消应用（g-069，Revision 50）**：`DELETE /presets?id=` 不再只从预设库
  剔项——它先查出所有 `applied` 记录中含该预设的工作区，对每个工作区按**既有栈语义**执行取消应用
  （剩余栈非空 ⇒ 按 `base` + 剩余 link 重算；栈空 ⇒ 写回 `base`，`base` 为 `null` 则移除保留段条目；层的
  其它条目与 `interpolateCustom` 开关不动），逐个落盘并登记与既有「取消应用」同等的历史记录与 prompt
  变更提示，全部成功后才删除预设。任一工作区还原失败 ⇒ 整体中止、**预设保留**，错误如实列出已还原/
  未还原的工作区；未被任何工作区应用时行为与从前逐字节一致（不写任何工作区层）。响应改为
  `restoredWorkspaces` / `links` / `workspaces[]`，正常删除不再产生 orphan（orphan 仅剩手改文件与
  Revisions 37–49 历史数据一种来源，仍可读、可取消）。客户端删除确认浮层在已应用时明确提示
  「会将被应用的工作区还原（即取消预设）」并列出受影响工作区，成功 notice 改为如实说明还原数量；文案
  仍以 `locale/*.json` 为唯一真源（现为 515 主词典 + 51 `error.<code>` = 566 键/语言）。**层文件已被
  删除（`ENOENT`）的工作区按「无可还原」跳过**：不写层、不重建目录、不记历史，但其应用记录仍随预设
  一起清理（不留 orphan），响应以 `missing: true` 标记，且不计入还原数；层存在但不可读/非法仍是拒绝
  （`preset-unapply-failed`）。拒绝文案只把**真正失败**的那个工作区写成 failed。
  **Deleting a preset now cancels it (g-069, Revision 50)**: `DELETE /presets?id=` no longer just drops the
  entry — every workspace whose `applied` record holds the preset is taken off its stack first, with the
  existing stack semantics (remaining links recomposed over `base`; an empty stack restores `base` itself,
  `null` removing the reserved entry; other entries and the `interpolateCustom` switch untouched), each
  restore is written and registered like the existing「cancel application」(history record + prompt-write
  note), and only then is the preset deleted. A workspace that cannot be restored aborts the whole
  deletion, **keeps the preset**, and the refusal lists which workspaces were restored and which were not;
  a preset nothing applied behaves exactly as before (no workspace layer is written). The answer now
  carries `restoredWorkspaces` / `links` / `workspaces[]`, and an ordinary deletion produces no orphan
  (orphans now only come from a hand-edited file or Revisions 37–49 data, and stay readable and
  cancellable). The deletion confirmation states the restore and names the affected workspaces, and the
  success notice reports how many were restored; copy stays sourced from `locale/*.json` (now 515 main +
  51 `error.<code>` = 566 keys per language). **A workspace whose layer file is gone (`ENOENT`) is
  skipped**: nothing is written, no directory is rebuilt and no history is logged, while its record is
  still cleaned up with the preset (no orphan is left), reported as `missing: true` and never counted as
  restored; a layer that exists but is unreadable still refuses the deletion
  (`preset-unapply-failed`), whose message names only the workspace that really failed.
- **「装配状态提示」移到「高级」面板顶部（g-065）**：这块两层装配观察（开关 + 装配层/送达层结论 +
  toast 降级说明）原先挂在「我的 Prompt」（写入口）顶部，而它的读者是「改完 Prompt 却没生效、要查为什么」
  的人，动机正好是打开「高级」。本次只换渲染位置：开关语义、偏好键、读取时机与轮询游标、toast 主动提示
  与宿主侧装配观察全部不变；「我的 Prompt」不再出现该块任何元素（不留空容器与空标题）。
  **The assembly-status block moved to the top of the "Advanced" panel (g-065)**: the two-layer
  observation (switch + assembly/delivery verdicts + toast-degradation note) used to sit at the top of
  "My Prompt" — the write surface — while its reader is the person whose saved prompt seems not to have
  taken effect, which is exactly why "Advanced" gets opened. Only the render position changed: the
  switch, its preference key, the read schedule and poll cursor, the proactive toast and the host-side
  assembly watch are all untouched, and "My Prompt" keeps no element of the block (no empty container, no
  leftover heading).

- **「备份与恢复」变成真正的全量备份，并同步解除导入写锁（g-074，Revision 53）**：`GET /export` 过去只带
  每层的一个保留段条目（`customOverridesOnly` 裁剪），现在带**整机安装**——两层**全部**覆盖（冻结项一并
  带上，`action` 原样保留）、**全部已注册工作区层**（不再只带 `?session=` 解析到的那一个）、预设库
  （`presets.json`）与偏好设置（`preferences.json`）；文档 `version` 升为 `2`，同时仍**接受** `version: 1`
  的旧备份。配套地，`POST /import` **解除** Revision 7 的按名字写锁（原先任何非保留名一律 `403
  write-locked`，导致「导得出去、导不回来」），并把它换成**更严**的逐项校验，且全部发生在任何落盘之前：
  层名白名单、每个条目字段（`name`/`action`/`text`/`order` 及唯一性）、每个工作区 root（绝对路径、无
  `..`、非卷根，且必须是本机注册表中真实存在的工作区，否则 `unknown-workspace-root` 整体拒绝）、预设库与
  偏好文档各自的结构合法性（未知偏好键**拒绝**而非忽略）。任何一项不合法即整体拒绝、**零写入**；四种文件
  （层配置、工作区配置、预设库、偏好）在同一个批次里先全部 staged 并回读校验，再逐个 rename。`?layer=`
  仍然只收窄两层视图，安装级文档此时不应用并在 `skipped` 里说明。契约 §10、§11.1、§4.4、新 §11.7、§15.7、
  §15.8、§20.8 与 §7 概览同步修订，并记 **Revision 53**。
  **A full backup, and the import write lock removed (g-074, Revision 53)**: `GET /export` used to carry one
  reserved entry per layer; it now carries the whole installation — every override of both layers (frozen
  entries included, `action` preserved), **every registered workspace layer** (no longer only the one a
  session resolved), the preset library and the preference document. The document is `version: 2`, and
  `version: 1` backups still import. `POST /import` drops Revision 7's name-based write lock — which made
  a full backup unrestorable — and replaces it with **stricter** validation that runs before anything is
  staged: the layer-name whitelist, every override field, every workspace root (an absolute path, no `..`,
  not a volume root, and a workspace this profile really registers), and the library / preference documents.
  Any invalid input is refused whole, with zero writes; all four kinds of file are staged and read back in
  one batch before the first rename. Contract §10, §11.1, §4.4, the new §11.7, §15.7, §15.8 and §20.8 are
  updated, and Revision 53 is recorded.

### Fixed 修复

- **备份/恢复的路径安全绕过（g-074 R1，Revision 53）**：`presets.applied[].workspaceRoot` 过去只检查「非空字符串」，
  而 `DELETE /prompt-setting/presets?id=` 会用记录里的 root 直接写 `<root>/.dsh-prompt-setting/overrides.json`。
  于是一份导入的备份可以命名任意磁盘路径（`/etc` 也行），删除预设就成了任意路径写入原语——评审 PoC 实测未注册
  目录下的层文件被真实改写。修复：形状规则抽到 `core/workspace-root.js`，由 `workspaces[].root` 与
  `presets.applied[].workspaceRoot` **共用同一个函数**；导入与删除两条路径都对 root 过注册表白名单（未注册即
  整体拒绝、零写入）；导出不再携带无法在本机还原的 `applied` 记录（条数由 `exportScope.omittedApplied` 声明），
  使插件自己产出的备份一定能被自己的导入读回。
  **Path-safety bypass fixed (g-074 R1)**: `presets.applied[].workspaceRoot` was checked for nothing but
  "a non-empty string" while `DELETE /prompt-setting/presets?id=` wrote `<root>/.dsh-prompt-setting/overrides.json`
  straight from the stored record, so an imported backup could name any directory on the disk and the delete
  became a write primitive (the review's PoC rewrote an unregistered directory's layer file). The shape rule now
  lives in `core/workspace-root.js` and is shared by `workspaces[].root` and
  `presets.applied[].workspaceRoot`; both the import and the delete route put every root through the registry
  whitelist (unregistered ⇒ refused whole, zero writes); and an export no longer carries an `applied` record it
  could not restore, with the count declared in `exportScope.omittedApplied` — so the plugin's own backup is
  always readable by the plugin's own import.

- **契约与「同一语义两处口径」收口（g-074 R2）**：`CONTRACT.md` §10 的 Response 200 示例更新为 Revision 53
  形状（原来仍是 `version: 1` + 旧 `exportScope`），Revision 7 的 `exportScope` 表与 §15.7 标题/首段、§15.8
  表格两行补上废置标注并改成新值——消除「文档说 A、实现做 B」；§11.7 写入「读面宽松 + 每个消费点必须过注册表
  白名单」不变量。口径一致性：`validatePreferencesDocument` 对 `downloadRegionRegistry` 复用下载区域路由的
  `validateRegistryAddress`（`file:///etc`、凭证、query、fragment 一律 `400 invalid-preference`），导出侧同口径
  复核、不符合就不携带并在 `exportScope.unavailable.preferences` 声明。
  **Contract and「one semantic, one rule」clean-up (g-074 R2)**: §10's Response 200 example now shows the
  Revision 53 shape, the Revision 7 `exportScope` table, §15.7's heading/first paragraph and §15.8's two
  rows are marked superseded and updated, and §11.7 now carries the「lenient read face + registry whitelist at
  every consumer」invariant. On the semantics side, `validatePreferencesDocument` reuses the download-region
  route's own `validateRegistryAddress` for `downloadRegionRegistry`, and an export applies the same rule in
  reverse rather than carrying a preference document its own import would refuse.

- **英文文案泄露（g-066）**：导出失败时不再把浏览器侧的英文原文（`no document`）拼进界面文案，改为
  走本地化兜底；`errorText` 对**未登记**的错误码不再把 `error.<code>` 裸键显示出来，而是退回本地化的
  `errUnknown`（原始 code 仍由错误横幅的 `errorCode` 行如实呈现）；另修掉两条英文文案里残留的中文
  书名号（`「My Prompt」` → `"My Prompt"`）。
  **English leaks fixed (g-066)**: a failed export no longer splices the browser's own English wording
  (`no document`) into localized copy, and `errorText` no longer renders a bare `error.<code>` key for a
  code that has no entry — it falls back to the localized `errUnknown` (the raw code is still shown
  verbatim on the banner). Two English strings that carried Chinese corner brackets were normalized too.

## [0.2.2] - 2026-10-13

**功能版本：新增「预设」库（保存 / 编辑 / 删除，可应用到工作区、也可取消应用），装配状态改为会话内
主动提示，并修复官方组件探测（设置页首次真正启用宿主官方组件）。底层还做了客户端半代码复用收口。 /
Feature release: a new preset library (save / edit / delete, apply to a workspace and un-apply), an
in-session assembly-status notice, and a fix to the official-component probe (the settings page now
actually uses the host's own components for the first time). The client half also got a code-reuse
cleanup underneath.**

（本次发布覆盖 g-060…g-063；范围经 `git merge-base --is-ancestor` 逐项核实——四个目标的代表提交都是
`dev` 的祖先、都不是 `009ec61`（0.2.1 发布合并提交）的祖先，`merge-base(main,dev) = 93b0d9e`（0.2.1
升版提交）。 / This release covers g-060…g-063; each was verified with `git merge-base --is-ancestor` —
every target's representative commit is an ancestor of `dev` and not of `009ec61` (the 0.2.1 release merge
commit), with `merge-base(main,dev) = 93b0d9e` (the 0.2.1 version bump).）

### Added 新增

- **「预设」库（g-060 / Revision 37–41）**：设置面板新增「我的预设」tab，可以把一整套 Prompt 存成命名
  预设，随时**编辑**或**删除**；一次「应用」把预设写进所选工作区，再点一次即**取消应用**。预设按**粒度**
  独立记账：要取消的是哪一次应用就还原哪一次，后一次应用不会吞掉前一次，重复应用同一预设是幂等的
  （不会叠加成双份），多个预设叠加时按应用顺序回放。编辑与覆盖已应用的预设、以及所有破坏性动作
  （删除、取消应用）都走**二次确认**，未保存的草稿在关闭弹窗时**受保护**，不会被静默丢弃。
  **The preset library (g-060 / Revision 37–41)**: a new "My presets" tab saves a whole prompt as a named
  preset that can be **edited** or **deleted** at any time, and one "apply" writes it into the chosen
  workspace — clicking again **un-applies** it. Presets are tracked **per application**, so un-applying
  restores exactly the application you are undoing: a later apply never swallows an earlier one, applying
  the same preset twice is idempotent (it does not double up), and stacked presets are replayed in apply
  order. Editing or overwriting an applied preset, and every destructive action (delete, un-apply), go
  through a **second confirmation**, and an unsaved draft is **protected** when the dialog is closed
  instead of being silently dropped.
- **会话内「装配状态提示」（g-062 / Revision 46–48）**：DSH 每个 model step 都会重新装配 system prompt，
  但「装配到」不等于「送达到模型」。改动 Prompt 后的下一个 run 会**主动弹一次 toast**，说明本次装配是否
  读到了新文本、以及它是否进入本次请求；设置页保留同一份详情与开关。提示**只落界面**——不进上下文、
  不占 token、不改模型收到的 prompt，且只在关键节点提示一次（新会话首次装配、每次变更后的下一个 run），
  因此不会变成刷屏。
  **The in-session assembly-status notice (g-062 / Revision 46–48)**: DSH re-assembles the system prompt on
  every model step, and "assembled" is not the same as "delivered to the model". After a prompt change, the
  next run **raises one toast** saying whether this assembly read the new text and whether it entered the
  request; the settings page keeps the same detail plus its switch. The notice is **UI only** — it never
  enters the context, costs no tokens and changes no prompt the model receives — and it fires only at key
  points (a new session's first assembly, and the next run after each change), so it cannot turn into noise.

### Changed 变更

- **版本号 `0.2.1` → `0.2.2`**：同步表示「本包当前版本」的每一处——本包 `package.json` 的 `version`、
  宿主的 `PLUGIN_VERSION`、`CONTRACT.md` 里的响应与示例、三份 README 的徽章与「当前版本」表述，以及
  测试中表示本包版本的硬字面量（含 `0.2.1` → `0.2.2` 的本包版本字面量，以及随之配套的更新目标夹具
  `0.2.2` → `0.2.3`）。版本号本身**不引入任何行为
  变更**：本版的行为变化全部是下面的条目，版本号不改变路由、落盘内容或既有响应字段。
  `npm publish` / `git tag` / `git push` 仍是人工 gate，不在本次变更内。
  **Version `0.2.1` → `0.2.2`**: every place that states "the version this package currently is" was
  moved together — this package's `package.json`, the host's `PLUGIN_VERSION`, the responses and examples
  in `CONTRACT.md`, the badges and "current" lines in all three READMEs, and the test literals that assert
  the package version (the package-version literals `0.2.1` → `0.2.2`, plus the "update target" fixtures that
  move with them, `0.2.2` → `0.2.3`). The bump
  itself introduces **no behaviour change**: this release's behaviour changes are the entries below, and
  the version number alone alters no route, no stored content and no existing response field.
  `npm publish`, `git tag` and `git push` remain manual gates and are not part of this change.
- **客户端半代码复用收口（g-061 / Revision 42–44）**：设置面板的各分块与主入口之间，把重复实现的
  机械部分收敛成共享模块（样式常量、层标签、下载区域文案键、tab 适配器、工作区推导等）。外观与交互
  **一字未改**，产物的分块划分（本版共 5 个分块，新增的 `client.presets.js` 即下方「预设」tab 一项）
  与构建指纹口径也不变。
  **Client-half code reuse cleanup (g-061 / Revision 42–44)**: mechanical duplication between the settings
  panel's chunks and its main entry is folded into shared modules (style constants, layer labels, download
  region copy keys, tab adapters, workspace derivation). The look and the interactions are **unchanged**,
  as are the artifact's chunk split (5 chunks in this release, the new `client.presets.js` being the
  "Presets" tab below) and the build-fingerprint rules.
- **「高级」状态区的两条常驻探测诊断行已移除（g-063 收尾）**：`data-primitives-detail` 与
  `data-primitives-members` 是为在真机定位下方那个 forwardRef 缺陷而临时加的常驻读数，使命完成后删除；
  渲染分支行、`data-primitives-toast-source` 行与两条仅在异常时出现的**原因行**（`data-primitives-failure`
  / `data-primitives-render-error`）全部保留。
  **Two always-on probe readout lines were removed from the "Advanced" status area (g-063 wrap-up)**:
  `data-primitives-detail` and `data-primitives-members` were temporary always-on readouts added to locate
  the forwardRef defect below on a real machine; they are removed now that they have served that purpose.
  The render-branch line and the `data-primitives-toast-source` line stay, and so do both **reason lines**
  (`data-primitives-failure` / `data-primitives-render-error`) that appear only when something went wrong.

### Fixed 修复

- **官方组件探测恒为假（g-063）**：判定「宿主是否提供官方组件」的条件是 `typeof Button === 'function'`，
  但 `React.forwardRef` 的产物是**对象**，`typeof` 永远是 `'object'` ⇒ 该判定自诞生起恒为 false，设置页
  一直退回自绘控件，从未真正启用宿主官方组件。现在新增 `isComponentExport`：函数组件，或带 React
  组件 brand（`forwardRef` → `render`、`memo` → `type`）且结构字段合法者；未知 brand、字段缺失或
  getter 抛错一律判不可用（保持 fail-open）。同一判据统一用于图标、差异块、`UI.Input` / `Tag`、分段
  tab 与 toast。
  **The official-component probe was always false (g-063)**: the check for "does the host ship its own
  components" was `typeof Button === 'function'`, but `React.forwardRef` yields an **object** whose `typeof`
  is always `'object'`, so the test was false from the day it was written and the settings page always fell
  back to its own controls instead of ever using the host's. A new `isComponentExport` accepts a function
  component, or anything carrying the React component brand (`forwardRef` → `render`, `memo` → `type`)
  with valid structural fields; an unknown brand, a missing field or a throwing getter is treated as
  unusable (fail-open preserved). The same predicate now drives icons, diff blocks, `UI.Input` / `Tag`,
  segmented tabs and the toast.

---

## [0.2.1] - 2026-10-11

**修复版本：修好「我的 Prompt」在分层查看下的读写错位（保存了却读不出来、切换查看范围静默写空），把
「查看范围」收进「我的 Prompt」块，并为保留段补上「空值＝该层不声明」与「覆盖 / 叠加」两套语义。 /
Fix release: the layered "My prompt" surface no longer reads the wrong layer or silently writes an empty
draft when the view scope changes; the "view scope" card is folded into the "My prompt" block; and the
reserved section gains both "an empty value means this layer states nothing" and an explicit
override / append mode.**

（g-050 的编辑器跟随修复与「检查更新已已开启」的重复字修复已随 `[0.2.0]` 发布，条目见上一段，本段不
重复。 / g-050's editor-follow fix and the duplicated "已已开启" copy were released with `[0.2.0]`; their
entries stay in the previous section and are not repeated here.）

### Added 新增

- **保留段「覆盖 / 叠加」模式（g-058）**：「我的 Prompt」现在可选本层文本和另一层的关系——**覆盖**
  （本层盖掉另一层，即原来的行为）或**叠加**（本层接在另一层之后：用户层在前、工作区层在后，两层都有
  内容时中间空一行，只有一层有内容时不留孤立空行）。导出、导入与回滚都会带上这个模式，**任何一次写入
  都只动当前这一层**。
  **"Override / append" mode for the reserved section (g-058)**: "My prompt" now states how this layer
  relates to the other one — **override** (this layer replaces it, the previous behaviour) or **append**
  (this layer follows it: the user layer first, the workspace layer after, one blank line between two
  non-empty texts and no stray blank line when only one has text). Exports, imports and rollbacks carry
  the mode, and **a write only ever touches the layer it targets**.

### Changed 变更

- **版本号 `0.2.0` → `0.2.1`**：同步表示「本包当前版本」的每一处——本包 `package.json` 的 `version`、
  宿主的 `PLUGIN_VERSION`、`CONTRACT.md` 里的响应与示例、三份 README 的徽章与「当前版本」表述，以及
  测试中表示本包版本的硬字面量（含 `0.2.1` → `0.2.2` 的更新目标夹具）。版本号本身**不引入任何行为
  变更**：本版的行为变化全部是下面的条目，版本号不改变路由、落盘内容或既有响应字段。
  `npm publish` / `git tag` / `git push` 仍是人工 gate，不在本次变更内。
  **Version `0.2.0` → `0.2.1`**: every place that states "the version this package currently is" was
  moved together — this package's `package.json`, the host's `PLUGIN_VERSION`, the responses and examples
  in `CONTRACT.md`, the badges and "current" lines in all three READMEs, and the test literals that assert
  the package version (including the "update target" fixtures, which moved `0.2.1` → `0.2.2`). The bump
  itself introduces **no behaviour change**: this release's behaviour changes are the entries below, and
  the version number alone alters no route, no stored content and no existing response field.
  `npm publish`, `git tag` and `git push` remain manual gates and are not part of this change.
- **保留段空值＝该层不声明（g-057 / Revision 35）**：把「我的 Prompt」在某一层写空，不再等于「用空文本
  盖掉另一层」——空值只表示这一层没表态，另一层已写好的文本照常生效；两层都空则该段什么都不施加。此前
  工作区层的一个空条目会让用户层写好的文本**永远不生效，而且没有任何提示**。
  **An empty reserved section means that layer states nothing (g-057 / Revision 35)**: clearing "My prompt"
  in one layer no longer overwrites the other layer with an empty string — an empty value only means this
  layer has nothing to say, and the other layer's text stays in effect; with both layers empty the section
  applies nothing. Before this, one empty workspace-layer entry made the user layer's text **silently
  never take effect**.
- **「查看范围」收成「我的 Prompt」块的头部（g-055）**：这两者在功能上是一个块，现在也用同一条视觉
  带子收在一起，并在「我的 Prompt」里给出一行**只读**的写入目标说明（写到哪一层、看的是哪个范围）。
  页面级的位置和唯一的改范围入口都没有搬动，折叠行为、标记与既有文案一字未改。
  **The "view scope" is folded into the head of the "My prompt" block (g-055)**: the two are one feature
  on the page and now read as one block under a shared visual band, with a **read-only** line inside
  "My prompt" naming the write target (which layer, which scope). The page-level position and the single
  scope control are unmoved, and the collapse behaviour, markers and existing copy are unchanged.

### Fixed 修复

- **分层编辑框读错了来源（g-054）**：在某一层保存过「我的 Prompt」之后，切到另一层，编辑框却显示为空
  （「版本历史」里那条记录明明在，回滚也提示成功）。现在每层的编辑框只读**该层自己的**内容：另一层
  有同名条目、甚至另一层存的是空文本，都不会再顶替本层显示。
  **A layered editor read the wrong source (g-054)**: after saving "My prompt" in one layer, switching to
  the other showed an empty box (while "Version history" held the record and a rollback reported success).
  Each layer's box now reads **that layer's own** content: a same-named entry in the other layer — even an
  empty one — no longer stands in for it.
- **切换「查看范围」会静默把草稿写空（g-056）**：未保存的草稿现在按**写入目标**保管（用户层是整份，
  工作区层按工作区）——在同一个写入目标里切会话、切范围，草稿都留在框里；草稿属于别的写入目标时，
  「保存」会被**明确阻断**并说明原因，另给一个「放弃那份草稿」的按钮（纯本地，不写任何数据）。
  此前切换范围会让编辑框静默回落到空文本，再保存就是一次成功提示背后的空写入。
  **Changing the "view scope" silently saved an empty draft (g-056)**: an unsaved draft is now kept
  per **write target** (the user layer is one, each workspace another) — switching sessions or scopes
  inside the same target keeps the draft in the box; when the draft belongs to another target, "Save" is
  **blocked with an explanation**, and a "discard that draft" button (local only, writing nothing) is
  offered. Before this, a scope change silently fell back to empty text, and saving it wrote that empty
  text behind a success notice.
- **冻结状态「未知」的文案不再指错人、也不再乱归因（g-052）**：状态条不再原样引用宿主的英文实现
  术语，也不再暗示「未在运行 / 未打开 / 已结束」这类未经证实的原因；指代统一为**「所选会话」**，并
  补两行说明——无法探测的是该会话自己的装配，而「未知」**不等于未冻结**（仍可编辑保存，只是不保证
  生效）。
  **The "unknown" frozen-state copy no longer names the wrong subject or invents a cause (g-052)**: the
  status line stops quoting the host's English implementation terms and stops implying unverified causes
  ("not running / not open / finished"); it says **"the selected session"** throughout and adds two lines
  — what could not be probed is that session's own assembly, and "unknown" **does not mean unfrozen**
  (editing and saving still work, they are just not guaranteed to take effect).

---

## [0.2.0] - 2026-10-09

**功能版本：更新检查改从 npm registry 读取并新增「下载区域」选择，客户端按需分块加载，DSH peer 范围纳入
0.2.1 线，并修复「版本历史」与「查看范围」的多处体验问题。 / Feature release: the update check now reads
the npm registry and gains a "download region" choice, the client loads in on-demand chunks, the DSH peer
range takes in the 0.2.1 line, and several version-history and "view scope" defects are fixed.**

### Added 新增

- **更新检查改从 npm registry 读取（g-042）**：插件不再只问 GitHub Release，而是先读 npm registry 的
  `dist-tags.latest` 与 `versions[<latest>].dist.tarball`（**顶层没有 `dist`，真实下载地址在版本条目
  里**），GitHub Release 作为回退。安装时同样优先使用该 tarball。响应因此新增 `source` 字段区分来源。
  **The update check reads the npm registry (g-042)**: instead of asking only GitHub Releases, the plugin
  first reads the registry's `dist-tags.latest` and `versions[<latest>].dist.tarball` (there is **no
  top-level `dist`**; the real artifact URL lives in the version entry), falling back to the GitHub
  release. Installation prefers the same tarball, and the response carries a new `source` field.
- **「下载区域」选择（g-043）**：「检查更新」卡片新增下载区域——**默认**、**中国大陆**（npmmirror 镜像）、
  **自定义**。默认值由**能否真正取到本包**这一连通性探测决定（按延迟取最快，**不使用第三方 IP 地理定位**，
  因此不受代理影响）；自定义地址经严格校验（必须是 http(s)、主机非空，且不带账号密码、查询串或片段），
  非法时给出红字说明且不落盘。
  **A "download region" choice (g-043)**: the update card gains a source selector — **Default**, **Chinese
  mainland** (the npmmirror mirror) and **Custom**. The default is decided by a connectivity probe that asks
  whether a source can actually serve *this* package (fastest wins; **no third-party IP geolocation**, so a
  proxy does not mislead it). A custom address is strictly validated (http(s), non-empty host, no
  credentials, query string or fragment) and an invalid one is refused with a red explanation, writing
  nothing.

### Changed 变更

- **客户端按需分块（g-045 / g-046）**：设置面板的客户端代码不再一次性全部加载——「提示词总览」「高级」
  「备份与恢复」「版本历史」各自成为按需加载的分块，主文件瘦身约 16%，打开设置时不请求任何分块。构建
  指纹随之覆盖全部 5 个文件并逐块校验，页面上的「构建戳」在任一分块损坏时会**明确报不一致**，而不是
  显示「一致」。
  **The client loads in on-demand chunks (g-045 / g-046)**: the settings panel no longer ships as one
  payload — "Prompt overview", "Advanced", "Backup and restore" and "Version history" are each a chunk that
  loads when its tab is opened; the main file shrank by about 16%, and opening settings requests no chunk at
  all. The build fingerprint now covers all five files and verifies every chunk, so a damaged chunk makes the
  page's build stamp report a mismatch instead of "in sync".
- **DSH peer 范围纳入 0.2.1 线**：`>=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.1-0 || >=0.2.1-0 <0.2.2-0`，
  即 `0.2.1` 的全部预发布与正式版都在支持范围内；`0.2.2-0` 及以后出界。**在 DSH 0.2.1 上插件此前会被
  平台整体跳过（装不上、也不加载）**，本版修复。
  **The DSH peer range takes in the 0.2.1 line**: `>=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.1-0 ||
  >=0.2.1-0 <0.2.2-0` — every prerelease and release of `0.2.1` is supported, and `0.2.2-0` onward is out.
  **On DSH 0.2.1 the plugin used to be skipped by the platform entirely** (it could neither be installed nor
  loaded); this release fixes that.

### Fixed 修复

- **「版本历史」列表高度过低（g-044）**：窗口化时列表只显示一条、最大化也仅多几条——面板改为按运行时可
  用高度撑满，不再依赖估算的视口偏移。
  **The "version history" list was too short (g-044)**: a windowed browser showed a single row (a maximised
  one only a few), because the panel height was an estimated viewport offset; it now measures the space
  actually available at run time.
- **「版本历史」曾列出插件注册的段（g-044）**：列表不再展示由插件注册（而非用户覆盖）的段，只保留用户
  自己写下的记录。
  **The history list used to show plugin-registered sections (g-044)**: it no longer lists sections that a
  plugin registered rather than the user overriding, keeping only the records the user wrote.
- **「搜索会话」输入框被会话标题占用（g-047）**：在「查看范围」里选中一个会话后，搜索框不再被填入该会话
  标题——**输入框只装用户自己敲的内容**，占位符恒为「搜索会话（标题 / 路径 / session id）」。此前被填入
  的标题还会立即参与过滤，甚至可能被当作 session id 解析。
  **The "search sessions" box was overwritten with the session title (g-047)**: selecting a session no longer
  writes its title into the search box — the box holds **only what the user typed**, and its placeholder is
  always "Search sessions (title / path / session id)". The old behaviour also fed that title straight into
  filtering and could even parse it as a session id.
- **回滚 / 重置 / 导入之后编辑器仍显示旧文本（g-050）**：「我的 Prompt」的编辑框在服务端内容已改变后
  不再停留在旧文本上。若框内内容只是原样重复了旧的已保存值，会被静默丢弃并跟上新值；若框内是**尚未保存
  的编辑**，则保留内容并在提示里说明「配置已在别处更新」，**不会悄悄丢掉你写的字**。
  **After a rollback, a reset or an import the editor still showed the old text (g-050)**: the "My prompt"
  box no longer keeps showing text the layer no longer holds. A box that merely repeated the previous saved
  value is dropped silently and follows the new value; a box holding **unsaved edits** keeps them, and the
  notice says the configuration changed elsewhere — your text is never thrown away silently.
- **中文提示「检查更新已已开启」（重复字）**：模板与状态值各带一个「已」，已修正为「检查更新已开启」。
  **The Chinese notice read "检查更新已已开启" (a duplicated character)**: both the template and the state
  value carried the same prefix; it now reads "检查更新已开启".

---

## [0.1.5] - 2026-10-08

**功能版本：版本历史与备份拆成两个 tab，历史作用域与「查看范围」解耦，列表分页，新增记录预览与一键
回滚，预览 / 对比改为视口弹窗 / Feature release: history and backup are split into two tabs, the history
scope is decoupled from the page's "view scope", the list paginates, and a record preview plus one-click
rollback are new; preview and diff render in a viewport dialog.**

### Added 新增

- **「历史与备份」拆成两个 tab（g-038）**：原「历史与备份」卡片拆为**「版本历史」**与**「备份与恢复」**
  两个 tab——导出 / 导入移入后者，前者只管浏览、预览、对比与回滚。**拆 tab 只改页面组织，路由、字段与
  落盘内容零变化。**
  **History and backup are now two tabs (g-038)**: the old "history and backup" card became **"Version
  history"** and **"Backup and restore"** — export / import moved into the latter, and the former only
  browses, previews, diffs and rolls back. The split is page organisation only: no route, field or stored
  byte changes.
- **历史作用域与「查看范围」解耦（g-038）**：版本历史**不再受页面上方「查看范围」影响**——用户级显示该层
  **全部**记录；工作区级改用**独立的工作区选择器**（折叠为一行摘要，点「更改」展开，展开后带搜索与定长
  内滚候选）。
  **The history scope is decoupled from the page's "view scope" (g-038)**: version history no longer
  follows the "view scope" selector at the top of the page — the user level shows **every** record of that
  level, and the workspace level gets its **own workspace picker** (collapsed to a one-line summary, opened
  by "Change", with a search box and a fixed-height scrolling candidate list).
- **历史列表分页与整屏内滚（g-038）**：记录很多时不再需要一路滚到底——列表分页，并在固定高度的面板内
  滚动。
  **The history list paginates and scrolls inside its own panel (g-038)**: with many records there is no
  more scrolling to the bottom of the page — the list is paged and scrolls within a fixed-height panel.
- **记录预览与一键回滚（g-039）**：任意历史记录可以**只读预览**（**不写任何数据**），并可**一键回滚到
  该版本**。回滚**只恢复「我的 Prompt」段**——该层里其它段一个字节都不动；回滚本身也记入历史，因此可以
  继续再回滚。
  **Record preview and one-click rollback (g-039)**: any history record can be **previewed read-only**
  (**writing nothing**), and **rolled back to** in one click. A rollback **restores only the "My prompt"
  section** — every other section of that layer is left byte-identical — and the rollback is itself recorded
  in history, so it can be rolled back again.
- **预览与对比改为视口弹窗（g-039）**：两者不再占用内联空间，改为视口弹窗——关闭按钮在右上角、`Esc` 可
  关，弹窗内的时间按**用户本地时区**显示；点击记录行即建立对比，「当前生效值」行同样可点选。
  **Preview and diff render in a viewport dialog (g-039)**: neither takes inline space any more — the close
  button sits in the top-right corner, `Esc` closes the dialog, and the timestamps inside it render in the
  **user's local time zone**; clicking a record row selects it for the diff, and the "currently in effect"
  row is selectable the same way.

### Changed 变更

- **版本号 `0.1.4` → `0.1.5`**：同步表示「本包当前发布版本」的每一处——本包 `package.json` 的 `version`、
  宿主的 `PLUGIN_VERSION`、`CONTRACT.md` 里的响应与示例、两份根 README 的徽章与「当前版本」表述，以及
  测试中表示本包版本的硬字面量。版本号本身**不引入任何行为变更**：本版的行为变化全部是上面五条
  （g-038 / g-039），版本号不改变路由、落盘内容或既有响应字段。`npm publish` / `git tag` / `git push`
  仍是人工 gate，不在本次变更内。
  **Version `0.1.4` → `0.1.5`**: every place that states "the version this package currently publishes" was
  moved together — this package's `package.json`, the host's `PLUGIN_VERSION`, the responses and examples in
  `CONTRACT.md`, the badges and "currently" lines in both root READMEs, and the test literals that assert the
  package version. The bump itself introduces **no behaviour change**: this release's behaviour changes are
  the five entries above (g-038 / g-039), and the version number alone alters no route, no stored content and
  no existing response field. `npm publish`, `git tag` and `git push` remain manual gates and are not part of
  this change.

---

## [0.1.4] - 2026-10-06

**发布准备版本 + 一处用户可感知变更：更新后的重启提示按启动形态分区；插件自报版本切到 `0.1.4` /
Release-prep release with one user-visible change: the post-update restart hint is partitioned by launch
shape; the plugin reports `0.1.4`.**

### Changed 变更

- **更新后的重启提示按启动形态分区（g-036）**：安装完成后那句话不再写死「重启 `dsh web`」。宿主从官方
  `profileContext.name` 判定启动形态（`desktop` / 其它名字 = `cli` / 读不到 = `unknown`，绝不猜成
  命令行），并在 ping 与 `update-apply` 三个响应上新增 `launchKind` 字段（老宿主没有该字段时页面按
  `unknown` 处理）。页面据此选文案：命令行给出「已安装 vX.Y.Z，请手动重新运行 `dsh web` 生效」；官方
  桌面端给出「请退出并重新打开 DeepSeek Harness 生效」——**该组文案不含 `dsh web`**（桌面端用户看不到
  终端，正式版 App 内也没有重启入口，需完全退出后重开）；形态无法判定时给两种形态都读得通的中性文案。
  安装动作本身与「**绝不自动重启**」不变，既有响应字段与状态机语义不变。中英两份文案表都已分区。
  **The post-update restart hint is partitioned by launch shape (g-036)**: the sentence shown after an
  install no longer hardcodes "restart `dsh web`". The host judges the shape from the official
  `profileContext.name` (`desktop`, any other name = `cli`, unreadable = `unknown` — never guessed as
  command line) and reports it as a new `launchKind` field on the ping and on all three `update-apply`
  responses (an old host's missing field reads as `unknown`). The page then picks its copy: the command
  line says "vX.Y.Z is installed — re-run `dsh web` yourself", the official desktop app says "quit and
  reopen DeepSeek Harness" — **that group never contains `dsh web`** (a desktop user has no terminal, and
  the shipped app has no in-app restart entry, so it must be fully quit and reopened) — and an
  undecidable shape gets copy both readers can follow. The install action itself and the "**never an
  automatic restart**" promise are unchanged, as are every existing response field and the state machine.
  Both dictionaries are partitioned.
- **版本号 `0.1.3` → `0.1.4`**：同步表示「本包当前发布版本」的每一处——本包 `package.json` 的 `version`、
  宿主的 `PLUGIN_VERSION`、`CONTRACT.md` 里的响应与示例、两份根 README 的徽章与「当前版本」表述，以及
  测试中表示本包版本的硬字面量。它本身**不引入任何行为变更**——本版唯一的行为变化是上面那条 g-036
  （响应新增 `launchKind`、页面文案按形态分区），而该变化正是由 g-036 引入、在本段如实记录；版本号本身
  不改变路由、落盘内容或既有响应字段。`npm publish` / `git tag` / `git push` 仍是人工 gate，不在本次
  变更内。
  **Version `0.1.3` → `0.1.4`**: every place that states "the version this package currently publishes" was
  moved together — this package's `package.json`, the host's `PLUGIN_VERSION`, the responses and examples in
  `CONTRACT.md`, the badges and "currently" lines in both root READMEs, and the test literals that assert the
  package version. The version bump itself introduces **no behaviour change** — the release's one
  behaviour change is the g-036 entry above (a new `launchKind` response field and shape-partitioned page
  copy), recorded there for what it is; the version number alone alters no route, no stored content and no
  existing response field. `npm publish`, `git tag` and `git push` remain manual gates and are not part of
  this change.

---

## [0.1.3] - 2026-10-05

**功能版本：时间戳全面按读者时区呈现（显示与导出文件名）/ Feature release: every timestamp is rendered
in the reader's own time zone, including the export file name.**

### Changed 变更

- **时间戳按读者时区呈现（Revision 18）**：宿主仍以 UTC ISO 8601 存与答，但设置页把给人看的时间与**导出文件名**
  都改为在**浏览器自身时区**呈现——状态区的「快照生成时间」（`snapshot.generatedAt`）与「历史与备份」每条记录的
  写入时间（`at`）显示为 `2024-01-02 18:00:00 GMT+8`（存储值 `2024-01-02T10:00:00.000Z` 在东八区的读法）；
  导出的文件名形如 `dsh-prompt-setting-2024-01-02-18-00-00.json`。显示骨架固定（不做 12 小时制、不按语言
  重排字段），原始 UTC 串保留在节点 `title` 上便于与宿主日志核对；文件名不带时区标签（`:` 折成 `-`，Windows
  下非法），定宽字段仍按导出时间可排序，且与文档里的 `exportedAt` 同源。解析不出的值原样回显，无 `Intl` 的
  环境回退到 UTC 形态（文件名回退为 Revision 18 之前的拼写）。**线上字段、路由与落盘内容零变化**：导出文档里的
  `exportedAt` 仍是 UTC，历史的排序与 `?before=` 过滤仍基于存储串。
  **Every timestamp renders in the reader's time zone (Revision 18)**: the host still stores and answers UTC
  ISO 8601, but the settings page renders both stamps a human reads — the snapshot's `generatedAt` and each
  history record's `at` — and the **export file name** in the **browser's own zone**. A UTC+8 reader sees
  `2024-01-02 18:00:00 GMT+8` for `…T10:00:00.000Z`, and the download is named
  `dsh-prompt-setting-2024-01-02-18-00-00.json`. The skeleton is fixed (no 12-hour clock, no locale
  re-ordering) and the raw UTC string stays on the node's `title`; the file name carries no zone label (`:`
  folded to `-`, illegal on Windows), keeps the fixed-width fields that sort by export time, and derives from
  the same `exportedAt` the document carries. An unparsable value is echoed, and an engine without `Intl` falls
  back to the UTC form (the file name to its pre-Revision-18 spelling). No wire field, route or stored byte
  changes: `exportedAt` inside the document is still UTC, and ordering and the `?before=` bound still use the
  stored strings.

---

## [0.1.2] - 2026-10-04

**功能版本：更新检查 +「立即更新」、设置页版本号，以及一处冻结误报修复 / Feature release: the update
check and "Update now", the settings-page version, and a false freeze report fixed.**

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
  「无可用信息」（`hasUpdate:null`）只在「高级」以一句中性文案解释，**检查失败不显示它**（两者是不同
  事实，不能混为一谈）；semver 只比较核心三段，`1.0.0` 与 `1.0.0-rc.1` 判相等，属**漏报而非误报**
  （`CONTRACT.md` §17.2）。
  **"No usable information"** (`hasUpdate:null`) is explained only inside the Advanced card, in one neutral line
  that a **failed** check does not get — the two are different facts and must not be confused. Semver compares the
  core triple only, so `1.0.0` vs `1.0.0-rc.1` is a *missed* update, never a false one (`CONTRACT.md` §17.2).
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

- **「立即更新」：宿主经官方 `pluginManager` 装 Release tarball，装完由你手动重启（g-032）**：提示条新增
  **「立即更新」**按钮（`data-action="update-apply"`），点击走**二次确认**（`data-region="confirm"`，
  文案写明「安装后需手动重启 `dsh web` 才生效」）。确认后由**宿主**调用官方插件管理器
  `installBundle(spec, {enabled:true, requestId})` 安装
  `https://github.com/zangxx66/dsh-prompt-setting/releases/download/<tag>/dsh-prompt-setting-<version>.tgz`
  ——`<tag>`/`<version>` 取自**同一次**更新检查（复用 6 小时缓存 ⇒ 零外呼；不新增 HTTP 响应字段的语义），
  所以「提示的版本 = 安装的版本」。**永不自动重启**：升级必然返回 `application: "restart-required"`，
  页面显示「已安装 vX.Y.Z，请手动重启 `dsh web` 生效」。新增新路由 `POST|GET /prompt-setting/update-apply`
  与 `POST /prompt-setting/update-apply/cancel`（发起即返回 `requestId`，客户端 1.5～5 秒轮询、最长 16 分钟、
  可取消；宿主自建 `requestId → 状态` 表，上限 20 条 / 保留 10 条已完成，官方 settle 后不保留结果）。
  **绝不传 `approvedBuilds`**（不写 profile 的 `allowBuilds`，避免让后续 install 执行任意包脚本）；
  **`link:`/本地路径安装形态拒绝执行**（A1：那是开发工作树，覆盖它没有回头路），返回明确 reason 与手动更新
  指引。失败按分类呈现：**资产缺失(404)** / 构建审批被拦 / 网络 / pnpm 缺失 / 超时 / …. 插件管理器作为
  **可选**服务查找（`ctx.get('pluginManager')`，**不进 `inject`**），服务缺失时路由返回结构化错误，
  既有三服务 `webServer`/`connection`/`systemPrompt` 与其它路由一字未动。失败**绝不自动重试**，
  全程**绝不 5xx**（形状错才是 400）。**发布流程新增一步 + 长期约束（必读）**：每个 release 必须上传
  `npm pack` 产物资产，命名固定 `dsh-prompt-setting-<version>.tgz`；本包**不得**新增
  `postinstall`/`install` 脚本（带它们的 tarball 会被 `ERR_PNPM_IGNORED_BUILDS` 拦）。契约见
  `CONTRACT.md` §18，实测与依据见 `NOTES.md` §107。复核后三处收紧：**探针失败不再误拦更新**（只有
  资产明确缺失 `404`/`410` 或不可匿名获取 `401`/`403` 才拒绝，`500`/`429`/`405` 等「探测不出结果」
  一律继续安装并交给 pnpm 裁决）；**profile 清单不可读时拒绝安装**（不再当成「未声明该包」而跳过
  `link:` 检查）；**关掉「检查更新」开关后，已在运行的安装仍可取消**（开关只门禁安装入口，不门禁
  已经在跑的那一个）。另：已安装版本与提示版本相同时不再显示「立即更新」按钮（避免「我是不是点了
  两次」的困惑），上游发布更新的版本时按钮自动回来。**真机缺陷修复（2026-10-04）**：桌面版在 release
  产物上重复点「立即更新」会被报成「安装失败」——根因是 profile 里已装的 spec 与安装目标**完全相同**时，
  `pnpm add` 不产生任何依赖变化，官方插件管理器随即抛 `ambiguous-install`
  （`dsh-plugin-manager/lib/index.js:1782`），而当时的分类只看 pnpm 的失败 kind、漏掉官方
  `ManagementError.code` ⇒ 落成「could not be classified」，并且在我们**什么都没改**的情况下还声称
  「profile files were restored」。现在三处修正：**同 spec 直接短路为成功**（不调用包管理器，返回
  `alreadyInstalled: true` + `done`/`restart-required`，文案「该版本已安装，请手动重启 dsh web 生效」）；
  **分类表覆盖官方全部 12 个 `ManagementError.code`**（逐条可读可操作，`operation-error` 作为包装继续
  下钻到 pnpm 的原因）；**不再谎称回滚**（只有官方确实还原过文件的失败才提，`unknown` 的兜底也改为如实
  说明「宿主没有给出原因」）。另：重试按钮按失败是否可重试门禁。
  **"Update now": the host installs the release tarball through the official plugin manager, and you do the
  restart (g-032)**: the banner gains an **Update now** button which opens a **second confirmation** that says the
  restart is manual. On confirm the **host** calls the official `installBundle(spec, {enabled:true, requestId})`
  with the release **asset** URL, whose `<tag>`/`<version>` come from the *same* update check (six-hour cache ⇒
  zero outbound requests), so the version announced is the version installed. **Nothing ever restarts**: an
  upgrade returns `application: "restart-required"` and the page says "restart `dsh web` yourself". New routes
  `POST|GET /prompt-setting/update-apply` and `POST /prompt-setting/update-apply/cancel` (the start answers a
  `requestId` at once; the page polls for up to 16 minutes and can cancel; the host keeps its own bounded
  `requestId → state` table because the official manager deletes a settled request). **`approvedBuilds` is never
  passed**, and a **`link:`/local-path install is refused** with a manual-update route instead of being
  overwritten. Failures are classified — **asset missing (404)**, build blocked, network, pnpm missing, timeout, …
  — and are **never retried automatically**; every outcome is a `200` (only a malformed shape is a `400`). The
  plugin manager is looked up **optionally** (never added to `inject`), so a profile without it degrades to a
  structured refusal while the three existing services and every other route stay untouched. **New release step
  (mandatory)**: every release must upload its `npm pack` asset, named exactly
  `dsh-prompt-setting-<version>.tgz`; this package must **not** add `postinstall`/`install` scripts. Contract:
  `CONTRACT.md` §18; measurements: `NOTES.md` §107.

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

- `0.1.0` 是该条目首次声明的版本号（清单当前版本见上方的 `0.1.2` 条目）；发布到 npm 与打 tag 后，
  本节日期即为发布日。
  `0.1.0` was the version this entry first declared (the manifest now carries `0.1.2`, see the entry above);
  once it is published and tagged, this entry's date becomes the release date.
- 变更颗粒度较大：本项目按目标（看板 `g-0xx`）开发，一个目标一个提交，上面的条目对应一组这样的目标。
  Changes are coarse-grained: the project is developed goal by goal (board `g-0xx`), one commit per goal.

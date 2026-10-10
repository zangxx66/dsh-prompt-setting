# NOTES — 阶段一 A 决策记录与探针实现

目标：`g-002`，attempt `att-001`，基线 `4613362`（集成分支 `v0.1.0-test`）。
本文件记录**为什么这么做**、**primitives 探针怎么判定**、**哪些还没验证**。

---

## 1. 包名取舍：`dsh-prompt-setting`（裸包名）

`package.json` 的 `name` 用裸包名而非 `@local/...`，理由：

- 本仓库目标是**可独立 npm 发布**，`@local/` 是脚手架模板（`templates/decoration`）用的私有前缀，发布时会绑定 scope；
- profile 内现有第三方 bundle（`dsh-graph`、`dsh-meme`）都是裸包名，安装形态一致；
- **客户端模块 id 必须等于包名**——`window.__ModuleLoader__.load({ id })` 与
  client-modules 生成的 `/plugins/<name>/client.js` 按包名对齐（`dsh-graph` 的 patch 注释明写了这一点）。
  用裸包名可以避免 scope 里的 `/` 混进模块 id 与 URL。

若将来发布到 npm 发现 `dsh-prompt-setting` 被占用，改名时**三处必须同步**：
`package.json.name`、`client.js` 里的 `load({ id })`、`cordis.patch.yml` 的 `name`。

## 2. `cordis.patch.yml` 只写**一条** `insert` 行（与 brief 建议的差异，已确认）

brief 建议「声明宿主行与客户端行（行 `id` 建议 `prompt-setting` / `prompt-setting-ui`）」。
实操后确认**不需要也不能有第二条行**，落地为一条：

```yaml
- insert:
    - id: prompt-setting
      name: dsh-prompt-setting
```

依据（均为只读查阅，未改动对方任何文件）：

| 证据 | 说明 |
| --- | --- |
| `~/.dsh/profiles/web/node_modules/dsh-meme/package.json` + `cordis.patch.yml` | 第三方 bundle，**同为「宿主路由 + 客户端设置栏」形态**，`dsh.client` 与 `exports["./client"]` 齐全，patch 里只有**一条** insert 行 |
| `.../dsh-graph/package.json` + `cordis.patch.yml` | 同一包承载 `graph_*` 工具与浏览器看板，patch 注释原文：「**一条 insert 同时承载两个半边**」 |
| `@deepseek-ai/dsh-web-app/cordis.patch.yml` | 出现两行（`open-in-app` + `ui-open-in-app`）的是「宿主包 + 客户端包」**分离**形态，两个不同包名 |

`dsh.client` 是**包级**声明（client-modules 按 `<name>/package.json` 解析），不是行级声明。
写第二条同名行会让 `index.js` 的 `apply` 跑两次、`/prompt-setting` 前缀重复注册。
故本包为一行；该结论已作为断言固化在 `test/host.test.mjs`（`name:` 出现次数必须为 1）。

## 3. 宿主半：路由、信任栅栏与失败姿态

- **一条 prefix 路由** `/prompt-setting` 持有前缀，内部再分发。阶段一 B/C 的新路由直接加分支，
  不必新增 `ctx.webServer.register` 调用，也就不可能漏掉信任栅栏。
- **信任栅栏**对齐 `dsh-host-open-in-app`（`lib/index.js` 的 `rejected()` + 各路由首行调用）：
  `ctx.connection.requestRejection(req)` → `undefined` 放行，否则按其返回值（`401`/`403`）拒绝并 `res.end()`。
- **顺序**：栅栏 → 路径分发 → 方法校验 → 应答。即**未通过信任检查的请求不会被 405 暴露路由存在性**
  （`test/host.test.mjs` 有断言：POST + 拒绝返回 `401` 而非 `405`）。
- **失败姿态 fail-closed**：`inject: ['webServer','connection']` 已保证 `connection` 存在；
  万一不存在（异常组合），返回 `503 {"code":"trust-fence-unavailable"}` 而**不是**放行。
  这是有意的：宁可探针不可用，也不要在缺栅栏时提供未鉴权读接口。
- **响应**统一 `content-type: application/json; charset=utf-8` + `cache-control: no-store`。
  探针答案与插件版本是活事实，不该被缓存。
- 前缀下的未知子路径返回 JSON `404 {"code":"not-found"}`，避免落到 shell 的 HTML 兜底页。

## 4. primitives 探针：实现方式与真机判定方法（本阶段关键结论）

**冲突**：`@deepseek-ai/dsh-client-ui-primitives` 在浏览器 seed 模块表里（可免声明 `require`），
但 skill `cordis-plugin-development` 明文要求外部插件**不得引用**它。

**落地**（`client.js`，工厂作用域内，零副作用原则下只做一次 `require` 尝试）：

| 位置 | 内容 |
| --- | --- |
| `client.js` 顶部 `#region primitives probe` | `try { primitivesModule = require('@deepseek-ai/dsh-client-ui-primitives') } catch (error) { primitivesFailure = error.message }`；随后判定 `primitivesUsable = typeof primitives.Button === 'function'` |
| `client.js` `RENDERER` | `primitivesUsable ? 'primitives' : 'fallback'`，模块实例内**固定不变** |
| `client.js` `UI`（`#region fallback atoms` 下方） | `RENDERER === 'primitives'` → 用 `primitives.Button/Input/Tag`；否则用手绘 `FxButton/FxInput/FxTag`（纯 `React.createElement` + `--dsw-alias-*` 变量） |
| `client.js` 页面末尾 | `<div data-renderer="primitives|fallback">`；页脚同时有一行人类可读的 `渲染分支: ...` |
| `client.js` fallback 且 `primitivesFailure` 非空时 | 额外一行把 `require` 的**失败原文**渲染到页面上 |

**真机观测方式（主管负责，无需重建）**：

1. **首选：直接看页面**。ping 响应现在自带 `clientRenderer` / `clientReportedAt`，而占位页本来就把
   原始响应渲染在「原始响应」`<pre>` 区里 —— 页面一加载，裁决结果就在屏幕上，不用控制台、不用 curl。
2. 页脚一行 `渲染分支: primitives（官方基础件）` 或 `fallback（自绘 + 主题变量）`。
3. DevTools 控制台（已带信任 cookie，最省事）：
   ```js
   await (await fetch('/prompt-setting/ping')).json()   // → { ..., clientRenderer, clientReportedAt }
   document.querySelector('[data-plugin="dsh-prompt-setting"] [data-renderer]').dataset.renderer
   ```
   同级的 `data-render-state` 为 `ok` | `error`。
4. 若为 `fallback` 且页面出现 `primitives 不可用原因: ...`，该行即 `require` 抛出的**报错原文**。

> **⚠️ 裸 curl 会被拒绝（401），这是预期，不是缺陷。** 已读源码确认判决链：
> `ctx.connection.requestRejection` = `isTrustedApiRequest`（Host/Origin 栅栏；本机 loopback + 无 Origin → **放行**）
> 之后是 `browserAuth.isAuthenticated`（**cookie 认证**，见
> `@deepseek-ai/dsh-client-connection/lib/index.js` 的 `requestRejection` / `isAuthenticated`）。
> 裸 curl 没有 `dsh-auth-<base64url(sha256(authority))>` cookie，故 **401**。
> 本插件**没有**为了 curl 便利削弱栅栏 —— 判据 2 明确要求「缺失浏览器信任标记的请求被拒绝」。
> 若确实要用 curl，把浏览器里该域的 cookie 值抄过来：
> ```bash
> # authority = 127.0.0.1:3080 时 cookie 名如下（localhost:3080 的名字不同）
> curl -s -H 'Cookie: dsh-auth-VPhEEcLKeqRDBoBalzN2Nm7CnfxKhLE00pKIDWxt1sw=<从浏览器抄的值>' \
>   'http://127.0.0.1:3080/prompt-setting/ping'
> ```
> 上面的做法 1 / 3 才是真正「一步拿到裁决」的路径。

**已知风险（留给真机裁决）**：`primitives` 的样式是它自己 `lib/**/*.css` 的一部分。
若它是被本插件**首次**引入，样式是否已注入未经证实——页面主体结构用的是本插件自己的内联主题变量，
所以即使 primitives 无样式，页面仍然可读（不会白屏）。这一点请真机确认。

**离线已验证的部分**（`test/client.test.mjs`，在 `node:vm` 里跑真实 `client.js`）：
`require` 抛错 → 渲染出 `data-renderer="fallback"` 且页面含失败原因；`require` 成功 → `data-renderer="primitives"`。

## 5. 客户端半的其它决策

- **免构建**：`require('react')` 取 seed 模块，`React.useSyncExternalStore` 订阅 `ctx.locale` 以切换 zh/en；
  `exports["./client"]` 写字符串 `"./client.js"`（brief 确认客户端半只认 string 或 `{default}`）。
- **i18n**：字典是 `client.js` 内联常量（`zh` / `en`），经 `ctx.locale.register(NS, { zh, en })` 注册，
  `NS = 'settings.promptSetting'`；导航标签用 `label: () => t('nav')` 由注册方本地化，
  组件从 `locale` seat 拿到框架合成的 `t`，**无硬编码文案**（`test/client.test.mjs` 断言 zh/en 键集一致且 `nav` 不同）。
- **`order: 30`**：既有设置栏为 `account -10 / general 0 / models 10 / plugins 15 / agent-presets 20`，
  取 30 追加在末尾，不与任何既有项冲突（数字来源为各包 `lib/client.js` 的注册调用）。
- **不改 shell**：导航与路由由 shell 拥有，本包只 `ctx.slots.inject('settings.section', ...)`。
- **`dsh.client.inject`**：`[client-runtime, client-connection, client-locale, ui-settings]`
  —— 对齐 `dsh-meme`（runtime/connection/ui-settings）与 `dsh-client-ui-settings-plugins`
  （locale/ui-settings）的并集。未加 `immediately`：同形态的 `dsh-meme`、`dsh-client-ui-settings-plugins`
  都没有它，settings 栏照常出现。
- **`dependencies` 为空对象、无 devDependencies**：测试只用 `node:test` / `node:vm` 内置能力。
- **`peerDependencies`**：`@deepseek-ai/dsh: ">=0.1.7-rc.2 <0.1.8-0"`，并置 `peerDependenciesMeta.optional = true`
  （`dsh-graph` 同做法），避免本地目录安装时因解析不到该包而告警。
- **未使用 `dsh-api-remotes` / typert Remote**：按 brief，外部 bundle 新增命名空间走不通，客户端一律裸 `fetch('/prompt-setting/...')`。

## 6. 自测证据（原始输出摘要，均在工作树内执行）

| # | 命令 | 结论 |
| --- | --- | --- |
| 1 | `node --check index.js` | exit 0 |
| 2 | `node --check client.js` | exit 0 |
| 3 | `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` | `package.json ok`，exit 0 |
| 4 | `node --test` | `tests 31 / pass 31 / fail 0`，exit 0（复核前为 20/20；新增 11 项覆盖 locale 退化与 renderer 上报） |
| 5 | `npm_config_cache=/tmp/g002-npm-cache npm pack --dry-run` | `total files: 6`——`README.md / NOTES.md / client.js / cordis.patch.yml / index.js / package.json`；**无** `.dsh-graph`、`node_modules`、`.worktrees`、`test/` |
| 6 | `node -e` 调 profile 内 `yaml@2.9.1` 解析 `cordis.patch.yml` | `STRUCTURE_OK: true`（顶层数组、1 条 insert、`id/name` 与 `package.json.name` 一致） |
| 7 | 负向对照 A（在 `/tmp` 副本上改坏 3 处后重跑） | `pass 14 / fail 6`：分别命中 405 守卫、信任栅栏、primitives 降级三组断言 → 测试确实「改坏就会红」 |
| 8 | `find <DSH 全局安装>/node_modules -newermt "2026-09-28 18:40" \| wc -l` | `0` —— 安装包内无任何文件在本次 attempt 期间被改动 |
| 9 | `find ~/.dsh/profiles/web -newermt "2026-09-28 18:40" \| wc -l` | `0` —— profile 内无任何文件被改动（其 mtime 均为 17:42–17:43，早于本次开工） |
| 10 | 负向对照 B（复核后新增，逐条单独改坏） | NC-A 去掉白名单 → `fail 2`（非法枚举两条）；NC-B 去掉 locale 守卫 → `fail 3`（退化三条）；NC-C 去掉渲染 try/catch → `fail 1`（失败卡片）——**三处均精确命中预期断言** |

> 第 5 项命令需带 `npm_config_cache`：本机 `~/.npm/_logs` 不可写，npm 会因此直接报错退出；
> 这与包内容无关。第 7、10 项的 `/tmp` 副本均已删除，工作树未受污染。

## 7. 未验证项（诚实清单，交给主管在集成检查点裁决）

1. **`require('@deepseek-ai/dsh-client-ui-primitives')` 在真实浏览器里成功还是失败** —— 阶段一 A 的
   核心待判定项。代码两条分支都已落地并离线验证；真机**打开设置页即可裁决**——ping 响应自带
   `clientRenderer`，而占位页把原始响应渲染在「原始响应」区，加载完看一眼即得
   `primitives` / `fallback` / `null`（§9.2；**裸 curl 会 401，取不到这条数据**）。
   `null` 表示浏览器从未上报（页面没挂载或 fetch 未发出），本身也是有效信号。
2. **primitives 的 CSS 是否随本插件首次 require 注入** —— 见 §4「已知风险」，可能表现为「分支为 primitives 但样式简陋」。
3. **设置栏在真实 GUI 中的外观**（列在末尾、深浅色可读性、刷新后仍可见）—— 未跑浏览器，无法断言观感；
   文案与结构已由单测覆盖，视觉层需真机。
4. **zh/en 切换的真实联动** —— 已按框架契约实现（`locale` ns 注册 + `useSyncExternalStore` 订阅
   `ctx.locale`），但未在真机切换 DSH 语言验证。**注：locale 相关 API 的缺失/抛错路径已在复核后加固
   （§9.1），最坏情况退化为「不跟随语言切换」，不会白屏——行为本身仍待真机确认。**
5. **`plugin_manager install_bundle` 安装结果与 `cordis_inspect_query` 挂载确认** —— 按 brief
   由主管在集成检查点执行，本 attempt **未安装、未重启**。
6. **`ctx.locale.subscribe` / `getSnapshot().revision` 的返回契约** —— 依据
   `dsh-client-ui-settings-plugins/lib/client.js`（`ctx.locale.subscribe(listener)` 返回退订函数、
   `ctx.locale.getSnapshot().revision`）与 `dsh-client-ui-slots/lib/types/index.d.ts` 推断，
   未经运行态确认。**当前状态：已防御（缺失 → no-op 退订 / 0；抛错 → 同样退化），
   即契约不成立也不会白屏，仅失去语言热切换；真实行为仍待真机确认。**
7. **prefix 路由收到的 `req.url` 是完整路径** —— 依据 `dsh-host-open-in-app/lib/index.js` 前缀路由里
   手工 `slice(prefixLength)` 推断，未在运行态确认；若实际是被裁剪过的剩余路径，
   `/prompt-setting/ping` 会落到 404 分支（现象明确、易修）。**新增依赖同一条推断的是
   `?renderer=` 查询串的可见性（§9.2）：若 `req.url` 被裁剪，上报会失效但探针本身仍 200，
   表现是 `clientRenderer` 恒为 `null`。**
8. **上报的 `clientRenderer` 在重启后归零** —— 按设计存内存不落盘，重启即 `null`（§9.2）。

## 8. 本 attempt 明确**没有**做的事

- 未 `plugin_manager` 安装进 profile，未重启 `dsh web`；
- 未修改 DSH 全局安装包内任何文件（所有查阅均为只读 `cat`/`grep`/`sed -n`）；
- 未手工编辑 `~/.dsh/profiles/web/` 下任何文件；
- 未写 `.dsh-graph/` 下任何数据；
- 未在 worktree 之外产生任何代码改动（含主工作树）；
- 未自行 `git worktree add` / `branch` / `checkout` / `merge`；
- 未削弱信任栅栏去迎合「裸 curl 一步取数」（见 §9.2 末尾的取舍说明）。

## 9. 复核后修订（第二个 commit）

主管复核提出两处必修；两处均已落地，`node --test` 从 20 项增至 31 项且全绿。

### 9.1 设置页白屏风险（blocker）—— locale 读取全面守卫

**原因**：`face` 直接解引用 `ctx.locale.subscribe` / `ctx.locale.getSnapshot().revision`，
而 `React.useSyncExternalStore` 会在**挂载期**调用它们；这两个 API 的真实契约在 §7.6 自列为未验证。
渲染期异常会被 React 卸载整棵子树 ⇒ 设置页白屏，直接违反判据 3。

**改法**（`client.js`）：

| # | 位置 | 内容 |
| --- | --- | --- |
| 1 | `apply()` 内 `const t = ...` / `ctx.effect(...)` | `locale.bind` / `locale.register` 也加 `typeof === 'function'` 守卫，缺则退化为 `(key) => key` / 不注册字典 |
| 2 | `apply()` 内 `canSubscribe` / `canReadRevision` | 先探测方法是否存在，缺则分别退回既有的 `noopSubscribe` / `zeroRevision` |
| 3 | `face.subscribeLocale` | 内部 `try/catch`：抛错时返回 no-op 退订函数，异常**不外溢到渲染期** |
| 4 | `face.getLocaleRevision` | 同样 `try/catch`，并加 `?? zeroRevision()`，`getSnapshot()` 缺 `revision` 时不返回 `undefined` |
| 5 | `PromptSettingSection`（hooks 之后） | `try { return renderSection(...) } catch (error) { return renderFailureCard(t, error) }`；**hooks 全在 `try` 之外**，调用顺序恒定 |
| 6 | 新增 `renderSection(t, probe, setAttempt)` | 原页面树整体搬入，仍在同一个 `try` 内构建 |
| 7 | 新增 `renderFailureCard(t, error)` + `safeT(...)` | 失败卡片带 `data-plugin` / `data-renderer` / `data-render-state="error"` 与错误原文；文案经 `safeT`，**`t` 本身炸掉也能渲染** |
| 8 | 页面根 div | 新增 `data-render-state="ok"`，与失败卡片的 `error` 对称，便于机器区分 |

**新增断言**（`test/client.test.mjs`，`LOCALE_SHAPES = full / bare / throwing / noRevision`）：
`inject face never throws`（每种形态下 `subscribeLocale` 返回函数、`getLocaleRevision` 返回 number）、
`a degraded locale seat still renders the page, never a blank`（四种形态都渲出 `data-renderer="fallback"` 且 `data-render-state="ok"`）、
`a missing locale seat entirely still renders the page`、
`a throw while building the tree renders a failure card, not a blank`。
为让这些用例真正承重，测试里的 `useSyncExternalStore` 桩改为**真调用** `subscribe()` 与 `getSnapshot()`
（对齐 React 挂载行为），否则守卫根本不会被走到。

**负向对照 NC-B**：去掉第 2/3/4 项守卫 → 上述 3 项断言转红。

### 9.2 primitives 裁决的机器可读通道（major）—— 同一次请求自带上报

**改法**（不新增路由、不做 POST、不落盘）：

| 半边 | 位置 | 内容 |
| --- | --- | --- |
| 客户端 | `client.js` 探针 `useEffect` | fetch 改为 `` `${PING_PATH}?renderer=${RENDERER}` `` —— **同一次探针请求顺带上报**，不新增请求 |
| 宿主 | `index.js` `CLIENT_RENDERERS` | `new Set(['primitives', 'fallback'])` 白名单 |
| 宿主 | `index.js` `recordClientRenderer(report, url)` | 取 `searchParams.get('renderer')`；`null` 或不在白名单 → **直接返回，不改任何状态** |
| 宿主 | `index.js` `apply()` | `const report = { renderer: null, reportedAt: null }`——**per-mount 闭包内存**，非模块级、**不落盘**；放在 `apply` 内而非模块顶层，使两次挂载（或两个测试用例）互不串扰 |
| 宿主 | `index.js` ping 响应 | 追加 `clientRenderer`（`null` 或枚举值）与 `clientReportedAt`（`null` 或 ISO） |
| 宿主 | 顺序 | 上报发生在**信任栅栏之后、方法校验之后**：非 GET 与未过栅栏的请求都不会写入 |

**新增断言**：`no client report yet reads as null`、`a legal renderer report is recorded and echoed`
（并验证后续 ping 仍读到同一 `clientReportedAt`）、`an illegal renderer report is ignored and the probe still answers 200`
（`../../etc/passwd` / `1` / `true` / `PRIMITIVES` / `primitives,fallback` / `\u0000` / 空值共 7 例，均 200 且 `clientRenderer` 保持 `null`）、
`an illegal report cannot overwrite a recorded one`、`a non-GET request never records a report`、
`a rejected request never records a report`；客户端侧 `the probe request reports the active renderer`
（断言 URL 精确等于 `/prompt-setting/ping?renderer=fallback` 与 `...=primitives`）。

**负向对照 NC-A**：去掉白名单（`|| !CLIENT_RENDERERS.has(reported)`）→ 非法枚举 2 项断言转红。

**取舍（需你知情）**：`requestRejection` 的第二段是 **cookie 认证**（源码：
`@deepseek-ai/dsh-client-connection/lib/index.js` 的 `requestRejection` → `isTrustedApiRequest`(Host/Origin 栅栏) →
`browserAuth.isAuthenticated`(cookie)）。因此**裸 `curl` 取数是 401，拿不到 JSON**。
我没有为了「一条 curl」而放宽或旁路栅栏（那会同时违背判据 2）。
等价且更省事的路径见 §4：裁决结果**已经打印在页面自己的「原始响应」区**，
或在已带 cookie 的页面控制台里 `await (await fetch('/prompt-setting/ping')).json()`。

---

# NOTES 阶段一 B — 装配快照 + 覆盖引擎 + 两层持久化

本篇接在阶段一 A 记录（§1–§9）之后。阶段一 A 的结论与决策仍然有效；下面是**阶段一 B 新增**
的设计取舍、实测结论与证据。REST 契约已冻结在 [`CONTRACT.md`](./CONTRACT.md)。

## 10. 分层：把逻辑挤出「必须重启才能验证」的地方

宿主进程的 JS 改动**必须重启 `dsh web`** 才生效（阶段一 A §「改包 JS 实体后必须重启」），
而本 attempt 被明确禁止重启。因此本阶段的形状是：

| 层 | 文件 | 是否可离线验证 |
| --- | --- | --- |
| 纯函数内核 | `core/overrides.js` | ✅ 零 IO、零 `ctx`，单测直接测 |
| 持久化 | `core/store.js` | ✅ 唯一碰 FS 的模块，临时目录单测 |
| 薄适配层 | `index.js` | ✅ 用「复刻真语义的假 Host」+ 真包真 Cordis 上下文两条路测 |
| UI | `client.js` | ❌ 阶段一 C 才改，本阶段**未动** |

`node --test` 覆盖了宿主面的全部行为（栅栏、405/404、两层、frozen、全部 4xx），
所以「没重启」不影响本轮判据 1/2/4/6/7 的机器证据；只有「真机上插件被禁用后覆盖是否失效」
（判据 8 / E5）留给集成检查点。

## 11. 关键设计决策（含与 brief / goal.md 的差异及理由）

### 11.1 `complete` 冻结检测：从「启发式」升级为「探针」（本阶段最重要的一处偏离）

goal.md 原定规则是：「`assemble()` 返回 1 段而我们的覆盖意图有多段 ⇒ frozen」。
**实测这条规则有一个无法覆盖的形状**：若某 scope 只注册了一段且它就是 `complete: true`，
那么有覆盖、无覆盖、任何配置，`assemble()` 都返回**与输入完全相同的那一段**——
外部观察者**无法区分**「该段是 complete 并被恢复」与「该 scope 本来就只有这一段」。

改法：快照时多跑**一次**装配探针，配置里只放一条
`append __dsh-prompt-setting-probe__`（一个真实用户配置绝不会包含的段名）：

| 观察 | 结论 |
| --- | --- |
| 探针段**出现在**结果里且段数 = 注册段数 + 1 | 没有 complete 段 ⇒ `complete: false`（**可证**，非猜测） |
| 探针段**消失**，结果只剩 1 段 | 该 scope 的 sections 在 waterfall 之后被整体替换为那一段 ⇒ `frozen:true`、`frozenSection` = 那一段 |
| 探针段消失，结果 0 段或 >1 段 | 同样被替换，但无法指出是哪一段 ⇒ `frozen:true`、`frozenSection:null` |
| 探针段在、但段数与注册数不符 | 装配管线改动了段列表 ⇒ `frozen:true` |
| 探针段名被真实段占用（病态） | 探针不可用，回退到「两次探针互比」 |

优点：对**任何** scope 形状都成立，且**不依赖用户是否配了覆盖**——用户打开设置页就能看到
「这个 scope 是冻结的」，这正是判据 3 要的「绝不能静默失败」。
代价：快照从 1 次 `assemble()` 变成 2 次（探针 + 真实配置）。快照是按需的 UI 路由，
不在一轮对话的路径上，这个代价可以接受，已写进 CONTRACT.md §2.6。

另有两条**辅助**信号保留：探针之外，还会比较「我们交给下游的 sections」与「最终返回的
sections」，若我们的改动没留下痕迹，也会报 frozen，并把原因写成
「你的覆盖被丢弃」而不是「该 scope 被冻结」——两者语义不同，不该混为一谈。

### 11.2 真实回合的工作区层：`context.agent.id`（brief 未提，实测得出）

brief 要求「装配路径零 IO」，同时要求工作区层按 session 解析。这两条看似冲突：
`AssembleContext` 只声明了 `scope` / `signal`，监听器怎么知道自己在为哪个 session 装配？

实测答案（读 `dsh-agent/lib/index.js:291` + `dsh-agent-loop/lib/index.js:907`）：

```js
function assembleContextFor(agent, signal) { return { agent, scope: agent, ...(signal ? {signal} : {}) }; }
// 调用点：this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
```

即真实回合传的是 `{ agent, scope: agent }`，**scope key 就是 Agent 对象本身**
（`dsh-agent` 的 `scopeTarget(agent, agent)`），而 `Agent.id` 就是 `SessionId`
（`dsh-agent/lib/types/types.d.ts`：`interface Agent { readonly id: SessionId }`）。

⇒ 监听器用 `context.agent.id`（回退 `context.scope.id`）在**内存里**查
`workspaceRegistry.list()` 的投影，选到工作区层，**零 IO**。
这在 `test/route.test.mjs` 与 `test/integration.test.mjs` 都有断言
（同一份装配服务，两个 session 命中两个不同工作区的覆盖）。

### 11.3 快照探针怎么把「某个 session 的配置」喂进无 scope 装配

快照描述的是**无 scope 的全局装配**（brief 规定；agent-scoped 段不在首版范围），
但 `?session=` 又要决定工作区层。做法：探针前在内存里放一个**一次性**的 resolved 配置，
监听器在无 scope 装配时取用并立刻消费掉。

**没有**用「塞自定义字段进 `AssembleContext`」：brief 明确禁止，且 `AssembleContext` 只有
`scope`/`signal`。也**没有**用 `signal` 当关联令牌（虽然它是已声明字段）——那是滥用。
`scope === undefined` ⇒ 全局槽位；真实回合都有 scope，两者天然不会互相污染。

监听器在**同步阶段**就记录 observation 并消费一次性配置（`await next()` 之前），
所以探针与自身观察之间不存在可交错的窗口。

### 11.4 监听器是 async 且**始终调用 `next()`**

`system-prompt/assemble` 是 waterfall：不调用 `next()` 的监听器会**否决它之后的所有监听器**。
本插件因此先 `await next()` 拿到下游结果，再在下游结果之上应用自己的覆盖——
既不否决任何插件，又保证覆盖生效（`next()` 在 cordis 里不接收新实参，无法把改过的 assembly
传下去，所以「后置应用」是唯一可行且不越权的语义）。

副作用：没有覆盖时直接 `return downstream`，即**按同一对象引用**返回，
满足判据 2 的「无覆盖配置时装配结果与默认逐字节一致」（内核单测用 `assert.equal(result.sections, input)`
把这条钉死）。

### 11.5 `order` 一律用数组下标

同 brief / goal.md：`AssembledSection` 不含 `order`，`getSectionOrder()` 只认闭集枚举，
第三方段名取不到 ⇒ 快照只给 `index`（数组位置），`append` 的 `order` 解释为**目标下标**
（越界夹取到 `[0, length]`）。**绝不伪造 order**。

### 11.6 `rendered` 的插值差异（已写进契约，不藏）

`renderPrompt` 对未知/畸形 `{{变量}}` **抛错**，而快照是只读视图、绝不能因为某段 provenance
文本里有个 `{{` 就整页报错；同时本插件**不能** import 那个渲染器（linked 插件包里解析不到
`@deepseek-ai/dsh-system-prompt`，静态 import 会直接起不来）。所以 `renderSections` 自己实现
「已知变量替换、未知引用保留字面量」，差异在 CONTRACT.md §2.3 / §7.1 明写。

### 11.7 两层写入失败姿态：宁可拒绝，不可覆盖

层文件存在但非法（坏 JSON / schema 不符）时：

- **读**：该层 `enabled:false` + `reason`（结构化 code + 原文），装配照常，用户层不受工作区层影响；
- **写**：`409 layer-not-writable`，**不覆盖**原文件（否则等于静默毁掉用户数据）。

工作区解析不到（没有 `session` / 该 session 不属于任何工作区）时同样拒绝（`400 workspace-unresolved`），
**不回退**到任何猜测路径。

### 11.8 快照=全局装配（brief 规定，如实标注）

`assemble()` 无 scope 调用是被全局注册的 section 的基座 prompt。带 scope 的真实回合可能还有
agent-scoped 段，因此快照的 `base`/`effective` 段数可能**少于**某个具体回合。
CONTRACT.md §5.8 / §7.2 明写。监听器本身对 scope 是正确的（每个 scope 都应用）。

## 12. 自测证据（工作树内执行，均为单行结构化概要）

```
evidence: suite=overrides passed=27 failed=0 skipped=0 exit=0 ms=119 diff=12f/+3665/-64 commit=bfc9269
evidence: suite=store passed=10 failed=0 skipped=0 exit=0 ms=115 diff=12f/+3665/-64 commit=bfc9269
evidence: suite=route passed=28 failed=0 skipped=0 exit=0 ms=166 diff=12f/+3665/-64 commit=bfc9269
evidence: suite=host passed=19 failed=0 skipped=0 exit=0 ms=130 diff=12f/+3665/-64 commit=bfc9269
evidence: suite=integration passed=6 failed=0 skipped=0 exit=0 ms=167 diff=12f/+3665/-64 commit=bfc9269
evidence: suite=client passed=13 failed=0 skipped=0 exit=0 ms=172 diff=0f/+0/-0 commit=bfc9269
evidence: suite=all passed=103 failed=0 skipped=0 exit=0 ms=375 diff=12f/+3665/-64 commit=bfc9269
evidence: suite=node-check passed=11 failed=0 skipped=0 exit=0 ms=410 diff=0f/+0/-0 commit=bfc9269
evidence: suite=npm-pack passed=10 failed=0 skipped=0 exit=0 ms=900 diff=0f/+0/-0 commit=bfc9269
```

`diff=12f/+3665/-64` 是相对权威基线 `23b344c`（集成分支 `v0.1.0-test`）的 `git diff --cached --shortstat`，
含新增的 `core/`、`CONTRACT.md` 与 5 个测试文件；`node-check` 一行的 `passed=11` 是
`index.js` / `core/*.js` / `client.js` / `test/*.test.mjs` 的 `node --check` 全部 exit 0；
`npm-pack` 一行的 `passed=10` 是 tarball 条目数（全部为预期条目，见下）。

- **`integration` 是 `pass 6 / skipped 0`，不是 skip**——本机真包解析成功
  （`@deepseek-ai/dsh-system-prompt@0.1.7-rc.2` + `@deepseek-ai/cordis@4.0.4` + `@deepseek-ai/dsh-scope`，
  从 pnpm 全局 store 的 `@deepseek-ai+dsh-web-app@0.1.7-rc.2` 锚点解析）。无 DSH 的机器上该套件才 skip。
- `node --test` 的 5 个套件、103 项断言：**无 skip、无 fail**。
- `npm_config_cache=/tmp/npm-cache-probe npm pack --dry-run` → `total files: 10`：
  `CONTRACT.md / NOTES.md / README.md / client.js / cordis.patch.yml / core/{experiments,overrides,store}.js / index.js / package.json`。
  **无** `test/`、`.dsh-graph/`、`node_modules/`、`.worktrees/`。
- `node --check` 通过：`index.js` / `core/overrides.js` / `core/store.js` / `core/experiments.js` / `client.js`。

## 13. 负向对照（逐条单独改坏源码 → 重跑全量）

每条都是「只改一处、跑完立刻还原」，还原后由 `diff` 确认源码逐字节回到备份。

| # | 改坏点 | 结果 | 变红的用例（对应关系） |
| --- | --- | --- | --- |
| NC-1 | `mergeLayers` 不再遍历工作区层（`for (const override of [])`）⇒ 去掉两层优先级 | `fail 8` | `mergeLayers: workspace wins a name clash…`、`mergeLayers: a single layer, and no layers at all`、`snapshot: the workspace layer is applied…`、`snapshot: replace, hide and append…`、`snapshot: the workspace layer overrides the user layer…`、`snapshot: a complete section is reported as frozen…`、`overrides GET: both layers plus the merged list`、`assembly: a real scoped turn resolves its workspace layer…` |
| NC-2 | `detectFrozen` 恒返回 `{frozen:false,…}` ⇒ 去掉 complete 检测 | `fail 9` | `integration: a real complete section is reported as frozen through the real routes`（**真包真路由**）、`detectFrozen: a missing probe section…`、`detectFrozen: a scope whose only section is complete…`、`detectFrozen: the probe controls its own section list…`、`detectFrozen: a surviving probe whose list size still changed…`、`detectFrozen: a probe section that cannot be appended…`、`snapshot: a complete section is reported as frozen…`、`snapshot: a scope whose only section is complete…`、`snapshot: sections missing from the render…` |
| NC-3 | `core/store.js` 把「临时文件 + `rename`」换成就地 `writeFileSync(path, …)` ⇒ 去掉原子写 | `fail 1` | `writeConfig: replacement is atomic — the old file survives under a hard link` |
| NC-4 | `applyOverrides` 在无覆盖时返回 `input.slice()` 而非 `input` ⇒ 去掉零差异恒等保证 | `fail 1` | `applyOverrides: no overrides returns the input array BY IDENTITY (zero-diff guarantee)` |

NC-3 的判别方式是**硬链接见证**：先用 `writeConfig` 写一次，`linkSync` 出一个别名（共享 inode），
再写第二次。`rename` 换掉目录项 ⇒ 别名仍读得到**旧**内容；就地 `writeFile` 会改写同一 inode
⇒ 别名读到**新**内容。同一条用例还断言 inode 变化，所以「原子写」不是靠注释声明的，是被证伪过的。

## 14. E1–E4 实测结论（真包 + 真 Cordis 上下文）

结论文案与 `core/experiments.js` / 快照 `experiments` 字段 / CONTRACT.md §6 **同源**，此处给要点：

- **E1**：`assemble()` 无参合法；返回全局注册段且**已按 canonical 顺序排好**
  （`harness:identity` → `deployment:persona-prefix` → 自定义段按 order → `deployment:persona-suffix`）；
  每个段只有 `{name, text}`，**没有 `order`、没有 `complete`** ⇒ 位置即顺序，取不到就返回 `null`/不下标。
- **E2**：`system-prompt/assemble` 是**最外层优先**的 waterfall；`next()` 解析下游值；
  **不调用 `next()` 的监听器否决其后全部监听器**，其返回值即权威；
  监听器可以 `await next()` 后变换下游结果（本插件正是这么做的）。实测 trace：`outer:in → inner:in → inner:out → outer:out`。
- **E3**：注册 `complete:true` 段后，**整个 scope 的 sections 在 waterfall 之后被替换为那一段**，
  且用的是**注册时的原始文本**——监听器把该段改写成 `HACKED` 也被回滚成原文；
  监听器对**其它段的增删同样全部无效**；对照组（无 complete 段）同样的改动则生效。
  ⇒ `complete` 不是「那段不可改」，是「整个 scope 被推翻」。
- **E4**：同名 scoped 段在**该 scope 内**遮蔽全局段，全局视图不变；
  **注册在根上下文的监听器会收到 scoped 派发**（`scopeTarget` 的过滤对无 tag 监听器返回 true），
  这既是快照 `mounted` 可观测的前提，也解释了为什么本插件的监听器能统管所有 scope。
- **E5**（推断，非实测）：插件被禁用/卸载时路由与监听器一起注销，UI 观察到的是**接口不可达**，
  而不是 `mounted:false`。`mounted` 字段本身已实现并在快照里如实反映（只在监听器真的观察到探针时为 `true`）。
  真机禁用后行为留给集成检查点。

## 15. 未验证项（诚实清单，交给主管在集成检查点裁决）

1. **真机上插件的 `systemPrompt` 硬依赖能否解析**：`inject` 从 `['webServer','connection']`
   变为 `['webServer','connection','systemPrompt']`。若 profile 里 `dsh-system-prompt` 未激活，
   **本插件会整体不加载**（这正是硬依赖的语义，也是 brief 的要求）。本 attempt **未安装、未重启**，
   真机挂载由主管在集成检查点确认。
2. **禁用/卸载后覆盖失效与 `mounted:false` 的可观测性（E5）**——见 §14 E5，仅推断。
3. **真实回合里工作区层的端到端生效**：`context.agent.id` 的解析依据是 `dsh-agent` 源码
   （`assembleContextFor`）+ 类型声明（`Agent.id: SessionId`），并已在真 Cordis 上下文里
   用同一份真装配服务断言过；但**没有**在一个真实 DSH 回合里观察过覆盖生效。
   （按判据 6「保存后在下一个会话/下一轮生效」，这需要真机。）
4. **`ctx.workspaceRegistry.list()` 的投影实时性**：工作区在挂载后才创建时，
   在下次路由请求刷新缓存前不贡献覆盖（CONTRACT.md §7.3）。真机多工作区场景未验证。

   > **Revision 5 校正（本行原文保留，措辞已过时）**：刷新现在发生在**每个被处理请求的开头**
   > （不再是「某个路由恰好需要工作区层时」），所以「挂载后新建的工作区」在**下一次请求**
   > 就会被读到。原表述里仍然成立的两点是：**注册表尚未列出的工作区不可见**，以及
   > **绝不请求中途重读、绝不在装配路径上重读**。工作区投影本身的真机实时性仍属未验证。
   > 见 §65、§68 与 CONTRACT §5.5 / §7.3。
5. **快照 = 无 scope 全局装配 vs 某个 agent-scoped 真实回合的段数差异**（§11.8）——
   差异的存在是设计使然，但**具体差多少**未在真机测过。
6. **`rendered` 与真实回合 prompt 的逐字节相等性**：仅在「文本里不含未知 `{{变量}}`」时成立
   （§11.6）。真实 preset 文本是否含 `{{`，未逐一检查。
7. **客户端 UI**：本阶段**未动** `client.js`，所以设置页仍只显示 ping 探针；
   快照/覆盖的界面呈现是阶段一 C。

## 16. 本 attempt 明确**没有**做的事

- 未 `plugin_manager` 安装进 profile，未重启 `dsh web`（集成检查点由主管做）；
- 未修改 DSH 全局安装包内任何文件（所有查阅均为只读 `cat`/`grep`/`sed -n`/`node --check`）；
- 未手工编辑 `~/.dsh/profiles/web/` 下任何文件；
- 未写 `.dsh-graph/` 下任何数据（看板数据只由 `graph_*` 工具写主工作树）；
- 未改 `client.js`（阶段一 C 才动 UI）；
- 未引入任何运行时依赖（`dependencies` 仍为 `{}`）、未引入构建步骤；
- 未在 worktree 之外产生任何代码改动；
- 未自行 `git worktree add` / `branch` / `checkout` / `merge`（只在本 worktree 内 `git add` / `commit`）；
- 未使用 `configEditor` 服务（它会把配置写回 profile，违反本项目硬约束）。

## 17. 未改动外部文件的取证

以本 attempt 开工时刻（2026-09-28 19:05）为界：

```
find /Users/ricardo/.local/share/pnpm/global -newermt "2026-09-28 19:05" -type f | wc -l   → 0
find /Users/ricardo/.dsh/profiles/web    -newermt "2026-09-28 19:05" -type f | wc -l       → 0
find /Users/ricardo/.dsh -maxdepth 2 -newermt "2026-09-28 19:05" | grep -v '/storages' | grep -v '/sessions/'  → 空
```

唯一在开工后变化的是 `~/.dsh/storages` 与 `~/.dsh/sessions/…`——那是**正在运行的
`dsh web` 进程在记录本次会话**（harness 自己写的），不是本 attempt 的插件改动。

> 以 19:00 为界会看到 `~/.dsh/profiles/web/package.json` 等 7 个文件在 **19:02** 被改，
> 那是**上一阶段（g-002）的集成检查点**（主管执行 `plugin_manager install_bundle`，
> 把 `dsh-prompt-setting` 以 `link:` 指向主工作树包目录）留下的，早于本次开工（19:04 建 worktree）。
> 本 attempt 与它无关，也没有对它做任何后续改动。

---

# NOTES 阶段一 B · 复核后修订（第二个提交轮）

主管复核独立复跑确认了 103/103 证据属实，同时指出两处缺陷（**同一根因：探针没有对准
目标作用域/调用者**）。两处均已修复，测试从 103 项增至 113 项且全绿（集成套件
`pass 10 / skipped 0`）。本节记录缺陷、修复与回归证据。

## 18. D1 — 探针用错了作用域（会让我自己提议的真机验收点失败）

**缺陷**：`probe()` 调的是**无参** `assemble()`，所以快照的 `frozen` / `frozenSection` /
每段 `overridable` 描述的是**全局作用域**，不是 `?session=` 那个会话的作用域。

**为什么这是致命的**：`complete` 是**按 scope 生效**的（`ScopedLayers.merge` 沿
`scopeChainOf` 的父链合并，最近的作用域最后覆盖）。本机 `liangshen` preset 把
`{complete:true}` 注册在 **preset 的 standing scope** 上，会话通过
`createScope(ctx, agent, { parent: presetKey })` 挂在它下面；**全局作用域根本没有 complete 段**。
于是 `/snapshot?session=<liangshen 会话>` 会报 `frozen:false` 并把改不动的段标成
`overridable:true` ⇒ UI（g-004）允许编辑一个改不动的段 —— 正是本项目最不能出的错。

**修复**（`index.js`）：

| # | 位置 | 内容 |
| --- | --- | --- |
| 1 | 模块级 `export const PROBE_SCOPE = Object.freeze({})` | 本插件**私有**的探针 scope：没有任何 scoped 注册 ⇒ 解析结果与全局装配一致，但它是**只有本模块能持有**的对象 |
| 2 | `agentsService()` / `agentFor(sessionId)` | `ctx.get('agents')`（Service 键 `agents`，`AgentRegistry.get(id) → this.store.get(id)?.agent`，见 `dsh-agent/lib/index.js:594`）可选获取 |
| 3 | `probeTarget(sessionId)` | 有 session 且有活跃 agent ⇒ `{scope: agent, agent, frozenScope:'session'}`；无 session ⇒ `{scope: PROBE_SCOPE, frozenScope:'global'}`；**有 session 但 agent 不活跃** ⇒ 用 `PROBE_SCOPE` 但 `frozenScope:'global'` **且 `frozenScopeReason` 明说**「该会话的 agent 不活跃，本判定描述的是无作用域装配，该会话作用域里注册的 complete 段在这里看不到」 |
| 4 | `probe({scope, agent, resolved})` | `const context = agent === undefined ? { scope } : { agent, scope }`，然后 `ctx.systemPrompt.assemble(context)` —— 与真实回合 `assembleContextFor(agent, signal)` 的 `{agent, scope: agent}` **同形**（差别只在没有 `signal`，见 CONTRACT §7.6） |
| 5 | 响应 | 新增 `frozenScope: "session" \| "global"` 与 `frozenScopeReason: string \| null`；`records` 的 key 改用探针实际使用的 scope 对象 |

**为什么必须新增字段而不是「猜」**：同一个 mount 对 liangshen 会话必须报 `frozen:true`，
对全局视图必须报 `frozen:false`。只给一个 `frozen` 而不说它描述哪个作用域，
调用方无法判断该不该禁用编辑 —— 那还是静默失败。

## 19. D2 — one-shot 用哨兵值匹配 ⇒ 可能污染别的调用者

**缺陷**：`state.oneShot` 的消费条件是 `scopeKeyOf(context) === GLOBAL_SCOPE`，而
`GLOBAL_SCOPE` 是「**所有** scope 为 undefined/null 的装配」共用的哨兵值。
若在探针的窗口内（section text provider 求值期间）其它插件发起一次无作用域
`assemble()`，它会先一步消费掉 one-shot，于是**别人的提示词里被追加了
`__dsh-prompt-setting-probe__`**，同时我们的探针也拿不到观察结果。

**修复**：把匹配键从「作用域值/哨兵」换成**精确的 context 对象同一性**：

```js
state.pendingProbe = { context, resolved };        // context = 本插件自己构造并传给 assemble() 的那个对象
// 消费条件（仍在任何 await 之前同步完成）：
if (state.pendingProbe !== null && context === state.pendingProbe.context) { ... }
```

**为什么不是主管建议的 `{scope, resolved}` + scope 对象同一性**（这是我对建议的一处**收紧**，
理由经实验证伪）：`assemble()` 把调用者传进来的 `context` **原样**交给 waterfall
（`lib/index.js:355`），所以 context 对象的同一性天然可用。而 **scope 对象在同一会话里不是唯一的**：
真实回合传的正是 `{agent, scope: agent}`，`scope` 就是那个 agent 对象本身 ⇒ 探针进行中真实发生的
同一会话回合会命中 `scope === agent` 并消费掉探针配置，**把探针段注入真实回合的提示词**。
负向对照 NC-6 实测复现了这一点（见 §20）。context 对象是**每次调用新建**的，只有本插件能持有，
因此「任何其它调用者都不可能命中」这一目标由它达成，而不是由 scope 达成。

注意监听器的**同步消费语义未变**：`assembleHandler` 在第一个 `await` 之前就完成
observation 记录与 `pendingProbe` 消费，所以探针自身不存在可交错的窗口。

## 20. 复核后的自测证据（工作树内执行）

```
evidence: suite=overrides passed=27 failed=0 skipped=0 exit=0 ms=119 diff=4f/+496/-56 commit=fdb12a5
evidence: suite=store passed=10 failed=0 skipped=0 exit=0 ms=115 diff=4f/+496/-56 commit=fdb12a5
evidence: suite=route passed=34 failed=0 skipped=0 exit=0 ms=178 diff=4f/+496/-56 commit=fdb12a5
evidence: suite=host passed=19 failed=0 skipped=0 exit=0 ms=130 diff=4f/+496/-56 commit=fdb12a5
evidence: suite=client passed=13 failed=0 skipped=0 exit=0 ms=172 diff=0f/+0/-0 commit=fdb12a5
evidence: suite=integration passed=10 failed=0 skipped=0 exit=0 ms=216 diff=4f/+496/-56 commit=fdb12a5
evidence: suite=all passed=113 failed=0 skipped=0 exit=0 ms=416 diff=4f/+496/-56 commit=fdb12a5
evidence: suite=node-check passed=17 failed=0 skipped=0 exit=0 ms=520 diff=0f/+0/-0 commit=fdb12a5
evidence: suite=npm-pack passed=10 failed=0 skipped=0 exit=0 ms=900 diff=0f/+0/-0 commit=fdb12a5
```

`diff=4f/+496/-56` 是**本轮代码/契约/测试改动**相对上一轮提交 `689f754` 的
`git diff --cached --shortstat`（`index.js` / `CONTRACT.md` / `test/route.test.mjs` /
`test/integration.test.mjs` 四个文件）；`NOTES.md` 本身记录在紧随其后的文档提交里，
不计入该数字。`commit=fdb12a5` 即该提交。
集成套件仍是 **`pass 10 / skipped 0`**（真包真 Cordis 上下文）。

## 21. 复核后新增的回归测试与负向对照

新增 6 项路由测试 + 4 项集成测试：

| 测试 | 断言 |
| --- | --- |
| `D1: a complete section registered in the SESSION scope freezes that session, not the global view` | 假 Host 建模 scope 父链：preset scope 注册 `complete:true`，agent scope 挂其下 ⇒ `?session=` 快照 `frozenScope:"session"` / `frozen:true` / `frozenSection:"preset:locked"` / 该会话段全部 `overridable:false` / `base` 含 scoped 段；**同一 mount 无 session 快照** `frozenScope:"global"` / `frozen:false` / `overridable:true` |
| `D1: a session whose agent is not active says so…` | `frozenScope:"global"` + `frozenScopeReason` 匹配 `/no active agent/` 与 `/would not be visible here/` |
| `D1: a profile with no agents service also says so` | `frozenScopeReason` 匹配 `/agents service is not available/` |
| `D2a: a concurrent UNSCOPED assembly cannot steal the probe config` | 探针窗口内并发 `assemble()` ⇒ 其结果**不含** `__dsh-prompt-setting-probe__`，且探针自身观察仍正确 |
| `D2b: a concurrent turn for the SAME agent cannot steal the session probe config` | 并发 `assemble({agent, scope: agent})`（**同一个 scope 对象、新的 context 对象**）⇒ 其结果不含探针段 |
| `D2c: the probe consumes exactly one config, and only for its own context` | 快照之后 `assemble()` 与 `assemble({})` 都拿不到探针配置 |
| `integration D1: a complete section in a PRESET scope freezes its sessions, but not the global view` | **真包**：`createScope(ctx, presetKey)` 注册 `complete:true`，`createScope(ctx, agent, {parent: presetKey})` 挂其下 ⇒ 真 `ScopedLayers` 父链下 `?session=` 报 `frozen:true`，无 session 报 `frozen:false` |
| `integration D1: an inactive session reports frozenScope "global" with a reason` | 真包 + 空 `agents` 服务 |
| `integration D2: a concurrent unscoped assembly during a snapshot is never handed the probe section` | **真包**：包装真 `systemPrompt.assemble` 制造并发窗口 |
| `integration: PROBE_SCOPE resolves exactly the unscoped view…` | `assemble({scope: PROBE_SCOPE})` 与 `assemble()` 的段名与文本逐项一致 ⇒ `base` 视图语义未被破坏 |

**负向对照（逐条单独改坏 → 跑全量 113 项 → 立即还原，`diff` 确认逐字节回滚）**：

| # | 改坏点 | 结果 | 变红用例 |
| --- | --- | --- | --- |
| NC-5 | `probeTarget()` 恒返回全局目标（即**修复前的 D1 行为**：探针永远只看无作用域装配） | `fail 6` | `D1: a complete section registered in the SESSION scope…`、`D1: a session whose agent is not active…`、`D1: a profile with no agents service…`、`integration D1: a complete section in a PRESET scope…`、`integration D1: an inactive session…`、`D2b`（其 `frozenScope:"session"` 断言） |
| NC-6 | 消费条件换成 `scopeKeyOf(context) === scopeKeyOf(pendingProbe.context)`（即主管建议的 scope 对象匹配） | `fail 1` | **仅** `D2b` —— 实测报错正是「真实回合的 sections 里多了 `__dsh-prompt-setting-probe__`」 |
| NC-7 | **两处同时回退到复核前的行为**（探针恒全局 + 消费条件退化为「存在即消费」） | `fail 8` | D1×3、D2a、D2b、integration D1×2、integration D2 ⇒ 证明这 8 项新测试**确实能抓住复核前的那两个缺陷** |

NC-6 只有 1 项变红是**预期且关键**的：它说明「按 scope 匹配」只会在**真实回合共用同一 agent
对象**这一条路径上出事，而 D2b 精确覆盖了这条路径。这也解释了为什么我采用 context 对象
同一性而非 scope 对象同一性。

## 22. 复核后仍未验证项（更新）

1. ~~快照作用域~~ ⇒ 已修，并且**在真 `ScopedLayers` 父链下实测**（`integration D1`）。
   仍未验证的是**真机**上 liangshen 会话的 `?session=` 快照是否为 `frozen:true` —— 需要
   `dsh web` 重启 + 带 cookie 的页面请求，属集成检查点。
2. **`ctx.agents.get(sessionId)` 在真机上的活跃判定**：依据 `dsh-agent` 源码
   （`AgentRegistry.get` → `store.get(id)?.agent`）与真 Cordis 上下文里的假 `agents` 服务断言，
   但**没有**在真机对一个真实会话调用过。若真机上它恒返回 `undefined`，
   行为是 `frozenScope:"global"` + `frozenScopeReason`（安全侧失败，不会把冻结段标成可编辑）。
   **这正是集成检查点要确认的第一件事**：`?session=<当前会话>` 的响应里
   `frozenScope` 应为 `"session"`。
3. 其余未验证项（E5 禁用后行为、真实回合里工作区覆盖生效、挂载后新建工作区、
   `rendered` 与真实回合逐字节相等、客户端 UI）同 §15，未变。
4. **新增**：探针 context 不含 `signal`（CONTRACT §7.6）。若某 section/variable provider
   依赖 `context.signal`，快照与真实回合会不同；现有 shipped 包无一读取它。

---

# NOTES 阶段一 B · 真机验收后修订（第四个提交轮）

宿主重启、新代码已加载后，真机 `/prompt-setting/snapshot` 的实测响应暴露两个缺陷。
两处均已修复，测试从 113 项增至 125 项且全绿（集成套件 `pass 12 / skipped 0`）。

## 23. 真机原始观测（节选，长文本已删）

```
mounted: true, frozenScope: "global", frozenScopeReason: null
frozen: true
frozenReason: "the assembled section list differs from the registered sections for a probe-only append"
base.sections:      10 段（harness:identity … deployment:persona-suffix）
effective.sections: 11 段 = 上面 10 段 + dsh-expression:companion（index 10）
每个 effective 段： applied:false, overridable:false, reason:<同上>
rendered: "...powered by the undefined model. ... working directory is undefined."
layers: user{enabled:true} / workspace{enabled:false, reason:"no ?session= ..."}
```

两个事实：**全局作用域没有任何 complete 段**（我们全量扫描过 shipped 包，本机也没有），
却报 `frozen:true` 且把每一段标成不可覆盖；`rendered` 里出现了裸 `undefined`。

## 24. F1【blocker】段数比较把「别的插件加段」误判成冻结

**根因**：`detectFrozen` 除「探针段是否幸存」外，还有一条
`probe.length !== registered.length + 1 ⇒ frozen` 的分支。这条分支的隐含假设是
「waterfall 期间段数只会因我们那次 append 而变化」，但**别的插件会在自己的
`system-prompt/assemble` 监听器里增删段**。真机上 `dsh-expression` 追加了
`dsh-expression:companion`：`registered=10`，探针那次结果 = 10 + 探针段 + companion = 12 ≠ 11
⇒ 误判「sections 被整体替换」⇒ `frozen:true` ⇒ `buildEffective` 把**每一段**标成
`overridable:false` ⇒ g-004 的 UI 会禁用全部编辑，用户拿到一个什么都改不了的面板。

**修复**（`core/overrides.js` `detectFrozen`）——判据换成「**我们自己的改动是否幸存**」：

| 观察 | 结论 |
| --- | --- |
| 探针段**存在** | `frozen:false`。别人增删段与我们无关，**不再做任何段数比较** |
| 探针段**消失**且结果恰好 1 段 | `frozen:true` + `frozenSection` = 那一段（scope 被唯一的 complete 段整体替换） |
| 探针段**消失**且结果不是 1 段 | `frozen:true`，reason 写「我们的追加在后处理阶段被移除」，**不谎称是 complete** |
| 探针段名被真实段占用（病态） | 探针不可用，回退到两次观测互比 |

同时**删掉**了原第三条信号（「我们的覆盖被丢弃」作为 frozen 依据）。它同样是
false-positive 源：若第三方监听器注册在我们**之前**，它会变换我们返回的结果，
于是 `attempt.sections` 与 `after` 天然不同 —— 在「用户确实配了覆盖」时又会误报冻结。
现在 `frozen` **只由探针段幸存与否决定**；「某个覆盖没生效」这件事由
`effective[].applied` + `reason` 逐段如实报告，不需要也不应该升级成整段冻结。

**`overridable` 不再被启发式污染**：`frozen:false` 时，未被覆盖的段一律
`overridable:true`（真机 `dsh-expression:companion` 这段也是 `true` —— 我们的覆盖施加在
下游结果之上，确实能 replace/hide 它）。

**新增 `effective[].origin`**（`core/overrides.js` `buildEffective`），让 UI 能把
「别的插件在后处理加的段」如实呈现，而不是当成我们的覆盖或异常：

| 值 | 含义 |
| --- | --- |
| `registered` | 该名字在 waterfall 前的注册段里 |
| `appended` | 本插件自己的 `append` 覆盖引入的 |
| `downstream-added` | 两者都不是：它在 waterfall 之后进入结果，由别的监听器贡献（真机的 `dsh-expression:companion` 即此类） |
| `unmatched-override` | 覆盖的目标既不在注册段里、也不在结果里 |

顺带修掉一处同源的不如实：某覆盖的目标**原本注册过**、但在结果里被下游删掉时，
原来会显示跳过信息「no section named X is registered」（不准确），现在显示
「the section was removed from the assembled result」。

## 25. F2【major】`rendered` 把缺值变量渲染成裸 `undefined`

**根因**：`interpolate` 判「变量可用」只查了 `Object.hasOwn(variables, name)`。
而 `assembly.variables` **可以**带着 `undefined` 值 —— shipped 渲染器自己的文档就写了
「provider 可返回 `undefined`，但渲染引用它的段会失败」，而全局探针的 context 没有 agent，
agent 侧的 provider 因此返回 `undefined`。于是 `String(undefined)` 把 `undefined` 写进了
「全文」，等于给用户看一段**从未存在过的提示词**（g-004 的全文视图判据建立在这个字段上）。

**修复**（`core/overrides.js` `renderSections` / `interpolate`）：

- 值缺失（键不存在，或值为 `undefined`/`null`）时**保留字面量 `{{name}}`**，绝不输出裸 `undefined`；
- 返回结构从 `string` 改为 `{text, resolved, unresolved}`，快照据此新增
  `renderedResolved: boolean` 与 `unresolvedVariables: string[]`（排序去重）；
- 完整但畸形的组（如 `{{Upper}}`）也算未解析（shipped 渲染器对它会抛错）；
  孤立的 `{{`（无闭合组）按 prose 处理、不算未解析 —— 与 shipped 渲染器的判断一致；
- `false` / `0` 是**可用值**，不当作缺失（`{{n}}` + `{n:0}` → `"0"`）。

**实测回答了复核提出的问题**：会话作用域探针（`?session=<活跃会话>`）**能**解析
agent 侧变量 —— 因为我们传的正是 `{agent, scope: agent}`，provider 拿得到 `context.agent`。
`integration F2` 用「只在 `context.agent` 存在时才返回值的 provider」验证：带 session 时
`renderedResolved:true` 且渲染出真实值；不带 session 时 `renderedResolved:false` +
`unresolvedVariables:["model"]`，输出里没有任何 `undefined`。

## 26. 修复后的自测证据（工作树内执行）

`diff=6f/+545/-170` 是本轮代码/契约/测试改动相对提交 `ae7c359` 的
`git diff --cached --shortstat`（`CONTRACT.md` / `core/overrides.js` / `index.js` /
`test/{overrides,route,integration}.test.mjs`）；`NOTES.md` 本身记录在紧随其后的文档提交里。
`commit=1f9c9e2` 即该提交。

```
evidence: suite=overrides passed=32 failed=0 skipped=0 exit=0 ms=178 diff=6f/+545/-170 commit=1f9c9e2
evidence: suite=store passed=10 failed=0 skipped=0 exit=0 ms=115 diff=6f/+545/-170 commit=1f9c9e2
evidence: suite=route passed=39 failed=0 skipped=0 exit=0 ms=210 diff=6f/+545/-170 commit=1f9c9e2
evidence: suite=host passed=19 failed=0 skipped=0 exit=0 ms=130 diff=6f/+545/-170 commit=1f9c9e2
evidence: suite=client passed=13 failed=0 skipped=0 exit=0 ms=172 diff=0f/+0/-0 commit=1f9c9e2
evidence: suite=integration passed=12 failed=0 skipped=0 exit=0 ms=240 diff=6f/+545/-170 commit=1f9c9e2
evidence: suite=all passed=125 failed=0 skipped=0 exit=0 ms=392 diff=6f/+545/-170 commit=1f9c9e2
```

## 27. 本轮新增的回归测试与负向对照

| 测试 | 断言 |
| --- | --- |
| `detectFrozen: the F1 regression — a surviving probe plus ANOTHER plugin section is NOT a freeze` | 内核层：探针幸存 + 第三方段 ⇒ `frozen:false` |
| `detectFrozen: a surviving probe alongside sections REMOVED by another plugin is also not a freeze` | 别人删段也不冻结 |
| `detectFrozen: a probe removed without a single-section collapse does not claim complete` | 探针消失但结果非单段 ⇒ reason 不提 complete |
| `buildEffective: F1 — a section another plugin added after the waterfall is marked, not blamed on us` | `origin:"downstream-added"`、`overridable:true`、`reason:null` |
| `buildEffective: an override whose registered target was removed downstream says so` | 目标被下游删掉时给「removed from the assembled result」 |
| `F1: a third-party listener that appends a section is NOT read as a freeze` | 路由层：注册在我们**之后**的第三方监听器 ⇒ `frozen:false`、5 段全部 `overridable:true`、companion `origin:"downstream-added"` |
| `F1: a third-party listener that also removes a section is still not a freeze` | 路由层：第三方删段 |
| `F1: the real complete collapse is still reported after the survival-only rule` | **确保修复没把真冻结一起放过** |
| `integration F1: a real third-party assemble listener that appends a section does not freeze the scope` | 真包 + 真 Cordis：第三方注册在我们**之前**（最严苛顺序）⇒ 不冻结、未覆盖段全 `overridable:true`；同文件再挂一个**真 complete 段**的场景 ⇒ 仍 `frozen:true` 且 `frozenSection` 正确 |
| `F2: unresolved variables are reported instead of rendered as "undefined"` | 路由层：`{{model}}`/`{{cwd}}` 为 `undefined` ⇒ 输出无 `undefined`、`renderedResolved:false`、`unresolvedVariables:["cwd","model"]` |
| `F2: variables a provider did resolve render normally and are not reported` | 正常值 ⇒ `renderedResolved:true`、空数组 |
| `F2: an undefined or missing variable is never rendered as a bare "undefined"` | 内核层：`undefined`/`null`/缺失/畸形，以及 `0`/`false` 是可用值 |
| `integration F2: a session-scope probe resolves agent-dependent variables; the global probe cannot` | 真包：带 session 解析成功，无 session 报未解析 |

**负向对照（逐条单独改坏 → 跑全量 125 项 → 立即还原，`diff` 确认逐字节回滚）**：

| # | 改坏点 | 结果 | 变红用例 |
| --- | --- | --- | --- |
| NC-F1 | `detectFrozen` 主信号换回段数比较（`survived && probe.length === registered.length + 1`） | `fail 5` | `detectFrozen: the F1 regression — …`、`detectFrozen: a surviving probe alongside sections REMOVED …`、`F1: a third-party listener that appends a section …`、`F1: a third-party listener that also removes a section …`、`integration F1: a real third-party assemble listener …` |
| NC-F2 | `interpolate` 改回「只要键存在就用它的值」（`value === undefined && !Object.hasOwn(...)`） | `fail 3` | `F2: an undefined or missing variable is never rendered as a bare "undefined"`、`F2: unresolved variables are reported instead of rendered as "undefined"`、`integration F2: a session-scope probe resolves agent-dependent variables …` |

NC-F1 的 5 项变红里，两项在**内核层**、两项在**路由层**、一项在**真包集成层** ——
也就是说复核报出的真机现象在离线测试里**可复现、可回归**，不需要再靠真机才能发现。

## 28. 本轮仍未验证项（更新）

1. **真机复跑**：本轮修复的判据是「真机上 liangshen/普通会话的 `?session=` 快照」
   与「无 session 快照」应分别为 `frozen:true` / `frozen:false`，且 `dsh-expression:companion`
   落在 `origin:"downstream-added"`、`overridable:true`。已用真包真 Cordis 复现同一形状，
   但**没有**再跑一次真机（需重启 + 带 cookie 请求，属集成检查点）。
2. **真机 `unresolvedVariables` 的实际内容**：真机是否除 `model`/`cwd` 之外还有别的未解析变量、
   以及 `?session=` 时是否**全部**解析成功 —— 需真机带 session 请求一次即可读出。
3. 其余未验证项同 §15 / §22（E5 禁用后行为、真实回合里工作区覆盖生效、渲染与真实回合的
   逐字节相等、客户端 UI）。
4. **新增**：`unresolvedVariables` 无法区分「变量根本不存在」与「provider 返回了 `undefined`」
   （装配结果里只有一个值）。两者对读者的含义相同，故合并报告；已在 CONTRACT §7.7 写明。

---

# 阶段一 C：客户端设置页（g-004）

目标 `g-004`，attempt `att-001`，基线 `1d7d937`（集成分支 `v0.1.0-test`），
任务类型 **rewrite**。本节只记录本阶段**新增**的决策与证据；§1–§28 仍是 g-002/g-003
的历史记录，未改动一字。

## 29. 本轮交付面：只动 `client.js`（+ 本节）

| 文件 | 变化 |
| --- | --- |
| `client.js` | **整篇重写**：阶段一 A 的占位页 → Prompt 管理器（状态条 / 会话选择器 / 分段视图 / 全文视图 / 编辑面板 / 覆盖管理） |
| `test/client.test.mjs` | 测试基座升级：`node:vm` 里新增「递归展开函数组件」的迷你渲染器 + fetch 路由桩，34 个用例 |
| `NOTES.md` | 本节 |

宿主半（`index.js`、`core/**`）、`CONTRACT.md`、`package.json`、`cordis.patch.yml`
**一字未动**（`git diff --stat` 可验）。契约缺口未发现，故没有 `blocked`。

## 30. 契约字段消费清单（Revision 3，逐条对应）

| 字段 | 页面消费方式 |
| --- | --- |
| `mounted` | 状态条 tag（已挂载 / 未挂载 / 未知），未挂载时给警示条 |
| `frozen` / `frozenSection` / `frozenReason` | `frozenScope:"session"` 或「全局视图」时按事实呈现；警示条带 `frozenReason` 原文 |
| `frozenScope` / `frozenScopeReason` | **三态**呈现，见 §31 |
| `base.sections[]` | 全文视图的 `base ↔ effective` 对比左值 |
| `effective.sections[]` | 分段视图的每一行；`index` / `applied` / `overridable` / `reason` / `overrideLayer` / `action` / `origin` 全部可见 |
| `origin` 四值 | 各自一个 tag + 文案：`registered` 注册段、`appended` 本插件 append、`downstream-added` **其它插件加入**（附「不是覆盖也不是异常」的说明，且仍 `overridable`）、`unmatched-override` 无匹配覆盖 |
| `rendered` | 全文视图等宽文本框（复制按钮），默认视图直接用服务端 `rendered`，不自行拼接 |
| `renderedResolved` / `unresolvedVariables` | `false` 时顶部警示卡：标题 + 「未解析：<列表>」+ 说明「不要据此判断真实 prompt」，`data-unresolved-variables` 供机器读 |
| `layers.user` / `layers.workspace` | 状态条逐层一行：`enabled` / `path` / `reason`；工作区层 disabled 时编辑面板也据此禁用「保存到工作区级」 |
| `experiments` | 不呈现（只读诊断，非页面判据） |
| 4xx `code` | 20 条 code 全有 zh/en 文案（见 §33），页面同时给出**文案 + 原始 code + 宿主 message** |

## 31. `frozenScope` 三态：为什么必须区分，以及怎么落地

`frozenState(snapshot, sessionSelected)` 是唯一判定点，返回
`{kind, scope, certain, frozen}`：

| 响应 | kind | 文案 | 编辑 |
| --- | --- | --- | --- |
| `frozenScope:"session"` + `frozen:false` | `unfrozen` | 「本会话未冻结」 | 允许 |
| `frozenScope:"session"` + `frozen:true` | `frozen` | 「本会话已冻结」+ reason | **禁用** |
| `frozenScope:"global"` **且选了会话** | `unknown` | 「**本会话冻结状态未知**」+ `frozenScopeReason` | **允许但强警示**（编辑器内 `data-warning="edit-uncertain"`） |
| `frozenScope:"global"` 且未选会话 | `unfrozen`/`frozen` | 「全局装配未冻结 / 已冻结」 | 依全局事实 |

两处刻意的选择：

1. **unknown ≠ 未冻结**：unknown 分支绝不渲染「本会话未冻结」文案；全局 `frozen:true`
   时另起一行写「全局装配已冻结」（作用域写明是全局），不与本会话结论混为一谈。
2. **unknown 时不禁用编辑、但必须警示**：契约明确「本会话自己作用域内的 complete 段不可见」，
   我们无法知道编辑是否生效；静默禁用会掩盖「换会话就能改」的事实，静默放行正是 §2.4 要防的
   失败模式。故取「警示 + 允许」，且有测试锁死这个区别（NC1 见 §35）。

## 32. 会话选择器：从 props 取 root 级 hook，缺失即降级

- `typeof props.useSessions === 'function'` ⇒ `mode:"sessions"`：
  一次 `useSessions(selector)`，selector 返回**一个字符串**（`currentId` + 每会话
  `id/title/cwd/running`，分隔符为控制字符），因此 hook 的相等性检查看到的是稳定值，
  且对「快照未就绪」（`state` 为 `undefined`）不会抛。
  默认选中项照抄产品写法：`retainedBy.mainView > 0` 的那个会话；下拉另含「全局」项。
- `typeof !== 'function'`（或 hook 调用抛错）⇒ `mode:"manual"`：手输 session id + 「应用」+
  「全局」，并在页面上明写 `sessionLimit` 文案（**明示该限制**），`data-session-mode="manual"`。
- **不从 URL 取会话 id**：shell 无会话路由（g-004 侦察卡片已证），代码里没有
  `location` / `URLSearchParams` / `history` 的任何引用。
- 选中会话 ⇒ `/prompt-setting/snapshot?session=` 与覆盖读写都带该 session；「全局」⇒ 无参。

`useSessions` 是本次唯一「我们无法完全控制的 hook 调用」：`typeof` 分支在同一次挂载内稳定，
调用点包在 try/catch 里，抛错即降级为 manual 并在页面上报原因（不让异常穿透渲染）。
页面树另外整体包在原有 `try/catch → renderFailureCard` 里，`data-render-state="error"` 仍是
最后一道「不白屏」防线。

## 33. 4xx → 可读文案：单一来源表

`ERROR_TEXT` 是唯一来源（`code → [zh, en]`），字典在注册时用同一个循环生成
`error.<code>` 键，因此**不可能出现某个 code 只有 zh 没有 en**，也不可能出现「只显示原始 code」。
覆盖 20 条：契约 §4.4 的 18 条 + `not-found`、`duplicate-name`。
未知 code 也不会裸奔：退回通用文案 + `errCode` 标签 + 宿主 message。

## 34. 可选实现取舍（与 directive 清单的差异，均有理由）

| directive 提到 | 落地 | 理由 |
| --- | --- | --- |
| `SegmentedTabs` | primitives 分支用官方件；fallback 分支自绘 | fallback 分支必须能在**无 primitives**时工作，且真机判据靠 `data-*`；自绘件把 `data-tab-key/-value` 留在真实 DOM 上，测试与真机都能读 |
| `CodeBlock` | 未用，改用自绘等宽 `pre` | 全文视图需要**搜索命中高亮**（往文本里插 `mark` 片段），`CodeBlock` 逐字渲染源码、无法注入 span；引它只会多一层 shiki 依赖而拿不到判据 |
| `Modal` | 未用，编辑面板内联在页面中 | 减少 portal/焦点管理面；真机截图同样可见「编辑态」 |
| `SearchBlock` | 未用 | 它是「工具搜索结果卡片」形状，与「在最终文本里检索」不是一回事 |
| primitives 复用 | `Button` / `Input` / `Tag`（+ `SegmentedTabs`）+ `writeClipboard` | 沿用 g-002 的双分支探针与 `data-renderer` 标记，两条分支都保留 |

其余实现细节：文本域/原生下拉无对应 primitive，直接手绘（`--dsw-alias-*` token，深浅色可读）；
`append` 的 `order` 只在 action=`append` 时出现在请求体里（`replace`/`hide` 不带，见 §31 测试）；
全文视图超过 3000 行会截断并明写「仅显示前 N 行」（搜索计数按**显示出来的**文本算，避免
「有 N 处命中却一个高亮都看不到」）。

## 35. 自测证据（工作树内执行）

```
evidence: suite=client passed=34 failed=0 exit=0 ms=1072 diff=2f/+2926/-341 commit=626327c
evidence: suite=all passed=146 failed=0 exit=0 ms=1314 diff=2f/+2926/-341 commit=626327c
```

`ms` 取 `node --test` 自报的 `duration_ms`（含 vm 加载与 34 个用例）；`diff` 是代码提交
`626327c` 相对基线 `1d7d937` 的 `git diff --cached --shortstat`（`client.js` +
`test/client.test.mjs`）；本节 `NOTES.md` 记录在紧随其后的文档提交里。

| suite | 命令 | 结果 |
| --- | --- | --- |
| client | `node --test test/client.test.mjs` | 34 passed / 0 failed |
| all | `node --test` | 146 passed / 0 failed |
| syntax | `node --check client.js` | exit 0 |
| pack | `npm_config_cache=/tmp/npm-cache-probe npm pack --dry-run` | `total files: 10`，无 `test/` |

覆盖的断言族（34 项）：注册契约与 zh/en 键集一致；20 条错误码双语文案非空且互不相同；
两条渲染分支；请求全在 `/prompt-setting/*` 前缀内（无越界请求）；4xx 文案映射（抽样 5 条，
含 409/413/503）；宿主不可达；空装配；会话选择器默认当前视图会话 + URL 带 session；
切「全局」后去掉 session；`useSessions` 缺失降级并明示 + 手输 id 生效；
`useSessions` 抛错不致白屏；`frozenScope` 三态（含 unknown ≠ 未冻结）；不可覆盖段禁用 + reason；
`origin` 四值标注（downstream-added 不当作覆盖/异常）；分段视图三种筛选；全文搜索高亮与计数；
按来源筛全文（重组预览并标注）；`renderedResolved:false` 警示与变量列表；base↔effective 差异标记；
`replace` 不带 order + 「下一轮生效」；`append` 带目标下标 + 非法下标本地拒绝（不发给宿主）；
工作区层无 session 时本地拒绝；保存后从变化过的快照重读；覆盖列表与单条撤销；
locale seat 四种退化形状仍渲染；`t` 抛错时渲染失败卡（不白屏）；`npm pack` 清单。

**负向对照**（逐条单独改坏 → 重跑 client 套件 → 立刻按备份还原；下表为最终源码上的复跑结果）：

| # | 改坏点 | 变红用例 |
| --- | --- | --- |
| NC1 | 删掉 `frozenState` 的「global + 选了会话 ⇒ unknown」分支 | `frozenScope "global" with a session is "unknown", never "not frozen"` |
| NC2 | `renderedResolved:false` 的警示卡恒不渲染 | `renderedResolved false marks the text as partial and lists the variables` |
| NC3 | `errorText` 直接返回原始 code（不做文案映射） | 4xx 映射用例 + 工作区层本地拒绝用例 |
| NC4 | `savedNotice` 文案去掉「下一轮生效」 | `replace saves without an order and promises the next turn` |

## 36. 本轮未验证项（诚实清单，交给主管在集成检查点裁决）

1. **真机目视**：设置页是否出现新 UI、`data-renderer` 实际是哪个分支、语言切换是否即时生效、
   编辑态截图，以及「保存覆盖 → 新回合装配已改变」的端到端证据 —— 均属集成检查点（需重启
   `dsh web` 或带 cookie 请求），本轮**没有**做，也未安装进 profile。
2. **primitives 分支的交互**：离线测试的点击链路跑在 fallback 分支（primitives 用桩件），
   官方 `SegmentedTabs` 的真实键盘/布局行为未在浏览器里核过。
3. **`useSessions` 的真实形状**：本 profile 是否启用了 `dsh-client-ui-session`（决定真机是
   sessions 还是 manual 分支）需真机确认；selector 的相等/重渲染语义仍是照抄产品用法。
4. **`renderedResolved` 在带 session 时的真实解析率**（CONTRACT §2.3 的预期未在真机复核）。
5. **截断阈值 3000 行**：真机 rendered 长度未测；纯属防御性上限，不影响判据。

## 37. 本轮明确**没有**做的事

- 没有安装进 profile、没有调用 `plugin_manager`、没有重启 `dsh web`；
- 没有改宿主半（`index.js` / `core/**`）与 `CONTRACT.md`；
- 没有改 DSH 安装包、没有手工编辑 `~/.dsh/profiles/web/**`；
- **没有写 `.dsh-graph/**`**，也没有写 `~/.dsh/prompt-setting/overrides.json`
  （测试全程用内存 fetch 桩，唯一的「写」是断言请求体，落盘路径从未被触碰）；
- 没有新增运行时依赖或构建步骤（`dependencies` 仍为空，仍是零构建手写 CJS）；
- 没有做阶段二能力（历史 diff、恢复默认、导出导入）。

---

# 阶段一 C · 复核修复（g-004 第二轮）

真机使用暴露一个 UX 缺陷，主管把卡片放回执行 lane；本节记录缺陷、修复、证据与负向对照。
基线仍 `1d7d937`，本轮提交 `1b642d9`（代码）+ 紧随其后的文档提交。

## 38. 缺陷：UI 允许保存一条「永远不会生效」的覆盖

**现象（真机原始证据）**：编辑面板里对**已注册**段名 `plan:policy` 选 `append` → 接口返回
200，`~/.dsh/prompt-setting/overrides.json` 被正确写入，但下一回合的 system prompt 毫无变化。

**根因（宿主语义，`core/overrides.js:applyOverrides`，只读核对）**：

| 情况 | 宿主行为 | reason |
| --- | --- | --- |
| `append` 落到**已存在**（瀑布前已在）的段名 | 跳过，什么都不改 | `name-already-present`（两段不可同名） |
| `replace` / `hide` 落到**不存在**的段名 | 跳过，什么都不改 | `section-not-present` |
| `append` 落到新名 | 生效 | — |

宿主侧 `frozen` / `overridable` / `reason` 这一整套就是为了不让「以为改了、其实没改」发生；
而**客户端恰好在「保存」这个动作上把它放了回来**：保存看起来成功，界面既不阻止也不警示，
事后只能靠用户自己去读某一行 `reason`。**这是客户端的责任，不是宿主的** —— 两段不可同名是
上游约束，宿主跳过是正确行为，已按主管要求**没有**去改宿主半。

## 39. 修复：保存前用当前快照判定「这条覆盖能不能生效」

新增三个纯函数（`client.js`）：

| 函数 | 作用 |
| --- | --- |
| `incomingNames(snapshot)` | 真实回合的瀑布里**已经存在**的段名集合 |
| `overrideFeasibility(name, action, incoming)` | `⇒ {blocked, code}`：append 命中已有名 ⇒ `name-already-present`；replace/hide 命中未注册名 ⇒ `section-not-present`；空段名 ⇒ `missing-name` |
| `blockText` / `ineffectiveCause` | 可执行的本地化指引；以及「这条覆盖为什么没生效」的可证明原因 |

`incomingNames` 的取值口径（与主管指令的一处**有意差异**，必须说明）：

- **计入**：`base.sections[].name`（已注册）；`effective` 中 `origin:"downstream-added"` 的段名
  （其它插件在我们的监听器**之前**加进去的，瀑布里确实存在）；
- **不计入**：`origin:"appended"` 的段名 —— 那是我方 `append` 覆盖自己造出来的段，
  覆盖列表按 `name` upsert，重存同一条 append 仍然生效；若把它算作「已存在」，用户就**再也
  改不了自己已有的 append 覆盖**（真机上就是这种条目）。主管指令写的是「base 或 effective 的
  名字集合」，按字面实现会引入这个新回归，故按语义取「瀑布前已存在」这一更准的集合；
  被主管点名的两种来源（只在 `base`、只在 `effective`）**都有专门的测试**覆盖。
- **防御**：`effective` 中「有渲染结果（`index !== null`）且没有任何覆盖指向它
  （`overrideLayer === null && action === null`）」的条目也计入，兜住 `origin` 缺失/未知的情况。

界面落地（**在点击保存之前**生效，不是等接口回来才说）：

1. 编辑面板新增**段名输入**（`data-role="name"`）——它同时让「append 一个全新段」第一次成为
   可能（此前段名由所选行固定，用户根本无法新建段）；校验随输入**即时**重算。
2. 校验不通过 ⇒ 红色卡 `data-warning="override-blocked"` + `data-block-code="<code>"`：
   标题「此覆盖不会生效，已阻止保存」+ 可执行指引（改用 replace / 改成未注册的新名 /
   改用 append 新建）+ 原始 code。
3. 保存按钮 `disabled`；`save()` 内**重复同一道校验**，程序化点击也发不出请求（防御纵深，
   测试里就是直接调 `onClick` 验证「零写入请求」）。
4. 「覆盖管理」按 `effective` 标注每条覆盖的真实结果：`data-override-applied="true|false|unknown"`
   + 未生效条目显示 `data-override-reason`（客户端能证明时给出**真实原因**，并把宿主
   `reason` 作为详情行附上，因为宿主在这种场景下的 reason 是「文本被下游替换」而不是
   「名字已存在」）+ 修正指引。
5. 分段视图对 `applied === false` 且客户端能证明原因的条目，补一行
   `data-section-ineffective="<code>"`（原因 + 修正指引）。

## 40. 本轮新增测试（34 → 41）与证据

新增 7 项：`append` 命中**只在 base 的名字** ⇒ 阻止 + 零写入；`append` 命中**只在 effective 的
（downstream-added）名字** ⇒ 同样阻止；`replace`/`hide` 命中未注册名（两种动作各测）⇒ 阻止 +
零写入；**空名集合（空装配形状）不崩**且 append 仍可用；空段名 ⇒ `missing-name` 阻止；
分段视图给出可证明的真实原因；覆盖管理显示未生效 + 原因 + 修正指引。
原有 `append` 用例改为先输入**新段名**再保存（顺带覆盖「append 新名 ⇒ 允许且请求体正确」）。

```
evidence: suite=client passed=41 failed=0 exit=0 ms=1471 diff=2f/+410/-35 commit=1b642d9
evidence: suite=all passed=153 failed=0 exit=0 ms=1632 diff=2f/+410/-35 commit=1b642d9
```

`diff` 是本轮修复提交 `1b642d9` 自身的 `git diff --cached --shortstat`（`client.js` +
`test/client.test.mjs`，相对上一提交 `626327c`）；（代码提交 `56e7c67`；本节的最终文字在其后的独立文档提交里。）

`node --check client.js` exit 0；
`npm pack --dry-run` 仍 `total files: 10`（无 `test/`）。

**负向对照（逐条单独改坏 ⇒ 重跑 client 套件 ⇒ 按备份还原）**：

| # | 改坏点 | 变红 |
| --- | --- | --- |
| NC5 | 去掉 append 校验（`overrideFeasibility` 恒不阻止） | 6 项：两处 append 阻止、replace/hide 阻止、空名集合、覆盖管理未生效展示、分段视图原因行 |
| NC6 | 去掉 replace/hide 校验 | 2 项：replace/hide 未注册名阻止、空名集合 |
| NC7 | 覆盖管理不再标注 / 不显示未生效原因 | 1 项：覆盖管理未生效展示 |

## 41. 本轮仍未验证项（增量）

- **真机复核**（主管做）：用一个已存在段名尝试 append，应被 UI 挡住；以及「撤销无效覆盖 →
  改用 replace 重存 → 新回合装配改变」的端到端 —— 仍需重启/带 cookie，本轮未做。
- **`incomingNames` 与真实回合瀑布的等价性**：离线用契约形状验证；真机上若存在
  「`base` 与 `effective` 都看不到、但瀑布里确实存在」的段名（本插件拿不到的场景），
  客户端会漏判成「可以 append」，此时宿主仍会正确跳过（不会写坏数据，只是回到旧行为）。
  这一残余风险已在契约已知限制范围内，未新增宿主探测。

---

# 阶段一 C · 第二轮复核修复（g-004 第三轮）

负责人 verdict 未通过：会话下拉随使用规模退化。本轮提交 `6474215`（代码）+ 紧随其后的文档提交。

## 42. 反馈与原理

> 「查看范围使用下拉会有一个问题，随着用户的深度使用，下拉列表会越来越长。」

会话数是**随时间单调增长**的用户数据（每个会话都在侧边栏里），而原生 `<select>` 一次铺开全部
选项：几十条开始难用，上百条实际不可用，并把 DOM 撑大。凡是「与用户历史规模成正比的控件」
都必须**可搜索 + 有界渲染**，否则功能随使用退化。这一条成立，已按反馈返工。

## 43. 搜索路径：为什么不用 `ctx.sessions.search`

先做了只读侦察（证据为 DSH 安装包内的 d.ts 原文）：

| 候选 | 事实 | 结论 |
| --- | --- | --- |
| `ISessions.search(query, signal)`（`dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:104-112`） | 原文：**"Search the Host's visible message-content index. Results stay request-local; the list snapshot remains the metadata authority."** 返回 `{items: SessionSearchResultItem[], hasMore}`，规模由 `searchResultLimit` 约束 | **不是元数据检索**：它搜的是消息**内容**，不会按标题/路径/id 命中；且需要 `ctx.sessions` 服务注入 + 每次击键一次 Host 往返（`AbortSignal` 取消） |
| `ISessions.list`（同文件 `:45`） | `ObservableSnapshot<SessionListState>`，`ids` 为 Host 顺序、行含 `displayTitle/title/cwd/running/retainedBy`；`service.d.ts:52` 明确它是 "the metadata authority" | **采用**：props 的 `useSessions` 就是这个快照的选择器形态 |
| 会话侧的 root hook 贡献 | `dsh-client-ui-session` 只 `provideRoot({hooks:{sessions,sessionStatus}, keyedHooks:{sessionRetainInfo}})`，**没有** search hook | 没有第二条 props 通道 |

因此：**本地过滤 `list` 快照 + 有界渲染**（正是主管允许的兜底路径）。这样也不需要新增
`inject`（注入一个本 profile 可能不存在的服务会让整个设置页有加载失败风险），
与「`useSessions` 缺失即降级」的既有防御一致。

## 44. 新交互

| 元素 | 行为 | 机器可读标记 |
| --- | --- | --- |
| 「全局」置顶项 | 永远可见、不参与过滤；选中即无参快照 | `data-action="session-pinned"` `data-pinned="global"` `data-pinned-active` |
| 「当前视图会话」置顶项 | 同上；取 `retainedBy.mainView > 0`，标签带当前值；无当前会话时 disabled | `data-pinned="current"` |
| 当前选择 | 一行可读文案（`当前：<标题>`） | `data-role="session-current"` |
| 搜索框 | 即时过滤 `displayTitle` / `title` / `cwd` / id（大小写不敏感子串，见 §45）；选中后**回填**该会话可读标题；静止时 placeholder 显示当前值 | `data-role="session-search"` |
| 计数行 | 「显示 X / Y 条匹配（共 Z 个会话）」 | `data-session-shown` / `data-session-matched` / `data-session-total` |
| 结果列表 | **最多 20 行**，Host 顺序不重排；高亮键盘选中行 | `data-role="session-option"` `data-session-id` `data-session-active` |
| 无匹配 | 提示 + 「按该 id 查看：<输入>」入口（保留手输能力） | `data-warning="session-no-match"` `data-action="session-use-input"` |
| 键盘 | ↑↓ 移动、Enter 选中（无匹配时 Enter 直接用输入值）、Esc 清空；输入框与行都是原生控件 ⇒ Tab/Enter 与焦点环天然可用 | — |

保留项（未受影响）：`useSessions` 缺失或抛错 ⇒ 手输 id + 明示限制；**不**从 URL 取 session；
`frozenScope` 三态呈现；保存前覆盖可行性校验。

## 45. 有界渲染与规模实测（离线 vm 探针，非同真机）

`SESSION_MATCH_LIMIT = 20`：匹配集合整体算出，**渲染永远只取前 20**。用真实 `client.js` 在
`node:vm` 里挂载（桩 fetch + 合成会话目录，目录只构造一次）实测：

| 会话数 | 渲染出的会话行 | 计数行 shown/matched/total | 首次挂载 | 一次击键（过滤+重渲染） | 其中 selector 编码 |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1 / 1 / 1 | 4.3ms | 0.3ms | 0.0ms |
| 20 | 20 | 20 / 20 / 20 | 2.4ms | 0.2ms | 0.0ms |
| 200 | **20** | 20 / 200 / 200 | 5.6ms | 0.3ms | 0.1ms |
| 500 | **20** | 20 / 500 / 500 | 6.6ms | 1.2ms | 0.5ms |
| 2000 | **20** | 20 / 2000 / 2000 | 11.1ms | 2.1ms | 1.6ms |
| 5000 | **20** | 20 / 5000 / 5000 | 22.3ms | 6.0ms | 5.1ms |

（首次挂载含两次桩网络往返与 vm 加载；击键含测试探针的整树展开开销。）

两处为此做的实现选择：

1. **紧凑编码**而非 JSON：`ctx.sessions` 的 selector 每次渲染都会重跑，5000 行时
   JSON 555KB / 1.8ms 对比紧凑分隔符 274KB / 1.5ms（实测），且 `displayTitle` 等字段先经
   「无分隔符则原样返回」的快速路径，不再每行 `split/join`（那一版 5000 行击键要 15.9ms）。
   分隔符是控制字符，解码按位置进行；显示字段命中分隔符时才做替换，id 由 Host 生成、原样携带。
2. **解码缓存**（按 payload 字符串精确命中）并在解码时预生成小写 `haystack`，
   于是「一次击键」= 每行一次 `indexOf`，而不是每行 4 次 `toLowerCase`。

## 46. 新增测试（41 → 47）与证据

| 测试 | 断言 |
| --- | --- |
| `the session picker renders a bounded list at every catalog size` | 0 / 1 / 200 三种规模：渲染行数 = 0/1/20，**不等于 200**；计数行三段数字与文案正确；0 会话时置顶仍在、当前项 disabled |
| `the session search matches title, path and id, case-insensitively` | `ALPHA`（displayTitle，大写）⇒ s1；`/work/beta`（cwd）⇒ s2；`S3`（id）⇒ s3；每次都只剩 1 行 |
| `a query that matches nothing becomes a manual session id` | 0 匹配 ⇒ 出现「按该 id 查看」、明示文案；点击后 `?session=pasted-id-42` 真的发出 |
| `the pinned entries are never filtered away` | 无匹配时「全局」「当前视图会话」仍在；点全局 ⇒ 选中 global 且清空搜索、列表恢复 |
| `picking a row refills the search box with the readable title` | 点 s1 ⇒ 输入框回填 `Alpha One`，当前行同步 |
| `the session list is keyboard reachable` | ↑↓ 移动唯一高亮、Enter 选中、Esc 清空 |
| （改写）`the session selector defaults to the current view session` | 默认仍选当前视图会话，`?session=s2`；另断言搜索框/计数/置顶标记 |

```
evidence: suite=client passed=47 failed=0 exit=0 ms=2000 diff=2f/+576/-126 commit=6474215
evidence: suite=all passed=159 failed=0 exit=0 ms=2292 diff=2f/+576/-126 commit=6474215
```

`diff` 为本轮提交自身的 `git diff --cached --shortstat`（相对 `24b4e09`）；`node --check client.js`
exit 0；`npm pack --dry-run` 仍 `total files: 10`（无 `test/`）。

**负向对照（逐条单独改坏 ⇒ 重跑 client 套件 ⇒ 按备份还原）**：

| # | 改坏点 | 变红 |
| --- | --- | --- |
| NC8 | 去掉渲染上界（`sessionMatches.slice()`） | `the session picker renders a bounded list at every catalog size`（200 条会全渲染） |
| NC9 | 去掉置顶「全局」项 | 4 项：规模上界、置顶不被过滤、默认会话、切换全局 |

## 47. 本轮仍未验证项（会话规模相关，如实说明）

1. **真实 profile 的会话规模未测**：离线探针用的是合成目录；负责人真机上到底有多少会话、
   500+ 时浏览器（真实 React 调度 + 真实 DOM 提交）的击键延迟，**没有**真机数据。
   已知成本构成：DOM 行数被硬限在 20（与规模无关）；与规模相关的只剩
   「props hook 的 selector 重跑 + 一次 O(n) 过滤」，实测 5000 行约 6ms（其中 selector 5.1ms）。
   若真机出现 5000+ 会话且击键手感差，可考虑的后续手段（本轮未做）：把 selector 的编码改为
   只在目录版本变化时重建（需要 hook 侧配合），或改用服务侧元数据接口（当前服务只有
   消息内容检索，不满足）。
2. **真机目视**：置顶项/搜索/计数/键盘/无匹配回退的实际观感与焦点环，需负责人真机确认。
3. 其余未验证项同 §36 / §41（primitives 分支真实交互、带 session 的 `renderedResolved` 解析率等）。

# 阶段一 C · 第三轮复核返工（g-004 att-002）：会话选择器改为工作区树

负责人 verdict 未通过，反馈是**信息架构**问题，不是控件微调：

> 「『查看范围』的展示可以使用树形结构，和左侧边栏的『工作区』一致。」

上一轮（`6474215`）把原生下拉升级成「可搜索 + 有界渲染」，控件本身没问题；这一轮把「查看范围」按
**工作区**分组，层级与侧边栏同构，并保留上一轮的全部成果（置顶全局/当前、搜索、有界、降级）。
本轮只改 `client.js` + `test/client.test.mjs` + 本节。

## 48. `useWorkspaces` 实测形状（读源码，非推断；附文件:行）

| 事实 | 证据（DSH 0.1.7-rc.2 安装包内） |
| --- | --- |
| 工作区 hook 名为 `useWorkspaces`，由 `ctx.slots.provideRoot({hooks:{workspaces}})` 贡献 | `dsh-client-ui-workspace/lib/client.js:4137`；renderer 把它合成为 props（`dsh-client-ui-renderer/lib/client.js:703-711`） |
| 快照形状 `{items, archivedSessionIds, pinnedSessionIds, state, phase, error}` | `dsh-api-workspace-controller/lib/types/client/model.d.ts`（`WorkspaceSnapshot`） |
| 工作区实体 `{workspaceId, path, title, sessionIds, createdAt, updatedAt}` | `dsh-api-workspace-controller/lib/types/types.d.ts:19-33`（`WorkspaceView`） |
| **分组顺序** = `items` 的 Host 顺序；**无归属会话**追加在最后，key `""` | `dsh-client-ui-workspace/lib/client.js:418-437`（`groupByWorkspace`） |
| **组内会话排序** = `updatedAt` 降序、id 升序 tie-break | 同文件 `:278-298`（`orderByRecency`） |
| 排序之上：当前 blank 会话置顶，然后 **pinned 行前置** | 同文件 `:338-343`（`pinCurrentBlank`）、`:373-386`（`sectionMembers`：placeholders → pinned → rest） |
| **可见性** = 排除 `origin==='subagent'`、排除非当前 blank、默认排除 archived | 同文件 `:358-372`（`sessionVisible`，`archivedFilter` 默认 `'default'`） |
| 工作区节点标签 = `title`；`title === 'default-workspace'` 用本地化默认名；再退回路径 basename | 同文件 `:1053-1055`（`workspaceDisplayTitle`）、`:267-272`（`workspaceLabel`） |
| 无归属桶标签 = 侧边栏 `group.ungrouped` =「未分组」/「Ungrouped」 | 同文件 `:1269`；zh `:3866`、en `:3980` |
| 「当前视图会话」= `retainedBy.mainView > 0` | 同文件 `mainSessionId`（`dsh-client-ui-layout/lib/client.js:59-62` 同款写法） |

与派发前的侦察一致（`useWorkspaces` 键名、`sessionIds` 归属都对）；侦察里未覆盖的两点由本轮补齐：
**无归属桶**的存在与位置（最后）、**组内 pinned 前置**规则。

## 49. 树形「查看范围」：交互与机器可读标记

| 元素 | 行为 | 标记 |
| --- | --- | --- |
| 模式 | 两个 root hook 都在 ⇒ 树；只有 `useSessions` ⇒ 平铺；`useSessions` 也没有 ⇒ 手输 id | 根节点 `data-scope-mode="tree" \| "flat" \| "manual"` |
| 置顶「全局」/「当前视图会话」 | 与上一轮完全一致（不参与过滤、无当前会话时 disabled） | `data-pinned="global"\|"current"` |
| 工作区分组节点 | 名称（`title` → 默认工作区名 → 路径 basename）+ 路径副标题（`title` 提示）+ 会话数 | `data-scope-group="<workspaceId or ''>"` `data-scope-expanded` `data-scope-contains-current` `data-role="scope-group-label"` `data-role="scope-group-count"` |
| 展开/折叠 | 点箭头切换；**默认只展开「当前视图会话」所在工作区**，其余折叠；无当前会话时全部折叠 | `data-action="scope-toggle"` `data-scope-toggle="<key>"`（`aria-expanded`） |
| 会话行 | 可读标题 + 运行中圆点 + 路径；点击即选中并回填搜索框 | `data-role="session-option"` `data-session-id` `data-scope-parent` `data-session-running` |
| 渲染上界 | 每个展开的工作区**最多 10 行**（`SCOPE_GROUP_PAGE`），「显示更多」每次 +10、单组封顶 50（`SCOPE_GROUP_MAX`）；**全局同时最多 100 行**（`SCOPE_TOTAL_MAX`）；分组行最多 40 个（`SCOPE_GROUP_LIMIT`，含当前会话所在组时 ≤41） | `data-action="scope-more"` `data-scope-more` / `data-scope-cut` / `data-warning="scope-truncated"` / `data-warning="scope-groups-truncated"` |
| 计数行 | 「显示 X / Y 条匹配（共 Z 个会话）」，与上一轮同一组标记 | `data-session-shown` / `data-session-matched` / `data-session-total` |
| 归档会话 | 按侧边栏默认隐藏，并在页面上说明数量（不静默丢） | `data-warning="scope-archived-hidden"` |
| 降级 | `useWorkspaces` 缺失或抛错 ⇒ 平铺可搜索列表，并明示限制 | `data-scope-mode="flat"` + `data-warning="scope-degraded"` |

### 搜索语义（明确定义，写进 UI 提示 `data-role="scope-search-hint"`）

1. 会话级匹配：`displayTitle` / `title` / `cwd` / id 的大小写不敏感子串（沿用上一轮的 `haystack`）。
2. **保留祖先**：只要组内有 ≥1 条匹配，该工作区分组节点就保留（承载匹配行），组内非匹配会话被过滤掉；
   完全没有匹配的分组被移除。
3. 匹配**工作区名或路径** ⇒ 该工作区下**全部**会话视为匹配（一并可见）。
4. 搜索期间命中的分组**强制展开**（否则「保留祖先」看不见匹配）；此时折叠按钮的显式收起不生效，
   清空搜索后恢复用户自己的展开状态。这是刻意的语义选择：搜索的第一职责是把命中显示出来。
5. 无归属会话（不属于任何工作区）自成一组（标签「未分组」），始终排在最后，搜索时同样按上述规则保留/移除。

### 为什么不复用 `dsh-client-ui-workspace` 的 `deriveGroups`

它是该包的**内部函数**（`lib/client.js` 顶部 IIFE 内，未导出到包 entry），外部 bundle 拿不到；
本轮按其**逐条语义**在 `client.js` 内重写（recency → blank → pinned 分区），并额外加了窗口化。
没有新增依赖、没有改宿主半、没有 require 该包的内部路径。

## 50. 有界渲染与规模实测（离线 vm 探针，非同真机）

`deriveScope` 是纯函数：先按侧边栏规则算出每个分组的完整顺序，再**只把窗口内的行交给渲染**。
实测（真实 `client.js` 挂在 `node:vm`，桩 fetch，合成目录）：

| 会话规模 | 工作区数 | 默认（只展开当前组）渲染行数 | 搜索命中全部时渲染行数 | 一次击键（编码+过滤+重渲染） |
| --- | --- | --- | --- | --- |
| 200 | 1 | 10 | 10 | 2.3ms |
| 200 | 4 | 10 | 40 | 1.6ms |
| 500 | 1 | 10 | 10 | 2.9ms |
| 500 | 5 | 10 | 50 | 2.3ms |
| 2000 | 1 | 10 | 10 | 6.0ms |
| 2000 | 20 | 10 | **100（触顶，未渲染的 1900 行有说明文案）** | 3.5ms |

结论：**任何情况下渲染行数都有硬上界**（单组 ≤50、全局 ≤100），与目录规模无关；「全部命中」这种
最坏搜索在 2000 会话时渲染 100 行而不是 2000 行，页面上出现 `data-warning="scope-truncated"` 与
`data-scope-cut` 说明剩下的行去哪了。（击键含测试探针的整树展开开销。）

## 51. 本轮新增测试（47 → 52）与证据

| 测试 | 断言 |
| --- | --- |
| `the scope picker groups sessions by workspace, like the sidebar` | 分组顺序 = Host 顺序 + 未归属最后；标签 title→basename→未分组；路径副标题；默认只展开当前组；组内 pinned 前置 + recency；归档隐藏且有说明；运行中标记唯一；计数行；键盘高亮 |
| `the scope tree keeps the ancestor workspace of every search match` | 命中第二个（折叠）工作区的会话 ⇒ 只剩 `w-beta` 且强制展开；命中工作区名/路径 ⇒ 其下会话全留；命中未归属会话 ⇒ 未归属组保留；0 命中 ⇒「按该 id 查看」仍可用并真的发出 `?session=` |
| `a workspace group folds, unfolds, and pages its rows in` | 折叠态 0 行 → 点击展开出现该行 → 再点收起；25 会话组初始 10 行 + 「显示更多（还有 15 条）」→ 一次点击恰好 +10 行 |
| `the scope tree never renders the whole catalog (200 / 500 / 2000 sessions)` | 6 种规模×形状：默认 10 行；搜索全部命中时严格等于 `min(100, 组数×10)` 且 `< total`；分组行 ≤41；击键 <500ms；并打印上表 |
| `a missing useWorkspaces degrades to the flat searchable list` | 无 hook ⇒ `flat` + 降级文案 + 平铺 20 行封顶；hook 抛错 ⇒ 同样降级且不白屏；`items: []` **不算降级**（全部落入未分组，6 个会话一个不丢） |

```
evidence: suite=client passed=52 failed=0 exit=0 ms=2101 diff=3f/+1309/-81 commit=56e7c67
evidence: suite=all    passed=164 failed=0 exit=0 ms=2194 diff=3f/+1309/-81 commit=56e7c67
```

（代码提交 `56e7c67`；本节文字在其后的独立文档提交中定稿。）

`node --check client.js` exit 0；`npm_config_cache=/tmp/npm-cache-probe npm pack --dry-run` 仍
`total files: 10`（`index.js` / `core/*` / `client.js` / `cordis.patch.yml` / `CONTRACT.md` /
`README.md` / `NOTES.md` / `package.json`，**不含 `test/`**）。

## 52. 负向对照（逐条单独改坏 ⇒ 重跑 client 套件 ⇒ 备份还原 ⇒ 全量重跑确认）

| # | 改坏点 | 变红 |
| --- | --- | --- |
| NC10 | 去掉渲染上界（`matchedIds.slice(0, limit)` → `matchedIds`，预算 `Math.min(…, budget)` → 全量） | `the scope tree never renders the whole catalog`（`200 !== 10`：撤掉上界后默认就铺开整组） |
| NC11 | 去掉搜索时的祖先保留（删掉「无匹配分组 drop」那一行） | `the scope tree keeps the ancestor workspace of every search match` |
| NC12 | 去掉置顶「全局」项 | 3 项：`the pinned entries are never filtered away`、`switching to the global option drops ?session=`、`the scope picker groups sessions by workspace` |
| NC13 | 去掉平铺降级（`useWorkspaces` 缺失也走 tree） | `a missing useWorkspaces degrades to the flat searchable list` |

四条都是「单独改坏 ⇒ 对应用例变红 ⇒ `cp` 还原 ⇒ 全量 164 项重新全绿」，无跨用例连锁。

## 53. 未验证项（第三轮，诚实清单）

1. **真机目视**：树形分组的实际观感（缩进/箭头/路径副标题/运行中圆点）、展开折叠手感、
   以及与左侧边栏「并排看是否真的一致」，都需负责人真机确认。离线探针只能证明结构与标记。
2. **真实会话规模**：同 §47，探针用合成目录；真机 2000+ 会话下的浏览器击键延迟无数据。
3. **真机 profile 是否启用 `dsh-client-ui-workspace`**：本轮未在真机确认 `useWorkspaces` 是否真的到达
   props（类型合并恒在、运行时可缺）。若真机未启用，页面会显示平铺降级并明示 —— 这也是被验收的行为之一，
   但「真机到底走哪条分支」需目视确认（`data-scope-mode`）。
4. `default-workspace` 的本地化名字：`dsh-client-ui-workspace` 字典里查不到 `workspace.defaultName` 条目，
   本轮按语义自备「默认工作区 / Default workspace」。若真机上侧边栏显示的是别的文案，则此项不一致（低风险，
   仅影响默认工作区这一个节点的标签）。

# 阶段一 C · 第四轮复核修复（g-004 att-002 返工）：工作区节点的可发现性

反馈（负责人）：

> 「从视觉上看很难知道哪里是可交互的地方，左侧工作区部分每个工作区名称之前都有一个文件夹的图标，
> 那一列都是可交互的（折叠/展开）。」

这不是美化问题：树形控件的价值全在「展开状态可见 + 交互目标明确」两件事上。上一轮的分组头看起来像
静态文本，于是「默认只展开当前组」反而变成困惑。本轮按侧边栏的做法补齐 affordance，**结构/排序/
有界/降级全部不变**（167 项全绿：客户端 55 + 其余 112）。只改 `client.js` + `test/client.test.mjs` + 本节。

## 54. 图标来源与取舍（先读源码，可复用则复用）

| 事实 | 证据（DSH 0.1.7-rc.2 安装包内） |
| --- | --- |
| 侧边栏工作区行用的是 primitives 的图标组件：展开 `IconFolderOpenRegular`、折叠 `IconFolderCloseRegular`；折叠指示用 `IconTriangleRightFillRegular`（`arrowOpen` 时旋转 90°） | `dsh-client-ui-workspace/lib/client.js:1290-1304`（`Rows` 的 projectRow 渲染）、`:1058`（`Rows.module.css`：`.arrowOpen{transform:rotate(90deg)}`） |
| 这些图标**确实在 primitives 的公开导出里** | `dsh-client-ui-primitives/lib/index.js:12181`（export 列表含 `IconFolderOpenRegular` / `IconFolderCloseRegular` / `IconTriangleRightFillRegular`） |
| 展开态是**填充**几何（3 条 path，首条 `opacity:0.16`），折叠态是**描边**几何（2 条 path，`stroke:currentColor`，`strokeWidth:1`），画布 `0 0 16 16`，默认尺寸 16 | 同文件 `IconFolderOpenArtwork`、`FolderCloseArtwork`、`IconTriangleRightFillArtwork` |

**取舍**：两条渲染分支都要能用（g-002 起就遵守的硬规则），所以

- `ICON_SOURCE = 'primitives'`：primitives 模块真的导出了这三个图标组件 ⇒ **直接复用**它们（与侧边栏同一个组件、同一份几何）；
- 否则 `ICON_SOURCE = 'inline'`：把**同一份路径数据逐字节内联**成 `React.createElement('svg', …)`
  （`FOLDER_OPEN_PATHS` / `FOLDER_CLOSE_PATHS` / `CARET_PATH`，来源即上表两处 artwork）。两条分支视觉一致，
  **没有新增依赖、没有 require 包内部路径、没有装 npm 图标包**。
- 诚实说明：primitives 的图标组件只解构 `{size, className, strokeWidth}`，**不会把未知 props 透传到 `<svg>`**，
  所以 `data-role="scope-folder-glyph"` 这个「确实画了图标」的机器标记只在 inline 分支出现；两条分支都稳定的
  标记是外层 span 的 `data-role="scope-folder-icon"` + `data-icon-state` + `data-icon-source`。

## 55. 可交互线索清单（对齐侧边栏，且都能机器核验）

| 元素 | 线索 | 标记/样式 |
| --- | --- | --- |
| 工作区分组头（整行） | 整行可点：`cursor:pointer`、hover 换填色、焦点环、`tabIndex=0`、Enter/Space 切换、`aria-expanded` | `data-role="group-toggle"` `data-scope-group` `data-expanded` `data-hover` `data-focus` `aria-expanded` `aria-label`；hover 用侧边栏同款 `--dsw-alias-interactive-bg-hover` |
| 文件夹图标列 | **与整行同一个 toggle 的第二个指针目标**（点击时 `stopPropagation`，保证「一次点击=一次翻转」），图标形态=展开态（开/合） | `data-role="scope-folder-icon"` `data-icon-state="open\|closed"` `data-icon-source="primitives\|inline"` `data-scope-toggle` |
| 展开指示（caret） | 与图标一起给出「可折叠」的形状线索；展开时旋转 90° | `data-role="scope-caret"` `data-caret-open` |
| 会话行 | hover 填色、焦点环、命中态；**选中态不只靠文字**：左侧色条（`inset 3px 0 0 0`）+ ✓ 标记 | `data-role="session-row"` `data-selected` `data-hover` `data-focus` `aria-selected`；`data-role="session-selected-mark"` |
| 置顶「全局」/「当前视图会话」 | 描边药丸 + hover 填色 + 选中态（实心 + ✓） | `data-role="pinned-option"` `data-selected` `data-hover` `data-focus`；`data-role="pinned-selected-mark"` |
| 焦点环 | 直接用全产品统一的那一个，不自造：`outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))`，`outline-offset:-2px` | `data-focus="true"` + `style.outline` |
| 平铺（降级）列表 | 与树形同样给 hover/选中态（同一套 `scopeRowStyle`），`data-role` 仍是 `session-option` | `data-selected` `data-hover` `data-focus` |

**标记改名（相对 §49）**：分组头原来的 `data-scope-expanded` 统一为复核要求的 **`data-expanded`**（值不变，
`aria-expanded` 必须与它一致，并有断言守着）；`data-scope-group`（key）、`data-scope-toggle`（图标列）、
`data-scope-more`、`data-scope-parent` 全部保留。旧的内层 `<button data-action="scope-toggle">` 已移除：
整行就是那个控件（避免「嵌套可点元素」）。会话行在树里是 `data-role="session-row"`，平铺列表仍是
`data-role="session-option"`（既有 47 项断言依赖它）。

**hover/焦点为什么用 state 而不是 CSS**：本插件零构建、不注入样式表，`:hover`/`:focus-visible` 无法内联表达；
因此 hover/焦点走 `onMouseEnter/onMouseLeave/onFocus/onBlur` + 页面级单槽 state（同一时刻只有一个 hover/焦点），
并把状态镜像成 `data-hover`/`data-focus` —— 这样「有没有视觉反馈」也变成可自动断言的事实。
焦点环只在 `:focus-visible` 成立时画（`event.target.matches(':focus-visible')`，拿不到或抛错时按「画」处理，失败方向安全）。

## 56. 本轮新增测试（52 → 55）与证据

| 测试 | 断言 |
| --- | --- |
| `the scope picker groups sessions by workspace, like the sidebar`（改写） | 增加：`aria-expanded` 与 `data-expanded` 一致 |
| `every workspace node advertises and toggles its expansion state`（新） | 每个分组头都有 `data-role="group-toggle"`、`tabIndex=0`、onClick+onKeyDown、`aria-label`、`cursor:pointer`、`aria-expanded === data-expanded`；图标列是第二个指针目标且 `data-icon-state` 与展开态一致、caret 同态；hover 换填色、焦点环是产品同款、移出/失焦复位；**Enter / Space 各翻转一次**、其它键不动；点整行翻转、点图标列翻转，且**一次点击只翻转一次**（行数复原）；全程行数 ≤ 上界 |
| `the folder glyph is the sidebar artwork in both renderer branches`（新） | inline 分支：`<svg viewBox="0 0 16 16">` + 3 条 path、`d` 以 `M2.55912 7.93683` 开头（= primitives 原文）、`fill:currentColor`、`opacity:0.16`；primitives 分支（`primitives:'icons'` 桩）：`data-icon-source="primitives"` 且 `data-renderer="primitives"` |
| `the selected session and the pinned scope carry an explicit selected mark`（新） | 默认作用域会话行唯一 `data-selected="true"` + `aria-selected` + 左侧色条 + ✓ 标记；会话行 hover 生效；置顶两项都是 button、有 onClick、`data-selected === data-pinned-active`、活动项有 ✓；切「全局」后没有任何会话行声称选中、置顶项接管选中态；平铺降级列表同样有选中标记与 hover |

```
evidence: suite=client passed=55 failed=0 exit=0 ms=2509 diff=2f/+657/-75 commit=fd80e40 (diff = client.js + test/client.test.mjs)
evidence: suite=all    passed=167 failed=0 exit=0 ms=2419 diff=2f/+657/-75 commit=fd80e40 (diff = client.js + test/client.test.mjs)
```

规模实测复跑（行数上界不受交互改动影响）：200/1ws 默认10·搜索10·2.1ms；200/4ws 10·40·2.4ms；
500/1ws 10·10·2.6ms；500/5ws 10·50·2.8ms；2000/1ws 10·10·4.5ms；2000/20ws 10·**100（触顶）**·2.9ms。

## 57. 负向对照（本轮，逐条单独改坏 ⇒ 对应用例变红 ⇒ 还原 ⇒ 全量重跑）

| # | 改坏点 | 变红 |
| --- | --- | --- |
| NC14 | 去掉分组头的 `data-role="group-toggle"` | `every workspace node advertises and toggles its expansion state`（找不到任何 toggle 标记） |
| NC15 | 去掉分组头的 `aria-expanded` | 同上（`aria-expanded` 与 `data-expanded` 不再一致） |
| NC16 | 去掉会话行选中态的两个视觉标记（`inset` 色条 + ✓ `session-selected-mark`） | `the selected session and the pinned scope carry an explicit selected mark`（选中只剩文字） |

三条都满足「单独改坏 ⇒ 对应用例变红 ⇒ 还原后全量 167 项重新全绿」。
（过程留痕：还原时曾误把「已被改坏的文件」当作备份覆盖一次，导致 2 项失败；按备份重放 `aria-expanded` 一行后
`node --check` + 全量 167 项复绿，最终提交内容是完整版，`git diff` 已复核。）

## 58. 本轮仍未验证项（增量，诚实清单）

1. **真机 hover / 焦点环观感**：离线 vm 只能证明「状态与样式对象确实随交互变化」，无法证明真实浏览器里
   填色深浅、焦点环粗细、caret 旋转手感。需要真机目视（鼠标悬停整行、Tab 走到分组头、Enter/Space 切换）。
2. **图标与侧边栏是否视觉一致**：primitives 分支与侧边栏用的是同一组件，理论上完全一致；但**本 profile 是否
   真能 require 到 primitives**（`ICON_SOURCE` 到底走哪条分支）仍是真机才知道的事，页面上看 `data-icon-source`
   即可判定。inline 分支是逐字节复制几何，但**没有**真机并排比对过（颜色/线宽继承自 `currentColor` 与 `strokeWidth:1`）。
3. `:focus-visible` 的真实行为：`matches(':focus-visible')` 在无 DOM 环境下走「总是画焦点环」的兜底，
   真实浏览器里鼠标点击是否**不**出现焦点环，未验。
4. **ARIA 树的嵌套结构**：容器是 `role="tree"`、分组头与会话行都是 `role="treeitem"`，但分组行被包在一层
   无 role 的 `div` 里（WAI-ARIA 的规范写法是 `treeitem > group > treeitem`）。本轮没有为此重构 DOM 树
   （风险大于收益，且复核要求的是 `aria-expanded` 与展开态一致，已满足并有断言）；若后续要做完整的
   「树」无障碍语义，应把分组容器移进分组头 `treeitem` 内部。
5. 其余同 §53（真机规模、`useWorkspaces` 是否到达 props、`default-workspace` 文案）。

# NOTES 阶段二 — 历史 / diff / 恢复默认 / 导出导入

## 59. 本阶段的分层原则（沿用阶段一，且是选型的理由）

阶段二新增的能力全部落在**纯函数层**，`index.js` 只做接线，`core/store.js`
仍是唯一碰 FS 的模块：

| 文件 | 职责 | 为什么放在这里 |
| --- | --- | --- |
| `core/history.js` | 记录构造/校验、jsonl 解析、裁剪（保留最近 N）、查询分页、指纹 | 无需重启宿主即可单测；裁剪上界是「有界」的证明点 |
| `core/diff.js` | 行级 LCS + 有界退化、段级快照比较、焦点段选择 | 判据要求 diff 正确性（空文本/CRLF/超长行）可单测 |
| `core/transfer.js` | 导出文档构造、导入文档校验、冲突策略与变更计划 | 导入的「写之前全部可判定」是原子性的前提 |
| `core/store.js` | `<layer>/history.jsonl` 追加写 + 裁剪重写、多文件原子替换 | 唯一 FS 面；原子性必须贴着 `rename` 实现 |

`core/*` 里唯一新增的 Node 内置依赖是 `node:crypto`（SHA-256 指纹）。它是确定性的、
无 IO、无时钟，不破坏「纯函数内核」的性质；`at` 由调用方传入，测试可以钉死时间戳。

## 60. 关键设计决策（含与 brief / goal.md 的差异及理由）

### 60.1 历史记录存**全文**，快照只存摘要（`{name, action, hash, bytes}`）

brief 允许「存哈希 + 长度」，前提是能支撑 diff。选全文是因为：diff 要求展示**行级**差异，
只有哈希无法还原行；而每条记录最多两个 200 KiB 文本是既有 `MAX_TEXT_BYTES` 决定的上界，
不是新引入的风险。为把「任意两条历史记录对比」的代价压住，每条记录额外携带一份
**写后快照**（只有名字/动作/哈希/字节数，没有文本），段级 diff 就完全不需要读 N 个 prompt 正文。

### 60.2 `PUT` / `DELETE` 的响应体**逐字节不变**（本阶段最重要的一个取舍）

第一版实现给 `PUT`/`DELETE` 的成功响应加了 `history` 字段（记录 id 与写入结果）。
跑既有 167 项测试时 `route.test.mjs:728` 的 `deepStrictEqual` 立刻变红——阶段一契约把
这两个响应体当作冻结字节。按「既有契约只增不改」的更强读法（**连字段都不增**），
改为：`PUT`/`DELETE` 响应体保持原样；历史写入的结果通过 `GET /history` 的 `lastError`
暴露（`state.historyFailures`，按键为历史文件路径）。这样「日志写失败」仍然可观测，
而冻结响应一个字节都没动。`reset=true` 是本阶段新增的能力，没有历史包袱，所以它的响应
**带** `history` 字段。

### 60.3 整层重置用 `DELETE /overrides?reset=true`，而不是新路由

brief 允许两种写法。选查询参数是因为：方法表 `GET, PUT, DELETE` 完全不变 ⇒ 既有 405
`allow` 语义与所有既有断言不变；`reset` 必须是**字面量 `true`**，`reset=1` 会落回单条删除
语义（随后因缺 `name` 而 `400 missing-name`），这条差异有单测钉住。

### 60.4 「恢复默认（单段）」不发新路由：复用既有单条 DELETE，逐层发一次

判据 3 说「删除指定段的**全部层**覆盖」。宿主没有任何跨层写，硬造一个会引入第二个真相源，
所以客户端读现有覆盖列表 → 算出哪几层持有该名字（`data-reset-layers` 直接渲染给用户看）
→ 逐层 `DELETE`。二次确认卡片先说明「将删除以下层中的全部覆盖」。

### 60.5 导入：先全部校验与解析，再一次性 stage，最后 rename

实现顺序严格按 brief：解析 → schema/版本/字段校验 → 冲突策略 → 临时文件写入 → 校验通过 →
原子替换。关键点有三处：

1. **解析后立刻解析目标**（`targetFor` + `writableConfig`）。workspace 层无法解析 ⇒ 400，
   此时**一个字节都还没写**，用户层也不会被写（有哈希断言证明）。
2. **多文件 stage 再统一 rename**（`writeConfigsAtomically`）：先给每个目标写同目录临时文件，
   **再把临时文件读回来重新校验**（复用 `validateConfig`），全部通过才逐个 `rename`。
   任何一步失败 ⇒ 删除所有临时文件并抛错，真实配置文件从未以写方式打开。
3. **失败的证明用哈希**：`test/stage2.test.mjs` 的原子性用例对 user/workspace 的
   `overrides.json` **和** `history.jsonl` 四个文件做 SHA-256 前后比对，并额外断言目录里
   没有残留 `.tmp`。

残余风险不藏：commit 阶段是**逐文件**原子的，不是跨文件事务。两次 `rename` 之间发生
文件系统错误会留下「前一层已替换」的状态，错误信息会写明「n of m layer(s) were already
replaced」（CONTRACT §11.6 + §7.9）。

### 60.6 「空 workspace 层无 session」跳过而不是报错

导出（不带 session）会带一个 `enabled:false` 的空 workspace 层。若导入时一律要求解析
workspace，则「导出 → 导入」在无 session 时必然 400 —— 用户无法解决。规则改为：
**文档在该层没有任何条目**时跳过并在 `skipped` 里说明；**有条目**时才 400
`workspace-unresolved`（绝不静默丢数据）。两种都有单测。

### 60.7 行级 diff 在宿主算，客户端只渲染（两条分支同源）

brief 允许「宿主返回 diff」或「客户端自算」。选宿主计算：`core/diff.js` 是可单测的纯函数，
并且把 `ops` 与 `textBefore/textAfter` 一起返回，于是客户端的两条渲染分支用的是**同一份**
比较结果——primitives 可用时交给官方 `DiffBlock`（它自己按 oldText/newText 渲染），
不可用时用同一份 `ops` 自绘 `+`/`-` 行。这不是两套算法，避免「两条分支给出不同差异」这种
最难查的 bug。

`mode: "lcs"` / `"bounded"` 明确区分精确与退化：超预算（每侧 2000 行 / 100 万表格单元）
时退化为「公共前缀 + 公共后缀 + 一整块替换」，并把 mode 写进契约与 UI（有单测断言
`mode === 'bounded'` 且 40 行里改 1 行仍能定位到该行）。

CRLF：`\r\n` 与 `\r` 都当行分隔，`crlfNormalized: true` 明说「这个差异被忽略了」，
而不是把它藏起来（`a\r\nb` vs `a\nb` 断言行级无差异且有标记）。

### 60.8 历史只在「覆盖」页开放时拉取

设置页默认在「分段」页。若挂载即拉历史，阶段一的既有断言
（`requests stay on the plugin prefix`：请求集合恰好是 ping/snapshot/overrides）会变红。
把历史 effect 收敛为 `view === 'overrides'` 时才执行：既不改既有断言，也真的省掉一次
管理页不看的请求（有单测断言分段页拉取历史次数为 0）。

### 60.9 顺手修掉的既有 i18n 缺口（`ovUser` / `ovWorkspace` / `sessionCurrent`）

写键集覆盖检查脚本（`t(...)` 里所有字符串字面量与注册字典对比）时发现阶段一有 **3 个键
从未注册**：`t('ovUser')`、`t('ovWorkspace')`、`t('sessionCurrent')` 会渲染成字面量
`ovUser` / `ovWorkspace` / `sessionCurrent`（出现在层选择器、保存提示、查看范围标题里）。
本阶段一并补上 zh/en 文案。这是**既有行为缺陷**，不是新功能；修复有测试（新用例断言
确认卡片里出现「用户级/工作区级」文案）。

## 61. 客户端 UI 与机器可读标记（新增部分）

| 区域 | 标记 |
| --- | --- |
| 历史面板 | `data-region="history"`、`data-history-layer`、`data-history-state`、`data-history-total`、`data-history-corrupt`、`data-history-unreadable`、`data-history-last-error` |
| 历史行 | `data-history-row="<id>"`、`data-history-action`、`data-history-name`、`data-history-origin`、`data-history-selected="from|to|"`；当前生效值行为 `data-history-row="current"` + `data-history-current="true"` |
| 对比结果 | `data-region="history-diff"`、`data-diff-state`、`data-diff-from`、`data-diff-to`、`data-diff-sections/-changed/-added/-removed/-same`、`data-hd-row="<name>"` + `data-hd-status`、`data-diff-no-lines`、`data-diff-line-name/-mode/-line-added/-line-removed`、`data-diff-renderer="diffblock|fallback"` |
| 行级渲染 | 官方分支 `data-diff-block="primitives"`；自绘分支 `data-diff-block="fallback"` + `data-diff-ops`/`data-diff-ops-shown` + 每行 `data-diff-op`/`data-diff-op-text`/`data-diff-op-before-line`/`data-diff-op-after-line` |
| 整层重置 | `data-region="layer-reset"`、`data-reset-layer`、`data-reset-count`、`data-action="reset-layer"` |
| 单段恢复默认 | `data-action="reset-section"` + `data-section-name` + `data-reset-layers` |
| 导出/导入 | `data-region="transfer"`、`data-transfer-phase`、`data-import-mode`、`data-export-name`、`data-role="export-text"`、`data-role="import-text"`、`data-role="import-file"`、`data-import-plan` + `data-import-added/-replaced/-unchanged-count/-removed/-kept/-changes/-applied`、`data-import-change="<name>"` + `data-import-status` + `data-import-layer`、`data-import-skipped`、`data-import-unchanged="true"` |
| 二次确认 | `data-region="confirm"` + `data-confirm-kind="reset-section|reset-layer|import"` + `data-action="confirm-yes|confirm-no"` |

primitives 复用：新增 `DiffBlock`（`data-diff-renderer="diffblock"` 是机器可判定的分支标记），
`Button`/`SegmentedTabs` 沿用。**没有**为任何 UI 件引入 npm 依赖，也没有构建步骤。

## 62. 自测证据（工作树内执行）

```
evidence: suite=history passed=24 failed=0 exit=0 ms=113 diff=14f/+6388/-30 commit=ec5e958
evidence: suite=diff passed=19 failed=0 exit=0 ms=77 diff=14f/+6388/-30 commit=ec5e958
evidence: suite=transfer passed=16 failed=0 exit=0 ms=76 diff=14f/+6388/-30 commit=ec5e958
evidence: suite=stage2 passed=28 failed=0 exit=0 ms=140 diff=14f/+6388/-30 commit=ec5e958
evidence: suite=client passed=77 failed=0 exit=0 ms=3533 diff=14f/+6388/-30 commit=ec5e958
evidence: suite=all passed=276 failed=0 exit=0 ms=3761 diff=14f/+6388/-30 commit=ec5e958
evidence: suite=node-check passed=8 failed=0 exit=0 commit=ec5e958
evidence: suite=npm-pack passed=13 failed=0 exit=0 commit=ec5e958
```

上表在**代码提交 `ec5e958`** 上测得；紧随其后的 `9b828cf`（把导入计划里的
`data-import-unchanged` 计数改名为 `-unchanged-count`，与失败导入的
`data-import-unchanged="true"` 标志分开）之后**重跑全量仍为 276 passed / 0 failed / 0 skipped**，
断言数不变（该修订提交的 sha 见交付总结，它本身会因 amend 而变化，故此处不钉）。

`diff=14f/+6388/-30` 是代码提交 `ec5e958` 相对权威基线 `27a6759`（集成分支
`v0.1.0-test`）的 `git diff --shortstat`；`npm-pack` 的 `passed=13` 是 `npm pack --dry-run`
的 `total files: 13`（阶段一为 10，新增三个 `core/*.js`；清单里**没有** `test/`、没有
`.dsh-graph`）；`node-check` 的 8 是 `index.js` / `client.js` / `core/*.js` 共 8 个文件的
`node --check` 全部 exit 0。

**阶段一既有的 167 项断言全部保留且全绿**（`overrides` 32 / `store` 10 / `route` 39 /
`host` 19 / `client` 55→77 中阶段一的部分 / `integration` 12），其中
`route.test.mjs:728` 的 `deepStrictEqual`（PUT/DELETE 响应体逐字段相等）与
`client.test.mjs` 的「请求集合恰好是 ping/snapshot/overrides」两条断言**一字未改**——
它们正是 §60.2 与 §60.8 两个设计取舍的守护者。`integration` 套件 **12 passed / 0 skipped**
（真包真 Cordis，非 skip）。

## 62bis. 负向对照（逐条单独改坏 ⇒ 对应用例变红 ⇒ 备份还原 ⇒ 哈希确认逐字节回滚）

每条都是「改一处 → 只跑相关套件 → 从 `/tmp` 备份还原 → `shasum -a 256 -c` 确认源码
逐字节回到改坏之前」，最后再跑一次全量 276 项确认全绿。

| # | 改坏的内容 | 结果 | 变红的用例（节选） |
| --- | --- | --- | --- |
| NC-1 | `core/store.js`：裁剪上界改成 `Number.MAX_SAFE_INTEGER`（历史无界） | `history`+`stage2` fail 2 / pass 50 | `store: the retention bound is enforced on disk…`、`stage2: the retention bound is configurable and enforced on disk` |
| NC-2 | `core/store.js`：去掉「临时文件读回再校验」 | fail 1 / pass 51 | `store: a staged file that fails its own re-validation aborts with BOTH targets byte-identical` |
| NC-3 | `core/store.js`：把「先 stage 再 rename」改成就地写目标文件 | fail 6 / pass 46 | `store: an import commits every layer atomically…`、`store: a staged file that fails…`、`stage2: a real import applies both layers…` |
| NC-4 | `core/transfer.js`：去掉导入的版本校验 | `transfer`+`stage2` fail 2 / pass 42 | `transfer: every malformed document is rejected with a stable code`、`stage2: every rejected import leaves BOTH config files and the history byte-identical` |
| NC-5 | `core/history.js`：快照指纹恒为常量（段级 diff 失明） | fail 2 / pass 69 | `history: a snapshot entry is comparable without carrying any text`、`stage2: two history records of one section diff at section and line level` |
| NC-6 | `client.js`：整层重置跳过二次确认直接发请求 | `client` fail 1 / pass 76 | `client: resetting a whole layer needs a confirmation and states the impact` |
| NC-7 | `client.js`：`HAS_DIFF_BLOCK` 恒为 `false`（永不使用官方 DiffBlock） | `client` fail 1（叠加 NC-6 时为 2） | `client: the primitives branch renders the comparison with the official DiffBlock` |

## 63. 未验证项（诚实清单，交给主管在集成检查点裁决）

1. **真机端到端**：本轮全部证据都是离线单测（真包真 Cordis 的集成套件覆盖到 `assemble` 语义，
   但不覆盖历史/diff/导入的真实浏览器路径）。需要真机走一遍「改 → 看历史 → diff → 恢复默认」
   与「导出 → 导入」，并用非法文件导入后比对配置哈希。
2. **`DiffBlock` 真机渲染**：离线用例只证明「primitives 暴露 `DiffBlock` 时确实被调用、
   参数形状正确（diffs/labels/maxLines）」，不能证明它在真实 DOM 里的折叠/复制/换行交互与观感。
3. **下载路径**：Blob + `<a download>` 在真浏览器里的行为（本 profile 的 GUI、文件名、下载目录）
   未验；无 Blob 时的 `data:` URL 兜底路径也未在真机触发过。
4. **历史文件的跨进程并发**：同一 profile 多进程同时写同一层历史文件未验（与阶段一
   `overrides.json` 的并发姿态一致：同一进程内串行，跨进程未加锁）。
5. **`historyLimit` 走 Cordis 配置**：单测通过 `apply(ctx, {historyLimit})` 与
   环境变量两种通道验证；**真机 profile 是否会把 `historyLimit` 传进 `apply` 第二参数**未验
   （未声明 Config schema，未知键不会让插件起不来；环境变量通道是已验的兜底）。

## 64. 本 attempt 明确**没有**做的事

- 没有安装/启用任何插件，没有跑 `plugin_manager`，没有重启 `dsh web`，没有改 DSH 安装包；
- 没有手改 `~/.dsh/profiles/**`，没有写 `.dsh-graph/**`，**没有写真实的
  `~/.dsh/prompt-setting/`**（所有测试都用 `DSH_HOME` 指向临时目录）；
- 没有新增运行时依赖或构建步骤（`package.json` 的 `dependencies` 仍为空，`files` 清单不变）；
- 没有改 `applyOverrides` / `mergeLayers` / 冻结探针 / 快照语义（阶段一行为逐字节保留）；
- 没有把 `PUT`/`DELETE` 响应体加字段（见 §60.2），也没有改 405 `allow` 语义；
- 没有为「恢复默认单段」新增宿主路由（复用既有单条 DELETE，见 §60.4）。

## 65. 两层刷新语义对齐：用户层也按请求重读（Revision 5）

### 65.1 改动前的真实姿态

| 层 | 何时写入内存 | 外部改文件能否被感知 |
| --- | --- | --- |
| 用户层 `$DSH_HOME/prompt-setting/overrides.json` | **只在挂载时**读一次；此后仅由本插件保存路径（`cacheWritten`）更新 | **不能**，要等插件重载 |
| 工作区层 `<root>/.dsh-prompt-setting/overrides.json` | 挂载时 + 每次「需要工作区层的路由」开头 | 能（下一次请求） |

真机现象：清理测试数据时直接改用户层文件，运行中的插件完全无反应（旧覆盖继续生效）。
这正是本次要修的不一致：同一份语义、同一种文件，两层却不同命。

### 65.2 改法（`index.js`，唯一新增的 IO 点仍是路由）

- 新增 `refreshUser()`：按 `readConfig()` 的既有映射重读用户层；**永不抛**。
- 新增 `refreshLayers()`：`refreshUser()` + `refreshWorkspaces()`，**并列**调用。
- 派发器（prefix handler）的 `try` 第一句就是 `refreshLayers();` —— 在路径/方法判定之后、
  任何 handler 之前，因此「请求要么不落地 IO（栅栏/404/405），要么先刷新再谈成败」。
- `workspaceContext()` 里原有的 `refreshWorkspaces()` 删除：它唯一的作用就是「顺带刷新」，
  现在由派发器统一做，避免每请求重复读同一批文件（`loadWorkspace(root)` 仍保留，
  用于「注册表列了但缓存还没见过」的那个 root）。
- `cacheWritten()` 给用户层补 `present: true`（写完文件一定存在）。
- 挂载处 `readConfig` + 手工拼 state 改为直接 `refreshUser()`，两条路径共用同一段判断。

### 65.3 「文件消失」为什么单独报错（与「从来没有」区分）

`readConfig()` 的既有语义是：**ENOENT = 空且启用**（新装的 profile 本来就该是这样），
只有「读不了 / 不是合法 JSON / schema 不符」才是 `enabled:false + reason`。
`state.user.present` 记录「本 mount 读到过这个文件」，于是：

- **从来没写过**（present=false，ENOENT）→ 空、`enabled:true`、`reason:null`（既有语义不变，
  既有用例 `overrides GET: both layers plus the merged list` 逐字钉住这条）；
- **读到过、现在没了**（present=true，ENOENT）→ `enabled:false`，
  reason `missing-file: <path> was removed after it had been read`。

两种情形对**装配**的效果完全一致（该层不贡献任何覆盖，旧覆盖不会靠缓存续命），差别只在
面板上「文件没了」不再被伪装成「这层没有覆盖」。工作区层不做这条区分（本次未改它，
避免扩大范围；它的缺文件仍按既有语义报空+启用）。

### 65.4 装配路径零 IO：结构 + 行为双证

- **结构**：`resolvedFor()` / `assembleHandler()` 的源码切片里不含
  `readConfig(` / `loadWorkspace(` / `refreshUser(` / `refreshWorkspaces(` / `refreshLayers(` /
  `readFileSync(`；`index.js` 里唯一碰 `node:fs` 的仍是 `core/store.js`。
- **行为**：挂载后改盘上文件，**不经任何路由**直接 `ctx.systemPrompt.assemble({scope})`，
  装配结果仍是旧内容；一次（哪怕失败的）请求之后才变成新内容。这条断言同时也是
  「缓存脱节最多存活一个请求」的证据。

### 65.5 失败请求与缓存脱节（主管追加要求）

四条写路径（PUT / DELETE / DELETE?reset / import）的**失败分支**都不得改动可观察状态：

- 运行期：11 种可触发的失败输入（`invalid-json`、`unknown-layer`、`missing-text`、
  `workspace-unresolved`、`override-not-found`、非法 schema、`413 body-too-large` …）逐个打，
  每次都断言「缓存直读的装配仍是文件内容」且 `GET /snapshot` 的
  `layers.user = {enabled:true, reason:null}` 且 effective 里仍是文件的文本；
- 409 `layer-not-writable`（工作区层文件损坏）单列一例：只禁用那一层，用户层照旧；
- 结构：四条写路径在 `cacheWritten(` 之前的源码片段里**完全不出现 `state.`**，
  且都先 `writeConfig(…)`/`writeConfigsAtomically(…)`。这一条覆盖了两个「构造不出来」的分支
  （`import-staging-failed` / `import-verify-failed`：`core/store.js` 是「先 staging 再读回校验」，
  合法计划生成不出读回失败的暂存文件）。**没有**为它们硬造文件系统故障（如 chmod 只读目录），
  以免在特权用户下变成假红。

## 66. 本轮自测证据（工作树内执行）

`packages/dsh-prompt-setting/` 下：`node --test test/*.test.mjs`

- 全量：`evidence: suite=all passed=285 failed=0 exit=0 ms=4493 diff=3f/+421/-18 commit=ea8ab2d`
- 宿主路由+刷新套件：`evidence: suite=route+refresh passed=48 failed=0 exit=0 ms=286 diff=3f/+421/-18 commit=ea8ab2d`
- 集成套件（真包真 Cordis）**pass 非 skip**：`evidence: suite=integration passed=12 failed=0 exit=0 ms=243 diff=3f/+421/-18 commit=ea8ab2d`
  （12 个用例全部 ✔，`skipped 0`；不是「整文件跳过」的假绿）。
- 基线对照：改动前同一条命令 `tests 276 pass 276 fail 0`（§62bis 记录的那一轮），
  本轮为 `285 = 276 + 9`。

## 67. 本轮新增测试（276 → 285）与负向对照

新增用例全部落在 `test/route.test.mjs` 的 `// #region external refresh (Revision 5)`：

| 用例 | 钉住的行为 |
| --- | --- |
| `refresh: an external edit of the user layer reaches the very next request` | 外部改文件 → 一次 `GET /snapshot` 即反映（判据 1） |
| `refresh: the assembly path opens no file, so an external edit waits for a request` | 装配路径零 IO；失败请求也算「一次请求」（判据 4 + 追加要求 2） |
| `refresh: a failed write never leaves the cache at odds with the file` | 11 种失败输入，逐个断言缓存==文件（追加要求 1） |
| `refresh: a write rejected because the target layer is unusable leaves the other layer alone` | 409 只禁用坏的那层 |
| `refresh: every write path caches only after its own file write returned` | 四条写路径结构上先写后缓存 |
| `refresh: deleting the user layer file disables it with a reason, and restoring it recovers` | 删除 → `missing-file` + 不崩；恢复 → 立即生效（判据 2） |
| `refresh: a file that never existed is an empty enabled layer, not a vanished one` | 「从来没有」与「没了」必须不同（既有语义不回归） |
| `refresh: a user file corrupted after mount disables it, and a repaired one recovers` | 非法 JSON / schema 不符 → 不崩 + 既有 error 语义（判据 3） |
| `refresh: the route handler re-reads both layers before its first branch` | 结构：刷新先于每个 handler 分支 |

负向对照（每条：改坏一处 → 跑 `test/route.test.mjs` → 从 `/tmp` 备份还原 → 复跑确认回绿）：

| # | 改坏的内容 | 结果 | 变红的用例 |
| --- | --- | --- | --- |
| NC-1 | 删掉派发器里的 `refreshLayers();`（请求路径不再重读） | `route` fail 5 / pass 43 | `an external edit … reaches the very next request`、`the assembly path opens no file…`、`deleting the user layer file …`、`a user file corrupted after mount …`、`the route handler re-reads both layers…` |
| NC-2 | `refreshUser()` 读到坏文件时 `throw`（而不是把该层标为不可用） | `route` fail 2 / pass 46 | `layers: a corrupt user file disables that layer…`（既有）、`a user file corrupted after mount …`（新增） |
| NC-3 | 去掉「读到过又消失」规则（`state.user.present` 恒为 false） | `route` fail 1 / pass 47 | `deleting the user layer file disables it with a reason…` |

三条都是「单独改坏 ⇒ 对应用例变红」，且三次还原后全量均为 `tests 285 pass 285 fail 0`。

## 68. 这条断言覆盖的真机现象，以及它**能/不能**证明什么

### 68.1 被覆盖的现象（能证明的部分）

真机时间线（文件 mtime 全程未变、内容含一条 `ui-e2e-ok` append）：

- `21:42:27` 的回合：该覆盖**生效**；
- 该窗口内负责人执行过一次**被拒绝的导入**（非法文件）；
- `21:52:54` 的回合：该覆盖**不再生效**，而文件未动。

本轮新增的断言能证明的是**「缓存与文件脱节」这一类解释里，属于写路径的那一半不成立**：

1. 四条写路径（含 `handleImport` 的每一个早退/异常分支）在写成功之前都不碰可观察状态；
   被拒绝的导入既不改文件、也不改缓存（运行期 11 例 + 结构性断言）；
2. 即便真的出现过脱节（例如外部改文件而缓存落后），**每个被处理请求开头都会重读两层**，
   所以脱节最多存活一个请求，且该请求失败也照样重读；
3. 装配路径零 IO：脱节不会被「装配时顺手重读」掩盖，也不会在装配中途变化。

### 68.2 不能证明的部分（边界，明确写下）

- **没有复现 `21:42 → 21:52` 那段现象，也不声称找到了它的确切根因。** 本轮的证据只能排除
  「写路径把缓存改坏」与「外部改文件长期不被感知」两类解释。
- 逐条读过四条写路径 + `core/store.js` 的 `writeConfigsAtomically` 后，**能构造出来的脱节方向
  是「旧覆盖继续生效」（stale cache），不是「覆盖停止生效」**。上面那次观测的方向恰好相反。
  因此若真因属于后者，它不在本轮覆盖的范围内 —— 可能的方向（均**未验证**、仅列作后续排查线索）
  包括：`frozen` / `complete` 判定、`?session=` 对应的 scope 或工作区解析变化、
  工作区层同名覆盖（工作区层优先）在某一回路合下胜出、以及那次回合的 preset 组合与 `21:42` 不同。
- 前提是「文件确实未变」这一点来自人的观测（mtime/哈希一致），本轮**未**取得该文件的独立证据
  （没有文件快照、没有那一轮的真实 prompt 原文），所以时间线本身按外部输入对待。
- 真机复跑（页面刷新后改文件即生效、改坏即 disabled、改回即恢复）**未做**：本轮全部为离线断言，
  真机验收点仍由主管在集成检查点执行。

### 68.3 顺带读到的一份同时期证据（只读，未改未删）

主工作树根下有一份**未跟踪**文件 `dsh-prompt-setting-2026-09-28T13-41-32-354.json`
（mtime `2026-09-28 21:43:12`，**非本轮产生**，本轮只读它）——正是那次真机会话里导出的文档：

- `exportedAt 13:41:32.354Z`（本地 `21:41:32`，即覆盖仍生效的窗口内）；
- `user`：`enabled: true`，唯一覆盖 `ui-e2e-ok:append`；
- `workspace`：`enabled: true`，`overrides: []`。

**它能说明的**：21:41:32 时刻，一次经真实路由的导出解析到了工作区层（`enabled: true` 要求
`?session=` 能解析出可读的工作区），而**那个工作区层当时没有任何覆盖**；用户层当时确实只有那一条
append。**它不能说明的**：导出结果不等于 `21:52:54` 那一轮装配的输入，工作区层按 session 解析，
那一轮的 session/root 未必相同。所以这条证据**既不支持也不排除**「工作区层同名覆盖胜出」
（§68.2 列出的待排查方向之一），只是把「21:41 那个 root 下不存在工作区层覆盖」钉成了事实。

## 69. 本轮明确**没有**做的事

- 没有改 `client.js` 与 `test/client.test.mjs`（并行 attempt g-006 正在改，避免冲突）；
- 没有改 `core/**` 任何内核语义（`applyOverrides` / `mergeLayers` / 校验 / 迁移 / 历史 / diff 全未动）；
- 没有引入文件监听（inotify/`fs.watch`）、定时器或轮询；刷新只发生在请求路径上；
- 没有新增依赖或构建步骤（`package.json` 未动）；
- 没有改 `PUT` / `DELETE` / `import` 的响应体与状态码（Revision 5 只改「何时重读」与
  一层「文件消失」的 `enabled`/`reason` 取值，字段集合与既有形状不变）；
- 没有为了负向对照之外的原因临时改坏源码；三次改坏均从 `/tmp` 备份还原并复跑全量确认；
- 没有写任何真实 `~/.dsh/prompt-setting/`（所有测试仍用 `DSH_HOME` 指向临时目录）；
- 没有自行 `git worktree add` / `branch` / `checkout` / `merge`，只在专属 worktree 内提交；
- 没有安装/启用插件、没有重启 `dsh web`、没有改 DSH 安装包或 profile。
---

# 阶段一 C · 第五轮（g-006）：编辑面板交互重构 —— 把耦合参数拆成两条入口

## 70. 问题与根因（负责人真机反馈）

编辑面板把**段名（可编辑输入）**与**动作（replace / hide / append 分段控件）**做成两个互相独立的控件，
但二者语义上强耦合：`append` 必须配**未注册**段名，`replace` / `hide` 必须配**已注册**段名。
用户只能靠摸索凑合法组合，可行性只能在**保存前**（也就是已经点下去之后）才被拦住。
第四轮的修复（§38/§39）把「不会生效的保存」拦住了，但它拦在**事后**：交互层仍然允许拼出非法组合。

## 71. 修法：三层，由外向内收窄

| 层 | 作用 | 位置 |
| --- | --- | --- |
| 入口层（结构） | 入口决定「能选什么」，非法组合**不可产生** | `editorRoute` / `editorActions` / `openEditor` / `openAppend` / `setAction` / `setName` |
| 即时层（live） | 边输入边说明为什么保存被禁用 | `entryFeedback` + `data-warning="entry-feedback"` |
| 兜底层（defensive） | 既有保存前可行性校验**原样保留**，仍是写入前最后一关 | `overrideFeasibility` + `save()` 内重复检查 |

- **入口 1「编辑已有段」**：点分段行的「编辑」→ `mode='edit'`、`nameLocked=true`、
  `editorActions('edit') === ['replace','hide']`；动作只有这两个 tab，`replace` 为默认
  （若该段已存的是 `hide`，则沿用 `hide`，见 §72.2）。
- **入口 2「新增一段」**：分段列表头部的独立按钮 `data-action="append-new"` → `mode='append'`、
  `nameLocked=false`、动作恒为 `append`，界面上**没有动作控件**（`data-role="action-fixed"` 是事实陈述，
  不是可点的控件），并明示「必须是当前未被注册的段名」。
- **即时反馈**：新增入口里输入已注册段名 ⇒ 立刻出现 `data-warning="entry-feedback"`
  （`data-feedback-code="name-already-present"`）并**禁用保存**；不需要先点保存。
  空名同理（`missing-name`），否则「刚打开面板」这个正常中间态会被兜底卡片吓一跳。
- **兜底**：`overrideFeasibility` 一字未改，仍在 `save()` 里把关；它的**卡片**只在
  「两条入口都产不出的状态」下渲染：①入口契约被破坏（动作不在该入口集合内）；
  ②面板开着时世界变了（段名离开了 incoming 装配）。

## 72. 与 brief / goal.md 的差异及理由（都写在这里，不藏）

### 67.1 第三种呈现：`edit-override`（分段行自己路由，不是第三个用户入口）

行上的「编辑」按钮由**行**决定打开哪个呈现（`data-entry` 标记）：

- 段名**在** incoming 装配里（`registered` / `downstream-added`）⇒ 入口 1（replace / hide，段名只读）；
- 段名**不在** incoming 里（`appended` = 本插件自己的 append，或 `unmatched-override` = 无目标的覆盖）
  ⇒ 以**同名 append 重存**，此时名字与动作都由该覆盖本身决定，用户无从选错。

理由：`incomingNames` 故意**不**把本插件自己的 append 算进来（§39，upsert 语义）。
所以 `extra:appended` 这类行如果走入口 1，`replace`/`hide` 一定被 `section-not-present` 拦住——
那会让**正常路径**撞上兜底卡片，既违反 brief 要求 4，也等于删掉「改自己 append 段的文本」这个既有能力。
把它路由到能重存它的入口，是唯一既不产生非法组合、也不丢能力的做法。
副作用是把旧用例「an empty name set does not crash the validation」（对 `ghost:section` 先 replace 被拦、
再切 append）改写成新交互下的等价断言，覆盖未削弱（见 §75）。

### 67.2 入口 1 的默认动作：`replace`，但不静默改写已存的 `hide`

`openEditor` 的默认是 `replace`；只有当该段**当前存的覆盖动作本身就在 `{replace, hide}` 里**时才沿用
（即已存 `hide` 的段打开时选中 `hide`）。brief 的「默认 replace」在**无覆盖的普通段**上逐字成立
（§75 有断言），而沿用已存 `hide` 避免了「点开 → 保存」把隐藏段悄悄变成替换——那是新增的静默改写，
比不满足字面默认更糟。

### 67.3 `save()` 里多一条契约外动作守卫

入口已经决定动作，所以 `editor.action` 不在 `ACTIONS` 内只可能是契约外状态：
此时按 `unknown-action` 拒绝写入，而不是按 replace 语义去猜（既有 `error.unknown-action` 文案，未新增 i18n）。
`ACTIONS` 因此仍是活常量，不再是被重构挤掉的死代码。

## 73. 机器可读标记（新增，全部可断言）

| 标记 | 位置 | 含义 |
| --- | --- | --- |
| `data-editor-entry` | 编辑面板 | `edit` / `append-new` / `edit-override` |
| `data-editor-mode` | 编辑面板 | `edit` / `append` |
| `data-editor-name-locked` | 编辑面板 + 名字输入 | 段名是否只读 |
| `data-editor-actions` | 编辑面板 | 该入口实际可选动作，逗号分隔（`replace,hide` / `append`） |
| `data-editor-meta` / `data-editor-origin` / `data-editor-overridable` | 编辑面板（入口 1） | 来源层与是否可覆盖 |
| `data-role="name"` 的 `readOnly` / `data-name-locked` | 名字输入 | 只读与否 |
| `data-role="name-hint"` / `data-role="entry-hint"` / `data-role="action-hint"` | 编辑面板 | 规则说明（未注册段名 / 重存本覆盖 / 动作固定） |
| `data-role="action-fixed"` + `data-fixed-action` | 编辑面板 | 固定动作的事实陈述（无动作控件） |
| `data-warning="entry-feedback"` + `data-feedback-code` | 编辑面板 | **即时**反馈（`name-already-present` / `missing-name`） |
| `data-entry` | 分段行的编辑按钮 | 该行会打开哪个入口 |
| `data-action="append-new"` | 分段列表头部 | 入口 2 的可达点 |

既有标记全部保留：`data-region="editor"`、`data-editor-name`、`data-warning="override-blocked"` +
`data-block-code`、`data-warning="edit-disabled"` / `edit-uncertain` / `workspace-layer-disabled`、
`data-editor-error`、`data-role="text"` / `order`、`data-sections-total` / `data-sections-shown`、
`data-action="save"` / `cancel`、`data-tab-key="action"` / `"editor-layer"`。

### 68.1 i18n 增删（zh/en 键集合始终相同，既有 parity 用例把关）

- **新增 15 键**：`editNameLocked` / `editNameLockedHint` / `editOriginLabel` / `editOverridableLabel` /
  `appendEntry` / `appendHeading` / `appendUntitled` / `appendName` / `appendNameHint` /
  `appendActionFixed` / `appendActionHint` / `editOverrideHeading` / `editOverrideHint` /
  `feedbackNameRequired` / `feedbackNameTaken`。
- **删除 1 键**：`editName`（「段名（覆盖目标）」）。它原来的唯一消费者是那个「可编辑段名 + 独立动作」
  的旧面板；拆成两条入口后名字标签由 `editNameLocked` / `appendName` 取代，留着就是死键。
  全仓（含 `test/`、`NOTES.md`、`CONTRACT.md`）无引用，删除不涉及契约。

## 74. 自测证据（工作树内执行）

单行结构化概要：

- `evidence: suite=node --test (packages/dsh-prompt-setting) passed=281 failed=0 exit=0 ms=4475 diff=client.js+317/-34,test/client.test.mjs+280/-59,NOTES.md+176/-0`
- `evidence: suite=node --check client.js exit=0`
- `evidence: suite=npm_config_cache=/tmp/npm-cache-probe npm pack --dry-run total files=13 (无测试目录/无新增文件)`

断言命令与结论：

- `node --test`（在 `packages/dsh-prompt-setting/`，Node v24.13.1）⇒ `tests 281 / pass 281 / fail 0`，
  基线 276 项全部保留且全绿（client 套件 77 → 82）。
- `node --check client.js` ⇒ 退出码 0。
- `npm_config_cache=/tmp/npm-cache-probe npm pack --dry-run` ⇒ 13 个文件，与改动前清单一致，
  未把 `test/` 或任何新文件带进包。

## 75. 本轮新增/改写的测试（client 77 → 82）

新增或改写（`test/client.test.mjs`）：

1. `the edit entry locks the name and offers only replace/hide` — 入口 1：`data-editor-actions='replace,hide'`、
   tab 集合恰为 `['replace','hide']`、无 `data-role="order"`、名字输入 `readOnly` 且**改写不了**、
   来源/可覆盖标记、无兜底卡片、无即时反馈。
2. `the add entry is a separate, reachable entry whose action is fixed to append` — 入口 2 可达性、
   `data-editor-actions='append'`、`data-role="action-fixed"`、**零个动作 tab**、未注册段名提示、
   名字输入可编辑。
3. `the edit entry defaults to replace and mirrors an existing hide` — 默认 `replace` 有断言；
   已存 `hide` 的段打开即 `hide` 且不渲染文本域。
4. `neither entry reaches the pre-save check on a normal path` — **正常路径不触发兜底**：
   replace / hide / append 三条合法路径各写成功一次，全程 `override-blocked` 卡片数为 0。
5. `a registered name in the add entry is reported immediately, and the write is blocked` —
   **重名即时反馈** + 保存禁用 + **程序化点击仍 0 写入且给出原因**（兜底在异常态生效）；
   改名后反馈消失、保存恢复可用。
6. `a name another plugin added is fed back immediately as well` — downstream-added 名同理。
7. `an empty name in the add entry is refused locally as missing-name` — 空名即时提示 + 兜底原因。
8. `the pre-save check still fires when the world moves under an open panel` — 面板开着时快照里段消失 ⇒
   兜底卡片 `section-not-present` + 阻止写入 + 给出原因（**这是兜底卡片唯一可达的正常/异常路径**）。
9. `an own-override row is edited through the entry that can re-save it` — `ghost:section` 行
   `data-entry="edit-override"`、动作固定 append、名字只读，保存体 `action: 'append'`。
10. `an appended section is re-editable as the append it is` — `extra:appended` 行同样路由到 append 重存，
    文本域带出已存文本（能力未丢）。
11. `the add entry carries a target index, and a bad index is refused locally` — 改写自旧的
    `append carries a target index…`：现在走入口 2；非法 `order` 本地拒绝、合法 `order` 随 PUT 发出。

## 76. 负向对照（逐条单独改坏 ⇒ 跑 client 套件 ⇒ 从 `/tmp` 还原 ⇒ 全量复绿）

每条都是「改一处 → 只跑 `test/client.test.mjs` → `cp /tmp/g006-client-final.js client.js` 还原 →
`shasum -a 256 client.js` 与改坏前逐字节一致
（`57e52feaa78e217266457f7c896e45da6987fa659f88ac89813c9c531e07e3df`）→ `node --check` 通过 →
再跑全量确认 281 全绿」。

| # | 改坏的内容 | 结果 | 变红的用例 |
| --- | --- | --- | --- |
| NC-1 | `EDIT_ACTIONS` 加回 `'append'`（编辑入口又能选 append ⇒ 非法组合复活） | client fail 1 / pass 81 | `the edit entry locks the name and offers only replace/hide` |
| NC-2 | `entryFeedback` 去掉 `name-already-present` 分支（重名不再即时反馈） | client fail 2 / pass 80 | `a registered name in the add entry is reported immediately…`、`a name another plugin added is fed back immediately…` |
| NC-3 | `openEditor` 把 `nameLocked` 置 `false`（编辑入口段名可改） | client fail 3 / pass 79 | `the edit entry locks the name…`、`an own-override row is edited through the entry that can re-save it`、`an appended section is re-editable as the append it is` |
| NC-4 | 同时删掉 `save()` 的可行性守卫与兜底卡片渲染（兜底消失） | client fail 4 / pass 78 | `…reported immediately…`、`…fed back immediately as well`、`…empty name…missing-name`、`the pre-save check still fires when the world moves under an open panel` |

## 77. 未验证项（诚实清单，交给主管在集成检查点裁决）

1. **真机两条路径**：本轮证据全部是离线 vm 单测（含真包/真 Cordis 的宿主半套件未受影响）。
   设置页上「选中已有段 → 编辑 → 段名不可改 → 保存 → 下一轮生效」与
   「新增一段 → 输入已注册段名得即时反馈 → 换新名 → 保存 → 下一轮装配出现该段」
   两条真机路径**未走**，以及 `frozenScope: "global"` + 已选会话下的只读观感。
2. **只读输入的真实观感**：`readOnly` 的 `<input>` 在 primitives 分支由官方 `Input` 渲染，
   离线用例里 `primitives.Input` 是空实现（只验标记与 props 传递），真机上的灰化/焦点行为未验。
3. **`aria-readonly` 的读屏行为**：只做了属性写入断言，没有辅助技术实测。
4. **`edit-override` 的措辞**：该呈现的文案（`editOverrideHint`）是新增的，
   没有经过真机中文阅读体验复核。

## 78. 本 attempt 明确**没有**做的事

- 没有改宿主半（`index.js`、`core/**`），没有改 `CONTRACT.md`，没有改 `package.json`；
  范围严格是 `client.js` + `test/client.test.mjs` + 本节；
- 没有新增运行时依赖或构建步骤，`npm pack --dry-run` 清单不变（13 个文件）；
- 没有安装/启用插件、没有跑 `plugin_manager`、没有重启 `dsh web`、没有改 DSH 安装包、
  没有手改 `~/.dsh/profiles/**`、没有写 `.dsh-graph/**`、**没有写真实 `~/.dsh/prompt-setting/`**
  （测试全部走内存桩）；
- 没有改 `overrideFeasibility` 的语义（仍是写入前唯一的可行性判定），也没有删掉兜底卡片：
  它只是改为在「两条入口都产不出的状态」下渲染；
- 没有删减既有断言来换绿：276 项基线全部保留，其中 6 项与本次交互直接相关的用例被
  **改写**为新交互下的等价（且更严）断言（§75.11 与 §72.1 各说明一处）。

## 79. 构建戳：问题、最小设计与落点（Revision 6）

**问题**（本轮把它变成机器可判）：页面有可能在跑**不是磁盘当前字节**的 `client.js`，而它自己不知情。
两边都「正常工作」，所以「改动没生效」与「页面不是当前字节」在页面上长得一模一样；
本机 `Cmd+Shift+R` 又被 DSH 接管，最自然的人工判别路径也没了。

**先纠正一个被真机推翻的前提（这次返工的原因）**：本节早先写的「已经打开的标签页会一直跑它被加载时
的 `client.js`」是**错的**（至少不是 DSH 0.1.7-rc.2 的常态）。DSH 自带客户端插件 HMR，静态复核
（读安装包源码，`$P` = pnpm 全局安装根下的 `@deepseek-ai/<包>` 目录）如下：

| 事实 | 源码位置（可自行复核） |
| --- | --- |
| 客户端订阅 SSE `/plugins/events`，收到 `{type:"rebuilt", id, rev}` 就 `ctx.modules.entries.reload(id, rev)` | `$P/dsh-client-hmr/lib/client.js`（`EVENTS_ROUTE = "/plugins/events"`；`entries.reload(frame.id, frame.rev)`） |
| `replace()` = `modules.prefetch(id)` → `tearDownEntryFiber(entry)` → `import(id)` → `entry.refresh()` ⇒ **页面无需重载文档即可换新插件代码** | `$P/dsh-client-modules/lib/client.js` |
| 宿主侧：`rebuilt(id)` 取 `rev = artifactRevision(baseline) = framedHash("plugin-artifact", [String(mtimeMs), String(ctimeMs), String(size)])`；**rev 未变就直接 return（不读文件、不发通知）**，变了才 `readFileSync` 重读 bundle 并 notify | `$P/dsh-client-modules/lib/index.js` |

真机实测（主管，2026-09-28 23:48–23:51；改的是集成工作树里被 `web` profile 链接的那份
`packages/dsh-prompt-setting/client.js`）：在 factory 区域**内**改 1 处（注释加 ` [stale-demo]`，
摘要 `63cf17c0` → `77134de7`）后，页面在**无任何操作**下 `data-build` 由 `63cf17c0` 变成 `77134de7`，
而 `performance.timeOrigin` 恒为 `23:36:50` ⇒ 文档未重载、HMR 确实生效。该改动随后已还原
（本轮复核：主工作树 `client.js` 摘要回到 `63cf17c0`、`grep -c stale-demo` = 0、`git status` 干净）。

**因此构建戳的定位收窄为**：正常路径下 HMR 会把新字节毫秒级送进页面；页面落后于磁盘只发生在
**HMR 没做成**（事件流断/被阻断/该页 boot 时通道不健康）或**写入与 `rebuilt` 之间**的窗口里。
三态含义随之更准确：`true` = 正常；`false` = 页面确实不是当前字节（先刷新，仍为 `false` 说明 DSH
没重建/事件流不健康）；`unknown` = 无法比较。`ctime` 也在 rev 里且用户态改不掉 ⇒ 只要文件被写就会
触发换新 ⇒ **HMR 健康时「页面版本已过期」几乎无法靠改文件稳定复现**（两次真机尝试都撞上 `true`
即是此因）。

**最小设计**：不引入构建步骤、不注入哈希、不加依赖。`client.js` 的 factory 正文由一对注释标记界定，
宿主读自己发布的 `client.js` 并对该区域做 32 位 FNV-1a（8 位 hex），在 ping 里以 `clientBuild` 返回；
页面则对**正在运行的**函数源码（`promptSettingFactory.toString()`）做同一算法的指纹，两边一比即知：

| 落点 | 内容 |
| --- | --- |
| `core/build.js`（新增，纯文本无 IO） | `FINGERPRINT_BEGIN/END`、`normalizeBuildText`（去首个 BOM、`\r\n?` → `\n`）、`fingerprintRegion`（标记须唯一且有序，否则 `null`）、`fnv1a32`、`fingerprintOf` → `{hash, size}` |
| `core/store.js`（仍是唯一碰 FS 的模块） | `clientBuildInfo(path)`：`readFileSync` + `statSync` → `{hash, size, mtime(ISO)}`；任何异常、或标记区域不可用 ⇒ `null`，**不抛**、不造指纹 |
| `index.js` | `CLIENT_BUNDLE_PATH = fileURLToPath(new URL('./client.js', import.meta.url))`；ping 响应加 `clientBuild: clientBuildInfo(CLIENT_BUNDLE_PATH)`，**每次请求现场读**（无缓存） |
| `client.js` | factory 由方法简写改为具名函数表达式 `factory: function promptSettingFactory(require) {`；`begin` 紧跟 `{`、`end` 紧贴闭合大括号前（区域覆盖整段正文）；体内内联一份等价纯实现 + `SELF_BUILD`；ping 由 fire-and-forget 改为消费响应 → `setBoot({self, server, pingFailed})`；状态条新增一行构建戳 + 三态；根容器挂 `data-build` / `data-build-server` / `data-build-match`；不等时渲染 `data-warning="client-build-stale"` 段落 |
| `CONTRACT.md` | Revision 6 + 新增 §14（字段、算法、归一化、三态、能/不能声称什么） |
| `README.md` | 新增「构建戳怎么读」小节（三态表 + 三条 `data-*` + 控制台一条命令） |
| `test/build.test.mjs`（新增） | 纯函数：FNV-1a 官方向量、归一化、四种坏标记 ⇒ `null`、区域内改 1 字符 ⇒ 摘要变、真实文件区域覆盖整段 factory 正文 |

**两个必须解释的实现细节**：

1. **标记字面量在 `client.js` 里被拆成两段拼接**（`'/* @build-' + 'fingerprint:begin */'`）。
   原因不是风格：区域要求两个标记各**恰好出现一次**，而内联实现若照抄字面量就会在文件里制造
   第二处标记 ⇒ `fingerprintRegion` 判为有歧义 ⇒ 所有人永久「未知」。拆分拼接让标记文本在文件里
   仍然只出现一次（`test/build.test.mjs` 断言 count === 1）。
2. **`size` 是归一化区域的 UTF-16 code unit 数，不是字节数**。这是两侧唯一能算出同一数值的长度：
   浏览器没有 `Buffer`，而 `readFileSync(path,'utf8')` + `charCodeAt` 能逐位复现宿主侧。
   `client.js` 含中文，字节数与 code unit 数并不相等 —— 如果把 `size` 定义成字节数，两侧就必须
   各自实现一份 UTF-8 编码器（客户端还得手写），这才是真正的脆弱点。契约里已写明这一点。

## 80. 三态与「绝不误报过期」

判定只有一句：**两侧都给出真实 hash 且相等 ⇒ `true`；都给出且不等 ⇒ `false`；其余一律 `unknown`。**
旧宿主（ping 无 `clientBuild`）、宿主文件读不到（`clientBuild: null`）、标记被改坏、ping 失败/网络错误
全部落到 `unknown`，并且**永远不会**渲染 `data-warning="client-build-stale"`。
`unknown` 也有自己的解释段落（`data-warning="client-build-unknown"`，ping 失败时点名是 ping 失败），
避免让「未知」看起来像「没问题」。页面的自身指纹在三种状态下都照样报出（`data-build`）——
页面永远知道自己在跑什么，只有「比较」可能未知。

`false` 的措辞是「页面版本已过期」，但契约里明说了它严格只意味着**两边字节不同**；而这句限定现在
更弱了：HMR 正常时页面几乎不会落后（§79），所以 `false` 要么命中「写入与 `rebuilt` 之间」的窗口，
要么说明这次 HMR 通道没生效。处置按 CONTRACT §14.3：**先刷新页面**；刷新后仍是 `false`，说明 DSH 侧
没有重建/事件流不健康 —— 这不是本插件能修的，也**不得**声称「刷新必然拿到新字节」（那属于 DSH 的
缓存/监视语义，见 §81.6 与 CONTRACT §14.5）。

## 81. 未验证项与「已接受的限制」（诚实清单，交给主管在集成检查点裁决）

1. **「DSH 服务的 `client.js` 区域字节与磁盘一致」尚未在真机抓取 payload 逐字节比对。**
   本轮的等价性证据全部来自 `node:vm`：`vm.runInContext(文件文本)` 之后 `factory.toString()` 的区域
   与文件区域逐位相同（`test/client.test.mjs` 第一条构建戳用例 + `test/build.test.mjs` 的区域用例）。
   追加的**静态复核**（读 `$P/dsh-client-modules/lib/index.js`，第 254/330 行附近）显示传输链上确实
   有改写，但都在区域之外：每个资源 `prepareSource` 剥掉**文件末尾**的 `//# sourceURL=` /
   `//# sourceMappingURL=` 尾巴、必要时补一个换行，`buildComboScript` 用 `;\n` 把多个 bundle
   拼接起来（可执行载荷见 `comboScript`）。⇒ 区域内的文本原样通过，自证摘要仍应相等。
   仍未做的是：真机抓一次浏览器实际收到的 payload，与磁盘区域逐字节对照。
   - 归一化只覆盖**去首个 BOM** 与 **`\r\n?` → `\n`**（这是最可能的改写，且有用例钉住）；
   - 若服务端在**区域内部**做了换行/BOM 之外的改写（压缩、去注释、任何重写），两侧摘要会不等 ⇒
     显示「过期」。方向上这是**可见**的失败（重写永远不会被报成「一致」），但它对本侧不可探测，
     所以列在这里而不是声称已测。
   - **主管补记（2026-09-28，据此把本条从「未验证」升为「区域层面已真机验证」）**：真机观测到
     `data-build-match === 'true'`（两次、路径不同）本身就是等价性证据——`data-build` 是页面用
     **实际执行的** `factory.toString()` 区域算的，`data-build-server` 是宿主读磁盘算的，两者相等
     即「DSH 传输后页面拿到的区域文本 == 磁盘区域文本」（同一 32 位 FNV 相等，仅余 2^-32 碰撞余量；
     静态复核又已排除区域内改写）。两次分别来自：① 文档 boot 时 `buildComboScript` 下发的那份；
     ② 区域内改动后由 HMR `prefetch` 重新取的那份。⇒ 仍缺的只有「整文件逐字节比对」，而它对本结论
     **不必要**（区域之外的任何差异都不进摘要）。
2. **真机三态：`true` 已观测，`false` 不可稳定复现，`unknown` 仍只有离线证据。**
   - `true`：主管真机（2026-09-28 23:48–23:51）在集成副本上看到 `data-build-match === 'true'`，
     `data-build = 63cf17c0`（改动前）；
   - `false`：HMR 健康时**无法靠改文件稳定造出**——改文件会让 rev 变、DSH 随即 rebuilt 并热替换，
     页面自动追上（§79 的真机实测就是这条路）。所以它目前**只有离线证据**：`node:vm` + fetch 桩
     的三条用例（同 hash / 区域内改 1 字符后的异 hash / 无 `clientBuild` 与 ping 失败）；真机上要
     稳定复现，得先让 HMR 通道失效（阻断 `/plugins/events` 或让该页 boot 时通道不健康）；
   - `unknown`：仍仅离线覆盖（旧宿主形态、`clientBuild: null`、ping 失败三种桩）。
3. **`data-build` 是否对所有客户端投影生效未验**：只有 `renderSection` 的根容器与 `renderFailureCard`
   带 `data-build`；页面在「渲染彻底失败」之外的降级路径都属于前者，但真机未逐路径核对。
4. **`clientBuild.mtime` 的实际用途未验**：目前只作为「宿主确实在读这个文件」的旁证暴露出来，
   UI 没有呈现它，也没有基于它做任何判断。
5. **已接受的限制（复核提出，必须明写）：标记区域只覆盖 factory 正文，区域外的改动是假「一致」。**
   这不是未验证项，而是自证式指纹的**固有边界**，写在这里是因为它与上面几条一起决定「这个戳能
   保证什么、不能保证什么」：
   - **精确边界**：`begin` 必须是 factory 体内的**第一条**语句、`end` 必须是**最后一条**，所以
     一切包围代码都在区域外 —— 文件头 51 行注释、`window.__ModuleLoader__.load({`、`id:` 行、
     `factory: function promptSettingFactory(require) {` 行，以及末尾的 `};` / `},` / `});`。
     `test/build.test.mjs` 用「区域必须包含 factory 体首条语句 `const React = require('react');`
     与末条语句 `'prompt-setting: section dictionaries'`」把标记**不会内缩**钉住；
     但没有任何断言能覆盖「函数外的文件内容变了」——这对 `factory.toString()` 结构上不可见。
   - **唯一失败方向**：只改区域外内容 ⇒ 摘要不动 ⇒ 跑旧字节的标签页会误报
     `data-build-match="true"`（假「一致」）。它**不会**造成假「过期」：假过期只可能来自
     区域**内**的改写（§81.1），两者方向相反，互不掩盖。
   - **为什么不能改成「整文件哈希」**：客户端唯一能拿到的自身字节就是 `factory.toString()` 的返回
     （模块加载器只交出函数源码，浏览器侧也没有原文件可读）。要覆盖整文件，标记就必须移到函数**外**，
     而函数外的文本根本不在 `toString()` 里 —— 那会把「自证」直接变成不可能，而不是变得更准。
   - **为什么可接受**：区域外只有注释与包装行；真正有语义的只有 `id` 与 factory 的绑定，
     而改它们属于罕见且**显眼**的改动（会改掉注册顺序/装卸行为，`node --test` 的注册断言也会红）。
     日常改动（组件、文案、路由消费、样式）全部落在 factory 体内，因此这条边界在实践中
     不会吞掉「需要开新标签」的那类编辑。
6. **语义差异（必须明写，不能暗示「刷新必然拿到新字节」）**：我们的 `clientBuild` 是**内容指纹**，
   每次 ping 现场读磁盘；而页面跑的是 **DSH 在最近一次 `rebuilt` 时捕获的 artifact**，其换新触发
   基于**元数据**（`mtimeMs`/`ctimeMs`/`size` 的 framed hash，rev 未变则不读文件、不发通知，§79）。
   于是「写入之后、`rebuilt` 之前」两者可以合法地不一致 ⇒ 此时判「过期」是**正确的**（页面确实不是
   当前文件）；但**刷新页面也可能拿到同一份旧 artifact**（DSH 未重建/监视未触发）⇒ 本插件不得声称
   「刷新必然生效」，这条属于 DSH 的缓存与监视语义。契约侧写在 CONTRACT §14.5，README 的三态表
   也按此改写处置列。
7. **未结案（不得再断言的原因）**：负责人更早那次「编辑面板交互长时间停留在 g-006 之前」的现象，
   本轮**撤回**原先的解释（「因为旧标签页不会更新」——该前提已被 §79 的真机 HMR 实测推翻）。
   目前它只是一个**未结案现象**，新假设空间（都未验证）：①该页 boot 时 `/plugins/events` 通道不健康
   （事件流被阻断/SSE 断线未重连）；②该次改动确实没有触发 rev 变化（例如写入发生在 DSH 监视
   覆盖之外，或安装副本与页面加载的那份不是同一个文件）；③页面加载的是另一份 artifact
   （combo/缓存命中了旧 rev）。**不**再把「旧标签页」当作已证结论；构建戳提供了区分它们的第一个
   观测点（先看 `data-build-match`，再看 `performance.timeOrigin` 是否变化）。

## 82. 自测证据（工作树 `.worktrees/g-008-att-02`，基线 `v0.1.0-test@512fe4c`）

```
$ node --test
ℹ tests 305   ℹ pass 305   ℹ fail 0   （基线 290 ⇒ 新增 15 项：build 8、store 2、route 1、client 4）
$ node --check index.js && node --check client.js && for f in core/*.js; do node --check "$f"; done
（全部 exit 0，无输出）
$ npm pack --dry-run            # npm_config_cache=/tmp/npm-cache-g008
npm notice total files: 14      # 既有 13 + core/build.js；test/ 命中数 0
$ node -e "…fingerprintOf(readFileSync('client.js','utf8'))"
{"hash":"63cf17c0","size":248093}   # 区域 = 整段 factory 正文
$ node -e "clientBuildInfo('/tmp/g008-att-02-does-not-exist/client.js')"
clientBuildInfo(missing) = null threw = null
```

`node --test test/` 在本机（Node **v24.13.1**）不是等价命令：它把 `test/` 当模块解析并抛
`MODULE_NOT_FOUND`（`node --test test` 同样）。规范命令是在包目录下跑 `node --test`（自动发现 `test/`），
`node --test test/*.test.mjs` 亦可。这是运行器行为，与本包无关，已在 README 注明。

独立复算（**不复用被测实现**）出现在三处：`test/build.test.mjs` 用官方向量 + 自己写的
`split` 计数与 `indexOf` 切片；`test/route.test.mjs` 的 `independentBuildFingerprint` 从契约文本重写；
`test/client.test.mjs` 同一函数独立重写，并断言
「vm 内运行实例的自身指纹 === 独立复算的真实文件区域指纹」（`data-build` 与之相等，`size` 也相等）。

## 83. 负向对照（逐条单独改坏 ⇒ 跑套件 ⇒ 从 `/tmp/g008-att-02-bak` 还原 ⇒ `shasum -a 256 -c` 确认逐字节回滚）

| # | 改坏方式 | 结果 | 还原 |
| --- | --- | --- | --- |
| ① | 删掉 `client.js` 的 `/* @build-fingerprint:end */` 行 | **8 红**：build 2（区域覆盖、区域内改字符）+ client 4（自证指纹与三态全部）+ route 2（ping 的现场复算与「不可读 ⇒ null」） | ✅ hash 回到 `a0555365…`，`node --test` 复绿 |
| ② | 区域**内**改 1 字符（`begin` 后第 40 字节，把注释里的 `e` 改成 `y`） | 摘要 `63cf17c0` → `3acb61a7`（`size` 不变 248093）——**指纹确实随内容变**；但该改动下全套件仍 305 绿，原因见下 | ✅ 同 hash 回滚，摘要回到 `63cf17c0` |
| ②′ | 让 `fingerprintOf` 不再跟踪内容（返回常量 hash） | **6 红**：build 3（区域切片即摘要、空区域、区域内改字符）+ route 2（ping 的独立复算与「改文件即变」）+ store 1 | ✅ `core/build.js` hash 回 `2b1b1992…` |
| ③ | 让 `clientBuildInfo` 在读失败时**编造**摘要（去掉 `null` 降级） | **2 红**：store 的「不可读 ⇒ null」+ route 的「删掉 bundle ⇒ `clientBuild:null` 且 200」 | ✅ `core/store.js` hash 回 `c78b8b68…`，复绿 |

**② 为什么单独一条不会变红（必须写明，不能含糊）**：本套件的所有期望值都是**从文件现场复算**的
（没有把真实摘要硬编码进测试），因此「把文件区域改 1 字符」会让被测侧与预言侧**同时**移动 ⇒ 全绿。
这是有意的设计：硬编码真实摘要会让任何一次合法的 `client.js` 改动都炸掉测试，从而很快被人删掉，
那种「会变红」是假的。②因此拆成两半取证：`63cf17c0 → 3acb61a7` 证明**指纹对内容敏感**；
②′（让算法不再跟踪内容）证明**这条敏感性是被断言钉住的**（6 处变红）。
②′ 的日志里 `client.test.mjs` 保持绿是预期：页面用的是 `client.js` 内联的那份实现，
与 `core/build.js` 是**两份独立实现**，宿主侧算法坏掉由 route/store 抓，客户端侧坏掉由 client 抓。

## 84. 本 attempt 明确**没有**做的事

- 没有构建步骤/哈希注入/打包器，没有新增依赖（`package.json` 只被读取，未被修改）；
- 没有改覆盖引擎、没有改既有 REST 语义：唯一契约变更是 ping 新增 `clientBuild`（含一处既有断言
  的字段列表更新，见 §85）；
- 没有安装/卸载插件、没有重启 `dsh web`、没有改 profile、**没有触碰 `~/.dsh/prompt-setting/*`**、
  没有读写真实用户数据（所有测试走临时目录与内存桩）；
- 没有改 `main` 分支，改动全部在 `.worktrees/g-008-att-02`；
- 没有删改削弱既有 290 项断言：只做「契约变更导致的字段断言更新」1 处（ping 的 key 列表）并追加 15 项；
- 没有调用 `cordis_inspect_query`（契约信息来自本包源码与 `CONTRACT.md`）；
- **本 attempt 自己**没有在真机浏览器验证三态与传输字节（见 §81）；真机上 `true` 那一次观测是
  主管在集成副本上做的（§81.2 / §79），本条不据为己有。

## 85. 与 brief / goal.md 的差异及理由（都写在这里，不藏）

1. **`clientBuild` 在「文件可读但标记区域不可用」时也是 `null`**（brief 只写了「读失败为 null」）。
   理由：此时没有任何可信摘要；如果说「文件读到了但 hash 是 null」，要么多一个形状、要么就得造一个
   指纹，而造指纹会被读成「过期」。`null` = 未知 = 三态的第三态，是唯一诚实的答案（CONTRACT §14.2）。
2. **ping 与 snapshot/overrides 的并发关系未变**：brief 要求「ping 改为消费响应」，没有要求改成串行。
   实现里 `sendPing()` 与 `load()` 仍是并发发起（URL 与请求集合都不变，既有「三条路由」断言不动），
   只是 ping 现在被 `await` 并写进 `setBoot`。
3. **`data-build` 额外挂在失败卡片上**：brief 只说根容器要挂三件套。失败卡片没有模型、也拿不到宿主，
   但它同样应该能回答「我是哪个 bundle」——这正是页面坏掉时最想问的问题，所以那里只挂 `data-build`。
4. **`size` 的定义写死为 UTF-16 code unit 数**（brief 只写 `size`）。理由见 §79.2；这属于把 brief 的
   模糊处说清楚，而不是改需求。
5. **`size` 没进 UI**：状态条只呈现两个 hash 与三态结论；`size`/`mtime` 留在 ping 响应里供机器读取
   （UI 上加长度只会增加噪声）。
6. **新增了一条「ping 现场读、不缓存」的端到端用例**（brief 只要求 route 用例「独立复算」）。
   做法是把整包复制到临时目录再 `import` 其 `index.js`，于是可以真的改那个副本的 `client.js`、
   甚至删掉它，从而证明「两次 ping 之间改文件 ⇒ 摘要变」「文件不可读 ⇒ `clientBuild:null` 且 200」。
   这是本轮唯一「比 brief 多要一点」的测试，理由是「不缓存」是本目标的核心断言，用 store 单测间接
   证明不如用路由端到端证明。

## 86. 第三次返工：真机推翻「旧标签页」前提（只改文档）

复核在真机验证过程中推翻了我们写进文档的一个**一般陈述**，本轮只改 `CONTRACT.md` / `NOTES.md` /
`README.md`（`client.js`、`core/**`、`test/**` 一字未动，摘要仍是 `63cf17c0` / `248093`）。

- **被推翻的**：「已经打开的标签页会一直跑它 boot 时的那份 `client.js`」。
  DSH 0.1.7-rc.2 自带客户端插件 HMR（`/plugins/events` SSE → `entries.reload(id, rev)` →
  `replace()` = prefetch → tearDown → import → refresh），文件一被写、rev 一变就会热替换，
  **无需重载文档**；主管真机实测（§79）已记录 `data-build` 在无操作下从 `63cf17c0` 变成 `77134de7`
  而 `performance.timeOrigin` 不变。
- **改成的表述**：页面落后于磁盘只发生在 **HMR 没做成**（事件流断/被阻断/该页 boot 时通道不健康）
  或 **写入与 `rebuilt` 之间**的窗口；构建戳三态的处置随之改写（`true` = 正常；`false` = 先刷新，
  仍为 `false` ⇒ DSH 侧未重建/事件流不健康；`unknown` = 无法比较）。落在 CONTRACT §14.1/§14.3、
  README「代码改动怎么生效」与三态表、NOTES §79/§80。
- **新增的语义差异**：`clientBuild` 是**内容指纹**（每请求读磁盘），页面跑的是 **DSH 在最近一次
  `rebuilt` 捕获的 artifact**（触发基于 `mtime/ctime/size` 的元数据，rev 未变则不读不发通知）。
  「写入后、`rebuilt` 前」两者可以合法不一致 ⇒ 判「过期」正确；但**刷新也可能拿到同一份旧 artifact**
  ⇒ 不得声称「刷新必然拿到新字节」。落在 CONTRACT §14.5、NOTES §81.6、README 三态表下的说明。
- **顺带收回一条旧解释**：负责人早先那次「交互长时间停留在 g-006 之前」的现象，不再断言
  「因为旧标签页不会更新」（前提已推翻），改为**未结案**并列假设空间（§81.7）。
- **顺带补一条静态复核**：传输链上的改写（`prepareSource` 剥 `sourceURL`/`sourceMappingURL` 尾巴、
  必要时补换行；`buildComboScript` 以 `;\n` 拼接）全部落在标记区域**之外** ⇒ 区域内文本原样通过；
  真机 payload 逐字节比对仍未做（§81.1）。

---

# 阶段一 C · 第六轮（g-009）：把「查看范围」树做成标准 ARIA 树（只动 client.js 渲染 + 测试 + 文档）

## 87. ARIA 树语义修正：`tree > treeitem + group > treeitem`

### 87.1 改动前的真实姿态（自己读代码确认，不照抄 brief）

- `role="tree"` 的**直接子项是每个工作区的裸 `div` 包裹层**（`scopeGroupElement` 的返回值
  `h('div', { key: 'g:'+key, style: {gap:1} }, nodes)`），包裹层里才是 `role="treeitem"` 的折叠行
  和会话行 ⇒ 实际形状是 `tree > div > treeitem`。标准树要求 `tree` 的直接子项只能是
  `treeitem` / `group`，这一条**不成立**（长期记忆里那条「已知未闭合」项说的就是它）。
- 折叠行**本来**就是 `role="treeitem"`（带 `aria-expanded`、`data-expanded`、Enter/Space、文件夹图标列、
  hover/focus 环），会话行也**本来**就是 `role="treeitem"` + `aria-selected`：缺的不是角色，而是
  **层级**（两者都没有 `aria-level`，也没人把「工作区」与「会话」的从属关系说清楚），以及
  `tree` 自己没有可访问名。
- 扁平降级分支（无 `useWorkspaces`）本来就是 `role="listbox"` + `role="option"`：角色自洽，
  只是 `listbox` 没有可访问名。

### 87.2 改成什么（`client.js`，函数级）

- `scopeGroupElement` → **`scopeGroupParts`**，返回 `[header, group|null]`：
  - **header**：`role="treeitem"`（不变）+ **新增 `aria-level: 1`**；`data-role="group-toggle"`、
    `data-scope-group`、`data-expanded`、`data-scope-contains-current`、`data-hover`/`data-focus`、
    `aria-expanded`、`aria-label`、`tabIndex`、样式、`onClick`/`onKeyDown`/`onFocus`/`onBlur` 与子节点
    （文件夹图标列/caret/label/path/count）**逐字不变**；只有 `key` 从 `'head'` 变成 `h:<key>`（因为
    它现在与 group 同级）。
  - **group**：**新增** `role="group"` + `aria-label` = 该工作区标题（未分组桶 = `未分组`/`Ungrouped`）；
    只有该工作区**确实有子行**时才渲染（关着的组不留一个空 group）。
  - **会话行**：`role="treeitem"`（不变）+ **新增 `aria-level: 2`**（`aria-selected` 早就有）。
- `scopeTreeElement`：`scope.groups.map(...)` → **`flatMap(...)`**，于是 `tree` 的直接子项正好是
  `treeitem`（工作区）与 `group`（其会话）；`tree` 新增 `aria-label`（复用 `sessionHeading`
  的 zh/en 文案，未新增词典键）。
- 扁平降级：`listbox` 新增同一个 `aria-label`；**不改角色、不加 `aria-level`**（取舍见 87.5）。

### 87.3 为什么 group 是 header 的兄弟，而不是 APG 里那种「group 嵌在 treeitem 内部」

- 折叠目标是**整行**（`onClick`/`onKeyDown` 都在 header 上，文件夹图标列也触发同一个 toggle，
  靠 `stopPropagation` 保证一次点击只翻一次）。若把会话行塞进 header 内部，点任一会话都会冒泡成
  一次折叠/展开，focus 环也会罩住全部子行 ⇒ **行为与观感双变**，直接违反硬约束。
- 「header 内层再套一层行 + 外层 treeitem 外壳」也不行：focus 环要么落到外层容器上（观感变），
  要么 treeitem 本身不可聚焦（语义反而更差），而且 `data-scope-group` 的唯一性会被两个节点争。
- 因此按 brief 明确写下的形状实现：**`tree` 的直接子项为 `treeitem` / `group`**，group 紧随它所属的
  工作区节点之后。未使用 `aria-owns` 把 group 声明给前面的 treeitem：需要稳定 id（本包目前不用
  `useId`/`aria-labelledby`，引入新 hook 依赖有风险），且不同 SR 对待 `aria-owns` 的差异较大 ——
  这条列进未验证项（87.6），不假装已经解决。

### 87.4 零观感变化的机械保证（可断言）

| 结构 | header→首行 | 组间 | 组内行间 |
| --- | --- | --- | --- |
| 旧：`tree{gap:2} > 包裹层{gap:1}` | 1px | 2px | 1px |
| 新：`tree{gap:2} > header`、`tree{gap:2} > group{gap:1, marginTop:-1}` | 2px + (−1px) = **1px** | 2px | 1px |

`tree` 与各行的**任何既有样式值都没改**；只是新建的 group 元素带 `gap:1`（等价于被它取代的旧包裹层）
与 `marginTop:-1`（抵消 `tree` 的 `gap:2`）。这两个值被新增测试钉住，免得以后有人改了 `tree` 的 gap
却以为「观感没变」。另外组内行间、`显示更多`/`隐藏 N 条`提示的间距都还在同一个 `gap:1` 容器里 ⇒ 不变。

### 87.5 扁平降级路径的取舍（brief 要求二选一，这里选「明确不宣称树」）

**选「不宣称树」**：降级分支继续 `role="listbox"` + `role="option"`，补一个可访问名，条目**不加**
`aria-level`。理由：降级分支没有工作区分组，只有一层被 `SESSION_MATCH_LIMIT` 截断的搜索结果；
套 `tree` 就必须给每行编一个层级（只能是 1），而 `tree` 里的「level 1」意味着根节点、可展开，
这里的行是搜索结果、不可展开 —— 收益为零而会误导 SR。测试把这条取舍钉死：扁平路径下
`role=tree`/`treeitem`/`group` 计数全为 0，且 option 上不存在 `aria-level`。

### 87.6 未验证项（诚实清单）

1. **真机屏幕阅读器（VoiceOver）未测**：本轮全部证据来自渲染树断言 + 311 项自动化测试；
   「SR 的播报顺序、是否会因为 group 是兄弟而非子节点而改变层级播报」**没有实测**。
2. **`aria-owns` / DOM 内嵌 group 未采用**（见 87.3）：部分 SR 可能不把同级 group 视为前一
   `treeitem` 的子级；实际层级靠 `aria-level` 兜底，真机未确认。
3. **`aria-setsize`/`aria-posinset` 未加**（目标描述里本就是可选项）：列表是**窗口化**渲染
   （每组 10 行起、`显示更多`到 50、全局 100 行上限、超出报「还有 N 条」），`aria-setsize` 会与实际
   可导航项数不符，宁可不宣称。
4. **像素级观感等价未截图对比**：87.4 是「按样式值推导 + 断言钉住」，不是像素 diff；
   `marginTop:-1` 在真机上的最终像素结果未逐像素校验。
5. 树节点上的 `aria-level` 是**我们写死的 1/2**（不是 SR 从嵌套推导出来的），这是有意为之：
   结构的真实深度就是两层，写死才与 DOM 一致（测试同时断言了嵌套链）。

### 87.7 证据（全部在 `.worktrees/g-009-att-01` 内执行）

```
$ node --check client.js && node --check test/client.test.mjs
（exit 0，无输出）
$ node --test                       # 包目录，自动发现 test/
ℹ tests 311   ℹ pass 311   ℹ fail 0   （基线 305 ⇒ 新增 6 项，全部在 test/client.test.mjs 的
                                       `#region g-009`；既有 305 项未删、未改、未削弱）
$ npm pack --dry-run                # npm_config_cache=/tmp/g009-npm-cache（本机 ~/.npm 有 root 属主文件，
                                    #  默认缓存会 EPERM；用临时缓存绕开，与代码无关）
npm notice total files: 14          # 与基线一致：仍只有运行时文件，test/ 命中 0
```

新增 6 项断言（都在 `test/client.test.mjs`，遍历**渲染出来的**树，不读源码字符串）：

1. `the「查看范围」tree is a standard ARIA tree`：`role="tree"` 且有名；直接子项只有
   `treeitem`/`group`（形状 `[treeitem w-alpha, group Alpha repo, treeitem w-beta, treeitem '']`）；
   每个 `group` 都有 `aria-label`（无名分组检测）；工作区节点 `aria-level=1` + `aria-expanded`，
   会话行 `aria-level=2` + `aria-selected=boolean`；**嵌套链**断言（level 1 的链为空、level 2 的链
   恰好是 `['group']`，中间插任何东西都会让链多一项 ⇒ 变红）；并对 `tree{gap:2}` /
   `group{gap:1, marginTop:-1}` 做间距等价断言。
2. 开合一个工作区：Enter 后出现 **新的、有名的** group（`beta-dir`）且行都是 level 2；Space 收起后
   该 group 消失（**不留空 group**）。
3. 搜索态形状不变：只留生存工作区的 `[treeitem, group]`；`Beta` ⇒ `beta-dir`；`Loose` ⇒ 未分组桶
   `['treeitem'(''), group(未分组)]`；同时断言「遍历得到的行集合 === 既有 helper 读 marker 得到的行集合」。
4. 没有任何工作区时：唯一桶仍是**有名 group**（`未分组`），6 个会话仍全是 level 2。
5. `显示更多`动作行：不是 treeitem、也不是 `tree` 的直接子项，而是**它的 group 内**的普通按钮；
   同组内的行数 = `SCOPE_GROUP_PAGE`(10) 且全是 level 2。
6. 扁平降级：`tree`/`treeitem`/`group` 计数 0，`listbox` 有名，option 上没有 `aria-level`。

### 87.8 负向对照（逐条「改坏 ⇒ 红 ⇒ 还原 ⇒ 绿」，`shasum -a 256 -c` 逐字节确认回滚）

| # | 改坏方式（只改 `client.js`，改完立刻还原） | 结果 | 还原 |
| --- | --- | --- | --- |
| ① | 会话行 `role: 'treeitem'` → `role: 'option'` | **5 红**（新增 6 项里除「扁平降级」那项外全红：角色集合、层级、嵌套链、形状断言命中） | ✅ `773b8ca3…` 逐字节回滚，6/6 复绿 |
| ② | `flatMap` → `map(h('div', …))`，在 `tree` 与 `treeitem` 之间插裸 `div` 夹层 | **5 红**（直接子项断言 + 嵌套链断言命中） | ✅ 同上 hash 回滚，复绿 |
| ③ | 去掉 group 的 `aria-label`（造出无名分组） | **5 红**（无名分组检测命中） | ✅ 同上 hash 回滚，复绿 |

- 「扁平降级」那项在 ①②③ 下**保持绿**是预期：它断言的是另一条分支（`role="listbox"`），
  与被改坏的树渲染无关 —— 这也顺带证明新增断言**没有**用「整页快照」这种会连坐的写法。
- 还原后 `git status --porcelain` 只有本 attempt 预期修改的文件（无残留 `client.js` 半成品、
  无未跟踪文件、无 `.tgz`）。

```
evidence: suite=client(node --test, packages/dsh-prompt-setting) passed=311 failed=0 exit=0 ms=7885 diff=2f/+321/-8 commit=2fac4d9
```

（该 commit 只含 `client.js` + `test/client.test.mjs`，即被验证的代码与测试本身；本 NOTES 与 README 的
文档改动在其后的提交里，不改任何被测字节。）

### 87.9 本轮明确**没有**做的事

- 没有改分组/排序/可见性规则，没有碰 `SCOPE_GROUP_PAGE/SCOPE_GROUP_MAX/SCOPE_TOTAL_MAX`/
  `SESSION_MATCH_LIMIT`/`SCOPE_GROUP_LIMIT`，没有碰搜索语义与分页边界；
- 没有改任何样式值、没有改视觉（文件夹图标列、caret、色条 + ✓、hover/focus 环）与交互行为
  （↑↓/Enter/Space/Esc、点行、点图标列各一次 toggle）；
- 没有改既有 `data-*` 标记，没有删改削弱既有 305 项断言（本轮**只增 6 项**）；
- 没有动 `core/**`、`index.js`、`package.json`、`cordis.patch.yml`；`CONTRACT.md` 里本来就没有树的
  ARIA 描述（已 grep 确认），故无需同步、也无漂移；
- 没有改 zh/en 词典键（`aria-label` 复用既有 `sessionHeading`，既有词典 parity 用例仍绿）；
- 没有调用 `cordis_inspect_query`；没有触碰 `~/.dsh/prompt-setting/*`、没有重启 `dsh web`、
  没有装/卸插件、没有改 profile、没有改 `main`；
- 没有做真机 SR 验证、没有做像素截图对比、没有加 `aria-owns`/`aria-setsize`/`aria-posinset`
  （见 87.6）。

## 88. 独立 profile 以 tarball 安装验证（g-011，2026-09-29，主管本人执行）

**为什么做**：发布前最后一块缺口。此前「可发布 npm」的安装证据只有「以 `link:` 装入本机 web
profile」，长期记忆里如实记为「未在独立 profile 安装验证」——别人拿到 tarball 能不能装上并挂起来
没有证据。本次用**全新 profile**（`g011`，从官方 web 模板初始化）真装一次，全程不碰当前 web
profile 与 `~/.dsh/prompt-setting/` 用户数据。

**步骤与证据**

| # | 命令 / 动作 | 结果 |
| --- | --- | --- |
| 1 | `npm pack`（包目录） | `dsh-prompt-setting-0.1.0.tgz`，206,799 B，**14 条**，sha256 `4053664ab8b6afb8…f81eaa9` |
| 2 | `dsh --profile g011 --from-default-profile web --dump-config` | 从官方 web 模板初始化出独立 profile |
| 3 | `dsh plugin --profile g011 add <tarball>` | 装为 `file:` 依赖，并**自动**把 `dsh-prompt-setting` 追加进该 profile 的 `dsh.profile.bundles` |
| 4a | `dsh --profile g011 --dump-config` | 组合树出现 `# == dsh-prompt-setting` / `- id: prompt-setting` / `name: dsh-prompt-setting` ⇒ 包 patch 生效、条目挂上 |
| 4b | 该 profile 下 `import('dsh-prompt-setting')` | 解析到 `profiles/g011/node_modules/dsh-prompt-setting/index.js`；`apply` 为函数；`inject` 恰为 `["webServer","connection","systemPrompt"]` |
| 4c | 装进去的 `client.js` 摘要 | `63cf17c0` / size `248093` —— 与仓库那份**逐字节同源**（tarball 里就是同一份字节） |
| 5 | `dsh --profile g011 --port 3099 --host 127.0.0.1` 起独立 GUI | 负责人目视：**Prompt 节出现**、**构建戳「与宿主一致」**、段列表正常、无错误横幅 |
| 6 | 清理 | 停止实例、删除临时 profile 与 tarball |

**零影响证明**：当前 web profile 的 `package.json` / `cordis.patch.yml` 在验证前后哈希逐字节一致
（`bfa8056f478b…` / `cd76ce2bd7c6…`）；3080 实例 pid 未变（**未重启**）；仓库 `git status` 干净。

**坑（写给后来者）**

- `dsh --profile g011 web --port 3099` 会报 `too many arguments. Expected 0 arguments but got 1: web`
  —— profile 自身声明了要跑的应用；正确写法是 `dsh --profile <name> --port <port>`（app 参数直接
  跟 launcher 参数）。
- 该实例启动时**会自动打开默认浏览器**（`--no-open` 可关）。
- 带 `?token=` 的 URL 对 `/prompt-setting/*` **仍是 401**：信任栅栏不看 URL token，只有页面自身的
  连接能过 ⇒ 这一层**无法用 curl 免浏览器验证**，目视检查是必需品。
- **结论：tarball 安装路径成立**（宿主半可解析、可加载、配置树挂载；客户端半在该 profile 的 GUI 可用）。

**本次仍未验**：该 profile 下跑真实对话回合的装配行为（本次只验安装与挂载）；`npm publish` 到
registry 未执行（人工 gate）。


---

## 89. 英文渲染横扫：测试桩按语言渲染 + en 全分支断言（g-010，2026-09-29）

**缺口（为什么需要这条）**：`test/client.test.mjs:934` 已断言 zh/en **键位相等**，`:940` 已断言每个错误码
中英文案**互不相同**；但既有用例全部把 `t` 绑在 `dict.zh`（测试桩里的 `dict()` 写死 `.zh`），
**从来没有用 en 词典渲染过页面** ⇒ 绕开 `t()` 的硬编码中文、`t()` 回落到裸 key 字面量，
自动化完全看不见。真机切英文是唯一曝光途径，而真机不可能穷举每一次渲染。

**一、测试桩改动（既有 zh 语义逐字节不变）**

| 改动 | 说明 |
| --- | --- |
| `dict(dictionaries, ns, key, language = 'zh')` | 多一个语言参数，**默认 `'zh'`**；`locale.bind` 的既有调用点行为不变 |
| `makePage({ language })` | `'en'` 时把 `props.t` 绑到注册词典的 `dict.en`；不传 = 老行为 |
| `page.text` | 新增：当前所绑语言的表（en 用例断言期望文案用）；`page.zh` 语义不变，311 条老用例零改动 |

**二、两条新用例（311 → 313）**

1. `client: the english render sweep shows no CJK and no bare key, in any branch`
   —— **34 个场景**，共扫 **10980** 条渲染字符串（含 `placeholder` / `title` / `aria-label` / `alt` / `value`
   这些**会显示文案的属性**，不只 children）。三类断言：
   - **零 CJK**：判据原文 `/[\u4e00-\u9fff]/`，**外加** CJK 标点/全角块 `\u3000-\u303f`、`\uff01-\uff60`、
     `\uffe0-\uffe6`（判据的严格超集）。失败信息给出 `chars`、命中文本、以及最近的 `data-*` 标记链
     （`region=… editor-entry=… tab-value=…`），可直接定位到分支。
   - **无裸 key**：① 含点 key（`error.not-found`）不得作为子串出现；② 标识符 token（`ovUser`、`stBuildStale`）
     只要是词典 key、且不在 **en 文案自身的词表**里，即判泄漏。
   - **词典自身完好**：以 **zh 的键集**遍历，en 侧必须存在、`trim()` 后非空、且值不等于 key 本身。
     删 key / 清空 key / 值等于 key 三种改坏都会红，**即使该 key 没被任何场景的 `copy` 声明覆盖**
     （N3/N4 就是靠这一条变红）。
   - 每个场景另断言 `copy`：指定 key 的 en 文案必须**真的出现在屏幕上**（否则就是「什么都没渲染所以没中文」）。
2. `client: the english sweep really walked every required branch marker`
   —— 把 **59 个 `data-*` 标记**作为**必达清单**断言，少一个就红。覆盖范围因此是**机器检查**的，不是文字承诺：
   `region=sections|filters|full|diff|overrides|history|history-diff|transfer|layer-reset|confirm|editor|session|session-tree|session-list|build|status`、
   `editor-entry=edit|append-new|edit-override`、`build-match=true|false|unknown`、
   `frozen-state=unfrozen|frozen|unknown`、`error-code=not-found|workspace-unresolved|assemble-failed`、
   `phase=empty|loading`、`empty=sections|history|overrides`、`renderer=fallback|primitives`、
   `diff-block=primitives`、`import-plan=true`、`diff-row` / `hd-row`、`render-state=error`，
   以及 **19 个 `data-warning=*`**：`client-build-stale` / `client-build-unknown` / `frozen` / `frozen-unknown` /
   `not-mounted` / `rendered-unresolved` / `scope-degraded` / `scope-archived-hidden` / `scope-truncated` /
   `scope-groups-truncated` / `session-degraded` / `session-no-match` / `full-filtered` / `truncated` /
   `entry-feedback` / `override-blocked` / `workspace-layer-disabled` / `edit-uncertain` / `edit-disabled`。

**三、覆盖的场景（34 条）**

段列表（默认 / 来源筛选 / 筛到 0 行 / 空装配 / 加载中）、全文视图（正文 / 搜索高亮 / 来源筛选 /
超 3000 行截断 / 未解析变量告警）、`base ↔ effective` diff、覆盖视图（覆盖列表 / 无覆盖 / 历史可读 /
历史损坏 / 历史 diff / 无法比较的 diff）、导入导出面板（干跑预览 / 冲突模式 / 被拒导入 / 二次确认 /
应用完成 / 下载成功 / 无下载面 / 整层重置确认）、编辑面板三个入口（`edit` / `append-new` / `edit-override`）
\+ 即时反馈（`entry-feedback`）+ 保存前拦截（`override-blocked`）+ order 非法 + 冻结不确定 + 禁用闸门、
构建戳三态（含 ping 失败）、错误横幅（`not-found` / `workspace-unresolved` / `assemble-failed` / 网络）、
冻结三态、未挂载、会话选择器（工作区树 / 归档提示 / 无匹配 / 扁平降级 / 两类行数上限）、
primitives 渲染分支、渲染失败卡片。

**四、横扫暴露并修掉的问题（3 处，全部属「绕开 `t()`」或「值回显标签」）**

| # | 位置 | 现象（en 渲染实测文本） | 修法 |
| --- | --- | --- | --- |
| 1 | `client.js:3383` 会话选择器「当前」胶囊 | 硬编码**全角冒号**，en 下渲染 `Current：Second` | 复用既有模板 `sessionCurrentLabel`（`fmt(t('sessionCurrentLabel'), { label })`）；**zh 输出逐字节不变** |
| 2 | `client.js:3941` 编辑面板「保存层」标签 | 硬编码**全角括号**，en 下渲染 `workspace layer（Disabled）` | 新增键 `ovWorkspaceDisabled`（zh `工作区级（未启用）` / en `workspace layer (disabled)`）；**zh 输出逐字节不变** |
| 3 | `client.js:3865` 编辑面板「可覆盖」**值** | 值取自 `fYes`/`fNo`，与同行标签 `editOverridableLabel` **同词** ⇒ `Overridable  Overridable`（zh 同样 `可覆盖  可覆盖`）。**负责人真机发现** | 新增**仅供该行**的 `fYesShort`/`fNoShort`（zh `是`/`否`、en `Yes`/`No`）；`fYes`/`fNo` **不动**（段列表行 Tag 用它们是正确的） |

- 新增键共 **6 个**（zh/en 各 3）：`fYesShort`、`fNoShort`、`ovWorkspaceDisabled`。
  独立复算：zh 262→265、en 262→265，**既有键的文案 0 处改动、0 处删除**，两套键集仍完全相等（各 265 + 36 个 `error.CODE`）。
- 唯一 **zh 可见变化**：编辑面板该行由「可覆盖」变「是」（即 #3 的修法本身，属修 bug）。
- 既有用例 `:2559` 因该契约变更更新为断言 `zh.fYesShort`，并**追加**「该行不再等于 `editOverridableLabel`」
  的断言（不是削弱，是更严）。

**五、同类「标签: 值」配对排查（应负责人要求）**

逐点数了所有「标签 + 紧邻值」行：`editOriginLabel`/`originRegistered`、`histLayerLabel`/`ovUser|ovWorkspace`、
`stMounted`/`stMountedOn|Off`、`stBuild`/`stBuildSame|Stale|Unknown`、`stBuildSelf`/哈希、`stBuildServer`/哈希、
`stPath`/路径、`stReason`/原因、`ovReason`/原因、`editLayer`/`ovUser|WorkspaceDisabled` ——
**只有 `editOverridableLabel` 与它的值同词**（已修，见上表 #3）。
另有一处**刻意保留**并记录在案：段列表筛选行的组标签 `filterOverridable`（`Overridable`）与它的三个**枚举选项**
`fAll`/`fYes`/`fNo`（`All`/`Overridable`/`Not overridable`）有一词重合 —— 那是「枚举选项」不是「值回显标签」，
改成 `Yes`/`No` 会同时改掉 zh 文案、且与同组另两个选项（`All`/`Default`）风格不一致，故**不动**。

**六、负向对照（逐条改坏 ⇒ 红 ⇒ 从 `/tmp` 还原 ⇒ 绿；`shasum -a 256` 逐字节确认回滚）**

基线 `client.js` sha256 `a24bb760946d94d20336c191fb2d7c4d66c36cde51f871233bc5e1cea45efced`，
**5 条对照的还原后 sha256 全部等于该值**，还原后 `git status` 只含本 attempt 的两处改动（无残留改坏）。

| # | 改坏内容 | 结果 | 命中的断言 |
| --- | --- | --- | --- |
| N1 | 状态卡标题插入硬编码中文 `` `${t('stateHeading')} 状态` `` | client 套件 92 pass / **2 fail** | `kind: cjk, chars: 状态` + 命中标记链 |
| N2 | 删掉 en 键 `title` | 91 pass / **3 fail** | `every en key must carry its own non-empty copy` |
| N3 | 删掉 en 键 `scopeSelected`（**任何场景的 `copy` 都没声明它**） | 91 pass / **3 fail** | 同上（证明这条网不依赖场景清单） |
| N4 | 把 en 键 `stMountedOff` 清成 `''` | 92 pass / **2 fail** | 同上（空串渲染成「什么都没有」，只有这条网抓得到） |
| N5 | 让一处渲染回落到裸 key：`title: t('scopeSelected')` → `title: 'scopeSelected'` | 93 pass / **1 fail** | `kind: bare-key, key: scopeSelected, text: scopeSelected` |

**七、真机证据（负责人执行，英文界面）**

- 负责人把 DSH 语言切到 **English** 后目视 **Scope / Status / Edit section / Filters** 四个区块：
  文案**完整**、**无裸 key 外露**、布局正常；
- 截图里的构建戳 `Build: Matches the host` / `This tab: 7e5115f5` / `Host: 7e5115f5` 与
  **合并 g-009 后的真实摘要一致**（本 attempt 独立复算该状态：`hash=7e5115f5`、`size=249937`，
  与截图逐位相同 ⇒ 负责人看的确实是本分支的客户端半）。**本 attempt 改动落在指纹区间内，
  合并后摘要变为 `7c48a4b1` / `size=250294`**，下次真机应看到新值且仍为「与宿主一致」；
- 左侧导航的 **`表情包` 属 dsh-meme 插件，不在本包范围**；
- 编辑面板内出现的中文段落是**被编辑的 section 正文**（用户数据），不是 UI 文案；
- 负责人同时发现了上表 **#3** 的「值回显标签」，本轮已修。

**八、未覆盖 / 待验（诚实清单）**

- **真机 English 下的 `Full text` / `Overrides`（历史 · diff · 导入导出）三块本轮未目视** ——
  负责人本轮只看了上述四区块。这三块由本文的**离线横扫**覆盖（含 `data-region=full|diff|history|history-diff|transfer` 的必达断言），
  **真机目视由负责人补看，本 attempt 不声称已验证**。
- **不覆盖**（横扫刻意不管，也不该由本插件负责）：
  1. **原生控件文案** —— `<input type="file">` 的文件选择器按钮、浏览器日期/时间控件等由浏览器本体出字，
     不在本插件的 `t()` 管辖范围；
  2. **DSH 自带 UI 的文案** —— 宿主与其它插件的界面；
  3. **宿主返回的 `message` / `reason` 原文** —— 本插件按契约原样透传（便于排障），**不翻译**；
     它们的语言由宿主决定，横扫里用的是英文 fixture，因此不会把宿主中文误判为本插件泄漏。
- **不覆盖**：真机屏幕阅读器（SR）朗读、真机语言切换的**热替换**时序（横扫用的是桩，不能替代真机）。
- `errTitle`（`请求失败` / `Request failed`）经排查在**所有** `errorBanner` 调用点都被显式 `title` 覆盖，
  **当前渲染不可达**。本轮**不改**（无渲染影响、改它反而要动调用点），只在此记录；键位仍由 `:934` 维持。

**九、自测证据（本 attempt；worktree `.worktrees/g-010-att-01`，基线 `v0.1.0-test@f363b55`）**

```
evidence: suite=node --test(packages/dsh-prompt-setting) passed=313 failed=0 exit=0
evidence: suite=node --test(test/client.test.mjs) passed=94 failed=0 exit=0
evidence: pack=files 14 / test-hits 0
```

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test`（包目录） | **313 tests / 313 pass / 0 fail**（基线 311 ⇒ **+2 条新用例**，无删改削弱） |
| 客户端套件 | `node --test test/client.test.mjs` | 94 / 94 pass |
| 打包 | `npm pack --dry-run --cache /tmp/g010-npm-cache` | **14 个文件**，`test/` **命中 0**，package size `220.7 kB`，tarball shasum `1da004675dff2d5864e3cb746e4a98ab8f5a24a8`（本文件定稿后重跑） |
| 词典 | 独立复算（非套件内） | zh 262→265、en 262→265，**既有键 0 改动 / 0 删除**，键集完全相等 |
| 新增键 | — | `fYesShort`(是/Yes)、`fNoShort`(否/No)、`ovWorkspaceDisabled`(工作区级（未启用）/workspace layer (disabled)) |
| 构建戳 | 独立复算 `@build-fingerprint` 区间 | 改前 `7e5115f5` / `249937`（= 负责人截图值）⇒ 改后 `7c48a4b1` / `250294` |

## 90. 编辑已有段改为**行内就地展开**（g-012，2026-09-29，基线 `v0.1.0-test@aed9bc8`）

**缺口（负责人真机报的 UX 问题）**：`renderSection` 把 `editor-slot` 插在视图页签之后、主面板之前
（原 `client.js:4993-4994`），于是点段列表**下面**某一行的「编辑」后，表单渲染在**视口之上**——
列表越长越糟，用户必须手动滚回顶部才看得到自己刚点开的表单。

**一、改动点（函数级；只动 `client.js` / `test/client.test.mjs` / 本文 / 包 `README.md`）**

| 函数 | 改动 |
| --- | --- |
| `editorPlacement(m)`（新增，在 `editorEntry` 旁） | 唯一的「表单该画在哪」判定：`append-new` ⇒ 页面槽位；行内作用域 entry ⇒ 该行在屏（`view === 'sections'` 且过 `passesFilters`）则 `{inline:true,row}`，否则 `{inline:false,row,fallback:'row-hidden'}` |
| `editorFocusRole(editor)`（新增） | 焦点落点：`append-new` ⇒ `'name'`，其余 ⇒ `'text'` |
| `renderEditor(t,m,a,placement,rootRef)` | 新增 2 个参数；根节点在既有 6 个标记之外新增 `data-editor-row` / `data-editor-fallback` / `data-editor-focus`，并把 `ref` 挂到根 `<section>` |
| `sectionRow(t,m,a,section,inlineEditor)` | 多一个「本行的表单」子节点，**渲染在该行容器内、行内容之后** |
| `renderSectionsView(t,m,a,inlineEditor)` | `{row,element}` 只交给 `row === section.name` 的那一行，其他行拿到 `null` |
| `renderSection(t,m,a,rootRef)` | 调 `editorPlacement`；`inline` 时**不再**往 `editor-slot` 推，否则沿用原槽位 |
| 组件（`promptSettingFactory` 内） | 新增 `React.useRef` + 一个焦点 `useEffect` + `editorRootRef`；`renderFailureCard` 兜底路径不变 |
| 测试桩 | hooks double 补 `useRef(initial)`（**纯新增**：既有 hook 顺序与索引不变，313 条老用例零改动） |

**二、与 brief / goal.md 的三处差异（都按代码事实办，不按 brief 字面办）**

1. **`edit-override` 不是覆盖视图的入口——brief 的事实错误。** brief 与验收项 2/4 假定
   「覆盖视图的『编辑本覆盖』= `data-editor-entry="edit-override"`（约 `client.js:4926`）」。
   实际：`:4926` 是覆盖条目的 `data-action="reset-section"`（「恢复默认」）；全仓**只有**一个编辑入口——
   `sectionRow` 的 `data-action="edit"`（原 `:3693-3701`），开哪个 entry 由 `editorRoute`（`:2035`）决定：
   段名在装配里 ⇒ `edit`，只是我们自己的覆盖 ⇒ `edit-override`。两者**都是段列表里的行**，而覆盖视图
   （`data-region="overrides"`）只有 `undo` / `reset-section`，**从来没有**任何编辑入口。
   ⇒ 取舍（主管已复核并采纳，原判据 4 作废）：**所有行内作用域 entry（`edit` 与 `edit-override`）都在
   其所属行内展开**，`append-new` 留在页面槽位；另加断言「覆盖视图内不含编辑器」。
2. **段列表没有搜索框、没有分页。** `renderSectionsView` 是 `sections.filter(passesFilters)` 之后**全量渲染**；
   `m.search` 只服务全文视图。能隐藏一行的**只有**三个触发源：① `renderFilters` 的三个筛选；
   ② 视图页签切走；③ **快照重载后该段不再返回**（装配本身变了）。降级路径按这三个触发源实现与断言。
3. **降级回退是「位置」决策，完全不碰 `editor` 状态。** 已输入内容不丢是**同一个 state**的直接结果，
   不是额外保存逻辑；行回来后表单自动回到行内。

**三、新增用例（313 → 321，+8 条；既有 313 条零删改削弱）**

| # | 用例 | 钉住什么 |
| --- | --- | --- |
| ① | `editing a section draws the form inside that section row` | `data-editor-row` 指向该行，**且** `owningRows()`（祖先链）证明表单真的在 `data-section-row` 内部；`data-region=editor` 全树**仍唯一**；既有 6 个标记逐一不变；表单在行内容**之后**；其他行没有它 |
| ② | `the append entry owns no row and keeps the page-level slot` | `append-new` 无 `data-editor-row`/`data-editor-fallback`；不在任何行内、也不在 `data-region=sections` 内；仍在列表**之前** |
| ③ | `an own-override row opens its form at its own entry` | `edit-override` 也在其所属行内；切到覆盖视图后覆盖视图内**不含**编辑器，表单带 `row-hidden` |
| ④ | `a filtered-away row sends the form to the slot without losing the text` | 触发源 ①：`origin` 筛选藏掉该行 ⇒ 槽位 + `row-hidden` + 归属名仍在 + **文本逐字未丢**；清筛选后**回到行内** |
| ⑤ | `a view switch keeps an open row form reachable` | 触发源 ②：切到全文视图 ⇒ 同一回退 + 文本未丢 |
| ⑥ | `a row that a reload removes sends the form to the slot too` | 触发源 ③：**刷新后快照不再返回该段** ⇒ 同一回退 + 文本未丢（与 ④⑤ **同码路、不同触发源**，单独用例钉住，不再只靠横扫） |
| ⑦ | `opening an edit form puts the caret in the text, once per session` | 焦点：`data-editor-focus=text`；桩 `ref` 接上「已提交节点」后**恰好**聚焦一次；**再渲染（打字 / 切 layer）不抢回焦点**；关闭后重开同一行**重新武装** |
| ⑧ | `the append entry puts the caret in the name field` | `data-editor-focus=name`，且桩 `ref` 只对 `[data-role="name"]` 调 `focus()` |

**四、en 横扫同步加强**：3 个既有 editor 场景各补 `data-editor-row=harness:identity` /
`data-editor-focus=text|name` / `data-editor-fallback=row-hidden`；必达清单 `EN_REQUIRED_MARKERS`
由 **59 → 63** 项（§89 记的是当时的 59）。新增标记在 en 下同样零 CJK、零裸 key；**未新增任何 `t()` 键**。

**五、负向对照（改坏 ⇒ 红 ⇒ 从 `/tmp/g012-neg` 还原 ⇒ `shasum -a 256` 确认逐字节回滚）**

| # | 改坏 | 结果 |
| --- | --- | --- |
| N1 | `editorPlacement` 对行内作用域 entry 永远返回 `inline:false`（= 退回旧的「顶部单面板」） | **5 条红**：① ③ ④ ⑤ ⑥ |
| N2 | `renderSection` 的槽位条件加上 `placement.fallback === null`（= 去掉降级路径：行不可见时**根本不再渲染表单**） | **7 条红**：③ ④ ⑤ ⑥ + 既有 `the pre-save check still fires when the world moves under an open panel` + 两条 en 横扫（含 `data-editor-fallback` 必达项）。**既有用例也会红** ⇒ 降级路径是**既有行为的承重件**，不是新加的装饰 |

N1、N2 都做了两遍：第一遍在实现定稿前跑，第二遍**在最终交付内容上重跑**，红集**逐条相同**（5 / 7），
两次还原后 `shasum -a 256` 都逐字节回到备份值。
最终交付内容：`client.js` = `989fbddd546f4a63732247983acac3e9b53537fa00819df42e023fce5d73e323`、
`test/client.test.mjs` = `465a4a78fb93c07addb2ce833207e6550d1c746c5c3e2ee83265bac0b136f698`
（前者比第一遍的 `1f63f10c…` 多了 `editorPlacement` 上一处**纯注释**措辞修订，无行为差异，改后全量仍 321 绿）。

**六、未验证 / 未做（诚实清单）**

- **真机（真实浏览器 + 长列表）的落点与手感未验**：列表很长时点下面的行，表单确实在行内展开，
  但「展开后该行是否仍完整在视口内、是否需要把表单顶部滚进视口」**没有真机数据**——本轮只有渲染树级断言。
- **跨浏览器 / 深列表下的滚动锚定（scroll anchoring）与布局抖动未验**：本包不使用 sticky；行内展开会让
  该行变高，是否引起浏览器滚动锚定跳位、下方行位移的手感，**未在不同浏览器上验证**。
- **primitives 分支下 `data-role="name"` 是否被官方 `Input` 透传到 DOM 未验**（`UI.Input` 在 primitives 分支
  委托给 `primitives.Input`；文本区不受影响，`UI.Textarea` 两个分支都是自绘 `FxTextarea`）。
  兜底是**优雅降级**：查不到节点就不聚焦，不报错、不改变任何行为。真机若见「新增一段」不落焦，即此因。
- **未做**：自动滚动 / 吸顶面板（负责人已选定行内展开）；覆盖引擎与 REST 契约零改动；零新依赖。
- **未验**：真机屏幕阅读器对「行内展开」的朗读顺序（表单现在是行的子节点，读序会变，需 SR 实测）。

**七、返工 R1：行「编辑」变成开关（第三轮，负责人真机反馈）**

**设计依据 = 对齐 DSH 自身的「设置 → 模型」行展开**（负责人明确指定）。这条依据本 attempt 独立核对过，
不是照抄一句口头结论——读本机 pnpm global 里的
`@deepseek-ai/dsh-client-ui-settings-models@0.1.7-rc.2/lib/client.js` 可见：

- 行内按钮：`jsx("button", { type: "button", className: …["iconButton"], "aria-label": …, "aria-expanded": props.expanded, title: t("modelAdvanced"), onClick: props.onToggle, children: props.expanded ? jsx(IconChevronDown…) : … })`；
- 状态：`const toggleExpanded = (index) => { setExpanded((current) => { const next = new Set(current); if (!next.delete(index)) next.add(index); return next; }); };`

⇒ **对齐的是「同一个按钮开/关 + 用 `aria-expanded` 报告状态」这条语义**。
**刻意不对齐的一点**：DSH 的模型页用 `Set` 允许**多行同时展开**，而本插件是**单一编辑器**——
表单是单实例状态 `editor`，`data-region="editor"` 必须全局唯一。所以打开另一行是**切换**（原行收合）
而不是叠加。此处写明，避免被读成漏做。DSH 的按钮展开时会换成 chevron 图标，本插件**不加图标**
（会改动行的既有观感，且要引入未在此处验证过的 artwork）。

| 位置 | 改动 |
| --- | --- |
| `openEditor`（actions） | 先判「这一行是否**正持有**打开的表单」（`editorEntry(editor) !== 'append-new'` 且 `section.name === editor.name`）⇒ `setEditor(null)` 折回。判定**在 gate 之前**：收合永不需要许可，能打开它的按钮必须能关掉它。只有**行内作用域**会话可被行切换 —— `新增一段` 归页面所有，任何行都不能关它（R6 钉住） |
| `sectionRow` 的「编辑」按钮 | `'aria-expanded': String(editorOpen)`，`editorOpen = inlineEditor 非空`，即「本行持有打开的表单」这**同一个**事实，不是它的副本；激活态只改 `color` / `background`，`font` / `fontSize` / `padding` / `borderRadius` / `border` **逐字节等于其它行** ⇒ 零布局位移（R2 逐属性断言） |
| `disabled` | `gate.disabled` ⇒ `gate.disabled && !editorOpen`：表单在**自己这一行**里开着时按钮必须可点，否则没法靠它收合。既有「冻结 ⇒ disabled」用例不受影响（那时没有打开的表单），321 项全绿已证 |
| 「取消」 | 保留不动：`closeEditor`、文案、既有用例全未触碰 |

**八、返工 R2：展开后最小滚动入视口（第三轮，负责人真机反馈）**

**需求**：点靠视口底部的行 ⇒ 表单下半截在屏外。**实现**与「焦点落文本区」共用同一个「打开会话」武装点：

- 面板 **root** 的 `ref` 是滚动与焦点共同的入口（root 在两个 renderer 分支都是 host 元素 `<section>`）。
- 顺序 **先滚、后聚焦**；两件事各用各的闩锁（`scrollKey` / `focusKey`），因为成功条件不同：
  滚动只要「有节点」，焦点还要求「节点里有目标控件」。合成一个闩会让其中一件在另一件失败时反复重试。
- 调用 `node.scrollIntoView({ block: 'nearest' })`，并以 `typeof node.scrollIntoView === 'function'` 保护：
  桩 / 老实现没有该方法时**不调用、不抛**，面板照常打开、焦点照常落（R5）。
- `nearest` 是**最小滚动**：元素已在视口内则**不动**；`start` 会把整页拉走、丢掉用户刚点的那一行，
  所以**禁止**（R4 显式断言 `block !== 'start'`）。
- **一次性**：打字 / 切 layer / 再次渲染都**不再滚**（R4 用两个桩 root 断言第二次 0 次调用）；
  折叠（`editor === null`）清空两个闩，重开同一行**重新武装**滚动与焦点（R7）——即「不得因滚动导致
  焦点被抢或在输入时反复滚动」。
- `target.focus()` 保持上一轮的调用形态（**不加** `preventScroll`）：滚动在前保证它通常是 no-op，
  而「焦点若在视口外，浏览器也会把它带进视野」正是「表单下半截在屏外」的另一半。

**九、负向对照（4 条；改坏 ⇒ 红 ⇒ 从 `/tmp/g012-neg` 还原 ⇒ `shasum -a 256` 逐字节确认回滚）**

| # | 改坏 | 结果 |
| --- | --- | --- |
| N1 | `editorPlacement` 对行内作用域 entry 永远返回 `inline:false`（= 退回「顶部单面板」） | **10 条红**：§90 三节的 ①③④⑤⑥ + R1 R2 R3 R6 R7 |
| N2 | `renderSection` 槽位条件加 `placement.fallback === null`（= 去掉降级路径） | **7 条红**：③④⑤⑥ + 既有 `the pre-save check still fires when the world moves under an open panel` + 两条 en 横扫（含 `data-editor-fallback` 必达项）。**既有用例也红** ⇒ 降级路径是既有行为的承重件 |
| N3 | 删掉 `openEditor` 的同行开关判定（= 再点已展开的行仍走 `openEditor` 而**不关闭**） | **3 条红**：R1 R6 R7 |
| N4 | 保留闩锁但删掉 `node.scrollIntoView(...)` 调用（= 去掉滚动，其余不动） | **2 条红**：R4 R7 |

四条各自「只改一处 → 跑套件 → 立刻还原」。**在最终交付内容上重跑，红集与首遍逐条相同**；
还原后 `client.js` = `0fb7c1ea67b50737055083b5b9a54df0b64d742114b606e43d943c7701ea5308`、
`test/client.test.mjs` = `353b684f9648560a9135662dafda035781d9f5804213086f93940b2aa25bf874`
（与改坏前逐字节一致），随后全量重新全绿（328 / 0 fail）。

**十、返工 R1/R2 的新增用例（321 → 328，+7 条）**

| # | 用例 | 钉住什么 |
| --- | --- | --- |
| R1 | `the row switch closes the form it opened` | 再点同一行「编辑」⇒ 表单消失、`aria-expanded=false`、按钮恢复可编辑、行本身仍在、控件全无 |
| R2 | `only the row that holds the open form reports itself expanded` | 5 行开关的 `aria-expanded` 全景（开前全 `false`、开后**只有**该行 `true`）；激活态是**纯绘制**：`font`/`fontSize`/`padding`/`borderRadius`/`border` 与未按下的按钮逐属性相同，其它行 `background` 仍为 `transparent` |
| R3 | `opening another row folds the first and moves the one form` | 点另一行 ⇒ 仍只有 1 个 `data-region=editor`、归属切到新行、文本是新行自己的 `identity base`、原行 `aria-expanded=false` 且行内无表单 |
| R4 | `expanding a row pulls the form in with the smallest scroll` | 桩记录到**恰好一次** `{block:'nearest'}`；断言 `block !== 'start'`；打字与切 layer 后仍只有那一次；后一次渲染交接的新桩 root 为 0 次滚动、0 次聚焦 |
| R5 | `a node with no scrollIntoView is survivable` | 节点无 `scrollIntoView` ⇒ 不抛、面板照常、焦点照常落 |
| R6 | `a row cannot fold the append entry it does not own` | 在 `新增一段` 里把名字打成某行的名字后，点该行「编辑」是**切换**（不是折叠）；随后同一按钮才折叠 |
| R7 | `folding and re-opening the same row re-arms scroll and caret` | 折叠后旧桩不再被调用；重开同一行 ⇒ 滚动与焦点**各重新武装一次**，`aria-expanded=true` |

**十一、单位/兼容性未验项（R1/R2 专有，与 §90 六节并列）**

- `scrollIntoView(options)` 的**对象签名**是 CSSOM View 标准，但**旧实现会把任何参数当作布尔
  `alignToTop`**（等价 `block:'start'`）。本项目实际宿主是 DSH Web GUI（Chromium 系），对象签名受支持；
  **其它浏览器 / 旧 WebView 未验**——在那些实现上会退化为「把该行顶到视口顶部」。
- **真机滚动锚定（scroll anchoring）未验**：行内展开会让该行变高，浏览器可能自行微调滚动位置、
  或让下方行位移；未跨浏览器验证。
- **「先滚后聚焦」在真机上是否出现可见的两段滚动未验**：离线只能断言调用次数为 1；
  未采用 `preventScroll`（理由见八节）。
- **真机手感未验**：`nearest` 对「比视口还高的表单」的实际落点（顶对齐还是底对齐）未在真机上目视确认。

**十二、自测证据（worktree `.worktrees/g-012-att-01`，基线 `aed9bc8` ⇒ 本返工基于 `68d5881`）**

```
evidence: suite=node --test(packages/dsh-prompt-setting) passed=328 failed=0 exit=0
evidence: suite=node --test(test/client.test.mjs) passed=109 failed=0 exit=0
evidence: pack=files 14 / test-hits 0
evidence: fingerprint aed9bc8=7c48a4b1/250294 -> now=42061a2a/260711
```

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test`（包目录） | **328 / 328 pass / 0 fail**（第一轮基线 313、首轮交付 321 ⇒ **本轮 +7 条新用例**，既有 321 条零删改削弱） |
| 客户端套件 | `node --test test/client.test.mjs` | 109 / 109 pass（首轮 102） |
| 打包 | `npm pack --dry-run --cache /tmp/g012-npm-cache` | **14 个文件**，`test/` **命中 0**，package size `232.2 kB`，tarball shasum `99addab2bc0d1d8300d39494240f69e29b795769`（自指提示：把该值写进本行会再改一次 shasum；**文件数 14 与 `test/` 命中 0 不受影响**，与 §89 同一处置） |
| 词典 | 既有用例 `client: injects the locale namespace thunk and declares zh/en dictionaries`（`:1002`，键集相等断言在 `:1013`） | 绿；**两轮都未新增 / 未改动任何 i18n 键**（toggle 与滚动都不产生文案） |
| 构建戳 | 独立复算 `@build-fingerprint` 区间 | 改前 `7c48a4b1` / `250294`（= §89 的预测值）⇒ 首轮 `ab715bbd` / `257592` ⇒ 本轮 `42061a2a` / `260711` |
| 仓库根 `README.md` | 检查 | 仅路线图里的「就地编辑」（`:18` / `:66`），**本就是此行行为的描述，无需改** |

## 91. boot 韧性：导入期自检 / `apply` 防护 / 客户端半硬化（g-013，2026-09-29，基线 `v0.1.0-test@3aadadf`）

**缺口（负责人要求）**：「预防 DSH 以后可能出现的破坏性更新：如果插件在 boot 阶段加载失败，
**要在终端打印信息**，并且**不能影响 DSH 的正常启动**。」

### 一、结论先行：哪一种失败我们能在插件内处理，哪一种不能

先读源码（`@deepseek-ai/cordis-plugin-loader@0.1.7-rc.2/lib/index.js` + `@deepseek-ai/cordis@0.1.7-rc.2/lib/index.js`），
再用真包实测一次（下面二、三节）。结论四条，**每条都决定了一处实现边界**：

| # | 失败形态 | 源码事实 | 插件内能否处理 |
| --- | --- | --- | --- |
| ① | **import 期抛错**（`index.js` 顶层/语法/依赖解析） | `Entry._init()`：`try { exports = await this.parent.tree.import(name) } catch (error) { this.ctx.logger.error(error); return; }` ⇒ boot 继续 | **不能**：模块顶层已经炸了，我们自己的代码一行都没跑。平台至少会打 `failed to import`（见二节） |
| ② | **`cordis.patch.yml` 不合法**（未知 verb / schema 变动） | 失败发生在 loader 把 patch 组合进 profile 树时，**早于**任何 `import(name)` | **不能**：连「本插件被 import」都没发生。**实测终端完全没有输出**（最糟） |
| ③ | **`inject` 的服务消失** | Cordis `Fiber._refresh()`：`inject` 的每个服务都要有实现，否则 `epoch = INACTIVE`；`_reload()` 根本不执行 `runtime.callback`（= 我们的 `apply`）。loader 只打 `expected service <name> to be implemented`（`isolate()` 路径），Cordis 侧打 `pending (waiting for service: …)`（见二节实测） | **不能**：我们的 `apply` **根本没被调用**。这条只能靠「导入期自检」+ 文档 |
| ④ | **`apply` 期抛错**（服务方法改名/缺失、方法抛错、返回形状不符…） | `Entry.init()`：`this.fiber?.await().then(notify, notify)` ⇒ apply 的失败被**吞掉**，boot 继续；终端只有原始堆栈 | **能**：这是唯一一处我们 100% 掌控的失败面 ⇒ g-013 的 `apply` 全程 try/catch + 清理 + 单条可读信息 |

**为什么「导入期自检」是唯一能覆盖 ①②③ 的插件内手段**：它在 `module` 顶层执行、**不依赖任何注入服务**
（因此不依赖 ③ 的 `inject` 是否齐备）、也不依赖 patch 组合成功（②如果失败我们虽然不执行，但一旦执行就说明
patch 至少组合到了本插件这一行）。所以「范围内静默 / 超范围一条 / 探测失败一条」写进了 `index.js` 的顶层。

### 二、主管实测：四种失败形态 × 终端原文（逐字，本机 DSH `0.1.7-rc.2`，临时 profile）

| # | 失败形态 | DSH 是否正常启动 | 终端原文（逐字） |
| --- | --- | --- | --- |
| ① | import 期抛错 | ✅ 仍启动（照常打印 web URL） | `dsh: warning: 1 entry did not activate`<br>`g013-badjs (dsh-g013-badjs): failed to import` |
| ② | patch 里未知 verb（`insertt:`） | ✅ 仍启动 | **完全没有输出**（插件静默不激活）← **最糟，平台不报** |
| ③ | `inject` 的服务不存在 | ✅ 仍启动 | `…g013-badservice (dsh-g013-badservice): pending (waiting for service: definitelyNotAServiceInAnyDSH)` |
| ④ | `apply` 期抛错 | ✅ 仍启动 | `…g013-applythrow (dsh-g013-applythrow): Error: G013-APPLY-MARKER: …` + 完整堆栈（含 `#g013-applythrow` / `#include`），**没有任何指引** |

> 更正：本 attempt 的 brief 早先写「import 失败时终端只有一坨堆栈」**不准确**——平台有汇总行 +
> `<id> (<name>): failed to import`。上面的表是修正后的版本。

**形态④ 的真机可复现触发（主管 2026-09-29 实测；本文档承诺的文案被逐字命中）**：临时 profile 里**先**装一个
抢占 `/prompt-setting` 前缀的插件、**再**装本包（`webServer.register()` 对重复前缀直接抛），启动 12 秒抓终端：

```text
[dsh-prompt-setting] 插件 0.1.0 挂载失败，本插件已停用，DSH 其余功能不受影响。检测到的 DSH：0.1.7-rc.2。首因：webserver: duplicate prefix route "/prompt-setting"。已撤销 0 项已注册 effect，不会留下半挂载。排查与救援见 README「兼容性与救援」。
dsh web: http://127.0.0.1:3086/?token=…
```

- 「已撤销 0 项」是对的：路由是**第一个**注册项、它自己就抛了，此时没有已注册的 effect 需要回滚；而监听器
  因为在路由**之后**注册，所以**从未挂上**（这正是第五节把路由放在前面的理由之一）。**DSH 照常启动**。
- 同一批实测的第三项（范围内正常加载）终端里**没有任何 `[dsh-prompt-setting]` 行** ⇒ 静默分支也真机通过。

### 二之补、平台自己还有一道**更早**的闸门：bundle 兼容性（第五条签名，改写了「超范围」分支的表述）

同一批实测还抓到一条本 attempt 早先没记录的签名：**平台在 boot 期读 profile 的 `dsh.profile.bundles` 时，
就对每个 bundle 跑一次 peer 兼容性检查；不通过就整条跳过并点名**：

```text
dsh: skipping profile bundle "dsh-prompt-setting": Error: Plugin dsh-prompt-setting@0.1.0 is incompatible with dsh 0.1.7-rc.2: peerDependencies {"@deepseek-ai/dsh":">=9.0.0"}. Running it may cause crashes and data loss. … To accept this risk explicitly, grant the exact-version exemption …
dsh web: http://127.0.0.1:3087/?token=…
```

（`…` 是抓取时的省略。）DSH 仍然正常启动，只是本插件被整条跳过。源码位置：`@deepseek-ai/dsh-app-boot/lib/index.js`
`loadProfileDirectory()` `:919-953`（`evaluatePluginCompatibility()` 不通过 ⇒ `throw` ⇒ 收进 `skippedBundles`，
该 bundle 的 patch 层**根本不加载**）、消息模板 `pluginCompatibilityWarning()` `:322`、
输出 `reportSkippedBundles()` `:516`（`process.stderr.write`）。

**两条必须写下来的结论**：

1. **我们的导入期「超范围」警告在 DSH 0.1.7-rc.2 上被抢占、不可观测**：该检查发生在
   `mountRootInclude()`（`:4082`，真正开始 import 插件的地方）**之前**，本包**根本不会被 import**，
   于是 `BOOT_COMPAT` 那次探测连同它的警告一起不会发生。⇒ 文档、自检脚本与本节表述一律以**平台签名**为准；
   我们那条只作为「未来平台若撤掉此检查」的**兜底/防御纵深**保留（判定逻辑、`apply` 防护、stderr 通道一律不动）。
2. **安装期也有同一套检查**：`dsh plugin add` / plugin manager 在**安装时**就拒绝不兼容版本，并给出
   `dsh plugin allow-version`（或 plugin manager）的 exact-version 豁免指引 —— 也就是说「DSH 升到插件不支持的
   版本」这件事，平台在**装之前**和**启之前**各拦一次，比插件内自救更早。

### 三、主管实测：坏插件对 web UI 的**功能级**影响（同一套功能探针，三个临时实例对照）

| 实例 | shell | UI 挂载点 | boot 清单条目 | 唯一核心客户端模块 | 首个 bundle |
| --- | --- | --- | --- | --- | --- |
| 干净基线 | HTTP 200 / 34,240 B | 有 | **67** | **64** | 200 / JS / 33,930 B |
| 注入服务不存在 | HTTP 200 / **34,240 B** | 有 | **67** | **64** | 200 / JS / 33,930 B |
| apply 期抛错 | HTTP 200 / **34,240 B** | 有 | **67** | **64** | 200 / JS / 33,930 B |

- 核心模块清单**逐条 `diff` 完全相同**（`"id":"@deepseek-ai/…"` 排序后无差异）；
- 探针方法：`curl -L -c/-b cookiejar "…/?token=…"` 取 shell（200、`<!doctype html>`、含 `id="root"` 挂载点、
  `__DSH_BOOT__` 清单 67 条目）+ 取清单里第一个 `plugins/??…client.js&rev=…` 资源（200、`text/javascript`、33,930 B）；
- 结论：**插件未激活对 web UI 零影响**（干净 vs 坏的差别只是少一个条目，而那个条目本来就不是核心 UI 模块）
  ⇒ README「兼容性与救援」据此写「挂掉不会影响 DSH 启动与界面」，**同时必须写**：
  终端只有那两行/堆栈，用户不看终端就只会觉得「插件没生效」。
- 清理：三个临时 profile 与 `/tmp` 样本已删；当前 profile 两文件哈希与 3080 pid 未变。

### 四、本 attempt 自己跑的源码级实测（补二节的「能不能捕获」）

用真 `@deepseek-ai/cordis` 起一个 `new Context()`，跑两个探针：

```
(A) try { ctx.effect(() => { throw new Error('BOOM-A') }) } catch { … }
    ⇒ caught = BOOM-A           // 工厂抛错**会**传播到 ctx.effect 的调用方
(B) ctx.plugin({ apply(c) { c.effect(()=>()=>log('first-disposed')); c.effect(()=>{throw …}) } })
    ⇒ ctx.plugin() rejects，且 first-disposed 被调用   // 不 catch 时 Cordis 也会 unload 掉该 fiber
```

⇒ 两个推论（都写进了实现与测试）：

1. `ctx.effect(factory)` 的工厂抛错**能**被我们自己的 try/catch 看见 —— 这是 `apply` 防护能成立的前提
   （`registerEffect` 因此可以「注册成功才记账」）。
2. 即便我们不 catch，Cordis 也会在 fiber 失败后 dispose 掉已注册 effect（`_reload` 捕获 → `epoch=INACTIVE`
   → `_unload()` → `_disposables.clear()`）。**所以我们的显式清理不是为了「否则一定半挂载」，而是为了**：
   回滚**同步、确定、可断言**，不依赖 Cordis 的异步 unload，也不依赖 loader `fiber.await().then(notify, notify)`
   对失败的处理；并且能让「失败」变成**一条**我们自己的信息，而不是平台堆栈。

### 五、实现（六个落点）

| 文件 | 落点 |
| --- | --- |
| `core/compat.js`（新增） | 纯函数：semver 解析/比较（含 §11 预发布规则）、范围判定（不支持的语法 ⇒ `null`「无法判断」）、三分支文案、`apply` 失败文案；best-effort 探测 `detectDshVersion`（多锚点、绝不抛） |
| `index.js` 顶层 | `reportBootCompatibility()` + `BOOT_COMPAT`：导入期自检，**范围内静默**，超范围/探测失败各一条 `console.warn`（**超范围那条在 0.1.7-rc.2 上被平台闸门抢占、观测不到，见二之补**）；探测与 logger 都各自 guarded，外层再包一层 ⇒ **绝不抛**。`DSH_PEER_RANGE` 从自己的 `package.json` 读（读不到回退到常量，测试断言两者相等） |
| `index.js` `apply` | `apply(ctx, config)` 只做一件事：`try { mount(...) } catch { reportMountFailure(...) }`。`mount` 是原来的正文；两处注册改为 `registerEffect(ctx, cleanups, factory, label)`（登记 disposer + 校验返回值），路由注册用 `disposerOf()` 校验服务返回的是不是 disposer。失败信息**同时**写终端与 `ctx.logger.error`（理由见六） |
| `index.js` 注册顺序 | **路由先、waterfall 监听器后**（原来相反）。理由两条：最可能的真实失败是 `webServer.register()` 拒绝重复前缀（二次安装/未来宿主占用该前缀），先注册路由 ⇒ 该失败发生在**什么都没挂**时；同时让「路由已 live、下一步失败」成为可被测试钉死的半挂载场景。两者都在 `mount` 返回前**同步**挂好，任何请求与装配都观察不到顺序（既有断言只看数量与 `listeners[0]`，已复跑 328 条全绿） |
| `client.js` | 指纹区之后加一道 guard：`try { return buildPlugin(require) } catch { return degradedPlugin(require, error) }`；原正文整体移入 `buildPlugin`（**刻意不缩进**：6k 行重排等于 6k 行 diff、零行为变化，且指纹区正是这段文本）；`degradedPlugin` 打印一条 `console.error`，能拿到 React 就注册降级卡片（保留 `data-plugin`/`data-render-state` 标记），连 React 都没有就返回 `{inject: [], apply(){}}`（什么都不注册）。渲染期仍走既有 `renderFailureCard` |
| `scripts/check-compat.mjs`（新增，随包发布） | 只读自检：本插件版本 / peer 范围 / 已装 DSH 版本与来源 / 结论 / **四种 boot 失败形态的终端签名（逐字）** / 救援步骤 / 本插件自己的消息模板（**由 `core/compat.js` 的真实构造函数产出，不是手抄副本**）。零依赖、不联网、永不抛、**退出码恒 0** |

### 六、终端渠道：为什么失败信息**同时**写 `stderr` 与 `ctx.logger.error`（本节结论改过一次实现）

brief 的原话是「用 `ctx.logger.error`；`ctx.logger` 不可用时退回 `console.error`」。**读源码后发现前半句
在本 profile 里到不了终端**，而「在终端打印信息」正是 g-013 的全部要求，所以实现改成**两个渠道都写**：

| 依据（源码） | 结论 |
| --- | --- |
| `@deepseek-ai/dsh-app-boot/lib/index.js:4053-4060`：`diagnostics.logger.exporter({ levels: { default: 2 }, export: ({type,…}) => { if (type === "warn" \|\| type === "error") startupLogs.push(…) } })` | 整个 profile 里**唯一**注册给 `ctx.logger` 的 exporter 只是把 warn/error **收进数组**，不写终端 |
| 同文件 `:4092`：`cause.startup = { configurationPath, messages: startupLogs }`（只在 `catch (cause)` 里，且仅 `StartupError`） | `startupLogs` 只在**启动失败**时才被挂到错误上；**启动成功时它被丢弃** ⇒ 我们的 `logger.error` 在正常 boot 下**什么都不会打印** |
| `@deepseek-ai/cordis/lib/index.js:598-604`：默认 exporter 只 `self.buffer.push(message)` | cordis 自带出口是内存环形缓冲（给 UI 看），不是终端 |
| `@deepseek-ai/dsh-app-boot/lib/index.js:3956-3963`、`:4008`：`warn = (line) => void process.stderr.write(line)`，`activationDiagnostic` 拼 `\`${binName}: warning: N entry did not activate\n<id> (<name>): …\`` | **平台自己的告警是直接写 `process.stderr` 的** —— 我们照做才是同一个终端渠道 |

⇒ `logToHost(ctx, message)` 现在：**先**调 `ctx.logger.error(message)`（可行时；让宿主的日志记录/启动诊断也能看到），
**再无条件** `console.error(message)`（= `process.stderr`，与平台告警同渠道）。测试
`boot: the line always reaches the terminal, even when the host logger is missing or broken` 对
`logger = ok / missing / throwing` 三种形态都断言**终端恰好一条**，且 `ok` 时两个渠道内容相同。

**代价（诚实记录）**：若某个宿主**自己**注册了写终端的 logger exporter，这条信息会**出现两次**。
选择接受：重复一次远好于「信息消失」。本机 web profile 没有这样的 exporter（证据见上表第一、二行）。

### 七、三条边界（+ 一条我们修不了的残余，全部写进 README）

① `inject` 的服务消失 ⇒ 我们的 `apply` **根本不执行**（一、③）⇒ 只能靠导入期自检与文档；
② `cordis.patch.yml` 不合法 ⇒ 失败在 **profile 组合层**、早于本插件任何代码，且**平台不报**（一、②）
   ⇒ 插件无法自救，只能靠 `scripts/check-compat.mjs` + `dsh --dump-config`；
③ 终端消息**只在终端**（`dsh web` 前台输出）：没有 UI 提示、没有远程上报（非目标）⇒ 不看终端 = 没有信号。
④（残余）若某版 `webServer.register()` **返回非 disposer**，路由已进它自己的表而我们**没有句柄可撤**：
   `disposerOf()` 会把这个形态变成可见的失败（一条信息）并保证**不再往上叠挂**监听器，
   但那一项本身撤不掉。测试 `boot: a service that returns the wrong shape …` 明确断言 `live.size === 1`（不掩饰）。

### 八、`inject` 保持不变：结论与代价分析（brief 要求「先给结论，不要直接改」）

**结论：不改。** `inject = ['webServer', 'connection', 'systemPrompt']` 原样保留（新增测试钉死）。

- 把 `systemPrompt` 从 `inject` 里拿掉的**收益**：服务消失时我们至少能跑 `apply`，于是可以打印一条自己的信息。
- **代价（更大）**：插件会在没有覆盖引擎的 profile 里「成功挂载」——路由照常提供服务、UI 照常展示页面，
  但**每一段覆盖都静默失效**（`assemble` 不存在，覆盖永远不生效）。这是把「启动期一次可见的失败」换成
  「运行期持续的、看起来正常的错误结果」，对「默认 System Prompt 管理」这个核心承诺是降级而非兜底。
- 而且 ③ 的失败**平台已经报了**（终端有 `pending (waiting for service: …)`，见二节），信息并没有丢；
  真正没信号的只有 ②，而 ② 与 `inject` 无关。
- ⇒ 选「保留硬依赖 + 把可读信息补在导入期与 apply 期」，代价是 ③ 只能靠文档与自检脚本（写进七、①）。

### 九、版本探测（`detectDshVersion`）的设计与已知限制

锚点按「越能描述**本次 boot** 越优先」排序：

1. `DSH_INSTALL_ROOT`（显式覆盖；与 `test/integration.test.mjs` 同一个 knob）；
2. `DSH_PROFILE_DIR`（宿主自己声明的 profile 目录）；
3. **本模块所在目录**（DSH 是祖先依赖或非 optional 依赖时命中）；
4. **运行中的 CLI 入口 `process.argv[1]`**：pnpm 全局布局里 `dsh` 的 bin 就在安装树内部
   （`…/global/v11/<hash>/node_modules/@deepseek-ai/dsh/lib/bin.js`），`createRequire` 从它出发能解析到
   **本次进程正在用的**那个 `@deepseek-ai/dsh`。**本机实测：该锚点解析到 `0.1.7-rc.2`**；
5. pnpm 全局 store 扫描（`$PNPM_HOME/global`、`$DSH_HOME/profiles`、`~/.local/share/pnpm/global`），
   镜像 `test/integration.test.mjs` 的候选目录策略 —— 最后手段，只能说明「机器上有什么」。

已知限制（都写进代码注释，不藏）：

- **brief 建议的 `createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')` 在本机真实布局下必然失败**
  （本包以 `link:` 装进 profile，profile 的 `node_modules/@deepseek-ai` 里只有 `cosmokit`/`schemastery`；
  插件目录的祖先链条上没有 `node_modules`）。若照抄 brief 那一句，**每次 boot 都会打印「无法探测」**，
  正是 brief 自己禁止的噪音 ⇒ 实现为多锚点，实测命中第 4/5 条。
- **多版本并存时以「最高优先级锚点」为准**，不做「多个候选取最悲观」：同一台机器上存在旧 DSH 的 store 副本时，
  只有优先级更高的锚点失败才可能选到它（已记录的取舍；判错的代价只是**一条措辞**，不会失败）。
- **范围语法只实现比较器列表**（`>=x <y`，含 `||`）：`^`/`~`/`x`/连字符区间一律返回 `null`「无法判断」，
  并被当作 undetected 处理（**绝不猜**）。本包实际只用 `>=0.1.7-rc.2 <0.1.8-0`。
- 探测**读文件系统**（一次 `readFileSync`，失败路径才有 readdir）：不联网、不写任何东西。

### 十、`apply` 失败后**不 rethrow**：取舍

- **选不 rethrow**（`apply` 捕获后正常返回）：终端只有我们**一条**可读信息 —— 形态④ 的裸堆栈不会再出现
  （已实测形态④ 只有堆栈、没有指引，这正是 g-013 要治的东西）。
- **代价**：本插件的 fiber 保持 active 但零 effect，`plugin_manager` 里仍显示「已启用」。
  这是**有意**的取舍：`apply` 的返回值对 loader 而言就是「挂上了」，而把它标成失败除了多一坨平台堆栈
  并不会让任何东西更好用；「本插件已停用」这句话写进那一条信息里，README 也写了怎么确认。

### 十一、测试与负向对照

新增 `test/boot.test.mjs`（**21 条**）：导入期三分支（范围内静默 / 超范围一条 / 探测失败一条 / 探测抛错、
logger 抛错都收容）、范围与 semver §11 边界（`rc.1 < rc.2 < 0.1.7`、`rc.10 > rc.2`、`alpha < alpha.1`、
不支持的语法 ⇒ `null`）、探测多锚点（真安装 / 坏 JSON / 无 version / 什么都没有 / 垃圾锚点）、
`apply` 四种破坏（方法缺失 / 抛错 / 返回非 disposer / `ctx.effect` 缺失）下**不抛 + 一条信息 + 零残留**、
**半挂载回滚**（先注册的路由 disposer 被调用且 `live` 路由表清空）、失败的 disposer 被收容且在信息里承认、
**boot 连续性**（同管线下一个插件照常挂载）、客户端 factory 抛错不抛回 loader（`react` 缺失 + 正文抛错两种，
后者断言降级卡的 `data-plugin`/`data-render-state` 与原因文本）、正常路径零变化（`inject` 与渲染期兜底仍在）、
自检脚本的签名/退出码/只读性。

负向对照 4 条（逐条「改坏 ⇒ 跑 `test/boot.test.mjs` ⇒ 从 `/tmp/g013-nc` 还原 ⇒ `shasum -a 256` 逐字节核回」）：

| # | 改坏 | 结果 | 还原后 |
| --- | --- | --- | --- |
| NC1 | 去掉 `apply` 的 try/catch（直接 `mount(...)`） | **8 红 / 13 绿**（4 种破坏形态 + logger 兜底 + 半挂载 + 失败 disposer + boot 连续性） | 21 绿 |
| NC2 | 去掉 effect 清理循环（`cleanups.length = 0` 前不 dispose） | **2 红**（半挂载回滚、失败 disposer 收容） | 21 绿 |
| NC3 | 让超范围分支 `message = null`（静默） | **2 红**（三分支文案、真安装探测→判决） | 21 绿 |
| NC4 | 去掉客户端 factory guard（`return buildPlugin(require)`） | **3 红**（react 缺失、正文抛错降级卡、坏宿主） | 21 绿 |

`shasum -a 256` 逐字节核回：`index.js 6da70b548e987aa8eeb87268d58604c40e828d7e56741ff294797554b12b7249`、
`client.js 419ac8d1b374f5cbef6f0f8ad89f17fb8d7363c6e76f5f22d9c4e263f72059fc`（还原前后 `shasum -a 256` 逐字节一致；
四条对照在**最终代码**上重跑过一遍，红/绿计数见上表）。

### 十二、自测证据（worktree `.worktrees/g-013-att-01`，基线 `3aadadf`）

```
evidence: suite=node --test(packages/dsh-prompt-setting) passed=349 failed=0 exit=0 skipped=0
evidence: suite=node --test(test/boot.test.mjs) passed=21 failed=0 exit=0
evidence: pack=files 16 / test-hits 0
evidence: fingerprint 3aadadf=42061a2a/260711 -> now=0c098c88/265425
```

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test`（包目录） | **349 / 349 pass / 0 fail / 0 skipped**（基线 328 ⇒ **+21 条**） |
| 语法 | `node --check`（`index.js`、`client.js`、`core/*.js`、`scripts/*.mjs`） | 全通过 |
| 打包 | `npm pack --dry-run --cache /tmp/g013-npm-cache` | **16 个文件**、`test/` **命中 0**。相对基线 14 → 16：**+`core/compat.js`、+`scripts/check-compat.mjs`**（brief/补充说「14 → 15」是按「只加脚本」估的；`core/compat.js` 是纯函数内核，按本仓分层原则必须单独成文件，所以是 **16** —— 数字更正，`test/` 仍 0 命中） |
| 构建戳 | 独立复算 `@build-fingerprint` 区间 | `42061a2a` / `260711`（= §90 的收尾值）⇒ `0c098c88` / `265425` |
| 既有 328 条 | 全量复跑 | **零删改削弱**；唯一改动的既有测试是 `test/host.test.mjs` 的 `files` 白名单断言（**+1 行 `'scripts'`**，并补注释说明），以及 `test/client.test.mjs` 的打包断言本来就只查 `test` 不在册（未改） |
| **终端渠道** | 子进程里用「`webServer.register` 不存在」的 ctx 桩跑 `apply`（`/tmp/g013-stderr-proof.mjs`） | **exit 0**、**stdout 无输出**、**stderr 恰好一行**（原文见交付说明），且 `ctx.logger.error` 同时拿到同一行（`LOGGER_LINES=1`）——「终端看得见」是实测的，不是推断的 |
| 兼容自检脚本 | `node scripts/check-compat.mjs` | 退出 0；本机输出 `兼容（在已测试范围内）`（探测到 `0.1.7-rc.2`，来源为全局安装内的 `@deepseek-ai/dsh/package.json`） |

### 十三、未验证项 / 交给主管（诚实清单）

- **真机临时 profile 实测由主管执行**（本 attempt 无特权、且禁改 profile）：三节的功能级对照与二之补的平台签名
  都是主管实测；二节形态④ 的触发方式（抢前缀插件）已真机验证可用，且终端输出与本文档承诺的文案**逐字一致**。
  **仍未被真机观测到的**：我们自己的「导入期 · 超范围」与「导入期 · 探测失败」两条警告（前者被平台抢占，后者需要
  构造一个解析不到 DSH 的真机环境）——它们的证据是单测 + `test/boot.test.mjs` 的三分支断言，不是真机截图。
- **运行中 `dsh web` 进程的 `argv[1]` 究竟是不是 `…/@deepseek-ai/dsh/lib/bin.js` 未直接验证**
  （本机 `ps` 被沙箱拒绝）。锚点 4 是按 pnpm 布局与 `dsh` 启动 shim 的源码推出的，并已用「把该路径当
  `argv[1]`」的方式验证过解析成功；真机 boot 下若锚点 4 失效，会退到锚点 5（全局 store 扫描），
  本机实测锚点 5 也能命中 `0.1.7-rc.2` ⇒ **范围内仍然静默**。
- **`core/compat.js` 的范围语法只覆盖比较器列表**（九节），`^`/`~` 等未实现（返回「无法判断」）。
- **降级卡片的文案刻意不做 i18n**（`client.js` 顶部词典与 locale 绑定都在刚失败的正文里）；
  `test/client.test.mjs` 的 en 横扫走的是**正常**模块，因此不受影响 —— 这是有意选择，不是漏掉。
- **「返回非 disposer」的残余**（六、④）无法彻底消除，只能可见化 + 不再叠加。

---

## 92. 插件自注册一段 Prompt + 写入面收窄到该段（g-014，2026-09-29，基线 `v0.1.0-test@8533eb1`）

**目标（负责人本轮产品决定）**：插件从「任意段的覆盖编辑器」收敛为「**一个我自己的 Prompt 段** +
其他段只读」。本目标只做**宿主半 + 契约**；客户端 UI 重排是另一个目标（`CONTRACT.md` §7 限制 21）。

### 一、侦察到的平台事实（逐条带出处，全部读自本机已装 0.1.7-rc.2）

下称 `SP` = `…/.pnpm/@deepseek-ai+dsh-system-prompt@0.1.7-rc.2_…/node_modules/@deepseek-ai/dsh-system-prompt`。

| # | 事实 | 出处（`file:line`） | 对本实现的约束 |
| --- | --- | --- | --- |
| ① | `section()` 就是往当前 scope 的层里 `insert` 一条命名段，并返回 **cordis effect 的 disposer**；`order` 非有限数抛 `TypeError`，同层重名抛 `Error` | `SP/lib/index.js:240-243`（`241` 有限性检查、`242` `layers.effect(...)`） | 可以在 `apply` 期间安全注册；disposer 直接交给本仓的 `registerEffect` 台账 |
| ② | 排序 = `order` 升序，相等时按名字 **code-unit** | `SP/lib/index.js:97-99`（`comparePromptSections`） | 只要 `order` 大于所有内置值，本段必然最后 |
| ③ | 内置位置表最大值 `DEPLOYMENT_PERSONA_SUFFIX = 10200` | `SP/lib/index.js:10-43`（`42` 行） | 取 `1000000` 严格大于它；文档写清「只保证排在 DSH 仓库内置段之后」 |
| ④ | 平台明确说外部贡献可用**任意有限 order** | `SP/README.md:56` | 所以「另一个插件仍可能排在我们之后」是文档边界，不是 bug |
| ⑤ | 装配后段对象**不带 `order`**（只有 `name` / `text` / 可选 `interpolate`） | `SP/lib/index.js:340-346` | 单测只能断言**顺序**，不能断言段上带 order（断言写成 `Object.hasOwn(section,'order') === false` + 位置最后） |
| ⑥ | `interpolate: false` 的段文本原样保留、跳过插值；其余段在遇到未知变量名、`undefined` 值、畸形 `{{}}` 时**抛错** | `SP/lib/index.js:113-115`（`renderPrompt`）、`:153-177`（`interpolate`，抛出点 `160`/`166`/`169`/`172`） | 用户文本必须 `interpolate:false`，否则用户写一个 `{{foo}}` 就让**每一轮**装配失败 |
| ⑦ | 空文本段仍在 `assembly.sections` 里（监听器可见），但 `renderPrompt` 用 `.filter(text => text.length > 0)` 丢弃 | `SP/lib/index.js:113-115` | 「未配置 ⇒ 对最终 prompt 零贡献」是可断言的；同时快照视图会多一条 |
| ⑧ | 生效列表里有 `complete:true` 段时，**瀑布返回之后** `sections` 被整体替换为该段 | `SP/lib/index.js:335-337`（collect）、`:355-361`（替换） | 本段会被丢掉、用户文本不进 prompt ⇒ 快照如实报 `frozen`，文档必须明说 |
| ⑨ | 真实 `renderPrompt` **是导出的**（`export { …, renderPrompt }`） | `SP/lib/index.js` 末行 | 所以「真实渲染路径」可以在集成测试里直接量，不需要自己再写一个渲染器 |

结论：①–⑨ 都**没有推翻** brief 里的侦察结论；补到的两条是 ⑤（装配后不带 `order`，影响断言写法）
与 ⑨（`renderPrompt` 可用，让「零贡献」和「逐字节保留」有了真实渲染器的证据）。

### 二、落了什么（函数级）

| 位置 | 改动 |
| --- | --- |
| `core/custom.js`（**新增**，288 行，纯函数零 IO） | `CUSTOM_SECTION_NAME='prompt-setting:custom-prompt'`、`CUSTOM_SECTION_ORDER=1000000`、`CUSTOM_SECTION_INTERPOLATE=false`、`CUSTOM_SECTION_TEXT=''`、`REPO_MAX_SECTION_ORDER=10200`；`customSection()`、`isCustomSectionName()`、`assertWritableSection()`（`403 write-locked` / `400 unsupported-action`）、`assertDeletableName()`（`403 write-locked`）、`legacyPlan()`、`customOverridesOnly()`、`exportScope()`、`assertImportableDocument()` |
| `index.js` | ① `mount()` 末尾第三个 effect：`registerEffect(ctx, cleanups, () => disposerOf(ctx.systemPrompt.section(customSection())), label)`；② `handleWriteOverride` 在 `layer` 检查后、`validateOverride` **之前**调 `assertWritableSection`；③ `handleDeleteOverride` 显式先查 `layer`，再 `reset`/`legacy` 互斥 `400 conflicting-query`，再 `missing-name`/`name-too-long`，再 `assertDeletableName`，最后才是 404；④ 新增 `handleLegacyClear`（写 `legacy-clear` 历史记录，`count===0` 不写文件）；⑤ `handleImport` 在 `parseExport` 之后立刻 `assertImportableDocument`（dry-run 也挡）；⑥ `handleExport` 过滤成保留名条目 + 响应加 `exportScope`；⑦ 末尾 re-export 保留名常量 |
| `core/history.js` | `HISTORY_ACTIONS` 加 `legacy-clear`；新增 `LEGACY_CLEAR_ACTION` 与 `LAYER_WIDE_ACTIONS=['reset-layer','legacy-clear']`；`validateHistoryRecord` 的「整层动作必须 `name:null`」规则从「只认 reset-layer」改为「认这两个」 |

**为什么注册放在最后（第三个 effect）**：三个 effect 的注册顺序只在失败时有意义，规则是
「**越可能失败的越先注册**，失败时要撤销的东西最少」。真实 profile 最常撞的是
`webServer.register()` 拒绝重复前缀，其次是 `ctx.on` 不可用，本段注册只可能因为
「本插件已经挂过两次」或平台改名而失败。这样也保住了 `test/boot.test.mjs` 早已钉住的
「路由先注册，随后监听器失败 ⇒ 撤销 1 项」这个半挂载用例的逐字含义。

**注册失败的处理**：完全走 g-013 已有的路径 —— `mount` 抛错 ⇒ `reportMountFailure` 打**一条**可读信息
（终端 + `ctx.logger.error` 双通道）并按逆序撤销已注册的 effect，`apply` 从不向外抛，
**绝不让 DSH 启动失败**。三个新形态（`section` 缺失 / 抛错 / 返回非 disposer）在
`test/boot.test.mjs` 里各有一条断言，其中「返回非 disposer」的残余（宿主收下了注册却没给撤销句柄）
按 §91 边界 ②′ 如实断言为 `sections.length === 1` 并写明理由。

### 三、收窄的理由（为什么是「接口也收窄」而不是只收窄 UI）

负责人选的是「接口也收窄」。理由记在这里，避免以后被当成过度设计：

1. **判据必须能被外部证明。** UI 收窄只改了客户端的自觉；`PUT {name:"project:alpha"}` 仍然能改任意段，
   「其他段只读」就只是一个说法。收窄接口后，「只读」是一条有 4xx 码、有 SHA-256 证据的**事实**。
2. **不动旧覆盖的语义。** 收窄发生在**写入口**，不在装配路径：`applyOverrides`/`mergeLayers`/
   `buildEffective`/`detectFrozen` 一行没改，所以 Revision 6 的集成断言（含
   `hide`/`append`/`complete`/scope 链）逐字节保持一致，回归风险集中在新增分支上。
3. **逃生口必须留。** 冻结不等于删掉：层文件仍是唯一事实来源、每次路由请求都重读（§5.5），
   手工编辑它改单条旧覆盖是文档化的逃生口，`?legacy=true` 是整批清除，`?reset=true` 是整层清空。

### 四、测试前后映射表（既有断言强度不降级）

基线 `node --test` = **349 项 / 0 fail**；本 attempt = **377 项 / 0 fail**（净 +28）。
新增文件 `test/custom.test.mjs`（14 项，纯策略内核）。既有用例**没有一条被删除**，被收窄能力影响
的用例逐条等价改写如下（`-` = Revision 6 写法，`+` = Revision 7 写法）：

| 文件:用例 | Revision 6（等价强度） | Revision 7 |
| --- | --- | --- |
| `host.test.mjs` 注册面 | 1 监听器 + 1 路由，2 个 disposer，`disposedCount()` 0→2 | +1 段注册 ⇒ 3 个 disposer，`disposedCount()` 0→2 与 `sectionsDisposedCount()` 0→1；另加一条断言注册定义逐字段等于契约 |
| `history.test.mjs` 动作词表 | `HISTORY_ACTIONS` = 5 个值 | = 6 个值（前 5 个顺序不变），并逐值验证「该带 name / 该不带 name」 |
| `history.test.mjs` 无 name 动作 | 「`reset-layer` 是唯一不带 name 的动作」 | 「整层动作**恰好**是 `reset-layer` + `legacy-clear`」+ 双向断言（带 name 则该拒） |
| `route.test.mjs` 快照顺序 | 5 段名 + index `[0..4]` + complete ×5 | 6 段名 + index `[0..5]` + complete ×6；`rendered` 断言**未变** |
| `route.test.mjs` D2a/b/c、F1 | `DEFAULT_SECTIONS.map(name)` | `globalNames()`（= fixture + 本段，恒最后） |
| `route.test.mjs` effective 视图 | 5 行 | +1 行（本段、空、index 5、`applied:false`） |
| `route.test.mjs` 两层覆盖优先级 | PUT 用户层 `project:alpha` | PUT **保留名** + 直接落盘一条旧覆盖（逃生口），两者同在用户层；merged 仍断 workspace 胜 |
| `route.test.mjs` `complete` 冻结 | `base.sections.length === 6` | `=== sections.length + 1` 且 `.at(-1).name` 是本段 |
| `route.test.mjs` PUT 原子写 | PUT `project:alpha` → 200 | PUT 保留名 → 200；+断言最终段文本、位于 `base` 最后、`rendered` 以它结尾 |
| `route.test.mjs` PUT upsert | 3 次 PUT（含 `hide`）不重复 | 2 次 PUT 保留名不重复 + 旧覆盖**不被扰动**（文件内容逐项断言） |
| `route.test.mjs` PUT 拒绝表 | 13 例（含 `unknown-action`/`unexpected-text`/`invalid-order`） | 20 例：形状类改用保留名（`missing-text`/`text-too-large`/`workspace-unresolved` 等仍可达）+ 6 例非保留名 `403 write-locked` + 4 例保留名非 `replace` 的 `unsupported-action`。`unknown-action`/`unexpected-text`/`invalid-order` **仍在**内核单测与 import 文档校验里覆盖 |
| `route.test.mjs` DELETE 单名 | PUT+DELETE 任意名 → 200/404 | 保留名 200/404 + **旧覆盖在场**的 `403 write-locked`（证明「冻结」先于「404」）+ 不存在的旧名也 403 + `name-too-long` 仍在 |
| `route.test.mjs` 损坏层写 409 | PUT 任意名 → 409 | PUT **保留名** → 409（`layer-not-writable` 仍可达）+ 段数断言 |
| `route.test.mjs` 写入失败矩阵 | `missing-text`/`workspace-unresolved`/404 用任意名 | 改用保留名；旧名一例改断 `403 write-locked` |
| `route.test.mjs` 结构断言 | 4 个写路径必须写完才进缓存 | +`handleLegacyClear`（第 5 个写路径同样受约束） |
| `stage2.test.mjs` 历史机制 | PUT 任意名 ×N | PUT 保留名；「多名字日志」由 `seedHistory()` 直接落盘（旧版本本来就会留下这种文件） |
| `stage2.test.mjs` `hide` 无 after 文本 | PUT `hide` → 记录无文本 | 用 **import 一条保留名 `hide`** 驱动（`hide` 已不可 PUT），断言不变 |
| `stage2.test.mjs` 分段/命名过滤 | 3 次 PUT（a/b/a） | `seedHistory()` 落两条旧记录 + 1 次 PUT 保留名；过滤分别按旧名与保留名各断一次 |
| `stage2.test.mjs` 整层重置 | 2 次 PUT + reset | 直接落盘 3 条（旧 replace/旧 hide/保留名）+ reset；`removed`/`entries` 3 条全断言；reset 记录数 3→1（PUT 不再产生历史） |
| `stage2.test.mjs` reset 非严格 true | `reset=1&name=a` → 200 | `reset=1&name=<保留名>` → 200（同义），`legacy=1` 的同义断言放在新增用例里 |
| `stage2.test.mjs` diff 行级 | 两条 `a` 记录 | 两条保留名记录 + 落盘一条旧覆盖（证明冻结条目不影响 diff） |
| `stage2.test.mjs` reset 版本 diff | PUT a → reset → PUT b | PUT 保留名 → 落盘旧 `a` → reset → PUT 保留名；三段记录全部断言 |
| `stage2.test.mjs` 导出 | 任意名条目 + 无 `exportScope` | 保留名条目 + `exportScope` 两项断言（`{only, omitted:{user,workspace,total}}`） |
| `stage2.test.mjs` dry-run 计划 | 2 条导入（`a` replaced + `c` added，kept 1） | 保留名 1 条 added（kept 2）+ **`mode=replace` 分支**补回 `removed`/`kept` 形状（`added1/removed2/kept0`） |
| `stage2.test.mjs` mode=replace | 本地 `a` replaced + `b` removed | 本地两条旧覆盖全 removed + 保留名 added；历史记录**全量**断言（原为 `slice(0,2)`） |
| `stage2.test.mjs` 导入两层 | 文档带 `a`/`w` | 文档带保留名两条；本地旧覆盖落盘 ⇒ `kept:1`、`['keep', 保留名]` 位置断言不变 |
| `stage2.test.mjs` 导入拒绝表 | 9 例 | 11 例（+ 非保留名 `403 write-locked`、+ 非导入层里的非保留名也 403），并对 `write-locked` 各加一次 `dryRun` 拒绝 + 文件哈希不变 |
| `stage2.test.mjs` 不可读层 409 / 不可解析工作区 400 | 任意名文档 | 保留名文档（409/400 仍可达） |
| `integration.test.mjs` 快照顺序 | 5 段/index `[0..4]`/complete ×5 | 与真实 `assemble()` 对齐（段数动态），+断言本段最后 |
| `integration.test.mjs` `complete` 冻结 | PUT `test:complete` | 落盘旧 `test:complete` 覆盖（逃生口）+ PUT **保留名**；冻结判据逐字保留，+断言保留段被整段丢弃的原因 |
| `integration.test.mjs` D2 并发 | 4 段名 | 5 段名（+保留名） |

**净新增断言（本 revision 专有）**：注册定义（名字/order>10200/`interpolate===false`）、disposer 记账与卸载后无残留
（真实 cordis fiber `dispose()`）、未配置时 `renderPrompt(assemble())` 与「没装插件」逐字节相同、
保留名 `replace` 后最终段文本逐字节相等且位于 `sections` 最后、用户文本含 `{{未定义}}`/畸形 `{{` 不抛且原样保留
（含「同样的文本在插值段里会抛」的**对照组**）、每条 403/400 前后文件 SHA-256 不变、
`legacy=true` 三情形（有旧覆盖 / 无旧覆盖 / 与 reset 冲突）、import 带其他名 403 + 文件不变（dry-run 亦然）、
export 只含保留名且显式声明省略、加上 `test/custom.test.mjs` 的 14 项纯策略断言。
`git diff` 计数：**+242 条 `assert.`**、-53 条（改写），**新增 20 处 `test(...)`**、移除 6 处（改写为等价用例）。

### 五、负向对照（改坏 → 红 → 还原 → 绿）

三条，逐条都在 worktree 内做，「还原」用 `git checkout` + `shasum -a 256` 确认逐字节回滚：

| # | 改坏 | 期望红 | 实测（`node --test`，基线 377 项 0 fail） |
| --- | --- | --- | --- |
| ① | `index.js` 去掉 `ctx.systemPrompt.section(...)` 那段注册 | 注册定义、disposer 记账、零贡献逐字节、`{{}}` 原样保留、快照多一行 —— 全红 | **27 fail / 350 pass**，命中 `boot: the reserved section is registered…`、`host: mounting registers … one prompt section`、`integration R7: with nothing configured … byte-identical`、`integration R7: a reserved replace lands LAST`、`integration R7: an unknown {{reference}} …`、`integration R7: the plugin registers one reserved section`、以及所有依赖段数的快照/D2/F1 用例 |
| ② | `core/custom.js` 的 `assertWritableSection` 去掉名字闸门（放开任意名） | `403 write-locked` 与「拒绝时 SHA-256 不变」红 | **4 fail / 373 pass**：`custom: a write to any other name is 403 write-locked…`、`overrides PUT: every rejection…`、`overrides: the write lock is checked before anything can be written, proven by SHA-256`、`refresh: a failed write never leaves the cache at odds with the file` |
| ③ | `core/custom.js` 的 `assertImportableDocument` 直接 `return`（放开 import 其他名） | import 的 `403` 与「所有文件 SHA-256 不变」红 | **3 fail / 374 pass**：`custom: an import document carrying any frozen name is 403 write-locked…`、`custom: the refusal message is bounded…`、`stage2: every rejected import leaves BOTH config files and the history byte-identical` |

三条都「改坏 → 红 → `git checkout` 还原 → `shasum -a 256 -c` 逐字节确认 → 绿（377/0）」，
还原后的哈希与改坏前一致（`index.js` `eb721389…`、`core/custom.js` `d87ce69b…`）。

### 六、未验证项 / 交给主管（诚实清单）

- **「注册段进入真机最终 prompt」未验证**：注册是在**真包真 context** 上做的（`test/integration.test.mjs`
  的 R7 用例组：`ctx.plugin(SystemPrompt)` + 真 `assemble()` + 真 `renderPrompt`），
  但「重启后的 `dsh web` 把它装配进实际发出去的 prompt」需要一个宿主重启才能观察，
  本轮**没有重启**（brief 明令禁止）⇒ 按未验证项记录。
  > **更正（2026-09-29，真机已验）**：本条已闭合。负责人重启 `dsh web` 后，主管在真外壳内实测：
  > `GET /snapshot` 的 `base.sections` 末项即 `prompt-setting:custom-prompt`（`text:""`，`baseCount=11`）；
  > 页面保存文本后该段 `applied:true` / `action:"replace"` / `overrideLayer:"user"`，且最终 `rendered` 含该文本；
  > 点「恢复默认」后段回到空、`overrides.json` SHA-256 逐字节回到原值。证据见 `.dsh-graph` 的
  > `versions/v0.1.0/goals/g-014/goal.md`「§七·补」与 g-014 评论区。
- **多轮真实会话中的持久性未验证**：本轮的证据是「同一进程内多次 `assemble()` 一致」，
  不是「跨重启/跨会话一致」。
- **`complete:true` scope 下的最终行为只在离线双桩与真包 `assemble()` 两种路径验证**；
  真机上哪个 scope 带 `complete` 取决于用户的 preset，不在本插件可控范围。
- **客户端半仍是 Revision 6 的编辑器**（写任意名会收到 `403`）：契约 §7 限制 21 已写明，
  UI 重排是另一个目标。
- **`legacy-clear` 这个历史动作没有客户端文案**：`client.js` 的 `histAction.*` 词典里没有这一项，
  面板会渲染原始动作字符串。这是刻意的「不猜」行为，但要等 UI 目标补文案。

### 七、本轮实测证据

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test`（包目录） | **377 / 377 pass / 0 fail / 0 skipped**（基线 349 ⇒ **+28 条**；其中 `test/custom.test.mjs` 14 条是新文件） |
| 语法 | `node --check`（`index.js`、`client.js`、`core/*.js`、`scripts/*.mjs`、`test/*.mjs`） | 全通过 |
| 打包 | `npm pack --dry-run --cache /tmp/g014-npm-cache` | **17 个文件**（基线 16 → +`core/custom.js`）、`test/` **命中 0**、包体 284.6 kB / 展开 872.3 kB |
| 兼容自检 | `node scripts/check-compat.mjs` | 退出 0；`兼容（在已测试范围内）`（`0.1.7-rc.2`） |
| 负向对照 | 三条「改坏 → 红 → `git checkout` 还原 → `shasum -a 256 -c` → 绿」 | 27 / 4 / 3 fail；还原后哈希逐字节一致，全量回到 377/0 |
| 契约 diff | `CONTRACT.md` | +470 行（Revision 7 摘要 + §4.1/§4.3/§4.4 就地修订 + §10/§11.1/§12 就地修订 + 新增 §15 共 9 个小节 + §7 新增 6 条限制） |
| 客户端半 | 未改 `client.js`（本目标只做宿主半；`test/client.test.mjs` 109 条全绿） | 见 §六 未验证项与 `CONTRACT.md` §7 限制 21 |

## 93. 设置页重排为四个一级 tab（g-015，2026-09-29，基线 `f02463a`）

负责人反馈「页面太长」。这个目标把设置页按**功能与使用频率**分成四个一级 tab，固定顺序、默认第一个：
「我的 Prompt」（唯一写入口）/「提示词总览」（纯只读）/「历史与备份」/「高级」。
同时把 Revision 6 的**编辑/新建覆盖 UI 整块删掉**——这是产品决定，不是简化：写入面已经是**一个名字宽**
（`CONTRACT.md` §15.1），一个提供更多写入口的 UI 就是一个提供宿主必然拒绝的写入口的 UI。

### 一、侦察到的现状（逐条读自本 worktree 的 `client.js`，行号为改动前）

| 事实 | 位置 | 结论 |
| --- | --- | --- |
| 页面是一条长列：标题/副标题 → 会话选择器 → 状态卡 → 视图页签 → 编辑器槽位 → 面板 | `renderSection` ~`:5109` | 「太长」的主因 |
| 覆盖视图把覆盖列表 + 差异 + 历史 + 层重置 + 导入导出串在一起 | `renderOverridesView` ~`:4982` | 五个不同频率的面板挤在一个视图里 |
| 已有 `tabs()` 助手，优先 `SegmentedTabs`、否则自绘 `role="tablist"` | ~`:1184` | 直接复用，不自造导航 |
| 客户端**没有**保留名常量，保存走任意名 | 全文 | 与 Revision 7 契约不符（§7 限制 21） |
| 历史动作词表缺 `legacy-clear` 的客户端文案 | `historyActionLabel` ~`:2514` | g-014 遗留：会渲染原始动作串 |

### 二、落了什么（函数级，只动 `packages/dsh-prompt-setting/{client.js,test/client.test.mjs,README.md,NOTES.md,CONTRACT.md}`）

**新增 / 重写**

| 位置 | 内容 |
| --- | --- |
| 常量区 | `RESERVED_SECTION_NAME = 'prompt-setting:custom-prompt'`（`core/custom.js` `CUSTOM_SECTION_NAME` 的**字面孪生**，两侧靠测试逐字比对）、`RESERVED_SECTION_ACTION = 'replace'`、`MAIN_TABS = ['mine','overview','history','advanced']`、`LAYERS`；`VIEWS` 去掉 `'overrides'`（只留 `sections`/`full`）；删掉 `EDIT_ACTIONS`/`ACTIONS` |
| `reservedTextOf(ovs, layer)` | 从 `merged.overrides`（装配真正应用的那张表）读保留段在该层的文本；`null` = 该层没这条覆盖 |
| `renderStatusLine` | 顶端**一行**：挂载 / 冻结三态 / 构建戳三个 tag + 刷新按钮；三个 `data-status-*` 标记供探针直读，tag 的 `title` 带上原因 |
| `renderStatusDetail` | 「高级」里的完整状态区（`data-region="status-detail"`）：挂载、生成时间、两层 `enabled/path/reason`、`data-region="build"`（两个指纹）、三条冻结/两条构建戳解释、`data-region="renderer-info"` 与降级原因（`data-primitives-failure`） |
| `renderMinePanel` | 「我的 Prompt」：层选择（`data-region="mine-layer"`，复用 `user`/`workspace` 语义）+ 文本框（`data-role="mine-text"`）+ 保存（`data-action="mine-save"`）/ 取消（`data-action="mine-cancel"`，仅 `dirty` 可用，纯客户端复位草稿、不发请求、无二次确认）/ 恢复默认（`data-action="mine-reset"`）；`data-mine-state` = `unconfigured`/`dirty`/`saving`/`saved`/`error`；失败时渲染完整 `errorBanner`（`data-mine-error`，映射文案 + 原始 code + 宿主 message）；冻结或 `applied:false` 时渲染 `data-warning="mine-frozen"` |
| `renderOverviewPanel` | 「提示词总览」：保留 `data-region="view-tabs"`（组 `view`，值 `sections`/`full`）——两个只读答案都还需要，且都不写 |
| `renderHistoryTab` | 「历史与备份」：历史面板 + 差异 + 导入导出（`data-region="history-tab"`） |
| `renderAdvancedTab` | 「高级」：只读旧覆盖列表 + 两个层级按钮 + 完整状态区 |
| `renderOverridesList` | 由 `renderOverridesView` 改写：删掉 `data-action="undo"` 与 `data-action="reset-section"` 两个写入口，其余标记（`data-override-row/-layer/-action/-applied/-reason`、`data-overrides-total`）逐字保留，新增 `data-override-reserved` 与 `data-note="overrides-read-only"` |
| `renderLayerReset` | 改用「高级」自己的层状态 `advancedLayer`，同一块里给出两个按钮：`data-action="legacy-clear"`（`legacy=true`，只清旧覆盖、保留「我的 Prompt」）与 `data-action="reset-layer"`（`reset=true`），并把整层 / 冻结 / 保留三个计数分别标记 |
| `renderConfirm` | 四种 kind：`mine-reset`、`legacy-clear`、`reset-layer`、`import`（删掉 `reset-section`） |
| `sectionRow` | 只读化：删掉行内「编辑」开关与它承载的表单；`data-action="expand"` 披露保留（新增 `aria-expanded`），新增按 `section.action` 派生的状态 tag（已覆盖/已隐藏/追加），并把 `editGate` 的结论以 `data-warning="edit-disabled"` **陈述**出来（只读，不再是 disabled 开关） |
| `renderSectionsView` | 删掉 `inlineEditor` 形参与「新增一段」入口；保留过滤器与总数/命中数；新增 `data-action="copy"`；过滤掉保留段并给一行 `data-note="reserved-own-tab"` 说明 |
| `tabs()` | primitives 分支外面包一层 `display: contents` 的容器承载 `data-tab-group`，使该标记在**两个分支**都成立（此前只有 fallback 有） |
| 状态 | 新增 `tab`（默认 `'mine'`）、`mineLayer`/`mineDraft`/`mineStatus`、`advancedLayer`；删除 `editor` 与编辑器 ref/effect |
| 动作 | 新增 `setTab`/`setMineLayer`/`setMineText`/`saveMine`/`requestMineReset`/`setAdvancedLayer`/`requestLegacyClear`/`clearLegacy`/`resetMine`；`saveMine` 发 `PUT /overrides`，body 恒为 `{layer, session?, section:{name: 保留名, action:'replace', text}}`；`resetMine` 发 `DELETE /overrides?layer=…[&session=…]&name=<保留名>`；`clearLegacy` 发 `...&legacy=true` |
| 懒加载 | 历史 effect 的判据由 `view !== 'overrides'` 改为 `tab !== 'history'`：不开该 tab 时仍然只有三条基线请求 |
| 词典 | 删掉 40 个随 UI 一起消失的键（`edit*`/`append*`/`block*`/`feedback*`/`ovUndo`/`resetSection*`/`viewOverrides` 等）；新增 30 个（`tabMine/tabOverview/tabHistory/tabAdvanced`、`mine*` 16 个、`overviewReservedNote`、`stHidden`/`stAppended`、`resetLegacy*`、`advReservedTag`/`advReadOnlyNote`、`histAction.legacy-clear`）；另补 3 个 g-014 遗留的**未翻译**错误码（`write-locked`/`unsupported-action`/`conflicting-query`——此前会渲染原始 code）。zh/en 两侧仍各 256 键、键集相等 |

**删除（不留不可达路径）**：`renderEditor` 整个函数、`editorRoute`/`editorActions`/`editorEntry`/`editorFocusRole`/`editorPlacement`/`entryFeedback`/`layersHolding`、
状态 `editor` + 打开/关闭/改名/改动作/改层/改 order 的 11 个动作 + `save` + `removeOverride` + `resetSection` + `requestResetSection`、
「打开面板时滚动 + 落光标」的 `editorFocus` ref 与 effect、`renderEditor` 的槽位与 `rootRef` 传参。

### 三、删除用例映射表（逐条，既有断言强度不降级）

`test/client.test.mjs` 基线 **109 条**；本 attempt **92 条**（净 −17：删 37、增 20。`node --test` 全包 377 → 360）。

| 被删用例（Revision 6） | 去向 / 等价替代 |
| --- | --- |
| 「replace saves without an order and promises the next turn」 | → 「我的 Prompt」保存：断言 `PUT` 的 URL、method 与 body（名字 = 宿主常量、`action='replace'`、text 逐字），并断言 `dirty → saved` |
| 「the add entry is a separate, reachable entry…」 | 删除。`append-new` 入口不存在（新增断言：总览里 `data-action` 非写集、无 `data-action="edit"`） |
| 「the add entry carries a target index, and a bad index is refused locally」 | 删除。`append` + `order` 已不是本页能产生的写入（宿主 §4.1 只接受保留名 + `replace`） |
| 「the edit entry locks the name and offers only replace/hide」 | 删除。动作 tab 与只读段名一起消失（保留段名由 `RESERVED_SECTION_NAME` 固定，由常量一致性用例覆盖） |
| 「the edit entry defaults to replace and mirrors an existing hide」 | 删除。同上；「镜像已有 action」的能力随任意名写入一起消失 |
| 「neither entry reaches the pre-save check on a normal path」 | 删除。`overrideFeasibility`/`blockText` 仍在（只读诊断用，见下一条），但不再是写前闸门 |
| 「a registered name in the add entry is reported immediately…」 | 删除。同名冲突只能由「新建」产生，入口已不存在 |
| 「a name another plugin added is fed back immediately as well」 | 删除。同上 |
| 「an empty name in the add entry is refused locally as missing-name」 | 删除。名字不再由用户输入 |
| 「the pre-save check still fires when the world moves under an open panel」 | 删除。没有「打开的编辑面板」可被世界移动 |
| 「an own-override row is edited through the entry that can re-save it」 | 删除。逐行写入口不存在 |
| 「an appended section is re-editable as the append it is」 | 删除。同上 |
| 「editing a section draws the form inside that section row」 | 删除。没有行内表单；行只读披露由「overview: copy/expand」用例覆盖 |
| 「the append entry owns no row and keeps the page-level slot」 | 删除 |
| 「an own-override row opens its form at its own entry」 | 删除 |
| 「a filtered-away row sends the form to the slot without losing the text」 | 删除。`editorPlacement` 的三种回退随之删除 |
| 「a row that a reload removes sends the form to the slot too」 | 删除。同上 |
| 「a view switch keeps an open row form reachable」 | 删除。同上 |
| 「opening an edit form puts the caret in the text, once per session」 | 删除。`editorFocus` 滚动/落光标机制整块删除 |
| 「the append entry puts the caret in the name field」 | 删除 |
| 「the row switch closes the form it opened」 | 删除 |
| 「only the row that holds the open form reports itself expanded」 | 删除。`editSwitches` 助手改为断言「一个都不存在」 |
| 「opening another row folds the first and moves the one form」 | 删除 |
| 「expanding a row pulls the form in with the smallest scroll」 | 删除 |
| 「a node with no scrollIntoView is survivable」 | 删除（`scrollIntoView` 已无调用方） |
| 「a row cannot fold the append entry it does not own」 | 删除 |
| 「folding and re-opening the same row re-arms scroll and caret」 | 删除 |
| 「the workspace layer is refused locally when no session is selected」 | → 「我的 Prompt」workspace 无 session：本地拒绝、0 次写、`data-mine-state=error` + `error.workspace-unresolved` |
| 「a saved override is re-read from a changed snapshot」 | → 保存后重读 `merged.overrides`，文本框显示已存储文本、状态回到 `saved` |
| 「overrides can be listed and undone, one entry at a time」 | → 「the legacy override list is read-only」：列表与每行标记逐字断言，且 `undo`/`reset-section`/`edit`/`delete` **一个都不存在**、0 次写 |
| 「restoring one section default asks first and then clears every layer that holds it」 | → 「恢复默认」只作用于保留名：二次确认（`data-confirm-kind="mine-reset"`）→ 一条 `DELETE …&name=<保留名>` |
| 「a section held by both layers clears both, one request per layer」 | 删除。「一次清多层」只可能是跨层任意名删除，写面不支持 |
| 「overrides view: the override list, the history log, the transfer panel, the layer reset」（sweep） | 拆为「history: 日志 + 差异 + 传输」与「advanced: 只读列表 + 两个按钮 + 状态区」两条 sweep 用例 |
| 其余 4 条 sweep「overrides view / editor / editor entry…」 | 改写为「advanced: …」「mine: …」「overview: …」，标记与文案逐条换成新面板的 |

**仍在用的断言一条没放宽**：`data-region="sections"/"filters"/"full"/"diff"/"history"/"history-diff"/"transfer"/"layer-reset"/"confirm"/"status"/"build"/"session*"`、
`data-diff-*`、`data-import-*`、`data-history-*`、`data-error-code`、`data-renderer`、`data-build*`、`data-frozen-state*`、ARIA 树用例、
降级渲染器用例、会话选择器全部用例均保留（只在需要时先切到拥有该面板的 tab）。

### 四、本 revision 专有新增断言

① 四个 tab 存在且**顺序**逐值等于 `['mine','overview','history','advanced']`；② 默认 tab = `mine`（`data-active-tab` 在容器与根上各一份）；
③ 切 tab 只渲染对应面板（一个 `data-region="tab-panel"`、其 `data-tab-value` 等于激活值，其余 tab 的顶层 region 数量为 0）；
④ 保存请求 URL/method/body：`section.name` 与 `import { CUSTOM_SECTION_NAME } from '../core/custom.js'` **逐字相等**且 `action='replace'`；
⑤ 恢复默认：先 `data-region="confirm"`（`mine-reset`）→ 0 请求 → 一条 `DELETE ...&name=<保留名>`；
⑥ 只读总览：两个内层视图 × 两个渲染器分支，`data-region="editor"` 与写类 `data-action` 均不存在，且 `copy` 仍在；
⑦ 高级两个按钮：`legacy-clear` → `...&legacy=true`、`reset-layer` → `...&reset=true`，各自先渲染二次确认，取消则 0 请求；
⑧ 冻结警告可见：`data-warning="mine-frozen"` + 原因；⑨ 保留名常量一致性（见 ④）；⑩ `histAction.legacy-clear` 在历史行里渲染为文案而非原始动作串；
⑪ 保留段不在总览重复展示（`data-note="reserved-own-tab"`）；⑫ 段状态 tag 由 `section.action` 派生；⑬ `write-locked`/`unsupported-action`/`conflicting-query` 三个错误码有 zh/en 文案。

### 五、负向对照（改坏 → 红 → 还原 → 绿）

三条，逐条在 worktree 内做；「还原」用备份副本回写（**不用 `git checkout`**，因为本轮改动尚未提交，
checkout 会把整个改动回滚掉），并用 `shasum -a 256 -c` 确认逐字节回到改坏前：

| # | 改坏 | 期望红 | 实测（`test/client.test.mjs` 单文件，92 项基线 0 fail） |
| --- | --- | --- | --- |
| ① | 在 `renderSectionsView` 里放回一个 `data-action="edit"` 按钮 | 「总览无写入口」类用例红 | **2 fail / 90 pass**：`client: 「提示词总览」 renders no write entry at all`、`client: a non-overridable section states its verdict and its reason` |
| ② | 把默认 tab 从 `'mine'` 改成 `'overview'` | 「顺序与默认 tab」「我的 Prompt 保存」类用例红 | **9 fail / 83 pass**：默认 tab、保存/恢复默认/失败/workspace 五条写面用例，以及两条英文横扫（缺 `data-active-tab=mine` 等分支标记） |
| ③ | 去掉 `legacy-clear` 的二次确认（`onClick` 直接调 `clearLegacy(layer)`） | `data-confirm-kind="legacy-clear"` 与「先确认再写」类用例红 | **4 fail / 88 pass**：`「清除全部覆盖」 confirms first…`、`「清除全部覆盖」 can be cancelled without writing`、两条英文横扫（缺 `data-confirm-kind=legacy-clear`） |

三条都「改坏 → 红 → 备份回写 → `shasum -a 256 -c` 逐字节确认 → 绿（92/0；全包 360/0）」；
还原后 `client.js` 哈希 `6f585108…`、`test/client.test.mjs` 哈希 `a5eececf…`，与改坏前一致。

### 六、未验证项 / 交给主管（诚实清单）

- **`legacy=true` / `reset=true` 新路由的真机行为本轮无法验证**：客户端半由 DSH 自身 HMR 热替换，不重启即可验；
  但**宿主仍是 Revision 6 的**（新路由 `?legacy=true` 需要重启 `dsh web` 才注册），因此真机只验证了
  「四个 tab 可见可切 / 默认 tab 正确 / 「我的 Prompt」能保存」（保存走的是 Revision 3 就有的 `PUT`），
  `legacy=true` 的真机返回值标「未验证（需重启）」。
  > **更正（2026-09-29，真机已验）**：本条已闭合。宿主重启后主管实测新路由：空层 `?legacy=true` ⇒
  > 200 `count:0` / `history:null`；`reset=true&legacy=true` 同时给 ⇒ 400 `conflicting-query`；
  > `?reset=true` 原语义不变。证据见 `.dsh-graph` 的 `goals/g-014/goal.md`「§七·补」与 g-015 评论区。
- **滚动手感与 VoiceOver 层级朗读未验证**：tab 切换后的焦点位置、`SegmentedTabs` 在真实 DSH 里的键盘行为
  没有在真机上逐项走查（本机只做了 CDP DOM 探针，不做朗读）。
- **`mine-frozen` 的两种来源未在真机分别复现**：一种是 `frozenScope:"session"` + `frozen:true`，
  另一种是保留段 `applied:false`；两者都由单测覆盖，真机需要构造 `complete` 段才能触发。
- **英文文案的字距/换行未在真机核对**：只保证 en 渲染横扫无 CJK、无裸键。

### 七、本轮实测证据

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test`（包目录，worktree `.worktrees/g-015-att-01`） | **360 / 360 pass / 0 fail / 0 skipped**（基线 `f02463a` = **377 / 0**；`test/client.test.mjs` 109 → 92，见第三节映射表；其余 5 个测试文件一条未动） |
| 客户端单文件 | `node --test test/client.test.mjs` | **92 / 92 pass / 0 fail** |
| 语法 | `node --check client.js`、`node --check test/client.test.mjs` | 通过 |
| 词典 | 键集比对 | zh/en 各 **256** 键、**对称差为空**；死键仅剩基线就有的 2 个（`nextTurn`/`importBadJson`，未动） |
| 英文横扫 | `test/client.test.mjs` 内 | 39 个场景、6946 条渲染字符串、80 个必达分支标记，零 CJK、零裸键 |
| 打包 | `npm pack --dry-run` | 文件数不变（本轮不新增文件），`test/` 仍被排除；包体比基线略小（`client.js` 净减约 20 kB） |
| 负向对照 | 三条「改坏 → 红 → 备份回写 → `shasum -a 256 -c` → 绿」 | 2 / 9 / 4 fail；还原后哈希逐字节一致，全量回到 360/0（详见第五节） |
| 契约 diff | `CONTRACT.md` | §13 由 2 节重写为 **7 节**（四个 tab 的标记、唯一写入口、只读总览、历史/高级、四种二次确认、常量一致性）；§7 限制 21 由「客户端仍是 Revision 6 编辑器」改写为「g-015 已解决」；§12.1/§12.3 的交叉引用随之更新 |
| 文档 | `README.md` | 顶部能力描述、包内容表、i18n 表（39 场景 / 6946 字符串 / 80 标记）、新增「设置页的四个一级 tab」章、Revision 7 边界章标题与限制 21 |
| 哈希 | `shasum -a 256` | `client.js` `6f585108…`、`test/client.test.mjs` `a5eececf…`（负向对照断言基线） |

**真机验证（真浏览器 CDP：真 Chrome 154 + 真 React 18.3.1 + 真 DOM + 本 worktree 的 `client.js` 字节）**

配方：`node` 内置 `WebSocket` 驱动 CDP（无第三方依赖）；Chrome `--headless=new --no-sandbox --remote-debugging-port=9333`；
一个只读静态服务器把**本 worktree 的** `client.js`（`shasum` `6f585108…`，逐字节确认）与 React 18 UMD 发给页面；
页面用真实 `ReactDOM.createRoot` 渲染真实组件，`fetch` 用内存路由打桩，其余（模块加载器、`ctx`、locale 座位）最小替身。
探针按真人方式 `el.click()` 与原生 setter + `input` 事件驱动，读回真实 DOM：

| 断言 | 实测 |
| --- | --- |
| 四个一级 tab 与顺序 | `['mine','overview','history','advanced']`（`data-tab-key="main"` 的按钮数组） |
| 分组标记在两个分支都在 | `[data-region="tabs"] [data-tab-group]` = `main` |
| 默认 tab | 容器 `data-active-tab="mine"`、根容器 `data-active-tab="mine"`、`data-region="tab-panel"` **恰好 1 个**且 `data-tab-value="mine"` |
| 切 tab 只渲染对应面板 | overview：`{history:0, transfer:0, overrides:0}`；history：`{history:1, transfer:1, overrides:0}`；advanced：`{overrides:1, layerReset:1, statusDetail:1, history:0}`；每次仅 1 个 panel |
| 「我的 Prompt」能保存 | `data-mine-state` 走 `unconfigured → dirty → saved`；真发出一条 `PUT /prompt-setting/overrides`，body = `{"layer":"user","section":{"name":"prompt-setting:custom-prompt","action":"replace","text":"my own house rules from a real browser"}}`；保存后文本框仍显示该文本，notice = `success` |
| 总览确实无编辑入口 | `document.querySelectorAll('[data-region="editor"]').length === 0`；写类 `data-action` 过滤结果 `[]`；实际 `data-action` 全集 = `['copy','expand','refresh','session-apply','session-global']`；`[data-region="mine"]` 在总览打开时为 0；保留段说明行文本正确 |
| 高级的二次确认真的挡住请求 | 点 `legacy-clear` 后 `data-confirm-kind="legacy-clear"`，此时 DELETE 计数 **0**；点「取消」后确认卡消失、DELETE 仍 **0** |
| 一行状态摘要 | `data-status-mount="true"`、`data-status-frozen="unfrozen"`、`data-status-build="unknown"`，三个 tag 文案可读 |
| 控制台/加载错误 | `__PROBE__.errors === []`（模块加载、`apply`、React 渲染全程无异常） |

**真机未覆盖的部分（诚实说明）**：这条探针验证的是**真实浏览器里的真实组件与真实字节**，但它不是
`dsh web` 设置页外壳内的那一次渲染 —— 原因有两条，都不是本轮能绕开的：

1. **运行中的 `dsh web` 服务的是主工作树的 `client.js`**：插件在 profile 里是
   `link:.../dsh-prompt-setting/packages/dsh-prompt-setting`，宿主用
   `fileURLToPath(new URL('./client.js', import.meta.url))` 读自己那份，因此它读到的是**主工作树**的文件；
   而主工作树（`main` 语义的已发布分支）本轮**禁止改动**。所谓「HMR 热替换不重启就能验」的前提是
   被服务的那份文件在变，这里不成立。
2. **`http://127.0.0.1:3080` 对非浏览器请求返回 401**：会话凭证由 `dsh web` 的进程令牌 URL 行下发，
   本会话拿不到；即使用无头 Chrome 直连该端口也只会拿到 401。而重启 `dsh web` / 装卸插件 / 改 profile
   都在硬性禁止之列。

因此以下三项**仍未在 `dsh web` 外壳内验证**，留给主管：真机滚动手感、tab 切换后的焦点位置与 VoiceOver
层级朗读、`SegmentedTabs`（primitives 分支）在真实 DSH 里的键盘行为。

## 94. 「查看范围」默认收成一行摘要 +「更改」展开（g-016，2026-09-29，基线 `cc9f844`）

g-015 把设置页切成四个 tab，但**共用的会话选择器仍然整块展开**，所以「页面太长」只解决了一半。
本目标把它改成**折叠区**：默认只有一行摘要 + 一个「更改」开关，选中范围后自动收回去。

### 一、问题（主管真机实测，逐条为既有事实，不是推测）

| 事实 | 数字 |
| --- | --- |
| `data-region="session"`（搜索框 + 30 个会话的分组树 + 分页 + pinned + 4 行帮助文案） | 高约 **500px** |
| `data-region="tabs"` 的 y 坐标 | **≈789** |
| `data-region="tab-panel"` 的起始 y | **≈1025**（折线 900 以下） |
| 结论 | 打开页面**看不到任何 tab 内容**，必须先滚动 |

### 二、落了什么（函数级，只动 `packages/dsh-prompt-setting/{client.js,test/client.test.mjs,README.md,NOTES.md,CONTRACT.md}`）

| 位置 | 内容 |
| --- | --- |
| `scopeSection(t, m, a, body)`（**新增**） | 「查看范围」卡片的唯一出口。永远渲染一行 `data-region="scope-summary"`：`h3` 标题 + `data-role="scope-summary-label"`（可读范围名）+ **仅在降级时**出现的 `data-role="scope-summary-hint"` + 一个 `UI.Button`（`data-action="scope-toggle"`、`variant="outline"`、`aria-expanded`/`data-expanded` = `m.scopeOpen`、文案 `scopeEdit`/`scopeCollapse`）。`data-scope-open` 落在 `data-region="session"` 上，`body` 只在 `m.scopeOpen` 时展开渲染（`...(m.scopeOpen ? body : [])`，body 项本身就是同级兄弟，不新增包裹层，既有 `elementChildren`/ARIA 结构断言不受影响） |
| `renderSession`（**改写，行为不变**） | 手动降级分支与正常分支都改为「组装 body → 交给 `scopeSection`」；两个分支各自删掉原来自己渲染的 `h3`（标题现在在摘要行里），返回语句由 `h('section', …)` 改为 `scopeSection(t, m, a, children)`。body 内容（pinned / `session-current` / 搜索 / 计数 / 树或列表 / no-match / empty / degraded / 键盘提示 / note）**一个标记都没动** |
| 样式（新增 3 个常量） | `scopeSummaryStyle`（`display:flex; align-items:center; gap:8; flexWrap:wrap; minHeight:24`）、`scopeSummaryTextStyle`（13px / lineHeight 20px / `token.labelPrimary`）、`scopeSummaryHintStyle`（`metaStyle` + lineHeight 18px）；沿用既有 token 与 `cardStyle` / `headingStyle` / `metaStyle`，不新增依赖、不新增颜色 |
| 状态 | 新增 `const [scopeOpen, setScopeOpen] = React.useState(false)`；`model.scopeOpen` |
| 动作 | 新增 `toggleScopeOpen: () => setScopeOpen((open) => !open)`；新增局部 `closeScope = () => setScopeOpen(false)`，只在**完成选择**的动作里调用：`pickSession`、`useCurrent`、`useTypedId`、`onSessionKeyDown` 的 Enter 两支（选中高亮行 / 无匹配时按输入 id）、`applyManual`、`useGlobal`。`toggleScope`（工作区分组）、`showMoreScope`、`setSessionQuery` **不调用**它 |
| 词典 | zh/en 各新增 **4 键**：`scopeEdit`（更改 / Change）、`scopeCollapse`（收起 / Collapse）、`scopeSummaryManual`（会话服务不可用：手动输入 id / Session service unavailable: type an id）、`scopeSummaryFlat`（工作区服务不可用：平铺列表 / Workspace service unavailable: flat list）。挂载后 `Object.keys` zh = en = **298**（含运行期注入的 `error.*`）、对称差为空 |

**手动降级分支也一起折叠**：理由是一致性（「查看范围」在任何座位下都先是一行），且降级态本来也没有树可藏；
摘要行用 `scopeSummaryManual` 说明「会话服务不可用」，比把整段 `sessionLimit` 长句摊在首屏更符合「必要状态提示」。

### 三、用例映射表（既有断言一条未放宽，只加了「先展开」这一步）

`test/client.test.mjs` 里需要断言选择器**内部**的用例，把 `makePage(...)` 换成 `makeOpenPage(...)`
（= `makePage({ scopeOpen: true })`）。`makeOpenPage` 只是让 harness 在**每次 `flush()` 前**先点一次
「更改」（选择后组件会自动收起，所以是每次而不是一次）——**用例正文、断言内容、断言强度全部零改动**。
基线 **92** 条 → 本轮 **97** 条（净 +5：新增 5 条，既有 92 条一条未删）。

| # | 用例（`makeOpenPage`，共 24 条 / 29 处页面构造） |
| --- | --- |
| 1 | `the session selector defaults to the current view session` |
| 2 | `switching to the global option drops ?session= and re-reads the snapshot` |
| 3 | `a missing useSessions degrades to a manual id and says so` |
| 4 | `a useSessions hook that throws degrades instead of blanking the panel` |
| 5 | `the session picker renders a bounded list at every catalog size` |
| 6 | `the session search matches title, path and id, case-insensitively` |
| 7 | `a query that matches nothing becomes a manual session id` |
| 8 | `the pinned entries are never filtered away` |
| 9 | `picking a row refills the search box with the readable title` |
| 10 | `the session list is keyboard reachable` |
| 11 | `the scope picker groups sessions by workspace, like the sidebar` |
| 12 | `the scope tree keeps the ancestor workspace of every search match` |
| 13 | `a workspace group folds, unfolds, and pages its rows in` |
| 14 | `the scope tree never renders the whole catalog (200 / 500 / 2000 sessions)` |
| 15 | `a missing useWorkspaces degrades to the flat searchable list` |
| 16 | `every workspace node advertises and toggles its expansion state` |
| 17 | `the folder glyph is the sidebar artwork in both renderer branches` |
| 18 | `the selected session and the pinned scope carry an explicit selected mark` |
| 19 | `the「查看范围」tree is a standard ARIA tree (tree > treeitem + group > treeitem)` |
| 20 | `opening and shutting a workspace adds and removes its group, never an empty one` |
| 21 | `a search keeps the tree shape, including the ungrouped bucket` |
| 22 | `with no workspaces every session stays level 2 inside the named bucket` |
| 23 | `the「显示更多」action is a child of its group, never a tree child` |
| 24 | `the flat fallback declares a listbox instead of faking a tree` |

英文渲染横扫（`EN_SWEEP_CASES`）里**要给选择器打标记/断言其文案**的 4 个场景同样只加了 `scopeOpen: true`
（`status card: an unmounted assembly and a degraded session seat`、`session selector: the workspace tree,
its archived note and its search hint`、`session selector: the flat fallback says it is degraded`、
`session selector: a catalog over both render caps warns instead of spreading`），断言逐条不变。

**新增 5 条**（均为折叠态本身）：

| 用例 | 断言 |
| --- | --- |
| `the「查看范围」picker ships collapsed, with no body on screen` | `data-scope-open="false"`；摘要含标题与 `当前：Alpha three`；`session-tree`/`session-list`/`session-pinned`/`session-search`/`scope-search-hint`/`session-current`/`group-toggle`/`scope-more` **逐个断言节点数为 0**；`scopeSearchHint`/`sessionKeyboardHint`/`sessionSelectedNote`/`sessionGlobalNote` 四行帮助文案**不在渲染字符串里**；降级座位（无 `useSessions`）与扁平座位（无 `useWorkspaces`）各给出 `scopeSummaryManual` / `scopeSummaryFlat` 提示，且长句 `sessionLimit` 不在屏上 |
| `「更改」 is one switch that reports aria-expanded and brings the picker back` | 点「更改」→ `data-scope-open="true"`、`aria-expanded=true`、`data-expanded="true"`、按钮文案变 `scopeCollapse`、树/搜索/pinned/分组/搜索提示全部回来；再点同一个按钮 → 回到 `false` |
| `the summary names the scope, and the range decides the label` | 扁平座位：摘要 = `当前：Second` + `scopeSummaryFlat`；切到 pinned「全局」后摘要 = `全局（不指定会话）`，旧标签**不再出现** |
| `choosing a scope shuts the picker, and the summary follows it` | 四条选择路径各自「一次点击即收起 + 摘要更新」：点会话行（`a1`）、pinned「全局」、键盘 ArrowDown+Enter（`a2`）、无匹配时点「按该 id 查看」（`pasted-id-42`）；同时断言**输入搜索文本本身不会收起**（`data-scope-open` 仍为 `true`） |
| `the collapsed「查看范围」block is one row inside an 80px budget` | 折叠态 `data-region="session"` 的**元素子节点恰好 1 个**且是 `data-region="scope-summary"`；摘要行元素 ≤ 4 个、其中 button 恰好 1 个、`<p>` 0 个；高度预算 ≤ 80px；展开后同一节点数 > 折叠态 2 倍且树存在（证明预算不是空断言） |

`EN_REQUIRED_MARKERS` 同步新增 6 个必达分支标记：`data-region=scope-summary`、`data-scope-open=false`、
`data-scope-open=true`、`data-action=scope-toggle`、`data-role=scope-summary-label`、
`data-role=scope-summary-hint`；并新增 1 个 en 场景
（`scope summary: the「查看范围」block ships collapsed, with no picker body`）确保这些标记真的被渲染过。

### 四、折叠态几何断言的实际数值

离线预算函数 `collapsedScopeHeight(tree)`（写在 `test/client.test.mjs`，与用例同区）：

```
卡片垂直内边距 12×2 = 24px  +  摘要行 minHeight = 24px  +  一行文本余量 = 22px  ⇒  70px
```

- **实测（`node --test` 输出）**：`scope geometry: collapsed「查看范围」= 70px budget (80px), 37 nodes; expanded = 102 nodes`
  —— 折叠态渲染树 **37 个宿主节点**，展开态 **102 个**。
- 结构性那一半同样可断言：折叠态 `data-region="session"` 的元素子节点恰好 **1**（摘要行），
  展开态 **> 1**；摘要行内 button 恰好 **1**、`<p>` **0**。所以「默认改成展开」或「折叠态仍渲染 body」
  都会立刻变红（见第五节 ①②④）。
- **真机几何（`data-region="tabs"` 的 y 坐标 / 首屏可见性）本轮不测**：运行中的 `dsh web` 服务的是**主工作树**的
  `client.js`（profile 是 `link:`），worktree 的改动对它不可见（§93 第六节两条原因、长期记忆 `mem-820e8abb`、
  INDEX §一·补二）。按 brief 第 8 条，这一项**由主管在合并进 `v0.1.0-test` 后走 HMR 实测**。

### 五、负向对照（四条，逐条「改坏 → 红 → 备份回写 → `shasum -a 256` 逐字节确认 → 绿」）

四条都在 worktree 内做；「还原」用 `/tmp/g016-client-green.js` 副本回写（**不用 `git checkout`**，本轮改动尚未提交），
还原后 `client.js` 哈希 `9c5dc6ba74c6…` 与改坏前逐字节一致：

| # | 改坏 | 期望红 | 实测（`test/client.test.mjs`，97 项基线 0 fail） |
| --- | --- | --- | --- |
| ① | 默认改成展开：`useState(false)` → `useState(true)` | 5 条折叠态用例 + 2 条英文横扫 | **7 fail / 90 pass**：5 条新用例（折叠、开关、摘要、自动收起、几何）+ 英文横扫两条（缺 `data-scope-open=false`） |
| ② | 展开态不显示摘要：摘要行改成 `m.scopeOpen ? null : h('div', …)` | 开关用例（展开后找不到 `data-action="scope-toggle"`） | **1 fail / 96 pass**：`「更改」 is one switch that reports aria-expanded and brings the picker back` |
| ③ | 选中后不自动折叠：删掉 `pickSession` 与 Enter 分支里的两处 `closeScope()` | 自动收起用例 | **1 fail / 96 pass**：`choosing a scope shuts the picker, and the summary follows it` |
| ④ | 折叠态仍渲染整个 body：`...(m.scopeOpen ? body : [])` → `...body` | 折叠/开关/自动收起/几何四条 | **4 fail / 93 pass**：折叠、开关、自动收起、几何四条全红 |

四条都「改坏 → 红 → 副本回写 → `shasum -a 256` 逐字节一致 → 绿（97/0；全包 365/0）」。

### 六、未验证项（诚实清单，交给主管在集成检查点裁决）

- **外壳内的首屏几何未测**（本 attempt 的硬约束，不是遗漏）：`data-region="tabs"` 的 y 坐标、tab 面板是否
  真的落在折线以上，必须在合并进 `v0.1.0-test` 后由主管走 HMR 量。本轮只提供**离线预算 70px ≤ 80px** 与
  结构判据（1 行 + 1 按钮）。
  > **更正（2026-09-29，真机已量）**：本条已闭合。主管把改动合并进 `v0.1.0-test` 后，在真 `dsh web` 外壳内实测：
  > 折叠态 `[data-region="session"]` 高 **60px**、`[data-region="tabs"]` 顶边 **y=316**、`tab-panel` 顶边 **y=354**
  > （视口 900；改前分别是 789 / 1025）；点「更改」⇒ 533px / y=789 且会话行数 2；点一行会话 ⇒ 自动收回到 60px。
  > ⇒ 本节第四节的**离线预算 70px 是保守上界**，真机实际 **60px**。证据见 `.dsh-graph` 的 `goals/g-016/goal.md` 与 g-016 评论区。
- **未做独立真浏览器桩（CDP）补充证据**：g-015 用过「本地静态服务器 + React UMD + CDP」的手法，本轮**没做**
  —— 折叠带来的差异是**渲染树的有无**（离线断言已逐节点覆盖），而首屏几何属于外壳内的事，桩测不出结论；
  与其造一份不能回答关键问题的证据，不如把这一项如实交给主管。
- **观感/间距未在真机目视**：摘要行在真实 DSH 里的字号/行高与按钮高度、英文文案是否折行、`flexWrap` 在窄
  （< 640px）设置面板里是否变成两行，均未实测。离线预算对「折成两行」留了 22px 余量（70px），
  但**两行以上就会逼近 80px 上界**。
- **`scopeSummaryManual` / `scopeSummaryFlat` 的中文措辞未做用户测试**：这两个 hint 是本轮新造的用户可见文案
  （替代被折叠隐藏的长句）。
- **VoiceOver / 键盘焦点未走查**：`aria-expanded` 是正确的 ARIA 状态，但展开后焦点是否落在选择器内、
  收起后焦点是否回到「更改」按钮，本轮没有断言也没有真机走查。

### 七、本轮实测证据

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test test/*.test.mjs`（包目录，worktree `.worktrees/g-016-att-01`） | **365 / 365 pass / 0 fail / 0 skipped**（基线 `cc9f844` = **360 / 0**；本轮 +5 条，全部在 `test/client.test.mjs`，其余 12 个测试文件一条未动） |
| 客户端单文件 | `node --test test/client.test.mjs` | **97 / 97 pass / 0 fail**（基线 92） |
| 语法 | `node --check client.js`、`node --check test/client.test.mjs` | 通过 |
| 词典 | 挂载后 `Object.keys` | zh = en = **298**，`onlyZh = 0`、`onlyEn = 0`（字面各新增 4 键） |
| 英文横扫 | `test/client.test.mjs` 内 | **40** 个场景（基线 39）、**6718** 条渲染字符串（基线 6946，下降是因为默认折叠后多数场景不再渲染选择器 body）、**86** 个必达分支标记（基线 80）；零 CJK、零裸键 |
| 几何 | `test/client.test.mjs` 内 | 折叠态预算 **70px**（≤ 80px），**37** 宿主节点；展开态 **102** 节点 |
| 负向对照 | 四条「改坏 → 红 → 副本回写 → `shasum -a 256` → 绿」 | 7 / 1 / 1 / 4 fail；还原后哈希逐字节一致，全量回到 365/0（详见第五节） |
| 打包 | `npm pack --dry-run --cache /tmp/g016-npm-cache` | **17** 个文件，`test/` 命中 **0**；无新增文件、无临时文件残留 |
| 哈希 | `shasum -a 256` | `client.js` `9c5dc6ba74c6…`、`test/client.test.mjs` `f75543e9ac41…`（负向对照断言基线） |
| 契约 | `CONTRACT.md` | §13 标题补 g-016；§13.0 说明选择器自己也是折叠的；**新增 §13.7**（折叠/展开/开关/选中即收起的完整契约与标记表） |
| 文档 | `README.md` | 包内容表补「默认折叠」；「四个一级 tab」章补一句交叉引用；**新增「查看范围默认收成一行（g-016）」章**；ARIA 树章标注为展开态语义；i18n 表数字 39/6946/80 → 40/6718/86；Revision 7 边界补一条「打开页面看不到 tab 内容（g-016 已解决）」 |


## 95. 让「我的 Prompt」真·排最后（g-017，2026-09-29，基线 `628d0c7`）

g-014 用 `order: 1000000` 让保留段排在**所有注册段**的最后，真机重启后验收却发现：最终 prompt 的
最后一段不是用户写的话。本目标在瀑布里加**一个单一职责的 `prepend` 监听器**把它搬到末尾。

### 一、真机事实与根因（重启后验收实测，不是推测）

| 事实 | 值 |
| --- | --- |
| 我们的保留段 `prompt-setting:custom-prompt` 在 `base.sections` 的位置 | **最后一项**（`order=1000000` > 仓库内置最大 `10200`）——`order` 这条承诺是准的 |
| 最终 `assembly.sections` 的最后一项 | **`dsh-expression:companion`**（`origin: downstream-added`，本机斗图插件） |
| 原因 | 它的 `system-prompt/assemble` 监听器**注册在我们之前** ⇒ 对我们是**外层**；`next()` 返回后它才追加自己的段 ⇒ 它的 post-`next()` 比我们的晚执行 |
| 契约依据 | §6·E2：瀑布**由外到内**（`outer:in → inner:in → inner:out → outer:out`），**最先注册的是最外层**，其 post-`next()` 最后执行；`{prepend: true}` 可让监听器排到最前（平台自己在用：`dsh-session-reference` 的 `ctx.on(..., { prepend: true })`；本轮读 `@deepseek-ai/cordis@4.0.4` `lib/index.js` 的 `register()` 确认：`const method = options.prepend ? "unshift" : "push"`） |

**结论**：`order` 只能承诺「排在所有内置段之后」（对，但不够）；要让用户的话真咬在最后，必须占住
**「最外层监听器」**这个位置。这两件事互相独立，缺一不可。

### 二、落了什么（函数级，只动 `packages/dsh-prompt-setting/{index.js,core/custom.js,test/*.test.mjs,README.md,NOTES.md,CONTRACT.md}`）

| 位置 | 内容 |
| --- | --- |
| `core/custom.js` → `reservedSectionLast(result)`（**新增**，纯函数） | 4 个 identity 分支：`sections` 不是数组 / 没有该名字的段 / 该段已在末尾 / `text` 不是非空字符串 ⇒ **按引用原样返回**；只有「存在 + 有文本 + 不在末尾」才返回 `{...result, sections: [...其余, 保留段]}`。**只换 `sections` 数组，段对象本身不复制**；无 IO、无 `ctx`、无时钟，任何形状都不抛 |
| `index.js` → `keepReservedLastHandler(assembly, context, next)`（**新增**） | `const result = await next();` → `try { return reservedSectionLast(result); } catch { return result; }`。始终 `next()`（不否决）；`try` 是与 `assembleHandler` 同一个 fail-open 规则（装配路径上的异常会毁掉用户一轮） |
| `index.js` → 第 4 个 `registerEffect`（**新增**） | `() => ctx.on('system-prompt/assemble', keepReservedLastHandler, { prepend: true })`，标签 `` `prompt-setting: keep the reserved section last` ``；注册位置在**覆盖监听器之后、段注册之前**（段注册仍最后 ⇒ 台账顺序仍是「越可能失败越先注册」）。`ctx.on` 不可用/抛错 ⇒ 与既有监听器同一失败模式（一条可读信息、整体回滚、绝不启动失败）；宿主忽略第三参数 ⇒ 不退化为失败，只是失去最前位置 |
| `index.js` → `assembleHandler` / 段注册 / 路由 | **逐字未动**（`git diff` 只有注释与新增块）：`base` 记录、探针消费、`detectFrozen`、`applyOverrides` 与其「无覆盖按引用返回」全部原样；既有监听器**没有**改成 prepend |

**为什么只搬「有文本」的段**（刻意选择，不是省事）：空段渲染零字节（§15.2），它在 `sections` 里的位置
在 prompt 里**不可观察**；而搬动会让「无配置时按同一对象引用返回（identity）」失效，连带破坏
「未配置 = 与没装插件逐字节相同」这条既有承诺。所以未配置时该监听器**什么都不做** —— 负向对照 ②
（让空文本也搬）会立刻打出 identity / 零贡献类断言红（见第五节）。

### 三、被否掉的做法（写清楚，免得下轮返工）

| 路线 | 为什么否掉 |
| --- | --- |
| 把 `order` 调更大（1e9） | 无效：追加段的落地顺序由**监听器内外层**决定，不由 `order` 决定。`order` 只决定**注册序**，而 `dsh-expression` 是在 `next()` 返回后往数组里 push |
| 把**既有**覆盖监听器也改成 `prepend` | 会让覆盖应用发生在最外层，改变 `base` 记录/探针消费「在 `next()` 之前同步完成」的时序（§5.3、§15）与 identity 保证；brief 亦明令既有监听器注册位置不动 |
| 让空文本也搬（无条件下搬） | 破坏 identity 与零贡献（既有 g-014 断言会红）；收益为零（空段位置不可观察） |
| 在装配路径上读配置判断「用户写了没有」 | 违反「装配路径零 IO」（§5.5）：文本是靠既有覆盖引擎进段的，监听器只读内存 |
| 干脆不响应 `complete` 场景 | 本来就是不可抗的平台行为，如实写进契约与 README，不假装解决 |

### 四、用例映射表（既有断言**一条未放宽**，只允许等价改写）

基线 `628d0c7` 全包 **365 / 0 fail**；本轮 **373 / 0 fail / 0 skipped**（净 +8：`custom.test.mjs` +3、
`integration.test.mjs` +5；`build / client / diff / history / overrides / stage2 / store / transfer` 这 8 个测试文件**逐字节未动**）。

| 文件（用例） | 改动 | 强度 |
| --- | --- | --- |
| `test/custom.test.mjs`（新增 3 条） | `reservedSectionLast` 的搬动 / identity（`===` 引用相等）/ 任意形状不抛 | 新增 |
| `test/integration.test.mjs`（新增 5 条 R8） | 外层追加下「有文本搬动 / 无文本不搬」、逐字节 prompt、complete 冻结不变、hand-edited `hide` 不崩、`dispose()` 后无残留 | 新增 |
| `test/boot.test.mjs`「a host with no systemPrompt.section …」 | `'已撤销 2 项已注册 effect'` → `3` | 等价（数字随 effect 数 +1 同步；语义未变） |
| `test/boot.test.mjs`「a section registration that throws …」 | `disposedCount()===2` → `3`，文案改「every earlier effect」 | 等价（同上） |
| `test/host.test.mjs`「mounting registers one assemble listener …」→「… two assemble listeners (one prepended) …」 | 计数 `1→2`、`3→4`、`2→3`；标题改名 | **增强**：新增「恰有 1 个 prepend / 覆盖监听器未被移动 / 两个回调不同」三条断言 |
| `test/route.test.mjs`「assembly: … BY IDENTITY」 | `listeners.length===1` → 结构断言（顺序 + prepend 标记）；新增「最内层监听器拿到原始 assembly，最外层返回值与它**引用相等**」 | **增强**（原用例只断言段名，实际没有断言 identity） |
| `test/route.test.mjs` F1「a third-party listener that appends …」 | 删掉 `const original = listeners[0]; assert.equal(original !== undefined, true)`，改为 `listeners.length===2` | 等价（原断言恒真、零信息量），新断言更强 |
| `test/route.test.mjs` / `test/host.test.mjs` 的 `on()` 桩 | 记录第三个参数，并按 `{prepend:true}` `unshift`（忠实模拟 shipped `ctx.on`） | harness 保真度提升；没有放宽任何断言 |

### 五、负向对照（4 条：改坏 → 红 → 还原 → `shasum -a 256 -c` 逐字节 → 绿）

四条都是「单点改坏 → 跑 `custom + integration + route + host` 四个套件（108 条）→ 从 `/tmp/g017-neg`
副本回写 → `shasum -a 256 -c` 确认逐字节一致 → 全量复绿」。

| # | 改坏 | 红的用例（4 / 4 / 4 / 3 条） | 结果 |
| --- | --- | --- | --- |
| ① | 去掉搬动（`findIndex` 恒 -1） | `custom: …moves the reserved section to the end…`、`custom: …never throws…`、`integration R8: with text configured…`、`integration R8: disposing the mount…` | **4 fail / 104 pass**，还原后 **108 / 0** |
| ② | 空文本也搬（删掉 `text` 非空判断） | `custom: …BY IDENTITY whenever nothing moves`、`integration R8: with nothing configured…`、`integration R8: with text configured…`、**既有** `F1: a third-party listener that appends a section is NOT read as a freeze` | **4 fail / 104 pass**，还原后 **108 / 0**（② 打出 identity / 零贡献类断言红，且被**既有**用例抓到一个位置漂移） |
| ③ | 去掉 `{prepend: true}` | `host: …two assemble listeners (one prepended)…`、`integration R8: with text configured…`（追加段重新跑到最后）、`integration R8: disposing…`、`assembly: …BY IDENTITY` | **4 fail / 104 pass**，还原后 **108 / 0** |
| ④ | 保留搬动但每次都重建（identity 失效） | `custom: …BY IDENTITY whenever nothing moves`、`integration R8: hand-edited hide…`、`assembly: …BY IDENTITY` | **3 fail / 105 pass**，还原后 **108 / 0** |

还原后 `core/custom.js` = `9995d7bb…`、`index.js` = `7cb9b32a…`（与改坏前的基线哈希逐字节一致）。

### 六、残余边界（契约 §15.10 / §7 第 22–24 条，如实写）

1. **`complete: true` 的 scope**：平台在瀑布**之后**把整段列表替换为该 complete 段（源码
   `assemble()` 结尾 `sections: completeSection === void 0 ? transformed.sections : [completeSection]`）
   ⇒ 我们的搬运**和**外层追加的段一起被丢弃。本插件不可抗；快照仍报 `frozen: true` + `frozenReason`，
   保留段 `applied:false` + `reason: "the section was removed from the assembled result"`（集成用例断言逐字不变）。
2. **挂载之后**才以 `{prepend: true}` 注册的外部监听器：`prepend` 是「抢最前」，晚来的 prepend 会排到
   我们之前，其 post-`next()` 也就晚于我们 ⇒ 它追加的段真的在最后。我们不去重排别人的段。
3. **我们只搬自己的段**：搬运是 splice（`[...前, ...后, 保留段]`），别人的相对顺序逐字保留；段对象、
   别的字段、`base.sections`（注册视图）全都不动。

### 七、未验证项（诚实清单，交给主管在集成检查点裁决）

- **真机未验证（需重启 `dsh web`）**：本目标是**宿主半**改动，运行中的进程必须重启才可能看到效果。
  本轮按硬性禁止**没有重启**，因此「重启后最终 prompt 最后一段 = 保留段」**没有**真机证据。请主管在下次
  重启后把 `data-build` 与快照/渲染文本的最后一项一起看（快照 `base.sections` 的那一条**不会**变，要看
  真实回合的渲染结果或 `assembly.sections` 的最后一项）。
  > **更正（2026-09-29，真机已验）**：本条已闭合。负责人重启后主管在真 `dsh web` 外壳内实测：**未配置**时
  > `effective.sections` 末项仍是 `dsh-expression:companion`（保留段空 ⇒ 不搬动，按引用原样返回）；**写入文本**后
  > 保留段变成**末项**、`dsh-expression:companion` 退到倒数第二，且拼出的 `rendered` **真以用户文本结尾**；
  > 点「恢复默认」⇒ 顺序复原、`overrides.json` SHA-256 前后一致。证据见 `.dsh-graph` 的 `goals/g-017/goal.md`、
  > g-017 评论区与长期记忆 `INDEX.md` §七。
- **残余边界 ②（挂载后再 prepend 的第三方）是推演 + 间接证据**：结论来自 `@deepseek-ai/cordis@4.0.4`
  `register()` 的 `unshift` 语义与 §6·E2 的实测语义，以及负向对照 ③（去掉 `prepend` ⇒ 追加段回到最后）
  的对照；本轮**没有**构造一个真机第三方插件去实测它。
- **宿主忽略 `ctx.on` 第三参数的情形未实测**：本机 cordis 4.0.4 支持；代码路径是「仍注册、只是不在最前」，
  不是失败（§15.9 已写明）。boot 桩只覆盖 `ctx.on` 缺失/抛错两条既有失败模式。
- **客户端未改也不需要改**：目标不涉客户端；但**页面不会告诉你「排最后」这件事**（快照视图里保留段本来
  就靠 `order` 在最后，与瀑布之后的实际位置无关），本轮未加任何 UI 文案 —— 若主管认为需要在「我的 Prompt」
  面板写一句位置说明，那是新目标。
- **未做浏览器/CDP 验证**：无 UI 改动，无可视对象可测。

### 八、本轮实测证据（worktree `.worktrees/g-017-att-01`，基线 `628d0c7`）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test`（包目录） | **373 / 373 pass / 0 fail / 0 skipped / 11030ms**（基线 **365 / 0**；净 +8） |
| 集成单文件 | `node --test test/integration.test.mjs` | **21 / 21 pass / 0 fail**（基线 16） |
| 内核单文件 | `node --test test/custom.test.mjs` | **17 / 17 pass / 0 fail**（基线 14） |
| 语法 | `node --check index.js`、`node --check core/custom.js` | 通过 |
| 关键集成证据 | `integration R8` 断言（真 Cordis + 真 `@deepseek-ai/dsh-system-prompt` + 模拟 `dsh-expression` 的**外层追加**监听器） | 有文本：最终 `[…, dsh-expression:companion, prompt-setting:custom-prompt]`，`renderPrompt = 无插件 prompt + "\n\n" + 用户文本`；无文本：`[…, prompt-setting:custom-prompt, dsh-expression:companion]`，`renderPrompt` 与无插件逐字节相同；`assembly === 追加监听器返回的对象`（identity） |
| 负向对照 | 4 条「改坏 → 红 → 副本回写 → `shasum -a 256 -c` → 绿」 | 4 / 4 / 4 / 3 fail；还原后哈希逐字节一致、四套件回到 108/0、全量 373/0（详见第五节） |
| 打包 | `npm pack --dry-run --cache /tmp/g017-npm-cache` | **17** 个文件，`test/` 命中 **0**，无新增/残留文件 |
| 哈希 | `shasum -a 256` | `core/custom.js` `9995d7bb…`、`index.js` `7cb9b32a…`、`test/integration.test.mjs` `c127465d…`、`test/custom.test.mjs` `3c2955a4…`（负向对照基线） |
| 契约 | `CONTRACT.md` | 版本日志新增 **Revision 8**；§15 标题标注 lastness；§15.1 / §5.3 / §6·E2 交叉引用；§15.9 改「四个 effect」并补 keeper 的失败形态；**新增 §15.10**（机制 / 四个 identity 分支 / 只搬有文本的理由 / 精确承诺 / 三条残余边界 / 失败行为 / 未验证）；§7 新增第 **22–24** 条 |
| 文档 | `README.md` | 分层原则改「两个 waterfall 监听器」并写明 prepend；tab 表后加一句位置交叉引用；**新增「「我的 Prompt」为什么真的排在最后（g-017，契约 Revision 8）」章**；文末**新增「Revision 8 边界」块** |

## 96. 从 git 安装的 prepare 门禁（2026-09-30，基线 `4a74d92`）

### 一、这一轮要做的事

官方发布文档《打包与安装插件》的「从 GitHub 安装：构建脚本这道坎」一节要求：想让用户
`dsh plugin add github:you/hello-plugin` 装得上的作者，**必须自己提供一个 `prepare` 脚本**，
且它必须**自包含**（不能假设旁边有一份 monorepo checkout）——因为 git 安装拉到的是
**源码而不是构建产物**，pnpm 会在安装现场运行 `prepare`；用户侧还要为该包在 profile 的
`pnpm-workspace.yaml` 里授权构建脚本（`allowBuilds`），否则第一次 `add` 会失败。

本包是**零构建**包：`index.js` / `client.js` / `core/*.js` 本身就是发布入口，没有编译产物。
所以这一节落到本包上，问题不是「怎么编译」，而是「**装到用户机器上的那一份到底全不全**」。
本轮把它做成一个可执行、可失败的门禁：`core/prepare.js`（纯函数，零 IO）+
`scripts/prepare.mjs`（注入 `node:fs`，不通过则 `exit 1`）。

### 二、实测：pnpm 从 git 安装时，落地的就是 `files` 白名单

第一版代码的注释里写的是「git 安装既不套用 `files` 也不套用 `.gitignore`，所以本地有、
仓库没有的文件会缺失」。**这个判断是错的**，本机实测推翻了它：

```sh
pnpm add 'github:zangxx66/dsh-prompt-setting#path:/packages/dsh-prompt-setting'
```

| 观察项 | 实测结果（pnpm 12.3.4，2026-09-30） |
| --- | --- |
| 解析结果 | `dsh-prompt-setting 0.1.0` —— `#path:` 指向 monorepo 子目录，解析成功 |
| 落地内容 | `files` 白名单 8 项 **+ `package.json` + `LICENSE`**；`test/` 与 `.dsh-graph/` 均**不在** |
| 体积 | `node_modules/dsh-prompt-setting` **968K**，与 `npm pack` 的 unpacked **958.2 kB** 同量级，远小于整个 checkout |
| 反例（装仓库根） | 直接 `github:zangxx66/dsh-prompt-setting` 装到的是 pnpm **合成的 `0.0.0` 空包**：仓库根没有 `package.json`，装上去没有任何入口，插件当然不会出现 |

结论：git 这条路**照样按 `files` 打包**。真正的风险在反方向——
**「声明了、但没被白名单覆盖（或压根没提交）的文件」在用户机器上一定不存在**。
门禁的判据据此调整，新增 `NOT-SHIPPED`（见第四、五节）。

### 三、实测：`prepare` 在安装现场真的被执行，且被 `allowBuilds` 拦住

用本地 bare clone 模拟 git 源（`git+file:///tmp/.../remote.git#path:/packages/dsh-prompt-setting`，
commit `f602b16`）：

**第一次（未授权）——安装失败**，错误码 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，
并打印出**确切的包键**（官方文档说的「把 pnpm 打印的那个键复制过去」）：

```
The git-hosted package "dsh-prompt-setting@0.1.0" needs to execute build
scripts but is not in the "allowBuilds" allowlist.
help: Add the package to "allowBuilds" in your project's pnpm-workspace.yaml
      allowBuilds:
        dsh-prompt-setting@git+file:///tmp/.../remote.git#f602b16…&path:/packages/dsh-prompt-setting: true
```

**写入该键后重试——`prepare` 真的执行了**，脚本输出原样出现在 pnpm 的 `npm-install:` 流里
（19 项 ok + `prepare：OK`），安装成功、版本 `0.1.0`。

> 这一条对用户是**成本**：本包零构建，`prepare` 只做自检，却同样要吃 `allowBuilds` 授权
> （授权 = 允许该包在安装时于本机执行代码，且不在 agent 沙箱内）。文档给出的替代路径是
> 「分发构建产物」：装 npm 包或 `pnpm pack` 出来的 tarball 都不需要任何构建权限。
> 取舍写在包 README 的安装一节。

### 四、负向对照：残缺 checkout 被门禁挡住

把 `package.json` 的 `files` 里的 `client.js` 删掉（模拟「入口忘了列进白名单」），commit 后
从该仓库安装：

```
FAIL  NOT-SHIPPED: exports["./client"] → client.js 不在 files 白名单里：安装时这个文件会被裁掉
prepare：失败（1 项）—— 这个 checkout 装上去会缺东西，先修好再安装
Error: ERR_PNPM_PREPARE_PACKAGE
```

安装被拒绝（退出码 1）。**这一条正是只做「文件存在性」检查抓不到的**：文件在 checkout 里
**明明存在**，只有「声明 vs 白名单」这条判据能发现它；否则这个 checkout 会装上去，
然后在 `dsh` 启动时以模块解析错误的形式炸掉——正是这道坎最坏的形态。

### 五、判据清单（`core/prepare.js`）

| code | 级别 | 判据 |
| --- | --- | --- |
| `MANIFEST` / `MANIFEST-UNREADABLE` | ok / fail | `package.json` 可解析 |
| `NO-ENTRYPOINT` / `ENTRY` / `ENTRY-MISSING` / `ENTRY-EMPTY` | fail / ok / fail | `main` 与 `exports` 至少声明一个入口；每个入口存在且非空 |
| `NO-BUNDLE-PATCH` / `PATCH` / `PATCH-MISSING` / `PATCH-EMPTY` | warn / ok / fail / warn | `dsh.bundle.patch`（字符串或数组）存在；空 patch 只提示 |
| `PATCH-ROW` / `PATCH-EXTERNAL` / `ROW-NO-ENTRY` / `ROW-NO-SUBPATH-EXPORT` / `ROW-ENTRY-MISSING` | ok / ok / fail | patch 每一行 `name:`：本包裸名 → `main`/`exports["."]`；本包子路径 → `exports["./x"]`；外部包只记一行 ok（不猜别人的包） |
| `NO-FILES` / `FILES-FILE` / `FILES-DIR` / `FILES-MISSING` | warn / ok / fail | `files` 每一项存在（目录非空） |
| `SHIPS` / `NOT-SHIPPED` | ok / fail | 每个声明入口与 bundle patch **必须被白名单覆盖**（目录、`*`、`**`、`?` 都认；`package.json` 例外，npm 永远保留） |
| `CLIENT-NO-EXPORT` / `CLIENT-MISSING` / `CLIENT-FINGERPRINT` | fail | 声明 `dsh.client` 时 `exports["./client"]` 存在，且构建戳区间唯一有序 |
| `NO-RUNTIME-DEPS` / `RUNTIME-DEPS` | ok / warn | 零运行时依赖是契约；有依赖只提示（pnpm 会装） |

设计约束与仓库既有分层一致：`core/prepare.js` **零 IO、零 `ctx`**，读者由调用方注入，
所以每条判据都能离线单测；`scripts/prepare.mjs` 只做三件事——注入 `node:fs`、**拒绝逃出包根的
路径**（manifest 里写 `../x` 不算本包内容）、打印并设置退出码。与 `check-compat.mjs` 的分工：
那个是**诊断**（退出码恒 0），这个是**门禁**（不通过就 exit 1）。

### 六、未验证项（诚实清单）

- **没有跑真正的 `github:` 协议安装**：本机 GitHub 凭据不可用（`git push` 由用户在终端完成），
  所以真机证据来自 `git+file://` + 本地 bare clone。pnpm 对两者走同一条 git 解析路径，
  但「GitHub 上那个 commit」这一步本轮**没有**经过网络验证。
- **没有在真的 `dsh plugin --profile <name> add …` 里跑**：本轮验证到 pnpm 这一层。
  `dsh plugin` 只是把参数转发给 profile 目录里的 pnpm，因此**预期**一致，但未实测。
- **`prepare` 与打包的先后顺序是推断**：负向对照里「文件存在于 checkout、却因不在白名单而失败」
  说明 `prepare` 看到的**是未经过滤的 checkout**；这是从输出推断的，不是直接观测。
- **未跑浏览器/CDP**：本轮无 UI 改动。

### 七、本轮实测证据

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test`（包目录） | **395 / 395 pass / 0 fail / 0 skipped**（基线 373；净 +22） |
| 新套件 | `node --test test/prepare.test.mjs` | **22 / 22 pass**（含真实包自检、脚本端到端、临时残缺包负向端到端） |
| 自检 | `node scripts/prepare.mjs` | 真实包 **19 项 ok / exit 0** |
| git 安装（正向） | `pnpm add 'git+file://…/remote.git#path:/packages/dsh-prompt-setting'` | 首次 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`（打印确切包键）→ 授权后 `prepare` 执行、**安装成功 0.1.0** |
| git 安装（负向） | 同上，源换成删掉 `files: client.js` 的 commit | `FAIL NOT-SHIPPED` → **`ERR_PNPM_PREPARE_PACKAGE`、exit 1** |
| 打包 | `npm pack --dry-run` | **20** 个文件（`core/prepare.js`、`scripts/prepare.mjs` 落在既有目录项内）、329.2 kB / unpacked 990.4 kB |
| 语法 | `node --check core/prepare.js`、`node --check scripts/prepare.mjs` | 通过 |

## 97. peer 范围放宽到 `>=0.1.7-rc.2 <0.2.0`（2026-09-30，基线 `fda778a`）

### 一、起因：这不是「顺手改个字符串」

负责人在 `package.json` 的暂存改动里把这一行改成（原值 `>=0.1.7-rc.2 <0.1.8-0`）：

```
"@deepseek-ai/dsh": ">=0.1.7-rc.2 <0.2.0 || >=0.1.7-rc2 <0.2.0-0"
```

提交前实测发现两件事：

1. **它会让 3 个测试变红**：
   | 位置（改动前） | 断言 | 实测 |
   | --- | --- | --- |
   | `test/boot.test.mjs:323` | `satisfiesRange('0.1.8-0', RANGE)` = false | actual **true** |
   | `test/boot.test.mjs:427` | verdict = `out-of-range`（注入 `0.2.0-rc.1`） | actual `ok` |
   | `test/host.test.mjs:154` | manifest 范围精确匹配旧串 | 不匹配 |
2. **表达式冗余**：后半段 `>=0.1.7-rc2 <0.2.0-0` 是前半段 `>=0.1.7-rc.2 <0.2.0` 的**子集**
   （`0.1.7-rc.2` 排在 `0.1.7-rc2` 之前，且 `<0.2.0-0` ⊂ `<0.2.0`），净效果等于前半段；
   `rc2` 还少一个点。

负责人裁定「做完整修订，上界放宽到 `<0.2.0`」，故规范写法取 `>=0.1.7-rc.2 <0.2.0`。

### 二、新范围的实测判定（`core/compat.js` 的 `satisfiesRange`，本机逐条实测）

| 版本 | 判定 | 说明 |
| --- | --- | --- |
| `0.1.7-rc.1` | false | 低于已测试的 rc |
| `0.1.7-rc.2` | true | 已测试版本 |
| `0.1.7` | true | 该 rc 的正式版 |
| `0.1.8-0` | **true**（原为 false） | 上界放宽后，更晚的 0.1.x prerelease 也被收进来 |
| `0.1.99` | true | 更晚的每一个 0.1.x 正式版 |
| `0.2.0-0` | true | prerelease 排在 `0.2.0` 之前，仍在范围内 |
| `0.2.0` | false | 上界本身被排除 |
| `0.3.0` | false | |

⇒ 语义是「**0.2.0 之前的一切都算在内（含 prerelease）**」。这也意味着"超范围"的测试样例必须从
`0.2.0-rc.1` 换成 `0.2.0` —— 前者现在**在**范围内。

### 三、同步面（一次契约修订）

| 文件 | 改动 |
| --- | --- |
| `package.json` | 范围规范化为 `>=0.1.7-rc.2 <0.2.0` |
| `index.js` | `DSH_PEER_RANGE_FALLBACK` 同步新值，并**改为导出**（理由见下） |
| `test/boot.test.mjs` | 范围断言按新语义重写（8 个边界版本）+ verdict 用例改用 `0.2.0` + 新增 fallback 漂移断言 |
| `test/host.test.mjs` | manifest 范围正则改为新串 |
| `core/compat.js` | 一句示例注释里的范围 |
| `README.md`、`README_zh.md`、包内 `README.md`（中英各一处） | 前置条件改新范围 |

**顺带补上的护栏**：`index.js` 的注释早就写着"`test/boot.test.mjs` 断言 fallback 与 manifest 相等"，
但实际那条断言比的是 `DSH_PEER_RANGE`（**从 manifest 现读**的值）与 manifest —— 两边恒等，抓不到
fallback 漂移。本次把 `DSH_PEER_RANGE_FALLBACK` 改为导出，并真的断言
`DSH_PEER_RANGE_FALLBACK === RANGE`；注释描述的行为这才成立。

### 四、未验证项（重要，诚实边界）

- **没有在 0.1.8 / 0.1.9 / 0.2.0 之前的任何版本上实测过本插件**。放宽上界是一个**宽松预期**，
  不是「已验证兼容」；本机唯一的真机证据仍然只有 DSH `0.1.7-rc.2`。
  （**本条已被 §98 取代**：DSH `0.2.0-rc.2` 上已有「插件加载 + 路由注册 + 存储写入」的真机证据。）
- 装上 0.1.8+ 后若出现异常，`core/compat.js` 的范围自检**不会**再提醒（它落在范围内）——
  此时用 `node scripts/check-compat.mjs` 与启动终端输出判断。
- **没有**改 `CONTRACT.md` 的 Revision：那里的 Revision 是 **REST 契约**的版本，
  peer 范围不属于 REST 契约。

### 五、顺带修掉的一处失效指向（上一节目标的遗留）

包内 README 瘦身（§96 之后的 `f73e7c6`）删掉了「兼容性与救援」章节，但**五处运行时文案**仍在让
用户去看那一节：`core/compat.js` 三处、`client.js` 一处、`scripts/check-compat.mjs` 一处。
本轮统一改指 README 现在的「出问题时 / When something goes wrong」，`test/boot.test.mjs` 的
`RESCUE_HINT` 常量同步（5 处断言自动跟随）。

### 六、本轮实测证据

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **395 / 395 pass / 0 fail / 0 skipped** |
| 范围判定 | `node --input-type=module -e "…satisfiesRange…"` | 见第二节表格（8 个版本逐条实测） |
| 自检 | `node scripts/prepare.mjs` | 19 项 ok |
| 打包 | `npm pack --dry-run` | 20 个文件 |

## 98. peer 范围显式纳入 `0.2.0-rc.2`（2026-09-30，基线 `a058bfb`）

### 一、起因：三种 semver 口径，只有一种是「不满足」

负责人要求「把 `package.json` 的版本号放宽到 `0.2.0-rc2`」。动手前先把**三个判定引擎**分开量了一遍
（本机 `semver@7.8.5`，范围取 §97 的 `>=0.1.7-rc.2 <0.2.0`，被测版本 `0.2.0-rc.2`）：

| 引擎 | 结果 | 为什么 |
| --- | --- | --- |
| 平台兼容闸门 `dsh-app-boot` | **满足** | `lib/index.js:300` 传的是 `{ includePrerelease: true }`，prerelease 排除规则不生效 |
| 本插件 `core/compat.js` 的 `satisfiesRange` | **满足** | 它压根没实现 prerelease 排除规则（`0.2.0-rc.2 < 0.2.0` 即算在内） |
| **严格** `node-semver`（npm / pnpm 安装期 peer 解析） | **不满足** | §11 规则：带 prerelease 的版本要满足某个 `||` 分支，该分支里必须有**同一个 `[major, minor, patch]` 且自带 prerelease** 的比较器 —— 旧范围里没有 |

⇒ 所以这不是「修一个正在报的错」：当前装法（平台闸门 + 自带自检）**本来就放行** `0.2.0-rc.2`。
这次改动是把「平台已经放行」的事实，写成**连严格 semver 也放行**的声明。

### 二、裁定与写法

负责人选定 A 案（另三个候选：字面 `<=0.2.0-rc.2`、放开整条 `<0.3.0`、以及「只记文档不改表达式」）：

```
"@deepseek-ai/dsh": ">=0.1.7-rc.2 <0.2.0 || >=0.2.0-rc.2 <0.2.0"
```

- 第二个 `||` 分支的**唯一**作用就是给严格 semver 一个「同号 prerelease 比较器」，让 `0.2.0-rc.2` 过关；
- 上界仍是 `<0.2.0`：`0.2.0` 正式版**依旧出界**（与 §97 一致），放开 0.2.x 若要发生需要另一次裁定；
- 三个引擎的新判定（逐条实测）：

| 版本 | 严格 semver | `includePrerelease` | 本插件自带 |
| --- | --- | --- | --- |
| `0.1.7-rc.1` | false | false | false |
| `0.1.7-rc.2` | true | true | true |
| `0.1.7` | true | true | true |
| `0.1.8-0` | **false** | true | true |
| `0.1.99` | true | true | true |
| `0.2.0-0` | **false** | true | true |
| `0.2.0-rc.1` | **false** | true | true |
| `0.2.0-rc.2` | **true** | true | true |
| `0.2.0` | false | false | false |
| `0.3.0` | false | false | false |

**诚实边界**：第二个分支只把 `0.2.0-rc.2` 这一档（`>=0.2.0-rc.2`）拉进严格 semver；更早的 0.2.0 prerelease
（`0.2.0-0`、`0.2.0-rc.1`）与 0.1.x 的 prerelease 在严格口径下**仍是 false**（这是 §11 规则的必然结果，
不是漏写）。平台闸门与插件自检对它们都判 true，所以运行时照常静默。

### 三、同步面

| 文件 | 改动 |
| --- | --- |
| `package.json` | 范围改为 `>=0.1.7-rc.2 <0.2.0 || >=0.2.0-rc.2 <0.2.0` |
| `index.js` | `DSH_PEER_RANGE_FALLBACK` 同步新值，并补注释说明第二个分支为何**看着冗余却不是** |
| `core/compat.js` | 模块头补「`||` 分支是给严格 semver 的桥」一段；`satisfiesRange` 的示例范围与「不实现 prerelease 排除」一句 |
| `test/boot.test.mjs` | 边界表补 `0.2.0-rc.2` 一行；新增**形状断言**（见下） |
| `test/host.test.mjs` | manifest 范围正则改为整串精确匹配（含 `||`） |
| `README.md`、`README_zh.md`、包内 `README.md`（中英各一处） | 前置条件标明「含 `0.2.0-rc.2`」 |
| `CHANGELOG.md` | `Changed` 里补一条，并记下真机证据升级 |

### 四、护栏：为什么会「看起来冗余」而更需要断言

自带解析器把第二个分支读成第一个分支的**子集**（它没有 prerelease 排除规则），于是**任何行为测试都抓不到
它被删掉** —— 未来有人「化简」这个范围，本套测试会全绿，而 npm/pnpm 的 peer 检查会悄悄退回不满足。
所以 `test/boot.test.mjs` 新增的不是行为断言，而是**形状断言**：范围里必须存在一个匹配
`^[<>]=?0\.2\.0-` 的比较器（失败文案直接点名「严格 semver 会拒绝 `0.2.0-rc.2`」）。

### 五、真机证据升级（§97 之四的第一条**已过时**）

§97 记的「本机唯一的真机证据仍然只有 DSH `0.1.7-rc.2`」在本轮不再成立：

| 证据 | 观测 |
| --- | --- |
| 运行中的 DSH | **`0.2.0-rc.2`**（全局 CLI `…/node_modules/@deepseek-ai/dsh`，`check-compat` 探测来源同名） |
| 插件已挂载 | `/prompt-setting/` → **401**（已注册前缀路由，需 token）；对照 `/prompt-setting-nope/`、`/definitely-not-a-route-xyz/` → **404** |
| 存储活着 | `~/.dsh/prompt-setting/{overrides.json,history.jsonl}` 于当日 **21:02** 被写入 |
| 自检 | `node scripts/check-compat.mjs` → 探测到 `0.2.0-rc.2`，结论「兼容（在已测试范围内）」 |

**边界**：这是「插件在 0.2.0-rc.2 上加载、注册路由、正常落盘」的证据，**不是**全功能回归 ——
`0.1.8`–`0.1.99`、`0.2.0-rc.0/rc.1` 以及 `0.2.0` 正式版仍未实测。

### 六、本轮实测证据

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **395 / 395 pass / 0 fail / 0 skipped**（11.5 s） |
| 三口径判定 | `node --input-type=module -e "…"`（semver@7.8.5 + 自带 `satisfiesRange`） | 见第二节表格（10 个版本 × 3 口径逐条实测） |
| 自检 | `node scripts/check-compat.mjs` | 探测 `0.2.0-rc.2`，结论「兼容（在已测试范围内）」 |
| 门禁 | `node scripts/prepare.mjs` | 19 项 ok |
| 打包 | `npm pack --dry-run` | **未能执行**：本机 `~/.npm` 归属 root，npm 拒绝写 `_logs`（与本次改动无关；文件清单未变） |

## 99. peer 桥下界 `0.2.0-rc.2` → `0.2.0-0`（2026-09-30，基线 `a058bfb` 工作区）

### 一、起因：负责人的 review 提问

> 「`>=0.2.0-rc.2 <0.2.0` 条件成立，后续如果发布了 `0.2.0-alpha` 不就匹配不到了」

复核结论：**提问成立**，且缺口不止 alpha 一个版本 —— `0.2.0-0`、`alpha`、`beta`、`rc.1` 全在严格口径外。

### 二、机制：两层，缺一不可

1. 第二分支的下界 `>=0.2.0-rc.2` 本身就**高于**它们（本机实测 semver 序：
   `0.2.0-0 < 0.2.0-alpha < 0.2.0-beta.3 < 0.2.0-rc.1 < 0.2.0-rc.2 < 0.2.0`）；
2. 第一分支 `>=0.1.7-rc.2 <0.2.0` 数值上**包含** `0.2.0-alpha`，却被 §11 预发布白名单规则挡掉：带 prerelease
   的版本要过某个 `||` 分支，该分支里必须有**同 `[major, minor, patch]` 且自带 prerelease** 的比较器 ——
   第一分支里带 prerelease 的是 `>=0.1.7-rc.2`（元组 `0.1.7`），管不到 `0.2.0` 元组。

**关键反例**：`>=0.1.7-rc.2 <0.3.0-0` 在数值上完全罩住 `0.2.0-alpha`，严格 semver 依然 **false**。
⇒ 这个洞只能靠「同元组的 prerelease 比较器」修，**放宽上界修不好**。

### 三、真实发布史：`0.2.0-alpha` 不会作为「后续」出现

`npm view @deepseek-ai/dsh versions`（本机实测）：0.2.0 线只有 `0.2.0-rc.1` → **`0.2.0-rc.2`（latest）**，
**从未发布 alpha/beta**；而 0.1.2 / 0.1.5 / 0.1.6 / 0.1.7 的历史一律是 `alpha.* → rc.*`。

⇒ alpha 只出现在**新 minor 的早期**，0.2.0 已走到 rc.2，回头再发 alpha 属于版本号倒退。
**真正会撞上的未来是 `0.3.0-alpha.1`**，它在当前范围下（含本轮修订后）仍是 false，且这是**有意**的：
0.3 线未验证（§97/§98 同口径）。

### 四、影响面：这不是「正在报的错」

| 口径 | `0.2.0-alpha` |
| --- | --- |
| 严格 `node-semver`（npm / pnpm 安装期 peer 解析） | **false（修前）→ true（修后）** |
| 平台闸门 `dsh-app-boot@0.2.0-rc.2` `lib/index.js:300`（`includePrerelease: true`） | true |
| 本插件自带 `satisfiesRange`（不实现 prerelease 排除） | true |

- peer 是 `optional: true`；npm **11.11.0** 实测：不满足只出 `npm warn ERESOLVE overriding peer dependency`
  （**warn，不阻塞安装**）；
- 真实安装链路（`plugin_manager install_bundle` 绝对路径 / `pnpm add github:…#path:`）里
  `@deepseek-ai/dsh` 不在依赖树中 → 视为未安装 → optional peer 缺失合法，连 warn 都不会出现；
- ⇒ 修前缺口的实际后果是「**声明口径 ≠ 放行口径**」，不是装不上、也不是跑不起来。

### 五、裁定与写法

负责人选 **B 案**（另三案：只补文档不动表达式 / 整体放开 0.2.x / 先不动）：

```
"@deepseek-ai/dsh": ">=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.0"
```

`0.2.0-0` 是 0.2.0 的**最小**预发布（数字标识符排在任何字母标识符之前，semver §11.4）。
上界仍是 `<0.2.0`：`0.2.0` 正式版照旧出界（与 §97/§98 一致，放开需另一次裁定）。

候选实测矩阵（`semver@7.8.5`）：

| 版本 | A 旧（`…rc.2…`） | **B 新（`…0-0…`）** | C `>=0.1.7-rc.2 <0.3.0-0` | D 上界 `<0.3.0-0` |
| --- | --- | --- | --- | --- |
| `0.2.0-0` | false | **true** | false | false |
| `0.2.0-alpha` | false | **true** | false | false |
| `0.2.0-beta.3` | false | **true** | false | false |
| `0.2.0-rc.1` | false | **true** | false | false |
| `0.2.0-rc.2` | true | **true** | false | true |
| `0.2.0` / `0.2.1` | false | false | **true** | **true** |

C 行是第二节那个反例的实测形态：数值上罩住 alpha，严格口径仍然 false。

### 六、诚实边界（修后仍在）

严格 semver 下**仍为 false** 的档位：0.1.x 的**预发布**（`0.1.8-0`、`0.1.9-rc.1`）、`0.2.0` 正式版及
其之后的一切（`0.2.1`、`0.3.0-*`）。前者是白名单策略的必然形态（不是漏写），后者是有意的未验证边界；
平台闸门与插件自检对 0.1.x 预发布判 true，运行期照常静默。

### 七、同步面

| 文件 | 改动 |
| --- | --- |
| `package.json` | 第二分支下界 `0.2.0-rc.2` → `0.2.0-0` |
| `index.js` | `DSH_PEER_RANGE_FALLBACK` 同步；补注释「下界必须停在 `0.2.0-0`：白名单只认元组、不认排序」 |
| `core/compat.js` | 模块头一段 + `satisfiesRange` 的示例范围同步 |
| `test/boot.test.mjs` | 边界表补 `0.2.0-alpha` / `beta.3` / `rc.1`；**形状断言从正则 `^[<>]=?0\.2\.0-` 收紧为 `deepEqual(['>=0.2.0-0'])`** |
| `test/host.test.mjs` | manifest 正则同步为「下界 `0.2.0-0`」形态 |
| 四处 README（根 / 包内 × 中英） | 前置条件从「含 `0.2.0-rc.2`」改为「含 `0.2.0` 全部预发布，`0.2.0` 正式版出界」 |
| `CHANGELOG.md` | 新增一条 `Changed`（中英） |

**护栏教训**：§98 的形状断言只要求「存在一个 0.2.0 的 prerelease 比较器」，它抓得住「整条桥被删」，
却抓不住「下界被抬到 rc.2」—— 而后者正是本轮暴露的缺口。收紧到 `deepEqual` 后，两个方向都会红。

### 八、本轮实测证据

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **395 / 395 pass / 0 fail / 0 skipped**（13.6 s） |
| 四口径判定 | `semver@7.8.5`（strict 新范围 / strict 旧范围 / `includePrerelease`）+ 自带 `satisfiesRange` | 16 个版本逐条，见第五节矩阵 |
| 自检 | `node scripts/check-compat.mjs` | 探测 `0.2.0-rc.2` → 「兼容（在已测试范围内）」，退出码 0 |
| 门禁 | `node scripts/prepare.mjs` | 19 项 ok |
| 运行期真机 | 未变（§98 之五：插件正跑在 DSH `0.2.0-rc.2` 上） | 本轮**只改声明口径**，未触碰任何运行期分支 |
| 护栏反向验证 | 把下界临时改回 `0.2.0-rc.2` 再跑 `node --test` | **393 / 395，恰好 2 红**：`boot.test.mjs:316` 形状断言（文案点名「must bridge strict semver at `0.2.0-0` … not at a later one」）与 `host.test.mjs:157` manifest 正则；改回后全绿 |

## 100. peer 上界 `<0.2.0` → `<0.2.1-0`：把 `0.2.0` 正式版纳入范围（2026-10-01，基线 `eb3be8e` 工作区）

### 一、起因：g-019 的 GA 阻塞结论（P0）

§98/§99 之后的范围是 `>=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.0` —— **两个分支都不含 `0.2.0` 正式版**。
g-019 把后果钉死为「`0.2.0` 发布当天本插件直接不加载」，机制三处，本机 `dsh-app-boot@0.2.0-rc.2` 逐行核对：

| 位置 | 代码 | 后果 |
| --- | --- | --- |
| `dsh-app-boot/lib/index.js:300` | `!semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })` | profile boot 期逐条判定，不满足即记为 issue |
| 同文件 `:931` | `throw new Error(pluginCompatibilityWarning(issue))` | **整个 profile bundle 被跳过**，`:516` 往 stderr 写 `skipping profile bundle …` |
| 同文件 `:2086` | `row.disabled = true`（运行期 `deny()` 路径） | 该条在运行期被置为禁用 |

关键点：跳过发生在 **import 之前**，本插件的导入期自检一行都跑不到 —— 插件内没有任何补救手段。
这不是理论风险：本机已有一次「整套插件都没进 prompt」的观测（`dsh/session-0021b973`，2026-09-30 20:36）。

### 二、范围变化（负责人逐字确认）

```diff
- "@deepseek-ai/dsh": ">=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.0"
+ "@deepseek-ai/dsh": ">=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.1-0"
```

- **修后语义**：`0.1.7-rc.2` 起的全部 0.1.x、`0.2.0` 的全部预发布**以及 `0.2.0` 正式版本身**都在范围内；
  `0.2.1-0` 及以后（含 `0.2.1-rc.N`、`0.2.1`、`0.3.x`）一律拒绝。
- **为什么保留 `<0.2.0` 那一支**：它继续承担 0.1.x 线，并且是**严格** `node-semver` 下 0.2.0 预发布的
  白名单来源（§98/§99）。本轮只把**最后一道**上界从 `<0.2.0` 推到 `<0.2.1-0`，第一支逐字未动。
- **为什么上界取 `<0.2.1-0`**：语义是「0.2.x 只要没有新的破坏性声明就继续放行，下一个 minor 必须重新评估」。
  本机既有实践佐证：`dsh-graph@0.17.0` 的 peer 正是 `@deepseek-ai/dsh-settings: >=0.1.5-rc.2 <0.2.1-0`。
- **仍未验证的边界**：`0.2.1-0` 及以后是**有意**出界（与 §97/§98/§99 同口径），不是漏写。

### 三、双解析器验证（自带解析器 vs 平台闸门口径 `node-semver`）

命令（自带解析器从 `core/compat.js` 导入；`semver` 取本机 `semver@7.8.5`，与 `dsh-app-boot` 声明的
`semver: ^7.8.5` 同版本）：

```
node --input-type=module -e "import {satisfiesRange} from './core/compat.js'; import semver from '<semver@7.8.5>/index.js'; …"
```

| 版本 | 自带（旧） | strict（旧） | `includePrerelease`（旧） | 自带（新） | strict（新） | `includePrerelease`（新） |
| --- | --- | --- | --- | --- | --- | --- |
| `0.1.7-rc.1` | false | false | false | false | false | false |
| `0.1.7-rc.2` | true | true | true | true | true | true |
| `0.1.8-0` | true | **false** | true | true | **false** | true |
| `0.2.0-0` | true | true | true | true | true | true |
| `0.2.0-rc.2` | true | true | true | true | true | true |
| **`0.2.0`** | **false** | **false** | **false** | **true** | **true** | **true** |
| `0.2.0-1` | true | true | true | true | true | true |
| `0.2.1-0` | false | false | false | false | false | false |
| `0.2.1` | false | false | false | false | false | false |
| `0.3.0-0` | false | false | false | false | false | false |
| `0.3.0` | false | false | false | false | false | false |
| `1.0.0` | false | false | false | false | false | false |

**结论**：修后自带解析器与平台口径（`includePrerelease: true`）在**全部 11 个版本上逐条一致**；与严格
`node-semver` 的唯一差异是 `0.1.8-0` 一行，那是 §98 已记录在案的已知形态（白名单策略，非本次引入）。
修前 `0.2.0` 一行三个口径**全 false** —— 这就是 P0 本体：平台闸门判定与插件自检同时说「不兼容」。

### 四、边界表（六项均有自动化断言，含负向）

`test/boot.test.mjs`「the tested range is the manifest range…」内逐条断言：

| 版本 | 判定 | 角色 |
| --- | --- | --- |
| `0.1.7-rc.2` | true | 已真机验证的下界 |
| `0.2.0-0` | true | 0.2.0 最小预发布（严格口径的桥下界） |
| `0.2.0-rc.2` | true | 本机正在运行的版本 |
| `0.2.0` | **true（本轮由 false 改）** | GA 正式版，P0 的靶心 |
| `0.2.1-0` | false | 新上界自身，必须出界（负向） |
| `0.3.0` | false | 下一个 minor（负向） |

**新增形状护栏**：除 §99 已有的 `deepEqual(bridges, ['>=0.2.0-0'])` 外，本轮加了一条**上界形状断言** ——
`RANGE` 里所有 `<` 比较器必须恰为 `['<0.2.0', '<0.2.1-0']`。§99 那条守的是「桥的下界」，这条守的是
「最后一道上界」：把上界改回 `<0.2.0`（本次要修的 P0 形态）或改成 `<0.2.2-0`（越权放行）都会立刻红。

### 五、影响面：改的是声明口径，不是运行期分支

| 口径 | 影响 |
| --- | --- |
| 平台闸门（`includePrerelease: true`） | `0.2.0` 由 **不兼容 → 兼容**：整个 bundle 不再被跳过（本次唯一实质修复） |
| 严格 `node-semver`（npm/pnpm 安装期 peer 解析） | `0.2.0` true；peer 是 `optional: true`，本就不阻塞安装（§99 之四） |
| 本插件自检 / `scripts/check-compat.mjs` | 在 DSH `0.2.0` 上由「超范围」告警变为**完全静默**（`ok`） |
| 运行期装配逻辑 | **零改动**；`core/**`、`client.js` 的代码路径一行未动 |

### 六、裁定与写法

负责人直接给定范围字面量（本文件逐字照抄，不做变体）：

```
"@deepseek-ai/dsh": ">=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.1-0"
```

被否的写法：只改文档不动表达式（P0 原样保留）；上界改 `<0.2.0-0` 或 `<0.3.0`（前者仍不含正式版，
后者把未验证的 0.3.x 一并放行）。

### 七、同步面

| 文件 | 改动 |
| --- | --- |
| `package.json` | peer 表达式上界 `<0.2.0` → `<0.2.1-0` |
| `index.js` | `DSH_PEER_RANGE_FALLBACK` 同步；重写常量注释（第二支的两个职责 + 为何不能停在 `<0.2.0`） |
| `core/compat.js` | 模块头 `One asymmetry …` 段 + `satisfiesRange` 的 `@param range` 示例同步 |
| `test/boot.test.mjs` | 边界表：`0.2.0` false→true，补 `0.2.0-1` true 与 `0.2.1-0`/`0.2.1` false；新增上界形状断言；超范围样例 `0.2.0` → `0.2.1-0`（含 `reportBootCompatibility` 与真实探针两处） |
| `test/host.test.mjs` | manifest 正则同步为 `… \|\| >=0.2.0-0 <0.2.1-0$` |
| `scripts/check-compat.mjs` | 第 5 节的超范围样例版本 `0.2.0` → `0.2.1-0`，并注明「在 `0.1.7-rc.2` / `0.2.0` 上轮不到它」 |
| 四处 README（根 / 包内 × 中英） | 前置条件改为逐字给出完整范围，并写明 `0.2.0` 正式版在范围内、`0.2.1-0` 及以后出界 |
| `CHANGELOG.md` | 新增一条 `Changed`（中英） |
| 徽章（根 README 中英） | `DSH->=0.1.7-rc.2` → `DSH->=0.1.7-rc.2 <0.2.1-0`（有效集合的上下界） |

**历史小节保留**：§97/§98/§99 与本文件里的旧字面量是**历史记录**，按体例不改写；现行声明只在本节与
上表列出的「现行口径」文件里。全文检索残留旧上界时须按「历史小节 / 现行声明」分类判读。

### 八、本轮实测证据

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **395 / 395 pass / 0 fail / 0 skipped**（约 12 s） |
| 双解析器判定 | `semver@7.8.5`（strict + `includePrerelease`）+ 自带 `satisfiesRange` | 11 个版本 × 修前/修后，见第三节矩阵；新旧口径 100% 一致 |
| 自检 | `node scripts/check-compat.mjs` | 探测 `0.2.0-rc.2` → 「兼容（在已测试范围内）」，退出码 0；超范围模板逐字为 `检测到 DSH 0.2.1-0 … 超出已测试范围 >=0.1.7-rc.2 <0.2.0 \|\| >=0.2.0-0 <0.2.1-0` |
| 门禁 | `node scripts/prepare.mjs` | 19 项 ok |
| 语法检查 | `node --check` × 28 个 js/mjs | 全部通过（本仓库**无 TypeScript**：无 `tsconfig.json`、无 `.ts`、无 `node_modules`，故 `tsc --noEmit` 不适用，以此替代） |
| 护栏反向验证 | 把上界临时改回 `<0.2.0` 再跑 `node --test` | **392 / 395，恰好 3 红**：`boot.test.mjs` 的两条（边界表 `0.2.0` + 上界形状断言）与 `host.test.mjs` 的 manifest 正则；还原后 395/395 全绿（`package.json` 逐字节还原） |
| 运行期真机 | 未触发重启 | 本轮只改声明口径与文档，未触碰任何运行期分支；插件仍跑在 DSH `0.2.0-rc.2` 上 |


## 101. 冻结态的「我的 Prompt」升级为阻断级呈现（g-021，2026-10-01，基线 `448a1ed` 工作区）

### 一、问题：写入成功 ≠ 生效，而面板只写了一行红字

两个 agent preset 声明 `complete: true`（内置 `minimal`；本机「梁神模式」）。平台的
`SystemPrompt.assemble` 在 waterfall **返回之后**把 `sections` 强制替换为 `[completeSection]`，
因此这类会话里本插件写入的自定义段**必然不进最终 prompt**（平台事实，本插件无法反制，见 §15.4）。

面板此前只渲染一行 `data-warning="mine-frozen"`（`client.js:4965-4974` 旧版），而保存按钮的
`disabled` 只绑 `m.busy`、成功文案也无条件 —— 用户点击保存 → 主机照常写盘 → 界面显示
「已保存到…，下一轮生效」，于是「保存成功」被读成「已生效」。这正是负责人报障「未生效」的必现场景之一。

### 二、方案 A 的落地（brief 六条逐条对应）

| brief 要求 | 落地 |
| --- | --- |
| 主提示含三件事 | 冻结块由一行 `<p>` 升级为 `<div>`，内含三句：① 标题+原因（`mineFrozenWarn` + `stReason: <reason>`）；② `data-mine-frozen-body` —— 文本会写入{layer}配置，但被 complete 段冻结，**不进最终 prompt、下一轮也不生效**；③ `data-mine-frozen-fix` —— **可执行**办法：换用未声明 `complete` 的 agent preset，或去掉当前 preset 的 `complete` 声明，然后重新加载会话 |
| 成功态不得单独出现 | 冻结时状态行改用带条件前缀的 key（确定冻结 `mineSavedFrozen` / 未知 `mineSavedUnknown`）、全局成功 banner 同步（`savedNoticeFrozen` / `savedNoticeUnknown`）；未冻结时逐字回到旧 key（`mineSaved` / `savedNotice`）。**删除路径不动**（`deletedNotice` 保持原样）：brief 圈定的是「保存成功类文案」，删除是另一个动作，本轮有意不扩范围，见第五节 |
| 零丢失 | 未触碰任何清空路径（`mineDraft` 的 layer+session 键位不变）；新增测试覆盖「输入 → 切 tab 往返 → 切层往返 → 解除冻结 → 保存」全程文本存活 |
| 机器可读 | 新增 `data-mine-frozen="true"`（容器）、`data-mine-frozen-body="true"`、`data-mine-frozen-fix="true"`、`data-mine-frozen-certainty`（`certain` / `unknown`）、状态行 `data-mine-effect`（确定冻结 `none` / 未知 `unknown` / 否则 `next-turn`）；`data-warning="mine-frozen"` **保留** |
| 冻结三态零放宽 | 未改 `frozenState` / `editGate` / 任何宿主侧字段；§2.4/§7.2 的既有断言（`session` frozen/unfrozen、`global`+会话 = `unknown`、`global` 无会话）一条未动。**并且**：`global` + 选中会话这一「未知」态在面板里也不再被写成「本会话已冻结」——它有独立的 `mineFrozenUnknownWarn` / `mineFrozenUnknownBody` 与 `data-mine-frozen-certainty="unknown"`，机器可读地区分「确定冻结」与「未知」 |
| zh/en 键位对齐 | 新增 8 个 key 两语言齐全；en 无 CJK（sweep 的 `CJK_ON_SCREEN` 横扫覆盖新文案，含 `unknown` 分支） |

写入能力**保留**（方案 A）：冻结挡的是「生效」，不是「配置」。保存按钮的 `disabled` 仍只绑 `m.busy`。

### 三、新增/改动文案键

| key | 用途 | zh | en |
| --- | --- | --- | --- |
| `mineFrozenWarn` | 冻结块标题（**改值**） | 该作用域已被冻结：你写下的 Prompt 不会生效 | This scope is frozen: the prompt you write will not take effect |
| `mineFrozenBody` | 新增 · 确定冻结：写入去向 + 不生效 | 保存按钮仍然可用…不会在下一轮生效。 | Saving still works and the text is stored in the {layer} config… |
| `mineFrozenUnknownWarn` | 新增 · 未知冻结标题 | 冻结状态未知：本会话的装配无法确认 | Frozen state unknown: the assembly for this session cannot be confirmed |
| `mineFrozenUnknownBody` | 新增 · 未知冻结正文 | 全局装配被 complete 段冻结…如果本会话确实被冻结，它就不会生效。 | The unscoped assembly is frozen by a complete section…if this session is frozen too, it will not take effect. |
| `mineFrozenHowTo` | 新增 · 可执行解决办法（两态共用） | 要让它生效：换用一个未声明 complete 的 agent preset… | To make it take effect: switch to an agent preset that does not declare complete… |
| `mineSavedFrozen` | 新增 · 确定冻结的 saved 前缀 | 已保存到{layer}，但本会话冻结中，不会生效。 | Saved to {layer}, but this session is frozen, so it will not take effect. |
| `mineSavedUnknown` | 新增 · 未知冻结的 saved 前缀 | 已保存到{layer}；本会话冻结状态未知，若已冻结则不会生效。 | Saved to {layer}; this session may be frozen, in which case it will not take effect. |
| `savedNoticeFrozen` | 新增 · 确定冻结的全局 banner | 已保存到{layer}，但本会话冻结中，本轮不会生效。 | Saved to {layer}, but this session is frozen; it will not take effect here. |
| `savedNoticeUnknown` | 新增 · 未知冻结的全局 banner | 已保存到{layer}；本会话冻结状态未知，若已冻结则本轮不会生效。 | Saved to {layer}; this session may be frozen, in which case it will not take effect here. |

### 四、本轮实测证据（全部在包目录 `packages/dsh-prompt-setting/` 下执行，Node v24.13.1）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **399 / 399 pass / 0 fail / 0 skipped**（约 13 s；基线 395，新增 4 项） |
| 基线对照 | `git archive 448a1ed … \| tar -x -C /tmp` 后同命令 | **395 / 395 pass**（证明新增 4 项之外零回归、零放宽） |
| 客户端套件 | `node --test test/client.test.mjs` | 101 / 101 pass |
| 语法检查 | `node --check client.js` | 通过（本仓库无 TypeScript：无 `tsconfig.json`、无 `.ts`，`tsc --noEmit` 不适用） |
| 负向对照 I | 冻结块改回旧单行 `<p>` + saved 文案改回无条件 `mineSaved`/`savedNotice` → 重跑 client 套件 | **5 红**：3 项新增针对性断言（确定冻结 / 冻结保存 / 未知冻结）+ EN sweep + marker 覆盖测试 |
| 负向对照 II | `data-mine-effect` 固定为 `'next-turn'` | **6 红**：4 项新增断言（含「文本不丢」里对冻结标记的断言）+ EN sweep + marker 覆盖测试 |
| 负向对照 III | 把「未知」当「确定冻结」（certainty 恒 `certain`、正文/标题恒用确定态 key） | **3 红**：未知态专项测试 + EN sweep + marker 覆盖测试 —— 即「`global`+会话 被写成已冻结」一定会被抓到 |

### 五、未验证项（诚实清单）

- **真机目视**：本轮只做离线渲染断言，未重启/未触碰 `dsh web` 进程；真实冻结会话里的呈现由负责人在集成检查点目视收口。
- **平台侧冻结判定**：未改 `probe` / `snapshot` / REST 契约字段，`frozenScope` / `frozen` / `frozenReason` 逐字未动（新增属性纯客户端）。
- **`data-mine-effect` / `data-mine-frozen-certainty` 的取值面**：只在 `mine` 面板上引入（`next-turn` / `none` / `unknown` 与 `certain` / `unknown`），未复用到其它面板；若后续要当全局语义用需单独立项。
- **删除路径的冻结文案**：`deletedNotice`（「已撤销{layer}的覆盖，下一轮生效」）在冻结态仍是**无条件**形态 —— 与保存路径的同类误导同源，但不在本 brief 圈定的「保存成功类文案」内，本轮有意不做（做了要再加 `deletedNoticeFrozen` / `deletedNoticeUnknown` 两键），留给后续目标决定。
- **「未知」态缺省 reason**：`global` + 选中会话且快照未给 `frozenScopeReason` 时，标题只有 `mineFrozenUnknownWarn`、正文照常渲染（原因段为空），未额外补占位文案。




---

# g-026：「我的 Prompt」变量替换开关（Revision 11）

## 一、做了什么

给保留段 `prompt-setting:custom-prompt` 加一个**默认关闭**的变量替换开关。关闭态行为逐字节不变；开启后保留段参与 DSH 原生插值，并由写入侧保证「任何会让会话每轮抛错的文本都进不来」。

| 层 | 文件 | 加了什么 |
| --- | --- | --- |
| 配置 | `core/overrides.js` | 导出 shipped 同款正则 `VARIABLE_NAME` / `VARIABLE_GROUP`；新增配置级字段 `interpolateCustom`（`validateInterpolateFlag` / `interpolateFlagOf` / `withInterpolate`），`validateConfig` 保留它，`mergeLayers` 按「工作区显式 > 用户显式 > 未声明」合并 |
| 校验 | `core/interpolate.js`（新） | `classifyReferences` 逐行复刻 shipped `interpolate()`；`scanThrowingReference`（严格四条件）、`lintPromptText`（致命 vs 警告）、`assertInterpolatable`（400 `unresolvable-variable`）、`selfCheckConfig`（加载期降级）、`effectiveInterpolate`、`withSwitch`/`withoutSwitch` |
| 宿主 | `index.js` | 持有注册定义对象并在开关变化时改它的 `interpolate`；`ensureVariables`/`refreshVariables`/`variablesForWrite`（私有 scope 探针取变量表）；`syncInterpolate`；`GET`/`PUT /prompt-setting/interpolate`；PUT/import 写入前校验；`refreshUser`/`loadWorkspace` 加载期自检；快照 `layers.interpolate` |
| 客户端 | `client.js` | 「我的 Prompt」面板开关（状态、后果提示、锁定态、错误卡）、`INTERPOLATE_PATH`、4 个新错误码 zh/en 文案、8 组开关文案 |
| 契约 | `CONTRACT.md` | Revision 11 段、路由表两行、§2.3 修订、§2.3a、§15.3 修订、**§16**（8 个小节） |
| 台账 | `docs/prompt-variables.md` | §4 差异说明更正、§6 边界注记、**§8 变量替换开关**（开关语义 / 拦截表 / 软化 / 历史与加载期 / 预览一致性 / 复现） |
| 测试 | `test/interpolate.test.mjs`（新）、`test/route.test.mjs`、`test/integration.test.mjs`、`test/client.test.mjs` | 见下 |

## 二、关键设计与被否方案

1. **运行时切换靠「改自己那个定义对象的字段」**，不改任何私有字段。依据是两条实测事实：`NamedEntries` 按引用保存定义对象；shipped `assemble` 每轮现读 `section.interpolate` 并拷入 assembly。测试对**真** `@deepseek-ai/dsh-system-prompt` 固化了「下一次 assemble 立刻看到新值」。
2. **校验器不复用预览的扫描分支**。预览的「`group === null` 一律当散文」对只读预览是对的，做安全闸门则会漏掉 `{{ lone {{c}}` 与 `{{{{model}}}}`（实测两者 shipped 都抛错）。新校验器独立复刻，并用负向对照把「旧口径会漏、新实现抓住」写死。
3. **变量表动态获取**：本插件私有 scope 的一次真实 `assemble()`（与快照同一 `probe` 机制）。名字未知 ⇒ 硬拒；名字已知但当前值 `undefined` ⇒ 只警告。后者是唯一的软化，理由写进 §16.3：值属于会话而不属于文本，硬拒会让「没有活跃会话」时无法保存。
4. **开关写「缺字段」而不是 `false`**：关闭即删键，开→关→开后配置文件逐字节回到开启前（SHA-256 固化）。
5. **被否**：把开关塞进 `PUT /overrides` 的 body（会破坏 stage 1B 冻结的请求体，且旧客户端保存会静默关掉开关）；把开关状态放快照顶层（会打破 Revision 10 客户端的顶层键严格断言，故放进 `layers` 容器）；探针失败时按「没有变量」放行（等于放炸弹进来，改成 503）。

## 三、契约变更点（需人工确认的两处「既有断言/既有文档」改动）

- `test/route.test.mjs` 的假宿主 `section()` 由「浅拷贝定义」改为「按引用保存」，以忠实模拟 `NamedEntries`。`sectionRegistrations` 仍保留注册时快照，因此既有断言不变；不这样改，一个坏掉的运行时切换也能「通过」。
- `test/client.test.mjs` 的 `snapshotFixture` 增加 `layers.interpolate`，`ERROR_CODES` 增加 4 个新码，`PATHS`/`defaultResponses` 增加开关路由。均为追加。
- `CONTRACT.md` §2.3 原文「no user section ever has its `interpolate` turned on」被修订（加一句限定：仅本插件自己持有的那一个段定义、且仅当用户显式开启）。这是本修订**唯一**推翻既有陈述的地方，已就地标注。

## 四、本轮实测证据（包目录 `packages/dsh-prompt-setting/` 下执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **448 / 448 pass / 0 fail / 0 skipped**（约 15 s；基线 407，新增 41 项） |
| 校验器纯函数 | `node --test test/interpolate.test.mjs` | 16 / 16 pass（不依赖 DSH 安装） |
| 路由 + 开关 | `node --test test/route.test.mjs` | 69 / 69 pass |
| 真渲染器对照 | `node --test test/integration.test.mjs` | 27 / 27 pass（真 `@deepseek-ai/dsh-system-prompt`） |
| 客户端 UI | `node --test test/client.test.mjs` | 108 / 108 pass |
| 语法检查 | `node --check index.js / client.js / core/interpolate.js` | 通过 |
| **负向对照 I** | 校验器退回旧口径（畸形组当散文）→ 跑 interpolate + route + integration | **7 红**（`{{ lone {{c}}` / `{{{{model}}}}` 三类用例 + 路由拒绝 + 真渲染器对照） |
| **负向对照 II** | `applyInterpolateFlag` 只判断不写入字段（模拟「切换没生效」）→ 跑 route + integration + client | **6 红**（默认/开启/回退/预览分级/真 assemble 现读） |
| **负向对照 III** | 写入侧校验恒 `return`（模拟「不拦炸弹」）→ 跑 route + integration | **4 红**（PUT 拒绝、import 拒绝、开启前历史文本校验、真渲染器对照） |
| 还原核对 | `diff` 备份 + 负向对照标记残留检索（见下节同一命令） | 0 残留，全量回到 448 / 448 pass |

## 五、未验证项（诚实清单）

- **真机目视**：未重启 `dsh web`，未在运行中的 GUI 里点开关。宿主半的改动只有在进程重启后才生效；离线断言已覆盖到真 `renderPrompt` 与真 Cordis 上下文。
- **跨版本依赖**：本方案依赖 shipped `assemble` 每轮现读 `section.interpolate`。上游若改成注册时定死，开关会静默失效——已写入 `CONTRACT.md` §16.2 并有两处测试可在升级时先红。
- **`undefined` 值的软化**：开启态下保存「名字已注册但本次装配无值」的引用会放行；若该会话真实装配里该值仍是 `undefined`，那一轮仍会抛错。这是 §16.3 明示的取舍，未做「保存后再核实」。
- **多工作区**：开关按层声明，「工作区未声明则继承用户层」。若用户对某个工作区显式关掉，而无会话的请求（例如设置页全局视图）会把全局定义同步成用户层的值——多会话并发下「当前生效值」是最近一次请求解析出的那一个（`CONTRACT.md` §16.7 已记）。


---

# g-026 att-002：修掉独立审计的 BLOCK（Revision 12，基线 `6362aaf`）

独立对抗审计判定 BLOCK：不变式「开启后不得有文本使会话装配 throw」在纯 UI 操作下可被绕过。
本轮逐条修复 F1–F5，并把审计的复现固化为回归测试。

## 一、四个必修项怎么修的

- **F1（高）写入/开启/import 的判定口径**：新增 `layerTextIsArmed(root, config)`，
  把「被写那一层开没开」换成「这段文本能不能到达一个会插值的装配」：
  用户层文本在任何一层 ON 时即被武装；工作区层文本按 `effectiveInterpolate(user, ws)` 判定。
  写入（`PUT /overrides`）、开启（`PUT /interpolate`）、`import`（含 `dryRun`）与
  **加载期**（`enforceVisibleTextsSafe`，含 `loadWorkspace` 后的二次读取）共用这一条口径。
  审计的「两步绕过」「反向写用户层」「import 到用户层」三条路由级复现全部由 200/THROW 变 400 + 零字节。
  **被否方案**：审计文字里那句更保守的「任一层 ON ⇒ 校验所有可见层」。它会连带拒绝
  「显式关层的字面量 `{{...}}`」——而那正是 F4 存在的意义；并且会让加载期把一层的
  自身文本降级（在那一层作用域内它根本不会抛）。F1 的每条复现都由现有口径拦住，故不采用。
- **F3（中）装配不再依赖全局可变字段**：删除「请求期把 effective 写进全局单值」的机制。
  改为 `applyAssemblyInterpolate(sections, resolved)`：在**该次 dispatch 自己的** context 上
  从 `resolvedFor(context)`（真实 turn 走 session→workspace 合并；探针走探针自己的 config）取
  已合并的 flag，并把它写进**本次** `sections` 里保留段的 `interpolate`。
  `state.customDefinition.interpolate` 只保留为「无 scope 视图」的镜像（无 session 请求重算同一值，
  因而是 no-op）。测法：无 session 的 ping 之后，ON 工作区会话的真装配仍为 `interpolate: true` 且真替换；
  未武装的全局装配仍为字面量。
- **F2（中）warnings 上wire**：`assertInterpolatable` 现在返回 `{warnings}`，
  `PUT /overrides`、`PUT /interpolate`（开启态）、`POST /import`（含 dryRun）在非空时下发
  `warnings[]`（`{name, kind, code, message}`，≤3 条），客户端在「我的 Prompt」里呈现（zh/en 齐备）。
  字段是**条件性附加**：无话可说时响应与旧版逐字节相同（既有精确 body 断言不受影响）。
- **F4（低）三态**：磁盘上 未声明 / `true` / `false`；`PUT` 旧拼写 `{enabled:false}` 仍等于「未声明（删键）」，
  逐字节回退契约不变；新拼写 `{state:"inherit"|"on"|"off"}` 才写 `false`。UI 三键并列，
  并在「本层未设置但当前跟随上层 ON」时明说「要覆盖请选显式关」。
- **F5（低）加载期降级**：**选择「用户可感知 + 契约如实写明」**（审计给的第二条路）。
  降级仍是整层（`missing-file` 范式），但「我的 Prompt」现在就地呈现被停用层的原因与恢复路径
  （`data-warning="mine-layer-disabled"`），`CONTRACT.md` §16.5 把「整层而非单条」写成明确取舍。

## 二、口径与被否方案（写进 CONTRACT 的点）

- `CONTRACT.md` 新增 §16.2（装配按 context 现场决定 + 为什么「改全局定义对象」对本次装配无效）、
  §16.3 的 warnings 段、§16.4 的 F1 口径与三行门禁表、§16.5 的跨层加载期检查与 F5 取舍、
  §16.8（三态表）、§16.9（不做的事，新增「显式关层的字面量可存」一条）。
- 保留段注册值仍是 `interpolate: false`，作为「未被判定覆盖」的兜底。

## 三、本轮实测证据（包目录 `packages/dsh-prompt-setting/` 下执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **467 / 467 pass / 0 fail / 0 skipped**（约 15 s；基线 448，新增 19 项） |
| 校验器/三态纯函数 | `node --test test/interpolate.test.mjs` | 19 / 19 pass |
| 路由 + 审计复现 | `node --test test/route.test.mjs` | 78 / 78 pass |
| 真渲染器对照 | `node --test test/integration.test.mjs` | 27 / 27 pass（真 `@deepseek-ai/dsh-system-prompt`，差分 fuzz 0 漏检 0 误报） |
| 客户端 UI | `node --test test/client.test.mjs` | 115 / 115 pass |
| 语法检查 | `node --check index.js / client.js / core/interpolate.js` | 通过 |
| 负向对照 I | 写入校验退回「按被写层的 flag」判定 | **2 红**（反向写用户层、import 到用户层） |
| 负向对照 II | 装配 flag 改读全局 live 字段 | **3 红**（无 session ping、交错会话、显式关覆盖） |
| 负向对照 III | `describeWarnings` 退回「算完就丢」 | **1 红**（F2 路由用例） |
| 负向对照 IV | `withState('off')` 退回删键 | **2 红**（三态往返、显式关覆盖用户层 ON） |
| 残留核对 | 备份 `diff` + 负向对照标记检索 | 0 残留，全量回到 467 / 467 pass |

## 四、未验证项（诚实清单）

- **真机目视**：未重启 `dsh web`，未在运行中的 GUI 里点三态控件；宿主半改动需进程重启才生效，
  离线断言已覆盖到真 `renderPrompt` 与真 Cordis 上下文。
- **显式关层的字面量**：按 F1 口径可存（且真渲染为字面量），但加载期若该层被其它层武装则会被降级；
  这一取舍写入 `CONTRACT.md` §16.4/§16.5。
- **多工作区并发**：装配已按 context 现场决定，但「同一个 workspace 层」的多次写仍按请求串行，
  未做跨请求并发压测（离线无法复现真机并发）。
- **`undefined` 值的软化**：仍是 warning 而非拒绝（§16.3 明示），本轮只保证它被下发与呈现。

---

# g-026 att-003：堵死第二轮审计的两条 fail-open（Revision 13，基线 `63109f8`）

第二轮独立审计判定 BLOCK：F2–F5 成立，**F1 仍有两条 fail-open**——共同形态是「判定取的数据
与实际使用的数据来源不一致」。本轮先立总纲，再修两处：

> **凡判定所需的数据缺失、或与实际使用的数据来源不一致 ⇒ 一律 fail-closed**
> （拒绝写入 / 该轮不参与插值 / 明确降级 + reason）。不允许任何形式的 fail-open。

## 一、D1：判定集合与写目标来源不一致

- **现状**：`armedLayers`/`visibleLayers` 只遍历 `state.workspaces`（请求开头 `refreshLayers()` 建的缓存），
  而写目标 `targetFor` 经 `workspaceRegistry.list()` 动态解析。registry 在同一请求内才开始
  列出某工作区时，`armedLayers(next, target).some(l => l.root === target.root)` 恒为 false ⇒
  写入被判成「无需校验」⇒ 200 + 落字节 ⇒ `cacheWritten` 把该层塞进缓存 ⇒ 该会话真装配 THROW。
- **修法（两道，都 fail-closed）**：
  ① `targetFor` 解析出 root 后就地 `loadWorkspace(root)`（与 refresh 同一个读取器），
  判定集合与写目标从此同源；
  ② 判定前新增 `assertTargetJudged(target)`：目标仍不在判定集合内 ⇒ **400 `write-target-unverified`**、
  零字节（宁可过度拒绝：说不清的写入正是开关要拦的东西）。
  两个入口（`assertTextInterpolatable`、`assertStoredTextsInterpolatable`）都过了这一关。

## 二、D2：加载期只查语法，名字类漏检

- **现状**：加载期自检需要变量表，而 `state.variables` 只在首个 HTTP 请求时获取 ⇒
  `mount` 到首个路由请求之间只查语法。手工编辑/跨进程遗留的
  `{interpolateCustom:true, text:'x {{nope}}'}` 通过自检，**首轮真装配直接 THROW**。
- **修法（等效方案，比「异步补探测」更准）**：装配路径改从**本次装配自己即将使用的变量表**
  （`assembly.variables`）现场判定——`interpolateHoldReason(text, table)`：
  未注册 / 非法名 / 畸形组，**或根本没有表而文本含 `{{`** ⇒ **该轮退回不插值**
  （section 写 `interpolate: false`，文本按字面量进入 prompt），并把 reason 按 scope 记入
  `state.interpolationHolds`，快照以 `layers.interpolationHold: {at, reason}` 下发供 UI 说明。
  下一个走完路由的请求拿到表后，该层按既有范式降级。
  **被否方案**：mount 后 `void` 一个异步探针补表。它能缩短窗口，但会往单槽 `pendingProbe`
  里塞第二个并发 dispatch（路由路径本来就在探测），为「提前一个请求降级」换一个真实的并发交错风险；
  装配期判定是精确判定（用真表），窗口内的真实后果只是**一轮字面量**，不炸会话、也不静默放行。
- **窗口的真实后果（写进 CONTRACT §16.5.1，不是「下次请求才查名字」）**：
  armed 且文本无法解析的层，在 mount → 首个拿到表的请求之间，保留段**字面量渲染**；
  下一个请求即降级该层，此后该文本不会再 hold。
- **`undefined` 值不 hold**：它是 §16.3 的既定取舍（会话属性、非文本属性），仍「保存时警告 + 那一轮会抛」；
  加了一条防回归用例盯着它，防止后人把 hold 扩到 undefined 而悄悄改掉契约。

## 三、契约与文档

- `CONTRACT.md`：顶部新增 Revision 13 段（总纲 + D1/D2）；§2.3b 新增 `layers.interpolationHold` 字段；
  §16.3 判定表加「装配期」一列与「无表」一行；§16.4 新增 D1 段与 `400 write-target-unverified`；
  §16.5 改写「无表只查语法」那段并新增 §16.5.1（D2 与窗口真实后果）；§16.6 加 hold 的预览一致性；
  §16.9 改名 Revisions 11–13 并补「不改 undefined 取舍」「不做 mount 异步补探」两条；
- `docs/prompt-variables.md`：§8.4 补 D1/D2 口径，§8.3 补 hold 不覆盖 `undefined`，§8.5 预览表加 hold 一行。

## 四、本轮实测证据（包目录 `packages/dsh-prompt-setting/` 下执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **472 / 472 pass / 0 fail / 0 skipped**（基线 467，新增 5 项） |
| 路由 + 两条复现 | `node --test test/route.test.mjs` | 81 / 81 pass |
| 真渲染器对照 + 差分 | `node --test test/integration.test.mjs` | 29 / 29 pass（真 `@deepseek-ai/dsh-system-prompt`） |
| 校验器/纯函数 | `node --test test/interpolate.test.mjs` | 19 / 19 pass |
| 客户端 UI | `node --test test/client.test.mjs` | 115 / 115 pass（未改 client） |
| 负向对照 D1 | 还原 `targetFor` 的 `loadWorkspace`（源码 stash）后跑 rev13 用例 | **1 红** |
| 负向对照 D2 | 还原 `applyAssemblyInterpolate` 的 hold 后跑 rev13 用例 | **2 红**（route + integration） |
| 差分 fuzz（新增） | 13×13 组合文本 × 真 `renderPrompt` | 0 漏检 / 0 误报；两分支都被走到 |
| 残留核对 | `grep -rc 'NEGATIVE CONTROL'` 全包 | 0 |

## 五、未验证项（诚实清单）

- **真机目视**：未重启 `dsh web`，未在 GUI 里观察 hold 提示；宿主半改动需重启才生效。
- **hold 的客户端渲染**：reason 已随快照下发（`layers.interpolationHold`）并写进契约，
  但本轮**未接 client.js**（保持 UI 零改动，避免动到既有 115 条客户端断言与 build 指纹）；
  「上一轮为何字面量渲染」目前需从快照字段读。
- **`undefined` 值**：仍会让那一轮装配抛错（§16.3 既定取舍），本轮明确不在 D2 的收敛范围内。
- **多工作区并发**：D1 修的是「同一请求内来源漂移」，未做跨请求并发压测（离线无法复现真机并发）。

# g-026 att-004：第三轮审计 E1/E2/E3 收口（Revision 14，基线 `72472b6`）

审计判 BLOCK 的是 E1：**可达**的高危缺陷——装配期的 hold 判定用写入侧软口径
（`lintPromptText().errors`），而 `undefined` 归 warnings，于是「已注册但这一轮没值」的引用
被放行去插值，`renderPrompt` 抛 `prompt variable "{{cwd}}" has no value for this assembly`，
会话那一轮直接组不出来。总纲：**把「会话不炸」的最终责任收到装配期**——那里持有这一轮真实
的变量表与真实的段文本，必须用严格口径回答「这一轮会不会 throw」，且判定数据一律取自
**最终将要渲染的** `sections` 与 `variables`；写入侧保持宽松（探针表 ≠ 会话表，硬拒会让
无活跃会话时无法保存）。

## 一、E1：`undefined` 值必须 hold（装配期改严格口径）

- `core/interpolate.js` 的 `interpolateHoldReason` 改用 `scanThrowingReference`
  （四个抛错条件全算，`undefined` 计入；表缺失仍读作「名字全未知」）。hold 文案按类别分叉：
  `undefined` 值说「has no value in this assembly」，未注册/非法名说「cannot resolve」，
  畸形组单独一句——修复方向不同，UI 读到的是同一段人话。
- `assertInterpolatable` / `selfCheckConfig` / `lintPromptText` **一字未动**：写入与加载仍是
  「致命才 400 / 才降级，`undefined` 只给 warning」，所以无活跃会话时仍能保存，
  加载期也不会因病值停用整层。两侧现在回答的是两个不同问题（CONTRACT §16.3 有表）。

## 二、E2：判定与渲染同源（挪到最外层 + 用最终数据）

- 判定从 `assembleHandler`（内层）搬到 `keepReservedLastHandler`（`{prepend:true}` 的**最外层**
  listener）的 post-`next()`：这是本插件还能改装配的最后一个点，其后再没有 listener 能改它。
- 判定对象改为**最终 `sections` 里保留段的文本**与**最终 `variables`**，不再用
  `customTextOf(resolved)`（配置文本）。审计的漏放正是「配置文本安全、最终文本是炸弹」。
- 跨 listener 传递这一轮 resolved 配置：新增 `state.resolvedByContext`（以装配 context 对象为键的
  `WeakMap`）——探针一次性槽位（`pendingProbe`）仍只在内层消费一次，两个并发 dispatch 不会串。
  **被否方案**：在外层再调一次 `resolvedFor(context)`（探针槽已消费，会退回普通 merge，
  对 frozenProbe 的 probeConfig 语义不等价）。

## 三、E3：hold 生命周期闭环（选「清除」路线）

- `layers.interpolationHold` 从「最后一次 hold」变成**当前状态**：这一轮不 hold（文本改安全 /
  保留段被隐藏 / 开关关闭）就 `delete` 该 scope 的键，快照再也不会返回过期 reason 与旧时间戳。
- 选「清除」而不是「接 UI 呈现」：面板不必为不再存在的一轮解释什么，契约与断言都以「null =
  这一轮没 hold」为准。`layers.interpolate` 三键形状未动，`interpolationHold` 仍是其兄弟键。

## 四、E4（信息项）

- `assertTargetJudged` 保持为防御性兜底；CONTRACT §16.4 D1 段补写「**通常不可达**」的理由
  （`targetFor` 已把目标加载进缓存，该分支只防未来重构），不删。

## 五、契约与文档

- `CONTRACT.md`：新增 Revision 14 顶部段；§16.3 判定表第 4 行装配列改「held back」并重写
  「两个面问两个问题」的说明；§2.3b 改为「当前状态」语义；§16.4 D1 补 E4 备注；
  §16.5.1 标题改 Revisions 13–14、补 E1/E2/E3 三条与真渲染回归说明；§16.6 补「开+会抛这一格
  在保留段不可达」的说明；§16.9 改名 Revisions 11–14 并改写 undefined 与「不做 hold 历史」两条。
- `docs/prompt-variables.md`：§8.3 改名并改写为「写入侧的唯一软化」；§8.4 补 Revision 14 三条；
  §8.5 预览表更新（开+可解析 / 开+hold 两行，并说明 throwing 格为何不可达）。

## 六、本轮实测证据（包目录 `packages/dsh-prompt-setting/` 下执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **476 / 476 pass / 0 fail / 0 skipped**（基线 472，新增 4 项） |
| 路由（含 E1/E2/E3 复现） | `node --test test/route.test.mjs` | 83 / 83 pass |
| 真渲染器对照 + 差分 | `node --test test/integration.test.mjs` | 31 / 31 pass（真 `@deepseek-ai/dsh-system-prompt`） |
| 差分矩阵（含 `undefined` 类别） | 13×13 组合 × 真 `renderPrompt` | 0 漏放 / 0 误伤；hold 与严格口径逐条一致 |
| 真 host 复现 E1 | 手写 armed 层 + `variable('cwd', () => undefined)` | 该轮不抛、字面量渲染；去掉 hold 即 `prompt variable` 抛（负向对照） |
| E2 负向对照 | 旧口径（配置文本）跑新用例 | 1 红（改写文本漏放） |
| E3 负向对照 | 去掉 delete 分支跑新用例 | 1 红（过期 reason 残留） |
| OFF 态回归 | `6fa99d2` 的旧测试文件（route/client/integration/overrides）跑当前代码 | **213 / 213 pass / 0 fail**（`interpolate.test.mjs` 在 6fa99d2 尚不存在） |
| 残留核对 | 代码/测试内负向对照标记检索 | 0 |

## 七、未验证项（诚实清单）

- **真机目视**：未重启 `dsh web`，未在 GUI 里看 hold 提示；宿主半改动需重启才生效。
- **hold 仍未接 client.js**：reason 随快照下发且契约写明，但面板不呈现——本轮走「清除」路线，
  因此「此刻不 hold」与 `null` 一致；不再有「过期 reason 无处可查」的问题。
- **比本插件更外层的 listener**：判定已是本插件能占据的最后一点；若另一个 `{prepend:true}`
  在该点之后再改 sections/variables，本插件无法看到（也无力阻止）。已在契约里说明判定点的边界。
- **既有断言的三处契约同步**：E1/E2/E3 推翻了 Revision 13 钉住的三条断言（保留段 undefined
  不禁插值、预览开态 throwing、hold 快照可残留），本轮按新契约最小改写为收紧方向，
  并新增复现用例；具体清单与理由见交回报文的「需主管裁决事项」。


# g-026 att-005：终态重构（Revision 15，基线 `ad9034e`）

第四轮独立审计 BLOCK 的理由不是「某个分支写错了」，而是**设计前提被证伪**：
`{prepend:true}` 在 cordis 4.0.4 是 `unshift`，因此**后注册**的 prepend 监听器更外层，
Revision 14 那套「抢装配链最后一个位置，用最终 sections/variables 现场判定」的
安全模型**机制上不成立**；宿主忽略 `options` 时更是连「最外层」都拿不到。
负责人据此拍板方案 A：**放弃「判定会不会炸」，改成结构上不可能炸**。

## 一、终态设计（七条，逐条落地）

1. **保留段永远 `interpolate: false`**：注册如此，装配期永不改成 `true`。
   `syncInterpolate()`、`state.customDefinition`、以及把 `interpolate` 写进本次
   `sections` 的 `applyAssemblyInterpolate` 全部删除。DSH 的严格插值器再也看不到这段文本。
2. **开关 = 本插件自行展开**：`assembleHandler` 在 `applyOverrides` 之后调用
   `expandReservedSection(sections, assemblyVariablesOf(assembly, downstream))`，
   数据源严格是**本轮装配真实变量表**（`downstream.variables ?? assembly.variables`）。
3. **宽松语义**（`core/interpolate.js` 新增 `expandPromptText`）：已注册且有值 ⇒
   `String(value)`；未注册 / 值为 `undefined` / 畸形组 ⇒ 保留字面量；绝不 throw、
   绝不输出裸 `undefined`。扫描顺序复刻 shipped（`{{` 搜索 + `GROUP_AT` + 替换值不二次扫描），
   区别只在失败行为（shipped 抛错，这里保留）。
4. **位置无关**：展开在 `assembleHandler` 内，不依赖 `{prepend:true}`、不假设自己最外层。
   更外层 listener 之后改写 sections 的最坏结果是「这一轮没展开」，绝不 throw。
5. **删除 hold 机制**：`interpolateHoldReason` / `describeHold` / `state.interpolationHolds` /
   `INTERPOLATION_HOLD_LIMIT` / `layers.interpolationHold` / `state.resolvedByContext` /
   `takeResolvedFor` 全部删除；缺值引用由 g-025 的 `unresolvedLiteral` 如实呈现（保留段
   `interpolate: false` ⇒ 缺值引用天然进 literal），不新增重复字段。
6. **删除加载期插值自检与整层降级**：`selfCheckConfig` / `describeLayerDisabled` /
   `selfCheckLayer` / `enforceVisibleTextsSafe` / `degradeLayer` 全部删除。手改文件带着
   「死引用」落盘时，该层保持启用、文本照常进 prompt、死引用按 literal 呈现——
   整层降级会把用户的 Prompt 直接抹掉，而它已无法造成任何失败。
7. **写入侧校验口径不变**（未注册/非法名/畸形 ⇒ 400 `unresolvable-variable`；
   已注册但当前无值 ⇒ warning）：仍是 F1 的 `armedLayers` 口径，未扩大也未收紧；
   变的只是**定位与文案**——从「防炸」改为「UX 提示」，消息不再声称每轮抛错。

## 二、被否方案

- **继续打补丁**（再加一层「抢位置」的机制，例如 patch `ctx.on` 或注册顺序兜底）：
  审计已用真 Cordis 证明位置不可保证（后注册 prepend ⇒ 更外层；宿主忽略 options ⇒
  没有 prepend），任何依赖位置的安全模型都只是把赌注换了个地方。
- **让写入侧独自承担安全**：写侧校验挡不住手改文件、同步工具、停机期写入，
  而且 Revision 13 的 D2 已证明 mount→首个请求之间没有表；方案 A 之后这条路不再需要。
- **保留 hold 作为「未展开」的解释通道**：不需要。未解析引用已经由 `unresolvedLiteral`
  如实呈现，新增字段只会造成两套真相。

## 三、契约与文档

- `CONTRACT.md`：**§16.9（Revision 15 终态 + §16.9.1 shipped 差异对照表）**、
  **§16.10（断言改写台账，逐条理由与替代覆盖）**、**§16.11（不做什么）**新增；
  §16.2 重写（定义对象永不被触碰）、§16.3 判定表重写（assembly 列改「stays literal」）、
  §16.5 重写（删除加载期降级与跨层 pass）、§16.6/§16.7 重写（预览一致 / 可回退）、
  §6 增补 Revision 15 段并把 D2/E1/E2/E3 标注为「已被取代」、
  §2.3 修订「no user section ever has its interpolate turned on」的例外被撤回、
  §2.3b 标记该字段已移除、§15.3 说明 flag 重新变成常量、§16 标题改 Revisions 11–15。
  绝对声明「nothing else can change it / therefore the outermost」已删除。
- `docs/prompt-variables.md`：§8 整节重写（开关语义 / 写入侧拦截表 / 展开规则表 /
  被删机制 / 预览一致性 / 复现），§1/§4 的引用与说明同步。

## 四、本轮实测证据（包目录 `packages/dsh-prompt-setting/` 下执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **478 / 478 pass / 0 fail / 0 skipped**（基线 476，净增 2 项） |
| 展开 + 校验器纯函数 | `node --test test/interpolate.test.mjs` | 21 / 21 pass |
| 路由 + 装配期展开 | `node --test test/route.test.mjs` | 83 / 83 pass |
| 真渲染器对照 + F1/F2 | `node --test test/integration.test.mjs` | 31 / 31 pass（真 `@deepseek-ai/dsh-system-prompt`） |
| 客户端 UI | `node --test test/client.test.mjs` | 115 / 115 pass |
| 差分（可解析子集逐字符） | 16×16 组合文本 × 真 `renderPrompt` | 可解析子集**字节相同**；其余形态 shipped 真抛错而展开不抛；两分支都走到 |
| F1 复现（真 Cordis，后注册 `{prepend:true}`） | 三种改写：改成死引用 / 清空变量表 / 晚到变量 | 真 `renderPrompt` **0 throw**；最坏退化为未展开（逐条断言） |
| F2 复现（宿主忽略 options） | `mountRealPlugin(CUSTOM, {ignoreListenerOptions:true})` | 真 `renderPrompt` **0 throw**，且展开仍然发生 |
| **负向对照 I** | 展开时同时把段置 `interpolate: true`（模拟旧设计）→ 跑 integration F1/F2 | **2 红**（`renderPrompt` 抛 `prompt variable`） |
| **负向对照 II** | 去掉开关判断、无条件展开 → 跑 route 的 OFF 用例 | **2 红**（OFF 态字面量被替换） |
| **负向对照 III** | 未解析引用替换成 `undefined` 而非保留字面量 → 跑差分 | **2 红**（interpolate 宽松用例 + integration 差分） |
| OFF 态历史回归 | `6fa99d2` 的 14 个测试文件（不含 g-026 新增）跑当前源码 | **407 / 407 pass / 0 fail**（= g-026 之前的基线 407） |
| 残留核对 | `grep -rc 'NEGATIVE CONTROL'` 全包 | 0（仅 NOTES 本条自引用） |

## 五、被改写的断言（逐条理由见 `CONTRACT.md` §16.10）

本目标内被新设计推翻的断言共 10 处，全部为最小改写，方向「收紧或等价」且有替代用例承接：
ON 不再翻转定义（改为断言恒 `false` **并**断言文本已展开）、remount 不再靠翻转（改为断言
展开结果恢复）、加载期降级（改为断言层仍启用 + 死引用归 literal）、跨层降级（同上）、
`undefined` hold（改为断言文本仍字面量且快照**无**该字段）、两份 hold 差分（改为展开差分，
比较字节而非判定）、首轮 hold（改为首轮字面量 + 不抛）、E2 最终数据判定（改为三种 listener
改写下的不抛）、E3 hold 生命周期（改为「开关是唯一状态」）。
**g-026 之前的历史断言一行未改**，OFF 态回归 407/407 即其证据。

## 六、未验证项（诚实清单）

- **真机目视**：未重启 `dsh web`，未在运行中的 GUI 里点开关；宿主半改动需进程重启才生效。
- **比本插件更外层的 listener 之后改写**：本设计**接受**「这一轮没展开」（用户看到字面量）。
  这是取舍而非缺陷，已在契约 §16.9.4 与回归用例里写明。
- **跨版本**：本方案不再依赖 shipped `assemble` 如何拷贝 `interpolate`（那是 Revision 11–14
  的依赖），只依赖「`interpolate: false` 的段原样交给模型」这一条 shipped 语义——
  该语义由 integration 的真 `renderPrompt` 断言固化。

## 102. 未配置即误报「该作用域已被冻结」：`applied: false` 不是冻结信号（issue #1，2026-10-03，基线 `800a6c7` 工作区）

### 一、问题

issue #1（真机 0.2.0-rc.2 desktop + 本插件 0.1.1，commit `800a6c7`）：「我的 Prompt」在**什么都没写**时
渲染红色阻断块「该作用域已被冻结：你写下的 Prompt 不会生效」，而同页「高级 → 状态」是绿的
「本会话未冻结」，`?session=` 快照的 `frozen` 也是 `false` —— 同一份快照，两个半边结论相反。

### 二、根因：同一个字段的两个含义被当成一个

- **宿主语义（§15.3）**：`applied: false` 的**正常**含义是「这一段没有任何配置覆盖」。`core/overrides.js`
  的 `buildEffective` 对「无 override」的分支写 `applied: false` + `reason: null`，而 `reason` 的定义就是
  「`applied` 为 false 或 `overridable` 为 false 时的人类解释，**没什么要解释的就是 `null`**」。
  保留段 `prompt-setting:custom-prompt` **每次装配都注册**，所以「刚装好、未配置」必然命中这一分支。
- **契约文本把同一字段升格成冻结证据**：§2.4 的 certainty 定义与 §13.1 都写着「`frozen: true`，
  **或**保留段以 `applied: false` 到达」—— 漏了 `reason` 非 null 这个限定。客户端照着写。
- **客户端（旧 `client.js:5940-5947`）**：`reservedEffective.applied === false` 即判「确定冻结」，
  并把 `reason` 为 `null` 转成空串 `''`；下游用 `reason !== null` 判冻结（`client.js:5136`），
  于是**空串也算冻结**并走确定冻结文案。三处叠加 = 未配置即红字。
- 时序解释了「为什么第一次使用就撞上」：用户一写并生效后 `applied` 变 `true`，红字自行消失——
  误报恰好出现在最需要信任的那一次打开。

### 三、修法：冻结判定只认快照的 `frozen` / `frozenScope`

删掉「保留段 `applied: false`」这第二判据，`mineFrozen` 只保留 §2.4/§7.2 的两态：

```js
if (fz.certain && fz.frozen) return { reason: …, certain: true };   // session 冻结 / 无会话的 global 冻结
if (fz.kind === 'unknown' && fz.frozen) return { reason: …, certain: false };  // global + 选中会话
return null;
```

**为什么不是 issue 建议的「补一个 `reason !== null`」**（该补丁单独跑也能让未配置不再报警，属必要但不充分）：

1. `reason` 非 null 并不等于冻结。同一保留段的**非冻结失败**也带 reason：`replace` 没命中
   （`the section text differs from both…`）、`hide` 没吃掉、段被流水线丢弃。把它们说成
   「该作用域已被冻结」会把用户指向错误的解法（去换 agent preset），并把宿主英文原始原因直接显示在中文界面。
2. `frozenScope: "global"` + 选中会话时，保留段的 reason 来自**同一份全局探针**（`frozenInfo`），
   判据顺序里 reserved 分支又在 unknown 之前 ⇒ 会把 §2.4/§7.2 明令不得当作确定的「未知」态
   **升格为「确定冻结」**。这不是 issue 报告的路径，但同源，本次一并修掉。
3. 反过来看，凡是 fz 已判冻结的场景，保留段的证据与它**同源**（`buildEffective` 的 `frozen` 参数就是
   `frozenInfo.frozen`），所以这条「第二证据」在正常情况下冗余、在不确定态下有害；只有探针完全不可观测
   （`mounted: false`）时才非冗余，而那时它同样不可信。故整条判据删除，而不是收窄。

### 四、契约同步（防止实现再次漂回）

- §2.4 certainty 定义：`"certain"` 现在是「`frozenScope: "session"` + `frozen: true`，或无会话的
  `frozenScope: "global"` + `frozen: true`」，并明写「保留段 `applied: false` **不是**冻结信号」。
- §13.1：判据从「`frozen: true`，**或**保留段 `applied: false`」改为「快照的 `frozen`/`frozenScope`
  **单独**决定；§15.3 已定义 `applied: false` 是「无覆盖」的正常态，非冻结失败同样带它」。

### 五、新增回归（3 条，`test/client.test.mjs`）

| 用例 | 锁定的行为 |
| --- | --- |
| `an unconfigured install renders no frozen block (issue #1)` | 真机形状（保留段 `applied: false` + `reason: null`，`frozenScope: "session"`、`frozen: false`）⇒ 零 `data-warning="mine-frozen"`、零 `data-mine-frozen`、`data-mine-effect="next-turn"`、状态「未配置」 |
| `a non-frozen override failure is not reported as a freeze (issue #1)` | `applied: false` + 非冻结 reason ⇒ 仍不是冻结 |
| `the reserved entry never upgrades an unknown scope to a certain freeze (issue #1)` | global 冻结 + 选中会话，保留段带同一全局 reason ⇒ `data-mine-frozen-certainty="unknown"`、`data-mine-effect="unknown"` |

新增 fixture 时**不动** `snapshotFixture()` 的默认 `effective.sections`：真机上保留段确实总在，
但把它塞进默认 fixture 会连带推翻十余条与「段数量/列表内容」相关的既有断言（实测：注入后 12 红，
其中 7 条与冻结无关，例如段列表计数、总览的 copy sweep；用同样形状的普通段 `other:plugin` 对照注入，
得到同类的 9 条红），那是另一笔 fixture 债，不属于本次范围。故用**就地构造的真机形状**锁定行为。

### 六、客户端侧渲染矩阵（BEFORE/AFTER，同一 harness、同一场景）

实验方式：`git show HEAD:packages/dsh-prompt-setting/client.js > /tmp/client_before.js`，
测试 harness 通过 `PS_CLIENT` 环境变量选择被测客户端源码，四场景各渲染一次「我的 Prompt」面板：

| 场景 | BEFORE | AFTER |
| --- | --- | --- |
| S1 未配置（issue 现场） | `warning=1` `certainty=certain` `effect=none`，**状态行「本会话未冻结」与阻断块「该作用域已被冻结」同屏** | `warning=0` `effect=next-turn`（与状态卡一致，无红字） |
| S2 会话真被 complete 段冻结 | `warning=1` `certain` `none` + 正确原因 | **不变**（`warning=1` `certain` `none`，原因照旧）——无过度修复 |
| S3 global 冻结 + 选中会话 | `warning=1` **`certainty=certain`**，文案说「该作用域已被冻结」，原因用的是全局探针那句 | `warning=1` **`certainty=unknown`**，文案「冻结状态未知：本会话的装配无法确认」，原因换成 `frozenScopeReason` |
| S4 非冻结的应用失败 | `warning=1` `certain`，谎称被 complete 段冻结 | `warning=0` `effect=next-turn` |

红绿对照（同一 3 条新断言）：修复前源码 **3/3 红**，修复后 **3/3 绿**。

### 七、本轮实测证据（包目录 `packages/dsh-prompt-setting/` 下执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **483 / 483 pass / 0 fail / 0 skipped**（基线 480，新增 3） |
| 客户端 UI | `node --test test/client.test.mjs` | 120 / 120 pass（基线 117，新增 3） |
| 新断言红绿 | 修复前源码 + `--test-name-pattern="issue #1"` | **0 pass / 3 fail** |
| 同上 | 修复后源码 | **3 pass / 0 fail** |
| 渲染矩阵 | 四场景 × 两份源码 | 见第六节（BEFORE 四场景全为 `certain`；AFTER 与快照一致） |
| 兼容性自检 | `node scripts/check-compat.mjs` | 退出码 0，只读诊断不受影响 |

### 八、未验证项（诚实清单）

- **真机目视**：未重启 `dsh web`、未在运行中的桌面版里打开面板复核；客户端半改动需重新构建/重载客户端
  bundle 才生效，宿主半（本次未改）不受影响。
- **`mounted: false`（探针不可观测）时的面板表现**：本条判据删除后，这种情形下面板不再给出任何冻结提示。
  该情形本来就没有可信证据（fz 与保留段证据同源），未新增文案；如实记录为已知留白。
- **非冻结的应用失败在「我的 Prompt」面板不再有任何提示**：这是有意的——它由「段列表 / 提示词总览」的
  `applied` / 原因列负责（§15.3 语义），不冒充冻结。

## 103. 确认弹窗从「页面流内卡片」改为视口居中模态（2026-10-03，基线 `800a6c7` 工作区 + §102 的未提交改动）

### 一、问题（负责人报障）

「恢复默认」的确认弹窗**位置不对**：点按钮后卡片出现在面板**上方**、离按钮很远，要往上滚才看到。

### 二、根因：确认卡渲染在页面流里，且固定挂在面板之前

- 触发按钮在「我的 Prompt」的按钮行（`client.js:5474-5483`），而「我的 Prompt」是全页最长的面板
  （状态行 + 文本框 + 变量开关 + 说明 + 冻结块）；
- 确认卡被 push 进整页 `children`（tabs 之后、`panel` 之前），样式只有 `{...cardStyle}`，
  **没有 position** ⇒ 它是文档流内的一张卡；
- 于是它必然出现在触发点**上方**：页面滚到按钮处再点，卡片落在视口之外，体感是「点了没反应」；
  每次出现还会把面板整体下推（布局位移）。
- 自 g-005 引入以来位置未变（`git log -S "'data-region': 'confirm'"` 只有 `ec5e958`）；
  契约 §13.5 只规定「先渲染确认卡」，没规定位置——所以是设计缺口，不是回归。

### 三、修法：视口居中模态（负责人选定方案）

- `renderConfirm` 现在返回 `data-region="confirm-overlay"`：`position: fixed` + 四边 `0` +
  `display: flex` 双向居中 + `z-index: 1000` + 半透明遮罩，卡片限宽 `480`、限高 `80vh`（超出内部滚动）；
- 卡片本身仍是 `data-region="confirm"` + `data-confirm-kind` + 两个 `data-action`，既有断言与 sweep
  的 marker 一个未动，另加 `role="dialog"` / `aria-modal="true"` / `aria-label`；
- 挂载点去掉了 `display: contents` 包装（fixed 元素落点与 `children` 顺序无关），并留注释说明；
- 遮罩**只是背景**：点它不关闭任何东西，出口仍是 `confirm-yes` / `confirm-no`——这样既不会误关，
  也不会因为点遮罩而误判「已取消」；
- 契约 §13.5 同步写明结构、定位与 a11y 约定。

### 四、本轮实测证据（包目录 `packages/dsh-prompt-setting/` 下执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **483 / 483 pass / 0 fail** |
| 位置实验（BEFORE = `git show HEAD:…/client.js`） | harness 渲染后点「恢复默认」 | BEFORE：顶层 `children=[title, subtitle, status, session, tabs, **confirm-slot**, panel]`，`card-position=static`、无 overlay、无 role ⇒ 流内卡片、在面板之前 |
| 同上（AFTER = 当前源码） | 同上 | AFTER：`[title, subtitle, status, session, tabs, **confirm-overlay**, panel]`，`overlay-position=fixed`、`in-overlay=true`、`centered=center/center`、`overlay-z=1000`、`role=dialog` |
| 位置断言 | `node --test --test-name-pattern="恢复默认"` | 断言 overlay 为 fixed / 四向居中 / 卡片在 overlay 内 / 面板子树不含 `data-region="confirm"` / `role=dialog` + `aria-modal` |
| en sweep | `node --test test/client.test.mjs` | 新增必需 marker `data-region=confirm-overlay` 已被走通 |

### 五、未验证项（诚实清单）

- **真机目视**：未在桌面版重新构建 bundle 后肉眼确认；本仓库改动需重新打包安装（客户端半由 DSH HMR
  替换，但前提是 bundle 已更新）。
- **祖先带 `transform` 时的 `fixed` 语义**：若设置页容器带 transform/filter，`fixed` 会相对该容器而非视口。
  实际效果仍是「贴住容器可视区、不随滚动移出」，但未在真机验证；如需要可改用 `position: absolute` + 容器
  为定位上下文，作为后备方案。
- **键盘可达性**：只加了 `role="dialog"` / `aria-modal`，未实现焦点陷阱与 Esc 关闭；本轮范围只到「位置」。

## 104. 确认弹窗的文字排版：三层级 + 去重复（2026-10-03，承接 §103）

### 一、问题（负责人报障：「弹窗的文字排版需要优化」）

把四种 kind × zh/en 的弹窗结构 dump 出来，问题具体是四条：

1. **标题没有层级**：`请确认` 是 `fontSize: 13` 的 `<strong>`，而正文行**没有任何显式字号与行高**，
   靠继承；两者同尺寸，只剩颜色在区分，标题不像标题；
2. **间距只有一个值**：卡片 `gap: 6`，标题、正文两行、警示句、按钮行全部等距——没有分组，读起来是一坨；
3. **重复**：正文里已经写了「…；删除不可撤销。」/「此操作不可撤销，被删除的内容会记入历史。」，
   底下又单独一行红字「此操作不可撤销。」（`resetLayerBody`、`resetLegacyBody` 同样重复）；
4. **按钮与文案没有边界**：破坏性的「确认执行 / 取消」直接贴着警示句。

### 二、修法：三层级 + 结构分组 + 文案去重

| 层 | 规格 |
| --- | --- |
| 标题 | `14px / 600 / lineHeight 1.4`，`stateWarn` |
| 正文组 `data-role="confirm-body"` | 组内 `gap: 4`、`marginTop: 10`；**首句**（动作本身）`13px / 500 / labelPrimary`，**说明句** `13px / labelSecondary`，两者 `lineHeight: 1.6` + `wordBreak: break-word`（zh/en 长句都在 480px 卡片里折行） |
| 警示条 `data-role="confirm-irreversible"` | `marginTop: 12`、`paddingLeft: 10`、`borderLeft: 3px stateError`、`12px / lineHeight 1.5 / stateError` |
| 按钮行 `data-role="confirm-actions"` | `marginTop: 16` + `paddingTop: 12` + `borderTop: 1px borderL1`，按钮顺序与 marker 全部不变 |
| 卡片 | `padding: 16px 18px`，**去掉统一 `gap`**（分组由各层自己的 margin 决定） |

**文案去重**（6 条，zh+en 各 3）：`mineResetBody` / `resetLegacyBody` / `resetLayerBody` 里与
`resetIrreversible` 重复的「不可撤销」句删除。契约 §13.5 要求卡片「stating that the action cannot be
undone」，现在由警示条**唯一**承担，不再出现两次三次。改文案不动键名与参数，en sweep 的 copy 断言
（按注册表取值比对）自动跟随，无断言需要改写。

### 三、本轮实测证据（包目录 `packages/dsh-prompt-setting/` 下执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **483 / 483 pass / 0 fail** |
| 排版 dump（BEFORE = `git show HEAD:…/client.js`） | harness 渲染 4 kind × zh/en | BEFORE：卡片 `gap=6, padding=12px 14px`；正文两行同为 `13px`、无行高、无字重；警示句无 `borderLeft`（`fs` 继承）；按钮行无 `borderTop`；正文里出现两次「不可撤销」 |
| 排版 dump（AFTER = 当前源码） | 同上 | AFTER：`padding=16px 18px`、无统一 `gap`；`body0 = 13px/500/1.6`、`body1 = 13px/-/1.6` 且两行颜色分层；警示条 `borderLeft=yes, fs=12, mt=12`；按钮行 `borderTop=yes, mt=16`；「不可撤销」只出现 1 次 |
| 结构断言 | `node --test --test-name-pattern="恢复默认"` | 新增：`confirm-body` 的 `gap=4`、首句 `fontWeight=500`、`lineHeight=1.6`、两行颜色不同、警示条 `borderLeft` 含 `3px`、`fontSize=12`、按钮行 `borderTop` 以 `1px solid` 开头、`resetIrreversible` 只出现一次 |
| en sweep | `node --test test/client.test.mjs` | 新增必需 marker `data-role=confirm-body` / `confirm-irreversible` / `confirm-actions`，四个确认场景全部走通 |

### 四、未验证项（诚实清单）

- **真机目视**：未重新构建客户端 bundle 后肉眼核对；规格（14/13/12、1.4/1.6/1.5）是按 480px 卡片与
  现有 13px 正文基准推的，真机上若 shell 的字号基准不同，可能需要微调 Δ1px。
- **未做缩放核对**：200% 缩放与窄视口（<360px）下的折行未实测；卡片 `maxWidth: 480` 与
  `maxHeight: 80vh` 内的滚动行为沿用上一轮，未变。
- **主按钮语义色**：破坏性确认仍是品牌色 `primary` 按钮，本轮只改排版，未动颜色语义。

## 105. 设置页显示插件版本号，单一来源 = 宿主 ping.version（g-029，2026-10-03，基线 `9a7f434` 工作区）

### 一、要解决的问题

插件版本号此前只活在需要人工同步的多处副本里（`package.json` 的 `version`、`index.js` 的
`PLUGIN_VERSION`、CONTRACT 响应示例、两份 README 徽章、测试断言，见 g-028）；用户在设置页看不到自己装的
是哪个版本，排障（issue #1 的「从某 commit 的 tarball 安装」）只能去翻文件。页面已有的「构建戳」
（`data-build` / `data-build-server` / `data-build-match`）回答的是「这个 tab 跑的是哪份字节」，
与版本号互补而不可互替。

### 二、落点选择（为什么是顶部状态条 + 根容器）

| 候选落点 | 结论 | 理由 |
| --- | --- | --- |
| **顶部状态条 `data-region="status"`** | **选中**：构建戳 Tag 右边加一个版本 Tag | 与构建戳**同一行、同一区域**：两者本来就是一问一答（哪份字节 + 哪个版本），且打开设置页第一屏即可见，不必切 tab |
| 「高级」状态卡 `data-region="status-detail"` | 不重复渲染 | g-015 把「解释」都挪到那里，版本号不是解释；同一事实两处渲染只增加走样面（`data-region="build"` 里的两个指纹是解释，版本号不是） |
| 根容器 `data-plugin-version` | **选中**，与 `data-build*` 并列 | 沿用构建戳既有的「根容器暴露机器可读标记」体例，探针无需知道状态条的布局 |

### 三、实现要点

- `setBoot({ self, server, version, pingFailed })`：版本与构建戳来自**同一次 ping**（一个应答 = 一个宿主
  启动），从根上排除「版本来自 A 次、指纹来自 B 次」的错配；
- 存储与渲染两处都用「**去空白后仍非空**」判定（`version.trim().length > 0`）：字段缺失 / `null` / 数字 /
  对象 / `''` / 纯空白（`'   '`、`'\t\n'`）一律归一到 `'unknown'`，状态条不会出现 `v   `——不做 `String()`
  强转，也不把空白当声明（att-002 复核必修 1）；
- **合法值逐字节原样**：空白只用于「这是不是一个声明」的判定，渲染与机器标记用的都是 ping 的原字符串
  （`' 9.9.9-padded '` 原样输出，不 trim）——去掉填充是改写宿主的表述，不是本页该做的决定；
- **所有根容器都带该标记**：真页面、渲染失败卡（`data-render-state="error"` + `data-renderer="fallback"`）、
  加载失败卡（`data-renderer="none"`）三处都输出 `data-plugin-version`，后两者恒为 `'unknown'`（它们根本发不出
  ping）——探针只需读一个属性，不必知道「哪种渲染态才该有它」（att-002 复核必修 2）；
- `client.js` 内**零版本字面量**：测试用「当前版本加引号后必须不存在于 `client.js`」钉死这一条
  （注释里出现别的版本号如 `0.1.7-rc.2` 不受影响，因为断言只查带引号的字面量）；
- 未知态文案 `stPluginVersionUnknown`（「版本未知」/「Version unknown」），Tag tone 用 `outline`，
  与构建戳 unknown 同口径：任何情况下都不伪造版本号；
- **被否方案**：①在客户端 import `package.json` 取版本（浏览器模块没有该入口，且会变成第二份来源）；
  ②宿主新增一个 `GET /version` 路由（多余的往返，`version` 自 stage 1A 就在 ping 里）；
  ③把版本塞进 `data-build` 的值里（会破坏构建戳既有的「一个是/否 + 两个指纹」语义）。

### 四、契约与记账

- `CONTRACT.md`：新增 **Revision 16** 段；新增 **§13.8**（标记、取值来源 `ping.version`、`unknown` 态
  约定、与构建戳共用同一次应答）；§1 路由表的 ping 行补一句「页面自 Revision 16 起消费该 `version`」；
- 宿主半 `index.js` / `core/**` **零改动**（`version: PLUGIN_VERSION` 自 stage 1A 就存在，直接复用）；
- 既有构建戳的语义、标记与三态判定一律未动（`data-build*`、`data-status-build`、`data-warning=client-build-*`）。

### 五、本轮实测证据（包目录 `packages/dsh-prompt-setting/` 下执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **487 / 487 pass / 0 fail**（exit 0；att-001 首跑的一次红见下方「一次真实红」） |
| 相关两文件 | `node --test test/client.test.mjs test/boot.test.mjs` | **149 / 149 pass / 0 fail**（exit 0） |
| 基线对照 | 改动前 `node --test` | **483 / 483 pass / 0 fail**（exit 0） |
| 哨兵版本（负向对照） | `node --test --test-name-pattern="not a copy kept in the bundle"` | ping 返回仓库里不存在的 `9.9.9-sentinel`：`data-plugin-version` = 该值、状态条渲染 `v9.9.9-sentinel`，且**不出现** `v0.1.1`（若客户端硬编码就会红）；同一条用例另断言 `' 9.9.9-padded '` **原样**输出（合法值不 trim） |
| 真实链路 | `--test-name-pattern="cannot drift from the one the host publishes"` | `package.json.version === index.js` 的 `PLUGIN_VERSION`（读文件比对）；`index.js` 含 `version: PLUGIN_VERSION,`；`client.js` 不含带引号的版本字面量；ping 默认版本 ⇒ 页面标记 = `PLUGIN_VERSION` |
| unknown 七态 | `--test-name-pattern="a ping without a usable version"` | 无字段 / `null` / `42` / `''` / **`'   '`** / **`'\t\n'`** / `{}` / ping 失败 ⇒ `data-plugin-version="unknown"` + 「版本未知」文案 + 不出现任何 `v<原值>` |
| 空白版本（必修 1 专属用例） | `--test-name-pattern="whitespace-only version"` | `'   '` / `'\t'` / `'\n'` / `' \t\n '` 四种纯空白 ⇒ marker `unknown`、文案「版本未知」、屏幕上不出现 `v` + 空白 |
| 降级根容器（必修 2） | `--test-name-pattern="failure card"` | 渲染抛错卡（`client.test.mjs`）与加载失败卡（`boot.test.mjs`）两个根容器都断言 `data-plugin-version === 'unknown'` |
| 改坏就红 A（去掉 trim 归一） | 备份后把两处 `version.trim().length > 0` 改回 `version.length > 0`，跑 client | **122 pass / 2 fail**（空白用例 + unknown 七态用例变红）；`cp` 还原后 124/124 |
| 改坏就红 B（删两处降级卡标记） | 备份后删掉两张失败卡的 `'data-plugin-version': 'unknown'`，跑 client+boot | **147 pass / 2 fail**（渲染抛错卡断言 + 加载失败卡断言各红）；`cp` 还原后 149/149 |
| 改坏就红 C（硬编码版本） | 备份后把消费点改成 `version: '0.1.1'`，跑 client | **119 pass / 5 fail**（3 条 g-029 断言 + 空白版本用例 + en sweep）；`cp` 还原后 **124 / 124 pass / 0 fail** |
| en sweep | `node --test test/client.test.mjs` | 必需 marker 列表含 `data-plugin-version=<当前版本>` 与 `data-plugin-version=unknown`，构建戳单元场景同时覆盖两态 |

**一次真实红（留档）**：全量首跑 1 fail —— `test/host.test.mjs:359` 断言 `client.js` 不得含
`/<[A-Za-z][^>]*>/`（无 JSX 的守卫）。我新写的注释里用了 `` `v<version>` `` 这种尖括号占位符，被这条既有
断言抓住。修法是把它改成 `v` + 版本号的散文写法，而不是放宽断言（断言未动）。

### 六、未验证项（诚实清单）

- **真机目视**：HMR 监视主工作树，worktree 里的 `client.js` 改动对运行中页面不可见 ⇒ 版本 Tag 的真机视觉
  （与既有三个 Tag 并排后的换行、`success`/`outline` 观感、窄视口下的排布）由主管合并后在集成副本上确认；
- **超长版本串**：宿主若返回异常长的 `version`，Tag 不截断（沿用状态条既有的 `flexWrap` 换行），未实测极端长度；
- **版本语义**：只当它是「宿主声明的版本字符串」，页面不解析 semver、不比较新旧、不做「检查更新」（属 g-030）。

### 七、守卫的覆盖边界（att-002 复核要求如实写明，不为此加固断言）

「`client.js` 内零版本字面量」这条断言（`test/client.test.mjs`，`clientSource.includes(`'${version}'`)`）
**只是廉价补充，不是单一来源的真正保障**，覆盖面与误报面如下：

| 面 | 事实 |
| --- | --- |
| **抓得到** | 单引号或双引号包裹的**当前** `package.json.version` 字面量（如 `const FALLBACK = '0.1.1';`） |
| **抓不到** | 反引号模板串（`` `0.1.1` ``）、字符串拼接（`'0.' + '1.1'`）、`String.fromCharCode(...)`、从别处 import 常量、以及**旧版本号**字面量（与当前值不同者）——这些形式都不会被这条断言拦下 |
| **会误报（保守）** | 注释或文档字符串里出现**带引号的当前版本**会被判红（哪怕只是举例），这正是 att-002 首轮差点踩到的方向；宁可误报也不放过 |
| **真正的保障** | **sentinel 负向对照**：ping 返回仓库中不存在的 `9.9.9-sentinel` 时，`data-plugin-version` 与 `v{...}` 文本必须等于该值（改坏就红 C 证明：硬编码 `0.1.1` 会红）。它证明的是「渲染值来自 ping」，而不是「文件里没有字面量」——前者才是契约要求的性质 |

按复核意见**不加固**这条守卫（不改成正则扫描模板串/拼接）：静态扫描的边际收益低、误伤面大，还会给出
「已经防住了」的假安全感；真正需要的是上面的行为对照。

**补充（Revision 17 之后新增的两条同类守卫及其边界）**：
- `clientSource.includes('github.com') === false` —— 禁止客户端写死仓库主机。边界同上：只抓这一个字符串，
  别的 host（`gitlab.com`、自建域名）或拼接形式抓不到；注释里出现 `github.com` 会误报（本轮的注释改用
  「the ping's URL」的散文表述，正是为了不触发它）；
- `test/host.test.mjs:359` 的 `/<[A-Za-z][^>]*>/ === false`（**既有**守卫）：它的本意是「client.js 不许出现
  JSX 风格标签」，但任何**注释里的 HTML 尖括号**（`<a>`、`v<version>`）都会命中。g-029 期间它被踩到两次
  （att-001 与 Revision 17 各一次），两次都按「改注释、不放宽断言」处理。

### 八、Revision 17 修订：落点移到设置页标题旁 + 点击跳转仓库（2026-10-03，负责人修订）

**为什么改**：版本号此前是状态条上的第四枚 Tag，与「覆盖引擎 / 冻结态 / 构建戳」并列——那三枚是**健康裁决**，
版本号是**身份**，混在一行里读起来像第四枚裁决。负责人据此把落点移到设置页标题旁，并把「装的是谁家的哪一版」
补成可点链接。**原「Tag tone / 是否在高级重复显示」两个取舍点随之作废。**

**宿主半（`index.js`，本目标首次改动宿主代码）**
- 新增**纯函数** `repositoryUrlOf(manifest)`（导出，供离线单测）：按序取 `repository.url`（去 `git+` 前缀与
  `.git` 后缀）⇒ 裸 `repository` 字符串（同样清洗，两种写法给同一个地址）⇒ `homepage`（去 `#…` 片段）⇒ `null`；
- `OWN_REPOSITORY_URL` 与既有 `DSH_PEER_RANGE` 同源同风格：import 时读自己的 `package.json`、`try/catch`
  兜底、**失败绝不抛**；ping 响应新增 `repositoryUrl`；
- `package.json` 是唯一定义处：宿主不写字面量，客户端也不写。

**客户端半（`client.js`）**
- 版本节点移到**标题行**（`h2` 的同级、flex baseline 对齐），标记 `data-role="plugin-version"`；
- **状态条不再渲染版本 Tag**，落点唯一（用例断言全页恰好 1 个该节点、且 `data-region="status"` 子树里 0 个）；
- 有 `repositoryUrl` ⇒ `a` 元素（`href` = ping 的 URL、`target="_blank"`、`rel="noreferrer noopener"`，
  `data-plugin-repository` = 同一 URL）；无 ⇒ 同位置 `span` + `data-plugin-repository="unknown"`，
  **纯文本、不可点**（不伪造 URL、不发空 `href`）；版本 unknown 且有 URL 时**仍是链接**，文本用
  `stPluginVersionUnknown`；
- `repositoryUrl` 与 `version` **同一次 ping、同口径**（非空字符串、`trim()` 判空，否则 `null`）；根容器
  `data-plugin-version` 与两张降级失败卡的 `'unknown'` **保持不变**。

**被改写的既有断言（逐条，等价改写、无削弱）**

| # | 位置 | 改了什么 | 为什么不算削弱 |
| --- | --- | --- | --- |
| 1 | `test/route.test.mjs` ping 字段全集 `deepEqual(Object.keys(payload).sort(), […])` | 列表加入 `'repositoryUrl'` | ping 按契约新增字段，字段全集断言必须跟随；**未删任何既有字段** |
| 2 | `test/client.test.mjs`「the version on the page is…」 | `assert.ok(hasText(tree, zh.stPluginVersion))` → `assert.equal(oneBy(tree,'data-role','plugin-version').props.title, zh.stPluginVersion)` | 该文案从可见子文本变成节点的 `title` 属性；断言从「某处出现该文案」收紧为「**该节点**携带该文案」 |
| 3 | 同用例 | 断言消息 `the status line renders v…` → `the title line renders v…` | 仅消息文字，判定不变 |
| 4 | 同用例（padded 段） | 断言消息 `the tag shows…` → `the node shows…` | 仅消息文字，判定不变 |
| 5 | `test/client.test.mjs` en sweep（`EN_REQUIRED_MARKERS` + build-stamp case 的 `marks`） | **新增** `data-role=plugin-version`、`data-plugin-repository=<url>`、`data-plugin-repository=unknown` | 纯新增，未删既有 marker/copy |

**本轮实测证据**（包目录 `packages/dsh-prompt-setting/` 下执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **490 / 490 pass / 0 fail**（exit 0；Revision 17 前为 487，新增 3 条用例） |
| 相关三文件 | `node --test test/client.test.mjs test/host.test.mjs test/route.test.mjs` | **230 / 230 pass / 0 fail**（exit 0） |
| 宿主纯函数 | `--test-name-pattern="repositoryUrlOf derives"` | 5 类输入全过：`git+…​.git` ⇒ 去装饰；裸字符串（含 `git+…​.git` 形式）⇒ 同址；`homepage#readme` ⇒ 去片段；`repository` 缺 `url` ⇒ 落到 `homepage`／无则 `null`；全缺/`null`/`'not a manifest'`/空白 ⇒ `null` |
| 防漂移（宿主） | `--test-name-pattern="reports the repository URL its own manifest declares"` | ping 的 `repositoryUrl` === `repositoryUrlOf(packageJson)`，且 `^https?://`、无 `git+`、无 `.git` 后缀 |
| 落点唯一 + 链接属性（客户端） | `--test-name-pattern="not a copy kept in the bundle"` | `data-role="plugin-version"` 节点：`type='a'`、`href`=fixture URL、`target='_blank'`、`rel='noreferrer noopener'`、`data-plugin-repository`=同一 URL、`title`=「插件版本」、文本=`v9.9.9-sentinel`；全页恰 1 个；status 子树 0 个 |
| 降级形态（客户端） | `--test-name-pattern="without a repository URL"` | 四种「没有 URL」（缺字段/`null`/空白/数字）⇒ `type='span'`、无 `href`、`data-plugin-repository='unknown'`、文本仍渲染 `v1.2.3`、根容器标记不受影响；有 URL + unknown 版本 ⇒ 仍是 `a` + 「版本未知」；两者皆缺 ⇒ `span` + 「版本未知」 |
| 改坏就红 ①（宿主硬编码 URL） | 把 ping 的 `repositoryUrl` 改成 `'https://example.com/hardcoded'`，跑 `test/host.test.mjs` | **21 pass / 1 fail**（防漂移断言变红）；还原后 22/22 |
| 改坏就红 ②（无 URL 仍渲染链接） | 把客户端的无 URL 分支改成仍渲染 `a`（`href=''`），跑 `test/client.test.mjs` | **124 pass / 1 fail**（降级断言变红）；还原后 125/125 |

**真机验证的额外前提（如实写明）**：本轮**首次改了宿主半 `index.js`**（ping 新增 `repositoryUrl`）。客户端半走
HMR，但宿主半必须**重启 `dsh web`** 才生效——重启会终止正在运行的会话，因此真机目视（链接可点、跳转正确、
标题行排版）由**主管在合并后统一安排**，本轮只做离线验证；未重启前，旧宿主进程的 ping 不带该字段，页面按
「无 URL」降级渲染纯文本版本号（这正是降级分支要覆盖的现实情形）。

### 九、Revision 17 复核收口（独立复核 3 条小缺口）

**A｜派生函数校验 scheme（最高优先）**
- `asGitAddress` 现在**只接受 `http://` / `https://`** 开头的地址：SSH 形态（`git@github.com:a/b.git`、
  `ssh://…`）与非 web scheme（`ftp://`）一律视为不可用，**回退 `homepage`（同样要求 http(s)），再不行 `null`**；
  **不做** SSH→https 自动改写（那是猜测一个不同的地址）；`homepage` 原先只判非空，现补同样的 http(s) 校验；
- **尾斜杠**：选择「先折叠尾斜杠、再判 `.git`」⇒ `https://x/y.git/` → `https://x/y`。理由：尾斜杠是**同一地址的
  书写变体**（折叠不改变目标），SSH→https 是**换一个地址**（猜测）——两者性质不同，故一个做、一个不做，均有断言；
- 契约同步：Revision 17 段、§13.8「the link」bullet（宿主只报 http(s)），§14.2 的 `repositoryUrl` bullet
  （非 http(s) ⇒ `null`、SSH 不改写）。

**B｜降级卡与契约措辞的一致性**
- 加载失败卡的 `data-plugin-version='unknown'` **此前已有**断言（`test/boot.test.mjs` 的 "a throwing client body
  degrades to a card that keeps the machine markers"）；本轮另加一条**独立用例**
  `boot: the load-failure card carries data-plugin-version="unknown"`，便于按用例名单独取证，并同时断言该卡片
  没有 `data-role`（失败卡没有标题行，本来就不该有 `data-role="plugin-version"`）；
- 契约 §13.8 把「exactly one `data-role="plugin-version"`」**限定为正常渲染态**，并写明两张失败卡**不存在**该节点、
  机器的版本真值由**根容器**的 `data-plugin-version` 提供（每个渲染态都有它）。

**C｜标题行 React key**：标题行 `h2` 补 `key: 'heading'`（与同一 children 数组里的版本节点 `key: 'version'` 并列），
消除 React 开发构建的 key 警告；纯工程整洁，行为与标记不变，未加断言。

**本轮实测证据**（包目录 `packages/dsh-prompt-setting/` 下执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **491 / 491 pass / 0 fail**（exit 0；上一轮 490，新增 1 条独立用例） |
| 相关三文件 | `node --test test/host.test.mjs test/boot.test.mjs test/client.test.mjs` | **173 / 173 pass / 0 fail**（exit 0） |
| A 新增边界（绿） | `--test-name-pattern="repositoryUrlOf derives"` | scp 风格 / `ssh://` / `ftp://` / 非 http 的 `homepage` ⇒ `null`；SSH + `homepage` ⇒ 用 `homepage`；`https://x/y.git/` ⇒ `https://x/y`；`git+https://x/y.git/` ⇒ `https://x/y`；`http://x/y.git` ⇒ `http://x/y`；原 5 类输入与「ping === `repositoryUrlOf(packageJson)`」保持全绿 |
| 改坏就红 A（去掉 scheme 校验） | `asGitAddress` 末尾改回 `url.length > 0 ? url : null`，跑 `test/host.test.mjs` | **21 pass / 1 fail**（新增边界用例变红）；还原后 22/22 |
| 改坏就红 B（删加载失败卡标记） | 删掉该卡的 `'data-plugin-version': 'unknown'`，跑 `test/boot.test.mjs` | **24 pass / 2 fail**（既有断言 + 新增独立用例各红一条）；还原后 26/26 |

## 106. 上游更新检查：宿主代理一个 GitHub Releases `GET` + 可关闭提示条与「高级」开关（g-030，2026-10-03，基线 `9cc0da0` 工作区）

### 一、要解决的问题

插件以 tarball / `link:` 安装，`npm` 侧没有任何东西会告诉用户上游动了；升级只能靠人去 GitHub 页面看。
负责人 2026-10-03 确认数据源走 **GitHub Releases API**（不是 npm registry），因为用户实际安装的是这里的
release。三个不可让步的性质：**绝不误报有更新**、**失败绝不干扰页面**、**只发一个请求且可关闭**。

### 二、落点选择（为什么是「宿主一个路由 + 独立偏好文件 + 页面镜像」）

| 候选 | 结论 | 理由 |
| --- | --- | --- |
| 客户端直接 `fetch` GitHub | **否** | 浏览器侧受 CORS / 无法超时 / 无法缓存 / 无法真正关闭；且会把「联网」这件事放到页面半边 |
| **宿主 `GET /prompt-setting/update-check`** | **选中** | Node 侧 `fetch`：无 CORS、可 `AbortController`、可缓存、可被开关短路；沿用既有前缀路由与 `connection.requestRejection` 信任栅栏 |
| 开关存进 `overrides.json`（像 `interpolateCustom` 那样） | **否** | 那会把「本机是否联网」拖进 export / import / history / snapshot 四个 frozen schema；一个开关不该让四个契约涨字段 |
| **`<DSH_HOME>/prompt-setting/preferences.json`** | **选中** | 独立文件、独立语义；损坏 / 缺失一律回落到默认「开启」，且损坏是被**报告**而不是被静默改写 |
| 开关只在客户端 `localStorage` | **否** | 换浏览器 / 换 profile 就丢；`localStorage` 只作**镜像**（省一次往返，且让「关闭后页面挂载零请求」真的成立），权威始终在宿主 |
| 开关降级为「配置文件 + 文档」 | **否（负责人明确否决）** | 找不到的隐私开关不算开关，必须做进「高级」tab |

### 三、实现要点

- **纯策略层 `core/update.js`**：`parseRepositorySlug` / `parseSemver` / `compareSemver` /
  `isNewerVersion` / `normalizePreferences` 都是纯函数；`createUpdateChecker` 把 **transport、时钟、
  TTL、超时、偏好读写全部注入**（默认 `globalThis.fetch` / `Date.now` / 6h / 5s），所以单测与路由测都
  不可能真联网；
- **`check()` 的分支顺序就是安全顺序**：先读开关（关 ⇒ 直接返回，**零外呼**）→ 再查缓存（TTL 内
  `cached:true`）→ `force` 只跳缓存、**不跳开关** → 才发那唯一一个 `GET`；
- **判定表**：`latest > current` ⇒ `hasUpdate:true`；相等或更旧 ⇒ `false`；404 / tag 不解析 / 无
  `tag_name` / `current` 自身不可解析 ⇒ **`hasUpdate:null`**（「无可用信息」），页面据此**什么都不显示**
  ——`null` 的存在就是为了让「不知道」既不等于「已最新」也不等于「落后」；
- **失败是值不是异常**：网络错误 / 超时 / HTTP≠2xx(404 除外) 全部 `ok:false` + 结构化 `error`，路由
  恒答 **200**；`PUT` 写偏好失败也是 200 + `preferences-unwritable`。唯一 400 是 `PUT` 形状错
  （`invalid-enabled`），与 `PUT /interpolate` 同口径；
- **缓存只缓存确定性答案**：成功、404、tag 不可解析都缓存（仓库暂时没 release 不该每次开页面都去打
  GitHub）；网络错误 / 超时 / HTTP 错误**不缓存**，下一次重试；
- **超时是双保险**：`AbortController.signal` + 内部 `Promise.race`，即使注入的 transport 完全无视
  signal（测试里那个永不 resolve 的 stub）也不会把页面挂住；
- **请求形态**：`GET`，`accept: application/vnd.github+json`，`user-agent:
  dsh-prompt-setting/<版本>`，无 body、无 cookie、无任何本机 / 会话 / 工作区派生的参数；URL 由
  `parseRepositorySlug(repository.url)` 拼出，仓库只写一处（`package.json`）；
- **客户端三态**：挂载时 `localStorage` 镜像读 `'off'` ⇒ **一个请求都不发**（连 `GET /update-check`
  都不发）；否则请求一次，用宿主答案里的 `enabled` 回填镜像与开关显示；
- **提示条**：只在 `hasUpdate === true` 且 `latest` 是非空字符串时渲染，`data-update-available="true"` /
  `data-update-latest` / 发布页链接（`target="_blank"` + `rel="noreferrer noopener"`）/ 关闭按钮
  `data-action="update-dismiss"`（仅本会话隐藏，不发请求、不写任何东西）；
- **开关**：`data-region="update-setting"` + `data-update-enabled` + `data-action="update-toggle"`
  （`aria-pressed` 同步），关闭态不渲染「立即重查」；发送值 = 宿主上次报告状态的**取反**，所以一次点击
  必然得到标签承诺的状态；开启时立即 `?force=1` 查一次；
- **「零提示零红字」是结构性的**：`renderUpdateNotice` 对「无更新 / `null` / 失败 / 已关闭」返回
  `null`，它没有任何路径能产出 `data-notice="error"`；失败的检查只更新开关卡片里的一行中性文案。

### 四、被否方案

① 客户端直连 GitHub（见上表）；② 复用 `GET /prompt-setting/interpolate` 或往 `ping` 里塞
`updateCheckEnabled`/`hasUpdate`：判据 8 明确要求**不改既有 ping / snapshot / overrides 的响应形状**，
ping 是多处断言过的 frozen 形状；③ 把开关写进 `overrides.json`；④ 「配置文件 + 文档」的降级形态
（负责人已否决）；⑤ 用 npm registry 的 `dist-tags`（负责人已确认不是这个数据源）。

### 五、契约与文档

- `CONTRACT.md`：§1 路由表 + `allow` 清单加 `update-check`；**新增 §17**（数据源与三条性质、字段表、
  判定表、缓存/超时/请求形态、`PUT` 与偏好文件、不做什么）；**新增 §13.9**（提示条与开关的标记、静默
  规则、`localStorage` 镜像与「关闭后零请求」）；§13.3 的「三条基线请求」改为四条；
- 三份 README（根 `README.md` / 根 `README_zh.md` / 包 `README.md`）：写明**只有一个请求、不带任何
  本机数据、5 秒超时 / 6 小时缓存、失败静默**，以及**关闭方法**（UI 路径 + `preferences.json` 手改路径）；
- 包 `README.md`「高级」bullet 与根两份 README 的 tab 表都点出「检查更新」开关及其默认值；
- `CHANGELOG.md` `[Unreleased] → Added` 补中英条目；`client.js` 顶部模块注释补 g-030 段；
  `index.js` 顶部「seven REST routes」改为 eight。

### 六、本轮实测证据（包目录 `packages/dsh-prompt-setting/` 下执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **532 / 532 pass / 0 fail**（exit 0） |
| 基线对照 | 改动前 `node --test` | **491 / 491 pass / 0 fail**（exit 0） |
| 新增宿主套件 | `node --test test/update.test.mjs` | **34 / 34 pass / 0 fail**（第 1 跑 33/1，红的是本测试自身 TTL 换算写错，已修） |
| 新增客户端用例 | `node --test test/client.test.mjs` | **132 / 132 pass / 0 fail**（原 125 + 7） |
| 语法 | `node --check index.js / client.js / core/update.js` | 三个文件均 exit 0 |
| 判定语义 | `--test-name-pattern="comparison is numeric"`、`"the same version, and an older one"` | `v0.1.2 > 0.1.1` ⇒ true；相等 / 更旧 ⇒ false；`latest` / `1.2` / `1.2.3.4` / 非版本 current ⇒ `null`；`0.10.0 > 0.9.9` |
| 降级四态 | `--test-name-pattern="hasUpdate:null"`、`"a network error is a structured failure"`、`"an HTTP error"`、`"times out"` | 404 ⇒ `ok:true` + `no-release`；tag 畸形 ⇒ `unparsable-tag`；网络错误 ⇒ `ok:false` + `network-error`（且**不缓存**，第二次仍外呼）；403 ⇒ `http-error` + `status:403`；25ms 注入超时 ⇒ `timeout` |
| 缓存 / force | `--test-name-pattern="repeat inside the TTL"` | TTL 内第二次 `cached:true` 且外呼数不变；`force:1` ⇒ 再次外呼；TTL 过后再次外呼 |
| 开关零外呼 | `--test-name-pattern="a closed switch answers without asking anyone"`、`"the switch is persisted"` | `enabled:false` 时外呼数 **0**（含 `?force=1`）；路由 `PUT {enabled:false}` 后 `GET` 仍 0；**重挂载**（等价于下次打开页面）读同一文件后仍 0 |
| 路由形状 | `--test-name-pattern="GET answers the documented shape"`、`"never a 5xx"`、`"method table"` | 九个字段齐全；fetch 抛错 ⇒ **200** + `network-error`；`POST` ⇒ 405 `allow: GET, PUT`；信任栅栏 403 / 缺 `connection` 503 且**未触达检查** |
| 不碰既有形状 | `--test-name-pattern="ping is untouched"` | ping 响应仍 `ok/version`，且**不含** `hasUpdate` |
| 客户端静默 | `--test-name-pattern="equally silent"` | 已最新 / `hasUpdate:null` / 请求失败三种 ⇒ 无 `data-update-available`、无 `data-notice=error` |
| 客户端提示条 | `--test-name-pattern="dismissible banner"` | `data-update-latest="0.9.9"`；链接 `target=_blank` + `rel=noreferrer noopener`；点关闭后节点消失且零写入 |
| **改坏就红 A**（比较语义归零） | 备份后把 `core/update.js` 的 `hasUpdate: newer` 改成 `hasUpdate: true`，跑 `test/update.test.mjs` | **33 pass / 1 fail**（「相等或更旧」用例红）；`cp` 还原后 34/34 |
| **改坏就红 B**（删开关短路） | 备份后删掉 `check()` 开头的 `preferences()[…] !== true ⇒ return` 分支，跑 `test/update.test.mjs` | **32 pass / 2 fail**（「关闭开关零外呼」与「`force` 不跳开关」两条红）；还原后 34/34 |
| **改坏就红 C**（忽略本地镜像） | 备份后把 `client.js` 挂载处的 `if (readUpdatePref() === false)` 改成 `if (false)`，跑 `test/client.test.mjs` | **130 pass / 2 fail**（「镜像 off 挂载零请求」与「重新开启立即查」两条红）；`cp` 还原后 132/132 |

### 七、未验证项（诚实清单）

- **真机目视未做**：宿主半（`index.js` / `core/**`）需要重启 `dsh web` 才生效，客户端半虽走 HMR 但
  当前 `dsh web` 的 HMR 监视的是主工作树 —— 本轮改动就在主工作树内，合并/重启后由主管做一次真机确认
  （打开设置页看提示条与「高级」开关、关掉后看网络面板零请求）。本轮所有结论都来自离线断言；
- **没有对真实 `api.github.com` 发过一次请求**：这是判据 6 的要求（全部用注入的 fetch stub），因此
  「真实 API 的响应形状 / 限流行为 / 本仓库当前到底有没有 release」未经真机验证。404 降级路径已用
  stub 覆盖；若仓库尚无 release，真机应表现为「页面零提示」；
- **真实 UA 是否被 GitHub 接受**、以及 `publishedAt` 的真实格式，只按 API 文档实现并用 stub 断言；
- **多进程 / 多 profile 下的偏好文件并发写**未验证：写是原子的单文件 `rename`，但两个进程同时改会
  last-wins；这是「一个本机偏好」的合理语义，未加锁；
- 客户端 `localStorage` 失效路径（隐私模式抛错 / 配额满）只做了 `try/catch` 兜底，**没有**在真实浏览器
  里验证过（vm 沙箱里以「没有 `localStorage`」和「假实现」两种形态覆盖）。

### 八、复核收口（att-001 第二轮：必修 1 / 必修 2 / 文档如实化）

复核结论 PASS + 1 必修 + 1 建议必修 + 1 文档如实化。三件都做，**未削弱任何既有断言**；其中「把
`updateUnknown` 渲染条件从 `phase === 'error'` 改到 `hasUpdate === null`」是**收紧**（见下），已在
本节记明。

**必修 1｜`updateUnknown` 挂错了条件（真实缺陷，已修）**

- 缺陷：文案原来只在 `enabled && phase === 'error'`（**检查失败**）时渲染，而它写的四件事
  （404 无 release / 无 `tag_name` / tag 不可解析 / `current` 不可解析）都是 `hasUpdate:null`
  这一**成功但无法判定**的上游事实 —— 该解释的没解释，不该解释的网络失败反而显示「上游没有可用
  版本信息」，把「上游还没发 release」误读成「插件连不上」；
- 修法：`update` state 新增 `check`（**最后一次成功**的 payload），`renderUpdateSetting` 按
  `check.hasUpdate` 分三态渲染 —— `true` ⇒ 版本行（`data-update-state="available"` /
  `data-update-known`）、`null` ⇒ 中性说明行（`data-update-state="unknown"` /
  `data-update-unknown="true"`）、`false` ⇒ 不渲染；检查失败只置 `phase='error'`，**不覆盖 `check`、
  也不新增任何红字**（主页面零提示零红字不变，「高级」里也没有新增错误行）；
- 这是**收紧而非放宽**：原来那条错误条件被替换成更准确的条件，且新增断言把两态**都**钉死
  （`client.test.mjs`：① 404 桩 ⇒ 出现 `updateUnknown`；② 网络失败桩 ⇒ **不**出现、且无任何
  `data-update-state` 行、`data-notice="error"` 计数 0；③ 有更新 ⇒ 只有 `available` 行；④ 已最新 ⇒
  无状态行）。既有断言一条未改、一条未删。

**建议必修 2｜缓存年龄负值守卫（已修）**

- 缺陷：`now` 是可注入的，时钟回拨（NTP 校正 / 手工改时间 / 测试假时钟）会让
  `now() - cache.at` 为负，仍满足 `< ttlMs`，于是一条陈旧答案会被判「新鲜」**永久**；
- 修法：`const age = cache === null ? null : now() - cache.at;`，命中条件收紧为
  `age >= 0 && age < ttlMs`（`force` 语义不变）。方向选择：时钟非单调时视为**不新鲜** ——
  多一次请求远比一条永不过期的答案便宜；
- 新用例 `update: a clock that steps backwards does not make a cache eternal`：`now` 1000000 →
  0 后第二次 `check()` 必须 `cached:false`、`ok:true` 且外呼数 = 2。

**文档如实化 3｜两条已知取舍写进契约与记录**

- **prerelease 简化**（`CONTRACT.md` §17.2）：`parseSemver` 只看核心三段 ⇒ `1.0.0` 与
  `1.0.0-rc.1` 判**相等**（`hasUpdate:false`）。这是**漏报**而非误报；「绝不误报有更新」优先于
  「绝不漏报」，且 `/releases/latest` 上游天然排除 prerelease、本包发的是正式版，要做全序就得为
  数据源产生不出来的情形实现完整 semver 优先级 —— 已写明这条推理；
- **镜像漂移**（`CONTRACT.md` §13.9 + 本节）：`localStorage` 镜像为 `off` 而宿主
  `preferences.json` 为 `true`（外部手改 / 换浏览器）时，「高级」显示「已关闭」直到用户点一次；
  页面不为此在挂载时多发一个请求对账 —— **零请求优先于显示一致**，且两个漂移方向都不可能造成
  不该发的外呼（镜像 off：页面什么都不发；镜像 on/缺失而文件 false：请求由宿主短路，零外呼并把
  `enabled:false` 回填镜像）。

**本轮实测证据**（包目录 `packages/dsh-prompt-setting/` 下执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **534 / 534 pass / 0 fail**（exit 0；上一轮 532，本轮 +2：客户端三态用例 1、时钟回拨 1） |
| 必修 1 两态 | `--test-name-pattern="explains an undecided upstream answer"` | ① 404 桩 ⇒ `data-update-unknown="true"` + `data-update-state="unknown"` + 文案命中；② 网络失败桩 ⇒ 无该节点、无任何 `data-update-state`、`data-notice="error"` 计数 0；③ 有更新 ⇒ `data-update-known="0.9.9"` = `available`；④ 已最新 ⇒ 无状态行 |
| 必修 2 回拨 | `--test-name-pattern="clock that steps backwards"` | 时钟 1000000 → 0 后 `cached:false`、`ok:true`、外呼数 2 |
| 新增宿主套件 | `node --test test/update.test.mjs` | **35 / 35 pass / 0 fail** |
| 新增客户端套件 | `node --test test/client.test.mjs` | **133 / 133 pass / 0 fail** |
| **改坏就红 D**（文案条件改回旧错法） | 备份后把 `undecided` 改回 `enabled && u.phase === 'error'`，跑 `test/client.test.mjs` | **132 pass / 1 fail**（新两态用例红）；`cp` 还原后 133/133 |
| **改坏就红 E**（删年龄守卫） | 备份后把命中条件改回 `age < ttlMs`，跑 `test/update.test.mjs` | **34 pass / 1 fail**（回拨用例红）；`cp` 还原后 35/35 |

**本轮未验证项（增量）**：镜像漂移的两种方向仍只在 vm 沙箱 + stub 下断言（`localStorage` 假实现 /
无 `localStorage`），未在真实浏览器里手改 `preferences.json` 复现；真机目视仍待宿主半重启（见 §106 七）。

## 107. 「立即更新」：宿主经官方 `pluginManager` 装 Release tarball，永不自动重启（g-032，2026-10-04，基线 `8624978` 工作区）

### 一、要解决的问题

g-030（§106）只做到「告知有新版本」；负责人 2026-10-03 要求加「立即更新」：**由宿主经官方插件
管理器安装新版本，不自动重启**，装完提示用户手动重启 `dsh web` 生效。三张台账卡片
（`shared-149506f4` 官方 API、`shared-a11bad1f` git 安装实测、`shared-cab1058d` tarball 实测）
是设计输入，本节的结论全部建立在它们之上。

### 二、被否方案

- **A2/A3（`link:` 允许被覆盖 / 先卸载再装）**：A2 会把开发者的 `link:` 换成 registry 版本且没有
  回头路；A3 在 live 下卸载正在运行的自身。两者都否，取 **A1 拒绝执行 + 手动指引**（负责人
  2026-10-04 决定，`CONTRACT.md` §18.1）。
- **git spec（`github:…#<tag>&path:packages/dsh-prompt-setting`）**：pnpm 12.3.4 实测 exit=0，
  但会命中 **git 获取路径专属**的 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 构建审批门禁；且 pnpm 12
  失败后不写占位值，DSH 的 `build-approval.js` 只识别 pnpm 11 写的占位 ⇒ 审批回路抛
  `stale-approval`，**首次必失败且无法通过对话批准自愈**（卡片 `shared-a11bad1f`）。否。
- **传 `approvedBuilds`**：写 profile 的 `allowBuilds` 会让**后续** install 执行任意包脚本。永远
  不传（`CONTRACT.md` §18.1）。tarball 路线本来也不需要它。
- **在路由里 `await installBundle`**：单次最长「约 2 分钟等锁 + 10 分钟静默超时」，设置页不能挂
  一个请求这么久。改为「发起即返回 `requestId`」，状态存宿主自己的表（官方 settle 后
  `installs.delete(requestId)`，结果不保留）。
- **`enabled: false`（官方 GUI 新建安装的写法）**：见下节，语义不对。
- **服务放进 `inject`**：`inject` 是硬依赖，服务缺失会让整个插件（含既有的 7 条路由）不加载。
  判据 1 要的是「优雅降级」，所以走 `ctx.get('pluginManager')` 可选查找——**既有三服务
  `webServer`/`connection`/`systemPrompt` 一字未动**。

### 三、`installBundle` 的 `enabled` 对「已存在 bundle」的语义（判据 4，读源码确认）

读 `@deepseek-ai/dsh-plugin-manager@0.2.0-rc.2` 的 `lib/index.js`（`installBundle`，
`:1691-1813`）：

```js
return this.configure(async () => {
  if (options?.enabled !== false) await this.selectBundle(name, true);
  if (Object.hasOwn(before, name)) return 'restart-required';
  if (options?.enabled !== false) result.warnings = await this.reload();
});
```

三条事实：

1. `before` 是**安装前**的 profile `dependencies`。我们升级的 bundle 必然已存在 ⇒
   `Object.hasOwn(before, name)` 为真 ⇒ 返回 `'restart-required'`，**且不会执行 `reload()`**；
2. 所以对「已存在 bundle」这个场景，`enabled: true|false` 对**结果**没有影响
   （`selectBundle` 把已选中的 bundle 再选一次是 no-op，`change()` 里
   `JSON.stringify(previous) === JSON.stringify(bundles)` 直接 return）；
3. 传 `enabled: true` 是**保守值**：它显式表达「这个 bundle 现在就装在这个 profile 里、且要保持
   被选中」，而 `false` 表达的是「装完先别选」（官方 GUI 新建安装的语义——它随后用
   `setBundleEnabled(name, true)` 真正启用）。我们没有任何理由让一个正在运行的 bundle 走
   「先不选」这条路径，所以取 `true`，并在测试里把
   `Object.keys(options).sort() === ['enabled', 'requestId']` 钉死——既证明补丁永远不发
   `approvedBuilds`，也证明参数集是**只有**这两个。

### 四、profile 目录与 A1 检测

`installBundle` 自己**不查已安装**、`inspect` 对已安装包必然拒绝（`already-installed`），所以
「这个 profile 是 `link:` 吗」只能自己看。读的是 **manager 服务实例上的**
`service.profile.dir`（`lib/index.js:1383` `this.profile = ctx.profileContext`）下的
`package.json` 的 `dependencies['dsh-prompt-setting']`——**不是** DSH 的 `pluginContext` 类型字段，
所以这里做了 duck-typing：拿不到 `dir` 就**保守拒绝**（`installer-unavailable`），而不是「检测不了
就当它是安全的」。检测不到就放行会让 A1 在降级场景下静默失效。

`core/install.js` 的 `isLocalSpec` 覆盖 `link:`/`file:`/`portal:`/`workspace:` 前缀、`/abs`、
`./rel`、`../rel` 和 Windows 盘符；`core` 不做 IO，读文件在 `index.js`。

### 五、状态形状与「谁说了算」

- 宿主端 `phase` 是更细的步骤（`installing`/`cancelling`/…），客户端分支用的 `status` 是
  `running`/`done`/`failed`/`cancelled`/`unknown`。**页面按 `status` 分支**，`phase` 只进
  `data-update-apply-phase` 标记（初版曾把它塞进一个叫 `data-update-apply-step` 的标记，语义与命名
  都不对齐；复核后统一，见 §九 必修 4）。这条是被测试逼出来的：页面最初按 `phase` 分支，而宿主返回的
  `phase` 是 `installing` ⇒ 每个「运行中」都掉进失败的 else 分支。两个名字不许互换角色，
  所以分支依据只留一个；
- 客户端自建的失败态（网络层失败、结构化拒绝）也**补全成宿主的形状**
  （`status`/`phase`/`requestId`/`version`/`tag`/`error`），这样 `renderUpdateApplyStatus` 只有
  一种输入形状；
- `requestJson` 把「body 的 `ok` 不是 `true`」一律归为失败 ⇒ 结构化拒绝走的是 `!result.ok`
  分支，`error.message` 就是宿主那句人话。**顺带修了一个会误导用户的点**：这条分支原先只渲染
  `errorText`，于是拒绝文案会显示成 `error.development-link`（英文键回落到 key）。现在优先用
  宿主 message，并且把 `manual` 一并透传（`error.manual`），否则重新探测失败分支的「手动更新」
  链接会丢；
- 沙箱里没有 `sessionStorage` 时，resume 会静默失效——所以读写都包了 `typeof` 守卫 + `try`。

### 六、发布流程新增一步 + 长期约束（必读）

> **每个 release 必须上传 `npm pack` 产物资产，命名固定
> `dsh-prompt-setting-<version>.tgz`。**

做法（**切勿在包目录里跑 `npm pack`**，否则会把 `test/`、`.dsh-graph/` 等一起打进去）：

```bash
git archive <commit> packages/dsh-prompt-setting | tar -x -C /tmp/pkg-export
cd /tmp/pkg-export/packages/dsh-prompt-setting && npm pack
gh release upload <tag> dsh-prompt-setting-<version>.tgz
```

- **本包不得新增 `postinstall`/`install` 脚本**：带它们的 tarball 会被
  `ERR_PNPM_IGNORED_BUILDS` 拦成 exit≠0（实测）。`prepare` 维持原样——tarball 路线不执行它；
- **当前 release `0.1.1` 的 assets=0**，所以对本机 0.1.1 按按钮必然走
  「**资产缺失（404）**」分支。这是**预期行为**，不是缺陷：该分支有独立 code（`asset-missing`）、
  独立文案、独立断言（`test/install.test.mjs`「a release with no asset fails as asset-missing」），
  并且**不调用 pnpm**——预检 `HEAD` 让这个答案在秒级返回，而不是等两分钟 pnpm 失败。

### 七、本轮实测证据（包目录 `packages/dsh-prompt-setting/` 下执行）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **564 / 564 pass / 0 fail**（exit 0；基线 534，本轮 +30：新增 `test/install.test.mjs` 22 条、`test/client.test.mjs` +7 条、前缀请求预期 +1 条） |
| 新增宿主+策略套件 | `node --test test/install.test.mjs` | **22 / 22 pass / 0 fail** |
| 客户端套件 | `node --test test/client.test.mjs` | **140 / 140 pass / 0 fail** |
| 更新套件（回归） | `node --test test/update.test.mjs` | **35 / 35 pass / 0 fail**（`latestTag` 为新增字段，旧字段形状未变） |
| **改坏就红 A**（A1 放行） | 备份后把 `resolveInstallPolicy` 的 `if (current.local)` 改成 `if (false && current.local)`，跑 `test/install.test.mjs` | **20 pass / 2 fail**（「A1 — a link:/path install is refused」与「a link: profile is refused with a manual route」红）；`cp` 还原后 22/22 |
| **改坏就红 B**（失败分类归零） | 备份后让 `classifyInstallFailure` 开头直接 `return INSTALL_FAILURE_UNKNOWN`，跑 `test/install.test.mjs` | **18 pass / 4 fail**（分类总用例、manager code 保留、asset-unverified、失败结果结算四条红）；`cp` 还原后 22/22 |
| **改坏就红 C**（补丁加 `approvedBuilds`） | 备份后往 `installBundle` 的 options 里塞 `approvedBuilds: []`，跑 `test/install.test.mjs` | **21 pass / 1 fail**（「approvedBuilds is never passed」红）；`cp` 还原后 22/22 |

### 八、未验证项（诚实清单）

- **真机端到端未跑**：本机 profile 是 `link:`（web 与 desktop 两个 profile 都是），按 A1 必然
  拒绝；且**禁用装 profile 的约束**下没有在真机跑 `installBundle`。所以
  「tarball 装完 profile 里真的变成 `0.1.2`」这条链路的最后一跳**没有真机证据**，只有
  「spec 形态 + tarball 免审批 + 产物干净有效」的实测（卡片 `shared-cab1058d`）；
- **`0.1.1` 无资产 ⇒ 没有一次成功的真 HTTPS 资产安装**。补资产后需要真机复跑一次，确认
  `asset-missing` 分支消失；
- **`link:` 检测依赖 `service.profile.dir`**：官方服务的内部字段，未在任何官方类型里承诺。它被
  包了 duck-typing + 保守拒绝，但官方改字段名时**只会降级成「一律拒绝并提示手动更新」**，
  不会误放行——这是刻意选的方向；
- **`cancelling` 的竞态只用桩覆盖**：真实 `pnpm add` 被 abort 后 `change()` 返回 `cancelled`
  这条路径没有真机跑过（桩里返回 `cancelled`/`restart-required` 两种）；
- **页面轮询的最坏路径未在真机验证**：16 分钟预算内一直 `running` 的体验（比如等锁 2 分钟）只在
  桩里模拟过状态转换，没有真机观察；
- **`HEAD` 预检对某些 CDN 的可能行为**：GitHub release 资产对 `HEAD` 返回 200/404 已按语义断言，
  但真实网络下的重定向/限流未实测。⚠️ **本条已被复核推翻并修正**（见 §九 必修 1）：初版把预检的
  任何 ≥400 都当拒绝，实测 `500`/`429`/`405` 会误拦可安装的更新；现在只有 `404`/`410`/`401`/`403`
  拒绝，其余一律继续交给 pnpm。

### 九、独立只读复核收口（2026-10-04，5 条必修 + 2 条顺手）

复核结论 BLOCK（11 条判据中 8=BLOCK）。逐条修复，并**全部先写红用例再改产品代码**
（每条都能复现旧行为）：

1. **预检把「探针自己失败」当成拒绝（B1，已修）**：旧代码
   `if (probe.status !== 0 && probe.ok !== true && probe.status >= 400)` 会把 `500`/`429`/`405`
   结算成 `failed`、`error.code='unknown'`、**`installBundle` 调用 0 次**，而 `unknown` 的文案还
   声称「the profile files were restored」——实际什么都没跑。这与 `CONTRACT.md` §18.2 自己写的
   「a probe that cannot answer (no fetch, a throw, a 5xx) is not a refusal」**直接矛盾**，也把可安装
   的更新挡死。现收窄为 **`404`/`410` ⇒ `asset-missing`**、**`401`/`403` ⇒ `asset-unverified`**，
   **其余一律按「无答案」继续交给 pnpm**（含 `500`/`429`/`405`/抛错/无 `fetch`）。探针是捷径不是门禁。
   用例：`assetStatus: 500 / 429 / 405` 与「探针抛错」四种 ⇒ 断言 `manager.calls.length === 1`、
   最终 `phase='done'`、`application='restart-required'`、`error===null`。
2. **A1 检测失败默认放行（B2，已修）**：`installDependencyField` 对「manifest 存在但不可读/非法
   JSON」返回 `{value:null, error}`，而调用点只取 `value` ⇒ 被当成「profile 未声明该包」⇒ **放行**
   ⇒ 在一个从未被检查过的 profile 上执行安装。现在 `resolveInstallPolicy` 新增 `fieldError` 入参，
   **非空即拒绝**（`installer-unavailable`，文案含「could not be read / nothing was installed」）；
   `ENOENT`（文件不存在）仍返回 `error:null` ⇒ 继续放行，语义是「profile 真的没声明这个包」。
   用例：非法 JSON ⇒ `ok:false` + `installer-unavailable` + `manager.calls.length===0`；
   删掉 manifest ⇒ `ok:true` 且装成功（两侧都在）。
3. **客户端 resume 覆盖最终态（B3，已修）**：remembered 查询得到非 running 后再发裸 `GET`，而宿主的
   裸 `GET` **只答 live** ⇒ 返回 `null` ⇒ 无条件覆盖掉 remembered 的 `done` ⇒ 页面丢掉「已安装
   vX.Y.Z，请手动重启」，反而回到「立即更新」按钮。现在只在**新答案非空**时覆盖
   （`status = fresh ?? status`）。用例：预置 sessionStorage id + `?requestId=` 答 `done` + 裸 GET 答
   `null` ⇒ 断言出现「已安装 v0.9.9 / 手动重启 dsh web」且 `data-action=update-apply` 计数 **0**。
4. **契约与实现不一致（note 1，已修）**：`data-update-apply` 实际取 `apply.phase`（`installing`…），
   而 §18.7 写它等于 `status`（`running`…）⇒ 运行态两套说法。现统一为：
   `data-update-apply` = **status**（与页面分支一致）、`data-update-apply-status` = status（状态行上）、
   `data-update-apply-phase` = **phase**；删掉冗余的 `data-update-apply-step`。§18.3/§18.7 同步改写，
   并写明「status 与 phase 是两个事实的两个名字，永不互换」。
5. **运行中安装失去取消入口（note 3，已修）**：开关关闭时「高级」卡被 `latest === null || !enabled`
   挡住，而安装仍在跑，且 banner 也不渲染 ⇒ **全页面没有任何取消入口**。现在**存在活跃安装优先于
   开关状态**（`(u.apply ?? null) === null && (latest === null || !enabled)` 才不渲染）——开关只门禁
   「发起安装」的按钮，不门禁「已经在跑的那个」。用例走真实路径：开关打开 → 有 running ⇒ 关掉开关
   ⇒ 断言「高级」卡仍有 1 个取消控件、banner 归零、且不重新提供第二个安装按钮。
6. **顺手：`latestTag` 是死参数（note 2，已删）**：`requestUpdateApply(latest, latestTag)` 的第二个参数
   从未被读（确认时重新从 `update.data` 取 tag，这正是「过期点击不会装错版本」的机制）。签名收成单参。
7. **顺手：两条 import 挤在一行（note 4，已拆）**：`} from './core/update.js';import {` 拆成两行。
8. **顺手（复核未提，自查发现）**：删掉 `index.js` 里 5 个**未被使用**的 `core/install.js` 导入
   （`REFUSAL_DEVELOPMENT_LINK`/`REFUSAL_NO_UPDATE`/`buildReleaseAssetUrl`/`describeInstalledSpec`/
   `releasePageForTag`——它们在 `core/` 内部消费，`index.js` 只透传 code）；并把 banner 边框色的判据
   从 `settled && apply.phase === 'failed'` 统一到 `step === 'failed'`，删掉随之失效的 `settled` 变量。
   两处都不改行为（测试全绿且无断言调整）。

**顺带收紧的一处产品行为（由必修 3 的用例逼出）**：`done`（`restart-required`）**且已装版本 === 提示
版本**时不再渲染「立即更新」按钮——按钮装的东西和盘上已有的东西相同时，用户会怀疑自己点了两次；
而当上游发布**更新的**版本（`installedVersion !== latest`）时按钮自动回来，所以没有丢失能力。
契约 §18.7 已写明。

**复核后的实测证据**

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **572 / 572 pass / 0 fail**（复核前 564；必修轮 +5：探针无答案 1、不可读 manifest 1、缺 manifest 1、remembered-done 1、开关关闭后仍可控 1；note 收尾轮 +3：410 1、401 1、§18.7 枚举守卫 1） |
| `test/install.test.mjs` | `node --test test/install.test.mjs` | **27 / 27 pass / 0 fail**（复核前 22；必修轮 +3，note 收尾轮 +2：`410 ⇒ asset-missing`、`401 ⇒ asset-unverified`） |
| `test/client.test.mjs` | `node --test test/client.test.mjs` | **144 / 144 pass / 0 fail**（复核前 140；必修轮 +3，note 收尾轮 +1：§18.7 三处标记枚举的守卫） |
| **改坏就红 D**（探针 5xx 当拒绝） | 把预检拒绝条件还原成 `probe.status >= 400` ⇒ 跑 `test/install.test.mjs` | 「a probe that cannot answer is not a refusal」红（`manager.calls.length` 0 ≠ 1）；`cp` 还原后 25/25 |
| **改坏就红 E**（忽略 fieldError） | 把 `fieldError` 传参去掉 ⇒ 跑 `test/install.test.mjs` | 「an unreadable profile manifest refuses instead of installing blind」红（`ok:true` ≠ `ok:false`）；`cp` 还原后 25/25 |
| **改坏就红 F**（resume 无条件覆盖） | 把 `status = fresh ?? status` 还原成 `status = fresh` ⇒ 跑 `test/client.test.mjs` | 「a remembered finished install keeps its verdict」红（按钮计数 1 ≠ 0）；`cp` 还原后 143/143 |
| **改坏就红 G**（开关门禁运行态） | 把渲染条件还原成 `latest === null \|\| !enabled` ⇒ 跑 `test/client.test.mjs` | 「a live install keeps its controls after the update switch is turned off」红（取消计数 0 ≠ 1）；`cp` 还原后 143/143 |
| **改坏就红 H**（去掉 410 拒绝） | 把预检条件改成 `probe.status === 404` ⇒ 跑 `test/install.test.mjs` | 「410 (gone) is the same "the asset is not there" as 404」红（26/1）；`cp` 还原后 27/27 |
| **改坏就红 I**（去掉 401 拒绝） | 把预检条件改成 `probe.status === 403` ⇒ 跑 `test/install.test.mjs` | 「401 (not fetchable anonymously) is unverified, not missing」红（26/1）；`cp` 还原后 27/27 |
| **改坏就红 J**（phase 标记输出契约外的值） | 把 `data-update-apply-phase` 改成输出 `apply.status` ⇒ 跑 `test/client.test.mjs` | 「every install marker carries a value the contract enumerates」红（0/1）；`cp` 还原后 144/144 |

### 九之二、note 级收尾（复核 PASS 后，2026-10-04）

复核结论 PASS（B1/B2/B3 三个 blocker 全 closed），剩 3 条 note 级收尾，同一 worktree 一次做完：

1. **补两条保守分支用例（note 1）**：`404`/`403` 原有覆盖，但 `410`（资产被删的形态）与 `401`
   （不可匿名获取）只有桩证据。新增两条独立用例（不合并进既有用例，保留各自可单独变红的能力）：
   `assetStatus: 410 ⇒ code='asset-missing'` 且 `manager.calls.length===0`；`assetStatus: 401 ⇒
   code='asset-unverified'` 且 `manager.calls.length===0`；两条都断言 `diagnostic` 含对应状态码。
   对照 H/I：把 410（或 401）从拒绝条件里去掉 ⇒ 对应用例各自变红。
2. **补齐 CONTRACT 三处枚举（note 3）**：① 拒绝码表 `asset-missing` 由 `(404)` 补成 `(404/410)`
   （与散文 `:3379` 及实现一致），并把同表 `asset-unverified` 的 `a 401/403` 改成反引号
   `(401/403)`；② §18.7 三行标记的枚举**逐字对齐实现**——`data-update-apply` =
   `idle` + `running/done/failed/cancelled/unknown`（并注明「无 `status` 时回落 `phase`」这个防御性兜底，
   宿主总会给 `status`）、`data-update-apply-status` = 同样五值（并注明该行只在有安装时渲染，
   所以 `idle` 永远不会出现在这里）、`data-update-apply-phase` =
   `installing/cancelling/done/failed/cancelled/unknown`。③ 为让「complete」这个词可验证，新增
   `test/client.test.mjs`「every install marker carries a value the contract enumerates」：遍历五种
   `status` 渲染，断言三个标记的取值都落在契约枚举内、`idle` 只属于 banner、且 banner 与状态行的
   `status` 永远相等。对照 J：把 phase 标记改成输出 `status` ⇒ 该守卫红。
3. **把一条已知边界写进 NOTES（note 2，不改代码）**：见下节「十、已知边界」。

### 九之三、真机缺陷：重复点击「立即更新」被报成「安装失败」（2026-10-04，桌面版，负责人实测）

**现象**（负责人，桌面版，release 产物安装后点「立即更新」）：

> 安装失败：the install failed and the reason could not be classified; the profile files were restored. Update by hand

**已核实的事实**（勿再猜）：
- `~/.dsh/profiles/desktop/package.json` 的 `dependencies['dsh-prompt-setting']` =
  `https://github.com/zangxx66/dsh-prompt-setting/releases/download/0.1.1/dsh-prompt-setting-0.1.1.tgz`
  （**非 `link:`** ⇒ A1 正确地放行了）；
- `~/.dsh/profiles/desktop/node_modules/dsh-prompt-setting/package.json` 的 `version = 0.1.1`；
- 即：**安装目标 spec 与 profile 里已装的 spec 完全相同**。

**根因（源码定位）**：`pnpm add <与已装完全相同的 spec>` 之后依赖没有任何变化 ⇒ 官方
`dsh-plugin-manager/lib/index.js:1782` 找不到「那一个新增依赖」：

```js
if (installed.length !== 1 || target === void 0) throw new ManagementFailure("ambiguous-install");
```

而当时我们的 `classifyInstallFailure` **只看 `PackageResult.kind`**（pnpm 对失败 run 的分类），
完全没看 `changeResult.error.code`（官方 `ManagementError.code`）⇒ `ambiguous-install` 落到
`unknown` ⇒ 文案「the reason could not be classified」；并且 `unknown` 的模板里还写着
「the profile files were restored」——在我们**什么都没改**的情况下，两处都不实。

**三条修复**：

1. **同 spec 前置短路（产品行为）**：发起安装前，用 A1 已经在读的 `installDependencyField` 取当前
   spec，与本次目标 URL **逐字比较**（`isAlreadyInstalledOn`，比较前 trim 首尾空白）。
   相等 ⇒ **不调用 `installBundle`**，直接在状态表里 `begin` + `settle({application:'restart-required'})`，
   返回 `{ok:true, alreadyInstalled:true, status:{phase:'done',…,restartRequired:true}}`；客户端识别
   `alreadyInstalled` 后**不轮询**，直接显示「该版本已安装（vX.Y.Z），请手动重启 dsh web 生效」。
   不等（旧 tarball URL / semver / registry 范围 / `link:`）⇒ 照常安装。
   理由：官方对「无变化」的安装**必然**抛 `ambiguous-install`，把用户预期内的第二次点击变成「失败」既
   误导、又白花一次 pnpm 往返（秒级，锁竞争下可达分钟级）。
2. **分类表覆盖官方全部 `ManagementError.code`（12 个）**：`management-required` / `unaddressable` /
   `unknown-plugin` / `invalid-spec` / `ambiguous-install` / `not-bundle` / `not-removable` /
   `stop-profile` / `bundle-in-use` / `stale-approval` / `incompatible-version` / `operation-error`
   （前两个来自 `ReadOnlyReason`，其余十个见 `lib/types/types.d.ts:19`）。分类**顺序**也改了：
   probe 事实 → **官方 code** → pnpm `kind` → 日志文本 → 兜底。官方 code 提到文本匹配之前，是为了
   避免 `stale-approval` 的 diagnostic 里出现 `prepare` 就被读成 `build-blocked`。
   `operation-error` 是**包装**而非原因（官方把非 `ManagementFailure` 的错误包进它），所以它**不**
   作为最终 code，继续下钻到 pnpm 的 `kind`/日志。
3. **不再谎称 restored**：只有在官方**确实执行过回滚**的失败（`timeout` 与 pnpm run 失败）才提
   「文件已还原」；全部 management code 的文案（含什么都没改的 `ambiguous-install`）都不提。
   `unknown` 的兜底文案也换掉了「could not be classified」，改为如实说明
   「the install failed and the host reported no reason for it; update by hand」——它只在**两个来源
   都没有信息**时可达。
   顺带：客户端「重试」按钮现在按 host 给出的 `error.retryable` 门禁（不可重试的失败不给重试按钮）。

**本轮实测证据**

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 | `node --test` | **579 / 579 pass / 0 fail**（上一轮 572，本轮 +7：同 spec 短路 1、旧 spec 仍安装 1、12 个官方 code 的映射与文案 1、operation-error 下钻 1、非包装 code 优先 1、`isAlreadyInstalledOn` 纯策略 1、客户端 already-installed 1） |
| `test/install.test.mjs` | `node --test test/install.test.mjs` | **33 / 33 pass / 0 fail**（27 → 33） |
| `test/client.test.mjs` | `node --test test/client.test.mjs` | **145 / 145 pass / 0 fail**（144 → 145） |
| **改坏就红 K**（去掉同 spec 短路） | 把 `if (isAlreadyInstalledOn(…))` 改成 `if (false && …)` ⇒ 跑 `test/install.test.mjs` | **32 / 1**，红在「a profile already holding the target asset answers success, not ambiguous-install」；`cp` 还原后 33/33 |
| **改坏就红 L**（把 `ambiguous-install` 从分类表移除） | 在 `classifyInstallFailure` 的官方 code 分支排除 `ambiguous-install` ⇒ 跑 `test/install.test.mjs` | **32 / 1**，红在「an official management failure is named, never "could not be classified"」（断言的是**映射后**的 `error.code`，所以"只看 raw code"骗不过它）；`cp` 还原后 33/33 |

**契约同步**：`CONTRACT.md` §18.2 新增「同 spec ⇒ `alreadyInstalled: true` + `done`/`restart-required`」
整段（含 `:1782` 行号与「不同 spec 照常安装」）；§18.4 补「`already-installed` 行创建即 settle，
所以对它的取消是 `not-running`」；§18.6 重写为「两个来源 + 五级顺序 + 12 个官方 code 全表 +
关于回滚的措辞规则 + `unknown` 只说它自己」，并把「重试按钮」与 `retryable` 绑定。

### 十、已知边界（复核 note 2）：`installedVersion === latest` 依赖宿主 `version` 是**规范化版本**

「已装版本 === 提示版本时隐藏『立即更新』」这条收紧（§九 末尾）比较的是
`apply.version`（来自宿主 `publicInstallStatus` 的 `version` 字段）与 `update.data.latest`
（`core/update.js` 的 `formatSemver` 规范化结果）。宿主侧的 `version` 取自
`resolveInstallTarget`，那里填的是 **`payload.latest`**——也就是同一个规范化版本
（`core/install.js` 的 `resolveInstallTarget`：`version = payload.latest.trim()`，
而 `tag` 才可能是原样的 `v0.1.2`）。

**边界与触发条件**：若将来有人把 `resolveInstallTarget` 的 `version` 改成上报 **tag 原样**
（例如图省事写成 `version: tag`，于是 `v0.1.2` 而不只是 `0.1.2`），那么
`installedVersion === latest` 会永远为假 ⇒ 按钮**静默重新出现**（已装版本又被提供一次），
**而现有断言不会红**：`test/client.test.mjs` 的用例用的是**同一个** fixture 值走两条路径，
两边同时变成 `v0.9.9` 也仍然相等，所以测试照旧全绿。

**改 `version` 语义时必须同步的断言**（提醒）：
1. `test/client.test.mjs`「a remembered finished install keeps its verdict, and never re-offers the button」
   与「every install marker carries a value the contract enumerates」——两处的 fixture 要让
   `version`（= `latest`）与 `latestTag`（= `v0.1.2`）**故意不同**，隐藏逻辑才会被真正检验；
2. `test/install.test.mjs` 的 tarball URL 断言（`/download/<tag>/dsh-prompt-setting-<version>.tgz`）
   已经刻意区分了二者（`v0.2.0` 的 tag 配 `0.2.0` 的 version），改语义会先在那里红。

**复核后仍未验证项（增量）**：与 §107 八相同（真机端到端未跑、`0.1.1` 无资产、`cancelling` 竞态仅桩、
轮询最坏路径未真机观察、`HEAD` 预检在真实 CDN 重定向/限流下未实测）。**新增一条**：预检对 `401/403`
判 `asset-unverified` 的分支只有桩证据——GitHub 对不存在的 release 资产实际答 `404`，私有/受限资产
才会 `403`，本仓库的 release 都是公开的，所以这条路径在真机上可能永远不会走到（保守分支）。

## 108. 版本号 `0.1.1` → `0.1.2`：同步点、白名单依据与两处过时表述修正（g-033，2026-10-04，基线 `8f54973`）

### 一、同步的「本包当前发布版本」（12 处）
- `package.json` 的 `version`、`index.js` 的 `PLUGIN_VERSION`；
- `CONTRACT.md`：§10 export 示例（`plugin.version` / `pluginVersion`）、§13.8 版本节点文案（`v0.1.2`）、
  §13.9 ping 示例的 `version`、§17 update-check 示例的 `current`；
- 两份根 README 的徽章与 CHANGELOG 行（`currently 0.1.2` / `当前 0.1.2`）；
- 测试硬字面量：`test/stage2.test.mjs` 的 export 断言 2 处、`test/client.test.mjs` 的 export fixture 2 处、
  update-check fixture 的 `current` 1 处、banner 渲染断言 `/0\.1\.2/` 1 处、`test/update.test.mjs` 的
  ping 版本断言 1 处。

### 二、白名单判断依据（一律未动）
- `CHANGELOG.md` 的 `[0.1.1]` / `[0.1.0]` 历史段、`NOTES.md` 历史叙述、`.dsh-graph/**`、
  `docs/prompt-variables.md`：历史记录。
- `test/update.test.mjs`：115 行 `currentVersion` 默认值、190–195 的 `compareSemver` / `isNewerVersion`、
  217 行回显断言、231 行的 tag 列表，**全部保留**。理由：它们是「注入的被检查版本 / semver 比较数据」，
  不是本包版本；且 231 行的 `'v0.1.1'` 依赖 115 的默认值才构成「**同版本** ⇒ 无更新」这条覆盖，
  改 115 会连带把它降级为「更旧」（与 `0.1.0` / `v0.0.9` 已有的覆盖重复）⇒ 属削弱断言，
  按「两可即保留」处理。
- `test/install.test.mjs`：`writeProfile({ 'dsh-prompt-setting': '0.1.1' })`、`tag_name: '0.1.1'`、
  `resolveInstallPolicy({ field: '0.1.1' })`、`isAlreadyInstalledOn('0.1.1', …)` 都是
  「模拟 profile 已装 spec / 旧 release」的夹具，保留。

### 三、过时表述修正（资产已补：`dsh-prompt-setting-0.1.1.tgz` = 391186 B，实测 200/404）
- `core/install.js:116`：「the 0.1.1 release has zero assets」→「a release published without an asset」；
- `core/install.js` `classifyInstallFailure` 的 asset-missing 段：「(0.1.1 had zero assets)」→
  「a release published without an asset（本特性从 release 资产安装，早于它的 release 未附资产）」；
- `index.js` `UPDATE_ASSET_PROBE_TIMEOUT_MS` 注释：「an asset-less release (0.1.1 has none)」→
  「a release published without an asset」；
- `test/install.test.mjs` 两处注释同样中性化（**只改叙述，未动任何 `0.1.1` 字面量、夹具与断言**）：
  原「The asset-less release: the expected outcome for 0.1.1.」与
  「The measured state of the published 0.1.1 release: zero assets.」；
- 复查中一并修掉的同类注释：`index.js` 的 `probeReleaseAsset` 与 `runInstall` 原有「the state every release
  published before this feature existed is in」从句——0.1.1 补资产后该全称判断同样不成立 ⇒ 已删去从句，
  只留「the release carries no such asset」。
- 已核对确为**中性、无需改**：`CONTRACT.md` §18.7 分类表（「a release with no asset — e.g. a release
  published before this feature」）、`client.js`（「when the release simply has no asset yet」）。

### 四、原两可项（负责人 2026-10-04 裁定后已处理）
- `core/install.js` `describeInstallFailure` 的 `asset-missing` 用户文案原为「Releases published before
  this feature existed carry no assets; the next release will」：负责人裁定**必修**——0.1.1 已补资产，
  该历史解释对它、也对未来「漏传资产的 release」都不成立，会把用户引向错误成因。已改为**中性、可操作、
  不假设历史**的中英双语表述（「check the release page for its assets, or try again later /
  这个版本没有可下载的安装包（`dsh-prompt-setting-<version>.tgz` 未随 release 提供）；请到 release 页面
  查看，或稍后重试」），`manual` 指引与 `retryable: true` 语义不变；`test/install.test.mjs` 相应加了
  「含可操作与重试指引 + 含中文 + **不含**旧历史解释」的断言（把旧句退回即红，见本节末对照）。
- `CHANGELOG.md` `[0.1.0]` 段 Notes 的「清单当前版本见上方的 `0.1.1` 条目 / the manifest now carries
  `0.1.1`」已随本次同步过时：负责人裁定**只改指向、不动历史事实** ⇒ 已改为指向 `0.1.2` 条目。
- `NOTES.md` §107 的「`0.1.1` 无资产」叙述按「历史留档」保留（当时的实测事实，白名单点名 NOTES 历史不改）。

### 五、`npm pack` 复核（`--cache` 指向工作区内，临时目录已清理）
- 产物 `dsh-prompt-setting-0.1.2.tgz`，**488186 B**，23 个条目；
- `test/` 命中 **0**；`core/install.js` **在包内**；`test/install.test.mjs` **不在包内**；
- 包内 `package.json` 的 `version` 与 `index.js` 的 `PLUGIN_VERSION` 均已是 `0.1.2`。

### 六、验收
- `cd packages/dsh-prompt-setting && node --test`：**579 pass / 0 fail**（与 0.1.1 基线 579 一致，无断言削弱）；
- 全仓 `0.1.1` 残留清单：仅白名单/夹具（见二），其余全部同步为 `0.1.2`。

### 七、收尾对照（负责人 2026-10-04 裁决的两项）
- **改坏就红**：把 `asset-missing` 文案退回旧句（「Releases published before this feature existed carry no
  assets…」）后，`node --test --test-name-pattern="failures are classified into the categories"` ⇒
  **17 tests / 1 fail**（`AssertionError: the sentence names the actionable route`）；还原新文案后全量
  **579 pass / 0 fail**（对比基线 579，无新增/削弱）。
- `CHANGELOG.md` `[0.1.0]` 段 Notes 的指向已由 `0.1.1` 改为 `0.1.2`（只改指向，历史事实与历史段内容未动）。

## 109. 时间戳按读者时区渲染：「快照生成时间」、版本历史的 `at` 与导出文件名（Revision 18，2026-10-05，基线 `1ce4444` 工作区）

### 一、问题（负责人 2026-10-05 提出，分两条指令）
- 宿主存与答的一律是 **UTC ISO 8601**（`new Date().toISOString()`）：`snapshot.generatedAt`（`index.js:1695`）、
  历史记录 `at`（`index.js` 五处写点：2856 / 2931 / 2975 / 3039 / 导入 2187）、`exportedAt`、`checkedAt`、
  安装的 `startedAt` / `finishedAt`；
- 客户端此前**原样回显**：`stampOf()` 只做 `T`→空格、去毫秒（保留 `Z`），`generatedAt` 连毫秒一起显示；
- 后果：UTC+8 的读者看到的时间比本地少 8 小时，而唯一的时区线索是末尾那个 `Z`——页面把「换算」与
  「Z 要不要紧」两件事都推给了读者。
- **第二条指令（同日补充）**：**导出文件名**也是时间戳（`exportFileName(document.exportedAt)`），用户存到
  磁盘的那个文件同样比本地少 8 小时 —— 页面上的时间全改了、留下的产物却仍是 UTC，正是最容易被忽略的一处。

### 二、改法（只动显示，两处消费点）
- `client.js` 新增 `localStampFormatter()`：惰性一次构建并缓存 `Intl.DateTimeFormat`，`timeZoneName` 按
  `shortOffset` → `short` → 无标签**三级降级**，任一构造失败都不抛；另留 `rawStamp()`（旧的 T/毫秒整理）
  作回退。`stampOf()` 改为在**浏览器自身时区**渲染 `YYYY-MM-DD HH:mm:ss GMT±h[:mm]`——例：
  `2024-01-02T10:00:00.000Z` ⇒ 东八区 `2024-01-02 18:00:00 GMT+8`。
- **形状固定、只有时区变**：骨架用 `formatToParts` 自行拼装，不跟随 locale（不做 12 小时制、不重排字段），
  因为逐读者不同的是时区、也只有时区；两人对照时读到的仍是同一骨架。
- **原始 UTC 串不丢**：两处消费点都把存储串挂到节点 `title`（`data-region="status-detail"` 的
  「快照生成时间」、`data-history-row` 的时间节点），与宿主日志核对仍是一次悬停。
- **降级而不抛**：解析不出的值走 `rawStamp()` 原样回显；无 `Intl`（或无 `timeZoneName`）回退到 UTC 串；
  非字符串 / 空串渲染为空——与替换前接受的输入集一致。
- **导出文件名（第二条指令）**：抽出 `localStampParts(at)`（`{date, time, zone}` 或 `null`）作为**唯一**解析路径，
  `stampOf()` 与 `exportFileName()` 共用 ⇒ 同一时刻在两处的时区不可能各说各话；文件名形如
  `dsh-prompt-setting-2026-10-05-21-30-00.json`（本地时区、定宽字段可字典序排序、`:` 折成 `-` 因 Windows 非法、
  **不带时区标签**——文件名不是解释时钟的地方，且 `+` 在文件名里本身可疑）。
  回退仍保留 Revision 18 之前的 UTC 拼写，使无 `Intl` 的引擎仍能命名文件而不是退化成 `export`。

### 三、明确未动（本轮范围之外）
- 任何线上字段、路由、落盘内容：宿主仍答 UTC ISO，历史文件仍是原字节；
- `?before=` 上界与排序（`seq` 降序 / `at < before`）继续用**存储串** ⇒ 读者机器的 `TZ` 不可能重排或隐藏
  任何一条记录；
- 导出**文档内容**（响应里的 `exportedAt` 字段本身）仍是 UTC ISO：本地化只发生在**命名**上，导入/校验读到的
  仍是标准形态；
- 时间戳的另一个用处（`clientBuild.mtime`、`checkedAt`、安装 `startedAt`/`finishedAt`）页面本就不展示，
  本轮未动。

### 四、测试与实测证据（包目录 `packages/dsh-prompt-setting/` 下执行）
- `test/client.test.mjs`：两处显示断言（「原样 ISO」）改为用本地 `Date` getter + `getTimezoneOffset`
  **独立推导**的期望值 `localStampOf()`——与实现走 `Intl` 是两条不同代码路径，故是断言而非镜像；并各加两条
  配套断言：原 UTC 串**不再**出现在可见文本、且仍以 `title` 形式可达（每处恰好 1 个节点）。
- 文件名侧三处断言同样改为独立推导的 `localFileNameOf()`：下载名（原 `assert.match` 正则 → `assert.equal`）、
  `data-export-name` 标记与 `downloadDone` 文案、英文横扫表项（提炼为共享常量 `EN_SWEEP_EXPORT_NAME`，
  避免同一期望值抄三遍）。
- 新增一条**降级用例**（`makePage({ withoutIntl: true })` 在 vm 沙箱里把 `Intl` 置 `undefined`）：显示串回退为
  存储的 UTC 形态（`2024-01-01 00:00:00Z`，既非空白、也非逐字 ISO），导出文件名回退为 Revision 18 之前的
  UTC 拼写而不是 `export.json` ⇒ 「无 `Intl` 降级」由代码审查升为**已验**。
- 跨时区实跑（`TZ=` 注入，四条用例：两条显示 + 导出下载 + 英文横扫）：`UTC` / `America/New_York` /
  `Asia/Kolkata` / `Pacific/Kiritimati` 四组均 **4 pass / 0 fail**（覆盖零偏移、负偏移、半小时偏移、+14）。
- 全量：`node --test` ⇒ **580 pass / 0 fail**（基线 579 + 本轮新增的降级用例 1 条；无断言削弱、无套件跳过）。
- **改坏就红（对照跑过，一次破坏覆盖三处）**：在 `localStampParts()` 开头早退 `return null`（= 显示与文件名
  同时退回 UTC 回显），`node --test --test-name-pattern="carries the full status|history panel renders records|exporting downloads|english render sweep"`
  ⇒ **0 pass / 4 fail**（`the generation timestamp…`、`the record timestamp…`、`the download is named…` 各一条
  + 英文横扫一条）；**在 `Asia/Shanghai` 与 `UTC` 两种时区下都是 4 红** ⇒ 断言靠在「本地化 vs UTC 原样」的
  形态差上，不依赖跑测机器恰好不在 UTC。还原后四组 TZ 复跑各 **4 pass / 0 fail**。

### 五、真机验收（2026-10-05，负责人目视，web GUI @ 127.0.0.1:3080）
- **三项全部 OK**：① 导出文件名；②「快照生成时间」；③ 版本历史各行时间。⇒ 本轮**没有**遗留的真机未验证项
  （原先「拿不到 token URL、未起无头 Chrome/CDP」的缺口由负责人目视补齐，见下条环境事实）。
- 宿主进程 `pid 12871`（13:51 启动、加载 0.1.2 代码）已退出，现为 `pid 35408` 启动于 `2026-10-05 15:59:41`，
  `lsof` 确认监听 `127.0.0.1:3080` —— 该时刻**晚于** `4d10d5f` / `6bffafc` 两个提交 ⇒ 页面跑的就是本分支代码。
- 生效路径：`web` profile 的 `node_modules/dsh-prompt-setting` 是**符号链接**指向本工作区，客户端半随
  `dsh-client-hmr` 的 stat 轮询热替换生效（刷新设置页即可，无需重启）；`desktop` profile 是 `0.1.2` 的
  **安装副本**，**不含**本版改动。

### 六、契约与文档
- `CONTRACT.md`：新增 **Revision 18** 段（三条落点：快照时间、历史行、**导出文件名**；含三级降级、`title`
  保留、文件名不带时区标签的理由、`before` 与排序不受影响）；§13.3 历史行 + 文件名、§13.4 `status-detail`
  各补一句指向；
- `client.js` 注释引用 Revision 18（`localStampParts` / `stampOf` / 两个消费点 / `exportFileName`）；
- `CHANGELOG.md`：新增 `[Unreleased]` 段（Changed），由 g-035 定稿为 `[0.1.3]`。

## 110. 版本号 `0.1.2` → `0.1.3`：同步点与白名单依据（g-035，2026-10-05，基线 `4d10d5f` 工作区）

### 一、同步的「本包当前发布版本」（15 处）
- `package.json` 的 `version`、`index.js` 的 `PLUGIN_VERSION`；
- `CONTRACT.md`：§10 export 示例 2 处（`plugin.version` / `pluginVersion`）、§13.8 版本节点文案（`v0.1.3`）、
  §13.9 ping 示例的 `version`、§17 update-check 示例的 `current`；
- 两份根 README：徽章各 1 处 + CHANGELOG 行表述各 1 处（`currently 0.1.3` / `当前 0.1.3`）；
- 测试硬字面量：`test/stage2.test.mjs` export 断言 2 处、`test/client.test.mjs` export fixture 2 处 +
  update-check fixture 的 `current` 1 处 + banner 渲染断言 `/0\.1\.3/` 1 处、`test/update.test.mjs` ping 断言 1 处。

### 二、白名单判断依据（一律未动）
- `CHANGELOG.md` 的 `[0.1.2]` 及更早历史段、`NOTES.md` 历史叙述、`.dsh-graph/**`、`docs/prompt-variables.md`：历史记录；
- `core/update.js:138/283`、`core/install.js:128`、`CONTRACT.md:3174/3328`：`v0.1.2` / `0.1.2` 在这里是
  **tag 形态与 canonicalize 的语法举例**（`v0.1.2` → `0.1.2`），不是「本包当前版本」；
- `core/install.js:172` 的「announce `0.1.3` and install `0.1.2`」：**故意让两个版本号不同**才说明
  「宣布的版本与安装的版本必须同源」；改成同一个数反而失去示例意义 ⇒ 保留；
- `test/update.test.mjs:174/175/190/191`：`parseSemver` / `compareSemver` / `isNewerVersion` 的
  **semver 比较数据**（`v0.1.2 > 0.1.1`），与「本包当前版本」无关；
- `test/update.test.mjs:115` 的 `currentVersion` 默认值 `0.1.1`：注入的被检查版本（g-033 已裁定保留）。

### 三、CHANGELOG 定稿
`[Unreleased]` 归入 `## [0.1.3] - 2026-10-05`（中英对照），并把条目中「导出文件名本轮未改」的表述更新为
「导出文件名同样按读者时区命名」（g-034 的第二条指令落地后，旧表述已过时）。`[0.1.2]` 及更早段一字未动。

### 四、验收
- `cd packages/dsh-prompt-setting && node --test`：**580 pass / 0 fail**（与 g-034 后基线 580 一致，无断言削弱）；
- `npm pack` ⇒ **`dsh-prompt-setting-0.1.3.tgz`**：**23 文件**、**497130 B**、`test/` 命中 **0**、
  `core/install.js` 在包内、`test/install.test.mjs` 不在包内；包内 `package.json.version` 与
  `index.js` 的 `PLUGIN_VERSION` 均为 `0.1.3`，包内 `client.js` 含 Revision 18 的 `localStampParts`；
- 全仓 `0.1.2` 残留清单：仅上述白名单（见二），无其它位置把 `0.1.2` 当作当前版本；
- `README.md` / `README_zh.md` 的 `npm pack` 文件数与体积表述：本轮未在 README 正文写具体字节数
  （历史值只在 NOTES 与 CHANGELOG 留档）⇒ 无需同步。
- **真机已验（2026-10-05，负责人目视）**：宿主 `pid 35408` 于 `15:59:41` 重启（晚于提交 `6bffafc`）后加载
  `PLUGIN_VERSION = '0.1.3'`，设置页标题旁版本号显示 OK ⇒「宿主半改动需重启才生效」这条既有事实本次照常兑现
  （旧 `pid 12871` 是 13:51 启动、跑 0.1.2 代码的宿主）。

## 111. 版本号 `0.1.3` → `0.1.4`：同步点与白名单依据（g-037，2026-10-06，基线 `73c3ed2` 工作区）

### 一、同步的「本包当前发布版本」（18 处 / 9 文件）
- `package.json` 的 `version`、`index.js` 的 `PLUGIN_VERSION`；
- `CONTRACT.md` 5 处：§10 export 示例 2 处（`plugin.version` / `pluginVersion`）、§13.8 版本节点文案（`v0.1.4`）、
  §13.9 ping 示例的 `version`、§17 update-check 示例的 `current`；
- 两份根 README 4 处：徽章各 1 处 + CHANGELOG 行表述各 1 处（`currently 0.1.4` / `当前 0.1.4`）；
- 测试硬字面量 7 处：`test/stage2.test.mjs` export 断言 2 处、`test/client.test.mjs` update-check fixture 的
  `current` 1 处 + export fixture 2 处 + banner 渲染断言 `/0\.1\.4/` 1 处、`test/update.test.mjs` ping 断言 1 处。
- **升版盲点（下次务必照做）**：banner 渲染断言在源码里是**转义正则**（`/0\.1\.3/`），普通 `grep '0.1.3'`
  命中不到（§110 的清单记了它，但机械 grep 会漏）。本轮首次全量测试正是漏改这一处 ⇒ 579 pass / **1 fail**；
  升版扫描必须同时跑 `grep -rnF '0\.1\.'`，或直接跑全量测试兜底。

### 二、白名单判断依据（一律未动）
- `CHANGELOG.md` 的 `[0.1.3]` 及更早历史段、`NOTES.md` 历史叙述（含 §110 的 `0.1.3` 记录）、`.dsh-graph/**`、
  `docs/prompt-variables.md`：历史记录；
- `core/install.js:171` 的「announce `0.1.3` and install `0.1.2`」：**故意让两个版本号不同**才说明
  「宣布的版本与安装的版本必须同源」；改成同一个数反而失去示例意义 ⇒ 保留；
- `core/update.js` / `core/install.js:128` / `CONTRACT.md` 的 tag 形态举例（`v0.1.2`）、`test/update.test.mjs`
  的 semver 比较数据与 `currentVersion` 默认值 `0.1.1`：与「本包当前版本」无关（§110 已裁定）。

### 三、CHANGELOG 定稿
新增 `## [0.1.4] - 2026-10-06`（中英对照）。本段**不含用户可感知的行为变更**：本版功能改动 g-036（重启提示
按启动形态分区）截稿时仍在 `collecting`、尚未落地，故条目只记版本号同步，并声明运行时行为与 `0.1.3` 相同。
`[0.1.3]` 及更早段一字未动。

### 四、验收
- `cd packages/dsh-prompt-setting && node --test`：**580 pass / 0 fail / skipped 0**（与 0.1.3 基线 580 一致，
  无断言削弱）；
- 负向对照（天然红证据）：漏改 banner 断言时全量 **579 pass / 1 fail**（`client.test.mjs:6571` 期望
  `/0\.1\.3/`、实际渲染 `0.1.4`）⇒ 版本断言确实钉住「当前版本」，非空转；
- `npm pack` ⇒ **`dsh-prompt-setting-0.1.4.tgz`**：**23 文件**、`test/` 命中 **0**、`core/install.js` 在包内、
  `test/install.test.mjs` 不在包内；包内 `package.json.version` 与 `index.js` 的 `PLUGIN_VERSION` 均为
  `0.1.4`；`prepare` 自检 **19 项通过**；体积 **≈499 KB**（**不要记精确字节数**：`NOTES.md` 在 `files`
  白名单内，本节每修一次字，包体就跟着变——首测 498280 B（本节写入前）⇒ 本节写入后 499026 B）。
- 全仓 `0.1.3` 残留：仅上述白名单（见二），无其它位置把 `0.1.3` 当作当前版本。

## 112. 更新后的重启提示按启动形态分区（g-036，2026-10-06，基线 `67eed2f`）

### 一、形态判据：官方 `profileContext.name`，且只认它
- 新增 `core/launch-kind.js`（纯函数、无 IO、不 import DSH、不读 `process.env`），`launchKindOf(ctx)` 用
  **可选** `ctx.get('profileContext')` 读取——**不进 `inject`**（`inject` 仍是
  `['webServer','connection','systemPrompt']`，`test/launch-kind.test.mjs` 明确断言这一点），服务缺失/抛错
  都只是 `'unknown'` 这个值，绝不让整包加载失败。
- 三态口径：`name === 'desktop'` ⇒ `'desktop'`；**其它非空字符串**（`web`/`tui`/…）⇒ `'cli'`；缺失、非字符串、
  空白串、服务不可读、getter/查找抛错 ⇒ `'unknown'`。**`'unknown'` 绝不折叠成 `'cli'`** —— 桌面端用户看到
  「重启 dsh web」正是本目标要消灭的缺陷。
- 不用环境标记：`ELECTRON_RUN_AS_NODE` 对任何 Electron Node 宿主都真（无区分力），`DSH_CLIENT_VERSION` 是
  用户可 export 的变量。两者都只能把诚实的 `'unknown'` 变成猜测，所以一个都不做判据（主管卡片已把二者降为
  佐证）。
- 官方同款写法与无假阳依据：`@deepseek-ai/dsh-web-app/cordis.patch.yml` 用
  `ctx.get('profileContext')?.name !== 'desktop'`；`@deepseek-ai/dsh/lib/bin.js` 的 `rejectElectronProfile()`
  对 `profile==='desktop'` 直接报错 ⇒ 命令行宿主无法伪称桌面端。

### 二、下发点：ping + `update-apply` 三类响应（不动 `core/install.js`）
- ping（`index.js` 组装处）与 POST 发起（含 `reused` / `alreadyInstalled` / `publicRefusal` 三种出口）、
  GET 查询（含 `status:null` 与未知 id）、POST cancel（`cancelling` 与两种 `not-running`）全部附
  `launchKind`；`publicInstallStatus()`（`core/install.js:924` 起）**一字未动**，状态机语义与既有字段不变。
- 字段只在响应组装处读取，请求体/查询串无法影响它（契约 §18.8 已写明）。

### 三、文案分区与 `unknown` 兜底的选择理由
- 采用**「保留基键作兜底 + 新增形态专用键」**（而非把每键改成三键并删原键）：基键仍是老宿主与不可判定形态
  的落点，客户端映射表 `UPDATE_APPLY_COPY_KEYS` 是**显式表**，不在渲染处拼键名；缺键回落到
  `updateApplyUnknown`，所以任何情况下都不会渲染出 `undefined`。
- 分区键（zh/en 各 12 个）：`updateApplyRestartNote`（确认框）、`updateApplyDone`（完成态）、
  `updateApplyAlready`（同版本已装）、`updateApplyUnknown`（状态不可查；取消失败与缺版本的兜底也用它）。
- **兜底键不含 `dsh web`**：判据 4 把「`unknown`」与「字段缺失（老宿主）」归为同一档 ⇒ 兜底文案是**桌面端
  用户也会读到**的那一句，写成「请手动重启 DSH」两种形态都执行得通。代价是判据 5 的「老宿主下与原行为
  等价」只能按**渲染路径与可执行性等价**理解（同渲染点、同非空文案、无报错无空白），而**不是逐字相同**；
  这是有意选择：老宿主背后的桌面端用户正是最不能被指向终端的读者。渲染结果等价性由
  `test/client.test.mjs` 的「an old host without launchKind renders the shape-neutral copy」用例钉住
  （省略字段与 ping 失败两条路径文案逐字相同）。
- 桌面端文案承诺「退出并重新打开 DeepSeek Harness」，**不承诺 App 内有重启按钮**：正式版没有该入口
  （`app.relaunch` 只用于崩溃恢复），macOS 关窗不退出 ⇒ 必须 Cmd+Q 完全退出再重开。cli 文案含
  「重新运行 `dsh web`」（en：`restart dsh web`），桌面端组经测试断言**不含** `dsh web`。
- 客户端另在根容器发布 `data-launch-kind="cli|desktop|unknown"`，真机核验读一个属性即可，不必匹配句子。
- `CONTRACT.md:2569`（§15 里「running `dsh web` must be restarted…」）与 `README` 的开发段落属**另一个
  语境**（宿主进程级事实，非「更新后提示」），本轮未改，仅把 README 维护者段的口径扩成「重启宿主（两种
  形态各怎么做）」。

### 四、测试口径
- 新增 `test/launch-kind.test.mjs`：纯函数穷举（含 `Symbol`、getter 抛错、`ctx.get` 抛错、`''`/空白、大小写），
  并断言 `inject` 不含 `profileContext`。
- 宿主：`test/host.test.mjs` ping 断言 `launchKind` 三态；`test/route.test.mjs` 的 ping 键集合全等断言补
  `launchKind`；`test/install.test.mjs` 新增 `mountHost({profileName})` 并在 POST/GET/cancel/already-installed
  与「每个 profile 名字对应哪个形态」逐项断言（未知 profile ⇒ `unknown`）。
- 客户端：新增两条渲染用例（三形态的确认框与完成态文案 + 老宿主/失败 ping 回退等价），并把既有
  「`/手动重启 dsh web/`」断言改为形态化断言（cli fixture 断言 `/重新运行 dsh web/`、「already installed」
  这条真桌面用例改用 `desktop` fixture 并断言 `/退出并重新打开 DeepSeek Harness/` + **`doesNotMatch(/dsh web/)`**）；
  文案表测试新增「每个 family 三键齐备」「cli 组含 `dsh web`」「desktop 组与兜底键都不含 `dsh web`」及 en 的
  `automatic restart` 扫描 —— 原有「不承诺自动重启」断言一条未删、未放宽。
- `test/client.test.mjs` 的 ping fixture 需要 `payload.ok === true` 才会被 `requestJson` 视为成功；只写
  `{ launchKind: … }` 会被当成 ping 失败 ⇒ 三态用例恒走兜底（本轮踩过，已改成
  `{ payload: { ok: true, launchKind: … } }` 或 `pingResponse(..., launchKind)`）。

### 五、负向对照与验收
- 负向对照①：临时把 `launchKindOfName` 的返回值改为恒 `'cli'` ⇒ `test/launch-kind.test.mjs` **7 tests / 4 pass /
 3 fail**（三条形态判定断言转红）；还原后该套件 7/7 全绿。
- 负向对照②：临时把客户端 `normalizeLaunchKind` 改为恒 `'unknown'` ⇒ `test/client.test.mjs` **148 tests /
  143 pass / 5 fail**（三形态新用例与三条 cli 断言转红）；还原后 148/148 全绿。
- 基线对照：中途未同步 `test/route.test.mjs` 的 ping 键集合全等断言时，全量为 **590 pass / 1 fail**；补上
  `launchKind` 后 **591 pass / 0 fail**（与「改文案/加字段必须同步全等断言」的既有纪律一致）。
- 最终：`cd packages/dsh-prompt-setting && node --test` ⇒ **591 pass / 0 fail / skipped 0 / exit 0**（基线
  `67eed2f` 的 580 加上本轮新增 11 条：launch-kind 7 + client 2 + host 1 + install 1）。
- 真机项（判据 10）：本机是命令行 `dsh web`（`~/.dsh/profiles/web`，宿主 PID 35408 于本轮**未重启**）⇒ 重启后
  `GET /prompt-setting/ping` 应回 `launchKind: "cli"`、页面根容器 `data-launch-kind="cli"`、完成态文案含
  「重新运行 dsh web」。**本轮未重启宿主，故真机目视为待验证项**（第三方插件读真 `profileContext` 的返回值
  同样只在重启后才能看到；裸 `curl /prompt-setting/ping` 只会得到 401 信任围栏）。

## 113. 「历史与备份」拆成「版本历史」+「备份与恢复」，历史作用域与查看范围解耦，列表分页 + 定高内滚（g-038，2026-10-08，基线 `4e1bef3` 工作区）

### 一、契约变更（Revision 19；`CONTRACT.md` §8 / §9 / §13.0 / §13.3 / §13.3a / §13.7）
- **tab 5 个**：`MAIN_TABS = ['mine','overview','history','backup','advanced']`，顺序固定、默认仍 `mine`；
  导出/导入整体迁入 `backup`（`data-region="backup-tab"` 内只有 `transfer`），`history` 内不再有任何导出/导入节点。
- **history 的 scope 一拆为二**：`?session=` = **显式过滤**（未传/空 ⇒ 不过滤，user 层因此是「该层全部记录」）；
  新增 `?workspace=` = **只定位不过滤**（一个能解析出工作区的 session id），响应新增 `scopeSession`。
  `?diff=` 用同一套 `readScopeOf`（`index.js`），所以列表与对比永远读同一个文件。
- **分页**：新增 `?offset=`（`resolvePageOffset`：缺失/空/负/非数 ⇒ `0`；越界 ⇒ 钳到最后一页起始），
  响应新增 `offset` / `pageCount` / `hasMore`。`queryHistory` 变成 `(filter → 排序 → offset/limit 窗口)`，
  返回 `{records,total,offset,pageCount,hasMore}`；`total` 永远是匹配数、页数是 `ceil(total/limit)`、
  `limit=0` 是「只要计数」⇒ `pageCount=0`/`hasMore=false`。
- 兼容性：`layer`/`name`/`before`/`limit`、`.jsonl` 格式、保留上限、坏行跳过语义、写入响应体全部未动。

### 二、为什么新增 `?workspace=`（与推荐方案的一处偏差及理由）
- 推荐方案是「`?session=` 缺省不过滤、显式时过滤」，但**工作区层必须有一个 id 才能定位 `history.jsonl`**
  （根目录只由宿主 `workspaceRegistry` 从 session 反查，§4.2 明令「客户端从不提供路径」）。若拿 `?session=`
  既定位又过滤，同一个工作区里**别的会话写下的记录会被隐藏**（实测：一个工作区两个会话 ⇒ 只看到一半历史）。
- 因此新增**只用于定位**的 `?workspace=<sessionId>`：工作区维度选择器发它，列表拿到的是该工作区**全部**记录；
  `?session=` 的过滤能力原样保留（`stage2.test.mjs` 有用例）。两个参数都是 session id，都不是路径。
- 被否方案：① 客户端传工作区 root —— 违反 §4.2；② 让 `session` 只定位不过滤 —— 与 brief「显式 session 过滤
  能力保留」冲突，且会让既有 `?layer=workspace&session=…` 调用语义变化；③ 选择器只给「会话」维度 ——
  与负责人裁决的「工作区维度」不符。降级路径（profile 无 useWorkspaces）仍回落为会话列表并显式标注
  `data-warning="history-scope-degraded"`。

### 三、客户端改动
- `renderHistoryTab` 只渲染历史面板；新增 `renderBackupTab` 承载 `renderTransferPanel`；tab 面板分派加 `backup` 分支。
- **历史自己的作用域**：`historyScope`（`null` = 跟随当前会话）+ `historyScopeOptionsOf(wsSeat, seat)`
  （工作区维度，值为该工作区的一个成员 session；无工作区列表时降级为会话目录）。`historyScopeArg` 只在
  workspace 层进入请求，所以 user 层的日志不因作用域移动而重新请求。页面用 `data-role="history-scope-note"`
  明说当前作用域（global / workspace+sid / no-session）。
- **分页**：state 只有 `historyOffset`；`historyPagerInfo(data)` 从**响应**读 `pageLimit/offset/pageCount/hasMore`，
  并把越界 offset 钳进真实页数（标签不会出现「第 6 / 3 页」）。首页禁用「上一页」、末页禁用「下一页」。
  **客户端不再有页大小字面量**：首次请求不带 `limit`，之后按响应 `pageLimit` 步进（旧 `HISTORY_PAGE = 20` 已删）。
- **定高内滚 + 左右两栏**：`HISTORY_BOX_HEIGHT = 320`；左列 `data-region="history-list"`、右列
  `data-region="history-detail-box"` 各自 `height/maxHeight` + `overflowY: auto`，窄宽度回落为上下两段。
  右列按裁决只**预留容器与数据骨架**（`data-history-detail` + `data-note="history-detail-pending"`），
  既有的 `history-diff` 对比面板放进右列；**本目标不实现预览/回滚**（g-039）。
- 文案：zh/en 各新增 12 键（含 `tabBackup`、`histScope*`、`histPager` 等），两表白名单仍逐键相等。

### 四、测试口径与证据
- 新增/改写用例：`history.test.mjs`（`resolvePageOffset` 14 断言 + `queryHistory` 分页/钳制/`limit=0`/过滤后分页）、
  `stage2.test.mjs`（无 session ⇒ 全层 / 显式 session 仍过滤 / `?offset=` 三页 + 非法与越界钳制 + 默认 50 /
  `?workspace=` 定位不过滤 + `?diff=` 同 scope）、`client.test.mjs`（5 tab 顺序与单面板、导出导入正负向归属、
  作用域与查看范围解耦、分页边界与末页禁用、越界钳制、定高滚动盒、EN 扫描新增 history/backup 两条用例与必需标记）。
- **负向对照（逐条都真的转红，随后还原）**：① 宿主把 `workspace=` 也当过滤 ⇒
  `stage2: a workspace log is located by ?workspace=…` 1 fail；② 客户端历史请求回退到 `layerQuery(layer, sessionArg)`
  ⇒ 客户端 2 fail（作用域定位、查看范围解耦）；③ 客户端硬编码 `pageSize = 20` ⇒ 客户端 2 fail（分页边界、越界钳制）；
  ④ 把 `renderTransferPanel` 放回历史 tab ⇒ 客户端 2 fail（tab 切换、导出导入归属）。
- 基线对照：改动前 `591 pass / 0 fail`（23.7s）；完成后 `601 pass / 0 fail`（新增 10 条）。
  `node --check index.js && node --check client.js` 通过（本仓库无 tsconfig，不跑 tsc）。

### 五、未验证项（诚实清单）
- **真机目视未做**：左右两栏的实际换行宽度、320px 盒子的观感、内部滚动手感都只在测试沙箱里按 DOM/样式断言
  （`overflowY`、`height`、`maxHeight`、只渲染当前页），没有真浏览器截图；需要复核时由负责人打开设置页确认。
- 宿主**未重启**（纯插件代码 + 路由参数，无需重启；`dsh web` 进程仍跑旧代码，`?workspace=` 要到下次加载新版
  `index.js` 才生效）。
- g-039（右列预览/回滚）与 g-040 未开工：右列目前只有占位说明 + 既有对比面板。

## 114. g-038 二轮返工：历史作用域改「一行摘要 + 更改展开」，换文件即复位对比选择（2026-10-08，基线 `d4d2052` 工作区）

### 一、反馈 1：作用域不能平铺成 tab（设计改版）
- 一轮把每个工作区渲染成一枚 tab 按钮（复用 `tabs()`），工作区一多就铺满好几行。二轮改为 **g-016 同款折叠**：
  `data-region="history-scope"` 上带 `data-scope-open="true|false"`，展开体（`data-region="history-scope-picker"`）
  **只在展开时渲染**，所以面板高度与工作区数量无关（收起态恒为一行摘要）。
- 摘要行 = `data-region="history-scope-summary"` + `data-role="history-scope-summary-label"`（当前作用域名）+
  `data-action="history-scope-toggle"` 开关；开关文案**复用** g-016 的 `scopeEdit`（更改）/ `scopeCollapse`（收起），
  `aria-expanded` / `data-expanded` 同步。无候选（`data-history-scope-options === "0"`）时摘要行落到
  `data-role="history-scope-empty"`（既有 `histScopeNone` 文案）且**不渲染开关**。
- 展开区 = 搜索框 `data-role="history-scope-search"` + **定高内滚**候选列表
  `data-history-scope-list="scroll"`（`HISTORY_SCOPE_LIST_HEIGHT = 200`，`height == maxHeight`，`overflowY:auto`；
  `data-history-scope-shown` = 过滤后条数）。候选是 `button[data-role="history-scope-option"]
  [data-history-scope-option=<session id>][data-selected=true|false]`；搜索无匹配渲染
  `data-role="history-scope-no-match"`。选中即收尾：应用 → 收起（picker 与搜索框消失）→ 清空搜索词。
- 新增 zh/en 各 2 键：`histScopeSearch`、`histScopeNoMatch`（其余全部复用既有键；两表键位仍逐键相等）。
- 「用户级 / 工作区级」那一行**保持 tab 不变**（只有两个值）。
- **一个既有测试的写法需要收紧**：`data-scope-open` 现在是两个节点共用的钩子（页面「查看范围」卡片 + 历史作用域），
  所以原来用 `markerOf(tree,'data-scope-open')` 的「页面选择器收起」断言改为精确到
  `oneBy(tree,'data-region','session')`；断言强度不变（仍是同一事实，只是不再假设「全页唯一」）。

### 二、反馈 2：切层/切作用域后对比选中态残留（缺陷）
- 根因：`diffSel` 装的是**某一份** `history.jsonl` 里的 `seq`。切层（user ↔ workspace）或切作用域 = 换文件，
  旧引用在新文件里没有意义，界面却仍高亮、右列仍显示旧结果 —— 状态与数据不同源。
- 修法：把复位收拢成一个 `resetHistoryView()`，`setHistoryLayer` 与 `setHistoryScope` 统一调用：
  `setHistoryOffset(0)` + `setDiffSel({ from: null, to: DIFF_CURRENT })` + `setDiff({ idle, data: null })`
  （右列 `data-history-detail="empty"`、`history-diff` 的 `data-diff-state="idle"`、无 `data-diff-sections`、
  占位说明回归）。**切层时 offset 也归零**（一轮只在切层分支写了 offset，二轮把两条路径彻底统一）。
- **翻页不复位**（负责人倾向 + 我的判断一致）：`historyPrev` / `historyNext` 在同一份文件内移动，选择与结果保留、
  也不重发请求。这一条差异已写进契约 §13.3，并由两条用例分别钉死（复位 vs 保留）。

### 三、测试与负向对照
- 新增 4 条客户端用例：① 摘要行/展开收起/搜索过滤/搜索空态/定高内滚/选中收起；② 无候选空态（摘要落
  `history-scope-empty`、无开关、无 picker、不发请求、workspace 层仍给 `no-session`）；③ 切层与切作用域两条
  复位路径（无记录行带选中、current 回默认 `to`、offset 归零、右列 empty、diff 回 idle、零新请求）；④ 翻页保留
  （`detail` 仍 `diff`、diff 请求数不变、翻回第 1 页选中仍在）。
- EN 扫描：history 用例补 `history-scope-empty` / `histScopeNone`，并新增一条「作用域折叠：摘要 + picker + 搜索 +
  无匹配」用例（marks 覆盖 `history-scope-summary` / `history-scope-picker` / `history-scope-search` /
  `history-scope-option` / `history-scope-no-match` / `history-scope-list=scroll` / `data-scope-open=true`），
  `EN_REQUIRED_MARKERS` 同步补 7 项。
- **负向对照（均真红后还原）**：① 去掉 `resetHistoryView` 里的 `setDiffSel` ⇒ 复位用例转红；② 去掉
  `setHistoryOffset(0)` ⇒ 复位用例 offset 断言转红；③ 忽略 `historyScopeOpen` 常驻渲染展开体 ⇒ 摘要/收起用例转红；
  ④ 让翻页也调用 `resetHistoryView` ⇒ 翻页保留用例转红（两条路径的差异被钉死）。
- 全量：`cd packages/dsh-prompt-setting && node --test` ⇒ **605 pass / 0 fail**（一轮 601 + 新增 4，无回归、无削弱）；
  `node --check index.js && node --check client.js` 通过。

### 四、未验证项
- 真机目视仍未做（收起态一行高度、200px 候选盒的滚动手感、两栏换行），只有 DOM/样式断言；宿主未重启（本轮
  纯客户端改动，路由/参数未动，契约 Revision 20 明记「client-half only」）。

## 115. 版本历史（二）：对比免滚动、记录预览、一键回滚到指定版本（g-039，2026-10-08，基线 `2b36456` 工作区）

### 一、需求与终态

三件事，一件写三处（宿主 / 核心 / 客户端）：① 选两条记录看对比**不必滚页面**；② 任一条记录**一键预览**
要点与内容；③ 任一记录**一键回滚**到该版本，带二次确认与不可撤销声明，且回滚本身可再回滚。
①是 g-038 两栏布局的验收核心，本轮不再重做布局，只保证新交互**不破坏**它：预览、对比、回滚确认三视图
全部落进右列那个既有的定高内滚盒 `data-region="history-detail-box"`，页面高度因此与历史条数无关。
`data-note="history-detail-pending"` 从「后续目标落地」改为**空闲提示**（元素与标记保留，既有断言不动）。

### 二、核心设计：snapshot 给结构，记录链给文本

契约 §8 的 `snapshot` 是 `{name, action, hash, bytes}` 列表，**不含文本**——它说明某个版本有哪些段、
什么动作、什么顺序，唯独不说内容。所以"按 snapshot 写回该层"单靠 snapshot 做不到，而凭空取用当前
配置的文本正是「静默写坏配置」的形态（当前值可能已被更晚的记录改过）。

落地算法（`core/history.js` 新增纯函数 `rollbackOverrides(records, current, seq)`）：

- **结构** = 目标记录自己的 `snapshot`（权威，含顺序与 action）；
- **文本** = 倒序回放：状态从**当前**层出发，按 `seq` 降序撤销每条更晚的记录。单段记录把该 name 恢复成
  它的 `before`（`before === null` ⇒ 该段当时不存在 ⇒ 删除）；整层记录用它的 `entries` 重建
  （`reset-layer` / `rollback` 是「清空后重建」，`legacy-clear` 是「加回」）。隐藏（`hide`）项按定义无文本，
  结构里 `action === 'hide'` 的项**不查回放**，直接产出 `{name, action: 'hide'}`；
- **对账**：回放后仍取不到文本的段（日志与文件不一致，例如手改过配置）⇒ 抛
  `history-rollback-unavailable`，**不猜文本**。多余项按 snapshot 语义删除（这正是"回到该版本"的含义），
  被替换掉的整层列表记进新记录的 `entries`，所以删掉的东西仍可再滚回来。

被否方案：① 只用 snapshot 重建、文本沿用当前值 —— 不满足"等于该历史版本"，且会静默写错；
② 反向逐条"重放快照"（不读 `before`/`after`）—— snapshot 无文本，重放得不到内容；
③ 用 diff 引擎反推文本 —— 间接、慢，且 diff 的语义是"比较"不是"恢复"。
保留的限制（写进契约 §19）：`append` 的 `order` 既不在 snapshot 也不在任何记录里，只有仍存在于当前
配置的同名项能保留它，其余情况丢弃——重建一个任何版本都没记过的位置就是猜。

### 三、宿主：`POST /prompt-setting/rollback`

- 入参 `{layer, session?, workspace?, seq}`；scope 与 §8/§9 **逐字同源**（`session` 过滤、`workspace` 只定位），
  body 优先、query 兜底；`workspace` 层仍须能解析出 root（`workspace-unresolved`）。
- **顺序即契约**：解析层 → 读当前配置（`writableConfig`，坏文件 `layer-not-writable` 409）→ 读日志 →
  重建（`rollbackOverrides`）→ `validateConfig` 校验 → **才写** → 追加记录。任何拒绝都发生在第一次写之前，
  所以失败路径**字节级不变**（`test/stage2.test.mjs` 每个失败路径都拿 SHA-256 卡）。
- 新增 action `rollback`（`HISTORY_ACTIONS` 追加在末尾；`LAYER_WIDE_ACTIONS` 同步追加，故 `name: null`）。
  记录带 `entries = resetEntries(回滚前的整层)`、`snapshot = 回滚后的层`、`note = "rollback to #N"`，
  因此回滚可被 diff、预览、**再回滚**。
- 错误码：`invalid-seq` / `history-not-found`(404) / `layer-not-writable`(409) / `history-snapshot-missing`(409) /
  `invalid-history-snapshot`(409) / `history-replay-unavailable`(409) / `history-rollback-unavailable`(409)。
  方法表 `[ROLLBACK_PATH, ['POST']]`，其余方法 405 + `allow: POST`。
- 兼容取舍：`snapshot` **缺失或为空**一律拒绝（`history-snapshot-missing`）。旧记录本就没有该字段；
  整层清空后的记录 snapshot 合法地为 `[]`——两种都描述不出可恢复的结构，而"回到空层"本来就有
  `?reset=true`（§12.1）这条会自我说明的路由。这是 brief 允许的「明确结构化拒绝」分支，选了它而不是
  用 `before`/`after` 猜结构。

### 四、客户端：预览零请求、回滚只提问

- 每行新增 `data-action="history-preview"` 与 `"history-rollback"`（都带 `data-history-id`）。
- **预览不发任何请求**：面板渲染的全部内容（要点、`before`/`after` 文本、整层 snapshot、note）本来就随
  `GET /history` 那一页一起到达，所以"预览零写请求"是**结构性**的而非承诺——测试断言预览路径后
  router 上非 GET 调用数为 0、且从不碰 `/rollback`。标记：`data-region="history-preview"`
  + `data-preview-state="ready"|"missing"`、`data-preview-field`（action/at/layer/name/origin/note）、
  `data-preview-text="before"|"after"`（`data-preview-bytes` 存字节数，正文是节点文本）、
  `data-preview-snapshot="<name>"` + `data-preview-snapshot-action`。
- **翻页不复位预览**（与 `diffSel` 同一约定，§13.3）：当前页不含该记录时渲染显式的
  `data-preview-state="missing"`，而不是空白面板；**切层/切作用域则复位**（`resetHistoryView` 里新增
  `setPreviewId(null)`）——否则会重犯 g-038 二轮修掉的「蓝框还在但指错对象」。
- **回滚按钮只提问**：走既有 `confirm-overlay`，`data-confirm-kind="rollback"`，正文点名版本，
  不可撤销声明复用 `data-role="confirm-irreversible"`（既有的 `resetIrreversible` 文案）。未点确认前
  零请求。确认后只发一次 `POST /rollback?layer=…[&workspace=…]`，body `{layer, seq}`。
- **成功后重新拉取而不是原地打补丁**：`resetHistoryView()` + `setReload(+1)` ⇒ offset 回 0、选择/对比/预览
  全部复位，历史列表、当前生效值、两个层视图都从宿主重读（下一次装配看到新值）。失败只出错误 notice，不复位。
- 新增 zh/en 各 14 键（`histAction.rollback`、`histPreview*`、`histRollback*`），两表键位仍逐键相等。

### 五、测试与负向对照

- `test/history.test.mjs`：新增 4 条（倒序回放的文本恢复 / hide 无需文本且 append 保留 order /
  整层清空的 entries 撤销 / 全部拒绝码），并更新契约快照断言。
- `test/stage2.test.mjs`：新增 3 条（成功回滚 = 层等于该版本 + 追加 rollback 记录 + 再回滚；
  六类失败逐个 SHA-256 卡字节不变；workspace 层经 `workspace=` 定位），405 与 fence 两个既有遍历
  各加 rollback 条目。
- `test/client.test.mjs`：新增 4 条（预览要点/文本/snapshot + **零写请求** + 同一详情盒内 + 两栏等高；
  翻页保留预览与 missing 态、切层复位；回滚二次确认 + 不可撤销 + 单次 POST + POST 之后重读日志/当前值；
  失败只出 notice 且视图原样保留）。
- **被改写的既有断言（逐条理由）**：`history.test.mjs` 里 `HISTORY_ACTIONS` 与 `LAYER_WIDE_ACTIONS` 的
  精确列表断言——它们是契约快照，Revision 21 追加了 `rollback`，故从 6 项更新为 7 项、从 2 项更新为 3 项，
  并**新增** rollback 的正反两向断言（不得带 name / 必须为 null）。除此之外没有删除或放宽任何断言；
  `data-note="history-detail-pending"` 的两处既有断言靠"保留标记、只改文案"原样通过。
- **负向对照（均真红后还原）**：① 把"文本不可恢复即拒绝"改成跳过 ⇒ history 单测与 stage2 各 1 条转红；
  ② 让 `history-not-found` 不拒绝而返回空层 ⇒ stage2 的 404/字节不变用例转红（证明"失败零副作用"不是空断言）。
- 全量：`cd packages/dsh-prompt-setting && node --test` ⇒ **616 pass / 0 fail**（基线 605 + 新增 11，
  无回归、无削弱）；`node --check index.js && node --check core/history.js && node --check client.js` 通过。

### 六、未验证项

- **真机目视未做**：窄屏两栏回落、预览面板在 320px 盒内的滚动手感、回滚确认弹窗的视觉层级，本轮只有
  DOM/样式断言（`overflowY`/`maxHeight`/同盒归属）。
- **宿主未重启**：本轮改了宿主路由与新 action，需要重启后才在真机生效；测试全部通过假 Host 驱动。
- **`order` 的有损恢复**（见二）：仅当同名项仍在当前配置中时保留，契约 §19 已明记，未做端到端真机验证。
- 未做并发写入（两个回滚同时到达）的真机验证；单进程内 `writeConfig` 是原子替换，但"读-改-写"之间没有锁，
  与既有 `PUT/DELETE` 的语义一致，不是本轮引入的新风险。

## 116. g-039 返工：回滚收窄为「只恢复保留段」，与写入面政策一致（Revision 22，2026-10-08，基线 `7645961` 工作区）

### 一、缺陷与原理

主管独立实测（真实场景：旧覆盖 `project:alpha` 后来被删除，再回滚到它还存在的版本）证实：上一轮的
**整层写回**会把**非保留段一并复活** —— `回滚到 #1 产出的 overrides = [{"name":"project:alpha",...}]`。
而 `PUT /overrides`、单名 `DELETE`、`POST /import` 对任何非保留段名一律 `403 write-locked`
（Revision 7 的写入面收窄，§4.1 / §15.7）。也就是说回滚成了**第 4 条写路径**：用户界面上既不能创建、
也不能删除的旧段覆盖，会因为一次回滚重新进入装配，改变下一轮会话的提示词。负责人裁决与写入面政策严格
一致，不做例外。

### 二、收窄后的语义（本轮的实现）

`rollbackOverrides(records, current, seq, sectionName)` 的返回值不再是"重建出来的整层"，而是
**当前层原样 + 恰好一个条目被调整**：

- 目标版本的 `snapshot` **含**保留段 ⇒ 该条目文本恢复为那一版的文本；
- 目标版本的 `snapshot` **不含**保留段 ⇒ 从当前配置中**删除该条目**（回到「未配置」）；
- **其余条目一律按引用原样透传，位置也不动** —— 包括层文件里历史遗留的非保留段，无论目标版本是否
  提到过它。回滚永不新增、删除、重排或修改它们。

文本仍来自记录链倒序回放，但**只跟踪保留段这一条**：只有 `name === sectionName` 的单段记录、以及会
把保留段一起清掉的 `reset-layer`（用它的 `entries` 撤销）参与回放；`legacy-clear` 只删 frozen 覆盖、
动不到保留段，直接跳过；其它段的记录一律跳过（它们不可能移动保留段）。取不到文本 ⇒
`history-rollback-unavailable`，绝不猜。

### 三、为什么采用「段级 rollback 记录」（第 4 条）而不另立方案

采纳负责人给的第 4 条，且没有更优替代：把 `rollback` 记录改成**普通段记录**
（`name` = 保留段名，`before` / `after` = 该段回滚前后的文本，`entries: null`）之后，
**`undoSection` 走的就是普通分支**，与 `replace` 记录完全同一条路径 —— replay 的正确性来自
"它本来就是我表里的一种写"，而不是来自任何为 rollback 新开的特例。相应地：

- `LAYER_WIDE_ACTIONS` **撤回** `rollback`（恢复为 2 项：`reset-layer` / `legacy-clear`），
  `HISTORY_ACTIONS` 仍保留新增值；
- `validateHistoryRecord` 的既有约束因此自动给出正确结果：`rollback` 是段级，必须带非空 `name`；
  带 `name: null` 的 rollback 记录会被判为非法行（§8 的宽容读法计为 corrupt），
  这正是"上一轮 REVISION 21 形态的日志不再被本契约描述"的诚实处理，写进契约 §19.9。

被否方案：保留 layer-wide 记录但用 `entries` 表达"只改保留段" —— 语义与字段名打架，
且 replay 仍需为 rollback 开特例（`entries` 语义与 `reset-layer` 不同），特例正是越界的温床。

### 四、客户端

- 预览面板新增 `data-preview-policy="reserved-only"`（文案 `histPreviewPolicy`），并在目标版本
  snapshot 含非保留段时给出 `data-preview-foreign="<n>"`（文案 `histRollbackForeign`，n 由**该记录
  自己的 snapshot** 现算）；
- 二次确认框新增 `histRollbackScope`（只恢复保留段）与同一句 `histRollbackForeign`（n>0 时）；
- 宿主响应新增 `section` / `restored` / `skipped` 三个字段，把"政策拒绝恢复了几条"变成**响应自己的
  陈述**，客户端不必反推。

### 五、测试与负向对照

- `test/history.test.mjs`：重写 4 条 rollback 单测（只调目标段、非保留段按引用透传且位置不变、
  目标版本不含保留段则删除、段级 rollback 记录可再回滚），`LAYER_WIDE_ACTIONS` 契约快照断言
  **改回 2 项**并新增"rollback 必须带 name"的正反两向断言。
- `test/stage2.test.mjs`：新增 2 条并改写 2 条 —— (a) 目标版本含非保留段、当前没有 ⇒ 回滚后仍然没有
  且保留段正确恢复；(b) 当前有遗留非保留段 ⇒ 用 `entryBlock()` 从**格式化后的文件文本里按名字切出
  该条目块**，回滚前后**逐字节相同**（内容 + 位置都断言）；(c) 目标版本不含保留段 ⇒ 该条目被删除；
  (d) `rollback` 记录是段级（`name` = 保留段名、`before`/`after` 正确、`entries: null`）且再回滚回到
  回滚前的保留段状态。
- `test/client.test.mjs`：新增 1 条，断言预览与确认框都出现"只恢复保留段"的句子，且 `foreign` 计数
  与文案一致（对照：没有任何其它段的版本不出现该警告）。
- **负向对照（均真红后还原）**：① 在 `rollbackOverrides` 末尾加回"复活 snapshot 里的非保留段" ⇒
  stage2 的"never revives"与 history 单测各 1 条转红；② 把非保留段改成丢弃（不透传）⇒ 用例 (b) 的
  逐字节/顺序断言转红。两条合起来证明"不复活"与"不碰"都不是空断言。
- 全量：`cd packages/dsh-prompt-setting && node --test` ⇒ **621 pass / 0 fail**（上一轮 616 + 5，
  无回归、无削弱）；`node --check index.js && node --check client.js && node --check core/history.js` 通过。

### 六、未验证项

- 真机目视仍未做（新增的政策说明行在 320px 盒内的排版、确认框条目变多后的高度），只有 DOM 断言。
- 宿主未重启（本轮改的是宿主路由与核心层，真机需重启后才生效）。
- `order` 的有损恢复（同名项仍在当前配置时保留，否则丢弃）与上一轮一致，未做端到端真机验证。

## 117. g-039 三轮返工：整屏固定布局 + 点行即选 + 清除/关闭（Revision 23，2026-10-08，基线 `302db66` 工作区）

### 一、真机现象与根因

负责人真机看到三件事：① 记录列表与右侧详情**上下堆叠**，选一条看结果要滚页面；② 对比选择**没有取消/重置入口**；
③ 选两条要在长列表里反复翻找。根因（已复验）：`renderHistoryTab` 用了 `flexWrap: 'wrap'`，左列 `flex: 1 1 420px`、
右列 `flex: 1 1 360px` ⇒ 容器宽度不足约 790px 时**必然换行**，而设置对话框正好是这个宽度；再加上两个盒固定
`320px`、头部说明 + 作用域 + 分页 + 元信息把面板撑高，页面一定要滚。上一轮我按 brief 里「窄屏回落为上下两段各自
定高滚动」实现——那条要求本轮**作废**，改为一律不堆叠。

### 二、布局：整屏固定 + 恒并排（纯客户端）

- 容器：`flexWrap: 'nowrap'`，`alignItems: 'stretch'`，`height === maxHeight === calc(100vh - 260px)`，
  `minHeight: 320`（极短窗口的保底，低于它宁可滚也不给两条没用的缝）。
- 两列：`flex: '1 1 0'` + `minWidth: 0` + `minHeight: 0` + `overflow: 'hidden'`。**删掉了 px 级 flex-basis**
  （420/360）——那正是触发换行的语义；现在窄面板只会让两列变窄，不会换行。
- 两个滚动盒：`flex: '1 1 auto'` + `minHeight: 0` + `overflowY: 'auto'`，**不再有固定高度**；
  `data-history-box-height` 从"像素数"改为字符串 `'viewport'`（表述"高度来自视口，不来自本盒"）。
  列表卡片 `data-region="history"` 加 `height: '100%'`，否则卡片按内容撑高、盒子又变回内容高度。
- 视口偏移取 **260px**：它是设置页在本面板之上的固定开销（标题行 + 判定事实行 + tab bar，实测略低于 250px）。
  取"略宽裕"是有意的——面板矮几像素只损失几像素空间，而高几像素就是本轮要消掉的那根页面滚动条。常量
  `HISTORY_VIEWPORT_OFFSET` / `HISTORY_PANEL_HEIGHT` / `HISTORY_PANEL_MIN_HEIGHT`，面板上带
  `data-history-viewport-offset` 便于断言与排查。
- **没有加「列表 / 详情」segmented control**：`nowrap` + `1 1 0` 已满足「任何情况下不得堆叠」，再加一个
  "哪一栏可见"的状态维度会与「换文件复位」等不变量相乘，收益（窄屏各半仍可用）小于复杂度，故不做。

### 三、交互：点行即选 + 清除 + 单视图

- 每行 `data-action="history-row-pick"` + `onClick`（`title`/`data-history-pick-hint` 用 `histRowPickHint` 说明）。
  规则：**第一行 → from**（此时只选了一半，不发请求，右列保持空态）；**第二行 → to，随即发起 `GET /diff`**；
  **第三条起滑动窗口**（原 to 变 from、新行变 to）。点当前 from 行 ⇒ 清空一对；点当前 to 行 ⇒ 退回"只选了 from"。
- 行内 `diff-from` / `diff-to` / `history-preview` / `history-rollback` 四枚按钮保留作精确控制，并在 handler 里
  `stopPropagation`（真实浏览器里点击会冒泡，否则点按钮会连带重选整行；测试替身直接调 `onClick` 无事件，故守卫容忍
  缺失 event）。
- 新增 `data-action="diff-clear"`（对比视图头部，无可清除时 disabled）：恢复默认对 `{from: null, to: 'current'}`
  ——**与复位安装的那一对完全相同**，避免"清除后"和"刚打开"漂移——并丢弃对比结果，右列回空态。
- 右列三态**互斥**：`data-history-detail` = `empty` | `preview` | `diff`；预览渲染时**不再渲染** `history-diff`，
  空闲时**不渲染** `history-diff` 卡片（旧版是"卡片常驻、只是 idle"，会留下过期选择行）。预览关闭按钮改为
  `data-action="preview-close"`；关闭后若仍有对比选中就回到对比视图，否则回到空闲提示。点行/点清除同样会关掉预览
  （因为面板一次只显示一个视图）。

### 四、测试与负向对照

- **等价改写 1 条**：`client: the log renders inside a fixed-height scroll box (g-038)` ⇒
  `client: the log and the detail pane share one viewport-sized row, and scroll inside themselves (g-038 → g-039)`。
  覆盖（5000 条只渲染一页、内部滚动、页面不增高）一条没少，机制断言由「height 是数字且 maxHeight 相同」换成
  「nowrap + 无 px basis + 面板 = calc(100vh - offset) + 两盒 flex 撑满 + 无固定 height」。
- **等价改写 2 处**：`drops a comparison made in the other file` 里"对比卡片还在、只是 idle"的断言，改为
  「`history-diff` 完全不渲染 + 无 `data-diff-sections` + 空闲提示回来」——比旧断言更强（不再有过期内容可残留）。
- **新增 4 条**：① 点行建对比（from → to 并请求 → 滑动窗口 → 行内按钮仍可精确指定）；② 清除对比（回空态、选择清空、
  默认对恢复、可重新开始）；③ 三态互斥与关闭预览（预览时不渲染 diff，关闭后回对比，无对比时回空闲）；④ 切层同时
  复位预览与对比。
- **负向对照（真红后还原）**：① `flexWrap: 'nowrap'` 改回 `'wrap'` ⇒ 1 条红；② 行 `onClick` 置空 ⇒ 4 条红。
- 全量：`cd packages/dsh-prompt-setting && node --test` ⇒ **625 pass / 0 fail**（上一轮 621 + 新增 4，无回归无削弱）；
  `node --check client.js` 通过。宿主与 `core/` 本轮**未改动**，故 `index.js`/`core/history.js` 的字节不变断言
  （stage2 的 SHA-256 用例）继续原样通过。

### 五、「页面不再滚动」的验证依据与目视确认建议

自动化依据（`test/client.test.mjs`，改写后的那条用例）：
1. `history-tab` 的 `style.flexWrap === 'nowrap'` —— 两列不可能换行堆叠；
2. `style.height === style.maxHeight === 'calc(100vh - 260px)'` —— 面板高度由视口推导，不随记录数增长；
3. 两列 `flex` 不含 `px`、`minWidth/minHeight === 0`；两盒 `flex === '1 1 auto'`、`minHeight === 0`、
   `style.height === undefined` —— 盒子撑满剩余高度并在内部滚动；
4. 5000 条记录时 DOM 里仍只有一页 50 行。
CSS 语义上 1–3 合起来等价于"本 tab 的高度 ≤ 视口、内容只在列内滚"，因此页面不会因此产生纵向滚动条。

建议负责人的目视确认（3 步）：
1. 打开设置 → 「版本历史」：**页面右侧不应出现纵向滚动条**；把鼠标放在页面空白（头部/两栏之外）滚轮，页面不动；
2. 把鼠标放在记录列表上滚轮：**只有列表滚**；放在右侧详情上滚轮：**只有详情滚**；两栏始终左右并排；
3. 把窗口宽度缩到约 700px（设置对话框的实测宽度）：仍是左右并排（只是两列更窄），**不出现上下堆叠**。

### 六、未验证项

- 真机目视未做（本轮所有布局断言都在测试沙箱里按 DOM/样式属性做）：`calc(100vh - 260px)` 的偏移 260px 是按设置页
  头部实测估的，**若真机上仍出现页面滚动条，优先调大 `HISTORY_VIEWPORT_OFFSET`**（它只影响面板高度，不影响其它行为）。
- 宿主未重启（本轮纯客户端改动，宿主路由/参数/字节未动，契约 Revision 23 明记 "client-half only"）。
- 窄宽度（<620px）下两栏各 ~300px 的观感未验，只有"不换行"的机制断言。

## 118. g-039 四轮：面板高度从「硬编码偏移」改为「运行时测量」（Revision 24，2026-10-08，基线 `8e1b707` 工作区）

### 一、为什么必须改

三轮把面板高度定为 `calc(100vh - 260px)`，260 是**按设置页头部实测估的**。这个面板渲染在 DSH 设置对话框内部，
对话框自身的高度约束与内边距由壳层决定（`dsh-client-ui-settings` 包内没有高度定义，无法离线定案）。偏移估小
几十像素 ⇒ 面板超出可视区 ⇒ 页面/对话框又开始滚，正是本轮要消灭的症状原样复发。所以不再赌常量：**边界实测**。

### 二、实现

- **纯函数** `historyPanelHeight({panelTop, boundaryBottom, viewportHeight, minHeight, gap})` → `{height, source}`：
  - 边界 = 最近的可滚动祖先的 `rect.bottom`（向上找第一个 computed `overflow-y` 为 `auto`/`scroll` 的父元素，
    经 `getComputedStyle` 读，所以样式表里写的也算），找不到则用 `window.innerHeight`；
  - `height = Math.max(floor, Math.floor(boundary - panelTop - gap))`，floor 默认 `HISTORY_PANEL_MIN_HEIGHT`(320)，
    gap 默认 `HISTORY_PANEL_GAP`(16)；
  - **全域函数**：`panelTop` 缺失/`≤0`/`NaN`、边界不在面板下方、既无可观察祖先又无 `window` ⇒
    `{height: null, source: 'fallback'}`，渲染层据此回落到 `HISTORY_PANEL_HEIGHT` 常量。
    `panelTop <= 0` 视为"没测到"：未布局的元素报告全 0，而真实卡片一定在设置页标题之下。
- **组件接线**：`historyPanelRef` + `historyPanelPx` state；`useLayoutEffect`（运行时没有就退回 `useEffect`，绘制晚一帧）
  挂载时测一次、`window.resize` 再测；有 `ResizeObserver` 时同时观察父元素（对话框被拖动/改内边距而窗口没 resize 的场景）。
  **同值不 setState**（`setHistoryPanelPx(current => current === next ? current : next)`），否则观察者会自己喂自己。
- **诊断钩子**：根容器 `data-history-height-source`（`measured` | `fallback`）与 `data-history-panel-height`
  （px 数字或字符串 `fallback`）；`data-history-viewport-offset` 继续报告回落常量。测试沙箱渲染无真实布局 ⇒
  天然走 fallback，因此既有断言（`height === calc(100vh - offset)`）语义不变、只补了 source 断言。
- **测试通道**：浏览器 bundle 没有导出，纯函数通过 factory 返回值的 `__internals.historyPanelHeight` 暴露
  （loader 只读 `inject`/`apply`，页面从不读它）。测试替身补了 `useRef` 预设（`options.refs`）与
  `window` 注入（`innerHeight` / `getComputedStyle` / `addEventListener`），用于 measured 与 resize 用例。
- 布局与交互**一律不动**：`nowrap`、两列 `1 1 0`、两盒 `1 1 auto; minHeight: 0`、点行即选、`diff-clear`、
  `preview-close` 全部保持；「换文件复位 / 翻页不复位」与本轮无关（面板高度不属于文件级状态）。

### 三、测试与负向对照

- 新增 3 条：① 纯函数（正常测量 / 无祖先用 viewport / 下限钳制 / gap 先减后钳 / 10 组不可用输入 ⇒ fallback）；
  ② measured 渲染（假元素 + 可滚动祖先 ⇒ `data-history-panel-height === '684'`，`height === '684px'`，布局规则不变）；
  ③ `window.resize` 重测（边界下移 ⇒ 484；边界移到面板上方 ⇒ fallback，布局规则仍在）。
- 等价改写：`test/client.test.mjs` 里那条视口布局用例补上 `data-history-height-source === 'fallback'` 与
  `data-history-panel-height === 'fallback'`（覆盖一条未少，机制断言由"固定 calc"扩展为"fallback=calc、measured=实测值"）。
- **负向对照（真红后还原）**：① 去掉 `Math.max(floor, …)` 钳制 ⇒ 纯函数用例 1 红；② 让测量结果永远走 fallback
  ⇒ measured + resize 两条用例红。
- 全量：`cd packages/dsh-prompt-setting && node --test` ⇒ **628 pass / 0 fail**（三轮 625 + 3，无回归无削弱）；
  `node --check client.js` 通过。宿主与 `core/` 未改动。

### 四、真机上若仍滚，现在怎么调

1. 先读钩子：打开「版本历史」，在面板根节点（`[data-region="history-tab"]`）看
   `data-history-height-source` 与 `data-history-panel-height`。
   - `measured` + 一个明显偏大的数字 ⇒ 可滚动祖先不是对话框那一层（可能命中了更外层），或祖先的 bottom 本身就是
     页面底边；此时往下看第 3 步。
   - `fallback` ⇒ 说明测量不可用（取不到祖先且 `window.innerHeight` 也不可用，或 `panelTop <= 0`），走的是常量路径。
2. 若是 `measured` 但只差几十像素（贴在滚动条边缘），调大 `HISTORY_PANEL_GAP`（`client.js` 常量区，默认 16）
   —— 它直接从可用高度里扣掉，是最贴切的旋钮。
3. 若是 `fallback`，或 `measured` 的数字明显不合理，调 `HISTORY_VIEWPORT_OFFSET`（`client.js` 常量区，默认 260）：
   它决定 `HISTORY_PANEL_HEIGHT = calc(100vh - 260px)`，只影响回落高度，不动其它行为。
4. 下限 `HISTORY_PANEL_MIN_HEIGHT`（默认 320）只在"可用高度比它更小"时生效；真机上若出现"面板比可视区还高"，
   先确认不是这个下限在顶——它是有意为之（宁可滚也不给两条没用的缝）。

### 五、未验证项

- **真机目视仍未做**：`getComputedStyle` 找到的"最近可滚动祖先"到底是不是设置对话框那一层，只能在真机上读钩子确认；
  本轮所有断言都在沙箱里用假元素完成。
- `ResizeObserver` 分支未被测试覆盖（沙箱无该构造器，只有 `typeof` 守卫与真实浏览器路径）；只有 `window.resize` 有断言。
- 宿主未重启（本轮纯客户端改动）。

## 119. g-039 五轮：废弃左右两栏，列表独占宽度，预览/对比改视口弹窗（Revision 25，2026-10-08，基线 `b8ddcb6` 工作区）

### 一、真机反馈与根因

负责人真机反馈「左右视图导致左侧信息拥挤」：两栏把记录列表压到约一半宽度，而行内要塞下编号、动作标签、段名、
时间戳和四枚按钮——半幅宽度下每行都挤。第三轮为了「选择与结果同屏」引入两栏，方向本身没错，但代价（列表变窄）
在真机上一眼可见；而右列同一时刻只显示预览或对比其中之一，用整块常驻宽度换它是亏的。本轮把内容搬到**视口弹窗**，
列表回到独占宽度。

### 二、布局与形态（纯客户端）

- **单栏**：`renderHistoryTab` 现在是 `flexDirection: 'column'` 的单列容器（`data-history-layout="single"`），
  唯一子节点是列表面板 `data-region="history"`。**删除**了 `data-history-columns`、
  `data-region="history-list-column"` / `history-detail` / `history-detail-box`、`data-history-detail`、
  空闲提示 `data-note="history-detail-pending"` 与 `data-action="preview-close"`——不留半成品结构。
  第四轮的**面板高度测量**（`historyPanelHeight` + `data-history-height-source` / `data-history-panel-height`）
  原样保留，只是现在给单栏列表定高；列表盒仍是 `flex: 1 1 auto; minHeight: 0; overflowY: auto`。
- **两个视口弹窗**（沿用 g-031 的 confirm-overlay 模式，但不复用同一个 DOM）：
  - 浮层 `data-region="history-modal-overlay"` + `data-history-modal`，`position: fixed`、居中、暗底；
  - 对话框 `data-region="history-preview-modal"` / `"history-diff-modal"`，`role="dialog"` + `aria-modal="true"`
    + `aria-label`，`width: min(1040px, 92vw)`、`height: maxHeight: min(82vh, 900px)`、`overflowY: auto`
    （长内容在**弹窗内部**滚）；
  - **关闭入口**：头部 `data-action="history-modal-close"`（`aria-label`/`title` = `histModalClose`）+ **Esc**
    （弹窗打开期间由页面绑定 `keydown`）。两种方式都只关弹窗、**保留选择**。
  - **互斥**：由单一状态 `historyModal`（`null | 'preview' | 'diff'`）决定，同一时刻最多一个。
  - **页面锁**：弹窗打开时 `document.body.style.overflow = 'hidden'`，关闭时恢复为**原来的确切值**（用 ref 记住，
    而不是写成 `''`）；effect 两个方向都跑，cleanup 也兜底（卸载时不会把页面锁住）。

### 三、交互联动

- 点记录行仍是主路径：第一行 = `from`（不发请求、不开弹窗），第二行 = `to` ⇒ 发 `GET /diff` **并自动弹出对比弹窗**；
  **关闭弹窗保留这一对**；再点第三条 ⇒ 滑动窗口（原 to→from、新行→to）**并重新弹出**。
- 行内四枚按钮保留作精确控制（`diff-from` / `diff-to` / `history-preview` / `history-rollback`），并 `stopPropagation`。
- 「预览」按钮开预览弹窗（**零请求**，内容随列表那一页一起到达）；不再有"再点一次关闭"的 toggle，
  关闭只走关闭按钮/Esc。
- 「清除对比」`data-action="diff-clear"` 在对比弹窗内：恢复默认对 `{null,'current'}`、丢弃结果、**并关闭弹窗**。
- 换文件（切 layer / 切作用域）复位 offset + `diffSel` + diff + **弹窗态**；翻页仍不复位。

### 四、测试与负向对照

- **按新形态改写 8 条既有用例**（覆盖一条未少）：单栏结构（不再有并排两列/右列详情盒，替换第三轮那条
  "两栏并排"用例）、预览弹窗（含关闭按钮、零写请求）、翻页保留预览与 missing 态、点行建对并自动弹窗、
  清除对比、弹窗互斥与 Esc、切层/切作用域复位（含弹窗态）、measured 渲染与 resize 重测的布局断言。
  g-038 的两条复位用例里 `data-history-detail` 断言改为"无弹窗 + 无 diff 残留"。
- **新增 1 条**：`an open modal locks the page behind it, and unlocks it exactly` —— 断言浮层 `position: fixed`、
  对话框 `height/maxHeight = min(82vh, 900px)` 且 `overflowY: auto`、打开时 `body.style.overflow === 'hidden'`、
  关闭后恢复为原值 `'visible'`（含对比弹窗同样上锁）。
- **测试基建**：替身支持 `document` 注入（body 锁断言用）；`window` 注入已有（`innerHeight` /
  `getComputedStyle` / `addEventListener`）。EN 扫描的历史用例现在先开预览弹窗、关闭、再开对比弹窗，
  `EN_REQUIRED_MARKERS` 用 modal 三个标记替换了已删除的 `data-region=history-detail`。
- **负向对照（真红后还原）**：① 去掉 `body.style.overflow = 'hidden'` ⇒ 页面锁用例 1 红；
  ② 让"选满两条"不再自动开弹窗 ⇒ fifth round 5 条红。
- 全量：`cd packages/dsh-prompt-setting && node --test` ⇒ **629 pass / 0 fail**（四轮 628 + 新增 1，
  改写的 8 条覆盖未减）；`node --check client.js` 通过。宿主与 `core/` 一字节未动。

### 五、「弹窗打开时页面不滚动」的验证依据与目视确认

自动化依据（`test/client.test.mjs` 的页面锁用例）：
1. 浮层 `data-region="history-modal-overlay"` 的 `style.position === 'fixed'`（不进入文档流，不产生页面溢出）；
2. 对话框 `style.height === style.maxHeight === 'min(82vh, 900px)'` 且 `overflowY === 'auto'`（内容在弹窗内滚）；
3. 打开时 `document.body.style.overflow === 'hidden'`（页面被显式锁住），关闭后**恢复为原来的确切值**。

建议负责人的目视确认（3 步）：
1. 打开「版本历史」→ 点某行的「预览」：弹窗居中浮出，**页面滚动条不应因它而变化**；鼠标放在页面（弹窗之外）
   滚轮：页面不动；
2. 在弹窗内部滚轮：**只有弹窗内容滚**；点右上「✕」或按 **Esc**：弹窗消失，列表选择仍在；
3. 点两条记录（选满一对）：对比弹窗自动弹出；关掉它，两行的 `from`/`to` 高亮**仍在**；再点第三条：
   高亮变成新的两条并再次弹窗。

### 六、未验证项

- 真机目视未做（弹窗宽度 `min(1040px, 92vw)` 在设置对话框里的观感、`min(82vh, 900px)` 高度是否顶到边缘、
  Esc 在宿主对话框里的按键捕获是否被外层拦截）——三条都只能在真机确认。
- 宿主未重启（本轮纯客户端改动）。
- `ResizeObserver` 分支仍无测试覆盖（沙箱无该构造器）。

## 120. g-039 六轮：弹窗细节收口 6 条（Revision 26，2026-10-08，基线 `52904c8` 工作区）

### 一、真机反馈的 6 条与处理

1. **关闭按钮移到弹窗右上角**：对话框加 `position: relative`，`✕` 换成
   `position: absolute; top: 10; right: 10`（`data-action="history-modal-close"` 与 `aria-label`/`title` 不变），
   标题行只剩标题。按钮不再受标题长度或滚动位置影响。
2. **「清除对比」移出弹窗**：`data-action="diff-clear"` 从 `renderDiffModal` 移到列表区的
   `data-region="history-diff-tools"`（作用域块之后、列表之前），`disabled` 条件不变（`from===null && to===DIFF_CURRENT`）。
   弹窗 DOM 内**不再有** `diff-clear`（负向断言）。理由：作用于"列表的选择"的控件不该藏在弹窗里，
   而弹窗开着时用户看不到列表，也点不到它。
3. **弹窗内时间本地化**：预览弹窗的 `at` 从"原始 UTC 串"改为 Revision 18 的唯一路径 `stampOf()`，
   与列表行**同一函数**；原始 UTC 串仍挂在节点 `title`（与行内做法一致）。对比弹窗内目前不渲染时间
   （只有段/行差异），故无第二处需要改。
4. **删「对比」弹窗内的操作说明**：`histDiffHint` 整段与**文案键**一起删除（zh/en），
   它描述的"行内两枚小按钮"本轮已不存在。
5. **去掉行内两枚 from/to 按钮**：记录行与「当前生效值」行的 `diff-from`/`diff-to` 全部删除；
   `pickDiffSide` action 删除；`histPickFrom`/`histPickTo` 键删除；`sideStyle` 仍被
   `history-preview`/`history-rollback` 两枚按钮使用，保留。「当前生效值」行改为
   `data-action="history-row-pick"` + `onClick: pickHistoryRow(DIFF_CURRENT)` + `cursor: 'pointer'`，
   因此它仍可被选入对比（点一次是取消默认的 `to`、再点一次成为 `from`，语义与其它行完全一致）。
6. **列表区补操作引导**：作用域说明行（`data-role="history-scope-note"`）**下一行**新增
   `data-role="history-compare-hint"`（新键 `histCompareHint`，zh/en 对齐），说明"点两条记录自动对比、
   第一条为 from、第二条为 to、之后滑动窗口；点行内「预览」看单条"。弹窗内**不再出现**同类说明。

### 二、测试与负向对照

- **既有用例等价改写 9 条**（覆盖一条未少）：依赖 `diff-from`/`diff-to` 的 4 条主用例
  （两条记录对比、live value 在任一侧、无法行级比较的说明、primitives 分支）改为"点行"（哪一条先点决定 from/to）；
  g-038 的两条复位用例与 g-039 的单栏、建对用例同样改写；「清除对比」用例改为在**列表区**点 `diff-clear`。
- **新增 5 条**：① 关闭按钮在右上角（`relative`/`absolute` + `top`/`right`）且能关闭、弹窗内无操作说明；
  ② 弹窗内**无** `diff-clear`、列表区**有**且能清空回空态；③ 预览弹窗的时间与列表行**同一文本**、
  且不出现原始 UTC 串（后者仍可从 `title` 取到）；④ 行内不再有 from/to 按钮、点「当前生效值」行可即选；
  ⑤ 作用域说明下一行确为对比引导，且清除控件在列表区。
- EN 扫描：历史用例改走"点行 + 点当前生效值行"，`copy` 列表里的 `histPickFrom` 换成 `histCompareHint`，
  `EN_REQUIRED_MARKERS` 增补 `data-region=history-diff-tools` / `data-action=diff-clear` /
  `data-role=history-compare-hint`。
- **负向对照（真红后还原）**：① 关闭按钮改回 `position: static` ⇒ 第 1 条红；② 预览弹窗的 `at` 改回原始
  UTC 串 ⇒ 第 3 条红。
- 全量：`cd packages/dsh-prompt-setting && node --test` ⇒ **634 pass / 0 fail**（五轮 629 + 新增 5，
  改写的 9 条覆盖未减）；`node --check client.js` 通过。宿主与 `core/` 一字节未动。

### 三、「弹窗时间已本地化」的断言位置（可一眼复验）

`test/client.test.mjs` → `client: the preview dialog renders a timestamp the way a list row does (g-039 sixth round)`：
- 先取 `const expected = localStampOf('2024-01-02T10:00:00.000Z')`（测试自带的本地时区渲染 helper），断言**列表行**
  含该文本；
- 再断言预览弹窗的 `data-preview-field="at"` 节点含**同一文本**（字符级一致）；
- 断言该节点的全部字符串**不含** `2024-01-02T10:00:00.000Z`；
- 断言 `title` 恰好是 `2024-01-02T10:00:00.000Z`（原始 UTC 串只作 title）。

### 四、未验证项

- 真机目视仍未做：关闭按钮在右上角的视觉位置、`history-diff-tools` 在列表区的排布、新引导行的行宽观感。
- 宿主未重启（纯客户端）。`ResizeObserver` 分支仍无测试覆盖。

## 121. 版本号 `0.1.4` → `0.1.5`：同步点与白名单依据（g-040，2026-10-08，基线 `7efde96` 工作区）

### 一、同步的「本包当前发布版本」（18 处 / 8 文件）

- `package.json` 的 `version`、`index.js` 的 `PLUGIN_VERSION`（2 处 / 2 文件）；
- `CONTRACT.md` 5 处：§10 export 示例 2 处（`plugin.version` / `pluginVersion`，1582-1583）、§13.8 版本节点
  文案（`v0.1.4` → `v0.1.5`）、§13.9 ping 示例的 `version`、§17 update-check 示例的 `current`；
- 两份根 README 4 处：徽章各 1 处 + CHANGELOG 行表述各 1 处（`currently 0.1.4, unpublished` /
  `当前 0.1.4，尚未发布`）；
- 测试硬字面量 7 处 + **转义正则 1 处**（共 8 处）：`test/stage2.test.mjs` export 断言 2 处、
  `test/client.test.mjs` update-check fixture 的 `current` 1 处 + export fixture 2 处 +
  banner 渲染断言 `/0\.1\.4/` 1 处、`test/update.test.mjs` ping 断言 1 处。
- 机械清单（supervisor 给的 17 处）**不含** banner 那处转义正则，见第二节——它是本轮唯一的「清单外」同步点，
  且不改必然红，属升版必需而非顺带扩大改动面。

### 二、升版盲点（§111 的教训在本轮再次成立）

- 位置：`test/client.test.mjs:8041`，`assert.match(strings(tree).join(' '), /0\.1\.4/)`。源码里是**转义正则**，
  普通 `grep -rn "0\.1\.4"`（正则 `0\.1\.4` 匹配字面 `0.1.4`）**扫不到** `0\.1\.4` 这种带反斜杠的写法。
- **实测证据（天然负向对照）**：先按 17 处清单改完即跑全量 ⇒ **633 pass / 1 fail**，失败正是
  `client.test.mjs:8029`「a newer release renders a dismissible banner…」，期望 `/0\.1\.4/`、实际渲染
  `（当前 0.1.5）` ⇒ 该断言确实钉住「当前版本」，非空转；改后 **634 pass / 0 fail**。
- **下次升版务必照做**：残留扫描同时跑 `grep -rnF '0\.1\.'`（固定串，能命中 `0\.1\.4` 形态），或直接跑全量
  测试兜底——只跑正则 grep 会重演本轮。

### 三、白名单判断依据（一律未动）

- `CHANGELOG.md` 的 `[0.1.4]` 及更早历史段、`NOTES.md` 历史叙述（含 §111 的 `0.1.3`→`0.1.4` 记录）：历史记录；
- `core/install.js` 的「announce 旧版、install 新版」示例（g-037 已确立先例，§111 第二节）：**故意让两个版本号
  不同**才说明「宣布的版本与安装的版本必须同源」⇒ 保留。本轮实测该文件**不含** `0.1.4`（示例里的两个版本号
  早已是别的值），故它在本次扫描里天然无命中，依据仍记录在案；
- `test/update.test.mjs` 的 semver 比较数据与 `currentVersion` 默认值、`core/update.js` / `CONTRACT.md` 的
  tag 形态举例（`v0.1.2`/`v0.2.0`）：与「本包当前版本」无关（§110/§111 已裁定）。

### 四、CHANGELOG 定稿

新增 `## [0.1.5] - 2026-10-08`（中英对照），置于 `## [0.1.4]` 段之前：`### Added 新增` 5 条
（拆 tab、历史作用域与查看范围解耦、列表分页与整屏内滚、记录预览与一键回滚、预览/对比改视口弹窗）、
`### Changed 变更` 1 条（版本号同步本身），`[0.1.4]` 及更早段一字未动。

### 五、验收

- `cd packages/dsh-prompt-setting && node --test` ⇒ **634 pass / 0 fail / skipped 0**（与升版前基线一致，
  无断言削弱）；升版中途的 633/1 见第二节；
- `node --check index.js` 通过；
- 残留自查 `grep -rn "0\.1\.4" --include=... | grep -v node_modules | grep -v .worktrees | grep -v .dsh-graph
  | grep -v CHANGELOG.md | grep -v NOTES.md` ⇒ **空**；
- `npm pack` ⇒ **`dsh-prompt-setting-0.1.5.tgz`**：**24 文件**、`test/` 命中 **0**、包内
  `package.json.version` = `0.1.5`、`prepare` 自检 **19 项通过**、体积 **≈568 KB**（**不要记精确字节数**：
  `NOTES.md` 在本包 `files` 白名单内，本节每修一次字包体就跟着变）。
  **24 vs 上版 23 的 +1 = `core/launch-kind.js`**（g-036 新增文件；§111 打包时 g-036 尚未落地，故那次的 23
  文件不含它），与本次升版无关。
- 环境注记：本机 `~/.npm/_cacache` 内有 root-owned 文件，`npm pack` 直跑报 `EPERM`；本轮改用
  `npm pack --cache <可写临时目录>` 完成打包（`prepare` 自检与打包本体均正常）。这与本包无关，记录以免下次
  误判为包缺陷。

### 六、未验证项

- `npm publish` / `git tag` / `git push` 未做（人工 gate）；提交由主管统一收口，本轮不 commit；
- README 徽章的 shields.io 在线渲染未目视（离线），只核对了源文本；
- 只改了表示「本包当前版本」的字面量，无任何产品逻辑改动 ⇒ 无行为回归面。

---

## 122. g-045 阶段一：`client.js` 拆出包内 chunk（「版本历史」按需加载），构建戳覆盖到 chunk（2026-10-08，基线 `e54d1d5` 工作区）

目标 g-045 阶段一：把 10249 行的单文件客户端拆成「主入口 + 包内 chunk」，**不引入构建步骤、不新增运行时依赖**，先打通机制并迁一个重块作样板。阶段二（无状态层与其余 51 个渲染函数）不在此列。

### 一、形态：DSH 原生 chunk，不是自写拼接构建

调研（`card-3812ad36`）确认 DSH 客户端模块系统原生支持「单入口 + 包内 chunk」，且官方已有两个先例
（`dsh-client-ui-sidebar-terminal` 的 `lib/client.js` + `lib/client.terminal.js`、
`sidebar-documentpreview` 的 `client.excel.js` / `client.pdf.js`）。落地要点：

- chunk 文件名必须匹配 `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$`（**不含 `/`**），且必须**平铺**在 `client.js` 同目录；
- 主入口用 `require.async('./client.history.js')` + `React.lazy` 按需取；
- chunk 自己 `window.__ModuleLoader__.load({ id: 'dsh-prompt-setting', chunk: 'client.history.js', factory })`；
- **方向必须是 DAG**：主 → chunk 走 `require.async`（异步），chunk → 主走 `require('dsh-prompt-setting')`（此时主 factory 已物化）。循环依赖在 loader 里是**致命错误**（`require cycle … cannot deliver partial exports`），不是警告。

`package.json` 的 `files` 因此改为通配 `client.*.js`（对齐官方 `lib/client.*.js` 写法）：新增 chunk 不需要改 manifest。
`core/prepare.js` 的 `files` 自检原先只认字面路径与目录，本轮补上**模式条目**分支（`FILES-GLOB`：按包根匹配，匹配不到即 FAIL）——
否则一个正确的通配写法会被发布门禁判成「文件不存在」，把好包挡在门外。

### 二、指纹：主 factory 摘要 + chunk 清单 + 每 chunk 实测摘要

**问题**：`factory.toString()` 看不到 chunk 的字节，拆分后「改了 chunk 而戳不变」＝静默假「一致」。这是本次最关键的隐性破坏面。

落地（三层，全部有负向对照测试）：

1. **每个源文件自带一对 marker**（主文件与每个 chunk 各一对，位于各自 factory 体内）。host 对文件求 region 摘要，页面侧对
   `chunkFactory.toString()` 求同一段 region —— 与主文件完全同构，因此单个 chunk 的摘要口径天然一致；
2. **主文件 region 内嵌清单 `CHUNK_STAMPS`**（`{name, hash, size}`）。它在 region 内 ⇒ 属于主戳：新增/改名/删除/手工改清单都会移动**主**摘要；
3. **host 在 ping 里报 `clientBuild.chunks`**（主机对每个 chunk 文件求的 region 摘要），页面逐项比对清单，并把**自己真正加载过的** chunk 自报摘要
   （chunk factory 里的 `SELF_BUILD`，经 exports 回传给主入口）一并比对。

三态语义保持 `data-build-match` 的 `true` / `false` / `unknown`，新增 `data-build-loaded`（已加载 chunk 的 `name:hash` 列表）：
主摘要不一致、任一 chunk 摘要不一致 ⇒ `false`；**两边 chunk 清单对不上（覆盖不全）或列表格式非法 ⇒ `unknown`，绝不显示「一致」**；旧 host 不带 `chunks` 字段时保持拆分前的答案（不加载 chunk 时按主摘要判，已加载过 chunk 后变 `unknown`）。
清单与磁盘的一致性由 `test/build.test.mjs` 断言兜底，`scripts/client-chunks.mjs`（`--write` 就地重写清单，无参数则校验）是唯一的修复入口 —— 它是开发期工具而非构建步骤：chunk 与主文件本身就是发布物。

### 三、开发期限制（务必记住）

**chunk 的 URL 用的是 owner（`client.js`）的 rev**，而该 rev 由 `client.js` 的 mtime/ctime/size 推导
（`dsh-client-modules` 的 `artifactRevision` + `chunkUrl`）⇒ **只改 chunk、不碰 `client.js` 时，浏览器不会换新 chunk**（同一 URL + immutable 响应）。
开发期请连带 `touch client.js` 或重启宿主；发布期不会发生（改 chunk 必然意味着清单也要改，而清单在主文件 region 内）。
另：本机 `~/.npm/_cacache` 有 root-owned 文件，`npm pack` 需 `--cache <可写目录>`（同 §121 环境注记）。

### 四、harness 与断言

`test/client.test.mjs` 的 `load` stub 原先只保留最后一次注册、require stub 对未知名字直接抛错 —— 拆分后这两处不改就是**全部测试挂**。本轮改为：
收集多次注册（按 `<id>/<chunk>` 索引）、`require.async` 从磁盘读 chunk 并在**同一 sandbox** `vm.runInContext` 后返回其 exports、
`require('dsh-prompt-setting')` 解析到主模块 exports、`React.lazy` / `Suspense` 双实现（同步 thenable，使既有同步 `expandTree` 断言全部保持原样）；
文本级断言（版本字面量 / `github.com` / 无 JSX）扩到全部 chunk。`test/build.test.mjs` 的 region 断言按新语义重述：
不再宣称「region 覆盖整个 factory body / size > 100000」，改为「region 覆盖主 factory 首尾 + 清单在内」，保留「两个标记各恰好一次、有序」不变式，并新增 chunk marker、清单一致性、单字符改动的负向对照。

### 五、验收

- `cd packages/dsh-prompt-setting && node --test` ⇒ **731 pass / 0 fail / skipped 0**（基线 710；新增 21 条：chunk 机制/按需加载/失败路径/`require` 主入口/指纹 chunk 维度/清单与发布面/订阅通知/发布门禁/目录级 glob/两条降级分支）；
- 体积（**收口后实测**，`wc -l -c client.js client.history.js`）：`client.js` 10249 行 / 484930 B → **9584 行 / 456680 B**（净减 665 行 / 28250 B）；`client.history.js` **1163 行 / 50497 B**（约 49.3 KB 由首屏改为按需加载）；两者合计 10747 行 / 507177 B —— 总量略增，因为主文件里多了 chunk 边界机制与清单（约 350 行），换来的是「版本历史」不再进首屏；
- `npm pack --dry-run --cache /tmp/...` ⇒ chunk 在包内（`client.history.js`），`scripts/client-chunks.mjs` 随包发布，26 个文件；
- `node scripts/prepare.mjs` ⇒ **21 项通过**（含 `FILES-GLOB: files: client.*.js（1 项：client.history.js）` 与新增的 `CHUNK-STAMPS` 门禁）；
- 零新依赖（`dependencies: {}`）、零构建步骤（`test/host.test.mjs` 两条门禁继续绿）。

### 六、真机回归：`data-build-loaded` 曾经滞后（返工记录）

**缺陷**（主管真机端到端发现，离线 harness 测不到）：`recordLoadedChunk()` 写在 `React.lazy` 的 resolve 回调里，即**渲染期**；
而 `data-build-loaded` 与 `buildVerdict()` 的第三重循环都在**渲染 root 容器**时求值。chunk 加载只让 Suspense 子树重渲染，
不会让 root 重渲染 ⇒ 停在「版本历史」tab 的读者会看到 `data-build-loaded="none"`、`data-build-match="true"`，
要切一次 tab（或任何别的 state 变化）才更新。后果不只是显示不准：**第三重校验——唯一能发现「浏览器实际运行的 chunk 字节 ≠ 宿主 serve 的字节」的那一重——在最需要它的场景下不生效**。

**修复**：给 root 加一个 `useSyncExternalStore(subscribeChunkLoads, chunkLoadRevision, chunkLoadRevision)` 座位
（与既有的 locale revision 座位并列，仍在 `useState` 之前，hooks 顺序稳定）。`loadedChunks` 变化时 `chunkLoadCount += 1`
并通知订阅者；快照是**计数器**而不是 Map/新数组（`useSyncExternalStore` 要求渲染间稳定的值）。
通知走 `queueMicrotask`（引擎没有时同步回退）——`recordLoadedChunk` 在渲染期被调用，直接 setState 会是「渲染期更新」。

**真机证据**（临时 `DSH_HOME` + `dsh web --port 3099` + headless Chrome over CDP；脚本用 `Fetch` 域在 Response 阶段改写 chunk 响应）：

| 场景 | 观察 | 结论 |
| --- | --- | --- |
| 正常打开「版本历史」，**不切 tab** | 打开前 `data-build-loaded="none"` / `match="true"`；打开后 `client.history.js:2887cc6c` / `true`，`data-active-tab="history"` | 修复生效；chunk 请求真实发生（`/plugins/dsh-prompt-setting/client.history.js?rev=11d5d7dab4ad`） |
| 把 chunk 响应在**指纹区间内**加 49 字节，再不切 tab | `data-build-loaded="client.history.js:67d2092d"`（运行字节的真实摘要）、`data-build-match="false"` | 第三重校验真的生效（改坏就红），且随 chunk 到达即时更新 |
| 阻断 chunk 请求 | `data-region="chunk-failure"` 出现、`data-render-state="ok"`、`data-build-loaded="none"` | 失败降级可读、不白屏、不谎报已加载 |

**发布门禁**：`scripts/prepare.mjs` 新增 `CHUNK-STAMPS` 一项（既有 20 项一字未动，共 21）：清单与磁盘 chunk 摘要不符即
`prepare` 失败并提示 `node scripts/client-chunks.mjs --write`。理由：「改了 chunk 忘了 `--write`」是这套机制里最容易发生、
后果是用户侧指纹失真的动作，而测试只有有人跑测试时才拦得住 —— `prepare` 是安装/发布路径上的门。

### 七、未验证项

- 真机只覆盖了 dev 宿主（临时 `DSH_HOME`）与 headless Chrome：**「只改 chunk 不碰 `client.js` 时 HMR 不换新」仍未做端到端实测**
  （由 `artifactRevision`/`chunkUrl` 的代码路径推出，§三 已标注为限制）；失败卡片只有 DOM 级核对，无视觉截图；
- 阶段二的其余重块（总览/作用域树/传输/mine、无状态层）未迁，属另一个目标。

### 八、收口补丁（独立评审 5 条）

- **F1 · 文档数字回填。**（五）里原来的体积与用例数是返工前的快照。已回填为收口后实测：`client.js`
  **9584 行 / 456680 B**、`client.history.js` **1163 行 / 50497 B**、`node --test` **731 pass**（新增 21 条）。
  依据：量化证据一旦滞后，后来人就没法用它判断「这是哪一版字节」，而本次机制的全部价值正是自证版本。
- **F2 · 契约与代码对齐。** §14.3 原写「`chunks` 存在但非法一律 unknown」，实现把 `chunks: null` 当「老宿主无清单」
  （未加载 ⇒ `true`、已加载 ⇒ `unknown`）。**选择改契约而不是改实现**（保留对旧宿主的兼容意图）：`absent` 与
  `null` 同为「无清单」；`[]` 是「我确实不 serve chunk」的**声明**，按清单逐项比对；只有既非 absent/null、
  又不是 `{name, hash}` 字符串数组时才整份拒绝 ⇒ `unknown`。补断言锁住 `null` 与 `[]` 的区别（后者与声明了 chunk 的
  清单必然对不上 ⇒ `unknown`）。
- **F3 · 不可达回退不再是同步 flush。** `notifyChunkLoad` 在 `queueMicrotask` 不可用时原为同步 flush —— 那等于允许
  「渲染期更新」，正是延后通知要避免的东西。改为 `setTimeout(flush, 0)`（同样异步、同样保证在本次渲染之后）。
  真实引擎都有 `queueMicrotask`，这条不可达；**正因为不可达才更该写对**。
- **F4 · 目录级 glob。** `core/prepare.js` 的 `files` 模式校验原先只按包根匹配，`core/*.js`（以及官方的
  `lib/client.*.js` 写法）会误报 `FAIL`。改为按最后一个 `/` 拆出目录、**在该目录内**匹配（目录部分本身含通配符时
  回退为整路径匹配），并补测试：`core/*.js` 命中 `core/a.js`、不命中 `b.txt`，目录不存在仍 `FAIL`。
- **F5 · 两条降级分支补测。** ① `require.async` 缺失（loader 没有 chunk 通道）；② `HAS_REACT_LAZY === false`
  （React 无 `lazy`/`Suspense`）。各一条：页面照常渲染、该 tab 渲染可读卡片、`data-build-loaded` 保持 `none`、
  且**不发请求**（没有通道就不该发）。

---

## 123. g-046 阶段二：其余三个 tab 的渲染器迁成按需 chunk（2026-10-08，基线 `355ad3f` 工作区）

目标 g-046 阶段二：复用 g-045 已交付并验证的 chunk 机制，把展示层里**尚未进首屏**的大块继续外提。**不引入构建步骤、不新增运行时依赖、不改状态机结构。**

### 一、切分：能拆的只有三个非默认 tab

对**全部**顶层渲染函数做了闭包测算：逐个判断它是否在首屏 `renderSection` 的同步调用链上。可复现口径（本 commit 实测）：

```bash
grep -h "^ *function [A-Za-z0-9_$]*(t, m, a)" client.js client.*.js | wc -l   # ⇒ 28
#   主文件 13 + client.overview.js 4 + client.transfer.js 2 + client.advanced.js 4 + client.history.js 5
```

（签名带额外参数的变体，如 `renderDownloadRegion(t, m, a, u)`，不计入上表；阶段一 §122 沿用的「51 个」取自结构测绘卡对**全部顶层定义**的另一种统计口径，与本条命令不可互推 —— 本 commit 起以本条为准。）
结论是「按 tab 拆」只有三个候选：

| 新 chunk | 装了什么 | 行数（`wc -l`，含 shared 解构与 lazy 样板） |
| --- | --- | --- |
| `client.overview.js` | `renderOverviewPanel` / `renderSectionsView` / `renderFilters` / `sectionRow` / `renderFullView` | 577 |
| `client.transfer.js` | `renderBackupTab` / `renderTransferPanel` / `importStatusLabel` | 264 |
| `client.advanced.js` | `renderAdvancedTab` / `renderOverridesList` / `renderUpdateSetting` / `renderDownloadRegion` / `renderLayerReset` / `regionNoteKey` | 502 |

留在主文件的骨架（首屏第一帧就会走到）：`renderSection`、`renderPluginVersion`+`renderStatusDetail`、`renderStatusLine`、
`renderSession` 与作用域选择器一族（`scopeSection` / `scopeTreeElement` / `scopeGroupParts` / `pinnedSessionButton` / 两个 glyph / `scopeRowStyle` / `focusVisibleOf`；
`awk '/^    function focusVisibleOf\(/,/^    function renderSession\(/' client.js | wc -l` ⇒ 643 行）、
`renderUpdateNotice` + `renderUpdateApplyStatus`、`renderConfirm` / `renderRegionDialog`，以及默认 tab 的 `renderMinePanel`。

### 二、被否的方案（逐条给理由）

- **「我的 Prompt」(mine) 不做 chunk。** 它是设置页的**默认 tab**：第一帧就要渲染。做成 chunk 只会在首屏代码前加一次网络往返，
  并把一次失败取件变成「默认 tab 空白」。判据 2 的「打开设置页只请求主文件」正是这条。
- **无状态层（常量 / `ERROR_TEXT` / zh+en 两份字典 / token / `Fx*` 原子 / 纯函数群）留主文件。** 外提必须同时满足「首屏不因此多一次阻塞等待」与
  「共享 chunk 失败可读降级」：而 factory 是**同步物化**的，主文件渲染第一帧就需要这些值，`require.async` 只能异步 ⇒ 条件①**结构上不可满足**；
  条件②更糟——共享 chunk 失败会让**整页**既无文案表也无 token，而 tab chunk 失败只影响一个 tab（风险不对称）。
- **确认弹窗与镜像对话框（`renderConfirm` + `renderRegionDialog` + 5 个 confirm 样式常量）不做 chunk。** 它们确实「交互后才出现」，
  但那是**破坏性操作**（恢复默认 / 清空覆盖 / 立即更新）的确认面：把「点击 → 弹窗」变成一次异步取件不值得。
- `renderLayerReset` 同时被「高级」使用，`renderFilters` 只服务总览视图，`importStatusLabel` / `regionNoteKey` 各只有一个消费者 ⇒ 各随其 tab 走，
  于是三个新 chunk 之间**零依赖**：DAG 只有「主 → chunk」一个方向。

### 三、共享设施：零副本，仍是同一实例

新 chunk 需要的常量与纯函数（`LAYER_FILTERS` / `ORIGIN_FILTERS` / `OVERRIDABLE_FILTERS` / `MAX_VIEW_LINES` / `splitLines` / `highlightNodes` / `chunkDiff` /
`diffSections` / `composeSections` / `editGate` / `sectionLayer` / `regionLabelKey` / `renderStatusDetail` / `renderUpdateApplyStatus` … 共 26 个名字）
一律加进主 factory 的 `__internals.shared`（`CHUNK_FACILITIES`）后由 chunk 解构取用，**没有一份副本**。

`test/client.test.mjs` 对这个不变式做的是**双向机械校验**（独立评审意见 P3 收口后）：

- **引用侧**：chunk 的**代码行**里所有 `shared.<name>` 引用（含 `const x = shared.x`、`const { x, y } = shared`、内联 `shared.x` 三种取式）都被收集，逐个断言 `name in __internals.shared`；
- **定义侧**（反向）：`__internals.shared` 的**每一个键名**，chunk 都不得用 `const` / `let` / `var` / `function` 在本地重新声明（除非该行右侧就是 `shared.<同键>`）。这一条针对的正是「本地造一份副本」的唯一形态 —— 局部绑定会**遮蔽**共享实例，引用侧断言看不见它；
- 另加一条：不得出现 `require.async`、`require('react')` 或**任何另一个 chunk 的文件名** ⇒ chunk→chunk 依赖与第二个 React 都不可能成立。

负向对照（都实测会红、随后还原）：内联 `shared.nope` ⇒ 引用侧红；`const UI = null`（非字典形态的本地重定义）⇒ 定义侧红；`const token = {…}`、`require.async('./client.transfer.js')` 各自红。
正向对照：把 `const UI = shared.UI` 改写成 `const { UI } = shared` 仍绿（新取式被正确采集）。

**已知限制（写在文档里，不悄悄留着）**：这是**形态级**守卫，不是完整的自由变量分析（后者需要 JS 解析器，与本包「零依赖」承诺冲突）。
它覆盖评审点名的三类逃逸取式与本地副本；「chunk 引用了某个名字却忘了取用」这类错误由**运行时**兜底 —— chunk 在 vm 里以严格语义执行，
未声明的自由标识符直接抛 `ReferenceError`，打开该 tab 的测试随即变红。

### 四、验收

- `cd packages/dsh-prompt-setting && node --test` ⇒ **736 pass / 0 fail / skipped 0**（基线 731；新增 5 条：首屏零请求 + 每个 tab 只取自己的 chunk、每个新 chunk 的失败降级、
  无 `React.lazy` 时每个 chunked tab 的降级且不发请求、每个 chunk 的第三重校验（自报摘要 vs 独立读盘）、DAG 与零副本）；
- 体积（实测）：`client.js` **9584 行 / 456680 B → 8575 行 / 411979 B**（净减 1009 行 / 44691 B）；
  新增 `client.overview.js` 577 行 / 25186 B、`client.transfer.js` 264 行 / 11320 B、`client.advanced.js` 502 行 / 23237 B；
  连同 g-045 的 `client.history.js`（1163 行 / 50497 B），四个 chunk 合计 2506 行 / 110240 B，整包 11081 行 / 522219 B
  （比拆分前单文件 10747 行多 334 行：四份 chunk 的 shared 解构与 lazy 样板；换来的是三个新 tab 的渲染器整块不再进首屏）；
- `node scripts/client-chunks.mjs` ⇒ 4 项与磁盘一致；`--write` 后与仓库逐字零 diff；
- `node scripts/prepare.mjs` ⇒ **21 项通过**（`FILES-GLOB: files: client.*.js（4 项）` 与 `CHUNK-STAMPS` 绿）；
- `npm pack --dry-run --cache <可写目录>` ⇒ **29 个文件**，四个 `client.*.js` chunk 全部在包内（`README.md` 的运行提示已同步为 29）；
- 零新依赖（`dependencies: {}`）、零构建步骤（`test/host.test.mjs` 两条门禁绿）。

### 五、为什么没到「5000-6000 行」（如实说明）

阶段一给的期望是主文件降到 5000-6000 行。实测下限由**首屏同步闭包**决定，只到 8575 行 —— 因为下面每一类都**不能在首屏异步**：

| 不可搬的部分 | 为什么 |
| --- | --- |
| `PromptSettingSection`（状态机） | 唯一状态持有者，本目标明令不动 |
| 无状态层（常量 / `ERROR_TEXT` / zh+en 两份字典 / token / `Fx*` / 纯函数群） | 首屏与所有 chunk 的共同依赖（见二） |
| 首屏骨架渲染（会话选择器与作用域树 + 状态行/详情 + 版本 + 更新横幅 + 两个 overlay，不含 mine） | `renderSection` 第一帧就会走到 |
| 「我的 Prompt」面板 | 默认 tab |
| chunk 边界机制本身（g-045 与本轮） | 加载、清单、指纹、降级卡 |

各块的规模（**本 commit 实测**，命令可直接复现；行号会随后续改动漂移，命令不会）：

```bash
wc -l -c client.js client.*.js                                     # 主文件 8575 行 / 411979 B；三个新 chunk 合计 1343 行
git show 355ad3f:packages/dsh-prompt-setting/client.js | wc -l -c   # 迁移前主文件 9584 行 / 456680 B
awk '/^    function PromptSettingSection\(/,/^    function renderFailureCard\(/' client.js | wc -l  # 状态机 1898
awk '/^    function focusVisibleOf\(/,/^    function renderSession\(/' client.js | wc -l            # 作用域选择器一族 643
awk '/^    function renderSession\(/,/^    const confirmTitleStyle/' client.js | wc -l             # 会话选择器 253
awk '/^    \/\/ #region chunk boundary \(g-045\)/,/^    \/\/ #endregion/' client.js | wc -l        # chunk 边界机制 432
```

⇒ 展示层里**能搬的都搬了**：可搬集合恰是三个非默认 tab 的渲染器，它们已整块落在三个新 chunk 里（三个新 chunk 共 1343 行，其中每份手写的 shared 解构与 lazy 样板约占 60 行）。
要再降只能动上面这五类，而每一类都被判据（状态机不动、首屏只请求主文件、零行为变化）或可靠性约束挡住。

### 六、未验证项

- **真机端到端未跑**（g-045 曾用临时 `DSH_HOME` + headless Chrome/CDP）：本轮「首屏只请求主文件、打开某 tab 才请求该 chunk」的证据来自 harness 的
  `loadedChunkFiles` 序列与 `data-render-state` 断言，不是浏览器网络面板；
- 三个新 chunk 的**真机失败降级**（阻断请求）未目视，只有 harness 的 `chunkFailures` 证据；
- 「只改 chunk 不碰 `client.js` 时浏览器不换新」仍是未实测的开发期限制（g-045 已记录，本轮未变）。

### 七、收口补丁（独立评审 3 条）

- **P1 · README 文件数滞后。** `README.md` 的运行提示仍写「26 个文件」（那是 g-045 的实测）。改为**29**（`npm pack --dry-run` 实测，本次新增 3 个 chunk）。
  同时按「凡是能被 `npm pack` / `wc` 复现的都必须与实测一致」复核了本次受影响的其它数字：`CONTRACT.md` §14.2 的 `chunks` 示例（4 项）与 `client.js` 的 `CHUNK_STAMPS` **逐项一致**（文件名、hash、size，已用命令对照）；README 的「十八个套件」仍等于 `ls test/*.mjs | wc -l` ⇒ 18。
  包体 kB 不再写进文档：文档本身计入包体，写入精确值必然滞后一步（文件数不受影响，故保留）。
- **P2 · NOTES 的数字口径不可复现。** §123 原写「51 个统一签名 `(t, m, a)` 的渲染函数」—— 该数字取自阶段一结构测绘卡对**全部顶层定义**的统计口径，本 commit 实测严格签名为 **28**
  （命令与逐文件分解已写进第一节），故换成可复现口径并注明「与 51 不可互推」。§五 表里引自估算的行数（1900 / 2900 / 1830 / 393 / 450）**全部删除**，
  改为「只留理由」+ 一组**带命令的实测锚点**（`wc -l -c`、`git show 355ad3f:…`、四条 `awk` 区间计数）。
- **P3 · DAG /「零副本」断言只认一种取式。** 原断言只匹配 `^ {4}const X = shared.X;$`，`const { X } = shared`、内联 `shared.X` 都会逃逸。按评审建议改为**双向校验**：
  引用侧收集所有 `shared.<name>` 与解构取式，逐个断言键存在；定义侧反向断言「`__internals.shared` 的每个键名都不得被 chunk 本地重定义」（`const UI = null`、`const token = {…}` 这类副本正是唯一能藏住「第二份实例」的形态）。
  负向对照实测：内联 `shared.nope` ⇒ 引用侧红；`const UI = null` ⇒ 定义侧红；正向对照：`const { UI } = shared` 仍绿。
  **未做成完整的自由变量分析**（那需要 JS 解析器，与本包零依赖冲突）—— 这一限制已写进 `CONTRACT.md` §13.0 Revision 30 与本文件第二节，不悄悄留着：剩下的缺口（引用了却没取用）由运行时兜底（未声明标识符抛 `ReferenceError`，打开该 tab 的测试即红）。
- 收口后复跑：`node --test` ⇒ **736 pass / 0 fail / skipped 0**；`node scripts/client-chunks.mjs` ⇒ 4 项一致；`node scripts/prepare.mjs` ⇒ 21 项通过；`npm pack --dry-run` ⇒ 29 个文件。

## 124. DSH peer 范围纳入 0.2.1 线：新增 `>=0.2.1-0 <0.2.2-0`（2026-10-09，基线 `5f00b76` 工作区）

### 一、P0：插件在 0.2.1-alpha.2 上直接消失

- 运行时升到 **DSH 0.2.1-alpha.2** 后，原范围 `>=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.1-0` 把 **0.2.1 整条 line** 排除。
- 两个可观测后果（本机实测）：
  1. 宿主 boot 闸门跳过整个 bundle —— 日志逐字：`dsh: skipping profile bundle "dsh-prompt-setting"`；
  2. 平台**拒绝安装** —— `dsh plugin --profile web add …` 输出 `dsh: nothing was installed.` 并给出
     `dsh plugin --profile web allow-version dsh-prompt-setting@0.1.5 --dsh-version 0.2.1-alpha.2 --accept-risk`。
- 与 §100 记的 P0 是**同一机制**：闸门在任何本包代码被 import **之前**生效，所以包内自检（`reportBootCompatibility`）救不了它。

### 二、为什么必须新增分支，而不是放宽上界

§98/§99 已记：严格 `node-semver`（npm/pnpm peer 解析，**不带** `includePrerelease`）只认「**同一个 alternative 内**存在同 `[major, minor, patch]` tuple 且自带 prerelease 的比较器」。
实测（本机 `semver@7.8.5`）：

| 版本 | 原范围 | 三段式（本轮） | 只把第二分支上界放宽到 `<0.2.2-0` |
|---|---|---|---|
| `0.2.1-alpha.2` | false | **true** | **false** |
| `0.2.1` | false | true | true |
| `0.2.2-0` | false | false | false |

⇒ 「懒写」`>=0.2.0-0 <0.2.2-0` 对 `0.2.1-alpha.2` **仍然 false**（0.2.1 这个 tuple 里没有任何比较器）。故新增第三分支 `>=0.2.1-0 <0.2.2-0`，下界取该 tuple 的**最小** prerelease（§99 同一理由：白名单只认 tuple，不认排序）。

### 三、终态范围与同步点

```
"@deepseek-ai/dsh": ">=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.1-0 || >=0.2.1-0 <0.2.2-0"
```

语义：`0.1.7-rc.2` 起的全部 0.1.x、`0.2.0` 与 `0.2.1` 两行的**全部预发布 + 正式版**都在范围内；`0.2.2-0` 及以后一律出界（新 minor 未经评估不放行）。

同步点（**9 文件**）：`package.json`（权威源）、`index.js`（`DSH_PEER_RANGE_FALLBACK` + 注释；测试断言两者逐字相等）、`test/boot.test.mjs`（边界表 + 桥/上界两条形状断言）、`test/host.test.mjs`（manifest 正则）、`scripts/check-compat.mjs`（超范围样例 `0.2.1-0` → `0.2.2-0`）、`core/compat.js`（注释）、四份 README（根/包内 × 中英）+ 两个徽章（`<0.2.1-0` → `<0.2.2-0`，仍是有效集合的上下界写法）。

### 四、护栏与它给出的信号

- 桥断言：`>=0.2.x-` 比较器必须恰为 `['>=0.2.0-0', '>=0.2.1-0']`；
- 上界断言：所有 `<` 比较器必须恰为 `['<0.2.0', '<0.2.1-0', '<0.2.2-0']`；
- 所有「超范围样例」从 `0.2.1-0` 改为 `0.2.2-0`。⚠️ 本轮首跑 3 红**正是护栏在指路**：`0.2.1-0` 在新范围里变成**范围内**，于是 `boot.test.mjs` 的两条出界用例与 `host.test.mjs` 的 manifest 正则一起变红——这是「改范围必须同步改动点」的机械保障，不是障碍。

### 五、验证

| 项 | 结果 |
|---|---|
| `node --test` | **737 pass / 0 fail / 0 skip** |
| `node-semver` 实测 | `0.2.1-alpha.2` / `0.2.1` = true；`0.2.2-0` / `0.3.0` = false |
| `node scripts/check-compat.mjs` | 退出 0，结论「兼容（在已测试范围内）」 |
| 真机（临时 `DSH_HOME` + 0.2.1-alpha.2 宿主） | 装包成功；宿主日志 `skipping profile bundle` 计数 **0**；`/prompt-setting/ping` 与 `/download-region` 均 **200** |

### 六、未验证

- **未在用户主 profile 上重装验证**（那需要动他的运行环境）；本机以临时 `DSH_HOME` 等价取证。
- npm 上已发布的 `0.1.5` 仍是**旧 peer** ⇒ 用户若从 npm 装，仍需等一版发布才会带上本修复；本地 `link:` 安装则立即生效。
- 本次提交**未同步版本号**（当时仍 `0.1.5`），属于发布准备的范围；版本号随后在 §127 升到 `0.2.0`。

---

## 125. g-047：选中会话不再改写「搜索会话」输入框（Revision 31，2026-10-09，基线 `5f00b76` 工作区）

### 一、现象与报告路径

- 负责人真机反馈：在「查看范围」里**选中一个会话**后，下方「搜索会话」的输入框被**会话标题**占用，容易
  让人误以为那是搜索词。
- 复核确认这不是显示瑕疵而是**写值**：框里真的被填进了标题文本。

### 二、根因（三处调用，注释自述为设计意图）

| 调用点 | 触发方式 |
| --- | --- |
| `pickSession` | 点候选项行 |
| `useCurrent` | 点固定的「当前会话」条目 |
| Enter 分支 | 高亮某行时按 Enter |

三处都会 `setSessionQuery(sessionLabelOf(session))`，源码注释自述为 *"the box reflects the selection"*。

### 三、连带副作用（比"不好看"严重）

- 被填入的值**立即参与 `filterSessions(...)`**：列表随即按**标题**过滤，而不是按用户自己敲的词；
- 当没有任何候选行匹配时，Enter 会走 Revision 3 的「按该 id 查看」分支 ⇒ **一个会话标题可能被当成
  session id 解析**。

### 四、裁决与改动（负责人选定「保用户输入」）

- 三处写值**全部删除**：输入框**只装用户敲的内容**，列表继续被用户自己的词收窄；
- `placeholder` 恒为 `sessionSearch`（「搜索会话（标题 / 路径 / session id）」），不再是状态显示位；
- 「我在哪个范围」仍由**三处**显示承担，一处未削弱：`data-role="scope-summary-label"`、
  `data-role="session-current"` 行、pinned 条目的选中态（§13.7）；
- **「全局」与 `Esc` 保持清空行为**（回到全局 = 丢掉过滤），未做对称改动；
- 核查「版本历史」的独立作用域选择器（§13.3）**无同病**（`data-role="history-scope-search"` 的
  placeholder 是固定的 `histScopeSearch`，且 `setHistoryScope` 只在收起时清空）。

### 五、教训

**输入框不是状态显示位。** 被程序改写的值会立刻参与过滤、并污染后续解析——「让框反映选中」这类便利
设计，代价是用户失去对自己输入的掌控。契约 §13.7 与 Revision 31 已把这条写成规则。

---

## 126. DSH `0.2.1-alpha.2` 兼容评估与真机走查：两处真实缺陷（2026-10-09）

### 一、更新日志逐条对照（结论：无破坏性变更）

对照 [dsh-v0.2.1-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.2)
的中英两版正文，与本插件接触面相关的只有几条，且**没有**需要改代码的破坏性变更：

| 更新日志条目 | 与本插件的关系 | 判定 |
| --- | --- | --- |
| pi-ai 按模型能力处理**会话中系统提示词更新** | 本插件核心是 `ctx.systemPrompt` 段注册 + waterfall 覆盖 | ✅ 实测装配 8 段、保留段仍在**最后一位** |
| 修复「插件包元信息不可读 ⇒ **整个请求被阻断**」 | 本插件导入期要读自己的 `package.json` | ✅ 利好（0.2.0 那条会波及整个请求） |
| 更新「运行时工具、MCP 协议、图片处理和**客户端渲染依赖**」 | 本插件 inject 4 个客户端包 | ✅ 5 tab、4 chunk、交互、构建戳全部正常 |
| 新增**思考正文 Slot** + 官方 Markdown Content Factory | 本插件用 settings slot | ℹ️ 无关 |
| 新增实验性**插件 Session 状态记录接口** | 本插件自写 `history.jsonl` | ℹ️ 潜在机会（非必须） |
| agent-instructions **移除逐行 dshHome** | 影响「提示词总览」里 AGENTS.md 类段的**来源** | ℹ️ 只影响展示内容 |
| 默认 SDK profile 改**通用 AI Agent 身份** | 影响 `deployment:persona-*` 段内容 | ℹ️ 同上 |
| `working_directory` 工具（会话可切工作目录） | 本插件按 workspace 归属覆盖/历史 | ⚠️ 新能力边界：运行中切 cwd 会让归属"跳"，非 bug，记录备查 |

### 二、真机走查覆盖（临时 `DSH_HOME` + 0.2.1-alpha.2 宿主，逐项**实操**）

**真点过**：编辑 + 保存、变量替换开关、取消（放弃未保存编辑）、恢复默认（确认 + 取消）、刷新快照、
历史列表 / 翻页、点行选对比、预览弹窗（字段无段名、时间本地化）、清除对比、关闭弹窗、
**回滚（确认 + 取消）**、**整层重置（确认 + 取消）**、**导出**（文件名本地化、JSON 可解析、内容正确）、
**导入**（粘贴 → 干跑预览 → 确认 → 二次确认 → 真的写入，`origin=import` 记入历史）、下载区域下拉、
自定义镜像弹窗（非法地址红字 `rgb(236,19,19)` 且不落盘、合法地址保存）、更新开关三态、重新检查、
总览展开 / 复制。

**未覆盖（诚实记录）**：`update-apply` 的**真实安装**——npm 上 `latest` = `0.1.5` = 本地版本 ⇒ 无更新，
按钮不出现；用页面内 hook `fetch` 伪造「有新版本 9.9.9」可以走到提示条 / 立即更新 / 确认弹窗 / 取消，
但点确认后宿主的 `POST /update-apply` **自己重做了一次检查**（不走客户端 hook），据真实结果拒绝
（`no-update`）⇒ **客户端伪造骗不过服务端**。这本身是应有的安全性质；代价是真实安装链路仍需真有新版本
才能覆盖。

### 三、发现 1：中文提示「检查更新已已开启」（重复字）→ 已修（`e460d45`）

- 模板 `updateToggleSaved: '检查更新已{state}。'` 与状态值 `updateSettingOn: '已开启'` **各带一个「已」**
  ⇒ 渲染成「检查更新已已开启。」；英文侧 `Update checks are now {state}.` + `On` 本来正常。
- **修模板**（`'检查更新{state}。'`）而非改值：该值同时是「高级」tab 开关**按钮自身的文本**（
  `client.advanced.js` 直接 `t(enabled ? 'updateSettingOn' : ...)`），改值会让按钮从「已开启」退化成
  「开启」，语义变弱。
- 顺带扫过「已已 / 的的 / 了了」无其它命中。

### 四、发现 2：回滚 / 整层重置 / 导入之后编辑器仍显示旧文本 → 已修（`d6e39c9`，Revision 32）

- **现象**：三个操作的服务端、历史与装配**都已改变**（curl 逐个核实：回滚 `before 10 → after 20` 字符、
  整层重置后 `overrides: []`、导入后值真的变成目标值），但「我的 Prompt」的编辑框**仍显示操作前的文本**
  ⇒ 用户会以为「操作没生效」。
- **根因**：编辑框在草稿存在时渲染草稿（`mineText` 的取值式见 §13.1），而这三处成功后只
  `setReload(v => v+1)` 重拉数据，**没有对草稿做任何处理**；同面板的「恢复默认」(`resetMine`) 则有
  `setMineDraft(null)` ⇒ **是遗漏，不是设计**。
- **修法（负责人选定 A 口径：保守）**：新增 `settleMineDraft()`，三处成功后调用——
  - 草稿仍等于**操作前**的存储文本 ⇒ 不含用户新写的内容 ⇒ **静默丢弃**，编辑器跟随新值；
  - 草稿不同 ⇒ 属未保存工作 ⇒ **保留**，并在成功 notice 后追加 `mineDraftKept`
    （「配置已在别处更新；你编辑器中尚未保存的内容仍保留着。」）。
  §15.4 的「no path clears what the user typed」正是**第二支**的依据，也是两支必须不同的理由。
- `clearLegacy`（`legacy=true`）**刻意不入此列**：它保留保留段（§12.2），面板文本不会在编辑器背后变化。
- **验证**：新增 3 例（草稿等于旧值静默丢弃 / 草稿不等则保留并提示 / 整层重置与导入走同一对账路径）⇒
  **740 pass**；负向对照注入「未保存草稿不再被识别」⇒ 其中 **2 例红**（212/214）；真机两场景复验，
  A 场景编辑器显示回滚后的新值且**无**提示，B 场景保留 `G049-UNSAVED-DRAFT` 且 notice 带提示。

### 五、附：`data-renderer = "fallback"` 的定位（不是 0.2.1 引入，也不影响使用）

真机读到 `data-renderer="fallback"`，追查后确认**不是**本次升级造成的降级：

- `dsh-client-ui-primitives@0.2.1-alpha.2` **存在于 DSH 安装内**，但不在任何 profile 的 `node_modules`；
- 官方插件（`dsh-client-ui-skill` 等）把它放在 **devDependencies**，靠 **bundler（rolldown）内联**进产物
  ——它们的 `inject` 列表里**也没有**它；
- 本插件是**零构建手写**，无法内联，只能运行时 `require` 探测；而它从未把该包写进 `inject` / 依赖 ⇒
  **必然落空**，走自建原子（`Fx*` + `--dsw-alias-*` CSS 变量 + `font: inherit`，因此**跟随主题与字体**）。
- 判定：**设计内降级，功能不受损**（`render-state=ok`，交互全部通过；且 fallback 是自动化测试的**默认
  主路径**——harness 的 `primitives` 默认 `'throw'`，740 项断言绝大多数跑在它之下）。插件在对比弹窗里也
  自报「自绘渲染（primitives 不可用）」，不掩饰。
- 若将来要恢复官方组件渲染：把该包加进 `dsh.client.inject`——但 inject 是**硬声明**，平台不提供时可能
  让整个插件加载失败（现在探测失败只是降级），且那正是「零构建」承诺的反面。**本次维持现状。**

---

## 127. 版本号 `0.1.5` → `0.2.0`：同步点、新盲点与白名单依据（g-048，2026-10-09）

### 一、为什么是 `0.2.0`（minor）而不是 `0.1.6`

负责人 2026-10-09 决定直接提到 **`0.2.0`**：本轮有用户可感知的变化（更新检查改从 npm 读取、新增「下载
区域」、客户端按需分块、peer 范围纳入 DSH 0.2.1 线），且插件自身版本与所支持的 DSH 0.2.x 线就此对齐。

### 二、同步的「本包当前版本」

- **权威源 2 处 / 2 文件**：`package.json` 的 `version`、`index.js` 的 `PLUGIN_VERSION`；
- **`CONTRACT.md` 5 类**：§10 export 示例（`plugin.version` / `pluginVersion`）、§13.8 版本节点文案
  （`v0.1.5` → `v0.2.0`）、§13.9 ping 示例的 `version`、§17 update-check 的 **npm 与 GitHub 两个示例**
  （`current` 0.1.5 → 0.2.0；`latest` 0.2.0 → **0.2.1**、`latestTag` → `v0.2.1`、`releaseUrl` 同步——
  示例必须保持「有更新」的语义）；
- **两份根 README + 包内 README 共 8 处**：徽章 2 处；「npm 上的版本」表述 5 处改为**双写**
  （「npm `latest` 为 `0.1.5`，本仓库为 `0.2.0`，发布后两者一致」）——**发布前**写死 0.2.0 会误导按文档
  安装的人，故如实区分；
- **测试 6 个文件**：见下节。

### 三、⚠️ 本轮新盲点：fixture 里的「更新目标版本」

§121 记的盲点是 **banner 的转义正则**（`/0\.1\.4/`）；本轮暴露了**第二类**，且它是升版失败的主因：

- **现象**：改完两个权威源即跑全量 ⇒ **740 中 33 红**，集中在 `install.test.mjs`（26）、`route.test.mjs`
  （3）、`update.test.mjs`（3）、`stage2.test.mjs`（1）。
- **根因**：这些测试把**「注册表里的新版本」写死为 `0.2.0`**——在真实版本是 `0.1.5` 的年代，0.2.0 比它高，
  于是构成「有更新」。真实版本一升到 `0.2.0`，**它不再构成更新** ⇒ `check()` 答 `no-update` ⇒ 依赖
  「有更新」的全部路由用例连锁失败（首个报错 `actual: 'no-update'`）。
- **修法**：把所有**作为更新目标**的 `0.2.0` 提到 **`0.2.1`**（含 `TARBALL_URL` / `ASSET_URL` /
  `npmDocument()` / `makeTransport()` 的默认 GitHub release tag / 各测试自己的 `versions[...]` 覆盖键），
  并把「本包已经是的那版」`OLD_TARBALL_URL` 从 `0.1.5` 改为 **`0.2.0`**。
- **收敛过程**（每一轮都由测试指出下一批）：33 红 → 改 fixture 常量后 7 红 → 改 `versions[...]` 覆盖键与
  个别断言后 1 红 → 改 `body.version` 断言后 0 红。
- **下一次升版的做法**：升版后**立刻跑全量测试**，把红点当作清单；并在改 fixture 时自问
  「这个字面量是**更新目标**还是**当前版本**」——两者都要动，但方向相反。

### 四、白名单判断依据（一律未动）

- `CHANGELOG.md` 的 `[0.1.5]` 及更早历史段、`NOTES.md` 历史叙述（含 §121 的升版记录）：历史；
- `CONTRACT.md` / `core/update.js` 的**镜像实测记录**（`dist-tags.latest` = `0.1.5`、真机响应示例
  `latest:"0.1.5"`、镜像延迟表）：**当时测得的事实**，改了就是在伪造测量；
- 纯函数测试里自洽的版本字面量（`buildReleaseAssetUrl('0.2.0','0.2.0')`、
  `isNewerVersion('0.2.0', ...)`、`packumentLatest({latest:'0.1.5'})` 等）：传什么断言什么，与当前版本无关；
- `test/update.test.mjs` 的 `currentVersion: '0.1.5'`（4 处）与 `test/client.test.mjs` 的 ping/export
  **替身响应**（`pluginVersion: '0.1.5'`）：测试自己注入的假数据，不代表真实版本——`client.test.mjs:8896`
  的 banner 断言 `/0\.1\.5/` 正是匹配这个替身，故它在本轮**天然不红**；
- `core/install.js` 的「announce 旧版、install 新版」示例（§111/§121 已确立先例）。

### 五、CHANGELOG 定稿

新增 `## [0.2.0] - 2026-10-09`（中英对照），置于 `## [0.1.5]` 之前：`### Added 新增` 2 条（更新检查改从
npm 读取、下载区域）、`### Changed 变更` 2 条（客户端按需分块、peer 范围纳入 0.2.1 线）、`### Fixed 修复`
5 条（历史列表高度、历史不再列出插件注册段、搜索框被标题占用、回滚/重置/导入后草稿不刷新、重复字），
`[0.1.5]` 及更早段一字未动。

### 六、验收

| 项 | 结果 |
| --- | --- |
| `node --test` | **740 pass / 0 fail / skipped 0**（升版前基线一致，无断言削弱；中途 739/1 见第三节） |
| `node scripts/prepare.mjs` | **21 项通过**（含 `CHUNK-STAMPS` 与零运行时依赖） |
| `npm pack` | **`dsh-prompt-setting-0.2.0.tgz`**：**29 文件**、`test/` 命中 **0**、包内
`package.json.version` = **`0.2.0`**、体积 **≈636 KB**（不记精确字节数：`NOTES.md` 在 `files` 白名单内） |
| 残留自查 | `0.1.5` 只剩历史段、镜像实测记录与测试替身（逐条见第四节） |

- 环境注记（承 §121）：本机 `~/.npm/_cacache` 有 root-owned 文件，`npm pack` 需 `--cache <可写临时
  目录>`，与包本身无关。

### 七、未验证项

- `npm publish` / `git tag` / `git push` / Release 资产：**人工 gate，未做**；因此 **npm 上的 `latest`
  仍是 `0.1.5`**（README 的双写表述正为此），从 npm 安装的用户要等发布才拿到本版；
- README 徽章的 shields.io 在线渲染未目视（离线），只核对了源文本；
- 只改了表示「本包当前版本」的字面量与文档，**无产品逻辑改动** ⇒ 无行为回归面（本轮的行为改动是
  §126 的两处，已各自单独验证）。

---

## 128. g-052：冻结状态「未知」的文案改造（指代 + 不归因解释行，2026-10-10，基线 `e59b164` 隔离工作树）

### 一、要解决的问题

在「查看范围」里选中一个本进程从未激活过的会话时，状态条原样引用宿主英文实现术语
（`session "xxx" has no active agent, ...`），且只写「本会话」——用户读不出**哪个**会话，也读不出
「未知 ≠ 未冻结，仍可编辑保存」。判定逻辑（`frozenState()` 三态、宿主 `probeTarget`）**一字未改**，
改的只是呈现。

### 二、事实依据：`running` ≠ `agentAvailable`（本轮最重要的一条）

- 会话列表的 `running` 字段 = `agent.status === 'running'`，与「有没有 live Agent」
  （`agentAvailable`）**不是一回事**；
- 刚聊完的空闲会话：`running === false`，但**有** live agent ⇒ 冻结状态**可以确认**；
- 因此文案**严禁**归因成「未在运行 / 未打开 / 已结束」：用户拿列表里的 ● 标记一对照就矛盾。
  **本次文案不归因**，只解释「未知」的含义与后果。

### 三、文案决策（措辞由负责人逐字拍板，未自行改写）

- 指代统一为**「所选会话」**：`stFrozenSession` / `stUnfrozenSession` / `stFrozenUnknown` /
  `mineFrozenUnknownWarn` / `mineSavedUnknown` / `savedNoticeUnknown`（zh/en 一一对应）；
- 新增两个 key（沿用 `stFrozen*` 命名）：`stFrozenUnknownProbe`（「无法探测该会话自己的装配。」）、
  `stFrozenUnknownNotFrozen`（「这不等于未冻结；仍可编辑保存，只是不保证生效。」）；
- `stFrozenGlobal` / `stUnfrozenGlobal` 描述全局装配，**保持不动**；
- 状态条 unknown 分支：保留原有那行（含宿主 `frozenScopeReason` 英文原句，格式 ` — 原因: <原文>`），
  其下**新增两个独立 `<p>`**，样式 `fontSize: 12` + `wordBreak: 'break-word'`（第一行 `stateWarn`、
  第二行 `labelTertiary`）；两行只在 `fz.kind === 'unknown' && !fz.pending` 出现，certain 时绝不出现；
  既有 `data-warning="frozen-unknown"` 等标记原样保留，新增节点带 `frozen-unknown-probe` /
  `frozen-unknown-not-frozen` 供机器读取。

### 四、测试（`test/` 只增行：`78 insertions(+), 0 deletions(-)`）

- 新增 2 个用例：unknown 场景锁死两个新 key 的文本都出现、且整页文本**不含**「未在运行」/「未打开」/
  「已结束」；certain（frozen + unfrozen）场景锁死这两个 key 与其标记都不出现；
- 既有断言只增不减、不放宽；zh/en 键位一一对应（`client.test.mjs:1396` 的对齐测试自动覆盖）；
- 顺带撞到一个真实盲点：新注释里写了 `<p>` / `<br>` 字样，被 `host.test.mjs:448` 的
  「模块里不得出现 JSX/HTML 标签」正则（`/<[A-Za-z][^>]*>/`）判红 —— 注释改成「paragraph nodes /
  line-break element」后转绿。**教训：在 `client.js` 里连注释都不能出现尖括号标签样式。**

### 五、实测数字

| 项 | 结果 |
| --- | --- |
| `node --test` | **742 pass / 0 fail / skipped 0**，exit 0 |
| `node scripts/check-compat.mjs` | exit 0（只读诊断） |
| `node scripts/client-chunks.mjs` | **4 file(s) match the CHUNK_STAMPS manifest**，exit 0（未改 chunk，无需 `--write`） |
| `git diff --stat` | `client.js 52+/12-`、`test/client.test.mjs 78+/0-` |
| 其它 chunk | `client.history.js` / `client.overview.js` / `client.advanced.js` / `client.transfer.js` 均未引用被改 key ⇒ 无需同步 |

### 六、未验证项

- **真机目视未做**：两行新文案的换行、与告警行的间距只按邻近元素样式取值，未在浏览器里看过；
- 未改动任何判定逻辑，故无行为回归面。

### 七、复核补修：指代收口（同轮追加 commit，`45a4396` 未被 amend）

- 复核发现四处冻结文案仍在用「本会话」/ "this session"，与已统一的「所选会话」并存：
  `mineFrozenUnknownBody`（同一句里混用「选中的会话」与「本会话」，是明确缺陷）、`mineFrozenHowTo`、
  `mineSavedFrozen`、`savedNoticeFrozen`（zh/en 各 4 处）；全部统一为「所选会话」，
  `mineFrozenUnknownBody` 第二次起改用「它」，避免一句话里三次重复「所选会话」；
- **未动** `client.js:1372` 的 en "assembling this session's prompt"（变量引用段，那里的 "this session"
  含义正确）、`mineFrozenBody`（certain 正文，无「本会话」）、判定逻辑与 `CONTRACT.md`；
- 新增断言（只增行）：unknown 面板（`data-region="mine"` 子树）zh 文本不含「本会话」且含「所选会话」；
  en 面板子树不含 "this session" 且含 "the selected session"；
- `grep -n "本会话" client.js` → **0 命中**；
- 实测：`node --test` **743 pass / 0 fail / skipped 0**，exit 0（新增 1 个用例）；`check-compat.mjs`
  exit 0；`client-chunks.mjs` 4 file match，exit 0；**无既有断言硬编码旧中文串**（全绿，未放宽任何断言）；
- 补修 diff：`client.js 8+/8-`、`test/client.test.mjs 34+/0-`。

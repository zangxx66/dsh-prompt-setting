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

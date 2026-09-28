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

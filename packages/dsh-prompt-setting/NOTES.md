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

## 53. 未验证项（本轮，诚实清单）

1. **真机目视**：树形分组的实际观感（缩进/箭头/路径副标题/运行中圆点）、展开折叠手感、
   以及与左侧边栏「并排看是否真的一致」，都需负责人真机确认。离线探针只能证明结构与标记。
2. **真实会话规模**：同 §47，探针用合成目录；真机 2000+ 会话下的浏览器击键延迟无数据。
3. **真机 profile 是否启用 `dsh-client-ui-workspace`**：本轮未在真机确认 `useWorkspaces` 是否真的到达
   props（类型合并恒在、运行时可缺）。若真机未启用，页面会显示平铺降级并明示 —— 这也是被验收的行为之一，
   但「真机到底走哪条分支」需目视确认（`data-scope-mode`）。
4. `default-workspace` 的本地化名字：`dsh-client-ui-workspace` 字典里查不到 `workspace.defaultName` 条目，
   本轮按语义自备「默认工作区 / Default workspace」。若真机上侧边栏显示的是别的文案，则此项不一致（低风险，
   仅影响默认工作区这一个节点的标签）。

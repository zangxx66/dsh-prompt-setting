![dsh-prompt-setting：DSH 预设 Prompt 管理](./assets/hero.jpg)

# dsh-prompt-setting

[English](./README.md) | 中文

**DSH 的系统提示词（System Prompt）管理插件。** 它在 DeepSeek Harness 的 Web GUI「设置」里加一栏
Prompt 管理器：**看得见**每一轮会话最终装配出来的系统提示词，搜得到、写得上自己的指令、改错了能回滚，
全程**不碰 DSH 全局安装包**。

![license](https://img.shields.io/badge/license-MIT-blue)
![version](https://img.shields.io/badge/version-0.1.2-blue)
![dsh](https://img.shields.io/badge/DSH-%3E%3D0.1.7--rc.2%20%3C0.2.1--0-blueviolet)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

- **零运行时依赖、零构建步骤**：装进去就是一整包 JS，不拉依赖、不编译。
- **升级安全**：配置只写插件自己的数据目录，升级 / 重装 DSH 不会丢，也不会被覆盖。

---

## 一、这插件解决什么问题

DSH 每轮会话都会注入一段由 `@deepseek-ai/dsh-system-prompt` 装配出来的基座系统提示词。
以前想调整它，只有一条路：**去 pnpm 全局 `node_modules` 里硬改文件**。代价是：

- 升级 DSH 就被覆盖，改动全丢；
- 污染全局安装，别人（或另一台机器）无法复现；
- 改了什么、改之前是什么，没有任何记录可比对；
- 最要命的是——**你根本看不到「最终拼出来的 system prompt 到底长什么样」**。

这个插件把这件事搬进设置页：装配结果按段展开给你看，你自己写的那部分单独成段、稳定排在最后，
其余内置段保持只读，改动有历史、可 diff、可导出备份。

## 二、装完你能看到什么

设置页里会多出一栏 **「Prompt 管理 / Prompt settings」**（`id: prompt-setting`），下面四个一级 tab：

| Tab | 你能做的事 |
| --- | --- |
| **我的 Prompt** | 唯一写入口：写下你自己的系统级指令（选作用域 → 编辑 → 保存），一键「恢复默认」。这段文本会**排在所有内置段之后**。 |
| **提示词总览** | 纯只读：装配后的分段列表（状态标记 / 搜索 / 筛选 / 复制）、完整全文，以及 `base ↔ effective` 对比 —— 一眼看出你的改动究竟改变了什么。 |
| **历史与备份** | 历史列表 + 版本对比（行级 diff）；配置导出下载、导入预览（导入前先看变更计划，确认后才落盘）。 |
| **高级** | 旧版覆盖的只读列表、「清除全部覆盖」与「整层恢复默认」两个二次确认按钮、**「检查更新」开关**（默认开启；关闭后本插件完全不再联网）、**「立即更新」**（宿主安装提示条里的版本，重启 `dsh web` 由你来做）、完整状态区（挂载情况 / 构建戳 / 渲染器自检）。 |

> 界面文案跟随 DSH 语言：DSH 切到 English，这一页就是英文，不需要刷新或重启。

### 联网边界：这个插件会查一次更新（可关闭）

打开设置页时，**宿主**（Node 侧）会发一个 `GET` 到
`https://api.github.com/repos/zangxx66/dsh-prompt-setting/releases/latest`
（地址由本包 `package.json` 的 `repository.url` 解析，不是第二份硬编码）。这是本插件**唯一**的对外
请求，且是可关的：

- **只有这一个请求**：没有 body、没有 cookie、不带任何本机 / 会话 / 工作区数据；`User-Agent` 是
  `dsh-prompt-setting/<版本>`，5 秒超时，同一进程 6 小时内不重复请求；
- **只有确实有更新才提示**：页面顶部出现一条**可关闭**的提示（新版本号 + 发布页链接）。没有更新、
  仓库还没发 release、或请求失败 —— 页面顶部**一律零提示、零报错**；其中「没有 release / 版本号不可解析」
  是**上游事实**，只在「高级」的开关卡片里用一句中性文案说明（**检查失败时不显示该句**）；
- **怎么关**：设置 →「Prompt 管理」→「高级」→ 关掉**「检查更新」**。关闭后**零请求**（包括打开
  设置页时），并写入 `$DSH_HOME/prompt-setting/preferences.json` 的 `{"updateCheck": false}`；
  直接手改这个文件、或删掉它（回到默认 = 开启）同样有效；
- **它不做**：不自动下载、不自动安装、**不自动重启**、也不检查 DSH 平台版本。

### 装更新（「立即更新」）

**装了新版本，重启还是你自己来。** 提示条上的「立即更新」会先弹二次确认（写明这点），确认后由**宿主**
通过官方插件管理器把那个 Release 的 `.tgz` 装进当前 profile；装完页面只会说「已安装 vX.Y.Z，请手动重启
`dsh web` 生效」。**这里不会重启任何东西。**

- **装的是什么**：release **资产**
  `https://github.com/zangxx66/dsh-prompt-setting/releases/download/<tag>/dsh-prompt-setting-<version>.tgz`，
  `<tag>`/`<version>` 取自**同一次**更新检查——「提示的版本 = 安装的版本」，命中 6 小时缓存时零外呼。
  因为它是资产，安装**不需要** pnpm 的构建脚本审批；
- **怎么进行**：点击立刻返回 `requestId`，页面轮询进度（1.5～5 秒一次，最长 16 分钟），期间可**取消**。
  失败给出分类原因（资产缺失 404 / 构建被拦 / 网络 / 缺 pnpm …）与重试按钮——**绝不自动重试、绝不自动重启**；
- **`link:` 安装会被拒绝**：profile 里是 `link:`/本地路径（开发工作树）时按钮拒绝执行并给出手动更新
  指引，绝不会把开发链接覆盖成发布版本；
- **发布方须知**：每个 release 必须上传 `npm pack` 资产，命名固定
  `dsh-prompt-setting-<version>.tgz`；本包**不得**新增 `postinstall`/`install` 脚本（带它们的 tarball
  会被 pnpm 的构建门禁拦下）。做法见 `packages/dsh-prompt-setting/NOTES.md` §107。

## 三、安装

**前置条件**：已安装 DSH（`>= 0.1.7-rc.2 < 0.2.0 || >= 0.2.0-0 < 0.2.1-0`：`0.1.7-rc.2` 起的全部
0.1.x、`0.2.0` 的全部预发布（`0.2.0-0` / `alpha` / `beta` / `rc.N`）以及 **`0.2.0` 正式版本身**都在范围内；
`0.2.1-0` 及以后一律出界——新的 minor 未经评估不放行）。跑测试和开发才需要 Node `>= 22`。

三条路，装进的都是**同一个 profile 里的同一个包**——同样的 profile 文件、同样的包管理器、同样的日志，
按手边有什么挑一条即可（**不要**手工编辑 profile 配置文件）。

### GUI 自带的插件管理页（不用终端）

当前 DSH 在 Web GUI 侧边栏提供了**独立的「Plugins」页**。它不在「设置」里——设置 →「内置插件」是只读清单，
不是安装入口：

1. 侧边栏 → **Plugins** → **Add plugin**；
2. 填一个和 `dsh plugin add` 同形的 spec，点 **Install**：
   - **本地路径**——本仓库插件目录的绝对路径：
     `<仓库绝对路径>/packages/dsh-prompt-setting`（先克隆/下载仓库；相对路径会被拒，因为「宿主的工作目录」
     对浏览器里输入的人没有意义）；
   - **git 地址**——`github:zangxx66/dsh-prompt-setting#path:/packages/dsh-prompt-setting`
     （本仓库是 monorepo，`#path:` 必带）；
   - **npm 包名**——`dsh-prompt-setting`（发布到 npm 之后）；
   - **tarball**——磁盘上或 http(s) 上的 `dsh-prompt-setting-<版本>.tgz`；
3. **宿主会先读一遍 spec 再动手**（名字、版本、一句话简介、这包到底带不带 bundle 补丁），读不出来就只在输入框下
   给一句说明、不装；通过后 pnpm 的输出折叠在 **Show install details** 里，随时可 **Cancel install**，失败或取消都会
   把 profile 文件恢复原样；
4. 装完可以 **Enable now**；bundle 自己的详情页上有开关、插件行和 **uninstall**。若 pnpm 拦下了依赖的安装脚本，
   失败页会列出这些包并提供 **Allow these scripts and retry**。

**本地路径装进来的是 `link:`**——profile 和你的工作树是同一份文件（开发态）。插件的「立即更新」按钮会刻意拒绝
把这种安装覆盖成发布版本（见上文「装更新」一节）：这种安装请用 `git pull` 更新。

如果你的 DSH 版本侧边栏里没有 **Plugins** 这一项，走下面的 `dsh` 命令行。

### 在会话里把仓库地址交给 AI

把地址贴进任意会话，说清要做什么就行——AI 会把它装进这个会话正在跑的 profile：

> 把 `https://github.com/zangxx66/dsh-prompt-setting` 装进当前 profile

Creator 模式下 AI 手里有 `plugin_manager` 工具，会直接调用：

```
plugin_manager(action: "install_bundle", target: "github:zangxx66/dsh-prompt-setting#path:/packages/dsh-prompt-setting", enabled: true)
```

- **`#path:` 必带**：本仓库是 monorepo，插件在子目录里。不带的话 pnpm 装到仓库根合成的 `0.0.0` 空包，插件不会出现；
- **你在批准什么**：安装会改写 profile 的 `package.json` 与 bundle 选择，随后装进来的宿主代码在工作区沙箱之外
  以进程内方式执行——所以这个工具要么需要 `danger-full-access`，要么每次调用单独审批。批准前先看清 spec。

### `dsh` 命令行

`dsh plugin --profile <名字> <pnpm 参数…>` 会在该 profile 目录里跑 pnpm，并把这次装上的 bundle 选进去。
Web GUI 的 profile 名是 `web`：

```sh
# 从 npm 装（发布之后）
dsh plugin --profile web add dsh-prompt-setting

# 直接从 GitHub 装——不用先克隆；本仓库是 monorepo，#path: 必带
dsh plugin --profile web add 'github:zangxx66/dsh-prompt-setting#path:/packages/dsh-prompt-setting'

# 装本地工作树（绝对路径；装成 link:）
dsh plugin --profile web add '<仓库绝对路径>/packages/dsh-prompt-setting'

# 装 tarball——先在插件目录里打包，行为完全一致
cd packages/dsh-prompt-setting && pnpm pack
dsh plugin --profile web add '<刚打出的 .tgz 绝对路径>'
```

pnpm ≥10 默认**不**运行 git 依赖的构建脚本，所以 git 安装第一次会失败并打印一个**确切的包键**
（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）；把它复制进该 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`
再重跑 `add` 就好。**这项授权 = 允许该包的代码在安装时于你的机器上执行**，所以只对可信来源授权、并锁定
commit（`…#<sha>`）。本包零构建，`prepare` 只做发布自检（入口是否齐全、是否都在 `files` 白名单里、patch
每一行能否解析）；想完全避开授权，就用 `pnpm pack` 打出 tarball 再 `add`，功能完全一致。

### 确认挂上了

打开 DSH Web GUI →「设置」，应能看到 **「Prompt 管理」** 这一栏。想确认宿主半挂上了没有：页面的
「原始响应」区会显示 `GET /prompt-setting/ping` 的返回 JSON，也可以在页面控制台执行
`await (await fetch('/prompt-setting/ping')).json()`。

> 用裸 `curl` 直接请求这个路由会被拒（`401`）：它要求浏览器的 cookie 认证，这是预期行为，
> 不代表路由没挂上。详见 [`NOTES.md`](./packages/dsh-prompt-setting/NOTES.md) §4。

真机实测输出、判据表与未验证项见 [`NOTES.md`](./packages/dsh-prompt-setting/NOTES.md) §96；
面向插件包本身的简介、功能与安装（中英对照）见 [`packages/dsh-prompt-setting/README.md`](./packages/dsh-prompt-setting/README.md)。

## 四、使用须知（几条容易踩的边界）

- **生效时机**：保存后从**下一轮 / 新会话**生效，不会改写正在进行中的回合。
- **写入面很窄**：只有「我的 Prompt」这一段可写。其他内置段**只能看不能改**——
  `PUT`、单名 `DELETE`、`import` 一律返回 `403 write-locked`（拒绝时不碰文件一个字节）。
- **两层作用域**：用户级默认 + 工作区级覆盖，**工作区级优先**；适合「全局一套，某个项目另加几句」。
- **装了但没写 = 等于没装**：未填写时这一段对最终 prompt 零贡献，渲染结果逐字节相同。
- **数据落在哪**：只写插件自己的数据目录（用户级 + 工作区级两个层文件，外加一份 `history.jsonl`）。

### 「我的 Prompt」注入的是文本，不是行为开关

- **它做的事是「把文本注入到 system prompt 的末尾」**：排在所有内置段之后（2026-09-30 21:32 之后的本机
  `standard` 会话实测，注入命中率与末位率都是 100%）。它**不是**模型行为的强制开关。
- **对输出语言这类表层风格通常有效**；**对 reasoning / 内部思考语言的影响不稳定，由模型与平台决定**——
  实测出现过可见输出为中文、同一会话 reasoning 却全英文。这不等于插件没生效。
- **必现不生效的两种情况**（与「模型不遵从」要分开）：① 该会话的 agent preset 声明了 `complete: true`
  （内置 `minimal`、本机「梁神模式」）⇒ 平台把装配压成单段，本插件写入必然进不了最终 prompt，设置页会
  给阻断级提示；② 插件整体没加载（插件挂掉不影响 DSH 启动，终端是唯一信号，先跑 `node scripts/check-compat.mjs`）。

**本会话自证（两条路径 + 失败判读）**：

```bash
# 路径一（最硬）：读该会话落盘的最终 prompt
ls ~/.dsh/sessions                              # 先找到你的工作区目录（转义形式，非 ASCII 变成 ~XXXX~）
F=~/.dsh/sessions/<工作区目录>/<会话id>/session.v4.jsonl.zstd   # 例：--Users-me-Documents-proj--
zstd -dc "$F" | jq -r 'select(.type=="system/message") | .data.message.content[0].text[-200:]'
```

- **路径二（GUI）**：设置 → **Prompt settings** →「我的 Prompt」面板看**冻结提示**；「高级」页状态卡看
  **冻结状态**与**构建戳**（`与宿主一致` / `页面版本已过期` / `构建戳未知`，显示过期刷新页面即可）。
- **判读规则**：末位出现你写的那几句 ⇒ 注入正常，模型不照做时应去查**模型遵从**或**preset 冻结**；
  末尾找不到或整条为空 ⇒ 先查该会话的 `agentPreset` 与「冻结状态」。

## 五、仓库结构

```
packages/dsh-prompt-setting/   # 插件包本体（可独立 npm 发布）
├── index.js                   # 宿主半：路由 + 装配监听器 + 注册保留段
├── client.js                  # 客户端半：设置页四个 tab
├── core/                      # 纯函数内核 + 唯一碰文件系统的 store
├── cordis.patch.yml           # bundle 补丁（一条 insert 挂上两个半边）
├── scripts/                   # check-compat.mjs（只读诊断）+ prepare.mjs（从 git 安装的门禁）
├── CONTRACT.md                # 冻结的 REST 契约（客户端照它写）
├── NOTES.md                   # 设计取舍、实测记录、未验证项
└── test/                      # 十四个测试套件
assets/                        # 本 README 的头图
.dsh-graph/                    # 项目看板与事件流（内层独立仓库，不纳入本仓库）
.worktrees/                    # 子代理隔离工作树（不纳入本仓库）
```

## 六、开发与测试

```bash
cd packages/dsh-prompt-setting

# 语法检查
node --check index.js && node --check client.js && for f in core/*.js scripts/*.mjs; do node --check "$f"; done

node --test                    # 十四个套件；集成套件用真 DSH 包跑对照实验，须为 pass（非 skip）
node scripts/check-compat.mjs  # 只读兼容性自检（不联网、永不抛、退出码恒 0）
node scripts/prepare.mjs       # prepare 门禁：从 git 安装时 pnpm 会自动跑它（不通过则 exit 1）
npm pack --dry-run             # 确认发布产物干净（21 个文件、无 test/、无 .dsh-graph）
```

最近一次在本机跑的结果：`node --test` **480 项断言全部通过、0 skipped**（含集成套件 31 项），
`npm pack --dry-run` 21 个文件（2026-10-02 实测）。

要点：

- `test/integration.test.mjs` 会解析本机 DSH 安装根里的真 `@deepseek-ai/dsh-system-prompt` 与真 Cordis，
  在真上下文里验证装配语义（waterfall 顺序、`complete` 冻结、scope 遮蔽）——**这些结论不是猜的，是实测的**，
  结论同时写进 [`CONTRACT.md`](./packages/dsh-prompt-setting/CONTRACT.md) 与快照的 `experiments` 字段。
- 解析不到真包时该套件会 `skip`，所以没有 DSH 的机器上 `node --test` 仍全绿；
  **开发机必须看到它 pass 而不是 skip**——skip 即证据缺失。
- 测试不需要浏览器：`client.js` 在 `node:vm` 沙箱里跑，`require` / React / `fetch` 全是桩，
  因此「primitives 可用 / 不可用」「探针成功 / HTTP 错误 / 网络错误」都能离线断言。
- 测试过程绝不会读写真实的 `~/.dsh`：相关套件会把 `$DSH_HOME` 指向临时目录。

DSH 升级后插件没出现、终端也没报错时，先跑 `node scripts/check-compat.mjs` —— 它会直接打印
四种 boot 失败形态的终端签名与救援步骤。代码改动的生效方式与维护者命令见插件包 README 的
「给维护者」一节；详尽实测记录见 [`NOTES.md`](./packages/dsh-prompt-setting/NOTES.md) §91。

## 七、设计要点

- **看得见**：宿主侧调 `ctx.systemPrompt.assemble({scope: agent})`，拿到分段（`sections[{name,text}]`）与全文。
- **改得动，但不改核心**：注册官方 `system-prompt/assemble` waterfall hook，按段名替换 / 屏蔽 / 追加，
  **不改 DSH 核心、不改全局安装包**。
- **自己的段自己注册**：插件在 `apply` 期间用 `ctx.systemPrompt.section()` 注册保留段
  `prompt-setting:custom-prompt`（空文本、`interpolate: false`），用户的文本通过覆盖引擎落到这一段，
  并被一个最外层监听器搬到最终装配的**最后**。
  `interpolate: false` 不是风格选择：用户文本一旦参与插值，写一个 `{{不存在的变量}}` 就会让之后每一轮装配抛错。
- **分层可测**：`core/` 下除 `store.js` 外全是纯数据进、纯数据出的纯函数，`store.js` 是唯一碰文件系统的模块，
  且不在装配路径上；装配路径上的监听器只读内存、始终调用 `next()`。
- **失败姿态保守**：注册、自检、装配中的任何异常都不会让 DSH 启动失败；`apply` 中途失败会回滚已注册的 effect，不留半挂载。

## 八、文档地图

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| 本文件 | 所有人 | 这是什么、怎么装、怎么用、仓库全貌 |
| [`packages/dsh-prompt-setting/README.md`](./packages/dsh-prompt-setting/README.md) | 使用者 / 开发者 | 包简介与功能（中英对照）、安装、维护者要点、出问题时怎么办 |
| [`CONTRACT.md`](./packages/dsh-prompt-setting/CONTRACT.md) | 开发者 | 冻结的 REST 契约：字段、动作枚举、字段上限、每一个 4xx |
| [`NOTES.md`](./packages/dsh-prompt-setting/NOTES.md) | 开发者 | 设计取舍与实测记录（含未验证项与已推翻的旧结论） |
| [`CHANGELOG.md`](./CHANGELOG.md) | 使用者 / 开发者 | 每个版本的用户可感知变更（中英对照；当前 0.1.2，尚未发布） |

## 九、状态与路线图

- **已交付**：插件骨架与本地 profile 挂载（host + client 两半、设置页入口）、宿主侧装配分段快照 +
  `system-prompt/assemble` 覆盖引擎 + 用户级/工作区级两层持久化、设置页 Prompt 管理器
  （分段浏览、全文检索、就地编辑与不可覆盖段标注、覆盖管理）、版本历史 + diff、恢复默认、导出 / 导入。
- **当前形态（契约 Revision 8）**：写入面收窄到保留段「我的 Prompt」；其余段只读；设置页按功能与频率分成四个一级 tab。
- **真机验收状态、残余边界与未验证项**见上述三份包内文档；进度与验收证据以 `.dsh-graph` 看板为准。

## 十、许可证

MIT —— 见 [`LICENSE`](./LICENSE)（`packages/dsh-prompt-setting/LICENSE` 是同一份，随 npm 包发布）。

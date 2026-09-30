![dsh-prompt-setting：DSH 预设 Prompt 管理](./assets/hero.jpg)

# dsh-prompt-setting

[English](./README.md) | 中文

**DSH 的系统提示词（System Prompt）管理插件。** 它在 DeepSeek Harness 的 Web GUI「设置」里加一栏
Prompt 管理器：**看得见**每一轮会话最终装配出来的系统提示词，搜得到、写得上自己的指令、改错了能回滚，
全程**不碰 DSH 全局安装包**。

![license](https://img.shields.io/badge/license-MIT-blue)
![version](https://img.shields.io/badge/version-0.1.0-blue)
![dsh](https://img.shields.io/badge/DSH-%3E%3D0.1.7--rc.2-blueviolet)
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
| **高级** | 旧版覆盖的只读列表、「清除全部覆盖」与「整层恢复默认」两个二次确认按钮、完整状态区（挂载情况 / 构建戳 / 渲染器自检）。 |

> 界面文案跟随 DSH 语言：DSH 切到 English，这一页就是英文，不需要刷新或重启。

## 三、安装

**前置条件**：已安装 DSH（`>= 0.1.7-rc.2 < 0.2.0`：含 `0.2.0` 的全部预发布 `0.2.0-0` / `alpha` /
`beta` / `rc.N`，`0.2.0` 正式版出界）。跑测试和开发才需要 Node `>= 22`。

1. 把本仓库克隆/下载到本地任意目录；
2. 用 DSH 的 plugin manager 以**绝对路径**安装插件目录（**不要**手工编辑 profile 配置文件）：

   ```
   plugin_manager(action: "install_bundle", target: "<仓库绝对路径>/packages/dsh-prompt-setting")
   ```

3. 打开 DSH Web GUI →「设置」，应能看到「Prompt 管理」这一栏；
4. 想确认宿主半挂上了没有：页面的「原始响应」区会显示 `GET /prompt-setting/ping` 的返回 JSON，
   也可以在页面控制台执行 `await (await fetch('/prompt-setting/ping')).json()`。

> 用裸 `curl` 直接请求这个路由会被拒（`401`）：它要求浏览器的 cookie 认证，这是预期行为，
> 不代表路由没挂上。详见 [`NOTES.md`](./packages/dsh-prompt-setting/NOTES.md) §4。

### 从 GitHub 直接安装（可选）

不想先克隆仓库，也可以让 pnpm 直接从 git 装。本仓库是 monorepo、插件在子目录，所以**必须带 `#path:`**
（不带会装到仓库根合成的 `0.0.0` 空包，插件不会出现）：

```sh
dsh plugin --profile demo add 'github:zangxx66/dsh-prompt-setting#path:/packages/dsh-prompt-setting'
```

pnpm ≥10 默认**不**运行 git 依赖的构建脚本，第一次会失败并打印一个**确切的包键**
（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）；把它复制进该 profile 的 `pnpm-workspace.yaml` 的
`allowBuilds` 再重跑 `add` 就好。**这项授权 = 允许该包的代码在安装时于你的机器上执行**，
所以只对可信来源授权、并锁定 commit（`…#<sha>`）。本包零构建，`prepare` 只做发布自检
（入口是否齐全、是否都在 `files` 白名单里、patch 每一行能否解析）；想完全避开授权，
就用 `pnpm pack` 打出 tarball 再 `add`，功能完全一致。

真机实测输出、判据表与未验证项见 [`NOTES.md`](./packages/dsh-prompt-setting/NOTES.md) §96；
面向插件包本身的简介、功能与安装（中英对照）见 [`packages/dsh-prompt-setting/README.md`](./packages/dsh-prompt-setting/README.md)。

## 四、使用须知（几条容易踩的边界）

- **生效时机**：保存后从**下一轮 / 新会话**生效，不会改写正在进行中的回合。
- **写入面很窄**：只有「我的 Prompt」这一段可写。其他内置段**只能看不能改**——
  `PUT`、单名 `DELETE`、`import` 一律返回 `403 write-locked`（拒绝时不碰文件一个字节）。
- **两层作用域**：用户级默认 + 工作区级覆盖，**工作区级优先**；适合「全局一套，某个项目另加几句」。
- **装了但没写 = 等于没装**：未填写时这一段对最终 prompt 零贡献，渲染结果逐字节相同。
- **数据落在哪**：只写插件自己的数据目录（用户级 + 工作区级两个层文件，外加一份 `history.jsonl`）。

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
npm pack --dry-run             # 确认发布产物干净（20 个文件、无 test/、无 .dsh-graph）
```

最近一次在本机跑的结果：`node --test` **395 项断言全部通过、0 skipped**（含集成套件 21 项），
`npm pack --dry-run` 20 个文件（2026-09-30 实测）。

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
| [`CHANGELOG.md`](./CHANGELOG.md) | 使用者 / 开发者 | 每个版本的用户可感知变更（中英对照；当前 0.1.0，尚未发布） |

## 九、状态与路线图

- **已交付**：插件骨架与本地 profile 挂载（host + client 两半、设置页入口）、宿主侧装配分段快照 +
  `system-prompt/assemble` 覆盖引擎 + 用户级/工作区级两层持久化、设置页 Prompt 管理器
  （分段浏览、全文检索、就地编辑与不可覆盖段标注、覆盖管理）、版本历史 + diff、恢复默认、导出 / 导入。
- **当前形态（契约 Revision 8）**：写入面收窄到保留段「我的 Prompt」；其余段只读；设置页按功能与频率分成四个一级 tab。
- **真机验收状态、残余边界与未验证项**见上述三份包内文档；进度与验收证据以 `.dsh-graph` 看板为准。

## 十、许可证

MIT —— 见 [`LICENSE`](./LICENSE)（`packages/dsh-prompt-setting/LICENSE` 是同一份，随 npm 包发布）。

# dsh-prompt-setting

DeepSeek Harness（DSH）**默认 System Prompt 管理插件**：在 Web GUI「设置」里提供一栏 Prompt 管理器，
让你看得见最终装配出来的 system prompt、搜得到、改得动、可回滚，且**不改写 DSH 全局安装包**。

## 为什么需要它

DSH 每轮会话都会注入由 `@deepseek-ai/dsh-system-prompt` 装配的基座系统提示词。当前想改动它只能
去全局安装包（pnpm 全局 `node_modules`）里硬改文件：升级即丢失、污染全局安装、无法回溯与对比，
也没有任何可视化手段看清「最终拼出来的 system prompt 到底长什么样」。

## 能力与阶段

| 阶段 | 能力 | 状态 |
| --- | --- | --- |
| 阶段一 A | 插件骨架与本地 profile 挂载（host + client 两半、设置页入口） | ✅ 已交付 |
| 阶段一 B | 宿主：装配分段快照 + `system-prompt/assemble` 覆盖引擎 + 两层持久化 | ✅ 已交付 |
| 阶段一 C | 客户端：分段浏览、全文检索、就地编辑（含不可覆盖段标注）、覆盖管理 | ✅ 已交付 |
| 阶段二 | 版本历史 + diff、恢复默认、导出 / 导入 | 规划中 |

## 设计要点

- **看得见**：host 侧调 `ctx.systemPrompt.assemble({scope: agent})`，返回分段（`sections[{name,text}]`）与全文；
- **改得动**：注册官方 `system-prompt/assemble` waterfall hook，按段名替换 / 屏蔽 / 追加，**不改核心、不改安装包**；
- **作用域两层**：用户级默认 + 工作区级覆盖（后者优先）；
- **生效边界**：保存后从下一个会话 / 下一轮生效，不改写正在进行中的回合；
- **跟随语言**：客户端文案**全部**走 DSH 的 locale 命名空间词典（zh/en 两套内联，键位必须相等），
  DSH 语言切到 English 时本页即英文，无需刷新或重启；自动化以「en 渲染横扫」保证零 CJK、无裸 key 回落，
  覆盖范围与不覆盖的部分见 [`packages/dsh-prompt-setting/NOTES.md`](./packages/dsh-prompt-setting/NOTES.md) §89；
- **持久化**：只写插件自己的数据目录，升级 DSH 不丢配置。

## 仓库结构

```
packages/dsh-prompt-setting/   # 插件包本体（可独立 npm 发布）
.dsh-graph/                    # 项目看板与事件流（内层独立仓库，不纳入本仓库）
.worktrees/                    # 子代理隔离工作树（不纳入本仓库）
```

## 开发与安装

插件以「本地 bundle」形式安装进 DSH profile：

1. `packages/dsh-prompt-setting/` 内保持 `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`；
2. 由 DSH 的 plugin manager 以**绝对路径**安装该目录（不要手工编辑 profile 配置文件）；
3. 代码改动的生效方式与排障顺序、以及插件包的详细说明，见
   [`packages/dsh-prompt-setting/README.md`](./packages/dsh-prompt-setting/README.md)。

## 测试与验证

```bash
cd packages/dsh-prompt-setting
node --test                    # 十二个套件；集成套件用真 DSH 包跑对照实验，须为 pass（非 skip）
node scripts/check-compat.mjs  # 只读兼容性自检（不联网、永不抛、退出码恒 0）
npm pack --dry-run             # 确认发布产物干净（16 个文件、无 test/、无 .dsh-graph）
```

`test/boot.test.mjs`（g-013）钉住 boot 韧性：导入期兼容自检三分支、`apply` 失败只打印一条且回滚已注册的
effect（不留半挂载）、boot 连续性、客户端 factory 不把异常抛回 loader。DSH 更新后插件没出现、终端也没报错时，
先跑 `node scripts/check-compat.mjs`，再看插件包 README 的「兼容性与救援」一节。

其中 `test/integration.test.mjs` 会直接解析本机 DSH 安装根里的真
`@deepseek-ai/dsh-system-prompt` 与真 Cordis，在真上下文里验证装配语义（waterfall 顺序、
`complete` 冻结、scope 遮蔽）——**这些结论不是猜的，是实测的**，结论同时写进
[`CONTRACT.md`](./packages/dsh-prompt-setting/CONTRACT.md) 与快照的 `experiments` 字段。

## 状态

- **阶段一（A/B/C）已交付**：插件骨架与本地挂载、宿主侧装配快照 + `system-prompt/assemble`
  覆盖引擎 + 用户级/工作区级两层持久化、客户端设置页 Prompt 管理器（分段浏览、全文检索、
  就地编辑、覆盖管理）。REST 契约已冻结于 `CONTRACT.md`（Revision 3）。
- **阶段二（规划中）**：版本历史 + diff、恢复默认、导出 / 导入。
- 进度与验收证据以 `.dsh-graph` 看板为准。

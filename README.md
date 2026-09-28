# dsh-prompt-setting

DeepSeek Harness（DSH）**默认 System Prompt 管理插件**：在 Web GUI「设置」里提供一栏 Prompt 管理器，
让你看得见最终装配出来的 system prompt、搜得到、改得动、可回滚，且**不改写 DSH 全局安装包**。

## 为什么需要它

DSH 每轮会话都会注入由 `@deepseek-ai/dsh-system-prompt` 装配的基座系统提示词。当前想改动它只能
去全局安装包（pnpm 全局 `node_modules`）里硬改文件：升级即丢失、污染全局安装、无法回溯与对比，
也没有任何可视化手段看清「最终拼出来的 system prompt 到底长什么样」。

## 能力（规划中）

| 阶段 | 能力 |
| --- | --- |
| 阶段一 A | 插件骨架与本地 profile 挂载（host + client 两半、设置页入口） |
| 阶段一 B | 宿主：装配分段快照 + `system-prompt/assemble` 覆盖引擎 + 两层持久化 |
| 阶段一 C | 客户端：分段浏览、全文检索、就地编辑（含不可覆盖段标注） |
| 阶段二 | 版本历史 + diff、恢复默认、导出 / 导入 |

## 设计要点

- **看得见**：host 侧调 `ctx.systemPrompt.assemble({scope: agent})`，返回分段（`sections[{name,text}]`）与全文；
- **改得动**：注册官方 `system-prompt/assemble` waterfall hook，按段名替换 / 屏蔽 / 追加，**不改核心、不改安装包**；
- **作用域两层**：用户级默认 + 工作区级覆盖（后者优先）；
- **生效边界**：保存后从下一个会话 / 下一轮生效，不改写正在进行中的回合；
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
3. **改动插件包 JS 实体后必须重启 `dsh web` 进程**才会加载新代码（patch/config 改动可热生效）。

## 状态

阶段一 A 正在开发。进度以 `.dsh-graph` 看板为准。

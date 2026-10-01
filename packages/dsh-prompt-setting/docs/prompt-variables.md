# 提示词变量台账（`dsh-prompt-setting`）

这份文档回答一个具体问题：**模型实际收到的 system prompt 里，`{{变量}}` 会被替换成什么，不替换时又会怎样。**
它是 g-023（变量盘点）与 g-024（预览现状复核）的结论落盘，记录 g-025 的实现（未解析后果分级），
并记录 g-026 的实现（「我的 Prompt」变量替换开关，§9）。

- 数据快照：DSH `0.2.0-rc.2`，`dsh-prompt-setting` 工作树基线 `6fa99d2`（g-026 改动随本次提交）。
- 口径：只统计**已发布**（shipped）的 preset / patch 与插件自身的保留段；用户自建的 override 文本按同一规则处理。
- 行号来自上述快照，会随上游版本漂移；结论依赖的是**结构与语义**，不是行号。

本文件**不在** `package.json` 的 `files` 白名单内（白名单不含 `docs`），因此它随仓库走、不随 npm 包发布，`npm pack` 的文件数与体积不受影响。

## 1. 引用清单：14 处，全部在 persona 配置

`{{变量}}` 只出现在各 app 的 agent preset（`*.patch.yml`）里，且只在 `@deepseek-ai/dsh-persona` 的 `prefix` / `suffix` 文本中：

| 文件（相对 DSH 安装的 `node_modules/.pnpm/`） | 位置 | 引用 |
| --- | --- | --- |
| `@deepseek-ai+dsh-web-app@*/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml` | `preset-standard` → `persona.config.suffix` / `.prefix` | `{{cwd}}` / `{{model}}` |
| `…/dsh-web-app/presets/ptc.patch.yml` | 同上 | `{{cwd}}` / `{{model}}` |
| `…/dsh-web-app/presets/cordis.patch.yml` | 同上 | `{{cwd}}` / `{{model}}` |
| `@deepseek-ai+dsh-web-app@*/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml` | `system-prompt.config.personaSuffix` / `.personaPrefix` | `{{cwd}}` / `{{model}}` |
| `@deepseek-ai+dsh-sdk-app@*/node_modules/@deepseek-ai/dsh-sdk-app/cordis.patch.yml` | 同上 | `{{cwd}}` / `{{model}}` |
| `@deepseek-ai+dsh-headless@*/node_modules/@deepseek-ai/dsh-headless/cordis.patch.yml` | 同上 | `{{cwd}}` / `{{model}}` |
| `@deepseek-ai+dsh-acp-app@*/node_modules/@deepseek-ai/dsh-acp-app/cordis.patch.yml` | 同上 | `{{cwd}}` / `{{model}}` |

7 个文件 × 2 处 = **14 处**；出现的变量名集合恰为 `{cwd, model}`。原文形如：

```yaml
# presets/*.patch.yml:插件形态
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: Your working directory is {{cwd}}.
    prefix: You are a coding agent powered by the {{model}} model.

# <app>/cordis.patch.yml:配置形态
- id: system-prompt
  config:
    personaSuffix: Your working directory is {{cwd}}.
    personaPrefix: >-
      You are a coding agent powered by the {{model}} model.
```

`presets/minimal.patch.yml` 与其余 shipped 段（`harness:identity`、`deployment:persona-suffix` 等）不含任何 `{{变量}}`。本插件自己注册的保留段（`prompt-setting:custom-prompt`）默认是空串，用户写入的文本**默认不参与替换**（§4），因此它里面的 `{{...}}` 是字面量而不是引用——除非用户显式打开变量替换开关（§9），此时保留段加入插值，引用按 §4 的规则真实替换或抛错。

## 2. 注册变量：恰好 3 个，全部按 `context.agent` 求值

`@deepseek-ai/dsh-agent-loop/lib/index.js`（快照行号 1564–1566）：

```js
ctx.systemPrompt.variable("provider", (context) => context.agent?.options.provider);
ctx.systemPrompt.variable("model",    (context) => context.agent?.options.model);
ctx.systemPrompt.variable("cwd",      (context) => context.agent?.session.header.cwd);
```

- 三个变量都在 **global 层**注册（`ctx.systemPrompt.variable(...)`），值由 provider 回调在装配时求值。
- 三者都读 `context.agent`。没有 Agent 的装配（例如无会话的探针）得到 `undefined`——这正是「值缺失」在真机上真实发生的原因。
- 变量名受 shipped 语法约束 `/^[a-z][a-z0-9_]*$/`（`dsh-system-prompt/lib/index.js:59`），所以 `{{Upper}}`、`{{a-b}}` 这类写法不是变量，而是**畸形引用**（§4）。

## 3. 双向差集

| 方向 | 结果 |
| --- | --- |
| 引用 − 已注册 | **∅**（`{cwd, model}` 全部已注册，没有「引用了但没人提供」的变量） |
| 已注册 − 引用 | **{provider}**（注册了但 shipped 从不引用；它仍可被用户文本引用） |

结论：在 shipped 输入下，变量**不缺**，缺的只可能是**值**（无 Agent 的装配）。g-025 的分级因此不是「补变量」，而是「说清缺值时真实装配会怎样」。

## 4. 插值语义依据（shipped `renderPrompt`）

`@deepseek-ai/dsh-system-prompt/lib/index.js`：

```js
function renderPrompt(assembly) {
  return assembly.sections
    .map((section) => section.interpolate === false ? section.text : interpolate(section, assembly.variables, "section"))
    .filter((text) => text.length > 0)
    .join("\n\n");
}
```

规则（同一文件 `interpolate()`）：

1. 段列表按数组顺序渲染，空串段被丢弃，其余用**一个空行**连接；
2. `interpolate === false` 的段**整段跳过插值**，`text` 原样返回——里面的 `{{...}}` 就是模型读到的字面量；
3. 其余段逐个扫描 `{{name}}`：
   - 组不完整但后面还有 `}}` ⇒ `malformed prompt variable reference` **抛错**；
   - `name` 不匹配 `/^[a-z][a-z0-9_]*$/` ⇒ `malformed prompt variable reference` **抛错**；
   - 变量未注册 ⇒ `unknown prompt variable` **抛错**；
   - 变量已注册但值为 `undefined` ⇒ `prompt variable "{{name}}" has no value for this assembly` **抛错**；
   - 否则替换为值；**替换结果不再扫描**（不递归展开）。
4. 单独的 `{{` 且其后没有任何 `}}` ⇒ 视为散文，原样保留，不视为引用。

**本插件的只读预览与 shipped 的已知差异**（刻意保留，见 `CONTRACT.md` §2.3）：预览在同一个未解析引用上**不抛错**，而是保留字面量并上报（见 §5）。原因：快照是只读视图，不能因为 provider 文本而整体失败；预览绝不显示一个从未存在过的值（绝不输出裸 `undefined`）。

g-025 曾记录第二处更细的差异：`{{ lone {{c}}` 这种「组内含花括号、后面另有 `}}`」的写法，shipped 判 malformed 抛错，而预览的 **`interpolate: false` 分支**把它当散文跳过。**g-026 在预览的插值分支修正了这一点**：插值段里的畸形组现在进 `unresolvedThrowing`（带与 Host 报错同样的 16 字符摘录），于是「预览说不会抛错、实际每轮抛错」这一矛盾不再存在。`interpolate: false` 段的分支保持原样（那里的字面量**就是**真实 prompt，不存在抛错问题）。写入侧的严格校验器另有一套精确口径，见 §9。

## 5. 未解析引用的后果分级（g-025 实现）

「未解析」= 变量未注册，或已注册但值为 `undefined`/`null`。它对**真实装配**的后果取决于引用落在哪种段：

| 字段（`/snapshot`） | 引用所在段 | 真实装配的行为 | 预览的价值 |
| --- | --- | --- | --- |
| `unresolvedVariables` / `unresolvedThrowing` | `interpolate !== false` | **每轮抛错**，该会话的 prompt 组装不出来 | 不是真实 prompt；该会话没有 prompt |
| `unresolvedLiteral` | `interpolate === false`（本插件保留段） | 原样交给模型，字面量**就是** prompt | 就是真实 prompt，所见即所得 |

- `unresolvedVariables`（既有字段）语义与取值**未变**：仍是「会抛错」的那批引用名（排序去重）。`unresolvedThrowing` 是同一数组的显式分级名，供客户端不必推断。
- `unresolvedLiteral` 与它们**互斥**：一个引用只属于一个段，只出现在一个列表里。在 `interpolate: false` 段里**可解析**的引用两个列表都不进——它的值存在，只是从不替换，所以字面量不是缺陷。
- `renderedResolved` 定义未变（`=== unresolvedVariables.length === 0`）。只有 literal 未解析引用时它仍为 `true`，但 `unresolvedLiteral` 非空：安全态，客户端不得当作警告呈现。
- 预览全程**只读**：不写回装配、不为预览打开用户段的 `interpolate`、不改变模型实际收到的 prompt。分级只是让 UI 说清 shipped 渲染器**将会做什么**（包括它会抛错）。

## 6. 预览实现链与边界（g-024 结论）

真实插值预览**并非新功能**，它既已存在且已契约化：

| 环节 | 位置 |
| --- | --- |
| 只读渲染内核 | `core/overrides.js` → `renderSections()`（合法引用按 `assembly.variables` 真实替换；未解析保字面量并上报；g-025 起按段分级） |
| 路由调用点 | `index.js` → `handleSnapshot()`（`renderSections(overrideProbe.after, overrideProbe.variables)`） |
| 响应字段 | `rendered` / `renderedResolved` / `unresolvedVariables` / `unresolvedThrowing` / `unresolvedLiteral` |
| 客户端落点 | 「提示词总览 → 完整渲染」`client.js` → `renderFullView()`：危险态 `data-warning="rendered-unresolved"`，安全态 `data-note="rendered-literal"` |
| 契约 | `CONTRACT.md` §2.3，已知限制 §7.1 |

边界（g-024 已定，g-025 不越界；g-026 只动其中一条）：

- 预览**只读**：不改变模型实际收到的 prompt；g-026 打开的插值只作用于本插件自己注册并持有的那一个段定义（`CONTRACT.md` §16.2），与预览无关；
- **不下发变量真值到客户端**（属契约变更），响应里只有引用名与分级；`GET /prompt-setting/interpolate` 例外地下发**变量名列表**（不含值），供用户知道可以写哪些名字；
- ~~不加 tab、不加开关~~ → **g-026 加入了「我的 Prompt」变量替换开关**（§9，`CONTRACT.md` §16）；tab 数量与结构未变；
- 缺值/未注册变量**绝不输出裸 `undefined`**（项目铁律）；
- 合法输入下 `rendered` 与 shipped `renderPrompt` **逐字符一致**：由 `test/integration.test.mjs` 中 `integration g-025:*` 三个用例对真实 `renderPrompt` 固化（替换 / 孤立 `{{` / `interpolate: false` 段逐字符相等；未知名 / 畸形名 / `undefined` 值则「shipped 抛错 vs 预览分级」对照）。

## 7. 复现命令

在 **DSH 安装根**（含 `.pnpm`）下运行。先定位它（本机为 pnpm 全局布局）：

```bash
ls -d ~/.local/share/pnpm/global/*/*/node_modules   # 其一含有 @deepseek-ai/dsh
cd <上一步的 node_modules 目录>
```

```bash
# ① 引用清单：每个 patch 里的 {{变量}}（本机实测 7 个文件 × 2 = 14 处）
grep -rn '{{[a-z_]*}}' --include='*.patch.yml' .

# ② 注册变量：恰好 3 个，全部 global 层注册、按 context.agent 求值
grep -n 'systemPrompt.variable(' \
  @deepseek-ai+dsh-agent-loop@*/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js

# ③ 双向差集（引用 − 已注册 应为空；已注册 − 引用 应为 provider）
refs=$(grep -rho '{{[a-z_]*}}' --include='*.patch.yml' . | tr -d '{}' | sort -u)
regs=$(grep -ho 'systemPrompt.variable("[a-z_]*"' \
  @deepseek-ai+dsh-agent-loop@*/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js \
  | sed 's/.*"\(.*\)"/\1/' | sort -u)
echo "refs: $refs"; echo "regs: $regs"
echo "refs-regs: [$(comm -23 <(echo "$refs") <(echo "$regs") | tr '\n' ' ')]"
echo "regs-refs: [$(comm -13 <(echo "$refs") <(echo "$regs") | tr '\n' ' ')]"

# ④ 插值语义：读 shipped 渲染器本身
sed -n '105,180p' @deepseek-ai+dsh-system-prompt@*/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js
```

本插件一侧的回归（不依赖 DSH 是否安装）：

```bash
cd packages/dsh-prompt-setting && node --test
```

## 8. 变量替换开关（g-026 实现）

`CONTRACT.md` §16 是契约；本节是同一件事的台账视角：**开关打开后，哪些 `{{...}}` 会被替换，哪些会让会话每轮抛错。**

### 8.1 开关长什么样

- 载体：任一层 `overrides.json` 顶层的布尔字段 `interpolateCustom`。**字段缺失 = 关闭**，这也是所有旧配置文件的形态；
- 优先级：工作区层「显式声明」优先于用户层；工作区层未声明则**继承**用户层；两层都未声明 = 关闭；
- 运行时切换：`index.js` 持有交给 `systemPrompt.section()` 的那个定义对象，开关变化时改它的 `interpolate` 字段。Host 的 `NamedEntries` 按引用保存该对象，且每轮 `assemble` 都会现读 `section.interpolate`，所以**下一个回合即生效**，不需要重启、不需要重新注册；
- 关闭时把字段从文件里**删掉**，因此开→关→开后配置文件逐字节回到开启前。

### 8.2 打开后，写入侧会拦什么

校验口径**逐行复刻** shipped `interpolate()`（§4 的规则表），复用 shipped 的同一组正则（`^[a-z][a-z0-9_]*$` 与 `^\{\{([^{}]*)\}\}`）：

| 文本里的写法 | shipped 真实装配 | 保存/导入时 |
| --- | --- | --- |
| `{{model}}`、`{{cwd}}`、`{{provider}}`（已注册且有值） | 替换为真实值 | **接受** |
| `{{nope}}`（未注册） | 每轮抛 `unknown prompt variable` | **400 `unresolvable-variable`**，零字节写入 |
| `{{Upper}}`、`{{a-b}}`、`{{a b}}`、`{{}}`（名字非法） | 每轮抛 `malformed prompt variable reference` | **400**，零字节写入 |
| `{{ lone {{c}}`、`{{{{model}}}}`、`{{a{b}}`（畸形组） | 每轮抛 `malformed prompt variable reference` | **400**，零字节写入 |
| `{{maybe}}`（已注册、但本次装配取不到值） | 在**那个装配**里抛 | **接受 + 警告**（见 §8.3） |
| `{{cwd}}` 且值为 `null` | 拼成字符串 `null`，**不抛** | 接受，不报警 |
| `{{unclosed`（后面再没有 `}}`） | 散文，不视为引用 | 接受，不报警 |

校验在**任何字节落盘之前**执行：`PUT /prompt-setting/overrides` 与 `POST /prompt-setting/import`（含 `?dryRun=true`）被拒时，两层文件的 SHA-256 前后一致（`test/route.test.mjs` 固化）。**开启动作本身**也会先校验已经存好的两层文本——一个旧的 `{{typo}}` 在关闭态无害，一开启就成了炸弹，所以不合规时直接拒绝开启并给出修复路径。

### 8.3 唯一的软化：`undefined` 值只警告不拒绝

`provider` / `model` / `cwd` 三个变量都按 `context.agent` 求值（§2），没有 Agent 的装配（例如无会话的探针）拿到 `undefined`。此时「这个名字已注册但当前无值」是**装配的属性，不是文本的属性**：

- 写入侧把它记为**警告**并放行。若硬拒，则没有活跃会话时根本无法保存——而同一段文本在真实会话里可能是完全安全的；
- 加载期自检同样只对**致命**类别降级，不因 `undefined` 停用整层；
- 严格的四条件判定（`undefined` 也算抛错）**仍然实现并有测试**（`core/interpolate.js` 的 `scanThrowingReference`，`test/interpolate.test.mjs` 与 `test/integration.test.mjs` 对真实 `renderPrompt` 固化），只是不用于「拒绝写入」这个决策。

变量名集合来自一次真实 `assemble()`（本插件私有 scope 的探针，与快照同一机制），按 mount 缓存、**每次写入校验前重新探测**。探针失败的 profile 返回 `503 variable-lookup-failed`，而不是猜一个「安全」。

### 8.4 历史文本与加载期

- 开启前校验两层既有文本（工作区层里显式声明 `false` 的跳过，因为不会有东西继承进去）；
- 已经带着炸弹落到磁盘的配置（手改、同步工具、停机期间写入）在**加载期**被**降级 + 给原因**：该层 `config: null`、`error.code = unresolvable-variable`，快照上表现为 `layers.<层>.enabled = false` 并带 reason。它不是「文件非法」（不是 `invalid-config`），也**不静默放行**；
- 本轮还没有变量表时（mount 后的第一个请求、或探针失败的 profile），加载期只查语法类问题——一次探针失败绝不能停用用户的层。

### 8.5 预览一致性

预览用的就是 `section.interpolate`，所以开关一开，保留段的引用自动从 `unresolvedLiteral` 变成 `unresolvedThrowing`，`renderedResolved` 随之变 `false`：

| 开关 | 保留段 | `unresolvedThrowing` | `unresolvedLiteral` | `renderedResolved` |
| --- | --- | --- | --- | --- |
| 关（默认） | `interpolate: false` | `[]` | 该段里的未解析引用 | `true`（字面量就是真实 prompt） |
| 开 | `interpolate: true` | 该段里的未解析引用 | `[]` | `false`（真实装配会抛错） |

`test/route.test.mjs` 的 `g-026 preview:` 用例对同一段文本断言了这两种分级，确保不会出现「预览说不会替换、实际替换了」的自相矛盾。

### 8.6 复现

```bash
cd packages/dsh-prompt-setting
node --test test/interpolate.test.mjs    # 校验器 + 开关语义（不依赖 DSH 安装）
node --test test/route.test.mjs          # 路由、零字节、加载期自检
node --test test/integration.test.mjs    # 真 renderPrompt 逐字符对照（需装 DSH）
```

## 9. 维护提示

- 上游新增变量（第 4 个 `systemPrompt.variable(...)`）或新增 `{{引用}}` 时，本台账的 §1/§2/§3 需要同步；§4 的语义随 `dsh-system-prompt` 版本复核。
- 新增引用若落在 `interpolate: false` 段，按 §5 归入 `unresolvedLiteral`；落在普通段则归入 `unresolvedThrowing` 且真实装配会抛错——这两条是自动化断言固化的（`test/overrides.test.mjs`、`test/route.test.mjs`、`test/client.test.mjs`、`test/integration.test.mjs`）。

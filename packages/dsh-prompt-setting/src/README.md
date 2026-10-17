# `src/` —— `client.js` 的真源切片

**这里的每个 `.js` 文件都不是模块，而是 `client.js` 的一段连续切片。**

它们没有 `import` / `export`，单独 `parse` / `lint` / `node` 执行**必然报错** ——
因为被切开的是**同一个 CommonJS factory 的函数体**，跨文件的括号与作用域在拼接后
才闭合。这也是文件首行那句声明存在的原因：

```
// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。
```

那行声明是**元信息**：`scripts/client-build.mjs` 在拼接前逐段剥离它，它不会进入
`client.js`。所以「段文件的行数」比「该段在 `client.js` 中占的行数」多 1 行，行数预算
按后者算（见 `docs/refactor-plan.md` §5.1 的目标段表：17 段，每段 ≤ 1200 行）。

## 规则

1. **文件名字典序 == 代码顺序**。两位数字前缀（`00-` … `16-`）补零到两位，所以字典序
   与段序号恒等；「顺序」因此不需要一份手工清单。**段集合本身是发布面，但它锚在产物上**：
   `prepare` 用 `renderClient()` 按 `src/` 重算并与磁盘 `client.js` **逐字节**比对（门禁
   `CLIENT-SRC-DRIFT`），缺段、多出陌生段、**段内改了一行**都会 FAIL —— 而且**新增/重切/
   合并段不需要改任何清单**，跑一次 `node scripts/client-build.mjs --write` 就对上了。
2. **只重切、不移动**。每个段必须对应 `client.js` 里一段**连续区间**；可以改切点、可以
   合并相邻段，**不可以**把代码块搬到别的段。搬迁会改变 `const`/`class` 的 TDZ 边界与
   函数声明的提升可见性，而现有用例没有一条能证明那种移动无害
   （`CONTRACT.md` §23.2）。
3. **不要手改 `client.js`**。它是生成物；`client.js` 顶部的头注是生成器产出的，手改产物
   会让 `client:check` 与 `test/client-source.test.mjs` 同时变红。
4. **一个功能点只改一个段**。需要同时改两个段，通常说明切点放错了位置。
5. **有一类段不要手改**：承载 `const zh = {` / `const en = {` 的那一段是**生成的** ——
   人工真源是 `locale/*.json`，改完跑 `node scripts/locale-pack.mjs --write`（它会写进段里
   并顺手重建 `client.js`，所以一次跑完两边都新）。手改该段会被 `locale-pack --check` 拒。
6. **`11-chunks.js` 里的 `CHUNK_STAMPS` 是派生副本，不是第二真源**。真源是磁盘上的
   `client.*.js` 文件；`client-build.mjs --write` 在拼接产物时按磁盘**重算**这一段清单行，
   所以段内那一份从不进发布物，它落后于磁盘是预期且无害的（`CONTRACT.md` §23.1）。
   要同步清单，跑 `node scripts/client-chunks.mjs --write`（它写的是 `client.js`）。

## 改完之后

```sh
node scripts/client-build.mjs --write   # 按 src/ 重建 client.js（内容相同则不动文件）
node scripts/client-build.mjs --check   # 只读校验
node scripts/locale-pack.mjs --check    # 词典生成段：段与产物同时核对
node docs/check-refs.mjs                # §1.3 / §5.1 两张表复算 + 文档引用体检
node --test test/*.test.mjs             # 全量用例
```

`docs/architecture-map.md` 是这张切片的**地图**：域 → 行区间 → 段文件 → 入口函数 →
CONTRACT 章节 → 测试文件。这一份 `README.md` 不参与拼接（生成器只收 `.js` 段文件）。

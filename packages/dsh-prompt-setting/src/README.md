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
   与段序号恒等；「顺序」因此不需要一份手工清单。
2. **只重切、不移动**。每个段必须对应 `client.js` 里一段**连续区间**；可以改切点、可以
   合并相邻段，**不可以**把代码块搬到别的段。搬迁会改变 `const`/`class` 的 TDZ 边界与
   函数声明的提升可见性，而现有用例没有一条能证明那种移动无害
   （`CONTRACT.md` §23.2）。
3. **不要手改 `client.js`**。它是生成物；`client.js` 顶部的头注是生成器产出的，手改产物
   会让 `client:check` 与 `test/client-source.test.mjs` 同时变红。
4. **一个功能点只改一个段**。需要同时改两个段，通常说明切点放错了位置。

## 改完之后

```sh
node scripts/client-build.mjs --write   # 按 src/ 重建 client.js（内容相同则不动文件）
node scripts/client-build.mjs --check   # 只读校验
node docs/check-refs.mjs                # §1.3 / §5.1 两张表复算 + 文档引用体检
node --test test/*.test.mjs             # 全量用例
```

`docs/architecture-map.md` 是这张切片的**地图**：域 → 行区间 → 段文件 → 入口函数 →
CONTRACT 章节 → 测试文件。这一份 `README.md` 不参与拼接（生成器只收 `.js` 段文件）。

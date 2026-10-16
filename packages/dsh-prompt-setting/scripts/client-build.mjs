#!/usr/bin/env node
/**
 * `dsh-prompt-setting` 的客户端生成器（g-075 阶段 1 就位，阶段 2 收敛到 17 段 + 头注）。
 *
 * 为什么需要它：`client.js` 是 **12382 行**的单文件 factory，读一次就要按整块
 * 计费，改一行也要在 2640 行的不可分函数体里定位（`docs/refactor-plan.md` §1）。
 * 阶段 1 把**真源**挪进 `src/`：每个文件 = `client.js` 里**一段连续区间**的切片，
 * 由本脚本按文件名字典序拼接回同一个 `client.js`。发布物、指纹区间、
 * `CHUNK_STAMPS`、chunk 协议、`data-*` marker 全部不变 —— 阶段 1 的验收就是
 * 「`--write` 之后 `client.js` **逐字节等价**」（`git diff` 为空）。
 *
 * 三条实现约束（方案 §5.2 R1-11 + R2-D2，写成断言而不是口号）：
 *   1. **段间不插任何分隔符**：只做「剥离段首声明行 + 按字典序 concat」，没有
 *      trim / 归一化 / 空行处理 —— 任何一处都会改 `fingerprintOf` 的 UTF-16
 *      长度与 hash（§5.2 实现约束 1–3）；
 *   2. `--write` **仅当内容不同才落盘**：mtime 变了即使字节相同，DSH 的 artifact
 *      revision 也会变，触发页面重读与重载（§8-R5）；
 *   3. `CHUNK_STAMPS` 由 `scripts/client-chunks.mjs` 的既有函数重算
 *      （`readDeclaredStamps` / `writeDeclaredStamps` → `renderStampRows`），本
 *      脚本不另写一份实现（§5.2「清单的写入权」）。
 *
 * 阶段 1 **不写任何头注**（加头注就是改字节，与「逐字节等价」互斥，R1-1）。**阶段 2
 * 起**两件被推迟的事落地：①{@link GENERATED_BANNER}（「生成物，勿手改」，构造上
 * 落在 fingerprint `begin` 之前）；②每个段文件首行带一行「片段，不是独立模块」声明，
 * 由 {@link stripDeclaration} 在拼接前逐段剥离（`--check` 要求「全有或全无」）。
 * 于是阶段 2 的验收不再是字节等价，而是更强的**代码零移动**判据：
 * `stripBanner(renderClient())` 与阶段 1 的产物逐字节相同（方案 §5.2 阶段 2 判据 2）。
 *
 * 用法：
 *   node scripts/client-build.mjs           # 校验（等价于 --check）
 *   node scripts/client-build.mjs --check   # 只读校验；不一致 ⇒ 非零退出码
 *   node scripts/client-build.mjs --write   # 按 src/ 重建 client.js（内容相同则不动文件）
 *
 * **行锚点纪律（阶段 1）**：`docs/check-refs.mjs` 把本包若干文件的**行号**当断言
 * （`package.json:22-33`、`scripts/prepare.mjs:180-183`、`test/host.test.mjs:171-197`
 * 等）。因此阶段 1 对既有文件的改动都是**行数中性**的（新增内容与既有行同排，或占用
 * 原本的空行）；本文件与 `src/` 是新增文件，不在此限。阶段 2 的改口同样走行数中性，
 * 只有 `client.js` 因为头注整体下移 —— 那一条由 `docs/check-refs.mjs` 的
 * `CLIENT_HEAD_LINES` 平移处理（文档的 `client.js:行` 引用记的是**段真源坐标**）。
 */

import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PREPARE_FAIL, PREPARE_OK, filesCoverPath } from '../core/prepare.js';
import { clientChunkStamps } from '../core/store.js';
import { readDeclaredStamps, sameStamps, writeDeclaredStamps } from './client-chunks.mjs';

/** 包根目录（本文件在 `scripts/` 下）。 */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** 生成物路径 —— 本脚本唯一会写的文件。 */
const CLIENT_PATH = join(PACKAGE_DIR, 'client.js');

/** 段目录（包根相对路径）。 */
export const CLIENT_SRC_DIR = 'src';
/**
 * 段文件命名：两位数字前缀 + 小写短名 + `.js`。
 *
 * 前缀补零到两位 ⇒ **文件名字典序 == 段序号递增 == 代码顺序**，于是「顺序」不需要
 * 一份手工清单（方案 §5.1 规则 ①、§9-3）。一位数前缀 `0-`/`10-` 会打断这条性质，
 * 所以这里拒绝它而不是猜。
 */
export const SEGMENT_PATTERN = /^(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.js$/;
/**
 * 阶段 2 起每个段文件的首行声明（§5.2 R1-9）。
 *
 * 段是**同一个 factory body** 的连续切片，单独 parse/lint 必然报错，却会随 `files`
 * 白名单发布；这行就是把这件事写在读者眼前。它**不进产物**：{@link stripDeclaration}
 * 在拼接前逐段剥离。
 */
export const SEGMENT_DECLARATION = '// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。';
/**
 * 生成物头注（g-075 阶段 2；方案 §5.2 阶段 2 + §9-4）。
 *
 * 三条性质，都是被别人断言的：
 *   1. **它由生成器产出**，不是手写在 `client.js` 里的 —— 手写的那一份会在下一次
 *      `--write` 时消失，于是「勿手改」这句话本身先被自己违反；
 *   2. **它落在 fingerprint `begin` 标记之前**（`client.js` 最顶部）——
 *      `test/build.test.mjs` 的 `clientSource.indexOf(头注) < clientSource.indexOf(BEGIN)`
 *      是这条的机器证明；头注不在 region 里，所以既不进 `SELF_BUILD` 摘要、也不
 *      改变宿主报给 ping 的 `clientBuild`（方案 §5.2 R1-1 实测：加头注后 hash/size 不变）；
 *   3. **它是纯粹的前缀**，因此 `stripBanner()` 能精确还原无头注的产物 —— 阶段 2 的
 *      核心判据「去掉头注后与阶段 1 产物逐字节相同」由这条性质成立。
 *
 * 阶段 1 **不写**它：阶段 1 的验收是「`--write` 后 `git diff` 为空」，加头注就是改字节，
 * 两条判据互斥（方案 §5.2 R1-1）。
 */
export const GENERATED_BANNER = '/* 生成物，勿手改 — GENERATED FILE, DO NOT EDIT.\n'
  + ' * Rebuilt by `node scripts/client-build.mjs --write` from `src/*.js`: every file in\n'
  + ' * `src/` is one contiguous slice of this file, concatenated in file-name order, and\n'
  + ' * the slice header line on top of each file is stripped before it lands here.\n'
  + ' * Edit `src/`, never this file — `client:check` and `test/client-source.test.mjs`\n'
  + ' * both fail on a hand edit, and the slices are the only source of truth.\n'
  + ' * This banner sits deliberately *outside* the build-fingerprint region below: it must\n'
  + ' * never move the digest the host reports for this bundle (CONTRACT.md §23).\n'
  + ' */\n';

/** 把异常或任意值渲染成一行消息。 */
function reason(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 从 `src/` 的目录条目里挑出段文件，按**文件名字典序**返回（= 代码顺序）。
 *
 * 非 `.js` 条目（如 `src/README.md`）被忽略；**形状不对的 `.js` 一律抛错**：
 * 一个拼错的段名若被静默跳过，生成物就会少一段而 `--check` 只能说「不一致」，
 * 定位成本远高于当场拒绝。
 * @param entries - 目录条目名（`readdirSync('src')` 的结果）。
 * @returns `[{name, index}]`，已按字典序；`index` 是两位前缀的数字值。
 */
export function segmentNames(entries) {
  const found = [];
  const byIndex = new Map();
  for (const name of entries) {
    if (!name.endsWith('.js')) continue;
    const match = SEGMENT_PATTERN.exec(name);
    if (match === null) {
      throw new Error(`${CLIENT_SRC_DIR}/${name} 不符合段文件命名（两位数字前缀 + 小写短名 + .js）`);
    }
    const index = Number(match[1]);
    if (byIndex.has(index)) {
      throw new Error(`段序号 ${match[1]} 重复：${byIndex.get(index)} 与 ${name}`);
    }
    byIndex.set(index, name);
    found.push({ name, index });
  }
  // 补零到两位 ⇒ 字典序与序号恒等（`00` … `23` 按名字排序就是按代码顺序），
  // 所以「顺序」不需要一份手工清单，也不需要在读段时再排一次序号。
  found.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return found;
}

/**
 * 剥离段首声明行（阶段 2 起存在；阶段 1 的段没有它，这里是恒等操作）。
 * @param text - 段文件全文。
 * @returns 不含声明行的段文本。
 */
export function stripDeclaration(text) {
  if (!text.startsWith(SEGMENT_DECLARATION)) return text;
  const rest = text.slice(SEGMENT_DECLARATION.length);
  if (!rest.startsWith('\n')) {
    throw new Error('段首声明行必须独占一行（声明之后要紧跟换行）');
  }
  return rest.slice(1);
}

/**
 * 按顺序拼接段：**不插任何分隔符**，也不做 trim / 归一化 / 空行处理。
 *
 * 每个段文件是「自己的那些行 + 末尾一个 `\n`」，所以逐段原样相加 == 原文件。
 * @param segments - {@link readSegments} 的返回值。
 * @returns 拼接后的全文（尚未重算清单块）。
 */
export function concatSegments(segments) {
  return segments.map((segment) => stripDeclaration(segment.text)).join('');
}

/**
 * 按 `src/` 的文件名字典序读段。
 *
 * `segmentDir` 相对 `packageDir`；`io.readDir` / `io.read` 可注入（测试用），缺省读盘。
 * @param packageDir - 包根目录。
 * @param io - 可选的读取环境。
 * @returns `[{name, index, text, lines, declares}]`。
 *   `lines` 是**该段在 `client.js` 中占的行数**（按 `\n` 计，末尾换行不算一行），
 *   也就是**去掉段首声明行之后**的行数 —— 声明行是元信息，不是切片的内容，所以它
 *   既不计入行数预算（方案 §5.1 表里 `13-page-a.js` 是 1200 行，段文件本身 1201 行），
 *   也不进入产物。这样 `lines` 与 §1.3/§5.1 两张表的「行数」列始终可直接对账。
 */
export function readSegments(packageDir = PACKAGE_DIR, io = {}) {
  const readDir = io.readDir ?? ((relPath) => readdirSync(join(packageDir, relPath)));
  const read = io.read ?? ((relPath) => readFileSync(join(packageDir, relPath), 'utf8'));
  let entries = null;
  try {
    entries = readDir(CLIENT_SRC_DIR);
  } catch {
    entries = null;
  }
  if (entries === null) {
    throw new Error(`读不到 ${CLIENT_SRC_DIR}/ 目录：客户端真源段不存在`);
  }
  const names = segmentNames(entries);
  if (names.length === 0) {
    throw new Error(`${CLIENT_SRC_DIR}/ 里没有任何段文件（真源缺失）`);
  }
  const segments = names.map(({ name, index }) => {
    const text = read(`${CLIENT_SRC_DIR}/${name}`);
    if (typeof text !== 'string') {
      throw new Error(`读不到段文件 ${CLIENT_SRC_DIR}/${name}`);
    }
    const declares = text.startsWith(SEGMENT_DECLARATION);
    // 声明若不独占一行，`stripDeclaration` 当场抛错 —— 这正是我们要的 fail-closed。
    const body = stripDeclaration(text);
    return { name, index, text, body, lines: body.split('\n').length - 1, declares };
  });
  // 「全有或全无」：阶段 1 一个声明都没有，阶段 2 每个段都有。半数是拼接出错的先兆。
  const declared = segments.filter((segment) => segment.declares).length;
  if (declared !== 0 && declared !== segments.length) {
    throw new Error(`${CLIENT_SRC_DIR}/ 的段首声明不一致：${declared}/${segments.length} 个段带声明（要求全有或全无）`);
  }
  return segments;
}

/**
 * 剥离生成物头注（{@link GENERATED_BANNER}）。头注是纯前缀，所以这是它的精确逆。
 *
 * 阶段 2 的核心判据就写在这上面：`stripBanner(renderClient()) === 阶段 1 的产物`，
 * 逐字节。这条同时证明「段重排只换切点、不移动任何代码」（方案 §5.2 阶段 2 判据 2）。
 * @param text - 生成物全文（或任意文本）。
 * @returns 去掉头注后的文本；没有头注时原样返回。
 */
export function stripBanner(text) {
  if (!text.startsWith(GENERATED_BANNER)) return text;
  return text.slice(GENERATED_BANNER.length);
}

/**
 * 渲染 `client.js`：头注 + 拼接段 + 按磁盘重算 `CHUNK_STAMPS` 块。
 *
 * 顺序是**先头注、后段**：头注必须落在 fingerprint `begin` 标记之前，而 `begin`
 * 在 `00-entry.js` 里（段拼接结果内部），所以只有把头注放在整个产物最前面才成立。
 * @param options - `packageDir` / `readDir` / `read` / `chunkStamps` 可注入。
 * @returns 生成物全文。
 */
export function renderClient(options = {}) {
  const packageDir = options.packageDir ?? PACKAGE_DIR;
  const segments = readSegments(packageDir, { readDir: options.readDir, read: options.read });
  const stamps = (options.chunkStamps ?? clientChunkStamps)(packageDir);
  return GENERATED_BANNER + writeDeclaredStamps(concatSegments(segments), stamps);
}

/**
 * 第 6 类发布门禁（g-075 阶段 1）：`src/` 段真源的三态检查。
 *
 * 为什么放在**发布门**上：`client.js` 从此是生成物，人只改 `src/`。段真源若没随包
 * 发布，「装到用户机器上的包」就只剩一份无法再生成、无法 diff 的产物 —— 与
 * `locale/*.json` 完全同理（`scripts/prepare.mjs` 的 `LOCALE-*` 三态）。
 *
 * 三态（照搬 `inspectLocale` 的语义，§5.2 R1-3）：
 *   - **N/A**：既没有 `src/` 目录、`files` 也没声明 ⇒ **通过**（合法的无源包，
 *     例如 `test/prepare.test.mjs` 的最小 fixture）；
 *   - **FILES**：`src/` 存在或已声明，却没有可用的段文件 ⇒ FAIL；
 *   - **NOT-SHIPPED**：段文件在，却不在 `files` 白名单里 ⇒ FAIL（安装时会被裁掉）。
 *   - **DRIFT**（g-077，{@link inspectClientDrift}）：段文件在、也发，但**按 `src/` 重建
 *     出来的字节与磁盘上的 `client.js` 不一致** ⇒ FAIL。这是本门禁找「段集合不完整」的
 *     唯一锚：g-076 曾用一份**手工段名常量**与段名对账，但**「段集合
 *     应该是什么」无法从 `src/` 自身派生** —— 删掉一个段再 `--write`，任何从目录派生的
 *     清单都会跟着少一段、两边照样「一致」（实测见 NOTES.md）。唯一不依赖手工清单的锚
 *     是**产物**：`renderClient()` 与磁盘 `client.js` 逐字节比对，于是缺段、多出陌生段、
 *     以及**段内漂移**（改了 `src/` 一行却忘了 `--write`）会一并暴露。
 * 段文件都在、都声明了、重建结果与产物逐字节相同 ⇒ `CLIENT-SRC`（ok）。
 *
 * 注意：DRIFT 比的是**磁盘上那一份** `client.js`（发布面的字节），所以它同时覆盖
 * 「段集合」与「段内容」两类漂移；`node scripts/client-build.mjs --check` 是同一比对的
 * 命令行入口（CLI 侧消息更详细）。
 * @param filesField - `package.json` 的 `files` 数组。
 * @param io - `{packageDir, listDir, clientSource, render}` 可注入；`listDir(relPath)`
 *   读不到时返回 `null`；`clientSource` 是**已读到的** `client.js` 文本（安装现场复用
 *   `prepare.mjs` 读过的同一份字节，避免重复读盘）；`render` 可注入渲染函数（测试用）。
 * @returns 一条 finding（`PREPARE_OK` 或 `PREPARE_FAIL`）。
 */
export function inspectClientSource(filesField, io = {}) {
  const packageDir = io.packageDir ?? PACKAGE_DIR;
  const listDir = io.listDir ?? ((relPath) => {
    try {
      return readdirSync(join(packageDir, relPath));
    } catch {
      return null;
    }
  });
  const declared = filesCoverPath(filesField, CLIENT_SRC_DIR);
  const entries = listDir(CLIENT_SRC_DIR);
  if (entries === null && !declared) {
    return {
      level: PREPARE_OK,
      code: 'CLIENT-SRC-N/A',
      message: `未使用 ${CLIENT_SRC_DIR}/ 段真源（无目录、files 也未声明），跳过`,
    };
  }
  let segments;
  try {
    segments = segmentNames(entries ?? []);
  } catch (error) {
    return { level: PREPARE_FAIL, code: 'CLIENT-SRC-FILES', message: `${CLIENT_SRC_DIR}/ 的段文件不可用：${reason(error)}` };
  }
  if (segments.length === 0) {
    return {
      level: PREPARE_FAIL,
      code: 'CLIENT-SRC-FILES',
      message: `${CLIENT_SRC_DIR}/ 里没有段文件：client.js 的真源缺失（装上去只剩生成物）`,
    };
  }
  if (!declared) {
    return {
      level: PREPARE_FAIL,
      code: 'CLIENT-SRC-NOT-SHIPPED',
      message: `${CLIENT_SRC_DIR}/ 不在 files 白名单里：安装时会被裁掉，包里只剩生成物 client.js`,
    };
  }
  // g-077：段集合完整性不再对账任何手工段名清单 —— 改由「段 ↔ 磁盘产物逐字节一致」
  // 保证（{@link inspectClientDrift}）。手工清单发现不了「段被删」：删段后跑
  // `--write`，从目录派生的清单会跟着少一段、两边照样一致；而磁盘产物是有意的
  // 发布面字节，缺段/多段/段内漂移都会让它对不上。
  const drift = inspectClientDrift({
    packageDir,
    clientSource: io.clientSource,
    render: io.render,
  });
  if (drift.level !== PREPARE_OK) return drift;
  return {
    level: PREPARE_OK,
    code: 'CLIENT-SRC',
    message: `${CLIENT_SRC_DIR}/ 下 ${segments.length} 个段文件与 client.js 逐字节一致`
      + `（重建后用 node scripts/client-build.mjs --write 可再同步），files 白名单已覆盖`,
  };
}

/**
 * 第 7 类发布门禁（g-077）：**段 ↔ 产物逐字节一致性** —— 段集合完整性的唯一锚。
 *
 * 为什么不能靠「清单」：`prepare` 要发现「段被删了一个」，就得知道**应该有哪些段**。
 * 这份信息无法从 `src/` 自身派生 —— 删掉 `src/12-update.js` 再跑
 * `node scripts/client-build.mjs --write`，任何从目录派生的清单都会跟着少一段，两边
 * 照样「一致」（g-076 项 7 的实测结论，也是本目标换掉手工常量的立论）。g-076 后来
 * 换成了一份**手工段名常量**，代价是重切/合并段要同步 4 处；g-077 把它删掉、改用下面
 * 的产物锚。
 *
 * 不依赖手工清单的锚只有一个：**磁盘上的 `client.js`**（发布面的字节）。用
 * {@link renderClient} 按 `src/` 重算，与它逐字节比对：
 *   - **缺段** ⇒ 重建结果短了一整个区间 ⇒ FAIL；
 *   - **多出陌生段** ⇒ 重建结果多了不存在的字节 ⇒ FAIL；
 *   - **段内改了一行** ⇒ 正是这个门相对「集合对账」多出来的收益 ⇒ FAIL；
 *   - 一致 ⇒ 段真源与产物同一份代码，段集合完整性由产物锚定，不需要任何清单。
 *
 * 失败的指引落在**随包发布**的东西上（`scripts/client-build.mjs` 本身；`docs/` 不在
 * `files` 白名单里、安装现场读不到），并给出**首个差异位置**（行号 + 两侧内容），
 * 因为「哪一侧才是真源」需要人来判断：产物才是有意的那一份就 `--write`，段才是就改
 * `src/` 直到 `--check` 绿。
 *
 * 纯函数、只读：不写任何文件。`prepare` 把已读到的 `client.js` 文本经 `clientSource`
 * 传进来，所以安装现场**不会重复读**这 ~612 KB（`inspectClientChunks` 已读过一次）。
 * @param options - `{packageDir, clientSource, render}` 可注入。
 *   `clientSource` 省略时自行读 `client.js`（读不到 ⇒ FAIL，fail-closed）。
 * @returns 一条 finding（`PREPARE_OK` 或 `PREPARE_FAIL`）。
 */
export function inspectClientDrift(options = {}) {
  const packageDir = options.packageDir ?? PACKAGE_DIR;
  let current = options.clientSource;
  if (current === undefined) {
    try {
      current = readFileSync(join(packageDir, 'client.js'), 'utf8');
    } catch {
      current = null;
    }
  }
  if (typeof current !== 'string') {
    return {
      level: PREPARE_FAIL,
      code: 'CLIENT-SRC-DRIFT',
      message: `读不到 client.js：无法核对 ${CLIENT_SRC_DIR}/ 段与发布产物是否逐字节一致`,
    };
  }
  let generated;
  try {
    generated = (options.render ?? renderClient)({ packageDir });
  } catch (error) {
    return {
      level: PREPARE_FAIL,
      code: 'CLIENT-SRC-DRIFT',
      message: `无法按 ${CLIENT_SRC_DIR}/ 重建 client.js：${reason(error)}`
        + `（先跑 node scripts/client-build.mjs --check 看细节）`,
    };
  }
  const currentLines = current.split('\n').length;
  const generatedLines = generated.split('\n').length;
  if (generated === current) {
    return {
      level: PREPARE_OK,
      code: 'CLIENT-SRC-DRIFT',
      message: `${CLIENT_SRC_DIR}/ 段与 client.js 逐字节一致（${generatedLines} 行）`,
    };
  }
  const difference = firstDifference(generated, current);
  const where = difference === null
    ? `首处差异无法按行定位（两侧同为 ${generatedLines} 行，但字节不同）`
    : `首处差异在第 ${difference.line} 行：src/ 生成 ${JSON.stringify(preview(difference.generated))}`
      + ` vs client.js ${JSON.stringify(preview(difference.current))}`;
  return {
    level: PREPARE_FAIL,
    code: 'CLIENT-SRC-DRIFT',
    message: `${CLIENT_SRC_DIR}/ 与 client.js 逐字节不一致（${where}；`
      + `src/ 重建 ${generatedLines} 行 vs 产物 ${currentLines} 行）。段集合完整性由此锚定`
      + `（段被删、多出陌生段、段内改了行都会在这里暴露，不再依赖任何手工段名清单）：`
      + `若产物才是发布面那一份，跑 node scripts/client-build.mjs --write 按 ${CLIENT_SRC_DIR}/ 重建；`
      + `若段才是真源（例如误删了段），把段恢复到与产物一致再跑 node scripts/client-build.mjs --check`,
  };
}

/** 找两份文本的第一处差异（行号 + 两侧内容），给 `--check` 的失败一个可执行的提示。 */
export function firstDifference(generated, current) {
  const left = generated.split('\n');
  const right = current.split('\n');
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    if (left[index] !== right[index]) {
      return { line: index + 1, generated: left[index] ?? '(缺行)', current: right[index] ?? '(缺行)' };
    }
  }
  return null;
}

/** 一行差异预览。 */
function preview(text) {
  const trimmed = text.trim();
  return trimmed.length > 96 ? `${trimmed.slice(0, 96)}…` : trimmed;
}

/** CLI 主流程：校验（无参 / `--check`）或 `--write`。 */
function main(argv) {
  const write = argv.includes('--write');
  const unknown = argv.filter((flag) => flag !== '--write' && flag !== '--check');
  if (unknown.length > 0) {
    process.stderr.write(`client build: 未知参数 ${unknown.join(' ')}（只认 --write / --check）\n`);
    return 2;
  }
  let segments;
  let generated;
  let stamps;
  let declared;
  try {
    segments = readSegments();
    const concatenated = concatSegments(segments);
    stamps = clientChunkStamps(PACKAGE_DIR);
    declared = readDeclaredStamps(concatenated);
    generated = GENERATED_BANNER + writeDeclaredStamps(concatenated, stamps);
  } catch (error) {
    process.stderr.write(`client build: ${reason(error)}\n`);
    return 1;
  }
  const manifest = sameStamps(declared, stamps)
    ? `CHUNK_STAMPS ${stamps.length} 项与磁盘一致`
    : `CHUNK_STAMPS 段内声明 ${declared.length} 项 → 按磁盘重算为 ${stamps.length} 项`;
  const current = readFileSync(CLIENT_PATH, 'utf8');
  if (generated === current) {
    process.stdout.write(`client build: ${segments.length} 个段与 client.js 逐字节一致（${manifest}；未落盘）\n`);
    return 0;
  }
  if (!write) {
    const difference = firstDifference(generated, current);
    process.stderr.write(
      `client build: src/ 与 client.js 不一致（首处差异在第 ${difference === null ? '?' : difference.line} 行）\n`
        + `  src/ 生成: ${difference === null ? '(无法定位)' : preview(difference.generated)}\n`
        + `  client.js : ${difference === null ? '(无法定位)' : preview(difference.current)}\n`
        + `  run: node scripts/client-build.mjs --write\n`,
    );
    return 1;
  }
  writeFileSync(CLIENT_PATH, generated);
  process.stdout.write(`client build: client.js 已按 ${segments.length} 个段重建（${manifest}）\n`);
  return 0;
}

// 只有作为脚本运行时才执行：测试会 import 上面的纯函数与门禁。
//
// g-076 项 1（symlink 假绿）：`process.argv[1]` 是**调用时的字面路径**，而
// `import.meta.url` 已被 Node 解析成真实路径。经软链调用（`npm link`、pnpm
// workspace、`node_modules/<pkg>`、`.bin`）时两者永不相等 ⇒ 守卫整段被跳过、
// **静默 exit 0** —— 连 `--bogus` 的参数校验都不跑，在自动化里等于假绿。
// 统一改成 realpath 比较；`argv[1]` 可能不存在或无法解析，所以包在 try/catch 里
// （拿不到真实路径就不当成直接运行，fail-closed）。同款守卫、同款理由见
// `scripts/client-chunks.mjs` 与 `scripts/locale-pack.mjs`（三处必须一起改，不许分裂）。
const isDirectRun = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  process.exitCode = main(process.argv.slice(2));
}

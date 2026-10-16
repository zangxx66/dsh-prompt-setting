#!/usr/bin/env node
/**
 * `dsh-prompt-setting` 的客户端生成器（g-075 阶段 1）。
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
 * 阶段 1 **不写任何头注**：加头注就是改字节，与「逐字节等价」互斥（R1-1）。阶段 2
 * 起每个段文件首行会带一行「片段，不是独立模块」声明，由 {@link stripDeclaration}
 * 在拼接前逐段剥离（本阶段没有声明，剥离是恒等操作，`--check` 仍要求「全有或全无」）。
 *
 * 用法：
 *   node scripts/client-build.mjs           # 校验（等价于 --check）
 *   node scripts/client-build.mjs --check   # 只读校验；不一致 ⇒ 非零退出码
 *   node scripts/client-build.mjs --write   # 按 src/ 重建 client.js（内容相同则不动文件）
 *
 * **行锚点纪律（阶段 1）**：`docs/check-refs.mjs` 把本包若干文件的**行号**当断言
 * （`package.json:22-33`、`scripts/prepare.mjs:180-183`、`test/host.test.mjs:171-197`
 * 等）。因此阶段 1 对既有文件的改动都是**行数中性**的（新增内容与既有行同排，或占用
 * 原本的空行）；本文件与 `src/` 是新增文件，不在此限。
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
 * @returns `[{name, index, text, lines}]`（`lines` 按 `\n` 计，末尾换行不算一行）。
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
    return { name, index, text, lines: text.split('\n').length - 1, declares: text.startsWith(SEGMENT_DECLARATION) };
  });
  // 「全有或全无」：阶段 1 一个声明都没有，阶段 2 每个段都有。半数是拼接出错的先兆。
  const declared = segments.filter((segment) => segment.declares).length;
  if (declared !== 0 && declared !== segments.length) {
    throw new Error(`${CLIENT_SRC_DIR}/ 的段首声明不一致：${declared}/${segments.length} 个段带声明（要求全有或全无）`);
  }
  return segments;
}

/**
 * 渲染 `client.js`：拼接段 + 按磁盘重算 `CHUNK_STAMPS` 块。
 * @param options - `packageDir` / `readDir` / `read` / `chunkStamps` 可注入。
 * @returns 生成物全文。
 */
export function renderClient(options = {}) {
  const packageDir = options.packageDir ?? PACKAGE_DIR;
  const segments = readSegments(packageDir, { readDir: options.readDir, read: options.read });
  const stamps = (options.chunkStamps ?? clientChunkStamps)(packageDir);
  return writeDeclaredStamps(concatSegments(segments), stamps);
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
 * 段文件都在且都声明了 ⇒ `CLIENT-SRC`（ok）。
 *
 * 注意本门禁只看**发布面**（有没有、发不发）；「生成物与段是否一致」由
 * `node scripts/client-build.mjs --check` 负责（阶段 1 的判据 1 / 5）。
 * @param filesField - `package.json` 的 `files` 数组。
 * @param io - `{packageDir, listDir}` 可注入；`listDir(relPath)` 读不到时返回 `null`。
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
  return {
    level: PREPARE_OK,
    code: 'CLIENT-SRC',
    message: `${CLIENT_SRC_DIR}/ 下 ${segments.length} 个段文件，files 白名单已覆盖`,
  };
}

/** 找两份文本的第一处差异（行号 + 两侧内容），给 `--check` 的失败一个可执行的提示。 */
function firstDifference(generated, current) {
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
    generated = writeDeclaredStamps(concatenated, stamps);
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
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}

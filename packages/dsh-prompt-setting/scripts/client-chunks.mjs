#!/usr/bin/env node
/**
 * `dsh-prompt-setting` 的 chunk 清单工具（g-045）。
 *
 * 为什么需要它：`client.js` 拆成「主入口 + 包内 chunk」之后，主 factory 的
 * `toString()` 看不到 chunk 的字节（`CONTRACT.md` §14）。于是主文件里带一份
 * **内嵌清单** `CHUNK_STAMPS`，它在指纹区间内 ⇒ 属于主戳；宿主在 ping 里报出
 * 每个 chunk 文件的真实摘要（`clientBuild.chunks`），页面逐项比对。任何一边漏
 * 掉同步，页面就会把「改了 chunk 而清单没动」读成不一致 —— 方向安全，但清单若
 * 长期漂移就没人看得懂自己在比对什么。
 *
 * 这个脚本把清单与磁盘对齐：`--write` 就地重算并写回 `client.js` 的清单块，
 * 不带参数则只**校验**（不一致 ⇒ 非零退出码）。它是开发期工具，不是构建步骤：
 * chunk 与主文件本身就是发布物，脚本只更新主文件里那一份清单。
 *
 * 用法：
 *   node scripts/client-chunks.mjs          # 校验（适合 CI / 发布前）
 *   node scripts/client-chunks.mjs --write  # 重算清单并写回承载块的那一段 src/ 与 client.js
 */

import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clientChunkStamps, CLIENT_CHUNK_PATTERN } from '../core/store.js';

/** 包根目录（本文件在 `scripts/` 下）。 */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** 主 bundle 路径 —— 清单就写在它里面。 */
const CLIENT_PATH = join(PACKAGE_DIR, 'client.js');
/** 段目录（g-075 阶段 2 起清单块的真源在 src/ 的某一段里）。 */
const CLIENT_SRC_DIR = 'src';
/** 清单块的开头行（缩进/措辞改动会让本脚本拒绝动手，而不是猜）。 */
const BLOCK_OPEN = '    const CHUNK_STAMPS = Object.freeze([';
/** 清单块的结束行。 */
const BLOCK_CLOSE = '    ]);';

/**
 * 把一份摘要清单渲染成清单块的正文行。
 * @param stamps - `[{name, hash, size}]`，已按文件名校验过。
 * @returns 行数组（不含首尾的空行）。
 */
export function renderStampRows(stamps) {
  return stamps
    .map((stamp) => `      { name: '${stamp.name}', hash: '${stamp.hash}', size: ${stamp.size} },`)
    .join('\n');
}

/**
 * 从 `client.js` 的文本里取出当前声明的清单项。
 * @param source - `client.js` 的全文。
 * @returns `[{name, hash, size}]`（无法定位清单块时抛错，绝不猜）。
 */
export function readDeclaredStamps(source) {
  const lines = source.split('\n');
  const open = lines.indexOf(BLOCK_OPEN);
  if (open === -1) throw new Error(`client.js carries no \`CHUNK_STAMPS\` block (looked for: ${BLOCK_OPEN})`);
  const close = lines.indexOf(BLOCK_CLOSE, open + 1);
  if (close === -1) throw new Error('the `CHUNK_STAMPS` block is not closed');
  const stamps = [];
  for (let index = open + 1; index < close; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0 || line.startsWith('//')) continue;
    const match = line.match(/^\{ name: '([^']+)', hash: '([^']+)', size: (\d+) \},$/);
    if (match === null) throw new Error(`unreadable CHUNK_STAMPS row: ${line}`);
    stamps.push({ name: match[1], hash: match[2], size: Number(match[3]) });
  }
  return stamps;
}

/**
 * 用一份新清单替换 `client.js` 里的清单块。
 * @param source - `client.js` 的全文。
 * @param stamps - 新清单。
 * @returns 新的全文。
 */
export function writeDeclaredStamps(source, stamps) {
  const lines = source.split('\n');
  const open = lines.indexOf(BLOCK_OPEN);
  if (open === -1) throw new Error(`client.js carries no \`CHUNK_STAMPS\` block (looked for: ${BLOCK_OPEN})`);
  const close = lines.indexOf(BLOCK_CLOSE, open + 1);
  if (close === -1) throw new Error('the `CHUNK_STAMPS` block is not closed');
  const next = [...lines.slice(0, open + 1), ...renderStampRows(stamps).split('\n'), ...lines.slice(close)];
  return next.join('\n');
}

/**
 * 两份清单是否逐项一致（顺序、名称、摘要、长度）。
 * @param left - 一份清单。
 * @param right - 另一份清单。
 * @returns `true` 当且仅当两者完全一致。
 */
export function sameStamps(left, right) {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return entry.name === other.name && entry.hash === other.hash && entry.size === other.size;
  });
}

/**
 * 清单块所在的 `src/` 段（阶段 2：`client.js` 是生成物，真源在段里）。
 *
 * 只有一个段能带这个块；找不到或不唯一时返回 `null` —— 本脚本只改它**读到**的
 * 那一处，绝不猜一个「应该在哪」的位置。
 * @param packageDir - 包根目录。
 * @returns 段的相对路径，或 `null`。
 */
function stampSegmentPath(packageDir) {
  let entries;
  try {
    entries = readdirSync(join(packageDir, CLIENT_SRC_DIR));
  } catch {
    return null;
  }
  const hits = [];
  for (const entry of entries.filter((name) => name.endsWith('.js')).sort()) {
    const relPath = `${CLIENT_SRC_DIR}/${entry}`;
    try {
      if (readFileSync(join(packageDir, relPath), 'utf8').includes(BLOCK_OPEN)) hits.push(relPath);
    } catch {
      // An unreadable segment is simply not the one; the build's own check owns that failure.
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

/** CLI 主流程：校验，或按 `--write` 写回。 */
function main(argv) {
  const write = argv.includes('--write');
  const source = readFileSync(CLIENT_PATH, 'utf8');
  const declared = readDeclaredStamps(source);
  const actual = clientChunkStamps(PACKAGE_DIR);
  // Stage 2 adds a second copy of the block: the `src/` segment it is generated
  // from. Both must be in sync — checking only `client.js` would call a split
  // state "ok", and the next `client-build --write` would then rebuild the
  // artifact from the stale segment and move it again.
  const segmentPath = stampSegmentPath(PACKAGE_DIR);
  const segment = segmentPath === null ? null : readFileSync(join(PACKAGE_DIR, segmentPath), 'utf8');
  const segmentDeclared = segment === null ? null : readDeclaredStamps(segment);
  const clientInSync = sameStamps(declared, actual);
  const segmentInSync = segmentDeclared === null || sameStamps(segmentDeclared, actual);
  if (clientInSync && segmentInSync) {
    process.stdout.write(`client chunks: ${actual.length} file(s) match the CHUNK_STAMPS manifest\n`);
    return 0;
  }
  if (!write) {
    process.stderr.write(
      'client chunks: the CHUNK_STAMPS manifest is out of date.\n' +
        `  client.js: ${declared.map((s) => `${s.name}@${s.hash}`).join(', ') || '(none)'}\n` +
        (segmentDeclared === null
          ? ''
          : `  src/${segmentPath}: ${segmentDeclared.map((s) => `${s.name}@${s.hash}`).join(', ') || '(none)'}\n`) +
        `  on disk  : ${actual.map((s) => `${s.name}@${s.hash}`).join(', ') || '(none)'}\n` +
        '  run: node scripts/client-chunks.mjs --write\n',
    );
    return 1;
  }
  // Two copies of the same block exist on disk and both must move together:
  // the **segment** is the truth (stage 2 made `client.js` its concatenation),
  // and `client.js` is the shipped artifact a page may already be loading. A
  // script that updated only one of them would leave `client-source`'s
  // byte-equality assertion to discover the split, which is exactly what the
  // `--write` remedy exists to prevent.
  if (segment !== null) {
    const nextSegment = writeDeclaredStamps(segment, actual);
    if (nextSegment !== segment) writeFileSync(join(PACKAGE_DIR, segmentPath), nextSegment);
  }
  writeFileSync(CLIENT_PATH, writeDeclaredStamps(source, actual));
  process.stdout.write(`client chunks: CHUNK_STAMPS updated (${actual.length} file(s))\n`);
  return 0;
}

// 只有作为脚本运行时才执行：测试会 import 上面的纯函数。
//
// g-076 项 1（symlink 假绿）：`process.argv[1]` 是**调用时的字面路径**，而
// `import.meta.url` 已被 Node 解析成真实路径。经软链调用（`npm link`、pnpm
// workspace、`node_modules/<pkg>`、`.bin`）时两者永不相等 ⇒ 守卫整段被跳过、
// **静默 exit 0** —— 连 `--bogus` 的参数校验都不跑，在自动化里等于假绿。
// 统一改成 realpath 比较；`argv[1]` 可能不存在或无法解析，所以包在 try/catch 里
// （拿不到真实路径就不当成直接运行，fail-closed）。同款守卫、同款理由见
// `scripts/client-build.mjs` 与 `scripts/locale-pack.mjs`（三处必须一起改，不许分裂）。
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

export { CLIENT_CHUNK_PATTERN };

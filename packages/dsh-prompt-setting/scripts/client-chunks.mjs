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
 *   node scripts/client-chunks.mjs --write  # 重算清单并写回 client.js
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clientChunkStamps, CLIENT_CHUNK_PATTERN } from '../core/store.js';

/** 包根目录（本文件在 `scripts/` 下）。 */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** 主 bundle 路径 —— 清单就写在它里面。 */
const CLIENT_PATH = join(PACKAGE_DIR, 'client.js');
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

/** CLI 主流程：校验，或按 `--write` 写回。 */
function main(argv) {
  const write = argv.includes('--write');
  const source = readFileSync(CLIENT_PATH, 'utf8');
  const declared = readDeclaredStamps(source);
  const actual = clientChunkStamps(PACKAGE_DIR);
  if (sameStamps(declared, actual)) {
    process.stdout.write(`client chunks: ${actual.length} file(s) match the CHUNK_STAMPS manifest\n`);
    return 0;
  }
  if (!write) {
    process.stderr.write(
      `client chunks: the CHUNK_STAMPS manifest in client.js is out of date.\n` +
        `  declared: ${declared.map((s) => `${s.name}@${s.hash}`).join(', ') || '(none)'}\n` +
        `  on disk : ${actual.map((s) => `${s.name}@${s.hash}`).join(', ') || '(none)'}\n` +
        `  run: node scripts/client-chunks.mjs --write\n`,
    );
    return 1;
  }
  writeFileSync(CLIENT_PATH, writeDeclaredStamps(source, actual));
  process.stdout.write(`client chunks: CHUNK_STAMPS updated (${actual.length} file(s))\n`);
  return 0;
}

// 只有作为脚本运行时才执行：测试会 import 上面的纯函数。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}

export { CLIENT_CHUNK_PATTERN };

#!/usr/bin/env node
/**
 * `docs/refactor-plan.md` 的**引用体检**（g-072 评审 R3-R5）。
 *
 * 为什么需要它：方案文档里手写了上百条 `文件:行` 引用，靠人眼维护必然漂移。
 * 三轮评审已经在这个问题上来回命中（R1-5、R2-D1、R3-R1 都是同一类）。与其修一个个案，
 * 不如给文档装一次"体检"：**能自动判的逐条断言，判不了的如实列进人工清单**。
 *
 * 本脚本**只读**：不写任何文件、不改产品代码。它放在 `docs/` 下，而 `package.json`
 * 的 `files` 白名单不含 `docs`，所以它不会随包发布。
 *
 * 用法（在 `packages/dsh-prompt-setting/` 下）：
 *   node docs/check-refs.mjs          # 体检；有不符 ⇒ 非零退出码
 *
 * 输出三类：
 *   ok    —— 期望表里的引用，行内容与文档声称的符号一致；
 *   FAIL  —— 期望表里的引用，行内容对不上（退出码 1）；
 *   manual—— 文档里出现、但本脚本无法自动判定的引用（外部 loader、行号省略等），
 *            逐条列出供人工核对；**它们不影响退出码**。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `docs/` 目录（本文件所在）。 */
const DOCS_DIR = dirname(fileURLToPath(import.meta.url));
/** 包根目录。 */
const PACKAGE_DIR = dirname(DOCS_DIR);
/** 被体检的文档。 */
const DOC_PATH = join(DOCS_DIR, 'refactor-plan.md');

/**
 * 期望表：文档中声称「`file:line` 处就是 `expect`」的引用。
 *
 * `from` 与 `to` 都是 1 基行号；`to` 缺省表示单行引用。`expect` 用 `includes`
 * 判定；`stripEquals` 用于「该行去掉缩进后恰好等于某串」这类断言（例如闭括号）。
 * `at`（缺省 `from`）用于「区间以 JSDoc/注释开头、被断言的符号在区间中段」的引用。
 * @type {{ref: string, file: string, from: number, to?: number, at?: number, expect?: string, stripEquals?: string}[]}
 */
const REFS = [
  // ── client.js ────────────────────────────────────────────────────────────
  { ref: 'client.js:107', file: 'client.js', from: 107, expect: '__ModuleLoader__.load({' },
  { ref: 'client.js:114', file: 'client.js', from: 114, expect: 'factory: function promptSettingFactory(require) {' },
  { ref: 'client.js:115', file: 'client.js', from: 115, expect: '@build-fingerprint:begin' },
  { ref: 'client.js:182', file: 'client.js', from: 182, expect: 'SELF_BUILD = fingerprintOf(promptSettingFactory.toString())' },
  { ref: 'client.js:213', file: 'client.js', from: 213, expect: "const React = require('react');" },
  { ref: 'client.js:903-2047', file: 'client.js', from: 903, to: 2047, expect: '#region generated: locale' },
  { ref: 'client.js:2116', file: 'client.js', from: 2116, expect: '#region fallback atoms' },
  { ref: 'client.js:2650', file: 'client.js', from: 2650, expect: '#region pure helpers' },
  { ref: 'client.js:3340', file: 'client.js', from: 3340, expect: 'function chunkStampMap' },
  { ref: 'client.js:3378', file: 'client.js', from: 3378, expect: 'function buildVerdict' },
  { ref: 'client.js:7224', file: 'client.js', from: 7224, expect: 'function renderMinePanel' },
  { ref: 'client.js:7224-7770', file: 'client.js', from: 7224, to: 7770, expect: 'function renderMinePanel' },
  { ref: 'client.js:7770', file: 'client.js', from: 7770, stripEquals: '}' },
  { ref: 'client.js:7789', file: 'client.js', from: 7789, expect: 'const CHUNK_STAMPS = Object.freeze([' },
  { ref: 'client.js:7806', file: 'client.js', from: 7806, expect: 'const CHUNK_FACILITIES = Object.freeze({' },
  { ref: 'client.js:7806-7895', file: 'client.js', from: 7806, to: 7895, expect: 'const CHUNK_FACILITIES = Object.freeze({' },
  { ref: 'client.js:7895', file: 'client.js', from: 7895, stripEquals: '});' },
  { ref: 'client.js:7979', file: 'client.js', from: 7979, expect: 'function loadChunk' },
  { ref: 'client.js:7990', file: 'client.js', from: 7990, expect: 'function recordLoadedChunk' },
  { ref: 'client.js:8084', file: 'client.js', from: 8084, expect: 'function chunkModule' },
  { ref: 'client.js:8124', file: 'client.js', from: 8124, expect: 'client.history.js' },
  { ref: 'client.js:8160-8188', file: 'client.js', from: 8160, to: 8188, expect: 'HistoryTabChunk' },
  { ref: 'client.js:8164-8169', file: 'client.js', from: 8164, to: 8169, expect: 'deliberately' },
  { ref: 'client.js:8209', file: 'client.js', from: 8209, expect: 'function chunkTab' },
  { ref: 'client.js:8844', file: 'client.js', from: 8844, expect: 'data-build-loaded' },
  { ref: 'client.js:8884', file: 'client.js', from: 8884, expect: 'function PromptSettingSection' },
  { ref: 'client.js:8884-11523', file: 'client.js', from: 8884, to: 11523, expect: 'function PromptSettingSection' },
  { ref: 'client.js:8893', file: 'client.js', from: 8893, expect: 'React.useSyncExternalStore(' },
  { ref: 'client.js:11523', file: 'client.js', from: 11523, stripEquals: '}' },
  { ref: 'client.js:11536', file: 'client.js', from: 11536, expect: 'function renderFailureCard' },
  { ref: 'client.js:11639', file: 'client.js', from: 11639, expect: 'return {' },
  { ref: 'client.js:11640', file: 'client.js', from: 11640, expect: "inject: ['slots', 'locale']," },
  { ref: 'client.js:11648', file: 'client.js', from: 11648, expect: '__internals' },
  { ref: 'client.js:11651', file: 'client.js', from: 11651, expect: 'shared: CHUNK_FACILITIES' },
  { ref: 'client.js:11685', file: 'client.js', from: 11685, expect: 'apply(ctx)' },
  { ref: 'client.js:11808', file: 'client.js', from: 11808, expect: 'function degradedPlugin' },
  // ── index.js ─────────────────────────────────────────────────────────────
  { ref: 'index.js:226', file: 'index.js', from: 226, expect: 'CLIENT_BUNDLE_PATH' },
  { ref: 'index.js:778', file: 'index.js', from: 778, expect: 'export function apply' },
  { ref: 'index.js:983', file: 'index.js', from: 983, expect: 'function mount' },
  { ref: 'index.js:4363', file: 'index.js', from: 4363, expect: 'clientBuild: clientBuildInfo' },
  { ref: 'index.js:4612', file: 'index.js', from: 4612, stripEquals: '}' },
  { ref: 'index.js:4615', file: 'index.js', from: 4615, expect: 'export { ACTIONS' },
  // ── core/ ────────────────────────────────────────────────────────────────
  { ref: 'core/build.js:35', file: 'core/build.js', from: 35, expect: 'FINGERPRINT_BEGIN' },
  { ref: 'core/build.js:37', file: 'core/build.js', from: 37, expect: 'FINGERPRINT_END' },
  { ref: 'core/build.js:52', file: 'core/build.js', from: 52, expect: 'function normalizeBuildText' },
  { ref: 'core/build.js:66', file: 'core/build.js', from: 66, expect: 'function fingerprintRegion' },
  { ref: 'core/build.js:101', file: 'core/build.js', from: 101, expect: 'function fingerprintOf' },
  { ref: 'core/store.js:295', file: 'core/store.js', from: 295, expect: 'function clientBuildInfo' },
  { ref: 'core/store.js:308', file: 'core/store.js', from: 308, expect: 'chunks: clientChunkStamps(' },
  { ref: 'core/store.js:323', file: 'core/store.js', from: 323, expect: 'CLIENT_CHUNK_PATTERN' },
  { ref: 'core/store.js:337', file: 'core/store.js', from: 337, expect: 'function clientChunkStamps' },
  // ── scripts/ ─────────────────────────────────────────────────────────────
  { ref: 'scripts/client-chunks.mjs:32', file: 'scripts/client-chunks.mjs', from: 32, expect: 'BLOCK_OPEN' },
  { ref: 'scripts/client-chunks.mjs:41', file: 'scripts/client-chunks.mjs', from: 41, expect: 'function renderStampRows' },
  { ref: 'scripts/client-chunks.mjs:52', file: 'scripts/client-chunks.mjs', from: 52, expect: 'function readDeclaredStamps' },
  { ref: 'scripts/client-chunks.mjs:75', file: 'scripts/client-chunks.mjs', from: 75, expect: 'function writeDeclaredStamps' },
  { ref: 'scripts/client-chunks.mjs:91', file: 'scripts/client-chunks.mjs', from: 91, expect: 'function sameStamps' },
  { ref: 'scripts/client-chunks.mjs:100', file: 'scripts/client-chunks.mjs', from: 100, expect: 'function main(' },
  { ref: 'scripts/prepare.mjs:9', file: 'scripts/prepare.mjs', from: 9, expect: '零构建包' },
  { ref: 'scripts/prepare.mjs:86', file: 'scripts/prepare.mjs', from: 86, expect: 'function inspectClientChunks' },
  { ref: 'scripts/prepare.mjs:135', file: 'scripts/prepare.mjs', from: 135, expect: 'function inspectLocale' },
  { ref: 'scripts/prepare.mjs:144', file: 'scripts/prepare.mjs', from: 144, expect: 'LOCALE-SYNC-N/A' },
  { ref: 'scripts/prepare.mjs:154', file: 'scripts/prepare.mjs', from: 154, expect: 'LOCALE-NOT-SHIPPED' },
  { ref: 'scripts/prepare.mjs:180', file: 'scripts/prepare.mjs', from: 180, expect: 'findings.push(inspectClientChunks' },
  // ── package.json ─────────────────────────────────────────────────────────
  { ref: 'package.json:15', file: 'package.json', from: 15, expect: '"type": "module"' },
  { ref: 'package.json:19', file: 'package.json', from: 19, expect: '"./client": "./client.js"' },
  // ── test/ ────────────────────────────────────────────────────────────────
  { ref: 'test/build.test.mjs:136', file: 'test/build.test.mjs', from: 136, expect: 'the real client.js region covers' },
  { ref: 'test/build.test.mjs:136-171', file: 'test/build.test.mjs', from: 136, to: 171, expect: 'the real client.js region covers' },
  { ref: 'test/build.test.mjs:171', file: 'test/build.test.mjs', from: 171, expect: 'size > 50000' },
  { ref: 'test/build.test.mjs:174', file: 'test/build.test.mjs', from: 174, expect: 'every chunk carries one marker pair' },
  { ref: 'test/build.test.mjs:174-198', file: 'test/build.test.mjs', from: 174, to: 198, expect: 'every chunk carries one marker pair' },
  { ref: 'test/build.test.mjs:200', file: 'test/build.test.mjs', from: 200, expect: 'CHUNK_STAMPS manifest is exactly' },
  { ref: 'test/client.test.mjs:1988', file: 'test/client.test.mjs', from: 1988, expect: 'flat sibling' },
  { ref: 'test/client.test.mjs:2029-2036', file: 'test/client.test.mjs', from: 2029, to: 2036, expect: 'chunkFailures' },
  { ref: 'test/client.test.mjs:2338', file: 'test/client.test.mjs', from: 2338, expect: 'shared.x' },
  { ref: 'test/client.test.mjs:2338-2360', file: 'test/client.test.mjs', from: 2338, to: 2360, expect: 'shared.x' },
  { ref: 'test/client.test.mjs:2518', file: 'test/client.test.mjs', from: 2518, expect: 'scrimStyle' },
  { ref: 'test/client.test.mjs:2516-2520', file: 'test/client.test.mjs', from: 2516, to: 2520, expect: 'readFileSync' },
  { ref: 'test/boot.test.mjs:56', file: 'test/boot.test.mjs', from: 56, expect: "client.js" },
  { ref: 'test/host.test.mjs:171', file: 'test/host.test.mjs', from: 171, expect: 'packageJson.files' },
  { ref: 'test/host.test.mjs:171-197', file: 'test/host.test.mjs', from: 171, to: 197, expect: 'packageJson.files' },
  { ref: 'test/prepare.test.mjs:440', file: 'test/prepare.test.mjs', from: 440, expect: 'incomplete checkout' },
  { ref: 'test/prepare.test.mjs:440-485', file: 'test/prepare.test.mjs', from: 440, to: 485, expect: 'incomplete checkout' },
  { ref: 'test/prepare.test.mjs:487', file: 'test/prepare.test.mjs', from: 487, expect: 'CHUNK_STAMPS manifest that drifted' },
  { ref: 'test/prepare.test.mjs:487-539', file: 'test/prepare.test.mjs', from: 487, to: 539, expect: 'CHUNK_STAMPS manifest that drifted' },
  // ── 仓库内文档（零构建承诺等）─────────────────────────────────────────────
  { ref: 'README.md:102', file: 'README.md', from: 102, expect: '零构建步骤' },
  { ref: 'NOTES.md:3635', file: 'NOTES.md', from: 3635, expect: '零构建' },
  { ref: 'CONTRACT.md:3855', file: 'CONTRACT.md', from: 3855, expect: '## 14. Client build stamp' },
  { ref: 'CONTRACT.md:6966', file: 'CONTRACT.md', from: 6966, expect: 'no build step' },
  // ── 文档里实际引用的区间（补全，减少人工核对项）──────────────────────────
  { ref: 'client.js:55-61', file: 'client.js', from: 55, to: 61, expect: 'Two hard rules' },
  { ref: 'client.js:62-66', file: 'client.js', from: 62, to: 66, expect: 'Markers the page carries' },
  { ref: 'client.js:67-73', file: 'client.js', from: 67, to: 73, expect: 'Revision 6 adds' },
  { ref: 'client.js:903-911', file: 'client.js', from: 903, to: 911, expect: '#region generated' },
  { ref: 'client.js:3922-3926', file: 'client.js', from: 3922, to: 3926, expect: 'g-061 batch 2' },
  { ref: 'client.js:7789-7795', file: 'client.js', from: 7789, to: 7795, expect: 'const CHUNK_STAMPS' },
  { ref: 'client.js:7797-7805', file: 'client.js', from: 7797, to: 7805, at: 7798, expect: 'cross-chunk facility' },
  { ref: 'client.js:7916-7943', file: 'client.js', from: 7916, to: 7943, expect: 'function subscribeChunkLoads' },
  { ref: 'client.js:7979-7982', file: 'client.js', from: 7979, to: 7982, expect: 'function loadChunk' },
  { ref: 'client.js:7990-8000', file: 'client.js', from: 7990, to: 8000, expect: 'function recordLoadedChunk' },
  { ref: 'client.js:8003', file: 'client.js', from: 8003, expect: 'function loadedChunkStamps' },
  { ref: 'client.js:8024', file: 'client.js', from: 8024, expect: 'function chunkFailureComponent' },
  { ref: 'client.js:8139', file: 'client.js', from: 8139, expect: 'function renderHistoryChunk' },
  { ref: 'client.js:8209-8277', file: 'client.js', from: 8209, to: 8277, expect: 'function chunkTab' },
  { ref: 'client.js:11648-11651', file: 'client.js', from: 11648, to: 11651, expect: '__internals' },
  { ref: 'client.history.js:36', file: 'client.history.js', from: 36, expect: "require('dsh-prompt-setting')" },
  { ref: 'core/store.js:277-293', file: 'core/store.js', from: 277, to: 293, at: 278, expect: 'Read the published client bundle' },
  { ref: 'core/store.js:295-315', file: 'core/store.js', from: 295, to: 315, expect: 'function clientBuildInfo' },
  { ref: 'core/store.js:337-364', file: 'core/store.js', from: 337, to: 364, expect: 'function clientChunkStamps' },
  { ref: 'core/build.js:35-37', file: 'core/build.js', from: 35, to: 37, expect: 'FINGERPRINT_BEGIN' },
  { ref: 'core/build.js:66-78', file: 'core/build.js', from: 66, to: 78, expect: 'function fingerprintRegion' },
  { ref: 'core/build.js:85-95', file: 'core/build.js', from: 85, to: 95, expect: 'function fnv1a32' },
  { ref: 'core/build.js:101-105', file: 'core/build.js', from: 101, to: 105, expect: 'function fingerprintOf' },
  { ref: 'scripts/prepare.mjs:1-30', file: 'scripts/prepare.mjs', from: 1, to: 30, expect: '#!/usr/bin/env node' },
  { ref: 'scripts/prepare.mjs:86-129', file: 'scripts/prepare.mjs', from: 86, to: 129, expect: 'function inspectClientChunks' },
  { ref: 'scripts/prepare.mjs:135-167', file: 'scripts/prepare.mjs', from: 135, to: 167, expect: 'function inspectLocale' },
  { ref: 'scripts/prepare.mjs:139-145', file: 'scripts/prepare.mjs', from: 139, to: 145, at: 144, expect: 'LOCALE-SYNC-N/A' },
  { ref: 'scripts/prepare.mjs:150-157', file: 'scripts/prepare.mjs', from: 150, to: 157, expect: 'const cut =' },
  { ref: 'scripts/prepare.mjs:162', file: 'scripts/prepare.mjs', from: 162, expect: '零构建' },
  { ref: 'scripts/prepare.mjs:180-183', file: 'scripts/prepare.mjs', from: 180, to: 183, expect: 'findings.push' },
  { ref: 'scripts/client-chunks.mjs:32-34', file: 'scripts/client-chunks.mjs', from: 32, to: 34, expect: 'BLOCK_OPEN' },
  { ref: 'scripts/client-chunks.mjs:41-97', file: 'scripts/client-chunks.mjs', from: 41, to: 97, expect: 'function renderStampRows' },
  { ref: 'package.json:22-33', file: 'package.json', from: 22, to: 33, expect: '"files": [' },
  { ref: 'index.js:778-792', file: 'index.js', from: 778, to: 792, expect: 'export function apply' },
  { ref: 'index.js:983-4612', file: 'index.js', from: 983, to: 4612, expect: 'function mount' },
  { ref: 'index.js:2262-2746', file: 'index.js', from: 2262, to: 2746, expect: 'function handleHistory' },
  { ref: 'CONTRACT.md:613', file: 'CONTRACT.md', from: 613, expect: '## 1. Routes and methods' },
  { ref: 'CONTRACT.md:1873', file: 'CONTRACT.md', from: 1873, expect: '## 13. Client-side contract' },
  { ref: 'CONTRACT.md:4137-4145', file: 'CONTRACT.md', from: 4137, to: 4145, expect: 'what the page is running' },
  { ref: 'README.md:325', file: 'README.md', from: 325, expect: '零构建' },
  { ref: 'README.md:344', file: 'README.md', from: 344, expect: 'node --test' },
  { ref: 'NOTES.md:3679', file: 'NOTES.md', from: 3679, expect: '这一条对用户是' },
  { ref: 'test/client.test.mjs:10', file: 'test/client.test.mjs', from: 10, expect: 'Run:' },
  { ref: 'test/build.test.mjs:138-141', file: 'test/build.test.mjs', from: 138, to: 141, at: 140, expect: 'occurrences(clientSource, BEGIN)' },
];

/** 缓存文件行，避免重复读盘。 */
const fileLines = new Map();

/**
 * 读一个文件的行数组。
 * @param relPath - 相对包根的路径。
 * @returns 行数组；读不到时返回 `null`。
 */
function linesOf(relPath) {
  if (fileLines.has(relPath)) return fileLines.get(relPath);
  let lines = null;
  try {
    lines = readFileSync(resolve(PACKAGE_DIR, relPath), 'utf8').split('\n');
  } catch {
    lines = null;
  }
  fileLines.set(relPath, lines);
  return lines;
}

/**
 * 校验一条期望。
 * @param entry - 期望表条目。
 * @returns `{ok, detail}`。
 */
function checkOne(entry) {
  const lines = linesOf(entry.file);
  if (lines === null) return { ok: false, detail: `读不到 ${entry.file}` };
  const last = entry.to ?? entry.from;
  const at = entry.at ?? entry.from;
  const first = lines[at - 1];
  const end = lines[last - 1];
  if (first === undefined || end === undefined) {
    return { ok: false, detail: `${entry.file} 行数不足（要 ${last}，实有 ${lines.length}）` };
  }
  if (entry.stripEquals !== undefined) {
    if (first.trim() !== entry.stripEquals) {
      return { ok: false, detail: `${entry.file}:${at} 期望 "${entry.stripEquals}"，实为 "${first.trim()}"` };
    }
    return { ok: true, detail: '' };
  }
  if (!first.includes(entry.expect)) {
    return { ok: false, detail: `${entry.file}:${at} 不含 "${entry.expect}"，实为 "${first.trim().slice(0, 80)}"` };
  }
  // 区间引用另外检查末端：末行是空行说明区间尾巴写多了（例如把 `#endregion` 之后也圈进来）。
  if (entry.to !== undefined && end.trim() === '') {
    return { ok: false, detail: `${entry.file}:${entry.to} 是空行（区间末端可疑）` };
  }
  return { ok: true, detail: '' };
}

/**
 * 从文档正文里抽出所有 `文件:行` / `文件:行-行` / 简写 `:行` 引用。
 *
 * §10 的证据索引用**简写**（`**\`packages/.../client.js\`**` 标题下的 `:107`，以及
 * 同一行里跟在 `client.test.mjs:1988` 之后的 `:2338-2360`），所以归属分两级：
 *   1. 同一行内该简写**之前**若出现过文件名，归属到它（按 basename 在全文的路径索引解析）；
 *   2. 否则归属到当前文件区块标题（`**\`…\`**`）；标题是目录（以 `/` 结尾）时无法归属。
 * @param doc - 文档全文。
 * @returns `Map<ref, true>`。
 */
function collectRefs(doc) {
  const lines = doc.split('\n');
  // 第一遍：全文的 basename → 路径索引（用于把 `:2338-2360` 归属回 `test/client.test.mjs`）。
  // 包前缀先剥掉，好让标题里的 `packages/dsh-prompt-setting/client.js` 与正文里的
  // 裸 `client.js` 归一成同一个键。
  const PREFIX = 'packages/dsh-prompt-setting/';
  const byBasename = new Map();
  const notePath = (path) => {
    const normalized = path.startsWith(PREFIX) ? path.slice(PREFIX.length) : path;
    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    if (!byBasename.has(base)) byBasename.set(base, new Set());
    byBasename.get(base).add(normalized);
  };
  for (const line of lines) {
    for (const m of line.matchAll(/((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:js|mjs|json|md))/g)) notePath(m[1]);
    for (const m of line.matchAll(/(?<![/\w.-])([A-Za-z0-9_.-]+\.(?:js|mjs|json|md))/g)) notePath(m[1]);
  }
  const pathOf = (base) => {
    const paths = byBasename.get(base);
    if (paths === undefined || paths.size === 0) return null;
    // 带目录的同名路径唯一 ⇒ 用它（`store.js` → `core/store.js`）；
    // 没有带目录的形式 ⇒ 就是包根文件（`client.js`）。
    const withDir = [...paths].filter((path) => path.includes('/'));
    if (withDir.length === 1) return withDir[0];
    if (withDir.length === 0) return base;
    return null; // 多义（多个目录下同名）⇒ 放弃归属，交人工
  };

  // 第二遍：抽引用。
  const found = new Map();
  // 归一：`store.js:295` 与 `core/store.js:295` 是同一处引用，统一成后者。
  const normalize = (file, line) => {
    const base = file.slice(file.lastIndexOf('/') + 1);
    return `${pathOf(base) ?? file}:${line}`;
  };
  let currentFile = '';
  for (const line of lines) {
    const heading = /^\*\*`([^`]+)`\*\*$/.exec(line.trim());
    if (heading !== null) {
      const raw = heading[1];
      currentFile = raw.startsWith('packages/dsh-prompt-setting/')
        ? raw.slice('packages/dsh-prompt-setting/'.length)
        : raw;
      continue;
    }
    for (const m of line.matchAll(/([A-Za-z0-9_./-]+\.(?:js|mjs|json|md)):(\d+)(?:-(\d+))?/g)) {
      const span = m[3] === undefined ? `${m[2]}` : `${m[2]}-${m[3]}`;
      found.set(normalize(m[1], span), true);
    }
    for (const m of line.matchAll(/(?<![A-Za-z0-9_.-]):(\d+)(?:-(\d+))?/g)) {
      const before = line.slice(0, m.index);
      const named = [...before.matchAll(/(?<![/\w.-])([A-Za-z0-9_.-]+\.(?:js|mjs|json|md))/g)].map((x) => x[1]);
      const owner = named.length > 0
        ? pathOf(named[named.length - 1])
        : (currentFile !== '' && !currentFile.endsWith('/') ? currentFile : null);
      if (owner === null) continue;
      found.set(`${owner}:${m[2] === undefined ? m[1] : `${m[1]}-${m[2]}`}`, true);
    }
  }
  return found;
}

/** 主流程。 */
function main() {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const declared = collectRefs(doc);
  const table = new Map(REFS.map((entry) => [entry.ref, entry]));

  const failures = [];
  let verified = 0;
  for (const entry of REFS) {
    const result = checkOne(entry);
    if (result.ok) {
      verified += 1;
      process.stdout.write(`  ok    ${entry.ref}\n`);
    } else {
      failures.push(`${entry.ref}: ${result.detail}`);
      process.stdout.write(`  FAIL  ${entry.ref} — ${result.detail}\n`);
    }
  }

  const manual = [...declared.keys()].filter((ref) => !table.has(ref)).sort();
  for (const ref of manual) process.stdout.write(`  manual ${ref}（需人工核对）\n`);

  process.stdout.write(
    `\ncheck-refs: verified=${verified} failed=${failures.length} manual=${manual.length} `
    + `(文档共出现 ${declared.size} 条引用)\n`,
  );
  if (failures.length > 0) {
    process.stdout.write('\n不符项（先修文档或修期望表，别弱化断言）：\n');
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
    process.exitCode = 1;
    return 1;
  }
  process.stdout.write('check-refs: 期望表内的引用全部成立；manual 项请人工核对（不影响退出码）\n');
  return 0;
}

main();

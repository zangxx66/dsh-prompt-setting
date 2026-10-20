#!/usr/bin/env node
/**
 * `docs/refactor-plan.md` 的**引用体检**（g-072 评审 R3-R5；R4 收敛轮加固为 fail-closed）。
 *
 * 为什么需要它：方案文档里手写了上百条 `文件:行` 引用，靠人眼维护必然漂移
 * （R1-5 / R2-D1 / R3-R1 / R4 都是同一类）。与其修一个个案，不如给文档装一次体检。
 *
 * **R4 的四条加固**（这四条决定了 `failed=0` 是否可信）：
 *   1. **fail-closed**：归属失败（`<unresolved>`）、包内文件读不到、行号越界，一律计入失败
 *      ⇒ 非零退出码。只有**明确的仓库外路径**（宿主 `loader.js` / `lib/index.js` /
 *      `@deepseek-ai/…`）才允许留在 manual。恒等式：
 *      `文档引用数 == verified + rangeOnly + manual + unresolved`。
 *   2. **计数口径分开**：`verified` 只统计「期望表 ∩ 文档引用」里通过的条数——即**文档引用
 *      真的被验证了**的条数；期望表里那些文档中并不存在的条目（`REFS\declared`）单独报数，
 *      **不计入覆盖率**，避免用它们给 `verified` 注水。
 *   3. **manual 不是垃圾桶**：包内可读的引用一律自动判定（越界即 FAIL），manual 只收仓库外路径。
 *   4. **区间端点与宽度**：区间必须声明 `toExpect`（端点逐字断言）或 `loose: true`
 *      （长区间，明确声明只判首行）；跨度 > 90 行而不声明 `loose` ⇒ FAIL；`at` 必须落在区间内。
 *   另：**围栏代码块内的文本不参与体检**（§10 记录的"历史错值"因此不会污染计数）。
 *
 * 另外校验 **§1.3 版图表**与 **§5.1 目标段表**（R4-C1）：行数 == 区间长度、区间首尾相接、
 * 合计 == 12593、每段 ≤ 1200。这两张表是阶段 1/2 的门禁基础，必须可复跑而不是粘贴输出。
 * **§5.1 的段名集合还与磁盘 `src/` 的段名集合逐名对账（g-077 起）**：
 * 「文档 ↔ 磁盘」之间不再经过任何手工常量 —— 段集合的完整性由「段 ↔ 产物逐字节一致」
 * （`prepare` 的 `CLIENT-SRC-DRIFT`）保证，本文档这一侧只断言「§5.1 表写的段名 == 磁盘
 * `src/` 里真实存在的段名（含顺序）」，于是文档改错一个段名、或磁盘换了段名没同步文档，
 * 都会在这里红。
 *
 * **生成物头注与坐标平移（g-075 阶段 2）**：`client.js` 从阶段 2 起是**生成物**，
 * 顶部有 `scripts/client-build.mjs` 注入的「生成物，勿手改」头注（{@link GENERATED_BANNER}）。
 * 文档里的 `client.js:行` 引用与 §1.3/§5.1 两张表记的是**段真源坐标** —— 也就是每个
 * `src/*.js` 切片所处的坐标，头注不属于任何段（它是生成器加的前缀）。真源坐标是唯一
 * 稳定的坐标：头注文案调整不该让上百条文档引用一起漂移。因此本脚本把期望表里
 * `client.js` 的行号按**头注行数**平移后再断言，而文档里的数字保持段真源坐标不变。
 * 这不是"弱化断言"：`CLIENT_HEAD_LINES` 由 {@link GENERATED_BANNER} 实测得出，且
 * `test/client-source.test.mjs` 独立断言头注是纯前缀、在 fingerprint `begin` 之前、
 * 且不改变 `fingerprintOf` 的 hash/size。
 *
 * **g-079 的四条 fail-closed 加固**（本脚本自己 fail-open 等于治本失败）：
 *   1. **恒等式变成真正的失败判定**：`total == verified + rangeOnly + manual + unresolved`
 *      不成立 ⇒ 计入 failures、非零退出（此前只 `console.log`，算式被改坏仍然绿）。
 *      `unresolved` 现在只数**引用级**失败；表格复算 / `REFS\declared` 的失败单独报数，
 *      不再混进恒等式（混装会让恒等式在表格坏掉时假红、在引用被静默丢弃时假绿）。
 *   2. **收集域之外的形态显式计数**：裸行号（`（212）`）、行内代码裸行号（`` `2313` ``）、
 *      裸区间（`185–198`）不被 `REFS` 收集器识别。脚本逐条计数并打印
 *      `未覆盖的引用形态：N 处`（`--verbose` 逐条列出），不再静默吞掉；其中 §1.3/§5.1
 *      表格首列由行数复算覆盖，计数里单独扣除并说明。**这是披露，不是护栏** —— 别把
 *      「已计数」当成「裸行号已校验」，它们仍不在自动判定内。
 *   3. **弱断言披露**：`expect` 只能命中通用串的条目带 `weakReason`，脚本在输出里逐条披露
 *      （能收紧的已收紧为更长、更独特的串；端点行只有 `/**` 这类无法再收紧的才保留并说明理由）。
 *   4. **收集域下限**（返工 U4）：恒等式只保证计数自洽，抓不到「收集器整体失效」（例如
 *      `file:line` 分支被注释掉 ⇒ total 153→62 但恒等式仍成立）。`total < 100` ⇒ 计入
 *      failures、非零退出。
 *
 * 本脚本**只读**：不写任何文件、不改产品代码。它放在 `docs/` 下，而 `package.json`
 * 的 `files` 白名单不含 `docs`，所以它不会随包发布。
 *
 * 用法（在 `packages/dsh-prompt-setting/` 下）：
 *   node docs/check-refs.mjs          # 体检；有 fail/unresolved ⇒ 非零退出码
 *
 * 输出四类：
 *   ok        —— 期望表内、且文档确实引用了，行内容与声称的符号一致；
 *   rangeOnly —— 文档引用了、包内可读、行号合法，但期望表没有符号期望（最小验证）；
 *   manual    —— 仓库外路径，无法自动判定，逐条列出供人工核对（**不影响退出码**）；
 *   unresolved/FAIL —— 归属失败、读不到、越界或断言不符（**非零退出码**）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLIENT_SRC_DIR, GENERATED_BANNER, segmentNames } from '../scripts/client-build.mjs';

/** `docs/` 目录（本文件所在）。 */
const DOCS_DIR = dirname(fileURLToPath(import.meta.url));
/** 包根目录。 */
const PACKAGE_DIR = dirname(DOCS_DIR);
/** 被体检的文档。 */
const DOC_PATH = join(DOCS_DIR, 'refactor-plan.md');

/**
 * 段真源坐标 → 生成物行号的平移量：生成物头注的行数（g-075 阶段 2）。
 *
 * 头注是 `client.js` 的纯前缀，所以 `生成物第 N 行 == 段真源第 N - CLIENT_HEAD_LINES 行`。
 * 只有 `file === 'client.js'` 的期望需要平移；段文件、`index.js`、`scripts/`、`test/`
 * 一律不动（它们的行锚点是行数中性维护的）。
 */
const CLIENT_HEAD_LINES = GENERATED_BANNER.split('\n').length - 1;

/**
 * **仓库外**路径前缀：这些引用指向宿主包或安装目录，本仓库读不到，只能人工核对。
 * 其余"读不到"的引用一律算失败（fail-closed）——`src/README.md` 这种尚未存在的路径也算。
 */
const OUT_OF_REPO = [
  /^@deepseek-ai\//,
  /^deepseek-ai\//, // 正则剥掉 `@` 后剩下的形式
  /^lib\//,
  /^loader\.js$/,
  /^dsh-client-modules\//,
  /^node_modules\//,
];

/** 一个引用是否属于"仓库外、只可人工核对"。 */
const isOutOfRepo = (file) => OUT_OF_REPO.some((pattern) => pattern.test(file));

/**
 * 期望表：文档中声称「`file:line` 处就是 `expect`」的引用。
 *
 * `from` 与 `to` 都是 1 基行号；`to` 缺省表示单行引用。`expect` 用 `includes`
 * 判定；`stripEquals` 用于「该行去掉缩进后恰好等于某串」这类断言（例如闭括号）。
 * `at`（缺省 `from`）用于「区间以 JSDoc/注释开头、被断言的符号在区间中段」的引用。
 * `toExpect` / `fromExpect` 给出区间**末行/首行**的逐字断言；`loose: true` 声明「长区间，只判 `at` 行」。跨度 > 90 行且未声明 `loose` ⇒ FAIL；跨度 ≤ 90 且无 `toExpect` ⇒ FAIL。
 * `weakReason`：该条 `expect` 只能命中通用串（纯符号 / 常见词）时，写明**为什么不能再收紧**；
 * 脚本会把所有带 `weakReason` 的条目逐条打印出来（g-079 项 2b：不留沉默项）。
 * @type {{ref: string, file: string, from: number, to?: number, at?: number, expect?: string, stripEquals?: string, fromExpect?: string, toExpect?: string, loose?: boolean, weakReason?: string}[]}
 */
const REFS = [
  // ── client.js ────────────────────────────────────────────────────────────
  { ref: 'client.js:107', file: 'client.js', from: 107, expect: '__ModuleLoader__.load({' },
  { ref: 'client.js:114', file: 'client.js', from: 114, expect: 'factory: function promptSettingFactory(require) {' },
  { ref: 'client.js:115', file: 'client.js', from: 115, expect: '@build-fingerprint:begin' },
  { ref: 'client.js:182', file: 'client.js', from: 182, expect: 'SELF_BUILD = fingerprintOf(promptSettingFactory.toString())' },
  { ref: 'client.js:213', file: 'client.js', from: 213, expect: "const React = require('react');" },
  { ref: 'client.js:906-2104', file: 'client.js', from: 906, to: 2104, expect: '#region generated: locale', toExpect: "// #endregion", loose: true },
  { ref: 'client.js:2173', file: 'client.js', from: 2173, expect: '#region fallback atoms' },
  { ref: 'client.js:2707', file: 'client.js', from: 2707, expect: '#region pure helpers' },
  { ref: 'client.js:3397', file: 'client.js', from: 3397, expect: 'function chunkStampMap' },
  { ref: 'client.js:3435', file: 'client.js', from: 3435, expect: 'function buildVerdict' },
  { ref: 'client.js:7354', file: 'client.js', from: 7354, expect: 'function renderMinePanel' },
  { ref: 'client.js:7354-7900', file: 'client.js', from: 7354, to: 7900, expect: 'function renderMinePanel', toExpect: "}", loose: true },
  { ref: 'client.js:7900', file: 'client.js', from: 7900, stripEquals: '}' },
  { ref: 'client.js:7919', file: 'client.js', from: 7919, expect: 'const CHUNK_STAMPS = Object.freeze([' },
  { ref: 'client.js:7936', file: 'client.js', from: 7936, expect: 'const CHUNK_FACILITIES = Object.freeze({' },
  { ref: 'client.js:7936-8025', file: 'client.js', from: 7936, to: 8025, expect: 'const CHUNK_FACILITIES = Object.freeze({', toExpect: "});" },
  { ref: 'client.js:8025', file: 'client.js', from: 8025, stripEquals: '});' },
  { ref: 'client.js:8109', file: 'client.js', from: 8109, expect: 'function loadChunk' },
  { ref: 'client.js:8120', file: 'client.js', from: 8120, expect: 'function recordLoadedChunk' },
  { ref: 'client.js:8214', file: 'client.js', from: 8214, expect: 'function chunkModule' },
  { ref: 'client.js:8248', file: 'client.js', from: 8248, expect: 'client.history.js' },
  { ref: 'client.js:8270-8318', file: 'client.js', from: 8270, to: 8318, expect: 'HistoryTabChunk', toExpect: "? React.lazy(() => chunkModule('client.presets.js', (chunkExports) => chunkExports && chunkExports.PresetsTab))" },
  { ref: 'client.js:8294-8299', file: 'client.js', from: 8294, to: 8299, expect: 'deliberately', toExpect: "* click, which is exactly the case a lazy boundary is for." },
  { ref: 'client.js:8339', file: 'client.js', from: 8339, expect: 'function chunkTab' },
  { ref: 'client.js:9026', file: 'client.js', from: 9026, expect: 'data-build-loaded' },
  { ref: 'client.js:9066', file: 'client.js', from: 9066, expect: 'function PromptSettingSection' },
  { ref: 'client.js:9066-12237', file: 'client.js', from: 9066, to: 12237, expect: 'function PromptSettingSection', toExpect: "}", loose: true },
  { ref: 'client.js:9075', file: 'client.js', from: 9075, expect: 'React.useSyncExternalStore(' },
  { ref: 'client.js:12237', file: 'client.js', from: 12237, stripEquals: '}' },
  { ref: 'client.js:12250', file: 'client.js', from: 12250, expect: 'function renderFailureCard' },
  { ref: 'client.js:12340', file: 'client.js', from: 12340, expect: 'return { failed: true };' },
  { ref: 'client.js:12354', file: 'client.js', from: 12354, expect: "inject: ['slots', 'locale']," },
  { ref: 'client.js:12362', file: 'client.js', from: 12362, expect: '__internals' },
  { ref: 'client.js:12365', file: 'client.js', from: 12365, expect: 'shared: CHUNK_FACILITIES' },
  { ref: 'client.js:12399', file: 'client.js', from: 12399, expect: 'apply(ctx)' },
  { ref: 'client.js:12522', file: 'client.js', from: 12522, expect: 'function degradedPlugin' },
  // ── index.js ─────────────────────────────────────────────────────────────
  { ref: 'index.js:231', file: 'index.js', from: 231, expect: 'CLIENT_BUNDLE_PATH' },
  { ref: 'index.js:786', file: 'index.js', from: 786, expect: 'export function apply' },
  { ref: 'index.js:991', file: 'index.js', from: 991, expect: 'function mount' },
  { ref: 'index.js:4909', file: 'index.js', from: 4909, expect: 'clientBuild: clientBuildInfo' },
  { ref: 'index.js:5167', file: 'index.js', from: 5167, stripEquals: '}' },
  { ref: 'index.js:5170', file: 'index.js', from: 5170, expect: 'export { ACTIONS' },
  // ── core/ ────────────────────────────────────────────────────────────────
  { ref: 'core/build.js:35', file: 'core/build.js', from: 35, expect: 'FINGERPRINT_BEGIN' },
  { ref: 'core/build.js:37', file: 'core/build.js', from: 37, expect: 'FINGERPRINT_END' },
  { ref: 'core/build.js:52', file: 'core/build.js', from: 52, expect: 'function normalizeBuildText' },
  { ref: 'core/build.js:66', file: 'core/build.js', from: 66, expect: 'function fingerprintRegion' },
  { ref: 'core/build.js:101', file: 'core/build.js', from: 101, expect: 'function fingerprintOf' },
  { ref: 'core/store.js:298', file: 'core/store.js', from: 298, expect: 'function clientBuildInfo' },
  { ref: 'core/store.js:311', file: 'core/store.js', from: 311, expect: 'chunks: clientChunkStamps(' },
  { ref: 'core/store.js:326', file: 'core/store.js', from: 326, expect: 'CLIENT_CHUNK_PATTERN' },
  { ref: 'core/store.js:340', file: 'core/store.js', from: 340, expect: 'function clientChunkStamps' },
  // ── scripts/ ─────────────────────────────────────────────────────────────
  { ref: 'scripts/client-chunks.mjs:34', file: 'scripts/client-chunks.mjs', from: 34, expect: 'BLOCK_OPEN' },
  { ref: 'scripts/client-chunks.mjs:43', file: 'scripts/client-chunks.mjs', from: 43, expect: 'function renderStampRows' },
  { ref: 'scripts/client-chunks.mjs:54', file: 'scripts/client-chunks.mjs', from: 54, expect: 'function readDeclaredStamps' },
  { ref: 'scripts/client-chunks.mjs:77', file: 'scripts/client-chunks.mjs', from: 77, expect: 'function writeDeclaredStamps' },
  { ref: 'scripts/client-chunks.mjs:93', file: 'scripts/client-chunks.mjs', from: 93, expect: 'function sameStamps' },
  { ref: 'scripts/client-chunks.mjs:129', file: 'scripts/client-chunks.mjs', from: 129, expect: 'function main(' },
  { ref: 'scripts/prepare.mjs:9', file: 'scripts/prepare.mjs', from: 9, expect: '本包是零编译包（无 bundler / JSX / TypeScript' },
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
  { ref: 'test/build.test.mjs:136-171', file: 'test/build.test.mjs', from: 136, to: 171, expect: 'the real client.js region covers', toExpect: "assert.ok(fingerprint.size > 50000, 'the region is the bulk of the entry file');" },
  { ref: 'test/build.test.mjs:171', file: 'test/build.test.mjs', from: 171, expect: 'size > 50000' },
  { ref: 'test/build.test.mjs:174', file: 'test/build.test.mjs', from: 174, expect: 'every chunk carries one marker pair' },
  { ref: 'test/build.test.mjs:174-198', file: 'test/build.test.mjs', from: 174, to: 198, expect: 'every chunk carries one marker pair', toExpect: "});" },
  { ref: 'test/build.test.mjs:200', file: 'test/build.test.mjs', from: 200, expect: 'CHUNK_STAMPS manifest is exactly' },
  { ref: 'test/client.test.mjs:2024', file: 'test/client.test.mjs', from: 2024, expect: 'flat sibling' },
  { ref: 'test/client.test.mjs:2067-2074', file: 'test/client.test.mjs', from: 2067, to: 2074, expect: 'chunkFailures', toExpect: "assert.ok(hasText(tree, 'chunk unavailable: client.history.js'), 'and the reason is on screen');" },
  { ref: 'test/client.test.mjs:2376', file: 'test/client.test.mjs', from: 2376, expect: 'shared.x' },
  { ref: 'test/client.test.mjs:2376-2398', file: 'test/client.test.mjs', from: 2376, to: 2398, expect: 'shared.x', toExpect: "for (const hit of code.matchAll(redefined)) {" },
  { ref: 'test/client.test.mjs:2556', file: 'test/client.test.mjs', from: 2556, expect: 'scrimStyle' },
  { ref: 'test/client.test.mjs:2554-2558', file: 'test/client.test.mjs', from: 2554, to: 2558, expect: 'readFileSync', toExpect: "'renderConfirm states 1200 and renderRegionDialog states 1000'," },
  { ref: 'test/boot.test.mjs:56', file: 'test/boot.test.mjs', from: 56, expect: "const clientSource = readFileSync(join(packageRoot, 'client.js'), 'utf8');" },
  { ref: 'test/host.test.mjs:171', file: 'test/host.test.mjs', from: 171, expect: 'packageJson.files' },
  { ref: 'test/host.test.mjs:171-197', file: 'test/host.test.mjs', from: 171, to: 197, expect: 'packageJson.files', toExpect: "});" },
  { ref: 'test/prepare.test.mjs:440', file: 'test/prepare.test.mjs', from: 440, expect: 'incomplete checkout' },
  { ref: 'test/prepare.test.mjs:440-485', file: 'test/prepare.test.mjs', from: 440, to: 485, expect: 'incomplete checkout', toExpect: "});" },
  { ref: 'test/prepare.test.mjs:487', file: 'test/prepare.test.mjs', from: 487, expect: 'CHUNK_STAMPS manifest that drifted' },
  { ref: 'test/prepare.test.mjs:487-539', file: 'test/prepare.test.mjs', from: 487, to: 539, expect: 'CHUNK_STAMPS manifest that drifted', toExpect: "});" },
  // ── 仓库内文档（零编译承诺 / 客户端入口为生成物；g-075 阶段 2 按 §9-1 裁决改口）──────
  { ref: 'README.md:122', file: 'README.md', from: 122, expect: '**零运行时依赖、零编译 / Zero runtime dependencies, zero compilation**' },
  { ref: 'NOTES.md:3635', file: 'NOTES.md', from: 3635, expect: '本包是**零编译**包（无 bundler / JSX / TypeScript）' },
  { ref: 'CONTRACT.md:4460', file: 'CONTRACT.md', from: 4460, expect: '## 14. Client build stamp' },
  { ref: 'CONTRACT.md:7892', file: 'CONTRACT.md', from: 7892, expect: 'no build step' },
  // ── 文档里实际引用的区间（补全，减少人工核对项）──────────────────────────
  { ref: 'client.js:55-61', file: 'client.js', from: 55, to: 61, expect: 'Two hard rules', toExpect: "*" },
  { ref: 'client.js:62-66', file: 'client.js', from: 62, to: 66, expect: 'Markers the page carries', toExpect: "*" },
  { ref: 'client.js:67-73', file: 'client.js', from: 67, to: 73, expect: 'Revision 6 adds', toExpect: "* failed ping yields, and which is deliberately never reported as「过期」." },
  { ref: 'client.js:906-914', file: 'client.js', from: 906, to: 914, expect: '#region generated', toExpect: "subtitle: '查看并覆盖每轮会话最终装配的 system prompt。写入作用于下一轮装配（next-turn）。'," },
  { ref: 'client.js:3979-3983', file: 'client.js', from: 3979, to: 3983, expect: 'g-061 batch 2', toExpect: "* renders in." },
  { ref: 'client.js:7919-7925', file: 'client.js', from: 7919, to: 7925, expect: 'const CHUNK_STAMPS', toExpect: "]);" },
  { ref: 'client.js:7927-7935', file: 'client.js', from: 7927, to: 7935, at: 7928, expect: 'cross-chunk facility', toExpect: "*/" },
  { ref: 'client.js:8046-8060', file: 'client.js', from: 8046, to: 8060, expect: 'function subscribeChunkLoads', toExpect: "*/" },
  { ref: 'client.js:8109-8112', file: 'client.js', from: 8109, to: 8112, expect: 'function loadChunk', toExpect: "}" },
  { ref: 'client.js:8120-8130', file: 'client.js', from: 8120, to: 8130, expect: 'function recordLoadedChunk', toExpect: "}" },
  { ref: 'client.js:8133', file: 'client.js', from: 8133, expect: 'function loadedChunkStamps' },
  { ref: 'client.js:8154', file: 'client.js', from: 8154, expect: 'function chunkFailureComponent' },
  { ref: 'client.js:8269', file: 'client.js', from: 8269, expect: 'function renderHistoryChunk' },
  { ref: 'client.js:8339-8407', file: 'client.js', from: 8339, to: 8407, expect: 'function chunkTab', toExpect: "function renderPresetsChunk(t, m, a) {" },
  { ref: 'client.js:12362-12365', file: 'client.js', from: 12362, to: 12365, expect: '__internals', toExpect: "shared: CHUNK_FACILITIES," },
  { ref: 'client.history.js:36', file: 'client.history.js', from: 36, expect: "require('dsh-prompt-setting')" },
  { ref: 'core/store.js:280-296', file: 'core/store.js', from: 280, to: 296, at: 281, expect: 'Read the published client bundle', toExpect: "*   three fields for every chunk file beside it — or `null`." },
  { ref: 'core/store.js:298-318', file: 'core/store.js', from: 298, to: 318, expect: 'function clientBuildInfo', toExpect: "/**" },
  { ref: 'core/store.js:340-367', file: 'core/store.js', from: 340, to: 367, expect: 'function clientChunkStamps', toExpect: "/**" },
  { ref: 'core/build.js:35-37', file: 'core/build.js', from: 35, to: 37, expect: 'FINGERPRINT_BEGIN', toExpect: "export const FINGERPRINT_END = '/* @build-fingerprint:end */';" },
  { ref: 'core/build.js:66-78', file: 'core/build.js', from: 66, to: 78, expect: 'function fingerprintRegion', toExpect: "}" },
  { ref: 'core/build.js:85-95', file: 'core/build.js', from: 85, to: 95, expect: 'function fnv1a32', toExpect: "* Fingerprint a whole file's {@link fingerprintRegion}." },
  { ref: 'core/build.js:101-105', file: 'core/build.js', from: 101, to: 105, expect: 'function fingerprintOf', toExpect: "}" },
  { ref: 'scripts/prepare.mjs:1-30', file: 'scripts/prepare.mjs', from: 1, to: 30, expect: '#!/usr/bin/env node', toExpect: "import { dirname, join, resolve, sep } from 'node:path';" },
  { ref: 'scripts/prepare.mjs:86-129', file: 'scripts/prepare.mjs', from: 86, to: 129, expect: 'function inspectClientChunks', toExpect: "*" },
  { ref: 'scripts/prepare.mjs:135-167', file: 'scripts/prepare.mjs', from: 135, to: 167, expect: 'function inspectLocale', toExpect: "let manifestError = null;" },
  { ref: 'scripts/prepare.mjs:139-145', file: 'scripts/prepare.mjs', from: 139, to: 145, at: 144, expect: 'LOCALE-SYNC-N/A', toExpect: "}" },
  { ref: 'scripts/prepare.mjs:150-157', file: 'scripts/prepare.mjs', from: 150, to: 157, expect: 'const cut =', toExpect: "}" },
  { ref: 'scripts/prepare.mjs:162', file: 'scripts/prepare.mjs', from: 162, expect: "prepare：发布就绪自检（本包零编译；`client.js` 是 `src/` 的生成物）" },
  { ref: 'scripts/prepare.mjs:180-183', file: 'scripts/prepare.mjs', from: 180, to: 183, expect: 'findings.push', toExpect: "findings.push(inspectLocale(pkg && pkg.files));" },
  { ref: 'scripts/client-chunks.mjs:34-36', file: 'scripts/client-chunks.mjs', from: 34, to: 36, expect: 'BLOCK_OPEN', toExpect: "const BLOCK_CLOSE = '    ]);';" },
  { ref: 'scripts/client-chunks.mjs:43-99', file: 'scripts/client-chunks.mjs', from: 43, to: 99, expect: 'function renderStampRows', toExpect: "}" },
  { ref: 'package.json:22-33', file: 'package.json', from: 22, to: 33, expect: '"files": [', toExpect: "]," },
  { ref: 'index.js:786-800', file: 'index.js', from: 786, to: 800, expect: 'export function apply', toExpect: "}" },
  { ref: 'index.js:991-5167', file: 'index.js', from: 991, to: 5167, expect: 'function mount', toExpect: "}", loose: true },
  { ref: 'index.js:2407-2768', file: 'index.js', from: 2407, to: 2768, expect: 'function handleHistory', toExpect: "*/", loose: true },
  { ref: 'CONTRACT.md:630', file: 'CONTRACT.md', from: 630, expect: '## 1. Routes and methods' },
  { ref: 'CONTRACT.md:2313', file: 'CONTRACT.md', from: 2313, expect: '## 13. Client-side contract' },
  { ref: 'CONTRACT.md:4742-4750', file: 'CONTRACT.md', from: 4742, to: 4750, expect: 'what the page is running', toExpect: "moment." },
  { ref: 'README.md:345', file: 'README.md', from: 345, expect: '（本包零编译，客户端入口 `client.js` 是 `src/` 的生成物' },
  { ref: 'README.md:364', file: 'README.md', from: 364, expect: 'node --test' },
  { ref: 'NOTES.md:3679', file: 'NOTES.md', from: 3679, expect: '这一条对用户是' },
  { ref: 'test/client.test.mjs:10', file: 'test/client.test.mjs', from: 10, expect: 'Run: `node --test test/`' },
  { ref: 'test/build.test.mjs:138-141', file: 'test/build.test.mjs', from: 138, to: 141, at: 140, expect: 'occurrences(clientSource, BEGIN)', toExpect: "assert.equal(occurrences(clientSource, END), 1, 'exactly one end marker');" },
  // ── rangeOnly 收编（R4-A3：包内可读的引用一律纳入自动判定）──────────────
  { ref: 'scripts/prepare.mjs:170-186', file: 'scripts/prepare.mjs', from: 170, to: 186, stripEquals: "try {", toExpect: "if (manifestError !== null) say(`  FAIL  MANIFEST-UNREADABLE: ${manife" },
  { ref: 'client.js:107-114', file: 'client.js', from: 107, to: 114, expect: "window.__ModuleLoader__.load({", toExpect: "factory: function promptSettingFactory(require) {" },
  { ref: 'core/build.js:52-56', file: 'core/build.js', from: 52, to: 56, expect: "export function normalizeBuildText(text) {", toExpect: "}" },
  { ref: 'core/store.js:280-297', file: 'core/store.js', from: 280, to: 297, stripEquals: '/**', toExpect: ' */', weakReason: '端点行只有 JSDoc 起止标记（`/**` 与 `*/`），精确匹配已是上限；块内语义由 core/store.js:280-296 条目的 at=281 断言覆盖' },
  { ref: 'test/build.test.mjs:136-172', file: 'test/build.test.mjs', from: 136, to: 172, expect: "test('build: the real client.js region covers every byte the entry fac", toExpect: "});" },
  { ref: 'index.js:4898-4918', file: 'index.js', from: 4898, to: 4918, expect: "ok: true,", toExpect: "}" },
  { ref: 'package.json:27', file: 'package.json', from: 27, expect: "\"locale\"," },
  { ref: 'test/client.test.mjs:2554', file: 'test/client.test.mjs', from: 2554, expect: "const entry = readFileSync(join(here, '..', 'client.js'), 'utf8');" },
  { ref: 'test/client.test.mjs:2560-2568', file: 'test/client.test.mjs', from: 2560, to: 2568, expect: "const presets = chunkCode(readFileSync(join(here, '..', 'client.preset", toExpect: "}" },
  { ref: 'index.js:1134-1201', file: 'index.js', from: 1134, to: 1201, expect: "function assemblyNoticeEnabled() {", toExpect: "function workspaceRegistry() {" },
  { ref: 'test/host.test.mjs:194-196', file: 'test/host.test.mjs', from: 194, to: 196, expect: "assert.equal(packageJson.files.includes('test'), false);", toExpect: "assert.equal(packageJson.files.includes('node_modules'), false);" },
  { ref: 'test/build.test.mjs:142', file: 'test/build.test.mjs', from: 142, expect: "assert.ok(clientSource.indexOf(BEGIN) < clientSource.indexOf(END), 'be" },
  { ref: 'client.js:12591', file: 'client.js', from: 12591, expect: "/* @build-fingerprint:end */" },
  { ref: 'client.js:214', file: 'client.js', from: 214, expect: "const h = React.createElement;" },
  { ref: 'client.js:310', file: 'client.js', from: 310, expect: "const primitives =" },
  { ref: 'client.js:2112', file: 'client.js', from: 2112, expect: "let fallbackT = (key) => key;" },
  { ref: 'client.js:2115', file: 'client.js', from: 2115, expect: "const token = {" },
  { ref: 'client.js:2332', file: 'client.js', from: 2332, expect: "const UI = {" },
  { ref: 'client.js:2438', file: 'client.js', from: 2438, expect: "function tabs(items, value, onChange, label, group) {" },
  { ref: 'client.js:2715', file: 'client.js', from: 2715, expect: "function fmt(text, params) {" },
  { ref: 'client.js:3967', file: 'client.js', from: 3967, expect: "const cardStyle = {" },
  { ref: 'client.js:4010', file: 'client.js', from: 4010, expect: "function scrimStyle(zIndex) {" },
  { ref: 'client.js:4472', file: 'client.js', from: 4472, expect: "function errorBanner(t, error, title) {" },
  { ref: 'client.js:4613', file: 'client.js', from: 4613, expect: "function stampOf(at) {" },
  { ref: 'client.js:5002', file: 'client.js', from: 5002, expect: "function layerLabel(t, layer) {" },
  { ref: 'README.md:350', file: 'README.md', from: 350, expect: "> zero-compilation; `client.js` is generated from `src/`" },
];

/** 一个包内相对路径是否真实存在（用于归属时优先选"包内存在"的候选）。 */
function fileExists(relPath) {
  try {
    return existsSync(resolve(PACKAGE_DIR, relPath));
  } catch {
    return false;
  }
}

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
 * 校验一条期望（fail-closed）。
 *
 * 规则：①文件必须可读；②行号必须落在文件内；③`at` 必须在 `[from, to]` 内；
 * ④区间跨度 > 90 行必须声明 `loose: true`，跨度 ≤ 90 行必须给 `toExpect`；
 * ⑤`expect` 判 `at` 行、`fromExpect` 判首行、`toExpect` 判末行（都按 `includes` 逐字）。
 *
 * 期望表一律记**段真源坐标**；`client.js` 的条目在这里按 {@link CLIENT_HEAD_LINES}
 * 平移到生成物行号后断言（见文件头「生成物头注与坐标平移」）。
 * @param entry - 期望表条目（段真源坐标）。
 * @returns `{ok, detail}`（`detail` 里的行号是**生成物行号**，即实际读到的那一行）。
 */
function checkExpectation(entry) {
  const lines = linesOf(entry.file);
  if (lines === null) return { ok: false, detail: `读不到 ${entry.file}` };
  const shift = entry.file === 'client.js' ? CLIENT_HEAD_LINES : 0;
  const from = entry.from + shift;
  const to = entry.to === undefined ? undefined : entry.to + shift;
  const last = to ?? from;
  if (from < 1 || last > lines.length) {
    return { ok: false, detail: `${entry.file} 行数不足（要 ${last}，实有 ${lines.length}）` };
  }
  const at = entry.at === undefined ? from : entry.at + shift;
  if (to !== undefined && (at < from || at > to)) {
    return { ok: false, detail: `${entry.ref}: at=${at} 不在区间 [${from}, ${to}] 内` };
  }
  if (to !== undefined) {
    const span = to - from + 1;
    if (span > 90 && entry.loose !== true) {
      return { ok: false, detail: `${entry.ref}: 跨度 ${span} 行 > 90，必须声明 loose: true（或收窄区间）` };
    }
    if (span <= 90 && entry.toExpect === undefined) {
      return { ok: false, detail: `${entry.ref}: 跨度 ${span} 行 ≤ 90，必须给出 toExpect（端点逐字断言）` };
    }
  }
  const atLine = lines[at - 1];
  if (entry.stripEquals !== undefined) {
    if (atLine.trim() !== entry.stripEquals) {
      return { ok: false, detail: `${entry.file}:${at} 期望 "${entry.stripEquals}"，实为 "${atLine.trim()}"` };
    }
  } else if (entry.expect !== undefined && !atLine.includes(entry.expect)) {
    return { ok: false, detail: `${entry.file}:${at} 不含 "${entry.expect}"，实为 "${atLine.trim().slice(0, 80)}"` };
  }
  if (entry.fromExpect !== undefined && !lines[from - 1].includes(entry.fromExpect)) {
    return { ok: false, detail: `${entry.file}:${from} 不含 fromExpect "${entry.fromExpect}"，实为 "${lines[from - 1].trim().slice(0, 80)}"` };
  }
  if (entry.toExpect !== undefined && !lines[last - 1].includes(entry.toExpect)) {
    return { ok: false, detail: `${entry.file}:${last} 不含 toExpect "${entry.toExpect}"，实为 "${lines[last - 1].trim().slice(0, 80)}"` };
  }
  return { ok: true, detail: '' };
}

/**
 * 从文档正文里抽出所有 `文件:行` / `文件:行-行` / 简写 `:行` 引用。
 *
 * **跳过围栏代码块**（§10 记录的"历史错值"因此不参与体检）。归属分两级：
 *   1. 同一行内该简写**之前**若出现过文件名，归属到它（按 basename 索引解析）；
 *   2. 否则归属到当前文件区块标题（`**\`…\`**`）；标题是目录时**无法归属**，记入 `unowned`。
 *
 * `pathOf` 优先选**包内真实存在**的候选，因此本包 `index.js` 不会被误挂到宿主的
 * `lib/index.js`，`src/README.md` 也不会顶掉真实存在的 `README.md`。
 * @param doc - 文档全文。
 * @returns `{declared: Map<ref, {file, from, to}>, unowned: string[]}`。
 */
function collectRefs(doc) {
  const scannable = [];
  let inFence = false;
  for (const line of doc.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) scannable.push(line);
  }

  const PREFIX = 'packages/dsh-prompt-setting/';
  const byBasename = new Map();
  const notePath = (path) => {
    const normalized = path.startsWith(PREFIX) ? path.slice(PREFIX.length) : path;
    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    if (!byBasename.has(base)) byBasename.set(base, new Set());
    byBasename.get(base).add(normalized);
  };
  for (const line of scannable) {
    for (const m of line.matchAll(/((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:js|mjs|json|md))/g)) notePath(m[1]);
    for (const m of line.matchAll(/(?<![/\w.-])([A-Za-z0-9_.-]+\.(?:js|mjs|json|md))/g)) notePath(m[1]);
  }
  const pathOf = (base) => {
    const candidates = [...(byBasename.get(base) ?? [])];
    // ① 包内真实存在的候选优先（唯一 ⇒ 直接用它）
    const existing = candidates.filter(fileExists);
    if (existing.length === 1) return existing[0];
    // ② 多个存在 ⇒ 优先包根（不带目录）的那个
    if (existing.length > 1) return existing.find((path) => !path.includes('/')) ?? null;
    // ③ 裸名在包根不存在时，探测常见子目录（§10 的索引写的是 `boot.test.mjs:56` 这种简写）
    if (!base.includes('/')) {
      for (const dir of ['test/', 'core/', 'scripts/', 'locale/']) {
        if (fileExists(dir + base)) return dir + base;
      }
    }
    // ④ 一个都不存在：唯一候选就用它（随后会因"读不到"而 FAIL，正是 fail-closed 想要的）
    if (candidates.length === 1) return candidates[0];
    return null;
  };

  const declared = new Map();
  const unowned = [];
  let currentFile = '';
  for (const line of scannable) {
    const heading = /^\*\*`([^`]+)`\*\*$/.exec(line.trim());
    if (heading !== null) {
      const raw = heading[1];
      currentFile = raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw;
      continue;
    }
    for (const m of line.matchAll(/([A-Za-z0-9_./-]+\.(?:js|mjs|json|md)):(\d+)(?:-(\d+))?/g)) {
      const rawFile = m[1];
      const base = rawFile.slice(rawFile.lastIndexOf('/') + 1);
      // 带路径的引用**不许**被 basename 顶成包内同名文件（宿主 `lib/index.js`、`…/lib/client.js`）
      const stripped = rawFile.startsWith(PREFIX) ? rawFile.slice(PREFIX.length) : rawFile;
      const file = rawFile.includes('/')
        ? (isOutOfRepo(stripped) || fileExists(stripped) ? stripped : (pathOf(base) ?? stripped))
        : (pathOf(base) ?? rawFile);
      const from = Number(m[2]);
      const to = m[3] === undefined ? undefined : Number(m[3]);
      const key = to === undefined ? `${file}:${from}` : `${file}:${from}-${to}`;
      declared.set(key, { file, from, to });
    }
    for (const m of line.matchAll(/(?<![A-Za-z0-9_.-]):(\d+)(?:-(\d+))?/g)) {
      const before = line.slice(0, m.index);
      // 同行内、该简写**之前**最后一个文件引用：先看"带路径"的形式（`test/x.mjs`、
      // `@deepseek-ai/.../lib/client.js`），它比裸名更具体（否则宿主 `lib/client.js`
      // 会被裸名 `client.js` 顶成包内文件）；没有再退回裸名。
      const full = [...before.matchAll(/([A-Za-z0-9_./@-]+\.(?:js|mjs|json|md))/g)].map((x) => x[1]);
      const lastFull = full.length > 0 ? full[full.length - 1] : null;
      let owner = null;
      if (lastFull !== null && (lastFull.includes('/') || lastFull.startsWith('@'))) {
        const stripped = lastFull.startsWith(PREFIX) ? lastFull.slice(PREFIX.length) : lastFull;
        owner = isOutOfRepo(stripped) || existsSync(resolve(PACKAGE_DIR, stripped)) ? stripped : pathOf(lastFull.slice(lastFull.lastIndexOf('/') + 1));
      } else if (lastFull !== null) {
        owner = pathOf(lastFull);
      }
      if (owner === null && currentFile !== '' && !currentFile.endsWith('/')) owner = currentFile;
      const from = Number(m[1]);
      const to = m[2] === undefined ? undefined : Number(m[2]);
      if (owner === null) {
        unowned.push(`:${m[1]}${m[2] === undefined ? '' : `-${m[2]}`}`);
        continue;
      }
      const key = to === undefined ? `${owner}:${from}` : `${owner}:${from}-${to}`;
      declared.set(key, { file: owner, from, to });
    }
  }
  return { declared, unowned };
}

/**
 * 从文档里解析一张「行区间 / 行数」表。
 * @param lines - 文档行数组（**已剔除围栏代码块**）。
 * @param startPrefix - 表格所在小节/段落的起始行前缀。
 * @param endPrefix - 表格结束后的第一行前缀。
 * @param rowPattern - 行正则，捕获组 1/2/3 = 起始行、结束行、行数。
 * @returns `{from, to, count}[]`。
 */
function parseSpanTable(lines, startPrefix, endPrefix, rowPattern) {
  const start = lines.findIndex((line) => line.startsWith(startPrefix));
  const end = lines.findIndex((line, index) => index > start && line.startsWith(endPrefix));
  const rows = [];
  for (const line of lines.slice(start, end === -1 ? undefined : end)) {
    const m = rowPattern.exec(line);
    if (m !== null) rows.push({ from: Number(m[1]), to: Number(m[2]), count: Number(m[3]) });
  }
  return rows;
}

/**
 * 从 §5.1 目标段表里解析**段名集合**（每行第一列的反引号段名，按表内顺序）。
 *
 * 为什么体检要管这个（g-076 返工 S2，g-077 换成磁盘锚）：段名集合有两份真源 —— 文档表
 * 与磁盘 `src/` 的段文件。只钉住「磁盘 ↔ 产物」（发布门 `CLIENT-SRC-DRIFT`）而漏掉
 * 「文档 ↔ 磁盘」，文档里改错一个段名就无人发现 —— 这正是 g-072 反复吃的亏。而 g-077
 * 删掉了手工常量，所以这里直接对磁盘 `src/` 的段名（`segmentNames` 给出含顺序的集合），
 * 不再依赖任何手写清单。
 * @param lines - 文档行数组。
 * @returns 段名数组（解析不到时为空数组）。
 */
function parseSegmentNames(lines) {
  const start = lines.findIndex((line) => line.startsWith('**阶段 2 的目标段划分'));
  const end = lines.findIndex((line, index) => index > start && line.startsWith('合计 12593 行'));
  const names = [];
  for (const line of lines.slice(start, end === -1 ? undefined : end)) {
    const m = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (m !== null) names.push(m[1]);
  }
  return names;
}

/**
 * 校验 §1.3 版图表与 §5.1 目标段表（R4-C1）的可复算不变式。
 * @param lines - 文档行数组（已剔除围栏代码块）。
 * @returns 失败说明数组（空数组 = 全部成立）。
 */
function checkTables(lines) {
  const failures = [];
  const rules = [
    {
      name: '§1.3 版图表',
      rows: parseSpanTable(lines, '### 1.3', '**上表互不重叠', /^\|\s*(?:\*\*)?(\d+)[–-](\d+)(?:\*\*)?\s*\|\s*(?:\*\*)?(\d+)(?:\*\*)?\s*\|/),
      maxCount: Infinity,
    },
    {
      name: '§5.1 目标段表',
      rows: parseSpanTable(lines, '**阶段 2 的目标段划分', '合计 12593 行', /^\|\s*`[^`]+`\s*\|\s*(\d+)[–-](\d+)\s*\|\s*(\d+)\s*\|/),
      maxCount: 1200,
    },
  ];
  for (const rule of rules) {
    const { name, rows, maxCount } = rule;
    if (rows.length === 0) {
      failures.push(`${name}: 没解析到任何行（表格结构变了？）`);
      continue;
    }
    for (const row of rows) {
      if (row.to - row.from + 1 !== row.count) {
        failures.push(`${name}: ${row.from}–${row.to} 标称 ${row.count} 行，实为 ${row.to - row.from + 1} 行`);
      }
      if (row.count > maxCount) {
        failures.push(`${name}: ${row.from}–${row.to} 有 ${row.count} 行，超过上限 ${maxCount}`);
      }
    }
    for (let k = 0; k + 1 < rows.length; k += 1) {
      if (rows[k].to + 1 !== rows[k + 1].from) {
        failures.push(`${name}: ${rows[k].to} 与 ${rows[k + 1].from} 之间不连续（有空隙或重叠）`);
      }
    }
    if (rows[0].from !== 1) failures.push(`${name}: 首行是 ${rows[0].from}，应为 1`);
    if (rows[rows.length - 1].to !== 12593) failures.push(`${name}: 末行是 ${rows[rows.length - 1].to}，应为 12593`);
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    if (total !== 12593) failures.push(`${name}: 行数合计 ${total}，应为 12593`);
    process.stdout.write(`  table ${name}: rows=${rows.length} 合计=${total} 最大段=${Math.max(...rows.map((r) => r.count))}\n`);
  }
  // g-077：§5.1 的**段名集合**（含顺序）必须与磁盘 `src/` 的段名集合一致 —— 不再经过
  // 任何手工常量（g-076 那份段名常量已在 g-077 删除）。发布门 `CLIENT-SRC-DRIFT` 锚的是
  // 「段 ↔ 产物逐字节一致」，文档这一侧锚的是磁盘段名：两边都锚在真实文件上，中间没有
  // 需要人手同步的清单。
  const documented = parseSegmentNames(lines);
  if (documented.length === 0) {
    failures.push('§5.1 目标段表: 没解析到任何段名（表格第一列的结构变了？）');
  } else {
    let onDisk = null;
    try {
      onDisk = segmentNames(readdirSync(join(PACKAGE_DIR, CLIENT_SRC_DIR))).map((segment) => segment.name);
    } catch (error) {
      failures.push(`${CLIENT_SRC_DIR}/ 的段名读不到：${error instanceof Error ? error.message : String(error)}`);
    }
    if (onDisk !== null) {
      if (documented.join('\n') !== onDisk.join('\n')) {
        const missing = onDisk.filter((name) => !documented.includes(name));
        const extra = documented.filter((name) => !onDisk.includes(name));
        const detail = missing.length > 0 || extra.length > 0
          ? `文档缺 ${missing.join('、') || '(无)'}；文档多出 ${extra.join('、') || '(无)'}`
          : `段名相同但顺序不同：文档 ${documented.join(',')} ≠ 磁盘 ${onDisk.join(',')}`;
        failures.push(`§5.1 目标段表的段名集合与磁盘 ${CLIENT_SRC_DIR}/ 不符（${detail}）`);
      } else {
        process.stdout.write(`  table §5.1 段名集合: 与磁盘 ${CLIENT_SRC_DIR}/ 一致（${documented.length} 段）\n`);
      }
    }
  }
  return failures;
}

/**
 * 统计**收集域之外**的裸行号形态（g-079 项 2b）。
 *
 * 收集域只认 `文件:行` / `文件:行-行` / 简写 `:行`；文档里另有三类裸数字引用逃过
 * 体检：① 行内代码里的纯行号（`` `2313` ``）；② 括号裸行号（`（212）`、
 * `（185–198）`）；③ 裸区间（`1–106`、`185–198`）。本函数**只计数、不判内容**：
 * 裸数字不带文件名，脚本无法凭空断言它指哪个文件的哪一行。
 *
 * **"不判"不等于"静默吞掉"**：输出里给出显式条数，`--verbose` 逐条列出，人工核对
 * 有清单可循。§1.3/§5.1 两张表的行区间已由 {@link checkTables} 按行数/连续性复算，
 * 因此从"未覆盖"里单列扣除（`tableCovered`），避免把已检查过的数字算成缺口。
 *
 * 已知边界（如实）：裸区间里混有行数估算（如「加 30–80 行」）与尺寸数字，脚本不区分
 * 语义；计数是**上界**，只保证"没有静默吞掉"，不冒充"这些都是文件行号引用"。
 * @param doc - 文档全文。
 * @returns `{codeBare, paren, range, tableCovered}`，前三个是 `{line, text}[]`。
 */
function countUncoveredRefs(doc) {
  const lines = doc.split('\n');
  const codeBare = [];
  const paren = [];
  const range = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // 已覆盖的 `文件:行` / `:行` 先从文本里剔除，避免与裸形态重复计数。
    let text = raw
      .replace(/[A-Za-z0-9_./-]+\.(?:js|mjs|json|md):\d+(?:-\d+)?/g, ' ')
      .replace(/:\d+(?:-\d+)?/g, ' ');
    // ① 行内代码里的纯行号 / 纯区间（`2313`、`115–11877`）。`0` 是数值不是行号，排除。
    for (const match of text.matchAll(/`\s*(\d{1,6}(?:\s*[–-]\s*\d{1,6})?)\s*`/g)) {
      if (Number(match[1].split(/[–-]/)[0]) >= 1) codeBare.push({ line: index + 1, text: match[0].trim() });
    }
    text = text.replace(/`\s*\d{1,6}(?:\s*[–-]\s*\d{1,6})?\s*`/g, ' ').replace(/`/g, ' ');
    // `§9-3` 是章节号，不是行区间。
    text = text.replace(/§\s*\d+(?:[–-]\d+)?/g, '§');
    // ② 括号裸行号。全角 `（）` 是中文行文里的引用写法，一律计数；半角 `()` 只在
    // 左括号前不紧邻标识符时计数，排除 `scrimStyle(1200)` 这种函数实参。
    for (const match of text.matchAll(/[（]\s*(\d{1,6}(?:\s*[–-]\s*\d{1,6})?)\s*[）]/g)) {
      paren.push({ line: index + 1, text: match[0].trim() });
    }
    for (const match of text.matchAll(/(?<![\w.])\(\s*(\d{1,6}(?:\s*[–-]\s*\d{1,6})?)\s*\)/g)) {
      paren.push({ line: index + 1, text: match[0].trim() });
    }
    // ③ 裸区间（en dash / hyphen）；排除日期（`2026-10-17` 的连字符被两侧规则挡住）。
    for (const match of text.matchAll(/(?<![\w:./#-])(\d{1,6})\s*[–-]\s*(\d{1,6})(?![\w-])/g)) {
      range.push({ line: index + 1, text: match[0] });
    }
  }
  // §1.3 的行区间在第 1 列、§5.1 的在第 2 列 —— 这两列正是 checkTables 复算覆盖的列。
  const countCellRanges = (startPrefix, endPrefix, cellIndex) => {
    const start = lines.findIndex((line) => line.startsWith(startPrefix));
    const end = lines.findIndex((line, at) => at > start && line.startsWith(endPrefix));
    let count = 0;
    for (const line of lines.slice(start, end === -1 ? undefined : end)) {
      const cells = line.split('|');
      const cell = cells[cellIndex + 1];
      if (cell === undefined) continue;
      for (const _ of cell.matchAll(/\d{1,6}\s*[–-]\s*\d{1,6}/g)) count += 1;
    }
    return count;
  };
  const tableCovered = countCellRanges('### 1.3', '**上表互不重叠', 0)
    + countCellRanges('**阶段 2 的目标段划分', '合计 12593 行', 1);
  return { codeBare, paren, range, tableCovered };
}

/** 主流程：文档引用体检 + 两张表复算。 */
function main() {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const { declared, unowned } = collectRefs(doc);
  const table = new Map(REFS.map((entry) => [entry.ref, entry]));

  const failures = [...checkTables(doc.split('\n'))];
  const manualList = [];
  const rangeOnlyList = [];
  let verified = 0;
  let rangeOnly = 0;
  let manual = 0;
  // **引用级**失败（进恒等式）。表格复算 / `REFS\declared` 的失败是另一类，单独报数：
  // 混在一起会让恒等式在表格坏掉时假红、在引用被静默丢弃时假绿。
  let unresolved = 0;

  // ① 文档里出现、且期望表也有的引用 —— 这才是"文档引用被验证"的条数
  for (const [key, meta] of declared) {
    const entry = table.get(key);
    if (entry === undefined) {
      // ② 期望表没有的引用：包内可读 + 行号合法 = 最小验证；否则 FAIL（fail-closed）
      const lines = linesOf(meta.file);
      if (lines === null) {
        if (isOutOfRepo(meta.file)) {
          manual += 1;
          manualList.push(key);
        } else {
          failures.push(`${key}: 包内读不到该文件（fail-closed）`);
          unresolved += 1;
        }
        continue;
      }
      const last = meta.to ?? meta.from;
      if (meta.from < 1 || last > lines.length) {
        failures.push(`${key}: 行号越界（${meta.file} 实有 ${lines.length} 行）（fail-closed）`);
        unresolved += 1;
        continue;
      }
      rangeOnly += 1;
      rangeOnlyList.push(key);
      continue;
    }
    const result = checkExpectation(entry);
    if (result.ok) {
      verified += 1;
    } else {
      failures.push(result.detail);
      unresolved += 1;
    }
  }

  // ③ 归属失败的简写引用：一律 unresolved ⇒ 失败（fail-closed）
  for (const raw of unowned) {
    failures.push(`${raw}: 无法归属到具体文件（fail-closed）`);
    unresolved += 1;
  }

  // ④ 期望表里文档中并不存在的条目：独立校验，但**不计入覆盖率**
  const notDeclared = REFS.filter((entry) => !declared.has(entry.ref));
  let notDeclaredOk = 0;
  for (const entry of notDeclared) {
    const result = checkExpectation(entry);
    if (result.ok) notDeclaredOk += 1;
    else failures.push(`[REFS\\declared] ${result.detail}`);
  }

  // ⑤ 恒等式 = **真实失败判定**（g-079 项 2a）。它抓的是"某条引用被静默丢弃"：
  // 任何一条 `continue` 只要没落进 verified/rangeOnly/manual/unresolved 四类之一，等式就破。
  const total = declared.size + unowned.length;
  const identitySum = verified + rangeOnly + manual + unresolved;
  const identityHolds = total === identitySum;
  if (!identityHolds) {
    failures.push(
      `恒等式不成立：total=${total} ≠ verified+rangeOnly+manual+unresolved=`
      + `${verified}+${rangeOnly}+${manual}+${unresolved}=${identitySum}（有引用被静默丢弃或重复计数）`,
    );
  }

  // ⑥ 收集域下限（返工 U4）：恒等式只保证「计数自洽」，抓不到**收集域整体失效** ——
  // 评审实测：注释掉 `file:line` 分支的 `declared.set` 后，total 从 153 掉到 62，
  // 四个计数仍然自洽、恒等式仍「成立」、脚本 exit 0，等于收集器坏了而体检全绿。
  // 文档引用规模是稳定的（基线 153 条），所以加一条下限：total < 100 ⇒ 失败。
  // 阈值 100 的理由：基线 153、收集域塌掉后 62；取 100 既容得下文档正常的增删
  // （几十条级别），又不给「整体失效」留活口。
  const MIN_DOC_REFS = 100;
  if (total < MIN_DOC_REFS) {
    failures.push(
      `收集域可能失效：只收集到 ${total} 条引用（下限 ${MIN_DOC_REFS}）`
      + '—— 检查 collectRefs 的 `file:line` / `:line` 分支是否被改坏',
    );
  }
  const otherFailures = failures.length - unresolved;

  // ⑦ 收集域之外的裸行号形态：显式可数，不静默吞掉（g-079 项 2b）。
  const uncovered = countUncoveredRefs(doc);
  const uncoveredTotal = uncovered.codeBare.length + uncovered.paren.length + uncovered.range.length;
  const uncoveredManual = uncoveredTotal - uncovered.tableCovered;

  process.stdout.write(
    `\ncheck-refs: 文档引用 total=${total} | verified=${verified} | rangeOnly=${rangeOnly} `
    + `| manual=${manual} | unresolved=${unresolved} | 其它失败（表格/孤儿期望）=${otherFailures}\n`,
  );
  process.stdout.write(
    `check-refs: REFS 表 ${REFS.length} 条 → REFS∩declared=${REFS.length - notDeclared.length}`
    + `（计入覆盖率，其中 verified=${verified}） / REFS\\declared=${notDeclared.length}`
    + `（未被收集器识别的写法：裸行号 / 不同区间写法等，不计入覆盖率；其中 ${notDeclaredOk} 条独立校验通过）\n`,
  );
  process.stdout.write(
    `check-refs: 恒等式 total == verified + rangeOnly + manual + unresolved = `
    + `${total} == ${verified} + ${rangeOnly} + ${manual} + ${unresolved} → `
    + `${identityHolds ? '成立' : '不成立（已计入失败，非零退出）'}\n`,
  );
  process.stdout.write(
    `check-refs: 未覆盖的引用形态：${uncoveredTotal} 处（行内代码裸行号 ${uncovered.codeBare.length}`
    + ` / 括号裸行号 ${uncovered.paren.length} / 裸区间 ${uncovered.range.length}）`
    + `—— 收集域只认 文件:行 / 文件:行-行 / :行；其中 ${uncovered.tableCovered} 处是 §1.3/§5.1 的区间列`
    + `（已由行数复算覆盖），其余 ${uncoveredManual} 处仅计数、不判内容（--verbose 逐条列出）\n`,
  );
  // 弱断言披露：能收紧的已在 REFS 表里收紧；仍带 `weakReason` 的逐条打印理由。
  const weak = REFS.filter((entry) => entry.weakReason !== undefined);
  process.stdout.write(`check-refs: 弱断言披露：${weak.length} 条（能收紧的已收紧，以下为只能弱断言的理由）\n`);
  for (const entry of weak) process.stdout.write(`  weak ${entry.ref}：${entry.weakReason}\n`);
  for (const key of manualList) process.stdout.write(`  manual ${key}（仓库外路径，需人工核对）\n`);
  if (process.argv.includes('--verbose')) {
    for (const key of rangeOnlyList) process.stdout.write(`  rangeOnly ${key}（包内可读 + 行号合法，但期望表无符号断言）\n`);
    const details = [...uncovered.codeBare, ...uncovered.paren, ...uncovered.range]
      .sort((left, right) => left.line - right.line || left.text.localeCompare(right.text));
    for (const hit of details) process.stdout.write(`  uncovered ${hit.line}: ${hit.text}\n`);
  }

  if (failures.length > 0) {
    process.stdout.write('\n不符项（修文档或修期望值；**不要弱化断言**）：\n');
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
    process.exitCode = 1;
    return 1;
  }
  process.stdout.write('check-refs: 文档引用的可自动判定部分全部成立；manual 项请人工核对\n');
  return 0;
}

main();

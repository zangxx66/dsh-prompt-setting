/**
 * Client-source assertions (`scripts/client-build.mjs`, g-075 阶段 1 + 阶段 2).
 *
 * 阶段 1 的意义是一个等式：**`src/` 渲染出来的东西 == 今天的 `client.js`**，逐字节。
 * 阶段 2 加了一行头注，于是等式升级成更强的一条：**`src/` 渲染出来的东西去掉头注后
 * == 阶段 1 的产物**，仍然逐字节。后者同时证明「段边界只在连续区间内部换了切点、
 * 一行代码都没移动」（方案 §5.2 阶段 2 判据 2），因为任何一次搬迁都会让某个字节
 * 落在不同的相对位置上，等号立刻破裂。所以这里按证据强度分四层：
 *   1. **逐字节**：`stripBanner(renderClient())` == 段真源坐标下的 `client.js`，
 *      且每段等于 §5.1 表里那个区间的行切片（零移动的机器证明）；
 *   2. **结构**：17 段一一对应 §5.1 的 17 个连续区间、每段 ≤ 1200 行、字典序 ==
 *      代码顺序、段间不插分隔符、无 CR、末尾换行一致、行数合计 12382；
 *   3. **头注**：它是纯前缀、在 fingerprint `begin` 之前、**不进指纹**（hash/size
 *      与去头注后完全相同），而且磁盘上的 `client.js` 真的带着它；
 *   4. **负向对照**：在一次性包目录里改一行 `src/`（或只改 `client.js`）之后
 *      `--check` 必须非零退出 —— 否则上面的「等价」只是没人验证过的巧合。
 *
 * 门禁三态（N/A / FILES / NOT-SHIPPED）在本文件里用注入的 `listDir` 做纯函数覆盖；
 * 它在真实发布路径上的行为由 `test/prepare.test.mjs` 端到端覆盖。
 *
 * Run: `node --test`
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FINGERPRINT_BEGIN, fingerprintOf } from '../core/build.js';
import { PREPARE_FAIL, PREPARE_OK } from '../core/prepare.js';
import { clientChunkStamps } from '../core/store.js';
import {
  CLIENT_SRC_DIR,
  GENERATED_BANNER,
  SEGMENT_DECLARATION,
  concatSegments,
  inspectClientSource,
  readSegments,
  renderClient,
  segmentNames,
  stripBanner,
  stripDeclaration,
} from '../scripts/client-build.mjs';
import { readDeclaredStamps, sameStamps, writeDeclaredStamps } from '../scripts/client-chunks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
/** 包根目录 —— 生成物、真源段、清单脚本都住在这里。 */
const packageDir = join(here, '..');
const CLIENT_PATH = join(packageDir, 'client.js');
const clientSource = readFileSync(CLIENT_PATH, 'utf8');
const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));

/**
 * §5.1 目标段表的 17 个连续区间，**写死在这里**（与文档表格逐个数字对应）。
 *
 * 这份表刻意不从 `src/` 派生：它要能发现「段边界被改动」，而派生出来的表永远同意
 * 自己。列出的顺序就是代码顺序，也就是文件名字典序。
 */
const SEGMENTS = [
  [1, 215, '00-entry.js'],
  [216, 902, '01-shared-head.js'],
  [903, 2085, '02-locale.js'],
  [2086, 2687, '03-facilities.js'],
  [2688, 3338, '04-helpers-a.js'],
  [3339, 3943, '05-helpers-b.js'],
  [3944, 4608, '06-tree.js'],
  [4609, 5255, '07-stage2.js'],
  [5256, 5997, '08-chrome-a.js'],
  [5998, 6786, '09-chrome-b.js'],
  [6787, 7774, '10-toaster-mine.js'],
  [7775, 8385, '11-chunks.js'],
  [8386, 9026, '12-update.js'],
  [9027, 10226, '13-page-a.js'],
  [10227, 11424, '14-page-b.js'],
  [11425, 12026, '15-page-c.js'],
  [12027, 12382, '16-boot.js'],
];

/**
 * 段真源坐标下的 `client.js`：磁盘产物去掉生成物头注。
 *
 * 文档里的 `client.js:行` 引用、§1.3/§5.1 两张表、以及每个段文件的区间，全部记在这
 * 个坐标系里 —— 头注由生成器注入、不属于任何段，所以「无头注」才是稳定坐标。
 */
const clientBody = stripBanner(clientSource);
/** `clientBody` 的实际行（末尾换行不产生一行）。 */
const clientLines = clientBody.split('\n');

/** 一个一次性包目录：只放 `client-build.mjs` 读得到的东西。 */
function throwawayPackage() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-client-build-'));
  for (const dir of ['core', 'scripts', CLIENT_SRC_DIR]) {
    cpSync(join(packageDir, dir), join(root, dir), { recursive: true });
  }
  for (const name of readdirSync(packageDir)) {
    if (name === 'client.js' || /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(name)) {
      cpSync(join(packageDir, name), join(root, name));
    }
  }
  return root;
}

/** 在包目录里跑一次生成器。 */
function runBuild(root, ...flags) {
  return spawnSync(process.execPath, ['scripts/client-build.mjs', ...flags], { cwd: root, encoding: 'utf8' });
}

test('client source: src/ renders the shipped client.js byte for byte', () => {
  const segments = readSegments();
  assert.equal(segments.length, SEGMENTS.length);
  assert.equal(renderClient(), clientSource, '生成物（含头注）必须与磁盘上的 client.js 逐字节相同');
  // 头注是唯一多出来的东西：剥掉它，剩下的就是段真源坐标下的 client.js。
  assert.equal(stripBanner(renderClient()), clientBody);
  // 声明行不进产物，段间也不插分隔符 —— 所以拼接结果与「去掉头注的产物」逐字节相同。
  assert.equal(concatSegments(segments), clientBody);
  // 阶段 2 的「全有或全无」在这里是正面：每个段都必须带声明行。
  for (const segment of segments) {
    assert.equal(segment.declares, true, `${segment.name} 缺段首声明行`);
  }
});

test('client source: every segment is its §5.1 region, in code order and with no gaps', () => {
  const segments = readSegments();
  assert.deepEqual(
    segments.map((segment) => segment.name),
    SEGMENTS.map((segment) => segment[2]),
    '文件名字典序必须就是 §5.1 目标段表的区间顺序',
  );
  let consumed = 0;
  for (const [position, segment] of SEGMENTS.entries()) {
    const [from, to, name] = segment;
    const read = segments[position];
    assert.equal(read.index, position, `${name} 的两位前缀必须是它的段序号`);
    assert.equal(read.lines, to - from + 1, `${name} 的行数`);
    assert.ok(read.lines <= 1200, `${name} 有 ${read.lines} 行，超过 1200 行预算（阶段 2 判据 3）`);
    // 零移动的机器证明：这一段去掉声明行之后，就是 client.js 里那几行，一行不差。
    assert.equal(
      stripDeclaration(read.text),
      `${clientLines.slice(from - 1, to).join('\n')}\n`,
      `${name} ≠ client.js:${from}-${to}（段边界被改动，或代码被搬动）`,
    );
    // 声明行不进产物 ⇒ 段在生成物中的偏移就是区间本身：单调递增且无空隙（判据 3）。
    assert.equal(consumed, from - 1, `${name} 与上一段之间有空隙或重叠`);
    consumed += read.lines;
  }
  assert.equal(consumed, clientLines.length - 1, '段必须恰好铺满 12382 行');
  assert.equal(consumed, 12382);
});

test('client source: the generated banner is a pure prefix outside the fingerprint region', () => {
  const bannerLines = GENERATED_BANNER.split('\n').length - 1;
  assert.ok(bannerLines >= 8 && bannerLines <= 15, `头注 ${bannerLines} 行，应落在 8–15 行（方案 §9-4）`);
  assert.equal(GENERATED_BANNER.endsWith('\n'), true, '头注必须以换行结束，否则剥离后粘连第一行');
  // 磁盘上的 client.js 真的带着它（而不是「生成器会加、产物里却没有」）。
  assert.equal(clientSource.startsWith(GENERATED_BANNER), true, 'client.js 顶部就是生成物头注');
  assert.notEqual(clientBody, clientSource, '头注必须真的改变了字节，否则阶段 2 的头注没落地');
  assert.equal(stripBanner(clientSource.slice(GENERATED_BANNER.length)), clientBody, '剥离是精确的逆');
  assert.equal(stripBanner(clientBody), clientBody, '没有头注时是恒等操作（阶段 1 的实况）');
  // 判据 3：头注落在 fingerprint begin 标记之前。
  assert.ok(
    clientSource.indexOf(GENERATED_BANNER) < clientSource.indexOf(FINGERPRINT_BEGIN),
    '头注必须在 build-fingerprint begin 之前，否则它会进指纹',
  );
  // 不污染指纹（方案 §5.2 R1-1 实测口径）：含头注与去头注的 hash/size 必须完全相同。
  assert.deepEqual(fingerprintOf(clientSource), fingerprintOf(clientBody), '头注不得移动构建摘要');
});

test('client source: concatenation inserts no separator, no CR, and keeps the trailing newline', () => {
  for (const segment of readSegments()) {
    assert.equal(segment.text.includes('\r'), false, `${segment.name} 含 CR`);
    assert.equal(segment.text.endsWith('\n'), true, `${segment.name} 末尾缺换行`);
  }
  assert.equal(clientSource.includes('\r'), false, 'client.js 是纯 LF');
  assert.equal(clientBody.endsWith('});\n'), true, '末字节仍是 `});\\n`');
  assert.equal(clientBody.endsWith('\n\n'), false);
});

test('client source: the segment order still satisfies the two order-sensitive assertions', () => {
  // 方案 §5.2「段序敏感」：`test/client.test.mjs:2538-2542` 断言 `renderConfirm` 的
  // scrim 在 `renderRegionDialog` 之前（1200 先于 1000）。只重切、不移动 ⇒ 天然满足；
  // 这道断言就是「谁把这两个块搬反了」的机器证明。
  assert.ok(
    clientBody.indexOf('function renderConfirm') < clientBody.indexOf('function renderRegionDialog'),
    'renderConfirm 必须在 renderRegionDialog 之前',
  );
  assert.ok(clientBody.indexOf('scrimStyle(1200)') < clientBody.indexOf('scrimStyle(1000)'));
});

test('client source: the CHUNK_STAMPS manifest is already in sync (the generator is idempotent)', () => {
  // 方案 §5.2 判据 5：正常状态下 --write 的产物与磁盘逐字节相同 ⇒ git diff 为空、
  // mtime 不变（§8-R5 的页面重载噪音由此消失）。清单块在段内，所以幂等式在段真源
  // 坐标下成立；头注只是前缀，不参与重算。
  const stamps = clientChunkStamps(packageDir);
  assert.equal(writeDeclaredStamps(clientBody, stamps), clientBody);
  assert.equal(sameStamps(readDeclaredStamps(clientBody), stamps), true);
  assert.equal(renderClient(), GENERATED_BANNER + writeDeclaredStamps(concatSegments(readSegments()), stamps));
});

test('client source: line budget — stage 2 converges to §5.1, so no segment exceeds 1200', () => {
  const segments = readSegments();
  const over = segments.filter((segment) => segment.lines > 1200).map((segment) => `${segment.name}:${segment.lines}`);
  // 阶段 1 超预算的三个（12-helpers/15-chrome/21-page）必须在这里消失。
  assert.deepEqual(over, [], `仍有超预算段：${over.join('、')}`);
  assert.equal(segments.length, 17, '阶段 2 的段数（§5.1 目标段表）');
  assert.equal(segments.reduce((sum, segment) => sum + segment.lines, 0), 12382);
  assert.equal(Math.max(...segments.map((segment) => segment.lines)), 1200, '最大段应恰为 §5.1 的 13-page-a');
});

test('client source: the manifest ships src/ and wires the two build scripts', () => {
  assert.ok(packageJson.files.includes(CLIENT_SRC_DIR), 'src/ 必须随包发布（真源要能随安装到达用户机器）');
  assert.equal(packageJson.scripts['client:build'], 'node scripts/client-build.mjs --write');
  assert.equal(packageJson.scripts['client:check'], 'node scripts/client-build.mjs --check');
});

test('client source: segment names are the order, and unusable names are refused', () => {
  assert.deepEqual(
    segmentNames(['02-b.js', '00-a.js', '01-c.js']).map((segment) => segment.name),
    ['00-a.js', '01-c.js', '02-b.js'],
  );
  // 非 .js 条目（说明文档等）不参与拼接。
  assert.deepEqual(segmentNames(['00-a.js', 'README.md', 'notes.txt']).map((segment) => segment.name), ['00-a.js']);
  // 形状不对的段名一律拒绝：静默跳过会让生成物少一段，而 --check 只能报"不一致"。
  assert.throws(() => segmentNames(['0-a.js']), /命名/);
  assert.throws(() => segmentNames(['00-A.js']), /命名/);
  assert.throws(() => segmentNames(['helpers.js']), /命名/);
  assert.throws(() => segmentNames(['00-a.js', '00-b.js']), /重复/);
  // 真包的段名本身就是顺序，且与 §5.1 表一致（不靠一份手工清单）。
  assert.deepEqual(
    segmentNames(readdirSync(join(packageDir, CLIENT_SRC_DIR))).map((segment) => segment.name),
    SEGMENTS.map((segment) => segment[2]),
  );
});

test('client source: the stage-2 declaration line is stripped, and a half-declared set is refused', () => {
  const plain = 'a();\n';
  assert.equal(stripDeclaration(plain), plain, '没有声明行时是恒等操作');
  assert.equal(stripDeclaration(`${SEGMENT_DECLARATION}\na();\n`), plain);
  assert.throws(() => stripDeclaration(`${SEGMENT_DECLARATION} a();\n`), /独占一行/);
  assert.equal(
    concatSegments([
      { name: '00-a.js', text: `${SEGMENT_DECLARATION}\na();\n` },
      { name: '01-b.js', text: 'b();\n' },
    ]),
    'a();\nb();\n',
    '声明不进产物，且段间仍不插分隔符',
  );
  const declaredDir = () => ['00-a.js', '01-b.js'];
  const mixed = {
    readDir: declaredDir,
    read: (relPath) => (relPath.endsWith('00-a.js') ? `${SEGMENT_DECLARATION}\na();\n` : 'b();\n'),
  };
  assert.throws(() => readSegments(packageDir, mixed), /全有或全无/);
  const uniform = {
    readDir: declaredDir,
    read: (relPath) => `${SEGMENT_DECLARATION}\n${relPath.includes('00') ? 'a();' : 'b();'}\n`,
  };
  assert.equal(concatSegments(readSegments(packageDir, uniform)), 'a();\nb();\n');
});

test('client source: the publish gate is tri-state (N/A / FILES / NOT-SHIPPED)', () => {
  const files = ['index.js', 'core', 'client.js', 'client.*.js', 'locale', 'scripts'];
  const shipped = [...files, CLIENT_SRC_DIR];
  const realDir = () => readdirSync(join(packageDir, CLIENT_SRC_DIR));

  // N/A：既没目录也没声明 ⇒ 通过（合法的无 src 包，例如最小 fixture 包）。
  const nA = inspectClientSource(files, { listDir: () => null });
  assert.equal(nA.level, PREPARE_OK);
  assert.equal(nA.code, 'CLIENT-SRC-N/A');

  // FILES：声明了但目录不在（或目录里没有可用段文件）⇒ FAIL。
  for (const listing of [() => null, () => [], () => ['README.md'], () => ['helpers.js'], () => ['00-a.js', '00-b.js']]) {
    const finding = inspectClientSource(shipped, { listDir: listing });
    assert.equal(finding.level, PREPARE_FAIL);
    assert.equal(finding.code, 'CLIENT-SRC-FILES');
  }

  // NOT-SHIPPED：段在，但 files 白名单不覆盖 ⇒ FAIL（安装时会被裁掉）。
  const notShipped = inspectClientSource(files, { listDir: realDir });
  assert.equal(notShipped.level, PREPARE_FAIL);
  assert.equal(notShipped.code, 'CLIENT-SRC-NOT-SHIPPED');

  // 真包：段在、也声明了 ⇒ ok，且段数与 §5.1 目标段表一致。
  const ok = inspectClientSource(packageJson.files, { listDir: realDir });
  assert.equal(ok.level, PREPARE_OK);
  assert.equal(ok.code, 'CLIENT-SRC');
  assert.match(ok.message, /17 个段文件/);
});

test('client build --check: a healthy copy is green, and one edited src/ line is red', () => {
  const root = throwawayPackage();
  try {
    const healthy = runBuild(root, '--check');
    assert.equal(healthy.status, 0, `副本本身必须是绿的\n${healthy.stdout}\n${healthy.stderr}`);

    const relPath = join(CLIENT_SRC_DIR, '12-update.js');
    const text = readFileSync(join(root, relPath), 'utf8');
    assert.equal(text.startsWith(SEGMENT_DECLARATION), true, '段首声明必须在第 1 行');
    writeFileSync(join(root, relPath), text.replace('\n', '\n// one edited line\n'));
    const edited = runBuild(root, '--check');
    assert.notEqual(edited.status, 0, `改了 src/ 却通过了\n${edited.stdout}`);
    assert.match(edited.stderr, /不一致/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('client build --check: editing the generated client.js alone is red too', () => {
  const root = throwawayPackage();
  try {
    const target = join(root, 'client.js');
    writeFileSync(target, readFileSync(target, 'utf8').replace('\n', '\n// hand-edited generated file\n'));
    const run = runBuild(root, '--check');
    assert.notEqual(run.status, 0, `手改生成物却通过了\n${run.stdout}`);
    assert.match(run.stderr, /不一致/);
    // 头注落在第一行：任何手改都会先撞上它，而不是撞上别的东西。
    assert.equal(readFileSync(join(root, 'client.js'), 'utf8').split('\n')[0], GENERATED_BANNER.split('\n')[0]);
    assert.equal(readFileSync(join(root, CLIENT_SRC_DIR, '00-entry.js'), 'utf8').startsWith(SEGMENT_DECLARATION), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

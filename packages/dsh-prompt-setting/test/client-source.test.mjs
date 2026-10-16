/**
 * Client-source assertions (`scripts/client-build.mjs`, g-075 阶段 1).
 *
 * 阶段 1 的全部意义是一个等式：**`src/` 渲染出来的东西 == 今天的 `client.js`**，
 * 逐字节。等号成立，则这次改动对产品零影响（指纹、chunk 协议、DOM marker 都没动），
 * 不等号成立，则不管别的检查多绿都不能发布。所以这里按证据强度分三层：
 *   1. **逐字节**：`renderClient()` 与磁盘 `client.js` 相等，且每段等于 §1.3 的
 *      同名行切片（零移动的机器证明）；
 *   2. **结构**：24 段一一对应 §1.3 的 24 个连续区间、字典序 == 代码顺序、
 *      段间不插分隔符、无 CR、末尾换行一致、行数合计 12382；
 *   3. **负向对照**：在一次性包目录里改一行 `src/`（或只改 `client.js`）之后
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

import { PREPARE_FAIL, PREPARE_OK } from '../core/prepare.js';
import { clientChunkStamps } from '../core/store.js';
import {
  CLIENT_SRC_DIR,
  SEGMENT_DECLARATION,
  concatSegments,
  inspectClientSource,
  readSegments,
  renderClient,
  segmentNames,
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
 * §1.3 版图的 24 个连续区间，**写死在这里**。
 *
 * 这份表刻意不从 `src/` 派生：它要能发现「段边界被改动」，而派生出来的表永远同意
 * 自己。列出的顺序就是代码顺序，也就是文件名字典序。
 */
const REGIONS = [
  [1, 106, '00-header.js'],
  [107, 114, '01-register.js'],
  [115, 183, '02-build-stamp.js'],
  [184, 198, '03-guard.js'],
  [199, 215, '04-build-plugin.js'],
  [216, 297, '05-launch.js'],
  [298, 632, '06-primitives.js'],
  [633, 902, '07-constants.js'],
  [903, 2085, '08-locale.js'],
  [2086, 2153, '09-facilities.js'],
  [2154, 2277, '10-atoms.js'],
  [2278, 2687, '11-ui.js'],
  [2688, 3943, '12-helpers.js'],
  [3944, 4471, '13-tree.js'],
  [4472, 5255, '14-stage2.js'],
  [5256, 6786, '15-chrome.js'],
  [6787, 7156, '16-toaster.js'],
  [7157, 7774, '17-mine.js'],
  [7775, 8385, '18-chunks.js'],
  [8386, 9026, '19-update.js'],
  [9027, 9040, '20-page-doc.js'],
  [9041, 12026, '21-page.js'],
  [12027, 12038, '22-failure-doc.js'],
  [12039, 12382, '23-boot.js'],
];

/** `client.js` 的实际行（末尾换行不产生一行）。 */
const clientLines = clientSource.split('\n');

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
  assert.equal(segments.length, REGIONS.length);
  assert.equal(renderClient(), clientSource, '生成物必须与磁盘上的 client.js 逐字节相同（阶段 1 的唯一验收门）');
  // 不剥离、不加工也相同：阶段 1 的段没有声明行，拼接是纯 concat。
  assert.equal(segments.map((segment) => segment.text).join(''), clientSource);
  assert.equal(concatSegments(segments), clientSource);
});

test('client source: every segment is its §1.3 region, in code order and with no gaps', () => {
  const segments = readSegments();
  assert.deepEqual(
    segments.map((segment) => segment.name),
    REGIONS.map((region) => region[2]),
    '文件名字典序必须就是 §1.3 的区间顺序',
  );
  let consumed = 0;
  for (const [position, region] of REGIONS.entries()) {
    const [from, to, name] = region;
    const segment = segments[position];
    assert.equal(segment.index, position, `${name} 的两位前缀必须是它的段序号`);
    assert.equal(segment.lines, to - from + 1, `${name} 的行数`);
    // 零移动的机器证明：这一段就是 client.js 里那几行，一行不差、一字不改。
    assert.equal(segment.text, `${clientLines.slice(from - 1, to).join('\n')}\n`, `${name} ≠ client.js:${from}-${to}`);
    assert.equal(consumed, from - 1, `${name} 与上一段之间有空隙或重叠`);
    consumed += segment.lines;
  }
  assert.equal(consumed, clientLines.length - 1, '段必须恰好铺满 12382 行');
  assert.equal(consumed, 12382);
});

test('client source: concatenation inserts no separator, no CR, and keeps the trailing newline', () => {
  for (const segment of readSegments()) {
    assert.equal(segment.text.includes('\r'), false, `${segment.name} 含 CR`);
    assert.equal(segment.text.endsWith('\n'), true, `${segment.name} 末尾缺换行`);
  }
  assert.equal(clientSource.includes('\r'), false, 'client.js 是纯 LF');
  assert.equal(clientSource.endsWith('});\n'), true, '末字节仍是 `});\\n`');
  assert.equal(clientSource.endsWith('\n\n'), false);
});

test('client source: the CHUNK_STAMPS manifest is already in sync (the generator is idempotent)', () => {
  // 方案 §5.2 判据 5：正常状态下 --write 的产物与磁盘逐字节相同 ⇒ git diff 为空、
  // mtime 不变（§8-R5 的页面重载噪音由此消失）。
  const stamps = clientChunkStamps(packageDir);
  assert.equal(writeDeclaredStamps(clientSource, stamps), clientSource);
  assert.equal(sameStamps(readDeclaredStamps(clientSource), stamps), true);
  assert.equal(renderClient(), writeDeclaredStamps(concatSegments(readSegments()), stamps));
});

test('client source: line budget — stage 1 keeps §1.3, so exactly three regions exceed 1200', () => {
  const over = readSegments()
    .filter((segment) => segment.lines > 1200)
    .map((segment) => `${segment.name}:${segment.lines}`);
  // 阶段 1 的段边界照抄 §1.3（不做任何重排），因此超预算段是已知的三个。
  // 阶段 2 把段收敛到 17 段（每段 ≤1200）之后，这个数组必须变成空的 —— 它是阶段 2
  // 的扳机：谁忘了重排，这里先红。
  assert.deepEqual(over, ['12-helpers.js:1256', '15-chrome.js:1531', '21-page.js:2986']);
  assert.equal(readSegments().reduce((sum, segment) => sum + segment.lines, 0), 12382);
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
});

test('client source: the stage-2 declaration line is stripped, and a half-declared set is refused', () => {
  const plain = 'a();\n';
  assert.equal(stripDeclaration(plain), plain, '没有声明行时是恒等操作（阶段 1 的实况）');
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

  // 真包：段在、也声明了 ⇒ ok，且段数与 §1.3 的行数一致。
  const ok = inspectClientSource(packageJson.files, { listDir: realDir });
  assert.equal(ok.level, PREPARE_OK);
  assert.equal(ok.code, 'CLIENT-SRC');
  assert.match(ok.message, /24 个段文件/);
});

test('client build --check: a healthy copy is green, and one edited src/ line is red', () => {
  const root = throwawayPackage();
  try {
    const healthy = runBuild(root, '--check');
    assert.equal(healthy.status, 0, `副本本身必须是绿的\n${healthy.stdout}\n${healthy.stderr}`);

    const relPath = join(CLIENT_SRC_DIR, '12-helpers.js');
    const text = readFileSync(join(root, relPath), 'utf8');
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
    assert.equal(readFileSync(join(root, CLIENT_SRC_DIR, '00-header.js'), 'utf8').startsWith('/**'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

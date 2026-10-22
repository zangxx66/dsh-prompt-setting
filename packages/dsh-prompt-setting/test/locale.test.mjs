/**
 * `locale/` dictionary assertions (g-066).
 *
 * Before g-066 the plugin's copy lived inline in `client.js`: a 513-key `zh`
 * table, a 513-key `en` table, and a 51-row `ERROR_TEXT` table that a loop
 * expanded into `error.CODE` entries (564 keys per language). The dictionaries
 * now live in `locale/zh.json` / `locale/en.json`, and the blocks are **generated**
 * from them by `scripts/locale-pack.mjs` — since g-075 stage 2 that script writes
 * the `src/` slice that carries the blocks and then rebuilds `client.js`, so one
 * `--write` leaves the source and the artifact in sync (CONTRACT.md §23.2).
 *
 * These tests pin the properties that make "generated" safe to say:
 *   - the JSON is valid, key-aligned and complete (no key can go missing);
 *   - the carrying slice, and the bundle built from it, are byte-for-byte what
 *     `--write` would produce, so a hand edit to either is caught here rather
 *     than by a user;
 *   - the *negative* control: a single drifted character is reported, i.e. the
 *     check is not a no-op that passes on anything;
 *   - the delivery shape did not move: still a classic script, still a
 *     synchronous `locale.register` (a dictionary fetched at runtime would show
 *     bare keys on the first frame).
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

import { CLIENT_SRC_DIR } from '../scripts/client-build.mjs';
import {
  LOCALES,
  checkLocaleSync,
  findLocaleSegment,
  readDeclaredBlock,
  readDictionaries,
  renderDictionaryBlock,
  renderLocaleSegment,
  writeDeclaredBlock,
} from '../scripts/locale-pack.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

/** `node:fs`-backed reader over the package root, never throwing. */
function readText(relPath) {
  try {
    return readFileSync(join(packageRoot, relPath), 'utf8');
  } catch {
    return null;
  }
}

/** `node:fs`-backed directory lister over the package root, never throwing. */
function readDir(relPath) {
  try {
    return readdirSync(join(packageRoot, relPath));
  } catch {
    return null;
  }
}

/** A throwaway copy of everything `locale-pack.mjs` reads — so `--write` can be run for real. */
function throwawayPackage() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-locale-pack-'));
  for (const dir of ['core', 'scripts', 'locale', CLIENT_SRC_DIR]) {
    cpSync(join(packageRoot, dir), join(root, dir), { recursive: true });
  }
  for (const name of readdirSync(packageRoot)) {
    if (name === 'client.js' || /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(name)) {
      cpSync(join(packageRoot, name), join(root, name));
    }
  }
  return root;
}

/** Run a script in a throwaway copy. */
function run(root, script, ...flags) {
  return spawnSync(process.execPath, [script, ...flags], { cwd: root, encoding: 'utf8' });
}

/** Append `count` probe keys to both JSON dictionaries (same order ⇒ key parity holds). */
function appendProbeKeys(root, count) {
  for (const name of Object.keys(LOCALES)) {
    const jsonPath = join(root, 'locale', `${name}.json`);
    const raw = readFileSync(jsonPath, 'utf8');
    const rows = [];
    for (let index = 0; index < count; index += 1) {
      rows.push(`  "g079Probe${index}": "${name === 'zh' ? `探针${index}` : `probe${index}`}"`);
    }
    const next = raw.replace(/\n}\s*$/, `,\n${rows.join(',\n')}\n}\n`);
    assert.notEqual(next, raw, 'the fixture edit really lands');
    writeFileSync(jsonPath, next);
  }
}

/**
 * The number of `error.*` entries the `ERROR_TEXT` table expanded to.
 *
 * g-069 (Revision 50) grew the main dictionary from 513 to 515: the deletion
 * confirmation now states the restore it performs (`presetDeleteConfirmApplied`,
 * `presetDeleteAppliedList`) and its success notice reports how many workspaces
 * were restored (`presetDeletedRestoredNotice`), while the sentence that promised
 * a workspace「still holds its text」(`presetDeletedOrphanNotice`) is gone with
 * the behaviour it described.
 */
const ERROR_KEY_COUNT = 51;
/**
 * The main dictionary's own key count (522) — the two numbers must add to 573.
 *
 * g-070 (Revision 51) added one more: `tabUpdateBadge`, the readable description
 * the「高级」tab's red dot carries (`title` / `aria-label`). The count suffix on
 * 「我的预设」is a number in brackets, not prose, so it needs no key. g-071
 * (Revision 52) is a layout revision and adds no key: the read-only scope line it
 * first shipped on the other tabs was withdrawn by the owner's real-machine review
 * (R4), so the dictionaries are back to what Revision 51 left them at.
 *
 * g-074 att-002 (Revision 54) added six, all on the import preview: the
 * 「整份替换」warning and its two per-document lines (`importReplaceWarning`,
 * `importReplacePresets`, `importReplacePreferences`), the workspace-layer list
 * (`importWorkspacesHeading`, `importWorkspaceRow`) and the per-entry skipped
 * row (`importSkippedRow`). `importSkipped` keeps its key and now carries the
 * count instead of a joined list.
 *
 * g-073 (Revision 55) added thirteen, the two tab-owned scopes' own copy: six for
 * 「提示词总览」's by-workspace, per-session selector (`overviewScopeLabel`,
 * `overviewScopeNone`, `overviewScopeDegraded`, `overviewScopeSearch`,
 * `overviewScopeNoMatch`, `overviewScopeAuto`) and seven for「高级」's workspace
 * selector (`advancedScopeLabel`, `advancedScopeNone`, `advancedScopeDegraded`,
 * `advancedScopeSearch`, `advancedScopeNoMatch`, `advancedScopeAuto`,
 * `advancedScopeNote`). The disclosure and「当前选中」words (`scopeEdit`,
 * `scopeCollapse`, `scopeSelected`) are shared with the version history's own
 * selector and needed no new key.
 *
 * g-082 (Revision 56) added eight main keys, all on the preset library's tag
 * set: the manager entrance/title (`presetTagManager`), its empty state
 * (`presetTagNone`), the one save button (`presetTagSave`), the editor's
 * picker label (`presetTagPickerHint`), the filtered-empty sentence
 * (`presetFilteredEmpty`), the deletion question (`presetTagDeleteConfirmTitle`
 * / `presetTagDeleteConfirmBody`) and its notice (`presetTagDeletedNotice`).
 * The rest of the tag surface reuses the words the page already has (`fAll`,
 * `presetEdit`, `presetDelete`, `presetNameLabel`, `presetDialogClose`,
 * `confirmNo`, `presetFailed`) — the segment budget (§5.1, 1200 lines) holds at
 * 594 keys per language, and the new tag codes reuse the existing fallback the
 * older preset codes already rely on: the banner states the code itself.
 *
 * g-084 (Revision 57) added three, all on「我的 Prompt」's new read-only summary:
 * the no-record line (`mineStatusNoRecord`), the coverage counter
 * (`mineStatusCoverage`) and the「详情」entry (`mineStatusDetail`). The global
 * scope reuses `sessionGlobal`, and the two verdicts reuse the words the
 * assembly block already ships (`assemblyLayerAssembly` / `assemblyLayerDelivery`
 * plus the verdict sentences), so the count is 546 main keys / 597 total. To make
 * room inside the 1200-line segment budget, the generator's stale five-line
 * header comment was reduced to zero lines (the facts live in CONTRACT §14.5).
 */
const MAIN_KEY_COUNT = 546;
/** The full key count both files must hold, in the same order. */
const TOTAL_KEY_COUNT = MAIN_KEY_COUNT + ERROR_KEY_COUNT;

test('locale: both JSON files are valid, key-aligned dictionaries', () => {
  const { dictionaries, keys } = readDictionaries(packageRoot);
  assert.deepEqual(Object.keys(dictionaries), Object.keys(LOCALES));
  assert.equal(keys.length, TOTAL_KEY_COUNT);
  assert.equal(keys.length, 597);
  for (const name of Object.keys(LOCALES)) {
    const dict = dictionaries[name];
    assert.equal(Object.keys(dict).length, TOTAL_KEY_COUNT, `${name}: ${TOTAL_KEY_COUNT} keys`);
    // Key *sets* are not enough: the generated blocks follow file order, so a
    // reordered file is a silent 516-line diff of the bundle.
    assert.deepEqual(Object.keys(dict), keys, `${name}: same keys in the same order as zh`);
    for (const key of keys) assert.equal(typeof dict[key], 'string');
  }
});

test('locale: the 594 keys split into 543 main entries and 51 error codes', () => {
  const { dictionaries, keys } = readDictionaries(packageRoot);
  const errorKeys = keys.filter((key) => key.startsWith('error.'));
  assert.equal(errorKeys.length, ERROR_KEY_COUNT);
  assert.equal(keys.length - errorKeys.length, MAIN_KEY_COUNT);
  for (const key of errorKeys) {
    assert.match(key, /^error\.[a-z0-9-]+$/, `${key}: a documented rejection code`);
    // A code rendered as its own identifier is the failure the table existed to
    // prevent, so both languages must carry real, distinct prose.
    assert.notEqual(dictionaries.zh[key], key);
    assert.notEqual(dictionaries.en[key], key);
    assert.notEqual(dictionaries.zh[key], dictionaries.en[key], `${key}: actually translated`);
  }
});

test('locale: no placeholder drift beyond the one recorded exception', () => {
  const { dictionaries, keys } = readDictionaries(packageRoot);
  const params = (text) => [...new Set([...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]))].sort();
  const drift = [];
  for (const key of keys) {
    const zh = params(dictionaries.zh[key]).join(',');
    const en = params(dictionaries.en[key]).join(',');
    if (zh !== en) drift.push({ key, zh, en });
  }
  // g-080: `mineInterpolateNote` now carries the same two placeholders in both
  // languages — `{list}` (the host's registered names) and the `{{cwd}}` the copy
  // names as retired — so the g-066 exception is gone rather than kept. The
  // assertion stays exact: any *new* drift fails here.
  assert.deepEqual(drift, []);
});

test('locale: both the src/ segment and the bundle carry exactly what --write produces', () => {
  const { dictionaries } = readDictionaries(packageRoot);
  const source = readText('client.js');
  assert.notEqual(source, null);
  for (const name of Object.keys(LOCALES)) {
    const declared = readDeclaredBlock(source, name);
    assert.equal(declared.text, renderDictionaryBlock(name, dictionaries[name]));
    // The generator is idempotent: re-running it must not touch a byte.
    assert.equal(writeDeclaredBlock(source, name, dictionaries[name]), source, `${name}: --write is a no-op here`);
  }
  // 阶段 2：真源是承载 locale 生成段的那个 `src/` 段；产物的块必须与它一致。
  const segment = findLocaleSegment({ packageDir: packageRoot });
  assert.notEqual(segment, null, 'src/ 里的 locale 段真源必须存在');
  assert.equal(renderLocaleSegment(segment.text, dictionaries), segment.text, '段上的 --write 同样是恒等操作');
  const result = checkLocaleSync({ packageDir: packageRoot, readText, readDir });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.code, 'LOCALE-SYNC');
  assert.match(result.message, /src\//, '一条 ok 里要同时说出段真源与产物');
});

test('locale: a drifted bundle block is refused, not tolerated', () => {
  const source = readText('client.js');
  const broken = source.replace("      nav: 'Prompt 管理',", "      nav: 'Prompt 管理（改）',");
  assert.notEqual(broken, source, 'the negative control really edits the block');
  const result = checkLocaleSync({
    packageDir: packageRoot,
    readText: (relPath) => (relPath === 'client.js' ? broken : readText(relPath)),
    readDir,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LOCALE-SYNC');
  assert.match(result.message, /client\.js/);
  assert.match(result.message, /--write/);
});

test('locale: a drifted src/ segment is refused even when the bundle is intact', () => {
  const segment = findLocaleSegment({ packageDir: packageRoot });
  assert.notEqual(segment, null);
  const broken = segment.text.replace("      nav: 'Prompt 管理',", "      nav: 'Prompt 管理（段改）',");
  assert.notEqual(broken, segment.text, 'the negative control really edits the segment');
  const result = checkLocaleSync({
    packageDir: packageRoot,
    readText: (relPath) => (relPath === `${CLIENT_SRC_DIR}/${segment.name}` ? broken : readText(relPath)),
    readDir,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LOCALE-SYNC');
  // 失败要指向**段真源**：旧实现只看 client.js，这半场是它的盲区。
  assert.match(result.message, new RegExp(`${CLIENT_SRC_DIR}/${segment.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.message, /--write/);
  // 而 client.js 一个字节没动 —— 证明这次失败确实来自段真源。
  assert.equal(readDeclaredBlock(readText('client.js'), 'zh').text.includes('段改'), false);
});

test('locale: --write lands in the src/ segment and rebuilds client.js in one shot', () => {
  const root = throwawayPackage();
  try {
    const jsonPath = join(root, 'locale', 'zh.json');
    const json = readFileSync(jsonPath, 'utf8');
    const edited = json.replace('"nav": "Prompt 管理"', '"nav": "R1 一次到位"');
    assert.notEqual(edited, json, 'the fixture edit really lands');
    writeFileSync(jsonPath, edited);

    const write = run(root, 'scripts/locale-pack.mjs', '--write');
    assert.equal(write.status, 0, `--write 必须成功\n${write.stdout}\n${write.stderr}`);

    const { dictionaries } = readDictionaries(root);
    assert.equal(dictionaries.zh.nav, 'R1 一次到位');
    const segment = findLocaleSegment({ packageDir: root });
    assert.notEqual(segment, null);
    // ① 段真源带上新文案
    const segmentText = readFileSync(join(root, CLIENT_SRC_DIR, segment.name), 'utf8');
    assert.equal(readDeclaredBlock(segmentText, 'zh').text, renderDictionaryBlock('zh', dictionaries.zh));
    // ①' 非自参照断言（g-076 项 6）：期望写成**字面量**，不经被测函数生成 ——
    // 上面那条用 `renderDictionaryBlock` 造期望，而它正是被测对象，生成器改坏时
    // 两边会一起坏、断言照样绿。这两条只信「文件里有没有那一行」。
    const segmentLines = segmentText.split('\n');
    assert.equal(segmentLines.includes("      nav: 'R1 一次到位',"), true, '段真源里的 nav 必须就是新文案那一行');
    assert.equal(segmentLines.includes("      nav: 'Prompt 管理',"), false, '旧文案必须从段真源消失');
    // ② 生成物也带上 —— 一次 --write 之后两边同时最新（这就是旧实现丢掉的那一步）
    assert.equal(
      readDeclaredBlock(readFileSync(join(root, 'client.js'), 'utf8'), 'zh').text,
      renderDictionaryBlock('zh', dictionaries.zh),
    );
    // ②' 同一条字面量断言落在产物上：产物里的 nav 也是那一行。
    assert.equal(
      readFileSync(join(root, 'client.js'), 'utf8').split('\n').includes("      nav: 'R1 一次到位',"),
      true,
      '产物里的 nav 必须就是新文案那一行（同样不经生成器）。',
    );
    // ③ / ④ 两道门都绿
    assert.equal(run(root, 'scripts/client-build.mjs', '--check').status, 0, 'client-build --check 必须绿');
    assert.equal(run(root, 'scripts/locale-pack.mjs', '--check').status, 0, 'locale-pack --check 必须绿');
    // 反向：把刚写进段的文案手改掉（不跑 --write）⇒ 门必须红。
    writeFileSync(join(root, CLIENT_SRC_DIR, segment.name), segmentText.replace('R1 一次到位', '手动回退'));
    assert.notEqual(run(root, 'scripts/locale-pack.mjs', '--check').status, 0, '手改段真源必须被拒');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('locale: --write without a src/ truth source falls back loudly, not silently', () => {
  // g-076 项 5：`src/` 被误删时 `--write` 仍走老路径直接写 client.js（这是为阶段 2
  // 之前的包与最小 fixture 保留的兼容分支，本身要留着）—— 但它必须**说出来**，
  // 否则「src/ 没了」会被这条分支静默吞掉，直到 `client-build --check` 才红。
  const root = throwawayPackage();
  try {
    rmSync(join(root, CLIENT_SRC_DIR), { recursive: true, force: true });
    const write = run(root, 'scripts/locale-pack.mjs', '--write');
    assert.equal(write.status, 0, `无 src/ 的回退分支本身是合法路径\n${write.stderr}`);
    assert.match(write.stderr, /未找到 src\/ 段真源/, '回退必须打印显式提示（不能静默）');
    assert.match(write.stdout, /client\.js/, '回退写的是老路径 client.js，提示要说清');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('locale: the dictionary segment is found, never hard-coded, and ambiguity is refused', () => {
  const found = findLocaleSegment({ packageDir: packageRoot });
  assert.notEqual(found, null);
  assert.equal(found.name.endsWith('.js'), true);
  // 真源不唯一 ⇒ fail-closed（重切之后两个段都含 zh/en 块）。
  const listTwo = (relPath) => (
    relPath === CLIENT_SRC_DIR ? [...readdirSync(join(packageRoot, CLIENT_SRC_DIR)), '02-also.js'] : readDir(relPath)
  );
  const readTwo = (relPath) => (relPath === `${CLIENT_SRC_DIR}/02-also.js` ? found.text : readText(relPath));
  assert.throws(() => findLocaleSegment({ packageDir: packageRoot, readDir: listTwo, readText: readTwo }), /真源不唯一/);
  // 命中 0 个 ⇒ fail-closed
  const readNone = (relPath) => (relPath.startsWith(`${CLIENT_SRC_DIR}/`) ? '// 没有段\n' : readText(relPath));
  assert.throws(() => findLocaleSegment({ packageDir: packageRoot, readText: readNone, readDir }), /真源缺失/);
  // 没有 src/ ⇒ N/A（返回 null，不抛）：阶段 2 之前的包与最小 fixture 走这条。
  assert.equal(findLocaleSegment({ packageDir: packageRoot, readDir: () => null }), null);
  // g-076 项 4 的负向对照：文本里**恰好出现**两个块头行、但块不闭合 —— 只按「行是否
  // 出现过」判定的旧实现会把它当真源；现在候选判定复用 `readDeclaredBlock`（要块头 +
  // 闭合行），所以它不算命中 ⇒ 真源缺失（fail-closed），绝不往这个段里写词典。
  const decoy = 'const outer = {\n    const zh = {\n};\n    const en = {\n};\n';
  const decoyLines = decoy.split('\n');
  assert.equal(
    decoyLines.includes('    const zh = {') && decoyLines.includes('    const en = {'),
    true,
    '诱饵确实含两行块头（旧判据会命中它）',
  );
  const readDecoy = (relPath) => (relPath === `${CLIENT_SRC_DIR}/${found.name}` ? decoy : readText(relPath));
  assert.throws(
    () => findLocaleSegment({ packageDir: packageRoot, readDir, readText: readDecoy }),
    /真源缺失/,
  );
});

test('locale: a comment decoy with fully closed blocks is still refused (g-079 项 3)', () => {
  const found = findLocaleSegment({ packageDir: packageRoot });

  // 三格矩阵第①格（行为不变）：真源在 + 另一段的注释里只有「块头」、没有闭合行 ⇒ 命中真源。
  const openOnly = 'const outer = {\n    const zh = {\n};\n    const en = {\n};\n';
  const listExtra = (relPath) => (
    relPath === CLIENT_SRC_DIR ? [...readdirSync(join(packageRoot, CLIENT_SRC_DIR)), '02-decoy.js'] : readDir(relPath)
  );
  const readExtra = (relPath) => (relPath === `${CLIENT_SRC_DIR}/02-decoy.js` ? openOnly : readText(relPath));
  assert.equal(
    findLocaleSegment({ packageDir: packageRoot, readDir: listExtra, readText: readExtra }).name,
    found.name,
    '真源在 + 无闭合诱饵 ⇒ 仍命中真源',
  );

  // 三格矩阵第③格（g-079 修复）：真源缺失 + 注释里写出**一对完整可解析**的 zh/en 块
  // （含闭合行）。旧实现只要求「两个块都能被 readDeclaredBlock 解析」⇒ 会把它当真源。
  // 这里刻意用**两个真实键**（nav / title）而不是瞎编的键名：键重合度会是 100%，单靠
  // 重合度挡不住它 —— 真正挡住它的是「较小一侧键数 ≥ 50」的规模下限（U1）。这样本用例
  // 同时钉住「行格式 + 区间不重叠 + 规模下限」三层判据，而不只是「键名对不上」。
  const closedDecoy = [
    '/* 文档示例（注释，不是真源）：',
    '    const zh = {',
    "      nav: '示例',",
    "      title: '示例',",
    '    };',
    '',
    '    const en = {',
    "      nav: 'example',",
    "      title: 'example',",
    '    };',
    '*/',
    '',
  ].join('\n');
  const readClosed = (relPath) => (relPath === `${CLIENT_SRC_DIR}/${found.name}` ? closedDecoy : readText(relPath));
  assert.throws(
    () => findLocaleSegment({ packageDir: packageRoot, readDir, readText: readClosed }),
    /真源缺失/,
  );
});

test('locale: --check and --write refuse a fully closed decoy and touch no file (g-079 项 3)', () => {
  const root = throwawayPackage();
  try {
    const segment = findLocaleSegment({ packageDir: root });
    const segmentPath = join(root, CLIENT_SRC_DIR, segment.name);
    const decoy = [
      '/* 文档示例（注释，不是真源）：',
      '    const zh = {',
      "      nav: '示例',",
      "      title: '示例',",
      '    };',
      '',
      '    const en = {',
      "      nav: 'example',",
      "      title: 'example',",
      '    };',
      '*/',
      '',
    ].join('\n');
    writeFileSync(segmentPath, decoy);
    const watched = ['client.js', `${CLIENT_SRC_DIR}/${segment.name}`];
    const before = watched.map((rel) => readFileSync(join(root, rel), 'utf8'));
    for (const flag of ['--check', '--write']) {
      const result = run(root, 'scripts/locale-pack.mjs', flag);
      assert.notEqual(result.status, 0, `${flag} 必须非零\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /真源缺失/, `${flag} 的失败必须说清「真源缺失」`);
      // 返工 U2：不能指引「先跑 --write」（用户跑的/该跑的正是不可能定位到目标的它）。
      assert.doesNotMatch(result.stderr, /先跑 node scripts\/locale-pack\.mjs --write/, `${flag} 不得再指引跑 --write`);
      if (flag === '--check') {
        assert.match(result.stderr, /检查该段是否被改坏/, '--check 的指引要指向「段被改坏 / 与 JSON 漂移过大」');
      } else {
        assert.match(result.stderr, /没有一个满足真源判据/, '--write 的文案要区分「有候选段但不合格」与「没有候选段」');
      }
    }
    // 不写坏任何文件：段文件保持诱饵原文，client.js 一个字节没动。
    watched.forEach((rel, at) => assert.equal(readFileSync(join(root, rel), 'utf8'), before[at], `${rel} 不得被改写`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('locale: adding a key to the JSON still lets --write locate the segment', () => {
  // 键集合判据不是严格相等（g-079 项 3）：加键/删键/改名之后跑 `--write` 是正常流程，
  // 严格相等会把这条流程挡在门外。本用例钉住「+1 键」这个最小形态。
  const root = throwawayPackage();
  try {
    appendProbeKeys(root, 1);
    const write = run(root, 'scripts/locale-pack.mjs', '--write');
    assert.equal(write.status, 0, `加键后的 --write 必须仍能定位真源\n${write.stdout}\n${write.stderr}`);
    const segment = findLocaleSegment({ packageDir: root });
    const text = readFileSync(join(root, CLIENT_SRC_DIR, segment.name), 'utf8');
    assert.equal(text.includes("      g079Probe0: '探针0',"), true, 'zh 的新键要写进段真源');
    assert.equal(text.includes("      g079Probe0: 'probe0',"), true, 'en 的新键要写进段真源');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('locale: a batch of +80 keys still lets --write locate the segment (U1)', () => {
  // 返工 U1：用 max 作分母时，纯加 N 键的得分是 S/(S+N)，带基线键数时 +66 就掉到 90% 以下
  // ⇒ --write 报「真源缺失」，而基线在同样副本里 exit 0（行为回归）。改用 min 分母后，
  // 纯加键恒为 100%。这里用评审实测的 +80 键钉住它（g-084 起基线是 597 键）。
  const root = throwawayPackage();
  try {
    appendProbeKeys(root, 80);
    const write = run(root, 'scripts/locale-pack.mjs', '--write');
    assert.equal(write.status, 0, `加 80 键后的 --write 必须仍能定位真源\n${write.stdout}\n${write.stderr}`);
    assert.match(write.stdout, /677 键\/语言/, '--write 要按 597+80=677 键写');
    const segment = findLocaleSegment({ packageDir: root });
    const segmentText = readFileSync(join(root, CLIENT_SRC_DIR, segment.name), 'utf8');
    const clientText = readFileSync(join(root, 'client.js'), 'utf8');
    for (const [text, label] of [[segmentText, '段真源'], [clientText, 'client.js']]) {
      assert.equal(text.includes("      g079Probe0: '探针0',"), true, `${label} 要含第一个新键`);
      assert.equal(text.includes("      g079Probe79: 'probe79',"), true, `${label} 要含最后一个新键`);
    }
    // 加键不该让「段 ↔ 产物」「词典 ↔ 段」两道一致性门变红。
    assert.equal(run(root, 'scripts/client-build.mjs', '--check').status, 0, '加键后段 ↔ 产物仍一致');
    assert.equal(run(root, 'scripts/locale-pack.mjs', '--check').status, 0, '加键后词典 ↔ 段仍一致');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('locale: client.js carries no second copy of the dictionaries', () => {
  const source = readText('client.js');
  // The inline table is gone: `error.CODE` is a plain dictionary key now.
  assert.equal(source.includes('ERROR_TEXT'), false, 'the ERROR_TEXT table is deleted');
  const lines = source.split('\n');
  assert.equal(lines.filter((line) => line === '    const zh = {').length, 1);
  assert.equal(lines.filter((line) => line === '    const en = {').length, 1);
  assert.equal(lines.filter((line) => line.startsWith('      error.')).length, 0, 'and the codes live in the JSON, not a loop');
  assert.match(source, /locale\.register\(NS, \{ zh, en \}\)/);
});

test('locale: the delivery shape stays a classic script with a synchronous register', () => {
  const source = readText('client.js');
  // A classic `<script>` factory: ESM syntax would be a syntax error in the
  // browser, which the host does not transpile away.
  assert.doesNotMatch(source, /^\s*import[\s{*]/m);
  assert.doesNotMatch(source, /^\s*export[\s{*]/m);
  assert.doesNotMatch(source, /import\.meta/);
  const line = source.split('\n').find((text) => text.includes('locale.register(NS, { zh, en })'));
  assert.ok(line, 'the registration call is still there');
  assert.doesNotMatch(line, /\bawait\b|\bfetch\b/);
  // Both dictionaries are already bound when the call runs: the constants are
  // declared above it, in the same factory body.
  const register = source.indexOf('locale.register(NS, { zh, en })');
  assert.ok(source.indexOf('    const zh = {') > 0 && source.indexOf('    const zh = {') < register);
  assert.ok(source.indexOf('    const en = {') > 0 && source.indexOf('    const en = {') < register);
});

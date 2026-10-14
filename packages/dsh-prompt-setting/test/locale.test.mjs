/**
 * `locale/` dictionary assertions (g-066).
 *
 * Before g-066 the plugin's copy lived inline in `client.js`: a 513-key `zh`
 * table, a 513-key `en` table, and a 51-row `ERROR_TEXT` table that a loop
 * expanded into `error.CODE` entries (564 keys per language). The dictionaries
 * now live in `locale/zh.json` / `locale/en.json`, and the blocks in `client.js`
 * are **generated** from them by `scripts/locale-pack.mjs`.
 *
 * These tests pin the properties that make "generated" safe to say:
 *   - the JSON is valid, key-aligned and complete (no key can go missing);
 *   - the bundle's blocks are byte-for-byte what `--write` would produce, so a
 *     hand edit to the generated region is caught here rather than by a user;
 *   - the *negative* control: a single drifted character is reported, i.e. the
 *     check is not a no-op that passes on anything;
 *   - the delivery shape did not move: still a classic script, still a
 *     synchronous `locale.register` (a dictionary fetched at runtime would show
 *     bare keys on the first frame).
 *
 * Run: `node --test`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LOCALES,
  checkLocaleSync,
  readDeclaredBlock,
  readDictionaries,
  renderDictionaryBlock,
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
 * The main dictionary's own key count (516) — the two numbers must add to 567.
 *
 * g-070 (Revision 51) added one more: `tabUpdateBadge`, the readable description
 * the「高级」tab's red dot carries (`title` / `aria-label`). The count suffix on
 * 「我的预设」is a number in brackets, not prose, so it needs no key.
 */
const MAIN_KEY_COUNT = 516;
/** The full key count both files must hold, in the same order. */
const TOTAL_KEY_COUNT = MAIN_KEY_COUNT + ERROR_KEY_COUNT;

test('locale: both JSON files are valid, key-aligned dictionaries', () => {
  const { dictionaries, keys } = readDictionaries(packageRoot);
  assert.deepEqual(Object.keys(dictionaries), Object.keys(LOCALES));
  assert.equal(keys.length, TOTAL_KEY_COUNT);
  assert.equal(keys.length, 567);
  for (const name of Object.keys(LOCALES)) {
    const dict = dictionaries[name];
    assert.equal(Object.keys(dict).length, TOTAL_KEY_COUNT, `${name}: ${TOTAL_KEY_COUNT} keys`);
    // Key *sets* are not enough: the generated blocks follow file order, so a
    // reordered file is a silent 516-line diff of the bundle.
    assert.deepEqual(Object.keys(dict), keys, `${name}: same keys in the same order as zh`);
    for (const key of keys) assert.equal(typeof dict[key], 'string');
  }
});

test('locale: the 567 keys split into 516 main entries and 51 error codes', () => {
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
  // `mineInterpolateNote` already disagreed before g-066: the en copy names
  // `{variables}` and the zh copy does not, so the English panel can render a
  // literal `{variables}`. The migration freezes copy, so this is recorded as a
  // named exception instead of being silently tolerated — any *new* drift fails
  // here, which is the property that matters once the JSON becomes the source.
  assert.deepEqual(drift, [{ key: 'mineInterpolateNote', zh: 'cwd,model,provider', en: 'cwd,model,provider,variables' }]);
});

test('locale: the client.js blocks are exactly what --write produces', () => {
  const { dictionaries } = readDictionaries(packageRoot);
  const source = readText('client.js');
  assert.notEqual(source, null);
  for (const name of Object.keys(LOCALES)) {
    const declared = readDeclaredBlock(source, name);
    assert.equal(declared.text, renderDictionaryBlock(name, dictionaries[name]));
    // The generator is idempotent: re-running it must not touch a byte.
    assert.equal(writeDeclaredBlock(source, name, dictionaries[name]), source, `${name}: --write is a no-op here`);
  }
  const result = checkLocaleSync({ packageDir: packageRoot, readText });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.code, 'LOCALE-SYNC');
});

test('locale: a drifted bundle block is refused, not tolerated', () => {
  const source = readText('client.js');
  const broken = source.replace("      nav: 'Prompt 管理',", "      nav: 'Prompt 管理（改）',");
  assert.notEqual(broken, source, 'the negative control really edits the block');
  const result = checkLocaleSync({ packageDir: packageRoot, readText: (relPath) => (relPath === 'client.js' ? broken : null) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LOCALE-SYNC');
  assert.match(result.message, /--write/);
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

/**
 * Unit assertions for the stage 2 history kernel (`core/history.js`) and for
 * the store functions that persist it (`core/store.js`).
 *
 * Everything here is pinned without a Host and without touching a real config:
 * the pure kernel is called directly, and the store functions work inside a
 * per-test temp directory. `DSH_HOME` is redirected for the path tests only.
 *
 * Run: `node --test test/`
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import {
  DEFAULT_HISTORY_LIMIT,
  HISTORY_ACTIONS,
  MAX_HISTORY_LIMIT,
  MIN_HISTORY_LIMIT,
  actionOf,
  digestEntry,
  makeRecord,
  parseHistory,
  publicRecord,
  queryHistory,
  resolveHistoryLimit,
  resolvePageLimit,
  resetEntries,
  sameOverride,
  serializeHistory,
  serializeRecord,
  snapshotOfConfig,
  textEntry,
  trimRecords,
  validateHistoryRecord,
} from '../core/history.js';
import {
  appendHistoryRecord,
  historyPath,
  readHistoryFile,
  userConfigPath,
  workspaceConfigPath,
  writeConfigsAtomically,
} from '../core/store.js';

let home;
let previousHome;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-prompt-setting-history-'));
  previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
});

/** SHA-256 of a file's bytes, for byte-identity assertions. */
function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** One valid record's fields. */
function fields(over = {}) {
  return {
    path: join(home, 'layer', 'overrides.json'),
    seq: 1,
    at: '2024-01-01T00:00:00.000Z',
    layer: 'user',
    session: null,
    action: 'replace',
    name: 'project:alpha',
    origin: 'ui',
    before: null,
    after: textEntry('one'),
    snapshot: [],
    ...over,
  };
}

// #region text fingerprints

test('history: a text entry carries the text, its SHA-256 and its UTF-8 byte length', () => {
  const entry = textEntry('héllo');
  assert.equal(entry.text, 'héllo');
  assert.equal(entry.bytes, 6, 'é is two bytes');
  assert.deepEqual(entry.hash, createHash('sha256').update('héllo', 'utf8').digest('hex'));
  assert.equal(textEntry(null), null);
  assert.equal(textEntry(undefined), null);
  assert.deepEqual(digestEntry('one'), { hash: textEntry('one').hash, bytes: 3 });
  assert.equal(digestEntry(null), null);
});

test('history: a snapshot entry is comparable without carrying any text', () => {
  const snapshot = snapshotOfConfig({
    version: 1,
    overrides: [
      { name: 'a', action: 'replace', text: 'A' },
      { name: 'b', action: 'hide' },
      { name: 'c', action: 'append', text: 'CC', order: 1 },
    ],
  });
  assert.deepEqual(snapshot.map((entry) => entry.name), ['a', 'b', 'c']);
  assert.deepEqual(snapshot[0], { name: 'a', action: 'replace', hash: textEntry('A').hash, bytes: 1 });
  assert.deepEqual(snapshot[1], { name: 'b', action: 'hide', hash: null, bytes: null });
  assert.equal(JSON.stringify(snapshot).includes('CC'), false, 'no text leaks into a snapshot');
  assert.deepEqual(snapshotOfConfig(null), []);
});

// #endregion

// #region record shape

test('history: the action vocabulary is exactly the five documented values', () => {
  assert.deepEqual([...HISTORY_ACTIONS], ['replace', 'hide', 'append', 'remove', 'reset-layer']);
});

test('history: makeRecord rejects a record that could not round-trip', () => {
  assert.equal(makeRecord(fields()).seq > 0, true);
  for (const [patch, code] of [
    [{ at: undefined }, 'invalid-history-record'],
    [{ at: '' }, 'invalid-history-record'],
    [{ action: 'nope' }, 'invalid-history-record'],
    [{ origin: 'robot' }, 'invalid-history-record'],
    [{ name: null }, 'invalid-history-record'],
    [{ seq: 0 }, 'invalid-history-record'],
    [{ seq: 1.5 }, 'invalid-history-record'],
    [{ session: 7 }, 'invalid-history-record'],
    [{ entries: 'x' }, 'invalid-history-record'],
    [{ snapshot: 'x' }, 'invalid-history-record'],
  ]) {
    assert.throws(() => makeRecord(fields(patch)), (error) => error.code === code, JSON.stringify(patch));
  }
});

test('history: a reset-layer record is the one action that carries no name', () => {
  const record = makeRecord(fields({ action: 'reset-layer', name: null, entries: [] }));
  assert.equal(record.name, null);
  assert.throws(() => validateHistoryRecord({ ...record, name: 'x' }), /./);
  assert.throws(() => makeRecord(fields({ action: 'remove', name: null })), (error) => error.code === 'invalid-history-record');
});

// #endregion

// #region parse / serialize

test('history: parsing skips a corrupt line instead of losing the whole log', () => {
  const good = serializeRecord(makeRecord(fields({ seq: 1 })));
  const second = serializeRecord(makeRecord(fields({ seq: 2, action: 'hide', after: null })));
  const text = `${good}\n{not json\n${second}\n${good}not-a-record-object\n\n`;
  const parsed = parseHistory(text);
  assert.deepEqual(parsed.records.map((record) => record.seq), [1, 2]);
  assert.equal(parsed.corrupt, 3, 'two unparsable lines and one duplicate seq are each counted');
  assert.equal(parsed.maxSeq, 2);
});

test('history: parsing an empty or absent file is empty history, never an error', () => {
  assert.deepEqual(parseHistory(''), { records: [], corrupt: 0, maxSeq: 0 });
  assert.deepEqual(parseHistory(undefined), { records: [], corrupt: 0, maxSeq: 0 });
  assert.deepEqual(parseHistory('\n\n'), { records: [], corrupt: 0, maxSeq: 0 });
});

test('history: serializeHistory round-trips through parseHistory', () => {
  const records = [makeRecord(fields({ seq: 1 })), makeRecord(fields({ seq: 2, at: '2024-01-02T00:00:00.000Z' }))];
  const parsed = parseHistory(serializeHistory(records));
  assert.deepEqual(parsed.records, records);
  assert.equal(parsed.corrupt, 0);
});

// #endregion

// #region retention

test('history: trimRecords keeps the newest N and reports what it dropped', () => {
  const records = [1, 2, 3, 4, 5].map((seq) => makeRecord(fields({ seq })));
  const trimmed = trimRecords(records, 3);
  assert.deepEqual(trimmed.kept.map((record) => record.seq), [3, 4, 5]);
  assert.deepEqual(trimmed.dropped.map((record) => record.seq), [1, 2]);
  assert.equal(trimmed.trimmed, true);

  const untouched = trimRecords(records, 5);
  assert.equal(untouched.trimmed, false);
  assert.deepEqual(untouched.dropped, []);
  const fallback = trimRecords(records, 0);
  assert.equal(fallback.kept.length, 5, 'an unusable bound falls back to the default, which keeps all five');
  assert.equal(fallback.trimmed, false);
});

test('history: the retention bound is configurable, clamped, and never fatal', () => {
  assert.equal(resolveHistoryLimit(undefined, {}), DEFAULT_HISTORY_LIMIT);
  assert.equal(DEFAULT_HISTORY_LIMIT >= 100, true, 'the documented default is at least 100');
  assert.equal(resolveHistoryLimit({ historyLimit: 250 }, {}), 250);
  assert.equal(resolveHistoryLimit(undefined, { DSH_PROMPT_SETTING_HISTORY_LIMIT: '300' }), 300);
  assert.equal(resolveHistoryLimit({ historyLimit: '120' }, {}), 120);
  assert.equal(resolveHistoryLimit({ historyLimit: 3 }, {}), DEFAULT_HISTORY_LIMIT, 'below the minimum is ignored');
  assert.equal(resolveHistoryLimit({ historyLimit: 10 ** 9 }, {}), MAX_HISTORY_LIMIT);
  assert.equal(resolveHistoryLimit({ historyLimit: 'abc' }, {}), DEFAULT_HISTORY_LIMIT);
  assert.equal(resolveHistoryLimit({ historyLimit: null }, { DSH_PROMPT_SETTING_HISTORY_LIMIT: '11' }), 11);
  assert.equal(MIN_HISTORY_LIMIT, 10);
});

test('history: the page size is clamped rather than rejected', () => {
  assert.equal(resolvePageLimit(null), 50);
  assert.equal(resolvePageLimit(''), 50);
  assert.equal(resolvePageLimit('0'), 0);
  assert.equal(resolvePageLimit('7'), 7);
  assert.equal(resolvePageLimit('-4'), 50);
  assert.equal(resolvePageLimit('nope'), 50);
  assert.equal(resolvePageLimit('100000'), 500);
});

// #endregion

// #region query

test('history: querying is newest-first and filters by layer, session and name', () => {
  const records = [
    makeRecord(fields({ seq: 1, name: 'a', session: null })),
    makeRecord(fields({ seq: 2, name: 'b', session: 's1' })),
    makeRecord(fields({ seq: 3, name: 'a', session: 's1', at: '2024-02-01T00:00:00.000Z' })),
    makeRecord(fields({ seq: 4, layer: 'workspace', name: 'a', session: 's1' })),
  ];
  const all = queryHistory(records, {});
  assert.deepEqual(all.records.map((record) => record.seq), [4, 3, 2, 1]);
  assert.equal(all.total, 4);

  assert.deepEqual(queryHistory(records, { name: 'a' }).records.map((r) => r.seq), [4, 3, 1]);
  assert.deepEqual(queryHistory(records, { layer: 'workspace' }).records.map((r) => r.seq), [4]);
  assert.deepEqual(queryHistory(records, { session: 's1' }).records.map((r) => r.seq), [4, 3, 2]);
  assert.deepEqual(
    queryHistory(records, { before: '2024-02-01T00:00:00.000Z' }).records.map((r) => r.seq),
    [4, 2, 1],
    'before is exclusive: record 3 carries exactly that timestamp',
  );

  const paged = queryHistory(records, { limit: 2 });
  assert.deepEqual(paged.records.map((record) => record.seq), [4, 3]);
  assert.equal(paged.total, 4, 'total counts every match, not the page');
  assert.deepEqual(queryHistory(records, { limit: 0 }).records, []);
});

test('history: the public record exposes a stable id that is its seq', () => {
  const record = makeRecord(fields({ seq: 42 }));
  assert.equal(publicRecord(record).id, '42');
  assert.equal(publicRecord(record).seq, 42);
});

// #endregion

// #region small helpers

test('history: actionOf and sameOverride describe one write', () => {
  assert.equal(actionOf(null, { name: 'a', action: 'replace', text: 'x' }), 'replace');
  assert.equal(actionOf({ name: 'a', action: 'replace', text: 'x' }, { name: 'a', action: 'hide' }), 'hide');
  assert.equal(actionOf(null, { name: 'a', action: 'append', text: 'x' }), 'append');
  assert.equal(actionOf({ name: 'a', action: 'replace', text: 'x' }, null), 'remove');

  assert.equal(sameOverride({ name: 'a', action: 'replace', text: 'x' }, { name: 'a', action: 'replace', text: 'x' }), true);
  assert.equal(sameOverride({ name: 'a', action: 'replace', text: 'x' }, { name: 'a', action: 'replace', text: 'y' }), false);
  assert.equal(sameOverride({ name: 'a', action: 'append', text: 'x' }, { name: 'a', action: 'append', text: 'x', order: 1 }), false);
  assert.equal(sameOverride(null, null), true);
});

test('history: resetEntries keeps the removed text so a reset is reconstructible', () => {
  assert.deepEqual(
    resetEntries([
      { name: 'a', action: 'replace', text: 'A' },
      { name: 'b', action: 'hide' },
      { name: 'c', action: 'append', text: 'C', order: 2 },
    ]),
    [
      { name: 'a', action: 'replace', text: 'A' },
      { name: 'b', action: 'hide' },
      { name: 'c', action: 'append', text: 'C', order: 2 },
    ],
  );
  assert.deepEqual(resetEntries(null), []);
});

// #endregion

// #region store: paths, append, trim

test('store: a layer history file lives beside that layer config, never elsewhere', () => {
  const user = userConfigPath();
  const workspace = workspaceConfigPath('/w/one');
  assert.equal(historyPath(user), join(home, 'prompt-setting', 'history.jsonl'));
  assert.equal(user.endsWith(join('prompt-setting', 'overrides.json')), true);
  assert.equal(historyPath(workspace), join('/w/one', '.dsh-prompt-setting', 'history.jsonl'));
});

test('store: appending writes one line and never rewrites the existing bytes', () => {
  const path = historyPath(join(home, 'prompt-setting', 'overrides.json'));
  const first = appendHistoryRecord(path, fields({ at: '2024-01-01T00:00:00.000Z' }), 100);
  assert.equal(first.record.seq, 1);
  assert.equal(first.rewritten, false);
  const afterFirst = readFileSync(path, 'utf8');

  const second = appendHistoryRecord(path, fields({ at: '2024-01-02T00:00:00.000Z' }), 100);
  assert.equal(second.record.seq, 2, 'seq continues the file high-water mark');
  assert.equal(second.rewritten, false);
  const afterSecond = readFileSync(path, 'utf8');
  assert.equal(afterSecond.startsWith(afterFirst), true, 'the previous bytes are a prefix: this is an append');
  assert.equal(afterSecond.split('\n').filter((line) => line.length > 0).length, 2);
  assert.equal(readdirSync(join(home, 'prompt-setting')).some((name) => name.endsWith('.tmp')), false);
});

test('store: the retention bound is enforced on disk and only then is the file rewritten', () => {
  const path = historyPath(join(home, 'prompt-setting', 'overrides.json'));
  for (let index = 1; index <= 5; index += 1) {
    appendHistoryRecord(path, fields({ at: `2024-01-0${index}T00:00:00.000Z` }), 3);
  }
  const read = readHistoryFile(path);
  assert.deepEqual(read.records.map((record) => record.seq), [3, 4, 5], 'the oldest two were dropped');
  assert.equal(read.maxSeq, 5, 'the high-water mark survives trimming, so ids stay unique');
  assert.equal(readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0).length, 3);

  // A trim is the one case that rewrites: the next append keeps the bound.
  const sixth = appendHistoryRecord(path, fields({ at: '2024-01-06T00:00:00.000Z' }), 3);
  assert.equal(sixth.rewritten, true, 'the file was at its bound, so it was rewritten');
  assert.deepEqual(sixth.dropped.map((record) => record.seq), [3]);
  assert.deepEqual(readHistoryFile(path).records.map((record) => record.seq), [4, 5, 6]);
});

test('store: a corrupt line is skipped on read and healed on the next append', () => {
  const path = historyPath(join(home, 'prompt-setting', 'overrides.json'));
  mkdirSync(join(home, 'prompt-setting'), { recursive: true });
  writeFileSync(path, `${serializeRecord(makeRecord(fields({ seq: 1 })))}{ broken\n`, 'utf8');
  const read = readHistoryFile(path);
  assert.equal(read.corrupt, 1);
  assert.deepEqual(read.records.map((record) => record.seq), [1]);

  const appended = appendHistoryRecord(path, fields({ at: '2024-01-03T00:00:00.000Z' }), 100);
  assert.equal(appended.rewritten, true, 'a corrupt line forces one healing rewrite');
  const healed = readHistoryFile(path);
  assert.equal(healed.corrupt, 0);
  assert.deepEqual(healed.records.map((record) => record.seq), [1, 2]);
});

test('store: a missing history file is empty history, an unreadable one is an error', () => {
  const missing = readHistoryFile(join(home, 'nope', 'history.jsonl'));
  assert.deepEqual(missing.records, []);
  assert.equal(missing.missing, true);
  assert.equal(missing.error, null);

  const directory = join(home, 'adir');
  mkdirSync(directory, { recursive: true });
  const unreadable = readHistoryFile(directory);
  assert.equal(unreadable.missing, false);
  assert.equal(unreadable.error.code, 'unreadable-file');
});

test('store: appending to an unreadable history file is a structured error, not a crash', () => {
  const directory = join(home, 'adir2');
  mkdirSync(directory, { recursive: true });
  assert.throws(
    () => appendHistoryRecord(directory, fields()),
    (error) => error.code === 'history-unusable' && error.status === 500,
  );
});

// #endregion

// #region store: atomic multi-file replace

test('store: an import commits every layer atomically and leaves no temp file behind', () => {
  const one = join(home, 'one', 'overrides.json');
  const two = join(home, 'two', 'overrides.json');
  mkdirSync(join(home, 'one'), { recursive: true });
  mkdirSync(join(home, 'two'), { recursive: true });
  writeFileSync(one, '{"version":1,"overrides":[]}\n', 'utf8');
  writeFileSync(two, '{"version":1,"overrides":[]}\n', 'utf8');

  const result = writeConfigsAtomically([
    { path: one, config: { version: 1, overrides: [{ name: 'a', action: 'replace', text: 'A' }] } },
    { path: two, config: { version: 1, overrides: [{ name: 'b', action: 'hide' }] } },
  ]);
  assert.deepEqual(result.paths, [one, two]);
  assert.deepEqual(JSON.parse(readFileSync(one, 'utf8')).overrides, [{ name: 'a', action: 'replace', text: 'A' }]);
  assert.deepEqual(JSON.parse(readFileSync(two, 'utf8')).overrides, [{ name: 'b', action: 'hide' }]);
  for (const directory of [join(home, 'one'), join(home, 'two')]) {
    assert.equal(readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
  }
});

test('store: a staged file that fails its own re-validation aborts with BOTH targets byte-identical', () => {
  const one = join(home, 'one', 'overrides.json');
  const two = join(home, 'two', 'overrides.json');
  mkdirSync(join(home, 'one'), { recursive: true });
  mkdirSync(join(home, 'two'), { recursive: true });
  writeFileSync(one, '{"version":1,"overrides":[]}\n', 'utf8');
  writeFileSync(two, '{"version":1,"overrides":[]}\n', 'utf8');
  const beforeOne = fileHash(one);
  const beforeTwo = fileHash(two);

  assert.throws(
    () => writeConfigsAtomically([
      { path: one, config: { version: 1, overrides: [{ name: 'a', action: 'replace', text: 'A' }] } },
      // A config the reader rejects (wrong schema version) must stop the commit.
      { path: two, config: { version: 9, overrides: [] } },
    ]),
    (error) => error.code === 'import-verify-failed' && error.status === 500,
  );
  assert.equal(fileHash(one), beforeOne, 'the first layer was never replaced');
  assert.equal(fileHash(two), beforeTwo);
  for (const directory of [join(home, 'one'), join(home, 'two')]) {
    assert.equal(readdirSync(directory).some((name) => name.endsWith('.tmp')), false, 'no temp file survives');
  }
});

test('store: an unstaged directory aborts the import with nothing written', () => {
  const one = join(home, 'one', 'overrides.json');
  mkdirSync(join(home, 'one'), { recursive: true });
  writeFileSync(one, '{"version":1,"overrides":[]}\n', 'utf8');
  const beforeOne = fileHash(one);
  // `blocked` is a regular file, so the directory chain for the second layer
  // cannot be created.
  writeFileSync(join(home, 'blocked'), 'not a directory', 'utf8');

  assert.throws(
    () => writeConfigsAtomically([
      { path: one, config: { version: 1, overrides: [{ name: 'a', action: 'hide' }] } },
      { path: join(home, 'blocked', 'overrides.json'), config: { version: 1, overrides: [] } },
    ]),
    (error) => error.code === 'import-staging-failed' || error.code === 'unwritable-directory' || error.status === 500,
  );
  assert.equal(fileHash(one), beforeOne);
  assert.equal(readdirSync(join(home, 'one')).some((name) => name.endsWith('.tmp')), false);
});

// #endregion

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
  LAYER_WIDE_ACTIONS,
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
  resolvePageOffset,
  resetEntries,
  rollbackOverrides,
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

test('history: the action vocabulary is exactly the seven documented values', () => {
  // Revision 7 adds exactly one: `legacy-clear`, the record
  // `DELETE /overrides&legacy=true` writes. The first five are Revision 6's set,
  // unchanged and in the same order, so every existing history file still reads.
  // Revision 21 (g-039) appends `rollback` — also last, also additive: a log
  // written before it still parses, and an old reader's vocabulary is a prefix.
  assert.deepEqual(
    [...HISTORY_ACTIONS],
    ['replace', 'hide', 'append', 'remove', 'reset-layer', 'legacy-clear', 'rollback'],
  );
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

test('history: the layer-wide actions are exactly the ones that carry no name', () => {
  const record = makeRecord(fields({ action: 'reset-layer', name: null, entries: [] }));
  assert.equal(record.name, null);
  assert.throws(() => validateHistoryRecord({ ...record, name: 'x' }), /./);
  assert.throws(() => makeRecord(fields({ action: 'remove', name: null })), (error) => error.code === 'invalid-history-record');

  // Revision 7's addition obeys the same rule, in both directions: its subject
  // is the layer, so it must not name a section …
  const legacy = makeRecord(fields({ action: 'legacy-clear', name: null, entries: [] }));
  assert.equal(legacy.name, null);
  assert.throws(
    () => makeRecord(fields({ action: 'legacy-clear', name: 'a' })),
    (error) => error.code === 'invalid-history-record',
    'a layer-wide action must not name a section',
  );
  // … and it is exactly the two layer-wide actions, not "any action accepted
  // with a null name".
  assert.deepEqual([...LAYER_WIDE_ACTIONS], ['reset-layer', 'legacy-clear']);
  // Revision 21's addition is the opposite shape on purpose: a rollback edits
  // **one** section — the reserved one — so it is an ordinary section record and
  // must name it (Revision 22 narrowed it; §4.1's write face accepts no other
  // name).
  const rollbackRecord = makeRecord(fields({ action: 'rollback', name: 'prompt-setting:custom-prompt' }));
  assert.equal(rollbackRecord.name, 'prompt-setting:custom-prompt');
  assert.throws(
    () => makeRecord(fields({ action: 'rollback', name: null })),
    (error) => error.code === 'invalid-history-record',
    'a rollback names the section it adjusted',
  );
  for (const action of HISTORY_ACTIONS) {
    const isLayerWide = LAYER_WIDE_ACTIONS.includes(action);
    assert.equal(
      (() => {
        try {
          makeRecord(fields({ action, name: isLayerWide ? null : 'a' }));
          return true;
        } catch {
          return false;
        }
      })(),
      true,
      `${action} must be representable with ${isLayerWide ? 'no name' : 'a name'}`,
    );
  }
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

test('history: the page offset is clamped rather than rejected (g-038)', () => {
  // An unusable page number is page one, never an error: an absent, empty,
  // negative, fractional or unparsable value all fall back to 0, and a usable
  // one is floored to an integer.
  assert.equal(resolvePageOffset(null), 0);
  assert.equal(resolvePageOffset(undefined), 0);
  assert.equal(resolvePageOffset(''), 0);
  assert.equal(resolvePageOffset('   '), 0);
  assert.equal(resolvePageOffset('0'), 0);
  assert.equal(resolvePageOffset('-1'), 0);
  assert.equal(resolvePageOffset('-999'), 0);
  assert.equal(resolvePageOffset('nope'), 0);
  assert.equal(resolvePageOffset('NaN'), 0);
  assert.equal(resolvePageOffset('Infinity'), 0);
  assert.equal(resolvePageOffset('7'), 7);
  assert.equal(resolvePageOffset('7.9'), 7);
  assert.equal(resolvePageOffset(' 12 '), 12);
  assert.equal(resolvePageOffset(3), 3);
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

test('history: paging walks the matched list by offset and reports its page (g-038)', () => {
  // Six records, newest first: 6, 5, 4, 3, 2, 1.
  const records = [1, 2, 3, 4, 5, 6].map((seq) => makeRecord(fields({ seq })));

  const first = queryHistory(records, { limit: 2, offset: 0 });
  assert.deepEqual(first.records.map((record) => record.seq), [6, 5]);
  assert.equal(first.total, 6, 'total is every match, never the page');
  assert.equal(first.offset, 0);
  assert.equal(first.pageCount, 3);
  assert.equal(first.hasMore, true);

  const middle = queryHistory(records, { limit: 2, offset: 2 });
  assert.deepEqual(middle.records.map((record) => record.seq), [4, 3]);
  assert.equal(middle.offset, 2);
  assert.equal(middle.hasMore, true);

  const last = queryHistory(records, { limit: 2, offset: 4 });
  assert.deepEqual(last.records.map((record) => record.seq), [2, 1]);
  assert.equal(last.offset, 4);
  assert.equal(last.pageCount, 3);
  assert.equal(last.hasMore, false);

  // A partial last page is still the last page.
  const uneven = queryHistory(records, { limit: 4, offset: 4 });
  assert.deepEqual(uneven.records.map((record) => record.seq), [2, 1]);
  assert.equal(uneven.pageCount, 2);
  assert.equal(uneven.hasMore, false);

  // An offset past the end is clamped to the **start of the last page**, so the
  // reader still sees records instead of an empty window.
  for (const offset of [6, 7, 999]) {
    const clamped = queryHistory(records, { limit: 2, offset });
    assert.deepEqual(clamped.records.map((record) => record.seq), [2, 1], `offset ${offset} clamps`);
    assert.equal(clamped.offset, 4);
    assert.equal(clamped.hasMore, false);
  }
  // A negative or unusable offset is page one (the route resolves, but the pure
  // function must not trust its caller either).
  assert.equal(queryHistory(records, { limit: 2, offset: -4 }).offset, 0);

  // `limit: 0` is the documented "counts alone" request: no page exists.
  const counts = queryHistory(records, { limit: 0, offset: 4 });
  assert.deepEqual(counts.records, []);
  assert.equal(counts.total, 6);
  assert.equal(counts.offset, 0);
  assert.equal(counts.pageCount, 0);
  assert.equal(counts.hasMore, false);

  // No matches at all: one empty page rather than a phantom page 2.
  const none = queryHistory(records, { layer: 'workspace' });
  assert.deepEqual(none.records, []);
  assert.equal(none.total, 0);
  assert.equal(none.pageCount, 0);
  assert.equal(none.hasMore, false);

  // Paging is applied **after** filtering: the page count describes the matches.
  const filtered = queryHistory(records, { name: 'project:alpha', limit: 2, offset: 2 });
  assert.equal(filtered.total, 6, 'every seeded record names the same section');
  assert.deepEqual(filtered.records.map((record) => record.seq), [4, 3]);
  const notMatched = queryHistory(records, { name: 'nothing-named-this', limit: 2, offset: 2 });
  assert.equal(notMatched.total, 0, 'a filter that matches nothing pages nothing');
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

// #region rollback (Revision 21; narrowed to one section in Revision 22, g-039)

/** The reserved section name — the one section a rollback may adjust. */
const R = 'prompt-setting:custom-prompt';

/** A validated layer config holding the given overrides. */
function configOf(overrides) {
  return { version: 1, overrides };
}

/** One snapshot entry, exactly the `{name, action, hash, bytes}` shape. */
function snap(name, action, text = null) {
  const digest = action === 'hide' ? null : digestEntry(text);
  return { name, action, hash: digest === null ? null : digest.hash, bytes: digest === null ? null : digest.bytes };
}

/** One single-section record of a layer's log. */
function sectionRecord({ seq, action, name, before = null, after = null, snapshot, entries = null }) {
  return makeRecord({
    seq,
    at: `2024-01-0${seq}T00:00:00.000Z`,
    layer: 'user',
    session: null,
    action,
    name,
    origin: 'ui',
    before: textEntry(before),
    after: textEntry(after),
    entries,
    snapshot,
  });
}

/** The `code` of the error a call throws, or `null` when it does not throw. */
function codeOf(run) {
  try {
    run();
    return null;
  } catch (error) {
    return error.code;
  }
}

test('rollback: only the named section is adjusted, everything else is carried through untouched', () => {
  // The version `#1` overrode two sections; `#3` later removed the non-reserved
  // one. Rebuilding `#1` must restore the reserved text and must NOT revive the
  // other section: `PUT` / `DELETE` / `import` all refuse a non-reserved name
  // (§4.1, §15.7), so a rollback may not be a fourth write path around that.
  const records = [
    sectionRecord({
      seq: 1,
      action: 'replace',
      name: R,
      after: 'A1',
      snapshot: [snap(R, 'replace', 'A1'), snap('legacy:x', 'replace', 'X1')],
    }),
    sectionRecord({
      seq: 2,
      action: 'replace',
      name: R,
      before: 'A1',
      after: 'A2',
      snapshot: [snap(R, 'replace', 'A2'), snap('legacy:x', 'replace', 'X1')],
    }),
    sectionRecord({
      seq: 3,
      action: 'remove',
      name: 'legacy:x',
      before: 'X1',
      after: null,
      snapshot: [snap(R, 'replace', 'A2')],
    }),
  ];
  const current = configOf([{ name: R, action: 'replace', text: 'A2' }]);
  const result = rollbackOverrides(records, current, 1, R);
  assert.deepEqual(result.overrides, [{ name: R, action: 'replace', text: 'A1' }], 'the non-reserved section is not revived');
  assert.deepEqual(result.structure, [{ name: R, action: 'replace' }, { name: 'legacy:x', action: 'replace' }]);
  assert.deepEqual(result.target, { name: R, action: 'replace' });
});

test('rollback: a non-reserved entry the layer still carries is passed through by reference, in place', () => {
  const records = [
    sectionRecord({
      seq: 1,
      action: 'replace',
      name: R,
      after: 'A1',
      snapshot: [snap(R, 'replace', 'A1'), snap('legacy:old', 'replace', 'OLD')],
    }),
    sectionRecord({
      seq: 2,
      action: 'replace',
      name: R,
      before: 'A1',
      after: 'A2',
      snapshot: [snap(R, 'replace', 'A2'), snap('legacy:old', 'replace', 'OLD')],
    }),
  ];
  const legacy = { name: 'legacy:old', action: 'replace', text: 'KEEP ME', order: undefined };
  delete legacy.order;
  const current = configOf([legacy, { name: R, action: 'replace', text: 'A2' }]);
  // Rolling back to `#1` (which also named the legacy section) leaves that entry
  // alone…
  const toFirst = rollbackOverrides(records, current, 1, R);
  assert.deepEqual(toFirst.overrides, [legacy, { name: R, action: 'replace', text: 'A1' }]);
  assert.equal(toFirst.overrides[0], current.overrides[0], 'carried through by reference, not rebuilt');
  // …and so does a version that never mentioned it at all.
  const legacyOnly = [
    sectionRecord({ seq: 1, action: 'replace', name: R, after: 'A1', snapshot: [snap(R, 'replace', 'A1')] }),
  ];
  const toOnlyReserved = rollbackOverrides(legacyOnly, current, 1, R);
  assert.equal(toOnlyReserved.overrides[0], current.overrides[0]);
  assert.deepEqual(toOnlyReserved.overrides.map((entry) => entry.name), ['legacy:old', R], 'position is kept too');
});

test('rollback: a version that did not hold the named section removes it from the layer', () => {
  // `#1` predates the reserved section entirely (a pre-Revision-7 log): its
  // snapshot names one other section and nothing else.
  const records = [
    sectionRecord({
      seq: 1,
      action: 'replace',
      name: 'legacy:x',
      after: 'X1',
      snapshot: [snap('legacy:x', 'replace', 'X1')],
    }),
    sectionRecord({
      seq: 2,
      action: 'replace',
      name: R,
      after: 'A1',
      snapshot: [snap('legacy:x', 'replace', 'X1'), snap(R, 'replace', 'A1')],
    }),
  ];
  const current = configOf([
    { name: 'legacy:x', action: 'replace', text: 'X1' },
    { name: R, action: 'replace', text: 'A1' },
  ]);
  const result = rollbackOverrides(records, current, 1, R);
  assert.deepEqual(result.overrides, [{ name: 'legacy:x', action: 'replace', text: 'X1' }], 'the reserved entry is dropped');
  assert.equal(result.target, null, 'and the caller is told the version did not hold it');
});

test('rollback: a section-level rollback record replays like any other write', () => {
  // `#2` is the record a rollback appends: `name` is the reserved section and
  // `before` / `after` are its text on either side — no layer-wide `entries`.
  const records = [
    sectionRecord({ seq: 1, action: 'replace', name: R, after: 'A1', snapshot: [snap(R, 'replace', 'A1')] }),
    sectionRecord({
      seq: 2,
      action: 'replace',
      name: R,
      before: 'A1',
      after: 'A2',
      snapshot: [snap(R, 'replace', 'A2')],
    }),
    makeRecord({
      seq: 3,
      at: '2024-01-03T00:00:00.000Z',
      layer: 'user',
      session: null,
      action: 'rollback',
      name: R,
      origin: 'ui',
      before: textEntry('A2'),
      after: textEntry('A1'),
      entries: null,
      snapshot: [snap(R, 'replace', 'A1')],
      note: 'rollback to #1',
    }),
  ];
  const current = configOf([{ name: R, action: 'replace', text: 'A1' }]);
  // The rollback's own version: the file already IS that version.
  assert.deepEqual(rollbackOverrides(records, current, 3, R).overrides, [{ name: R, action: 'replace', text: 'A1' }]);
  // Rolling back again, to the version the rollback replaced: undoing the
  // section-level record restores its `before` text.
  assert.deepEqual(rollbackOverrides(records, current, 2, R).overrides, [{ name: R, action: 'replace', text: 'A2' }]);
  // …and to `#1`, through both.
  assert.deepEqual(rollbackOverrides(records, current, 1, R).overrides, [{ name: R, action: 'replace', text: 'A1' }]);
});

test('rollback: a hidden section needs no text, and a whole-layer clear is undone from its entries', () => {
  const hidden = [
    sectionRecord({ seq: 1, action: 'hide', name: R, after: null, snapshot: [snap(R, 'hide')] }),
  ];
  // A `hide` has no text by definition, so the structure alone is the answer.
  assert.deepEqual(
    rollbackOverrides(hidden, configOf([]), 1, R).overrides,
    [{ name: R, action: 'hide' }],
    'a hidden section is rebuilt from the structure',
  );

  const cleared = [
    sectionRecord({ seq: 1, action: 'replace', name: R, after: 'A1', snapshot: [snap(R, 'replace', 'A1')] }),
    makeRecord({
      seq: 2,
      at: '2024-01-02T00:00:00.000Z',
      layer: 'user',
      session: null,
      action: 'reset-layer',
      name: null,
      origin: 'ui',
      before: null,
      after: null,
      entries: [{ name: R, action: 'replace', text: 'A1' }],
      snapshot: [],
      note: 'reset removed 1 override(s)',
    }),
  ];
  assert.deepEqual(
    rollbackOverrides(cleared, configOf([]), 1, R).overrides,
    [{ name: R, action: 'replace', text: 'A1' }],
    'the clear is undone from what it recorded',
  );
  // The clear's own version has an empty snapshot and is refused rather than
  // invented (`?reset=true` is the way to an empty layer, and says so).
  assert.equal(codeOf(() => rollbackOverrides(cleared, configOf([]), 2, R)), 'history-snapshot-missing');
  // A clear that recorded nothing cannot be undone at all.
  const noEntries = [
    sectionRecord({ seq: 1, action: 'replace', name: R, after: 'A1', snapshot: [snap(R, 'replace', 'A1')] }),
    { ...cleared[1], entries: null, snapshot: [snap(R, 'replace', 'A1')] },
  ];
  assert.equal(codeOf(() => rollbackOverrides(noEntries, configOf([]), 1, R)), 'history-replay-unavailable');
});

test('rollback: every refusal is a stable code, never a guessed config', () => {
  const one = sectionRecord({ seq: 1, action: 'replace', name: R, after: 'A1', snapshot: [snap(R, 'replace', 'A1')] });
  const current = configOf([{ name: R, action: 'replace', text: 'A1' }]);
  assert.equal(codeOf(() => rollbackOverrides([one], current, 9, R)), 'history-not-found');
  assert.equal(codeOf(() => rollbackOverrides([one], current, 0, R)), 'history-not-found');
  assert.equal(codeOf(() => rollbackOverrides([one], current, 1, '')), 'invalid-section-name');
  assert.equal(codeOf(() => rollbackOverrides([one], current, 1, null)), 'invalid-section-name');

  // No snapshot at all (an old record), and an empty one (a whole-layer clear):
  // both are refusals, because neither describes a structure to restore.
  assert.equal(codeOf(() => rollbackOverrides([{ ...one, snapshot: undefined }], current, 1, R)), 'history-snapshot-missing');
  assert.equal(codeOf(() => rollbackOverrides([{ ...one, snapshot: [] }], current, 1, R)), 'history-snapshot-missing');

  // A malformed snapshot: a bad action, a non-object entry, a duplicate name,
  // an entry without a name.
  for (const snapshot of [
    [{ name: R, action: 'nope' }],
    ['a'],
    [{ name: R, action: 'replace' }, { name: R, action: 'replace' }],
    [{ action: 'replace' }],
  ]) {
    assert.equal(
      codeOf(() => rollbackOverrides([{ ...one, snapshot }], current, 1, R)),
      'invalid-history-snapshot',
      JSON.stringify(snapshot),
    );
  }

  // The version asks for text of the reserved section that the chain cannot
  // supply (the file was edited by hand): refuse rather than guess.
  assert.equal(codeOf(() => rollbackOverrides([one], configOf([]), 1, R)), 'history-rollback-unavailable');
});

// #endregion

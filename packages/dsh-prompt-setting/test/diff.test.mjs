/**
 * Unit assertions for the stage 2 diff kernel (`core/diff.js`).
 *
 * The interesting cases are the ones a real prompt produces: empty text, CRLF
 * line endings, one enormous line, and a text too large for the exact LCS — the
 * last one must be *reported* as a bounded comparison rather than passed off as
 * exact.
 *
 * Run: `node --test test/`
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_DIFF_CELLS,
  MAX_DIFF_LINES,
  MAX_DIFF_OPS,
  buildDiff,
  countStatuses,
  diffLines,
  diffSnapshots,
  focusSection,
  normalizeLines,
} from '../core/diff.js';

/** `{name, action, hash, bytes}` snapshot entries for a compact fixture. */
function snapshot(pairs) {
  return pairs.map(([name, hash, bytes, action = 'replace']) => ({ name, action, hash, bytes }));
}

/** One diff side. */
function side(over = {}) {
  return {
    kind: 'history',
    label: '#1',
    layer: 'user',
    session: null,
    snapshot: [],
    texts: {},
    id: '1',
    seq: 1,
    at: '2024-01-01T00:00:00.000Z',
    action: 'replace',
    name: 'a',
    ...over,
  };
}

// #region line splitting

test('diff: line splitting treats CRLF and CR as line endings and says so', () => {
  assert.deepEqual(normalizeLines('a\r\nb'), { lines: ['a', 'b'], crlf: true });
  assert.deepEqual(normalizeLines('a\rb'), { lines: ['a', 'b'], crlf: true });
  assert.deepEqual(normalizeLines('a\nb'), { lines: ['a', 'b'], crlf: false });
  assert.deepEqual(normalizeLines(''), { lines: [''], crlf: false });
  assert.deepEqual(normalizeLines(null), { lines: [''], crlf: false });
  assert.deepEqual(normalizeLines('a\nb\n'), { lines: ['a', 'b', ''], crlf: false });
});

// #endregion

// #region line diff

test('diff: an unchanged text is all-equal ops with zero additions and removals', () => {
  const diff = diffLines('one\ntwo', 'one\ntwo');
  assert.equal(diff.stats.added, 0);
  assert.equal(diff.stats.removed, 0);
  assert.equal(diff.stats.same, 2);
  assert.equal(diff.mode, 'lcs');
  assert.equal(diff.truncated, false);
  assert.equal(diff.crlfNormalized, false);
  assert.deepEqual(diff.ops.map((op) => op.type), ['equal', 'equal']);
});

test('diff: a changed line in the middle is exact, not a whole-text replacement', () => {
  const diff = diffLines('head\nold line\ntail', 'head\nnew line\ntail');
  assert.deepEqual(diff.ops.map((op) => [op.type, op.text]), [
    ['equal', 'head'],
    ['delete', 'old line'],
    ['insert', 'new line'],
    ['equal', 'tail'],
  ]);
  assert.deepEqual(diff.stats, { added: 1, removed: 1, same: 2 });
  assert.equal(diff.mode, 'lcs');
  assert.deepEqual(diff.ops[1].beforeLine, 2);
  assert.equal(diff.ops[1].afterLine, null);
  assert.equal(diff.ops[2].beforeLine, null);
  assert.deepEqual(diff.ops[2].afterLine, 2);
});

test('diff: a pure insertion and a pure deletion are distinguished', () => {
  const inserted = diffLines('a\nc', 'a\nb\nc');
  assert.deepEqual(inserted.ops.map((op) => op.type), ['equal', 'insert', 'equal']);
  assert.deepEqual(inserted.stats, { added: 1, removed: 0, same: 2 });

  const deleted = diffLines('a\nb\nc', 'a\nc');
  assert.deepEqual(deleted.ops.map((op) => op.type), ['equal', 'delete', 'equal']);
  assert.deepEqual(deleted.stats, { added: 0, removed: 1, same: 2 });
});

test('diff: empty text against text is a real, reportable change', () => {
  const fromEmpty = diffLines('', 'hello');
  assert.deepEqual(fromEmpty.stats, { added: 1, removed: 1, same: 0 }, 'the empty string is one empty line');
  assert.deepEqual(fromEmpty.ops.map((op) => [op.type, op.text]), [['delete', ''], ['insert', 'hello']]);

  const toEmpty = diffLines('hello', '');
  assert.deepEqual(toEmpty.stats, { added: 1, removed: 1, same: 0 });
  assert.deepEqual(toEmpty.ops.map((op) => [op.type, op.text]), [['delete', 'hello'], ['insert', '']]);

  const bothEmpty = diffLines('', '');
  assert.deepEqual(bothEmpty.stats, { added: 0, removed: 0, same: 1 });
});

test('diff: CRLF against LF reports the flag and diffs only the changed line', () => {
  const diff = diffLines('a\r\nb\r\nc', 'a\nB\nc');
  assert.equal(diff.crlfNormalized, true);
  assert.deepEqual(diff.stats, { added: 1, removed: 1, same: 2 });
  assert.deepEqual(diff.ops.map((op) => op.text), ['a', 'b', 'B', 'c']);

  const identicalModuloEol = diffLines('a\r\nb', 'a\nb');
  assert.equal(identicalModuloEol.crlfNormalized, true);
  assert.deepEqual(identicalModuloEol.stats, { added: 0, removed: 0, same: 2 }, 'line endings alone are not a change');
});

test('diff: one very long line is compared exactly and never truncated', () => {
  const long = `x${'y'.repeat(200000)}`;
  const changed = `${long}z`;
  const diff = diffLines(long, changed);
  assert.equal(diff.mode, 'lcs');
  assert.equal(diff.truncated, false);
  assert.deepEqual(diff.stats, { added: 1, removed: 1, same: 0 });
  assert.equal(diff.ops[0].text.length, long.length, 'the full line is carried through');
  assert.equal(diff.ops[1].text.length, changed.length);
});

test('diff: a text past the line budget degrades to a bounded comparison and says so', () => {
  const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
  const after = before.replace('line 20', 'LINE TWENTY');
  const diff = diffLines(before, after, { maxLines: 10 });
  assert.equal(diff.mode, 'bounded');
  assert.equal(diff.crlfNormalized, false);
  // The shared prefix and suffix survive; the changed middle is one block each.
  assert.equal(diff.ops[0].text, 'line 0');
  assert.equal(diff.stats.same, 39, '20 shared prefix + 19 shared suffix lines stay equal');
  assert.deepEqual([diff.stats.added, diff.stats.removed], [1, 1], 'the one changed line is the differing middle');
  assert.equal(diff.ops.some((op) => op.type === 'equal' && op.text === 'line 20'), false);
  assert.equal(diff.ops.filter((op) => op.type === 'delete')[0].text, 'line 20');
  assert.equal(diff.ops.filter((op) => op.type === 'insert')[0].text, 'LINE TWENTY');
});

test('diff: the exact table has a documented cell budget', () => {
  const half = Math.sqrt(MAX_DIFF_CELLS);
  const many = Array.from({ length: Math.ceil(half) + 1 }, (_, index) => `l${index}`).join('\n');
  assert.equal(diffLines(many, many, { maxCells: 4 }).mode, 'bounded');
  // The budget is compared against `(lines + 1) * (lines + 1)`: three lines is
  // nine cells, so a budget of nine is still exact and eight is not.
  assert.equal((2 + 1) * (2 + 1), 9);
  assert.equal(diffLines('a\nb', 'a\nb', { maxCells: 9 }).mode, 'lcs');
  assert.equal(diffLines('a\nb', 'a\nb', { maxCells: 8 }).mode, 'bounded');
  assert.equal(MAX_DIFF_LINES >= 1000, true, 'the line budget is generous for a real prompt');
});

test('diff: a diff longer than the op cap is cut and flagged, never silently huge', () => {
  const before = Array.from({ length: 60 }, (_, index) => `a${index}`).join('\n');
  const after = Array.from({ length: 60 }, (_, index) => `b${index}`).join('\n');
  const diff = diffLines(before, after, { maxOps: 10 });
  assert.equal(diff.ops.length, 10);
  assert.equal(diff.truncated, true);
  assert.equal(diff.stats.added + diff.stats.removed, 120, 'the stats still describe the whole change');
  assert.equal(MAX_DIFF_OPS >= 1000, true);
});

// #endregion

// #region snapshot diff

test('diff: a snapshot diff reports same, changed, added and removed by name', () => {
  const rows = diffSnapshots(
    snapshot([['a', 'h1', 1], ['b', 'h2', 2], ['gone', 'h3', 3]]),
    snapshot([['a', 'h1', 1], ['b', 'h9', 4], ['new', 'h4', 5]]),
  );
  assert.deepEqual(rows.map((row) => [row.name, row.status]), [
    ['a', 'same'],
    ['b', 'changed'],
    ['gone', 'removed'],
    ['new', 'added'],
  ]);
  assert.deepEqual(countStatuses(rows), { total: 4, changed: 1, added: 1, removed: 1, same: 1 });
  assert.equal(rows[1].before.hash, 'h2');
  assert.equal(rows[1].after.hash, 'h9');
  assert.equal(rows[2].after, null);
  assert.equal(rows[3].before, null);
});

test('diff: an action change alone marks a section changed even with identical bytes', () => {
  const rows = diffSnapshots(
    snapshot([['a', 'h1', 2, 'replace']]),
    snapshot([['a', 'h1', 2, 'hide']]),
  );
  assert.equal(rows[0].status, 'changed');
});

test('diff: two empty snapshots produce no rows and zero counts', () => {
  const rows = diffSnapshots([], []);
  assert.deepEqual(rows, []);
  assert.deepEqual(countStatuses(rows), { total: 0, changed: 0, added: 0, removed: 0, same: 0 });
  assert.deepEqual(countStatuses(null), { total: 0, changed: 0, added: 0, removed: 0, same: 0 });
});

// #endregion

// #region focus selection

test('diff: the focus section is explicit, then shared, then the single change', () => {
  const rows = [
    { name: 'a', status: 'changed' },
    { name: 'b', status: 'same' },
    { name: 'c', status: 'added' },
  ];
  assert.deepEqual(focusSection(rows, { focusName: 'b' }), { name: 'b', reason: null });
  assert.deepEqual(focusSection([{ name: 'a', status: 'same' }], { fromName: 'a', toName: 'a' }), { name: 'a', reason: null });
  assert.deepEqual(focusSection([{ name: 'one', status: 'changed' }, { name: 'two', status: 'same' }], {}), { name: 'one', reason: null });

  const ambiguous = focusSection(rows, {});
  assert.equal(ambiguous.name, null);
  assert.match(ambiguous.reason, /more than one section differs/);

  const explicitMissing = focusSection(rows, { focusName: 'zzz' });
  assert.equal(explicitMissing.name, null);
  assert.match(explicitMissing.reason, /no section named "zzz" differs/);

  const identical = focusSection([{ name: 'a', status: 'same' }], {});
  assert.equal(identical.name, null);
  assert.match(identical.reason, /identical/);

  // Nothing differs, but one side is about a section that is present: the
  // caller still gets that section's text compared.
  assert.deepEqual(focusSection([{ name: 'a', status: 'same' }], { fromName: 'a', toName: null }), { name: 'a', reason: null });
  // One side's own section is preferred over an ambiguous multi-section change.
  assert.deepEqual(focusSection(rows, { fromName: 'x', toName: 'c' }), { name: 'c', reason: null });
});

// #endregion

// #region buildDiff

test('diff: two versions of the same section produce section and line results', () => {
  const payload = buildDiff({
    from: side({ seq: 1, id: '1', name: 'a', snapshot: snapshot([['a', 'h1', 5], ['b', 'h2', 5]]), texts: { a: 'one\ntwo' } }),
    to: side({ seq: 2, id: '2', name: 'a', snapshot: snapshot([['a', 'h9', 9], ['b', 'h2', 5]]), texts: { a: 'one\nTWO\nthree' } }),
  });
  assert.equal(payload.scope, 'layer');
  assert.deepEqual(payload.sectionsCounts, { total: 2, changed: 1, added: 0, removed: 0, same: 1 });
  assert.equal(payload.from.id, '1');
  assert.equal(payload.to.id, '2');
  assert.equal(payload.lines.name, 'a');
  assert.deepEqual(payload.lines.stats, { added: 2, removed: 1, same: 1 });
  assert.equal(payload.lineReason, null);
  assert.deepEqual(payload.stats, { added: 0, removed: 0, changed: 1, same: 1, lineAdded: 2, lineRemoved: 1 });
  assert.equal(payload.from.texts, undefined, 'the payload never dumps both texts');
});

test('diff: a history version against current compares names and one section text', () => {
  const payload = buildDiff({
    from: side({ name: 'a', snapshot: snapshot([['a', 'h1', 1]]), texts: { a: 'old' } }),
    to: side({
      kind: 'current',
      label: 'current',
      id: null,
      seq: null,
      at: null,
      name: null,
      snapshot: snapshot([['a', 'h1', 1], ['b', 'h2', 2]]),
      texts: { a: 'old', b: 'brand new' },
    }),
    focusName: 'b',
  });
  assert.deepEqual(payload.sectionsCounts, { total: 2, changed: 0, added: 1, removed: 0, same: 1 });
  assert.equal(payload.lines.name, 'b');
  assert.equal(payload.to.kind, 'current');
  assert.equal(payload.to.at, null);
});

test('diff: an ambiguous comparison says why instead of guessing a section', () => {
  // Two sections differ and neither side is about one of them (both sides are
  // layer versions with no single subject), so no section may be picked.
  const payload = buildDiff({
    from: side({ name: null, snapshot: snapshot([['a', 'h1', 1], ['b', 'h2', 2]]), texts: { a: 'x', b: 'y' } }),
    to: side({ kind: 'current', name: null, snapshot: snapshot([['a', 'h9', 3], ['b', 'h8', 4]]), texts: { a: 'x2', b: 'y2' } }),
  });
  assert.equal(payload.lines, null);
  assert.match(payload.lineReason, /more than one section differs/);
  assert.deepEqual(payload.stats, { added: 0, removed: 0, changed: 2, same: 0, lineAdded: 0, lineRemoved: 0 });
});

test('diff: a two-section change still compares the section one side is about', () => {
  const payload = buildDiff({
    from: side({ name: 'a', snapshot: snapshot([['a', 'h1', 1], ['b', 'h2', 2]]), texts: { a: 'x' } }),
    to: side({ seq: 2, id: '2', name: 'b', snapshot: snapshot([['a', 'h9', 3], ['b', 'h8', 4]]), texts: { b: 'y' } }),
  });
  assert.equal(payload.lines.name, 'a', 'the older side names the section it is about');
  assert.deepEqual(payload.lines.stats, { added: 1, removed: 1, same: 0 });
});

test('diff: a version with no text on either side reports no line diff, with a reason', () => {
  const payload = buildDiff({
    from: side({ action: 'remove', name: 'a', snapshot: [], texts: { a: null } }),
    to: side({ seq: 2, action: 'remove', name: 'a', snapshot: [], texts: { a: null } }),
  });
  assert.equal(payload.lines, null);
  assert.match(payload.lineReason, /neither version holds text/);
  assert.deepEqual(payload.sectionsCounts, { total: 0, changed: 0, added: 0, removed: 0, same: 0 });
});

// #endregion

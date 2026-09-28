/**
 * Unit assertions for the stage 2 export/import kernel (`core/transfer.js`).
 *
 * This is where the conflict strategy and the strictness of an import document
 * are pinned. The kernel does no IO, which is what lets the route's atomicity
 * guarantee rest on it: a document that fails any check here never reaches the
 * store at all.
 *
 * Run: `node --test test/`
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPORT_LAYERS,
  EXPORT_SCHEMA,
  EXPORT_VERSION,
  IMPORT_MODES,
  buildExport,
  parseExport,
  planImport,
  publicPlan,
  resolveMode,
  totalCounts,
} from '../core/transfer.js';

/** A public layer view for {@link buildExport}. */
function layerView(overrides, over = {}) {
  return { layer: 'user', enabled: true, path: '/home/u/.dsh/prompt-setting/overrides.json', reason: null, overrides, ...over };
}

/** A valid export document. */
function document(over = {}) {
  return {
    schema: EXPORT_SCHEMA,
    version: EXPORT_VERSION,
    exportedAt: '2024-01-01T00:00:00.000Z',
    plugin: { name: 'dsh-prompt-setting', version: '0.1.0' },
    layers: {
      user: { layer: 'user', enabled: true, reason: null, overrides: [{ name: 'a', action: 'replace', text: 'A' }] },
      workspace: { layer: 'workspace', enabled: false, reason: 'no session', overrides: [] },
    },
    ...over,
  };
}

// #region export document

test('transfer: an export carries its schema, version, time, plugin identity and layers', () => {
  const built = buildExport({
    layers: {
      user: layerView([{ name: 'a', action: 'replace', text: 'A' }]),
      workspace: layerView([], { layer: 'workspace', enabled: false, path: null, reason: 'no ?session=' }),
    },
    pluginVersion: '0.1.0',
    exportedAt: '2024-01-01T00:00:00.000Z',
  });
  assert.equal(built.schema, 'dsh-prompt-setting/export');
  assert.equal(built.version, 1);
  assert.equal(built.exportedAt, '2024-01-01T00:00:00.000Z');
  assert.equal(built.pluginVersion, '0.1.0');
  assert.deepEqual(built.plugin, { name: 'dsh-prompt-setting', version: '0.1.0' });
  assert.deepEqual(Object.keys(built.layers), ['user', 'workspace']);
  assert.deepEqual(built.layers.user.overrides, [{ name: 'a', action: 'replace', text: 'A' }]);
  assert.equal(built.layers.workspace.enabled, false);
  assert.equal(built.layers.workspace.reason, 'no ?session=');
  assert.equal(JSON.stringify(built).includes('/home/u/'), false, 'a path is never exported');
});

test('transfer: an export can be limited to one layer', () => {
  const built = buildExport({
    layers: { user: layerView([]), workspace: layerView([], { layer: 'workspace' }) },
    pluginVersion: '0.1.0',
    exportedAt: '2024-01-01T00:00:00.000Z',
    layerNames: ['user'],
  });
  assert.deepEqual(Object.keys(built.layers), ['user']);
  assert.deepEqual(EXPORT_LAYERS, ['user', 'workspace']);
});

// #endregion

// #region import validation

test('transfer: a well-formed document parses to validated override lists', () => {
  const parsed = parseExport(document());
  assert.equal(parsed.schema, EXPORT_SCHEMA);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.exportedAt, '2024-01-01T00:00:00.000Z');
  assert.deepEqual(parsed.layers.user, [{ name: 'a', action: 'replace', text: 'A' }]);
  assert.deepEqual(parsed.layers.workspace, []);
});

test('transfer: every malformed document is rejected with a stable code', () => {
  const cases = [
    [null, 'invalid-export'],
    ['{}', 'invalid-export'],
    [[], 'invalid-export'],
    [{ version: 1, layers: {} }, 'unknown-export-schema'],
    [document({ schema: 'other' }), 'unknown-export-schema'],
    [document({ version: undefined }), 'missing-export-version'],
    [document({ version: '1' }), 'missing-export-version'],
    [document({ version: 2 }), 'unsupported-export-version'],
    [document({ version: 0 }), 'unsupported-export-version'],
    [document({ layers: undefined }), 'missing-export-layers'],
    [document({ layers: [] }), 'missing-export-layers'],
    [document({ layers: {} }), 'missing-export-layers'],
    [document({ layers: { user: 'nope' } }), 'invalid-export-layer'],
    [document({ layers: { user: { overrides: 'nope' } } }), 'invalid-export-layer'],
    // Field validation reuses the stage 1 codes, with the location in the message.
    [document({ layers: { user: { overrides: [{ name: 'a', action: 'nope' }] } } }), 'unknown-action'],
    [document({ layers: { user: { overrides: [{ name: '', action: 'replace', text: 'x' }] } } }), 'missing-name'],
    [document({ layers: { user: { overrides: [{ name: 'a', action: 'replace' }] } } }), 'missing-text'],
    [document({ layers: { user: { overrides: [{ name: 'a', action: 'hide', text: 'x' }] } } }), 'unexpected-text'],
    [document({ layers: { user: { overrides: [{ name: 'a', action: 'append', text: 'x', order: -1 }] } } }), 'invalid-order'],
    [document({ layers: { user: { overrides: [{ name: 'a', action: 'hide', order: 1 }] } } }), 'unexpected-order'],
    [
      document({
        layers: {
          user: {
            overrides: [
              { name: 'a', action: 'replace', text: 'x' },
              { name: 'a', action: 'replace', text: 'y' },
            ],
          },
        },
      }),
      'duplicate-name',
    ],
  ];
  for (const [input, code] of cases) {
    assert.throws(() => parseExport(input), (error) => error.code === code, `${JSON.stringify(input)} => ${code}`);
  }
});

test('transfer: a field error names the exact location inside the document', () => {
  assert.throws(
    () => parseExport(document({ layers: { user: { overrides: [{ name: 'ok', action: 'replace', text: 'x' }, { name: 'bad', action: 'nope' }] } } })),
    (error) => error.code === 'unknown-action' && error.message.includes('layers.user.overrides[1]'),
  );
});

test('transfer: an over-large text is refused with the existing 413 code', () => {
  assert.throws(
    () => parseExport(document({
      layers: { user: { overrides: [{ name: 'a', action: 'replace', text: 'x'.repeat(200 * 1024 + 1) }] } },
    })),
    (error) => error.code === 'text-too-large' && error.status === 413,
  );
});

test('transfer: a literal empty body is refused rather than read as an empty import', () => {
  assert.throws(() => parseExport({}), (error) => error.code === 'unknown-export-schema');
  assert.equal(IMPORT_MODES.join(','), 'merge,replace');
});

// #endregion

// #region conflict strategy

test('transfer: an unknown mode is an error, an absent one is "merge"', () => {
  assert.equal(resolveMode(null), 'merge');
  assert.equal(resolveMode(''), 'merge');
  assert.equal(resolveMode(' merge '), 'merge');
  assert.equal(resolveMode('replace'), 'replace');
  assert.throws(() => resolveMode('overwrite'), (error) => error.code === 'unknown-import-mode');
});

test('transfer: merge takes the imported value on a clash and keeps local extras', () => {
  const plan = planImport({
    imported: [
      { name: 'a', action: 'replace', text: 'IMPORTED' },
      { name: 'c', action: 'replace', text: 'NEW' },
    ],
    current: {
      version: 1,
      overrides: [
        { name: 'a', action: 'replace', text: 'LOCAL' },
        { name: 'b', action: 'hide' },
      ],
    },
    mode: 'merge',
  });
  assert.deepEqual(plan.next.overrides.map((entry) => [entry.name, entry.text ?? null]), [
    ['a', 'IMPORTED'],
    ['b', null],
    ['c', 'NEW'],
  ]);
  assert.deepEqual(plan.changes.map((change) => [change.name, change.status]), [
    ['a', 'replaced'],
    ['c', 'added'],
  ]);
  assert.equal(plan.counts.kept, 1, 'b is a local entry the document does not mention');
  assert.deepEqual(plan.removed, []);
});

test('transfer: an identical entry is reported as unchanged, not rewritten', () => {
  const plan = planImport({
    imported: [{ name: 'a', action: 'replace', text: 'SAME' }],
    current: { version: 1, overrides: [{ name: 'a', action: 'replace', text: 'SAME' }] },
    mode: 'merge',
  });
  assert.deepEqual(plan.counts, { added: 0, replaced: 0, unchanged: 1, removed: 0, kept: 0 });
  assert.equal(plan.changes[0].status, 'unchanged');
  assert.deepEqual(plan.next.overrides, [{ name: 'a', action: 'replace', text: 'SAME' }]);
});

test('transfer: a differing action or order is a change even with the same text', () => {
  const byAction = planImport({
    imported: [{ name: 'a', action: 'hide' }],
    current: { version: 1, overrides: [{ name: 'a', action: 'replace', text: 'x' }] },
  });
  assert.equal(byAction.changes[0].status, 'replaced');
  const byOrder = planImport({
    imported: [{ name: 'a', action: 'append', text: 'x', order: 2 }],
    current: { version: 1, overrides: [{ name: 'a', action: 'append', text: 'x', order: 1 }] },
  });
  assert.equal(byOrder.changes[0].status, 'replaced');
});

test('transfer: replace makes the layer exactly the document, removing local extras', () => {
  const plan = planImport({
    imported: [{ name: 'a', action: 'replace', text: 'IMPORTED' }],
    current: {
      version: 1,
      overrides: [
        { name: 'a', action: 'replace', text: 'LOCAL' },
        { name: 'b', action: 'hide' },
      ],
    },
    mode: 'replace',
  });
  assert.deepEqual(plan.next.overrides.map((entry) => entry.name), ['a']);
  assert.deepEqual(plan.changes.map((change) => [change.name, change.status]), [
    ['a', 'replaced'],
    ['b', 'removed'],
  ]);
  assert.deepEqual(plan.counts, { added: 0, replaced: 1, unchanged: 0, removed: 1, kept: 0 });
  assert.deepEqual(plan.removed.map((entry) => entry.name), ['b']);
  assert.equal(plan.changes[1].after, null);
  assert.equal(plan.changes[1].before.text, undefined);
});

test('transfer: an empty document is a no-op in merge mode and a wipe in replace mode', () => {
  const current = { version: 1, overrides: [{ name: 'a', action: 'hide' }] };
  const merge = planImport({ imported: [], current, mode: 'merge' });
  assert.deepEqual(merge.counts, { added: 0, replaced: 0, unchanged: 0, removed: 0, kept: 1 });
  assert.deepEqual(merge.next.overrides, current.overrides);

  const replace = planImport({ imported: [], current, mode: 'replace' });
  assert.deepEqual(replace.next.overrides, []);
  assert.deepEqual(replace.counts, { added: 0, replaced: 0, unchanged: 0, removed: 1, kept: 0 });
});

test('transfer: an unusable mode falls back to merge instead of guessing "replace"', () => {
  const plan = planImport({
    imported: [{ name: 'a', action: 'hide' }],
    current: { version: 1, overrides: [{ name: 'b', action: 'hide' }] },
    mode: 'whatever',
  });
  assert.deepEqual(plan.next.overrides.map((entry) => entry.name), ['b', 'a']);
});

// #endregion

// #region response shapes

test('transfer: the public plan reports counts and statuses without any text', () => {
  const plan = planImport({
    imported: [{ name: 'a', action: 'replace', text: 'SECRET TEXT' }],
    current: { version: 1, overrides: [] },
  });
  const published = publicPlan(plan);
  assert.deepEqual(published.counts, { added: 1, replaced: 0, unchanged: 0, removed: 0, kept: 0 });
  assert.deepEqual(published.changes, [{ name: 'a', status: 'added', action: 'replace' }]);
  assert.equal(JSON.stringify(published).includes('SECRET'), false);
});

test('transfer: totals sum every layer plan, and an absent layer contributes nothing', () => {
  const totals = totalCounts({
    user: planImport({ imported: [{ name: 'a', action: 'hide' }], current: { version: 1, overrides: [] } }),
    workspace: planImport({
      imported: [],
      current: { version: 1, overrides: [{ name: 'b', action: 'hide' }] },
      mode: 'replace',
    }),
  });
  assert.deepEqual(totals, { added: 1, replaced: 0, unchanged: 0, removed: 1, kept: 0 });
  assert.deepEqual(totalCounts(null), { added: 0, replaced: 0, unchanged: 0, removed: 0, kept: 0 });
});

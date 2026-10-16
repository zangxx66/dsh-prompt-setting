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
  EXPORT_ACCEPTED_VERSIONS,
  EXPORT_LAYERS,
  EXPORT_SCHEMA,
  EXPORT_VERSION,
  IMPORT_MODES,
  buildExport,
  parseExport,
  parseExportWorkspaces,
  planImport,
  publicPlan,
  resolveMode,
  totalCounts,
  validateWorkspaceRoot,
} from '../core/transfer.js';

/** A public layer view for {@link buildExport}. */
function layerView(overrides, over = {}) {
  return { layer: 'user', enabled: true, path: '/home/u/.dsh/prompt-setting/overrides.json', reason: null, overrides, ...over };
}

/** A valid version 2 export document. */
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
    workspaces: [{ root: '/home/u/project', enabled: true, reason: null, overrides: [{ name: 'b', action: 'hide' }] }],
    presets: { version: 1, presets: [], applied: [] },
    preferences: { updateCheck: false, downloadRegion: 'cn' },
    ...over,
  };
}

// #region export document

test('transfer: a full export carries its schema, version, time, plugin identity, every layer and the two installation documents', () => {
  const built = buildExport({
    layers: {
      user: layerView([{ name: 'a', action: 'replace', text: 'A' }]),
      workspace: layerView([], { layer: 'workspace', enabled: false, path: null, reason: 'no ?session=' }),
    },
    workspaceLayers: [{ root: '/home/u/project', enabled: true, reason: null, overrides: [{ name: 'b', action: 'hide' }] }],
    presets: { version: 1, presets: [{ id: 'p1', name: 'P', action: 'replace', text: 'T', createdAt: null, updatedAt: null }], applied: [] },
    preferences: { updateCheck: false },
    pluginVersion: '0.1.0',
    exportedAt: '2024-01-01T00:00:00.000Z',
  });
  assert.equal(built.schema, 'dsh-prompt-setting/export');
  assert.equal(built.version, 2);
  assert.deepEqual(EXPORT_ACCEPTED_VERSIONS, [2, 1]);
  assert.equal(built.exportedAt, '2024-01-01T00:00:00.000Z');
  assert.equal(built.pluginVersion, '0.1.0');
  assert.deepEqual(built.plugin, { name: 'dsh-prompt-setting', version: '0.1.0' });
  assert.deepEqual(Object.keys(built.layers), ['user', 'workspace']);
  assert.deepEqual(built.layers.user.overrides, [{ name: 'a', action: 'replace', text: 'A' }]);
  assert.equal(built.layers.workspace.enabled, false);
  assert.equal(built.layers.workspace.reason, 'no ?session=');
  assert.deepEqual(built.workspaces, [{ root: '/home/u/project', enabled: true, reason: null, overrides: [{ name: 'b', action: 'hide' }] }]);
  assert.equal(built.presets.presets.length, 1);
  assert.deepEqual(built.preferences, { updateCheck: false });
  assert.equal(JSON.stringify(built).includes('/home/u/.dsh/'), false, 'a layer view path is never exported');
});

test('transfer: an export can be limited to one layer view', () => {
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

test('transfer: a well-formed document parses to validated override lists, workspaces and documents', () => {
  const parsed = parseExport(document());
  assert.equal(parsed.schema, EXPORT_SCHEMA);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.exportedAt, '2024-01-01T00:00:00.000Z');
  assert.deepEqual(parsed.layers.user, [{ name: 'a', action: 'replace', text: 'A' }]);
  assert.deepEqual(parsed.layers.workspace, []);
  assert.deepEqual(parsed.workspaces, [{ root: '/home/u/project', overrides: [{ name: 'b', action: 'hide' }] }]);
  assert.deepEqual(parsed.presets, { version: 1, presets: [], applied: [] });
  assert.deepEqual(parsed.preferences, { updateCheck: false, downloadRegion: 'cn' });
});

test('transfer: a version 1 backup still imports, frozen names included', () => {
  // The pre-g-074 shape: reserved entries only, and no installation documents.
  const legacy = {
    schema: EXPORT_SCHEMA,
    version: 1,
    exportedAt: '2024-01-01T00:00:00.000Z',
    layers: {
      user: { overrides: [{ name: 'prompt-setting:custom-prompt', action: 'replace', text: 'MINE' }] },
      workspace: { overrides: [{ name: 'keep', action: 'hide' }] },
    },
  };
  const parsed = parseExport(legacy);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.layers.workspace, [{ name: 'keep', action: 'hide' }], 'a frozen name is imported, not refused');
  assert.deepEqual(parsed.workspaces, []);
  assert.equal(parsed.presets, null);
  assert.equal(parsed.preferences, null);
});

test('transfer: a version 1 document carrying version 2 fields is refused rather than half-read', () => {
  assert.throws(
    () => parseExport(document({ version: 1 })),
    (error) => error.code === 'unexpected-export-field',
  );
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
    [document({ version: 3 }), 'unsupported-export-version'],
    [document({ version: 0 }), 'unsupported-export-version'],
    [document({ layers: undefined }), 'missing-export-layers'],
    [document({ layers: [] }), 'missing-export-layers'],
    [document({ layers: {} }), 'missing-export-layers'],
    [document({ layers: { user: 'nope' } }), 'invalid-export-layer'],
    [document({ layers: { user: { overrides: 'nope' } } }), 'invalid-export-layer'],
    // The layer-name whitelist (Revision 53): an unknown layer is refused, not
    // silently ignored.
    [document({ layers: { user: { overrides: [] }, project: { overrides: [] } } }), 'unknown-export-layer'],
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

// #region workspace roots (Revision 53: path safety)

test('transfer: a workspace root must be a legal absolute path', () => {
  for (const good of ['/home/u/project', 'C:\\Users\\u\\project', '\\\\server\\share\\project']) {
    assert.equal(validateWorkspaceRoot(good), good);
  }
  const bad = [
    ['relative/path', 'invalid-workspace-root'],
    ['./project', 'invalid-workspace-root'],
    ['/home/u/../etc', 'invalid-workspace-root'],
    ['/home/u/\u0000evil', 'invalid-workspace-root'],
    ['/', 'invalid-workspace-root'],
    ['C:\\', 'invalid-workspace-root'],
    ['', 'invalid-workspace-root'],
    [null, 'invalid-workspace-root'],
    [42, 'invalid-workspace-root'],
    ['x'.repeat(4097), 'invalid-workspace-root'],
  ];
  for (const [input, code] of bad) {
    assert.throws(() => validateWorkspaceRoot(input), (error) => error.code === code, `${JSON.stringify(input)} => ${code}`);
  }
});

test('transfer: the workspaces array is validated entry by entry', () => {
  const cases = [
    [{ workspaces: 'nope' }, 'invalid-export-workspaces'],
    [{ workspaces: [null] }, 'invalid-export-workspace'],
    [{ workspaces: [{ root: '/a', overrides: [], extra: 1 }] }, 'invalid-export-workspace'],
    [{ workspaces: [{ root: '/a', overrides: 'nope' }] }, 'invalid-export-workspace'],
    [{ workspaces: [{ root: '/a', overrides: [{ name: 'x', action: 'nope' }] }] }, 'unknown-action'],
    [
      { workspaces: [{ root: '/a', overrides: [{ name: 'x', action: 'hide' }, { name: 'x', action: 'hide' }] }] },
      'duplicate-name',
    ],
    [
      { workspaces: [{ root: '/a', overrides: [] }, { root: '/a', overrides: [] }] },
      'duplicate-workspace-root',
    ],
    [{ workspaces: [{ root: 'relative', overrides: [] }] }, 'invalid-workspace-root'],
  ];
  for (const [over, code] of cases) {
    assert.throws(() => parseExport(document(over)), (error) => error.code === code, `${JSON.stringify(over)} => ${code}`);
  }
  // An absent array is an empty one (a version 1 backup, or a narrowed export).
  assert.deepEqual(parseExportWorkspaces(undefined), []);
  assert.deepEqual(parseExportWorkspaces(null), []);
  const parsed = parseExportWorkspaces([{ root: '/a', enabled: true, reason: null, overrides: [{ name: 'x', action: 'hide' }] }]);
  assert.deepEqual(parsed, [{ root: '/a', overrides: [{ name: 'x', action: 'hide' }] }]);
});

// #endregion

// #region the two installation documents (Revision 53)

test('transfer: a preset document is validated strictly, never silently repaired', () => {
  const preset = { id: 'p1', name: 'P', action: 'replace', text: 'T', createdAt: null, updatedAt: null };
  const parsed = parseExport(document({ presets: { version: 1, presets: [preset], applied: [] } }));
  assert.deepEqual(parsed.presets.presets, [preset]);

  const cases = [
    [{ version: 1, presets: 'nope' }, 'invalid-presets'],
    [{ version: 9, presets: [] }, 'unsupported-presets-version'],
    [{ version: 1, presets: [], nope: 1 }, 'invalid-presets'],
    [{ version: 1, presets: [{ id: 'a b', name: 'P', action: 'replace', text: 'T' }] }, 'invalid-preset-id'],
    [{ version: 1, presets: [{ id: 'p1', name: '  ', action: 'replace', text: 'T' }] }, 'invalid-name'],
    [{ version: 1, presets: [{ id: 'p1', name: 'P', action: 'hide', text: 'T' }] }, 'unsupported-action'],
    [{ version: 1, presets: [{ id: 'p1', name: 'P', action: 'replace' }] }, 'missing-text'],
    [{ version: 1, presets: [{ id: 'p1', name: 'P', action: 'replace', text: 7 }] }, 'missing-text'],
    [
      { version: 1, presets: [preset, { ...preset, name: 'P2' }] },
      'duplicate-preset-id',
    ],
    [
      { version: 1, presets: [], applied: [{ workspaceRoot: '/a', base: { action: 'nope', text: 'x' }, stack: [] }] },
      'unsupported-action',
    ],
    [
      { version: 1, presets: [], applied: [{ workspaceRoot: '/a', base: null, stack: [{ presetId: 'p1', appliedAt: null, action: 'replace' }] }] },
      'missing-text',
    ],
    [
      { version: 1, presets: [], applied: [{ workspaceRoot: '/a', base: null, stack: [] }, { workspaceRoot: '/a', base: null, stack: [] }] },
      'invalid-applied',
    ],
  ];
  for (const [presets, code] of cases) {
    assert.throws(() => parseExport(document({ presets })), (error) => error.code === code, `${JSON.stringify(presets)} => ${code}`);
  }
});

test('transfer: a preference document is validated strictly, unknown keys included', () => {
  const parsed = parseExport(document({ preferences: { updateCheck: true, assemblyNotice: false, downloadRegion: 'custom', downloadRegionRegistry: 'https://mirror/' } }));
  assert.deepEqual(parsed.preferences, {
    updateCheck: true,
    downloadRegion: 'custom',
    downloadRegionRegistry: 'https://mirror/',
    assemblyNotice: false,
  });

  const cases = [
    [{ nope: 1 }, 'unknown-preference'],
    [{ updateCheck: 'false' }, 'invalid-preference'],
    [{ assemblyNotice: 1 }, 'invalid-preference'],
    [{ downloadRegionAuto: 'yes' }, 'invalid-preference'],
    [{ downloadRegion: 'mars' }, 'invalid-preference'],
    [{ downloadRegionRegistry: '' }, 'invalid-preference'],
    [{ downloadRegionRegistry: 7 }, 'invalid-preference'],
    ['nope', 'invalid-preferences'],
  ];
  for (const [preferences, code] of cases) {
    assert.throws(() => parseExport(document({ preferences })), (error) => error.code === code, `${JSON.stringify(preferences)} => ${code}`);
  }
});

test('transfer: an applied record names the very same workspace root the workspaces array does', () => {
  const presetsWith = (workspaceRoot) => ({
    version: 1,
    presets: [],
    applied: [{ workspaceRoot, base: null, stack: [] }],
  });
  for (const good of ['/home/u/project', 'C:\\Users\\u\\project', '\\\\server\\share\\project']) {
    assert.equal(parseExport(document({ presets: presetsWith(good) })).presets.applied[0].workspaceRoot, good);
  }
  // g-074 R1: the review found this field checked for nothing but "a non-empty
  // string", which let an imported library name any absolute path on the disk —
  // `/etc` included — and a later `DELETE /presets` wrote into it. It is now
  // judged by the same rule `workspaces[].root` is.
  const bad = [
    ['relative/dir', 'invalid-workspace-root'],
    ['./project', 'invalid-workspace-root'],
    ['/tmp/../etc', 'invalid-workspace-root'],
    ['/', 'invalid-workspace-root'],
    ['C:\\', 'invalid-workspace-root'],
    ['/home/u/\u0000evil', 'invalid-workspace-root'],
    ['', 'invalid-workspace-root'],
    [null, 'invalid-workspace-root'],
    [42, 'invalid-workspace-root'],
    ['x'.repeat(4097), 'invalid-workspace-root'],
  ];
  for (const [workspaceRoot, code] of bad) {
    assert.throws(
      () => parseExport(document({ presets: presetsWith(workspaceRoot) })),
      (error) => error.code === code && error.message.includes('applied[0].workspaceRoot'),
      `applied[0].workspaceRoot = ${JSON.stringify(workspaceRoot)} => ${code}`,
    );
  }
  // The two fields are one rule, so they cannot drift apart again: the same bad
  // root answers the same code whichever field carries it.
  for (const badRoot of ['relative', '/tmp/../etc', '/']) {
    let fromWorkspaces = null;
    let fromApplied = null;
    try {
      parseExport(document({ workspaces: [{ root: badRoot, overrides: [] }] }));
    } catch (error) {
      fromWorkspaces = error.code;
    }
    try {
      parseExport(document({ presets: presetsWith(badRoot) }));
    } catch (error) {
      fromApplied = error.code;
    }
    assert.equal(fromWorkspaces, fromApplied, `${badRoot} must answer the same code on both fields`);
  }
});

test('transfer: the location prefix of a nested document error names the key', () => {
  assert.throws(
    () => parseExport(document({ preferences: { nope: 1 } })),
    (error) => error.message.startsWith('preferences: ') && error.status === 400,
  );
  assert.throws(
    () => parseExport(document({ presets: { version: 9 } })),
    (error) => error.message.startsWith('presets: '),
  );
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

/**
 * Pure-kernel assertions: config validation, layer merge, the section
 * transform, the `complete` derivation and the snapshot projections.
 *
 * Everything here is a pure function, so these tests are the primary evidence
 * for the acceptance criteria — they need no Host, no restart and no browser.
 *
 * Run: `node --test test/`
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIONS,
  CONFIG_VERSION,
  MAX_NAME_LENGTH,
  MAX_TEXT_BYTES,
  OverrideError,
  PROBE_SECTION_NAME,
  applyOverrides,
  buildBase,
  buildEffective,
  completeFlags,
  detectFrozen,
  emptyConfig,
  mergeLayers,
  probeConfig,
  renderSections,
  sameSections,
  validateConfig,
  validateOverride,
} from '../core/overrides.js';

/** A section-list builder that keeps the tests readable. */
function sections(...rows) {
  return rows.map(([name, text, extra]) => ({ name, text, ...(extra ?? {}) }));
}

/** Assert that `run` throws an OverrideError carrying `code`. */
function throwsCode(run, code, status) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof OverrideError, `expected an OverrideError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

test('contract: the action and layer enums are frozen at their documented values', () => {
  assert.deepEqual(ACTIONS, ['replace', 'hide', 'append']);
  assert.equal(CONFIG_VERSION, 1);
  assert.equal(MAX_NAME_LENGTH, 200);
  assert.equal(MAX_TEXT_BYTES, 204800);
  assert.deepEqual(emptyConfig(), { version: 1, overrides: [] });
  assert.throws(() => ACTIONS.push('x'), TypeError);
});

test('validateOverride: accepts each action and normalizes away unknown keys', () => {
  assert.deepEqual(validateOverride({ name: 'a', action: 'replace', text: 'T', junk: 1 }), {
    name: 'a',
    action: 'replace',
    text: 'T',
  });
  assert.deepEqual(validateOverride({ name: 'a', action: 'hide' }), { name: 'a', action: 'hide' });
  assert.deepEqual(validateOverride({ name: 'a', action: 'append', text: 'T', order: 3 }), {
    name: 'a',
    action: 'append',
    text: 'T',
    order: 3,
  });
  // An empty text is legal: "replace this section with nothing".
  assert.deepEqual(validateOverride({ name: 'a', action: 'replace', text: '' }), {
    name: 'a',
    action: 'replace',
    text: '',
  });
});

test('validateOverride: every rejection carries a stable code and status', () => {
  throwsCode(() => validateOverride(null), 'invalid-override');
  throwsCode(() => validateOverride([]), 'invalid-override');
  throwsCode(() => validateOverride('nope'), 'invalid-override');
  throwsCode(() => validateOverride({ action: 'replace', text: 'T' }), 'missing-name');
  throwsCode(() => validateOverride({ name: '', action: 'hide' }), 'missing-name');
  throwsCode(() => validateOverride({ name: 'a'.repeat(MAX_NAME_LENGTH + 1), action: 'hide' }), 'name-too-long');
  throwsCode(() => validateOverride({ name: 'a\u0000b', action: 'hide' }), 'invalid-name');
  throwsCode(() => validateOverride({ name: 'a\u2028b', action: 'hide' }), 'invalid-name');
  throwsCode(() => validateOverride({ name: 'a', action: 'REPLACE', text: 'T' }), 'unknown-action');
  throwsCode(() => validateOverride({ name: 'a', action: 'delete' }), 'unknown-action');
  throwsCode(() => validateOverride({ name: 'a', action: 'hide', text: 'T' }), 'unexpected-text');
  throwsCode(() => validateOverride({ name: 'a', action: 'replace' }), 'missing-text');
  throwsCode(() => validateOverride({ name: 'a', action: 'append' }), 'missing-text');
  throwsCode(() => validateOverride({ name: 'a', action: 'replace', text: 'T', order: 1 }), 'unexpected-order');
  throwsCode(() => validateOverride({ name: 'a', action: 'append', text: 'T', order: -1 }), 'invalid-order');
  throwsCode(() => validateOverride({ name: 'a', action: 'append', text: 'T', order: 1.5 }), 'invalid-order');
  // The name bound is inclusive and counted in code units.
  assert.equal(validateOverride({ name: 'a'.repeat(MAX_NAME_LENGTH), action: 'hide' }).name.length, MAX_NAME_LENGTH);
});

test('validateOverride: the 200 KiB text cap is measured in UTF-8 bytes, not characters', () => {
  const ascii = 'x'.repeat(MAX_TEXT_BYTES);
  assert.equal(validateOverride({ name: 'a', action: 'replace', text: ascii }).text.length, MAX_TEXT_BYTES);
  throwsCode(() => validateOverride({ name: 'a', action: 'replace', text: `${ascii}x` }), 'text-too-large', 413);
  // 3 bytes per CJK character: 70000 characters is already over the cap.
  const wide = '\u4e2d'.repeat(70000);
  assert.ok(wide.length < MAX_TEXT_BYTES, 'the character count alone would have passed');
  throwsCode(() => validateOverride({ name: 'a', action: 'replace', text: wide }), 'text-too-large', 413);
});

test('validateConfig: accepts the documented document and rejects every malformed shape', () => {
  assert.deepEqual(validateConfig({ version: 1, overrides: [{ name: 'a', action: 'hide' }] }), {
    version: 1,
    overrides: [{ name: 'a', action: 'hide' }],
  });
  assert.deepEqual(validateConfig({}), { version: 1, overrides: [] });
  assert.deepEqual(validateConfig({ version: 1 }), { version: 1, overrides: [] });
  throwsCode(() => validateConfig(null), 'invalid-config');
  throwsCode(() => validateConfig([]), 'invalid-config');
  throwsCode(() => validateConfig({ version: 2, overrides: [] }), 'unsupported-version');
  throwsCode(() => validateConfig({ overrides: {} }), 'invalid-config');
  throwsCode(() => validateConfig({ overrides: [{ name: 'a', action: 'nope' }] }), 'unknown-action');
  throwsCode(
    () => validateConfig({ overrides: [{ name: 'a', action: 'hide' }, { name: 'a', action: 'hide' }] }),
    'duplicate-name',
  );
});

test('mergeLayers: workspace wins a name clash, keeps the user position, appends the rest', () => {
  const user = validateConfig({
    overrides: [
      { name: 'one', action: 'replace', text: 'user-one' },
      { name: 'two', action: 'hide' },
      { name: 'three', action: 'append', text: 'user-three', order: 0 },
    ],
  });
  const workspace = validateConfig({
    overrides: [
      { name: 'two', action: 'replace', text: 'ws-two' },
      { name: 'four', action: 'append', text: 'ws-four' },
    ],
  });
  const merged = mergeLayers(user, workspace);
  assert.deepEqual(merged.overrides.map((entry) => [entry.name, entry.action, entry.layer]), [
    ['one', 'replace', 'user'],
    ['two', 'replace', 'workspace'],
    ['three', 'append', 'user'],
    ['four', 'append', 'workspace'],
  ]);
  assert.equal(merged.overrides[1].text, 'ws-two');
  // Consequence: the workspace replacement is what the assembly handler applies.
  const applied = applyOverrides(sections(['two', 'ORIGINAL']), merged);
  assert.equal(applied.sections.find((section) => section.name === 'two').text, 'ws-two');
});

test('mergeLayers: a single layer, and no layers at all', () => {
  const user = validateConfig({ overrides: [{ name: 'a', action: 'hide' }] });
  const workspace = validateConfig({ overrides: [{ name: 'b', action: 'hide' }] });
  assert.deepEqual(mergeLayers(user, null).overrides.map((entry) => [entry.name, entry.layer]), [['a', 'user']]);
  assert.deepEqual(mergeLayers(null, workspace).overrides.map((entry) => [entry.name, entry.layer]), [['b', 'workspace']]);
  assert.deepEqual(mergeLayers(null, null), { version: 1, overrides: [] });
  assert.deepEqual(mergeLayers(emptyConfig(), emptyConfig()).overrides, []);
});

test('applyOverrides: no overrides returns the input array BY IDENTITY (zero-diff guarantee)', () => {
  const input = sections(['a', 'A'], ['b', 'B']);
  const result = applyOverrides(input, emptyConfig());
  assert.equal(result.sections, input, 'the same array instance must come back');
  assert.equal(result.changed, false);
  assert.deepEqual(result.report, { applied: [], skipped: [] });
});

test('applyOverrides: replace rewrites text in place and keeps the interpolation flag', () => {
  const input = sections(['a', 'A'], ['b', 'B', { interpolate: false }], ['c', 'C']);
  const resolved = mergeLayers(validateConfig({ overrides: [{ name: 'b', action: 'replace', text: 'B2' }] }), null);
  const result = applyOverrides(input, resolved);
  assert.equal(result.changed, true);
  assert.deepEqual(result.sections.map((section) => [section.name, section.text]), [['a', 'A'], ['b', 'B2'], ['c', 'C']]);
  assert.equal(result.sections[1].interpolate, false, 'the flag must survive a replace');
  assert.deepEqual(result.report.applied, [{ name: 'b', action: 'replace', layer: 'user' }]);
  assert.equal(input[1].text, 'B', 'the input must not be mutated');
});

test('applyOverrides: replace with the registered text is a no-op, not a change', () => {
  const input = sections(['a', 'A']);
  const resolved = mergeLayers(validateConfig({ overrides: [{ name: 'a', action: 'replace', text: 'A' }] }), null);
  const result = applyOverrides(input, resolved);
  assert.equal(result.changed, false);
  assert.equal(result.sections, input);
  assert.deepEqual(result.report.applied, [{ name: 'a', action: 'replace', layer: 'user' }]);
});

test('applyOverrides: hide removes the section; append inserts at order or at the end', () => {
  const input = sections(['a', 'A'], ['b', 'B'], ['c', 'C']);
  const resolved = mergeLayers(
    validateConfig({
      overrides: [
        { name: 'b', action: 'hide' },
        { name: 'z', action: 'append', text: 'Z' },
        { name: 'head', action: 'append', text: 'H', order: 0 },
        { name: 'far', action: 'append', text: 'F', order: 99 },
      ],
    }),
    null,
  );
  const result = applyOverrides(input, resolved);
  assert.deepEqual(result.sections.map((section) => section.name), ['head', 'a', 'c', 'z', 'far']);
  assert.deepEqual(result.report.skipped, []);
  assert.equal(result.report.applied.length, 4);
});

test('applyOverrides: an absent replace/hide target and a colliding append are skipped, never invented', () => {
  const input = sections(['a', 'A']);
  const resolved = mergeLayers(
    validateConfig({
      overrides: [
        { name: 'ghost', action: 'replace', text: 'G' },
        { name: 'ghost2', action: 'hide' },
        { name: 'a', action: 'append', text: 'AGAIN' },
      ],
    }),
    null,
  );
  const result = applyOverrides(input, resolved);
  assert.equal(result.changed, false);
  assert.equal(result.sections, input);
  assert.deepEqual(result.report.applied, []);
  assert.deepEqual(result.report.skipped.map((entry) => [entry.name, entry.code]), [
    ['ghost', 'section-not-present'],
    ['ghost2', 'section-not-present'],
    ['a', 'name-already-present'],
  ]);
});

test('sameSections: compares name, text and the interpolation flag positionally', () => {
  assert.equal(sameSections([{ name: 'a', text: 'A' }], [{ name: 'a', text: 'A' }]), true);
  assert.equal(sameSections([{ name: 'a', text: 'A' }], [{ name: 'a', text: 'A', interpolate: false }]), false);
  assert.equal(sameSections([{ name: 'a', text: 'A' }], [{ name: 'b', text: 'A' }]), false);
  assert.equal(sameSections([{ name: 'a', text: 'A' }], []), false);
  assert.equal(sameSections(undefined, []), true);
});

test('detectFrozen: a missing probe section means the pipeline replaced the scope', () => {
  const registered = sections(['complete:c', 'C'], ['other', 'O']);
  const verdict = detectFrozen({
    registered,
    probe: [{ name: 'complete:c', text: 'C' }],
  });
  assert.equal(verdict.frozen, true);
  assert.equal(verdict.frozenSection, 'complete:c');
  assert.match(verdict.frozenReason, /single complete section "complete:c"/);
});

test('detectFrozen: a scope whose only section is complete is still caught, with no override configured', () => {
  const registered = sections(['complete:c', 'ORIGINAL']);
  const verdict = detectFrozen({
    registered,
    probe: [{ name: 'complete:c', text: 'ORIGINAL' }],
  });
  assert.equal(verdict.frozen, true);
  assert.equal(verdict.frozenSection, 'complete:c');
  assert.match(verdict.frozenReason, /single complete section "complete:c"/);
});

test('detectFrozen: the probe controls its own section list, so a discarded probe is not about us', () => {
  const registered = sections(['complete:c', 'C'], ['other', 'O']);
  const verdict = detectFrozen({
    registered,
    probe: [{ name: 'complete:c', text: 'C' }],
  });
  assert.equal(verdict.frozen, true);
  // The decisive signal names the scope, not our override.
  assert.match(verdict.frozenReason, /single complete section/);
});

test('detectFrozen: the F1 regression — a surviving probe plus ANOTHER plugin section is NOT a freeze', () => {
  // Live shape: 10 registered sections; this plugin appends its probe; a third
  // party (dsh-expression) appends a companion section in its own listener. The
  // result is 12 sections, not 11 — an earlier "the list changed size" rule
  // called that a freeze and marked every section non-overridable.
  const registered = sections(['a', 'A'], ['b', 'B']);
  const verdict = detectFrozen({
    registered,
    probe: sections(['a', 'A'], ['b', 'B'], [PROBE_SECTION_NAME, 'probe'], ['companion', 'C']),
  });
  assert.deepEqual(verdict, { frozen: false, frozenSection: null, frozenReason: null });
});

test('detectFrozen: a surviving probe alongside sections REMOVED by another plugin is also not a freeze', () => {
  const registered = sections(['a', 'A'], ['b', 'B'], ['c', 'C']);
  const verdict = detectFrozen({
    registered,
    probe: sections(['a', 'A'], [PROBE_SECTION_NAME, 'probe']),
  });
  assert.deepEqual(verdict, { frozen: false, frozenSection: null, frozenReason: null });
});

test('detectFrozen: a probe removed without a single-section collapse does not claim complete', () => {
  const registered = sections(['a', 'A'], ['b', 'B']);
  const verdict = detectFrozen({
    registered,
    probe: sections(['a', 'A'], ['b', 'B']),
  });
  assert.equal(verdict.frozen, true);
  assert.equal(verdict.frozenSection, null);
  assert.match(verdict.frozenReason, /probe section was removed/);
  assert.doesNotMatch(verdict.frozenReason, /complete/);
});

test('detectFrozen: hiding every section but one is our own doing, not a freeze', () => {
  const registered = sections(['a', 'A'], ['b', 'B']);
  const withProbe = sections(['a', 'A'], ['b', 'B'], [PROBE_SECTION_NAME, 'p']);
  const verdict = detectFrozen({ registered, probe: withProbe });
  assert.deepEqual(verdict, { frozen: false, frozenSection: null, frozenReason: null });
});

test('detectFrozen: an untouched assembly whose probe survived is not frozen', () => {
  const registered = sections(['a', 'A'], ['b', 'B']);
  assert.deepEqual(
    detectFrozen({ registered, probe: sections(['a', 'A'], ['b', 'B'], [PROBE_SECTION_NAME, 'p']) }),
    { frozen: false, frozenSection: null, frozenReason: null },
  );
});

test('detectFrozen: a probe section that cannot be appended falls back to comparing the two probes', () => {
  // Pathological: a registered section already owns the probe name, so the
  // probe append is skipped and cannot be used as a marker.
  const registered = sections([PROBE_SECTION_NAME, 'SQUATTER'], ['a', 'A']);
  const collided = detectFrozen({ registered, probe: registered });
  assert.deepEqual(collided, { frozen: false, frozenSection: null, frozenReason: null });
  const collapsed = detectFrozen({ registered, probe: [{ name: 'a', text: 'A' }] });
  assert.equal(collapsed.frozen, true);
  assert.equal(collapsed.frozenSection, 'a');
});

test('completeFlags: only claimed where the probe actually proves it', () => {
  const registered = sections(['a', 'A'], ['b', 'B']);
  const survived = completeFlags(registered, sections(['a', 'A'], ['b', 'B'], [PROBE_SECTION_NAME, 'p']), false, null);
  assert.deepEqual([...survived], [['a', false], ['b', false]]);
  const frozenSingle = completeFlags(registered, sections(['a', 'A']), true, 'a');
  assert.deepEqual([...frozenSingle], [['a', true], ['b', false]]);
  // Frozen but the collapsed section cannot be named: nothing may be claimed.
  const unnamed = completeFlags(registered, [], true, null);
  assert.deepEqual([...unnamed], [['a', 'unknown'], ['b', 'unknown']]);
  assert.deepEqual([...completeFlags([], [], false, null)], []);
});

test('probeConfig: one deterministic append that no real config would contain', () => {
  assert.deepEqual(probeConfig(), {
    version: 1,
    overrides: [{ name: PROBE_SECTION_NAME, action: 'append', text: 'dsh-prompt-setting assemble probe', layer: 'user' }],
  });
  assert.equal(probeConfig().overrides[0].name.startsWith('__dsh-prompt-setting'), true);
});

test('buildBase: index is the array position — never an invented order', () => {
  const flags = new Map([['a', 'unknown'], ['b', false]]);
  assert.deepEqual(buildBase(sections(['a', 'A'], ['b', 'B']), flags), [
    { name: 'a', index: 0, text: 'A', complete: 'unknown' },
    { name: 'b', index: 1, text: 'B', complete: false },
  ]);
});

test('buildEffective: mirrors the rendered result and reports what each override achieved', () => {
  const base = buildBase(sections(['a', 'A'], ['b', 'B'], ['c', 'C']), new Map());
  const resolved = mergeLayers(
    validateConfig({
      overrides: [
        { name: 'a', action: 'replace', text: 'A2' },
        { name: 'b', action: 'hide' },
        { name: 'new', action: 'append', text: 'N' },
      ],
    }),
    null,
  );
  const rendered = sections(['a', 'A2'], ['new', 'N'], ['c', 'C']);
  const attempt = applyOverrides(sections(['a', 'A'], ['b', 'B'], ['c', 'C']), resolved);
  const effective = buildEffective({
    base,
    after: rendered,
    resolved,
    report: attempt.report,
    frozen: false,
    frozenReason: null,
  });
  assert.deepEqual(
    effective.map((entry) => [entry.name, entry.index, entry.text, entry.origin, entry.action, entry.overrideLayer, entry.applied]),
    [
      ['a', 0, 'A2', 'registered', 'replace', 'user', true],
      ['new', 1, 'N', 'appended', 'append', 'user', true],
      ['c', 2, 'C', 'registered', null, null, false],
      // Not rendered any more: index null, and the suppressed text is shown.
      ['b', null, 'B', 'registered', 'hide', 'user', true],
    ],
  );
  assert.equal(effective[2].overridable, true);
  assert.equal(effective[2].reason, null);
  assert.equal(effective[0].reason, null);
});

test('buildEffective: F1 — a section another plugin added after the waterfall is marked, not blamed on us', () => {
  const base = buildBase(sections(['a', 'A']), new Map());
  const effective = buildEffective({
    base,
    after: sections(['a', 'A'], ['companion', 'C']),
    resolved: emptyConfig(),
    report: { applied: [], skipped: [] },
    frozen: false,
    frozenReason: null,
  });
  const added = effective.find((entry) => entry.name === 'companion');
  assert.deepEqual(
    [added.origin, added.action, added.overrideLayer, added.applied, added.overridable, added.reason],
    ['downstream-added', null, null, false, true, null],
  );
  // And an untouched registered section stays editable when nothing is frozen.
  const plain = effective.find((entry) => entry.name === 'a');
  assert.deepEqual([plain.origin, plain.overridable, plain.reason], ['registered', true, null]);
});

test('buildEffective: an override whose registered target was removed downstream says so', () => {
  const base = buildBase(sections(['a', 'A'], ['b', 'B']), new Map());
  const resolved = mergeLayers(validateConfig({ overrides: [{ name: 'b', action: 'replace', text: 'B2' }] }), null);
  const attempt = applyOverrides(sections(['a', 'A']), resolved);
  const effective = buildEffective({
    base,
    after: sections(['a', 'A']),
    resolved,
    report: attempt.report,
    frozen: false,
    frozenReason: null,
  });
  const b = effective.find((entry) => entry.name === 'b');
  assert.deepEqual([b.index, b.origin, b.applied, b.overridable], [null, 'registered', false, false]);
  assert.match(b.reason, /removed from the assembled result/);
});

test('buildEffective: a frozen scope marks every section non-overridable with the frozen reason', () => {
  const base = buildBase(sections(['c', 'ORIGINAL'], ['x', 'X']), new Map([['c', true], ['x', false]]));
  const resolved = mergeLayers(validateConfig({ overrides: [{ name: 'c', action: 'replace', text: 'REWRITTEN' }] }), null);
  const effective = buildEffective({
    base,
    after: [{ name: 'c', text: 'ORIGINAL' }],
    resolved,
    report: { applied: [{ name: 'c', action: 'replace', layer: 'user' }], skipped: [] },
    frozen: true,
    frozenReason: 'the assembly was replaced by a single complete section "c"',
  });
  const replaced = effective.find((entry) => entry.name === 'c');
  assert.equal(replaced.applied, false);
  assert.equal(replaced.overridable, false);
  assert.match(replaced.reason, /single complete section/);
  // `x` is gone from the result, so it reports as a replace that lost its section.
  const gone = effective.find((entry) => entry.name === 'x');
  assert.equal(gone.index, null);
  assert.equal(gone.overridable, false);
});

test('buildEffective: skipped overrides explain themselves instead of silently vanishing', () => {
  const base = buildBase(sections(['a', 'A']), new Map());
  const resolved = mergeLayers(
    validateConfig({ overrides: [{ name: 'ghost', action: 'replace', text: 'G' }] }),
    null,
  );
  const attempt = applyOverrides(sections(['a', 'A']), resolved);
  const effective = buildEffective({
    base,
    after: sections(['a', 'A']),
    resolved,
    report: attempt.report,
    frozen: false,
    frozenReason: null,
  });
  const ghost = effective.find((entry) => entry.name === 'ghost');
  assert.equal(ghost.applied, false);
  assert.equal(ghost.overridable, false);
  assert.match(ghost.reason, /is registered/);
});

test('renderSections: joins non-empty sections with a blank line and interpolates usable variables', () => {
  const text = (sections_, variables) => renderSections(sections_, variables);
  assert.deepEqual(text(sections(['a', 'A'], ['b', 'B']), {}), { text: 'A\n\nB', resolved: true, unresolved: [] });
  assert.equal(text(sections(['a', 'A'], ['b', ''], ['c', 'C']), {}).text, 'A\n\nC');
  assert.equal(text(sections(['a', 'Hello {{name}}']), { name: 'world' }).text, 'Hello world');
  assert.equal(text(sections(['a', '{{a}}{{b}}']), { a: '1', b: '2' }).text, '12');
  assert.equal(text(sections(['a', 'A'], ['b', '{{a}}']), { a: 'expanded' }).text, 'A\n\nexpanded');
  assert.deepEqual(text(undefined, undefined), { text: '', resolved: true, unresolved: [] });
  // `interpolate: false` sections keep their braces by design, so they are NOT
  // unresolved references.
  assert.deepEqual(
    text(sections(['a', 'lit {{name}}', { interpolate: false }]), { name: 'x' }),
    { text: 'lit {{name}}', resolved: true, unresolved: [] },
  );
});

test('F2: an undefined or missing variable is never rendered as a bare "undefined"', () => {
  // The live bug: the probe context had no agent, agent-scoped providers
  // returned undefined, and the "full prompt" showed `powered by the undefined
  // model` — a prompt that never existed.
  const undefinedValue = renderSections(sections(['a', 'powered by the {{model}} model']), { model: undefined });
  assert.equal(undefinedValue.text, 'powered by the {{model}} model');
  assert.equal(undefinedValue.text.includes('undefined'), false);
  assert.deepEqual(undefinedValue.unresolved, ['model']);
  assert.equal(undefinedValue.resolved, false);

  const nullValue = renderSections(sections(['a', 'cwd {{cwd}}']), { cwd: null });
  assert.equal(nullValue.text, 'cwd {{cwd}}');
  assert.deepEqual(nullValue.unresolved, ['cwd']);

  // Absent and malformed references are unresolved too; the snapshot never throws.
  assert.deepEqual(renderSections(sections(['a', 'Hello {{nope}}']), {}).unresolved, ['nope']);
  assert.deepEqual(renderSections(sections(['a', 'a {{Upper}} b']), {}).unresolved, ['Upper']);
  assert.equal(renderSections(sections(['a', 'a {{Upper}} b']), {}).text, 'a {{Upper}} b');
  // A lone `{{` is prose, exactly as the shipped renderer treats it.
  assert.deepEqual(renderSections(sections(['a', '{{unclosed']), {}), { text: '{{unclosed', resolved: true, unresolved: [] });

  // Several references, deduplicated and sorted; resolved ones are not listed.
  const mixed = renderSections(sections(['a', '{{b}} {{a}} {{b}} {{ok}}']), { a: undefined, b: undefined, ok: 'yes' });
  assert.equal(mixed.text, '{{b}} {{a}} {{b}} yes');
  assert.deepEqual(mixed, { text: '{{b}} {{a}} {{b}} yes', resolved: false, unresolved: ['a', 'b'] });

  // A usable value renders normally and reports nothing unresolved.
  assert.deepEqual(
    renderSections(sections(['a', 'powered by the {{model}} model']), { model: 'deepseek-flash' }),
    { text: 'powered by the deepseek-flash model', resolved: true, unresolved: [] },
  );
  // `false` and `0` are usable values, not "missing".
  assert.equal(renderSections(sections(['a', '{{n}}']), { n: 0 }).text, '0');
  assert.equal(renderSections(sections(['a', '{{n}}']), { n: false }).text, 'false');
});

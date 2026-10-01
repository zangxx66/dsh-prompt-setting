/**
 * Revision 9's switch semantics, the write-face validator, and — since Revision
 * 15 — the lenient expansion the switch actually performs.
 *
 * The validator answers "would this text make a *strictly interpolated* section
 * throw?" against the shipped renderer's OWN grammar, so it is written here with
 * the renderer's four conditions, and the two shapes the earlier preview logic
 * got wrong (`{{ lone {{c}}`, `{{{{model}}}}`) are asserted in both directions:
 * the strict validator must catch them, and the old "a non-matching `{{` is
 * prose" reading must be shown to miss them.
 *
 * Revision 15 (design A) deletes the load-time self-check and the assembly hold,
 * and adds {@link expandPromptText}: the switch now means "this plugin expands
 * the reserved section itself", leniently. The expansion is pinned here; the
 * byte-for-byte agreement with the real `renderPrompt` is pinned in
 * `test/integration.test.mjs`.
 *
 * Run: `node --test test/`
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CUSTOM_SECTION_NAME } from '../index.js';
import {
  INTERPOLATE_STATES,
  UNRESOLVABLE_VARIABLE,
  anyStatesOn,
  assertInterpolatable,
  customTextOf,
  describeInterpolateErrors,
  describeWarnings,
  effectiveInterpolate,
  expandPromptText,
  lintPromptText,
  scanThrowingReference,
  switchStateOf,
  walkReferences,
  withState,
  withSwitch,
  withoutSwitch,
} from '../core/interpolate.js';
import {
  INTERPOLATE_FLAG,
  emptyConfig,
  interpolateFlagOf,
  mergeLayers,
  renderSections,
  validateConfig,
} from '../core/overrides.js';
import { upsertOverride, removeOverride } from '../core/store.js';
import { legacyPlan } from '../core/custom.js';
import { planImport } from '../core/transfer.js';

/** The variable table a healthy profile assembles. */
const VARIABLES = Object.freeze({ model: 'deepseek-flash', cwd: '/work', provider: 'deepseek', maybe: undefined });

/** A config that carries the switch ON, with the given「我的 Prompt」text. */
function arming(text, extra = {}) {
  return { version: 1, [INTERPOLATE_FLAG]: true, overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text, ...extra }] };
}

// ---------------------------------------------------------------------------
// The validator: four throw conditions, transcribed from the shipped renderer
// ---------------------------------------------------------------------------

test('g-026 validator: the malformed-group condition (shipped renderer line "malformed prompt variable reference")', () => {
  // `{{` with no complete group but a LATER `}}` is a reference the renderer
  // cannot parse, and it throws. This is the condition the preview's old
  // "group === null ⇒ prose" branch missed, so it is asserted first.
  for (const text of ['{{ lone {{c}}', '{{{{model}}}}', '{{a{b}}', '{{ } }}']) {
    const fault = scanThrowingReference(text, VARIABLES);
    assert.notEqual(fault, null, `must be classified as throwing: ${JSON.stringify(text)}`);
    assert.equal(fault.kind, 'malformed', JSON.stringify(text));
  }
  // A `{{` with NO later `}}` is prose to the renderer, and must stay prose here.
  assert.equal(scanThrowingReference('{{unclosed', VARIABLES), null);
  assert.equal(scanThrowingReference('a {{ b {{ c', VARIABLES), null);
});

test('g-026 validator: the illegal-name condition (shipped renderer checks ^[a-z][a-z0-9_]*$)', () => {
  const upper = scanThrowingReference('keep {{Upper}}', VARIABLES);
  assert.equal(upper.kind, 'invalid-name');
  assert.equal(upper.name, 'Upper');
  for (const text of ['{{a-b}}', '{{1a}}', '{{a b}}', '{{}}', '{{ a}}']) {
    assert.equal(scanThrowingReference(text, VARIABLES).kind, 'invalid-name', JSON.stringify(text));
  }
  // The legal grammar is accepted (the names must be registered to be reachable,
  // so the table states them).
  const names = { a: '1', a1: '1', a_b: '1', a_b_c9: '1' };
  assert.equal(scanThrowingReference('{{a}} {{a1}} {{a_b}} {{a_b_c9}}', names), null);
});

test('g-026 validator: the unregistered-name condition, and a missing table is fail-closed', () => {
  const unknown = scanThrowingReference('keep {{nope}}', VARIABLES);
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.name, 'nope');
  // A table this process could not obtain proves nothing about the name, so the
  // strict reading treats every reference as unknown rather than as safe.
  assert.equal(scanThrowingReference('{{nope}}', null).kind, 'unknown');
  assert.equal(scanThrowingReference('{{model}}', null).kind, 'unknown');
});

test('g-026 validator: an `undefined` value throws, a `null` value does NOT', () => {
  const undef = scanThrowingReference('{{maybe}}', VARIABLES);
  assert.equal(undef.kind, 'undefined-value');
  assert.equal(undef.name, 'maybe');
  // The renderer stringifies null into the prompt; it is a usable value.
  assert.equal(scanThrowingReference('{{cwd}}', { cwd: null }), null);
  assert.equal(scanThrowingReference('{{n}}', { n: 0 }), null);
  assert.equal(scanThrowingReference('{{n}}', { n: false }), null);
  assert.equal(scanThrowingReference('{{n}}', { n: '' }), null);
});

test('g-026 validator: substituted values are never scanned again', () => {
  // A value that itself looks like a reference must not be walked: only the
  // INPUT is scanned, exactly like the shipped renderer.
  assert.equal(scanThrowingReference('{{a}}', { a: '{{nope}}' }), null);
  const seen = [];
  walkReferences('{{a}}', { a: '{{nope}}' }, (event) => seen.push(event.kind));
  assert.deepEqual(seen, []);
});

test('g-026 validator: the first fault is the one the renderer would throw on', () => {
  // Scan order decides. `{{a}}` is unregistered, so it is the first throw even
  // though a second fault follows.
  const first = scanThrowingReference('{{a}} then {{Upper}}', { });
  assert.equal(first.kind, 'unknown');
  assert.equal(first.name, 'a');
  assert.equal(first.at, 0);
  // And an `undefined` value earlier in the text beats a later unknown name:
  // the renderer throws at the first reference it cannot render.
  const mixed = scanThrowingReference('x {{maybe}} y {{nope}}', VARIABLES);
  assert.equal(mixed.kind, 'undefined-value');
  assert.equal(mixed.name, 'maybe');
});

test('g-026 validator: the old preview reading misses exactly the two bomb shapes', () => {
  // The negative control. `core/overrides.js` renders a section that does NOT
  // interpolate by collecting references with a branch that calls every
  // non-matching `{{` prose. This file is the oracle for "the new validator must
  // catch what that branch misses", so it renders through the public API rather
  // than re-implementing it.
  for (const text of ['{{ lone {{c}}', '{{{{model}}}}']) {
    // The shape lands in the renderer at all (the section carries text), and the
    // old reading reports NOTHING that will throw — which is the miss.
    const closed = renderSections([{ name: 'reserved', text, interpolate: false }], { c: 'C' });
    assert.deepEqual(closed.unresolved, [], `old reading must miss it: ${JSON.stringify(text)}`);
    assert.equal(closed.resolved, true);
    // The new validator catches it.
    assert.notEqual(scanThrowingReference(text, { c: 'C', model: 'M' }), null, JSON.stringify(text));
    assert.equal(lintPromptText(text, { c: 'C', model: 'M' }).errors[0].kind, 'malformed');
  }
  // And an interpolating section now agrees with the validator instead of
  // claiming everything is fine.
  for (const text of ['{{ lone {{c}}', '{{{{model}}}}']) {
    const open = renderSections([{ name: 'custom', text, interpolate: true }], { c: 'C', model: 'M' });
    assert.equal(open.resolved, false, JSON.stringify(text));
    assert.equal(open.unresolved.length, 1);
  }
});

// ---------------------------------------------------------------------------
// The refusal policy: fatal vs. warned
// ---------------------------------------------------------------------------

test('g-026 lint: an `undefined` value is a warning, never a refusal', () => {
  const { errors, warnings } = lintPromptText('{{model}} and {{maybe}}', VARIABLES);
  assert.deepEqual(errors, [], 'a registered name is not an error even when its value is undefined here');
  assert.deepEqual(warnings.map((entry) => [entry.kind, entry.name]), [['undefined-value', 'maybe']]);

  // The three fatal classes stay fatal.
  assert.equal(lintPromptText('{{nope}}', VARIABLES).errors[0].kind, 'unknown');
  assert.equal(lintPromptText('{{Upper}}', VARIABLES).errors[0].kind, 'invalid-name');
  assert.equal(lintPromptText('{{ lone {{c}}', VARIABLES).errors[0].kind, 'malformed');
  // A missing table is fatal for the write path (fail closed)...
  assert.equal(lintPromptText('{{model}}', null, { assumeUnknown: true }).errors[0].kind, 'unknown');
  // ...but the load path reads it as "cannot check names", grammar only.
  assert.deepEqual(lintPromptText('{{model}}', null).errors, []);
  assert.equal(lintPromptText('{{ lone {{c}}', null).errors[0].kind, 'malformed');
});

test('g-026 assertInterpolatable: refuses the fatal classes with 400 unresolvable-variable', () => {
  for (const text of ['{{nope}}', '{{Upper}}', '{{ lone {{c}}', '{{{{model}}}}']) {
    assert.throws(
      () => assertInterpolatable(text, VARIABLES, 'the user layer (/x/overrides.json)'),
      (error) => {
        assert.equal(error.code, UNRESOLVABLE_VARIABLE);
        assert.equal(error.status, 400);
        assert.match(error.message, /user layer/);
        assert.match(error.message, /Fix:/, 'the message must carry the way out');
        return true;
      },
      JSON.stringify(text),
    );
  }
  // The legal and the `undefined` cases pass.
  assert.doesNotThrow(() => assertInterpolatable('hi {{model}} {{cwd}} {{provider}}', VARIABLES, 'x'));
  assert.doesNotThrow(() => assertInterpolatable('hi {{maybe}}', VARIABLES, 'x'));
  assert.doesNotThrow(() => assertInterpolatable('{{unclosed prose', VARIABLES, 'x'));
});

test('g-026 describeInterpolateErrors: bounded, and it names the registered variables', () => {
  const { errors } = lintPromptText('{{a}} {{b}} {{c}} {{d}}', { model: 'x' });
  const message = describeInterpolateErrors(errors, 'the user layer', ['model']);
  assert.match(message, /4 prompt reference/);
  assert.match(message, /and 1 more/);
  assert.match(message, /model/);
  assert.equal(typeof message, 'string');
});

// ---------------------------------------------------------------------------
// The switch: config semantics
// ---------------------------------------------------------------------------

test('g-026 switch: it is absent by default and an absent key means OFF', () => {
  assert.deepEqual(emptyConfig(), { version: 1, overrides: [] });
  assert.equal(Object.hasOwn(emptyConfig(), INTERPOLATE_FLAG), false);
  assert.equal(interpolateFlagOf(emptyConfig()), undefined);
  assert.equal(effectiveInterpolate(emptyConfig(), null), false);
  assert.equal(effectiveInterpolate(null, null), false);
});

test('g-026 switch: a non-boolean flag is a rejected config, never coerced', () => {
  // `"false"` is truthy; reading it as "on" is exactly how a safety switch
  // becomes a bomb, so it must be refused rather than interpreted.
  assert.throws(
    () => validateConfig({ version: 1, overrides: [], [INTERPOLATE_FLAG]: 'false' }),
    (error) => error.code === 'invalid-interpolate-flag',
  );
  assert.throws(() => validateConfig({ version: 1, overrides: [], [INTERPOLATE_FLAG]: 1 }), /interpolateCustom/);
  // `null` reads as "states nothing", not as a boolean.
  assert.equal(interpolateFlagOf(validateConfig({ version: 1, overrides: [], [INTERPOLATE_FLAG]: null })), undefined);
  // A document that never mentions the key validates to the pre-Revision-9 shape.
  assert.deepEqual(validateConfig({ version: 1, overrides: [] }), { version: 1, overrides: [] });
});

test('g-026 switch: the workspace layer wins on STATEDNESS, not on truthiness', () => {
  const off = { version: 1, overrides: [], [INTERPOLATE_FLAG]: false };
  const on = { version: 1, overrides: [], [INTERPOLATE_FLAG]: true };
  const silent = { version: 1, overrides: [] };

  assert.equal(effectiveInterpolate(on, null), true);
  assert.equal(effectiveInterpolate(off, null), false);
  assert.equal(effectiveInterpolate(null, on), true);
  // A workspace layer that states nothing INHERITS the user layer...
  assert.equal(effectiveInterpolate(on, silent), true);
  // ...while one that states OFF overrides an ON user layer.
  assert.equal(effectiveInterpolate(on, off), false);
  assert.equal(effectiveInterpolate(off, on), true);
  // The merged config carries the winner, and carries nothing when neither states.
  assert.equal(interpolateFlagOf(mergeLayers(on, silent)), true);
  assert.equal(interpolateFlagOf(mergeLayers(on, off)), false);
  assert.equal(Object.hasOwn(mergeLayers(silent, silent), INTERPOLATE_FLAG), false);
});

test('g-026 switch: withSwitch writes absence for OFF, and the rebuild paths carry it', () => {
  const base = { version: 1, overrides: [] };
  assert.deepEqual(withSwitch(base, true), { version: 1, overrides: [], [INTERPOLATE_FLAG]: true });
  assert.deepEqual(withSwitch(withSwitch(base, true), false), { version: 1, overrides: [] });
  assert.deepEqual(withoutSwitch(withSwitch(base, true)), { version: 1, overrides: [] });

  // Every mutation helper rebuilds `{version, overrides}`; without the carry the
  // next save would silently turn the switch off.
  const armed = { version: 1, overrides: [], [INTERPOLATE_FLAG]: true };
  assert.equal(interpolateFlagOf(upsertOverride(armed, { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'x' })), true);
  assert.equal(interpolateFlagOf(removeOverride(armed, CUSTOM_SECTION_NAME).config), true);
  assert.equal(interpolateFlagOf(legacyPlan(armed.overrides, interpolateFlagOf(armed)).next), true);
  assert.equal(interpolateFlagOf(planImport({ imported: [], current: armed }).next), true);
  // And a caller that states nothing still gets the pre-Revision-9 shape.
  assert.equal(Object.hasOwn(legacyPlan([], undefined).next, INTERPOLATE_FLAG), false);
  assert.equal(Object.hasOwn(planImport({ imported: [], current: emptyConfig() }).next, INTERPOLATE_FLAG), false);
});

// ---------------------------------------------------------------------------
// Revision 15 (design A): the expansion the switch performs itself.
//
// This replaces the Revision 9/12/14 "load-time self-check" block. Those
// assertions pinned a degradation that no longer exists — with the reserved
// section permanently `interpolate: false`, stored text cannot break an
// assembly, so no layer is disabled for its text (CONTRACT §16.10, rewrite 1).
// What has to be pinned now is the opposite direction: what the expansion DOES
// to the text, and what it deliberately refuses to do.
// ---------------------------------------------------------------------------

test('g-026 rev15 expand: a registered name with a value is substituted, exactly like the shipped renderer', () => {
  assert.equal(expandPromptText('I am {{model}} in {{cwd}}', VARIABLES), 'I am deepseek-flash in /work');
  // The value is stringified, never inspected: 0, false and '' are values.
  assert.equal(expandPromptText('n={{n}}', { n: 0 }), 'n=0');
  assert.equal(expandPromptText('n={{n}}', { n: false }), 'n=false');
  assert.equal(expandPromptText('n=[{{n}}]', { n: '' }), 'n=[]');
  // A `null` value renders as the shipped renderer renders it (it does not
  // throw on null), so the two agree on this shape too.
  assert.equal(expandPromptText('cwd={{cwd}}', { cwd: null }), 'cwd=null');
  // Surrounding prose, adjacent references and repeated names all survive.
  assert.equal(expandPromptText('{{a}}{{a}}!', { a: 'x' }), 'xx!');
  assert.equal(expandPromptText('nothing to do', {}), 'nothing to do');
});

test('g-026 rev15 expand: an unregistered name, an `undefined` value or a malformed group stays LITERAL', () => {
  // The lenient half. The shipped renderer throws on every one of these; the
  // whole design rests on the expansion doing the opposite.
  assert.equal(expandPromptText('keep {{nope}}', VARIABLES), 'keep {{nope}}');
  assert.equal(expandPromptText('keep {{maybe}}', VARIABLES), 'keep {{maybe}}');
  assert.equal(expandPromptText('keep {{Upper}}', VARIABLES), 'keep {{Upper}}');
  assert.equal(expandPromptText('keep {{a b}}', VARIABLES), 'keep {{a b}}');
  assert.equal(expandPromptText('keep {{}}', VARIABLES), 'keep {{}}');
  // A malformed group is left alone — but "alone" means the two braces the
  // shipped scan would have stopped at, with the cursor advancing exactly as the
  // shipped one advances it. The text after that point is still scanned, so an
  // independent, well-formed reference later in the same string still resolves.
  // This is the shipped cursor, minus the throw.
  assert.equal(expandPromptText('keep {{ lone {{c}}', { c: 'C' }), 'keep {{ lone C');
  assert.equal(expandPromptText('keep {{{{model}}}}', VARIABLES), 'keep {{deepseek-flash}}');
  assert.equal(expandPromptText('{{ lone {{c}}', {}), '{{ lone {{c}}');
  // Prose is prose: a lone `{{` is not a reference at all.
  assert.equal(expandPromptText('keep {{unclosed', VARIABLES), 'keep {{unclosed');
  // Never a bare `undefined` (nor "null" for the undefined case).
  const out = expandPromptText('a {{maybe}} b {{model}} c', VARIABLES);
  assert.equal(out, 'a {{maybe}} b deepseek-flash c');
  assert.equal(out.includes('undefined'), false);
  // A missing table resolves nothing and is not an error.
  assert.equal(expandPromptText('a {{model}} b', null), 'a {{model}} b');
  assert.equal(expandPromptText('a {{model}} b', undefined), 'a {{model}} b');
  assert.equal(expandPromptText('a {{model}} b', 'not a table'), 'a {{model}} b');
  // Non-string input expands to nothing rather than throwing.
  assert.equal(expandPromptText(null, VARIABLES), '');
  assert.equal(expandPromptText(undefined, VARIABLES), '');
});

test('g-026 rev15 expand: substituted values are never scanned again, and the scan cursor follows the shipped one', () => {
  // The value looks like a reference; it is written out and not walked.
  assert.equal(expandPromptText('{{alias}}', { alias: '{{nope}}' }), '{{nope}}');
  assert.equal(expandPromptText('{{a}}{{b}}', { a: '{{x}}', b: 'B' }), '{{x}}B');
  // The `{{` search resumes AFTER the two braces it just wrote out, and a
  // well-formed group reached from there resolves: the cursor is the shipped
  // one, and nothing is scanned twice.
  assert.equal(expandPromptText('{{ lone {{c}}', { c: 'C' }), '{{ lone C');
  assert.equal(expandPromptText('{{{{a}}}}', { a: 'A' }), '{{A}}');
  // An empty text and a text of pure prose are returned unchanged.
  assert.equal(expandPromptText('', VARIABLES), '');
});

test('g-026 customTextOf: the reserved text, or null when there is none to expand', () => {
  assert.equal(customTextOf(arming('hello')), 'hello');
  assert.equal(customTextOf({ version: 1, overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'hello' }] }), 'hello');
  assert.equal(customTextOf({ version: 1, overrides: [{ name: CUSTOM_SECTION_NAME, action: 'hide' }] }), null);
  assert.equal(customTextOf({ version: 1, overrides: [] }), null);
  assert.equal(customTextOf(null), null);
  assert.equal(customTextOf(undefined), null);
});

// ---------------------------------------------------------------------------
// Revision 12 (g-026 att-002): the audit's F1/F2/F4 in their pure form.
// ---------------------------------------------------------------------------

test('g-026 rev12 F1: anyStatesOn is the cross-layer half of the verdict, statedness included', () => {
  const on = { version: 1, overrides: [], [INTERPOLATE_FLAG]: true };
  const off = { version: 1, overrides: [], [INTERPOLATE_FLAG]: false };
  const silent = { version: 1, overrides: [] };
  assert.equal(anyStatesOn([off, silent]), false);
  assert.equal(anyStatesOn([off, silent, on]), true, 'one stated ON is enough');
  assert.equal(anyStatesOn([off, false, undefined, null, 'true']), false, 'a non-boolean neither arms nor throws here');
  assert.equal(anyStatesOn([]), false);
  assert.equal(anyStatesOn(null), false);
});

test('g-026 rev12 F2: the advisories are described, bounded and named', () => {
  const { warnings } = lintPromptText('{{a}} {{b}} {{c}} {{d}}', { a: undefined, b: undefined, c: undefined, d: undefined });
  assert.equal(warnings.length, 4);
  const described = describeWarnings(warnings, 'the user layer (/x/overrides.json)');
  assert.equal(described.length, 3, 'a bounded window, never a dump');
  assert.deepEqual(described.map((entry) => entry.name), ['a', 'b', 'c']);
  assert.equal(described[0].kind, 'undefined-value');
  assert.equal(described[0].code, 'unresolved-at-save');
  assert.match(described[0].message, /user layer/);
  assert.match(described[0].message, /no value/);
  assert.deepEqual(describeWarnings([], 'x'), []);
  assert.deepEqual(describeWarnings(undefined, 'x'), []);

  // assertInterpolatable returns them instead of dropping them, and still
  // refuses only the fatal classes.
  assert.deepEqual(
    assertInterpolatable('hi {{maybe}}', VARIABLES, 'the user layer').warnings.map((entry) => entry.name),
    ['maybe'],
  );
  assert.deepEqual(assertInterpolatable('hi {{model}}', VARIABLES, 'the user layer').warnings, []);
  assert.throws(
    () => assertInterpolatable('hi {{nope}}', VARIABLES, 'the user layer'),
    (error) => error.code === UNRESOLVABLE_VARIABLE && error.status === 400,
  );
});

test('g-026 rev12 F4: the three states round-trip, and inherit is the absence of the key', () => {
  assert.deepEqual([...INTERPOLATE_STATES], ['inherit', 'on', 'off']);
  const base = { version: 1, overrides: [] };
  assert.equal(switchStateOf(base), 'inherit');
  assert.equal(switchStateOf(withState(base, 'on')), 'on');
  assert.equal(switchStateOf(withState(base, 'off')), 'off');

  assert.deepEqual(withState(base, 'on'), { version: 1, overrides: [], [INTERPOLATE_FLAG]: true });
  assert.deepEqual(withState(base, 'off'), { version: 1, overrides: [], [INTERPOLATE_FLAG]: false });
  assert.deepEqual(withState(withState(base, 'off'), 'inherit'), { version: 1, overrides: [] });
  // The explicit OFF is the state `withSwitch` cannot express; both spellings
  // stay available and neither changes meaning.
  assert.equal(Object.hasOwn(withSwitch(base, false), INTERPOLATE_FLAG), false);
  assert.equal(withState(base, 'off')[INTERPOLATE_FLAG], false);

  // An explicit OFF is what lets a workspace close over an ON user layer.
  assert.equal(effectiveInterpolate(withState(base, 'on'), withState(base, 'off')), false);
  assert.equal(effectiveInterpolate(withState(base, 'on'), base), true, 'unstated still inherits');
  // An unknown state falls back to "states nothing" rather than guessing.
  assert.deepEqual(withState(withState(base, 'on'), 'nonsense'), { version: 1, overrides: [] });
});

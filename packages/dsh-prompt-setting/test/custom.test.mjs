/**
 * Pure-kernel assertions for Revision 7's write policy (`core/custom.js`).
 *
 * Everything here is a pure function over plain data, so these are the primary
 * evidence for "which name may be written" and need no Host, no restart and no
 * browser. The route-level half (status codes, byte-identical files, the
 * responses) lives in `test/route.test.mjs` and `test/stage2.test.mjs`.
 *
 * Run: `node --test test/`
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CUSTOM_SECTION_INTERPOLATE,
  CUSTOM_SECTION_NAME,
  CUSTOM_SECTION_ORDER,
  CUSTOM_SECTION_TEXT,
  REPO_MAX_SECTION_ORDER,
  assertDeletableName,
  assertImportableDocument,
  assertWritableSection,
  customOverridesOnly,
  customSection,
  exportScope,
  isCustomSectionName,
  legacyPlan,
} from '../core/custom.js';
import { CONFIG_VERSION, OverrideError } from '../core/overrides.js';

/** Assert that `run` throws an OverrideError carrying `code` and `status`. */
function throwsCode(run, code, status) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof OverrideError, `expected an OverrideError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

test('custom: the reserved name and its placement are frozen at the documented values', () => {
  assert.equal(CUSTOM_SECTION_NAME, 'prompt-setting:custom-prompt');
  assert.equal(CUSTOM_SECTION_ORDER, 1000000);
  assert.equal(CUSTOM_SECTION_TEXT, '');
  assert.equal(CUSTOM_SECTION_INTERPOLATE, false);
  // The one promise `order` can make about the shipped repository: strictly past
  // every placement its own table defines (DEPLOYMENT_PERSONA_SUFFIX = 10200).
  assert.equal(REPO_MAX_SECTION_ORDER, 10200);
  assert.ok(CUSTOM_SECTION_ORDER > REPO_MAX_SECTION_ORDER);
  // The name is namespaced, so it cannot collide with a `harness:`/`deployment:`
  // /`tool:` section the repository registers.
  assert.match(CUSTOM_SECTION_NAME, /^prompt-setting:/);
});

test('custom: customSection() is the exact definition handed to the Host service', () => {
  const section = customSection();
  assert.deepEqual(section, {
    name: CUSTOM_SECTION_NAME,
    order: CUSTOM_SECTION_ORDER,
    text: '',
    interpolate: false,
  });
  // A fresh object per call: the service keeps the object it is given, so a
  // shared one would let one caller's mutation reach another's registration.
  const other = customSection();
  assert.notEqual(section, other);
  other.text = 'mutated';
  assert.equal(customSection().text, '');
});

test('custom: isCustomSectionName is an equality test, not a prefix or case test', () => {
  assert.equal(isCustomSectionName(CUSTOM_SECTION_NAME), true);
  for (const other of ['prompt-setting:custom-prompt ', 'prompt-setting:CUSTOM-PROMPT', 'prompt-setting:', 'project:alpha', '', null, undefined, 42]) {
    assert.equal(isCustomSectionName(other), false, `${JSON.stringify(other)} is not the reserved name`);
  }
});

test('custom: a write to any other name is 403 write-locked and names the one writable section', () => {
  throwsCode(() => assertWritableSection({ name: 'project:alpha', action: 'replace', text: 'x' }), 'write-locked', 403);
  throwsCode(() => assertWritableSection({ name: 'harness:identity', action: 'hide' }), 'write-locked', 403);
  throwsCode(() => assertWritableSection({ name: 'prompt-setting:custom-prompt ', action: 'replace', text: 'x' }), 'write-locked', 403);
  let message = '';
  try {
    assertWritableSection({ name: 'project:alpha', action: 'replace', text: 'x' });
  } catch (error) {
    message = error.message;
  }
  assert.ok(message.includes(CUSTOM_SECTION_NAME), `the message names the writable section: ${message}`);
  assert.ok(message.includes('project:alpha'), `and the refused one: ${message}`);
});

test('custom: the reserved name accepts exactly "replace", and nothing else answers a field code', () => {
  // The accepted shape never throws.
  assertWritableSection({ name: CUSTOM_SECTION_NAME, action: 'replace', text: '' });
  // Everything else is `unsupported-action` — including an action that is
  // absent or unknown, because the action is decided before its own validation.
  for (const action of ['hide', 'append', 'delete', 'REPLACE', undefined, null, 42]) {
    throwsCode(() => assertWritableSection({ name: CUSTOM_SECTION_NAME, action }), 'unsupported-action', 400);
  }
});

test('custom: a request with no usable name is left to validateOverride, not answered by the policy', () => {
  // An absent, empty or non-string name is a malformed override, not a policy
  // question: the policy does not fire, so `missing-name` still comes from the
  // kernel. This is the one shape whose 400 code is not the policy's.
  for (const section of [undefined, null, {}, { name: '' }, { name: 42 }, { name: ['a'] }, { name: {} }]) {
    assert.doesNotThrow(() => assertWritableSection(section), JSON.stringify(section));
  }
});

test('custom: the single-name DELETE lock refuses any other name and accepts the reserved one', () => {
  assert.doesNotThrow(() => assertDeletableName(CUSTOM_SECTION_NAME));
  for (const name of ['project:alpha', 'a', 'prompt-setting:custom-prompt ', 'harness:identity']) {
    throwsCode(() => assertDeletableName(name), 'write-locked', 403);
  }
  // A malformed name never reaches this check in the route (it answers
  // `missing-name`/`name-too-long` first), and here it is a no-op.
  for (const name of ['', null, undefined, 42]) {
    assert.doesNotThrow(() => assertDeletableName(name), JSON.stringify(name));
  }
});

test('custom: legacyPlan separates the frozen overrides from the reserved one, in file order', () => {
  const overrides = [
    { name: 'a', action: 'replace', text: 'A' },
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
    { name: 'b', action: 'hide' },
  ];
  const plan = legacyPlan(overrides);
  assert.deepEqual(plan.removed.map((entry) => entry.name), ['a', 'b']);
  assert.deepEqual(plan.kept.map((entry) => entry.name), [CUSTOM_SECTION_NAME]);
  assert.deepEqual(plan.next, {
    version: CONFIG_VERSION,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' }],
  });
  // The input is not mutated.
  assert.equal(overrides.length, 3);
});

test('custom: legacyPlan tolerates every empty shape, and a reserved-only layer is a no-op', () => {
  for (const input of [undefined, null, [], 'nope', {}]) {
    const plan = legacyPlan(input);
    assert.deepEqual(plan.removed, []);
    assert.deepEqual(plan.next, { version: CONFIG_VERSION, overrides: [] });
  }
  const reservedOnly = legacyPlan([{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' }]);
  assert.deepEqual(reservedOnly.removed, [], 'nothing to remove means the caller must not write');
  assert.deepEqual(reservedOnly.next.overrides.map((entry) => entry.name), [CUSTOM_SECTION_NAME]);
});

test('custom: customOverridesOnly keeps the reserved entry and drops the rest, without mutating its input', () => {
  const overrides = [
    { name: 'a', action: 'hide' },
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
  ];
  assert.deepEqual(customOverridesOnly(overrides), [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' }]);
  assert.equal(overrides.length, 2);
  for (const input of [undefined, null, 'nope', {}]) {
    assert.deepEqual(customOverridesOnly(input), []);
  }
});

test('custom: exportScope declares what an export dropped, per layer and in total', () => {
  const views = {
    user: { overrides: [{ name: 'a' }, { name: CUSTOM_SECTION_NAME }, { name: 'b' }] },
    workspace: { overrides: [{ name: CUSTOM_SECTION_NAME }] },
  };
  assert.deepEqual(exportScope(views, ['user', 'workspace']), {
    only: CUSTOM_SECTION_NAME,
    omitted: { user: 2, workspace: 0, total: 2 },
  });
  // A subset export counts only the layers it covers.
  assert.deepEqual(exportScope(views, ['workspace']), { only: CUSTOM_SECTION_NAME, omitted: { workspace: 0, total: 0 } });
  assert.deepEqual(exportScope(views, ['user']), { only: CUSTOM_SECTION_NAME, omitted: { user: 2, total: 2 } });
  // A layer whose config is unusable reports no readable overrides: `0` means
  // "none seen", and the layer's own `reason` is where its state is stated.
  assert.deepEqual(exportScope({ user: {} }, ['user']), { only: CUSTOM_SECTION_NAME, omitted: { user: 0, total: 0 } });
  assert.deepEqual(exportScope(undefined, ['user']), { only: CUSTOM_SECTION_NAME, omitted: { user: 0, total: 0 } });
});

test('custom: an import document carrying any frozen name is 403 write-locked, whichever layer holds it', () => {
  throwsCode(
    () => assertImportableDocument({ layers: { user: [{ name: 'project:alpha', action: 'replace', text: 'x' }] } }),
    'write-locked',
    403,
  );
  // The check is document-wide: a frozen name in a layer the request would not
  // import is still a refusal, because the document as a whole is not importable.
  throwsCode(
    () => assertImportableDocument({ layers: { user: [], workspace: [{ name: 'project:beta', action: 'hide' }] } }),
    'write-locked',
    403,
  );
});

test('custom: an import document of reserved entries only is accepted, whatever action it carries', () => {
  // The name is the boundary; the action is taken from the document as it
  // stands, so a hand-edited config that hides the reserved section still
  // round-trips through export → import.
  for (const action of ['replace', 'hide', 'append']) {
    const entry = action === 'hide' ? { name: CUSTOM_SECTION_NAME, action } : { name: CUSTOM_SECTION_NAME, action, text: 'x' };
    assert.doesNotThrow(() => assertImportableDocument({ layers: { user: [entry] } }));
  }
  for (const document of [undefined, null, {}, { layers: null }, { layers: {} }, { layers: { user: [] } }]) {
    assert.doesNotThrow(() => assertImportableDocument(document), JSON.stringify(document));
  }
});

test('custom: the refusal message is bounded, however many frozen entries a document carries', () => {
  const overrides = Array.from({ length: 500 }, (_, index) => ({ name: `project:${index}`, action: 'hide' }));
  let message = '';
  try {
    assertImportableDocument({ layers: { user: overrides } });
  } catch (error) {
    message = error.message;
  }
  assert.equal(message.includes('\n'), false, 'one sentence, not a dump');
  assert.ok(message.length < 300, `the message stays short: ${message.length} chars`);
  assert.ok(message.includes('500'), 'and it still states the true count');
  assert.ok(message.includes('and 497 more'), `and admits the truncation: ${message}`);
});

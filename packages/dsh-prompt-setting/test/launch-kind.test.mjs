/**
 * Exhaustive assertions for the launch-shape judgement (g-036).
 *
 * The whole point of `core/launch-kind.js` is that its decision is a pure
 * function, so every branch can be enumerated here without a Host, a desktop
 * app or a browser: the desktop profile name is the only input that may produce
 * `'desktop'`, and no malformed input may ever produce `'cli'` by accident — a
 * desktop user shown the command-line copy is the defect being fixed.
 *
 * Run: `node --test test/`
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESKTOP_PROFILE_NAME,
  LAUNCH_KINDS,
  LAUNCH_KIND_CLI,
  LAUNCH_KIND_DESKTOP,
  LAUNCH_KIND_UNKNOWN,
  PROFILE_CONTEXT_SLOT,
  launchKindOf,
  launchKindOfName,
  launchKindOfProfileContext,
  normalizeLaunchKind,
} from '../core/launch-kind.js';
import { inject } from '../index.js';

test('launch-kind: the enum is exactly the three documented values', () => {
  assert.deepEqual([...LAUNCH_KINDS], ['cli', 'desktop', 'unknown']);
  assert.equal(DESKTOP_PROFILE_NAME, 'desktop');
  assert.equal(PROFILE_CONTEXT_SLOT, 'profileContext');
});

test('launch-kind: a profile name decides desktop only for the official name', () => {
  assert.equal(launchKindOfName('desktop'), LAUNCH_KIND_DESKTOP);
  assert.equal(launchKindOfName(' desktop '), LAUNCH_KIND_DESKTOP, 'surrounding whitespace is decoration');
  // The CLI's own profiles are the command-line shape. Case matters: DSH compares
  // the profile name literally, so `Desktop` is *not* the desktop profile.
  for (const name of ['web', 'tui', 'Desktop', 'DESKTOP', 'desktop2', 'web-desktop', '0']) {
    assert.equal(launchKindOfName(name), LAUNCH_KIND_CLI, `${JSON.stringify(name)} is the command line`);
  }
});

test('launch-kind: no missing or non-string name is ever judged cli', () => {
  for (const value of [undefined, null, '', '   ', 0, 1, true, false, {}, [], () => 'desktop', Symbol('desktop')]) {
    assert.equal(
      launchKindOfName(value),
      LAUNCH_KIND_UNKNOWN,
      `${String(value)} must be unknown, never cli`,
    );
  }
});

test('launch-kind: a malformed profileContext is unknown, never cli', () => {
  assert.equal(launchKindOfProfileContext({ name: 'desktop' }), LAUNCH_KIND_DESKTOP);
  assert.equal(launchKindOfProfileContext({ name: 'web' }), LAUNCH_KIND_CLI);
  for (const value of [undefined, null, 'desktop', 7, true, [], () => ({ name: 'desktop' })]) {
    assert.equal(launchKindOfProfileContext(value), LAUNCH_KIND_UNKNOWN, `${String(value)} is unknown`);
  }
  assert.equal(launchKindOfProfileContext({}), LAUNCH_KIND_UNKNOWN, 'a context without a name decides nothing');
  assert.equal(launchKindOfProfileContext({ name: null }), LAUNCH_KIND_UNKNOWN);
  // A throwing getter is unreadable, not command-line evidence.
  assert.equal(
    launchKindOfProfileContext({
      get name() {
        throw new Error('unreadable');
      },
    }),
    LAUNCH_KIND_UNKNOWN,
  );
});

test('launch-kind: the Host context lookup is optional and exception-free', () => {
  assert.equal(launchKindOf({ get: (slot) => (slot === PROFILE_CONTEXT_SLOT ? { name: 'desktop' } : undefined) }), LAUNCH_KIND_DESKTOP);
  assert.equal(launchKindOf({ get: () => ({ name: 'web' }) }), LAUNCH_KIND_CLI);
  assert.equal(launchKindOf({ get: () => undefined }), LAUNCH_KIND_UNKNOWN, 'no service means unknown');
  assert.equal(launchKindOf({ get: () => null }), LAUNCH_KIND_UNKNOWN);
  assert.equal(
    launchKindOf({
      get() {
        throw new Error('service lookup failed');
      },
    }),
    LAUNCH_KIND_UNKNOWN,
    'a throwing lookup must not fail a route',
  );
  for (const value of [undefined, null, {}, 'ctx', 3, { get: 'not-a-function' }]) {
    assert.equal(launchKindOf(value), LAUNCH_KIND_UNKNOWN, `${String(value)} has no usable lookup`);
  }
});

test('launch-kind: normalization accepts the two decided values and folds the rest to unknown', () => {
  assert.equal(normalizeLaunchKind('cli'), LAUNCH_KIND_CLI);
  assert.equal(normalizeLaunchKind('desktop'), LAUNCH_KIND_DESKTOP);
  for (const value of ['unknown', 'CLI', 'Desktop', '', ' cli ', undefined, null, 0, {}, []]) {
    assert.equal(normalizeLaunchKind(value), LAUNCH_KIND_UNKNOWN, `${String(value)} normalizes to unknown`);
  }
});

test('launch-kind: the profile context is read optionally, never injected', () => {
  // A hard dependency would make the whole plugin unloadable in a profile
  // without the service, and every route must keep answering `unknown` instead.
  assert.equal(inject.includes(PROFILE_CONTEXT_SLOT), false, 'profileContext must not be an injected service');
  assert.deepEqual([...inject], ['webServer', 'connection', 'systemPrompt']);
});

/**
 * Assertions for the g-062 assembly-status watch (`core/assembly-watch.js`).
 *
 * The module is pure policy with an injected clock and bounds, so the whole
 * state machine — the two layers, the new-conversation signal, the probe
 * exclusion, the bounded records and the fail-open paths — is driven here
 * without a Host.
 *
 * Run: `node --test test/`
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHANGE_NOTICE,
  FIRST_NOTICE,
  configuredTextOf,
  createAssemblyWatch,
  sectionTextOf,
  surfaceOperationOf,
  systemTextOf,
  textDigest,
} from '../core/assembly-watch.js';

/** One `system/message` event carrying `text`, as `Session.append` would store it. */
function systemEvent({ text, turn = 1, step = 1, seq = 7, surfaceOp = 'append' }) {
  return {
    type: 'system/message',
    seq,
    time: 0,
    surfaceOp,
    data: { turn, step, message: { role: 'system', content: [{ type: 'text', text }] } },
  };
}

/** One `request/header` event with the given reason. */
function headerEvent(reason) {
  return { type: 'request/header', seq: 1, time: 0, data: { reason, header: {} } };
}

/**
 * Bring one session past its first assembly.
 *
 * The first assembly this mount sees for a conversation is scenario A and
 * consumes any pending write, so every "the prompt changed" case starts from a
 * session that is already established.
 * @param watch - the watcher.
 * @param sessionId - the session id.
 * @param text - the prompt text this first assembly carries.
 * @returns the session's public record.
 */
function establish(watch, sessionId, text = 'A') {
  watch.observeAssembly({ sessionId, configuredText: text, segmentText: text, at: 0 });
  watch.observeSessionEvent({ sessionId, event: headerEvent('initial'), at: 0 });
  return watch.status(sessionId);
}

test('assembly-watch: textDigest is stable, distinguishes the empty text and is not a truncation', () => {
  assert.equal(textDigest(''), 'empty');
  assert.equal(textDigest(undefined), 'empty');
  assert.equal(textDigest('abc'), textDigest('abc'));
  assert.notEqual(textDigest('abc'), textDigest('abd'));
  assert.match(textDigest('hello world'), /^[0-9a-f]{8}$/);
});

test('assembly-watch: sectionTextOf / configuredTextOf read the reserved section only', () => {
  const sections = [
    { name: 'other', text: 'x' },
    { name: 'prompt-setting:custom-prompt', text: 'mine' },
  ];
  assert.equal(sectionTextOf(sections, 'prompt-setting:custom-prompt'), 'mine');
  assert.equal(sectionTextOf(sections, 'missing'), null);
  assert.equal(sectionTextOf(null, 'prompt-setting:custom-prompt'), null);

  const overrides = [
    { name: 'other', action: 'replace', text: 'x' },
    { name: 'prompt-setting:custom-prompt', action: 'replace', text: 'mine' },
  ];
  assert.equal(configuredTextOf(overrides, 'prompt-setting:custom-prompt'), 'mine');
  // `hide` is "nothing configured", not "configured with empty text".
  assert.equal(
    configuredTextOf([{ name: 'prompt-setting:custom-prompt', action: 'hide' }], 'prompt-setting:custom-prompt'),
    null,
  );
  assert.equal(configuredTextOf(overrides, 'missing'), null);
});

test('assembly-watch: the surface op and the system text survive both event shapes', () => {
  assert.equal(surfaceOperationOf({ surfaceOp: 'append' }), 'append');
  assert.equal(surfaceOperationOf({ surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } }), 'replace');
  assert.equal(surfaceOperationOf({}), null);
  assert.equal(systemTextOf(systemEvent({ text: 'prompt' })), 'prompt');
  assert.equal(systemTextOf({ data: { message: { content: 'plain' } } }), 'plain');
  assert.equal(systemTextOf({ data: { message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } } }), 'ab');
});

test('assembly-watch: a first assembly stays pending until the initial header, then reports "assembled"', () => {
  const watch = createAssemblyWatch({ now: () => 1000 });
  assert.equal(
    watch.observeAssembly({ sessionId: 's1', configuredText: 'hello', segmentText: 'hello', at: 1000 }),
    null,
  );
  // Nothing is reported before the new-conversation signal.
  assert.equal(watch.status('s1').notice, null);
  const notice = watch.observeSessionEvent({
    sessionId: 's1',
    event: headerEvent('initial'),
    at: 1010,
  });
  assert.equal(notice.kind, FIRST_NOTICE);
  assert.equal(notice.probe, false);
  assert.equal(notice.assemblyBasis, 'plugin-return');
  assert.equal(notice.assembly.state, 'assembled');
  assert.equal(notice.assembly.assembled, true);
  assert.equal(notice.configured, true);
  assert.equal(notice.delivery.state, 'waiting');
  const view = watch.status('s1');
  assert.equal(view.firstNoticeDone, true);
  assert.equal(view.notice.kind, FIRST_NOTICE);
  // The user's text never travels in the payload.
  assert.equal(JSON.stringify(view).includes('hello'), false);
});

test('assembly-watch: the first assembly of a conversation is scenario A even when a save preceded it', () => {
  const watch = createAssemblyWatch({ now: () => 0 });
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'NEW', at: 0 });
  // A `change` notice here would report the very same fact twice: setting a
  // prompt and then opening a conversation is not a change *under* one.
  assert.equal(watch.observeAssembly({ sessionId: 's1', configuredText: 'NEW', segmentText: 'NEW', at: 1 }), null);
  const notice = watch.observeSessionEvent({ sessionId: 's1', event: headerEvent('initial'), at: 2 });
  assert.equal(notice.kind, FIRST_NOTICE);
  // And the consumed write cannot fire a second notice on the following run.
  assert.equal(watch.observeAssembly({ sessionId: 's1', configuredText: 'NEW', segmentText: 'NEW', at: 3 }), null);
  assert.equal(watch.stats().notices, 1);
});

test('assembly-watch: scenario A reports "not assembled" when a configured prompt did not reach the section', () => {
  const watch = createAssemblyWatch({ now: () => 5 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'hello', segmentText: '', at: 5 });
  const notice = watch.observeSessionEvent({ sessionId: 's1', event: headerEvent('initial'), at: 6 });
  assert.equal(notice.kind, FIRST_NOTICE);
  assert.equal(notice.assembly.state, 'empty');
  assert.equal(notice.assembly.assembled, false);
  assert.equal(notice.configured, true);
});

test('assembly-watch: a session with no configured prompt produces no first notice', () => {
  const watch = createAssemblyWatch({ now: () => 5 });
  watch.observeAssembly({ sessionId: 's1', configuredText: null, segmentText: '', at: 5 });
  assert.equal(watch.observeSessionEvent({ sessionId: 's1', event: headerEvent('initial'), at: 6 }), null);
  assert.equal(watch.status('s1').firstNoticeDone, false);
  assert.equal(watch.status('s1').notice, null);
});

test('assembly-watch: resume/fork headers never become a first-assembly notice', () => {
  const watch = createAssemblyWatch({ now: () => 5 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'hello', segmentText: 'hello', at: 5 });
  assert.equal(watch.observeSessionEvent({ sessionId: 's1', event: headerEvent('resume'), at: 6 }), null);
  // Dropped, not queued: a later `initial` cannot resurrect it.
  assert.equal(watch.observeSessionEvent({ sessionId: 's1', event: headerEvent('initial'), at: 7 }), null);
  assert.equal(watch.status('s1').notice, null);
  // A later real first assembly is still reportable (a fresh session record).
  watch.observeAssembly({ sessionId: 's2', configuredText: 'hi', segmentText: 'hi', at: 8 });
  assert.equal(watch.observeSessionEvent({ sessionId: 's2', event: headerEvent('initial'), at: 9 }).kind, FIRST_NOTICE);
});

test('assembly-watch: a saved change reports the assembly layer, then the delivery layer after pre-step', () => {
  const watch = createAssemblyWatch({ now: () => 100 });
  establish(watch, 's1');
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'NEW', at: 100 });
  const notice = watch.observeAssembly({ sessionId: 's1', configuredText: 'NEW', segmentText: 'NEW', at: 110 });
  assert.equal(notice.kind, CHANGE_NOTICE);
  assert.equal(notice.assembly.state, 'read');
  assert.equal(notice.assembly.expectedDigest, textDigest('NEW'));
  assert.equal(notice.delivery.state, 'waiting');
  assert.equal(notice.expected.layer, 'user');

  watch.observePreStep({ sessionId: 's1', turn: 3, step: 2 });
  assert.equal(watch.status('s1').notice.turn, 3);
  assert.equal(watch.status('s1').notice.step, 2);

  const settled = watch.observeSessionEvent({
    sessionId: 's1',
    event: systemEvent({ text: 'SYSTEM\nNEW', turn: 3, step: 2, seq: 42, surfaceOp: 'append' }),
    at: 120,
  });
  assert.equal(settled.delivery.state, 'delivered');
  assert.equal(settled.delivery.seq, 42);
  assert.equal(settled.delivery.surfaceOp, 'append');
  assert.equal(settled.delivery.textMatched, true);
});

test('assembly-watch: a change that was not re-assembled says so, and a replace-head delivery is recorded', () => {
  const watch = createAssemblyWatch({ now: () => 100 });
  establish(watch, 's1');
  watch.markPromptWrite({ session: 's1', layer: 'workspace', action: 'replace', text: 'NEW', at: 100 });
  const notice = watch.observeAssembly({ sessionId: 's1', configuredText: 'NEW', segmentText: 'OLD', at: 110 });
  assert.equal(notice.assembly.state, 'not-read');
  watch.observePreStep({ sessionId: 's1', turn: 1, step: 1 });
  watch.observeSessionEvent({
    sessionId: 's1',
    event: systemEvent({ text: 'SYSTEM', turn: 1, step: 1, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } }),
    at: 120,
  });
  assert.equal(watch.status('s1').notice.delivery.surfaceOp, 'replace');
  assert.equal(watch.status('s1').notice.delivery.textMatched, false);
});

test('assembly-watch: an expanded text still counts as "read" (the stored text is a substring)', () => {
  const watch = createAssemblyWatch({ now: () => 100 });
  establish(watch, 's1');
  establish(watch, 's2');
  watch.markPromptWrite({ session: null, layer: 'user', action: 'replace', text: 'Hello {{name}}', at: 100 });
  const notice = watch.observeAssembly({
    sessionId: 's1',
    configuredText: 'Hello {{name}}',
    segmentText: 'Hello whale',
    at: 110,
  });
  assert.equal(notice.assembly.state, 'not-read');
  const notice2 = watch.observeAssembly({
    sessionId: 's2',
    configuredText: 'Hello {{name}}',
    segmentText: 'prefix Hello {{name}} suffix',
    at: 111,
  });
  assert.equal(notice2.assembly.state, 'read');
});

test('assembly-watch: a system/message of another step never settles this notice', () => {
  const watch = createAssemblyWatch({ now: () => 100 });
  establish(watch, 's1');
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'NEW', at: 100 });
  const notice = watch.observeAssembly({ sessionId: 's1', configuredText: 'NEW', segmentText: 'NEW', at: 110 });
  watch.observePreStep({ sessionId: 's1', turn: 2, step: 5 });
  assert.equal(
    watch.observeSessionEvent({ sessionId: 's1', event: systemEvent({ text: 'NEW', turn: 2, step: 4 }), at: 120 }),
    null,
  );
  assert.equal(watch.status('s1').notice.delivery.state, 'waiting');
  assert.equal(notice.delivery.state, 'waiting');
  watch.observeSessionEvent({ sessionId: 's1', event: systemEvent({ text: 'NEW', turn: 2, step: 5 }), at: 130 });
  assert.equal(watch.status('s1').notice.delivery.state, 'delivered');
});

test('assembly-watch: a delivery that was never observed settles as unconfirmed, lazily', () => {
  let clock = 0;
  const watch = createAssemblyWatch({ now: () => clock, settleMs: 50 });
  establish(watch, 's1');
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'NEW', at: 0 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'NEW', segmentText: 'NEW', at: 0 });
  assert.equal(watch.status('s1').notice.delivery.state, 'waiting');
  clock = 100;
  assert.equal(watch.status('s1').notice.delivery.state, 'unconfirmed');
});

test('assembly-watch: one notice per key node, newest first, and the record is bounded', () => {
  const watch = createAssemblyWatch({ now: () => 0, noticeLimit: 2 });
  establish(watch, 's1');
  for (const text of ['B', 'C', 'D']) {
    watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text, at: 0 });
    watch.observeAssembly({ sessionId: 's1', configuredText: text, segmentText: text, at: 0 });
  }
  const view = watch.status('s1');
  assert.equal(view.notices.length, 2);
  // The first-assembly notice and the B notice were pushed out, newest first.
  assert.equal(view.dropped, 2);
  // Newest first: D then C.
  assert.equal(view.notice.assembly.expectedDigest, textDigest('D'));
  assert.equal(view.notices[1].assembly.expectedDigest, textDigest('C'));
  assert.equal(watch.stats().droppedNotices, 2);
});

test('assembly-watch: repeated assemblies with no change never accumulate notices', () => {
  const watch = createAssemblyWatch({ now: () => 0 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'A', segmentText: 'A', at: 0 });
  watch.observeSessionEvent({ sessionId: 's1', event: headerEvent('initial'), at: 1 });
  for (let index = 0; index < 5; index += 1) {
    watch.observeAssembly({ sessionId: 's1', configuredText: 'A', segmentText: 'A', at: 10 + index });
    watch.observePreStep({ sessionId: 's1', turn: 1, step: index + 1 });
  }
  assert.equal(watch.stats().notices, 1);
  assert.equal(watch.status('s1').lastAssembly.length, 1);
});

test('assembly-watch: a stale change only fires once, on the next run', () => {
  const watch = createAssemblyWatch({ now: () => 0 });
  establish(watch, 's1');
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'B', at: 0 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'B', segmentText: 'B', at: 1 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'B', segmentText: 'B', at: 2 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'B', segmentText: 'B', at: 3 });
  assert.equal(watch.stats().notices, 2, 'one first assembly plus exactly one change');
  assert.equal(watch.status('s1').notices.filter((notice) => notice.kind === CHANGE_NOTICE).length, 1);
  assert.equal(watch.status('s1').notices.filter((notice) => notice.kind === FIRST_NOTICE).length, 1);
});

test('assembly-watch: a user-layer write addresses every session; a workspace write only its own', () => {
  const watch = createAssemblyWatch({ now: () => 0 });
  watch.observeAssembly({ sessionId: 's1', configuredText: null, segmentText: '', at: 0 });
  watch.observeAssembly({ sessionId: 's2', configuredText: null, segmentText: '', at: 0 });
  watch.markPromptWrite({ session: 's1', layer: 'workspace', action: 'replace', text: 'W', at: 1 });
  assert.equal(watch.observeAssembly({ sessionId: 's2', configuredText: 'W', segmentText: 'W', at: 2 }), null);
  assert.equal(
    watch.observeAssembly({ sessionId: 's1', configuredText: 'W', segmentText: 'W', at: 2 }).kind,
    CHANGE_NOTICE,
  );
  watch.markPromptWrite({ session: null, layer: 'user', action: 'replace', text: 'U', at: 3 });
  assert.equal(
    watch.observeAssembly({ sessionId: 's2', configuredText: 'U', segmentText: 'U', at: 4 }).kind,
    CHANGE_NOTICE,
  );
});

test('assembly-watch: the session table is bounded and a disposed session drops its record', () => {
  const watch = createAssemblyWatch({ now: () => Date.now(), sessionLimit: 2, noticeLimit: 4 });
  let clock = 0;
  const timed = createAssemblyWatch({ now: () => clock, sessionLimit: 2 });
  for (const id of ['a', 'b', 'c']) {
    clock += 1;
    timed.observeAssembly({ sessionId: id, configuredText: 'x', segmentText: 'x', at: clock });
  }
  assert.equal(timed.stats().sessions, 2);
  assert.equal(timed.status('a'), null);
  assert.notEqual(timed.status('c'), null);
  assert.equal(timed.disposeSession('c'), true);
  assert.equal(timed.status('c'), null);
  assert.equal(timed.disposeSession('c'), false);
  assert.equal(watch.stats().sessions, 0);
});

test('assembly-watch: the switch off stops new notices without losing the observation', () => {
  let on = true;
  const watch = createAssemblyWatch({ now: () => 0, enabled: () => on });
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'B', at: 0 });
  on = false;
  assert.equal(watch.observeAssembly({ sessionId: 's1', configuredText: 'B', segmentText: 'B', at: 1 }), null);
  assert.equal(watch.status('s1').notice, null);
  // The assembly itself is still on record — the switch silences the notice, not
  // the observation.
  assert.equal(watch.status('s1').lastAssembly.length, 1);
  on = true;
  assert.equal(watch.observeAssembly({ sessionId: 's1', configuredText: 'B', segmentText: 'B', at: 2 }).kind, CHANGE_NOTICE);
});

test('assembly-watch: a throwing switch reads as on, and malformed input never throws', () => {
  const watch = createAssemblyWatch({
    now: () => 0,
    enabled: () => {
      throw new Error('boom');
    },
  });
  // A first assembly arms scenario A, and the throwing switch did not stop it.
  assert.equal(watch.observeAssembly({ sessionId: 's1', configuredText: 'B', segmentText: 'B', at: 0 }), null);
  assert.equal(watch.observeSessionEvent({ sessionId: 's1', event: headerEvent('initial'), at: 0 }).kind, FIRST_NOTICE);
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'C', at: 1 });
  assert.equal(
    watch.observeAssembly({ sessionId: 's1', configuredText: 'C', segmentText: 'C', at: 1 }).kind,
    CHANGE_NOTICE,
  );

  const tolerant = createAssemblyWatch({ now: () => 0 });
  for (const bad of [undefined, null, {}, { sessionId: '' }, { sessionId: 7 }]) {
    assert.equal(tolerant.observeAssembly(bad), null);
  }
  tolerant.observePreStep(undefined);
  tolerant.observeSessionEvent(undefined);
  tolerant.observeSessionEvent({ sessionId: 'nope', event: { type: 'system/message' } });
  tolerant.markPromptWrite(undefined);
  assert.equal(tolerant.status('nope'), null);
  assert.equal(tolerant.disposeSession(undefined), false);
  assert.equal(typeof tolerant.stats().sessions, 'number');
});

test('assembly-watch: the probe counter is bookkeeping the page can read, not a verdict', () => {
  const watch = createAssemblyWatch({ now: () => 0 });
  watch.rejectProbe();
  watch.rejectProbe();
  assert.equal(watch.stats().rejectedProbes, 2);
  assert.equal(watch.stats().sessions, 0);
});

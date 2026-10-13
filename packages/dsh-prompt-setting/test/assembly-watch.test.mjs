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

test('assembly-watch: a cleared prompt is a change too — the empty write reports as read', () => {
  // Revision 48: the write paths spell "the prompt is now empty" as
  // `action: 'hide'` with an empty text (`DELETE`, `reset`, and since this round
  // the preset unapply that restores「there was none」). The watch must treat it
  // as the change it is: the assembly really did read an empty section.
  const watch = createAssemblyWatch({ now: () => 100 });
  establish(watch, 's1');
  watch.markPromptWrite({ session: 's1', layer: 'workspace', action: 'hide', text: '', at: 100 });
  const notice = watch.observeAssembly({ sessionId: 's1', configuredText: null, segmentText: '', at: 110 });
  assert.equal(notice.kind, CHANGE_NOTICE, 'a clearing is a prompt change, not silence');
  assert.equal(notice.assembly.state, 'read', 'the empty text is what the assembly really returned');
  assert.equal(notice.assembly.assembled, false);
  assert.equal(notice.configured, false, 'and this plugin no longer has a prompt configured');
  assert.equal(notice.expected.length, 0);
  assert.equal(notice.expected.action, 'hide');
  assert.equal(notice.expected.layer, 'workspace');
  // A second assembly with no further write adds nothing.
  assert.equal(watch.observeAssembly({ sessionId: 's1', configuredText: null, segmentText: '', at: 120 }), null);
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

test('assembly-watch: a page read never rewrites a delivery verdict, however late (review W4)', () => {
  let clock = 0;
  const watch = createAssemblyWatch({ now: () => clock });
  establish(watch, 's1');
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'NEW', at: 0 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'NEW', segmentText: 'NEW', at: 0 });
  watch.observePreStep({ sessionId: 's1', turn: 4, step: 1 });
  assert.equal(watch.status('s1').notice.delivery.state, 'waiting');
  // Ten minutes pass while the page polls — a read is a read.
  clock = 10 * 60 * 1000;
  assert.equal(watch.status('s1').notice.delivery.state, 'waiting');
  assert.equal(watch.status('s1').notice.delivery.state, 'waiting');
  // A late projection of the SAME step still settles as delivered: the earlier
  // reads must not have frozen the notice out of its own verdict.
  watch.observeSessionEvent({
    sessionId: 's1',
    event: systemEvent({ text: 'SYSTEM NEW', turn: 4, step: 1, seq: 5 }),
    at: clock,
  });
  assert.equal(watch.status('s1').notice.delivery.state, 'delivered');
});

test('assembly-watch: the next step starting settles a missed delivery as unconfirmed (review W4)', () => {
  const watch = createAssemblyWatch({ now: () => 0 });
  establish(watch, 's1');
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'NEW', at: 0 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'NEW', segmentText: 'NEW', at: 0 });
  watch.observePreStep({ sessionId: 's1', turn: 5, step: 1 });
  assert.equal(watch.status('s1').notice.delivery.state, 'waiting');
  // The next step proves the previous one is over — an event, not a deadline.
  watch.observePreStep({ sessionId: 's1', turn: 5, step: 2 });
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
  // Both sessions are established conversations: the header answers the
  // new-conversation question (review R1 — until it does, a save stays pending
  // rather than being consumed).
  for (const id of ['s1', 's2']) {
    watch.observeAssembly({ sessionId: id, configuredText: null, segmentText: '', at: 0 });
    watch.observeSessionEvent({ sessionId: id, event: headerEvent('resume'), at: 0 });
  }
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

test('assembly-watch: a save on an existing conversation reports delivered in the Host\'s real order (review R1/W2)', () => {
  const watch = createAssemblyWatch({ now: () => 0 });
  // The mount sees this conversation for the first time in the very step the
  // user saved a new prompt — a Host restart is the everyday version of this.
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'NEW', at: 0 });
  // The Host's real order inside one step: assemble → pre-step → system/message
  // → request/header. The projection is committed BEFORE the header that creates
  // the notice (review W2: the earlier case used the reverse order and so could
  // not see this).
  watch.observeAssembly({ sessionId: 's1', configuredText: 'NEW', segmentText: 'NEW', at: 1 });
  watch.observePreStep({ sessionId: 's1', turn: 3, step: 1 });
  watch.observeSessionEvent({
    sessionId: 's1',
    event: systemEvent({ text: 'SYSTEM NEW', turn: 3, step: 1, seq: 5 }),
    at: 2,
  });
  // An existing conversation answers `resume`, never `initial`.
  const notice = watch.observeSessionEvent({ sessionId: 's1', event: headerEvent('resume'), at: 3 });
  assert.equal(notice.kind, CHANGE_NOTICE, 'the save is reported as the change it is');
  assert.equal(notice.assembly.state, 'read');
  assert.equal(notice.turn, 3, 'and it kept the step label');
  assert.equal(notice.step, 1);
  assert.equal(notice.delivery.state, 'delivered', 'the step\'s own projection was already committed (review W1)');
  assert.equal(notice.delivery.seq, 5);
  assert.equal(notice.delivery.surfaceOp, 'append');
  // The step ending afterwards must not undo a delivered verdict.
  watch.observeSessionEvent({
    sessionId: 's1',
    event: { type: 'step/end', seq: 6, time: 0, data: { turn: 3, step: 1 } },
    at: 4,
  });
  assert.equal(watch.status('s1').notice.delivery.state, 'delivered');
  assert.equal(watch.stats().notices, 1, 'exactly one notice — the same fact is never reported twice');
});

test('assembly-watch: a first assembly reports delivered in the Host\'s real order too (review W2)', () => {
  const watch = createAssemblyWatch({ now: () => 0 });
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'MINE', at: 0 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'MINE', segmentText: 'MINE', at: 1 });
  watch.observePreStep({ sessionId: 's1', turn: 1, step: 1 });
  watch.observeSessionEvent({
    sessionId: 's1',
    event: systemEvent({ text: 'SYSTEM MINE', turn: 1, step: 1, seq: 9 }),
    at: 2,
  });
  const notice = watch.observeSessionEvent({ sessionId: 's1', event: headerEvent('initial'), at: 3 });
  assert.equal(notice.kind, FIRST_NOTICE);
  assert.equal(notice.delivery.state, 'delivered');
  assert.equal(notice.delivery.seq, 9);
  watch.observeSessionEvent({
    sessionId: 's1',
    event: { type: 'step/end', seq: 10, time: 0, data: { turn: 1, step: 1 } },
    at: 4,
  });
  assert.equal(watch.status('s1').notice.delivery.state, 'delivered');
});

test('assembly-watch: a save is not swallowed when no header ever arrives (review R1)', () => {
  const watch = createAssemblyWatch({ now: () => 0 });
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'NEW', at: 0 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'NEW', segmentText: 'NEW', at: 1 });
  watch.observePreStep({ sessionId: 's1', turn: 1, step: 1 });
  // The platform appends a header only when the configuration or the series
  // changed, so the next assembly resolves the candidate the other way.
  const notice = watch.observeAssembly({ sessionId: 's1', configuredText: 'NEW', segmentText: 'NEW', at: 2 });
  assert.equal(notice.kind, CHANGE_NOTICE);
  assert.equal(watch.status('s1').notice.delivery.state, 'waiting');
  assert.equal(watch.stats().notices, 1);
});

test('assembly-watch: a notice without a step label never settles off an unrelated step (review R2)', () => {
  const watch = createAssemblyWatch({ now: () => 0 });
  establish(watch, 's1');
  // A change whose run never produced a pre-step: no label is available.
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'NEW', at: 1 });
  const notice = watch.observeAssembly({ sessionId: 's1', configuredText: 'NEW', segmentText: 'NEW', at: 2 });
  assert.equal(notice.turn, null);
  assert.equal(notice.step, null);
  // An unrelated step's projection must NOT be read as this notice's delivery.
  assert.equal(
    watch.observeSessionEvent({ sessionId: 's1', event: systemEvent({ text: 'SYSTEM', turn: 3, step: 9, seq: 99 }), at: 3 }),
    null,
  );
  assert.equal(watch.status('s1').notice.delivery.state, 'waiting');
  // Its own step, once labelled, still settles.
  watch.observePreStep({ sessionId: 's1', turn: 4, step: 1 });
  watch.observeSessionEvent({ sessionId: 's1', event: systemEvent({ text: 'SYSTEM NEW', turn: 4, step: 1, seq: 7 }), at: 4 });
  assert.equal(watch.status('s1').notice.delivery.state, 'delivered');
});

test('assembly-watch: the step end is the exact deadline — no event by then is unconfirmed (review P2)', () => {
  const watch = createAssemblyWatch({ now: () => 0 });
  establish(watch, 's1');
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'NEW', at: 1 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'NEW', segmentText: 'NEW', at: 2 });
  watch.observePreStep({ sessionId: 's1', turn: 5, step: 2 });
  assert.equal(watch.status('s1').notice.delivery.state, 'waiting');
  // The step closes without a system/message: the miss is now a fact, not a
  // timeout that a slow streaming step could still earn back.
  watch.observeSessionEvent({ sessionId: 's1', event: { type: 'step/end', seq: 8, time: 0, data: { turn: 5, step: 2 } }, at: 3 });
  assert.equal(watch.status('s1').notice.delivery.state, 'unconfirmed');
  // A `step/end` of another step changes nothing.
  watch.observeSessionEvent({ sessionId: 's1', event: { type: 'step/end', seq: 9, time: 0, data: { turn: 5, step: 3 } }, at: 4 });
  assert.equal(watch.status('s1').notice.delivery.state, 'unconfirmed');
});

test('assembly-watch: a first assembly whose projection already committed reads as delivered (review R3)', () => {
  const watch = createAssemblyWatch({ now: () => 0 });
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'MINE', at: 0 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'MINE', segmentText: 'MINE', at: 1 });
  watch.observePreStep({ sessionId: 's1', turn: 1, step: 1 });
  // The Host commits this step's projection BEFORE the header that creates the
  // notice (the order review R3 measured) — without the cache this delivery
  // would be lost and misreported as unconfirmed.
  watch.observeSessionEvent({
    sessionId: 's1',
    event: systemEvent({ text: 'SYSTEM MINE', turn: 1, step: 1, seq: 7, surfaceOp: 'append' }),
    at: 2,
  });
  const notice = watch.observeSessionEvent({ sessionId: 's1', event: headerEvent('initial'), at: 3 });
  assert.equal(notice.kind, FIRST_NOTICE);
  assert.equal(notice.delivery.state, 'delivered');
  assert.equal(notice.delivery.seq, 7);
  assert.equal(notice.delivery.surfaceOp, 'append');
  assert.equal(notice.delivery.textMatched, true);
});

test('assembly-watch: a cached projection of ANOTHER step does not settle a first assembly (review R3)', () => {
  const watch = createAssemblyWatch({ now: () => 0 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'MINE', segmentText: 'MINE', at: 0 });
  watch.observePreStep({ sessionId: 's1', turn: 2, step: 1 });
  // A projection belonging to a previous step, then the header of this one.
  watch.observeSessionEvent({ sessionId: 's1', event: systemEvent({ text: 'OLD', turn: 1, step: 9, seq: 3 }), at: 1 });
  const notice = watch.observeSessionEvent({ sessionId: 's1', event: headerEvent('initial'), at: 2 });
  assert.equal(notice.delivery.state, 'waiting', 'the cache is matched by turn/step, never by recency alone');
});

// ---------------------------------------------------------------------------
// g-062 (Revision 46): the incremental feed the shell-overlay toaster reads.
//
// The per-session record answers "what is the latest key node"; the feed answers
// "what was born since cursor N", which is the only question a client that is
// not on the settings page can ask. What is pinned here is the cursor contract:
// an absent cursor never replays history, a cursor is only comparable within one
// mount, a consumed cursor never yields the same notice twice, and the log's
// bound turns into `stale` rather than into a burst.
// ---------------------------------------------------------------------------

test('assembly-watch: an absent cursor starts from now and never replays history', () => {
  const watch = createAssemblyWatch({ now: () => 0, bootId: 'boot-a' });
  establish(watch, 's1');
  const feed = watch.pendingNotices(null);
  assert.equal(feed.bootId, 'boot-a', 'the cursor belongs to one mount, and it says which');
  assert.equal(feed.cursor, watch.stats().noticeSeq, 'the answer says where "now" is');
  assert.deepEqual(feed.notices, [], 'a first connection is not a re-play');
  // A non-numeric cursor is the same request: "start from now".
  assert.deepEqual(watch.pendingNotices(undefined).notices, []);
  assert.deepEqual(watch.pendingNotices('n1').notices, []);
});

test('assembly-watch: the feed yields each new notice once, oldest first, tagged with its session', () => {
  const watch = createAssemblyWatch({ now: () => 0, bootId: 'boot-a' });
  const start = watch.pendingNotices(null).cursor;
  establish(watch, 's1');
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'NEW', at: 1 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'NEW', segmentText: 'NEW', at: 2 });

  const feed = watch.pendingNotices(start);
  assert.equal(feed.stale, false);
  assert.deepEqual(
    feed.notices.map((entry) => [entry.session, entry.notice.kind, entry.notice.seq]),
    [
      ['s1', FIRST_NOTICE, start + 1],
      ['s1', CHANGE_NOTICE, start + 2],
    ],
    'both key nodes, oldest first, each naming its conversation',
  );
  // The same cursor twice is the client's guarantee against a double toast: the
  // second answer is empty, because the cursor it was handed is now the newest.
  assert.deepEqual(watch.pendingNotices(feed.cursor).notices, []);
  // A notice carries the same public shape the page renders, plus `seq`.
  const [first] = feed.notices;
  assert.equal(first.notice.kind, FIRST_NOTICE);
  assert.equal(typeof first.notice.assembly.digest, 'string');
  assert.equal(first.notice.probe, false);
  assert.equal(JSON.stringify(feed).includes('NEW'), false, 'never the prompt text');
});

test('assembly-watch: the cursor is exclusive — the notice it names is never handed out again (review C3a)', () => {
  // The boundary the cursor contract lives on: `seq === cursor` is **not** news.
  // Two notices are needed for this to be observable at all — with `latest`
  // still equal to the cursor the function returns early, which is why the
  // obvious one-notice case passes even when the filter is inclusive.
  const watch = createAssemblyWatch({ now: () => 0, bootId: 'boot-a' });
  establish(watch, 's1');
  const seen = watch.pendingNotices(null).cursor;
  watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: 'NEW', at: 1 });
  watch.observeAssembly({ sessionId: 's1', configuredText: 'NEW', segmentText: 'NEW', at: 2 });
  const feed = watch.pendingNotices(seen);
  assert.deepEqual(
    feed.notices.map((entry) => entry.notice.seq),
    [seen + 1],
    'exactly the notice above the cursor, and not the one it already names',
  );
  assert.equal(feed.cursor, seen + 1, 'and the cursor moves to the newest notice');
  // And the same holds one step later: the client may send the cursor of the
  // notice it is currently showing.
  assert.deepEqual(watch.pendingNotices(seen + 1).notices, []);
});

test('assembly-watch: a cursor from another mount is not comparable and is answered "start from now"', () => {
  const first = createAssemblyWatch({ now: () => 0, bootId: 'boot-a' });
  establish(first, 's1');
  const consumed = first.pendingNotices(null).cursor;
  // A Host restart empties this watch and restarts `noticeSeq`: the same number
  // means something else, so the client must be told, not left comparing them.
  const restarted = createAssemblyWatch({ now: () => 0, bootId: 'boot-b' });
  establish(restarted, 's2');
  const feed = restarted.pendingNotices(consumed);
  assert.equal(feed.bootId, 'boot-b');
  assert.deepEqual(feed.notices, [], 'nothing is replayed across a restart');
  assert.equal(feed.cursor >= 1, true, 'but the cursor is re-anchored to this mount');
  // And the default boot id is a real per-mount identity, not a constant.
  assert.notEqual(createAssemblyWatch({ now: () => 0 }).bootId, createAssemblyWatch({ now: () => 0 }).bootId);
});

test('assembly-watch: a cursor older than the retained log is stale, and yields the newest notice only', () => {
  const watch = createAssemblyWatch({ now: () => 0, bootId: 'boot-a', historyLimit: 3 });
  establish(watch, 's1');
  const start = watch.pendingNotices(null).cursor;
  // Four more key nodes; only three births can be retained, so `start` is older
  // than the log by the time the client looks.
  for (let index = 0; index < 4; index += 1) {
    watch.markPromptWrite({ session: 's1', layer: 'user', action: 'replace', text: `T${index}`, at: index });
    watch.observeAssembly({ sessionId: 's1', configuredText: `T${index}`, segmentText: `T${index}`, at: index });
  }
  const feed = watch.pendingNotices(start);
  assert.equal(feed.stale, true, 'the client is told its cursor fell off the log');
  assert.equal(feed.notices.length, 1, 'one notice, not a burst of half-remembered ones');
  assert.equal(feed.notices[0].notice.seq, feed.cursor, 'and it is the newest');
  assert.equal(watch.stats().history <= 3, true, 'the log itself stays bounded');
});

test('assembly-watch: a disposed conversation leaves the feed, and the switch off produces nothing to send', () => {
  let enabled = true;
  const watch = createAssemblyWatch({ now: () => 0, bootId: 'boot-a', enabled: () => enabled });
  const start = watch.pendingNotices(null).cursor;
  establish(watch, 's1');
  assert.equal(watch.pendingNotices(start).notices.length, 1);
  // A conversation the Host removed is one the user can no longer open: its
  // notices must not be toasted after the fact.
  assert.equal(watch.disposeSession('s1'), true);
  assert.deepEqual(watch.pendingNotices(start).notices, []);

  // With the switch off no notice is born at all, so the feed has nothing to
  // report — "closed ⇒ no new prompt" is the Host's promise, not the page's.
  enabled = false;
  watch.markPromptWrite({ session: 's2', layer: 'user', action: 'replace', text: 'NEW', at: 1 });
  watch.observeAssembly({ sessionId: 's2', configuredText: 'NEW', segmentText: 'NEW', at: 2 });
  watch.observeSessionEvent({ sessionId: 's2', event: headerEvent('initial'), at: 3 });
  assert.deepEqual(watch.pendingNotices(start).notices, []);
  assert.equal(watch.status('s2').notice, null);
});

/**
 * `dsh-prompt-setting` — the in-session assembly-status watch (g-062), host side.
 *
 * The problem this module answers: a user edits their prompt in this plugin and
 * cannot tell whether the change reached the model. DSH re-assembles the system
 * prompt on **every** model step (`AgentLoop.preStep()` →
 * `systemPrompt.assemble()`), but "assembled" is not "delivered" —
 * `SystemPromptProjection.project()` deduplicates, and an unchanged prompt
 * produces **zero** `system/message` events. This module keeps the two layers
 * apart, on purpose:
 *
 *   - **assembly layer** — did this step's assembly read the (changed) plugin
 *     section text? Observed directly from the section list this plugin
 *     returned;
 *   - **delivery layer** — did that text enter this request's messages? Observed
 *     from the `system/message` event the step committed on the session
 *     surface (`append` or `replace` of the head node). Whether the HTTP request
 *     was actually sent is **not** observable from a plugin, and this module
 *     does not claim it.
 *
 * Pure policy, no IO, zero dependencies: every side effect (the clock, the
 * per-session bookkeeping) is injected or in-memory, so `test/assembly-watch.test.mjs`
 * drives the whole state machine without a Host.
 *
 * Three invariants:
 *   - **observer only.** Nothing here can change an assembly: the watcher is
 *     handed text that already exists and returns nothing the assembly path uses.
 *   - **fail-open.** Every public method swallows its own errors; a broken
 *     observation must never break a user's turn.
 *   - **bounded.** Per-session notices and the number of tracked sessions are
 *     both capped, and a disposed session drops its record.
 *
 * @module dsh-prompt-setting/core/assembly-watch
 */

/** Notice kind: the first assembly of a new conversation. */
export const FIRST_NOTICE = 'first-assembly';
/** Notice kind: the next run after the user saved a new prompt. */
export const CHANGE_NOTICE = 'prompt-change';
/** How many notices one session retains (newest first). */
export const NOTICE_LIMIT = 6;
/** How many sessions are tracked at once; the least recently touched is dropped. */
export const SESSION_LIMIT = 64;
/** How many prompt writes are retained as "the change to watch for". */
export const WRITE_LIMIT = 8;
/**
 * How long a notice may wait for its delivery evidence before it is reported as
 * unconfirmed. The wait is settled lazily on read, so this module needs no timer.
 */
export const DELIVERY_SETTLE_MS = 20 * 1000;
/**
 * Longest plugin-section text this module will `includes()`-probe inside a
 * delivered system message. Above it the delivery verdict still stands (the
 * event exists), only the "does this text carry the section" detail is left
 * unstated instead of costing an unbounded scan.
 */
export const TEXT_MATCH_LIMIT = 4000;
/** The unscoped write bucket: a `user`-layer save that names no session. */
export const GLOBAL_WRITE = null;

/**
 * FNV-1a 32 over a string, as 8 lowercase hex digits.
 *
 * Not a security hash: it exists to compare one stored prompt with the text an
 * assembly produced without keeping either string around, and it is cheap
 * enough to run on every assembly.
 * @param text - the text to digest.
 * @returns 8 hex digits, or `'empty'` for an empty/absent text.
 */
export function textDigest(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.length === 0) return 'empty';
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The surface operation of a `system/message` event, in the two words the page
 * shows: `append`, `replace` (a head/series rewrite), or `null` when the event
 * carries no usable marker.
 * @param event - the appended session event.
 * @returns `'append'`, `'replace'` or `null`.
 */
export function surfaceOperationOf(event) {
  const op = event?.surfaceOp;
  if (op === 'append') return 'append';
  if (op !== null && typeof op === 'object' && op.op === 'replace') return 'replace';
  return null;
}

/**
 * The text of a committed `system/message` event, or `''` when it carries none.
 * @param event - the appended session event.
 * @returns the message text.
 */
export function systemTextOf(event) {
  const content = event?.data?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block !== null && typeof block === 'object' && typeof block.text === 'string') text += block.text;
  }
  return text;
}

/**
 * The plugin-section text inside one assembly's final section list.
 * @param sections - the section list an assembly returned.
 * @param name - the reserved section name.
 * @returns the text, or `null` when the section is not in that list.
 */
export function sectionTextOf(sections, name) {
  if (!Array.isArray(sections)) return null;
  const section = sections.find((entry) => entry !== null && typeof entry === 'object' && entry.name === name);
  if (section === undefined) return null;
  return typeof section.text === 'string' ? section.text : '';
}

/**
 * The text the resolved override list would apply to the reserved section, or
 * `null` when nothing is configured for it (absent, or hidden).
 *
 * This is "what the user set in this plugin", read from the very config the
 * assembly resolved — so a configured prompt that never reaches the rendered
 * section (frozen layer, a later rewrite) is still reported as **configured but
 * not assembled**, which is the distinction scenario A asks for.
 * @param overrides - the resolved override list of one assembly.
 * @param name - the reserved section name.
 * @returns the configured text, or `null`.
 */
export function configuredTextOf(overrides, name) {
  if (!Array.isArray(overrides)) return null;
  const entry = overrides.find((item) => item !== null && typeof item === 'object' && item.name === name);
  if (entry === undefined || entry.action === 'hide') return null;
  return typeof entry.text === 'string' ? entry.text : null;
}

/**
 * Create one mount's assembly watch.
 *
 * @param options - injectable bounds and clock.
 * @param options.now - the clock in epoch ms (defaults to `Date.now`).
 * @param options.noticeLimit - notices retained per session.
 * @param options.sessionLimit - sessions tracked at once.
 * @param options.writeLimit - retained prompt writes.
 * @param options.settleMs - delivery wait before a notice reads unconfirmed.
 * @param options.sectionName - the reserved section name (never guessed here).
 * @param options.enabled - `() => boolean`; when it answers false no **new**
 *   notice is produced (the switch is off), while bookkeeping stays intact.
 * @returns the watcher.
 */
export function createAssemblyWatch(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const noticeLimit = Number.isSafeInteger(options.noticeLimit) && options.noticeLimit > 0 ? options.noticeLimit : NOTICE_LIMIT;
  const sessionLimit =
    Number.isSafeInteger(options.sessionLimit) && options.sessionLimit > 0 ? options.sessionLimit : SESSION_LIMIT;
  const writeLimit = Number.isSafeInteger(options.writeLimit) && options.writeLimit > 0 ? options.writeLimit : WRITE_LIMIT;
  const settleMs = Number.isSafeInteger(options.settleMs) && options.settleMs >= 0 ? options.settleMs : DELIVERY_SETTLE_MS;
  const sectionName = typeof options.sectionName === 'string' ? options.sectionName : null;
  const enabled = typeof options.enabled === 'function' ? options.enabled : () => true;

  /** Per-session records, insertion-ordered by first sight and re-touched on use. */
  const records = new Map();
  /** Retained prompt writes, oldest first; the tail is the newest change. */
  const writes = [];
  let writeSeq = 0;
  let noticeSeq = 0;
  let droppedNotices = 0;
  let rejectedProbes = 0;

  /** @returns true when the switch allows a NEW notice to be produced. */
  function noticesAllowed() {
    try {
      return enabled() !== false;
    } catch {
      // A switch that throws is not a reason to lose the feature, and it is not
      // a reason to break a turn either: fail open to "on".
      return true;
    }
  }

  /**
   * The record for one session, created on first sight.
   * @param sessionId - the session id.
   * @returns the record.
   */
  function recordFor(sessionId) {
    let record = records.get(sessionId);
    if (record !== undefined) {
      record.touchedAt = now();
      return record;
    }
    record = {
      sessionId,
      firstNoticeDone: false,
      pendingFirst: null,
      lastAssembly: null,
      active: null,
      notices: [],
      dropped: 0,
      consumedWriteSeq: 0,
      touchedAt: now(),
    };
    records.set(sessionId, record);
    trimSessions();
    return record;
  }

  /** Drop the least recently touched sessions once the cap is exceeded. */
  function trimSessions() {
    while (records.size > sessionLimit) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, record] of records) {
        if (record.touchedAt < oldestAt) {
          oldestAt = record.touchedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      records.delete(oldestKey);
    }
  }

  /**
   * The newest retained write that addresses this session: a `user`-layer save
   * (unscoped, so it addresses every session) or a `workspace`-layer save naming
   * exactly this session.
   * @param sessionId - the session id.
   * @returns the write entry, or null.
   */
  function writeFor(sessionId) {
    for (let index = writes.length - 1; index >= 0; index -= 1) {
      const write = writes[index];
      if (write.session === GLOBAL_WRITE || write.session === sessionId) return write;
    }
    return null;
  }

  /**
   * Push one notice onto a record, newest first, and make it the active one.
   * @param record - the session record.
   * @param notice - the notice to retain.
   */
  function pushNotice(record, notice) {
    record.notices.unshift(notice);
    if (record.notices.length > noticeLimit) {
      record.notices.length = noticeLimit;
      record.dropped += 1;
      droppedNotices += 1;
    }
    record.active = notice;
  }

  /**
   * One notice, assembled from the facts known at the key node.
   * @param kind - {@link FIRST_NOTICE} or {@link CHANGE_NOTICE}.
   * @param input - the node's facts.
   * @returns the notice.
   */
  function makeNotice(kind, input) {
    noticeSeq += 1;
    return {
      id: `n${noticeSeq}`,
      kind,
      at: input.at,
      turn: input.turn ?? null,
      step: input.step ?? null,
      // The user has a prompt stored for this plugin (scenario A's precondition).
      configured: input.configured === true,
      assembly: {
        // `read` / `not-read` are the change-notice verdicts; a first notice
        // states `assembled` instead, because there is no earlier text to
        // compare against.
        state: input.assemblyState,
        assembled: input.assembled === true,
        digest: input.digest,
        length: input.length,
        expectedDigest: input.expectedDigest ?? null,
      },
      delivery: { state: 'waiting', at: null, seq: null, surfaceOp: null, textMatched: null },
      // Stated limitation, carried on every notice so the page never has to
      // re-derive it: the text recorded here is what THIS plugin returned, and a
      // `{prepend: true}` listener registered after this plugin may still
      // rewrite the sections.
      assemblyBasis: 'plugin-return',
      probe: false,
      // Internal: the text a delivered system message must carry to answer the
      // optional "does this text really contain the prompt" detail. Never
      // serialized (`publicNotice` drops it) — the page shows lengths and
      // digests, not a copy of the user's prompt.
      expectedText: typeof input.expectedText === 'string' ? input.expectedText : null,
    };
  }

  /**
   * Arm scenario A's pending first notice for one session.
   *
   * The notice itself is only produced when the `request/header` event confirms
   * this is really a new conversation (`reason: 'initial'`).
   * @param record - the session record.
   * @param input - `{at, configuredText, segmentText}`.
   */
  function armFirstNotice(record, input) {
    record.pendingFirst = {
      at: input.at,
      configured: true,
      assembled: input.segmentText.length > 0,
      digest: textDigest(input.segmentText),
      length: input.segmentText.length,
      expectedDigest: textDigest(input.configuredText),
      expectedText: input.configuredText.length > TEXT_MATCH_LIMIT ? null : input.configuredText,
      turn: null,
      step: null,
    };
  }

  /**
   * Note one real (non-probe) assembly.
   *
   * Called from the `system-prompt/assemble` listener with the text that
   * listener is about to return. Nothing here changes that text.
   * @param input - `{sessionId, configuredText, segmentText, at}`.
   * @returns the notice this assembly produced, or null.
   */
  function observeAssembly(input) {
    try {
      const sessionId = input?.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
      const at = Number.isFinite(input?.at) ? input.at : now();
      const segmentText = typeof input?.segmentText === 'string' ? input.segmentText : '';
      const configuredText = typeof input?.configuredText === 'string' ? input.configuredText : null;
      const record = recordFor(sessionId);
      // The very first assembly this mount sees for a conversation is scenario A
      // — "the user set a prompt, report whether it was assembled" — even when a
      // save happened moments earlier. Recording first, so the branch below can
      // tell the two cases apart.
      const firstSight = record.lastAssembly === null;
      record.lastAssembly = {
        at,
        digest: textDigest(segmentText),
        length: segmentText.length,
        configured: configuredText !== null,
      };
      if (noticesAllowed() !== true) return null;

      const write = writeFor(sessionId);
      const hasPendingWrite = write !== null && write.seq > record.consumedWriteSeq;

      if (firstSight === true) {
        // Consume the pending write without reporting it as a change: setting a
        // prompt before (or while) opening a conversation is not "the prompt
        // changed under an existing conversation", and reporting both would be
        // the same fact twice.
        if (hasPendingWrite) record.consumedWriteSeq = write.seq;
        // Scenario A's precondition: the user must have set a prompt in this
        // plugin. Without one there is nothing to report, assembled or not.
        if (configuredText === null) return null;
        armFirstNotice(record, { at, configuredText, segmentText });
        return null;
      }

      if (hasPendingWrite === true) {
        record.consumedWriteSeq = write.seq;
        const digest = textDigest(segmentText);
        // The assembly layer: did the section this step assembled carry the text
        // the save wrote? An exact digest match is the precise case; the
        // `includes` fallback covers the ON-switch expansion, where variables in
        // the stored text are substituted before the section is rendered — the
        // stored text is then a substring of what was assembled, and calling
        // that "not re-assembled" would be wrong.
        const readBack =
          digest === write.digest ||
          (write.text !== null && segmentText.length > 0 && segmentText.includes(write.text));
        const notice = makeNotice(CHANGE_NOTICE, {
          at,
          turn: null,
          step: null,
          configured: configuredText !== null,
          assemblyState: readBack ? 'read' : 'not-read',
          assembled: segmentText.length > 0,
          digest,
          length: segmentText.length,
          expectedDigest: write.digest,
          expectedText: write.text,
        });
        notice.expected = { length: write.length, layer: write.layer ?? null, action: write.action ?? null };
        pushNotice(record, notice);
        return notice;
      }

      if (record.firstNoticeDone === true || record.pendingFirst !== null) return null;
      // A later assembly of an already-seen conversation with no pending write:
      // only relevant when a prompt appeared *without* a save this mount saw
      // (a hand edit of the layer files), which is still scenario A.
      if (configuredText === null) return null;
      armFirstNotice(record, { at, configuredText, segmentText });
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Note one prompt save, so the session's next run can report whether the
   * change was re-assembled and delivered.
   * @param input - `{session, layer, action, text, at}`.
   * @returns nothing; a malformed save is ignored.
   */
  function markPromptWrite(input) {
    try {
      const text = typeof input?.text === 'string' ? input.text : '';
      writeSeq += 1;
      writes.push({
        seq: writeSeq,
        at: Number.isFinite(input?.at) ? input.at : now(),
        digest: textDigest(text),
        length: text.length,
        // Internal: kept only to answer the optional "delivered message really
        // contains this text" detail; bounded by the same cap that guards the
        // scan (`TEXT_MATCH_LIMIT`).
        text: text.length > TEXT_MATCH_LIMIT ? null : text,
        layer: typeof input?.layer === 'string' ? input.layer : null,
        action: typeof input?.action === 'string' ? input.action : null,
        // `null` = every session (a `user`-layer save names none); a string = the
        // one session whose workspace layer was written.
        session: typeof input?.session === 'string' && input.session.length > 0 ? input.session : GLOBAL_WRITE,
      });
      if (writes.length > writeLimit) writes.splice(0, writes.length - writeLimit);
    } catch {
      // Fail open: a save that cannot be noted still saves.
    }
  }

  /**
   * Label the node currently waiting (the assembly this step just ran) with the
   * turn/step the Host dispatched it under.
   * @param input - `{sessionId, turn, step}`.
   */
  function observePreStep(input) {
    try {
      const record = records.get(input?.sessionId);
      if (record === undefined) return;
      record.touchedAt = now();
      const target = record.pendingFirst ?? (record.active?.delivery?.state === 'waiting' ? record.active : null);
      if (target === null || target === undefined) return;
      if (!Number.isFinite(target.turn) && Number.isFinite(input?.turn)) target.turn = input.turn;
      if (!Number.isFinite(target.step) && Number.isFinite(input?.step)) target.step = input.step;
    } catch {
      // Fail open.
    }
  }

  /**
   * Fold one committed session event into the session's record.
   * @param input - `{sessionId, event, at}`.
   * @returns the notice a settlement produced, or null.
   */
  function observeSessionEvent(input) {
    try {
      const record = records.get(input?.sessionId);
      if (record === undefined) return null;
      record.touchedAt = now();
      const event = input?.event;
      if (event === null || typeof event !== 'object') return null;

      if (event.type === 'request/header') {
        const reason = event?.data?.reason;
        if (record.pendingFirst === null) return null;
        if (reason === 'initial') {
          // The strongest new-conversation signal: the log's first request
          // header. `resume` / `fork` never produce it (`RequestHeaderReason`).
          const pending = record.pendingFirst;
          record.pendingFirst = null;
          record.firstNoticeDone = true;
          const notice = makeNotice(FIRST_NOTICE, {
            at: pending.at,
            turn: pending.turn,
            step: pending.step,
            configured: pending.configured,
            assemblyState: pending.assembled ? 'assembled' : 'empty',
            assembled: pending.assembled,
            digest: pending.digest,
            length: pending.length,
            expectedDigest: pending.expectedDigest,
            expectedText: pending.expectedText,
          });
          pushNotice(record, notice);
          return notice;
        }
        // Not a new conversation (a resume, a fork, a later change): scenario A
        // does not apply, so the pending first notice is dropped rather than
        // reported as a first assembly.
        record.pendingFirst = null;
        return null;
      }

      if (event.type !== 'system/message') return null;
      const active = record.active;
      if (active === null || active.delivery?.state !== 'waiting') return null;
      const turn = event?.data?.turn;
      const step = event?.data?.step;
      // Align on the step this notice belongs to when both sides state one: a
      // later step's projection must not be read as this step's delivery.
      if (Number.isFinite(active.turn) && Number.isFinite(turn) && active.turn !== turn) return null;
      if (Number.isFinite(active.step) && Number.isFinite(step) && active.step !== step) return null;
      const text = systemTextOf(event);
      const expected = active.expectedText;
      active.delivery = {
        // The agreed verdict: this step committed a `system/message` on the
        // surface, so the prompt text is in this request's messages.
        state: 'delivered',
        at: Number.isFinite(input?.at) ? input.at : now(),
        seq: Number.isFinite(event?.seq) ? event.seq : null,
        surfaceOp: surfaceOperationOf(event),
        textMatched:
          typeof expected !== 'string' || expected.length === 0 || expected.length > TEXT_MATCH_LIMIT
            ? null
            : text.includes(expected),
      };
      return active;
    } catch {
      return null;
    }
  }

  /**
   * Drop one session's record (the Host announced it left the store).
   * @param sessionId - the session id.
   * @returns true when a record was dropped.
   */
  function disposeSession(sessionId) {
    try {
      return records.delete(sessionId);
    } catch {
      return false;
    }
  }

  /**
   * Settle a record's pending delivery waits whose deadline has passed.
   *
   * Lazy on purpose: no timer is registered, so this module owns no lifecycle
   * and a page that never reads costs nothing.
   * @param record - the session record.
   * @param at - the current clock reading.
   */
  function settle(record, at) {
    for (const notice of record.notices) {
      if (notice.delivery?.state !== 'waiting') continue;
      if (at - notice.at < settleMs) continue;
      notice.delivery = { ...notice.delivery, state: 'unconfirmed' };
    }
  }

  /**
   * The public, read-only view of one session.
   * @param sessionId - the session id.
   * @returns the view, or null when this mount has never seen the session.
   */
  function status(sessionId) {
    try {
      const record = records.get(sessionId);
      if (record === undefined) return null;
      const at = now();
      settle(record, at);
      const notice = record.notices[0] ?? null;
      return {
        session: record.sessionId,
        firstNoticeDone: record.firstNoticeDone,
        lastAssembly: record.lastAssembly === null ? null : { ...record.lastAssembly },
        notice: notice === null ? null : publicNotice(notice),
        notices: record.notices.slice(0, 3).map(publicNotice),
        dropped: record.dropped,
      };
    } catch {
      return null;
    }
  }

  /**
   * The public shape of one notice: everything the page renders, and never the
   * user's prompt text (only lengths and digests travel).
   * @param notice - the stored notice.
   * @returns the public notice.
   */
  function publicNotice(notice) {
    return {
      id: notice.id,
      kind: notice.kind,
      at: notice.at,
      turn: notice.turn,
      step: notice.step,
      configured: notice.configured,
      assembly: { ...notice.assembly },
      delivery: { ...notice.delivery },
      assemblyBasis: notice.assemblyBasis,
      probe: notice.probe,
      ...(notice.expected === undefined ? {} : { expected: { ...notice.expected } }),
    };
  }

  /** Counters for the page and for tests; never throws. */
  function stats() {
    try {
      return {
        sessions: records.size,
        notices: [...records.values()].reduce((total, record) => total + record.notices.length, 0),
        droppedNotices,
        writes: writes.length,
        rejectedProbes,
        noticeSeq,
      };
    } catch {
      return { sessions: 0, notices: 0, droppedNotices, writes: 0, rejectedProbes, noticeSeq };
    }
  }

  /**
   * Count one assembly this module deliberately did not observe (a probe or an
   * unscoped assembly). Observability fact, not a verdict.
   * @returns nothing.
   */
  function rejectProbe() {
    rejectedProbes += 1;
  }

  return {
    sectionName,
    observeAssembly,
    markPromptWrite,
    observePreStep,
    observeSessionEvent,
    disposeSession,
    status,
    stats,
    rejectProbe,
  };
}

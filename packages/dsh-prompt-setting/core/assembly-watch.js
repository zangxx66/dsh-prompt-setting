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
 * How many notices the **global** birth log retains for the incremental feed
 * (`pendingNotices`) the shell-overlay toaster reads.
 *
 * The per-session record answers "what is the latest key node for this
 * conversation" and is read on demand; this log answers "what was born since
 * cursor N", which is what a client that is *not* on the settings page needs.
 * It is deliberately smaller than `SESSION_LIMIT * NOTICE_LIMIT`: a client
 * that has been away long enough to fall off this log is answered with
 * `stale: true` plus the newest notice, never with a burst of old ones.
 */
export const NOTICE_HISTORY_LIMIT = 24;
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
 * @param options.sectionName - the reserved section name (never guessed here).
 * @param options.enabled - `() => boolean`; when it answers false no **new**
 *   notice is produced (the switch is off), while bookkeeping stays intact.
 * @param options.bootId - this mount's identity, handed to clients that keep a
 *   cursor across page loads: a cursor is only comparable with notices of the
 *   **same** mount, because a Host restart empties this watch and restarts
 *   `noticeSeq` at 0 (defaults to a fresh per-mount id).
 * @returns the watcher.
 */
export function createAssemblyWatch(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const noticeLimit = Number.isSafeInteger(options.noticeLimit) && options.noticeLimit > 0 ? options.noticeLimit : NOTICE_LIMIT;
  const sessionLimit =
    Number.isSafeInteger(options.sessionLimit) && options.sessionLimit > 0 ? options.sessionLimit : SESSION_LIMIT;
  const writeLimit = Number.isSafeInteger(options.writeLimit) && options.writeLimit > 0 ? options.writeLimit : WRITE_LIMIT;
  const historyLimit =
    Number.isSafeInteger(options.historyLimit) && options.historyLimit > 0 ? options.historyLimit : NOTICE_HISTORY_LIMIT;
  const sectionName = typeof options.sectionName === 'string' ? options.sectionName : null;
  const enabled = typeof options.enabled === 'function' ? options.enabled : () => true;
  const bootId =
    typeof options.bootId === 'string' && options.bootId.length > 0
      ? options.bootId
      : `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /** Per-session records, insertion-ordered by first sight and re-touched on use. */
  const records = new Map();
  /** Retained prompt writes, oldest first; the tail is the newest change. */
  const writes = [];
  /**
   * The global birth log, oldest first and bounded by {@link NOTICE_HISTORY_LIMIT}:
   * `{seq, sessionId, notice}` for every notice this mount produced. It is what
   * makes the incremental feed possible without walking every session record.
   */
  let births = [];
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
      /**
       * Whether the new-conversation question has been answered for this session
       * (`initial` header seen, or proven not to be one). Until it is, an
       * assembly arms {@link armFirstNotice} and the pending write stays
       * **unconsumed** — a conversation this mount happens to see for the first
       * time is not automatically a new conversation (review R1).
       */
      firstDecided: false,
      pendingFirst: null,
      /**
       * The newest `system/message` this session committed, kept whether or not a
       * notice was waiting for it: the Host may commit this step's projection
       * **before** the `request/header` that turns a pending first assembly into
       * a notice, and without this cache that step's delivery would be lost and
       * misreported as unconfirmed (review R3).
       */
      recentSystem: null,
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
   *
   * This is also the single place a notice enters the global birth log, so the
   * incremental feed and the per-session record can never disagree about
   * whether a notice exists.
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
    births.push({ seq: notice.seq, sessionId: record.sessionId, notice });
    if (births.length > historyLimit) births.splice(0, births.length - historyLimit);
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
      /**
       * The numeric half of `id`, and the cursor a client keeps: it is monotone
       * **within one mount**, which is exactly the scope a cursor may be
       * compared across (`bootId` says which mount).
       */
      seq: noticeSeq,
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
   * Did an assembly's section text carry the text a save wrote?
   *
   * An exact digest match is the precise case; the `includes` fallback covers the
   * ON-switch expansion, where variables in the stored text are substituted
   * before the section is rendered — the stored text is then a substring of what
   * was assembled, and calling that "not re-assembled" would be wrong.
   * @param segmentText - the plugin section's final text.
   * @param write - the save entry (`null` when none is attached).
   * @returns true / false, or `null` when there is nothing to compare against.
   */
  function readBackOf(segmentText, write) {
    if (write === null || write === undefined) return null;
    if (textDigest(segmentText) === write.digest) return true;
    if (write.text === null) return false;
    return segmentText.length > 0 && segmentText.includes(write.text);
  }

  /**
   * Arm scenario A's pending first notice for one session.
   *
   * The notice itself is produced only when the `request/header` event confirms
   * this really is a new conversation (`reason: 'initial'`); a non-`initial`
   * header resolves the question the other way and — when a save is attached —
   * produces the `prompt-change` notice instead. Until then the attached write is
   * deliberately **not** consumed.
   * @param record - the session record.
   * @param input - `{at, configuredText, segmentText, write}`.
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
      // Precomputed while the text is in hand: if the header answers "not a new
      // conversation", the assembly layer's verdict is already decided and there
      // is no reason to keep (or recompute from) the text.
      readBack: readBackOf(input.segmentText, input.write),
      turn: null,
      step: null,
      // The write whose fate depends on the header's reason, or null when the
      // user's prompt did not change under this mount's eyes.
      writeSeq: input.write === null || input.write === undefined ? null : input.write.seq,
    };
  }

  /**
   * Build and retain the `prompt-change` notice for one write against one
   * assembly's text.
   *
   * The assembly layer answers "did this step's assembly read the changed text":
   * an exact digest match is the precise case, while the `includes` fallback
   * covers the ON-switch expansion, where variables in the stored text are
   * substituted before the section is rendered — the stored text is then a
   * substring of what was assembled, and calling that "not re-assembled" would be
   * wrong.
   * @param record - the session record.
   * @param input - `{at, turn, step, configuredText, segmentText, write}`.
   * @returns the notice, already pushed.
   */
  function emitChangeNotice(record, input) {
    const { write } = input;
    const digest = textDigest(input.segmentText);
    const readBack = readBackOf(input.segmentText, write) === true;
    const notice = makeNotice(CHANGE_NOTICE, {
      at: input.at,
      turn: input.turn ?? null,
      step: input.step ?? null,
      configured: input.configuredText !== null,
      assemblyState: readBack ? 'read' : 'not-read',
      assembled: input.segmentText.length > 0,
      digest,
      length: input.segmentText.length,
      expectedDigest: write.digest,
      expectedText: write.text,
    });
    notice.expected = { length: write.length, layer: write.layer ?? null, action: write.action ?? null };
    // A change notice answers the pending question, so any half-armed first
    // notice is gone: leaving it would keep stealing the step label from this
    // notice (review R2). The same-step cache is applied by `finalizeNotice` —
    // this path is born inside the assembly, before the step's own pre-step can
    // label it, so it usually has nothing to adopt; the header paths are the
    // ones that need it (review W1).
    record.pendingFirst = null;
    return finalizeNotice(record, notice);
  }

  /**
   * Resolve a pending first notice that no `request/header` settled before the
   * next assembly ran.
   *
   * The Host appends the header inside the very step the assembly belongs to, so
   * a candidate still pending when the **next** assembly starts has proven not to
   * be a new conversation (or produced no header at all — the platform appends
   * one only when the configuration or the series changed). The question is
   * therefore answered "not a new conversation": the candidate is dropped, and an
   * attached write becomes a `prompt-change` notice — exactly the case review R1
   * found to be silently swallowed.
   * @param record - the session record.
   * @param input - the running assembly's `{at, configuredText, segmentText}`.
   * @returns the notice this resolution produced, or null.
   */
  function resolveStalePendingFirst(record, input) {
    const pending = record.pendingFirst;
    if (pending === null) return null;
    record.pendingFirst = null;
    record.firstDecided = true;
    if (pending.writeSeq === null) return null;
    const write = writes.find((entry) => entry.seq === pending.writeSeq) ?? null;
    if (write === null || write.seq <= record.consumedWriteSeq) return null;
    if (noticesAllowed() !== true) return null;
    record.consumedWriteSeq = write.seq;
    // The change is reported against the assembly running **now**: that is the
    // step whose delivery this notice waits for.
    return emitChangeNotice(record, {
      at: input.at,
      turn: null,
      step: null,
      configuredText: input.configuredText,
      segmentText: input.segmentText,
      write,
    });
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
      // A candidate that survived into the *next* assembly was never settled by a
      // header: resolve it before this assembly's own evidence replaces
      // `lastAssembly`.
      const stale = resolveStalePendingFirst(record, { at, configuredText, segmentText });
      record.lastAssembly = {
        at,
        digest: textDigest(segmentText),
        length: segmentText.length,
        configured: configuredText !== null,
      };

      const write = writeFor(sessionId);
      const hasPendingWrite = write !== null && write.seq > record.consumedWriteSeq;

      if (hasPendingWrite === true) {
        if (record.firstNoticeDone === true || record.firstDecided === true) {
          // An established conversation: a save is a change, reported on the very
          // next run. The switch is consulted only where a notice may be born.
          if (noticesAllowed() !== true) return stale;
          record.consumedWriteSeq = write.seq;
          const notice = emitChangeNotice(record, { at, turn: null, step: null, configuredText, segmentText, write });
          return notice ?? stale;
        }
        // The new-conversation question is still open. Arm (or refresh) the
        // candidate **without consuming the write**: only an `initial` header
        // makes this scenario A, and even then the write is consumed as the
        // already-done fact rather than reported twice.
        if (record.pendingFirst === null) {
          armFirstNotice(record, { at, configuredText, segmentText, write });
        } else {
          record.pendingFirst.writeSeq = write.seq;
          record.pendingFirst.at = at;
          record.pendingFirst.assembled = segmentText.length > 0;
          record.pendingFirst.digest = textDigest(segmentText);
          record.pendingFirst.length = segmentText.length;
          record.pendingFirst.readBack = readBackOf(segmentText, write);
        }
        return stale;
      }

      // No pending write: scenario A's precondition is simply "the user has a
      // prompt configured in this plugin" (a hand-edited layer file satisfies it
      // too). Asked once per session, and only while the question is open.
      if (record.firstNoticeDone === true || record.firstDecided === true || record.pendingFirst !== null) {
        return stale;
      }
      if (configuredText === null) return stale;
      if (noticesAllowed() !== true) return stale;
      armFirstNotice(record, { at, configuredText, segmentText, write: null });
      return stale;
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
   *
   * The **active** notice wins over a pending first candidate: the candidate's
   * own step is not the one a change notice is waiting for, and letting it keep
   * the label is what made the alignment silently disappear (review R2).
   * @param input - `{sessionId, turn, step}`.
   */
  function observePreStep(input) {
    try {
      const record = records.get(input?.sessionId);
      if (record === undefined) return;
      record.touchedAt = now();
      const turn = Number.isFinite(input?.turn) ? input.turn : null;
      const step = Number.isFinite(input?.step) ? input.step : null;
      const active = record.active;
      // A step starting means the **previous** step is over. A notice still
      // waiting for a projection from an earlier step can never receive one, so
      // this event — not a page read — settles it (review W4).
      if (
        active !== null &&
        active.delivery?.state === 'waiting' &&
        Number.isFinite(active.turn) &&
        Number.isFinite(active.step) &&
        (active.turn !== turn || active.step !== step)
      ) {
        active.delivery = { ...active.delivery, state: 'unconfirmed' };
        record.active = null;
      }
      const target =
        record.active !== null && record.active.delivery?.state === 'waiting' ? record.active : record.pendingFirst;
      if (target === null || target === undefined) return;
      if (!Number.isFinite(target.turn) && turn !== null) target.turn = turn;
      if (!Number.isFinite(target.step) && step !== null) target.step = step;
    } catch {
      // Fail open.
    }
  }

  /**
   * Settle one waiting notice as delivered by one observed `system/message`.
   * @param notice - the waiting notice.
   * @param input - `{at, seq, surfaceOp, text}` of that event.
   * @returns the notice.
   */
  function settleDelivered(notice, input) {
    const expected = notice.expectedText;
    const text = typeof input?.text === 'string' ? input.text : '';
    notice.delivery = {
      // The agreed verdict: this step committed a `system/message` on the
      // surface, so the prompt text is in this request's messages.
      state: 'delivered',
      at: input.at,
      seq: Number.isFinite(input.seq) ? input.seq : null,
      surfaceOp: input.surfaceOp ?? null,
      textMatched:
        typeof expected !== 'string' || expected.length === 0 || expected.length > TEXT_MATCH_LIMIT
          ? null
          : text.includes(expected),
    };
    return notice;
  }

  /**
   * Settle a notice from the cached `system/message` of **exactly its own**
   * turn/step, if there is one.
   *
   * The Host may commit this step's projection before the notice is born (the
   * first-assembly case, and the resume-header case of review W1), so every
   * notice birth point asks this question. The match is exact: a cached event of
   * another step is never adopted.
   * @param record - the session record.
   * @param notice - the freshly built notice.
   * @returns the notice (possibly settled).
   */
  function settleFromRecentSameStep(record, notice) {
    if (notice.delivery?.state !== 'waiting') return notice;
    const recent = record.recentSystem;
    if (recent === null) return notice;
    if (!Number.isFinite(notice.turn) || !Number.isFinite(notice.step)) return notice;
    if (recent.turn !== notice.turn || recent.step !== notice.step) return notice;
    return settleDelivered(notice, {
      at: recent.at,
      seq: recent.seq,
      surfaceOp: recent.surfaceOp,
      text: recent.text,
    });
  }

  /**
   * The single exit for every notice: settle it from the same-step cache, then
   * retain it. Every birth point goes through here, so no path can be born
   * "waiting" while its own step's projection is already on record (review W1).
   * @param record - the session record.
   * @param notice - the notice to retain.
   * @returns the notice.
   */
  function finalizeNotice(record, notice) {
    settleFromRecentSameStep(record, notice);
    pushNotice(record, notice);
    return notice;
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
      const at = Number.isFinite(input?.at) ? input.at : now();

      if (event.type === 'request/header') {
        const reason = event?.data?.reason;
        const pending = record.pendingFirst;
        record.pendingFirst = null;
        const alreadyDecided = record.firstDecided === true;
        // A header answers the new-conversation question for this session even
        // when no candidate was armed (the step assembled no configured prompt),
        // and it is answered exactly once. `firstNoticeDone` still means "a first
        // notice really was produced", so it is set where the notice is.
        record.firstDecided = true;
        if (pending === null || alreadyDecided === true) return null;
        if (reason !== 'initial') {
          // Not a new conversation (a resume, a fork, a later change): scenario A
          // does not apply. A write attached to the candidate is **not** lost —
          // it is reported as the change it is (review R1), against the assembly
          // evidence the candidate already recorded.
          if (pending.writeSeq === null) return null;
          const write = writes.find((entry) => entry.seq === pending.writeSeq) ?? null;
          if (write === null || write.seq <= record.consumedWriteSeq) return null;
          if (noticesAllowed() !== true) return null;
          record.consumedWriteSeq = write.seq;
          const notice = makeNotice(CHANGE_NOTICE, {
            at: pending.at,
            turn: pending.turn,
            step: pending.step,
            configured: pending.configured,
            assemblyState: pending.readBack === true ? 'read' : 'not-read',
            assembled: pending.assembled,
            digest: pending.digest,
            length: pending.length,
            expectedDigest: write.digest,
            expectedText: write.text,
          });
          notice.expected = { length: write.length, layer: write.layer ?? null, action: write.action ?? null };
          return finalizeNotice(record, notice);
        }
        // The log's first request header: scenario A really is a new
        // conversation, and the write — if any — was the user setting the prompt
        // this conversation starts with, so it is consumed as an already-done
        // fact instead of being reported twice.
        //
        // The switch is consulted **before** the write is consumed: while it is
        // off nothing is produced and nothing is spent, so turning it back on
        // still reports the pending change on a later run.
        if (noticesAllowed() !== true) return null;
        if (pending.writeSeq !== null) record.consumedWriteSeq = Math.max(record.consumedWriteSeq, pending.writeSeq);
        record.firstNoticeDone = true;
        // `finalizeNotice` applies the same-step cache here too (review R3 and W1
        // agree: the Host may commit the projection before this header).
        return finalizeNotice(record, makeNotice(FIRST_NOTICE, {
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
        }));
      }

      if (event.type === 'system/message') {
        const turn = event?.data?.turn;
        const step = event?.data?.step;
        // Cache first, settle second: this event may be the delivery of a notice
        // that does not exist yet (the first-assembly case), and it is the only
        // copy of that fact.
        record.recentSystem = {
          turn: Number.isFinite(turn) ? turn : null,
          step: Number.isFinite(step) ? step : null,
          seq: Number.isFinite(event?.seq) ? event.seq : null,
          surfaceOp: surfaceOperationOf(event),
          text: systemTextOf(event),
          at,
        };
        const active = record.active;
        if (active === null || active.delivery?.state !== 'waiting') return null;
        // Alignment is the only proof that this projection belongs to this
        // notice. A notice without a label therefore **refuses** to settle
        // (review R2): reporting "delivered" off an unrelated step is the one
        // mistake this feature must never make.
        if (!Number.isFinite(active.turn) || !Number.isFinite(active.step)) return null;
        if (turn !== active.turn || step !== active.step) return null;
        return settleDelivered(active, {
          at,
          seq: record.recentSystem.seq,
          surfaceOp: record.recentSystem.surfaceOp,
          text: record.recentSystem.text,
        });
      }

      if (event.type === 'step/end') {
        // An exact fact, and a better deadline than any clock: the step is over,
        // so no further `system/message` can belong to it (review P2.2).
        const active = record.active;
        if (active === null || active.delivery?.state !== 'waiting') return null;
        const turn = event?.data?.turn;
        const step = event?.data?.step;
        if (!Number.isFinite(active.turn) || !Number.isFinite(active.step)) return null;
        if (turn !== active.turn || step !== active.step) return null;
        active.delivery = { ...active.delivery, state: 'unconfirmed' };
        return active;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Drop one session's record (the Host announced it left the store).
   *
   * Its notices leave the global birth log with it: a conversation that no
   * longer exists must not be toasted at a user who can no longer open it.
   * @param sessionId - the session id.
   * @returns true when a record was dropped.
   */
  function disposeSession(sessionId) {
    try {
      const dropped = records.delete(sessionId);
      births = births.filter((birth) => birth.sessionId !== sessionId);
      return dropped;
    } catch {
      return false;
    }
  }

  /**
   * The incremental feed of notices born after one cursor — "what happened since
   * you last looked", for a client that is **not** on the settings page.
   *
   * A cursor is an opaque `seq` this module handed out, and it is **exclusive**:
   * the notice it names has already been shown, so it is never handed out again.
   * The comparison is only meaningful inside one mount — `bootId` **states** that
   * identity, this function does not enforce it (it takes no `bootId`): a client
   * whose cursor came from another mount is expected to notice the changed
   * `bootId` and re-anchor instead of comparing two numberings.
   *
   * A cursor whose successor has already been dropped from the bounded log — a
   * real gap, `oldest > known + 1`; a contiguous window is not stale — answers
   * `stale: true` with the **newest** notice only, so the client reports what it
   * can still prove instead of a burst of half-remembered ones.
   * @param rawCursor - the client's last seen `seq`, or anything else for
   *   "start from now" (a first connection never replays history).
   * @returns `{bootId, cursor, stale, notices}`; each notice is
   *   `{session, notice}` so a toast can name the conversation it belongs to.
   */
  function pendingNotices(rawCursor) {
    try {
      const latest = noticeSeq;
      const known =
        typeof rawCursor === 'number' && Number.isSafeInteger(rawCursor) && rawCursor >= 0
          ? Math.min(rawCursor, latest)
          : latest;
      if (known >= latest) return { bootId, cursor: latest, stale: false, notices: [] };
      const oldest = births.length > 0 ? births[0].seq : latest + 1;
      const stale = oldest > known + 1;
      const fresh = births.filter((birth) => birth.seq > known).sort((a, b) => a.seq - b.seq);
      const selected = stale && fresh.length > 1 ? [fresh[fresh.length - 1]] : fresh;
      return {
        bootId,
        cursor: latest,
        stale,
        notices: selected.map((birth) => ({ session: birth.sessionId, notice: publicNotice(birth.notice) })),
      };
    } catch {
      return { bootId, cursor: noticeSeq, stale: false, notices: [] };
    }
  }

  /**
   * The public, read-only view of one session.
   *
   * **Read-only is a contract, not a description** (review W4): this function
   * never rewrites a delivery state. A verdict is produced by events — the
   * step's own `step/end`, a later `agent/pre-step`, or the step's own
   * `system/message` — so polling the page cannot freeze a late projection out
   * of its own verdict.
   * @param sessionId - the session id.
   * @returns the view, or null when this mount has never seen the session.
   */
  function status(sessionId) {
    try {
      const record = records.get(sessionId);
      if (record === undefined) return null;
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
      seq: notice.seq,
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
        // How much of the incremental feed is still retained; a client whose
        // cursor is older than this is answered `stale`.
        history: births.length,
        bootId,
      };
    } catch {
      return { sessions: 0, notices: 0, droppedNotices, writes: 0, rejectedProbes, noticeSeq, history: 0, bootId };
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
    bootId,
    observeAssembly,
    markPromptWrite,
    observePreStep,
    observeSessionEvent,
    disposeSession,
    pendingNotices,
    status,
    stats,
    rejectProbe,
  };
}

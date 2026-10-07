/**
 * Bounded, append-only history kernel for `dsh-prompt-setting`.
 *
 * Pure like `core/overrides.js`: no `fs`, no `ctx`, no clock. The only import
 * is `node:crypto`, which is deterministic and stateless — the record builders
 * take `at` from the caller so a test can pin a timestamp exactly.
 *
 * Vocabulary
 * - *record*: one line of a layer's `history.jsonl`. It describes one write:
 *   who acted (`origin`), on which layer, on which section (`name`), and what
 *   the section's text was before and after.
 * - *snapshot*: the layer's override list **after** that write, stored as
 *   `{name, action, hash, bytes}` per entry. It carries no text, so a hundred
 *   records cost a hundred names-and-hashes rather than a hundred prompt
 *   bodies — and it is still enough to diff two versions section by section.
 * - *seq*: a per-file monotonic counter. It is the record's stable id (the
 *   file is trimmed, so an array index would move; a timestamp can collide).
 *
 * Invariants this module enforces (all pinned by `test/history.test.mjs`):
 * 1. a record is always structurally valid or it is rejected;
 * 2. a history file never holds more than `limit` records once it has been
 *    appended through {@link makeRecord} + {@link trimRecords};
 * 3. reading is tolerant (a corrupt line is counted and skipped, never fatal)
 *    while writing is strict.
 *
 * @module dsh-prompt-setting/core/history
 */

import { createHash } from 'node:crypto';

import { ACTIONS, fail } from './overrides.js';

/**
 * The actions a history record can describe, in contract order.
 *
 * `rollback` (Revision 21; narrowed in Revision 22) is the action a
 * `POST /prompt-setting/rollback` appends. It is a first-class action rather
 * than a `replace` so a reader can tell "the user wrote this text" from "the
 * layer was moved back to a version that held this text", and so the next
 * rollback can treat the record like any other version. Its subject is the
 * reserved section — the only section any write route accepts — so it is a
 * normal section record, not a layer-wide one.
 */
export const HISTORY_ACTIONS = Object.freeze(['replace', 'hide', 'append', 'remove', 'reset-layer', 'legacy-clear', 'rollback']);
/** Who triggered the write. `ui` is the settings page, `import` is `/import`. */
export const HISTORY_ORIGINS = Object.freeze(['ui', 'import']);
/** Default retention: the newest N records of each layer file. */
export const DEFAULT_HISTORY_LIMIT = 100;
/** Lower bound accepted from configuration (a smaller N makes history useless). */
export const MIN_HISTORY_LIMIT = 10;
/** Upper bound accepted from configuration: memory and file size are bounded. */
export const MAX_HISTORY_LIMIT = 10000;
/** `GET /prompt-setting/history` default page size. */
export const DEFAULT_HISTORY_PAGE = 50;
/** `GET /prompt-setting/history` maximum page size. */
export const MAX_HISTORY_PAGE = 500;
/** The record action that clears a whole layer. */
export const RESET_ACTION = 'reset-layer';
/**
 * The record action that removes only the layer's frozen (non-reserved)
 * overrides: `DELETE /prompt-setting/overrides&legacy=true` (Revision 7).
 * Distinct from {@link RESET_ACTION} on purpose — a reader must be able to tell
 * "the whole layer was cleared" from "the legacy half was cleared", because the
 * two leave the layer in different states.
 */
export const LEGACY_CLEAR_ACTION = 'legacy-clear';
/**
 * The record action a rollback appends (Revision 21; narrowed in Revision 22).
 *
 * A rollback touches exactly **one** section — the reserved one — so its record
 * is an ordinary section record: `name` is that section's name, and `before` /
 * `after` are its text on either side of the write. It is deliberately *not*
 * layer-wide: the write face has been "the reserved section only" since
 * Revision 7 (§4.1, §15.7), and a rollback that could revive a non-reserved
 * override would be a fourth write path around that policy.
 */
export const ROLLBACK_ACTION = 'rollback';
/**
 * The actions whose subject is the whole layer rather than one section. A
 * record carrying one of these has `name: null`; every other action requires a
 * name.
 */
export const LAYER_WIDE_ACTIONS = Object.freeze([RESET_ACTION, LEGACY_CLEAR_ACTION]);

/** @returns a SHA-256 fingerprint of the text. */
function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Fingerprint one text value.
 *
 * The hash and byte length travel with the text so a reader can tell two
 * same-sized versions apart without re-reading both bodies, and so a record
 * whose text was dropped (a `hide`) is distinguishable from an empty string.
 * @param text - the text, or null/undefined for "no value".
 * @returns `{text, hash, bytes}` or `null`.
 */
export function textEntry(text) {
  if (text === null || text === undefined) return null;
  const value = String(text);
  return { text: value, hash: hashText(value), bytes: Buffer.byteLength(value, 'utf8') };
}

/**
 * Fingerprint one text value without carrying the text.
 * @param text - the text, or null/undefined.
 * @returns `{hash, bytes}` or `null`.
 */
export function digestEntry(text) {
  const entry = textEntry(text);
  return entry === null ? null : { hash: entry.hash, bytes: entry.bytes };
}

/**
 * `{name, action, hash, bytes}` for every override of one layer config.
 *
 * `hide` has no text, so its digest is `null`; the `action` and `name` still
 * make the entry comparable, which is what the section-level diff needs.
 * @param config - a validated layer config (or null).
 * @returns the snapshot array.
 */
export function snapshotOfConfig(config) {
  const overrides = Array.isArray(config?.overrides) ? config.overrides : [];
  return overrides.map((override) => {
    const digest = override.action === 'hide' ? null : digestEntry(override.text);
    return {
      name: override.name,
      action: override.action,
      hash: digest === null ? null : digest.hash,
      bytes: digest === null ? null : digest.bytes,
    };
  });
}

/**
 * Validate one history record as parsed from a file.
 * @param raw - the parsed JSON value of one line.
 * @returns the normalized record.
 * @throws {OverrideError} with a stable `code`.
 */
export function validateHistoryRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('invalid-history-record', 'a history record must be a JSON object');
  }
  if (!Number.isInteger(raw.seq) || raw.seq < 1) {
    throw fail('invalid-history-record', '"seq" must be a positive integer');
  }
  if (typeof raw.at !== 'string' || raw.at.length === 0) {
    throw fail('invalid-history-record', '"at" must be a non-empty ISO timestamp string');
  }
  if (typeof raw.layer !== 'string' || raw.layer.length === 0) {
    throw fail('invalid-history-record', '"layer" must be a non-empty string');
  }
  if (typeof raw.action !== 'string' || !HISTORY_ACTIONS.includes(raw.action)) {
    throw fail('invalid-history-record', `"action" must be one of ${HISTORY_ACTIONS.join(', ')}`);
  }
  if (typeof raw.origin !== 'string' || !HISTORY_ORIGINS.includes(raw.origin)) {
    throw fail('invalid-history-record', `"origin" must be one of ${HISTORY_ORIGINS.join(', ')}`);
  }
  const name = raw.name === undefined ? null : raw.name;
  if (name !== null && (typeof name !== 'string' || name.length === 0)) {
    throw fail('invalid-history-record', '"name" must be a non-empty string or null');
  }
  if (!LAYER_WIDE_ACTIONS.includes(raw.action) && name === null) {
    throw fail('invalid-history-record', `a "${raw.action}" record requires a "name"`);
  }
  if (LAYER_WIDE_ACTIONS.includes(raw.action) && name !== null) {
    // A layer-wide write has no single target: its subject is the whole layer.
    throw fail('invalid-history-record', `a "${raw.action}" record must carry a null "name"`);
  }
  const session = raw.session === undefined ? null : raw.session;
  if (session !== null && typeof session !== 'string') {
    throw fail('invalid-history-record', '"session" must be a string or null');
  }
  const entries = raw.entries === undefined ? null : raw.entries;
  if (entries !== null && !Array.isArray(entries)) {
    throw fail('invalid-history-record', '"entries" must be an array or null');
  }
  const snapshot = raw.snapshot === undefined ? [] : raw.snapshot;
  if (!Array.isArray(snapshot)) {
    throw fail('invalid-history-record', '"snapshot" must be an array');
  }
  const note = raw.note === undefined ? null : raw.note;
  if (note !== null && typeof note !== 'string') {
    throw fail('invalid-history-record', '"note" must be a string or null');
  }
  return {
    seq: raw.seq,
    at: raw.at,
    layer: raw.layer,
    session,
    action: raw.action,
    name,
    origin: raw.origin,
    before: raw.before ?? null,
    after: raw.after ?? null,
    entries,
    snapshot,
    note,
  };
}

/**
 * Build one history record.
 *
 * `seq` is assigned by the caller (the store knows the file's high-water mark);
 * everything else is derived here so a record can never be assembled with a
 * missing timestamp or an action outside the contract.
 * @param fields - `{seq, at, layer, session?, action, name?, origin, before?,
 *   after?, entries?, snapshot?, note?}`.
 * @returns the normalized record.
 * @throws {OverrideError} when the result would not round-trip.
 */
export function makeRecord(fields) {
  const record = {
    seq: fields?.seq,
    at: fields?.at,
    layer: fields?.layer,
    session: fields?.session ?? null,
    action: fields?.action,
    name: fields?.name ?? null,
    origin: fields?.origin,
    before: fields?.before ?? null,
    after: fields?.after ?? null,
    entries: fields?.entries ?? null,
    snapshot: fields?.snapshot ?? [],
    note: fields?.note ?? null,
  };
  return validateHistoryRecord(record);
}

/** One record as a single JSONL line (no embedded newline: JSON escapes them). */
export function serializeRecord(record) {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Parse a history file.
 *
 * Tolerant by design: history is a diagnostic log, so a hand-edited or
 * truncated line is counted in `corrupt` and skipped rather than disabling the
 * feature. A `seq` that repeats (two writers, a restored backup) keeps the
 * first occurrence, so ids stay unique.
 * @param text - the file contents ('' for a missing file).
 * @returns `{records, corrupt, maxSeq}` with records in file order.
 */
export function parseHistory(text) {
  const source = typeof text === 'string' ? text : '';
  const records = [];
  const seen = new Set();
  let corrupt = 0;
  let maxSeq = 0;
  for (const line of source.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      corrupt += 1;
      continue;
    }
    let record;
    try {
      record = validateHistoryRecord(parsed);
    } catch {
      corrupt += 1;
      continue;
    }
    if (seen.has(record.seq)) {
      corrupt += 1;
      continue;
    }
    seen.add(record.seq);
    maxSeq = Math.max(maxSeq, record.seq);
    records.push(record);
  }
  return { records, corrupt, maxSeq };
}

/**
 * Keep only the newest `limit` records, in file order.
 * @param records - the records, oldest first.
 * @param limit - the retention bound.
 * @returns `{kept, dropped, trimmed}`.
 */
export function trimRecords(records, limit) {
  const list = Array.isArray(records) ? records : [];
  const bound = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_HISTORY_LIMIT;
  if (list.length <= bound) return { kept: list.slice(), dropped: [], trimmed: false };
  return { kept: list.slice(list.length - bound), dropped: list.slice(0, list.length - bound), trimmed: true };
}

/** Serialize a whole record list back to JSONL text. */
export function serializeHistory(records) {
  return (Array.isArray(records) ? records : []).map(serializeRecord).join('');
}

/**
 * Resolve the retention bound from plugin config, then the environment.
 *
 * Config is the intended channel (`apply(ctx, {historyLimit})`); the env var is
 * there so the bound can be changed without editing a profile. An unusable
 * value is ignored rather than fatal — a typo must not disable history.
 * @param config - the loose plugin config object (or undefined).
 * @param env - the environment to read.
 * @returns an integer in `[MIN_HISTORY_LIMIT, MAX_HISTORY_LIMIT]`.
 */
export function resolveHistoryLimit(config, env = process.env) {
  const candidates = [config?.historyLimit, env?.DSH_PROMPT_SETTING_HISTORY_LIMIT];
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? Number(candidate.trim()) : candidate;
    if (Number.isInteger(value) && value >= MIN_HISTORY_LIMIT) {
      return Math.min(value, MAX_HISTORY_LIMIT);
    }
  }
  return DEFAULT_HISTORY_LIMIT;
}

/**
 * Resolve one history query's page size.
 *
 * `limit` is clamped rather than rejected: a page size is a presentation
 * choice, and a bad one must not turn a read into an error. `0` is a legal
 * request for the counts alone.
 * @param raw - the `?limit=` value, or null.
 * @returns an integer in `[0, MAX_HISTORY_PAGE]`.
 */
export function resolvePageLimit(raw) {
  if (raw === null || raw === undefined || String(raw).trim().length === 0) return DEFAULT_HISTORY_PAGE;
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value) || value < 0) return DEFAULT_HISTORY_PAGE;
  return Math.min(Math.floor(value), MAX_HISTORY_PAGE);
}

/**
 * Resolve one history query's offset.
 *
 * Like {@link resolvePageLimit}, `offset` is clamped rather than rejected: an
 * unusable page number must not turn a read into an error. The bound is applied
 * later, by {@link queryHistory}, against the match count — a request past the
 * end lands on the last page instead of on an empty one.
 * @param raw - the `?offset=` value, or null.
 * @returns a non-negative integer.
 */
export function resolvePageOffset(raw) {
  if (raw === null || raw === undefined || String(raw).trim().length === 0) return 0;
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * Filter and page a record list, newest first.
 *
 * Paging is `(offset, limit)` over the **filtered, ordered** list, so `total`
 * stays the match count and a page is a window into it. An out-of-range
 * `offset` is clamped to the start of the last page (never an error): a stale
 * page number must still render the newest records rather than an empty list.
 * @param records - the records, in file order.
 * @param query - `{layer?, session?, name?, limit?, offset?, before?}`;
 *   `before` is an exclusive ISO upper bound on `at`.
 * @returns `{records, total, offset, pageCount, hasMore}` where `total` is the
 *   match count before paging, `offset` is the offset actually used, and
 *   `hasMore` says whether a page after this one exists.
 */
export function queryHistory(records, query = {}) {
  const list = Array.isArray(records) ? records : [];
  const layer = query.layer ?? null;
  const session = query.session ?? null;
  const name = query.name ?? null;
  const before = query.before ?? null;
  const limit = Number.isInteger(query.limit) ? query.limit : DEFAULT_HISTORY_PAGE;
  const matched = list.filter((record) => {
    if (layer !== null && record.layer !== layer) return false;
    if (name !== null && record.name !== name) return false;
    if (session !== null && record.session !== session) return false;
    if (before !== null && !(record.at < before)) return false;
    return true;
  });
  const ordered = matched.slice().sort((left, right) => right.seq - left.seq);
  const total = ordered.length;
  // `limit: 0` is the documented "counts alone" request: no page exists, so
  // there is no page count and nothing after this page.
  const pageCount = limit > 0 ? Math.ceil(total / limit) : 0;
  const lastOffset = pageCount > 0 ? (pageCount - 1) * limit : 0;
  const requested = Number.isInteger(query.offset) && query.offset > 0 ? query.offset : 0;
  const offset = Math.min(requested, lastOffset);
  return {
    records: limit > 0 ? ordered.slice(offset, offset + limit) : [],
    total,
    offset,
    pageCount,
    hasMore: limit > 0 && offset + limit < total,
  };
}

/**
 * The public shape of one record. `id` is the stable handle a client passes
 * back as `?from=` / `?to=`; `seq` stays visible for ordering.
 * @param record - a validated record.
 * @returns the response entry.
 */
export function publicRecord(record) {
  return { ...record, id: String(record.seq) };
}

/**
 * Decide which record action one write represents.
 * @param before - the override being replaced, or null.
 * @param after - the override being written, or null.
 * @returns one of `replace` | `hide` | `append` | `remove`.
 */
export function actionOf(before, after) {
  if (after === null || after === undefined) return 'remove';
  if (after.action === 'hide') return 'hide';
  if (after.action === 'append') return 'append';
  return 'replace';
}

/**
 * Whether two values describe the same override (name, action, text, order).
 * @param left - one override, or null.
 * @param right - the other, or null.
 * @returns whether the two are interchangeable.
 */
export function sameOverride(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left ?? null) === (right ?? null);
  }
  return left.name === right.name
    && left.action === right.action
    && (left.text ?? null) === (right.text ?? null)
    && (left.order ?? null) === (right.order ?? null);
}

/**
 * The `entries` payload of a layer-wide record (`reset-layer`, and since
 * Revision 7 `legacy-clear`): every removed override with its full text, so the
 * removal is reconstructible from history alone.
 * @param overrides - the removed overrides.
 * @returns `[{name, action, text, order?}]`.
 */
export function resetEntries(overrides) {
  return (Array.isArray(overrides) ? overrides : []).map((override) => ({
    name: override.name,
    action: override.action,
    ...(typeof override.text === 'string' ? { text: override.text } : {}),
    ...(override.order === undefined ? {} : { order: override.order }),
  }));
}

/**
 * Rebuild the layer one history version held — **restricted to one section**
 * (Revision 21; narrowed to the reserved section in Revision 22).
 *
 * Two facts about this problem shape the whole function:
 *
 * 1. a {@link snapshotOfConfig} carries `{name, action, hash, bytes}` and **no
 *    text**, so a version's *structure* is recorded but never what its sections
 *    said;
 * 2. since Revision 7 the write face is the reserved section alone (§4.1,
 *    §15.7): `PUT /overrides`, the single-name `DELETE` and `POST /import` all
 *    refuse a non-reserved name. A rollback must not be a fourth write path
 *    around that policy, so it may not revive, drop or edit any other section —
 *    including one a hand-edited or pre-Revision-7 file still carries.
 *
 * What is returned is therefore the **current** override list with exactly one
 * entry adjusted: the section named `sectionName` is set to the text that
 * version held, or removed when that version did not hold it. Every other entry
 * is passed through untouched and in place — that is the invariant the tests
 * pin, and the reason a rollback cannot surprise a user with a section the page
 * gives them no way to remove.
 *
 * The section's own text comes from the record chain. Text is not in a
 * snapshot, but it is in every record (`before` / `after`), and the records form
 * a chain: walking them **backwards** from the newest one undoes each write, so
 * replaying only the records that touch `sectionName` (plus whole-layer clears,
 * which remove it) lands that one section exactly where the target version left
 * it. A version that claims the section held text the chain cannot supply is a
 * **refusal**, never a guess.
 *
 * A record whose `snapshot` is absent or empty is refused: an old record never
 * had one, and a whole-layer clear legitimately snapshots `[]` — neither says
 * what structure the version had, and "back to an empty layer" is what
 * `DELETE …?reset=true` (§12.1) already does.
 *
 * @param records - every record of one layer, in file order (oldest first).
 * @param current - the layer's current validated config.
 * @param seq - the `seq` of the version to restore.
 * @param sectionName - the one section a rollback may adjust: the reserved name.
 * @returns `{overrides, structure, target}` — the adjusted override list, the
 *   target version's ordered `{name, action}` list (which is how a caller can
 *   say "that version held N other sections, and they are not restored"), and
 *   the target entry for `sectionName` (`null` when that version did not hold
 *   it).
 * @throws {OverrideError} with a stable `code`; nothing is written.
 */
export function rollbackOverrides(records, current, seq, sectionName) {
  const list = Array.isArray(records) ? records : [];
  const target = list.find((record) => record !== null && typeof record === 'object' && record.seq === seq);
  if (target === undefined) {
    throw fail('history-not-found', `no history record #${seq} in this layer`, 404);
  }
  if (typeof sectionName !== 'string' || sectionName.length === 0) {
    throw fail('invalid-section-name', 'the section a rollback may adjust must be a non-empty name');
  }
  const structure = readStructure(target);
  const wanted = structure.find((entry) => entry.name === sectionName) ?? null;
  const restored = wanted === null ? null : restoredSection(list, current, seq, sectionName, wanted);
  const overrides = [];
  let placed = false;
  for (const override of Array.isArray(current?.overrides) ? current.overrides : []) {
    if (override.name !== sectionName) {
      // Not this section's business: carried through by reference, in place.
      overrides.push(override);
      continue;
    }
    if (restored !== null) {
      overrides.push(restored);
      placed = true;
    }
  }
  if (restored !== null && !placed) overrides.push(restored);
  return { overrides, structure, target: wanted };
}

/**
 * The one entry a rollback writes: the section as the target version held it.
 * @param list - every record of the layer, in file order.
 * @param current - the layer's current validated config.
 * @param seq - the target version's `seq`.
 * @param sectionName - the one section a rollback may adjust.
 * @param wanted - that section's `{name, action}` in the target's snapshot.
 * @returns the override to write.
 * @throws {OverrideError} when its text cannot be recovered from the chain.
 */
function restoredSection(list, current, seq, sectionName, wanted) {
  if (wanted.action === 'hide') {
    // A hidden section carries no text by definition, so the replay is never
    // consulted for it: the structure alone is the whole answer.
    return { name: sectionName, action: 'hide' };
  }
  const state = currentSection(current, sectionName);
  const later = list
    .filter((record) => record !== null && typeof record === 'object' && record.seq > seq)
    .sort((left, right) => right.seq - left.seq);
  for (const record of later) undoSection(record, state, sectionName);
  if (state.entry === null || typeof state.entry.text !== 'string') {
    throw fail(
      'history-rollback-unavailable',
      `the text of ${sectionName} is not recoverable from history; roll back to a newer record or restore the file by hand`,
      409,
    );
  }
  return {
    name: sectionName,
    action: wanted.action,
    text: state.entry.text,
    ...(wanted.action === 'append' && Number.isInteger(state.entry.order) ? { order: state.entry.order } : {}),
  };
}

/**
 * One section's state in a config, as a mutable box.
 * @param current - the layer's current validated config.
 * @param sectionName - the section to track.
 * @returns `{entry}` — the override, or `null` when the config does not hold it.
 */
function currentSection(current, sectionName) {
  const found = (Array.isArray(current?.overrides) ? current.overrides : [])
    .find((override) => override.name === sectionName);
  return { entry: found === undefined ? null : found };
}

/**
 * Undo one record, tracking **only** the one section a rollback may adjust.
 *
 * Every other record is a no-op here: a write to some other section cannot have
 * moved this one, and pretending otherwise is exactly how a replay would start
 * rebuilding overrides the write face does not allow.
 * @param record - the record to undo.
 * @param state - `{entry}`, mutated in place.
 * @param sectionName - the one section a rollback may adjust.
 * @throws {OverrideError} when the record cannot be undone at all.
 */
function undoSection(record, state, sectionName) {
  if (record.action === LEGACY_CLEAR_ACTION) {
    // It removes the frozen (non-reserved) overrides and keeps the reserved one,
    // so undoing it moves nothing this function tracks.
    return;
  }
  if (record.action === RESET_ACTION) {
    const entries = Array.isArray(record.entries) ? record.entries : null;
    if (entries === null) {
      throw fail('history-replay-unavailable', `history record #${record.seq} cannot be undone: it lists no removed entries`, 409);
    }
    const hit = entries.find((entry) => entry !== null && typeof entry === 'object' && entry.name === sectionName);
    state.entry = hit === undefined ? null : entryOverride(hit);
    return;
  }
  if (record.name !== sectionName) return;
  const before = record.before;
  if (before === null || before === undefined) {
    state.entry = null;
    return;
  }
  if (typeof before.text !== 'string') {
    throw fail('history-replay-unavailable', `history record #${record.seq} carries no text for ${sectionName}`, 409);
  }
  state.entry = { name: sectionName, text: before.text };
}

/**
 * Validate and copy one record's `snapshot` as an ordered `{name, action}` list.
 *
 * An empty or absent snapshot is a refusal rather than an empty structure: the
 * only records that legitimately carry `[]` are whole-layer clears, and
 * "roll back to an empty layer" is what `DELETE …?reset=true` already does —
 * with a record that says so. The list is also how a rollback knows whether the
 * reserved section existed at that version at all.
 * @param record - the target record.
 * @returns the structure.
 * @throws {OverrideError} with a stable `code`.
 */
function readStructure(record) {
  const snapshot = record.snapshot;
  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    throw fail(
      'history-snapshot-missing',
      `history record #${record.seq} carries no whole-layer snapshot, so it cannot be restored safely`,
      409,
    );
  }
  const structure = [];
  const seen = new Set();
  for (const entry of snapshot) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw fail('invalid-history-snapshot', `history record #${record.seq} has a malformed snapshot entry`, 409);
    }
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      throw fail('invalid-history-snapshot', `history record #${record.seq} has a snapshot entry without a name`, 409);
    }
    if (typeof entry.action !== 'string' || !ACTIONS.includes(entry.action)) {
      throw fail(
        'invalid-history-snapshot',
        `history record #${record.seq} has a snapshot entry with a bad action (${JSON.stringify(entry.action)})`,
        409,
      );
    }
    if (seen.has(entry.name)) {
      throw fail('invalid-history-snapshot', `history record #${record.seq} names ${entry.name} twice in its snapshot`, 409);
    }
    seen.add(entry.name);
    structure.push({ name: entry.name, action: entry.action });
  }
  return structure;
}

/**
 * One `entries` element as an override, or `null` when it is unusable.
 *
 * A `hide` entry has no text and is kept as such: the section really was hidden
 * at that version, and reading the omission as "delete the entry" would lose a
 * version the user can see in the log.
 * @param entry - one `entries` element.
 * @returns the override, or `null` when the element is malformed.
 */
function entryOverride(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.name !== 'string' || entry.name.length === 0) return null;
  if (entry.action === 'hide') return { name: entry.name, action: 'hide' };
  if (typeof entry.action !== 'string' || !ACTIONS.includes(entry.action)) return null;
  if (typeof entry.text !== 'string') return null;
  return {
    name: entry.name,
    action: entry.action,
    text: entry.text,
    ...(entry.action === 'append' && Number.isInteger(entry.order) ? { order: entry.order } : {}),
  };
}

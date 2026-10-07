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

import { fail } from './overrides.js';

/** The actions a history record can describe, in contract order. */
export const HISTORY_ACTIONS = Object.freeze(['replace', 'hide', 'append', 'remove', 'reset-layer', 'legacy-clear']);
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

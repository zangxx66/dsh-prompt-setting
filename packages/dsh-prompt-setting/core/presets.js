/**
 * The preset library (g-060, `CONTRACT.md` Revision 37).
 *
 * Pure like `core/overrides.js` and `core/custom.js`: constants plus functions
 * over plain data — no `fs`, no `ctx`, no clock, no import of the Host. Every
 * decision this revision adds (what a preset may carry, what a stored document
 * normalizes to, what「应用」 writes and what「取消应用」 restores) is therefore
 * pinned offline by `node --test`, and `index.js` stays an adapter.
 *
 * Vocabulary
 * - *preset*: one named `{action, text}` pair for the reserved section
 *   ({@link CUSTOM_SECTION_NAME}). It is a **library** entry: it lives in its
 *   own file and is never read by the assembly path.
 * - *applied*: a record that one workspace's layer currently holds the text of
 *   one preset, together with the `before` snapshot that「取消应用」restores.
 *   At most one record per workspace root — the layer has one reserved entry,
 *   so a second application replaces the record rather than stacking on it.
 * - *orphan*: an `applied` record whose preset has been deleted. The workspace
 *   layer keeps its text (deleting a preset never rewrites a layer); the record
 *   is only reported as pointing at a preset that no longer exists.
 *
 * Why the library is not folded into `overrides.json`: the layer config, the
 * history and the snapshot schemas are frozen contracts, and a preset is
 * neither an override of one layer nor a layer-scoped fact — it is the user's
 * own catalogue of texts, which is why it lives in a third file
 * (`<DSH_HOME>/prompt-setting/presets.json`) with its own shape.
 *
 * Revision 53 (g-074) made that catalogue **part of a full backup**: the export
 * document carries it as a top-level `presets` field, and an import validates it
 * with {@link validatePresetsDocument} and replaces the file from it. It is
 * still never folded into a layer — the document carries the library as a
 * document, never as loose override entries, so `overrides.json` and the
 * `/overrides` view keep exactly the shape they had.
 *
 * @module dsh-prompt-setting/core/presets
 */

import { CUSTOM_SECTION_NAME } from './custom.js';
import { MAX_TEXT_BYTES, RESERVED_STACK_SEPARATOR, emptyConfig, fail, withInterpolate } from './overrides.js';
import { validateWorkspaceRoot } from './workspace-root.js';

/**
 * The presets document version. A stored document may omit it (the first
 * revision's files did not have to carry one); a document that states a
 * **different** version is refused rather than guessed at.
 */
export const PRESETS_VERSION = 1;

/** The longest preset name this library stores (characters, like `MAX_NAME_LENGTH`). */
export const MAX_PRESET_NAME_LENGTH = 120;

/**
 * The actions a preset may carry, in contract order.
 *
 * Deliberately the write face's own two words (`core/custom.js`'s
 * `RESERVED_WRITABLE_ACTIONS`): a preset is a value one may apply to the
 * reserved section, so it may only carry what that section accepts. `hide` is
 * not a preset — a section the user is filling in is not one they mean to
 * remove (Revision 36).
 */
export const PRESET_ACTIONS = Object.freeze(['replace', 'append']);

/**
 * The preset id shape: an opaque, URL-safe token.
 *
 * Ids are minted by the Host (`index.js`, one `randomUUID()` per new preset) and
 * never by the client: the client sends an id only to address an existing
 * preset. Validating the shape here keeps a hand-edited file or a crafted body
 * from putting a path-looking or control-character string into the library (the
 * id is echoed in JSON, never used to build a path — but a bounded alphabet is
 * cheap and makes the "unknown id" and "malformed id" answers distinguishable).
 */
export const PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Control characters, refused in a preset name exactly as in a section name. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const encoder = new TextEncoder();

/** A fresh, empty library. */
export function emptyPresets() {
  return { version: PRESETS_VERSION, presets: [], applied: [] };
}

/**
 * Normalize one stored preset, tolerating a hand-edited file.
 *
 * A stored entry is *data*, not a request: an entry this revision cannot use is
 * dropped (`null`) rather than failing the whole read, because one bad line must
 * not make every other preset unreachable. The write face never produces such
 * an entry — {@link validatePresetInput} refuses the same inputs with a code.
 * @param raw - one element of a stored `presets` array.
 * @returns the normalized preset, or `null` when the entry is unusable.
 */
function normalizeStoredPreset(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = raw.id;
  if (typeof id !== 'string' || !PRESET_ID_PATTERN.test(id)) return null;
  const name = raw.name;
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > MAX_PRESET_NAME_LENGTH) return null;
  if (CONTROL_CHARACTERS.test(name)) return null;
  if (!PRESET_ACTIONS.includes(raw.action)) return null;
  if (typeof raw.text !== 'string' || encoder.encode(raw.text).length > MAX_TEXT_BYTES) return null;
  return {
    id,
    name,
    action: raw.action,
    text: raw.text,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

/**
 * Normalize one stored `applied` record (Revision 41: one base plus a stack).
 *
 * A record describes **one workspace**: `base` is the reserved entry that was
 * there before the first application (`null` = there was none), and `stack` is
 * every preset applied since, in application order. Each stack entry carries the
 * `{action, text}` it wrote at the time, so the layer's text can be recomposed —
 * and one entry cancelled — even after that preset has been deleted from the
 * library (an orphan).
 *
 * The **Revision 37 shape** (`{workspaceRoot, presetId, before, appliedAt}`) is
 * migrated in place rather than dropped: its `before` becomes `base`, its single
 * preset becomes a one-entry stack, and the text snapshot it never carried is
 * taken from the library entry of the same id when the document still has one.
 *
 * **`workspaceRoot` is deliberately checked leniently here, and that asymmetry
 * is a decision, not an oversight (g-074 R2).** This is the *read* face: a
 * record a hand edit, an older build or another machine wrote must keep the
 * library readable, so the only question asked is "is this a usable string?".
 * The *import* face ({@link validateAppliedEntry}) and every *writer* are
 * strict. The invariant that makes the lenient read safe:
 *
 * > **the read face is lenient; every consumer of a stored `workspaceRoot` must
 * > pass it through the registry whitelist before it can become a path.**
 *
 * It holds today because the value has exactly three consumers, and all three
 * are covered: `appliedRootsOf` feeds the delete-preset route, which calls
 * `assertKnownWorkspaceRoot` on every root it is about to write; the same
 * function feeds `planPresetRemoval`, whose `currentOf` callback is only reached
 * from that route; and `publicApplied` only *reports* the string (no path is
 * built from it). `GET /export` additionally drops a record whose root this
 * profile does not register (`exportScope.omittedApplied`). Tightening this
 * function instead would be a regression of a different kind: a library holding
 * one bad historical record would stop reading at all.
 * @param raw - one element of a stored `applied` array.
 * @param presetsById - the document's own presets, for that migration lookup.
 * @returns the normalized record, or `null` when the entry is unusable.
 */
function normalizeStoredApplied(raw, presetsById = new Map()) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const workspaceRoot = raw.workspaceRoot;
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) return null;

  const stacked = Array.isArray(raw.stack);
  const rawBase = stacked ? raw.base : raw.before;
  let base = null;
  if (rawBase !== undefined && rawBase !== null) {
    if (typeof rawBase !== 'object' || Array.isArray(rawBase)) return null;
    if (!PRESET_ACTIONS.includes(rawBase.action)) return null;
    if (typeof rawBase.text !== 'string' || encoder.encode(rawBase.text).length > MAX_TEXT_BYTES) return null;
    base = { action: rawBase.action, text: rawBase.text };
  }

  if (stacked) {
    const stack = [];
    for (const item of raw.stack) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const presetId = item.presetId;
      if (typeof presetId !== 'string' || !PRESET_ID_PATTERN.test(presetId)) continue;
      const known = presetsById.get(presetId) ?? null;
      const action = PRESET_ACTIONS.includes(item.action)
        ? item.action
        : known !== null
          ? known.action
          : 'append';
      const text = typeof item.text === 'string' ? item.text : known === null ? '' : known.text;
      if (encoder.encode(text).length > MAX_TEXT_BYTES) continue;
      stack.push({
        presetId,
        appliedAt: typeof item.appliedAt === 'string' ? item.appliedAt : null,
        action,
        text,
      });
    }
    return { workspaceRoot, base, stack };
  }

  // Revision 37's one-record shape.
  const presetId = raw.presetId;
  if (typeof presetId !== 'string' || !PRESET_ID_PATTERN.test(presetId)) return null;
  const known = presetsById.get(presetId) ?? null;
  return {
    workspaceRoot,
    base,
    stack: [{
      presetId,
      appliedAt: typeof raw.appliedAt === 'string' ? raw.appliedAt : null,
      action: known !== null ? known.action : base === null ? 'replace' : base.action,
      text: known !== null ? known.text : '',
    }],
  };
}

/**
 * Normalize a whole stored document.
 *
 * Unlike a layer's config (which *disables the layer* when it is unusable), a
 * library file that is not an object at all, or that states another version, is
 * refused with a code: the write face must not overwrite a file it does not
 * understand, and the read face reports the same reason. Entries *inside* a
 * usable document are dropped individually (see above).
 * @param raw - the parsed JSON value.
 * @returns the normalized `{version, presets, applied}`.
 * @throws {OverrideError} `invalid-presets` / `unsupported-presets-version`.
 */
export function normalizePresets(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('invalid-presets', 'the presets file must contain a JSON object');
  }
  if (raw.version !== undefined && raw.version !== PRESETS_VERSION) {
    throw fail('unsupported-presets-version', `unsupported presets version ${JSON.stringify(raw.version)}`);
  }
  if (raw.presets !== undefined && !Array.isArray(raw.presets)) {
    throw fail('invalid-presets', '"presets" must be an array');
  }
  if (raw.applied !== undefined && !Array.isArray(raw.applied)) {
    throw fail('invalid-presets', '"applied" must be an array');
  }
  const presets = [];
  const seen = new Set();
  for (const entry of raw.presets ?? []) {
    const preset = normalizeStoredPreset(entry);
    if (preset === null || seen.has(preset.id)) continue;
    seen.add(preset.id);
    presets.push(preset);
  }
  const presetsById = new Map(presets.map((preset) => [preset.id, preset]));
  const applied = [];
  for (const entry of raw.applied ?? []) {
    const record = normalizeStoredApplied(entry, presetsById);
    if (record === null) continue;
    const at = applied.findIndex((item) => item.workspaceRoot === record.workspaceRoot);
    if (at === -1) applied.push(record);
    else applied[at] = record;
  }
  return { version: PRESETS_VERSION, presets, applied };
}

/**
 * The keys a stored preset document may carry (Revision 53).
 *
 * An entry's shape is a contract, not a suggestion: `normalizePresets` is the
 * *read* face and drops what it cannot use, while {@link validatePresetsDocument}
 * is the *import* face and refuses the document. Keeping the two apart is what
 * lets one bad hand-edited line keep the library readable without letting a
 * crafted backup write it.
 */
const PRESET_DOCUMENT_KEYS = Object.freeze(['version', 'presets', 'applied']);
const PRESET_ENTRY_KEYS = Object.freeze(['id', 'name', 'action', 'text', 'createdAt', 'updatedAt']);
const APPLIED_ENTRY_KEYS = Object.freeze(['workspaceRoot', 'base', 'stack']);
const STACK_ENTRY_KEYS = Object.freeze(['presetId', 'appliedAt', 'action', 'text']);

/**
 * Refuse an object that carries a key this revision does not define.
 * @param value - the object.
 * @param allowed - the accepted keys.
 * @param where - the dotted location for the message.
 * @throws {OverrideError} `invalid-presets`.
 */
function assertKnownKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw fail('invalid-presets', `${where} carries an unknown key ${JSON.stringify(key)}`);
    }
  }
}

/**
 * Validate one preset entry **strictly** (Revision 53).
 *
 * Every rule `normalizeStoredPreset` tolerates by dropping the entry is a
 * refusal here, and each refusal names the rule it broke. Nothing is
 * normalized away: an import must write exactly what the document asked for,
 * or write nothing at all.
 * @param raw - one element of a document's `presets` array.
 * @param where - the dotted location for the message.
 * @returns the validated `{id, name, action, text, createdAt, updatedAt}`.
 * @throws {OverrideError} with a stable code.
 */
function validatePresetEntry(raw, where) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('invalid-preset', `${where} must be a JSON object`);
  }
  assertKnownKeys(raw, PRESET_ENTRY_KEYS, where);
  const id = raw.id;
  if (typeof id !== 'string' || !PRESET_ID_PATTERN.test(id)) {
    throw fail('invalid-preset-id', `${where}.id must be a preset id (1-64 characters of [A-Za-z0-9._-])`);
  }
  const name = raw.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw fail('invalid-name', `${where} requires a non-empty string "name"`);
  }
  if (name.length > MAX_PRESET_NAME_LENGTH) {
    throw fail('name-too-long', `${where}.name exceeds ${MAX_PRESET_NAME_LENGTH} characters`);
  }
  if (CONTROL_CHARACTERS.test(name)) {
    throw fail('invalid-name', `${where}.name must not contain control characters`);
  }
  const action = raw.action;
  if (typeof action !== 'string' || !PRESET_ACTIONS.includes(action)) {
    throw fail('unsupported-action', `${where}.action must be one of ${PRESET_ACTIONS.map((value) => JSON.stringify(value)).join(', ')}`);
  }
  if (typeof raw.text !== 'string') {
    throw fail('missing-text', `${where} requires a string "text"`);
  }
  if (encoder.encode(raw.text).length > MAX_TEXT_BYTES) {
    throw fail('text-too-large', `${where}.text exceeds ${MAX_TEXT_BYTES} UTF-8 bytes`);
  }
  for (const key of ['createdAt', 'updatedAt']) {
    if (raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== 'string') {
      throw fail('invalid-preset', `${where}.${key} must be a string or null`);
    }
  }
  return {
    id,
    name,
    action,
    text: raw.text,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

/**
 * Validate one `applied` record strictly (Revision 53).
 *
 * The Revision 41 shape (`{workspaceRoot, base, stack}`) is the only one
 * accepted: a Revision 37 record is a *stored* shape the read face migrates,
 * never something this build writes, and an import that silently migrated it
 * would report a write it did not perform.
 * @param raw - one element of a document's `applied` array.
 * @param where - the dotted location for the message.
 * @returns the validated record.
 * @throws {OverrideError} with a stable code.
 */
function validateAppliedEntry(raw, where) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('invalid-applied', `${where} must be a JSON object`);
  }
  assertKnownKeys(raw, APPLIED_ENTRY_KEYS, where);
  const workspaceRoot = raw.workspaceRoot;
  // g-074 R1: this field **is** the workspace root `workspaces[].root` carries
  // (`core/transfer.js`), so it is judged by the very same shape rule. Before
  // R1 it was checked for nothing but "a non-empty string": an imported library
  // could name `/etc`, and the delete-preset route would later write into it.
  // The registry half of the rule is a route decision (`index.js`), because only
  // the Host can answer it — shape here, whitelist there, both before a byte.
  validateWorkspaceRoot(workspaceRoot, `${where}.workspaceRoot`);
  let base = null;
  if (raw.base !== undefined && raw.base !== null) {
    if (typeof raw.base !== 'object' || Array.isArray(raw.base)) {
      throw fail('invalid-applied', `${where}.base must be an object or null`);
    }
    assertKnownKeys(raw.base, ['action', 'text'], `${where}.base`);
    if (!PRESET_ACTIONS.includes(raw.base.action)) {
      throw fail('unsupported-action', `${where}.base.action must be one of ${PRESET_ACTIONS.join(', ')}`);
    }
    if (typeof raw.base.text !== 'string') {
      throw fail('missing-text', `${where}.base requires a string "text"`);
    }
    if (encoder.encode(raw.base.text).length > MAX_TEXT_BYTES) {
      throw fail('text-too-large', `${where}.base.text exceeds ${MAX_TEXT_BYTES} UTF-8 bytes`);
    }
    base = { action: raw.base.action, text: raw.base.text };
  }
  if (raw.stack !== undefined && !Array.isArray(raw.stack)) {
    throw fail('invalid-applied', `${where}.stack must be an array`);
  }
  const stack = (raw.stack ?? []).map((item, index) => {
    const at = `${where}.stack[${index}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw fail('invalid-applied', `${at} must be a JSON object`);
    }
    assertKnownKeys(item, STACK_ENTRY_KEYS, at);
    if (typeof item.presetId !== 'string' || !PRESET_ID_PATTERN.test(item.presetId)) {
      throw fail('invalid-preset-id', `${at}.presetId must be a preset id`);
    }
    if (item.appliedAt !== undefined && item.appliedAt !== null && typeof item.appliedAt !== 'string') {
      throw fail('invalid-applied', `${at}.appliedAt must be a string or null`);
    }
    if (!PRESET_ACTIONS.includes(item.action)) {
      throw fail('unsupported-action', `${at}.action must be one of ${PRESET_ACTIONS.join(', ')}`);
    }
    if (typeof item.text !== 'string') {
      throw fail('missing-text', `${at} requires a string "text"`);
    }
    if (encoder.encode(item.text).length > MAX_TEXT_BYTES) {
      throw fail('text-too-large', `${at}.text exceeds ${MAX_TEXT_BYTES} UTF-8 bytes`);
    }
    return {
      presetId: item.presetId,
      appliedAt: typeof item.appliedAt === 'string' ? item.appliedAt : null,
      action: item.action,
      text: item.text,
    };
  });
  return { workspaceRoot, base, stack };
}

/**
 * Validate a whole preset document **strictly**, for an import (Revision 53).
 *
 * This is the document-level twin of {@link normalizePresets} and the two
 * differ on exactly one axis, on purpose: `normalizePresets` answers「what can
 * this file still mean?」and drops what it cannot, while this answers「may this
 * document be written?」and refuses. An import replaces `presets.json` as a
 * whole, so a document with one unusable entry must write **nothing** rather
 * than quietly delete the rest of the library.
 * @param raw - the parsed document.
 * @returns the normalized `{version, presets, applied}`.
 * @throws {OverrideError} `invalid-presets` / `unsupported-presets-version` /
 *   `invalid-preset` / `invalid-preset-id` / `duplicate-preset-id` /
 *   `invalid-name` / `name-too-long` / `unsupported-action` / `missing-text` /
 *   `text-too-large` / `invalid-applied`.
 */
export function validatePresetsDocument(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('invalid-presets', 'the presets document must be a JSON object');
  }
  assertKnownKeys(raw, PRESET_DOCUMENT_KEYS, 'presets');
  if (raw.version !== undefined && raw.version !== PRESETS_VERSION) {
    throw fail('unsupported-presets-version', `unsupported presets version ${JSON.stringify(raw.version)}`);
  }
  if (raw.presets !== undefined && !Array.isArray(raw.presets)) {
    throw fail('invalid-presets', '"presets" must be an array');
  }
  if (raw.applied !== undefined && !Array.isArray(raw.applied)) {
    throw fail('invalid-presets', '"applied" must be an array');
  }
  const presets = [];
  const ids = new Set();
  (raw.presets ?? []).forEach((entry, index) => {
    const preset = validatePresetEntry(entry, `presets[${index}]`);
    if (ids.has(preset.id)) {
      throw fail('duplicate-preset-id', `"presets" names the preset id ${JSON.stringify(preset.id)} twice`);
    }
    ids.add(preset.id);
    presets.push(preset);
  });
  const applied = [];
  const roots = new Set();
  (raw.applied ?? []).forEach((entry, index) => {
    const record = validateAppliedEntry(entry, `applied[${index}]`);
    if (roots.has(record.workspaceRoot)) {
      throw fail('invalid-applied', `"applied" names the workspace ${JSON.stringify(record.workspaceRoot)} twice`);
    }
    roots.add(record.workspaceRoot);
    applied.push(record);
  });
  return { version: PRESETS_VERSION, presets, applied };
}

/**
 * Validate a preset body (`PUT /prompt-setting/presets`).
 *
 * The order is the order of the answers: a body that is not an object, then the
 * name, then the action, then the text. Every rejection is a `400` carrying a
 * stable code, and the route has written nothing at that point — the file is
 * byte-identical, which is what the negative cases assert.
 *
 * The text cap is a `400` here (not the config validator's `413`): this route's
 * body cap is separate, so a text that is over the library's own limit is an
 * ordinary invalid input rather than a transport-level refusal.
 * @param raw - the parsed request body.
 * @returns the normalized `{name, action, text}`.
 * @throws {OverrideError} `invalid-preset` / `invalid-name` / `name-too-long` /
 *   `unsupported-action` / `missing-text` / `text-too-large`.
 */
export function validatePresetInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('invalid-preset', 'a preset must be a JSON object');
  }
  const name = raw.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw fail('invalid-name', 'a preset requires a non-empty string "name"');
  }
  if (name.length > MAX_PRESET_NAME_LENGTH) {
    throw fail('name-too-long', `"name" exceeds ${MAX_PRESET_NAME_LENGTH} characters`);
  }
  if (CONTROL_CHARACTERS.test(name)) {
    throw fail('invalid-name', '"name" must not contain control characters');
  }
  const action = raw.action;
  if (typeof action !== 'string' || !PRESET_ACTIONS.includes(action)) {
    throw fail(
      'unsupported-action',
      `"action" must be one of ${PRESET_ACTIONS.map((value) => JSON.stringify(value)).join(', ')}, not `
      + `${action === undefined ? 'an absent action' : JSON.stringify(action)}`,
    );
  }
  if (typeof raw.text !== 'string') {
    throw fail('missing-text', `a "${action}" preset requires a string "text"`);
  }
  if (encoder.encode(raw.text).length > MAX_TEXT_BYTES) {
    throw fail('text-too-large', `"text" exceeds ${MAX_TEXT_BYTES} UTF-8 bytes`);
  }
  return { name, action, text: raw.text };
}

/**
 * Validate an id that addresses an existing preset.
 * @param value - the `id` field of a body, or a `?id=` value.
 * @param code - the error code to answer with (`missing-id` when the caller
 *   distinguishes "absent" from "malformed" itself).
 * @returns the id.
 * @throws {OverrideError} 400 with the given code.
 */
export function validatePresetId(value, code = 'invalid-id') {
  if (typeof value !== 'string' || !PRESET_ID_PATTERN.test(value)) {
    throw fail(code, '"id" must be a preset id (1-64 characters of [A-Za-z0-9._-])');
  }
  return value;
}

/**
 * The preset with one id, or `null`.
 * @param document - a normalized document.
 * @param id - the preset id.
 * @returns the preset, or `null`.
 */
export function presetById(document, id) {
  const list = Array.isArray(document?.presets) ? document.presets : [];
  return list.find((entry) => entry.id === id) ?? null;
}

/**
 * Insert or update one preset.
 *
 * Without an id this is an insertion and the caller must have minted one
 * (`options.id`); with an id the entry must exist (`404 preset-not-found`),
 * because "edit preset X" silently becoming "create preset X" would make a
 * stale page overwrite the library instead of reporting that its target is
 * gone. The `createdAt` of an edited preset is preserved; `updatedAt` moves.
 * @param document - the current normalized document.
 * @param fields - the validated `{name, action, text}`.
 * @param options.id - the id to insert (ignored when `fields.id` is given).
 * @param options.at - the ISO timestamp to stamp.
 * @returns `{document, preset, created}`.
 * @throws {OverrideError} 404 `preset-not-found` for an unknown existing id.
 */
export function upsertPreset(document, fields, options = {}) {
  const at = typeof options.at === 'string' ? options.at : null;
  const list = Array.isArray(document?.presets) ? document.presets.slice() : [];
  const id = fields?.id === undefined || fields?.id === null ? options.id : fields.id;
  if (id === undefined || id === null) {
    throw fail('missing-id', 'a new preset needs an id minted by the Host');
  }
  const editing = fields?.id !== undefined && fields?.id !== null;
  const index = list.findIndex((entry) => entry.id === id);
  if (editing && index === -1) {
    throw fail('preset-not-found', `no preset with id ${JSON.stringify(id)}`, 404);
  }
  const previous = index === -1 ? null : list[index];
  const preset = {
    id,
    name: fields.name,
    action: fields.action,
    text: fields.text,
    createdAt: previous?.createdAt ?? at,
    updatedAt: at,
  };
  if (index === -1) list.push(preset);
  else list[index] = preset;
  return {
    document: { version: PRESETS_VERSION, presets: list, applied: appliedListOf(document) },
    preset,
    created: index === -1,
  };
}

/**
 * Remove one preset — the **catalogue** half of a deletion, and nothing else.
 *
 * Since Revision 50 the normal deletion path is {@link planPresetRemoval}: every
 * application of the preset is cancelled (the workspace layer is restored to
 * `base` plus what is left of its stack) **before** this function drops the
 * entry, so an ordinary delete produces no orphan at all. This function itself
 * still touches no layer, which is what keeps it usable for the two cases that
 * are not an ordinary delete: a hand-edited `applied` record (or one written by
 * Revisions 37–49) whose link outlives its preset keeps its own snapshot and is
 * still reported as an orphan and still cancellable (§20.1).
 * @param document - the current normalized document.
 * @param id - the preset id.
 * @returns `{document, removed}` where `removed` is the deleted preset or null.
 */
export function removePreset(document, id) {
  const list = Array.isArray(document?.presets) ? document.presets : [];
  const at = list.findIndex((entry) => entry.id === id);
  if (at === -1) return { document, removed: null };
  const removed = list[at];
  const presets = list.slice();
  presets.splice(at, 1);
  return {
    document: { version: PRESETS_VERSION, presets, applied: appliedListOf(document) },
    removed,
  };
}

/** The `applied` list of a document, tolerating a shape without one. */
function appliedListOf(document) {
  return Array.isArray(document?.applied) ? document.applied.slice() : [];
}

/** The reserved entry of one layer config, or `null`. */
function reservedEntryOf(config) {
  const list = Array.isArray(config?.overrides) ? config.overrides : [];
  return list.find((entry) => entry?.name === CUSTOM_SECTION_NAME) ?? null;
}

/**
 * Rebuild one layer config with the reserved entry upserted, keeping the
 * layer's own interpolation switch and its other entries in file order.
 *
 * Deliberately local to this module: `core/store.js`'s `upsertOverride` is the
 * same idea, but a pure module must not import the filesystem module. The two
 * cannot drift — the shape they produce is `validateConfig`'s, and the route
 * validates the result before writing.
 * @param config - the current validated config.
 * @param override - the `{name, action, text}` to store.
 * @returns a fresh config.
 */
function withReservedOverride(config, override) {
  const overrides = (Array.isArray(config?.overrides) ? config.overrides : []).slice();
  const at = overrides.findIndex((entry) => entry?.name === CUSTOM_SECTION_NAME);
  if (at === -1) overrides.push(override);
  else overrides[at] = override;
  const flag = typeof config?.interpolateCustom === 'boolean' ? config.interpolateCustom : undefined;
  return withInterpolate({ version: config?.version ?? 1, overrides }, flag);
}

/** Rebuild one layer config without the reserved entry. */
function withoutReservedOverride(config) {
  const overrides = (Array.isArray(config?.overrides) ? config.overrides : [])
    .filter((entry) => entry?.name !== CUSTOM_SECTION_NAME);
  const flag = typeof config?.interpolateCustom === 'boolean' ? config.interpolateCustom : undefined;
  return withInterpolate({ version: config?.version ?? 1, overrides }, flag);
}

/**
 * The reserved entry's text for one base + stack pair.
 *
 * Parts that are empty (or whitespace-only) contribute nothing — Revision 35's
 * 「a blank half states nothing」 rule, applied to every link of the chain — and
 * the non-empty ones are joined by the same {@link RESERVED_STACK_SEPARATOR} the
 * cross-layer stack uses, so one application of one preset reproduces exactly
 * what Revision 39 produced.
 * @param base - the `{action, text}|null` snapshot the stack sits on.
 * @param stack - the stack entries, in application order.
 * @returns the composed text.
 */
function composeStackText(base, stack) {
  const parts = [];
  const baseText = base === null ? '' : base.text;
  if (baseText.trim().length > 0) parts.push(baseText);
  for (const item of stack) {
    if (typeof item.text === 'string' && item.text.trim().length > 0) parts.push(item.text);
  }
  return parts.join(RESERVED_STACK_SEPARATOR);
}

/**
 * Plan「应用」: push one preset onto a workspace's stack and recompose its text.
 *
 * **The model (Revision 41).** Each workspace keeps one record: `base` — the
 * reserved entry as it stood **before the first application** — and the `stack`
 * of presets applied since, in order. The layer's text is always the recomposition
 * of that pair, so「取消应用」of *one* preset removes that link and keeps the
 * others, instead of walking the whole layer back.
 *
 * **Idempotent.** A preset already on the stack is not pushed twice: the plan
 * returns the caller's own document, the existing record, and
 * `alreadyApplied: true`, and the route writes nothing at all — layer, history
 * and library file included (Revisions 39/R5).
 *
 * **The base is taken once.** The first application snapshots the layer as it
 * stood; later applications never overwrite it (Revision 40/R6 — a snapshot that
 * followed the current text would turn「取消应用」into a no-op).
 *
 * **Recomposition is authoritative.** The text is rebuilt from the stack rather
 * than appended to whatever the layer currently holds, so a hand edit made
 * between two applications is overwritten. That is the price of cancelling one
 * preset out of several, and it is stated in the contract (§20.5).
 * @param document - the current normalized document.
 * @param options.presetId - the preset to apply.
 * @param options.workspaceRoot - the resolved workspace root.
 * @param options.current - the workspace layer's current validated config.
 * @param options.at - the ISO timestamp to stamp.
 * @returns `{document, preset, record, base, stack, text, config, alreadyApplied}`.
 * @throws {OverrideError} 404 `preset-not-found`.
 */
export function planApply(document, options = {}) {
  const preset = presetById(document, options.presetId);
  if (preset === null) {
    throw fail('preset-not-found', `no preset with id ${JSON.stringify(options.presetId)}`, 404);
  }
  const entry = reservedEntryOf(options.current);
  const existing = appliedListOf(document)
    .find((item) => item.workspaceRoot === options.workspaceRoot) ?? null;
  const stack = existing === null ? [] : existing.stack.slice();
  const currentText = entry === null || typeof entry.text !== 'string' ? '' : entry.text;

  if (stack.some((item) => item.presetId === preset.id)) {
    return {
      document,
      preset,
      record: existing,
      base: existing.base,
      stack,
      text: currentText,
      config: options.current,
      alreadyApplied: true,
    };
  }

  const base = existing === null
    ? entry === null
      ? null
      : { action: entry.action, text: currentText }
    : existing.base;
  const nextStack = stack.concat([{
    presetId: preset.id,
    appliedAt: typeof options.at === 'string' ? options.at : null,
    action: preset.action,
    text: preset.text,
  }]);
  const text = composeStackText(base, nextStack);
  // The entry's mode follows the link that was applied last: it describes how
  // the composed text relates to the other layer (§13.1), and the newest
  // application is the one that stated an intent about it.
  const action = nextStack[nextStack.length - 1].action;
  const config = withReservedOverride(options.current, { name: CUSTOM_SECTION_NAME, action, text });
  const record = { workspaceRoot: options.workspaceRoot, base, stack: nextStack };
  const applied = appliedListOf(document).filter((item) => item.workspaceRoot !== options.workspaceRoot);
  applied.push(record);
  return {
    document: { version: PRESETS_VERSION, presets: document.presets.slice(), applied },
    preset,
    record,
    base,
    stack: nextStack,
    text,
    config,
    alreadyApplied: false,
  };
}

/**
 * Plan「取消应用」: pop **one** preset off a workspace's stack.
 *
 * Revision 41: the request names the preset to remove. The remaining links stay
 * — that is the whole point of the stack — and the layer's text is recomposed
 * from `base` plus what is left. Removing the last link restores `base` itself:
 * a non-null base is written back with its own `action`/`text`, a `null` base
 * removes the reserved entry, and the layer's `interpolateCustom` switch and its
 * other entries are never touched.
 *
 * A workspace with no record, or with a record that does not hold that preset,
 * is `404 not-applied`: there is nothing to remove, and answering `200` would
 * claim a write that did not happen. The plan is total over the rest — the text
 * is recomposed rather than un-appended, so it is right even if the layer was
 * edited by hand in the meantime (the contract states that trade, §20.6).
 * @param document - the current normalized document.
 * @param options.workspaceRoot - the resolved workspace root.
 * @param options.presetId - the preset to take off the stack.
 * @param options.current - the workspace layer's current validated config.
 * @returns `{document, record, removed, base, stack, text, restored, config}`
 *   where `stack` is what remains, `removed` is the popped link, and `restored`
 *   says the layer is back to its base (as opposed to merely one shorter).
 * @throws {OverrideError} 404 `not-applied`.
 */
export function planUnapply(document, options = {}) {
  const applied = appliedListOf(document);
  const record = applied.find((item) => item.workspaceRoot === options.workspaceRoot) ?? null;
  const at = record === null
    ? -1
    : record.stack.findIndex((item) => item.presetId === options.presetId);
  if (record === null || at === -1) {
    throw fail(
      'not-applied',
      `${JSON.stringify(options.presetId)} is not applied to ${JSON.stringify(options.workspaceRoot)}`,
      404,
    );
  }
  const removed = record.stack[at];
  const stack = record.stack.slice();
  stack.splice(at, 1);
  let config;
  let restored = false;
  if (stack.length === 0) {
    restored = record.base !== null;
    config = record.base === null
      ? withoutReservedOverride(options.current)
      : withReservedOverride(options.current, {
        name: CUSTOM_SECTION_NAME,
        action: record.base.action,
        text: record.base.text,
      });
  } else {
    config = withReservedOverride(options.current, {
      name: CUSTOM_SECTION_NAME,
      action: stack[stack.length - 1].action,
      text: composeStackText(record.base, stack),
    });
  }
  // An empty stack is not a record: the workspace is back to its base, there is
  // nothing left to cancel, and keeping a base with no links would only make the
  // page report an application that no longer exists.
  const kept = stack.length === 0
    ? applied.filter((item) => item.workspaceRoot !== options.workspaceRoot)
    : applied.map((item) => (
      item.workspaceRoot === options.workspaceRoot ? { workspaceRoot: item.workspaceRoot, base: item.base, stack } : item
    ));
  const nextRecord = stack.length === 0
    ? null
    : { workspaceRoot: record.workspaceRoot, base: record.base, stack };
  return {
    document: {
      version: PRESETS_VERSION,
      presets: document.presets.slice(),
      applied: kept,
    },
    record: nextRecord,
    removed,
    base: record.base,
    stack,
    text: stack.length === 0 ? (record.base === null ? '' : record.base.text) : composeStackText(record.base, stack),
    restored,
    config,
  };
}

/**
 * The workspaces whose `applied` record holds one preset, in file order.
 *
 * The route half needs this list **before** it plans anything: it is the set of
 * layers the deletion is about to restore, and therefore the set a refusal has
 * to account for ("which of these were restored, which were not").
 * @param document - the current normalized document.
 * @param presetId - the preset id.
 * @returns a fresh array of workspace roots (deduplicated).
 */
export function appliedRootsOf(document, presetId) {
  const roots = [];
  for (const record of appliedListOf(document)) {
    if (!record.stack.some((item) => item.presetId === presetId)) continue;
    if (!roots.includes(record.workspaceRoot)) roots.push(record.workspaceRoot);
  }
  return roots;
}

/**
 * Plan「删除预设」: cancel **every** application of one preset, then drop it.
 *
 * Revision 50. Deleting an applied preset is no longer a catalogue-only write:
 * the text the deletion would otherwise leave behind, with a record that can
 * never name its source again, is exactly what the user asked to be rid of. Each
 * workspace that holds the preset is taken off its stack with
 * {@link planUnapply}'s own semantics — the remaining links (if any) are
 * recomposed over `base`, an empty stack restores `base` itself (`null` removes
 * the reserved entry), and the layer's `interpolateCustom` switch and its other
 * entries are never touched — and only then is the entry removed from the
 * library.
 *
 * **Pure.** The workspace layers are read by the caller and handed in through
 * `currentOf`; this function decides, it never writes. That is what makes the
 * atomicity the route needs possible: every read, every plan and every
 * validation happens before the first byte moves, so a workspace that cannot be
 * restored refuses the whole deletion instead of leaving "the preset is gone and
 * the layer is not".
 *
 * A workspace whose hand-edited record carries the same preset **twice** is
 * given the same treatment link by link: {@link planUnapply} pops one at a time,
 * so the loop below runs until the record no longer names the preset at all —
 * an ordinary document needs exactly one pass.
 *
 * **A layer that is not there is skipped, not invented.** When `currentOf`
 * answers `null`/`undefined` — the caller read the file and found ENOENT — the
 * workspace has no text to restore, so its plan carries `missing: true` and
 * `config: null`: the route must not write, cache or log it, and it must **not**
 * create the directory a write would need. Its links are still cancelled here, so
 * the deletion leaves no orphan behind even then. An unreadable or invalid layer
 * is the opposite case: it is a `throw` from `currentOf`, which refuses the whole
 * plan.
 * @param document - the current normalized document.
 * @param options.presetId - the preset to delete and cancel.
 * @param options.currentOf - `(workspaceRoot) => validated config|null`; the
 *   caller's read of that layer. `null` means the layer file does not exist
 *   (ENOENT). Throwing from it refuses the whole plan (and nothing has been
 *   written).
 * @returns `{document, removed, plans, links}`. `document` is the library with
 *   the preset dropped and every one of its links gone; `removed` is `null` when
 *   the library has no such preset (and then nothing else is reported);
 *   `plans` is one entry per affected workspace
 *   (`{workspaceRoot, missing, removed, links, before, after, config, restored, base, stack, text}`);
 *   `links` is the total number of stack links cancelled.
 */
export function planPresetRemoval(document, options = {}) {
  const presetId = options.presetId;
  const roots = appliedRootsOf(document, presetId);
  // Nothing applied it: the deletion is a catalogue write and nothing else, byte
  // for byte what Revision 49 did — no layer is opened, let alone written.
  if (roots.length === 0) {
    const dropped = removePreset(document, presetId);
    return { document: dropped.document, removed: dropped.removed, plans: [], links: 0 };
  }
  let working = document;
  const plans = [];
  for (const workspaceRoot of roots) {
    // `null` means **this workspace has no layer file at all** (the caller's read
    // reported ENOENT). There is no text to restore, so this entry is planned as
    // a cleanup only: `missing: true`, `config: null`, and the route must not
    // write, cache or log it — restoring a layer that does not exist would create
    // the workspace directory the user deleted (g-069 review A). The links still
    // come off the record here, so the deletion cannot leave an orphan behind.
    const read = options.currentOf(workspaceRoot);
    const missing = read === null || read === undefined;
    const current = missing ? emptyConfig() : read;
    let config = null;
    let step = null;
    const removed = [];
    const before = missing ? null : reservedSectionOf(current);
    for (;;) {
      const record = appliedListOf(working).find((item) => item.workspaceRoot === workspaceRoot) ?? null;
      if (record === null || !record.stack.some((item) => item.presetId === presetId)) break;
      step = planUnapply(working, {
        workspaceRoot,
        presetId,
        current: config === null ? current : config,
      });
      working = step.document;
      config = step.config;
      removed.push(step.removed);
    }
    plans.push({
      workspaceRoot,
      missing,
      removed,
      links: removed.length,
      before,
      after: missing ? null : reservedSectionOf(config),
      config: missing ? null : config,
      restored: missing || step === null ? false : step.restored,
      base: step === null ? null : step.base,
      stack: step === null ? [] : step.stack,
      text: step === null ? '' : step.text,
    });
  }
  const dropped = removePreset(working, presetId);
  if (dropped.removed === null) return { document, removed: null, plans: [], links: 0 };
  return {
    document: dropped.document,
    removed: dropped.removed,
    plans,
    links: plans.reduce((total, plan) => total + plan.links, 0),
  };
}

/**
 * The public view of the library: presets only.
 *
 * Nothing here renames a field or invents a value, so a page that already
 * renders the stored shape renders this one. `createdAt`/`updatedAt` are `null`
 * when a hand-edited file did not state them — never a made-up timestamp.
 * @param document - the normalized document.
 * @returns a fresh array.
 */
export function publicPresets(document) {
  const list = Array.isArray(document?.presets) ? document.presets : [];
  return list.map((preset) => ({
    id: preset.id,
    name: preset.name,
    action: preset.action,
    text: preset.text,
    createdAt: preset.createdAt ?? null,
    updatedAt: preset.updatedAt ?? null,
  }));
}

/**
 * The public view of the applied records: one entry per workspace, with its base
 * and its stack.
 *
 * Each stack link carries the preset's **name** when the library still has it and
 * `orphan: true` when it does not — the link itself keeps its own
 * `{action, text}` snapshot, which is why an orphan still composes and still
 * cancels (§20.6). `base` is reported as-is so a page can say what the workspace
 * will fall back to.
 * @param document - the normalized document.
 * @returns a fresh array.
 */
export function publicApplied(document) {
  const list = Array.isArray(document?.applied) ? document.applied : [];
  const presets = new Map((Array.isArray(document?.presets) ? document.presets : []).map((p) => [p.id, p]));
  return list.map((record) => ({
    workspaceRoot: record.workspaceRoot,
    base: record.base === null ? null : { action: record.base.action, text: record.base.text },
    stack: record.stack.map((item) => ({
      presetId: item.presetId,
      presetName: presets.has(item.presetId) ? presets.get(item.presetId).name : null,
      orphan: !presets.has(item.presetId),
      appliedAt: item.appliedAt ?? null,
    })),
  }));
}

/**
 * The reserved section's own entry of a workspace layer, for a response that
 * should state what「应用」really left on disk. Exported because the route builds
 * its `after` field from it without re-deriving the lookup.
 * @param config - a validated layer config.
 * @returns `{action, text}|null`.
 */
export function reservedSectionOf(config) {
  const entry = reservedEntryOf(config);
  if (entry === null) return null;
  return { action: entry.action, text: typeof entry.text === 'string' ? entry.text : '' };
}

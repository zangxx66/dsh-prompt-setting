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
 * Why the library is not folded into `overrides.json` (or into an export): the
 * export / import / history / snapshot schemas are frozen contracts, and a
 * preset is neither an override of one layer nor a portable backup — it is the
 * user's own catalogue of texts, which is why it lives in a third file
 * (`<DSH_HOME>/prompt-setting/presets.json`) with its own shape.
 *
 * @module dsh-prompt-setting/core/presets
 */

import { CUSTOM_SECTION_NAME } from './custom.js';
import { MAX_TEXT_BYTES, RESERVED_STACK_SEPARATOR, fail, withInterpolate } from './overrides.js';

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
 * Normalize one stored `applied` record.
 *
 * `before` is the whole point of the record, so a record whose snapshot cannot
 * be read is dropped: "applied, but we do not know what to restore" would make
 *「取消应用」silently wrong. A `null` snapshot is a real value — it means the
 * workspace layer held no reserved entry when the preset was applied, so
 *「取消应用」must remove the entry entirely.
 * @param raw - one element of a stored `applied` array.
 * @returns the normalized record, or `null` when the entry is unusable.
 */
function normalizeStoredApplied(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const workspaceRoot = raw.workspaceRoot;
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) return null;
  const presetId = raw.presetId;
  if (typeof presetId !== 'string' || !PRESET_ID_PATTERN.test(presetId)) return null;
  let before = null;
  if (raw.before !== undefined && raw.before !== null) {
    const snapshot = raw.before;
    if (typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    if (!PRESET_ACTIONS.includes(snapshot.action)) return null;
    if (typeof snapshot.text !== 'string' || encoder.encode(snapshot.text).length > MAX_TEXT_BYTES) return null;
    before = { action: snapshot.action, text: snapshot.text };
  }
  return {
    workspaceRoot,
    presetId,
    before,
    appliedAt: typeof raw.appliedAt === 'string' ? raw.appliedAt : null,
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
  const applied = [];
  for (const entry of raw.applied ?? []) {
    const record = normalizeStoredApplied(entry);
    if (record === null) continue;
    const at = applied.findIndex((item) => item.workspaceRoot === record.workspaceRoot);
    if (at === -1) applied.push(record);
    else applied[at] = record;
  }
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
 * Remove one preset.
 *
 * Deleting an applied preset is allowed and changes **no layer**: the record
 * stays (and is then reported as an orphan), because rewriting a workspace the
 * user did not name would be a write no request asked for. The caller decides
 * how to report that.
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
 * Plan「应用」: snapshot what the workspace layer holds now, return the config to
 * write, and return the library document with the record replaced.
 *
 * The snapshot is the whole safety story of「取消应用」: the reserved section is
 * one entry, so writing a preset overwrites whatever the user had typed, and
 * the only way back is the copy taken **before** the write. It is taken from the
 * config the route just read (not from the cache, not from an earlier request).
 *
 * At most one record per workspace root: applying a second preset replaces the
 * first record, so「取消应用」goes back to the text that was there before the
 * *latest* application. That is a deliberate one-deep model — a stack of
 * snapshots would be a version history, which this feature does not claim to be.
 *
 * **The two modes mean what they mean everywhere else in this plugin
 * (Revision 39).** `replace` is the preset's text as the section's text.
 * `append` is the preset's text **stacked after what the workspace layer already
 * holds**, joined by the same {@link RESERVED_STACK_SEPARATOR} the two-layer
 * stack of Revision 36 uses — the reserved section is one entry per layer, so
 * 「叠加」 has to be composed here, at the one moment the text is written; the
 * merge kernel cannot add the same layer's text twice. An empty/absent stored
 * text contributes no separator, exactly as in the cross-layer case.
 *
 * The composition is **idempotent**: a text that is already the preset's, or
 * already ends with `SEP + preset.text`, is left alone and the plan says so
 * (`alreadyApplied`), so clicking「应用」twice cannot grow the section by one
 * copy each time. Such a request changes **nothing at all**: the returned
 * `document` is the caller's own object, and `record` is the record that was
 * already there (or `null` when this layer never had one — the request produced
 * no change to restore). The snapshot the *first* application took is the only
 * thing「取消应用」restores, so a second click must not overwrite it (review R5).
 * @param document - the current normalized document.
 * @param options.presetId - the preset to apply.
 * @param options.workspaceRoot - the resolved workspace root.
 * @param options.current - the workspace layer's current validated config.
 * @param options.at - the ISO timestamp to stamp.
 * @returns `{document, preset, before, config, record, text, alreadyApplied}`
 *   where `text` is the text the reserved entry ends up with, `alreadyApplied`
 *   says the layer already carried it, and `document`/`record` are the inputs
 *   unchanged in that case (a new record is written only when one is needed).
 * @throws {OverrideError} 404 `preset-not-found`.
 */
export function planApply(document, options = {}) {
  const preset = presetById(document, options.presetId);
  if (preset === null) {
    throw fail('preset-not-found', `no preset with id ${JSON.stringify(options.presetId)}`, 404);
  }
  const entry = reservedEntryOf(options.current);
  const before = entry === null
    ? null
    : { action: entry.action, text: typeof entry.text === 'string' ? entry.text : '' };
  const stored = entry === null || typeof entry.text !== 'string' ? '' : entry.text;
  let text;
  let alreadyApplied = false;
  if (preset.action === 'append') {
    if (stored.length === 0) {
      text = preset.text;
    } else if (stored === preset.text || stored.endsWith(`${RESERVED_STACK_SEPARATOR}${preset.text}`)) {
      // Already the whole text, or already the top of the stack: appending again
      // would duplicate it, which is the one thing a second click must not do.
      text = stored;
      alreadyApplied = true;
    } else {
      text = `${stored}${RESERVED_STACK_SEPARATOR}${preset.text}`;
    }
  } else {
    text = preset.text;
    alreadyApplied = entry !== null && stored === preset.text && entry.action === preset.action;
  }
  const config = withReservedOverride(options.current, {
    name: CUSTOM_SECTION_NAME,
    action: preset.action,
    text,
  });
  // Review R5: an idempotent request changes **nothing**, and that includes the
  // record. `before` is the only thing「取消应用」restores, so overwriting it with
  // the text the layer holds *now* would turn the cancel into a no-op — the user
  // could never get back to the state before the first application. The existing
  // record is therefore returned untouched (and `null` when this layer never had
  // one: this request produced no change to restore).
  if (alreadyApplied) {
    const existing = appliedListOf(document)
      .find((item) => item.workspaceRoot === options.workspaceRoot) ?? null;
    return {
      document,
      preset,
      before,
      config,
      record: existing,
      text,
      alreadyApplied: true,
    };
  }
  const record = {
    workspaceRoot: options.workspaceRoot,
    presetId: preset.id,
    before,
    appliedAt: typeof options.at === 'string' ? options.at : null,
  };
  const applied = appliedListOf(document).filter((item) => item.workspaceRoot !== options.workspaceRoot);
  applied.push(record);
  return {
    document: { version: PRESETS_VERSION, presets: document.presets.slice(), applied },
    preset,
    before,
    config,
    record,
    text,
    alreadyApplied: false,
  };
}

/**
 * Plan「取消应用」: restore exactly what {@link planApply} snapshotted.
 *
 * The restoration is *content*, not a rollback to a history version: a `null`
 * snapshot removes the reserved entry (the layer had none), and a snapshot
 * writes the recorded `action`/`text` back. The workspace layer's other entries
 * and its interpolation switch are untouched, and no other file is read or
 * written.
 * @param document - the current normalized document.
 * @param options.workspaceRoot - the resolved workspace root.
 * @param options.current - the workspace layer's current validated config.
 * @returns `{document, record, config, restored}` where `restored` is false when
 *   the snapshot was `null` (the entry is removed instead of written back).
 * @throws {OverrideError} 404 `not-applied`.
 */
export function planUnapply(document, options = {}) {
  const applied = appliedListOf(document);
  const record = applied.find((item) => item.workspaceRoot === options.workspaceRoot) ?? null;
  if (record === null) {
    throw fail('not-applied', `no preset is applied to ${JSON.stringify(options.workspaceRoot)}`, 404);
  }
  const config = record.before === null
    ? withoutReservedOverride(options.current)
    : withReservedOverride(options.current, {
      name: CUSTOM_SECTION_NAME,
      action: record.before.action,
      text: record.before.text,
    });
  return {
    document: {
      version: PRESETS_VERSION,
      presets: document.presets.slice(),
      applied: applied.filter((item) => item.workspaceRoot !== options.workspaceRoot),
    },
    record,
    config,
    restored: record.before !== null,
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
 * The public view of the applied records, with the orphan flag.
 *
 * `orphan` says the record's preset is no longer in the library; the workspace
 * layer still holds that text and「取消应用」still restores the snapshot, which is
 * why an orphan is reported rather than cleaned up.
 * @param document - the normalized document.
 * @returns a fresh array.
 */
export function publicApplied(document) {
  const list = Array.isArray(document?.applied) ? document.applied : [];
  const names = new Map((Array.isArray(document?.presets) ? document.presets : []).map((p) => [p.id, p.name]));
  return list.map((record) => ({
    workspaceRoot: record.workspaceRoot,
    presetId: record.presetId,
    presetName: names.get(record.presetId) ?? null,
    orphan: !names.has(record.presetId),
    appliedAt: record.appliedAt ?? null,
    before: record.before === null ? null : { action: record.before.action, text: record.before.text },
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

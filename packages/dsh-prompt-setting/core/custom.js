/**
 * The reserved prompt section this plugin owns, and the write policy that
 * protects it (g-014, CONTRACT.md Revision 7).
 *
 * Pure like `core/overrides.js`: constants plus functions over plain data — no
 * `fs`, no `ctx`, no clock, no import of the Host. That is deliberate. The Host
 * process can only be exercised by restarting `dsh web`, so every decision this
 * revision adds (which name may be written, which may be deleted, what a
 * `legacy=true` clear removes, what a document may carry, what an export
 * carries) lives here where `node --test` pins it down offline, and `index.js`
 * stays an adapter.
 *
 * Vocabulary
 * - *reserved name*: {@link CUSTOM_SECTION_NAME}. It is simultaneously the name
 *   of the section the Host half registers with `systemPrompt.section()` and
 *   the name of the one override the write routes accept.
 * - *custom override*: an override whose `name` is the reserved name.
 * - *legacy override*: any override whose `name` is not. Revision 7 freezes
 *   these: they keep working in assembly, but no route creates, updates or
 *   imports one any more (`DELETE ...&legacy=true` is the one route that
 *   removes them).
 *
 * @module dsh-prompt-setting/core/custom
 */

import { CONFIG_VERSION, fail, withInterpolate } from './overrides.js';

/**
 * The one section name this plugin owns, and the one override name every write
 * route accepts.
 *
 * Namespaced deliberately: `systemPrompt.section()` refuses a duplicate name
 * within a layer, and the shipped section names are the unprefixed
 * `harness:*` / `deployment:*` / `tool:*` families (a preset may add its own
 * `preset:*` / `session:*`), so a `prompt-setting:` prefix cannot collide with
 * a section this repository ships.
 */
export const CUSTOM_SECTION_NAME = 'prompt-setting:custom-prompt';

/**
 * The registration order. Strictly greater than every order the shipped
 * package's own placement table defines — its maximum is
 * `DEPLOYMENT_PERSONA_SUFFIX = 10200` (`@deepseek-ai/dsh-system-prompt`,
 * `lib/index.js`, the `SECTION_ORDERS` table at the top of the module; read
 * back from the installed 0.1.7-rc.2 build).
 *
 * The promise this buys is narrow, and stated that way on purpose: **this
 * plugin's section sorts after every section the DSH repository defines.**
 * Another plugin may legitimately register a larger finite order — the
 * platform documents external contributions as free to place themselves
 * anywhere — and when it does, its section sorts after ours. That is not a
 * violated invariant; it is the documented boundary of what an `order` value
 * can promise.
 */
export const CUSTOM_SECTION_ORDER = 1000000;

/** The largest `order` in the shipped placement table (see above). */
export const REPO_MAX_SECTION_ORDER = 10200;

/**
 * The section's interpolation flag. `false` is a safety requirement, not a
 * style choice: the shipped renderer *throws* on a section whose text
 * references a variable that is not registered, is `undefined`, or is written
 * malformed (`CONTRACT.md` §15.3). User text is arbitrary, so a user who typed
 * a single unknown `{{reference}}` would otherwise break every later assembly
 * of the session. With `interpolate: false` the shipped renderer hands the
 * text back byte for byte.
 */
export const CUSTOM_SECTION_INTERPOLATE = false;

/**
 * The text the section is registered with: empty.
 *
 * An empty section survives into `assembly.sections` (so a waterfall listener
 * can see it) but the shipped `renderPrompt` drops it with its
 * `.filter((text) => text.length > 0)` pass, so an unconfigured install
 * contributes exactly nothing to the final prompt. That is the property
 * `CONTRACT.md` §15.2 calls "zero contribution"; it is asserted against the
 * shipped renderer in `test/integration.test.mjs`.
 */
export const CUSTOM_SECTION_TEXT = '';

/**
 * The definition handed to `ctx.systemPrompt.section()`.
 *
 * A fresh object per call: the service keeps the object it is given, and a
 * shared frozen one would be a trap for any future caller that mutates it.
 * @returns `{name, order, text, interpolate}`.
 */
export function customSection() {
  return {
    name: CUSTOM_SECTION_NAME,
    order: CUSTOM_SECTION_ORDER,
    text: CUSTOM_SECTION_TEXT,
    interpolate: CUSTOM_SECTION_INTERPOLATE,
  };
}

/**
 * Whether a name is the reserved one.
 * @param name - any candidate name.
 * @returns whether it is exactly {@link CUSTOM_SECTION_NAME}.
 */
export function isCustomSectionName(name) {
  return name === CUSTOM_SECTION_NAME;
}

/**
 * Move the reserved section to the end of an assembly's section list (g-017,
 * `CONTRACT.md` Revision 8/§15.10).
 *
 * Pure, total and identity-preserving, like everything else in this module: the
 * listener in `index.js` is a two-line adapter around this function, so every
 * branch that decides *whether* a section moves is pinned offline by
 * `node --test` instead of by a Host restart.
 *
 * Why a move is needed at all: `order: 1000000` (§15.1) sorts the registered
 * section after every section the DSH repository defines, but a
 * `system-prompt/assemble` listener registered **before** this plugin runs its
 * post-`next()` step **after** ours and may append its own section then — it is
 * outer in the waterfall. The live machine does exactly that
 * (`dsh-expression:companion`), which is what puts a third party's text after
 *「我的 Prompt」. Nothing an `order` value can say reaches that, so the plugin
 * moves its own section at the outermost point it can occupy.
 *
 * The identity rule is the important half. This function returns **the very
 * value it was given** unless it actually moves a section: no spread, no new
 * array, no copy on the path where nothing changes. That is what keeps an
 * unconfigured install's zero-diff promise intact (§15.2) — a caller can
 * compare the reference it passed in.
 *
 * Four shapes decide identity. All of them return the input unchanged, so none
 * of them can throw on the assembly path:
 * - `result` has no array `sections` (`null`, a primitive, a shape change):
 *   return it;
 * - no entry carries {@link CUSTOM_SECTION_NAME} — a hand-edited `hide`, a
 *   scope whose collapse dropped it, a shape this plugin did not create: return
 *   it;
 * - the reserved section **is already the last entry**: return it;
 * - the reserved section's `text` is **not a non-empty string**: return it. An
 *   unconfigured section renders zero bytes (§15.2), so its position is
 *   unobservable in the prompt; moving it would buy nothing and would cost the
 *   identity above. Only a section with text is moved — see §15.10.
 *
 * @param result - the value the rest of the waterfall returned, any shape.
 * @returns the same `result`, or a shallow copy of it with the reserved
 *   section moved to the end of a fresh `sections` array.
 */
export function reservedSectionLast(result) {
  const sections = result?.sections;
  if (!Array.isArray(sections)) return result;
  const index = sections.findIndex((section) => isCustomSectionName(section?.name));
  if (index === -1 || index === sections.length - 1) return result;
  const section = sections[index];
  if (typeof section?.text !== 'string' || section.text.length === 0) return result;
  return {
    ...result,
    sections: [...sections.slice(0, index), ...sections.slice(index + 1), section],
  };
}

/**
 * Read one override list, tolerating any shape.
 * @param overrides - a config's `overrides`, or anything else.
 * @returns a fresh array (empty when the input is not an array).
 */
function listOf(overrides) {
  return Array.isArray(overrides) ? overrides.slice() : [];
}

/**
 * Name up to `max` section names for one message, and count the rest.
 *
 * A rejection message goes back to a browser, so it is bounded: an import of a
 * hundred legacy entries must produce a sentence, not a hundred-line dump.
 * @param names - the offending names.
 * @param max - how many to spell out.
 * @returns e.g. `"a", "b" and 3 more`.
 */
function nameList(names, max = 3) {
  const shown = names.slice(0, max).map((name) => JSON.stringify(name)).join(', ');
  const rest = names.length - Math.min(names.length, max);
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/**
 * The actions the reserved name accepts on `PUT /prompt-setting/overrides`,
 * in contract order (Revision 36).
 *
 * `replace` (覆盖) and `append` (叠加) are both modes of the *same* single
 * section: the write face stores the word, and `mergeLayers` resolves it
 * (`core/overrides.js`, Revision 36). `hide` stays refused — the panel has no
 * control for it, and a section the user is typing into is not one they mean to
 * remove; a hand-edited `hide` keeps working in assembly (Revision 35).
 */
export const RESERVED_WRITABLE_ACTIONS = Object.freeze(['replace', 'append']);

/**
 * Enforce the write lock for `PUT /prompt-setting/overrides`.
 *
 * Two independent rules, checked in this order and **before anything else the
 * route does** — before the target layer is resolved, before the current config
 * is read, and therefore before any byte could be written:
 *
 * 1. a name that is a non-empty string other than the reserved one is
 *    `403 write-locked`. This is a wall, not a validation error: the name is
 *    perfectly legal, this route simply may not write it any more;
 * 2. the reserved name accepts exactly the actions of
 *    {@link RESERVED_WRITABLE_ACTIONS} — `replace` (Revision 7) and, since
 *    Revision 36, `append`. Anything else, **including an absent or unknown
 *    action**, is `400 unsupported-action`. The action is therefore not
 *    validated by `validateOverride` on this route: `unsupported-action` is the
 *    one code the write face answers for it, which is what makes the narrowing a
 *    two-code policy rather than a soup of field-level errors. (`unknown-action`,
 *    `unexpected-text` and `invalid-order` stay reachable exactly where they
 *    belong — in `validateOverride`, pinned by `test/overrides.test.mjs`;
 *    `missing-text` and `text-too-large` stay reachable through this route too,
 *    because they are about the fields both writing actions use.)
 *
 * Revision 36 adds one more rule for the reserved name alone, after the two
 * above: an `order` field is `400 unexpected-order`. For every other section
 * `order` is *what `append` means* — where to insert the new section — but on
 * the reserved name `append` means「stack after the other layer」, which has no
 * index. Refusing the field here is what keeps a meaningless value out of the
 * stored file instead of persisting one the merge kernel would then drop.
 *
 * A request with no usable `name` at all is *not* a policy question: it is a
 * malformed override, and it is left to `validateOverride` so it still answers
 * `400 missing-name`. A non-string `name` (a number, an object) takes the same
 * path.
 * @param section - the `section` field of the PUT body.
 * @throws {OverrideError} 403 `write-locked`, 400 `unsupported-action`, or 400
 *   `unexpected-order`.
 */
export function assertWritableSection(section) {
  const name = section?.name;
  if (typeof name === 'string' && name.length > 0 && !isCustomSectionName(name)) {
    throw fail(
      'write-locked',
      `${JSON.stringify(name)} is frozen read-only: ${JSON.stringify(CUSTOM_SECTION_NAME)} is the only section this route may write`,
      403,
    );
  }
  if (!isCustomSectionName(name)) return;
  if (!RESERVED_WRITABLE_ACTIONS.includes(section?.action)) {
    throw fail(
      'unsupported-action',
      `${JSON.stringify(CUSTOM_SECTION_NAME)} accepts only the `
      + `${RESERVED_WRITABLE_ACTIONS.map((action) => JSON.stringify(action)).join(' and ')} actions, not `
      + `${section?.action === undefined ? 'an absent action' : JSON.stringify(section.action)}`,
    );
  }
  if (section?.order !== undefined && section?.order !== null) {
    throw fail(
      'unexpected-order',
      `${JSON.stringify(CUSTOM_SECTION_NAME)} must not carry "order": its "append" stacks after the other layer, it does not name a position`,
    );
  }
}

/**
 * Enforce the write lock for the single-name form of
 * `DELETE /prompt-setting/overrides`.
 *
 * A non-reserved name is `403 write-locked`. The check runs **before** the
 * `404 override-not-found` lookup, so "this name is frozen" is never reported
 * as "no such override" — those are different facts and only one of them is
 * true.
 *
 * It is evaluated after the request's own shape checks (`missing-name`,
 * `name-too-long`), which answer `400` for a name this route could not act on
 * under any policy.
 * @param name - the `?name=` value.
 * @throws {OverrideError} 403 `write-locked`.
 */
export function assertDeletableName(name) {
  if (typeof name === 'string' && name.length > 0 && !isCustomSectionName(name)) {
    throw fail(
      'write-locked',
      `${JSON.stringify(name)} is frozen read-only: ${JSON.stringify(CUSTOM_SECTION_NAME)} is the only section this route may delete`,
      403,
    );
  }
}

/**
 * Split one layer's overrides for `DELETE /prompt-setting/overrides&legacy=true`.
 *
 * `legacy=true` is the one write that still touches legacy entries, and it only
 * ever *removes* them: the reserved override survives, the layer's own
 * `enabled`/`version` shape is untouched, and the surviving list keeps file
 * order. The optional `flag` carries the layer's config-level interpolation
 * switch (Revision 9) across the rebuild; a caller that omits it gets the
 * pre-Revision-9 shape, byte for byte.
 * @param overrides - the layer's current override list.
 * @param flag - the layer's `interpolateCustom` value, when it states one.
 * @returns `{kept, removed, next}` where `next` is the config to write (or to
 *   discard when `removed` is empty — a no-op must not touch the file).
 */
export function legacyPlan(overrides, flag) {
  const all = listOf(overrides);
  const removed = all.filter((entry) => !isCustomSectionName(entry?.name));
  const kept = all.filter((entry) => isCustomSectionName(entry?.name));
  return { kept, removed, next: withInterpolate({ version: CONFIG_VERSION, overrides: kept }, flag) };
}

/**
 * Keep only the reserved override of one export layer.
 * @param overrides - a layer view's `overrides`.
 * @returns a fresh array holding at most the reserved entry.
 */
export function customOverridesOnly(overrides) {
  return listOf(overrides).filter((entry) => isCustomSectionName(entry?.name));
}

/**
 * Declare the scope of an export: what it carried, and what it left behind.
 *
 * A narrowed export **must not silently drop** legacy entries — a user who
 * exports as a backup and re-imports must be able to tell that the file is not
 * the whole configuration. The counts are computed from the layer views this
 * process could read, so a layer whose config is unusable reports its `reason`
 * and contributes `0` (its overrides are unknown, not zero).
 * @param views - `{layer: view}` where a view carries `overrides`.
 * @param layerNames - the layers this export covers, in order.
 * @returns `{only, omitted}` with `omitted.total` summed over the layers.
 */
export function exportScope(views, layerNames) {
  const omitted = {};
  let total = 0;
  for (const name of layerNames) {
    const list = listOf(views?.[name]?.overrides);
    const count = list.filter((entry) => !isCustomSectionName(entry?.name)).length;
    omitted[name] = count;
    total += count;
  }
  omitted.total = total;
  return { only: CUSTOM_SECTION_NAME, omitted };
}

/**
 * Enforce the write lock for `POST /prompt-setting/import`.
 *
 * The document is checked as a whole, **before** any layer is resolved and
 * before the dry-run branch: a document that carries any legacy entry is
 * refused with `403 write-locked` under both `?dryRun=true` and a real import,
 * so the dry run answers the same question the real run would answer and no
 * file is touched by either.
 *
 * The check is on **names only**. That is the security boundary this revision
 * draws: an import may not create, resurrect or modify a frozen override. The
 * *action* of a reserved-name entry is taken from the document as it stands, so
 * a document that (say) hides the reserved section still round-trips — the
 * export of such a hand-edited config re-imports unchanged.
 * @param document - the parsed export document.
 * @throws {OverrideError} 403 `write-locked` naming the offending sections.
 */
export function assertImportableDocument(document) {
  const layers = document?.layers;
  if (layers === null || typeof layers !== 'object') return;
  const offenders = [];
  for (const [layer, list] of Object.entries(layers)) {
    for (const entry of listOf(list)) {
      if (!isCustomSectionName(entry?.name)) offenders.push(`${layer}:${entry?.name}`);
    }
  }
  if (offenders.length === 0) return;
  throw fail(
    'write-locked',
    `this document carries ${offenders.length} frozen section(s) `
    + `(${nameList(offenders)}); only ${JSON.stringify(CUSTOM_SECTION_NAME)} may be imported`,
    403,
  );
}

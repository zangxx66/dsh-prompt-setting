/**
 * The interpolation switch for the reserved section (Revision 9).
 *
 * g-014 registered「我的 Prompt」with `interpolate: false` as a safety gate: the
 * shipped renderer **throws** on a reference it cannot resolve, and a user's
 * text is arbitrary, so one stray `{{typo}}` would break every later assembly of
 * that session. Revision 9 lets the user open that gate deliberately — and pays
 * for it with the second half of this module: a validator that answers the one
 * question the gate exists for, *"would this text make the real assembly
 * throw?"*, with the shipped renderer's own grammar.
 *
 * Pure, like `core/overrides.js`: no `fs`, no `ctx`, no clock. The Host process
 * can only be exercised by restarting `dsh web`, so the safety decision lives
 * here where `node --test` pins it down offline.
 *
 * Vocabulary
 * - *flag*: the config-level boolean `interpolateCustom`. **Absent means OFF**,
 *   and absent is the only value a config written before this revision has.
 * - *reference*: one `{{...}}` group in section text.
 * - *fatal* (`errors`): a reference the shipped renderer throws on. Writing it
 *   is refused.
 * - *warning*: a reference that is well-formed and registered but whose value
 *   is `undefined` in the probed assembly. The shipped renderer would throw on
 *   it **for that assembly**, but the value is a property of the session, not of
 *   the text: a probe with no active agent leaves agent-scoped providers
 *   valueless, and refusing the save would make the switch unusable whenever no
 *   session is running. Reported, never silently dropped (see CONTRACT §16.3).
 * - *state*: the switch's three-valued form (Revision 12, §16.8) — `inherit`
 *   (the key is absent), `on` (`true`), `off` (`false`). The two-valued
 *   `boolean` form is the legacy spelling of `on`/`inherit`.
 *
 * Revision 14 (the third independent audit's E1) makes the **assembly** verdict
 * strict: {@link interpolateHoldReason} no longer asks "is this text *fatal*?"
 * (the write-face reading, where an `undefined` value is a warning) but "would
 * this assembly throw?" — the same four conditions, `undefined` included. The
 * write face keeps the softer reading on purpose: the probe table is not the
 * session's table, so refusing a save for a value the *session* owns would make
 * the switch unusable whenever nothing is running (CONTRACT §16.3).
 *
 * Revision 12 (the independent audit's F1/F2/F4) changed three things here and
 * nothing about the validator's strictness:
 * - {@link anyStatesOn} supplies the cross-layer half of the F1 verdict. The
 *   verdict itself belongs to the text, not to the write target: `index.js`
 *   asks, per text, whether it can reach an assembly that interpolates. For the
 *   **user** text — merged into every session that has no workspace entry of its
 *   own — that question reduces to "does the user layer or any visible workspace
 *   layer state ON", which is exactly this predicate (§16.4);
 * - {@link describeWarnings} gives the previously discarded `warnings` a shape
 *   the route can put on the wire and the browser can render (§16.3);
 * - {@link withState} / {@link switchStateOf} add the explicit-OFF write that
 *   {@link withoutSwitch} cannot express (§16.8).
 *
 * @module dsh-prompt-setting/core/interpolate
 */

import { CUSTOM_SECTION_NAME } from './custom.js';
import {
  INTERPOLATE_FLAG,
  VARIABLE_GROUP,
  VARIABLE_NAME,
  fail,
  interpolateFlagOf,
  withInterpolate,
} from './overrides.js';

/**
 * The one error code a write is refused with when its text would throw
 * (Revision 9). Stable and machine-readable: the browser maps it to copy that
 * names the offending reference and the way out.
 */
export const UNRESOLVABLE_VARIABLE = 'unresolvable-variable';

/**
 * Decide the switch's effective value for one assembly context.
 *
 * Workspace wins over user on *statedness*, exactly like {@link mergeLayers}
 * merges the switch: an unstated workspace layer inherits the user layer, and
 * two unstated layers are OFF.
 * @param userConfig - the validated user layer, or null.
 * @param workspaceConfig - the validated workspace layer, or null.
 * @returns whether「我的 Prompt」participates in interpolation.
 */
export function effectiveInterpolate(userConfig, workspaceConfig) {
  return (interpolateFlagOf(workspaceConfig) ?? interpolateFlagOf(userConfig) ?? false) === true;
}

/**
 * The stored「我的 Prompt」text of one layer config, or null.
 *
 * A `hide` entry carries no text and takes the section out of the prompt
 * entirely, so it cannot throw and is not validated.
 * @param config - a validated layer config, or anything else.
 * @returns the text, or null when the layer stores none.
 */
export function customTextOf(config) {
  const list = Array.isArray(config?.overrides) ? config.overrides : [];
  const entry = list.find((item) => item?.name === CUSTOM_SECTION_NAME);
  if (entry === undefined || entry === null) return null;
  if (entry.action === 'hide') return null;
  return typeof entry.text === 'string' ? entry.text : null;
}

/**
 * Walk every reference in `text` in the shipped renderer's own scan order.
 *
 * This is a line-by-line transcription of `interpolate()` in
 * `@deepseek-ai/dsh-system-prompt` (`lib/index.js`): the same `{{` search, the
 * same `GROUP_AT` at the scan position, the same "a lone `{{` with no later
 * `}}` is prose" rule, and the same "substituted values are not scanned again"
 * property (which holds here for free, because only the INPUT is walked).
 *
 * The difference is that the shipped function throws on the first fault while
 * this one reports every fault and keeps scanning, so a caller can show the
 * whole picture. "Which reference throws first" is still well defined: events
 * arrive in increasing `at` order, so the first one is the one the renderer
 * would have thrown on. Continuing is safe precisely because the scan cursor is
 * advanced exactly as the shipped one advances it.
 *
 * It deliberately does **not** reuse the `group === null` branch of
 * `renderSections`/`collectUnresolved` in `core/overrides.js`: that branch
 * treats every non-matching `{{` as prose, which is right for a read-only
 * preview and **wrong** as a safety gate — it classifies `{{ lone {{c}}` and
 * `{{{{model}}}}` as safe, and the shipped renderer throws on both.
 *
 * `assumeUnknown` decides what a **missing** variable table means. The load
 * path must not degrade a layer because one probe failed, so it reads a missing
 * table as "cannot check names" and only reports grammar faults; the write path
 * must not accept a reference it cannot prove safe, so it reads the same missing
 * table as "every name is unknown" and refuses (fail closed).
 * @param text - the section text (any value; non-strings scan as empty).
 * @param variables - the assembled variable table, or null when unavailable.
 * @param assumeUnknown - treat every reference as unregistered when the table
 *   is null.
 * @param visit - called once per reference, in scan order.
 * @returns nothing.
 */
function classifyReferences(text, variables, assumeUnknown, visit) {
  const source = typeof text === 'string' ? text : '';
  const table = variables !== null && typeof variables === 'object' ? variables : null;
  let cursor = 0;
  for (let open = source.indexOf('{{'); open >= 0; open = source.indexOf('{{', cursor)) {
    const group = VARIABLE_GROUP.exec(source.slice(open));
    if (group === null) {
      // No complete group at this position. The shipped renderer throws when
      // ANY `}}` follows, because that is a reference it cannot parse; with no
      // later `}}` the two braces are prose and the cursor moves past them.
      if (source.indexOf('}}', open + 2) >= 0) visit({ kind: 'malformed', name: null, at: open });
      cursor = open + 2;
      continue;
    }
    const name = group[0].slice(2, -2);
    if (!VARIABLE_NAME.test(name)) {
      visit({ kind: 'invalid-name', name, at: open });
    } else if (table === null) {
      if (assumeUnknown) visit({ kind: 'unknown', name, at: open });
    } else if (!Object.hasOwn(table, name)) {
      visit({ kind: 'unknown', name, at: open });
    } else if (table[name] === undefined) {
      visit({ kind: 'undefined-value', name, at: open });
    }
    cursor = open + group[0].length;
  }
}

/**
 * Walk every reference in `text`, reporting grammar faults only.
 * @param text - the section text.
 * @param variables - the assembled variable table, or null.
 * @param visit - called once per reference, in scan order.
 * @returns nothing.
 */
export function walkReferences(text, variables, visit) {
  classifyReferences(text, variables, false, visit);
}

/**
 * Classify every reference in `text` by what the shipped renderer would do.
 * @param text - the section text.
 * @param variables - the assembled variable table, or null when unavailable.
 * @param options.assumeUnknown - treat every reference as unregistered when the
 *   table is null (the write path's fail-closed reading).
 * @returns `{errors, warnings}`: `errors` are the references a write is refused
 *   for (malformed group, illegal name, unregistered name, unknown table);
 *   `warnings` are the registered-but-currently-`undefined` ones.
 */
export function lintPromptText(text, variables, options = {}) {
  const errors = [];
  const warnings = [];
  classifyReferences(text, variables, options?.assumeUnknown === true, (event) => {
    if (event.kind === 'undefined-value') warnings.push(event);
    else errors.push(event);
  });
  return { errors, warnings };
}

/**
 * The first reference the shipped `interpolate()` would throw on, or null.
 *
 * This is the **strict** verdict: all four throw conditions count, `undefined`
 * included, and a missing table counts as "unknown". It is what a test pins the
 * transcription against — the refusal policy below deliberately softens only
 * the `undefined` case.
 * @param text - the section text.
 * @param variables - the assembled variable table, or null when unavailable.
 * @returns the first faulting event, or null when the text renders.
 */
export function scanThrowingReference(text, variables) {
  let first = null;
  classifyReferences(text, variables, true, (event) => {
    if (first === null) first = event;
  });
  return first;
}

/** One-line, bounded rendering of a faulting reference. */
function describeReference(event) {
  if (event.kind === 'malformed') return 'a malformed `{{…}}` group';
  return `\`{{${String(event.name)}}}\``;
}

/** One-line, bounded reading of the assembled variable names. */
function describeKnown(variableNames) {
  const names = Array.isArray(variableNames) ? variableNames : [];
  if (names.length === 0) return '(none)';
  const shown = names.slice(0, 8).join(', ');
  return names.length > 8 ? `${shown}, … (${names.length} total)` : shown;
}

/**
 * Build the rejection message for a text that would throw.
 *
 * Bounded on purpose: it goes back to a browser and into a config's `reason`,
 * so it names at most a few references and always states the way out.
 * @param errors - the fatal events from {@link lintPromptText}.
 * @param owner - what the text belongs to, e.g. `the user layer`.
 * @param variableNames - the assembled variable names, for the "use one of
 *   these" half of the fix.
 * @returns the message.
 */
export function describeInterpolateErrors(errors, owner, variableNames) {
  const list = Array.isArray(errors) ? errors : [];
  const shown = list.slice(0, 3).map(describeReference).join(', ');
  const rest = list.length - Math.min(list.length, 3);
  const reasons = [...new Set(list.map((event) => event.kind))].join('/');
  return `${owner} contains ${list.length} prompt reference(s) that would make every assembly of the session throw `
    + `(${shown}${rest > 0 ? ` and ${rest} more` : ''}; ${reasons}). `
    + 'Fix: delete the reference, or use a registered variable '
    + `(${describeKnown(variableNames)}), or save with variable substitution OFF.`;
}

/**
 * Turn the non-fatal advisory events into a bounded, wire-safe list.
 *
 * One entry per reference, in scan order, capped like the refusal message so a
 * pathological text cannot turn a response into a data dump. The `message` is
 * prose the browser may show verbatim; `name` and `kind` are for the copy the
 * page builds itself (Revision 12, audit F2 — CONTRACT §16.3).
 * @param warnings - the `undefined-value` events from {@link lintPromptText}.
 * @param owner - what the text belongs to.
 * @returns `[{name, kind, code, message}]`.
 */
export function describeWarnings(warnings, owner) {
  const list = Array.isArray(warnings) ? warnings : [];
  return list.slice(0, 3).map((event) => ({
    name: event.name === null || event.name === undefined ? null : String(event.name),
    kind: event.kind,
    code: 'unresolved-at-save',
    message: `${owner} references \`{{${String(event.name)}}}\`, which is registered but has no value in the `
      + 'assembly this process probed. The save was accepted because the value belongs to the session, not to the '
      + 'text — but a turn without that value will fail to assemble.',
  }));
}

/**
 * Refuse a text the shipped renderer would throw on, and report the rest.
 *
 * Only the fatal class is refused. An `undefined` value is a property of the
 * assembly that was probed, not of the text, so it is reported to the caller as
 * a warning and the write proceeds (CONTRACT §16.3).
 *
 * Revision 12 (audit F2): the warnings are **returned**, not dropped. The route
 * puts them in the write/enable response and the browser renders them, because
 * "accepted but this one reference has no value in the probed assembly" is a
 * fact the user cannot discover any other way.
 * @param text - the section text about to be written.
 * @param variables - the assembled variable table.
 * @param owner - what the text belongs to (goes into the message).
 * @returns `{warnings}` — the advisory events (never fatal, possibly empty).
 * @throws {OverrideError} `400 unresolvable-variable`.
 */
export function assertInterpolatable(text, variables, owner) {
  const { errors, warnings } = lintPromptText(text, variables, { assumeUnknown: true });
  if (errors.length === 0) return { warnings: describeWarnings(warnings, owner) };
  const names = variables !== null && typeof variables === 'object' ? Object.keys(variables) : [];
  throw fail(UNRESOLVABLE_VARIABLE, describeInterpolateErrors(errors, owner, names), 400);
}

/**
 * Self-check one layer's stored config against its own switch.
 *
 * Called on the load path, where the shipped `missing-file` precedent applies:
 * a layer that would break the assembly is **degraded with a reason**, never
 * silently accepted and never escalated into "the whole file is invalid". The
 * switch itself is a config field, so a layer that states OFF is untouched by
 * construction.
 * @param config - the validated layer config.
 * @param variables - the assembled variable table, or null when unavailable.
 * @param owner - what the text belongs to (goes into the message).
 * @returns `{flag, error}` where `error` is `{code, message}|null`.
 */
export function selfCheckConfig(config, variables, owner) {
  const flag = interpolateFlagOf(config);
  if (flag !== true) return { flag, error: null };
  const text = customTextOf(config);
  if (text === null) return { flag, error: null };
  const { errors } = lintPromptText(text, variables);
  if (errors.length === 0) return { flag, error: null };
  return { flag, error: { code: UNRESOLVABLE_VARIABLE, message: describeLayerDisabled(errors, variables, owner) } };
}

/**
 * The load-time degradation reason for one layer (Revision 12 keeps this text
 * in one place: the per-layer self-check and the cross-layer pass that F1 adds
 * must word the same verdict the same way).
 * @param errors - the fatal events from {@link lintPromptText}.
 * @param variables - the assembled variable table, or null.
 * @param owner - what the text belongs to.
 * @returns the `reason` string stored on the degraded layer.
 */
export function describeLayerDisabled(errors, variables, owner) {
  const names = variables !== null && typeof variables === 'object' ? Object.keys(variables) : [];
  return `${describeInterpolateErrors(errors, owner, names)} `
    + 'The layer was disabled so the real assembly keeps working.';
}

/**
 * Why **this assembly** must render the reserved section literally, or null.
 *
 * The load-time self-check is only as good as the variable table it holds, and
 * the table arrives one HTTP request late (`state.variables` is filled by
 * `ensureVariables()` at the top of the route handler). Between `mount` and that
 * request a layer that states ON and carries `{{nope}}` therefore passes the
 * name half of the check, and the first real turn of any session using it takes
 * the whole prompt down (audit D2). The assembly, however, always carries the
 * table it is about to render with (`assembly.variables`), so the verdict does
 * not have to be guessed: it is taken from the very data the renderer will use —
 * one source of truth, never a cached reading of it.
 *
 * Fail closed, twice over:
 * - a table that is **not available** plus any `{{` in the text is *unverified*
 *   and is held — never "no table, so grammar is enough";
 * - a table that **is** available is judged with {@link scanThrowingReference},
 *   the strict transcription of the shipped renderer: **all four** throw
 *   conditions, `undefined` included.
 *
 * Revision 14 (audit E1) is the second half of that reading. Revision 13 asked
 * the write face's question here — "is this text *fatal*?" — and `undefined` is
 * not fatal at write time (§16.3, a value the session owns rather than the text
 * does). But the assembly **holds the session's own table**, so for the assembly
 * the honest question is "would *this* turn throw?", and a registered name whose
 * value is `undefined` in this very table throws. Holding it costs one literal
 * turn; not holding it costs the turn outright — `renderPrompt` raises
 * `prompt variable "{{…}}" has no value for this assembly` and the prompt cannot
 * be assembled at all. The write face is untouched by this: a save is still
 * judged with {@link lintPromptText} and an `undefined` value is still a warning.
 * @param text - the「我的 Prompt」text this assembly would render, or null.
 * @param variables - the variable table **of this assembly**.
 * @returns the hold reason, or null when the text may interpolate.
 */
export function interpolateHoldReason(text, variables) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const table = variables !== null && typeof variables === 'object' ? variables : null;
  if (table === null) {
    if (!text.includes('{{')) return null;
    return 'this assembly carries no variable table, so the reserved section could not be verified and variable '
      + 'substitution was held back for this turn (the text is rendered literally)';
  }
  const first = scanThrowingReference(text, table);
  if (first === null) return null;
  return describeHold(first);
}

/**
 * One-line, bounded reason for the first reference this assembly cannot render.
 *
 * Split by kind because the fix differs: an `undefined` value is a *value* the
 * session lacks (the name is right), while an unknown/illegal/malformed
 * reference is a *text* fault. Both are "held back", and both say so — the
 * wording is what the browser shows next to the text box.
 * @param event - the first faulting event from {@link scanThrowingReference}.
 * @returns the reason string.
 */
function describeHold(event) {
  if (event.kind === 'malformed') {
    return 'the reserved section contains a malformed `{{…}}` group that this assembly cannot resolve, so variable '
      + 'substitution was held back for this turn instead of failing the prompt (the text is rendered literally)';
  }
  if (event.kind === 'undefined-value') {
    return `the reserved section references \`{{${String(event.name)}}}\`, which has no value in this assembly, so `
      + 'variable substitution was held back for this turn instead of failing the prompt (the text is rendered literally)';
  }
  return `the reserved section references \`{{${String(event.name)}}}\`, which this assembly cannot resolve, so `
    + 'variable substitution was held back for this turn instead of failing the prompt (the text is rendered literally)';
}

/**
 * State the switch on a rebuilt config, dropping the field when it is OFF.
 *
 * "OFF" is written as the **absence** of the key, so a layer that never turned
 * the switch on keeps a config byte-identical to the one an earlier revision
 * wrote.
 * @param config - the config to write.
 * @param enabled - the requested value.
 * @returns the config to persist.
 */
export function withSwitch(config, enabled) {
  return enabled === true ? withInterpolate(config, true) : withoutSwitch(config);
}

/**
 * Remove the switch field from a config, leaving every other key alone.
 * @param config - the config to rewrite.
 * @returns a fresh config without {@link INTERPOLATE_FLAG}.
 */
export function withoutSwitch(config) {
  const next = { ...config };
  delete next[INTERPOLATE_FLAG];
  return next;
}

/**
 * The switch's three states, in the order the browser offers them
 * (Revision 12, audit F4 — CONTRACT §16.8).
 */
export const INTERPOLATE_STATES = Object.freeze(['inherit', 'on', 'off']);

/**
 * Read one config's three-valued switch state.
 *
 * The three states are not decoration: with only two, a workspace layer cannot
 * express「explicitly OFF」and therefore cannot close a switch the user layer
 * opened — the UI would show OFF while the session really inherits ON.
 * @param config - a validated config, or anything else.
 * @returns `inherit` (no key), `on` (`true`) or `off` (`false`).
 */
export function switchStateOf(config) {
  const flag = interpolateFlagOf(config);
  if (flag === undefined) return 'inherit';
  return flag === true ? 'on' : 'off';
}

/**
 * State one of the three switch values on a rebuilt config.
 *
 * `inherit` **deletes** the key, which is what keeps the legacy revert exact: a
 * layer that never declared the switch is byte-identical after on→off. `off`
 * writes the boolean `false`, which `withSwitch` deliberately cannot express —
 * that is the whole point of Revision 12's F4.
 * @param config - the config to write.
 * @param state - `inherit` | `on` | `off`.
 * @returns the config to persist.
 */
export function withState(config, state) {
  if (state === 'on') return withInterpolate(config, true);
  if (state === 'off') return withInterpolate(config, false);
  return withoutSwitch(config);
}

/**
 * The F1 verdict: does **any** visible layer state the switch on?
 *
 * Revision 12 replaces the old per-layer question ("does the layer being
 * written interpolate?") with this one. The old question had a pure-UI bypass:
 * a text could be stored into a layer that was closed *at that moment* and then
 * be armed later by a flag on another layer, and the write that armed it only
 * checked its own layer. Since the user layer is merged into every session and a
 * workspace layer can be armed by the user layer's flag, the honest reading of
 * "could this text make a real assembly throw?" is the union over the layers,
 * not the write target.
 *
 * Deliberately conservative: a layer that explicitly states OFF is still
 * checked, because over-refusing is explainable and repairable while a missed
 * unregistered reference is a session whose prompt cannot be built at all
 * (CONTRACT §16.4).
 * @param configs - the visible layer configs (any values).
 * @returns whether at least one of them states `true`.
 */
export function anyStatesOn(configs) {
  const list = Array.isArray(configs) ? configs : [];
  return list.some((config) => interpolateFlagOf(config) === true);
}

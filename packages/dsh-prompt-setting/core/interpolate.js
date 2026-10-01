/**
 * The variable-substitution switch for the reserved section (Revision 15).
 *
 * g-014 registered「我的 Prompt」with `interpolate: false` as a safety gate: the
 * shipped renderer **throws** on a reference it cannot resolve, and a user's
 * text is arbitrary, so one stray `{{typo}}` would break every later assembly of
 * that session.
 *
 * Revision 15 (the final rework, design A) stops trying to *earn* the right to
 * interpolate and removes the failure mode structurally instead:
 *
 * 1. the reserved section stays `interpolate: false` **forever** — as registered
 *    and at every assembly. DSH's strict interpolator therefore never touches
 *    it, so "an unknown/valueless variable throws every turn" cannot happen;
 * 2. the switch means「this plugin expands the text itself」. With it ON,
 *    `index.js` substitutes `{{name}}` in the reserved section's text during the
 *    assembly, from the variable table **that assembly carries**
 *    (`downstream.variables ?? assembly.variables`);
 * 3. the expansion is **lenient**: a registered name with a value becomes
 *    `String(value)`; an unregistered name, an `undefined` value or a malformed
 *    group stays **literal** — never a throw, never a bare `undefined`;
 * 4. the expansion happens after `applyOverrides` inside `assembleHandler` and
 *    depends on nothing about listener position. Even if a later (outer)
 *    listener rewrites the sections afterwards, the worst case is "this turn was
 *    not expanded" — the user sees the literal braces — and never a failed turn.
 *
 * The consequence recorded in CONTRACT §16.9: the write-face validator below is
 * no longer a safety requirement. It is kept **unchanged in what it refuses**
 * (unregistered/illegal/malformed ⇒ `400 unresolvable-variable`; registered but
 * currently valueless ⇒ a warning) purely as UX — it stops a user from saving
 * text that would never expand — and its messages say that, not "every turn
 * throws".
 *
 * Pure, like `core/overrides.js`: no `fs`, no `ctx`, no clock. The Host process
 * can only be exercised by restarting `dsh web`, so every decision here is
 * pinned down offline by `node --test`.
 *
 * Vocabulary
 * - *flag*: the config-level boolean `interpolateCustom`. **Absent means OFF**,
 *   and absent is the only value a config written before this revision has.
 * - *reference*: one `{{...}}` group in section text.
 * - *fatal* (`errors`): a reference the write face refuses. Under the shipped
 *   grammar these are exactly the references that would make a **strictly
 *   interpolated** section throw; here they only mark text that will never
 *   expand.
 * - *warning*: a reference that is well-formed and registered but whose value
 *   is `undefined` in the probed assembly. The value is a property of the
 *   session, not of the text: a probe with no active agent leaves agent-scoped
 *   providers valueless, and refusing the save would make the switch unusable
 *   whenever no session is running. Reported, never silently dropped (§16.3).
 * - *state*: the switch's three-valued form (Revision 12, §16.8) — `inherit`
 *   (the key is absent), `on` (`true`), `off` (`false`). The two-valued
 *   `boolean` form is the legacy spelling of `on`/`inherit`.
 *
 * Revision 12 (the independent audit's F1/F2/F4) still owns three shapes here:
 * - {@link anyStatesOn} supplies the cross-layer half of the F1 verdict. The
 *   verdict itself belongs to the text, not to the write target: `index.js`
 *   asks, per text, whether it can reach an assembly whose switch is ON. For the
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
 * @returns whether the plugin expands「我的 Prompt」itself for this assembly.
 */
export function effectiveInterpolate(userConfig, workspaceConfig) {
  return (interpolateFlagOf(workspaceConfig) ?? interpolateFlagOf(userConfig) ?? false) === true;
}

/**
 * The stored「我的 Prompt」text of one layer config, or null.
 *
 * A `hide` entry carries no text and takes the section out of the prompt
 * entirely, so there is nothing left to check or to expand.
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
 * preview and **wrong** for a write-face gate — it classifies `{{ lone {{c}}`
 * and `{{{{model}}}}` as safe, and the shipped renderer throws on both.
 *
 * `assumeUnknown` decides what a **missing** variable table means. The
 * write face must not accept a reference it cannot prove will expand, so it
 * reads a missing table as "every name is unknown" and refuses (fail closed);
 * with a table present, only grammar faults are reported.
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
 * included, and a missing table counts as "unknown". Revision 15 no longer uses
 * it on any decision path — the reserved section never interpolates — so it now
 * serves one purpose only: it is the oracle a test pins the transcription
 * against, so "we still know exactly what the shipped renderer would do" stays
 * measurable even though nothing depends on it any more.
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

/**
 * Expand the reserved section's text the way the **plugin** promises to
 * (Revision 15, design A) — the lenient half of the switch.
 *
 * Same scan as the shipped `interpolate()` (the `{{` search, `VARIABLE_GROUP`
 * at the scan position, the "lone `{{` with no later `}}` is prose" rule, and
 * "a substituted value is never scanned again" — the last one holds for free
 * because only the INPUT is walked), and deliberately **not** a transcription
 * of its failure behaviour:
 *
 * - a name that is registered **and** has a value (`undefined` excluded) is
 *   replaced with `String(value)`, so `{{n: 0}}` renders `0` exactly as the
 *   shipped renderer does;
 * - an unregistered name, an `undefined` value and a malformed group are all
 *   left **literal**. The shipped renderer throws on each of them; this function
 *   cannot throw at all, and it never puts a bare `undefined` into the prompt.
 *
 * That difference is the whole point of the design (CONTRACT §16.9): the
 * section is registered `interpolate: false` and stays that way, so the strict
 * interpolator never sees this text, and the worst outcome of the lenient
 * reading is "this reference was not expanded" — never a failed assembly.
 * @param text - the reserved section's text (non-strings expand to nothing).
 * @param variables - the variable table this assembly carries, or null.
 * @returns the text with every resolvable reference substituted.
 */
export function expandPromptText(text, variables) {
  const source = typeof text === 'string' ? text : '';
  const table = variables !== null && typeof variables === 'object' ? variables : null;
  let result = '';
  let cursor = 0;
  for (let open = source.indexOf('{{'); open >= 0; open = source.indexOf('{{', cursor)) {
    const group = VARIABLE_GROUP.exec(source.slice(open));
    if (group === null) {
      // No complete group at this position: prose (the shipped renderer throws
      // here only when a later `}}` makes it a malformed reference, and a
      // lenient expansion simply leaves it alone).
      result += source.slice(cursor, open + 2);
      cursor = open + 2;
      continue;
    }
    const name = group[0].slice(2, -2);
    const value = table !== null && VARIABLE_NAME.test(name) && Object.hasOwn(table, name) ? table[name] : undefined;
    if (value === undefined) {
      result += source.slice(cursor, open + group[0].length);
      cursor = open + group[0].length;
      continue;
    }
    result += source.slice(cursor, open) + String(value);
    cursor = open + group[0].length;
  }
  return result + source.slice(cursor);
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
 * Build the rejection message for a text the write face refuses.
 *
 * Bounded on purpose: it goes back to a browser and into a config's `reason`,
 * so it names at most a few references and always states the way out.
 *
 * Revision 15 (design A) rewrote the reason to say what is actually true. The
 * old wording — "would make every assembly of the session throw" — described
 * the shipped renderer's behaviour on an **interpolating** section, and the
 * reserved section never interpolates. Nothing throws; the reference simply can
 * never expand, so this is a UX refusal, not a safety one (CONTRACT §16.9).
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
  return `${owner} contains ${list.length} prompt reference(s) that variable substitution would never expand `
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
 *
 * Revision 15: the advisory no longer claims a failed assembly. A value the
 * probed assembly lacks only means this reference is left literal for such a
 * turn (the lenient expansion never throws), so the message says that.
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
      + 'text — in a turn that has no value for it, the reference stays literal instead of being substituted.',
  }));
}

/**
 * Refuse a text whose references could never expand, and report the rest.
 *
 * Revision 15 keeps the refusal policy **exactly as it was** (the four shipped
 * throw conditions: malformed group, illegal name, unregistered name, and a
 * missing/unknown table — `undefined` values stay a warning), and keeps it for
 * one reason only: a reference that can never expand is a trap for the user, who
 * would otherwise save text that silently stays literal. It is no longer what
 * keeps a session alive — the reserved section does not interpolate, and the
 * plugin's own expansion is lenient (CONTRACT §16.9).
 *
 * An `undefined` value is a property of the assembly that was probed, not of the
 * text, so it is reported to the caller as a warning and the write proceeds
 * (CONTRACT §16.3).
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

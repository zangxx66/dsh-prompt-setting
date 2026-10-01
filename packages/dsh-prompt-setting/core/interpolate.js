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
 * Refuse a text the shipped renderer would throw on.
 *
 * Only the fatal class is refused. An `undefined` value is a property of the
 * assembly that was probed, not of the text, so it is reported to the caller as
 * a warning and the write proceeds (CONTRACT §16.3).
 * @param text - the section text about to be written.
 * @param variables - the assembled variable table.
 * @param owner - what the text belongs to (goes into the message).
 * @throws {OverrideError} `400 unresolvable-variable`.
 */
export function assertInterpolatable(text, variables, owner) {
  const { errors } = lintPromptText(text, variables, { assumeUnknown: true });
  if (errors.length === 0) return;
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
  const names = variables !== null && typeof variables === 'object' ? Object.keys(variables) : [];
  return {
    flag,
    error: {
      code: UNRESOLVABLE_VARIABLE,
      message: `${describeInterpolateErrors(errors, owner, names)} `
        + 'The layer was disabled so the real assembly keeps working.',
    },
  };
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

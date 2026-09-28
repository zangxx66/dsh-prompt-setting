/**
 * Pure override kernel for `dsh-prompt-setting`.
 *
 * Everything in this module is a pure function over plain data: no `fs`, no
 * `ctx`, no clock, no process state. That is deliberate — the Host process can
 * only be exercised by restarting it, so all of the interesting logic lives
 * here where `node --test` can pin it down directly, and `index.js` stays a
 * thin adapter around these functions.
 *
 * Vocabulary
 * - *section*: one `{name, text, interpolate?}` entry of the pre-waterfall
 *   `PromptAssembly.sections`. The Host service sorts these before the
 *   waterfall, so array ORDER is the canonical order; `order` is never
 *   invented here.
 * - *override*: one `{name, action, text?, order?}` record persisted by the
 *   user, where `action` is `replace` | `hide` | `append`.
 * - *resolved config*: the merged, layer-tagged override list (`mergeLayers`)
 *   that the assembly handler actually applies.
 *
 * @module dsh-prompt-setting/core/overrides
 */

/** The only accepted `action` values, in contract order. */
export const ACTIONS = Object.freeze(['replace', 'hide', 'append']);
/** The only accepted `layer` values. `workspace` wins over `user` on a name clash. */
export const LAYERS = Object.freeze(['user', 'workspace']);
/** Upper bound on an override `name`, in UTF-16 code units. */
export const MAX_NAME_LENGTH = 200;
/** Upper bound on an override `text`, in UTF-8 bytes (200 KiB). */
export const MAX_TEXT_BYTES = 200 * 1024;
/** The persisted config schema version. A different version disables the layer. */
export const CONFIG_VERSION = 1;

/** Rejected in section names: C0/C1 controls, DEL, and the Unicode line separators. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** The prompt-variable grammar the Host renderer interpolates. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;
/** Matches one complete `{{name}}` group at the scan position. */
const VARIABLE_GROUP = /^\{\{([^{}]*)\}\}/;
const encoder = new TextEncoder();

/**
 * A rejected input. Carries the machine-readable `code` and the HTTP `status`
 * the route should answer with, so the route layer never re-derives either.
 */
export class OverrideError extends Error {
  /**
   * @param code - stable machine-readable error code.
   * @param message - human-readable, safe to return to the browser.
   * @param status - the HTTP status this error should answer with.
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'OverrideError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Build an {@link OverrideError}.
 * @param code - stable machine-readable error code.
 * @param message - human-readable message.
 * @param status - HTTP status to answer with.
 * @returns the error, ready to throw.
 */
export function fail(code, message, status = 400) {
  return new OverrideError(code, message, status);
}

/**
 * The empty, valid config — the shape a missing or absent layer resolves to.
 * @returns a fresh empty config.
 */
export function emptyConfig() {
  return { version: CONFIG_VERSION, overrides: [] };
}

/**
 * Normalize and validate one override record (a config-file entry or a `PUT`
 * body's `section`). Unknown extra keys are dropped rather than persisted.
 * @param raw - the candidate record.
 * @returns the normalized `{name, action, text?, order?}`.
 * @throws {OverrideError} with a stable `code` for every rejection.
 */
export function validateOverride(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('invalid-override', 'an override must be a JSON object');
  }
  const name = raw.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw fail('missing-name', 'an override requires a non-empty string "name"');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw fail('name-too-long', `"name" exceeds ${MAX_NAME_LENGTH} characters`);
  }
  if (CONTROL_CHARACTERS.test(name)) {
    throw fail('invalid-name', '"name" must not contain control characters');
  }
  const action = raw.action;
  if (typeof action !== 'string' || !ACTIONS.includes(action)) {
    throw fail('unknown-action', `"action" must be one of ${ACTIONS.join(', ')}`);
  }

  let text;
  if (action === 'hide') {
    if (raw.text !== undefined && raw.text !== null) {
      throw fail('unexpected-text', 'a "hide" override must not carry "text"');
    }
  } else {
    if (typeof raw.text !== 'string') {
      throw fail('missing-text', `a "${action}" override requires a string "text"`);
    }
    if (encoder.encode(raw.text).length > MAX_TEXT_BYTES) {
      throw fail('text-too-large', `"text" exceeds ${MAX_TEXT_BYTES} UTF-8 bytes`, 413);
    }
    text = raw.text;
  }

  let order;
  if (raw.order !== undefined && raw.order !== null) {
    if (action !== 'append') {
      throw fail('unexpected-order', `a "${action}" override must not carry "order"`);
    }
    if (!Number.isInteger(raw.order) || raw.order < 0) {
      throw fail('invalid-order', '"order" must be a non-negative integer (a target index)');
    }
    order = raw.order;
  }

  return {
    name,
    action,
    ...(text === undefined ? {} : { text }),
    ...(order === undefined ? {} : { order }),
  };
}

/**
 * Validate a whole persisted config document.
 * @param raw - the parsed JSON value.
 * @returns the normalized `{version, overrides}`.
 * @throws {OverrideError} when the document is not a valid config.
 */
export function validateConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('invalid-config', 'a config file must contain a JSON object');
  }
  if (raw.version !== undefined && raw.version !== CONFIG_VERSION) {
    throw fail('unsupported-version', `unsupported config version ${JSON.stringify(raw.version)}`);
  }
  if (raw.overrides === undefined) return emptyConfig();
  if (!Array.isArray(raw.overrides)) {
    throw fail('invalid-config', '"overrides" must be an array');
  }
  const seen = new Set();
  const overrides = raw.overrides.map((entry) => {
    const override = validateOverride(entry);
    if (seen.has(override.name)) {
      throw fail('duplicate-name', `duplicate override for section ${JSON.stringify(override.name)}`);
    }
    seen.add(override.name);
    return override;
  });
  return { version: CONFIG_VERSION, overrides };
}

/**
 * Merge the two layers into the list the assembly handler applies.
 *
 * Precedence: a workspace override wins over a user override for the same
 * section name and keeps the user entry's position, so a layer switch never
 * reshuffles the list. Workspace-only entries are appended in file order.
 * @param userConfig - the user layer (already validated), or null.
 * @param workspaceConfig - the workspace layer (already validated), or null.
 * @returns `{version, overrides}` where every entry carries its `layer`.
 */
export function mergeLayers(userConfig, workspaceConfig) {
  const merged = toOverrides(userConfig, 'user');
  const workspace = toOverrides(workspaceConfig, 'workspace');
  for (const override of workspace) {
    const at = merged.findIndex((entry) => entry.name === override.name);
    if (at === -1) merged.push(override);
    else merged[at] = override;
  }
  return { version: CONFIG_VERSION, overrides: merged };
}

/**
 * Tag one layer's validated overrides with their layer name.
 * @param config - the validated layer config, or null.
 * @param layer - the layer name to tag with.
 * @returns the layer-tagged override list (a fresh array).
 */
function toOverrides(config, layer) {
  const list = Array.isArray(config?.overrides) ? config.overrides : [];
  return list.map((override) => ({ ...override, layer }));
}

/**
 * Compare two section lists by name, text and interpolation flag.
 * @param left - first list.
 * @param right - second list.
 * @returns whether the two lists render identically.
 */
export function sameSections(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index]?.name !== b[index]?.name) return false;
    if (a[index]?.text !== b[index]?.text) return false;
    if ((a[index]?.interpolate === false) !== (b[index]?.interpolate === false)) return false;
  }
  return true;
}

/**
 * Apply the resolved override list to a section list.
 *
 * Returns the INPUT array by identity when nothing changed, which is what lets
 * the assembly handler hand the untouched assembly straight back (the
 * "no overrides ⇒ byte-identical assembly" guarantee).
 *
 * Per-action semantics:
 * - `replace` rewrites the matching section's text in place; a name that is
 *   not registered is reported as `section-not-present` and changes nothing.
 * - `hide` removes the matching section; likewise skipped when absent.
 * - `append` inserts `{name, text}` at `order` (a target index, clamped to
 *   `[0, length]`) or at the end when `order` is absent. An `append` whose
 *   name is already registered is reported as `name-already-present` and
 *   changes nothing, because two sections may not share a name.
 * @param sections - the pre-waterfall section list.
 * @param resolved - the merged override list from {@link mergeLayers}.
 * @returns `{sections, changed, report}`.
 */
export function applyOverrides(sections, resolved) {
  const input = Array.isArray(sections) ? sections : [];
  const overrides = Array.isArray(resolved?.overrides) ? resolved.overrides : [];
  const applied = [];
  const skipped = [];
  if (overrides.length === 0) return { sections: input, changed: false, report: { applied, skipped } };

  const output = input.slice();
  for (const override of overrides) {
    const at = output.findIndex((section) => section?.name === override.name);
    if (override.action === 'replace') {
      if (at === -1) {
        skipped.push(skipOf(override, 'section-not-present', `no section named ${JSON.stringify(override.name)} is registered`));
        continue;
      }
      output[at] = { ...output[at], text: override.text };
      applied.push(appliedOf(override));
    } else if (override.action === 'hide') {
      if (at === -1) {
        skipped.push(skipOf(override, 'section-not-present', `no section named ${JSON.stringify(override.name)} is registered`));
        continue;
      }
      output.splice(at, 1);
      applied.push(appliedOf(override));
    } else {
      if (at !== -1) {
        skipped.push(skipOf(override, 'name-already-present', `section ${JSON.stringify(override.name)} is already registered`));
        continue;
      }
      const index = override.order === undefined
        ? output.length
        : Math.max(0, Math.min(override.order, output.length));
      output.splice(index, 0, { name: override.name, text: override.text });
      applied.push(appliedOf(override));
    }
  }

  const changed = !sameSections(input, output);
  return { sections: changed ? output : input, changed, report: { applied, skipped } };
}

/**
 * Build one `report.applied` entry.
 * @param override - the override that took effect.
 * @returns the report entry.
 */
function appliedOf(override) {
  return { name: override.name, action: override.action, layer: override.layer ?? null };
}

/**
 * Build one `report.skipped` entry.
 * @param override - the override that could not take effect.
 * @param code - why it was skipped.
 * @param message - human-readable explanation.
 * @returns the report entry.
 */
function skipOf(override, code, message) {
  return { name: override.name, action: override.action, layer: override.layer ?? null, code, message };
}

/**
 * The section name the frozen probe appends.
 *
 * Frozen detection cannot rely on the user having configured an override: a
 * scope whose only registered section is itself `complete` returns exactly what
 * it was given for ANY real config, so the collapse is invisible. Appending a
 * section that no real config would contain makes the collapse observable —
 * if the probe section is missing from the result, the scope's whole `sections`
 * array was replaced after the waterfall.
 */
export const PROBE_SECTION_NAME = '__dsh-prompt-setting-probe__';
/** The probe section's text; never rendered, only observed. */
const PROBE_SECTION_TEXT = 'dsh-prompt-setting assemble probe';

/**
 * The config used by the frozen probe: one append of {@link PROBE_SECTION_NAME}.
 * @returns a resolved-config-shaped object with a single `user`-layer append.
 */
export function probeConfig() {
  return {
    version: CONFIG_VERSION,
    overrides: [{ name: PROBE_SECTION_NAME, action: 'append', text: PROBE_SECTION_TEXT, layer: 'user' }],
  };
}

/**
 * Decide whether the assembled scope is frozen, from two real `assemble()`
 * probes. Nothing is guessed: every input is an observation.
 *
 * Three signals, in order:
 * 1. the *frozen probe* — its appended section is missing from the result, so
 *    the pipeline replaced the scope's `sections` (a `complete: true` section
 *    does exactly that). This is the decisive signal, and it works for every
 *    scope shape including one whose only section is the complete one;
 * 2. the frozen probe survived but the section list still changed size — the
 *    pipeline rewrote the list for another reason;
 * 3. the *override* probe discarded our change. Kept because it names the
 *    specific failure ("your override was discarded") rather than the scope's.
 * @param probes - the observed sections of both probes.
 * @returns `{frozen, frozenSection, frozenReason}`.
 */
export function detectFrozen({ registered, probe, downstream, after, resolved }) {
  const probeAttempt = applyOverrides(registered, probeConfig());
  if (probeAttempt.changed) {
    const survived = probe.some((section) => section?.name === PROBE_SECTION_NAME);
    if (!survived) {
      const collapsed = probe.length === 1;
      return {
        frozen: true,
        frozenSection: collapsed ? probe[0].name : null,
        frozenReason: collapsed
          ? `the assembly was replaced by a single complete section ${JSON.stringify(probe[0].name)}`
          : 'the probe section was removed: the assembled sections were replaced after the waterfall',
      };
    }
    if (probe.length !== registered.length + 1) {
      return {
        frozen: true,
        frozenSection: null,
        frozenReason: 'the assembled section list differs from the registered sections for a probe-only append',
      };
    }
  } else if (!sameSections(registered, probe)) {
    return {
      frozen: true,
      frozenSection: probe.length === 1 ? probe[0].name : null,
      frozenReason: 'the assembled sections differ from the registered sections even with no override applied',
    };
  }

  const attempt = applyOverrides(downstream, resolved);
  if (attempt.changed && !sameSections(attempt.sections, after)) {
    const collapsed = after.length === 1 && downstream.length > 1;
    let reason;
    if (sameSections(downstream, after)) {
      reason = 'the override was discarded: the assembled sections are the pre-override sections';
    } else if (collapsed) {
      reason = `the assembly was replaced by a single complete section ${JSON.stringify(after[0].name)}`;
    } else {
      reason = 'the override was discarded by the assembly pipeline';
    }
    return {
      frozen: true,
      frozenSection: after.length === 1 ? after[0].name : null,
      frozenReason: reason,
    };
  }
  return { frozen: false, frozenSection: null, frozenReason: null };
}

/**
 * Infer each registered section's `complete` flag from the frozen probe.
 *
 * A probe-only append that survives the round trip proves no complete section
 * is active — a complete section always collapses the scope to itself. A frozen
 * scope with a named single section proves that one is complete and the rest
 * are not. Anything else stays `"unknown"` rather than guessed.
 * @param registered - the registered sections (pre-waterfall).
 * @param probe - the frozen probe's assembled result.
 * @param frozen - the {@link detectFrozen} verdict.
 * @param frozenSection - the section named by that verdict.
 * @returns a `Map<name, true|false|"unknown">`.
 */
export function completeFlags(registered, probe, frozen, frozenSection) {
  const flags = new Map();
  const list = Array.isArray(registered) ? registered : [];
  const survived = (Array.isArray(probe) ? probe : []).some((section) => section?.name === PROBE_SECTION_NAME);
  if (survived && !frozen) {
    for (const section of list) flags.set(section.name, false);
  } else if (frozen && frozenSection !== null) {
    for (const section of list) flags.set(section.name, section.name === frozenSection);
  } else {
    for (const section of list) flags.set(section.name, 'unknown');
  }
  return flags;
}

/**
 * Project the registered sections into the snapshot's `base` view.
 * @param registered - the registered sections (pre-waterfall), in canonical order.
 * @param flags - the {@link completeFlags} map.
 * @returns `[{name, index, text, complete}]`.
 */
export function buildBase(registered, flags) {
  const list = Array.isArray(registered) ? registered : [];
  return list.map((section, index) => ({
    name: section.name,
    index,
    text: section.text,
    complete: flags.get(section.name) ?? 'unknown',
  }));
}

/**
 * Project the assembled result plus the override intent into the snapshot's
 * `effective` view — one entry per rendered section, then one entry per
 * registered section or override that produced no rendered section.
 *
 * `index` is the entry's position in the RENDERED array. An entry with
 * `index: null` is not in the rendered prompt at all (a successful `hide`, a
 * name that was never registered, a section the pipeline dropped, or an
 * `append` that was discarded); its `text` is the suppressed original where one
 * exists, otherwise `""`.
 * @param view - the projection inputs.
 * @returns the `effective` array.
 */
export function buildEffective({ base, after, resolved, report, frozen, frozenReason }) {
  const rendered = Array.isArray(after) ? after : [];
  const overrides = Array.isArray(resolved?.overrides) ? resolved.overrides : [];
  const byName = new Map(overrides.map((override) => [override.name, override]));
  const baseByName = new Map((Array.isArray(base) ? base : []).map((entry) => [entry.name, entry]));
  const skippedByName = new Map((report?.skipped ?? []).map((entry) => [entry.name, entry]));
  const seen = new Set();
  const out = [];

  rendered.forEach((section, index) => {
    seen.add(section.name);
    const override = byName.get(section.name);
    if (override === undefined) {
      out.push({
        name: section.name,
        index,
        text: section.text,
        applied: false,
        overridable: !frozen,
        reason: frozen ? frozenReason : null,
        overrideLayer: null,
        action: null,
      });
      return;
    }
    const entry = {
      name: section.name,
      index,
      text: section.text,
      applied: false,
      overridable: true,
      reason: null,
      overrideLayer: override.layer ?? null,
      action: override.action,
    };
    if (override.action === 'replace') {
      entry.applied = section.text === override.text;
      if (!entry.applied) {
        entry.overridable = false;
        entry.reason = frozen
          ? frozenReason
          : (baseByName.has(section.name) && section.text === baseByName.get(section.name).text
            ? 'the section text was restored to its pre-waterfall value'
            : 'the section text differs from both the registered text and the requested text');
      }
    } else if (override.action === 'hide') {
      // A hidden section only reaches this branch when the hide did not stick.
      entry.applied = false;
      entry.overridable = false;
      entry.reason = frozen ? frozenReason : 'the section survived the hide request';
    } else {
      entry.applied = section.text === override.text;
      if (!entry.applied) {
        entry.overridable = false;
        entry.reason = frozen ? frozenReason : 'the appended text was replaced further down the assembly pipeline';
      }
    }
    out.push(entry);
  });

  // A registered section that the assembled result dropped without an override
  // asking for it (a frozen scope collapses to its complete section) is still
  // reported, so the loss is visible rather than an unexplained absence.
  for (const entry of Array.isArray(base) ? base : []) {
    if (seen.has(entry.name) || byName.has(entry.name)) continue;
    out.push({
      name: entry.name,
      index: null,
      text: entry.text,
      applied: false,
      overridable: false,
      reason: frozen ? frozenReason : 'the section is not present in the assembled result',
      overrideLayer: null,
      action: null,
    });
  }

  for (const override of overrides) {
    if (seen.has(override.name)) continue;
    const baseEntry = baseByName.get(override.name);
    const skipped = skippedByName.get(override.name);
    let reason = null;
    let overridable = !frozen;
    let applied = false;
    if (skipped !== undefined) {
      reason = skipped.message;
      overridable = false;
    } else if (override.action === 'hide') {
      applied = true;
    } else if (override.action === 'replace') {
      overridable = false;
      reason = baseEntry === undefined
        ? `no section named ${JSON.stringify(override.name)} is registered`
        : 'the section was removed from the assembled result';
    } else {
      overridable = false;
      reason = 'the appended section is not present in the assembled result';
    }
    out.push({
      name: override.name,
      index: null,
      text: override.action === 'hide' ? (baseEntry?.text ?? '') : '',
      applied,
      overridable,
      reason,
      overrideLayer: override.layer ?? null,
      action: override.action,
    });
  }

  return out;
}

/**
 * Render a section list the way the Host renders the prompt: interpolate each
 * section, drop empty ones, join the rest with a blank line.
 *
 * Deliberate difference from the shipped `renderPrompt`: an unknown or
 * malformed `{{reference}}` is left LITERAL here instead of throwing. The
 * snapshot is a read-only view and must never fail because of provider text,
 * and this module may not import the shipped renderer (it is not resolvable
 * from a linked plugin package). Provenance text containing `{{…}}` therefore
 * renders literally in the snapshot but throws in a real turn — see
 * CONTRACT.md §4.4.
 * @param sections - the sections to render.
 * @param variables - the assembly's resolved variable values.
 * @returns the rendered prompt.
 */
export function renderSections(sections, variables) {
  const list = Array.isArray(sections) ? sections : [];
  const values = variables !== null && typeof variables === 'object' ? variables : {};
  return list
    .map((section) => (section?.interpolate === false ? String(section.text) : interpolate(String(section?.text ?? ''), values)))
    .filter((text) => text.length > 0)
    .join('\n\n');
}

/**
 * Substitute every well-formed `{{name}}` whose value is known.
 * @param text - the raw section text.
 * @param variables - the resolved variable values.
 * @returns the text with known references substituted and unknown ones literal.
 */
function interpolate(text, variables) {
  let result = '';
  let cursor = 0;
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', cursor)) {
    const group = VARIABLE_GROUP.exec(text.slice(open));
    const name = group === null ? null : group[0].slice(2, -2);
    if (name === null || !VARIABLE_NAME.test(name) || !Object.hasOwn(variables, name)) {
      result += text.slice(cursor, open + 2);
      cursor = open + 2;
      continue;
    }
    result += text.slice(cursor, open) + String(variables[name]);
    cursor = open + group[0].length;
  }
  return result + text.slice(cursor);
}

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
/**
 * Where an `effective` entry came from. The pre-waterfall registered sections
 * and the final result legitimately differ, because another plugin may add or
 * remove sections in its own `system-prompt/assemble` listener; this is how the
 * browser tells those apart instead of reading them as an override or a fault.
 * - `registered` — the name was in the pre-waterfall sections;
 * - `appended` — this plugin's own `append` override introduced it;
 * - `downstream-added` — neither of the above: it entered the result after the
 *   waterfall, contributed by another listener;
 * - `unmatched-override` — an override whose target exists neither in the
 *   registered sections nor in the result.
 */
export const ORIGINS = Object.freeze(['registered', 'appended', 'downstream-added', 'unmatched-override']);

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
/**
 * The probe section's text; never rendered, only observed. */
const PROBE_SECTION_TEXT = 'dsh-prompt-setting assemble probe';
/** Shared verdict for a scope nothing froze. */
const NO_FREEZE = Object.freeze({ frozen: false, frozenSection: null, frozenReason: null });

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
 * Decide whether the assembled scope is frozen, from the frozen probe alone.
 *
 * THE signal is whether this plugin's own appended probe section survived the
 * waterfall:
 *
 * - it survived ⇒ no complete section replaced the scope's `sections`, so
 *   `frozen: false`. **Other plugins adding or removing sections in their own
 *   `system-prompt/assemble` listeners is normal and is NOT a freeze** — a real
 *   machine had a plugin append a companion section, which made an earlier
 *   "the list changed size" heuristic report a freeze on every scope and marked
 *   every section non-overridable;
 * - it is gone and the result is exactly one section ⇒ the scope collapsed to
 *   its single `complete` section;
 * - it is gone and the result is anything else ⇒ our append was removed after
 *   the waterfall. Reported as frozen with that wording, and deliberately
 *   WITHOUT claiming a `complete` section caused it.
 *
 * Nothing compares section counts or the whole list against the registered
 * sections except in the degenerate case where the probe name is already taken
 * and no marker is available.
 * @param probes - `{registered, probe}`: the pre-waterfall sections and the
 *   frozen probe's assembled result.
 * @returns `{frozen, frozenSection, frozenReason}`.
 */
export function detectFrozen({ registered, probe }) {
  const survived = (Array.isArray(probe) ? probe : []).some((section) => section?.name === PROBE_SECTION_NAME);
  const probeAttempt = applyOverrides(registered, probeConfig());
  if (probeAttempt.changed) {
    if (survived) return NO_FREEZE;
    const collapsed = probe.length === 1;
    return {
      frozen: true,
      frozenSection: collapsed ? probe[0].name : null,
      frozenReason: collapsed
        ? `the assembly was replaced by a single complete section ${JSON.stringify(probe[0].name)}`
        : 'this plugin\'s appended probe section was removed after the waterfall, so the assembled sections are not the ones this plugin returned',
    };
  }
  // Degenerate: a registered section already owns the probe name, so the marker
  // cannot be used. Fall back to comparing the two observations.
  if (!sameSections(registered, probe)) {
    return {
      frozen: true,
      frozenSection: probe.length === 1 ? probe[0].name : null,
      frozenReason: 'the assembled sections differ from the registered sections even with no override applied',
    };
  }
  return NO_FREEZE;
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
 *
 * `origin` says where the entry came from, which is what lets the browser tell
 * a section this plugin can edit from one another plugin contributed during the
 * waterfall — see {@link ORIGINS}.
 * @param view - the projection inputs.
 * @returns the `effective` array.
 */
export function buildEffective({ base, after, resolved, report, frozen, frozenReason }) {
  const rendered = Array.isArray(after) ? after : [];
  const overrides = Array.isArray(resolved?.overrides) ? resolved.overrides : [];
  const byName = new Map(overrides.map((override) => [override.name, override]));
  const baseByName = new Map((Array.isArray(base) ? base : []).map((entry) => [entry.name, entry]));
  const skippedByName = new Map((report?.skipped ?? []).map((entry) => [entry.name, entry]));
  /** Where a name in the result came from. */
  const originOf = (name) => {
    if (baseByName.has(name)) return 'registered';
    return byName.get(name)?.action === 'append' ? 'appended' : 'downstream-added';
  };
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
        origin: originOf(section.name),
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
      origin: originOf(section.name),
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
  // asking for it (a frozen scope collapses to its complete section, or another
  // listener removed it) is still reported, so the loss is visible rather than
  // an unexplained absence.
  for (const entry of Array.isArray(base) ? base : []) {
    if (seen.has(entry.name) || byName.has(entry.name)) continue;
    out.push({
      name: entry.name,
      index: null,
      text: entry.text,
      origin: 'registered',
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
    if (override.action === 'hide' && skipped === undefined) {
      // The hide took effect: the section is gone from the result, which is
      // exactly what was asked for.
      applied = true;
    } else if (baseEntry !== undefined) {
      // It WAS registered but is absent from the result: report the loss, not
      // the (inaccurate) "no such section is registered".
      overridable = false;
      reason = 'the section was removed from the assembled result';
    } else if (skipped !== undefined) {
      reason = skipped.message;
      overridable = false;
    } else if (override.action === 'replace') {
      overridable = false;
      reason = `no section named ${JSON.stringify(override.name)} is registered`;
    } else {
      overridable = false;
      reason = 'the appended section is not present in the assembled result';
    }
    out.push({
      name: override.name,
      index: null,
      text: override.action === 'hide' ? (baseEntry?.text ?? '') : '',
      origin: baseEntry !== undefined ? 'registered' : 'unmatched-override',
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
 * Deliberate difference from the shipped `renderPrompt`: an unresolved
 * `{{reference}}` is left LITERAL here instead of throwing. The snapshot is a
 * read-only view and must never fail because of provider text, and this module
 * may not import the shipped renderer (it is not resolvable from a linked
 * plugin package).
 *
 * A reference is unresolved when the variable is absent, or present with an
 * `undefined`/`null` value — which really happens: the shipped renderer
 * documents that a provider may return `undefined`, and a probe context without
 * an agent leaves agent-scoped providers valueless. Rendering `String(undefined)`
 * would put a bare `undefined` into the "full prompt" the UI shows, i.e. a
 * prompt that never existed. Instead the reference stays literal and its name is
 * reported, so the browser can say the value had no context.
 *
 * **The consequence of an unresolved reference depends on its section**, and the
 * two outcomes are not comparable, so they are collected separately:
 * - a section that interpolates (`interpolate !== false`) makes the shipped
 *   renderer **throw** on that reference — the real assembly of that session
 *   fails every turn, its prompt cannot be built at all;
 * - a section that does not interpolate (`interpolate === false`, e.g. this
 *   plugin's own reserved section) is handed to the model verbatim, so the
 *   literal braces in the preview **are** the real prompt.
 * Only the first kind can go into `unresolved`: that field's meaning ("this is
 * why the real prompt is not what you see") and its value are unchanged.
 * @param sections - the sections to render.
 * @param variables - the assembly's resolved variable values.
 * @returns `{text, resolved, unresolved, literal}` where `unresolved` is the
 *   sorted, deduplicated inner text of every reference left literal in a section
 *   that interpolates (the references that make the real assembly throw), and
 *   `literal` is the same for references in sections that do not interpolate
 *   (those reach the model exactly as written).
 */
export function renderSections(sections, variables) {
  const list = Array.isArray(sections) ? sections : [];
  const values = variables !== null && typeof variables === 'object' ? variables : {};
  const unresolved = new Set();
  const literal = new Set();
  const text = list
    .map((section) => {
      if (section?.interpolate === false) {
        const raw = String(section.text);
        collectUnresolved(raw, values, literal);
        return raw;
      }
      return interpolate(String(section?.text ?? ''), values, unresolved);
    })
    .filter((part) => part.length > 0)
    .join('\n\n');
  return { text, resolved: unresolved.size === 0, unresolved: [...unresolved].sort(), literal: [...literal].sort() };
}

/**
 * Look up one reference name in the assembly's variables.
 * @param name - the reference's inner text.
 * @param variables - the resolved variable values.
 * @returns the value, or `undefined` when the name is malformed, absent, or
 *   carries no usable value (`undefined`/`null`).
 */
function lookup(name, variables) {
  const value = VARIABLE_NAME.test(name) && Object.hasOwn(variables, name) ? variables[name] : undefined;
  return value === undefined || value === null ? undefined : value;
}

/**
 * Record every reference in `text` that has no usable value, without changing
 * the text. Used for sections the Host never interpolates: their braces reach
 * the model as written, so nothing is substituted — but a reference with no
 * value is still worth naming, because the preview then shows a placeholder the
 * reader may mistake for a resolved value.
 * @param text - the raw section text.
 * @param variables - the resolved variable values.
 * @param sink - collector for the names with no usable value.
 */
function collectUnresolved(text, variables, sink) {
  let cursor = 0;
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', cursor)) {
    const group = VARIABLE_GROUP.exec(text.slice(open));
    if (group === null) {
      // A lone `{{` with no closing group is prose here too.
      cursor = open + 2;
      continue;
    }
    const name = group[0].slice(2, -2);
    if (lookup(name, variables) === undefined) sink.add(name);
    cursor = open + group[0].length;
  }
}

/**
 * Substitute every well-formed `{{name}}` whose value is usable, and record
 * every reference left literal.
 * @param text - the raw section text.
 * @param variables - the resolved variable values.
 * @param unresolved - collector for the names left literal.
 * @returns the text with usable references substituted and the rest literal.
 */
function interpolate(text, variables, unresolved) {
  let result = '';
  let cursor = 0;
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', cursor)) {
    const group = VARIABLE_GROUP.exec(text.slice(open));
    if (group === null) {
      // A lone `{{` with no closing group is prose, exactly as the shipped
      // renderer treats it — not an unresolved reference.
      result += text.slice(cursor, open + 2);
      cursor = open + 2;
      continue;
    }
    const name = group[0].slice(2, -2);
    const value = lookup(name, variables);
    if (value === undefined) {
      unresolved.add(name);
      result += text.slice(cursor, open + group[0].length);
      cursor = open + group[0].length;
      continue;
    }
    result += text.slice(cursor, open) + String(value);
    cursor = open + group[0].length;
  }
  return result + text.slice(cursor);
}

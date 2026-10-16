/**
 * Export / import kernel for `dsh-prompt-setting`.
 *
 * Pure: this module decides what a valid export document is, what an import
 * would change, and nothing about where a byte lands. `core/store.js` owns the
 * write and `index.js` wires the two together, which is what makes the
 * atomicity guarantee testable without a Host: the plan is computed first, and
 * a plan that fails produces no write at all.
 *
 * Revision 53 (g-074) turns the document from「the reserved section of two
 * layers」into **the whole installation**: every override of every layer
 * (frozen ones included), every workspace layer the Host registers, the preset
 * library and the preference document. `version` is therefore 2, and the
 * reader still accepts 1 — a pre-g-074 backup, which carries reserved entries
 * only, imports exactly as it did (the write lock is gone, so it never needed
 * to carry more).
 *
 * The conflict strategy is explicit and documented (CONTRACT.md §11.4):
 * - `merge` (default) — imported entries win on a name clash, local entries the
 *   document does not mention are kept;
 * - `replace` — the layer becomes exactly what the document says, so a local
 *   entry the document omits is removed.
 *
 * @module dsh-prompt-setting/core/transfer
 */

import { OverrideError, fail, interpolateFlagOf, validateConfig, validateOverride, withInterpolate } from './overrides.js';
import { validatePresetsDocument } from './presets.js';
import { validatePreferencesDocument } from './update.js';
import { validateWorkspaceRoot } from './workspace-root.js';

/** The `schema` marker every export carries. */
export const EXPORT_SCHEMA = 'dsh-prompt-setting/export';
/** The export document version this build writes (Revision 53: the full backup). */
export const EXPORT_VERSION = 2;
/**
 * Every version this build can **read** (Revision 53).
 *
 * 1 is the pre-g-074 shape: one reserved override per layer and nothing else.
 * It stays accepted on purpose — a backup a user already saved must keep
 * importing — and it is imported with exactly the rules this revision applies
 * to version 2 (schema, names, field validity, path safety).
 */
export const EXPORT_ACCEPTED_VERSIONS = Object.freeze([2, 1]);
/** The accepted conflict strategies. */
export const IMPORT_MODES = Object.freeze(['merge', 'replace']);
/** The layers an export may carry. */
export const EXPORT_LAYERS = Object.freeze(['user', 'workspace']);
/** The keys of one workspace entry. Anything else is a malformed document. */
const WORKSPACE_ENTRY_KEYS = Object.freeze(['root', 'enabled', 'reason', 'overrides']);

/**
 * Re-exported so this module stays the one place a reader of the export
 * document imports from. Since g-074 R1 the rule itself lives in
 * `core/workspace-root.js`, because `presets.applied[].workspaceRoot` is the
 * **same** field and must be judged by the very same function (a cycle would
 * otherwise force `core/presets.js` to type its own, weaker copy — which is
 * exactly the hole the review found).
 */
export { MAX_WORKSPACE_ROOT_LENGTH, validateWorkspaceRoot } from './workspace-root.js';

/**
 * Build one export document.
 *
 * Revision 53: the document carries everything the plugin persists. `layers` is
 * still the `user` / `workspace` view pair (the `workspace` entry is the layer
 * of the session that asked for the export, and it stays the shape a
 * pre-Revision-53 reader understands), `workspaces` is every workspace layer
 * the Host registers, and `presets` / `preferences` are the two
 * installation-level documents.
 *
 * `path` is deliberately **not** copied out of a layer view: the layers stay
 * path-free, and the only absolute path the document carries is a workspace's
 * own `root`, which is what makes the backup restorable at all (§10).
 * @param fields - `{layers, workspaceLayers?, presets?, preferences?, pluginVersion, exportedAt, layerNames?}`.
 * @returns the document (JSON-serializable).
 */
export function buildExport({
  layers,
  workspaceLayers = [],
  presets = null,
  preferences = null,
  pluginVersion,
  exportedAt,
  layerNames = EXPORT_LAYERS,
}) {
  const included = {};
  for (const name of layerNames) {
    const view = layers?.[name];
    if (view === undefined || view === null) continue;
    included[name] = {
      layer: name,
      enabled: view.enabled === true,
      reason: view.reason ?? null,
      overrides: Array.isArray(view.overrides) ? view.overrides : [],
    };
  }
  return {
    schema: EXPORT_SCHEMA,
    version: EXPORT_VERSION,
    exportedAt,
    plugin: { name: 'dsh-prompt-setting', version: pluginVersion },
    pluginVersion,
    layers: included,
    workspaces: (Array.isArray(workspaceLayers) ? workspaceLayers : []).map((entry) => ({
      root: entry.root,
      enabled: entry.enabled === true,
      reason: entry.reason ?? null,
      overrides: Array.isArray(entry.overrides) ? entry.overrides : [],
    })),
    presets: presets === undefined || presets === null ? null : presets,
    preferences: preferences === undefined || preferences === null ? null : preferences,
  };
}

/**
 * Validate one override list that belongs to a document location.
 * @param list - the candidate array.
 * @param where - the dotted location for the error message.
 * @returns the validated, normalized list.
 * @throws {OverrideError} with the field validator's own code.
 */
function parseOverrideList(list, where) {
  return (Array.isArray(list) ? list : []).map((entry, index) => {
    try {
      return validateOverride(entry);
    } catch (error) {
      const code = error instanceof OverrideError ? error.code : 'invalid-override';
      const message = error?.message ?? String(error);
      throw new OverrideError(code, `${where}[${index}]: ${message}`, error?.status ?? 400);
    }
  });
}

/**
 * Refuse a list that names one section twice.
 * @param overrides - a validated override list.
 * @param where - the dotted location for the error message.
 * @throws {OverrideError} `duplicate-name`.
 */
function assertUniqueNames(overrides, where) {
  const seen = new Set();
  for (const override of overrides) {
    if (seen.has(override.name)) {
      throw fail('duplicate-name', `${where} contains more than one override for ${JSON.stringify(override.name)}`);
    }
    seen.add(override.name);
  }
}

/**
 * Validate the `workspaces` array of a version 2 document.
 *
 * Every rule the import then relies on is checked here, before any layer is
 * resolved and therefore before any byte could move: each entry is an object
 * with no unknown key, its `root` is a legal absolute path
 * ({@link validateWorkspaceRoot}), its `overrides` is a valid override array
 * with unique names, and no two entries name the same root — two entries for
 * one layer would make "what this import writes" ambiguous, which is exactly
 * what the atomicity story may not be.
 * @param raw - the `workspaces` value, or `undefined`.
 * @returns `[{root, overrides}]`.
 * @throws {OverrideError} with a stable code.
 */
export function parseExportWorkspaces(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw fail('invalid-export-workspaces', '"workspaces" must be an array');
  }
  const parsed = [];
  const seen = new Set();
  raw.forEach((entry, index) => {
    const where = `workspaces[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw fail('invalid-export-workspace', `${where} must be an object`);
    }
    for (const key of Object.keys(entry)) {
      if (!WORKSPACE_ENTRY_KEYS.includes(key)) {
        throw fail('invalid-export-workspace', `${where} carries an unknown key ${JSON.stringify(key)}`);
      }
    }
    const root = validateWorkspaceRoot(entry.root);
    if (seen.has(root)) {
      throw fail('duplicate-workspace-root', `"workspaces" names ${JSON.stringify(root)} more than once`);
    }
    seen.add(root);
    if (entry.overrides !== undefined && !Array.isArray(entry.overrides)) {
      throw fail('invalid-export-workspace', `${where}.overrides must be an array`);
    }
    const overrides = parseOverrideList(entry.overrides, `${where}.overrides`);
    assertUniqueNames(overrides, `${where}.overrides`);
    parsed.push({ root, overrides: validateConfig({ version: 1, overrides }).overrides });
  });
  return parsed;
}

/**
 * Validate one export document and normalize it to override lists.
 *
 * Strict on purpose: an import is the one operation that can destroy a user's
 * configuration, so an unrecognized document is refused with a code rather
 * than read as generously as possible. Revision 53 keeps that strictness and
 * moves the write lock's job here: every layer name is whitelisted, every
 * entry is field-validated, every workspace root must be a legal path, and the
 * preset library and the preference document are validated as documents in
 * their own right (`validatePresetsDocument`, `validatePreferencesDocument`) —
 * the lock is gone, the checks are not (§11.7, §15.7).
 *
 * Unknown **top-level** keys are ignored rather than refused: the export
 * response is itself a valid import body (`ok`, `exportScope`, `mode`,
 * `session` ride along), and refusing them would break a copy-paste round trip
 * the route has always supported.
 * @param raw - the parsed request body.
 * @returns `{version, exportedAt, plugin, layers, workspaces, presets, preferences}`.
 * @throws {OverrideError} with a stable `code` for every rejection.
 */
export function parseExport(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail('invalid-export', 'an export document must be a JSON object');
  }
  if (raw.schema !== EXPORT_SCHEMA) {
    throw fail('unknown-export-schema', `"schema" must be ${JSON.stringify(EXPORT_SCHEMA)}`);
  }
  if (!Number.isInteger(raw.version)) {
    throw fail('missing-export-version', '"version" must be an integer');
  }
  if (!EXPORT_ACCEPTED_VERSIONS.includes(raw.version)) {
    throw fail(
      'unsupported-export-version',
      `unsupported export version ${JSON.stringify(raw.version)}; this build accepts ${EXPORT_ACCEPTED_VERSIONS.join(' and ')}`,
    );
  }
  const layers = raw.layers;
  if (layers === null || typeof layers !== 'object' || Array.isArray(layers)) {
    throw fail('missing-export-layers', '"layers" must be an object');
  }
  for (const name of Object.keys(layers)) {
    if (!EXPORT_LAYERS.includes(name)) {
      throw fail(
        'unknown-export-layer',
        `"layers" carries ${JSON.stringify(name)}; the accepted layer names are ${EXPORT_LAYERS.join(' and ')}`,
      );
    }
  }
  const parsed = {};
  for (const name of EXPORT_LAYERS) {
    const layer = layers[name];
    if (layer === undefined) continue;
    if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) {
      throw fail('invalid-export-layer', `"layers.${name}" must be an object`);
    }
    if (layer.overrides !== undefined && !Array.isArray(layer.overrides)) {
      throw fail('invalid-export-layer', `"layers.${name}.overrides" must be an array`);
    }
    const overrides = parseOverrideList(layer.overrides, `layers.${name}.overrides`);
    assertUniqueNames(overrides, `layers.${name}`);
    parsed[name] = validateConfig({ version: 1, overrides }).overrides;
  }
  if (Object.keys(parsed).length === 0) {
    throw fail('missing-export-layers', 'the document carries no user or workspace layer');
  }

  const wholeInstallation = ['workspaces', 'presets', 'preferences']
    .filter((key) => raw[key] !== undefined && raw[key] !== null);
  if (raw.version === 1 && wholeInstallation.length > 0) {
    throw fail(
      'unexpected-export-field',
      `a version 1 document must not carry ${wholeInstallation.map((key) => JSON.stringify(key)).join(', ')}; re-export with this build for a full backup`,
    );
  }

  return {
    schema: raw.schema,
    version: raw.version,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : null,
    plugin: raw.plugin ?? null,
    layers: parsed,
    workspaces: parseExportWorkspaces(raw.workspaces),
    presets: raw.presets === undefined || raw.presets === null ? null : locate('presets', () => validatePresetsDocument(raw.presets)),
    preferences: raw.preferences === undefined || raw.preferences === null
      ? null
      : locate('preferences', () => validatePreferencesDocument(raw.preferences)),
  };
}

/**
 * Re-throw a nested validation error with its location in the document.
 * @param where - the document key being validated.
 * @param read - the validator to run.
 * @returns whatever the validator returned.
 * @throws {OverrideError} with the validator's code and a `where:` prefix.
 */
function locate(where, read) {
  try {
    return read();
  } catch (error) {
    const code = error instanceof OverrideError ? error.code : 'invalid-export';
    const message = error?.message ?? String(error);
    throw new OverrideError(code, `${where}: ${message}`, error?.status ?? 400);
  }
}

/**
 * Resolve the conflict strategy.
 * @param raw - the `mode` value (query or body), or null.
 * @returns `"merge"` or `"replace"`.
 * @throws {OverrideError} for an unknown mode.
 */
export function resolveMode(raw) {
  if (raw === null || raw === undefined || String(raw).trim().length === 0) return 'merge';
  const value = String(raw).trim();
  if (!IMPORT_MODES.includes(value)) {
    throw fail('unknown-import-mode', `"mode" must be one of ${IMPORT_MODES.join(', ')}`);
  }
  return value;
}

/**
 * The ordered override list of a config.
 * @param config - a validated config, or null.
 * @returns a fresh array.
 */
function overridesOf(config) {
  return Array.isArray(config?.overrides) ? config.overrides.slice() : [];
}

/**
 * Whether two overrides hold the same content (order is part of it).
 * @param left - one override.
 * @param right - the other.
 * @returns whether nothing would change.
 */
function identical(left, right) {
  return left.action === right.action
    && (left.text ?? null) === (right.text ?? null)
    && (left.order ?? null) === (right.order ?? null);
}

/**
 * Compute the config an import would produce, and what changes on the way.
 *
 * No IO: the caller decides whether to persist the result (`dryRun` simply
 * returns the plan). `changes` carries the full before/after values so the
 * caller can write one history record per changed section.
 * @param input - `{imported, current, mode}`.
 * @returns `{next, changes, counts, removed}`.
 */
export function planImport({ imported, current, mode = 'merge' }) {
  const strategy = IMPORT_MODES.includes(mode) ? mode : 'merge';
  const existing = overridesOf(current);
  const incoming = Array.isArray(imported) ? imported : [];
  const changes = [];
  const next = strategy === 'replace' ? [] : existing.slice();
  const kept = new Set();

  for (const override of incoming) {
    const at = existing.findIndex((entry) => entry.name === override.name);
    const before = at === -1 ? null : existing[at];
    if (before !== null && identical(before, override)) {
      changes.push({ name: override.name, status: 'unchanged', before, after: override });
    } else if (before === null) {
      changes.push({ name: override.name, status: 'added', before: null, after: override });
    } else {
      changes.push({ name: override.name, status: 'replaced', before, after: override });
    }
    if (strategy === 'replace') next.push(override);
    else if (at === -1) next.push(override);
    else next[at] = override;
    kept.add(override.name);
  }

  const removed = strategy === 'replace'
    ? existing.filter((entry) => !kept.has(entry.name))
    : [];
  for (const override of removed) {
    changes.push({ name: override.name, status: 'removed', before: override, after: null });
  }

  const changesByName = new Map(changes.map((change) => [change.name, change]));
  const order = strategy === 'replace'
    ? [...incoming.map((entry) => entry.name), ...removed.map((entry) => entry.name)]
    : next.map((entry) => entry.name);
  const ordered = order.map((name) => changesByName.get(name)).filter(Boolean);

  const counts = { added: 0, replaced: 0, unchanged: 0, removed: 0, kept: 0 };
  for (const change of ordered) counts[change.status] += 1;
  counts.kept = next.filter((entry) => !kept.has(entry.name)).length;

  return {
    next: withInterpolate({ version: 1, overrides: next }, interpolateFlagOf(current)),
    changes: ordered,
    counts,
    removed,
  };
}

/**
 * The public, text-free view of a plan: names, statuses and counts.
 * @param plan - a {@link planImport} result.
 * @returns the response fragment.
 */
export function publicPlan(plan) {
  return {
    counts: { ...plan.counts },
    changes: plan.changes.map((change) => ({
      name: change.name,
      status: change.status,
      action: (change.after ?? change.before)?.action ?? null,
    })),
  };
}

/**
 * Sum per-layer plan counts into one totals row.
 * @param plans - `{layer: plan}`.
 * @returns `{added, replaced, unchanged, removed, kept}`.
 */
export function totalCounts(plans) {
  const totals = { added: 0, replaced: 0, unchanged: 0, removed: 0, kept: 0 };
  for (const plan of Object.values(plans ?? {})) {
    if (plan === null || plan === undefined) continue;
    for (const key of Object.keys(totals)) totals[key] += plan.counts?.[key] ?? 0;
  }
  return totals;
}

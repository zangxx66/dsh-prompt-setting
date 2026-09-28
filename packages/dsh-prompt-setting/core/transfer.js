/**
 * Export / import kernel for `dsh-prompt-setting`.
 *
 * Pure: this module decides what a valid export document is, what an import
 * would change, and nothing about where a byte lands. `core/store.js` owns the
 * write and `index.js` wires the two together, which is what makes the
 * atomicity guarantee testable without a Host: the plan is computed first, and
 * a plan that fails produces no write at all.
 *
 * The conflict strategy is explicit and documented (CONTRACT.md §11.4):
 * - `merge` (default) — imported entries win on a name clash, local entries the
 *   document does not mention are kept;
 * - `replace` — the layer becomes exactly what the document says, so a local
 *   entry the document omits is removed.
 *
 * @module dsh-prompt-setting/core/transfer
 */

import { OverrideError, fail, validateConfig, validateOverride } from './overrides.js';

/** The `schema` marker every export carries. */
export const EXPORT_SCHEMA = 'dsh-prompt-setting/export';
/** The export document version this build writes and accepts. */
export const EXPORT_VERSION = 1;
/** The accepted conflict strategies. */
export const IMPORT_MODES = Object.freeze(['merge', 'replace']);
/** The layers an export may carry. */
export const EXPORT_LAYERS = Object.freeze(['user', 'workspace']);

/**
 * Build one export document.
 * @param fields - `{layers, pluginVersion, exportedAt, layerNames?}` where
 *   `layers` maps a layer name to its public layer view.
 * @returns the document (JSON-serializable).
 */
export function buildExport({ layers, pluginVersion, exportedAt, layerNames = EXPORT_LAYERS }) {
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
  };
}

/**
 * Validate one export document and normalize it to override lists.
 *
 * Strict on purpose: an import is the one operation that can destroy a user's
 * configuration, so an unrecognized document is refused with a code rather
 * than read as generously as possible.
 * @param raw - the parsed request body.
 * @returns `{version, exportedAt, plugin, layers: {user?, workspace?}}` where
 *   each layer is a validated override array.
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
  if (raw.version !== EXPORT_VERSION) {
    throw fail('unsupported-export-version', `unsupported export version ${JSON.stringify(raw.version)}; this build accepts ${EXPORT_VERSION}`);
  }
  const layers = raw.layers;
  if (layers === null || typeof layers !== 'object' || Array.isArray(layers)) {
    throw fail('missing-export-layers', '"layers" must be an object');
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
    const overrides = (layer.overrides ?? []).map((entry, index) => {
      try {
        return validateOverride(entry);
      } catch (error) {
        const code = error instanceof OverrideError ? error.code : 'invalid-override';
        const message = error?.message ?? String(error);
        throw new OverrideError(code, `layers.${name}.overrides[${index}]: ${message}`, error?.status ?? 400);
      }
    });
    const seen = new Set();
    for (const override of overrides) {
      if (seen.has(override.name)) {
        throw fail('duplicate-name', `layers.${name} contains more than one override for ${JSON.stringify(override.name)}`);
      }
      seen.add(override.name);
    }
    parsed[name] = validateConfig({ version: 1, overrides }).overrides;
  }
  if (Object.keys(parsed).length === 0) {
    throw fail('missing-export-layers', 'the document carries no user or workspace layer');
  }
  return {
    schema: raw.schema,
    version: raw.version,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : null,
    plugin: raw.plugin ?? null,
    layers: parsed,
  };
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
    next: { version: 1, overrides: next },
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

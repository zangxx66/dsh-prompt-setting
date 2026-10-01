/**
 * `dsh-prompt-setting` — Host half.
 *
 * Owns the `/prompt-setting` route prefix and the `system-prompt/assemble`
 * override engine, on top of stage 1A's read-only probe (whose behaviour is
 * unchanged).
 *
 * Shape of the host half:
 * - `core/overrides.js` holds ALL of the logic as pure functions (validated
 *   config, layer merge, section transform, `complete` derivation, render).
 * - `core/store.js` is the only module touching the filesystem, and it is off
 *   the assembly path: layers are read at mount and refreshed at the start of
 *   every route request, then held in memory. Both layers are refreshed at the
 *   same point, so an external edit — a hand edit, a config-sync tool, another
 *   process — reaches the next request whichever layer it touched, and a
 *   request that fails still leaves the cache no further behind than that.
 *   It also reads this package's own `client.js` for the ping's `clientBuild`
 *   stamp — that read is the one deliberate exception to "held in memory", and
 *   it is re-done per request on purpose (CONTRACT.md §14).
 * - `core/build.js` is pure text (no IO): the marker region and the digest the
 *   browser half re-computes for itself.
 * - `core/custom.js` is pure policy (no IO): the reserved section this plugin
 *   registers and the write lock that narrows every write route to it
 *   (Revision 7).
 * - this file is the adapter: one registered prompt section, two waterfall
 *   listeners and seven REST routes.
 *
 * The listeners read memory only. The override listener records the
 * pre-waterfall sections (the `base` view and the frozen probe) before
 * delegating with `next()`, then applies this plugin's overrides on top of the
 * downstream result — so it never vetoes another listener, and the untouched
 * assembly is returned by identity when no override applies. The second
 * listener (Revision 8) is registered `{prepend: true}` so it is the outermost
 * one, and its only act is to move the reserved section to the end when it
 * carries text and is not already there — by reference otherwise.
 *
 * No DSH Host package is imported: the Host APIs used are the `systemPrompt`,
 * `webServer` and `connection` services read off `ctx`, plus an optional
 * `workspaceRegistry` lookup.
 *
 * @module dsh-prompt-setting
 */

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compatibilityVerdict,
  detectDshVersion,
  firstCauseLine,
  mountFailureMessage,
} from './core/compat.js';
import {
  CUSTOM_SECTION_NAME,
  CUSTOM_SECTION_ORDER,
  assertDeletableName,
  assertImportableDocument,
  assertWritableSection,
  customOverridesOnly,
  customSection,
  exportScope,
  legacyPlan,
  reservedSectionLast,
} from './core/custom.js';
import { EXPERIMENTS } from './core/experiments.js';
import { buildDiff } from './core/diff.js';
import {
  assertInterpolatable,
  customTextOf,
  describeInterpolateErrors,
  effectiveInterpolate,
  lintPromptText,
  selfCheckConfig,
  withSwitch,
  withoutSwitch,
} from './core/interpolate.js';
import {
  DEFAULT_HISTORY_PAGE,
  LEGACY_CLEAR_ACTION,
  RESET_ACTION,
  actionOf,
  publicRecord,
  queryHistory,
  resolveHistoryLimit,
  resolvePageLimit,
  resetEntries,
  snapshotOfConfig,
  textEntry,
} from './core/history.js';
import {
  ACTIONS,
  LAYERS,
  MAX_NAME_LENGTH,
  OverrideError,
  applyOverrides,
  buildBase,
  buildEffective,
  completeFlags,
  detectFrozen,
  emptyConfig,
  fail,
  interpolateFlagOf,
  mergeLayers,
  probeConfig,
  renderSections,
  sameSections,
  validateOverride,
} from './core/overrides.js';
import {
  appendHistoryRecord,
  clientBuildInfo,
  historyPath,
  readConfig,
  readHistoryFile,
  removeOverride,
  upsertOverride,
  userConfigPath,
  workspaceConfigPath,
  writeConfig,
  writeConfigsAtomically,
} from './core/store.js';
import {
  EXPORT_LAYERS,
  buildExport,
  parseExport,
  planImport,
  publicPlan,
  resolveMode,
  totalCounts,
} from './core/transfer.js';

/** Package name; echoed by the probe so the browser can assert identity. */
const PLUGIN_NAME = 'dsh-prompt-setting';
/** Package version; `test/host.test.mjs` asserts it matches package.json. */
const PLUGIN_VERSION = '0.1.0';
/** The one prefix this plugin owns. Every route lives under it. */
const ROUTE_PREFIX = '/prompt-setting';
/** Stage 1A's route: a read-only liveness probe (behaviour frozen). */
const PING_PATH = `${ROUTE_PREFIX}/ping`;
/**
 * The bundle this Host publishes, resolved from this module's own URL — never
 * from `cwd` and never from client input. Resolved once (it is a property of
 * this installed package, not of a request); the **bytes** are re-read on every
 * ping, which is what makes the reported stamp current.
 */
const CLIENT_BUNDLE_PATH = fileURLToPath(new URL('./client.js', import.meta.url));
/** Stage 1B: the assembly snapshot. */
const SNAPSHOT_PATH = `${ROUTE_PREFIX}/snapshot`;
/** Stage 1B: read/write/delete the two override layers. */
const OVERRIDES_PATH = `${ROUTE_PREFIX}/overrides`;
/** Stage 2: the bounded change log of one layer. */
const HISTORY_PATH = `${ROUTE_PREFIX}/history`;
/** Stage 2: compare two versions of one layer. */
const DIFF_PATH = `${ROUTE_PREFIX}/diff`;
/** Stage 2: one layer (or both) as a portable JSON document. */
const EXPORT_PATH = `${ROUTE_PREFIX}/export`;
/** Stage 2: apply such a document, atomically. */
const IMPORT_PATH = `${ROUTE_PREFIX}/import`;
/**
 * Revision 9: read and write the「我的 Prompt」interpolation switch. It is its
 * own route rather than a field on `PUT /overrides` because the switch is a
 * **config-level** fact, not a property of any one override: the existing PUT
 * body is a frozen stage 1B contract (`{layer, section, session}`), and adding a
 * field to it would make an old client's save silently turn the switch off.
 */
const INTERPOLATE_PATH = `${ROUTE_PREFIX}/interpolate`;
/** Method table; a known path with any other method is a 405 carrying `allow`. */
const ROUTES = new Map([
  [PING_PATH, ['GET']],
  [SNAPSHOT_PATH, ['GET']],
  [OVERRIDES_PATH, ['GET', 'PUT', 'DELETE']],
  [HISTORY_PATH, ['GET']],
  [DIFF_PATH, ['GET']],
  [EXPORT_PATH, ['GET']],
  [IMPORT_PATH, ['POST']],
  [INTERPOLATE_PATH, ['GET', 'PUT']],
]);
/** Cap on a PUT body, matching the 200 KiB per-override text cap with headroom. */
const MAX_BODY_BYTES = 256 * 1024;
/**
 * Cap on an import body. An export carries every override of both layers with
 * full text, so it is legitimately larger than a single-override PUT; the cap
 * still exists, and exceeding it is the existing `413 body-too-large`.
 */
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
/**
 * This plugin's private probe scope, used when the snapshot has no session.
 *
 * It is a plain object with no scoped registrations, so
 * `assemble({scope: PROBE_SCOPE})` resolves exactly the global sections — but
 * unlike an unscoped `assemble()` it is a scope key ONLY this module can hold.
 * That uniqueness is what lets the one-shot probe config be matched by exact
 * object identity without any other caller being able to collide with it.
 *
 * Exported for the equivalence assertion in `test/integration.test.mjs`; it is
 * not part of the plugin's API and nothing else should pass it to `assemble`.
 */
export const PROBE_SCOPE = Object.freeze({});
/**
 * The per-mount record key for an assembly that carries no scope at all.
 * A module-level string is safe here (it is only a Map key), and it is never
 * used to match a probe: probes always carry an Agent or {@link PROBE_SCOPE}.
 */
const UNSCOPED_KEY = 'unscoped';

/**
 * Required Host services. `systemPrompt` is a hard dependency: without it the
 * override engine cannot exist, so the Loader must not start this plugin.
 * `workspaceRegistry` is deliberately NOT here — it is looked up optionally,
 * so the user layer keeps working in a profile that has no workspace service.
 */
export const inject = ['webServer', 'connection', 'systemPrompt'];

/**
 * This module's directory: the module-relative anchor of the version probe
 * (the anchor that works when DSH is an ancestor or a real, non-optional
 * dependency).
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** This package's own manifest — the single source of the tested range. */
const OWN_MANIFEST_URL = new URL('./package.json', import.meta.url);
/**
 * The range used when this package's manifest cannot be read. It exists so the
 * boot check can never fail on IO; `test/boot.test.mjs` asserts it is *equal* to
 * `peerDependencies['@deepseek-ai/dsh']` in `package.json`, so the two cannot
 * drift apart silently.
 *
 * The `||` alternative has two jobs. Under **strict** `node-semver` (npm/pnpm
 * peer resolution, *without* `includePrerelease`) it is what makes the 0.2.x
 * line reachable at all: strict semver refuses a prerelease unless some
 * comparator names that very `[major, minor, patch]` tuple with a prerelease of
 * its own, and the first branch's only prerelease comparator is `0.1.7-rc.2`.
 * Under *every* parser it is also the branch that carries the range past the
 * `0.2.0` release (`<0.2.0` on its own stops one version short). This plugin's
 * own parser implements no prerelease exclusion, so for it the second branch is
 * numerically a superset extension of the first. The platform's own gate passes
 * `includePrerelease: true`, so there the first branch alone already admits the
 * 0.2.0 prereleases.
 *
 * The alternative's lower bound must stay at `0.2.0-0`, the **smallest** `0.2.0`
 * prerelease: strict semver whitelists the tuple, it does not rank it, so a
 * higher bound such as `>=0.2.0-rc.2` puts `0.2.0-alpha`, `beta` and `rc.1`
 * out of range.
 *
 * The **final** upper bound is `<0.2.1-0`, not `<0.2.0` (NOTES.md §100). The
 * platform's boot gate judges each profile bundle against this range and
 * **skips the whole bundle** when it fails (`dsh-app-boot`: `skipping profile
 * bundle … is incompatible with dsh …`), before a single line of this package
 * is imported — so its own self-check cannot help. A range whose highest
 * admitted version is `0.2.0-rc.N` therefore loses the plugin on the day
 * `0.2.0` ships. `0.2.0` and every earlier 0.2.x prerelease are in;
 * `0.2.1-0` and everything after it are out, because a new minor is
 * unverified until a new decision says otherwise.
 * See NOTES.md §98, §99 and §100.
 */
export const DSH_PEER_RANGE_FALLBACK = '>=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.1-0';

/**
 * The DSH range this plugin was tested against, read from its own manifest at
 * import time. Never throws: an unreadable manifest falls back to
 * {@link DSH_PEER_RANGE_FALLBACK}.
 */
export const DSH_PEER_RANGE = readDshPeerRange();

/**
 * @returns the peer range, or the pinned fallback.
 */
function readDshPeerRange() {
  try {
    const manifest = JSON.parse(readFileSync(OWN_MANIFEST_URL, 'utf8'));
    const range = manifest?.peerDependencies?.['@deepseek-ai/dsh'];
    if (typeof range === 'string' && range.trim().length > 0) return range.trim();
  } catch {
    // Fall through: a probe must never be the reason a boot fails.
  }
  return DSH_PEER_RANGE_FALLBACK;
}

/**
 * Run the import-time compatibility self-check and print **at most one** line.
 *
 * Silent while the installed DSH is inside the tested range — a plugin that
 * talks on every boot is worse than a silent one; one readable line when the
 * version is outside it or could not be detected. It needs **no injected
 * service and no `ctx`**, which is exactly why it runs here: the one failure the
 * plugin can never catch from the inside is a missing `inject` service (then
 * `apply` is never called at all — NOTES.md §91 boundary ①).
 *
 * Never throws: the probe and the logger are both guarded, and every
 * collaborator is injectable so all three branches are asserted offline.
 * @param options.detect - detection function (tests); defaults to
 *   {@link detectDshVersion} anchored at this module.
 * @param options.log - sink for the one warning (tests); defaults to
 *   `console.warn`.
 * @param options.expectedRange - range override (tests).
 * @returns the verdict `{level, version, message, reason}` with `level` one of
 *   `ok` | `out-of-range` | `undetected`.
 */
export function reportBootCompatibility(options = {}) {
  const detect = options.detect ?? (() => detectDshVersion({ moduleDir: MODULE_DIR }));
  const log = options.log ?? ((message) => {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(message);
  });
  let detection;
  try {
    detection = detect() ?? {};
  } catch (error) {
    detection = { version: null, reason: `probe threw: ${firstCauseLine(error)}` };
  }
  const verdict = compatibilityVerdict({
    pluginName: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    expectedRange: options.expectedRange ?? DSH_PEER_RANGE,
    detection,
  });
  if (verdict.message !== null) {
    try {
      log(verdict.message);
    } catch {
      // A logger that throws is not a reason to take the harness down with us.
    }
  }
  return verdict;
}

/**
 * The import-time self-check, run once per process — the deliverable of g-013
 * that has to work even when nothing else about this plugin runs. Guarded
 * twice on purpose: `reportBootCompatibility` swallows probe/logger failures,
 * and this wrapper swallows anything else (including a bug in the checker).
 */
export const BOOT_COMPAT = bootSelfCheck();

/**
 * @returns the verdict, or a silent `undetected` verdict when the check itself
 *   broke.
 */
function bootSelfCheck() {
  try {
    return reportBootCompatibility();
  } catch (error) {
    return { level: 'undetected', version: null, reason: firstCauseLine(error), message: null };
  }
}


/**
 * Write one JSON response. `no-store`: every answer here is a live fact.
 * @param res - the Node response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * 405 carrying the route's supported methods.
 * @param res - the Node response.
 * @param allow - the supported method names.
 */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405;
  res.setHeader('allow', allow);
  res.end();
}

/**
 * Answer an untrusted/unauthenticated request before any route logic runs —
 * the same fence `dsh-host-open-in-app` puts in front of its routes.
 * @param ctx - the Host plugin context.
 * @param req - the Node request.
 * @param res - the Node response.
 * @returns true when the request was already rejected and the handler must stop.
 */
function rejected(ctx, req, res) {
  const connection = Reflect.get(ctx, 'connection');
  if (connection === undefined || connection === null) {
    // Fail closed: without the fence we cannot tell a browser request from
    // anything else, so refuse rather than serve anything unauthenticated.
    sendJson(res, 503, {
      code: 'trust-fence-unavailable',
      message: 'the connection service is not available',
    });
    return true;
  }
  const rejection = connection.requestRejection(req);
  if (rejection === undefined) return false;
  res.statusCode = rejection;
  res.end();
  return true;
}

/**
 * Resolve the request URL. A prefix route receives the full URL, so the
 * dispatcher resolves it against a throwaway origin.
 * @param req - the Node request.
 * @returns the parsed request URL.
 */
function requestUrl(req) {
  return new URL(String(req.url ?? '/'), 'http://localhost');
}

/**
 * The renderer values the browser half may report. A whitelist — not a free
 * text field: the report is observational, so anything outside this set is
 * ignored rather than becoming an arbitrary-data injection point.
 */
const CLIENT_RENDERERS = new Set(['primitives', 'fallback']);

/**
 * Record the renderer the browser reports, when it is one of the accepted
 * values. Absent, repeated or unknown values leave the last report untouched,
 * and this never influences the response status.
 * @param report - the mutable per-mount report holder.
 * @param url - the parsed request URL.
 */
function recordClientRenderer(report, url) {
  const reported = url.searchParams.get('renderer');
  if (reported === null || !CLIENT_RENDERERS.has(reported)) return;
  report.renderer = reported;
  report.reportedAt = new Date().toISOString();
}

/**
 * Read and parse a JSON request body, with a hard size cap.
 * @param req - the Node request.
 * @param cap - the byte cap (defaults to the PUT cap).
 * @returns the parsed body (`{}` for an empty body).
 * @throws {OverrideError} on an over-large or unparsable body.
 */
async function readJsonBody(req, cap = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) {
      req.destroy?.();
      throw new OverrideError('body-too-large', `the request body exceeds ${cap} bytes`, 413);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new OverrideError('invalid-json', `the request body is not valid JSON: ${error?.message ?? String(error)}`);
  }
}

/**
 * Mount the probe route, the snapshot route, the override routes, the stage 2
 * history/diff/export/import routes and the assembly override listener.
 * @param ctx - the Host plugin context.
 * @param config - the loose plugin config. Only `historyLimit` is read, and an
 *   absent or unusable value falls back to {@link resolveHistoryLimit}'s
 *   default rather than failing the mount.
 */
export function apply(ctx, config) {
  /**
   * Disposers of everything this mount registered, in registration order. Kept
   * by this guard rather than inferred from the host: whatever a future DSH
   * does with a failed fiber (Cordis unloads it asynchronously; the Loader
   * swallows the rejection outright), *this* function decides, synchronously,
   * that a mount either registers everything or registers nothing.
   */
  const cleanups = [];
  try {
    mount(ctx, config, cleanups);
  } catch (error) {
    reportMountFailure(ctx, error, cleanups);
  }
}

/**
 * Register one effect and remember how to undo it, so a later step failing can
 * always roll the earlier ones back.
 * @param ctx - the Host plugin context.
 * @param cleanups - this mount's disposer list.
 * @param factory - the effect factory, exactly as `ctx.effect` takes it.
 * @param label - the effect label.
 * @returns the effect's own disposer.
 * @throws when the host does not hand back a disposer: an effect we cannot undo
 *   must fail the mount rather than stay half-mounted.
 */
function registerEffect(ctx, cleanups, factory, label) {
  const disposer = ctx.effect(factory, label);
  if (typeof disposer !== 'function') {
    throw new TypeError(`ctx.effect(${JSON.stringify(label)}) returned ${describeValue(disposer)} instead of a disposer`);
  }
  cleanups.push(disposer);
  return disposer;
}

/**
 * Guard a host service's return value: a disposer, or a thrown error.
 *
 * `webServer.register()` returns the function that removes the route, and the
 * whole "no half-mount" promise rests on that function existing. A breaking
 * change that returns anything else (or nothing) is reported through the
 * ordinary failure path instead of silently leaving a route nothing can remove.
 * @param value - the service's return value.
 * @returns the disposer.
 * @throws {TypeError} when the value is not a function.
 */
function disposerOf(value) {
  if (typeof value !== 'function') {
    throw new TypeError(`a host service returned ${describeValue(value)} instead of a disposer`);
  }
  return value;
}

/**
 * Name a value for a one-line diagnostic.
 * @param value - any value.
 * @returns e.g. `null`, `undefined`, `object`.
 */
function describeValue(value) {
  return value === null ? 'null' : typeof value;
}

/**
 * Report a failed mount: roll every registered effect back, then print exactly
 * one readable line.
 *
 * Rollback runs in reverse registration order — the last thing mounted is the
 * thing most likely to depend on the ones before it — and one failing disposer
 * never strands the rest. Never throws: a report that throws would *be* the
 * failure it reports.
 * @param ctx - the Host plugin context.
 * @param error - the thrown value.
 * @param cleanups - this mount's disposer list (emptied here).
 */
function reportMountFailure(ctx, error, cleanups) {
  let disposed = 0;
  let disposeFailures = 0;
  for (let index = cleanups.length - 1; index >= 0; index -= 1) {
    try {
      cleanups[index]();
      disposed += 1;
    } catch {
      disposeFailures += 1;
    }
  }
  cleanups.length = 0;
  logToHost(ctx, mountFailureMessage({
    pluginName: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    dshVersion: BOOT_COMPAT.version,
    cause: firstCauseLine(error),
    disposed,
    disposeFailures,
  }));
}

/**
 * Report one line on **both** channels that matter.
 *
 * 1. **The terminal (stderr)** — the channel the whole g-013 requirement is
 *    about, and one `ctx.logger` alone does **not** reach: the only exporter
 *    registered for `ctx.logger` in this profile is app-boot's, and it merely
 *    pushes `warn`/`error` into `startupLogs`
 *    (`dsh-app-boot/lib/index.js:4053-4060`), which is attached to a
 *    `StartupError` only when startup *fails* (`:4092`); cordis' own default
 *    exporter only buffers in memory (`cordis/lib/index.js:598-604`). That is
 *    why the platform's own activation warnings go straight to
 *    `process.stderr` (`dsh-app-boot/lib/index.js:3956-3963`, `:4008`) — and
 *    why a boot-visible message of ours has to do the same, or it is invisible.
 * 2. **`ctx.logger.error`** — the host's own log record (UI ring buffer,
 *    startup diagnostics), so a logger-aware host still sees a log line.
 *
 * The duplication this can produce on a host that *does* register a console
 * exporter is accepted deliberately: printing the line twice is a far smaller
 * failure than printing it nowhere (NOTES.md §91).
 * @param ctx - the Host plugin context (may be absent).
 * @param message - the single readable line.
 * @returns true when the host logger also took the line.
 */
function logToHost(ctx, message) {
  let logged = false;
  try {
    const logger = ctx === null || ctx === undefined ? undefined : ctx.logger;
    if (logger !== null && typeof logger === 'object' && typeof logger.error === 'function') {
      logger.error(message);
      logged = true;
    }
  } catch {
    // A logger that throws must not swallow the report; the terminal write
    // below is the one that always has to happen.
  }
  try {
    console.error(message);
  } catch {
    // Nothing left to report to; inventing a throw here would break the boot
    // this whole path exists to protect.
  }
  return logged;
}

/**
 * Mount everything. Separated from {@link apply} so the guard has one call to
 * wrap and one list of disposers to unwind.
 * @param ctx - the Host plugin context.
 * @param config - the loose plugin config.
 * @param cleanups - this mount's disposer list.
 */
function mount(ctx, config, cleanups) {
  // Per-mount state. Deliberately not module-level: two mounts (or two test
  // cases) must never observe each other's reports, watermark or config cache.
  const report = { renderer: null, reportedAt: null };
  /**
   * Retention bound for every layer history file, resolved once per mount from
   * the plugin config then the environment (default 100, minimum 10).
   */
  const historyLimit = resolveHistoryLimit(config);
  const state = {
    /**
     * User layer: read at mount and re-read at the start of every route
     * request, rewritten in memory by the save paths. `present` records that
     * the layer's file has been seen at least once, which is what lets a
     * *disappeared* file be reported instead of silently reading as "this
     * layer holds no overrides" (see {@link refreshUser}).
     */
    user: { path: userConfigPath(), config: emptyConfig(), error: null, present: false },
    /** Workspace layers by resolved root path; refreshed by the routes. */
    workspaces: new Map(),
    /** Last assembly observation per scope key: `{seq, registered, downstream}`. */
    records: new Map(),
    /**
     * Last history write failure per history file, keyed by path. A history
     * failure never changes a write's own response (the stage 1B PUT/DELETE
     * bodies are frozen), so this is where it becomes observable, through
     * `GET /history` as `lastError` (CONTRACT §8.4).
     */
    historyFailures: new Map(),
    /**
     * The config one in-flight probe must use, matched by the identity of the
     * `AssembleContext` object this plugin itself passed to `assemble()`. Only
     * this module can hold that object, so no other caller can collide with it.
     */
    pendingProbe: null,
    /**
     * The live definition object handed to `systemPrompt.section()` (Revision
     * 9). `NamedEntries` keeps the object **by reference** and every `assemble`
     * copies `section.interpolate` into the assembly it renders, so flipping
     * `state.customDefinition.interpolate` here changes what the next turn
     * renders without re-registering anything. `null` before registration and
     * after unmount.
     */
    customDefinition: null,
    /**
     * The assembled variable table, or `null` when this mount has not obtained
     * one. Cached because the lookup costs one full `assemble()`; refreshed on
     * every **write** validation so a name registered later is never refused on
     * a stale reading.
     */
    variables: null,
    /** Why the last variable-table lookup failed, or `null`. */
    variablesError: null,
  };

  /**
   * The agent registry, or undefined when this profile has none.
   * @returns the service, or undefined.
   */
  function agentsService() {
    try {
      const service = ctx.get('agents');
      return service === undefined || service === null ? undefined : service;
    } catch {
      return undefined;
    }
  }

  /**
   * The live Agent that owns a session, which is also that session's scope key.
   * @param sessionId - the session id to look up.
   * @returns the Agent, or undefined when it is not active.
   */
  function agentFor(sessionId) {
    const agents = agentsService();
    if (agents === undefined || typeof agents.get !== 'function') return undefined;
    try {
      const agent = agents.get(sessionId);
      return agent !== null && typeof agent === 'object' ? agent : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The workspace registry, or undefined when this profile has none. Looked up
   * live rather than cached, so a service that activates later is picked up and
   * a profile without it simply disables the workspace layer.
   * @returns the service, or undefined.
   */
  function workspaceRegistry() {
    try {
      const service = ctx.get('workspaceRegistry');
      return service === undefined || service === null ? undefined : service;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve the workspace root that owns a session, using the Host's own
   * session index. No client-supplied path is ever consulted.
   * @param sessionId - the session id to resolve.
   * @returns `{root, reason}`; `root` is null when it cannot be resolved.
   */
  function workspaceRootFor(sessionId) {
    const registry = workspaceRegistry();
    if (registry === undefined || typeof registry.list !== 'function') {
      return { root: null, reason: 'the workspaceRegistry service is not available in this profile' };
    }
    let list;
    try {
      list = registry.list();
    } catch (error) {
      return { root: null, reason: `workspaceRegistry.list() failed: ${error?.message ?? String(error)}` };
    }
    const workspaces = Array.isArray(list) ? list : [];
    const owner = workspaces.find(
      (workspace) => Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId),
    );
    if (owner === undefined || typeof owner.path !== 'string' || owner.path.length === 0) {
      return { root: null, reason: `no workspace owns session ${JSON.stringify(sessionId)}` };
    }
    return { root: owner.path, reason: null };
  }

  /**
   * Apply Revision 9's load-time self-check to one freshly read layer.
   *
   * The switch is a safety gate the user opens on purpose, so a layer that
   * states it OPEN while carrying text the shipped renderer would throw on is a
   * bomb that is already lit: the next assembly of any session using that layer
   * fails, and the prompt cannot be built at all. Such a layer is **degraded
   * with a reason**, exactly like the `missing-file` precedent
   * ({@link refreshUser}): the layer contributes nothing and the reason says
   * which references are at fault and how to fix them. It is never reported as
   * an invalid file (the code is `unresolvable-variable`, not `invalid-config`)
   * and it is never silently accepted.
   *
   * A layer that states nothing, or states OFF, is returned untouched by
   * construction — the check cannot affect an install that never opened the
   * gate.
   * @param read - the `readConfig` result.
   * @param owner - what the text belongs to (goes into the reason).
   * @returns the result to cache: the same one, or a degraded copy.
   */
  function selfCheckLayer(read, owner) {
    if (read.error !== null || read.config === null) return read;
    const check = selfCheckConfig(read.config, state.variables, owner);
    if (check.error === null) return read;
    return { config: null, missing: read.missing, error: check.error };
  }

  /**
   * Read one workspace layer into the in-memory cache.
   * @param root - the resolved workspace root.
   * @returns the cached layer `{path, config, error}`.
   */
  function loadWorkspace(root) {
    const path = workspaceConfigPath(root);
    const read = selfCheckLayer(readConfig(path), `the workspace layer ${path}`);
    const layer = { path, config: read.config, error: read.error };
    state.workspaces.set(root, layer);
    return layer;
  }

  /**
   * Re-read the user layer from disk into the in-memory cache.
   *
   * The user layer obeys the same rule as a workspace layer — a file that is
   * missing is an empty, enabled layer, which is the honest state of a profile
   * that has never been configured — with one addition: once this mount has
   * *seen* the file, its disappearance is reported as `missing-file` and the
   * layer contributes nothing, rather than degrading into "this layer has no
   * overrides". Either way a stale override can never survive on a file that
   * is no longer there.
   *
   * Never throws: an unreadable or invalid file disables this layer with a
   * reason (CONTRACT §5.6) and leaves every other layer alone.
   * @returns the refreshed user layer record.
   */
  function refreshUser() {
    const path = state.user.path;
    const read = selfCheckLayer(readConfig(path), `the user layer ${path}`);
    if (read.error !== null) {
      // Unreadable or invalid: keep no config at all, so this layer
      // contributes nothing to any assembly. `present` is sticky, so it stays
      // reported if the file is then deleted as well.
      state.user = { path, config: null, error: read.error, present: true };
      return state.user;
    }
    if (read.missing === true) {
      state.user = state.user.present
        ? {
          path,
          config: null,
          present: true,
          error: { code: 'missing-file', message: `${path} was removed after it had been read` },
        }
        : { path, config: read.config, error: null, present: false };
      return state.user;
    }
    state.user = { path, config: read.config, error: null, present: true };
    return state.user;
  }

  /**
   * Re-read every known workspace layer. Called at mount and at the start of
   * every route request — never from the assembly path, which only reads the
   * cache. This is what keeps `assemble` free of IO while still noticing a
   * workspace created after mount.
   * @returns the number of workspace layers inspected.
   */
  function refreshWorkspaces() {
    const registry = workspaceRegistry();
    if (registry === undefined || typeof registry.list !== 'function') return 0;
    let list;
    try {
      list = registry.list();
    } catch {
      return 0;
    }
    let count = 0;
    for (const workspace of Array.isArray(list) ? list : []) {
      if (typeof workspace?.path !== 'string' || workspace.path.length === 0) continue;
      loadWorkspace(workspace.path);
      count += 1;
    }
    return count;
  }

  /**
   * Probe the live assembly once and cache its variable table (Revision 9).
   *
   * One full `assemble()` under this plugin's own private scope is the only
   * honest source of "which `{{names}}` exist": the table is assembled per turn
   * from every registration in the profile, so a hard-coded list would be wrong
   * the moment another plugin registers a variable. Never throws — a profile
   * where the probe fails simply has no table, and the two callers treat that
   * differently on purpose ({@link ensureVariables} degrades, {@link
   * variablesForWrite} refuses).
   * @returns the table, or null when it could not be obtained.
   */
  async function refreshVariables() {
    try {
      const probed = await probe({ ...probeTarget(null), resolved: mergeLayers(emptyConfig(), null) });
      const table = probed.variables !== null && typeof probed.variables === 'object' ? probed.variables : {};
      state.variables = table;
      state.variablesError = null;
      return table;
    } catch (error) {
      state.variables = null;
      state.variablesError = error?.message ?? String(error);
      return null;
    }
  }

  /**
   * The cached variable table, obtained at most once per mount.
   *
   * The load path uses this: it must never fail a request, and a table it cannot
   * obtain only costs the stricter half of the self-check (see
   * {@link selfCheckConfig}).
   * @returns the table, or null.
   */
  async function ensureVariables() {
    if (state.variables !== null) return state.variables;
    return refreshVariables();
  }

  /**
   * The variable table a **write** validation must use.
   *
   * Always freshly probed: a name registered after this mount started must never
   * be refused on a stale reading. A probe that fails is a `503`, never a silent
   * "nothing is registered" — the refusal would then be a lie about the user's
   * text rather than a statement about this process.
   * @returns the table.
   * @throws {OverrideError} `503 variable-lookup-failed`.
   */
  async function variablesForWrite() {
    const table = await refreshVariables();
    if (table === null) {
      throw fail(
        'variable-lookup-failed',
        `cannot verify prompt variables, so this write is refused: ${state.variablesError ?? 'the assembly probe failed'}`,
        503,
      );
    }
    return table;
  }

  /**
   * Push a switch value onto the live section definition.
   *
   * Idempotent by construction: it writes only when the value actually differs,
   * so calling it on every request leaves no residue and no rewriting. It
   * touches exactly one field of one object — the definition this plugin itself
   * handed to `systemPrompt.section()` — and never a private service field.
   * @param enabled - the requested value.
   * @returns whether a write happened.
   */
  function applyInterpolateFlag(enabled) {
    const definition = state.customDefinition;
    if (definition === null) return false;
    const next = enabled === true;
    if (definition.interpolate === next) return false;
    definition.interpolate = next;
    return true;
  }

  /**
   * The cached workspace layer that owns one session, or null.
   * @param sessionId - the request's session id, or null.
   * @returns the validated config, or null.
   */
  function workspaceConfigFor(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    const { root } = workspaceRootFor(sessionId);
    if (root === null) return null;
    return state.workspaces.get(root)?.config ?? null;
  }

  /**
   * Resolve the session's effective switch and push it onto the live section.
   *
   * Resolving it here rather than at registration is what makes the switch
   * runtime-changeable: the section object is held by reference, and the shipped
   * `assemble` copies `section.interpolate` fresh on every turn, so the value
   * set here is what the **next** turn renders. No re-registration, no restart.
   * @param sessionId - the request's session id, or null for the global view.
   * @returns whether the definition changed.
   */
  function syncInterpolate(sessionId) {
    if (state.customDefinition === null) return false;
    return applyInterpolateFlag(
      effectiveInterpolate(state.user.config ?? emptyConfig(), workspaceConfigFor(sessionId)),
    );
  }

  /**
   * Refuse to store an override whose text the shipped renderer would throw on
   * (Revision 9).
   *
   * The decision is made from the **post-write** config of the layer being
   * written plus the other layer as it stands, which is exactly the pair the
   * assembly merges: text written into a layer that does not interpolate cannot
   * throw, so it is not validated. Nothing is read from disk a second time and
   * nothing is written here — the caller writes only after this returns.
   * @param override - the normalized override about to be stored.
   * @param next - the config the layer would hold after the write.
   * @param target - the resolved write target from {@link targetFor}.
   * @returns nothing.
   * @throws {OverrideError} `400 unresolvable-variable`.
   */
  async function assertTextInterpolatable(override, next, target) {
    if (override === null || override === undefined) return;
    if (override.name !== CUSTOM_SECTION_NAME || override.action === 'hide') return;
    const userFlag = target.root === null ? interpolateFlagOf(next) : interpolateFlagOf(state.user.config);
    const workspaceFlag = target.root === null ? undefined : interpolateFlagOf(next);
    if ((workspaceFlag ?? userFlag ?? false) !== true) return;
    const owner = target.root === null
      ? `the user layer (${target.path})`
      : `the workspace layer (${target.path})`;
    assertInterpolatable(override.text, await variablesForWrite(), owner);
  }

  /**
   * Re-read both layers from disk. This is the single point where a route
   * request touches the filesystem for reading, and it is deliberately the
   * *first* thing every handled request does — before any of it can fail.
   *
   * Consequences, both intended:
   * - an external edit (hand edit, config-sync tool, another process) is
   *   visible to the very next handled request, with no remount;
   * - a request that then fails still leaves the cache aligned with the files,
   *   so a failed write can never desync memory from disk for longer than the
   *   request that failed.
   *
   * It is never reached from the assembly path: the waterfall listener reads
   * this cache and nothing else (CONTRACT §5.5).
   *
   * It stays **synchronous and argument-free**: `test/route.test.mjs` asserts on
   * its source shape ("the IO sits in `refreshLayers()`, at the top of the
   * handler"), and Revision 9 does not widen that. The two Revision 9 steps that
   * need more than a file read live next to the call instead — the variable
   * table is awaited before it (so the self-check has one) and the switch is
   * pushed after it (so it can name the session).
   */
  function refreshLayers() {
    refreshUser();
    refreshWorkspaces();
  }

  /**
   * The session id an assembly belongs to. Real turns dispatch with
   * `AssembleContext = {agent, scope: agent, signal?}`, and `Agent.id` IS the
   * session id, so the workspace layer can be chosen without any IO.
   * @param context - the waterfall's assembly context.
   * @returns the session id, or undefined for the unscoped base assembly.
   */
  function sessionIdOf(context) {
    for (const candidate of [context?.agent, context?.scope]) {
      if (candidate !== null && typeof candidate === 'object' && typeof candidate.id === 'string') {
        return candidate.id;
      }
    }
    return undefined;
  }

  /**
   * The map key an assembly is filed under. An unscoped assembly has no scope
   * key object, so it gets a sentinel that no probe can collide with (probes
   * always carry a scope: an Agent or {@link PROBE_SCOPE}).
   * @param context - the waterfall's assembly context.
   * @returns the scope key object, or the unscoped sentinel.
   */
  function scopeKeyOf(context) {
    const scope = context?.scope;
    return scope === undefined || scope === null ? UNSCOPED_KEY : scope;
  }

  /**
   * The config one assembly must apply: user layer always, workspace layer when
   * the assembly belongs to an agent whose workspace has a cached layer.
   *
   * Consumes the in-flight probe config when — and only when — this is the very
   * `AssembleContext` object {@link probe} handed to `assemble()`. Matching on
   * the context's identity rather than on a scope value or a sentinel is what
   * keeps a concurrent assembly by any other caller (including a real turn for
   * the same agent) from picking up the probe's synthetic section.
   * @param context - the waterfall's assembly context.
   * @returns the merged, layer-tagged override list.
   */
  function resolvedFor(context) {
    if (state.pendingProbe !== null && context === state.pendingProbe.context) {
      const resolved = state.pendingProbe.resolved;
      state.pendingProbe = null;
      return resolved;
    }
    const user = state.user.config ?? emptyConfig();
    const sessionId = sessionIdOf(context);
    if (sessionId === undefined) return mergeLayers(user, null);
    const { root } = workspaceRootFor(sessionId);
    if (root === null) return mergeLayers(user, null);
    return mergeLayers(user, state.workspaces.get(root)?.config ?? null);
  }

  /**
   * The `system-prompt/assemble` waterfall listener.
   *
   * Synchronous until `next()`: the observation is recorded and the in-flight
   * probe config consumed before anything can interleave, which is what makes
   * the snapshot's `base` view and frozen detection deterministic. It calls
   * `next()` so no other listener is vetoed, then applies this plugin's
   * overrides to the downstream result.
   * @param assembly - the pre-waterfall assembly (registered sections).
   * @param context - the assembly context (`{agent?, scope?, signal?}`).
   * @param next - the rest of the waterfall.
   * @returns the assembly with this plugin's overrides applied.
   */
  async function assembleHandler(assembly, context, next) {
    const key = scopeKeyOf(context);
    const registered = Array.isArray(assembly?.sections) ? assembly.sections : [];
    const record = { seq: (state.records.get(key)?.seq ?? 0) + 1, registered, downstream: null };
    state.records.set(key, record);
    const resolved = resolvedFor(context);

    const downstream = await next();
    const sections = Array.isArray(downstream?.sections) ? downstream.sections : registered;
    record.downstream = sections;
    if (resolved.overrides.length === 0) return downstream;

    let applied;
    try {
      applied = applyOverrides(sections, resolved);
    } catch {
      // Fail open. An override bug must never break a user's turn; the snapshot
      // reports the layers it could not use, which is where this surfaces.
      return downstream;
    }
    if (!applied.changed) return downstream;
    return { ...downstream, sections: applied.sections };
  }

  /**
   * The `system-prompt/assemble` listener that keeps the reserved section last
   * (g-017, `CONTRACT.md` §15.10).
   *
   * Registered with `{prepend: true}`, which makes it the **outermost** listener
   * for this event. Measured, not assumed: the waterfall runs
   * `outer:in → inner:in → inner:out → outer:out` (`CONTRACT.md` §6·E2), so the
   * outermost listener's post-`next()` step runs **last** and therefore sees
   * every section a listener registered earlier appended after `next()`
   * returned. The platform itself places listeners this way
   * (`ctx.on(..., { prepend: true })`), and `order: 1000000` cannot outrank it:
   * that is exactly the live-machine gap this listener closes.
   *
   * It does **one** thing — hand the downstream result through
   * {@link reservedSectionLast}, which returns its input **by reference**
   * unless it really moves a section. It applies no override, reads no config
   * and touches no other field: `assembleHandler` above owns all of that, and
   * neither listener's registration order relative to the other is observable
   * (`prepend` fixes this one's position; the override handler is inside it).
   *
   * Fail-open twice over: the transform is pure and total, and the surrounding
   * `try` is the same belt-and-braces rule `assembleHandler` uses — an
   * exception on the assembly path would break a user's turn.
   * @param assembly - the pre-waterfall assembly (unused here).
   * @param context - the assembly context (unused here).
   * @param next - the rest of the waterfall.
   * @returns the downstream assembly, with the reserved section last when it
   *   carries text and is not already there.
   */
  async function keepReservedLastHandler(assembly, context, next) {
    const result = await next();
    try {
      return reservedSectionLast(result);
    } catch {
      return result;
    }
  }

  /**
   * Run one assembly probe under the target scope with a specific config, and
   * report what was observed.
   *
   * The scope matters: `complete` is a per-scope fact. Because `Scoped`
   * registrations are inherited through the scope's parent chain, a
   * `complete: true` section registered by a preset's standing scope freezes
   * every session composed under it while the unscoped assembly stays
   * unfrozen — so probing globally would report `frozen: false` and
   * `overridable: true` for a scope where an edit cannot take effect.
   * @param probe - the target scope and the config this probe must apply.
   * @returns `{observed, registered, downstream, after, variables}`.
   */
  async function probe({ scope, agent, resolved }) {
    const context = agent === undefined ? { scope } : { agent, scope };
    const before = state.records.get(scope)?.seq ?? 0;
    state.pendingProbe = { context, resolved };
    let assembly;
    try {
      assembly = await ctx.systemPrompt.assemble(context);
    } catch (error) {
      throw new OverrideError('assemble-failed', `systemPrompt.assemble() failed: ${error?.message ?? String(error)}`, 503);
    } finally {
      state.pendingProbe = null;
    }
    const record = state.records.get(scope);
    const observed = record !== undefined && record.seq > before;
    return {
      observed,
      registered: observed ? record.registered : [],
      downstream: observed ? (record.downstream ?? []) : [],
      after: Array.isArray(assembly?.sections) ? assembly.sections : [],
      variables: assembly?.variables,
    };
  }

  /**
   * Choose the scope the snapshot must probe, and say plainly which scope the
   * resulting verdict describes.
   * @param sessionId - the `?session=` value, or null.
   * @returns `{scope, agent, frozenScope, frozenScopeReason}`.
   */
  function probeTarget(sessionId) {
    if (sessionId === null || sessionId.length === 0) {
      return { scope: PROBE_SCOPE, agent: undefined, frozenScope: 'global', frozenScopeReason: null };
    }
    const agent = agentFor(sessionId);
    if (agent !== undefined) {
      return { scope: agent, agent, frozenScope: 'session', frozenScopeReason: null };
    }
    const available = agentsService() !== undefined;
    return {
      scope: PROBE_SCOPE,
      agent: undefined,
      frozenScope: 'global',
      frozenScopeReason: available
        ? `session ${JSON.stringify(sessionId)} has no active agent, so this verdict describes the unscoped assembly; a complete section registered in that session's scope would not be visible here`
        : 'the agents service is not available in this profile, so this verdict describes the unscoped assembly',
    };
  }

  /**
   * The public view of the user layer.
   * @returns `{layer, enabled, path, reason, overrides}` without the internal config.
   */
  function userLayerView() {
    return {
      layer: 'user',
      enabled: state.user.error === null,
      path: state.user.path,
      reason: state.user.error === null ? null : `${state.user.error.code}: ${state.user.error.message}`,
      overrides: state.user.config?.overrides ?? [],
    };
  }

  /**
   * The public view of the workspace layer for a session.
   * @param sessionId - the resolved session id, or null when none was supplied.
   * @param config - the layer config to expose (null when unusable).
   * @returns `{layer, enabled, path, reason, overrides}`.
   */
  function workspaceLayerView({ sessionId, path, reason, config }) {
    return {
      layer: 'workspace',
      enabled: config !== null,
      path: path ?? null,
      reason: config !== null ? null : reason,
      overrides: config?.overrides ?? [],
    };
  }

  /**
   * Resolve which config a session's snapshot must describe.
   *
   * It does not refresh: {@link refreshLayers} already re-read every layer at
   * the start of this request, so the only thing left to do here is load the
   * one root this view is about (which is also how a root the registry lists
   * but the cache has not seen is picked up).
   * @param sessionId - the `?session=` value, or null.
   * @returns `{sessionId, path, reason, config}`.
   */
  function workspaceContext(sessionId) {
    if (sessionId === null || sessionId.length === 0) {
      return {
        sessionId: null,
        path: null,
        reason: 'no ?session= was supplied, so the workspace layer is inactive for this view',
        config: null,
      };
    }
    const { root, reason } = workspaceRootFor(sessionId);
    if (root === null) return { sessionId, path: null, reason, config: null };
    const layer = loadWorkspace(root);
    if (layer.error !== null) {
      return {
        sessionId,
        path: layer.path,
        reason: `${layer.error.code}: ${layer.error.message}`,
        config: null,
      };
    }
    return { sessionId, path: layer.path, reason: null, config: layer.config };
  }

  /**
   * `GET /prompt-setting/snapshot` — the base and effective section views of
   * one assembly, plus the layering and frozen verdict that produced them.
   *
   * With `?session=` the assembly is probed under that session's own Agent
   * scope, so the verdict describes the scope a real turn would use; without
   * it, under this plugin's private scope, which resolves the global sections.
   * `frozenScope` always says which of the two the verdict is about.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  async function handleSnapshot(url, res) {
    const sessionId = url.searchParams.get('session');
    const workspace = workspaceContext(sessionId);
    const userConfig = state.user.config ?? emptyConfig();
    const resolved = mergeLayers(userConfig, workspace.config);
    const target = probeTarget(sessionId);

    // Probe 1 appends one section nothing else would contain. If it is missing
    // from the result, or the list changed size without it, the pipeline
    // replaced this scope's sections after the waterfall — the frozen signal,
    // and the only signal that also sees a scope whose single section IS the
    // complete one.
    const frozenProbe = await probe({ ...target, resolved: probeConfig() });
    // Probe 2 asks what this session's real overrides actually achieve.
    const overrideProbe = await probe({ ...target, resolved });

    const frozenInfo = detectFrozen({
      registered: frozenProbe.registered,
      probe: frozenProbe.after,
    });
    const flags = completeFlags(
      frozenProbe.registered,
      frozenProbe.after,
      frozenInfo.frozen,
      frozenInfo.frozenSection,
    );
    const base = buildBase(frozenProbe.registered, flags);
    const attempt = applyOverrides(overrideProbe.downstream, resolved);
    const effective = buildEffective({
      base,
      after: overrideProbe.after,
      resolved,
      report: attempt.report,
      frozen: frozenInfo.frozen,
      frozenReason: frozenInfo.frozenReason,
    });
    const rendered = renderSections(overrideProbe.after, overrideProbe.variables);

    sendJson(res, 200, {
      ok: true,
      mounted: frozenProbe.observed && overrideProbe.observed,
      generatedAt: new Date().toISOString(),
      frozen: frozenInfo.frozen,
      frozenSection: frozenInfo.frozenSection,
      frozenReason: frozenInfo.frozenReason,
      frozenScope: target.frozenScope,
      frozenScopeReason: target.frozenScopeReason,
      base: { sections: base },
      effective: { sections: effective },
      rendered: rendered.text,
      renderedResolved: rendered.resolved,
      unresolvedVariables: rendered.unresolved,
      // The same unresolved references, graded by what they actually do to the
      // real assembly (see CONTRACT §2.3). `unresolvedVariables` keeps its
      // meaning: it is the throwing set, which is what the warning is about.
      unresolvedThrowing: rendered.unresolved,
      unresolvedLiteral: rendered.literal,
      layers: {
        user: { enabled: state.user.error === null, path: state.user.path, reason: state.user.error === null ? null : `${state.user.error.code}: ${state.user.error.message}` },
        workspace: {
          enabled: workspace.config !== null,
          path: workspace.path,
          reason: workspace.config === null ? workspace.reason : null,
        },
        // Revision 9. `effective` is what this session's assembly will do;
        // `user`/`workspace` are the layers' own stated values (`null` when a
        // layer states nothing, which is not the same as `false` and is what
        // makes "the workspace inherits the user layer" visible to the browser).
        // It lives under `layers` rather than at the top level so a Revision 8
        // client's exact-key assertion on the snapshot body still holds.
        interpolate: {
          effective: effectiveInterpolate(userConfig, workspace.config),
          user: interpolateFlagOf(state.user.config) ?? null,
          workspace: interpolateFlagOf(workspace.config) ?? null,
        },
      },
      experiments: EXPERIMENTS,
    });
  }

  /**
   * `GET /prompt-setting/overrides` — both layers and the merged list the
   * assembly handler would apply for this session.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  function handleReadOverrides(url, res) {
    const workspace = workspaceContext(url.searchParams.get('session'));
    const userConfig = state.user.config ?? emptyConfig();
    const merged = mergeLayers(userConfig, workspace.config);
    sendJson(res, 200, {
      ok: true,
      user: userLayerView(),
      workspace: workspaceLayerView(workspace),
      merged: { overrides: merged.overrides },
    });
  }

  /**
   * Resolve the config path one write targets.
   * @param layer - the requested layer.
   * @param sessionId - the session id from the body or query, or null.
   * @returns `{path, root}`; `root` is null for the user layer.
   * @throws {OverrideError} for an unknown layer or an unresolvable workspace.
   */
  function targetFor(layer, sessionId) {
    if (!LAYERS.includes(layer)) {
      throw new OverrideError('unknown-layer', `"layer" must be one of ${LAYERS.join(', ')}`);
    }
    if (layer === 'user') return { path: userConfigPath(), root: null };
    if (sessionId === null || sessionId.length === 0) {
      throw new OverrideError('workspace-unresolved', 'layer "workspace" requires a "session" id to resolve the workspace root');
    }
    const { root, reason } = workspaceRootFor(sessionId);
    if (root === null) throw new OverrideError('workspace-unresolved', reason ?? 'cannot resolve a workspace for this session');
    return { path: workspaceConfigPath(root), root };
  }

  /**
   * Read the layer a write is about to modify, refusing to overwrite a file we
   * could not understand.
   * @param path - the config path.
   * @returns the validated current config.
   * @throws {OverrideError} with 409 when the file exists but is unusable.
   */
  function writableConfig(path) {
    const current = readConfig(path);
    if (current.error !== null) {
      throw new OverrideError(
        'layer-not-writable',
        `${path} is not a valid config (${current.error.code}: ${current.error.message}); fix or remove it before saving`,
        409,
      );
    }
    return current.config;
  }

  /**
   * Store a freshly written layer back into the in-memory cache, so the very
   * next assembly sees it without a re-read. The file now exists by
   * construction, which is what the user layer's `present` flag records.
   * @param target - the resolved target from {@link targetFor}.
   * @param config - the config that was written.
   */
  function cacheWritten(target, config) {
    if (target.root === null) {
      state.user = { path: target.path, config, error: null, present: true };
      return;
    }
    state.workspaces.set(target.root, { path: target.path, config, error: null });
  }

  /**
   * Append one record to a layer's history file.
   *
   * History is a log, not the source of truth: a failure here is reported to
   * the caller and never undoes or blocks the config write that already
   * happened. That is the same failure isolation the assembly path uses (§5.6).
   * @param fields - the record fields; `seq` is assigned by the store.
   * @returns `{ok: true, id, seq, dropped, rewritten}` or `{ok: false, reason}`.
   */
  function recordHistory(fields) {
    const file = historyPath(fields.path ?? '');
    try {
      const { record, dropped, rewritten } = appendHistoryRecord(file, fields, historyLimit);
      state.historyFailures.delete(file);
      return { ok: true, id: String(record.seq), seq: record.seq, dropped: dropped.length, rewritten };
    } catch (error) {
      const reason = error instanceof OverrideError
        ? `${error.code}: ${error.message}`
        : `${error?.message ?? String(error)}`;
      state.historyFailures.set(file, { at: new Date().toISOString(), reason });
      return { ok: false, reason };
    }
  }

  /**
   * Read a layer's history file without throwing.
   * @param path - the layer's config path (its directory owns the history).
   * @returns `{path, records, corrupt, error}`.
   */
  function readLayerHistory(path) {
    const file = historyPath(path);
    const read = readHistoryFile(file);
    return { path: file, records: read.records, corrupt: read.corrupt, error: read.error };
  }

  /**
   * Resolve a layer for a read-only stage 2 view (history, diff, export).
   * @param layer - `user` | `workspace`.
   * @param sessionId - the session id, or null.
   * @returns `{layer, session, path, config, reason}`; `path` is null when the
   *   layer could not be resolved at all.
   * @throws {OverrideError} for an unknown layer.
   */
  function layerFor(layer, sessionId) {
    if (!LAYERS.includes(layer)) {
      throw fail('unknown-layer', `"layer" must be one of ${LAYERS.join(', ')}`);
    }
    if (layer === 'user') {
      return {
        layer,
        session: sessionId ?? null,
        path: state.user.path,
        config: state.user.config ?? emptyConfig(),
        reason: state.user.error === null ? null : `${state.user.error.code}: ${state.user.error.message}`,
      };
    }
    const workspace = workspaceContext(sessionId);
    return {
      layer,
      session: sessionId ?? null,
      path: workspace.path,
      config: workspace.config,
      reason: workspace.config === null ? workspace.reason : null,
    };
  }

  /**
   * `GET /prompt-setting/history` — one layer's change log, newest first.
   *
   * `layer` is required, exactly like `DELETE /overrides`: history lives beside
   * one layer's config file, and there is no meaningful default between the
   * two. `limit` is clamped rather than rejected; `name` and `before` narrow
   * the page.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  function handleHistory(url, res) {
    const layer = url.searchParams.get('layer');
    const sessionId = url.searchParams.get('session');
    const view = layerFor(layer, sessionId);
    const history = readLayerHistory(view.path ?? userConfigPath());
    const pageLimit = resolvePageLimit(url.searchParams.get('limit'));
    const { records, total } = queryHistory(history.records, {
      layer,
      session: sessionId,
      name: url.searchParams.get('name'),
      before: url.searchParams.get('before'),
      limit: pageLimit,
    });
    sendJson(res, 200, {
      ok: true,
      layer,
      session: sessionId,
      path: history.path,
      enabled: view.reason === null,
      reason: view.reason,
      retentionLimit: historyLimit,
      pageLimit,
      total,
      corrupt: history.corrupt,
      unreadable: history.error === null ? null : `${history.error.code}: ${history.error.message}`,
      lastError: state.historyFailures.get(history.path) ?? null,
      records: records.map(publicRecord),
    });
  }

  /**
   * `GET /prompt-setting/export` — one or both layers as a portable document.
   *
   * `layer` (optional) limits which layers the document carries; without it the
   * document carries `user` and `workspace`, the latter possibly disabled with
   * a `reason` — an export never invents a path it could not resolve.
   *
   * Since Revision 7 the document carries **only** the reserved override of
   * each layer, and the response declares that scope explicitly as
   * `exportScope` (`{only, omitted: {<layer>, total}}`) rather than dropping
   * frozen entries silently: a backup that is not the whole configuration has
   * to say so (CONTRACT §10).
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  function handleExport(url, res) {
    const requested = url.searchParams.get('layer');
    const names = requested === null || requested.length === 0 ? EXPORT_LAYERS.slice() : [requested];
    for (const name of names) {
      if (!LAYERS.includes(name)) throw fail('unknown-layer', `"layer" must be one of ${LAYERS.join(', ')}`);
    }
    const workspace = workspaceContext(url.searchParams.get('session'));
    const views = { user: userLayerView(), workspace: workspaceLayerView(workspace) };
    const scoped = {};
    for (const name of names) {
      scoped[name] = { ...views[name], overrides: customOverridesOnly(views[name].overrides) };
    }
    const document = buildExport({
      layers: scoped,
      pluginVersion: PLUGIN_VERSION,
      exportedAt: new Date().toISOString(),
      layerNames: names,
    });
    sendJson(res, 200, { ok: true, ...document, exportScope: exportScope(views, names) });
  }

  /**
   * Resolve one side of a diff.
   * @param selector - `current` | `<seq>` | null.
   * @param fallbackCurrent - whether `null` means `current` (one side may
   *   default) or is an error.
   * @param inputs - `{layer, session, path, config, history}`.
   * @returns the diff side.
   * @throws {OverrideError} for an unknown id.
   */
  function diffSide(selector, fallbackCurrent, inputs) {
    const currentSide = () => ({
      kind: 'current',
      label: 'current',
      layer: inputs.layer,
      session: inputs.session,
      snapshot: snapshotOfConfig(inputs.config),
      texts: Object.fromEntries(
        (inputs.config?.overrides ?? []).map((override) => [
          override.name,
          override.action === 'hide' ? null : override.text,
        ]),
      ),
      id: null,
      seq: null,
      at: null,
      action: null,
      name: null,
    });
    const raw = selector === null || selector === undefined ? '' : String(selector).trim();
    if (raw.length === 0) {
      if (fallbackCurrent) return currentSide();
      throw fail('missing-diff-selector', 'supply ?from= and/or ?to= (a history id or "current")');
    }
    if (raw === 'current') return currentSide();
    if (!/^\d+$/.test(raw)) {
      throw fail('invalid-diff-selector', `"${raw}" is neither "current" nor a history id`);
    }
    const record = inputs.history.records.find((entry) => entry.seq === Number(raw));
    if (record === undefined) {
      throw new OverrideError('history-not-found', `no history record #${raw} in the ${inputs.layer} layer`, 404);
    }
    return {
      kind: 'history',
      label: `#${record.seq}`,
      layer: record.layer,
      session: record.session,
      snapshot: Array.isArray(record.snapshot) ? record.snapshot : [],
      texts: record.name === null ? {} : { [record.name]: record.after === null ? null : record.after.text },
      id: String(record.seq),
      seq: record.seq,
      at: record.at,
      action: record.action,
      name: record.name,
    };
  }

  /**
   * `GET /prompt-setting/diff` — section-level and line-level differences
   * between two versions of one layer.
   *
   * `from` and `to` each take a history id or `current`; exactly one of them
   * may be omitted (it then means `current`), and omitting both is a `400`
   * because there is nothing to compare. `name` picks the section whose text is
   * compared line by line when more than one differs.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  function handleDiff(url, res) {
    const layer = url.searchParams.get('layer');
    const sessionId = url.searchParams.get('session');
    const fromRaw = url.searchParams.get('from');
    const toRaw = url.searchParams.get('to');
    if ((fromRaw === null || fromRaw.length === 0) && (toRaw === null || toRaw.length === 0)) {
      throw fail('missing-diff-selector', 'supply ?from= and/or ?to= (a history id or "current")');
    }
    const view = layerFor(layer, sessionId);
    const history = readLayerHistory(view.path ?? userConfigPath());
    const inputs = { layer, session: sessionId, config: view.config, history };
    const from = diffSide(fromRaw, toRaw !== null && toRaw.length > 0, inputs);
    const to = diffSide(toRaw, fromRaw !== null && fromRaw.length > 0, inputs);
    const focusName = url.searchParams.get('name');
    const payload = buildDiff({ from, to, focusName: focusName === null || focusName.length === 0 ? null : focusName });
    sendJson(res, 200, {
      ok: true,
      layer,
      session: sessionId,
      historyPath: history.path,
      ...payload,
    });
  }

  /**
   * `POST /prompt-setting/import` — apply an export document.
   *
   * The order is the contract: parse → schema/version/field validation →
   * **write-lock policy** → conflict strategy → stage every layer's file and
   * validate it → atomic rename. Nothing touches a real config file before the
   * last step, so a rejection at any earlier point leaves the existing
   * configuration byte-identical. `?dryRun=true` stops after the plan and
   * returns the counts.
   *
   * Since Revision 7 a document carrying any non-reserved section name is
   * refused with `403 write-locked` (CONTRACT §15.7). That check sits before
   * the dry-run branch on purpose: a dry run answers the question the real run
   * would answer, and neither may touch a byte.
   * @param req - the Node request.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  async function handleImport(req, url, res) {
    const body = await readJsonBody(req, MAX_IMPORT_BYTES);
    const mode = resolveMode(url.searchParams.get('mode') ?? body?.mode);
    const dryRun = url.searchParams.get('dryRun') === 'true';
    const document = parseExport(body);
    assertImportableDocument(document);

    const requested = url.searchParams.get('layer');
    const names = requested === null || requested.length === 0 ? Object.keys(document.layers) : [requested];
    for (const name of names) {
      if (!LAYERS.includes(name)) throw fail('unknown-layer', `"layer" must be one of ${LAYERS.join(', ')}`);
      if (!Object.hasOwn(document.layers, name)) {
        throw fail('missing-export-layer', `the document carries no ${JSON.stringify(name)} layer`);
      }
    }

    const sessionId = typeof body?.session === 'string' && body.session.length > 0
      ? body.session
      : url.searchParams.get('session');

    // Resolve and validate every target before a single byte is written. A
    // workspace that cannot be resolved throws here, with nothing staged — but
    // only when the document actually asks for something in it: an export taken
    // without a session carries an empty, disabled workspace layer, and
    // refusing to re-import that would make export -> import fail for a reason
    // the user cannot act on. Such a layer is reported as `skipped` instead.
    const targets = {};
    const plans = {};
    const skipped = [];
    for (const name of names) {
      const imported = document.layers[name];
      let target;
      try {
        target = targetFor(name, sessionId);
      } catch (error) {
        if (imported.length === 0 && error instanceof OverrideError) {
          skipped.push({ layer: name, reason: error.message, entries: 0 });
          continue;
        }
        throw error;
      }
      const current = writableConfig(target.path);
      targets[name] = target;
      // Revision 9: the document's「我的 Prompt」text is validated against the
      // live variable table before the plan is even built, so a refused import
      // writes no layer at all — and the `?dryRun=true` branch answers exactly
      // what the real run would answer, which is the rule this route already
      // follows for the write lock.
      await assertTextInterpolatable(
        (Array.isArray(imported) ? imported : []).find((entry) => entry?.name === CUSTOM_SECTION_NAME),
        current,
        target,
      );
      plans[name] = planImport({ imported, current, mode });
    }
    const importedNames = Object.keys(plans);
    const totals = totalCounts(plans);
    const layers = {};
    for (const name of importedNames) {
      layers[name] = { ...publicPlan(plans[name]), path: targets[name].path, enabled: true };
    }
    const unchanged = importedNames.every((name) => plans[name].counts.added === 0
      && plans[name].counts.replaced === 0
      && plans[name].counts.removed === 0);

    if (dryRun) {
      sendJson(res, 200, {
        ok: true,
        dryRun: true,
        mode,
        session: sessionId ?? null,
        schema: document.schema ?? null,
        exportedAt: document.exportedAt,
        layers,
        imported: importedNames,
        skipped,
        totals,
        unchanged,
        applied: false,
      });
      return;
    }

    if (unchanged) {
      sendJson(res, 200, {
        ok: true,
        dryRun: false,
        mode,
        session: sessionId ?? null,
        layers,
        imported: importedNames,
        skipped,
        totals,
        unchanged: true,
        applied: false,
        written: [],
        history: {},
      });
      return;
    }

    const commit = writeConfigsAtomically(importedNames.map((name) => ({
      path: targets[name].path,
      config: plans[name].next,
    })));

    const history = {};
    for (const name of importedNames) {
      cacheWritten(targets[name], plans[name].next);
      const snapshot = snapshotOfConfig(plans[name].next);
      const reported = [];
      for (const change of plans[name].changes) {
        if (change.status === 'unchanged') continue;
        const result = recordHistory({
          path: targets[name].path,
          at: new Date().toISOString(),
          layer: name,
          session: sessionId ?? null,
          action: change.status === 'removed' ? 'remove' : actionOf(change.before, change.after),
          name: change.name,
          origin: 'import',
          before: textEntry(change.before === null || change.before === undefined ? null : change.before.text),
          after: textEntry(change.after === null || change.after === undefined ? null : change.after.text),
          snapshot,
          note: `import mode=${mode} status=${change.status}`,
        });
        reported.push({ name: change.name, status: change.status, ...result });
      }
      history[name] = reported;
    }

    sendJson(res, 200, {
      ok: true,
      dryRun: false,
      mode,
      session: sessionId ?? null,
      layers,
      imported: importedNames,
      skipped,
      totals,
      unchanged,
      applied: true,
      written: commit.paths,
      history,
    });
  }

  /**
   * Refuse to open the switch while a layer already on disk carries text the
   * shipped renderer would throw on (Revision 9).
   *
   * The switch is inherited: a workspace layer that states nothing inherits the
   * user layer, so opening the user layer arms **every** workspace layer that
   * did not explicitly close it. That is why the check covers the whole visible
   * set rather than the one layer being written — a bomb in an unrelated
   * workspace is exactly the "historical text" risk the switch introduces, and
   * the refusal names the file and the way out.
   *
   * A layer that explicitly states OFF is skipped: nothing inherits into it, so
   * its text cannot throw.
   * @param targetRoot - the workspace root being written, or null for the user
   *   layer. That layer is checked as OPEN, because that is what is being asked
   *   for.
   * @param variables - the freshly probed variable table.
   * @throws {OverrideError} `400 unresolvable-variable`.
   */
  function assertStoredTextsInterpolatable(targetRoot, variables) {
    const names = Object.keys(variables);
    const faults = [];
    const check = (owner, config, open) => {
      if (!open) return;
      const text = customTextOf(config);
      if (text === null) return;
      const { errors } = lintPromptText(text, variables, { assumeUnknown: true });
      if (errors.length > 0) faults.push(describeInterpolateErrors(errors, owner, names));
    };
    const userOpen = targetRoot === null ? true : interpolateFlagOf(state.user.config) === true;
    check(`the user layer (${state.user.path})`, state.user.config, userOpen);
    for (const [root, layer] of state.workspaces) {
      const open = root === targetRoot ? true : (interpolateFlagOf(layer.config) ?? userOpen);
      check(`the workspace layer (${layer.path})`, layer.config, open);
    }
    if (faults.length === 0) return;
    throw fail(
      'unresolvable-variable',
      `variable substitution cannot be enabled: ${faults.join(' ')}`,
      400,
    );
  }

  /**
   * `GET /prompt-setting/interpolate` — the switch's value, per layer and
   * effective.
   *
   * `variables` is the assembled variable table's key set, or `null` when this
   * mount could not obtain one; the browser uses it to say what is available
   * instead of guessing. `variablesError` says why when it is null.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  function handleReadInterpolate(url, res) {
    const sessionId = url.searchParams.get('session');
    const workspace = workspaceContext(sessionId);
    sendJson(res, 200, {
      ok: true,
      interpolateCustom: effectiveInterpolate(state.user.config ?? emptyConfig(), workspace.config),
      layers: {
        user: interpolateFlagOf(state.user.config) ?? null,
        workspace: interpolateFlagOf(workspace.config) ?? null,
      },
      variables: state.variables === null ? null : Object.keys(state.variables),
      variablesError: state.variablesError,
    });
  }

  /**
   * `PUT /prompt-setting/interpolate` — open or close the switch.
   *
   * Order is the whole safety story, and it is the same order every other write
   * route uses: shape, then policy, then the current file, then the check that
   * can only be done with a live assembly, and only then a byte. A refusal
   * therefore leaves both layers byte-identical
   * (`test/route.test.mjs` hashes them around every rejection).
   *
   * Opening additionally validates the text **already stored**, because turning
   * the switch on is what turns an old `{{typo}}` into a per-turn throw; closing
   * validates nothing, because closing can only ever make text safer.
   * @param req - the Node request.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  async function handleWriteInterpolate(req, url, res) {
    const body = await readJsonBody(req);
    if (typeof body?.enabled !== 'boolean') {
      throw fail('invalid-enabled', '"enabled" must be a boolean (true opens the switch, false closes it)');
    }
    const enabled = body.enabled;
    const layer = body?.layer === undefined || body?.layer === null ? 'user' : body.layer;
    if (!LAYERS.includes(layer)) {
      throw new OverrideError('unknown-layer', `"layer" must be one of ${LAYERS.join(', ')}`);
    }
    const sessionId = typeof body?.session === 'string' && body.session.length > 0
      ? body.session
      : url.searchParams.get('session');
    const target = targetFor(layer, sessionId);
    const current = writableConfig(target.path);
    if (enabled) assertStoredTextsInterpolatable(target.root, await variablesForWrite());
    const next = enabled ? withSwitch(current, true) : withoutSwitch(current);
    writeConfig(target.path, next);
    cacheWritten(target, next);
    // Effective from the NEXT turn: the definition is held by reference and the
    // shipped assemble copies `interpolate` into the assembly it is about to
    // render, so this write is what that render reads.
    syncInterpolate(sessionId);
    sendJson(res, 200, {
      ok: true,
      interpolateCustom: state.customDefinition !== null && state.customDefinition.interpolate === true,
      layer,
      saved: { enabled },
      effectiveFrom: 'next-turn',
    });
  }

  /**
   * `PUT /prompt-setting/overrides` — upsert one override into one layer.
   *
   * Since Revision 7 the write face is one section wide: the body's name must
   * be the reserved {@link CUSTOM_SECTION_NAME} ({@link assertWritableSection})
   * and its action must be `replace`. The policy is evaluated before the layer
   * is resolved, before the current config is read and therefore before any
   * byte is written, so a rejected write leaves the layer's file byte-identical
   * (`test/route.test.mjs` hashes it around every rejection).
   * @param req - the Node request.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  async function handleWriteOverride(req, url, res) {
    const body = await readJsonBody(req);
    const layer = body?.layer;
    if (!LAYERS.includes(layer)) {
      throw new OverrideError('unknown-layer', `"layer" must be one of ${LAYERS.join(', ')}`);
    }
    assertWritableSection(body?.section);
    const override = validateOverride(body?.section);
    const sessionId = typeof body?.session === 'string' && body.session.length > 0
      ? body.session
      : url.searchParams.get('session');
    const target = targetFor(layer, sessionId);
    const current = writableConfig(target.path);
    const at = current.overrides.findIndex((entry) => entry.name === override.name);
    const before = at === -1 ? null : current.overrides[at];
    const next = upsertOverride(current, override);
    // Revision 9: when this layer interpolates, the text about to be written is
    // checked against the live variable table BEFORE any byte moves, so a
    // refusal leaves the file byte-identical. The check is decided from the
    // layer's own post-write switch, not from a request-wide one: text written
    // into a layer that is closed cannot throw.
    await assertTextInterpolatable(override, next, target);
    writeConfig(target.path, next);
    cacheWritten(target, next);
    // History is written after the config it describes, and a history failure
    // never turns a successful save into an error (CONTRACT §8.4).
    recordHistory({
      path: target.path,
      at: new Date().toISOString(),
      layer,
      session: sessionId ?? null,
      action: actionOf(before, override),
      name: override.name,
      origin: 'ui',
      before: textEntry(before === null ? null : before.text),
      after: textEntry(override.action === 'hide' ? null : override.text),
      snapshot: snapshotOfConfig(next),
    });
    sendJson(res, 200, {
      ok: true,
      saved: { ...override, layer },
      effectiveFrom: 'next-turn',
    });
  }

  /**
   * `DELETE /prompt-setting/overrides` — drop one override from one layer,
   * clear the whole layer with `?reset=true`, or clear only its frozen
   * overrides with `?legacy=true`.
   *
   * Since Revision 7 the single-name form accepts only the reserved section
   * name ({@link assertDeletableName}), and that verdict runs **before** the
   * `404 override-not-found` lookup. `reset=true` keeps its stage 2 meaning
   * (the whole layer, reserved entry included). `legacy=true` is the new one:
   * it removes every non-reserved override and keeps the reserved one, which is
   * the only way back from "frozen read-only" to a clean layer without hand
   * editing the file. The two query flags are mutually exclusive.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  function handleDeleteOverride(url, res) {
    const layer = url.searchParams.get('layer');
    const sessionId = url.searchParams.get('session');
    // The shape check first, exactly as `PUT` does it: a request that names no
    // layer this plugin has is a 400 whatever else it carries.
    if (!LAYERS.includes(layer)) {
      throw new OverrideError('unknown-layer', `"layer" must be one of ${LAYERS.join(', ')}`);
    }
    const reset = url.searchParams.get('reset') === 'true';
    const legacy = url.searchParams.get('legacy') === 'true';
    if (reset && legacy) {
      throw new OverrideError(
        'conflicting-query',
        '"reset" clears the whole layer and "legacy" clears only its frozen overrides; supply one, not both',
      );
    }
    if (reset) {
      handleResetLayer(layer, sessionId, res);
      return;
    }
    if (legacy) {
      handleLegacyClear(layer, sessionId, res);
      return;
    }
    const name = url.searchParams.get('name');
    if (name === null || name.length === 0) {
      throw new OverrideError('missing-name', 'query parameter "name" is required');
    }
    if (name.length > MAX_NAME_LENGTH) {
      throw new OverrideError('name-too-long', `"name" exceeds ${MAX_NAME_LENGTH} characters`);
    }
    assertDeletableName(name);
    const target = targetFor(layer, sessionId);
    const current = writableConfig(target.path);
    const at = current.overrides.findIndex((entry) => entry.name === name);
    const { config, removed } = removeOverride(current, name);
    if (!removed) {
      throw new OverrideError('override-not-found', `no ${layer} override for section ${JSON.stringify(name)}`, 404);
    }
    writeConfig(target.path, config);
    cacheWritten(target, config);
    recordHistory({
      path: target.path,
      at: new Date().toISOString(),
      layer,
      session: sessionId ?? null,
      action: actionOf(current.overrides[at] ?? null, null),
      name,
      origin: 'ui',
      before: textEntry(current.overrides[at]?.text ?? null),
      after: null,
      snapshot: snapshotOfConfig(config),
    });
    sendJson(res, 200, { ok: true, removed: true, layer, name, effectiveFrom: 'next-turn' });
  }

  /**
   * Clear one layer and record what was removed.
   *
   * Resetting an already-empty layer is a success with `count: 0` and no
   * history record: there was no change to log. The layer's file is still
   * written empty, which makes "reset" observable on disk rather than implied.
   * @param layer - `user` | `workspace`.
   * @param sessionId - the session id, or null.
   * @param res - the Node response.
   */
  function handleResetLayer(layer, sessionId, res) {
    const target = targetFor(layer, sessionId);
    const current = writableConfig(target.path);
    const removed = current.overrides.slice();
    if (removed.length === 0) {
      sendJson(res, 200, {
        ok: true,
        reset: true,
        layer,
        removed: [],
        count: 0,
        effectiveFrom: 'next-turn',
        history: null,
      });
      return;
    }
    const config = emptyConfig();
    writeConfig(target.path, config);
    cacheWritten(target, config);
    const history = recordHistory({
      path: target.path,
      at: new Date().toISOString(),
      layer,
      session: sessionId ?? null,
      action: RESET_ACTION,
      name: null,
      origin: 'ui',
      before: null,
      after: null,
      entries: resetEntries(removed),
      snapshot: [],
      note: `reset removed ${removed.length} override(s)`,
    });
    sendJson(res, 200, {
      ok: true,
      reset: true,
      layer,
      removed: removed.map((entry) => entry.name),
      count: removed.length,
      entries: resetEntries(removed),
      effectiveFrom: 'next-turn',
      history,
    });
  }

  /**
   * Remove a layer's frozen (non-reserved) overrides and keep the reserved one.
   *
   * The response is the reset response with `legacy` in place of `reset`, so a
   * client that already renders one renders the other (CONTRACT §12.2).
   *
   * Two deliberate details:
   * - a layer with nothing legacy in it is a success with `count: 0` and **no
   *   file write at all** — like a reset of an empty layer, the file is left
   *   exactly as it was, because "there was nothing to remove" must not be
   *   recorded as a write;
   * - the removal is logged as {@link LEGACY_CLEAR_ACTION}, not as a reset: the
   *   layer afterwards still holds the reserved override, and a history reader
   *   must be able to tell that apart from a full clear.
   * @param layer - `user` | `workspace`.
   * @param sessionId - the session id, or null.
   * @param res - the Node response.
   */
  function handleLegacyClear(layer, sessionId, res) {
    const target = targetFor(layer, sessionId);
    const current = writableConfig(target.path);
    const { removed, next } = legacyPlan(current.overrides, interpolateFlagOf(current));
    if (removed.length === 0) {
      sendJson(res, 200, {
        ok: true,
        legacy: true,
        layer,
        removed: [],
        count: 0,
        effectiveFrom: 'next-turn',
        history: null,
      });
      return;
    }
    const config = next;
    writeConfig(target.path, config);
    cacheWritten(target, config);
    const entries = resetEntries(removed);
    const history = recordHistory({
      path: target.path,
      at: new Date().toISOString(),
      layer,
      session: sessionId ?? null,
      action: LEGACY_CLEAR_ACTION,
      name: null,
      origin: 'ui',
      before: null,
      after: null,
      entries,
      snapshot: snapshotOfConfig(config),
      note: `legacy clear removed ${removed.length} frozen override(s)`,
    });
    sendJson(res, 200, {
      ok: true,
      legacy: true,
      layer,
      removed: removed.map((entry) => entry.name),
      count: removed.length,
      entries,
      effectiveFrom: 'next-turn',
      history,
    });
  }

  // Load the layers this mount can see. The assembly handler never reads disk.
  refreshUser();
  refreshWorkspaces();

  // The four effects are registered route-first, listener-second,
  // listener-third, section-last.
  //
  // All are mounted synchronously before `mount` returns, so neither a request
  // nor an assembly can observe the order. It matters only when a step fails,
  // and the rule is *most-likely failure first, so the least has to be undone*:
  // `webServer.register()` refusing a duplicate prefix is the failure a real
  // profile actually hits (a second install, or a future host claiming the
  // prefix), `ctx.on` being unavailable is the next (twice), and the section
  // registration is the plugin's own promise — a reserved name in the global
  // layer, which fails only if this plugin is already mounted twice or the
  // platform changed. Registering in that order also keeps "the route is
  // already live when the next step fails" the half-mount case
  // `test/boot.test.mjs` pins, i.e. the recoverable half is the externally
  // reachable one. A section-registration failure therefore unwinds the route
  // and both listeners with it — no half-mounted plugin, and (g-013) one
  // readable line instead of a boot failure.
  registerEffect(
    ctx,
    cleanups,
    () =>
      disposerOf(ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          if (rejected(ctx, req, res)) return;
          const url = requestUrl(req);
          const methods = ROUTES.get(url.pathname);
          if (methods === undefined) {
            sendJson(res, 404, {
              code: 'not-found',
              message: `no route for ${url.pathname}`,
            });
            return;
          }
          if (!methods.includes(req.method)) {
            sendMethodNotAllowed(res, methods.join(', '));
            return;
          }
          try {
            // First thing every handled request does: re-read both layers, as
            // peers, before anything can fail. This is what makes an external
            // edit visible without a remount, and what bounds a cache/file
            // desync to the request that failed (CONTRACT §5.5).
            //
            // Revision 9 wraps the same read in the two steps that need an
            // assembly: the variable table is obtained first (so the load-time
            // self-check has the names it must judge against, once per mount),
            // and the effective switch is pushed onto the live section last (so
            // it can name the session whose workspace layer it must honour).
            await ensureVariables();
            refreshLayers();
            syncInterpolate(url.searchParams.get('session'));
            if (url.pathname === PING_PATH) {
              // Same request that probes also reports: the browser half appends
              // `?renderer=<primitives|fallback>`, so the page it renders settles
              // the primitives question on sight (NOTES.md §7/§9.2). Since
              // Revision 6 it also answers "which bytes of `client.js` am I
              // serving": read and hashed **right here**, on every request, so
              // the answer cannot outlive the file (CONTRACT.md §14).
              recordClientRenderer(report, url);
              sendJson(res, 200, {
                ok: true,
                plugin: PLUGIN_NAME,
                version: PLUGIN_VERSION,
                time: new Date().toISOString(),
                clientRenderer: report.renderer,
                clientReportedAt: report.reportedAt,
                clientBuild: clientBuildInfo(CLIENT_BUNDLE_PATH),
              });
              return;
            }
            if (url.pathname === SNAPSHOT_PATH) {
              await handleSnapshot(url, res);
              return;
            }
            if (url.pathname === HISTORY_PATH) {
              handleHistory(url, res);
              return;
            }
            if (url.pathname === DIFF_PATH) {
              handleDiff(url, res);
              return;
            }
            if (url.pathname === EXPORT_PATH) {
              handleExport(url, res);
              return;
            }
            if (url.pathname === IMPORT_PATH) {
              await handleImport(req, url, res);
              return;
            }
            if (url.pathname === INTERPOLATE_PATH) {
              if (req.method === 'PUT') await handleWriteInterpolate(req, url, res);
              else handleReadInterpolate(url, res);
              return;
            }
            if (req.method === 'GET') {
              handleReadOverrides(url, res);
              return;
            }
            if (req.method === 'PUT') {
              await handleWriteOverride(req, url, res);
              return;
            }
            handleDeleteOverride(url, res);
          } catch (error) {
            if (error instanceof OverrideError) {
              sendJson(res, error.status, { ok: false, code: error.code, message: error.message });
              return;
            }
            sendJson(res, 500, {
              ok: false,
              code: 'internal-error',
              message: error?.message ?? String(error),
            });
          }
        },
      })),
    `prompt-setting: ${ROUTE_PREFIX} routes (${ACTIONS.join('/')} overrides)`,
  );

  registerEffect(
    ctx,
    cleanups,
    () => ctx.on('system-prompt/assemble', assembleHandler),
    'prompt-setting: system-prompt/assemble override',
  );

  // Revision 8's deliverable: the outermost listener that keeps the reserved
  // section last. `prepend` is the whole mechanism — it places this listener at
  // the front of the waterfall, so its post-`next()` step is the final one to
  // touch the assembly, past any listener that registered before this plugin
  // and appends its own section after `next()` returns (the live
  // `dsh-expression:companion` case). It moves nothing else, applies no
  // override and reads no config; `reservedSectionLast` is pure and returns its
  // input by reference unless a section actually moves.
  //
  // No new failure mode: this is the same `ctx.on` effect as the listener above,
  // on the same ledger, and a host that ignores the options object still
  // registers it (it simply does not get the front slot).
  registerEffect(
    ctx,
    cleanups,
    () => ctx.on('system-prompt/assemble', keepReservedLastHandler, { prepend: true }),
    'prompt-setting: keep the reserved section last',
  );

  // Revision 7's deliverable: this plugin's own prompt section.
  //
  // Registered **empty**. The user's text is never read here — it reaches the
  // section through the existing override engine (a `replace` whose name is the
  // reserved one, applied by `assembleHandler` above), so the assembly path
  // gains no configuration read, no IO and no new branch. Until a user writes
  // something, the section renders to nothing and the final prompt is
  // byte-identical to the prompt this plugin does not exist for.
  //
  // `interpolate: false` is a safety requirement, not a preference: the
  // shipped renderer throws on an unknown, undefined or malformed `{{...}}`
  // reference, and a user's text is arbitrary. With it, a stray `{{name}}`
  // stays literal in every turn instead of breaking every turn.
  //
  // `order` places the section after every section the DSH repository defines
  // (its table's maximum is 10200); another plugin may still place itself
  // after this one, which is the documented limit of what `order` promises.
  //
  // Revision 9 keeps the **definition object** the service was handed, in
  // `state.customDefinition`. `NamedEntries` stores it by reference and every
  // `assemble` re-reads `section.interpolate` off it, so flipping that one field
  // changes what the next turn renders — no re-registration, no restart, and no
  // write to any private service field (CONTRACT §16.2).
  //
  // The disposer is accounted for exactly like the other two: it is the
  // `systemPrompt.section()` effect's own disposer, so unloading the plugin —
  // or a later step of this mount failing — removes the registration instead of
  // leaving a name in the global layer that a remount would collide with. It
  // also clears the reference, so a disposed mount can never keep steering a
  // definition the service no longer owns.
  registerEffect(
    ctx,
    cleanups,
    () => {
      const definition = customSection();
      const dispose = disposerOf(ctx.systemPrompt.section(definition));
      state.customDefinition = definition;
      return () => {
        state.customDefinition = null;
        dispose();
      };
    },
    `prompt-setting: reserved section ${CUSTOM_SECTION_NAME} (order ${CUSTOM_SECTION_ORDER}, switchable)`,
  );

  // Revision 9: apply whatever the layers already state, before `mount`
  // returns. The initial layer read above ran before the section existed, so
  // this is the one place the two facts meet — which is what makes the switch
  // survive a restart rather than only a route request.
  syncInterpolate(null);
}

/** Re-exported so tests and the client can assert the frozen action set. */
export { ACTIONS, LAYERS, sameSections };
/**
 * Re-exported for the same reason (Revision 7): the reserved section's name,
 * order and interpolation flag are contract, and a test may not re-type them.
 */
export {
  CUSTOM_SECTION_INTERPOLATE,
  CUSTOM_SECTION_NAME,
  CUSTOM_SECTION_ORDER,
  CUSTOM_SECTION_TEXT,
  REPO_MAX_SECTION_ORDER,
} from './core/custom.js';

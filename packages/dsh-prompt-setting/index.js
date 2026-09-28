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
 * - this file is the adapter: one waterfall listener and four REST routes.
 *
 * The listener reads memory only. It records the pre-waterfall sections (the
 * `base` view and the frozen probe) before delegating with `next()`, then
 * applies this plugin's overrides on top of the downstream result — so it
 * never vetoes another listener, and the untouched assembly is returned by
 * identity when no override applies.
 *
 * No DSH Host package is imported: the Host APIs used are the `systemPrompt`,
 * `webServer` and `connection` services read off `ctx`, plus an optional
 * `workspaceRegistry` lookup.
 *
 * @module dsh-prompt-setting
 */

import { fileURLToPath } from 'node:url';

import { EXPERIMENTS } from './core/experiments.js';
import { buildDiff } from './core/diff.js';
import {
  DEFAULT_HISTORY_PAGE,
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
/** Method table; a known path with any other method is a 405 carrying `allow`. */
const ROUTES = new Map([
  [PING_PATH, ['GET']],
  [SNAPSHOT_PATH, ['GET']],
  [OVERRIDES_PATH, ['GET', 'PUT', 'DELETE']],
  [HISTORY_PATH, ['GET']],
  [DIFF_PATH, ['GET']],
  [EXPORT_PATH, ['GET']],
  [IMPORT_PATH, ['POST']],
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
   * Read one workspace layer into the in-memory cache.
   * @param root - the resolved workspace root.
   * @returns the cached layer `{path, config, error}`.
   */
  function loadWorkspace(root) {
    const path = workspaceConfigPath(root);
    const read = readConfig(path);
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
    const read = readConfig(path);
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
      layers: {
        user: { enabled: state.user.error === null, path: state.user.path, reason: state.user.error === null ? null : `${state.user.error.code}: ${state.user.error.message}` },
        workspace: {
          enabled: workspace.config !== null,
          path: workspace.path,
          reason: workspace.config === null ? workspace.reason : null,
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
    const document = buildExport({
      layers: { user: userLayerView(), workspace: workspaceLayerView(workspace) },
      pluginVersion: PLUGIN_VERSION,
      exportedAt: new Date().toISOString(),
      layerNames: names,
    });
    sendJson(res, 200, { ok: true, ...document });
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
   * conflict strategy → stage every layer's file and validate it → atomic
   * rename. Nothing touches a real config file before the last step, so a
   * rejection at any earlier point leaves the existing configuration
   * byte-identical. `?dryRun=true` stops after the plan and returns the counts.
   * @param req - the Node request.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  async function handleImport(req, url, res) {
    const body = await readJsonBody(req, MAX_IMPORT_BYTES);
    const mode = resolveMode(url.searchParams.get('mode') ?? body?.mode);
    const dryRun = url.searchParams.get('dryRun') === 'true';
    const document = parseExport(body);

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
   * `PUT /prompt-setting/overrides` — upsert one override into one layer.
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
    const override = validateOverride(body?.section);
    const sessionId = typeof body?.session === 'string' && body.session.length > 0
      ? body.session
      : url.searchParams.get('session');
    const target = targetFor(layer, sessionId);
    const current = writableConfig(target.path);
    const at = current.overrides.findIndex((entry) => entry.name === override.name);
    const before = at === -1 ? null : current.overrides[at];
    const next = upsertOverride(current, override);
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
   * `DELETE /prompt-setting/overrides` — drop one override from one layer, or
   * clear the whole layer with `?reset=true`.
   *
   * The single-name semantics are unchanged from stage 1B, including the `404`
   * for a name the layer does not hold. The layer reset is the stage 2
   * addition: it is a different operation on the same route and method, and it
   * carries the removed content into history so a reset stays traceable.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  function handleDeleteOverride(url, res) {
    const layer = url.searchParams.get('layer');
    const sessionId = url.searchParams.get('session');
    if (url.searchParams.get('reset') === 'true') {
      handleResetLayer(layer, sessionId, res);
      return;
    }
    const name = url.searchParams.get('name');
    if (name === null || name.length === 0) {
      throw new OverrideError('missing-name', 'query parameter "name" is required');
    }
    if (name.length > MAX_NAME_LENGTH) {
      throw new OverrideError('name-too-long', `"name" exceeds ${MAX_NAME_LENGTH} characters`);
    }
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

  // Load the layers this mount can see. The assembly handler never reads disk.
  refreshUser();
  refreshWorkspaces();

  ctx.effect(
    () => ctx.on('system-prompt/assemble', assembleHandler),
    'prompt-setting: system-prompt/assemble override',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
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
            refreshLayers();
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
      }),
    `prompt-setting: ${ROUTE_PREFIX} routes (${ACTIONS.join('/')} overrides)`,
  );
}

/** Re-exported so tests and the client can assert the frozen action set. */
export { ACTIONS, LAYERS, sameSections };

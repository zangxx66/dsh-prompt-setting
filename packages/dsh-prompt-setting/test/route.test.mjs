/**
 * Route assertions for stage 1B, driven through a fake Host whose
 * `system-prompt` service reproduces the REAL semantics that matter here:
 * canonical ordering by `order`, an outermost-first waterfall whose `next()`
 * resolves the downstream value, and the post-waterfall `complete` collapse.
 *
 * These tests are the offline half of the acceptance evidence: they exercise
 * the whole host surface (fence, dispatch, 4xx/405, both layers, frozen
 * detection) without a Host restart.
 *
 * Run: `node --test test/`
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { apply, inject, CUSTOM_SECTION_NAME } from '../index.js';
import { renderSections } from '../core/overrides.js';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(here, '..');
/** The published bundle whose bytes the ping must fingerprint. */
const CLIENT_PATH = join(PACKAGE_ROOT, 'client.js');

const PING_PATH = '/prompt-setting/ping';
const SNAPSHOT_PATH = '/prompt-setting/snapshot';
const OVERRIDES_PATH = '/prompt-setting/overrides';
const IMPORT_PATH = '/prompt-setting/import';

/** Markers as documented in CONTRACT.md §14, written out independently. */
const BUILD_BEGIN = '/* @build-fingerprint:begin */';
const BUILD_END = '/* @build-fingerprint:end */';

/**
 * Independent recomputation of the build digest from the contract text.
 *
 * Deliberately **not** imported from `core/build.js`: this file is the oracle
 * for what the host answers, so it may not share the code under test. It is a
 * fresh FNV-1a 32 over the marker region, normalized the documented way.
 * @param text - the bundle text.
 * @returns `{hash, size}` or `null` when the markers are unusable.
 */
function independentBuildFingerprint(text) {
  let value = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  value = value.replace(/\r\n?/g, '\n');
  const from = value.indexOf(BUILD_BEGIN);
  const to = value.indexOf(BUILD_END);
  if (from === -1 || to === -1 || from >= to) return null;
  const region = value.slice(from + BUILD_BEGIN.length, to);
  let hash = 0x811c9dc5;
  for (let index = 0; index < region.length; index += 1) {
    hash = Math.imul(hash ^ region.charCodeAt(index), 0x01000193) >>> 0;
  }
  return { hash: hash.toString(16).padStart(8, '0'), size: region.length };
}

/** The sections a fresh fake Host registers, in registration order. */
const DEFAULT_SECTIONS = [
  { name: 'harness:identity', order: -1000, text: 'You are an AI agent powered by DeepSeek Harness.' },
  { name: 'deployment:persona-prefix', order: 0, text: '' },
  { name: 'project:alpha', order: 1000, text: 'ALPHA BODY' },
  { name: 'project:beta', order: 2000, text: 'BETA BODY' },
  { name: 'deployment:persona-suffix', order: 10200, text: '' },
];

/**
 * The section names an assembly of a mounted fake Host carries: the fixture
 * plus the one section the plugin registers for itself (Revision 7). Its order
 * (1000000) sorts it after every fixture entry, so it is always last.
 * @param extra - further names to append (an `append` override, a scoped
 *   section registered before it, …).
 * @returns the names in canonical order.
 */
function globalNames(extra = []) {
  return [...DEFAULT_SECTIONS.map((section) => section.name), ...extra, CUSTOM_SECTION_NAME];
}

let home;
let previousHome;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-prompt-setting-route-'));
  previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
});

/** Minimal Node response double: records status, headers and body. */
function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    end(chunk) {
      this.body = chunk === undefined || chunk === null ? '' : String(chunk);
      this.ended = true;
    },
  };
}

/** Minimal Node request double: the handler reads these fields and the body stream. */
function makeRequest({ method = 'GET', url = PING_PATH, headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  return {
    method,
    url,
    headers,
    destroy() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/**
 * Mount the plugin against a fake Host.
 *
 * The fake `systemPrompt` reproduces the parts of the real service that matter
 * here: canonical ordering by `order`, scoped layers merged along a parent
 * chain (`complete` is a per-scope fact, so the chain matters), an
 * outermost-first waterfall, and the post-waterfall `complete` collapse.
 * @param options.sections - registered GLOBAL sections (defaults to {@link DEFAULT_SECTIONS}).
 * @param options.scopes - `[{key, parent?, sections}]` scoped registrations.
 * @param options.workspaces - `list()` rows for the fake workspace registry.
 * @param options.agents - Agent objects (each with an `id`); when omitted, one
 *   is derived for every session id the workspace rows declare.
 * @param options.omitAgents - mount in a profile with no `agents` service.
 * @param options.omitWorkspaceRegistry - mount in a profile with no workspace service.
 * @param options.requestRejection - what the connection service returns.
 * @param options.omitConnection - mount without a connection service.
 * @param options.variables - the fake assembly's resolved variables.
 * @param options.beforeDispatch - awaited before each waterfall dispatch: the
 *   window in which a concurrent assembly could run.
 * @param options.host - the `apply` to mount; defaults to this package's. The
 *   build-stamp liveness test mounts a *copy* of the package so it can change
 *   the bundle on disk without touching the real `client.js`.
 * @returns the captured route plus the harness handles.
 */
function mount(options = {}) {
  const registered = (options.sections ?? DEFAULT_SECTIONS).map((section) => ({ ...section }));
  const scopes = new Map(
    (options.scopes ?? []).map((entry) => [entry.key, { parent: entry.parent, sections: entry.sections }]),
  );
  const agents = new Map(
    (
      options.agents ??
      (options.workspaces ?? []).flatMap((workspace) =>
        (workspace.sessionIds ?? []).map((id) => ({ id })),
      )
    ).map((agent) => [agent.id, agent]),
  );
  const listeners = [];
  const routes = [];
  /** Every `systemPrompt.section()` this mount registered, with its disposer. */
  const sectionRegistrations = [];
  /** Every effect disposer this mount handed back, in registration order. */
  const cleanups = [];
  let disposed = 0;
  let sectionsDisposed = 0;
  const registry = options.workspaces === undefined ? undefined : { list: () => options.workspaces };
  const agentRegistry = options.omitAgents === true ? undefined : { get: (id) => agents.get(id) };

  const systemPrompt = {
    /**
     * Reproduces the shipped `section()`: a live registration in the global
     * layer plus its own disposer. Since Revision 7 the plugin registers one
     * section during `apply`, and `close()` below is how a test observes that
     * registration being undone.
     *
     * Revision 9 note: `registered` keeps the definition **by reference**,
     * because the shipped `NamedEntries` does (`insert(name, section)` stores
     * the object it was handed) and every `assemble` re-reads
     * `section.interpolate` off it. A shallow copy here would make the fake host
     * insensitive to the one mutation the switch performs, i.e. it would let a
     * broken runtime toggle pass. `sectionRegistrations` still snapshots the
     * value as registered, so "registered with interpolate:false" stays
     * assertable after the switch has flipped.
     */
    section(definition) {
      sectionRegistrations.push({ ...definition });
      registered.push(definition);
      return () => {
        const at = registered.findIndex((entry) => entry.name === definition.name);
        if (at >= 0) registered.splice(at, 1);
        sectionsDisposed += 1;
      };
    },
    /** Reproduces the shipped assemble(): scope merge, order, waterfall, collapse. */
    async assemble(context = {}) {
      if (typeof options.beforeDispatch === 'function') await options.beforeDispatch(context);
      // Scoped layers along the parent chain, nearest scope last, exactly like
      // ScopedLayers.merge — which is what makes `complete` a per-scope fact.
      const chain = [];
      for (let cursor = context?.scope; cursor !== undefined && cursor !== null; cursor = scopes.get(cursor)?.parent) {
        chain.push(cursor);
      }
      const merged = new Map(registered.map((section) => [section.name, section]));
      for (const key of chain.reverse()) {
        for (const section of scopes.get(key)?.sections ?? []) merged.set(section.name, section);
      }
      const sorted = [...merged.values()].sort(
        (left, right) => left.order - right.order || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
      );
      const completeSection = sorted.find((section) => section.complete === true);
      const assembly = {
        sections: sorted.map((section) => ({
          name: section.name,
          text: typeof section.text === 'function' ? section.text(context) : section.text,
          ...(section.interpolate === undefined ? {} : { interpolate: section.interpolate }),
        })),
        contexts: [],
        tools: [],
        variables: options.variables ?? {},
      };
      const queue = listeners.map((listener) => listener.callback);
      const inner = () => Promise.resolve(assembly);
      const next = () => {
        const callback = queue.shift() ?? inner;
        return callback(assembly, context, next);
      };
      const transformed = await next();
      if (completeSection === undefined) return transformed;
      return { ...transformed, sections: [{ name: completeSection.name, text: completeSection.text }] };
    },
  };

  const ctx = {
    connection:
      options.omitConnection === true
        ? undefined
        : { requestRejection: options.requestRejection ?? (() => undefined) },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          disposed += 1;
        };
      },
    },
    systemPrompt,
    get(name) {
      if (name === 'workspaceRegistry') return registry;
      if (name === 'agents') return agentRegistry;
      return undefined;
    },
    on(name, callback, listenerOptions) {
      // Emulates the shipped `ctx.on`: registration order IS waterfall order
      // (outermost first), except that `{prepend: true}` unshifts the listener
      // into the front — which is how Revision 8's keeper becomes the outermost
      // one without touching the listener registered before it.
      const listener = { name, callback, options: listenerOptions };
      if (listenerOptions?.prepend === true) listeners.unshift(listener);
      else listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    effect(factory) {
      const disposer = factory();
      cleanups.push(disposer);
      return disposer;
    },
  };
  (options.host ?? apply)(ctx);
  return {
    ctx,
    routes,
    route: routes[0],
    disposedCount: () => disposed,
    listeners,
    agents,
    registered,
    systemPrompt,
    sectionRegistrations,
    sectionsDisposedCount: () => sectionsDisposed,
    /**
     * Undo every effect this mount registered, newest first — the unmount path
     * cordis takes when the plugin's fiber is disposed. It exists so a test can
     * assert "nothing this mount registered outlives the unmount", which is
     * criterion 1 of g-014 for the section registration.
     */
    unmount() {
      for (const disposer of cleanups.splice(0).reverse()) disposer();
    },
  };
}

/** Call the prefix route with a request double. */
async function call(route, options = {}) {
  const res = makeResponse();
  await route.handler(makeRequest(options), res);
  return res;
}

/** Parse a response body. */
function json(res) {
  return JSON.parse(res.body);
}

/** The user layer's config path for the current temp DSH_HOME. */
function userPath() {
  return join(home, 'prompt-setting', 'overrides.json');
}

/** Write a raw file, creating its directory. */
function writeRaw(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** SHA-256 of a file, or `missing` — the byte-identity assertion's currency. */
function sha256(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'missing';
}

/** Create one workspace directory with a config file and return its registry row. */
function workspaceWith(id, sessionId, config) {
  const root = join(home, id);
  mkdirSync(root, { recursive: true });
  if (config !== undefined) {
    mkdirSync(join(root, '.dsh-prompt-setting'), { recursive: true });
    writeFileSync(
      join(root, '.dsh-prompt-setting', 'overrides.json'),
      JSON.stringify(config),
      { encoding: 'utf8', flag: 'w' },
    );
  }
  return { id, path: root, title: id, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', sessionIds: [sessionId] };
}

test('host: injects webServer, connection and the hard systemPrompt dependency', () => {
  assert.deepEqual(inject, ['webServer', 'connection', 'systemPrompt']);
});

test('host: one prefix route owns the /prompt-setting prefix and both effects dispose', () => {
  const harness = mount();
  assert.equal(harness.routes.length, 1);
  assert.equal(harness.route.kind, 'prefix');
  assert.equal(harness.route.path, '/prompt-setting');
});

test('host: GET /prompt-setting/ping reports the renderer and the live client build stamp', async () => {
  const { route } = mount();
  const res = await call(route);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  const payload = json(res);
  assert.deepEqual(Object.keys(payload).sort(), [
    'clientBuild',
    'clientRenderer',
    'clientReportedAt',
    'ok',
    'plugin',
    'time',
    'version',
  ]);
  assert.equal(payload.ok, true);
  assert.equal(payload.clientRenderer, null);

  // The stamp is the digest of the bytes on disk *now*, so an independent
  // recomputation of the real file must agree field for field — a constant, a
  // stale copy or a different algorithm would all show up here.
  const bytes = readFileSync(CLIENT_PATH, 'utf8');
  const oracle = independentBuildFingerprint(bytes);
  assert.notEqual(oracle, null, 'the published bundle carries a usable marker region');
  assert.deepEqual(payload.clientBuild, {
    hash: oracle.hash,
    size: oracle.size,
    mtime: statSync(CLIENT_PATH).mtime.toISOString(),
  });
  assert.match(payload.clientBuild.hash, /^[0-9a-f]{8}$/);
  // Two probes answer the same thing while the file is unchanged.
  assert.deepEqual(json(await call(route)).clientBuild, payload.clientBuild);

  const reported = json(await call(route, { url: `${PING_PATH}?renderer=primitives` }));
  assert.equal(reported.clientRenderer, 'primitives');
  assert.equal(json(await call(route, { url: `${PING_PATH}?renderer=../../etc/passwd` })).clientRenderer, 'primitives');
});

test('host: the build stamp is re-read on every ping, and is null when the bundle is unreadable', async () => {
  // Mount a *copy* of the package: the only honest way to prove "no cache" is
  // to change the bytes the host serves between two probes, and the real
  // `client.js` must never be edited by a test.
  const copyRoot = mkdtempSync(join(tmpdir(), 'dsh-prompt-setting-build-'));
  try {
    for (const file of ['index.js', 'client.js', 'package.json']) {
      copyFileSync(join(PACKAGE_ROOT, file), join(copyRoot, file));
    }
    mkdirSync(join(copyRoot, 'core'));
    for (const file of readdirSync(join(PACKAGE_ROOT, 'core'))) {
      copyFileSync(join(PACKAGE_ROOT, 'core', file), join(copyRoot, 'core', file));
    }
    const copiedClient = join(copyRoot, 'client.js');
    const copiedHost = await import(pathToFileURL(join(copyRoot, 'index.js')).href);
    const { route } = mount({ host: copiedHost.apply });

    const first = json(await call(route));
    const bytes = readFileSync(copiedClient, 'utf8');
    assert.deepEqual(first.clientBuild.hash, independentBuildFingerprint(bytes).hash);

    // One character, same length, inside the region.
    const at = bytes.indexOf(BUILD_BEGIN) + BUILD_BEGIN.length + 100;
    const edited = `${bytes.slice(0, at)}${bytes[at] === 'x' ? 'y' : 'x'}${bytes.slice(at + 1)}`;
    writeFileSync(copiedClient, edited, 'utf8');
    const second = json(await call(route));
    assert.equal(second.clientBuild.size, first.clientBuild.size, 'the edit is length-preserving');
    assert.notEqual(
      second.clientBuild.hash,
      first.clientBuild.hash,
      'a changed bundle must change the next ping: a cached stamp would not',
    );
    assert.equal(second.clientBuild.hash, independentBuildFingerprint(edited).hash);

    // A bundle that cannot be read is「未知」— a 200 with `clientBuild: null`,
    // never a 500 and never a fabricated digest (which would read as「过期」).
    rmSync(copiedClient);
    const missing = await call(route);
    assert.equal(missing.statusCode, 200);
    assert.equal(json(missing).clientBuild, null);
    assert.equal(json(missing).ok, true);
  } finally {
    rmSync(copyRoot, { recursive: true, force: true });
  }
});

test('host: method, path and fence failure modes are unchanged for every route', async () => {
  const { route } = mount();
  const rejected = await call(route, { method: 'POST' });
  assert.equal(rejected.statusCode, 405);
  assert.equal(rejected.headers.allow, 'GET');

  const unknown = await call(route, { url: '/prompt-setting/nope' });
  assert.equal(unknown.statusCode, 404);
  assert.equal(json(unknown).code, 'not-found');

  const fenced = await call(mount({ requestRejection: () => 403 }).route);
  assert.equal(fenced.statusCode, 403);
  assert.equal(fenced.body, '');

  const unfenced = await call(mount({ omitConnection: true }).route);
  assert.equal(unfenced.statusCode, 503);
  assert.equal(json(unfenced).code, 'trust-fence-unavailable');

  // A wrong method never records a renderer report.
  const bad = await call(route, { method: 'POST', url: `${PING_PATH}?renderer=fallback` });
  assert.equal(bad.statusCode, 405);
  assert.equal(json(await call(route)).clientRenderer, null);
});

test('host: wrong methods on the new routes answer 405 with the full allow list', async () => {
  const { route } = mount();
  const snapshot = await call(route, { method: 'POST', url: SNAPSHOT_PATH });
  assert.equal(snapshot.statusCode, 405);
  assert.equal(snapshot.headers.allow, 'GET');
  const overrides = await call(route, { method: 'POST', url: OVERRIDES_PATH });
  assert.equal(overrides.statusCode, 405);
  assert.equal(overrides.headers.allow, 'GET, PUT, DELETE');
});

test('snapshot: reports the base and effective sections in the real assembly order', async () => {
  const { route } = mount();
  const res = await call(route, { url: SNAPSHOT_PATH });
  assert.equal(res.statusCode, 200);
  const payload = json(res);
  assert.equal(payload.ok, true);
  assert.equal(payload.mounted, true);
  assert.equal(Number.isNaN(Date.parse(payload.generatedAt)), false);
  assert.deepEqual(Object.keys(payload).sort(), [
    'base', 'effective', 'experiments', 'frozen', 'frozenReason', 'frozenScope', 'frozenScopeReason',
    'frozenSection', 'generatedAt', 'layers', 'mounted', 'ok', 'rendered', 'renderedResolved',
    'unresolvedLiteral', 'unresolvedThrowing', 'unresolvedVariables',
  ]);
  // No ?session=: the verdict describes the unscoped assembly, and it says so.
  assert.equal(payload.frozenScope, 'global');
  assert.equal(payload.frozenScopeReason, null);

  assert.deepEqual(payload.base.sections.map((section) => section.name), globalNames());
  assert.deepEqual(payload.base.sections.map((section) => section.index), [0, 1, 2, 3, 4, 5]);
  // No override is registered, so the effective view mirrors the base and every
  // section is overridable. `complete: false` is PROVEN here: a multi-section
  // assembly means no complete section is active (one would collapse it to one).
  // The plugin's own section is part of the view — it renders to nothing, which
  // is exactly why the `rendered` assertion below is unchanged by Revision 7.
  assert.deepEqual(payload.effective.sections.map((section) => [section.name, section.index, section.applied, section.action]), [
    ['harness:identity', 0, false, null],
    ['deployment:persona-prefix', 1, false, null],
    ['project:alpha', 2, false, null],
    ['project:beta', 3, false, null],
    ['deployment:persona-suffix', 4, false, null],
    [CUSTOM_SECTION_NAME, 5, false, null],
  ]);
  assert.deepEqual(payload.base.sections.map((section) => section.complete), [false, false, false, false, false, false]);
  assert.equal(payload.effective.sections.every((section) => section.overridable === true), true);
  assert.equal(payload.effective.sections.every((section) => section.reason === null), true);
  assert.equal(payload.rendered, 'You are an AI agent powered by DeepSeek Harness.\n\nALPHA BODY\n\nBETA BODY');
  assert.equal(payload.frozen, false);
  assert.equal(payload.frozenSection, null);
  assert.equal(payload.frozenReason, null);
});

test('snapshot: no ?session= disables the workspace layer with an explained reason', async () => {
  const { route } = mount({ workspaces: [workspaceWith('ws', 's1', { version: 1, overrides: [{ name: 'project:alpha', action: 'hide' }] })] });
  const payload = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.deepEqual(payload.layers.user.enabled, true);
  assert.equal(payload.layers.user.path, userPath());
  assert.equal(payload.layers.user.reason, null);
  assert.equal(payload.layers.workspace.enabled, false);
  assert.equal(payload.layers.workspace.path, null);
  assert.match(payload.layers.workspace.reason, /no \?session=/);
  assert.equal(payload.effective.sections.some((section) => section.name === 'project:alpha' && section.applied), false);
});

test('snapshot: an unresolvable session explains the workspace layer instead of guessing a path', async () => {
  const { route } = mount({ workspaces: [workspaceWith('ws', 's1', { version: 1, overrides: [] })] });
  const payload = json(await call(route, { url: `${SNAPSHOT_PATH}?session=ghost` }));
  assert.equal(payload.layers.workspace.enabled, false);
  assert.match(payload.layers.workspace.reason, /no workspace owns session "ghost"/);
});

test('D1: a complete section registered in the SESSION scope freezes that session, not the global view', async () => {
  // The real shape: a preset registers a standing scope, the session's agent
  // scope is composed under it, and `complete` is inherited through the chain.
  const presetScope = {};
  const agent = { id: 'locked-session' };
  const { route } = mount({
    agents: [agent],
    scopes: [
      { key: presetScope, sections: [{ name: 'preset:locked', order: 500, text: 'LOCKED BODY', complete: true }] },
      { key: agent, parent: presetScope, sections: [{ name: 'session:own', order: 600, text: 'SESSION BODY' }] },
    ],
  });

  const session = json(await call(route, { url: `${SNAPSHOT_PATH}?session=locked-session` }));
  assert.equal(session.frozenScope, 'session');
  assert.equal(session.frozenScopeReason, null);
  assert.equal(session.frozen, true);
  assert.equal(session.frozenSection, 'preset:locked');
  assert.match(session.frozenReason, /single complete section "preset:locked"/);
  assert.equal(session.rendered, 'LOCKED BODY');
  // The scoped sections are visible, and none claims to be overridable.
  assert.equal(session.base.sections.some((section) => section.name === 'preset:locked'), true);
  assert.equal(session.base.sections.some((section) => section.name === 'session:own'), true);
  assert.equal(session.base.sections.find((section) => section.name === 'preset:locked').complete, true);
  assert.equal(session.effective.sections.every((section) => section.overridable === false), true);

  // The SAME mount, without ?session=, must NOT report the session's freeze.
  const global = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.equal(global.frozenScope, 'global');
  assert.equal(global.frozen, false);
  assert.equal(global.frozenSection, null);
  assert.equal(global.rendered.includes('LOCKED BODY'), false);
  assert.equal(global.base.sections.some((section) => section.name === 'preset:locked'), false);
  assert.equal(global.effective.sections.every((section) => section.overridable === true), true);
});

test('D1: a session whose agent is not active says so instead of silently reporting the global view', async () => {
  const presetScope = {};
  const { route } = mount({
    agents: [],
    scopes: [{ key: presetScope, sections: [{ name: 'preset:locked', order: 500, text: 'LOCKED', complete: true }] }],
  });
  const payload = json(await call(route, { url: `${SNAPSHOT_PATH}?session=gone` }));
  assert.equal(payload.frozenScope, 'global');
  assert.equal(payload.frozen, false);
  assert.match(payload.frozenScopeReason, /no active agent/);
  assert.match(payload.frozenScopeReason, /would not be visible here/);
});

test('D1: a profile with no agents service also says so', async () => {
  const { route } = mount({ omitAgents: true });
  const payload = json(await call(route, { url: `${SNAPSHOT_PATH}?session=s1` }));
  assert.equal(payload.frozenScope, 'global');
  assert.match(payload.frozenScopeReason, /agents service is not available/);
});

test('D2a: a concurrent UNSCOPED assembly cannot steal the probe config', async () => {
  let nested = null;
  let armed = false;
  const harness = mount({
    beforeDispatch: async () => {
      // Run once, in the window between arming the probe and its dispatch.
      if (armed) return;
      armed = true;
      nested = await harness.ctx.systemPrompt.assemble();
    },
  });
  const payload = json(await call(harness.route, { url: SNAPSHOT_PATH }));

  assert.notEqual(nested, null, 'the concurrent assembly must actually have run');
  assert.deepEqual(nested.sections.map((section) => section.name), globalNames());
  assert.equal(
    nested.sections.some((section) => section.name.startsWith('__dsh-prompt-setting-probe__')),
    false,
    'the probe section must never leak into another caller assembly',
  );
  // And the probe's own observation is unaffected.
  assert.equal(payload.mounted, true);
  assert.equal(payload.frozen, false);
  assert.equal(payload.base.sections.length, globalNames().length);
});

test('D2b: a concurrent turn for the SAME agent cannot steal the session probe config', async () => {
  const agent = { id: 's1' };
  let nested = null;
  let armed = false;
  const harness = mount({
    agents: [agent],
    beforeDispatch: async (context) => {
      // A real turn for the same session: same scope object, NEW context object.
      if (armed || context?.scope !== agent) return;
      armed = true;
      nested = await harness.ctx.systemPrompt.assemble({ agent, scope: agent });
    },
  });
  const payload = json(await call(harness.route, { url: `${SNAPSHOT_PATH}?session=s1` }));

  assert.notEqual(nested, null, 'the concurrent turn must actually have run');
  assert.deepEqual(nested.sections.map((section) => section.name), globalNames());
  assert.equal(
    nested.sections.some((section) => section.name.startsWith('__dsh-prompt-setting-probe__')),
    false,
    'a real turn sharing the scope object must not receive the probe section',
  );
  assert.equal(payload.frozenScope, 'session');
  assert.equal(payload.mounted, true);
  assert.equal(payload.frozen, false);
  assert.equal(payload.base.sections.length, globalNames().length);
});

test('D2c: the probe consumes exactly one config, and only for its own context', async () => {
  const harness = mount();
  // Two sequential probes (as one snapshot runs) must not leak into a third,
  // unconsumed assembly.
  json(await call(harness.route, { url: SNAPSHOT_PATH }));
  const plain = await harness.ctx.systemPrompt.assemble();
  assert.deepEqual(plain.sections.map((section) => section.name), globalNames());
  const withEmptyContext = await harness.ctx.systemPrompt.assemble({});
  assert.deepEqual(
    withEmptyContext.sections.map((section) => section.name),
    globalNames(),
  );
});

test('snapshot: a profile with no workspaceRegistry disables only the workspace layer', async () => {
  const { route } = mount({ omitWorkspaceRegistry: true });
  const payload = json(await call(route, { url: `${SNAPSHOT_PATH}?session=s1` }));
  assert.equal(payload.layers.workspace.enabled, false);
  assert.match(payload.layers.workspace.reason, /workspaceRegistry service is not available/);
  assert.equal(payload.layers.user.enabled, true);
  assert.equal(payload.mounted, true);
});

test('snapshot: the workspace layer is applied and marked with its layer', async () => {
  const workspace = workspaceWith('ws', 's1', {
    version: 1,
    overrides: [{ name: 'project:alpha', action: 'replace', text: 'WS ALPHA' }],
  });
  const { route } = mount({ workspaces: [workspace] });
  const payload = json(await call(route, { url: `${SNAPSHOT_PATH}?session=s1` }));
  assert.equal(payload.layers.workspace.enabled, true);
  assert.equal(payload.layers.workspace.path, join(workspace.path, '.dsh-prompt-setting', 'overrides.json'));
  assert.equal(payload.layers.workspace.reason, null);
  const alpha = payload.effective.sections.find((section) => section.name === 'project:alpha');
  assert.deepEqual([alpha.text, alpha.applied, alpha.action, alpha.overrideLayer, alpha.overridable], [
    'WS ALPHA', true, 'replace', 'workspace', true,
  ]);
  assert.match(payload.rendered, /WS ALPHA/);
  assert.doesNotMatch(payload.rendered, /ALPHA BODY/);
});

test('snapshot: replace, hide and append all show up in the effective view', async () => {
  const workspace = workspaceWith('ws', 's1', {
    version: 1,
    overrides: [
      { name: 'project:alpha', action: 'replace', text: 'NEW ALPHA' },
      { name: 'project:beta', action: 'hide' },
      { name: 'project:gamma', action: 'append', text: 'GAMMA', order: 0 },
    ],
  });
  const { route } = mount({ workspaces: [workspace] });
  const payload = json(await call(route, { url: `${SNAPSHOT_PATH}?session=s1` }));
  assert.deepEqual(payload.effective.sections.map((section) => [section.name, section.index, section.applied, section.action]), [
    ['project:gamma', 0, true, 'append'],
    ['harness:identity', 1, false, null],
    ['deployment:persona-prefix', 2, false, null],
    ['project:alpha', 3, true, 'replace'],
    ['deployment:persona-suffix', 4, false, null],
    // The plugin's own section is registered last and no override targets it,
    // so it sits at its real index, empty and unapplied.
    [CUSTOM_SECTION_NAME, 5, false, null],
    // The hidden section is still reported, with its original text and a null index.
    ['project:beta', null, true, 'hide'],
  ]);
  assert.equal(payload.effective.sections.at(-1).text, 'BETA BODY');
  assert.equal(payload.rendered.includes('BETA BODY'), false);
  assert.match(payload.rendered, /^GAMMA\n\nYou are an AI agent/);
});

test('snapshot: the workspace layer overrides the user layer for the same section', async () => {
  const workspace = workspaceWith('ws', 's1', {
    version: 1,
    overrides: [{ name: 'project:alpha', action: 'replace', text: 'WS ALPHA' }],
  });
  // The user layer's `project:alpha` entry can only be a pre-Revision-7 one, so
  // it is seeded the way the escape hatch documents: a hand edit of the file.
  // The write route still sees it (read-only) and a reserved-name write joins it.
  writeUserConfig([{ name: 'project:alpha', action: 'replace', text: 'USER ALPHA' }]);
  const { route } = mount({ workspaces: [workspace] });
  const put = await call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    body: JSON.stringify({ layer: 'user', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' } }),
  });
  assert.equal(put.statusCode, 200);

  const read = json(await call(route, { url: `${OVERRIDES_PATH}?session=s1` }));
  assert.deepEqual(read.merged.overrides.map((entry) => [entry.name, entry.layer, entry.text]), [
    ['project:alpha', 'workspace', 'WS ALPHA'],
    [CUSTOM_SECTION_NAME, 'user', 'MINE'],
  ]);
  assert.deepEqual(read.user.overrides, [
    { name: 'project:alpha', action: 'replace', text: 'USER ALPHA' },
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
  ]);
  assert.deepEqual(read.workspace.overrides, [{ name: 'project:alpha', action: 'replace', text: 'WS ALPHA' }]);

  const alpha = json(await call(route, { url: `${SNAPSHOT_PATH}?session=s1` }))
    .effective.sections.find((section) => section.name === 'project:alpha');
  assert.deepEqual([alpha.text, alpha.overrideLayer], ['WS ALPHA', 'workspace']);

  // Without a session the same user-layer override is the one that applies.
  const alone = json(await call(route, { url: SNAPSHOT_PATH }))
    .effective.sections.find((section) => section.name === 'project:alpha');
  assert.deepEqual([alone.text, alone.overrideLayer], ['USER ALPHA', 'user']);
});

test('snapshot: a complete section is reported as frozen, with no silent failure', async () => {
  const sections = [...DEFAULT_SECTIONS, { name: 'preset:locked', order: 500, text: 'LOCKED BODY', complete: true }];
  const workspace = workspaceWith('ws', 's1', {
    version: 1,
    overrides: [
      { name: 'preset:locked', action: 'replace', text: 'IGNORED' },
      { name: 'project:alpha', action: 'hide' },
    ],
  });
  const { route } = mount({ sections, workspaces: [workspace] });
  const payload = json(await call(route, { url: `${SNAPSHOT_PATH}?session=s1` }));
  assert.equal(payload.frozen, true);
  assert.equal(payload.frozenSection, 'preset:locked');
  assert.match(payload.frozenReason, /single complete section "preset:locked"/);
  assert.equal(payload.rendered, 'LOCKED BODY');
  // Every registered section is still listed — the fixture's five, the complete
  // one, and the plugin's own registration — and none claims to be overridable.
  assert.equal(payload.base.sections.length, sections.length + 1);
  assert.equal(payload.base.sections.at(-1).name, CUSTOM_SECTION_NAME);
  assert.equal(payload.effective.sections.every((section) => section.overridable === false), true);
  // The discarded replace is explicit, not silent.
  const locked = payload.effective.sections.find((section) => section.name === 'preset:locked');
  assert.deepEqual([locked.text, locked.applied, locked.action, locked.overrideLayer], ['LOCKED BODY', false, 'replace', 'workspace']);
  assert.match(locked.reason, /single complete section/);
  // `complete` is now proven, not guessed.
  assert.equal(payload.base.sections.find((section) => section.name === 'preset:locked').complete, true);
  assert.equal(payload.base.sections.find((section) => section.name === 'project:alpha').complete, false);
});

test('snapshot: a scope whose only section is complete is caught by the probe alone', async () => {
  const sections = [{ name: 'preset:only', order: 100, text: 'ONLY BODY', complete: true }];
  const { route } = mount({ sections });
  const clean = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.equal(clean.frozen, true);
  assert.equal(clean.frozenSection, 'preset:only');
  assert.match(clean.frozenReason, /single complete section "preset:only"/);
  const only = clean.effective.sections.find((section) => section.name === 'preset:only');
  assert.deepEqual([only.text, only.applied, only.overridable], ['ONLY BODY', false, false]);
  assert.equal(clean.base.sections.find((section) => section.name === 'preset:only').complete, true);
});

test('snapshot: the probe section never leaks into the rendered prompt', async () => {
  const { route } = mount();
  const payload = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.equal(payload.rendered.includes('probe'), false);
  assert.equal(payload.base.sections.some((section) => section.name.includes('probe')), false);
  assert.equal(payload.effective.sections.some((section) => section.name.includes('probe')), false);
  // The probe is a read-only observation: nothing was written for it.
  assert.deepEqual(json(await call(route, { url: OVERRIDES_PATH })).user.overrides, []);
  assert.throws(() => readFileSync(userPath(), 'utf8'), /ENOENT/);
});

test('snapshot: sections missing from the render are listed instead of silently vanishing', async () => {
  const sections = [{ name: 'preset:only', order: 100, text: 'ONLY BODY', complete: true }];
  const { route } = mount({ sections: [...sections, { name: 'twin', order: 200, text: 'TWIN' }] });
  const payload = json(await call(route, { url: SNAPSHOT_PATH }));
  const twin = payload.effective.sections.find((section) => section.name === 'twin');
  assert.equal(twin.index, null);
  assert.equal(twin.overridable, false);
  assert.match(twin.reason, /single complete section "preset:only"/);
});

test('overrides GET: both layers plus the merged list', async () => {
  const workspace = workspaceWith('ws', 's1', {
    version: 1,
    overrides: [{ name: 'project:beta', action: 'hide' }],
  });
  const { route } = mount({ workspaces: [workspace] });
  const payload = json(await call(route, { url: `${OVERRIDES_PATH}?session=s1` }));
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.user, { layer: 'user', enabled: true, path: userPath(), reason: null, overrides: [] });
  assert.equal(payload.workspace.enabled, true);
  assert.deepEqual(payload.workspace.overrides, [{ name: 'project:beta', action: 'hide' }]);
  assert.deepEqual(payload.merged.overrides.map((entry) => [entry.name, entry.layer]), [['project:beta', 'workspace']]);
});

test('overrides PUT: writes the reserved section atomically and takes effect on the next assembly', async () => {
  const { route } = mount();
  const res = await call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    body: JSON.stringify({ layer: 'user', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'EDITED' } }),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), {
    ok: true,
    saved: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'EDITED', layer: 'user' },
    effectiveFrom: 'next-turn',
  });
  // The file on disk is the durable truth.
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')), {
    version: 1,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'EDITED' }],
  });
  // And the very next assembly sees it, from the in-memory cache: the section
  // carries the text byte for byte and sits LAST in the assembly, because its
  // registered order (1000000) is above every fixture order.
  const payload = json(await call(route, { url: SNAPSHOT_PATH }));
  const custom = payload.effective.sections.find((section) => section.name === CUSTOM_SECTION_NAME);
  assert.deepEqual([custom.text, custom.applied, custom.overrideLayer], ['EDITED', true, 'user']);
  assert.equal(payload.base.sections.at(-1).name, CUSTOM_SECTION_NAME);
  assert.equal(payload.rendered.endsWith('\n\nEDITED'), true, 'the text lands at the very end of the prompt');
});

test('overrides PUT: a second save upserts the reserved entry and never disturbs a frozen one', async () => {
  // A pre-Revision-7 entry is in the layer. The narrowed write face can neither
  // update nor delete it, and must not disturb it.
  writeUserConfig([{ name: 'project:beta', action: 'hide' }]);
  const { route } = mount();
  const put = (section) => call(route, { method: 'PUT', url: OVERRIDES_PATH, body: JSON.stringify({ layer: 'user', section }) });
  assert.equal((await put({ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'ONE' })).statusCode, 200);
  assert.equal((await put({ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'TWO' })).statusCode, 200);
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')).overrides, [
    { name: 'project:beta', action: 'hide' },
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'TWO' },
  ]);
});

test('overrides PUT: workspace layer resolves through the Host session index, never a client path', async () => {
  const workspace = workspaceWith('ws', 's1');
  const { route } = mount({ workspaces: [workspace] });
  const res = await call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    body: JSON.stringify({ layer: 'workspace', session: 's1', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'WS MINE' } }),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res).saved, { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'WS MINE', layer: 'workspace' });
  const written = join(workspace.path, '.dsh-prompt-setting', 'overrides.json');
  assert.deepEqual(JSON.parse(readFileSync(written, 'utf8')).overrides, [
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'WS MINE' },
  ]);

  // A client-supplied path is not a parameter at all: an unknown session fails.
  const ghost = await call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    body: JSON.stringify({ layer: 'workspace', session: 'ghost', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'x' } }),
  });
  assert.equal(ghost.statusCode, 400);
  assert.equal(json(ghost).code, 'workspace-unresolved');
});

test('overrides PUT: every rejection is a readable 4xx and never touches the disk', async () => {
  const { route } = mount();
  const put = (body) => call(route, { method: 'PUT', url: OVERRIDES_PATH, body });
  const reserved = CUSTOM_SECTION_NAME;
  const cases = [
    // Request shape: the same 400s as Revision 6, evaluated identically.
    ['{ not json', 400, 'invalid-json'],
    [JSON.stringify({ section: { name: reserved, action: 'replace', text: 'x' } }), 400, 'unknown-layer'],
    [JSON.stringify({ layer: 'global', section: { name: reserved, action: 'replace', text: 'x' } }), 400, 'unknown-layer'],
    [JSON.stringify({ layer: 'user' }), 400, 'invalid-override'],
    [JSON.stringify({ layer: 'user', section: { action: 'replace', text: 'x' } }), 400, 'missing-name'],
    [JSON.stringify({ layer: 'user', section: { name: reserved, action: 'replace' } }), 400, 'missing-text'],
    [JSON.stringify({ layer: 'workspace', section: { name: reserved, action: 'replace', text: 'x' } }), 400, 'workspace-unresolved'],
    [JSON.stringify({ layer: 'user', section: { name: reserved, action: 'replace', text: 'x'.repeat(204801) } }), 413, 'text-too-large'],
    ['x'.repeat(300 * 1024), 413, 'body-too-large'],
    // Revision 7's write lock: any other name, whatever else the body says. The
    // name check precedes every field-level rule, so a legacy name never answers
    // a field error — it answers the wall.
    [JSON.stringify({ layer: 'user', section: { name: 'a', action: 'replace', text: 'x' } }), 403, 'write-locked'],
    [JSON.stringify({ layer: 'user', section: { name: 'a', action: 'hide' } }), 403, 'write-locked'],
    [JSON.stringify({ layer: 'user', section: { name: 'a', action: 'explode' } }), 403, 'write-locked'],
    [JSON.stringify({ layer: 'user', section: { name: 'a', action: 'replace' } }), 403, 'write-locked'],
    [JSON.stringify({ layer: 'user', section: { name: 'a', action: 'hide', text: 'x' } }), 403, 'write-locked'],
    [JSON.stringify({ layer: 'user', section: { name: 'a', action: 'append', text: 'x', order: -2 } }), 403, 'write-locked'],
    [JSON.stringify({ layer: 'user', section: { name: 'a'.repeat(201), action: 'hide' } }), 403, 'write-locked'],
    // … and the reserved name accepts exactly one action.
    [JSON.stringify({ layer: 'user', section: { name: reserved, action: 'hide' } }), 400, 'unsupported-action'],
    [JSON.stringify({ layer: 'user', section: { name: reserved, action: 'append', text: 'x' } }), 400, 'unsupported-action'],
    [JSON.stringify({ layer: 'user', section: { name: reserved, action: 'explode', text: 'x' } }), 400, 'unsupported-action'],
    [JSON.stringify({ layer: 'user', section: { name: reserved } }), 400, 'unsupported-action'],
  ];
  for (const [body, status, code] of cases) {
    const res = await put(body);
    assert.equal(res.statusCode, status, `body ${body.slice(0, 40)}`);
    const payload = json(res);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, code);
    assert.equal(typeof payload.message, 'string');
    assert.ok(payload.message.length > 0);
  }
  assert.throws(() => readFileSync(userPath(), 'utf8'), /ENOENT/, 'no rejected write may create a file');
  // The 403 message names the one writable section, so a caller can act on it.
  const locked = json(await put(JSON.stringify({ layer: 'user', section: { name: 'a', action: 'replace', text: 'x' } })));
  assert.ok(locked.message.includes(reserved), `the write-lock message names ${reserved}: ${locked.message}`);
});

test('overrides DELETE: removes the reserved override, and reports a miss as 404', async () => {
  const { route } = mount();
  await call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    body: JSON.stringify({ layer: 'user', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' } }),
  });
  const res = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&name=${encodeURIComponent(CUSTOM_SECTION_NAME)}` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { ok: true, removed: true, layer: 'user', name: CUSTOM_SECTION_NAME, effectiveFrom: 'next-turn' });
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')).overrides, []);

  const again = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&name=${encodeURIComponent(CUSTOM_SECTION_NAME)}` });
  assert.equal(again.statusCode, 404);
  assert.equal(json(again).code, 'override-not-found');

  // A legacy name is refused by the write lock, and that verdict is reached
  // BEFORE the presence lookup: the entry below really does exist, so a 404
  // would be a lie about why nothing was removed.
  writeUserConfig([{ name: 'a', action: 'hide' }]);
  const locked = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&name=a` });
  assert.equal(locked.statusCode, 403);
  assert.equal(json(locked).code, 'write-locked');
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')).overrides, [{ name: 'a', action: 'hide' }], 'and it removed nothing');
  const lockedMiss = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&name=never-existed` });
  assert.equal(lockedMiss.statusCode, 403, '403 before 404, present or not');
  assert.equal(json(lockedMiss).code, 'write-locked');

  const noName = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user` });
  assert.equal(noName.statusCode, 400);
  assert.equal(json(noName).code, 'missing-name');

  const tooLong = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&name=${'a'.repeat(201)}` });
  assert.equal(tooLong.statusCode, 400, 'a name this route could never act on is still a shape error');
  assert.equal(json(tooLong).code, 'name-too-long');

  const noLayer = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?name=a` });
  assert.equal(noLayer.statusCode, 400);
  assert.equal(json(noLayer).code, 'unknown-layer');
});

test('overrides: the write lock is checked before anything can be written, proven by SHA-256', async () => {
  // A layer with content, so "unchanged" is a claim about real bytes rather
  // than about the absence of a file.
  writeUserConfig([
    { name: 'project:alpha', action: 'replace', text: 'KEEP ME' },
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
  ]);
  const workspace = workspaceWith('ws-lock', 's-lock', {
    version: 1,
    overrides: [{ name: 'project:beta', action: 'hide' }],
  });
  const { route } = mount({ workspaces: [workspace] });
  const workspaceFile = join(workspace.path, '.dsh-prompt-setting', 'overrides.json');
  const paths = [userPath(), workspaceFile];
  const before = Object.fromEntries(paths.map((path) => [path, sha256(path)]));

  const rejected = [
    ['PUT', OVERRIDES_PATH, JSON.stringify({ layer: 'user', section: { name: 'project:alpha', action: 'replace', text: 'HIJACK' } }), 403],
    ['PUT', OVERRIDES_PATH, JSON.stringify({ layer: 'user', section: { name: 'project:alpha', action: 'hide' } }), 403],
    ['PUT', OVERRIDES_PATH, JSON.stringify({ layer: 'workspace', session: 's-lock', section: { name: 'project:beta', action: 'replace', text: 'HIJACK' } }), 403],
    ['PUT', OVERRIDES_PATH, JSON.stringify({ layer: 'user', section: { name: CUSTOM_SECTION_NAME, action: 'append', text: 'x' } }), 400],
    ['PUT', OVERRIDES_PATH, JSON.stringify({ layer: 'workspace', session: 's-lock', section: { name: CUSTOM_SECTION_NAME, action: 'hide' } }), 400],
    ['DELETE', `${OVERRIDES_PATH}?layer=user&name=project%3Aalpha`, undefined, 403],
    ['DELETE', `${OVERRIDES_PATH}?layer=user&name=never-existed`, undefined, 403],
    ['DELETE', `${OVERRIDES_PATH}?layer=workspace&session=s-lock&name=project%3Abeta`, undefined, 403],
    ['DELETE', `${OVERRIDES_PATH}?layer=user&reset=true&legacy=true`, undefined, 400],
  ];
  for (const [method, url, body, status] of rejected) {
    const res = await call(route, { method, url, body });
    assert.equal(res.statusCode, status, `${method} ${url}`);
    assert.deepEqual(
      Object.fromEntries(paths.map((path) => [path, sha256(path)])),
      before,
      `${method} ${url} must leave both layers byte-identical`,
    );
  }

  // The reserved name still writes, and only its own entry changes.
  const ok = await call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    body: JSON.stringify({ layer: 'user', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'NEW' } }),
  });
  assert.equal(ok.statusCode, 200);
  assert.notEqual(sha256(userPath()), before[userPath()], 'a legal write does change the file');
  assert.equal(sha256(workspaceFile), before[workspaceFile], 'and only the layer it targeted');
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')).overrides, [
    { name: 'project:alpha', action: 'replace', text: 'KEEP ME' },
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'NEW' },
  ]);
});

test('layers: a corrupt user file disables that layer, is explained, and never breaks assembly', async () => {
  writeRaw(userPath(), '{ this is not json');
  const { route } = mount();
  const payload = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.equal(payload.mounted, true, 'the engine still runs');
  assert.equal(payload.layers.user.enabled, false);
  assert.equal(payload.layers.user.path, userPath());
  assert.match(payload.layers.user.reason, /invalid-json/);
  assert.deepEqual(payload.base.sections.length, globalNames().length, 'the assembly is untouched');

  const refused = await call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    body: JSON.stringify({ layer: 'user', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'x' } }),
  });
  assert.equal(refused.statusCode, 409);
  assert.equal(json(refused).code, 'layer-not-writable');
  assert.equal(readFileSync(userPath(), 'utf8'), '{ this is not json', 'the unreadable file is preserved');
});

test('layers: a corrupt workspace file disables only that workspace layer', async () => {
  const workspace = workspaceWith('ws', 's1');
  mkdirSync(join(workspace.path, '.dsh-prompt-setting'), { recursive: true });
  writeFileSync(join(workspace.path, '.dsh-prompt-setting', 'overrides.json'), 'nope', 'utf8');
  const { route } = mount({ workspaces: [workspace] });
  const payload = json(await call(route, { url: `${SNAPSHOT_PATH}?session=s1` }));
  assert.equal(payload.layers.workspace.enabled, false);
  assert.match(payload.layers.workspace.reason, /invalid-json/);
  assert.equal(payload.layers.user.enabled, true);
  assert.deepEqual(payload.base.sections.length, globalNames().length);
});

test('assembly: a real scoped turn resolves its workspace layer from the agent scope, with no route involved', async () => {
  const workspace = workspaceWith('ws', 's1', {
    version: 1,
    overrides: [{ name: 'project:beta', action: 'hide' }],
  });
  const other = workspaceWith('other', 's2', {
    version: 1,
    overrides: [{ name: 'project:alpha', action: 'hide' }],
  });
  const { ctx } = mount({ workspaces: [workspace, other] });

  const scoped = await ctx.systemPrompt.assemble({ agent: { id: 's1' }, scope: { marker: 'a' } });
  assert.deepEqual(scoped.sections.map((section) => section.name).includes('project:beta'), false);
  assert.equal(scoped.sections.some((section) => section.name === 'project:alpha'), true);

  const second = await ctx.systemPrompt.assemble({ agent: { id: 's2' }, scope: { marker: 'b' } });
  assert.equal(second.sections.some((section) => section.name === 'project:alpha'), false);
  assert.equal(second.sections.some((section) => section.name === 'project:beta'), true);

  const anonymous = await ctx.systemPrompt.assemble();
  assert.deepEqual(anonymous.sections.map((section) => section.name), globalNames());
});

test('assembly: with no overrides configured the assembly comes back BY IDENTITY', async () => {
  const { ctx, listeners } = mount();
  // Two listeners since Revision 8, in waterfall order: the `prepend`ed keeper
  // is outermost, the override listener keeps the registration position it had.
  assert.deepEqual(
    listeners.map((listener) => [listener.name, listener.options?.prepend === true]),
    [['system-prompt/assemble', true], ['system-prompt/assemble', false]],
  );
  // The innermost listener is handed the raw assembly the service built and
  // gives it straight back; the value the caller receives is therefore the very
  // same object only if neither listener copied it on the way out.
  let innermost = null;
  ctx.on('system-prompt/assemble', (assembly, context, next) => {
    innermost = assembly;
    return next();
  });
  const plain = await ctx.systemPrompt.assemble();
  assert.notEqual(innermost, null, 'the observer really ran');
  assert.equal(plain, innermost, 'the untouched assembly arrives by identity, through both listeners');
  assert.deepEqual(plain.sections.map((section) => section.name), globalNames());
  assert.equal(Object.hasOwn(plain, 'order'), false);
});

test('snapshot: a failed assembly is a 503 with a code, not an empty success', async () => {
  const { ctx, route } = mount();
  const original = ctx.systemPrompt.assemble;
  ctx.systemPrompt.assemble = async () => {
    throw new Error('registry is broken');
  };
  try {
    const res = await call(route, { url: SNAPSHOT_PATH });
    assert.equal(res.statusCode, 503);
    assert.equal(json(res).code, 'assemble-failed');
    assert.match(json(res).message, /registry is broken/);
  } finally {
    ctx.systemPrompt.assemble = original;
  }
});

test('snapshot: experiments carries the measured E1-E5 conclusions, not placeholders', async () => {
  const { route } = mount();
  const payload = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.deepEqual(Object.keys(payload.experiments), ['E1', 'E2', 'E3', 'E4', 'E5']);
  for (const value of Object.values(payload.experiments)) {
    assert.equal(typeof value, 'string');
    assert.ok(value.length > 40, 'each conclusion must actually say something');
  }
  assert.match(payload.experiments.E3, /complete:true/);
  assert.match(payload.experiments.E4, /scoped/);
});

test('F1: a third-party listener that appends a section is NOT read as a freeze', async () => {
  // Reproduces the live machine: registered=5, our probe appends one, and
  // another plugin appends a companion in its own listener. The old rule
  // ("the result is not registered.length + 1") called that a freeze and marked
  // every section non-overridable, so the whole panel became read-only.
  const { ctx, route, listeners } = mount();
  assert.equal(listeners.length, 2, 'the prepended keeper and the override listener are mounted');
  // Register the third party AFTER this plugin, so it runs inside our next().
  ctx.on('system-prompt/assemble', (assembly) => ({
    ...assembly,
    sections: [...assembly.sections, { name: 'dsh-expression:companion', text: 'COMPANION' }],
  }));

  const payload = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.equal(payload.mounted, true);
  assert.equal(payload.frozen, false, 'another plugin adding a section is normal');
  assert.equal(payload.frozenSection, null);
  assert.equal(payload.frozenReason, null);

  // Every untouched registered section must stay editable.
  const registered = payload.effective.sections.filter((section) => section.origin === 'registered');
  assert.equal(registered.length, globalNames().length);
  assert.equal(registered.every((section) => section.overridable === true), true);
  assert.equal(registered.every((section) => section.reason === null), true);

  // And the third-party section is distinguishable, at its real position.
  const companion = payload.effective.sections.find((section) => section.name === 'dsh-expression:companion');
  assert.deepEqual(
    [companion.index, companion.origin, companion.action, companion.applied, companion.overridable, companion.reason],
    [globalNames().length, 'downstream-added', null, false, true, null],
  );
  assert.equal(payload.base.sections.some((section) => section.name === 'dsh-expression:companion'), false);
  assert.equal(payload.base.sections.length, globalNames().length);
  assert.match(payload.rendered, /COMPANION$/);
});

test('F1: a third-party listener that also removes a section is still not a freeze', async () => {
  const { ctx, route } = mount();
  ctx.on('system-prompt/assemble', (assembly) => ({
    ...assembly,
    sections: assembly.sections.filter((section) => section.name !== 'project:beta'),
  }));
  const payload = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.equal(payload.frozen, false);
  const removed = payload.effective.sections.find((section) => section.name === 'project:beta');
  assert.deepEqual([removed.index, removed.origin, removed.overridable], [null, 'registered', false]);
  assert.match(removed.reason, /not present in the assembled result/);
});

test('F1: the real complete collapse is still reported after the survival-only rule', async () => {
  const sections = [...DEFAULT_SECTIONS, { name: 'preset:locked', order: 500, text: 'LOCKED', complete: true }];
  const { route } = mount({ sections });
  const payload = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.equal(payload.frozen, true);
  assert.equal(payload.frozenSection, 'preset:locked');
  assert.match(payload.frozenReason, /single complete section "preset:locked"/);
  assert.equal(payload.effective.sections.every((section) => section.overridable === false), true);
});

test('F2: unresolved variables are reported instead of rendered as "undefined"', async () => {
  const { route } = mount({
    sections: [
      { name: 'agent:identity', order: 100, text: 'You are a coding agent powered by the {{model}} model.' },
      { name: 'env:cwd', order: 200, text: 'Your working directory is {{cwd}}.' },
    ],
    variables: { model: undefined, cwd: undefined },
  });
  const payload = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.equal(payload.rendered.includes('undefined'), false);
  assert.equal(payload.rendered, 'You are a coding agent powered by the {{model}} model.\n\nYour working directory is {{cwd}}.');
  assert.equal(payload.renderedResolved, false);
  assert.deepEqual(payload.unresolvedVariables, ['cwd', 'model']);
});

test('F2: variables a provider did resolve render normally and are not reported', async () => {
  const { route } = mount({
    sections: [{ name: 'agent:identity', order: 100, text: 'powered by the {{model}} model in {{cwd}}' }],
    variables: { model: 'deepseek-flash', cwd: '/repo' },
  });
  const payload = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.equal(payload.rendered, 'powered by the deepseek-flash model in /repo');
  assert.equal(payload.renderedResolved, true);
  assert.deepEqual(payload.unresolvedVariables, []);
  assert.deepEqual(payload.unresolvedThrowing, []);
  assert.deepEqual(payload.unresolvedLiteral, []);
});

test('snapshot: an unresolved reference is graded by the section that carries it', async () => {
  const { route } = mount({
    sections: [
      { name: 'agent:identity', order: 100, text: 'powered by the {{model}} model' },
      { name: 'plugin:reserved', order: 900, text: 'keep {{not_registered}} literal', interpolate: false },
    ],
    variables: { model: undefined },
  });
  const payload = json(await call(route, { url: SNAPSHOT_PATH }));
  // The interpolating section THROWS in the real assembly; the reserved one is
  // handed to the model as written, so the two consequences are not the same.
  assert.deepEqual(payload.unresolvedThrowing, ['model']);
  assert.deepEqual(payload.unresolvedLiteral, ['not_registered']);
  assert.deepEqual(payload.unresolvedVariables, ['model'], 'the legacy field keeps its old value: the throwing set');
  assert.equal(payload.renderedResolved, false);
  assert.equal(payload.rendered.includes('undefined'), false);
  assert.equal(payload.rendered, 'powered by the {{model}} model\n\nkeep {{not_registered}} literal');
});

test('snapshot: a literal-only unresolved reference is graded literal and leaves resolved true', async () => {
  const { route } = mount({
    sections: [
      { name: 'agent:identity', order: 100, text: 'powered by the {{model}} model' },
      { name: 'plugin:reserved', order: 900, text: 'cwd is {{cwd}}', interpolate: false },
    ],
    variables: { model: 'deepseek-flash', cwd: undefined },
  });
  const payload = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.deepEqual(payload.unresolvedThrowing, [], 'nothing here can take the real assembly down');
  assert.deepEqual(payload.unresolvedLiteral, ['cwd']);
  assert.equal(payload.renderedResolved, true, 'the legacy verdict is unchanged: no throwing reference');
  assert.deepEqual(payload.unresolvedVariables, []);
  assert.equal(payload.rendered, 'powered by the deepseek-flash model\n\ncwd is {{cwd}}');
});

// #region external refresh (Revision 5)

/**
 * Both layers are re-read at the start of every handled route request
 * (CONTRACT §5.5): an external edit — a hand edit, a config-sync tool, another
 * process — is visible to the next request with no remount, while the assembly
 * path stays IO-free and reads only the cache those refreshes maintain.
 *
 * The failure-path half of this region exists because a real session showed an
 * override in effect at one turn and gone at a later one with the file
 * untouched. Nothing here claims to explain that observation (NOTES.md §13.7);
 * what it pins is that no request — successful or rejected — can leave the
 * in-memory cache disagreeing with the files for longer than that request.
 */
const ALPHA = 'project:alpha';
/** The import body cap from `index.js`; one byte over it is the 413 case. */
const IMPORT_CAP = 4 * 1024 * 1024;

/** Write the user layer's file the way an external writer would. */
function writeUserConfig(overrides) {
  writeRaw(userPath(), `${JSON.stringify({ version: 1, overrides }, null, 2)}\n`);
}

/** One override that replaces `project:alpha`. */
function alphaOverride(text) {
  return { name: ALPHA, action: 'replace', text };
}

/** The effective `project:alpha` entry of a snapshot payload. */
function effectiveAlpha(payload) {
  return payload.effective.sections.find((section) => section.name === ALPHA);
}

/**
 * Read what one assembly renders for `project:alpha` with no route involved.
 * The waterfall listener reads the in-memory cache and nothing else, so this is
 * the cache observed directly: no refresh runs on this path.
 */
async function assembleDirectly(ctx) {
  const assembly = await ctx.systemPrompt.assemble({ scope: {} });
  return assembly.sections.find((section) => section.name === ALPHA).text;
}

test('refresh: an external edit of the user layer reaches the very next request', async () => {
  const { route } = mount();
  assert.deepEqual(json(await call(route, { url: OVERRIDES_PATH })).user.overrides, []);

  // An external writer adds one override: no PUT, no remount, no watcher.
  writeUserConfig([alphaOverride('EXTERNAL EDIT')]);
  const snapshot = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.deepEqual(
    [snapshot.layers.user.enabled, snapshot.layers.user.reason, effectiveAlpha(snapshot).text, effectiveAlpha(snapshot).applied],
    [true, null, 'EXTERNAL EDIT', true],
  );
  assert.deepEqual(json(await call(route, { url: OVERRIDES_PATH })).user.overrides, [alphaOverride('EXTERNAL EDIT')]);

  // A second edit is seen too: the layer is re-read, not read once.
  writeUserConfig([alphaOverride('SECOND EDIT')]);
  assert.equal(effectiveAlpha(json(await call(route, { url: SNAPSHOT_PATH }))).text, 'SECOND EDIT');
});

test('refresh: the assembly path opens no file, so an external edit waits for a request', async () => {
  writeUserConfig([alphaOverride('FROM FILE')]);
  const { ctx, route } = mount();
  assert.equal(await assembleDirectly(ctx), 'FROM FILE');

  // The file changes on disk. Memory does not, because nothing on the assembly
  // path opens it — that is the invariant §5.5 states.
  writeUserConfig([alphaOverride('NEWER ON DISK')]);
  assert.equal(await assembleDirectly(ctx), 'FROM FILE', 'the listener must read the cache, never the file');

  // One handled request refreshes the cache. It does not have to succeed:
  // the refresh happens before the request can fail, which is what bounds a
  // desync to the request that failed.
  const refused = await call(route, { method: 'PUT', url: OVERRIDES_PATH, body: '{ not json' });
  assert.equal(refused.statusCode, 400);
  assert.equal(await assembleDirectly(ctx), 'NEWER ON DISK');
  assert.equal(effectiveAlpha(json(await call(route, { url: SNAPSHOT_PATH }))).text, 'NEWER ON DISK');
});

test('refresh: a failed write never leaves the cache at odds with the file', async () => {
  writeUserConfig([alphaOverride('FROM FILE')]);
  const { ctx, route } = mount();
  assert.equal(await assembleDirectly(ctx), 'FROM FILE');

  const exportDocument = JSON.stringify({
    schema: 'dsh-prompt-setting/export',
    version: 1,
    layers: { user: { layer: 'user', overrides: [{ name: 'a', action: 'nope', text: 'X' }] } },
  });
  const failures = [
    ['PUT', OVERRIDES_PATH, '{ not json', 400, 'invalid-json'],
    ['PUT', OVERRIDES_PATH, JSON.stringify({ layer: 'nope', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'x' } }), 400, 'unknown-layer'],
    ['PUT', OVERRIDES_PATH, JSON.stringify({ layer: 'user', section: { name: 'project:alpha', action: 'replace', text: 'x' } }), 403, 'write-locked'],
    ['PUT', OVERRIDES_PATH, JSON.stringify({ layer: 'user', section: { name: CUSTOM_SECTION_NAME, action: 'replace' } }), 400, 'missing-text'],
    ['PUT', OVERRIDES_PATH, JSON.stringify({ layer: 'workspace', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'x' } }), 400, 'workspace-unresolved'],
    ['DELETE', `${OVERRIDES_PATH}?layer=user&name=absent`, undefined, 403, 'write-locked'],
    ['DELETE', `${OVERRIDES_PATH}?layer=user&name=${encodeURIComponent(CUSTOM_SECTION_NAME)}`, undefined, 404, 'override-not-found'],
    ['DELETE', `${OVERRIDES_PATH}?layer=nope&name=a`, undefined, 400, 'unknown-layer'],
    ['DELETE', `${OVERRIDES_PATH}?layer=nope&reset=true`, undefined, 400, 'unknown-layer'],
    ['POST', IMPORT_PATH, '{ not json', 400, 'invalid-json'],
    ['POST', IMPORT_PATH, JSON.stringify({ layers: { user: { overrides: [] } } }), 400, 'unknown-export-schema'],
    ['POST', IMPORT_PATH, exportDocument, 400, 'unknown-action'],
    ['POST', IMPORT_PATH, 'x'.repeat(IMPORT_CAP + 1), 413, 'body-too-large'],
  ];

  for (const [method, url, body, status, code] of failures) {
    const res = await call(route, { method, url, body });
    assert.equal(res.statusCode, status, `${method} ${url} must be rejected`);
    assert.equal(json(res).code, code, `${method} ${url} must carry ${code}`);
    // The rejected request changed nothing observable: the cache still holds
    // exactly what the file says, so a real turn still gets the override.
    assert.equal(await assembleDirectly(ctx), 'FROM FILE', `${method} ${url} desynced the cache`);
    const snapshot = json(await call(route, { url: SNAPSHOT_PATH }));
    assert.deepEqual(
      [snapshot.layers.user.enabled, snapshot.layers.user.reason, effectiveAlpha(snapshot).text],
      [true, null, 'FROM FILE'],
      `${method} ${url} left the snapshot stale or disabled`,
    );
  }
});

test('refresh: a write rejected because the target layer is unusable leaves the other layer alone', async () => {
  const workspace = workspaceWith('ws-bad', 's-bad');
  mkdirSync(join(workspace.path, '.dsh-prompt-setting'), { recursive: true });
  writeFileSync(join(workspace.path, '.dsh-prompt-setting', 'overrides.json'), 'nope', 'utf8');
  writeUserConfig([alphaOverride('FROM FILE')]);
  const { route } = mount({ workspaces: [workspace] });

  const refused = await call(route, {
    method: 'PUT',
    url: `${OVERRIDES_PATH}?session=s-bad`,
    body: JSON.stringify({ layer: 'workspace', session: 's-bad', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'x' } }),
  });
  assert.equal(refused.statusCode, 409);
  assert.equal(json(refused).code, 'layer-not-writable');

  const snapshot = json(await call(route, { url: `${SNAPSHOT_PATH}?session=s-bad` }));
  assert.deepEqual([snapshot.layers.user.enabled, snapshot.layers.user.reason], [true, null]);
  assert.equal(effectiveAlpha(snapshot).text, 'FROM FILE', 'the user layer still contributes');
  assert.equal(snapshot.layers.workspace.enabled, false);
  assert.match(snapshot.layers.workspace.reason, /invalid-json/);
});

test('refresh: every write path caches only after its own file write returned', () => {
  // The runtime matrix above reaches every failure a caller can trigger. The
  // two remaining import failures — `import-staging-failed` and
  // `import-verify-failed` — need an artificial filesystem fault (`core/store.js`
  // validates the staged file by reading it back, so a staged file that fails
  // to validate cannot be produced by a well-formed plan). They are covered
  // here instead, by the structure that makes them safe: in all four write
  // paths nothing before the successful write names the observable state at
  // all, so no early exit or throw can reach the cache.
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const writePaths = [
    ['handleWriteOverride', 'async function handleWriteOverride(req, url, res) {'],
    ['handleDeleteOverride', 'function handleDeleteOverride(url, res) {'],
    ['handleResetLayer', 'function handleResetLayer(layer, sessionId, res) {'],
    ['handleLegacyClear', 'function handleLegacyClear(layer, sessionId, res) {'],
    ['handleImport', 'async function handleImport(req, url, res) {'],
  ];
  for (const [name, signature] of writePaths) {
    const start = source.indexOf(signature);
    assert.equal(start > 0, true, `${name} is still declared`);
    const commitAt = source.indexOf('cacheWritten(', start);
    assert.equal(commitAt > start, true, `${name} still caches what it wrote`);
    const before = source.slice(start, commitAt);
    assert.equal(before.includes('state.'), false, `${name} must not touch the cache before its write returns`);
    assert.match(before, /writeConfig(sAtomically)?\(/, `${name} writes the file before caching it`);
  }
});

test('refresh: deleting the user layer file disables it with a reason, and restoring it recovers', async () => {
  writeUserConfig([alphaOverride('WILL VANISH')]);
  const { route } = mount();
  const before = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.deepEqual([before.layers.user.enabled, effectiveAlpha(before).text], [true, 'WILL VANISH']);

  rmSync(userPath(), { force: true });
  const after = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.equal(after.mounted, true, 'the engine still runs');
  assert.equal(after.layers.user.enabled, false);
  assert.equal(after.layers.user.path, userPath(), 'the layer still reports where it looked');
  assert.match(after.layers.user.reason, /missing-file/);
  assert.match(after.layers.user.reason, /was removed after it had been read/);
  assert.equal(effectiveAlpha(after).text, 'ALPHA BODY', 'a vanished file keeps no override alive');
  assert.equal(after.base.sections.length, globalNames().length);
  assert.equal(json(await call(route, { url: OVERRIDES_PATH })).user.enabled, false);

  // Re-creating it by hand recovers on the next request, with no remount.
  writeUserConfig([alphaOverride('RESTORED')]);
  const restored = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.deepEqual([restored.layers.user.enabled, effectiveAlpha(restored).text], [true, 'RESTORED']);
});

test('refresh: a file that never existed is an empty enabled layer, not a vanished one', async () => {
  // The distinction matters and is deliberate: a profile that has never been
  // configured (and a fresh install) reports an empty, enabled layer — exactly
  // what the mount path has always done — while a file this mount has read and
  // that then disappeared is reported disabled with `missing-file`.
  const { route } = mount();
  const snapshot = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.deepEqual(snapshot.layers.user, { enabled: true, path: userPath(), reason: null });
  assert.deepEqual(json(await call(route, { url: OVERRIDES_PATH })).user, {
    layer: 'user',
    enabled: true,
    path: userPath(),
    reason: null,
    overrides: [],
  });
});

test('refresh: a user file corrupted after mount disables it, and a repaired one recovers', async () => {
  const { route } = mount();
  writeRaw(userPath(), '{ this is not json');
  const broken = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.equal(broken.mounted, true);
  assert.equal(broken.layers.user.enabled, false);
  assert.match(broken.layers.user.reason, /invalid-json/);
  assert.equal(broken.base.sections.length, globalNames().length, 'the assembly is untouched');
  assert.equal(json(await call(route, { url: OVERRIDES_PATH })).user.enabled, false);

  // Well-formed JSON that fails the schema is the same story, with the
  // validator's own code.
  writeUserConfig([{ name: ALPHA, action: 'nope', text: 'X' }]);
  const invalid = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.deepEqual([invalid.layers.user.enabled, /unknown-action/.test(invalid.layers.user.reason)], [false, true]);
  assert.equal(effectiveAlpha(invalid).text, 'ALPHA BODY');

  writeUserConfig([alphaOverride('REPAIRED')]);
  const fixed = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.deepEqual([fixed.layers.user.enabled, effectiveAlpha(fixed).text], [true, 'REPAIRED']);
});

test('refresh: the route handler re-reads both layers before its first branch', () => {
  // A structural assertion for the invariant the behavioural tests above
  // exercise: the IO sits in `refreshLayers()`, at the top of the handler, and
  // the waterfall listener's own source contains no read at all.
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  const assemblyStart = source.indexOf('function resolvedFor(');
  const assemblyEnd = source.indexOf('async function probe(', assemblyStart);
  assert.equal(assemblyStart > 0 && assemblyEnd > assemblyStart, true, 'the listener block is still contiguous');
  const assemblyPath = source.slice(assemblyStart, assemblyEnd);
  for (const forbidden of ['readConfig(', 'loadWorkspace(', 'refreshUser(', 'refreshWorkspaces(', 'refreshLayers(', 'readFileSync(']) {
    assert.equal(assemblyPath.includes(forbidden), false, `the assembly path must not contain ${forbidden}`);
  }

  const handler = source.slice(source.indexOf('handler: async (req, res) => {'));
  const refreshedAt = handler.indexOf('refreshLayers();');
  assert.equal(refreshedAt > 0, true, 'the handler refreshes the layers');
  for (const branch of ['if (url.pathname === PING_PATH)', 'if (url.pathname === SNAPSHOT_PATH)', 'if (req.method === \'GET\')']) {
    assert.equal(refreshedAt < handler.indexOf(branch), true, `the refresh precedes ${branch}`);
  }
});

// #endregion

// ---------------------------------------------------------------------------
// Revision 9 (g-026): the「我的 Prompt」variable-substitution switch.
//
// The switch is the only thing in this package that can turn user text into a
// per-turn throw, so the assertions below are the safety half of the feature:
// every refusal is checked for a 400 with the right code AND for zero bytes
// written (a SHA-256 around the whole layer file), and the switch itself is
// checked to flip the LIVE definition object rather than to re-register.
// ---------------------------------------------------------------------------

const INTERPOLATE_PATH = '/prompt-setting/interpolate';
/** The variable table a healthy fake host assembles. */
const SWITCH_VARIABLES = { model: 'deepseek-flash', cwd: '/work', provider: 'deepseek' };

/** The definition the fake host is holding for the reserved section. */
function reservedDefinition(harness) {
  return harness.registered.find((section) => section.name === CUSTOM_SECTION_NAME);
}

/** Parse one layer file, or null when it does not exist. */
function readLayer(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** Call the switch route. */
function setSwitch(route, body) {
  return call(route, {
    method: 'PUT',
    url: INTERPOLATE_PATH,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Call the override route with the reserved section. */
function putText(route, text, extra = {}) {
  return call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      layer: 'user',
      section: { name: CUSTOM_SECTION_NAME, action: 'replace', text },
      ...extra,
    }),
  });
}

test('g-026 switch: OFF by default, and the reserved section still registers interpolate:false', async () => {
  const harness = mount({ variables: SWITCH_VARIABLES });
  assert.equal(reservedDefinition(harness).interpolate, false);
  assert.equal(harness.sectionRegistrations.length, 1);
  assert.equal(harness.sectionRegistrations[0].interpolate, false, 'the registration value is contract');

  const payload = json(await call(harness.route, { url: SNAPSHOT_PATH }));
  assert.deepEqual(payload.layers.interpolate, { effective: false, user: null, workspace: null });
  // Reading reports OFF; it does not invent a config file.
  assert.equal(existsSync(userPath()), false);

  const read = await call(harness.route, { url: INTERPOLATE_PATH });
  assert.equal(read.statusCode, 200);
  assert.equal(json(read).interpolateCustom, false);
  assert.deepEqual(json(read).layers, { user: null, workspace: null });
  assert.deepEqual(json(read).variables.sort(), ['cwd', 'model', 'provider']);
  // The route table is real: another method is a 405, not a 404.
  assert.equal((await call(harness.route, { method: 'DELETE', url: INTERPOLATE_PATH })).statusCode, 405);
});

test('g-026 rev15 switch: enabling never flips the LIVE definition — it drives the plugin\'s own expansion', async () => {
  const harness = mount({ variables: SWITCH_VARIABLES, agents: [{ id: 'session-a' }] });
  assert.equal(reservedDefinition(harness).interpolate, false);
  assert.equal((await putText(harness.route, 'I am {{model}}')).statusCode, 200);

  // OFF: the section text is handed over exactly as written.
  const closed = await assembleFor(harness, 'session-a');
  assert.equal(reservedOf(closed).text, 'I am {{model}}');
  assert.equal(reservedOf(closed).interpolate, false);

  const res = await setSwitch(harness.route, { enabled: true });
  assert.equal(res.statusCode, 200);
  const payload = json(res);
  assert.equal(payload.interpolateCustom, true);
  assert.equal(payload.layer, 'user');
  assert.equal(payload.effectiveFrom, 'next-turn');

  // Revision 15 (design A): the live definition object is NOT touched. The
  // `interpolate: false` field is structural, not a switch position, so the
  // strict renderer can never be pointed at this text — no re-registration and
  // no second name in the global layer either.
  assert.equal(reservedDefinition(harness).interpolate, false, 'the definition never moves');
  assert.equal(harness.sectionRegistrations.length, 1);
  assert.equal(harness.registered.filter((section) => section.name === CUSTOM_SECTION_NAME).length, 1);
  assert.equal(harness.sectionRegistrations[0].interpolate, false, 'and the registration value stays false');

  // What the switch DOES do: the next assembly's text arrives expanded, and the
  // section still says `interpolate: false`.
  const open = await assembleFor(harness, 'session-a');
  assert.equal(reservedOf(open).text, 'I am deepseek-flash');
  assert.equal(reservedOf(open).interpolate, false, 'DSH still never interpolates this section');

  assert.equal(readLayer(userPath()).interpolateCustom, true);
  assert.equal(json(await call(harness.route, { url: SNAPSHOT_PATH })).layers.interpolate.effective, true);
});

test('g-026 switch: it survives a remount, which is what "no restart" would otherwise cost', async () => {
  const first = mount({ variables: SWITCH_VARIABLES, agents: [{ id: 'session-a' }] });
  assert.equal((await setSwitch(first.route, { enabled: true })).statusCode, 200);
  assert.equal((await putText(first.route, 'M={{model}}')).statusCode, 200);

  const second = mount({ variables: SWITCH_VARIABLES, agents: [{ id: 'session-a' }] });
  const restored = await assembleFor(second, 'session-a');
  assert.equal(reservedOf(restored).text, 'M=deepseek-flash', 'mount applies what the layers already state');
  assert.equal(reservedDefinition(second).interpolate, false, 'and still flips nothing');
  assert.equal(json(await call(second.route, { url: SNAPSHOT_PATH })).layers.interpolate.effective, true);
});

test('g-026 switch: closing restores the file byte for byte, and ON→OFF→ON leaves no residue', async () => {
  const harness = mount({ variables: SWITCH_VARIABLES, agents: [{ id: 'session-a' }] });
  assert.equal((await putText(harness.route, 'hello {{model}}')).statusCode, 200);
  const before = sha256(userPath());
  assert.equal(readLayer(userPath()).interpolateCustom, undefined, 'OFF is absence, not false');
  assert.equal(reservedOf(await assembleFor(harness, 'session-a')).text, 'hello {{model}}');

  await setSwitch(harness.route, { enabled: true });
  assert.equal(reservedOf(await assembleFor(harness, 'session-a')).text, 'hello deepseek-flash');
  const on = sha256(userPath());
  assert.notEqual(on, before);
  // Repeating ON is a no-op, and the expansion it drives is idempotent.
  assert.equal((await setSwitch(harness.route, { enabled: true })).statusCode, 200);
  assert.equal(sha256(userPath()), on, 'a repeated ON rewrites the same bytes');
  assert.equal(reservedDefinition(harness).interpolate, false);

  await setSwitch(harness.route, { enabled: false });
  assert.equal(sha256(userPath()), before, 'the pre-switch bytes are back exactly');
  assert.equal(reservedOf(await assembleFor(harness, 'session-a')).text, 'hello {{model}}', 'and the braces are literal again');

  await setSwitch(harness.route, { enabled: true });
  await setSwitch(harness.route, { enabled: false });
  assert.equal(sha256(userPath()), before, 'the cycle is idempotent in both directions');
  assert.equal(reservedDefinition(harness).interpolate, false);
  assert.equal(json(await call(harness.route, { url: SNAPSHOT_PATH })).layers.interpolate.effective, false);
});

test('g-026 switch: the request shape is validated before anything is read or written', async () => {
  const harness = mount({ variables: SWITCH_VARIABLES });
  const before = sha256(userPath());
  for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }]) {
    const res = await setSwitch(harness.route, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(json(res).code, 'invalid-enabled', JSON.stringify(body));
  }
  const bad = await setSwitch(harness.route, { enabled: true, layer: 'nope' });
  assert.equal(bad.statusCode, 400);
  assert.equal(json(bad).code, 'unknown-layer');
  assert.equal(sha256(userPath()), before, 'no byte moved');
});

test('g-026 write face: with the switch ON a throwing reference is refused, and zero bytes move', async () => {
  const harness = mount({ variables: SWITCH_VARIABLES });
  await setSwitch(harness.route, { enabled: true });
  const before = sha256(userPath());

  for (const text of ['keep {{nope}}', 'keep {{Upper}}', 'keep {{ lone {{c}}', 'keep {{{{model}}}}', 'keep {{a b}}']) {
    const res = await putText(harness.route, text);
    assert.equal(res.statusCode, 400, text);
    assert.equal(json(res).code, 'unresolvable-variable', text);
    assert.match(json(res).message, /Fix:/, text);
    assert.equal(sha256(userPath()), before, `zero bytes written for ${JSON.stringify(text)}`);
  }

  // The legal text still saves, and it is the switch being ON that gates this.
  const ok = await putText(harness.route, 'I am {{model}} in {{cwd}} via {{provider}}');
  assert.equal(ok.statusCode, 200);
  assert.equal(readLayer(userPath()).overrides[0].text, 'I am {{model}} in {{cwd}} via {{provider}}');
  assert.equal(readLayer(userPath()).interpolateCustom, true, 'saving the text does not turn the switch off');
});

test('g-026 write face: with the switch OFF every one of those texts is accepted, exactly as before', async () => {
  const harness = mount({ variables: SWITCH_VARIABLES });
  for (const text of ['keep {{nope}}', 'keep {{Upper}}', 'keep {{ lone {{c}}', 'keep {{{{model}}}}']) {
    assert.equal((await putText(harness.route, text)).statusCode, 200, text);
  }
  assert.equal(readLayer(userPath()).overrides[0].text, 'keep {{{{model}}}}');
});

test('g-026 write face: a registered name whose value is undefined here is saved, not refused', async () => {
  // The value belongs to the session, not to the text: a probe with no active
  // agent leaves agent-scoped providers valueless, and refusing the save would
  // make the switch unusable whenever no session is running (§16.3).
  const harness = mount({ variables: { model: undefined } });
  assert.equal((await setSwitch(harness.route, { enabled: true })).statusCode, 200);
  const res = await putText(harness.route, 'hi {{model}}');
  assert.equal(res.statusCode, 200);
  assert.equal(readLayer(userPath()).overrides[0].text, 'hi {{model}}');
});

test('g-026 write face: an import carrying a throwing reference is refused, dry run included', async () => {
  const harness = mount({ variables: SWITCH_VARIABLES });
  await setSwitch(harness.route, { enabled: true });
  const before = sha256(userPath());

  const document = {
    schema: 'dsh-prompt-setting/export',
    version: 1,
    layers: { user: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'imported {{nope}}' }] } },
  };
  for (const suffix of ['', '?dryRun=true']) {
    const res = await call(harness.route, {
      method: 'POST',
      url: `${IMPORT_PATH}${suffix}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(document),
    });
    assert.equal(res.statusCode, 400, suffix);
    assert.equal(json(res).code, 'unresolvable-variable', suffix);
  }
  assert.equal(sha256(userPath()), before, 'the refused import wrote nothing, dry run or not');

  const good = {
    ...document,
    layers: { user: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'imported {{model}}' }] } },
  };
  const ok = await call(harness.route, {
    method: 'POST',
    url: IMPORT_PATH,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(good),
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(readLayer(userPath()).overrides[0].text, 'imported {{model}}');
  assert.equal(readLayer(userPath()).interpolateCustom, true, 'the switch survives the import');

  // The same document imports fine once the switch is closed — OFF is what makes
  // arbitrary braces legal again.
  await setSwitch(harness.route, { enabled: false });
  const closed = await call(harness.route, {
    method: 'POST',
    url: IMPORT_PATH,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(document),
  });
  assert.equal(closed.statusCode, 200);
  assert.equal(readLayer(userPath()).overrides[0].text, 'imported {{nope}}');
  assert.equal(readLayer(userPath()).interpolateCustom, undefined);
});

test('g-026 history check: opening the switch validates what is ALREADY stored and refuses with a fix', async () => {
  const harness = mount({ variables: SWITCH_VARIABLES });
  // Legal while the switch is closed: nothing interpolates, so nothing throws.
  assert.equal((await putText(harness.route, 'bomb {{nope}}')).statusCode, 200);
  const before = sha256(userPath());

  const res = await setSwitch(harness.route, { enabled: true });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).code, 'unresolvable-variable');
  assert.match(json(res).message, /Fix:/);
  assert.match(json(res).message, /nope/);
  assert.equal(sha256(userPath()), before, 'the switch was not written');
  assert.equal(reservedDefinition(harness).interpolate, false, 'and the live definition stays closed');
});

test('g-026 history check: a bomb in the WORKSPACE layer also blocks opening the user layer', async () => {
  // The switch is inherited: a workspace layer that states nothing inherits the
  // user layer, so opening the user layer arms every such workspace.
  const workspace = workspaceWith('ws-bomb', 'session-a', {
    version: 1,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'ws {{nope}}' }],
  });
  const harness = mount({ variables: SWITCH_VARIABLES, workspaces: [workspace] });
  const res = await setSwitch(harness.route, { enabled: true });
  assert.equal(res.statusCode, 400);
  assert.match(json(res).message, /workspace layer/);

  // A workspace layer that explicitly states OFF cannot throw, so it no longer
  // blocks the user layer.
  const off = workspaceWith('ws-off', 'session-b', {
    version: 1,
    interpolateCustom: false,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'ws {{nope}}' }],
  });
  const second = mount({ variables: SWITCH_VARIABLES, workspaces: [workspace, off] });
  // Both are visible; the still-unstated bomb keeps the refusal honest.
  assert.equal((await setSwitch(second.route, { enabled: true })).statusCode, 400);
});

test('g-026 rev15 load time: a hand-armed layer with a dead reference is NOT degraded any more', async () => {
  // Revision 15 (design A) deletes the load-time interpolation self-check. It
  // used to disable a layer whose stored text would throw if the section
  // interpolated — but the section never interpolates, so the text is harmless,
  // and disabling it would silently discard the user's prompt. What replaces the
  // assertion is stronger: the layer is fully enabled, its text reaches the
  // prompt, and the dead reference is graded literal exactly as g-025 grades it.
  writeRaw(userPath(), JSON.stringify({
    version: 1,
    interpolateCustom: true,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'x {{nope}}' }],
  }));
  const harness = mount({ variables: SWITCH_VARIABLES });
  const payload = json(await call(harness.route, { url: SNAPSHOT_PATH }));
  assert.equal(payload.layers.user.enabled, true, 'the layer contributes everything');
  assert.equal(payload.layers.user.reason, null);
  assert.equal(payload.layers.interpolate.user, true, 'the switch it states is read as stated');
  assert.equal(payload.layers.interpolate.effective, true);
  assert.equal(payload.rendered.endsWith('x {{nope}}'), true, 'the braces reach the model literally');
  assert.equal(payload.renderedResolved, true);
  assert.deepEqual(payload.unresolvedThrowing, []);
  assert.deepEqual(payload.unresolvedLiteral, ['nope'], 'graded where it belongs: literal, not throwing');
});

test('g-026 load time: the same file loads untouched while the switch is closed', async () => {
  writeRaw(userPath(), JSON.stringify({
    version: 1,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'x {{nope}}' }],
  }));
  const harness = mount({ variables: SWITCH_VARIABLES });
  const payload = json(await call(harness.route, { url: SNAPSHOT_PATH }));
  assert.equal(payload.layers.user.enabled, true);
  assert.equal(payload.layers.user.reason, null);
  assert.equal(payload.rendered.endsWith('x {{nope}}'), true, 'the braces reach the model literally');
});

test('g-026 rev15: a valueless reference stays literal whether the switch is open or closed', async () => {
  // `model` is registered but has no value in this assembly, so the text is
  // storable (a warned reference) and the two gradings are directly comparable.
  // Revision 14 held such a turn back; Revision 15 (design A) does not have to,
  // because the section never interpolates — the reference is simply left
  // literal by the plugin's own lenient expansion, and the preview says so.
  const harness = mount({ variables: { model: undefined }, agents: [{ id: 'session-a' }] });
  assert.equal((await putText(harness.route, 'I am {{model}}')).statusCode, 200);

  const closed = json(await call(harness.route, { url: SNAPSHOT_PATH }));
  assert.equal(closed.rendered.endsWith('I am {{model}}'), true);
  assert.equal(closed.renderedResolved, true);
  assert.deepEqual(closed.unresolvedThrowing, []);
  assert.deepEqual(closed.unresolvedLiteral, ['model'], 'closed: literal, not a fault');
  assert.equal(Object.hasOwn(closed.layers, 'interpolationHold'), false, 'rev15: the hold field is gone');

  await setSwitch(harness.route, { enabled: true });
  const open = json(await call(harness.route, { url: SNAPSHOT_PATH }));
  assert.equal(open.rendered.endsWith('I am {{model}}'), true, 'a value this assembly lacks is left literal');
  assert.equal(open.renderedResolved, true);
  assert.deepEqual(open.unresolvedThrowing, [], 'nothing about this turn can throw');
  assert.deepEqual(open.unresolvedLiteral, ['model']);
  assert.equal(open.layers.interpolate.effective, true);
  assert.equal(Object.hasOwn(open.layers, 'interpolationHold'), false);

  // The real assembly of a session agrees, and DSH is still never handed the
  // text as an interpolating section.
  const assembly = await assembleFor(harness, 'session-a');
  assert.equal(reservedOf(assembly).text, 'I am {{model}}');
  assert.equal(reservedOf(assembly).interpolate, false);
});

test('g-026 scope: the workspace layer states its own value and wins over the user layer', async () => {
  const workspace = workspaceWith('ws-off-2', 'session-a', {
    version: 1,
    interpolateCustom: false,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'ws {{nope}}' }],
  });
  const harness = mount({ variables: SWITCH_VARIABLES, workspaces: [workspace] });
  assert.equal((await setSwitch(harness.route, { enabled: true })).statusCode, 200);

  const scoped = json(await call(harness.route, { url: `${SNAPSHOT_PATH}?session=session-a` }));
  assert.deepEqual(scoped.layers.interpolate, { effective: false, user: true, workspace: false });
  assert.equal(scoped.rendered.includes('ws {{nope}}'), true, 'the workspace text stays literal');

  const global = json(await call(harness.route, { url: SNAPSHOT_PATH }));
  assert.deepEqual(global.layers.interpolate, { effective: true, user: true, workspace: null });
});

test('g-026 scope: writing into a workspace layer is gated by that layer, not by the user layer', async () => {
  const workspace = workspaceWith('ws-write', 'session-a', {
    version: 1,
    interpolateCustom: false,
    overrides: [],
  });
  const harness = mount({ variables: SWITCH_VARIABLES, workspaces: [workspace] });
  const path = join(workspace.path, '.dsh-prompt-setting', 'overrides.json');
  const body = {
    layer: 'workspace',
    session: 'session-a',
    section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'ws {{nope}}' },
  };
  const put = (text) => call(harness.route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, section: { ...body.section, text } }),
  });

  // Workspace OFF while the user layer is ON: the workspace text is not
  // validated, because in that scope the section does not interpolate.
  assert.equal((await setSwitch(harness.route, { enabled: true })).statusCode, 200);
  assert.equal((await put('ws {{nope}}')).statusCode, 200);
  assert.equal(readLayer(path).overrides[0].text, 'ws {{nope}}');
  assert.equal(readLayer(path).interpolateCustom, false, 'writing text never writes the switch');

  // ...and that stored text is exactly what blocks opening THIS layer: the same
  // historical-text check, aimed at the workspace layer.
  const blocked = await setSwitch(harness.route, { enabled: true, layer: 'workspace', session: 'session-a' });
  assert.equal(blocked.statusCode, 400);
  assert.match(json(blocked).message, /workspace layer/);

  // Make the stored text safe, then open the layer for real.
  assert.equal((await put('ws {{model}}')).statusCode, 200);
  assert.equal((await setSwitch(harness.route, { enabled: true, layer: 'workspace', session: 'session-a' })).statusCode, 200);
  assert.equal(readLayer(path).interpolateCustom, true);

  // Now this layer's own writes are gated by this layer's own switch.
  const before = sha256(path);
  const refused = await put('ws2 {{also_nope}}');
  assert.equal(refused.statusCode, 400);
  assert.equal(json(refused).code, 'unresolvable-variable');
  assert.equal(sha256(path), before);
});

test('g-026 switch: an unreadable variable table refuses the write instead of guessing', async () => {
  // A profile whose assemble throws cannot answer "is this name registered?".
  // Guessing "yes" is how a bomb gets in, so the write answers 503.
  const harness = mount({
    variables: SWITCH_VARIABLES,
    beforeDispatch: () => {
      throw new Error('assembly exploded');
    },
  });
  // The probe for the switch itself fails, so even opening is refused — and it
  // is refused as a failure of this process, not as a fault in the user's text.
  const res = await setSwitch(harness.route, { enabled: true });
  assert.equal(res.statusCode, 503);
  assert.equal(json(res).code, 'variable-lookup-failed');
  assert.equal(sha256(userPath()), 'missing');
});

// ---------------------------------------------------------------------------
// Revision 12 (g-026 att-002): the independent audit's four findings, frozen as
// regressions.
//
// F1 — the write/enable/import verdict is about the TEXT, not about the write
// target: a reference is refused whenever it can reach an assembly that
// interpolates. The audit's two-step bypass is the first test below; the
// reverse direction (a write into the user layer while a workspace is armed) is
// the second and third.
// F2 — the advisories travel on the response.
// F3 — the assembly decides on its OWN context; no process-wide field, and a
// session-less ping cannot move a session's behaviour.
// F4 — three states, with explicit OFF able to close over an ON user layer and
// the legacy close still reverting byte for byte.
// ---------------------------------------------------------------------------

/** The workspace layer's config path, from its registry row. */
function layerPath(workspace) {
  return join(workspace.path, '.dsh-prompt-setting', 'overrides.json');
}

/** Call the override route for one layer. */
function putLayer(route, layer, text, session) {
  return call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      layer,
      section: { name: CUSTOM_SECTION_NAME, action: 'replace', text },
      ...(session === undefined ? {} : { session }),
    }),
  });
}

/** One real assembly for a session, through the fake host's own `assemble`. */
async function assembleFor(harness, sessionId) {
  const agent = harness.agents.get(sessionId);
  return harness.systemPrompt.assemble({ agent, scope: agent });
}

/** The reserved section of an assembly, or undefined. */
function reservedOf(assembly) {
  return assembly.sections.find((section) => section.name === CUSTOM_SECTION_NAME);
}

test('g-026 rev12 F1: a bomb stored while everything is closed cannot be armed by another layer', async () => {
  const workspace = workspaceWith('ws-arm', 'session-a', { version: 1, overrides: [] });
  const path = join(workspace.path, '.dsh-prompt-setting', 'overrides.json');
  const harness = mount({ variables: SWITCH_VARIABLES, workspaces: [workspace] });

  // Step 1 of the audit's bypass: legal while nothing interpolates — and it must
  // stay 200, because that is the closed-state contract the switch rests on.
  assert.equal((await putText(harness.route, 'x {{nope}}')).statusCode, 200);
  const userHash = sha256(userPath());
  const wsHash = sha256(path);

  // Step 2: arming the WORKSPACE layer would render that user text through this
  // workspace (this workspace carries no entry of its own, so the merge picks the
  // user's). The old check only looked at the layer being written and let this
  // through, after which every turn of session-a threw.
  const res = await setSwitch(harness.route, { enabled: true, layer: 'workspace', session: 'session-a' });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).code, 'unresolvable-variable');
  assert.match(json(res).message, /user layer/);
  assert.equal(sha256(userPath()), userHash, 'zero bytes in the user layer');
  assert.equal(sha256(path), wsHash, 'zero bytes in the workspace layer');
  assert.equal(Object.hasOwn(readLayer(path), 'interpolateCustom'), false, 'and the switch did not move');

  // The same arming write succeeds once the stored text is safe.
  assert.equal((await putText(harness.route, 'x {{model}}')).statusCode, 200);
  assert.equal((await setSwitch(harness.route, { enabled: true, layer: 'workspace', session: 'session-a' })).statusCode, 200);
});

test('g-026 rev12 F1: with a workspace armed, the user layer text is gated as well', async () => {
  const workspace = workspaceWith('ws-rev', 'session-a', { version: 1, overrides: [] });
  const harness = mount({ variables: SWITCH_VARIABLES, workspaces: [workspace] });
  assert.equal((await setSwitch(harness.route, { enabled: true, layer: 'workspace', session: 'session-a' })).statusCode, 200);

  // The reverse bypass: the user layer's own flag is off, but its text is merged
  // into every session of this armed workspace, so this write really would arm a
  // per-turn throw. The old per-layer check answered 200.
  const before = sha256(userPath());
  const res = await putText(harness.route, 'y {{also_nope}}');
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).code, 'unresolvable-variable');
  assert.match(json(res).message, /user layer/);
  assert.equal(sha256(userPath()), before, 'zero bytes written');
  assert.equal(existsSync(userPath()), false, 'and the file was never created');

  // Writing the same bomb into the armed workspace is refused by the same rule.
  const wsBefore = sha256(layerPath(workspace));
  const ws = await putLayer(harness.route, 'workspace', 'z {{also_nope}}', 'session-a');
  assert.equal(ws.statusCode, 400);
  assert.equal(sha256(layerPath(workspace)), wsBefore);
});

test('g-026 rev12 F1: the same verdict covers import, dry run included', async () => {
  const workspace = workspaceWith('ws-imp', 'session-a', { version: 1, overrides: [] });
  const harness = mount({ variables: SWITCH_VARIABLES, workspaces: [workspace] });
  assert.equal((await setSwitch(harness.route, { enabled: true, layer: 'workspace', session: 'session-a' })).statusCode, 200);
  const before = sha256(userPath());

  const document = {
    schema: 'dsh-prompt-setting/export',
    version: 1,
    layers: { user: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'imported {{nope}}' }] } },
  };
  for (const suffix of ['', '?dryRun=true']) {
    const res = await call(harness.route, {
      method: 'POST',
      url: `${IMPORT_PATH}${suffix}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(document),
    });
    assert.equal(res.statusCode, 400, suffix);
    assert.equal(json(res).code, 'unresolvable-variable', suffix);
    assert.match(json(res).message, /user layer/, suffix);
  }
  assert.equal(sha256(userPath()), before, 'the refused import wrote nothing, dry run or not');

  // An import of safe text still lands, and does not disturb the armed layer.
  const good = {
    ...document,
    layers: { user: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'imported {{model}}' }] } },
  };
  const ok = await call(harness.route, {
    method: 'POST',
    url: IMPORT_PATH,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(good),
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(readLayer(userPath()).overrides[0].text, 'imported {{model}}');
});

test('g-026 rev12 F1: an explicitly closed workspace is the one place literal braces stay storable', async () => {
  // The rule is per-text participation, not "any layer armed", and this is the
  // case that tells them apart: a workspace that states OFF renders its own text
  // literally in every session it owns, so its braces provably cannot throw and
  // are not refused. (It is also why F4's explicit OFF is worth having.)
  const workspace = workspaceWith('ws-closed', 'session-a', {
    version: 1,
    interpolateCustom: false,
    overrides: [],
  });
  const path = layerPath(workspace);
  const harness = mount({ variables: SWITCH_VARIABLES, workspaces: [workspace] });
  assert.equal((await setSwitch(harness.route, { enabled: true })).statusCode, 200);

  assert.equal((await putLayer(harness.route, 'workspace', 'ws {{nope}}', 'session-a')).statusCode, 200);
  assert.equal(readLayer(path).overrides[0].text, 'ws {{nope}}');

  const scoped = json(await call(harness.route, { url: `${SNAPSHOT_PATH}?session=session-a` }));
  assert.deepEqual(scoped.layers.interpolate, { effective: false, user: true, workspace: false });
  assert.equal(scoped.rendered.includes('ws {{nope}}'), true, 'the real render for that session is literal');
  const global = json(await call(harness.route, { url: SNAPSHOT_PATH }));
  assert.deepEqual(global.layers.interpolate, { effective: true, user: true, workspace: null });

  // ...but arming THAT layer is refused while its own text is a bomb, because
  // after the change it is the layer's text that interpolates.
  const blocked = await setSwitch(harness.route, { enabled: true, layer: 'workspace', session: 'session-a' });
  assert.equal(blocked.statusCode, 400);
  assert.match(json(blocked).message, /workspace layer/);
});

test('g-026 rev15 F1 at load: a hand-armed pair of layers is left enabled, and the dead reference stays literal', async () => {
  // The Revision 12 load-time half, re-stated for the design that removed it: the
  // user layer states ON, the workspace layer states nothing and carries a dead
  // reference. Revision 15 does not degrade it — nothing about the text can break
  // an assembly — so the assertion is that both layers keep contributing and the
  // reference is graded literal.
  writeRaw(userPath(), JSON.stringify({ version: 1, interpolateCustom: true, overrides: [] }));
  const workspace = workspaceWith('ws-load', 'session-a', {
    version: 1,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'ws {{nope}}' }],
  });
  const harness = mount({ variables: SWITCH_VARIABLES, workspaces: [workspace] });

  const scoped = json(await call(harness.route, { url: `${SNAPSHOT_PATH}?session=session-a` }));
  assert.equal(scoped.layers.workspace.enabled, true, 'nothing is taken out of the assembly any more');
  assert.equal(scoped.layers.workspace.reason, null);
  assert.equal(scoped.rendered.includes('ws {{nope}}'), true, 'the dead reference is the literal the user wrote');
  assert.deepEqual(scoped.unresolvedThrowing, []);
  assert.deepEqual(scoped.unresolvedLiteral, ['nope']);
  // The user layer keeps contributing as well: this is not a degradation of the
  // profile, and there is no other layer to degrade.
  const global = json(await call(harness.route, { url: SNAPSHOT_PATH }));
  assert.deepEqual([global.layers.user.enabled, global.layers.interpolate.user], [true, true]);
  // A workspace whose text resolves expands it, in that workspace's own scope.
  const safe = workspaceWith('ws-safe', 'session-b', {
    version: 1,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'ws {{model}}' }],
  });
  const second = mount({ variables: SWITCH_VARIABLES, workspaces: [workspace, safe] });
  const both = json(await call(second.route, { url: `${SNAPSHOT_PATH}?session=session-b` }));
  assert.equal(both.layers.workspace.enabled, true);
  assert.equal(both.rendered.includes('ws deepseek-flash'), true);
});

test('g-026 rev12 F2: a registered-but-valueless reference is saved AND reported', async () => {
  const harness = mount({ variables: { model: undefined, cwd: '/work' } });
  assert.equal((await setSwitch(harness.route, { enabled: true })).statusCode, 200);

  const saved = await putText(harness.route, 'hi {{model}}');
  assert.equal(saved.statusCode, 200);
  assert.equal(json(saved).warnings.length, 1);
  assert.equal(json(saved).warnings[0].name, 'model');
  assert.equal(json(saved).warnings[0].kind, 'undefined-value');
  assert.match(json(saved).warnings[0].message, /no value/);
  assert.equal(readLayer(userPath()).overrides[0].text, 'hi {{model}}', 'the save still happened');

  // A safe text reports nothing at all — the field is additive, not decorative.
  const clean = await putText(harness.route, 'hi {{cwd}}');
  assert.equal(clean.statusCode, 200);
  assert.equal(Object.hasOwn(json(clean), 'warnings'), false);

  // Closing warns about nothing, and re-arming re-reports what is stored: the
  // advisory is a property of the text, so it comes back with the arming write.
  assert.equal(Object.hasOwn(json(await setSwitch(harness.route, { enabled: false })), 'warnings'), false);
  assert.equal((await putText(harness.route, 'hi {{model}}')).statusCode, 200);
  const reopened = await setSwitch(harness.route, { enabled: true });
  assert.equal(reopened.statusCode, 200);
  assert.equal(json(reopened).warnings[0].name, 'model');
  assert.match(json(reopened).warnings[0].message, /user layer/);
});

test('g-026 rev12 F3: the assembly decides on its own context, so a session-less ping cannot move it', async () => {
  const workspace = workspaceWith('ws-f3', 'session-a', {
    version: 1,
    interpolateCustom: true,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'A={{model}}' }],
  });
  const harness = mount({ variables: SWITCH_VARIABLES, workspaces: [workspace] });

  const first = await assembleFor(harness, 'session-a');
  assert.equal(reservedOf(first).interpolate, false, 'the section is never handed to the strict interpolator');
  assert.equal(reservedOf(first).text, 'A=deepseek-flash', 'the armed workspace layer expands for its own session');
  assert.equal(
    renderSections(first.sections, first.variables).text.includes('A=deepseek-flash'),
    true,
    'and the rendered assembly carries the value',
  );

  // The ping carries no session. Historically it recomputed the global view and
  // wrote it onto the one live flag, which turned this session's next turn
  // literal even though nothing about the session had changed.
  assert.equal((await call(harness.route, { url: PING_PATH })).statusCode, 200);
  const afterPing = await assembleFor(harness, 'session-a');
  assert.equal(reservedOf(afterPing).text, 'A=deepseek-flash', 'the ping cannot disarm a session that states ON');
  assert.equal(renderSections(afterPing.sections, afterPing.variables).text.includes('A=deepseek-flash'), true);

  // The unscoped assembly is a different context and stays closed: nobody armed
  // the user layer, and the workspace override is not merged into it at all.
  const global = await harness.systemPrompt.assemble();
  assert.equal(reservedOf(global).interpolate, false);
  assert.equal(renderSections(global.sections, global.variables).text.includes('A='), false);

  // The mirror the routes read still answers "the unscoped view", which is what
  // makes a session-less request a no-op on the live definition.
  assert.equal(reservedDefinition(harness).interpolate, false);
});

test('g-026 rev12 F3: interleaved sessions keep the reported effective and the real render in step', async () => {
  const armed = workspaceWith('ws-i-on', 'session-a', {
    version: 1,
    interpolateCustom: true,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'A={{model}}' }],
  });
  const closed = workspaceWith('ws-i-off', 'session-b', {
    version: 1,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'B={{model}}' }],
  });
  const harness = mount({ variables: SWITCH_VARIABLES, workspaces: [armed, closed] });

  const view = async (session) => json(await call(harness.route, { url: `${SNAPSHOT_PATH}?session=${session}` }));
  const before = { a: await view('session-a'), b: await view('session-b') };
  // Interleave a session-less request between the two sessions' views: this is
  // the sequence that made a single global flag report one thing and render
  // another.
  await call(harness.route, { url: PING_PATH });
  const after = { a: await view('session-a'), b: await view('session-b') };

  for (const [key, session] of [['a', 'session-a'], ['b', 'session-b']]) {
    assert.deepEqual(after[key].layers.interpolate, before[key].layers.interpolate, `${session} view is stable`);
  }
  assert.equal(after.a.layers.interpolate.effective, true);
  assert.equal(after.b.layers.interpolate.effective, false);

  const a = await assembleFor(harness, 'session-a');
  const b = await assembleFor(harness, 'session-b');
  assert.equal(reservedOf(a).interpolate, false, 'A: the section is never interpolated by DSH');
  assert.equal(reservedOf(b).interpolate, false);
  assert.equal(reservedOf(a).text, 'A=deepseek-flash', 'A: reported effective = expanded for real');
  assert.equal(reservedOf(b).text, 'B={{model}}', 'B: reported effective OFF = left literal');
  assert.equal(renderSections(a.sections, a.variables).text.endsWith('A=deepseek-flash'), true);
  assert.equal(renderSections(b.sections, b.variables).text.endsWith('B={{model}}'), true);
  // The snapshot's own bytes agree with the real renderer of each session.
  assert.equal(after.a.rendered.endsWith('A=deepseek-flash'), true);
  assert.equal(after.b.rendered.endsWith('B={{model}}'), true);
});

test('g-026 rev12 F4: three states, and an explicit OFF closes over an ON user layer', async () => {
  const workspace = workspaceWith('ws-three', 'session-a', { version: 1, overrides: [] });
  const path = layerPath(workspace);
  const harness = mount({ variables: SWITCH_VARIABLES, workspaces: [workspace] });
  assert.equal((await setSwitch(harness.route, { enabled: true })).statusCode, 200);

  // Unstated: it inherits ON. That is the state the old two-valued write could
  // not leave, and the state the UI used to render as OFF while the session
  // really interpolated.
  const inherited = json(await call(harness.route, { url: `${SNAPSHOT_PATH}?session=session-a` }));
  assert.deepEqual(inherited.layers.interpolate, { effective: true, user: true, workspace: null });

  // Explicit OFF: the boolean is written, which `enabled:false` cannot express.
  const off = await setSwitch(harness.route, { state: 'off', layer: 'workspace', session: 'session-a' });
  assert.equal(off.statusCode, 200);
  assert.equal(json(off).state, 'off');
  assert.deepEqual(json(off).saved, { enabled: false, state: 'off' });
  assert.equal(readLayer(path).interpolateCustom, false, 'the key is present and false');
  assert.deepEqual(
    json(await call(harness.route, { url: `${SNAPSHOT_PATH}?session=session-a` })).layers.interpolate,
    { effective: false, user: true, workspace: false },
  );
  // The real assembly agrees with the report.
  assert.equal(reservedOf(await assembleFor(harness, 'session-a')).interpolate, false);

  // Back to unstated: the key is DELETED, not written as a third value.
  assert.equal((await setSwitch(harness.route, { state: 'inherit', layer: 'workspace', session: 'session-a' })).statusCode, 200);
  assert.equal(Object.hasOwn(readLayer(path), 'interpolateCustom'), false);

  // Explicit ON, then the legacy close: byte-for-byte back to unstated.
  assert.equal((await setSwitch(harness.route, { state: 'on', layer: 'workspace', session: 'session-a' })).statusCode, 200);
  assert.equal(readLayer(path).interpolateCustom, true);
  assert.equal((await setSwitch(harness.route, { enabled: false, layer: 'workspace', session: 'session-a' })).statusCode, 200);
  assert.equal(Object.hasOwn(readLayer(path), 'interpolateCustom'), false, 'the legacy close still reverts exactly');

  // Shape: anything that is not one of the three states is refused, zero bytes.
  const hash = sha256(path);
  for (const state of ['maybe', '', 1, true, {}]) {
    const res = await setSwitch(harness.route, { state, layer: 'workspace', session: 'session-a' });
    assert.equal(res.statusCode, 400, JSON.stringify(state));
    assert.equal(json(res).code, 'invalid-state', JSON.stringify(state));
  }
  assert.equal(sha256(path), hash, 'no byte moved');
  // And a body with neither spelling keeps the pre-Revision-12 answer.
  const empty = await setSwitch(harness.route, { layer: 'workspace', session: 'session-a' });
  assert.equal(empty.statusCode, 400);
  assert.equal(json(empty).code, 'invalid-enabled');
});

// ---------------------------------------------------------------------------
// Revision 13 (g-026): the two fail-opens the second independent audit found.
// Both are one rule — a verdict may not be taken from data other than the data
// the decision actually uses — so each test moves the two sources apart and
// asserts the write (D1) or the turn (D2) fails closed instead of open.
// ---------------------------------------------------------------------------

test('g-026 rev13 D1: a workspace the registry only lists mid-request cannot slip past the F1 verdict', async () => {
  const workspace = workspaceWith('ws-late', 'session-late', { version: 1, overrides: [] });
  const path = layerPath(workspace);
  // `registry.list()` reads this binding on every call, so the test can move the
  // registry between the two moments the audit separated: the cache refresh at
  // the top of the request (workspace not listed yet) and `targetFor` after the
  // body was read (workspace listed). That is the disagreement — the F1 verdict
  // ranged over `state.workspaces`, the write target over `registry.list()`.
  let rows = [];
  const options = { variables: SWITCH_VARIABLES };
  Object.defineProperty(options, 'workspaces', { get: () => rows, configurable: true });
  const harness = mount(options);
  // Arm the USER layer while no workspace exists at all, so the user's flag is
  // what arms the late workspace layer — and only the cross-layer rule can see it.
  assert.equal((await setSwitch(harness.route, { enabled: true })).statusCode, 200);
  const before = sha256(path);

  const body = JSON.stringify({
    layer: 'workspace',
    session: 'session-late',
    section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'bomb {{nope}}' },
  });
  const res = makeResponse();
  await harness.route.handler({
    method: 'PUT',
    url: OVERRIDES_PATH,
    headers: { 'content-type': 'application/json' },
    destroy() {},
    async *[Symbol.asyncIterator]() {
      // The body appears only after `refreshLayers()` has already run for this
      // request, i.e. after the cache was built without the workspace in it.
      rows = [workspace];
      yield Buffer.from(body);
    },
  }, res);

  assert.equal(res.statusCode, 400, 'the target is judged, never skipped because the cache had not seen it');
  assert.equal(json(res).code, 'unresolvable-variable');
  assert.equal(sha256(path), before, 'zero bytes written');
  assert.equal(readLayer(path).overrides.length, 0);

  // The next request sees the same workspace through the normal path, and the
  // same text is refused there too — the verdict does not depend on the timing.
  assert.equal((await putLayer(harness.route, 'workspace', 'bomb {{nope}}', 'session-late')).statusCode, 400);
  assert.equal(sha256(path), before, 'still zero bytes');
});

test('g-026 rev15 D2: a layer that states ON with an unregistered name cannot fail the first turn', async () => {
  // Cross-process residue or a hand edit: the layer states ON and carries a name
  // nothing registers. The Revision 13 exploit was that the first turn after
  // mount ran before any variable table existed, so the name half of the check
  // slipped through and the turn threw. Under design A there is no window at
  // all: the section is never interpolated, so the first turn is literal and
  // safe by construction.
  writeRaw(userPath(), JSON.stringify({
    version: 1,
    interpolateCustom: true,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'x {{nope}}' }],
  }));
  const agent = { id: 'session-a' };
  const harness = mount({ variables: SWITCH_VARIABLES, agents: [agent] });

  // Not one route request has run: `state.variables` is still null, and that no
  // longer matters to the assembly path.
  const first = await assembleFor(harness, 'session-a');
  const reserved = reservedOf(first);
  assert.equal(reserved.text, 'x {{nope}}', 'the dead reference is left exactly as written');
  assert.equal(reserved.interpolate, false, 'and the strict interpolator is never pointed at it');

  const scoped = json(await call(harness.route, { url: `${SNAPSHOT_PATH}?session=session-a` }));
  assert.equal(Object.hasOwn(scoped.layers, 'interpolationHold'), false, 'rev15: no hold state exists');
  assert.equal(scoped.layers.user.enabled, true, 'the layer is not degraded — it has nothing to be degraded for');
  assert.equal(scoped.layers.user.reason, null);
  assert.equal(scoped.rendered.endsWith('x {{nope}}'), true);
  assert.deepEqual(scoped.unresolvedLiteral, ['nope']);
});

test('g-026 rev15 E1: a registered-but-valueless name is left literal, not "held"', async () => {
  // The write face is soft (the save is accepted with a warning, because the
  // probe table is not the session's table), and Revision 15 makes the assembly
  // soft in the same way: this very table has no value for this very name, so
  // the reference is left literal by the lenient expansion. There is no throw to
  // hold back and no hold state to report.
  writeRaw(userPath(), JSON.stringify({
    version: 1,
    interpolateCustom: true,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'hi {{model}}' }],
  }));
  const agent = { id: 'session-u' };
  const harness = mount({ variables: { model: undefined }, agents: [agent] });

  const first = await assembleFor(harness, 'session-u');
  assert.equal(reservedOf(first).text, 'hi {{model}}', 'no value in this assembly ⇒ the reference stays literal');
  assert.equal(reservedOf(first).interpolate, false);

  const snap = json(await call(harness.route, { url: `${SNAPSHOT_PATH}?session=session-u` }));
  assert.equal(Object.hasOwn(snap.layers, 'interpolationHold'), false);
  assert.equal(snap.layers.user.enabled, true, 'the write/load face still warns instead of refusing the layer');
  assert.equal(snap.rendered.endsWith('hi {{model}}'), true);
  assert.deepEqual(snap.unresolvedLiteral, ['model']);
  assert.deepEqual(snap.unresolvedThrowing, []);
});

test('g-026 rev15 E2/F1: a listener that rewrites the reserved section cannot arm a throw', async () => {
  // The audit's E2 asked where the verdict is taken. Revision 15 removes the
  // verdict entirely: the expansion reads the section list `applyOverrides`
  // produced and the table this assembly carries, and it is lenient — so every
  // rewrite another listener can perform costs at most "this turn was not
  // expanded", never a failed turn.

  // Direction A — an INNER listener (registered after this plugin, without
  // `prepend`) rewrites the reserved text into a dead reference. The expansion
  // runs after it, cannot resolve the name, and leaves it literal.
  writeRaw(userPath(), JSON.stringify({ version: 1, interpolateCustom: true, overrides: [] }));
  const inner = mount({ variables: {}, agents: [{ id: 'session-e2a' }] });
  inner.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next();
    return {
      ...result,
      sections: result.sections.map((section) => (section.name === CUSTOM_SECTION_NAME
        ? { ...section, text: 'boom {{missing}}' }
        : section)),
    };
  });
  const caught = reservedOf(await assembleFor(inner, 'session-e2a'));
  assert.equal(caught.text, 'boom {{missing}}', 'the final section text is what this turn renders');
  assert.equal(caught.interpolate, false, 'and it is never handed to the strict interpolator');
  const caughtSnap = json(await call(inner.route, { url: `${SNAPSHOT_PATH}?session=session-e2a` }));
  assert.equal(Object.hasOwn(caughtSnap.layers, 'interpolationHold'), false);

  // Direction B — an OUTER listener registered AFTER this plugin's mount: the F1
  // shape, where `{prepend: true}` makes a late registration the outermost one.
  // It rewrites the finished value, so the plugin's expansion is overwritten —
  // and that is the whole point. The section still says `interpolate: false`, so
  // the worst case is "not expanded", never a throw.
  const outer = mount({ variables: {}, agents: [{ id: 'session-e2b' }] });
  outer.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next();
    return {
      ...result,
      sections: result.sections.map((section) => (section.name === CUSTOM_SECTION_NAME
        ? { ...section, text: 'late {{nope}}' }
        : section)),
    };
  }, { prepend: true });
  const overwritten = reservedOf(await assembleFor(outer, 'session-e2b'));
  assert.equal(overwritten.text, 'late {{nope}}', 'the outer rewrite wins, as it must');
  assert.equal(overwritten.interpolate, false, 'and it is still never interpolated by DSH');

  // Direction C — an outer listener that only ADDS a value afterwards. The
  // expansion ran a moment earlier with the table it had, so this turn is not
  // expanded: the user sees the literal braces, and the turn is still safe.
  writeRaw(userPath(), JSON.stringify({
    version: 1,
    interpolateCustom: true,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'late is {{late}}' }],
  }));
  const recovered = mount({ variables: {}, agents: [{ id: 'session-e2c' }] });
  recovered.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next();
    return { ...result, variables: { ...result.variables, late: 'L' } };
  }, { prepend: true });
  const safe = reservedOf(await assembleFor(recovered, 'session-e2c'));
  assert.equal(safe.text, 'late is {{late}}', 'the value arrived too late: unexpanded, not broken');
  assert.equal(safe.interpolate, false);
});

test('g-026 rev15: the switch is the only state — ON expands, OFF is literal, and nothing is remembered', async () => {
  // The audit's E3 was about a hold map that remembered stale reasons. Revision
  // 15 deletes the map, so the assertion becomes the stronger one: the switch is
  // the only state that exists, ON expands, OFF is literal, and there is nothing
  // left to go stale.
  const harness = mount({ variables: { model: 'M' }, agents: [{ id: 'session-e3' }] });
  assert.equal((await setSwitch(harness.route, { enabled: true })).statusCode, 200);
  assert.equal((await putText(harness.route, 'I am {{model}}')).statusCode, 200);

  assert.equal(reservedOf(await assembleFor(harness, 'session-e3')).text, 'I am M');
  const live = json(await call(harness.route, { url: `${SNAPSHOT_PATH}?session=session-e3` }));
  assert.equal(live.rendered.includes('I am M'), true);
  assert.equal(Object.hasOwn(live.layers, 'interpolationHold'), false, 'rev15 removed the hold record entirely');

  // Fixing the text needs no bookkeeping, because there is none.
  assert.equal((await putText(harness.route, 'I am a coding agent')).statusCode, 200);
  const fixed = json(await call(harness.route, { url: `${SNAPSHOT_PATH}?session=session-e3` }));
  assert.equal(fixed.rendered.includes('I am a coding agent'), true);
  assert.equal(Object.hasOwn(fixed.layers, 'interpolationHold'), false);

  // Closing the switch takes the expansion away, and the braces are literal
  // again — the OFF promise, with no residual state anywhere.
  assert.equal((await putText(harness.route, 'I am {{model}}')).statusCode, 200);
  assert.equal(reservedOf(await assembleFor(harness, 'session-e3')).text, 'I am M');
  await setSwitch(harness.route, { enabled: false });
  const closed = json(await call(harness.route, { url: `${SNAPSHOT_PATH}?session=session-e3` }));
  assert.equal(closed.rendered.includes('I am {{model}}'), true, 'the braces are literal again, as OFF promises');
  assert.equal(closed.layers.interpolate.effective, false);
  assert.equal(reservedOf(await assembleFor(harness, 'session-e3')).text, 'I am {{model}}');
});

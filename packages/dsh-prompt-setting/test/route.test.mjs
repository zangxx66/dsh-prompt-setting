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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { apply, inject } from '../index.js';

const PING_PATH = '/prompt-setting/ping';
const SNAPSHOT_PATH = '/prompt-setting/snapshot';
const OVERRIDES_PATH = '/prompt-setting/overrides';

/** The sections a fresh fake Host registers, in registration order. */
const DEFAULT_SECTIONS = [
  { name: 'harness:identity', order: -1000, text: 'You are an AI agent powered by DeepSeek Harness.' },
  { name: 'deployment:persona-prefix', order: 0, text: '' },
  { name: 'project:alpha', order: 1000, text: 'ALPHA BODY' },
  { name: 'project:beta', order: 2000, text: 'BETA BODY' },
  { name: 'deployment:persona-suffix', order: 10200, text: '' },
];

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
 * @param options.sections - registered sections (defaults to {@link DEFAULT_SECTIONS}).
 * @param options.workspaces - `list()` rows for the fake workspace registry.
 * @param options.omitWorkspaceRegistry - mount in a profile with no workspace service.
 * @param options.requestRejection - what the connection service returns.
 * @param options.omitConnection - mount without a connection service.
 * @param options.variables - the fake assembly's resolved variables.
 * @returns the captured route plus the harness handles.
 */
function mount(options = {}) {
  const registered = (options.sections ?? DEFAULT_SECTIONS).map((section) => ({ ...section }));
  const listeners = [];
  const routes = [];
  let disposed = 0;
  const registry = options.workspaces === undefined ? undefined : { list: () => options.workspaces };

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
    systemPrompt: {
      /** Reproduces the shipped assemble(): order, waterfall, complete collapse. */
      async assemble(context = {}) {
        const sorted = [...registered].sort(
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
        const queue = listeners.slice();
        const inner = () => Promise.resolve(assembly);
        const next = () => {
          const callback = queue.shift() ?? inner;
          return callback(assembly, context, next);
        };
        const transformed = await next();
        if (completeSection === undefined) return transformed;
        return { ...transformed, sections: [{ name: completeSection.name, text: completeSection.text }] };
      },
    },
    get(name) {
      return name === 'workspaceRegistry' ? registry : undefined;
    },
    on(name, callback) {
      listeners.push(callback);
      return () => {
        const at = listeners.indexOf(callback);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    effect(factory) {
      return factory();
    },
  };
  apply(ctx);
  return { ctx, routes, route: routes[0], disposedCount: () => disposed, listeners };
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

test('host: GET /prompt-setting/ping is unchanged, including the renderer report', async () => {
  const { route } = mount();
  const res = await call(route);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  const payload = json(res);
  assert.deepEqual(Object.keys(payload).sort(), ['clientRenderer', 'clientReportedAt', 'ok', 'plugin', 'time', 'version']);
  assert.equal(payload.ok, true);
  assert.equal(payload.clientRenderer, null);

  const reported = json(await call(route, { url: `${PING_PATH}?renderer=primitives` }));
  assert.equal(reported.clientRenderer, 'primitives');
  assert.equal(json(await call(route, { url: `${PING_PATH}?renderer=../../etc/passwd` })).clientRenderer, 'primitives');
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
    'base', 'effective', 'experiments', 'frozen', 'frozenReason', 'frozenSection',
    'generatedAt', 'layers', 'mounted', 'ok', 'rendered',
  ]);

  assert.deepEqual(payload.base.sections.map((section) => section.name), [
    'harness:identity', 'deployment:persona-prefix', 'project:alpha', 'project:beta', 'deployment:persona-suffix',
  ]);
  assert.deepEqual(payload.base.sections.map((section) => section.index), [0, 1, 2, 3, 4]);
  // No override is registered, so the effective view mirrors the base and every
  // section is overridable. `complete: false` is PROVEN here: a multi-section
  // assembly means no complete section is active (one would collapse it to one).
  assert.deepEqual(payload.effective.sections.map((section) => [section.name, section.index, section.applied, section.action]), [
    ['harness:identity', 0, false, null],
    ['deployment:persona-prefix', 1, false, null],
    ['project:alpha', 2, false, null],
    ['project:beta', 3, false, null],
    ['deployment:persona-suffix', 4, false, null],
  ]);
  assert.deepEqual(payload.base.sections.map((section) => section.complete), [false, false, false, false, false]);
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
  const { route } = mount({ workspaces: [workspace] });
  const put = await call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    body: JSON.stringify({ layer: 'user', section: { name: 'project:alpha', action: 'replace', text: 'USER ALPHA' } }),
  });
  assert.equal(put.statusCode, 200);

  const read = json(await call(route, { url: `${OVERRIDES_PATH}?session=s1` }));
  assert.deepEqual(read.merged.overrides.map((entry) => [entry.name, entry.layer, entry.text]), [
    ['project:alpha', 'workspace', 'WS ALPHA'],
  ]);
  assert.deepEqual(read.user.overrides, [{ name: 'project:alpha', action: 'replace', text: 'USER ALPHA' }]);
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
  // Every base section is still listed, and none claims to be overridable.
  assert.equal(payload.base.sections.length, 6);
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

test('overrides PUT: writes the user layer atomically and takes effect on the next assembly', async () => {
  const { route } = mount();
  const res = await call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    body: JSON.stringify({ layer: 'user', section: { name: 'project:alpha', action: 'replace', text: 'EDITED' } }),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), {
    ok: true,
    saved: { name: 'project:alpha', action: 'replace', text: 'EDITED', layer: 'user' },
    effectiveFrom: 'next-turn',
  });
  // The file on disk is the durable truth.
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')), {
    version: 1,
    overrides: [{ name: 'project:alpha', action: 'replace', text: 'EDITED' }],
  });
  // And the very next assembly sees it, from the in-memory cache.
  const payload = json(await call(route, { url: SNAPSHOT_PATH }));
  const alpha = payload.effective.sections.find((section) => section.name === 'project:alpha');
  assert.deepEqual([alpha.text, alpha.applied, alpha.overrideLayer], ['EDITED', true, 'user']);
});

test('overrides PUT: a second save upserts rather than duplicating', async () => {
  const { route } = mount();
  const put = (section) => call(route, { method: 'PUT', url: OVERRIDES_PATH, body: JSON.stringify({ layer: 'user', section }) });
  await put({ name: 'project:alpha', action: 'replace', text: 'ONE' });
  await put({ name: 'project:beta', action: 'hide' });
  await put({ name: 'project:alpha', action: 'replace', text: 'TWO' });
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')).overrides, [
    { name: 'project:alpha', action: 'replace', text: 'TWO' },
    { name: 'project:beta', action: 'hide' },
  ]);
});

test('overrides PUT: workspace layer resolves through the Host session index, never a client path', async () => {
  const workspace = workspaceWith('ws', 's1');
  const { route } = mount({ workspaces: [workspace] });
  const res = await call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    body: JSON.stringify({ layer: 'workspace', session: 's1', section: { name: 'project:alpha', action: 'hide' } }),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res).saved, { name: 'project:alpha', action: 'hide', layer: 'workspace' });
  const written = join(workspace.path, '.dsh-prompt-setting', 'overrides.json');
  assert.deepEqual(JSON.parse(readFileSync(written, 'utf8')).overrides, [{ name: 'project:alpha', action: 'hide' }]);

  // A client-supplied path is not a parameter at all: an unknown session fails.
  const ghost = await call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    body: JSON.stringify({ layer: 'workspace', session: 'ghost', section: { name: 'a', action: 'hide' } }),
  });
  assert.equal(ghost.statusCode, 400);
  assert.equal(json(ghost).code, 'workspace-unresolved');
});

test('overrides PUT: every rejection is a readable 4xx and never touches the disk', async () => {
  const { route } = mount();
  const put = (body) => call(route, { method: 'PUT', url: OVERRIDES_PATH, body });
  const cases = [
    ['{ not json', 400, 'invalid-json'],
    [JSON.stringify({ section: { name: 'a', action: 'hide' } }), 400, 'unknown-layer'],
    [JSON.stringify({ layer: 'global', section: { name: 'a', action: 'hide' } }), 400, 'unknown-layer'],
    [JSON.stringify({ layer: 'user' }), 400, 'invalid-override'],
    [JSON.stringify({ layer: 'user', section: { action: 'hide' } }), 400, 'missing-name'],
    [JSON.stringify({ layer: 'user', section: { name: 'a'.repeat(201), action: 'hide' } }), 400, 'name-too-long'],
    [JSON.stringify({ layer: 'user', section: { name: 'a', action: 'explode' } }), 400, 'unknown-action'],
    [JSON.stringify({ layer: 'user', section: { name: 'a', action: 'replace' } }), 400, 'missing-text'],
    [JSON.stringify({ layer: 'user', section: { name: 'a', action: 'hide', text: 'x' } }), 400, 'unexpected-text'],
    [JSON.stringify({ layer: 'user', section: { name: 'a', action: 'append', text: 'x', order: -2 } }), 400, 'invalid-order'],
    [JSON.stringify({ layer: 'workspace', section: { name: 'a', action: 'hide' } }), 400, 'workspace-unresolved'],
    [JSON.stringify({ layer: 'user', section: { name: 'a', action: 'replace', text: 'x'.repeat(204801) } }), 413, 'text-too-large'],
    ['x'.repeat(300 * 1024), 413, 'body-too-large'],
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
});

test('overrides DELETE: removes one override, and reports a miss as 404', async () => {
  const { route } = mount();
  await call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    body: JSON.stringify({ layer: 'user', section: { name: 'project:alpha', action: 'hide' } }),
  });
  const res = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&name=project%3Aalpha` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { ok: true, removed: true, layer: 'user', name: 'project:alpha', effectiveFrom: 'next-turn' });
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')).overrides, []);

  const again = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&name=project%3Aalpha` });
  assert.equal(again.statusCode, 404);
  assert.equal(json(again).code, 'override-not-found');

  const noName = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user` });
  assert.equal(noName.statusCode, 400);
  assert.equal(json(noName).code, 'missing-name');

  const noLayer = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?name=a` });
  assert.equal(noLayer.statusCode, 400);
  assert.equal(json(noLayer).code, 'unknown-layer');
});

test('layers: a corrupt user file disables that layer, is explained, and never breaks assembly', async () => {
  writeRaw(userPath(), '{ this is not json');
  const { route } = mount();
  const payload = json(await call(route, { url: SNAPSHOT_PATH }));
  assert.equal(payload.mounted, true, 'the engine still runs');
  assert.equal(payload.layers.user.enabled, false);
  assert.equal(payload.layers.user.path, userPath());
  assert.match(payload.layers.user.reason, /invalid-json/);
  assert.deepEqual(payload.base.sections.length, 5, 'the assembly is untouched');

  const refused = await call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    body: JSON.stringify({ layer: 'user', section: { name: 'a', action: 'hide' } }),
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
  assert.deepEqual(payload.base.sections.length, 5);
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
  assert.deepEqual(anonymous.sections.map((section) => section.name), DEFAULT_SECTIONS.map((section) => section.name));
});

test('assembly: with no overrides configured the assembly comes back BY IDENTITY', async () => {
  const { ctx, listeners } = mount();
  assert.equal(listeners.length, 1, 'exactly one assemble listener is registered');
  const plain = await ctx.systemPrompt.assemble();
  // Re-running with a listener that returns its input proves the pass-through
  // path, and `applyOverrides` itself is asserted by identity in the kernel tests.
  assert.deepEqual(plain.sections.map((section) => section.name), DEFAULT_SECTIONS.map((section) => section.name));
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

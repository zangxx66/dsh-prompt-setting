/**
 * Client-half assertions for stage 1C (the Prompt manager settings page).
 *
 * `client.js` is executed in a `node:vm` context with a stubbed module loader,
 * a stubbed `require`, a minimal hooks runtime, and a stubbed `fetch` router,
 * so the whole contract consumption is asserted without a browser and without
 * touching any real user config: the stub answers from memory, and the only
 * writes it can observe are the JSON bodies the page sent.
 *
 * Run: `node --test test/`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8');
const NS = 'settings.promptSetting';
/** Every documented rejection code (CONTRACT.md §4.4) plus the route-level ones. */
const ERROR_CODES = [
  'invalid-json',
  'invalid-override',
  'missing-name',
  'name-too-long',
  'invalid-name',
  'unknown-action',
  'missing-text',
  'unexpected-text',
  'invalid-order',
  'unexpected-order',
  'unknown-layer',
  'workspace-unresolved',
  'override-not-found',
  'layer-not-writable',
  'text-too-large',
  'body-too-large',
  'assemble-failed',
  'trust-fence-unavailable',
  'not-found',
  'duplicate-name',
];

/**
 * Minimal hooks runtime: index-addressed cells, effects collected per render.
 * @returns the React double plus render bookkeeping.
 */
function makeHooksRuntime() {
  let cells = [];
  let cursor = 0;
  let effects = [];
  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: { ...(props || {}), children: children.length === 1 ? children[0] : children },
      };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
      const set = (next) => {
        cells[index] = typeof next === 'function' ? next(cells[index]) : next;
      };
      return [cells[index], set];
    },
    useEffect(fn) {
      effects.push(fn);
      cursor += 1;
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      cursor += 1;
      // Mirror React's mount behavior: subscribe once, then read the snapshot.
      // This is exactly the path a missing `ctx.locale.subscribe` would break.
      subscribe(() => {});
      return getSnapshot();
    },
    useId: () => 'test-id',
    Fragment: Symbol('Fragment'),
  };
  return {
    React,
    render(component, props) {
      cursor = 0;
      effects = [];
      const tree = component(props);
      const pending = effects;
      effects = [];
      return { tree, pending };
    },
  };
}

/**
 * Expand function components into host nodes.
 *
 * The hooks runtime above calls one component directly; the page's atoms are
 * plain functions, so rendering them here is what lets a test click the real
 * `<button>` the fallback branch produced.
 * @param node - an element, an array of children, or a leaf.
 * @returns the expanded tree.
 */
function expandTree(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(expandTree);
  if (typeof node.type === 'symbol') return expandTree(node.props ? node.props.children : null);
  if (typeof node.type === 'function') return expandTree(node.type(node.props));
  return { ...node, props: { ...node.props, children: expandTree(node.props.children) } };
}

/**
 * Load `client.js` in a vm sandbox.
 * @param primitives - 'ok' to resolve primitives, 'throw' to make the require
 *   fail the way an unlisted package would.
 * @returns the registered descriptor plus the loader bookkeeping.
 */
function loadClient(primitives) {
  let descriptor = null;
  const runtime = makeHooksRuntime();
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          descriptor = entry;
        },
      },
    },
    console,
  };
  sandbox.fetch = () => Promise.reject(new Error('fetch not stubbed'));
  vm.createContext(sandbox);
  vm.runInContext(clientSource, sandbox, { filename: 'client.js' });
  assert.ok(descriptor, 'client.js must register a lazy factory');
  const primitivesModule =
    primitives === 'ok'
      ? {
          Button: () => null,
          Input: () => null,
          Tag: () => null,
          SegmentedTabs: () => null,
        }
      : null;
  const module = descriptor.factory((name) => {
    if (name === 'react') return runtime.React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      if (primitives === 'throw') throw new Error("Cannot find module '@deepseek-ai/dsh-client-ui-primitives'");
      return primitivesModule;
    }
    throw new Error(`unexpected require: ${name}`);
  });
  return { descriptor, module, sandbox, runtime };
}

/**
 * `ctx.locale` shapes the plugin must survive. 'full' is the intended
 * contract; the other three are the failure modes the render-time guard
 * exists for.
 */
const LOCALE_SHAPES = ['full', 'bare', 'throwing', 'noRevision'];

/**
 * Mount the client half against a stubbed cordis context.
 * @param module - the descriptor `client.js` registered.
 * @param localeShape - one of {@link LOCALE_SHAPES}.
 * @returns the captured registration, dictionaries and live ctx.
 */
function mountClient(module, localeShape = 'full') {
  let registeredSlot = null;
  const registrations = [];
  const dictionaries = [];
  const record = (ns, dict0) => {
    dictionaries.push({ ns, dict: dict0 });
    return () => {};
  };
  const locale = {
    full: {
      register: record,
      bind: (ns) => (key) => dict(dictionaries, ns, key),
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 0 }),
    },
    // The service exists but exposes none of the methods we rely on.
    bare: {},
    // Every call throws — the shape a signature change would produce.
    throwing: {
      register: record,
      bind: (ns) => (key) => dict(dictionaries, ns, key),
      subscribe: () => {
        throw new Error('locale.subscribe is not a function');
      },
      getSnapshot: () => {
        throw new Error('locale.getSnapshot is not a function');
      },
    },
    // Snapshot present, but without the `revision` field.
    noRevision: {
      register: record,
      bind: (ns) => (key) => dict(dictionaries, ns, key),
      subscribe: () => () => {},
      getSnapshot: () => ({}),
    },
  }[localeShape];
  const ctx = {
    locale,
    slots: {
      inject(slot, thunk) {
        registeredSlot = slot;
        thunk();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    effect(factory) {
      return factory();
    },
  };
  module.apply(ctx);
  return { ctx, registeredSlot, registrations, dictionaries };
}

/** Resolve a key against the registered dictionaries (identity when missing). */
function dict(dictionaries, ns, key) {
  const entry = dictionaries.find((item) => item.ns === ns);
  return entry && entry.dict.zh && entry.dict.zh[key] !== undefined ? entry.dict.zh[key] : key;
}

/** Depth-first collect of element nodes matching a predicate. */
function collect(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  if (node.props) collect(node.props.children, predicate, out);
  return out;
}

/** Depth-first collect of every rendered string. */
function strings(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) strings(child, out);
    return out;
  }
  if (node.props) strings(node.props.children, out);
  return out;
}

/** Whether any rendered string contains `needle`. */
function hasText(tree, needle) {
  return strings(tree).some((text) => text.includes(needle));
}

/** Read one marker attribute the page carries for on-machine inspection. */
function markerOf(tree, attribute) {
  const markers = collect(tree, (node) => node.props && node.props[attribute] !== undefined);
  assert.equal(markers.length, 1, `exactly one ${attribute} marker`);
  return markers[0].props[attribute];
}

/** The branch marker the page carries for on-machine inspection. */
function rendererOf(tree) {
  return markerOf(tree, 'data-renderer');
}

/** Exactly one node matching the predicate. */
function findOne(tree, predicate, what = 'node') {
  const found = collect(tree, predicate);
  assert.equal(found.length, 1, `exactly one ${what}`);
  return found[0];
}

/** The single node carrying `attribute === value`. */
function oneBy(tree, attribute, value) {
  return findOne(tree, (node) => node.props && node.props[attribute] === value, `${attribute}=${value}`);
}

/** Click the single button matching every attribute pair. */
function clickButton(tree, attrs) {
  const node = findOne(
    tree,
    (candidate) =>
      candidate.type === 'button' &&
      Object.entries(attrs).every(([key, value]) => candidate.props[key] === value),
    `button ${JSON.stringify(attrs)}`,
  );
  assert.notEqual(node.props.disabled, true, `button ${JSON.stringify(attrs)} must be enabled`);
  node.props.onClick();
}

/** Fire a tab click inside one tab group. */
function clickTab(tree, group, value) {
  const node = findOne(
    tree,
    (candidate) =>
      candidate.type === 'button' &&
      candidate.props['data-tab-key'] === group &&
      candidate.props['data-tab-value'] === value,
    `tab ${group}=${value}`,
  );
  node.props.onClick();
}

/** Drive a controlled input the way React would. */
function typeInto(tree, role, value) {
  const node = oneBy(tree, 'data-role', role);
  node.props.onChange({ target: { value } });
}

/** The edit panel's save button (may be disabled on purpose). */
function saveButton(tree) {
  return findOne(tree, (node) => node.type === 'button' && node.props['data-action'] === 'save', 'save button');
}

/** Every write the page attempted (PUT / DELETE), whatever the outcome. */
function writeCalls(page) {
  return page.router.calls.filter((call) => call.init && (call.init.method === 'PUT' || call.init.method === 'DELETE'));
}

/** The single edit button of one section row. */
function editButtonOf(tree, name) {
  return findOne(
    tree,
    (node) =>
      node.type === 'button' && node.props['data-action'] === 'edit' && node.props['data-section-name'] === name,
    `edit button for ${name}`,
  );
}

/** Flush microtasks until the async effects settle. */
async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A `fetch` router backed by in-memory responses.
 * @param responses - path → response (`{status, payload}`, `Error`, or a
 *   function returning one of those).
 * @returns the stub plus the recorded calls.
 */
function makeRouter(responses) {
  const calls = [];
  const table = { ...responses };
  const fetchStub = (url, init) => {
    const target = String(url);
    calls.push({ url: target, init: init || null });
    const path = target.split('?')[0];
    const entry = table[path];
    if (entry === undefined) return Promise.reject(new Error(`no stub for ${target}`));
    const resolved = typeof entry === 'function' ? entry(target, init || {}) : entry;
    if (resolved instanceof Error) return Promise.reject(resolved);
    if (typeof resolved === 'string') {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(resolved) });
    }
    const status = resolved.status === undefined ? 200 : resolved.status;
    return Promise.resolve({
      ok: resolved.ok === undefined ? status < 400 : resolved.ok,
      status,
      text: () => Promise.resolve(JSON.stringify(resolved.payload === undefined ? resolved : resolved.payload)),
    });
  };
  return {
    calls,
    fetchStub,
    set(path, response) {
      table[path] = response;
    },
  };
}

/**
 * Mount the page with a stubbed transport and run the first load.
 * @param options - `responses`, `useSessions`, `primitives`, `localeShape`, `t`.
 * @returns the page harness.
 */
function makePage(options = {}) {
  const loaded = loadClient(options.primitives || 'throw');
  const mounted = mountClient(loaded.module, options.localeShape || 'full');
  const router = makeRouter(options.responses || {});
  loaded.sandbox.fetch = router.fetchStub;
  const props = {
    t: options.t || ((key) => dict(mounted.dictionaries, NS, key)),
    ...mounted.registrations[0].options.inject(),
  };
  if (options.useSessions !== undefined) props.useSessions = options.useSessions;
  const component = mounted.registrations[0].component;
  const draw = () => expandTree(loaded.runtime.render(component, props).tree);
  const flush = async () => {
    const pending = loaded.runtime.render(component, props).pending;
    for (const effect of pending) effect();
    await settle();
    return draw();
  };
  const zh = mounted.dictionaries.length > 0 ? mounted.dictionaries[0].dict.zh : {};
  return { loaded, mounted, router, props, draw, flush, zh };
}

// #region fixtures (shapes copied from CONTRACT.md; no real config involved)

/** `GET /prompt-setting/snapshot` payload covering all four origins. */
function snapshotFixture(over = {}) {
  return {
    ok: true,
    mounted: true,
    generatedAt: '2024-01-01T00:00:00.000Z',
    frozen: false,
    frozenSection: null,
    frozenReason: null,
    frozenScope: 'global',
    frozenScopeReason: null,
    base: {
      sections: [
        { name: 'harness:identity', index: 0, text: 'identity base', complete: false },
        { name: 'project:alpha', index: 1, text: 'alpha base', complete: false },
        { name: 'project:beta', index: 2, text: 'beta base', complete: false },
      ],
    },
    effective: {
      sections: [
        {
          name: 'harness:identity',
          index: 0,
          text: 'identity base',
          applied: false,
          overridable: true,
          reason: null,
          overrideLayer: null,
          action: null,
          origin: 'registered',
        },
        {
          name: 'project:alpha',
          index: 1,
          text: 'alpha overridden',
          applied: true,
          overridable: true,
          reason: null,
          overrideLayer: 'user',
          action: 'replace',
          origin: 'registered',
        },
        {
          name: 'extra:appended',
          index: 2,
          text: 'appended text',
          applied: true,
          overridable: true,
          reason: null,
          overrideLayer: 'user',
          action: 'append',
          origin: 'appended',
        },
        {
          name: 'companion:extra',
          index: 3,
          text: 'added downstream',
          applied: false,
          overridable: true,
          reason: null,
          overrideLayer: null,
          action: null,
          origin: 'downstream-added',
        },
        {
          name: 'ghost:section',
          index: null,
          text: '',
          applied: false,
          overridable: true,
          reason: 'no section or override with this name',
          overrideLayer: null,
          action: 'replace',
          origin: 'unmatched-override',
        },
      ],
    },
    rendered: 'identity base\n\nalpha overridden\n\nappended text\n\nadded downstream',
    renderedResolved: true,
    unresolvedVariables: [],
    layers: {
      user: { enabled: true, path: '/home/u/.dsh/prompt-setting/overrides.json', reason: null },
      workspace: {
        enabled: false,
        path: null,
        reason: 'no ?session= was supplied, so the workspace layer is inactive for this view',
      },
    },
    experiments: { E1: 'e1' },
    ...over,
  };
}

/** `GET /prompt-setting/overrides` payload. */
function overridesFixture(over = {}) {
  return {
    ok: true,
    user: {
      layer: 'user',
      enabled: true,
      path: '/home/u/.dsh/prompt-setting/overrides.json',
      reason: null,
      overrides: [{ name: 'project:alpha', action: 'replace', text: 'alpha overridden' }],
    },
    workspace: {
      layer: 'workspace',
      enabled: false,
      path: null,
      reason: 'no ?session= was supplied, so the workspace layer is inactive for this view',
      overrides: [],
    },
    merged: {
      overrides: [{ name: 'project:alpha', action: 'replace', text: 'alpha overridden', layer: 'user' }],
    },
    ...over,
  };
}

/** Paths the page is allowed to call. */
const PATHS = {
  ping: '/prompt-setting/ping',
  snapshot: '/prompt-setting/snapshot',
  overrides: '/prompt-setting/overrides',
};

/** The default three-route stub table. */
function defaultResponses(over = {}) {
  return {
    [PATHS.ping]: {},
    [PATHS.snapshot]: { payload: snapshotFixture() },
    [PATHS.overrides]: { payload: overridesFixture() },
    ...over,
  };
}

/** The urls of one route, in call order. */
function urlsFor(page, path) {
  return page.router.calls.filter((call) => call.url.startsWith(path)).map((call) => call.url);
}

/** A `useSessions` stub shaped like the renderer's selector hook. */
function sessionsHook(state) {
  return (selector) => selector(state);
}

/** `SessionListState` with one retained (current view) session. */
const SESSIONS_STATE = {
  ids: ['s1', 's2'],
  byId: {
    s1: { id: 's1', displayTitle: 'First', cwd: '/w/one', running: false, retainedBy: { mainView: 0 } },
    s2: { id: 's2', displayTitle: 'Second', cwd: '/w/two', running: true, retainedBy: { mainView: 1 } },
  },
  phase: 'ready',
};

// #endregion

test('client: registers one settings.section entry with the plugin id', () => {
  const { module } = loadClient('throw');
  const { registeredSlot, registrations } = mountClient(module);
  assert.equal(registeredSlot, 'settings.section');
  assert.equal(registrations.length, 1);
  const { options, component } = registrations[0];
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'prompt-setting');
  assert.equal(options.locale, NS);
  assert.equal(typeof component, 'function');
  assert.equal(options.order, 30);
});

test('client: injects the locale namespace thunk and declares zh/en dictionaries', () => {
  const { module } = loadClient('throw');
  const { registrations, dictionaries } = mountClient(module);
  // Spread first: the descriptor's array comes from the vm realm, so it is not
  // reference-equal to a host-realm literal under deepStrictEqual.
  assert.deepEqual([...module.inject], ['slots', 'locale']);
  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0].ns, NS);
  const zh = dictionaries[0].dict.zh;
  const en = dictionaries[0].dict.en;
  assert.ok(zh && en, 'both dictionaries registered');
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.notEqual(zh.nav, en.nav);
  // The nav label is registrant-localized, not hard-coded.
  assert.equal(registrations[0].options.label(), zh.nav);
});

test('client: every documented rejection code has distinct zh/en copy', () => {
  const { module } = loadClient('throw');
  const { dictionaries } = mountClient(module);
  const zh = dictionaries[0].dict.zh;
  const en = dictionaries[0].dict.en;
  for (const code of ERROR_CODES) {
    const key = `error.${code}`;
    assert.equal(typeof zh[key], 'string', `${key} has zh copy`);
    assert.equal(typeof en[key], 'string', `${key} has en copy`);
    assert.ok(zh[key].length > 0 && en[key].length > 0, `${key} is not empty`);
    assert.notEqual(zh[key], en[key], `${key} is actually translated`);
    // The copy must be prose, not the bare identifier it maps from.
    assert.notEqual(zh[key], code);
    assert.notEqual(en[key], code);
  }
});

test('client: an unresolvable primitives module degrades to the fallback renderer', async () => {
  const page = makePage({ responses: defaultResponses() });
  const tree = await page.flush();
  assert.equal(rendererOf(tree), 'fallback');
  // The failure reason is surfaced on the page rather than swallowed.
  assert.ok(hasText(tree, 'Cannot find module'), 'reason rendered');
});

test('client: a resolvable primitives module selects the primitives renderer', async () => {
  const page = makePage({ primitives: 'ok', responses: defaultResponses() });
  const tree = await page.flush();
  assert.equal(rendererOf(tree), 'primitives');
});

test('client: the page renders with no locale seat at all', async () => {
  const page = makePage({ responses: defaultResponses() });
  delete page.props.t;
  delete page.props.subscribeLocale;
  delete page.props.getLocaleRevision;
  const tree = await page.flush();
  assert.equal(rendererOf(tree), 'fallback');
  assert.equal(markerOf(tree, 'data-render-state'), 'ok');
});

// #region transport: the frozen REST contract, no real files touched

test('client: requests stay on the plugin prefix and report the renderer', async () => {
  const page = makePage({ responses: defaultResponses() });
  await page.flush();
  const urls = page.router.calls.map((call) => call.url);
  assert.ok(urls.includes(`${PATHS.ping}?renderer=fallback`), 'the stage 1A renderer report still happens');
  assert.deepEqual(
    [...new Set(urls.map((url) => url.split('?')[0]))].sort(),
    [PATHS.overrides, PATHS.ping, PATHS.snapshot],
  );
  // The global default: no `?session=`, so the workspace layer stays inactive.
  assert.deepEqual(urlsFor(page, PATHS.snapshot), [PATHS.snapshot]);
  assert.deepEqual(urlsFor(page, PATHS.overrides), [PATHS.overrides]);
});

test('client: a 4xx renders the mapped copy plus the raw code, never a blank', async () => {
  for (const [code, status] of [
    ['unexpected-order', 400],
    ['workspace-unresolved', 400],
    ['layer-not-writable', 409],
    ['text-too-large', 413],
    ['assemble-failed', 503],
  ]) {
    const page = makePage({
      responses: defaultResponses({
        [PATHS.snapshot]: { status, payload: { ok: false, code, message: `server says ${code}` } },
      }),
    });
    const tree = await page.flush();
    const banner = oneBy(tree, 'data-error-code', code);
    assert.equal(banner.props['data-error-status'], String(status));
    assert.ok(strings(tree).includes(page.zh[`error.${code}`]), `${code} renders its zh copy`);
    assert.ok(hasText(tree, `server says ${code}`), `${code} keeps the host message`);
    assert.equal(rendererOf(tree), 'fallback');
  }
});

test('client: an unreachable host renders the transport error instead of throwing', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.snapshot]: new Error('Failed to fetch'),
      [PATHS.overrides]: new Error('Failed to fetch'),
    }),
  });
  const tree = await page.flush();
  assert.equal(markerOf(tree, 'data-render-state'), 'ok');
  assert.ok(hasText(tree, 'Failed to fetch'), 'transport error rendered');
  assert.ok(strings(tree).includes(page.zh.errNetwork), 'localized network copy rendered');
});

test('client: an empty assembly renders the empty state rather than crashing', async () => {
  const empty = snapshotFixture({ base: { sections: [] }, effective: { sections: [] }, rendered: '' });
  const page = makePage({
    responses: defaultResponses({
      [PATHS.snapshot]: { payload: empty },
      [PATHS.overrides]: { payload: overridesFixture({ merged: { overrides: [] } }) },
    }),
  });
  const tree = await page.flush();
  assert.equal(markerOf(tree, 'data-phase'), 'empty');
  assert.equal(oneBy(tree, 'data-empty', 'sections').props['data-empty'], 'sections');
  assert.equal(oneBy(tree, 'data-sections-total', '0').props['data-sections-total'], '0');
  assert.ok(strings(tree).includes(page.zh.emptyTitle));
  assert.ok(strings(tree).includes(page.zh.emptyBody));
});

// #endregion

// #region session selector (props `useSessions` root hook, with a degradation)

test('client: the session selector defaults to the current view session', async () => {
  const page = makePage({ useSessions: sessionsHook(SESSIONS_STATE), responses: defaultResponses() });
  const tree = await page.flush();
  assert.equal(markerOf(tree, 'data-session-mode'), 'sessions');
  // `retainedBy.mainView > 0` picks s2, exactly like the product's own selector.
  assert.equal(markerOf(tree, 'data-session'), 's2');
  assert.deepEqual(urlsFor(page, PATHS.snapshot), [`${PATHS.snapshot}?session=s2`]);
  assert.deepEqual(urlsFor(page, PATHS.overrides), [`${PATHS.overrides}?session=s2`]);
  const select = oneBy(tree, 'data-role', 'session-select');
  assert.equal(select.props.value, 's2');
  const options = collect(select, (node) => node.type === 'option');
  assert.equal(options.length, 3, 'global + one option per session');
  assert.equal(options[0].props.children, page.zh.sessionGlobal);
  assert.ok(options.some((option) => option.props.value === 's1' && String(option.props.children).includes('First')));
  assert.ok(
    options.some((option) => option.props.value === 's2' && String(option.props.children).includes('Second')),
    'the session row renders its title',
  );
});

test('client: switching to the global option drops ?session= and re-reads the snapshot', async () => {
  const page = makePage({ useSessions: sessionsHook(SESSIONS_STATE), responses: defaultResponses() });
  let tree = await page.flush();
  tree = await page.flush();
  oneBy(tree, 'data-role', 'session-select').props.onChange({ target: { value: '\u0000global' } });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-session'), 'global');
  const snapshotCalls = urlsFor(page, PATHS.snapshot);
  assert.ok(snapshotCalls.includes(PATHS.snapshot), 'the global view sends no session');
  assert.ok(snapshotCalls.includes(`${PATHS.snapshot}?session=s2`), 'the session view was read first');
});

test('client: a missing useSessions degrades to a manual id and says so', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await page.flush();
  assert.equal(markerOf(tree, 'data-session-mode'), 'manual');
  assert.ok(oneBy(tree, 'data-warning', 'session-degraded'), 'the degradation is announced');
  assert.ok(strings(tree).includes(page.zh.sessionLimit), 'the limitation is stated in words');
  assert.ok(oneBy(tree, 'data-role', 'session-manual'));
  assert.ok(findOne(tree, (node) => node.type === 'button' && node.props['data-action'] === 'session-global'));

  // The manual path works: apply a pasted id and the next read carries it.
  typeInto(tree, 'session-manual', 'manual-7');
  tree = await page.flush();
  clickButton(tree, { 'data-action': 'session-apply' });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-session'), 'manual-7');
  assert.ok(urlsFor(page, PATHS.snapshot).includes(`${PATHS.snapshot}?session=manual-7`), 'the manual id is used');
});

test('client: a useSessions hook that throws degrades instead of blanking the panel', async () => {
  const page = makePage({
    useSessions: () => {
      throw new Error('useSessions is not usable here');
    },
    responses: defaultResponses(),
  });
  const tree = await page.flush();
  assert.equal(markerOf(tree, 'data-render-state'), 'ok');
  assert.equal(markerOf(tree, 'data-session-mode'), 'manual');
  assert.ok(strings(tree).includes(page.zh.sessionLimit));
});

// #endregion

// #region frozenScope: the three states, and editing under uncertainty

test('client: frozenScope "session" is presented as a fact about the session', async () => {
  for (const [frozen, expectedState, copyKey] of [
    [false, 'unfrozen', 'stUnfrozenSession'],
    [true, 'frozen', 'stFrozenSession'],
  ]) {
    const page = makePage({
      useSessions: sessionsHook(SESSIONS_STATE),
      responses: defaultResponses({
        [PATHS.snapshot]: {
          payload: snapshotFixture({
            frozenScope: 'session',
            frozen,
            frozenReason: frozen ? 'the scope collapsed to its complete section' : null,
          }),
        },
      }),
    });
    const tree = await page.flush();
    assert.equal(markerOf(tree, 'data-frozen-scope'), 'session');
    assert.equal(markerOf(tree, 'data-frozen-state'), expectedState);
    assert.ok(strings(tree).includes(page.zh[copyKey]), `${copyKey} rendered`);
    const button = editButtonOf(tree, 'harness:identity');
    if (frozen) {
      assert.equal(button.props.disabled, true, 'a frozen scope disables editing');
      assert.ok(hasText(tree, 'the scope collapsed to its complete section'), 'the reason is shown');
    } else {
      assert.notEqual(button.props.disabled, true, 'an unfrozen scope stays editable');
    }
  }
});

test('client: frozenScope "global" with a session is "unknown", never "not frozen"', async () => {
  const page = makePage({
    useSessions: sessionsHook(SESSIONS_STATE),
    responses: defaultResponses({
      [PATHS.snapshot]: {
        payload: snapshotFixture({
          frozenScope: 'global',
          frozenScopeReason: 'session "s2" has no active agent, so this verdict describes the unscoped assembly',
        }),
      },
    }),
  });
  const tree = await page.flush();
  assert.equal(markerOf(tree, 'data-frozen-scope'), 'global');
  assert.equal(markerOf(tree, 'data-frozen-state'), 'unknown');
  assert.ok(strings(tree).includes(page.zh.stFrozenUnknown), 'the unknown state is stated');
  assert.ok(!hasText(tree, page.zh.stUnfrozenSession), 'it is never presented as "not frozen"');
  const warning = oneBy(tree, 'data-warning', 'frozen-unknown');
  assert.ok(hasText(warning, 'has no active agent'), 'the frozenScopeReason is shown');

  // Editing is warned, not silently allowed and not silently blocked.
  const button = editButtonOf(tree, 'harness:identity');
  assert.notEqual(button.props.disabled, true, 'the section itself is still overridable');
  button.props.onClick();
  const withEditor = await page.flush();
  assert.ok(oneBy(withEditor, 'data-warning', 'edit-uncertain'), 'the editor carries the warning');
  assert.ok(strings(withEditor).includes(page.zh.editWarnUnknown));
});

test('client: frozenScope "global" without a session describes the global assembly', async () => {
  const page = makePage({ responses: defaultResponses() });
  const tree = await page.flush();
  assert.equal(markerOf(tree, 'data-frozen-scope'), 'global');
  assert.equal(markerOf(tree, 'data-frozen-state'), 'unfrozen');
  assert.ok(strings(tree).includes(page.zh.stUnfrozenGlobal));
  assert.ok(!strings(tree).includes(page.zh.stFrozenUnknown));
});

test('client: a non-overridable section disables editing and shows its reason', async () => {
  const payload = snapshotFixture();
  payload.effective.sections[0].overridable = false;
  payload.effective.sections[0].reason = 'this scope observed the change being reverted';
  const page = makePage({ responses: defaultResponses({ [PATHS.snapshot]: { payload } }) });
  const tree = await page.flush();
  const row = oneBy(tree, 'data-section-row', 'harness:identity');
  assert.equal(row.props['data-overridable'], 'false');
  assert.ok(
    hasText(oneBy(tree, 'data-section-reason', 'harness:identity'), 'observed the change being reverted'),
    'the reason original text is shown',
  );
  assert.equal(editButtonOf(tree, 'harness:identity').props.disabled, true);
});

// #endregion

// #region origin labelling, filters, diff and the unresolved warning

test('client: downstream-added is labelled as another plugin, not as an override', async () => {
  const page = makePage({ responses: defaultResponses() });
  const tree = await page.flush();
  const row = oneBy(tree, 'data-section-row', 'companion:extra');
  assert.equal(row.props['data-origin'], 'downstream-added');
  assert.ok(strings(row).includes(page.zh.originDownstream), 'labelled as added by another plugin');
  assert.ok(strings(row).includes(page.zh.originDownstreamHint), 'and explained as normal');
  assert.equal(row.props['data-overridable'], 'true', 'it stays overridable');
  const unmatched = oneBy(tree, 'data-section-row', 'ghost:section');
  assert.equal(unmatched.props['data-origin'], 'unmatched-override');
  assert.ok(strings(unmatched).includes(page.zh.originUnmatchedHint));
});

test('client: the section view filters by layer, overridable and origin', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await page.flush();
  assert.equal(oneBy(tree, 'data-sections-total', '5').props['data-sections-shown'], '5');

  clickTab(tree, 'origin', 'downstream-added');
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-sections-shown'), '1');
  assert.ok(oneBy(tree, 'data-section-row', 'companion:extra'));

  clickTab(tree, 'origin', 'all');
  tree = await page.flush();
  clickTab(tree, 'layer', 'user');
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-sections-shown'), '2');

  clickTab(tree, 'layer', 'all');
  tree = await page.flush();
  clickTab(tree, 'overridable', 'no');
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-sections-shown'), '0');
  assert.equal(markerOf(tree, 'data-sections-total'), '5');
});

test('client: the full-text view highlights search hits and counts them', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await page.flush();
  clickTab(tree, 'view', 'full');
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-search-count'), '0');

  typeInto(tree, 'search', 'alpha');
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-search-count'), '1');
  const hits = collect(tree, (node) => node.props && node.props['data-search-hit'] === 'true');
  assert.equal(hits.length, 1, 'one highlighted fragment');
  assert.equal(hits[0].props.children, 'alpha');
  assert.equal(oneBy(tree, 'data-full-text', 'rendered').props['data-full-text'], 'rendered');
});

test('client: the full-text view can be filtered by origin (recomposed preview)', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await page.flush();
  clickTab(tree, 'view', 'full');
  tree = await page.flush();
  assert.ok(hasText(oneBy(tree, 'data-full-text', 'rendered'), 'identity base'));

  clickTab(tree, 'full-origin', 'downstream-added');
  tree = await page.flush();
  const pre = oneBy(tree, 'data-full-text', 'filtered');
  const text = strings(pre).join('');
  assert.ok(text.includes('added downstream'), 'keeps the downstream section');
  assert.ok(!text.includes('identity base'), 'drops the registered sections');
  assert.ok(strings(tree).includes(page.zh.fullFiltered), 'and says it is a preview');
});

test('client: renderedResolved false marks the text as partial and lists the variables', async () => {
  const payload = snapshotFixture({
    renderedResolved: false,
    unresolvedVariables: ['Upper', 'project:alpha'],
    rendered: 'identity base\n\n{{Upper}} {{project:alpha}}',
  });
  const page = makePage({ responses: defaultResponses({ [PATHS.snapshot]: { payload } }) });
  let tree = await page.flush();
  clickTab(tree, 'view', 'full');
  tree = await page.flush();
  const warning = oneBy(tree, 'data-warning', 'rendered-unresolved');
  assert.equal(warning.props['data-unresolved-variables'], 'Upper,project:alpha');
  assert.ok(strings(tree).includes(page.zh.unresolvedTitle));
  assert.ok(hasText(tree, 'Upper, project:alpha'), 'the list is rendered');
  assert.ok(strings(tree).includes(page.zh.unresolvedNote));
  assert.equal(oneBy(tree, 'data-full-text', 'rendered').props['data-rendered-resolved'], 'false');
});

test('client: the base/effective comparison marks changed, added and removed sections', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await page.flush();
  clickTab(tree, 'view', 'full');
  tree = await page.flush();
  const diff = oneBy(tree, 'data-region', 'diff');
  // base: identity(same), alpha(changed), beta(removed)
  // effective-only: appended, downstream, unmatched  ⇒ 3 added
  assert.equal(diff.props['data-diff-total'], '6');
  assert.equal(diff.props['data-diff-changed'], '5');
  assert.equal(oneBy(tree, 'data-diff-row', 'project:beta').props['data-diff-status'], 'removed');
  assert.equal(oneBy(tree, 'data-diff-row', 'project:alpha').props['data-diff-status'], 'changed');
  assert.equal(oneBy(tree, 'data-diff-row', 'harness:identity').props['data-diff-status'], 'same');
  const detail = oneBy(tree, 'data-diff-detail', 'project:alpha');
  assert.ok(oneBy(detail, 'data-diff-line', 'base'), 'the base side of the change is marked');
  assert.ok(oneBy(detail, 'data-diff-line', 'effective'), 'the effective side of the change is marked');
});

// #endregion

// #region editing and override management

test('client: replace saves without an order and promises the next turn', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await page.flush();
  clickButton(tree, { 'data-action': 'edit', 'data-section-name': 'harness:identity' });
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-region', 'editor').props['data-editor-name'], 'harness:identity');
  assert.equal(oneBy(tree, 'data-role', 'text').props.value, 'identity base');

  typeInto(tree, 'text', 'identity rewritten');
  tree = await page.flush();
  clickButton(tree, { 'data-action': 'save' });
  tree = await page.flush();

  const put = page.router.calls.find((call) => call.init && call.init.method === 'PUT');
  assert.ok(put, 'a PUT was sent');
  assert.equal(put.url, PATHS.overrides);
  const body = JSON.parse(put.init.body);
  assert.equal(body.layer, 'user');
  assert.equal(body.section.name, 'harness:identity');
  assert.equal(body.section.action, 'replace');
  assert.equal(body.section.text, 'identity rewritten');
  assert.ok(!('order' in body.section), 'replace must not carry an order');
  assert.ok(!('session' in body), 'a global view must not smuggle a session');
  assert.ok(oneBy(tree, 'data-notice', 'success'), 'the save is confirmed');
  assert.ok(hasText(tree, page.zh.nextTurn), 'the next-turn promise is stated');
});

test('client: append carries a target index, and a bad index is refused locally', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await page.flush();
  clickButton(tree, { 'data-action': 'edit', 'data-section-name': 'harness:identity' });
  tree = await page.flush();
  // Appending onto a registered name is refused (see the block tests below), so
  // the new section is created under a name nothing has registered yet.
  typeInto(tree, 'name', 'panel:added');
  tree = await page.flush();
  clickTab(tree, 'action', 'append');
  tree = await page.flush();
  assert.ok(oneBy(tree, 'data-role', 'order'), 'append exposes the target index');

  typeInto(tree, 'order', '-3');
  tree = await page.flush();
  clickButton(tree, { 'data-action': 'save' });
  tree = await page.flush();
  assert.equal(
    page.router.calls.filter((call) => call.init && call.init.method === 'PUT').length,
    0,
    'an invalid index never reaches the host',
  );
  assert.ok(strings(tree).includes(page.zh.editOrderInvalid));

  typeInto(tree, 'order', '2');
  tree = await page.flush();
  typeInto(tree, 'text', 'appended by the panel');
  tree = await page.flush();
  clickButton(tree, { 'data-action': 'save' });
  await page.flush();
  const put = page.router.calls.find((call) => call.init && call.init.method === 'PUT');
  const body = JSON.parse(put.init.body);
  assert.equal(body.section.name, 'panel:added', 'the new name is what gets appended');
  assert.equal(body.section.action, 'append');
  assert.equal(body.section.order, 2, 'append order is a target index');
  assert.equal(body.section.text, 'appended by the panel');
});

// #region pre-save validation: never let a save that cannot take effect look successful

test('client: append onto an already-registered name is blocked before any write', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await page.flush();
  clickButton(tree, { 'data-action': 'edit', 'data-section-name': 'harness:identity' });
  tree = await page.flush();
  // `project:beta` exists in `base` only (another listener removed it downstream).
  typeInto(tree, 'name', 'project:beta');
  tree = await page.flush();
  clickTab(tree, 'action', 'append');
  tree = await page.flush();

  const save = saveButton(tree);
  assert.equal(save.props.disabled, true, 'the save button is disabled up front');
  const block = oneBy(tree, 'data-warning', 'override-blocked');
  assert.equal(block.props['data-block-code'], 'name-already-present');
  assert.ok(hasText(block, page.zh.blockAppendExisting), 'the reason and the way out are stated');
  assert.ok(hasText(block, 'name-already-present'), 'and the host code is named');

  // Even a programmatic click on the disabled control writes nothing.
  save.props.onClick();
  assert.equal(writeCalls(page).length, 0, 'zero write requests');
  tree = await page.flush();
  assert.equal(writeCalls(page).length, 0, 'still zero write requests after the click');
});

test('client: append onto a name another plugin added is blocked as well', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await page.flush();
  clickButton(tree, { 'data-action': 'edit', 'data-section-name': 'companion:extra' });
  tree = await page.flush();
  clickTab(tree, 'action', 'append');
  tree = await page.flush();
  // `companion:extra` is absent from `base` and only present because another
  // plugin added it downstream — the two-sections-one-name rule still applies.
  assert.equal(oneBy(tree, 'data-warning', 'override-blocked').props['data-block-code'], 'name-already-present');
  saveButton(tree).props.onClick();
  tree = await page.flush();
  assert.equal(writeCalls(page).length, 0, 'zero write requests');
});

test('client: replace or hide for an unregistered name is blocked before any write', async () => {
  for (const action of ['replace', 'hide']) {
    const page = makePage({ responses: defaultResponses() });
    let tree = await page.flush();
    clickButton(tree, { 'data-action': 'edit', 'data-section-name': 'harness:identity' });
    tree = await page.flush();
    typeInto(tree, 'name', 'never:registered');
    tree = await page.flush();
    clickTab(tree, 'action', action);
    tree = await page.flush();
    const block = oneBy(tree, 'data-warning', 'override-blocked');
    assert.equal(block.props['data-block-code'], 'section-not-present', `${action} is blocked`);
    assert.ok(strings(block).includes(page.zh.blockNotPresent));
    assert.equal(saveButton(tree).props.disabled, true);
    saveButton(tree).props.onClick();
    tree = await page.flush();
    assert.equal(writeCalls(page).length, 0, `${action} writes nothing`);
  }
});

test('client: an empty name set does not crash the validation', async () => {
  const payload = snapshotFixture({
    base: { sections: [] },
    effective: {
      sections: [
        {
          name: 'ghost:section',
          index: null,
          text: '',
          applied: false,
          overridable: true,
          reason: 'no section or override with this name',
          overrideLayer: null,
          action: 'replace',
          origin: 'unmatched-override',
        },
      ],
    },
    rendered: '',
  });
  const page = makePage({ responses: defaultResponses({ [PATHS.snapshot]: { payload } }) });
  let tree = await page.flush();
  clickButton(tree, { 'data-action': 'edit', 'data-section-name': 'ghost:section' });
  tree = await page.flush();
  // Nothing is in the incoming assembly, so replace/hide is provably useless…
  assert.equal(oneBy(tree, 'data-warning', 'override-blocked').props['data-block-code'], 'section-not-present');
  // …while the same name may still be appended as a new section.
  clickTab(tree, 'action', 'append');
  tree = await page.flush();
  assert.equal(saveButton(tree).props.disabled, false, 'append of a new name stays possible');
  assert.equal(collect(tree, (node) => node.props && node.props['data-warning'] === 'override-blocked').length, 0);
});

test('client: an empty name is refused locally as missing-name', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await page.flush();
  clickButton(tree, { 'data-action': 'edit', 'data-section-name': 'harness:identity' });
  tree = await page.flush();
  typeInto(tree, 'name', '   ');
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-warning', 'override-blocked').props['data-block-code'], 'missing-name');
  saveButton(tree).props.onClick();
  tree = await page.flush();
  assert.equal(writeCalls(page).length, 0, 'zero write requests');
});

test('client: the sections view proves why an override did not take effect', async () => {
  const payload = snapshotFixture();
  // A registered section whose append override the Host skipped: `applied:false`
  // with the Host's observation as the reason.
  payload.effective.sections[0].applied = false;
  payload.effective.sections[0].overridable = false;
  payload.effective.sections[0].overrideLayer = 'user';
  payload.effective.sections[0].action = 'append';
  payload.effective.sections[0].reason = 'the appended text was replaced further down the assembly pipeline';
  const page = makePage({ responses: defaultResponses({ [PATHS.snapshot]: { payload } }) });
  const tree = await page.flush();
  const line = oneBy(tree, 'data-section-ineffective', 'name-already-present');
  assert.ok(hasText(line, page.zh.blockAppendExisting), 'the real cause is named');
  assert.ok(strings(line).some((text) => text.includes(page.zh.ovFixHint)), 'and a fix is offered');
  assert.ok(hasText(tree, 'the appended text was replaced further down'), 'the host reason is still visible');
});

test('client: the overrides view shows an ineffective override with cause and fix', async () => {
  const payload = snapshotFixture();
  payload.effective.sections[0].applied = false;
  payload.effective.sections[0].overrideLayer = 'user';
  payload.effective.sections[0].action = 'append';
  payload.effective.sections[0].reason = 'the appended text was replaced further down the assembly pipeline';
  const page = makePage({
    responses: defaultResponses({
      [PATHS.snapshot]: { payload },
      [PATHS.overrides]: {
        payload: overridesFixture({
          merged: {
            overrides: [
              { name: 'harness:identity', action: 'append', text: 'ui-e2e', layer: 'user' },
              { name: 'project:alpha', action: 'replace', text: 'alpha overridden', layer: 'user' },
            ],
          },
        }),
      },
    }),
  });
  let tree = await page.flush();
  clickTab(tree, 'view', 'overrides');
  tree = await page.flush();
  const bad = oneBy(tree, 'data-override-row', 'harness:identity');
  assert.equal(bad.props['data-override-applied'], 'false', 'ineffective is explicit');
  const reason = oneBy(tree, 'data-override-reason', 'harness:identity');
  assert.ok(hasText(reason, page.zh.blockAppendExisting), 'cause shown');
  assert.ok(hasText(bad, 'the appended text was replaced further down'), 'host reason shown too');
  assert.ok(hasText(bad, page.zh.ovFixHint), 'fix hint shown');
  assert.equal(oneBy(tree, 'data-override-row', 'project:alpha').props['data-override-applied'], 'true');
});

// #endregion

test('client: the workspace layer is refused locally when no session is selected', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await page.flush();
  clickButton(tree, { 'data-action': 'edit', 'data-section-name': 'project:alpha' });
  tree = await page.flush();
  assert.ok(oneBy(tree, 'data-warning', 'workspace-layer-disabled'), 'the disabled workspace layer is stated');
  clickTab(tree, 'editor-layer', 'workspace');
  tree = await page.flush();
  clickButton(tree, { 'data-action': 'save' });
  tree = await page.flush();
  assert.equal(
    page.router.calls.filter((call) => call.init && call.init.method === 'PUT').length,
    0,
    'no write without a resolvable workspace',
  );
  assert.ok(strings(tree).includes(page.zh['error.workspace-unresolved']), 'the mapped copy is shown');
});

test('client: a saved override is re-read from a changed snapshot', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await page.flush();
  clickButton(tree, { 'data-action': 'edit', 'data-section-name': 'harness:identity' });
  tree = await page.flush();
  typeInto(tree, 'text', 'identity rewritten');
  tree = await page.flush();
  // The host answers the next snapshot with the new text: the page must show it.
  const after = snapshotFixture();
  after.effective.sections[0].text = 'identity rewritten';
  after.effective.sections[0].applied = true;
  after.effective.sections[0].overrideLayer = 'user';
  after.effective.sections[0].action = 'replace';
  page.router.set(PATHS.snapshot, { payload: after });
  clickButton(tree, { 'data-action': 'save' });
  await settle();
  tree = await page.flush();
  clickButton(tree, { 'data-action': 'expand', 'data-section-name': 'harness:identity' });
  tree = await page.flush();
  const pre = oneBy(tree, 'data-section-full', 'harness:identity');
  assert.ok(hasText(pre, 'identity rewritten'), 'the page re-read the snapshot');
});

test('client: overrides can be listed and undone, one entry at a time', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.overrides]: {
        payload: overridesFixture({
          merged: {
            overrides: [
              { name: 'project:alpha', action: 'replace', text: 'alpha overridden', layer: 'user' },
              { name: 'extra:appended', action: 'append', text: 'appended text', layer: 'workspace' },
            ],
          },
        }),
      },
    }),
  });
  let tree = await page.flush();
  clickTab(tree, 'view', 'overrides');
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-overrides-total', '2').props['data-overrides-total'], '2');
  const first = oneBy(tree, 'data-override-row', 'project:alpha');
  assert.equal(first.props['data-override-layer'], 'user');
  assert.equal(first.props['data-override-action'], 'replace');
  assert.equal(oneBy(tree, 'data-override-row', 'extra:appended').props['data-override-layer'], 'workspace');

  clickButton(tree, { 'data-action': 'undo', 'data-override-name': 'project:alpha' });
  tree = await page.flush();
  const call = page.router.calls.find((entry) => entry.init && entry.init.method === 'DELETE');
  assert.ok(call, 'a DELETE was sent');
  assert.equal(call.url, `${PATHS.overrides}?layer=user&name=${encodeURIComponent('project:alpha')}`);
  assert.ok(hasText(oneBy(tree, 'data-notice', 'success'), page.zh.nextTurn));
});

// #endregion

// #region locale-seat degradation (blocker: a render-time throw would blank the panel)

test('client: the inject face never throws, whatever ctx.locale exposes', () => {
  for (const shape of LOCALE_SHAPES) {
    const { module } = loadClient('throw');
    const { registrations } = mountClient(module, shape);
    const face = registrations[0].options.inject();
    assert.doesNotThrow(() => face.subscribeLocale(() => {}), `subscribeLocale must not throw (${shape})`);
    const unsubscribe = face.subscribeLocale(() => {});
    assert.equal(typeof unsubscribe, 'function', `unsubscribe must be a function (${shape})`);
    let revision;
    assert.doesNotThrow(() => {
      revision = face.getLocaleRevision();
    }, `getLocaleRevision must not throw (${shape})`);
    assert.equal(typeof revision, 'number', `revision must be a number (${shape})`);
  }
});

test('client: a degraded locale seat still renders the page, never a blank', async () => {
  for (const shape of LOCALE_SHAPES) {
    const page = makePage({ localeShape: shape, responses: defaultResponses() });
    const tree = await page.flush();
    assert.equal(rendererOf(tree), 'fallback', `still renders the page (${shape})`);
    assert.equal(markerOf(tree, 'data-render-state'), 'ok', `page rendered, not the failure card (${shape})`);
  }
});

test('client: a missing locale seat entirely still renders the page', async () => {
  const page = makePage({ localeShape: 'bare', responses: defaultResponses() });
  delete page.props.t;
  const tree = await page.flush();
  assert.equal(markerOf(tree, 'data-render-state'), 'ok');
});

test('client: a throw while building the tree renders a failure card, not a blank', () => {
  const { module, runtime } = loadClient('throw');
  const { registrations } = mountClient(module);
  const props = {
    // A translator that explodes: the worst case for the page's own copy.
    t: () => {
      throw new Error('translator exploded');
    },
    ...registrations[0].options.inject(),
  };
  let tree = null;
  assert.doesNotThrow(() => {
    tree = expandTree(runtime.render(registrations[0].component, props).tree);
  });
  assert.equal(rendererOf(tree), 'fallback');
  assert.equal(markerOf(tree, 'data-render-state'), 'error');
  assert.ok(hasText(tree, 'translator exploded'), 'the error text is shown');
  // `t` is the broken thing here, so the card falls back to its literal copy.
  assert.ok(hasText(tree, 'render failure'), 'literal fallback copy is used');
});

// #endregion

test('client: the packaged file list still excludes the tests', () => {
  assert.ok(packageJson.files.includes('client.js'));
  assert.ok(!packageJson.files.includes('test'));
});

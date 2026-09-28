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
  // Stage 2 (CONTRACT.md Revision 4).
  'invalid-history-record',
  'history-unusable',
  'history-not-found',
  'missing-diff-selector',
  'invalid-diff-selector',
  'invalid-export',
  'unknown-export-schema',
  'missing-export-version',
  'unsupported-export-version',
  'missing-export-layers',
  'missing-export-layer',
  'invalid-export-layer',
  'unknown-import-mode',
  'import-verify-failed',
  'import-staging-failed',
  'import-commit-failed',
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
  // The primitives double keeps the atoms' *props* reachable (so a real button
  // can be clicked and a real `DiffBlock` call inspected) while rendering
  // nothing itself — the point is that this page's own markers survive the
  // primitives branch, not that the atoms draw anything.
  const diffBlockCalls = [];
  const atoms = {
    Button: (props) => runtime.React.createElement('button', props),
    Input: () => null,
    Tag: (props) => runtime.React.createElement('span', props),
    SegmentedTabs: (props) =>
      runtime.React.createElement(
        'div',
        { role: 'tablist' },
        (props.items || []).map((item) =>
          runtime.React.createElement(
            'button',
            {
              key: item.value,
              type: 'button',
              'data-tab-value': item.value,
              'data-tab-key': 'primitives',
              onClick: () => props.onChange(item.value),
            },
            item.label,
          ),
        ),
      ),
    DiffBlock: (props) => {
      diffBlockCalls.push(props);
      return null;
    },
  };
  const primitivesModule =
    primitives === 'ok'
      ? atoms
      : // 'icons' = the same module plus the sidebar's own icon components.
        primitives === 'icons'
        ? {
            ...atoms,
            IconFolderOpenRegular: () => null,
            IconFolderCloseRegular: () => null,
            IconTriangleRightFillRegular: () => null,
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
  return { descriptor, module, sandbox, runtime, diffBlockCalls };
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

/** The single node carrying `data-history-row` = value. */
function historyRowOf(tree, id) {
  return oneBy(tree, 'data-history-row', String(id));
}

/** Click a tab in either branch: the fallback uses data-tab-key, the double does not. */
function clickAnyTab(tree, value) {
  const node = findOne(
    tree,
    (candidate) => candidate.type === 'button' && candidate.props['data-tab-value'] === value,
    `tab ${value}`,
  );
  node.props.onClick();
}

/** Install a fake download surface (`document` / `Blob` / `URL`) in the sandbox. */
function installDownloader(page, { blob = true } = {}) {
  const clicks = [];
  const revoked = [];
  const sandbox = page.loaded.sandbox;
  sandbox.document = {
    createElement(tag) {
      const node = {
        tag,
        href: '',
        download: '',
        rel: '',
        click() {
          clicks.push({ href: node.href, download: node.download });
        },
      };
      return node;
    },
    body: { appendChild() {}, removeChild() {} },
  };
  if (blob) {
    sandbox.Blob = function Blob(parts, options) {
      this.parts = parts;
      this.type = options ? options.type : '';
    };
    sandbox.URL = {
      createObjectURL: () => {
        revoked.push('created');
        return 'blob:test-1';
      },
      revokeObjectURL: (url) => revoked.push(url),
    };
  }
  return { clicks, revoked };
}

/** A fake `File`-like object for the file input. */
function fakeFile(text, name = 'export.json') {
  return { name, text: () => Promise.resolve(text) };
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
  if (options.useWorkspaces !== undefined) props.useWorkspaces = options.useWorkspaces;
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

/** `GET /prompt-setting/history` payload: two records for one section. */
function historyFixture(over = {}) {
  const digest = (text) => ({ text, hash: `h-${text.length}`, bytes: text.length });
  return {
    ok: true,
    layer: 'user',
    session: null,
    path: '/home/u/.dsh/prompt-setting/history.jsonl',
    enabled: true,
    reason: null,
    retentionLimit: 100,
    pageLimit: 20,
    total: 2,
    corrupt: 0,
    unreadable: null,
    lastError: null,
    records: [
      {
        id: '2',
        seq: 2,
        at: '2024-01-02T10:00:00.000Z',
        layer: 'user',
        session: null,
        action: 'replace',
        name: 'project:alpha',
        origin: 'import',
        before: digest('alpha base'),
        after: digest('alpha overridden'),
        entries: null,
        snapshot: [{ name: 'project:alpha', action: 'replace', hash: 'h-16', bytes: 16 }],
        note: 'import mode=merge status=replaced',
      },
      {
        id: '1',
        seq: 1,
        at: '2024-01-01T09:00:00.000Z',
        layer: 'user',
        session: null,
        action: 'replace',
        name: 'project:alpha',
        origin: 'ui',
        before: null,
        after: digest('alpha base'),
        entries: null,
        snapshot: [],
        note: null,
      },
    ],
    ...over,
  };
}

/** `GET /prompt-setting/diff` payload: one changed section, exact line ops. */
function diffFixture(over = {}) {
  return {
    ok: true,
    layer: 'user',
    session: null,
    historyPath: '/home/u/.dsh/prompt-setting/history.jsonl',
    scope: 'layer',
    from: {
      kind: 'history', label: '#1', layer: 'user', session: null,
      id: '1', seq: 1, at: '2024-01-01T09:00:00.000Z', action: 'replace', name: 'project:alpha',
    },
    to: {
      kind: 'history', label: '#2', layer: 'user', session: null,
      id: '2', seq: 2, at: '2024-01-02T10:00:00.000Z', action: 'replace', name: 'project:alpha',
    },
    sections: [
      { name: 'project:alpha', status: 'changed', before: { action: 'replace', hash: 'h1', bytes: 10 }, after: { action: 'replace', hash: 'h2', bytes: 16 } },
      { name: 'project:beta', status: 'same', before: { action: 'hide', hash: null, bytes: null }, after: { action: 'hide', hash: null, bytes: null } },
    ],
    sectionsCounts: { total: 2, changed: 1, added: 0, removed: 0, same: 1 },
    lines: {
      name: 'project:alpha',
      ops: [
        { type: 'equal', text: 'alpha', beforeLine: 1, afterLine: 1 },
        { type: 'delete', text: 'base', beforeLine: 2, afterLine: null },
        { type: 'insert', text: 'overridden', beforeLine: null, afterLine: 2 },
      ],
      stats: { added: 1, removed: 1, same: 1 },
      mode: 'lcs',
      crlfNormalized: false,
      truncated: false,
      textBefore: 'alpha\nbase',
      textAfter: 'alpha\noverridden',
    },
    lineReason: null,
    stats: { added: 0, removed: 0, changed: 1, same: 1, lineAdded: 1, lineRemoved: 1 },
    ...over,
  };
}

/** `GET /prompt-setting/export` payload (the document plus `ok`). */
function exportFixture(over = {}) {
  return {
    ok: true,
    schema: 'dsh-prompt-setting/export',
    version: 1,
    exportedAt: '2024-01-02T10:00:00.000Z',
    plugin: { name: 'dsh-prompt-setting', version: '0.1.0' },
    pluginVersion: '0.1.0',
    layers: {
      user: {
        layer: 'user',
        enabled: true,
        reason: null,
        overrides: [{ name: 'project:alpha', action: 'replace', text: 'alpha overridden' }],
      },
      workspace: { layer: 'workspace', enabled: false, reason: 'no ?session= was supplied', overrides: [] },
    },
    ...over,
  };
}

/** `POST /prompt-setting/import?dryRun=true` payload. */
function importPlanFixture(over = {}) {
  return {
    ok: true,
    dryRun: true,
    applied: false,
    mode: 'merge',
    session: null,
    schema: 'dsh-prompt-setting/export',
    exportedAt: '2024-01-02T10:00:00.000Z',
    layers: {
      user: {
        counts: { added: 1, replaced: 1, unchanged: 0, removed: 0, kept: 1 },
        changes: [
          { name: 'project:alpha', status: 'replaced', action: 'replace' },
          { name: 'panel:added', status: 'added', action: 'replace' },
        ],
        path: '/home/u/.dsh/prompt-setting/overrides.json',
        enabled: true,
      },
    },
    imported: ['user'],
    skipped: [{ layer: 'workspace', reason: 'layer "workspace" requires a "session" id', entries: 0 }],
    totals: { added: 1, replaced: 1, unchanged: 0, removed: 0, kept: 1 },
    unchanged: false,
    ...over,
  };
}

/** A valid export document, as the panel would hold it after an export. */
function exportDocument(over = {}) {
  const payload = exportFixture();
  delete payload.ok;
  return JSON.stringify({ ...payload, ...over }, null, 2);
}

/** Paths the page is allowed to call. */
const PATHS = {
  ping: '/prompt-setting/ping',
  snapshot: '/prompt-setting/snapshot',
  overrides: '/prompt-setting/overrides',
  history: '/prompt-setting/history',
  diff: '/prompt-setting/diff',
  export: '/prompt-setting/export',
  import: '/prompt-setting/import',
};

/** The default three-route stub table. */
function defaultResponses(over = {}) {
  return {
    [PATHS.ping]: {},
    [PATHS.snapshot]: { payload: snapshotFixture() },
    [PATHS.overrides]: { payload: overridesFixture() },
    [PATHS.history]: { payload: historyFixture() },
    [PATHS.diff]: { payload: diffFixture() },
    [PATHS.export]: { payload: exportFixture() },
    [PATHS.import]: { payload: importPlanFixture() },
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

/** A synthetic catalog of `count` sessions (ids in Host order, last one current). */
function manySessions(count) {
  const ids = [];
  const byId = {};
  for (let i = 1; i <= count; i += 1) {
    const id = `sess-${i}`;
    ids.push(id);
    byId[id] = {
      id,
      title: `Session ${i}`,
      displayTitle: `Session ${i}`,
      cwd: `/w/${i}`,
      running: i % 2 === 0,
      retainedBy: { mainView: i === count ? 1 : 0 },
    };
  }
  return { ids, byId, phase: 'ready' };
}

/** Three rows that separate the three searchable fields. */
const FILTER_SESSIONS = {
  ids: ['s1', 's2', 's3'],
  byId: {
    s1: { id: 's1', displayTitle: 'Alpha One', title: 'Alpha One', cwd: '/work/alpha', running: false, retainedBy: { mainView: 0 } },
    s2: { id: 's2', displayTitle: 'Beta Two', title: 'Beta Two', cwd: '/work/beta', running: true, retainedBy: { mainView: 1 } },
    s3: { id: 's3', displayTitle: 'Gamma Three', title: 'Gamma Three', cwd: '/work/gamma', running: false, retainedBy: { mainView: 0 } },
  },
  phase: 'ready',
};

/** Fill one `{name}` template the way the page does. */
function fillText(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (params[key] === undefined ? match : String(params[key])));
}

/**
 * Every rendered session row: the flat (degraded) list marks rows
 * `session-option`, the workspace tree marks them `session-row`.
 */
function sessionOptions(tree) {
  return collect(
    tree,
    (node) =>
      node.props && (node.props['data-role'] === 'session-option' || node.props['data-role'] === 'session-row'),
  );
}

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
  // A searchable picker, not a spread-open native select.
  assert.equal(oneBy(tree, 'data-role', 'session-search').props.value, '');
  const options = sessionOptions(tree);
  assert.equal(options.length, 2, 'both sessions are rendered at this size');
  assert.ok(
    options.some((option) => option.props['data-session-id'] === 's1' && strings(option).some((text) => text.includes('First'))),
  );
  assert.ok(
    options.some((option) => option.props['data-session-id'] === 's2' && strings(option).some((text) => text.includes('Second'))),
    'the session row renders its title and path',
  );
  assert.ok(hasText(oneBy(tree, 'data-role', 'session-current'), 'Second'), 'the selection is named');
  assert.equal(oneBy(tree, 'data-pinned', 'global').props['data-pinned-active'], 'false');
  assert.equal(oneBy(tree, 'data-pinned', 'current').props['data-pinned-active'], 'true');
  const count = oneBy(tree, 'data-session-shown', '2');
  assert.equal(count.props['data-session-matched'], '2');
  assert.equal(count.props['data-session-total'], '2');
  assert.ok(hasText(count, fillText(page.zh.sessionMatches, { shown: 2, matched: 2, total: 2 })));
});

test('client: switching to the global option drops ?session= and re-reads the snapshot', async () => {
  const page = makePage({ useSessions: sessionsHook(SESSIONS_STATE), responses: defaultResponses() });
  let tree = await page.flush();
  clickButton(tree, { 'data-action': 'session-pinned', 'data-pinned': 'global' });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-session'), 'global');
  assert.equal(oneBy(tree, 'data-pinned', 'global').props['data-pinned-active'], 'true');
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

// #region the picker must not degrade as the session catalog grows

test('client: the session picker renders a bounded list at every catalog size', async () => {
  for (const [count, expectedShown] of [
    [0, 0],
    [1, 1],
    [200, 20],
  ]) {
    const state = count === 0 ? { ids: [], byId: {}, phase: 'ready' } : manySessions(count);
    const page = makePage({ useSessions: sessionsHook(state), responses: defaultResponses() });
    const tree = await page.flush();
    const options = sessionOptions(tree);
    assert.equal(options.length, expectedShown, `${count} sessions render ${expectedShown} rows`);
    if (count > 20) assert.notEqual(options.length, count, 'the whole catalog is never rendered');
    const countNode = oneBy(tree, 'data-session-shown', String(expectedShown));
    assert.equal(countNode.props['data-session-matched'], String(count));
    assert.equal(countNode.props['data-session-total'], String(count));
    assert.ok(
      hasText(countNode, fillText(page.zh.sessionMatches, { shown: expectedShown, matched: count, total: count })),
      `the count line is right for ${count}`,
    );
    if (count === 0) {
      assert.ok(hasText(tree, page.zh.sessionEmpty), 'the empty catalog is stated');
      assert.equal(oneBy(tree, 'data-pinned', 'current').props.disabled, true, 'nothing to jump to');
      assert.ok(oneBy(tree, 'data-pinned', 'global'), 'global stays reachable');
    }
  }
});

test('client: the session search matches title, path and id, case-insensitively', async () => {
  const page = makePage({ useSessions: sessionsHook(FILTER_SESSIONS), responses: defaultResponses() });
  let tree = await page.flush();
  assert.equal(sessionOptions(tree).length, 3);

  for (const [query, expectedId] of [
    ['ALPHA', 's1'],
    ['/work/beta', 's2'],
    ['S3', 's3'],
  ]) {
    typeInto(tree, 'session-search', query);
    tree = await page.flush();
    const options = sessionOptions(tree);
    assert.equal(options.length, 1, `${query} matches one session`);
    assert.equal(options[0].props['data-session-id'], expectedId);
    assert.equal(oneBy(tree, 'data-session-shown', '1').props['data-session-matched'], '1');
  }
});

test('client: a query that matches nothing becomes a manual session id', async () => {
  const page = makePage({ useSessions: sessionsHook(FILTER_SESSIONS), responses: defaultResponses() });
  let tree = await page.flush();
  typeInto(tree, 'session-search', 'pasted-id-42');
  tree = await page.flush();
  assert.equal(sessionOptions(tree).length, 0, 'nothing matches');
  const entry = oneBy(tree, 'data-action', 'session-use-input');
  assert.equal(entry.props['data-session-id'], 'pasted-id-42');
  assert.ok(hasText(tree, page.zh.sessionNoMatch), 'the fallback is explained');
  assert.ok(hasText(tree, fillText(page.zh.sessionUseInput, { id: 'pasted-id-42' })));

  clickButton(tree, { 'data-action': 'session-use-input' });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-session'), 'pasted-id-42');
  assert.ok(urlsFor(page, PATHS.snapshot).includes(`${PATHS.snapshot}?session=pasted-id-42`));
});

test('client: the pinned entries are never filtered away', async () => {
  const page = makePage({ useSessions: sessionsHook(FILTER_SESSIONS), responses: defaultResponses() });
  let tree = await page.flush();
  typeInto(tree, 'session-search', 'zzz-nothing');
  tree = await page.flush();
  assert.equal(sessionOptions(tree).length, 0);
  assert.ok(oneBy(tree, 'data-pinned', 'global'), 'global is pinned through the search');
  assert.ok(oneBy(tree, 'data-pinned', 'current'), 'the current-view entry is pinned too');

  clickButton(tree, { 'data-action': 'session-pinned', 'data-pinned': 'global' });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-session'), 'global');
  assert.equal(oneBy(tree, 'data-role', 'session-search').props.value, '', 'global clears the search');
  assert.equal(sessionOptions(tree).length, 3, 'and the list is browsable again');

  clickButton(tree, { 'data-action': 'session-pinned', 'data-pinned': 'current' });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-session'), 's2', 'the current-view entry picks the retained session');
  assert.equal(oneBy(tree, 'data-role', 'session-search').props.value, 'Beta Two', 'and names it');
});

test('client: picking a row refills the search box with the readable title', async () => {
  const page = makePage({ useSessions: sessionsHook(FILTER_SESSIONS), responses: defaultResponses() });
  let tree = await page.flush();
  const target = sessionOptions(tree).find((option) => option.props['data-session-id'] === 's1');
  target.props.onClick();
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-session'), 's1');
  assert.equal(oneBy(tree, 'data-role', 'session-search').props.value, 'Alpha One');
  assert.ok(hasText(oneBy(tree, 'data-role', 'session-current'), 'Alpha One'));
});

test('client: the session list is keyboard reachable', async () => {
  const page = makePage({ useSessions: sessionsHook(FILTER_SESSIONS), responses: defaultResponses() });
  let tree = await page.flush();
  const input = () => oneBy(tree, 'data-role', 'session-search');
  input().props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  tree = await page.flush();
  const active = collect(tree, (node) => node.props && node.props['data-session-active'] === 'true');
  assert.equal(active.length, 1, 'exactly one row is highlighted');
  assert.equal(active[0].props['data-session-id'], 's1', 'the first row is highlighted');
  input().props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  tree = await page.flush();
  const second = collect(tree, (node) => node.props && node.props['data-session-active'] === 'true');
  assert.equal(second.length, 1);
  assert.equal(second[0].props['data-session-id'], 's2', 'ArrowDown moves the highlight');
  input().props.onKeyDown({ key: 'Enter', preventDefault() {} });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-session'), 's2', 'Enter selects the highlighted row');
  input().props.onKeyDown({ key: 'Escape', preventDefault() {} });
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-role', 'session-search').props.value, '', 'Esc clears the search');
  assert.equal(sessionOptions(tree).length, 3, 'and the list is back');
});

// #endregion

// #region the workspace tree (grouping, search ancestors, hard render bounds)

/**
 * Mirror of `SCOPE_TOTAL_MAX` in `client.js`: the hard ceiling on session rows
 * the tree may render at any one time.
 */
const SCOPE_RENDER_CAP = 100;
/** Mirror of `SCOPE_GROUP_PAGE`: the initial page of one expanded group. */
const SCOPE_GROUP_PAGE = 10;

/** A `useWorkspaces` stub shaped like the renderer's selector hook. */
function workspacesHook(state) {
  return (selector) => selector(state);
}

/**
 * `WorkspaceSnapshot` in Host order: two workspaces (one with a title, one
 * without so the node must fall back to its path basename), one archived
 * session, one pinned session.
 */
function workspacesFixture(over = {}) {
  return {
    items: [
      {
        workspaceId: 'w-alpha',
        title: 'Alpha repo',
        path: '/work/alpha',
        sessionIds: ['a1', 'a2', 'a3'],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        workspaceId: 'w-beta',
        title: '',
        path: '/work/beta-dir',
        sessionIds: ['b1', 'b2'],
        createdAt: '2024-01-02T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      },
    ],
    archivedSessionIds: ['b2'],
    pinnedSessionIds: ['a2'],
    state: 'idle',
    phase: 'ready',
    error: null,
    ...over,
  };
}

/**
 * Session catalog: `a3` is the retained main-view session, `a2` is pinned and
 * `b2` archived, `loose` belongs to no workspace. `updatedAt` breaks the
 * recency ties so the expected order is exact.
 */
const WORKSPACE_SESSIONS = {
  ids: ['a1', 'a2', 'a3', 'b1', 'b2', 'loose'],
  byId: {
    a1: { id: 'a1', displayTitle: 'Alpha one', title: 'Alpha one', cwd: '/work/alpha', running: false, updatedAt: 300, retainedBy: { mainView: 0 } },
    a2: { id: 'a2', displayTitle: 'Alpha two', title: 'Alpha two', cwd: '/work/alpha', running: true, updatedAt: 100, retainedBy: { mainView: 0 } },
    a3: { id: 'a3', displayTitle: 'Alpha three', title: 'Alpha three', cwd: '/work/alpha', running: false, updatedAt: 200, retainedBy: { mainView: 1 } },
    b1: { id: 'b1', displayTitle: 'Beta one', title: 'Beta one', cwd: '/work/beta-dir', running: false, updatedAt: 50, retainedBy: { mainView: 0 } },
    b2: { id: 'b2', displayTitle: 'Beta archived', title: 'Beta archived', cwd: '/work/beta-dir', running: false, updatedAt: 10, retainedBy: { mainView: 0 } },
    loose: { id: 'loose', displayTitle: 'Loose session', title: 'Loose session', cwd: '/tmp', running: false, updatedAt: 5, retainedBy: { mainView: 0 } },
  },
  phase: 'ready',
};

/** A synthetic catalog of `workspaceCount × perWorkspace` sessions, current = first. */
function manyWorkspaceSessions(workspaceCount, perWorkspace) {
  const ids = [];
  const byId = {};
  const items = [];
  let n = 0;
  for (let w = 1; w <= workspaceCount; w += 1) {
    const sessionIds = [];
    for (let i = 0; i < perWorkspace; i += 1) {
      n += 1;
      const id = `sess-${n}`;
      ids.push(id);
      sessionIds.push(id);
      byId[id] = {
        id,
        title: `Session ${n}`,
        displayTitle: `Session ${n}`,
        cwd: `/w/${w}`,
        running: n % 2 === 0,
        updatedAt: n,
        retainedBy: { mainView: n === 1 ? 1 : 0 },
      };
    }
    items.push({
      workspaceId: `w-${w}`,
      title: `Workspace ${w}`,
      path: `/w/${w}`,
      sessionIds,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
  }
  return {
    sessions: { ids, byId, phase: 'ready' },
    workspaces: { items, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null },
  };
}

/** Every rendered workspace group header, in render order. */
function scopeGroupNodes(tree) {
  return collect(tree, (node) => node.props && node.props['data-scope-group'] !== undefined);
}

/** The group keys, in render order. */
function scopeGroupKeys(tree) {
  return scopeGroupNodes(tree).map((node) => node.props['data-scope-group']);
}

/** The rendered session-row ids, in render order. */
function scopeRowIds(tree) {
  return sessionOptions(tree).map((node) => node.props['data-session-id']);
}

/** One group's interactive header row (the whole row toggles). */
function scopeHeader(tree, key) {
  return oneBy(tree, 'data-scope-group', key);
}

/** One group's folder-glyph column (a second pointer target for the same toggle). */
function scopeIcon(tree, key) {
  return oneBy(tree, 'data-scope-toggle', key);
}

/** Click a non-button node the way a pointer would. */
function clickNode(node, event = {}) {
  node.props.onClick(event);
}

/** Fire one keyboard event at a node. */
function pressKey(node, key) {
  node.props.onKeyDown({ key, preventDefault() {} });
}

test('client: the scope picker groups sessions by workspace, like the sidebar', async () => {
  const page = makePage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  let tree = await page.flush();

  assert.equal(markerOf(tree, 'data-scope-mode'), 'tree');
  // Group order is the Host order of `items`, with the ungrouped bucket last.
  assert.deepEqual(scopeGroupKeys(tree), ['w-alpha', 'w-beta', '']);
  // A workspace node is named by its title, and by the path basename when the
  // title is blank — the sidebar's own precedence.
  const labels = collect(tree, (node) => node.props && node.props['data-role'] === 'scope-group-label');
  assert.deepEqual(
    labels.map((node) => node.props.children),
    ['Alpha repo', 'beta-dir', page.zh.scopeUngrouped],
  );
  assert.ok(hasText(tree, '/work/alpha'), 'the workspace path is a subtitle');
  // Default expansion: the workspace holding the current view session, others shut.
  assert.deepEqual(
    scopeGroupNodes(tree).map((node) => node.props['data-expanded']),
    ['true', 'false', 'false'],
  );
  assert.equal(scopeGroupNodes(tree)[0].props['data-scope-contains-current'], 'true');
  assert.equal(scopeGroupNodes(tree)[0].props['aria-expanded'], true, 'aria-expanded mirrors data-expanded');
  // Recency order (`updatedAt` desc), with the pinned row fronted — the
  // sidebar's own `sectionMembers` partition — and the archived row hidden.
  assert.deepEqual(scopeRowIds(tree), ['a2', 'a1', 'a3']);
  assert.ok(
    sessionOptions(tree).every((node) => node.props['data-scope-parent'] === 'w-alpha'),
    'collapsed groups render no child rows',
  );
  const running = collect(tree, (node) => node.props && node.props['data-role'] === 'session-running');
  assert.equal(running.length, 1, 'the running marker shows on the running session only');
  assert.equal(sessionOptions(tree)[0].props['data-session-running'], 'true');
  assert.equal(oneBy(tree, 'data-pinned', 'global').props['data-pinned-active'], 'false');
  assert.equal(oneBy(tree, 'data-pinned', 'current').props['data-pinned-active'], 'true');
  // 3 + 1 + 1 listed; the archived b2 is announced instead of silently lost.
  const counts = oneBy(tree, 'data-session-shown', '3');
  assert.equal(counts.props['data-session-matched'], '5');
  assert.equal(counts.props['data-session-total'], '5');
  assert.ok(oneBy(tree, 'data-warning', 'scope-archived-hidden'), 'hidden archived rows are stated');
  assert.ok(hasText(tree, fillText(page.zh.scopeSessions, { n: 3 })), 'the group count is shown');
  assert.equal(oneBy(tree, 'data-scope-rendered', '3').props['data-scope-groups'], '3');

  // The keyboard walks the rendered rows across groups, as in the flat list.
  oneBy(tree, 'data-role', 'session-search').props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  tree = await page.flush();
  const active = collect(tree, (node) => node.props && node.props['data-session-active'] === 'true');
  assert.equal(active.length, 1, 'exactly one row is highlighted');
  assert.equal(active[0].props['data-session-id'], 'a2', 'the first rendered row is highlighted');
});

test('client: the scope tree keeps the ancestor workspace of every search match', async () => {
  const page = makePage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  let tree = await page.flush();

  // A title match inside the *second*, collapsed workspace: its ancestor group
  // must survive (carrying the row) while the unrelated group disappears.
  typeInto(tree, 'session-search', 'Beta one');
  tree = await page.flush();
  assert.deepEqual(scopeGroupKeys(tree), ['w-beta']);
  assert.equal(scopeGroupNodes(tree)[0].props['data-expanded'], 'true', 'the match is visible');
  assert.deepEqual(scopeRowIds(tree), ['b1']);
  assert.equal(oneBy(tree, 'data-session-shown', '1').props['data-session-matched'], '1');

  // Matching the workspace *name* keeps every session of that workspace.
  typeInto(tree, 'session-search', 'Alpha repo');
  tree = await page.flush();
  assert.deepEqual(scopeGroupKeys(tree), ['w-alpha']);
  assert.deepEqual(scopeRowIds(tree), ['a2', 'a1', 'a3']);

  // Matching the workspace path does the same.
  typeInto(tree, 'session-search', 'beta-dir');
  tree = await page.flush();
  assert.deepEqual(scopeGroupKeys(tree), ['w-beta']);

  // A query matching only the ungrouped session keeps the ungrouped bucket.
  typeInto(tree, 'session-search', 'Loose');
  tree = await page.flush();
  assert.deepEqual(scopeGroupKeys(tree), ['']);
  assert.deepEqual(scopeRowIds(tree), ['loose']);

  // No match at all ⇒ the typed id stays a way out.
  typeInto(tree, 'session-search', 'nothing-here-42');
  tree = await page.flush();
  assert.deepEqual(scopeGroupKeys(tree), []);
  assert.ok(oneBy(tree, 'data-warning', 'session-no-match'));
  clickButton(tree, { 'data-action': 'session-use-input' });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-session'), 'nothing-here-42');
  assert.ok(urlsFor(page, PATHS.snapshot).includes(`${PATHS.snapshot}?session=nothing-here-42`));
});

test('client: a workspace group folds, unfolds, and pages its rows in', async () => {
  const page = makePage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  let tree = await page.flush();
  assert.deepEqual(scopeRowIds(tree).filter((id) => id === 'b1'), [], 'w-beta starts folded');

  // The glyph column toggles too, and stops the bubble so one click is one flip.
  clickNode(scopeIcon(tree, 'w-beta'), { stopPropagation() {} });
  tree = await page.flush();
  assert.equal(scopeHeader(tree, 'w-beta').props['data-expanded'], 'true');
  assert.ok(scopeRowIds(tree).includes('b1'), 'the folded group now shows its session');
  // The initial page is a page, not the whole group: a 25-session workspace
  // renders 10 rows plus an explicit "show more".
  const big = makePage({
    useSessions: sessionsHook(manyWorkspaceSessions(1, 25).sessions),
    useWorkspaces: workspacesHook(manyWorkspaceSessions(1, 25).workspaces),
    responses: defaultResponses(),
  });
  let bigTree = await big.flush();
  assert.equal(scopeRowIds(bigTree).length, SCOPE_GROUP_PAGE, 'one page, not the whole group');
  const more = oneBy(bigTree, 'data-scope-more', 'w-1');
  assert.ok(
    hasText(more, fillText(big.zh.scopeMore, { n: 25 - SCOPE_GROUP_PAGE })),
    'the remaining count is stated',
  );
  more.props.onClick();
  bigTree = await big.flush();
  assert.equal(scopeRowIds(bigTree).length, SCOPE_GROUP_PAGE * 2, 'one click adds exactly one page');
  assert.equal(oneBy(bigTree, 'data-scope-more', 'w-1').props['data-scope-more'], 'w-1');

  clickNode(scopeHeader(tree, 'w-beta'));
  tree = await page.flush();
  assert.ok(!scopeRowIds(tree).includes('b1'), 'folding it again drops the row');
});

test('client: the scope tree never renders the whole catalog (200 / 500 / 2000 sessions)', async () => {
  const rows = [];
  for (const [workspaceCount, perWorkspace] of [
    [1, 200],
    [4, 50],
    [1, 500],
    [5, 100],
    [1, 2000],
    [20, 100],
  ]) {
    const total = workspaceCount * perWorkspace;
    const state = manyWorkspaceSessions(workspaceCount, perWorkspace);
    const page = makePage({
      useSessions: sessionsHook(state.sessions),
      useWorkspaces: workspacesHook(state.workspaces),
      responses: defaultResponses(),
    });
    let tree = await page.flush();
    // Default: only the group holding the current session is open.
    const defaultRows = scopeRowIds(tree).length;
    assert.equal(defaultRows, SCOPE_GROUP_PAGE, `${total} sessions: one page by default`);
    assert.ok(defaultRows < total, `${total} sessions are not spread open`);

    // A query matching every session opens every group: the global cap is what
    // keeps the DOM bounded, not the fold state.
    const started = process.hrtime.bigint();
    typeInto(tree, 'session-search', 'Session');
    tree = page.draw();
    const keystrokeMs = Number(process.hrtime.bigint() - started) / 1e6;
    const searchRows = scopeRowIds(tree).length;
    const expected = Math.min(SCOPE_RENDER_CAP, workspaceCount * SCOPE_GROUP_PAGE);
    assert.equal(searchRows, expected, `${total} sessions across ${workspaceCount} workspaces: ${expected} rows`);
    assert.ok(searchRows <= SCOPE_RENDER_CAP, 'the render cap holds');
    assert.ok(searchRows < total, `${total} sessions are never fully rendered`);
    assert.equal(oneBy(tree, 'data-session-shown', String(searchRows)).props['data-session-total'], String(total));
    assert.ok(scopeGroupNodes(tree).length <= 41, 'the group headers are bounded too');
    assert.ok(keystrokeMs < 500, `one keystroke stays cheap (${keystrokeMs.toFixed(1)}ms)`);
    rows.push(
      `${total} sessions / ${workspaceCount} workspace(s): default ${defaultRows} rows, search ${searchRows} rows, keystroke ${keystrokeMs.toFixed(1)}ms`,
    );
  }
  // The measurement is part of the evidence, not decoration.
  for (const line of rows) console.log(`    scope scale: ${line}`);
});

test('client: a missing useWorkspaces degrades to the flat searchable list', async () => {
  const flat = makePage({
    useSessions: sessionsHook(manySessions(200)),
    responses: defaultResponses(),
  });
  let tree = await flat.flush();
  assert.equal(markerOf(tree, 'data-scope-mode'), 'flat');
  assert.ok(oneBy(tree, 'data-warning', 'scope-degraded'), 'the degradation is announced');
  assert.ok(strings(tree).includes(flat.zh.scopeDegraded), 'and stated in words');
  assert.equal(scopeRowIds(tree).length, 20, 'the flat list stays bounded');
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'session-tree').length, 0);

  // A workspace hook that throws degrades the same way, without blanking.
  const thrown = makePage({
    useSessions: sessionsHook(SESSIONS_STATE),
    useWorkspaces: () => {
      throw new Error('useWorkspaces is not usable here');
    },
    responses: defaultResponses(),
  });
  tree = await thrown.flush();
  assert.equal(markerOf(tree, 'data-render-state'), 'ok');
  assert.equal(markerOf(tree, 'data-scope-mode'), 'flat');
  assert.ok(oneBy(tree, 'data-warning', 'scope-degraded'));

  // An empty workspace list is *not* a degradation: everything falls into the
  // ungrouped bucket, so no session disappears.
  const empty = makePage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture({ items: [], archivedSessionIds: [], pinnedSessionIds: [] })),
    responses: defaultResponses(),
  });
  tree = await empty.flush();
  assert.equal(markerOf(tree, 'data-scope-mode'), 'tree');
  assert.deepEqual(scopeGroupKeys(tree), ['']);
  // Recency order across the single bucket, with the pinned row fronted.
  assert.deepEqual(scopeRowIds(tree), ['a1', 'a3', 'a2', 'b1', 'b2', 'loose']);
  assert.equal(oneBy(tree, 'data-session-shown', '6').props['data-session-total'], '6');
  assert.equal(oneBy(tree, 'data-session-shown', '6').props['data-session-matched'], '6');
});

test('client: every workspace node advertises and toggles its expansion state', async () => {
  const page = makePage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  let tree = await page.flush();

  // Every group header is a control whose state is visible in attributes *and*
  // in the glyph — the sidebar's affordance, not a line of static text.
  const headers = collect(tree, (node) => node.props && node.props['data-role'] === 'group-toggle');
  assert.equal(headers.length, 3, 'one toggle per rendered group');
  for (const header of headers) {
    const open = header.props['data-expanded'] === 'true';
    assert.equal(typeof header.props.onClick, 'function', 'the whole row is clickable');
    assert.equal(typeof header.props.onKeyDown, 'function', 'the row is keyboard operable');
    assert.equal(header.props.tabIndex, 0, 'the row is in the tab order');
    assert.equal(header.props['aria-expanded'], open, 'aria-expanded mirrors data-expanded');
    assert.equal(header.props.style.cursor, 'pointer');
    assert.ok(header.props['aria-label'], 'the row announces what it does');

    const key = header.props['data-scope-group'];
    const icon = scopeIcon(tree, key);
    assert.equal(icon.props['data-role'], 'scope-folder-icon', 'the glyph column is a pointer target');
    assert.equal(typeof icon.props.onClick, 'function');
    assert.equal(icon.props['data-icon-state'], open ? 'open' : 'closed');
    assert.ok(['inline', 'primitives'].includes(icon.props['data-icon-source']));
    const glyph = collect(icon, (node) => node.props && node.props['data-role'] === 'scope-folder-glyph');
    assert.equal(glyph.length, 1, 'a folder glyph is actually drawn');
    const caret = collect(header, (node) => node.props && node.props['data-role'] === 'scope-caret');
    assert.equal(caret.length, 1, 'one caret per header');
    assert.equal(caret[0].props['data-caret-open'], String(open), 'the caret reflects the same state');
  }

  // Hover and keyboard focus are visible and machine-checkable.
  scopeHeader(tree, 'w-beta').props.onMouseEnter();
  tree = await page.flush();
  assert.equal(scopeHeader(tree, 'w-beta').props['data-hover'], 'true');
  assert.notEqual(scopeHeader(tree, 'w-beta').props.style.background, 'transparent', 'hover changes the fill');
  scopeHeader(tree, 'w-beta').props.onFocus({ target: { matches: () => true } });
  tree = await page.flush();
  assert.equal(scopeHeader(tree, 'w-beta').props['data-focus'], 'true');
  assert.match(String(scopeHeader(tree, 'w-beta').props.style.outline), /focus-ring/, 'the shell ring is reused');
  scopeHeader(tree, 'w-beta').props.onMouseLeave();
  scopeHeader(tree, 'w-beta').props.onBlur();
  tree = await page.flush();
  assert.equal(scopeHeader(tree, 'w-beta').props['data-hover'], 'false');
  assert.equal(scopeHeader(tree, 'w-beta').props['data-focus'], 'false');
  assert.equal(scopeHeader(tree, 'w-beta').props.style.background, 'transparent');

  // Keyboard parity: Enter and Space flip exactly what a click flips.
  const rowsBefore = scopeRowIds(tree).length;
  pressKey(scopeHeader(tree, 'w-beta'), 'Enter');
  tree = await page.flush();
  assert.equal(scopeHeader(tree, 'w-beta').props['data-expanded'], 'true', 'Enter expands');
  assert.ok(scopeRowIds(tree).length > rowsBefore, 'and the group now shows rows');
  pressKey(scopeHeader(tree, 'w-beta'), ' ');
  tree = await page.flush();
  assert.equal(scopeHeader(tree, 'w-beta').props['data-expanded'], 'false', 'Space collapses');
  pressKey(scopeHeader(tree, 'w-beta'), 'Tab');
  tree = await page.flush();
  assert.equal(scopeHeader(tree, 'w-beta').props['data-expanded'], 'false', 'other keys are ignored');

  // Row click and glyph click are two targets of one toggle, never two toggles.
  clickNode(scopeHeader(tree, 'w-beta'));
  tree = await page.flush();
  assert.equal(scopeHeader(tree, 'w-beta').props['data-expanded'], 'true');
  assert.ok(scopeRowIds(tree).length <= SCOPE_RENDER_CAP, 'still inside the render cap');
  clickNode(scopeIcon(tree, 'w-beta'), { stopPropagation() {} });
  tree = await page.flush();
  assert.equal(scopeHeader(tree, 'w-beta').props['data-expanded'], 'false', 'the glyph column toggles too');
  assert.equal(scopeRowIds(tree).length, rowsBefore, 'exactly one flip per click');
});

test('client: the folder glyph is the sidebar artwork in both renderer branches', async () => {
  // Fallback: no primitives module at all ⇒ the same geometry is inlined.
  const inline = makePage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  const inlineTree = await inline.flush();
  const inlineIcon = scopeIcon(inlineTree, 'w-alpha');
  assert.equal(inlineIcon.props['data-icon-source'], 'inline');
  const inlineGlyph = collect(inlineIcon, (node) => node.props && node.props['data-role'] === 'scope-folder-glyph')[0];
  assert.equal(inlineGlyph.type, 'svg', 'drawn with createElement, no dependency');
  assert.equal(inlineGlyph.props.viewBox, '0 0 16 16');
  const inlinePaths = collect(inlineGlyph, (node) => node.type === 'path');
  // The open-folder artwork copied from the primitives package (NOTES §54).
  assert.equal(inlinePaths.length, 3, 'the open glyph keeps all three paths');
  assert.ok(String(inlinePaths[0].props.d).startsWith('M2.55912 7.93683'), 'geometry is copied, not invented');
  assert.equal(inlinePaths[0].props.fill, 'currentColor');
  assert.equal(inlinePaths[0].props.opacity, '0.16', 'the shell keeps the shaded side');

  // Primitives: when the module really exposes the icons, they are reused.
  const prim = makePage({
    primitives: 'icons',
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  const primTree = await prim.flush();
  assert.equal(rendererOf(primTree), 'primitives');
  assert.equal(scopeIcon(primTree, 'w-alpha').props['data-icon-source'], 'primitives');
});

test('client: the selected session and the pinned scope carry an explicit selected mark', async () => {
  const page = makePage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  let tree = await page.flush();

  // The scope defaults to the retained session a3: its row is marked by a bar
  // and a tick, not by text alone.
  const selectedRows = collect(
    tree,
    (node) => node.props && node.props['data-role'] === 'session-row' && node.props['data-selected'] === 'true',
  );
  assert.equal(selectedRows.length, 1, 'exactly one session row is selected');
  assert.equal(selectedRows[0].props['data-session-id'], 'a3');
  assert.equal(selectedRows[0].props['aria-selected'], true);
  assert.match(String(selectedRows[0].props.style.boxShadow), /inset 3px 0 0 0/, 'a colour bar marks the row');
  assert.equal(
    collect(selectedRows[0], (node) => node.props && node.props['data-role'] === 'session-selected-mark').length,
    1,
    'and a tick',
  );

  // Session rows are hoverable too.
  sessionOptions(tree).find((row) => row.props['data-session-id'] === 'a1').props.onMouseEnter();
  tree = await page.flush();
  assert.equal(
    sessionOptions(tree).find((row) => row.props['data-session-id'] === 'a1').props['data-hover'],
    'true',
  );
  assert.notEqual(
    sessionOptions(tree).find((row) => row.props['data-session-id'] === 'a1').props.style.background,
    'transparent',
  );

  // Both pinned entries are real controls with a selected state.
  const pinned = collect(tree, (node) => node.props && node.props['data-role'] === 'pinned-option');
  assert.equal(pinned.length, 2, 'global + current view session');
  for (const entry of pinned) {
    assert.equal(entry.type, 'button');
    assert.equal(typeof entry.props.onClick, 'function');
    assert.equal(entry.props['data-selected'], entry.props['data-pinned-active']);
  }
  const currentPin = pinned.find((entry) => entry.props['data-pinned'] === 'current');
  assert.equal(currentPin.props['data-selected'], 'true');
  assert.equal(
    collect(currentPin, (node) => node.props && node.props['data-role'] === 'pinned-selected-mark').length,
    1,
    'the active pinned entry is ticked',
  );
  const globalPin = pinned.find((entry) => entry.props['data-pinned'] === 'global');
  assert.equal(globalPin.props['data-selected'], 'false');
  globalPin.props.onMouseEnter();
  tree = await page.flush();
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-role'] === 'pinned-option').find(
      (entry) => entry.props['data-pinned'] === 'global',
    ).props['data-hover'],
    'true',
  );

  // Choosing the global scope moves the mark off every session row.
  clickButton(tree, { 'data-action': 'session-pinned', 'data-pinned': 'global' });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-session'), 'global');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-role'] === 'session-row' && node.props['data-selected'] === 'true')
      .length,
    0,
    'no session row claims the selection while the global scope is active',
  );
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-role'] === 'pinned-option').find(
      (entry) => entry.props['data-pinned'] === 'global',
    ).props['data-selected'],
    'true',
  );

  // The flat (degraded) list keeps the same guarantees.
  const flat = makePage({ useSessions: sessionsHook(SESSIONS_STATE), responses: defaultResponses() });
  const flatTree = await flat.flush();
  const flatSelected = collect(
    flatTree,
    (node) => node.props && node.props['data-role'] === 'session-option' && node.props['data-selected'] === 'true',
  );
  assert.equal(flatSelected.length, 1);
  assert.equal(flatSelected[0].props['data-session-id'], 's2');
  assert.equal(
    collect(flatSelected[0], (node) => node.props && node.props['data-role'] === 'session-selected-mark').length,
    1,
  );
  assert.equal(typeof sessionOptions(flatTree)[0].props.onMouseEnter, 'function', 'flat rows hover as well');
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

// #region stage 2: history, diff, restore default, export / import

/** Open the 覆盖 view, where every stage 2 panel lives. */
async function openOverrides(page) {
  let tree = await page.flush();
  clickTab(tree, 'view', 'overrides');
  tree = await page.flush();
  return tree;
}

test('client: the history log is fetched only while the 覆盖 view is open', async () => {
  const page = makePage({ responses: defaultResponses() });
  const sections = await page.flush();
  assert.equal(urlsFor(page, PATHS.history).length, 0, 'the section view pays nothing for the log');
  clickTab(sections, 'view', 'overrides');
  await page.flush();
  assert.deepEqual(urlsFor(page, PATHS.history), [`${PATHS.history}?layer=user&limit=20`]);
});

test('client: the history panel renders records, their action and their origin', async () => {
  const page = makePage({ responses: defaultResponses() });
  const tree = await openOverrides(page);
  const region = oneBy(tree, 'data-region', 'history');
  assert.equal(region.props['data-history-layer'], 'user');
  assert.equal(region.props['data-history-state'], 'ready');
  assert.equal(markerOf(region, 'data-history-total'), '2');

  const newest = historyRowOf(region, '2');
  assert.equal(newest.props['data-history-action'], 'replace');
  assert.equal(newest.props['data-history-name'], 'project:alpha');
  assert.equal(newest.props['data-history-origin'], 'import');
  assert.equal(historyRowOf(region, '1').props['data-history-origin'], 'ui');

  // The record's own timestamp, the localized action and the current-value row.
  assert.ok(hasText(newest, '2024-01-02 10:00:00Z'), 'the ISO timestamp is shown verbatim');
  assert.ok(hasText(newest, page.zh['histAction.replace']), 'the action is localized, not the raw enum');
  assert.equal(oneBy(region, 'data-history-current', 'true').props['data-history-row'], 'current');
  assert.ok(strings(region).includes(page.zh.histCurrent));
});

test('client: an empty or unreadable history is stated, never a blank panel', async () => {
  const empty = makePage({
    responses: defaultResponses({ [PATHS.history]: { payload: historyFixture({ records: [], total: 0 }) } }),
  });
  const emptyTree = await openOverrides(empty);
  assert.ok(oneBy(emptyTree, 'data-empty', 'history'));
  assert.ok(strings(emptyTree).includes(empty.zh.histEmpty));

  const broken = makePage({
    responses: defaultResponses({
      [PATHS.history]: {
        payload: historyFixture({ records: [], total: 0, corrupt: 3, unreadable: 'unreadable-file: cannot read /x', lastError: { at: '2024-01-02T00:00:00.000Z', reason: 'history-unusable: nope' } }),
      },
    }),
  });
  const brokenTree = await openOverrides(broken);
  assert.equal(markerOf(brokenTree, 'data-history-corrupt'), '3');
  assert.ok(oneBy(brokenTree, 'data-history-unreadable', 'true'));
  assert.ok(oneBy(brokenTree, 'data-history-last-error', 'true'));
  assert.ok(hasText(brokenTree, 'unreadable-file: cannot read /x'));
});

test('client: a failing history request shows the mapped copy and keeps the page', async () => {
  const page = makePage({
    responses: defaultResponses({ [PATHS.history]: { status: 400, payload: { ok: false, code: 'unknown-layer', message: 'nope' } } }),
  });
  const tree = await openOverrides(page);
  assert.equal(oneBy(tree, 'data-region', 'history').props['data-history-state'], 'error');
  assert.ok(hasText(tree, page.zh['error.unknown-layer']));
  assert.equal(markerOf(tree, 'data-render-state'), 'ok', 'the page itself still renders');
});

test('client: choosing two records requests the comparison and renders both levels', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openOverrides(page);

  clickButton(historyRowOf(tree, '2'), { 'data-action': 'diff-from', 'data-history-id': '2' });
  tree = await page.flush();
  clickButton(historyRowOf(tree, '1'), { 'data-action': 'diff-to', 'data-history-id': '1' });
  tree = await page.flush();

  // `to` starts at `current`, so the first click already compares against the
  // live value; the second click re-runs with the chosen record.
  assert.deepEqual(urlsFor(page, PATHS.diff), [
    `${PATHS.diff}?layer=user&from=2&to=current`,
    `${PATHS.diff}?layer=user&from=2&to=1`,
  ]);
  const panel = oneBy(tree, 'data-region', 'history-diff');
  assert.equal(panel.props['data-diff-state'], 'ready');
  assert.equal(markerOf(panel, 'data-diff-from'), '2');
  assert.equal(markerOf(panel, 'data-diff-to'), '1');
  assert.equal(markerOf(panel, 'data-diff-sections'), '2');
  assert.equal(markerOf(panel, 'data-diff-changed'), '1');
  assert.equal(oneBy(panel, 'data-hd-row', 'project:alpha').props['data-hd-status'], 'changed');
  assert.equal(oneBy(panel, 'data-hd-row', 'project:beta').props['data-hd-status'], 'same');
  assert.equal(markerOf(panel, 'data-diff-line-name'), 'project:alpha');
  assert.equal(markerOf(panel, 'data-diff-mode'), 'lcs');
  assert.equal(markerOf(panel, 'data-diff-line-added'), '1');
  assert.equal(markerOf(panel, 'data-diff-line-removed'), '1');
  assert.equal(markerOf(panel, 'data-diff-renderer'), 'fallback', 'primitives is unavailable in this double');
  assert.equal(oneBy(panel, 'data-region', 'diffblock').props['data-diff-block'], 'fallback');
  // The fallback renders the host's own ops line by line, add and remove marked.
  assert.equal(collect(panel, (node) => node.props && node.props['data-diff-op'] === 'insert').length, 1);
  assert.equal(collect(panel, (node) => node.props && node.props['data-diff-op'] === 'delete').length, 1);
  assert.ok(hasText(panel, '- base'));
  assert.ok(hasText(panel, '+ overridden'));
});

test('client: the comparison can put the live value on either side', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openOverrides(page);
  const current = oneBy(tree, 'data-history-current', 'true');
  clickButton(current, { 'data-action': 'diff-to', 'data-history-id': 'current' });
  tree = await page.flush();
  assert.equal(urlsFor(page, PATHS.diff).length, 0, 'from is still unset, so nothing is sent');

  clickButton(historyRowOf(tree, '1'), { 'data-action': 'diff-from', 'data-history-id': '1' });
  tree = await page.flush();
  assert.deepEqual(urlsFor(page, PATHS.diff), [`${PATHS.diff}?layer=user&from=1&to=current`]);
});

test('client: a comparison the host could not make is explained, not left empty', async () => {
  const payload = diffFixture({ lines: null, lineReason: 'more than one section differs; pass ?name= to compare one of them' });
  const page = makePage({ responses: defaultResponses({ [PATHS.diff]: { payload } }) });
  let tree = await openOverrides(page);
  clickButton(historyRowOf(tree, '1'), { 'data-action': 'diff-from', 'data-history-id': '1' });
  tree = await page.flush();
  const panel = oneBy(tree, 'data-region', 'history-diff');
  assert.equal(markerOf(panel, 'data-diff-no-lines'), 'true');
  assert.ok(hasText(panel, 'more than one section differs'));
});

test('client: the primitives branch renders the comparison with the official DiffBlock', async () => {
  const page = makePage({ primitives: 'ok', responses: defaultResponses() });
  let tree = await page.flush();
  clickAnyTab(tree, 'overrides');
  tree = await page.flush();
  assert.equal(rendererOf(tree), 'primitives');

  clickButton(tree, { 'data-action': 'diff-from', 'data-history-id': '1' });
  tree = await page.flush();
  const panel = oneBy(tree, 'data-region', 'history-diff');
  assert.equal(markerOf(panel, 'data-diff-renderer'), 'diffblock');
  assert.equal(oneBy(panel, 'data-region', 'diffblock').props['data-diff-block'], 'primitives');

  const calls = page.loaded.diffBlockCalls;
  assert.equal(calls.length, 1, 'DiffBlock is called exactly once per comparison');
  // The props object comes from the vm realm, so compare its JSON form.
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].diffs)), [
    { path: 'project:alpha', oldText: 'alpha\nbase', newText: 'alpha\noverridden' },
  ]);
  assert.equal(calls[0].maxLines, 200);
  // DiffBlock's own chrome is supplied, localized, by this page.
  for (const key of ['copy', 'copied', 'collapse', 'collapseAria', 'codeLabel', 'wrapLabel', 'unwrapLabel']) {
    assert.equal(typeof calls[0].labels[key], 'string', `DiffBlock label ${key}`);
  }
  assert.equal(typeof calls[0].labels.expand, 'function');
  assert.equal(calls[0].labels.expand(4), page.zh.diffBlockExpand.replace('{n}', '4'));
});

test('client: switching the history layer to the workspace asks for a session first', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openOverrides(page);
  clickTab(tree, 'history-layer', 'workspace');
  tree = await page.flush();
  const region = oneBy(tree, 'data-region', 'history');
  assert.equal(region.props['data-history-layer'], 'workspace');
  assert.equal(oneBy(region, 'data-history-note', 'no-session').props['data-history-note'], 'no-session');
  assert.equal(urlsFor(page, PATHS.history).length, 1, 'no request without a session');

  // With a session the layer is fetched, and the request carries it.
  const sessionPage = makePage({
    useSessions: sessionsHook(SESSIONS_STATE),
    responses: defaultResponses({ [PATHS.history]: { payload: historyFixture({ layer: 'workspace', session: 's1' }) } }),
  });
  let sessionTree = await openOverrides(sessionPage);
  clickTab(sessionTree, 'history-layer', 'workspace');
  sessionTree = await sessionPage.flush();
  assert.deepEqual(urlsFor(sessionPage, PATHS.history), [
    `${PATHS.history}?layer=user&session=s2&limit=20`,
    `${PATHS.history}?layer=workspace&session=s2&limit=20`,
  ]);
  assert.equal(markerOf(sessionTree, 'data-history-total'), '2');
});

test('client: restoring one section default asks first and then clears every layer that holds it', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openOverrides(page);
  const button = findOne(
    tree,
    (node) => node.type === 'button' && node.props['data-action'] === 'reset-section' && node.props['data-section-name'] === 'project:alpha',
    'reset-section button',
  );
  assert.equal(button.props['data-reset-layers'], 'user', 'the affected layers are stated on the control');

  button.props.onClick();
  tree = await page.flush();
  const card = oneBy(tree, 'data-region', 'confirm');
  assert.equal(card.props['data-confirm-kind'], 'reset-section');
  assert.ok(hasText(card, 'project:alpha'));
  assert.ok(hasText(card, page.zh.ovUser), 'the impact names the layer');
  assert.ok(hasText(card, page.zh.resetIrreversible), 'and says it cannot be undone');

  // Cancel: nothing is sent.
  clickButton(card, { 'data-action': 'confirm-no' });
  tree = await page.flush();
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'confirm').length, 0);
  assert.equal(writeCalls(page).length, 0);

  // Confirm: exactly one DELETE, for the one layer that holds the name.
  findOne(tree, (node) => node.type === 'button' && node.props['data-action'] === 'reset-section' && node.props['data-section-name'] === 'project:alpha', 'reset-section button').props.onClick();
  tree = await page.flush();
  clickButton(oneBy(tree, 'data-region', 'confirm'), { 'data-action': 'confirm-yes' });
  tree = await page.flush();
  assert.deepEqual(writeCalls(page).map((call) => [call.init.method, call.url]), [
    ['DELETE', `${PATHS.overrides}?layer=user&name=project%3Aalpha`],
  ]);
  assert.ok(hasText(tree, page.zh.resetDoneNotice.replace('{count}', '1')));
});

test('client: a section held by both layers clears both, one request per layer', async () => {
  const ovs = overridesFixture({
    workspace: {
      layer: 'workspace',
      enabled: true,
      path: '/w/one/.dsh-prompt-setting/overrides.json',
      reason: null,
      overrides: [{ name: 'project:alpha', action: 'replace', text: 'workspace alpha' }],
    },
  });
  const page = makePage({
    useSessions: sessionsHook(SESSIONS_STATE),
    responses: defaultResponses({ [PATHS.overrides]: { payload: ovs } }),
  });
  let tree = await openOverrides(page);
  const button = findOne(
    tree,
    (node) => node.type === 'button' && node.props['data-action'] === 'reset-section' && node.props['data-section-name'] === 'project:alpha',
    'reset-section button',
  );
  assert.equal(button.props['data-reset-layers'], 'user,workspace');
  button.props.onClick();
  tree = await page.flush();
  assert.ok(hasText(oneBy(tree, 'data-region', 'confirm'), page.zh.ovWorkspace));
  clickButton(oneBy(tree, 'data-region', 'confirm'), { 'data-action': 'confirm-yes' });
  tree = await page.flush();
  assert.deepEqual(writeCalls(page).map((call) => call.url), [
    `${PATHS.overrides}?layer=user&session=s2&name=project%3Aalpha`,
    `${PATHS.overrides}?layer=workspace&session=s2&name=project%3Aalpha`,
  ]);
});

test('client: resetting a whole layer needs a confirmation and states the impact', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openOverrides(page);
  const region = oneBy(tree, 'data-region', 'layer-reset');
  assert.equal(region.props['data-reset-layer'], 'user');
  assert.equal(region.props['data-reset-count'], '1');
  assert.ok(hasText(region, page.zh.resetLayerBody.replace('{layer}', page.zh.ovUser).replace('{count}', '1')));

  clickButton(region, { 'data-action': 'reset-layer', 'data-layer': 'user' });
  tree = await page.flush();
  const card = oneBy(tree, 'data-region', 'confirm');
  assert.equal(card.props['data-confirm-kind'], 'reset-layer');
  clickButton(card, { 'data-action': 'confirm-yes' });
  tree = await page.flush();
  assert.deepEqual(writeCalls(page).map((call) => [call.init.method, call.url]), [
    ['DELETE', `${PATHS.overrides}?layer=user&reset=true`],
  ]);
  assert.ok(hasText(tree, page.zh.resetNoneNotice), 'the double answers count 0, and the page says so');
});

test('client: the layer reset is disabled when the layer holds nothing', async () => {
  const page = makePage({
    responses: defaultResponses({ [PATHS.overrides]: { payload: overridesFixture({ user: { layer: 'user', enabled: true, path: '/p', reason: null, overrides: [] } }) } }),
  });
  const tree = await openOverrides(page);
  const button = findOne(tree, (node) => node.type === 'button' && node.props['data-action'] === 'reset-layer', 'reset-layer button');
  assert.equal(button.props.disabled, true);
});

test('client: exporting downloads the document and keeps a copyable text', async () => {
  const page = makePage({
    useSessions: sessionsHook(SESSIONS_STATE),
    responses: defaultResponses(),
  });
  const downloader = installDownloader(page);
  let tree = await openOverrides(page);
  clickButton(oneBy(tree, 'data-region', 'transfer'), { 'data-action': 'export' });
  tree = await page.flush();

  assert.deepEqual(urlsFor(page, PATHS.export), [`${PATHS.export}?session=s2`]);
  assert.equal(downloader.clicks.length, 1, 'one download was triggered');
  // Identifiable and time-ordered: the ISO timestamp with the punctuation
  // replaced, so the name is filesystem-safe and sorts by export time.
  assert.match(downloader.clicks[0].download, /^dsh-prompt-setting-2024-01-02T10-00-00-000\.json$/);
  assert.equal(downloader.clicks[0].href, 'blob:test-1');
  assert.equal(downloader.revoked.includes('blob:test-1'), true, 'the object URL is revoked');

  const text = oneBy(tree, 'data-role', 'export-text').props.value;
  const document = JSON.parse(text);
  assert.equal(document.schema, 'dsh-prompt-setting/export');
  assert.equal(document.version, 1);
  assert.equal('ok' in document, false, 'the liveness flag is not part of the document');
  assert.equal(markerOf(tree, 'data-export-name'), 'dsh-prompt-setting-2024-01-02T10-00-00-000.json');
  assert.ok(hasText(tree, page.zh.downloadDone.replace('{name}', 'dsh-prompt-setting-2024-01-02T10-00-00-000.json')));
});

test('client: an export with no download surface still yields the JSON and says why', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openOverrides(page);
  clickButton(oneBy(tree, 'data-region', 'transfer'), { 'data-action': 'export' });
  tree = await page.flush();
  // No `document` in the sandbox at all: the page must not claim a download.
  assert.equal(oneBy(tree, 'data-region', 'transfer').props['data-transfer-phase'], 'error');
  assert.ok(hasText(tree, page.zh.downloadFailed.replace('{reason}', 'no document')));
  assert.equal(JSON.parse(oneBy(tree, 'data-role', 'export-text').props.value).version, 1);
  assert.ok(oneBy(tree, 'data-error-code', 'download-failed'));
});

test('client: an import preview dry-runs, renders the plan and writes nothing', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openOverrides(page);
  const panel = () => oneBy(tree, 'data-region', 'transfer');

  // Nothing to preview yet: the button is disabled and clicking is refused.
  const preview = findOne(tree, (node) => node.type === 'button' && node.props['data-action'] === 'import-preview', 'preview button');
  assert.equal(preview.props.disabled, true);
  preview.props.onClick();
  assert.equal(urlsFor(page, PATHS.import).length, 0);

  typeInto(tree, 'import-text', exportDocument());
  tree = await page.flush();
  clickButton(panel(), { 'data-action': 'import-preview' });
  tree = await page.flush();

  assert.deepEqual(urlsFor(page, PATHS.import), [`${PATHS.import}?dryRun=true&mode=merge`]);
  const call = page.router.calls.find((entry) => entry.url.startsWith(PATHS.import));
  assert.equal(call.init.method, 'POST');
  assert.equal(JSON.parse(call.init.body).schema, 'dsh-prompt-setting/export');
  assert.equal(panel().props['data-transfer-phase'], 'preview');

  const plan = oneBy(tree, 'data-import-plan', 'true');
  assert.equal(plan.props['data-import-added'], '1');
  assert.equal(plan.props['data-import-replaced'], '1');
  assert.equal(plan.props['data-import-removed'], '0');
  assert.equal(plan.props['data-import-kept'], '1');
  assert.equal(plan.props['data-import-applied'], 'false', 'a preview is not an application');
  assert.equal(oneBy(plan, 'data-import-change', 'project:alpha').props['data-import-status'], 'replaced');
  assert.equal(oneBy(plan, 'data-import-change', 'panel:added').props['data-import-status'], 'added');
  assert.equal(oneBy(plan, 'data-import-skipped', '1').props['data-import-skipped'], '1');
  assert.equal(writeCalls(page).length, 0, 'a dry run never writes');
});

test('client: applying an import is confirmed first and then posts without dryRun', async () => {
  const applied = importPlanFixture({ dryRun: false, applied: true, written: ['/home/u/.dsh/prompt-setting/overrides.json'] });
  const page = makePage({
    responses: defaultResponses({
      [PATHS.import]: (url) => ({ payload: url.includes('dryRun=true') ? importPlanFixture() : applied }),
    }),
  });
  let tree = await openOverrides(page);
  typeInto(tree, 'import-text', exportDocument());
  tree = await page.flush();
  clickButton(oneBy(tree, 'data-region', 'transfer'), { 'data-action': 'import-preview' });
  tree = await page.flush();

  const apply = findOne(tree, (node) => node.type === 'button' && node.props['data-action'] === 'import-apply', 'apply button');
  assert.notEqual(apply.props.disabled, true, 'a previewed plan enables the apply');
  apply.props.onClick();
  tree = await page.flush();
  const card = oneBy(tree, 'data-region', 'confirm');
  assert.equal(card.props['data-confirm-kind'], 'import');
  assert.ok(hasText(card, page.zh.resetIrreversible));

  clickButton(card, { 'data-action': 'confirm-yes' });
  tree = await page.flush();
  assert.deepEqual(urlsFor(page, PATHS.import), [
    `${PATHS.import}?dryRun=true&mode=merge`,
    `${PATHS.import}?mode=merge`,
  ]);
  assert.equal(oneBy(tree, 'data-region', 'transfer').props['data-transfer-phase'], 'applied');
  assert.ok(hasText(tree, page.zh.importAppliedNotice.replace('{written}', '1').replace('{count}', '2')));
});

test('client: the import conflict strategy is chosen in the panel and sent with the request', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openOverrides(page);
  assert.equal(oneBy(tree, 'data-region', 'transfer').props['data-import-mode'], 'merge');
  clickTab(tree, 'import-mode', 'replace');
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-region', 'transfer').props['data-import-mode'], 'replace');
  typeInto(tree, 'import-text', exportDocument());
  tree = await page.flush();
  clickButton(oneBy(tree, 'data-region', 'transfer'), { 'data-action': 'import-preview' });
  assert.deepEqual(urlsFor(page, PATHS.import), [`${PATHS.import}?dryRun=true&mode=replace`]);
});

test('client: a rejected import shows the reason and states that nothing changed', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.import]: { status: 400, payload: { ok: false, code: 'unknown-export-schema', message: '"schema" must be "dsh-prompt-setting/export"' } },
    }),
  });
  let tree = await openOverrides(page);
  typeInto(tree, 'import-text', exportDocument({ schema: 'nope' }));
  tree = await page.flush();
  clickButton(oneBy(tree, 'data-region', 'transfer'), { 'data-action': 'import-preview' });
  tree = await page.flush();

  assert.ok(hasText(tree, page.zh['error.unknown-export-schema']));
  assert.ok(oneBy(tree, 'data-error-code', 'unknown-export-schema'));
  assert.equal(oneBy(tree, 'data-import-unchanged', 'true').props['data-import-unchanged'], 'true');
  assert.equal(collect(tree, (node) => node.props && node.props['data-import-plan'] === 'true').length, 0);
});

test('client: a pasted non-JSON document is refused locally, without a request', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openOverrides(page);
  typeInto(tree, 'import-text', '{ not json');
  tree = await page.flush();
  clickButton(oneBy(tree, 'data-region', 'transfer'), { 'data-action': 'import-preview' });
  tree = await page.flush();
  assert.equal(urlsFor(page, PATHS.import).length, 0);
  assert.ok(oneBy(tree, 'data-error-code', 'invalid-json'));
  assert.ok(hasText(tree, page.zh.importUnchangedWarning));
});

test('client: a chosen export file fills the import box', async () => {
  const page = makePage({ responses: defaultResponses() });
  const tree = await openOverrides(page);
  const input = oneBy(tree, 'data-role', 'import-file');
  input.props.onChange({ target: { files: [fakeFile(exportDocument())] } });
  await settle();
  const next = await page.flush();
  assert.equal(oneBy(next, 'data-role', 'import-text').props.value.includes('dsh-prompt-setting/export'), true);
});

test('client: the stage 2 panels never render a blank page when the host is unreachable', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.history]: new Error('boom'),
      [PATHS.export]: new Error('boom'),
      [PATHS.import]: new Error('boom'),
    }),
  });
  let tree = await openOverrides(page);
  clickButton(oneBy(tree, 'data-region', 'transfer'), { 'data-action': 'export' });
  tree = await page.flush();
  typeInto(tree, 'import-text', exportDocument());
  tree = await page.flush();
  clickButton(oneBy(tree, 'data-region', 'transfer'), { 'data-action': 'import-preview' });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-render-state'), 'ok');
  assert.equal(oneBy(tree, 'data-region', 'history').props['data-history-state'], 'error');
  assert.equal(oneBy(tree, 'data-region', 'transfer').props['data-transfer-phase'], 'error');
  assert.ok(hasText(tree, page.zh.errNetwork));
});

// #endregion

test('client: the packaged file list still excludes the tests', () => {
  assert.ok(packageJson.files.includes('client.js'));
  assert.ok(!packageJson.files.includes('test'));
});

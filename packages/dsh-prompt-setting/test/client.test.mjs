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
// The *host* copy of the reserved section name (CONTRACT.md §15.1). The client
// hardcodes the same literal because a browser module cannot import host code;
// the tests below compare the two, character for character, so the two copies
// cannot drift apart silently (g-015, requirement: 两侧常量不许漂移).
import { CUSTOM_SECTION_NAME } from '../core/custom.js';

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
  // Revision 7 write face (CONTRACT.md §15.5–§15.7).
  'write-locked',
  'unsupported-action',
  'conflicting-query',
  // Revision 9 switch (CONTRACT.md §16.4).
  'invalid-interpolate-flag',
  'unresolvable-variable',
  'invalid-enabled',
  'variable-lookup-failed',
  // Revision 12 three-state spelling (CONTRACT.md §16.8).
  'invalid-state',
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
    useRef(initial) {
      const index = cursor++;
      if (!(index in cells)) cells[index] = { current: initial };
      return cells[index];
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

/**
 * Resolve a key against the registered dictionaries (identity when missing).
 * @param dictionaries - every registered `{ns, dict}` record.
 * @param ns - the namespace to resolve in.
 * @param key - dictionary key.
 * @param language - `'zh'` (default, unchanged) or `'en'`. The default keeps
 *   every pre-existing test on the zh dictionary, bit for bit.
 * @returns the localized text, or the key itself when the table has no entry.
 */
function dict(dictionaries, ns, key, language = 'zh') {
  const entry = dictionaries.find((item) => item.ns === ns);
  const table = entry && entry.dict ? entry.dict[language] : undefined;
  return table && table[key] !== undefined ? table[key] : key;
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

/** The four first-level tabs, in render order, as their `data-tab-value`s. */
function mainTabs(tree) {
  return collect(tree, (node) => node.type === 'button' && node.props['data-tab-key'] === 'main').map(
    (node) => node.props['data-tab-value'],
  );
}

/** The one first-level tab list element (the container carrying `data-region`). */
function tabList(tree) {
  return oneBy(tree, 'data-region', 'tabs');
}

/** The single rendered tab panel: a page renders exactly one at a time. */
function tabPanel(tree) {
  return oneBy(tree, 'data-region', 'tab-panel');
}

/**
 * Open one first-level tab. Selection is by value alone so this works in both
 * renderer branches (the official `SegmentedTabs` double labels its own group
 * `primitives`): the four values `mine` / `overview` / `history` / `advanced`
 * occur on exactly one control each.
 */
async function openTab(page, value, from) {
  const tree = from === undefined ? await page.flush() : from;
  clickAnyTab(tree, value);
  return page.flush();
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

/** Every section row's 「编辑」 switch, as `[section name, aria-expanded]` pairs. */
function editSwitches(tree) {
  return collect(
    tree,
    (node) => node.type === 'button' && node.props['data-action'] === 'edit',
  ).map((node) => [node.props['data-section-name'], node.props['aria-expanded']]);
}

/** Every write the page attempted (PUT / DELETE), whatever the outcome. */
function writeCalls(page) {
  return page.router.calls.filter((call) => call.init && (call.init.method === 'PUT' || call.init.method === 'DELETE'));
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
 * @param options - `responses`, `useSessions`, `useWorkspaces`, `primitives`,
 *   `localeShape`, `t`, `language` (`'zh'` default, `'en'` to bind the en
 *   dictionary). Passing an explicit `t` still wins.
 * @returns the page harness (`zh` is the registered zh table, `text` the table
 *   of the language actually bound).
 */
function makePage(options = {}) {
  const loaded = loadClient(options.primitives || 'throw');
  const mounted = mountClient(loaded.module, options.localeShape || 'full');
  const router = makeRouter(options.responses || {});
  loaded.sandbox.fetch = router.fetchStub;
  const language = options.language === undefined ? 'zh' : options.language;
  const props = {
    t: options.t || ((key) => dict(mounted.dictionaries, NS, key, language)),
    ...mounted.registrations[0].options.inject(),
  };
  if (options.useSessions !== undefined) props.useSessions = options.useSessions;
  if (options.useWorkspaces !== undefined) props.useWorkspaces = options.useWorkspaces;
  const component = mounted.registrations[0].component;
  const draw = () => expandTree(loaded.runtime.render(component, props).tree);
  const scopeToggleOf = (tree) =>
    collect(
      tree,
      (node) => node.type === 'button' && node.props && node.props['data-action'] === 'scope-toggle',
    );
  const flush = async () => {
    const pending = loaded.runtime.render(component, props).pending;
    for (const effect of pending) effect();
    await settle();
    let tree = draw();
    // g-016: the「查看范围」picker ships collapsed. A case that asserts its
    // internals (search / tree / paging / pinned / keyboard) opts into
    // `scopeOpen: true` and gets the same click a user makes —「更改」— before
    // every read. Selection shuts the picker again, so the click is repeated
    // per flush instead of being done once at mount; the assertions below are
    // unchanged, only the way in is.
    if (options.scopeOpen === true) {
      const toggle = scopeToggleOf(tree);
      if (toggle.length === 1 && toggle[0].props['aria-expanded'] === false) {
        toggle[0].props.onClick();
        tree = draw();
      }
    }
    return tree;
  };
  const tables = mounted.dictionaries.length > 0 ? mounted.dictionaries[0].dict : {};
  const zh = tables.zh || {};
  return { loaded, mounted, router, props, draw, flush, zh, language, text: tables[language] || {} };
}

/**
 * `makePage` with the「查看范围」picker already open.
 *
 * This is the g-016 compatibility door for the cases that existed before the
 * picker collapsed: they assert the search box, the ARIA tree, paging, the
 * pinned entries and the degraded paths, and they keep asserting exactly that —
 * they just click「更改」first. `NOTES.md` §94 maps every case. New cases that
 * assert the collapsed default use `makePage` directly.
 * @param options - the same options as {@link makePage}.
 * @returns the page harness.
 */
function makeOpenPage(options = {}) {
  return makePage({ ...options, scopeOpen: true });
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
      // Revision 9: the switch, as the host reports it. The fixture default is
      // the shipped default — OFF, with neither layer stating anything.
      interpolate: { effective: false, user: null, workspace: null },
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
  interpolate: '/prompt-setting/interpolate',
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
    [PATHS.interpolate]: {
      payload: { ok: true, interpolateCustom: true, layer: 'user', saved: { enabled: true }, effectiveFrom: 'next-turn' },
    },
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
  // The failure reason is diagnostics: 「高级」 carries it (g-015 moved the
  // renderer self-check there), so it is not lost — it is just not permanent
  // chrome on a page whose subject is the user's prompt.
  const advanced = await openAdvanced(page);
  assert.ok(hasText(advanced, 'Cannot find module'), 'reason rendered');
  assert.equal(oneBy(advanced, 'data-primitives-failure', 'true').props['data-primitives-failure'], 'true');
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

// #region build stamp —「这一页跑的是哪个 bundle」(Revision 6)

/**
 * Independent recomputation of the build digest, straight from CONTRACT.md §14:
 * one ordered marker pair, BOM/CRLF normalized away, FNV-1a 32 over UTF-16 code
 * units. Written here rather than imported, so it can disagree with the page.
 * @param text - the bundle (or live factory) text.
 * @returns `{hash, size}` or `null`.
 */
function independentBuildFingerprint(text) {
  let value = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  value = value.replace(/\r\n?/g, '\n');
  const begin = '/* @build-fingerprint:begin */';
  const end = '/* @build-fingerprint:end */';
  const from = value.indexOf(begin);
  const to = value.indexOf(end);
  if (from === -1 || to === -1 || from >= to) return null;
  const region = value.slice(from + begin.length, to);
  let hash = 0x811c9dc5;
  for (let index = 0; index < region.length; index += 1) {
    hash = Math.imul(hash ^ region.charCodeAt(index), 0x01000193) >>> 0;
  }
  return { hash: hash.toString(16).padStart(8, '0'), size: region.length };
}

/** The ping body a host serving `clientBuild` answers with. */
function pingResponse(clientBuild) {
  return {
    payload: {
      ok: true,
      plugin: 'dsh-prompt-setting',
      version: '0.1.0',
      time: '2024-01-01T00:00:00.000Z',
      clientRenderer: 'fallback',
      clientReportedAt: null,
      clientBuild,
    },
  };
}

/** A `clientBuild` object as the host sends it. */
function buildFixture(hash, size = 240949) {
  return { hash, size, mtime: '2024-01-01T00:00:00.000Z' };
}

/** Every stale-build warning on screen. */
function staleWarnings(tree) {
  return collect(tree, (node) => node.props && node.props['data-warning'] === 'client-build-stale');
}

test('client: the running page self-fingerprints exactly as an independent read of the file does', async () => {
  const page = makePage({ responses: defaultResponses({ [PATHS.ping]: pingResponse(null) }) });
  const tree = await page.flush();

  // Three sources, one digest: the page's own `factory.toString()` digest, an
  // independent recomputation of that *same live function*, and an independent
  // recomputation of the file on disk this vm was handed.
  const live = independentBuildFingerprint(page.loaded.descriptor.factory.toString());
  const onDisk = independentBuildFingerprint(clientSource);
  assert.notEqual(live, null, 'the running factory carries a usable marker region');
  assert.equal(markerOf(tree, 'data-build'), live.hash, 'the page reports the digest it computed itself');
  assert.equal(live.hash, onDisk.hash, 'the live function and the published file agree bit for bit');
  assert.equal(live.size, onDisk.size);
  assert.equal(page.loaded.module.SELF_BUILD, undefined, 'nothing new is exported from the module surface');
});

test('client: an equal host digest is the only way to read "matches"', async () => {
  const oracle = independentBuildFingerprint(clientSource);
  const page = makePage({
    responses: defaultResponses({ [PATHS.ping]: pingResponse(buildFixture(oracle.hash, oracle.size)) }),
  });
  const tree = await page.flush();
  assert.equal(markerOf(tree, 'data-build'), oracle.hash);
  assert.equal(markerOf(tree, 'data-build-server'), oracle.hash);
  assert.equal(markerOf(tree, 'data-build-match'), 'true');
  assert.equal(staleWarnings(tree).length, 0);
  assert.ok(hasText(tree, page.zh.stBuildSame), 'the zh copy states the match');
});

test('client: one character changed inside the region is the only source of a stale verdict', async () => {
  const oracle = independentBuildFingerprint(clientSource);
  // A *real* one-character edit inside the region: the smallest possible
  // "different build". If the digest ignored content, this hash would equal the
  // oracle's and the stale verdict below could never fire.
  const at = clientSource.indexOf('/* @build-fingerprint:begin */') + 40;
  const editedSource = `${clientSource.slice(0, at)}${clientSource[at] === 'x' ? 'y' : 'x'}${clientSource.slice(at + 1)}`;
  const edited = independentBuildFingerprint(editedSource);
  assert.notEqual(edited.hash, oracle.hash, 'one character inside the region must move the digest');
  assert.equal(edited.size, oracle.size, 'the edit is length-preserving');

  const page = makePage({
    responses: defaultResponses({ [PATHS.ping]: pingResponse(buildFixture(edited.hash, edited.size)) }),
  });
  const tree = await page.flush();
  assert.equal(markerOf(tree, 'data-build'), oracle.hash, 'the page still reports its own digest');
  assert.equal(markerOf(tree, 'data-build-server'), edited.hash);
  assert.equal(markerOf(tree, 'data-build-match'), 'false');
  // The one-line summary at the top carries the verdict...
  assert.equal(oneBy(tree, 'data-region', 'status').props['data-status-build'], 'false');
  assert.ok(hasText(tree, page.zh.stBuildStale), 'the tag itself says stale');
  // ...and 「高级」 carries the explanation, exactly once.
  const advanced = await openAdvanced(page);
  const warning = staleWarnings(advanced);
  assert.equal(warning.length, 1, 'exactly one stale warning');
  assert.ok(hasText(advanced, page.zh.stBuildStaleHint), 'the stale warning explains what to do');
});

test('client: no clientBuild, or a failed ping, is "unknown" and never "stale"', async () => {
  // (a) an older host that answers the ping without the field at all;
  const older = makePage({
    responses: defaultResponses({
      [PATHS.ping]: { payload: { ok: true, plugin: 'dsh-prompt-setting', version: '0.0.1' } },
    }),
  });
  const olderTree = await older.flush();
  assert.equal(markerOf(olderTree, 'data-build-match'), 'unknown');
  assert.equal(markerOf(olderTree, 'data-build-server'), 'unknown');
  assert.equal(staleWarnings(olderTree).length, 0, 'a missing answer must never be read as stale');
  assert.ok(hasText(await openAdvanced(older), older.zh.stBuildUnknownHint));

  // (b) an explicitly unreadable bundle on the host side (`clientBuild: null`);
  const unreadable = makePage({ responses: defaultResponses({ [PATHS.ping]: pingResponse(null) }) });
  const unreadableTree = await unreadable.flush();
  assert.equal(markerOf(unreadableTree, 'data-build-match'), 'unknown');
  assert.equal(staleWarnings(unreadableTree).length, 0);

  // (c) a ping that never arrived.
  const failed = makePage({
    responses: defaultResponses({ [PATHS.ping]: new Error('Failed to fetch') }),
  });
  const failedTree = await failed.flush();
  assert.equal(markerOf(failedTree, 'data-build-match'), 'unknown');
  assert.equal(staleWarnings(failedTree).length, 0);
  assert.ok(
    hasText(await openAdvanced(failed), failed.zh.stBuildPingFailedHint),
    'the failed probe is named as such',
  );
  // The page's own identity survives every one of these: only the comparison is
  // unknown, not the digest of what is running.
  assert.equal(markerOf(olderTree, 'data-build'), independentBuildFingerprint(clientSource).hash);
  assert.equal(markerOf(failedTree, 'data-build'), independentBuildFingerprint(clientSource).hash);
});

// #endregion

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
  const tree = await openOverview(page);
  assert.equal(markerOf(tree, 'data-phase'), 'empty');
  assert.equal(oneBy(tree, 'data-empty', 'sections').props['data-empty'], 'sections');
  assert.equal(oneBy(tree, 'data-sections-total', '0').props['data-sections-total'], '0');
  assert.ok(strings(tree).includes(page.zh.emptyTitle));
  assert.ok(strings(tree).includes(page.zh.emptyBody));
});

// #endregion

// #region session selector (props `useSessions` root hook, with a degradation)

test('client: the session selector defaults to the current view session', async () => {
  const page = makeOpenPage({ useSessions: sessionsHook(SESSIONS_STATE), responses: defaultResponses() });
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
  const page = makeOpenPage({ useSessions: sessionsHook(SESSIONS_STATE), responses: defaultResponses() });
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
  const page = makeOpenPage({ responses: defaultResponses() });
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
  const page = makeOpenPage({
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
    const page = makeOpenPage({ useSessions: sessionsHook(state), responses: defaultResponses() });
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
  const page = makeOpenPage({ useSessions: sessionsHook(FILTER_SESSIONS), responses: defaultResponses() });
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
  const page = makeOpenPage({ useSessions: sessionsHook(FILTER_SESSIONS), responses: defaultResponses() });
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
  const page = makeOpenPage({ useSessions: sessionsHook(FILTER_SESSIONS), responses: defaultResponses() });
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
  const page = makeOpenPage({ useSessions: sessionsHook(FILTER_SESSIONS), responses: defaultResponses() });
  let tree = await page.flush();
  const target = sessionOptions(tree).find((option) => option.props['data-session-id'] === 's1');
  target.props.onClick();
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-session'), 's1');
  assert.equal(oneBy(tree, 'data-role', 'session-search').props.value, 'Alpha One');
  assert.ok(hasText(oneBy(tree, 'data-role', 'session-current'), 'Alpha One'));
});

test('client: the session list is keyboard reachable', async () => {
  const page = makeOpenPage({ useSessions: sessionsHook(FILTER_SESSIONS), responses: defaultResponses() });
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

// #region g-016 · the「查看范围」picker ships collapsed (one summary +「更改」)

/** The「更改」switch: one button, whose `aria-expanded` reports the picker. */
function scopeToggle(tree) {
  return oneBy(tree, 'data-action', 'scope-toggle');
}

/** The always-visible summary row of the「查看范围」card. */
function scopeSummary(tree) {
  return oneBy(tree, 'data-region', 'scope-summary');
}

/** Every host node in a rendered tree: a cheap "how much is on screen" count. */
function renderedNodeCount(tree) {
  return collect(tree, (node) => node.type !== undefined).length;
}

/**
 * One text line of slack in the collapsed summary row, in px: the row's own
 * font is 13–15px, so a 22px line covers the tallest atom it can hold without
 * wrapping.
 */
const SCOPE_SUMMARY_LINE_PX = 22;

/**
 * The offline height budget of the collapsed「查看范围」card, in px: the card's
 * own vertical padding, the summary row's declared minimum height, and one line
 * of slack. The real geometry is measured in the settings shell by the
 * supervisor after this is merged (NOTES §94) — this budget is what keeps
 * criterion 4 assertable offline, and it can only stay green while the
 * collapsed tree really is one row, because the structural half of the same
 * test fails the moment a body node is rendered beside the summary.
 * @param tree - a rendered page tree.
 * @returns the budgeted height in px.
 */
function collapsedScopeHeight(tree) {
  const section = oneBy(tree, 'data-region', 'session');
  const row = scopeSummary(tree);
  const parts = String(section.props.style.padding)
    .split(' ')
    .map((part) => Number.parseFloat(part));
  const vertical = parts.length > 1 ? parts[0] * 2 : parts[0];
  const minHeight = Number.parseFloat(String(row.props.style.minHeight));
  return vertical + minHeight + SCOPE_SUMMARY_LINE_PX;
}

test('client: the「查看范围」picker ships collapsed, with no body on screen', async () => {
  const page = makePage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  const tree = await page.flush();

  assert.equal(markerOf(tree, 'data-scope-open'), 'false', 'the default state is shut');
  const summary = scopeSummary(tree);
  assert.ok(hasText(summary, page.zh.sessionHeading), 'the block is still labelled');
  assert.ok(
    hasText(summary, fillText(page.zh.sessionCurrentLabel, { label: 'Alpha three' })),
    'and it names the scope the snapshot is taken in',
  );
  assert.ok(hasText(scopeToggle(tree), page.zh.scopeEdit), 'with one「更改」switch');
  assert.equal(scopeToggle(tree).props['aria-expanded'], false);

  // Every node of the picker body is *absent*, not merely hidden.
  for (const [attribute, value] of [
    ['data-region', 'session-tree'],
    ['data-region', 'session-list'],
    ['data-region', 'session-pinned'],
    ['data-role', 'session-search'],
    ['data-role', 'scope-search-hint'],
    ['data-role', 'session-current'],
    ['data-role', 'group-toggle'],
  ]) {
    assert.equal(
      collect(tree, (node) => node.props && node.props[attribute] === value).length,
      0,
      `${attribute}=${value} must not be rendered while collapsed`,
    );
  }
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-action'] === 'scope-more').length,
    0,
    'no「显示更多」outside the body',
  );
  // The four help lines the shell user had to scroll past are gone as copy too.
  for (const key of ['scopeSearchHint', 'sessionKeyboardHint', 'sessionSelectedNote', 'sessionGlobalNote']) {
    assert.ok(!hasText(tree, page.zh[key]), `${key} is not on screen while collapsed`);
  }

  // The degraded seat collapses the same way, and the summary carries the
  // *reason* instead of the long limitation paragraph.
  const manual = makePage({ responses: defaultResponses() });
  const manualTree = await manual.flush();
  assert.equal(markerOf(manualTree, 'data-scope-open'), 'false');
  assert.equal(oneBy(manualTree, 'data-role', 'scope-summary-hint').props.children, manual.zh.scopeSummaryManual);
  assert.ok(!hasText(manualTree, manual.zh.sessionLimit), 'the paragraph lives inside the picker');
  assert.ok(
    hasText(scopeSummary(manualTree), manual.zh.sessionGlobal),
    'the degraded seat still names the scope it is reading (global, with no session service)',
  );

  // The flat (no useWorkspaces) seat says which degradation it is, in a word.
  const flat = makePage({ useSessions: sessionsHook(SESSIONS_STATE), responses: defaultResponses() });
  const flatTree = await flat.flush();
  assert.equal(oneBy(flatTree, 'data-role', 'scope-summary-hint').props.children, flat.zh.scopeSummaryFlat);
});

test('client: 「更改」 is one switch that reports aria-expanded and brings the picker back', async () => {
  const page = makePage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  let tree = await page.flush();

  scopeToggle(tree).props.onClick();
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-scope-open'), 'true');
  assert.equal(scopeToggle(tree).props['aria-expanded'], true);
  assert.equal(scopeToggle(tree).props['data-expanded'], 'true', 'the attribute and the ARIA state agree');
  assert.ok(hasText(scopeToggle(tree), page.zh.scopeCollapse), 'the same button now says how to shut it');
  assert.ok(oneBy(tree, 'data-region', 'session-tree'), 'the existing tree is what comes back');
  assert.ok(oneBy(tree, 'data-role', 'session-search'));
  assert.ok(oneBy(tree, 'data-region', 'session-pinned'));
  assert.ok(collect(tree, (node) => node.props && node.props['data-role'] === 'group-toggle').length > 0);
  assert.ok(hasText(tree, page.zh.scopeSearchHint));

  // The same button shuts it: one control, two states.
  scopeToggle(tree).props.onClick();
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-scope-open'), 'false');
  assert.equal(scopeToggle(tree).props['aria-expanded'], false);
  assert.ok(hasText(scopeToggle(tree), page.zh.scopeEdit));
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'session-tree').length, 0);
});

test('client: the summary names the scope, and the range decides the label', async () => {
  const page = makePage({ useSessions: sessionsHook(SESSIONS_STATE), responses: defaultResponses() });
  let tree = await page.flush();

  // The current view session, in the readable-title form the page uses.
  assert.equal(markerOf(tree, 'data-scope-open'), 'false');
  assert.ok(hasText(scopeSummary(tree), fillText(page.zh.sessionCurrentLabel, { label: 'Second' })));
  assert.equal(oneBy(tree, 'data-role', 'scope-summary-hint').props.children, page.zh.scopeSummaryFlat);

  // 「全局」 names itself rather than naming a session.
  scopeToggle(tree).props.onClick();
  tree = await page.flush();
  clickButton(tree, { 'data-action': 'session-pinned', 'data-pinned': 'global' });
  tree = await page.flush();
  const summary = scopeSummary(tree);
  assert.ok(hasText(summary, page.zh.sessionGlobal), 'the global scope is named as such');
  assert.ok(
    !hasText(summary, fillText(page.zh.sessionCurrentLabel, { label: 'Second' })),
    'the previous scope is no longer claimed',
  );
  assert.equal(markerOf(tree, 'data-session'), 'global');
});

test('client: choosing a scope shuts the picker, and the summary follows it', async () => {
  const page = makePage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  let tree = await page.flush();
  assert.equal(markerOf(tree, 'data-scope-open'), 'false');

  // A row click: the picker closes itself, no second click anywhere.
  scopeToggle(tree).props.onClick();
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-scope-open'), 'true');
  sessionOptions(tree).find((row) => row.props['data-session-id'] === 'a1').props.onClick();
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-scope-open'), 'false', 'one click on a row also closes the picker');
  assert.equal(markerOf(tree, 'data-session'), 'a1');
  assert.ok(hasText(scopeSummary(tree), fillText(page.zh.sessionCurrentLabel, { label: 'Alpha one' })));
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'session-tree').length, 0);

  // The pinned「全局」entry does the same.
  scopeToggle(tree).props.onClick();
  tree = await page.flush();
  clickButton(tree, { 'data-action': 'session-pinned', 'data-pinned': 'global' });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-scope-open'), 'false');
  assert.ok(hasText(scopeSummary(tree), page.zh.sessionGlobal));

  // The keyboard path: Enter on the highlighted row selects *and* closes.
  scopeToggle(tree).props.onClick();
  tree = await page.flush();
  oneBy(tree, 'data-role', 'session-search').props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  tree = await page.flush();
  oneBy(tree, 'data-role', 'session-search').props.onKeyDown({ key: 'Enter', preventDefault() {} });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-scope-open'), 'false', 'Enter selects and closes');
  assert.equal(markerOf(tree, 'data-session'), 'a2');
  assert.ok(hasText(scopeSummary(tree), fillText(page.zh.sessionCurrentLabel, { label: 'Alpha two' })));

  // Typing an id that matches nothing is a scope choice too.
  scopeToggle(tree).props.onClick();
  tree = await page.flush();
  typeInto(tree, 'session-search', 'pasted-id-42');
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-scope-open'), 'true', 'typing does not close the picker by itself');
  clickButton(tree, { 'data-action': 'session-use-input' });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-scope-open'), 'false');
  assert.equal(markerOf(tree, 'data-session'), 'pasted-id-42');
  assert.ok(hasText(scopeSummary(tree), fillText(page.zh.sessionCurrentLabel, { label: 'pasted-id-42' })));
});

test('client: the collapsed「查看范围」block is one row inside an 80px budget', async () => {
  const page = makePage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  let tree = await page.flush();

  const section = oneBy(tree, 'data-region', 'session');
  const rows = elementChildren(section);
  assert.equal(rows.length, 1, 'collapsed: exactly one row, nothing rendered beside it');
  assert.equal(rows[0].props['data-region'], 'scope-summary', 'and that row is the summary');
  const row = scopeSummary(tree);
  const atoms = elementChildren(row);
  assert.ok(atoms.length <= 4, `heading + label + at most one hint + one switch (got ${atoms.length})`);
  assert.equal(atoms.filter((node) => node.type === 'button').length, 1, 'exactly one control in the row');
  assert.equal(collect(row, (node) => node.type === 'p').length, 0, 'no paragraph can add a second line');

  const collapsedNodes = renderedNodeCount(tree);
  const budget = collapsedScopeHeight(tree);
  scopeToggle(tree).props.onClick();
  tree = await page.flush();
  const expandedNodes = renderedNodeCount(tree);
  assert.ok(elementChildren(oneBy(tree, 'data-region', 'session')).length > 1, 'expanded, the body is a sibling');
  assert.ok(oneBy(tree, 'data-region', 'session-tree'), 'and the tree is the bulk of it');
  // The measurement is part of the evidence, not decoration (NOTES §94).
  console.log(
    `    scope geometry: collapsed「查看范围」= ${budget}px budget (80px), ${collapsedNodes} nodes; expanded = ${expandedNodes} nodes`,
  );
  assert.ok(budget <= 80, `the collapsed block budgets ${budget}px, over the 80px ceiling`);
  assert.ok(expandedNodes > collapsedNodes * 2, `opening the picker adds the body back (${expandedNodes} vs ${collapsedNodes})`);
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
  const page = makeOpenPage({
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
  const page = makeOpenPage({
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
  const page = makeOpenPage({
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
  const big = makeOpenPage({
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
    const page = makeOpenPage({
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
  const flat = makeOpenPage({
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
  const thrown = makeOpenPage({
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
  const empty = makeOpenPage({
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
  const page = makeOpenPage({
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
  const inline = makeOpenPage({
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
  const prim = makeOpenPage({
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
  const page = makeOpenPage({
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
  const flat = makeOpenPage({ useSessions: sessionsHook(SESSIONS_STATE), responses: defaultResponses() });
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

// #region g-009 · the「查看范围」tree is a real ARIA tree (tree > treeitem + group > treeitem)

/** Element children of a rendered node (nulls React skips are dropped). */
function elementChildren(node) {
  const kids = node && node.props ? node.props.children : null;
  const list = Array.isArray(kids) ? kids : kids === null || kids === undefined ? [] : [kids];
  // Built here, not with `.filter`, so the result is this realm's array: the
  // rendered tree lives in the vm context and its arrays are not assert-equal.
  const out = [];
  for (const child of list) {
    if (child !== null && typeof child === 'object' && child.type !== undefined) out.push(child);
  }
  return out;
}

/**
 * Walk a rendered ARIA tree and return one record per `treeitem`, with the
 * chain of *container* roles above it (`'group'`, a bare host tag, or
 * `'treeitem'` when items are nested in items). The chain is what makes the
 * nesting machine-checkable: a level-1 item must sit directly under the `tree`,
 * a level-2 item under `tree > group`, and a bare `div` wrapper in between
 * shows up in the chain instead of hiding.
 */
function ariaTreeItems(root) {
  const items = [];
  const visit = (node, chain) => {
    for (const child of elementChildren(node)) {
      const role = child.props.role;
      if (role === 'treeitem') items.push({ node: child, chain });
      visit(child, chain.concat([role === 'group' || role === 'treeitem' ? role : String(child.type)]));
    }
  };
  visit(root, []);
  return items;
}

/**
 * Assert the whole ARIA shape of one rendered scope tree: named container,
 * only `treeitem`/`group` as direct children, no anonymous group, every
 * workspace node level 1 with `aria-expanded`, every session level 2 with
 * `aria-selected`, and each one nested exactly as its level claims.
 * @returns the tree's direct children, for the caller's own assertions.
 */
function assertAriaTreeShape(root) {
  assert.equal(root.props.role, 'tree', 'the container is a tree');
  assert.ok(String(root.props['aria-label'] || '').length > 0, 'the tree has an accessible name');
  const top = elementChildren(root);
  assert.ok(top.length > 0, 'the tree is not empty');
  for (const child of top) {
    assert.ok(
      child.props.role === 'treeitem' || child.props.role === 'group',
      `a tree holds only treeitem/group, found <${child.type} role=${child.props.role}>`,
    );
  }
  for (let i = 0; i < top.length; i += 1) {
    if (top[i].props.role !== 'group') continue;
    assert.ok(String(top[i].props['aria-label'] || '').length > 0, 'no anonymous group');
    assert.equal(top[i - 1].props.role, 'treeitem', 'a group follows the workspace node it belongs to');
    assert.notEqual(top[i - 1].props['data-scope-group'], undefined, 'and that node is the workspace header');
  }
  const items = ariaTreeItems(root);
  assert.ok(items.length > 0, 'the tree has items');
  // The role set, read off the page's own markers: a node a test or a script
  // can select is a treeitem, and nothing else may be one.
  const headers = collect(root, (node) => node.props && node.props['data-scope-group'] !== undefined);
  const rows = collect(root, (node) => node.props && node.props['data-role'] === 'session-row');
  for (const header of headers) {
    assert.equal(header.props.role, 'treeitem', 'every workspace node is a treeitem');
    assert.equal(header.props['aria-level'], 1, 'a workspace node is level 1');
    assert.equal(typeof header.props['aria-expanded'], 'boolean', 'and states whether it is open');
  }
  for (const row of rows) {
    assert.equal(row.props.role, 'treeitem', 'every session row is a treeitem');
    assert.equal(row.props['aria-level'], 2, 'a session inside a workspace is level 2');
    assert.equal(typeof row.props['aria-selected'], 'boolean', 'and carries the selection state');
  }
  assert.equal(items.length, headers.length + rows.length, 'and there is no other treeitem');
  for (const { node, chain } of items) {
    if (node.props['data-scope-group'] !== undefined) {
      assert.deepEqual(chain, [], 'a workspace node is a direct child of the tree');
    } else {
      assert.notEqual(node.props['data-session-id'], undefined, 'every other treeitem is a session row');
      assert.deepEqual(chain, ['group'], 'a session sits in its workspace group, nothing between');
    }
  }
  return top;
}

/** The `role="tree"` container of the scope picker (exactly one). */
function scopeTreeRoot(tree) {
  return oneBy(tree, 'data-region', 'session-tree');
}

test('client: the「查看范围」tree is a standard ARIA tree (tree > treeitem + group > treeitem)', async () => {
  const page = makeOpenPage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  const tree = await page.flush();
  const root = scopeTreeRoot(tree);

  const top = assertAriaTreeShape(root);
  // The default state: only the workspace holding the current session is open,
  // and an open workspace is exactly the one followed by its group.
  assert.deepEqual(
    top.map((child) => [child.props.role, child.props['data-scope-group'] ?? child.props['aria-label']]),
    [
      ['treeitem', 'w-alpha'],
      ['group', 'Alpha repo'],
      ['treeitem', 'w-beta'],
      ['treeitem', ''],
    ],
  );
  assert.deepEqual(
    top.filter((child) => child.props.role === 'treeitem').map((child) => child.props['aria-expanded']),
    [true, false, false],
    'a workspace is open iff its group is rendered',
  );

  // The session rows of the one open group: level 2, recency order, and the
  // retained session is the single selected item.
  const rows = ariaTreeItems(root).filter((item) => item.node.props['data-session-id'] !== undefined);
  assert.deepEqual(rows.map((item) => item.node.props['data-session-id']), ['a2', 'a1', 'a3']);
  assert.ok(rows.every((item) => item.node.props['aria-level'] === 2));
  assert.deepEqual(
    rows.filter((item) => item.node.props['aria-selected'] === true).map((item) => item.node.props['data-session-id']),
    ['a3'],
  );

  // Zero-visual-change guard for the header/first-row distance: the tree's own
  // gap is untouched, and the group cancels it (2px − 1px = the old 1px gap of
  // the wrapper this replaces).
  assert.equal(root.props.style.gap, 2);
  const group = top.find((child) => child.props.role === 'group');
  assert.equal(group.props.style.gap, 1, 'rows keep the 1px spacing they had inside the wrapper');
  assert.equal(group.props.style.marginTop, -1, 'and the group cancels the tree gap it now sits in');
});

test('client: opening and shutting a workspace adds and removes its group, never an empty one', async () => {
  const page = makeOpenPage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  let tree = await page.flush();
  assert.equal(
    ariaTreeItems(scopeTreeRoot(tree)).filter((item) => item.node.props['data-scope-parent'] === 'w-beta').length,
    0,
    'a shut workspace renders no rows at all',
  );

  pressKey(scopeHeader(tree, 'w-beta'), 'Enter');
  tree = await page.flush();
  const opened = assertAriaTreeShape(scopeTreeRoot(tree));
  assert.deepEqual(opened.map((child) => child.props.role), ['treeitem', 'group', 'treeitem', 'group', 'treeitem']);
  const beta = opened[2];
  assert.equal(beta.props['data-scope-group'], 'w-beta');
  assert.equal(beta.props['aria-expanded'], true);
  assert.equal(opened[3].props['aria-label'], 'beta-dir', 'the new group is named after its workspace');
  const betaRows = ariaTreeItems(opened[3]);
  assert.ok(betaRows.length > 0);
  assert.ok(betaRows.every((item) => item.node.props['aria-level'] === 2));
  assert.ok(betaRows.every((item) => item.node.props['data-scope-parent'] === 'w-beta'));

  pressKey(scopeHeader(tree, 'w-beta'), ' ');
  tree = await page.flush();
  const shut = assertAriaTreeShape(scopeTreeRoot(tree));
  assert.deepEqual(
    shut.filter((child) => child.props.role === 'group').map((child) => child.props['aria-label']),
    ['Alpha repo'],
    'the shut workspace leaves no group behind',
  );
  assert.equal(
    ariaTreeItems(scopeTreeRoot(tree)).filter((item) => item.node.props['data-scope-parent'] === 'w-beta').length,
    0,
  );
});

test('client: a search keeps the tree shape, including the ungrouped bucket', async () => {
  const page = makeOpenPage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  let tree = await page.flush();

  typeInto(tree, 'session-search', 'Beta');
  tree = await page.flush();
  const filtered = assertAriaTreeShape(scopeTreeRoot(tree));
  assert.deepEqual(filtered.map((child) => child.props.role), ['treeitem', 'group']);
  assert.equal(filtered[1].props['aria-label'], 'beta-dir');
  const visibleRows = sessionOptions(tree).map((row) => row.props['data-session-id']);
  assert.deepEqual(
    ariaTreeItems(scopeTreeRoot(tree))
      .filter((item) => item.node.props['data-session-id'] !== undefined)
      .map((item) => item.node.props['data-session-id']),
    visibleRows,
    'the traversal and the marker-reading helper agree on every rendered row',
  );

  typeInto(tree, 'session-search', 'Loose');
  tree = await page.flush();
  const loose = assertAriaTreeShape(scopeTreeRoot(tree));
  assert.equal(loose[0].props['data-scope-group'], '', 'the ungrouped bucket is a workspace node too');
  assert.equal(loose[1].props['aria-label'], page.zh.scopeUngrouped, 'and its group is named, not anonymous');
  assert.deepEqual(
    ariaTreeItems(loose[1]).map((item) => item.node.props['data-session-id']),
    ['loose'],
  );
});

test('client: with no workspaces every session stays level 2 inside the named bucket', async () => {
  const page = makeOpenPage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture({ items: [], archivedSessionIds: [], pinnedSessionIds: [] })),
    responses: defaultResponses(),
  });
  const tree = await page.flush();
  const root = scopeTreeRoot(tree);
  const top = assertAriaTreeShape(root);
  assert.deepEqual(top.map((child) => child.props.role), ['treeitem', 'group']);
  assert.equal(top[0].props['data-scope-group'], '');
  assert.equal(top[0].props['aria-expanded'], true);
  assert.equal(top[1].props['aria-label'], page.zh.scopeUngrouped);
  const rows = ariaTreeItems(root).filter((item) => item.node.props['data-session-id'] !== undefined);
  assert.equal(rows.length, 6, 'every visible session is a treeitem');
  assert.ok(rows.every((item) => item.node.props['aria-level'] === 2 && item.chain.join('/') === 'group'));
});

test('client: the「显示更多」action is a child of its group, never a tree child', async () => {
  const { sessions, workspaces } = manyWorkspaceSessions(1, 20);
  const page = makeOpenPage({
    useSessions: sessionsHook(sessions),
    useWorkspaces: workspacesHook(workspaces),
    responses: defaultResponses(),
  });
  const tree = await page.flush();
  const root = scopeTreeRoot(tree);
  const top = assertAriaTreeShape(root);
  assert.deepEqual(top.map((child) => child.props.role), ['treeitem', 'group']);
  const more = findOne(top[1], (node) => node.props && node.props['data-action'] === 'scope-more', 'the more button');
  assert.equal(more.props.role, undefined, 'an action row is not a tree node');
  assert.equal(
    elementChildren(root).filter((child) => child.props['data-action'] === 'scope-more').length,
    0,
    'and it is not a direct child of the tree either',
  );
  const rows = ariaTreeItems(top[1]);
  assert.equal(rows.length, SCOPE_GROUP_PAGE, 'the page of rows is level 2, the action is not a treeitem');
});

test('client: the flat fallback declares a listbox instead of faking a tree', async () => {
  const page = makeOpenPage({
    useSessions: sessionsHook(manySessions(200)),
    responses: defaultResponses(),
  });
  const tree = await page.flush();
  assert.equal(collect(tree, (node) => node.props && node.props.role === 'tree').length, 0);
  assert.equal(collect(tree, (node) => node.props && node.props.role === 'treeitem').length, 0);
  assert.equal(collect(tree, (node) => node.props && node.props.role === 'group').length, 0);
  const list = oneBy(tree, 'data-region', 'session-list');
  assert.equal(list.props.role, 'listbox');
  assert.equal(list.props['aria-label'], page.zh.sessionHeading, 'the fallback list is named too');
  const options = elementChildren(list);
  assert.ok(options.length > 0);
  for (const option of options) {
    assert.equal(option.props.role, 'option');
    assert.equal(option.props['aria-level'], undefined, 'a flat list has no levels, and claims none');
  }
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
    // The top line states the verdict; 「高级」 carries the reason, and
    // 「我的 Prompt」 states the consequence on the surface it owns (§15.4: the
    // panel must say the text will not reach the prompt, not let the write look
    // effective).
    const advanced = await openAdvanced(page);
    const frozenWarnings = collect(advanced, (node) => node.props && node.props['data-warning'] === 'frozen');
    if (frozen) {
      assert.equal(frozenWarnings.length, 1, 'the frozen verdict is explained in 高级');
      assert.ok(hasText(frozenWarnings[0], 'the scope collapsed to its complete section'), 'the reason is shown');
    } else {
      assert.equal(frozenWarnings.length, 0, 'an unfrozen scope renders no frozen warning');
    }
    const mine = await openTab(page, 'mine');
    const mineWarnings = collect(mine, (node) => node.props && node.props['data-warning'] === 'mine-frozen');
    if (frozen) {
      assert.equal(mineWarnings.length, 1, '「我的 Prompt」 says the text will not take effect');
      assert.ok(hasText(mineWarnings[0], page.zh.mineFrozenWarn));
      assert.ok(hasText(mineWarnings[0], 'the scope collapsed to its complete section'), 'and gives the reason');
    } else {
      assert.equal(mineWarnings.length, 0, 'no warning when the scope is not frozen');
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
  // The unknown verdict explains itself in 「高级」, where the full status lives.
  const advanced = await openAdvanced(page);
  const warning = oneBy(advanced, 'data-warning', 'frozen-unknown');
  assert.ok(hasText(warning, 'has no active agent'), 'the frozenScopeReason is shown');
});

test('client: frozenScope "global" without a session describes the global assembly', async () => {
  const page = makePage({ responses: defaultResponses() });
  const tree = await page.flush();
  assert.equal(markerOf(tree, 'data-frozen-scope'), 'global');
  assert.equal(markerOf(tree, 'data-frozen-state'), 'unfrozen');
  assert.ok(strings(tree).includes(page.zh.stUnfrozenGlobal));
  assert.ok(!strings(tree).includes(page.zh.stFrozenUnknown));
});

test('client: a non-overridable section states its verdict and its reason', async () => {
  const payload = snapshotFixture();
  payload.effective.sections[0].overridable = false;
  payload.effective.sections[0].reason = 'this scope observed the change being reverted';
  const page = makePage({ responses: defaultResponses({ [PATHS.snapshot]: { payload } }) });
  const tree = await openOverview(page);
  const row = oneBy(tree, 'data-section-row', 'harness:identity');
  assert.equal(row.props['data-overridable'], 'false');
  assert.ok(
    hasText(oneBy(tree, 'data-section-reason', 'harness:identity'), 'observed the change being reverted'),
    'the reason original text is shown',
  );
  // The overview cannot write, so the gate is *stated* rather than enforced:
  // the same `editGate` verdict that used to disable the edit button is now a
  // read-only note on the row.
  const note = oneBy(tree, 'data-warning', 'edit-disabled');
  assert.ok(hasText(note, 'observed the change being reverted'), 'the gate repeats the reason');
  assert.equal(
    collect(tree, (node) => node.type === 'button' && node.props['data-action'] === 'edit').length,
    0,
    'and there is no edit entry to disable',
  );
});

// #endregion

// #region origin labelling, filters, diff and the unresolved warning

test('client: downstream-added is labelled as another plugin, not as an override', async () => {
  const page = makePage({ responses: defaultResponses() });
  const tree = await openOverview(page);
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
  let tree = await openOverview(page);
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
  let tree = await openOverview(page);
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
  let tree = await openOverview(page);
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
  let tree = await openOverview(page);
  clickTab(tree, 'view', 'full');
  tree = await page.flush();
  const warning = oneBy(tree, 'data-warning', 'rendered-unresolved');
  assert.equal(warning.props['data-unresolved-variables'], 'Upper,project:alpha');
  assert.ok(strings(tree).includes(page.zh.unresolvedTitle));
  assert.ok(hasText(tree, 'Upper, project:alpha'), 'the list is rendered');
  assert.ok(strings(tree).includes(page.zh.unresolvedNote));
  assert.equal(oneBy(tree, 'data-full-text', 'rendered').props['data-rendered-resolved'], 'false');
});

test('client: a throwing unresolved reference warns that the real assembly will fail', async () => {
  const payload = snapshotFixture({
    renderedResolved: false,
    unresolvedVariables: ['model'],
    unresolvedThrowing: ['model'],
    unresolvedLiteral: ['cwd'],
    rendered: 'powered by the {{model}} model\n\ncwd is {{cwd}}',
  });
  const page = makePage({ responses: defaultResponses({ [PATHS.snapshot]: { payload } }) });
  let tree = await openOverview(page);
  clickTab(tree, 'view', 'full');
  tree = await page.flush();
  const warning = oneBy(tree, 'data-warning', 'rendered-unresolved');
  assert.equal(warning.props['data-unresolved-variables'], 'model', 'the legacy attribute still names the fault');
  assert.equal(warning.props['data-unresolved-throwing'], 'model');
  assert.equal(warning.props['data-unresolved-literal'], 'cwd');
  assert.ok(strings(tree).includes(page.zh.unresolvedTitle), 'the fault is stated as a real-assembly failure');
  assert.ok(strings(tree).includes(page.zh.unresolvedNote));
  assert.ok(
    hasText(tree, fillText(page.zh.unresolvedBody, { list: 'model' })),
    'the throwing list is the one the warning renders',
  );
  assert.ok(
    hasText(tree, fillText(page.zh.unresolvedLiteralInline, { list: 'cwd' })),
    'and the literal half is still spelled out',
  );
  // While the fault is on screen the safe half gets no card of its own: two
  // cards for one render would read as two separate problems.
  assert.equal(collect(tree, (node) => node.props && node.props['data-note'] === 'rendered-literal').length, 0);
});

test('client: a literal-only unresolved reference is presented as the real prompt, not as a fault', async () => {
  const payload = snapshotFixture({
    renderedResolved: true,
    unresolvedVariables: [],
    unresolvedThrowing: [],
    unresolvedLiteral: ['cwd'],
    rendered: 'identity base\n\ncwd is {{cwd}}',
  });
  const page = makePage({ responses: defaultResponses({ [PATHS.snapshot]: { payload } }) });
  let tree = await openOverview(page);
  clickTab(tree, 'view', 'full');
  tree = await page.flush();
  // Nothing here can take the real assembly down, so nothing is a warning.
  assert.equal(collect(tree, (node) => node.props && node.props['data-warning'] === 'rendered-unresolved').length, 0);
  const card = oneBy(tree, 'data-note', 'rendered-literal');
  assert.equal(card.props['data-unresolved-literal'], 'cwd');
  assert.ok(strings(tree).includes(page.zh.unresolvedLiteralTitle), 'the card says the preview IS the real prompt');
  assert.ok(hasText(tree, fillText(page.zh.unresolvedLiteralBody, { list: 'cwd' })));
  assert.ok(strings(tree).includes(page.zh.unresolvedLiteralNote));
  assert.equal(oneBy(tree, 'data-full-text', 'rendered').props['data-rendered-resolved'], 'true');
});

test('client: the base/effective comparison marks changed, added and removed sections', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openOverview(page);
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

// #region 「我的 Prompt」: the only write surface (g-015)

test('client: the page opens on 「我的 Prompt」 and every tab is reachable in a fixed order', async () => {
  const page = makePage({ responses: defaultResponses() });
  const tree = await page.flush();

  // The order is the product decision, so it is asserted verbatim.
  assert.deepEqual(mainTabs(tree), ['mine', 'overview', 'history', 'advanced']);
  assert.equal(tabList(tree).props['data-active-tab'], 'mine', 'the first tab is the default');
  // The root carries the same verdict, so a probe finds it without walking in.
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-active-tab'] === 'mine').length,
    2,
    'the tab list and the root both report the active tab',
  );
  assert.equal(tabPanel(tree).props['data-tab-value'], 'mine');
  assert.equal(oneBy(tree, 'data-region', 'mine').props['data-region'], 'mine');

  // The chrome above the tabs is exactly the title, the one-line status and the
  // session selector: no panel of any tab is rendered before a tab is chosen.
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'tab-panel').length, 1);
  for (const region of ['sections', 'full', 'history', 'transfer', 'overrides', 'status-detail']) {
    assert.equal(
      collect(tree, (node) => node.props && node.props['data-region'] === region).length,
      0,
      `${region} belongs to another tab and must not be rendered`,
    );
  }
});

test('client: switching a tab renders that tab and nothing else', async () => {
  const page = makePage({ responses: defaultResponses() });
  const expectations = [
    ['mine', 'mine'],
    ['overview', 'sections'],
    ['history', 'history'],
    ['advanced', 'overrides'],
  ];
  for (const [value, region] of expectations) {
    const tree = await openTab(page, value);
    assert.equal(tabList(tree).props['data-active-tab'], value);
    assert.equal(tabPanel(tree).props['data-tab-value'], value, 'exactly one panel, and it is this tab');
    assert.equal(oneBy(tree, 'data-region', region).props['data-region'], region, `${value} renders ${region}`);
    // No other tab's own top-level region is on screen.
    for (const [otherValue, otherRegion] of expectations) {
      if (otherValue === value) continue;
      assert.equal(
        collect(tree, (node) => node.props && node.props['data-region'] === otherRegion).length,
        0,
        `${value} must not render ${otherRegion}`,
      );
    }
  }
});

test('client: 「我的 Prompt」 saves the reserved name, and only the reserved name', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await page.flush();

  // The reserved section is not in the default override fixture, so the panel
  // opens in its unconfigured state rather than showing an empty box.
  assert.equal(markerOf(tree, 'data-mine-state'), 'unconfigured');
  assert.ok(strings(tree).includes(page.zh.mineUnconfigured));
  assert.equal(oneBy(tree, 'data-role', 'mine-text').props.value, '');

  typeInto(tree, 'mine-text', 'my own house rules');
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-mine-state'), 'dirty', 'an unsaved edit is stated');
  assert.ok(strings(tree).includes(page.zh.mineDirty));

  clickButton(tree, { 'data-action': 'mine-save' });
  tree = await page.flush();

  const put = page.router.calls.filter((call) => call.init && call.init.method === 'PUT');
  assert.equal(put.length, 1, 'exactly one write');
  // The URL is the frozen route; the *body* is what the write face is.
  assert.equal(put[0].url, PATHS.overrides);
  const body = JSON.parse(put[0].init.body);
  assert.equal(body.layer, 'user');
  assert.equal(body.session, undefined, 'the global view sends no session');
  // The name is compared with the HOST constant, not with a literal here: the
  // client hardcodes it because a browser module cannot import host code, and
  // this is the assertion that keeps the two copies from drifting.
  assert.equal(body.section.name, CUSTOM_SECTION_NAME, 'the reserved name, verbatim');
  assert.equal(body.section.name, 'prompt-setting:custom-prompt');
  assert.equal(body.section.action, 'replace', 'the only action the write face accepts');
  assert.equal(body.section.text, 'my own house rules', 'the text is sent exactly as typed');
  assert.equal(markerOf(tree, 'data-mine-state'), 'saved');
  assert.ok(strings(tree).includes(fillText(page.zh.mineSaved, { layer: page.zh.ovUser })));
});

test('client: a save that the host refuses is reported, never shown as saved', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.overrides]: (url, init) =>
        init && init.method === 'PUT'
          ? { status: 403, payload: { ok: false, code: 'write-locked', message: 'only the reserved section may be written' } }
          : { payload: overridesFixture() },
    }),
  });
  let tree = await page.flush();
  typeInto(tree, 'mine-text', 'nope');
  tree = await page.flush();
  clickButton(tree, { 'data-action': 'mine-save' });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-mine-state'), 'error');
  assert.ok(strings(tree).includes(page.zh['error.write-locked']), 'the mapped copy is shown');
  assert.equal(
    oneBy(tree, 'data-mine-error', 'true').props['data-mine-error'],
    'true',
    'the failure keeps the full error card',
  );
  assert.ok(hasText(oneBy(tree, 'data-mine-error', 'true'), 'only the reserved section may be written'), 'the host message survives');
  assert.equal(markerOf(oneBy(tree, 'data-mine-error', 'true'), 'data-error-code'), 'write-locked');
  assert.ok(strings(tree).includes(page.zh.mineFailed));
});

test('client: 「恢复默认」 confirms first, then deletes by the reserved name', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.overrides]: { payload: overridesFixture({
        merged: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'stored text', layer: 'user' }] },
      }) },
    }),
  });
  let tree = await page.flush();
  // The stored value is what the panel shows, read from the merged override list.
  assert.equal(oneBy(tree, 'data-role', 'mine-text').props.value, 'stored text');
  assert.equal(markerOf(tree, 'data-mine-state'), 'idle');
  assert.ok(strings(tree).includes(fillText(page.zh.mineLoaded, { layer: page.zh.ovUser })));

  clickButton(tree, { 'data-action': 'mine-reset' });
  tree = await page.flush();
  const confirm = oneBy(tree, 'data-region', 'confirm');
  assert.equal(confirm.props['data-confirm-kind'], 'mine-reset', 'the destructive action confirms first');
  assert.equal(
    writeCalls(page).length,
    0,
    'no request is sent before confirm-yes',
  );

  clickButton(confirm, { 'data-action': 'confirm-yes' });
  tree = await page.flush();
  const deletes = writeCalls(page).filter((call) => call.init.method === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.equal(
    deletes[0].url,
    `${PATHS.overrides}?layer=user&name=${encodeURIComponent(CUSTOM_SECTION_NAME)}`,
    'the delete names the reserved section, and nothing else',
  );
  assert.ok(strings(tree).includes(fillText(page.zh.deletedNotice, { layer: page.zh.ovUser })));
});

test('client: 「我的 Prompt」 refuses a workspace write without a session, locally', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await page.flush();
  clickTab(tree, 'mine-layer', 'workspace');
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-role', 'mine-text').props['data-role'], 'mine-text');
  assert.ok(oneBy(tree, 'data-warning', 'mine-workspace-disabled'), 'the disabled workspace layer is stated');
  clickButton(tree, { 'data-action': 'mine-save' });
  tree = await page.flush();
  assert.equal(writeCalls(page).length, 0, 'no write without a resolvable workspace layer');
  assert.equal(markerOf(tree, 'data-mine-state'), 'error');
  assert.ok(strings(tree).includes(page.zh['error.workspace-unresolved']), 'the mapped copy is shown');
});

test('client: a workspace save carries the session and the reserved name', async () => {
  const page = makePage({ useSessions: sessionsHook(SESSIONS_STATE), responses: defaultResponses() });
  let tree = await page.flush();
  clickTab(tree, 'mine-layer', 'workspace');
  tree = await page.flush();
  typeInto(tree, 'mine-text', 'per-session text');
  tree = await page.flush();
  clickButton(tree, { 'data-action': 'mine-save' });
  tree = await page.flush();
  const put = page.router.calls.filter((call) => call.init && call.init.method === 'PUT');
  assert.equal(put.length, 1);
  const body = JSON.parse(put[0].init.body);
  assert.equal(body.layer, 'workspace');
  assert.equal(body.session, 's2', 'the selected session travels with the write');
  assert.equal(body.section.name, CUSTOM_SECTION_NAME);
  assert.equal(body.section.action, 'replace');
  assert.equal(body.section.text, 'per-session text');
});

test('client: a saved 「我的 Prompt」 is re-read from the changed override list', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await page.flush();
  typeInto(tree, 'mine-text', 'identity rewritten');
  tree = await page.flush();
  // The host answers the next read with the stored entry: the panel must show
  // what is configured, not what this render happened to hold.
  page.router.set(PATHS.overrides, {
    payload: overridesFixture({
      merged: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'identity rewritten', layer: 'user' }] },
    }),
  });
  clickButton(tree, { 'data-action': 'mine-save' });
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-role', 'mine-text').props.value, 'identity rewritten');
  assert.equal(markerOf(tree, 'data-mine-state'), 'saved');
});

// #region g-021: a frozen scope is a block, not a footnote (方案 A)

test('client: a frozen 「我的 Prompt」 is structurally distinct, and says what to do', async () => {
  const frozenReason = 'the scope collapsed to its complete section';
  const frozenPage = makePage({
    responses: defaultResponses({
      [PATHS.snapshot]: { payload: snapshotFixture({ frozenScope: 'session', frozen: true, frozenReason }) },
    }),
  });
  const frozenTree = await frozenPage.flush();

  // The frozen state is machine-readable on its own: no copy has to be read to
  // tell the two panels apart.
  const block = oneBy(frozenTree, 'data-warning', 'mine-frozen');
  assert.equal(block.props['data-mine-frozen'], 'true', 'the block carries its own boolean marker');
  assert.equal(block.props['data-mine-frozen-certainty'], 'certain', 'and says how sure it is');
  assert.equal(markerOf(frozenTree, 'data-mine-effect'), 'none', 'and the state line says the write has no effect');
  assert.equal(
    collect(frozenTree, (node) => node.props && node.props['data-mine-frozen'] === 'true').length,
    1,
    'exactly one blocking block',
  );

  // The three statements the brief requires: where the text goes, that it does
  // not take effect here, and what the user can do about it.
  const body = oneBy(frozenTree, 'data-mine-frozen-body', 'true');
  assert.ok(
    hasText(body, fillText(frozenPage.zh.mineFrozenBody, { layer: frozenPage.zh.ovUser })),
    'the body says the text is stored in the layer config',
  );
  assert.ok(hasText(body, 'complete'), 'and names the complete section as the cause');
  const fix = oneBy(frozenTree, 'data-mine-frozen-fix', 'true');
  assert.ok(hasText(fix, frozenPage.zh.mineFrozenHowTo), 'the fix is the panel copy, not a paraphrase');
  assert.ok(hasText(fix, 'preset'), 'and it names the actionable lever');
  assert.ok(hasText(block, frozenReason), 'the reason still travels with the block');

  // 方案 A: the write stays open. A frozen scope blocks the effect, not the
  // configuration, so the button must not be disabled.
  assert.equal(oneBy(frozenTree, 'data-action', 'mine-save').props.disabled, false, 'the write is not disabled');

  // The unfrozen control: same panel, opposite markers, no warning at all.
  const livePage = makePage({ responses: defaultResponses() });
  const liveTree = await livePage.flush();
  assert.equal(markerOf(liveTree, 'data-mine-effect'), 'next-turn');
  assert.equal(collect(liveTree, (node) => node.props && node.props['data-warning'] === 'mine-frozen').length, 0);
  assert.equal(collect(liveTree, (node) => node.props && node.props['data-mine-frozen'] === 'true').length, 0);
  assert.equal(oneBy(liveTree, 'data-action', 'mine-save').props.disabled, false);
});

test('client: saving in a frozen scope never reads as bare success', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.snapshot]: {
        payload: snapshotFixture({
          frozenScope: 'session',
          frozen: true,
          frozenReason: 'the scope collapsed to its complete section',
        }),
      },
    }),
  });
  let tree = await page.flush();
  typeInto(tree, 'mine-text', 'frozen text');
  tree = await page.flush();
  clickButton(tree, { 'data-action': 'mine-save' });
  tree = await page.flush();

  // The write really happened — that is the whole point of 方案 A.
  const put = page.router.calls.filter((call) => call.init && call.init.method === 'PUT');
  assert.equal(put.length, 1, 'a frozen scope still writes to the layer config');
  assert.equal(JSON.parse(put[0].init.body).section.text, 'frozen text');

  // …and neither success surface may stand alone.
  assert.equal(markerOf(tree, 'data-mine-state'), 'saved');
  assert.equal(markerOf(tree, 'data-mine-effect'), 'none');
  assert.ok(strings(tree).includes(fillText(page.zh.mineSavedFrozen, { layer: page.zh.ovUser })), 'the state line is conditional');
  assert.ok(strings(tree).includes(fillText(page.zh.savedNoticeFrozen, { layer: page.zh.ovUser })), 'and so is the banner');
  const bareSaved = fillText(page.zh.mineSaved, { layer: page.zh.ovUser });
  const bareNotice = fillText(page.zh.savedNotice, { layer: page.zh.ovUser });
  assert.ok(
    !strings(tree).some((text) => text.includes(bareSaved) || text.includes(bareNotice)),
    'the unconditional saved copy appears nowhere while the scope is frozen',
  );
});

test('client: a frozen scope never eats the typed text', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.snapshot]: {
        payload: snapshotFixture({
          frozenScope: 'session',
          frozen: true,
          frozenReason: 'the scope collapsed to its complete section',
        }),
      },
    }),
  });
  let tree = await page.flush();
  typeInto(tree, 'mine-text', 'draft under a frozen scope');
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-role', 'mine-text').props.value, 'draft under a frozen scope');

  // Away to another tab and back: the draft survives the freeze.
  clickAnyTab(tree, 'overview');
  tree = await page.flush();
  clickAnyTab(tree, 'mine');
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-role', 'mine-text').props.value, 'draft under a frozen scope');
  assert.equal(markerOf(tree, 'data-mine-effect'), 'none', 'still frozen');

  // Away to the other layer and back: still the user layer's own draft.
  clickTab(tree, 'mine-layer', 'workspace');
  tree = await page.flush();
  clickTab(tree, 'mine-layer', 'user');
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-role', 'mine-text').props.value, 'draft under a frozen scope');

  // Unfreeze: the text is still there, and now it saves under the plain copy.
  page.router.set(PATHS.snapshot, { payload: snapshotFixture({ frozenScope: 'session', frozen: false }) });
  clickAnyTab(tree, 'overview');
  tree = await page.flush();
  clickAnyTab(tree, 'mine');
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-mine-effect'), 'next-turn', 'the freeze is gone');
  assert.equal(oneBy(tree, 'data-role', 'mine-text').props.value, 'draft under a frozen scope');
  clickButton(tree, { 'data-action': 'mine-save' });
  tree = await page.flush();
  assert.ok(
    strings(tree).includes(fillText(page.zh.mineSaved, { layer: page.zh.ovUser })),
    'the unconditional copy is back once the scope is not frozen',
  );
  const put = page.router.calls.filter((call) => call.init && call.init.method === 'PUT');
  assert.equal(put.length, 1);
  assert.equal(JSON.parse(put[0].init.body).section.text, 'draft under a frozen scope');
});

test('client: the global-freeze-with-a-session case stays "unknown" in the panel too', async () => {
  // CONTRACT.md §2.4/§7.2: a global freeze plus a selected session is *unknown*,
  // never "not frozen" — and, just as important, never "this session is frozen".
  // The panel keeps warning (the write may well be discarded), but it says so
  // with its own copy and its own markers.
  const scopeReason = 'session "s2" has no active agent, so this verdict describes the unscoped assembly';
  const page = makePage({
    useSessions: sessionsHook(SESSIONS_STATE),
    responses: defaultResponses({
      [PATHS.snapshot]: {
        payload: snapshotFixture({ frozenScope: 'global', frozen: true, frozenScopeReason: scopeReason }),
      },
    }),
  });
  let tree = await page.flush();
  assert.equal(markerOf(tree, 'data-frozen-state'), 'unknown', 'the page verdict is still unknown');

  const block = oneBy(tree, 'data-warning', 'mine-frozen');
  assert.equal(block.props['data-mine-frozen'], 'true');
  assert.equal(block.props['data-mine-frozen-certainty'], 'unknown', 'the panel claims no certainty it does not have');
  assert.equal(markerOf(tree, 'data-mine-effect'), 'unknown', 'and the effect is unknown, not none');
  const body = oneBy(tree, 'data-mine-frozen-body', 'true');
  assert.ok(
    hasText(body, fillText(page.zh.mineFrozenUnknownBody, { layer: page.zh.ovUser })),
    'the unknown wording is its own copy',
  );
  assert.ok(
    !hasText(body, fillText(page.zh.mineFrozenBody, { layer: page.zh.ovUser })),
    'and never the certain-freeze wording',
  );
  assert.ok(hasText(block, scopeReason), 'the scope reason travels with the block');

  // Saving here is still conditional, never bare success.
  typeInto(tree, 'mine-text', 'text under an unknown freeze');
  tree = await page.flush();
  clickButton(tree, { 'data-action': 'mine-save' });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-mine-state'), 'saved');
  assert.equal(markerOf(tree, 'data-mine-effect'), 'unknown');
  assert.ok(strings(tree).includes(fillText(page.zh.mineSavedUnknown, { layer: page.zh.ovUser })));
  assert.ok(strings(tree).includes(fillText(page.zh.savedNoticeUnknown, { layer: page.zh.ovUser })));
  assert.ok(
    !strings(tree).some((text) => text.includes(fillText(page.zh.mineSaved, { layer: page.zh.ovUser }))),
    'the unconditional saved copy is still withheld',
  );
});

// #endregion

// #endregion

// #region 「提示词总览」 is read-only, and the legacy list says its pieces

test('client: 「提示词总览」 renders no write entry at all', async () => {
  const page = makePage({ responses: defaultResponses() });
  // Both inner views, both renderer branches: an editor path that only appears
  // for one of them would still be an editor path.
  for (const primitives of ['throw', 'ok']) {
    const each = makePage({ primitives, responses: defaultResponses() });
    for (const view of ['sections', 'full']) {
      let tree = await openTab(each, 'overview');
      if (view === 'full') {
        clickAnyTab(tree, 'full');
        tree = await each.flush();
      }
      assert.equal(
        collect(tree, (node) => node.props && node.props['data-region'] === 'editor').length,
        0,
        `no editor node (${primitives}/${view})`,
      );
      const writeActions = collect(
        tree,
        (node) =>
          node.props &&
          ['edit', 'append-new', 'delete', 'save', 'cancel', 'undo', 'reset-section'].includes(node.props['data-action']),
      ).map((node) => node.props['data-action']);
      assert.deepEqual(writeActions, [], `no write action (${primitives}/${view})`);
      // The read-only controls the tab promises are still there.
      assert.ok(oneBy(tree, 'data-action', 'copy'), `copy is offered (${primitives}/${view})`);
      if (view === 'sections') assert.equal(editSwitches(tree).length, 0, 'and no 「编辑」 switch either');
    }
  }
});

test('client: 「提示词总览」 owns no copy of the reserved section', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.snapshot]: {
        payload: snapshotFixture({
          effective: {
            sections: [
              ...snapshotFixture().effective.sections,
              {
                name: CUSTOM_SECTION_NAME,
                index: 5,
                text: 'my own house rules',
                applied: true,
                overridable: true,
                reason: null,
                overrideLayer: 'user',
                action: 'replace',
                origin: 'registered',
              },
            ],
          },
        }),
      },
    }),
  });
  const tree = await openOverview(page);
  // The reserved section belongs to 「我的 Prompt」; the overview says so instead
  // of rendering the same text twice on one page.
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-section-row'] === CUSTOM_SECTION_NAME).length,
    0,
    'the reserved row is not repeated',
  );
  assert.equal(oneBy(tree, 'data-note', 'reserved-own-tab').props['data-note'], 'reserved-own-tab');
  assert.equal(markerOf(tree, 'data-sections-total'), '5', 'only the other sections are counted');
});

test('client: the segment list states 已覆盖 / 已隐藏 / 追加 from the applied action', async () => {
  const payload = snapshotFixture();
  payload.effective.sections[1].action = 'replace'; // project:alpha
  payload.effective.sections[2].action = 'append'; // extra:appended
  payload.effective.sections[3].action = 'hide'; // companion:extra
  const page = makePage({ responses: defaultResponses({ [PATHS.snapshot]: { payload } }) });
  const tree = await openOverview(page);
  assert.ok(strings(oneBy(tree, 'data-section-row', 'project:alpha')).includes(page.zh.ovEffective));
  assert.ok(strings(oneBy(tree, 'data-section-row', 'extra:appended')).includes(page.zh.stAppended));
  assert.ok(strings(oneBy(tree, 'data-section-row', 'companion:extra')).includes(page.zh.stHidden));
  // Untouched rows claim no such state.
  assert.ok(!strings(oneBy(tree, 'data-section-row', 'harness:identity')).includes(page.zh.stHidden));
});

// #endregion

test('client: 「提示词总览」 proves why an override did not take effect', async () => {
  const payload = snapshotFixture();
  // A registered section whose append override the Host skipped: `applied:false`
  // with the Host's observation as the reason.
  payload.effective.sections[0].applied = false;
  payload.effective.sections[0].overridable = false;
  payload.effective.sections[0].overrideLayer = 'user';
  payload.effective.sections[0].action = 'append';
  payload.effective.sections[0].reason = 'the appended text was replaced further down the assembly pipeline';
  const page = makePage({ responses: defaultResponses({ [PATHS.snapshot]: { payload } }) });
  const tree = await openOverview(page);
  const line = oneBy(tree, 'data-section-ineffective', 'name-already-present');
  assert.ok(hasText(line, page.zh.blockAppendExisting), 'the real cause is named');
  assert.ok(strings(line).some((text) => text.includes(page.zh.ovFixHint)), 'and a fix is offered');
  assert.ok(hasText(tree, 'the appended text was replaced further down'), 'the host reason is still visible');
});

test('client: the legacy override list shows an ineffective entry with cause and fix', async () => {
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
  const tree = await openAdvanced(page);
  const bad = oneBy(tree, 'data-override-row', 'harness:identity');
  assert.equal(bad.props['data-override-applied'], 'false', 'ineffective is explicit');
  const reason = oneBy(tree, 'data-override-reason', 'harness:identity');
  assert.ok(hasText(reason, page.zh.blockAppendExisting), 'cause shown');
  assert.ok(hasText(bad, 'the appended text was replaced further down'), 'host reason shown too');
  assert.ok(hasText(bad, page.zh.ovFixHint), 'fix hint shown');
  assert.equal(oneBy(tree, 'data-override-row', 'project:alpha').props['data-override-applied'], 'true');
});

// #endregion

test('client: the legacy override list is read-only, and names what it holds', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.overrides]: {
        payload: overridesFixture({
          merged: {
            overrides: [
              { name: 'project:alpha', action: 'replace', text: 'alpha overridden', layer: 'user' },
              { name: 'extra:appended', action: 'append', text: 'appended text', layer: 'workspace' },
              { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'mine', layer: 'user' },
            ],
          },
        }),
      },
    }),
  });
  const tree = await openAdvanced(page);
  assert.equal(oneBy(tree, 'data-overrides-total', '3').props['data-overrides-total'], '3');
  const first = oneBy(tree, 'data-override-row', 'project:alpha');
  assert.equal(first.props['data-override-layer'], 'user');
  assert.equal(first.props['data-override-action'], 'replace');
  assert.equal(first.props['data-override-reserved'], 'false');
  assert.equal(oneBy(tree, 'data-override-row', 'extra:appended').props['data-override-layer'], 'workspace');
  assert.equal(
    oneBy(tree, 'data-override-row', CUSTOM_SECTION_NAME).props['data-override-reserved'],
    'true',
    '「我的 Prompt」 is marked as the reserved entry',
  );
  // Read-only by construction: the Revision 6 per-entry write controls are gone.
  const writeActions = collect(
    tree,
    (node) => node.props && ['undo', 'reset-section', 'edit', 'delete'].includes(node.props['data-action']),
  );
  assert.deepEqual(writeActions, [], 'the legacy list offers no per-entry write');
  assert.equal(writeCalls(page).length, 0, 'and has not written anything');
});

test('client: 「高级」 carries the full status the top line compresses', async () => {
  const oracle = independentBuildFingerprint(clientSource);
  const page = makePage({
    responses: defaultResponses({ [PATHS.ping]: pingResponse(buildFixture(oracle.hash, oracle.size)) }),
  });
  const top = await page.flush();
  // One line: the verdicts, not the explanation.
  assert.equal(oneBy(top, 'data-region', 'status').props['data-status-mount'], 'true');
  assert.equal(oneBy(top, 'data-region', 'status').props['data-status-frozen'], 'unfrozen');
  assert.equal(oneBy(top, 'data-region', 'status').props['data-status-build'], 'true');
  assert.equal(collect(top, (node) => node.props && node.props['data-region'] === 'build').length, 0);

  const tree = await openAdvanced(page);
  const detail = oneBy(tree, 'data-region', 'status-detail');
  assert.equal(detail.props['data-region'], 'status-detail');
  assert.equal(oneBy(detail, 'data-region', 'build').props['data-region'], 'build');
  assert.ok(hasText(detail, '2024-01-01T00:00:00.000Z'), 'the generation timestamp is detail');
  assert.ok(hasText(detail, page.zh.stUserLayer), 'both layers are named');
  // The renderer self-check lives here too (it is diagnostics, not navigation).
  assert.ok(hasText(oneBy(tree, 'data-region', 'renderer-info'), page.zh.rendererFallback));
  assert.ok(hasText(tree, 'Cannot find module'), 'the unavailable primitives reason is surfaced');
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

/** Open 「历史与备份」, where the log, the comparison and the transfer panel live. */
async function openHistory(page) {
  return openTab(page, 'history');
}

/** Open 「高级」, where the legacy override list, the layer buttons and the status detail live. */
async function openAdvanced(page) {
  return openTab(page, 'advanced');
}

/** Open 「提示词总览」, the read-only assembly, on its segment list. */
async function openOverview(page) {
  return openTab(page, 'overview');
}

test('client: the history log is fetched only while 「历史与备份」 is open', async () => {
  const page = makePage({ responses: defaultResponses() });
  const mine = await page.flush();
  assert.equal(urlsFor(page, PATHS.history).length, 0, '「我的 Prompt」 pays nothing for the log');
  const overview = await openTab(page, 'overview', mine);
  assert.equal(urlsFor(page, PATHS.history).length, 0, 'and neither does 「提示词总览」');
  await openTab(page, 'history', overview);
  assert.deepEqual(urlsFor(page, PATHS.history), [`${PATHS.history}?layer=user&limit=20`]);
});

test('client: the history panel renders records, their action and their origin', async () => {
  const page = makePage({ responses: defaultResponses() });
  const tree = await openHistory(page);
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
  const emptyTree = await openHistory(empty);
  assert.ok(oneBy(emptyTree, 'data-empty', 'history'));
  assert.ok(strings(emptyTree).includes(empty.zh.histEmpty));

  const broken = makePage({
    responses: defaultResponses({
      [PATHS.history]: {
        payload: historyFixture({ records: [], total: 0, corrupt: 3, unreadable: 'unreadable-file: cannot read /x', lastError: { at: '2024-01-02T00:00:00.000Z', reason: 'history-unusable: nope' } }),
      },
    }),
  });
  const brokenTree = await openHistory(broken);
  assert.equal(markerOf(brokenTree, 'data-history-corrupt'), '3');
  assert.ok(oneBy(brokenTree, 'data-history-unreadable', 'true'));
  assert.ok(oneBy(brokenTree, 'data-history-last-error', 'true'));
  assert.ok(hasText(brokenTree, 'unreadable-file: cannot read /x'));
});

test('client: a failing history request shows the mapped copy and keeps the page', async () => {
  const page = makePage({
    responses: defaultResponses({ [PATHS.history]: { status: 400, payload: { ok: false, code: 'unknown-layer', message: 'nope' } } }),
  });
  const tree = await openHistory(page);
  assert.equal(oneBy(tree, 'data-region', 'history').props['data-history-state'], 'error');
  assert.ok(hasText(tree, page.zh['error.unknown-layer']));
  assert.equal(markerOf(tree, 'data-render-state'), 'ok', 'the page itself still renders');
});

test('client: choosing two records requests the comparison and renders both levels', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openHistory(page);

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
  let tree = await openHistory(page);
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
  let tree = await openHistory(page);
  clickButton(historyRowOf(tree, '1'), { 'data-action': 'diff-from', 'data-history-id': '1' });
  tree = await page.flush();
  const panel = oneBy(tree, 'data-region', 'history-diff');
  assert.equal(markerOf(panel, 'data-diff-no-lines'), 'true');
  assert.ok(hasText(panel, 'more than one section differs'));
});

test('client: the primitives branch renders the comparison with the official DiffBlock', async () => {
  const page = makePage({ primitives: 'ok', responses: defaultResponses() });
  let tree = await openHistory(page);
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
  let tree = await openHistory(page);
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
  let sessionTree = await openHistory(sessionPage);
  clickTab(sessionTree, 'history-layer', 'workspace');
  sessionTree = await sessionPage.flush();
  assert.deepEqual(urlsFor(sessionPage, PATHS.history), [
    `${PATHS.history}?layer=user&session=s2&limit=20`,
    `${PATHS.history}?layer=workspace&session=s2&limit=20`,
  ]);
  assert.equal(markerOf(sessionTree, 'data-history-total'), '2');
});

test('client: 「清除全部覆盖」 confirms first, then sends legacy=true and keeps 「我的 Prompt」', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.overrides]: {
        payload: overridesFixture({
          user: {
            layer: 'user',
            enabled: true,
            path: '/p',
            reason: null,
            overrides: [
              { name: 'project:alpha', action: 'replace', text: 'alpha overridden' },
              { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'mine' },
            ],
          },
        }),
      },
    }),
  });
  const tree = await openAdvanced(page);
  const region = oneBy(tree, 'data-region', 'layer-reset');
  assert.equal(region.props['data-reset-layer'], 'user');
  assert.equal(region.props['data-reset-count'], '2', 'the whole layer is counted');
  assert.equal(region.props['data-reset-frozen-count'], '1', 'and the frozen half separately');
  assert.equal(region.props['data-reset-reserved-count'], '1');

  clickButton(region, { 'data-action': 'legacy-clear', 'data-layer': 'user' });
  const withConfirm = await page.flush();
  const card = oneBy(withConfirm, 'data-region', 'confirm');
  assert.equal(card.props['data-confirm-kind'], 'legacy-clear');
  assert.ok(hasText(card, page.zh.ovUser), 'the impact names the layer');
  assert.ok(hasText(card, '1'), 'and the frozen count');
  assert.ok(hasText(card, page.zh.resetIrreversible), 'and says it cannot be undone');
  assert.equal(writeCalls(page).length, 0, 'nothing is sent before confirm-yes');

  clickButton(card, { 'data-action': 'confirm-yes' });
  const after = await page.flush();
  assert.deepEqual(writeCalls(page).map((call) => [call.init.method, call.url]), [
    ['DELETE', `${PATHS.overrides}?layer=user&legacy=true`],
  ]);
  assert.notEqual(after, null);
});

test('client: 「清除全部覆盖」 can be cancelled without writing', async () => {
  const page = makePage({ responses: defaultResponses() });
  const tree = await openAdvanced(page);
  clickButton(oneBy(tree, 'data-region', 'layer-reset'), { 'data-action': 'legacy-clear', 'data-layer': 'user' });
  let next = await page.flush();
  clickButton(oneBy(next, 'data-region', 'confirm'), { 'data-action': 'confirm-no' });
  next = await page.flush();
  assert.equal(collect(next, (node) => node.props && node.props['data-region'] === 'confirm').length, 0);
  assert.equal(writeCalls(page).length, 0);
});

test('client: 「整层恢复默认」 needs a confirmation and states the impact', async () => {
  const page = makePage({ responses: defaultResponses() });
  const tree = await openAdvanced(page);
  const region = oneBy(tree, 'data-region', 'layer-reset');
  assert.equal(region.props['data-reset-layer'], 'user');
  assert.equal(region.props['data-reset-count'], '1');
  assert.ok(hasText(region, page.zh.resetLayerBody.replace('{layer}', page.zh.ovUser).replace('{count}', '1')));

  clickButton(region, { 'data-action': 'reset-layer', 'data-layer': 'user' });
  let next = await page.flush();
  const card = oneBy(next, 'data-region', 'confirm');
  assert.equal(card.props['data-confirm-kind'], 'reset-layer');
  assert.equal(writeCalls(page).length, 0, 'nothing is sent before confirm-yes');
  clickButton(card, { 'data-action': 'confirm-yes' });
  next = await page.flush();
  assert.deepEqual(writeCalls(page).map((call) => [call.init.method, call.url]), [
    ['DELETE', `${PATHS.overrides}?layer=user&reset=true`],
  ]);
  assert.ok(hasText(next, page.zh.resetNoneNotice), 'the double answers count 0, and the page says so');
});

test('client: the layer reset is disabled when the layer holds nothing', async () => {
  const page = makePage({
    responses: defaultResponses({ [PATHS.overrides]: { payload: overridesFixture({ user: { layer: 'user', enabled: true, path: '/p', reason: null, overrides: [] } }) } }),
  });
  const tree = await openAdvanced(page);
  const button = findOne(tree, (node) => node.type === 'button' && node.props['data-action'] === 'reset-layer', 'reset-layer button');
  assert.equal(button.props.disabled, true);
});

test('client: exporting downloads the document and keeps a copyable text', async () => {
  const page = makePage({
    useSessions: sessionsHook(SESSIONS_STATE),
    responses: defaultResponses(),
  });
  const downloader = installDownloader(page);
  let tree = await openHistory(page);
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
  let tree = await openHistory(page);
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
  let tree = await openHistory(page);
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
  assert.equal(plan.props['data-import-unchanged-count'], '0', 'the plan count is not the "nothing changed" flag');
  assert.equal(plan.props['data-import-unchanged'], undefined);
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
  let tree = await openHistory(page);
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
  let tree = await openHistory(page);
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
  let tree = await openHistory(page);
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
  let tree = await openHistory(page);
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
  const tree = await openHistory(page);
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
  let tree = await openHistory(page);
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

// #region english render sweep: the en dictionary, every view and every state

/**
 * Both registered tables, read once from a throwaway mount. The zh table is
 * kept so the sweep can iterate *its* key set: a key deleted from `en` no
 * longer appears in `en`'s own keys, and must still be caught.
 */
const SWEEP_TABLES = (() => {
  const { module } = loadClient('throw');
  const { dictionaries } = mountClient(module);
  return dictionaries[0].dict;
})();

/** The registered en table. */
const EN_TABLE = SWEEP_TABLES.en;

/**
 * Every token the en copy itself uses. A rendered token that is also a
 * dictionary key but never occurs in the en copy is a leaked key, not English.
 */
const EN_COPY_WORDS = (() => {
  const words = new Set();
  for (const value of Object.values(EN_TABLE)) {
    for (const word of String(value).split(/[^A-Za-z0-9_-]+/)) if (word.length > 0) words.add(word);
  }
  return words;
})();

/** Dotted keys (`error.not-found`) can only reach the screen by leaking. */
const EN_DOTTED_KEYS = Object.keys(EN_TABLE).filter((key) => key.indexOf('.') >= 0);

/**
 * The characters that must never reach an en render: the required
 * `/[\u4e00-\u9fff]/` ideograph block, plus the CJK punctuation/symbol blocks
 * (`（）「」：，。` and friends) that a hardcoded Chinese template leaves behind.
 */
const CJK_ON_SCREEN = /[\u4e00-\u9fff\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/;

/** A page whose `t` is bound to the registered en dictionary. */
function enPage(options = {}) {
  return makePage({ ...options, language: 'en' });
}

/**
 * The props that put user-visible copy on screen without being children:
 * a hardcoded Chinese placeholder or tooltip is a leak exactly like a label.
 */
const TEXT_ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt', 'value'];

/** Every rendered string — children and text-bearing props — with its markers. */
function stringsByMarker(node, markers = {}, out = []) {
  if (typeof node === 'string') {
    out.push({ text: node, markers, attribute: null });
    return out;
  }
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) stringsByMarker(child, markers, out);
    return out;
  }
  const props = node.props || {};
  const own = Object.keys(props).filter((key) => key.startsWith('data-'));
  const next =
    own.length === 0
      ? markers
      : { ...markers, ...Object.fromEntries(own.map((key) => [key, props[key]])) };
  for (const attribute of TEXT_ATTRIBUTES) {
    if (typeof props[attribute] === 'string' && props[attribute].length > 0) {
      out.push({ text: props[attribute], markers: next, attribute });
    }
  }
  stringsByMarker(props.children, next, out);
  return out;
}

/** `region=sections build=…`: the marker trail that owns one rendered string. */
function markerTrail(markers) {
  const parts = Object.keys(markers)
    .sort()
    .map((key) => `${key.replace(/^data-/, '')}=${String(markers[key])}`);
  return parts.length === 0 ? '(root)' : parts.join(' ');
}

/** Every non-English thing one tree puts on screen. */
function englishProblems(tree) {
  const problems = [];
  for (const { text, markers, attribute } of stringsByMarker(tree)) {
    const place = attribute === null ? markerTrail(markers) : `${attribute} @ ${markerTrail(markers)}`;
    const cjk = text.match(new RegExp(CJK_ON_SCREEN, 'g'));
    if (cjk !== null) {
      problems.push({ kind: 'cjk', chars: [...new Set(cjk)].join(''), text, at: place });
    }
    for (const key of EN_DOTTED_KEYS) {
      if (text.indexOf(key) >= 0) problems.push({ kind: 'bare-key', key, text, at: place });
    }
    for (const word of text.split(/[^A-Za-z0-9_-]+/)) {
      if (word.length === 0 || EN_COPY_WORDS.has(word)) continue;
      if (Object.prototype.hasOwnProperty.call(EN_TABLE, word)) {
        problems.push({ kind: 'bare-key', key: word, text, at: place });
      }
    }
  }
  return problems;
}

/** Every `data-*` marker one tree carries, as `attr=value`. */
function dataMarkers(tree) {
  const pairs = new Set();
  for (const node of collect(tree, (candidate) => candidate.props !== undefined)) {
    for (const [key, value] of Object.entries(node.props)) {
      if (key.startsWith('data-')) pairs.add(`${key}=${String(value)}`);
    }
  }
  return pairs;
}

/** A page plus every tree it draws, so intermediate states are swept too. */
function recorder(page) {
  const trees = [];
  return {
    page,
    trees,
    async take() {
      const tree = await page.flush();
      trees.push(tree);
      return tree;
    },
    last() {
      return trees[trees.length - 1];
    },
  };
}

/**
 * Re-draw one recorded page with 「高级」 open and return every tree it has
 * drawn: the status *details* (build digests, frozen reasons, the renderer
 * self-check) moved into that tab in g-015, so a status case has to walk there.
 * @param rec - a {@link recorder} handle.
 * @returns every tree the recorder has drawn, including the new one.
 */
async function advancedTrees(rec) {
  clickAnyTab(rec.last(), 'advanced');
  await rec.take();
  return rec.trees;
}

/** The `data-*` markers the sweep saw; filled by the sweep, read by the coverage test. */
let observedMarkers = new Set();

/**
 * One en render per interesting state. `run` returns every tree drawn on the
 * way (all of them are swept); `marks` are `data-*` pairs that must be on the
 * last tree; `copy` are dictionary keys whose en text must be on screen
 * verbatim; `raw` are verbatim strings for the branch where `t` itself is the
 * thing that broke.
 */
const EN_SWEEP_CASES = [
  {
    name: 'overview: default list, origin filter, filtered to nothing',
    marks: [
      ['data-region', 'overview'],
      ['data-region', 'sections'],
      ['data-region', 'panel'],
      ['data-region', 'view-tabs'],
      ['data-region', 'status'],
      ['data-region', 'filters'],
      ['data-sections-shown', '0'],
      ['data-sections-total', '5'],
      ['data-active-tab', 'overview'],
    ],
    copy: ['title', 'subtitle', 'stateHeading', 'viewSections', 'filterHeading', 'fNo', 'overviewReservedNote', 'copy'],
    async run() {
      const page = enPage({ responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'overview');
      await rec.take();
      clickTab(rec.last(), 'origin', 'downstream-added');
      await rec.take();
      clickTab(rec.last(), 'origin', 'all');
      await rec.take();
      clickTab(rec.last(), 'overridable', 'no');
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'overview: an empty assembly states the empty state',
    marks: [
      ['data-phase', 'empty'],
      ['data-empty', 'sections'],
      ['data-region', 'sections'],
    ],
    copy: ['emptyTitle', 'emptyBody', ['sectionsShown', { shown: 0, total: 0 }]],
    async run() {
      const page = enPage({
        responses: defaultResponses({
          [PATHS.snapshot]: {
            payload: snapshotFixture({ base: { sections: [] }, effective: { sections: [] }, rendered: '' }),
          },
          [PATHS.overrides]: { payload: overridesFixture({ merged: { overrides: [] } }) },
        }),
      });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'overview');
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'the loading state before the first answer',
    marks: [['data-phase', 'loading'], ['data-region', 'panel']],
    copy: ['loading', 'refresh'],
    async run() {
      const page = enPage({ responses: defaultResponses() });
      return [page.draw()];
    },
  },
  {
    name: 'overview / full text: the rendered text, the search and the base/effective diff',
    marks: [
      ['data-region', 'full'],
      ['data-full-text', 'rendered'],
      ['data-region', 'diff'],
      ['data-diff-row', 'project:alpha'],
      ['data-diff-detail', 'project:alpha'],
    ],
    copy: ['viewFull', 'fullHeading', 'searchPlaceholder', 'diffHeading', 'diffChanged', 'diffHint'],
    async run() {
      const page = enPage({ responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'overview');
      await rec.take();
      clickTab(rec.last(), 'view', 'full');
      await rec.take();
      typeInto(rec.last(), 'search', 'alpha');
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'overview / full text: the origin filter, the line cap and the unresolved warning',
    marks: [
      ['data-region', 'full'],
      ['data-full-text', 'filtered'],
      ['data-warning', 'full-filtered'],
    ],
    copy: ['fullFiltered', 'fullHeading'],
    async run() {
      const page = enPage({ responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'overview');
      await rec.take();
      clickTab(rec.last(), 'view', 'full');
      await rec.take();
      clickTab(rec.last(), 'full-origin', 'downstream-added');
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'overview / full text: a text over the line cap is truncated, and says so',
    marks: [['data-region', 'full'], ['data-warning', 'truncated']],
    copy: ['fullHeading'],
    async run() {
      const page = enPage({
        responses: defaultResponses({
          [PATHS.snapshot]: { payload: snapshotFixture({ rendered: Array(3002).fill('line').join('\n') }) },
        }),
      });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'overview');
      await rec.take();
      clickTab(rec.last(), 'view', 'full');
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'overview / full text: unresolved variables are named, not silently dropped',
    marks: [
      ['data-region', 'full'],
      ['data-warning', 'rendered-unresolved'],
      ['data-full-text', 'rendered'],
    ],
    copy: ['unresolvedTitle', 'unresolvedNote'],
    async run() {
      const payload = snapshotFixture({
        renderedResolved: false,
        unresolvedVariables: ['Upper', 'project:alpha'],
        rendered: 'identity base\n\n{{Upper}} {{project:alpha}}',
      });
      const page = enPage({ responses: defaultResponses({ [PATHS.snapshot]: { payload } }) });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'overview');
      await rec.take();
      clickTab(rec.last(), 'view', 'full');
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'overview / full text: a graded fault — throwing references fail, literal ones are still spelled out',
    marks: [
      ['data-region', 'full'],
      ['data-warning', 'rendered-unresolved'],
      ['data-note', 'rendered-literal-inline'],
    ],
    copy: [
      'unresolvedTitle',
      'unresolvedNote',
      ['unresolvedBody', { list: 'model' }],
      ['unresolvedLiteralInline', { list: 'cwd' }],
    ],
    async run() {
      const payload = snapshotFixture({
        renderedResolved: false,
        unresolvedVariables: ['model'],
        unresolvedThrowing: ['model'],
        unresolvedLiteral: ['cwd'],
        rendered: 'powered by the {{model}} model\n\ncwd is {{cwd}}',
      });
      const page = enPage({ responses: defaultResponses({ [PATHS.snapshot]: { payload } }) });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'overview');
      await rec.take();
      clickTab(rec.last(), 'view', 'full');
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'overview / full text: a graded non-fault — a literal-only reference is the real prompt',
    marks: [
      ['data-region', 'full'],
      ['data-note', 'rendered-literal'],
    ],
    copy: [
      'unresolvedLiteralTitle',
      'unresolvedLiteralNote',
      ['unresolvedLiteralBody', { list: 'cwd' }],
    ],
    async run() {
      const payload = snapshotFixture({
        renderedResolved: true,
        unresolvedVariables: [],
        unresolvedThrowing: [],
        unresolvedLiteral: ['cwd'],
        rendered: 'identity base\n\ncwd is {{cwd}}',
      });
      const page = enPage({ responses: defaultResponses({ [PATHS.snapshot]: { payload } }) });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'overview');
      await rec.take();
      clickTab(rec.last(), 'view', 'full');
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'history: the log, the comparison and the transfer panel',
    marks: [
      ['data-region', 'history-tab'],
      ['data-region', 'history'],
      ['data-region', 'transfer'],
      ['data-history-row', '2'],
      ['data-active-tab', 'history'],
    ],
    copy: ['histHeading', 'transferHeading', 'exportButton', 'histPickFrom'],
    async run() {
      const page = enPage({ responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'history');
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'advanced: no override at all, and an empty history',
    marks: [
      ['data-empty', 'overrides'],
      ['data-region', 'overrides'],
      ['data-region', 'layer-reset'],
      ['data-region', 'status-detail'],
      ['data-active-tab', 'advanced'],
    ],
    copy: ['ovEmpty', 'ovHeading', 'ovMergedNote', 'resetLayersLabel', 'advReadOnlyNote', 'resetLegacyButton'],
    async run() {
      const page = enPage({
        responses: defaultResponses({
          [PATHS.overrides]: { payload: overridesFixture({ merged: { overrides: [] } }) },
          [PATHS.history]: { payload: historyFixture({ records: [], total: 0 }) },
        }),
      });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'advanced');
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'history: a corrupt, unreadable history is stated, never a blank',
    marks: [
      ['data-region', 'history'],
      ['data-history-corrupt', '3'],
      ['data-history-unreadable', 'true'],
      ['data-history-last-error', 'true'],
    ],
    copy: [['histCorrupt', { n: 3 }], ['histUnreadable', { reason: 'unreadable-file: cannot read /x' }], ['histLastError', { reason: 'history-unusable: nope' }]],
    async run() {
      const page = enPage({
        responses: defaultResponses({
          [PATHS.history]: {
            payload: historyFixture({
              records: [],
              total: 0,
              corrupt: 3,
              unreadable: 'unreadable-file: cannot read /x',
              lastError: { at: '2024-01-02T00:00:00.000Z', reason: 'history-unusable: nope' },
            }),
          },
        }),
      });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'history');
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'history: a comparison renders both levels and the diff block',
    marks: [
      ['data-region', 'history-diff'],
      ['data-region', 'diffblock'],
      ['data-hd-row', 'project:alpha'],
      ['data-diff-from', '2'],
      ['data-diff-to', '1'],
    ],
    copy: ['histDiffHeading', ['histDiffSections', { total: 2, changed: 1, added: 0, removed: 0, same: 1 }]],
    async run() {
      const page = enPage({ responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'history');
      await rec.take();
      clickButton(historyRowOf(rec.last(), '2'), { 'data-action': 'diff-from', 'data-history-id': '2' });
      await rec.take();
      clickButton(historyRowOf(rec.last(), '1'), { 'data-action': 'diff-to', 'data-history-id': '1' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'history: a comparison the host could not make is explained',
    marks: [
      ['data-region', 'history-diff'],
      ['data-diff-no-lines', 'true'],
    ],
    copy: [['histDiffNoLines', { reason: 'more than one section differs; pass ?name= to compare one of them' }]],
    async run() {
      const payload = diffFixture({
        lines: null,
        lineReason: 'more than one section differs; pass ?name= to compare one of them',
      });
      const page = enPage({ responses: defaultResponses({ [PATHS.diff]: { payload } }) });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'history');
      await rec.take();
      clickButton(historyRowOf(rec.last(), '1'), { 'data-action': 'diff-from', 'data-history-id': '1' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'transfer: an import dry run renders the plan, both counts and both modes',
    marks: [
      ['data-region', 'transfer'],
      ['data-import-plan', 'true'],
      ['data-import-change', 'project:alpha'],
      ['data-import-skipped', '1'],
      ['data-import-mode', 'replace'],
    ],
    copy: ['importHeading', 'importPlanHeading', 'importModeReplace', ['importChangeRow', { name: 'project:alpha', status: 'replaced' }], ['importCounts', { added: 1, replaced: 1, unchanged: 0, removed: 0, kept: 1 }]],
    async run() {
      const page = enPage({ responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'history');
      await rec.take();
      clickTab(rec.last(), 'import-mode', 'replace');
      await rec.take();
      typeInto(rec.last(), 'import-text', exportDocument());
      await rec.take();
      clickButton(oneBy(rec.last(), 'data-region', 'transfer'), { 'data-action': 'import-preview' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'transfer: a rejected import names the reason and the unchanged state',
    marks: [
      ['data-region', 'transfer'],
      ['data-error-code', 'unknown-export-schema'],
      ['data-import-unchanged', 'true'],
    ],
    copy: ['error.unknown-export-schema', 'importUnchangedWarning'],
    async run() {
      const page = enPage({
        responses: defaultResponses({
          [PATHS.import]: {
            status: 400,
            payload: { ok: false, code: 'unknown-export-schema', message: '"schema" must be "dsh-prompt-setting/export"' },
          },
        }),
      });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'history');
      await rec.take();
      typeInto(rec.last(), 'import-text', exportDocument({ schema: 'nope' }));
      await rec.take();
      clickButton(oneBy(rec.last(), 'data-region', 'transfer'), { 'data-action': 'import-preview' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'transfer: an import asks for confirmation before it writes',
    marks: [
      ['data-region', 'confirm'],
      ['data-confirm-kind', 'import'],
    ],
    copy: ['importConfirmTitle', 'confirmTitle', 'confirmYes', 'confirmNo', 'resetIrreversible'],
    async run() {
      const page = enPage({ responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'history');
      await rec.take();
      typeInto(rec.last(), 'import-text', exportDocument());
      await rec.take();
      clickButton(oneBy(rec.last(), 'data-region', 'transfer'), { 'data-action': 'import-preview' });
      await rec.take();
      findOne(
        rec.last(),
        (node) => node.type === 'button' && node.props['data-action'] === 'import-apply',
        'apply button',
      ).props.onClick();
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'transfer: an applied import states what it wrote',
    marks: [
      ['data-region', 'transfer'],
      ['data-transfer-phase', 'applied'],
      ['data-notice', 'success'],
    ],
    copy: ['importHeading', ['importAppliedNotice', { written: 1, count: 2 }]],
    async run() {
      const applied = importPlanFixture({
        dryRun: false,
        applied: true,
        written: ['/home/u/.dsh/prompt-setting/overrides.json'],
      });
      const page = enPage({
        responses: defaultResponses({
          [PATHS.import]: (url) => ({ payload: url.includes('dryRun=true') ? importPlanFixture() : applied }),
        }),
      });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'history');
      await rec.take();
      typeInto(rec.last(), 'import-text', exportDocument());
      await rec.take();
      clickButton(oneBy(rec.last(), 'data-region', 'transfer'), { 'data-action': 'import-preview' });
      await rec.take();
      findOne(
        rec.last(),
        (node) => node.type === 'button' && node.props['data-action'] === 'import-apply',
        'apply button',
      ).props.onClick();
      await rec.take();
      clickButton(oneBy(rec.last(), 'data-region', 'confirm'), { 'data-action': 'confirm-yes' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'transfer: an export writes a file and keeps a copyable document',
    marks: [
      ['data-region', 'transfer'],
      ['data-export-name', 'dsh-prompt-setting-2024-01-02T10-00-00-000.json'],
      ['data-notice', 'success'],
    ],
    copy: ['exportButton', ['downloadDone', { name: 'dsh-prompt-setting-2024-01-02T10-00-00-000.json' }], 'exportPreviewLabel'],
    async run() {
      const page = enPage({ useSessions: sessionsHook(SESSIONS_STATE), responses: defaultResponses() });
      installDownloader(page);
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'history');
      await rec.take();
      clickButton(oneBy(rec.last(), 'data-region', 'transfer'), { 'data-action': 'export' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'transfer: an export with no download surface states why',
    marks: [
      ['data-region', 'transfer'],
      ['data-transfer-phase', 'error'],
      ['data-error-code', 'download-failed'],
    ],
    copy: [['downloadFailed', { reason: 'no document' }]],
    async run() {
      const page = enPage({ responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'history');
      await rec.take();
      clickButton(oneBy(rec.last(), 'data-region', 'transfer'), { 'data-action': 'export' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'advanced: a whole layer reset confirms first',
    marks: [
      ['data-region', 'confirm'],
      ['data-confirm-kind', 'reset-layer'],
      ['data-region', 'status-detail'],
    ],
    copy: [['resetLayerTitle', { layer: 'user layer' }], 'resetIrreversible', 'confirmYes', 'resetLayersLabel'],
    async run() {
      const page = enPage({ responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'advanced');
      await rec.take();
      clickButton(oneBy(rec.last(), 'data-region', 'layer-reset'), { 'data-action': 'reset-layer', 'data-layer': 'user' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'mine: the unconfigured panel, then a dirty edit, then the saved state',
    marks: [
      ['data-region', 'mine'],
      ['data-region', 'mine-layer'],
      ['data-mine-state', 'unconfigured'],
      ['data-mine-state', 'dirty'],
      ['data-mine-state', 'saved'],
      ['data-mine-effect', 'next-turn'],
      ['data-active-tab', 'mine'],
    ],
    copy: ['tabMine', 'mineHeading', 'mineNote', 'mineTextLabel', 'mineSave', 'mineReset', 'mineUnconfigured', 'mineDirty', ['mineSaved', { layer: 'user layer' }]],
    async run() {
      const page = enPage({ responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      typeInto(rec.last(), 'mine-text', 'my own house rules');
      await rec.take();
      clickButton(rec.last(), { 'data-action': 'mine-save' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'mine: a stored value, a failed write and its full error card',
    marks: [
      ['data-region', 'mine'],
      ['data-mine-state', 'error'],
      ['data-error-code', 'write-locked'],
      ['data-notice', 'error'],
    ],
    copy: ['mineFailed', 'error.write-locked', 'errCode', 'errDetail', ['mineLoaded', { layer: 'user layer' }]],
    async run() {
      const page = enPage({
        responses: defaultResponses({
          [PATHS.overrides]: (url, init) =>
            init && init.method === 'PUT'
              ? { status: 403, payload: { ok: false, code: 'write-locked', message: 'only the reserved section may be written' } }
              : {
                  payload: overridesFixture({
                    merged: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'stored text', layer: 'user' }] },
                  }),
                },
        }),
      });
      const rec = recorder(page);
      await rec.take();
      clickButton(rec.last(), { 'data-action': 'mine-save' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'mine: the workspace layer without a session is refused, and says why',
    marks: [
      ['data-region', 'mine'],
      ['data-warning', 'mine-workspace-disabled'],
      ['data-mine-state', 'error'],
      ['data-error-code', 'workspace-unresolved'],
    ],
    copy: ['mineWorkspaceNeedsSession', 'error.workspace-unresolved', 'ovWorkspaceDisabled'],
    async run() {
      const page = enPage({ responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      clickTab(rec.last(), 'mine-layer', 'workspace');
      await rec.take();
      clickButton(rec.last(), { 'data-action': 'mine-save' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'mine: a frozen scope states that the text will not take effect',
    marks: [
      ['data-region', 'mine'],
      ['data-warning', 'mine-frozen'],
      ['data-mine-frozen', 'true'],
      ['data-mine-frozen-certainty', 'certain'],
      ['data-mine-frozen-body', 'true'],
      ['data-mine-frozen-fix', 'true'],
      ['data-mine-effect', 'none'],
      ['data-frozen-state', 'frozen'],
    ],
    copy: ['mineFrozenWarn', 'stReason', 'stFrozenSession', 'mineFrozenHowTo', ['mineFrozenBody', { layer: 'user layer' }]],
    async run() {
      const page = enPage({
        responses: defaultResponses({
          [PATHS.snapshot]: {
            payload: snapshotFixture({
              frozenScope: 'session',
              frozen: true,
              frozenReason: 'the scope collapsed to its complete section',
            }),
          },
        }),
      });
      const rec = recorder(page);
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'mine: a frozen save is stored and still refused the success wording',
    marks: [
      ['data-region', 'mine'],
      ['data-warning', 'mine-frozen'],
      ['data-mine-state', 'saved'],
      ['data-mine-effect', 'none'],
      ['data-notice', 'success'],
    ],
    copy: [['mineSavedFrozen', { layer: 'user layer' }], ['savedNoticeFrozen', { layer: 'user layer' }]],
    async run() {
      const page = enPage({
        responses: defaultResponses({
          [PATHS.snapshot]: {
            payload: snapshotFixture({
              frozenScope: 'session',
              frozen: true,
              frozenReason: 'the scope collapsed to its complete section',
            }),
          },
        }),
      });
      const rec = recorder(page);
      await rec.take();
      typeInto(rec.last(), 'mine-text', 'frozen rules');
      await rec.take();
      clickButton(rec.last(), { 'data-action': 'mine-save' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'mine: a global freeze with a session stays unknown, in the panel too',
    marks: [
      ['data-region', 'mine'],
      ['data-warning', 'mine-frozen'],
      ['data-mine-frozen', 'true'],
      ['data-mine-frozen-certainty', 'unknown'],
      ['data-mine-effect', 'unknown'],
      ['data-mine-state', 'saved'],
      ['data-frozen-state', 'unknown'],
    ],
    copy: [
      'mineFrozenUnknownWarn',
      'mineFrozenHowTo',
      ['mineFrozenUnknownBody', { layer: 'user layer' }],
      ['mineSavedUnknown', { layer: 'user layer' }],
      ['savedNoticeUnknown', { layer: 'user layer' }],
    ],
    async run() {
      const page = enPage({
        useSessions: sessionsHook(SESSIONS_STATE),
        responses: defaultResponses({
          [PATHS.snapshot]: {
            payload: snapshotFixture({
              frozenScope: 'global',
              frozen: true,
              frozenScopeReason: 'session "s2" has no active agent, so this verdict describes the unscoped assembly',
            }),
          },
        }),
      });
      const rec = recorder(page);
      await rec.take();
      typeInto(rec.last(), 'mine-text', 'unknown rules');
      await rec.take();
      clickButton(rec.last(), { 'data-action': 'mine-save' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'mine: 「恢复默认」 renders its confirmation before deleting',
    marks: [
      ['data-region', 'confirm'],
      ['data-confirm-kind', 'mine-reset'],
    ],
    copy: [['mineResetTitle', { layer: 'user layer' }], 'mineResetBody', 'resetIrreversible', 'confirmYes'],
    async run() {
      const page = enPage({
        responses: defaultResponses({
          [PATHS.overrides]: {
            payload: overridesFixture({
              merged: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'stored text', layer: 'user' }] },
            }),
          },
        }),
      });
      const rec = recorder(page);
      await rec.take();
      clickButton(rec.last(), { 'data-action': 'mine-reset' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'overview: the read-only list offers copy and expand, and no write entry',
    marks: [
      ['data-region', 'overview'],
      ['data-region', 'sections'],
      ['data-note', 'reserved-own-tab'],
      ['data-active-tab', 'overview'],
    ],
    copy: ['copy', 'overviewReservedNote', 'expand', 'viewSections'],
    async run() {
      const page = enPage({ responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'overview');
      await rec.take();
      clickButton(rec.last(), { 'data-action': 'expand', 'data-section-name': 'harness:identity' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'overview: the section status markers, and the ineffective diagnosis',
    marks: [
      ['data-region', 'overview'],
      ['data-section-ineffective', 'name-already-present'],
      ['data-warning', 'edit-disabled'],
    ],
    copy: ['ovEffective', 'stAppended', 'stHidden', 'ovReason', 'ovFixHint', 'blockAppendExisting', 'editDisabledOverridable'],
    async run() {
      const payload = snapshotFixture();
      payload.effective.sections[0].applied = false;
      payload.effective.sections[0].overridable = false;
      payload.effective.sections[0].overrideLayer = 'user';
      payload.effective.sections[0].action = 'append';
      payload.effective.sections[0].reason = 'the appended text was replaced further down the assembly pipeline';
      payload.effective.sections[1].action = 'replace';
      payload.effective.sections[2].action = 'append';
      payload.effective.sections[3].action = 'hide';
      // A second row states the gate without a host reason, so the gate's own
      // copy is on screen too.
      payload.effective.sections[3].overridable = false;
      payload.effective.sections[3].reason = null;
      const page = enPage({ responses: defaultResponses({ [PATHS.snapshot]: { payload } }) });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'overview');
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'advanced: the legacy list, both destructive buttons and the status detail',
    marks: [
      ['data-region', 'advanced'],
      ['data-region', 'overrides'],
      ['data-region', 'layer-reset'],
      ['data-region', 'advanced-layer'],
      ['data-region', 'status-detail'],
      ['data-region', 'build'],
      ['data-region', 'renderer-info'],
      ['data-active-tab', 'advanced'],
    ],
    copy: ['ovHeading', 'ovMergedNote', 'advReadOnlyNote', 'advReservedTag', 'resetLayersLabel', 'resetLegacyButton', 'resetLayerUser', 'stateHeading'],
    async run() {
      const page = enPage({
        responses: defaultResponses({
          [PATHS.overrides]: {
            payload: overridesFixture({
              merged: {
                overrides: [
                  { name: 'project:alpha', action: 'replace', text: 'alpha overridden', layer: 'user' },
                  { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'stored text', layer: 'user' },
                ],
              },
            }),
          },
        }),
      });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'advanced');
      await rec.take();
      clickTab(rec.last(), 'advanced-layer', 'workspace');
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'advanced: 「清除全部覆盖」 renders a confirmation that keeps 「我的 Prompt」',
    marks: [
      ['data-region', 'confirm'],
      ['data-confirm-kind', 'legacy-clear'],
    ],
    copy: [['resetLegacyTitle', { layer: 'user layer' }], ['resetLegacyBody', { layer: 'user layer', count: 1 }], 'resetIrreversible', 'confirmYes'],
    async run() {
      const page = enPage({
        responses: defaultResponses({
          [PATHS.overrides]: {
            payload: overridesFixture({
              user: {
                layer: 'user',
                enabled: true,
                path: '/p',
                reason: null,
                overrides: [
                  { name: 'project:alpha', action: 'replace', text: 'alpha overridden' },
                  { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'stored text' },
                ],
              },
            }),
          },
        }),
      });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'advanced');
      await rec.take();
      clickButton(oneBy(rec.last(), 'data-region', 'layer-reset'), { 'data-action': 'legacy-clear', 'data-layer': 'user' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'advanced: a legacy clear with nothing frozen still states that 「我的 Prompt」 is kept',
    marks: [
      ['data-region', 'confirm'],
      ['data-confirm-kind', 'legacy-clear'],
      ['data-reset-frozen-count', '0'],
      ['data-reset-reserved-count', '1'],
    ],
    copy: [['resetLegacyEmpty', { layer: 'user layer' }], 'resetIrreversible'],
    async run() {
      const page = enPage({
        responses: defaultResponses({
          [PATHS.overrides]: {
            payload: overridesFixture({
              user: {
                layer: 'user',
                enabled: true,
                path: '/p',
                reason: null,
                overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'stored text' }],
              },
            }),
          },
        }),
      });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'advanced');
      await rec.take();
      clickButton(oneBy(rec.last(), 'data-region', 'layer-reset'), { 'data-action': 'legacy-clear', 'data-layer': 'user' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'status card: the build stamp in all three verdicts',
    marks: [
      ['data-region', 'build'],
      ['data-build-match', 'true'],
      ['data-build-match', 'false'],
      ['data-build-match', 'unknown'],
      ['data-warning', 'client-build-stale'],
      ['data-warning', 'client-build-unknown'],
    ],
    copy: ['stBuild', 'stBuildSame', 'stBuildStale', 'stBuildStaleHint', 'stBuildUnknown', 'stBuildUnknownHint', 'stBuildPingFailedHint', 'stateHeading', 'stBuildSelf', 'stBuildServer'],
    async run() {
      const oracle = independentBuildFingerprint(clientSource);
      const same = enPage({
        responses: defaultResponses({ [PATHS.ping]: pingResponse(buildFixture(oracle.hash, oracle.size)) }),
      });
      const sameRec = recorder(same);
      await sameRec.take();

      const edited = `${clientSource.slice(0, clientSource.indexOf('/* @build-fingerprint:begin */') + 40)}x${clientSource.slice(
        clientSource.indexOf('/* @build-fingerprint:begin */') + 41,
      )}`;
      const other = independentBuildFingerprint(edited);
      const stale = enPage({
        responses: defaultResponses({ [PATHS.ping]: pingResponse(buildFixture(other.hash, other.size)) }),
      });
      const staleRec = recorder(stale);
      await staleRec.take();

      const older = enPage({
        responses: defaultResponses({
          [PATHS.ping]: { payload: { ok: true, plugin: 'dsh-prompt-setting', version: '0.0.1' } },
        }),
      });
      const olderRec = recorder(older);
      await olderRec.take();

      const failed = enPage({ responses: defaultResponses({ [PATHS.ping]: new Error('Failed to fetch') }) });
      const failedRec = recorder(failed);
      await failedRec.take();

      return [
        ...(await advancedTrees(sameRec)),
        ...(await advancedTrees(staleRec)),
        ...(await advancedTrees(olderRec)),
        ...(await advancedTrees(failedRec)),
      ];
    },
  },
  {
    name: 'status card: the frozen scope in all three verdicts',
    marks: [
      ['data-frozen-state', 'unfrozen'],
      ['data-frozen-state', 'frozen'],
      ['data-frozen-state', 'unknown'],
      ['data-warning', 'frozen'],
      ['data-warning', 'frozen-unknown'],
    ],
    copy: ['stUnfrozenGlobal', 'stFrozenSession', 'stFrozenUnknown', 'stReason'],
    async run() {
      const global = enPage({ responses: defaultResponses() });
      const globalRec = recorder(global);
      await globalRec.take();

      const frozen = enPage({
        useSessions: sessionsHook(SESSIONS_STATE),
        responses: defaultResponses({
          [PATHS.snapshot]: {
            payload: snapshotFixture({
              frozenScope: 'session',
              frozen: true,
              frozenReason: 'the scope collapsed to its complete section',
            }),
          },
        }),
      });
      const frozenRec = recorder(frozen);
      await frozenRec.take();

      const unknown = enPage({
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
      const unknownRec = recorder(unknown);
      await unknownRec.take();

      return [
        ...(await advancedTrees(globalRec)),
        ...(await advancedTrees(frozenRec)),
        ...(await advancedTrees(unknownRec)),
      ];
    },
  },
  {
    name: 'status card: an unmounted assembly and a degraded session seat',
    marks: [
      ['data-warning', 'not-mounted'],
      ['data-warning', 'session-degraded'],
      ['data-region', 'session'],
    ],
    copy: ['stMountedOff', 'sessionLimit', 'sessionManualPlaceholder', 'sessionApply', 'sessionGlobal'],
    async run() {
      const unmounted = enPage({
        scopeOpen: true,
        responses: defaultResponses({ [PATHS.snapshot]: { payload: snapshotFixture({ mounted: false }) } }),
      });
      const unmountedRec = recorder(unmounted);
      await unmountedRec.take();

      const manual = enPage({ scopeOpen: true, responses: defaultResponses() });
      const manualRec = recorder(manual);
      await manualRec.take();

      return [...(await advancedTrees(unmountedRec)), ...manualRec.trees];
    },
  },
  {
    name: 'error banners: every named rejection code, kept next to the host message',
    marks: [
      ['data-error-code', 'not-found'],
      ['data-error-code', 'workspace-unresolved'],
      ['data-error-code', 'assemble-failed'],
    ],
    copy: ['error.not-found', 'error.workspace-unresolved', 'error.assemble-failed', 'loadFailed', 'errCode', 'errDetail'],
    async run() {
      const trees = [];
      for (const [code, status] of [
        ['not-found', 404],
        ['workspace-unresolved', 400],
        ['assemble-failed', 503],
      ]) {
        const page = enPage({
          responses: defaultResponses({
            [PATHS.snapshot]: { status, payload: { ok: false, code, message: `server says ${code}` } },
          }),
        });
        const rec = recorder(page);
        await rec.take();
        trees.push(...rec.trees);
      }
      return trees;
    },
  },
  {
    name: 'error banners: an unreachable host is the transport error, not a blank',
    marks: [
      ['data-render-state', 'ok'],
      ['data-region', 'status'],
    ],
    copy: ['errNetwork', 'loadFailed'],
    async run() {
      const page = enPage({
        responses: defaultResponses({
          [PATHS.snapshot]: new Error('Failed to fetch'),
          [PATHS.overrides]: new Error('Failed to fetch'),
        }),
      });
      const rec = recorder(page);
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'scope summary: the「查看范围」block ships collapsed, with no picker body',
    marks: [
      ['data-region', 'scope-summary'],
      ['data-scope-open', 'false'],
      ['data-action', 'scope-toggle'],
      ['data-renderer', 'fallback'],
    ],
    copy: ['sessionHeading', 'scopeEdit', 'scopeSummaryFlat', ['sessionCurrentLabel', { label: 'Alpha three' }]],
    async run() {
      const page = enPage({ useSessions: sessionsHook(WORKSPACE_SESSIONS), responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'session selector: the workspace tree, its archived note and its search hint',
    marks: [
      ['data-region', 'session-tree'],
      ['data-region', 'session'],
      ['data-warning', 'scope-archived-hidden'],
      ['data-session-mode', 'sessions'],
    ],
    copy: ['sessionHeading', 'sessionSearch', 'scopeSearchHint', 'sessionKeyboardHint'],
    async run() {
      const page = enPage({
        scopeOpen: true,
        useSessions: sessionsHook(WORKSPACE_SESSIONS),
        useWorkspaces: workspacesHook(workspacesFixture()),
        responses: defaultResponses(),
      });
      const rec = recorder(page);
      await rec.take();
      typeInto(rec.last(), 'session-search', 'zzz-no-match');
      await rec.take();
      const noMatch = enPage({
        scopeOpen: true,
        useSessions: sessionsHook(WORKSPACE_SESSIONS),
        useWorkspaces: workspacesHook(workspacesFixture()),
        responses: defaultResponses(),
      });
      const noMatchRec = recorder(noMatch);
      await noMatchRec.take();
      typeInto(noMatchRec.last(), 'session-search', 'zzz-no-match');
      await noMatchRec.take();
      return [...rec.trees, ...noMatchRec.trees];
    },
  },
  {
    name: 'session selector: the flat fallback says it is degraded',
    marks: [
      ['data-region', 'session-list'],
      ['data-warning', 'scope-degraded'],
      ['data-session-mode', 'sessions'],
    ],
    copy: ['scopeDegraded', 'sessionSearch', 'sessionKeyboardHint'],
    async run() {
      const page = enPage({
        scopeOpen: true,
        useSessions: sessionsHook(FILTER_SESSIONS),
        responses: defaultResponses(),
      });
      const rec = recorder(page);
      await rec.take();
      typeInto(rec.last(), 'session-search', 'nothing matches this');
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'session selector: a catalog over both render caps warns instead of spreading',
    marks: [
      ['data-warning', 'scope-truncated'],
      ['data-warning', 'scope-groups-truncated'],
      ['data-region', 'session-tree'],
    ],
    copy: [['scopeTruncated', { n: 100 }], 'scopeGroupsTruncated'],
    async run() {
      // Every group open at once is what exhausts the shared row budget: the
      // default walk (one open group) can never reach the cap.
      const wideState = manyWorkspaceSessions(20, 100);
      const wide = enPage({
        scopeOpen: true,
        useSessions: sessionsHook(wideState.sessions),
        useWorkspaces: workspacesHook(wideState.workspaces),
        responses: defaultResponses(),
      });
      const wideRec = recorder(wide);
      await wideRec.take();
      typeInto(wideRec.last(), 'session-search', 'Session');
      await wideRec.take();

      const grouped = enPage({
        scopeOpen: true,
        useSessions: sessionsHook(manyWorkspaceSessions(45, 1).sessions),
        useWorkspaces: workspacesHook(manyWorkspaceSessions(45, 1).workspaces),
        responses: defaultResponses(),
      });
      const groupedRec = recorder(grouped);
      await groupedRec.take();

      return [...wideRec.trees, ...groupedRec.trees];
    },
  },
  {
    name: 'the primitives renderer draws the same copy through the official atoms',
    marks: [
      ['data-renderer', 'primitives'],
      ['data-region', 'sections'],
      ['data-region', 'full'],
      ['data-region', 'overrides'],
      ['data-region', 'history-diff'],
      ['data-diff-block', 'primitives'],
      ['data-tab-group', 'main'],
    ],
    copy: ['title', 'viewFull', 'ovHeading', 'histDiffHeading'],
    async run() {
      const page = enPage({ primitives: 'ok', responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      // The official SegmentedTabs double labels every group 'primitives', so
      // the tabs are picked by value alone in this branch.
      clickAnyTab(rec.last(), 'overview');
      await rec.take();
      clickAnyTab(rec.last(), 'full');
      await rec.take();
      clickAnyTab(rec.last(), 'advanced');
      await rec.take();
      clickAnyTab(rec.last(), 'history');
      await rec.take();
      clickButton(historyRowOf(rec.last(), '2'), { 'data-action': 'diff-from', 'data-history-id': '2' });
      await rec.take();
      clickButton(historyRowOf(rec.last(), '1'), { 'data-action': 'diff-to', 'data-history-id': '1' });
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'the render-failure card falls back to readable copy, never a blank',
    marks: [['data-render-state', 'error'], ['data-renderer', 'fallback']],
    raw: ['render failure', 'Error'],
    async run() {
      const { module, runtime } = loadClient('throw');
      const { registrations } = mountClient(module);
      const props = {
        // A translator that explodes: `t` is the broken thing here.
        t: () => {
          throw new Error('translator exploded');
        },
        ...registrations[0].options.inject(),
      };
      return [expandTree(runtime.render(registrations[0].component, props).tree)];
    },
  },
];

/**
 * The `data-*` markers the sweep must have rendered. It is the machine-checked
 * half of "the sweep really walked these branches": a case that renders nothing
 * can never satisfy its own `marks`, and this list fails if a case is dropped.
 */
const EN_REQUIRED_MARKERS = [
  // g-015: the four first-level tabs and the surfaces they own.
  'data-region=tabs',
  'data-region=tab-panel',
  'data-active-tab=mine',
  'data-active-tab=overview',
  'data-active-tab=history',
  'data-active-tab=advanced',
  'data-region=mine',
  'data-region=mine-layer',
  'data-region=overview',
  'data-region=advanced',
  'data-region=advanced-layer',
  'data-region=status',
  'data-region=status-detail',
  'data-region=renderer-info',
  'data-region=sections',
  'data-region=filters',
  'data-region=full',
  'data-region=diff',
  'data-region=overrides',
  'data-region=history-tab',
  'data-region=history',
  'data-region=history-diff',
  'data-region=transfer',
  'data-region=layer-reset',
  'data-region=confirm',
  'data-region=session',
  'data-region=session-tree',
  'data-region=session-list',
  // g-016: the collapsed summary and both states of its「更改」switch.
  'data-region=scope-summary',
  'data-scope-open=false',
  'data-scope-open=true',
  'data-action=scope-toggle',
  'data-role=scope-summary-label',
  'data-role=scope-summary-hint',
  'data-region=build',
  'data-renderer=fallback',
  'data-renderer=primitives',
  'data-diff-block=primitives',
  // 「我的 Prompt」: every state the panel can be in, and both confirmations.
  'data-mine-state=unconfigured',
  'data-mine-state=dirty',
  'data-mine-state=saved',
  'data-mine-state=error',
  'data-mine-error=true',
  'data-warning=mine-frozen',
  // g-021: the frozen block's own markers, and the effect marker that keeps
  // "saved" from being read as "effective".
  'data-mine-frozen=true',
  'data-mine-frozen-body=true',
  'data-mine-frozen-fix=true',
  'data-mine-frozen-certainty=certain',
  'data-mine-frozen-certainty=unknown',
  'data-mine-effect=none',
  'data-mine-effect=unknown',
  'data-mine-effect=next-turn',
  'data-warning=mine-workspace-disabled',
  'data-confirm-kind=mine-reset',
  'data-confirm-kind=legacy-clear',
  'data-confirm-kind=reset-layer',
  'data-note=reserved-own-tab',
  'data-note=overrides-read-only',
  'data-override-reserved=true',
  'data-reset-frozen-count=1',
  // 提示词总览 is read-only, and says what it diagnoses.
  'data-section-ineffective=name-already-present',
  'data-warning=edit-disabled',
  'data-empty=sections',
  'data-empty=overrides',
  'data-build-match=true',
  'data-build-match=false',
  'data-build-match=unknown',
  'data-frozen-state=unfrozen',
  'data-frozen-state=frozen',
  'data-frozen-state=unknown',
  'data-error-code=not-found',
  'data-error-code=workspace-unresolved',
  'data-error-code=assemble-failed',
  'data-error-code=write-locked',
  'data-phase=empty',
  'data-phase=loading',
  'data-warning=client-build-stale',
  'data-warning=client-build-unknown',
  'data-warning=frozen',
  'data-warning=frozen-unknown',
  'data-warning=not-mounted',
  'data-warning=rendered-unresolved',
  'data-warning=scope-degraded',
  'data-warning=scope-archived-hidden',
  'data-warning=scope-truncated',
  'data-warning=scope-groups-truncated',
  'data-warning=session-degraded',
  'data-warning=session-no-match',
  'data-warning=full-filtered',
  'data-warning=truncated',
  'data-import-plan=true',
  'data-diff-row=project:alpha',
  'data-hd-row=project:alpha',
  'data-render-state=error',
];


// #endregion

test('client: the english render sweep shows no CJK and no bare key, in any branch', async () => {
  const problems = [];
  const observed = new Set();
  let stringsSwept = 0;

  for (const testCase of EN_SWEEP_CASES) {
    const trees = await testCase.run();
    assert.ok(trees.length > 0, `${testCase.name}: the case drew at least one tree`);

    // Every tree the case drew counts: a case that walks several states asserts
    // each marker somewhere in that walk, and every tree is swept for leaks.
    const caseMarkers = new Set();
    const caseStrings = [];
    for (const tree of trees) {
      stringsSwept += stringsByMarker(tree).length;
      for (const problem of englishProblems(tree)) {
        problems.push({ case: testCase.name, ...problem });
      }
      for (const marker of dataMarkers(tree)) {
        caseMarkers.add(marker);
        observed.add(marker);
      }
      for (const entry of stringsByMarker(tree)) caseStrings.push(entry.text);
    }

    for (const [attribute, value] of testCase.marks || []) {
      if (!caseMarkers.has(`${attribute}=${value}`)) {
        problems.push({ case: testCase.name, kind: 'missing-branch', key: `${attribute}=${value}` });
      }
    }
    for (const entry of testCase.copy || []) {
      const [key, params] = Array.isArray(entry) ? entry : [entry, null];
      const template = EN_TABLE[key];
      const expected = params === null ? template : fillText(template, params);
      if (typeof template !== 'string' || expected.trim() === '') {
        problems.push({ case: testCase.name, kind: 'unknown-copy-key', key });
      } else if (!caseStrings.some((text) => text.includes(expected))) {
        problems.push({ case: testCase.name, kind: 'missing-copy', key, expected });
      }
    }
    for (const literal of testCase.raw || []) {
      if (!caseStrings.some((text) => text.includes(literal))) {
        problems.push({ case: testCase.name, kind: 'missing-literal', key: literal });
      }
    }
  }

  // Hand the observed markers to the coverage test even when a sweep assertion
  // below fails, so the two assertions stay independently readable.
  observedMarkers = observed;

  // The sweep guards the table itself too: a key missing from `en` renders as
  // its own identifier, and a key blanked to `''` renders as nothing at all —
  // neither is CJK, so neither would be caught by the checks above.
  const brokenTable = Object.keys(SWEEP_TABLES.zh).filter((key) => {
    const value = EN_TABLE[key];
    return typeof value !== 'string' || value.trim() === '' || value === key;
  });
  assert.deepEqual(brokenTable, [], 'every en key must carry its own non-empty copy');

  // Not vacuous: the sweep really rendered a lot of localized text.
  assert.ok(stringsSwept > 2000, `the sweep swept ${stringsSwept} rendered strings`);
  assert.deepEqual(problems, []);
});

test('client: the english sweep really walked every required branch marker', () => {
  const missing = EN_REQUIRED_MARKERS.filter((marker) => !observedMarkers.has(marker));
  assert.deepEqual(missing, [], 'the sweep must render every branch it claims to cover');
});

test('client: the packaged file list still excludes the tests', () => {
  assert.ok(packageJson.files.includes('client.js'));
  assert.ok(!packageJson.files.includes('test'));
});


// ---------------------------------------------------------------------------
// Revision 9 (g-026): the variable-substitution switch on「我的 Prompt」.
//
// The panel half of the feature is copy-heavy by design — the switch changes
// what a text box MEANS, and the one thing the user can no longer do (write a
// literal `{{...}}`) has to be on screen next to the state, not in a document
// nobody opens. The assertions below therefore check the machine-readable state
// AND the consequence text, and they check that the state comes back from the
// host rather than from local optimism.
// ---------------------------------------------------------------------------

/** A snapshot fixture with the switch in a given state. */
function withSwitch(snapshot, interpolate) {
  return { ...snapshot, layers: { ...snapshot.layers, interpolate } };
}

/** Every rendered string of one tree, as one blob. */
function renderedStrings(tree) {
  return stringsByMarker(tree).map((entry) => entry.text).join('\n');
}

test('g-026 client: the panel carries the switch, its state and its consequence', async () => {
  const page = enPage({ responses: defaultResponses() });
  const rec = recorder(page);
  await rec.take();
  const tree = rec.last();

  const region = oneBy(tree, 'data-region', 'mine-interpolate');
  assert.equal(region.props['data-mine-interpolate'], 'off');
  assert.equal(oneBy(tree, 'data-mine-interpolate-state', 'off').props.children, 'OFF');
  assert.match(
    oneBy(tree, 'data-mine-interpolate-stated', 'inherit').props.children,
    /inherits the user layer/,
    'a layer that states nothing must be distinguishable from one that states OFF',
  );

  const toggle = oneBy(tree, 'data-action', 'mine-interpolate');
  assert.equal(toggle.props['aria-pressed'], 'false');
  assert.equal(toggle.props['data-mine-interpolate-layer'], 'user');
  assert.equal(toggle.props.disabled, false);
  assert.equal(toggle.props.children, 'Turn variable substitution on');

  // The consequence is stated where the state is: no escape syntax, so no
  // literal `{{...}}` any more.
  const strings = renderedStrings(tree);
  assert.match(strings, /no escape syntax/i);
  assert.match(strings, /literal \{\{\.\.\.\}\}/i);
  assert.match(strings, /the current model/);
  assert.match(strings, /saved per selected layer/, 'and how the value is scoped');
});

test('g-026 client: when the host says ON the panel says ON and offers the way back', async () => {
  const page = enPage({
    responses: defaultResponses({
      [PATHS.snapshot]: { payload: withSwitch(snapshotFixture(), { effective: true, user: true, workspace: null }) },
    }),
  });
  const rec = recorder(page);
  await rec.take();
  const tree = rec.last();

  assert.equal(oneBy(tree, 'data-region', 'mine-interpolate').props['data-mine-interpolate'], 'on');
  assert.equal(oneBy(tree, 'data-mine-interpolate-state', 'on').props.children, 'ON');
  const toggle = oneBy(tree, 'data-action', 'mine-interpolate');
  assert.equal(toggle.props['aria-pressed'], 'true');
  assert.equal(toggle.props.children, 'Turn variable substitution off');
  assert.match(oneBy(tree, 'data-mine-interpolate-stated', 'true').props.children, /states ON explicitly/);
});

test('g-026 client: clicking the switch writes it to the selected layer and re-reads the host state', async () => {
  const page = enPage({ responses: defaultResponses() });
  const rec = recorder(page);
  await rec.take();
  const before = urlsFor(page, PATHS.snapshot).length;

  clickButton(rec.last(), { 'data-action': 'mine-interpolate' });
  await rec.take();

  const calls = page.router.calls.filter((call) => call.url.startsWith(PATHS.interpolate));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].init.body), { enabled: true, layer: 'user' });
  // The state is the host's answer, so the snapshot is re-read instead of the
  // button flipping itself optimistically.
  assert.equal(urlsFor(page, PATHS.snapshot).length > before, true);
  assert.equal(rec.last() !== null, true);
});

test('g-026 client: a refused switch keeps the host code and message, and the state does not move', async () => {
  const page = enPage({
    responses: defaultResponses({
      [PATHS.interpolate]: {
        status: 400,
        ok: false,
        payload: { ok: false, code: 'unresolvable-variable', message: 'the user layer contains 1 prompt reference(s) that would throw' },
      },
    }),
  });
  const rec = recorder(page);
  await rec.take();
  clickButton(rec.last(), { 'data-action': 'mine-interpolate' });
  await rec.take();
  const tree = rec.last();

  oneBy(tree, 'data-mine-interpolate-error', 'true');
  const strings = renderedStrings(tree);
  assert.match(strings, /unresolvable-variable/, 'the host code is on screen');
  assert.match(strings, /would throw/, 'and so is the host message');
  // Nothing moved: the button still offers to turn it on.
  assert.equal(oneBy(tree, 'data-action', 'mine-interpolate').props.children, 'Turn variable substitution on');
});

test('g-026 client: the workspace layer needs a session before its switch can be written', async () => {
  const page = enPage({ responses: defaultResponses() });
  const rec = recorder(page);
  await rec.take();
  clickTab(rec.last(), 'mine-layer', 'workspace');
  await rec.take();
  const tree = rec.last();

  const toggle = oneBy(tree, 'data-action', 'mine-interpolate');
  assert.equal(toggle.props['data-mine-interpolate-layer'], 'workspace');
  assert.equal(toggle.props.disabled, true, 'no session ⇒ the workspace layer cannot be written');
  oneBy(tree, 'data-warning', 'mine-interpolate-locked');
  assert.match(renderedStrings(tree), /workspace layer needs a selected session/i);
  // And a click does not even reach the transport.
  const before = page.router.calls.filter((call) => call.url.startsWith(PATHS.interpolate)).length;
  assert.equal(before, 0);
});

// ---------------------------------------------------------------------------
// Revision 12 (g-026 att-002): the audit's F2/F4/F5 on the panel.
//
// F4 — the layer needs THREE states, and the inherited-ON case has to be named:
//      with only two, "turn it off" on a layer that states nothing is a click
//      that changes nothing while the session keeps interpolating.
// F2 — the advisories the host returns with an accepted write have to be on
//      screen; a dropped warning is a user who never learns that one turn will
//      fail to assemble.
// F5 — a degraded layer contributes nothing, so the panel says so (and how to
//      recover) where the text box is.
// ---------------------------------------------------------------------------

test('g-026 rev12 client: the layer state control offers inherit/on/off and selects the host one', async () => {
  const page = enPage({
    responses: defaultResponses({
      [PATHS.snapshot]: { payload: withSwitch(snapshotFixture(), { effective: true, user: null, workspace: true }) },
    }),
  });
  const rec = recorder(page);
  await rec.take();
  const tree = rec.last();

  // The user layer states nothing while the effective value is ON: the state the
  // old toggle could not distinguish from OFF.
  const choice = (value) => oneBy(tree, 'data-mine-interpolate-set', value);
  assert.deepEqual(
    ['inherit', 'on', 'off'].map((value) => choice(value).props['data-mine-interpolate-set-active']),
    ['true', 'false', 'false'],
  );
  oneBy(tree, 'data-warning', 'mine-interpolate-inherited');
  assert.match(renderedStrings(tree), /inherits ON/, 'the consequence is spelled out, not implied');
  assert.match(renderedStrings(tree), /writes false/, 'and so is what the third state does');

  // Clicking "off" writes the boolean false — the state the toggle cannot express.
  clickButton(tree, { 'data-action': 'mine-interpolate-state', 'data-mine-interpolate-set': 'off' });
  await rec.take();
  const calls = page.router.calls.filter((call) => call.url.startsWith(PATHS.interpolate));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].init.body), { state: 'off', layer: 'user' });
  // The toggle keeps its two-valued spelling: on→off is still an exact revert.
  const toggle = oneBy(rec.last(), 'data-action', 'mine-interpolate');
  assert.equal(toggle.props['aria-pressed'], 'true');
});

test('g-026 rev12 client: a layer that states OFF is shown as OFF, and the state control can set it back', async () => {
  const page = enPage({
    useSessions: sessionsHook(SESSIONS_STATE),
    responses: defaultResponses({
      [PATHS.snapshot]: { payload: withSwitch(snapshotFixture(), { effective: false, user: true, workspace: false }) },
    }),
  });
  const rec = recorder(page);
  await rec.take();
  clickTab(rec.last(), 'mine-layer', 'workspace');
  await rec.take();
  const tree = rec.last();

  const choice = (value) => oneBy(tree, 'data-mine-interpolate-set', value);
  assert.equal(choice('off').props['data-mine-interpolate-set-active'], 'true');
  assert.equal(choice('inherit').props['data-mine-interpolate-set-active'], 'false');
  assert.equal(choice('inherit').props.disabled, false, 'a session is selected, so the workspace layer is writable');

  clickButton(tree, { 'data-action': 'mine-interpolate-state', 'data-mine-interpolate-set': 'inherit' });
  await rec.take();
  const calls = page.router.calls.filter((call) => call.url.startsWith(PATHS.interpolate));
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), { state: 'inherit', layer: 'workspace', session: 's2' });
});

test('g-026 rev12 client: the advisories of an accepted save are rendered, not dropped', async () => {
  const warned = {
    ...overridesFixture(),
    warnings: [
      { name: 'model', kind: 'undefined-value', code: 'unresolved-at-save', message: 'registered but has no value' },
    ],
  };
  const page = enPage({ responses: defaultResponses({ [PATHS.overrides]: { payload: warned } }) });
  let tree = await page.flush();

  // Nothing is claimed before a write has happened.
  assert.equal(collect(tree, (node) => node.props && node.props['data-mine-warnings'] === 'true').length, 0);

  typeInto(tree, 'mine-text', 'I am {{model}}');
  tree = await page.flush();
  clickButton(tree, { 'data-action': 'mine-save' });
  tree = await page.flush();

  oneBy(tree, 'data-warning', 'mine-warnings');
  oneBy(tree, 'data-mine-warnings-list', 'true');
  const shown = renderedStrings(tree);
  assert.match(shown, /Saved, with references to note/, 'the heading says the save happened');
  assert.match(shown, /reference model/, 'and names the reference');
  // A successful save is still a successful save: the advisory is not an error.
  assert.equal(markerOf(tree, 'data-mine-state'), 'saved');
});

test('g-026 rev12 client: an accepted switch write clears the advisories, and a new draft does too', async () => {
  const warned = {
    ok: true,
    interpolateCustom: true,
    layer: 'user',
    state: 'on',
    saved: { enabled: true, state: 'on' },
    warnings: [{ name: 'model', kind: 'undefined-value', code: 'unresolved-at-save', message: 'no value' }],
    effectiveFrom: 'next-turn',
  };
  const clean = { ...warned, warnings: [] };
  let first = true;
  const page = enPage({
    responses: defaultResponses({
      [PATHS.interpolate]: () => {
        const payload = first ? warned : clean;
        first = false;
        return { payload };
      },
    }),
  });
  const rec = recorder(page);
  await rec.take();

  clickButton(rec.last(), { 'data-action': 'mine-interpolate' });
  await rec.take();
  const withAdvisory = rec.last();
  oneBy(withAdvisory, 'data-warning', 'mine-warnings');

  // A second write that carries none clears them rather than leaving a stale
  // warning on screen for a state it no longer describes.
  clickButton(rec.last(), { 'data-action': 'mine-interpolate' });
  await rec.take();
  assert.equal(
    collect(rec.last(), (node) => node.props && node.props['data-mine-warnings'] === 'true').length,
    0,
    'no advisories ⇒ the block is gone',
  );
});

test('g-026 rev12 client: a degraded layer is named, explained and given a way out (F5)', async () => {
  const reason = 'unresolvable-variable: the user layer (/x/overrides.json) contains 1 prompt reference(s) that would make every assembly of the session throw (`{{nope}}`; unknown). Fix: delete the reference. The layer was disabled so the real assembly keeps working.';
  const page = enPage({
    responses: defaultResponses({
      [PATHS.snapshot]: {
        payload: snapshotFixture({
          layers: {
            ...snapshotFixture().layers,
            user: { enabled: false, path: '/x/overrides.json', reason },
            interpolate: { effective: false, user: null, workspace: null },
          },
        }),
      },
    }),
  });
  const tree = await page.flush();

  oneBy(tree, 'data-warning', 'mine-layer-disabled');
  oneBy(tree, 'data-mine-layer-disabled-reason', 'true');
  oneBy(tree, 'data-mine-layer-disabled-fix', 'true');
  const shown = renderedStrings(tree);
  assert.match(shown, /This layer is disabled/, 'the consequence is stated where the text box is');
  assert.match(shown, /unresolvable-variable/, 'with the host\'s own reason');
  assert.match(shown, /never rewrites your file/, 'and a recovery path that does not invent a rewrite');
});

test('g-026 rev12 client: an unknown state refusal is surfaced with its own copy', async () => {
  const page = enPage({
    responses: defaultResponses({
      [PATHS.interpolate]: {
        status: 400,
        ok: false,
        payload: { ok: false, code: 'invalid-state', message: 'state must be one of inherit, on, off' },
      },
    }),
  });
  const rec = recorder(page);
  await rec.take();
  clickButton(rec.last(), { 'data-action': 'mine-interpolate' });
  await rec.take();
  const tree = rec.last();
  oneBy(tree, 'data-mine-interpolate-error', 'true');
  const shown = renderedStrings(tree);
  assert.match(shown, /inherit, on or off/, 'the copy is prose, never the bare code');
});

test('g-026 rev12 client: a layer disabled for a non-reference reason gets the file-level way out', async () => {
  const page = enPage({
    responses: defaultResponses({
      [PATHS.snapshot]: {
        payload: snapshotFixture({
          layers: {
            ...snapshotFixture().layers,
            user: { enabled: false, path: '/x/overrides.json', reason: 'invalid-json: Unexpected token } in JSON' },
            interpolate: { effective: false, user: null, workspace: null },
          },
        }),
      },
    }),
  });
  const tree = await page.flush();
  oneBy(tree, 'data-warning', 'mine-layer-disabled');
  const shown = renderedStrings(tree);
  assert.match(shown, /invalid-json/, 'the host reason is on screen');
  assert.match(shown, /repair or remove that layer's config file/, 'and the fix matches the cause');
  assert.equal(/unresolvable \{\{\.\.\.\}\} reference/.test(shown), false, 'not the reference fix');
});

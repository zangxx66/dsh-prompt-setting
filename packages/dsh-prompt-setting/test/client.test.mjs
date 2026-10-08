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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { afterEach } from 'node:test';
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
/**
 * The **host** half, read as text (g-029).
 *
 * `index.js` is an ESM module with plugin side effects, so it is not imported
 * here: the one literal this file needs — the version the ping answers with —
 * is parsed out of the source instead, and then compared with `package.json`.
 * That comparison is the point: two copies a human keeps in sync are exactly
 * the copies that drift, so the test reads both files and says so.
 */
const indexSource = readFileSync(join(here, '..', 'index.js'), 'utf8');
const PLUGIN_VERSION_MATCH = indexSource.match(/^const PLUGIN_VERSION = '([^']*)';[ \t]*$/m);
/** `index.js`'s `PLUGIN_VERSION`, or `null` when the declaration is gone. */
const PLUGIN_VERSION = PLUGIN_VERSION_MATCH === null ? null : PLUGIN_VERSION_MATCH[1];
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
  // g-043 download region (CONTRACT.md §17.3/§17.7–§17.10).
  'invalid-region',
  'registry-invalid',
  'registry-unreachable',
  'registry-http-error',
  'registry-not-npm',
  'registry-unavailable',
  // Both preferences routes can answer this one (§17.4, §17.8).
  'preferences-unwritable',
];

/**
 * Minimal hooks runtime: index-addressed cells, effects collected per render.
 * @returns the React double plus render bookkeeping.
 */
function makeHooksRuntime(options = {}) {
  let cells = [];
  let cursor = 0;
  let refCursor = 0;
  let effects = [];
  /**
   * Every `useSyncExternalStore` subscription this render registered, and every
   * notification a store pushed through one (g-045). A case asserts on the
   * notification, not on the count: "the page re-read the snapshot when it
   * happened to re-render" is exactly the bug this seat exists to prevent.
   */
  const externalSubscriptions = [];
  const externalNotifications = [];
  // g-039 fourth round: a `useRef` whose `.current` the case can preset. React
  // assigns a ref's `.current` when it mounts the element; the double renders no
  // real DOM, so a case that wants to exercise a measuring code path hands in the
  // element it wants the ref to hold.
  const presetRefs = Array.isArray(options.refs) ? options.refs : [];
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
      if (!(index in cells)) {
        const preset = presetRefs[refCursor];
        refCursor += 1;
        cells[index] = { current: preset === undefined ? initial : preset };
      }
      return cells[index];
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      cursor += 1;
      // Mirror React's mount behavior: subscribe once, then read the snapshot.
      // This is exactly the path a missing `ctx.locale.subscribe` would break.
      // g-045: the listener is **kept and really registered**, so a case can
      // prove a store notifies its subscribers instead of the page merely
      // re-reading the snapshot on some later render — which is the difference
      // the root's `data-build-*` attributes depend on (NOTES.md §122).
      const listener = () => {
        externalNotifications.push(getSnapshot());
      };
      externalSubscriptions.push({ getSnapshot, listener });
      subscribe(listener);
      return getSnapshot();
    },
    useId: () => 'test-id',
    Fragment: Symbol('Fragment'),
    // g-045: the lazy chunk boundary. `load()` is called on first expansion,
    // exactly as React calls it on first render; the loader double below
    // resolves synchronously, so one expansion is enough to get the real panel —
    // and a chunk that cannot be loaded hands back the page's own readable
    // failure component, which is what the boundary must render instead of a
    // blank tab.
    Suspense: SUSPENSE_TYPE,
    lazy(load) {
      const holder = { component: null, started: false };
      return {
        $$typeof: LAZY_TYPE,
        _resolveNode(props) {
          if (!holder.started) {
            holder.started = true;
            try {
              load().then((moduleObject) => {
                holder.component =
                  moduleObject && typeof moduleObject.default === 'function' ? moduleObject.default : null;
              });
            } catch {
              holder.component = null;
            }
          }
          return typeof holder.component === 'function' ? holder.component(props) : null;
        },
      };
    },
  };
  if (options.withoutReactLazy === true) {
    // g-045 degradation branch: a React without `lazy`/`Suspense` must leave the
    // page rendering (the tab says so) instead of taking the panel down.
    delete React.lazy;
    delete React.Suspense;
  }
  return {
    React,
    externalSubscriptions,
    externalNotifications,
    render(component, props) {
      cursor = 0;
      refCursor = 0;
      effects = [];
      const tree = component(props);
      const pending = effects;
      effects = [];
      return { tree, pending };
    },
  };
}

/**
 * The two element types the lazy chunk boundary produces (g-045).
 *
 * 「版本历史」 is mounted through `React.lazy` inside `React.Suspense`, and this
 * harness expands the tree by hand instead of scheduling a real render, so it
 * has to recognise both. They are module-level markers rather than locals of the
 * hooks double because {@link expandTree} — which walks the tree — needs them.
 */
const LAZY_TYPE = Symbol('react.lazy');
const SUSPENSE_TYPE = Symbol('react.suspense');

/**
 * Expand function components into host nodes.
 *
 * The hooks runtime above calls one component directly; the page's atoms are
 * plain functions, so rendering them here is what lets a test click the real
 * `<button>` the fallback branch produced. Since g-045 a tab panel may also be a
 * **lazy chunk**: the loader double resolves `require.async` synchronously, so
 * the boundary collapses on first expansion instead of suspending.
 * @param node - an element, an array of children, or a leaf.
 * @returns the expanded tree.
 */
function expandTree(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(expandTree);
  if (node.type !== null && typeof node.type === 'object' && node.type.$$typeof === LAZY_TYPE) {
    return expandTree(node.type._resolveNode(node.props));
  }
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
/**
 * Every page this file mounted, so the timers a g-032 poll loop leaves behind
 * are stopped when its case ends. Without this a case that stubs a **running**
 * install would leave a live timer chain behind it, and the test process would
 * never see the event loop drain.
 */
const mountedPages = [];

afterEach(() => {
  for (const page of mountedPages.splice(0)) page.dispose();
});

function loadClient(primitives, options = {}) {
  /**
   * Every registration this sandbox saw, in order (g-045: the main bundle plus
   * one entry per chunk — a bundle may `load()` more than once, and the loader
   * keys chunks by `<id>/<file>`).
   */
  const registrations = [];
  const factoryEntries = new Map();
  /** Module-table id → exports, the way the real loader memoizes a factory. */
  const moduleTable = new Map();
  /** Chunk file name → its materialized exports (each chunk registers once). */
  const chunkModules = new Map();
  /** Every chunk file this page asked for, in request order. */
  const loadedChunkFiles = [];
  /** Chunk file names a case wants to answer with a rejection (g-045). */
  const chunkFailures = new Set(options.chunkFailures || []);
  const runtime = makeHooksRuntime(options);
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          registrations.push(entry);
          factoryEntries.set(entry.chunk === undefined ? entry.id : `${entry.id}/${entry.chunk}`, entry);
        },
      },
    },
    console,
  };
  sandbox.fetch = () => Promise.reject(new Error('fetch not stubbed'));
  // g-045: the page defers its chunk-load notification to a microtask, so the
  // sandbox gets one too — the real path is what the tests should exercise.
  sandbox.queueMicrotask = queueMicrotask;
  // g-032 gives the page a real timer loop (the install poll, and the「已用时」
  // ticker). The sandbox gets the host's own timers with a **floored delay**, so
  // a case that stubs a running install does not spend 1.5 s per poll: the
  // page's behaviour (wait, ask again) is unchanged, only the wait is — and
  // every handle is registered so `page.dispose()` can stop a loop a case no
  // longer needs (a live poll would otherwise outlive the test process).
  const pendingTimers = new Set();
  sandbox.setTimeout = (fn, ms) => {
    const id = setTimeout(fn, Math.min(Number.isFinite(ms) ? ms : 0, 5));
    pendingTimers.add(id);
    return id;
  };
  sandbox.clearTimeout = (id) => {
    pendingTimers.delete(id);
    return clearTimeout(id);
  };
  sandbox.setInterval = (fn, ms) => {
    const id = setInterval(fn, Math.min(Number.isFinite(ms) ? ms : 0, 5));
    pendingTimers.add(id);
    return id;
  };
  sandbox.clearInterval = (id) => {
    pendingTimers.delete(id);
    return clearInterval(id);
  };
  vm.createContext(sandbox);
  vm.runInContext(clientSource, sandbox, { filename: 'client.js' });
  const descriptor = registrations.find((entry) => entry.chunk === undefined);
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
  /**
   * The loader's `require.async('./client.x.js')`, doubled (g-045).
   *
   * It does what the real one does, minus the network: reads the chunk from
   * disk, executes it **in this same sandbox** (so it registers itself and
   * builds its elements on the page's one `React` double) and answers with its
   * exports. The answer is a *synchronous* thenable because this harness expands
   * trees by hand; the page's own loading code is unchanged, and a rejection
   * still reaches it (see `chunkFailures`).
   * @param spec - the relative spec the page asked for (`./client.history.js`).
   * @returns a thenable resolving to the chunk's exports.
   */
  const requireAsync = (spec) => {
    const fileName = String(spec).replace(/^\.\//, '');
    loadedChunkFiles.push(fileName);
    if (chunkFailures.has(fileName)) {
      const failure = new Error(`chunk unavailable: ${fileName}`);
      return {
        then: (onLoaded, onFailed) => (typeof onFailed === 'function' ? onFailed(failure) : undefined),
      };
    }
    if (!chunkModules.has(fileName)) {
      let source;
      try {
        source = readFileSync(join(here, '..', fileName), 'utf8');
      } catch (error) {
        return {
          then: (onLoaded, onFailed) => (typeof onFailed === 'function' ? onFailed(error) : undefined),
        };
      }
      // g-045: a case can hand in the bytes the browser would have received
      // *differently* from the ones on disk — the one way to prove the page
      // compares what it really ran against what the host serves.
      if (typeof options.chunkSourceEdit === 'function') source = options.chunkSourceEdit(fileName, source);
      vm.runInContext(source, sandbox, { filename: fileName });
      const entry = factoryEntries.get(`${packageJson.name}/${fileName}`);
      assert.ok(entry, `${fileName} must register itself as a chunk of ${packageJson.name}`);
      chunkModules.set(fileName, entry.factory(requireFn));
    }
    const chunkExports = chunkModules.get(fileName);
    return { then: (onLoaded) => onLoaded(chunkExports) };
  };
  const requireFn = (name) => {
    if (name === 'react') return runtime.React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      if (primitives === 'throw') throw new Error("Cannot find module '@deepseek-ai/dsh-client-ui-primitives'");
      return primitivesModule;
    }
    // g-045: a chunk's one way back into the main bundle. The real loader
    // resolves the package id out of its module table, where the main factory
    // has already been materialized — hence "no cycle, ever".
    if (name === packageJson.name || name === `${packageJson.name}/client.js`) {
      return moduleTable.get(packageJson.name);
    }
    throw new Error(`unexpected require: ${name}`);
  };
  requireFn.async = requireAsync;
  // g-045 degradation branch: a loader with no chunk path at all (`require.async`
  // missing) must produce the readable card, not a throw.
  if (options.withoutRequireAsync === true) delete requireFn.async;
  const module = descriptor.factory(requireFn);
  moduleTable.set(packageJson.name, module);
  return {
    descriptor,
    module,
    sandbox,
    runtime,
    diffBlockCalls,
    registrations,
    loadedChunkFiles,
    /** Stop every timer this page's sandbox still holds. */
    stopTimers: () => {
      for (const id of pendingTimers) {
        clearTimeout(id);
        clearInterval(id);
      }
      pendingTimers.clear();
    },
  };
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

/**
 * The stamp a reader in **this process's** time zone must see.
 *
 * Derived from the local `Date` getters and `getTimezoneOffset` — a different
 * code path than `client.js`, which asks `Intl` — so an equality assertion
 * tests the claim ("the page shows the reader's zone") instead of mirroring the
 * implementation. Portable by construction: run the suite under any `TZ` and
 * the expectation moves with it.
 * @param iso - the stored UTC ISO value.
 * @returns `YYYY-MM-DD HH:mm:ss GMT±h[:mm]` for the local zone.
 */
function localStampOf(iso) {
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const absolute = Math.abs(offset);
  const zone =
    absolute % 60 === 0
      ? `GMT${sign}${absolute / 60}`
      : `GMT${sign}${Math.floor(absolute / 60)}:${pad(absolute % 60)}`;
  return `${day} ${clock} ${zone}`;
}

/**
 * The export file name that one stored stamp must produce (Revision 18).
 *
 * Built from {@link localStampOf} — the same independent local derivation, not
 * the implementation — so the name and the visible stamp are asserted to agree
 * about the same instant while both staying portable across `TZ`.
 * @param iso - the stored UTC ISO value.
 * @returns `dsh-prompt-setting-YYYY-MM-DD-HH-mm-ss.json` for the local zone.
 */
function localFileNameOf(iso) {
  const [day, clock] = localStampOf(iso).split(' ');
  return `dsh-prompt-setting-${day}-${clock.replace(/:/g, '-')}.json`;
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

/** Every rendered record row's id, in render order (the 「当前生效值」row is not one). */
function historyRowIds(tree) {
  return collect(tree, (node) => node.props && node.props['data-history-action'] !== undefined).map(
    (node) => node.props['data-history-row'],
  );
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

/** The five first-level tabs, in render order, as their `data-tab-value`s. */
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
 * `primitives`): the five values `mine` / `overview` / `history` / `backup` /
 * `advanced` occur on exactly one control each.
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
  const loaded = loadClient(options.primitives || 'throw', options);
  // g-039 fourth round: extra `window` facts a measuring case needs
  // (`innerHeight`, `getComputedStyle`). Merged, never replaced: the loader
  // double is still there.
  if (options.window !== undefined) Object.assign(loaded.sandbox.window, options.window);
  // g-039 fifth round: the page-level scroll lock reads `document.body.style`.
  if (options.document !== undefined) loaded.sandbox.document = options.document;
  // Revision 18: an engine with no `Intl` must still stamp a time and name a
  // file — the fallback is part of the contract, so a case can ask for that
  // engine instead of trusting a branch no one has run.
  if (options.withoutIntl === true) loaded.sandbox.Intl = undefined;
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
  const page = {
    loaded,
    mounted,
    router,
    props,
    draw,
    flush,
    zh,
    language,
    text: tables[language] || {},
    /** Stop the page's timers: a case that leaves an install "running" is done. */
    dispose: () => loaded.stopTimers(),
  };
  mountedPages.push(page);
  return page;
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

/**
 * `GET /prompt-setting/update-check` payload (g-030).
 *
 * The default is the quiet case: the switch is on (`enabled: true`) and upstream
 * is not ahead (`hasUpdate: false`), which is exactly what must render **nothing**.
 * @param over - fields to override.
 * @returns the payload.
 */
function updateFixture(over = {}) {
  return {
    ok: true,
    enabled: true,
    current: '0.1.5',
    latest: null,
    hasUpdate: false,
    releaseUrl: null,
    publishedAt: null,
    checkedAt: '2024-01-01T00:00:00.000Z',
    cached: false,
    error: null,
    ...over,
  };
}

/** The banner's payload: a confirmed newer release with its release page. */
function updateAvailableFixture(over = {}) {
  return updateFixture({
    latest: '0.9.9',
    hasUpdate: true,
    releaseUrl: 'https://github.com/zangxx66/dsh-prompt-setting/releases/tag/v0.9.9',
    publishedAt: '2024-06-01T00:00:00.000Z',
    ...over,
  });
}

/**
 * `GET /prompt-setting/download-region` payload (g-043).
 *
 * The default is the **pre-detection** shape a g-043 host answers with when the
 * region was already stored: the shipped source, and `detected:false` because no
 * probe decided it. The two fields that change the copy — `detected` and a
 * `custom` `error` — are what the cases below drive.
 * @param over - fields to override.
 * @returns the payload.
 */
function regionFixture(over = {}) {
  return {
    ok: true,
    region: 'default',
    registry: 'https://registry.npmjs.org/',
    custom: null,
    detected: false,
    stored: true,
    error: null,
    probed: false,
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
    // g-038: the scope that located the file (a workspace's own log is located
    // by a session id) and the paging numbers the client reads back.
    scopeSession: null,
    path: '/home/u/.dsh/prompt-setting/history.jsonl',
    enabled: true,
    reason: null,
    retentionLimit: 100,
    pageLimit: 20,
    offset: 0,
    total: 2,
    pageCount: 1,
    hasMore: false,
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
    scopeSession: null,
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
    plugin: { name: 'dsh-prompt-setting', version: '0.1.5' },
    pluginVersion: '0.1.5',
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
  // g-039: the version-history tab's only write.
  rollback: '/prompt-setting/rollback',
  export: '/prompt-setting/export',
  import: '/prompt-setting/import',
  interpolate: '/prompt-setting/interpolate',
  // g-030: the upstream update check and its on/off switch.
  updateCheck: '/prompt-setting/update-check',
  // g-043:「下载区域」— the choice, and the first-visit detection behind it.
  downloadRegion: '/prompt-setting/download-region',
  // g-032:「立即更新」— the install route, its status read and its cancel face.
  updateApply: '/prompt-setting/update-apply',
  updateApplyCancel: '/prompt-setting/update-apply/cancel',
};

/** The default stub table (every route the page may call on mount). */
function defaultResponses(over = {}) {
  return {
    [PATHS.ping]: {},
    [PATHS.snapshot]: { payload: snapshotFixture() },
    [PATHS.overrides]: { payload: overridesFixture() },
    [PATHS.history]: { payload: historyFixture() },
    [PATHS.diff]: { payload: diffFixture() },
    // g-039: the rollback response, the one write this tab can start.
    [PATHS.rollback]: {
      payload: {
        ok: true,
        rolledBack: true,
        layer: 'user',
        session: null,
        seq: 1,
        count: 1,
        overrides: [],
        effectiveFrom: 'next-turn',
        history: { ok: true, id: '3', seq: 3, dropped: 0, rewritten: false },
      },
    },
    [PATHS.export]: { payload: exportFixture() },
    [PATHS.import]: { payload: importPlanFixture() },
    // g-030: the shipped default — switch on, upstream not ahead, so the default
    // page renders no banner at all.
    [PATHS.updateCheck]: { payload: updateFixture() },
    // g-043: a host that has already stored a region — so the default page makes
    // one read and no probe, exactly like a second visit does.
    [PATHS.downloadRegion]: { payload: regionFixture() },
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
  // g-032 adds one baseline request: the bare `GET /update-apply` that lets a
  // page which was reloaded mid-install resume following it. It is a **local**
  // request to this plugin's own prefix, so it does not weaken g-030's promise
  // that a closed switch means no request leaves the machine.
  //
  // g-043 adds one more of exactly that kind: `GET /download-region`, the read
  // that (on a first visit) lets the *host* decide the update source. Still one
  // request to this plugin's own prefix, and still none at all when the mirror
  // says the switch is off (asserted in the region section below).
  assert.deepEqual(
    [...new Set(urls.map((url) => url.split('?')[0]))].sort(),
    [PATHS.downloadRegion, PATHS.overrides, PATHS.ping, PATHS.snapshot, PATHS.updateApply, PATHS.updateCheck],
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

/**
 * The repository URL the fixture host reports (Revision 17).
 *
 * Deliberately a fixture constant, not a value derived from `package.json`: what
 * the client test must show is that the page renders **the ping's** URL. That
 * the ping's URL is the manifest's is asserted on the host side
 * (`test/host.test.mjs`), where the derivation lives.
 */
const FIXTURE_REPOSITORY_URL = 'https://github.com/zangxx66/dsh-prompt-setting';

/**
 * The ping body a host serving `clientBuild` answers with.
 *
 * Since g-029 the same body also carries the version, and its default is the
 * version `index.js` really declares: a fixture that hard-coded one would go on
 * passing after the two copies drifted apart, which is the failure this whole
 * goal exists to prevent. Revision 17 adds `repositoryUrl` to the same body.
 * @param launchKind - g-036: the launch shape the host reports; `undefined`
 *   omits the field entirely, which is what a pre-g-036 host answers.
 */
function pingResponse(clientBuild, version = PLUGIN_VERSION, repositoryUrl = FIXTURE_REPOSITORY_URL, launchKind = undefined) {
  return {
    payload: {
      ok: true,
      plugin: 'dsh-prompt-setting',
      version,
      repositoryUrl,
      time: '2024-01-01T00:00:00.000Z',
      clientRenderer: 'fallback',
      clientReportedAt: null,
      clientBuild,
      // g-036: absent for the old-host cases, exactly as a pre-g-036 host
      // answers. `undefined` is dropped by the JSON stub, which is the point.
      ...(launchKind === undefined ? {} : { launchKind }),
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

// #region g-045: the split bundle — chunks, and what the stamp covers now

/** The chunk files this package ships, in file-name order. */
const CHUNK_FILES = readdirSync(join(here, '..'))
  .filter((name) => /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(name))
  .sort();

/**
 * The host's chunk digests, recomputed here from disk.
 *
 * Deliberately independent of `core/store.js`: these cases assert what the page
 * does with the host's answer, so the answer is built by the test.
 * @returns `[{name, hash, size, mtime}]`, in file-name order.
 */
function chunkBuildFixture() {
  return CHUNK_FILES.map((name) => {
    const oracle = independentBuildFingerprint(readFileSync(join(here, '..', name), 'utf8'));
    return { name, hash: oracle.hash, size: oracle.size, mtime: '2024-01-01T00:00:00.000Z' };
  });
}

/** A `clientBuild` body that carries the chunk list, as a post-g-045 host sends it. */
function chunkedBuildFixture() {
  const oracle = independentBuildFingerprint(clientSource);
  return { ...buildFixture(oracle.hash, oracle.size), chunks: chunkBuildFixture() };
}

test('client: the bundle registers its entry plus one entry per chunk, flat and loader-legal', async () => {
  const page = makePage({ responses: defaultResponses() });
  await openHistory(page);
  const entries = page.loaded.registrations.filter((entry) => entry.chunk === undefined);
  const chunks = page.loaded.registrations.filter((entry) => entry.chunk !== undefined);
  assert.deepEqual(entries.map((entry) => entry.id), [packageJson.name], 'exactly one entry registration');
  assert.ok(chunks.length >= 1, 'the split bundle registers at least one chunk');
  for (const entry of chunks) {
    assert.equal(entry.id, packageJson.name, 'a chunk names the package that owns it');
    // The loader refuses any other spelling: `client.<something>.js`, with no
    // directory separator, so the file must be a flat sibling of client.js.
    assert.match(entry.chunk, /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/);
    assert.ok(existsSync(join(here, '..', entry.chunk)), `${entry.chunk} is a flat sibling of client.js`);
    assert.equal(typeof entry.factory, 'function');
  }
});

test('client: 「版本历史」 is fetched only when that tab is opened', async () => {
  const page = makePage({ responses: defaultResponses() });
  await page.flush();
  assert.deepEqual(page.loaded.loadedChunkFiles, [], '「我的 Prompt」 pays nothing for the history chunk');
  const tree = await openHistory(page);
  assert.deepEqual(page.loaded.loadedChunkFiles, ['client.history.js'], 'opening the tab fetches it');
  // …and the tree is the same one this file used to build itself: the chunk's
  // markers, its rows and its panel frame are all still here.
  assert.equal(oneBy(tree, 'data-region', 'history').props['data-region'], 'history');
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'history').length, 1);
  // g-046: 「提示词总览」 has a chunk of its own now, so reaching it adds that
  // file — and only that file: the history chunk a reader already paid for is
  // never fetched a second time.
  await openOverview(page);
  assert.deepEqual(
    page.loaded.loadedChunkFiles,
    ['client.history.js', 'client.overview.js'],
    'each tab fetches its own chunk, and only once',
  );
});

test('client: a chunk reaches the main bundle through require(), never a second React', () => {
  const source = readFileSync(join(here, '..', 'client.history.js'), 'utf8');
  // One direction only: the chunk asks the main bundle for the page's shared
  // facilities. A `require('react')` here would be a second React instance, and
  // a second element factory under it — the exact drift the split must avoid.
  assert.ok(source.includes(`require('${packageJson.name}')`), 'the chunk requires the main bundle');
  assert.equal(source.includes("require('react')"), false, 'the chunk must not build its own React');
  // The facilities it does get are the main factory's own instance, not copies.
  const loaded = loadClient('throw');
  const shared = loaded.module.__internals.shared;
  assert.equal(shared.h, loaded.runtime.React.createElement, 'one element factory for the whole bundle');
  assert.ok(shared.token && typeof shared.token === 'object', 'and one theme token table');
});

test('client: a chunk that cannot be loaded renders a readable card, not a blank tab', async () => {
  const page = makePage({ chunkFailures: ['client.history.js'], responses: defaultResponses() });
  const mine = await page.flush();
  assert.equal(markerOf(mine, 'data-render-state'), 'ok', 'the page itself still renders');
  const tree = await openHistory(page);
  const card = oneBy(tree, 'data-region', 'chunk-failure');
  assert.equal(card.props['data-chunk'], 'client.history.js', 'the card names the chunk');
  assert.equal(card.props['data-chunk-state'], 'error');
  assert.ok(hasText(tree, 'chunk unavailable: client.history.js'), 'and the reason is on screen');
  // The rest of the page is untouched: a chunk failure is one tab's problem.
  assert.equal(markerOf(tree, 'data-render-state'), 'ok');
  assert.equal(oneBy(tree, 'data-region', 'tabs').props['data-region'], 'tabs');
  const overview = await openOverview(page);
  assert.equal(markerOf(overview, 'data-render-state'), 'ok', 'other tabs still render');
});

test('client: chunk sources obey the same rules as the entry (no version literal, no repository URL)', () => {
  for (const name of CHUNK_FILES) {
    const source = readFileSync(join(here, '..', name), 'utf8');
    for (const quoted of [`'${packageJson.version}'`, `"${packageJson.version}"`]) {
      assert.equal(source.includes(quoted), false, `${name} must not contain ${quoted}`);
    }
    assert.equal(source.includes('github.com'), false, `${name} must not carry a repository URL`);
    assert.equal(/<[A-Za-z][^>]*>/.test(source), false, `${name} must not carry JSX`);
  }
});

test('client: the stamp covers the host’s chunk digests, and the page verifies the chunk it ran', async () => {
  const page = makePage({
    responses: defaultResponses({ [PATHS.ping]: pingResponse(chunkedBuildFixture()) }),
  });
  const mine = await page.flush();
  assert.equal(markerOf(mine, 'data-build-match'), 'true', 'the entry digest and the manifest agree');
  assert.equal(markerOf(mine, 'data-build-loaded'), 'none', 'no chunk has run yet');

  await openHistory(page);
  // The chunk has now really run, so the root carries what it reported — the
  // page reads it on the next render, exactly as React re-renders a boundary.
  const history = page.draw();
  assert.equal(markerOf(history, 'data-build-match'), 'true');
  const declared = chunkBuildFixture().find((entry) => entry.name === 'client.history.js');
  assert.equal(markerOf(history, 'data-build-loaded'), `client.history.js:${declared.hash}`);
  // …and that digest is the one an independent read of the chunk file yields.
  assert.equal(
    declared.hash,
    independentBuildFingerprint(readFileSync(join(here, '..', 'client.history.js'), 'utf8')).hash,
  );
});

test('client: a chunk whose served bytes differ from the manifest is 「stale」, never 「matching」', async () => {
  // Negative control (criterion 3): the entry file is byte-for-byte the one on
  // disk, and only the *chunk* the host reports differs from what the entry
  // declares. Before g-045 this could not be expressed — the entry digest saw
  // no chunk at all — and a silent「一致」here is exactly what the split risks.
  const chunks = chunkBuildFixture().map((entry) =>
    entry.name === 'client.history.js' ? { ...entry, hash: 'deadbeef' } : entry,
  );
  const page = makePage({
    responses: defaultResponses({
      [PATHS.ping]: pingResponse({ ...buildFixture(independentBuildFingerprint(clientSource).hash), chunks }),
    }),
  });
  const tree = await page.flush();
  assert.equal(markerOf(tree, 'data-build'), independentBuildFingerprint(clientSource).hash);
  assert.equal(markerOf(tree, 'data-build-match'), 'false', 'the served chunk is not the declared one');
  assert.equal(oneBy(tree, 'data-region', 'status').props['data-status-build'], 'false');
  const advanced = await openAdvanced(page);
  assert.equal(staleWarnings(advanced).length, 1);
  assert.ok(hasText(advanced, page.zh.stBuildStaleHint));
});

test('client: a chunk edited in flight is caught by the page’s own chunk digest', async () => {
  // The strongest form of "the bytes the page is running vs the bytes on disk":
  // the host reports the file's digest, the manifest agrees with it, and the
  // chunk that actually ran reports a *different* digest of itself.
  const page = makePage({
    chunkSourceEdit: (name, source) =>
      name === 'client.history.js'
        ? source.replace('/* @build-fingerprint:end */', '// edited in flight\n    /* @build-fingerprint:end */')
        : source,
    responses: defaultResponses({ [PATHS.ping]: pingResponse(chunkedBuildFixture()) }),
  });
  const mine = await page.flush();
  assert.equal(markerOf(mine, 'data-build-match'), 'true', 'nothing has run the edited bytes yet');
  await openHistory(page);
  const tree = page.draw();
  assert.equal(markerOf(tree, 'data-build-match'), 'false', 'the running chunk is not the served chunk');
  assert.equal(oneBy(tree, 'data-region', 'status').props['data-status-build'], 'false');
});

test('client: a chunk list the two sides do not share is 「unknown」, never 「matching」', async () => {
  const oracle = independentBuildFingerprint(clientSource);
  // (a) the host serves fewer chunks than this entry declares.
  const short = makePage({
    responses: defaultResponses({
      [PATHS.ping]: pingResponse({ ...buildFixture(oracle.hash, oracle.size), chunks: [] }),
    }),
  });
  assert.equal(markerOf(await short.flush(), 'data-build-match'), 'unknown', 'coverage is incomplete');
  // (b) the host serves a chunk this entry does not declare.
  const extra = makePage({
    responses: defaultResponses({
      [PATHS.ping]: pingResponse({
        ...buildFixture(oracle.hash, oracle.size),
        chunks: [...chunkBuildFixture(), { name: 'client.ghost.js', hash: 'deadbeef', size: 1, mtime: 'x' }],
      }),
    }),
  });
  assert.equal(markerOf(await extra.flush(), 'data-build-match'), 'unknown', 'and never a guessed verdict');
  // (c) a malformed list is refused whole rather than half-read.
  const malformed = makePage({
    responses: defaultResponses({
      [PATHS.ping]: pingResponse({
        ...buildFixture(oracle.hash, oracle.size),
        chunks: [{ name: 'client.history.js' }],
      }),
    }),
  });
  assert.equal(markerOf(await malformed.flush(), 'data-build-match'), 'unknown');
});

test('client: an old host without a chunk list keeps the pre-split answer', async () => {
  const oracle = independentBuildFingerprint(clientSource);
  const page = makePage({
    responses: defaultResponses({ [PATHS.ping]: pingResponse(buildFixture(oracle.hash, oracle.size)) }),
  });
  assert.equal(markerOf(await page.flush(), 'data-build-match'), 'true', 'nothing contradicts the entry digest');
  // Once a chunk has really run, an answer that says nothing about it is no
  // longer enough to call this tab「一致」.
  await openHistory(page);
  assert.equal(markerOf(page.draw(), 'data-build-match'), 'unknown');
  // `chunks: null` is that same answer, spelled out: "I have no list to offer"
  // (CONTRACT.md §14.3). It is **not** `[]`, which is a claim that no chunk is
  // served and is therefore compared against the manifest like any other list.
  const nullList = makePage({
    responses: defaultResponses({
      [PATHS.ping]: pingResponse({ ...buildFixture(oracle.hash, oracle.size), chunks: null }),
    }),
  });
  assert.equal(markerOf(await nullList.flush(), 'data-build-match'), 'true', 'null means "no list", like an absent field');
  await openHistory(nullList);
  assert.equal(markerOf(nullList.draw(), 'data-build-match'), 'unknown', 'and once a chunk has run, still unknown');
});

test('client: a chunk that finishes loading notifies the root seat, so the attributes follow', async () => {
  // The regression this pins (found on a real browser, NOTES.md §122): a chunk's
  // load re-renders only the Suspense subtree, while `data-build-loaded` and the
  // verdict live on the **root** container. Without a seat that the store really
  // notifies, the page reports "no chunk has run" to a reader staring at one —
  // and the third check never runs when it matters.
  const page = makePage({ responses: defaultResponses() });
  const mine = await page.flush();
  assert.equal(markerOf(mine, 'data-build-loaded'), 'none', 'no chunk has run yet');
  const before = page.loaded.runtime.externalNotifications.length;
  await openHistory(page);
  await settle();
  assert.ok(
    page.loaded.runtime.externalNotifications.length > before,
    'the loaded chunk notifies its useSyncExternalStore subscribers',
  );
  assert.ok(
    page.loaded.runtime.externalNotifications.some((snapshot) => snapshot > 0),
    'and the snapshot it read really moved',
  );
  // The root attributes carry it on the next render, with no tab change: the
  // history tab is still the open one.
  const declared = chunkBuildFixture().find((entry) => entry.name === 'client.history.js');
  const tree = page.draw();
  assert.equal(oneBy(tree, 'data-region', 'tab-panel').props['data-tab-value'], 'history', 'still on the tab');
  assert.equal(markerOf(tree, 'data-build-loaded'), `client.history.js:${declared.hash}`);
  // A chunk that fails to load never claims to have run.
  const failed = makePage({ chunkFailures: ['client.history.js'], responses: defaultResponses() });
  await failed.flush();
  await openHistory(failed);
  await settle();
  assert.equal(markerOf(failed.draw(), 'data-build-loaded'), 'none', 'a failed chunk is not a loaded chunk');
});

test('client: a loader without require.async degrades that tab to a readable card', async () => {
  // The loader contract has one relative form; an engine that does not offer it
  // cannot fetch a chunk. That is a degradation of one tab, never a throw and
  // never a claim that something ran.
  const page = makePage({ withoutRequireAsync: true, responses: defaultResponses() });
  const mine = await page.flush();
  assert.equal(markerOf(mine, 'data-render-state'), 'ok', 'the page itself still renders');
  const tree = await openHistory(page);
  assert.equal(oneBy(tree, 'data-region', 'tab-panel').props['data-tab-value'], 'history');
  const card = oneBy(tree, 'data-region', 'chunk-failure');
  assert.equal(card.props['data-chunk'], 'client.history.js');
  assert.equal(card.props['data-chunk-state'], 'error');
  assert.deepEqual(page.loaded.loadedChunkFiles, [], 'with no loader there is no request to make');
  assert.equal(markerOf(tree, 'data-build-loaded'), 'none', 'and nothing is reported as loaded');
});

test('client: a React without lazy/Suspense renders the tab as a readable card', async () => {
  // The boundary is a probe, like the primitives one: an engine whose React
  // predates `lazy`/`Suspense` must lose this tab's content, not the panel.
  const page = makePage({ withoutReactLazy: true, responses: defaultResponses() });
  const mine = await page.flush();
  assert.equal(markerOf(mine, 'data-render-state'), 'ok', 'the page itself still renders');
  const tree = await openHistory(page);
  assert.equal(oneBy(tree, 'data-region', 'tab-panel').props['data-tab-value'], 'history');
  assert.equal(oneBy(tree, 'data-region', 'chunk-failure').props['data-chunk'], 'client.history.js');
  assert.equal(markerOf(tree, 'data-build-loaded'), 'none');
  assert.deepEqual(page.loaded.loadedChunkFiles, [], 'without a boundary nothing is fetched at all');
  // The other tabs are untouched by this engine's limitation.
  const overview = await openOverview(page);
  assert.equal(markerOf(overview, 'data-render-state'), 'ok');
});

// #endregion

// #region g-046: the remaining tabs move out

/**
 * Each **non-default** tab and the chunk that carries it.
 *
 * 「我的 Prompt」 is deliberately absent from this table: it is the tab the
 * settings page opens on, so its renderer stays in the entry file — a chunk
 * there would put a round trip in front of first-screen code and turn a failed
 * fetch into a blank default tab.
 */
const TAB_CHUNKS = [
  ['overview', 'client.overview.js'],
  ['backup', 'client.transfer.js'],
  ['advanced', 'client.advanced.js'],
  ['history', 'client.history.js'],
];

/** A chunk source with its comment lines removed, so only code is asserted on. */
function chunkCode(source) {
  return source
    .split('\n')
    .filter((line) => {
      const text = line.trim();
      return !(text.startsWith('*') || text.startsWith('/*') || text.startsWith('//'));
    })
    .join('\n');
}

test('client: the first screen fetches the entry alone, and each tab fetches only its own chunk (g-046)', async () => {
  const page = makePage({ responses: defaultResponses() });
  const mine = await page.flush();
  assert.equal(markerOf(mine, 'data-render-state'), 'ok');
  assert.equal(oneBy(mine, 'data-region', 'tab-panel').props['data-tab-value'], 'mine');
  // Criterion 2, stated at its strongest: opening the settings page is one
  // request. The default tab is built from bytes this file already carries.
  assert.deepEqual(page.loaded.loadedChunkFiles, [], 'the first screen is the entry file only');

  const seen = [];
  for (const [tab, file] of TAB_CHUNKS) {
    const tree = await openTab(page, tab);
    seen.push(file);
    assert.deepEqual(
      page.loaded.loadedChunkFiles.slice().sort(),
      seen.slice().sort(),
      `「${tab}」 fetches ${file} and nothing else`,
    );
    assert.equal(oneBy(tree, 'data-region', 'tab-panel').props['data-tab-value'], tab);
    assert.equal(markerOf(tree, 'data-render-state'), 'ok');
  }
  // And a tab that has already been opened never fetches anything again.
  const again = await openTab(page, 'overview');
  assert.deepEqual(page.loaded.loadedChunkFiles.slice().sort(), seen.slice().sort(), 'each chunk is fetched once');
  assert.equal(oneBy(again, 'data-region', 'tab-panel').props['data-tab-value'], 'overview');
});

test('client: a tab chunk that cannot be loaded degrades that tab alone (g-046)', async () => {
  // Criterion 3 for every new boundary, not just the first one: one tab's 404
  // is a readable card in that tab, and nothing else on the page notices.
  for (const [tab, file] of TAB_CHUNKS) {
    const page = makePage({ chunkFailures: [file], responses: defaultResponses() });
    const mine = await page.flush();
    assert.equal(markerOf(mine, 'data-render-state'), 'ok', `${file}: the page itself still renders`);
    const tree = await openTab(page, tab);
    const card = oneBy(tree, 'data-region', 'chunk-failure');
    assert.equal(card.props['data-chunk'], file, `${file}: the card names the chunk`);
    assert.equal(card.props['data-chunk-state'], 'error');
    assert.ok(hasText(tree, `chunk unavailable: ${file}`), `${file}: and the reason is on screen`);
    assert.equal(markerOf(tree, 'data-render-state'), 'ok', `${file}: a chunk failure is one tab's problem`);
    // The other tabs are still reachable, and still render.
    const other = tab === 'overview' ? 'advanced' : 'overview';
    const next = await openTab(page, other);
    assert.equal(markerOf(next, 'data-render-state'), 'ok', `${file}: other tabs still render`);
    assert.equal(oneBy(next, 'data-region', 'tab-panel').props['data-tab-value'], other);
  }
});

test('client: every chunk depends on the entry alone — a DAG, with one copy of each facility (g-046)', () => {
  // Criterion 4, mechanically: the only edge out of a chunk is `require()` of
  // the entry, so no chunk can name or fetch another one and no cycle can
  // exist. Everything a chunk uses comes off `__internals.shared` under its own
  // name — and every key it asks for must really be there, which is what keeps
  // a facility from being copied into the chunk instead of handed over.
  const loaded = loadClient('throw');
  const shared = loaded.module.__internals.shared;
  for (const name of CHUNK_FILES) {
    const code = chunkCode(readFileSync(join(here, '..', name), 'utf8'));
    assert.equal(code.includes('require.async'), false, `${name}: a chunk never fetches another chunk`);
    assert.equal(code.includes("require('react')"), false, `${name}: no second React instance`);
    for (const other of CHUNK_FILES) {
      if (other === name) continue;
      assert.equal(code.includes(other), false, `${name}: must not name ${other}`);
    }
    // No copied data either: a second dictionary or token table would be a
    // second value that can drift away from the page it renders in.
    assert.equal(/const (zh|en|ERROR_TEXT|token) = \{/.test(code), false, `${name}: no copied copy table`);
    // Every reference to the shared surface is collected, in both spellings:
    // `shared.x` (however it is bound — `const x = shared.x`, `const {x} = shared`,
    // or used inline) and the destructuring form. Each key asked for must really
    // be exposed, so a chunk cannot invent a facility the entry never handed it.
    const asked = [
      ...[...code.matchAll(/shared\.([A-Za-z0-9_$]+)/g)].map((match) => match[1]),
      ...[...code.matchAll(/const\s*\{([^}]*)\}\s*=\s*shared\b/g)].flatMap((match) =>
        match[1]
          .split(',')
          .map((part) => part.trim().split(':').pop().trim())
          .filter((key) => key.length > 0),
      ),
    ];
    assert.ok(asked.length > 0, `${name}: takes its facilities from the shared surface`);
    for (const key of asked) {
      assert.ok(key in shared, `${name}: the entry exposes ${key} on __internals.shared`);
    }
    // …and it may not build its own: a local `const token = …` or `function fmt(…)`
    // under a name the entry already owns would be the second copy the whole
    // mechanism exists to prevent, and the check above cannot see it (the local
    // binding shadows the shared one instead of reaching for it).
    for (const key of Object.keys(shared)) {
      const redefined = new RegExp(`^ {4}(?:const|let|var|function)\\s+${key}\\b`, 'gm');
      for (const hit of code.matchAll(redefined)) {
        const line = code.slice(hit.index).split('\n')[0];
        assert.ok(
          line.includes(`shared.${key}`),
          `${name}: ${key} is taken from the shared surface, never redefined — ${line.trim()}`,
        );
      }
    }
  }
  assert.equal(shared.h, loaded.runtime.React.createElement, 'one element factory for the whole bundle');
  assert.ok(shared.token && typeof shared.token === 'object', 'and one theme token table');
});

test('client: without React.lazy every chunked tab renders its card, and nothing is fetched (g-046)', async () => {
  // The same probe g-045 asserts for 「版本历史」, now for every boundary: an
  // engine whose React predates `lazy`/`Suspense` must lose the tab's content,
  // never the panel — and must not make a request it cannot use.
  const page = makePage({ withoutReactLazy: true, responses: defaultResponses() });
  const mine = await page.flush();
  assert.equal(markerOf(mine, 'data-render-state'), 'ok');
  for (const [tab, file] of TAB_CHUNKS) {
    const tree = await openTab(page, tab);
    assert.equal(oneBy(tree, 'data-region', 'tab-panel').props['data-tab-value'], tab);
    assert.equal(oneBy(tree, 'data-region', 'chunk-failure').props['data-chunk'], file);
    assert.equal(markerOf(tree, 'data-render-state'), 'ok');
  }
  assert.deepEqual(page.loaded.loadedChunkFiles, [], 'without a boundary nothing is fetched at all');
  assert.equal(markerOf(page.draw(), 'data-build-loaded'), 'none');
});

test('client: each tab’s chunk reports a digest an independent read of its file confirms (g-046)', async () => {
  // Criterion 6 at the chunk level: the third verification is the only one that
  // can catch "the bytes this page ran are not the bytes the host serves", and
  // it has to work for every chunk, not just the first one.
  const page = makePage({
    responses: defaultResponses({ [PATHS.ping]: pingResponse(chunkedBuildFixture()) }),
  });
  await page.flush();
  assert.equal(markerOf(page.draw(), 'data-build-loaded'), 'none', 'nothing has run yet');
  const fixture = chunkBuildFixture();
  const seen = [];
  for (const [tab, file] of TAB_CHUNKS) {
    await openTab(page, tab);
    seen.push(file);
    // `loadedChunkStamps()` is insertion-ordered, so the attribute is exactly
    // the chunks opened so far, in that order.
    const expected = seen.map((name) => `${name}:${fixture.find((entry) => entry.name === name).hash}`).join(',');
    const tree = page.draw();
    assert.equal(markerOf(tree, 'data-build-loaded'), expected, `${file}: the page reports its own running bytes`);
    assert.equal(markerOf(tree, 'data-build-match'), 'true', `${file}: and the manifest agrees`);
  }
});

// #endregion

// #region g-029: the plugin version the page shows

/**
 * Ping bodies that carry **no usable version**: the field is absent, or present
 * as something that declares no version — a non-string, the empty string, or
 * only whitespace. Every one of them must render as「未知」— the alternative is
 * a value no host ever sent (`v   ` included).
 */
const VERSIONLESS_PINGS = [
  ['no version field at all', { payload: { ok: true, plugin: 'dsh-prompt-setting' } }],
  ['version: null', { payload: { ok: true, plugin: 'dsh-prompt-setting', version: null } }],
  ['version: 42', { payload: { ok: true, plugin: 'dsh-prompt-setting', version: 42 } }],
  ['version: ""', { payload: { ok: true, plugin: 'dsh-prompt-setting', version: '' } }],
  ['version: "   "', { payload: { ok: true, plugin: 'dsh-prompt-setting', version: '   ' } }],
  ['version: "\\t\\n"', { payload: { ok: true, plugin: 'dsh-prompt-setting', version: '\t\n' } }],
  ['version: {}', { payload: { ok: true, plugin: 'dsh-prompt-setting', version: {} } }],
];

test('client: the version on the page is the ping\'s version, not a copy kept in the bundle', async () => {
  // A version that occurs nowhere in this repository. If the page can render it,
  // it can only have come from the answer it was handed — the negative control
  // for "no second copy of the version string".
  const sentinel = '9.9.9-sentinel';
  const page = makePage({
    responses: defaultResponses({ [PATHS.ping]: pingResponse(buildFixture('deadbeef'), sentinel) }),
  });
  const tree = await page.flush();
  assert.equal(markerOf(tree, 'data-plugin-version'), sentinel, 'the machine marker repeats the answer');
  assert.ok(hasText(tree, `v${sentinel}`), 'the title line renders v<version>');
  assert.equal(hasText(tree, `v${packageJson.version}`), false, 'the bundle\'s own version is not what was shown');
  // One ping, one host boot: the build stamp on the same render comes from that
  // same answer.
  assert.equal(markerOf(tree, 'data-build-server'), 'deadbeef');

  // Revision 17: the node is beside the page title, and it is a link to the
  // repository from **that same** ping.
  const node = oneBy(tree, 'data-role', 'plugin-version');
  assert.equal(node.type, 'a', 'with a repository URL the version is a link');
  assert.equal(node.props.href, FIXTURE_REPOSITORY_URL, 'the href is the ping\'s URL, not a literal');
  assert.equal(node.props.target, '_blank');
  assert.equal(node.props.rel, 'noreferrer noopener');
  assert.equal(node.props['data-plugin-repository'], FIXTURE_REPOSITORY_URL);
  assert.equal(node.props.title, page.zh.stPluginVersion, 'and labels which fact it is');
  assert.deepEqual(node.props.children, `v${sentinel}`, 'the link text is the version itself');
  // The title row is a sibling of the heading, above every tab.
  // Exactly one version node, and it sits in the heading's own row.
  assert.equal(
    collect(tree, (candidate) => candidate.props && candidate.props['data-role'] === 'plugin-version').length,
    1,
    'exactly one version node on the page — the placement is unique',
  );
  const titleRow = collect(
    tree,
    (candidate) =>
      Array.isArray(candidate.props && candidate.props.children)
      && candidate.props.children.some((child) => child && child.type === 'h2')
      && candidate.props.children.some(
        (child) => child && child.props && child.props['data-role'] === 'plugin-version',
      ),
  );
  assert.equal(titleRow.length, 1, 'the version sits in the same row as the page title');
  // ...and the status line no longer carries one.
  assert.equal(
    collect(oneBy(tree, 'data-region', 'status'), (candidate) => candidate.props && candidate.props['data-role'] === 'plugin-version')
      .length,
    0,
    'the status line renders no version node any more',
  );

  // A value that carries text is passed through **byte for byte**: normalizing
  // whitespace away would print a version the host did not declare.
  const padded = ' 9.9.9-padded ';
  const paddedPage = makePage({
    responses: defaultResponses({ [PATHS.ping]: pingResponse(null, padded) }),
  });
  const paddedTree = await paddedPage.flush();
  assert.equal(markerOf(paddedTree, 'data-plugin-version'), padded, 'not one byte may be trimmed away');
  assert.ok(hasText(paddedTree, `v${padded}`), 'and the node shows exactly that value');
});

test('client: without a repository URL the version is plain text, never a link', async () => {
  // Every shape of "no URL": an older host (field absent), an explicit `null`, a
  // blank string and a non-string. None of them may produce an `a` element —
  // a guessed or empty `href` would send the reader somewhere no manifest names.
  const versionless = [
    ['field absent', { ok: true, plugin: 'dsh-prompt-setting', version: '1.2.3' }],
    ['null', { ok: true, plugin: 'dsh-prompt-setting', version: '1.2.3', repositoryUrl: null }],
    ['blank', { ok: true, plugin: 'dsh-prompt-setting', version: '1.2.3', repositoryUrl: '   ' }],
    ['number', { ok: true, plugin: 'dsh-prompt-setting', version: '1.2.3', repositoryUrl: 7 }],
  ];
  for (const [name, payload] of versionless) {
    const page = makePage({ responses: defaultResponses({ [PATHS.ping]: { payload } }) });
    const tree = await page.flush();
    const node = oneBy(tree, 'data-role', 'plugin-version');
    assert.equal(node.type, 'span', `${name}: not clickable`);
    assert.equal(node.props.href, undefined, `${name}: no href is invented`);
    assert.equal(node.props['data-plugin-repository'], 'unknown', `${name}: the marker says so`);
    assert.deepEqual(node.props.children, 'v1.2.3', `${name}: the version text still renders`);
    assert.equal(markerOf(tree, 'data-plugin-version'), '1.2.3', `${name}: the root marker is unaffected`);
  }

  // A known URL with an unknown version: still a link, with the unknown copy.
  const unknownLinked = makePage({ responses: defaultResponses({ [PATHS.ping]: pingResponse(null, null) }) });
  const unknownTree = await unknownLinked.flush();
  const unknownNode = oneBy(unknownTree, 'data-role', 'plugin-version');
  assert.equal(unknownNode.type, 'a', 'an unknown version is still a link when the URL is known');
  assert.equal(unknownNode.props.href, FIXTURE_REPOSITORY_URL);
  assert.deepEqual(unknownNode.props.children, unknownLinked.zh.stPluginVersionUnknown);

  // Neither a URL nor a version: the unknown copy, plain text, no href.
  const bare = makePage({
    responses: defaultResponses({ [PATHS.ping]: { payload: { ok: true, plugin: 'dsh-prompt-setting' } } }),
  });
  const bareTree = await bare.flush();
  const bareNode = oneBy(bareTree, 'data-role', 'plugin-version');
  assert.equal(bareNode.type, 'span');
  assert.equal(bareNode.props.href, undefined);
  assert.deepEqual(bareNode.props.children, bare.zh.stPluginVersionUnknown);
});

test('client: the shipped version cannot drift from the one the host publishes', async () => {
  // Criterion 1, read from the files themselves: the two copies a human keeps
  // in sync are compared here instead of trusted.
  assert.ok(PLUGIN_VERSION !== null, "index.js declares PLUGIN_VERSION as a single-quoted literal");
  assert.equal(packageJson.version, PLUGIN_VERSION, 'package.json version and PLUGIN_VERSION must not drift');
  assert.ok(indexSource.includes('version: PLUGIN_VERSION,'), 'the ping answers PLUGIN_VERSION itself');
  // Criterion 2's "single source": the client may not carry the version as a JS
  // string literal, whatever that version currently is. Comments are free to
  // name other versions (they already do), so only quoted literals are refused.
  for (const quoted of [`'${packageJson.version}'`, `"${packageJson.version}"`]) {
    assert.equal(clientSource.includes(quoted), false, `client.js must not contain ${quoted}`);
  }
  // Revision 17 adds the same rule for the link: the URL comes from the ping, so
  // the client half may not name a repository host of its own.
  assert.equal(clientSource.includes('github.com'), false, 'client.js must not carry a repository URL');
  const page = makePage({ responses: defaultResponses({ [PATHS.ping]: pingResponse(null) }) });
  const tree = await page.flush();
  assert.equal(markerOf(tree, 'data-plugin-version'), PLUGIN_VERSION, 'the real chain: index.js → ping → page');
  assert.ok(hasText(tree, `v${PLUGIN_VERSION}`), 'and it is rendered with its v prefix');
});

test('client: a ping without a usable version is "unknown", and never a version', async () => {
  for (const [name, answer] of VERSIONLESS_PINGS) {
    const page = makePage({ responses: defaultResponses({ [PATHS.ping]: answer }) });
    const tree = await page.flush();
    assert.equal(markerOf(tree, 'data-plugin-version'), 'unknown', `${name}: the marker says unknown`);
    assert.ok(hasText(tree, page.zh.stPluginVersionUnknown), `${name}: the copy says so`);
    assert.equal(hasText(tree, `v${packageJson.version}`), false, `${name}: no version was fabricated`);
    // Whitespace is the case a `length > 0` check would have printed: the tag
    // must not show `v   ` (or `v` plus any other non-declaration) either.
    const raw = answer.payload && typeof answer.payload.version === 'string' ? answer.payload.version : '';
    if (raw.length > 0) {
      assert.equal(hasText(tree, `v${raw}`), false, `${name}: a blank value is not rendered as a version`);
    }
  }
  // A ping that never arrived is the same state —「未知」, not an error card.
  const failed = makePage({ responses: defaultResponses({ [PATHS.ping]: new Error('Failed to fetch') }) });
  const failedTree = await failed.flush();
  assert.equal(markerOf(failedTree, 'data-plugin-version'), 'unknown');
  assert.ok(hasText(failedTree, failed.zh.stPluginVersionUnknown));
  assert.equal(hasText(failedTree, `v${packageJson.version}`), false);
});

test('client: a whitespace-only version is "unknown", never a blank version', async () => {
  // `'   '` survives a `length > 0` check, which is exactly how it would reach
  // the screen as `v   `. Whitespace is not a declaration, so both halves of the
  // pipeline — the stored state and the render — must refuse it.
  for (const blank of ['   ', '\t', '\n', ' \t\n ']) {
    const page = makePage({ responses: defaultResponses({ [PATHS.ping]: pingResponse(null, blank) }) });
    const tree = await page.flush();
    assert.equal(markerOf(tree, 'data-plugin-version'), 'unknown', `${JSON.stringify(blank)}: the marker`);
    assert.ok(hasText(tree, page.zh.stPluginVersionUnknown), `${JSON.stringify(blank)}: the copy`);
    assert.equal(hasText(tree, `v${blank}`), false, `${JSON.stringify(blank)}: no blank version on screen`);
  }
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

  // The order is the product decision, so it is asserted verbatim. g-038 split
  // 「历史与备份」 into 「版本历史」 + 「备份与恢复」, in exactly this order.
  assert.deepEqual(mainTabs(tree), ['mine', 'overview', 'history', 'backup', 'advanced']);
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
  for (const region of ['sections', 'full', 'history', 'transfer', 'backup-tab', 'overrides', 'status-detail']) {
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
    ['backup', 'transfer'],
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
  // The confirmation is a viewport-anchored modal, not an inline card in the
  // page flow. Triggered from the bottom of a long panel, an inline card landed
  // *above* the trigger (off-screen on a scrolled page, which reads as "nothing
  // happened") and pushed the panel down as it appeared; fixed + centered keeps
  // it where the click happened.
  const overlay = oneBy(tree, 'data-region', 'confirm-overlay');
  assert.equal(overlay.props.style.position, 'fixed', 'the overlay is anchored to the viewport');
  assert.equal(overlay.props.style.top, 0);
  assert.equal(overlay.props.style.left, 0);
  assert.equal(overlay.props.style.alignItems, 'center', 'and centers its card vertically');
  assert.equal(overlay.props.style.justifyContent, 'center', 'and horizontally');
  assert.equal(collect(overlay, (node) => node === confirm).length, 1, 'the card sits inside the overlay');
  assert.equal(confirm.props.role, 'dialog');
  assert.equal(confirm.props['aria-modal'], 'true');
  assert.equal(
    collect(oneBy(tree, 'data-region', 'panel'), (node) => node.props && node.props['data-region'] === 'confirm').length,
    0,
    'no confirmation is rendered inside the panel (it is out of the page flow)',
  );
  assert.equal(
    writeCalls(page).length,
    0,
    'no request is sent before confirm-yes',
  );

  // The dialog's typography: the lead sentence and its explanation are two
  // levels, the "cannot be undone" warning is its own structural strip, and the
  // actions are separated from the copy — instead of one uniform 6px gap and
  // two identically styled sentences.
  const bodyBlock = oneBy(tree, 'data-role', 'confirm-body');
  const bodyLines = (bodyBlock.props.children || []).filter(Boolean);
  assert.equal(bodyLines.length, 2, 'the lead sentence and the explanation');
  assert.equal(bodyBlock.props.style.gap, 4, 'the two sentences form one group');
  assert.equal(bodyLines[0].props.style.fontWeight, 500, 'the lead sentence is emphasised');
  assert.equal(bodyLines[0].props.style.lineHeight, 1.6, 'wrapped copy states its own line height');
  assert.notEqual(
    bodyLines[0].props.style.color,
    bodyLines[1].props.style.color,
    'the explanation sits at a lower level than the lead',
  );
  const irreversible = oneBy(tree, 'data-role', 'confirm-irreversible');
  assert.ok(String(irreversible.props.style.borderLeft).includes('3px'), 'the warning is a structural strip');
  assert.equal(irreversible.props.style.fontSize, 12, 'and does not compete with the copy');
  const actions = oneBy(tree, 'data-role', 'confirm-actions');
  assert.ok(String(actions.props.style.borderTop).startsWith('1px solid'), 'the actions are cut off from the copy');
  // The warning is stated exactly once: the sentences no longer repeat it.
  const irreversibleWord = page.zh.resetIrreversible.replace(/[。.]$/, '');
  assert.equal(
    strings(confirm).filter((text) => String(text).includes(irreversibleWord)).length,
    1,
    'the irreversible warning is stated once, not twice',
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

// #region issue #1: the reserved entry's `applied: false` is not a freeze signal

/**
 * The reserved section as a real host reports it. `index` and `text` vary with
 * the assembly; the fields that matter here are the two the panel used to
 * over-read — `applied: false` with `reason: null` (§15.3: a section with no
 * override) or with a non-frozen failure reason.
 */
function reservedEffectiveEntry(over = {}) {
  return {
    name: CUSTOM_SECTION_NAME,
    index: 4,
    text: '',
    applied: false,
    overridable: true,
    reason: null,
    overrideLayer: null,
    action: null,
    origin: 'registered',
    ...over,
  };
}

test('client: an unconfigured install renders no frozen block (issue #1)', async () => {
  // The host registers the reserved section in every assembly, so a freshly
  // installed plugin already sees it in `effective.sections` — with
  // `applied: false` and `reason: null`, which is "no override applies", not a
  // freeze. The status card and `?session=` both said "not frozen"; the panel
  // used to contradict them on first open.
  const page = makePage({
    responses: defaultResponses({
      [PATHS.snapshot]: {
        payload: snapshotFixture({
          frozenScope: 'session',
          frozen: false,
          effective: { sections: [...snapshotFixture().effective.sections, reservedEffectiveEntry()] },
        }),
      },
    }),
  });
  const tree = await page.flush();
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-warning'] === 'mine-frozen').length,
    0,
    'an unconfigured scope renders no mine-frozen block',
  );
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-mine-frozen'] === 'true').length,
    0,
    'and none of the block markers',
  );
  assert.equal(markerOf(tree, 'data-mine-effect'), 'next-turn', 'the write still takes effect next turn');
  assert.equal(markerOf(tree, 'data-mine-state'), 'unconfigured', 'the panel says "unconfigured", not "frozen"');
  assert.ok(strings(tree).includes(page.zh.mineUnconfigured));
});

test('client: a non-frozen override failure is not reported as a freeze (issue #1)', async () => {
  // §15.4's failures that are *not* a freeze carry `applied: false` too — a
  // `replace` that did not stick, a `hide` that did not stick, an entry the
  // pipeline dropped. Calling any of them "this scope is frozen" would send the
  // reader to the wrong fix (switching agent preset).
  const page = makePage({
    responses: defaultResponses({
      [PATHS.snapshot]: {
        payload: snapshotFixture({
          frozenScope: 'session',
          frozen: false,
          effective: {
            sections: [
              ...snapshotFixture().effective.sections,
              reservedEffectiveEntry({
                reason: 'the section text differs from both the registered text and the requested text',
              }),
            ],
          },
        }),
      },
    }),
  });
  const tree = await page.flush();
  assert.equal(markerOf(tree, 'data-frozen-state'), 'unfrozen', 'the host verdict is the premise of this case');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-warning'] === 'mine-frozen').length,
    0,
    'a non-frozen reason is not a freeze',
  );
  assert.equal(markerOf(tree, 'data-mine-effect'), 'next-turn');
});

test('client: the reserved entry never upgrades an unknown scope to a certain freeze (issue #1)', async () => {
  // `frozenScope: "global"` + a selected session is *unknown* (§2.4/§7.2). The
  // reserved entry's reason comes from the same global probe, so it must not be
  // read as proof that *this session* is frozen.
  const scopeReason = 'session "s2" has no active agent, so this verdict describes the unscoped assembly';
  const globalReason =
    "this plugin's appended probe section was removed after the waterfall, so the assembled sections are not the ones this plugin returned";
  const page = makePage({
    useSessions: sessionsHook(SESSIONS_STATE),
    responses: defaultResponses({
      [PATHS.snapshot]: {
        payload: snapshotFixture({
          frozenScope: 'global',
          frozen: true,
          frozenScopeReason: scopeReason,
          frozenReason: globalReason,
          effective: { sections: [...snapshotFixture().effective.sections, reservedEffectiveEntry({ reason: globalReason })] },
        }),
      },
    }),
  });
  const tree = await page.flush();
  const block = oneBy(tree, 'data-warning', 'mine-frozen');
  assert.equal(
    block.props['data-mine-frozen-certainty'],
    'unknown',
    'the panel may not claim a certainty the snapshot does not have',
  );
  assert.equal(markerOf(tree, 'data-mine-effect'), 'unknown');
  assert.ok(hasText(block, scopeReason), 'the scope reason is still shown');
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
  // Revision 18: rendered in the reader's zone, with the zone named, and the
  // stored UTC value one hover away rather than echoed as the visible text.
  assert.ok(
    hasText(detail, localStampOf('2024-01-01T00:00:00.000Z')),
    "the generation timestamp is shown in the reader's zone",
  );
  assert.equal(hasText(detail, '2024-01-01T00:00:00.000Z'), false, 'the stored UTC string is not echoed');
  assert.ok(
    collect(detail, (node) => node.props && node.props.title === '2024-01-01T00:00:00.000Z').length === 1,
    'and stays reachable as the node title',
  );
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
  // g-029: a root container always carries the version marker, in this state
  // too — nothing could have answered, so the honest value is `unknown`.
  assert.equal(markerOf(tree, 'data-plugin-version'), 'unknown', 'the failure card carries the marker');
  assert.ok(hasText(tree, 'translator exploded'), 'the error text is shown');
  // `t` is the broken thing here, so the card falls back to its literal copy.
  assert.ok(hasText(tree, 'render failure'), 'literal fallback copy is used');
});

// #endregion

// #region stage 2: history, diff, restore default, export / import

/** Open 「版本历史」, where the log and its comparison live (g-038: no transfer here). */
async function openHistory(page) {
  return openTab(page, 'history');
}

/** Open 「备份与恢复」, where export and import live (g-038 split them out). */
async function openBackup(page) {
  return openTab(page, 'backup');
}

/** Open 「高级」, where the legacy override list, the layer buttons and the status detail live. */
async function openAdvanced(page) {
  return openTab(page, 'advanced');
}

/** Open 「提示词总览」, the read-only assembly, on its segment list. */
async function openOverview(page) {
  return openTab(page, 'overview');
}

test('client: the history log is fetched only while 「版本历史」 is open', async () => {
  const page = makePage({ responses: defaultResponses() });
  const mine = await page.flush();
  assert.equal(urlsFor(page, PATHS.history).length, 0, '「我的 Prompt」 pays nothing for the log');
  const overview = await openTab(page, 'overview', mine);
  assert.equal(urlsFor(page, PATHS.history).length, 0, 'and neither does 「提示词总览」');
  // g-038: the transfer tab is not the log either — the two no longer share a tab.
  const backup = await openTab(page, 'backup', overview);
  assert.equal(urlsFor(page, PATHS.history).length, 0, '「备份与恢复」 does not read the log');
  assert.deepEqual(urlsFor(page, PATHS.export), [], 'and it exports nothing until asked');
  await openTab(page, 'history', backup);
  // g-038: no `session` (the user layer is global and is filtered by no scope)
  // and no `limit` (the host owns the page size; this bundle never hardcodes
  // one). The offset is explicit so page N is a request, not a client-side slice.
  assert.deepEqual(urlsFor(page, PATHS.history), [`${PATHS.history}?layer=user&offset=0`]);
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
  // Revision 18: the stored UTC value is rendered in the reader's zone (the
  // fixture says 10:00Z, which is 18:00 for the suite's UTC+8 run) and the raw
  // string stays on the node's `title`.
  assert.ok(
    hasText(newest, localStampOf('2024-01-02T10:00:00.000Z')),
    "the record timestamp is shown in the reader's zone",
  );
  assert.equal(hasText(newest, '2024-01-02T10:00:00Z'), false, 'the stored UTC string is not echoed');
  assert.equal(
    collect(newest, (node) => node.props && node.props.title === '2024-01-02T10:00:00.000Z').length,
    1,
    'and stays reachable as the node title',
  );
  assert.ok(hasText(newest, page.zh['histAction.replace']), 'the action is localized, not the raw enum');
  assert.equal(oneBy(region, 'data-history-current', 'true').props['data-history-row'], 'current');
  assert.ok(strings(region).includes(page.zh.histCurrent));
});

test('client: a history row shows the version, never the section it was written to (g-044)', async () => {
  // A log that still holds the names a reader could once type by hand, plus one
  // whole-layer record (`name === null`) whose placeholder line goes with them.
  const legacy = ['stage2-e2e', 'ui-e2e-ok'];
  const records = legacy.map((name, index) => ({
    id: String(index + 1),
    seq: index + 1,
    at: '2024-01-02T10:00:00.000Z',
    layer: 'user',
    session: null,
    action: 'replace',
    name,
    origin: 'ui',
    before: null,
    after: { text: 'x', hash: 'h-1', bytes: 1 },
    entries: null,
    snapshot: [],
    note: null,
  }));
  records.push({ ...records[0], id: '3', seq: 3, name: null });
  const page = makePage({
    responses: defaultResponses({ [PATHS.history]: { payload: historyFixture({ records, total: records.length }) } }),
  });
  const tree = await openHistory(page);

  // 1. Nothing is filtered: every record is still a row, in the host's order…
  assert.deepEqual(historyRowIds(tree), ['1', '2', '3']);
  assert.equal(markerOf(oneBy(tree, 'data-region', 'history'), 'data-history-total'), '3');
  // …and the name survives **as data**, which is where tests and diagnostics
  // read it from.
  assert.equal(historyRowOf(tree, '1').props['data-history-name'], 'stage2-e2e');
  assert.equal(historyRowOf(tree, '2').props['data-history-name'], 'ui-e2e-ok');
  assert.equal(historyRowOf(tree, '3').props['data-history-name'], '', 'a null name stays an empty datum');

  // 2. No user-visible text names a section — not the legacy ones, and not the
  //    `name === null` placeholder that used to stand in for them.
  const text = strings(tree).join('\n');
  for (const name of legacy) assert.equal(text.includes(name), false, `${name} is not user-visible`);
  assert.equal(text.includes('（整层）'), false, 'nor the zh whole-layer placeholder');
  assert.equal(text.includes('(whole layer)'), false, 'nor the en one');
  assert.equal(page.zh.histWholeLayer, undefined, 'the placeholder copy key is gone, not left dead');
  assert.equal(page.zh.histPreviewName, undefined, 'and so is the preview label');

  // 3. The row is the one-line fact list this buys: id, action, time, buttons.
  const row = historyRowOf(tree, '1');
  assert.equal(row.props.style.padding, '3px 6px', 'tighter than the 6px it carried while it wrapped');
  assert.equal(row.props.style.gap, 4);
  assert.equal(collect(row, (node) => node.type === 'code').length, 1, 'one code node left: the id');
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

  // g-039 sixth round: rows are picked by clicking them — the first fills
  // `from`, the second completes the pair and that is the request.
  clickNode(historyRowOf(tree, '2'));
  tree = await page.flush();
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  assert.deepEqual(urlsFor(page, PATHS.diff), [`${PATHS.diff}?layer=user&from=2&to=1`]);
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
  // 「当前生效值」 is picked like any row. It starts as the default `to`, so the
  // first click clears that slot and the second fills `from`.
  clickNode(oneBy(tree, 'data-history-current', 'true'));
  tree = await page.flush();
  assert.equal(historyRowOf(tree, 'current').props['data-history-selected'], '');
  clickNode(oneBy(tree, 'data-history-current', 'true'));
  tree = await page.flush();
  assert.equal(historyRowOf(tree, 'current').props['data-history-selected'], 'from');
  assert.equal(urlsFor(page, PATHS.diff).length, 0, 'one side is still missing, so nothing is sent');
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  assert.deepEqual(urlsFor(page, PATHS.diff), [`${PATHS.diff}?layer=user&from=current&to=1`]);

  // …and the other way round: a record first, the live value second.
  clickButton(tree, { 'data-action': 'diff-clear' });
  tree = await page.flush();
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  clickNode(oneBy(tree, 'data-history-current', 'true'));
  tree = await page.flush();
  assert.deepEqual(urlsFor(page, PATHS.diff).slice(-1), [`${PATHS.diff}?layer=user&from=1&to=current`]);
});

test('client: a comparison the host could not make is explained, not left empty', async () => {
  const payload = diffFixture({ lines: null, lineReason: 'more than one section differs; pass ?name= to compare one of them' });
  const page = makePage({ responses: defaultResponses({ [PATHS.diff]: { payload } }) });
  let tree = await openHistory(page);
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  clickNode(oneBy(tree, 'data-history-current', 'true'));
  tree = await page.flush();
  const panel = oneBy(tree, 'data-region', 'history-diff');
  assert.equal(markerOf(panel, 'data-diff-no-lines'), 'true');
  assert.ok(hasText(panel, 'more than one section differs'));
});

test('client: the primitives branch renders the comparison with the official DiffBlock', async () => {
  const page = makePage({ primitives: 'ok', responses: defaultResponses() });
  let tree = await openHistory(page);
  assert.equal(rendererOf(tree), 'primitives');

  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  clickNode(oneBy(tree, 'data-history-current', 'true'));
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

test('client: the workspace layer is located by the history scope, never by the page scope', async () => {
  // No hooks at all: there is no scope to resolve a workspace root from, so the
  // panel says so instead of asking the host for something it must refuse.
  const bare = makePage({ responses: defaultResponses() });
  let bareTree = await openHistory(bare);
  clickTab(bareTree, 'history-layer', 'workspace');
  bareTree = await bare.flush();
  const bareRegion = oneBy(bareTree, 'data-region', 'history');
  assert.equal(bareRegion.props['data-history-layer'], 'workspace');
  assert.equal(oneBy(bareRegion, 'data-history-note', 'no-session').props['data-history-note'], 'no-session');
  assert.equal(oneBy(bareTree, 'data-region', 'history-scope').props['data-history-scope-mode'], 'none');
  assert.equal(urlsFor(bare, PATHS.history).length, 1, 'no request without a resolvable scope');

  // A session catalog but no workspace list: the selector degrades to sessions
  // (announced on the page) and locates the workspace log by the current one.
  const page = makePage({
    useSessions: sessionsHook(SESSIONS_STATE),
    responses: defaultResponses({
      [PATHS.history]: { payload: historyFixture({ layer: 'workspace', session: 's2' }) },
    }),
  });
  let tree = await openHistory(page);
  const scope = oneBy(tree, 'data-region', 'history-scope');
  assert.equal(scope.props['data-history-scope-mode'], 'sessions');
  assert.equal(scope.props['data-history-scope-value'], 's2', 'the default scope is the current session');
  assert.equal(oneBy(scope, 'data-warning', 'history-scope-degraded').props['data-warning'], 'history-scope-degraded');
  // The user layer is global: the selector does not apply to it, and the note
  // says so.
  assert.equal(scope.props['data-history-scope-applies'], 'false');
  assert.equal(oneBy(scope, 'data-history-note', 'global').props['data-history-note'], 'global');

  clickTab(tree, 'history-layer', 'workspace');
  tree = await page.flush();
  assert.deepEqual(urlsFor(page, PATHS.history), [
    `${PATHS.history}?layer=user&offset=0`,
    `${PATHS.history}?layer=workspace&workspace=s2&offset=0`,
  ]);
  // `workspace=` locates the file; `session=` would slice it to the writes of
  // one session, which is exactly what a workspace-shaped scope must not do.
  assert.equal(urlsFor(page, PATHS.history)[1].includes('session='), false);
  assert.equal(oneBy(tree, 'data-region', 'history-scope').props['data-history-scope-applies'], 'true');
  assert.equal(markerOf(tree, 'data-history-total'), '2');
});

test('client: changing 「查看范围」 never moves the version history list (g-038)', async () => {
  const page = makePage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  let tree = await openHistory(page);

  const scope = oneBy(tree, 'data-region', 'history-scope');
  assert.equal(scope.props['data-history-scope-mode'], 'workspaces');
  // Two workspaces, each located by one of its own sessions; the default is the
  // workspace the current session (a3) belongs to.
  assert.equal(scope.props['data-history-scope-options'], '2');
  assert.equal(scope.props['data-history-scope-value'], 'a1');
  const before = urlsFor(page, PATHS.history);
  assert.deepEqual(before, [`${PATHS.history}?layer=user&offset=0`]);
  const rowsBefore = historyRowIds(tree);

  // Move the **page** scope twice: another session, then 全局.
  scopeToggle(tree).props.onClick();
  tree = await page.flush();
  sessionOptions(tree).find((row) => row.props['data-session-id'] === 'a2').props.onClick();
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-session'), 'a2', 'the page scope really moved');
  scopeToggle(tree).props.onClick();
  tree = await page.flush();
  clickButton(tree, { 'data-action': 'session-pinned', 'data-pinned': 'global' });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-session'), 'global');
  // g-038: the history scope carries its own `data-scope-open`, so this asserts
  // the **page-level** card's state rather than "the only such marker on screen".
  assert.equal(
    oneBy(tree, 'data-region', 'session').props['data-scope-open'],
    'false',
    'the page picker closed on the pick',
  );

  // The test double's `useEffect` re-runs unconditionally (it has no dependency
  // diffing), so the invariant asserted here is the request **shape**: whatever
  // the page scope does, the log is asked for by layer and offset alone — never
  // by a session, which is what used to re-slice it.
  const afterScope = urlsFor(page, PATHS.history);
  assert.ok(
    afterScope.every((url) => url === `${PATHS.history}?layer=user&offset=0`),
    `every log request stays global: ${JSON.stringify(afterScope)}`,
  );
  assert.equal(afterScope.some((url) => url.includes('session=')), false, 'the page scope never enters the log request');
  assert.deepEqual(historyRowIds(tree), rowsBefore, 'and the rows on screen are the same rows');
  assert.equal(
    oneBy(tree, 'data-region', 'history-scope').props['data-history-scope-value'],
    'a1',
    'the version history kept its own scope through both page-scope changes',
  );

  // …while the version history's **own** selector does move it, without touching
  // the page scope. The selector is a disclosure: 「更改」 opens it, a candidate
  // click finishes the interaction and closes it again.
  clickButton(tree, { 'data-action': 'history-scope-toggle' });
  tree = await page.flush();
  clickButton(tree, { 'data-role': 'history-scope-option', 'data-history-scope-option': 'b1' });
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-region', 'history-scope').props['data-scope-open'], 'false', 'the pick closed it');
  assert.equal(markerOf(tree, 'data-session'), 'global', 'the page scope is still what the user left it as');
  clickTab(tree, 'history-layer', 'workspace');
  tree = await page.flush();
  const afterLayer = urlsFor(page, PATHS.history);
  assert.equal(
    afterLayer[afterLayer.length - 1],
    `${PATHS.history}?layer=workspace&workspace=b1&offset=0`,
    'the workspace log is located by the history scope, and by nothing else',
  );
  assert.ok(
    afterLayer.filter((url) => url.startsWith(`${PATHS.history}?layer=user`)).every((url) => url === `${PATHS.history}?layer=user&offset=0`),
    'and the user-layer reads stayed global throughout',
  );
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
  let tree = await openBackup(page);
  clickButton(oneBy(tree, 'data-region', 'transfer'), { 'data-action': 'export' });
  tree = await page.flush();

  assert.deepEqual(urlsFor(page, PATHS.export), [`${PATHS.export}?session=s2`]);
  assert.equal(downloader.clicks.length, 1, 'one download was triggered');
  // Identifiable and time-ordered, and named in the reader's zone (Revision 18):
  // the expectation comes from local getters, not from the implementation.
  assert.equal(
    downloader.clicks[0].download,
    localFileNameOf('2024-01-02T10:00:00.000Z'),
    "the download is named after the export time in the reader's zone",
  );
  assert.equal(downloader.clicks[0].href, 'blob:test-1');
  assert.equal(downloader.revoked.includes('blob:test-1'), true, 'the object URL is revoked');

  const text = oneBy(tree, 'data-role', 'export-text').props.value;
  const document = JSON.parse(text);
  assert.equal(document.schema, 'dsh-prompt-setting/export');
  assert.equal(document.version, 1);
  assert.equal('ok' in document, false, 'the liveness flag is not part of the document');
  const expectedName = localFileNameOf('2024-01-02T10:00:00.000Z');
  assert.equal(markerOf(tree, 'data-export-name'), expectedName);
  assert.ok(hasText(tree, page.zh.downloadDone.replace('{name}', expectedName)));
});

test('client: without Intl the stamps and the export name fall back to UTC, never to blank', async () => {
  const page = makePage({
    useSessions: sessionsHook(SESSIONS_STATE),
    responses: defaultResponses(),
    withoutIntl: true,
  });
  const downloader = installDownloader(page);
  let tree = await openBackup(page);
  clickButton(oneBy(tree, 'data-region', 'transfer'), { 'data-action': 'export' });
  tree = await page.flush();

  // The file name keeps the pre-Revision-18 UTC spelling rather than degrading
  // to `export.json`, and the download itself is unaffected.
  assert.equal(downloader.clicks.length, 1, 'the download still happens');
  assert.equal(
    downloader.clicks[0].download,
    'dsh-prompt-setting-2024-01-02T10-00-00-000.json',
    'the name falls back to the stored UTC value',
  );
  assert.equal(markerOf(tree, 'data-export-name'), 'dsh-prompt-setting-2024-01-02T10-00-00-000.json');

  // And the visible stamps fall back to the stored UTC string, not to blank.
  const advanced = await openAdvanced(page);
  const detail = oneBy(advanced, 'data-region', 'status-detail');
  assert.ok(hasText(detail, '2024-01-01 00:00:00Z'), 'the stored UTC value is echoed');
  assert.equal(
    hasText(detail, '2024-01-01T00:00:00.000Z'),
    false,
    'with the T/millisecond fix-ups, not verbatim',
  );
});

test('client: an export with no download surface still yields the JSON and says why', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openBackup(page);
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
  let tree = await openBackup(page);
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
  let tree = await openBackup(page);
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
  let tree = await openBackup(page);
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
  let tree = await openBackup(page);
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
  let tree = await openBackup(page);
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
  const tree = await openBackup(page);
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
  // g-038: the log and the transfer surface live in different tabs now, so each
  // is visited on its own and each must carry its own failure.
  let tree = await openHistory(page);
  assert.equal(markerOf(tree, 'data-render-state'), 'ok');
  assert.equal(oneBy(tree, 'data-region', 'history').props['data-history-state'], 'error');
  assert.ok(hasText(tree, page.zh.errNetwork));

  tree = await openTab(page, 'backup', tree);
  clickButton(oneBy(tree, 'data-region', 'transfer'), { 'data-action': 'export' });
  tree = await page.flush();
  typeInto(tree, 'import-text', exportDocument());
  tree = await page.flush();
  clickButton(oneBy(tree, 'data-region', 'transfer'), { 'data-action': 'import-preview' });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-render-state'), 'ok');
  assert.equal(oneBy(tree, 'data-region', 'transfer').props['data-transfer-phase'], 'error');
  assert.ok(hasText(tree, page.zh.errNetwork));
});

// #region g-038: the split tabs, the history scope and the paging list

/** One history record, `seq` ascending, for the paging and scrolling cases. */
function recordOf(seq) {
  return {
    id: String(seq),
    seq,
    at: '2024-01-02T10:00:00.000Z',
    layer: 'user',
    session: null,
    action: 'replace',
    name: 'project:alpha',
    origin: 'ui',
    before: null,
    after: { text: `v${seq}`, hash: `h-${seq}`, bytes: String(seq).length + 1 },
    entries: null,
    snapshot: [],
    note: null,
  };
}

/** The `offset` one history URL asked for. */
function offsetOf(url) {
  const parsed = new URL(url, 'http://localhost');
  const raw = parsed.searchParams.get('offset');
  return raw === null ? null : Number(raw);
}

test('client: export and import live in 「备份与恢复」, and nowhere in 「版本历史」 (g-038)', async () => {
  const page = makePage({ responses: defaultResponses() });
  const history = await openHistory(page);

  // Negative: the log's own tab carries no export/import entry point at all —
  // neither an action, nor an input, nor the transfer panel itself.
  for (const [key, value] of [
    ['data-action', 'export'],
    ['data-action', 'import-preview'],
    ['data-action', 'import-apply'],
    ['data-role', 'import-file'],
    ['data-role', 'import-text'],
    ['data-role', 'export-text'],
    ['data-region', 'transfer'],
    ['data-region', 'backup-tab'],
  ]) {
    assert.equal(
      collect(history, (node) => node.props && node.props[key] === value).length,
      0,
      `「版本历史」 must not render ${key}=${value}`,
    );
  }

  // Positive: they are exactly where the split put them.
  const backup = await openTab(page, 'backup', history);
  assert.equal(tabPanel(backup).props['data-tab-value'], 'backup');
  assert.equal(oneBy(backup, 'data-region', 'backup-tab').props['data-region'], 'backup-tab');
  assert.equal(oneBy(backup, 'data-region', 'transfer').props['data-region'], 'transfer');
  assert.equal(typeof oneBy(backup, 'data-action', 'export').props.onClick, 'function');
  assert.equal(typeof oneBy(backup, 'data-action', 'import-preview').props.onClick, 'function');
  assert.equal(typeof oneBy(backup, 'data-action', 'import-apply').props.onClick, 'function');
  assert.equal(oneBy(backup, 'data-role', 'import-file').type, 'input');
  assert.ok(oneBy(backup, 'data-role', 'import-text'));
  // …and the log's surfaces are not here.
  assert.equal(collect(backup, (node) => node.props && node.props['data-region'] === 'history').length, 0);
  assert.equal(collect(backup, (node) => node.props && node.props['data-region'] === 'history-list').length, 0);
  assert.equal(urlsFor(page, PATHS.history).length, 1, 'and opening it reads no log');
});

test('client: the log is paged by the host, and the page size is never hardcoded (g-038)', async () => {
  const total = 120;
  const pageSize = 50;
  const pageCount = 3;
  const page = makePage({
    responses: defaultResponses({
      [PATHS.history]: (url) => {
        const offset = offsetOf(url) ?? 0;
        const records = [];
        for (let index = 0; index < pageSize && offset + index < total; index += 1) {
          records.push(recordOf(offset + index + 1));
        }
        return {
          payload: historyFixture({
            offset,
            pageLimit: pageSize,
            total,
            pageCount,
            hasMore: offset + pageSize < total,
            records,
          }),
        };
      },
    }),
  });
  let tree = await openHistory(page);

  const pager = () => oneBy(tree, 'data-region', 'history-pager');
  // The numbers are the **response's**, not this bundle's: it never sends a
  // `limit`, it reads `pageLimit` back and steps by it.
  assert.deepEqual(urlsFor(page, PATHS.history), [`${PATHS.history}?layer=user&offset=0`]);
  assert.equal(urlsFor(page, PATHS.history).some((url) => url.includes('limit=')), false);
  assert.equal(pager().props['data-history-page'], '1');
  assert.equal(pager().props['data-history-pages'], '3');
  assert.equal(pager().props['data-history-page-size'], '50');
  assert.equal(pager().props['data-history-offset'], '0');
  assert.ok(hasText(pager(), fillText(page.zh.histPager, { page: 1, pages: 3, total: 120 })));
  assert.equal(historyRowIds(tree).length, 50, 'exactly one page of records is rendered');
  assert.equal(historyRowIds(tree)[0], '1');
  assert.equal(oneBy(pager(), 'data-action', 'history-prev').props.disabled, true, 'page 1 has no previous');
  assert.equal(oneBy(pager(), 'data-action', 'history-next').props.disabled, false);

  clickButton(pager(), { 'data-action': 'history-next' });
  tree = await page.flush();
  assert.deepEqual(urlsFor(page, PATHS.history).slice(-1), [`${PATHS.history}?layer=user&offset=50`]);
  assert.equal(pager().props['data-history-page'], '2');
  assert.equal(oneBy(pager(), 'data-action', 'history-prev').props.disabled, false);
  assert.equal(historyRowIds(tree)[0], '51', 'the second page is a different window');

  clickButton(pager(), { 'data-action': 'history-next' });
  tree = await page.flush();
  assert.deepEqual(urlsFor(page, PATHS.history).slice(-1), [`${PATHS.history}?layer=user&offset=100`]);
  assert.equal(pager().props['data-history-page'], '3');
  assert.equal(oneBy(pager(), 'data-action', 'history-next').props.disabled, true, 'the last page has no next');
  assert.equal(historyRowIds(tree).length, 20, 'the last page holds what is left');

  clickButton(pager(), { 'data-action': 'history-prev' });
  tree = await page.flush();
  assert.deepEqual(urlsFor(page, PATHS.history).slice(-1), [`${PATHS.history}?layer=user&offset=50`]);

  // Back to page 1: 「上一页」 disables itself again rather than asking for -50.
  clickButton(pager(), { 'data-action': 'history-prev' });
  tree = await page.flush();
  assert.equal(pager().props['data-history-offset'], '0');
  assert.equal(oneBy(pager(), 'data-action', 'history-prev').props.disabled, true);
  oneBy(pager(), 'data-action', 'history-prev').props.onClick();
  tree = await page.flush();
  // (The double's `useEffect` re-runs unconditionally, so the assertion is that
  // no request ever asks for a negative offset — the clamp, not the call count.)
  assert.equal(
    urlsFor(page, PATHS.history).every((url) => (offsetOf(url) ?? 0) >= 0),
    true,
    'a clamped step never asks for a negative offset',
  );
  assert.equal(pager().props['data-history-page'], '1');
});

test('client: an out-of-range page from the host is clamped, never rendered as page 6 of 3 (g-038)', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.history]: (url) => ({
        payload: historyFixture({
          offset: offsetOf(url) ?? 0,
          pageLimit: 50,
          total: 120,
          pageCount: 3,
          hasMore: (offsetOf(url) ?? 0) + 50 < 120,
          records: [recordOf(1)],
        }),
      }),
    }),
  });
  let tree = await openHistory(page);
  // A host that answers with an offset past the end — the client must clamp the
  // window into the pages that exist rather than render "page 6 / 3".
  page.router.set(PATHS.history, {
    payload: historyFixture({
      offset: 250,
      pageLimit: 50,
      total: 120,
      pageCount: 3,
      hasMore: false,
      records: [recordOf(101)],
    }),
  });
  clickButton(oneBy(tree, 'data-region', 'history-pager'), { 'data-action': 'history-next' });
  tree = await page.flush();
  const pager = oneBy(tree, 'data-region', 'history-pager');
  assert.equal(pager.props['data-history-page'], '3', 'clamped to the last page that exists');
  assert.equal(pager.props['data-history-pages'], '3');
  assert.equal(pager.props['data-history-offset'], '100', 'the window moved to the last page start');
  assert.equal(oneBy(pager, 'data-action', 'history-next').props.disabled, true);
  assert.equal(oneBy(pager, 'data-action', 'history-prev').props.disabled, false, 'the way back is still offered');
  assert.equal(markerOf(tree, 'data-render-state'), 'ok', 'a bad page is clamped, never an error');
  // Stepping back asks for the page that really precedes the clamped one.
  clickButton(pager, { 'data-action': 'history-prev' });
  tree = await page.flush();
  assert.deepEqual(urlsFor(page, PATHS.history).slice(-1), [`${PATHS.history}?layer=user&offset=50`]);
});

test('client: the record list owns the whole panel, and the preview/comparison are viewport modals (g-039 fifth round)', async () => {
  const many = [];
  for (let index = 1; index <= 50; index += 1) many.push(recordOf(index));
  const page = makePage({
    responses: defaultResponses({
      [PATHS.history]: {
        payload: historyFixture({ records: many, total: 5000, pageLimit: 50, offset: 0, pageCount: 100, hasMore: true }),
      },
    }),
  });
  let tree = await openHistory(page);

  // One column: no second column, no detail box beside the list, no wrapping
  // row — the list takes the panel's full width. This replaces the third round's
  // "two viewport-sized columns" case; the coverage (bounded rendering, internal
  // scroll, the page never growing) is the same, the shape is not.
  const tab = oneBy(tree, 'data-region', 'history-tab');
  assert.equal(tab.props['data-history-layout'], 'single');
  assert.equal(tab.props['data-history-columns'], undefined, 'the two-column marker is gone');
  assert.equal(tab.props.style.display, 'flex');
  assert.equal(tab.props.style.flexDirection, 'column');
  assert.equal(tab.props.style.flexWrap, undefined, 'one column needs no wrapping rule');
  assert.equal(tab.props.style.height, `calc(100vh - ${tab.props['data-history-viewport-offset']}px)`);
  assert.equal(tab.props.style.maxHeight, tab.props.style.height, 'the panel is bounded by the viewport');
  for (const region of ['history-list-column', 'history-detail', 'history-detail-box']) {
    assert.equal(
      collect(tree, (node) => node.props && node.props['data-region'] === region).length,
      0,
      `${region} went with the two-column layout`,
    );
  }
  assert.equal(noHistoryModal(tree), true, 'nothing is open on arrival');

  // The log still renders one page inside its own scrolling box…
  const box = oneBy(tree, 'data-region', 'history-list');
  assert.equal(box.props['data-history-list'], 'scroll');
  assert.equal(box.props.style.overflowY, 'auto', 'the box scrolls, the page does not');
  assert.equal(box.props.style.flex, '1 1 auto');
  assert.equal(box.props.style.minHeight, 0);
  assert.equal(box.props.style.height, undefined, 'no fixed height: the viewport is the bound');
  assert.equal(box.props['data-history-box-height'], 'viewport');
  assert.equal(historyRowIds(tree).length, 50, '5000 records on disk, one page in the DOM');

  // …and a completed pair opens the comparison modal over it, which the list
  // behind it does not care about.
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  clickNode(oneBy(tree, 'data-history-current', 'true'));
  const after = await page.flush();
  assert.ok(oneBy(after, 'data-region', 'history-diff-modal'), 'the comparison lives in a modal');
  assert.equal(
    oneBy(after, 'data-region', 'history-list').props['data-history-list'],
    'scroll',
    'the list is right where it was',
  );
});

// #region g-039: record preview and one-click rollback

/** Every request that is not a plain GET — i.e. every request that could write. */
function mutatingCalls(page) {
  return page.router.calls.filter(
    (call) => call.init && typeof call.init.method === 'string' && call.init.method !== 'GET',
  );
}

test('client: previewing a record opens a modal over the list, and asks the host nothing at all (g-039 fifth round)', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openHistory(page);
  const modal = () => oneBy(tree, 'data-region', 'history-preview-modal');

  clickButton(historyRowOf(tree, '2'), { 'data-action': 'history-preview', 'data-history-id': '2' });
  tree = await page.flush();

  // Positive: the preview is a viewport overlay (`position: fixed`, centred,
  // role=dialog), so the list underneath keeps the panel's full width and none of
  // this grows the panel.
  const overlay = oneBy(tree, 'data-region', 'history-modal-overlay');
  assert.equal(overlay.props.style.position, 'fixed');
  assert.equal(overlay.props['data-history-modal'], 'history-preview-modal');
  assert.equal(modal().props.role, 'dialog');
  assert.equal(modal().props['aria-modal'], 'true');
  assert.equal(modal().props.style.width, 'min(1040px, 92vw)');
  assert.equal(modal().props.style.height, 'min(82vh, 900px)');
  assert.equal(modal().props.style.maxHeight, 'min(82vh, 900px)');
  assert.equal(modal().props.style.overflowY, 'auto', 'a long preview scrolls inside the dialog');
  const preview = oneBy(modal(), 'data-region', 'history-preview');
  assert.equal(preview.props['data-preview-state'], 'ready');
  assert.equal(preview.props['data-preview-id'], '2');
  // …and the record list is still rendered, full width, behind it.
  assert.equal(oneBy(tree, 'data-region', 'history-list').props['data-history-list'], 'scroll');
  assert.equal(oneBy(tree, 'data-region', 'history-tab').props['data-history-layout'], 'single');

  // The facts that say WHICH version this is… g-044 dropped the `name` field:
  // the section a record was written to is a leftover of the era when sections
  // could be added by hand, the write surface is now the single reserved
  // section, and the list row does not show it either — one rule for both.
  for (const [field, label] of [
    ['action', page.zh.histPreviewAction],
    ['at', page.zh.histPreviewAt],
    ['layer', page.zh.histPreviewLayer],
    ['origin', page.zh.histPreviewOrigin],
    ['note', page.zh.histPreviewNote],
  ]) {
    assert.ok(hasText(oneBy(preview, 'data-preview-field', field), label), `${field} is labelled`);
  }
  assert.equal(
    collect(preview, (node) => node.props && node.props['data-preview-field'] === 'name').length,
    0,
    'the preview carries no section-name field',
  );
  assert.equal(page.zh.histPreviewName, undefined, 'and the copy key is gone, not left as a dead entry');
  assert.equal(
    collect(preview, (node) => node.props && node.props['data-preview-field'] === 'layer' && hasText(node, 'project:alpha')).length,
    0,
    'and the row\'s section name is not smuggled into another field',
  );
  assert.ok(hasText(oneBy(preview, 'data-preview-field', 'layer'), page.zh.ovUser));
  assert.ok(hasText(oneBy(preview, 'data-preview-field', 'origin'), 'import'));
  assert.ok(hasText(oneBy(preview, 'data-preview-field', 'note'), 'import mode=merge status=replaced'));
  // …the content on both sides of that write…
  assert.equal(oneBy(preview, 'data-preview-text', 'before').props['data-preview-bytes'], '10');
  assert.ok(hasText(oneBy(preview, 'data-preview-text', 'before'), 'alpha base'));
  assert.ok(hasText(oneBy(preview, 'data-preview-text', 'after'), 'alpha overridden'));
  // …and the whole-layer snapshot that version carried.
  assert.equal(oneBy(preview, 'data-preview-snapshot-count', '1').props['data-preview-snapshot-count'], '1');
  assert.equal(oneBy(preview, 'data-preview-snapshot', 'project:alpha').props['data-preview-snapshot-action'], 'replace');
  assert.ok(
    hasText(
      oneBy(preview, 'data-preview-snapshot', 'project:alpha'),
      fillText(page.zh.histPreviewSnapshotEntry, { name: 'project:alpha', action: 'replace', bytes: 16 }),
    ),
  );
  // g-044: an entry says what the snapshot holds, never which section it holds —
  // the same rule the row and the field list follow. The name is still the
  // node's `data-preview-snapshot`, which is what the lookup above uses.
  assert.equal(
    strings(oneBy(preview, 'data-preview-snapshot', 'project:alpha')).join(' ').includes('project:alpha'),
    false,
    'the snapshot entry renders no section name',
  );

  // The preview is a read of what is already on screen: no write of any kind,
  // and no request to the route a rollback would use.
  assert.deepEqual(mutatingCalls(page), [], 'a preview writes nothing');
  assert.deepEqual(urlsFor(page, PATHS.rollback), [], 'and never touches the rollback route');

  // The explicit close entry point is a button in the dialog's head…
  const close = oneBy(modal(), 'data-action', 'history-modal-close');
  assert.equal(close.props['aria-label'], page.zh.histModalClose);
  clickButton(modal(), { 'data-action': 'history-modal-close' });
  tree = await page.flush();
  assert.equal(noHistoryModal(tree), true, 'the modal is gone');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-region'] === 'history-preview').length,
    0,
    'and so is everything it rendered',
  );

  // …and opening it again is one click, with no toggle to reason about.
  clickButton(historyRowOf(tree, '2'), { 'data-action': 'history-preview', 'data-history-id': '2' });
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-region', 'history-preview').props['data-preview-state'], 'ready');
});

test('client: a page turn keeps the preview modal open, and a record it no longer holds says so (g-039 fifth round)', async () => {
  const page = makePage({
    useSessions: sessionsHook(SESSIONS_STATE),
    responses: defaultResponses({ [PATHS.history]: twoPageHistory }),
  });
  let tree = await openHistory(page);
  clickButton(historyRowOf(tree, '2'), { 'data-action': 'history-preview', 'data-history-id': '2' });
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-region', 'history-preview').props['data-preview-state'], 'ready');

  // Paging does **not** reset it — the same rule the comparison selection
  // follows (§13.3) — so a page that no longer holds the record has to say that
  // rather than render an empty dialog.
  clickButton(oneBy(tree, 'data-region', 'history-pager'), { 'data-action': 'history-next' });
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-region', 'history-pager').props['data-history-offset'], '1');
  const modal = oneBy(tree, 'data-region', 'history-preview-modal');
  assert.equal(oneBy(modal, 'data-region', 'history-preview').props['data-preview-state'], 'missing');
  assert.ok(oneBy(modal, 'data-preview-missing', 'true'));
  // …and the way out is still the explicit close.
  clickButton(modal, { 'data-action': 'history-modal-close' });
  tree = await page.flush();
  assert.equal(noHistoryModal(tree), true);
});

test('client: a rollback asks first, states that it cannot be undone, then refreshes log and value (g-039)', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openHistory(page);

  clickButton(historyRowOf(tree, '1'), { 'data-action': 'history-rollback', 'data-history-id': '1' });
  tree = await page.flush();

  // The second confirmation (CONTRACT §13.5): the version it will apply, and the
  // irreversible statement — and still no write at all.
  const card = oneBy(oneBy(tree, 'data-region', 'confirm-overlay'), 'data-region', 'confirm');
  assert.equal(card.props['data-confirm-kind'], 'rollback');
  assert.ok(hasText(oneBy(card, 'data-role', 'confirm-body'), '#1'));
  assert.ok(hasText(oneBy(card, 'data-role', 'confirm-irreversible'), page.zh.resetIrreversible));
  assert.deepEqual(mutatingCalls(page), [], 'asking is not writing');
  assert.deepEqual(urlsFor(page, PATHS.rollback), [], 'and the question costs no request');

  // Cancelling writes nothing either.
  clickButton(card, { 'data-action': 'confirm-no' });
  tree = await page.flush();
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'confirm-overlay').length, 0);
  assert.deepEqual(mutatingCalls(page), []);

  clickButton(historyRowOf(tree, '1'), { 'data-action': 'history-rollback', 'data-history-id': '1' });
  tree = await page.flush();
  clickButton(oneBy(tree, 'data-region', 'confirm-overlay'), { 'data-action': 'confirm-yes' });
  tree = await page.flush();

  // Exactly one POST, to the documented route, carrying the layer's own scope
  // and the version.
  const posts = mutatingCalls(page);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, `${PATHS.rollback}?layer=user`);
  assert.deepEqual(JSON.parse(posts[0].init.body), { layer: 'user', seq: 1 });
  assert.ok(hasText(tree, fillText(page.zh.histRollbackDone, { id: '1' })));

  // The write invalidated the page's data, so it is re-read from the host rather
  // than patched: the log comes back at page 1 (the file changed under the
  // reader) and the current value is read again, both **after** the POST.
  assert.deepEqual(urlsFor(page, PATHS.history).slice(-1), [`${PATHS.history}?layer=user&offset=0`]);
  const posted = page.router.calls.findIndex((call) => call.init && call.init.method === 'POST');
  const afterWrite = page.router.calls.slice(posted + 1).map((call) => call.url);
  assert.equal(posted >= 0, true, 'the rollback really was sent');
  assert.ok(afterWrite.some((url) => url.startsWith(PATHS.history)), 'the log is re-read after the write');
  assert.ok(afterWrite.some((url) => url.startsWith(PATHS.snapshot)), 'the current value is re-read after the write');
  assert.ok(afterWrite.some((url) => url.startsWith(PATHS.overrides)));
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'history-preview').length, 0);
});

test('client: a refused rollback reports the host answer and leaves the log untouched (g-039)', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.rollback]: {
        status: 409,
        payload: {
          ok: false,
          code: 'history-snapshot-missing',
          message: 'history record #1 carries no whole-layer snapshot, so it cannot be restored safely',
        },
      },
    }),
  });
  let tree = await openHistory(page);
  // A preview is open first: a refused write must not move the reader's view.
  clickButton(historyRowOf(tree, '1'), { 'data-action': 'history-preview', 'data-history-id': '1' });
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-region', 'history-preview').props['data-preview-state'], 'ready');

  clickButton(historyRowOf(tree, '1'), { 'data-action': 'history-rollback', 'data-history-id': '1' });
  tree = await page.flush();
  clickButton(oneBy(tree, 'data-region', 'confirm-overlay'), { 'data-action': 'confirm-yes' });
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-render-state'), 'ok', 'a refusal is a notice, not a broken page');
  assert.ok(hasText(tree, page.zh.histRollbackFailed.replace('{reason}', '')), 'the failure is reported');
  assert.equal(oneBy(tree, 'data-notice', 'error').props['data-notice'], 'error');
  // Nothing changed on disk, so nothing is reset: unlike the success path (which
  // clears the view explicitly), the preview survives a refusal untouched.
  assert.equal(
    oneBy(tree, 'data-region', 'history-preview').props['data-preview-state'],
    'ready',
    'a refused rollback leaves the view exactly as it was',
  );
});

test('client: preview and confirmation both state that only 「我的 Prompt」 is restored (g-039 rework)', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openHistory(page);

  // The fixture's `#2` snapshot names one *other* section, so the page has a
  // version to warn about.
  clickButton(historyRowOf(tree, '2'), { 'data-action': 'history-preview', 'data-history-id': '2' });
  tree = await page.flush();
  const preview = oneBy(tree, 'data-region', 'history-preview');
  const policy = oneBy(preview, 'data-preview-policy', 'reserved-only');
  assert.equal(policy.props['data-preview-policy'], 'reserved-only');
  assert.ok(hasText(policy, page.zh.histPreviewPolicy), 'the preview states the scope of a rollback');
  assert.equal(
    oneBy(preview, 'data-preview-foreign', '1').props['data-preview-foreign'],
    '1',
    'a version that overrode another section is counted',
  );
  assert.ok(hasText(oneBy(preview, 'data-preview-foreign', '1'), fillText(page.zh.histRollbackForeign, { n: 1 })));

  // The confirmation repeats both sentences: nobody confirms the write without
  // seeing what it does and does not restore.
  clickButton(historyRowOf(tree, '2'), { 'data-action': 'history-rollback', 'data-history-id': '2' });
  tree = await page.flush();
  const card = oneBy(oneBy(tree, 'data-region', 'confirm-overlay'), 'data-region', 'confirm');
  assert.equal(card.props['data-confirm-kind'], 'rollback');
  const body = oneBy(card, 'data-role', 'confirm-body');
  assert.ok(hasText(body, page.zh.histRollbackScope), 'the scope is stated');
  assert.ok(hasText(body, fillText(page.zh.histRollbackForeign, { n: 1 })), '…and what is NOT restored');
  assert.ok(hasText(oneBy(card, 'data-role', 'confirm-irreversible'), page.zh.resetIrreversible));
  assert.deepEqual(mutatingCalls(page), [], 'still nothing is written');

  // A version that overrode nothing else states the scope and carries no
  // warning at all.
  clickButton(card, { 'data-action': 'confirm-no' });
  tree = await page.flush();
  clickButton(historyRowOf(tree, '1'), { 'data-action': 'history-preview', 'data-history-id': '1' });
  tree = await page.flush();
  const second = oneBy(tree, 'data-region', 'history-preview');
  assert.ok(hasText(oneBy(second, 'data-preview-policy', 'reserved-only'), page.zh.histPreviewPolicy));
  assert.equal(
    collect(second, (node) => node.props && node.props['data-preview-foreign'] !== undefined).length,
    0,
    'no other section means no warning',
  );
});

test('client: clicking rows builds the pair and opens the comparison modal, which closing keeps (g-039 fifth round)', async () => {
  const records = [recordOf(3), recordOf(2), recordOf(1)];
  const page = makePage({
    responses: defaultResponses({
      [PATHS.history]: {
        payload: historyFixture({ records, total: 3, pageLimit: 20, offset: 0, pageCount: 1, hasMore: false }),
      },
    }),
  });
  let tree = await openHistory(page);
  const diffCalls = () => urlsFor(page, PATHS.diff).length;
  const closeDiff = () => {
    clickButton(oneBy(tree, 'data-region', 'history-diff-modal'), { 'data-action': 'history-modal-close' });
  };

  // The first row fills `from` only: no request, and nothing opens.
  assert.equal(typeof historyRowOf(tree, '3').props.onClick, 'function');
  clickNode(historyRowOf(tree, '3'));
  tree = await page.flush();
  assert.equal(historyRowOf(tree, '3').props['data-history-selected'], 'from');
  assert.equal(diffCalls(), 0, 'a half-made selection is not a request');
  assert.equal(noHistoryModal(tree), true, 'and not a modal either');
  assert.equal(typeof historyRowOf(tree, '3').props['data-history-pick-hint'], 'string');

  // The second row completes the pair: the request fires and the modal opens by
  // itself.
  clickNode(historyRowOf(tree, '2'));
  tree = await page.flush();
  assert.equal(historyRowOf(tree, '3').props['data-history-selected'], 'from');
  assert.equal(historyRowOf(tree, '2').props['data-history-selected'], 'to');
  assert.deepEqual(urlsFor(page, PATHS.diff).slice(-1), [`${PATHS.diff}?layer=user&from=3&to=2`]);
  assert.ok(oneBy(tree, 'data-region', 'history-diff-modal'), 'the comparison opens on its own');

  // Closing it keeps the selection: the pair is the reader's, the modal is only
  // how they were looking at it.
  closeDiff();
  tree = await page.flush();
  assert.equal(noHistoryModal(tree), true);
  assert.equal(historyRowOf(tree, '3').props['data-history-selected'], 'from', 'the pair survives the close');
  assert.equal(historyRowOf(tree, '2').props['data-history-selected'], 'to');

  // A third row slides the window and re-opens the modal on the new pair.
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  assert.equal(historyRowOf(tree, '3').props['data-history-selected'], '');
  assert.equal(historyRowOf(tree, '2').props['data-history-selected'], 'from');
  assert.equal(historyRowOf(tree, '1').props['data-history-selected'], 'to');
  assert.deepEqual(urlsFor(page, PATHS.diff).slice(-1), [`${PATHS.diff}?layer=user&from=2&to=1`]);
  assert.ok(oneBy(tree, 'data-region', 'history-diff-modal'), 'and the modal comes back with it');

  // g-039 sixth round: there are no per-row side buttons. Clearing (in the list's
  // tool row) empties the pair, and picking starts over from the rows.
  closeDiff();
  tree = await page.flush();
  clickButton(tree, { 'data-action': 'diff-clear' });
  tree = await page.flush();
  assert.deepEqual(selectedHistoryRows(tree), []);
  clickNode(historyRowOf(tree, '3'));
  tree = await page.flush();
  assert.equal(historyRowOf(tree, '3').props['data-history-selected'], 'from');
  assert.equal(noHistoryModal(tree), true, 'one side is not a comparison');
});

test('client: clearing the comparison closes the modal and resets the pair (g-039 fifth round)', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openHistory(page);
  clickNode(historyRowOf(tree, '2'));
  tree = await page.flush();
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  const modal = () => oneBy(tree, 'data-region', 'history-diff-modal');
  // g-039 sixth round: the clear control is in the LIST, never inside the dialog.
  assert.equal(oneBy(tree, 'data-action', 'diff-clear').props.disabled, false);

  clickButton(tree, { 'data-action': 'diff-clear' });
  tree = await page.flush();
  assert.equal(noHistoryModal(tree), true, 'the modal goes with the comparison');
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'history-diff').length, 0);
  assert.deepEqual(selectedHistoryRows(tree), [], 'no row claims a side any more');
  assert.equal(historyRowOf(tree, 'current').props['data-history-selected'], 'to', 'back to the default pair');

  // …and picking again works exactly as it did the first time.
  clickNode(historyRowOf(tree, '2'));
  tree = await page.flush();
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  assert.equal(historyRowOf(tree, '2').props['data-history-selected'], 'from');
  assert.ok(oneBy(tree, 'data-region', 'history-diff-modal'));
});

test('client: at most one modal is open, and Esc closes it (g-039 fifth round)', async () => {
  const listeners = {};
  const page = makePage({
    window: {
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      removeEventListener: (type) => {
        delete listeners[type];
      },
    },
    responses: defaultResponses(),
  });
  let tree = await openHistory(page);
  const countOf = (region) => collect(tree, (node) => node.props && node.props['data-region'] === region).length;

  // A preview.
  clickButton(historyRowOf(tree, '2'), { 'data-action': 'history-preview', 'data-history-id': '2' });
  tree = await page.flush();
  assert.equal(countOf('history-preview-modal'), 1);
  assert.equal(countOf('history-diff-modal'), 0, 'the comparison is not open at the same time');

  // Esc is the keyboard half of the close entry point.
  assert.equal(typeof listeners.keydown, 'function', 'the page listens for Esc while a modal is open');
  listeners.keydown({ key: 'Escape' });
  tree = await page.flush();
  assert.equal(noHistoryModal(tree), true);

  // A complete pair opens the comparison instead — still at most one modal.
  clickNode(historyRowOf(tree, '2'));
  tree = await page.flush();
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  assert.equal(countOf('history-diff-modal'), 1);
  assert.equal(countOf('history-preview-modal'), 0, 'the preview modal is not behind it');

  clickButton(oneBy(tree, 'data-region', 'history-diff-modal'), { 'data-action': 'history-modal-close' });
  tree = await page.flush();
  assert.equal(noHistoryModal(tree), true);
  // Esc with nothing open changes nothing (and must not throw).
  if (typeof listeners.keydown === 'function') listeners.keydown({ key: 'Escape' });
  tree = await page.flush();
  assert.equal(noHistoryModal(tree), true);
  assert.equal(markerOf(tree, 'data-render-state'), 'ok');
});

test('client: switching the layer or the scope resets the modal with the selection (g-039 fifth round)', async () => {
  const page = makePage({
    useSessions: sessionsHook(SESSIONS_STATE),
    responses: defaultResponses(),
  });
  let tree = await openHistory(page);

  // Preview open, then a layer switch: the modal describes a record of the old
  // file, so it goes with everything else that pointed into it.
  clickButton(historyRowOf(tree, '2'), { 'data-action': 'history-preview', 'data-history-id': '2' });
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-region', 'history-preview-modal').props.role, 'dialog');
  clickTab(tree, 'history-layer', 'workspace');
  tree = await page.flush();
  assert.equal(noHistoryModal(tree), true, 'a layer switch closes the modal');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-region'] === 'history-preview').length,
    0,
    'and drops the record it was showing',
  );
  assert.deepEqual(selectedHistoryRows(tree), []);
  assert.equal(oneBy(tree, 'data-region', 'history-pager').props['data-history-offset'], '0');

  // The same rule for the scope: a different workspace is a different file.
  clickTab(tree, 'history-layer', 'user');
  tree = await page.flush();
  clickNode(historyRowOf(tree, '2'));
  tree = await page.flush();
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  assert.ok(oneBy(tree, 'data-region', 'history-diff-modal'), 'a comparison is open');
  clickButton(tree, { 'data-action': 'history-scope-toggle' });
  tree = await page.flush();
  clickButton(tree, { 'data-role': 'history-scope-option', 'data-history-scope-option': 's1' });
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-region', 'history-scope').props['data-history-scope-value'], 's1');
  assert.equal(noHistoryModal(tree), true, 'a scope switch closes the modal too');
  assert.deepEqual(selectedHistoryRows(tree), [], 'the old selection is void in the new file');
});

test('client: an open modal locks the page behind it, and unlocks it exactly (g-039 fifth round)', async () => {
  const body = { style: { overflow: 'visible' } };
  const page = makePage({ document: { body }, responses: defaultResponses() });
  let tree = await openHistory(page);
  assert.equal(body.style.overflow, 'visible', 'nothing is locked before anything opens');

  clickButton(historyRowOf(tree, '2'), { 'data-action': 'history-preview', 'data-history-id': '2' });
  tree = await page.flush();
  const modal = oneBy(tree, 'data-region', 'history-preview-modal');
  // The overlay is fixed and the dialog is capped to the viewport, so a long
  // preview scrolls inside the dialog and never the page behind it…
  assert.equal(oneBy(tree, 'data-region', 'history-modal-overlay').props.style.position, 'fixed');
  assert.equal(modal.props.style.height, 'min(82vh, 900px)');
  assert.equal(modal.props.style.maxHeight, 'min(82vh, 900px)');
  assert.equal(modal.props.style.overflowY, 'auto');
  // …and the page behind it is locked outright.
  assert.equal(body.style.overflow, 'hidden', 'the page behind the modal cannot scroll');

  clickButton(modal, { 'data-action': 'history-modal-close' });
  tree = await page.flush();
  assert.equal(noHistoryModal(tree), true);
  assert.equal(body.style.overflow, 'visible', 'and the previous value is restored exactly');

  // The comparison modal locks it the same way.
  clickNode(historyRowOf(tree, '2'));
  tree = await page.flush();
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  assert.ok(oneBy(tree, 'data-region', 'history-diff-modal'));
  assert.equal(body.style.overflow, 'hidden');
});

test('client: a modal closes from its top-right corner, and explains nothing inside (g-039 sixth round)', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openHistory(page);
  clickButton(historyRowOf(tree, '2'), { 'data-action': 'history-preview', 'data-history-id': '2' });
  tree = await page.flush();
  const dialog = oneBy(tree, 'data-region', 'history-preview-modal');
  // The dialog is the positioning context, and the button is anchored in its
  // corner: it cannot drift with the title or the scroll position.
  assert.equal(dialog.props.style.position, 'relative');
  const close = oneBy(dialog, 'data-action', 'history-modal-close');
  assert.equal(close.props.style.position, 'absolute');
  assert.equal(close.props.style.top, 10);
  assert.equal(close.props.style.right, 10);
  assert.equal(close.props['aria-label'], page.zh.histModalClose);
  // …and the how-to sentence lives in the list, never inside a dialog.
  assert.equal(hasText(dialog, page.zh.histCompareHint), false, 'no how-to copy inside the dialog');
  assert.equal(
    collect(dialog, (node) => node.props && node.props['data-role'] === 'history-compare-hint').length,
    0,
  );

  clickButton(dialog, { 'data-action': 'history-modal-close' });
  tree = await page.flush();
  assert.equal(noHistoryModal(tree), true, 'the corner button closes it');

  // The comparison dialog is built the same way.
  clickNode(historyRowOf(tree, '2'));
  tree = await page.flush();
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  const diff = oneBy(tree, 'data-region', 'history-diff-modal');
  assert.equal(oneBy(diff, 'data-action', 'history-modal-close').props.style.position, 'absolute');
  assert.equal(hasText(diff, page.zh.histCompareHint), false);
});

test('client: clearing the comparison lives in the list, never in the dialog (g-039 sixth round)', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openHistory(page);
  clickNode(historyRowOf(tree, '2'));
  tree = await page.flush();
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  const dialog = oneBy(tree, 'data-region', 'history-diff-modal');

  // Negative: the dialog holds no control that acts on the list's selection.
  assert.equal(
    collect(dialog, (node) => node.props && node.props['data-action'] === 'diff-clear').length,
    0,
    'the dialog carries no diff-clear',
  );
  // Positive: the list has its own tool row, and that control works.
  const tools = oneBy(tree, 'data-region', 'history-diff-tools');
  assert.equal(oneBy(tools, 'data-action', 'diff-clear').props.disabled, false);
  clickButton(tools, { 'data-action': 'diff-clear' });
  tree = await page.flush();
  assert.equal(noHistoryModal(tree), true, 'clearing closes the dialog');
  assert.deepEqual(selectedHistoryRows(tree), [], 'and empties the pair');
  assert.equal(historyRowOf(tree, 'current').props['data-history-selected'], 'to', 'back to the default pair');
});

test('client: the preview dialog renders a timestamp the way a list row does (g-039 sixth round)', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openHistory(page);
  const expected = localStampOf('2024-01-02T10:00:00.000Z');
  assert.ok(hasText(historyRowOf(tree, '2'), expected), 'the row shows the reader-zone stamp');

  clickButton(historyRowOf(tree, '2'), { 'data-action': 'history-preview', 'data-history-id': '2' });
  tree = await page.flush();
  const value = oneBy(oneBy(tree, 'data-region', 'history-preview'), 'data-preview-field', 'at');
  assert.ok(hasText(value, expected), 'and so does the dialog, character for character');
  assert.equal(
    strings(value).join(' ').includes('2024-01-02T10:00:00.000Z'),
    false,
    'the raw UTC string is never rendered as the value',
  );
  // …it is still reachable as the node's `title`, exactly as on a row.
  const titled = oneBy(value, 'title', '2024-01-02T10:00:00.000Z');
  assert.equal(titled.props.title, '2024-01-02T10:00:00.000Z');
});

test('client: rows have no from/to buttons, and the live value is picked by clicking it (g-039 sixth round)', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openHistory(page);
  // Negative: the per-row side buttons are gone from every row, the live-value
  // row included.
  for (const action of ['diff-from', 'diff-to']) {
    assert.equal(
      collect(tree, (node) => node.props && node.props['data-action'] === action).length,
      0,
      `${action} is gone`,
    );
  }
  // Positive: 「当前生效值」 is a pick control like any row…
  const current = historyRowOf(tree, 'current');
  assert.equal(current.props['data-action'], 'history-row-pick');
  assert.equal(current.props.style.cursor, 'pointer');
  assert.equal(typeof current.props.onClick, 'function');
  // …so one record plus the live value is a comparison, in two clicks.
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  assert.equal(historyRowOf(tree, '1').props['data-history-selected'], 'from');
  assert.equal(noHistoryModal(tree), true, 'one side is not a comparison');
  clickNode(historyRowOf(tree, 'current'));
  tree = await page.flush();
  assert.equal(historyRowOf(tree, 'current').props['data-history-selected'], 'to');
  assert.deepEqual(urlsFor(page, PATHS.diff).slice(-1), [`${PATHS.diff}?layer=user&from=1&to=current`]);
});

test('client: the list states how to compare, right below the scope sentence (g-039 sixth round)', async () => {
  const page = makePage({ responses: defaultResponses() });
  const tree = await openHistory(page);
  const scope = oneBy(tree, 'data-region', 'history-scope');
  const hint = oneBy(scope, 'data-role', 'history-compare-hint');
  assert.ok(hasText(hint, page.zh.histCompareHint), 'the how-to line is there, in the reader\'s language');
  // Both sentences still exist, in this order — but since g-044 they share one
  // wrapping flex row (`key: 'scope-lines'`) instead of being two stacked
  // siblings: three stacked lines above the list were three rows of history the
  // reader never got to see.
  const lines = oneBy(scope, 'key', 'scope-lines');
  const kids = Array.isArray(lines.props.children) ? lines.props.children : [lines.props.children];
  const order = kids
    .filter((kid) => kid && kid.props && (kid.props['data-role'] === 'history-scope-note' || kid.props['data-role'] === 'history-compare-hint'))
    .map((kid) => kid.props['data-role']);
  assert.deepEqual(order, ['history-scope-note', 'history-compare-hint']);
  assert.equal(lines.props.style.display, 'flex', 'one line, not three');
  assert.equal(lines.props.style.flexWrap, 'wrap', 'and it wraps instead of overflowing');
  // The comparison's own control sits next to the list, not in a dialog.
  assert.ok(oneBy(oneBy(tree, 'data-region', 'history-diff-tools'), 'data-action', 'diff-clear'));
  assert.equal(noHistoryModal(tree), true);
});

// #region g-039 fourth round: the panel height is measured, not guessed

/**
 * A fake panel element whose geometry a measuring case can pin.
 *
 * The double renders no DOM, so a case that wants the measuring path hands the
 * page this instead: an element with a `getBoundingClientRect` and (by default)
 * one scrollable ancestor above it. `scroller: false` models the other shape —
 * no scrollable ancestor, so the viewport is the boundary.
 * @param options - `top`, `scrollerBottom`, `scroller`.
 * @returns `{panel, ancestor}`.
 */
function measuredPanel({ top = 200, scrollerBottom = 900, scroller = true } = {}) {
  // Mutable, so a case can move the world and ask for a re-measure.
  const state = { top, scrollerBottom };
  const ancestor = {
    getBoundingClientRect: () => ({
      top: 0,
      bottom: state.scrollerBottom,
      left: 0,
      right: 700,
      width: 700,
      height: state.scrollerBottom,
    }),
  };
  return {
    ancestor,
    state,
    panel: {
      parentElement: scroller ? ancestor : null,
      getBoundingClientRect: () => ({ top: state.top, bottom: state.top + 100, left: 0, right: 700, width: 700, height: 100 }),
    },
  };
}

test('client: the panel height resolver measures the boundary, clamps and falls back (g-039 fourth round)', () => {
  const resolve = loadClient('ok').module.__internals.historyPanelHeight;
  assert.equal(typeof resolve, 'function');
  // The resolver runs inside the sandbox realm, so a case compares its answer as
  // plain text rather than as an object built in a different realm.
  const shape = (value) => `${String(value.height)}/${String(value.source)}`;

  // Measured: the room between the panel's top and the bottom of the thing that
  // would scroll, minus the gap.
  assert.equal(shape(resolve({ panelTop: 200, boundaryBottom: 900, viewportHeight: 1200, minHeight: 320, gap: 16 })), '684/measured');
  // No scrollable ancestor is not a failure — the viewport is the boundary that
  // always exists in a browser.
  assert.equal(shape(resolve({ panelTop: 200, boundaryBottom: null, viewportHeight: 1200, minHeight: 320, gap: 16 })), '984/measured');
  // The gap is real, and it is subtracted BEFORE the clamp.
  assert.equal(shape(resolve({ panelTop: 100, boundaryBottom: 500, viewportHeight: 1200, minHeight: 320, gap: 0 })), '400/measured');
  assert.equal(shape(resolve({ panelTop: 100, boundaryBottom: 500, viewportHeight: 1200, minHeight: 320, gap: 40 })), '360/measured');
  // A panel pushed far down is clamped UP to the floor, never to a negative box.
  assert.equal(shape(resolve({ panelTop: 900, boundaryBottom: 950, viewportHeight: 1200, minHeight: 320, gap: 16 })), '320/measured');
  // An unusable floor falls back to the shipped minimum rather than to 0, and a
  // missing gap is no gap.
  assert.equal(shape(resolve({ panelTop: 100, boundaryBottom: 300, viewportHeight: 1200, minHeight: 0, gap: 0 })), '320/measured');
  assert.equal(shape(resolve({ panelTop: 100, boundaryBottom: 300, viewportHeight: 1200 })), '320/measured');

  // Unusable inputs ⇒ the constant path, never a nonsense number.
  for (const inputs of [
    {},
    null,
    { panelTop: 0, boundaryBottom: 900, viewportHeight: 1200 },
    { panelTop: null, boundaryBottom: 900, viewportHeight: 1200 },
    { panelTop: Number.NaN, boundaryBottom: 900, viewportHeight: 1200 },
    { panelTop: 200 },
    { panelTop: 200, boundaryBottom: 0, viewportHeight: 0 },
    { panelTop: 200, boundaryBottom: null, viewportHeight: null },
    // A boundary that is not below the panel is not a height either.
    { panelTop: 500, boundaryBottom: 500, viewportHeight: 1200, minHeight: 320, gap: 16 },
    { panelTop: 500, boundaryBottom: 100, viewportHeight: 1200, minHeight: 320, gap: 16 },
  ]) {
    assert.equal(shape(resolve(inputs)), 'null/fallback', JSON.stringify(inputs));
  }
});

test('client: a measured panel renders the measured height, and says where it came from (g-039 fourth round)', async () => {
  const { panel, ancestor } = measuredPanel({ top: 200, scrollerBottom: 900 });
  const page = makePage({
    refs: [panel],
    window: {
      innerHeight: 1200,
      getComputedStyle: (node) => ({ overflowY: node === ancestor ? 'auto' : 'visible' }),
    },
    responses: defaultResponses(),
  });
  const tree = await openHistory(page);
  const tab = oneBy(tree, 'data-region', 'history-tab');
  // 900 (the scrollable ancestor's bottom) − 200 (the panel's top) − 8 (the gap;
  // halved from 16 in g-044 — it is subtracted from a measured room, so the
  // panel simply gets those pixels).
  assert.equal(tab.props['data-history-height-source'], 'measured');
  assert.equal(tab.props['data-history-panel-height'], '692');
  assert.equal(tab.props.style.height, '692px');
  assert.equal(tab.props.style.maxHeight, '692px');
  assert.equal(tab.props.style.minHeight, 320, 'the floor stays whatever the measurement says');
  // The layout itself is untouched by the measuring: one column, and the record
  // box filling whatever height is left.
  assert.equal(tab.props.style.flexDirection, 'column');
  assert.equal(tab.props['data-history-layout'], 'single');
  assert.equal(oneBy(tree, 'data-region', 'history-list').props.style.flex, '1 1 auto');
  assert.equal(oneBy(tree, 'data-region', 'history-list').props.style.minHeight, 0);
});

test('client: a window resize re-measures the panel, and still nothing else moves (g-039 fourth round)', async () => {
  const { panel, ancestor, state } = measuredPanel({ top: 200, scrollerBottom: 900 });
  const listeners = {};
  const page = makePage({
    refs: [panel],
    window: {
      innerHeight: 1200,
      getComputedStyle: (node) => ({ overflowY: node === ancestor ? 'auto' : 'visible' }),
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      removeEventListener: (type) => {
        delete listeners[type];
      },
    },
    responses: defaultResponses(),
  });
  let tree = await openHistory(page);
  assert.equal(oneBy(tree, 'data-region', 'history-tab').props['data-history-panel-height'], '692');
  assert.equal(typeof listeners.resize, 'function', 'the page listens for a resize');

  // The dialog gets shorter: the boundary moves, so the panel must too.
  state.scrollerBottom = 700;
  listeners.resize();
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-region', 'history-tab').props['data-history-panel-height'], '492');
  assert.equal(oneBy(tree, 'data-region', 'history-tab').props['data-history-height-source'], 'measured');

  // A boundary that leaves no room at all is a fallback, not a broken panel.
  state.top = 900;
  listeners.resize();
  tree = await page.flush();
  const tab = oneBy(tree, 'data-region', 'history-tab');
  assert.equal(tab.props['data-history-height-source'], 'fallback');
  assert.equal(tab.props['data-history-layout'], 'single', 'the layout rule survives every measuring outcome');
});

// #endregion

/**
 * Whether no history modal is open — the fifth-round shape of "the detail pane
 * is in its idle state".
 * @param tree - the rendered tree.
 * @returns whether both modals are absent.
 */
function noHistoryModal(tree) {
  return collect(tree, (node) => node.props && node.props['data-region'] === 'history-modal-overlay').length === 0;
}

/** Every history **record** row that currently claims a comparison selection. */
function selectedHistoryRows(tree) {
  return collect(
    tree,
    (node) =>
      node.props
      && node.props['data-history-action'] !== undefined
      && typeof node.props['data-history-selected'] === 'string'
      && node.props['data-history-selected'] !== '',
  );
}

/**
 * A log whose every page holds one record, newest first: page 1 is `#2`, page 2
 * is `#1`. `offset` comes from the request, so paging really moves the window.
 */
function twoPageHistory(url) {
  const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset') ?? 0);
  const pages = [recordOf(2), recordOf(1)];
  return {
    payload: historyFixture({
      offset,
      pageLimit: 1,
      total: 2,
      pageCount: 2,
      hasMore: offset === 0,
      records: [pages[offset]],
    }),
  };
}

test('client: the history scope is one summary line, and its picker opens on 「更改」 (g-038)', async () => {
  const page = makePage({
    useSessions: sessionsHook(WORKSPACE_SESSIONS),
    useWorkspaces: workspacesHook(workspacesFixture()),
    responses: defaultResponses(),
  });
  let tree = await openHistory(page);
  const scope = () => oneBy(tree, 'data-region', 'history-scope');

  // Shut by default: exactly one summary row and **no** candidate control, so the
  // panel's height does not grow with the number of workspaces.
  assert.equal(scope().props['data-scope-open'], 'false');
  assert.equal(scope().props['data-history-scope-mode'], 'workspaces');
  assert.equal(scope().props['data-history-scope-options'], '2', 'the count is the candidate total');
  assert.equal(scope().props['data-history-scope-value'], 'a1');
  assert.equal(scope().props['data-history-scope-applies'], 'false', 'the user layer is global');
  assert.ok(hasText(oneBy(tree, 'data-region', 'history-scope-summary'), 'Alpha repo'), 'the summary names the current scope');
  assert.ok(oneBy(tree, 'data-role', 'history-scope-summary-label'));
  assert.equal(collect(tree, (node) => node.props && node.props['data-role'] === 'history-scope-option').length, 0);
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'history-scope-picker').length, 0);
  assert.equal(collect(tree, (node) => node.props && node.props['data-role'] === 'history-scope-search').length, 0);
  assert.ok(oneBy(tree, 'data-region', 'history-scope-summary'), 'and one row is all there is');
  const toggle = oneBy(tree, 'data-action', 'history-scope-toggle');
  assert.equal(toggle.props['aria-expanded'], false);
  assert.equal(toggle.props['data-expanded'], 'false');
  assert.ok(hasText(toggle, page.zh.scopeEdit), 'the page-level 「更改」 copy is reused');

  // 「更改」 opens it: a search box and a bounded, scrolling candidate list.
  clickButton(tree, { 'data-action': 'history-scope-toggle' });
  tree = await page.flush();
  assert.equal(scope().props['data-scope-open'], 'true');
  assert.ok(hasText(oneBy(tree, 'data-action', 'history-scope-toggle'), page.zh.scopeCollapse));
  assert.ok(oneBy(tree, 'data-region', 'history-scope-picker'));
  const search = oneBy(tree, 'data-role', 'history-scope-search');
  assert.equal(search.props['data-role'], 'history-scope-search');
  const list = oneBy(tree, 'data-history-scope-list', 'scroll');
  assert.equal(list.props.style.overflowY, 'auto', 'the candidates scroll inside their own box');
  assert.equal(typeof list.props.style.height, 'number');
  assert.equal(list.props.style.maxHeight, list.props.style.height, 'the box height is fixed');
  assert.equal(collect(tree, (node) => node.props && node.props['data-role'] === 'history-scope-option').length, 2);
  assert.equal(oneBy(tree, 'data-history-scope-option', 'a1').props['data-selected'], 'true');
  assert.equal(oneBy(tree, 'data-history-scope-option', 'b1').props['data-selected'], 'false');
  assert.ok(hasText(oneBy(tree, 'data-history-scope-option', 'b1'), 'beta-dir'), 'a title-less workspace falls back to its directory');

  // The search box narrows the candidates and moves nothing else.
  typeInto(tree, 'history-scope-search', 'beta');
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-history-scope-list', 'scroll').props['data-history-scope-shown'], '1');
  assert.ok(oneBy(tree, 'data-history-scope-option', 'b1'));
  assert.equal(scope().props['data-history-scope-options'], '2', 'the total is not the match count');
  assert.equal(scope().props['data-history-scope-value'], 'a1', 'searching does not move the scope');

  // A search with no match says so inside the box, rather than rendering nothing.
  typeInto(tree, 'history-scope-search', 'zzz-no-such-workspace');
  tree = await page.flush();
  assert.ok(oneBy(tree, 'data-role', 'history-scope-no-match'));
  assert.equal(collect(tree, (node) => node.props && node.props['data-role'] === 'history-scope-option').length, 0);

  // Picking one applies it and finishes the interaction: the picker collapses
  // and the search is dropped, like the page-level picker (§13.7).
  typeInto(tree, 'history-scope-search', '');
  tree = await page.flush();
  clickButton(tree, { 'data-role': 'history-scope-option', 'data-history-scope-option': 'b1' });
  tree = await page.flush();
  assert.equal(scope().props['data-scope-open'], 'false');
  assert.equal(scope().props['data-history-scope-value'], 'b1');
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'history-scope-picker').length, 0);
  assert.equal(collect(tree, (node) => node.props && node.props['data-role'] === 'history-scope-search').length, 0, 'the search box is gone with the picker');
  assert.ok(hasText(oneBy(tree, 'data-region', 'history-scope-summary'), 'beta-dir'), 'the summary names the new scope');
  // The sentence that states the scope follows it too — read on the workspace
  // layer, where it names the workspace and the session that located it.
  clickTab(tree, 'history-layer', 'workspace');
  tree = await page.flush();
  assert.ok(hasText(oneBy(tree, 'data-role', 'history-scope-note'), 'beta-dir'), 'and the sentence does too');
});

test('client: a history scope with no candidate keeps the existing note and grows no picker (g-038)', async () => {
  // No hooks at all: neither a workspace list nor a session catalog exists, which
  // is the degraded profile this must survive.
  const page = makePage({ responses: defaultResponses() });
  let tree = await openHistory(page);
  const scope = () => oneBy(tree, 'data-region', 'history-scope');
  assert.equal(scope().props['data-history-scope-mode'], 'none');
  assert.equal(scope().props['data-history-scope-options'], '0');
  assert.equal(scope().props['data-scope-open'], 'false');
  assert.equal(oneBy(scope(), 'data-role', 'history-scope-empty').props['data-role'], 'history-scope-empty');
  assert.ok(hasText(scope(), page.zh.histScopeNone), 'the existing「no scope」copy is the whole summary');
  assert.equal(collect(tree, (node) => node.props && node.props['data-action'] === 'history-scope-toggle').length, 0, 'there is nothing to expand');
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'history-scope-picker').length, 0);
  assert.equal(oneBy(tree, 'data-role', 'history-scope-note').props['data-history-note'], 'global');
  assert.equal(urlsFor(page, PATHS.history).length, 1);

  // The workspace layer keeps its own「needs a session」note, and still asks for
  // nothing it knows the host would refuse.
  clickTab(tree, 'history-layer', 'workspace');
  tree = await page.flush();
  assert.equal(scope().props['data-history-scope-applies'], 'true');
  assert.equal(oneBy(scope(), 'data-history-note', 'no-session').props['data-history-note'], 'no-session');
  assert.equal(oneBy(scope(), 'data-role', 'history-scope-empty').props['data-role'], 'history-scope-empty');
  assert.equal(urlsFor(page, PATHS.history).length, 1, 'no request without a scope');
});

test('client: switching the layer or the scope drops a comparison made in the other file (g-038 fix)', async () => {
  const page = makePage({
    useSessions: sessionsHook(SESSIONS_STATE),
    responses: defaultResponses({ [PATHS.history]: twoPageHistory }),
  });
  let tree = await openHistory(page);

  // A selection is made against a *page* of the user log, which is one specific
  // file; page 2 also proves the offset is reset below.
  clickButton(oneBy(tree, 'data-region', 'history-pager'), { 'data-action': 'history-next' });
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-region', 'history-pager').props['data-history-offset'], '1');
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  clickNode(oneBy(tree, 'data-history-current', 'true'));
  tree = await page.flush();
  assert.equal(historyRowOf(tree, '1').props['data-history-selected'], 'from');
  assert.ok(oneBy(tree, 'data-region', 'history-diff-modal'), 'a complete pair opens the comparison modal');
  const diffsMade = urlsFor(page, PATHS.diff).length;

  // Switching the layer switches the file: the selection and the result describe
  // a record that the new file may not even contain, so both must go.
  clickTab(tree, 'history-layer', 'workspace');
  tree = await page.flush();
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'history').length, 1);
  assert.equal(oneBy(tree, 'data-region', 'history-pager').props['data-history-offset'], '0', 'the new file starts at page 1');
  assert.deepEqual(selectedHistoryRows(tree), [], 'no record claims a selection any more');
  assert.equal(
    historyRowOf(tree, 'current').props['data-history-selected'],
    'to',
    'the comparison target is back to its default (「当前生效值」)',
  );
  // A new file closes the modal *and* drops the result (g-039 fifth round): the
  // modal describes a comparison of two records of the old file, so leaving it
  // open would be describing a file that is no longer on screen.
  assert.equal(noHistoryModal(tree), true, 'no modal survives a new file');
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'history-diff').length, 0);
  assert.equal(collect(tree, (node) => node.props && node.props['data-diff-sections'] !== undefined).length, 0);
  assert.equal(urlsFor(page, PATHS.diff).length, diffsMade, 'and nothing new was requested');

  // The same rule for the scope: a different workspace is a different file.
  clickTab(tree, 'history-layer', 'user');
  tree = await page.flush();
  clickButton(oneBy(tree, 'data-region', 'history-pager'), { 'data-action': 'history-next' });
  tree = await page.flush();
  clickNode(historyRowOf(tree, '1'));
  tree = await page.flush();
  clickNode(oneBy(tree, 'data-history-current', 'true'));
  tree = await page.flush();
  assert.equal(historyRowOf(tree, '1').props['data-history-selected'], 'from');
  assert.equal(oneBy(tree, 'data-region', 'history-pager').props['data-history-offset'], '1');
  clickButton(tree, { 'data-action': 'history-scope-toggle' });
  tree = await page.flush();
  clickButton(tree, { 'data-role': 'history-scope-option', 'data-history-scope-option': 's1' });
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-region', 'history-scope').props['data-history-scope-value'], 's1');
  assert.equal(oneBy(tree, 'data-region', 'history-pager').props['data-history-offset'], '0', 'page 1 of the new log');
  assert.deepEqual(selectedHistoryRows(tree), [], 'the old selection is void in the new file');
  assert.equal(
    historyRowOf(tree, 'current').props['data-history-selected'],
    'to',
    'the comparison target is back to its default',
  );
  assert.equal(noHistoryModal(tree), true);
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'history-diff').length, 0);
  assert.equal(collect(tree, (node) => node.props && node.props['data-diff-sections'] !== undefined).length, 0);
});

test('client: paging keeps the comparison, because the file does not change (g-038 fix)', async () => {
  const page = makePage({ responses: defaultResponses({ [PATHS.history]: twoPageHistory }) });
  let tree = await openHistory(page);

  clickNode(historyRowOf(tree, '2'));
  tree = await page.flush();
  clickNode(oneBy(tree, 'data-history-current', 'true'));
  tree = await page.flush();
  assert.equal(historyRowOf(tree, '2').props['data-history-selected'], 'from');
  assert.ok(oneBy(tree, 'data-region', 'history-diff-modal'), 'a complete pair opens the comparison modal');
  const diffsMade = urlsFor(page, PATHS.diff).length;

  // A page turn is **not** a new file: §13.3's reset covers a layer/scope change
  // only, so the selection and its result survive — and are not re-requested.
  clickButton(oneBy(tree, 'data-region', 'history-pager'), { 'data-action': 'history-next' });
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-region', 'history-pager').props['data-history-offset'], '1');
  assert.ok(oneBy(tree, 'data-region', 'history-diff-modal'), 'the modal is kept across a page turn');
  assert.equal(urlsFor(page, PATHS.diff).length, diffsMade, 'the comparison is kept, not re-run');

  clickButton(oneBy(tree, 'data-region', 'history-pager'), { 'data-action': 'history-prev' });
  tree = await page.flush();
  assert.equal(historyRowOf(tree, '2').props['data-history-selected'], 'from', 'back on page 1 the row is still selected');
});

// #endregion

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

/** The export file name the transfer sweep must see: the reader's zone, one source. */
const EN_SWEEP_EXPORT_NAME = localFileNameOf('2024-01-02T10:00:00.000Z');

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
    name: 'history: the log, its own scope, the paging box and the comparison',
    marks: [
      ['data-region', 'history-tab'],
      ['data-region', 'history'],
      ['data-region', 'history-scope'],
      ['data-role', 'history-scope-empty'],
      ['data-region', 'history-list'],
      ['data-region', 'history-pager'],
      ['data-history-row', '2'],
      ['data-active-tab', 'history'],
      // g-039 fifth round: the preview and the comparison are modals now, and
      // this case walks both so their English copy is swept too.
      ['data-region', 'history-modal-overlay'],
      ['data-region', 'history-preview-modal'],
      ['data-region', 'history-diff-modal'],
      // g-039 sixth round: the how-to line and the comparison's one control live
      // in the list, and neither is inside a dialog.
      ['data-role', 'history-compare-hint'],
      ['data-region', 'history-diff-tools'],
      ['data-action', 'diff-clear'],
    ],
    copy: ['histHeading', 'histScopeHint', 'histCompareHint', 'histScopeNone', 'histPagePrev', 'histScopeGlobal'],
    async run() {
      const page = enPage({ responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'history');
      await rec.take();
      clickButton(historyRowOf(rec.last(), '2'), { 'data-action': 'history-preview', 'data-history-id': '2' });
      await rec.take();
      clickButton(rec.last(), { 'data-action': 'history-modal-close' });
      await rec.take();
      clickNode(historyRowOf(rec.last(), '2'));
      await rec.take();
      clickNode(oneBy(rec.last(), 'data-history-current', 'true'));
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'history: the scope disclosure — one summary row, a picker, its search and its empty result',
    marks: [
      ['data-region', 'history-scope'],
      ['data-region', 'history-scope-summary'],
      ['data-role', 'history-scope-summary-label'],
      ['data-action', 'history-scope-toggle'],
      ['data-region', 'history-scope-picker'],
      ['data-role', 'history-scope-search'],
      ['data-history-scope-list', 'scroll'],
      ['data-role', 'history-scope-option'],
      ['data-role', 'history-scope-no-match'],
      ['data-scope-open', 'true'],
    ],
    copy: ['histScopeSearch', 'histScopeNoMatch', 'scopeEdit', 'scopeCollapse'],
    async run() {
      const page = enPage({
        useSessions: sessionsHook(WORKSPACE_SESSIONS),
        useWorkspaces: workspacesHook(workspacesFixture()),
        responses: defaultResponses(),
      });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'history');
      await rec.take();
      clickButton(rec.last(), { 'data-action': 'history-scope-toggle' });
      await rec.take();
      typeInto(rec.last(), 'history-scope-search', 'zzz-no-such-workspace');
      await rec.take();
      return rec.trees;
    },
  },
  {
    name: 'backup: the export / import surface, on its own tab',
    marks: [
      ['data-region', 'backup-tab'],
      ['data-region', 'transfer'],
      ['data-active-tab', 'backup'],
    ],
    copy: ['transferHeading', 'exportButton', 'importApplyButton'],
    async run() {
      const page = enPage({ responses: defaultResponses() });
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'backup');
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
      clickNode(historyRowOf(rec.last(), '2'));
      await rec.take();
      clickNode(historyRowOf(rec.last(), '1'));
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
      clickNode(historyRowOf(rec.last(), '1'));
      await rec.take();
      clickNode(oneBy(rec.last(), 'data-history-current', 'true'));
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
      clickAnyTab(rec.last(), 'backup');
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
      clickAnyTab(rec.last(), 'backup');
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
      clickAnyTab(rec.last(), 'backup');
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
      clickAnyTab(rec.last(), 'backup');
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
      ['data-export-name', EN_SWEEP_EXPORT_NAME],
      ['data-notice', 'success'],
    ],
    copy: ['exportButton', ['downloadDone', { name: EN_SWEEP_EXPORT_NAME }], 'exportPreviewLabel'],
    async run() {
      const page = enPage({ useSessions: sessionsHook(SESSIONS_STATE), responses: defaultResponses() });
      installDownloader(page);
      const rec = recorder(page);
      await rec.take();
      clickAnyTab(rec.last(), 'backup');
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
      clickAnyTab(rec.last(), 'backup');
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
      ['data-action', 'mine-cancel'],
      ['data-active-tab', 'mine'],
    ],
    copy: ['tabMine', 'mineHeading', 'mineNote', 'mineTextLabel', 'mineSave', 'mineCancel', 'mineReset', 'mineUnconfigured', 'mineDirty', ['mineSaved', { layer: 'user layer' }]],
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
      // g-029: the version tag rides on the same ping, so the same walk covers
      // both its answered and its missing form.
      ['data-plugin-version', packageJson.version],
      ['data-plugin-version', 'unknown'],
      // Revision 17: the version moved beside the page title and became a link
      // when the host reports a repository. All three of its forms must be
      // walked: the link, the plain-text fallback, and the node itself.
      ['data-role', 'plugin-version'],
      ['data-plugin-repository', FIXTURE_REPOSITORY_URL],
      ['data-plugin-repository', 'unknown'],
    ],
    copy: ['stBuild', 'stBuildSame', 'stBuildStale', 'stBuildStaleHint', 'stBuildUnknown', 'stBuildUnknownHint', 'stBuildPingFailedHint', 'stateHeading', 'stBuildSelf', 'stBuildServer', 'stPluginVersion', 'stPluginVersionUnknown'],
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
      clickNode(historyRowOf(rec.last(), '2'));
      await rec.take();
      clickNode(historyRowOf(rec.last(), '1'));
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
  // g-015: the first-level tabs and the surfaces they own — five since g-038
  // split 「历史与备份」 into 「版本历史」 and 「备份与恢复」.
  'data-region=tabs',
  'data-region=tab-panel',
  'data-active-tab=mine',
  'data-active-tab=overview',
  'data-active-tab=history',
  'data-active-tab=backup',
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
  'data-region=history-scope',
  'data-region=history-scope-summary',
  'data-region=history-scope-picker',
  'data-role=history-scope-summary-label',
  'data-role=history-scope-search',
  'data-role=history-scope-option',
  'data-role=history-scope-no-match',
  'data-history-scope-list=scroll',
  'data-region=history-list',
  'data-region=history-pager',
  'data-region=history-modal-overlay',
  'data-region=history-preview-modal',
  'data-region=history-diff-modal',
  'data-region=history-diff',
  'data-region=history-diff-tools',
  'data-action=diff-clear',
  'data-role=history-compare-hint',
  'data-region=backup-tab',
  'data-region=transfer',
  'data-region=layer-reset',
  'data-region=confirm',
  // A confirmation is a fixed, centered overlay rather than an inline card, so
  // the trigger's place in the page flow never decides where it lands.
  'data-region=confirm-overlay',
  // The dialog's three typographic levels are structural, not just styling.
  'data-role=confirm-body',
  'data-role=confirm-irreversible',
  'data-role=confirm-actions',
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
  // g-027: the third control of the write surface — the one that only drops an
  // unsaved draft — must exist for the en sweep to have seen it rendered.
  'data-action=mine-cancel',
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
  // g-029: the plugin version is shown beside the build stamp, in both the
  // answered form (the version the host really sends) and the missing one.
  `data-plugin-version=${packageJson.version}`,
  'data-plugin-version=unknown',
  // Revision 17: the version node beside the title, in its linked form (the URL
  // the fixture host reports) and its plain-text form (no URL answered).
  'data-role=plugin-version',
  `data-plugin-repository=${FIXTURE_REPOSITORY_URL}`,
  'data-plugin-repository=unknown',
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

// ---------------------------------------------------------------------------
// g-027: 「取消」 on「我的 Prompt」 — drop the unsaved draft, keep the stored text.
//
// It exists to be the *safe* counterpart of 「恢复默认」: that one deletes what
// the layer stored (a server DELETE, confirmed first), this one throws away only
// what was typed and never left the page. So the assertions here are mostly
// negative — no request, no confirmation, no byte moved — plus the two states
// the panel has to be in for the button to be offered at all.
// ---------------------------------------------------------------------------

test('g-027 client: 「取消」 drops the unsaved draft, restores the stored text and writes nothing', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.overrides]: {
        payload: overridesFixture({
          merged: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'stored text', layer: 'user' }] },
        }),
      },
    }),
  });
  let tree = await page.flush();

  // A clean box has nothing to cancel, and says so by being disabled — the same
  // shape 「恢复默认」 uses for "there is nothing stored to delete".
  assert.equal(oneBy(tree, 'data-role', 'mine-text').props.value, 'stored text');
  assert.equal(markerOf(tree, 'data-mine-state'), 'idle');
  const clean = oneBy(tree, 'data-action', 'mine-cancel');
  assert.equal(clean.props.disabled, true, 'nothing unsaved ⇒ 「取消」 is greyed out');
  assert.equal(clean.props['data-mine-layer'], 'user', 'like its two neighbours, it names the layer');
  assert.equal(clean.props.children, page.zh.mineCancel, 'and it carries the localized label');
  assert.ok(strings(tree).includes(fillText(page.zh.mineLoaded, { layer: page.zh.ovUser })));

  typeInto(tree, 'mine-text', 'half-typed garbage');
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-mine-state'), 'dirty', 'the edit is unsaved');
  assert.equal(oneBy(tree, 'data-action', 'mine-cancel').props.disabled, false, 'an unsaved edit can be dropped');

  const writesBefore = writeCalls(page).length;
  assert.equal(writesBefore, 0, 'nothing has been written up to here');
  clickButton(tree, { 'data-action': 'mine-cancel' });
  tree = await page.flush();

  // The draft is gone and the layer's own stored text is back — not an empty
  // box, and not the deleted state 「恢复默认」 would leave behind.
  assert.equal(oneBy(tree, 'data-role', 'mine-text').props.value, 'stored text', 'the stored text, verbatim');
  assert.equal(markerOf(tree, 'data-mine-state'), 'idle');
  assert.equal(oneBy(tree, 'data-action', 'mine-cancel').props.disabled, true, 'nothing left to cancel');

  // Cancel is neither a write nor a confirmation: it is one local state reset.
  // (`flush` re-runs the page's effects, so reads are not the unit to count
  // here — a write is, and there must be none.)
  assert.equal(writeCalls(page).length, writesBefore, '「取消」 issues no write');
  assert.equal(writeCalls(page).length, 0, 'and no PUT / DELETE in particular');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-region'] === 'confirm').length,
    0,
    'no second confirmation appears: nothing stored is destroyed',
  );
  assert.ok(strings(tree).includes(fillText(page.zh.mineLoaded, { layer: page.zh.ovUser })), 'the panel reads as loaded again');
});

test('g-027 client: 「取消」 only drops the draft of the layer it belongs to', async () => {
  // The draft is keyed by layer+session (`mineKey`), so cancelling in one layer
  // must not touch another layer's draft, and switching away and back must not
  // resurrect a draft that was actually cancelled.
  const page = makePage({
    responses: defaultResponses({
      [PATHS.overrides]: {
        payload: overridesFixture({
          merged: {
            overrides: [
              { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'user stored', layer: 'user' },
              { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'workspace stored', layer: 'workspace' },
            ],
          },
        }),
      },
    }),
  });
  let tree = await page.flush();
  assert.equal(oneBy(tree, 'data-role', 'mine-text').props.value, 'user stored');

  typeInto(tree, 'mine-text', 'user draft');
  tree = await page.flush();
  assert.equal(markerOf(tree, 'data-mine-state'), 'dirty');

  // The other layer shows its own stored value, and cannot cancel a draft that
  // is not its own.
  clickTab(tree, 'mine-layer', 'workspace');
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-role', 'mine-text').props.value, 'workspace stored');
  assert.equal(markerOf(tree, 'data-mine-state'), 'idle');
  assert.equal(oneBy(tree, 'data-action', 'mine-cancel').props.disabled, true, "the user layer's draft is not this layer's to cancel");

  // Back again: the draft is the user layer's own, exactly as before g-027.
  clickTab(tree, 'mine-layer', 'user');
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-role', 'mine-text').props.value, 'user draft');
  assert.equal(markerOf(tree, 'data-mine-state'), 'dirty');

  clickButton(tree, { 'data-action': 'mine-cancel' });
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-role', 'mine-text').props.value, 'user stored');
  assert.equal(markerOf(tree, 'data-mine-state'), 'idle');

  // Gone, not merely hidden: the round trip does not bring the draft back.
  clickTab(tree, 'mine-layer', 'workspace');
  tree = await page.flush();
  clickTab(tree, 'mine-layer', 'user');
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-role', 'mine-text').props.value, 'user stored');
  assert.equal(markerOf(tree, 'data-mine-state'), 'idle');
  assert.equal(writeCalls(page).length, 0, 'none of this wrote anything');
});

// #region g-030: the upstream update check

/** The banner node, if the page rendered one. */
function updateBanner(tree) {
  return collect(tree, (node) => node.props && node.props['data-update-available'] !== undefined);
}

/** The `localStorage` double, installed in the sandbox before the page mounts. */
function installUpdateMirror(page, initial) {
  const store = new Map(initial === undefined ? [] : [['dsh-prompt-setting.updateCheck', initial]]);
  page.loaded.sandbox.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  return store;
}

test('client: no update, no information and a failed check are all equally silent', async () => {
  const cases = [
    ['up to date', { payload: updateFixture() }],
    ['no release upstream', { payload: updateFixture({ hasUpdate: null, error: { code: 'no-release', message: 'none' } }) }],
    ['a failed check', new Error('network down')],
  ];
  for (const [label, response] of cases) {
    const page = makePage({ responses: defaultResponses({ [PATHS.updateCheck]: response }) });
    const tree = await page.flush();
    assert.equal(updateBanner(tree).length, 0, `${label}: no banner`);
    assert.equal(
      collect(tree, (node) => node.props && node.props['data-notice'] === 'error').length,
      0,
      `${label}: no error banner either`,
    );
  }
});

test('client: a newer release renders a dismissible banner carrying the version and the release link', async () => {
  const page = makePage({ responses: defaultResponses({ [PATHS.updateCheck]: { payload: updateAvailableFixture() } }) });
  let tree = await page.flush();
  const banner = findOne(tree, (node) => node.props && node.props['data-update-available'] === 'true', 'the update banner');
  assert.equal(banner.props['data-update-latest'], '0.9.9');
  const link = oneBy(tree, 'data-update-release-link', 'true');
  assert.equal(link.type, 'a');
  assert.equal(link.props.href, 'https://github.com/zangxx66/dsh-prompt-setting/releases/tag/v0.9.9');
  assert.equal(link.props.target, '_blank');
  assert.equal(link.props.rel, 'noreferrer noopener');
  // The banner says both versions, so「latest」is never mistaken for the build.
  assert.match(strings(tree).join(' '), /0\.9\.9/);
  assert.match(strings(tree).join(' '), /0\.1\.5/);

  clickButton(tree, { 'data-action': 'update-dismiss' });
  tree = page.draw();
  assert.equal(updateBanner(tree).length, 0, 'dismissing removes it for this session');
  assert.equal(writeCalls(page).length, 0, 'dismissal is view state only');
});

test('client: 「高级」 carries the update switch, on by default, with the re-check beside it', async () => {
  const page = makePage({ responses: defaultResponses() });
  const tree = await openTab(page, 'advanced');
  const card = oneBy(tree, 'data-region', 'update-setting');
  assert.equal(card.props['data-update-enabled'], 'true');
  const toggle = oneBy(tree, 'data-action', 'update-toggle');
  assert.equal(toggle.props['aria-pressed'], 'true');
  oneBy(tree, 'data-action', 'update-recheck');
});

test('client: turning the switch off writes the preference, mirrors it and stops asking', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.updateCheck]: (target, init) =>
        init.method === 'PUT'
          ? { payload: { ok: true, enabled: false, saved: { enabled: false }, effectiveFrom: 'immediate', error: null } }
          : { payload: updateFixture() },
    }),
  });
  const store = installUpdateMirror(page);
  let tree = await openTab(page, 'advanced');
  const before = urlsFor(page, PATHS.updateCheck).length;
  clickButton(tree, { 'data-action': 'update-toggle' });
  // Settle the write without re-running the mount effect: a real React effect
  // runs once, so the page re-renders from the switch's own answer here.
  await settle();
  tree = page.draw();
  const put = page.router.calls.filter((call) => call.url.startsWith(PATHS.updateCheck) && call.init.method === 'PUT');
  assert.equal(put.length, 1);
  assert.deepEqual(JSON.parse(put[0].init.body), { enabled: false });
  assert.equal(oneBy(tree, 'data-region', 'update-setting').props['data-update-enabled'], 'false');
  assert.equal(oneBy(tree, 'data-action', 'update-toggle').props['aria-pressed'], 'false');
  assert.equal(urlsFor(page, PATHS.updateCheck).length, before + 1, 'closing the switch asks nothing further');
  assert.equal(store.get('dsh-prompt-setting.updateCheck'), 'off', 'the local mirror remembers it');
});

test('client: a mirrored "off" makes the mount issue no update request at all', async () => {
  const page = makePage({ responses: defaultResponses() });
  installUpdateMirror(page, 'off');
  const tree = await page.flush();
  assert.deepEqual(urlsFor(page, PATHS.updateCheck), [], 'zero requests while the mirror says off');
  assert.equal(updateBanner(tree).length, 0);
  const advanced = await openTab(page, 'advanced', tree);
  assert.equal(oneBy(advanced, 'data-region', 'update-setting').props['data-update-enabled'], 'false');
  assert.equal(collect(advanced, (node) => node.props && node.props['data-action'] === 'update-recheck').length, 0);
});

test('client: turning the switch back on asks once, immediately, with force=1', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.updateCheck]: (target, init) =>
        init.method === 'PUT'
          ? { payload: { ok: true, enabled: true, saved: { enabled: true }, effectiveFrom: 'immediate', error: null } }
          : { payload: updateFixture() },
    }),
  });
  const store = installUpdateMirror(page, 'off');
  let tree = await openTab(page, 'advanced');
  assert.deepEqual(urlsFor(page, PATHS.updateCheck), []);
  clickButton(tree, { 'data-action': 'update-toggle' });
  tree = await page.flush();
  const urls = urlsFor(page, PATHS.updateCheck);
  const forced = urls.filter((url) => url.endsWith('?force=1'));
  assert.equal(forced.length, 1, 'exactly one immediate check, bypassing the host cache');
  assert.ok(
    urls.findIndex((url) => url.endsWith('?force=1')) >
      urls.findIndex((url) => url.split('?')[0] === PATHS.updateCheck && !url.endsWith('?force=1')),
    'the forced check comes after the switch was written',
  );
  assert.equal(oneBy(tree, 'data-region', 'update-setting').props['data-update-enabled'], 'true');
  assert.equal(store.get('dsh-prompt-setting.updateCheck'), 'on');
});

test('client: a refused switch write is reported, and the state stays what the host said', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.updateCheck]: (target, init) =>
        init.method === 'PUT'
          ? {
              status: 200,
              payload: {
                ok: false,
                enabled: true,
                saved: { enabled: true },
                code: 'preferences-unwritable',
                message: 'cannot write',
                error: { code: 'preferences-unwritable', message: 'cannot write' },
              },
            }
          : { payload: updateFixture() },
    }),
  });
  let tree = await openTab(page, 'advanced');
  clickButton(tree, { 'data-action': 'update-toggle' });
  tree = await page.flush();
  assert.equal(oneBy(tree, 'data-region', 'update-setting').props['data-update-enabled'], 'true');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-notice'] === 'error').length,
    1,
    'the refusal is visible, not silent',
  );
});

// g-030 review finding: `hasUpdate:null` (upstream answered, nothing comparable)
// and `ok:false` (the check itself failed) are different wire facts and used to
// share one wrong condition — the explanation rendered on *failure* and stayed
// hidden for the four upstream cases it was written for. Both states are frozen
// here, including the "no red line either way" half.
test('client: 「高级」 explains an undecided upstream answer, and stays quiet when the check failed', async () => {
  // ① Upstream answered — there is simply no release to compare against (404).
  const undecided = makePage({
    responses: defaultResponses({
      [PATHS.updateCheck]: {
        payload: updateFixture({ hasUpdate: null, latest: null, error: { code: 'no-release', message: 'none yet' } }),
      },
    }),
  });
  let tree = await openTab(undecided, 'advanced');
  const unknown = oneBy(tree, 'data-update-unknown', 'true');
  assert.equal(unknown.props['data-update-state'], 'unknown');
  assert.match(strings(tree).join(' '), /上游暂时没有可用的版本信息/);
  assert.equal(collect(tree, (node) => node.props && node.props['data-notice'] === 'error').length, 0, '① still no red line');
  assert.equal(updateBanner(tree).length, 0, '① and no main-page banner');

  // ② The check failed: that is not a fact about upstream, so it gets no such
  // sentence — and no error line either.
  const failed = makePage({
    responses: defaultResponses({ [PATHS.updateCheck]: new Error('offline') }),
  });
  tree = await openTab(failed, 'advanced');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-update-unknown'] === 'true').length,
    0,
    '② a failed check is not explained as「上游没有可用信息」',
  );
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-update-state'] !== undefined).length,
    0,
    '② no state line at all',
  );
  assert.equal(collect(tree, (node) => node.props && node.props['data-notice'] === 'error').length, 0, '② no red line');
  assert.equal(urlsFor(failed, PATHS.updateCheck).length > 0, true, '② the failed check really was attempted');

  // ③ A confirmed newer release still shows its version line, not the unknown one.
  const available = makePage({
    responses: defaultResponses({ [PATHS.updateCheck]: { payload: updateAvailableFixture() } }),
  });
  tree = await openTab(available, 'advanced');
  assert.equal(oneBy(tree, 'data-update-known', '0.9.9').props['data-update-state'], 'available');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-update-unknown'] === 'true').length,
    0,
    '③ the two lines are mutually exclusive',
  );
  // ④ "Up to date" says nothing at all in the card.
  const current = makePage({ responses: defaultResponses({ [PATHS.updateCheck]: { payload: updateFixture() } }) });
  tree = await openTab(current, 'advanced');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-update-state'] !== undefined).length,
    0,
    '④ no update means no state line',
  );
});

// #endregion

// #region g-032:「立即更新」

/** The `sessionStorage` double, installed in the sandbox before the page mounts. */
function installApplyMirror(page, initial) {
  const store = new Map(initial === undefined ? [] : [['dsh-prompt-setting.updateApply', initial]]);
  page.loaded.sandbox.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  return store;
}

/** A `GET /update-apply` answer for one phase. */
function applyStatus(over = {}) {
  return {
    requestId: 'i1-test',
    phase: 'installing',
    status: 'running',
    known: true,
    application: null,
    version: '0.9.9',
    tag: '0.9.9',
    startedAt: '2024-06-01T00:00:00.000Z',
    finishedAt: null,
    cancelRequested: false,
    cancellable: true,
    restartRequired: false,
    installed: false,
    error: null,
    ...over,
  };
}

/**
 * The install route's answer, told apart by **method**, not by URL.
 *
 * `POST` is the start (it answers the request id) and a `GET` carrying a
 * `requestId` is a poll; a bare `GET` is the fresh-page resume probe. Testing
 * `url.includes('requestId=')` instead would mis-read the `POST` — whose path is
 * `/update-apply` — as a poll, which silently turns every start into "unknown".
 * @param status - what a poll answers.
 * @returns the router response function.
 */
function installRoute(status) {
  return (url, init) => {
    if (init && init.method === 'POST') return { payload: { ok: true, status: applyStatus() } };
    if (url.includes('requestId=')) return { payload: { ok: true, status: typeof status === 'function' ? status() : status } };
    return { payload: { ok: true, status: null } };
  };
}

/** The install fixture: a newer release whose check carries the tag as published. */
function updateAvailableWithTag(over = {}) {
  return updateAvailableFixture({ latestTag: 'v0.9.9', ...over });
}

/** Wait for the page's own poll loop to drain (the sandbox floor is 5 ms). */
async function flushApply() {
  for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

test('client: the banner carries「立即更新」, disabled while a first install is requested', async () => {
  // g-036: a command-line host says so on the ping, so this fixture renders the
  // `cli` copy — the instruction that names `dsh web`.
  const page = makePage({
    responses: defaultResponses({
      [PATHS.ping]: { payload: { ok: true, launchKind: 'cli' } },
      [PATHS.updateCheck]: { payload: updateAvailableWithTag() },
    }),
  });
  let tree = await page.flush();
  const apply = oneBy(tree, 'data-action', 'update-apply');
  assert.equal(apply.type, 'button');
  assert.match(strings(tree).join(' '), /立即更新/);
  assert.notEqual(apply.props.disabled, true, 'the button is live once a newer release is known');

  // Clicking opens the **existing** confirmation modal, and it writes nothing.
  apply.props.onClick();
  tree = page.draw();
  const modal = oneBy(tree, 'data-region', 'confirm');
  assert.equal(modal.props['data-confirm-kind'], 'update-apply');
  assert.equal(writeCalls(page).length, 0, 'the confirmation writes nothing');
  const text = strings(tree).join(' ');
  assert.match(text, /0\.9\.9/, 'the modal names the version');
  assert.match(text, /重新运行 dsh web/, 'the modal states the command-line restart (g-036)');
  assert.equal(
    urlsFor(page, PATHS.updateApply).length,
    1,
    'only the mount-time resume probe ran; confirming is what starts an install',
  );
});

test('client: confirming starts the install — one POST, then polling, then the manual-restart line', async () => {
  const page = makePage({
    responses: defaultResponses({
      // g-036: the command-line copy, so the settled sentence names `dsh web`.
      [PATHS.ping]: { payload: { ok: true, launchKind: 'cli' } },
      [PATHS.updateCheck]: { payload: updateAvailableWithTag() },
      [PATHS.updateApply]: installRoute(applyStatus()),
    }),
  });
  let tree = await page.flush();
  clickButton(tree, { 'data-action': 'update-apply' });
  tree = page.draw();
  clickButton(tree, { 'data-action': 'confirm-yes' });
  await flushApply();
  tree = page.draw();

  const posts = page.router.calls.filter((call) => call.init && call.init.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, PATHS.updateApply);
  assert.deepEqual(JSON.parse(posts[0].init.body), { tag: 'v0.9.9' }, 'the tag the check published is the tag installed');

  const status = oneBy(tree, 'data-update-apply-status', 'running');
  assert.equal(status.props['data-region'], 'update-apply-status');
  // The banner's marker carries the **status** the page branches on; the finer
  // host step is a separate, correctly named marker.
  assert.equal(updateBanner(tree)[0].props['data-update-apply'], 'running');
  assert.equal(status.props['data-update-apply-phase'], 'installing');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-action'] === 'update-apply-cancel').length,
    1,
    'a running install offers a cancel',
  );

  // The host settles it as restart-required: a success, and the copy must say so.
  page.router.set(
    PATHS.updateApply,
    installRoute(
      applyStatus({
        phase: 'done',
        status: 'done',
        application: 'restart-required',
        restartRequired: true,
        installed: true,
        cancellable: false,
        finishedAt: '2024-06-01T00:02:00.000Z',
      }),
    ),
  );
  await flushApply();
  tree = page.draw();
  assert.equal(oneBy(tree, 'data-update-apply-status', 'done').props['data-region'], 'update-apply-status');
  const done = strings(tree).join(' ');
  assert.match(done, /已安装 v0\.9\.9/);
  assert.match(done, /重新运行 dsh web/, 'the command-line restart instruction (g-036)');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-action'] === 'update-apply-cancel').length,
    0,
    'a settled install has nothing left to cancel',
  );
  assert.equal(writeCalls(page).length, 0, 'installing is a POST, never a PUT/DELETE of the config');
});

test('client: a failed install shows the host category and a retry, and never retries by itself', async () => {
  const failed = applyStatus({
    phase: 'failed',
    status: 'failed',
    application: 'failed',
    cancellable: false,
    finishedAt: '2024-06-01T00:00:10.000Z',
    error: {
      code: 'asset-missing',
      message: 'the 0.9.9 release has no dsh-prompt-setting-<version>.tgz asset to install from',
      diagnostic: 'https://github.com/.../dsh-prompt-setting-0.9.9.tgz answered HTTP 404',
      manual: { releaseUrl: 'https://github.com/zangxx66/dsh-prompt-setting/releases/tag/0.9.9' },
      retryable: true,
    },
  });
  const page = makePage({
    responses: defaultResponses({
      [PATHS.updateCheck]: { payload: updateAvailableWithTag() },
      [PATHS.updateApply]: installRoute(failed),
    }),
  });
  let tree = await page.flush();
  clickButton(tree, { 'data-action': 'update-apply' });
  tree = page.draw();
  clickButton(tree, { 'data-action': 'confirm-yes' });
  await flushApply();
  tree = page.draw();

  assert.equal(oneBy(tree, 'data-update-apply-status', 'failed').props['data-region'], 'update-apply-status');
  const text = strings(tree).join(' ');
  assert.match(text, /no .*asset/, 'the host’s own sentence is rendered');
  assert.match(text, /404/, 'the diagnostic is shown, so a 404 is never a silent failure');
  const manual = oneBy(tree, 'data-update-apply-manual', 'true');
  assert.equal(manual.props.href, 'https://github.com/zangxx66/dsh-prompt-setting/releases/tag/0.9.9');

  const before = page.router.calls.filter((call) => call.init && call.init.method === 'POST').length;
  await flushApply();
  const after = page.router.calls.filter((call) => call.init && call.init.method === 'POST').length;
  assert.equal(after, before, 'nothing retries on its own');
  assert.equal(
    collect(page.draw(), (node) => node.props && node.props['data-action'] === 'update-apply-retry').length,
    1,
    'the retry is the user’s click',
  );
});

test('client: a running install can be cancelled, and the cancel goes to the host', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.updateCheck]: { payload: updateAvailableWithTag() },
      [PATHS.updateApply]: installRoute(applyStatus()),
      [PATHS.updateApplyCancel]: { payload: { ok: true, code: 'cancelling', status: applyStatus({ phase: 'cancelling', cancelRequested: true }) } },
    }),
  });
  let tree = await page.flush();
  clickButton(tree, { 'data-action': 'update-apply' });
  tree = page.draw();
  clickButton(tree, { 'data-action': 'confirm-yes' });
  await flushApply();
  tree = page.draw();
  clickButton(tree, { 'data-action': 'update-apply-cancel' });
  await flushApply();

  const cancel = page.router.calls.find((call) => call.url === PATHS.updateApplyCancel);
  assert.ok(cancel, 'the cancel route was called');
  assert.equal(cancel.init.method, 'POST');
  assert.deepEqual(JSON.parse(cancel.init.body), { requestId: 'i1-test' });
});

test('client: a reloaded page resumes a running install it can no longer name', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.updateCheck]: { payload: updateAvailableWithTag() },
      [PATHS.updateApply]: { payload: { ok: true, status: applyStatus() } },
    }),
  });
  const tree = await page.flush();
  // The bare `GET` is the resume probe, and the running install is rendered from
  // its answer — the page never "remembers" a phase of its own.
  const probes = urlsFor(page, PATHS.updateApply).filter((url) => !url.includes('requestId='));
  assert.equal(probes.length >= 1, true, 'a fresh page asks whether anything is installing');
  assert.equal(oneBy(tree, 'data-update-apply-status', 'running').props['data-region'], 'update-apply-status');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-action'] === 'update-apply-cancel').length,
    1,
    'the resumed install is cancellable, so a reload loses nothing',
  );
});

test('client: a remembered finished install keeps its verdict, and never re-offers the button', async () => {
  // The reload path: the tab remembers the request id, that id settles as
  // `restart-required`, and the host's **bare** `GET` (which only ever names a
  // *running* install) answers `null`. Overwriting the settled answer with that
  // `null` would drop the one sentence the user needs and offer「立即更新」again
  // for a version that is already installed.
  const page = makePage({
    responses: defaultResponses({
      // g-036: an old-style command-line host, so the settled sentence is the
      // one that names `dsh web`.
      [PATHS.ping]: { payload: { ok: true, launchKind: 'cli' } },
      [PATHS.updateCheck]: { payload: updateAvailableWithTag() },
      [PATHS.updateApply]: (url, init) =>
        init && init.method === 'POST'
          ? { payload: { ok: true, status: applyStatus() } }
          : url.includes('requestId=')
            ? {
                payload: {
                  ok: true,
                  status: applyStatus({
                    phase: 'done',
                    status: 'done',
                    application: 'restart-required',
                    restartRequired: true,
                    installed: true,
                    cancellable: false,
                    finishedAt: '2024-06-01T00:02:00.000Z',
                  }),
                },
              }
            : { payload: { ok: true, status: null } },
    }),
  });
  installApplyMirror(page, JSON.stringify({ requestId: 'i1-test', at: Date.now() }));
  const tree = await page.flush();

  assert.match(strings(tree).join(' '), /已安装 v0\.9\.9/, 'the installed version is still reported');
  assert.match(strings(tree).join(' '), /重新运行 dsh web/, 'and so is the command-line restart (g-036)');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-action'] === 'update-apply').length,
    0,
    'a settled install is not offered again',
  );
  assert.equal(oneBy(tree, 'data-update-apply-status', 'done').props['data-region'], 'update-apply-status');
  assert.equal(oneBy(tree, 'data-update-apply', 'done').props['data-region'], 'update-notice');
});

test('client: a live install keeps its controls after the update switch is turned off', async () => {
  // The real path: the switch is on, an install is started, and the user then
  // turns the switch off. `toggleUpdate` drops the check's own facts (`data`,
  // `check`) but must keep the install — and the install row must survive the
  // switch being off, or the page is left with a running install and **no**
  // cancel button anywhere (the banner follows the switch and renders nothing).
  const page = makePage({
    responses: defaultResponses({
      [PATHS.updateCheck]: (url, init) =>
        init && init.method === 'PUT'
          ? { payload: updateFixture({ enabled: false }) }
          : { payload: updateAvailableWithTag() },
      [PATHS.updateApply]: { payload: { ok: true, status: applyStatus() } },
    }),
  });
  let tree = await openTab(page, 'advanced');
  // While the switch is on there are two live controls — the banner and the
  // 「高级」card — and both cancel the same request.
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-action'] === 'update-apply-cancel').length,
    2,
    'the install is running and cancellable in both places while the switch is on',
  );

  clickButton(tree, { 'data-action': 'update-toggle' });
  await settle();
  tree = page.draw();

  assert.equal(oneBy(tree, 'data-region', 'update-setting').props['data-update-enabled'], 'false');
  assert.equal(updateBanner(tree).length, 0, 'the banner follows the switch (no facts to show)');
  const card = oneBy(tree, 'data-region', 'update-apply');
  assert.equal(card.props['data-region'], 'update-apply');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-action'] === 'update-apply-cancel').length,
    1,
    'the running install is still cancellable with the check switch off',
  );
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-action'] === 'update-apply').length,
    0,
    'and the switch being off does not re-offer a second install',
  );
});

test('client: 「already installed」 is a success with no poll and no second button', async () => {
  // The real desktop case: the profile already held the exact asset, so the host
  // answers a finished `restart-required` and never calls the package manager.
  // The page must say「该版本已安装，请退出并重新打开 DeepSeek Harness」— not a
  // failure, and not a spinner. g-036: a desktop host says so on the ping, and
  // that copy must not tell the user to run `dsh web` in a terminal they do not
  // have.
  const page = makePage({
    responses: defaultResponses({
      [PATHS.ping]: { payload: { ok: true, launchKind: 'desktop' } },
      [PATHS.updateCheck]: { payload: updateAvailableWithTag() },
      [PATHS.updateApply]: (url, init) =>
        init && init.method === 'POST'
          ? {
              payload: {
                ok: true,
                reused: false,
                alreadyInstalled: true,
                status: applyStatus({
                  phase: 'done',
                  status: 'done',
                  application: 'restart-required',
                  restartRequired: true,
                  installed: true,
                  cancellable: false,
                  finishedAt: '2024-06-01T00:00:01.000Z',
                }),
              },
            }
          : { payload: { ok: true, status: null } },
    }),
  });
  let tree = await page.flush();
  clickButton(tree, { 'data-action': 'update-apply' });
  tree = page.draw();
  clickButton(tree, { 'data-action': 'confirm-yes' });
  await flushApply();
  tree = page.draw();

  assert.match(strings(tree).join(' '), /已安装/, 'the notice says it is already installed');
  assert.match(strings(tree).join(' '), /退出并重新打开 DeepSeek Harness/, 'the desktop restart instruction (g-036)');
  assert.doesNotMatch(strings(tree).join(' '), /dsh web/, 'a desktop user has no terminal to run `dsh web` in');
  assert.equal(oneBy(tree, 'data-update-apply-status', 'done').props['data-region'], 'update-apply-status');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-action'] === 'update-apply').length,
    0,
    'nothing left to install, so no button',
  );
  // Nothing to poll: one POST, no follow-up `?requestId=` GET.
  const polls = page.router.calls.filter((call) => call.url.includes('requestId='));
  assert.equal(polls.length, 0, 'a no-op install is answered, not polled');
});

test('client: a structured refusal from the host is shown as its own sentence, and nothing polls', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.updateCheck]: { payload: updateAvailableWithTag() },
      [PATHS.updateApply]: (url, init) =>
        init && init.method === 'POST'
          ? {
              payload: {
                ok: false,
                code: 'development-link',
                message: 'this profile installs dsh-prompt-setting from a local path (link:../x)',
                manual: { releaseUrl: 'https://github.com/zangxx66/dsh-prompt-setting/releases/tag/0.9.9' },
              },
            }
          : { payload: { ok: true, status: null } },
    }),
  });
  let tree = await page.flush();
  clickButton(tree, { 'data-action': 'update-apply' });
  tree = page.draw();
  clickButton(tree, { 'data-action': 'confirm-yes' });
  await flushApply();
  tree = page.draw();

  assert.match(strings(tree).join(' '), /link:\.\.\/x/, 'the refusal’s own reason reaches the page');
  assert.equal(oneBy(tree, 'data-update-apply-status', 'failed').props['data-region'], 'update-apply-status');
  const posts = page.router.calls.filter((call) => call.init && call.init.method === 'POST');
  assert.equal(posts.length, 1, 'a refusal is not retried in a loop');
});

test('client: 「高级」 carries the same install control, so dismissing the banner loses nothing', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.updateCheck]: { payload: updateAvailableWithTag() },
      [PATHS.updateApply]: { payload: { ok: true, status: null } },
    }),
  });
  const tree = await page.flush();
  // The「高级」card is opened by its own tab click rather than through
  // `openTab`/`flush`: this harness re-runs every effect on a flush (its hooks
  // runtime compares no dependencies), so a flush would legitimately re-run the
  // update check — and that is the *check* resetting its own view state, not the
  // dismissal being lost.
  clickAnyTab(tree, 'advanced');
  const advanced = page.draw();
  assert.equal(updateBanner(advanced).length, 1, 'the banner is still there to dismiss');
  clickButton(advanced, { 'data-action': 'update-dismiss' });
  const dismissed = page.draw();
  assert.equal(updateBanner(dismissed).length, 0, 'dismissing removes the banner');
  // The install control is not in the banner, so dismissal cannot lose it.
  const card = oneBy(dismissed, 'data-region', 'update-apply');
  assert.equal(card.props['data-region'], 'update-apply');
  oneBy(dismissed, 'data-action', 'update-apply');
});

test('client: every install marker carries a value the contract enumerates', async () => {
  // CONTRACT §18.7 lists the **complete** set each marker can carry. This is the
  // assertion behind that word: a marker value the contract does not list cannot
  // be produced without turning this test red, and `idle` — the banner's
  // not-started-yet value — must never appear on the status row (the row does not
  // exist until there is an install to show).
  const BANNER = new Set(['idle', 'running', 'done', 'failed', 'cancelled', 'unknown']);
  const ROW = new Set(['running', 'done', 'failed', 'cancelled', 'unknown']);
  const PHASE = new Set(['installing', 'cancelling', 'done', 'failed', 'cancelled', 'unknown']);
  const phases = [
    applyStatus(),
    applyStatus({ phase: 'done', status: 'done', application: 'restart-required', restartRequired: true, installed: true, cancellable: false }),
    applyStatus({ phase: 'failed', status: 'failed', application: 'failed', cancellable: false, error: { code: 'asset-missing', message: 'no asset' } }),
    applyStatus({ phase: 'cancelling', status: 'running', cancelRequested: true }),
    applyStatus({ phase: 'unknown', status: 'unknown', known: false, cancellable: false }),
  ];
  for (const status of phases) {
    const page = makePage({
      responses: defaultResponses({
        [PATHS.updateCheck]: { payload: updateAvailableWithTag() },
        [PATHS.updateApply]: (url, init) =>
          init && init.method === 'POST'
            ? { payload: { ok: true, status } }
            : url.includes('requestId=')
              ? { payload: { ok: true, status } }
              : { payload: { ok: true, status: null } },
      }),
    });
    let tree = await page.flush();
    clickButton(tree, { 'data-action': 'update-apply' });
    tree = page.draw();
    clickButton(tree, { 'data-action': 'confirm-yes' });
    await flushApply();
    tree = page.draw();

    const banner = updateBanner(tree)[0];
    const row = oneBy(tree, 'data-region', 'update-apply-status');
    assert.ok(BANNER.has(banner.props['data-update-apply']), `banner marker ${banner.props['data-update-apply']} is in the contract`);
    assert.ok(ROW.has(row.props['data-update-apply-status']), `row status ${row.props['data-update-apply-status']} is in the contract`);
    assert.ok(PHASE.has(row.props['data-update-apply-phase']), `row phase ${row.props['data-update-apply-phase']} is in the contract`);
    assert.notEqual(row.props['data-update-apply-status'], 'idle', 'idle belongs to the banner only');
    assert.equal(row.props['data-update-apply-status'], banner.props['data-update-apply'], 'the two markers agree');
  }
  // And the one state that carries `idle` really is the banner with no install.
  const idlePage = makePage({ responses: defaultResponses({ [PATHS.updateCheck]: { payload: updateAvailableWithTag() } }) });
  const idleTree = await idlePage.flush();
  assert.equal(updateBanner(idleTree)[0].props['data-update-apply'], 'idle');
  assert.equal(
    collect(idleTree, (node) => node.props && node.props['data-region'] === 'update-apply-status').length,
    0,
    'no install means no status row',
  );
});

/** A settled `restart-required` install: the state that carries the restart copy. */
function settledInstallStatus() {
  return applyStatus({
    phase: 'done',
    status: 'done',
    application: 'restart-required',
    restartRequired: true,
    installed: true,
    cancellable: false,
    finishedAt: '2024-06-01T00:02:00.000Z',
  });
}

test('client: the restart copy follows the launch shape the ping reported (g-036)', async () => {
  // One state, three readers: the same settled `restart-required` install must
  // read as an instruction each reader can carry out. The command line names
  // `dsh web`; the desktop app says quit and reopen (and never mentions `dsh
  // web`, because that user has no terminal); a shape the host could not decide
  // — and an old host that never sent the field at all — gets copy that works in
  // both places.
  const cases = [
    { launchKind: 'cli', marker: 'cli', expects: /重新运行 dsh web/, forbidden: null },
    { launchKind: 'desktop', marker: 'desktop', expects: /退出并重新打开 DeepSeek Harness/, forbidden: /dsh web/ },
    { launchKind: undefined, marker: 'unknown', expects: /手动重启 DSH/, forbidden: /dsh web/ },
  ];
  for (const expected of cases) {
    const page = makePage({
      responses: defaultResponses({
        [PATHS.ping]: pingResponse(null, PLUGIN_VERSION, null, expected.launchKind),
        [PATHS.updateCheck]: { payload: updateAvailableWithTag() },
        [PATHS.updateApply]: installRoute(settledInstallStatus()),
      }),
    });
    let tree = await page.flush();
    assert.equal(markerOf(tree, 'data-launch-kind'), expected.marker, `the page announces the ${expected.marker} shape`);

    clickButton(tree, { 'data-action': 'update-apply' });
    tree = page.draw();
    const modal = strings(oneBy(tree, 'data-region', 'confirm')).join(' ');
    assert.match(modal, expected.expects, `the confirmation copy is the ${expected.marker} one`);
    if (expected.forbidden !== null) {
      assert.doesNotMatch(modal, expected.forbidden, `the ${expected.marker} confirmation may not name a terminal command`);
    }

    clickButton(tree, { 'data-action': 'confirm-yes' });
    await flushApply();
    tree = page.draw();
    const settled = strings(oneBy(tree, 'data-region', 'update-apply-status')).join(' ');
    assert.match(settled, expected.expects, `the settled line is the ${expected.marker} copy`);
    if (expected.forbidden !== null) {
      assert.doesNotMatch(settled, expected.forbidden, `the ${expected.marker} settled line may not name a terminal command`);
    }
  }
});

test('client: an old host without launchKind renders the shape-neutral copy, never a blank', async () => {
  // Backward compatibility, asserted two ways: a host that answered without the
  // field and a host whose ping never arrived must both fall back to the same
  // neutral sentence — non-empty, and free of the strings a missing key would
  // put on screen.
  const copyFor = async (pingEntry) => {
    const page = makePage({
      responses: defaultResponses({
        [PATHS.ping]: pingEntry,
        [PATHS.updateCheck]: { payload: updateAvailableWithTag() },
        [PATHS.updateApply]: installRoute(settledInstallStatus()),
      }),
    });
    let tree = await page.flush();
    clickButton(tree, { 'data-action': 'update-apply' });
    tree = page.draw();
    const modal = strings(oneBy(tree, 'data-region', 'confirm')).join(' ');
    clickButton(tree, { 'data-action': 'confirm-yes' });
    await flushApply();
    tree = page.draw();
    return { marker: markerOf(tree, 'data-launch-kind'), modal, page: strings(tree).join(' ') };
  };
  const oldHost = await copyFor(pingResponse(null, PLUGIN_VERSION, null));
  const failedPing = await copyFor(new Error('Failed to fetch'));

  for (const answer of [oldHost, failedPing]) {
    assert.equal(answer.marker, 'unknown', 'an unanswered shape is unknown, never cli');
    assert.match(answer.modal, /手动重启 DSH/, 'the fallback still says what to do');
    assert.match(answer.page, /手动重启 DSH/);
    assert.doesNotMatch(answer.modal, /dsh web/, 'the fallback is what an undecidable desktop host also sees');
    assert.doesNotMatch(answer.modal, /undefined|\[object Object\]/, 'no copy key may render as a missing value');
    assert.doesNotMatch(answer.page, /undefined|\[object Object\]/);
  }
  assert.equal(
    oldHost.modal,
    failedPing.modal,
    'an omitted field and a failed ping render the same restart sentence',
  );
});

test('client: the install copy exists in both dictionaries and never promises an automatic restart', async () => {
  const page = makePage({ responses: defaultResponses({ [PATHS.updateCheck]: { payload: updateAvailableWithTag() } }) });
  const zh = page.zh;
  const en = page.mounted.dictionaries[0].dict.en;
  for (const key of ['updateApply', 'updateApplyTitle', 'updateApplyBody', 'updateApplyRestartNote', 'updateApplying', 'updateApplyCancel', 'updateApplyCancelling', 'updateApplyDone', 'updateApplyApplied', 'updateApplyFailed', 'updateApplyRetry', 'updateApplyCancelled', 'updateApplyUnknown', 'updateApplyManualLink']) {
    assert.equal(typeof zh[key], 'string', `zh.${key} exists`);
    assert.equal(typeof en[key], 'string', `en.${key} exists`);
  }
  assert.match(zh.updateApplyBody, /不自动重启/);
  assert.match(zh.updateApplyRestartNote, /手动重启/);
  // g-036: every copy family that carries a restart instruction exists in all
  // three shapes — the bare `unknown` key, `Cli` and `Desktop` — in **both**
  // dictionaries, and each shape's text is what that reader can actually do:
  // the CLI names `dsh web`, the desktop app never mentions it (that user has no
  // terminal), and the shape-neutral fallback an old host gets names neither.
  const COPY_FAMILIES = ['updateApplyRestartNote', 'updateApplyDone', 'updateApplyAlready', 'updateApplyUnknown'];
  for (const family of COPY_FAMILIES) {
    for (const suffix of ['', 'Cli', 'Desktop']) {
      const key = `${family}${suffix}`;
      assert.equal(typeof zh[key], 'string', `zh.${key} exists`);
      assert.equal(typeof en[key], 'string', `en.${key} exists`);
    }
    assert.match(zh[`${family}Cli`], /重新运行 dsh web/, `zh.${family}Cli names the command-line restart`);
    assert.match(en[`${family}Cli`], /dsh web/, `en.${family}Cli names the command-line restart`);
    assert.match(zh[`${family}Desktop`], /退出并重新打开 DeepSeek Harness/, `zh.${family}Desktop names the desktop restart`);
    assert.match(en[`${family}Desktop`], /quit and reopen DeepSeek Harness/i, `en.${family}Desktop names the desktop restart`);
    assert.doesNotMatch(zh[`${family}Desktop`], /dsh web/, `zh.${family}Desktop must not name a terminal command`);
    assert.doesNotMatch(en[`${family}Desktop`], /dsh web/, `en.${family}Desktop must not name a terminal command`);
    // The fallback is what an old host (no `launchKind`) and an undecidable
    // profile render, so a desktop user can see it: it may not name `dsh web`.
    assert.doesNotMatch(zh[family], /dsh web/, `zh.${family} is the shape-neutral fallback`);
    assert.doesNotMatch(en[family], /dsh web/, `en.${family} is the shape-neutral fallback`);
  }
  // No string anywhere in either dictionary may promise a restart the page does.
  for (const table of [zh, en]) {
    for (const [key, value] of Object.entries(table)) {
      if (typeof value !== 'string') continue;
      assert.equal(
        /自动重启/.test(value) && !/不自动重启/.test(value),
        false,
        `${key} must not promise an automatic restart`,
      );
      assert.equal(
        /automatic restart/.test(value) && !/no automatic restart/.test(value),
        false,
        `${key} must not promise an automatic restart`,
      );
    }
  }
});

// #endregion

// #region g-043:「下载区域」— the dropdown, the dialog and its red line

/**
 * A `/download-region` stub that **remembers**, like the real host: a `PUT` moves
 * the stored region and every later `GET` answers it.
 *
 * Without this, the mount effect's own read answers the fixture's default and
 * overwrites whatever the user just chose — the test would then be asserting
 * against a host that forgets, not the host under test.
 * @param over - extra fields for the answered payload.
 * @returns a router entry plus `stored()`.
 */
function regionStub(over = {}) {
  let stored = {
    region: 'default',
    registry: 'https://registry.npmjs.org/',
    custom: null,
    detected: false,
    stored: true,
    ...over,
  };
  const handler = (target, init) => {
    if ((init.method || 'GET') !== 'PUT') return { payload: regionFixture(stored) };
    const body = JSON.parse(init.body);
    stored =
      body.region === 'custom'
        ? { region: 'custom', registry: 'https://mirror.example/npm/', custom: 'https://mirror.example/npm/', detected: false, stored: true }
        : {
            region: body.region,
            registry: body.region === 'cn' ? 'https://registry.npmmirror.com/' : 'https://registry.npmjs.org/',
            custom: null,
            detected: false,
            stored: true,
          };
    return { payload: regionFixture({ ...stored, saved: { region: body.region }, effectiveFrom: 'immediate' }) };
  };
  handler.stored = () => stored;
  return handler;
}

/** The one region control on the page (the card lives in 「高级」). */
function regionSelect(tree) {
  return oneBy(tree, 'data-action', 'update-region-select');
}

/** One `option` value/child pair, as the select renders it. */
function regionOptions(tree) {
  const select = regionSelect(tree);
  return (select.props.children || []).map((option) => [option.props.value, option.props.children]);
}

/** Choose one region the way a user does: fire the select's own `change`. */
function chooseRegion(tree, value) {
  regionSelect(tree).props.onChange({ target: { value } });
}

/** The「下载区域」card row (it lives inside `data-region="update-setting"`). */
function regionRow(tree) {
  return oneBy(tree, 'data-region', 'download-region');
}

test('client: 「高级」 carries the download region, with the three sources and their meanings', async () => {
  const page = makePage({ responses: defaultResponses() });
  const tree = await openTab(page, 'advanced');
  const row = regionRow(tree);
  assert.equal(row.props['data-download-region'], 'default', 'the host answers the shipped source by default');
  assert.equal(row.props['data-download-region-detected'], 'false');
  assert.deepEqual(regionOptions(tree), [
    ['default', '默认'],
    ['cn', '中国大陆'],
    ['custom', '自定义'],
  ]);
  assert.equal(regionSelect(tree).props.value, 'default');
  // The line under the control says what the selected source *means*, so the
  // three options are comparable rather than three words.
  const note = oneBy(tree, 'data-role', 'update-region-note');
  assert.match(strings(note).join(' '), /GitHub/);
  assert.equal(collect(tree, (node) => node.props && node.props['data-role'] === 'update-region-auto').length, 0);
});

test('client: a region the host decided by connectivity says so, and one it stored does not', async () => {
  const detected = makePage({
    responses: defaultResponses({
      [PATHS.downloadRegion]: { payload: regionFixture({ region: 'cn', registry: 'https://registry.npmmirror.com/', detected: true }) },
    }),
  });
  const tree = await openTab(detected, 'advanced');
  assert.equal(regionRow(tree).props['data-download-region'], 'cn');
  assert.equal(regionRow(tree).props['data-download-region-detected'], 'true');
  const auto = oneBy(tree, 'data-role', 'update-region-auto');
  assert.match(strings(auto).join(' '), /中国大陆/);

  // The same region, stored: the value is identical, the *claim* is not.
  const stored = makePage({
    responses: defaultResponses({
      [PATHS.downloadRegion]: { payload: regionFixture({ region: 'cn', registry: 'https://registry.npmmirror.com/' }) },
    }),
  });
  const other = await openTab(stored, 'advanced');
  assert.equal(regionRow(other).props['data-download-region'], 'cn');
  assert.equal(regionRow(other).props['data-download-region-detected'], 'false');
  assert.equal(collect(other, (node) => node.props && node.props['data-role'] === 'update-region-auto').length, 0);
});

test('client: choosing「中国大陆」writes it and shows the host\'s own answer', async () => {
  const page = makePage({ responses: defaultResponses({ [PATHS.downloadRegion]: regionStub() }) });
  let tree = await openTab(page, 'advanced');
  chooseRegion(tree, 'cn');
  tree = await page.flush();
  const put = page.router.calls.filter((call) => call.url.startsWith(PATHS.downloadRegion) && call.init.method === 'PUT');
  assert.equal(put.length, 1);
  assert.deepEqual(JSON.parse(put[0].init.body), { region: 'cn' }, 'the built-in choices carry no address');
  assert.equal(regionRow(tree).props['data-download-region'], 'cn');
  assert.equal(regionSelect(tree).props.value, 'cn');
  assert.match(strings(tree).join(' '), /下载区域已切换为/);
});

test('client: a refused region write keeps the source that is actually in force', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.downloadRegion]: (target, init) =>
        init.method === 'PUT'
          ? { status: 200, payload: { ok: false, code: 'preferences-unwritable', message: 'cannot write', region: 'cn', registry: null } }
          : { payload: regionFixture() },
    }),
  });
  let tree = await openTab(page, 'advanced');
  chooseRegion(tree, 'cn');
  tree = await page.flush();
  // The control never moves to the option the user clicked: the host did not
  // accept it, and the card may not claim otherwise.
  assert.equal(regionSelect(tree).props.value, 'default');
  assert.equal(regionRow(tree).props['data-download-region'], 'default');
  assert.equal(collect(tree, (node) => node.props && node.props['data-notice'] === 'error').length, 1);
});

test('client: 「自定义」opens the dialog and writes nothing until it is submitted', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openTab(page, 'advanced');
  chooseRegion(tree, 'custom');
  tree = page.draw();
  const dialog = oneBy(tree, 'data-region', 'region-dialog');
  assert.equal(dialog.props.role, 'dialog');
  assert.equal(writeCalls(page).length, 0, 'opening the dialog is not a write');
  assert.equal(oneBy(tree, 'data-role', 'region-input').props.value, '', 'nothing typed yet, nothing stored yet');
  assert.equal(collect(tree, (node) => node.props && node.props['data-role'] === 'region-error').length, 0);
});

test('client: a validated custom address is submitted trimmed and closes the dialog', async () => {
  const page = makePage({ responses: defaultResponses({ [PATHS.downloadRegion]: regionStub() }) });
  let tree = await openTab(page, 'advanced');
  chooseRegion(tree, 'custom');
  tree = page.draw();
  typeInto(tree, 'region-input', '  https://mirror.example/npm  ');
  tree = page.draw();
  clickButton(tree, { 'data-action': 'region-save' });
  tree = await page.flush();
  const put = page.router.calls.filter((call) => call.url.startsWith(PATHS.downloadRegion) && call.init.method === 'PUT');
  assert.equal(put.length, 1);
  assert.deepEqual(JSON.parse(put[0].init.body), { region: 'custom', registry: 'https://mirror.example/npm' });
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'region-dialog').length, 0, 'the dialog closed');
  assert.equal(regionRow(tree).props['data-download-region'], 'custom');
  assert.equal(regionRow(tree).props['data-download-region-stored'], 'true');
});

test('client: a refused custom address stays in the dialog as a red line, and nothing is saved', async () => {
  const codes = ['registry-invalid', 'registry-unreachable', 'registry-not-npm'];
  for (const code of codes) {
    const page = makePage({
      responses: defaultResponses({
        [PATHS.downloadRegion]: (target, init) =>
          init.method === 'PUT'
            ? { status: 200, payload: { ok: false, code, message: `the host refused it (${code})`, region: 'custom', registry: null, effectiveFrom: 'unchanged' } }
            : { payload: regionFixture() },
      }),
    });
    let tree = await openTab(page, 'advanced');
    const writesBefore = writeCalls(page).length;
    chooseRegion(tree, 'custom');
    tree = page.draw();
    typeInto(tree, 'region-input', 'https://mirror.example/npm');
    tree = page.draw();
    clickButton(tree, { 'data-action': 'region-save' });
    tree = await page.flush();
    // Still open, with the host's code rendered as prose in red inside it.
    oneBy(tree, 'data-region', 'region-dialog');
    const error = oneBy(tree, 'data-role', 'region-error');
    assert.equal(error.props['data-region-error'], code, `${code}: the code travels`);
    assert.ok(strings(error).join(' ').length > 0, `${code}: the red line is prose, not an enum`);
    assert.notEqual(strings(error).join(' '), code);
    // 「红字」, literally: the theme's error colour, not a neutral meta line.
    assert.equal(error.props.style.color, 'var(--dsw-alias-state-error-primary)', `${code}: rendered in red`);
    assert.equal(
      collect(tree, (node) => node.props && node.props['data-notice'] === 'error').length,
      0,
      `${code}: the notice behind the overlay is not used`,
    );
    assert.equal(writeCalls(page).length, writesBefore + 1, `${code}: exactly one attempt, nothing else written`);
    // …and the source in force did not move.
    assert.equal(regionRow(tree).props['data-download-region'], 'default');
    assert.equal(regionSelect(page.draw()).props.value, 'default');
  }
});

test('client: cancelling the dialog writes nothing and keeps the current source', async () => {
  const page = makePage({ responses: defaultResponses() });
  let tree = await openTab(page, 'advanced');
  chooseRegion(tree, 'custom');
  tree = page.draw();
  typeInto(tree, 'region-input', 'https://mirror.example/npm');
  clickButton(tree, { 'data-action': 'region-cancel' });
  tree = page.draw();
  assert.equal(collect(tree, (node) => node.props && node.props['data-region'] === 'region-dialog').length, 0);
  assert.equal(writeCalls(page).length, 0);
  assert.equal(regionSelect(tree).props.value, 'default');
});

test('client: a stored custom address the host cannot use is reported beside the control', async () => {
  const page = makePage({
    responses: defaultResponses({
      [PATHS.downloadRegion]: {
        payload: regionFixture({
          region: 'custom',
          registry: null,
          custom: 'mirror.example',
          error: { code: 'registry-invalid', message: 'unusable' },
        }),
      },
    }),
  });
  const tree = await openTab(page, 'advanced');
  assert.equal(regionRow(tree).props['data-download-region'], 'custom');
  const line = oneBy(tree, 'data-role', 'update-region-unusable');
  assert.equal(line.props['data-update-region-error'], 'registry-invalid');
  // The card is the report: a stored-but-unusable mirror is a standing condition,
  // not the outcome of an action, so it raises no page notice.
  assert.equal(collect(tree, (node) => node.props && node.props['data-notice'] === 'error').length, 0);
});

test('client: the region read is skipped entirely while the update mirror says off', async () => {
  const page = makePage({ responses: defaultResponses() });
  installUpdateMirror(page, 'off');
  await page.flush();
  assert.deepEqual(urlsFor(page, PATHS.downloadRegion), [], 'a closed switch costs no request at all');

  // Turning the switch back on is what loads it — and the host is the one that
  // decides the first-visit default.
  let tree = await openTab(page, 'advanced');
  clickButton(tree, { 'data-action': 'update-toggle' });
  tree = await page.flush();
  assert.equal(urlsFor(page, PATHS.downloadRegion).length, 1);
  assert.equal(regionRow(tree).props['data-download-region'], 'default');
});

test('client: switching the source drops the previous check\'s fact and re-checks', async () => {
  // The banner's version came from the **old** source. Keeping it would let the
  // page offer to install an artifact the new source may not carry.
  const page = makePage({
    responses: defaultResponses({
      // The mount's own check (the old source) found a release; the forced
      // re-check the region switch triggers is the **new** source's answer.
      [PATHS.updateCheck]: (target) => ({
        payload: target.includes('force=1') ? updateFixture() : updateAvailableFixture(),
      }),
      [PATHS.downloadRegion]: regionStub(),
    }),
  });
  let tree = await page.flush();
  assert.equal(updateBanner(tree).length, 1, 'the banner is up before the switch');
  tree = await openTab(page, 'advanced', tree);
  chooseRegion(tree, 'cn');
  // Settle the write without re-running the mount effect: a real React effect
  // runs once, so the page re-renders from the region's own answer here.
  await settle();
  tree = page.draw();
  assert.equal(updateBanner(tree).length, 0, 'the old source\'s fact is gone');
  const forced = page.router.calls.filter((call) => call.url === `${PATHS.updateCheck}?force=1`);
  assert.equal(forced.length, 1, 'the new source is asked once, immediately');
});

// #endregion

test('client: a page whose region read never answers still renders the card, at the shipped source', async () => {
  // §17.9: the detection is a side request, never a gate — and the read is not
  // awaited by the render at all. Two facts are asserted from one run: the card
  // and its control are on screen **in the same flush that asked**, and an
  // unanswered read (a host with no such route at all, a transport failure)
  // degrades to the shipped source without a notice and without crashing.
  const responses = defaultResponses();
  delete responses[PATHS.downloadRegion];
  const page = makePage({ responses });
  const tree = await openTab(page, 'advanced');
  const row = regionRow(tree);
  assert.equal(row.props['data-download-region'], 'default');
  assert.equal(row.props['data-download-region-detected'], 'false', 'nothing may be claimed without an answer');
  assert.equal(row.props['data-download-region-stored'], 'false', 'and no choice may be claimed either');
  assert.equal(regionSelect(tree).props.value, 'default');
  assert.deepEqual(
    [...new Set(urlsFor(page, PATHS.downloadRegion))],
    [PATHS.downloadRegion],
    'the only region request is the read, and nothing else was tried',
  );
  assert.equal(collect(tree, (node) => node.props && node.props['data-notice'] === 'error').length, 0);
});

test('client: a region the host could not decide claims nothing, and stays「默认」', async () => {
  // g-043 review BLOCK, client half: the host now answers `detected:false`,
  // `stored:false`, `undecided:true` when its probe found no usable source (an
  // offline first visit). The card must render the shipped source **without** the
  // 「已自动判定（该源能取到本包）」 line, because nothing was decided.
  const page = makePage({
    responses: defaultResponses({
      [PATHS.downloadRegion]: {
        payload: regionFixture({ region: 'default', registry: 'https://registry.npmjs.org/', detected: false, stored: false, written: false, undecided: true }),
      },
    }),
  });
  const tree = await openTab(page, 'advanced');
  const row = regionRow(tree);
  assert.equal(row.props['data-download-region'], 'default');
  assert.equal(row.props['data-download-region-detected'], 'false');
  assert.equal(row.props['data-download-region-stored'], 'false');
  assert.equal(regionSelect(tree).props.value, 'default');
  assert.equal(
    collect(tree, (node) => node.props && node.props['data-role'] === 'update-region-auto').length,
    0,
    'no automatic decision may be claimed',
  );
  assert.doesNotMatch(strings(tree).join(' '), /已自动判定/);
});

test('client: turning the switch back on still re-checks immediately, after the region load', async () => {
  // The review's "just confirm it": the `if (enabled) await recheckUpdate()` this
  // revision touched is still there — the region load was **added before it**, not
  // substituted for it.
  const page = makePage({
    responses: defaultResponses({
      [PATHS.updateCheck]: (target, init) =>
        init.method === 'PUT'
          ? { payload: { ok: true, enabled: true, saved: { enabled: true }, effectiveFrom: 'immediate', error: null } }
          : { payload: updateFixture() },
    }),
  });
  installUpdateMirror(page, 'off');
  const tree = await openTab(page, 'advanced');
  assert.deepEqual(urlsFor(page, PATHS.updateCheck), [], 'off on mount: no check request');
  assert.deepEqual(urlsFor(page, PATHS.downloadRegion), [], 'off on mount: no region request either');
  clickButton(tree, { 'data-action': 'update-toggle' });
  await page.flush();
  const forced = urlsFor(page, PATHS.updateCheck).filter((url) => url.endsWith('?force=1'));
  assert.equal(forced.length, 1, 'the immediate forced re-check survived');
  assert.equal(urlsFor(page, PATHS.downloadRegion).length, 1, 'and the region was loaded too');
  const order = page.router.calls.map((call) => call.url);
  assert.ok(
    order.findIndex((url) => url.startsWith(PATHS.downloadRegion)) < order.findIndex((url) => url.endsWith('?force=1')),
    'the region load happens before the re-check, not instead of it',
  );
});

test('client: the update copy names both sources and never claims a single GitHub path', async () => {
  // g-043 copy review: the g-030 wording said the host "asks GitHub once", which
  // stopped being true in Revision 27 (npm registry first, GitHub Releases only as
  // the fallback) and again in Revision 28 (the source follows the download
  // region). Three keys lied about it; this freezes the corrected text so the
  // claim cannot drift back.
  const page = makePage({ responses: defaultResponses() });
  const zh = page.zh;
  const en = page.mounted.dictionaries[0].dict.en;
  // The rendered tree, not just the dictionary: the sentence a reader actually
  // sees in「高级」's「检查更新」card is the one asserted below.
  const rendered = strings(await openTab(page, 'advanced')).join('\n');
  assert.ok(rendered.includes(zh.updateSettingNote), 'the card renders exactly this sentence');
  // …and the old wording is nowhere on the page.
  assert.equal(rendered.includes('向 GitHub 查询一次最新 Release'), false);
  const pairs = [
    ['updateSettingNote', zh.updateSettingNote, en.updateSettingNote],
    ['updateApplyBody', zh.updateApplyBody, en.updateApplyBody],
    ['updateApplyManualLink', zh.updateApplyManualLink, en.updateApplyManualLink],
  ];
  for (const [key, zhText, enText] of pairs) {
    assert.equal(typeof zhText, 'string', `${key} has zh copy`);
    assert.equal(typeof enText, 'string', `${key} has en copy`);
  }

  // ① The card's own explanation: npm first, GitHub as the fallback, and the
  //    download region decides the source.
  assert.match(zh.updateSettingNote, /npm/);
  assert.match(zh.updateSettingNote, /GitHub/);
  assert.match(zh.updateSettingNote, /下载区域/);
  assert.equal(/向 GitHub 查询一次/.test(zh.updateSettingNote), false, 'the single-GitHub-path claim is gone');
  assert.match(en.updateSettingNote, /npm/);
  assert.match(en.updateSettingNote, /GitHub/);
  assert.match(en.updateSettingNote, /download region/);
  assert.equal(/asks GitHub once/.test(en.updateSettingNote), false, 'the single-GitHub-path claim is gone');
  // Both halves of the switch's promise are still stated: off means no request,
  // and turning it on costs one download-region read (§17.10) — never "zero".
  assert.match(zh.updateSettingNote, /关闭后不再联网检查/);
  assert.match(en.updateSettingNote, /no update request is made at all/i);

  // ② The install is not described as a release package any more: with an npm
  //    source it installs that registry's own `dist.tarball` (§18.2).
  assert.equal(/Release 包/.test(zh.updateApplyBody), false, 'no longer "a Release package"');
  assert.equal(/the v\{latest\} release\b/.test(en.updateApplyBody), false);
  assert.match(zh.updateApplyBody, /npm registry/);
  assert.match(zh.updateApplyBody, /下载区域/);
  assert.match(en.updateApplyBody, /npm registry/);
  assert.match(en.updateApplyBody, /download region/);
  assert.match(zh.updateApplyBody, /不自动重启/);

  // ③ The manual link may point at a release page **or** the package page
  //    (`resolveInstallTarget` falls back to npm's own page), so it may not
  //    promise a Release page.
  assert.equal(/Release 页面/.test(zh.updateApplyManualLink), false);
  assert.equal(/release page/.test(en.updateApplyManualLink), false);
  assert.match(zh.updateApplyManualLink, /发布页或包页/);
});

test('client: every update-related key that still names GitHub is accurate, key by key', async () => {
  // The audit of the rest of the family. Each entry states *why* the copy is
  // right as written, so a future edit that changes the behaviour has to come
  // back here.
  const page = makePage({ responses: defaultResponses({ [PATHS.updateCheck]: { payload: updateAvailableFixture() } }) });
  const zh = page.zh;
  const en = page.mounted.dictionaries[0].dict.en;
  // The banner's link renders only when the check reported a `releaseUrl`, which
  // an npm answer never carries (§17.2) — so「发布页」is exactly what it opens.
  const tree = await page.flush();
  assert.equal(updateBanner(tree).length, 1);
  assert.equal(/GitHub|Release|发布页/.test(zh.updateAvailable), false, 'the version line names no source');
  assert.equal(/GitHub|Release|发布页/.test(zh.updateLatestKnown), false);
  assert.equal(/GitHub|Release|发布页/.test(zh.updateUnknown), false, '"upstream" already covers both sources');
  assert.equal(/GitHub|Release|发布页/.test(zh.updateToggleSaved), false);
  assert.equal(/GitHub|Release|发布页/.test(zh.updateRecheck), false);
  assert.equal(/GitHub|Release|发布页/.test(en.updateAvailable), false);
  assert.equal(/GitHub|Release|发布页/.test(en.updateLatestKnown), false);
  assert.equal(/GitHub|Release|发布页/.test(en.updateUnknown), false);
  // The restart instructions are about *how* to restart, never about a source.
  for (const key of ['updateApplyRestartNote', 'updateApplyDone', 'updateApplyAlready', 'updateApplyApplied', 'updateApplyFailed', 'updateApplyCancelled', 'updateApplyReused']) {
    assert.equal(/GitHub|Release|发布页/.test(zh[key]), false, `zh.${key} names no source`);
    assert.equal(/GitHub|Release/.test(en[key]), false, `en.${key} names no source`);
  }
});

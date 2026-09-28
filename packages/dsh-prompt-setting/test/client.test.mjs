/**
 * Client-half assertions for stage 1A. `client.js` is executed in a `node:vm`
 * context with a stubbed module loader, a stubbed `require`, and a minimal
 * hooks runtime, so the registration contract, the primitives probe and both
 * probe render paths are asserted without a browser.
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

/** Flush microtasks until the probe effect settles. */
async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

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

test('client: an unresolvable primitives module degrades to the fallback renderer', () => {
  const { module, runtime } = loadClient('throw');
  const { registrations } = mountClient(module);
  const { tree } = runtime.render(registrations[0].component, {
    t: (key) => key,
    ...registrations[0].options.inject(),
  });
  assert.equal(rendererOf(tree), 'fallback');
  // The failure reason is surfaced on the page rather than swallowed.
  assert.ok(strings(tree).some((text) => text.includes('Cannot find module')), 'reason rendered');
});

test('client: a resolvable primitives module selects the primitives renderer', () => {
  const { module, runtime } = loadClient('ok');
  const { registrations } = mountClient(module);
  const { tree } = runtime.render(registrations[0].component, {
    t: (key) => key,
    ...registrations[0].options.inject(),
  });
  assert.equal(rendererOf(tree), 'primitives');
});

test('client: the page renders with no locale seat at all', () => {
  const { module, runtime } = loadClient('throw');
  const { registrations } = mountClient(module);
  const { tree } = runtime.render(registrations[0].component, {});
  assert.equal(rendererOf(tree), 'fallback');
});

test('client: a successful probe renders the returned JSON', async () => {
  const { module, runtime, sandbox } = loadClient('throw');
  const { registrations } = mountClient(module);
  const payload = { ok: true, plugin: packageJson.name, version: packageJson.version, time: 'T' };
  sandbox.fetch = () =>
    Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)) });
  const props = { t: (key) => key, ...registrations[0].options.inject() };

  const first = runtime.render(registrations[0].component, props);
  for (const effect of first.pending) effect();
  await settle();
  const second = runtime.render(registrations[0].component, props);

  const pre = collect(second.tree, (node) => node.type === 'pre');
  assert.equal(pre.length, 1, 'the raw payload is rendered in a <pre>');
  assert.deepEqual(JSON.parse(pre[0].props.children), payload);
});

test('client: a failing probe renders a readable error instead of a blank page', async () => {
  const { module, runtime, sandbox } = loadClient('throw');
  const { registrations } = mountClient(module);
  sandbox.fetch = () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('boom') });
  const props = { t: (key) => key, ...registrations[0].options.inject() };

  const first = runtime.render(registrations[0].component, props);
  for (const effect of first.pending) effect();
  await settle();
  const second = runtime.render(registrations[0].component, props);

  assert.equal(rendererOf(second.tree), 'fallback');
  assert.ok(strings(second.tree).every((text) => typeof text === 'string'));
  assert.ok(strings(second.tree).some((text) => text.includes('HTTP 500')), 'status rendered');
  assert.ok(strings(second.tree).some((text) => text.includes('boom')), 'server text rendered');
});

test('client: a rejected fetch renders the transport error instead of throwing', async () => {
  const { module, runtime, sandbox } = loadClient('throw');
  const { registrations } = mountClient(module);
  sandbox.fetch = () => Promise.reject(new Error('Failed to fetch'));
  const props = { t: (key) => key, ...registrations[0].options.inject() };

  const first = runtime.render(registrations[0].component, props);
  for (const effect of first.pending) effect();
  await settle();
  const second = runtime.render(registrations[0].component, props);

  assert.ok(strings(second.tree).some((text) => text.includes('Failed to fetch')), 'error rendered');
});

test('client: the probe request reports the active renderer', async () => {
  for (const [primitives, expected] of [
    ['throw', 'fallback'],
    ['ok', 'primitives'],
  ]) {
    const { module, runtime, sandbox } = loadClient(primitives);
    const { registrations } = mountClient(module);
    const urls = [];
    sandbox.fetch = (url) => {
      urls.push(String(url));
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    };
    const props = { t: (key) => key, ...registrations[0].options.inject() };
    const first = runtime.render(registrations[0].component, props);
    for (const effect of first.pending) effect();
    await settle();

    assert.deepEqual(urls, [`/prompt-setting/ping?renderer=${expected}`]);
    assert.equal(rendererOf(runtime.render(registrations[0].component, props).tree), expected);
  }
});

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

test('client: a degraded locale seat still renders the page, never a blank', () => {
  for (const shape of LOCALE_SHAPES) {
    const { module, runtime } = loadClient('throw');
    const { registrations } = mountClient(module, shape);
    const props = { t: (key) => key, ...registrations[0].options.inject() };
    let tree = null;
    assert.doesNotThrow(() => {
      tree = runtime.render(registrations[0].component, props).tree;
    }, `the component must not throw (${shape})`);
    assert.equal(rendererOf(tree), 'fallback', `still renders the page (${shape})`);
    assert.equal(markerOf(tree, 'data-render-state'), 'ok', `page rendered, not the failure card (${shape})`);
  }
});

test('client: a missing locale seat entirely still renders the page', () => {
  const { module, runtime } = loadClient('throw');
  const { registrations } = mountClient(module, 'bare');
  const tree = runtime.render(registrations[0].component, registrations[0].options.inject()).tree;
  assert.equal(rendererOf(tree), 'fallback');
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
    tree = runtime.render(registrations[0].component, props).tree;
  });
  assert.equal(rendererOf(tree), 'fallback');
  assert.equal(markerOf(tree, 'data-render-state'), 'error');
  assert.ok(
    strings(tree).some((text) => text.includes('translator exploded')),
    'the error text is shown',
  );
  // `t` is the broken thing here, so the card falls back to its literal copy.
  assert.ok(
    strings(tree).some((text) => text.includes('render failure')),
    'literal fallback copy is used',
  );
});

// #endregion

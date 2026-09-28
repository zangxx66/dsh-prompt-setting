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
    useSyncExternalStore() {
      cursor += 1;
      return 0;
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
 * Mount the client half against a stubbed cordis context.
 * @returns the captured registration and the dictionaries handed to locale.
 */
function mountClient(module) {
  let registeredSlot = null;
  const registrations = [];
  const dictionaries = [];
  const ctx = {
    locale: {
      register(ns, dict) {
        dictionaries.push({ ns, dict });
        return () => {};
      },
      bind: (ns) => (key) => dict(dictionaries, ns, key),
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 0 }),
    },
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
  return { registeredSlot, registrations, dictionaries };
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

/** The branch marker the page carries for on-machine inspection. */
function rendererOf(tree) {
  const markers = collect(tree, (node) => node.props && node.props['data-renderer'] !== undefined);
  assert.equal(markers.length, 1, 'exactly one data-renderer marker');
  return markers[0].props['data-renderer'];
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

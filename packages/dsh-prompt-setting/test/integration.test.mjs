/**
 * E1-E4 control experiments, run against the REAL `@deepseek-ai/dsh-system-prompt`
 * and `@deepseek-ai/cordis` packages in a real Cordis context — not against a
 * double. Every conclusion published in CONTRACT.md §5 and in the snapshot's
 * `experiments` field is measured here.
 *
 * Resolution is best-effort on purpose: the packages live in the DSH global
 * install (a pnpm store this repository does not depend on), so a machine
 * without DSH skips this file instead of failing. `node --test` therefore stays
 * green everywhere, and on a machine that HAS DSH these tests must PASS, not
 * skip — a skip there is a missing-evidence bug, not a pass.
 *
 * Run: `node --test test/`
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test, { afterEach, beforeEach } from 'node:test';

/** Directory names under `node_modules/.pnpm` that carry the Host peers we need. */
const ANCHOR_PACKAGES = ['@deepseek-ai+dsh-web-app@', '@deepseek-ai+dsh-base@'];

/**
 * List `node_modules` directories that may hold resolvable copies of the Host
 * packages: the obvious env-var anchors first, then the pnpm global store
 * (whose layout nests the store one or two levels under the global root).
 * @returns candidate absolute directory paths, most specific first.
 */
function candidateDirectories() {
  const directories = [];
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0) directories.push(value);
  };
  push(process.env.DSH_INSTALL_ROOT);
  push(process.env.DSH_PROFILE_DIR);
  push(process.cwd());

  const bases = [];
  if (typeof process.env.PNPM_HOME === 'string' && process.env.PNPM_HOME.length > 0) {
    bases.push(join(process.env.PNPM_HOME, 'global'));
  }
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
    bases.push(join(process.env.DSH_HOME, 'profiles'));
  }
  bases.push(join(homedir(), '.local', 'share', 'pnpm', 'global'));

  for (const base of bases) {
    for (const entry of safeReaddir(base)) {
      const first = join(base, entry);
      push(join(first, 'node_modules'));
      for (const nested of safeReaddir(first)) {
        push(join(first, nested, 'node_modules'));
      }
    }
  }
  return directories;
}

/**
 * Read a directory, tolerating absence.
 * @param path - the directory.
 * @returns its entry names, or an empty list.
 */
function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * Resolve one real Host package, directly or through the pnpm store's
 * peer-keyed package directories (where DSH's own bundle dependencies live).
 * @param name - the bare package specifier.
 * @returns an importable file URL, or null when it cannot be found.
 */
function resolveReal(name) {
  for (const directory of candidateDirectories()) {
    const anchors = [directory];
    const pnpm = join(directory, '.pnpm');
    for (const pkg of safeReaddir(pnpm)) {
      if (ANCHOR_PACKAGES.some((prefix) => pkg.startsWith(prefix))) {
        anchors.push(join(pnpm, pkg, 'node_modules'));
      }
    }
    for (const anchor of anchors) {
      try {
        return new URL(`file://${createRequire(join(anchor, '__dsh_resolve_anchor__.js')).resolve(name)}`).href;
      } catch {
        // Try the next anchor: a package can be installed per-profile or only
        // under one peer key.
      }
    }
  }
  return null;
}

const SYSTEM_PROMPT_URL = resolveReal('@deepseek-ai/dsh-system-prompt');
const CORDIS_URL = resolveReal('@deepseek-ai/cordis');
const SCOPE_URL = resolveReal('@deepseek-ai/dsh-scope');

const REAL_PACKAGES = SYSTEM_PROMPT_URL !== null && CORDIS_URL !== null;
const SKIP_REASON = REAL_PACKAGES
  ? false
  : 'the DSH global install was not found (set DSH_INSTALL_ROOT to point at it); E1-E4 need the real @deepseek-ai/dsh-system-prompt and @deepseek-ai/cordis packages';

/** Guard so a skipped suite says WHY, not just "skipped". */
const suite = { skip: SKIP_REASON };

/**
 * Boot a real Cordis context with the real system-prompt service.
 * @param sections - optional global sections to register through an injecting plugin.
 * @returns `{ctx, service}`.
 */
async function boot(sections = []) {
  const { Context } = await import(CORDIS_URL);
  const { default: SystemPrompt } = await import(SYSTEM_PROMPT_URL);
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  const service = ctx.get('systemPrompt', false);
  if (sections.length > 0) {
    await ctx.plugin({
      name: 'test-sections',
      inject: ['systemPrompt'],
      apply(scope) {
        for (const section of sections) scope.systemPrompt.section(section);
      },
    });
  }
  return { ctx, service };
}

/** The section names, in the order the assembly returned them. */
function names(assembly) {
  return assembly.sections.map((section) => section.name);
}

const CUSTOM = [
  { name: 'test:one', order: 100, text: 'ONE' },
  { name: 'test:two', order: 200, text: 'TWO' },
];

test('E1: assemble() with no argument is legal and returns the registered global sections in canonical order', suite, async () => {
  const { service } = await boot(CUSTOM);
  const assembly = await service.assemble();

  assert.deepEqual(names(assembly), [
    'harness:identity',
    'deployment:persona-prefix',
    'test:one',
    'test:two',
    'deployment:persona-suffix',
  ]);
  // The claim the whole snapshot rests on: sections arrive pre-sorted, and their
  // position IS the order — the entries carry no order field at all.
  assert.deepEqual(names(assembly), [...names(assembly)]);
  for (const section of assembly.sections) {
    assert.deepEqual(Object.keys(section).sort(), ['name', 'text']);
    assert.equal(Object.hasOwn(section, 'order'), false);
    assert.equal(Object.hasOwn(section, 'complete'), false);
  }
  assert.deepEqual(assembly.contexts, []);
  assert.deepEqual(assembly.tools, []);
  assert.deepEqual(assembly.variables, {});
  // And it is re-runnable: the order is stable across calls.
  assert.deepEqual(names(await service.assemble()), names(assembly));
});

test('E2: the assemble waterfall is outermost-first, next() resolves downstream, and the return value is authoritative', suite, async () => {
  const { ctx, service } = await boot([{ name: 'test:one', order: 100, text: 'ONE' }]);
  const trace = [];

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    trace.push('outer:in');
    const downstream = await next();
    trace.push('outer:out');
    return { ...downstream, sections: downstream.sections.map((section) => (section.name === 'test:one' ? { ...section, text: 'FROM-OUTER' } : section)) };
  });
  ctx.on('system-prompt/assemble', (assembly, context, next) => {
    trace.push('inner:in');
    const downstream = next();
    trace.push('inner:out');
    return downstream;
  });

  const composed = await service.assemble();
  assert.deepEqual(trace, ['outer:in', 'inner:in', 'inner:out', 'outer:out']);
  assert.equal(composed.sections.find((section) => section.name === 'test:one').text, 'FROM-OUTER');

  // A listener that never calls next() vetoes everything registered after it.
  const vetoed = await boot([{ name: 'test:one', order: 100, text: 'ONE' }]);
  const calls = [];
  vetoed.ctx.on('system-prompt/assemble', (assembly) => {
    calls.push('first');
    return { ...assembly, sections: [{ name: 'VETO', text: 'VETO' }] };
  });
  vetoed.ctx.on('system-prompt/assemble', (assembly, context, next) => {
    calls.push('second');
    return next();
  });
  const vetoResult = await vetoed.service.assemble();
  assert.deepEqual(calls, ['first']);
  assert.deepEqual(names(vetoResult), ['VETO']);

  // The innermost listener's returned value is what the caller receives.
  const last = await boot([{ name: 'test:one', order: 100, text: 'ONE' }]);
  last.ctx.on('system-prompt/assemble', (assembly, context, next) => next());
  last.ctx.on('system-prompt/assemble', (assembly) => ({ ...assembly, sections: [{ name: 'LAST', text: 'LAST' }] }));
  assert.deepEqual(names(await last.service.assemble()), ['LAST']);
});

test('E3: a complete section replaces the WHOLE scope, reverting listener edits to its own text too', suite, async () => {
  const complete = { name: 'test:complete', order: 1000, text: 'COMPLETE-ORIGINAL', complete: true };
  const { ctx, service } = await boot([complete, { name: 'test:other', order: 2000, text: 'OTHER' }]);

  const preWaterfall = [];
  ctx.on('system-prompt/assemble', (assembly, context, next) => {
    preWaterfall.push(names(assembly));
    return next();
  });
  // Try to rewrite the complete section AND drop another one.
  ctx.on('system-prompt/assemble', (assembly) => ({
    ...assembly,
    sections: assembly.sections
      .map((section) => (section.name === 'test:complete' ? { ...section, text: 'HACKED' } : section))
      .filter((section) => section.name !== 'test:other'),
  }));

  const result = await service.assemble();
  assert.equal(preWaterfall.length, 1);
  assert.equal(preWaterfall[0].length > 1, true, 'the registered scope has several sections');
  // The listener loses for EVERY section, not just the complete one, and the
  // complete section comes back with its original registered text.
  assert.deepEqual(result.sections, [{ name: 'test:complete', text: 'COMPLETE-ORIGINAL' }]);

  // Contrast: with no complete section present, the same edit survives.
  const control = await boot([{ name: 'test:other', order: 2000, text: 'OTHER' }]);
  control.ctx.on('system-prompt/assemble', (assembly) => ({
    ...assembly,
    sections: assembly.sections.filter((section) => section.name !== 'test:other'),
  }));
  assert.equal(names(await control.service.assemble()).includes('test:other'), false);
});

test('E4: a scoped section shadows a global one, and a root listener DOES observe scoped dispatches', suite, async () => {
  const { Context } = await import(CORDIS_URL);
  const { default: SystemPrompt } = await import(SYSTEM_PROMPT_URL);
  const scopeUrl = SCOPE_URL ?? resolveReal('@deepseek-ai/dsh-scope');
  if (scopeUrl === null) return; // Covered by the file-level skip when DSH is absent.

  const { createScope, scopeOf } = await import(scopeUrl);
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  const service = ctx.get('systemPrompt', false);
  await ctx.plugin({
    name: 'global-sections',
    inject: ['systemPrompt'],
    apply(c) {
      c.systemPrompt.section({ name: 'test:global', order: 100, text: 'GLOBAL' });
      c.systemPrompt.section({ name: 'test:shared', order: 200, text: 'SHARED-GLOBAL' });
    },
  });

  const key = {};
  const scope = createScope(ctx, key);
  assert.equal(scopeOf(scope.ctx), key);
  await scope.ctx.plugin({
    name: 'scoped-sections',
    inject: ['systemPrompt'],
    apply(c) {
      c.systemPrompt.section({ name: 'test:shared', order: 200, text: 'SHARED-SCOPED' });
      c.systemPrompt.section({ name: 'test:scoped', order: 150, text: 'SCOPED-ONLY' });
    },
  });

  // The global view is unchanged by the scoped registrations.
  assert.deepEqual(names(await service.assemble()).includes('test:scoped'), false);
  assert.equal(
    (await service.assemble()).sections.find((section) => section.name === 'test:shared').text,
    'SHARED-GLOBAL',
  );

  // The scoped view shadows the same name and inherits the global entries.
  const scoped = await service.assemble({ scope: key });
  assert.equal(scoped.sections.find((section) => section.name === 'test:shared').text, 'SHARED-SCOPED');
  assert.equal(names(scoped).includes('test:scoped'), true);
  assert.equal(names(scoped).includes('test:global'), true);
  assert.ok(names(scoped).indexOf('test:scoped') < names(scoped).indexOf('test:shared'));

  // Dispatch: an untagged (root-registered) listener sees scoped dispatches,
  // which is the fact the snapshot's `mounted` flag and handler rely on.
  const observed = [];
  ctx.on('system-prompt/assemble', (assembly, context) => {
    observed.push(context?.scope === key ? 'scoped' : 'global');
  });
  await service.assemble({ scope: key });
  await service.assemble();
  assert.deepEqual(observed, ['scoped', 'global']);

  await scope.dispose();
});

// ---------------------------------------------------------------------------
// The same experiments, but through THIS plugin's real routes and handler,
// mounted on a real Cordis context with the real systemPrompt service. This is
// what proves the snapshot's order and frozen verdict come from real assembly.
// ---------------------------------------------------------------------------

let home;
let previousHome;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-prompt-setting-integration-'));
  previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
});

/**
 * Mount the real plugin on a real Cordis context with the real prompt service.
 * @param sections - global sections to register before the plugin mounts.
 * @param sections - global sections to register before the plugin mounts.
 * @param options.agents - Agent objects exposed through a fake `agents` service.
 * @param options.omitAgents - mount without an `agents` service.
 * @param options.beforePlugin - awaited after the Host stub, before this plugin.
 * @returns `{ctx, service, route, call}`.
 */
async function mountRealPlugin(sections = [], options = {}) {
  const { Context } = await import(CORDIS_URL);
  const { default: SystemPrompt } = await import(SYSTEM_PROMPT_URL);
  const plugin = await import('../index.js');

  const routes = [];
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  const agents = new Map((options.agents ?? []).map((agent) => [agent.id, agent]));
  await ctx.plugin({
    name: 'host-stub',
    apply(c) {
      c.provide('webServer', {
        register(route) {
          routes.push(route);
          return () => {};
        },
      });
      c.provide('connection', { requestRejection: () => undefined });
      if (options.omitAgents !== true) {
        c.provide('agents', { get: (id) => agents.get(id) });
      }
    },
  });
  if (sections.length > 0) {
    await ctx.plugin({
      name: 'test-sections',
      inject: ['systemPrompt'],
      apply(scope) {
        for (const section of sections) scope.systemPrompt.section(section);
      },
    });
  }
  if (typeof options.beforePlugin === 'function') await options.beforePlugin(ctx);
  await ctx.plugin({ name: 'dsh-prompt-setting', inject: plugin.inject, apply: plugin.apply });

  const service = ctx.get('systemPrompt', false);
  assert.equal(routes.length, 1);
  const route = routes[0];
  const call = async ({ method = 'GET', url = '/prompt-setting/snapshot', body } = {}) => {
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = String(value);
      },
      end(chunk) {
        this.body = chunk === undefined || chunk === null ? '' : String(chunk);
      },
    };
    const chunks = body === undefined ? [] : [Buffer.from(body)];
    const req = {
      method,
      url,
      headers: {},
      destroy() {},
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    };
    await route.handler(req, res);
    return { status: res.statusCode, payload: JSON.parse(res.body) };
  };
  return { ctx, service, route, call };
}

test('integration: the snapshot order matches the real assembly, section for section', suite, async () => {
  const { service, call } = await mountRealPlugin(CUSTOM);
  const assembly = await service.assemble();
  const snapshot = await call({});

  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.payload.mounted, true);
  assert.deepEqual(snapshot.payload.base.sections.map((section) => section.name), names(assembly));
  assert.deepEqual(snapshot.payload.base.sections.map((section) => section.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(
    snapshot.payload.base.sections.map((section) => section.text),
    assembly.sections.map((section) => section.text),
  );
  assert.equal(snapshot.payload.rendered, assembly.sections.map((section) => section.text).filter((text) => text.length > 0).join('\n\n'));
  assert.equal(snapshot.payload.frozen, false);
  // `complete: false` is proven by the surviving probe section.
  assert.deepEqual(snapshot.payload.base.sections.map((section) => section.complete), [false, false, false, false, false]);
});

test('integration: a real complete section is reported as frozen through the real routes', suite, async () => {
  const { ctx, call } = await mountRealPlugin([
    ...CUSTOM,
    { name: 'test:complete', order: 5000, text: 'LOCKED', complete: true },
  ]);
  // Configure a real override through the real route and the real store; the
  // complete section will discard it.
  const put = await call({
    method: 'PUT',
    url: '/prompt-setting/overrides',
    body: JSON.stringify({ layer: 'user', section: { name: 'test:complete', action: 'replace', text: 'DISCARDED' } }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual(put.payload.saved, { name: 'test:complete', action: 'replace', text: 'DISCARDED', layer: 'user' });

  const snapshot = await call({ url: '/prompt-setting/snapshot' });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.payload.mounted, true);
  assert.equal(snapshot.payload.frozen, true);
  assert.equal(snapshot.payload.frozenSection, 'test:complete');
  assert.match(snapshot.payload.frozenReason, /single complete section "test:complete"/);
  assert.equal(snapshot.payload.rendered, 'LOCKED');
  assert.equal(snapshot.payload.effective.sections.every((section) => section.overridable === false), true);
  assert.equal(snapshot.payload.base.sections.length, 6);
  assert.equal(
    snapshot.payload.base.sections.find((section) => section.name === 'test:complete').complete,
    true,
  );
  // The discarded override is reported explicitly, never silently.
  const locked = snapshot.payload.effective.sections.find((section) => section.name === 'test:complete');
  assert.deepEqual([locked.text, locked.applied, locked.action, locked.overrideLayer], [
    'LOCKED', false, 'replace', 'user',
  ]);
  assert.match(locked.reason, /complete section/);
  assert.equal(ctx.get('systemPrompt', false).name, 'systemPrompt');

  // The override file itself is durable, so a fresh mount reproduces the verdict.
  const remounted = await mountRealPlugin([
    ...CUSTOM,
    { name: 'test:complete', order: 5000, text: 'LOCKED', complete: true },
  ]);
  const again = await remounted.call({ url: '/prompt-setting/snapshot' });
  assert.equal(again.payload.frozen, true);
  assert.equal(again.payload.frozenSection, 'test:complete');
});

test('integration: PROBE_SCOPE resolves exactly the unscoped view, so the base view is unchanged', suite, async () => {
  const plugin = await import('../index.js');
  const { service } = await mountRealPlugin(CUSTOM);
  const unscoped = await service.assemble();
  const privateScoped = await service.assemble({ scope: plugin.PROBE_SCOPE });
  // A private object with no scoped registrations resolves the global sections,
  // which is what lets the probe be scope-keyed without changing `base`.
  assert.deepEqual(names(privateScoped), names(unscoped));
  assert.deepEqual(
    privateScoped.sections.map((section) => section.text),
    unscoped.sections.map((section) => section.text),
  );
  // And it is genuinely private: it carries no layer of its own.
  assert.equal(Object.keys(plugin.PROBE_SCOPE).length, 0);
});

test('integration D1: a complete section in a PRESET scope freezes its sessions, but not the global view', suite, async () => {
  const scopeUrl = SCOPE_URL ?? resolveReal('@deepseek-ai/dsh-scope');
  if (scopeUrl === null) return;
  const { createScope } = await import(scopeUrl);

  // The real liangshen shape: a preset registers `{complete: true}` on its own
  // standing scope, and each session's agent scope is composed UNDER it.
  const presetKey = {};
  const agent = { id: 'locked-session' };
  const { call } = await mountRealPlugin(
    [{ name: 'test:global', order: 100, text: 'GLOBAL' }],
    {
      agents: [agent],
      beforePlugin: async (ctx) => {
        const preset = createScope(ctx, presetKey);
        await preset.ctx.plugin({
          name: 'preset-persona',
          inject: ['systemPrompt'],
          apply(c) {
            c.systemPrompt.section({ name: 'preset:locked', order: 500, text: 'LOCKED BODY', complete: true });
          },
        });
        const session = createScope(ctx, agent, { parent: presetKey });
        await session.ctx.plugin({
          name: 'session-sections',
          inject: ['systemPrompt'],
          apply(c) {
            c.systemPrompt.section({ name: 'session:own', order: 600, text: 'SESSION BODY' });
          },
        });
      },
    },
  );

  // Under the session's own scope, the inherited complete section freezes it.
  const session = await call({ url: '/prompt-setting/snapshot?session=locked-session' });
  assert.equal(session.status, 200);
  assert.equal(session.payload.frozenScope, 'session');
  assert.equal(session.payload.frozen, true);
  assert.equal(session.payload.frozenSection, 'preset:locked');
  assert.match(session.payload.frozenReason, /single complete section "preset:locked"/);
  assert.equal(session.payload.rendered, 'LOCKED BODY');
  assert.equal(session.payload.base.sections.some((section) => section.name === 'session:own'), true);
  assert.equal(session.payload.effective.sections.every((section) => section.overridable === false), true);

  // The global view is NOT frozen: probing globally would have reported
  // `frozen: false, overridable: true` for a scope no edit can change.
  const global = await call({ url: '/prompt-setting/snapshot' });
  assert.equal(global.payload.frozenScope, 'global');
  assert.equal(global.payload.frozen, false);
  assert.equal(global.payload.rendered.includes('LOCKED BODY'), false);
  assert.equal(global.payload.base.sections.some((section) => section.name === 'preset:locked'), false);
  assert.equal(global.payload.effective.sections.every((section) => section.overridable === true), true);
});

test('integration D1: an inactive session reports frozenScope "global" with a reason, never a silent guess', suite, async () => {
  const { call } = await mountRealPlugin([{ name: 'test:global', order: 100, text: 'GLOBAL' }], { agents: [] });
  const payload = await call({ url: '/prompt-setting/snapshot?session=not-running' });
  assert.equal(payload.status, 200);
  assert.equal(payload.payload.frozenScope, 'global');
  assert.equal(payload.payload.frozen, false);
  assert.match(payload.payload.frozenScopeReason, /no active agent/);
});

test('integration D2: a concurrent unscoped assembly during a snapshot is never handed the probe section', suite, async () => {
  let nested = null;
  let armed = false;
  let service = null;
  const mounted = await mountRealPlugin([{ name: 'test:global', order: 100, text: 'GLOBAL' }], {
    // `assemble()` reaches the last await only after dispatching the waterfall,
    // so wrapping the service is how this test creates the concurrency window
    // without touching the plugin.
    beforePlugin: async (ctx) => {
      service = ctx.get('systemPrompt', false);
      const original = service.assemble.bind(service);
      service.assemble = async (...args) => {
        if (!armed) {
          armed = true;
          nested = await original();
        }
        return original(...args);
      };
    },
  });
  const snapshot = await mounted.call({ url: '/prompt-setting/snapshot' });

  assert.notEqual(nested, null, 'the concurrent assembly must actually have run');
  assert.deepEqual(names(nested), ['harness:identity', 'deployment:persona-prefix', 'test:global', 'deployment:persona-suffix']);
  assert.equal(snapshot.payload.mounted, true);
  assert.equal(snapshot.payload.frozen, false);
  assert.equal(service !== null, true);
});

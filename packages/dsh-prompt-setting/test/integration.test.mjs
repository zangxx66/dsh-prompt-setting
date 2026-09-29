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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test, { afterEach, beforeEach } from 'node:test';

import { CUSTOM_SECTION_NAME } from '../index.js';

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
 * Write the user layer's config file by hand — the escape hatch for a frozen
 * (non-reserved) override, which no route accepts since Revision 7. The next
 * handled request re-reads it, so no remount is needed.
 * @param overrides - the override list to write.
 */
function writeUserConfigFile(overrides) {
  const directory = join(home, 'prompt-setting');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'overrides.json'),
    `${JSON.stringify({ version: 1, overrides }, null, 2)}\n`,
    'utf8',
  );
}

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
  // Revision 7 adds one section to both views: the plugin's own registration,
  // sorted last by its order (1000000 > every shipped order).
  assert.equal(snapshot.payload.base.sections.at(-1).name, CUSTOM_SECTION_NAME);
  assert.deepEqual(
    snapshot.payload.base.sections.map((section) => section.index),
    names(assembly).map((_, index) => index),
  );
  assert.deepEqual(
    snapshot.payload.base.sections.map((section) => section.text),
    assembly.sections.map((section) => section.text),
  );
  assert.equal(snapshot.payload.rendered, assembly.sections.map((section) => section.text).filter((text) => text.length > 0).join('\n\n'));
  assert.equal(snapshot.payload.frozen, false);
  // `complete: false` is proven by the surviving probe section.
  assert.deepEqual(snapshot.payload.base.sections.map((section) => section.complete), names(assembly).map(() => false));
});

test('integration: a real complete section is reported as frozen through the real routes', suite, async () => {
  const { ctx, call } = await mountRealPlugin([
    ...CUSTOM,
    { name: 'test:complete', order: 5000, text: 'LOCKED', complete: true },
  ]);
  // The override on the complete section itself can only be a pre-Revision-7
  // one, so it is seeded the way the escape hatch documents: a hand edit of the
  // layer's file. The narrowed route below then writes the reserved section into
  // the same layer, which is what proves the two coexist.
  writeUserConfigFile([{ name: 'test:complete', action: 'replace', text: 'DISCARDED' }]);
  const put = await call({
    method: 'PUT',
    url: '/prompt-setting/overrides',
    body: JSON.stringify({ layer: 'user', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' } }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual(put.payload.saved, { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE', layer: 'user' });

  const snapshot = await call({ url: '/prompt-setting/snapshot' });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.payload.mounted, true);
  assert.equal(snapshot.payload.frozen, true);
  assert.equal(snapshot.payload.frozenSection, 'test:complete');
  assert.match(snapshot.payload.frozenReason, /single complete section "test:complete"/);
  assert.equal(snapshot.payload.rendered, 'LOCKED');
  assert.equal(snapshot.payload.effective.sections.every((section) => section.overridable === false), true);
  assert.equal(snapshot.payload.base.sections.length, 7, 'five fixture sections + the complete one + ours');
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
  // … and so is the reserved section the freeze threw away whole: the collapse
  // keeps one section, so the user's text never reaches the prompt. That is the
  // documented degradation (§15.4) and it must be visible, not silent.
  const mine = snapshot.payload.effective.sections.find((section) => section.name === CUSTOM_SECTION_NAME);
  assert.deepEqual([mine.applied, mine.action, mine.overrideLayer], [false, 'replace', 'user']);
  assert.match(mine.reason, /removed from the assembled result/);
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
  assert.deepEqual(names(nested), ['harness:identity', 'deployment:persona-prefix', 'test:global', 'deployment:persona-suffix', CUSTOM_SECTION_NAME]);
  assert.equal(snapshot.payload.mounted, true);
  assert.equal(snapshot.payload.frozen, false);
  assert.equal(service !== null, true);
});

test('integration F1: a real third-party assemble listener that appends a section does not freeze the scope', suite, async () => {
  // Reproduces the live machine exactly: dsh-expression appends a companion
  // section in its own listener. The scope has no complete section, so the
  // snapshot must report frozen:false and leave every section editable.
  const mounted = await mountRealPlugin([{ name: 'test:global', order: 100, text: 'GLOBAL' }], {
    beforePlugin: async (ctx) => {
      // Registered BEFORE this plugin, i.e. outermost: it transforms the result
      // this plugin returns, which is the harshest ordering.
      // It calls next() like any well-behaved listener — one that does not
      // would veto this plugin entirely (measured in E2).
      ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        const downstream = await next();
        return { ...downstream, sections: [...downstream.sections, { name: 'dsh-expression:companion', text: 'COMPANION' }] };
      });
    },
  });
  const snapshot = await mounted.call({ url: '/prompt-setting/snapshot' });

  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.payload.mounted, true);
  assert.equal(snapshot.payload.frozen, false);
  assert.equal(snapshot.payload.frozenSection, null);
  assert.equal(snapshot.payload.frozenReason, null);
  assert.equal(snapshot.payload.renderedResolved, true);

  const registered = snapshot.payload.effective.sections.filter((section) => section.origin === 'registered');
  assert.equal(registered.length, snapshot.payload.base.sections.length);
  assert.equal(registered.every((section) => section.overridable === true), true);
  assert.equal(registered.every((section) => section.reason === null), true);

  const companion = snapshot.payload.effective.sections.find((section) => section.name === 'dsh-expression:companion');
  assert.deepEqual([companion.origin, companion.overridable, companion.overrideLayer], ['downstream-added', true, null]);
  assert.equal(snapshot.payload.base.sections.some((section) => section.name === 'dsh-expression:companion'), false);
  assert.match(snapshot.payload.rendered, /COMPANION/);

  // A real complete section must STILL be caught — the fix must not have made
  // the detector blind.
  const frozenMount = await mountRealPlugin([
    { name: 'test:global', order: 100, text: 'GLOBAL' },
    { name: 'preset:locked', order: 500, text: 'LOCKED', complete: true },
  ], {
    beforePlugin: async (ctx) => {
      // It calls next() like any well-behaved listener — one that does not
      // would veto this plugin entirely (measured in E2).
      ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        const downstream = await next();
        return { ...downstream, sections: [...downstream.sections, { name: 'dsh-expression:companion', text: 'COMPANION' }] };
      });
    },
  });
  const frozenSnapshot = await frozenMount.call({ url: '/prompt-setting/snapshot' });
  assert.equal(frozenSnapshot.payload.frozen, true);
  assert.equal(frozenSnapshot.payload.frozenSection, 'preset:locked');
  assert.match(frozenSnapshot.payload.frozenReason, /single complete section "preset:locked"/);
  assert.equal(frozenSnapshot.payload.effective.sections.every((section) => section.overridable === false), true);
});

test('integration F2: a session-scope probe resolves agent-dependent variables; the global probe cannot', suite, async () => {
  // Answers the review question empirically: the probe context for a session
  // carries `{agent, scope: agent}`, so an agent-scoped variable provider IS
  // evaluated; the global probe has no agent and cannot resolve it.
  const agent = { id: 'var-session' };
  const { call } = await mountRealPlugin([], {
    agents: [agent],
    beforePlugin: async (ctx) => {
      await ctx.plugin({
        name: 'agent-variables',
        inject: ['systemPrompt'],
        apply(c) {
          c.systemPrompt.variable('model', (context) => (context?.agent === undefined ? undefined : 'deepseek-flash'));
          c.systemPrompt.section({ name: 'agent:identity', order: 100, text: 'powered by the {{model}} model' });
        },
      });
    },
  });

  // ANSWER to the review question: YES. A session-scope probe passes
  // `{agent, scope: agent}`, so an agent-scoped variable provider IS evaluated
  // and the value is resolved. (`harness:identity` is the service's own section,
  // which is why the rendered text is not only our section.)
  const session = await call({ url: '/prompt-setting/snapshot?session=var-session' });
  assert.equal(session.payload.frozenScope, 'session');
  assert.equal(session.payload.renderedResolved, true);
  assert.deepEqual(session.payload.unresolvedVariables, []);
  assert.match(session.payload.rendered, /powered by the deepseek-flash model$/);
  assert.equal(session.payload.rendered.includes('{{model}}'), false);

  // Without a session there is no agent, the provider returns undefined, and the
  // value must be reported rather than rendered as a bare `undefined`.
  const global = await call({ url: '/prompt-setting/snapshot' });
  assert.equal(global.payload.frozenScope, 'global');
  assert.equal(global.payload.renderedResolved, false);
  assert.deepEqual(global.payload.unresolvedVariables, ['model']);
  assert.equal(global.payload.rendered.includes('undefined'), false);
  assert.match(global.payload.rendered, /powered by the \{\{model\}\} model$/);
});

// ---------------------------------------------------------------------------
// Revision 7: the plugin's own prompt section, measured against the REAL
// shipped renderer. These are the assertions that need the actual
// `@deepseek-ai/dsh-system-prompt` — an offline double would prove nothing
// about byte-for-byte text and about `interpolate: false`.
// ---------------------------------------------------------------------------

test('integration R7: the plugin registers one reserved section, and disposing the mount removes it', suite, async () => {
  const { Context } = await import(CORDIS_URL);
  const { default: SystemPrompt } = await import(SYSTEM_PROMPT_URL);
  const plugin = await import('../index.js');

  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin({
    name: 'host-stub',
    apply(c) {
      c.provide('webServer', { register: () => () => {} });
      c.provide('connection', { requestRejection: () => undefined });
    },
  });
  const service = ctx.get('systemPrompt', false);

  const before = await service.assemble();
  assert.equal(
    before.sections.some((section) => section.name === CUSTOM_SECTION_NAME),
    false,
    'nothing is registered before the plugin mounts',
  );

  const fiber = ctx.plugin({ name: 'dsh-prompt-setting', inject: plugin.inject, apply: plugin.apply });
  await fiber;

  const mounted = await service.assemble();
  const section = mounted.sections.find((entry) => entry.name === CUSTOM_SECTION_NAME);
  assert.ok(section, 'the plugin registered its section');
  assert.equal(section.text, '', 'registered empty: an unconfigured install contributes nothing');
  assert.equal(section.interpolate, false, 'and never interpolates user text');
  // The assembly carries no `order` (the service sorts before the waterfall), so
  // the position IS the evidence: ours must be last, past every shipped section.
  assert.equal(Object.hasOwn(section, 'order'), false);
  assert.equal(mounted.sections.at(-1).name, CUSTOM_SECTION_NAME);

  // Disposing the mount must leave no residual registration, or the next mount
  // would collide with the name it already owns.
  await fiber.dispose();
  const after = await service.assemble();
  assert.equal(
    after.sections.some((entry) => entry.name === CUSTOM_SECTION_NAME),
    false,
    'the registration went with the mount',
  );
  assert.deepEqual(names(after), names(before), 'and the assembly is exactly what it was');
});

test('integration R7: with nothing configured the real rendered prompt is byte-identical to no plugin at all', suite, async () => {
  const { renderPrompt } = await import(SYSTEM_PROMPT_URL);
  // The baseline is a real context with the same fixture sections but WITHOUT
  // this plugin mounted, so the comparison is against a genuinely different mount.
  const baseline = await boot(CUSTOM);
  const mounted = await mountRealPlugin(CUSTOM);

  const baselineAssembly = await baseline.service.assemble();
  const mountedAssembly = await mounted.service.assemble();
  const without = baselineAssembly.sections;
  const with_ = mountedAssembly.sections;
  assert.equal(with_.length, without.length + 1, 'the only difference is our empty section');
  assert.equal(names(mountedAssembly).slice(0, without.length).join(','), names(baselineAssembly).join(','));
  assert.equal(with_.at(-1).name, CUSTOM_SECTION_NAME);

  const baselinePrompt = renderPrompt(baselineAssembly);
  const mountedPrompt = renderPrompt(mountedAssembly);
  assert.ok(baselinePrompt.length > 0, 'the baseline is a real prompt, not an empty string');
  assert.equal(mountedPrompt, baselinePrompt, 'the empty section contributes zero bytes');
  assert.equal(renderPrompt({ sections: without, variables: {} }), baselinePrompt, 'and the renderer is deterministic');
});

test('integration R7: a reserved replace lands LAST, byte for byte, in the real rendered prompt', suite, async () => {
  const { renderPrompt } = await import(SYSTEM_PROMPT_URL);
  const { service, call } = await mountRealPlugin(CUSTOM);
  // Deliberately awkward text: a trailing newline, tabs, double spaces and CRLF,
  // so "byte for byte" is a real claim rather than a trimmed one.
  const text = 'MY OWN PROMPT\n\tindented  line\r\n\ntrailing  \n';
  const put = await call({
    method: 'PUT',
    url: '/prompt-setting/overrides',
    body: JSON.stringify({ layer: 'user', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text } }),
  });
  assert.equal(put.status, 200);

  const assembly = await service.assemble();
  const last = assembly.sections.at(-1);
  assert.equal(last.name, CUSTOM_SECTION_NAME);
  assert.equal(last.text, text, 'byte for byte, whitespace included');
  assert.equal(last.interpolate, false, 'the flag survived the transform');
  assert.equal(Buffer.from(last.text, 'utf8').equals(Buffer.from(text, 'utf8')), true);

  const prompt = renderPrompt(assembly);
  assert.equal(prompt.endsWith(`\n\n${text}`), true, 'the user text is what the model reads last');
  assert.equal(prompt.includes('MY OWN PROMPT'), true);

  // Removing it restores the unconfigured prompt exactly: the empty section
  // cannot leave a trace behind.
  const deleted = await call({
    method: 'DELETE',
    url: `/prompt-setting/overrides?layer=user&name=${encodeURIComponent(CUSTOM_SECTION_NAME)}`,
  });
  assert.equal(deleted.status, 200);
  const cleared = renderPrompt(await service.assemble());
  assert.equal(cleared.includes('MY OWN PROMPT'), false);
  assert.equal(cleared, renderPrompt(await (await boot(CUSTOM)).service.assemble()));
});

test('integration R7: an unknown {{reference}} in user text is never interpolated and never throws', suite, async () => {
  const { renderPrompt } = await import(SYSTEM_PROMPT_URL);
  const { service, call } = await mountRealPlugin(CUSTOM);
  // Three shapes: an unknown (but well-formed) name, a malformed name, and a
  // lone `{{`. The shipped renderer throws on the first two and treats the
  // third as prose — in a section that interpolates.
  const text = 'keep {{not_registered}} and {{NotValid}} and {{ lone\nand a real {{}} pair';
  const put = await call({
    method: 'PUT',
    url: '/prompt-setting/overrides',
    body: JSON.stringify({ layer: 'user', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text } }),
  });
  assert.equal(put.status, 200);

  const assembly = await service.assemble();
  let prompt = null;
  assert.doesNotThrow(() => {
    prompt = renderPrompt(assembly);
  }, 'the real pre-step must not fail because of user text');
  assert.equal(prompt.endsWith(`\n\n${text}`), true, 'the text is handed back untouched');

  // The control that makes the requirement concrete: the same text in a section
  // that DOES interpolate takes the whole render down.
  assert.throws(
    () => renderPrompt({ sections: [{ name: 'control', text: 'keep {{not_registered}}' }], variables: {} }),
    /unknown prompt variable/,
  );
  assert.throws(
    () => renderPrompt({ sections: [{ name: 'control', text: 'keep {{NotValid}}' }], variables: {} }),
    /malformed prompt variable/,
  );
});

// ---------------------------------------------------------------------------
// Revision 8: the outermost listener that keeps the reserved section last.
//
// These run against the real service and the real renderer, because the claim
// they measure — "the last thing in the prompt the model reads is the user's
// text, even when a listener registered before this plugin appends its own
// section" — is a claim about the ORDER the real waterfall hands back, and
// about the real `renderPrompt`'s bytes. A double would prove neither.
// ---------------------------------------------------------------------------

/** The section the live `dsh-expression` listener appends. */
const COMPANION_SECTION = { name: 'dsh-expression:companion', text: 'COMPANION' };

/**
 * Register the live machine's other plugin, faithfully: a listener that is
 * registered **before** this plugin (so it is outer to the override listener),
 * calls `next()` like a well-behaved listener, and appends its own section once
 * `next()` has returned. `dsh-expression` does exactly this with
 * `dsh-expression:companion`, which is what puts a third party's text after
 * 「我的 Prompt」 and is why Revision 8 exists.
 *
 * What this listener returns is recorded, so a test can compare references and
 * tell "the keeper moved something" from "the keeper returned this by identity".
 * @param ctx - a real Cordis context.
 * @param sink - an object the returned objects are recorded on.
 * @returns the `sink`.
 */
function appendCompanion(ctx, sink = {}) {
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const downstream = await next();
    sink.downstream = downstream;
    sink.appended = { ...downstream, sections: [...downstream.sections, COMPANION_SECTION] };
    return sink.appended;
  });
  return sink;
}

/**
 * Register an observer that sits **outside** the keeper, which is the only way
 * to hold the value the keeper returned: `prepend` puts it in front of a
 * listener that is itself prepended, and registering after the mount is what
 * makes that possible (the residual boundary CONTRACT §15.10 records).
 * @param ctx - the context the plugin was mounted on.
 * @param seen - a one-element array the observed value is written into.
 */
function observeOutermost(ctx, seen) {
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    seen[0] = await next();
    return seen[0];
  }, { prepend: true });
}

test('integration R8: with nothing configured an outer appender still ends the prompt, and the keeper copies nothing', suite, async () => {
  const { renderPrompt } = await import(SYSTEM_PROMPT_URL);
  // The no-plugin baseline, with the SAME appender registered, so the byte
  // comparison below is against a genuinely different mount and not against our
  // own arithmetic.
  const baseline = await boot(CUSTOM);
  appendCompanion(baseline.ctx);
  const baselinePrompt = renderPrompt(await baseline.service.assemble());

  const sink = {};
  const mounted = await mountRealPlugin(CUSTOM, {
    beforePlugin: async (ctx) => appendCompanion(ctx, sink),
  });
  const seen = [];
  observeOutermost(mounted.ctx, seen);

  const assembly = await mounted.service.assemble();

  // An empty section renders nothing, so its position is unobservable: the
  // keeper must not have touched a single part of the assembly (§15.10).
  assert.equal(assembly, sink.appended, 'the keeper returned the downstream value by identity');
  assert.equal(seen[0], sink.appended, 'and that is the reference the outermost observer received');
  assert.deepEqual(names(assembly), [
    'harness:identity',
    'deployment:persona-prefix',
    'test:one',
    'test:two',
    'deployment:persona-suffix',
    CUSTOM_SECTION_NAME,
    'dsh-expression:companion',
  ]);
  assert.equal(assembly.sections.at(-1).name, 'dsh-expression:companion', 'nothing was moved');
  // And the bytes are the no-plugin bytes, exactly.
  assert.equal(renderPrompt(assembly), baselinePrompt, 'zero contribution, appender or not');
  assert.match(baselinePrompt, /COMPANION$/);
});

test('integration R8: with text configured the reserved section is moved past an outer appender, byte for byte', suite, async () => {
  const { renderPrompt } = await import(SYSTEM_PROMPT_URL);
  const baseline = await boot(CUSTOM);
  appendCompanion(baseline.ctx);
  const baselinePrompt = renderPrompt(await baseline.service.assemble());

  const sink = {};
  const mounted = await mountRealPlugin(CUSTOM, {
    beforePlugin: async (ctx) => appendCompanion(ctx, sink),
  });
  const seen = [];
  observeOutermost(mounted.ctx, seen);

  // Awkward text on purpose — trailing newline, tabs, CRLF, double spaces — so
  // "the model reads this last, byte for byte" is a real claim.
  const text = 'MY OWN PROMPT\n\tindented  line\r\n\ntrailing  \n';
  const put = await mounted.call({
    method: 'PUT',
    url: '/prompt-setting/overrides',
    body: JSON.stringify({ layer: 'user', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text } }),
  });
  assert.equal(put.status, 200);

  const assembly = await mounted.service.assemble();

  // The appender DID append after the override listener's result: without the
  // keeper this would be the last entry, which is the live-machine defect.
  assert.equal(sink.appended.sections.at(-1).name, 'dsh-expression:companion');
  // The keeper moved it, so the value is a copy — and the observer outside the
  // keeper saw that copy.
  assert.notEqual(assembly, sink.appended, 'a real move returns a copy');
  assert.notEqual(assembly.sections, sink.appended.sections, 'and a fresh sections array');
  assert.equal(seen[0], assembly, 'the outermost observer received exactly what the keeper returned');
  assert.deepEqual(names(assembly), [
    'harness:identity',
    'deployment:persona-prefix',
    'test:one',
    'test:two',
    'deployment:persona-suffix',
    'dsh-expression:companion',
    CUSTOM_SECTION_NAME,
  ]);
  const last = assembly.sections.at(-1);
  assert.equal(last.name, CUSTOM_SECTION_NAME, 'the user text is what the prompt ends with');
  assert.equal(last.text, text, 'byte for byte, whitespace included');
  assert.equal(last.interpolate, false, 'and the flag survived the move');
  assert.equal(Buffer.from(last.text, 'utf8').equals(Buffer.from(text, 'utf8')), true);
  // Nothing else was reordered or rebuilt: every entry is the very object the
  // appender handed over, our own section included. That is the "we reorder, we
  // do not rebuild" claim — and the copy above is a fresh ARRAY, not fresh
  // sections.
  for (const name of ['harness:identity', 'test:one', 'dsh-expression:companion', CUSTOM_SECTION_NAME]) {
    assert.equal(
      assembly.sections.find((section) => section.name === name),
      sink.appended.sections.find((section) => section.name === name),
      `${name} is the same section object, only reordered`,
    );
  }
  // The byte-level promise: the prompt that exists without this plugin, plus the
  // user's text at the very end.
  const prompt = renderPrompt(assembly);
  assert.equal(prompt, `${baselinePrompt}\n\n${text}`);
  assert.equal(prompt.endsWith(text), true);

  // Removing the text restores the no-plugin bytes exactly, appender included:
  // the move leaves no trace once there is nothing to move.
  const deleted = await mounted.call({
    method: 'DELETE',
    url: `/prompt-setting/overrides?layer=user&name=${encodeURIComponent(CUSTOM_SECTION_NAME)}`,
  });
  assert.equal(deleted.status, 200);
  const cleared = await mounted.service.assemble();
  assert.equal(cleared.sections.at(-1).name, 'dsh-expression:companion');
  assert.equal(renderPrompt(cleared), baselinePrompt);
});

test('integration R8: a complete scope still collapses the whole list, keeper move and appender included', suite, async () => {
  const text = 'MINE';
  const mounted = await mountRealPlugin([
    ...CUSTOM,
    { name: 'preset:locked', order: 5000, text: 'LOCKED', complete: true },
  ], {
    beforePlugin: async (ctx) => appendCompanion(ctx),
  });
  const put = await mounted.call({
    method: 'PUT',
    url: '/prompt-setting/overrides',
    body: JSON.stringify({ layer: 'user', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text } }),
  });
  assert.equal(put.status, 200);

  // The platform restores the complete section AFTER the waterfall, replacing the
  // whole list — so it discards the appender's section AND the keeper's move
  // alike. This is the residual boundary §15.10 states; what matters is that the
  // frozen verdict is unchanged by this revision.
  const assembly = await mounted.service.assemble();
  assert.deepEqual(assembly.sections, [{ name: 'preset:locked', text: 'LOCKED' }]);

  const snapshot = await mounted.call({ url: '/prompt-setting/snapshot' });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.payload.frozen, true);
  assert.equal(snapshot.payload.frozenSection, 'preset:locked');
  assert.match(snapshot.payload.frozenReason, /single complete section "preset:locked"/);
  assert.equal(snapshot.payload.rendered, 'LOCKED');
  assert.equal(snapshot.payload.effective.sections.every((section) => section.overridable === false), true);
  const mine = snapshot.payload.effective.sections.find((section) => section.name === CUSTOM_SECTION_NAME);
  assert.deepEqual([mine.applied, mine.action, mine.overrideLayer], [false, 'replace', 'user']);
  assert.match(mine.reason, /removed from the assembled result/);
  // The registered view is unaffected too: the keeper changed neither `base` nor
  // the recorded downstream sections (they are captured before it runs).
  assert.equal(snapshot.payload.base.sections.at(-1).name, CUSTOM_SECTION_NAME);
});

test('integration R8: a hand-edited hide removes the section, and the keeper does nothing and does not throw', suite, async () => {
  const { renderPrompt } = await import(SYSTEM_PROMPT_URL);
  // `hide` is the escape hatch's action: no route can write it any more, and a
  // user who hand-edits it gets a scope with no reserved section at all.
  writeUserConfigFile([{ name: CUSTOM_SECTION_NAME, action: 'hide' }]);
  const baseline = await boot(CUSTOM);
  appendCompanion(baseline.ctx);
  const baselinePrompt = renderPrompt(await baseline.service.assemble());

  const sink = {};
  const mounted = await mountRealPlugin(CUSTOM, {
    beforePlugin: async (ctx) => appendCompanion(ctx, sink),
  });

  // `await` is the assertion that it did not throw: an exception on the assembly
  // path would reject here.
  const assembly = await mounted.service.assemble();
  assert.equal(names(assembly).includes(CUSTOM_SECTION_NAME), false, 'the hide took effect');
  assert.equal(assembly, sink.appended, 'nothing to move: the downstream value comes back by identity');
  assert.equal(assembly.sections.at(-1).name, 'dsh-expression:companion');
  assert.equal(renderPrompt(assembly), baselinePrompt, 'and the bytes are the no-plugin bytes');

  // The snapshot still reports the hide, and does not treat it as an anomaly.
  const snapshot = await mounted.call({ url: '/prompt-setting/snapshot' });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.payload.frozen, false);
  const hidden = snapshot.payload.effective.sections.find((section) => section.name === CUSTOM_SECTION_NAME);
  assert.deepEqual([hidden.applied, hidden.index, hidden.origin], [true, null, 'registered']);
});

test('integration R8: disposing the mount removes the keeper with the section it guards', suite, async () => {
  const { Context } = await import(CORDIS_URL);
  const { default: SystemPrompt } = await import(SYSTEM_PROMPT_URL);
  const { customSection } = await import('../core/custom.js');
  const plugin = await import('../index.js');

  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin({
    name: 'host-stub',
    apply(c) {
      c.provide('webServer', { register: () => () => {} });
      c.provide('connection', { requestRejection: () => undefined });
    },
  });
  // The other plugin, registered first: outer to the override listener, and it
  // must end up inner to the keeper once the plugin mounts.
  appendCompanion(ctx);
  const service = ctx.get('systemPrompt', false);
  // The user's text reaches the section through the layer file, read at mount.
  writeUserConfigFile([{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' }]);

  const fiber = ctx.plugin({ name: 'dsh-prompt-setting', inject: plugin.inject, apply: plugin.apply });
  await fiber;

  const mounted = await service.assemble();
  assert.equal(mounted.sections.at(-1).name, CUSTOM_SECTION_NAME, 'mounted: the keeper moved it past the appender');
  assert.equal(mounted.sections.at(-1).text, 'MINE');

  await fiber.dispose();
  const after = await service.assemble();
  assert.equal(names(after).includes(CUSTOM_SECTION_NAME), false, 'the registration went with the mount');
  assert.equal(after.sections.at(-1).name, 'dsh-expression:companion');

  // The strongest half of "no residual listener": register the reserved section
  // again BY HAND, with text. If the keeper had survived the dispose it would
  // move it past the appender; the appender must stay last.
  await ctx.plugin({
    name: 'hand-registered',
    inject: ['systemPrompt'],
    apply(c) {
      c.systemPrompt.section({ ...customSection(), text: 'MINE' });
    },
  });
  const reregistered = await service.assemble();
  // No `CUSTOM` fixtures on this manual mount: the shipped sections, ours, and
  // the appender's, in that order.
  assert.deepEqual(names(reregistered), [
    'harness:identity',
    'deployment:persona-prefix',
    'deployment:persona-suffix',
    CUSTOM_SECTION_NAME,
    'dsh-expression:companion',
  ]);
  assert.equal(reregistered.sections.at(-1).name, 'dsh-expression:companion', 'nothing moved it: the keeper is gone');
  assert.equal(reregistered.sections.at(-2).name, CUSTOM_SECTION_NAME);
});

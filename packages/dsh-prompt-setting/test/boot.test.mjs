/**
 * Boot-resilience assertions (g-013).
 *
 * The claim this file pins: **a breaking DSH update must not take the harness
 * down with this plugin, and the failure must be readable in the terminal.**
 * Four surfaces, all asserted against doubles rather than against the host, so
 * they hold on a machine with no DSH at all:
 *
 * 1. the import-time compatibility self-check (silent in range, one line out of
 *    range or undetected, never a throw) — `core/compat.js` + `index.js`;
 * 2. `apply`'s guard: a renamed/throwing/wrong-shaped host service produces
 *    **one** readable line, never an exception, and every effect registered
 *    before the failure is rolled back (no half-mount);
 * 3. boot continuity: the next plugin in the same pipeline still mounts;
 * 4. the client half's factory guard: a load failure never reaches the loader,
 *    and the degradation is a card (markers intact) or nothing at all when even
 *    `react` is gone.
 *
 * Deliberately *not* re-asserted here: render-time failure (the existing
 * `renderFailureCard` path) is covered by `test/client.test.mjs` ("…renders the
 * failure card…", `data-render-state === 'error'`), and the fingerprint region
 * by `test/build.test.mjs`; this suite asserts those two are still in place
 * rather than duplicating them.
 *
 * Run: `node --test` (in `packages/dsh-prompt-setting/`)
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  BOOT_COMPAT,
  DSH_PEER_RANGE,
  DSH_PEER_RANGE_FALLBACK,
  apply,
  inject,
  reportBootCompatibility,
} from '../index.js';
import {
  compareSemver,
  compatibilityVerdict,
  detectDshVersion,
  firstCauseLine,
  mountFailureMessage,
  satisfiesRange,
} from '../core/compat.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const clientSource = readFileSync(join(packageRoot, 'client.js'), 'utf8');
const PLUGIN_NAME = 'dsh-prompt-setting';
/** The plugin version the host reports; `test/host.test.mjs` pins it to the manifest. */
const PLUGIN_VERSION = packageJson.version;
/** The declared range, taken from the manifest so the two cannot drift. */
const RANGE = packageJson.peerDependencies['@deepseek-ai/dsh'];
/** The manifest entry name of this plugin's bundle, used by the rescue copy. */
const RESCUE_HINT = '出问题时';

let home;
let previousHome;

// Every mount reads the user layer, so point `$DSH_HOME` at a throwaway
// directory: a boot test must never read — and could never write — the real
// `~/.dsh`.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-prompt-setting-boot-'));
  previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
});

/**
 * The temporary-dir helper for the probe tests.
 * @param prefix - the directory name prefix.
 * @returns the created path.
 */
function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Write a fake `@deepseek-ai/dsh` install under a root.
 * @param root - the directory that plays the role of a `node_modules` parent.
 * @param contents - the manifest text to write.
 * @returns the manifest path.
 */
function writeFakeInstall(root, contents) {
  const directory = join(root, 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(directory, { recursive: true });
  const manifest = join(directory, 'package.json');
  writeFileSync(manifest, contents);
  return manifest;
}

/**
 * The anchor a `createRequire` probe would use for a directory: a synthetic
 * file inside it (resolution then walks *its* ancestors' `node_modules`).
 * @param directory - the directory.
 * @returns the anchor path.
 */
function anchorFor(directory) {
  return join(directory, '__dsh_probe__.js');
}

/**
 * Mount the plugin against doubles that can be broken the way a future DSH
 * would break them. Every knob is off by default, so the default harness is a
 * faithful, working host.
 * @param options.register - `ok` | `missing` | `throws` | `no-disposer`.
 * @param options.on - `ok` | `throws`.
 * @param options.effect - `ok` | `missing`.
 * @param options.logger - `ok` | `missing` | `throwing`.
 * @param options.section - `ok` | `missing` | `throws` | `no-disposer` (the
 *   `systemPrompt.section()` registration surface, Revision 7).
 * @returns the doubles plus what the mount did: `routes`, the `live` route
 *   table (what is actually serving), `listeners`, `sections`, `logs` and a
 *   dispose count.
 */
function mountContext(options = {}) {
  const routes = [];
  const live = new Set();
  const listeners = [];
  const sections = [];
  const logs = [];
  let disposed = 0;
  let sectionsDisposed = 0;
  const webServer = {};
  if (options.register !== 'missing') {
    webServer.register = (route) => {
      if (options.register === 'throws') {
        throw new Error('webserver: duplicate prefix route "/prompt-setting"');
      }
      routes.push(route);
      live.add(route.path);
      // A host that stops returning a disposer: the route is in the table and
      // nothing can remove it.
      if (options.register === 'no-disposer') return { remove: () => {} };
      return () => {
        live.delete(route.path);
        disposed += 1;
      };
    };
  }
  const systemPrompt = {
    async assemble() {
      return { sections: [], contexts: [], tools: [], variables: {} };
    },
  };
  if (options.section !== 'missing') {
    systemPrompt.section = (definition) => {
      if (options.section === 'throws') {
        throw new Error(`systemPrompt: prompt section "${definition.name}" is already registered`);
      }
      const registered = { ...definition };
      sections.push(registered);
      // A host that stops returning a disposer: the section is registered in
      // the global layer and nothing can remove it.
      if (options.section === 'no-disposer') return { remove: () => {} };
      return () => {
        const at = sections.indexOf(registered);
        if (at >= 0) sections.splice(at, 1);
        sectionsDisposed += 1;
      };
    };
  }
  const ctx = {
    connection: { requestRejection: () => undefined },
    webServer,
    systemPrompt,
    get() {
      return undefined;
    },
    on(name, callback) {
      if (options.on === 'throws') throw new Error('ctx.on is not a function');
      const listener = { name, callback };
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
        disposed += 1;
      };
    },
    logger: options.logger === 'missing'
      ? undefined
      : options.logger === 'throwing'
        ? { error() { throw new Error('logger broken'); } }
        : { error(message) { logs.push(String(message)); } },
  };
  if (options.effect !== 'missing') {
    // Cordis' `effect()` runs the factory immediately and returns a disposer.
    // Measured against the real package (NOTES.md §91): a throw inside the
    // factory propagates to the caller, so this double is faithful where it
    // matters.
    ctx.effect = (factory) => factory();
  }
  return {
    ctx,
    routes,
    live,
    listeners,
    sections,
    logs,
    disposedCount: () => disposed,
    sectionsDisposedCount: () => sectionsDisposed,
  };
}

/**
 * Capture `console.error` for one call.
 * @param run - the body to run.
 * @returns what `run` returned, plus the captured lines and any thrown value.
 */
function withConsoleError(run) {
  const lines = [];
  const original = console.error;
  console.error = (message) => lines.push(String(message));
  try {
    return { value: run(), thrown: null, lines };
  } catch (error) {
    return { value: null, thrown: error, lines };
  } finally {
    console.error = original;
  }
}

/**
 * Mount against a captured terminal. Every failed mount writes its one line to
 * `stderr` **as well as** to `ctx.logger` — the terminal is the channel the
 * g-013 requirement is about — so a test must both capture it (to keep the
 * suite output clean) and assert it.
 * @param ctx - the Host plugin context.
 * @param config - the plugin config.
 * @returns the captured terminal lines (and any thrown value, which must be
 *   null).
 */
function applyCapturingTerminal(ctx, config = {}) {
  const captured = withConsoleError(() => apply(ctx, config));
  assert.equal(captured.thrown, null, 'apply must never throw outward');
  return captured;
}

/**
 * Load `client.js` in a vm sandbox with a controllable `require`, and call the
 * factory the loader would call.
 * @param options.source - source to load (defaults to the real file).
 * @param options.failRequire - a module name whose `require` must throw.
 * @returns the registered descriptor, the factory's result, any thrown value,
 *   the captured `console.error` lines and the React double.
 */
function loadClientFactory(options = {}) {
  let descriptor = null;
  const errors = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          descriptor = entry;
        },
      },
    },
    console: { error: (message) => errors.push(String(message)), log() {}, warn() {} },
  };
  sandbox.fetch = () => Promise.reject(new Error('fetch not stubbed'));
  vm.createContext(sandbox);
  vm.runInContext(options.source ?? clientSource, sandbox, { filename: 'client.js' });
  assert.ok(descriptor, 'client.js must register a lazy factory');
  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length === 1 ? children[0] : children } };
    },
    Fragment: Symbol('Fragment'),
  };
  const requireStub = (name) => {
    if (options.failRequire === name) throw new Error(`Cannot find module '${name}'`);
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') throw new Error('not installed');
    throw new Error(`unexpected require: ${name}`);
  };
  let thrown = null;
  let module = null;
  try {
    module = descriptor.factory(requireStub);
  } catch (error) {
    thrown = error;
  }
  return { descriptor, module, thrown, errors, React };
}

/**
 * Collect every string in an element tree.
 * @param node - an element, an array, or a leaf.
 * @returns the concatenated text.
 */
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node !== 'object') return String(node);
  return textOf(node.props ? node.props.children : null);
}

// ---------------------------------------------------------------------------
// 1. The import-time compatibility self-check
// ---------------------------------------------------------------------------

test('boot: the tested range is the manifest range, and every verdict is silent only in range', () => {
  assert.equal(DSH_PEER_RANGE, RANGE, 'the module and `package.json` cannot drift');
  assert.equal(
    DSH_PEER_RANGE_FALLBACK,
    RANGE,
    'the IO-failure fallback must equal the manifest range too, or an unreadable manifest would judge against a stale range',
  );
  assert.equal(packageJson.peerDependenciesMeta?.['@deepseek-ai/dsh']?.optional, true, 'the peer is optional');

  // The range itself: the tested rc is in, one rc below it is out, the first
  // branch admits every later 0.1.x (prereleases included, since they rank below
  // 0.2.0), and the second branch both admits every 0.2.0 prerelease and carries
  // the range past the `0.2.0` release — up to `<0.2.1-0`, the deliberate
  // re-evaluation boundary (NOTES.md §100).
  assert.equal(satisfiesRange('0.1.7-rc.2', RANGE), true, 'the verified lower bound');
  assert.equal(satisfiesRange('0.1.7', RANGE), true, 'the release of the tested rc is in range');
  assert.equal(satisfiesRange('0.1.7-rc.1', RANGE), false, 'below the tested prerelease (unchanged)');
  assert.equal(satisfiesRange('0.1.8-0', RANGE), true, 'the widened bound admits later 0.1.x prereleases');
  assert.equal(satisfiesRange('0.1.99', RANGE), true, 'and every later 0.1.x release');
  assert.equal(satisfiesRange('0.2.0-0', RANGE), true, 'the smallest 0.2.0 prerelease');
  assert.equal(satisfiesRange('0.2.0-alpha', RANGE), true, '§99: every 0.2.0 prerelease ranks below 0.2.0');
  assert.equal(satisfiesRange('0.2.0-beta.3', RANGE), true);
  assert.equal(satisfiesRange('0.2.0-rc.1', RANGE), true);
  assert.equal(satisfiesRange('0.2.0-rc.2', RANGE), true, 'the version this plugin runs on today');
  assert.equal(
    satisfiesRange('0.2.0', RANGE),
    true,
    '§100: the GA release must be in range — the platform boot gate skips the whole bundle when it is not',
  );
  assert.equal(satisfiesRange('0.2.0-1', RANGE), true, 'and later 0.2.0 prereleases with it');
  assert.equal(satisfiesRange('0.2.1-0', RANGE), false, '§100: the final upper bound itself is excluded');
  assert.equal(satisfiesRange('0.2.1', RANGE), false, 'and so is the release that follows it');
  assert.equal(satisfiesRange('0.3.0', RANGE), false);

  // §98/§99: the second `||` alternative exists for **strict** `node-semver`
  // (npm / pnpm peer resolution, *without* `includePrerelease`), which refuses a
  // prerelease unless some comparator in the same alternative names that exact
  // `[major, minor, patch]` tuple with a prerelease of its own. This parser has
  // no such rule — and *every* behavioural assertion above is green whether the
  // bridge reads `0.2.0-0` or `0.2.0-rc.2`. Hence a shape assertion, pinned to
  // the smallest 0.2.0 prerelease: strict semver whitelists the tuple, it does
  // not rank it, so any higher bound silently drops `0.2.0-alpha`, `0.2.0-beta`
  // and `0.2.0-rc.1`.
  const bridges = RANGE.split('||')
    .flatMap((alternative) => alternative.trim().split(/\s+/))
    .filter((comparator) => /^>=0\.2\.0-/.test(comparator));
  assert.deepEqual(
    bridges,
    ['>=0.2.0-0'],
    `"${RANGE}" must bridge strict semver at 0.2.0-0 (the smallest 0.2.0 prerelease), not at a later one`,
  );

  // §100: the *last* comparator of the range is the one that decides the whole
  // 0.2.x line, and it must clear the `0.2.0` release. Two `<` bounds are
  // expected: `<0.2.0` closes the legacy first branch (which now only owns the
  // 0.1.x line) and `<0.2.1-0` is the re-evaluation boundary. A `<0.2.0` final
  // bound is exactly the P0 this section fixes: the platform gate would skip the
  // entire bundle on the day `0.2.0` ships.
  const uppers = RANGE.split('||')
    .flatMap((alternative) => alternative.trim().split(/\s+/))
    .filter((comparator) => comparator.startsWith('<'));
  assert.deepEqual(
    uppers,
    ['<0.2.0', '<0.2.1-0'],
    `"${RANGE}" must end at <0.2.1-0 (0.2.0 in, 0.2.1-0 and later out), not at <0.2.0`,
  );

  // The semver §11 corners this range depends on.
  assert.equal(compareSemver('0.1.7-rc.2', '0.1.7'), -1, 'a prerelease ranks below its release');
  assert.equal(compareSemver('0.1.7-rc.10', '0.1.7-rc.2'), 1, 'numeric identifiers compare numerically');
  assert.equal(compareSemver('0.1.7-alpha', '0.1.7-alpha.1'), -1, 'a shorter prerelease ranks below');
  assert.equal(compareSemver('1.0.0+build', '1.0.0'), 0, 'build metadata is ignored');
  assert.equal(compareSemver('nonsense', '1.0.0'), null);

  // A shorthand this parser does not implement is "cannot tell", never a guess.
  for (const unsupported of ['^1.0.0', '~1.0.0', '1.x', '1.0.0 - 2.0.0']) {
    assert.equal(satisfiesRange('1.0.0', unsupported), null, `"${unsupported}" must not be guessed`);
  }
  assert.equal(satisfiesRange('nonsense', RANGE), null);
  assert.equal(satisfiesRange('1.0.0', ''), null);

  // The live verdict this process ran is consistent with the range it judged.
  assert.ok(['ok', 'out-of-range', 'undetected'].includes(BOOT_COMPAT.level));
  if (BOOT_COMPAT.version !== null) {
    assert.equal(BOOT_COMPAT.level === 'ok', satisfiesRange(BOOT_COMPAT.version, RANGE));
  }
  assert.equal(BOOT_COMPAT.message === null, BOOT_COMPAT.level === 'ok', 'only `ok` is silent');
});

test('boot: in range prints nothing; out of range and undetected each print exactly one line', () => {
  const lines = [];
  const log = (message) => lines.push(String(message));

  const ok = reportBootCompatibility({ detect: () => ({ version: '0.1.7-rc.2' }), log });
  assert.equal(ok.level, 'ok');
  assert.equal(ok.message, null);
  assert.deepEqual(lines, [], 'in range must be completely silent (no boot noise)');

  // §100, end to end: the `0.2.0` GA release takes the *silent* path too. This
  // is the user-visible half of the fix — before it, every boot on 0.2.0 would
  // have warned (and, worse, the platform gate would have dropped the bundle
  // before this code ever ran).
  const ga = reportBootCompatibility({ detect: () => ({ version: '0.2.0' }), log });
  assert.equal(ga.level, 'ok', '0.2.0 GA is in range');
  assert.equal(ga.message, null);
  assert.deepEqual(lines, [], 'and it is silent as well');

  const out = reportBootCompatibility({ detect: () => ({ version: '0.2.1-0' }), log });
  assert.equal(out.level, 'out-of-range');
  assert.equal(lines.length, 1, 'exactly one line');
  assert.equal(lines[0].includes('\n'), false, 'and it is one line, not a report');
  for (const expected of [PLUGIN_NAME, PLUGIN_VERSION, '0.2.1-0', RANGE, 'DSH 启动与其余功能不受影响', RESCUE_HINT]) {
    assert.ok(lines[0].includes(expected), `the warning names ${expected}`);
  }

  lines.length = 0;
  const undetected = reportBootCompatibility({
    detect: () => ({ version: null, reason: 'no @deepseek-ai/dsh/package.json was reachable' }),
    log,
  });
  assert.equal(undetected.level, 'undetected');
  assert.equal(lines.length, 1);
  for (const expected of [PLUGIN_NAME, PLUGIN_VERSION, '无法探测', RANGE, RESCUE_HINT]) {
    assert.ok(lines[0].includes(expected), `the undetected warning names ${expected}`);
  }
});

test('boot: a probe that throws, and a logger that throws, still cannot break the boot', () => {
  const lines = [];
  const threw = reportBootCompatibility({
    detect: () => {
      throw new Error('probe exploded');
    },
    log: (message) => lines.push(String(message)),
  });
  assert.equal(threw.level, 'undetected', 'a throwing probe degrades to "undetected"');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('probe exploded'), 'and the first cause is reported');

  // A logger that throws is not a reason to take the harness down with us.
  assert.doesNotThrow(() => reportBootCompatibility({
    detect: () => ({ version: '0.2.1-0' }),
    log: () => {
      throw new Error('logger broken');
    },
  }));

  // Detection that reports nothing at all is a verdict too.
  assert.equal(reportBootCompatibility({ detect: () => ({}), log: () => {} }).level, 'undetected');
  assert.equal(reportBootCompatibility({ detect: () => undefined, log: () => {} }).level, 'undetected');
});

test('boot: the version probe reads a real install and says why when it cannot', () => {
  const root = tempDir('dsh-probe-install-');
  const anchor = [anchorFor(root)];
  try {
    const manifest = writeFakeInstall(root, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' }));
    const inRange = detectDshVersion({ anchors: anchor });
    assert.equal(inRange.version, '0.1.7-rc.2');
    // `createRequire` answers with the real path (`/private/var/...` on macOS).
    assert.equal(realpathSync(inRange.source), realpathSync(manifest), 'the source names the manifest it read');
    assert.equal(inRange.reason, null);
    assert.equal(
      compatibilityVerdict({ pluginName: PLUGIN_NAME, pluginVersion: PLUGIN_VERSION, expectedRange: RANGE, detection: inRange }).level,
      'ok',
    );

    // A different installed version is a verdict, not an error. `0.2.1-0` is the
    // first version outside the §100 upper bound (`0.2.0` is now inside it).
    writeFakeInstall(root, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-0' }));
    const outOfRange = detectDshVersion({ anchors: anchor });
    assert.equal(outOfRange.version, '0.2.1-0');
    const verdict = compatibilityVerdict({
      pluginName: PLUGIN_NAME,
      pluginVersion: PLUGIN_VERSION,
      expectedRange: RANGE,
      detection: outOfRange,
    });
    assert.equal(verdict.level, 'out-of-range');
    assert.ok(verdict.message.includes('0.2.1-0'));

    // Found but unreadable is "undetected", and the reason names the file.
    writeFakeInstall(root, '{ this is not json');
    const broken = detectDshVersion({ anchors: anchor });
    assert.equal(broken.version, null);
    assert.ok(broken.reason.includes('package.json'), `the reason names the manifest: ${broken.reason}`);

    // A manifest with no version is a failure too, not a silent pass.
    writeFakeInstall(root, JSON.stringify({ name: '@deepseek-ai/dsh' }));
    assert.equal(detectDshVersion({ anchors: anchor }).version, null);

    // Nothing installed anywhere: no candidates, and a reason that says so.
    const empty = tempDir('dsh-probe-empty-');
    try {
      const none = detectDshVersion({ anchors: [anchorFor(empty)] });
      assert.equal(none.version, null);
      assert.deepEqual(none.candidates, []);
      assert.ok(none.reason.includes('no @deepseek-ai/dsh/package.json'));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }

    // Junk anchors are skipped, never thrown on.
    assert.equal(detectDshVersion({ anchors: [null, 42, '', '/nonexistent/__dsh_probe__.js'] }).version, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('boot: the one-line texts are built from the shared contract, not copied', () => {
  const message = mountFailureMessage({
    pluginName: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    dshVersion: '0.1.7-rc.2',
    cause: 'ctx.webServer.register is not a function',
    disposed: 2,
    disposeFailures: 0,
  });
  assert.equal(message.includes('\n'), false);
  for (const expected of [PLUGIN_NAME, PLUGIN_VERSION, '0.1.7-rc.2', '挂载失败', '本插件已停用', '已撤销 2 项', RESCUE_HINT]) {
    assert.ok(message.includes(expected), `the mount failure line names ${expected}`);
  }
  const partial = mountFailureMessage({
    pluginName: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    dshVersion: null,
    cause: 'boom',
    disposed: 1,
    disposeFailures: 1,
  });
  assert.ok(partial.includes('无法探测'), 'an undetected DSH is stated, not left blank');
  assert.ok(partial.includes('另有 1 项撤销时报错'), 'a failing disposer is admitted');
  assert.equal(firstCauseLine(new Error('first line\nsecond line')), 'first line');
});

// ---------------------------------------------------------------------------
// 2. `apply`'s guard: one line, no throw, nothing left half-mounted
// ---------------------------------------------------------------------------

test('boot: a service method renamed away is one readable line, never an exception', () => {
  const harness = mountContext({ register: 'missing' });
  const run = applyCapturingTerminal(harness.ctx);
  assert.equal(harness.logs.length, 1, 'exactly one readable line');
  assert.equal(run.lines.length, 1, 'and exactly one on the terminal too');
  for (const expected of [PLUGIN_NAME, PLUGIN_VERSION, '挂载失败', '本插件已停用', 'DSH 其余功能不受影响', RESCUE_HINT]) {
    assert.ok(harness.logs[0].includes(expected), `the line names ${expected}`);
  }
  assert.ok(harness.logs[0].includes('register'), 'and the first cause');
  assert.equal(harness.listeners.length, 0, 'nothing is left mounted');
  assert.equal(harness.live.size, 0);
});

test('boot: a service method that throws (duplicate route) is one readable line, nothing mounted', () => {
  const harness = mountContext({ register: 'throws' });
  const run = applyCapturingTerminal(harness.ctx);
  assert.equal(harness.logs.length, 1);
  assert.equal(run.lines.length, 1, 'the terminal got the same single line');
  assert.ok(harness.logs[0].includes('duplicate prefix route'), 'the first cause is the host’s own message');
  assert.equal(harness.live.size, 0, 'the route was never registered');
  assert.equal(harness.listeners.length, 0);
});

test('boot: a service that returns the wrong shape is refused instead of leaving an unremovable route', () => {
  const harness = mountContext({ register: 'no-disposer' });
  const run = applyCapturingTerminal(harness.ctx);
  assert.equal(harness.logs.length, 1);
  assert.equal(run.lines.length, 1, 'the terminal got the same single line');
  assert.ok(harness.logs[0].includes('instead of a disposer'), `first cause: ${harness.logs[0]}`);
  assert.equal(harness.listeners.length, 0, 'the listener is not mounted on top of a route we cannot undo');
  // The residual this cannot fix, stated instead of hidden: the host put the
  // route in its own table without handing back a remover, so *that* half is
  // beyond any plugin's reach (NOTES.md §91, boundary ②').
  assert.equal(harness.live.size, 1, 'the host’s own registration has no handle to undo');
});

test('boot: a missing ctx.effect is reported, not thrown', () => {
  const harness = mountContext({ effect: 'missing' });
  applyCapturingTerminal(harness.ctx);
  assert.equal(harness.logs.length, 1);
  assert.ok(harness.logs[0].includes('ctx.effect'), 'the first cause names the host API');
  assert.equal(harness.live.size, 0);
  assert.equal(harness.listeners.length, 0);
});

test('boot: the reserved section is registered with the contract values, last', () => {
  const harness = mountContext();
  applyCapturingTerminal(harness.ctx);
  assert.equal(harness.logs.length, 0, 'a working host says nothing');
  assert.deepEqual(harness.sections, [{
    name: 'prompt-setting:custom-prompt',
    order: 1000000,
    text: '',
    interpolate: false,
  }], 'registered empty, never interpolating, past every shipped order');
});

test('boot: a host with no systemPrompt.section is one readable line and nothing half-mounted', () => {
  // An older/newer service shape: `assemble` exists, `section` does not. The
  // plugin cannot offer its own section, so g-013's rule applies — one line,
  // every earlier effect unwound, no boot failure.
  const harness = mountContext({ section: 'missing' });
  const run = applyCapturingTerminal(harness.ctx);
  assert.equal(run.thrown, null, 'apply must never throw outward');
  assert.equal(harness.logs.length, 1, 'exactly one readable line');
  assert.equal(run.lines.length, 1, 'and exactly one on the terminal too');
  for (const expected of [PLUGIN_NAME, '挂载失败', '本插件已停用', '已撤销 3 项已注册 effect']) {
    assert.ok(harness.logs[0].includes(expected), `the line names ${expected}: ${harness.logs[0]}`);
  }
  assert.ok(harness.logs[0].includes('section'), 'and the first cause names the missing method');
  assert.equal(harness.live.size, 0, 'the route was rolled back');
  assert.equal(harness.listeners.length, 0, 'and so was the listener');
  assert.deepEqual(harness.sections, []);
});

test('boot: a section registration that throws is reported and rolls the mount back', () => {
  const harness = mountContext({ section: 'throws' });
  const run = applyCapturingTerminal(harness.ctx);
  assert.equal(run.thrown, null);
  assert.equal(harness.logs.length, 1);
  assert.ok(harness.logs[0].includes('already registered'), 'the host\'s own message is the first cause');
  assert.equal(harness.live.size, 0);
  assert.equal(harness.listeners.length, 0);
  assert.equal(harness.disposedCount(), 3, 'every earlier effect was undone — the route and both listeners');
  assert.equal(harness.sectionsDisposedCount(), 0, 'and nothing of the section\'s is left to undo');
});

test('boot: a section registration with no disposer is refused, not left unremovable', () => {
  const harness = mountContext({ section: 'no-disposer' });
  const run = applyCapturingTerminal(harness.ctx);
  assert.equal(run.thrown, null);
  assert.equal(harness.logs.length, 1);
  assert.ok(harness.logs[0].includes('instead of a disposer'), `first cause: ${harness.logs[0]}`);
  assert.equal(harness.live.size, 0, 'the route does not outlive a step we could not undo');
  assert.equal(harness.listeners.length, 0);
  // The residual this cannot fix, stated instead of hidden (NOTES.md §91,
  // boundary ②'): the host took the registration without handing back a
  // remover, so that half is beyond any plugin's reach — and a remount would
  // collide with the name it still owns, which is exactly why it is reported.
  assert.equal(harness.sections.length, 1, 'the host\'s own registration has no handle to undo');
});

test('boot: the line always reaches the terminal, even when the host logger is missing or broken', () => {
  for (const shape of ['ok', 'missing', 'throwing']) {
    const harness = mountContext({ on: 'throws', logger: shape });
    const run = applyCapturingTerminal(harness.ctx);
    assert.equal(run.thrown, null, `a ${shape} logger must not turn the report into a throw`);
    assert.equal(run.lines.length, 1, `a ${shape} logger still yields exactly one terminal line`);
    assert.ok(run.lines[0].includes(PLUGIN_NAME));
    // The host's own log record is best effort; the terminal is not.
    assert.equal(harness.logs.length, shape === 'ok' ? 1 : 0);
    if (shape === 'ok') assert.deepEqual([...harness.logs], [...run.lines], 'both channels got the same line');
  }
});

test('boot: a route registered before a later failure is disposed, so nothing serves the prefix', () => {
  // The half-mount the criterion names: the route registers successfully, then
  // the next step (the waterfall listener) fails.
  const harness = mountContext({ on: 'throws' });
  applyCapturingTerminal(harness.ctx);
  assert.equal(harness.routes.length, 1, 'the route really was registered first');
  assert.equal(harness.disposedCount(), 1, 'its disposer ran exactly once');
  assert.equal(harness.live.size, 0, 'and it is no longer live: nothing answers /prompt-setting');
  assert.equal(harness.listeners.length, 0, 'the listener never mounted');
  assert.equal(harness.logs.length, 1);
  assert.ok(harness.logs[0].includes('已撤销 1 项已注册 effect'), 'the line states the rollback');
  assert.ok(harness.logs[0].includes('不会留下半挂载'));
});

test('boot: a failing disposer is contained, and the line admits it', () => {
  const harness = mountContext({ on: 'throws' });
  const originalEffect = harness.ctx.effect;
  // The route registers normally; its *disposer* is what breaks. The rollback
  // must contain that too, or the report itself would become the failure.
  harness.ctx.effect = (factory) => {
    const disposer = originalEffect(factory);
    return () => {
      disposer();
      throw new Error('disposer broken');
    };
  };
  applyCapturingTerminal(harness.ctx);
  assert.equal(harness.logs.length, 1, 'still exactly one line');
  assert.ok(harness.logs[0].includes('另有 1 项撤销时报错'), `the line admits it: ${harness.logs[0]}`);
  assert.equal(harness.live.size, 0, 'the route is gone even though its disposer reported a failure afterwards');
});

test('boot: a failed mount does not stop the next plugin in the same pipeline', () => {
  const broken = mountContext({ on: 'throws' });
  const otherRoutes = [];
  const otherCtx = {
    webServer: {
      register(route) {
        otherRoutes.push(route);
        return () => {};
      },
    },
    effect: (factory) => factory(),
  };
  // The pipeline shape the Loader gives us: one plugin after another, each
  // promise settled on its own.
  const failures = [];
  const pipeline = [
    () => apply(broken.ctx, {}),
    () => {
      otherCtx.effect(() => otherCtx.webServer.register({ kind: 'prefix', path: '/other', handler() {} }), 'other: route');
    },
  ];
  const terminal = withConsoleError(() => {
    for (const step of pipeline) {
      try {
        step();
      } catch (error) {
        failures.push(error);
      }
    }
  });
  assert.equal(terminal.thrown, null);
  assert.equal(terminal.lines.length, 1, 'our plugin printed exactly one terminal line');
  assert.deepEqual(failures, [], 'no step of the pipeline throws');
  assert.equal(broken.logs.length, 1, 'our plugin said exactly one thing');
  assert.equal(otherRoutes.length, 1, 'the other plugin still mounted');
  assert.equal(otherRoutes[0].path, '/other');
});

test('boot: inject is unchanged — the three hard dependencies are still declared', () => {
  // The g-013 boundary analysis (NOTES.md §91) concluded a change here would
  // trade a reported failure for a silent degradation, so this pins the
  // declaration rather than the willingness to change it.
  assert.deepEqual(inject, ['webServer', 'connection', 'systemPrompt']);
});

// ---------------------------------------------------------------------------
// 3. The client factory guard
// ---------------------------------------------------------------------------

test('boot: the client factory never throws back into the loader when require fails', () => {
  const page = loadClientFactory({ failRequire: 'react' });
  assert.equal(page.thrown, null, 'the loader must not see an exception');
  assert.ok(page.module, 'a descriptor is always published');
  assert.deepEqual([...page.module.inject], [], 'without React nothing can be registered');
  assert.equal(typeof page.module.apply, 'function');
  assert.doesNotThrow(() => page.module.apply({ slots: { inject() { throw new Error('no slots service'); } } }));
  assert.equal(page.errors.length, 1, 'exactly one readable line');
  for (const expected of [PLUGIN_NAME, '客户端半加载失败', "Cannot find module 'react'", RESCUE_HINT]) {
    assert.ok(page.errors[0].includes(expected), `the line names ${expected}`);
  }
});

test('boot: a throwing client body degrades to a card that keeps the machine markers', () => {
  const broken = clientSource.replace("const React = require('react');", "throw new Error('G013-BOOT-BREAK');");
  assert.notEqual(broken, clientSource, 'the mutation must actually apply');
  const page = loadClientFactory({ source: broken });
  assert.equal(page.thrown, null, 'a body that throws still must not reach the loader');
  assert.deepEqual([...page.module.inject], ['slots'], 'React is available, so the failure card is published');
  assert.equal(page.errors.length, 1);
  assert.ok(page.errors[0].includes('G013-BOOT-BREAK'), 'the first cause is the thrown message');

  let registered = null;
  page.module.apply({
    slots: {
      inject(name, factory) {
        assert.equal(name, 'settings.section');
        registered = factory();
      },
      register(entry, component) {
        return { entry, component };
      },
    },
  });
  assert.ok(registered, 'the degraded card is registered on the settings section');
  const tree = registered.component();
  assert.equal(tree.props['data-plugin'], PLUGIN_NAME);
  assert.equal(tree.props['data-render-state'], 'error');
  assert.equal(tree.props['data-renderer'], 'none');
  const text = textOf(tree);
  assert.ok(text.includes('G013-BOOT-BREAK'), 'the card shows the cause');
  assert.ok(text.includes(PLUGIN_NAME), 'the card names the plugin');
});

test('boot: a client host that refuses the card is not a throw either', () => {
  const broken = clientSource.replace("const React = require('react');", "throw new Error('G013-BOOT-BREAK');");
  const page = loadClientFactory({ source: broken });
  assert.doesNotThrow(() => page.module.apply({ slots: { inject() { throw new Error('slots gone'); } } }));
  assert.doesNotThrow(() => page.module.apply(undefined));
});

test('boot: the normal client path is untouched, and render-time failure still uses the failure card', () => {
  // 1. The happy path still yields the real plugin descriptor.
  const page = loadClientFactory();
  assert.equal(page.thrown, null);
  assert.deepEqual([...page.module.inject], ['slots', 'locale']);
  assert.equal(typeof page.module.apply, 'function');
  assert.deepEqual([...page.errors], [], 'a healthy load says nothing');
  // 2. The render-time guard (the owner of `renderFailureCard`) is still in
  //    place; `test/client.test.mjs` asserts its behaviour in full.
  assert.ok(clientSource.includes('return renderFailureCard(t, error);'), 'the render-time guard is intact');
  assert.ok(clientSource.includes('function renderFailureCard(t, error)'));
});

// ---------------------------------------------------------------------------
// 4. The self-check script (the shape the platform does not report)
// ---------------------------------------------------------------------------

test('boot: the self-check script ships, runs read-only, and prints the four terminal signatures', () => {
  assert.ok(packageJson.files.includes('scripts'), 'the script must be published with the package');
  assert.equal(packageJson.scripts?.['check-compat'], 'node scripts/check-compat.mjs');
  const script = join(packageRoot, 'scripts', 'check-compat.mjs');
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 0, `the script must exit 0 even when it finds nothing: ${run.stderr}`);
  const stdout = run.stdout;
  for (const expected of [
    'dsh-prompt-setting',
    PLUGIN_VERSION,
    RANGE,
    // The four failure forms, with the platform's own wording, verbatim.
    'dsh: warning: 1 entry did not activate',
    'failed to import',
    '（终端没有任何输出）',
    'pending (waiting for service:',
    'Error: <message>',
    // The rescue path.
    '--dump-config',
    '--patch',
    'dsh rescue --from-default-profile web',
    '退出码恒为 0',
  ]) {
    assert.ok(stdout.includes(expected), `the script output must contain ${expected}`);
  }
  // Its own messages are printed from the real builders, so both branches are
  // visible for a逐字 comparison.
  assert.ok(stdout.includes('检测到 DSH 0.2.1-0'), 'the out-of-range template');
  assert.ok(stdout.includes('无法探测已安装的 DSH 版本'), 'the undetected template');
  assert.ok(stdout.includes('挂载失败'), 'the mount-failure template');
});

test('boot: the self-check script still exits 0 when there is no DSH to find', () => {
  const empty = tempDir('dsh-probe-nowhere-');
  try {
    const env = { ...process.env, HOME: empty, DSH_HOME: join(empty, '.dsh'), PNPM_HOME: join(empty, 'pnpm') };
    delete env.DSH_INSTALL_ROOT;
    delete env.DSH_PROFILE_DIR;
    const run = spawnSync(process.execPath, [join(packageRoot, 'scripts', 'check-compat.mjs')], { encoding: 'utf8', env });
    assert.equal(run.status, 0, 'a missing install is a printed verdict, never a failure');
    assert.ok(run.stdout.includes('无法探测'), 'the verdict says so');
    assert.ok(run.stdout.includes('DSH boot 失败形态'), 'and the guidance is still printed');
    assert.ok(run.stdout.includes('兼容性未经校验'));
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('boot: the self-check script leaves the filesystem alone', () => {
  const untouched = tempDir('dsh-probe-untouched-');
  try {
    const env = { ...process.env, DSH_HOME: untouched };
    execFileSync(process.execPath, [join(packageRoot, 'scripts', 'check-compat.mjs')], { encoding: 'utf8', env });
    // `$DSH_HOME` was pointed at an empty directory: a read-only script leaves
    // it empty (no config, no history, no cache, nothing to rescue).
    assert.deepEqual(readdirSyncSafe(untouched), []);
  } finally {
    rmSync(untouched, { recursive: true, force: true });
  }
});

/**
 * Read a directory, tolerating absence.
 * @param path - the directory.
 * @returns its entry names, or an empty list.
 */
function readdirSyncSafe(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

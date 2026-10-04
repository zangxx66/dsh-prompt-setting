/**
 * Host-half assertions for g-032: 「立即更新」— installing a release through the
 * official plugin manager, without ever restarting anything.
 *
 * Two layers, both offline and both **inert**:
 *   - `core/install.js` is exercised directly — the release-asset URL, the
 *     install/no-install decision, the A1 `link:` refusal, the failure
 *     classification and the bounded request table;
 *   - the three real routes are mounted against a minimal fake Host with a
 *     **stub** `pluginManager` (whose `installBundle` records its arguments and
 *     answers a canned `ChangeResult`) and a **stub** `fetch` (which answers
 *     both the GitHub release check and the asset probe from a table).
 *
 * Nothing here can install a package or reach the network: the only code that
 * would do either is behind those two doubles, and the assertions on
 * `installBundle`'s arguments are the evidence that the shipped call site is the
 * one being tested.
 *
 * Run: `node --test`
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { apply } from '../index.js';
import {
  INSTALL_ASSET_EXTENSION,
  INSTALL_FAILURE_UNKNOWN,
  INSTALL_REQUEST_LIMIT,
  MANAGEMENT_FAILURE_CODES,
  MANAGEMENT_OPERATION_ERROR,
  REFUSAL_ALREADY_INSTALLED,
  REFUSAL_ASSET_MISSING,
  REFUSAL_ASSET_UNVERIFIED,
  REFUSAL_DEVELOPMENT_LINK,
  REFUSAL_INVALID_REQUEST,
  REFUSAL_NO_UPDATE,
  REFUSAL_SERVICE_MISSING,
  buildReleaseAssetUrl,
  classifyInstallFailure,
  createInstallTable,
  describeInstallFailure,
  describeInstalledSpec,
  isAlreadyInstalledOn,
  isLocalSpec,
  publicInstallStatus,
  releasePageForTag,
  resolveInstallPolicy,
  resolveInstallTarget,
  summarizeDiagnostic,
} from '../core/install.js';

const UPDATE_CHECK_PATH = '/prompt-setting/update-check';
const UPDATE_APPLY_PATH = '/prompt-setting/update-apply';
const UPDATE_APPLY_CANCEL_PATH = '/prompt-setting/update-apply/cancel';
const ASSET_URL = 'https://github.com/zangxx66/dsh-prompt-setting/releases/download/0.2.0/dsh-prompt-setting-0.2.0.tgz';

let home;
let previousHome;
let profileDir;

// The preference file lives under `$DSH_HOME`; each case gets a throwaway one,
// so a run can never read or write the real `~/.dsh`. The profile directory is
// a second throwaway: it is what the A1 `link:` check reads.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-prompt-setting-install-'));
  profileDir = mkdtempSync(join(tmpdir(), 'dsh-prompt-setting-profile-'));
  previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
});

/** Write the profile's manifest, which is where the installed spec is read from. */
function writeProfile(dependencies) {
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile', dependencies }, null, 2)}\n`, 'utf8');
}

/**
 * A deterministic id generator (`req-1`, `req-2`, …) so an assertion never
 * depends on randomness, and every `begin` really is a distinct request.
 * @returns the generator.
 */
function sequenceIds() {
  let index = 0;
  return () => `req-${(index += 1)}`;
}

/** A `Response`-shaped double carrying a JSON body. */
function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * One transport that answers **both** questions this feature asks: the GitHub
 * release check (a JSON body) and the release-asset probe (a status only).
 *
 * The two are told apart by method — the check is a `GET`, the probe a `HEAD` —
 * which is also the assertion that the probe never replaces the check's own
 * request.
 * @param options.release - the release body, or a status to fail with.
 * @param options.assetStatus - the HEAD status (default 200).
 * @returns `{fetch, calls}`.
 */
function makeTransport(options = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = String(init.method ?? 'GET');
    calls.push({ url: String(url), method });
    if (method === 'HEAD') {
      if (options.throwOnProbe === true) throw new Error('ECONNRESET');
      return { ok: options.assetStatus === 200, status: options.assetStatus ?? 200 };
    }
    if (options.release === 'network') throw new Error('ECONNREFUSED');
    if (options.release === 'no-release') return jsonResponse({}, 404);
    return jsonResponse(options.release ?? { tag_name: '0.2.0', html_url: null, published_at: '2026-10-01T00:00:00Z' });
  };
  return { fetch, calls };
}

/**
 * A stub plugin manager.
 *
 * `installBundle` records its arguments and returns the canned `ChangeResult`
 * (asynchronously, like the real one), so the assertions can be about *what this
 * plugin asked for* rather than about pnpm.
 * @param options.result - the `ChangeResult` to answer with.
 * @param options.throwOnCall - throw instead of answering.
 * @param options.profile - the `profileContext` shape (`{dir}`), or `null` for none.
 * @returns the stub.
 */
function makeManager(options = {}) {
  const calls = [];
  const service = {
    profile: options.profile === null ? undefined : { dir: options.profile ?? profileDir },
    async installBundle(spec, installOptions) {
      calls.push({ spec, options: installOptions });
      if (typeof options.throwOnCall === 'function') throw options.throwOnCall();
      if (options.throwOnCall === true) throw new Error('lock timeout');
      return (
        options.result ?? {
          changed: true,
          application: 'restart-required',
          stage: 'install',
          target: spec,
          enabled: true,
          bundle: 'dsh-prompt-setting',
        }
      );
    },
    async cancelInstall(requestId) {
      calls.push({ cancel: requestId });
      return typeof options.cancelResult === 'function' ? options.cancelResult(requestId) : { status: 'cancelled' };
    },
  };
  return { service, calls };
}

/** Minimal Node response double. */
function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    end(chunk) {
      this.body = chunk === undefined || chunk === null ? '' : String(chunk);
      this.writableEnded = true;
    },
  };
}

/** Minimal Node request double. */
function makeRequest({ method = 'GET', url = UPDATE_CHECK_PATH, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  return {
    method,
    url,
    headers: {},
    destroy() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/**
 * Mount the plugin against a minimal fake Host.
 * @param options.manager - a stub manager, or `null` for "no pluginManager service".
 * @param options.transport - the stub transport.
 * @param options.rejection - what the trust fence answers.
 * @returns the captured prefix route and the stub manager's calls.
 */
function mountHost(options = {}) {
  const routes = [];
  const manager = options.manager === undefined ? makeManager() : options.manager;
  const ctx = {
    connection: { requestRejection: options.rejection ?? (() => undefined) },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    systemPrompt: {
      async assemble() {
        return { sections: [], contexts: [], tools: [], variables: {} };
      },
      section() {
        return () => {};
      },
    },
    get(name) {
      return name === 'pluginManager' && manager !== null ? manager.service : undefined;
    },
    on() {
      return () => {};
    },
    effect(factory) {
      return factory();
    },
  };
  apply(ctx, { updateCheck: { fetch: options.transport.fetch } });
  return { route: routes[0], manager };
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

/** Let the background install promise run to completion. */
async function settle() {
  for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** `POST /update-apply` and return the parsed body. */
async function startInstall(route, body = {}) {
  const res = await call(route, {
    method: 'POST',
    url: UPDATE_APPLY_PATH,
    body: JSON.stringify(body),
  });
  assert.equal(res.statusCode, 200, 'the start route never answers non-200');
  return json(res);
}

/** `GET /update-apply?requestId=` and return the parsed body. */
async function readStatus(route, requestId) {
  const res = await call(route, { url: `${UPDATE_APPLY_PATH}?requestId=${encodeURIComponent(requestId)}` });
  assert.equal(res.statusCode, 200);
  return json(res);
}

// #region core/install.js — the pure policy

test('install: the release-asset URL is the tarball form DSH accepts', () => {
  assert.equal(
    buildReleaseAssetUrl('0.2.0', '0.2.0'),
    'https://github.com/zangxx66/dsh-prompt-setting/releases/download/0.2.0/dsh-prompt-setting-0.2.0.tgz',
  );
  // The tag is used verbatim: a `v`-prefixed tag is a *different* asset path.
  assert.equal(
    buildReleaseAssetUrl('v0.2.0', '0.2.0'),
    'https://github.com/zangxx66/dsh-prompt-setting/releases/download/v0.2.0/dsh-prompt-setting-0.2.0.tgz',
  );
  // The file segment is built from validated version-ish input and encoded; a
  // value that is not a version cannot reach the URL at all.
  assert.throws(() => buildReleaseAssetUrl('not a tag', '0.2.0'), TypeError);
  assert.throws(() => buildReleaseAssetUrl('0.2.0', 'latest'), TypeError);
  assert.ok(ASSET_URL.endsWith(`${INSTALL_ASSET_EXTENSION}`), 'the extension is part of the contract');
});

test('install: the target comes from the check payload, and only a newer release has one', () => {
  const yes = resolveInstallTarget({ hasUpdate: true, latest: 'v0.2.0'.replace(/^v/, ''), latestTag: 'v0.2.0', releaseUrl: 'https://example.test/r' });
  assert.equal(yes.ok, true);
  assert.equal(yes.tag, 'v0.2.0');
  assert.equal(yes.version, '0.2.0');
  assert.ok(yes.url.includes('/download/v0.2.0/dsh-prompt-setting-0.2.0.tgz'));
  assert.equal(yes.releaseUrl, 'https://example.test/r');

  // No newer release, and "the check could not decide", are both refusals.
  assert.equal(resolveInstallTarget({ hasUpdate: false, latest: '0.2.0' }).code, REFUSAL_NO_UPDATE);
  assert.equal(resolveInstallTarget({ hasUpdate: null }).code, REFUSAL_NO_UPDATE);
  assert.equal(resolveInstallTarget({ hasUpdate: true, latest: 'not-a-version' }).code, REFUSAL_NO_UPDATE);
  assert.equal(resolveInstallTarget(null).code, REFUSAL_NO_UPDATE);
  // A release whose tag is not its version still resolves, using the tag verbatim.
  assert.ok(resolveInstallTarget({ hasUpdate: true, latest: '0.2.0', latestTag: 'v0.2.0' }).url.includes('/download/v0.2.0/'));
});

test('install: A1 — a link:/path install is refused, a missing dependency is allowed', () => {
  for (const spec of ['link:/Users/x/dsh-prompt-setting/packages/dsh-prompt-setting', 'file:../pkg', '/abs/path', './rel', '../up']) {
    assert.equal(isLocalSpec(spec), true, `${spec} is a local spec`);
  }
  for (const spec of ['0.1.1', '^0.1.1', 'https://example.test/a.tgz', 'github:o/r']) {
    assert.equal(isLocalSpec(spec), false, `${spec} is not a local spec`);
  }
  const linked = resolveInstallPolicy({ service: {}, profileDir, field: 'link:../x', tag: '0.2.0' });
  assert.equal(linked.ok, false);
  assert.equal(linked.code, REFUSAL_DEVELOPMENT_LINK);
  assert.match(linked.message, /local path|working copy/);
  assert.ok(linked.manual.releaseUrl.includes('/releases/tag/0.2.0'), 'the refusal points at the release page');

  // The profile not naming the package is an *install*, not a refusal: that is
  // what "restore a real install" means.
  assert.equal(resolveInstallPolicy({ service: {}, profileDir, field: null, tag: '0.2.0' }).ok, true);
  // A registry spec is upgradeable.
  assert.equal(resolveInstallPolicy({ service: {}, profileDir, field: '0.1.1', tag: '0.2.0' }).ok, true);
  // A profile manifest that could not be read is **not** "this package is not
  // declared": the install form was never established, so it fails closed.
  const unreadable = resolveInstallPolicy({ service: {}, profileDir, field: null, fieldError: 'Unexpected token }', tag: '0.2.0' });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.code, REFUSAL_SERVICE_MISSING);
  assert.match(unreadable.message, /could not be read/);
  assert.match(unreadable.message, /nothing was installed/);
  // A missing manifest (`ENOENT`) is reported as "no error" and stays allowed.
  assert.equal(resolveInstallPolicy({ service: {}, profileDir, field: null, fieldError: null, tag: '0.2.0' }).ok, true);

  // No service, and no profile directory, are both refusals with their own code.
  assert.equal(resolveInstallPolicy({ service: null, profileDir, field: null, tag: '0.2.0' }).code, REFUSAL_SERVICE_MISSING);
  assert.equal(resolveInstallPolicy({ service: {}, profileDir: null, field: null, tag: '0.2.0' }).code, REFUSAL_SERVICE_MISSING);
  assert.equal(describeInstalledSpec('  ').field, null);
  assert.equal(describeInstalledSpec(42).field, null);
  assert.equal(releasePageForTag('nope'), null);
});

test('install: failures are classified into the categories the goal names', () => {
  // A release published without an asset: the expected outcome.
  assert.equal(classifyInstallFailure({ status: 404 }), REFUSAL_ASSET_MISSING);
  assert.equal(classifyInstallFailure({ diagnostic: 'ERR_PNPM_FETCH_404  GET https://…' }), REFUSAL_ASSET_MISSING);
  // The build-script gate, by pnpm's own code and by its wording.
  assert.equal(classifyInstallFailure({ kind: 'build-blocked' }), 'build-blocked');
  assert.equal(classifyInstallFailure({ diagnostic: 'ERR_PNPM_IGNORED_BUILDS' }), 'build-blocked');
  // pnpm itself is missing, and the run timed out.
  assert.equal(classifyInstallFailure({ kind: 'pnpm-missing' }), 'pnpm-missing');
  assert.equal(classifyInstallFailure({ kind: 'timeout' }), 'timeout');
  // A dead network, named either by pnpm's kind or by an errno in the log.
  assert.equal(classifyInstallFailure({ kind: 'network' }), 'network');
  assert.equal(classifyInstallFailure({ diagnostic: 'Error: getaddrinfo ENOTFOUND github.com' }), 'network');
  // A probe that could not answer is not a 404: nothing was verified.
  assert.equal(classifyInstallFailure({ status: 403, probe: true }), REFUSAL_ASSET_UNVERIFIED);
  assert.equal(classifyInstallFailure({ status: 0, probe: true }), 'network');
  // Anything else keeps pnpm's own name, or the honest "unknown".
  assert.equal(classifyInstallFailure({ kind: 'not-found' }), 'not-found');
  assert.equal(classifyInstallFailure({ kind: 'no-matching-version' }), 'no-matching-version');
  assert.equal(classifyInstallFailure({}), INSTALL_FAILURE_UNKNOWN);
  assert.equal(classifyInstallFailure({ diagnostic: 'something new' }), INSTALL_FAILURE_UNKNOWN);

  // Every category has a sentence and a manual route; none of them is empty.
  for (const kind of [REFUSAL_ASSET_MISSING, 'build-blocked', 'network', 'pnpm-missing', 'timeout', INSTALL_FAILURE_UNKNOWN]) {
    const described = describeInstallFailure(kind, { tag: '0.2.0', version: '0.2.0' });
    assert.equal(described.code, kind);
    assert.ok(described.message.length > 20, `${kind} has a readable sentence`);
    assert.ok(described.manual.releaseUrl.includes('/releases/tag/0.2.0'));
  }
  // asset-missing is the one category whose wording used to explain *why* an
  // asset was absent ("releases published before this feature existed"). That
  // history is gone — the published releases carry assets — so the sentence may
  // not blame the past or promise a future release. It must name the actionable
  // route instead, in both languages, and stay retryable.
  const missing = describeInstallFailure(REFUSAL_ASSET_MISSING, { tag: 'v0.2.0', version: '0.2.0' });
  assert.equal(missing.retryable, true, 'a missing asset stays retryable');
  assert.match(missing.message, /dsh-prompt-setting-<version>\.tgz/);
  assert.match(missing.message, /release page/i, 'the sentence names the actionable route');
  assert.match(missing.message, /try again later/i, 'and the retry route');
  assert.match(missing.message, /[\u4e00-\u9fff]/, 'the sentence carries its Chinese half');
  assert.doesNotMatch(
    missing.message,
    /before this feature existed|carry no assets/i,
    'no stale history: the assets are published',
  );
  assert.match(missing.manual.releaseLink, /v0\.2\.0/, 'the manual route still names the tag');
  // A diagnostic is one short line, never a log.
  const long = `${'x'.repeat(500)}\nsecond line`;
  const summarized = summarizeDiagnostic(long);
  assert.ok(summarized.length <= 240);
  assert.equal(summarizeDiagnostic('\n\n'), null);
  assert.equal(summarizeDiagnostic(undefined), null);
});

test('install: the request table is bounded, evicts settled rows and never a live one', () => {
  let clock = 0;
  const table = createInstallTable({
    limit: 3,
    retention: 1,
    now: () => (clock += 1000),
    ids: sequenceIds(),
  });
  const first = table.begin({ tag: '0.2.0', version: '0.2.0', url: ASSET_URL });
  assert.equal(first.phase, 'installing');
  assert.equal(table.active().requestId, 'req-1');
  table.settle('req-1', { application: 'restart-required' });
  assert.equal(table.active(), null, 'a settled request is not active');
  assert.equal(table.read('req-1').phase, 'done');

  // Fill past the cap with settled rows: only the newest `retention` survive.
  for (let index = 0; index < 6; index += 1) {
    const row = table.begin({ tag: '0.3.0', version: '0.3.0', url: ASSET_URL });
    table.settle(row.requestId, { application: 'failed' });
  }
  assert.ok(table.size() <= 3, `the table stays bounded (${table.size()})`);
  assert.equal(table.read('req-1').known, false, 'the oldest settled row was evicted');
  assert.equal(table.read('req-1').phase, 'unknown', 'an evicted row is "unknown", not "failed"');

  // A live row outlives the cap: the page must be able to keep polling it.
  const live = table.begin({ tag: '0.4.0', version: '0.4.0', url: ASSET_URL });
  for (let index = 0; index < 6; index += 1) {
    const row = table.begin({ tag: '0.5.0', version: '0.5.0', url: ASSET_URL });
    table.settle(row.requestId, { application: 'applied' });
  }
  assert.equal(table.read(live.requestId).phase, 'installing', 'a running install is never evicted');

  // `unknown` is a distinct answer from "never issued", and the public shape is
  // total: every field is present on every answer.
  const unknown = publicInstallStatus(table.read('never'));
  assert.equal(unknown.known, false);
  assert.equal(unknown.status, 'unknown');
  for (const key of ['phase', 'status', 'application', 'version', 'tag', 'startedAt', 'finishedAt', 'cancellable', 'restartRequired', 'installed', 'error']) {
    assert.ok(key in unknown, `the public status carries ${key}`);
  }
  assert.equal(publicInstallStatus(table.read(live.requestId)).status, 'running');
  assert.equal(publicInstallStatus(table.read(live.requestId)).cancellable, true);
  assert.equal(table.size() <= INSTALL_REQUEST_LIMIT + 1, true);
});

test('install: a cancel is visible, and a success that beat it is not reported as cancelled', () => {
  const table = createInstallTable({ ids: sequenceIds() });
  table.begin({ tag: '0.2.0', version: '0.2.0', url: ASSET_URL });
  assert.equal(table.markCancelling('req-1'), true);
  assert.equal(table.read('req-1').phase, 'cancelling');
  assert.equal(table.markCancelling('nope'), false, 'an unknown id cannot be cancelled');

  // The manager's own verdict is what settles the row.
  table.settle('req-1', { application: 'cancelled' });
  assert.equal(table.read('req-1').phase, 'cancelled');
  const cancelled = publicInstallStatus(table.read('req-1'));
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancellable, false);
  assert.equal(cancelled.installed, false);
  assert.equal(cancelled.error.code, 'cancelled');

  // A cancel that arrived after the code was already applied must not claim the
  // install did not happen.
  const raced = createInstallTable({ ids: sequenceIds() });
  raced.begin({ tag: '0.2.0', version: '0.2.0', url: ASSET_URL });
  raced.markCancelling('req-1');
  raced.settle('req-1', { application: 'restart-required' });
  const done = publicInstallStatus(raced.read('req-1'));
  assert.equal(done.status, 'done');
  assert.equal(done.installed, true);
  assert.equal(done.restartRequired, true);
});

test('install: a failed ChangeResult keeps the manager code as well as the readable one', () => {
  const table = createInstallTable({ ids: sequenceIds() });
  table.begin({ tag: '0.2.0', version: '0.2.0', url: ASSET_URL });
  table.settle('req-1', {
    application: 'failed',
    error: { code: 'operation-error', diagnostic: 'ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: dsh-prompt-setting' },
  });
  const row = table.read('req-1');
  assert.equal(row.phase, 'failed');
  assert.equal(row.error.code, 'build-blocked');
  assert.equal(row.error.management, 'operation-error');
  assert.match(row.error.diagnostic, /IGNORED_BUILDS/);
  assert.equal(row.error.retryable, false);
});

// #endregion

// #region the mounted routes

test('install route: a missing pluginManager is a structured refusal, not a broken plugin', async () => {
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport();
  const { route } = mountHost({ manager: null, transport });
  const started = await startInstall(route);
  assert.equal(started.ok, false);
  assert.equal(started.code, REFUSAL_SERVICE_MISSING);
  assert.ok(started.message.length > 0);
  assert.equal(transport.calls.filter((entry) => entry.method === 'HEAD').length, 0, 'nothing was probed');

  // The plugin is otherwise untouched: the three existing services and every
  // other route still work, and the same mount answers the update check.
  const check = await call(route, { url: UPDATE_CHECK_PATH });
  assert.equal(check.statusCode, 200);
  assert.equal(json(check).ok, true);
  const ping = await call(route, { url: '/prompt-setting/ping' });
  assert.equal(ping.statusCode, 200);
  assert.equal(json(ping).ok, true);
});

test('install route: the tarball spec is installed, and approvedBuilds is never passed', async () => {
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport();
  const manager = makeManager();
  const { route } = mountHost({ manager, transport });

  const started = await startInstall(route);
  assert.equal(started.ok, true);
  assert.equal(typeof started.status.requestId, 'string');
  assert.equal(started.status.status, 'running');

  await settle();
  assert.equal(manager.calls.length, 1);
  const install = manager.calls[0];
  assert.equal(install.spec, ASSET_URL, 'the spec is the release tarball asset');
  assert.equal(install.options.enabled, true, 'the conservative value for an already-installed bundle');
  assert.equal(install.options.requestId, started.status.requestId);
  assert.equal('approvedBuilds' in install.options, false, 'allowBuilds is never written');
  assert.deepEqual(Object.keys(install.options).sort(), ['enabled', 'requestId']);

  const status = await readStatus(route, started.status.requestId);
  assert.equal(status.status.phase, 'done');
  assert.equal(status.status.application, 'restart-required');
  assert.equal(status.status.restartRequired, true, 'the page is told to restart by hand');
  assert.equal(status.status.installed, true);
  assert.equal(status.status.error, null);

  // Exactly two outbound requests: the update check and the asset probe. No
  // second check, and no pnpm-side fetch at all (there is no pnpm here).
  assert.deepEqual(
    transport.calls.map((entry) => entry.method).sort(),
    ['GET', 'HEAD'],
  );
});

test('install route: tag/version come from the same check, and a mismatched tag is refused', async () => {
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport({ release: { tag_name: 'v0.2.0', html_url: null } });
  const manager = makeManager();
  const { route } = mountHost({ manager, transport });

  const mismatched = await startInstall(route, { tag: '0.9.9' });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, REFUSAL_INVALID_REQUEST);
  assert.equal(manager.calls.length, 0, 'a mismatched tag installs nothing');

  // The matching tag is accepted, and the installed URL is the tag the check saw.
  const matching = await startInstall(route, { tag: 'v0.2.0' });
  assert.equal(matching.ok, true);
  await settle();
  assert.equal(manager.calls[0].spec, 'https://github.com/zangxx66/dsh-prompt-setting/releases/download/v0.2.0/dsh-prompt-setting-0.2.0.tgz');

  // g-030's payload now carries the tag, from the same answer as the version.
  const check = json(await call(route, { url: UPDATE_CHECK_PATH }));
  assert.equal(check.latest, '0.2.0');
  assert.equal(check.latestTag, 'v0.2.0');
  assert.equal(check.hasUpdate, true);
});

test('install route: no update to install is a 200 refusal that starts nothing', async () => {
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport({ release: { tag_name: '0.1.1', html_url: null } });
  const manager = makeManager();
  const { route } = mountHost({ manager, transport });
  const refused = await startInstall(route);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, REFUSAL_NO_UPDATE);
  assert.equal(manager.calls.length, 0);
});

test('install route: a link: profile is refused with a manual route, and nothing is installed', async () => {
  writeProfile({ 'dsh-prompt-setting': 'link:../dsh-prompt-setting/packages/dsh-prompt-setting' });
  const transport = makeTransport();
  const manager = makeManager();
  const { route } = mountHost({ manager, transport });

  const refused = await startInstall(route);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, REFUSAL_DEVELOPMENT_LINK);
  assert.match(refused.manual.current, /^link:/);
  assert.ok(refused.manual.releaseUrl.includes('/releases/tag/0.2.0'));
  assert.equal(manager.calls.length, 0, 'a development link is never overwritten');
  assert.equal(transport.calls.filter((entry) => entry.method === 'HEAD').length, 0);
});

test('install: the same spec is recognized as "already installed", a different one is not', () => {
  assert.equal(isAlreadyInstalledOn(ASSET_URL, ASSET_URL), true);
  assert.equal(isAlreadyInstalledOn(`  ${ASSET_URL}  `, ASSET_URL), true, 'surrounding whitespace is trimmed');
  assert.equal(isAlreadyInstalledOn(ASSET_URL, `${ASSET_URL}?x=1`), false, 'the comparison is literal');
  assert.equal(isAlreadyInstalledOn('0.1.1', ASSET_URL), false, 'a semver install is a different install');
  assert.equal(
    isAlreadyInstalledOn('https://github.com/zangxx66/dsh-prompt-setting/releases/download/0.1.0/dsh-prompt-setting-0.1.0.tgz', ASSET_URL),
    false,
    'an older tarball URL is a different install',
  );
  assert.equal(isAlreadyInstalledOn('link:../x', ASSET_URL), false);
  assert.equal(isAlreadyInstalledOn(null, ASSET_URL), false, 'an unreadable/missing manifest is not "already installed"');
  assert.equal(isAlreadyInstalledOn(ASSET_URL, null), false);
  assert.equal(isAlreadyInstalledOn('', ''), false);
});

test('install route: a profile already holding the target asset answers success, not ambiguous-install', async () => {
  // The real desktop defect: the profile's dependency **was** the very URL this
  // install would fetch, so `pnpm add` changed nothing and the official manager
  // threw `ambiguous-install` (`lib/index.js:1782`) — which used to surface as
  // 「安装失败：… could not be classified」. It is a no-op, not a failure.
  writeProfile({ 'dsh-prompt-setting': ASSET_URL });
  const transport = makeTransport();
  const manager = makeManager();
  const { route } = mountHost({ manager, transport });

  const started = await startInstall(route);
  assert.equal(started.ok, true);
  assert.equal(started.alreadyInstalled, true);
  await settle();
  assert.equal(manager.calls.length, 0, 'a no-op install never reaches the package manager');
  assert.equal(transport.calls.filter((entry) => entry.method === 'HEAD').length, 0, 'and it is not probed either');

  const status = await readStatus(route, started.status.requestId);
  assert.equal(status.status.phase, 'done', 'a success, never a failure');
  assert.equal(status.status.application, 'restart-required');
  assert.equal(status.status.restartRequired, true, 'the only step left is the manual restart');
  assert.equal(status.status.installed, true);
  assert.equal(status.status.error, null, 'no error at all');
});

test('install route: a profile holding an older asset still installs the new one', async () => {
  writeProfile({
    'dsh-prompt-setting': 'https://github.com/zangxx66/dsh-prompt-setting/releases/download/0.1.0/dsh-prompt-setting-0.1.0.tgz',
  });
  const transport = makeTransport();
  const manager = makeManager();
  const { route } = mountHost({ manager, transport });
  const started = await startInstall(route);
  assert.equal(started.ok, true);
  assert.equal(started.alreadyInstalled, undefined, 'a different spec is a real install');
  await settle();
  assert.equal(manager.calls.length, 1, 'the new version is installed');
  assert.equal(manager.calls[0].spec, ASSET_URL);
  assert.equal((await readStatus(route, started.status.requestId)).status.phase, 'done');
});

test('install route: an official management failure is named, never "could not be classified"', async () => {
  // `ManagementError.code` is the most specific thing the manager reports, and
  // it used to be ignored entirely (only pnpm's `kind` was consulted), so every
  // official refusal rendered as an unactionable sentence that also claimed a
  // rollback. Every code now has its own sentence.
  for (const code of MANAGEMENT_FAILURE_CODES) {
    writeProfile({ 'dsh-prompt-setting': '0.1.1' });
    const transport = makeTransport();
    const manager = makeManager({
      result: { changed: false, application: 'failed', stage: 'install', target: ASSET_URL, error: { code } },
    });
    const { route } = mountHost({ manager, transport });
    const started = await startInstall(route);
    await settle();
    const status = await readStatus(route, started.status.requestId);
    assert.equal(status.status.phase, 'failed');
    assert.equal(status.status.error.management, code, `${code} is carried through`);
    // The **mapped** code, not just the raw one: dropping a code from the table
    // must change what the page is told, and this is what makes that visible.
    // `operation-error` is the wrapper and has no reason of its own.
    assert.equal(
      status.status.error.code,
      code === MANAGEMENT_OPERATION_ERROR ? INSTALL_FAILURE_UNKNOWN : code,
      `${code} maps to its own code`,
    );
    assert.doesNotMatch(status.status.error.message, /could not be classified/, `${code} has a real sentence`);
    assert.ok(status.status.error.message.length > 30, `${code} says something actionable`);
    // Only a failure that really changed the profile may talk about a rollback;
    // every other sentence must stay silent about it.
    if (code !== MANAGEMENT_OPERATION_ERROR) {
      assert.doesNotMatch(status.status.error.message, /restored/i, `${code} must not claim a rollback`);
    }
    assert.ok(status.status.error.manual.releaseUrl.includes('/releases/tag/0.2.0'), `${code} keeps the manual route`);
  }
});

test('install route: an operation error is unwrapped into pnpm\u2019s own reason', async () => {
  // `operation-error` is a wrapper, not a reason: the real one is in the log.
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport();
  const manager = makeManager({
    result: {
      changed: true,
      application: 'failed',
      stage: 'install',
      target: ASSET_URL,
      packageResult: { exitCode: 1, kind: 'build-blocked', output: 'ERR_PNPM_IGNORED_BUILDS  Ignored build scripts' },
      error: { code: 'operation-error', diagnostic: 'ERR_PNPM_IGNORED_BUILDS  Ignored build scripts' },
    },
  });
  const { route } = mountHost({ manager, transport });
  const started = await startInstall(route);
  await settle();
  const status = await readStatus(route, started.status.requestId);
  assert.equal(status.status.error.code, 'build-blocked', 'pnpm\u2019s reason wins over the wrapper');
  assert.equal(status.status.error.management, 'operation-error');
});

test('install route: pnpm\u2019s reason is used when the manager only wraps it', async () => {
  // The previous case's mirror image, for a code that is *not* the wrapper: the
  // manager names the case, so its name wins over anything the log might hint at
  // (a `stale-approval` diagnostic mentioning `prepare` must not read as
  // `build-blocked`).
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport();
  const manager = makeManager({
    result: {
      changed: false,
      application: 'failed',
      stage: 'install',
      target: ASSET_URL,
      error: { code: 'stale-approval', diagnostic: 'ERR_PNPM_... prepare was blocked; allowBuilds is stale' },
    },
  });
  const { route } = mountHost({ manager, transport });
  const started = await startInstall(route);
  await settle();
  const status = await readStatus(route, started.status.requestId);
  assert.equal(status.status.error.code, 'stale-approval');
});

test('install route: an unreadable profile manifest refuses instead of installing blind', async () => {
  // The manifest exists but is not JSON: `installDependencyField` reports
  // `{value: null, error}`, and taking only `value` would read as "this profile
  // does not declare the package" — i.e. A1 would be skipped on a profile that
  // could not be inspected at all.
  writeFileSync(join(profileDir, 'package.json'), '{ "dependencies": { "dsh-prompt-setting": "0.1.1" ', 'utf8');
  const transport = makeTransport();
  const manager = makeManager();
  const { route } = mountHost({ manager, transport });

  const refused = await startInstall(route);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, REFUSAL_SERVICE_MISSING);
  assert.match(refused.message, /could not be read/);
  assert.equal(manager.calls.length, 0, 'nothing is installed when the profile cannot be inspected');
  assert.equal(transport.calls.filter((entry) => entry.method === 'HEAD').length, 0);
});

test('install route: a profile that simply lacks the dependency is still allowed to install it', async () => {
  // The other side of the same branch: **no** manifest at all is a real,
  // readable answer ("this profile does not declare the package"), which is what
  // restoring a real install means.
  rmSync(join(profileDir, 'package.json'), { force: true });
  const transport = makeTransport();
  const manager = makeManager();
  const { route } = mountHost({ manager, transport });
  const started = await startInstall(route);
  assert.equal(started.ok, true);
  await settle();
  assert.equal(manager.calls.length, 1, 'a missing manifest is not an unreadable one');
  assert.equal((await readStatus(route, started.status.requestId)).status.phase, 'done');
});

test('install route: a release with no asset fails as asset-missing, without calling pnpm', async () => {
  // A release published without an asset: the expected outcome, so it must be a
  // named branch with a real sentence.
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport({ assetStatus: 404 });
  const manager = makeManager();
  const { route } = mountHost({ manager, transport });

  const started = await startInstall(route);
  assert.equal(started.ok, true);
  await settle();
  const status = await readStatus(route, started.status.requestId);
  assert.equal(status.status.phase, 'failed');
  assert.equal(status.status.error.code, REFUSAL_ASSET_MISSING);
  assert.match(status.status.error.message, /no .*asset/);
  assert.equal(status.status.error.retryable, true);
  assert.match(status.status.error.diagnostic, /404/);
  assert.equal(manager.calls.length, 0, 'a 404 asset never reaches pnpm, so the answer is seconds not minutes');
});

test('install route: a probe that cannot answer is not a refusal — the install goes to pnpm', async () => {
  // The probe is a shortcut, never a gate. `500` (and `429`, and `405`, and a
  // throw) mean "I could not find out", which must not block an install: the
  // old behaviour refused with an unclassified failure whose sentence claimed
  // the profile files had been restored when nothing had run at all.
  for (const assetStatus of [500, 429, 405]) {
    writeProfile({ 'dsh-prompt-setting': '0.1.1' });
    const transport = makeTransport({ assetStatus });
    const manager = makeManager();
    const { route } = mountHost({ manager, transport });
    const started = await startInstall(route);
    assert.equal(started.ok, true, `${assetStatus}: the install is started`);
    await settle();
    assert.equal(manager.calls.length, 1, `${assetStatus}: pnpm is asked`);
    assert.equal(manager.calls[0].spec, ASSET_URL);
    const status = await readStatus(route, started.status.requestId);
    assert.equal(status.status.phase, 'done', `${assetStatus}: the verdict comes from the manager`);
    assert.equal(status.status.application, 'restart-required');
    assert.equal(status.status.error, null, `${assetStatus}: nothing was refused`);
  }
  // A probe that throws (the transport itself fails) is the same "no answer".
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const throwing = makeTransport({ assetStatus: 200, throwOnProbe: true });
  const manager = makeManager();
  const { route } = mountHost({ manager, transport: throwing });
  const started = await startInstall(route);
  await settle();
  assert.equal(manager.calls.length, 1, 'a throwing probe still installs');
  assert.equal((await readStatus(route, started.status.requestId)).status.phase, 'done');
});

test('install route: an unverifiable asset is reported as unverified, not as missing', async () => {
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport({ assetStatus: 403 });
  const manager = makeManager();
  const { route } = mountHost({ manager, transport });
  const started = await startInstall(route);
  await settle();
  const status = await readStatus(route, started.status.requestId);
  assert.equal(status.status.error.code, REFUSAL_ASSET_UNVERIFIED);
  assert.equal(manager.calls.length, 0);
});

test('install route: 410 (gone) is the same "the asset is not there" as 404', async () => {
  // The refusal set is `404`/`410` — both mean the release carries no such
  // asset. `410` is not decoration: a release whose asset was deleted answers it,
  // and treating only `404` as "definitely absent" would send that case to pnpm
  // for a two-minute failure with a worse sentence.
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport({ assetStatus: 410 });
  const manager = makeManager();
  const { route } = mountHost({ manager, transport });
  const started = await startInstall(route);
  assert.equal(started.ok, true);
  await settle();
  const status = await readStatus(route, started.status.requestId);
  assert.equal(status.status.phase, 'failed');
  assert.equal(status.status.error.code, REFUSAL_ASSET_MISSING);
  assert.match(status.status.error.diagnostic, /410/);
  assert.equal(manager.calls.length, 0, 'a 410 asset never reaches pnpm either');
});

test('install route: 401 (not fetchable anonymously) is unverified, not missing', async () => {
  // The other half of the refusal set: `401`/`403` say "you may not read this",
  // which is a different sentence from "it is not there" — and must not be
  // confused with "I could not find out", which would install anyway.
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport({ assetStatus: 401 });
  const manager = makeManager();
  const { route } = mountHost({ manager, transport });
  const started = await startInstall(route);
  await settle();
  const status = await readStatus(route, started.status.requestId);
  assert.equal(status.status.phase, 'failed');
  assert.equal(status.status.error.code, REFUSAL_ASSET_UNVERIFIED);
  assert.match(status.status.error.diagnostic, /401/);
  assert.equal(manager.calls.length, 0, 'an unverifiable asset is not installed over');
});

test('install route: a failing install is settled from the manager result, never thrown', async () => {
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport();
  const manager = makeManager({
    result: {
      changed: false,
      application: 'failed',
      stage: 'install',
      target: ASSET_URL,
      error: { code: 'operation-error', diagnostic: 'ERR_PNPM_FETCH_404  GET https://github.com/…' },
    },
  });
  const { route } = mountHost({ manager, transport });
  const started = await startInstall(route);
  await settle();
  const status = await readStatus(route, started.status.requestId);
  assert.equal(status.status.phase, 'failed');
  assert.equal(status.status.error.code, REFUSAL_ASSET_MISSING);
  assert.equal(status.status.error.management, 'operation-error');
});

test('install route: a manager that throws still settles the row and answers 200', async () => {
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport();
  const manager = makeManager({ throwOnCall: true });
  const { route } = mountHost({ manager, transport });
  const started = await startInstall(route);
  assert.equal(started.ok, true);
  await settle();
  const status = await readStatus(route, started.status.requestId);
  assert.equal(status.status.phase, 'failed');
  assert.equal(status.status.error.code, INSTALL_FAILURE_UNKNOWN);
  assert.match(status.status.error.message, /could not be started/);
});

test('install route: only one install runs at a time, and the second POST reuses it', async () => {
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport();
  const calls = [];
  const manager = {
    service: {
      profile: { dir: profileDir },
      installBundle(spec, options) {
        calls.push({ spec, options });
        return new Promise(() => {}, 'never settles'); // deliberately in flight
      },
      async cancelInstall() {
        return { status: 'cancelled' };
      },
    },
  };
  const { route } = mountHost({ manager, transport });
  const first = await startInstall(route);
  const second = await startInstall(route);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.reused, true, 'the second start reuses the running request');
  assert.equal(second.status.requestId, first.status.requestId);
  assert.equal(calls.length, 1, 'one pnpm add, not two queueing on the profile lock');
  assert.equal(calls[0].options.enabled, true);
});

test('install route: cancel marks the intent, forwards it, and never blocks on the settle', async () => {
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport();
  const cancellations = [];
  const manager = {
    service: {
      profile: { dir: profileDir },
      installBundle() {
        return new Promise(() => {});
      },
      async cancelInstall(requestId) {
        cancellations.push(requestId);
        return { status: 'cancelled' };
      },
    },
  };
  const { route } = mountHost({ manager, transport });
  const started = await startInstall(route);

  const cancelled = await call(route, {
    method: 'POST',
    url: UPDATE_APPLY_CANCEL_PATH,
    body: JSON.stringify({ requestId: started.status.requestId }),
  });
  assert.equal(cancelled.statusCode, 200);
  const body = json(cancelled);
  assert.equal(body.ok, true);
  assert.equal(body.code, 'cancelling');
  assert.equal(body.status.phase, 'cancelling');
  assert.equal(body.status.cancelRequested, true);
  await settle();
  assert.deepEqual(cancellations, [started.status.requestId]);

  // A cancel with no live request is a 200 `not-running`: nothing was stopped,
  // and that is a fact about the request rather than a server error.
  const again = json(await call(route, {
    method: 'POST',
    url: UPDATE_APPLY_CANCEL_PATH,
    body: JSON.stringify({ requestId: 'never-issued' }),
  }));
  assert.equal(again.ok, false);
  assert.equal(again.code, 'not-running');
  assert.equal(again.status.status, 'unknown');
});

test('install route: shape mistakes are 400, and no shape mistake is ever a 5xx', async () => {
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport();
  const { route } = mountHost({ transport });

  // No id at all is the fresh-page question ("is anything installing?"), not a
  // shape mistake: it answers 200 with `status:null` when nothing is running.
  const idle = await call(route, { url: UPDATE_APPLY_PATH });
  assert.equal(idle.statusCode, 200);
  assert.deepEqual(json(idle), { ok: true, status: null });

  const empty = await call(route, { url: `${UPDATE_APPLY_PATH}?requestId=` });
  assert.equal(empty.statusCode, 400);
  assert.equal(json(empty).code, 'invalid-request');

  const tooLong = await call(route, { url: `${UPDATE_APPLY_PATH}?requestId=${'x'.repeat(200)}` });
  assert.equal(tooLong.statusCode, 400);

  const cancelNoBody = await call(route, { method: 'POST', url: UPDATE_APPLY_CANCEL_PATH, body: '{}' });
  assert.equal(cancelNoBody.statusCode, 400);
  assert.equal(json(cancelNoBody).code, 'invalid-request');

  const method = await call(route, { method: 'DELETE', url: UPDATE_APPLY_PATH });
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.allow, 'GET, POST');

  const cancelMethod = await call(route, { method: 'GET', url: UPDATE_APPLY_CANCEL_PATH });
  assert.equal(cancelMethod.statusCode, 405);
  assert.equal(cancelMethod.headers.allow, 'POST');

  // Unknown id, and an install that never existed, are still 200s.
  const unknown = await readStatus(route, 'never-issued');
  assert.equal(unknown.status.known, false);
  assert.equal(unknown.status.status, 'unknown');
});

test('install route: the trust fence runs before anything else on all three routes', async () => {
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport();
  const manager = makeManager();
  const { route } = mountHost({ manager, transport, rejection: () => 403 });

  for (const callOptions of [
    { method: 'POST', url: UPDATE_APPLY_PATH, body: '{}' },
    { url: `${UPDATE_APPLY_PATH}?requestId=req-1` },
    { method: 'POST', url: UPDATE_APPLY_CANCEL_PATH, body: JSON.stringify({ requestId: 'req-1' }) },
  ]) {
    const res = await call(route, callOptions);
    assert.equal(res.statusCode, 403, `${callOptions.url} is fenced`);
  }
  assert.equal(manager.calls.length, 0);
  assert.equal(transport.calls.length, 0, 'a rejected request never reaches GitHub');
});

test('install route: an unreachable release check refuses to start anything', async () => {
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport({ release: 'network' });
  const manager = makeManager();
  const { route } = mountHost({ manager, transport });
  const refused = await startInstall(route);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, REFUSAL_NO_UPDATE);
  assert.equal(manager.calls.length, 0);
});

// #endregion

test('install route: a fresh page can find the install it can no longer name', async () => {
  writeProfile({ 'dsh-prompt-setting': '0.1.1' });
  const transport = makeTransport();
  const manager = {
    service: {
      profile: { dir: profileDir },
      installBundle() {
        return new Promise(() => {});
      },
      async cancelInstall() {
        return { status: 'cancelled' };
      },
    },
  };
  const { route } = mountHost({ manager, transport });
  assert.deepEqual(json(await call(route, { url: UPDATE_APPLY_PATH })), { ok: true, status: null });

  const started = await startInstall(route);
  // The reloaded tab has no id in memory: the bare `GET` names the live request.
  const found = json(await call(route, { url: UPDATE_APPLY_PATH }));
  assert.equal(found.ok, true);
  assert.equal(found.status.requestId, started.status.requestId);
  assert.equal(found.status.status, 'running');
});

// #endregion

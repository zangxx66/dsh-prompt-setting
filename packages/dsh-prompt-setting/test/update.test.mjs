/**
 * Host-half assertions for g-030 / g-042: the upstream update check.
 *
 * Two layers, both offline:
 *   - `core/update.js` is exercised directly — slug parsing, the npm registry
 *     document, semver comparison, caching, `force`, the GitHub fallback and
 *     every degradation (404, a malformed tag, a network error, a timeout). The
 *     transport is a stub that tells the two upstreams apart by URL, so no test
 *     here can reach npm or GitHub even if the machine is online;
 *   - the real route is mounted against a minimal fake Host with a stub
 *     transport injected through the plugin config, so the response shape and
 *     the on/off switch are asserted on the code that actually ships.
 *
 * g-042's rule under test: **npm is the primary path**, GitHub Releases is asked
 * only when npm could not answer, and every answer names which of the two
 * produced it (`source`).
 *
 * Run: `node --test test/`
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { apply } from '../index.js';
import {
  DEFAULT_NPM_REGISTRY,
  UPDATE_CHECK_TTL_MS,
  UPDATE_SOURCE_GITHUB,
  UPDATE_SOURCE_NPM,
  compareSemver,
  createUpdateChecker,
  formatSemver,
  isNewerVersion,
  normalizePreferences,
  normalizeRegistry,
  parseRepositorySlug,
  parseSemver,
  registryPackageUrl,
  releasePageUrl,
  releasesLatestUrl,
} from '../core/update.js';
import { readPreferences, userPreferencesPath, writePreferences } from '../core/store.js';

const UPDATE_CHECK_PATH = '/prompt-setting/update-check';
const PING_PATH = '/prompt-setting/ping';
/** The document the npm path asks, and the release API the fallback asks. */
const REGISTRY_URL = 'https://registry.npmjs.org/dsh-prompt-setting';
const GITHUB_URL = 'https://api.github.com/repos/zangxx66/dsh-prompt-setting/releases/latest';
/** The registry document's own install spec. */
const TARBALL_URL = 'https://registry.npmjs.org/dsh-prompt-setting/-/dsh-prompt-setting-0.2.0.tgz';

let home;
let previousHome;

// The preference file lives under `$DSH_HOME`; every case gets a throwaway one,
// so a test run can never read or write the real `~/.dsh`.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-prompt-setting-update-'));
  previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
});

/**
 * A stub transport that answers **both** upstreams from a table and counts its
 * calls.
 *
 * The recorded calls are the evidence for two things: which upstream was asked
 * (npm first, GitHub only as the fallback) and the two privacy-shaped criteria —
 * one `GET` per upstream, with an identifiable user-agent, and *zero* calls once
 * the switch is off.
 * @param handler - `(url, init) => response|Promise<response>`; the default
 *   answers the canonical npm document for a registry URL and the canonical
 *   release body for GitHub.
 * @returns `{fetch, calls}`.
 */
function makeTransport(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, init: init || {} });
    if (typeof handler === 'function') return handler(target, init || {});
    return target.startsWith('https://registry.npmjs.org/') ? npmResponse() : releaseResponse();
  };
  return { fetch, calls };
}

/**
 * A `Response`-shaped double carrying a JSON body.
 * @param body - the JSON value.
 * @param status - the HTTP status (default 200).
 * @returns the double.
 */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** The canonical "a newer release exists" answer. */
function releaseResponse(over = {}) {
  return jsonResponse({
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/zangxx66/dsh-prompt-setting/releases/tag/v0.2.0',
    published_at: '2026-10-01T00:00:00Z',
    draft: false,
    prerelease: false,
    ...over,
  });
}

/** The canonical "a newer version is published" npm package document. */
function npmResponse(over = {}) {
  return jsonResponse({
    name: 'dsh-prompt-setting',
    'dist-tags': { latest: '0.2.0' },
    dist: { tarball: TARBALL_URL },
    time: { '0.2.0': '2026-09-25T00:00:00.000Z' },
    ...over,
  });
}

/**
 * One checker over a stub transport, with the test's own version and repo.
 * @param options - `handler`, `preferences`, `currentVersion`, `ttlMs`,
 *   `timeoutMs`, `now`, `repositoryUrl`, `registry`.
 * @returns the checker plus the transport and the preference writes.
 */
function makeChecker(options = {}) {
  const transport = makeTransport(options.handler);
  const writes = [];
  let preferences = options.preferences ?? { updateCheck: true };
  const checker = createUpdateChecker({
    fetch: transport.fetch,
    repositoryUrl: options.repositoryUrl === undefined ? 'git+https://github.com/zangxx66/dsh-prompt-setting.git' : options.repositoryUrl,
    currentVersion: options.currentVersion === undefined ? '0.1.1' : options.currentVersion,
    registry: options.registry,
    ttlMs: options.ttlMs,
    timeoutMs: options.timeoutMs,
    now: options.now,
    readPreferences: () => preferences,
    writePreferences: (next) => {
      writes.push(next);
      preferences = next;
    },
  });
  return { checker, transport, writes };
}

// #region pure policy: the repository address

test('update: every real manifest spelling resolves to the same owner/repo pair', () => {
  const expected = { owner: 'zangxx66', repo: 'dsh-prompt-setting' };
  for (const spelling of [
    'git+https://github.com/zangxx66/dsh-prompt-setting.git',
    'https://github.com/zangxx66/dsh-prompt-setting',
    'https://github.com/zangxx66/dsh-prompt-setting.git/',
    'git://github.com/zangxx66/dsh-prompt-setting.git',
    'git+ssh://git@github.com/zangxx66/dsh-prompt-setting.git',
    'ssh://git@github.com/zangxx66/dsh-prompt-setting.git',
    'git@github.com:zangxx66/dsh-prompt-setting.git',
    'github:zangxx66/dsh-prompt-setting',
    'https://github.com/zangxx66/dsh-prompt-setting#readme',
  ]) {
    assert.deepEqual(parseRepositorySlug(spelling), expected, spelling);
  }
});

test('update: a spelling that does not name a GitHub repository is refused, never guessed', () => {
  for (const value of [
    undefined,
    null,
    42,
    '',
    '   ',
    'https://gitlab.com/zangxx66/dsh-prompt-setting',
    'https://github.com/zangxx66',
    'https://github.com/a/b/c',
    'not a url at all',
  ]) {
    assert.equal(parseRepositorySlug(value), null, JSON.stringify(value));
  }
});

test('update: the one request URL is derived from the parsed slug', () => {
  assert.equal(
    releasesLatestUrl(parseRepositorySlug('git+https://github.com/o/r.git')),
    'https://api.github.com/repos/o/r/releases/latest',
  );
  assert.equal(releasePageUrl({ owner: 'o', repo: 'r' }, 'v1.2.3'), 'https://github.com/o/r/releases/tag/v1.2.3');
});

// #region pure policy: the injected npm registry (g-042)

test('update: the npm document URL is built from the injected registry base', () => {
  assert.equal(DEFAULT_NPM_REGISTRY, 'https://registry.npmjs.org/');
  assert.equal(registryPackageUrl(), REGISTRY_URL, 'the shipped default needs no argument');
  assert.equal(registryPackageUrl(DEFAULT_NPM_REGISTRY), REGISTRY_URL);
  // A mirror under a path keeps that path, and a missing trailing slash is added
  // rather than silently dropped (which would ask the mirror's root instead).
  assert.equal(registryPackageUrl('https://mirror.example/npm/'), 'https://mirror.example/npm/dsh-prompt-setting');
  assert.equal(registryPackageUrl('https://mirror.example/npm'), 'https://mirror.example/npm/dsh-prompt-setting');
  assert.equal(registryPackageUrl('  https://mirror.example/npm/  '), 'https://mirror.example/npm/dsh-prompt-setting');
  assert.equal(normalizeRegistry('https://registry.npmjs.org/?a=1#b'), 'https://registry.npmjs.org/', 'query and fragment are decoration');
  // Blank means "unstated" ⇒ the shipped default; anything else unusable means
  // "do not ask npm", never "ask npmjs.org instead".
  for (const value of [undefined, null, '', '   ', 42, {}]) {
    assert.equal(normalizeRegistry(value), DEFAULT_NPM_REGISTRY, JSON.stringify(value));
  }
  for (const value of ['registry.example', 'ftp://mirror.example/', 'file:///tmp/registry', 'not a url']) {
    assert.equal(normalizeRegistry(value), null, value);
    assert.equal(registryPackageUrl(value), null, value);
  }
});

// #region pure policy: version comparison

test('update: the `v` prefix and a prerelease suffix are tolerated', () => {
  assert.deepEqual(parseSemver('v0.1.2'), { major: 0, minor: 1, patch: 2 });
  assert.deepEqual(parseSemver('0.1.2'), { major: 0, minor: 1, patch: 2 });
  assert.deepEqual(parseSemver(' 1.10.0 '), { major: 1, minor: 10, patch: 0 });
  assert.deepEqual(parseSemver('1.10.0-rc.1'), { major: 1, minor: 10, patch: 0 });
  assert.equal(formatSemver(parseSemver('v1.10.0')), '1.10.0');
});

test('update: a tag that is not a version is refused — the never-false-positive rule', () => {
  for (const value of [undefined, null, '', 'latest', '1.2', '1.2.3.4', 'v', 'v1.x.0', 'release-1.2.3']) {
    assert.equal(parseSemver(value), null, JSON.stringify(value));
  }
});

test('update: comparison is numeric, not lexicographic', () => {
  assert.equal(compareSemver(parseSemver('0.10.0'), parseSemver('0.9.9')), 1);
  assert.equal(compareSemver(parseSemver('1.0.0'), parseSemver('1.0.0')), 0);
  assert.equal(compareSemver(parseSemver('0.1.1'), parseSemver('0.1.2')), -1);
  assert.equal(isNewerVersion('v0.1.2', '0.1.1'), true);
  assert.equal(isNewerVersion('0.1.1', '0.1.1'), false);
  assert.equal(isNewerVersion('0.1.0', '0.1.1'), false);
  // Undecidable, not "false": the caller must render nothing at all.
  assert.equal(isNewerVersion('latest', '0.1.1'), null);
  assert.equal(isNewerVersion('0.2.0', 'not-a-version'), null);
});

// #region pure policy: the preference document

test('update: only an explicit boolean false closes the switch', () => {
  assert.deepEqual(normalizePreferences({ updateCheck: false }), { updateCheck: false });
  assert.deepEqual(normalizePreferences({ updateCheck: true }), { updateCheck: true });
  for (const value of [null, undefined, {}, { updateCheck: 'false' }, { updateCheck: 0 }, [], 'nonsense']) {
    assert.deepEqual(normalizePreferences(value), { updateCheck: true }, JSON.stringify(value));
  }
});

// #region the checker: npm first, GitHub only as the fallback

test('update: npm is the primary path — dist-tags.latest is the newest version', async () => {
  const { checker, transport } = makeChecker();
  const result = await checker.check();
  assert.equal(result.ok, true);
  assert.equal(result.source, UPDATE_SOURCE_NPM);
  assert.equal(result.hasUpdate, true);
  assert.equal(result.latest, '0.2.0');
  assert.equal(result.current, '0.1.1');
  assert.equal(result.latestTag, '0.2.0');
  assert.equal(result.tarball, TARBALL_URL, 'the registry document names the install spec');
  assert.equal(result.publishedAt, '2026-09-25T00:00:00.000Z');
  assert.equal(result.releaseUrl, null, 'the npm answer has no release page to link');
  assert.equal(result.cached, false);
  assert.equal(result.error, null);
  assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(transport.calls.length, 1, 'GitHub is not asked when npm answers');
  assert.equal(transport.calls[0].url, REGISTRY_URL);
  assert.equal(transport.calls[0].init.method, 'GET');
  assert.match(String(transport.calls[0].init.headers['user-agent']), /^dsh-prompt-setting\//);
  assert.equal(transport.calls[0].init.body, undefined, 'the request carries no body and no user data');
});

test('update: the same version, and an older one, are both "no update" — and are not a fallback trigger', async () => {
  for (const latest of ['0.1.1', '0.1.0', '0.0.9']) {
    const { checker, transport } = makeChecker({
      handler: (url) => (url === REGISTRY_URL ? npmResponse({ 'dist-tags': { latest } }) : releaseResponse()),
    });
    const result = await checker.check();
    assert.equal(result.hasUpdate, false, latest);
    assert.equal(result.ok, true, latest);
    assert.equal(result.source, UPDATE_SOURCE_NPM, latest);
    assert.equal(transport.calls.length, 1, `${latest}: an answer we do not like is still an answer`);
  }
});

test('update: the npm request is built from the injected registry base', async () => {
  const { checker, transport } = makeChecker({
    registry: 'https://mirror.example/npm/',
    handler: (url) => (url.endsWith('/dsh-prompt-setting') ? npmResponse() : releaseResponse()),
  });
  const result = await checker.check();
  assert.equal(result.source, UPDATE_SOURCE_NPM);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].url, 'https://mirror.example/npm/dsh-prompt-setting');
});

test('update: an unusable registry disables the npm path instead of asking npmjs.org', async () => {
  const { checker, transport } = makeChecker({ registry: 'file:///tmp/registry', handler: () => releaseResponse() });
  const result = await checker.check();
  assert.equal(result.ok, true);
  assert.equal(result.source, UPDATE_SOURCE_GITHUB);
  assert.equal(result.hasUpdate, true);
  assert.equal(transport.calls.length, 1, 'the npm path is skipped, not redirected to the default registry');
  assert.equal(transport.calls[0].url, GITHUB_URL);
});

test('update: a release without html_url falls back to the tag page', async () => {
  const { checker } = makeChecker({
    registry: 'registry.example',
    handler: () => releaseResponse({ html_url: null }),
  });
  const result = await checker.check();
  assert.equal(result.source, UPDATE_SOURCE_GITHUB);
  assert.equal(result.releaseUrl, 'https://github.com/zangxx66/dsh-prompt-setting/releases/tag/v0.2.0');
});

test('update: an npm failure falls back to GitHub Releases, marked source=github', async () => {
  const { checker, transport } = makeChecker({
    handler: (url) => (url === REGISTRY_URL ? jsonResponse({ message: 'unavailable' }, 503) : releaseResponse()),
  });
  const result = await checker.check();
  assert.equal(result.ok, true);
  assert.equal(result.source, UPDATE_SOURCE_GITHUB);
  assert.equal(result.hasUpdate, true);
  assert.equal(result.latest, '0.2.0');
  assert.equal(result.latestTag, 'v0.2.0', 'the release tag travels verbatim for the asset URL');
  assert.equal(result.tarball, null, 'a GitHub answer carries no registry tarball');
  assert.equal(
    result.releaseUrl,
    'https://github.com/zangxx66/dsh-prompt-setting/releases/tag/v0.2.0',
  );
  assert.deepEqual(transport.calls.map((call) => call.url), [REGISTRY_URL, GITHUB_URL], 'npm first, GitHub second');
});

test('update: every way npm can fail to answer sends the check to the fallback', async () => {
  const unusable = [
    ['a 503 from the registry', () => jsonResponse({ message: 'unavailable' }, 503)],
    ['a 404 — this registry does not carry the package', () => jsonResponse({ message: 'Not Found' }, 404)],
    ['a network error', () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    }],
    ['a body that is not JSON', () => ({ ok: true, status: 200, text: async () => 'not json' })],
    ['a body that is not a package document', () => jsonResponse(['nope'])],
    ['a document without dist-tags', () => jsonResponse({ name: 'dsh-prompt-setting' })],
    ['dist-tags without latest', () => jsonResponse({ 'dist-tags': { beta: '1.0.0' } })],
    ['a dist-tag that is not a version', () => npmResponse({ 'dist-tags': { latest: 'nightly' } })],
  ];
  for (const [reason, npmAnswer] of unusable) {
    const { checker, transport } = makeChecker({
      handler: (url) => (url === REGISTRY_URL ? npmAnswer() : releaseResponse()),
    });
    const result = await checker.check();
    assert.equal(result.ok, true, reason);
    assert.equal(result.source, UPDATE_SOURCE_GITHUB, reason);
    assert.equal(result.hasUpdate, true, reason);
    assert.equal(result.latest, '0.2.0', reason);
    assert.deepEqual(transport.calls.map((call) => call.url), [REGISTRY_URL, GITHUB_URL], reason);
  }
});

test('update: both upstreams failing is one structured failure, never a throw', async () => {
  const { checker, transport } = makeChecker({
    handler: () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
  });
  const result = await checker.check();
  assert.equal(result.ok, false, 'still a 200 payload, never an exception');
  assert.equal(result.hasUpdate, null);
  assert.equal(result.source, UPDATE_SOURCE_GITHUB, 'the last attempt produced this payload');
  assert.equal(result.error.code, 'network-error');
  assert.match(result.error.message, /ENOTFOUND/);
  assert.equal(result.error.npm.code, 'network-error', 'the primary path says why it was skipped');
  // A failure is never cached: the next check asks both paths again.
  await checker.check();
  assert.equal(transport.calls.length, 4);
});

test('update: a package with no usable repository URL refuses without asking anyone', async () => {
  // The npm path is disabled by the profile's own (unusable) registry, so the
  // GitHub precondition is the only thing left to check — and it fails before a
  // request, exactly as it did before g-042.
  const { checker, transport } = makeChecker({ registry: 'registry.example', repositoryUrl: 'https://gitlab.com/o/r' });
  const result = await checker.check();
  assert.equal(result.ok, false);
  assert.equal(result.source, UPDATE_SOURCE_GITHUB);
  assert.equal(result.error.code, 'no-repository');
  assert.equal('npm' in result.error, false, 'the npm path was never attempted, so it has no reason to report');
  assert.equal(transport.calls.length, 0);
});

// #region the checker: the cache

test('update: a repeat inside the TTL is served from cache, and force bypasses it', async () => {
  let clock = 1_000_000;
  const { checker, transport } = makeChecker({ now: () => clock });
  const first = await checker.check();
  assert.equal(first.cached, false);
  clock += UPDATE_CHECK_TTL_MS - 1;
  const second = await checker.check();
  assert.equal(second.cached, true, 'a repeat inside six hours must not ask again');
  assert.equal(second.hasUpdate, true);
  assert.equal(transport.calls.length, 1);
  const forced = await checker.check({ force: true });
  assert.equal(forced.cached, false);
  assert.equal(transport.calls.length, 2, 'force=1 performs a real request');
  // And the TTL really expires: a full lifetime after the forced check asks again.
  clock += UPDATE_CHECK_TTL_MS;
  const third = await checker.check();
  assert.equal(third.cached, false);
  assert.equal(transport.calls.length, 3);
});

test('update: a cached fallback answer is not re-opened by the npm path', async () => {
  let clock = 1_000_000;
  const { checker, transport } = makeChecker({
    now: () => clock,
    handler: (url) => (url === REGISTRY_URL ? jsonResponse({ message: 'unavailable' }, 503) : releaseResponse()),
  });
  const first = await checker.check();
  assert.equal(first.source, UPDATE_SOURCE_GITHUB);
  assert.equal(transport.calls.length, 2, 'the fallback cost exactly two requests');
  clock += UPDATE_CHECK_TTL_MS - 1;
  const second = await checker.check();
  assert.equal(second.cached, true, 'the TTL covers a GitHub-sourced answer too');
  assert.equal(second.source, UPDATE_SOURCE_GITHUB, 'the cached answer keeps the source it was produced from');
  assert.equal(transport.calls.length, 2, 'nothing is re-asked inside the TTL');
});

test('update: a clock that steps backwards does not make a cache eternal', async () => {
  let clock = 1_000_000;
  const { checker, transport } = makeChecker({ now: () => clock });
  assert.equal((await checker.check()).cached, false);
  // The review's case: `now` is injectable, so a backwards step (an NTP
  // correction, a hand-set clock, a fake clock) must not read as "fresh".
  // Without the `age >= 0` guard this second call answers `cached: true`.
  clock = 0;
  const second = await checker.check();
  assert.equal(second.cached, false, 'a negative cache age is not freshness');
  assert.equal(second.ok, true, 'the answer is still served — just re-fetched');
  assert.equal(transport.calls.length, 2, 'the stale-looking entry costs one request, not an eternity of them');
});

test('update: an undecidable GitHub answer is cached too, so a 404 is not re-asked', async () => {
  const { checker, transport } = makeChecker({ handler: () => jsonResponse({ message: 'Not Found' }, 404) });
  const first = await checker.check();
  assert.equal(first.ok, true, 'no release is a fact about upstream, not a failure of the check');
  assert.equal(first.hasUpdate, null);
  assert.equal(first.error.code, 'no-release');
  assert.equal(first.source, UPDATE_SOURCE_GITHUB);
  assert.equal(transport.calls.length, 2, 'npm answered 404 (unusable), then GitHub answered 404 (a fact)');
  const second = await checker.check();
  assert.equal(second.cached, true);
  assert.equal(transport.calls.length, 2);
});

// #region the checker: every degradation

test('update: a repository with no release answers hasUpdate:null, never an update', async () => {
  const { checker } = makeChecker({ handler: () => jsonResponse({ message: 'Not Found' }, 404) });
  const result = await checker.check();
  assert.equal(result.ok, true, 'no release is a fact about upstream, not a failure of the check');
  assert.equal(result.hasUpdate, null);
  assert.equal(result.latest, null);
});

test('update: a GitHub tag that is not a version answers hasUpdate:null instead of guessing', async () => {
  const { checker } = makeChecker({ registry: 'registry.example', handler: () => releaseResponse({ tag_name: 'nightly' }) });
  const result = await checker.check();
  assert.equal(result.hasUpdate, null);
  assert.equal(result.latest, null);
  assert.equal(result.error.code, 'unparsable-tag');
  assert.equal(result.source, UPDATE_SOURCE_GITHUB);
});

test('update: a release object with no tag_name answers hasUpdate:null', async () => {
  const { checker } = makeChecker({
    registry: 'registry.example',
    handler: () => jsonResponse({ html_url: 'https://github.com/o/r/releases' }),
  });
  const result = await checker.check();
  assert.equal(result.hasUpdate, null);
  assert.equal(result.error.code, 'invalid-response');
  assert.equal(result.source, UPDATE_SOURCE_GITHUB);
});

test('update: an HTTP error is reported with its status, and is not cached', async () => {
  const { checker, transport } = makeChecker({ handler: () => jsonResponse({ message: 'rate limited' }, 403) });
  const result = await checker.check();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'http-error');
  assert.equal(result.error.status, 403);
  assert.equal(result.error.npm.status, 403);
  await checker.check();
  assert.equal(transport.calls.length, 4, 'a failure is never cached, on either path');
});

test('update: a body that is neither a package document nor a release object is refused', async () => {
  const { checker } = makeChecker({ handler: () => ({ ok: true, status: 200, text: async () => 'not json' }) });
  const result = await checker.check();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid-response');
});

test('update: a text-only transport double is read as well as a real json() one', async () => {
  const { checker } = makeChecker({
    handler: (url) => (url === REGISTRY_URL
      ? { ok: true, status: 200, text: async () => JSON.stringify({ 'dist-tags': { latest: '9.9.9' }, dist: { tarball: TARBALL_URL } }) }
      : jsonResponse({ tag_name: 'v9.9.9' })),
  });
  const result = await checker.check();
  assert.equal(result.source, UPDATE_SOURCE_NPM);
  assert.equal(result.latest, '9.9.9');
  assert.equal(result.hasUpdate, true);
});

test('update: a hanging request times out on each path instead of wedging the page', async () => {
  const { checker, transport } = makeChecker({ handler: () => new Promise(() => {}), timeoutMs: 25 });
  const started = Date.now();
  const result = await checker.check();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'timeout');
  assert.equal(result.error.npm.code, 'timeout', 'the primary path timed out first, then the fallback');
  assert.equal(transport.calls.length, 2, 'each path gets its own timeout, and neither is retried');
  assert.ok(Date.now() - started < 5000, 'the timeout is the injected one, not the shipped five seconds');
});

test('update: a runtime without fetch refuses instead of throwing', async () => {
  const original = globalThis.fetch;
  try {
    // Removed *before* the checker is built: the default transport is resolved
    // once, from the runtime that exists at construction time.
    globalThis.fetch = undefined;
    const checker = createUpdateChecker({
      fetch: undefined,
      repositoryUrl: 'https://github.com/o/r',
      currentVersion: '1.0.0',
      readPreferences: () => ({ updateCheck: true }),
    });
    const result = await checker.check();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'fetch-unavailable');
    assert.equal(result.source, null, 'no upstream was consulted at all');
  } finally {
    globalThis.fetch = original;
  }
});

// #region the switch

test('update: a closed switch answers without asking anyone', async () => {
  const { checker, transport } = makeChecker({ preferences: { updateCheck: false } });
  const result = await checker.check();
  assert.equal(result.enabled, false);
  assert.equal(result.hasUpdate, false);
  assert.equal(result.ok, true);
  assert.equal(transport.calls.length, 0, 'zero outbound requests while the switch is off');
  const forced = await checker.check({ force: true });
  assert.equal(forced.enabled, false);
  assert.equal(transport.calls.length, 0, 'force=1 bypasses the cache, never the switch');
});

test('update: setEnabled persists the switch and a failed write is a value', async () => {
  const { checker, writes } = makeChecker();
  assert.deepEqual(checker.setEnabled(false), { written: true, enabled: false, error: null });
  assert.deepEqual(writes, [{ updateCheck: false }]);
  assert.equal(checker.preferences().updateCheck, false);
  assert.deepEqual(checker.setEnabled(true), { written: true, enabled: true, error: null });

  const failing = createUpdateChecker({
    fetch: async () => releaseResponse(),
    repositoryUrl: 'https://github.com/o/r',
    currentVersion: '1.0.0',
    readPreferences: () => ({ updateCheck: true }),
    writePreferences: () => {
      throw new Error('EACCES: permission denied');
    },
  });
  const refused = failing.setEnabled(false);
  assert.equal(refused.written, false);
  assert.equal(refused.error.code, 'preferences-unwritable');
  assert.match(refused.error.message, /EACCES/);
});

// #region the preference file

test('update: preferences default to on, a malformed file is reported and still means on', () => {
  const path = userPreferencesPath();
  assert.equal(path, join(home, 'prompt-setting', 'preferences.json'));
  const missing = readPreferences(path);
  assert.deepEqual(missing.preferences, { updateCheck: true });
  assert.equal(missing.missing, true);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"updateCheck": false}\n', 'utf8');
  assert.deepEqual(readPreferences(path).preferences, { updateCheck: false });

  writeFileSync(path, '{ not json', 'utf8');
  const broken = readPreferences(path);
  assert.equal(broken.preferences.updateCheck, true, 'a broken file must not read as a closed switch');
  assert.equal(broken.error.code, 'invalid-json');

  writeFileSync(path, '{"updateCheck": "off"}\n', 'utf8');
  assert.equal(readPreferences(path).preferences.updateCheck, true, 'only a boolean false closes it');
});

test('update: writePreferences is atomic and normalizes what it writes', () => {
  const path = userPreferencesPath();
  assert.deepEqual(writePreferences(path, { updateCheck: false }), { updateCheck: false });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).updateCheck, false);
  assert.deepEqual(writePreferences(path, { updateCheck: 'yes' }), { updateCheck: true });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).updateCheck, true);
});

// #region the mounted route

/** Minimal Node response double: records status, headers and body. */
function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    end(chunk) {
      this.body = chunk === undefined || chunk === null ? '' : String(chunk);
      this.ended = true;
    },
  };
}

/** Minimal Node request double: the handler reads these fields and the body stream. */
function makeRequest({ method = 'GET', url = UPDATE_CHECK_PATH, headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  return {
    method,
    url,
    headers,
    destroy() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/**
 * Mount the plugin against a minimal fake Host, with a stub transport injected
 * through the plugin config — the same channel a profile would use.
 * @param options.config - the plugin config (`updateCheck: {fetch, …}`).
 * @param options.requestRejection - what the trust fence answers.
 * @param options.omitConnection - mount with no connection service at all.
 * @returns the captured prefix route.
 */
function mountHost(options = {}) {
  const routes = [];
  const listeners = [];
  const ctx = {
    connection:
      options.omitConnection === true
        ? undefined
        : { requestRejection: options.requestRejection ?? (() => undefined) },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    systemPrompt: {
      sections: [],
      async assemble() {
        return { sections: [], contexts: [], tools: [], variables: {} };
      },
      section(definition) {
        this.sections.push(definition);
        return () => {};
      },
    },
    get() {
      return undefined;
    },
    on(name, callback, listenerOptions) {
      listeners.push({ name, callback, options: listenerOptions });
      return () => {};
    },
    effect(factory) {
      return factory();
    },
  };
  apply(ctx, options.config);
  return { route: routes[0], routes, listeners };
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

test('update route: GET answers the documented shape with a stub transport', async () => {
  const transport = makeTransport();
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const res = await call(route, { url: UPDATE_CHECK_PATH });
  assert.equal(res.statusCode, 200);
  const body = json(res);
  for (const key of [
    'ok',
    'current',
    'latest',
    'latestTag',
    'hasUpdate',
    'releaseUrl',
    'publishedAt',
    'source',
    'tarball',
    'checkedAt',
    'cached',
    'error',
  ]) {
    assert.ok(key in body, `the response carries ${key}`);
  }
  assert.equal(body.ok, true);
  assert.equal(body.hasUpdate, true);
  assert.equal(body.source, UPDATE_SOURCE_NPM, 'the npm answer names itself');
  assert.equal(body.tarball, TARBALL_URL);
  assert.equal(body.enabled, true, 'the same answer reports the switch');
  assert.equal(body.cached, false);
  assert.equal(transport.calls.length, 1);
});

test('update route: the registry is injected through the plugin config (g-042)', async () => {
  const transport = makeTransport((url) => (url.endsWith('/dsh-prompt-setting') ? npmResponse() : releaseResponse()));
  const { route } = mountHost({
    config: { updateCheck: { fetch: transport.fetch, registry: 'https://mirror.example/npm/' } },
  });
  const res = await call(route, { url: UPDATE_CHECK_PATH });
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).source, UPDATE_SOURCE_NPM);
  assert.equal(transport.calls[0].url, 'https://mirror.example/npm/dsh-prompt-setting');
});

test('update route: an npm failure falls back to GitHub, and is still a 200', async () => {
  const transport = makeTransport((url) => (url === REGISTRY_URL
    ? jsonResponse({ message: 'unavailable' }, 503)
    : releaseResponse()));
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const res = await call(route, { url: UPDATE_CHECK_PATH });
  assert.equal(res.statusCode, 200, 'the fallback is not an error page either');
  const body = json(res);
  assert.equal(body.source, UPDATE_SOURCE_GITHUB);
  assert.equal(body.hasUpdate, true);
  assert.equal(body.latest, '0.2.0');
  assert.deepEqual(transport.calls.map((entry) => entry.url), [REGISTRY_URL, GITHUB_URL]);
});

test('update route: a failing check is a 200 with a structured error, never a 5xx', async () => {
  const transport = makeTransport(() => {
    throw new Error('ECONNREFUSED');
  });
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const res = await call(route, { url: UPDATE_CHECK_PATH });
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'network-error');
  assert.equal(body.error.npm.code, 'network-error');
});

test('update route: force=1 is the only way to re-ask inside the cache window', async () => {
  const transport = makeTransport();
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  assert.equal(json(await call(route, { url: UPDATE_CHECK_PATH })).cached, false);
  assert.equal(json(await call(route, { url: UPDATE_CHECK_PATH })).cached, true);
  assert.equal(transport.calls.length, 1);
  assert.equal(json(await call(route, { url: `${UPDATE_CHECK_PATH}?force=1` })).cached, false);
  assert.equal(transport.calls.length, 2);
});

test('update route: the switch is persisted, and a closed switch makes the route silent', async () => {
  const transport = makeTransport();
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const put = await call(route, {
    method: 'PUT',
    url: UPDATE_CHECK_PATH,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(json(put).saved, { enabled: false });
  assert.equal(JSON.parse(readFileSync(userPreferencesPath(), 'utf8')).updateCheck, false);

  const before = transport.calls.length;
  const off = await call(route, { url: UPDATE_CHECK_PATH });
  assert.equal(json(off).enabled, false);
  assert.equal(json(off).hasUpdate, false);
  assert.equal(transport.calls.length, before, 'zero outbound requests while the switch is off');

  // A second mount (what the next page load sees) reads the same file and is
  // silent too: the switch survives the request, not just the process.
  const second = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const afterRemount = transport.calls.length;
  assert.equal(json(await call(second.route, { url: UPDATE_CHECK_PATH })).enabled, false);
  assert.equal(transport.calls.length, afterRemount);
});

test('update route: turning the switch back on makes the next check ask again', async () => {
  writePreferences(userPreferencesPath(), { updateCheck: false });
  const transport = makeTransport();
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  assert.equal(json(await call(route, { url: UPDATE_CHECK_PATH })).enabled, false);
  const on = await call(route, {
    method: 'PUT',
    url: UPDATE_CHECK_PATH,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(json(on).enabled, true);
  await call(route, { url: UPDATE_CHECK_PATH });
  assert.equal(transport.calls.length, 1);
});

test('update route: a non-boolean enabled is the ordinary 400, and nothing is written', async () => {
  const transport = makeTransport();
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const res = await call(route, {
    method: 'PUT',
    url: UPDATE_CHECK_PATH,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: 'yes' }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).code, 'invalid-enabled');
  assert.equal(readPreferences(userPreferencesPath()).missing, true);
});

test('update route: the method table is honoured and the trust fence still runs first', async () => {
  const transport = makeTransport();
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const post = await call(route, { method: 'POST', url: UPDATE_CHECK_PATH });
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.allow, 'GET, PUT');

  const fenced = mountHost({
    config: { updateCheck: { fetch: transport.fetch } },
    requestRejection: () => 403,
  });
  const rejected = await call(fenced.route, { url: UPDATE_CHECK_PATH });
  assert.equal(rejected.statusCode, 403);
  assert.equal(transport.calls.length, 0, 'a rejected request never reaches the check');

  const unfenced = mountHost({ config: { updateCheck: { fetch: transport.fetch } }, omitConnection: true });
  const unavailable = await call(unfenced.route, { url: UPDATE_CHECK_PATH });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(json(unavailable).code, 'trust-fence-unavailable');
});

test('update route: an unknown path is still a 404, and ping is untouched', async () => {
  const transport = makeTransport();
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const missing = await call(route, { url: '/prompt-setting/nope' });
  assert.equal(missing.statusCode, 404);
  const ping = await call(route, { url: PING_PATH });
  assert.equal(ping.statusCode, 200);
  const body = json(ping);
  assert.equal(body.ok, true);
  assert.equal(body.version, '0.1.5');
  assert.equal('hasUpdate' in body, false, 'the ping response shape is unchanged');
});

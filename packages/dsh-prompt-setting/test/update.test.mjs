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
  DOWNLOAD_REGIONS,
  DOWNLOAD_REGION_AUTO_FLAG,
  DOWNLOAD_REGION_FLAG,
  DOWNLOAD_REGION_REGISTRY_FLAG,
  CN_NPM_REGISTRY,
  UPDATE_CHECK_TTL_MS,
  UPDATE_SOURCE_GITHUB,
  UPDATE_SOURCE_NPM,
  compareSemver,
  createDownloadRegion,
  createUpdateChecker,
  formatSemver,
  isNewerVersion,
  normalizePreferences,
  normalizeRegistry,
  parseRepositorySlug,
  parseSemver,
  registryPackageUrl,
  packumentLatest,
  registryTarball,
  releasePageUrl,
  releasesLatestUrl,
  resolveDownloadRegion,
  statedDownloadRegion,
  validateRegistryAddress,
} from '../core/update.js';
import { readPreferences, userPreferencesPath, writePreferences } from '../core/store.js';

const UPDATE_CHECK_PATH = '/prompt-setting/update-check';
const PING_PATH = '/prompt-setting/ping';
/** The document the npm path asks, and the release API the fallback asks. */
const REGISTRY_URL = 'https://registry.npmjs.org/dsh-prompt-setting';
const GITHUB_URL = 'https://api.github.com/repos/zangxx66/dsh-prompt-setting/releases/latest';
/** The registry document's own install spec. */
const TARBALL_URL = 'https://registry.npmjs.org/dsh-prompt-setting/-/dsh-prompt-setting-0.2.2.tgz';
/** The same for the version this test package already is (`currentVersion`). */
const OLD_TARBALL_URL = 'https://registry.npmjs.org/dsh-prompt-setting/-/dsh-prompt-setting-0.2.1.tgz';

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
    tag_name: 'v0.2.2',
    html_url: 'https://github.com/zangxx66/dsh-prompt-setting/releases/tag/v0.2.2',
    published_at: '2026-10-01T00:00:00Z',
    draft: false,
    prerelease: false,
    ...over,
  });
}

/**
 * The canonical "a newer version is published" npm package document.
 *
 * **The shape is the real one**, measured against `registry.npmjs.org` on
 * 2026-10-08: a packument has **no top-level `dist`** — each version's artifact
 * lives at `versions[<version>].dist.tarball`. The first revision of g-042 read
 * `body.dist` and answered `tarball: null` for every real check (the owner's
 * real-machine review caught it), so this fixture must not be flattened.
 * @param over - top-level fields to override.
 * @returns the double.
 */
function npmResponse(over = {}) {
  return jsonResponse({
    name: 'dsh-prompt-setting',
    'dist-tags': { latest: '0.2.2' },
    versions: {
      '0.2.2': { name: 'dsh-prompt-setting', version: '0.2.2', dist: { tarball: TARBALL_URL } },
      '0.1.5': { name: 'dsh-prompt-setting', version: '0.1.5', dist: { tarball: OLD_TARBALL_URL } },
    },
    time: { '0.2.2': '2026-09-25T00:00:00.000Z' },
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
  // `undefined` (and a blank string) means "**unstated**" ⇒ the shipped default.
  for (const value of [undefined, '', '   ']) {
    assert.equal(normalizeRegistry(value), DEFAULT_NPM_REGISTRY, JSON.stringify(value));
  }
  // Everything else unusable means "**do not ask npm**", never "ask npmjs.org
  // instead" — an explicit `null` included. Collapsing `null` into "unstated" is
  // the g-043 review's BLOCK: an unusable custom address asked npmjs.org while the
  // page said「自定义」.
  for (const value of [null, 42, {}, true, 'registry.example', 'ftp://mirror.example/', 'file:///tmp/registry', 'not a url']) {
    assert.equal(normalizeRegistry(value), null, JSON.stringify(value));
    assert.equal(registryPackageUrl(value), null, JSON.stringify(value));
  }
  assert.equal(registryPackageUrl(undefined), REGISTRY_URL, 'unstated still means the shipped default');
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
  assert.equal(isNewerVersion('0.2.2', 'not-a-version'), null);
});

// #region pure policy: the preference document

test('update: only an explicit boolean false closes the switch', () => {
  assert.deepEqual(normalizePreferences({ updateCheck: false }), { updateCheck: false });
  assert.deepEqual(normalizePreferences({ updateCheck: true }), { updateCheck: true });
  for (const value of [null, undefined, {}, { updateCheck: 'false' }, { updateCheck: 0 }, [], 'nonsense']) {
    assert.deepEqual(normalizePreferences(value), { updateCheck: true }, JSON.stringify(value));
  }
});

// #region pure policy: where a real packument keeps the tarball

test('update: the tarball comes from versions[<version>].dist — the real packument shape', () => {
  // Measured against registry.npmjs.org (2026-10-08): the document has no
  // top-level `dist` at all. This is the shape the checker must read.
  const document = {
    name: 'dsh-prompt-setting',
    'dist-tags': { latest: '0.2.2' },
    versions: { '0.2.2': { dist: { tarball: TARBALL_URL } } },
    time: { '0.2.2': '2026-09-25T00:00:00.000Z' },
  };
  assert.equal(Object.prototype.hasOwnProperty.call(document, 'dist'), false, 'the fixture itself proves the shape');
  assert.equal(registryTarball(document, '0.2.2', '0.2.2'), TARBALL_URL);
  // A `v`-prefixed dist-tag is not a version key: the canonical spelling is tried.
  assert.equal(
    registryTarball({ versions: { '1.2.3': { dist: { tarball: 'https://r.test/x.tgz' } } } }, 'v1.2.3', '1.2.3'),
    'https://r.test/x.tgz',
  );
  // A flattened, non-standard document is tolerated (courtesy, never primary).
  assert.equal(
    registryTarball({ dist: { tarball: 'https://flat.test/x.tgz' } }, '1.2.3', '1.2.3'),
    'https://flat.test/x.tgz',
  );
  // `latestTag` wins over `canonical` when both exist.
  assert.equal(
    registryTarball(
      { versions: { 'v1.2.3': { dist: { tarball: 'https://tag.test/a.tgz' } }, '1.2.3': { dist: { tarball: 'https://canon.test/b.tgz' } } } },
      'v1.2.3',
      '1.2.3',
    ),
    'https://tag.test/a.tgz',
  );
  // Nothing usable: no versions entry, no top-level dist, blank values, junk.
  for (const [body, tag, canonical] of [
    [{ 'dist-tags': { latest: '0.2.2' } }, '0.2.2', '0.2.2'],
    [{ versions: {} }, '0.2.2', '0.2.2'],
    [{ versions: { '0.2.2': {} } }, '0.2.2', '0.2.2'],
    [{ versions: { '0.2.2': { dist: {} } } }, '0.2.2', '0.2.2'],
    [{ versions: { '0.2.2': { dist: { tarball: '   ' } } } }, '0.2.2', '0.2.2'],
    [{ versions: { '0.2.2': { dist: { tarball: 42 } } } }, '0.2.2', '0.2.2'],
    [{ versions: { '0.2.2': { dist: { tarball: TARBALL_URL } } } }, '', ''],
    [null, '0.2.2', '0.2.2'],
    ['not a document', '0.2.2', '0.2.2'],
  ]) {
    assert.equal(registryTarball(body, tag, canonical), null, JSON.stringify(body));
  }
});

test('update: a real-shaped document answers with its tarball, and one that names none answers null', async () => {
  const real = await makeChecker().checker.check();
  assert.equal(real.source, UPDATE_SOURCE_NPM);
  assert.equal(real.tarball, TARBALL_URL, 'read from versions[latest].dist.tarball');

  // The version is still the version when the document names no artifact: the
  // check is **not** a failure, and the install route refuses it (§18.2).
  const bare = makeChecker({ handler: (url) => (url === REGISTRY_URL ? npmResponse({ versions: { '0.2.2': {} } }) : releaseResponse()) });
  const answer = await bare.checker.check();
  assert.equal(answer.ok, true);
  assert.equal(answer.source, UPDATE_SOURCE_NPM);
  assert.equal(answer.latest, '0.2.2');
  assert.equal(answer.hasUpdate, true);
  assert.equal(answer.tarball, null);
});

// #region the checker: npm first, GitHub only as the fallback

test('update: npm is the primary path — dist-tags.latest is the newest version', async () => {
  const { checker, transport } = makeChecker();
  const result = await checker.check();
  assert.equal(result.ok, true);
  assert.equal(result.source, UPDATE_SOURCE_NPM);
  assert.equal(result.hasUpdate, true);
  assert.equal(result.latest, '0.2.2');
  assert.equal(result.current, '0.1.1');
  assert.equal(result.latestTag, '0.2.2');
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
  assert.equal(result.releaseUrl, 'https://github.com/zangxx66/dsh-prompt-setting/releases/tag/v0.2.2');
});

test('update: an npm failure falls back to GitHub Releases, marked source=github', async () => {
  const { checker, transport } = makeChecker({
    handler: (url) => (url === REGISTRY_URL ? jsonResponse({ message: 'unavailable' }, 503) : releaseResponse()),
  });
  const result = await checker.check();
  assert.equal(result.ok, true);
  assert.equal(result.source, UPDATE_SOURCE_GITHUB);
  assert.equal(result.hasUpdate, true);
  assert.equal(result.latest, '0.2.2');
  assert.equal(result.latestTag, 'v0.2.2', 'the release tag travels verbatim for the asset URL');
  assert.equal(result.tarball, null, 'a GitHub answer carries no registry tarball');
  assert.equal(
    result.releaseUrl,
    'https://github.com/zangxx66/dsh-prompt-setting/releases/tag/v0.2.2',
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
    assert.equal(result.latest, '0.2.2', reason);
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
      ? {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            'dist-tags': { latest: '9.9.9' },
            versions: { '9.9.9': { dist: { tarball: 'https://registry.npmjs.org/dsh-prompt-setting/-/dsh-prompt-setting-9.9.9.tgz' } } },
          }),
        }
      : jsonResponse({ tag_name: 'v9.9.9' })),
  });
  const result = await checker.check();
  assert.equal(result.source, UPDATE_SOURCE_NPM);
  assert.equal(result.latest, '9.9.9');
  assert.equal(result.hasUpdate, true);
  assert.equal(result.tarball, 'https://registry.npmjs.org/dsh-prompt-setting/-/dsh-prompt-setting-9.9.9.tgz');
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
  assert.equal(body.latest, '0.2.2');
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
  assert.equal(body.version, '0.2.1');
  assert.equal('hasUpdate' in body, false, 'the ping response shape is unchanged');
});

// #region g-043: the download region — format policy

/** Every address a user could reasonably type, and what the strict check says. */
const REGISTRY_ADDRESS_CASES = [
  // accepted, and normalized to exactly one trailing slash
  ['https://mirrors.example.com/npm', 'https://mirrors.example.com/npm/'],
  ['https://mirrors.example.com/npm/', 'https://mirrors.example.com/npm/'],
  ['  https://mirrors.example.com/npm/  ', 'https://mirrors.example.com/npm/'],
  ['http://mirrors.example.com:8080', 'http://mirrors.example.com:8080/'],
  ['https://mirrors.example.com', 'https://mirrors.example.com/'],
  // refused: no scheme, the wrong scheme, no host, credentials, query, fragment
  ['mirrors.example.com/npm', null],
  ['ftp://mirrors.example.com/', null],
  ['file:///tmp/registry', null],
  ['https://user:secret@mirrors.example.com/', null],
  ['https://user@mirrors.example.com/', null],
  ['https://mirrors.example.com/npm?token=abc', null],
  ['https://mirrors.example.com/npm#frag', null],
  ['http:///npm', null],
  ['https://', null],
  ['', null],
  ['   ', null],
  [null, null],
  [42, null],
];

test('region: a typed mirror address is admitted only as an http(s) base, normalized', () => {
  for (const [input, expected] of REGISTRY_ADDRESS_CASES) {
    const checked = validateRegistryAddress(input);
    if (expected === null) {
      assert.equal(checked.ok, false, `${JSON.stringify(input)} is refused`);
      assert.equal(checked.code, 'registry-invalid');
      continue;
    }
    assert.equal(checked.ok, true, `${JSON.stringify(input)} is admitted`);
    assert.equal(checked.registry, expected);
  }
});

test('region: the mainland source is the npmmirror registry, and the three ids are fixed', () => {
  // The owner's correction (2026-10-08): the goal first named the Tsinghua TUNA
  // mirror, which — measured on a real machine — answers 404 for `express` too,
  // i.e. it serves no npm registry at all and could never be a source. The
  // constant is now the registry that actually carries this package, and it is
  // named for the **region** so a further correction cannot leave `TAU_` behind.
  assert.equal(CN_NPM_REGISTRY, 'https://registry.npmmirror.com/');
  assert.deepEqual(DOWNLOAD_REGIONS, ['default', 'cn', 'custom']);
  // The probe asks for the package document — there is no `/-/ping` anywhere in
  // this module, and the assertion that it is gone is that the exported surface
  // no longer carries it (the import above would fail to resolve).
  assert.equal(registryPackageUrl(CN_NPM_REGISTRY), 'https://registry.npmmirror.com/dsh-prompt-setting');
});

test('region: only a real package document counts as usable, whatever the status', () => {
  // The predicate the probe, the custom-address validation and the check all
  // read. A `dist-tags.latest` string is the whole shape question — there is no
  // top-level `dist` in a real packument (g-042's lesson).
  assert.equal(packumentLatest(npmResponse()), null, 'a response double is not a body');
  const body = { name: 'dsh-prompt-setting', 'dist-tags': { latest: '0.1.5' }, versions: {} };
  assert.equal(packumentLatest(body), '0.1.5');
  assert.equal(packumentLatest({ 'dist-tags': { latest: '  ' } }), null, 'blank is not a version');
  assert.equal(packumentLatest({ 'dist-tags': {} }), null);
  assert.equal(packumentLatest({ versions: {} }), null);
  assert.equal(packumentLatest({ dist: { tarball: 'https://x.test/a.tgz' } }), null, 'a flattened document is not a packument');
  for (const junk of [null, undefined, 42, 'a string', [], true]) {
    assert.equal(packumentLatest(junk), null, JSON.stringify(junk));
  }
});

test('region: the preference document states the region, and a document without one is unchanged', () => {
  // The presence-preserving rule (g-043): a pre-g-043 file normalizes exactly as
  // it did before, so the switch's own document shape does not drift.
  assert.deepEqual(normalizePreferences({ updateCheck: false }), { updateCheck: false });
  assert.deepEqual(normalizePreferences(null), { updateCheck: true });
  assert.deepEqual(statedDownloadRegion({ updateCheck: true }), {});
  // Stated keys survive, an unknown id and a junk address are dropped rather
  // than repaired (a hand-edited file reads as "this profile did not state it").
  assert.deepEqual(
    normalizePreferences({ updateCheck: true, [DOWNLOAD_REGION_FLAG]: 'cn', [DOWNLOAD_REGION_AUTO_FLAG]: true }),
    { updateCheck: true, [DOWNLOAD_REGION_FLAG]: 'cn', [DOWNLOAD_REGION_AUTO_FLAG]: true },
  );
  assert.deepEqual(statedDownloadRegion({ [DOWNLOAD_REGION_FLAG]: 'mars' }), {});
  assert.deepEqual(statedDownloadRegion({ [DOWNLOAD_REGION_REGISTRY_FLAG]: '   ' }), {});
  assert.deepEqual(statedDownloadRegion({ [DOWNLOAD_REGION_AUTO_FLAG]: 'yes' }), {});
});

test('region: the stored document resolves to the address the check will ask', () => {
  assert.deepEqual(resolveDownloadRegion(null), {
    region: 'default',
    registry: DEFAULT_NPM_REGISTRY,
    custom: null,
    customError: null,
    stored: false,
    auto: false,
  });
  // An explicit「默认」is *stated*: it must never be re-decided by a later probe.
  assert.equal(resolveDownloadRegion({ [DOWNLOAD_REGION_FLAG]: 'default' }).stored, true);
  assert.equal(resolveDownloadRegion({ [DOWNLOAD_REGION_FLAG]: 'cn' }).registry, CN_NPM_REGISTRY);
  const custom = resolveDownloadRegion({
    [DOWNLOAD_REGION_FLAG]: 'custom',
    [DOWNLOAD_REGION_REGISTRY_FLAG]: 'https://mirror.example/npm',
  });
  assert.equal(custom.registry, 'https://mirror.example/npm/', 'the saved address is normalized, not rewritten');
  const broken = resolveDownloadRegion({
    [DOWNLOAD_REGION_FLAG]: 'custom',
    [DOWNLOAD_REGION_REGISTRY_FLAG]: 'mirror.example',
  });
  assert.equal(broken.registry, null, 'an unusable custom address disables the npm path');
  assert.equal(broken.customError.code, 'registry-invalid');
});

// #region g-043: the download region — detection and validation

/**
 * One region manager over a stub transport, with a preference document in memory.
 * @param options.handler - `(url) => response`; recorded by `transport.calls`.
 * @param options.preferences - the starting document.
 * @param options.fetch - an explicit transport (overrides `handler`).
 * @param options.now - the clock.
 * @param options.probeTimeoutMs - the per-probe bound.
 * @param options.writeThrows - make the preference write fail.
 * @returns `{region, transport, writes, preferences}`.
 */
function makeRegion(options = {}) {
  const base = Object.prototype.hasOwnProperty.call(options, 'fetch')
    ? options.fetch
    : makeTransport(options.handler).fetch;
  const calls = [];
  const fetch =
    typeof base === 'function'
      ? async (url, init) => {
          calls.push(String(url));
          return base(url, init);
        }
      : undefined;
  const seen = [];
  let preferences = options.preferences ?? { updateCheck: true };
  const region = createDownloadRegion({
    fetch,
    probeTimeoutMs: options.probeTimeoutMs,
    ttlMs: options.ttlMs,
    now: options.now,
    currentVersion: '0.1.5',
    readPreferences: () => preferences,
    writePreferences: (next) => {
      if (options.writeThrows === true) throw new Error('EACCES: permission denied');
      seen.push(next);
      preferences = next;
    },
  });
  return {
    region,
    transport: { calls },
    writes: seen,
    current: () => preferences,
  };
}

/**
 * A transport for the two **package documents** the probe reads (g-043 correction).
 *
 * Each registry is configured explicitly, because the three answers are different
 * facts and the probe must tell them apart:
 *   - `true` ⇒ the real packument (`200`, `dist-tags.latest`) — **usable**;
 *   - `'missing'` ⇒ an answered `404` (an HTML/JSON error, as a host that serves
 *     no registry at all returns) — reachable but **not usable**;
 *   - `'timeout'` / `'throw'` ⇒ nobody answered.
 * The distinction between the first two is the whole defect this revision fixes.
 * @param served - `{npm, cn}` entries.
 * @returns `{fetch, calls}`.
 */
function docTransport(served) {
  const calls = [];
  const fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    const registry = target.startsWith(CN_NPM_REGISTRY) ? 'cn' : 'npm';
    const entry = served[registry];
    if (entry === 'throw') throw new Error('ECONNREFUSED');
    if (entry === 'timeout') return new Promise(() => {});
    if (entry === true) return npmResponse();
    return jsonResponse({ message: 'Not Found' }, 404);
  };
  return { fetch, calls };
}

test('region: the first visit asks npmjs for this package, and「默认」wins when it is served', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    return npmResponse();
  };
  const manager = makeRegion({ fetch });
  const answer = await manager.region.ensure();
  assert.equal(answer.region, 'default');
  assert.equal(answer.registry, DEFAULT_NPM_REGISTRY);
  assert.equal(answer.detected, true, 'a probed value is marked as automatic');
  assert.equal(answer.stored, true);
  assert.deepEqual(calls, ['https://registry.npmjs.org/dsh-prompt-setting'], 'the mirror is not asked when npmjs serves the package');
  assert.deepEqual(manager.writes, [{ updateCheck: true, [DOWNLOAD_REGION_FLAG]: 'default', [DOWNLOAD_REGION_AUTO_FLAG]: true }]);
});

test('region: the probe asks for the package document, never a liveness endpoint', async () => {
  // The correction is about *what is asked*, not only about how the answer is
  // read: a `/-/ping` says nothing about whether a host can serve this package.
  const transport = docTransport({ npm: 'missing', cn: true });
  const manager = makeRegion({ fetch: transport.fetch });
  await manager.region.ensure();
  assert.deepEqual(transport.calls, [
    'https://registry.npmjs.org/dsh-prompt-setting',
    'https://registry.npmmirror.com/dsh-prompt-setting',
  ]);
  for (const url of transport.calls) {
    assert.equal(url.includes('/-/ping'), false, 'no liveness endpoint is consulted');
  }
});

test('region: a host that answers 404 for this package is not a usable source', async () => {
  // The ping-era defect, frozen: a host that answers *something* — a 404 for the
  // document, an nginx error page — was read as the best available source. It is
  // reachable and useless, and this is exactly the Tsinghua case that was
  // measured: `/npm/express` and `/npm/dsh-prompt-setting` both 404.
  const transport = docTransport({ npm: 'missing', cn: true });
  const manager = makeRegion({ fetch: transport.fetch });
  const answer = await manager.region.ensure();
  assert.equal(answer.region, 'cn', 'an answered 404 is not availability');
  assert.equal(answer.registry, CN_NPM_REGISTRY);
});

test('region: npmjs not serving the package while npmmirror does ⇒「中国大陆」', async () => {
  const transport = docTransport({ npm: 'missing', cn: true });
  const manager = makeRegion({ fetch: transport.fetch });
  const answer = await manager.region.ensure();
  assert.equal(answer.region, 'cn');
  assert.equal(answer.detected, true);
  assert.equal(manager.current()[DOWNLOAD_REGION_FLAG], 'cn', 'the verdict is written, not just reported');
});

test('region: a proxy user is served by npmjs, so the verdict stays「默认」(never the mirror)', async () => {
  // A proxy makes npmjs usable, which is the false positive a location guess
  // would get wrong — and the reason「默认」 is the conservative answer.
  const transport = docTransport({ npm: true, cn: true });
  const manager = makeRegion({ fetch: transport.fetch });
  const first = await manager.region.ensure();
  assert.equal(first.region, 'default');
  assert.deepEqual(transport.calls, ['https://registry.npmjs.org/dsh-prompt-setting']);
});

test('region: a probe that cannot find out answers「默认」and persists NOTHING', async () => {
  // g-043 review BLOCK: a run that found no usable source used to be written as
  // `downloadRegionAuto:true`. That did two wrong things — the page claimed
  // 「已自动判定（该源能取到本包）」 about a run that fetched nothing, and the stored
  // value short-circuited every later `ensure()` (past even the in-process cache),
  // so one offline first visit froze「默认」 forever. Now it is answered and
  // forgotten: `detected:false`, `stored:false`, no write, and the next process
  // probes again.
  let probes = 0;
  const manager = makeRegion({
    fetch: async () => {
      probes += 1;
      throw new Error('getaddrinfo ENOTFOUND');
    },
  });
  const answer = await manager.region.ensure();
  assert.equal(answer.region, 'default');
  assert.equal(answer.ok, true, 'a probe that cannot answer is never an error');
  assert.equal(answer.detected, false, 'nothing may be claimed as automatically decided');
  assert.equal(answer.stored, false);
  assert.equal(answer.written, false);
  assert.equal(answer.undecided, true);
  assert.deepEqual(manager.writes, [], 'nothing was written');
  assert.deepEqual(manager.current(), { updateCheck: true });

  // The same mount may reuse its in-process verdict (that is what the cache is
  // for), but it still writes nothing and still says it has not decided…
  const again = await manager.region.ensure();
  assert.equal(again.stored, false);
  assert.equal(again.detected, false);
  assert.deepEqual(manager.writes, []);
  // …and a **fresh process** (a new manager over the same preferences) probes
  // again instead of reading a frozen decision.
  const before = probes;
  const nextProcess = makeRegion({
    fetch: async () => {
      probes += 1;
      throw new Error('getaddrinfo ENOTFOUND');
    },
    preferences: manager.current(),
  });
  await nextProcess.region.ensure();
  assert.ok(probes > before, 'the next process really probes again');
});

test('region: a probe that finds a usable source still decides and persists, once', async () => {
  const transport = docTransport({ npm: true, cn: true });
  const manager = makeRegion({ fetch: transport.fetch });
  const answer = await manager.region.ensure();
  assert.equal(answer.detected, true);
  assert.equal(answer.stored, true);
  assert.equal(answer.written, true);
  assert.deepEqual(manager.writes, [
    { updateCheck: true, [DOWNLOAD_REGION_FLAG]: 'default', [DOWNLOAD_REGION_AUTO_FLAG]: true },
  ]);
});

test('region: a probe that never answers ends at the timeout and still decides', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    // The timeout is the *only* thing that can end this request.
    return new Promise(() => {});
  };
  const manager = makeRegion({ fetch, probeTimeoutMs: 20 });
  const started = Date.now();
  const answer = await manager.region.ensure();
  assert.equal(answer.region, 'default');
  assert.equal(calls.length, 2, 'both probes were attempted, each within its own bound');
  assert.ok(Date.now() - started < 2000, 'the detection is bounded, never open-ended');
});

test('region: a missing fetch degrades to「默认」and never throws', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    const manager = makeRegion({ fetch: undefined });
    // `createDownloadRegion` with no transport at all still has to answer.
    const bare = createDownloadRegion({ readPreferences: () => ({ updateCheck: true }) });
    const answer = await bare.ensure();
    assert.equal(answer.region, 'default');
    assert.equal(answer.ok, true);
    assert.ok(manager.region !== undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('region: the verdict is cached, and concurrent asks share one probe', async () => {
  let probes = 0;
  const fetch = async () => {
    probes += 1;
    return npmResponse();
  };
  const manager = makeRegion({ fetch });
  const [first, second] = await Promise.all([manager.region.ensure(), manager.region.ensure()]);
  assert.equal(first.region, 'default');
  assert.equal(second.region, 'default');
  assert.equal(probes, 1, 'two asks, one probe');
  // …and the verdict is stored, so a later read asks nobody at all.
  const before = probes;
  const again = await manager.region.detect();
  assert.equal(again.cached, true);
  assert.equal(probes, before);
  const stored = await manager.region.ensure();
  assert.equal(stored.stored, true);
  assert.equal(probes, before, 'a stored region is never re-probed');
});

test('region: nothing is probed while the update switch is off, and nothing is written', async () => {
  const transport = docTransport({ npm: 'missing', cn: true });
  const manager = makeRegion({ fetch: transport.fetch, preferences: { updateCheck: false } });
  const answer = await manager.region.ensure();
  assert.equal(answer.region, 'default', 'the switch off means the conservative answer');
  assert.equal(answer.stored, false);
  assert.equal(answer.skipped, true);
  assert.deepEqual(transport.calls, [], 'zero outbound requests while the switch is off');
  assert.deepEqual(manager.writes, [], 'and nothing is persisted from an answer nobody detected');
});

test('region: an unwritable preference file is a value beside the verdict', async () => {
  const manager = makeRegion({ fetch: docTransport({ npm: true, cn: 'missing' }).fetch, writeThrows: true });
  const answer = await manager.region.ensure();
  assert.equal(answer.ok, true);
  assert.equal(answer.region, 'default');
  assert.equal(answer.written, false);
  assert.equal(answer.writeError.code, 'preferences-unwritable');
});

test('region: a custom address is validated against the real packument shape', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    return npmResponse();
  };
  const manager = makeRegion({ fetch });
  const saved = await manager.region.set({ region: 'custom', registry: 'https://mirror.example/npm' });
  assert.equal(saved.ok, true);
  assert.equal(saved.region, 'custom');
  assert.equal(saved.registry, 'https://mirror.example/npm/');
  assert.deepEqual(calls, ['https://mirror.example/npm/dsh-prompt-setting'], 'one GET of the package document');
  assert.equal(manager.current()[DOWNLOAD_REGION_REGISTRY_FLAG], 'https://mirror.example/npm/');
  assert.equal(manager.current()[DOWNLOAD_REGION_AUTO_FLAG], false, 'a user choice is never marked automatic');
});

test('region: the three custom failures are told apart, and none of them writes', async () => {
  const cases = [
    ['a malformed address', 'mirror.example', async () => ({ ok: true, status: 200, json: async () => ({}) }), 'registry-invalid'],
    ['nobody answered', 'https://mirror.example/', async () => { throw new Error('ECONNREFUSED'); }, 'registry-unreachable'],
    ['a 404', 'https://mirror.example/', async () => ({ ok: false, status: 404, json: async () => ({}) }), 'registry-http-error'],
    ['a 2xx that is not a packument', 'https://mirror.example/', async () => ({ ok: true, status: 200, json: async () => ({ hello: 'world' }) }), 'registry-not-npm'],
    // A packument with no `dist-tags` at all is the same fact as one with no
    // `latest`: this is not a registry this plugin can install from.
    ['a packument without dist-tags', 'https://mirror.example/', async () => ({ ok: true, status: 200, json: async () => ({ versions: {} }) }), 'registry-not-npm'],
  ];
  for (const [label, address, handler, expected] of cases) {
    const manager = makeRegion({ fetch: handler, preferences: { updateCheck: true, [DOWNLOAD_REGION_FLAG]: 'cn' } });
    const before = manager.current();
    const refused = await manager.region.set({ region: 'custom', registry: address });
    assert.equal(refused.ok, false, `${label}: refused`);
    assert.equal(refused.code, expected, `${label}: names its failure`);
    assert.deepEqual(manager.writes, [], `${label}: nothing was written`);
    assert.deepEqual(manager.current(), before, `${label}: the effective source is unchanged`);
  }
});

test('region: an unknown region id is a shape refusal, and a known one needs no network', async () => {
  const calls = [];
  const manager = makeRegion({ fetch: async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({}) }; } });
  const refused = await manager.region.set({ region: 'mars' });
  assert.equal(refused.ok, false);
  assert.equal(refused.shape, true);
  assert.equal(refused.code, 'invalid-region');
  const cn = await manager.region.set({ region: 'cn' });
  assert.equal(cn.ok, true);
  assert.equal(cn.registry, CN_NPM_REGISTRY);
  assert.equal(cn.effectiveFrom, 'immediate');
  assert.deepEqual(calls, [], 'choosing a built-in region never probes');
  assert.equal(manager.current()[DOWNLOAD_REGION_AUTO_FLAG], false);
});

test('region: no test in this file can reach a third-party geo service', async () => {
  // The one hard constraint of g-043: the decision is connectivity, not location.
  // Every URL this manager can ever ask is one of the two registries' own
  // **package documents** — asserted over the whole surface.
  const asked = [];
  const fetch = async (url) => {
    asked.push(String(url));
    return { ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '0.2.2' } }) };
  };
  const detection = makeRegion({ fetch });
  await detection.region.ensure();
  const validation = makeRegion({ fetch });
  await validation.region.set({ region: 'custom', registry: 'https://mirror.example/npm/' });
  assert.ok(asked.length > 0);
  for (const url of asked) {
    const parsed = new URL(url);
    assert.ok(
      ['registry.npmjs.org', 'registry.npmmirror.com', 'mirror.example'].includes(parsed.hostname),
      `${url} is a registry this plugin was told about, never a geolocation service`,
    );
    assert.ok(!/geo|ipinfo|ip-api|maxmind|location/i.test(url), `${url} is not an IP lookup`);
  }
});

// #region g-043: the mounted route

const DOWNLOAD_REGION_PATH = '/prompt-setting/download-region';

/** `PUT /download-region` with a JSON body. */
function putRegion(route, body) {
  return call(route, {
    method: 'PUT',
    url: DOWNLOAD_REGION_PATH,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('region route: a first visit is decided by availability and reported as automatic', async () => {
  // npmjs does not serve this package (an answered 404, the measured shape of a
  // host with no registry at all) while npmmirror does ⇒「中国大陆」, and the
  // answer says it was decided rather than chosen.
  const calls = [];
  const fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.startsWith(CN_NPM_REGISTRY)) return npmResponse();
    return jsonResponse({ message: 'Not Found' }, 404);
  };
  const { route } = mountHost({ config: { updateCheck: { fetch } } });
  const res = await call(route, { url: DOWNLOAD_REGION_PATH });
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.ok, true);
  assert.equal(body.region, 'cn');
  assert.equal(body.registry, CN_NPM_REGISTRY);
  assert.equal(body.detected, true);
  assert.equal(body.stored, true);
  assert.deepEqual(calls, [
    'https://registry.npmjs.org/dsh-prompt-setting',
    'https://registry.npmmirror.com/dsh-prompt-setting',
  ]);
  assert.equal(readPreferences(userPreferencesPath()).preferences[DOWNLOAD_REGION_FLAG], 'cn');
});

test('region route: an answered 404 from npmjs is not a reason to stay on「默认」', async () => {
  // The same decision as above, asserted as the discriminator it is: under the
  // ping-era rule ("any HTTP answer counts") this mount would have answered
  //「默认」 while its own check could not fetch anything from npmjs.
  const answered404 = mountHost({
    config: {
      updateCheck: {
        fetch: async (url) => (String(url).startsWith(CN_NPM_REGISTRY) ? npmResponse() : jsonResponse({ message: 'Not Found' }, 404)),
      },
    },
  });
  const decided = json(await call(answered404.route, { url: DOWNLOAD_REGION_PATH }));
  assert.equal(decided.region, 'cn');
  assert.equal(decided.registry, CN_NPM_REGISTRY);
});

test('region route: the choice is persisted, and the very next check asks the mirror', async () => {
  const transport = makeTransport((url) => (String(url).startsWith(CN_NPM_REGISTRY) ? npmResponse() : releaseResponse()));
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const put = await putRegion(route, { region: 'cn' });
  assert.equal(put.statusCode, 200);
  assert.equal(json(put).ok, true);
  assert.equal(json(put).effectiveFrom, 'immediate');
  assert.equal(JSON.parse(readFileSync(userPreferencesPath(), 'utf8'))[DOWNLOAD_REGION_FLAG], 'cn');

  const check = await call(route, { url: UPDATE_CHECK_PATH });
  assert.equal(json(check).source, UPDATE_SOURCE_NPM);
  assert.equal(json(check).registry, CN_NPM_REGISTRY);
  assert.equal(transport.calls[0].url, `${CN_NPM_REGISTRY}dsh-prompt-setting`, 'the check asks the mirror, not npmjs');

  // …and a second `GET` answers from the stored choice without probing anyone.
  const before = transport.calls.length;
  const read = await call(route, { url: DOWNLOAD_REGION_PATH });
  assert.equal(json(read).region, 'cn');
  assert.equal(json(read).detected, false, 'a stored choice is not reported as automatic');
  assert.equal(transport.calls.length, before);
});

test('region route: a region that is not one of the three is the ordinary 400', async () => {
  const transport = makeTransport();
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const res = await putRegion(route, { region: 'mars' });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).code, 'invalid-region');
  assert.equal(readPreferences(userPreferencesPath()).missing, true, 'nothing was written');
});

test('region route: a refused custom address is a 200 with a code, and nothing changes', async () => {
  const transport = makeTransport((url) => (String(url).startsWith(CN_NPM_REGISTRY) ? npmResponse() : releaseResponse()));
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  await putRegion(route, { region: 'cn' });
  const transportCallsBefore = transport.calls.length;

  const refused = await putRegion(route, { region: 'custom', registry: 'https://mirror.example/nope?token=1' });
  assert.equal(refused.statusCode, 200, 'the address is content under validation, not a malformed request');
  const body = json(refused);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'registry-invalid');
  assert.equal(body.effectiveFrom, 'unchanged');
  assert.equal(transport.calls.length, transportCallsBefore, 'a malformed address is never asked');
  assert.equal(
    readPreferences(userPreferencesPath()).preferences[DOWNLOAD_REGION_FLAG],
    'cn',
    'the source in force is exactly what it was',
  );
});

test('region route: a custom mirror that is not an npm registry is refused before any write', async () => {
  const transport = makeTransport((url) => {
    const target = String(url);
    if (target.endsWith('/dsh-prompt-setting') && !target.startsWith(DEFAULT_NPM_REGISTRY)) {
      return jsonResponse({ hello: 'not a registry' });
    }
    return npmResponse();
  });
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const refused = await putRegion(route, { region: 'custom', registry: 'https://mirror.example/npm' });
  assert.equal(refused.statusCode, 200);
  assert.equal(json(refused).code, 'registry-not-npm');
  assert.equal(readPreferences(userPreferencesPath()).preferences[DOWNLOAD_REGION_REGISTRY_FLAG], undefined);
});

test('region route: a working custom mirror is saved normalized, and the check uses it', async () => {
  const transport = makeTransport((url) => {
    const target = String(url);
    if (target.startsWith('https://mirror.example/npm/')) return npmResponse();
    return releaseResponse();
  });
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const saved = await putRegion(route, { region: 'custom', registry: 'https://mirror.example/npm' });
  assert.equal(json(saved).ok, true);
  assert.equal(json(saved).registry, 'https://mirror.example/npm/');
  assert.equal(JSON.parse(readFileSync(userPreferencesPath(), 'utf8'))[DOWNLOAD_REGION_REGISTRY_FLAG], 'https://mirror.example/npm/');

  await call(route, { url: UPDATE_CHECK_PATH });
  assert.equal(json(await call(route, { url: UPDATE_CHECK_PATH })).tarball, TARBALL_URL);
  assert.equal(transport.calls[0].url, 'https://mirror.example/npm/dsh-prompt-setting');
});

test('region route: an unavailable mirror is a structured error, never a silent fallback', async () => {
  // Criterion 7, the one that matters most: with「中国大陆」selected, a registry
  // that cannot answer must NOT be answered by GitHub (or by npmjs) behind the
  // user's back — the whole point of choosing a region is knowing what is asked.
  const transport = makeTransport((url) => {
    const target = String(url);
    if (target.startsWith(CN_NPM_REGISTRY)) return jsonResponse({ message: 'down' }, 503);
    return releaseResponse();
  });
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  await putRegion(route, { region: 'cn' });
  const check = await call(route, { url: UPDATE_CHECK_PATH });
  assert.equal(check.statusCode, 200);
  const body = json(check);
  assert.equal(body.ok, false);
  assert.equal(body.hasUpdate, null);
  assert.equal(body.error.code, 'registry-unavailable');
  assert.equal(body.error.region, 'cn');
  assert.equal(body.error.registry, CN_NPM_REGISTRY);
  assert.equal(body.error.reason.status, 503);
  assert.deepEqual(
    transport.calls.map((entry) => entry.url),
    [`${CN_NPM_REGISTRY}dsh-prompt-setting`],
    'GitHub is not asked, and npmjs is not asked either',
  );
});

test('region route: turning the switch back off leaves the region in the file', async () => {
  // The switch's own write is merged into the document (g-043): the atomic write
  // replaces the whole file, so a region the user chose must survive a flip.
  const transport = makeTransport((url) => (String(url).startsWith(CN_NPM_REGISTRY) ? npmResponse() : releaseResponse()));
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  await putRegion(route, { region: 'cn' });
  await call(route, {
    method: 'PUT',
    url: UPDATE_CHECK_PATH,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  const stored = JSON.parse(readFileSync(userPreferencesPath(), 'utf8'));
  assert.equal(stored.updateCheck, false);
  assert.equal(stored[DOWNLOAD_REGION_FLAG], 'cn', 'the switch write did not erase the region');
});

test('region route: the method table is honoured, and the fence still runs first', async () => {
  const transport = makeTransport();
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const post = await call(route, { method: 'POST', url: DOWNLOAD_REGION_PATH });
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.allow, 'GET, PUT');

  const fenced = mountHost({
    config: { updateCheck: { fetch: transport.fetch } },
    requestRejection: () => 403,
  });
  const rejected = await call(fenced.route, { url: DOWNLOAD_REGION_PATH });
  assert.equal(rejected.statusCode, 403);
  assert.equal(transport.calls.length, 0, 'a rejected request never reaches the probe');
});

test('region route: a custom mirror that stops answering is the same structured error', async () => {
  // The third arm of "three options × the registry usable / unusable": a
  // validated custom address is still not answered by GitHub when it fails.
  const transport = makeTransport((url) => {
    const target = String(url);
    if (target.startsWith('https://mirror.example/npm/')) return npmResponse();
    if (target === GITHUB_URL) return releaseResponse();
    return jsonResponse({ message: 'down' }, 503);
  });
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const saved = await putRegion(route, { region: 'custom', registry: 'https://mirror.example/npm' });
  assert.equal(json(saved).ok, true);

  // The same mount, with the saved mirror now failing: the check names the
  // failure and asks nobody else.
  const failing = mountHost({
    config: {
      updateCheck: {
        fetch: async (url) => {
          const target = String(url);
          return target.startsWith('https://mirror.example/npm/')
            ? jsonResponse({ message: 'down' }, 503)
            : jsonResponse({ tag_name: 'v0.2.2' });
        },
      },
    },
  });
  const check = json(await call(failing.route, { url: UPDATE_CHECK_PATH }));
  assert.equal(check.ok, false);
  assert.equal(check.error.code, 'registry-unavailable');
  assert.equal(check.error.registry, 'https://mirror.example/npm/');
  assert.equal(check.error.reason.status, 503);
});

test('region route: the probe bounds come from the plugin config, so a wedged probe still answers', async () => {
  // A transport that never answers: only the injected bound can end this. With
  // the shipped 2.5 s the two probes would take 5 s, so a sub-200 ms answer is
  // the assertion that `downloadRegion.probeTimeoutMs` really reached the
  // manager (and that the bound is a hard one).
  const { route } = mountHost({
    config: {
      updateCheck: { fetch: () => new Promise(() => {}) },
      downloadRegion: { probeTimeoutMs: 10 },
    },
  });
  const started = Date.now();
  const res = await call(route, { url: DOWNLOAD_REGION_PATH });
  const elapsed = Date.now() - started;
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).region, 'default');
  assert.ok(elapsed < 500, `the bound is enforced (took ${elapsed} ms)`);
});

test('region route: mounting the plugin probes nobody', async () => {
  // The detection is a request of its own (§17.9), never a mount-time cost: the
  // settings page must be able to render without waiting for a registry.
  const transport = makeTransport();
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const ping = await call(route, { url: PING_PATH });
  assert.equal(ping.statusCode, 200);
  assert.deepEqual(transport.calls, [], 'a mount and a ping ask no registry');
});

test('update: the shipped six-hour TTL is the cache window, not an injected bound', async () => {
  // Regression guard for a real defect this revision introduced and no existing
  // case caught: the default TTL was accidentally clamped by the *timeout* cap
  // (60 s), so an answer that promised six hours expired after one minute. A
  // clock is injected and one hour of wall time passes — inside the TTL, far
  // outside any timeout bound.
  let clock = 0;
  const transport = makeTransport();
  const checker = createUpdateChecker({
    fetch: transport.fetch,
    repositoryUrl: 'https://github.com/o/r',
    currentVersion: '0.1.1',
    now: () => clock,
    readPreferences: () => ({ updateCheck: true }),
  });
  assert.equal((await checker.check()).cached, false);
  clock += 60 * 60 * 1000;
  assert.equal((await checker.check()).cached, true, 'one hour later is still inside the six-hour window');
  assert.equal(transport.calls.length, 1);
  clock += 6 * 60 * 60 * 1000;
  assert.equal((await checker.check()).cached, false, 'seven hours later the cache has expired');
  assert.equal(transport.calls.length, 2);

  // An *injected* TTL longer than the timeout cap must survive too: the two
  // bounds are different questions, and clamping one by the other silently
  // shortened a profile's configured window.
  let injected = 0;
  const second = makeTransport();
  const configured = createUpdateChecker({
    fetch: second.fetch,
    repositoryUrl: 'https://github.com/o/r',
    currentVersion: '0.1.1',
    ttlMs: 60 * 60 * 1000,
    now: () => injected,
    readPreferences: () => ({ updateCheck: true }),
  });
  assert.equal((await configured.check()).cached, false);
  injected += 30 * 60 * 1000;
  assert.equal((await configured.check()).cached, true, 'half an hour is inside an injected one-hour TTL');
  assert.equal(second.calls.length, 1);
});

// #region g-043 review fix 1: a refused source is refused everywhere

test('update: an explicitly refused registry asks nobody — not npmjs, not GitHub', async () => {
  // The BLOCK: `null` and `undefined` both went through `normalizeRegistry`'s
  // "not a string ⇒ the default" branch, so a caller that explicitly refused the
  // npm source was silently answered from npmjs.org. The two statements must now
  // differ, and the difference must be visible in the outbound traffic.
  const cases = [
    ['a resolver that answers null', () => null],
    ['a plain null', null],
  ];
  for (const [label, registry] of cases) {
    const calls = [];
    const checker = createUpdateChecker({
      fetch: async (url) => {
        calls.push(String(url));
        return npmResponse();
      },
      repositoryUrl: 'https://github.com/o/r',
      currentVersion: '0.1.5',
      registry,
      readPreferences: () => ({ updateCheck: true }),
    });
    const result = await checker.check();
    assert.deepEqual(calls, [], `${label}: zero outbound requests`);
    assert.equal(result.ok, false, label);
    assert.equal(result.error.code, 'registry-invalid', label);
    assert.equal(result.registry, null, label);
    assert.equal(result.source, null, 'no upstream produced this answer');
  }
});

test('update: an unstated registry is still the shipped default (the control)', async () => {
  // The other half of the fix: `undefined` — and a resolver that **throws** —
  // must keep meaning "nobody configured this", i.e. npmjs.org. Treating a broken
  // getter as a refusal would silently disable the npm path.
  for (const [label, registry] of [
    ['no option at all', undefined],
    ['a resolver that answers undefined', () => undefined],
    ['a resolver that throws', () => {
      throw new Error('EIO: cannot read preferences');
    }],
  ]) {
    const calls = [];
    const checker = createUpdateChecker({
      fetch: async (url) => {
        calls.push(String(url));
        return npmResponse();
      },
      repositoryUrl: 'https://github.com/o/r',
      currentVersion: '0.1.5',
      registry,
      readPreferences: () => ({ updateCheck: true }),
    });
    const result = await checker.check();
    assert.deepEqual(calls, [REGISTRY_URL], `${label}: npmjs is asked`);
    assert.equal(result.ok, true, label);
    assert.equal(result.source, UPDATE_SOURCE_NPM, label);
    assert.equal(result.registry, DEFAULT_NPM_REGISTRY, label);
  }
});

test('update: a malformed *string* from a profile keeps the Revision 27 fallback', async () => {
  // Deliberately NOT in the refused class: §17.2 keeps g-042's behaviour — an
  // unusable string disables the npm path and GitHub answers, with the npm reason
  // reported beside it. The fix must not swallow that.
  const calls = [];
  const checker = createUpdateChecker({
    fetch: async (url) => {
      calls.push(String(url));
      return releaseResponse();
    },
    repositoryUrl: 'https://github.com/o/r',
    currentVersion: '0.1.5',
    registry: 'file:///tmp/registry',
    readPreferences: () => ({ updateCheck: true }),
  });
  const result = await checker.check();
  assert.deepEqual(calls, ['https://api.github.com/repos/o/r/releases/latest'], 'npm is skipped, GitHub answers');
  assert.equal(result.source, UPDATE_SOURCE_GITHUB);
  assert.equal(result.registry, null, 'the unusable base is still reported as null');
});

test('update route: an unusable custom address is a structured error with zero outbound requests', async () => {
  // The end-to-end shape of the BLOCK, through the real mount: the resolver
  // `index.js` wires is `resolveDownloadRegion(...).registry`, which is `null` for
  // a `custom` region whose saved address is unusable.
  const transport = makeTransport();
  writePreferences(userPreferencesPath(), {
    updateCheck: true,
    [DOWNLOAD_REGION_FLAG]: 'custom',
    [DOWNLOAD_REGION_REGISTRY_FLAG]: 'mirror.example',
  });
  const { route } = mountHost({ config: { updateCheck: { fetch: transport.fetch } } });
  const res = await call(route, { url: UPDATE_CHECK_PATH });
  assert.equal(res.statusCode, 200);
  const body = json(res);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'registry-invalid');
  assert.equal(body.region, 'custom');
  assert.equal(body.registry, null);
  assert.equal(body.source, null);
  assert.deepEqual(transport.calls, [], 'nothing left the machine');
});

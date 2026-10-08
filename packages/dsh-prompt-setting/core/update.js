/**
 * `dsh-prompt-setting` — upstream update check, host side.
 *
 * Pure policy, no IO: this module never touches the filesystem, never imports a
 * DSH package and never calls `fetch` itself. Everything with a side effect is
 * injected — the HTTP client (`fetch`), the clock (`now`) and the two preference
 * functions — which is what makes the whole thing testable without a network
 * (`test/update.test.mjs` drives it with a stub that answers from memory).
 *
 * The problem: this plugin is installed as a tarball or a `link:`, so nothing
 * ever tells the user that upstream moved on. The answer (g-030, re-founded by
 * g-042) is a `GET` against the **npm registry** first — the package document
 * `<registry>/dsh-prompt-setting`, read for `dist-tags.latest` — and one
 * `GET` against the **GitHub Releases API**
 * (`/repos/{owner}/{repo}/releases/latest`) as the fallback when npm cannot
 * answer. Both are performed by the Host — Node has no CORS wall, can time out,
 * can cache and can be switched off — and read by the page.
 *
 * Why npm is the primary path (g-042): the registry is the address this package
 * is *published* to, it is the path `dsh plugin add dsh-prompt-setting` takes,
 * and it is the one a mirror can be pointed at (g-043). GitHub Releases stays as
 * the degradation path, so a profile behind a registry that does not carry the
 * package still gets an answer.
 *
 * Three rules this module exists to enforce:
 *   - **never a false positive.** A registry `dist-tags.latest` or a release tag
 *     that does not parse (or an upstream with no such version at all) must
 *     answer "no usable information", not "you are behind". Every undecidable
 *     case is `hasUpdate: null`;
 *   - **a failure is a value, not an exception.** A network error, a timeout, an
 *     HTTP error or an unreadable body all come back as a payload with
 *     `ok: false` and a structured `error`. Nothing here throws at a route, so
 *     no update check can turn into a 5xx on the settings page;
 *   - **one identifiable request per upstream, no user data.** A single `GET`
 *     each (the fallback is only asked when the primary could not answer), one
 *     `user-agent`, no cookies, no body, no query derived from this machine.
 *
 * Every answer names which upstream produced it (`source`: `npm` / `github`),
 * which is what the page shows and what a diagnostic reads.
 *
 * @module dsh-prompt-setting/core/update
 */

/** Cache lifetime: six hours, per the goal's spec. */
export const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;
/** Hard timeout on the single upstream request: five seconds. */
export const UPDATE_CHECK_TIMEOUT_MS = 5000;
/** Upper bound accepted for an injected timeout, so a config cannot wedge a request. */
export const UPDATE_CHECK_MAX_TIMEOUT_MS = 60 * 1000;
/** Upper bound accepted for an injected TTL (30 days). */
export const UPDATE_CHECK_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** The API root the GitHub fallback's one `GET` is built from. */
export const GITHUB_API_ROOT = 'https://api.github.com/repos';
/** Prefix of the `user-agent` the request identifies itself with. */
export const UPDATE_CHECK_USER_AGENT = 'dsh-prompt-setting';
/** The preference document's one key, at the top level of `preferences.json`. */
export const UPDATE_CHECK_FLAG = 'updateCheck';
/**
 * The registry the npm path asks by default. Parameterized (g-042) because
 * g-043 wires a download region / mirror into the same slot; this module only
 * needs the base address.
 */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';
/** This package's own name in the registry — the document the npm path reads. */
export const NPM_PACKAGE_NAME = 'dsh-prompt-setting';
/** `source` when the npm registry answered. */
export const UPDATE_SOURCE_NPM = 'npm';
/** `source` when the GitHub Releases fallback answered (or could not). */
export const UPDATE_SOURCE_GITHUB = 'github';
/**
 * The default preference: **on**. The owner's口径 is "打开设置页即检查，
 * 静默失败，仅在有新版本时提示"; a missing or unreadable preference file must
 * therefore mean "check", not "do not check".
 */
export const UPDATE_CHECK_DEFAULT = true;

/**
 * Parse the `owner/repo` pair out of a manifest repository URL.
 *
 * This accepts what really appears in a `package.json` rather than one spelling:
 * `git+https://…`, `git://…`, `git+ssh://git@…`, the scp-style
 * `git@github.com:owner/repo.git`, and the `github:owner/repo` shorthand. The
 * `git+` prefix, a trailing `.git`, a trailing slash, a `#fragment` and a query
 * are all decoration on the same address and are stripped; anything that is not
 * github.com, or that does not name exactly two path segments, is refused
 * (`null`) instead of guessed at — the check would otherwise ask the wrong
 * repository for its releases.
 * @param url - the manifest's repository URL, or anything else.
 * @returns `{owner, repo}`, or `null` when it does not name a GitHub repository.
 */
export function parseRepositorySlug(url) {
  if (typeof url !== 'string') return null;
  const value = url.trim().replace(/#.*$/, '').replace(/\?.*$/, '');
  if (value.length === 0) return null;

  const shorthand = /^github:([^/\s]+)\/([^/\s]+)$/i.exec(value);
  if (shorthand !== null) return slugParts(shorthand[1], shorthand[2]);

  const scp = /^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(value);
  if (scp !== null) return slugParts(scp[1], scp[2]);

  let parsed;
  try {
    parsed = new URL(value.replace(/^git\+/, ''));
  } catch {
    return null;
  }
  if (!/^(www\.)?github\.com$/i.test(parsed.hostname)) return null;
  const segments = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  if (segments.length !== 2) return null;
  return slugParts(segments[0], segments[1]);
}

/**
 * Validate and normalize one `owner`/`repo` pair.
 * @param owner - the candidate owner.
 * @param repo - the candidate repository name.
 * @returns `{owner, repo}`, or `null`.
 */
function slugParts(owner, repo) {
  const name = String(repo ?? '').replace(/\.git$/i, '');
  const account = String(owner ?? '');
  const usable = /^[A-Za-z0-9._-]+$/;
  if (account.length === 0 || name.length === 0) return null;
  if (!usable.test(account) || !usable.test(name)) return null;
  return { owner: account, repo: name };
}

/**
 * The one address this plugin ever asks. Built from the parsed slug, never from
 * request input and never hardcoded a second time.
 * @param slug - `{owner, repo}`.
 * @returns the `/releases/latest` URL.
 */
export function releasesLatestUrl(slug) {
  return `${GITHUB_API_ROOT}/${slug.owner}/${slug.repo}/releases/latest`;
}

/**
 * Normalize an injected npm registry base address (g-042).
 *
 * Three answers, and the third is the one that matters:
 *   - **absent/blank** ⇒ {@link DEFAULT_NPM_REGISTRY}. A profile that declares
 *     nothing gets the public registry, which is what the shipped default means;
 *   - **an `http(s)` URL** ⇒ the same URL with any query/fragment dropped and a
 *     trailing `/` guaranteed, so a mirror that lives under a path
 *     (`https://mirror.example/npm`) keeps it when the package name is appended;
 *   - **anything else non-empty** (a bare hostname, a `file:`/`ftp:` URL, junk)
 *     ⇒ `null`, which **disables the npm path** rather than silently asking
 *     npmjs.org for a profile that pointed somewhere else. The check then goes
 *     straight to the GitHub fallback, and says so.
 * @param value - the configured registry, or anything else.
 * @returns the normalized base address, or `null` when npm must not be asked.
 */
export function normalizeRegistry(value) {
  if (typeof value !== 'string') return DEFAULT_NPM_REGISTRY;
  const trimmed = value.trim();
  if (trimmed.length === 0) return DEFAULT_NPM_REGISTRY;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  parsed.search = '';
  parsed.hash = '';
  const text = parsed.toString();
  return text.endsWith('/') ? text : `${text}/`;
}

/**
 * The one npm document this check asks for.
 * @param registry - the registry base address (default {@link DEFAULT_NPM_REGISTRY}).
 * @param name - the package name (default {@link NPM_PACKAGE_NAME}).
 * @returns the package metadata URL, or `null` when the registry is unusable.
 */
export function registryPackageUrl(registry = DEFAULT_NPM_REGISTRY, name = NPM_PACKAGE_NAME) {
  const base = normalizeRegistry(registry);
  if (base === null) return null;
  try {
    return new URL(encodeURIComponent(name), base).toString();
  } catch {
    return null;
  }
}

/**
 * The install spec a **real npm packument** carries for one version (g-042).
 *
 * The registry's own contract puts a version's artifact under
 * **`versions[<version>].dist.tarball`** — there is **no top-level `dist`** in a
 * packument (full `application/json` and abbreviated
 * `application/vnd.npm.install-v1+json` alike): the top level carries `name`,
 * `dist-tags`, `versions`, `time` and friends. Reading `body.dist` looks
 * plausible and is always `null` against the real registry, which is exactly the
 * defect the owner's real-machine review caught (the first revision of this code
 * passed its own tests and answered `asset-missing` for every real install).
 *
 * Lookup order, so a version the document spells differently is still found:
 *   1. `versions[latestTag]` — `dist-tags.latest` verbatim (`v1.2.3`);
 *   2. `versions[canonical]` — the same version canonicalized (`1.2.3`), for the
 *      case where the dist-tag carries a `v` the version keys do not;
 *   3. **tolerated fallback only**: a top-level `dist.tarball`, for a
 *      non-standard registry that flattens the document. This is a courtesy, not
 *      the contract, and never the primary source.
 *
 * Only a non-blank string is returned, verbatim (no trimming beyond the edges,
 * no rewriting): whether it may be handed to pnpm is `core/install.js`'s call
 * (`registryTarballSpec`), not this function's.
 * @param body - the parsed packument, or anything else.
 * @param latestTag - `dist-tags.latest` verbatim.
 * @param canonical - the same version, canonicalized (`v1.2.3` → `1.2.3`).
 * @returns the tarball URL, or `null` when the document names none.
 */
export function registryTarball(body, latestTag, canonical) {
  const document = isRecord(body) ? body : {};
  const versions = isRecord(document.versions) ? document.versions : {};
  const keys = [];
  for (const key of [latestTag, canonical]) {
    if (typeof key === 'string' && key.trim().length > 0) keys.push(key.trim());
  }
  for (const key of new Set(keys)) {
    const entry = isRecord(versions[key]) ? versions[key] : null;
    const named = entry === null ? null : tarballOf(entry.dist);
    if (named !== null) return named;
  }
  return tarballOf(document.dist);
}

/**
 * A plain JSON object — not `null`, not an array, not a primitive.
 * @param value - the candidate.
 * @returns true when it is an object with named fields.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The non-blank `tarball` string inside one `dist` object, or `null`.
 * @param dist - the candidate `dist`.
 * @returns the URL, or `null`.
 */
function tarballOf(dist) {
  if (!isRecord(dist)) return null;
  return typeof dist.tarball === 'string' && dist.tarball.trim().length > 0 ? dist.tarball.trim() : null;
}

/**
 * The human release page for one tag — the fallback when GitHub's own
 * `html_url` is absent but the slug and tag are known.
 * @param slug - `{owner, repo}`.
 * @param tag - the tag name.
 * @returns the release page URL.
 */
export function releasePageUrl(slug, tag) {
  return `https://github.com/${slug.owner}/${slug.repo}/releases/tag/${encodeURIComponent(tag)}`;
}

/**
 * A leading `v` is decoration, not version, and npm and git disagree about it —
 * so it is tolerated. What is **not** tolerated is a tag this plugin cannot
 * compare: `1.2`, `1.2.3.4`, `latest` and the like answer `null`, which the
 * caller turns into "no usable information" rather than a guess. A prerelease
 * or build suffix (`1.2.3-rc.1`) parses as its core triple; `/releases/latest`
 * never returns a prerelease, so the suffix only matters for a hand-written tag.
 */
const SEMVER = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Parse a release tag into its numeric triple.
 * @param tag - the tag name (`v0.1.2`, `0.1.2`, `0.1.2-rc.1`, …).
 * @returns `{major, minor, patch}`, or `null` when it is not a version.
 */
export function parseSemver(tag) {
  if (typeof tag !== 'string') return null;
  const match = SEMVER.exec(tag.trim());
  if (match === null) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return { major: parts[0], minor: parts[1], patch: parts[2] };
}

/**
 * The canonical `major.minor.patch` spelling of a parsed tag.
 * @param version - a parsed version.
 * @returns the dotted string.
 */
export function formatSemver(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * Compare two parsed versions, numerically segment by segment.
 * @param left - a parsed version.
 * @param right - a parsed version.
 * @returns `-1`, `0` or `1`.
 */
export function compareSemver(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

/**
 * Is `latestTag` newer than `currentVersion`?
 * @param latestTag - the tag GitHub reported.
 * @param currentVersion - this package's own version.
 * @returns `true`/`false`, or `null` when either side does not parse — the
 *   undecidable answer, which must never be rendered as "there is an update".
 */
export function isNewerVersion(latestTag, currentVersion) {
  const latest = parseSemver(latestTag);
  const current = parseSemver(currentVersion);
  if (latest === null || current === null) return null;
  return compareSemver(latest, current) > 0;
}

/**
 * Normalize a preference document.
 *
 * Only the boolean `false` closes the switch. A missing field, a `null`, a
 * string `"false"` and any other shape all fall back to the default (on): a
 * malformed file must not be the reason a privacy switch silently reads as off
 * *or* as on — the default is stated in one place, once.
 * @param raw - the parsed `preferences.json`, or anything else.
 * @returns `{updateCheck: boolean}`.
 */
export function normalizePreferences(raw) {
  const stated = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw[UPDATE_CHECK_FLAG] : undefined;
  return { [UPDATE_CHECK_FLAG]: stated === false ? false : UPDATE_CHECK_DEFAULT };
}

/**
 * Coerce an injected number to a bounded positive integer.
 * @param value - the candidate.
 * @param fallback - the default when it is not a usable number.
 * @param max - the upper bound.
 * @returns the resolved number.
 */
function boundedNumber(value, fallback, max) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

/**
 * A marker rejection for the internal timeout race. Never escapes the checker:
 * it is caught and converted into the `timeout` payload.
 */
class UpdateTimeout extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpdateTimeout';
  }
}

/**
 * Create this mount's update checker: one cache, one preference path, one
 * injected transport.
 *
 * The returned object is deliberately tiny and side-effect free apart from the
 * calls it was handed:
 *   - `check({force})` — the answer the route returns verbatim;
 *   - `setEnabled(boolean)` — persist the switch;
 *   - `preferences()` — the current preference (never throws).
 *
 * @param options.fetch - the HTTP client (defaults to the global `fetch`).
 * @param options.repositoryUrl - this package's manifest repository URL.
 * @param options.currentVersion - this package's version (already normalized by
 *   the caller from its own module constant, so the client can never compare
 *   against a version the manifest and the code disagree about).
 * @param options.registry - the npm registry base address (default
 *   {@link DEFAULT_NPM_REGISTRY}); an unusable value disables the npm path
 *   ({@link normalizeRegistry}) instead of being silently replaced.
 * @param options.ttlMs - cache lifetime (default {@link UPDATE_CHECK_TTL_MS}).
 * @param options.timeoutMs - request timeout (default {@link UPDATE_CHECK_TIMEOUT_MS}),
 *   applied to **each** upstream attempt, so a check that falls back costs at
 *   most two timeouts.
 * @param options.now - the clock, in milliseconds (defaults to `Date.now`).
 * @param options.readPreferences - `() => preferences` (defaults to the default).
 * @param options.writePreferences - `(preferences) => void` (defaults to a no-op).
 * @returns the checker.
 */
export function createUpdateChecker(options = {}) {
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch;
  const repositoryUrl = typeof options.repositoryUrl === 'string' ? options.repositoryUrl : null;
  const currentVersion = typeof options.currentVersion === 'string' ? options.currentVersion : null;
  const registry = normalizeRegistry(options.registry);
  const ttlMs = boundedNumber(options.ttlMs, UPDATE_CHECK_TTL_MS, UPDATE_CHECK_MAX_TTL_MS);
  const timeoutMs = boundedNumber(options.timeoutMs, UPDATE_CHECK_TIMEOUT_MS, UPDATE_CHECK_MAX_TIMEOUT_MS);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const readPreferences = typeof options.readPreferences === 'function' ? options.readPreferences : () => null;
  const writePreferences = typeof options.writePreferences === 'function' ? options.writePreferences : () => {};
  /** The last **decidable** answer: `{at, payload}`. Failures are never cached. */
  let cache = null;

  /** The current preference, normalized, never throwing. */
  function preferences() {
    try {
      return normalizePreferences(readPreferences());
    } catch {
      return normalizePreferences(null);
    }
  }

  /**
   * Build the answer skeleton every branch starts from.
   * @param extra - fields to override.
   * @returns the payload.
   */
  function payload(extra = {}) {
    return {
      ok: true,
      enabled: preferences()[UPDATE_CHECK_FLAG],
      current: currentVersion,
      latest: null,
      /**
       * The tag GitHub actually published — or the npm `dist-tags.latest` — verbatim
       * (no `v` stripped, no reformatting), or `null` when the answer is not about
       * a published version.
       *
       * g-032: `latest` is a *version* and is therefore canonicalized
       * (`v0.1.2` → `0.1.2`), which is exactly right for display and exactly
       * wrong for a URL: the release **asset** path is keyed by the tag as
       * published. Both now travel on the same payload, from the same request,
       * so the "install this version" button can never name a tag the check did
       * not see — and the existing fields keep their shapes.
       */
      latestTag: null,
      hasUpdate: null,
      releaseUrl: null,
      publishedAt: null,
      /**
       * g-042: which upstream produced this answer — `"npm"`, `"github"`, or
       * `null` when no upstream was consulted at all (the switch is off, or the
       * runtime has no `fetch`). Additive: a pre-g-042 client ignores it and
       * renders exactly as before.
       */
      source: null,
      /**
       * g-042: the npm registry's own `dist.tarball` for `latest`, exactly as the
       * document spelled it — the install spec when `source: "npm"` (§18.2). It is
       * read from the packument's **`versions[<version>].dist.tarball`** (there is
       * no top-level `dist`), see {@link registryTarball}. `null` on every answer
       * that is not an npm one, and `null` when the document carried no usable
       * string. The *install* route decides whether it may be handed to pnpm; this
       * field is only what upstream said.
       */
      tarball: null,
      checkedAt: new Date(now()).toISOString(),
      cached: false,
      error: null,
      ...extra,
    };
  }

  /**
   * A structured failure — `ok:false` plus a code the client can name. It is a
   * **200** on the wire: an update check that fails is not an error page.
   * @param code - the stable code.
   * @param message - the readable message.
   * @param extra - further fields (a `status`, for instance).
   * @returns the payload.
   */
  function failure(code, message, extra = {}) {
    return payload({ ok: false, hasUpdate: null, error: { code, message, ...extra } });
  }

  /**
   * Store a decidable answer in the cache and return it.
   * @param result - the payload.
   * @param cacheable - whether a repeat request may reuse it.
   * @returns the payload.
   */
  function settle(result, cacheable) {
    cache = cacheable ? { at: now(), payload: result } : null;
    return result;
  }

  /**
   * Read a JSON body from whatever the injected transport returned, accepting
   * both the real `Response` (`json()`) and a minimal double (`text()`).
   * @param response - the transport's response.
   * @returns the parsed body, or `undefined` when there is none.
   */
  async function responseJson(response) {
    if (typeof response?.json === 'function') {
      try {
        return await response.json();
      } catch {
        return undefined;
      }
    }
    if (typeof response?.text === 'function') {
      try {
        const text = await response.text();
        return text.length === 0 ? undefined : JSON.parse(text);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * One upstream `GET`, raced against the timeout and read as JSON.
   *
   * Both paths ask exactly the same way — one `GET`, one identifiable
   * `user-agent`, no body, no cookies — and both degrade the same way: a throw, a
   * timeout, an HTTP status and an unreadable body all become a **value**
   * (`{ok:false, code, message, status?}`) that the caller turns into a fallback
   * or into a 200 payload. The timeout is **per attempt**, so a check that has to
   * fall back costs at most two of them.
   * @param url - the address to ask.
   * @param accept - the `accept` header.
   * @param label - how the upstream is named in a failure message.
   * @returns `{ok:true, body, status}` or `{ok:false, code, message, status?}`.
   */
  async function getJson(url, accept, label) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    let timer = null;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new UpdateTimeout(`${label} did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
    });

    let response;
    try {
      response = await Promise.race([
        fetchImpl(url, {
          method: 'GET',
          headers: { accept, 'user-agent': `${UPDATE_CHECK_USER_AGENT}/${currentVersion ?? 'unknown'}` },
          ...(controller === null ? {} : { signal: controller.signal }),
        }),
        timeout,
      ]);
    } catch (error) {
      if (controller !== null) {
        try {
          controller.abort();
        } catch {
          // an uncancellable request is still just a failed check
        }
      }
      if (timedOut || error instanceof UpdateTimeout) {
        return { ok: false, code: 'timeout', message: `the upstream check did not finish within ${timeoutMs} ms` };
      }
      return { ok: false, code: 'network-error', message: firstLine(error) };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    const status = typeof response?.status === 'number' ? response.status : 0;
    if (response?.ok !== true) {
      return {
        ok: false,
        code: 'http-error',
        message: `${label} answered HTTP ${status === 0 ? '?' : status}`,
        ...(status === 0 ? {} : { status }),
      };
    }
    return { ok: true, body: await responseJson(response), status };
  }

  /**
   * The **npm** attempt (g-042) — the primary path.
   *
   * One `GET` of the package document; `dist-tags.latest` is the version and
   * **`versions[<version>].dist.tarball`** is the install spec
   * ({@link registryTarball} — the real packument has no top-level `dist`). Every
   * way this can fail to produce a version — no usable registry, a network error,
   * a timeout, a non-2xx status, a body that is not a package document, a missing
   * or unparsable `dist-tags.latest` — is `{ok:false, failure}` and the caller
   * falls back to GitHub. It deliberately never invents an "undecidable upstream"
   * answer: a document the registry did not really serve is *unusable*, not a fact
   * about this package. A document that simply names no tarball is **not** a
   * failure of the check: the version is still the version, and §18.2 refuses the
   * install with `asset-missing`.
   *
   * The one exception is a version that parses but cannot be compared against
   * this plugin's own: that is our own broken constant rather than npm's silence,
   * so it is reported (and cached) as the same `uncomparable-version` answer the
   * GitHub path produces.
   * @returns `{ok:true, cacheable, payload}` or `{ok:false, failure}`, where
   *   `failure` is `null` when the npm path was never attempted at all.
   */
  async function attemptRegistry() {
    if (registry === null) return { ok: false, failure: null };
    const url = registryPackageUrl(registry);
    if (url === null) {
      // The profile pointed the npm path at something that is not an http(s)
      // registry. Asking npmjs.org anyway would ignore what it said, so the path
      // is skipped and the answer comes from GitHub.
      return { ok: false, failure: null };
    }
    const answer = await getJson(url, 'application/json', 'the npm registry');
    if (answer.ok !== true) {
      return {
        ok: false,
        failure: {
          code: answer.code,
          message: answer.message,
          ...(answer.status === undefined ? {} : { status: answer.status }),
        },
      };
    }
    const body = answer.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return {
        ok: false,
        failure: { code: 'invalid-response', message: 'the npm registry answered with a body that is not a package document' },
      };
    }
    const distTags = body['dist-tags'];
    const latestTag =
      distTags !== null && typeof distTags === 'object' && !Array.isArray(distTags) && typeof distTags.latest === 'string'
        ? distTags.latest.trim()
        : '';
    if (latestTag.length === 0) {
      return {
        ok: false,
        failure: { code: 'invalid-response', message: 'the npm registry document carries no dist-tags.latest' },
      };
    }
    const parsed = parseSemver(latestTag);
    if (parsed === null) {
      return {
        ok: false,
        failure: { code: 'unparsable-tag', message: `the npm dist-tag ${JSON.stringify(latestTag)} is not a version` },
      };
    }
    const newer = isNewerVersion(latestTag, currentVersion);
    if (newer === null) {
      return {
        ok: true,
        cacheable: true,
        payload: payload({
          source: UPDATE_SOURCE_NPM,
          latest: formatSemver(parsed),
          latestTag,
          hasUpdate: null,
          error: {
            code: 'uncomparable-version',
            message: `this package's own version ${JSON.stringify(currentVersion)} is not a version, so the comparison is undefined`,
          },
        }),
      };
    }
    const canonical = formatSemver(parsed);
    const tarball = registryTarball(body, latestTag, canonical);
    const time = body.time !== null && typeof body.time === 'object' && !Array.isArray(body.time) ? body.time : {};
    const publishedAt = typeof time[latestTag] === 'string'
      ? time[latestTag]
      : typeof time[canonical] === 'string'
        ? time[canonical]
        : null;
    return {
      ok: true,
      cacheable: true,
      payload: payload({
        source: UPDATE_SOURCE_NPM,
        latest: canonical,
        latestTag,
        hasUpdate: newer,
        // The npm answer has no release page, and the page's one link is labelled
        // for GitHub releases: `releaseUrl` stays null rather than sending that
        // label to a URL it does not describe (g-043 owns the copy).
        releaseUrl: null,
        publishedAt,
        tarball,
      }),
    };
  }

  /**
   * The **GitHub Releases** attempt — the pre-existing path, kept as the
   * fallback.
   *
   * Its own 404 is a fact about upstream (no release yet) and stays a decidable,
   * cached answer; every other failure is `{ok:false, failure}` and becomes a
   * fallback or the final payload.
   * @returns `{ok:true, cacheable, payload}` or `{ok:false, failure}`.
   */
  async function attemptGithub() {
    const slug = parseRepositorySlug(repositoryUrl);
    if (slug === null) {
      return {
        ok: false,
        failure: {
          code: 'no-repository',
          message: 'this package declares no usable GitHub repository URL, so there is nothing to compare against',
        },
      };
    }
    const answer = await getJson(releasesLatestUrl(slug), 'application/vnd.github+json', 'GitHub');
    if (answer.ok !== true) {
      if (answer.status === 404) {
        // No release yet — the goal says the repository may well be in this state,
        // and it is a fact about upstream, not a failure of the check.
        return {
          ok: true,
          cacheable: true,
          payload: payload({
            source: UPDATE_SOURCE_GITHUB,
            hasUpdate: null,
            error: { code: 'no-release', message: 'this repository has no published release yet' },
          }),
        };
      }
      return {
        ok: false,
        failure: {
          code: answer.code,
          message: answer.message,
          ...(answer.status === undefined ? {} : { status: answer.status }),
        },
      };
    }
    const body = answer.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, failure: { code: 'invalid-response', message: 'GitHub answered with a body that is not a release object' } };
    }
    const tag = typeof body.tag_name === 'string' ? body.tag_name.trim() : '';
    if (tag.length === 0) {
      return {
        ok: true,
        cacheable: true,
        payload: payload({
          source: UPDATE_SOURCE_GITHUB,
          hasUpdate: null,
          error: { code: 'invalid-response', message: 'the release carries no tag_name to compare against' },
        }),
      };
    }
    const parsed = parseSemver(tag);
    if (parsed === null) {
      return {
        ok: true,
        cacheable: true,
        payload: payload({
          source: UPDATE_SOURCE_GITHUB,
          hasUpdate: null,
          error: { code: 'unparsable-tag', message: `the release tag ${JSON.stringify(tag)} is not a version` },
        }),
      };
    }
    const newer = isNewerVersion(tag, currentVersion);
    if (newer === null) {
      return {
        ok: true,
        cacheable: true,
        payload: payload({
          source: UPDATE_SOURCE_GITHUB,
          latest: null,
          hasUpdate: null,
          error: {
            code: 'uncomparable-version',
            message: `this package's own version ${JSON.stringify(currentVersion)} is not a version, so the comparison is undefined`,
          },
        }),
      };
    }
    const htmlUrl = typeof body.html_url === 'string' && body.html_url.trim().length > 0 ? body.html_url.trim() : null;
    return {
      ok: true,
      cacheable: true,
      payload: payload({
        source: UPDATE_SOURCE_GITHUB,
        latest: formatSemver(parsed),
        latestTag: tag,
        hasUpdate: newer,
        releaseUrl: htmlUrl ?? releasePageUrl(slug, tag),
        publishedAt: typeof body.published_at === 'string' ? body.published_at : null,
      }),
    };
  }

  /**
   * Run one check: npm first, GitHub only when npm could not answer.
   *
   * Order matters and is the point of the whole module: the switch is read
   * **first**, so a closed switch cannot even reach the transport; the cache is
   * consulted second, so a repeat within the TTL costs nothing; `force` skips
   * only the cache, never the switch. Then npm is asked, and the fallback runs
   * for **a failure to answer** — never for an answer the user does not like: an
   * npm registry that says "you are up to date" *is* the answer.
   *
   * When neither upstream answers, the payload reports the GitHub attempt (the
   * last one) and carries the npm attempt's own reason beside it as `error.npm`;
   * that key is absent when the npm path was never attempted at all. Failures are
   * never cached, so the next check asks npm again.
   * @param options.force - bypass the cache (the manual re-check and the tests).
   * @returns the payload (never throws).
   */
  async function check({ force = false } = {}) {
    if (preferences()[UPDATE_CHECK_FLAG] !== true) {
      return payload({ hasUpdate: false });
    }
    // The age guard is not decoration: `now` is injectable, and a clock that
    // steps backwards (an NTP correction, a hand-set system time, a test's fake
    // clock) would otherwise make `now() - cache.at` negative and read a stale
    // answer as fresh *forever*. A non-monotonic clock is treated as "not fresh":
    // one extra request is cheaper than an answer that never expires.
    const age = cache === null ? null : now() - cache.at;
    if (force !== true && cache !== null && age >= 0 && age < ttlMs) {
      return { ...cache.payload, cached: true };
    }
    if (typeof fetchImpl !== 'function') {
      return failure('fetch-unavailable', 'this runtime offers no fetch, so the upstream check cannot run');
    }

    const npm = await attemptRegistry();
    if (npm.ok === true) return settle(npm.payload, npm.cacheable);
    const github = await attemptGithub();
    if (github.ok === true) return settle(github.payload, github.cacheable);
    return payload({
      ok: false,
      hasUpdate: null,
      source: UPDATE_SOURCE_GITHUB,
      error: {
        ...github.failure,
        ...(npm.failure === null ? {} : { npm: npm.failure }),
      },
    });
  }

  /**
   * Persist the switch. Returns a value rather than throwing, so the route can
   * answer `200 {ok:false, error}` instead of a 5xx.
   * @param enabled - the requested state.
   * @returns `{written, enabled, error}`.
   */
  function setEnabled(enabled) {
    const next = normalizePreferences({ [UPDATE_CHECK_FLAG]: enabled === true });
    try {
      writePreferences(next);
    } catch (error) {
      return {
        written: false,
        enabled: preferences()[UPDATE_CHECK_FLAG],
        error: { code: 'preferences-unwritable', message: firstLine(error) },
      };
    }
    return { written: true, enabled: next[UPDATE_CHECK_FLAG], error: null };
  }

  return { check, setEnabled, preferences };
}

/**
 * One line of an error, for a message that is rendered in a settings page.
 * @param error - the thrown value.
 * @returns a single line, never empty.
 */
function firstLine(error) {
  const text = error instanceof Error ? error.message : String(error ?? 'unknown error');
  const line = text.split('\n')[0].trim();
  return line.length === 0 ? 'unknown error' : line;
}

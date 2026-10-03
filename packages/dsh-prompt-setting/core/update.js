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
 * ever tells the user that upstream moved on. The answer (decided by the owner,
 * 2026-10-03) is one `GET` against the **GitHub Releases API**
 * (`/repos/{owner}/{repo}/releases/latest`), performed by the Host — Node has
 * no CORS wall, can time out, can cache and can be switched off — and read by
 * the page.
 *
 * Three rules this module exists to enforce:
 *   - **never a false positive.** `/releases/latest` already excludes drafts and
 *     prereleases, but a tag that does not parse (or a repository with no
 *     release at all) must answer "no usable information", not "you are behind".
 *     Every undecidable case is `hasUpdate: null`;
 *   - **a failure is a value, not an exception.** A network error, a timeout, an
 *     HTTP error or an unreadable body all come back as a payload with
 *     `ok: false` and a structured `error`. Nothing here throws at a route, so
 *     no update check can turn into a 5xx on the settings page;
 *   - **one request, no user data.** A single `GET`, one identifiable
 *     `user-agent`, no cookies, no body, no query derived from this machine.
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
/** The API root the one `GET` is built from. */
export const GITHUB_API_ROOT = 'https://api.github.com/repos';
/** Prefix of the `user-agent` the request identifies itself with. */
export const UPDATE_CHECK_USER_AGENT = 'dsh-prompt-setting';
/** The preference document's one key, at the top level of `preferences.json`. */
export const UPDATE_CHECK_FLAG = 'updateCheck';
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
 * @param options.ttlMs - cache lifetime (default {@link UPDATE_CHECK_TTL_MS}).
 * @param options.timeoutMs - request timeout (default {@link UPDATE_CHECK_TIMEOUT_MS}).
 * @param options.now - the clock, in milliseconds (defaults to `Date.now`).
 * @param options.readPreferences - `() => preferences` (defaults to the default).
 * @param options.writePreferences - `(preferences) => void` (defaults to a no-op).
 * @returns the checker.
 */
export function createUpdateChecker(options = {}) {
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch;
  const repositoryUrl = typeof options.repositoryUrl === 'string' ? options.repositoryUrl : null;
  const currentVersion = typeof options.currentVersion === 'string' ? options.currentVersion : null;
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
       * The tag GitHub actually published, verbatim (no `v` stripped, no
       * reformatting) — or `null` when the answer is not about a release.
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
   * Run one check.
   *
   * Order matters and is the point of the whole module: the switch is read
   * **first**, so a closed switch cannot even reach the transport (criterion 4);
   * the cache is consulted second, so a repeat within the TTL costs nothing;
   * `force` skips only the cache, never the switch.
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
    const slug = parseRepositorySlug(repositoryUrl);
    if (slug === null) {
      return failure(
        'no-repository',
        'this package declares no usable GitHub repository URL, so there is nothing to compare against',
      );
    }
    if (typeof fetchImpl !== 'function') {
      return failure('fetch-unavailable', 'this runtime offers no fetch, so the upstream check cannot run');
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    let timer = null;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new UpdateTimeout(`GitHub did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
    });

    let response;
    try {
      response = await Promise.race([
        fetchImpl(releasesLatestUrl(slug), {
          method: 'GET',
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': `${UPDATE_CHECK_USER_AGENT}/${currentVersion ?? 'unknown'}`,
          },
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
        return failure('timeout', `the upstream check did not finish within ${timeoutMs} ms`);
      }
      return failure('network-error', firstLine(error));
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    const status = typeof response?.status === 'number' ? response.status : 0;
    if (status === 404) {
      // No release yet — the goal says the repository may well be in this state,
      // and it is a fact about upstream, not a failure of the check.
      return settle(
        payload({
          hasUpdate: null,
          error: { code: 'no-release', message: 'this repository has no published release yet' },
        }),
        true,
      );
    }
    if (response?.ok !== true) {
      return failure('http-error', `GitHub answered HTTP ${status === 0 ? '?' : status}`, {
        ...(status === 0 ? {} : { status }),
      });
    }

    const body = await responseJson(response);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return failure('invalid-response', 'GitHub answered with a body that is not a release object');
    }
    const tag = typeof body.tag_name === 'string' ? body.tag_name.trim() : '';
    if (tag.length === 0) {
      return settle(
        payload({
          hasUpdate: null,
          error: { code: 'invalid-response', message: 'the release carries no tag_name to compare against' },
        }),
        true,
      );
    }
    const parsed = parseSemver(tag);
    if (parsed === null) {
      return settle(
        payload({
          hasUpdate: null,
          error: { code: 'unparsable-tag', message: `the release tag ${JSON.stringify(tag)} is not a version` },
        }),
        true,
      );
    }
    const newer = isNewerVersion(tag, currentVersion);
    if (newer === null) {
      return settle(
        payload({
          latest: null,
          hasUpdate: null,
          error: {
            code: 'uncomparable-version',
            message: `this package's own version ${JSON.stringify(currentVersion)} is not a version, so the comparison is undefined`,
          },
        }),
        true,
      );
    }
    const htmlUrl = typeof body.html_url === 'string' && body.html_url.trim().length > 0 ? body.html_url.trim() : null;
    return settle(
      payload({
        latest: formatSemver(parsed),
        latestTag: tag,
        hasUpdate: newer,
        releaseUrl: htmlUrl ?? releasePageUrl(slug, tag),
        publishedAt: typeof body.published_at === 'string' ? body.published_at : null,
      }),
      true,
    );
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

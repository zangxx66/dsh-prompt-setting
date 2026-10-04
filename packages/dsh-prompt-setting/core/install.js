/**
 * `dsh-prompt-setting` — 「立即更新」install policy, host side.
 *
 * Pure policy, no IO: this module never touches the filesystem, never imports a
 * DSH package, never calls `fetch` and never calls the plugin manager. Every
 * side effect lives in `index.js`; what lives here is the part that has to be
 * *decided* — which spec to install, whether deciding to install at all is
 * allowed, how an install's life is tracked, and how a failure is named.
 *
 * Why the work is split this way (g-032):
 *   - the Host installs through the **official** `pluginManager` service
 *     (`installBundle`, `cancelInstall`), whose own result is *not retained* —
 *     it deletes the `requestId` when the install settles. Everything the
 *     browser polls therefore has to be tracked here, with its own bound and its
 *     own eviction;
 *   - a single install can block for "~2 minutes waiting on the profile lock +
 *     10 minutes of silence timeout", so the route may never await it. The
 *     table below is what makes "return a `requestId` immediately, let the page
 *     poll" a small change instead of a timeout-shaped bug;
 *   - the install target is a **release tarball asset**
 *     (`…/releases/download/<tag>/dsh-prompt-setting-<version>.tgz`), which is
 *     the one form that is exempt from pnpm's build-script approval gate for
 *     this repository (measured, card `shared-cab1058d`). `approvedBuilds` is
 *     never passed: writing `allowBuilds` would let *later* installs run
 *     arbitrary package scripts.
 *
 * @module dsh-prompt-setting/core/install
 */

import { parseSemver } from './update.js';

/** The GitHub repository the release asset is fetched from. Fixed, never from input. */
export const INSTALL_REPOSITORY = Object.freeze({ owner: 'zangxx66', repo: 'dsh-prompt-setting' });
/** The asset name pattern every release of this package must carry. */
export const INSTALL_ASSET_PREFIX = 'dsh-prompt-setting-';
/** The only asset extension the install route accepts. `.tgz` is not decoration:
 * DSH refuses a URL that is neither a git host nor a tarball, and pnpm needs the
 * extension to treat it as a tarball at all. */
export const INSTALL_ASSET_EXTENSION = '.tgz';
/** How many install requests are remembered at once. */
export const INSTALL_REQUEST_LIMIT = 20;
/** How many of the newest **settled** entries are kept before the older ones go. */
export const INSTALL_SETTLED_RETENTION = 10;
/** Upper bound on one retained diagnostic, so a pnpm log tail cannot become a payload. */
export const INSTALL_MESSAGE_MAX = 240;

/** The install terminated in a way `classifyInstallFailure` could not name. */
export const INSTALL_FAILURE_UNKNOWN = 'unknown';

/**
 * The profile already holds exactly the artifact this install would fetch.
 *
 * Not a failure and not an install: the *only* thing left to do is restart, so
 * this is reported as a success whose application is `restart-required`.
 */
export const REFUSAL_ALREADY_INSTALLED = 'already-installed';

/**
 * Every code the official plugin manager can put on a failure.
 *
 * Taken from `@deepseek-ai/dsh-plugin-manager`'s `ManagementError.code`
 * (`lib/types/types.d.ts`): the `ReadOnlyReason` pair plus ten more. They are
 * enumerated here **on purpose**: the classifier used to know only pnpm's
 * `PackageResult.kind`, so an official refusal such as `ambiguous-install` fell
 * through to "the reason could not be classified" — an unactionable sentence for
 * a case the host had named precisely. A real desktop run hit exactly that:
 * `pnpm add <the already-installed spec>` changes nothing, and
 * `installBundle` throws `ambiguous-install` at `lib/index.js:1782`
 * (`installed.length !== 1`).
 */
export const MANAGEMENT_FAILURE_CODES = Object.freeze([
  'management-required',
  'unaddressable',
  'unknown-plugin',
  'invalid-spec',
  'ambiguous-install',
  'not-bundle',
  'not-removable',
  'stop-profile',
  'bundle-in-use',
  'stale-approval',
  'incompatible-version',
  'operation-error',
]);
/** The one management code that is a *wrapper*: its real reason is in the pnpm output. */
export const MANAGEMENT_OPERATION_ERROR = 'operation-error';

/**
 * The install phases this table can report. `installing` and `cancelling` are
 * live; the other three are settled and are the only ones the page stops
 * polling on.
 */
export const INSTALL_PHASES = Object.freeze(['installing', 'cancelling', 'done', 'failed', 'cancelled']);

/**
 * The `requestId` a cancel names when nothing in the table has it.
 * Not a failure of the request (the route still answers 200) — it says the
 * install is already gone, which is what a page that reloaded mid-install sees.
 */
export const INSTALL_UNKNOWN_REQUEST = 'unknown-request';

/**
 * Refuse codes. Every one of these reaches the page as `{ok:false, code,
 * message}` on a **200**: the button's whole promise is that it never paints the
 * settings page as an error page.
 */
export const REFUSAL_SERVICE_MISSING = 'installer-unavailable';
/** The profile holds this package as `link:`/`file:` — a working copy, not an install. */
export const REFUSAL_DEVELOPMENT_LINK = 'development-link';
/** The update check has no newer release, or could not decide. */
export const REFUSAL_NO_UPDATE = 'no-update';
/** The requested tag is not the tag the current check reported. */
export const REFUSAL_STALE_TAG = 'stale-tag';
/** The request body is not the documented shape. */
export const REFUSAL_INVALID_REQUEST = 'invalid-request';
/** The release asset is not there (the 0.1.1 release has zero assets). */
export const REFUSAL_ASSET_MISSING = 'asset-missing';
/** The release asset could not be verified because the probe itself failed. */
export const REFUSAL_ASSET_UNVERIFIED = 'asset-unverified';

/**
 * The tarball asset URL for one release.
 *
 * `<tag>` and `<version>` come from the **same** update check (the Host reuses
 * `core/update.js`'s `check()`, so a cached answer costs zero outbound
 * requests); neither is ever taken from the request body. The tag is used
 * verbatim — the asset path is keyed by the tag as published, which is not
 * always the canonicalized version (`v0.1.2` and `0.1.2` are different paths).
 *
 * The path is assembled from `encodeURIComponent`-ed segments and then parsed by
 * `URL`; a component that could break out of its segment cannot reach pnpm.
 * @param tag - the release tag (`.tgz` asset path segment).
 * @param version - the release version (asset name segment).
 * @returns the https URL.
 * @throws {TypeError} when either segment is not a valid version-ish string.
 */
export function buildReleaseAssetUrl(tag, version) {
  const cleanTag = typeof tag === 'string' ? tag.trim() : '';
  const cleanVersion = typeof version === 'string' ? version.trim() : '';
  if (parseSemver(cleanTag) === null) throw new TypeError(`not a release tag: ${JSON.stringify(tag)}`);
  if (parseSemver(cleanVersion) === null) throw new TypeError(`not a release version: ${JSON.stringify(version)}`);
  const path = [
    '',
    INSTALL_REPOSITORY.owner,
    INSTALL_REPOSITORY.repo,
    'releases',
    'download',
    cleanTag,
    `${INSTALL_ASSET_PREFIX}${cleanVersion}${INSTALL_ASSET_EXTENSION}`,
  ]
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return new URL(path, 'https://github.com').toString();
}

/**
 * The release page for a tag — the manual fallback a refusal points at.
 * @param tag - the release tag.
 * @returns the page URL, or `null` when the tag is not usable.
 */
export function releasePageForTag(tag) {
  const clean = typeof tag === 'string' ? tag.trim() : '';
  if (parseSemver(clean) === null) return null;
  return `https://github.com/${INSTALL_REPOSITORY.owner}/${INSTALL_REPOSITORY.repo}/releases/tag/${encodeURIComponent(clean)}`;
}

/**
 * Decide whether this update check offers anything installable, and from where.
 *
 * Both the version that was checked and the version that would be installed come
 * out of **one** payload, so the page can never announce `0.1.3` and install
 * `0.1.2`. A check that failed, is stale, or decided nothing (`hasUpdate:null`)
 * is a refusal with a readable reason, not an install.
 *
 * `tag` is the tag to fetch and `version` is the canonicalized version; they are
 * deliberately two values even when they happen to be equal (they are not for a
 * `v`-prefixed tag).
 * @param check - the payload `check()` returned.
 * @returns `{ok:true, tag, version, url, releaseUrl}` or `{ok:false, code, message, releaseUrl}`.
 */
export function resolveInstallTarget(check) {
  const payload = check !== null && typeof check === 'object' ? check : {};
  const releaseUrl = typeof payload.releaseUrl === 'string' && payload.releaseUrl.length > 0
    ? payload.releaseUrl
    : null;
  if (payload.hasUpdate !== true) {
    return {
      ok: false,
      code: REFUSAL_NO_UPDATE,
      message:
        'the last update check did not find a newer release, so there is nothing to install; press the update check again',
      releaseUrl,
    };
  }
  const version = typeof payload.latest === 'string' ? payload.latest.trim() : '';
  const tag = typeof payload.latestTag === 'string' && payload.latestTag.trim().length > 0
    ? payload.latestTag.trim()
    : version;
  if (parseSemver(version) === null || parseSemver(tag) === null) {
    return {
      ok: false,
      code: REFUSAL_NO_UPDATE,
      message: 'the last update check reported a release that is not a version, so it cannot be installed',
      releaseUrl,
    };
  }
  return {
    ok: true,
    tag,
    version,
    url: buildReleaseAssetUrl(tag, version),
    releaseUrl: releaseUrl ?? releasePageForTag(tag),
  };
}

/**
 * How this profile has `dsh-prompt-setting` written into its `dependencies`.
 *
 * The value is a string from the profile manifest or `null` when the profile
 * does not name the package at all. Reading it is IO and lives in `index.js`;
 * this function is the decision about what the value *means*.
 * @param value - the dependency spec, or anything else.
 * @returns `{field, spec, local}`.
 */
export function describeInstalledSpec(value) {
  const spec = typeof value === 'string' ? value.trim() : '';
  return {
    field: spec.length === 0 ? null : spec,
    spec: spec.length === 0 ? null : spec,
    local: isLocalSpec(spec),
  };
}

/**
 * Is this dependency spec a working copy rather than a published install?
 * @param spec - the dependency spec.
 * @returns true for `link:`, `file:`, or an absolute/relative path.
 */
export function isLocalSpec(spec) {
  if (typeof spec !== 'string') return false;
  const value = spec.trim();
  if (value.length === 0) return false;
  if (/^(?:link|file|portal|workspace):/i.test(value)) return true;
  // pnpm also accepts a bare path, and a Windows drive letter is absolute too.
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * May this profile be upgraded by installing over it?
 *
 * A1 (owner, 2026-10-04): a `link:`/path install is a **working copy** — the
 * developer's own tree — and `installBundle` would rewrite the profile's
 * dependency to a registry/tarball version with no way back. That is a
 * destructive edit of someone's development environment performed by a button
 * whose label says "update", so it is refused and the person is told to update
 * by hand.
 *
 * The answers are deliberately distinct, because "no plugin manager", "I could
 * not read the profile" and "you are running a linked working copy" need
 * different sentences:
 *   - `service === null` ⇒ refuse `installer-unavailable`;
 *   - `fieldError !== null` (the profile manifest exists but could not be read
 *     or parsed) ⇒ refuse `installer-unavailable`. **Failing closed matters
 *     here**: an unreadable manifest is not evidence that the package is
 *     unlinked, and treating it as "not declared" would let an install run
 *     against a profile whose form was never established;
 *   - a local spec ⇒ refuse `development-link`;
 *   - `field === null` **with no error** (the manifest was read and does not
 *     name this package) ⇒ **allowed**: installing adds a normal dependency,
 *     which is exactly what the profile being restored to a real install means.
 * @param options.service - the `pluginManager` service, or `null` when absent.
 * @param options.profileDir - the profile directory, or `null` when unknown.
 * @param options.field - the profile's own `dependencies['dsh-prompt-setting']`.
 * @param options.fieldError - why that value could not be read, or `null`.
 * @param options.tag - the tag that would be installed, for the message.
 * @returns `{ok, code, message, manual}`.
 */
export function resolveInstallPolicy(options = {}) {
  const tag = typeof options.tag === 'string' && options.tag.length > 0 ? options.tag : null;
  const manual = {
    releaseUrl: releasePageForTag(tag),
    releaseLink: tag === null
      ? 'open this repository\u2019s releases page'
      : `open the ${tag} release page`,
    command: 'dsh plugin add <tarball-or-path>',
  };
  if (options.service === null || options.service === undefined) {
    return {
      ok: false,
      code: REFUSAL_SERVICE_MISSING,
      message:
        'the plugin manager service is not available in this profile, so this plugin cannot install anything; update by hand',
      manual,
    };
  }
  if (options.profileDir === null || options.profileDir === undefined) {
    return {
      ok: false,
      code: REFUSAL_SERVICE_MISSING,
      message:
        'this profile\u2019s directory could not be resolved, so the current install form cannot be checked and nothing was installed; update by hand',
      manual,
    };
  }
  const fieldError = typeof options.fieldError === 'string' && options.fieldError.length > 0
    ? options.fieldError
    : null;
  if (fieldError !== null) {
    return {
      ok: false,
      code: REFUSAL_SERVICE_MISSING,
      message:
        `this profile\u2019s package.json could not be read (${fieldError}), so the current install form cannot be checked ` +
        'and nothing was installed; update by hand',
      manual,
    };
  }
  const current = describeInstalledSpec(options.field);
  if (current.local) {
    return {
      ok: false,
      code: REFUSAL_DEVELOPMENT_LINK,
      message:
        `this profile installs ${INSTALL_REPOSITORY.repo} from a local path (${current.spec}), which is a development working copy: ` +
        'installing a release over it would replace that link with a published version and there is no way back. Update by hand instead',
      manual: { ...manual, current: current.spec },
    };
  }
  return { ok: true, code: null, message: null, manual, current: current.spec };
}

/**
 * Does the profile already hold **exactly** the artifact this install would fetch?
 *
 * The comparison is deliberately literal (after trimming surrounding
 * whitespace): the profile's `dependencies['dsh-prompt-setting']` is either the
 * same tarball URL, a different URL, a semver range or a `link:` — and only the
 * identical string means "running this install would be a no-op".
 *
 * Why this must be answered **before** calling the manager: `pnpm add <spec>`
 * on an unchanged dependency changes nothing, so `installBundle` cannot find the
 * one new dependency it looks for and throws `ambiguous-install`
 * (`@deepseek-ai/dsh-plugin-manager` `lib/index.js:1782`). Letting that happen
 * turns a user's entirely reasonable second click into a *failure* sentence —
 * and spends a pnpm round trip (seconds, minutes under contention) to learn
 * something this plugin can read in one file.
 * @param currentSpec - the profile's own dependency string, or anything else.
 * @param targetUrl - the release asset URL this install would use.
 * @returns true when installing would change nothing.
 */
export function isAlreadyInstalledOn(currentSpec, targetUrl) {
  const spec = typeof currentSpec === 'string' ? currentSpec.trim() : '';
  const url = typeof targetUrl === 'string' ? targetUrl.trim() : '';
  return spec.length > 0 && url.length > 0 && spec === url;
}

/**
 * A dependency value that means "this very install", for the「已安装」line.
 * @param application - the `ChangeResult.application`.
 * @returns true when the change reached the running process without a restart.
 */
export function isLiveApplication(application) {
  return application === 'applied';
}

/**
 * Classify a failed install, from **both** places the host reports reasons.
 *
 * Two independent sources say why an install failed, and only one of them used
 * to be consulted:
 *   - `changeResult.error.code` — the official `ManagementError.code`
 *     ({@link MANAGEMENT_FAILURE_CODES}). This is the *most specific* fact
 *     available: the manager named the case itself. It therefore decides
 *     **before** any text matching, which also stops a `stale-approval` (a build
 *     approval) from being read as `build-blocked` merely because its diagnostic
 *     mentions `prepare`;
 *   - `changeResult.packageResult.kind` — pnpm's own `PluginInstallFailureKind`
 *     for a run that exited non-zero.
 *
 * `operation-error` is the one management code that is a *wrapper*: the manager
 * puts a non-`ManagementFailure` (in practice: pnpm's output) there, so it is
 * deliberately **not** returned as a code — the pnpm `kind`/diagnostic decides.
 *
 * The categories the goal asks to be told apart are kept, and two of them are
 * this feature's own:
 *   - **asset-missing** — the tarball is not on the release. This is the
 *     *expected* outcome for a release published before this feature existed
 *     (0.1.1 had zero assets), which is exactly why it must be a named branch
 *     and never a silent one;
 *   - **asset-unverified** — the asset could not be fetched anonymously.
 *
 * `unknown` survives only for the case where **neither** source said anything;
 * its sentence (§{@link describeInstallFailure}) says exactly that instead of
 * the old "could not be classified".
 * @param facts - `{kind, management, diagnostic, message, status, probe, offline}`
 *   from the install attempt.
 * @returns the failure code.
 */
export function classifyInstallFailure(facts = {}) {
  const stated = typeof facts.kind === 'string' ? facts.kind : '';
  const management = typeof facts.management === 'string' ? facts.management : '';
  const text = `${typeof facts.diagnostic === 'string' ? facts.diagnostic : ''} ${
    typeof facts.message === 'string' ? facts.message : ''
  }`;
  const status = Number.isFinite(facts.status) ? facts.status : 0;
  // 1. The probe's own answer, when the caller is classifying a probe result.
  if (status === 404 || status === 410) return 'asset-missing';
  if (status === 403 || status === 401) return 'asset-unverified';
  // 2. The manager's own code — the most specific thing known. A wrapper is not
  //    an answer, so `operation-error` falls through to pnpm's facts.
  if (management !== '' && management !== MANAGEMENT_OPERATION_ERROR) {
    if (MANAGEMENT_FAILURE_CODES.includes(management)) return management;
  }
  // 3. pnpm's own classification of the run it made.
  if (stated !== '') {
    if (stated === 'build-blocked') return 'build-blocked';
    if (stated === 'pnpm-missing' || stated === 'timeout' || stated === 'network') return stated;
    if (stated === 'not-found' || stated === 'no-matching-version') return stated;
    if (stated === 'integrity' || stated === 'permission' || stated === 'disk-full') return stated;
    if (stated === 'unknown') {
      // pnpm said "unknown"; the log may still name it, so fall through.
    }
  }
  // 4. The log itself (a tarball 404, the build-script gate, an errno).
  if (/ERR_PNPM_FETCH_404|\bE404\b|404 Not Found|Not Found - GET/i.test(text)) return 'asset-missing';
  if (/ERR_PNPM_IGNORED_BUILDS|Ignored build scripts|allowBuilds/i.test(text)) return 'build-blocked';
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|Could not resolve host/i.test(text)) {
    return 'network';
  }
  if (status === 0 && (facts.probe === true || facts.offline === true)) return 'network';
  // 5. Nothing named it. The sentence says so, without inventing a cause.
  return INSTALL_FAILURE_UNKNOWN;
}

/**
 * The readable sentence, the stable code and the manual route for one failure.
 *
 * Every category carries a `manual` hint: this feature can fail for reasons
 * outside the plugin (no assets published, no network, no pnpm), and the person
 * is never left with only a red line.
 * @param kind - the code `classifyInstallFailure` returned.
 * @param options.tag - the tag that was being installed, when known.
 * @param options.version - the version that was being installed, when known.
 * @returns `{code, message, manual, retryable}`.
 */
export function describeInstallFailure(kind, options = {}) {
  const tag = typeof options.tag === 'string' && options.tag.length > 0 ? options.tag : null;
  const version = typeof options.version === 'string' && options.version.length > 0 ? options.version : null;
  const named = version === null ? 'the new version' : `v${version}`;
  const releaseUrl = releasePageForTag(tag);
  const manual = { releaseUrl, releaseLink: 'open this repository\u2019s releases page' };
  const table = {
    'asset-missing': {
      message:
        `the ${tag === null ? '' : `${tag} `}release has no ${INSTALL_ASSET_PREFIX}<version>${INSTALL_ASSET_EXTENSION} asset to install from. ` +
        'Releases published before this feature existed carry no assets; the next release will',
      manual: { ...manual, releaseLink: tag === null ? manual.releaseLink : `check the ${tag} release for its assets` },
      retryable: true,
    },
    'build-blocked': {
      message:
        'pnpm refused a package build script during the install, so nothing was installed. ' +
        'This plugin never approves build scripts automatically; update by hand with dsh plugin add',
      manual,
      retryable: false,
    },
    network: {
      message: 'the release asset could not be reached, so nothing was installed. Check the network and try again',
      manual,
      retryable: true,
    },
    'pnpm-missing': {
      message: 'pnpm is not available to this profile, so the install could not run. Install pnpm, then try again',
      manual,
      retryable: true,
    },
    timeout: {
      message: 'the install did not finish in time and was stopped; the profile files were restored. Try again',
      manual,
      retryable: true,
    },
    'asset-unverified': {
      message: 'the release asset could not be verified before installing, so nothing was installed. Update by hand',
      manual,
      retryable: false,
    },
    'no-matching-version': {
      message: `${named} is not available from the registry, so nothing was installed. Update by hand`,
      manual,
      retryable: false,
    },
    'not-found': {
      message: `${named} was not found, so nothing was installed. Update by hand`,
      manual,
      retryable: false,
    },
    integrity: {
      message: 'the release asset failed its integrity check, so nothing was installed. Try again',
      manual,
      retryable: true,
    },
    permission: {
      message: 'the profile directory could not be written, so nothing was installed. Fix the permissions, then try again',
      manual,
      retryable: true,
    },
    'disk-full': {
      message: 'the disk is full, so nothing was installed. Free some space, then try again',
      manual,
      retryable: true,
    },
    // ── the official manager's own codes (`ManagementError.code`) ────────────
    // Each one is a case the manager named, so each gets its own actionable
    // sentence. None of them claims a rollback: whether files were restored is a
    // separate fact, and for `ambiguous-install` — a no-op install — nothing was
    // ever changed.
    [REFUSAL_ALREADY_INSTALLED]: {
      message: `the installed dependency did not change, so ${named} is already the version this profile holds. Restart dsh web to put it to work`,
      manual,
      retryable: false,
    },
    'ambiguous-install': {
      message:
        `the install changed nothing: ${named} is already the version this profile holds, so the package manager had no new dependency to report. ` +
        'Restart dsh web to put the installed version to work',
      manual,
      retryable: false,
    },
    'stale-approval': {
      message:
        'pnpm asked for a build-script approval that is no longer valid, so nothing was installed. ' +
        'Update by hand with dsh plugin add',
      manual,
      retryable: false,
    },
    'incompatible-version': {
      message: `${named} does not accept this DSH version (its peer range does not match), so nothing was installed`,
      manual,
      retryable: false,
    },
    'not-bundle': {
      message: `${named} declares no dsh.bundle, so it is not a plugin bundle this profile can install`,
      manual,
      retryable: false,
    },
    'not-removable': {
      message: 'this bundle cannot be removed by the plugin manager, so the install was refused',
      manual,
      retryable: false,
    },
    'bundle-in-use': {
      message: 'this bundle is in use by the running profile, so the install was refused. Restart dsh web and try again',
      manual,
      retryable: false,
    },
    'stop-profile': {
      message: 'this bundle is used by the running profile, so dsh web has to be stopped before it can be changed',
      manual,
      retryable: false,
    },
    'management-required': {
      message: 'this plugin is supplied by the DSH installation itself and cannot be managed from this profile; update DSH instead',
      manual,
      retryable: false,
    },
    'unaddressable': {
      message: 'the plugin manager could not address this profile\u2019s entry for the plugin, so nothing was installed; update by hand',
      manual,
      retryable: false,
    },
    'unknown-plugin': {
      message: 'the plugin manager found no entry for this plugin in the profile, so nothing was installed; update by hand',
      manual,
      retryable: false,
    },
    'invalid-spec': {
      message:
        'the plugin manager refused the install spec as invalid. That should not happen from this button (the URL is built from the update check); update by hand',
      manual,
      retryable: false,
    },
    [MANAGEMENT_OPERATION_ERROR]: {
      // Only reached when pnpm's own `kind` and log said nothing either.
      message: 'the package manager failed without naming a reason, so nothing was installed; update by hand',
      manual,
      retryable: true,
    },
    // ── the honest last resort ──────────────────────────────────────────────
    // Reachable only when **neither** source reported anything. It says exactly
    // that: no invented cause, and no claim about files being restored.
    [INSTALL_FAILURE_UNKNOWN]: {
      message: 'the install failed and the host reported no reason for it; update by hand',
      manual,
      retryable: true,
    },
  };
  const entry = table[kind] ?? table[INSTALL_FAILURE_UNKNOWN];
  return { code: table[kind] === undefined ? INSTALL_FAILURE_UNKNOWN : kind, ...entry };
}

/**
 * One short, single-line diagnostic from a possibly enormous pnpm log.
 * @param value - the raw text.
 * @returns a trimmed single line, or `null`.
 */
export function summarizeDiagnostic(value) {
  if (typeof value !== 'string') return null;
  const lines = value
    .split('\n')
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  // pnpm prints its context first and the `ERR_PNPM_*` line after, so the *last*
  // line is usually the one that names the failure; the first is the fallback
  // when nothing named one.
  const named = [...lines].reverse().find((line) => /ERR_PNPM_|ERR_|error/i.test(line)) ?? lines[0];
  return named.length > INSTALL_MESSAGE_MAX ? `${named.slice(0, INSTALL_MESSAGE_MAX - 1)}…` : named;
}

/**
 * A lifecycle phase that is still live: the install has not settled, and the
 * page may still cancel it.
 *
 * Exported because it has **two** readers that must agree: the route's cancel
 * guard (which decides whether to forward a cancel) and
 * {@link publicInstallStatus} (which tells the page whether to render the cancel
 * button). One predicate, so a row can never be reported as cancellable and then
 * refused, or the other way round.
 * @param phase - one phase, or anything else.
 * @returns true while the install has not settled.
 */
export function isLiveInstallPhase(phase) {
  return phase === 'installing' || phase === 'cancelling';
}

/**
 * The install-request table.
 *
 * The official manager deletes a finished request, so this is the only record of
 * what happened. It is bounded twice: at most {@link INSTALL_REQUEST_LIMIT}
 * entries live, and — once the table is full — the entries beyond the
 * {@link INSTALL_SETTLED_RETENTION} newest settled ones are evicted oldest
 * first. A **live** entry is never evicted: dropping a running install would
 * leave the page polling a request that will still change the profile.
 *
 * Evicted entries are not "not found": they answer `status:'unknown'`, which is
 * the honest sentence ("this page no longer knows") and is distinguishable from
 * "this id was never issued".
 *
 * @param options.limit - the entry cap (default {@link INSTALL_REQUEST_LIMIT}).
 * @param options.retention - settled entries kept (default {@link INSTALL_SETTLED_RETENTION}).
 * @param options.now - the clock in ms (defaults to `Date.now`).
 * @param options.ids - the id generator (defaults to a counter plus the clock;
 *   tests pass their own so an assertion never depends on randomness).
 * @returns the table.
 */
export function createInstallTable(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : INSTALL_REQUEST_LIMIT;
  const retention = Number.isInteger(options.retention) && options.retention >= 0
    ? options.retention
    : INSTALL_SETTLED_RETENTION;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const nextId = typeof options.ids === 'function'
    ? options.ids
    : (() => {
        let counter = 0;
        return () => `i${(counter += 1)}-${Math.random().toString(36).slice(2, 10)}`;
      })();
  /** Insertion-ordered: a `Map` keeps the newest entry last, which is the eviction order. */
  const entries = new Map();

  /**
   * Evict settled entries over the cap, oldest first. Live entries are kept
   * even when that leaves the table above its cap — correctness (a running
   * install the page can still poll) beats the bound, and the bound still holds
   * for everything that has stopped changing.
   */
  function evict() {
    if (entries.size <= limit) return;
    const settled = [...entries.values()].filter((entry) => !isLiveInstallPhase(entry.phase));
    let removable = settled.length - retention;
    for (const entry of settled) {
      if (entries.size <= limit && removable <= 0) break;
      entries.delete(entry.requestId);
      removable -= 1;
    }
  }

  /**
   * Open one request.
   * @param fields - `{tag, version, url}`; the request is `installing` from here.
   * @returns the stored entry (a copy, so callers cannot mutate the table).
   */
  function begin(fields = {}) {
    const requestId = String(nextId());
    const entry = {
      requestId,
      phase: 'installing',
      application: null,
      tag: typeof fields.tag === 'string' ? fields.tag : null,
      version: typeof fields.version === 'string' ? fields.version : null,
      url: typeof fields.url === 'string' ? fields.url : null,
      startedAt: new Date(now()).toISOString(),
      finishedAt: null,
      error: null,
      /** The caller's own cancel was accepted and has been forwarded. */
      cancelRequested: false,
      /** Kept so a late `installBundle` settlement can still be matched to this row. */
      settled: false,
    };
    entries.set(requestId, entry);
    evict();
    return { ...entry };
  }

  /**
   * The entry for one id, or a synthetic "this id is not known" answer.
   * @param requestId - the id to read.
   * @returns the entry view.
   */
  function read(requestId) {
    const id = typeof requestId === 'string' ? requestId : '';
    const entry = entries.get(id);
    if (entry === undefined) {
      return {
        requestId: id,
        phase: 'unknown',
        application: null,
        tag: null,
        version: null,
        url: null,
        startedAt: null,
        finishedAt: null,
        error: null,
        cancelRequested: false,
        cancellable: false,
        known: false,
      };
    }
    return { ...entry, cancellable: isLiveInstallPhase(entry.phase), known: true };
  }

  /**
   * The newest request that has not settled, or `null`.
   *
   * The route answers a fresh POST while one install is still running with this
   * request's id rather than starting a second `pnpm add` against the same
   * profile — two installs would queue on the profile lock and the second would
   * spend its life waiting (the measured worst case is ~2 minutes of lock wait
   * on top of the install itself).
   * @returns the entry view, or `null`.
   */
  function active() {
    for (const entry of [...entries.values()].reverse()) {
      if (isLiveInstallPhase(entry.phase)) {
        return { ...entry, cancellable: true, known: true };
      }
    }
    return null;
  }

  /**
   * Record an accepted cancel intent. The install itself is stopped by the
   * caller (the official `cancelInstall`); this only makes the intent visible to
   * the poll that is already in flight.
   * @param requestId - the id to mark.
   * @returns true when a live entry was marked.
   */
  function markCancelling(requestId) {
    const entry = entries.get(typeof requestId === 'string' ? requestId : '');
    if (entry === undefined || !isLiveInstallPhase(entry.phase)) return false;
    entry.phase = 'cancelling';
    entry.cancelRequested = true;
    return true;
  }

  /**
   * Settle one request from the manager's own `ChangeResult`.
   *
   * The application value is the **whole** verdict: `restart-required` is the
   * only one an upgrade of an already-installed bundle can produce, and it is
   * deliberately **not** turned into a failure — the install worked, the running
   * process simply still holds the old code, and the page's answer is「请手动重启
   * dsh web 生效」. Nothing here restarts anything.
   * @param requestId - the id that settled.
   * @param result - the `ChangeResult` (or a thrown error, folded by the caller).
   * @returns the settled entry view, or `null` when the id is not known.
   */
  function settle(requestId, result = {}) {
    const entry = entries.get(typeof requestId === 'string' ? requestId : '');
    if (entry === undefined) return null;
    const application = typeof result.application === 'string' ? result.application : null;
    entry.settled = true;
    entry.finishedAt = new Date(now()).toISOString();
    if (entry.cancelRequested && application !== 'failed') {
      // A cancel that was accepted before applyment ends as `cancelled`; the
      // official result says which, but a cancel that raced a success must not
      // be reported as a cancellation of something that really happened.
      entry.phase = application === 'cancelled' ? 'cancelled' : 'done';
      entry.application = application;
      entry.error = application === 'cancelled'
        ? { code: 'cancelled', message: 'the install was cancelled; the profile files were restored' }
        : null;
      return { ...entry };
    }
    if (application === 'cancelled') {
      entry.phase = 'cancelled';
      entry.application = application;
      entry.error = entry.error ?? {
        code: 'cancelled',
        message: 'the install was cancelled; the profile files were restored',
      };
      return { ...entry };
    }
    if (application === 'failed' || application === null) {
      entry.phase = 'failed';
      entry.application = application ?? 'failed';
      const kind = classifyInstallFailure({
        // Both sources the manager reports a reason in: its own code
        // (`error.code`) and pnpm's classification of the run it made
        // (`packageResult.kind`). Consulting only the second is what made a real
        // desktop `ambiguous-install` render as "the reason could not be
        // classified".
        management: result?.error?.code,
        kind: result?.packageResult?.kind,
        message: result?.error?.diagnostic,
        diagnostic: result?.error?.diagnostic,
      });
      const described = describeInstallFailure(kind, { tag: entry.tag, version: entry.version });
      entry.error = {
        code: described.code,
        management: typeof result?.error?.code === 'string' ? result.error.code : null,
        message: described.message,
        diagnostic: summarizeDiagnostic(result?.error?.diagnostic),
        manual: described.manual,
        retryable: described.retryable,
      };
      return { ...entry };
    }
    entry.phase = 'done';
    entry.application = application;
    return { ...entry };
  }

  /**
   * Fail one request with a refusal decided **before** the manager was called
   * (a missing service, a 404 probe, an unavailable pnpm). Known-shaped
   * failures land here rather than in a thrown error, so the page always reads
   * the same structure.
   * @param requestId - the id to fail.
   * @param failure - `{code, message, diagnostic, manual, retryable}`.
   * @returns the settled entry view, or `null`.
   */
  function fail(requestId, failure = {}) {
    const entry = entries.get(typeof requestId === 'string' ? requestId : '');
    if (entry === undefined) return null;
    entry.settled = true;
    entry.phase = 'failed';
    entry.application = 'failed';
    entry.finishedAt = new Date(now()).toISOString();
    entry.error = {
      code: typeof failure.code === 'string' ? failure.code : INSTALL_FAILURE_UNKNOWN,
      management: null,
      message: typeof failure.message === 'string' ? failure.message : 'the install failed',
      diagnostic: summarizeDiagnostic(failure.diagnostic),
      manual: failure.manual ?? {
        releaseUrl: releasePageForTag(entry.tag),
        releaseLink: 'open this repository\u2019s releases page',
      },
      retryable: failure.retryable !== false,
    };
    return { ...entry };
  }

  /**
   * The oldest live request, or `null` — the read a *fresh page* makes.
   *
   * A browser that reloads mid-install has no `requestId` in memory, and the
   * session mirror can be gone (a new tab, a cleared store). Asking the host
   * "is anything installing?" is one request that either resumes the page's
   * polling or returns `null`, and it can only ever name a request this mount
   * started itself. The **oldest** live row is returned, so the answer cannot
   * flip between calls while more than one is somehow live.
   * @returns the entry view, or `null`.
   */
  function oldestLive() {
    for (const entry of entries.values()) {
      if (isLiveInstallPhase(entry.phase)) {
        return { ...entry, cancellable: true, known: true };
      }
    }
    return null;
  }

  return {
    begin,
    read,
    active,
    oldestLive,
    settle,
    fail,
    markCancelling,
    /** The live entry count — asserted by the tests, never by the route. */
    size: () => entries.size,
    /** Every entry, oldest first (tests and diagnostics). */
    list: () => [...entries.values()].map((entry) => ({ ...entry })),
  };
}

/**
 * The public shape of one install request, exactly as the route returns it.
 *
 * `status` is the phase under the name the client's three-state marker uses
 * (`running` covers both `installing` and `cancelling`), and the two flags tell
 * the page what it may still do: `cancellable` while the install has not reached
 * the apply step, and `restartRequired` once the code is on disk but not in the
 * running process. Every field is present on every answer, including the
 * synthetic unknown-request one, so a client never has to guess a shape.
 * @param entry - an entry view from the table.
 * @returns the response body.
 */
export function publicInstallStatus(entry) {
  const row = entry !== null && typeof entry === 'object' ? entry : {};
  const phase = typeof row.phase === 'string' ? row.phase : 'unknown';
  const status = phase === 'installing' || phase === 'cancelling' ? 'running' : phase;
  return {
    requestId: typeof row.requestId === 'string' ? row.requestId : null,
    phase,
    status,
    known: row.known !== false,
    application: typeof row.application === 'string' ? row.application : null,
    version: typeof row.version === 'string' ? row.version : null,
    tag: typeof row.tag === 'string' ? row.tag : null,
    startedAt: typeof row.startedAt === 'string' ? row.startedAt : null,
    finishedAt: typeof row.finishedAt === 'string' ? row.finishedAt : null,
    cancelRequested: row.cancelRequested === true,
    cancellable: isLiveInstallPhase(phase),
    restartRequired: row.application === 'restart-required',
    installed: row.application === 'applied' || row.application === 'restart-required',
    error: row.error ?? null,
  };
}

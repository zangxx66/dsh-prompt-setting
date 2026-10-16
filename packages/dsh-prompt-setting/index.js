/**
 * `dsh-prompt-setting` — Host half.
 *
 * Owns the `/prompt-setting` route prefix and the `system-prompt/assemble`
 * override engine, on top of stage 1A's read-only probe (whose behaviour is
 * unchanged).
 *
 * Shape of the host half:
 * - `core/overrides.js` holds ALL of the logic as pure functions (validated
 *   config, layer merge, section transform, `complete` derivation, render).
 * - `core/store.js` is the only module touching the filesystem, and it is off
 *   the assembly path: layers are read at mount and refreshed at the start of
 *   every route request, then held in memory. Both layers are refreshed at the
 *   same point, so an external edit — a hand edit, a config-sync tool, another
 *   process — reaches the next request whichever layer it touched, and a
 *   request that fails still leaves the cache no further behind than that.
 *   It also reads this package's own `client.js` for the ping's `clientBuild`
 *   stamp — that read is the one deliberate exception to "held in memory", and
 *   it is re-done per request on purpose (CONTRACT.md §14).
 * - `core/build.js` is pure text (no IO): the marker region and the digest the
 *   browser half re-computes for itself.
 * - `core/custom.js` is pure policy (no IO): the reserved section this plugin
 *   registers and the write lock that narrows every write route to it
 *   (Revision 7).
 * - this file is the adapter: one registered prompt section, two waterfall
 *   listeners and sixteen REST paths. The eighth (g-030) is the upstream update
 *   check and its on/off switch; its policy is `core/update.js` (pure, with the
 *   transport and the clock injected) and its one byte of state lives in
 *   `preferences.json` through `core/store.js`. The last three (g-060,
 *   Revision 37) are the preset library — the user's own catalogue of texts for
 *   the reserved section, its policy in `core/presets.js` (pure) and its file
 *   `presets.json` again through `core/store.js` (CONTRACT.md §20).
 *
 * The listeners read memory only. The override listener records the
 * pre-waterfall sections (the `base` view and the frozen probe) before
 * delegating with `next()`, then applies this plugin's overrides on top of the
 * downstream result and, when this assembly's switch is ON, expands the reserved
 * section's `{{name}}` references itself — so it never vetoes another listener,
 * and the untouched assembly is returned by identity when no override applies.
 * The second listener (Revision 8) is registered `{prepend: true}` so it is the
 * outermost one, and its only act is to move the reserved section to the end
 * when it carries text and is not already there — by reference otherwise.
 *
 * Revision 15 (design A) is why the expansion lives in the first listener rather
 * than the outermost one: the reserved section is registered `interpolate: false`
 * and stays that way, so DSH's strict interpolator never sees the text and no
 * assembly can fail because of it. The expansion is lenient — an unresolvable
 * reference stays literal — and position-independent: a listener outer to this
 * one that rewrites the sections costs at most an unexpanded turn.
 *
 * No DSH Host package is imported: the Host APIs used are the `systemPrompt`,
 * `webServer` and `connection` services read off `ctx`, plus an optional
 * `workspaceRegistry` lookup.
 *
 * @module dsh-prompt-setting
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compatibilityVerdict,
  detectDshVersion,
  firstCauseLine,
  mountFailureMessage,
} from './core/compat.js';
import {
  CUSTOM_SECTION_NAME,
  CUSTOM_SECTION_ORDER,
  assertDeletableName,
  assertWritableSection,
  customSection,
  exportScope,
  legacyPlan,
  reservedSectionLast,
} from './core/custom.js';
import {
  CHANGE_NOTICE,
  FIRST_NOTICE,
  configuredTextOf,
  createAssemblyWatch,
  sectionTextOf,
} from './core/assembly-watch.js';
import { EXPERIMENTS } from './core/experiments.js';
import {
  INSTALL_REQUEST_LIMIT,
  REFUSAL_ASSET_MISSING,
  REFUSAL_ASSET_UNVERIFIED,
  REFUSAL_INVALID_REQUEST,
  REFUSAL_SERVICE_MISSING,
  classifyInstallFailure,
  createInstallTable,
  describeInstallFailure,
  isAlreadyInstalledOn,
  publicInstallStatus,
  resolveInstallPolicy,
  resolveInstallTarget,
  summarizeDiagnostic,
} from './core/install.js';
import { launchKindOf } from './core/launch-kind.js';
import { buildDiff } from './core/diff.js';
import {
  INTERPOLATE_STATES,
  anyStatesOn,
  assertInterpolatable,
  customTextOf,
  describeInterpolateErrors,
  describeWarnings,
  effectiveInterpolate,
  expandPromptText,
  lintPromptText,
  switchStateOf,
  withState,
} from './core/interpolate.js';
import {
  DEFAULT_HISTORY_PAGE,
  LEGACY_CLEAR_ACTION,
  RESET_ACTION,
  ROLLBACK_ACTION,
  actionOf,
  publicRecord,
  queryHistory,
  resolveHistoryLimit,
  resolvePageLimit,
  resolvePageOffset,
  resetEntries,
  rollbackOverrides,
  snapshotOfConfig,
  textEntry,
} from './core/history.js';
import {
  ACTIONS,
  LAYERS,
  MAX_NAME_LENGTH,
  OverrideError,
  applyOverrides,
  buildBase,
  buildEffective,
  completeFlags,
  detectFrozen,
  emptyConfig,
  fail,
  interpolateFlagOf,
  mergeLayers,
  probeConfig,
  renderSections,
  sameSections,
  validateConfig,
  validateOverride,
  withInterpolate,
} from './core/overrides.js';
import {
  appliedRootsOf,
  planApply,
  planPresetRemoval,
  planUnapply,
  presetById,
  publicApplied,
  publicPresets,
  reservedSectionOf,
  upsertPreset,
  validatePresetId,
  validatePresetInput,
} from './core/presets.js';
import {
  appendHistoryRecord,
  clientBuildInfo,
  historyPath,
  readConfig,
  readHistoryFile,
  readPreferences,
  readPresets,
  removeOverride,
  upsertOverride,
  userConfigPath,
  userPreferencesPath,
  userPresetsPath,
  workspaceConfigPath,
  writeConfig,
  writeDocumentsAtomically,
  writePreferences,
  writePresets,
} from './core/store.js';
import {
  ASSEMBLY_NOTICE_DEFAULT,
  ASSEMBLY_NOTICE_FLAG,
  DOWNLOAD_REGION_DEFAULT,
  REGION_PROBE_TIMEOUT_MS,
  REGISTRY_CHECK_TIMEOUT_MS,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_CHECK_TTL_MS,
  createDownloadRegion,
  createUpdateChecker,
  isDownloadRegion,
  normalizePreferences,
  resolveDownloadRegion,
} from './core/update.js';
import {
  EXPORT_LAYERS,
  buildExport,
  parseExport,
  planImport,
  publicPlan,
  resolveMode,
  totalCounts,
} from './core/transfer.js';

/** Package name; echoed by the probe so the browser can assert identity. */
const PLUGIN_NAME = 'dsh-prompt-setting';
/** Package version; `test/host.test.mjs` asserts it matches package.json. */
const PLUGIN_VERSION = '0.2.2';
/** The one prefix this plugin owns. Every route lives under it. */
const ROUTE_PREFIX = '/prompt-setting';
/** Stage 1A's route: a read-only liveness probe (behaviour frozen). */
const PING_PATH = `${ROUTE_PREFIX}/ping`;
/**
 * The bundle this Host publishes, resolved from this module's own URL — never
 * from `cwd` and never from client input. Resolved once (it is a property of
 * this installed package, not of a request); the **bytes** are re-read on every
 * ping, which is what makes the reported stamp current.
 */
const CLIENT_BUNDLE_PATH = fileURLToPath(new URL('./client.js', import.meta.url));
/** Stage 1B: the assembly snapshot. */
const SNAPSHOT_PATH = `${ROUTE_PREFIX}/snapshot`;
/** Stage 1B: read/write/delete the two override layers. */
const OVERRIDES_PATH = `${ROUTE_PREFIX}/overrides`;
/** Stage 2: the bounded change log of one layer. */
const HISTORY_PATH = `${ROUTE_PREFIX}/history`;
/** Stage 2: compare two versions of one layer. */
const DIFF_PATH = `${ROUTE_PREFIX}/diff`;
/**
 * g-039 (Revision 21): move one layer back to a recorded version.
 *
 * `POST` rather than `PUT`/`DELETE` because it is neither an upsert nor a
 * removal: it replaces a whole layer with a state the log already describes,
 * and appends a record of its own. The body carries `{layer, session?,
 * workspace?, seq}` — the same scope vocabulary `GET /history` and `GET /diff`
 * read, plus the version to restore.
 */
const ROLLBACK_PATH = `${ROUTE_PREFIX}/rollback`;
/** Stage 2: one layer (or both) as a portable JSON document. */
const EXPORT_PATH = `${ROUTE_PREFIX}/export`;
/** Stage 2: apply such a document, atomically. */
const IMPORT_PATH = `${ROUTE_PREFIX}/import`;
/**
 * Revision 9: read and write the「我的 Prompt」interpolation switch. It is its
 * own route rather than a field on `PUT /overrides` because the switch is a
 * **config-level** fact, not a property of any one override: the existing PUT
 * body is a frozen stage 1B contract (`{layer, section, session}`), and adding a
 * field to it would make an old client's save silently turn the switch off.
 */
const INTERPOLATE_PATH = `${ROUTE_PREFIX}/interpolate`;
/**
 * g-030: the upstream update check **and** its on/off switch.
 *
 * Both live on one path because they are one question asked twice: `GET` answers
 * "is there a newer release, and is checking even on", `PUT {enabled}` records
 * the preference. Keeping the switch on its own path would have cost the page an
 * extra round trip on every mount for a boolean the answer already carries.
 */
const UPDATE_CHECK_PATH = `${ROUTE_PREFIX}/update-check`;
/**
 * g-032: 「立即更新」— install the release the update check just named, through
 * the official `pluginManager`, and **never** restart anything.
 *
 * One path, two methods, plus a cancel path:
 *   - `POST /update-apply` starts an install and answers `{ok, requestId}`
 *     immediately. It may not await the install: one run can block for the
 *     profile lock (~2 min) plus pnpm's silence timeout (10 min), and a settings
 *     page cannot hold a request open for that;
 *   - `GET /update-apply?requestId=` reports the tracked phase, because the
 *     official manager **deletes** a settled request — the state the page polls
 *     has to live here (see `core/install.js`);
 *   - `POST /update-apply/cancel` stops a running install.
 *
 * The install target is a release **tarball asset**, derived from the same
 * update check the banner reads (`core/update.js`'s `check()`, so a cached
 * answer costs zero outbound requests). `approvedBuilds` is never passed.
 */
const UPDATE_APPLY_PATH = `${ROUTE_PREFIX}/update-apply`;
/** The cancel face of the same request. Its own path, so the method table stays explicit. */
const UPDATE_APPLY_CANCEL_PATH = `${ROUTE_PREFIX}/update-apply/cancel`;
/**
 * g-043: 「下载区域」— the update source the user picks, and the first-visit
 * availability detection that decides it.
 *
 * One path, two methods, and they are two different questions about one setting:
 *   - `GET` answers 「which region is in force, and what address does it ask」.
 *     With nothing stored it also **decides** — asking npmjs whether it can
 *     serve *this package*, then npmmirror — and writes the verdict as an
 *     explicit choice, flagged `detected:true` so the page can say it was
 *     automatic (§17.9). A read is a read: no stored region means the probe runs,
 *     but the page never waits for it to paint (the answer arrives on its own
 *     request);
 *   - `PUT {region, registry?}` records the choice. A `custom` address is
 *     **validated before anything is written** — format, then one `GET` of the
 *     package document — and every kind of failure leaves the effective source
 *     exactly where it was and answers `200 {ok:false, code}` for the dialog's
 *     red line. Only the `region` enum itself is a 400 (`invalid-region`): that
 *     is a body-shape fact, while an address is *content* under validation, one
 *     class of which is decided by a network round trip.
 */
const DOWNLOAD_REGION_PATH = `${ROUTE_PREFIX}/download-region`;
/**
 * g-060 (Revision 37): the preset library — the user's own catalogue of
 * `{action, text}` pairs for the reserved section.
 *
 * Three paths, and the split is the whole design:
 *   - `GET|PUT|DELETE /presets` is the **catalogue**: list, upsert one preset
 *     (`PUT`; `DELETE ?id=`) — it never touches a layer;
 *   - `POST /presets/apply` is the **write**: it takes `{presetId, session}`,
 *     snapshots what that workspace layer holds now, writes the preset's text
 *     into the reserved section, and records the pair;
 *   - `POST /presets/unapply` is the **restore**: it puts that workspace layer
 *     back to the snapshot it took, and drops the record.
 *
 * `apply`/`unapply` are `POST` because they are neither an upsert of the
 * library nor a removal from it: they act on a **layer**, named by a session,
 * through the same write path `PUT /overrides` uses. The library itself is
 * per-installation (`<DSH_HOME>/prompt-setting/presets.json`), which is why the
 * catalogue routes carry no layer or session at all.
 */
const PRESETS_PATH = `${ROUTE_PREFIX}/presets`;
/** g-060: apply one preset to the workspace that owns a session. */
const PRESETS_APPLY_PATH = `${ROUTE_PREFIX}/presets/apply`;
/** g-060: restore the workspace layer to the snapshot `apply` took. */
const PRESETS_UNAPPLY_PATH = `${ROUTE_PREFIX}/presets/unapply`;
/**
 * g-062: the「装配状态提示」— did the prompt this plugin set get assembled, and
 * did that text enter the model request?
 *
 * One path, two methods, and they are two different questions about one feature:
 *   - `GET ?session=<id>` answers the **observation**: the last key-node notice
 *     of that session (first assembly of a new conversation / the next run after
 *     a save), each with its assembly-layer and delivery-layer verdicts, plus the
 *     switch's current state. A read never writes a notice and never probes: an
 *     unknown session answers `record: null`, not an error;
 *   - `GET ?since=<seq>` answers the **incremental feed**: the notices born after
 *     that cursor, newest last, each tagged with its session. This is the channel
 *     the shell-overlay toaster reads: it has no session in hand (it lives outside
 *     the settings page) and it must never replay a notice it already showed, so
 *     the cursor — not a re-read of the same record — is what makes "once per key
 *     node" hold on the client too. An absent or malformed cursor means "start
 *     from now" (the current cursor and `bootId` come back with no notices), a
 *     cursor from another mount (`bootId`) is answered the same way, and a cursor
 *     older than the retained log is answered `stale: true` with the newest
 *     notice only;
 *   - `PUT {enabled}` records the switch in `preferences.json` (the same
 *     document the update check uses). Turning it off silences the notices; it
 *     does not stop the (side-effect-free) observation on the assembly path.
 *
 * Nothing here reaches the model: the notice is rendered in the settings page and
 * in a shell-overlay toast, it costs no tokens and it never changes the prompt an
 * assembly returns.
 */
const ASSEMBLY_STATUS_PATH = `${ROUTE_PREFIX}/assembly-status`;
/** Method table; a known path with any other method is a 405 carrying `allow`. */
const ROUTES = new Map([
  [PING_PATH, ['GET']],
  [SNAPSHOT_PATH, ['GET']],
  [OVERRIDES_PATH, ['GET', 'PUT', 'DELETE']],
  [HISTORY_PATH, ['GET']],
  [DIFF_PATH, ['GET']],
  [ROLLBACK_PATH, ['POST']],
  [EXPORT_PATH, ['GET']],
  [IMPORT_PATH, ['POST']],
  [INTERPOLATE_PATH, ['GET', 'PUT']],
  [UPDATE_CHECK_PATH, ['GET', 'PUT']],
  [UPDATE_APPLY_PATH, ['GET', 'POST']],
  [UPDATE_APPLY_CANCEL_PATH, ['POST']],
  [DOWNLOAD_REGION_PATH, ['GET', 'PUT']],
  [PRESETS_PATH, ['GET', 'PUT', 'DELETE']],
  [PRESETS_APPLY_PATH, ['POST']],
  [PRESETS_UNAPPLY_PATH, ['POST']],
  [ASSEMBLY_STATUS_PATH, ['GET', 'PUT']],
]);
/**
 * How long the host waits for the release-asset probe before installing anyway.
 *
 * The probe answers "is the asset really there" in one `HEAD`, which is what
 * turns the *expected* failure of a release published without an asset into a
 * named `asset-missing` in seconds instead of a two-minute pnpm round trip. A
 * probe that does not answer in time is **not** a refusal: the install is
 * attempted and whatever pnpm says is the answer.
 */
const UPDATE_ASSET_PROBE_TIMEOUT_MS = 10 * 1000;
/** Cap on a PUT body, matching the 200 KiB per-override text cap with headroom. */
const MAX_BODY_BYTES = 256 * 1024;
/**
 * Cap on an import body. An export carries every override of both layers with
 * full text, so it is legitimately larger than a single-override PUT; the cap
 * still exists, and exceeding it is the existing `413 body-too-large`.
 */
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
/**
 * This plugin's private probe scope, used when the snapshot has no session.
 *
 * It is a plain object with no scoped registrations, so
 * `assemble({scope: PROBE_SCOPE})` resolves exactly the global sections — but
 * unlike an unscoped `assemble()` it is a scope key ONLY this module can hold.
 * That uniqueness is what lets the one-shot probe config be matched by exact
 * object identity without any other caller being able to collide with it.
 *
 * Exported for the equivalence assertion in `test/integration.test.mjs`; it is
 * not part of the plugin's API and nothing else should pass it to `assemble`.
 */
export const PROBE_SCOPE = Object.freeze({});
/**
 * The per-mount record key for an assembly that carries no scope at all.
 * A module-level string is safe here (it is only a Map key), and it is never
 * used to match a probe: probes always carry an Agent or {@link PROBE_SCOPE}.
 */
const UNSCOPED_KEY = 'unscoped';

/**
 * Required Host services. `systemPrompt` is a hard dependency: without it the
 * override engine cannot exist, so the Loader must not start this plugin.
 * `workspaceRegistry` is deliberately NOT here — it is looked up optionally,
 * so the user layer keeps working in a profile that has no workspace service.
 */
export const inject = ['webServer', 'connection', 'systemPrompt'];

/**
 * This module's directory: the module-relative anchor of the version probe
 * (the anchor that works when DSH is an ancestor or a real, non-optional
 * dependency).
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** This package's own manifest — the single source of the tested range. */
const OWN_MANIFEST_URL = new URL('./package.json', import.meta.url);
/**
 * The range used when this package's manifest cannot be read. It exists so the
 * boot check can never fail on IO; `test/boot.test.mjs` asserts it is *equal* to
 * `peerDependencies['@deepseek-ai/dsh']` in `package.json`, so the two cannot
 * drift apart silently.
 *
 * Every `||` alternative after the first exists for **strict** `node-semver`
 * (npm/pnpm peer resolution, *without* `includePrerelease`), which refuses a
 * prerelease unless some comparator **in the same alternative** names that very
 * `[major, minor, patch]` tuple with a prerelease of its own. The first branch's
 * only prerelease comparator is `0.1.7-rc.2` (tuple `0.1.7`), so it cannot admit
 * any `0.2.x` prerelease on its own; **each 0.2.x minor therefore needs its own
 * branch**, with a lower bound at that tuple's smallest prerelease. Under every
 * parser those branches also carry the range past the matching release
 * (`<0.2.0` on its own stops one version short of `0.2.0`). This plugin's own
 * parser implements no prerelease exclusion, so for it each added branch is
 * numerically a superset extension. The platform's own gate passes
 * `includePrerelease: true`, so there a prerelease merely has to fall inside
 * some branch numerically — which is why a new minor needs a new branch rather
 * than a widened bound on an earlier one.
 *
 * A branch's lower bound must be the **smallest** prerelease of its tuple
 * (`0.2.0-0`, `0.2.1-0`, …): strict semver whitelists the tuple, it does not
 * rank it, so a higher bound such as `>=0.2.1-alpha` would put `0.2.1-0` — and
 * with it every other `0.2.1` prerelease below `alpha` — out of range.
 *
 * The **final** upper bound is `<0.2.2-0`, not `<0.2.1-0` (NOTES.md §124). The
 * platform's boot gate judges each profile bundle against this range and
 * **skips the whole bundle** when it fails (`dsh-app-boot`: `skipping profile
 * bundle … is incompatible with dsh …`), before a single line of this package
 * is imported — so its own self-check cannot help. That is exactly what happened
 * on DSH `0.2.1-alpha.2`: the plugin vanished from the profile and the platform
 * refused to install it at all. `0.2.1` and every `0.2.1` prerelease are in;
 * `0.2.2-0` and everything after it are out, because a new minor is unverified
 * until a new decision says otherwise.
 * See NOTES.md §98, §99, §100 and §124.
 */
export const DSH_PEER_RANGE_FALLBACK = '>=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.1-0 || >=0.2.1-0 <0.2.2-0';

/**
 * The DSH range this plugin was tested against, read from its own manifest at
 * import time. Never throws: an unreadable manifest falls back to
 * {@link DSH_PEER_RANGE_FALLBACK}.
 */
export const DSH_PEER_RANGE = readDshPeerRange();

/**
 * @returns the peer range, or the pinned fallback.
 */
function readDshPeerRange() {
  try {
    const manifest = JSON.parse(readFileSync(OWN_MANIFEST_URL, 'utf8'));
    const range = manifest?.peerDependencies?.['@deepseek-ai/dsh'];
    if (typeof range === 'string' && range.trim().length > 0) return range.trim();
  } catch {
    // Fall through: a probe must never be the reason a boot fails.
  }
  return DSH_PEER_RANGE_FALLBACK;
}

/**
 * This package's public repository URL, read once from its own manifest — the
 * same single source {@link DSH_PEER_RANGE} uses. The settings page turns it
 * into the link beside the version (Revision 17), so it is reported by the ping
 * rather than written into the client: one manifest field, one place to edit.
 *
 * Never throws. An unreadable manifest, or one without a usable field, answers
 * `null`, which the ping reports as-is and the page renders as plain text.
 */
const OWN_REPOSITORY_URL = readOwnRepositoryUrl();

/**
 * @returns this package's repository URL, or `null`.
 */
function readOwnRepositoryUrl() {
  try {
    return repositoryUrlOf(JSON.parse(readFileSync(OWN_MANIFEST_URL, 'utf8')));
  } catch {
    // Fall through: no probe may be the reason a boot fails.
  }
  return null;
}

/**
 * The repository URL a manifest declares, in npm's own order of authority:
 * `repository.url`, then a bare `repository` string, then `homepage` with its
 * `#…` fragment dropped.
 *
 * `git+https://….git` is how a manifest names a *git remote*; neither the
 * `git+` prefix nor the trailing `.git` belongs in the address a reader opens,
 * so both are stripped from the first two sources (after any trailing slash,
 * which is the same address written differently). A `homepage` is a page
 * already, so only its fragment is removed.
 *
 * What is returned must be an `http(s)` address: an SSH spelling is **not**
 * rewritten (guessing a different address is worse than admitting there is
 * none), it falls through to `homepage` and then to `null`. The client then
 * shows the version as plain text rather than a link to nowhere
 * (CONTRACT.md §13.8).
 * @param manifest - a parsed `package.json`, or anything else.
 * @returns an `http(s)` repository URL, or `null`.
 */
export function repositoryUrlOf(manifest) {
  const repository = manifest !== null && typeof manifest === 'object' ? manifest.repository : null;
  const declared =
    repository !== null && typeof repository === 'object'
      ? repository.url
      : typeof repository === 'string'
        ? repository
        : null;
  const git = asGitAddress(declared);
  if (git !== null) return git;
  const homepage = manifest !== null && typeof manifest === 'object' ? manifest.homepage : null;
  if (typeof homepage === 'string') {
    const page = homepage.split('#')[0].trim();
    if (isHttpAddress(page)) return page;
  }
  return null;
}

/**
 * A `repository` value as the address a reader can open, or `null`.
 *
 * The cleaning is deliberately narrow, because every step here rewrites what the
 * manifest said:
 *   - a trailing slash is folded away first (`…​.git/` is the same address as
 *     `…​.git`), which is what lets the `.git` test below reach it at all;
 *   - the `git+` prefix and a trailing `.git` are git decoration, not address;
 *   - what remains must be `http://` or `https://`. An SSH spelling
 *     (`git@github.com:a/b.git`, `ssh://…`) is **not** rewritten into https —
 *     that would be guessing a different address — and a non-web scheme would
 *     hand the reader a link the browser refuses to follow. Both answer `null`,
 *     which lets the manifest's `homepage` (or plain text) answer instead.
 * @param value - the manifest's `repository.url`, or a bare `repository`.
 * @returns the cleaned http(s) URL, or `null`.
 */
function asGitAddress(value) {
  if (typeof value !== 'string') return null;
  let url = value.trim();
  while (url.endsWith('/')) url = url.slice(0, -1);
  if (url.startsWith('git+')) url = url.slice('git+'.length);
  if (url.endsWith('.git')) url = url.slice(0, -'.git'.length);
  return isHttpAddress(url) ? url : null;
}

/**
 * Whether a string is an address a browser will actually open.
 * @param value - the candidate URL.
 * @returns `true` for `http://` and `https://` only.
 */
function isHttpAddress(value) {
  return value.startsWith('http://') || value.startsWith('https://');
}

/**
 * Run the import-time compatibility self-check and print **at most one** line.
 *
 * Silent while the installed DSH is inside the tested range — a plugin that
 * talks on every boot is worse than a silent one; one readable line when the
 * version is outside it or could not be detected. It needs **no injected
 * service and no `ctx`**, which is exactly why it runs here: the one failure the
 * plugin can never catch from the inside is a missing `inject` service (then
 * `apply` is never called at all — NOTES.md §91 boundary ①).
 *
 * Never throws: the probe and the logger are both guarded, and every
 * collaborator is injectable so all three branches are asserted offline.
 * @param options.detect - detection function (tests); defaults to
 *   {@link detectDshVersion} anchored at this module.
 * @param options.log - sink for the one warning (tests); defaults to
 *   `console.warn`.
 * @param options.expectedRange - range override (tests).
 * @returns the verdict `{level, version, message, reason}` with `level` one of
 *   `ok` | `out-of-range` | `undetected`.
 */
export function reportBootCompatibility(options = {}) {
  const detect = options.detect ?? (() => detectDshVersion({ moduleDir: MODULE_DIR }));
  const log = options.log ?? ((message) => {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(message);
  });
  let detection;
  try {
    detection = detect() ?? {};
  } catch (error) {
    detection = { version: null, reason: `probe threw: ${firstCauseLine(error)}` };
  }
  const verdict = compatibilityVerdict({
    pluginName: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    expectedRange: options.expectedRange ?? DSH_PEER_RANGE,
    detection,
  });
  if (verdict.message !== null) {
    try {
      log(verdict.message);
    } catch {
      // A logger that throws is not a reason to take the harness down with us.
    }
  }
  return verdict;
}

/**
 * The import-time self-check, run once per process — the deliverable of g-013
 * that has to work even when nothing else about this plugin runs. Guarded
 * twice on purpose: `reportBootCompatibility` swallows probe/logger failures,
 * and this wrapper swallows anything else (including a bug in the checker).
 */
export const BOOT_COMPAT = bootSelfCheck();

/**
 * @returns the verdict, or a silent `undetected` verdict when the check itself
 *   broke.
 */
function bootSelfCheck() {
  try {
    return reportBootCompatibility();
  } catch (error) {
    return { level: 'undetected', version: null, reason: firstCauseLine(error), message: null };
  }
}


/**
 * Write one JSON response. `no-store`: every answer here is a live fact.
 * @param res - the Node response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  // g-032: an install route answers its `POST` **before** its background work
  // settles, and that work can still be running when the client disconnects. A
  // write to an already-finished response throws, which would turn a completed
  // answer into a 5xx; the guard makes the late write a no-op instead.
  if (res.writableEnded === true || res.headersSent === true) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * 405 carrying the route's supported methods.
 * @param res - the Node response.
 * @param allow - the supported method names.
 */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405;
  res.setHeader('allow', allow);
  res.end();
}

/**
 * Answer an untrusted/unauthenticated request before any route logic runs —
 * the same fence `dsh-host-open-in-app` puts in front of its routes.
 * @param ctx - the Host plugin context.
 * @param req - the Node request.
 * @param res - the Node response.
 * @returns true when the request was already rejected and the handler must stop.
 */
function rejected(ctx, req, res) {
  const connection = Reflect.get(ctx, 'connection');
  if (connection === undefined || connection === null) {
    // Fail closed: without the fence we cannot tell a browser request from
    // anything else, so refuse rather than serve anything unauthenticated.
    sendJson(res, 503, {
      code: 'trust-fence-unavailable',
      message: 'the connection service is not available',
    });
    return true;
  }
  const rejection = connection.requestRejection(req);
  if (rejection === undefined) return false;
  res.statusCode = rejection;
  res.end();
  return true;
}

/**
 * Resolve the request URL. A prefix route receives the full URL, so the
 * dispatcher resolves it against a throwaway origin.
 * @param req - the Node request.
 * @returns the parsed request URL.
 */
function requestUrl(req) {
  return new URL(String(req.url ?? '/'), 'http://localhost');
}

/**
 * The renderer values the browser half may report. A whitelist — not a free
 * text field: the report is observational, so anything outside this set is
 * ignored rather than becoming an arbitrary-data injection point.
 */
const CLIENT_RENDERERS = new Set(['primitives', 'fallback']);

/**
 * Record the renderer the browser reports, when it is one of the accepted
 * values. Absent, repeated or unknown values leave the last report untouched,
 * and this never influences the response status.
 * @param report - the mutable per-mount report holder.
 * @param url - the parsed request URL.
 */
function recordClientRenderer(report, url) {
  const reported = url.searchParams.get('renderer');
  if (reported === null || !CLIENT_RENDERERS.has(reported)) return;
  report.renderer = reported;
  report.reportedAt = new Date().toISOString();
}

/**
 * Read and parse a JSON request body, with a hard size cap.
 * @param req - the Node request.
 * @param cap - the byte cap (defaults to the PUT cap).
 * @returns the parsed body (`{}` for an empty body).
 * @throws {OverrideError} on an over-large or unparsable body.
 */
async function readJsonBody(req, cap = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) {
      req.destroy?.();
      throw new OverrideError('body-too-large', `the request body exceeds ${cap} bytes`, 413);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new OverrideError('invalid-json', `the request body is not valid JSON: ${error?.message ?? String(error)}`);
  }
}

/**
 * Mount the probe route, the snapshot route, the override routes, the stage 2
 * history/diff/export/import routes and the assembly override listener.
 * @param ctx - the Host plugin context.
 * @param config - the loose plugin config. Only `historyLimit` is read, and an
 *   absent or unusable value falls back to {@link resolveHistoryLimit}'s
 *   default rather than failing the mount.
 */
export function apply(ctx, config) {
  /**
   * Disposers of everything this mount registered, in registration order. Kept
   * by this guard rather than inferred from the host: whatever a future DSH
   * does with a failed fiber (Cordis unloads it asynchronously; the Loader
   * swallows the rejection outright), *this* function decides, synchronously,
   * that a mount either registers everything or registers nothing.
   */
  const cleanups = [];
  try {
    mount(ctx, config, cleanups);
  } catch (error) {
    reportMountFailure(ctx, error, cleanups);
  }
}

/**
 * Register one effect and remember how to undo it, so a later step failing can
 * always roll the earlier ones back.
 * @param ctx - the Host plugin context.
 * @param cleanups - this mount's disposer list.
 * @param factory - the effect factory, exactly as `ctx.effect` takes it.
 * @param label - the effect label.
 * @returns the effect's own disposer.
 * @throws when the host does not hand back a disposer: an effect we cannot undo
 *   must fail the mount rather than stay half-mounted.
 */
function registerEffect(ctx, cleanups, factory, label) {
  const disposer = ctx.effect(factory, label);
  if (typeof disposer !== 'function') {
    throw new TypeError(`ctx.effect(${JSON.stringify(label)}) returned ${describeValue(disposer)} instead of a disposer`);
  }
  cleanups.push(disposer);
  return disposer;
}

/**
 * Guard a host service's return value: a disposer, or a thrown error.
 *
 * `webServer.register()` returns the function that removes the route, and the
 * whole "no half-mount" promise rests on that function existing. A breaking
 * change that returns anything else (or nothing) is reported through the
 * ordinary failure path instead of silently leaving a route nothing can remove.
 * @param value - the service's return value.
 * @returns the disposer.
 * @throws {TypeError} when the value is not a function.
 */
function disposerOf(value) {
  if (typeof value !== 'function') {
    throw new TypeError(`a host service returned ${describeValue(value)} instead of a disposer`);
  }
  return value;
}

/**
 * Name a value for a one-line diagnostic.
 * @param value - any value.
 * @returns e.g. `null`, `undefined`, `object`.
 */
function describeValue(value) {
  return value === null ? 'null' : typeof value;
}

/**
 * Report a failed mount: roll every registered effect back, then print exactly
 * one readable line.
 *
 * Rollback runs in reverse registration order — the last thing mounted is the
 * thing most likely to depend on the ones before it — and one failing disposer
 * never strands the rest. Never throws: a report that throws would *be* the
 * failure it reports.
 * @param ctx - the Host plugin context.
 * @param error - the thrown value.
 * @param cleanups - this mount's disposer list (emptied here).
 */
function reportMountFailure(ctx, error, cleanups) {
  let disposed = 0;
  let disposeFailures = 0;
  for (let index = cleanups.length - 1; index >= 0; index -= 1) {
    try {
      cleanups[index]();
      disposed += 1;
    } catch {
      disposeFailures += 1;
    }
  }
  cleanups.length = 0;
  logToHost(ctx, mountFailureMessage({
    pluginName: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    dshVersion: BOOT_COMPAT.version,
    cause: firstCauseLine(error),
    disposed,
    disposeFailures,
  }));
}

/**
 * Report one line on **both** channels that matter.
 *
 * 1. **The terminal (stderr)** — the channel the whole g-013 requirement is
 *    about, and one `ctx.logger` alone does **not** reach: the only exporter
 *    registered for `ctx.logger` in this profile is app-boot's, and it merely
 *    pushes `warn`/`error` into `startupLogs`
 *    (`dsh-app-boot/lib/index.js:4053-4060`), which is attached to a
 *    `StartupError` only when startup *fails* (`:4092`); cordis' own default
 *    exporter only buffers in memory (`cordis/lib/index.js:598-604`). That is
 *    why the platform's own activation warnings go straight to
 *    `process.stderr` (`dsh-app-boot/lib/index.js:3956-3963`, `:4008`) — and
 *    why a boot-visible message of ours has to do the same, or it is invisible.
 * 2. **`ctx.logger.error`** — the host's own log record (UI ring buffer,
 *    startup diagnostics), so a logger-aware host still sees a log line.
 *
 * The duplication this can produce on a host that *does* register a console
 * exporter is accepted deliberately: printing the line twice is a far smaller
 * failure than printing it nowhere (NOTES.md §91).
 * @param ctx - the Host plugin context (may be absent).
 * @param message - the single readable line.
 * @returns true when the host logger also took the line.
 */
function logToHost(ctx, message) {
  let logged = false;
  try {
    const logger = ctx === null || ctx === undefined ? undefined : ctx.logger;
    if (logger !== null && typeof logger === 'object' && typeof logger.error === 'function') {
      logger.error(message);
      logged = true;
    }
  } catch {
    // A logger that throws must not swallow the report; the terminal write
    // below is the one that always has to happen.
  }
  try {
    console.error(message);
  } catch {
    // Nothing left to report to; inventing a throw here would break the boot
    // this whole path exists to protect.
  }
  return logged;
}

/**
 * The injected transport and bounds for this mount's update checker (g-030).
 *
 * The plugin config is loose by design (only `historyLimit` was ever read from
 * it), and this adds one optional nested object rather than five new top-level
 * fields: `updateCheck: {fetch, registry, ttlMs, timeoutMs, now}`. Every piece is
 * optional and an unusable value is ignored, which is what keeps a profile that
 * declares nothing on the shipped defaults — and what lets `test/update.test.mjs`
 * drive the real route with a stub transport instead of the network.
 *
 * `registry` is g-042's one new slot: the npm registry base address the update
 * check asks first (default `https://registry.npmjs.org/`). It is a plain string
 * passthrough; the checker normalizes it and treats an unusable value as "do not
 * ask npm" (see `core/update.js`'s `normalizeRegistry`). g-043 wires the download
 * region / mirror choice into exactly this key.
 * @param config - the loose plugin config.
 * @returns the options `createUpdateChecker` accepts (transport/bounds only).
 */
function resolveUpdateOptions(config) {
  const declared = config !== null && typeof config === 'object' ? config.updateCheck : undefined;
  const source = declared !== null && typeof declared === 'object' ? declared : {};
  return {
    ...(typeof source.fetch === 'function' ? { fetch: source.fetch } : {}),
    ...(typeof source.registry === 'string' ? { registry: source.registry } : {}),
    ...(Number.isFinite(source.ttlMs) ? { ttlMs: source.ttlMs } : {}),
    ...(Number.isFinite(source.timeoutMs) ? { timeoutMs: source.timeoutMs } : {}),
    ...(typeof source.now === 'function' ? { now: source.now } : {}),
  };
}

/**
 * The injected transport and bounds for this mount's「下载区域」manager (g-043).
 *
 * The **transport is shared with the update checker** on purpose: a profile (or a
 * test) that injects one `updateCheck.fetch` must drive every outbound request
 * this plugin can make — the check, the install probe and now the region probe —
 * otherwise a stubbed test profile would still reach npmjs.org from the probe.
 * The three bounds have their own optional block (`downloadRegion:
 * {probeTimeoutMs, checkTimeoutMs, ttlMs}`) because they are different questions
 * from the check's cache and timeout; every one of them is optional and bounded
 * by `core/update.js` itself.
 * @param config - the loose plugin config.
 * @param updateOptions - the resolved update-check options (for `fetch` / `now`).
 * @returns the options `createDownloadRegion` accepts (transport/bounds only).
 */
function resolveRegionOptions(config, updateOptions) {
  const declared = config !== null && typeof config === 'object' ? config.downloadRegion : undefined;
  const source = declared !== null && typeof declared === 'object' ? declared : {};
  return {
    ...(typeof updateOptions.fetch === 'function' ? { fetch: updateOptions.fetch } : {}),
    ...(typeof updateOptions.now === 'function' ? { now: updateOptions.now } : {}),
    ...(Number.isFinite(source.probeTimeoutMs) ? { probeTimeoutMs: source.probeTimeoutMs } : {}),
    ...(Number.isFinite(source.checkTimeoutMs) ? { checkTimeoutMs: source.checkTimeoutMs } : {}),
    ...(Number.isFinite(source.ttlMs) ? { ttlMs: source.ttlMs } : {}),
  };
}

/**
 * Mount everything. Separated from {@link apply} so the guard has one call to
 * wrap and one list of disposers to unwind.
 * @param ctx - the Host plugin context.
 * @param config - the loose plugin config.
 * @param cleanups - this mount's disposer list.
 */
function mount(ctx, config, cleanups) {
  // Per-mount state. Deliberately not module-level: two mounts (or two test
  // cases) must never observe each other's reports, watermark or config cache.
  const report = { renderer: null, reportedAt: null };
  /**
   * Retention bound for every layer history file, resolved once per mount from
   * the plugin config then the environment (default 100, minimum 10).
   */
  const historyLimit = resolveHistoryLimit(config);
  /**
   * g-030: this mount's update checker — one cache, one preference file, one
   * injected transport. Per mount, like everything else in this object: two
   * mounts (or two test cases) must never share a cache, and a closed switch is
   * read from disk on every `check()` so a hand edit is honoured without a
   * restart.
   */
  const updatePreferencesPath = userPreferencesPath();
  /** Resolved once: the checker, this mount's install probe and the tests all read the same transport. */
  const updateOptions = resolveUpdateOptions(config);
  /**
   * The one reader both preferences consumers use. Read **per call**, never
   * cached: a hand edit of `preferences.json` and a write made by the sibling
   * route both have to be visible to the next request without a remount.
   */
  const readPreferenceDocument = () => readPreferences(updatePreferencesPath).preferences;
  /**
   * g-043: this mount's「下载区域」manager — the stored choice, the first-visit
   * detection and the custom-address validation. It shares the preference file
   * (and therefore the atomic write path) with the switch, and the transport with
   * the checker.
   */
  const downloadRegion = createDownloadRegion({
    probeTimeoutMs: REGION_PROBE_TIMEOUT_MS,
    checkTimeoutMs: REGISTRY_CHECK_TIMEOUT_MS,
    ...resolveRegionOptions(config, updateOptions),
    currentVersion: PLUGIN_VERSION,
    readPreferences: readPreferenceDocument,
    writePreferences: (next) => writePreferences(updatePreferencesPath, next),
  });
  /**
   * g-043: where the npm path points, resolved **per check** so a region switch
   * takes effect on the next one (the check cache is keyed by this same pair, so
   * a switch cannot be masked by a cached answer either).
   *
   * Precedence (§17.6): an operator-declared `updateCheck.registry` wins and
   * pins the base with the pre-g-043 fallback order; otherwise the stored
   * download region decides both the address and whether the GitHub fallback may
   * answer at all.
   */
  const declaredRegistry = typeof updateOptions.registry === 'string' ? updateOptions.registry : null;
  const effectiveRegion = () => (declaredRegistry === null ? resolveDownloadRegion(readPreferenceDocument()).region : DOWNLOAD_REGION_DEFAULT);
  const updateChecker = createUpdateChecker({
    // The shipped defaults are named here (and asserted in `core/update.js`'s own
    // tests) so the two numbers a reader looks for are greppable constants, while
    // anything the profile or a test injected still wins.
    ttlMs: UPDATE_CHECK_TTL_MS,
    timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
    ...updateOptions,
    ...(declaredRegistry === null
      ? { registry: () => resolveDownloadRegion(readPreferenceDocument()).registry, region: effectiveRegion }
      : {}),
    repositoryUrl: OWN_REPOSITORY_URL,
    currentVersion: PLUGIN_VERSION,
    readPreferences: readPreferenceDocument,
    writePreferences: (next) => writePreferences(updatePreferencesPath, next),
  });
  /**
   * g-032: this mount's install-request table and its probe transport.
   *
   * The table exists because the official manager does not retain a settled
   * install, and it is per mount for the same reason every other piece of state
   * here is: two mounts must never read each other's requests. The probe reuses
   * the checker's injected transport when a profile (or a test) provided one, so
   * a test that stubs the update check cannot accidentally reach the network
   * through the probe.
   */
  const installTable = createInstallTable({ limit: INSTALL_REQUEST_LIMIT });
  const installProbe =
    typeof updateOptions.fetch === 'function'
      ? updateOptions.fetch
      : typeof globalThis.fetch === 'function'
        ? globalThis.fetch
        : null;
  const state = {
    /**
     * User layer: read at mount and re-read at the start of every route
     * request, rewritten in memory by the save paths. `present` records that
     * the layer's file has been seen at least once, which is what lets a
     * *disappeared* file be reported instead of silently reading as "this
     * layer holds no overrides" (see {@link refreshUser}).
     */
    user: { path: userConfigPath(), config: emptyConfig(), error: null, present: false },
    /** Workspace layers by resolved root path; refreshed by the routes. */
    workspaces: new Map(),
    /** Last assembly observation per scope key: `{seq, registered, downstream}`. */
    records: new Map(),
    /**
     * Last history write failure per history file, keyed by path. A history
     * failure never changes a write's own response (the stage 1B PUT/DELETE
     * bodies are frozen), so this is where it becomes observable, through
     * `GET /history` as `lastError` (CONTRACT §8.4).
     */
    historyFailures: new Map(),
    /**
     * The config one in-flight probe must use, matched by the identity of the
     * `AssembleContext` object this plugin itself passed to `assemble()`. Only
     * this module can hold that object, so no other caller can collide with it.
     */
    pendingProbe: null,
    /**
     * The assembled variable table, or `null` when this mount has not obtained
     * one. Cached because the lookup costs one full `assemble()`; refreshed on
     * every **write** validation so a name registered later is never refused on
     * a stale reading.
     */
    variables: null,
    /** Why the last variable-table lookup failed, or `null`. */
    variablesError: null,
  };

  /**
   * g-062: this mount's assembly-status watch — the per-session record of the
   * last key-node notice (the first assembly of a new conversation, and the next
   * run after the user saved a new prompt), each carrying both verdicts.
   *
   * The switch is read **per notice**, never cached, for the same reason the
   * update switch is: a hand edit of `preferences.json` must be honoured on the
   * next run without a remount. The whole watch is an observer — nothing it
   * records can change the section list an assembly returns.
   */
  const assemblyWatch = createAssemblyWatch({
    sectionName: CUSTOM_SECTION_NAME,
    enabled: () => assemblyNoticeEnabled(),
  });

  /**
   * Is the g-062 notice switch on?
   *
   * Absent means on (`ASSEMBLY_NOTICE_DEFAULT`), and an unreadable document
   * fails open to on: the switch exists to silence a notice, not to break a
   * settings page or a turn.
   * @returns true when notices may be produced.
   */
  function assemblyNoticeEnabled() {
    try {
      return readPreferenceDocument()[ASSEMBLY_NOTICE_FLAG] !== false;
    } catch {
      return ASSEMBLY_NOTICE_DEFAULT;
    }
  }

  /**
   * Persist the g-062 switch.
   *
   * Merged into the current document, exactly like the update switch: an atomic
   * write replaces the whole file, so writing only this key would erase a stored
   * download region.
   * @param enabled - the requested state.
   * @returns `{written, enabled, error}`; a write failure is a value, never a throw.
   */
  function setAssemblyNotice(enabled) {
    const next = normalizePreferences({ ...readPreferenceDocument(), [ASSEMBLY_NOTICE_FLAG]: enabled === true });
    try {
      writePreferences(updatePreferencesPath, next);
    } catch (error) {
      const message = error instanceof Error ? String(error.message).split('\n')[0] : String(error);
      return {
        written: false,
        enabled: assemblyNoticeEnabled(),
        error: { code: 'preferences-unwritable', message },
      };
    }
    return { written: true, enabled: next[ASSEMBLY_NOTICE_FLAG] === true, error: null };
  }

  /**
   * The agent registry, or undefined when this profile has none.
   * @returns the service, or undefined.
   */
  function agentsService() {
    try {
      const service = ctx.get('agents');
      return service === undefined || service === null ? undefined : service;
    } catch {
      return undefined;
    }
  }

  /**
   * The live Agent that owns a session, which is also that session's scope key.
   * @param sessionId - the session id to look up.
   * @returns the Agent, or undefined when it is not active.
   */
  function agentFor(sessionId) {
    const agents = agentsService();
    if (agents === undefined || typeof agents.get !== 'function') return undefined;
    try {
      const agent = agents.get(sessionId);
      return agent !== null && typeof agent === 'object' ? agent : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The workspace registry, or undefined when this profile has none. Looked up
   * live rather than cached, so a service that activates later is picked up and
   * a profile without it simply disables the workspace layer.
   * @returns the service, or undefined.
   */
  function workspaceRegistry() {
    try {
      const service = ctx.get('workspaceRegistry');
      return service === undefined || service === null ? undefined : service;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve the workspace root that owns a session, using the Host's own
   * session index. No client-supplied path is ever consulted.
   * @param sessionId - the session id to resolve.
   * @returns `{root, reason}`; `root` is null when it cannot be resolved.
   */
  function workspaceRootFor(sessionId) {
    const registry = workspaceRegistry();
    if (registry === undefined || typeof registry.list !== 'function') {
      return { root: null, reason: 'the workspaceRegistry service is not available in this profile' };
    }
    let list;
    try {
      list = registry.list();
    } catch (error) {
      return { root: null, reason: `workspaceRegistry.list() failed: ${error?.message ?? String(error)}` };
    }
    const workspaces = Array.isArray(list) ? list : [];
    const owner = workspaces.find(
      (workspace) => Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId),
    );
    if (owner === undefined || typeof owner.path !== 'string' || owner.path.length === 0) {
      return { root: null, reason: `no workspace owns session ${JSON.stringify(sessionId)}` };
    }
    return { root: owner.path, reason: null };
  }

  /**
   * Read one workspace layer into the in-memory cache.
   *
   * Revision 15 (design A) removed the load-time interpolation self-check that
   * used to sit here: with the reserved section permanently `interpolate: false`
   * and the plugin's own expansion lenient, no stored text can break an
   * assembly, so there is nothing left to degrade a layer for. The file-level
   * rules are unchanged — an unreadable or invalid file still disables the layer
   * with its own reason (`readConfig`).
   * @param root - the resolved workspace root.
   * @returns the cached layer `{path, config, error}`.
   */
  function loadWorkspace(root) {
    const path = workspaceConfigPath(root);
    const read = readConfig(path);
    state.workspaces.set(root, { path, config: read.config, error: read.error });
    return state.workspaces.get(root) ?? { path, config: read.config, error: read.error };
  }

  /**
   * Re-read the user layer from disk into the in-memory cache.
   *
   * The user layer obeys the same rule as a workspace layer — a file that is
   * missing is an empty, enabled layer, which is the honest state of a profile
   * that has never been configured — with one addition: once this mount has
   * *seen* the file, its disappearance is reported as `missing-file` and the
   * layer contributes nothing, rather than degrading into "this layer has no
   * overrides". Either way a stale override can never survive on a file that
   * is no longer there.
   *
   * Never throws: an unreadable or invalid file disables this layer with a
   * reason (CONTRACT §5.6) and leaves every other layer alone.
   * @returns the refreshed user layer record.
   */
  function refreshUser() {
    const path = state.user.path;
    const read = readConfig(path);
    if (read.error !== null) {
      // Unreadable or invalid: keep no config at all, so this layer
      // contributes nothing to any assembly. `present` is sticky, so it stays
      // reported if the file is then deleted as well.
      state.user = { path, config: null, error: read.error, present: true };
      return state.user;
    }
    if (read.missing === true) {
      state.user = state.user.present
        ? {
          path,
          config: null,
          present: true,
          error: { code: 'missing-file', message: `${path} was removed after it had been read` },
        }
        : { path, config: read.config, error: null, present: false };
      return state.user;
    }
    state.user = { path, config: read.config, error: null, present: true };
    return state.user;
  }

  /**
   * Re-read every known workspace layer. Called at mount and at the start of
   * every route request — never from the assembly path, which only reads the
   * cache. This is what keeps `assemble` free of IO while still noticing a
   * workspace created after mount.
   * @returns the number of workspace layers inspected.
   */
  function refreshWorkspaces() {
    const registry = workspaceRegistry();
    if (registry === undefined || typeof registry.list !== 'function') return 0;
    let list;
    try {
      list = registry.list();
    } catch {
      return 0;
    }
    let count = 0;
    for (const workspace of Array.isArray(list) ? list : []) {
      if (typeof workspace?.path !== 'string' || workspace.path.length === 0) continue;
      loadWorkspace(workspace.path);
      count += 1;
    }
    return count;
  }

  /**
   * Probe the live assembly once and cache its variable table (Revision 9).
   *
   * One full `assemble()` under this plugin's own private scope is the only
   * honest source of "which `{{names}}` exist": the table is assembled per turn
   * from every registration in the profile, so a hard-coded list would be wrong
   * the moment another plugin registers a variable. Never throws — a profile
   * where the probe fails simply has no table, and the two callers treat that
   * differently on purpose ({@link ensureVariables} reports nothing, {@link
   * variablesForWrite} refuses).
   * @returns the table, or null when it could not be obtained.
   */
  async function refreshVariables() {
    try {
      const probed = await probe({ ...probeTarget(null), resolved: mergeLayers(emptyConfig(), null) });
      const table = probed.variables !== null && typeof probed.variables === 'object' ? probed.variables : {};
      state.variables = table;
      state.variablesError = null;
      return table;
    } catch (error) {
      state.variables = null;
      state.variablesError = error?.message ?? String(error);
      return null;
    }
  }

  /**
   * The cached variable table, obtained at most once per mount.
   *
   * The read face uses this: it must never fail a request, and a table it cannot
   * obtain only costs the "which names exist" half of `GET /interpolate`.
   * @returns the table, or null.
   */
  async function ensureVariables() {
    if (state.variables !== null) return state.variables;
    return refreshVariables();
  }

  /**
   * The variable table a **write** validation must use.
   *
   * Always freshly probed: a name registered after this mount started must never
   * be refused on a stale reading. A probe that fails is a `503`, never a silent
   * "nothing is registered" — the refusal would then be a lie about the user's
   * text rather than a statement about this process.
   * @returns the table.
   * @throws {OverrideError} `503 variable-lookup-failed`.
   */
  async function variablesForWrite() {
    const table = await refreshVariables();
    if (table === null) {
      throw fail(
        'variable-lookup-failed',
        `cannot verify prompt variables, so this write is refused: ${state.variablesError ?? 'the assembly probe failed'}`,
        503,
      );
    }
    return table;
  }

  /**
   * The cached workspace layer that owns one session, or null.
   *
   * Pure cache lookup plus the registry's session→workspace index: no file is
   * read here, so it is safe to call from a response path (and it is what keeps
   * the write response's `interpolateCustom` a statement about the post-write
   * cache rather than about a second read of disk).
   * @param sessionId - the request's session id, or null.
   * @returns the validated config, or null.
   */
  function workspaceConfigFor(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    const { root } = workspaceRootFor(sessionId);
    if (root === null) return null;
    return state.workspaces.get(root)?.config ?? null;
  }

  /**
   * The reserved section in one section list, or -1.
   * @param sections - a `PromptAssembly.sections` array.
   * @returns the index, or -1.
   */
  function reservedIndex(sections) {
    return Array.isArray(sections) ? sections.findIndex((section) => section?.name === CUSTOM_SECTION_NAME) : -1;
  }

  /**
   * Is one layer's「我的 Prompt」text **armed** — does it reach an assembly whose
   * effective switch is ON? (Revision 12, audit F1.)
   *
   * This is the F1 rule written as the question it actually is. Text is subject
   * to this plugin's expansion exactly when some assembly renders it *and* that
   * assembly's switch is ON, so the answer comes from the merge rule rather than
   * from the layer being written:
   * - the **user** text is merged into every session that carries no workspace
   *   entry of its own, so it is armed as soon as the user layer or any visible
   *   workspace states ON. Deliberately slightly conservative: a workspace that
   *   states ON *and* carries its own text does not in fact use the user's text,
   *   and the write is still refused — that is the audit's "write the user layer
   *   while a workspace is ON" case, and the cheap side of the trade;
   * - a **workspace** text is rendered only for that workspace's sessions, where
   *   {@link effectiveInterpolate} decides. An explicitly closed workspace (F4)
   *   is therefore the one configuration whose literal braces provably reach no
   *   expansion, and it is not refused.
   *
   * Revision 15 (design A) leaves this predicate and every write it refuses
   * exactly as they were, and changes only what the refusal *means*: an armed
   * reference that cannot resolve will never expand, so refusing it is UX, not
   * safety (CONTRACT §16.9).
   *
   * Judged on the **post-write** view ({@link visibleLayers}), so the change
   * being requested is what is decided, not what is on disk while it is decided.
   * @param next - the config the write target would hold, or null for the cache.
   * @param target - the resolved write target from {@link targetFor}, or null.
   * @returns the armed entries of the post-write view.
   */
  function armedLayers(next, target) {
    const view = visibleLayers(next, target);
    const user = view[0];
    return view.filter((layer) => (layer.root === null
      ? anyStatesOn(view.map((entry) => entry.config))
      : effectiveInterpolate(user.config ?? emptyConfig(), layer.config) === true));
  }

  /**
   * Expand the reserved section's text for one assembly (Revision 15, design A).
   *
   * This replaces the Revision 13/14 hold mechanism outright. The old design
   * asked "would this turn throw if the section interpolated?", answered it at
   * the outermost point of the waterfall, and held substitution back when the
   * answer was yes. The question existed only because the plugin used to flip
   * `section.interpolate` to `true`; Revision 15 never does, so the strict
   * renderer can no longer be reached through this section and there is nothing
   * to hold back. In its place the plugin does the substitution itself, from
   * {@link assemblyVariablesOf} — the table **this** assembly carries — and does
   * it leniently ({@link expandPromptText}): a name that resolves is replaced, a
   * name that does not stays literal.
   *
   * **Position, and why it does not matter** (CONTRACT §16.9). The expansion
   * runs right after `applyOverrides`, inside the ordinary `assembleHandler`, and
   * assumes nothing about the waterfall: not `{prepend: true}`, not "this plugin
   * is outermost". If a listener outer to this one rewrites the sections after
   * this point, the worst outcome is that this turn is not expanded — the user
   * sees the literal braces — and never that an assembly fails. That is the
   * whole value of the design, and it is what the F1/F2 regressions pin down.
   *
   * The result is applied to the section object the renderer will read. Returns
   * the input **by reference** when nothing changed, which keeps the "no
   * override ⇒ byte-identical assembly" guarantee exact and makes OFF a true
   * no-op.
   * @param sections - the section list this plugin's overrides produced.
   * @param variables - the variable table of this assembly, or null.
   * @returns the section list to render (possibly the input).
   */
  function expandReservedSection(sections, variables) {
    const at = reservedIndex(sections);
    if (at === -1) return sections;
    const text = sections[at]?.text;
    if (typeof text !== 'string' || !text.includes('{{')) return sections;
    const expanded = expandPromptText(text, variables);
    if (expanded === text) return sections;
    const output = sections.slice();
    output[at] = { ...sections[at], text: expanded };
    return output;
  }

  /**
   * The variable table an assembly is about to render with.
   *
   * `downstream` (what `next()` returned) wins because that is the object the
   * caller renders; the pre-waterfall `assembly` is the fallback for a host that
   * carries the table only there. Revision 15 uses this as the data source of
   * the plugin's own expansion — the *real* table of *this* turn, never a cached
   * reading of it. Anything that is not an object is reported as "no table",
   * which the lenient expansion reads as "nothing resolves".
   * @param assembly - the pre-waterfall assembly.
   * @param downstream - what the rest of the waterfall returned.
   * @returns the table, or null.
   */
  function assemblyVariablesOf(assembly, downstream) {
    const value = downstream?.variables ?? assembly?.variables;
    return value !== null && typeof value === 'object' ? value : null;
  }

  /**
   * Every visible layer, with the write target's post-write config in place
   * (Revision 12, audit F1).
   *
   * "Visible" is the whole set the F1 verdict must range over: the user layer
   * (merged into every session) plus every workspace layer this mount can see.
   * The post-write config matters when the write itself could state a flag —
   * `PUT /interpolate` can, `PUT /overrides` cannot — so the same helper serves
   * both routes without either of them re-deriving the pair. Which of these
   * entries is actually checked is decided per text by {@link armedLayers}.
   * @param next - the config the write target would hold, or null to use disk.
   * @param target - the resolved write target from {@link targetFor}, or null.
   * @returns `[{owner, root, config}]`.
   */
  function visibleLayers(next, target) {
    const isTarget = (root) => target !== null && target.root === root;
    const list = [{
      owner: `the user layer (${state.user.path})`,
      root: null,
      config: target !== null && isTarget(null) ? next : state.user.config,
    }];
    for (const [root, layer] of state.workspaces) {
      list.push({
        owner: `the workspace layer (${layer.path})`,
        root,
        config: isTarget(root) ? next : layer.config,
      });
    }
    return list;
  }

  /**
   * Refuse a write whose target is not in the set this process is judging
   * (Revision 13, audit D1).
   *
   * The F1 verdict is a statement about a *set* of layers, and a target that is
   * missing from that set is not "nothing to check" — it is "this write cannot
   * be verified". Answering 200 there was the audit's fail-open: the target's
   * text reaches an armed assembly while the verdict never saw it. It is
   * a belt-and-braces guard ({@link targetFor} now loads the target into the
   * cache, so the case should be unreachable), and it is deliberately a refusal
   * rather than a silent skip: the direction this check can be wrong in is
   * over-refusal, which is explainable and repairable.
   * @param target - the resolved write target from {@link targetFor}.
   * @returns nothing.
   * @throws {OverrideError} `400 write-target-unverified`.
   */
  function assertTargetJudged(target) {
    const present = visibleLayers(null, target).some((layer) => layer.root === target.root);
    if (present) return;
    const owner = target.root === null
      ? `the user layer (${target.path})`
      : `the workspace layer (${target.path})`;
    throw fail(
      'write-target-unverified',
      `${owner} is not in the layer set this request judged, so the write cannot be verified and is refused. `
        + 'Retry once this workspace is visible to the plugin.',
      400,
    );
  }

  /**
   * Refuse to store an override carrying a reference that could never expand
   * (Revision 9), judged by the F1 rule (Revision 12).
   *
   * The old judgement asked "does the layer being written interpolate?". That is
   * the wrong question and a pure-UI bypass: `x {{nope}}` could be stored into a
   * closed layer and then armed by flipping a *different* layer on, and the write
   * that stored it never looked at the layer that would arm it. The question
   * this asks instead is "does the text about to be stored reach an armed
   * assembly?" — {@link armedLayers} on the post-write view.
   *
   * Over-refusal is the deliberate direction when the two readings differ: a
   * refused write explains itself and is repairable. Revision 15 (design A) keeps
   * the whole rule and demotes its meaning from safety to UX — a stored
   * unregistered reference now stays literal instead of failing an assembly
   * (CONTRACT §16.9).
   * @param override - the normalized override about to be stored.
   * @param next - the config the layer would hold after the write.
   * @param target - the resolved write target from {@link targetFor}.
   * @returns the advisories to put on the response (possibly empty).
   * @throws {OverrideError} `400 unresolvable-variable`.
   */
  async function assertTextInterpolatable(override, next, target) {
    if (override === null || override === undefined) return [];
    if (override.name !== CUSTOM_SECTION_NAME || override.action === 'hide') return [];
    assertTargetJudged(target);
    const armed = armedLayers(next, target).some((layer) => layer.root === target.root);
    if (!armed) return [];
    const owner = target.root === null
      ? `the user layer (${target.path})`
      : `the workspace layer (${target.path})`;
    const { warnings } = assertInterpolatable(override.text, await variablesForWrite(), owner);
    return warnings;
  }

  /**
   * Re-read both layers from disk. This is the single point where a route
   * request touches the filesystem for reading, and it is deliberately the
   * *first* thing every handled request does — before any of it can fail.
   *
   * Consequences, both intended:
   * - an external edit (hand edit, config-sync tool, another process) is
   *   visible to the very next handled request, with no remount;
   * - a request that then fails still leaves the cache aligned with the files,
   *   so a failed write can never desync memory from disk for longer than the
   *   request that failed.
   *
   * It is never reached from the assembly path: the waterfall listener reads
   * this cache and nothing else (CONTRACT §5.5).
   *
   * It stays **synchronous and argument-free**: `test/route.test.mjs` asserts on
   * its source shape ("the IO sits in `refreshLayers()`, at the top of the
   * handler"), and Revision 9 does not widen that. The one extra Revision 9 step
   * that needs more than a file read lives next to the call instead: the
   * variable table is awaited before it, for the read face of `GET /interpolate`.
   *
   * Revision 15 (design A) removed the third step Revision 12 had added inside
   * it (the cross-layer interpolation self-check): nothing stored in a layer can
   * break an assembly any more, so no layer is ever degraded for its text.
   */
  function refreshLayers() {
    refreshUser();
    refreshWorkspaces();
  }

  /**
   * The session id an assembly belongs to. Real turns dispatch with
   * `AssembleContext = {agent, scope: agent, signal?}`, and `Agent.id` IS the
   * session id, so the workspace layer can be chosen without any IO.
   * @param context - the waterfall's assembly context.
   * @returns the session id, or undefined for the unscoped base assembly.
   */
  function sessionIdOf(context) {
    for (const candidate of [context?.agent, context?.scope]) {
      if (candidate !== null && typeof candidate === 'object' && typeof candidate.id === 'string') {
        return candidate.id;
      }
    }
    return undefined;
  }

  /**
   * The map key an assembly is filed under. An unscoped assembly has no scope
   * key object, so it gets a sentinel that no probe can collide with (probes
   * always carry a scope: an Agent or {@link PROBE_SCOPE}).
   * @param context - the waterfall's assembly context.
   * @returns the scope key object, or the unscoped sentinel.
   */
  function scopeKeyOf(context) {
    const scope = context?.scope;
    return scope === undefined || scope === null ? UNSCOPED_KEY : scope;
  }

  /**
   * The config one assembly must apply: user layer always, workspace layer when
   * the assembly belongs to an agent whose workspace has a cached layer.
   *
   * Consumes the in-flight probe config when — and only when — this is the very
   * `AssembleContext` object {@link probe} handed to `assemble()`. Matching on
   * the context's identity rather than on a scope value or a sentinel is what
   * keeps a concurrent assembly by any other caller (including a real turn for
   * the same agent) from picking up the probe's synthetic section.
   * @param context - the waterfall's assembly context.
   * @returns the merged, layer-tagged override list.
   */
  function resolvedFor(context) {
    if (state.pendingProbe !== null && context === state.pendingProbe.context) {
      const resolved = state.pendingProbe.resolved;
      state.pendingProbe = null;
      return resolved;
    }
    const user = state.user.config ?? emptyConfig();
    const sessionId = sessionIdOf(context);
    if (sessionId === undefined) return mergeLayers(user, null);
    const { root } = workspaceRootFor(sessionId);
    if (root === null) return mergeLayers(user, null);
    return mergeLayers(user, state.workspaces.get(root)?.config ?? null);
  }

  /**
   * The `system-prompt/assemble` waterfall listener.
   *
   * Synchronous until `next()`: the observation is recorded and the in-flight
   * probe config consumed before anything can interleave, which is what makes
   * the snapshot's `base` view and frozen detection deterministic. It calls
   * `next()` so no other listener is vetoed, then applies this plugin's
   * overrides to the downstream result, then expands the reserved section when
   * the switch is ON (Revision 15).
   *
   * The switch is resolved from the same `resolved` config the overrides come
   * from — merged per context — so two sessions cannot be described by one
   * value; nothing here reads or writes a process-wide field.
   * @param assembly - the pre-waterfall assembly (registered sections).
   * @param context - the assembly context (`{agent?, scope?, signal?}`).
   * @param next - the rest of the waterfall.
   * @returns the assembly with this plugin's overrides applied and expanded.
   */
  async function assembleHandler(assembly, context, next) {
    const key = scopeKeyOf(context);
    const registered = Array.isArray(assembly?.sections) ? assembly.sections : [];
    const record = { seq: (state.records.get(key)?.seq ?? 0) + 1, registered, downstream: null };
    state.records.set(key, record);
    // g-062: captured **before** `resolvedFor` consumes `pendingProbe`. Object
    // identity is the only reliable test: `probeTarget()` hands the real Agent
    // when the session has one, so a probe is indistinguishable from a turn by
    // its shape (card-e29d15f5, risk 2).
    const probe = state.pendingProbe !== null && context === state.pendingProbe.context;
    const resolved = resolvedFor(context);

    const downstream = await next();
    const sections = Array.isArray(downstream?.sections) ? downstream.sections : registered;
    record.downstream = sections;

    // Revision 12 (audit F3): this plugin's overrides are applied from `resolved`
    // — the config this very context resolved a moment ago — and never from the
    // live definition object, which the shipped `assemble` already copied into
    // the pre-waterfall sections and which is process-wide (two sessions cannot
    // be described by one value).
    let base = downstream;
    if (resolved.overrides.length > 0) {
      try {
        const applied = applyOverrides(sections, resolved);
        if (applied.changed) base = { ...downstream, sections: applied.sections };
      } catch {
        // Fail open. An override bug must never break a user's turn; the snapshot
        // reports the layers it could not use, which is where this surfaces.
        base = downstream;
      }
    }

    // Revision 15 (design A): the switch, applied on the finished section list.
    // `interpolateFlagOf(resolved)` is this assembly's own effective state
    // (workspace over user, on statedness), and the table is this assembly's own
    // (`downstream.variables ?? assembly.variables`) — never a cached reading.
    // A failure here costs at most one unexpanded turn, so it fails open.
    let result = base;
    if (interpolateFlagOf(resolved) === true) {
      try {
        const current = Array.isArray(base?.sections) ? base.sections : sections;
        const expanded = expandReservedSection(current, assemblyVariablesOf(assembly, downstream));
        if (expanded !== current) result = { ...base, sections: expanded };
      } catch {
        result = base;
      }
    }
    // g-062: the observation, after every decision above and before the value
    // leaves this handler. It reads the section list this plugin is about to
    // return and produces nothing the assembly path consumes; it is fail-open
    // (`observeUserAssembly` swallows its own errors), so no observation can
    // break a turn and no observation can change the returned sections.
    observeUserAssembly({ probe, context, resolved, sections: result?.sections, at: Date.now() });
    return result;
  }

  /**
   * g-062: fold one finished assembly into the status watch.
   *
   * Called with the exact section list {@link assembleHandler} returns. Two
   * assemblies are deliberately **not** attributed to a user session:
   *   - this plugin's own probe (matched by the identity of the very
   *     `AssembleContext` object `probe()` handed to `assemble()`): a probe
   *     assembles without any delivery and must never enter a session's notice;
   *   - an unscoped assembly (no session id), which belongs to no conversation.
   *
   * Both are counted instead of silently dropped, so the diagnostics can show
   * that the exclusion is running.
   * @param input - `{probe, context, resolved, sections, at}`.
   */
  function observeUserAssembly(input) {
    try {
      if (input.probe === true) {
        assemblyWatch.rejectProbe();
        return;
      }
      const sessionId = sessionIdOf(input.context);
      if (sessionId === undefined) {
        assemblyWatch.rejectProbe();
        return;
      }
      assemblyWatch.observeAssembly({
        sessionId,
        // The config this assembly resolved — "what the user set in this plugin",
        // independent of whether it reached the rendered section.
        configuredText: configuredTextOf(input.resolved?.overrides, CUSTOM_SECTION_NAME),
        // The plugin's own final text for the reserved section; absent means the
        // section did not survive to this list, which is reported as "not
        // assembled" rather than guessed at.
        segmentText: sectionTextOf(input.sections, CUSTOM_SECTION_NAME) ?? '',
        at: input.at,
      });
    } catch {
      // Fail open. An observation bug must never break a user's turn.
    }
  }

  /**
   * g-062: note a save of the reserved section, so that session's **next run**
   * can report whether the change was re-assembled and delivered.
   *
   * Called after a successful write and strictly side-effect-free with respect to
   * it: a note that cannot be taken never fails a save.
   * @param input - `{layer, session, action, text}`.
   */
  function notePromptWrite(input) {
    try {
      assemblyWatch.markPromptWrite({
        layer: input.layer,
        // `null` (a user-layer save with no session) addresses every session; a
        // workspace save addresses the one whose workspace layer was written.
        session: typeof input.session === 'string' && input.session.length > 0 ? input.session : null,
        action: input.action,
        text: typeof input.text === 'string' ? input.text : '',
        at: Date.now(),
      });
    } catch {
      // Fail open: the save already happened and its response is unaffected.
    }
  }

  /**
   * The `system-prompt/assemble` listener that keeps the reserved section last
   * (g-017, `CONTRACT.md` §15.10).
   *
   * Registered with `{prepend: true}`, which places it at the **front of the
   * waterfall among the listeners registered so far** — deliberately *not* an
   * absolute claim: cordis implements `prepend` as `unshift`, so a listener
   * registered **later** with `{prepend: true}` runs outside this one
   * (Revision 15, `CONTRACT.md` §16.9.4). Measured, not assumed: the waterfall runs
   * `outer:in → inner:in → inner:out → outer:out` (`CONTRACT.md` §6·E2), so the
   * outermost listener's post-`next()` step runs **last** and therefore sees
   * every section a listener registered earlier appended (or rewrote) after
   * `next()` returned. The platform itself places listeners this way
   * (`ctx.on(..., { prepend: true })`), and `order: 1000000` cannot outrank it:
   * that is exactly the live-machine gap this listener closes.
   *
   * Revision 15 removed the interpolation verdict this listener used to take:
   * the expansion now lives in {@link assembleHandler}, right where the
   * overrides are applied, and assumes nothing about position — a `prepend`
   * listener registered *after* this plugin can still rewrite the sections, and
   * all that costs is "this turn was not expanded". One step remains here:
   * {@link reservedSectionLast}, the g-017 move, identity-preserving.
   *
   * Fail-open: the transform is pure and total, and it is wrapped in the same
   * belt-and-braces `try` `assembleHandler` uses — an exception on the assembly
   * path would break a user's turn.
   * @param assembly - the pre-waterfall assembly (fallback section list).
   * @param context - the assembly context.
   * @param next - the rest of the waterfall.
   * @returns the downstream assembly with the reserved section last.
   */
  async function keepReservedLastHandler(assembly, context, next) {
    const result = await next();
    try {
      return reservedSectionLast(result);
    } catch {
      return result;
    }
  }

  /**
   * Run one assembly probe under the target scope with a specific config, and
   * report what was observed.
   *
   * The scope matters: `complete` is a per-scope fact. Because `Scoped`
   * registrations are inherited through the scope's parent chain, a
   * `complete: true` section registered by a preset's standing scope freezes
   * every session composed under it while the unscoped assembly stays
   * unfrozen — so probing globally would report `frozen: false` and
   * `overridable: true` for a scope where an edit cannot take effect.
   * @param probe - the target scope and the config this probe must apply.
   * @returns `{observed, registered, downstream, after, variables}`.
   */
  async function probe({ scope, agent, resolved }) {
    const context = agent === undefined ? { scope } : { agent, scope };
    const before = state.records.get(scope)?.seq ?? 0;
    state.pendingProbe = { context, resolved };
    let assembly;
    try {
      assembly = await ctx.systemPrompt.assemble(context);
    } catch (error) {
      throw new OverrideError('assemble-failed', `systemPrompt.assemble() failed: ${error?.message ?? String(error)}`, 503);
    } finally {
      state.pendingProbe = null;
    }
    const record = state.records.get(scope);
    const observed = record !== undefined && record.seq > before;
    return {
      observed,
      registered: observed ? record.registered : [],
      downstream: observed ? (record.downstream ?? []) : [],
      after: Array.isArray(assembly?.sections) ? assembly.sections : [],
      variables: assembly?.variables,
    };
  }

  /**
   * Choose the scope the snapshot must probe, and say plainly which scope the
   * resulting verdict describes.
   * @param sessionId - the `?session=` value, or null.
   * @returns `{scope, agent, frozenScope, frozenScopeReason}`.
   */
  function probeTarget(sessionId) {
    if (sessionId === null || sessionId.length === 0) {
      return { scope: PROBE_SCOPE, agent: undefined, frozenScope: 'global', frozenScopeReason: null };
    }
    const agent = agentFor(sessionId);
    if (agent !== undefined) {
      return { scope: agent, agent, frozenScope: 'session', frozenScopeReason: null };
    }
    const available = agentsService() !== undefined;
    return {
      scope: PROBE_SCOPE,
      agent: undefined,
      frozenScope: 'global',
      frozenScopeReason: available
        ? `session ${JSON.stringify(sessionId)} has no active agent, so this verdict describes the unscoped assembly; a complete section registered in that session's scope would not be visible here`
        : 'the agents service is not available in this profile, so this verdict describes the unscoped assembly',
    };
  }

  /**
   * The public view of the user layer.
   * @returns `{layer, enabled, path, reason, overrides}` without the internal config.
   */
  function userLayerView() {
    return {
      layer: 'user',
      enabled: state.user.error === null,
      path: state.user.path,
      reason: state.user.error === null ? null : `${state.user.error.code}: ${state.user.error.message}`,
      overrides: state.user.config?.overrides ?? [],
    };
  }

  /**
   * The public view of the workspace layer for a session.
   * @param sessionId - the resolved session id, or null when none was supplied.
   * @param config - the layer config to expose (null when unusable).
   * @returns `{layer, enabled, path, reason, overrides}`.
   */
  function workspaceLayerView({ sessionId, path, reason, config }) {
    return {
      layer: 'workspace',
      enabled: config !== null,
      path: path ?? null,
      reason: config !== null ? null : reason,
      overrides: config?.overrides ?? [],
    };
  }

  /**
   * Resolve which config a session's snapshot must describe.
   *
   * It does not refresh: {@link refreshLayers} already re-read every layer at
   * the start of this request, so the only thing left to do here is load the
   * one root this view is about (which is also how a root the registry lists
   * but the cache has not seen is picked up).
   * @param sessionId - the `?session=` value, or null.
   * @returns `{sessionId, path, reason, config}`.
   */
  function workspaceContext(sessionId) {
    if (sessionId === null || sessionId.length === 0) {
      return {
        sessionId: null,
        path: null,
        reason: 'no ?session= was supplied, so the workspace layer is inactive for this view',
        config: null,
      };
    }
    const { root, reason } = workspaceRootFor(sessionId);
    if (root === null) return { sessionId, path: null, reason, config: null };
    const layer = loadWorkspace(root);
    if (layer.error !== null) {
      return {
        sessionId,
        path: layer.path,
        reason: `${layer.error.code}: ${layer.error.message}`,
        config: null,
      };
    }
    return { sessionId, path: layer.path, reason: null, config: layer.config };
  }

  /**
   * Every workspace layer this process knows, as export entries (Revision 53).
   *
   * The g-074 requirement is「导出的所有设置」, and「所有」includes the
   * workspaces the export request never named: a backup taken in one project
   * must carry every other project's layer too. The set is
   * `state.workspaces`, which {@link refreshWorkspaces} fills from the Host's
   * own registry at the start of every request — so this reads the same list
   * the assembly path would use, never a client-supplied one.
   *
   * Sorted by `root` so two exports of an unchanged installation produce the
   * same byte order (the map's insertion order follows the registry, which is
   * not a promise anyone made).
   * @returns `[{root, enabled, reason, overrides}]`.
   */
  function workspaceLayerExports() {
    return [...state.workspaces.entries()]
      .map(([root, layer]) => ({
        root,
        enabled: layer.error === null,
        reason: layer.error === null ? null : `${layer.error.code}: ${layer.error.message}`,
        overrides: layer.config?.overrides ?? [],
      }))
      .sort((left, right) => (left.root < right.root ? -1 : left.root > right.root ? 1 : 0));
  }

  /**
   * The workspace roots the Host registers right now (Revision 53).
   * @returns a `Set` of absolute roots, or `null` when this profile has no
   *   workspace service at all.
   */
  function registeredWorkspaceRoots() {
    const registry = workspaceRegistry();
    if (registry === undefined || typeof registry.list !== 'function') return null;
    let list;
    try {
      list = registry.list();
    } catch {
      return null;
    }
    return new Set(
      (Array.isArray(list) ? list : [])
        .map((workspace) => workspace?.path)
        .filter((path) => typeof path === 'string' && path.length > 0),
    );
  }

  /**
   * The path-safety half of an import that restores workspace layers
   * (Revision 53, CONTRACT §11.7).
   *
   * `core/transfer.js` already proved the root is a legal absolute path with no
   * `..` segment (`validateWorkspaceRoot`). What it cannot know is **which
   * workspaces this Host has**: only the registry can say that, and without
   * this check a crafted document could make the import create a
   * `.dsh-prompt-setting/` directory under any absolute path on the machine.
   *
   * So the rule is the narrow one, and it is a refusal rather than a skip: a
   * root this profile does not register is `400 unknown-workspace-root`, the
   * whole import writes nothing, and the message says what to do about it.
   * @param root - the candidate root from the document.
   * @returns the root, unchanged.
   * @throws {OverrideError} `workspace-unresolved` / `unknown-workspace-root`.
   */
  function assertKnownWorkspaceRoot(root) {
    const known = registeredWorkspaceRoots();
    if (known === null) {
      throw new OverrideError(
        'workspace-unresolved',
        'this profile exposes no workspaceRegistry service, so no workspace layer can be restored',
      );
    }
    if (!known.has(root)) {
      throw new OverrideError(
        'unknown-workspace-root',
        `${JSON.stringify(root)} is not a workspace this profile registers; open that workspace here first, then import again`,
      );
    }
    return root;
  }

  /**
   * `GET /prompt-setting/snapshot` — the base and effective section views of
   * one assembly, plus the layering and frozen verdict that produced them.
   *
   * With `?session=` the assembly is probed under that session's own Agent
   * scope, so the verdict describes the scope a real turn would use; without
   * it, under this plugin's private scope, which resolves the global sections.
   * `frozenScope` always says which of the two the verdict is about.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  async function handleSnapshot(url, res) {
    const sessionId = url.searchParams.get('session');
    const workspace = workspaceContext(sessionId);
    const userConfig = state.user.config ?? emptyConfig();
    const resolved = mergeLayers(userConfig, workspace.config);
    const target = probeTarget(sessionId);

    // Probe 1 appends one section nothing else would contain. If it is missing
    // from the result, or the list changed size without it, the pipeline
    // replaced this scope's sections after the waterfall — the frozen signal,
    // and the only signal that also sees a scope whose single section IS the
    // complete one.
    const frozenProbe = await probe({ ...target, resolved: probeConfig() });
    // Probe 2 asks what this session's real overrides actually achieve.
    const overrideProbe = await probe({ ...target, resolved });

    const frozenInfo = detectFrozen({
      registered: frozenProbe.registered,
      probe: frozenProbe.after,
    });
    const flags = completeFlags(
      frozenProbe.registered,
      frozenProbe.after,
      frozenInfo.frozen,
      frozenInfo.frozenSection,
    );
    const base = buildBase(frozenProbe.registered, flags);
    const attempt = applyOverrides(overrideProbe.downstream, resolved);
    const effective = buildEffective({
      base,
      after: overrideProbe.after,
      resolved,
      report: attempt.report,
      frozen: frozenInfo.frozen,
      frozenReason: frozenInfo.frozenReason,
    });
    const rendered = renderSections(overrideProbe.after, overrideProbe.variables);

    sendJson(res, 200, {
      ok: true,
      mounted: frozenProbe.observed && overrideProbe.observed,
      generatedAt: new Date().toISOString(),
      frozen: frozenInfo.frozen,
      frozenSection: frozenInfo.frozenSection,
      frozenReason: frozenInfo.frozenReason,
      frozenScope: target.frozenScope,
      frozenScopeReason: target.frozenScopeReason,
      base: { sections: base },
      effective: { sections: effective },
      rendered: rendered.text,
      renderedResolved: rendered.resolved,
      unresolvedVariables: rendered.unresolved,
      // The same unresolved references, graded by what they actually do to the
      // real assembly (see CONTRACT §2.3). `unresolvedVariables` keeps its
      // meaning: it is the throwing set, which is what the warning is about.
      unresolvedThrowing: rendered.unresolved,
      unresolvedLiteral: rendered.literal,
      layers: {
        user: { enabled: state.user.error === null, path: state.user.path, reason: state.user.error === null ? null : `${state.user.error.code}: ${state.user.error.message}` },
        workspace: {
          enabled: workspace.config !== null,
          path: workspace.path,
          reason: workspace.config === null ? workspace.reason : null,
        },
        // Revision 9. `effective` is what this session's assembly will do;
        // `user`/`workspace` are the layers' own stated values (`null` when a
        // layer states nothing, which is not the same as `false` and is what
        // makes "the workspace inherits the user layer" visible to the browser).
        // It lives under `layers` rather than at the top level so a Revision 8
        // client's exact-key assertion on the snapshot body still holds.
        interpolate: {
          effective: effectiveInterpolate(userConfig, workspace.config),
          user: interpolateFlagOf(state.user.config) ?? null,
          workspace: interpolateFlagOf(workspace.config) ?? null,
        },
      },
      experiments: EXPERIMENTS,
    });
  }

  /**
   * `GET /prompt-setting/overrides` — both layers and the merged list the
   * assembly handler would apply for this session.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  function handleReadOverrides(url, res) {
    const workspace = workspaceContext(url.searchParams.get('session'));
    const userConfig = state.user.config ?? emptyConfig();
    const merged = mergeLayers(userConfig, workspace.config);
    sendJson(res, 200, {
      ok: true,
      user: userLayerView(),
      workspace: workspaceLayerView(workspace),
      merged: { overrides: merged.overrides },
    });
  }

  /**
   * Resolve the config path one write targets.
   * @param layer - the requested layer.
   * @param sessionId - the session id from the body or query, or null.
   * @returns `{path, root}`; `root` is null for the user layer.
   * @throws {OverrideError} for an unknown layer or an unresolvable workspace.
   */
  function targetFor(layer, sessionId) {
    if (!LAYERS.includes(layer)) {
      throw new OverrideError('unknown-layer', `"layer" must be one of ${LAYERS.join(', ')}`);
    }
    if (layer === 'user') return { path: userConfigPath(), root: null };
    if (sessionId === null || sessionId.length === 0) {
      throw new OverrideError('workspace-unresolved', 'layer "workspace" requires a "session" id to resolve the workspace root');
    }
    const { root, reason } = workspaceRootFor(sessionId);
    if (root === null) throw new OverrideError('workspace-unresolved', reason ?? 'cannot resolve a workspace for this session');
    // Revision 13 (audit D1): the write target's resolution and the F1 judgement
    // must range over the SAME set of layers. `workspaceRootFor` resolves
    // through `workspaceRegistry.list()`, while {@link armedLayers} ranges over
    // `state.workspaces` — and a workspace the registry only starts listing
    // *after* this request's `refreshLayers()` would be absent from the cache,
    // so `armedLayers(...).some((layer) => layer.root === target.root)` was
    // false by construction and the write was let through unverified. Loading
    // the target here closes the gap at its source: whatever root the registry
    // resolves is in the judgement set before any verdict is taken. The reader
    // is {@link loadWorkspace}, i.e. the same read the refresh uses, so the two
    // sources cannot drift apart again.
    if (!state.workspaces.has(root)) loadWorkspace(root);
    return { path: workspaceConfigPath(root), root };
  }

  /**
   * Read the layer a write is about to modify, refusing to overwrite a file we
   * could not understand.
   * @param path - the config path.
   * @returns the validated current config.
   * @throws {OverrideError} with 409 when the file exists but is unusable.
   */
  function writableConfig(path) {
    const current = readConfig(path);
    if (current.error !== null) {
      throw new OverrideError(
        'layer-not-writable',
        `${path} is not a valid config (${current.error.code}: ${current.error.message}); fix or remove it before saving`,
        409,
      );
    }
    return current.config;
  }

  /**
   * Store a freshly written layer back into the in-memory cache, so the very
   * next assembly sees it without a re-read. The file now exists by
   * construction, which is what the user layer's `present` flag records.
   * @param target - the resolved target from {@link targetFor}.
   * @param config - the config that was written.
   */
  function cacheWritten(target, config) {
    if (target.root === null) {
      state.user = { path: target.path, config, error: null, present: true };
      return;
    }
    state.workspaces.set(target.root, { path: target.path, config, error: null });
  }

  /**
   * Append one record to a layer's history file.
   *
   * History is a log, not the source of truth: a failure here is reported to
   * the caller and never undoes or blocks the config write that already
   * happened. That is the same failure isolation the assembly path uses (§5.6).
   * @param fields - the record fields; `seq` is assigned by the store.
   * @returns `{ok: true, id, seq, dropped, rewritten}` or `{ok: false, reason}`.
   */
  function recordHistory(fields) {
    const file = historyPath(fields.path ?? '');
    try {
      const { record, dropped, rewritten } = appendHistoryRecord(file, fields, historyLimit);
      state.historyFailures.delete(file);
      return { ok: true, id: String(record.seq), seq: record.seq, dropped: dropped.length, rewritten };
    } catch (error) {
      const reason = error instanceof OverrideError
        ? `${error.code}: ${error.message}`
        : `${error?.message ?? String(error)}`;
      state.historyFailures.set(file, { at: new Date().toISOString(), reason });
      return { ok: false, reason };
    }
  }

  /**
   * Read a layer's history file without throwing.
   * @param path - the layer's config path (its directory owns the history).
   * @returns `{path, records, corrupt, error}`.
   */
  function readLayerHistory(path) {
    const file = historyPath(path);
    const read = readHistoryFile(file);
    return { path: file, records: read.records, corrupt: read.corrupt, error: read.error };
  }

  /**
   * Resolve a layer for a read-only stage 2 view (history, diff, export).
   * @param layer - `user` | `workspace`.
   * @param sessionId - the session id, or null.
   * @returns `{layer, session, path, config, reason}`; `path` is null when the
   *   layer could not be resolved at all.
   * @throws {OverrideError} for an unknown layer.
   */
  function layerFor(layer, sessionId) {
    if (!LAYERS.includes(layer)) {
      throw fail('unknown-layer', `"layer" must be one of ${LAYERS.join(', ')}`);
    }
    if (layer === 'user') {
      return {
        layer,
        session: sessionId ?? null,
        path: state.user.path,
        config: state.user.config ?? emptyConfig(),
        reason: state.user.error === null ? null : `${state.user.error.code}: ${state.user.error.message}`,
      };
    }
    const workspace = workspaceContext(sessionId);
    return {
      layer,
      session: sessionId ?? null,
      path: workspace.path,
      config: workspace.config,
      reason: workspace.config === null ? workspace.reason : null,
    };
  }

  /**
   * Read the two scope parameters of a history-shaped read (Revision 19).
   *
   * `?session=` and `?workspace=` both name a session id, but they mean
   * different things and the difference is the whole of g-038:
   * - `session` is the **explicit filter** (plus, as it always was, the way to
   *   resolve which workspace's log to read). It is applied only when it is
   *   really supplied and non-empty: an absent/empty value means "this layer's
   *   whole log", which is what stops the user layer from being sliced per
   *   session (`?session=` was always sent by the page before Revision 19, so
   *   the user layer only ever showed the writes of one session).
   * - `workspace` is a **resolution-only** scope: a session id that says *which
   *   workspace* the reader is looking at, and never narrows the records. The
   *   version-history workspace selector uses it, so choosing a workspace can
   *   show that workspace's whole log rather than the slice written by the one
   *   session that happened to locate it.
   *
   * Neither parameter is ever a path: a workspace root still comes from the
   * Host's own session index (§4.2).
   * @param url - the parsed request URL.
   * @returns `{sessionFilter, scopeSession}` — `null` for "not supplied".
   */
  function readScopeOf(url) {
    const clean = (value) => (value === null || value.trim().length === 0 ? null : value);
    const sessionFilter = clean(url.searchParams.get('session'));
    const workspaceScope = clean(url.searchParams.get('workspace'));
    return { sessionFilter, scopeSession: sessionFilter ?? workspaceScope };
  }

  /**
   * `GET /prompt-setting/history` — one layer's change log, newest first.
   *
   * `layer` is required, exactly like `DELETE /overrides`: history lives beside
   * one layer's config file, and there is no meaningful default between the
   * two. `limit` and `offset` are clamped rather than rejected; `name` and
   * `before` narrow the page, and `session` narrows it too — but only when it
   * is explicitly supplied ({@link readScopeOf}).
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  function handleHistory(url, res) {
    const layer = url.searchParams.get('layer');
    const { sessionFilter, scopeSession } = readScopeOf(url);
    const view = layerFor(layer, scopeSession);
    const history = readLayerHistory(view.path ?? userConfigPath());
    const pageLimit = resolvePageLimit(url.searchParams.get('limit'));
    const pageOffset = resolvePageOffset(url.searchParams.get('offset'));
    const { records, total, offset, pageCount, hasMore } = queryHistory(history.records, {
      layer,
      session: sessionFilter,
      name: url.searchParams.get('name'),
      before: url.searchParams.get('before'),
      limit: pageLimit,
      offset: pageOffset,
    });
    sendJson(res, 200, {
      ok: true,
      layer,
      session: sessionFilter,
      scopeSession,
      path: history.path,
      enabled: view.reason === null,
      reason: view.reason,
      retentionLimit: historyLimit,
      pageLimit,
      offset,
      total,
      pageCount,
      hasMore,
      corrupt: history.corrupt,
      unreadable: history.error === null ? null : `${history.error.code}: ${history.error.message}`,
      lastError: state.historyFailures.get(history.path) ?? null,
      records: records.map(publicRecord),
    });
  }

  /**
   * `GET /prompt-setting/export` — the whole installation as a portable document.
   *
   * `layer` (optional) limits which of the two **layer views** the document
   * carries; without it the document carries `user` and `workspace`, the latter
   * possibly disabled with a `reason` — an export never invents a path it could
   * not resolve.
   *
   * Revision 7 narrowed this route to the reserved override of each layer and
   * declared the omission through `exportScope`. **Revision 53 (g-074) removes
   * the narrowing**: the document now carries every override of both layers
   * (frozen entries included), every workspace layer the Host registers, the
   * preset library and the preference document, and `version` is 2. The
   * declaration stays, with the opposite meaning — it says what the document
   * holds, and that nothing was left behind (§10).
   *
   * The two installation-level documents are read leniently like every other
   * read face: a `presets.json` or `preferences.json` this process cannot
   * understand is **not** carried (an empty library would silently clear the
   * user's real one on restore) and is reported in `exportScope.unavailable`
   * with its reason.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  function handleExport(url, res) {
    const requested = url.searchParams.get('layer');
    const names = requested === null || requested.length === 0 ? EXPORT_LAYERS.slice() : [requested];
    for (const name of names) {
      if (!LAYERS.includes(name)) throw fail('unknown-layer', `"layer" must be one of ${LAYERS.join(', ')}`);
    }
    const workspace = workspaceContext(url.searchParams.get('session'));
    const views = { user: userLayerView(), workspace: workspaceLayerView(workspace) };
    // Revision 53: no `customOverridesOnly` pass any more — what the layer view
    // holds is what the document carries. The view's own `path` is *not* copied
    // out: `buildExport` keeps only `{layer, enabled, reason, overrides}`, so
    // the layers stay path-free and the only absolute path in the document is a
    // workspace's own `root` (which is what makes it restorable).
    const scoped = {};
    for (const name of names) scoped[name] = { ...views[name] };

    const workspaceLayers = workspaceLayerExports();

    const presets = readPresets(userPresetsPath());
    const preferences = readPreferences(userPreferencesPath());
    const carriedPresets = presets.error === null ? presets.document : null;
    const carriedPreferences = preferences.error === null ? preferences.preferences : null;

    const document = buildExport({
      layers: scoped,
      workspaceLayers,
      presets: carriedPresets,
      preferences: carriedPreferences,
      pluginVersion: PLUGIN_VERSION,
      exportedAt: new Date().toISOString(),
      layerNames: names,
    });
    sendJson(res, 200, {
      ok: true,
      ...document,
      exportScope: exportScope({
        layers: scoped,
        workspaceLayers,
        presets: carriedPresets,
        preferences: carriedPreferences,
        unavailable: {
          presets: presets.error === null ? null : `${presets.error.code}: ${presets.error.message}`,
          preferences: preferences.error === null ? null : `${preferences.error.code}: ${preferences.error.message}`,
        },
      }, names),
    });
  }

  /**
   * Resolve one side of a diff.
   * @param selector - `current` | `<seq>` | null.
   * @param fallbackCurrent - whether `null` means `current` (one side may
   *   default) or is an error.
   * @param inputs - `{layer, session, path, config, history}`.
   * @returns the diff side.
   * @throws {OverrideError} for an unknown id.
   */
  function diffSide(selector, fallbackCurrent, inputs) {
    const currentSide = () => ({
      kind: 'current',
      label: 'current',
      layer: inputs.layer,
      session: inputs.session,
      snapshot: snapshotOfConfig(inputs.config),
      texts: Object.fromEntries(
        (inputs.config?.overrides ?? []).map((override) => [
          override.name,
          override.action === 'hide' ? null : override.text,
        ]),
      ),
      id: null,
      seq: null,
      at: null,
      action: null,
      name: null,
    });
    const raw = selector === null || selector === undefined ? '' : String(selector).trim();
    if (raw.length === 0) {
      if (fallbackCurrent) return currentSide();
      throw fail('missing-diff-selector', 'supply ?from= and/or ?to= (a history id or "current")');
    }
    if (raw === 'current') return currentSide();
    if (!/^\d+$/.test(raw)) {
      throw fail('invalid-diff-selector', `"${raw}" is neither "current" nor a history id`);
    }
    const record = inputs.history.records.find((entry) => entry.seq === Number(raw));
    if (record === undefined) {
      throw new OverrideError('history-not-found', `no history record #${raw} in the ${inputs.layer} layer`, 404);
    }
    return {
      kind: 'history',
      label: `#${record.seq}`,
      layer: record.layer,
      session: record.session,
      snapshot: Array.isArray(record.snapshot) ? record.snapshot : [],
      texts: record.name === null ? {} : { [record.name]: record.after === null ? null : record.after.text },
      id: String(record.seq),
      seq: record.seq,
      at: record.at,
      action: record.action,
      name: record.name,
    };
  }

  /**
   * `GET /prompt-setting/diff` — section-level and line-level differences
   * between two versions of one layer.
   *
   * `from` and `to` each take a history id or `current`; exactly one of them
   * may be omitted (it then means `current`), and omitting both is a `400`
   * because there is nothing to compare. `name` picks the section whose text is
   * compared line by line when more than one differs.
   *
   * Revision 19: the scope is read exactly as `GET /history` reads it
   * ({@link readScopeOf}), so the comparison always describes the same file the
   * log beside it lists: `?workspace=` locates, `?session=` filters.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  function handleDiff(url, res) {
    const layer = url.searchParams.get('layer');
    const { sessionFilter, scopeSession } = readScopeOf(url);
    const fromRaw = url.searchParams.get('from');
    const toRaw = url.searchParams.get('to');
    if ((fromRaw === null || fromRaw.length === 0) && (toRaw === null || toRaw.length === 0)) {
      throw fail('missing-diff-selector', 'supply ?from= and/or ?to= (a history id or "current")');
    }
    const view = layerFor(layer, scopeSession);
    const history = readLayerHistory(view.path ?? userConfigPath());
    const inputs = { layer, session: sessionFilter, config: view.config, history };
    const from = diffSide(fromRaw, toRaw !== null && toRaw.length > 0, inputs);
    const to = diffSide(toRaw, fromRaw !== null && fromRaw.length > 0, inputs);
    const focusName = url.searchParams.get('name');
    const payload = buildDiff({ from, to, focusName: focusName === null || focusName.length === 0 ? null : focusName });
    sendJson(res, 200, {
      ok: true,
      layer,
      session: sessionFilter,
      scopeSession,
      historyPath: history.path,
      ...payload,
    });
  }

  /**
   * `POST /prompt-setting/rollback` — move the reserved section back to a
   * recorded version (Revision 21; narrowed to that one section in Revision 22).
   *
   * The write face has been the reserved section alone since Revision 7
   * ({@link assertWritableSection}, §4.1/§15.7): `PUT /overrides`, the
   * single-name `DELETE` and `POST /import` all refuse every other name. A
   * rollback is therefore **not** a whole-layer restore — it adjusts that one
   * entry and leaves every other override of the layer exactly as it is,
   * including a non-reserved entry a hand-edited or pre-Revision-7 file still
   * carries. That restriction lives in {@link rollbackOverrides}; this handler
   * writes what it returns and nothing else.
   *
   * The order is the contract, exactly as `PUT /overrides` states it: resolve
   * the layer → read the layer's **current** config → read its log → rebuild
   * that one section → validate the rebuilt config → **only then** write. A
   * refusal at any earlier step therefore leaves the layer's file
   * byte-identical, which is the guarantee the failure cases are built on.
   *
   * The write appends a `rollback` record whose `name` is that section and whose
   * `before` / `after` are its text on either side, so the rollback is itself a
   * version: it can be rolled back, diffed and listed like any other.
   *
   * Scope: read exactly as `GET /history` and `GET /diff` read it. `session`
   * filters, `workspace` only locates ({@link readScopeOf}); either may come
   * from the body or the query string, and `session` wins when both are given,
   * because that is the value the read routes would apply.
   * @param req - the Node request.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  async function handleRollback(req, url, res) {
    const body = await readJsonBody(req);
    const layer = body?.layer;
    if (!LAYERS.includes(layer)) {
      throw new OverrideError('unknown-layer', `"layer" must be one of ${LAYERS.join(', ')}`);
    }
    const rawSeq = body?.seq;
    const seq = typeof rawSeq === 'string' && /^\d+$/.test(rawSeq.trim()) ? Number(rawSeq.trim()) : rawSeq;
    if (!Number.isInteger(seq) || seq < 1) {
      throw new OverrideError('invalid-seq', '"seq" must be a positive integer history id');
    }
    const clean = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);
    const sessionFilter = clean(body?.session) ?? clean(url.searchParams.get('session'));
    const workspaceScope = clean(body?.workspace) ?? clean(url.searchParams.get('workspace'));
    const scopeSession = sessionFilter ?? workspaceScope;
    const target = targetFor(layer, scopeSession);
    const current = writableConfig(target.path);
    const history = readLayerHistory(target.path);
    const { overrides, structure, target: wanted } = rollbackOverrides(
      history.records,
      current,
      seq,
      CUSTOM_SECTION_NAME,
    );
    // Validating the rebuilt list before the write is what keeps a malformed
    // version from reaching the disk: `validateConfig` rejects a duplicate name,
    // a bad action or an oversized text, and every one of those leaves the file
    // exactly as it was.
    const next = withInterpolate(validateConfig({ overrides }), interpolateFlagOf(current));
    const sectionOf = (config) =>
      (Array.isArray(config?.overrides) ? config.overrides : []).find((entry) => entry.name === CUSTOM_SECTION_NAME) ?? null;
    const wasSection = sectionOf(current);
    const isSection = sectionOf(next);
    writeConfig(target.path, next);
    cacheWritten(target, next);
    // g-062: a rollback rewrites the reserved section, so it is a prompt change
    // like any other and the layer's next run reports it.
    notePromptWrite({
      layer,
      session: layer === 'workspace' ? scopeSession ?? null : null,
      action: isSection === null ? 'hide' : isSection.action,
      text: isSection === null || isSection.action === 'hide' ? '' : String(isSection.text ?? ''),
    });
    const written = recordHistory({
      path: target.path,
      at: new Date().toISOString(),
      layer,
      session: scopeSession ?? null,
      action: ROLLBACK_ACTION,
      // A section record, like every other change this plugin makes: a rollback
      // edits one entry, so the log describes one entry.
      name: CUSTOM_SECTION_NAME,
      origin: 'ui',
      before: textEntry(wasSection === null ? null : wasSection.text),
      after: textEntry(isSection === null || isSection.action === 'hide' ? null : isSection.text),
      entries: null,
      snapshot: snapshotOfConfig(next),
      note: `rollback to #${seq}`,
    });
    sendJson(res, 200, {
      ok: true,
      rolledBack: true,
      layer,
      session: scopeSession ?? null,
      seq,
      // Which section was adjusted, whether the target version held it at all,
      // and how many *other* sections that version overrode — restored by
      // nothing, because the write face does not accept them (§19).
      section: CUSTOM_SECTION_NAME,
      restored: wanted !== null,
      skipped: structure.filter((entry) => entry.name !== CUSTOM_SECTION_NAME).length,
      count: next.overrides.length,
      overrides: next.overrides,
      effectiveFrom: 'next-turn',
      history: written,
    });
  }

  /**
   * `POST /prompt-setting/import` — apply an export document.
   *
   * The order is the contract: parse → schema/version/field validation →
   * **write-lock policy** → conflict strategy → stage every layer's file and
   * validate it → atomic rename. Nothing touches a real config file before the
   * last step, so a rejection at any earlier point leaves the existing
   * configuration byte-identical. `?dryRun=true` stops after the plan and
   * returns the counts.
   *
   * Since Revision 7 a document carrying any non-reserved section name is
   * refused with `403 write-locked` (CONTRACT §15.7). That check sits before
   * the dry-run branch on purpose: a dry run answers the question the real run
   * would answer, and neither may touch a byte.
   * @param req - the Node request.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  /**
   * `POST /prompt-setting/import` — apply an export document.
   *
   * The order is the contract: parse → schema/version/field/path validation →
   * conflict strategy → resolve and pre-check every target → stage every file
   * and read it back → atomic rename. Nothing touches a real file before the
   * last step, so a rejection at any earlier point leaves the existing
   * configuration byte-identical. `?dryRun=true` stops after the plan and
   * returns the counts.
   *
   * Revision 7 put a **write lock** in that order: a document carrying any
   * non-reserved section name was `403 write-locked`. **Revision 53 (g-074)
   * removes that lock** — a backup has to be restorable — and moves its weight
   * into validation instead: the layer-name whitelist, every override field,
   * every workspace root (a legal absolute path *and* a workspace this Host
   * registers) and the preset / preference documents are all checked before
   * anything is staged (§11.1, §11.7, §15.7). Removing the lock removed no
   * check.
   *
   * `?layer=` still narrows an import to the named layer view, which is what
   * it always meant: the installation-level documents are then not applied at
   * all (not half-applied), and the answer says so in `skipped`.
   * @param req - the Node request.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  async function handleImport(req, url, res) {
    const body = await readJsonBody(req, MAX_IMPORT_BYTES);
    const mode = resolveMode(url.searchParams.get('mode') ?? body?.mode);
    const dryRun = url.searchParams.get('dryRun') === 'true';
    const document = parseExport(body);

    const requested = url.searchParams.get('layer');
    const layersOnly = requested !== null && requested.length > 0;
    const names = layersOnly ? [requested] : Object.keys(document.layers);
    for (const name of names) {
      if (!LAYERS.includes(name)) throw fail('unknown-layer', `"layer" must be one of ${LAYERS.join(', ')}`);
      if (!Object.hasOwn(document.layers, name)) {
        throw fail('missing-export-layer', `the document carries no ${JSON.stringify(name)} layer`);
      }
    }

    const sessionId = typeof body?.session === 'string' && body.session.length > 0
      ? body.session
      : url.searchParams.get('session');

    // Resolve and validate every target before a single byte is written. A
    // workspace that cannot be resolved throws here, with nothing staged — but
    // only when the document actually asks for something in it: an export taken
    // without a session carries an empty, disabled workspace layer, and
    // refusing to re-import that would make export -> import fail for a reason
    // the user cannot act on. Such a layer is reported as `skipped` instead.
    const skipped = [];
    const warnings = [];
    /**
     * Every file this import would write, in one list, so the plan, the
     * pre-checks and the commit all range over the same set. A `layer` unit is
     * one of the document's two layer views; a `workspace` unit is one entry of
     * its `workspaces` array.
     */
    const units = [];
    /** The unit that already claimed a path, so one file is never planned twice. */
    const claimed = new Map();

    for (const name of names) {
      const imported = document.layers[name];
      let target;
      try {
        target = targetFor(name, sessionId);
      } catch (error) {
        if (imported.length === 0 && error instanceof OverrideError) {
          skipped.push({ layer: name, reason: error.message, entries: 0 });
          continue;
        }
        throw error;
      }
      const current = writableConfig(target.path);
      // Revision 9: the document's「我的 Prompt」text is validated against the
      // live variable table before the plan is even built, so a refused import
      // writes no layer at all — and the `?dryRun=true` branch answers exactly
      // what the real run would answer. Revision 12 (audit F1) makes that check
      // the cross-layer one and puts its advisories on both answers (audit F2).
      const layerWarnings = await assertTextInterpolatable(
        (Array.isArray(imported) ? imported : []).find((entry) => entry?.name === CUSTOM_SECTION_NAME),
        current,
        target,
      );
      warnings.push(...layerWarnings.map((entry) => ({ ...entry, layer: name })));
      claimed.set(target.path, { key: name, imported });
      units.push({
        key: name,
        kind: 'layer',
        layer: name,
        session: name === 'workspace' ? sessionId ?? null : null,
        target,
        path: target.path,
        plan: planImport({ imported, current, mode }),
      });
    }

    // Revision 53: the document's `workspaces` array restores every other
    // workspace layer. Each root must be a workspace this Host registers
    // (`assertKnownWorkspaceRoot`) — the path-safety boundary that keeps a
    // crafted document from creating a plugin directory anywhere on the disk —
    // and each layer is read and validated like a layer view, before anything
    // is staged.
    if (!layersOnly) {
      for (const entry of document.workspaces) {
        const root = assertKnownWorkspaceRoot(entry.root);
        const path = workspaceConfigPath(root);
        const key = `workspace:${root}`;
        if (entry.overrides.length === 0) {
          skipped.push({ layer: key, reason: 'the document carries no override for this workspace layer', entries: 0 });
          continue;
        }
        const other = claimed.get(path);
        if (other !== undefined) {
          if (JSON.stringify(other.imported) !== JSON.stringify(entry.overrides)) {
            throw fail('conflicting-import-target', `the document carries two different override lists for ${path}`);
          }
          skipped.push({ layer: key, reason: `already covered by ${JSON.stringify(other.key)} in this document`, entries: entry.overrides.length });
          continue;
        }
        // The judgement set is the same one `assertTextInterpolatable` ranges
        // over, and {@link refreshWorkspaces} has already loaded every root the
        // registry lists at the start of this request — so a root that just
        // passed `assertKnownWorkspaceRoot` is in the cache by construction,
        // exactly like the Revision 13 (audit D1) rule requires of `targetFor`.
        const current = writableConfig(path);
        const layerWarnings = await assertTextInterpolatable(
          entry.overrides.find((candidate) => candidate?.name === CUSTOM_SECTION_NAME),
          current,
          { path, root },
        );
        warnings.push(...layerWarnings.map((warning) => ({ ...warning, layer: key })));
        claimed.set(path, { key, imported: entry.overrides });
        units.push({
          key,
          kind: 'workspace',
          layer: 'workspace',
          session: null,
          target: { path, root },
          path,
          plan: planImport({ imported: entry.overrides, current, mode }),
        });
      }
    } else if (document.workspaces.length > 0 || document.presets !== null || document.preferences !== null) {
      const entries = document.workspaces.length
        + (document.presets === null ? 0 : document.presets.presets.length)
        + (document.preferences === null ? 0 : 1);
      skipped.push({
        layer: 'installation',
        reason: '?layer= limits this import to the named layer view, so the backup\'s workspace layers, preset library and preferences were not applied',
        entries,
      });
    }

    // The two installation-level documents (Revision 53). Both are replaced as
    // a whole when the document carries them: a library or a preference set has
    // no per-entry merge semantics, and the document an export produced is the
    // authoritative snapshot. A local file this process cannot understand is
    // **refused**, never overwritten — the same rule a layer file gets.
    let presetsPlan = null;
    if (!layersOnly && document.presets !== null) {
      const path = userPresetsPath();
      const current = readPresets(path);
      if (current.error !== null) {
        throw new OverrideError(
          'presets-not-writable',
          `${path} is not a usable preset library (${current.error.code}: ${current.error.message}); fix or remove it before importing`,
          409,
        );
      }
      presetsPlan = {
        path,
        next: document.presets,
        changed: JSON.stringify(current.document) !== JSON.stringify(document.presets),
      };
    }

    let preferencesPlan = null;
    if (!layersOnly && document.preferences !== null) {
      const path = userPreferencesPath();
      const current = readPreferences(path);
      if (current.error !== null) {
        throw new OverrideError(
          'preferences-not-writable',
          `${path} is not a readable preference document (${current.error.code}: ${current.error.message}); fix or remove it before importing`,
          409,
        );
      }
      preferencesPlan = {
        path,
        next: document.preferences,
        changed: JSON.stringify(current.preferences) !== JSON.stringify(document.preferences),
      };
    }

    const layerUnits = units.filter((unit) => unit.kind === 'layer');
    const workspaceUnits = units.filter((unit) => unit.kind === 'workspace');
    const plans = Object.fromEntries(layerUnits.map((unit) => [unit.key, unit.plan]));
    const importedNames = Object.keys(plans);
    const totals = totalCounts(Object.fromEntries(units.map((unit) => [unit.key, unit.plan])));
    const workspaceTotals = totalCounts(Object.fromEntries(workspaceUnits.map((unit) => [unit.key, unit.plan])));
    const layers = {};
    for (const unit of layerUnits) {
      layers[unit.key] = { ...publicPlan(unit.plan), path: unit.path, enabled: true };
    }
    const workspaces = workspaceUnits.map((unit) => ({
      root: unit.target.root,
      ...publicPlan(unit.plan),
      path: unit.path,
      enabled: true,
    }));
    const presetsReport = presetsPlan === null ? null : {
      path: presetsPlan.path,
      changed: presetsPlan.changed,
      presets: presetsPlan.next.presets.length,
      applied: presetsPlan.next.applied.length,
    };
    const preferencesReport = preferencesPlan === null ? null : {
      path: preferencesPlan.path,
      changed: preferencesPlan.changed,
      keys: Object.keys(preferencesPlan.next),
    };
    const importedWorkspaces = workspaceUnits.map((unit) => unit.target.root);
    const unchanged = units.every((unit) => unit.plan.counts.added === 0
      && unit.plan.counts.replaced === 0
      && unit.plan.counts.removed === 0)
      && (presetsPlan === null || presetsPlan.changed === false)
      && (preferencesPlan === null || preferencesPlan.changed === false);

    /** The exact bytes every config document is written with. */
    const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
    /** The response keys that describe the installation-level half. */
    const installation = {
      workspaces,
      presets: presetsReport,
      preferences: preferencesReport,
      importedWorkspaces,
      workspaceTotals,
    };

    if (dryRun) {
      sendJson(res, 200, withWarnings({
        ok: true,
        dryRun: true,
        mode,
        session: sessionId ?? null,
        schema: document.schema ?? null,
        exportedAt: document.exportedAt,
        layers,
        ...installation,
        imported: importedNames,
        skipped,
        totals,
        unchanged,
        applied: false,
      }, warnings));
      return;
    }

    if (unchanged) {
      sendJson(res, 200, withWarnings({
        ok: true,
        dryRun: false,
        mode,
        session: sessionId ?? null,
        layers,
        ...installation,
        imported: importedNames,
        skipped,
        totals,
        unchanged: true,
        applied: false,
        written: [],
        history: {},
      }, warnings));
      return;
    }

    // One commit for every changed file, of every kind (Revision 53): the
    // layer configs, the workspace configs, `presets.json` and
    // `preferences.json` are all staged and read back before the first rename,
    // so「a rejected import writes nothing」now covers the whole backup rather
    // than one file family.
    const commit = writeDocumentsAtomically([
      ...units
        .filter((unit) => unit.plan.counts.added + unit.plan.counts.replaced + unit.plan.counts.removed > 0)
        .map((unit) => ({ path: unit.path, text: serialize(unit.plan.next), verify: readConfig })),
      ...(presetsPlan !== null && presetsPlan.changed
        ? [{ path: presetsPlan.path, text: serialize(presetsPlan.next), verify: readPresets }]
        : []),
      ...(preferencesPlan !== null && preferencesPlan.changed
        ? [{ path: preferencesPlan.path, text: serialize(preferencesPlan.next), verify: readPreferences }]
        : []),
    ]);

    const history = {};
    for (const unit of units) {
      if (unit.plan.counts.added + unit.plan.counts.replaced + unit.plan.counts.removed === 0) continue;
      cacheWritten(unit.target, unit.plan.next);
      // g-062: an import that changes the reserved section is a prompt change like
      // any save, so the affected layer's next run reports it. Read from the plan
      // that was just committed, never re-read from disk.
      for (const change of unit.plan.changes) {
        if (change.name !== CUSTOM_SECTION_NAME || change.status === 'unchanged') continue;
        const after = change.after === undefined ? null : change.after;
        notePromptWrite({
          layer: unit.layer,
          session: unit.session,
          action: after === null ? 'hide' : after.action,
          text: after === null || after.action === 'hide' ? '' : String(after.text ?? ''),
        });
      }
      const snapshot = snapshotOfConfig(unit.plan.next);
      const reported = [];
      for (const change of unit.plan.changes) {
        if (change.status === 'unchanged') continue;
        const result = recordHistory({
          path: unit.path,
          at: new Date().toISOString(),
          layer: unit.layer,
          session: unit.session,
          action: change.status === 'removed' ? 'remove' : actionOf(change.before, change.after),
          name: change.name,
          origin: 'import',
          before: textEntry(change.before === null || change.before === undefined ? null : change.before.text),
          after: textEntry(change.after === null || change.after === undefined ? null : change.after.text),
          snapshot,
          note: `import mode=${mode} status=${change.status}`,
        });
        reported.push({ name: change.name, status: change.status, ...result });
      }
      history[unit.key] = reported;
    }

    sendJson(res, 200, withWarnings({
      ok: true,
      dryRun: false,
      mode,
      session: sessionId ?? null,
      layers,
      ...installation,
      imported: importedNames,
      skipped,
      totals,
      unchanged,
      applied: true,
      written: commit.paths,
      history,
    }, warnings));
  }

  /**
   * Refuse to arm the switch while a layer this change arms already carries text
   * that could never expand (Revision 9, re-judged by the F1 rule in Revision
   * 12, kept as UX by Revision 15).
   *
   * The switch is inherited in both directions, which is why this check ranges
   * over the whole visible set instead of the layer being written: opening the
   * user layer arms **every** workspace layer that did not explicitly close it,
   * and opening a workspace layer can arm the **user layer's** text, because the
   * user entry is what that workspace merges when it holds no entry of its own.
   * The old check only ever looked at the layer being written, so `x {{nope}}`
   * could sit in a closed user layer until a workspace layer was switched on.
   * Since Revision 15 the consequence of missing such a reference is milder — it
   * stays literal instead of failing the assembly — so this refusal is a courtesy
   * that keeps a user from saving text that will never substitute.
   *
   * Each layer is judged by {@link armedLayers}: a layer whose text cannot
   * reach an armed assembly after this change (an explicitly closed
   * workspace, say) is skipped, and every other visible layer must pass.
   * An `undefined` value is not a fault here either; those come back as
   * advisories for the response (Revision 12, audit F2).
   * @param next - the config the write target would hold after the write.
   * @param target - the resolved write target from {@link targetFor}.
   * @param variables - the freshly probed variable table.
   * @returns the advisories to put on the response (possibly empty).
   * @throws {OverrideError} `400 unresolvable-variable`.
   */
  function assertStoredTextsInterpolatable(next, target, variables) {
    assertTargetJudged(target);
    const names = Object.keys(variables);
    const faults = [];
    const warnings = [];
    for (const layer of armedLayers(next, target)) {
      if (layer.config === null) continue;
      const text = customTextOf(layer.config);
      if (text === null) continue;
      const linted = lintPromptText(text, variables, { assumeUnknown: true });
      if (linted.errors.length > 0) faults.push(describeInterpolateErrors(linted.errors, layer.owner, names));
      else warnings.push(...describeWarnings(linted.warnings, layer.owner));
    }
    if (faults.length === 0) return warnings;
    throw fail(
      'unresolvable-variable',
      `variable substitution cannot be enabled: ${faults.join(' ')}`,
      400,
    );
  }

  /**
   * Attach the advisories to a write response, or leave the body alone when
   * there are none (Revision 12, audit F2).
   *
   * The field is **additive and conditional**: a response that has something to
   * warn about carries `warnings`, and one that does not is byte-identical to
   * the response earlier revisions returned — which is what keeps the frozen
   * response shapes of the other routes intact.
   * @param payload - the response body.
   * @param warnings - the advisories from the write check.
   * @returns the body, with `warnings` when there is anything to say.
   */
  function withWarnings(payload, warnings) {
    return Array.isArray(warnings) && warnings.length > 0 ? { ...payload, warnings } : payload;
  }

  /**
   * `GET /prompt-setting/update-check` — is upstream ahead of this install?
   *
   * Every outcome is a **200**: a network error, a timeout, an HTTP error and a
   * repository with no release all answer with a payload (`ok:false` and a
   * structured `error`, or `hasUpdate:null` for "no usable information"). An
   * update check exists to be ignorable; it must never be able to paint the
   * settings page red or turn a page load into a 5xx.
   *
   * `force=1` bypasses the six-hour cache — the manual re-check, and the hook the
   * tests use to count real outbound requests. It does **not** bypass the switch:
   * a closed switch answers without asking anyone, whatever the query says.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  async function handleUpdateCheck(url, res) {
    sendJson(res, 200, await updateChecker.check({ force: url.searchParams.get('force') === '1' }));
  }

  /**
   * `GET /prompt-setting/assembly-status` — what this plugin observed about the
   * prompt's two layers for one session, plus the incremental feed a toaster
   * outside the settings page reads.
   *
   * The answer is a **pure read**: it never assembles, never probes and never
   * writes a notice. An unknown session (one this mount has not seen an assembly
   * for) answers `record: null` with `ok: true` — "nothing observed yet" is a
   * fact, not an error.
   *
   * The two verdicts are the goal's口径, and `basis` states them as data so the
   * page can render its own language rather than parse prose:
   *   - `assembly: 'plugin-return'` — the recorded text is the section list this
   *     plugin returned, and a `{prepend: true}` listener registered **after**
   *     this plugin may still rewrite it;
   *   - `delivery: 'surface-system-message'` — delivered means this step
   *     committed a `system/message` on the surface (append or head replace);
   *     `httpObservable: false` — whether the HTTP request was really sent is not
   *     observable from a plugin, and this route does not claim it.
   * @param url - the parsed request URL (`?session=`, `?since=`).
   * @param res - the Node response.
   */
  function handleReadAssemblyStatus(url, res) {
    const raw = url.searchParams.get('session');
    const sessionId = typeof raw === 'string' && raw.length > 0 ? raw : null;
    // The incremental feed is opt-in by query, so a plain read (the settings
    // page's own) can never consume a cursor it does not keep. A missing or
    // malformed `since` reads as "start from now": the answer still carries the
    // current cursor and `bootId` (that is how a fresh client learns where "now"
    // is without replaying history), but no notices. The cursor is the client's
    // optimisation, not a resource of this route, so a bad value is never an
    // error.
    const rawSince = url.searchParams.get('since');
    const since =
      typeof rawSince === 'string' && /^[0-9]{1,15}$/.test(rawSince.trim()) ? Number(rawSince.trim()) : null;
    sendJson(res, 200, {
      ok: true,
      enabled: assemblyNoticeEnabled(),
      session: sessionId,
      record: sessionId === null ? null : assemblyWatch.status(sessionId),
      counts: assemblyWatch.stats(),
      notifications: assemblyWatch.pendingNotices(since),
      basis: {
        assembly: 'plugin-return',
        delivery: 'surface-system-message',
        httpObservable: false,
        outerRewritePossible: true,
        // The Host collapses the whole section list onto the effective `complete`
        // section **after** the waterfall (`SystemPrompt.assemble()`), so the
        // recorded text is what this plugin returned, not necessarily what the
        // service finally kept — stated instead of hidden (review P2.3).
        postWaterfallCollapse: true,
      },
    });
  }

  /**
   * `PUT /prompt-setting/assembly-status` — record the notice switch.
   *
   * Same shape rules as the update switch (a non-boolean is the existing 400
   * `invalid-enabled`; an unwritable preference file is a 200 `ok:false`). The
   * write is merged into the current document, so it cannot erase the update
   * switch or a stored download region.
   * @param req - the Node request.
   * @param res - the Node response.
   */
  async function handleWriteAssemblyStatus(req, res) {
    const body = await readJsonBody(req);
    if (typeof body?.enabled !== 'boolean') {
      throw new OverrideError(
        'invalid-enabled',
        '"enabled" must be a boolean (true = show assembly-status notices, false = never show them)',
      );
    }
    const saved = setAssemblyNotice(body.enabled);
    sendJson(res, 200, {
      ok: saved.written,
      enabled: saved.enabled,
      saved: { enabled: saved.enabled },
      effectiveFrom: 'next-run',
      ...(saved.written
        ? { error: null }
        : { code: saved.error.code, message: saved.error.message, error: saved.error }),
    });
  }

  /**
   * `PUT /prompt-setting/update-check` — record the on/off switch.
   *
   * The switch is the one thing that makes this feature acceptable to ship: with
   * it off, the plugin makes **no outbound request at all**, including on mount.
   * The body is `{enabled: boolean}`; anything else is the existing 400
   * `invalid-enabled`, which is a *shape* refusal and therefore the one case that
   * is not a 200.
   *
   * A write that fails (an unwritable `$DSH_HOME`, say) is a 200 with
   * `ok:false` and `preferences-unwritable` rather than a 5xx — the page's
   * promise, "this feature never breaks the settings page", covers its own
   * configuration too.
   * @param req - the Node request.
   * @param res - the Node response.
   */
  async function handleWriteUpdateCheck(req, res) {
    const body = await readJsonBody(req);
    if (typeof body?.enabled !== 'boolean') {
      throw new OverrideError(
        'invalid-enabled',
        '"enabled" must be a boolean (true = check for updates, false = never ask)',
      );
    }
    const saved = updateChecker.setEnabled(body.enabled);
    sendJson(res, 200, {
      ok: saved.written,
      enabled: saved.enabled,
      saved: { enabled: saved.enabled },
      effectiveFrom: 'immediate',
      ...(saved.written
        ? { error: null }
        : { code: saved.error.code, message: saved.error.message, error: saved.error }),
    });
  }

  /**
   * `GET /prompt-setting/download-region` — which update source is in force?
   *
   * The answer is `{region, registry, custom, detected, stored, error}`. A stored
   * choice is returned with **no request at all**; with nothing stored the first
   * visit is decided here — npmjs reachable ⇒ `default`, npmjs unreachable while
   * npmmirror serves it ⇒ `cn`, neither ⇒ `default` — and the verdict is
   * written as an explicit choice flagged `detected:true`. While the update-check
   * switch is off the probe is **skipped** (the switch's promise is that off
   * means no outbound request at all, §17.4) and the conservative default is
   * answered without persisting it.
   *
   * Every outcome is a 200 and nothing here throws: a probe that times out, a
   * network error, a runtime with no `fetch` and an unwritable preference file
   * all degrade to a readable payload.
   * @param res - the Node response.
   */
  async function handleReadDownloadRegion(res) {
    sendJson(res, 200, await downloadRegion.ensure());
  }

  /**
   * `PUT /prompt-setting/download-region` — record the choice.
   *
   * The body is `{region, registry?}`. `region` must be one of the three ids;
   * anything else is the route's ordinary 400 `invalid-region`. A `custom` region
   * carries the address to validate, and **validation happens before the write**:
   * a malformed address, an unreachable mirror, a non-2xx answer and a 2xx that is
   * not a package document each answer `200 {ok:false, code, message}` — the
   * dialog renders that as its red line and the saved value is untouched. The
   * same 200-with-a-code shape covers an unwritable preference file: this route
   * never answers a 5xx for a failure of its own configuration.
   * @param req - the Node request.
   * @param res - the Node response.
   */
  async function handleWriteDownloadRegion(req, res) {
    const body = await readJsonBody(req);
    if (body === null || typeof body !== 'object' || Array.isArray(body) || isDownloadRegion(body.region) !== true) {
      throw new OverrideError('invalid-region', '"region" must be one of default, cn, custom');
    }
    const saved = await downloadRegion.set(body);
    if (saved.shape === true) {
      // Defensive: the shape was already checked above, so this is unreachable
      // unless the two disagree — and then the 400 is still the right answer.
      throw new OverrideError(saved.code, saved.message);
    }
    if (saved.ok !== true) {
      sendJson(res, 200, {
        ok: false,
        code: saved.code,
        message: saved.message,
        region: saved.region ?? null,
        registry: null,
        effectiveFrom: 'unchanged',
        ...(saved.reason === undefined ? {} : { reason: saved.reason }),
        ...(saved.status === undefined ? {} : { status: saved.status }),
      });
      return;
    }
    sendJson(res, 200, saved);
  }

  /**
   * The official plugin manager, looked up **optionally**.
   *
   * It is deliberately NOT added to {@link inject}: this plugin's own routes
   * exist without a plugin manager (every profile without the Web plugin
   * manager still serves the settings page), and a hard dependency would make
   * the whole plugin fail to load in such a profile. A missing service is
   * therefore a *value* — the install route answers a structured refusal — and
   * the three existing services are untouched.
   * @returns the service, or `null`.
   */
  function installService() {
    let service;
    try {
      service = ctx.get('pluginManager');
    } catch {
      return null;
    }
    if (service === null || typeof service !== 'object' || typeof service.installBundle !== 'function') return null;
    return service;
  }

  /**
   * The profile directory the manager installs into, or `null` when the service
   * does not expose one.
   *
   * `profile` is the manager's own `profileContext`, and `dir` is where its
   * `pnpm add` runs. Both are read defensively: this is a duck-typed dependency
   * on a service this plugin does not import, and a profile that answers a
   * different shape must degrade to "cannot check the install form" rather than
   * throw inside a route.
   * @param service - the plugin manager.
   * @returns the absolute profile directory, or `null`.
   */
  function installProfileDir(service) {
    try {
      const dir = service?.profile?.dir;
      return typeof dir === 'string' && dir.length > 0 ? dir : null;
    } catch {
      return null;
    }
  }

  /**
   * How this profile declares `dsh-prompt-setting`, read from the profile's own
   * manifest. This is the A1 check's input: a `link:` here means the running
   * copy is a development working tree, not an install.
   * @param dir - the profile directory.
   * @returns `{value, error}`; `value` is the dependency spec or `null`.
   */
  function installDependencyField(dir) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const value = manifest?.dependencies?.[PLUGIN_NAME];
      return { value: typeof value === 'string' ? value : null, error: null };
    } catch (error) {
      if (error?.code === 'ENOENT') return { value: null, error: null };
      return { value: null, error: summarizeDiagnostic(error?.message ?? String(error)) };
    }
  }

  /**
   * One `HEAD` against the release asset.
   *
   * A HEAD is the whole cost of turning "the release has no asset" into a named,
   * immediate answer instead of a two-minute pnpm failure. A transport that
   * cannot answer (no fetch, a throw, a 5xx) returns `unverified`, which means
   * "install anyway and let pnpm decide": the probe is a shortcut, never a gate.
   * @param url - the asset URL.
   * @returns `{status, ok, error}`; `status` is `0` when no answer arrived.
   */
  async function probeReleaseAsset(url) {
    if (installProbe === null) return { status: 0, ok: false, error: 'this runtime offers no fetch' };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    try {
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          controller?.abort();
          reject(new Error(`the release asset probe did not answer within ${UPDATE_ASSET_PROBE_TIMEOUT_MS} ms`));
        }, UPDATE_ASSET_PROBE_TIMEOUT_MS);
      });
      const response = await Promise.race([
        installProbe(url, {
          method: 'HEAD',
          headers: { 'user-agent': `${PLUGIN_NAME}/${PLUGIN_VERSION}` },
          ...(controller === null ? {} : { signal: controller.signal }),
        }),
        timeout,
      ]);
      const status = Number.isFinite(response?.status) ? response.status : 0;
      return { status, ok: response?.ok === true, error: null };
    } catch (error) {
      return { status: 0, ok: false, error: summarizeDiagnostic(error?.message ?? String(error)) };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * `POST /prompt-setting/update-apply` — start one install and answer at once.
   *
   * The answer is `{ok:true, requestId, status}` before any package manager has
   * run: the install can block for minutes, and the page polls
   * `GET /update-apply` for the outcome. Everything that can be decided cheaply
   * is decided **before** the install starts, and a refusal (`no update`,
   * `link:` profile, a missing service, an update check rate-limited to no
   * answer) is a **200** with `{ok:false, code, message}` — never a 5xx, and
   * never a background job.
   *
   * The tag/version pair is read off the checker's own payload — the same
   * answer the banner rendered, cached for six hours — so the version the page
   * announced and the version installed cannot drift apart. A body that names a
   * different tag is refused rather than ignored.
   * @param req - the Node request.
   * @returns the response body; the caller sends it (this function never writes
   *   to the response, so it stays a value-returning handler like the others).
   */
  async function handleStartInstall(req) {
    const body = await readJsonBody(req);
    const check = await updateChecker.check();
    const target = resolveInstallTarget(check);
    if (target.ok !== true) {
      // Nothing was started, so there is no request to track: the refusal is the
      // whole answer, and the client's error path renders it like any other.
      return publicRefusal(target.code, target.message, { releaseUrl: target.releaseUrl });
    }
    const claimed = typeof body?.tag === 'string' && body.tag.trim().length > 0 ? body.tag.trim() : null;
    if (claimed !== null && claimed !== target.tag) {
      return publicRefusal(
        REFUSAL_INVALID_REQUEST,
        `this request names tag ${JSON.stringify(claimed)} but the current update check reported ${JSON.stringify(target.tag)}; check for updates again`,
      );
    }
    // One install at a time: a second `pnpm add` would queue on the profile lock
    // (measured up to ~2 minutes) behind the first. The running request's id is
    // returned instead, which is also what the page should be polling.
    const running = installTable.active();
    if (running !== null) {
      return { ok: true, reused: true, status: publicInstallStatus(running), launchKind: launchKindOf(ctx) };
    }
    const service = installService();
    const profileDir = service === null ? null : installProfileDir(service);
    const field = profileDir === null ? null : installDependencyField(profileDir);
    const policy = resolveInstallPolicy({
      service,
      profileDir,
      field: field === null ? null : field.value,
      // An unreadable/unparsable profile manifest refuses rather than passing as
      // "this profile does not declare the package": the install form was never
      // established, and A1's whole point is not to write to a profile we could
      // not inspect. `installDependencyField` answers `null` for a **missing**
      // file, so "restore a real install" still works.
      fieldError: field === null ? null : field.error,
      tag: target.tag,
    });
    if (policy.ok !== true) {
      return publicRefusal(policy.code, policy.message, policy.manual);
    }
    // g-032 (real-machine fix): the profile already holds exactly this artifact.
    //
    // `pnpm add <the same spec>` changes no dependency, and the official manager
    // then cannot find the one new dependency it expects and throws
    // `ambiguous-install` (`dsh-plugin-manager/lib/index.js:1782`). The user's
    // second click is not a failure — everything the button promised is already
    // true, and the only remaining step is the restart they were going to do
    // anyway. So this is answered as a **success with nothing to install**, with
    // no manager call at all: no two-minute pnpm round trip, and no misleading
    // red line. A *different* spec (an older tarball URL, an npm version, a
    // registry range) still installs normally.
    if (isAlreadyInstalledOn(field === null ? null : field.value, target.url)) {
      const entry = installTable.begin({ tag: target.tag, version: target.version, url: target.url, source: target.source });
      installTable.settle(entry.requestId, { changed: false, application: 'restart-required' });
      return {
        ok: true,
        reused: false,
        alreadyInstalled: true,
        status: publicInstallStatus(installTable.read(entry.requestId)),
        launchKind: launchKindOf(ctx),
      };
    }
    const entry = installTable.begin({ tag: target.tag, version: target.version, url: target.url, source: target.source });
    void runInstall(entry.requestId, { service, target });
    return {
      ok: true,
      reused: false,
      status: publicInstallStatus(installTable.read(entry.requestId)),
      launchKind: launchKindOf(ctx),
    };
  }

  /**
   * Run one install in the background and settle its row.
   *
   * This is the only place the plugin manager is called, and it is called with
   * exactly four facts: the tarball spec, `{enabled: true, requestId}`.
   * `approvedBuilds` is deliberately absent — passing it writes the profile's
   * `allowBuilds`, which would let a **later** install run arbitrary package
   * scripts — and the whole thing runs on its own promise so the HTTP response
   * returned long ago stays valid.
   *
   * Nothing here restarts anything. `ChangeResult.application` is the verdict
   * the page is told about, and `restart-required` is a **success** whose
   * instruction is selected by the launch shape on the page (g-036: re-run
   * `dsh web`, or quit and reopen DeepSeek Harness).
   * @param requestId - the tracked request.
   * @param context - `{service, target}`.
   */
  async function runInstall(requestId, context) {
    const { service, target } = context;
    try {
      const probe = await probeReleaseAsset(target.url);
      // The probe is a **shortcut, never a gate**: only "the asset is definitely
      // not there / definitely not reachable anonymously" refuses. `404`/`410`
      // mean the release carries no such asset, and `401`/`403` mean it
      // cannot be fetched anonymously. **Every other answer is "I could not find
      // out" and must NOT block an install**: `500`, `429`, `405`, a redirect
      // that never resolved, a throw, no `fetch` at all. The probe exists to
      // answer the *expected* case in seconds; a probe that cannot answer falls
      // through to pnpm's own verdict instead of becoming a refusal the person
      // cannot act on (CONTRACT §18.2).
      const refusal = probe.status === 404 || probe.status === 410
        ? REFUSAL_ASSET_MISSING
        : probe.status === 401 || probe.status === 403
          ? REFUSAL_ASSET_UNVERIFIED
          : null;
      if (refusal !== null) {
        const described = describeInstallFailure(refusal, { tag: target.tag, version: target.version, source: target.source });
        installTable.fail(requestId, {
          code: described.code,
          message: described.message,
          diagnostic: `${target.url} answered HTTP ${probe.status}`,
          manual: described.manual,
          retryable: described.retryable,
        });
        return;
      }
      // The call itself. `enabled: true` is the conservative value for an
      // **already-installed** bundle: the profile already selects it, so the
      // manager's own `selectBundle(name, true)` is a no-op write, while
      // `false` would express "leave it unselected" for a package that is
      // currently running. `before[name]` is already populated, so the manager
      // returns `restart-required` — it reloads nothing, which is exactly the
      // no-auto-restart rule this feature ships under.
      const result = await service.installBundle(target.url, { enabled: true, requestId });
      installTable.settle(requestId, result);
    } catch (error) {
      // `change()` folds every ordinary failure into its result, so a throw here
      // is a lock/transport-level surprise. It still settles the row rather than
      // escaping: an unhandled rejection would take the host process with it.
      installTable.fail(requestId, {
        code: classifyInstallFailure({ message: error?.message }),
        message: `the install could not be started: ${summarizeDiagnostic(error?.message ?? String(error)) ?? 'unknown error'}`,
        diagnostic: summarizeDiagnostic(error?.stack ?? error?.message ?? String(error)),
        retryable: true,
      });
    }
  }

  /**
   * `GET /prompt-setting/update-apply?requestId=` — the tracked phase.
   *
   * Three shapes, three meanings:
   *   - `?requestId=<id>` for an id this mount knows answers the request's
   *     phase, application verdict and structured error;
   *   - `?requestId=<id>` for anything else answers `200` with
   *     `status:'unknown'` — the official manager deletes a settled request, so
   *     a page that reloaded mid-install has to be told "this page no longer
   *     knows", which is honest and distinguishable from a failed install;
   *   - **no** `requestId` at all is not a shape mistake: it is a fresh page
   *     asking "is anything installing?". The answer is this mount's oldest
   *     live request (or `null`), which is how a reloaded tab resumes polling an
   *     install it can no longer name.
   *
   * Only an empty or absurdly long id is the ordinary `400 invalid-request`.
   * @param url - the parsed request URL.
   * @returns the response body.
   */
  function handleInstallStatus(url) {
    const requestId = url.searchParams.get('requestId');
    if (requestId === null) {
      // g-032: no id at all is not a shape mistake — it is a **fresh page**
      // asking "is anything installing?". The host answers with its own oldest
      // live request (or `null`), which is what lets a reloaded tab resume
      // polling the install it can no longer name. It can only ever name a
      // request this mount started.
      const live = installTable.oldestLive();
      return { ok: true, status: live === null ? null : publicInstallStatus(live), launchKind: launchKindOf(ctx) };
    }
    if (requestId.trim().length === 0) {
      throw new OverrideError('invalid-request', 'query parameter "requestId" must not be empty');
    }
    if (requestId.length > 128) {
      throw new OverrideError('invalid-request', '"requestId" is too long to be one of ours');
    }
    return { ok: true, status: publicInstallStatus(installTable.read(requestId.trim())), launchKind: launchKindOf(ctx) };
  }

  /**
   * `POST /prompt-setting/update-apply/cancel` — stop a running install.
   *
   * The official `cancelInstall` resolves only after the install itself has
   * settled (files restored), which can be minutes — so it is **not** awaited
   * here. The intent is recorded in the table, which is what the page's next
   * poll reads, and the manager is asked in the background. An id that is not
   * live answers `{ok:false, code:'not-running'}` with a 200: nothing was
   * cancelled, and that is a fact about the request, not a server error.
   * @param req - the Node request.
   * @returns the response body.
   */
  async function handleCancelInstall(req) {
    const body = await readJsonBody(req);
    const requestId = typeof body?.requestId === 'string' ? body.requestId.trim() : '';
    if (requestId.length === 0) {
      throw new OverrideError('invalid-request', '"requestId" must be a non-empty string');
    }
    const entry = installTable.read(requestId);
    if (entry.known !== true) {
      return { ok: false, code: 'not-running', status: publicInstallStatus(entry), launchKind: launchKindOf(ctx) };
    }
    if (entry.cancellable !== true) {      // Settled, or past the point of no return. Saying so is the useful answer;
      // pretending to cancel a finished install would be a lie the next poll
      // would contradict.
      return { ok: false, code: 'not-running', status: publicInstallStatus(entry), launchKind: launchKindOf(ctx) };
    }
    installTable.markCancelling(requestId);
    const service = installService();
    if (service !== null && typeof service.cancelInstall === 'function') {
      // Fire and forget: the outcome reaches the page through the poll, and this
      // route may not block on a settle that takes minutes.
      Promise.resolve()
        .then(() => service.cancelInstall(requestId))
        .catch(() => {
          // A cancel that the manager refuses (a lock error, a teardown) leaves
          // the install running; the poll still reports the truth.
        });
    }
    return {
      ok: true,
      code: 'cancelling',
      status: publicInstallStatus(installTable.read(requestId)),
      launchKind: launchKindOf(ctx),
    };
  }

  /**
   * The one refusal shape, so the client has a single `ok:false` branch to read.
   * @param code - the stable refusal code.
   * @param message - the readable sentence.
   * @param manual - the manual-update hint (`{releaseUrl, releaseLink, command}`), or undefined.
   * @returns the body.
   */
  function publicRefusal(code, message, manual) {
    return {
      ok: false,
      code: typeof code === 'string' && code.length > 0 ? code : REFUSAL_SERVICE_MISSING,
      message: typeof message === 'string' && message.length > 0 ? message : 'the update could not be started',
      // g-036: a refusal is still an `update-apply` answer, so it carries the
      // same launch shape as a started install — one response shape per route,
      // whatever the verdict.
      launchKind: launchKindOf(ctx),
      ...(manual === undefined || manual === null ? {} : { manual }),
    };
  }

  /**
   * `GET /prompt-setting/interpolate` — the read face of the reserved section's
   * variable-substitution switch.
   *
   * `interpolateCustom` is the **effective** value a session's assembly will use
   * (user layer, else workspace layer, else the shipped default of ON);
   * `layers.user` / `layers.workspace` are what each layer itself states, where
   * `null` means "states nothing" — a distinction the UI needs, because OFF and
   * unstated are different values and only the second one inherits (CONTRACT
   * §16.1).
   *
   * `variables` is the assembled variable table's key set, or `null` when this
   * mount could not obtain one; the browser uses it to say what is available
   * instead of guessing. `variablesError` says why when it is null.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  function handleReadInterpolate(url, res) {
    const sessionId = url.searchParams.get('session');
    const workspace = workspaceContext(sessionId);
    sendJson(res, 200, {
      ok: true,
      interpolateCustom: effectiveInterpolate(state.user.config ?? emptyConfig(), workspace.config),
      layers: {
        user: interpolateFlagOf(state.user.config) ?? null,
        workspace: interpolateFlagOf(workspace.config) ?? null,
      },
      variables: state.variables === null ? null : Object.keys(state.variables),
      variablesError: state.variablesError,
    });
  }

  /**
   * `PUT /prompt-setting/interpolate` — set the switch to one of its three
   * states (Revision 12, audit F4).
   *
   * Order is the whole safety story, and it is the same order every other write
   * route uses: shape, then policy, then the current file, then the check that
   * can only be done with a live assembly, and only then a byte. A refusal
   * therefore leaves both layers byte-identical
   * (`test/route.test.mjs` hashes them around every rejection).
   *
   * Two spellings, one meaning each — deliberately not the same thing:
   * - `{"enabled": true|false}` is the two-valued form kept byte-compatible for
   *   every existing client and test. `true` states ON; `false` returns the
   *   layer to **unstated**, which is what makes on→off an exact byte revert and
   *   is the only reason the absent-key contract survives Revision 12;
   * - `{"state": "inherit"|"on"|"off"}` is the three-valued form. `off` writes
   *   the boolean `false`, which the two-valued form cannot express — without
   *   it, a workspace layer could never close a switch the user layer opened,
   *   and the UI would show OFF while the session really inherits ON.
   *
   * Only a transition to ON validates the text **already stored**, because
   * arming is what makes an old `{{typo}}` reachable by the expansion — and a
   * reference that can never expand is a trap for the user (since Revision 15
   * this is UX, not safety: §16.9). `off` and `inherit` can only make text
   * safer. The advisories of that check are returned rather than dropped
   * (audit F2).
   * @param req - the Node request.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  async function handleWriteInterpolate(req, url, res) {
    const body = await readJsonBody(req);
    const nextState = resolveSwitchState(body);
    const layer = body?.layer === undefined || body?.layer === null ? 'user' : body.layer;
    if (!LAYERS.includes(layer)) {
      throw new OverrideError('unknown-layer', `"layer" must be one of ${LAYERS.join(', ')}`);
    }
    const sessionId = typeof body?.session === 'string' && body.session.length > 0
      ? body.session
      : url.searchParams.get('session');
    const target = targetFor(layer, sessionId);
    const current = writableConfig(target.path);
    const next = withState(current, nextState);
    const resulting = switchStateOf(next);
    const warnings = nextState === 'on'
      ? assertStoredTextsInterpolatable(next, target, await variablesForWrite())
      : [];
    writeConfig(target.path, next);
    cacheWritten(target, next);
    // Nothing else to do here: what the next turn renders is decided per
    // assembly, from the config that assembly resolves for its own context
    // (Revision 15: `expandReservedSection` inside `assembleHandler`).
    sendJson(res, 200, withWarnings({
      ok: true,
      interpolateCustom: effectiveInterpolate(
        state.user.config ?? emptyConfig(),
        workspaceConfigFor(sessionId),
      ),
      layer,
      state: resulting,
      saved: { enabled: resulting === 'on', state: resulting },
      effectiveFrom: 'next-turn',
    }, warnings));
  }

  /**
   * Resolve the switch request body into one of the three states.
   *
   * `state` wins when present; the boolean `enabled` is the legacy spelling. A
   * body that states neither is the pre-Revision-12 `invalid-enabled` refusal,
   * with the same code so an existing client reads the same answer.
   * @param body - the parsed request body.
   * @returns `inherit` | `on` | `off`.
   * @throws {OverrideError} `400 invalid-state` / `400 invalid-enabled`.
   */
  function resolveSwitchState(body) {
    const requested = body?.state;
    if (requested !== undefined && requested !== null) {
      if (typeof requested !== 'string' || !INTERPOLATE_STATES.includes(requested)) {
        throw fail(
          'invalid-state',
          `"state" must be one of ${INTERPOLATE_STATES.join(', ')} (inherit = the layer states nothing, on/off = the layer states it)`,
        );
      }
      return requested;
    }
    if (typeof body?.enabled !== 'boolean') {
      throw fail(
        'invalid-enabled',
        '"enabled" must be a boolean (true opens the switch, false returns the layer to unstated), or "state" must be one of inherit/on/off',
      );
    }
    return body.enabled === true ? 'on' : 'inherit';
  }

  /**
   * `PUT /prompt-setting/overrides` — upsert one override into one layer.
   *
   * Since Revision 7 the write face is one section wide: the body's name must
   * be the reserved {@link CUSTOM_SECTION_NAME} ({@link assertWritableSection})
   * and its action must be one of the reserved name's writable actions —
   * `replace` (覆盖) or, since Revision 36, `append` (叠加). The policy is
   * evaluated before the layer is resolved, before the current config is read
   * and therefore before any byte is written, so a rejected write leaves the
   * layer's file byte-identical (`test/route.test.mjs` hashes it around every
   * rejection).
   *
   * Revision 36 also decides where「叠加」is turned into text: **not here**. This
   * handler stores the word the panel sent, in that layer's own file and in no
   * other; `mergeLayers` (`core/overrides.js`) is the one place that reads it
   * and joins the two layers' texts into the single section the assembly
   * applies. Keeping the two apart is what makes the mode persistable without
   * either file ever learning about the other one.
   * @param req - the Node request.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  async function handleWriteOverride(req, url, res) {
    const body = await readJsonBody(req);
    const layer = body?.layer;
    if (!LAYERS.includes(layer)) {
      throw new OverrideError('unknown-layer', `"layer" must be one of ${LAYERS.join(', ')}`);
    }
    assertWritableSection(body?.section);
    const override = validateOverride(body?.section);
    const sessionId = typeof body?.session === 'string' && body.session.length > 0
      ? body.session
      : url.searchParams.get('session');
    const target = targetFor(layer, sessionId);
    const current = writableConfig(target.path);
    const at = current.overrides.findIndex((entry) => entry.name === override.name);
    const before = at === -1 ? null : current.overrides[at];
    const next = upsertOverride(current, override);
    // Revision 9: the text about to be written is checked against the live
    // variable table BEFORE any byte moves, so a refusal leaves the file
    // byte-identical. Revision 12 (audit F1) decides the check from **every**
    // visible layer's state rather than this layer's own switch: see
    // `assertTextInterpolatable`. The advisories it returns are put on the
    // response instead of being dropped (audit F2).
    const warnings = await assertTextInterpolatable(override, next, target);
    writeConfig(target.path, next);
    cacheWritten(target, next);
    // g-062: a save of the reserved section is exactly the change the session's
    // next run has to report on. Noted after the write succeeded, read from the
    // body rather than re-read from disk, and unable to affect the response.
    if (override.name === CUSTOM_SECTION_NAME) {
      notePromptWrite({
        layer,
        // Contract §21.4: a `user`-layer save addresses **every** session, so a
        // `?session=` the page happens to carry must not scope it to one
        // (review W3). Only a workspace write names a session.
        session: layer === 'workspace' ? sessionId ?? null : null,
        action: override.action,
        text: override.action === 'hide' ? '' : override.text,
      });
    }
    // History is written after the config it describes, and a history failure
    // never turns a successful save into an error (CONTRACT §8.4).
    recordHistory({
      path: target.path,
      at: new Date().toISOString(),
      layer,
      session: sessionId ?? null,
      action: actionOf(before, override),
      name: override.name,
      origin: 'ui',
      before: textEntry(before === null ? null : before.text),
      after: textEntry(override.action === 'hide' ? null : override.text),
      snapshot: snapshotOfConfig(next),
    });
    sendJson(res, 200, withWarnings({
      ok: true,
      saved: { ...override, layer },
      effectiveFrom: 'next-turn',
    }, warnings));
  }

  /**
   * `DELETE /prompt-setting/overrides` — drop one override from one layer,
   * clear the whole layer with `?reset=true`, or clear only its frozen
   * overrides with `?legacy=true`.
   *
   * Since Revision 7 the single-name form accepts only the reserved section
   * name ({@link assertDeletableName}), and that verdict runs **before** the
   * `404 override-not-found` lookup. `reset=true` keeps its stage 2 meaning
   * (the whole layer, reserved entry included). `legacy=true` is the new one:
   * it removes every non-reserved override and keeps the reserved one, which is
   * the only way back from "frozen read-only" to a clean layer without hand
   * editing the file. The two query flags are mutually exclusive.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  function handleDeleteOverride(url, res) {
    const layer = url.searchParams.get('layer');
    const sessionId = url.searchParams.get('session');
    // The shape check first, exactly as `PUT` does it: a request that names no
    // layer this plugin has is a 400 whatever else it carries.
    if (!LAYERS.includes(layer)) {
      throw new OverrideError('unknown-layer', `"layer" must be one of ${LAYERS.join(', ')}`);
    }
    const reset = url.searchParams.get('reset') === 'true';
    const legacy = url.searchParams.get('legacy') === 'true';
    if (reset && legacy) {
      throw new OverrideError(
        'conflicting-query',
        '"reset" clears the whole layer and "legacy" clears only its frozen overrides; supply one, not both',
      );
    }
    if (reset) {
      handleResetLayer(layer, sessionId, res);
      return;
    }
    if (legacy) {
      handleLegacyClear(layer, sessionId, res);
      return;
    }
    const name = url.searchParams.get('name');
    if (name === null || name.length === 0) {
      throw new OverrideError('missing-name', 'query parameter "name" is required');
    }
    if (name.length > MAX_NAME_LENGTH) {
      throw new OverrideError('name-too-long', `"name" exceeds ${MAX_NAME_LENGTH} characters`);
    }
    assertDeletableName(name);
    const target = targetFor(layer, sessionId);
    const current = writableConfig(target.path);
    const at = current.overrides.findIndex((entry) => entry.name === name);
    const { config, removed } = removeOverride(current, name);
    if (!removed) {
      throw new OverrideError('override-not-found', `no ${layer} override for section ${JSON.stringify(name)}`, 404);
    }
    writeConfig(target.path, config);
    cacheWritten(target, config);
    // g-062: dropping the reserved entry changes the prompt this layer
    // contributes, so the layer's next run reports it like any other save.
    if (name === CUSTOM_SECTION_NAME) {
      // §21.4: only a workspace write is scoped to one session (review W3).
      notePromptWrite({ layer, session: layer === 'workspace' ? sessionId ?? null : null, action: 'hide', text: '' });
    }
    recordHistory({
      path: target.path,
      at: new Date().toISOString(),
      layer,
      session: sessionId ?? null,
      action: actionOf(current.overrides[at] ?? null, null),
      name,
      origin: 'ui',
      before: textEntry(current.overrides[at]?.text ?? null),
      after: null,
      snapshot: snapshotOfConfig(config),
    });
    sendJson(res, 200, { ok: true, removed: true, layer, name, effectiveFrom: 'next-turn' });
  }

  /**
   * Clear one layer and record what was removed.
   *
   * Resetting an already-empty layer is a success with `count: 0` and no
   * history record: there was no change to log. The layer's file is still
   * written empty, which makes "reset" observable on disk rather than implied.
   * @param layer - `user` | `workspace`.
   * @param sessionId - the session id, or null.
   * @param res - the Node response.
   */
  function handleResetLayer(layer, sessionId, res) {
    const target = targetFor(layer, sessionId);
    const current = writableConfig(target.path);
    const removed = current.overrides.slice();
    if (removed.length === 0) {
      sendJson(res, 200, {
        ok: true,
        reset: true,
        layer,
        removed: [],
        count: 0,
        effectiveFrom: 'next-turn',
        history: null,
      });
      return;
    }
    const config = emptyConfig();
    writeConfig(target.path, config);
    cacheWritten(target, config);
    // g-062: a reset that took the reserved entry away is a prompt change; a
    // reset of a layer that never held one is not.
    if (removed.some((entry) => entry.name === CUSTOM_SECTION_NAME)) {
      // §21.4: only a workspace write is scoped to one session (review W3).
      notePromptWrite({ layer, session: layer === 'workspace' ? sessionId ?? null : null, action: 'hide', text: '' });
    }
    const history = recordHistory({
      path: target.path,
      at: new Date().toISOString(),
      layer,
      session: sessionId ?? null,
      action: RESET_ACTION,
      name: null,
      origin: 'ui',
      before: null,
      after: null,
      entries: resetEntries(removed),
      snapshot: [],
      note: `reset removed ${removed.length} override(s)`,
    });
    sendJson(res, 200, {
      ok: true,
      reset: true,
      layer,
      removed: removed.map((entry) => entry.name),
      count: removed.length,
      entries: resetEntries(removed),
      effectiveFrom: 'next-turn',
      history,
    });
  }

  /**
   * Remove a layer's frozen (non-reserved) overrides and keep the reserved one.
   *
   * The response is the reset response with `legacy` in place of `reset`, so a
   * client that already renders one renders the other (CONTRACT §12.2).
   *
   * Two deliberate details:
   * - a layer with nothing legacy in it is a success with `count: 0` and **no
   *   file write at all** — like a reset of an empty layer, the file is left
   *   exactly as it was, because "there was nothing to remove" must not be
   *   recorded as a write;
   * - the removal is logged as {@link LEGACY_CLEAR_ACTION}, not as a reset: the
   *   layer afterwards still holds the reserved override, and a history reader
   *   must be able to tell that apart from a full clear.
   * @param layer - `user` | `workspace`.
   * @param sessionId - the session id, or null.
   * @param res - the Node response.
   */
  function handleLegacyClear(layer, sessionId, res) {
    const target = targetFor(layer, sessionId);
    const current = writableConfig(target.path);
    const { removed, next } = legacyPlan(current.overrides, interpolateFlagOf(current));
    if (removed.length === 0) {
      sendJson(res, 200, {
        ok: true,
        legacy: true,
        layer,
        removed: [],
        count: 0,
        effectiveFrom: 'next-turn',
        history: null,
      });
      return;
    }
    const config = next;
    writeConfig(target.path, config);
    cacheWritten(target, config);
    const entries = resetEntries(removed);
    const history = recordHistory({
      path: target.path,
      at: new Date().toISOString(),
      layer,
      session: sessionId ?? null,
      action: LEGACY_CLEAR_ACTION,
      name: null,
      origin: 'ui',
      before: null,
      after: null,
      entries,
      snapshot: snapshotOfConfig(config),
      note: `legacy clear removed ${removed.length} frozen override(s)`,
    });
    sendJson(res, 200, {
      ok: true,
      legacy: true,
      layer,
      removed: removed.map((entry) => entry.name),
      count: removed.length,
      entries,
      effectiveFrom: 'next-turn',
      history,
    });
  }

  /**
   * The preset library as this mount reads it: path plus the store's verdict.
   *
   * Read per request, never cached: the library is a user file that another
   * process (or a hand edit) may change between two clicks, exactly like the
   * two override layers, and it is off the assembly path either way.
   * @returns `{path, document, missing, error}`.
   */
  function presetsFile() {
    const path = userPresetsPath();
    const read = readPresets(path);
    return { path, ...read };
  }

  /**
   * The library a **write** may modify, refusing to overwrite a file this
   * revision does not understand.
   *
   * The same rule `writableConfig` applies to a layer: a malformed library is
   * reported and left alone, so a save can never destroy a file the user is
   * still holding the pieces of. Reads stay permissive (the read face answers
   * the reason instead).
   * @returns `{path, document}`.
   * @throws {OverrideError} 409 `presets-not-writable`.
   */
  function writablePresets() {
    const file = presetsFile();
    if (file.error !== null) {
      throw new OverrideError(
        'presets-not-writable',
        `${file.path} is not a valid presets library (${file.error.code}: ${file.error.message}); fix or remove it before saving`,
        409,
      );
    }
    return { path: file.path, document: file.document };
  }

  /** The `session` a preset body/query names, or null. */
  function presetSessionOf(body, url) {
    if (typeof body?.session === 'string' && body.session.length > 0) return body.session;
    return url.searchParams.get('session');
  }

  /**
   * `GET /prompt-setting/presets` — the catalogue and where it is applied.
   *
   * Always `200`: the library is one user file, and a file this revision cannot
   * understand is reported in `error` beside an empty catalogue rather than
   * failing the page — the page then says「库文件不可读」and the write routes
   * refuse with the same reason. `workspaceRoot` is present only when the caller
   * named a session this profile can resolve, so the page can tell「当前工作区
   * 已应用哪个预设」without a second lookup; an unresolvable session is `null`
   * here and never an error on a read.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  function handleReadPresets(url, res) {
    const file = presetsFile();
    const sessionId = url.searchParams.get('session');
    const root = typeof sessionId === 'string' && sessionId.length > 0 ? workspaceRootFor(sessionId).root : null;
    sendJson(res, 200, {
      ok: true,
      path: file.path,
      version: file.document.version,
      presets: publicPresets(file.document),
      applied: publicApplied(file.document),
      workspaceRoot: root,
      error: file.error === null ? null : { code: file.error.code, message: file.error.message },
    });
  }

  /**
   * `PUT /prompt-setting/presets` — insert one preset, or edit one by id.
   *
   * Order is the contract, as on every other write route: request shape first
   * ({@link validatePresetInput} answers `400` for every field-level mistake),
   * then the current library (`409` when it is unusable), and only then a byte.
   * A body without `id` inserts and the **Host** mints the id; a body with an id
   * must name an existing preset (`404 preset-not-found`), because「编辑」
   * silently becoming「新建」would let a stale page duplicate instead of report.
   * @param req - the Node request.
   * @param res - the Node response.
   */
  async function handleWritePreset(req, res) {
    const body = await readJsonBody(req);
    const fields = validatePresetInput(body);
    const editing = body?.id !== undefined && body?.id !== null;
    const id = editing ? validatePresetId(body.id, 'invalid-id') : randomUUID();
    const file = writablePresets();
    const at = new Date().toISOString();
    const result = upsertPreset(file.document, editing ? { ...fields, id } : fields, { id, at });
    writePresets(file.path, result.document);
    sendJson(res, 200, {
      ok: true,
      created: result.created,
      preset: result.preset,
      presets: publicPresets(result.document),
      applied: publicApplied(result.document),
    });
  }

  /**
   * `DELETE /prompt-setting/presets?id=` — drop one preset, and with it **every
   * application of it** (Revision 50).
   *
   * Deleting a preset that is currently applied used to be a catalogue-only
   * write: the workspace kept the text it was given and its record became an
   * orphan. That state is real but it is not what「删除」means to the person
   * clicking it — the text they asked to be rid of stayed in the prompt, under a
   * name no longer in the library. So the deletion now **cancels** the
   * applications first, through the same kernel「取消应用」uses
   * ({@link planPresetRemoval} → `planUnapply`): each affected workspace's layer
   * is recomposed from `base` plus the links that remain, the last link restores
   * `base` itself (`null` ⇒ the reserved entry is removed), and nothing else in
   * the layer is touched. Only then is the library written.
   *
   * **Atomic, in the only order that can be.** Every affected layer is read and
   * planned **before** the first write, so a workspace whose layer is unusable
   * refuses the whole request with nothing changed: never "the preset is gone
   * and the layer is not". A failure inside the commit loop (an I/O error after
   * some layers were already restored) stops there too — the preset is **not**
   * deleted, and the refusal names which workspaces were restored and which were
   * not (§20.4, §20.7 `preset-unapply-failed`). The residual risk is stated
   * rather than hidden: that second failure can leave some workspaces restored
   * with the preset still in the library, which is the recoverable direction of
   * the trade (the user can delete again, or cancel the remaining applications by
   * hand).
   *
   * **A layer that is gone is skipped, not recreated** (g-069 review A). When the
   * `applied` record points at a workspace root the user has since deleted, there
   * is no text to restore and the request must not build one: `writeConfig` would
   * `mkdirSync` the whole `.dsh-prompt-setting` tree back. That workspace is
   * planned as `missing`, its links still come off the record (no orphan is left
   * behind), and it is reported as `missing: true` / `restored: false` without
   * being counted in `restoredWorkspaces`. The opposite case — a layer file that
   * exists but cannot be read or parsed — is still a refusal.
   *
   * `?session=` is resolution only, exactly as on the read face (§20.2): when the
   * caller names one, the workspace it resolves to is the one whose history
   * record carries that session; every other restored workspace is logged without
   * one, the existing spelling for a workspace write no session asked for.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  function handleDeletePreset(url, res) {
    const raw = url.searchParams.get('id');
    if (raw === null || raw.length === 0) {
      throw fail('missing-id', 'query parameter "id" is required');
    }
    const id = validatePresetId(raw);
    const file = writablePresets();
    if (presetById(file.document, id) === null) {
      throw fail('preset-not-found', `no preset with id ${JSON.stringify(id)}`, 404);
    }
    const affected = appliedRootsOf(file.document, id);
    const rawSession = url.searchParams.get('session');
    const sessionId = typeof rawSession === 'string' && rawSession.length > 0 ? rawSession : null;
    const sessionRoot = sessionId === null ? null : workspaceRootFor(sessionId).root;
    const at = new Date().toISOString();
    // Phase 1 — read and plan every affected layer. Nothing is written here, so
    // any refusal (an unusable layer, an unknown workspace) leaves both files
    // byte-identical and the preset in the library.
    //
    // g-069 review A: a layer file that is **gone** (ENOENT) is not a refusal and
    // not a restore. It is planned as `missing` — the record's links are cancelled
    // so the deletion still leaves no orphan, but the route writes, caches and
    // logs nothing for that workspace: `writeConfig` would `mkdirSync` the
    // directory tree the user deleted. A layer that **exists but cannot be read**
    // stays a refusal (the read throws), which is the behaviour the negative
    // control pins.
    let plan;
    let reading = null;
    const absent = [];
    try {
      plan = planPresetRemoval(file.document, {
        presetId: id,
        currentOf: (root) => {
          reading = root;
          const path = workspaceConfigPath(root);
          const read = readConfig(path);
          if (read.error !== null) {
            throw new OverrideError(
              'layer-not-writable',
              `${path} is not a valid config (${read.error.code}: ${read.error.message}); fix or remove it before saving`,
              409,
            );
          }
          if (read.missing === true) {
            absent.push(root);
            return null;
          }
          return read.config;
        },
      });
    } catch (error) {
      const reason = error instanceof OverrideError
        ? `${error.code}: ${error.message}`
        : `${error?.message ?? String(error)}`;
      throw fail(
        'preset-unapply-failed',
        `${restoreRefusal('restoring', reading, affected, [], absent)} (${reason}); the preset was NOT deleted`,
        error instanceof OverrideError ? error.status : 500,
      );
    }
    if (plan.removed === null) {
      throw fail('preset-not-found', `no preset with id ${JSON.stringify(id)}`, 404);
    }
    // Phase 2 — commit. The library is written **last**, after every layer write
    // has succeeded, so the record always describes a state that really exists.
    const restored = [];
    let committing = null;
    try {
      for (const entry of plan.plans) {
        // No layer file, nothing to put back: the links are already off the
        // record (§20.4), and inventing the layer here is the defect this branch
        // exists to prevent.
        if (entry.missing === true) continue;
        committing = entry.workspaceRoot;
        const path = workspaceConfigPath(entry.workspaceRoot);
        const next = validateConfig(entry.config);
        writeConfig(path, next);
        cacheWritten({ path, root: entry.workspaceRoot }, next);
        const session = entry.workspaceRoot === sessionRoot ? sessionId : null;
        // g-062: a restore is a prompt change like any other save, and it is
        // reported on that workspace's next run (the same call the `unapply`
        // route makes, Revision 48 included: restoring **nothing** counts).
        notePromptWrite({
          layer: 'workspace',
          session,
          action: entry.after === null || entry.after.action === 'hide' ? 'hide' : 'replace',
          text: entry.after === null || entry.after.action === 'hide' ? '' : String(entry.after.text ?? ''),
        });
        recordHistory({
          path,
          at,
          layer: 'workspace',
          session,
          action: actionOf(entry.before, entry.after),
          name: CUSTOM_SECTION_NAME,
          origin: 'ui',
          before: textEntry(entry.before === null ? null : entry.before.text),
          after: textEntry(entry.after === null ? null : entry.after.text),
          snapshot: snapshotOfConfig(next),
          note: `delete preset ${id}`,
        });
        restored.push(entry.workspaceRoot);
      }
    } catch (error) {
      const reason = error instanceof OverrideError
        ? `${error.code}: ${error.message}`
        : `${error?.message ?? String(error)}`;
      throw fail(
        'preset-unapply-failed',
        `${restoreRefusal('restoring', committing, affected, restored, absent)} (${reason}); the preset was NOT deleted`,
        500,
      );
    }
    writePresets(file.path, plan.document);
    sendJson(res, 200, {
      ok: true,
      removed: true,
      id,
      preset: plan.removed,
      // What really happened, in the two counts the page needs (Revision 50):
      // how many workspaces were **really written**, and how many stack links
      // that took across every affected workspace. A workspace whose layer file
      // is gone is reported in `workspaces[]` as `missing: true` and is not
      // counted as restored (g-069 review A).
      restoredWorkspaces: restored.length,
      links: plan.links,
      workspaces: plan.plans.map((entry) => ({
        workspaceRoot: entry.workspaceRoot,
        links: entry.links,
        restored: entry.restored,
        missing: entry.missing === true,
      })),
      presets: publicPresets(plan.document),
      applied: publicApplied(plan.document),
    });
  }

  /**
   * The「which workspaces were restored, which were not」half of a refused
   * deletion (Revision 50): one sentence, both lists, so the answer can never
   * claim more than it did.
   *
   * `failedRoot` names the workspace the refusal really came from — the one whose
   * read threw in phase 1, or the one the commit loop was writing in phase 2
   * (g-069 review B: the previous wording listed every not-yet-reached workspace
   * as if it had failed, which §20.7 already promised not to do). `absent` names
   * the workspaces whose layer file does not exist: they are neither restored nor
   * failed, so they are excluded from `not restored` and reported separately.
   * @param verb - what was being attempted (`restoring`).
   * @param failedRoot - the workspace whose restore failed, or null.
   * @param affected - every workspace the deletion had to account for.
   * @param restored - the workspaces already restored, in commit order.
   * @param absent - the workspaces with no layer file (skipped, not restored).
   * @returns a human-readable sentence.
   */
  function restoreRefusal(verb, failedRoot, affected, restored, absent = []) {
    const quote = (roots) => (roots.length === 0 ? 'none' : roots.map((root) => JSON.stringify(root)).join(', '));
    const pending = affected.filter((root) => !restored.includes(root) && !absent.includes(root));
    const head = failedRoot === null || failedRoot === undefined
      ? `${verb} stopped before any layer was written`
      : `${verb} workspace ${JSON.stringify(failedRoot)} failed`;
    const parts = [`${head}`, `restored: ${quote(restored)}`, `not restored: ${quote(pending)}`];
    if (absent.length > 0) parts.push(`no layer to restore: ${quote(absent)}`);
    return parts.join('; ');
  }

  /**
   * `POST /prompt-setting/presets/apply` — write one preset into one workspace.
   *
   * This is the same write `PUT /overrides` performs (`targetFor` +
   * `writableConfig` + `writeConfig` + `cacheWritten`), and it deliberately
   * reuses it rather than growing a second write path: the reserved section is
   * still the only thing written, the layer's other entries and its switch are
   * carried across, and a refusal at any step before `writeConfig` leaves every
   * file byte-identical.
   *
   * The snapshot is taken from the config this request just read, and it is what
   * makes「取消应用」exact. The library write happens **after** the layer write:
   * the record describes a write that really happened. Residual risk, stated
   * rather than hidden: if the library write fails after the layer write
   * succeeded, the workspace holds the preset text with no record of how to undo
   * it, and the answer is a `500` — the alternative order would record an
   * application that never happened, which is worse (the page would then offer
   * to「取消应用」a workspace it never touched).
   *
   * Revision 39 puts the **composition** here too, through `planApply`: an
   * `append` preset is stacked after the layer's own text (the merge kernel
   * cannot join a layer to itself), and a text the layer already carries is a
   * `alreadyApplied` no-op — no `writeConfig`, no history record, and the answer
   * says so instead of claiming a write.
   * @param req - the Node request.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  async function handleApplyPreset(req, url, res) {
    const body = await readJsonBody(req);
    const rawPresetId = body?.presetId;
    if (rawPresetId === undefined || rawPresetId === null || rawPresetId === '') {
      throw fail('missing-preset-id', 'body field "presetId" is required');
    }
    const presetId = validatePresetId(rawPresetId);
    const sessionId = presetSessionOf(body, url);
    const target = targetFor('workspace', sessionId);
    const current = writableConfig(target.path);
    const file = writablePresets();
    const at = new Date().toISOString();
    const plan = planApply(file.document, { presetId, workspaceRoot: target.root, current, at });
    const next = validateConfig(plan.config);
    // Revisions 40/41: the answer's `base` (and therefore its `before`) is the
    // snapshot §20.6 restores — the state before the **first** application on
    // this root — while the history record below still describes *this* write
    // (the text it really replaced).
    const currentEntry = reservedSectionOf(current);
    const base = plan.alreadyApplied === true ? plan.base : plan.base;
    const before = base;
    const after = plan.alreadyApplied === true ? currentEntry : reservedSectionOf(next);
    // Revision 39: an application whose text the layer already carries is a
    // **no-op** — nothing is written, no history record is appended (there was
    // no change), and the answer says `alreadyApplied: true` so the page can say
    // 「该预设已在此工作区生效」instead of claiming a write.
    //
    // Review R5: "nothing" includes the **library file**. `before` is what
    // 「取消应用」restores, and `planApply` returns the existing record untouched
    // for this case, so writing the document back would either rewrite the same
    // bytes or — worse, in the original defect — replace the first application's
    // snapshot with the layer's current text, turning the cancel into a no-op.
    // The response reports the records as they stand.
    let history = null;
    if (plan.alreadyApplied === true) {
      cacheWritten(target, current);
    } else {
      writeConfig(target.path, next);
      cacheWritten(target, next);
      // g-062: applying a preset is a prompt change like any other save, so the
      // workspace's next run reports it. `alreadyApplied` above stays a no-op —
      // this branch is the one that really wrote.
      //
      // Revision 48: the registration is **not** conditioned on `after` existing,
      // because `writeConfig` above already happened either way. A preset can
      // legitimately leave the layer with no reserved entry (a `hide`-shaped
      // plan), and "the prompt is now empty" is exactly the kind of change the
      // next run has to report; the empty text is the same spelling
      // `DELETE`/`reset` use (`action: 'hide'`, `text: ''`).
      notePromptWrite({
        layer: 'workspace',
        session: sessionId ?? null,
        action: after === null || after.action === 'hide' ? 'hide' : 'replace',
        text: after === null || after.action === 'hide' ? '' : String(after.text ?? ''),
      });
      history = recordHistory({
        path: target.path,
        at,
        layer: 'workspace',
        session: sessionId ?? null,
        action: actionOf(currentEntry, after),
        name: CUSTOM_SECTION_NAME,
        origin: 'ui',
        before: textEntry(currentEntry === null ? null : currentEntry.text),
        after: textEntry(after === null ? null : after.text),
        snapshot: snapshotOfConfig(next),
        note: `preset ${plan.preset.id}`,
      });
      writePresets(file.path, plan.document);
    }
    const appliedRecords = publicApplied(plan.alreadyApplied === true ? file.document : plan.document);
    const record = appliedRecords.find((item) => item.workspaceRoot === target.root) ?? null;
    sendJson(res, 200, {
      ok: true,
      applied: true,
      alreadyApplied: plan.alreadyApplied === true,
      preset: plan.preset,
      // The public shape of this workspace's record (base + stack), so the page
      // can list every preset applied there without a second request.
      record,
      workspaceRoot: target.root,
      base,
      before,
      after,
      stack: record === null ? [] : record.stack,
      effectiveFrom: 'next-turn',
      history,
      appliedRecords,
    });
  }

  /**
   * `POST /prompt-setting/presets/unapply` — take **one** preset off a
   * workspace's stack (Revision 41).
   *
   * The body carries `{session, presetId}`: the request names which application
   * to cancel, because a workspace holds a stack and「取消应用」is no longer
   * all-or-nothing. The remaining links stay composed on top of `base`; removing
   * the last one restores `base` itself (`null` ⇒ the reserved entry is removed),
   * and the layer's other entries and its switch are untouched either way.
   *
   * The text is **recomposed** from base + stack rather than un-appended from the
   * current bytes, which is what makes cancelling one preset out of several
   * possible at all — and it means a hand edit made between two applications is
   * overwritten. That trade is stated in the contract (§20.6) as well as here.
   *
   * `presetId` is required (`400 missing-preset-id`), and a preset that is not on
   * that workspace's stack is `404 not-applied` — the answer must not claim a
   * write that did not happen.
   * @param req - the Node request.
   * @param url - the parsed request URL.
   * @param res - the Node response.
   */
  async function handleUnapplyPreset(req, url, res) {
    const body = await readJsonBody(req);
    const rawPresetId = body?.presetId;
    if (rawPresetId === undefined || rawPresetId === null || rawPresetId === '') {
      throw fail('missing-preset-id', 'body field "presetId" is required');
    }
    const presetId = validatePresetId(rawPresetId);
    const sessionId = presetSessionOf(body, url);
    const target = targetFor('workspace', sessionId);
    const current = writableConfig(target.path);
    const file = writablePresets();
    const at = new Date().toISOString();
    const plan = planUnapply(file.document, { workspaceRoot: target.root, presetId, current });
    const next = validateConfig(plan.config);
    const before = reservedSectionOf(current);
    const after = reservedSectionOf(next);
    writeConfig(target.path, next);
    cacheWritten(target, next);
    // g-062: cancelling an application restores text — also a prompt change, and
    // reported on the workspace's next run like any other save.
    //
    // Revision 48: "restores text" includes restoring **nothing**. Cancelling the
    // last link of a workspace that never held a reserved entry clears the
    // section (`after === null`), and a clearing is a prompt change: the guard
    // that used to sit here (`after !== null && typeof after.text === 'string'`)
    // silently dropped it, which is why「取消应用」never toasted on the live
    // machine. The empty text is the existing spelling of a removal
    // (`DELETE`/`reset` use `action: 'hide'`, `text: ''`).
    notePromptWrite({
      layer: 'workspace',
      session: sessionId ?? null,
      action: after === null || after.action === 'hide' ? 'hide' : 'replace',
      text: after === null || after.action === 'hide' ? '' : String(after.text ?? ''),
    });
    const history = recordHistory({
      path: target.path,
      at,
      layer: 'workspace',
      session: sessionId ?? null,
      action: actionOf(before, after),
      name: CUSTOM_SECTION_NAME,
      origin: 'ui',
      before: textEntry(before === null ? null : before.text),
      after: textEntry(after === null ? null : after.text),
      snapshot: snapshotOfConfig(next),
      note: `unapply preset ${presetId}`,
    });
    writePresets(file.path, plan.document);
    const appliedRecords = publicApplied(plan.document);
    const record = appliedRecords.find((item) => item.workspaceRoot === target.root) ?? null;
    sendJson(res, 200, {
      ok: true,
      unapplied: true,
      // Which application was cancelled, and what is left on the stack — the two
      // facts the page needs to keep the remaining names on screen.
      presetId,
      removed: { presetId, appliedAt: plan.removed.appliedAt ?? null },
      record,
      workspaceRoot: target.root,
      restored: plan.restored,
      base: plan.base,
      stack: record === null ? [] : record.stack,
      before,
      after,
      effectiveFrom: 'next-turn',
      history,
      appliedRecords,
    });
  }

  // Load the layers this mount can see. The assembly handler never reads disk.
  // Revision 12: the same entry point the request path uses, so the cross-layer
  // F1 pass also applies to what was already on disk at mount.
  refreshLayers();

  // The four effects are registered route-first, listener-second,
  // listener-third, section-last.
  //
  // All are mounted synchronously before `mount` returns, so neither a request
  // nor an assembly can observe the order. It matters only when a step fails,
  // and the rule is *most-likely failure first, so the least has to be undone*:
  // `webServer.register()` refusing a duplicate prefix is the failure a real
  // profile actually hits (a second install, or a future host claiming the
  // prefix), `ctx.on` being unavailable is the next (twice), and the section
  // registration is the plugin's own promise — a reserved name in the global
  // layer, which fails only if this plugin is already mounted twice or the
  // platform changed. Registering in that order also keeps "the route is
  // already live when the next step fails" the half-mount case
  // `test/boot.test.mjs` pins, i.e. the recoverable half is the externally
  // reachable one. A section-registration failure therefore unwinds the route
  // and both listeners with it — no half-mounted plugin, and (g-013) one
  // readable line instead of a boot failure.
  registerEffect(
    ctx,
    cleanups,
    () =>
      disposerOf(ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          if (rejected(ctx, req, res)) return;
          const url = requestUrl(req);
          const methods = ROUTES.get(url.pathname);
          if (methods === undefined) {
            sendJson(res, 404, {
              code: 'not-found',
              message: `no route for ${url.pathname}`,
            });
            return;
          }
          if (!methods.includes(req.method)) {
            sendMethodNotAllowed(res, methods.join(', '));
            return;
          }
          try {
            // First thing every handled request does: re-read both layers, as
            // peers, before anything can fail. This is what makes an external
            // edit visible without a remount, and what bounds a cache/file
            // desync to the request that failed (CONTRACT §5.5).
            //
            // Revision 9 wrapped the same read in two extra steps; Revision 15
            // (design A) keeps only the first — the variable table, which the
            // read face of `GET /interpolate` reports. There is no load-time
            // interpolation self-check to feed any more, and no live switch
            // mirror to refresh: the reserved section is registered
            // `interpolate: false` and never moves, and a turn's expansion is
            // decided per assembly from the config that assembly resolves.
            await ensureVariables();
            refreshLayers();
            if (url.pathname === PING_PATH) {
              // Same request that probes also reports: the browser half appends
              // `?renderer=<primitives|fallback>`, so the page it renders settles
              // the primitives question on sight (NOTES.md §7/§9.2). Since
              // Revision 6 it also answers "which bytes of `client.js` am I
              // serving": read and hashed **right here**, on every request, so
              // the answer cannot outlive the file (CONTRACT.md §14).
              recordClientRenderer(report, url);
              sendJson(res, 200, {
                ok: true,
                plugin: PLUGIN_NAME,
                version: PLUGIN_VERSION,
                // Revision 17: the page links the version to this package's own
                // repository. Derived from this package's manifest at import
                // time (never hardcoded on either side); `null` when the manifest
                // declares none, which the page renders as plain text.
                repositoryUrl: OWN_REPOSITORY_URL,
                time: new Date().toISOString(),
                clientRenderer: report.renderer,
                clientReportedAt: report.reportedAt,
                clientBuild: clientBuildInfo(CLIENT_BUNDLE_PATH),
                // g-036: which shape this Host was started in, so the page picks
                // a restart instruction its reader can actually carry out
                // (`core/launch-kind.js`). An unreadable profile answers
                // `'unknown'`, which the page renders as a copy both shapes can
                // follow — never as the command-line one.
                launchKind: launchKindOf(ctx),
              });
              return;
            }
            if (url.pathname === SNAPSHOT_PATH) {
              await handleSnapshot(url, res);
              return;
            }
            if (url.pathname === HISTORY_PATH) {
              handleHistory(url, res);
              return;
            }
            if (url.pathname === DIFF_PATH) {
              handleDiff(url, res);
              return;
            }
            if (url.pathname === ROLLBACK_PATH) {
              await handleRollback(req, url, res);
              return;
            }
            if (url.pathname === EXPORT_PATH) {
              handleExport(url, res);
              return;
            }
            if (url.pathname === IMPORT_PATH) {
              await handleImport(req, url, res);
              return;
            }
            if (url.pathname === UPDATE_CHECK_PATH) {
              // g-030: one route, two questions (`GET` = the check, `PUT` = the
              // switch). Both answer 200 for every outcome they can have; only a
              // malformed PUT body is an ordinary 400.
              if (req.method === 'PUT') await handleWriteUpdateCheck(req, res);
              else await handleUpdateCheck(url, res);
              return;
            }
            if (url.pathname === DOWNLOAD_REGION_PATH) {
              // g-043: one route, two questions (`GET` = which source is in force,
              // `PUT` = choose one). A `GET` may probe on the first visit, so it
              // answers 200 for every outcome; only a `region` that is not one of
              // the three ids is the route's ordinary 400.
              if (req.method === 'PUT') await handleWriteDownloadRegion(req, res);
              else await handleReadDownloadRegion(res);
              return;
            }
            if (url.pathname === UPDATE_APPLY_CANCEL_PATH) {
              // g-032: the cancel face. A settled/never-seen request is a 200
              // `{ok:false, code:'not-running'}`, not a 404: nothing about the
              // server went wrong, and the client has one branch to render.
              sendJson(res, 200, await handleCancelInstall(req));
              return;
            }
            if (url.pathname === UPDATE_APPLY_PATH) {
              // g-032: `POST` starts (and answers **immediately** with the
              // request id — an install can block for minutes), `GET` reports the
              // phase this mount tracks. Neither ever answers 5xx: a refusal is a
              // 200 with `{ok:false, code, message}`, and a shape mistake is the
              // route's ordinary 400.
              sendJson(res, 200, req.method === 'POST' ? await handleStartInstall(req) : handleInstallStatus(url));
              return;
            }
            if (url.pathname === PRESETS_PATH) {
              // g-060: the catalogue. `PUT` is one upsert (insert without an
              // id, edit with one), `DELETE ?id=` removes one entry; neither
              // touches a layer, so neither takes a session.
              if (req.method === 'PUT') await handleWritePreset(req, res);
              else if (req.method === 'DELETE') handleDeletePreset(url, res);
              else handleReadPresets(url, res);
              return;
            }
            if (url.pathname === PRESETS_APPLY_PATH) {
              await handleApplyPreset(req, url, res);
              return;
            }
            if (url.pathname === PRESETS_UNAPPLY_PATH) {
              await handleUnapplyPreset(req, url, res);
              return;
            }
            if (url.pathname === ASSEMBLY_STATUS_PATH) {
              // g-062: `GET` is a pure read of the observation (never assembles,
              // never probes); `PUT` records the notice switch. Neither reaches
              // the model.
              if (req.method === 'PUT') await handleWriteAssemblyStatus(req, res);
              else handleReadAssemblyStatus(url, res);
              return;
            }
            if (url.pathname === INTERPOLATE_PATH) {
              if (req.method === 'PUT') await handleWriteInterpolate(req, url, res);
              else handleReadInterpolate(url, res);
              return;
            }
            if (req.method === 'GET') {
              handleReadOverrides(url, res);
              return;
            }
            if (req.method === 'PUT') {
              await handleWriteOverride(req, url, res);
              return;
            }
            handleDeleteOverride(url, res);
          } catch (error) {
            if (error instanceof OverrideError) {
              sendJson(res, error.status, { ok: false, code: error.code, message: error.message });
              return;
            }
            sendJson(res, 500, {
              ok: false,
              code: 'internal-error',
              message: error?.message ?? String(error),
            });
          }
        },
      })),
    `prompt-setting: ${ROUTE_PREFIX} routes (${ACTIONS.join('/')} overrides)`,
  );

  registerEffect(
    ctx,
    cleanups,
    () => ctx.on('system-prompt/assemble', assembleHandler),
    'prompt-setting: system-prompt/assemble override',
  );

  // g-062: the two host feeds the assembly-status notice needs, on the same
  // ledger as every other effect (unmounting drops them with the route).
  //
  // `agent/pre-step` fires immediately after the assembly that step just ran
  // (`AgentLoop.preStep()`: assemble → this waterfall), and its payload carries
  // `{agent, messages, turn, step, signal}` — the agent is the session id, and
  // turn/step are what align a notice with the projection that follows.
  //
  // It is a **waterfall**, not an emit: the framework's own listener decides
  // `{kind: 'enter'|'reject', messages}` and `AgentLoop` consumes that decision.
  // A listener that returns `undefined` without calling `next()` would drop the
  // decision on the floor and break every step, so this one reads its payload,
  // contains its own errors and then **passes the waterfall on unchanged** — it
  // must never delay, veto or rewrite a step. `typeof` guards the double: an
  // emit-shaped caller (the test harness, an older host) hands no `next`.
  registerEffect(
    ctx,
    cleanups,
    () => ctx.on('agent/pre-step', (payload, next) => {
      try {
        const agent = payload?.agent;
        if (agent !== null && typeof agent === 'object' && typeof agent.id === 'string') {
          assemblyWatch.observePreStep({ sessionId: agent.id, turn: payload?.turn, step: payload?.step });
        }
      } catch {
        // Fail open: an observation must never break a user's turn.
      }
      return typeof next === 'function' ? next() : undefined;
    }),
    'prompt-setting: assembly-status step alignment',
  );

  // `session/event` is the post-commit, fire-and-forget append feed: the only
  // place a `system/message` (the delivery evidence) or a `request/header`
  // (`reason: 'initial'`, the new-conversation signal) can be observed. It is
  // observed and never relied on for a synchronous decision — listener failures
  // are contained by the host, and this listener contains its own.
  registerEffect(
    ctx,
    cleanups,
    () => ctx.on('session/event', (session, event) => {
      try {
        const sessionId = session !== null && typeof session === 'object' && typeof session.id === 'string' ? session.id : null;
        if (sessionId === null) return;
        assemblyWatch.observeSessionEvent({ sessionId, event, at: Date.now() });
      } catch {
        // Fail open.
      }
    }),
    'prompt-setting: assembly-status delivery observation',
  );

  // The bounded record is dropped when the Host says the session left the store,
  // so a long-lived profile does not accumulate one record per conversation.
  registerEffect(
    ctx,
    cleanups,
    () => ctx.on('session/disposed', (session) => {
      try {
        const sessionId = session !== null && typeof session === 'object' && typeof session.id === 'string' ? session.id : null;
        if (sessionId !== null) assemblyWatch.disposeSession(sessionId);
      } catch {
        // Fail open.
      }
    }),
    'prompt-setting: assembly-status session cleanup',
  );

  // Revision 8's deliverable: the listener that keeps the reserved section
  // last. `prepend` is the whole mechanism — it places this listener at the
  // front of the waterfall among the listeners registered so far, so its
  // post-`next()` step is the last one among those, past any listener that
  // registered before this plugin
  // and appends its own section after `next()` returns (the live
  // `dsh-expression:companion` case). It moves nothing else, applies no
  // override and reads no config; `reservedSectionLast` is pure and returns its
  // input by reference unless a section actually moves.
  //
  // No new failure mode: this is the same `ctx.on` effect as the listener above,
  // on the same ledger, and a host that ignores the options object still
  // registers it (it simply does not get the front slot).
  registerEffect(
    ctx,
    cleanups,
    () => ctx.on('system-prompt/assemble', keepReservedLastHandler, { prepend: true }),
    'prompt-setting: keep the reserved section last',
  );

  // Revision 7's deliverable: this plugin's own prompt section.
  //
  // Registered **empty**. The user's text is never read here — it reaches the
  // section through the existing override engine (a `replace` whose name is the
  // reserved one, applied by `assembleHandler` above), so the assembly path
  // gains no configuration read, no IO and no new branch. Until a user writes
  // something, the section renders to nothing and the final prompt is
  // byte-identical to the prompt this plugin does not exist for.
  //
  // `interpolate: false` is a safety requirement, not a preference, and
  // Revision 15 (design A) makes it permanent: the shipped renderer throws on an
  // unknown, undefined or malformed `{{...}}` reference, and a user's text is
  // arbitrary. Because this field is **never** flipped at run time, DSH's strict
  // interpolator can never reach the reserved section — the failure mode is
  // structurally impossible, not merely prevented. The switch means something
  // else now: with it ON, `assembleHandler` expands the text itself, leniently
  // (CONTRACT §16.9).
  //
  // `order` places the section after every section the DSH repository defines
  // (its table's maximum is 10200); another plugin may still place itself
  // after this one, which is the documented limit of what `order` promises.
  //
  // The disposer is accounted for exactly like the other two: it is the
  // `systemPrompt.section()` effect's own disposer, so unloading the plugin —
  // or a later step of this mount failing — removes the registration instead of
  // leaving a name in the global layer that a remount would collide with.
  registerEffect(
    ctx,
    cleanups,
    () => disposerOf(ctx.systemPrompt.section(customSection())),
    `prompt-setting: reserved section ${CUSTOM_SECTION_NAME} (order ${CUSTOM_SECTION_ORDER}, switchable)`,
  );
}

/** Re-exported so tests and the client can assert the frozen action set. */
export { ACTIONS, LAYERS, sameSections };
/**
 * Re-exported for the same reason (Revision 7): the reserved section's name,
 * order and interpolation flag are contract, and a test may not re-type them.
 */
export {
  CUSTOM_SECTION_INTERPOLATE,
  CUSTOM_SECTION_NAME,
  CUSTOM_SECTION_ORDER,
  CUSTOM_SECTION_TEXT,
  REPO_MAX_SECTION_ORDER,
} from './core/custom.js';

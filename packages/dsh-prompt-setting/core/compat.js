/**
 * Boot compatibility — *can this plugin run on the DSH it was loaded by?*
 *
 * Why this module exists (g-013): a breaking DSH update must never take the
 * harness down with this plugin, and the failure must be **readable in the
 * terminal** instead of arriving as a bare stack. The plugin therefore checks
 * its own `peerDependencies` range against the installed DSH **at import time**
 * — before any injected service is needed, so it also covers the one failure
 * the plugin can never catch from the inside (a missing `inject` service means
 * `apply` is never called at all; see NOTES.md §91).
 *
 * Two halves, deliberately separated:
 *
 * - **pure**: semver parsing/comparison, range satisfaction and the message
 *   text ({@link compatibilityVerdict}, {@link mountFailureMessage}). No IO, no
 *   `ctx`, unit-testable as data-in/text-out;
 * - **best effort**: {@link detectDshVersion} goes looking for the installed
 *   `@deepseek-ai/dsh/package.json`. This repository has **no** Node dependency
 *   on DSH (`peerDependenciesMeta.optional: true`), and `dsh` is normally
 *   installed as a global CLI — so there is no single path that always works.
 *   Every anchor is tried in a documented order, and *any* failure degrades to
 *   "not detected", which the caller turns into one warning line. **Nothing
 *   here may ever throw into a boot path**: a probe is advice, not a gate.
 *
 * Deliberate scope limits (NOTES.md §91): the range syntax implemented is the
 * comparator list the plugin actually uses (`>=x.y.z-pre <a.b.c-0`). A
 * comparator this parser does not understand returns `null` — "cannot tell" —
 * and is reported as an undetected version rather than guessed, because a
 * wrong verdict here is worse than no verdict.
 *
 * One asymmetry is deliberate (NOTES.md §98, §99, §100, §124): the declared range
 * carries `||` alternatives whose extras admit each `0.2.x` line's prereleases
 * under **strict** `node-semver` (§11 prerelease exclusion, no
 * `includePrerelease`), and which are what carry the range past each release up
 * to `<0.2.2-0`. This parser implements no such exclusion, so it reads those
 * alternatives as numeric extensions of the first one — same verdicts, one
 * fewer place to be wrong.
 *
 * @module dsh-prompt-setting/core/compat
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The peer package whose version decides compatibility. */
export const DSH_PACKAGE = '@deepseek-ai/dsh';
/** The manifest specifier resolved from every probe anchor. */
export const DSH_MANIFEST = `${DSH_PACKAGE}/package.json`;

/** `1`, `1.2`, `1.2.3-rc.4+build` — the leading `v` is tolerated. */
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
/** One comparator: operator (optional) plus version. */
const COMPARATOR = /^(>=|<=|>|<|=)?\s*(.+)$/;

/**
 * Parse a version string.
 * @param text - a candidate version.
 * @returns `{major, minor, patch, prerelease}` (prerelease is a string list,
 *   empty for a release), or `null` when it is not a version at all.
 */
export function parseSemver(text) {
  if (typeof text !== 'string') return null;
  const match = SEMVER.exec(text.trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

/**
 * Compare one prerelease identifier pair per semver §11.4: numeric
 * identifiers compare numerically and rank **below** alphanumeric ones.
 * @param left - an identifier from the first version.
 * @param right - an identifier from the second version.
 * @returns -1, 0 or 1.
 */
function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Compare two versions per semver §11.
 *
 * The two rules that matter in practice for a `-rc.N` release train: a
 * prerelease ranks **below** its release (`0.1.7-rc.2 < 0.1.7`), and `.10`
 * ranks above `.2` (numeric, not lexicographic).
 * @param left - a version string or {@link parseSemver} result.
 * @param right - a version string or {@link parseSemver} result.
 * @returns -1, 0 or 1, or `null` when either side is not a version.
 */
export function compareSemver(left, right) {
  const a = typeof left === 'string' ? parseSemver(left) : left;
  const b = typeof right === 'string' ? parseSemver(right) : right;
  if (a === null || b === null || a === undefined || b === undefined) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const longest = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < longest; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    // A shorter prerelease list ranks below a longer one that shares its prefix.
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const order = compareIdentifiers(leftPart, rightPart);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * Test one comparator against a parsed version.
 * @param version - a {@link parseSemver} result.
 * @param comparator - e.g. `>=0.1.7-rc.2`.
 * @returns true/false, or `null` when the comparator is not understood.
 */
function testComparator(version, comparator) {
  const match = COMPARATOR.exec(comparator);
  if (match === null) return null;
  const operator = match[1] ?? '=';
  const bound = parseSemver(match[2]);
  if (bound === null) return null;
  const order = compareSemver(version, bound);
  if (order === null) return null;
  switch (operator) {
    case '>=':
      return order >= 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '<':
      return order < 0;
    case '=':
      return order === 0;
    default:
      return null;
  }
}

/**
 * Does a version satisfy a whitespace-separated comparator list?
 *
 * `||` alternatives are supported (the `node-semver` convention); the
 * shorthands (`^`, `~`, `x`, hyphen ranges) are **not**, and meeting one
 * returns `null` — "cannot tell" — so no caller can mistake a guess for a
 * verdict. Unlike `node-semver`, a prerelease is **not** held back from a range
 * whose comparators are all releases (NOTES.md §98): here `0.2.0-rc.2` already
 * satisfies the first branch `>=0.1.7-rc.2 <0.2.0`, while the second branch is
 * what carries the range past the `0.2.0` release itself (NOTES.md §100).
 * @param version - the version under test.
 * @param range - the range, e.g. `>=0.1.7-rc.2 <0.2.0 || >=0.2.0-0 <0.2.1-0`.
 * @returns true, false, or null when the answer is not knowable.
 */
export function satisfiesRange(version, range) {
  if (parseSemver(version) === null) return null;
  if (typeof range !== 'string' || range.trim().length === 0) return null;
  let satisfied = false;
  for (const alternative of range.split('||')) {
    const comparators = alternative.trim().split(/\s+/).filter((part) => part.length > 0);
    if (comparators.length === 0) continue;
    let all = true;
    for (const comparator of comparators) {
      const result = testComparator(version, comparator);
      if (result === null) return null;
      if (!result) {
        all = false;
        break;
      }
    }
    if (all) satisfied = true;
  }
  return satisfied;
}

/**
 * The first line of an error's message, for a one-line terminal report. A
 * multi-line message (a native `ENOENT` blob, a stack-carrying error) must not
 * turn our single readable line into a wall of text.
 * @param error - any thrown value.
 * @returns a single line, never empty.
 */
export function firstCauseLine(error) {
  const text = error instanceof Error
    ? error.message
    : error === undefined || error === null
      ? ''
      : String(error);
  const line = String(text).split('\n')[0].trim();
  return line.length > 0 ? line : String(error);
}

/**
 * The one warning line for an out-of-range or undetectable DSH. Single line on
 * purpose: it is boot output, not a report.
 * @param inputs - plugin name/version, the expected range, the detection.
 * @returns the message.
 */
export function compatibilityMessage(inputs) {
  const reason = inputs.reason === null || inputs.reason === undefined ? null : `探测结果：${inputs.reason}。`;
  if (inputs.version === null) {
    return `[${inputs.pluginName}] 本插件 ${inputs.pluginVersion} 无法探测已安装的 DSH 版本`
      + `（期望范围 ${inputs.expectedRange}）：${reason ?? ''}兼容性未经校验，DSH 启动与其余功能不受影响。`
      + `若本插件在终端里没有激活，见 README「出问题时」（或 npm run check-compat）。`;
  }
  return `[${inputs.pluginName}] 本插件 ${inputs.pluginVersion} 检测到 DSH ${inputs.version}，`
    + `超出已测试范围 ${inputs.expectedRange}：本插件可能加载失败或行为异常，`
    + `DSH 启动与其余功能不受影响。排查与救援见 README「出问题时」（或 npm run check-compat）。`;
}

/**
 * Decide the boot verdict for one detection result.
 *
 * `ok` (in range) carries **no message at all** — a plugin that shouts on every
 * boot is worse than a silent one. The other two levels carry exactly one line.
 * @param inputs.pluginName - the plugin's package name.
 * @param inputs.pluginVersion - the plugin's version.
 * @param inputs.expectedRange - the peer range from `package.json`.
 * @param inputs.detection - `{version, reason}` from {@link detectDshVersion}.
 * @returns `{level, version, message, reason}` where `level` is
 *   `ok` | `out-of-range` | `undetected`.
 */
export function compatibilityVerdict(inputs) {
  const detection = inputs.detection ?? {};
  const version = typeof detection.version === 'string' ? detection.version : null;
  const reason = typeof detection.reason === 'string' ? detection.reason : null;
  if (version !== null) {
    const satisfied = satisfiesRange(version, inputs.expectedRange);
    if (satisfied === true) return { level: 'ok', version, message: null, reason };
    if (satisfied === null) {
      // Found a version but cannot judge it (an unsupported comparator in the
      // declared range): that is an undetected verdict, not a pass.
      return {
        level: 'undetected',
        version,
        reason: `the declared range ${inputs.expectedRange} uses a comparator this parser does not implement`,
        message: compatibilityMessage({
          ...inputs,
          version: null,
          reason: `范围语法无法解析：${inputs.expectedRange}`,
        }),
      };
    }
    return {
      level: 'out-of-range',
      version,
      reason,
      message: compatibilityMessage({ ...inputs, version }),
    };
  }
  return {
    level: 'undetected',
    version: null,
    reason,
    message: compatibilityMessage({ ...inputs, version: null, reason }),
  };
}

/**
 * The one line printed when `apply` fails: what happened, what it means, and
 * where to look. Names the plugin, its version and the detected DSH version, so
 * a report can be acted on without reading any source.
 * @param inputs.pluginName - the plugin's package name.
 * @param inputs.pluginVersion - the plugin's version.
 * @param inputs.dshVersion - the detected DSH version, or null.
 * @param inputs.cause - the first cause line.
 * @param inputs.disposed - how many registered effects were rolled back.
 * @param inputs.disposeFailures - how many disposers threw while rolling back.
 * @returns the message.
 */
export function mountFailureMessage(inputs) {
  const detected = typeof inputs.dshVersion === 'string' && inputs.dshVersion.length > 0
    ? inputs.dshVersion
    : '无法探测';
  const rollback = inputs.disposeFailures > 0
    ? `已撤销 ${inputs.disposed} 项已注册 effect（另有 ${inputs.disposeFailures} 项撤销时报错）`
    : `已撤销 ${inputs.disposed} 项已注册 effect`;
  return `[${inputs.pluginName}] 插件 ${inputs.pluginVersion} 挂载失败，本插件已停用，`
    + `DSH 其余功能不受影响。检测到的 DSH：${detected}。首因：${inputs.cause}。`
    + `${rollback}，不会留下半挂载。排查与救援见 README「出问题时」。`;
}

/**
 * Read a directory, tolerating absence or a permission error.
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
 * The directory names a `createRequire` anchor can be built from for one
 * command-line argument: the argument itself (a script path works directly) and
 * a synthetic file inside its directory (so a directory argument resolves from
 * *inside* it, the way a package in that directory would).
 * @param raw - one `process.argv` entry.
 * @returns candidate anchor paths.
 */
function entryAnchors(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  const value = raw.trim();
  return [value, join(value, '__dsh_probe__.js')];
}

/**
 * Every place the installed DSH may be reachable from, most trustworthy first.
 *
 * Order matters: the running CLI and the plugin's own module location describe
 * *this* boot, while a pnpm store scan only describes what exists on the
 * machine. When several DSH installs exist, the first anchor that resolves wins
 * (NOTES.md §91 records that limit).
 * @param options.env - environment (defaults to `process.env`).
 * @param options.argv - CLI arguments (defaults to `process.argv.slice(1)`).
 * @param options.moduleDir - the plugin's own directory.
 * @returns absolute anchor paths.
 */
export function dshProbeAnchors(options = {}) {
  const env = options.env ?? process.env;
  const anchors = [];
  const add = (value) => {
    if (typeof value === 'string' && value.trim().length > 0 && !anchors.includes(value)) anchors.push(value);
  };
  const addDir = (dir) => {
    if (typeof dir === 'string' && dir.length > 0) add(join(dir, '__dsh_probe__.js'));
  };

  // 1. Explicit overrides and host-declared locations. `DSH_INSTALL_ROOT` is the
  //    same knob `test/integration.test.mjs` documents for the same purpose.
  addDir(env.DSH_INSTALL_ROOT);
  addDir(env.DSH_PROFILE_DIR);
  // 2. The plugin's own module location: resolves when DSH is an ancestor or a
  //    real (non-optional) dependency.
  addDir(options.moduleDir);
  // 3. The running CLI entry. In the shipped pnpm layout the `dsh` binary lives
  //    *inside* the install (`.../global/v11/<hash>/node_modules/@deepseek-ai/dsh/lib/bin.js`),
  //    so a `createRequire` from it resolves the manifest through the install's
  //    own `node_modules`. This is the anchor that describes the live process.
  for (const raw of options.argv ?? process.argv.slice(1)) for (const anchor of entryAnchors(raw)) add(anchor);
  // 4. pnpm global layouts, mirrored from `test/integration.test.mjs`. Last
  //    resort: it can only say what exists on the machine, not what is running.
  const bases = [];
  if (typeof env.PNPM_HOME === 'string' && env.PNPM_HOME.length > 0) bases.push(join(env.PNPM_HOME, 'global'));
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0) bases.push(join(env.DSH_HOME, 'profiles'));
  try {
    bases.push(join(homedir(), '.local', 'share', 'pnpm', 'global'));
  } catch {
    // A machine without a resolvable home directory simply has no store anchor.
  }
  for (const base of bases) {
    addDir(base);
    for (const entry of safeReaddir(base)) {
      // `<base>/<entry>/node_modules` — the profile layout.
      const first = join(base, entry);
      addDir(join(first, 'node_modules'));
      // `<base>/<entry>/<nested>/node_modules` — the pnpm global layout, where
      // `<entry>` is `v11` and `<nested>` is the install hash.
      for (const nested of safeReaddir(first)) addDir(join(first, nested, 'node_modules'));
    }
  }
  return anchors;
}

/**
 * Best-effort detection of the installed DSH version. **Never throws**: any
 * anchor that cannot be resolved is skipped, and total failure is a result
 * (`version: null`), not an exception.
 * @param options.anchors - explicit anchors (tests); defaults to
 *   {@link dshProbeAnchors}.
 * @param options.readFile - manifest reader (tests); defaults to `readFileSync`.
 * @param options.resolveManifest - anchor→manifest resolver (tests); defaults
 *   to a `createRequire` from the anchor.
 * @returns `{version, source, reason, candidates}`; `version` is null when the
 *   version could not be determined, and `reason` says why.
 */
export function detectDshVersion(options = {}) {
  const anchors = options.anchors ?? dshProbeAnchors(options);
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const resolveManifest = options.resolveManifest ?? ((anchor) => createRequire(anchor).resolve(DSH_MANIFEST));
  const candidates = [];
  let firstFailure = null;
  for (const anchor of anchors) {
    let manifest = null;
    try {
      // No existence check on purpose: `createRequire` resolves from a path
      // that need not exist (the synthetic anchor inside a directory), and an
      // anchor that cannot be used throws here and is simply skipped.
      manifest = resolveManifest(anchor);
    } catch {
      continue;
    }
    if (typeof manifest !== 'string' || manifest.length === 0) continue;
    let version = null;
    let failure = null;
    try {
      const parsed = JSON.parse(readFile(manifest));
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.version === 'string') version = parsed.version;
      else failure = `${manifest} has no string "version"`;
    } catch (error) {
      failure = `${manifest} is not readable JSON: ${firstCauseLine(error)}`;
    }
    candidates.push({ version, source: manifest, failure });
    if (version !== null) {
      return { version, source: manifest, reason: null, candidates };
    }
    firstFailure ??= failure;
  }
  return {
    version: null,
    source: null,
    reason: candidates.length > 0
      ? firstFailure
      : `no ${DSH_MANIFEST} was reachable from ${anchors.length} probe anchor(s)`,
    candidates,
  };
}

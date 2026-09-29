/**
 * Git-install readiness — the pure half of the `prepare` hook
 * (`scripts/prepare.mjs`).
 *
 * Why this exists. Installing a plugin straight from a git host
 * (`dsh plugin add github:you/repo`) does **not** fetch a build artifact, it
 * fetches the **source checkout**, and pnpm runs the package's `prepare`
 * script on the installed copy (pnpm ≥10 only after the user grants
 * `allowBuilds` in the profile). The official publishing guide calls this the
 * "build script hurdle": a TypeScript package has no `lib/` on the other side
 * unless `prepare` builds it, from a context that must be self-contained.
 *
 * This package is zero-build — `index.js`, `client.js` and `core/*.js` are
 * tracked source that *is* the published entry surface. So the hurdle here is
 * not compilation, it is **packaging**, and the failure mode is measurable.
 * Measured on this machine against the published repository (pnpm 12.3.4,
 * 2026-09-30):
 *
 * ```sh
 * pnpm add 'github:zangxx66/dsh-prompt-setting#path:/packages/dsh-prompt-setting'
 * ```
 *
 * installs `dsh-prompt-setting@0.1.0`, and what lands in `node_modules` is
 * **exactly the `files` allowlist plus the two things npm always keeps**
 * (`package.json`, `LICENSE`) — `test/` and `.dsh-graph/` are absent, and the
 * unpacked size matches `npm pack` (968K vs 958.2 kB) rather than the checkout.
 * So the git path packs like the registry path after all; the hazard is the
 * other direction: a declared entry point that is **not covered by that list**
 * — or that is simply not committed — is missing on the user's machine, and
 * the failure surfaces later as a module-resolution error at `dsh` boot.
 *
 * `prepare` is the one hook that runs on the **installing** machine, in the
 * checkout, before anything of ours is loaded. It therefore *proves* every
 * declared entry point is both present and shippable, there, at install time.
 * Every check is a statement about bytes reachable from the package root: no
 * monorepo context, no network, no `git`, no clock.
 *
 * Contrast with `scripts/check-compat.mjs`: that one is a diagnostic and always
 * exits 0; this one is a gate and exits non-zero when the checkout is not
 * installable.
 *
 * @module dsh-prompt-setting/core/prepare
 */

import { fingerprintRegion } from './build.js';

/** `ok` — a fact was confirmed. */
export const PREPARE_OK = 'ok';
/** `warn` — worth reporting, not a reason to fail the install. */
export const PREPARE_WARN = 'warn';
/** `fail` — the checkout is not installable as-is. */
export const PREPARE_FAIL = 'fail';

/**
 * Normalize a manifest path to a package-root-relative POSIX path.
 *
 * `./index.js` and `index.js` must compare equal: the manifest is hand-written
 * and both spellings are legal.
 * @param value - any value; non-strings become `''`.
 * @returns the normalized path (empty for a non-string or empty input).
 */
export function normalizeRelPath(value) {
  if (typeof value !== 'string') return '';
  let path = value.trim().replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  while (path.startsWith('/')) path = path.slice(1);
  return path;
}

/**
 * Does a `files` allowlist cover a path?
 *
 * A path ships when it *is* a listed entry or lives **under** a listed
 * directory; npm's own globs (`*`, `**`, `?`) are honored, since a package may
 * legitimately write `core/**` instead of `core`.
 * @param filesField - the manifest's `files` array.
 * @param relPath - the normalized path to test.
 * @returns true when the allowlist covers it.
 */
export function filesCoverPath(filesField, relPath) {
  if (!Array.isArray(filesField) || typeof relPath !== 'string' || relPath.length === 0) return false;
  for (const entry of filesField) {
    let pattern = normalizeRelPath(entry);
    // `"core/"` and `"core"` mean the same directory.
    while (pattern.endsWith('/')) pattern = pattern.slice(0, -1);
    if (pattern.length === 0) continue;
    if (pattern === relPath || relPath.startsWith(`${pattern}/`)) return true;
    if (!/[*?]/.test(pattern)) continue;
    const rx = new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*|\*|\?/g, (token) => (token === '**' ? '.*' : token === '*' ? '[^/]*' : '[^/]'))}$`,
    );
    if (rx.test(relPath)) return true;
  }
  return false;
}

/**
 * Collect the `name:` values a patch file inserts or overrides.
 *
 * Deliberately not a YAML parser: this package ships a two-key patch, and a
 * dependency-free line scan cannot mis-handle what it does not understand — it
 * only needs the row names, and every other line is ignored.
 * @param text - the patch file text.
 * @returns the names, in file order (possibly empty).
 */
export function parsePatchNames(text) {
  if (typeof text !== 'string') return [];
  const names = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '');
    const match = /^\s*(?:-\s*)?name:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[1].replace(/^['"]|['"]$/g, '').trim();
    if (value.length > 0) names.push(value);
  }
  return names;
}

/**
 * Resolve one `name:` from a patch row against this package's manifest.
 *
 * The distinction that matters: a row naming *this* package (bare name, or
 * `name/sub`) must resolve to an entry this manifest actually declares —
 * cordis imports packages by name, so a typo there is a boot failure. A row
 * naming a **different** package is somebody else's dependency and is reported
 * as such rather than guessed about.
 * @param name - the row name.
 * @param pkg - the parsed `package.json`.
 * @returns `{ kind, specifier, relPath }` where `kind` is `'bare'`, `'sub'` or `'external'`.
 */
export function resolveRowName(name, pkg) {
  const packageName = typeof pkg?.name === 'string' ? pkg.name : '';
  const exportsField = pkg?.exports;
  const subpath = (key) => {
    if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
      const value = exportsField[key];
      return typeof value === 'string' ? normalizeRelPath(value) : '';
    }
    return '';
  };
  if (name === packageName) {
    const main = normalizeRelPath(pkg?.main ?? exportsField?.['.'] ?? '');
    return { kind: 'bare', specifier: name, relPath: main };
  }
  if (packageName.length > 0 && name.startsWith(`${packageName}/`)) {
    const rest = name.slice(packageName.length + 1);
    const declared = subpath(`./${rest}`);
    return { kind: 'sub', specifier: name, relPath: declared };
  }
  return { kind: 'external', specifier: name, relPath: '' };
}

/**
 * List every entry point the manifest declares, with the field that declares it.
 *
 * `main` and `exports` are both read: this package publishes `main` (for older
 * resolvers) *and* `exports` (for Node's subpath rules), plus the client half
 * through `exports["./client"]`, which the DSH client-modules resolver reads.
 * @param pkg - the parsed `package.json`.
 * @returns `{ field, relPath }[]`, de-duplicated by path.
 */
export function declaredEntrypoints(pkg) {
  const found = [];
  const seen = new Set();
  const push = (field, value) => {
    const relPath = normalizeRelPath(value);
    if (relPath.length === 0 || seen.has(relPath)) return;
    seen.add(relPath);
    found.push({ field, relPath });
  };
  const exportsField = pkg?.exports;
  if (typeof exportsField === 'string') push('exports', exportsField);
  else if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    for (const [key, value] of Object.entries(exportsField)) {
      push(`exports["${key}"]`, typeof value === 'string' ? value : value?.default);
    }
  }
  if (typeof pkg?.main === 'string') push('main', pkg.main);
  return found;
}

/**
 * Inspect a package root for install-from-git readiness.
 *
 * Pure over injected readers, so every branch below is pinned offline by
 * `test/prepare.test.mjs`; `scripts/prepare.mjs` supplies `node:fs`.
 * @param options - `{ pkg, patchTexts, readText, listDir }`:
 *   `pkg` is the parsed manifest (`null` when unreadable);
 *   `readText(relPath)` returns the file's text or `null`;
 *   `listDir(relDir)` returns a directory's entry names or `null`;
 *   `patchTexts` maps a normalized patch path to its text (or `null`).
 * @returns `{ ok, findings }` — `ok` is false iff some finding is `fail`.
 */
export function inspectPackage({ pkg, readText, listDir, patchTexts = {} } = {}) {
  const findings = [];
  const add = (level, code, message) => findings.push({ level, code, message });
  const read = typeof readText === 'function' ? readText : () => null;
  const list = typeof listDir === 'function' ? listDir : () => null;

  if (!pkg || typeof pkg !== 'object') {
    add(PREPARE_FAIL, 'MANIFEST-UNREADABLE', 'package.json 缺失或无法解析：这不是一个可安装的包目录');
    return { ok: false, findings };
  }

  add(PREPARE_OK, 'MANIFEST', `包名 ${pkg.name ?? '(未声明)'}，版本 ${pkg.version ?? '(未声明)'}`);

  // 1. Every declared entry point must exist and carry bytes.
  const entrypoints = declaredEntrypoints(pkg);
  if (entrypoints.length === 0) {
    add(PREPARE_FAIL, 'NO-ENTRYPOINT', 'main / exports 都没有声明入口：装上之后没有任何代码可加载');
  }
  for (const { field, relPath } of entrypoints) {
    const text = read(relPath);
    if (text === null) add(PREPARE_FAIL, 'ENTRY-MISSING', `${field} → ${relPath} 在包目录里不存在`);
    else if (text.trim().length === 0) add(PREPARE_FAIL, 'ENTRY-EMPTY', `${field} → ${relPath} 是空文件`);
    else add(PREPARE_OK, 'ENTRY', `${field} → ${relPath}`);
  }

  // 2. The bundle patch must be present, and every row naming this package must
  //    resolve to an entry declared above.
  const patchField = pkg?.dsh?.bundle?.patch;
  const patchPaths = (Array.isArray(patchField) ? patchField : [patchField])
    .map(normalizeRelPath)
    .filter((value) => value.length > 0);
  if (patchPaths.length === 0) {
    add(PREPARE_WARN, 'NO-BUNDLE-PATCH', '未声明 dsh.bundle.patch：安装后不会激活任何层（只能作为普通依赖）');
  }
  for (const patchPath of patchPaths) {
    const text = Object.prototype.hasOwnProperty.call(patchTexts, patchPath) ? patchTexts[patchPath] : read(patchPath);
    if (text === null || text === undefined) {
      add(PREPARE_FAIL, 'PATCH-MISSING', `dsh.bundle.patch → ${patchPath} 在包目录里不存在`);
      continue;
    }
    add(PREPARE_OK, 'PATCH', `dsh.bundle.patch → ${patchPath}`);
    const names = parsePatchNames(text);
    if (names.length === 0) {
      add(PREPARE_WARN, 'PATCH-EMPTY', `${patchPath} 里没有任何 name: 行`);
      continue;
    }
    for (const name of names) {
      const row = resolveRowName(name, pkg);
      if (row.kind === 'external') {
        add(PREPARE_OK, 'PATCH-EXTERNAL', `${patchPath} 的 name: ${name} 指向别的包（由它自己保证可用）`);
      } else if (row.relPath.length === 0) {
        add(
          PREPARE_FAIL,
          row.kind === 'bare' ? 'ROW-NO-ENTRY' : 'ROW-NO-SUBPATH-EXPORT',
          row.kind === 'bare'
            ? `${patchPath} 的 name: ${name} 是本包，但 manifest 没有 main/exports["."]`
            : `${patchPath} 的 name: ${name} 是本包子路径，但 exports 里没有 "./${name.slice(String(pkg.name).length + 1)}"`,
        );
      } else if (read(row.relPath) === null) {
        add(PREPARE_FAIL, 'ROW-ENTRY-MISSING', `${patchPath} 的 name: ${name} → ${row.relPath} 在包目录里不存在`);
      } else {
        add(PREPARE_OK, 'PATCH-ROW', `${patchPath} 的 name: ${name} → ${row.relPath}`);
      }
    }
  }

  // 3. The `files` allowlist must describe things that are really there. A git
  //    install ignores this list, but `npm pack` does not — a stale entry means
  //    the published tarball and the git checkout disagree about what ships.
  const filesField = pkg.files;
  if (!Array.isArray(filesField) || filesField.length === 0) {
    add(PREPARE_WARN, 'NO-FILES', '未声明 files：npm pack 会把整个目录发布出去（含 test/ 与文档）');
  } else {
    for (const entry of filesField) {
      const relPath = normalizeRelPath(entry);
      if (relPath.length === 0) continue;
      const text = read(relPath);
      if (text !== null) {
        add(PREPARE_OK, 'FILES-FILE', `files: ${relPath}`);
        continue;
      }
      const listing = list(relPath);
      if (Array.isArray(listing) && listing.length > 0) add(PREPARE_OK, 'FILES-DIR', `files: ${relPath}/（${listing.length} 项）`);
      else add(PREPARE_FAIL, 'FILES-MISSING', `files 里的 ${relPath} 不存在或为空目录`);
    }
  }

  // 3b. …and everything the two halves load at runtime must be *inside* that
  //     list. This is the check the measured packing behaviour makes necessary:
  //     the allowlist is what the user receives, so an entry point it does not
  //     cover is not "maybe missing", it is guaranteed missing.
  if (Array.isArray(filesField) && filesField.length > 0) {
    const mustShip = [
      ...entrypoints.map(({ field, relPath }) => ({ what: field, relPath })),
      ...patchPaths.map((relPath) => ({ what: 'dsh.bundle.patch', relPath })),
    ];
    const seen = new Set();
    for (const { what, relPath } of mustShip) {
      // npm keeps the manifest unconditionally; asking for it in `files` is noise.
      if (relPath === 'package.json' || seen.has(relPath)) continue;
      seen.add(relPath);
      if (filesCoverPath(filesField, relPath)) add(PREPARE_OK, 'SHIPS', `${what} → ${relPath} 在 files 白名单内`);
      else add(PREPARE_FAIL, 'NOT-SHIPPED', `${what} → ${relPath} 不在 files 白名单里：安装时这个文件会被裁掉`);
    }
  }

  // 4. The client half must carry exactly one usable fingerprint region: the
  //    page compares its own digest against the host's, and an unusable region
  //    reads as `null` on both sides, which the UI can only report as "unknown".
  if (pkg?.dsh?.client && typeof pkg.dsh.client === 'object') {
    const clientRel = (() => {
      const exportsField = pkg.exports;
      if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
        return normalizeRelPath(exportsField['./client']);
      }
      return '';
    })();
    if (clientRel.length === 0) {
      add(PREPARE_FAIL, 'CLIENT-NO-EXPORT', '声明了 dsh.client，但 exports 里没有 "./client"');
    } else {
      const text = read(clientRel);
      if (text === null) add(PREPARE_FAIL, 'CLIENT-MISSING', `dsh.client → ${clientRel} 在包目录里不存在`);
      else if (fingerprintRegion(text) === null) {
        add(PREPARE_FAIL, 'CLIENT-FINGERPRINT', `${clientRel} 的构建戳标记不是「唯一且有序」的一对：设置页将无法判断自己跑的是哪份包`);
      } else add(PREPARE_OK, 'CLIENT-FINGERPRINT', `${clientRel} 的构建戳区间可用`);
    }
  }

  // 5. Dependency shape. Not a failure either way — pnpm installs whatever is
  //    declared — but the two contracts are worth stating at install time: the
  //    plugin must share the host's DSH instance (peer), and it ships no
  //    runtime dependencies of its own.
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length === 0) add(PREPARE_OK, 'NO-RUNTIME-DEPS', '零运行时依赖');
  else add(PREPARE_WARN, 'RUNTIME-DEPS', `声明了 ${deps.length} 个运行时依赖：git 安装会为它们拉取依赖树`);

  return { ok: !findings.some((finding) => finding.level === PREPARE_FAIL), findings };
}

/**
 * `prepare` gate assertions (`core/prepare.js` + `scripts/prepare.mjs`).
 *
 * The gate exists because a git install (`dsh plugin add github:you/repo`)
 * receives the **source checkout**, not a packed artifact — `files` and
 * `.gitignore` are not applied to what the user gets. So the property under
 * test is "this checkout is self-contained", and the primary evidence is the
 * last test in this file: the real package, checked by the real script, exiting
 * 0. Everything before it pins the individual ways a checkout can be incomplete
 * so a future edit cannot quietly turn the gate into a no-op.
 *
 * Pure kernel tests use an in-memory reader; the end-to-end test spawns the
 * script on a throwaway package in a temp dir (never the real one).
 *
 * Run: `node --test`
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FINGERPRINT_BEGIN, FINGERPRINT_END } from '../core/build.js';
import {
  PREPARE_FAIL,
  PREPARE_OK,
  PREPARE_WARN,
  declaredEntrypoints,
  filesCoverPath,
  globMatches,
  inspectPackage,
  normalizeRelPath,
  parsePatchNames,
  resolveRowName,
} from '../core/prepare.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const realManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

/** `node:fs`-backed reader over a package root. */
function realIo(root = packageRoot) {
  return {
    readText: (relPath) => {
      try {
        return readFileSync(join(root, relPath), 'utf8');
      } catch {
        return null;
      }
    },
    listDir: (relPath) => {
      try {
        return readdirSync(join(root, relPath));
      } catch {
        return null;
      }
    },
  };
}

/**
 * In-memory reader: a string value is a file, an array value under
 * `"<dir>/"` is a directory listing, a missing key is "does not exist".
 */
function memIo(entries) {
  return {
    readText: (relPath) => (typeof entries[relPath] === 'string' ? entries[relPath] : null),
    listDir: (relPath) => (Array.isArray(entries[`${relPath}/`]) ? entries[`${relPath}/`] : null),
  };
}

/** A manifest shaped like this package's, with any field overridable. */
function healthyManifest(overrides = {}) {
  return {
    name: 'demo-plugin',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    exports: { '.': './index.js', './client': './client.js' },
    files: ['index.js', 'client.js', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    dependencies: {},
    ...overrides,
  };
}

/** Files that satisfy {@link healthyManifest}. */
function healthyFiles(overrides = {}) {
  return {
    'index.js': 'export const name = "demo-plugin"\n',
    'client.js': `${FINGERPRINT_BEGIN}\nwindow.__x = 1\n${FINGERPRINT_END}\n`,
    'cordis.patch.yml': '- insert:\n    - id: demo\n      name: demo-plugin\n',
    'package.json': '{}\n',
    ...overrides,
  };
}

/** Inspect the healthy fixture with `entries` overrides applied. */
function inspect(entries, manifest = healthyManifest()) {
  const io = memIo({ ...healthyFiles(), ...entries });
  return inspectPackage({ pkg: manifest, ...io });
}

/** The findings with a given code. */
function codes(result, level) {
  return result.findings.filter((finding) => finding.level === level).map((finding) => finding.code);
}

// #region pure helpers

test('prepare: normalizeRelPath folds ./ and backslashes, and never throws', () => {
  assert.equal(normalizeRelPath('./index.js'), 'index.js');
  assert.equal(normalizeRelPath('index.js'), 'index.js');
  assert.equal(normalizeRelPath('.\\core\\a.js'), 'core/a.js');
  assert.equal(normalizeRelPath('  ./a.js  '), 'a.js');
  assert.equal(normalizeRelPath(undefined), '');
  assert.equal(normalizeRelPath(42), '');
});

test('prepare: parsePatchNames reads rows, peels quotes and ignores comments', () => {
  const text = [
    '# a comment: name: not-this-one',
    '- insert:',
    '    - id: prompt-setting',
    "      name: 'dsh-prompt-setting'   # trailing comment",
    '    - id: other',
    '      name: "other-pkg"',
    '      config:',
    '        name: nested-is-not-a-row',
  ].join('\n');
  // `nested-is-not-a-row` is deliberately *not* filtered out: a bare
  // `^\s*name:` scan also matches nested config keys. That is acceptable — a
  // row name that is not this package is reported as external, never as a
  // failure — and it is stated here so the limit is a documented one.
  assert.deepEqual(parsePatchNames(text), ['dsh-prompt-setting', 'other-pkg', 'nested-is-not-a-row']);
  assert.deepEqual(parsePatchNames(''), []);
  assert.deepEqual(parsePatchNames(undefined), []);
});

test('prepare: resolveRowName classifies bare, sub-path and external rows', () => {
  const pkg = healthyManifest();
  assert.deepEqual(resolveRowName('demo-plugin', pkg), { kind: 'bare', specifier: 'demo-plugin', relPath: 'index.js' });
  assert.deepEqual(resolveRowName('demo-plugin/client', pkg), {
    kind: 'sub',
    specifier: 'demo-plugin/client',
    relPath: 'client.js',
  });
  assert.equal(resolveRowName('demo-plugin/tpyo', pkg).kind, 'sub');
  assert.equal(resolveRowName('demo-plugin/tpyo', pkg).relPath, '');
  assert.deepEqual(resolveRowName('@deepseek-ai/dsh-base', pkg), {
    kind: 'external',
    specifier: '@deepseek-ai/dsh-base',
    relPath: '',
  });
});

test('prepare: declaredEntrypoints reports every field, de-duplicated by path', () => {
  assert.deepEqual(declaredEntrypoints(healthyManifest()), [
    { field: 'exports["."]', relPath: 'index.js' },
    { field: 'exports["./client"]', relPath: 'client.js' },
  ]);
  // `main` pointing at the same file as `exports["."]` is one entry, not two.
  assert.deepEqual(declaredEntrypoints(healthyManifest({ main: './index.js' })).length, 2);
  assert.deepEqual(declaredEntrypoints({ name: 'x' }), []);
});

// #endregion

// #region the real package is the primary evidence

test('prepare: the real package passes every gate', () => {
  const result = inspectPackage({ pkg: realManifest, ...realIo() });
  assert.deepEqual(codes(result, PREPARE_FAIL), [], 'the shipped package must be installable from git as-is');
  assert.equal(result.ok, true);
  const ok = codes(result, PREPARE_OK);
  for (const code of ['MANIFEST', 'ENTRY', 'PATCH', 'PATCH-ROW', 'FILES-DIR', 'SHIPS', 'CLIENT-FINGERPRINT', 'NO-RUNTIME-DEPS']) {
    assert.ok(ok.includes(code), `expected an ok finding for ${code}`);
  }
});

test('prepare: the script exits 0 on the real package and prints its verdict', () => {
  const run = spawnSync(process.execPath, ['scripts/prepare.mjs'], { cwd: packageRoot, encoding: 'utf8' });
  assert.equal(run.status, 0, `expected exit 0, got ${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /prepare：OK/);
  assert.match(run.stdout, /CLIENT-FINGERPRINT/);
});

test('prepare: the script is wired as the package `prepare` hook', () => {
  assert.equal(realManifest.scripts?.prepare, 'node scripts/prepare.mjs');
  // …and the hook must ship: `scripts` is in the `files` allowlist, so a packed
  // install carries the same script a git install runs.
  assert.ok(realManifest.files.includes('scripts'));
});

test('prepare: every real chunk file ships, whatever the allowlist spells', () => {
  // g-045: the bundle is the entry plus its chunks. A chunk the allowlist does
  // not cover is a 404 in the browser — the page then renders its readable
  // failure card, but the feature is gone for every user. So: whatever the
  // allowlist says (`client.*.js` today), every real chunk must be covered.
  const chunkFiles = readdirSync(packageRoot).filter(
    (name) => /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(name),
  );
  assert.ok(chunkFiles.length >= 1, 'the split bundle ships at least one chunk');
  for (const name of chunkFiles) {
    assert.ok(filesCoverPath(realManifest.files, name), `${name} must be in the files allowlist`);
  }
  // And the pattern is what covers it — a manifest that named one chunk by hand
  // would silently drop the next one.
  assert.ok(realManifest.files.some((entry) => /[*?]/.test(entry)), 'the chunks are covered by a pattern');
});

// #endregion

// #region each way a checkout can be incomplete

test('prepare: an unreadable manifest is a failure, not a throw', () => {
  for (const pkg of [null, undefined, 'not-an-object']) {
    const result = inspectPackage({ pkg, ...memIo({}) });
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result, PREPARE_FAIL), ['MANIFEST-UNREADABLE']);
  }
});

test('prepare: a missing entry point fails and names the declaring field', () => {
  const result = inspect({ 'index.js': undefined });
  assert.equal(result.ok, false);
  assert.ok(codes(result, PREPARE_FAIL).includes('ENTRY-MISSING'));
  const message = result.findings.find((finding) => finding.code === 'ENTRY-MISSING').message;
  assert.match(message, /exports\["\.\"\]/);
  assert.match(message, /index\.js/);
});

test('prepare: a whitespace-only entry file fails', () => {
  const result = inspect({ 'index.js': '   \n\t\n' });
  assert.ok(codes(result, PREPARE_FAIL).includes('ENTRY-EMPTY'));
  assert.equal(result.ok, false);
});

test('prepare: a manifest with no entry point at all fails', () => {
  const result = inspectPackage({ pkg: { name: 'x', files: ['index.js'] }, ...memIo(healthyFiles()) });
  assert.ok(codes(result, PREPARE_FAIL).includes('NO-ENTRYPOINT'));
});

test('prepare: a missing bundle patch fails; a patch with no rows only warns', () => {
  const missing = inspect({ 'cordis.patch.yml': undefined });
  assert.ok(codes(missing, PREPARE_FAIL).includes('PATCH-MISSING'));

  const empty = inspect({ 'cordis.patch.yml': '# nothing here\n' });
  assert.equal(empty.ok, true);
  assert.ok(codes(empty, PREPARE_WARN).includes('PATCH-EMPTY'));
});

test('prepare: a patch row this package cannot resolve fails; an external row does not', () => {
  const typo = inspect({ 'cordis.patch.yml': '- insert:\n    - id: demo\n      name: demo-plugin/tpyo\n' });
  assert.equal(typo.ok, false);
  assert.ok(codes(typo, PREPARE_FAIL).includes('ROW-NO-SUBPATH-EXPORT'));

  const noEntry = inspect({ 'cordis.patch.yml': '- insert:\n    - id: demo\n      name: demo-plugin\n' }, healthyManifest({ main: undefined, exports: { './client': './client.js' } }));
  assert.equal(noEntry.ok, false);
  assert.ok(codes(noEntry, PREPARE_FAIL).includes('ROW-NO-ENTRY'));

  const external = inspect({ 'cordis.patch.yml': '- insert:\n    - id: base\n      name: "@deepseek-ai/dsh-base"\n' });
  assert.equal(external.ok, true);
  assert.ok(codes(external, PREPARE_OK).includes('PATCH-EXTERNAL'));
});

test('prepare: a patch row naming an entry that is absent fails', () => {
  const result = inspect({
    'cordis.patch.yml': '- insert:\n    - id: demo\n      name: demo-plugin/client\n',
    'client.js': undefined,
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result, PREPARE_FAIL).includes('ROW-ENTRY-MISSING'));
});

test('prepare: `files` entries must exist, and a directory must not be empty', () => {
  const listed = ['index.js', 'client.js', 'cordis.patch.yml'];
  const ghost = inspect({}, healthyManifest({ files: [...listed, 'ghost.js'] }));
  assert.equal(ghost.ok, false);
  assert.ok(codes(ghost, PREPARE_FAIL).includes('FILES-MISSING'));

  const emptyDir = inspect({ 'core/': [] }, healthyManifest({ files: [...listed, 'core'] }));
  assert.equal(emptyDir.ok, false);
  assert.ok(codes(emptyDir, PREPARE_FAIL).includes('FILES-MISSING'));

  const fullDir = inspect({ 'core/': ['a.js'] }, healthyManifest({ files: [...listed, 'core'] }));
  assert.equal(fullDir.ok, true);
  assert.ok(codes(fullDir, PREPARE_OK).includes('FILES-DIR'));
});

test('prepare: a `files` glob must match something, and it is anchored at the root', () => {
  const listed = ['index.js', 'client.js', 'cordis.patch.yml'];
  const chunk = `${FINGERPRINT_BEGIN}\nwindow.__chunk = 1\n${FINGERPRINT_END}\n`;
  // g-045: a chunked bundle keeps its chunks in the allowlist by pattern, so a
  // new chunk must not need a manifest edit to ship.
  const matched = inspect(
    {
      './': ['index.js', 'client.js', 'client.history.js', 'cordis.patch.yml', 'core'],
      'client.history.js': chunk,
    },
    healthyManifest({ files: [...listed, 'client.*.js'] }),
  );
  assert.ok(codes(matched, PREPARE_OK).includes('FILES-GLOB'), 'a matching pattern is a pass');
  // A pattern that matches nothing is a failure, not a silent no-op: the
  // published tarball would be missing files the author meant to ship.
  const unmatched = inspect(
    { './': ['index.js', 'client.js', 'cordis.patch.yml'] },
    healthyManifest({ files: [...listed, 'client.*.js'] }),
  );
  assert.equal(unmatched.ok, false);
  assert.ok(codes(unmatched, PREPARE_FAIL).includes('FILES-MISSING'));
  // Anchored at the package root: a nested file the loader could never fetch
  // does not satisfy the pattern.
  const nested = inspect(
    { './': ['index.js', 'client.js', 'cordis.patch.yml', 'nested'], 'nested/': ['client.x.js'] },
    healthyManifest({ files: [...listed, 'client.*.js'] }),
  );
  assert.equal(nested.ok, false);
  assert.ok(codes(nested, PREPARE_FAIL).includes('FILES-MISSING'));
});

test('prepare: no `files` field warns but still installs', () => {
  const result = inspect({}, healthyManifest({ files: undefined }));
  assert.equal(result.ok, true);
  assert.ok(codes(result, PREPARE_WARN).includes('NO-FILES'));
});

test('prepare: an entry point outside the `files` allowlist is a failure', () => {
  // Measured packing behaviour: what the user receives is the allowlist, so an
  // entry point it omits is guaranteed absent — not "possibly missing".
  const result = inspect({}, healthyManifest({ files: ['index.js', 'cordis.patch.yml'] }));
  assert.equal(result.ok, false);
  assert.ok(codes(result, PREPARE_FAIL).includes('NOT-SHIPPED'));
  const finding = result.findings.find((entry) => entry.code === 'NOT-SHIPPED');
  assert.match(finding.message, /client\.js/);
});

test('prepare: the bundle patch must ship too, or the layer never activates', () => {
  const result = inspect({}, healthyManifest({ files: ['index.js', 'client.js'] }));
  assert.equal(result.ok, false);
  const finding = result.findings.find((entry) => entry.code === 'NOT-SHIPPED');
  assert.match(finding.message, /cordis\.patch\.yml/);
});

test('prepare: filesCoverPath honors directories, globs and plain paths', () => {
  assert.equal(filesCoverPath(['core'], 'core/a.js'), true);
  assert.equal(filesCoverPath(['core/'], 'core/a/b.js'), true);
  assert.equal(filesCoverPath(['core/**'], 'core/a/b.js'), true);
  assert.equal(filesCoverPath(['core/*'], 'core/a.js'), true);
  assert.equal(filesCoverPath(['core/*'], 'core/a/b.js'), false);
  assert.equal(filesCoverPath(['./index.js'], 'index.js'), true);
  assert.equal(filesCoverPath(['index.js'], 'index2.js'), false);
  assert.equal(filesCoverPath(['inde?.js'], 'index.js'), true);
  assert.equal(filesCoverPath([], 'index.js'), false);
  assert.equal(filesCoverPath(undefined, 'index.js'), false);
  // g-045: the chunk pattern the bundle relies on, and the sub-path it must not
  // reach across.
  assert.equal(filesCoverPath(['client.*.js'], 'client.history.js'), true);
  assert.equal(filesCoverPath(['client.*.js'], 'client.js'), false);
  assert.equal(filesCoverPath(['client.*.js'], 'lib/client.history.js'), false);
  assert.equal(globMatches('client.*.js', 'client.history.js'), true);
  assert.equal(globMatches('client.*.js', 'client.js'), false);
  assert.equal(globMatches('client.js', 'client.js'), true);
  assert.equal(globMatches('', 'client.js'), false);
});

test('prepare: a declared client half must have an export and a usable fingerprint', () => {
  const noExport = inspect({}, healthyManifest({ exports: { '.': './index.js' } }));
  assert.equal(noExport.ok, false);
  assert.ok(codes(noExport, PREPARE_FAIL).includes('CLIENT-NO-EXPORT'));

  const noMarkers = inspect({ 'client.js': 'window.__x = 1\n' });
  assert.equal(noMarkers.ok, false);
  assert.ok(codes(noMarkers, PREPARE_FAIL).includes('CLIENT-FINGERPRINT'));

  // Two begin markers make the region ambiguous: the module refuses to guess,
  // so the gate must refuse the checkout.
  const duplicated = inspect({
    'client.js': `${FINGERPRINT_BEGIN}\na\n${FINGERPRINT_BEGIN}\nb\n${FINGERPRINT_END}\n`,
  });
  assert.equal(duplicated.ok, false);
  assert.ok(codes(duplicated, PREPARE_FAIL).includes('CLIENT-FINGERPRINT'));

  const ordered = inspect({ 'client.js': `${FINGERPRINT_END}\n${FINGERPRINT_BEGIN}\n` });
  assert.equal(ordered.ok, false);
  assert.ok(codes(ordered, PREPARE_FAIL).includes('CLIENT-FINGERPRINT'));
});

test('prepare: runtime dependencies are reported and do not fail the install', () => {
  const result = inspect({}, healthyManifest({ dependencies: { 'some-dep': '^1.0.0' } }));
  assert.equal(result.ok, true);
  assert.ok(codes(result, PREPARE_WARN).includes('RUNTIME-DEPS'));
});

// #endregion

// #region end to end on a throwaway package

test('prepare: the script fails an incomplete checkout with a non-zero exit code', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-prepare-'));
  try {
    // A package whose manifest declares a client export that was never
    // committed — exactly the git-install failure mode the gate exists for.
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'core'));
    for (const file of ['prepare.js', 'build.js']) {
      cpSync(join(packageRoot, 'core', file), join(root, 'core', file));
    }
    cpSync(join(packageRoot, 'scripts', 'prepare.mjs'), join(root, 'scripts', 'prepare.mjs'));
    writeFileSync(join(root, 'index.js'), 'export const name = "broken"\n');
    writeFileSync(join(root, 'cordis.patch.yml'), '- insert:\n    - id: broken\n      name: broken-plugin\n');
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify(
        {
          name: 'broken-plugin',
          version: '0.0.0',
          type: 'module',
          main: 'index.js',
          exports: { '.': './index.js', './client': './client.js' },
          files: ['index.js', 'client.js', 'cordis.patch.yml', 'scripts'],
          dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
          scripts: { prepare: 'node scripts/prepare.mjs' },
        },
        null,
        2,
      )}\n`,
    );

    const run = spawnSync(process.execPath, ['scripts/prepare.mjs'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(run.status, 0, `expected a non-zero exit\n${run.stdout}`);
    assert.match(run.stdout, /FAIL {2}ENTRY-MISSING/);
    assert.match(run.stdout, /prepare：失败/);

    // The same package, made complete, passes — the failure was the missing
    // bytes, not the temp directory.
    writeFileSync(join(root, 'client.js'), `${FINGERPRINT_BEGIN}\nx\n${FINGERPRINT_END}\n`);
    const fixed = spawnSync(process.execPath, ['scripts/prepare.mjs'], { cwd: root, encoding: 'utf8' });
    assert.equal(fixed.status, 0, `expected exit 0\n${fixed.stdout}\n${fixed.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #endregion

/**
 * Store assertions: path resolution, validation on read, and the atomic-write
 * guarantee (proved by replacement semantics, not by inspection).
 *
 * Every test writes into a fresh temp directory. Nothing here may touch
 * `~/.dsh`: the user-layer path is always redirected through `DSH_HOME`.
 *
 * Run: `node --test test/`
 */
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { emptyConfig } from '../core/overrides.js';
import {
  clientBuildInfo,
  readConfig,
  removeOverride,
  resolveDshHome,
  upsertOverride,
  userConfigPath,
  workspaceConfigPath,
  writeConfig,
} from '../core/store.js';

/** Create a disposable directory for one test. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'dsh-prompt-setting-test-'));
}

/** A valid config with one override. */
function configWith(...overrides) {
  return { version: 1, overrides };
}

test('paths: $DSH_HOME wins, blank falls back to ~/.dsh, and cwd is never consulted', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/tmp/custom-home' }), '/tmp/custom-home');
  assert.equal(resolveDshHome({ DSH_HOME: '' }), join(homedir(), '.dsh'));
  assert.equal(resolveDshHome({}), join(homedir(), '.dsh'));
  assert.equal(resolveDshHome(undefined), join(homedir(), '.dsh'));
  assert.equal(userConfigPath({ DSH_HOME: '/tmp/custom-home' }), '/tmp/custom-home/prompt-setting/overrides.json');
  assert.equal(workspaceConfigPath('/repo/root'), '/repo/root/.dsh-prompt-setting/overrides.json');
  // The resolved path must not embed the current working directory.
  assert.equal(userConfigPath({ DSH_HOME: '/tmp/custom-home' }).includes(process.cwd()), false);
  assert.equal(workspaceConfigPath('/repo/root').includes(process.cwd()), false);
});

test('readConfig: a missing file is an empty, usable layer', () => {
  const dir = scratch();
  try {
    const result = readConfig(join(dir, 'nothing', 'here.json'));
    assert.equal(result.missing, true);
    assert.equal(result.error, null);
    assert.deepEqual(result.config, emptyConfig());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfig: unparsable and invalid files report a code instead of throwing', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'overrides.json');
    writeFileSync(path, '{ not json', 'utf8');
    const broken = readConfig(path);
    assert.equal(broken.config, null);
    assert.equal(broken.error.code, 'invalid-json');
    assert.match(broken.error.message, /overrides\.json/);

    writeFileSync(path, JSON.stringify({ version: 9, overrides: [] }), 'utf8');
    assert.equal(readConfig(path).error.code, 'unsupported-version');

    writeFileSync(path, JSON.stringify({ overrides: [{ name: 'a', action: 'explode' }] }), 'utf8');
    assert.equal(readConfig(path).error.code, 'unknown-action');

    writeFileSync(path, 'null', 'utf8');
    assert.equal(readConfig(path).error.code, 'invalid-config');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfig: a valid file round-trips', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'overrides.json');
    const config = configWith({ name: 'a', action: 'replace', text: 'A' });
    writeConfig(path, config);
    const result = readConfig(path);
    assert.equal(result.error, null);
    assert.deepEqual(result.config, config);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeConfig: creates the directory chain and writes stable, human-readable JSON', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'deep', 'nested', 'overrides.json');
    writeConfig(path, configWith({ name: 'a', action: 'hide' }));
    const raw = readFileSync(path, 'utf8');
    assert.match(raw, /\n {2}"overrides": \[/);
    assert.equal(raw.endsWith('\n'), true);
    assert.deepEqual(JSON.parse(raw), configWith({ name: 'a', action: 'hide' }));
    assert.deepEqual(readdirSync(join(dir, 'deep', 'nested')), ['overrides.json'], 'no temp file may survive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeConfig: replacement is atomic — the old file survives under a hard link', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'overrides.json');
    const alias = join(dir, 'alias.json');
    writeConfig(path, configWith({ name: 'a', action: 'replace', text: 'FIRST' }));
    const firstInode = statSync(path).ino;
    // A hard link shares the inode. `rename` swaps the directory entry for a
    // NEW inode, so the alias keeps the old bytes; an in-place
    // `writeFile(path, ...)` would rewrite the shared inode and the alias would
    // show the new bytes. This is what makes "atomic" a testable claim.
    linkSync(path, alias);
    writeConfig(path, configWith({ name: 'a', action: 'replace', text: 'SECOND' }));

    assert.equal(JSON.parse(readFileSync(path, 'utf8')).overrides[0].text, 'SECOND');
    assert.equal(JSON.parse(readFileSync(alias, 'utf8')).overrides[0].text, 'FIRST', 'the old file must be intact');
    assert.notEqual(statSync(path).ino, firstInode, 'the target must be a new inode, not a rewritten one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeConfig: a failure before the rename leaves the previous file untouched', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'overrides.json');
    writeConfig(path, configWith({ name: 'a', action: 'replace', text: 'ORIGINAL' }));
    // A circular structure cannot be serialized, so the write aborts after the
    // target has been read but before any byte of it could be replaced.
    const circular = { version: 1, overrides: [] };
    circular.self = circular;
    assert.throws(() => writeConfig(path, circular), /cannot serialize config/);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).overrides[0].text, 'ORIGINAL');
    assert.deepEqual(readdirSync(dir), ['overrides.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeConfig: an unusable target directory is a structured error, not a crash', () => {
  const dir = scratch();
  try {
    const blocked = join(dir, 'blocked');
    mkdirSync(blocked);
    writeFileSync(join(blocked, 'child'), 'x', 'utf8');
    // `blocked` is a file, so it cannot become the config's directory.
    assert.throws(
      () => writeConfig(join(blocked, 'child', 'overrides.json'), emptyConfig()),
      (error) => error.code === 'unwritable-directory' || error.code === 'write-failed',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('upsertOverride: inserts a new name and replaces an existing one in place', () => {
  const withOne = upsertOverride(emptyConfig(), { name: 'a', action: 'hide' });
  assert.deepEqual(withOne.overrides, [{ name: 'a', action: 'hide' }]);
  const withTwo = upsertOverride(withOne, { name: 'b', action: 'hide' });
  assert.deepEqual(withTwo.overrides.map((entry) => entry.name), ['a', 'b']);
  const replaced = upsertOverride(withTwo, { name: 'a', action: 'replace', text: 'A' });
  assert.deepEqual(replaced.overrides, [
    { name: 'a', action: 'replace', text: 'A' },
    { name: 'b', action: 'hide' },
  ]);
  assert.equal(withTwo.overrides[0].action, 'hide', 'the input config must not be mutated');
});

test('removeOverride: drops one name and reports whether anything was there', () => {
  const config = configWith({ name: 'a', action: 'hide' }, { name: 'b', action: 'hide' });
  const dropped = removeOverride(config, 'a');
  assert.equal(dropped.removed, true);
  assert.deepEqual(dropped.config.overrides, [{ name: 'b', action: 'hide' }]);
  assert.equal(config.overrides.length, 2, 'the input config must not be mutated');
  const missing = removeOverride(config, 'zzz');
  assert.equal(missing.removed, false);
  assert.equal(missing.config, config);
});

// #region clientBuildInfo — the build stamp's one filesystem read (Revision 6)

/** Markers as they appear in `client.js`; written literally so a rename is caught. */
const BUILD_BEGIN = '/* @build-fingerprint:begin */';
const BUILD_END = '/* @build-fingerprint:end */';

test('clientBuildInfo: hashes a readable bundle and is not cached between reads', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'client.js');
    writeFileSync(path, `${BUILD_BEGIN}\nBODY\n${BUILD_END}\n`, 'utf8');
    const info = clientBuildInfo(path);
    // FNV-1a 32 of the region text "\nBODY\n" — pinned as a regression oracle,
    // not recomputed with the code under test.
    assert.equal(info.hash, 'af0ab245');
    assert.equal(info.size, 6);
    assert.equal(info.mtime, statSync(path).mtime.toISOString());

    // The whole point of reading per request: the next call must see the new
    // bytes, never an answer cached from the previous one.
    writeFileSync(path, `${BUILD_BEGIN}\nBODY!\n${BUILD_END}\n`, 'utf8');
    const after = clientBuildInfo(path);
    assert.equal(after.hash, '5b32638a', 'a changed region must change the reported digest');
    assert.equal(after.size, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clientBuildInfo: unreadable file or unusable region is null, and never throws', () => {
  const dir = scratch();
  try {
    assert.equal(clientBuildInfo(join(dir, 'missing.js')), null, 'a missing bundle is unknown');
    assert.equal(clientBuildInfo(join(dir, 'deep', 'missing.js')), null, 'a missing directory is unknown too');
    const directory = join(dir, 'a-directory');
    mkdirSync(directory);
    // Reading a directory fails on every supported platform (and where it does
    // not, the text carries no markers) — both paths must end in `null`.
    assert.equal(clientBuildInfo(directory), null);

    const path = join(dir, 'client.js');
    writeFileSync(path, 'no markers here', 'utf8');
    assert.equal(clientBuildInfo(path), null, 'markers edited away ⇒ unknown, never a fabricated digest');
    writeFileSync(path, `${BUILD_BEGIN}${BUILD_BEGIN}BODY${BUILD_END}`, 'utf8');
    assert.equal(clientBuildInfo(path), null, 'duplicated markers ⇒ unknown');
    writeFileSync(path, `${BUILD_END}BODY${BUILD_BEGIN}`, 'utf8');
    assert.equal(clientBuildInfo(path), null, 'reversed markers ⇒ unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #endregion

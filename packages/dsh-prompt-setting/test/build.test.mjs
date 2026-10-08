/**
 * Build-fingerprint assertions (`core/build.js`).
 *
 * The stamp is only worth having if a wrong answer is *impossible*: a false
 * 「一致」 hides exactly the stale bundle the feature exists to expose, and a
 * false 「过期」 sends the reader chasing a bundle that is fine. So these tests
 * pin three separate things:
 *   1. the algorithm is the published FNV-1a 32, checked against its official
 *      vectors rather than against itself;
 *   2. the region rules (one ordered, unique marker pair) degrade to `null`
 *      instead of guessing;
 *   3. the **real** `client.js` region covers the whole factory body, so a
 *      change anywhere in the page moves the digest.
 *
 * Run: `node --test`
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FINGERPRINT_BEGIN,
  FINGERPRINT_END,
  fingerprintOf,
  fingerprintRegion,
  fnv1a32,
  normalizeBuildText,
} from '../core/build.js';
import { clientChunkStamps, CLIENT_CHUNK_PATTERN } from '../core/store.js';
import { readDeclaredStamps, writeDeclaredStamps } from '../scripts/client-chunks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
/** The package root — the entry file and its chunks both live here. */
const packageDir = join(here, '..');
const CLIENT_PATH = join(here, '..', 'client.js');
const clientSource = readFileSync(CLIENT_PATH, 'utf8');

/**
 * The marker strings are written out here on purpose: this file must be able to
 * detect a marker rename/typo, so it may not learn them from the module under
 * test. They are *also* asserted to equal the exports, so the two can never
 * drift apart.
 */
const BEGIN = '/* @build-fingerprint:begin */';
const END = '/* @build-fingerprint:end */';

/** Wrap a body in one marker pair. */
function stamped(text) {
  return `/* preamble */\n${BEGIN}${text}${END}\n/* epilogue */`;
}

/** Count non-overlapping occurrences of a needle. */
function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('build: the exported markers are the ones this file hard-codes', () => {
  assert.equal(FINGERPRINT_BEGIN, BEGIN);
  assert.equal(FINGERPRINT_END, END);
});

test('build: fnv1a32 is the published FNV-1a 32-bit algorithm (official vectors)', () => {
  // Standard FNV-1a 32 test vectors — an independent oracle, so a silent change
  // of prime/offset/order cannot pass by agreeing with itself.
  assert.equal(fnv1a32(''), 0x811c9dc5);
  assert.equal(fnv1a32('a'), 0xe40c292c);
  assert.equal(fnv1a32('b'), 0xe70c2de5);
  assert.equal(fnv1a32('foobar'), 0xbf9cf968);
  // Same length, different bytes ⇒ different digest (the property the whole
  // feature rests on).
  assert.notEqual(fnv1a32('abcd'), fnv1a32('abce'));
});

test('build: the region excludes both markers and is hashed as-is', () => {
  const text = stamped('BODY');
  assert.equal(fingerprintRegion(text), 'BODY');
  const fingerprint = fingerprintOf(text);
  assert.deepEqual(fingerprint, { hash: fnv1a32('BODY').toString(16).padStart(8, '0'), size: 4 });
  assert.equal(fingerprint.hash.length, 8);
});

test('build: an empty region is a valid stamp, not a missing one', () => {
  assert.equal(fingerprintRegion(stamped('')), '');
  assert.deepEqual(fingerprintOf(stamped('')), { hash: '811c9dc5', size: 0 });
});

test('build: normalization folds BOM and CRLF/CR so a hop through CRLF cannot fake a mismatch', () => {
  assert.equal(normalizeBuildText('\uFEFFa\r\nb\rc\nd'), 'a\nb\nc\nd');
  const lf = stamped('line one\nline two\n');
  const crlf = `\uFEFF${lf.replace(/\n/g, '\r\n')}`;
  assert.equal(fingerprintRegion(crlf), fingerprintRegion(lf));
  assert.deepEqual(fingerprintOf(crlf), fingerprintOf(lf));
  // Only the first BOM is a BOM; a literal U+FEFF in the middle stays.
  assert.equal(normalizeBuildText('a\uFEFFb'), 'a\uFEFFb');
});

test('build: missing, unpaired, unordered or duplicated markers are null — never a guess', () => {
  const body = 'BODY';
  assert.equal(fingerprintRegion('no markers at all'), null);
  assert.equal(fingerprintRegion(`${BEGIN}${body}`), null, 'begin without end');
  assert.equal(fingerprintRegion(`${body}${END}`), null, 'end without begin');
  assert.equal(fingerprintRegion(`${END}${body}${BEGIN}`), null, 'reversed pair');
  assert.equal(fingerprintRegion(`${BEGIN}${body}${BEGIN}${body}${END}`), null, 'two begin markers');
  assert.equal(fingerprintRegion(`${BEGIN}${body}${END}${body}${END}`), null, 'two end markers');
  // The whole-shape function degrades identically, and still never throws.
  for (const text of ['', 'no markers', `${BEGIN}${body}`, `${END}${body}${BEGIN}`, `${BEGIN}a${BEGIN}b${END}`]) {
    assert.equal(fingerprintOf(text), null, `null for ${JSON.stringify(text)}`);
  }
  assert.equal(fingerprintOf(undefined), null);
  assert.equal(fingerprintOf(null), null);
  assert.equal(fingerprintOf(42), null);
});

test('build: one changed character inside the region changes the hash, and only the hash', () => {
  // Negative control for criterion 1: a same-length edit is the hard case — a
  // length-only "fingerprint" would call these two files identical.
  const original = readFileSync(CLIENT_PATH, 'utf8');
  const before = fingerprintOf(original);
  assert.notEqual(before, null);
  const inside = original.indexOf(BEGIN) + BEGIN.length + 200;
  const flipped = original[inside] === 'x' ? 'y' : 'x';
  const mutated = `${original.slice(0, inside)}${flipped}${original.slice(inside + 1)}`;
  const after = fingerprintOf(mutated);
  assert.equal(after.size, before.size, 'the edit is length-preserving');
  assert.notEqual(after.hash, before.hash, 'a one-character edit inside the region must move the digest');
  // A one-character edit *outside* the region must not: that is what makes the
  // region boundary meaningful (and is why docs/headers live outside it).
  const outside = original.indexOf(END) + END.length + 5;
  const outsideMutated = `${original.slice(0, outside)}${original[outside] === 'x' ? 'y' : 'x'}${original.slice(outside + 1)}`;
  assert.equal(fingerprintOf(outsideMutated).hash, before.hash);
});

test('build: the real client.js region covers every byte the entry factory runs', () => {
  // Exactly one ordered pair: two markers would make the region ambiguous and
  // silently degrade every machine to「未知」. This invariant survives the
  // g-045 split unchanged — the entry file still carries exactly one pair.
  assert.equal(occurrences(clientSource, BEGIN), 1, 'exactly one begin marker');
  assert.equal(occurrences(clientSource, END), 1, 'exactly one end marker');
  assert.ok(clientSource.indexOf(BEGIN) < clientSource.indexOf(END), 'begin precedes end');

  const region = fingerprintRegion(clientSource);
  assert.notEqual(region, null);
  // First statement of the factory body …
  assert.ok(region.includes("const React = require('react');"), 'region starts at the factory body');
  // … and the last one, so nothing in between can change unnoticed.
  assert.ok(
    region.includes("'prompt-setting: section dictionaries'"),
    'region reaches the end of the factory body',
  );
  assert.ok(region.includes('const SELF_BUILD = fingerprintOf(promptSettingFactory.toString());'));
  // g-045: the region is no longer "the whole implementation" — a chunk's bytes
  // are not in `factory.toString()`. What replaces that guarantee is the chunk
  // manifest *inside* the region plus the host's per-chunk digests; the manifest
  // has to be part of the entry's own digest, or adding or dropping a chunk
  // would not move the stamp at all.
  assert.ok(region.includes('const CHUNK_STAMPS = Object.freeze(['), 'the chunk manifest is inside the region');
  assert.ok(region.includes('CHUNK_STAMPS'), 'and the verdict reads it');
  // The factory header itself is outside: the region is the *body*, and both
  // halves slice the same body (the host from the file, the page from toString).
  assert.equal(region.includes('function promptSettingFactory'), false);

  const fingerprint = fingerprintOf(clientSource);
  assert.match(fingerprint.hash, /^[0-9a-f]{8}$/);
  assert.equal(fingerprint.size, region.length);
  // The floor is the entry file's own body, not the pre-split single file's:
  // the implementation now lives in the entry *plus* its chunks, and the chunks
  // are covered by the manifest + the host's per-file digests instead.
  assert.ok(fingerprint.size > 50000, 'the region is the bulk of the entry file');
});

test('build: every chunk carries one marker pair and is registered as a flat sibling', () => {
  const chunkFiles = readdirSync(packageDir)
    .filter((name) => CLIENT_CHUNK_PATTERN.test(name))
    .sort();
  assert.ok(chunkFiles.length >= 1, 'the split bundle ships at least one chunk');
  for (const name of chunkFiles) {
    const source = readFileSync(join(packageDir, name), 'utf8');
    assert.equal(occurrences(source, BEGIN), 1, `${name}: exactly one begin marker`);
    assert.equal(occurrences(source, END), 1, `${name}: exactly one end marker`);
    assert.ok(source.indexOf(BEGIN) < source.indexOf(END), `${name}: begin precedes end`);
    const region = fingerprintRegion(source);
    assert.notEqual(region, null, `${name}: usable region`);
    // The chunk registers itself as a chunk of this very package — the loader
    // refuses any other spelling, and a chunk that registers nothing is loaded
    // and then cannot be resolved.
    assert.ok(source.includes('window.__ModuleLoader__.load({'), `${name}: registers itself`);
    assert.match(source, /chunk: '[^']+'/, `${name}: declares its chunk file name`);
    assert.ok(source.includes('chunk: \'' + name + '\''), `${name}: declares its own file name`);
    // The factory is a *named function expression*, which is the only way the
    // chunk can digest `toString()` and report it back to the page.
    const factoryName = region !== null && /function ([A-Za-z_$][\w$]*)\(require\)/.exec(source);
    assert.notEqual(factoryName, null, `${name}: the factory is a named function expression`);
    assert.ok(region.includes(`${factoryName[1]}.toString()`), `${name}: digests its own running bytes`);
  }
});

test('build: the CHUNK_STAMPS manifest is exactly what the chunk files hash to', () => {
  // The manifest is what makes a chunk edit visible to the entry's digest, and
  // the host's per-chunk digests are what catch it when the manifest is stale.
  // The two are only useful together if the manifest is true — so it is checked
  // against the bytes, and `scripts/client-chunks.mjs --write` is the way to
  // repair it.
  const declared = readDeclaredStamps(clientSource);
  const actual = clientChunkStamps(packageDir);
  // The manifest carries the two fields the page compares; the host adds an
  // mtime the manifest has no use for, so only those two are compared here.
  assert.deepEqual(
    declared,
    actual.map((stamp) => ({ name: stamp.name, hash: stamp.hash, size: stamp.size })),
    'run `node scripts/client-chunks.mjs --write` after editing a chunk',
  );
  assert.ok(actual.length >= 1);
  for (const stamp of actual) {
    assert.match(stamp.hash, /^[0-9a-f]{8}$/);
    assert.ok(stamp.size > 0);
  }
});

test('build: a one-character edit in a chunk moves the digest the host reports (negative control)', () => {
  // Criterion 3's "改坏就红", at the level this suite can prove on its own: the
  // host's chunk digest is a function of the chunk's bytes, in the same region
  // the page would compute from `chunkFactory.toString()`.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prompt-setting-chunks-'));
  try {
    const name = 'client.probe.js';
    writeFileSync(join(dir, name), stamped('CHUNK BODY'), 'utf8');
    const before = clientChunkStamps(dir);
    assert.equal(before.length, 1);
    assert.equal(before[0].name, name);
    assert.equal(before[0].hash, fnv1a32('CHUNK BODY').toString(16).padStart(8, '0'));
    assert.equal(before[0].size, 'CHUNK BODY'.length);
    writeFileSync(join(dir, name), stamped('CHUNK BODZ'), 'utf8');
    const after = clientChunkStamps(dir);
    assert.notEqual(after[0].hash, before[0].hash, 'a clock-safe, length-preserving edit must move the digest');
    assert.equal(after[0].size, before[0].size);
    // A file whose markers are unusable is omitted, never reported with a
    // fabricated digest: the page would read a made-up answer as「不一致」.
    writeFileSync(join(dir, name), 'no markers here', 'utf8');
    assert.deepEqual(clientChunkStamps(dir), []);
    // A name the loader would refuse is not a chunk at all: no `client.` prefix,
    // and an empty first character after the dot.
    writeFileSync(join(dir, 'client-nested.js'), stamped('X'), 'utf8');
    writeFileSync(join(dir, 'client..js'), stamped('X'), 'utf8');
    assert.deepEqual(clientChunkStamps(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build: a manifest entry that stops matching the chunk moves the entry digest', () => {
  // The other half of criterion 3: the manifest lives inside the region, so a
  // chunk added, renamed or removed changes the entry's own digest even before
  // the host compares per-chunk digests.
  const before = fingerprintOf(clientSource);
  const mutated = writeDeclaredStamps(clientSource, [
    { name: 'client.history.js', hash: 'deadbeef', size: 99999 },
  ]);
  const after = fingerprintOf(mutated);
  assert.equal(after.size, before.size, 'the edit is length-preserving');
  assert.notEqual(after.hash, before.hash, 'the manifest is part of the entry digest');
  // And the disagreement is visible without any host: the manifest no longer
  // equals what the chunk on disk hashes to.
  assert.notDeepEqual(readDeclaredStamps(mutated), clientChunkStamps(packageDir));
});

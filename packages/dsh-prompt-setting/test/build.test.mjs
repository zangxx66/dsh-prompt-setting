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
import { readFileSync } from 'node:fs';
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

const here = dirname(fileURLToPath(import.meta.url));
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

test('build: the real client.js region covers the whole factory body', () => {
  // Exactly one ordered pair: two markers would make the region ambiguous and
  // silently degrade every machine to「未知」.
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
  // The factory header itself is outside: the region is the *body*, and both
  // halves slice the same body (the host from the file, the page from toString).
  assert.equal(region.includes('function promptSettingFactory'), false);

  const fingerprint = fingerprintOf(clientSource);
  assert.match(fingerprint.hash, /^[0-9a-f]{8}$/);
  assert.equal(fingerprint.size, region.length);
  assert.ok(fingerprint.size > 100000, 'the region is the bulk of the file');
});

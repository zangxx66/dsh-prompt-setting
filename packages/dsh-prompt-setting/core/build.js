/**
 * Client build fingerprint — the pure half of the「构建戳」.
 *
 * Why this exists: a settings tab can keep running a **stale** `client.js`
 * bundle after the file on disk changed (the host serves the new bytes; the
 * already-open tab never re-executes them). Nothing on the page said which
 * bundle it was, so the only way to tell was to guess. This module answers a
 * narrower, checkable question: *which bytes is this document showing?*
 *
 * How: `client.js` carries exactly one pair of marker comments inside its
 * factory body, and the text **between** them is the fingerprint region. The
 * host fingerprints the file it publishes ({@link module:dsh-prompt-setting/core/store}
 * `clientBuildInfo`), the page fingerprints the running function
 * (`factory.toString()`), and the two 8-hex digests are compared. The browser
 * half cannot import this module (it is loaded into `window` by the module
 * loader, not by Node), so `client.js` carries an inlined equivalent and the
 * tests assert the two agree **bit for bit** on the real file.
 *
 * Invariants, all asserted by `test/build.test.mjs`:
 * - **no IO and no Node built-ins** — this module is pure text in, text out, so
 *   it can be reasoned about (and copied) without a filesystem;
 * - the markers must be **unique** and **ordered**; anything else is `null`,
 *   never a wrong digest (a wrong digest would be read as a false「过期」);
 * - normalization removes a leading BOM and folds CRLF/CR to LF before hashing,
 *   so a newline-normalizing hop between disk and browser cannot fabricate a
 *   mismatch;
 * - the digest is 32-bit FNV-1a over **UTF-16 code units**, not UTF-8 bytes.
 *   That is the one encoding the browser can compute without a library, and
 *   `readFileSync(path, 'utf8')` + `charCodeAt` reproduces it exactly.
 *
 * @module dsh-prompt-setting/core/build
 */

/** Opening marker. Its text must occur exactly once in `client.js`. */
export const FINGERPRINT_BEGIN = '/* @build-fingerprint:begin */';
/** Closing marker. Its text must occur exactly once in `client.js`. */
export const FINGERPRINT_END = '/* @build-fingerprint:end */';

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/**
 * Normalize text before hashing: drop one leading BOM and fold every CRLF/CR
 * to LF. Anything that does not change the text's meaning on either side of
 * the wire must not change its digest, or a passthrough hop would look like a
 * stale bundle.
 * @param text - any value; non-strings are stringified.
 * @returns the normalized text (never throws).
 */
export function normalizeBuildText(text) {
  let value = typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text);
  if (value.charCodeAt(0) === 0xfeff) value = value.slice(1);
  return value.replace(/\r\n?/g, '\n');
}

/**
 * Extract the fingerprint region: the text between the two markers.
 *
 * `null` (never a guess) when the text does not carry exactly one begin marker
 * followed by exactly one end marker.
 * @param text - the file (or `factory.toString()`) text.
 * @returns the region, or `null`.
 */
export function fingerprintRegion(text) {
  const value = normalizeBuildText(text);
  const begin = value.indexOf(FINGERPRINT_BEGIN);
  if (begin === -1) return null;
  const end = value.indexOf(FINGERPRINT_END);
  if (end === -1) return null;
  // Ambiguous markers are refused, not resolved: picking one of two regions
  // would make two different files claim the same identity.
  if (value.indexOf(FINGERPRINT_BEGIN, begin + FINGERPRINT_BEGIN.length) !== -1) return null;
  if (value.indexOf(FINGERPRINT_END, end + FINGERPRINT_END.length) !== -1) return null;
  if (begin >= end) return null;
  return value.slice(begin + FINGERPRINT_BEGIN.length, end);
}

/**
 * FNV-1a over UTF-16 code units.
 * @param text - the region text.
 * @returns the digest as an unsigned 32-bit number.
 */
export function fnv1a32(text) {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash;
}

/**
 * Fingerprint a whole file's {@link fingerprintRegion}.
 * @param text - the file text.
 * @returns `{hash, size}` (8 lowercase hex digits; `size` is the normalized
 *   region's length in UTF-16 code units), or `null` when the region is
 *   unusable.
 */
export function fingerprintOf(text) {
  const region = fingerprintRegion(text);
  if (region === null) return null;
  return { hash: fnv1a32(region).toString(16).padStart(8, '0'), size: region.length };
}

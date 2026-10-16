    /* @build-fingerprint:begin */
    // #region build stamp — the fingerprint region
    // Everything between the two marker comments above/below is the region the
    // host hashes (core/build.js `fingerprintOf`). It must cover the whole
    // factory body: anything outside the region could change without changing
    // the digest, i.e. a silently false「一致」.
    //
    // The markers are assembled from two string pieces *on purpose*: the marker
    // text has to occur exactly once in this file, and a literal copy here
    // would be that second occurrence — `fingerprintRegion` refuses ambiguous
    // markers, so the stamp would degrade to「未知」for everyone.
    const FINGERPRINT_BEGIN = '/* @build-' + 'fingerprint:begin */';
    const FINGERPRINT_END = '/* @build-' + 'fingerprint:end */';
    const FNV_OFFSET_BASIS = 0x811c9dc5;
    const FNV_PRIME = 0x01000193;

    /**
     * Inline twin of `core/build.js` — the browser cannot import host code, so
     * the same three pure functions are repeated here. `test/build.test.mjs`
     * and `test/client.test.mjs` assert the two copies agree bit for bit on
     * this real file; keep them in sync by hand if either changes.
     * @param text - any value; non-strings are stringified.
     * @returns the normalized text (never throws).
     */
    function normalizeBuildText(text) {
      let value = typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text);
      if (value.charCodeAt(0) === 0xfeff) value = value.slice(1);
      return value.replace(/\r\n?/g, '\n');
    }

    /**
     * The text between exactly one ordered pair of markers, else `null`.
     * @param text - the file (or factory) text.
     * @returns the region, or `null`.
     */
    function fingerprintRegion(text) {
      const value = normalizeBuildText(text);
      const begin = value.indexOf(FINGERPRINT_BEGIN);
      if (begin === -1) return null;
      const end = value.indexOf(FINGERPRINT_END);
      if (end === -1) return null;
      if (value.indexOf(FINGERPRINT_BEGIN, begin + FINGERPRINT_BEGIN.length) !== -1) return null;
      if (value.indexOf(FINGERPRINT_END, end + FINGERPRINT_END.length) !== -1) return null;
      if (begin >= end) return null;
      return value.slice(begin + FINGERPRINT_BEGIN.length, end);
    }

    /**
     * FNV-1a over UTF-16 code units (no `Buffer` in a browser).
     * @param text - the region text.
     * @returns the 8-hex-digit digest plus the region length.
     */
    function fingerprintOf(text) {
      const region = fingerprintRegion(text);
      if (region === null) return null;
      let hash = FNV_OFFSET_BASIS;
      for (let index = 0; index < region.length; index += 1) {
        hash ^= region.charCodeAt(index);
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
      }
      return { hash: hash.toString(16).padStart(8, '0'), size: region.length };
    }

    /**
     * Which bytes this tab is running. `null` when this engine will not hand
     * back the source (or the markers are unusable) — rendered as「未知」.
     */
    const SELF_BUILD = fingerprintOf(promptSettingFactory.toString());
    // #endregion

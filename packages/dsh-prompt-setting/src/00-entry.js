// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。
/**
 * `dsh-prompt-setting` — Client half (stage 1C: the Prompt manager settings page).
 *
 * Hand-written CommonJS factory registered into the browser module loader:
 * no bundler, no JSX, no TypeScript, no runtime dependency beyond `react`
 * (and the optional `@deepseek-ai/dsh-client-ui-primitives` probe).
 *
 * Scope: a real page in 「设置 / Settings」 that consumes the frozen
 * `/prompt-setting/*` REST contract. Since g-015 the page is organised as four
 * first-level tabs, in a fixed order, with the first one open by default:
 *   1. **「我的 Prompt」** (`mine`) — the page's ONLY write surface. It writes
 *      the one name Revision 7 accepts, `prompt-setting:custom-prompt`, with
 *      `action: "replace"`, and can delete it again; its layer selector uses the
 *      page's existing `user`/`workspace` (`deriveScope`) semantics;
 *   2. **「提示词总览」** (`overview`) — strictly read-only: the assembled
 *      segment list with its origin/layer/applied markers, and the assembled
 *      text with search, the origin filter and the base ↔ effective comparison.
 *      No editor node and no `edit` / `append-new` / `delete` action exists in
 *      its tree, by construction;
 *   3. **「版本历史」** (`history`) — the history log with its **own** scope
 *      selector, its paging, and a viewport-sized two-column layout (record list
 *      beside the detail pane, neither ever stacking) carrying the version
 *      comparison, a record preview and the rollback control. Loaded lazily with
 *      the tab, and never sliced by the page's 「查看范围」 (g-038 / g-039);
 *   4. **「备份与恢复」** (`backup`) — the export/import surface, and only that
 *      (g-038 split it out of the old single tab: one tab may no longer be both
 *      a read-only log and the page's way to overwrite every file);
 *   5. **「高级」** (`advanced`) — the read-only legacy override list, the two
 *      layer-wide buttons (`legacy=true` clears the frozen overrides and keeps
 *      「我的 Prompt」; `reset=true` clears the whole layer), each behind its own
 *      second confirmation, plus the full status block.
 *
 * Above the tabs there are exactly two things: the title line (which carries
 * the plugin version beside the heading, Revision 17) and one line of deciding
 * facts (mounted / frozen three-state / build stamp). The session selector every
 * tab used to share is no longer chrome: since g-071 it is the first block
 * **inside**「我的 Prompt」, the only surface it writes. R4 (the owner's
 * real-machine review) removed the read-only scope line the other tabs briefly
 * carried: each of them has its own scope semantics, and decoupling them from
 * this page-level value is g-073 rather than something this page may assert. The
 * selector is
 * still sourced from the **props**
 * `useSessions` root hook, grouped as a workspace tree from the **props**
 * `useWorkspaces` root hook (same grouping/ordering/visibility rules as the
 * left sidebar), with a
 * flat searchable list when `useWorkspaces` is absent and a manual-id
 * degradation when `useSessions` is absent.
 *
 * The Revision 6 editor — arbitrary names, `hide`/`append`, the row-scoped
 * inline form, its action/layer tabs, its feasibility check and its tests — is
 * gone (CONTRACT.md §7 limitation 21 is closed by this page). That is a
 * product decision, not a simplification: the write face is one name wide, so a
 * UI that offers more is a UI that offers writes the Host refuses.
 *
 * Two hard rules from the earlier stages are preserved because they are what
 * keeps this page from going blank (see NOTES.md §4 and §7):
 *   - `primitives` vs `fallback` is *probed*, never assumed, and the branch
 *     actually taken is rendered as `data-renderer`;
 *   - every hook runs before the `try`, and building the tree happens inside
 *     it, so a failure renders a readable card instead of a white panel.
 *
 * Markers the page carries for machine inspection (`data-plugin`,
 * `data-renderer`, `data-render-state`) are joined in 1C by `data-phase`,
 * `data-frozen-state`, `data-section-name`, `data-error-code` and friends, so
 * `node --test` can assert the contract consumption without a browser.
 *
 * Revision 6 adds one more question the page can answer about *itself*: which
 * bytes of `client.js` is it running? The factory body sits between two marker
 * comments and digests its own source (`promptSettingFactory.toString()`),
 * while the host digests the file it publishes and returns it in the ping as
 * `clientBuild`. `data-build` / `data-build-server` / `data-build-match`
 * publish the comparison, whose third state —「未知」— is what an old host or a
 * failed ping yields, and which is deliberately never reported as「过期」.
 *
 * g-045 splits that bundle: this file is the **entry**, 「版本历史」 lives in
 * `client.history.js` beside it and arrives on demand (`require.async` behind
 * `React.lazy`), and the stamp covers the chunks too — `CHUNK_STAMPS` (inside
 * the region above) plus the host's `clientBuild.chunks` plus the digest each
 * loaded chunk reports of itself, published as `data-build-loaded`. A chunk the
 * page cannot fetch renders a readable card in that one tab instead of taking
 * the page down with it. CONTRACT.md §13.0 / §14.3–§14.5; NOTES.md §122.
 *
 * g-029 answers the other half of the same question — *which version* is this
 * tab talking to? — without adding a second source. The version rendered beside
 * the page title (as `v` + the version) and published as `data-plugin-version` is
 * the `version` field of that **same** ping, which the host fills from
 * `PLUGIN_VERSION`. A missing, non-string or empty answer is rendered as
 * 「版本未知」/`unknown`, so the page can never show a version no host claimed.
 *
 * Revision 17 keeps that single source and moves the version from the status
 * line to the page title, where it links to this package's repository: the URL
 * comes from the same ping (`repositoryUrl`, derived by the host from its own
 * `package.json`), and with no URL the node is plain, unclickable text. Neither
 * half of the plugin writes a repository URL down.
 *
 * g-030 adds the one thing the page says without being asked: a dismissible
 * 「有新版本」banner when — and only when — the host's update check confirmed a
 * newer release (`GET /prompt-setting/update-check`, CONTRACT.md §17). The check
 * is the host's request, never the page's, so the page cannot leak anything; the
 * 「高级」tab carries the switch that decides whether even the host asks
 * (`data-action="update-toggle"`), and a `localStorage` mirror of that switch is
 * what lets a page with it off issue no request at all, including on mount.
 * Every other outcome — up to date, no release yet, unparsable tag, a failure,
 * the switch off — renders nothing: this is a background question, and the only
 * two honest answers are silence and usefulness.
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-setting',
  // A *named function expression*, not the method shorthand, so the body can
  // refer to the function itself (`promptSettingFactory.toString()`) and
  // fingerprint the very bytes this tab is running — the only way an already
  // open tab can say which build it is (CONTRACT.md §14). The loader still
  // calls `descriptor.factory(require)`; nothing about that changes.
  factory: function promptSettingFactory(require) {
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

    // #region factory guard (g-013)
    // The loader calls `descriptor.factory(require)` while it boots the page: a
    // throw here reaches DSH's module loader, not a boundary this plugin can
    // apologize from. So the whole body is built behind one guard — the two
    // failure modes seen in the field are `require('react')` missing and the
    // self-fingerprint above (an engine that refuses `Function#toString`).
    // `buildPlugin` is hoisted, so the guard can call a body that is declared
    // below it.
    try {
      return buildPlugin(require);
    } catch (error) {
      return degradedPlugin(require, error);
    }
    // #endregion

    /**
     * The plugin body — everything this half does once it can be built.
     *
     * The body is deliberately **not** shifted one indent level deeper: it is
     * ~6k lines of hand-written code whose structure is asserted by
     * `test/build.test.mjs` (the fingerprint region covers exactly this text),
     * and a re-indent would be a 6k-line diff for zero behaviour change. The
     * declaration sits outside the build-stamp region's helpers only in
     * position, not in scope; the guard above is its only caller.
     * @param require - the loader's require.
     * @returns the plugin descriptor.
     */
    function buildPlugin(require) {
    const React = require('react');
    const h = React.createElement;


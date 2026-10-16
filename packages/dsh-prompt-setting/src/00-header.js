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

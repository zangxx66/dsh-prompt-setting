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
 *   3. **「历史与备份」** (`history`) — the history log, the version comparison
 *      and the export/import panel, loaded lazily with the tab;
 *   4. **「高级」** (`advanced`) — the read-only legacy override list, the two
 *      layer-wide buttons (`legacy=true` clears the frozen overrides and keeps
 *      「我的 Prompt」; `reset=true` clears the whole layer), each behind its own
 *      second confirmation, plus the full status block.
 *
 * Above the tabs there are exactly three things: the title, one line of
 * deciding facts (mounted / frozen three-state / build stamp / plugin version)
 * and the session selector every tab shares — sourced from the **props**
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
 * g-029 answers the other half of the same question — *which version* is this
 * tab talking to? — without adding a second source. The version rendered in the
 * status line (as `v` + the version) and published as `data-plugin-version` is the
 * `version` field of that **same** ping, which the host fills from
 * `PLUGIN_VERSION`. A missing, non-string or empty answer is rendered as
 * 「版本未知」/`unknown`, so the page can never show a version no host claimed.
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

    // #region primitives probe
    // Never let the probe throw past this factory: a failure here must degrade
    // to the hand-built renderer, not blank the settings panel.
    let primitivesModule = null;
    let primitivesFailure = '';
    try {
      primitivesModule = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      primitivesModule = null;
      primitivesFailure = error && error.message ? String(error.message) : String(error);
    }
    const primitives =
      primitivesModule !== null && typeof primitivesModule === 'object' ? primitivesModule : null;
    const primitivesUsable = primitives !== null && typeof primitives.Button === 'function';
    /** Which renderer this module instance actually uses: 'primitives' | 'fallback'. */
    const RENDERER = primitivesUsable ? 'primitives' : 'fallback';
    /**
     * Which folder/caret artwork the tree actually renders. The primitives
     * module is used when it really exposes the sidebar's icon components;
     * otherwise the identical inlined geometry is drawn (NOTES §54).
     */
    const ICON_SOURCE =
      primitivesUsable &&
      typeof primitives.IconFolderOpenRegular === 'function' &&
      typeof primitives.IconFolderCloseRegular === 'function' &&
      typeof primitives.IconTriangleRightFillRegular === 'function'
        ? 'primitives'
        : 'inline';
    // #endregion

    /** Locale namespace owned by this plugin (zh/en dictionaries are inlined). */
    const NS = 'settings.promptSetting';
    /** Stage 1A probe route; kept as a renderer-reporting side channel. */
    const PING_PATH = '/prompt-setting/ping';
    const SNAPSHOT_PATH = '/prompt-setting/snapshot';
    const OVERRIDES_PATH = '/prompt-setting/overrides';
    /** Stage 2 routes (CONTRACT.md Revision 4). */
    const HISTORY_PATH = '/prompt-setting/history';
    const DIFF_PATH = '/prompt-setting/diff';
    const EXPORT_PATH = '/prompt-setting/export';
    const IMPORT_PATH = '/prompt-setting/import';
    /**
     * Revision 9: the「我的 Prompt」variable-substitution switch. Its own route
     * because it is a config-level fact, not a property of one override.
     */
    const INTERPOLATE_PATH = '/prompt-setting/interpolate';
    /** Sentinel for "no session": never a legal `Agent.id`, so it cannot collide. */
    const GLOBAL_SESSION = '\u0000global';
    /**
     * The reserved section name — the *only* name any write route accepts
     * since Revision 7 (CONTRACT.md §15.1). It is the literal twin of
     * `CUSTOM_SECTION_NAME` in `core/custom.js`: a browser module cannot import
     * host code, so the two copies are kept in sync **by assertion** rather
     * than by construction — `test/client.test.mjs` imports the constant from
     * `core/custom.js` and compares it, character for character, with the name
     * this page puts into every save and delete it sends.
     */
    const RESERVED_SECTION_NAME = 'prompt-setting:custom-prompt';
    /** The one action the reserved name accepts (§4.1). */
    const RESERVED_SECTION_ACTION = 'replace';
    /**
     * The four first-level tabs, in the fixed order they are presented.
     * 「我的 Prompt」 is first and is the default: it is the only write surface
     * left, so it is where a user who opened this page for a reason lands.
     */
    const MAIN_TABS = ['mine', 'overview', 'history', 'advanced'];
    /**
     * The two *read-only* views inside 「提示词总览」. `sections` is the
     * assembled segment list; `full` is the assembled text. The Revision 6
     * `overrides` view is gone from this list: its read-only half moved to
     * 「高级」 and its history/transfer halves to 「历史与备份」.
     */
    const VIEWS = ['sections', 'full'];
    /** The layers 「我的 Prompt」 may write to, in presentation order. */
    const LAYERS = ['user', 'workspace'];
    /** CONTRACT.md §2.2 — the four `origin` values, in presentation order. */
    const ORIGINS = ['registered', 'appended', 'downstream-added', 'unmatched-override'];
    const LAYER_FILTERS = ['all', 'default', 'user', 'workspace'];
    const OVERRIDABLE_FILTERS = ['all', 'yes', 'no'];
    const ORIGIN_FILTERS = ['all', 'registered', 'appended', 'downstream-added', 'unmatched-override'];
    /** Upper bound on rendered lines put into the DOM (a long prompt is real). */
    const MAX_VIEW_LINES = 3000;
    /** History rows one page asks for (the panel keeps a page, not the file). */
    const HISTORY_PAGE = 20;
    /** Conflict strategies the import panel offers (CONTRACT §11.4). */
    const IMPORT_MODES = ['merge', 'replace'];
    /** Upper bound on the JSON preview the panel keeps in the DOM. */
    const MAX_EXPORT_PREVIEW = 20000;
    /** Upper bound on collapsed diff lines rendered by the fallback branch. */
    const MAX_DIFF_LINES_SHOWN = 400;
    /** Bound handed to the primitives `DiffBlock` (its own collapse default is smaller). */
    const DIFF_BLOCK_MAX_LINES = 200;
    /** The two ends of a comparison; `current` is the live layer, not a record. */
    const DIFF_CURRENT = 'current';
    /**
     * Upper bound on session rows rendered at once in the flat (degraded)
     * list. The session catalog grows with use (every session ever opened is a
     * row), so the picker may never render the whole list.
     */
    const SESSION_MATCH_LIMIT = 20;
    /**
     * Bounds of the workspace tree. The tree renders a *window* over the
     * catalog in every case: at most {@link SCOPE_GROUP_PAGE} session rows per
     * expanded workspace group, raised by {@link SCOPE_GROUP_STEP} per
     * 「显示更多」 click up to {@link SCOPE_GROUP_MAX}, and never more than
     * {@link SCOPE_TOTAL_MAX} session rows or {@link SCOPE_GROUP_LIMIT} group
     * headers overall (the group holding the current session may add exactly
     * one header when it falls outside that slice).
     */
    const SCOPE_GROUP_PAGE = 10;
    const SCOPE_GROUP_STEP = 10;
    const SCOPE_GROUP_MAX = 50;
    const SCOPE_TOTAL_MAX = 100;
    const SCOPE_GROUP_LIMIT = 40;

    // #region error-code dictionary (CONTRACT.md §4.4, every code gets copy)
    /**
     * `code` → `[zh, en]`. The table is the single source of both the
     * `error.CODE` dictionary entries and the lookup used when a request
     * fails, so a code can never be rendered as a bare identifier.
     */
    const ERROR_TEXT = {
      'invalid-json': ['请求体不是合法 JSON。', 'The request body is not valid JSON.'],
      'invalid-override': ['section 缺失或不是对象。', 'The "section" field is missing or not an object.'],
      'missing-name': ['缺少段名 name。', 'The section "name" is missing.'],
      'name-too-long': ['段名超过 200 个字符。', 'The section name exceeds 200 characters.'],
      'invalid-name': ['段名包含控制字符。', 'The section name contains control characters.'],
      'unknown-action': [
        'action 必须是 replace、hide 或 append。',
        'The action must be replace, hide, or append.',
      ],
      'missing-text': [
        'replace 或 append 必须提供字符串文本。',
        'replace and append require a text string.',
      ],
      'unexpected-text': ['hide 不能携带文本。', 'A hide override must not carry text.'],
      'invalid-order': [
        'order 必须是不小于 0 的整数（结果数组下标）。',
        'The order must be a non-negative integer (a target index).',
      ],
      'unexpected-order': [
        'replace 与 hide 不能携带 order。',
        'replace and hide must not carry an order.',
      ],
      'unknown-layer': ['layer 必须是 user 或 workspace。', 'The layer must be user or workspace.'],
      'workspace-unresolved': [
        '工作区层需要一个可解析的 session id。',
        'The workspace layer needs a resolvable session id.',
      ],
      'override-not-found': [
        '该层没有这条覆盖，无法撤销。',
        'That layer holds no such override to remove.',
      ],
      'layer-not-writable': [
        '目标配置文件不是合法配置，拒绝覆盖写入。',
        'The target config file is not a valid config; it is never overwritten.',
      ],
      'text-too-large': ['文本超过 200 KiB。', 'The text exceeds 200 KiB.'],
      'body-too-large': ['请求体超过 256 KiB。', 'The request body exceeds 256 KiB.'],
      'assemble-failed': [
        '宿主装配 system prompt 时抛错，快照不可用。',
        'The host assembly threw while building the snapshot.',
      ],
      'trust-fence-unavailable': [
        '连接服务不可用，请求被信任栅栏拒绝。',
        'The connection service is unavailable, so the trust fence refused the request.',
      ],
      'not-found': ['宿主没有这个路由。', 'The host has no such route.'],
      'duplicate-name': ['同一层出现重复段名。', 'The layer holds a duplicate section name.'],
      // Revision 7 write face (§15.5–§15.7): the three codes the narrowed route
      // answers with. Without copy the panel would render the raw enum as if it
      // were a sentence, which is exactly what the "no untranslated string"
      // rule forbids.
      'write-locked': [
        '该写入被拒绝：只有本插件自有的段 prompt-setting:custom-prompt 可以被写入或删除。',
        'This write was refused: only this plugin\u2019s own section, prompt-setting:custom-prompt, may be written or deleted.',
      ],
      'unsupported-action': [
        '该段只接受 action=replace。',
        'That section accepts only action=replace.',
      ],
      'conflicting-query': [
        'reset 与 legacy 不能同时使用：reset 清空整层，legacy 只清旧覆盖。',
        'reset and legacy cannot be combined: reset clears the whole layer, legacy clears only the legacy overrides.',
      ],
      // Stage 2 (CONTRACT.md Revision 4).
      'invalid-history-record': [
        '历史记录格式非法，该行已被跳过。',
        'That history line is malformed and was skipped.',
      ],
      'history-unusable': ['历史文件不可读写。', 'The history file cannot be read or written.'],
      'history-not-found': ['该层历史中没有这条记录。', 'That layer history holds no such record.'],
      'missing-diff-selector': [
        '需要 from 或 to（历史 id 或 current）。',
        'Supply ?from= and/or ?to= (a history id or "current").',
      ],
      'invalid-diff-selector': [
        'from/to 只能是 current 或历史记录 id。',
        'A diff selector must be "current" or a history record id.',
      ],
      'invalid-export': ['导入内容必须是 JSON 对象。', 'An export document must be a JSON object.'],
      'unknown-export-schema': [
        'schema 不是本插件的导出格式。',
        'The "schema" is not this plugin’s export format.',
      ],
      'missing-export-version': ['导入文件缺少 version。', 'The import document has no "version".'],
      'unsupported-export-version': [
        '导入文件版本不受支持。',
        'The import document version is not supported.',
      ],
      'missing-export-layers': ['导入文件缺少 layers。', 'The import document has no "layers".'],
      'missing-export-layer': ['导入文件不含所请求的层。', 'The import document carries no such layer.'],
      'invalid-export-layer': ['导入文件的层结构非法。', 'A layer in the import document is malformed.'],
      'unknown-import-mode': [
        'mode 只能是 merge 或 replace。',
        'The mode must be merge or replace.',
      ],
      'import-verify-failed': [
        '导入的临时文件校验失败，现有配置未改动。',
        'The staged import failed its own validation; nothing was changed.',
      ],
      'import-staging-failed': [
        '导入无法写入临时文件，现有配置未改动。',
        'The import could not be staged; nothing was changed.',
      ],
      'import-commit-failed': [
        '导入提交失败，可能有层已被替换。',
        'The import could not be committed; some layers may already be replaced.',
      ],
      // Revision 9 — the interpolation switch (§16).
      'invalid-interpolate-flag': [
        '配置里的 interpolateCustom 必须是布尔值；该层已被停用。',
        'The config\'s "interpolateCustom" must be a boolean; that layer was disabled.',
      ],
      'unresolvable-variable': [
        '这段文本里的 {{…}} 引用永远不会被替换成值（未注册、名字非法或写歪），因此保存被拒绝。请删掉该引用、改用已注册的变量，或先关闭变量替换。',
        'A {{…}} reference in this text could never be substituted (unregistered, illegal or malformed), so the save was refused. Delete the reference, use a registered variable, or turn variable substitution off first.',
      ],
      'invalid-enabled': [
        '开关请求缺少布尔值 enabled。',
        'The switch request needs a boolean "enabled".',
      ],
      'invalid-state': [
        '本层状态只能是 inherit、on 或 off 之一。',
        'A layer state must be one of inherit, on or off.',
      ],
      'variable-lookup-failed': [
        '无法取到当前的变量表，本次写入被拒绝（无法判断哪些变量会被展开）。',
        'The current variable table could not be obtained, so this write was refused: there is no way to tell which references would expand.',
      ],
    };
    // #endregion

    const zh = {
      nav: 'Prompt 管理',
      title: 'Prompt 管理',
      subtitle:
        '查看并覆盖每轮会话最终装配的 system prompt。写入作用于下一轮装配（next-turn）。',
      refresh: '刷新快照',
      loading: '加载中…',
      loadFailed: '快照加载失败',
      sessionHeading: '查看范围',
      sessionGlobal: '全局（不指定会话）',
      sessionManualPlaceholder: '粘贴 session id（Agent.id）',
      sessionApply: '应用',
      sessionLimit:
        '当前 profile 未提供 useSessions（会话服务不可用），已降级为手动输入 session id：无法列出会话下拉。',
      sessionEmpty: '会话列表为空，可手动输入 session id 或使用「全局」。',
      sessionGlobalNote: '未指定会话：快照描述全局装配，工作区层不参与。',
      sessionSearch: '搜索会话（标题 / 路径 / session id）',
      sessionCurrent: '当前',
      sessionCurrentLabel: '当前：{label}',
      sessionMatches: '显示 {shown} / {matched} 条匹配（共 {total} 个会话）',
      sessionUseInput: '按该 id 查看：{id}',
      sessionNoMatch: '没有匹配的会话，可直接按输入的 id 查看。',
      sessionKeyboardHint: '↑↓ 移动，Enter 选中，Esc 清空搜索',
      sessionSelectedNote: '已指定会话：快照在该会话自身作用域下探测。',
      // g-016: the collapsed「查看范围」summary row.
      scopeEdit: '更改',
      scopeCollapse: '收起',
      scopeSummaryManual: '会话服务不可用：手动输入 id',
      scopeSummaryFlat: '工作区服务不可用：平铺列表',
      stateHeading: '状态',
      stMounted: '覆盖引擎',
      stMountedOn: '已挂载',
      stMountedOff: '未挂载',
      stMountedUnknown: '未知',
      stGeneratedAt: '快照生成时间',
      stUserLayer: '用户级层',
      stWorkspaceLayer: '工作区级层',
      stEnabled: '已启用',
      stDisabled: '未启用',
      stPath: '路径',
      stNone: '（无）',
      stReason: '原因',
      stFrozenSession: '本会话已冻结',
      stUnfrozenSession: '本会话未冻结',
      stFrozenGlobal: '全局装配已冻结',
      stUnfrozenGlobal: '全局装配未冻结',
      stFrozenUnknown: '本会话冻结状态未知',
      stBuild: '构建戳',
      stBuildSame: '与宿主一致',
      stBuildStale: '页面版本已过期',
      stBuildUnknown: '构建戳未知',
      stBuildSelf: '本页',
      stBuildServer: '宿主',
      stBuildStaleHint:
        '本页运行的 client.js 与宿主正在发布的字节不同：这是旧标签页在跑旧 bundle。开一个新标签（或在新标签里重新打开设置）即可，改客户端不需要重启 dsh web。',
      stBuildUnknownHint:
        '宿主没有报告 client.js 指纹（宿主版本旧、文件不可读、或标记缺失/重复），因此无法判断本页是否过期；这里不会当作过期。',
      stBuildPingFailedHint: 'ping 请求失败，拿不到宿主指纹，因此无法判断本页是否过期。',
      // g-029: the version the host reported in the ping. The tag renders a real
      // answer as `v` + the version; this label and the one below are the only two
      // strings the missing case needs, and the version itself is never written
      // in this file.
      stPluginVersion: '插件版本',
      stPluginVersionUnknown: '版本未知',
      viewSections: '分段',
      viewFull: '全文',
      // g-015: the four first-level tabs, in their fixed presentation order.
      tabMine: '我的 Prompt',
      tabOverview: '提示词总览',
      tabHistory: '历史与备份',
      tabAdvanced: '高级',
      overviewReservedNote: '「我的 Prompt」那一段不在这里重复显示：它归「我的 Prompt」tab 所有，请到那里查看和编辑。',
      filterHeading: '筛选',
      filterLayer: '来源层',
      filterOverridable: '可覆盖',
      filterOrigin: '来源',
      fAll: '全部',
      fDefault: '默认',
      fUser: '用户级',
      fWorkspace: '工作区级',
      fYes: '可覆盖',
      fNo: '不可覆盖',
      // The editor's "label: value" row cannot echo its own label; these two
      // are the values of that row only, never of the sections-list Tag.
      originRegistered: '注册段',
      originAppended: '本插件 append',
      originDownstream: '其它插件加入',
      originUnmatched: '无匹配覆盖',
      originDownstreamHint: '该段由其它插件在后处理阶段加入，不是本插件的覆盖，也不是异常。',
      originUnmatchedHint: '该覆盖没有可作用的目标段。',
      colChars: '字符数 {n}',
      colReason: '原因',
      expand: '展开全文',
      collapse: '收起',
      emptyTitle: '当前装配没有任何段',
      emptyBody: '该作用域下 system prompt 装配为 0 段，这不是错误。',
      sectionsShown: '显示 {shown} / {total} 段',
      searchPlaceholder: '在最终文本中检索…',
      searchCount: '命中 {n} 处',
      searchNone: '无命中',
      copy: '复制全文',
      copied: '已复制',
      copyFail: '复制失败，请手动选择文本',
      fullHeading: '最终 rendered system prompt',
      fullFiltered: '已按来源筛选：此处为重组后的预览文本，不是服务端 rendered。',
      unresolvedTitle: '真实装配会失败',
      unresolvedBody: '会 throw 的引用：{list}',
      unresolvedNote:
        '这些引用所在的段参与变量替换，宿主每轮组装该会话的 prompt 时都会直接抛错——该会话的 prompt 组装不出来，因此这段文本不是真实 prompt。',
      unresolvedLiteralInline: '另有 {list} 位于不参与替换的段中：真实 prompt 里它们就是原样的字面量。',
      unresolvedLiteralTitle: '真实 prompt 就是这些字面量',
      unresolvedLiteralBody: '不参与替换的引用：{list}',
      unresolvedLiteralNote:
        '这些引用所在的段不由宿主插值（interpolate: false；「我的 Prompt」永远如此），无论本插件的变量替换是否开启、是否解析得出值，它们都会原样交给模型——预览里的字面量就是真实 prompt，预览即真相。',
      truncated: '文本过长，仅显示前 {n} 行。',
      diffHeading: 'base ↔ effective 对比',
      diffSame: '一致',
      diffChanged: '有差异',
      diffAdded: '仅 effective',
      diffRemoved: '仅 base',
      diffHint: '逐段比较：base 是注册原文，effective 是覆盖后的结果。',
      editLayer: '保存层',
      // ---- g-015: 「我的 Prompt」, the only write surface (the reserved section)
      mineHeading: '我的 Prompt',
      mineNote:
        '这里写下的内容会成为单独一段 Prompt，排在所有内置段之后，下一轮生效（next-turn）。该段永远不由 DSH 插值；开启「变量替换」后，由本插件在装配时展开 {{...}}——未注册、拼错或当前无值的引用原样保留，不会导致组装失败。',
      mineTextLabel: '内容',
      minePlaceholder: '在这里写下你的 Prompt…',
      mineSave: '保存',
      // g-027: not a confirmation-bearing action — it drops an unsaved draft.
      mineCancel: '取消',
      mineReset: '恢复默认',
      mineSaving: '保存中…',
      mineSaved: '已保存到{layer}，下一轮生效（next-turn）。',
      mineFailed: '保存失败',
      mineUnconfigured: '尚未配置：该层还没有「我的 Prompt」，文本为空。',
      mineDirty: '有未保存的修改。',
      mineLoaded: '已加载{layer}的「我的 Prompt」。',
      // ---- Revision 9: the variable-substitution switch
      mineInterpolateLabel: '变量替换',
      mineInterpolateOn: '已开启',
      mineInterpolateOff: '已关闭',
      mineInterpolateTurnOn: '开启变量替换',
      mineInterpolateTurnOff: '关闭变量替换',
      mineInterpolateNote:
        '开启后，这段文本里的 {{变量}} 由本插件在装配时展开：{{model}} → 当前模型名、{{cwd}} → 工作目录、{{provider}} → provider。未注册、拼错或当前无值的引用会原样保留（不会导致组装失败）。关闭时所有 {{...}} 都原样交给模型。',
      mineInterpolateWarn:
        '注意：DSH 没有转义机制。开启后你无法再在这里写字面量 {{...}}——未注册、拼错或写歪的引用永远拿不到值，所以保存时会被直接拒绝。它不会让会话装配失败，只会一直保持字面量。',
      mineInterpolateInherit: '该层未设置：跟随用户层。',
      mineInterpolateStated: '该层显式设置为{state}。',
      mineInterpolateSaving: '正在切换…',
      mineInterpolateSaved: '变量替换已{state}，下一轮生效（next-turn）。',
      mineInterpolateFailed: '切换变量替换失败',
      mineInterpolateWorkspaceNeedsSession: '工作区层需要先选择一个会话；未选择时无法在工作区层切换。',
      mineInterpolateLayerOnly: '开关按所选层保存；工作区层未设置时继承用户层。',
      // ---- Revision 12 (att-002): the three states, and the advisory the host
      // used to compute and drop.
      mineInterpolateStatesLabel: '本层状态',
      mineInterpolateSetInherit: '继承',
      mineInterpolateSetOn: '显式开',
      mineInterpolateSetOff: '显式关',
      mineInterpolateSetNote: '「继承」= 本层不声明（删掉该字段）；「显式关」= 写入 false，可覆盖上层的「开」。',
      mineInterpolateInheritedOn: '本层未设置，因此跟随上层的「开」。要覆盖它，请选「显式关」。',
      mineInterpolateStateSaved: '本层状态已设为「{state}」，下一轮生效（next-turn）。',
      mineWarningsHeading: '已保存，但有以下引用需要留意：',
      mineWarningUndefined:
        '这些变量在本次探测中没有值，保存已通过（值属于会话，不属于文本）；缺少该值的那一轮，这些引用会保留字面量、不做替换：{list}',
      mineWarningList: '引用 {name}',
      mineLayerDisabled: '本层已被停用，当前不参与任何装配。',
      mineLayerDisabledReason: '原因：{reason}',
      mineLayerDisabledFix:
        '修复路径：删掉该层配置里无法解析的 {{…}} 引用（或把变量替换关掉），然后重新打开本页；插件不会改写你的文件。',
      mineLayerDisabledFixGeneric:
        '修复路径：修正或删除该层的配置文件（JSON 非法、字段非法、文件被删都会落到这里），然后重新打开本页；插件不会改写你的文件。',
      // ---- g-021: a frozen scope is a blocking statement, not a footnote
      mineFrozenWarn: '该作用域已被冻结：你写下的 Prompt 不会生效',
      mineFrozenBody:
        '保存按钮仍然可用，文本会写入{layer}的配置；但这个作用域被 complete 段冻结，本次写入不会进入最终 Prompt，也不会在下一轮生效。',
      // The `frozenScope: "global"` + session case is *unknown*, not frozen
      // (CONTRACT.md §2.4/§7.2): the panel may warn, but it may not claim the
      // session is frozen. Two of its own keys keep that distinction separate.
      mineFrozenUnknownWarn: '冻结状态未知：本会话的装配无法确认',
      mineFrozenUnknownBody:
        '全局装配被 complete 段冻结，但选中的会话没有活动 agent，所以无法确认本会话是否同样冻结。文本仍会写入{layer}的配置；如果本会话确实被冻结，它就不会生效。',
      mineFrozenHowTo:
        '要让它生效：换用一个未声明 complete 的 agent preset（例如内置的默认 preset），或去掉当前 preset 里的 complete 声明，然后在本会话重新加载。',
      mineSavedFrozen: '已保存到{layer}，但本会话冻结中，不会生效。',
      mineSavedUnknown: '已保存到{layer}；本会话冻结状态未知，若已冻结则不会生效。',
      savedNoticeFrozen: '已保存到{layer}，但本会话冻结中，本轮不会生效。',
      savedNoticeUnknown: '已保存到{layer}；本会话冻结状态未知，若已冻结则本轮不会生效。',
      mineWorkspaceNeedsSession: '工作区层需要先选择一个会话；未选择时无法写入工作区层。',
      mineResetTitle: '恢复默认：删除{layer}的「我的 Prompt」',
      mineResetBody: '这会删除该层保存的文本、回到未配置状态。',
      // ---- stage 3: two entries, so an illegal (name, action) pair cannot exist
      blockAppendExisting:
        '该段名已在当前装配中：append 不会生效（两段不可同名，宿主会跳过并记为 name-already-present）。请改用「替换 replace」，或把段名改成一个尚未注册的新名。',
      blockNotPresent:
        '该段名当前不在装配中：replace / hide 会被跳过（宿主记为 section-not-present）。请改用一个已注册的段名，或改用「追加 append」新建段。',
      blockMissingName: '段名不能为空（宿主会返回 missing-name）。',
      editDisabledOverridable: '该段不可覆盖',
      editDisabledFrozen: '当前作用域已冻结，编辑不会生效',
      savedNotice: '已保存到{layer}，下一轮生效（next-turn）。',
      deletedNotice: '已撤销{layer}的覆盖，下一轮生效（next-turn）。',
      nextTurn: '下一轮生效',
      ovHeading: '已生效覆盖',
      ovEmpty: '当前作用域没有任何覆盖。',
      ovMergedNote: '合并顺序：工作区级覆盖同名用户级条目，并保留其位置。',
      ovUser: '用户级',
      ovWorkspace: '工作区级',
      ovWorkspaceDisabled: '工作区级（未启用）',
      ovEffective: '已生效',
      ovIneffective: '未生效',
      stHidden: '已隐藏',
      stAppended: '追加',
      ovUnknown: '效果未知',
      ovReason: '原因',
      ovFixHint: '修正：撤销本条覆盖后用 replace 重存，或改用未注册的新段名 append。',
      errTitle: '请求失败',
      errNetwork: '无法连接宿主（网络错误）',
      errHttp: '宿主返回 HTTP {status}',
      errUnknown: '未知错误码',
      errCode: '错误码',
      errDetail: '宿主消息',
      rendererLabel: '渲染分支',
      rendererPrimitives: 'primitives（官方基础件）',
      rendererFallback: 'fallback（自绘 + 主题变量）',
      primitivesFailure: 'primitives 不可用原因',
      renderErrorTitle: 'Prompt 管理：渲染失败',
      renderErrorLabel: '错误',
      scopeDefaultWorkspace: '默认工作区',
      scopeUntitledWorkspace: '（未命名工作区）',
      scopeUngrouped: '未分组',
      scopeRunning: '运行中',
      scopeSessions: '{n} 个会话',
      scopeMore: '显示更多（还有 {n} 条）',
      scopeCut: '还有 {n} 条已到渲染上限，请用搜索缩小范围。',
      scopeTruncated:
        '已达渲染上限（同一时刻最多渲染 {n} 条会话）：请用搜索缩小范围，或先收起其它工作区。',
      scopeGroupsTruncated: '工作区分组过多，仅显示部分分组：请用搜索缩小范围。',
      scopeDegraded:
        '当前 profile 未提供 useWorkspaces（工作区服务不可用），已降级为平铺会话列表：无法按工作区分组。',
      scopeArchivedHidden: '另有 {n} 个已归档会话未显示（与侧边栏默认一致），可用搜索或直接输入 id 查看。',
      scopeSearchHint:
        '按工作区分组，与左侧「工作区」一致；搜索会保留匹配项所属的工作区分组，匹配工作区名时其下会话一并显示。',
      scopeToggleAria: '工作区「{name}」：展开或收起',
      scopeToggleAria: '工作区「{name}」：展开或收起',
      scopeSelected: '当前选中',
      // ---- stage 2: history / diff / reset / transfer ----
      histHeading: '版本历史',
      histNote:
        '每次成功保存或撤销都会追加一条记录（最近 {limit} 条）。历史文件按行追加，不做整文件重写。',
      histLayerLabel: '历史层',
      histEmpty: '该层还没有历史记录。',
      histNoSession: '工作区层需要一个可解析的 session id 才能读取历史。',
      histTotal: '共 {n} 条',
      histCorrupt: '有 {n} 行历史记录无法解析，已跳过。',
      histUnreadable: '历史文件不可读：{reason}',
      histLastError: '最近一次历史写入失败：{reason}',
      histCurrent: '当前生效值',
      histWholeLayer: '（整层）',
      'histAction.replace': '替换 replace',
      'histAction.hide': '隐藏 hide',
      'histAction.append': '追加 append',
      'histAction.remove': '删除单条',
      'histAction.reset-layer': '整层重置',
      'histAction.legacy-clear': '清除旧覆盖 legacy-clear',
      diffBlockCopy: '复制',
      diffBlockCopied: '已复制',
      diffBlockCollapse: '收起',
      diffBlockExpand: '展开其余 {n} 行',
      diffBlockCollapseAria: '收起差异内容',
      diffBlockExpandAria: '展开差异内容（还有 {n} 行）',
      diffBlockCode: '文本差异',
      diffBlockWrap: '自动换行',
      diffBlockUnwrap: '不换行（横向滚动）',
      histPickFrom: '作为基准 from',
      histPickTo: '作为对比 to',
      histDiffHeading: '版本对比',
      histDiffHint: '选中任意两条历史记录（或历史 vs 当前生效值）后自动对比：先比段，再比行。',
      histDiffFrom: 'from',
      histDiffTo: 'to',
      histDiffSections: '段级：共 {total} 段（差异 {changed} / 仅新增 {added} / 仅旧版 {removed} / 一致 {same}）',
      histDiffLineStats: '行级：+{added} / -{removed}（{mode}）',
      histDiffModeLcs: '精确 LCS',
      histDiffModeBounded: '有界退化（前缀/后缀裁剪）',
      histDiffTruncated: '差异过长，仅渲染前 {n} 行。',
      histDiffCrlf: '两侧换行符不同（已按行归一化比较）。',
      histDiffNoLines: '未做行级比较：{reason}',
      histDiffBlock: '官方 DiffBlock 渲染',
      histDiffFallback: '自绘渲染（primitives 不可用）',
      histDiffUnavailable: '版本对比失败',
      resetLayersLabel: '整层重置',
      resetLayerUser: '重置用户级层',
      resetLayerWorkspace: '重置工作区级层',
      resetLegacyButton: '清除全部覆盖',
      resetLegacyTitle: '清除{layer}的全部旧覆盖',
      resetLegacyBody:
        '将删除{layer}的 {count} 条冻结覆盖（即「我的 Prompt」以外的全部旧覆盖），并保留「我的 Prompt」本身。',
      resetLegacyEmpty: '{layer}没有可清除的冻结覆盖；「我的 Prompt」会保留。',
      advReservedTag: '我的 Prompt',
      advReadOnlyNote: '本列表只读：唯一的写入口是「我的 Prompt」，层级清理请用下面两个按钮。',
      resetLayerTitle: '重置{layer}',
      resetLayerBody:
        '将清空{layer}的全部 {count} 条覆盖，下一轮装配生效；被删除的内容会记入历史。',
      resetLayerEmpty: '{layer}当前没有任何覆盖，无需重置。',
      resetIrreversible: '此操作不可撤销。',
      confirmTitle: '请确认',
      confirmYes: '确认执行',
      confirmNo: '取消',
      resetDoneNotice: '已恢复默认：删除 {count} 条覆盖，下一轮生效（next-turn）。',
      resetNoneNotice: '没有需要删除的覆盖。',
      transferHeading: '导出 / 导入',
      transferNote:
        '导出为带 schema 与版本号的 JSON；导入前先干跑预览变更，确认后才会写入（先写临时文件，校验通过再原子替换）。',
      exportButton: '导出 JSON',
      exportPreviewLabel: '导出内容（可复制）',
      exportPreviewCut: '预览仅显示前 {n} 个字符，下载内容为完整文件。',
      exportFailed: '导出失败：{reason}',
      downloadDone: '已下载 {name}',
      downloadFailed: '下载失败，请复制下方 JSON：{reason}',
      importHeading: '导入',
      importModeLabel: '冲突策略',
      importModeMerge: 'merge 覆盖同名 / 保留本地额外条目',
      importModeReplace: 'replace 以导入文件为准，删除本地额外条目',
      importTextLabel: '粘贴导出 JSON',
      importTextPlaceholder: '把导出的 JSON 粘贴到这里，或选择文件…',
      importFileLabel: '选择导出文件',
      importPreviewButton: '干跑预览变更',
      importPreviewing: '预览中…',
      importApplyButton: '确认导入',
      importApplying: '导入中…',
      importNeedText: '请先粘贴或选择导出 JSON。',
      importBadJson: '不是合法 JSON：{reason}',
      importPlanHeading: '变更预览（未写入）',
      importCounts: '新增 {added} / 覆盖 {replaced} / 无变化 {unchanged} / 删除 {removed} / 保留本地 {kept}',
      importChangeRow: '{name}：{status}',
      importNoChanges: '导入文件与当前配置一致，确认导入不会改动任何文件。',
      importSkipped: '已跳过的层：{list}',
      importAppliedNotice: '导入完成：写入 {written} 个层的配置文件，共 {count} 条变更，已记入历史（origin=import）。',
      importUnchangedNotice: '导入内容与现有配置一致，未写入任何文件。',
      importUnchangedWarning: '现有配置未被修改（逐字节不变）。',
      importStatusAdded: '新增',
      importStatusReplaced: '覆盖',
      importStatusUnchanged: '无变化',
      importStatusRemoved: '删除',
      importConfirmTitle: '确认导入',
      importConfirmBody: '将按 {mode} 策略写入以下变更，任何一步失败都不会改动现有配置。',
    };

    const en = {
      nav: 'Prompt settings',
      title: 'Prompt settings',
      subtitle:
        'Inspect and override the system prompt assembled into every session. A write applies to the next assembly (next-turn).',
      refresh: 'Refresh snapshot',
      loading: 'Loading…',
      loadFailed: 'Snapshot request failed',
      sessionHeading: 'Scope',
      sessionGlobal: 'Global (no session)',
      sessionManualPlaceholder: 'Paste a session id (Agent.id)',
      sessionApply: 'Apply',
      sessionLimit:
        'This profile provides no useSessions (session service unavailable); the picker degraded to a manual session id and cannot list sessions.',
      sessionEmpty: 'The session list is empty; enter a session id or use Global.',
      sessionGlobalNote: 'No session: the snapshot describes the global assembly and the workspace layer stays inactive.',
      sessionSearch: 'Search sessions (title, path, session id)',
      sessionCurrent: 'Current',
      sessionCurrentLabel: 'Current: {label}',
      sessionMatches: 'Showing {shown} / {matched} matches ({total} sessions)',
      sessionUseInput: 'View by this id: {id}',
      sessionNoMatch: 'No session matches; you can view the typed id directly.',
      sessionKeyboardHint: 'Up/Down to move, Enter to select, Esc to clear the search',
      sessionSelectedNote: 'Session selected: the snapshot probes that session’s own scope.',
      // g-016: the collapsed「查看范围」summary row.
      scopeEdit: 'Change',
      scopeCollapse: 'Collapse',
      scopeSummaryManual: 'Session service unavailable: type an id',
      scopeSummaryFlat: 'Workspace service unavailable: flat list',
      stateHeading: 'Status',
      stMounted: 'Override engine',
      stMountedOn: 'Mounted',
      stMountedOff: 'Not mounted',
      stMountedUnknown: 'Unknown',
      stGeneratedAt: 'Snapshot generated at',
      stUserLayer: 'User layer',
      stWorkspaceLayer: 'Workspace layer',
      stEnabled: 'Enabled',
      stDisabled: 'Disabled',
      stPath: 'Path',
      stNone: '(none)',
      stReason: 'Reason',
      stFrozenSession: 'This session is frozen',
      stUnfrozenSession: 'This session is not frozen',
      stFrozenGlobal: 'The global assembly is frozen',
      stUnfrozenGlobal: 'The global assembly is not frozen',
      stFrozenUnknown: 'This session’s frozen state is unknown',
      stBuild: 'Build',
      stBuildSame: 'Matches the host',
      stBuildStale: 'This tab is stale',
      stBuildUnknown: 'Build unknown',
      stBuildSelf: 'This tab',
      stBuildServer: 'Host',
      stBuildStaleHint:
        'The client.js this tab is running is not the build the host is serving byte for byte: an older tab kept an older bundle. Open a new tab (or reopen Settings in one); a client change needs no dsh web restart.',
      stBuildUnknownHint:
        'The host reported no client.js fingerprint (older host, unreadable file, or missing/duplicated markers), so this tab cannot be judged — it is not treated as stale.',
      stBuildPingFailedHint: 'The ping request failed, so there is no host fingerprint and this tab cannot be judged.',
      // g-029: the version the host reported in the ping, or「unknown」when the
      // same ping carried none. Never a version this bundle invented.
      stPluginVersion: 'Plugin version',
      stPluginVersionUnknown: 'Version unknown',
      viewSections: 'Sections',
      viewFull: 'Full text',
      tabMine: 'My Prompt',
      tabOverview: 'Prompt overview',
      tabHistory: 'History & backup',
      tabAdvanced: 'Advanced',
      overviewReservedNote: 'The My Prompt section is not repeated here: it belongs to the My Prompt tab, where it is read and written.',
      filterHeading: 'Filters',
      filterLayer: 'Layer',
      filterOverridable: 'Overridable',
      filterOrigin: 'Origin',
      fAll: 'All',
      fDefault: 'Default',
      fUser: 'User',
      fWorkspace: 'Workspace',
      fYes: 'Overridable',
      fNo: 'Not overridable',
      originRegistered: 'Registered',
      originAppended: 'Our append',
      originDownstream: 'Added by another plugin',
      originUnmatched: 'Unmatched override',
      originDownstreamHint:
        'Another plugin added this section after the waterfall. It is not our override and not an anomaly.',
      originUnmatchedHint: 'This override had no target section to act on.',
      colChars: 'Chars {n}',
      colReason: 'Reason',
      expand: 'Expand',
      collapse: 'Collapse',
      emptyTitle: 'The assembly has no sections',
      emptyBody: 'This scope assembled 0 sections. That is not an error.',
      sectionsShown: 'Showing {shown} / {total} sections',
      searchPlaceholder: 'Search the final text…',
      searchCount: '{n} matches',
      searchNone: 'No match',
      copy: 'Copy text',
      copied: 'Copied',
      copyFail: 'Copy failed; select the text manually',
      fullHeading: 'Final rendered system prompt',
      fullFiltered: 'Filtered by origin: this is a recomposed preview, not the server-side rendered text.',
      unresolvedTitle: 'The real assembly will fail',
      unresolvedBody: 'References that will throw: {list}',
      unresolvedNote:
        'These references sit in sections that DO interpolate, so the Host throws on every turn while assembling this session\'s prompt: the prompt cannot be built, and this text is not the real prompt.',
      unresolvedLiteralInline: 'Also {list}, in sections that are not interpolated: the real prompt carries them as literal braces.',
      unresolvedLiteralTitle: 'The real prompt is exactly these literal braces',
      unresolvedLiteralBody: 'References in non-interpolated sections: {list}',
      unresolvedLiteralNote:
        'These references sit in sections the Host never interpolates (interpolate: false; My Prompt always is one), so they reach the model exactly as written whether or not this plugin\'s own expansion resolved them — the braces in this preview are the real prompt.',
      truncated: 'Long text: showing the first {n} lines only.',
      diffHeading: 'base ↔ effective',
      diffSame: 'Same',
      diffChanged: 'Changed',
      diffAdded: 'effective only',
      diffRemoved: 'base only',
      diffHint: 'Compared per section: base is what was registered, effective is the result after overrides.',
      editLayer: 'Save to layer',
      mineHeading: 'My Prompt',
      mineNote:
        'What you write here becomes one extra prompt section, placed after every built-in section, effective from the next turn (next-turn). DSH never interpolates it; with variable substitution on, this plugin expands its {{...}} during assembly, and a reference that is unregistered, misspelled or currently valueless stays literal instead of failing the assembly.',
      mineTextLabel: 'Content',
      minePlaceholder: 'Write your prompt here…',
      mineSave: 'Save',
      // g-027: not a confirmation-bearing action — it drops an unsaved draft.
      mineCancel: 'Cancel',
      mineReset: 'Restore default',
      mineSaving: 'Saving…',
      mineSaved: 'Saved to {layer}; effective from the next turn (next-turn).',
      mineFailed: 'Saving failed',
      mineUnconfigured: 'Not configured yet: this layer has no My Prompt, so the text is empty.',
      mineDirty: 'You have unsaved changes.',
      mineLoaded: 'Loaded the {layer} My Prompt.',
      // ---- Revision 9: the variable-substitution switch
      mineInterpolateLabel: 'Variable substitution',
      mineInterpolateOn: 'ON',
      mineInterpolateOff: 'OFF',
      mineInterpolateTurnOn: 'Turn variable substitution on',
      mineInterpolateTurnOff: 'Turn variable substitution off',
      mineInterpolateNote:
        'When on, this plugin expands {{variables}} in this text during assembly: {{model}} \u2192 the current model, {{cwd}} \u2192 the working directory, {{provider}} \u2192 the provider. A reference that is unregistered, misspelled or currently valueless stays literal and never fails the assembly. When off, every {{...}} reaches the model exactly as written.',
      mineInterpolateWarn:
        'Note: DSH has no escape syntax. With this on you can no longer write a literal {{...}} here \u2014 an unregistered, misspelled or malformed reference can never resolve, so saving one is refused outright. It would not break the session; it would simply stay literal forever.',
      mineInterpolateInherit: 'This layer states nothing: it inherits the user layer.',
      mineInterpolateStated: 'This layer states {state} explicitly.',
      mineInterpolateSaving: 'Switching\u2026',
      mineInterpolateSaved: 'Variable substitution is now {state}; effective from the next turn (next-turn).',
      mineInterpolateFailed: 'Switching variable substitution failed',
      mineInterpolateWorkspaceNeedsSession: 'The workspace layer needs a selected session; without one the switch cannot be written there.',
      mineInterpolateLayerOnly: 'The switch is saved per selected layer; a workspace layer that states nothing inherits the user layer.',
      // ---- Revision 12 (att-002): the three states, and the advisory the host
      // used to compute and drop.
      mineInterpolateStatesLabel: 'This layer',
      mineInterpolateSetInherit: 'Inherit',
      mineInterpolateSetOn: 'On',
      mineInterpolateSetOff: 'Off',
      mineInterpolateSetNote: '"Inherit" states nothing (the field is removed); "Off" writes false, which is what lets a layer close over an inherited ON.',
      mineInterpolateInheritedOn: 'This layer states nothing, so it inherits ON. Choose "Off" to override that.',
      mineInterpolateStateSaved: 'This layer now states {state}; effective from the next turn (next-turn).',
      mineWarningsHeading: 'Saved, with references to note:',
      mineWarningUndefined:
        'These variables had no value in the probe that was run, so the save was accepted (a value belongs to the session, not to the text); in a turn that has no value for them, they stay literal instead of being substituted: {list}',
      mineWarningList: 'reference {name}',
      mineLayerDisabled: 'This layer is disabled and contributes nothing to any assembly right now.',
      mineLayerDisabledReason: 'Reason: {reason}',
      mineLayerDisabledFix:
        'Fix: delete the unresolvable {{...}} reference in that layer\'s config (or turn variable substitution off), then reopen this page. The plugin never rewrites your file.',
      mineLayerDisabledFixGeneric:
        'Fix: repair or remove that layer\'s config file (invalid JSON, an invalid field and a deleted file all land here), then reopen this page. The plugin never rewrites your file.',
      // ---- g-021: a frozen scope is a blocking statement, not a footnote
      mineFrozenWarn: 'This scope is frozen: the prompt you write will not take effect',
      mineFrozenBody:
        'Saving still works and the text is stored in the {layer} config, but this scope is frozen by a complete section: this write never reaches the final prompt, and it does not take effect from the next turn either.',
      // The `frozenScope: "global"` + session case is *unknown*, not frozen
      // (CONTRACT.md §2.4/§7.2): the panel may warn, but it may not claim the
      // session is frozen. Two of its own keys keep that distinction separate.
      mineFrozenUnknownWarn: 'Frozen state unknown: the assembly for this session cannot be confirmed',
      mineFrozenUnknownBody:
        'The unscoped assembly is frozen by a complete section, but the selected session has no active agent, so whether this session is frozen cannot be confirmed. The text is still written to the {layer} config; if this session is frozen too, it will not take effect.',
      mineFrozenHowTo:
        'To make it take effect: switch to an agent preset that does not declare complete (the built-in default preset, for example), or drop the complete declaration from the current preset, and then reload this session.',
      mineSavedFrozen: 'Saved to {layer}, but this session is frozen, so it will not take effect.',
      mineSavedUnknown: 'Saved to {layer}; this session may be frozen, in which case it will not take effect.',
      savedNoticeFrozen: 'Saved to {layer}, but this session is frozen; it will not take effect here.',
      savedNoticeUnknown: 'Saved to {layer}; this session may be frozen, in which case it will not take effect here.',
      mineWorkspaceNeedsSession: 'The workspace layer needs a session; without one it cannot be written.',
      mineResetTitle: 'Restore default: delete the {layer} My Prompt',
      mineResetBody: 'This deletes the text stored in that layer and returns it to unconfigured.',
      // ---- stage 3: two entries, so an illegal (name, action) pair cannot exist
      blockAppendExisting:
        'That name is already in the current assembly, so append would not take effect (two sections may not share a name; the Host skips it as name-already-present). Use Replace instead, or change the name to a new, unregistered one.',
      blockNotPresent:
        'That name is not in the current assembly, so replace / hide would be skipped (the Host records section-not-present). Pick a registered name, or use Append to create a new section.',
      blockMissingName: 'The section name cannot be empty (the Host answers missing-name).',
      editDisabledOverridable: 'This section is not overridable',
      editDisabledFrozen: 'The current scope is frozen; an edit would not take effect',
      savedNotice: 'Saved to {layer}; effective from the next turn (next-turn).',
      deletedNotice: 'Removed the {layer} override; effective from the next turn (next-turn).',
      nextTurn: 'next-turn',
      ovHeading: 'Active overrides',
      ovEmpty: 'This scope has no overrides.',
      ovMergedNote: 'Merge order: a workspace override wins over the same-name user entry and keeps its position.',
      ovUser: 'user layer',
      ovWorkspace: 'workspace layer',
      ovWorkspaceDisabled: 'workspace layer (disabled)',
      ovEffective: 'Applied',
      ovIneffective: 'Not applied',
      stHidden: 'hidden',
      stAppended: 'appended',
      ovUnknown: 'Effect unknown',
      ovReason: 'Reason',
      ovFixHint: 'Fix: undo this override and save it again as replace, or use append with a new, unregistered name.',
      errTitle: 'Request failed',
      errNetwork: 'Cannot reach the Host (network error)',
      errHttp: 'The Host answered HTTP {status}',
      errUnknown: 'Unknown error code',
      errCode: 'Error code',
      errDetail: 'Host message',
      rendererLabel: 'Renderer',
      rendererPrimitives: 'primitives (official atoms)',
      rendererFallback: 'fallback (hand-built + theme tokens)',
      primitivesFailure: 'Why primitives is unavailable',
      renderErrorTitle: 'Prompt settings — render failure',
      renderErrorLabel: 'Error',
      scopeDefaultWorkspace: 'Default workspace',
      scopeUntitledWorkspace: '(untitled workspace)',
      scopeUngrouped: 'Ungrouped',
      scopeRunning: 'Running',
      scopeSessions: '{n} sessions',
      scopeMore: 'Show more ({n} remaining)',
      scopeCut: '{n} more rows exceed the render cap; narrow the range with search.',
      scopeTruncated:
        'Render cap reached (at most {n} session rows at a time): narrow the range with search, or fold other workspaces first.',
      scopeGroupsTruncated: 'Too many workspace groups; only part of them is shown: narrow the range with search.',
      scopeDegraded:
        'This profile provides no useWorkspaces (workspace service unavailable); the picker degraded to a flat session list and cannot group by workspace.',
      scopeArchivedHidden:
        '{n} archived sessions are hidden (matching the sidebar default); use search, or type an id to view one.',
      scopeSearchHint:
        'Grouped by workspace, exactly like the left sidebar; a search keeps the owning workspace group of every match, and a workspace-name match keeps all of its sessions.',
      scopeToggleAria: 'Workspace "{name}": expand or collapse',
      scopeToggleAria: 'Workspace "{name}": expand or collapse',
      scopeSelected: 'Currently selected',
      // ---- stage 2: history / diff / reset / transfer ----
      histHeading: 'Version history',
      histNote:
        'Every successful save or removal appends one record (the newest {limit} are kept). The history file is appended line by line, never rewritten for a single read.',
      histLayerLabel: 'History layer',
      histEmpty: 'This layer has no history yet.',
      histNoSession: 'The workspace layer needs a resolvable session id to read its history.',
      histTotal: '{n} records',
      histCorrupt: '{n} history lines could not be parsed and were skipped.',
      histUnreadable: 'The history file is unreadable: {reason}',
      histLastError: 'The last history write failed: {reason}',
      histCurrent: 'Current value',
      histWholeLayer: '(whole layer)',
      'histAction.replace': 'replace',
      'histAction.hide': 'hide',
      'histAction.append': 'append',
      'histAction.remove': 'remove one',
      'histAction.reset-layer': 'reset the layer',
      'histAction.legacy-clear': 'clear legacy overrides',
      diffBlockCopy: 'Copy',
      diffBlockCopied: 'Copied',
      diffBlockCollapse: 'Collapse',
      diffBlockExpand: 'Show the other {n} lines',
      diffBlockCollapseAria: 'Collapse the diff',
      diffBlockExpandAria: 'Expand the diff ({n} more lines)',
      diffBlockCode: 'Text diff',
      diffBlockWrap: 'Wrap lines',
      diffBlockUnwrap: 'Keep columns (scroll sideways)',
      histPickFrom: 'Use as the from side',
      histPickTo: 'Use as the to side',
      histDiffHeading: 'Version comparison',
      histDiffHint: 'Pick any two history records (or a record against the current value); the comparison runs automatically, by section first and then by line.',
      histDiffFrom: 'from',
      histDiffTo: 'to',
      histDiffSections: 'Sections: {total} total ({changed} changed / {added} added / {removed} removed / {same} identical)',
      histDiffLineStats: 'Lines: +{added} / -{removed} ({mode})',
      histDiffModeLcs: 'exact LCS',
      histDiffModeBounded: 'bounded fallback (prefix/suffix trim)',
      histDiffTruncated: 'The difference is long; only the first {n} lines are rendered.',
      histDiffCrlf: 'The two sides use different line endings (compared line by line).',
      histDiffNoLines: 'No line comparison: {reason}',
      histDiffBlock: 'rendered by the official DiffBlock',
      histDiffFallback: 'hand-built rendering (primitives unavailable)',
      histDiffUnavailable: 'The version comparison failed',
      resetLayersLabel: 'Reset a whole layer',
      resetLayerUser: 'Reset the user layer',
      resetLayerWorkspace: 'Reset the workspace layer',
      resetLegacyButton: 'Clear all overrides',
      resetLegacyTitle: 'Clear every legacy override of the {layer}',
      resetLegacyBody:
        'This deletes the {count} frozen override(s) of the {layer} (everything except My Prompt) and keeps My Prompt itself.',
      resetLegacyEmpty: 'The {layer} has no frozen overrides to clear; My Prompt is kept.',
      advReservedTag: 'My Prompt',
      advReadOnlyNote: 'This list is read-only: My Prompt is the only write surface, and the two buttons below clear a whole layer.',
      resetLayerTitle: 'Reset the {layer}',
      resetLayerBody:
        'This clears all {count} overrides of the {layer}, effective from the next assembly; the removed content goes to history.',
      resetLayerEmpty: 'The {layer} holds no override, so there is nothing to reset.',
      resetIrreversible: 'This cannot be undone.',
      confirmTitle: 'Please confirm',
      confirmYes: 'Confirm',
      confirmNo: 'Cancel',
      resetDoneNotice: 'Restored the default: {count} override(s) removed, effective next turn (next-turn).',
      resetNoneNotice: 'There was nothing to remove.',
      transferHeading: 'Export / import',
      transferNote:
        'Export produces JSON carrying a schema and a version; an import is previewed with a dry run first, and only a confirmed import writes — staged to a temp file, validated, then renamed atomically.',
      exportButton: 'Export JSON',
      exportPreviewLabel: 'Exported content (copyable)',
      exportPreviewCut: 'The preview shows the first {n} characters; the download is the complete file.',
      exportFailed: 'Export failed: {reason}',
      downloadDone: 'Downloaded {name}',
      downloadFailed: 'The download failed; copy the JSON below: {reason}',
      importHeading: 'Import',
      importModeLabel: 'Conflict strategy',
      importModeMerge: 'merge: imported wins on a clash, local extras kept',
      importModeReplace: 'replace: the document is authoritative, local extras removed',
      importTextLabel: 'Paste the exported JSON',
      importTextPlaceholder: 'Paste the exported JSON here, or choose a file…',
      importFileLabel: 'Choose an export file',
      importPreviewButton: 'Dry-run the import',
      importPreviewing: 'Previewing…',
      importApplyButton: 'Apply the import',
      importApplying: 'Importing…',
      importNeedText: 'Paste or choose an export document first.',
      importBadJson: 'Not valid JSON: {reason}',
      importPlanHeading: 'Preview of the change (nothing written yet)',
      importCounts: 'added {added} / replaced {replaced} / unchanged {unchanged} / removed {removed} / local kept {kept}',
      importChangeRow: '{name}: {status}',
      importNoChanges: 'The document matches the current configuration, so a confirmed import changes no file.',
      importSkipped: 'Skipped layers: {list}',
      importAppliedNotice: 'Import complete: {written} layer file(s) written, {count} change(s), all recorded in history (origin=import).',
      importUnchangedNotice: 'The document matches the existing configuration; no file was written.',
      importUnchangedWarning: 'The existing configuration was not modified (byte-identical).',
      importStatusAdded: 'added',
      importStatusReplaced: 'replaced',
      importStatusUnchanged: 'unchanged',
      importStatusRemoved: 'removed',
      importConfirmTitle: 'Confirm the import',
      importConfirmBody: 'The changes below will be written with the {mode} strategy; a failure at any step leaves the existing configuration untouched.',
    };

    // One loop keeps zh/en key sets identical by construction, including every
    // `error.CODE` entry.
    for (const [code, pair] of Object.entries(ERROR_TEXT)) {
      zh[`error.${code}`] = pair[0];
      en[`error.${code}`] = pair[1];
    }

    /**
     * Last-resort translator, replaced by the bound `t` in `apply`. Only used
     * if the framework hands the component no `t` seat.
     * @param key - dictionary key.
     * @returns the key itself.
     */
    let fallbackT = (key) => key;

    /** Theme tokens only: the page must read correctly in light and dark. */
    const token = {
      labelPrimary: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      labelTertiary: 'var(--dsw-alias-label-tertiary)',
      borderL1: 'var(--dsw-alias-border-l1, var(--dsw-alias-border-l2))',
      borderL2: 'var(--dsw-alias-border-l2)',
      stateError: 'var(--dsw-alias-state-error-primary)',
      stateWarn: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-error-primary))',
      stateSuccess: 'var(--dsw-alias-state-success-primary)',
      /** Same token the sidebar tints the active workspace folder with. */
      stateBusiness: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary))',
      surface: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1, transparent))',
      surfaceStroke: 'var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2, transparent))',
      buttonFill: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, transparent))',
      buttonLabel: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      markFill: 'var(--dsw-alias-state-warning-fill, rgba(255, 200, 0, 0.35))',
      diffAddFill: 'var(--dsw-alias-state-success-fill, rgba(0, 200, 100, 0.16))',
      diffDelFill: 'var(--dsw-alias-state-error-fill, rgba(220, 60, 60, 0.16))',
      /** The sidebar's own row-hover fill (`Rows.module.css` uses this token). */
      hoverFill: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))',
      /**
       * The shell-wide focus ring: every product surface draws
       * `outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,
       * var(--dsw-alias-state-business-primary))` with `outline-offset: -2px`
       * (e.g. `dsh-client-ui-sidebar/lib/client.js`), so the page reuses it
       * instead of inventing a ring.
       */
      focusRing: 'var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    };

    /**
     * Folder and caret geometry copied **verbatim** from
     * `@deepseek-ai/dsh-client-ui-primitives` (0.1.7-rc.2):
     * `lib/index.js` `IconFolderOpenArtwork` (fill-only, three paths),
     * `FolderCloseArtwork` (stroke, two paths) and
     * `IconTriangleRightFillArtwork` (the sidebar's collapsed caret).
     *
     * The primitives branch renders those very components; the fallback
     * branch has no module to require, so it re-draws the identical
     * geometry with `React.createElement('svg', …)` — same artwork, no
     * new dependency, and the sidebar's workspace affordance stays
     * recognisable in both branches (NOTES §54).
     */
    const FOLDER_OPEN_PATHS = [
      { d: 'M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z', fill: 'currentColor', opacity: '0.16' },
      { d: 'M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z', fill: 'currentColor' },
      { d: 'M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z', fill: 'currentColor' },
    ];
    /** Closed-folder artwork: strokes, so the weight stays 1px like the sidebar. */
    const FOLDER_CLOSE_PATHS = [
      'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z',
      'M3.63501 7.66614H12.3647',
    ];
    /** Right-pointing caret; rotated 90° in place when the group is open. */
    const CARET_PATH = 'M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z';


    // #region fallback atoms (pure React.createElement + theme tokens)
    /**
     * Hand-built button. Extra props (including `data-*` markers) pass through
     * so the machine-readable attributes survive on the real DOM node.
     * @param props - `variant`, `disabled`, `onClick`, `data-*`, `style`.
     * @returns the button element.
     */
    function FxButton(props) {
      const primary = props.variant === 'primary';
      const disabled = props.disabled === true;
      const rest = { ...props };
      delete rest.variant;
      delete rest.children;
      delete rest.style;
      return h(
        'button',
        {
          ...rest,
          type: 'button',
          disabled,
          style: {
            font: 'inherit',
            fontSize: 13,
            lineHeight: '20px',
            padding: '6px 14px',
            borderRadius: 8,
            cursor: disabled ? 'default' : 'pointer',
            color: primary ? token.buttonLabel : token.labelPrimary,
            background: primary ? token.buttonFill : 'transparent',
            border: primary ? '1px solid transparent' : `1px solid ${token.borderL2}`,
            opacity: disabled ? 0.5 : 1,
            ...(props.style || {}),
          },
        },
        props.children,
      );
    }

    /**
     * Hand-built text input (single line).
     * @param props - native input props plus `data-*`.
     * @returns the input element.
     */
    function FxInput(props) {
      const rest = { ...props };
      delete rest.style;
      return h('input', {
        ...rest,
        type: props.type || 'text',
        style: {
          font: 'inherit',
          fontSize: 13,
          lineHeight: '20px',
          width: '100%',
          boxSizing: 'border-box',
          padding: '6px 10px',
          borderRadius: 8,
          color: token.labelPrimary,
          background: 'transparent',
          border: `1px solid ${token.borderL2}`,
          ...(props.style || {}),
        },
      });
    }

    /**
     * Hand-built multi-line editor (no primitive exists for a textarea).
     * @param props - `value`, `onChange`, `rows`, plus `data-*`.
     * @returns the textarea element.
     */
    function FxTextarea(props) {
      const rest = { ...props };
      delete rest.style;
      return h('textarea', {
        ...rest,
        rows: props.rows || 10,
        style: {
          font: `${13}px/20px ${token.mono}`,
          width: '100%',
          boxSizing: 'border-box',
          padding: '8px 10px',
          borderRadius: 8,
          resize: 'vertical',
          color: token.labelPrimary,
          background: 'transparent',
          border: `1px solid ${token.borderL2}`,
          ...(props.style || {}),
        },
      });
    }

    /**
     * Hand-built tag.
     * @param props - `tone` plus children.
     * @returns the tag element.
     */
    function FxTag(props) {
      const tone = props.tone === undefined ? 'outline' : props.tone;
      const color =
        tone === 'success'
          ? token.stateSuccess
          : tone === 'danger'
            ? token.stateError
            : tone === 'warning'
              ? token.stateWarn
              : token.labelTertiary;
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            fontSize: 12,
            lineHeight: '18px',
            padding: '1px 8px',
            borderRadius: 999,
            border: `1px solid ${token.borderL2}`,
            color,
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      );
    }
    // #endregion

    /**
     * Resolve the atoms once: `RENDERER` is fixed for this module instance, so
     * re-deciding per render would only remount children needlessly.
     */
    const UI =
      RENDERER === 'primitives'
        ? {
            Button: (props) =>
              h(
                primitives.Button,
                {
                  ...props,
                  variant: props.variant === 'primary' ? 'primary' : 'outline',
                  size: 'sm',
                  disabled: props.disabled,
                },
                props.children,
              ),
            Input: (props) =>
              typeof primitives.Input === 'function' ? h(primitives.Input, props) : h(FxInput, props),
            Textarea: FxTextarea,
            Tag: (props) =>
              typeof primitives.Tag === 'function'
                ? h(primitives.Tag, { tone: props.tone }, props.children)
                : h(FxTag, props),
          }
        : {
            Button: FxButton,
            Input: FxInput,
            Textarea: FxTextarea,
            Tag: FxTag,
          };

    /**
     * Render a segmented control.
     *
     * Deliberately *not* a component: it is called during tree building so the
     * fallback branch emits real host button nodes (role="tab") carrying the
     * `data-tab-*` markers the tests assert on. The primitives branch uses the
     * official `SegmentedTabs` (same `items`/`value`/`onChange` shape).
     * @param items - `{value, label, id, panelId}` entries, non-empty.
     * @param value - the selected value.
     * @param onChange - selection callback.
     * @param label - accessible name for the tab list.
     * @param group - marker key identifying which filter group this is.
     * @returns the tab list element.
     */
    function tabs(items, value, onChange, label, group) {
      if (RENDERER === 'primitives' && typeof primitives.SegmentedTabs === 'function') {
        // The official control owns its own DOM, so it cannot be asked to carry
        // our markers. `display: contents` keeps this wrapper invisible to
        // layout while giving a probe the *same* `data-tab-group` it reads in
        // the fallback branch — the marker is a fact about every branch, not
        // about the one that happens to be taken.
        return h(
          'div',
          { 'data-tab-group': group, style: { display: 'contents' } },
          h(primitives.SegmentedTabs, { items, value, onChange, label }),
        );
      }
      return h(
        'div',
        {
          role: 'tablist',
          'aria-label': label,
          'data-tab-group': group,
          style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
        },
        items.map((item) =>
          h(
            'button',
            {
              key: item.value,
              type: 'button',
              role: 'tab',
              'aria-selected': item.value === value,
              tabIndex: item.value === value ? 0 : -1,
              'data-tab-key': group,
              'data-tab-value': item.value,
              onClick: () => onChange(item.value),
              style: {
                font: 'inherit',
                fontSize: 12,
                lineHeight: '18px',
                padding: '3px 10px',
                borderRadius: 999,
                cursor: 'pointer',
                color: item.value === value ? token.buttonLabel : token.labelSecondary,
                background: item.value === value ? token.buttonFill : 'transparent',
                border: `1px solid ${item.value === value ? 'transparent' : token.borderL2}`,
              },
            },
            item.label,
          ),
        ),
      );
    }

    /** Subscribe stub used only when the framework hands no locale seat. */
    const noopSubscribe = () => () => {};
    /** Snapshot stub used only when the framework hands no locale seat. */
    const zeroRevision = () => 0;

    /**
     * Translate without ever throwing. Used only by the render-failure card,
     * where `t` itself may be the thing that broke.
     * @param t - candidate translator.
     * @param key - dictionary key.
     * @param literal - text used when the translator is absent or breaks.
     * @returns the localized text, or the literal.
     */
    function safeT(t, key, literal) {
      try {
        const value = t(key);
        return typeof value === 'string' && value.length > 0 ? value : literal;
      } catch {
        return literal;
      }
    }

    // #region pure helpers

    /**
     * Interpolate `{name}` placeholders in already-localized copy.
     * @param text - the localized template.
     * @param params - placeholder values.
     * @returns the filled string.
     */
    function fmt(text, params) {
      return String(text).replace(/\{(\w+)\}/g, (match, key) =>
        params[key] === undefined || params[key] === null ? match : String(params[key]),
      );
    }

    /**
     * Separators for the compact session encoding. Control characters are not
     * typeable, and the decoding is positional, so a title can never forge a
     * field boundary (the display fields are flattened first).
     */
    const SESSION_ROW_SEP = '\u001e';
    const SESSION_FIELD_SEP = '\u001f';
    /** Record separator for the multi-section workspace payload. */
    const SCOPE_RECORD_SEP = '\u001c';
    /** List separator inside one workspace payload field (`sessionIds`). */
    const SCOPE_ID_SEP = '\u001d';

    /** Every separator, for the fast "does this field need flattening" test. */
    const SESSION_SEPARATOR_PATTERN = /[\u001c\u001d\u001e\u001f]/;

    /**
     * Flatten one display field so it cannot contain an encoding separator. The
     * common path is a single regex test: a title with no control character (the
     * normal case) is returned untouched, no allocation.
     */
    function flattenSessionField(value) {
      const text = typeof value === 'string' ? value : '';
      if (!SESSION_SEPARATOR_PATTERN.test(text)) return text;
      return text.replace(/[\u001c\u001d\u001e\u001f]/g, ' ');
    }

    /**
     * The single selector handed to the props `useSessions` root hook.
     *
     * `ctx.sessions.search` is deliberately NOT used: it searches the Host's
     * *message-content* index (`ISessions.search(query, signal)` → bounded
     * `SessionSearchResultItem[]`), not session metadata; it matches message
     * text rather than title/path/id, and reaching it would need a `sessions`
     * service injection plus an async round trip per keystroke. The `list`
     * snapshot is documented as "the metadata authority", so the picker filters
     * it locally and bounds what it renders.
     *
     * The selector returns a *string* (the hook's equality check sees a stable
     * value; compact fields rather than JSON keep it ~2× smaller at the 5000-row
     * extreme), and it never throws on a not-yet-ready snapshot.
     * @param state - `SessionListState` (or anything shaped like it).
     * @returns the encoded string.
     */
    function sessionsProbeSelector(state) {
      const ids = state && Array.isArray(state.ids) ? state.ids : [];
      const byId = state && state.byId && typeof state.byId === 'object' ? state.byId : {};
      let current = '';
      for (const id of ids) {
        const row = byId[id];
        // Product usage (dsh-client-ui-layout): the session the main view retains.
        if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) {
          current = id;
          break;
        }
      }
      const records = ids.map((id) => {
        const row = byId[id] || {};
        return [
          String(id),
          flattenSessionField(row.displayTitle || row.title),
          flattenSessionField(row.title),
          flattenSessionField(row.cwd),
          row.running === true ? '1' : '0',
          // The three fields the workspace tree orders and filters by, copied
          // from the sidebar's own projection (`deriveGroups`): recency order
          // needs `updatedAt`, blank rows are the provisional New Session, and
          // subagent-origin sessions are never listed.
          Number.isFinite(row.updatedAt) ? String(row.updatedAt) : '',
          row.blank === true ? '1' : '0',
          typeof row.origin === 'string' ? flattenSessionField(row.origin) : '',
        ].join(SESSION_FIELD_SEP);
      });
      return [current, ...records].join(SESSION_ROW_SEP);
    }

    /**
     * One-entry decode cache. The props hook re-runs our selector on every
     * render, so the payload string is rebuilt often; caching the decode (and
     * the lowercased search text inside it) is what keeps a keystroke cheap in a
     * large catalog. Keyed by the exact payload, so a changed catalog misses.
     */
    let sessionDecodeKey = null;
    let sessionDecodeValue = { currentId: '', rows: [] };

    /**
     * Decode {@link sessionsProbeSelector}'s output.
     *
     * Each row also carries a pre-lowercased `haystack` covering id, display
     * title, title and cwd, so matching one query is one `indexOf` per row
     * instead of four `toLowerCase` allocations.
     *
     * A payload with no row separator is treated as unconformant and yields an
     * empty catalog rather than a fabricated session id.
     * @param encoded - the selector value.
     * @returns `{currentId, rows: [{id, displayTitle, title, cwd, running, haystack}]}`.
     */
    function decodeSessions(encoded) {
      if (typeof encoded !== 'string' || encoded.length === 0) return { currentId: '', rows: [] };
      if (encoded === sessionDecodeKey) return sessionDecodeValue;
      const parts = encoded.split(SESSION_ROW_SEP);
      if (parts.length < 2) return { currentId: '', rows: [] };
      const rows = parts
        .slice(1)
        .map((record) => {
          const fields = record.split(SESSION_FIELD_SEP);
          const updatedAt = Number(fields[5]);
          const row = {
            id: fields[0] || '',
            displayTitle: fields[1] || '',
            title: fields[2] || '',
            cwd: fields[3] || '',
            running: fields[4] === '1',
            updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
            blank: fields[6] === '1',
            origin: fields[7] || '',
          };
          row.haystack = [row.id, row.displayTitle, row.title, row.cwd].join(' ').toLowerCase();
          return row;
        })
        .filter((row) => row.id.length > 0);
      sessionDecodeKey = encoded;
      sessionDecodeValue = { currentId: parts[0] || '', rows };
      return sessionDecodeValue;
    }

    /**
     * Case-insensitive substring match across every field a user may search by.
     * @param row - a decoded session row.
     * @param needle - the already-trimmed, already-lowercased query.
     * @returns whether the row matches.
     */
    function sessionMatchesQuery(row, needle) {
      if (needle.length === 0) return true;
      const haystack =
        typeof row.haystack === 'string'
          ? row.haystack
          : [row.id, row.displayTitle, row.title, row.cwd].join(' ').toLowerCase();
      return haystack.indexOf(needle) >= 0;
    }

    /**
     * Filter the session rows for the picker. Order is the service's (Host list
     * order); nothing is sorted here.
     * @param rows - the decoded rows.
     * @param query - the raw search box content.
     * @returns every matching row (the caller bounds what it renders).
     */
    function filterSessions(rows, query) {
      const list = Array.isArray(rows) ? rows : [];
      const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
      if (needle.length === 0) return list.slice();
      return list.filter((row) => sessionMatchesQuery(row, needle));
    }

    /** The readable label of one session row. */
    function sessionRowLabel(row) {
      return `${row.displayTitle || row.title || row.id}${row.running ? ' ●' : ''}${row.cwd ? ` — ${row.cwd}` : ''}`;
    }

    /** The readable label of a session id inside a row list (falls back to the id). */
    function sessionLabelOf(rows, id) {
      if (typeof id !== 'string' || id.length === 0) return '';
      const row = (Array.isArray(rows) ? rows : []).find((candidate) => candidate.id === id);
      return row ? row.displayTitle || row.title || row.id : id;
    }

    /**
     * Read the session seat off `props.useSessions` without ever throwing.
     *
     * `useSessions` is a root-level hook contributed by
     * `dsh-client-ui-session`; it needs no inject and no require. When the
     * contribution is absent (`typeof !== 'function'`) or a call throws, the
     * picker degrades to a manual session id and says so on the page.
     * @param useSessions - the hook from props, or anything else.
     * @returns `{mode, currentId, rows, degraded, reason}`.
     */
    function readSessionSeat(useSessions) {
      if (typeof useSessions !== 'function') {
        return { mode: 'manual', currentId: '', rows: [], degraded: true, reason: 'no-hook' };
      }
      try {
        const decoded = decodeSessions(useSessions(sessionsProbeSelector));
        return {
          mode: 'sessions',
          currentId: decoded.currentId,
          rows: decoded.rows,
          degraded: false,
          reason: decoded.rows.length === 0 ? 'empty' : null,
        };
      } catch (error) {
        return {
          mode: 'manual',
          currentId: '',
          rows: [],
          degraded: true,
          reason: 'hook-threw',
          message: error && error.message ? String(error.message) : String(error),
        };
      }
    }

    /**
     * The single selector handed to the props `useWorkspaces` root hook.
     *
     * Shape confirmed by reading the installed 0.1.7-rc.2 package (NOTES §48):
     * `dsh-client-ui-workspace/lib/client.js:4137` contributes
     * `ctx.slots.provideRoot({hooks:{workspaces: workspaces.list}})`, which the
     * renderer synthesises into `useWorkspaces` for every root-scope slot
     * (`dsh-client-ui-renderer/lib/client.js:703-711`) — so, exactly like
     * `useSessions`, no inject and no require are needed. `WorkspaceSnapshot` is
     * `{items, archivedSessionIds, pinnedSessionIds, state, phase, error}`
     * (`dsh-api-workspace-controller/lib/types/client/model.d.ts`), and each
     * `WorkspaceView` is `{workspaceId, path, title, sessionIds, createdAt,
     * updatedAt}` (`.../lib/types/types.d.ts:19-33`).
     *
     * The payload is one compact string (the hook's equality check then sees a
     * stable value) laid out as four records:
     * `items \u001c pinned \u001c archived \u001c phase \u001c state`, where an item is
     * `workspaceId \u001f title \u001f path \u001f sessionIds(\u001d)`.
     * @param state - `WorkspaceSnapshot` (or anything shaped like it).
     * @returns the encoded string.
     */
    function workspacesProbeSelector(state) {
      const items = state && Array.isArray(state.items) ? state.items : [];
      const records = items.map((item) => {
        const workspace = item || {};
        const members = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
        return [
          flattenSessionField(workspace.workspaceId),
          flattenSessionField(workspace.title),
          flattenSessionField(workspace.path),
          members.map((id) => flattenSessionField(id)).join(SCOPE_ID_SEP),
        ].join(SESSION_FIELD_SEP);
      });
      const ids = (value) =>
        (Array.isArray(value) ? value : []).map((id) => flattenSessionField(id)).join(SCOPE_ID_SEP);
      return [
        records.join(SESSION_ROW_SEP),
        ids(state && state.pinnedSessionIds),
        ids(state && state.archivedSessionIds),
        state && typeof state.phase === 'string' ? state.phase : '',
        state && typeof state.state === 'string' ? state.state : '',
      ].join(SCOPE_RECORD_SEP);
    }

    /**
     * One-entry decode cache for {@link workspacesProbeSelector}, keyed by the
     * exact payload (a changed workspace list misses).
     */
    let workspaceDecodeKey = null;
    let workspaceDecodeValue = {
      items: [],
      pinned: [],
      archived: [],
      phase: '',
      state: '',
    };

    /**
     * Decode {@link workspacesProbeSelector}'s output. A payload with too few
     * records is unconformant and yields no workspaces rather than a fabricated
     * grouping.
     * @param encoded - the selector value.
     * @returns `{items: [{workspaceId, title, path, sessionIds}], pinned, archived, phase, state}`.
     */
    function decodeWorkspaces(encoded) {
      const empty = { items: [], pinned: [], archived: [], phase: '', state: '' };
      if (typeof encoded !== 'string' || encoded.length === 0) return empty;
      if (encoded === workspaceDecodeKey) return workspaceDecodeValue;
      const parts = encoded.split(SCOPE_RECORD_SEP);
      if (parts.length < 5) return empty;
      const splitIds = (value) => (value === '' ? [] : value.split(SCOPE_ID_SEP));
      const items = (parts[0] === '' ? [] : parts[0].split(SESSION_ROW_SEP))
        .map((record) => {
          const fields = record.split(SESSION_FIELD_SEP);
          return {
            workspaceId: fields[0] || '',
            title: fields[1] || '',
            path: fields[2] || '',
            sessionIds: splitIds(fields[3] || ''),
          };
        })
        .filter((workspace) => workspace.workspaceId.length > 0 || workspace.sessionIds.length > 0);
      workspaceDecodeKey = encoded;
      workspaceDecodeValue = {
        items,
        pinned: splitIds(parts[1] || ''),
        archived: splitIds(parts[2] || ''),
        phase: parts[3] || '',
        state: parts[4] || '',
      };
      return workspaceDecodeValue;
    }

    /**
     * Read the workspace seat off `props.useWorkspaces` without ever throwing.
     *
     * When the contribution is absent (`typeof !== 'function'`) or a call
     * throws, the picker degrades to the flat searchable list and says so on
     * the page — it never guesses a grouping.
     * @param useWorkspaces - the hook from props, or anything else.
     * @returns `{mode, items, pinned, archived, phase, state, degraded, reason}`.
     */
    function readWorkspaceSeat(useWorkspaces) {
      const base = { items: [], pinned: [], archived: [], phase: '', state: '' };
      if (typeof useWorkspaces !== 'function') {
        return { ...base, mode: 'degraded', degraded: true, reason: 'no-hook' };
      }
      try {
        const decoded = decodeWorkspaces(useWorkspaces(workspacesProbeSelector));
        return { ...decoded, mode: 'workspaces', degraded: false, reason: decoded.items.length === 0 ? 'empty' : null };
      } catch (error) {
        return {
          ...base,
          mode: 'degraded',
          degraded: true,
          reason: 'hook-threw',
          message: error && error.message ? String(error.message) : String(error),
        };
      }
    }

    /** Directory basename (both separators accepted), or '' when there is none. */
    function basenameOf(path) {
      const text = typeof path === 'string' ? path : '';
      const trimmed = text.replace(/[/\\]+$/, '');
      const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
      return trimmed.slice(separator + 1);
    }

    /**
     * Workspace node label: the workspace title, the localized name of the
     * product's default workspace, else the basename of its path — the same
     * precedence the sidebar uses (`workspaceDisplayTitle` +
     * `workspaceLabel`, `dsh-client-ui-workspace/lib/client.js:267-272`,
     * `:1053-1055`).
     * @param workspace - a decoded workspace item.
     * @param labels - `{defaultName, untitled}` already localized.
     * @returns the label text.
     */
    function workspaceLabelOf(workspace, labels) {
      const title = typeof workspace.title === 'string' ? workspace.title : '';
      if (title === 'default-workspace') return labels.defaultName;
      if (title.length > 0) return title;
      const base = basenameOf(workspace.path);
      return base.length > 0 ? base : workspace.path || labels.untitled;
    }

    /**
     * Project session ids by recency, newest first, id ascending as the
     * deterministic tie-break — copied verbatim from the sidebar's
     * `orderByRecency` (`dsh-client-ui-workspace/lib/client.js:278-298`).
     * @param ids - candidate ids.
     * @param byId - session rows by id.
     * @returns the ordered ids (unknown ids dropped).
     */
    function orderByRecency(ids, byId) {
      return ids
        .flatMap((id) => {
          const row = byId[id];
          if (row === undefined) return [];
          const rank = Number.isFinite(row.updatedAt) ? row.updatedAt : 0;
          return [{ id, rank }];
        })
        .sort((a, b) => {
          if (a.rank !== b.rank) return b.rank - a.rank;
          return a.id < b.id ? -1 : 1;
        })
        .map((member) => member.id);
    }

    /**
     * Order one group's members the way the sidebar does: recency order, the
     * selected provisional New Session first (`pinCurrentBlank`, :338-343),
     * then pinned rows ahead of the rest (`sectionMembers`, :373-386).
     * @param ids - the group's visible member ids.
     * @param byId - session rows by id.
     * @param pinned - the registry-global pin set.
     * @param currentId - the retained main-view session, if any.
     * @returns the ordered ids.
     */
    function scopeMemberOrder(ids, byId, pinned, currentId) {
      const recency = orderByRecency(ids, byId);
      const current = byId[currentId];
      const ordered =
        current !== undefined && current.blank === true && ids.indexOf(currentId) >= 0
          ? [currentId, ...recency.filter((id) => id !== currentId)]
          : recency;
      const placeholders = [];
      const leading = [];
      const rest = [];
      for (const id of ordered) {
        const row = byId[id];
        if (row.blank === true) placeholders.push(id);
        else if (pinned.has(id)) leading.push(id);
        else rest.push(id);
      }
      return [...placeholders, ...leading, ...rest];
    }

    /** Clamp one group's requested page size into its legal band. */
    function scopeGroupLimit(value) {
      if (!Number.isInteger(value)) return SCOPE_GROUP_PAGE;
      return Math.min(SCOPE_GROUP_MAX, Math.max(SCOPE_GROUP_PAGE, value));
    }

    /**
     * Derive the「查看范围」tree from the two root-hook seats.
     *
     * Grouping, ordering and visibility are copied from the product's own
     * workspace browser (`dsh-client-ui-workspace/lib/client.js`), so the picker
     * reads like the left sidebar:
     *   - groups follow the Host order of `WorkspaceSnapshot.items`, and the
     *     ungrouped bucket is appended last (`groupByWorkspace`, :418-437) —
     *     a session that belongs to no workspace is never dropped;
     *   - a session is listed unless it is subagent-origin, a non-selected
     *     blank row, or archived (`sessionVisible`, :358-372: the sidebar's
     *     default archived filter);
     *   - members are ordered by recency, then the selected blank row, then
     *     pinned rows (`orderByRecency` + `pinCurrentBlank` + `sectionMembers`).
     *
     * The tree is a **window** over the catalog, never a copy of it: at most
     * {@link SCOPE_GROUP_PAGE} session rows per expanded group, raised by
     * {@link SCOPE_GROUP_STEP} per 「显示更多」 up to {@link SCOPE_GROUP_MAX},
     * and at most {@link SCOPE_TOTAL_MAX} session rows plus
     * {@link SCOPE_GROUP_LIMIT} group headers overall. Groups without visible
     * members are dropped; the group holding the current session may add one
     * header beyond the limit so the default view always contains it.
     *
     * Search semantics: a non-empty query keeps only matching sessions **and
     * the workspace node that carries them** (every group with ≥1 match stays,
     * with its non-matching children dropped, and is forced open so the matches
     * are actually visible). A query that matches a workspace label or path
     * keeps every session of that workspace.
     * @param input - `{rows, currentId, workspaces, pinned, archived, query, expanded, limits, labels}`.
     * @returns the windowed tree plus its counters.
     */
    function deriveScope(input) {
      const rows = Array.isArray(input.rows) ? input.rows : [];
      const workspaces = Array.isArray(input.workspaces) ? input.workspaces : [];
      const currentId = typeof input.currentId === 'string' ? input.currentId : '';
      const needle = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
      const labels = input.labels && typeof input.labels === 'object' ? input.labels : {};
      const limits = input.limits && typeof input.limits === 'object' ? input.limits : {};
      const expanded = input.expanded && typeof input.expanded === 'object' ? input.expanded : {};
      const archived = new Set(Array.isArray(input.archived) ? input.archived : []);
      const pinned = new Set(Array.isArray(input.pinned) ? input.pinned : []);

      const byId = Object.create(null);
      for (const row of rows) byId[row.id] = row;

      const isVisible = (row) => {
        if (row.origin === 'subagent') return false;
        if (row.blank === true && row.id !== currentId) return false;
        if (archived.has(row.id)) return false;
        return true;
      };

      const accounted = new Set();
      for (const workspace of workspaces) {
        for (const id of workspace.sessionIds) accounted.add(id);
      }
      let currentGroupKey;
      if (currentId !== '') {
        const owner = workspaces.find((workspace) => workspace.sessionIds.indexOf(currentId) >= 0);
        currentGroupKey = owner ? owner.workspaceId : '';
      }

      const sections = workspaces.map((workspace) => ({
        key: workspace.workspaceId,
        workspaceId: workspace.workspaceId,
        path: workspace.path,
        label: workspaceLabelOf(workspace, labels),
        memberIds: workspace.sessionIds,
      }));
      const ungrouped = rows.map((row) => row.id).filter((id) => !accounted.has(id));
      if (ungrouped.length > 0) {
        sections.push({
          key: '',
          workspaceId: undefined,
          path: '',
          label: labels.ungrouped,
          memberIds: ungrouped,
        });
      }

      let total = 0;
      let matched = 0;
      let budget = SCOPE_TOTAL_MAX;
      let groupRows = 0;
      let archivedHidden = 0;
      let groupsSuppressed = 0;
      let truncated = false;
      const groups = [];
      const visible = [];

      for (const section of sections) {
        const known = [];
        for (const id of section.memberIds) {
          const row = byId[id];
          if (row === undefined) continue;
          if (!isVisible(row)) {
            archivedHidden += 1;
            continue;
          }
          known.push(id);
        }
        if (known.length === 0) continue;
        const ordered = scopeMemberOrder(known, byId, pinned, currentId);
        const labelText = `${section.label} ${section.path || ''}`.toLowerCase();
        const labelMatch = needle.length > 0 && labelText.indexOf(needle) >= 0;
        const matchedIds =
          needle.length === 0 || labelMatch
            ? ordered
            : ordered.filter((id) => sessionMatchesQuery(byId[id], needle));
        total += ordered.length;
        matched += matchedIds.length;
        // A search drops every group that carries no match: only the ancestors
        // of the matches survive.
        if (needle.length > 0 && matchedIds.length === 0) continue;

        const containsCurrent = currentGroupKey !== undefined && section.key === currentGroupKey;
        const explicit = expanded[section.key];
        const open =
          needle.length > 0
            ? matchedIds.length > 0
            : typeof explicit === 'boolean'
              ? explicit
              : containsCurrent;
        if (groupRows >= SCOPE_GROUP_LIMIT && !containsCurrent) {
          groupsSuppressed += 1;
          continue;
        }
        groupRows += 1;

        const limit = scopeGroupLimit(limits[section.key]);
        const windowIds = open ? matchedIds.slice(0, limit) : [];
        const room = Math.max(0, Math.min(windowIds.length, budget));
        const renderedIds = windowIds.slice(0, room);
        budget -= room;
        const hidden = open ? matchedIds.length - room : 0;
        if (open && room < windowIds.length) truncated = true;
        const sessions = renderedIds.map((id) => byId[id]);
        groups.push({
          key: section.key,
          workspaceId: section.workspaceId,
          path: section.path,
          label: section.label,
          total: ordered.length,
          matched: matchedIds.length,
          expanded: open,
          containsCurrent,
          hidden,
          limit,
          more: hidden > 0 && matchedIds.length > limit,
          sessions,
        });
        for (const row of sessions) visible.push(row);
      }

      return {
        groups,
        rows: visible,
        total,
        matched,
        shown: SCOPE_TOTAL_MAX - budget,
        archivedHidden,
        groupsShown: groupRows,
        groupsTotal: sections.length,
        groupsSuppressed,
        truncated,
        currentGroupKey,
      };
    }

    /** Effective layer of a section entry: 'default' | 'user' | 'workspace'. */
    function sectionLayer(section) {
      if (section && section.overrideLayer === 'user') return 'user';
      if (section && section.overrideLayer === 'workspace') return 'workspace';
      return 'default';
    }

    /** One of the four `origin` values, with a defensive fallback. */
    function originOf(section) {
      const origin = section ? section.origin : undefined;
      if (typeof origin === 'string' && ORIGINS.indexOf(origin) >= 0) return origin;
      return section && section.action === 'append' ? 'appended' : 'registered';
    }

    /** Localized label key for an origin value. */
    function originKey(origin) {
      if (origin === 'appended') return 'originAppended';
      if (origin === 'downstream-added') return 'originDownstream';
      if (origin === 'unmatched-override') return 'originUnmatched';
      return 'originRegistered';
    }

    /** Tag tone for an origin value; `downstream-added` is neutral, not a fault. */
    function originTone(origin) {
      if (origin === 'appended') return 'info';
      if (origin === 'unmatched-override') return 'warning';
      if (origin === 'downstream-added') return 'neutral';
      return 'outline';
    }

    /** Localized label key for one filter value (layer, overridable or origin). */
    function filterLabelKey(value) {
      if (value === 'user') return 'fUser';
      if (value === 'workspace') return 'fWorkspace';
      if (value === 'default') return 'fDefault';
      if (value === 'yes') return 'fYes';
      if (value === 'no') return 'fNo';
      if (value === 'all') return 'fAll';
      return originKey(value);
    }

    /** Localized label for a layer value. */
    function layerKey(layer) {
      if (layer === 'user') return 'fUser';
      if (layer === 'workspace') return 'fWorkspace';
      return 'fDefault';
    }

    /**
     * The three-state `frozenScope` presentation (CONTRACT.md §2.4, §7.2).
     *
     * - `frozenScope: "session"` → `frozen` describes the selected session;
     * - `frozenScope: "global"` **with** a selected session → the session's own
     *   state is *unknown*; this must never be presented as "not frozen";
     * - `frozenScope: "global"` without a session → it describes the global
     *   assembly.
     * @param snapshot - the snapshot payload, or null.
     * @param sessionSelected - whether the page is scoped to a session.
     * @returns `{kind, scope, certain, frozen, reason, pending}`.
     */
    function frozenState(snapshot, sessionSelected) {
      if (!snapshot || typeof snapshot !== 'object') {
        return { kind: 'unknown', scope: 'none', certain: false, frozen: false, reason: null, pending: true };
      }
      const frozen = snapshot.frozen === true;
      const reason = snapshot.frozenReason ? String(snapshot.frozenReason) : null;
      if (snapshot.frozenScope === 'session') {
        return { kind: frozen ? 'frozen' : 'unfrozen', scope: 'session', certain: true, frozen, reason, pending: false };
      }
      if (sessionSelected) {
        return {
          kind: 'unknown',
          scope: 'global',
          certain: false,
          frozen,
          reason: snapshot.frozenScopeReason ? String(snapshot.frozenScopeReason) : null,
          pending: false,
        };
      }
      return { kind: frozen ? 'frozen' : 'unfrozen', scope: 'global', certain: true, frozen, reason, pending: false };
    }

    /** Localized copy for a frozen verdict. */
    function frozenKey(fz) {
      if (fz.kind === 'unknown') return 'stFrozenUnknown';
      if (fz.scope === 'session') return fz.frozen ? 'stFrozenSession' : 'stUnfrozenSession';
      return fz.frozen ? 'stFrozenGlobal' : 'stUnfrozenGlobal';
    }

    /**
     * The build stamp's verdict, as the string the page exposes verbatim in
     * `data-build-match` (CONTRACT.md §14).
     *
     * Three states, and the asymmetry is the point: `'false'` requires a hash
     * on **both** sides and a difference. Every other case — no self-digest (an
     * engine that will not return the source), an old host without
     * `clientBuild`, a file whose region is unusable, a failed or unreachable
     * ping — is `'unknown'`. Rendering「过期」from a missing answer would send
     * the reader chasing a non-existent stale bundle, which is exactly the
     * confusion this feature exists to end.
     * @param boot - the `{self, server, pingFailed}` state.
     * @returns `'true'`, `'false'` or `'unknown'`.
     */
    function buildVerdict(boot) {
      const self = boot && boot.self && typeof boot.self.hash === 'string' ? boot.self.hash : null;
      const server = boot && boot.server && typeof boot.server.hash === 'string' ? boot.server.hash : null;
      if (self === null || server === null) return 'unknown';
      return self === server ? 'true' : 'false';
    }

    /**
     * The plugin version the page shows, taken from the ping's `version` field
     * (g-029) — the **only** source. This file carries no version literal of its
     * own: a second copy would be a second thing to keep in sync, which is
     * exactly the drift the display exists to end.
     *
     * `'unknown'` covers every way the same ping can fail to answer: no response
     * at all, a failed request, a body without `version`, a non-string value, or
     * a string that declares nothing — the empty string, or only whitespace. A
     * fabricated version here would be worse than none — the reader would be
     * told a version this build is not (CONTRACT.md §13.8).
     * @param boot - the `{self, server, version, pingFailed}` state.
     * @returns the version as the host reported it, or `'unknown'`.
     */
    function pluginVersionOf(boot) {
      const version = boot && boot.version;
      // Whitespace is not a declaration: `'   '` renders as「未知」rather than as
      // `v   `. A value that *does* carry text is returned byte for byte — a
      // legal version is never trimmed into a different one.
      return typeof version === 'string' && version.trim().length > 0 ? version : 'unknown';
    }

    /**
     * Whether the edit controls must be disabled for a section.
     *
     * A section that cannot be overridden is always disabled. A frozen verdict
     * disables editing only when it is certain for the scope being viewed; the
     * `frozenScope: "global"` + session case warns instead of silently
     * allowing (CONTRACT.md §2.4: treat it as unknown, not as unfrozen).
     * @param section - the effective section entry, or null.
     * @param fz - the frozen presentation.
     * @param t - the bound translator.
     * @returns `{disabled, reasons, warn}`.
     */
    function editGate(section, fz, t) {
      const reasons = [];
      if (section && section.overridable === false) {
        reasons.push(section.reason ? String(section.reason) : t('editDisabledOverridable'));
      }
      if (fz.certain && fz.frozen) reasons.push(t('editDisabledFrozen'));
      return { disabled: reasons.length > 0, reasons, warn: !fz.certain && !fz.pending };
    }

    /**
     * The section names a real turn's waterfall already has when our listener
     * runs: the registered `base` names plus anything another listener added
     * before us (`origin: "downstream-added"`).
     *
     * A name our OWN `append` introduced is deliberately *not* here: the
     * override list is keyed by name, so re-saving that append is an upsert
     * that still takes effect (and blocking it would make an existing append
     * uneditable).
     * @param snapshot - the snapshot payload, or null.
     * @returns a Set of names.
     */
    function incomingNames(snapshot) {
      const names = new Set();
      if (!snapshot || typeof snapshot !== 'object') return names;
      const base = snapshot.base && Array.isArray(snapshot.base.sections) ? snapshot.base.sections : [];
      for (const section of base) {
        if (section && typeof section.name === 'string') names.add(section.name);
      }
      const effective =
        snapshot.effective && Array.isArray(snapshot.effective.sections) ? snapshot.effective.sections : [];
      for (const section of effective) {
        if (!section || typeof section.name !== 'string') continue;
        if (section.origin === 'appended') continue;
        if (section.origin === 'downstream-added') {
          names.add(section.name);
          continue;
        }
        // Defensive: a rendered section nothing overrides belongs to the
        // incoming assembly even if its `origin` is missing or unknown.
        if (
          section.index !== null &&
          section.index !== undefined &&
          section.overrideLayer === null &&
          section.action === null
        ) {
          names.add(section.name);
        }
      }
      return names;
    }

    /**
     * Whether one override would actually take effect, decided BEFORE the write
     * by the same two rules the Host's `applyOverrides` uses (CONTRACT §4.1):
     * `append` to a name already in the incoming assembly is skipped as
     * `name-already-present` (two sections may not share a name), and
     * `replace`/`hide` for a name that is not there is skipped as
     * `section-not-present`. A save that cannot take effect must never look
     * successful — that is the silent-invalidity mode this page exists to
     * prevent.
     * @param name - the requested section name.
     * @param action - 'replace' | 'hide' | 'append'.
     * @param incoming - the names {@link incomingNames} returned.
     * @returns `{blocked, code}`; `code` is null when the save may proceed.
     */
    function overrideFeasibility(name, action, incoming) {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (trimmed.length === 0) return { blocked: true, code: 'missing-name' };
      const present = incoming instanceof Set ? incoming.has(trimmed) : false;
      if (action === 'append') return present ? { blocked: true, code: 'name-already-present' } : { blocked: false, code: null };
      return present ? { blocked: false, code: null } : { blocked: true, code: 'section-not-present' };
    }

    /**
     * Localized, actionable copy for a blocked override.
     * @param t - the bound translator.
     * @param feasibility - the {@link overrideFeasibility} verdict.
     * @returns the display text.
     */
    function blockText(t, feasibility) {
      if (feasibility.code === 'missing-name') return t('blockMissingName');
      if (feasibility.code === 'name-already-present') return t('blockAppendExisting');
      return t('blockNotPresent');
    }

    /**
     * The real cause of an override that did not take effect, when the client
     * can prove it from the section names (the Host's own `reason` describes the
     * observation, not always the cause).
     * @param t - the bound translator.
     * @param entry - an `effective.sections` entry.
     * @param incoming - the names {@link incomingNames} returned.
     * @returns `{code, text}` or null when there is nothing provable to add.
     */
    function ineffectiveCause(t, entry, incoming) {
      if (!entry || entry.applied === true) return null;
      const feasibility = overrideFeasibility(entry.name, entry.action, incoming);
      if (!feasibility.blocked) return null;
      return { code: feasibility.code, text: blockText(t, feasibility) };
    }

    /** Split a text into lines without dropping a trailing empty line. */
    function splitLines(text) {
      return String(text === null || text === undefined ? '' : text).split('\n');
    }

    /** Number of non-overlapping case-insensitive occurrences. */
    function countMatches(text, query) {
      if (typeof query !== 'string' || query.length === 0) return 0;
      const haystack = String(text).toLowerCase();
      const needle = query.toLowerCase();
      let from = 0;
      let total = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) return total;
        total += 1;
        from = at + needle.length;
      }
    }

    /**
     * Split text into plain strings and highlighted `mark` nodes.
     * @param text - the text to render.
     * @param query - the search needle ('' = no highlight).
     * @returns an array of React children.
     */
    function highlightNodes(text, query) {
      const source = String(text);
      const needle = typeof query === 'string' ? query : '';
      if (needle.length === 0) return [source];
      const haystack = source.toLowerCase();
      const lower = needle.toLowerCase();
      const out = [];
      let cursor = 0;
      let index = 0;
      for (;;) {
        const at = haystack.indexOf(lower, cursor);
        if (at === -1) break;
        if (at > cursor) out.push(source.slice(cursor, at));
        out.push(
          h(
            'mark',
            {
              key: `hit-${index}`,
              'data-search-hit': 'true',
              style: { background: token.markFill, color: 'inherit', borderRadius: 3 },
            },
            source.slice(at, at + needle.length),
          ),
        );
        cursor = at + needle.length;
        index += 1;
      }
      if (cursor < source.length) out.push(source.slice(cursor));
      return out;
    }

    /**
     * Line-level common prefix/suffix trim: the cheap, honest way to point at
     * what actually changed between two section texts without an O(n·m) LCS on
     * a 50 KiB prompt.
     * @param baseText - the registered text.
     * @param effectiveText - the resulting text.
     * @returns `{base, effective}` — only the differing middle blocks.
     */
    function chunkDiff(baseText, effectiveText) {
      const a = splitLines(baseText);
      const b = splitLines(effectiveText);
      let prefix = 0;
      while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
      let suffix = 0;
      while (
        suffix < a.length - prefix &&
        suffix < b.length - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
      ) {
        suffix += 1;
      }
      return {
        base: a.slice(prefix, a.length - suffix),
        effective: b.slice(prefix, b.length - suffix),
      };
    }

    /**
     * Compare `base.sections` with `effective.sections` by name.
     * @param baseSections - `base.sections`.
     * @param effectiveSections - `effective.sections`.
     * @returns rows of `{name, status, base, effective}`.
     */
    function diffSections(baseSections, effectiveSections) {
      const base = Array.isArray(baseSections) ? baseSections : [];
      const effective = Array.isArray(effectiveSections) ? effectiveSections : [];
      const effectiveByName = new Map();
      for (const section of effective) effectiveByName.set(section.name, section);
      const seen = new Set();
      const rows = [];
      for (const section of base) {
        seen.add(section.name);
        const after = effectiveByName.get(section.name);
        if (!after) {
          rows.push({ name: section.name, status: 'removed', base: section, effective: null });
          continue;
        }
        const changed =
          String(after.text) !== String(section.text) || after.index === null || after.applied === true;
        rows.push({
          name: section.name,
          status: changed ? 'changed' : 'same',
          base: section,
          effective: after,
        });
      }
      for (const section of effective) {
        if (seen.has(section.name)) continue;
        rows.push({ name: section.name, status: 'added', base: null, effective: section });
      }
      return rows;
    }

    /** Localized label key for a diff status. */
    function diffKey(status) {
      if (status === 'changed') return 'diffChanged';
      if (status === 'added') return 'diffAdded';
      if (status === 'removed') return 'diffRemoved';
      return 'diffSame';
    }

    /** Tag tone for a diff status. */
    function diffTone(status) {
      if (status === 'changed' || status === 'added') return 'warning';
      if (status === 'removed') return 'danger';
      return 'outline';
    }

    /**
     * Recompose the final text from a filtered section list, honoring render
     * order and dropping suppressed (`index: null`) entries.
     * @param sections - `effective.sections`.
     * @param originFilter - one of the four origins, or 'all'.
     * @returns the joined text.
     */
    function composeSections(sections, originFilter) {
      return (Array.isArray(sections) ? sections : [])
        .filter((section) => section && section.index !== null && section.index !== undefined)
        .filter((section) => originFilter === 'all' || originOf(section) === originFilter)
        .map((section) => (typeof section.text === 'string' ? section.text : ''))
        .filter((text) => text.length > 0)
        .join('\n\n');
    }

    /**
     * The advisories one write/enable response carries (Revision 12, audit F2).
     *
     * Tolerant by construction: an older host has no `warnings` field at all, and
     * a malformed entry must not be able to blank the panel. Only entries with a
     * usable `name` survive, because that is what the copy names.
     * @param payload - a route payload, or anything else.
     * @returns `[{name, kind, message}]`, possibly empty.
     */
    function payloadWarnings(payload) {
      const list = payload && Array.isArray(payload.warnings) ? payload.warnings : [];
      return list
        .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.name === 'string' && entry.name.length > 0)
        .map((entry) => ({
          name: String(entry.name),
          kind: typeof entry.kind === 'string' ? entry.kind : 'undefined-value',
          message: typeof entry.message === 'string' ? entry.message : '',
        }));
    }

    /**
     * Turn a failed request into localized copy. Every documented `code` has a
     * dictionary entry; an unknown code still renders readable text plus the
     * raw code, never the code alone.
     * @param t - the bound translator.
     * @param error - `{code, message, status, network}`.
     * @returns the display string.
     */
    function errorText(t, error) {
      if (!error) return t('errUnknown');
      if (error.code) {
        const key = `error.${error.code}`;
        const text = safeT(t, key, '');
        if (text.length > 0) return text;
      }
      if (error.network) return t('errNetwork');
      if (error.status) return fmt(t('errHttp'), { status: error.status });
      return t('errUnknown');
    }

    /**
     * One request, never throwing. Success requires `ok: true`, matching the
     * contract's shape for all four routes.
     * @param path - request path (may include a query string).
     * @param init - optional fetch init.
     * @returns `{ok, status, payload}` or `{ok: false, status, error}`.
     */
    async function requestJson(path, init) {
      try {
        const response = await fetch(path, {
          headers: { accept: 'application/json', ...(init && init.headers ? init.headers : {}) },
          ...(init || {}),
        });
        let text = '';
        try {
          text = await response.text();
        } catch {
          text = '';
        }
        let payload = null;
        try {
          payload = text.length > 0 ? JSON.parse(text) : null;
        } catch {
          payload = null;
        }
        if (response.ok && payload !== null && payload.ok === true) {
          return { ok: true, status: response.status, payload };
        }
        return {
          ok: false,
          status: response.status,
          error: {
            code: payload && typeof payload.code === 'string' ? payload.code : null,
            message:
              payload && typeof payload.message === 'string'
                ? payload.message
                : text.length > 0
                  ? text.slice(0, 300)
                  : '',
            status: response.status,
            network: false,
          },
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          error: {
            code: null,
            message: error && error.message ? String(error.message) : String(error),
            status: 0,
            network: true,
          },
        };
      }
    }

    /**
     * Copy text, preferring the probe's own clipboard helper.
     * @param text - the text to copy.
     * @returns whether the copy succeeded.
     */
    async function copyText(text) {
      try {
        if (primitives && typeof primitives.writeClipboard === 'function') {
          await primitives.writeClipboard(text);
          return true;
        }
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }
    // #endregion

    // #region tree builders (host elements, so `data-*` markers survive)

    /** Shared card style. */
    const cardStyle = {
      border: `1px solid ${token.surfaceStroke}`,
      background: token.surface,
      borderRadius: 10,
      padding: '12px 14px',
    };
    /** Shared small meta text style. */
    const metaStyle = { fontSize: 12, color: token.labelTertiary };
    /** Shared heading style. */
    const headingStyle = { margin: 0, fontSize: 15, fontWeight: 600 };
    /**
     * The always-visible「查看范围」summary row (g-016). One flex line — a
     * heading, the readable scope name, an optional short state hint and the
     *「更改」switch — so the card's height collapses to its own padding plus
     * this row, and the tab bar below it stays on the first screen.
     */
    const scopeSummaryStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 24 };
    /** The readable scope name in the summary row. */
    const scopeSummaryTextStyle = { ...metaStyle, fontSize: 13, lineHeight: '20px', color: token.labelPrimary };
    /** The summary row's degradation hint (`scopeSummaryManual` / `scopeSummaryFlat`). */
    const scopeSummaryHintStyle = { ...metaStyle, lineHeight: '18px' };

    /**
     * Render one line of layer information.
     * @param t - the bound translator.
     * @param label - the localized layer name.
     * @param layer - `layers.user` / `layers.workspace`, or undefined.
     * @param key - `data-layer-status` marker value.
     * @returns the row element.
     */
    function layerLine(t, label, layer, key) {
      const enabled = layer ? layer.enabled === true : false;
      const reason = layer && layer.reason ? String(layer.reason) : '';
      return h(
        'div',
        {
          'data-layer-status': key,
          'data-enabled': String(enabled),
          style: { fontSize: 12, color: token.labelSecondary, display: 'flex', gap: 8, flexWrap: 'wrap' },
        },
        h('strong', { style: { fontWeight: 600 } }, label),
        h(UI.Tag, { tone: enabled ? 'success' : 'warning' }, enabled ? t('stEnabled') : t('stDisabled')),
        h(
          'span',
          { style: metaStyle },
          `${t('stPath')}: ${layer && layer.path ? String(layer.path) : t('stNone')}`,
        ),
        reason ? h('span', { style: { ...metaStyle, color: token.stateWarn } }, `${t('stReason')}: ${reason}`) : null,
      );
    }

    /**
     * Render an error banner for a failed request.
     * @param t - the bound translator.
     * @param error - the error descriptor.
     * @param title - the localized banner heading.
     * @returns the banner element.
     */
    function errorBanner(t, error, title) {
      return h(
        'div',
        {
          'data-error-code': error && error.code ? String(error.code) : '',
          'data-error-status': String(error && error.status ? error.status : 0),
          style: { ...cardStyle, borderColor: token.stateError },
        },
        h('strong', { style: { color: token.stateError, fontSize: 13 } }, title || t('errTitle')),
        h('div', { style: { marginTop: 4, fontSize: 13, color: token.labelPrimary } }, errorText(t, error)),
        error && error.code
          ? h('div', { style: { ...metaStyle, marginTop: 4 } }, `${t('errCode')}: ${error.code}`)
          : null,
        error && error.message
          ? h('div', { style: { ...metaStyle, marginTop: 2, wordBreak: 'break-word' } }, `${t('errDetail')}: ${error.message}`)
          : null,
      );
    }

    // #region stage 2 helpers (history / diff / reset / transfer)

    /**
     * Localized label for one history action.
     * @param t - the bound translator.
     * @param action - `replace` | `hide` | `append` | `remove` | `reset-layer`.
     * @returns the display string (the raw action for an unknown value).
     */
    function historyActionLabel(t, action) {
      const key = `histAction.${String(action)}`;
      const text = safeT(t, key, '');
      return text.length > 0 ? text : String(action);
    }

    /**
     * Localized label for one import status.
     * @param t - the bound translator.
     * @param status - `added` | `replaced` | `unchanged` | `removed`.
     * @returns the display string.
     */
    function importStatusLabel(t, status) {
      if (status === 'added') return t('importStatusAdded');
      if (status === 'replaced') return t('importStatusReplaced');
      if (status === 'removed') return t('importStatusRemoved');
      return t('importStatusUnchanged');
    }

    /**
     * A readable, stable timestamp. The ISO string is what history stores, so it
     * is also what is shown: no locale-dependent reformatting that would make
     * the same record read differently on two machines.
     * @param at - the ISO timestamp, or null.
     * @returns the display string.
     */
    function stampOf(at) {
      if (typeof at !== 'string' || at.length === 0) return '';
      return at.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
    }

    /**
     * The query string one stage 2 request needs for a layer.
     * @param layer - `user` | `workspace`.
     * @param sessionArg - the session id, or null.
     * @returns `layer=…&session=…`.
     */
    function layerQuery(layer, sessionArg) {
      const parts = [`layer=${encodeURIComponent(layer)}`];
      if (sessionArg !== null) parts.push(`session=${encodeURIComponent(sessionArg)}`);
      return parts.join('&');
    }

    /**
     * The reserved section's stored text in one layer, read from the *merged*
     * override list — the same list the assembly applies (CONTRACT.md §3), so
     * what 「我的 Prompt」 shows is what is configured rather than what the last
     * render happened to hold.
     *
     * `null` means "the layer has no reserved override at all" (the page shows
     * the unconfigured state); `''` means "configured, but as empty text".
     * @param ovs - the `GET /overrides` payload, or null.
     * @param layer - `user` | `workspace`.
     * @returns the stored text, or null when the entry is absent.
     */
    function reservedTextOf(ovs, layer) {
      const merged = ovs && ovs.merged && Array.isArray(ovs.merged.overrides) ? ovs.merged.overrides : [];
      const entry = merged.find(
        (candidate) =>
          candidate && candidate.name === RESERVED_SECTION_NAME && candidate.layer === layer,
      );
      if (entry === undefined) return null;
      return typeof entry.text === 'string' ? entry.text : '';
    }

    /**
     * Localized layer name.
     * @param t - the bound translator.
     * @param layer - `user` | `workspace`.
     * @returns the display string.
     */
    function layerLabel(t, layer) {
      return t(layer === 'workspace' ? 'ovWorkspace' : 'ovUser');
    }

    /**
     * Hand a JSON document to the browser as a download.
     *
     * Two surfaces are attempted in order, and the caller is told which one was
     * used so the UI can tell the truth when neither worked (the settings panel
     * must never claim a download that did not happen):
     * 1. `Blob` + an object URL — the real download;
     * 2. a `data:` URL on the same anchor — the fallback where `Blob` is absent.
     * @param text - the JSON text.
     * @param filename - the suggested file name.
     * @returns `{ok: true, mode}` or `{ok: false, reason}`.
     */
    function downloadText(text, filename) {
      const click = (href) => {
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = filename;
        anchor.rel = 'noopener';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
      };
      try {
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
          return { ok: false, reason: 'no document' };
        }
        if (typeof Blob === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
          try {
            click(url);
          } finally {
            if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
          }
          return { ok: true, mode: 'blob' };
        }
        click(`data:application/json;charset=utf-8,${encodeURIComponent(text)}`);
        return { ok: true, mode: 'data-url' };
      } catch (error) {
        return { ok: false, reason: error && error.message ? String(error.message) : String(error) };
      }
    }

    /**
     * The suggested export file name: identifiable, and ordered by time.
     * @param at - the ISO export timestamp.
     * @returns `dsh-prompt-setting-…json`, with the export time in the name.
     */
    function exportFileName(at) {
      const stamp = String(at || '').replace(/[:.]/g, '-').replace('Z', '');
      return `dsh-prompt-setting-${stamp.length > 0 ? stamp : 'export'}.json`;
    }

    /**
     * Whether the primitives module really exposes the official diff renderer.
     * Probed, never assumed — exactly like the Button/Tag probes.
     */
    const HAS_DIFF_BLOCK = primitivesUsable && typeof primitives.DiffBlock === 'function';

    /**
     * The localized chrome `DiffBlock` asks its owner for.
     * @param t - the bound translator.
     * @returns the labels object.
     */
    function diffBlockLabels(t) {
      return {
        copy: t('diffBlockCopy'),
        copied: t('diffBlockCopied'),
        collapse: t('diffBlockCollapse'),
        expand: (hidden) => fmt(t('diffBlockExpand'), { n: hidden }),
        collapseAria: t('diffBlockCollapseAria'),
        expandAria: (hidden) => fmt(t('diffBlockExpandAria'), { n: hidden }),
        codeLabel: t('diffBlockCode'),
        wrapLabel: t('diffBlockWrap'),
        unwrapLabel: t('diffBlockUnwrap'),
      };
    }

    /** Localized label for a diff line op. */
    function diffOpMarker(type) {
      if (type === 'insert') return '+';
      if (type === 'delete') return '-';
      return ' ';
    }

    // #endregion

    /**
     * One line of the facts that decide whether a write here will do anything:
     * mounted, the frozen three-state verdict, the build stamp's verdict, and —
     * since g-029 — the plugin version the host reported.
     *
     * g-015 moved every *explanation* into 「高级」 (see
     * {@link renderStatusDetail}): the top of the page states the verdicts, and
     * the reason behind each one is one tab away rather than three paragraphs
     * of permanently visible text. Nothing is lost — each tag keeps its reason
     * as a `title`, and the full paragraph is rendered in the detail block.
     *
     * `data-region="status"` is unchanged, and so is the build stamp's
     * machine-readable copy on the root container (`data-build`,
     * `data-build-server`, `data-build-match`), so a probe that read the page
     * before this goal still reads it. The version tag is added to the same
     * line: it is the other half of "what is this tab actually running", and it
     * needs no second request (§13.8).
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the section element.
     */
    function renderStatusLine(t, m, a) {
      const snapshot = m.snap.data;
      const fz = m.fz;
      const verdict = buildVerdict(m.boot);
      const version = pluginVersionOf(m.boot);
      const mounted = snapshot ? snapshot.mounted === true : null;
      const mountedText =
        mounted === null ? t('stMountedUnknown') : mounted ? t('stMountedOn') : t('stMountedOff');
      return h(
        'section',
        {
          'data-region': 'status',
          'data-status-mount': mounted === null ? 'unknown' : String(mounted),
          'data-status-frozen': fz.kind,
          'data-status-build': verdict,
          style: { ...cardStyle, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
        },
        h('span', { style: { ...metaStyle, fontWeight: 600 } }, t('stateHeading')),
        h(
          UI.Tag,
          { tone: mounted === true ? 'success' : mounted === false ? 'danger' : 'outline', title: t('stMounted') },
          `${t('stMounted')}: ${mountedText}`,
        ),
        h(
          UI.Tag,
          {
            tone: fz.kind === 'unknown' ? 'warning' : fz.frozen ? 'danger' : 'success',
            title: fz.reason ? String(fz.reason) : undefined,
          },
          t(frozenKey(fz)),
        ),
        h(
          UI.Tag,
          { tone: verdict === 'true' ? 'success' : verdict === 'false' ? 'danger' : 'outline', title: t('stBuild') },
          `${t('stBuild')}: ${t(verdict === 'true' ? 'stBuildSame' : verdict === 'false' ? 'stBuildStale' : 'stBuildUnknown')}`,
        ),
        // g-029: the version the host reported in the ping, on the same line as
        // the build stamp and never invented: without an answer the tag says
        // 「版本未知」 instead of a number (the root container carries the same
        // answer as `data-plugin-version`).
        h(
          UI.Tag,
          { tone: version === 'unknown' ? 'outline' : 'success', title: t('stPluginVersion') },
          `${t('stPluginVersion')}: ${version === 'unknown' ? t('stPluginVersionUnknown') : `v${version}`}`,
        ),
        h(UI.Button, { variant: 'outline', 'data-action': 'refresh', onClick: a.refresh }, t('refresh')),
      );
    }

    /**
     * The full status block, rendered in 「高级」: everything the one-line
     * summary compresses, plus the facts that were always detail — the
     * generation timestamp, both layers' `enabled`/`path`/`reason`, both build
     * digests, which renderer branch this page got, and why an unavailable
     * primitives module degraded it.
     *
     * Both non-green build states explain themselves, and neither is ever
     * rendered as「过期」unless both digests really answered and really differ;
     * the frozen verdict is likewise never reported as「未冻结」when it is
     * unknown.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @returns the section element.
     */
    function renderStatusDetail(t, m) {
      const snapshot = m.snap.data;
      const fz = m.fz;
      const verdict = buildVerdict(m.boot);
      const selfHash = m.boot && m.boot.self && typeof m.boot.self.hash === 'string' ? m.boot.self.hash : null;
      const serverHash =
        m.boot && m.boot.server && typeof m.boot.server.hash === 'string' ? m.boot.server.hash : null;
      const mounted = snapshot ? snapshot.mounted === true : null;
      const mountedText =
        mounted === null ? t('stMountedUnknown') : mounted ? t('stMountedOn') : t('stMountedOff');
      const frozenText = t(frozenKey(fz));
      const layers = snapshot && snapshot.layers ? snapshot.layers : {};
      return h(
        'section',
        { 'data-region': 'status-detail', style: cardStyle },
        h('h3', { style: headingStyle }, t('stateHeading')),
        h(
          'div',
          { style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: metaStyle }, `${t('stMounted')}:`),
          h(UI.Tag, { tone: mounted === true ? 'success' : mounted === false ? 'danger' : 'outline' }, mountedText),
          h(UI.Tag, { tone: fz.kind === 'unknown' ? 'warning' : fz.frozen ? 'danger' : 'success' }, frozenText),
          h(
            'span',
            { style: metaStyle },
            `${t('stGeneratedAt')}: ${snapshot && snapshot.generatedAt ? String(snapshot.generatedAt) : t('stNone')}`,
          ),
        ),
        h(
          'div',
          {
            'data-region': 'build',
            style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
          },
          h('span', { style: metaStyle }, `${t('stBuild')}:`),
          h(
            UI.Tag,
            { tone: verdict === 'true' ? 'success' : verdict === 'false' ? 'danger' : 'outline' },
            t(verdict === 'true' ? 'stBuildSame' : verdict === 'false' ? 'stBuildStale' : 'stBuildUnknown'),
          ),
          h('span', { style: metaStyle }, `${t('stBuildSelf')}: ${selfHash === null ? t('stNone') : selfHash}`),
          h('span', { style: metaStyle }, `${t('stBuildServer')}: ${serverHash === null ? t('stNone') : serverHash}`),
        ),
        verdict === 'false'
          ? h(
              'p',
              {
                'data-warning': 'client-build-stale',
                style: { margin: '8px 0 0', fontSize: 12, color: token.stateError, wordBreak: 'break-word' },
              },
              t('stBuildStaleHint'),
            )
          : null,
        verdict === 'unknown'
          ? h(
              'p',
              {
                'data-warning': 'client-build-unknown',
                style: { margin: '8px 0 0', fontSize: 12, color: token.labelTertiary, wordBreak: 'break-word' },
              },
              m.boot && m.boot.pingFailed
                ? `${t('stBuildUnknown')} — ${t('stBuildPingFailedHint')}`
                : t('stBuildUnknownHint'),
            )
          : null,
        fz.kind === 'unknown' && !fz.pending
          ? h(
              'p',
              {
                'data-warning': 'frozen-unknown',
                style: { margin: '8px 0 0', fontSize: 12, color: token.stateWarn, wordBreak: 'break-word' },
              },
              `${t('stFrozenUnknown')}${fz.reason ? ` — ${t('stReason')}: ${fz.reason}` : ''}`,
            )
          : null,
        fz.kind === 'unknown' && fz.frozen
          ? h(
              'p',
              { 'data-warning': 'frozen-global', style: { margin: '4px 0 0', fontSize: 12, color: token.stateWarn } },
              t('stFrozenGlobal'),
            )
          : null,
        fz.certain && fz.frozen
          ? h(
              'p',
              {
                'data-warning': 'frozen',
                style: { margin: '8px 0 0', fontSize: 12, color: token.stateError, wordBreak: 'break-word' },
              },
              `${frozenText}${fz.reason ? ` — ${t('stReason')}: ${fz.reason}` : ''}`,
            )
          : null,
        mounted === false
          ? h(
              'p',
              { 'data-warning': 'not-mounted', style: { margin: '8px 0 0', fontSize: 12, color: token.stateWarn } },
              t('stMountedOff'),
            )
          : null,
        h(
          'div',
          { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 } },
          layerLine(t, t('stUserLayer'), layers.user, 'user'),
          layerLine(t, t('stWorkspaceLayer'), layers.workspace, 'workspace'),
        ),
        h(
          'div',
          { 'data-region': 'renderer-info', style: { marginTop: 8, fontSize: 12, color: token.labelTertiary } },
          `${t('rendererLabel')}: ${t(RENDERER === 'primitives' ? 'rendererPrimitives' : 'rendererFallback')}`,
        ),
        RENDERER === 'fallback' && primitivesFailure
          ? h(
              'div',
              { 'data-primitives-failure': 'true', style: { fontSize: 12, color: token.labelTertiary, wordBreak: 'break-word' } },
              `${t('primitivesFailure')}: ${primitivesFailure}`,
            )
          : null,
      );
    }

    /**
     * Render the session selector (root `useSessions` seat, or the manual
     * degradation with its limitation spelled out).
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the section element.
     */
    /**
     * Does this event originate from a keyboard interaction?
     *
     * `:focus-visible` is the browser's own answer; when the event carries no
     * element to ask (or `matches` throws, as in a non-DOM environment) the ring
     * is shown — a visible ring is the safe direction to fail in.
     * @param event - a focus/blur event.
     * @returns whether the focus ring should be drawn.
     */
    function focusVisibleOf(event) {
      const target = event && event.target;
      if (target && typeof target.matches === 'function') {
        try {
          return target.matches(':focus-visible');
        } catch {
          return true;
        }
      }
      return true;
    }

    /**
     * The workspace folder glyph, open or closed, at the size the sidebar uses.
     * Primitives components when the module really exposes them, the identical
     * inlined geometry otherwise (NOTES §54).
     * @param open - whether the group is expanded.
     * @param size - rendered square size in px.
     * @returns the icon element.
     */
    function scopeFolderGlyph(open, size) {
      if (ICON_SOURCE === 'primitives') {
        const Icon = open ? primitives.IconFolderOpenRegular : primitives.IconFolderCloseRegular;
        return h(Icon, { size, 'data-role': 'scope-folder-glyph' });
      }
      if (open) {
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            xmlns: 'http://www.w3.org/2000/svg',
            'aria-hidden': 'true',
            'data-role': 'scope-folder-glyph',
          },
          FOLDER_OPEN_PATHS.map((path, index) =>
            h('path', {
              key: `p${index}`,
              d: path.d,
              fill: path.fill,
              opacity: path.opacity,
            }),
          ),
        );
      }
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          strokeWidth: 1,
          'data-role': 'scope-folder-glyph',
        },
        FOLDER_CLOSE_PATHS.map((d, index) => h('path', { key: `p${index}`, d, stroke: 'currentColor' })),
      );
    }

    /**
     * The expansion caret: the sidebar's own right-pointing triangle, rotated
     * in place while the group is open. Rotation is inline so the state is
     * visible without any stylesheet.
     * @param open - whether the group is expanded.
     * @param size - rendered square size in px.
     * @returns the caret element.
     */
    function scopeCaretGlyph(open, size) {
      const style = {
        display: 'inline-flex',
        transform: open ? 'rotate(90deg)' : 'none',
        transition: 'transform 0.15s',
        color: token.labelTertiary,
      };
      if (ICON_SOURCE === 'primitives') {
        return h('span', { style }, h(primitives.IconTriangleRightFillRegular, { size }));
      }
      return h(
        'span',
        { style },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            xmlns: 'http://www.w3.org/2000/svg',
            'aria-hidden': 'true',
            'data-role': 'scope-caret-glyph',
          },
          h('path', { d: CARET_PATH, fill: 'currentColor' }),
        ),
      );
    }

    /**
     * Shared interaction styling for one clickable row: pointer cursor, hover
     * fill, and the product's focus ring. The two states are mirrored into
     * `data-hover` / `data-focus` so they are machine-checkable without CSS.
     * @param hover - whether the pointer is over the row.
     * @param focus - whether the row holds keyboard focus.
     * @returns the style object.
     */
    function scopeRowStyle(hover, focus) {
      return {
        cursor: 'pointer',
        userSelect: 'none',
        background: hover ? token.hoverFill : 'transparent',
        outline: focus ? token.focusRing : 'none',
        outlineOffset: focus ? '-2px' : undefined,
        borderRadius: 6,
      };
    }

    /**
     * One pinned picker entry: always visible, never filtered, one click away.
     * It carries an explicit selected state (`data-selected` + a tick) rather
     * than relying on the label alone.
     * @param t - the bound translator.
     * @param key - 'global' | 'current' (the `data-pinned` marker).
     * @param label - localized label.
     * @param active - whether this entry is the current scope.
     * @param disabled - whether the entry cannot be used right now.
     * @param hovered - whether the pointer is over this entry.
     * @param focused - whether this entry holds keyboard focus.
     * @param onClick - selection callback.
     * @param setHover - hover state callback (`false` when leaving).
     * @param setFocus - focus state callback.
     * @returns the button element.
     */
    function pinnedSessionButton(t, key, label, active, disabled, hovered, focused, onClick, setHover, setFocus) {
      return h(
        'button',
        {
          type: 'button',
          'data-action': 'session-pinned',
          'data-role': 'pinned-option',
          'data-pinned': key,
          'data-pinned-active': String(active),
          'data-selected': String(active),
          'data-hover': String(hovered),
          'data-focus': String(focused),
          disabled,
          onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onFocus: (event) => setFocus(focusVisibleOf(event)),
          onBlur: () => setFocus(false),
          style: {
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '3px 10px',
            borderRadius: 999,
            opacity: disabled ? 0.5 : 1,
            cursor: disabled ? 'default' : 'pointer',
            color: active ? token.buttonLabel : token.labelPrimary,
            background: active ? token.buttonFill : hovered && !disabled ? token.hoverFill : 'transparent',
            border: `1px solid ${active ? 'transparent' : token.borderL2}`,
            outline: focused ? token.focusRing : 'none',
            outlineOffset: focused ? '-2px' : undefined,
          },
        },
        active
          ? h('span', { key: 'mark', 'data-role': 'pinned-selected-mark', 'aria-hidden': 'true' }, '✓')
          : null,
        h('span', { key: 'label' }, label),
      );
    }

    /**
     * One workspace group of the「查看范围」tree: the interactive header row
     * (folder icon, expansion caret, label, path subtitle, session count) plus
     * its windowed session rows.
     *
     * Affordance is the point of this row (review feedback: the group header
     * looked like static text). It carries, like the left sidebar's project row:
     * a folder glyph whose state *is* the expansion state, a caret that rotates,
     * `cursor: pointer` on the whole row, a hover fill, the shell's focus ring,
     * `aria-expanded` in sync with `data-expanded`, and Enter/Space keyboard
     * toggling. Both the glyph column and the rest of the row trigger the same
     * toggle; the glyph stops propagation so one click is one toggle.
     *
     * `data-scope-group` / `data-scope-toggle` / `data-scope-more` /
     * `data-scope-parent` are distinct attribute names on purpose: each selector
     * a test or a script uses matches exactly one node per group.
     *
     * ARIA shape (g-009): the header row is a level-1 `treeitem` and the
     * windowed session rows are level-2 `treeitem`s inside the `group` that
     * follows it, so the branch reads `tree > treeitem + group > treeitem` and
     * a bare `div` never comes between the `tree` and its items. The group is a
     * *sibling* of the header, not a DOM child of it: the whole header row is
     * the toggle target, so nesting the rows inside it would make every session
     * click bubble into the toggle and would draw the focus ring around the
     * children. Its `marginTop: -1` cancels the tree's 2px gap so the header /
     * first-row distance stays the 1px gap the old wrapper had.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @param group - one derived group.
     * @param activeId - the keyboard-highlighted session id ('' when none).
     * @returns `[header, group|null]`: the group is omitted when the workspace
     *   renders no child row (shut, or nothing matched), so a collapsed node
     *   never carries an empty group.
     */
    function scopeGroupParts(t, m, a, group, activeId) {
      const hovered = m.scopeHover === `g:${group.key}`;
      const focused = m.scopeFocus === `g:${group.key}`;
      const label = group.label;
      const nodes = [
        h(
          'div',
          {
            key: `h:${group.key}`,
            role: 'treeitem',
            'aria-level': 1,
            tabIndex: 0,
            'data-role': 'group-toggle',
            'data-scope-group': group.key,
            'data-expanded': String(group.expanded),
            'data-scope-contains-current': String(group.containsCurrent),
            'data-hover': String(hovered),
            'data-focus': String(focused),
            'aria-expanded': group.expanded,
            'aria-label': fmt(t('scopeToggleAria'), { name: label }),
            onClick: () => a.toggleScope(group.key, !group.expanded),
            onKeyDown: (event) => a.onScopeHeaderKeyDown(event, group.key, !group.expanded),
            onMouseEnter: () => a.setScopeHover(`g:${group.key}`),
            onMouseLeave: () => a.setScopeHover(''),
            onFocus: (event) => {
              if (focusVisibleOf(event)) a.setScopeFocus(`g:${group.key}`);
            },
            onBlur: () => a.setScopeFocus(''),
            style: {
              ...scopeRowStyle(hovered, focused),
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              padding: '3px 6px',
              color: group.containsCurrent ? token.stateBusiness : token.labelPrimary,
              border: `1px solid ${group.containsCurrent ? token.borderL2 : 'transparent'}`,
            },
          },
          h(
            'span',
            {
              key: 'icon',
              'data-role': 'scope-folder-icon',
              'data-icon-state': group.expanded ? 'open' : 'closed',
              'data-icon-source': ICON_SOURCE,
              'data-scope-toggle': group.key,
              'aria-hidden': 'true',
              onClick: (event) => {
                // The glyph column is part of the target, not a second control:
                // stop the bubble so one click cannot toggle twice.
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                a.toggleScope(group.key, !group.expanded);
              },
              style: { display: 'inline-flex', flex: 'none', alignItems: 'center' },
            },
            scopeFolderGlyph(group.expanded, 16),
          ),
          h(
            'span',
            {
              key: 'caret',
              'data-role': 'scope-caret',
              'data-caret-open': String(group.expanded),
              'aria-hidden': 'true',
              style: { display: 'inline-flex', flex: 'none', alignItems: 'center' },
            },
            scopeCaretGlyph(group.expanded, 12),
          ),
          h(
            'span',
            {
              key: 'label',
              'data-role': 'scope-group-label',
              title: group.path || undefined,
              style: {
                fontSize: 13,
                fontWeight: 600,
                flex: 'none',
                maxWidth: '40%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            label,
          ),
          group.path
            ? h(
                'span',
                {
                  key: 'path',
                  title: group.path,
                  style: { ...metaStyle, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                },
                group.path,
              )
            : null,
          h(
            'span',
            { key: 'count', 'data-role': 'scope-group-count', style: { ...metaStyle, flex: 'none' } },
            fmt(t('scopeSessions'), { n: group.total }),
          ),
        ),
      ];

      // The workspace's children: level-2 treeitems, in a group of their own.
      const rows = [];

      for (const row of group.sessions) {
        const selected = row.id === m.sessionArg;
        const rowHovered = m.scopeHover === `s:${row.id}`;
        const rowFocused = m.scopeFocus === `s:${row.id}`;
        rows.push(
          h(
            'button',
            {
              key: `s:${row.id}`,
              type: 'button',
              role: 'treeitem',
              'aria-level': 2,
              'data-role': 'session-row',
              'data-session-id': row.id,
              'data-scope-parent': group.key,
              'data-selected': String(selected),
              'data-session-running': String(row.running === true),
              'data-session-active': String(row.id === activeId && activeId !== ''),
              'data-hover': String(rowHovered),
              'data-focus': String(rowFocused),
              'aria-selected': selected,
              onClick: () => a.pickSession(row.id),
              onMouseEnter: () => a.setScopeHover(`s:${row.id}`),
              onMouseLeave: () => a.setScopeHover(''),
              onFocus: (event) => {
                if (focusVisibleOf(event)) a.setScopeFocus(`s:${row.id}`);
              },
              onBlur: () => a.setScopeFocus(''),
              style: {
                ...scopeRowStyle(rowHovered, rowFocused),
                font: 'inherit',
                fontSize: 12,
                lineHeight: '18px',
                textAlign: 'left',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 8px 3px 20px',
                color: token.labelPrimary,
                background: selected
                  ? token.diffAddFill
                  : row.id === activeId && activeId !== ''
                    ? token.diffAddFill
                    : rowHovered
                      ? token.hoverFill
                      : 'transparent',
                // The selected row is marked by a bar, not by text alone.
                boxShadow: selected ? `inset 3px 0 0 0 ${token.stateBusiness}` : undefined,
                border: `1px solid ${selected ? token.borderL2 : 'transparent'}`,
              },
            },
            selected
              ? h(
                  'span',
                  {
                    key: 'mark',
                    'data-role': 'session-selected-mark',
                    title: t('scopeSelected'),
                    style: { flex: 'none', color: token.stateBusiness, fontSize: 11 },
                  },
                  '✓',
                )
              : null,
            h(
              'span',
              { key: 'title', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              row.displayTitle || row.title || row.id,
            ),
            row.running === true
              ? h(
                  'span',
                  {
                    key: 'run',
                    'data-role': 'session-running',
                    title: t('scopeRunning'),
                    style: { flex: 'none', fontSize: 10, color: token.stateSuccess },
                  },
                  '●',
                )
              : null,
            row.cwd
              ? h(
                  'span',
                  {
                    key: 'cwd',
                    title: row.cwd,
                    style: {
                      ...metaStyle,
                      flex: 'none',
                      maxWidth: '45%',
                      marginLeft: 'auto',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                  },
                  row.cwd,
                )
              : null,
          ),
        );
      }

      if (group.more) {
        const moreHovered = m.scopeHover === `m:${group.key}`;
        const moreFocused = m.scopeFocus === `m:${group.key}`;
        rows.push(
          h(
            'button',
            {
              key: 'more',
              type: 'button',
              'data-action': 'scope-more',
              'data-scope-more': group.key,
              'data-hover': String(moreHovered),
              'data-focus': String(moreFocused),
              onClick: () => a.showMoreScope(group.key),
              onMouseEnter: () => a.setScopeHover(`m:${group.key}`),
              onMouseLeave: () => a.setScopeHover(''),
              onFocus: (event) => {
                if (focusVisibleOf(event)) a.setScopeFocus(`m:${group.key}`);
              },
              onBlur: () => a.setScopeFocus(''),
              style: {
                font: 'inherit',
                fontSize: 12,
                lineHeight: '18px',
                textAlign: 'left',
                padding: '2px 8px 2px 20px',
                color: token.stateBusiness,
                background: 'transparent',
                border: 'none',
                ...scopeRowStyle(moreHovered, moreFocused),
              },
            },
            fmt(t('scopeMore'), { n: group.matched - group.sessions.length }),
          ),
        );
      } else if (group.expanded && group.hidden > 0) {
        rows.push(
          h(
            'p',
            { key: 'cut', 'data-scope-cut': group.key, style: { margin: '2px 0 2px 20px', ...metaStyle } },
            fmt(t('scopeCut'), { n: group.hidden }),
          ),
        );
      }

      // The children live in a `group` named after the workspace, so a screen
      // reader can tell the level-2 rows apart from the next workspace's.
      if (rows.length > 0) {
        nodes.push(
          h(
            'div',
            {
              key: `g:${group.key}`,
              role: 'group',
              'aria-label': label,
              style: { display: 'flex', flexDirection: 'column', gap: 1, marginTop: -1 },
            },
            rows,
          ),
        );
      }

      return nodes;
    }

    /**
     * The tree branch of the「查看范围」picker: group nodes in sidebar order,
     * each with its windowed session rows, plus the honest notices (hidden
     * archived rows, suppressed groups, the global render cap) that explain why
     * a session is not on screen.
     *
     * The branch is a real ARIA tree (g-009): the container is `role="tree"`
     * and its direct children are only `treeitem` (a workspace, level 1) or
     * `group` (that workspace's sessions, level 2). The notices below the tree
     * are siblings of the tree container, never children of it.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the tree block element.
     */
    function scopeTreeElement(t, m, a) {
      const scope = m.scope;
      const active = m.sessionActive >= 0 ? m.sessionVisible[m.sessionActive] : undefined;
      const activeId = active ? active.id : '';
      const parts = [
        h(
          'div',
          {
            key: 'tree',
            role: 'tree',
            'aria-label': t('sessionHeading'),
            'data-region': 'session-tree',
            'data-scope-groups': String(scope.groups.length),
            'data-scope-rendered': String(scope.shown),
            style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 },
          },
          scope.groups.flatMap((group) => scopeGroupParts(t, m, a, group, activeId)),
        ),
        h(
          'p',
          { key: 'hint', 'data-role': 'scope-search-hint', style: { margin: '6px 0 0', ...metaStyle } },
          t('scopeSearchHint'),
        ),
      ];
      if (scope.archivedHidden > 0) {
        parts.push(
          h(
            'p',
            { key: 'archived', 'data-warning': 'scope-archived-hidden', style: { margin: '4px 0 0', ...metaStyle } },
            fmt(t('scopeArchivedHidden'), { n: scope.archivedHidden }),
          ),
        );
      }
      if (scope.groupsSuppressed > 0) {
        parts.push(
          h(
            'p',
            { key: 'groups-cut', 'data-warning': 'scope-groups-truncated', style: { margin: '4px 0 0', ...metaStyle } },
            t('scopeGroupsTruncated'),
          ),
        );
      }
      if (scope.truncated) {
        parts.push(
          h(
            'p',
            { key: 'cut', 'data-warning': 'scope-truncated', style: { margin: '4px 0 0', ...metaStyle } },
            fmt(t('scopeTruncated'), { n: SCOPE_TOTAL_MAX }),
          ),
        );
      }
      return h('div', { key: 'scope', style: { display: 'flex', flexDirection: 'column' } }, parts);
    }

    /**
     * The session selector body: pinned entries, a live search box, and a
     * strictly bounded result area — a workspace tree when the root
     * `useWorkspaces` hook is present, the flat searchable list when it is not.
     *
     * Since g-016 this is the *body* only: {@link scopeSection} wraps it in the
     * one-line summary, and the body is rendered while that summary's「更改」
     * switch is open. Everything inside is unchanged by the collapse — the same
     * markers, the same interaction, the same bounds.
     *
     * Requirement this shape comes from: the session catalog grows monotonically
     * with use, so a control that spreads every row open becomes unusable at
     * scale (and inflates the DOM). Therefore: the two pinned entries every
     * scope needs are always rendered, the tree renders at most
     * {@link SCOPE_TOTAL_MAX} session rows (see {@link deriveScope}), the flat
     * list at most {@link SESSION_MATCH_LIMIT}, and a query that matches nothing
     * falls back to "view this id" instead of forcing a long list.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the section element.
     */
    /**
     * The「查看范围」card and its collapse rule (g-016).
     *
     * The picker used to be spread open above the tab bar: measured in the real
     * settings shell (1440×900) the block was ~500px tall, which pushed
     * `data-region="tabs"` to y≈789 and `data-region="tab-panel"` past the 900px
     * fold — opening the page showed no tab content at all. So the block now
     * renders **one summary line** (the readable scope name, a state hint only
     * when the picker is degraded, and the「更改」switch) and the body is
     * rendered only while `m.scopeOpen` is true.
     *
     * `data-scope-open` on the section and `aria-expanded` / `data-expanded` on
     * the switch report the same state, the way the「设置 → 模型」row and this
     * plugin's own workspace header (g-012) do. `data-region="scope-summary"`
     * is the always-present row; every body marker (`session-pinned`,
     * `session-tree`, `session-list`, the search box, the help copy) is absent
     * while it is shut.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @param body - the picker body, rendered only while expanded.
     * @returns the section element.
     */
    function scopeSection(t, m, a, body) {
      const scoped = m.sessionArg !== null;
      const readable = scoped ? sessionLabelOf(m.seat.rows, m.sessionArg) || m.sessionArg : '';
      const summaryLabel = scoped ? fmt(t('sessionCurrentLabel'), { label: readable }) : t('sessionGlobal');
      // A hint only when the scope itself is worth a word: the two degraded
      // seats, which change what the picker can do at all. The healthy tree
      // case says nothing extra, so the line stays short by construction.
      const isTree = m.seat.mode !== 'manual' && m.scopeMode === 'tree' && m.scope !== null;
      const hintKey = m.seat.mode === 'manual' ? 'scopeSummaryManual' : isTree ? null : 'scopeSummaryFlat';
      const parts = [
        h('h3', { key: 'heading', style: headingStyle }, t('sessionHeading')),
        h('span', { key: 'label', 'data-role': 'scope-summary-label', style: scopeSummaryTextStyle }, summaryLabel),
      ];
      if (hintKey !== null) {
        parts.push(h('span', { key: 'hint', 'data-role': 'scope-summary-hint', style: scopeSummaryHintStyle }, t(hintKey)));
      }
      parts.push(
        h(
          UI.Button,
          {
            key: 'toggle',
            variant: 'outline',
            'data-action': 'scope-toggle',
            'data-expanded': String(m.scopeOpen),
            'aria-expanded': m.scopeOpen,
            onClick: a.toggleScopeOpen,
          },
          m.scopeOpen ? t('scopeCollapse') : t('scopeEdit'),
        ),
      );
      return h(
        'section',
        { 'data-region': 'session', 'data-scope-open': String(m.scopeOpen), style: cardStyle },
        h('div', { key: 'summary', 'data-region': 'scope-summary', style: scopeSummaryStyle }, parts),
        ...(m.scopeOpen ? body : []),
      );
    }

    function renderSession(t, m, a) {
      const seat = m.seat;
      if (seat.mode === 'manual') {
        return scopeSection(t, m, a, [
          h(
            'div',
            { style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h(UI.Input, {
              'data-role': 'session-manual',
              placeholder: t('sessionManualPlaceholder'),
              value: m.manualId,
              onChange: a.setManualId,
              style: { maxWidth: 320 },
            }),
            h(UI.Button, { variant: 'outline', 'data-action': 'session-apply', onClick: a.applyManual }, t('sessionApply')),
            h(UI.Button, { variant: 'outline', 'data-action': 'session-global', onClick: a.useGlobal }, t('sessionGlobal')),
          ),
          h(
            'p',
            {
              'data-warning': 'session-degraded',
              style: { margin: '8px 0 0', fontSize: 12, color: token.stateWarn, wordBreak: 'break-word' },
            },
            t('sessionLimit'),
          ),
          seat.reason === 'hook-threw'
            ? h('p', { style: { margin: '4px 0 0', ...metaStyle } }, `${t('errDetail')}: ${seat.message}`)
            : null,
          h(
            'p',
            { 'data-session-note': m.sessionArg === null ? 'global' : 'session', style: { margin: '8px 0 0', ...metaStyle } },
            m.sessionArg === null ? t('sessionGlobalNote') : t('sessionSelectedNote'),
          ),
        ]);
      }

      const rows = seat.rows;
      const currentId = seat.currentId;
      const currentLabel = sessionLabelOf(rows, currentId);
      const isTree = m.scopeMode === 'tree' && m.scope !== null;
      const total = isTree ? m.scope.total : rows.length;
      const matched = isTree ? m.scope.matched : m.sessionMatches.length;
      const shown = isTree ? m.scope.shown : m.sessionVisible.length;
      const scoped = m.sessionArg !== null;
      const selectedLabel = scoped ? sessionLabelOf(rows, m.sessionArg) || m.sessionArg : t('sessionGlobal');

      const children = [
        // Pinned entries: always present, never filtered away, and — like the
        // group rows — visibly clickable and visibly selected.
        h(
          'div',
          { key: 'pinned', 'data-region': 'session-pinned', style: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' } },
          pinnedSessionButton(
            t,
            'global',
            t('sessionGlobal'),
            !scoped,
            false,
            m.scopeHover === 'p:global',
            m.scopeFocus === 'p:global',
            a.useGlobal,
            (on) => a.setScopeHover(on ? 'p:global' : ''),
            (on) => a.setScopeFocus(on ? 'p:global' : ''),
          ),
          pinnedSessionButton(
            t,
            'current',
            currentLabel ? fmt(t('sessionCurrentLabel'), { label: currentLabel }) : t('sessionCurrent'),
            scoped && m.sessionArg === currentId,
            currentId.length === 0,
            m.scopeHover === 'p:current',
            m.scopeFocus === 'p:current',
            a.useCurrent,
            (on) => a.setScopeHover(on ? 'p:current' : ''),
            (on) => a.setScopeFocus(on ? 'p:current' : ''),
          ),
        ),
        h(
          'div',
          { key: 'current', 'data-role': 'session-current', style: { marginTop: 8, ...metaStyle, wordBreak: 'break-word' } },
          fmt(t('sessionCurrentLabel'), { label: selectedLabel }),
        ),
        h(
          'label',
          { key: 'search', style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 420 } },
          h('span', { style: metaStyle }, t('sessionSearch')),
          h(UI.Input, {
            'data-role': 'session-search',
            value: m.sessionQuery,
            placeholder: currentLabel ? fmt(t('sessionCurrentLabel'), { label: currentLabel }) : t('sessionSearch'),
            onChange: a.setSessionQuery,
            onKeyDown: a.onSessionKeyDown,
          }),
        ),
        h(
          'div',
          {
            key: 'counts',
            'data-session-shown': String(shown),
            'data-session-matched': String(matched),
            'data-session-total': String(total),
            style: { marginTop: 6, ...metaStyle },
          },
          fmt(t('sessionMatches'), { shown, matched, total }),
        ),
      ];

      if (isTree) {
        children.push(scopeTreeElement(t, m, a));
      } else {
        children.push(
          h(
            'div',
            {
              key: 'list',
              role: 'listbox',
              'aria-label': t('sessionHeading'),
              'data-region': 'session-list',
              style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 },
            },
            m.sessionVisible.map((row, index) => {
              const selected = row.id === m.sessionArg;
              const hovered = m.scopeHover === `s:${row.id}`;
              const focused = m.scopeFocus === `s:${row.id}`;
              return h(
                'button',
                {
                  key: row.id,
                  type: 'button',
                  role: 'option',
                  'data-role': 'session-option',
                  'data-session-id': row.id,
                  'data-selected': String(selected),
                  'data-session-active': String(index === m.sessionActive),
                  'data-hover': String(hovered),
                  'data-focus': String(focused),
                  'aria-selected': selected,
                  onClick: () => a.pickSession(row.id),
                  onMouseEnter: () => a.setScopeHover(`s:${row.id}`),
                  onMouseLeave: () => a.setScopeHover(''),
                  onFocus: (event) => {
                    if (focusVisibleOf(event)) a.setScopeFocus(`s:${row.id}`);
                  },
                  onBlur: () => a.setScopeFocus(''),
                  style: {
                    ...scopeRowStyle(hovered, focused),
                    font: 'inherit',
                    fontSize: 12,
                    lineHeight: '18px',
                    textAlign: 'left',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 8px',
                    color: token.labelPrimary,
                    background:
                      selected || index === m.sessionActive
                        ? token.diffAddFill
                        : hovered
                          ? token.hoverFill
                          : 'transparent',
                    boxShadow: selected ? `inset 3px 0 0 0 ${token.stateBusiness}` : undefined,
                    border: `1px solid ${selected ? token.borderL2 : 'transparent'}`,
                  },
                },
                selected
                  ? h(
                      'span',
                      {
                        key: 'mark',
                        'data-role': 'session-selected-mark',
                        title: t('scopeSelected'),
                        style: { flex: 'none', color: token.stateBusiness, fontSize: 11 },
                      },
                      '✓',
                    )
                  : null,
                h('span', { key: 'label', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sessionRowLabel(row)),
              );
            }),
          ),
        );
      }

      // No match ⇒ the typed text is a session id, not a dead end.
      if (matched === 0 && m.sessionQuery.trim().length > 0) {
        children.push(
          h(
            'div',
            {
              key: 'no-match',
              'data-warning': 'session-no-match',
              style: { marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
            },
            h('span', { style: metaStyle }, t('sessionNoMatch')),
            h(
              'button',
              {
                type: 'button',
                'data-action': 'session-use-input',
                'data-session-id': m.sessionQuery.trim(),
                onClick: a.useTypedId,
                style: {
                  font: 'inherit',
                  fontSize: 12,
                  lineHeight: '18px',
                  padding: '3px 10px',
                  borderRadius: 999,
                  cursor: 'pointer',
                  color: token.labelPrimary,
                  background: 'transparent',
                  border: `1px solid ${token.borderL2}`,
                },
              },
              fmt(t('sessionUseInput'), { id: m.sessionQuery.trim() }),
            ),
          ),
        );
      }
      if (total === 0) {
        children.push(h('p', { key: 'empty', style: { margin: '6px 0 0', ...metaStyle } }, t('sessionEmpty')));
      }
      if (!isTree) {
        // The flat list is a degradation, not a silent difference: say it.
        children.push(
          h(
            'p',
            { key: 'degraded', 'data-warning': 'scope-degraded', style: { margin: '6px 0 0', ...metaStyle } },
            t('scopeDegraded'),
          ),
        );
      }
      children.push(
        h('p', { key: 'keys', style: { margin: '6px 0 0', ...metaStyle } }, t('sessionKeyboardHint')),
        h(
          'p',
          { key: 'note', 'data-session-note': scoped ? 'session' : 'global', style: { margin: '6px 0 0', ...metaStyle } },
          scoped ? t('sessionSelectedNote') : t('sessionGlobalNote'),
        ),
      );

      return scopeSection(t, m, a, children);
    }

    /**
     * Filter tabs for the section view.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the filter block element.
     */
    function renderFilters(t, m, a) {
      const group = (key, heading, values, selected, onPick) =>
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: metaStyle }, heading),
          tabs(
            values.map((value) => ({
              value,
              label: t(filterLabelKey(value)),
              id: `ps-${key}-${value}`,
              panelId: 'ps-panel',
            })),
            selected,
            onPick,
            heading,
            key,
          ),
        );
      return h(
        'div',
        { 'data-region': 'filters', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('span', { style: { ...metaStyle, fontWeight: 600 } }, t('filterHeading')),
        group('layer', t('filterLayer'), LAYER_FILTERS, m.filters.layer, a.setLayerFilter),
        group('overridable', t('filterOverridable'), OVERRIDABLE_FILTERS, m.filters.overridable, a.setOverridableFilter),
        group('origin', t('filterOrigin'), ORIGIN_FILTERS, m.filters.origin, a.setOriginFilter),
      );
    }

    /**
     * One section row of the read-only overview.
     *
     * Since g-015 this row has **no write entry at all**: the Revision 6
     * 「编辑」 switch, the row-scoped form it opened and the 新增一段 entry are
     * gone (the only write surface left is 「我的 Prompt」, which writes the one
     * name the Revision 7 contract accepts). What remains is what a reader
     * needs: the identity of the segment, its origin/layer/overridable verdict,
     * the action that produced the effective text, the reason an override did
     * not take effect when the client can prove it, and a disclosure that shows
     * the full text. `data-warning="edit-disabled"` — the gate that used to
     * disable the edit button — is kept as a *statement* rather than a switch:
     * the same {@link editGate} verdict, read-only.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @param section - the `effective.sections` entry.
     * @returns the row element.
     */
    function sectionRow(t, m, a, section) {
      const origin = originOf(section);
      const layer = sectionLayer(section);
      const overridable = section.overridable === true;
      const gate = editGate(section, m.fz, t);
      const text = typeof section.text === 'string' ? section.text : '';
      const expanded = m.expanded === section.name;
      const cause = ineffectiveCause(t, section, m.incoming);
      const showHint = origin === 'downstream-added' || origin === 'unmatched-override';
      // What the effective text *is*, in the vocabulary the goal asked for:
      // 已覆盖 / 已隐藏 / 追加, or nothing when the section is untouched. It is
      // read off `section.action` — the action the assembly really applied —
      // so a row cannot claim a state the override engine did not produce.
      const statusKey =
        section.action === 'replace' ? 'ovEffective' : section.action === 'hide' ? 'stHidden' : section.action === 'append' ? 'stAppended' : null;
      return h(
        'div',
        {
          'data-section-row': section.name,
          'data-section-name': section.name,
          'data-origin': origin,
          'data-layer': layer,
          'data-overridable': String(overridable),
          'data-applied': String(section.applied === true),
          'data-index': section.index === null || section.index === undefined ? '' : String(section.index),
          style: {
            border: `1px solid ${token.borderL1}`,
            borderRadius: 8,
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          },
        },
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('code', { style: { fontSize: 12, color: token.labelPrimary } }, section.name),
          h('span', { style: metaStyle }, `#${section.index === null || section.index === undefined ? '—' : section.index}`),
          h(UI.Tag, { tone: originTone(origin) }, t(originKey(origin))),
          h(UI.Tag, { tone: layer === 'default' ? 'neutral' : 'info' }, t(layerKey(layer))),
          h(UI.Tag, { tone: overridable ? 'success' : 'warning' }, overridable ? t('fYes') : t('fNo')),
          statusKey === null ? null : h(UI.Tag, { tone: 'info' }, t(statusKey)),
          section.action ? h(UI.Tag, { tone: 'neutral' }, String(section.action)) : null,
          h('span', { style: metaStyle }, fmt(t('colChars'), { n: text.length })),
        ),
        section.reason
          ? h(
              'div',
              { 'data-section-reason': section.name, style: { fontSize: 12, color: token.stateWarn, wordBreak: 'break-word' } },
              `${t('colReason')}: ${String(section.reason)}`,
            )
          : null,
        showHint
          ? h('div', { style: { fontSize: 12, color: token.labelTertiary } }, t(origin === 'downstream-added' ? 'originDownstreamHint' : 'originUnmatchedHint'))
          : null,
        cause === null
          ? null
          : h(
              'div',
              {
                'data-section-ineffective': cause.code,
                style: { fontSize: 12, color: token.stateWarn, wordBreak: 'break-word' },
              },
              `${t('ovReason')}: ${cause.text} ${t('ovFixHint')}`,
            ),
        // The gate is reported, not enforced: this list cannot write, so the
        // honest thing to render is why a write here *would* not take effect.
        gate.reasons.length === 0
          ? null
          : h(
              'div',
              {
                'data-warning': 'edit-disabled',
                style: { fontSize: 12, color: token.stateError, wordBreak: 'break-word' },
              },
              gate.reasons.join(' '),
            ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(
            'button',
            {
              type: 'button',
              'data-action': 'expand',
              'data-section-name': section.name,
              'aria-expanded': String(expanded),
              onClick: () => a.toggleExpanded(section.name),
              style: {
                font: 'inherit',
                fontSize: 12,
                padding: '2px 8px',
                borderRadius: 6,
                cursor: 'pointer',
                color: token.labelSecondary,
                background: 'transparent',
                border: `1px solid ${token.borderL2}`,
              },
            },
            expanded ? t('collapse') : t('expand'),
          ),
        ),
        expanded
          ? h(
              'pre',
              {
                'data-section-full': section.name,
                style: {
                  margin: 0,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: `1px solid ${token.borderL2}`,
                  fontSize: 12,
                  lineHeight: '18px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 320,
                  overflow: 'auto',
                  color: token.labelSecondary,
                  fontFamily: token.mono,
                },
              },
              text,
            )
          : null,
      );
    }

    /**
     * The read-only segment list — the `sections` view of 「提示词总览」.
     *
     * Read-only by construction: there is no editor slot (the parameter is
     * gone, so no caller could hand one in) and no 「新增一段」 entry. The two
     * controls that remain are `copy` (the assembled text, which is what the
     * overview tab promises) and the per-row `expand` disclosure.
     *
     * The reserved section itself is deliberately **not** listed here: it is
     * what 「我的 Prompt」 owns, and showing the same text twice on one page is
     * exactly the confusion the split exists to remove. A one-line note says so
     * whenever the reserved section is actually in the assembly.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the view element.
     */
    function renderSectionsView(t, m, a) {
      const all = m.effectiveSections;
      const sections = all.filter((section) => section.name !== RESERVED_SECTION_NAME);
      const shown = sections.filter((section) => m.passesFilters(section));
      return h(
        'div',
        { 'data-region': 'sections', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        renderFilters(t, m, a),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(
            'span',
            {
              'data-sections-total': String(sections.length),
              'data-sections-shown': String(shown.length),
              style: { ...metaStyle },
            },
            fmt(t('sectionsShown'), { shown: shown.length, total: sections.length }),
          ),
          h(UI.Button, { variant: 'outline', 'data-action': 'copy', onClick: a.copy }, t('copy')),
        ),
        h('p', { 'data-note': 'reserved-own-tab', style: { margin: 0, ...metaStyle } }, t('overviewReservedNote')),
        sections.length === 0
          ? h(
              'div',
              { 'data-empty': 'sections', style: cardStyle },
              h('strong', { style: { fontSize: 13 } }, t('emptyTitle')),
              h('p', { style: { margin: '4px 0 0', ...metaStyle } }, t('emptyBody')),
            )
          : null,
        shown.map((section) => h('div', { key: section.name }, sectionRow(t, m, a, section))),
      );
    }

    /**
     * The full-text view: `rendered`, search highlight, unresolved warning,
     * and the `base` ↔ `effective` comparison.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the view element.
     */
    function renderFullView(t, m, a) {
      const snapshot = m.snap.data;
      const sections = m.effectiveSections;
      const baseSections = snapshot && snapshot.base && Array.isArray(snapshot.base.sections) ? snapshot.base.sections : [];
      const resolved = snapshot ? snapshot.renderedResolved !== false : true;
      const unresolved = snapshot && Array.isArray(snapshot.unresolvedVariables) ? snapshot.unresolvedVariables : [];
      // The server grades an unresolved reference by what it does to the REAL
      // assembly: one in a section that interpolates makes it throw, one in a
      // section that does not reaches the model as literal braces. Only the
      // throwing list is a fault, so only it is a warning. A payload that
      // predates the grading carries neither list; then the single legacy list
      // is read as the throwing one, which is the safe reading.
      const graded = snapshot ? Array.isArray(snapshot.unresolvedThrowing) || Array.isArray(snapshot.unresolvedLiteral) : false;
      const throwing = snapshot && Array.isArray(snapshot.unresolvedThrowing) ? snapshot.unresolvedThrowing : unresolved;
      const literal = snapshot && Array.isArray(snapshot.unresolvedLiteral) ? snapshot.unresolvedLiteral : [];
      const names = (list) => list.map((name) => String(name)).join(', ');
      // Machine-readable attributes keep the original comma-separated shape.
      const marks = (list) => list.map((name) => String(name)).join(',');
      const text =
        m.fullOrigin === 'all' ? String(snapshot && snapshot.rendered ? snapshot.rendered : '') : composeSections(sections, m.fullOrigin);
      const lines = splitLines(text);
      const truncated = lines.length > MAX_VIEW_LINES;
      const shownText = (truncated ? lines.slice(0, MAX_VIEW_LINES) : lines).join('\n');
      const hits = countMatches(shownText, m.search);
      const diffRows = diffSections(baseSections, sections);
      const changed = diffRows.filter((row) => row.status !== 'same').length;

      return h(
        'div',
        { 'data-region': 'full', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        throwing.length > 0
          ? h(
              'div',
              {
                'data-warning': 'rendered-unresolved',
                'data-unresolved-variables': marks(unresolved),
                'data-unresolved-throwing': marks(throwing),
                'data-unresolved-literal': marks(literal),
                style: { ...cardStyle, borderColor: token.stateWarn },
              },
              h('strong', { style: { fontSize: 13, color: token.stateWarn } }, t('unresolvedTitle')),
              h(
                'div',
                { style: { marginTop: 4, fontSize: 13, color: token.labelPrimary } },
                fmt(t('unresolvedBody'), { list: names(throwing) }),
              ),
              h('p', { style: { margin: '4px 0 0', ...metaStyle } }, t('unresolvedNote')),
              literal.length > 0
                ? h(
                    'p',
                    { 'data-note': 'rendered-literal-inline', style: { margin: '4px 0 0', ...metaStyle } },
                    fmt(t('unresolvedLiteralInline'), { list: names(literal) }),
                  )
                : null,
            )
          : graded && literal.length > 0
            ? h(
                'div',
                {
                  'data-note': 'rendered-literal',
                  'data-unresolved-variables': marks(unresolved),
                  'data-unresolved-literal': marks(literal),
                  style: cardStyle,
                },
                h('strong', { style: { fontSize: 13, color: token.labelPrimary } }, t('unresolvedLiteralTitle')),
                h(
                  'div',
                  { style: { marginTop: 4, fontSize: 13, color: token.labelPrimary } },
                  fmt(t('unresolvedLiteralBody'), { list: names(literal) }),
                ),
                h('p', { style: { margin: '4px 0 0', ...metaStyle } }, t('unresolvedLiteralNote')),
              )
            : null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('h3', { style: headingStyle }, t('fullHeading')),
          h(UI.Button, { variant: 'outline', 'data-action': 'copy', onClick: a.copy }, t('copy')),
          h(UI.Input, {
            'data-role': 'search',
            placeholder: t('searchPlaceholder'),
            value: m.search,
            onChange: a.setSearch,
            style: { maxWidth: 280 },
          }),
          h('span', { 'data-search-count': String(hits), style: metaStyle }, hits > 0 ? fmt(t('searchCount'), { n: hits }) : t('searchNone')),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: metaStyle }, t('filterOrigin')),
          tabs(
            ORIGIN_FILTERS.map((value) => ({
              value,
              label: t(value === 'all' ? 'fAll' : originKey(value)),
              id: `ps-full-${value}`,
              panelId: 'ps-full-panel',
            })),
            m.fullOrigin,
            a.setFullOrigin,
            t('filterOrigin'),
            'full-origin',
          ),
        ),
        m.fullOrigin === 'all'
          ? null
          : h('p', { 'data-warning': 'full-filtered', style: { margin: 0, ...metaStyle } }, t('fullFiltered')),
        truncated
          ? h('p', { 'data-warning': 'truncated', style: { margin: 0, ...metaStyle } }, fmt(t('truncated'), { n: MAX_VIEW_LINES }))
          : null,
        h(
          'pre',
          {
            'data-full-text': m.fullOrigin === 'all' ? 'rendered' : 'filtered',
            'data-rendered-resolved': String(resolved),
            style: {
              margin: 0,
              padding: '10px 12px',
              borderRadius: 8,
              border: `1px solid ${token.borderL2}`,
              fontSize: 12,
              lineHeight: '18px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 460,
              overflow: 'auto',
              color: token.labelSecondary,
              fontFamily: token.mono,
            },
          },
          highlightNodes(shownText, m.search),
        ),
        h('h3', { style: { ...headingStyle, marginTop: 4 } }, t('diffHeading')),
        h('p', { style: { margin: 0, ...metaStyle } }, t('diffHint')),
        h(
          'div',
          {
            'data-region': 'diff',
            'data-diff-changed': String(changed),
            'data-diff-total': String(diffRows.length),
            style: { display: 'flex', flexDirection: 'column', gap: 6 },
          },
          diffRows.map((row) => {
            const pair = row.base && row.effective ? chunkDiff(row.base.text, row.effective.text) : null;
            return h(
              'div',
              {
                key: row.name,
                'data-diff-row': row.name,
                'data-diff-status': row.status,
                style: {
                  border: `1px solid ${row.status === 'same' ? token.borderL1 : token.stateWarn}`,
                  borderRadius: 8,
                  padding: '6px 10px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                },
              },
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('code', { style: { fontSize: 12 } }, row.name),
                h(UI.Tag, { tone: diffTone(row.status) }, t(diffKey(row.status))),
                h('span', { style: metaStyle }, fmt(t('colChars'), { n: row.effective ? String(row.effective.text || '').length : 0 })),
              ),
              row.status === 'changed' && pair
                ? h(
                    'pre',
                    {
                      'data-diff-detail': row.name,
                      style: {
                        margin: 0,
                        padding: '6px 8px',
                        borderRadius: 6,
                        fontSize: 12,
                        lineHeight: '18px',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        maxHeight: 220,
                        overflow: 'auto',
                        fontFamily: token.mono,
                      },
                    },
                    pair.base.length > 0
                      ? h(
                          'span',
                          { 'data-diff-line': 'base', style: { background: token.diffDelFill, display: 'block' } },
                          pair.base.join('\n'),
                        )
                      : null,
                    pair.effective.length > 0
                      ? h(
                          'span',
                          { 'data-diff-line': 'effective', style: { background: token.diffAddFill, display: 'block' } },
                          pair.effective.join('\n'),
                        )
                      : null,
                  )
                : null,
            );
          }),
        ),
      );
    }

    /**
     * The override-management view.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the view element.
     */
    /**
     * Render one history row, plus the two selectors that feed the comparison.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @param record - one history record.
     * @returns the row element.
     */
    function historyRow(t, m, a, record) {
      const id = String(record.id);
      const selected = m.diffSel.from === id ? 'from' : m.diffSel.to === id ? 'to' : '';
      const sideStyle = {
        font: 'inherit',
        fontSize: 12,
        padding: '2px 8px',
        borderRadius: 6,
        cursor: 'pointer',
        background: 'transparent',
        color: token.labelSecondary,
        border: `1px solid ${token.borderL2}`,
      };
      return h(
        'div',
        {
          key: id,
          'data-history-row': id,
          'data-history-action': record.action,
          'data-history-name': record.name === null ? '' : String(record.name),
          'data-history-origin': record.origin,
          'data-history-layer': record.layer,
          'data-history-selected': selected,
          style: {
            border: `1px solid ${selected === '' ? token.borderL1 : token.stateBusiness}`,
            borderRadius: 8,
            padding: '6px 8px',
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            flexWrap: 'wrap',
          },
        },
        h('code', { style: { fontSize: 12 } }, `#${id}`),
        h(UI.Tag, { tone: 'neutral' }, historyActionLabel(t, record.action)),
        h('code', { style: { fontSize: 12 } }, record.name === null ? t('histWholeLayer') : String(record.name)),
        h('span', { style: metaStyle }, stampOf(record.at)),
        record.origin === 'import' ? h(UI.Tag, { tone: 'warning' }, 'import') : null,
        record.entries !== null && Array.isArray(record.entries)
          ? h('span', { 'data-history-entries': String(record.entries.length), style: metaStyle }, `entries=${record.entries.length}`)
          : null,
        h(
          'button',
          {
            type: 'button',
            'data-action': 'diff-from',
            'data-history-id': id,
            disabled: selected === 'from',
            onClick: () => a.pickDiffSide('from', id),
            style: sideStyle,
          },
          t('histPickFrom'),
        ),
        h(
          'button',
          {
            type: 'button',
            'data-action': 'diff-to',
            'data-history-id': id,
            disabled: selected === 'to',
            onClick: () => a.pickDiffSide('to', id),
            style: sideStyle,
          },
          t('histPickTo'),
        ),
      );
    }

    /**
     * Render the line-level diff: the primitives `DiffBlock` when it is really
     * available, and a readable hand-built rendering of the host's own ops when
     * it is not. Both paths show the SAME comparison — the fallback is not a
     * second diff algorithm, it is a second renderer for the same result.
     * @param t - the bound translator.
     * @param lines - `diff.lines` from the host.
     * @returns the element.
     */
    function renderDiffLines(t, lines) {
      const ops = Array.isArray(lines.ops) ? lines.ops : [];
      if (HAS_DIFF_BLOCK) {
        return h(
          'div',
          { 'data-region': 'diffblock', 'data-diff-block': 'primitives' },
          h(primitives.DiffBlock, {
            diffs: [{
              path: lines.name,
              oldText: typeof lines.textBefore === 'string' ? lines.textBefore : '',
              newText: typeof lines.textAfter === 'string' ? lines.textAfter : '',
            }],
            labels: diffBlockLabels(t),
            maxLines: DIFF_BLOCK_MAX_LINES,
          }),
        );
      }
      const shown = ops.slice(0, MAX_DIFF_LINES_SHOWN);
      const cut = shown.length < ops.length || lines.truncated === true;
      return h(
        'div',
        {
          'data-region': 'diffblock',
          'data-diff-block': 'fallback',
          'data-diff-ops': String(ops.length),
          'data-diff-ops-shown': String(shown.length),
        },
        h(
          'div',
          {
            style: {
              font: `12px/18px ${token.mono}`,
              maxHeight: 320,
              overflow: 'auto',
              border: `1px solid ${token.borderL1}`,
              borderRadius: 8,
              padding: '6px 8px',
            },
          },
          shown.map((op, index) =>
            h(
              'div',
              {
                key: `op-${index}`,
                'data-diff-op': op.type,
                'data-diff-op-text': op.text,
                'data-diff-op-before-line': op.beforeLine === null ? '' : String(op.beforeLine),
                'data-diff-op-after-line': op.afterLine === null ? '' : String(op.afterLine),
                style: {
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: op.type === 'insert' ? token.diffAddFill : op.type === 'delete' ? token.diffDelFill : 'transparent',
                },
              },
              `${diffOpMarker(op.type)} ${op.text}`,
            ),
          ),
        ),
        cut ? h('div', { 'data-diff-cut': 'true', style: metaStyle }, fmt(t('histDiffTruncated'), { n: shown.length })) : null,
      );
    }

    /**
     * Render the version comparison result.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the panel element.
     */
    function renderDiffPanel(t, m, a) {
      const label = (value) => (value === null || value === undefined
        ? '—'
        : value === DIFF_CURRENT ? t('histCurrent') : `#${value}`);
      const children = [
        h('h4', { key: 'heading', style: { margin: 0, fontSize: 13, fontWeight: 600 } }, t('histDiffHeading')),
        h('p', { key: 'hint', style: { margin: 0, ...metaStyle } }, t('histDiffHint')),
        h(
          'div',
          { key: 'selection', style: metaStyle },
          h('span', { 'data-diff-from': m.diffSel.from === null ? '' : String(m.diffSel.from) }, `${t('histDiffFrom')}: ${label(m.diffSel.from)}`),
          ' · ',
          h('span', { 'data-diff-to': m.diffSel.to === null ? '' : String(m.diffSel.to) }, `${t('histDiffTo')}: ${label(m.diffSel.to)}`),
        ),
      ];
      if (m.diff.phase === 'loading') children.push(h('p', { key: 'loading', style: metaStyle }, t('loading')));
      if (m.diff.phase === 'error') children.push(h('div', { key: 'error' }, errorBanner(t, m.diff.error, t('histDiffUnavailable'))));
      const data = m.diff.data;
      if (data) {
        const counts = data.sectionsCounts || {};
        children.push(
          h(
            'div',
            {
              key: 'counts',
              'data-diff-sections': String(counts.total === undefined ? 0 : counts.total),
              'data-diff-changed': String(counts.changed === undefined ? 0 : counts.changed),
              'data-diff-added': String(counts.added === undefined ? 0 : counts.added),
              'data-diff-removed': String(counts.removed === undefined ? 0 : counts.removed),
              'data-diff-same': String(counts.same === undefined ? 0 : counts.same),
              style: metaStyle,
            },
            fmt(t('histDiffSections'), {
              total: counts.total === undefined ? 0 : counts.total,
              changed: counts.changed === undefined ? 0 : counts.changed,
              added: counts.added === undefined ? 0 : counts.added,
              removed: counts.removed === undefined ? 0 : counts.removed,
              same: counts.same === undefined ? 0 : counts.same,
            }),
          ),
        );
        const rows = Array.isArray(data.sections) ? data.sections : [];
        children.push(
          h(
            'div',
            { key: 'rows', 'data-diff-row-total': String(rows.length), style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            rows.map((row) =>
              h(
                'div',
                {
                  key: row.name,
                  'data-hd-row': row.name,
                  'data-hd-status': row.status,
                  style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
                },
                h('code', { style: { fontSize: 12 } }, row.name),
                h(UI.Tag, { tone: diffTone(row.status) }, t(diffKey(row.status))),
                h('span', { style: metaStyle }, `${row.before ? row.before.action : '—'} → ${row.after ? row.after.action : '—'}`),
              ),
            ),
          ),
        );
        const lines = data.lines;
        if (lines === null || lines === undefined) {
          children.push(
            h('p', { key: 'no-lines', 'data-diff-no-lines': 'true', style: metaStyle }, fmt(t('histDiffNoLines'), { reason: data.lineReason || '' })),
          );
        } else {
          children.push(
            h(
              'div',
              {
                key: 'line-meta',
                'data-diff-line-name': lines.name,
                'data-diff-mode': lines.mode,
                'data-diff-line-added': String(lines.stats.added),
                'data-diff-line-removed': String(lines.stats.removed),
                'data-diff-renderer': HAS_DIFF_BLOCK ? 'diffblock' : 'fallback',
                style: metaStyle,
              },
              fmt(t('histDiffLineStats'), {
                added: lines.stats.added,
                removed: lines.stats.removed,
                mode: lines.mode === 'lcs' ? t('histDiffModeLcs') : t('histDiffModeBounded'),
              }),
              h('span', { style: { marginLeft: 8 } }, HAS_DIFF_BLOCK ? t('histDiffBlock') : t('histDiffFallback')),
            ),
          );
          if (lines.crlfNormalized === true) {
            children.push(h('p', { key: 'crlf', 'data-diff-crlf': 'true', style: metaStyle }, t('histDiffCrlf')));
          }
          children.push(h('div', { key: 'lines' }, renderDiffLines(t, lines)));
        }
      }
      return h(
        'div',
        {
          'data-region': 'history-diff',
          'data-diff-state': m.diff.phase,
          style: { ...cardStyle, display: 'flex', flexDirection: 'column', gap: 6 },
        },
        children,
      );
    }

    /**
     * Render the history panel: layer selector, records, and the comparison.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the panel element.
     */
    function renderHistoryPanel(t, m, a) {
      const data = m.hist.data;
      const records = data && Array.isArray(data.records) ? data.records : [];
      const layer = m.historyLayer;
      const children = [
        h('h3', { key: 'heading', style: headingStyle }, t('histHeading')),
        h('p', { key: 'note', style: { margin: 0, ...metaStyle } }, fmt(t('histNote'), { limit: data && data.retentionLimit ? data.retentionLimit : '' })),
        h(
          'div',
          { key: 'layer', 'data-region': 'history-layer' },
          tabs(
            ['user', 'workspace'].map((value) => ({
              value,
              label: layerLabel(t, value),
              id: `ps-hist-${value}`,
              panelId: 'ps-hist-panel',
            })),
            layer,
            a.setHistoryLayer,
            t('histLayerLabel'),
            'history-layer',
          ),
        ),
      ];
      if (m.hist.phase === 'loading' && !data) children.push(h('p', { key: 'loading', style: metaStyle }, t('loading')));
      if (m.hist.phase === 'error') children.push(h('div', { key: 'error' }, errorBanner(t, m.hist.error, t('histHeading'))));
      if (layer === 'workspace' && m.sessionArg === null) {
        children.push(h('p', { key: 'no-session', 'data-history-note': 'no-session', style: { ...metaStyle, color: token.stateWarn } }, t('histNoSession')));
      }
      if (data) {
        children.push(
          h(
            'div',
            { key: 'meta', 'data-history-total': String(data.total), 'data-history-corrupt': String(data.corrupt), style: metaStyle },
            fmt(t('histTotal'), { n: data.total }),
            data.corrupt > 0 ? ` · ${fmt(t('histCorrupt'), { n: data.corrupt })}` : null,
            data.unreadable ? h('div', { 'data-history-unreadable': 'true', style: { color: token.stateError } }, fmt(t('histUnreadable'), { reason: data.unreadable })) : null,
            data.lastError ? h('div', { 'data-history-last-error': 'true', style: { color: token.stateError } }, fmt(t('histLastError'), { reason: data.lastError.reason })) : null,
          ),
        );
        children.push(
          h(
            'div',
            { key: 'rows', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            records.length === 0 ? h('div', { 'data-empty': 'history', style: metaStyle }, t('histEmpty')) : null,
            records.map((record) => historyRow(t, m, a, record)),
            h(
              'div',
              {
                key: 'current',
                'data-history-row': 'current',
                'data-history-current': 'true',
                'data-history-selected': m.diffSel.from === DIFF_CURRENT ? 'from' : m.diffSel.to === DIFF_CURRENT ? 'to' : '',
                style: { border: `1px dashed ${token.borderL2}`, borderRadius: 8, padding: '6px 8px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
              },
              h(UI.Tag, { tone: 'info' }, t('histCurrent')),
              h(
                'button',
                {
                  type: 'button',
                  'data-action': 'diff-from',
                  'data-history-id': DIFF_CURRENT,
                  onClick: () => a.pickDiffSide('from', DIFF_CURRENT),
                  style: { font: 'inherit', fontSize: 12, padding: '2px 8px', borderRadius: 6, cursor: 'pointer', background: 'transparent', color: token.labelSecondary, border: `1px solid ${token.borderL2}` },
                },
                t('histPickFrom'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  'data-action': 'diff-to',
                  'data-history-id': DIFF_CURRENT,
                  onClick: () => a.pickDiffSide('to', DIFF_CURRENT),
                  style: { font: 'inherit', fontSize: 12, padding: '2px 8px', borderRadius: 6, cursor: 'pointer', background: 'transparent', color: token.labelSecondary, border: `1px solid ${token.borderL2}` },
                },
                t('histPickTo'),
              ),
            ),
          ),
        );
      }
      return h(
        'div',
        {
          'data-region': 'history',
          'data-history-layer': layer,
          'data-history-state': m.hist.phase,
          style: { ...cardStyle, display: 'flex', flexDirection: 'column', gap: 6 },
        },
        children,
        renderDiffPanel(t, m, a),
      );
    }

    /**
     * The two layer-wide destructive controls of 「高级」, each with its impact
     * stated before the click.
     *
     * They are deliberately side by side, because the difference between them
     * is the whole point: `reset=true` clears the layer *including* 「我的
     * Prompt」, while `legacy=true` clears only the frozen Revision 6/7
     * overrides and **keeps** 「我的 Prompt」 (CONTRACT.md §12.2) — the way back
     * from a frozen read-only layer without hand-editing a file. Neither may
     * fire without its own second confirmation.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the panel element.
     */
    function renderLayerReset(t, m, a) {
      const layer = m.advancedLayer;
      const view = m.ovs.data ? m.ovs.data[layer] : null;
      const list = view && Array.isArray(view.overrides) ? view.overrides : [];
      const frozen = list.filter((entry) => entry && entry.name !== RESERVED_SECTION_NAME).length;
      const reserved = list.length - frozen;
      return h(
        'div',
        {
          'data-region': 'layer-reset',
          'data-reset-layer': layer,
          'data-reset-count': String(list.length),
          'data-reset-frozen-count': String(frozen),
          'data-reset-reserved-count': String(reserved),
          style: { border: `1px solid ${token.borderL1}`, borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 },
        },
        h('h4', { style: { margin: 0, fontSize: 13, fontWeight: 600 } }, t('resetLayersLabel')),
        h(
          'div',
          { 'data-region': 'advanced-layer' },
          tabs(
            LAYERS.map((value) => ({
              value,
              label: layerLabel(t, value),
              id: `ps-adv-${value}`,
              panelId: 'ps-adv-panel',
            })),
            layer,
            a.setAdvancedLayer,
            t('histLayerLabel'),
            'advanced-layer',
          ),
        ),
        h('p', { style: { margin: 0, ...metaStyle } }, fmt(t('resetLayerBody'), { layer: layerLabel(t, layer), count: list.length })),
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h(
            UI.Button,
            {
              'data-action': 'legacy-clear',
              'data-layer': layer,
              disabled: m.busy,
              onClick: () => a.requestLegacyClear(layer, frozen),
            },
            t('resetLegacyButton'),
          ),
          h(
            UI.Button,
            {
              'data-action': 'reset-layer',
              'data-layer': layer,
              disabled: list.length === 0 || m.busy,
              onClick: () => a.requestResetLayer(layer, list.length),
            },
            t(layer === 'workspace' ? 'resetLayerWorkspace' : 'resetLayerUser'),
          ),
        ),
      );
    }

    /**
     * Render the export / import panel.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the panel element.
     */
    function renderTransferPanel(t, m, a) {
      const transfer = m.transfer;
      const plan = transfer.plan;
      const children = [
        h('h3', { key: 'heading', style: headingStyle }, t('transferHeading')),
        h('p', { key: 'note', style: { margin: 0, ...metaStyle } }, t('transferNote')),
        h(
          'div',
          { key: 'export', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(UI.Button, { variant: 'primary', 'data-action': 'export', disabled: m.busy, onClick: a.exportNow }, t('exportButton')),
          transfer.fileName
            ? h('span', { 'data-export-name': transfer.fileName, style: metaStyle }, transfer.fileName)
            : null,
        ),
        transfer.exportText
          ? h(
              'details',
              { key: 'preview' },
              h('summary', { style: metaStyle }, t('exportPreviewLabel')),
              h(UI.Textarea, {
                'data-role': 'export-text',
                readOnly: true,
                rows: 6,
                value: transfer.exportText.slice(0, MAX_EXPORT_PREVIEW),
              }),
              transfer.exportText.length > MAX_EXPORT_PREVIEW
                ? h('div', { style: metaStyle }, fmt(t('exportPreviewCut'), { n: MAX_EXPORT_PREVIEW }))
                : null,
            )
          : null,
        h('h4', { key: 'import-heading', style: { margin: '6px 0 0', fontSize: 13, fontWeight: 600 } }, t('importHeading')),
        h('label', { key: 'mode-label', style: metaStyle }, t('importModeLabel')),
        h(
          'div',
          { key: 'mode' },
          tabs(
            IMPORT_MODES.map((value) => ({
              value,
              label: t(value === 'merge' ? 'importModeMerge' : 'importModeReplace'),
              id: `ps-import-${value}`,
              panelId: 'ps-import-panel',
            })),
            m.importMode,
            a.setImportMode,
            t('importModeLabel'),
            'import-mode',
          ),
        ),
        h('label', { key: 'text-label', style: metaStyle }, t('importTextLabel')),
        h(UI.Textarea, {
          key: 'text',
          'data-role': 'import-text',
          rows: 8,
          value: m.importText,
          placeholder: t('importTextPlaceholder'),
          onChange: a.setImportText,
        }),
        h('label', { key: 'file-label', style: metaStyle }, t('importFileLabel')),
        h('input', {
          key: 'file',
          type: 'file',
          accept: '.json,application/json',
          'data-role': 'import-file',
          onChange: a.pickImportFile,
        }),
        h(
          'div',
          { key: 'actions', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h(
            UI.Button,
            {
              variant: 'primary',
              'data-action': 'import-preview',
              disabled: m.busy || String(m.importText).trim().length === 0,
              onClick: a.previewImport,
            },
            transfer.phase === 'previewing' ? t('importPreviewing') : t('importPreviewButton'),
          ),
          h(
            UI.Button,
            {
              'data-action': 'import-apply',
              disabled: m.busy || plan === null,
              onClick: a.requestImportApply,
            },
            transfer.phase === 'applying' ? t('importApplying') : t('importApplyButton'),
          ),
        ),
      ];
      if (transfer.error) {
        children.push(h('div', { key: 'error' }, errorBanner(t, transfer.error, t('importHeading'))));
        children.push(
          h('p', { key: 'unchanged', 'data-import-unchanged': 'true', style: { margin: 0, ...metaStyle, color: token.stateSuccess } }, t('importUnchangedWarning')),
        );
      }
      if (plan !== null && plan !== undefined) {
        const changes = [];
        const layers = plan.layers && typeof plan.layers === 'object' ? plan.layers : {};
        for (const [layerName, entry] of Object.entries(layers)) {
          const list = entry && Array.isArray(entry.changes) ? entry.changes : [];
          for (const change of list) changes.push({ ...change, layer: layerName });
        }
        const totals = plan.totals || {};
        children.push(
          h(
            'div',
            {
              key: 'plan',
              'data-import-plan': 'true',
              'data-import-added': String(totals.added === undefined ? 0 : totals.added),
              'data-import-replaced': String(totals.replaced === undefined ? 0 : totals.replaced),
              // `-count` keeps this apart from the standalone
              // `data-import-unchanged="true"` flag on a failed import.
              'data-import-unchanged-count': String(totals.unchanged === undefined ? 0 : totals.unchanged),
              'data-import-removed': String(totals.removed === undefined ? 0 : totals.removed),
              'data-import-kept': String(totals.kept === undefined ? 0 : totals.kept),
              'data-import-changes': String(changes.length),
              'data-import-applied': String(plan.applied === true),
              style: { border: `1px solid ${token.borderL1}`, borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 },
            },
            h('strong', { style: { fontSize: 13 } }, t('importPlanHeading')),
            h('div', { style: metaStyle }, fmt(t('importCounts'), {
              added: totals.added === undefined ? 0 : totals.added,
              replaced: totals.replaced === undefined ? 0 : totals.replaced,
              unchanged: totals.unchanged === undefined ? 0 : totals.unchanged,
              removed: totals.removed === undefined ? 0 : totals.removed,
              kept: totals.kept === undefined ? 0 : totals.kept,
            })),
            changes.length === 0 ? h('div', { style: metaStyle }, t('importNoChanges')) : null,
            changes.map((change) =>
              h(
                'div',
                {
                  key: `${change.layer}:${change.name}`,
                  'data-import-change': change.name,
                  'data-import-status': change.status,
                  'data-import-layer': change.layer,
                  style: { fontSize: 12, color: token.labelSecondary },
                },
                fmt(t('importChangeRow'), { name: change.name, status: importStatusLabel(t, change.status) }),
              ),
            ),
            Array.isArray(plan.skipped) && plan.skipped.length > 0
              ? h(
                  'div',
                  { 'data-import-skipped': String(plan.skipped.length), style: metaStyle },
                  fmt(t('importSkipped'), { list: plan.skipped.map((entry) => `${entry.layer} (${entry.reason})`).join('; ') }),
                )
              : null,
          ),
        );
      }
      return h(
        'div',
        {
          'data-region': 'transfer',
          'data-transfer-phase': transfer.phase,
          'data-import-mode': m.importMode,
          style: { ...cardStyle, display: 'flex', flexDirection: 'column', gap: 6 },
        },
        children,
      );
    }

    /**
     * The confirmation dialog's typography: four levels instead of one uniform
     * gap — the title, the lead sentence that names the action, the sentence
     * that explains it, and a structural "cannot be undone" strip. zh and en
     * sentences both wrap inside the 480px card, so every level states its own
     * `lineHeight` instead of inheriting the shell's, and the spacing between
     * groups (not a single `gap`) is what carries the grouping.
     */
    const confirmTitleStyle = { fontSize: 14, fontWeight: 600, lineHeight: 1.4, color: token.stateWarn };
    const confirmBodyStyle = { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 };
    const confirmLeadStyle = {
      fontSize: 13,
      fontWeight: 500,
      lineHeight: 1.6,
      color: token.labelPrimary,
      wordBreak: 'break-word',
    };
    const confirmTextStyle = {
      fontSize: 13,
      lineHeight: 1.6,
      color: token.labelSecondary,
      wordBreak: 'break-word',
    };
    const confirmIrreversibleStyle = {
      marginTop: 12,
      paddingLeft: 10,
      borderLeft: `3px solid ${token.stateError}`,
      fontSize: 12,
      lineHeight: 1.5,
      color: token.stateError,
    };
    const confirmActionsStyle = {
      display: 'flex',
      gap: 8,
      marginTop: 16,
      paddingTop: 12,
      borderTop: `1px solid ${token.borderL1}`,
    };

    /**
     * Render the pending second confirmation. Every destructive action of this
     * page goes through here: the impact and the irreversibility are stated
     * before the click that performs it, never after.
     *
     * Four kinds remain, and they are exactly the four writes (or write-like
     * actions) the page can still start: `mine-reset` (drop 「我的 Prompt」 from
     * one layer), `legacy-clear` (`legacy=true`), `reset-layer` (`reset=true`)
     * and `import`. The Revision 6 `reset-section` kind is gone with the
     * generic per-name write it confirmed.
     *
     * It renders as a viewport-anchored modal (`data-region="confirm-overlay"`,
     * `position: fixed` + centered), not as an inline card in the page flow. The
     * trigger lives anywhere on a long panel — 「恢复默认」 sits at the bottom of
     * 「我的 Prompt」 — so an inline card appeared *above* the trigger (off-screen
     * on a scrolled page, which reads as "nothing happened") and pushed the
     * panel down as it appeared. The overlay is a backdrop only: it closes
     * nothing by itself, so the only ways out are the two buttons.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the overlay element, or null when nothing is pending.
     */
    function renderConfirm(t, m, a) {
      const confirm = m.confirm;
      if (confirm === null) return null;
      const body = [];
      if (confirm.kind === 'mine-reset') {
        body.push(fmt(t('mineResetTitle'), { layer: layerLabel(t, confirm.layer) }));
        body.push(t('mineResetBody'));
      } else if (confirm.kind === 'legacy-clear') {
        body.push(fmt(t('resetLegacyTitle'), { layer: layerLabel(t, confirm.layer) }));
        body.push(
          confirm.count === 0
            ? fmt(t('resetLegacyEmpty'), { layer: layerLabel(t, confirm.layer) })
            : fmt(t('resetLegacyBody'), { layer: layerLabel(t, confirm.layer), count: confirm.count }),
        );
      } else if (confirm.kind === 'reset-layer') {
        body.push(fmt(t('resetLayerTitle'), { layer: layerLabel(t, confirm.layer) }));
        body.push(
          confirm.count === 0
            ? fmt(t('resetLayerEmpty'), { layer: layerLabel(t, confirm.layer) })
            : fmt(t('resetLayerBody'), { layer: layerLabel(t, confirm.layer), count: confirm.count }),
        );
      } else {
        body.push(t('importConfirmTitle'));
        body.push(fmt(t('importConfirmBody'), { mode: t(m.importMode === 'replace' ? 'importModeReplace' : 'importModeMerge') }));
      }
      return h(
        'div',
        {
          key: 'confirm-overlay',
          'data-region': 'confirm-overlay',
          style: {
            position: 'fixed',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            background: 'rgba(0, 0, 0, 0.45)',
          },
        },
        h(
          'div',
          {
            'data-region': 'confirm',
            'data-confirm-kind': confirm.kind,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('confirmTitle'),
            style: {
              ...cardStyle,
              borderColor: token.stateWarn,
              display: 'flex',
              flexDirection: 'column',
              width: '100%',
              maxWidth: 480,
              maxHeight: '80vh',
              overflowY: 'auto',
              padding: '16px 18px',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
            },
          },
          h('strong', { style: confirmTitleStyle }, t('confirmTitle')),
          h(
            'div',
            { 'data-role': 'confirm-body', style: confirmBodyStyle },
            body.map((line, index) =>
              h('div', { key: `line-${index}`, style: index === 0 ? confirmLeadStyle : confirmTextStyle }, line),
            ),
          ),
          h('div', { 'data-role': 'confirm-irreversible', style: confirmIrreversibleStyle }, t('resetIrreversible')),
          h(
            'div',
            { 'data-role': 'confirm-actions', style: confirmActionsStyle },
            h(UI.Button, { variant: 'primary', 'data-action': 'confirm-yes', disabled: m.busy, onClick: a.confirmYes }, t('confirmYes')),
            h(UI.Button, { 'data-action': 'confirm-no', disabled: m.busy, onClick: a.cancelConfirm }, t('confirmNo')),
          ),
        ),
      );
    }

    /**
     * The read-only legacy override list of 「高级」.
     *
     * This is the Revision 6 list with its two write controls removed
     * (`data-action="undo"` and `data-action="reset-section"`): since the
     * write face narrowed to one name (§15.1), a *generic* per-name write is
     * not something this page may offer, and a list that cannot act is exactly
     * what the goal asked for here. What it keeps is the diagnosis — what is
     * configured, in which layer, whether the assembly applied it, and why not
     * when the client can prove the cause — because that is what a user needs
     * to decide between the two layer-wide buttons below.
     *
     * `data-region="overrides"` and every per-row marker (`data-override-row`,
     * `data-override-layer`, `data-override-action`, `data-override-applied`,
     * `data-override-reason`, `data-overrides-total`) are unchanged.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the list element.
     */
    function renderOverridesList(t, m, a) {
      const ovs = m.ovs.data;
      const merged = ovs && ovs.merged && Array.isArray(ovs.merged.overrides) ? ovs.merged.overrides : [];
      // `merged` says what is configured; `effective` says what it achieved. The
      // difference is the whole point of this list: a saved override that never
      // takes effect must be visible as such, with a reason.
      const achieved = new Map();
      for (const section of m.effectiveSections) achieved.set(section.name, section);
      return h(
        'div',
        { 'data-region': 'overrides', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('h3', { style: headingStyle }, t('ovHeading')),
        h('p', { style: { margin: 0, ...metaStyle } }, t('ovMergedNote')),
        h(
          'div',
          { 'data-overrides-total': String(merged.length), style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          merged.length === 0
            ? h('div', { 'data-empty': 'overrides', style: cardStyle }, t('ovEmpty'))
            : null,
          merged.map((entry) => {
            const target = achieved.get(entry.name);
            const state = target === undefined ? 'unknown' : target.applied === true ? 'applied' : 'ineffective';
            const hostReason = target && target.reason ? String(target.reason) : '';
            const cause = ineffectiveCause(t, target, m.incoming);
            const reasonText = cause === null ? hostReason : cause.text;
            const isReserved = entry.name === RESERVED_SECTION_NAME;
            return h(
              'div',
              {
                key: `${entry.layer}:${entry.name}`,
                'data-override-row': entry.name,
                'data-override-layer': entry.layer,
                'data-override-action': entry.action,
                'data-override-applied': state === 'unknown' ? 'unknown' : String(state === 'applied'),
                'data-override-reserved': String(isReserved),
                style: {
                  border: `1px solid ${state === 'ineffective' ? token.stateError : token.borderL1}`,
                  borderRadius: 8,
                  padding: '8px 10px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                },
              },
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('code', { style: { fontSize: 12 } }, entry.name),
                h(UI.Tag, { tone: 'info' }, String(entry.action)),
                h(UI.Tag, { tone: 'neutral' }, t(entry.layer === 'workspace' ? 'ovWorkspace' : 'ovUser')),
                h(
                  UI.Tag,
                  { tone: state === 'applied' ? 'success' : state === 'ineffective' ? 'danger' : 'outline' },
                  t(state === 'applied' ? 'ovEffective' : state === 'ineffective' ? 'ovIneffective' : 'ovUnknown'),
                ),
                isReserved ? h(UI.Tag, { tone: 'info' }, t('advReservedTag')) : null,
                typeof entry.text === 'string' && entry.text.length > 0
                  ? h('span', { style: { ...metaStyle, flex: '1 1 200px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.text.slice(0, 120))
                  : null,
              ),
              state === 'ineffective'
                ? h(
                    'div',
                    {
                      'data-override-reason': entry.name,
                      style: { fontSize: 12, color: token.stateError, wordBreak: 'break-word' },
                    },
                    `${t('ovReason')}: ${reasonText || t('ovIneffective')}`,
                  )
                : null,
              state === 'ineffective' && cause !== null && hostReason.length > 0
                ? h('div', { style: { ...metaStyle, wordBreak: 'break-word' } }, `${t('errDetail')}: ${hostReason}`)
                : null,
              state === 'ineffective'
                ? h('div', { style: { ...metaStyle, wordBreak: 'break-word' } }, t('ovFixHint'))
                : null,
            );
          }),
        ),
        // The generic per-name write is gone, so the escape hatch is stated
        // instead of offered: 「我的 Prompt」 owns the reserved name, and the two
        // layer-wide buttons below are the only writes this tab performs.
        h('p', { 'data-note': 'overrides-read-only', style: { margin: 0, ...metaStyle } }, t('advReadOnlyNote')),
      );
    }

    /**
     * 「我的 Prompt」 — the page's only write surface.
     *
     * The layer selector reuses the `user` / `workspace` semantics the whole
     * page already has (`deriveScope` / `scopeMode`): the workspace layer needs
     * a session, and the page says so instead of letting the write fail with
     * `workspace-unresolved`. The text box is bound to the reserved section's
     * stored value for that layer, read from the *merged* override list — the
     * same list the assembly applies — so what is shown is what is configured,
     * not what the last render happened to hold.
     *
     * Two states are stated rather than implied. `data-mine-state` is the
     * machine-readable one (`unconfigured` / `dirty` / `saving` / `saved` /
     * `error`), and a frozen or discarded scope renders
     * `data-warning="mine-frozen"` — §15.4 requires the panel to say that the
     * text will not reach the prompt rather than let a write look effective.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the panel element.
     */
    function renderMinePanel(t, m, a) {
      const workspace = m.snap.data && m.snap.data.layers ? m.snap.data.layers.workspace : null;
      const workspaceUsable = workspace && workspace.enabled === true;
      const layer = m.mineLayer;
      const state = m.mineState;
      const reason = m.mineFrozenReason;
      // Revision 9: the switch's own view state, kept separate from the text
      // box's so a failed toggle cannot read as a failed save.
      const interpolateOn = m.mineInterpolateOn === true;
      const interpolateStatus = m.mineInterpolateStatus ?? { kind: 'idle', error: null };
      const interpolateLocked = m.mineInterpolateLocked === true;
      const interpolateStated = m.mineInterpolateStated === undefined ? null : m.mineInterpolateStated;
      // Revision 12 (audit F4/F2/F5): the three-state name, the advisories the
      // host returned with the last write, and the reason this layer is out of
      // the assembly when it is.
      const interpolateState = m.mineInterpolateState === undefined ? 'inherit' : m.mineInterpolateState;
      const warnings = Array.isArray(m.mineWarnings) ? m.mineWarnings : [];
      const layerDisabled = m.mineLayerDisabled === undefined ? null : m.mineLayerDisabled;
      // The way out depends on WHY the layer is out: an unresolvable reference is
      // fixed in the text, everything else (invalid JSON, an invalid field, a
      // file that vanished) is fixed in the file.
      const disabledIsReference = layerDisabled !== null && layerDisabled.startsWith('unresolvable-variable');
      // The panel's own frozen boolean. `mineFrozenReason === null` is the
      // unfrozen case; an empty string is "frozen, no reason given".
      const frozen = reason !== null;
      // §2.4/§7.2: `frozenScope: "global"` + a selected session is *unknown*,
      // not frozen. The panel warns either way, but it may only claim a frozen
      // session when the model says the verdict is certain.
      const uncertain = frozen && m.mineFrozenCertain !== true;
      // Built *here*, inside the tree-building try: `t` may be the broken thing
      // (see `renderFailureCard`), so no localized string may be produced on the
      // component's own path.
      const stateText =
        state === 'saving'
          ? t('mineSaving')
          : state === 'saved'
            ? fmt(t(!frozen ? 'mineSaved' : uncertain ? 'mineSavedUnknown' : 'mineSavedFrozen'), {
                layer: layerLabel(t, layer),
              })
            : state === 'error'
              ? t('mineFailed')
              : state === 'unconfigured'
                ? t('mineUnconfigured')
                : state === 'dirty'
                  ? t('mineDirty')
                  : fmt(t('mineLoaded'), { layer: layerLabel(t, layer) });
      return h(
        'div',
        { 'data-region': 'mine', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('h3', { style: headingStyle }, t('mineHeading')),
        h('p', { style: { margin: 0, ...metaStyle } }, t('mineNote')),
        h(
          'div',
          { 'data-region': 'mine-layer', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: metaStyle }, t('editLayer')),
          tabs(
            LAYERS.map((value) => ({
              value,
              label: value === 'workspace' && !workspaceUsable ? t('ovWorkspaceDisabled') : layerLabel(t, value),
              id: `ps-mine-${value}`,
              panelId: 'ps-mine-panel',
            })),
            layer,
            a.setMineLayer,
            t('editLayer'),
            'mine-layer',
          ),
        ),
        workspaceUsable || layer === 'user'
          ? null
          : h(
              'p',
              {
                'data-warning': 'mine-workspace-disabled',
                style: { margin: 0, fontSize: 12, color: token.stateWarn, wordBreak: 'break-word' },
              },
              `${t('mineWorkspaceNeedsSession')}${workspace && workspace.reason ? ` — ${String(workspace.reason)}` : ''}`,
            ),
        // ---- Revision 12 (audit F5): a degraded layer contributes nothing to
        // any assembly, so the panel says so where the text box is, with the
        // host's own reason and the fix. The degradation itself is the
        // `missing-file` paradigm — the whole layer is out because its stored
        // text cannot be repaired in place without rewriting the user's file —
        // and CONTRACT §16.5 states that trade explicitly.
        layerDisabled === null
          ? null
          : h(
              'div',
              {
                'data-warning': 'mine-layer-disabled',
                'data-mine-layer-disabled': 'true',
                style: { margin: 0, display: 'flex', flexDirection: 'column', gap: 2, wordBreak: 'break-word' },
              },
              h('p', { style: { margin: 0, fontSize: 12, color: token.stateError } }, t('mineLayerDisabled')),
              h(
                'p',
                { 'data-mine-layer-disabled-reason': 'true', style: { margin: 0, fontSize: 12, color: token.stateError } },
                fmt(t('mineLayerDisabledReason'), { reason: layerDisabled.length > 0 ? layerDisabled : t('stNone') }),
              ),
              h(
                'p',
                { 'data-mine-layer-disabled-fix': 'true', style: { margin: 0, fontSize: 12, color: token.labelTertiary } },
                t(disabledIsReference ? 'mineLayerDisabledFix' : 'mineLayerDisabledFixGeneric'),
              ),
            ),
        reason === null
          ? null
          : h(
              // g-021 (方案 A): the write stays enabled, so the block has to be
              // loud enough that "saved" cannot be read as "effective". The
              // container carries three markers: the historical
              // `data-warning="mine-frozen"`, the boolean
              // `data-mine-frozen="true"`, and the certainty the panel is
              // allowed to claim (`certain` vs the §2.4/§7.2 `unknown`).
              'div',
              {
                'data-warning': 'mine-frozen',
                'data-mine-frozen': 'true',
                'data-mine-frozen-certainty': uncertain ? 'unknown' : 'certain',
                style: { margin: 0, display: 'flex', flexDirection: 'column', gap: 4, wordBreak: 'break-word' },
              },
              h(
                'p',
                { style: { margin: 0, fontSize: 12, color: token.stateError } },
                `${t(uncertain ? 'mineFrozenUnknownWarn' : 'mineFrozenWarn')}${
                  reason.length > 0 ? ` — ${t('stReason')}: ${reason}` : ''
                }`,
              ),
              // Where the text went, and where it did not: stored in the layer's
              // configuration, discarded from the assembly the verdict describes.
              h(
                'p',
                { 'data-mine-frozen-body': 'true', style: { margin: 0, fontSize: 12, color: token.stateError } },
                fmt(t(uncertain ? 'mineFrozenUnknownBody' : 'mineFrozenBody'), { layer: layerLabel(t, layer) }),
              ),
              // Actionable, not just descriptive: what the user can actually do.
              // The fix is the same whether the freeze is certain or unknown —
              // drop the `complete` declaration, or move to a preset without one.
              h(
                'p',
                { 'data-mine-frozen-fix': 'true', style: { margin: 0, fontSize: 12, color: token.labelTertiary } },
                t('mineFrozenHowTo'),
              ),
            ),
        // ---- Revision 9: the variable-substitution switch. It sits above the
        // text box because it changes what the text box MEANS: while it is on,
        // `{{...}}` is syntax, and a literal brace can no longer be written.
        h(
          'div',
          {
            'data-region': 'mine-interpolate',
            'data-mine-interpolate': interpolateOn ? 'on' : 'off',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              border: `1px solid ${token.borderL2}`,
              borderRadius: 6,
              padding: '8px 10px',
              wordBreak: 'break-word',
            },
          },
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: metaStyle }, t('mineInterpolateLabel')),
            h(
              UI.Button,
              {
                'data-action': 'mine-interpolate',
                'data-mine-interpolate-layer': layer,
                'aria-pressed': interpolateOn ? 'true' : 'false',
                disabled: m.busy || interpolateLocked,
                onClick: a.toggleMineInterpolate,
              },
              interpolateStatus.kind === 'saving'
                ? t('mineInterpolateSaving')
                : t(interpolateOn ? 'mineInterpolateTurnOff' : 'mineInterpolateTurnOn'),
            ),
            h(
              'span',
              {
                'data-mine-interpolate-state': interpolateOn ? 'on' : 'off',
                style: { ...metaStyle, color: interpolateOn ? token.stateWarn : token.labelTertiary },
              },
              t(interpolateOn ? 'mineInterpolateOn' : 'mineInterpolateOff'),
            ),
            h(
              'span',
              {
                'data-mine-interpolate-stated': interpolateStated === null ? 'inherit' : String(interpolateStated),
                style: metaStyle,
              },
              interpolateStated === null
                ? t('mineInterpolateInherit')
                : fmt(t('mineInterpolateStated'), {
                    state: t(interpolateStated ? 'mineInterpolateOn' : 'mineInterpolateOff'),
                  }),
            ),
          ),
          // ---- Revision 12 (audit F4): the three states, side by side. The
          // toggle above can only express ON and "unstated"; this is the control
          // that can also state OFF, which is what a workspace layer needs to
          // close a switch the user layer opened.
          h(
            'div',
            {
              'data-region': 'mine-interpolate-states',
              style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
            },
            h('span', { style: metaStyle }, t('mineInterpolateStatesLabel')),
            ...[
              ['inherit', t('mineInterpolateSetInherit')],
              ['on', t('mineInterpolateSetOn')],
              ['off', t('mineInterpolateSetOff')],
            ].map(([choice, label]) =>
              h(
                UI.Button,
                {
                  'data-action': 'mine-interpolate-state',
                  'data-mine-interpolate-set': choice,
                  'data-mine-interpolate-set-active': String(interpolateState === choice),
                  'aria-pressed': String(interpolateState === choice),
                  disabled: m.busy || interpolateLocked,
                  onClick: () => a.setMineInterpolateState(choice),
                },
                label,
              ),
            ),
          ),
          h('p', { style: { margin: 0, ...metaStyle } }, t('mineInterpolateSetNote')),
          // Inheriting ON is the state a user cannot see from the toggle alone:
          // the toggle offers "turn off", but turning off a layer that states
          // nothing just keeps stating nothing — so the panel names the way out.
          interpolateOn && interpolateState === 'inherit'
            ? h(
                'p',
                {
                  'data-warning': 'mine-interpolate-inherited',
                  style: { margin: 0, fontSize: 12, color: token.stateWarn },
                },
                t('mineInterpolateInheritedOn'),
              )
            : null,
          h('p', { style: { margin: 0, ...metaStyle } }, t('mineInterpolateNote')),
          h(
            'p',
            { 'data-warning': 'mine-interpolate', style: { margin: 0, fontSize: 12, color: token.stateWarn } },
            t('mineInterpolateWarn'),
          ),
          // ---- Revision 12 (audit F2): the advisories of the last write. A
          // registered reference with no value in the probe is not a refusal —
          // the save happened — but it is the difference between "the panel is
          // quiet" and "this turn will not assemble".
          warnings.length === 0
            ? null
            : h(
                'div',
                {
                  'data-warning': 'mine-warnings',
                  'data-mine-warnings': 'true',
                  style: { margin: 0, display: 'flex', flexDirection: 'column', gap: 2, wordBreak: 'break-word' },
                },
                h('p', { style: { margin: 0, fontSize: 12, color: token.stateWarn } }, t('mineWarningsHeading')),
                h(
                  'p',
                  { 'data-mine-warnings-list': 'true', style: { margin: 0, fontSize: 12, color: token.stateWarn } },
                  fmt(t('mineWarningUndefined'), {
                    list: warnings
                      .map((entry) => fmt(t('mineWarningList'), { name: entry.name }))
                      .join(', '),
                  }),
                ),
              ),
          h('p', { style: { margin: 0, ...metaStyle } }, t('mineInterpolateLayerOnly')),
          interpolateLocked
            ? h(
                'p',
                { 'data-warning': 'mine-interpolate-locked', style: { margin: 0, fontSize: 12, color: token.stateWarn } },
                t('mineInterpolateWorkspaceNeedsSession'),
              )
            : null,
          interpolateStatus.kind === 'error' && interpolateStatus.error
            ? h(
                'div',
                { 'data-mine-interpolate-error': 'true' },
                errorBanner(t, interpolateStatus.error, t('mineInterpolateFailed')),
              )
            : null,
        ),
        h(
          'label',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('span', { style: metaStyle }, t('mineTextLabel')),
          h(UI.Textarea, {
            'data-role': 'mine-text',
            value: m.mineText,
            onChange: a.setMineText,
            rows: 10,
            placeholder: t('minePlaceholder'),
          }),
        ),
        h(
          'p',
          {
            'data-mine-state': state,
            // g-021: the machine-readable half of "saved ≠ effective". The
            // effect is `none` for a certain freeze, `unknown` for the
            // §2.4/§7.2 unknown case, and `next-turn` otherwise — so the pair
            // (`saved`, `none`) is assertable offline without reading any copy.
            'data-mine-effect': !frozen ? 'next-turn' : uncertain ? 'unknown' : 'none',
            style: {
              margin: 0,
              fontSize: 12,
              color:
                state === 'error'
                  ? token.stateError
                  : state === 'saved'
                    ? frozen
                      ? token.stateWarn
                      : token.stateSuccess
                    : token.labelTertiary,
              wordBreak: 'break-word',
            },
          },
          stateText,
        ),
        // A failed write keeps the host's own words: the mapped copy names the
        // code, and the banner adds the code itself and the host message — the
        // same shape every other failed request on this page has.
        state === 'error' && m.mineError
          ? h('div', { 'data-mine-error': 'true' }, errorBanner(t, m.mineError, t('mineFailed')))
          : null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(
            UI.Button,
            {
              variant: 'primary',
              'data-action': 'mine-save',
              'data-mine-layer': layer,
              disabled: m.busy,
              onClick: a.saveMine,
            },
            state === 'saving' ? t('mineSaving') : t('mineSave'),
          ),
          // g-027: 「取消」 drops the unsaved draft and falls back to the layer's
          // *stored* text. It is the counterpart of 「恢复默认」, which is the
          // one that deletes stored text; so this one is offered exactly while
          // there is something unsaved to drop, and asks nothing first — it
          // destroys nothing that was ever stored (§13.1).
          h(
            UI.Button,
            {
              'data-action': 'mine-cancel',
              'data-mine-layer': layer,
              disabled: m.busy || state !== 'dirty',
              onClick: a.cancelMine,
            },
            t('mineCancel'),
          ),
          h(
            UI.Button,
            {
              'data-action': 'mine-reset',
              'data-mine-layer': layer,
              disabled: m.busy || !m.mineConfigured,
              onClick: a.requestMineReset,
            },
            t('mineReset'),
          ),
        ),
      );
    }

    /**
     * 「提示词总览」 — the read-only assembly, in its two existing views.
     *
     * The inner `view` tabs (`data-region="view-tabs"`, group `view`) are kept
     * from Revision 6 because both answers are still wanted and neither writes:
     * `sections` is the segment list with its origin/layer/applied markers,
     * `full` is the assembled text with search, highlight, the origin filter and
     * the base ↔ effective comparison. What is gone is the editor slot and the
     * write entries — this tab renders no `data-region="editor"` and no
     * `edit` / `append-new` / `delete` action, by construction: the row builder
     * no longer takes a form, and no caller builds one.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the panel element.
     */
    function renderOverviewPanel(t, m, a) {
      return h(
        'div',
        { 'data-region': 'overview', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(
          'div',
          { 'data-region': 'view-tabs' },
          tabs(
            VIEWS.map((value) => ({
              value,
              label: t(value === 'sections' ? 'viewSections' : 'viewFull'),
              id: `ps-view-${value}`,
              panelId: 'ps-view-panel',
            })),
            m.view,
            a.setView,
            t('title'),
            'view',
          ),
        ),
        m.view === 'sections' ? renderSectionsView(t, m, a) : renderFullView(t, m, a),
      );
    }

    /**
     * 「历史与备份」 — the log, the comparison and the export/import surface.
     *
     * Nothing here changed in g-015 except *where it lives*: the panel and the
     * transfer card moved out of the old 覆盖 view, and the lazy load now keys
     * off this tab instead of that view, so a page that never opens it still
     * issues exactly the three baseline requests.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the panel element.
     */
    function renderHistoryTab(t, m, a) {
      return h(
        'div',
        { 'data-region': 'history-tab', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        renderHistoryPanel(t, m, a),
        renderTransferPanel(t, m, a),
      );
    }

    /**
     * 「高级」 — everything rare, everything destructive, everything about the
     * page itself: the read-only legacy override list, the two layer-wide
     * buttons (`legacy=true` and `reset=true`, each confirmed), and the full
     * status block (mount / frozen / build stamp / renderer / primitives
     * self-check) that the one-line summary at the top compresses away.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the panel element.
     */
    function renderAdvancedTab(t, m, a) {
      return h(
        'div',
        { 'data-region': 'advanced', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        renderOverridesList(t, m, a),
        renderLayerReset(t, m, a),
        renderStatusDetail(t, m),
      );
    }

    /**
     * Build the whole page tree. Kept separate so the hook order in the
     * component above stays fixed and the entire tree is produced inside one
     * `try`.
     *
     * The chrome above the tabs is deliberately three things only — the title,
     * one line of deciding facts ({@link renderStatusLine}) and the session
     * selector every tab shares. Everything else moved into the tab that owns
     * it, which is what makes the page short again.
     *
     * @param t - the bound translator for this namespace.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the page element.
     */
    function renderSection(t, m, a) {
      const children = [];
      children.push(
        h('h2', { key: 'title', style: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '26px' } }, t('title')),
      );
      children.push(h('p', { key: 'subtitle', style: { margin: 0, fontSize: 13, color: token.labelTertiary } }, t('subtitle')));
      children.push(renderStatusLine(t, m, a));
      children.push(renderSession(t, m, a));
      children.push(
        h(
          'div',
          {
            key: 'tabs',
            'data-region': 'tabs',
            'data-active-tab': m.tab,
          },
          tabs(
            MAIN_TABS.map((value) => ({
              value,
              label: t(
                value === 'mine'
                  ? 'tabMine'
                  : value === 'overview'
                    ? 'tabOverview'
                    : value === 'history'
                      ? 'tabHistory'
                      : 'tabAdvanced',
              ),
              id: `ps-tab-${value}`,
              panelId: 'ps-tab-panel',
            })),
            m.tab,
            a.setTab,
            t('title'),
            'main',
          ),
        ),
      );
      if (m.snap.phase === 'error') children.push(h('div', { key: 'snap-error' }, errorBanner(t, m.snap.error, t('loadFailed'))));
      if (m.ovs.phase === 'error') children.push(h('div', { key: 'ovs-error' }, errorBanner(t, m.ovs.error, t('loadFailed'))));
      if (m.notice) {
        children.push(
          h(
            'div',
            {
              key: 'notice',
              'data-notice': m.notice.tone,
              style: {
                ...cardStyle,
                borderColor: m.notice.tone === 'error' ? token.stateError : token.stateSuccess,
                fontSize: 13,
                color: m.notice.tone === 'error' ? token.stateError : token.stateSuccess,
              },
            },
            m.notice.text,
          ),
        );
      }
      // The confirmation is a fixed overlay (renderConfirm), so its position in
      // this array is irrelevant to where it lands; it is pushed before the
      // panel purely so the panel keeps the last slot in the tree.
      const confirmCard = renderConfirm(t, m, a);
      if (confirmCard !== null) children.push(confirmCard);
      children.push(
        h('div', { key: 'panel', 'data-region': 'panel' },
          m.snap.phase === 'loading' && !m.snap.data ? h('p', { key: 'loading', style: metaStyle }, t('loading')) : null,
          m.snap.data
            ? h(
                'div',
                { key: 'tab-panel', 'data-region': 'tab-panel', 'data-tab-value': m.tab },
                m.tab === 'mine'
                  ? renderMinePanel(t, m, a)
                  : m.tab === 'overview'
                    ? renderOverviewPanel(t, m, a)
                    : m.tab === 'history'
                      ? renderHistoryTab(t, m, a)
                      : renderAdvancedTab(t, m, a),
              )
            : null,
        ),
      );
      return h(
        'div',
        {
          'data-plugin': 'dsh-prompt-setting',
          'data-renderer': RENDERER,
          'data-render-state': 'ok',
          'data-phase': m.phase,
          'data-session-mode': m.seat.mode,
          'data-scope-mode': m.scopeMode,
          'data-session': m.sessionArg === null ? 'global' : m.sessionArg,
          'data-frozen-scope': m.fz.scope,
          'data-frozen-state': m.fz.kind,
          'data-mounted': m.snap.data ? String(m.snap.data.mounted === true) : 'unknown',
          'data-active-tab': m.tab,
          // Build stamp, machine-readable at the root so a probe can read the
          // verdict without knowing the status bar's layout (Revision 6):
          // this tab's digest, the host's digest, and `true`/`false`/`unknown`.
          'data-build': m.boot && m.boot.self && typeof m.boot.self.hash === 'string' ? m.boot.self.hash : 'unknown',
          'data-build-server':
            m.boot && m.boot.server && typeof m.boot.server.hash === 'string' ? m.boot.server.hash : 'unknown',
          'data-build-match': buildVerdict(m.boot),
          // g-029: the version the host reported in the same ping, verbatim, or
          // `unknown` — never a version this bundle made up. Beside the build
          // stamp because both answer "what am I looking at" from one answer.
          'data-plugin-version': pluginVersionOf(m.boot),
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            maxWidth: 860,
            color: token.labelPrimary,
          },
        },
        children,
      );
    }

    // #endregion

    /**
     * The settings section page.
     *
     * Hooks run before the `try`: their call order must be identical on every
     * render, including the render that catches. The returned tree is built
     * inside the `try` so that no failure below can escape into React's
     * reconciler and blank the panel — a readable failure card is always
     * preferable to a white screen.
     * @param props - owner props (`close`, `useSessions`, …) merged with the
     *   `locale` seat (`t`) and this entry's inject face (`subscribeLocale`,
     *   `getLocaleRevision`).
     * @returns the rendered page; never throws.
     */
    function PromptSettingSection(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const subscribe = typeof props.subscribeLocale === 'function' ? props.subscribeLocale : noopSubscribe;
      const revision =
        typeof props.getLocaleRevision === 'function' ? props.getLocaleRevision : zeroRevision;
      // Re-render this page on its own when the DSH language changes, instead
      // of relying on the shell to re-render us. Both seats are already
      // exception-free by construction (see `apply`), so this hook cannot be
      // the call that throws.
      React.useSyncExternalStore(subscribe, revision, revision);

      // The session seat: a root-level hook on props, no inject required. The
      // `typeof` branch is stable for the life of a mount, and a hook that
      // throws degrades to the manual picker instead of blanking the panel.
      const seat = readSessionSeat(props.useSessions);
      // The workspace seat, from the *other* root hook
      // (`dsh-client-ui-workspace` provides `useWorkspaces`). Absent or
      // throwing ⇒ the flat list, announced on the page.
      const wsSeat = readWorkspaceSeat(props.useWorkspaces);

      const [selection, setSelection] = React.useState(null);
      const [manualId, setManualId] = React.useState('');
      const [sessionQuery, setSessionQuery] = React.useState('');
      const [sessionActive, setSessionActive] = React.useState(-1);
      const [scopeExpanded, setScopeExpanded] = React.useState({});
      // g-016: the「查看范围」block ships collapsed. `false` keeps the tab bar
      // and the tab panel on the first screen;「更改」opens the picker, and
      // picking a scope closes it again (see the actions below).
      const [scopeOpen, setScopeOpen] = React.useState(false);
      const [scopeLimits, setScopeLimits] = React.useState({});
      // Only one row can be hovered or focused at a time, so one slot each is
      // enough — and it keeps the interaction state out of a per-row component
      // (which would nest hooks under this page's render).
      const [scopeHover, setScopeHover] = React.useState('');
      const [scopeFocus, setScopeFocus] = React.useState('');
      // The first-level tab. 「我的 Prompt」 is first *and default*: it is the
      // only surface that writes, so it is where the page opens (g-015).
      const [tab, setTab] = React.useState('mine');
      // The read-only inner view of 「提示词总览」, unchanged from Revision 6.
      const [view, setView] = React.useState('sections');
      const [search, setSearch] = React.useState('');
      const [filters, setFilters] = React.useState({ layer: 'all', overridable: 'all', origin: 'all' });
      const [fullOrigin, setFullOrigin] = React.useState('all');
      const [expanded, setExpanded] = React.useState('');
      const [snap, setSnap] = React.useState({ phase: 'loading', data: null, error: null });
      const [ovs, setOvs] = React.useState({ phase: 'loading', data: null, error: null });
      const [reload, setReload] = React.useState(0);
      // 「我的 Prompt」: the selected layer, the user's unsaved draft (keyed by
      // layer+session so switching layers cannot carry a draft across), and the
      // last operation's outcome. `mineDraft === null` means "show what is
      // stored", which is what makes a fresh load, a layer switch and a
      // post-save reload all correct without clobbering typing.
      const [mineLayer, setMineLayer] = React.useState('user');
      const [mineDraft, setMineDraft] = React.useState(null);
      const [mineStatus, setMineStatus] = React.useState({ kind: 'idle', error: null });
      // Revision 9: the switch's own request state. Kept apart from
      // `mineStatus` because the switch is a config-level fact with its own
      // failure mode (a refusal names the text the write face will not accept),
      // and folding the two would let a failed toggle look like a failed save.
      const [mineInterpolate, setMineInterpolate] = React.useState({ kind: 'idle', error: null });
      // Revision 12 (audit F2): the advisories the host returns with a write or
      // an arming. They are *not* failures — the save happened — so they live in
      // their own slot and the panel renders them beside the state they qualify,
      // instead of inside an error banner that would deny the write.
      const [mineWarnings, setMineWarnings] = React.useState([]);
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      // Stage 2 state: history, the comparison, the pending confirmation and
      // the export/import surface. All of it is view state — nothing here is
      // derived from a real config file until a route answers.
      const [hist, setHist] = React.useState({ phase: 'idle', data: null, error: null });
      const [historyLayer, setHistoryLayer] = React.useState('user');
      // 「高级」 picks its own layer: the two layer-wide buttons are destructive,
      // and silently sharing 「历史与备份」's selector would make selecting a log
      // filter change what a clear button is aimed at.
      const [advancedLayer, setAdvancedLayer] = React.useState('user');
      const [diffSel, setDiffSel] = React.useState({ from: null, to: DIFF_CURRENT });
      const [diff, setDiff] = React.useState({ phase: 'idle', data: null, error: null });
      const [confirm, setConfirm] = React.useState(null);
      const [transfer, setTransfer] = React.useState({ phase: 'idle', plan: null, error: null, exportText: '', fileName: '' });
      const [importText, setImportText] = React.useState('');
      const [importMode, setImportMode] = React.useState('merge');
      // The build stamp's transport half: what this tab runs (`self`, computed
      // once at module scope) and what the host said it serves. Starts as
      //「未知」and stays that way unless the host really answered a hash — a
      // missing/failed ping must never be rendered as「过期」.
      // `version` rides on the *same* ping (g-029): one request answers both
      // questions, so the page can never show a build from one host boot and a
      // version from another.
      const [boot, setBoot] = React.useState({ self: SELF_BUILD, server: null, version: null, pingFailed: false });

      const session = selection === null ? seat.currentId || GLOBAL_SESSION : selection;
      const sessionArg = session === GLOBAL_SESSION ? null : session;
      // Tree when both root hooks answered, flat when only the session hook did,
      // manual when even that is missing. `scope` is null in the two degraded
      // modes, where the flat list keeps its own (bounded) projection.
      const scopeMode = seat.mode === 'manual' ? 'manual' : wsSeat.mode === 'workspaces' ? 'tree' : 'flat';
      const scope =
        scopeMode === 'tree'
          ? deriveScope({
              rows: seat.rows,
              currentId: seat.currentId,
              workspaces: wsSeat.items,
              pinned: wsSeat.pinned,
              archived: wsSeat.archived,
              query: sessionQuery,
              expanded: scopeExpanded,
              limits: scopeLimits,
              labels: {
                defaultName: t('scopeDefaultWorkspace'),
                untitled: t('scopeUntitledWorkspace'),
                ungrouped: t('scopeUngrouped'),
              },
            })
          : null;
      // Every match is computed; only a bounded window is ever rendered.
      const sessionMatches = scope === null ? filterSessions(seat.rows, sessionQuery) : [];
      const sessionVisible =
        scope === null ? sessionMatches.slice(0, SESSION_MATCH_LIMIT) : scope.rows;

      React.useEffect(() => {
        let cancelled = false;
        setSnap({ phase: 'loading', data: null, error: null });
        setOvs({ phase: 'loading', data: null, error: null });
        const query = sessionArg === null ? '' : `?session=${encodeURIComponent(sessionArg)}`;
        // Stage 1A side channel: the same ping tells the Host which renderer
        // branch this browser actually got (index.js `clientRenderer`). Since
        // Revision 6 it is *consumed* rather than fired and forgotten: its
        // `clientBuild` is the host's own digest of the bundle it serves, and
        // comparing it with this tab's self-digest is the whole build stamp.
        // The URL is unchanged (`?renderer=…`), so an old host keeps working:
        // no `clientBuild` ⇒「未知」, never a false「过期」.
        const sendPing = async () => {
          const ping = await requestJson(`${PING_PATH}?renderer=${RENDERER}`);
          if (cancelled) return;
          const body = ping.ok && ping.payload ? ping.payload : null;
          const build = body ? body.clientBuild : null;
          // g-029: the *same* answer also carries the plugin version, so the two
          // facts on screen always describe one host boot. Only a string that
          // declares something is kept; anything else (absent, `null`, a number,
          // `''`, whitespace only) stays `null` and renders as「未知」rather than
          // being coerced into a value the host never sent.
          const version = body ? body.version : null;
          setBoot({
            self: SELF_BUILD,
            server:
              build && typeof build === 'object' && typeof build.hash === 'string' && build.hash.length > 0
                ? {
                    hash: build.hash,
                    size: typeof build.size === 'number' ? build.size : null,
                    mtime: typeof build.mtime === 'string' ? build.mtime : null,
                  }
                : null,
            version: typeof version === 'string' && version.trim().length > 0 ? version : null,
            pingFailed: !ping.ok,
          });
        };
        void sendPing();
        const load = async () => {
          const snapshot = await requestJson(`${SNAPSHOT_PATH}${query}`);
          if (cancelled) return;
          setSnap(
            snapshot.ok
              ? { phase: 'ready', data: snapshot.payload, error: null }
              : { phase: 'error', data: null, error: snapshot.error },
          );
          const overrides = await requestJson(`${OVERRIDES_PATH}${query}`);
          if (cancelled) return;
          setOvs(
            overrides.ok
              ? { phase: 'ready', data: overrides.payload, error: null }
              : { phase: 'error', data: null, error: overrides.error },
          );
        };
        void load();
        return () => {
          cancelled = true;
        };
      }, [sessionArg, reload]);

      // History is loaded only while 「历史与备份」 is open: 「我的 Prompt」 and
      // 「提示词总览」 must not pay for a log they never show, and a mount that
      // never opens that tab must issue exactly the three baseline requests.
      React.useEffect(() => {
        if (tab !== 'history') return undefined;
        if (historyLayer === 'workspace' && sessionArg === null) {
          // The host refuses this with `workspace-unresolved`; asking anyway
          // would turn a known answer into an error banner.
          setHist({ phase: 'idle', data: null, error: null });
          return undefined;
        }
        let cancelled = false;
        setHist((current) => ({ ...current, phase: 'loading' }));
        const query = `${layerQuery(historyLayer, sessionArg)}&limit=${HISTORY_PAGE}`;
        const run = async () => {
          const result = await requestJson(`${HISTORY_PATH}?${query}`);
          if (cancelled) return;
          setHist(
            result.ok
              ? { phase: 'ready', data: result.payload, error: null }
              : { phase: 'error', data: null, error: result.error },
          );
        };
        void run();
        return () => {
          cancelled = true;
        };
      }, [tab, historyLayer, sessionArg, reload]);

      const snapshot = snap.data;
      const fz = frozenState(snapshot, sessionArg !== null);
      const effectiveSections =
        snapshot && snapshot.effective && Array.isArray(snapshot.effective.sections)
          ? snapshot.effective.sections
          : [];
      const phase = snap.phase === 'ready' && effectiveSections.length === 0 ? 'empty' : snap.phase;
      const incoming = incomingNames(snapshot);

      // ---- 「我的 Prompt」: the reserved section's stored value and its state
      // The draft is keyed by layer+session, so a draft typed for `user` is not
      // shown as if it were the workspace layer's, and switching back restores
      // it rather than losing it.
      const mineKey = `${mineLayer}|${sessionArg === null ? '' : sessionArg}`;
      const mineStored = reservedTextOf(ovs.data, mineLayer);
      const mineConfigured = mineStored !== null && mineStored.length > 0;
      const mineText =
        mineDraft !== null && mineDraft.key === mineKey ? mineDraft.text : mineStored === null ? '' : mineStored;
      // g-021: the panel separates *certainly frozen* from *unknown*, and the
      // verdict is the host's alone — `frozenState` reads the snapshot's
      // `frozen` / `frozenScope` (§2.4/§7.2), which covers both the certain
      // cases and the `frozenScope: "global"` + session case that must never be
      // presented as frozen (the snapshot froze the unscoped assembly, not this
      // session).
      //
      // The reserved entry's own `applied: false` is deliberately NOT a second
      // vote. `applied: false` is the *normal* state of a section with no
      // override (§15.3 defines it that way, and `reason` is `null` when there
      // is nothing to explain), and every non-frozen failure reports it too — a
      // `replace` that did not stick, a `hide` that did not stick, an entry the
      // pipeline dropped. Reading any of them as a freeze is what made a
      // freshly installed, still-unconfigured plugin show「该作用域已被冻结」on
      // first open, next to a status card that said the session was not frozen.
      const mineFrozen = (() => {
        if (fz.certain && fz.frozen) return { reason: fz.reason ? String(fz.reason) : '', certain: true };
        if (fz.kind === 'unknown' && fz.frozen) return { reason: fz.reason ? String(fz.reason) : '', certain: false };
        return null;
      })();
      const mineFrozenReason = mineFrozen === null ? null : mineFrozen.reason;
      const mineFrozenCertain = mineFrozen !== null && mineFrozen.certain;
      const mineState =
        mineStatus.kind === 'saving'
          ? 'saving'
          : mineStatus.kind === 'saved'
            ? 'saved'
            : mineStatus.kind === 'error'
              ? 'error'
              : !mineConfigured && mineText.length === 0
                ? 'unconfigured'
                : mineStored !== mineText
                  ? 'dirty'
                  : 'idle';
      // ---- Revision 9: the variable-substitution switch, as the host reports
      // it. `effective` is what this session's assembly will do; the per-layer
      // value is what the layer itself states, and `null` there means "states
      // nothing", which is *not* the same as `false` (the workspace layer then
      // inherits the user layer, §16.1).
      const mineInterpolateInfo =
        snapshot && snapshot.layers && snapshot.layers.interpolate ? snapshot.layers.interpolate : null;
      const mineInterpolateOn = mineInterpolateInfo !== null && mineInterpolateInfo.effective === true;
      const mineInterpolateStated = mineInterpolateInfo === null ? null : mineInterpolateInfo[mineLayer];
      const mineInterpolateLocked = mineLayer === 'workspace' && sessionArg === null;
      // Revision 12 (audit F4): the SAME fact as a name, which is what the three
      // state controls select between: `inherit` is the absent key, `on`/`off`
      // are the stated booleans. Deriving it here rather than in the tree keeps
      // one source of truth for "what does this layer say".
      const mineInterpolateState =
        mineInterpolateStated === true ? 'on' : mineInterpolateStated === false ? 'off' : 'inherit';
      // Revision 12 (audit F2/F5): what the host said about the layer the user is
      // editing. A degraded layer contributes nothing to any assembly, so the
      // panel has to say so where the text box is — the advanced tab's status
      // block is one scroll too far for "your prompt is not in the prompt".
      const mineLayerInfo =
        snapshot && snapshot.layers
          ? mineLayer === 'workspace'
            ? snapshot.layers.workspace
            : snapshot.layers.user
          : null;
      const mineLayerDisabled =
        mineLayerInfo !== null && mineLayerInfo !== undefined && mineLayerInfo.enabled === false
        && (mineLayer === 'user' || sessionArg !== null)
          ? String(mineLayerInfo.reason ? mineLayerInfo.reason : '')
          : null;
      /**
       * Ask the host for a comparison and store the result. `from`/`to` are a
       * history id or {@link DIFF_CURRENT}; a half-made selection clears the
       * panel rather than sending a request that cannot answer anything.
       */
      const runDiff = async (from, to) => {
        if (from === null || to === null) {
          setDiff({ phase: 'idle', data: null, error: null });
          return;
        }
        setDiff({ phase: 'loading', data: null, error: null });
        const query = `${layerQuery(historyLayer, sessionArg)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
        const result = await requestJson(`${DIFF_PATH}?${query}`);
        setDiff(
          result.ok
            ? { phase: 'ready', data: result.payload, error: null }
            : { phase: 'error', data: null, error: result.error },
        );
      };

      /** Clear one whole layer (`DELETE …&reset=true`). */
      const resetLayer = async (layer) => {
        setBusy(true);
        const result = await requestJson(`${OVERRIDES_PATH}?${layerQuery(layer, sessionArg)}&reset=true`, { method: 'DELETE' });
        setBusy(false);
        if (!result.ok) {
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        const count = result.payload && typeof result.payload.count === 'number' ? result.payload.count : 0;
        setNotice({
          tone: 'success',
          text: count > 0 ? fmt(t('resetDoneNotice'), { count }) : t('resetNoneNotice'),
        });
        setReload((value) => value + 1);
      };

      /** Fetch the export document, hold its text, and try to download it. */
      const exportNow = async () => {
        setBusy(true);
        const query = sessionArg === null ? '' : `?session=${encodeURIComponent(sessionArg)}`;
        const result = await requestJson(`${EXPORT_PATH}${query}`);
        setBusy(false);
        if (!result.ok) {
          setTransfer((current) => ({ ...current, phase: 'error', error: result.error, plan: null }));
          setNotice({ tone: 'error', text: fmt(t('exportFailed'), { reason: errorText(t, result.error) }) });
          return;
        }
        // `ok` is this plugin's own liveness flag, not part of the document: a
        // downloaded file must be importable by anything that reads the schema.
        const document = { ...result.payload };
        delete document.ok;
        const text = JSON.stringify(document, null, 2);
        const fileName = exportFileName(document.exportedAt);
        const download = downloadText(text, fileName);
        setTransfer({
          phase: download.ok ? 'exported' : 'error',
          plan: null,
          error: download.ok ? null : { code: 'download-failed', message: download.reason },
          exportText: text,
          fileName,
        });
        setNotice({
          tone: download.ok ? 'success' : 'error',
          text: download.ok ? fmt(t('downloadDone'), { name: fileName }) : fmt(t('downloadFailed'), { reason: download.reason }),
        });
      };

      /** Load an export document from a chosen file, when the file API exists. */
      const pickImportFile = async (event) => {
        const file = event && event.target && event.target.files ? event.target.files[0] : null;
        if (!file) return;
        if (typeof file.text !== 'function') {
          setTransfer((current) => ({
            ...current,
            phase: 'error',
            plan: null,
            error: { code: 'invalid-export', message: 'this browser cannot read a chosen file; paste the JSON instead' },
          }));
          return;
        }
        setBusy(true);
        try {
          const text = await file.text();
          setImportText(String(text));
          setTransfer((current) => ({ ...current, phase: 'idle', plan: null, error: null }));
        } catch (error) {
          setTransfer((current) => ({
            ...current,
            phase: 'error',
            plan: null,
            error: { code: 'invalid-export', message: error && error.message ? String(error.message) : String(error) },
          }));
        }
        setBusy(false);
      };

      /** Dry-run the pasted document: a preview, and provably no write. */
      const previewImport = async () => {
        const raw = String(importText).trim();
        if (raw.length === 0) {
          setNotice({ tone: 'error', text: t('importNeedText') });
          return;
        }
        try {
          JSON.parse(raw);
        } catch (error) {
          setTransfer((current) => ({
            ...current,
            phase: 'error',
            plan: null,
            error: { code: 'invalid-json', message: error && error.message ? String(error.message) : String(error) },
          }));
          return;
        }
        setTransfer((current) => ({ ...current, phase: 'previewing', error: null }));
        setBusy(true);
        const query = `dryRun=true&mode=${encodeURIComponent(importMode)}${sessionArg === null ? '' : `&session=${encodeURIComponent(sessionArg)}`}`;
        const result = await requestJson(`${IMPORT_PATH}?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        setBusy(false);
        if (!result.ok) {
          setTransfer((current) => ({ ...current, phase: 'error', error: result.error, plan: null }));
          return;
        }
        setTransfer((current) => ({ ...current, phase: 'preview', plan: result.payload, error: null }));
      };

      /** Perform the confirmed import. */
      const applyImport = async () => {
        const raw = String(importText).trim();
        setTransfer((current) => ({ ...current, phase: 'applying', error: null }));
        setBusy(true);
        const query = `mode=${encodeURIComponent(importMode)}${sessionArg === null ? '' : `&session=${encodeURIComponent(sessionArg)}`}`;
        const result = await requestJson(`${IMPORT_PATH}?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        setBusy(false);
        if (!result.ok) {
          setTransfer((current) => ({ ...current, phase: 'error', error: result.error }));
          setNotice({ tone: 'error', text: `${errorText(t, result.error)} ${t('importUnchangedWarning')}` });
          return;
        }
        const totals = result.payload && result.payload.totals ? result.payload.totals : {};
        const count = (totals.added || 0) + (totals.replaced || 0) + (totals.removed || 0);
        setTransfer((current) => ({ ...current, phase: 'applied', plan: result.payload, error: null }));
        setNotice({
          tone: 'success',
          text: result.payload && result.payload.unchanged === true
            ? t('importUnchangedNotice')
            : fmt(t('importAppliedNotice'), {
                written: result.payload && Array.isArray(result.payload.written) ? result.payload.written.length : 0,
                count,
              }),
        });
        setReload((value) => value + 1);
      };

      /**
       * Revision 9: open or close variable substitution for「我的 Prompt」.
       *
       * The switch is written to the **selected layer**, and the value sent is
       * the negation of the *effective* one the host reported: the button says
       * "turn it off" whenever this session interpolates, so a click always
       * produces the state the label promised — even when the effective value
       * came from the other layer (a workspace layer that states nothing
       * inherits the user layer).
       *
       * A refusal is the host's own words (usually `unresolvable-variable`,
       * naming the stored text the write face will not accept): the panel shows the code and
       * the message rather than a generic failure, because the fix is in the
       * text box right below.
       */
      const toggleMineInterpolate = async () => {
        const layer = mineLayer;
        if (layer === 'workspace' && sessionArg === null) {
          setMineInterpolate({ kind: 'error', error: { code: 'workspace-unresolved' } });
          setNotice({ tone: 'error', text: errorText(t, { code: 'workspace-unresolved' }) });
          return;
        }
        const next = !mineInterpolateOn;
        setMineInterpolate({ kind: 'saving', error: null });
        setBusy(true);
        // The two-valued spelling on purpose: this is the shortcut that goes
        // between ON and "unstated", which is what makes on→off an exact byte
        // revert (§16.7). The explicit OFF is a separate, deliberate choice and
        // lives on the three-state control below.
        const body = { enabled: next, layer };
        if (sessionArg !== null) body.session = sessionArg;
        const result = await requestJson(INTERPOLATE_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy(false);
        if (!result.ok) {
          setMineInterpolate({ kind: 'error', error: result.error });
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        const applied = result.payload && result.payload.interpolateCustom === true;
        setMineWarnings(payloadWarnings(result.payload));
        setMineInterpolate({ kind: 'saved', error: null });
        setNotice({
          tone: 'success',
          text: fmt(t('mineInterpolateSaved'), { state: t(applied ? 'mineInterpolateOn' : 'mineInterpolateOff') }),
        });
        setReload((value) => value + 1);
      };

      /**
       * Revision 12 (audit F4): state one of the three values for the selected
       * layer — `inherit` (the key is removed), `on` (`true`) or `off` (the
       * boolean `false`).
       *
       * This is the control that makes「显式关」reachable at all: the two-valued
       * toggle can only return a layer to unstated, so a workspace layer could
       * never close the switch the user layer had opened, and the panel showed
       * OFF while the session really inherited ON.
       * @param choice - `inherit` | `on` | `off`.
       */
      const setMineInterpolateState = async (choice) => {
        const layer = mineLayer;
        const state = choice === 'on' || choice === 'off' ? choice : 'inherit';
        if (layer === 'workspace' && sessionArg === null) {
          setMineInterpolate({ kind: 'error', error: { code: 'workspace-unresolved' } });
          setNotice({ tone: 'error', text: errorText(t, { code: 'workspace-unresolved' }) });
          return;
        }
        setMineInterpolate({ kind: 'saving', error: null });
        setBusy(true);
        const body = { state, layer };
        if (sessionArg !== null) body.session = sessionArg;
        const result = await requestJson(INTERPOLATE_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy(false);
        if (!result.ok) {
          setMineInterpolate({ kind: 'error', error: result.error });
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        setMineWarnings(payloadWarnings(result.payload));
        setMineInterpolate({ kind: 'saved', error: null });
        setNotice({
          tone: 'success',
          text: fmt(t('mineInterpolateStateSaved'), {
            state: t(
              state === 'on' ? 'mineInterpolateSetOn' : state === 'off' ? 'mineInterpolateSetOff' : 'mineInterpolateSetInherit',
            ),
          }),
        });
        setReload((value) => value + 1);
      };

      /**
       * 「我的 Prompt」 save: `PUT /prompt-setting/overrides` with the reserved
       * name and `replace`, which is the entire write face since Revision 7
       * (§4.1). The text is sent exactly as typed — trimming someone's prompt
       * would be a silent edit of the thing they are configuring — and a
       * workspace write without a session is refused here, with the same code
       * the Host would answer, instead of being sent to be rejected.
       */
      const saveMine = async () => {
        const layer = mineLayer;
        if (layer === 'workspace' && sessionArg === null) {
          // The host would answer exactly this; refusing here keeps a known
          // answer from being turned into a round trip.
          setMineStatus({ kind: 'error', error: { code: 'workspace-unresolved' } });
          setNotice({ tone: 'error', text: errorText(t, { code: 'workspace-unresolved' }) });
          return;
        }
        setMineStatus({ kind: 'saving', error: null });
        setBusy(true);
        const body = {
          layer,
          section: { name: RESERVED_SECTION_NAME, action: RESERVED_SECTION_ACTION, text: mineText },
        };
        if (sessionArg !== null) body.session = sessionArg;
        const result = await requestJson(OVERRIDES_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy(false);
        if (!result.ok) {
          setMineWarnings([]);
          setMineStatus({ kind: 'error', error: result.error });
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        // Keep the draft: it is what was just written, so the box does not
        // flicker back to the stored value while the re-read is in flight.
        setMineDraft({ key: mineKey, text: mineText });
        // Revision 12 (audit F2): an accepted save may still carry advisories —
        // a registered reference the probe had no value for. They are shown, not
        // dropped, and they are not an error: the write did happen.
        setMineWarnings(payloadWarnings(result.payload));
        setMineStatus({ kind: 'saved', error: null });
        // g-021: the write succeeded, so the banner stays a success banner — but
        // in a frozen scope it may not read as bare success either. The notice is
        // the most visible surface on the page, so it carries the same condition
        // the panel's state line does.
        setNotice({
          tone: 'success',
          text: fmt(
            t(
              mineFrozenReason === null
                ? 'savedNotice'
                : mineFrozenCertain
                  ? 'savedNoticeFrozen'
                  : 'savedNoticeUnknown',
            ),
            { layer: layerLabel(t, layer) },
          ),
        });
        setReload((value) => value + 1);
      };

      /**
       * g-027: 「取消」 for 「我的 Prompt」 — drop the unsaved draft so the box
       * shows the layer's already stored text again. It is deliberately not a
       * write: no request, no disk byte, and unlike 「恢复默认」 nothing that was
       * ever stored is destroyed, so it asks nothing first. Resetting the draft
       * is the whole operation: a draft belongs to one layer+session key
       * (`mineKey`), so a draft typed for another key is left where it is, and
       * the state falls back to whatever the stored value says (`idle`, or
       * `unconfigured` for a layer that has none). Only reachable while the
       * panel is `dirty`, which excludes `saving` / `saved` / `error`.
       */
      const cancelMine = () => {
        setMineDraft(null);
      };

      /**
       * 「恢复默认」 for 「我的 Prompt」: the single-name `DELETE`, which since
       * Revision 7 is exactly the reserved section. Confirmed first (§12.1): it
       * destroys text the user wrote.
       */
      const resetMine = async () => {
        const layer = mineLayer;
        setMineStatus({ kind: 'saving', error: null });
        setBusy(true);
        const query = `${layerQuery(layer, sessionArg)}&name=${encodeURIComponent(RESERVED_SECTION_NAME)}`;
        const result = await requestJson(`${OVERRIDES_PATH}?${query}`, { method: 'DELETE' });
        setBusy(false);
        if (!result.ok) {
          setMineStatus({ kind: 'error', error: result.error });
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        setMineDraft(null);
        setMineStatus({ kind: 'idle', error: null });
        setNotice({
          tone: 'success',
          text: fmt(t('deletedNotice'), { layer: layerLabel(t, layer) }),
        });
        setReload((value) => value + 1);
      };

      /**
       * Clear one layer's frozen (non-reserved) overrides: `legacy=true`, which
       * keeps 「我的 Prompt」 (§12.2). The same shape as the layer reset, one
       * flag apart, so the two share this reporting path.
       */
      const clearLegacy = async (layer) => {
        setBusy(true);
        const result = await requestJson(`${OVERRIDES_PATH}?${layerQuery(layer, sessionArg)}&legacy=true`, { method: 'DELETE' });
        setBusy(false);
        if (!result.ok) {
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        const count = result.payload && typeof result.payload.count === 'number' ? result.payload.count : 0;
        setNotice({
          tone: 'success',
          text: count > 0 ? fmt(t('resetDoneNotice'), { count }) : t('resetNoneNotice'),
        });
        setReload((value) => value + 1);
      };

      /**
       * Close the「查看范围」picker after a scope was actually chosen (g-016):
       * picking a row, the current session, a typed id or 「全局」 is the end of
       * that interaction, so the summary comes back without a second click. It
       * is deliberately *not* called by the search box, the group headers or
       * 「显示更多」 — those browse the picker, they do not finish with it.
       */
      const closeScope = () => setScopeOpen(false);

      const actions = {
        refresh: () => setReload((value) => value + 1),
        // The「更改」switch: the same button opens and shuts the picker, and
        // `aria-expanded` on it reports which state it is in.
        toggleScopeOpen: () => setScopeOpen((open) => !open),
        setTab,
        setView,
        setMineLayer: (value) => {
          setMineLayer(value === 'workspace' ? 'workspace' : 'user');
          setMineWarnings([]);
          setMineStatus({ kind: 'idle', error: null });
        },
        setMineText: (event) => {
          const value = event && event.target ? String(event.target.value) : '';
          setMineDraft({ key: mineKey, text: value });
          setMineWarnings([]);
          setMineStatus({ kind: 'idle', error: null });
        },
        saveMine,
        cancelMine,
        toggleMineInterpolate,
        setMineInterpolateState,
        requestMineReset: () => setConfirm({ kind: 'mine-reset', layer: mineLayer }),
        setAdvancedLayer: (value) => setAdvancedLayer(value === 'workspace' ? 'workspace' : 'user'),
        setSearch: (event) => setSearch(event && event.target ? String(event.target.value) : ''),
        setManualId: (event) => setManualId(event && event.target ? String(event.target.value) : ''),
        setSessionQuery: (event) => {
          setSessionQuery(event && event.target ? String(event.target.value) : '');
          setSessionActive(-1);
        },
        // Expansion is local view state, keyed by the sidebar's own group key
        // (the workspace id, or '' for the ungrouped bucket). The effective
        // state is passed in, so the toggle is exact even when a search forced
        // a group open.
        toggleScope: (key, open) => setScopeExpanded((current) => ({ ...current, [key]: open })),
        // Keyboard parity for the pointer toggle: Enter and Space both flip the
        // workspace node, exactly like the sidebar's own tree rows.
        onScopeHeaderKeyDown: (event, key, open) => {
          const pressed = event && event.key ? String(event.key) : '';
          if (pressed !== 'Enter' && pressed !== ' ' && pressed !== 'Spacebar') return;
          if (typeof event.preventDefault === 'function') event.preventDefault();
          setScopeExpanded((current) => ({ ...current, [key]: open }));
        },
        setScopeHover,
        setScopeFocus,
        showMoreScope: (key) =>
          setScopeLimits((current) => {
            const value = Number.isInteger(current[key]) ? current[key] : SCOPE_GROUP_PAGE;
            return { ...current, [key]: Math.min(SCOPE_GROUP_MAX, value + SCOPE_GROUP_STEP) };
          }),
        pickSession: (id) => {
          setSelection(id);
          // The box reflects the selection: it refills with the readable title.
          setSessionQuery(sessionLabelOf(seat.rows, id));
          setSessionActive(-1);
          closeScope();
        },
        useCurrent: () => {
          if (seat.currentId.length === 0) return;
          setSelection(seat.currentId);
          setSessionQuery(sessionLabelOf(seat.rows, seat.currentId));
          setSessionActive(-1);
          closeScope();
        },
        useTypedId: () => {
          const id = sessionQuery.trim();
          if (id.length === 0) return;
          setSelection(id);
          setSessionActive(-1);
          closeScope();
        },
        onSessionKeyDown: (event) => {
          const key = event && event.key ? String(event.key) : '';
          if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            if (sessionVisible.length === 0) return;
            setSessionActive((index) => {
              const next = key === 'ArrowDown' ? index + 1 : index - 1;
              return Math.max(0, Math.min(next, sessionVisible.length - 1));
            });
            return;
          }
          if (key === 'Enter') {
            const picked = sessionVisible[sessionActive] || sessionVisible[0];
            if (picked) {
              setSelection(picked.id);
              setSessionQuery(sessionLabelOf(seat.rows, picked.id));
              setSessionActive(-1);
              closeScope();
              return;
            }
            const typed = sessionQuery.trim();
            if (typed.length > 0) {
              setSelection(typed);
              closeScope();
            }
            return;
          }
          if (key === 'Escape') {
            setSessionQuery('');
            setSessionActive(-1);
          }
        },
        applyManual: () => {
          setSelection(manualId.trim().length > 0 ? manualId.trim() : GLOBAL_SESSION);
          closeScope();
        },
        useGlobal: () => {
          setSelection(GLOBAL_SESSION);
          setSessionQuery('');
          setSessionActive(-1);
          closeScope();
        },
        setLayerFilter: (value) => setFilters((current) => ({ ...current, layer: value })),
        setOverridableFilter: (value) => setFilters((current) => ({ ...current, overridable: value })),
        setOriginFilter: (value) => setFilters((current) => ({ ...current, origin: value })),
        setFullOrigin,
        toggleExpanded: (name) => setExpanded((current) => (current === name ? '' : name)),
        setHistoryLayer: (value) => {
          setHistoryLayer(value === 'workspace' ? 'workspace' : 'user');
          setDiff({ phase: 'idle', data: null, error: null });
        },
        pickDiffSide: (side, id) => {
          const next = { ...diffSel, [side]: id };
          setDiffSel(next);
          void runDiff(next.from, next.to);
        },
        requestResetLayer: (layer, count) => setConfirm({ kind: 'reset-layer', layer, count }),
        requestLegacyClear: (layer, count) => setConfirm({ kind: 'legacy-clear', layer, count }),
        cancelConfirm: () => setConfirm(null),
        confirmYes: async () => {
          const pending = confirm;
          if (pending === null) return;
          setConfirm(null);
          if (pending.kind === 'mine-reset') {
            await resetMine();
            return;
          }
          if (pending.kind === 'legacy-clear') {
            await clearLegacy(pending.layer);
            return;
          }
          if (pending.kind === 'reset-layer') {
            await resetLayer(pending.layer);
            return;
          }
          await applyImport();
        },
        exportNow,
        setImportText: (event) => {
          setImportText(event && event.target ? String(event.target.value) : '');
          setTransfer((current) => ({ ...current, phase: 'idle', plan: null, error: null }));
        },
        setImportMode: (value) => {
          setImportMode(value === 'replace' ? 'replace' : 'merge');
          setTransfer((current) => ({ ...current, plan: null, error: null, phase: 'idle' }));
        },
        pickImportFile,
        previewImport,
        requestImportApply: () => setConfirm({ kind: 'import' }),
        copy: async () => {
          const text =
            fullOrigin === 'all' ? String(snapshot && snapshot.rendered ? snapshot.rendered : '') : composeSections(effectiveSections, fullOrigin);
          const copied = await copyText(text);
          setNotice({ tone: copied ? 'success' : 'error', text: copied ? t('copied') : t('copyFail') });
        },
      };

      const model = {
        seat,
        wsSeat,
        scopeMode,
        scope,
        scopeOpen,
        scopeHover,
        scopeFocus,
        session,
        sessionArg,
        sessionQuery,
        sessionActive,
        sessionMatches,
        sessionVisible,
        manualId,
        tab,
        mineLayer,
        mineText,
        mineConfigured,
        mineState,
        mineError: mineStatus.error,
        mineInterpolateOn,
        mineInterpolateStated,
        mineInterpolateState,
        mineInterpolateLocked,
        mineInterpolateStatus: mineInterpolate,
        mineWarnings,
        mineLayerDisabled,
        mineFrozenReason,
        mineFrozenCertain,
        advancedLayer,
        view,
        search,
        filters,
        fullOrigin,
        expanded,
        snap,
        ovs,
        notice,
        busy,
        hist,
        historyLayer,
        diffSel,
        diff,
        confirm,
        transfer,
        importText,
        importMode,
        boot,
        fz,
        effectiveSections,
        incoming,
        phase,
        passesFilters: (section) => {
          if (filters.layer !== 'all' && sectionLayer(section) !== filters.layer) return false;
          if (filters.overridable === 'yes' && section.overridable !== true) return false;
          if (filters.overridable === 'no' && section.overridable !== false) return false;
          if (filters.origin !== 'all' && originOf(section) !== filters.origin) return false;
          return true;
        },
      };

      try {
        return renderSection(t, model, actions);
      } catch (error) {
        return renderFailureCard(t, error);
      }
    }

    /**
     * Last-resort card, rendered when building the page tree itself throws.
     * It carries the same `data-plugin` / `data-renderer` / `data-render-state`
     * markers as the real page — plus `data-build` and `data-plugin-version`,
     * both `unknown` because nothing was asked — so a broken render is still
     * machine-visible, and it shows the error text so the settings panel is
     * never blank.
     * @param t - candidate translator; may itself be what broke.
     * @param error - the thrown value.
     * @returns the failure card element.
     */
    function renderFailureCard(t, error) {
      const message = error && error.message ? String(error.message) : String(error);
      return h(
        'div',
        {
          'data-plugin': 'dsh-prompt-setting',
          'data-renderer': RENDERER,
          'data-render-state': 'error',
          // The failure card cannot ask the host anything (that is the point of
          // it), but it can still say which bundle it is: the self-digest needs
          // no transport and is exactly what a broken page is asked about.
          'data-build': SELF_BUILD && typeof SELF_BUILD.hash === 'string' ? SELF_BUILD.hash : 'unknown',
          // g-029: no ping can have answered here, so the version is honestly
          // `unknown`. Every root container carries the marker — a probe must
          // never have to know which render state *should* carry it.
          'data-plugin-version': 'unknown',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxWidth: 860,
            color: token.labelPrimary,
          },
        },
        h(
          'h2',
          { style: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '26px' } },
          safeT(t, 'renderErrorTitle', 'Prompt settings — render failure'),
        ),
        h(
          'p',
          { style: { margin: 0, fontSize: 13, color: token.stateError, wordBreak: 'break-word' } },
          `${safeT(t, 'renderErrorLabel', 'Error')}: ${message}`,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Every locale call is guarded. `ctx.locale.subscribe` and
        // `getSnapshot().revision` are the one unproven part of the 0.1.7-rc.2
        // client contract (NOTES.md §7), and a throw from either would happen
        // *during render* — React would then unmount the whole settings
        // subtree and the panel would go blank. Losing live language switching
        // is an acceptable degradation; a white screen is not.
        const locale = ctx.locale;
        const t = typeof locale?.bind === 'function' ? locale.bind(NS) : (key) => key;
        fallbackT = t;
        ctx.effect(
          () =>
            typeof locale?.register === 'function' ? locale.register(NS, { zh, en }) : undefined,
          'prompt-setting: section dictionaries',
        );

        const canSubscribe = typeof locale?.subscribe === 'function';
        const canReadRevision = typeof locale?.getSnapshot === 'function';

        // Built once so `React.useSyncExternalStore` sees stable identities.
        const face = {
          subscribeLocale: (listener) => {
            if (!canSubscribe) return noopSubscribe();
            try {
              const unsubscribe = locale.subscribe(listener);
              return typeof unsubscribe === 'function' ? unsubscribe : noopSubscribe();
            } catch {
              return noopSubscribe();
            }
          },
          getLocaleRevision: () => {
            if (!canReadRevision) return zeroRevision();
            try {
              return locale.getSnapshot()?.revision ?? zeroRevision();
            } catch {
              return zeroRevision();
            }
          },
        };

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'prompt-setting',
              // Existing orders: account -10, general 0, models 10, plugins 15,
              // agent-presets 20 — 30 appends without touching any of them.
              order: 30,
              label: () => t('nav'),
              locale: NS,
              inject: () => face,
            },
            PromptSettingSection,
          ),
        );
      },
    };
    }

    /**
     * The last resort when {@link buildPlugin} throws: say so once, then publish
     * whatever can still be published.
     *
     * Nothing here may throw — that is the whole point — so every step is
     * guarded and the return value is always a valid descriptor. When `react`
     * itself is what failed there is nothing to render a card *with*, so nothing
     * is registered at all: an empty plugin leaves the settings panel without a
     * Prompt section, and the console line is the only trace (that is the honest
     * degradation, not a blank panel).
     *
     * The card's text is intentionally not localized: the dictionaries and the
     * locale binding are part of the body that just failed to build, and a
     * diagnostic line is worth more than a translation here (NOTES.md §91).
     * @param require - the loader's require.
     * @param error - the thrown value.
     * @returns a plugin descriptor: degraded, never broken.
     */
    function degradedPlugin(require, error) {
      const cause = error && error.message ? String(error.message).split('\n')[0] : String(error);
      const line =
        '[dsh-prompt-setting] 客户端半加载失败：设置页将以降级提示卡呈现，DSH 其余功能不受影响。'
        + `首因：${cause}。排查见 README「出问题时」。`;
      try {
        if (typeof console !== 'undefined' && typeof console.error === 'function') console.error(line);
      } catch {
        // No usable console: the failure goes unrecorded, but the page boots.
      }

      let React = null;
      try {
        React = require('react');
      } catch {
        React = null;
      }
      if (React === null || typeof React !== 'object' || typeof React.createElement !== 'function') {
        // No React: registering anything would throw while the host renders it,
        // which would be worse than registering nothing at all.
        return { inject: [], apply() {} };
      }
      const h = React.createElement;

      /**
       * The degraded settings section: same machine markers as the real page, so
       * a browser-side check can still see that this plugin is the one that
       * failed — `data-build` and `data-plugin-version` included, each `unknown`.
       * @returns the failure card element.
       */
      function PromptSettingFailureSection() {
        return h(
          'div',
          {
            'data-plugin': 'dsh-prompt-setting',
            'data-renderer': 'none',
            'data-render-state': 'error',
            'data-build': 'unknown',
            // g-029: the same marker the real page and the render-failure card
            // carry, for the same reason — a probe reads one attribute, not a
            // map of which render state carries which marker.
            'data-plugin-version': 'unknown',
            style: { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 860 },
          },
          h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '26px' } },
            'Prompt settings — load failure'),
          h('p', { style: { margin: 0, fontSize: 13, wordBreak: 'break-word' } }, line),
        );
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          // Registering the card is best effort: it must not throw back into the
          // loader either.
          try {
            ctx.slots.inject('settings.section', () => ctx.slots.register({
              name: 'settings.section',
              id: 'prompt-setting',
              order: 30,
              label: () => 'Prompt settings',
              inject: () => ({}),
            }, PromptSettingFailureSection));
          } catch {
            // A host that will not take the card still boots.
          }
        },
      };
    }
    /* @build-fingerprint:end */
  },
});

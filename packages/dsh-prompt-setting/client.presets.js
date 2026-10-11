/**
 * `dsh-prompt-setting` — client chunk: the 「预设」 tab (g-060).
 *
 * This file is **not** a build product: it is published as it is, discovered by
 * the DSH client module loader (the file name matches `client.*.js` and it sits
 * next to `client.js`), registered with `chunk: 'client.presets.js'` and fetched
 * on demand by the main bundle through `require.async('./client.presets.js')`,
 * behind `React.lazy` — so a page that never opens the tab pays nothing for it.
 *
 * Direction of the two `require` edges (never a cycle):
 *   - main → chunk: `require.async` (asynchronous, at tab open time);
 *   - chunk → main: `require('dsh-prompt-setting')` (the main factory is
 *     already materialized by then; it hands over this chunk's half of the
 *     page's shared facilities — see `__internals.shared`).
 *
 * What this tab is, and what it deliberately is not (`CONTRACT.md` §20.9): it is
 * the **catalogue** — list, create, edit, delete — plus two layer actions on a
 * workspace the reader picks (apply, cancel). It never edits the reserved
 * section through `PUT /overrides`, never sends a layer name, and never writes a
 * file from the catalogue routes; the two writes it does perform go through
 * `POST /presets/apply` and `POST /presets/unapply`, which is where the layer is
 * resolved and snapshotted.
 *
 * Two hard rules are inherited from `client.js`:
 *   - no bundler, no JSX, no TypeScript, no runtime dependency beyond `react`;
 *   - the byte range between the two marker comments below is this chunk's
 *     fingerprint region, and everything this file *does* happens inside it, so
 *     a change to any of these bytes moves the digest the page compares against
 *     the host's (`CONTRACT.md` §14).
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-setting',
  chunk: 'client.presets.js',
  // A *named function expression*, so the chunk can fingerprint the very bytes
  // it is running and hand that digest back to the main bundle.
  factory: function promptSettingPresetsChunkFactory(require) {
    /* @build-fingerprint:begin */
    // #region shared facilities
    const shared = require('dsh-prompt-setting').__internals.shared;
    const h = shared.h;
    const token = shared.token;
    const UI = shared.UI;
    const fmt = shared.fmt;
    const tabs = shared.tabs;
    const cardStyle = shared.cardStyle;
    const metaStyle = shared.metaStyle;
    const headingStyle = shared.headingStyle;
    const errorBanner = shared.errorBanner;
    /**
     * This chunk's own digest, computed from `toString()` against the same
     * markers the host reads out of this file.
     */
    const SELF_BUILD = shared.fingerprintOf(promptSettingPresetsChunkFactory.toString());
    // #endregion

    /** How much of a preset's text a list row previews before it is cut off. */
    const PRESET_PREVIEW_LENGTH = 120;
    /** How many rows the workspace picker renders at once. */
    const PRESET_WORKSPACE_LIMIT = 50;

    /**
     * The `replace` / `append` pair, as the segmented control wants it.
     * @param t - the bound translator.
     * @returns the tab items.
     */
    function modeItems(t) {
      return [
        { value: 'replace', label: t('presetModeReplace'), id: 'ps-preset-mode-replace', panelId: 'ps-preset-panel' },
        { value: 'append', label: t('presetModeAppend'), id: 'ps-preset-mode-append', panelId: 'ps-preset-panel' },
      ];
    }

    /**
     * One line of a preset's text, bounded so a 200 KiB text cannot grow a row.
     * @param text - the stored text.
     * @returns the preview.
     */
    function previewOf(text) {
      const value = typeof text === 'string' ? text : '';
      return value.length > PRESET_PREVIEW_LENGTH ? `${value.slice(0, PRESET_PREVIEW_LENGTH)}…` : value;
    }

    /**
     * One stored preset as a row.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @param preset - the stored preset.
     * @returns the row element.
     */
    function presetRow(t, m, a, preset) {
      const selected = m.presetDraft.id === preset.id;
      return h(
        'div',
        {
          key: preset.id,
          'data-preset-id': preset.id,
          'data-preset-selected': String(selected),
          style: {
            ...cardStyle,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            borderColor: selected ? token.stateBusiness : undefined,
          },
        },
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: 13, fontWeight: 600, wordBreak: 'break-word' } }, preset.name),
          h(UI.Tag, { tone: preset.action === 'append' ? 'info' : 'neutral' },
            preset.action === 'append' ? t('presetModeAppend') : t('presetModeReplace')),
        ),
        h(
          'pre',
          {
            'data-role': 'preset-preview',
            style: {
              margin: 0,
              fontFamily: 'inherit',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: token.labelSecondary,
            },
          },
          previewOf(preset.text),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(
            UI.Button,
            {
              variant: 'outline',
              'data-action': 'preset-edit',
              'data-preset-id': preset.id,
              onClick: () => a.editPreset(preset.id),
            },
            t('presetEdit'),
          ),
          h(
            UI.Button,
            {
              variant: 'outline',
              'data-action': 'preset-delete',
              'data-preset-id': preset.id,
              disabled: m.busy,
              onClick: () => a.deletePreset(preset.id),
            },
            t('presetDelete'),
          ),
        ),
      );
    }

    /**
     * The catalogue: the stored presets, or the reason there are none to show.
     *
     * An unreadable library is stated as a library problem and **not** as an
     * empty catalogue (`CONTRACT.md` §20.9): the two look identical on screen
     * otherwise, and only one of them is the user's own doing.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the list element.
     */
    function presetsList(t, m, a) {
      const payload = m.presets.data;
      const presets = payload && Array.isArray(payload.presets) ? payload.presets : [];
      const libraryError = payload && payload.error ? payload.error : null;
      return h(
        'div',
        { 'data-region': 'presets-list', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('h4', { style: { ...headingStyle, fontSize: 13 } }, t('presetsListHeading')),
        libraryError !== null
          ? h(
              'div',
              {
                'data-warning': 'presets-library-error',
                'data-preset-library-error': libraryError.code,
                style: { ...cardStyle, borderColor: token.stateError, fontSize: 12, color: token.stateError, wordBreak: 'break-word' },
              },
              `${t('presetsLibraryError')} — ${libraryError.code}: ${libraryError.message}`,
            )
          : null,
        presets.length === 0 && libraryError === null
          ? h('p', { 'data-region': 'presets-empty', style: { margin: 0, ...metaStyle } }, t('presetsEmpty'))
          : presets.map((preset) => presetRow(t, m, a, preset)),
      );
    }

    /**
     * The editor: the draft the two catalogue writes send.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the editor element.
     */
    function presetEditor(t, m, a) {
      const draft = m.presetDraft;
      const editing = draft.id !== null;
      return h(
        'div',
        {
          'data-region': 'preset-editor',
          'data-preset-editing': editing ? draft.id : 'new',
          style: { ...cardStyle, display: 'flex', flexDirection: 'column', gap: 8 },
        },
        h('h4', { style: { ...headingStyle, fontSize: 13 } }, editing ? t('presetEditHeading') : t('presetNewHeading')),
        h('label', { style: metaStyle, htmlFor: 'ps-preset-name' }, t('presetNameLabel')),
        h(UI.Input, {
          id: 'ps-preset-name',
          'data-role': 'preset-name',
          value: draft.name,
          placeholder: t('presetNamePlaceholder'),
          onChange: a.setPresetName,
        }),
        h('span', { style: metaStyle }, t('presetModeLabel')),
        tabs(modeItems(t), draft.action, a.setPresetAction, t('presetModeLabel'), 'preset-mode'),
        h('label', { style: metaStyle, htmlFor: 'ps-preset-text' }, t('presetTextLabel')),
        h(UI.Textarea, {
          id: 'ps-preset-text',
          'data-role': 'preset-text',
          value: draft.text,
          placeholder: t('presetTextPlaceholder'),
          rows: 8,
          onChange: a.setPresetText,
        }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(
            UI.Button,
            {
              variant: 'primary',
              'data-action': 'preset-save',
              disabled: m.busy,
              onClick: () => a.savePreset(),
            },
            editing ? t('presetSaveEdit') : t('presetSaveNew'),
          ),
          h(
            UI.Button,
            { variant: 'outline', 'data-action': 'preset-new', onClick: a.newPreset },
            t('presetNew'),
          ),
          h(
            UI.Button,
            {
              variant: 'outline',
              'data-action': 'preset-save-as-current',
              disabled: m.presetCurrentText.length === 0,
              onClick: a.saveAsCurrentPreset,
            },
            t('presetSaveAsCurrent'),
          ),
        ),
        h('p', { style: { margin: 0, ...metaStyle } }, t('presetSaveAsCurrentHint')),
      );
    }

    /**
     * The workspace picker: the sessions this page can name, with the applied
     * state of each.
     *
     * The Host has no workspace-list route (`CONTRACT.md` §4.2), so the picker
     * offers what the page already knows: one row per workspace from the
     * workspace seat, each carrying its first session id — the identity the
     * apply/unapply routes need. A profile without that seat degrades to the
     * session list, and a row whose workspace root is unknown simply states no
     * applied state rather than guessing one.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the picker element.
     */
    function presetWorkspacePicker(t, m, a) {
      const rows = m.presetWorkspaces;
      const applied = m.presets.data && Array.isArray(m.presets.data.applied) ? m.presets.data.applied : [];
      const selectedId = m.presetDraft.id;
      // g-060 (review R1): 「应用」 names a preset by id and the host reads that
      // preset out of the library, so an unsaved edit in the box would make the
      // page write the *stored* version and call it success. The picker therefore
      // states which of the two reasons blocks the action, and the buttons follow
      // the same value — never a silently stale apply.
      const blocked = selectedId === null ? 'no-preset' : m.presetDirty === true ? 'unsaved' : null;
      return h(
        'div',
        { 'data-region': 'preset-workspace', style: { ...cardStyle, display: 'flex', flexDirection: 'column', gap: 8 } },
        h('h4', { style: { ...headingStyle, fontSize: 13 } }, t('presetWorkspaceHeading')),
        h('p', { style: { margin: 0, ...metaStyle } }, t('presetWorkspaceNote')),
        blocked === null
          ? null
          : h(
              'p',
              {
                'data-preset-apply-blocked': blocked,
                style: { margin: 0, ...metaStyle, color: blocked === 'unsaved' ? token.stateWarn : undefined },
              },
              t(blocked === 'unsaved' ? 'presetApplyUnsaved' : 'presetApplyPickOne'),
            ),
        rows.length === 0
          ? h('p', { 'data-region': 'preset-workspace-empty', style: { margin: 0, ...metaStyle } }, t('presetWorkspaceEmpty'))
          : rows.slice(0, PRESET_WORKSPACE_LIMIT).map((row) => {
            const record = row.root === null
              ? null
              : applied.find((entry) => entry.workspaceRoot === row.root) ?? null;
            const isSelected = m.presetWorkspace === row.session;
            return h(
              'div',
              {
                key: row.session,
                'data-preset-session': row.session,
                'data-preset-workspace-root': row.root === null ? 'unknown' : row.root,
                'data-preset-applied': record === null ? 'false' : 'true',
                'data-preset-orphan': record !== null && record.orphan === true ? 'true' : 'false',
                'data-preset-workspace-selected': String(isSelected),
                style: {
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  borderTop: `1px solid ${token.borderL2}`,
                  paddingTop: 6,
                },
              },
              h(
                'button',
                {
                  type: 'button',
                  'data-action': 'preset-workspace-pick',
                  'data-preset-session': row.session,
                  'aria-pressed': String(isSelected),
                  style: {
                    font: 'inherit',
                    fontSize: 12,
                    padding: '2px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: isSelected ? token.hoverFill : 'transparent',
                    color: token.labelPrimary,
                    border: `1px solid ${token.borderL2}`,
                  },
                  onClick: () => a.setPresetWorkspace(row.session),
                },
                row.label,
              ),
              record === null
                ? h('span', { 'data-preset-name': '', style: metaStyle }, t('presetNotApplied'))
                : h(
                    'span',
                    { 'data-preset-name': record.presetName === null ? '' : record.presetName, style: metaStyle },
                    record.orphan === true
                      ? `${t('presetAppliedOrphan')}: ${record.presetId}`
                      : fmt(t('presetAppliedAs'), { name: record.presetName === null ? record.presetId : record.presetName }),
                  ),
              h(
                UI.Button,
                {
                  variant: 'outline',
                  'data-action': 'preset-apply',
                  'data-preset-session': row.session,
                  disabled: m.busy || blocked !== null,
                  onClick: () => a.applyPreset(selectedId, row.session),
                },
                t('presetApply'),
              ),
              h(
                UI.Button,
                {
                  variant: 'outline',
                  'data-action': 'preset-unapply',
                  'data-preset-session': row.session,
                  disabled: m.busy || record === null,
                  onClick: () => a.unapplyPreset(row.session),
                },
                t('presetUnapply'),
              ),
            );
          }),
      );
    }

    /**
     * The 「预设」 tab.
     *
     * Reads `GET /presets` through the page model and writes through the four
     * catalogue/apply routes only (§20.3–§20.6). The state line is the same
     * shape the 「我的 Prompt」 panel uses, so a reader recognises it.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the tab element.
     */
    function renderPresetsPanel(t, m, a) {
      const kind = m.presetStatus.kind;
      const state =
        kind === 'saving' ? 'saving' : kind === 'saved' ? 'saved' : kind === 'error' ? 'error' : 'idle';
      const stateText =
        state === 'saving'
          ? t('presetSaving')
          : state === 'saved'
            ? t('presetSaved')
            : state === 'error'
              ? t('presetFailed')
              : m.presets.phase === 'loading'
                ? t('loading')
                : t('presetLoaded');
      return h(
        'div',
        { 'data-region': 'presets', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('h3', { style: headingStyle }, t('presetsHeading')),
        h('p', { style: { margin: 0, ...metaStyle } }, t('presetsNote')),
        h(
          'p',
          {
            'data-region': 'presets-state',
            'data-preset-state': state,
            style: { margin: 0, ...metaStyle, color: state === 'error' ? token.stateError : token.labelSecondary },
          },
          stateText,
        ),
        m.presetStatus.error !== null
          ? errorBanner(t, m.presetStatus.error, t('presetFailed'))
          : null,
        m.presets.phase === 'error'
          ? errorBanner(t, m.presets.error, t('loadFailed'))
          : null,
        presetsList(t, m, a),
        presetEditor(t, m, a),
        presetWorkspacePicker(t, m, a),
      );
    }

    /**
     * The lazy boundary the main bundle mounts for this tab.
     * @param props - the main bundle's page model, actions and translator.
     * @returns the tab element.
     */
    function PresetsTab(props) {
      return renderPresetsPanel(props.t, props.m, props.a);
    }

    return { PresetsTab, build: SELF_BUILD };
    /* @build-fingerprint:end */
  },
});

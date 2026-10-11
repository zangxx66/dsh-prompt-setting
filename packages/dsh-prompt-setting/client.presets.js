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
 * Shape of the tab (`CONTRACT.md` §20.9, Revision 38 / review R3): the body is
 * the **catalogue** — a heading, a state line and one row per stored preset
 * (mode tag, text preview, 「编辑」/「删除」/「应用到工作区」) plus a「新建预设」
 * entry. Both writes the tab can start happen in **overlays**, laid out like
 * `renderRegionDialog` in `client.js`:
 *   - the editor dialog (`data-region="preset-editor-dialog"`) holds the
 *     name/text/mode fields; a refusal stays **inside** it and never closes it,
 *     and a dirty draft makes the close control say「放弃修改」with a visible
 *     warning, so nothing is discarded silently;
 *   - the apply dialog (`data-region="preset-apply-dialog"`) is opened from one
 *     list row and names that row's preset; it lists every workspace the page
 *     knows with its applied state and the two layer actions.
 *
 * What the tab deliberately is not: it never edits the reserved section through
 * `PUT /overrides`, never sends a layer name, and never writes a file from the
 * catalogue routes — the two layer writes go through `POST /presets/apply` and
 * `POST /presets/unapply`, which is where the host resolves and snapshots.
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
    const errorText = shared.errorText;
    /**
     * This chunk's own digest, computed from `toString()` against the same
     * markers the host reads out of this file.
     */
    const SELF_BUILD = shared.fingerprintOf(promptSettingPresetsChunkFactory.toString());
    // #endregion

    /** How much of a preset's text a list row previews before it is cut off. */
    const PRESET_PREVIEW_LENGTH = 120;
    /** How many workspace rows the apply dialog renders at once. */
    const PRESET_WORKSPACE_LIMIT = 50;
    /**
     * The overlay backdrop, copied from `client.js`'s `renderRegionDialog` (the
     * project's own dialog precedent): one full-screen scrim that dims the page
     * behind the card, so a dialog reads as modal without stealing focus.
     */
    const OVERLAY_STYLE = {
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
    };
    /** The dialog card inside the scrim; scrolls when a workspace list is long. */
    const DIALOG_STYLE = {
      ...cardStyle,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      width: '100%',
      maxWidth: 520,
      maxHeight: '80vh',
      overflow: 'auto',
      padding: '16px 18px',
      boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
    };
    /** The dialog's title line. */
    const DIALOG_TITLE_STYLE = { fontSize: 15, fontWeight: 600 };
    /** The dialog's button row. */
    const DIALOG_ACTIONS_STYLE = { display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' };

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
     * The dialog's error line, or `null` when the last write did not fail.
     *
     * Review R3: a refusal is rendered **here** — inside the open dialog, on its
     * own marked line — never through the page-level notice, which would sit
     * behind the scrim and read as "nothing happened".
     * @param t - the bound translator.
     * @param m - the page model.
     * @returns the line element, or null.
     */
    function dialogError(t, m) {
      const error = m.presetStatus.kind === 'error' ? m.presetStatus.error : null;
      if (error === null || error === undefined) return null;
      return h(
        'div',
        {
          'data-role': 'preset-dialog-error',
          'data-preset-dialog-error': typeof error.code === 'string' ? error.code : 'unknown',
          style: { fontSize: 13, color: token.stateError, wordBreak: 'break-word' },
        },
        `${t('presetFailed')}: ${errorText(t, error)}`,
      );
    }

    /**
     * One stored preset as a catalogue row.
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
              // Review R4: the button only *asks* — the DELETE is sent by the
              // page's shared confirmation overlay, never on the click itself.
              onClick: () => a.requestPresetDelete(preset.id),
            },
            t('presetDelete'),
          ),
          // Review R3: the layer action's entrance. It opens the apply dialog
          // **on this row's id**, so what gets applied is always the preset the
          // reader pointed at — never "whatever the editor happens to hold".
          h(
            UI.Button,
            {
              variant: 'outline',
              'data-action': 'preset-apply-to',
              'data-preset-id': preset.id,
              disabled: m.busy,
              onClick: () => a.requestPresetApplyTo(preset.id),
            },
            t('presetApplyTo'),
          ),
        ),
      );
    }

    /**
     * The catalogue: the stored presets, the reason there are none to show, and
     * the two「新建」entrances.
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
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('h4', { style: { ...headingStyle, fontSize: 13, margin: 0 } }, t('presetsListHeading')),
          h(
            UI.Button,
            {
              variant: 'outline',
              'data-action': 'preset-new',
              disabled: m.busy,
              onClick: a.newPreset,
            },
            t('presetNewHeading'),
          ),
          h(
            UI.Button,
            {
              variant: 'outline',
              'data-action': 'preset-save-as-current',
              disabled: m.busy || m.presetCurrentText.length === 0,
              onClick: a.saveAsCurrentPreset,
            },
            t('presetSaveAsCurrent'),
          ),
        ),
        h('p', { style: { margin: 0, ...metaStyle } }, t('presetSaveAsCurrentHint')),
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
     * The editor dialog: the draft both catalogue writes send.
     *
     * Three rules are copied from `client.js`'s `renderRegionDialog` (review R3):
     * a refusal stays **inside** the dialog on its own marked line, the dialog is
     * **not** closed by a failure, and closing is always an explicit act — while
     * the draft differs from what the library holds, that act is labelled
     * 「放弃修改」and the dialog says so in words, so nothing is discarded
     * silently.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the overlay element, or `null` when this dialog is not open.
     */
    function presetEditorDialog(t, m, a) {
      const dialog = m.presetDialog;
      if (dialog === null || dialog.kind !== 'edit') return null;
      const editing = m.presetDraft.id;
      const dirty = m.presetDraftDirty === true;
      const saving = m.presetStatus.kind === 'saving';
      const title = editing === null ? t('presetNewHeading') : t('presetEditHeading');
      return h(
        'div',
        { key: 'preset-editor-overlay', 'data-region': 'preset-editor-overlay', style: OVERLAY_STYLE },
        h(
          'div',
          {
            'data-region': 'preset-editor-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
            'data-preset-dialog': 'edit',
            'data-preset-editing': editing === null ? 'new' : editing,
            'data-preset-dirty': String(dirty),
            style: DIALOG_STYLE,
          },
          h('strong', { style: DIALOG_TITLE_STYLE }, title),
          h('label', { style: metaStyle, htmlFor: 'ps-preset-name' }, t('presetNameLabel')),
          h(UI.Input, {
            id: 'ps-preset-name',
            'data-role': 'preset-name',
            value: m.presetDraft.name,
            placeholder: t('presetNamePlaceholder'),
            disabled: saving,
            onChange: a.setPresetName,
          }),
          h('span', { style: metaStyle }, t('presetModeLabel')),
          tabs(modeItems(t), m.presetDraft.action, a.setPresetAction, t('presetModeLabel'), 'preset-mode'),
          h('label', { style: metaStyle, htmlFor: 'ps-preset-text' }, t('presetTextLabel')),
          h(UI.Textarea, {
            id: 'ps-preset-text',
            'data-role': 'preset-text',
            value: m.presetDraft.text,
            placeholder: t('presetTextPlaceholder'),
            rows: 8,
            disabled: saving,
            onChange: a.setPresetText,
          }),
          dirty
            ? h(
                'p',
                { 'data-role': 'preset-dialog-dirty', style: { margin: 0, ...metaStyle, color: token.stateWarn } },
                t('presetDialogDirtyHint'),
              )
            : null,
          dialogError(t, m),
          h(
            'div',
            { 'data-role': 'preset-dialog-actions', style: DIALOG_ACTIONS_STYLE },
            h(
              UI.Button,
              {
                variant: 'primary',
                'data-action': 'preset-save',
                disabled: m.busy || saving,
                onClick: () => a.savePreset(),
              },
              editing === null ? t('presetSaveNew') : t('presetSaveEdit'),
            ),
            h(
              UI.Button,
              {
                'data-action': 'preset-dialog-close',
                'data-preset-dirty': String(dirty),
                disabled: m.busy || saving,
                // Review R4: a dirty draft is confirmed first (through the shared
                // overlay); a clean one closes straight away.
                onClick: a.requestPresetDialogClose,
              },
              dirty ? t('presetDialogDiscard') : t('presetDialogClose'),
            ),
          ),
        ),
      );
    }

    /**
     * One workspace row inside the apply dialog.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @param row - `{session, root, label}` from the page model.
     * @param record - the `applied` record for this root, or null.
     * @param presetId - the preset this dialog is applying.
     * @returns the row element.
     */
    function presetWorkspaceRow(t, m, a, row, record, presetId) {
      return h(
        'div',
        {
          key: row.session,
          'data-preset-session': row.session,
          'data-preset-workspace-root': row.root === null ? 'unknown' : row.root,
          'data-preset-applied': record === null ? 'false' : 'true',
          'data-preset-orphan': record !== null && record.orphan === true ? 'true' : 'false',
          'data-preset-name': record === null || record.presetName === null ? '' : record.presetName,
          style: {
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            borderTop: `1px solid ${token.borderL2}`,
            paddingTop: 6,
          },
        },
        h('span', { style: { fontSize: 12, color: token.labelPrimary, wordBreak: 'break-word' } }, row.label),
        record === null
          ? h('span', { style: metaStyle }, t('presetNotApplied'))
          : h(
              'span',
              { style: metaStyle },
              record.orphan === true
                ? `${t('presetAppliedOrphan')}: ${record.presetId}`
                : fmt(t('presetAppliedAs'), { name: record.presetName === null ? record.presetId : record.presetName }),
            ),
        h(
          UI.Button,
          {
            variant: 'outline',
            'data-action': 'preset-apply',
            'data-preset-id': presetId,
            'data-preset-session': row.session,
            disabled: m.busy,
            onClick: () => a.applyPreset(presetId, row.session),
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
    }

    /**
     * The apply dialog: which preset is being applied, and to which workspace.
     *
     * It is opened from one list row and names that row's preset, and it states
     * in words that the version **stored in the library** is what gets written
     * (`CONTRACT.md` §20.5): an unsaved edit lives in the other dialog and is
     * never what a layer write stores.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the overlay element, or `null` when this dialog is not open.
     */
    function presetApplyDialog(t, m, a) {
      const dialog = m.presetDialog;
      if (dialog === null || dialog.kind !== 'apply') return null;
      const list = m.presets.data && Array.isArray(m.presets.data.presets) ? m.presets.data.presets : [];
      const preset = list.find((entry) => entry.id === dialog.presetId) ?? null;
      const name = preset === null ? dialog.presetId : preset.name;
      const applied = m.presets.data && Array.isArray(m.presets.data.applied) ? m.presets.data.applied : [];
      const rows = m.presetWorkspaces;
      return h(
        'div',
        { key: 'preset-apply-overlay', 'data-region': 'preset-apply-overlay', style: OVERLAY_STYLE },
        h(
          'div',
          {
            'data-region': 'preset-apply-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': fmt(t('presetApplyToTitle'), { name }),
            'data-preset-dialog': 'apply',
            'data-preset-dialog-preset': dialog.presetId,
            style: DIALOG_STYLE,
          },
          h('strong', { style: DIALOG_TITLE_STYLE }, fmt(t('presetApplyToTitle'), { name })),
          h('p', { style: { margin: 0, ...metaStyle } }, t('presetApplyToNote')),
          rows.length === 0
            ? h('p', { 'data-region': 'preset-workspace-empty', style: { margin: 0, ...metaStyle } }, t('presetWorkspaceEmpty'))
            : rows.slice(0, PRESET_WORKSPACE_LIMIT).map((row) => {
              const record = row.root === null
                ? null
                : applied.find((entry) => entry.workspaceRoot === row.root) ?? null;
              return presetWorkspaceRow(t, m, a, row, record, dialog.presetId);
            }),
          dialogError(t, m),
          h(
            'div',
            { 'data-role': 'preset-dialog-actions', style: DIALOG_ACTIONS_STYLE },
            h(
              UI.Button,
              { 'data-action': 'preset-dialog-close', disabled: m.busy, onClick: a.closePresetDialog },
              t('presetDialogClose'),
            ),
          ),
        ),
      );
    }

    /**
     * The 「预设」 tab.
     *
     * Reads `GET /presets` through the page model and writes through the four
     * catalogue/apply routes only (§20.3–§20.6). The body is the catalogue; the
     * two overlays are rendered beside it (they are `position: fixed`, so their
     * place in the tree does not matter), exactly as the page's other dialogs
     * are.
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
        m.presets.phase === 'error'
          ? errorBanner(t, m.presets.error, t('loadFailed'))
          : null,
        presetsList(t, m, a),
        presetEditorDialog(t, m, a),
        presetApplyDialog(t, m, a),
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

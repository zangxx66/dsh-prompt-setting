/**
 * `dsh-prompt-setting` — client chunk: the 「备份与恢复」 tab.
 *
 * This file is **not** a build product: it is published as it is, discovered by
 * the DSH client module loader (the file name matches `client.*.js` and it sits
 * next to `client.js`), registered with `chunk: 'client.transfer.js'` and fetched on
 * demand by the main bundle through `require.async('./client.transfer.js')`, behind
 * `React.lazy` — a page that never opens this tab pays nothing for these bytes.
 *
 * Direction of the two `require` edges (never a cycle):
 *   - main → chunk: `require.async` (asynchronous, at tab open time);
 *   - chunk → main: `require('dsh-prompt-setting')` (the main factory is
 *     already materialized by then; it is what hands over this chunk's half of
 *     the page's shared facilities — see `__internals.shared`).
 *
 * Two hard rules are inherited from `client.js`:
 *   - no bundler, no JSX, no TypeScript, no runtime dependency beyond `react`;
 *   - the byte range between the two marker comments below is this chunk's
 *     fingerprint region, and everything this file *does* happens inside it
 *     (`CONTRACT.md` §14).
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-setting',
  chunk: 'client.transfer.js',
  // A *named function expression*, so the chunk can fingerprint the very bytes
  // it is running and hand that digest back to the main bundle.
  factory: function promptSettingTransferChunkFactory(require) {
    /* @build-fingerprint:begin */
    // #region shared facilities
    // Every name below is the main factory's own instance (never a copy): one
    // `React.createElement`, one theme token table, one set of pure helpers. A
    // copy would be a second value that can drift away from the page it renders.
    const shared = require('dsh-prompt-setting').__internals.shared;
    const IMPORT_MODES = shared.IMPORT_MODES;
    const MAX_EXPORT_PREVIEW = shared.MAX_EXPORT_PREVIEW;
    const UI = shared.UI;
    const cardStyle = shared.cardStyle;
    const chunkTab = shared.chunkTab;
    const errorBanner = shared.errorBanner;
    const fmt = shared.fmt;
    const h = shared.h;
    const headingStyle = shared.headingStyle;
    const metaStyle = shared.metaStyle;
    const tabs = shared.tabs;
    const token = shared.token;
    /**
     * This chunk's own digest, computed from `toString()` against the same
     * markers the host reads out of this file — so the page can verify a chunk
     * it has really loaded, instead of trusting the main file's manifest alone.
     */
    const SELF_BUILD = shared.fingerprintOf(promptSettingTransferChunkFactory.toString());
    // #endregion

    /**
     * g-038: 「备份与恢复」 — the export/import surface, and nothing else.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the tab element.
     */
    function renderBackupTab(t, m, a) {
      return h(
        'div',
        { 'data-region': 'backup-tab', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        renderTransferPanel(t, m, a),
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
        // g-074 att-002 (criterion 9): the preview has to say what an import
        // does to the two installation documents and to every workspace layer,
        // not only to the layer views `totals` sums. The four reads below are
        // the response's own fields (`workspaces`, `presets`, `preferences`,
        // `skipped`), never a second computation of the plan.
        const workspaceList = Array.isArray(plan.workspaces) ? plan.workspaces : [];
        const presetsReport = plan.presets !== null && typeof plan.presets === 'object' ? plan.presets : null;
        const preferencesReport = plan.preferences !== null && typeof plan.preferences === 'object' ? plan.preferences : null;
        const skippedList = Array.isArray(plan.skipped) ? plan.skipped : [];
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
            // Criterion 9, part 1: the two installation documents are replaced
            // as a whole, and the preview says so in words a user reads before
            // confirming.
            presetsReport === null && preferencesReport === null
              ? null
              : h(
                  'div',
                  {
                    key: 'replaces',
                    'data-import-replaces': 'true',
                    style: {
                      border: `1px solid ${token.stateWarn}`,
                      borderRadius: 8,
                      padding: '6px 8px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                    },
                  },
                  h('strong', { style: { fontSize: 13, color: token.stateWarn } }, t('importReplaceWarning')),
                  presetsReport === null
                    ? null
                    : h(
                        'div',
                        { 'data-import-replaces-presets': 'true', style: { fontSize: 12, color: token.labelSecondary } },
                        fmt(t('importReplacePresets'), {
                          presets: countOf(presetsReport.presets),
                          applied: countOf(presetsReport.applied),
                        }),
                      ),
                  preferencesReport === null
                    ? null
                    : h(
                        'div',
                        { 'data-import-replaces-preferences': 'true', style: { fontSize: 12, color: token.labelSecondary } },
                        fmt(t('importReplacePreferences'), {
                          keys: Array.isArray(preferencesReport.keys) ? preferencesReport.keys.length : 0,
                        }),
                      ),
                ),
            // Criterion 9, part 2: which workspace layers the document touches,
            // and whether each one really changes anything.
            workspaceList.length === 0
              ? null
              : h(
                  'div',
                  {
                    key: 'workspaces',
                    'data-import-workspaces': String(workspaceList.length),
                    style: { display: 'flex', flexDirection: 'column', gap: 2 },
                  },
                  h('strong', { style: { fontSize: 13 } }, fmt(t('importWorkspacesHeading'), { n: workspaceList.length })),
                  workspaceList.map((entry) => {
                    const counts = changeCountsOf(entry);
                    const root = entry && entry.root !== undefined && entry.root !== null ? String(entry.root) : '';
                    return h(
                      'div',
                      {
                        key: `workspace:${root}`,
                        'data-import-workspace': root,
                        'data-import-workspace-changed': String(counts.added + counts.replaced + counts.removed > 0),
                        style: { fontSize: 12, color: token.labelSecondary, wordBreak: 'break-all' },
                      },
                      fmt(t('importWorkspaceRow'), { root, ...counts }),
                    );
                  }),
                ),
            // Criterion 9, part 3: what the import leaves alone. `entries` is
            // the response's own count for the entry (`1` for a dropped applied
            // record, the override count for a workspace layer).
            skippedList.length === 0
              ? null
              : h(
                  'div',
                  {
                    key: 'skipped',
                    'data-import-skipped': String(skippedList.length),
                    style: { display: 'flex', flexDirection: 'column', gap: 2 },
                  },
                  h('strong', { style: { fontSize: 13, color: token.stateWarn } }, fmt(t('importSkipped'), { n: skippedList.length })),
                  skippedList.map((entry, index) =>
                    h(
                      'div',
                      {
                        key: `skipped:${index}`,
                        'data-import-skipped-row': String(entry && entry.layer),
                        'data-import-skipped-entries': String(countOf(entry && entry.entries)),
                        style: { fontSize: 12, color: token.labelSecondary, wordBreak: 'break-all' },
                      },
                      fmt(t('importSkippedRow'), {
                        layer: String(entry && entry.layer),
                        reason: String(entry && entry.reason),
                        entries: countOf(entry && entry.entries),
                      }),
                    ),
                  ),
                ),
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
     * A count the plan would render, or `0`. The preview never prints
     * `undefined` or `NaN`, and an older host's response (one without
     * `workspaces` / `presets`) renders nothing rather than a broken number.
     * @param value - the candidate.
     * @returns the number, or `0`.
     */
    function countOf(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    }

    /**
     * The three changing counts of one `workspaces[]` report entry (criterion 9).
     * @param entry - one entry of the response's `workspaces` array.
     * @returns `{added, replaced, removed}`.
     */
    function changeCountsOf(entry) {
      const counts = entry && entry.counts && typeof entry.counts === 'object' ? entry.counts : {};
      return {
        added: countOf(counts.added),
        replaced: countOf(counts.replaced),
        removed: countOf(counts.removed),
      };
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
     * The lazy boundary the main bundle mounts for this tab.
     * @param props - the main bundle's page model, actions and translator.
     * @returns the tab element.
     */
    const TransferTab = chunkTab(renderBackupTab, 'TransferTab');

    return { TransferTab, build: SELF_BUILD };
    /* @build-fingerprint:end */
  },
});

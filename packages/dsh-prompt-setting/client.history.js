/**
 * `dsh-prompt-setting` — client chunk: the 「版本历史」 tab.
 *
 * This file is **not** a build product: it is published as it is, discovered by
 * the DSH client module loader (the file name matches `client.*.js` and it sits
 * next to `client.js`), registered with `chunk: 'client.history.js'` and fetched
 * on demand by the main bundle through `require.async('./client.history.js')`,
 * behind `React.lazy` — that is what makes the tab's ~1000 lines cost nothing
 * to a page that never opens it.
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
 *     fingerprint region, and everything this file *does* happens inside it, so
 *     a change to any of these bytes moves the digest the page compares against
 *     the host's (`CONTRACT.md` §14).
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-setting',
  chunk: 'client.history.js',
  // A *named function expression*, so the chunk can fingerprint the very bytes
  // it is running and hand that digest back to the main bundle: the one thing a
  // page can say about a chunk it has actually loaded.
  factory: function promptSettingHistoryChunkFactory(require) {
    /* @build-fingerprint:begin */
    // #region shared facilities
    // Everything below is the main factory's own instance (never a copy): one
    // `React.createElement`, one theme token table, one renderer probe. A copy
    // would be a second value that can drift away from the page it renders in.
    const shared = require('dsh-prompt-setting').__internals.shared;
    const h = shared.h;
    const token = shared.token;
    const UI = shared.UI;
    const fmt = shared.fmt;
    const tabs = shared.tabs;
    const primitives = shared.primitives;
    const cardStyle = shared.cardStyle;
    const metaStyle = shared.metaStyle;
    const headingStyle = shared.headingStyle;
    const scopeSummaryStyle = shared.scopeSummaryStyle;
    const scopeSummaryTextStyle = shared.scopeSummaryTextStyle;
    const errorBanner = shared.errorBanner;
    const stampOf = shared.stampOf;
    const layerLabel = shared.layerLabel;
    const historyActionLabel = shared.historyActionLabel;
    const diffBlockLabels = shared.diffBlockLabels;
    const diffOpMarker = shared.diffOpMarker;
    const diffKey = shared.diffKey;
    const diffTone = shared.diffTone;
    const HAS_DIFF_BLOCK = shared.HAS_DIFF_BLOCK;
    const DIFF_CURRENT = shared.DIFF_CURRENT;
    const DIFF_BLOCK_MAX_LINES = shared.DIFF_BLOCK_MAX_LINES;
    const MAX_DIFF_LINES_SHOWN = shared.MAX_DIFF_LINES_SHOWN;
    const HISTORY_SCOPE_LIST_HEIGHT = shared.HISTORY_SCOPE_LIST_HEIGHT;
    const HISTORY_PANEL_HEIGHT = shared.HISTORY_PANEL_HEIGHT;
    const HISTORY_VIEWPORT_OFFSET = shared.HISTORY_VIEWPORT_OFFSET;
    const HISTORY_PANEL_MIN_HEIGHT = shared.HISTORY_PANEL_MIN_HEIGHT;
    const RESERVED_SECTION_NAME = shared.RESERVED_SECTION_NAME;
    const VIEWS = shared.VIEWS;
    /**
     * This chunk's own digest, computed from `toString()` against the same
     * markers the host reads out of this file — so the page can verify a chunk
     * it has really loaded, instead of trusting the main file's manifest alone.
     */
    const SELF_BUILD = shared.fingerprintOf(promptSettingHistoryChunkFactory.toString());
    // #endregion

    /**
     * The override-management view.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the view element.
     */
    /**
     * Render one history row, plus the two selectors that feed the comparison.
     *
     * g-044: a row shows the **version**, never the section it was written to.
     * `record.name` is a leftover of the era when a reader could add sections by
     * hand and had to tell them apart; the write surface is now the single
     * reserved section, so the name carries no information a reader can act on.
     * It is still exposed as `data-history-name` (tests and diagnostics read it
     * from there), and records are **not** filtered by it — a log holding
     * `stage2-e2e` rows still lists them, they simply no longer say so.
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
      const pickHint = t('histRowPickHint');
      // A button inside a clickable row must not also re-pick the row: in a real
      // browser the click bubbles up, so the buttons swallow it. The test
      // doubles call `onClick` directly with no event, which is why the guard
      // tolerates a missing one.
      const stop = (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      };
      return h(
        'div',
        {
          key: id,
          'data-history-row': id,
          // g-039 third round: the **row itself** is the primary control —
          // clicking records builds the comparison (first row = from, second =
          // to and the request fires, then a sliding window). The two small
          // buttons below stay for exact control.
          'data-action': 'history-row-pick',
          'data-history-pick-hint': pickHint,
          title: pickHint,
          onClick: () => a.pickHistoryRow(id),
          'data-history-action': record.action,
          'data-history-name': record.name === null ? '' : String(record.name),
          'data-history-origin': record.origin,
          'data-history-layer': record.layer,
          'data-history-selected': selected,
          style: {
            border: `1px solid ${selected === '' ? token.borderL1 : token.stateBusiness}`,
            borderRadius: 8,
            // g-044: a row is a **one-line** fact list. It used to carry the
            // record's section name as a third `code` node, which at the
            // dialog's width pushed the timestamp and the two buttons onto a
            // second and third line: every row was 65px tall and the panel fit
            // barely one of them. The name is still on `data-history-name` for
            // tests and diagnostics; no user-visible text shows it (see
            // historyRow's own note above).
            padding: '3px 6px',
            display: 'flex',
            gap: 4,
            alignItems: 'center',
            flexWrap: 'wrap',
            cursor: 'pointer',
          },
        },
        h('code', { style: { fontSize: 12 } }, `#${id}`),
        h(UI.Tag, { tone: 'neutral' }, historyActionLabel(t, record.action)),
        h(
          'span',
          { style: metaStyle, title: typeof record.at === 'string' ? record.at : undefined },
          stampOf(record.at),
        ),
        record.origin === 'import' ? h(UI.Tag, { tone: 'warning' }, 'import') : null,
        record.entries !== null && Array.isArray(record.entries)
          ? h('span', { 'data-history-entries': String(record.entries.length), style: metaStyle }, `entries=${record.entries.length}`)
          : null,
        // g-039 sixth round: no per-row from/to buttons. The row itself is the
        // control (see the click handler above), so the two remaining buttons are
        // the ones that open something.
        h(
          'button',
          {
            type: 'button',
            'data-action': 'history-preview',
            'data-history-id': id,
            'data-preview-selected': m.preview.id === id ? 'true' : 'false',
            onClick: (event) => {
              stop(event);
              a.previewHistoryRecord(id);
            },
            style: sideStyle,
          },
          t('histPreview'),
        ),
        h(
          'button',
          {
            type: 'button',
            'data-action': 'history-rollback',
            'data-history-id': id,
            onClick: (event) => {
              stop(event);
              a.requestRollback(id);
            },
            style: sideStyle,
          },
          t('histRollback'),
        ),
      );
    }

    /**
     * g-039: one history record, previewed in full.
     *
     * Everything it shows is already in the `GET /history` payload the list
     * beside it was rendered from — the record's `before` / `after` texts, its
     * `snapshot`, its `note`. That is deliberate: previewing a version is a
     * **read of what is on screen**, so it issues no request at all, and the
     * "preview writes nothing" assertion is structural rather than a promise.
     *
     * The record is looked up in the current page by id. Paging does not clear
     * the preview (the same rule the comparison selection follows, CONTRACT
     * §13.3), so a page that does not hold the record yet renders the explicit
     * `missing` state instead of silently showing nothing.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the panel element, or `null` when no record is being previewed.
     */
    function renderPreviewModal(t, m, a) {
      const preview = m.preview;
      const shell = (children, state) =>
        modalShell(
          {
            key: 'history-preview-modal',
            region: 'history-preview-modal',
            title: t('histPreviewHeading'),
            closeLabel: t('histModalClose'),
            onClose: a.closeHistoryModal,
          },
          h(
            'div',
            {
              'data-region': 'history-preview',
              'data-preview-state': state,
              'data-preview-id': preview.id === null ? '' : String(preview.id),
              style: { display: 'flex', flexDirection: 'column', gap: 6 },
            },
            children,
          ),
        );
      if (preview.state === 'missing') {
        return shell([
          h('p', { key: 'missing', 'data-preview-missing': 'true', style: { margin: 0, ...metaStyle } }, t('histPreviewMissing')),
          h('p', { key: 'missing-hint', style: { margin: 0, ...metaStyle } }, t('histPreviewMissingHint')),
        ], 'missing');
      }
      const record = preview.record;
      const entryText = (entry) =>
        entry !== null && entry !== undefined && typeof entry.text === 'string' ? entry.text : t('histPreviewNoText');
      const entryBytes = (entry) =>
        entry !== null && entry !== undefined && Number.isFinite(entry.bytes) ? String(entry.bytes) : '';
      const snapshot = Array.isArray(record.snapshot) ? record.snapshot : [];
      const foreign = snapshot.filter((entry) => entry.name !== RESERVED_SECTION_NAME).length;
      const field = (key, label, value, title) =>
        h(
          'div',
          { key, 'data-preview-field': key, style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
          h('span', { key: 'label', style: { ...metaStyle, minWidth: 48 } }, label),
          h('span', { key: 'value', style: { wordBreak: 'break-word' }, title }, value),
        );
      const textBoxStyle = {
        margin: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 200,
        overflowY: 'auto',
        border: `1px solid ${token.borderL1}`,
        borderRadius: 6,
        padding: '4px 6px',
        fontSize: 12,
      };
      const textBox = (key, label, entry) =>
        h(
          'div',
          { key, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          h('span', { key: 'label', style: metaStyle }, label),
          h(
            'pre',
            {
              key: 'text',
              'data-preview-text': key,
              'data-preview-bytes': entryBytes(entry),
              style: textBoxStyle,
            },
            entryText(entry),
          ),
        );
      return shell(
        [
          h(
            'div',
            { key: 'head', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('code', { key: 'id', style: { fontSize: 12 } }, `#${record.id}`),
            h('span', { key: 'action', style: metaStyle }, historyActionLabel(t, record.action)),
          ),
          h(
            'div',
            { key: 'facts', style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            field('action', t('histPreviewAction'), historyActionLabel(t, record.action)),
            // Revision 18's single rule, the same one a list row follows: the
            // reader sees the timestamp in **their own** zone, and the record's
            // stored UTC string stays on the node's `title`.
            field(
              'at',
              t('histPreviewAt'),
              stampOf(record.at),
              typeof record.at === 'string' ? record.at : undefined,
            ),
            field('layer', t('histPreviewLayer'), layerLabel(t, record.layer)),
            // g-044: no section name here either — the preview keeps the same
            // rule as the list row it was opened from (see `historyRow`).
            field('origin', t('histPreviewOrigin'), record.origin === null || record.origin === undefined ? '' : String(record.origin)),
            field('note', t('histPreviewNote'), record.note === null || record.note === undefined ? t('histPreviewNoText') : String(record.note)),
          ),
          // g-039 rework: say what a rollback would and would not touch, before
          // the button that starts one. The count is read off this record's own
          // snapshot, so the sentence is about *this* version.
          h(
            'p',
            { key: 'policy', 'data-preview-policy': 'reserved-only', style: { margin: 0, ...metaStyle } },
            t('histPreviewPolicy'),
          ),
          foreign > 0
            ? h(
                'p',
                {
                  key: 'foreign',
                  'data-preview-foreign': String(foreign),
                  style: { margin: 0, ...metaStyle, color: token.stateWarn },
                },
                fmt(t('histRollbackForeign'), { n: foreign }),
              )
            : null,
          textBox('before', t('histPreviewBefore'), record.before),
          textBox('after', t('histPreviewAfter'), record.after),
          h(
            'div',
            { key: 'snapshot', 'data-preview-snapshot-count': String(snapshot.length), style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            h(
              'span',
              { key: 'label', style: metaStyle },
              snapshot.length === 0
                ? t('histPreviewSnapshotEmpty')
                : fmt(t('histPreviewSnapshot'), { n: snapshot.length }),
            ),
            ...snapshot.map((entry) =>
              h(
                'div',
                {
                  key: `snap-${String(entry.name)}`,
                  'data-preview-snapshot': String(entry.name),
                  'data-preview-snapshot-action': String(entry.action),
                  style: { ...metaStyle, display: 'flex', gap: 6, flexWrap: 'wrap' },
                },
                fmt(t('histPreviewSnapshotEntry'), {
                  name: String(entry.name),
                  action: String(entry.action),
                  bytes: entry.bytes === null || entry.bytes === undefined ? '—' : String(entry.bytes),
                }),
              ),
            ),
          ),
        ],
        'ready',
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
    function renderDiffModal(t, m, a) {
      const label = (value) => (value === null || value === undefined
        ? '—'
        : value === DIFF_CURRENT ? t('histCurrent') : `#${value}`);
      // g-039 sixth round: the dialog holds the comparison and nothing else. The
      // "clear the comparison" control lives **outside** it (in the list's tool
      // row), so no control that acts on the list is ever buried inside a dialog,
      // and the how-to sentence lives there too — a dialog that is showing a
      // result does not need to explain how to ask for one.
      const children = [
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
      return modalShell(
        {
          key: 'history-diff-modal',
          region: 'history-diff-modal',
          title: t('histDiffHeading'),
          closeLabel: t('histModalClose'),
          onClose: a.closeHistoryModal,
        },
        h(
          'div',
          {
            'data-region': 'history-diff',
            'data-diff-state': m.diff.phase,
            style: { display: 'flex', flexDirection: 'column', gap: 6 },
          },
          children,
        ),
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
      const pg = m.histPage;
      const loading = m.hist.phase === 'loading';
      const pagerButtonStyle = {
        font: 'inherit',
        fontSize: 12,
        padding: '2px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        background: 'transparent',
        color: token.labelSecondary,
        border: `1px solid ${token.borderL2}`,
      };
      // The scope sentence: what is on screen right now, in words. A reader must
      // never have to infer it from a request URL (g-038).
      const scopeNote =
        layer === 'user'
          ? { key: 'scope-global', attr: 'global', text: t('histScopeGlobal') }
          : m.historyScopeValue.length === 0
            ? { key: 'no-session', attr: 'no-session', text: t('histNoSession') }
            : {
                key: 'scope-workspace',
                attr: 'workspace',
                text: fmt(t('histScopeWorkspace'), {
                  name: m.historyScopeName,
                  session: m.historyScopeValue,
                }),
              };
      const children = [
        // g-044: the heading is the only chrome that stays above the fold. The
        // retention sentence and the three explanatory lines moved into one
        // **collapsed** disclosure (see `notes` below): every stacked line of
        // chrome above the list was a row of history the reader did not get, and
        // the settings dialog's height is the host's business — so the panel's
        // own chrome is what gets tightened (CONTRACT §13.2, Revision 27).
        h('h3', { key: 'heading', style: headingStyle }, t('histHeading')),
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
        // The version history's **own** scope (g-038): independent of the
        // page-level 「查看范围」, so changing that one can never move this list.
        //
        // g-038 second round: the scope is a **collapsed disclosure** — one
        // summary row that never grows with the number of workspaces, and a
        // picker (search box + fixed-height scrolling candidate list) rendered
        // only while it is open. The page's own「查看范围」was collapsed the same
        // way in g-016; the tab-button wall this replaces pushed the list down
        // the screen one workspace at a time.
        h(
          'div',
          {
            key: 'scope',
            'data-region': 'history-scope',
            'data-history-scope-mode': m.historyScopeMode,
            'data-history-scope-applies': layer === 'workspace' ? 'true' : 'false',
            'data-history-scope-value': m.historyScopeValue,
            'data-history-scope-options': String(m.historyScopeOptions.length),
            'data-scope-open': String(m.historyScopeOpen),
            style: { display: 'flex', flexDirection: 'column', gap: 4 },
          },
          h(
            'div',
            { key: 'summary', 'data-region': 'history-scope-summary', style: scopeSummaryStyle },
            h('span', { key: 'label', style: metaStyle }, t('histScopeLabel')),
            m.historyScopeOptions.length === 0
              ? h(
                  'span',
                  { key: 'empty', 'data-role': 'history-scope-empty', style: scopeSummaryTextStyle },
                  t('histScopeNone'),
                )
              : h(
                  'span',
                  { key: 'value', 'data-role': 'history-scope-summary-label', style: scopeSummaryTextStyle },
                  m.historyScopeName,
                ),
            m.historyScopeOptions.length > 0
              ? h(
                  UI.Button,
                  {
                    key: 'toggle',
                    variant: 'outline',
                    'data-action': 'history-scope-toggle',
                    'data-expanded': String(m.historyScopeOpen),
                    'aria-expanded': m.historyScopeOpen,
                    onClick: a.toggleHistoryScopeOpen,
                  },
                  m.historyScopeOpen ? t('scopeCollapse') : t('scopeEdit'),
                )
              : null,
          ),
          ...(m.historyScopeOpen && m.historyScopeOptions.length > 0
            ? [
                h(
                  'div',
                  { key: 'picker', 'data-region': 'history-scope-picker', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  h(UI.Input, {
                    key: 'search',
                    'data-role': 'history-scope-search',
                    placeholder: t('histScopeSearch'),
                    value: m.historyScopeSearch,
                    onChange: a.setHistoryScopeSearch,
                    style: { maxWidth: 320 },
                  }),
                  h(
                    'div',
                    {
                      key: 'list',
                      'data-history-scope-list': 'scroll',
                      'data-history-scope-shown': String(m.historyScopeMatches.length),
                      style: {
                        height: HISTORY_SCOPE_LIST_HEIGHT,
                        maxHeight: HISTORY_SCOPE_LIST_HEIGHT,
                        overflowY: 'auto',
                        border: `1px solid ${token.borderL1}`,
                        borderRadius: 8,
                        padding: 6,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                      },
                    },
                    m.historyScopeMatches.length === 0
                      ? h('span', { key: 'no-match', 'data-role': 'history-scope-no-match', style: metaStyle }, t('histScopeNoMatch'))
                      : m.historyScopeMatches.map((option) =>
                          h(
                            'button',
                            {
                              key: option.value,
                              type: 'button',
                              'data-role': 'history-scope-option',
                              'data-history-scope-option': option.value,
                              'data-selected': option.value === m.historyScopeValue ? 'true' : 'false',
                              onClick: () => a.setHistoryScope(option.value),
                              style: {
                                font: 'inherit',
                                fontSize: 12,
                                lineHeight: '18px',
                                textAlign: 'left',
                                padding: '4px 8px',
                                borderRadius: 6,
                                cursor: 'pointer',
                                color: option.value === m.historyScopeValue ? token.buttonLabel : token.labelPrimary,
                                background: option.value === m.historyScopeValue ? token.buttonFill : 'transparent',
                                border: `1px solid ${option.value === m.historyScopeValue ? 'transparent' : token.borderL2}`,
                                display: 'flex',
                                gap: 6,
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                wordBreak: 'break-word',
                              },
                            },
                            h('span', { key: 'name' }, option.label),
                            option.value === m.historyScopeValue ? h(UI.Tag, { key: 'current', tone: 'info' }, t('scopeSelected')) : null,
                          ),
                        ),
                  ),
                ),
              ]
            : []),
          m.historyScopeMode === 'sessions'
            ? h(
                'span',
                { key: 'degraded', 'data-warning': 'history-scope-degraded', style: { ...metaStyle, color: token.stateWarn } },
                t('histScopeDegraded'),
              )
            : null,
          // g-044: the retention sentence and the three explanatory sentences are
          // now **folded away** behind one summary line. Every one of them is a
          // sentence *about* the list rather than a row of it, and stacked at the
          // settings dialog's height they cost the reader three records. A native
          // `details` disclosure keeps all of them one click away, and — because the
          // children are still rendered — keeps every node and every `data-role`
          // §13.2 talks about exactly where it was.
          h(
            'details',
            { key: 'notes', 'data-region': 'history-notes', 'data-history-notes': 'folded' },
            h(
              'summary',
              {
                'data-role': 'history-notes-toggle',
                style: { ...metaStyle, cursor: 'pointer', lineHeight: '18px' },
              },
              t('histNotesToggle'),
            ),
            h(
              'div',
              { key: 'notes-body', style: { display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 2 } },
              h(
                'p',
                { key: 'note', 'data-role': 'history-retention-note', style: { margin: 0, ...metaStyle } },
                fmt(t('histNote'), { limit: data && data.retentionLimit ? data.retentionLimit : '' }),
              ),
              h(
                'div',
                { key: 'scope-lines', style: { display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' } },
                h(
                  'p',
                  {
                    key: 'scope-note',
                    'data-role': 'history-scope-note',
                    'data-history-note': scopeNote.attr,
                    style: { margin: 0, ...metaStyle },
                  },
                  scopeNote.text,
                ),
                h('p', { key: 'scope-hint', style: { margin: 0, ...metaStyle } }, t('histScopeHint')),
                // g-039 sixth round: how to compare, right below the scope sentence …
                h(
                  'p',
                  { key: 'compare-hint', 'data-role': 'history-compare-hint', style: { margin: 0, ...metaStyle } },
                  t('histCompareHint'),
                ),
              ),
            ),
          ),
        ),
      ];
      // g-044: …and the one control that acts on the comparison, **outside**
      // every dialog, now shares its line with the record count. Both are chrome
      // the list pays for; the control keeps its `data-region` and its disabled
      // rule, and the count keeps `data-history-total` / `data-history-corrupt`.
      const diffToolsRow = h(
        'div',
        {
          key: 'diff-tools',
          'data-region': 'history-diff-tools',
          style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
        },
        h(
          UI.Button,
          {
            key: 'clear',
            'data-action': 'diff-clear',
            disabled: m.diffSel.from === null && m.diffSel.to === DIFF_CURRENT,
            onClick: a.clearDiff,
          },
          t('histDiffClear'),
        ),
      );
      const metaRow = data
        ? h(
            'div',
            { key: 'meta', 'data-history-total': String(data.total), 'data-history-corrupt': String(data.corrupt), style: metaStyle },
            fmt(t('histTotal'), { n: data.total }),
            data.corrupt > 0 ? ` · ${fmt(t('histCorrupt'), { n: data.corrupt })}` : null,
            data.unreadable ? h('div', { 'data-history-unreadable': 'true', style: { color: token.stateError } }, fmt(t('histUnreadable'), { reason: data.unreadable })) : null,
            data.lastError ? h('div', { 'data-history-last-error': 'true', style: { color: token.stateError } }, fmt(t('histLastError'), { reason: data.lastError.reason })) : null,
          )
        : null;
      // g-044: `diffToolsRow` and `metaRow` are **not** pushed here. They render
      // inside the pager row below the list instead: they are controls and facts
      // *about* the list, and a row of their own cost the reader another record
      // (see the pager's own note). Both keep their `data-region` / markers.
      if (loading && !data) children.push(h('p', { key: 'loading', style: metaStyle }, t('loading')));
      if (m.hist.phase === 'error') children.push(h('div', { key: 'error' }, errorBanner(t, m.hist.error, t('histHeading'))));
      if (data) {
        // g-038: a box that scrolls **inside** itself, so exactly the current
        // page of records is ever rendered. g-039 third round: it FILLS the
        // column (`flex: 1 1 auto; minHeight: 0`) instead of being 320px tall,
        // because the panel's height now comes from the viewport.
        children.push(
          h(
            'div',
            {
              key: 'rows',
              'data-region': 'history-list',
              'data-history-list': 'scroll',
              'data-history-box-height': 'viewport',
              style: {
                flex: '1 1 auto',
                minHeight: 0,
                overflowY: 'auto',
                border: `1px solid ${token.borderL1}`,
                borderRadius: 8,
                padding: 6,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              },
            },
            records.length === 0 ? h('div', { 'data-empty': 'history', style: metaStyle }, t('histEmpty')) : null,
            records.map((record) => historyRow(t, m, a, record)),
            // g-039 sixth round: the 「当前生效值」 row is picked the same way a
            // record row is — click it — so it stays comparable with a record
            // without its own pair of buttons.
            h(
              'div',
              {
                key: 'current',
                'data-history-row': 'current',
                'data-history-current': 'true',
                'data-action': 'history-row-pick',
                'data-history-selected': m.diffSel.from === DIFF_CURRENT ? 'from' : m.diffSel.to === DIFF_CURRENT ? 'to' : '',
                'data-history-pick-hint': t('histRowPickHint'),
                title: t('histRowPickHint'),
                onClick: () => a.pickHistoryRow(DIFF_CURRENT),
                style: {
                  border: `1px dashed ${token.borderL2}`,
                  borderRadius: 8,
                  padding: '6px 8px',
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  cursor: 'pointer',
                },
              },
              h(UI.Tag, { tone: 'info' }, t('histCurrent')),
            ),
          ),
        );
        children.push(
          h(
            'div',
            {
              key: 'pager',
              'data-region': 'history-pager',
              'data-history-page': String(pg.pageIndex + 1),
              'data-history-pages': String(pg.pageCount),
              'data-history-page-size': String(pg.pageSize),
              'data-history-offset': String(pg.offset),
              // g-044: the pager row now also carries「清除对比」and the record
              // count. Three facts that were three stacked rows are one row now;
              // `alignItems: baseline` keeps the small pager text on the same
              // line as the taller button.
              style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' },
            },
            h(
              'button',
              {
                key: 'prev',
                type: 'button',
                'data-action': 'history-prev',
                disabled: pg.offset <= 0 || loading,
                onClick: a.historyPrev,
                style: pagerButtonStyle,
              },
              t('histPagePrev'),
            ),
            h(
              'span',
              { key: 'label', 'data-role': 'history-page-label', style: metaStyle },
              fmt(t('histPager'), {
                page: pg.pageIndex + 1,
                pages: Math.max(1, pg.pageCount),
                total: pg.total,
              }),
            ),
            h(
              'button',
              {
                key: 'next',
                type: 'button',
                'data-action': 'history-next',
                disabled: pg.hasMore !== true || loading,
                onClick: a.historyNext,
                style: pagerButtonStyle,
              },
              t('histPageNext'),
            ),
            diffToolsRow,
            metaRow,
          ),
        );
      }
      return h(
        'div',
        {
          'data-region': 'history',
          'data-history-layer': layer,
          'data-history-state': m.hist.phase,
          // g-039 third round: the card fills its column, and the record box
          // inside it takes whatever is left (`flex: 1 1 auto; minHeight: 0`).
          // `height: 100%` is what makes that possible: without it the card is
          // content-sized and the box below would size to its own content again.
          style: {
            ...cardStyle,
            display: 'flex',
            flexDirection: 'column',
            // g-044: 4, not 6. The panel stacks eight blocks above the list, so
            // the inter-block gaps were themselves a whole row of history.
            gap: 4,
            height: '100%',
            minHeight: 0,
            overflow: 'hidden',
          },
        },
        children,
      );
    }

    /**
     * 「版本历史」 — the log and the comparison (g-038: the export/import
     * surface moved to its own 「备份与恢复」 tab).
     *
     * Nothing here changed in g-015 except *where it lives*: the panel and the
     * transfer card moved out of the old 覆盖 view, and the lazy load now keys
     * off this tab instead of that view, so a page that never opens it still
     * issues exactly the three baseline requests. g-038 then split the two
     * apart: this renderer is the log's half only.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the panel element.
     */
    /**
     * g-038: 「版本历史」 — the log and its comparison, arranged as two columns.
     * g-039 (third round): the arrangement is now a **fixed, viewport-sized
     * row** rather than a wrapping one.
     *
     * The left column is the record list (internally scrolling box, pager); the
     * right column is the detail pane, which shows exactly one of three views —
     * the idle note, a record preview, or the comparison. Both columns are
     * always in the same row and always share the panel's height.
     *
     * Why `nowrap` and no px basis: the previous version wrapped when the two
     * columns no longer fit (`1 1 420px` + `1 1 360px` in a ~700px dialog), so
     * choosing a record and reading the result were one screen apart. A narrower
     * panel must narrow the columns — never stack them. `flex: 1 1 0` gives each
     * column an equal share of whatever width there is and lets the inner boxes
     * scroll, which is the only scroll this tab is allowed to have.
     *
     * Height (g-039 third round, measured in the fourth): the panel is bounded by
     * what was really available — `m.historyPanel.height` when the measurement
     * produced one — and falls back to `HISTORY_PANEL_HEIGHT`
     * (`calc(100vh − offset)`) when it did not. The boxes below take
     * `flex: 1 1 auto; minHeight: 0` so they fill whatever is left instead of a
     * fixed 320px. The page's own scroll bar therefore does not appear for this
     * tab. Which path is in use is reported on the panel itself:
     * `data-history-height-source` (`measured` | `fallback`) and
     * `data-history-panel-height` (the px number, or `fallback`).
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the tab element.
     */
    function renderHistoryTab(t, m, a) {
      const panelHeight = m.historyPanel.height === null ? HISTORY_PANEL_HEIGHT : `${m.historyPanel.height}px`;
      return h(
        'div',
        {
          'data-region': 'history-tab',
          // g-039 fifth round: one column. The record list owns the full width of
          // the panel; the preview and the comparison are viewport modals below,
          // so nothing squeezes the rows any more.
          'data-history-layout': 'single',
          'data-history-viewport-offset': String(HISTORY_VIEWPORT_OFFSET),
          'data-history-height-source': m.historyPanel.source,
          'data-history-panel-height':
            m.historyPanel.height === null ? 'fallback' : String(m.historyPanel.height),
          ref: m.historyPanelRef,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            height: panelHeight,
            maxHeight: panelHeight,
            minHeight: HISTORY_PANEL_MIN_HEIGHT,
            minWidth: 0,
            overflow: 'hidden',
          },
        },
        renderHistoryPanel(t, m, a),
        renderHistoryModals(t, m, a),
      );
    }

    /**
     * g-039 (fifth round): the preview and the comparison, as viewport modals.
     *
     * They are mutually exclusive by construction — one state
     * (`m.historyModal`) picks at most one of them — and each is a
     * `position: fixed` overlay with `role="dialog"` + `aria-modal="true"`, a
     * header close button, Esc (bound by the page while one is open) and an
     * internally scrolling body, so a long comparison never scrolls the page
     * behind it. The record list keeps the full panel width underneath.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the modal element, or `null` when none is open.
     */
    function renderHistoryModals(t, m, a) {
      if (m.historyModal === 'preview') return m.preview.state === 'none' ? null : renderPreviewModal(t, m, a);
      if (m.historyModal === 'diff') return renderDiffModal(t, m, a);
      return null;
    }

    /**
     * The shared modal shell: a fixed, centred overlay with a titled, closeable,
     * internally scrolling dialog.
     * @param options - `{key, region, label, title, onClose, closeAction}`.
     * @param children - the dialog's body.
     * @returns the overlay element.
     */
    function modalShell(options, children) {
      return h(
        'div',
        {
          key: options.key,
          'data-region': 'history-modal-overlay',
          'data-history-modal': options.region,
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
            'data-region': options.region,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': options.title,
            style: {
              ...cardStyle,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              width: 'min(1040px, 92vw)',
              maxWidth: '92vw',
              height: 'min(82vh, 900px)',
              maxHeight: 'min(82vh, 900px)',
              overflowY: 'auto',
              padding: '16px 18px',
              // The close button is anchored to this corner, so it stays put
              // however long the title or the dialog's scroll position is.
              position: 'relative',
              boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
            },
          },
          h(
            UI.Button,
            {
              key: 'close',
              'data-action': 'history-modal-close',
              'aria-label': options.closeLabel,
              title: options.closeLabel,
              onClick: options.onClose,
              style: { position: 'absolute', top: 10, right: 10 },
            },
            '✕',
          ),
          h(
            'div',
            { 'data-role': 'history-modal-head', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('strong', { key: 'title', style: { fontSize: 14, fontWeight: 600 } }, options.title),
          ),
          children,
        ),
      );
    }
    /**
     * The lazy boundary the main bundle mounts for this tab.
     *
     * The main bundle renders one element with `{t, m, a}` and this component
     * calls the very same `renderHistoryTab` the page used to call directly, so
     * the tree, the markers and the interaction are byte-for-byte what they
     * were before the split — only *when* it is built changed.
     * @param props - the main bundle's page model, actions and translator.
     * @returns the tab element.
     */
    function HistoryTab(props) {
      return renderHistoryTab(props.t, props.m, props.a);
    }

    return { HistoryTab, build: SELF_BUILD };
    /* @build-fingerprint:end */
  },
});

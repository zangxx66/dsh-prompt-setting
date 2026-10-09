/**
 * `dsh-prompt-setting` — client chunk: the 「提示词总览」 tab.
 *
 * This file is **not** a build product: it is published as it is, discovered by
 * the DSH client module loader (the file name matches `client.*.js` and it sits
 * next to `client.js`), registered with `chunk: 'client.overview.js'` and fetched on
 * demand by the main bundle through `require.async('./client.overview.js')`, behind
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
  chunk: 'client.overview.js',
  // A *named function expression*, so the chunk can fingerprint the very bytes
  // it is running and hand that digest back to the main bundle.
  factory: function promptSettingOverviewChunkFactory(require) {
    /* @build-fingerprint:begin */
    // #region shared facilities
    // Every name below is the main factory's own instance (never a copy): one
    // `React.createElement`, one theme token table, one set of pure helpers. A
    // copy would be a second value that can drift away from the page it renders.
    const shared = require('dsh-prompt-setting').__internals.shared;
    const LAYER_FILTERS = shared.LAYER_FILTERS;
    const MAX_VIEW_LINES = shared.MAX_VIEW_LINES;
    const ORIGIN_FILTERS = shared.ORIGIN_FILTERS;
    const OVERRIDABLE_FILTERS = shared.OVERRIDABLE_FILTERS;
    const RESERVED_SECTION_NAME = shared.RESERVED_SECTION_NAME;
    const UI = shared.UI;
    const VIEWS = shared.VIEWS;
    const cardStyle = shared.cardStyle;
    const chunkDiff = shared.chunkDiff;
    const composeSections = shared.composeSections;
    const countMatches = shared.countMatches;
    const diffKey = shared.diffKey;
    const diffSections = shared.diffSections;
    const diffTone = shared.diffTone;
    const editGate = shared.editGate;
    const filterLabelKey = shared.filterLabelKey;
    const fmt = shared.fmt;
    const h = shared.h;
    const headingStyle = shared.headingStyle;
    const highlightNodes = shared.highlightNodes;
    const ineffectiveCause = shared.ineffectiveCause;
    const layerKey = shared.layerKey;
    const metaStyle = shared.metaStyle;
    const originKey = shared.originKey;
    const originOf = shared.originOf;
    const originTone = shared.originTone;
    const sectionLayer = shared.sectionLayer;
    const splitLines = shared.splitLines;
    const tabs = shared.tabs;
    const token = shared.token;
    /**
     * This chunk's own digest, computed from `toString()` against the same
     * markers the host reads out of this file — so the page can verify a chunk
     * it has really loaded, instead of trusting the main file's manifest alone.
     */
    const SELF_BUILD = shared.fingerprintOf(promptSettingOverviewChunkFactory.toString());
    // #endregion

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
     * The lazy boundary the main bundle mounts for this tab.
     * @param props - the main bundle's page model, actions and translator.
     * @returns the tab element.
     */
    function OverviewTab(props) {
      return renderOverviewPanel(props.t, props.m, props.a);
    }

    return { OverviewTab, build: SELF_BUILD };
    /* @build-fingerprint:end */
  },
});

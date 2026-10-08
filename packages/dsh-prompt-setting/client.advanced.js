/**
 * `dsh-prompt-setting` — client chunk: the 「高级」 tab.
 *
 * This file is **not** a build product: it is published as it is, discovered by
 * the DSH client module loader (the file name matches `client.*.js` and it sits
 * next to `client.js`), registered with `chunk: 'client.advanced.js'` and fetched on
 * demand by the main bundle through `require.async('./client.advanced.js')`, behind
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
  chunk: 'client.advanced.js',
  // A *named function expression*, so the chunk can fingerprint the very bytes
  // it is running and hand that digest back to the main bundle.
  factory: function promptSettingAdvancedChunkFactory(require) {
    /* @build-fingerprint:begin */
    // #region shared facilities
    // Every name below is the main factory's own instance (never a copy): one
    // `React.createElement`, one theme token table, one set of pure helpers. A
    // copy would be a second value that can drift away from the page it renders.
    const shared = require('dsh-prompt-setting').__internals.shared;
    const DOWNLOAD_REGIONS = shared.DOWNLOAD_REGIONS;
    const LAYERS = shared.LAYERS;
    const RESERVED_SECTION_NAME = shared.RESERVED_SECTION_NAME;
    const UI = shared.UI;
    const cardStyle = shared.cardStyle;
    const errorText = shared.errorText;
    const fmt = shared.fmt;
    const h = shared.h;
    const headingStyle = shared.headingStyle;
    const ineffectiveCause = shared.ineffectiveCause;
    const layerLabel = shared.layerLabel;
    const metaStyle = shared.metaStyle;
    const regionLabelKey = shared.regionLabelKey;
    const renderStatusDetail = shared.renderStatusDetail;
    const renderUpdateApplyStatus = shared.renderUpdateApplyStatus;
    const tabs = shared.tabs;
    const token = shared.token;
    /**
     * This chunk's own digest, computed from `toString()` against the same
     * markers the host reads out of this file — so the page can verify a chunk
     * it has really loaded, instead of trusting the main file's manifest alone.
     */
    const SELF_BUILD = shared.fingerprintOf(promptSettingAdvancedChunkFactory.toString());
    // #endregion

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
        // g-030: the switch that decides whether this plugin may talk to GitHub
        // at all. It sits above the status block because it is an *action*, and
        // the status block is a read-out.
        renderUpdateSetting(t, m, a),
        renderStatusDetail(t, m),
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
     * g-030: the「检查更新」switch, in 「高级」.
     *
     * The switch is the whole reason this feature is shippable: the goal is
     * explicit that off means the plugin makes no outbound request at all,
     * including when the page mounts, and that the control has to be real UI in
     * 「高级」 rather than a config file a user must find. So the state shown is
     * the **Host's** answer (`enabled` on the update-check payload), the mirror
     * in `localStorage` only saves a round trip, and the button sends the
     * negation — one click always produces the state the label promised.
     *
     * Nothing here is derived from the check's outcome; the line below it is
     * rendered from the same payload that produced the banner, and is silent for
     * every inconclusive answer.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the settings card element.
     */
    function renderUpdateSetting(t, m, a) {
      const u =
        m.update === null || m.update === undefined
          ? { enabled: true, phase: 'idle', data: null, check: null }
          : m.update;
      const enabled = u.enabled !== false;
      const saving = u.phase === 'saving';
      // The two answers this card can explain are **different facts** and must
      // not be confused (review finding, g-030):
      //   - `check.hasUpdate === null` is a *successful* check that could not
      //     decide — no release yet, no `tag_name`, an unparsable tag. Upstream
      //     said something; it just was not a version. That is what the
      //     「上游暂时没有可用的版本信息」 line is for;
      //   - a failed check (`ok:false`, `phase === 'error'`) is *not* a fact about
      //     upstream, so it gets no such sentence — and no red line either (the
      //     page's zero-error rule). The last successful answer, if any, stays.
      // A newer release shows its version; "up to date" says nothing.
      const check = u.check ?? null;
      const latest =
        check !== null && check.hasUpdate === true && typeof check.latest === 'string' ? check.latest : null;
      const undecided = check !== null && check.hasUpdate === null;
      return h(
        'div',
        {
          key: 'update-setting',
          'data-region': 'update-setting',
          'data-update-enabled': enabled ? 'true' : 'false',
          style: { ...cardStyle, display: 'flex', flexDirection: 'column', gap: 6 },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, t('updateSettingLabel')),
          h(
            UI.Button,
            {
              'data-action': 'update-toggle',
              'aria-pressed': enabled ? 'true' : 'false',
              disabled: m.busy || saving,
              onClick: a.toggleUpdate,
            },
            saving ? t('updateSwitching') : t(enabled ? 'updateSettingOn' : 'updateSettingOff'),
          ),
          enabled
            ? h(
                UI.Button,
                {
                  'data-action': 'update-recheck',
                  disabled: m.busy || saving,
                  onClick: a.recheckUpdate,
                },
                t('updateRecheck'),
              )
            : null,
        ),
        h('p', { style: { margin: 0, ...metaStyle } }, t('updateSettingNote')),
        renderDownloadRegion(t, m, a, u),
        latest === null
          ? null
          : h(
              'p',
              { style: { margin: 0, ...metaStyle }, 'data-update-state': 'available', 'data-update-known': latest },
              fmt(t('updateLatestKnown'), { latest }),
            ),
        undecided
          ? h(
              'p',
              { style: { margin: 0, ...metaStyle }, 'data-update-state': 'unknown', 'data-update-unknown': 'true' },
              t('updateUnknown'),
            )
          : null,
        // g-032: the install's state and its controls live here as well as in
        // the banner. Dismissing the banner must not lose the only place a
        // running install can be cancelled or a failed one retried — **and
        // neither may the update-check switch**: an install started while the
        // switch was on can still be live after it is turned off, and hiding its
        // row then would take away the only cancel button on the page. So a
        // known install outranks both conditions; the switch and the
        // "is there anything to install" line only gate the button that
        // **starts** one.
        (u.apply ?? null) === null && (latest === null || !enabled)
          ? null
          : h(
              'div',
              { 'data-region': 'update-apply', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              (u.apply ?? null) === null
                ? h(
                    UI.Button,
                    {
                      variant: 'primary',
                      'data-action': 'update-apply',
                      disabled: m.busy,
                      onClick: () => a.requestUpdateApply(latest),
                    },
                    t('updateApply'),
                  )
                : renderUpdateApplyStatus(t, m, a),
            ),
      );
    }

    /**
     * g-043:「下载区域」— the dropdown inside the「检查更新」card, plus the line
     * that says where the current one happens to come from.
     *
     * Four facts drive what is on screen, and none of them is optimistic:
     *   - the **selected** value is the Host's stored region, never the option the
     *     user just clicked: a click sends the `PUT`, and only the answer moves the
     *     control — so a refused write visibly leaves the old source in force;
     *   - `detected` (the Host decided this by availability on the first visit)
     *     renders as「已自动判定（该源能取到本包）」, because a default a page chose for the
     *     user must not look like one the user chose;
     *   - a stored `custom` address the Host cannot use renders its reason beside
     *     the control, so「自定义」is never silently wrong;
     *   - the note under it names what the selected source means, which is what
     *     makes the three options comparable.
     *
     * The control is a plain native `select` element: it is a three-way choice
     * over fixed ids, and a native one is keyboard- and screen-reader-correct in
     * both renderer branches without a primitives dependency (no `Select` atom is
     * asserted to exist).
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @param u - this card's update view state.
     * @returns the region row element.
     */
    function renderDownloadRegion(t, m, a, u) {
      const region = u.region ?? null;
      const current = region !== null && DOWNLOAD_REGIONS.includes(region.region) ? region.region : 'default';
      const saving = region !== null && region.phase === 'saving';
      const detected = region !== null && region.detected === true;
      // A saved `custom` address the Host cannot use is reported once, here — it
      // is the only place the user can see that their mirror is not in force.
      const unusable =
        region !== null && region.error !== null && region.error !== undefined && typeof region.error.code === 'string'
          ? region.error
          : null;
      return h(
        'div',
        {
          key: 'download-region',
          'data-region': 'download-region',
          'data-download-region': current,
          'data-download-region-detected': detected ? 'true' : 'false',
          'data-download-region-stored': region !== null && region.stored === true ? 'true' : 'false',
          style: { display: 'flex', flexDirection: 'column', gap: 4 },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 13 } }, t('updateRegionLabel')),
          h(
            'select',
            {
              'data-action': 'update-region-select',
              'aria-label': t('updateRegionSelectLabel'),
              value: current,
              disabled: m.busy || saving,
              onChange: a.setDownloadRegion,
              style: {
                font: 'inherit',
                fontSize: 13,
                lineHeight: '20px',
                padding: '6px 10px',
                borderRadius: 8,
                color: token.labelPrimary,
                background: token.surface,
                border: `1px solid ${token.borderL2}`,
              },
            },
            ...DOWNLOAD_REGIONS.map((id) => h('option', { key: id, value: id }, t(regionLabelKey(id)))),
          ),
          saving ? h('span', { style: { ...metaStyle }, 'data-role': 'update-region-saving' }, t('updateRegionSaving')) : null,
        ),
        h('p', { style: { margin: 0, ...metaStyle }, 'data-role': 'update-region-note' }, t(regionNoteKey(current))),
        detected
          ? h(
              'p',
              { style: { margin: 0, ...metaStyle }, 'data-role': 'update-region-auto', 'data-update-region-auto': 'true' },
              fmt(t('updateRegionAuto'), { region: t(regionLabelKey(current)) }),
            )
          : null,
        unusable === null
          ? null
          : h(
              'p',
              {
                style: { margin: 0, ...metaStyle, color: token.stateError },
                'data-role': 'update-region-unusable',
                'data-update-region-error': unusable.code,
              },
              fmt(t('updateRegionUnusable'), { reason: errorText(t, unusable) }),
            ),
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

    /** The one-line meaning of one region id (same fallback rule as the label). */
    function regionNoteKey(id) {
      return id === 'cn' ? 'updateRegionCnNote' : id === 'custom' ? 'updateRegionCustomNote' : 'updateRegionDefaultNote';
    }

    /**
     * The lazy boundary the main bundle mounts for this tab.
     * @param props - the main bundle's page model, actions and translator.
     * @returns the tab element.
     */
    function AdvancedTab(props) {
      return renderAdvancedTab(props.t, props.m, props.a);
    }

    return { AdvancedTab, build: SELF_BUILD };
    /* @build-fingerprint:end */
  },
});

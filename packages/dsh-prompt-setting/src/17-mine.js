     * reach the model: the block reads `GET /assembly-status` for the selected
     * session and draws it. The assembly layer is what this plugin's assembly
     * returned (with its stated limit: a later `{prepend: true}` listener may
     * still rewrite the sections); the delivery layer is the `system/message`
     * this step committed on the surface. "Was the HTTP request really sent" is
     * not observable from a plugin and is not claimed anywhere here.
     *
     * One notice is shown — the last key node — because the Host produces one per
     * node, never one per step.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the block element.
     */
    function renderAssemblyStatus(t, m, a) {
      const state =
        m.assembly ?? { phase: 'idle', data: null, error: null, enabled: null, status: { kind: 'idle', error: null } };
      const payload = state.data !== null && typeof state.data === 'object' ? state.data : null;
      const ready = state.phase === 'ready' && payload !== null;
      const enabled = ready ? payload.enabled === true : m.assemblyEnabled === true;
      const switchStatus = m.assemblyStatus ?? { kind: 'idle', error: null };
      const record = ready && payload.record !== null && typeof payload.record === 'object' ? payload.record : null;
      const notice =
        record !== null && record.notice !== null && typeof record.notice === 'object' ? record.notice : null;
      // g-073 (Revision 55): 「高级」's own workspace selector names the session
      // whose assembly record is read (the host keys one record per session id) —
      // no longer the page's「查看范围」, which serves「我的 Prompt」alone. The
      // fallback keeps an older model shape readable; it is never reached by this
      // page, which always hands `assemblySession` over.
      const hasSession =
        m.assemblySession !== undefined ? m.assemblySession !== null : m.sessionArg !== null;
      // The one punctuation the two languages disagree about, so no sentence is
      // assembled by concatenating a hardcoded separator.
      const sep = t('assemblyLayerSep');
      const kindLabel = (kind) => t(kind === 'first-assembly' ? 'assemblyKindFirst' : 'assemblyKindChange');
      const assemblyVerdict = notice === null ? null : assemblyVerdictOf(t, notice);
      const deliveryVerdict = notice === null ? null : deliveryVerdictOf(t, notice);
      const matchedNote =
        notice !== null && notice.delivery.state === 'delivered' && notice.delivery.textMatched !== null
          ? fmt(t('assemblyMatchedSuffix'), {
              note: t(notice.delivery.textMatched === true ? 'assemblyTextMatchedYes' : 'assemblyTextMatchedNo'),
            })
          : '';
      const meta =
        notice !== null && notice.turn !== null && notice.step !== null
          ? fmt(t('assemblyNodeMeta'), { turn: String(notice.turn), step: String(notice.step) })
          : null;
      const errorStyle = { margin: 0, fontSize: 12, color: token.stateError, wordBreak: 'break-word' };
      const noteStyle = { margin: 0, ...metaStyle };
      const lineStyle = { margin: 0, fontSize: 13 };
      // Review C4: the degradation is reported from the **seat** — "no overlay is
      // registered" — never from the capability probe alone. A Host that has the
      // primitive but not the slot would otherwise show nothing at all.
      const toastSeat = overlaySeat.state;
      return h(
        'div',
        {
          'data-region': 'assembly-status',
          'data-assembly-phase': state.phase,
          'data-assembly-enabled': ready ? String(enabled) : 'unknown',
          'data-assembly-switch': switchStatus.kind,
          'data-assembly-session': hasSession ? 'yes' : 'none',
          'data-assembly-toast-seat': toastSeat,
          'data-notice-kind': notice === null ? 'none' : String(notice.kind),
          'data-assembly-state':
            notice === null
              ? 'none'
              : notice.kind === 'first-assembly'
                ? notice.assembly.assembled === true
                  ? 'assembled'
                  : 'empty'
                : String(notice.assembly.state),
          'data-delivery-state': notice === null ? 'none' : String(notice.delivery.state),
          style: { ...cardStyle, display: 'flex', flexDirection: 'column', gap: 6 },
        },
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('h3', { style: headingStyle }, t('assemblyHeading')),
          h('span', { style: metaStyle }, t('assemblySwitchLabel')),
          h(
            UI.Button,
            {
              'data-action': 'assembly-toggle',
              'aria-pressed': ready && enabled ? 'true' : 'false',
              disabled: m.busy || !ready || switchStatus.kind === 'saving',
              onClick: a.toggleAssemblyNotice,
            },
            switchStatus.kind === 'saving'
              ? t('assemblySaving')
              : t(ready && enabled ? 'assemblyTurnOff' : 'assemblyTurnOn'),
          ),
          h(
            'span',
            { 'data-assembly-switch-state': ready ? (enabled ? 'on' : 'off') : 'unknown', style: metaStyle },
            ready ? t(enabled ? 'assemblySwitchOn' : 'assemblySwitchOff') : '',
          ),
        ),
        h('p', { style: noteStyle }, t('assemblyIntro')),
        state.phase === 'error'
          ? h('p', { 'data-warning': 'assembly-unreadable', style: errorStyle }, errorText(t, state.error))
          : null,
        switchStatus.kind === 'error'
          ? h(
              'p',
              { 'data-warning': 'assembly-switch-failed', style: errorStyle },
              `${t('assemblySaveFailed')}${sep}${errorText(t, switchStatus.error)}`,
            )
          : null,
        !hasSession
          ? h('p', { 'data-assembly-note': 'no-session', style: noteStyle }, t('assemblyNoSession'))
          : null,
        hasSession && ready && record === null
          ? h('p', { 'data-assembly-note': 'no-record', style: noteStyle }, t('assemblyNoRecord'))
          : null,
        hasSession && record !== null && notice === null
          ? h('p', { 'data-assembly-note': 'no-notice', style: noteStyle }, t('assemblyNoNotice'))
          : null,
        notice !== null
          ? h(
              'div',
              { 'data-region': 'assembly-notice', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h(
                'p',
                { 'data-assembly-kind': String(notice.kind), style: { margin: 0, fontWeight: 600 } },
                meta === null ? kindLabel(notice.kind) : `${kindLabel(notice.kind)} · ${meta}`,
              ),
              h(
                'p',
                {
                  'data-assembly-layer':
                    notice.kind === 'first-assembly'
                      ? notice.assembly.assembled === true
                        ? 'assembled'
                        : 'empty'
                      : String(notice.assembly.state),
                  style: lineStyle,
                },
                `${t('assemblyLayerAssembly')}${sep}${assemblyVerdict}`,
              ),
              h(
                'p',
                { 'data-delivery-layer': String(notice.delivery.state), style: lineStyle },
                `${t('assemblyLayerDelivery')}${sep}${deliveryVerdict}${matchedNote}`,
              ),
              h('p', { style: noteStyle }, t('assemblyNoticeOnce')),
            )
          : null,
        // g-062 (Revision 46): the honest degradation, keyed on the **seat**
        // (review C4). Three different facts, three different sentences (review
        // R1) — a Host without the primitive, a Host that never declared the
        // slot, and a Host that declared it and refused the registration are not
        // the same thing, and saying "the slot is missing" about a Host that
        // declared it would be a false statement about the user's own machine.
        // Only `ready` is silent; everything else says which one happened.
        toastSeat === 'ready'
          ? null
          : h(
              'p',
              { 'data-assembly-note': 'no-toast', style: noteStyle },
              t(
                toastSeat === 'absent'
                  ? 'assemblyToastUnavailable'
                  : toastSeat === 'failed'
                    ? 'assemblyToastRefused'
                    : 'assemblyToastSlotMissing',
              ),
            ),
        h('p', { 'data-region': 'assembly-limitation', style: noteStyle }, t('assemblyLimitation')),
      );
    }

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
      // g-056: which side of the box is being shown (`draft` vs this target's
      // stored text), the readable scope the shown draft belongs to, and — when
      // the reader has unsaved text in a scope this box is **not** showing —
      // that draft. The last one is stated here and refuses the save below.
      const textSource = m.mineTextSource === 'draft' ? 'draft' : 'stored';
      const draftScope = m.mineDraftScope === undefined ? null : m.mineDraftScope;
      const foreignDraft = m.mineForeignDraft === undefined ? null : m.mineForeignDraft;
      // The names are built **here**, inside the tree-building try: `t` may be
      // the broken thing (see `renderFailureCard`), so the component's own path
      // never calls it.
      const scopeNameOf = (scope) =>
        scope === null || scope === undefined
          ? ''
          : mineScopeNameOf(
            t,
            scope.layer === 'workspace' ? 'workspace' : 'user',
            typeof scope.session === 'string' ? scope.session : null,
            m.seat.rows,
          );
      const draftScopeName = scopeNameOf(draftScope);
      const foreignScopeName = scopeNameOf(foreignDraft === null ? null : foreignDraft.scope);
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
      // g-055: the panel states its own write target, so the reader does not have
      // to look anywhere else to know which layer a save lands in. It is
      // read-only on purpose: the one place the scope is changed is the block
      // rendered directly above this line (g-071 moved it in from above the tab
      // bar), and a second switch here would be a second entrance — exactly what
      // this design refuses.
      const targetLine = h(
        'p',
        {
          'data-region': 'mine-target',
          'data-mine-target-layer': layer,
          'data-mine-target-scope': m.sessionArg === null ? 'global' : String(m.sessionArg),
          // g-058: the read-only target line also says which mode this save will
          // send and which one the file stores — the two facts a reader needs to
          // tell「还没保存」from「已生效」without opening the file.
          'data-mine-target-mode': m.mineMode,
          'data-mine-target-mode-stored': m.mineStoredMode === null || m.mineStoredMode === undefined
            ? 'none'
            : String(m.mineStoredMode),
          style: { margin: 0, ...metaStyle, color: token.labelSecondary },
        },
        fmt(t('mineTargetNote'), { layer: layerLabel(t, layer), scope: scopeName(t, m) }),
      );
      // g-058 (Revision 36): the entry's mode — `append` (叠加) or `replace`
      // (覆盖). Only the two words the write face accepts; anything else a stale
      // model might carry reads as the default.
      const mineMode = m.mineMode === 'append' ? 'append' : RESERVED_SECTION_DEFAULT_MODE;
      const mineStoredMode =
        m.mineStoredMode === 'append' || m.mineStoredMode === 'replace' ? m.mineStoredMode : null;
      // g-071: the scope card is no longer a block above the tab bar — this
      // panel renders it as its first block, right under its own title, and the
      // panel keeps the 3px rule that claims both as one surface.
      return h(
        'div',
        { 'data-region': 'mine', style: { ...promptBlockBandStyle, display: 'flex', flexDirection: 'column', gap: 10 } },
        h('h3', { style: headingStyle }, t('mineHeading')),
        renderPromptBlock(t, m, a),
        targetLine,
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
        // ---- g-058 (Revision 36): the「覆盖 / 叠加」mode of THIS layer's entry.
        // It is a control over this layer's stored mode and nothing else — it
        // writes no file on its own, it offers no second way to change the
        // write scope (the scope block above it keeps that single entrance,
        // g-055; it moved inside this panel in g-071), and
        // it can never reach the other layer's file: the save it feeds carries
        // one layer and one entry (§4.1).
        h(
          'div',
          {
            'data-region': 'mine-mode',
            'data-mine-mode': mineMode,
            'data-mine-mode-stored': mineStoredMode === null ? 'none' : mineStoredMode,
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
            h('span', { style: metaStyle }, t('mineModeLabel')),
            ...RESERVED_SECTION_MODES.map((choice) =>
              h(
                UI.Button,
                {
                  'data-action': 'mine-mode',
                  'data-mine-mode-choice': choice,
                  'data-mine-mode-active': String(mineMode === choice),
                  'aria-pressed': String(mineMode === choice),
                  disabled: m.busy,
                  onClick: () => a.setMineMode(choice),
                },
                t(choice === 'append' ? 'mineModeAppend' : 'mineModeReplace'),
              ),
            ),
            // The stored side, in words: 「未设置」is a different fact from
            // 「显式覆盖」, exactly as the interpolation switch's「继承」is (§16.1).
            h(
              'span',
              {
                'data-mine-mode-stored-label': mineStoredMode === null ? 'none' : mineStoredMode,
                style: metaStyle,
              },
              mineStoredMode === null
                ? t('mineModeStoredNone')
                : fmt(t('mineModeStored'), {
                    mode: t(mineStoredMode === 'append' ? 'mineModeAppend' : 'mineModeReplace'),
                  }),
            ),
          ),
          h(
            'p',
            { 'data-mine-mode-hint': mineMode, style: { margin: 0, ...metaStyle } },
            t(mineMode === 'append' ? 'mineModeHintAppend' : 'mineModeHintReplace'),
          ),
          h('p', { style: { margin: 0, ...metaStyle } }, t('mineModeNote')),
          layer === 'workspace'
            ? null
            : h(
                'p',
                { 'data-warning': 'mine-mode-bottom', style: { margin: 0, fontSize: 12, color: token.stateWarn } },
                t('mineModeBottomNote'),
              ),
          (mineStoredMode ?? RESERVED_SECTION_DEFAULT_MODE) !== mineMode
            ? h(
                'p',
                { 'data-warning': 'mine-mode-dirty', style: { margin: 0, fontSize: 12, color: token.stateWarn } },
                t('mineModeDirty'),
              )
            : null,
        ),
        foreignDraft === null
          ? null
          : h(
              'div',
              {
                'data-warning': 'mine-draft-elsewhere',
                'data-mine-draft-scope': foreignScopeName,
                'data-mine-draft-chars': String(foreignDraft.chars),
                style: { margin: 0, display: 'flex', flexDirection: 'column', gap: 4, wordBreak: 'break-word' },
              },
              h(
                'p',
                { style: { margin: 0, fontSize: 12, color: token.stateWarn } },
                fmt(t('mineDraftElsewhere'), { scope: foreignScopeName, chars: foreignDraft.chars }),
              ),
              h(
                UI.Button,
                {
                  'data-action': 'mine-drop-foreign-draft',
                  'data-mine-drop-scope': foreignScopeName,
                  disabled: m.busy,
                  onClick: a.dropForeignDraft,
                },
                t('mineDraftElsewhereDrop'),

// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。


    /**
     * g-030: the dismissible「有新版本」banner — and, since g-032, the place
     * 「立即更新」 starts.
     *
     * It renders **only** for a confirmed newer release: every other outcome
     * (no update, no release upstream, an unparsable tag, a network failure, a
     * timeout, the switch being off) returns `null` here, which is the page's
     * half of "无更新 / 失败 / 无 release：零提示、零报错红字". Nothing in this
     * function can produce an error banner, and it never writes state.
     *
     * g-032 keeps that rule and adds one: while an install is running, done or
     * failed, the banner shows **that** instead of「有新版本」. The alternative —
     * leaving the version pitch up after the install already started — is what
     * makes a user click「立即更新」twice and then wonder which one is real. The
     * dismissal stays available in every state (the install is the host's and
     * keeps running without this page).
     *
     * The link opens the release page in a new tab with `rel="noreferrer
     * noopener"` (a `target="_blank"` without it hands the opened page a
     * `window.opener` back into this settings page).
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the banner element, or `null`.
     */
    function renderUpdateNotice(t, m, a) {
      const u = m.update;
      if (u === null || u === undefined || u.dismissed === true || u.data === null) return null;
      const latest = typeof u.data.latest === 'string' ? u.data.latest : '';
      if (latest.length === 0) return null;
      const apply = u.apply ?? null;
      const step = apply === null ? null : apply.status ?? apply.phase ?? null;
      const running = apply !== null && (step === 'running' || step === 'cancelling');
      /**
       * The version this page has already **installed**, if any.
       *
       * The update button is offered only when that is not the version the banner
       * is announcing: after a `restart-required` install the two are equal, and
       * a button that installs what is already installed is exactly the "did I
       * press it twice?" confusion this banner must not create. A *later* release
       * (0.9.9 installed, 0.9.10 announced) makes them differ again and the
       * button returns — so nothing is lost by hiding it.
       */
      const installedVersion =
        apply !== null && apply.installed === true && typeof apply.version === 'string' ? apply.version : null;
      return h(
        'div',
        {
          key: 'update-notice',
          'data-region': 'update-notice',
          'data-update-available': 'true',
          'data-update-latest': latest,
          // The **status** the page branches on (`idle`/`running`/`done`/
          // `failed`/`cancelled`/`unknown`) — the same value the status row
          // carries, so the banner and the 「高级」 card can never disagree about
          // what is happening. The host's finer step lives in
          // `data-update-apply-phase` below (CONTRACT §18.7).
          'data-update-apply': apply === null ? 'idle' : String(apply.status ?? apply.phase ?? 'unknown'),
          style: {
            ...cardStyle,
            borderColor: step === 'failed' ? token.stateError : token.stateWarn,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            fontSize: 13,
          },
        },
        // The install's own line replaces the version pitch once it exists: two
        // competing statements about the same version is the one thing this
        // banner must never show.
        apply === null
          ? h('span', { style: { flex: '1 1 240px', minWidth: 0 } },
              fmt(t('updateAvailable'), {
                latest,
                current: typeof u.data.current === 'string' ? u.data.current : t('stPluginVersionUnknown'),
              }),
            )
          : renderUpdateApplyStatus(t, m, a),
        apply === null && typeof u.data.releaseUrl === 'string' && u.data.releaseUrl.length > 0
          ? h(
              'a',
              {
                key: 'release',
                href: u.data.releaseUrl,
                target: '_blank',
                rel: 'noreferrer noopener',
                'data-update-release-link': 'true',
                style: { color: token.stateBusiness },
              },
              t('updateReleaseLink'),
            )
          : null,
        // g-032:「立即更新」. Offered while nothing is installed yet, and again
        // when the announced version is **not** the one already installed (a
        // later release). Disabled while an install runs (the cancel button
        // beside it is the live control then) and while the page is busy with any
        // other write, so two writes can never race.
        installedVersion !== null && installedVersion === latest
          ? null
          : h(
              UI.Button,
              {
                key: 'apply',
                variant: 'primary',
                'data-action': 'update-apply',
                disabled: m.busy || running,
                onClick: () => a.requestUpdateApply(latest),
              },
              t('updateApply'),
            ),
        h(
          UI.Button,
          { key: 'dismiss', 'data-action': 'update-dismiss', onClick: a.dismissUpdate },
          t('updateDismiss'),
        ),
      );
    }

    /**
     * g-032: the install's own line, rendered in the banner **and** in「高级」.
     *
     * One function, two readers, because the two must never disagree about what
     * is happening: the banner is what the user sees while they are deciding,
     * and the 「高级」 card is where they come back when they dismissed it.
     *
     * The three states the goal names are exactly three branches plus the two
     * the manager can really produce:
     *   - `running` — a spinner-less sentence, the elapsed time, and a **cancel**
     *     button while the install has not reached the apply step. Nothing is
     *     disabled by the elapsed time: an install that waits two minutes for the
     *     profile lock is normal, not stuck;
     *   - `done` — `restart-required` is a **success** and the sentence is「已安装
     *     vX.Y.Z」plus the restart instruction for this launch shape (g-036:
     *     re-run `dsh web`, or quit and reopen DeepSeek Harness). `applied` is
     *     the rarer live case and says so; neither restarts anything;
     *   - `failed` — the host's own category, its sentence, and a retry button
     *     when the category is retryable. Nothing retries by itself;
     *   - `cancelled` / `unknown` — the two honest endings: the files were
     *     restored, or this page can no longer look the request up.
     *
     * The manual route (`manual.releaseUrl`) is rendered whenever the host sent
     * one: a failure whose only advice is "try again" would leave a user with no
     * way forward when the release simply has no asset yet.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the status element, or null when there is nothing to say.
     */
    function renderUpdateApplyStatus(t, m, a) {
      const u = m.update;
      if (u === null || u === undefined || u.apply === null || u.apply === undefined) return null;
      const apply = u.apply;
      // The host's three client-facing states are `running` / `done` / `failed`
      // (plus `cancelled` / `unknown`); its `phase` says *which* live step it is
      // in (`installing` / `cancelling`) and is what the stale-closure-free
      // `data-*` marker reports. Branching on `status` is deliberate: the two
      // names must not silently swap, and a phase this page does not know still
      // reads as the state it came under rather than as a failure.
      const phase =
        typeof apply.status === 'string'
          ? apply.status
          : typeof apply.phase === 'string'
            ? apply.phase
            : 'unknown';
      const version = typeof apply.version === 'string' && apply.version.length > 0 ? apply.version : null;
      const latest = version ?? apply.latest ?? '';
      const lines = [];
      const buttons = [];
      if (phase === 'running' || phase === 'cancelling') {
        const elapsed = formatElapsed(u.applyElapsed);
        lines.push(`${t(phase === 'cancelling' ? 'updateApplyCancelling' : 'updateApplying')}${elapsed === null ? '' : ` ${fmt(t('updateApplyElapsed'), { elapsed })}`}`);
        buttons.push(
          h(
            UI.Button,
            {
              key: 'cancel',
              'data-action': 'update-apply-cancel',
              disabled: phase === 'cancelling',
              onClick: a.cancelUpdateApply,
            },
            t(phase === 'cancelling' ? 'updateApplyCancelling' : 'updateApplyCancel'),
          ),
        );
      } else if (phase === 'done') {
        // g-036: the restart instruction is the launch shape's copy. `applied`
        // needs none: the new version is already running.
        const doneKey =
          apply.restartRequired === true ? updateApplyCopyKey('done', modelLaunchKind(m)) : 'updateApplyApplied';
        lines.push(
          fmt(t(doneKey), {
            version: latest === '' ? t('stPluginVersionUnknown') : latest,
          }),
        );
      } else if (phase === 'cancelled') {
        lines.push(t('updateApplyCancelled'));
      } else if (phase === 'unknown') {
        lines.push(t(updateApplyCopyKey('unknownState', modelLaunchKind(m))));
      } else {
        const error = apply.error ?? {};
        const reason = typeof error.message === 'string' && error.message.length > 0 ? error.message : t('updateApplyUnknown');
        lines.push(fmt(t('updateApplyFailed'), { reason }));
        if (typeof error.diagnostic === 'string' && error.diagnostic.length > 0) lines.push(error.diagnostic);
        // The host classifies every failure and says whether retrying can help:
        // a `link:`-shaped refusal, an incompatible version or a no-op install
        // gets no retry button, because pressing it again would do nothing.
        if (error.retryable !== false) {
          buttons.push(
            h(
              UI.Button,
              { key: 'retry', 'data-action': 'update-apply-retry', disabled: m.busy, onClick: a.retryUpdateApply },
              t('updateApplyRetry'),
            ),
          );
        }
        const manual = error.manual;
        if (manual !== null && typeof manual === 'object' && typeof manual.releaseUrl === 'string' && manual.releaseUrl.length > 0) {
          buttons.push(
            h(
              'a',
              {
                key: 'manual',
                href: manual.releaseUrl,
                target: '_blank',
                rel: 'noreferrer noopener',
                'data-update-apply-manual': 'true',
                style: { color: token.stateBusiness },
              },
              fmt(t('updateApplyManualLink'), { tag: apply.tag ?? '' }),
            ),
          );
        }
      }
      return h(
        'div',
        {
          key: 'update-apply-status',
          'data-region': 'update-apply-status',
          'data-update-apply-status': phase,
          'data-update-apply-phase': typeof apply.phase === 'string' ? apply.phase : 'unknown',
          style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 240px', minWidth: 0 },
        },
        ...lines.map((line, index) => h('span', { key: `line-${index}`, style: { fontSize: 13 } }, line)),
        buttons.length === 0 ? null : h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, ...buttons),
      );
    }

    /**
     * Format the running install's age for the page.
     * @param ms - milliseconds since the install started, or anything else.
     * @returns `m:ss`, or `null` when there is nothing usable to show.
     */
    function formatElapsed(ms) {
      if (!Number.isFinite(ms) || ms < 0) return null;
      const total = Math.floor(ms / 1000);
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    /**
     * g-043: the i18n key for one region id. An unknown id (a Host from the
     * future, a hand-edited answer) reads as「默认」rather than as a bare enum.
     *
     * g-061: the same three ids are named in **two** key families — the
     * 「查看范围」 label (`family: ''`, `updateRegionCn`) and the one-line note
     * under it (`family: 'Note'`, `updateRegionCnNote`). The id→key rule is
     * written once here and the family is the only thing a caller adds, so the
     * two families can never disagree about which id is「默认」.
     * @param id - `default` / `cn` / `custom`, or anything else.
     * @param family - the suffix that names the family (`''` for the label).
     * @returns the dictionary key.
     */
    function regionKey(id, family) {
      const suffix = typeof family === 'string' ? family : '';
      return id === 'cn'
        ? `updateRegionCn${suffix}`
        : id === 'custom'
          ? `updateRegionCustom${suffix}`
          : `updateRegionDefault${suffix}`;
    }

    /**
     * g-043: the「自定义」dialog — the address field, its red line, and the two
     * buttons.
     *
     * It is its own overlay rather than another `renderConfirm` branch because
     * what it needs is a **form**: a text field, a validation error that stays on
     * screen (the confirm overlay has no such slot), and a submit that must not
     * close the dialog when the Host refuses the address. Three rules from §17.10
     * are visible here:
     *   - the failure is **red and in the dialog** (`data-role="region-error"`),
     *     never a page notice the user could miss while the dialog covers it;
     *   - the dialog stays open on a refusal, so the address can be corrected in
     *     place, and closing it is always an explicit choice;
     *   - it never writes anything itself: the `PUT` is the same action the
     *     dropdown uses, so there is exactly one save path.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the overlay element, or null when the dialog is closed.
     */
    function renderRegionDialog(t, m, a) {
      const dialog = m.regionDialog ?? null;
      if (dialog === null) return null;
      const checking = dialog.phase === 'saving';
      return h(
        'div',
        {
          key: 'region-overlay',
          'data-region': 'region-overlay',
          // The tab-dialog layer, stated here rather than defaulted: 1000, the
          // same value the history comparison modal and the two preset dialogs
          // use, and deliberately **below** the shared confirmation overlay
          // (1200, review R6).
          style: scrimStyle(1000),
        },
        h(
          'div',
          {
            'data-region': 'region-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('updateRegionCustomTitle'),
            style: dialogCardStyle({
              width: '100%',
              gap: 10,
              maxWidth: 480,
              // g-061 batch 3: this dialog states neither `maxHeight` nor an
              // `overflow` — it always has, and the batch keeps it that way
              // instead of quietly giving it the confirmation's 80vh.
            }),
          },
          h('strong', { style: confirmTitleStyle }, t('updateRegionCustomTitle')),
          h('div', { 'data-role': 'region-body', style: confirmTextStyle }, t('updateRegionCustomBody')),
          h(UI.Input, {
            'data-role': 'region-input',
            value: dialog.value,
            placeholder: t('updateRegionCustomPlaceholder'),
            disabled: m.busy || checking,
            onChange: a.setRegionCustomValue,
          }),
          dialog.error === null
            ? null
            : errorLine({
                role: 'region-error',
                probe: 'data-region-error',
                code: dialog.error.code,
                fontSize: 13,
                text: errorText(t, dialog.error),
              }),
          h(
            'div',
            { 'data-role': 'region-actions', style: confirmActionsStyle },
            h(
              UI.Button,
              {
                variant: 'primary',
                'data-action': 'region-save',
                disabled: m.busy || checking,
                onClick: a.submitRegionCustom,
              },
              checking ? t('updateRegionCustomChecking') : t('updateRegionCustomSubmit'),
            ),
            h(
              UI.Button,
              { 'data-action': 'region-cancel', disabled: m.busy || checking, onClick: a.cancelRegionCustom },
              t('updateRegionCustomCancel'),
            ),
          ),
        ),
      );
    }

    /**
     * Build the whole page tree. Kept separate so the hook order in the
     * component above stays fixed and the entire tree is produced inside one
     * `try`.
     *
     * The chrome above the tabs is deliberately two things only — the title and
     * one line of deciding facts ({@link renderStatusLine}). Everything else
     * moved into the tab that owns it, which is what makes the page short again.
     *
     * g-055 took the session selector out of that chrome into the「我的 Prompt」
     * block ({@link renderPromptBlock}), which is the only surface it writes;
     * g-071 moved that block itself **into** the mine panel, so the selector is
     * rendered by the surface it belongs to and the chrome no longer depends on it
     * at all. The tabs other than「我的 Prompt」render no scope surface of their
     * own (R4 withdrew the read-only line g-071 first gave them — their scopes are
     * their own business, see g-073).
     * The selector is still one instance and still the one place the scope is
     * changed.
     *
     * @param t - the bound translator for this namespace.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the page element.
     */
    function renderSection(t, m, a) {
      const children = [];
      children.push(
        h(
          'div',
          {
            key: 'title',
            // Revision 17: the version sits beside the title, on the flex
            // baseline, instead of in the status line — the page's identity, not
            // another health chip.
            style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
          },
          h('h2', { key: 'heading', style: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '26px' } }, t('title')),
          renderPluginVersion(t, m),
        ),
      );
      children.push(h('p', { key: 'subtitle', style: { margin: 0, fontSize: 13, color: token.labelTertiary } }, t('subtitle')));
      // g-030: the update banner, when — and only when — the Host confirmed a
      // newer release. It sits above the tabs so it is true of the page rather
      // than of one tab, and the dismissal is rendered by returning `null`.
      const updateNotice = renderUpdateNotice(t, m, a);
      if (updateNotice !== null) children.push(updateNotice);
      children.push(renderStatusLine(t, m, a));
      // g-071: nothing scope-shaped lives above the tabs any more. The picker is
      // rendered by「我的 Prompt」itself (renderMinePanel → renderPromptBlock);
      // no other tab carries a scope surface of its own (R4), and the tab bar
      // keeps the last-but-one slot.
      // g-070: the two decorations the first-level bar carries, both read as
      // facts rather than assumed: the preset library's real entry count
      // (`null` ⇒ no suffix at all, never a false `(0)`) and whether a newer
      // release is on offer (the banner's own test, minus its dismissal — see
      // `updateOffered`).
      const presetCount = presetCountOf(m.presets);
      const updateDot = updateOffered(m.update);
      children.push(
        h(
          'div',
          {
            key: 'tabs',
            'data-region': 'tabs',
            'data-active-tab': m.tab,
            // No `overflow` here: since g-070 the scroll container **is** the
            // tablist rendered below (`mainTabStrip`), and the wrapper stays a
            // plain block so nothing about the strip's width reaches an ancestor.
            // The g-063 rounds 1–3 note this line used to carry is kept in the
            // decision comment above `tabs()`.
          },
          mainTabStrip(
            MAIN_TABS.map((value) => ({
              value,
              label: t(
                value === 'mine'
                  ? 'tabMine'
                  : value === 'presets'
                    ? 'tabPresets'
                    : value === 'overview'
                      ? 'tabOverview'
                      : value === 'history'
                        ? 'tabHistory'
                        : value === 'backup'
                          ? 'tabBackup'
                          : 'tabAdvanced',
              ),
              // The two identity fields the items have always carried (`tabs()`
              // does not read them either); kept so the item contract around
              // `MAIN_TABS` is unchanged in this batch.
              id: `ps-tab-${value}`,
              panelId: 'ps-tab-panel',
              // g-070: the count hangs off「我的预设」, the red dot off「高级」 —
              // the two tabs the operator named, and no others.
              count: value === 'presets' ? presetCount : null,
              badge: value === 'advanced' && updateDot,
            })),
            m.tab,
            a.setTab,
            t('title'),
            t('tabUpdateBadge'),
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
      // g-043: the custom-mirror dialog is the second fixed overlay, and the two
      // are mutually exclusive in practice (their triggers live in different
      // cards). Pushed here for the same reason as the confirm card.
      const regionCard = renderRegionDialog(t, m, a);
      if (regionCard !== null) children.push(regionCard);
      // g-071: the tab panel holds the tab's own surface and nothing else. No
      // scope-shaped node is injected here (R4 withdrew the read-only line).
      //
      // g-073 (Revision 55; extended in review R1): the panel's gate follows
      // **the tab's own** read, because the page-scoped snapshot is not a
      // prerequisite of any other surface:
      //   - 「我的 Prompt」 is the read that page scope belongs to, so it is the one
      //     tab gated on `m.snap`;
      //   - 「提示词总览」 and 「高级」 read `/snapshot` in **their own** scopes, so
      //     their panels follow `m.overviewSnap` / `m.advancedSnap` — a failing
      //     page-scoped read must not blank a tab that already has its data;
      //   - 「我的预设」 (the library), 「版本历史」 (the log) and 「备份与恢复」 (the
      //     transfer document) consume **no** snapshot at all: each carries its own
      //     state and renders its own phase, so none of them is gated on a read it
      //     never made.
      const panelGate = (() => {
        if (m.tab === 'mine') {
          return { loading: m.snap.phase === 'loading' && !m.snap.data, ready: Boolean(m.snap.data) };
        }
        if (m.tab === 'overview') {
          return {
            loading: m.overviewSnap.phase === 'loading' && !m.overviewSnap.data,
            ready: Boolean(m.overviewSnap.data),
          };
        }
        if (m.tab === 'advanced') {
          return {
            loading: m.advancedSnap.phase === 'loading' && !m.advancedSnap.data,
            ready: Boolean(m.advancedSnap.data),
          };
        }
        if (m.tab === 'presets') {
          // Its own read is the library; `idle` is the one frame before that read
          // has been issued, and it must not render as「没有预设」. Data already on
          // screen wins over the phase: a refresh must not replace a rendered
          // library with a loading line (review R3).
          return {
            loading: (m.presets.phase === 'idle' || m.presets.phase === 'loading') && !m.presets.data,
            ready: true,
          };
        }
        if (m.tab === 'history') {
          // Same rule: while the log is being re-read (a reload, or a page whose
          // answer is in flight) the records already on screen stay — the loading
          // line is for "nothing to show yet", not for "switching back"
          // (review R3-2).
          return {
            loading: (m.hist.phase === 'idle' || m.hist.phase === 'loading') && !m.hist.data,
            ready: true,
          };
        }
        // 「备份与恢复」 issues no read of its own until a button is pressed.
        return { loading: false, ready: true };
      })();
      children.push(
        h('div', { key: 'panel', 'data-region': 'panel' },
          panelGate.loading ? h('p', { key: 'loading', style: metaStyle }, t('loading')) : null,
          panelGate.ready
            ? h(
                'div',
                { key: 'tab-panel', 'data-region': 'tab-panel', 'data-tab-value': m.tab },
                m.tab === 'mine'
                  ? renderMinePanel(t, m, a)
                  : m.tab === 'presets'
                    ? renderPresetsChunk(t, m, a)
                    : m.tab === 'overview'
                      ? renderOverviewChunk(t, m, a)
                      : m.tab === 'history'
                        ? renderHistoryChunk(t, m, a)
                        : m.tab === 'backup'
                          ? renderBackupChunk(t, m, a)
                          : renderAdvancedChunk(t, m, a),
              )
            : null,
        ),
      );
      return h(
        'div',
        {
          'data-plugin': 'dsh-prompt-setting',
          // `activeRenderer()`, not the probe's `RENDERER`: after a render-time
          // failure of the Host's atoms this page draws with the hand-built
          // atoms, and the marker has to name the branch really in use (g-063 E1).
          'data-renderer': activeRenderer(),
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
          // g-045: which chunks this page has *actually loaded*, as
          // `name:hash` pairs (`,`-separated; `none` before the first one). The
          // main digest above is one file's bytes; this is the other half of the
          // question, and a probe can see that a tab was opened without asking
          // the page to render one.
          'data-build-loaded': loadedChunkStamps()
            .map((entry) => `${entry.name}:${entry.hash}`)
            .join(',') || 'none',
          // g-029: the version the host reported in the same ping, verbatim, or
          // `unknown` — never a version this bundle made up. The visible node is
          // beside the page title (Revision 17); this copy stays on the root
          // container so a probe reads it without knowing the layout.
          'data-plugin-version': pluginVersionOf(m.boot),
          // g-036: the launch shape every restart instruction on this page was
          // rendered for — `cli` / `desktop` / `unknown`. On the root container,
          // so a real-machine check reads the shape off one attribute instead of
          // matching sentences.
          'data-launch-kind': modelLaunchKind(m),
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

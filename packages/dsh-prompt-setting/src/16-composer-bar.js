// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。

    /**
     * g-086: the resident assembly bar above the composer.
     *
     * One read-only line in the Host's `conversation.input.dock` slot — "full-width
     * entries above the composer card" (Host contract 0.2.1-rc.3). Four properties
     * are load-bearing:
     *   - **a list entry, never a shadow** — the slot is `kind: 'list'`, so this
     *     registration is appended beside the shipped ones (`queue`, `todo`);
     *     `ctx.slots.inject` runs only once the Host has declared the slot, so a
     *     Host without it loses the bar, not the plugin (the same degradation the
     *     `shell.overlay` toaster relies on);
     *   - **read-only** — every request here is a `GET`; the bar never saves a
     *     prompt, never enables an assembly and never switches a layer. Its only
     *     write-like act is a re-read the user asked for;
     *   - **the page's own口径** — the two layer regions call `mineCoverageOf`,
     *     the very function「我的 Prompt」's summary uses (g-084), and the
     *     notice region calls `assemblyVerdictOf` / `deliveryVerdictOf`, the same
     *     two verdicts the settings page and the toaster print. A bar that
     *     disagreed with the page it summarizes would be worse than no bar;
     *   - **zero requests without a Session** — the Host renders this slot only
     *     with a Session (`InputZone` needs one), but the component does not rely
     *     on that: an absent Session id short-circuits *before* any `fetch`.
     *
     * Scope: the five data regions are addressed by `data-region` and the semantic
     * colour by `data-tone` (`normal` / `warn` / `error` / `unknown`), so a probe
     * reads attributes instead of guessing at text.
     */

    /** `conversation.input.dock` ordering: shipped entries are `todo` (0) and `queue` (20); 30 sits nearest the composer. */
    const COMPOSER_BAR_ORDER = 30;
    /** The bar's own root marker（与五个分区的 `data-region` 区分开）. */
    const COMPOSER_BAR_REGION = 'composer-assembly-bar';
    /**
     * The five region keys, in display order. Frozen and exported through
     * `__internals` so a test (and a probe) can assert the roster instead of
     * re-typing it.
     */
    const COMPOSER_BAR_REGIONS = Object.freeze([
      'bar-sections',
      'bar-user-layer',
      'bar-workspace-layer',
      'bar-assembly',
      'bar-settings',
    ]);
    /**
     * One distinguishable hue per region, Host theme tokens first.
     *
     * The hue is carried by the region's left rule and its label, never by the
     * value text: the value is coloured semantically (`data-tone`), so a theme
     * that maps a hue token onto a low-contrast colour can only weaken the rule,
     * not make the number unreadable. Five fallbacks are plain CSS colours with
     * enough contrast on both light and dark module backgrounds.
     */
    const COMPOSER_BAR_HUES = Object.freeze({
      'bar-sections': 'var(--dsw-alias-state-business-primary, #2563eb)',
      'bar-user-layer': 'var(--dsw-alias-state-success-primary, #15803d)',
      'bar-workspace-layer': 'var(--dsw-alias-state-warning-primary, #b45309)',
      'bar-assembly': 'var(--dsw-alias-brand-primary, #7c3aed)',
      'bar-settings': 'var(--dsw-alias-state-info-primary, #0e7490)',
    });

    /**
     * The semantic colour of one verdict, as a theme token.
     * @param tone - `normal` | `warn` | `error` | `unknown`.
     * @returns the CSS colour for the value text.
     */
    function composerBarToneColor(tone) {
      if (tone === 'error') return token.stateError;
      if (tone === 'warn') return token.stateWarn;
      if (tone === 'normal') return token.labelPrimary;
      return token.labelTertiary;
    }

    /**
     * The Hue of one region.
     * @param region - one of {@link COMPOSER_BAR_REGIONS}.
     * @returns its CSS colour, or the tertiary label colour for an unknown key.
     */
    function composerBarHueOf(region) {
      return COMPOSER_BAR_HUES[region] === undefined ? token.labelTertiary : COMPOSER_BAR_HUES[region];
    }

    /**
     * The Session this bar reads, from the several seats a Host may use.
     *
     * `conversation.input.dock`'s owner share is `InputZone {session, input}`, so
     * `props.session.sessionId` is the intended seat; `barSessionId` is this
     * registration's own inject face (the Host passes the scope id to a
     * Session-scoped `inject`), and a bare `sessionId` is accepted for the same
     * reason. Anything else is "no Session", which issues **no request**.
     * @param props - the entry's props.
     * @returns the Session id, or `''`.
     */
    function composerBarSessionIdOf(props) {
      const snapshot = props === null || props === undefined ? null : props.session;
      const fromSnapshot = snapshot !== null && typeof snapshot === 'object' ? snapshot.sessionId : undefined;
      if (typeof fromSnapshot === 'string' && fromSnapshot.length > 0) return fromSnapshot;
      for (const candidate of [props === null || props === undefined ? undefined : props.barSessionId, props === null || props === undefined ? undefined : props.sessionId]) {
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
      }
      return '';
    }

    /**
     * The three reads this bar needs, as URLs — or `null` when there is no Session.
     *
     * `?session=` is the whole scope: the Host resolves the workspace layer from
     * it (§2.4), so the client never has to name a workspace root it does not own.
     * Pure and side-effect free, which is what makes "no Session ⇒ no request"
     * assertable without a transport.
     * @param sessionId - the Session id, or `''`.
     * @returns `{snapshot, overrides, assembly}`, or `null`.
     */
    function composerBarRequestUrls(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
      const query = `?session=${encodeURIComponent(sessionId)}`;
      return {
        snapshot: `${SNAPSHOT_PATH}${query}`,
        overrides: `${OVERRIDES_PATH}${query}`,
        assembly: `${ASSEMBLY_STATUS_PATH}${query}`,
      };
    }

    /**
     * The assembled section count — `effective.sections.length`.
     *
     * The same number「提示词总览」counts (`sectionsShown`) and the same one
     * `emptyTitle` calls "no sections": the post-waterfall view, including
     * entries that produced no rendered section. Counting only `index !== null`
     * would silently disagree with the settings page, which is the one thing this
     * bar must not do.
     * @param payload - a `GET /prompt-setting/snapshot` payload, or null.
     * @returns the count, or `null` when the payload cannot answer.
     */
    function composerBarSectionCount(payload) {
      if (payload === null || typeof payload !== 'object') return null;
      const effective = payload.effective;
      if (effective === null || typeof effective !== 'object') return null;
      return Array.isArray(effective.sections) ? effective.sections.length : null;
    }

    /**
     * One layer's read-only verdict.
     *
     * The coverage half is **exactly**「我的 Prompt」's second line: the same
     * `mineCoverageOf(layer, overrides, effective.sections)` call, so "this layer
     * stores N overrides and M of them did not take effect" means the same thing
     * in both places. The disability half reads the snapshot's own
     * `layers[layer].enabled` (§2), because a disabled layer is not "zero
     * overrides" — it is a layer the Host refuses to apply.
     * @param layer - `user` | `workspace`.
     * @param snapshot - a `GET /prompt-setting/snapshot` payload, or null.
     * @param overrides - a `GET /prompt-setting/overrides` payload, or null.
     * @returns `{kind, total, ineffective}` where `kind` is `ready`, `none`,
     *   `disabled` or `error`.
     */
    function composerBarLayerFact(layer, snapshot, overrides) {
      if (snapshot === null || typeof snapshot !== 'object') return { kind: 'error', total: 0, ineffective: 0 };
      if (overrides === null || typeof overrides !== 'object') return { kind: 'error', total: 0, ineffective: 0 };
      const layers = snapshot.layers !== null && typeof snapshot.layers === 'object' ? snapshot.layers : null;
      const view = layers !== null && layers[layer] !== null && typeof layers[layer] === 'object' ? layers[layer] : null;
      if (view !== null && view.enabled === false) return { kind: 'disabled', total: 0, ineffective: 0 };
      const sections =
        snapshot.effective !== null && typeof snapshot.effective === 'object' && Array.isArray(snapshot.effective.sections)
          ? snapshot.effective.sections
          : [];
      const coverage = mineCoverageOf(layer, overrides, sections);
      return {
        kind: coverage.total === 0 ? 'none' : 'ready',
        total: coverage.total,
        ineffective: coverage.ineffective,
      };
    }

    /**
     * The key node's notice, or `null` when there is nothing to summarize.
     *
     * A notice without its two verdict objects is not a notice this bar can
     * print; treating it as absent is the honest answer (the settings page's
     * summary does the same).
     * @param payload - a `GET /prompt-setting/assembly-status` payload, or null.
     * @returns the notice, or `null`.
     */
    function composerBarNoticeOf(payload) {
      if (payload === null || typeof payload !== 'object') return null;
      const record = payload.record;
      if (record === null || typeof record !== 'object') return null;
      const notice = record.notice;
      if (notice === null || typeof notice !== 'object') return null;
      if (notice.assembly === null || typeof notice.assembly !== 'object') return null;
      if (notice.delivery === null || typeof notice.delivery !== 'object') return null;
      return notice;
    }

    /**
     * The settings opener this Host exposes, if any — the capability probe behind
     * region 5.
     *
     * The 0.2.1-rc.3 Host ships no public API that opens the settings panel and
     * selects a section from an unrelated plugin: the panel's open/section state
     * lives in a store created privately by `sidebar.settings` (`ui-settings-general`),
     * `settings.launcher`'s `openSettings` owner prop exists only for occupants of
     * that slot, and the `settings.open` command is registered with the shortcuts
     * service, which exposes `register`/catalog only — no dispatch. So the official
     * path is "not available", and this probe is what makes that a **fact** rather
     * than an assumption: a Host that ever passes `openSettings` (or
     * `openSettingsPanel`) through the entry props upgrades the button with no
     * change here, and every other Host gets the explicit fallback sentence.
     * @param props - the entry's props.
     * @returns a zero-argument opener, or `null`.
     */
    function composerBarSettingsOpener(props) {
      if (props === null || props === undefined) return null;
      for (const name of ['openSettings', 'openSettingsPanel']) {
        const candidate = props[name];
        if (typeof candidate === 'function') return () => candidate.call(props);
      }
      return null;
    }

    /**
     * One region's element: a hue rule, an optional small label, a semantic value
     * and an optional trailing control.
     *
     * An empty label/value renders no span at all — the settings region is a
     * button and a hue rule, and an empty span element there would be a phantom cell
     * a probe could mistake for content.
     * @param options - `region`, `label`, `value`, `tone`, `extra`.
     * @returns the region element.
     */
    function composerBarRegionOf(options) {
      const hue = composerBarHueOf(options.region);
      const hasLabel = typeof options.label === 'string' && options.label.length > 0;
      const hasValue = typeof options.value === 'string' && options.value.length > 0;
      return h(
        'div',
        {
          'data-region': options.region,
          'data-tone': options.tone,
          'data-bar-hue': hue,
          style: {
            display: 'flex',
            alignItems: 'baseline',
            gap: 5,
            minWidth: 0,
            paddingLeft: 6,
            borderLeft: `3px solid ${hue}`,
            ...(options.region === 'bar-settings' ? { marginLeft: 'auto' } : {}),
          },
        },
        hasLabel
          ? h(
              'span',
              {
                'data-bar-label': '',
                style: { fontSize: 11, lineHeight: '14px', color: composerBarLabelColorOf(hue), whiteSpace: 'nowrap' },
              },
              options.label,
            )
          : null,
        hasValue
          ? h(
              'span',
              {
                'data-bar-value': '',
                // The full sentence is often wider than the cell's budget; the
                // tooltip keeps the tail readable without letting one long
                // verdict push the other regions off the row.
                title: options.value,
                style: {
                  fontSize: 12,
                  lineHeight: '16px',
                  fontWeight: 500,
                  color: composerBarToneColor(options.tone),
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: options.region === 'bar-assembly' ? 460 : 280,
                },
              },
              options.value,
            )
          : null,
        options.extra === undefined ? null : options.extra,
      );
    }

    /**
     * The label colour of one region — the hue itself when the Host's tokens make
     * it legible, the tertiary label otherwise. Deliberately the *same* colour the
     * rule uses: two colours would make a region look like two regions.
     * @param hue - the region's CSS colour.
     * @returns the colour for the small label.
     */
    function composerBarLabelColorOf(hue) {
      return typeof hue === 'string' && hue.length > 0 ? hue : token.labelTertiary;
    }

    /**
     * The whole bar.
     *
     * Renders five `data-region` cells in one wrapped row. The reads happen on
     * mount, on Session change and on the user's explicit refresh — never on a
     * timer: a resident poll would be a request the user did not ask for on every
     * open tab, and the facts it would pick up (a save in the settings panel)
     * arrive with a fresh mount or one click.
     * @param props - the entry's props (`session`, `barSessionId`, `t`, …).
     * @returns the bar element.
     */
    function ComposerAssemblyBar(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const sessionId = composerBarSessionIdOf(props);
      const [read, setRead] = React.useState({
        phase: sessionId === '' ? 'no-session' : 'loading',
        snapshot: null,
        overrides: null,
        assembly: null,
      });
      const [nonce, setNonce] = React.useState(0);
      const [hint, setHint] = React.useState(false);

      React.useEffect(() => {
        const urls = composerBarRequestUrls(sessionId);
        if (urls === null) {
          // No Session ⇒ no request at all. This is the promise `verify` cannot
          // make for us: a component that asked "just in case" would leak a
          // request per mounted blank composer.
          setRead({ phase: 'no-session', snapshot: null, overrides: null, assembly: null });
          return undefined;
        }
        let cancelled = false;
        setRead((current) => ({
          phase: 'loading',
          // A refresh keeps the last answer on screen instead of blanking the
          // bar; only the phase changes, so the row does not jump.
          snapshot: current.snapshot,
          overrides: current.overrides,
          assembly: current.assembly,
        }));
        const load = async () => {
          const snapshot = await requestJson(urls.snapshot);
          const overrides = await requestJson(urls.overrides);
          const assembly = await requestJson(urls.assembly);
          if (cancelled) return;
          setRead({
            phase: 'ready',
            snapshot: snapshot.ok === true ? snapshot.payload : null,
            overrides: overrides.ok === true ? overrides.payload : null,
            assembly: assembly.ok === true ? assembly.payload : null,
          });
        };
        void load();
        return () => {
          cancelled = true;
        };
      }, [sessionId, nonce]);

      const phase = read.phase;
      const notice = composerBarNoticeOf(read.assembly);
      const layerLine = (layer) => {
        if (phase === 'no-session') return { text: t('barNoSession'), tone: 'unknown' };
        if (phase !== 'ready') return { text: t('loading'), tone: 'unknown' };
        const fact = composerBarLayerFact(layer, read.snapshot, read.overrides);
        if (fact.kind === 'error') return { text: t('loadFailed'), tone: 'error' };
        if (fact.kind === 'disabled') return { text: t('stDisabled'), tone: 'warn' };
        if (fact.kind === 'none') return { text: t('stNone'), tone: 'unknown' };
        return {
          text: fmt(t('mineStatusCoverage'), { total: String(fact.total), ineffective: String(fact.ineffective) }),
          tone: fact.ineffective > 0 ? 'warn' : 'normal',
        };
      };
      const sectionsValue =
        phase === 'no-session'
          ? { text: t('barNoSession'), tone: 'unknown' }
          : phase !== 'ready'
            ? { text: t('loading'), tone: 'unknown' }
            : composerBarSectionCount(read.snapshot) === null
              ? { text: t('loadFailed'), tone: 'error' }
              : { text: String(composerBarSectionCount(read.snapshot)), tone: 'normal' };
      const assemblyValue =
        phase === 'no-session'
          ? { text: t('barNoSession'), tone: 'unknown' }
          : phase !== 'ready'
            ? { text: t('loading'), tone: 'unknown' }
            : read.assembly === null
              ? { text: t('loadFailed'), tone: 'error' }
              : notice === null
                ? { text: t('mineStatusNoRecord'), tone: 'unknown' }
                : {
                    text: [
                      `${t('assemblyLayerAssembly')}${t('assemblyLayerSep')}${assemblyVerdictOf(t, notice)}`,
                      `${t('assemblyLayerDelivery')}${t('assemblyLayerSep')}${deliveryVerdictOf(t, notice)}`,
                    ].join(' · '),
                    tone: notice.delivery.state === 'delivered' ? 'normal' : 'warn',
                  };

      const userLine = layerLine('user');
      const workspaceLine = layerLine('workspace');
      const refreshButton = h(
        'button',
        {
          type: 'button',
          'data-action': 'composer-bar-refresh',
          'aria-label': t('refresh'),
          title: t('refresh'),
          onClick: () => setNonce((value) => value + 1),
          style: {
            font: 'inherit',
            fontSize: 11,
            lineHeight: '14px',
            padding: '0 4px',
            border: 'none',
            borderRadius: 4,
            background: 'transparent',
            color: token.labelSecondary,
            cursor: 'pointer',
          },
        },
        t('refresh'),
      );
      const settingsButton = h(
        'button',
        {
          type: 'button',
          'data-action': 'composer-bar-settings',
          'aria-label': t('nav'),
          title: t('nav'),
          onClick: () => {
            const open = composerBarSettingsOpener(props);
            if (open !== null) {
              open();
              return;
            }
            // The honest degradation: the button stays visible and says why it
            // cannot do what it looks like it does — never a silent no-op.
            setHint(true);
          },
          style: {
            font: 'inherit',
            fontSize: 12,
            lineHeight: '16px',
            fontWeight: 500,
            padding: '1px 8px',
            border: `1px solid ${token.surfaceStroke}`,
            borderRadius: 999,
            background: 'transparent',
            color: token.stateBusiness,
            cursor: 'pointer',
          },
        },
        t('nav'),
      );

      return h(
        'div',
        {
          'data-plugin': 'dsh-prompt-setting',
          'data-region': COMPOSER_BAR_REGION,
          'data-composer-bar-state': phase,
          'data-composer-bar-session': sessionId === '' ? '' : sessionId,
          role: 'status',
          'aria-live': 'polite',
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '4px 14px',
            margin: '0 0 6px',
            padding: '5px 10px',
            border: `1px solid ${token.surfaceStroke}`,
            borderRadius: 8,
            background: token.surface,
            color: token.labelPrimary,
            font: 'inherit',
            fontSize: 12,
            lineHeight: '16px',
          },
        },
        composerBarRegionOf({
          region: 'bar-sections',
          label: t('viewSections'),
          value: sectionsValue.text,
          tone: sectionsValue.tone,
        }),
        composerBarRegionOf({
          region: 'bar-user-layer',
          label: t('ovUser'),
          value: userLine.text,
          tone: userLine.tone,
        }),
        composerBarRegionOf({
          region: 'bar-workspace-layer',
          label: t('ovWorkspace'),
          value: workspaceLine.text,
          tone: workspaceLine.tone,
        }),
        composerBarRegionOf({
          region: 'bar-assembly',
          label: t('assemblyHeading'),
          value: assemblyValue.text,
          tone: assemblyValue.tone,
          extra: refreshButton,
        }),
        composerBarRegionOf({
          region: 'bar-settings',
          label: '',
          value: '',
          tone: 'unknown',
          extra: settingsButton,
        }),
        hint === true
          ? h(
              'p',
              {
                'data-region': 'bar-settings-hint',
                'data-composer-bar-hint': 'unavailable',
                role: 'status',
                style: {
                  margin: 0,
                  flexBasis: '100%',
                  fontSize: 11,
                  lineHeight: '14px',
                  color: token.labelSecondary,
                  wordBreak: 'break-word',
                },
              },
              t('barSettingsFallback'),
            )
          : null,
      );
    }


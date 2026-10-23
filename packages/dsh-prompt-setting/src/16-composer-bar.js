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
     * An opener the entry props themselves carry, if any — the first seat the
     * button tries.
     *
     * No 0.2.1-rc.3 slot hands `openSettings` to an unrelated entry (that owner
     * prop belongs to `settings.launcher`), so in practice this returns `null`;
     * it stays because a Host that ever does pass one must not need a code change
     * here to get the direct path.
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
     * Invoke the Host's own `settings.open` command, through the shortcuts
     * registry's **public** `invoke(id, context)` (g-086 R1).
     *
     * This is the honest answer to "how does a bar open the settings panel":
     * `ui-settings-general` registers `settings.open` with `modals:
     * ["settings"]`, and `ShortcutRegistry.invoke` checks only
     * `context.modal !== null && !command.modals.includes(context.modal)` before
     * running `resolve(...)`. Passing `modal: null` therefore elects the command
     * and runs its `shellInstance.actions.open()` branch — the panel opens from a
     * plugin that never occupied `settings.launcher`. (Dispatching a synthetic
     * keyboard event would also "work" and is exactly the kind of fragile
     * mechanism this avoids: the registry's own entry point is a documented one.)
     *
     * `shortcuts` is read through `ctx.get('shortcuts')` rather than declared in
     * `inject`: a Host without the service must still apply this plugin (the
     * same optional-read discipline `locale` follows), and a refused or throwing
     * read must degrade to `false`, never to a throw inside a click handler.
     * @param shortcuts - the shortcuts service, or anything else.
     * @returns `true` only when the command was really invoked.
     */
    function composerBarInvokeSettingsShortcut(shortcuts) {
      if (shortcuts === null || typeof shortcuts !== 'object' || typeof shortcuts.invoke !== 'function') return false;
      try {
        shortcuts.invoke('settings.open', { region: 'page', modal: null, target: null });
        return true;
      } catch {
        return false;
      }
    }

    /** How long the bar keeps looking for the settings panel after the opener ran. */
    const COMPOSER_BAR_AIM_TIMEOUT_MS = 800;

    /** The document the bar may touch: an explicit prop first, the global one second. */
    function composerBarDocumentOf(props) {
      const explicit = props === null || props === undefined ? undefined : props.document;
      if (explicit !== null && typeof explicit === 'object' && typeof explicit.querySelector === 'function') return explicit;
      const globalDocument = typeof document === 'undefined' ? undefined : document;
      return globalDocument !== null && typeof globalDocument === 'object' && typeof globalDocument.querySelector === 'function'
        ? globalDocument
        : null;
    }

    /**
     * The settings panel in one document, or `null`.
     *
     * The anchor is the Host's own semantic marker (`data-shortcut-modal="settings"`,
     * carried by the portaled dialog), never a build-time class name.
     * @param root - a document (or any query-capable root).
     * @returns the panel element, or `null`.
     */
    function composerBarSettingsPane(root) {
      if (root === null || root === undefined || typeof root !== 'object' || typeof root.querySelector !== 'function') return null;
      try {
        const pane = root.querySelector('[data-shortcut-modal="settings"]');
        return pane !== null && typeof pane === 'object' ? pane : null;
      } catch {
        return null;
      }
    }

    /**
     * The nav row whose visible text is exactly `label`, inside one settings pane.
     *
     * The panel's nav rows are button elements whose text is the section's registered
     * label — so the plugin's own `t('nav')` is the precise needle, and an exact
     * trimmed match is what keeps a sibling section from being clicked by accident.
     * @param pane - the settings panel.
     * @param label - the section label to match.
     * @returns the clickable row, or `null`.
     */
    function composerBarNavButton(pane, label) {
      if (pane === null || typeof pane !== 'object' || typeof pane.querySelectorAll !== 'function') return null;
      const wanted = typeof label === 'string' ? label.trim() : '';
      if (wanted.length === 0) return null;
      let buttons;
      try {
        buttons = pane.querySelectorAll('nav button');
      } catch {
        return null;
      }
      if (buttons === null || typeof buttons !== 'object' || typeof buttons.length !== 'number') return null;
      for (let index = 0; index < buttons.length; index += 1) {
        const button = buttons[index];
        if (button === null || typeof button !== 'object') continue;
        const text = typeof button.textContent === 'string' ? button.textContent.trim() : '';
        if (text === wanted && typeof button.click === 'function') return button;
      }
      return null;
    }

    /**
     * Click one settings section by its label, when the panel is already there.
     * @param root - the document.
     * @param label - the section label.
     * @returns `clicked` (the row was clicked), `panel` (open, no such row) or
     *   `missing` (no panel yet).
     */
    function composerBarClickSection(root, label) {
      const pane = composerBarSettingsPane(root);
      if (pane === null) return 'missing';
      const button = composerBarNavButton(pane, label);
      if (button === null) return 'panel';
      try {
        button.click();
      } catch {
        return 'panel';
      }
      return 'clicked';
    }

    /**
     * Wait — for at most {@link COMPOSER_BAR_AIM_TIMEOUT_MS} — for the panel the
     * opener just opened, then click this plugin's own nav row.
     *
     * Two properties matter:
     *   - **bounded and disposable** — one observer plus one timeout, both
     *     released by the returned stopper (which the component calls on unmount
     *     and before every new attempt). No `setTimeout` chain, no polling, and
     *     no second observer per render;
     *   - **best effort** — a panel that never appears, a row that never matches
     *     and a Host that changes its nav markup all end the same way: the panel
     *     is open (the user asked for settings and got settings), the bar keeps
     *     working, and nothing is thrown. Section selection is a bonus, not a
     *     requirement for the entry to be honest.
     *
     * The DOM hooks are injectable (`document` / `MutationObserver` / `raf` /
     * timer functions) so the whole wait is testable without a browser.
     * @param options - `document`, `label`, `timeoutMs` plus optional IO overrides.
     * @returns an idempotent stopper.
     */
    function composerBarAimAtSection(options) {
      const io = options === null || typeof options !== 'object' ? {} : options;
      const doc = io.document === undefined ? null : io.document;
      const label = io.label;
      const timeoutMs =
        typeof io.timeoutMs === 'number' && io.timeoutMs > 0 ? io.timeoutMs : COMPOSER_BAR_AIM_TIMEOUT_MS;
      const view = doc !== null && typeof doc === 'object' && doc.defaultView !== null && doc.defaultView !== undefined ? doc.defaultView : null;
      const setTimer = typeof io.setTimeout === 'function' ? io.setTimeout : typeof setTimeout === 'function' ? setTimeout : null;
      const clearTimer =
        typeof io.clearTimeout === 'function' ? io.clearTimeout : typeof clearTimeout === 'function' ? clearTimeout : null;
      const raf =
        typeof io.raf === 'function'
          ? io.raf
          : view !== null && typeof view.requestAnimationFrame === 'function'
            ? view.requestAnimationFrame.bind(view)
            : null;
      const cancelRaf =
        typeof io.cancelAnimationFrame === 'function'
          ? io.cancelAnimationFrame
          : view !== null && typeof view.cancelAnimationFrame === 'function'
            ? view.cancelAnimationFrame.bind(view)
            : null;
      const ObserverCtor =
        typeof io.MutationObserver === 'function'
          ? io.MutationObserver
          : view !== null && typeof view.MutationObserver === 'function'
            ? view.MutationObserver
            : typeof MutationObserver === 'function'
              ? MutationObserver
              : null;
      let observer = null;
      let timer = null;
      let frame = null;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (observer !== null) {
          try {
            observer.disconnect();
          } catch {
            // A disconnected observer is the goal; a throwing one is already dead.
          }
          observer = null;
        }
        if (timer !== null && clearTimer !== null) {
          try {
            clearTimer(timer);
          } catch {
            // Same as above: nothing to keep alive.
          }
          timer = null;
        }
        if (frame !== null && cancelRaf !== null) {
          try {
            cancelRaf(frame);
          } catch {
            // Same.
          }
          frame = null;
        }
      };
      const attempt = () => {
        if (stopped) return;
        if (composerBarClickSection(doc, label) === 'clicked') stop();
      };
      const schedule = () => {
        if (stopped || frame !== null) return;
        const run = () => {
          frame = null;
          attempt();
        };
        if (raf !== null) {
          try {
            frame = raf(run);
            return;
          } catch {
            frame = null;
          }
        }
        run();
      };
      if (doc === null) return stop;
      // The opener may have painted the panel synchronously (React commits before
      // the handler returns in a portal): ask once before waiting for mutations.
      attempt();
      if (stopped) return stop;
      if (ObserverCtor !== null) {
        try {
          observer = new ObserverCtor(schedule);
          const target = doc.body !== null && typeof doc.body === 'object' ? doc.body : doc;
          observer.observe(target, { childList: true, subtree: true });
        } catch {
          observer = null;
        }
      }
      if (setTimer !== null) timer = setTimer(stop, timeoutMs);
      return stop;
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
      // One pending "find the settings panel" attempt at a time: kept in a ref so
      // the component can stop it before starting another and on unmount.
      const aimRef = React.useRef(null);
      const stopAim = () => {
        const stop = aimRef.current;
        aimRef.current = null;
        if (typeof stop === 'function') {
          try {
            stop();
          } catch {
            // The stopper is best effort; a throwing one must not break unmount.
          }
        }
      };
      // Unmount cleanup. An empty dependency array means the cleanup runs once,
      // when the entry is torn down (session switch / plugin unload), which is
      // exactly when a lingering observer would otherwise scan a document the bar
      // no longer belongs to.
      React.useEffect(() => stopAim, []);

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
            stopAim();
            // g-086 R1: two seats, in order. The entry-props opener (a Host that
            // hands one over), then the Host's own `settings.open` command via the
            // shortcuts registry. Both are guarded: a throwing opener is "not
            // available", not a broken click.
            let opened = false;
            const open = composerBarSettingsOpener(props);
            if (open !== null) {
              try {
                open();
                opened = true;
              } catch {
                opened = false;
              }
            }
            if (!opened && typeof props.invokeSettingsShortcut === 'function') {
              try {
                opened = props.invokeSettingsShortcut() === true;
              } catch {
                opened = false;
              }
            }
            if (!opened) {
              // The honest degradation: the button stays visible and says why it
              // cannot do what it looks like it does — never a silent no-op.
              setHint(true);
              return;
            }
            setHint(false);
            // The panel is open; selecting *this* plugin's page is best effort
            // (bounded, disposable, anchored on semantic attributes only).
            aimRef.current = composerBarAimAtSection({ document: composerBarDocumentOf(props), label: t('nav') });
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


// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。

    /**
     * Last-resort card, rendered when building the page tree itself throws.
     * It carries the same `data-plugin` / `data-renderer` / `data-render-state`
     * markers as the real page — plus `data-build` and `data-plugin-version`,
     * both `unknown` because nothing was asked — so a broken render is still
     * machine-visible, and it shows the error text so the settings panel is
     * never blank.
     * @param t - candidate translator; may itself be what broke.
     * @param error - the thrown value.
     * @returns the failure card element.
     */
    function renderFailureCard(t, error) {
      const message = error && error.message ? String(error.message) : String(error);
      return h(
        'div',
        {
          'data-plugin': 'dsh-prompt-setting',
          'data-renderer': activeRenderer(),
          'data-render-state': 'error',
          // The failure card cannot ask the host anything (that is the point of
          // it), but it can still say which bundle it is: the self-digest needs
          // no transport and is exactly what a broken page is asked about.
          'data-build': SELF_BUILD && typeof SELF_BUILD.hash === 'string' ? SELF_BUILD.hash : 'unknown',
          // g-029: no ping can have answered here, so the version is honestly
          // `unknown`. Every root container carries the marker — a probe must
          // never have to know which render state *should* carry it.
          'data-plugin-version': 'unknown',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxWidth: 860,
            color: token.labelPrimary,
          },
        },
        h(
          'h2',
          { style: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '26px' } },
          safeT(t, 'renderErrorTitle', 'Prompt settings — render failure'),
        ),
        errorLine({
          tag: 'p',
          fontSize: 13,
          margin: 0,
          wrap: true,
          text: `${safeT(t, 'renderErrorLabel', 'Error')}: ${message}`,
        }),
      );
    }

    /**
     * The settings-nav glyph for this plugin's own section (0.2.2
     * `settings.section.icon`).
     *
     * Drawn by hand in the Shell's icon idiom rather than borrowed from the
     * primitives probe: a nav glyph must still draw when that probe fails, and
     * 16 px is the one size that matters. The glyph says what the section is —
     * a system-prompt document carrying two text rows and a caret editing the
     * third: this page reads the assembled prompt and writes the one custom
     * section.
     *
     * `currentColor` only: the shell owns the row's colour, selected state
     * included, and passes `active` for the same mild emphasis its own glyphs
     * use. `size` is the shell's requested square edge in pixels.
     * @param props - `{ size, active }` from the settings navigation row.
     * @returns the svg element.
     */
    function PromptSettingNavIcon(props) {
      const size =
        props !== null && typeof props === 'object' && Number.isFinite(props.size) && props.size > 0
          ? props.size
          : 16;
      const active = props !== null && typeof props === 'object' && props.active === true;
      return h(
        'svg',
        {
          'data-nav-icon': 'prompt-setting',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { flex: 'none', display: 'block' },
        },
        h('path', { d: 'M6 3.5h8l4 4v13H6z' }),
        h('path', { d: 'M14 3.5v4h4' }),
        h('path', { d: 'M9 11h6' }),
        h('path', { d: 'M9 14.5h6' }),
        h('path', { d: 'M9 19v-3' }),
      );
    }

    /**
     * The base class the boundary extends.
     *
     * `React.Component` on every React this page has ever seen; the fallback
     * keeps a Host with an exotic React from breaking the **whole bundle** at
     * load time (`class X extends undefined` throws before a single render).
     */
    const ReactComponentBase =
      React !== null && React !== undefined && typeof React.Component === 'function'
        ? React.Component
        : class {
            constructor(props) {
              this.props = props || {};
              this.state = {};
            }
          };

    /**
     * The boundary that keeps a Host atom's **render-time** failure from taking
     * the settings panel down (g-063, review E1).
     *
     * Activating the primitives branch made this path reachable for the first
     * time: the probe's `try/catch` only guards `require` and *building*
     * elements (`h(Button, …)` does not call the component), while React calls
     * the Host's atoms later, during render. Before g-063 the page never got
     * there, so a throwing atom could only be a theory; now it is one render
     * away, and a section that throws with no boundary around it would blank
     * the panel.
     *
     * The recovery is **"rebuild this page with the hand-built atoms"**, not
     * "show an error": `renderFallback` is called on every render once the flip
     * has happened, and the flip (`capturePrimitivesRenderFailure`) happens in
     * `getDerivedStateFromError` — i.e. **before** React re-renders the
     * boundary — so the tree that replaces the broken one can no longer contain
     * the atom that threw, in this render or any later one.
     */
    class PrimitivesErrorBoundary extends ReactComponentBase {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }
      /**
       * One-way, and deliberately side-effecting: React calls this before the
       * re-render, and the module-wide flip is what makes that re-render
       * hand-built. `componentDidCatch` repeats it idempotently for the case
       * where a Host's React calls only the commit-phase hook.
       * @param error - the thrown value.
       * @returns the next state.
       */
      static getDerivedStateFromError(error) {
        capturePrimitivesRenderFailure(error);
        return { failed: true };
      }
      /** The commit-phase half of the same record. */
      componentDidCatch(error) {
        capturePrimitivesRenderFailure(error);
      }
      /** @returns the rebuilt (hand-built) page, or the tree that is still fine. */
      render() {
        if (this.state.failed) return this.props.renderFallback();
        return this.props.children;
      }
    }

    /**
     * g-097: the read-only prompt-injection inspector — one button in
     * `conversation.input.left` (order 10, right of the meme picker's 5) and the
     * panel it opens in `conversation.input.overlay`. Read-only (the bar's same
     * three GETs); no Session ⇒ zero requests; one row per `effective.sections`
     * (index:null included, characters = text.length); three close paths that
     * return focus to the composer; no listener/style survives unmount.
     */
    const PROMPT_INSPECTOR_BUTTON_ORDER = 10;
    const PROMPT_INSPECTOR_BUTTON_SLOT = 'conversation.input.left';
    const PROMPT_INSPECTOR_PANEL_SLOT = 'conversation.input.overlay';
    const PROMPT_INSPECTOR_BUTTON_ID = 'prompt-setting-prompt-inspector';
    const PROMPT_INSPECTOR_PANEL_ID = 'prompt-setting-prompt-inspector-panel';
    const PROMPT_INSPECTOR_REGION = 'composer-prompt-inspector';
    const PROMPT_INSPECTOR_LAYERS = Object.freeze(['user', 'workspace']);
    /** Inline styles only: nothing is injected into the document, so unmount is total. */
    const PROMPT_INSPECTOR_STYLE = Object.freeze({
      line: { margin: 0, fontSize: 12, lineHeight: '18px', color: token.labelSecondary, wordBreak: 'break-word' },
      heading: { margin: 0, fontSize: 12, fontWeight: 600, color: token.labelPrimary },
      block: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      list: { display: 'flex', flexDirection: 'column', gap: 0, margin: 0, padding: 0, listStyle: 'none', border: `1px solid ${token.borderL2}`, borderRadius: 8, overflow: 'hidden' },
      row: { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 8px', borderBottom: `1px solid ${token.borderL2}` },
      rowTop: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
      rowMeta: { display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11, lineHeight: '16px', color: token.labelSecondary },
      panel: { position: 'fixed', left: 0, right: 0, bottom: 96, margin: '0 auto', zIndex: 2147483001, width: 'min(640px, calc(100vw - 32px))', maxHeight: 'min(70vh, 640px)', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', background: token.surface, color: token.labelPrimary, border: `1px solid ${token.surfaceStroke}`, borderRadius: 12, boxShadow: '0 12px 40px rgba(0, 0, 0, 0.18)', font: 'inherit', fontSize: 12, lineHeight: '18px', overflow: 'hidden' },
      scrim: { position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, zIndex: 2147483000, background: 'rgba(0, 0, 0, 0.12)' },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${token.borderL2}` },
      close: { flex: 'none', width: 24, height: 24, padding: 0, border: 'none', borderRadius: 6, background: 'transparent', color: token.labelSecondary, cursor: 'pointer', font: 'inherit', fontSize: 16, lineHeight: '24px' },
      body: { display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px 12px', overflowY: 'auto', minHeight: 0 },
      button: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, flex: 'none', padding: 0, border: 'none', borderRadius: 8, background: 'transparent', cursor: 'pointer', font: 'inherit' },
    });

    /** The one seat the two entries share. `revision` is the store snapshot. */
    const promptInspectorSeat = { open: false, sessionId: '', returnFocus: null, revision: 0, listeners: new Set() };

    /** Subscribe to the seat; the returned unsubscribe is what unmount calls. */
    function promptInspectorSubscribe(listener) {
      promptInspectorSeat.listeners.add(listener);
      return () => {
        promptInspectorSeat.listeners.delete(listener);
      };
    }

    /** Bump the revision and notify every listener; one broken subscriber must not stop the rest. */
    function promptInspectorNotify() {
      promptInspectorSeat.revision += 1;
      for (const listener of [...promptInspectorSeat.listeners]) {
        try {
          listener();
        } catch {
          // One broken subscriber must not break the others.
        }
      }
    }

    /** Open the panel for one Session, remembering where focus came from. */
    function promptInspectorOpen(options) {
      const source = options !== null && typeof options === 'object' ? options : {};
      promptInspectorSeat.open = true;
      promptInspectorSeat.sessionId = typeof source.sessionId === 'string' ? source.sessionId : '';
      promptInspectorSeat.returnFocus = source.returnFocus === undefined ? null : source.returnFocus;
      promptInspectorNotify();
    }

    /** Close the panel without touching focus (the dismiss path adds it). */
    function promptInspectorClose() {
      if (promptInspectorSeat.open === false) return;
      promptInspectorSeat.open = false;
      promptInspectorSeat.sessionId = '';
      promptInspectorNotify();
    }

    /** Return focus to the composer editor; the recorded element is the last resort. */
    function promptInspectorFocusInput(documentLike, fallback) {
      const root =
        documentLike !== null && documentLike !== undefined && typeof documentLike.querySelector === 'function'
          ? documentLike
          : null;
      if (root !== null) {
        for (const selector of [
          '[data-composer-card] [contenteditable="true"]',
          '[data-composer-card] textarea',
          '[contenteditable="true"]',
          'textarea',
        ]) {
          let element = null;
          try {
            element = root.querySelector(selector);
          } catch {
            element = null;
          }
          if (element !== null && element !== undefined && typeof element.focus === 'function') {
            try {
              element.focus();
              return true;
            } catch {
              // Next selector.
            }
          }
        }
      }
      if (fallback !== null && fallback !== undefined && typeof fallback.focus === 'function') {
        try {
          fallback.focus();
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }

    /** The one dismiss path: close, then return focus to the composer. */
    function promptInspectorDismiss(props) {
      const fallback = promptInspectorSeat.returnFocus;
      promptInspectorSeat.returnFocus = null;
      promptInspectorClose();
      return promptInspectorFocusInput(composerBarDocumentOf(props), fallback);
    }

    /** The Session seat (`InputZone.session` / the inject face); anything else is "no Session". */
    function promptInspectorSessionIdOf(props) {
      if (props === null || props === undefined) return '';
      const snapshot = props.session;
      const fromSnapshot = snapshot !== null && typeof snapshot === 'object' ? snapshot.sessionId : undefined;
      if (typeof fromSnapshot === 'string' && fromSnapshot.length > 0) return fromSnapshot;
      for (const candidate of [props.inspectorSessionId, props.sessionId]) {
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
      }
      return '';
    }

    /** Project `effective.sections` into rows: payload order, nothing filtered, `text.length`. */
    function promptInspectorSectionRows(payload) {
      const effective = payload !== null && typeof payload === 'object' ? payload.effective : null;
      const sections =
        effective !== null && typeof effective === 'object' && Array.isArray(effective.sections)
          ? effective.sections
          : [];
      return sections.map((section, position) => {
        const row = section !== null && typeof section === 'object' ? section : {};
        const text = typeof row.text === 'string' ? row.text : '';
        return {
          key: `${position}:${typeof row.name === 'string' ? row.name : ''}`,
          name: typeof row.name === 'string' ? row.name : '',
          index: Number.isInteger(row.index) ? row.index : null,
          chars: text.length,
          origin: typeof row.origin === 'string' ? row.origin : '',
          overrideLayer: typeof row.overrideLayer === 'string' ? row.overrideLayer : null,
          action: typeof row.action === 'string' ? row.action : null,
          applied: row.applied === true,
          reason: typeof row.reason === 'string' ? row.reason : '',
        };
      });
    }

    /** The two totals: section count and the sum of `text.length`. */
    function promptInspectorTotals(rows) {
      const list = Array.isArray(rows) ? rows : [];
      let chars = 0;
      for (const row of list) {
        if (row !== null && typeof row === 'object' && typeof row.chars === 'number' && Number.isFinite(row.chars)) {
          chars += row.chars;
        }
      }
      return { sections: list.length, chars };
    }

    /** The key node's two verdicts, or the state the panel must print instead. */
    function promptInspectorAssemblyFactOf(payload) {
      if (payload === null || typeof payload !== 'object') return { kind: 'error' };
      const notice = composerBarNoticeOf(payload);
      return notice === null ? { kind: 'none' } : { kind: 'notice', notice };
    }

    /** The frozen fact, straight from the snapshot's own flags. */
    function promptInspectorFrozenFactOf(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object' || snapshot.frozen !== true) return null;
      return {
        section: typeof snapshot.frozenSection === 'string' ? snapshot.frozenSection : '',
        reason: typeof snapshot.frozenReason === 'string' ? snapshot.frozenReason : '',
      };
    }

    /** Failed snapshot ⇒ `error`; failed overrides/assembly keeps the list, degrades one block. */
    function promptInspectorReadOf(results) {
      const source = results !== null && typeof results === 'object' ? results : {};
      const payloadOf = (result) =>
        result !== null && typeof result === 'object' && result.ok === true ? result.payload : null;
      const failureOf = (result) =>
        result !== null && typeof result === 'object' && result.ok !== true && result.error ? result.error : null;
      const snapshot = payloadOf(source.snapshot);
      const overrides = payloadOf(source.overrides);
      const assembly = payloadOf(source.assembly);
      const error = failureOf(source.snapshot) || failureOf(source.overrides) || failureOf(source.assembly);
      if (snapshot === null) return { phase: 'error', snapshot: null, overrides, assembly, error };
      return { phase: 'ready', snapshot, overrides, assembly, error };
    }

    /**
     * The panel's one read path: opened ⇒ three serial GETs, no Session ⇒ zero
     * transport calls, closed ⇒ `idle`. The latest round wins (stale answers are
     * dropped before they can issue the remaining requests).
     */
    function usePromptInspectorRead(options) {
      const source = options !== null && typeof options === 'object' ? options : {};
      const open = source.open === true;
      const sessionId = typeof source.sessionId === 'string' ? source.sessionId : '';
      const [read, setRead] = React.useState({
        phase: 'idle',
        snapshot: null,
        overrides: null,
        assembly: null,
        error: null,
      });
      const [nonce, setNonce] = React.useState(0);
      const bookRef = React.useRef(null);
      if (bookRef.current === null) bookRef.current = { round: 0 };
      const book = bookRef.current;
      const refresh = () => setNonce((value) => value + 1);
      React.useEffect(() => {
        const reset = (phase) => {
          book.round += 1;
          setRead({ phase, snapshot: null, overrides: null, assembly: null, error: null });
        };
        if (!open) {
          reset('idle');
          return undefined;
        }
        const urls = composerBarRequestUrls(sessionId);
        if (urls === null) {
          reset('no-session');
          return undefined;
        }
        let cancelled = false;
        book.round += 1;
        const round = book.round;
        setRead({ phase: 'loading', snapshot: null, overrides: null, assembly: null, error: null });
        const load = async () => {
          const snapshot = await requestJson(urls.snapshot);
          if (cancelled || book.round !== round) return;
          const overrides = await requestJson(urls.overrides);
          if (cancelled || book.round !== round) return;
          const assembly = await requestJson(urls.assembly);
          if (cancelled || book.round !== round) return;
          setRead(promptInspectorReadOf({ snapshot, overrides, assembly }));
        };
        load();
        return () => {
          cancelled = true;
        };
      }, [open, sessionId, nonce]);
      return { read, refresh };
    }

    /**
     * The toolbar button: one square icon in the Host's tool row. `onMouseDown`
     * is prevented so the click never steals focus from the composer; the
     * dismiss path returns focus explicitly.
     */
    function ComposerPromptInspectorButton(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      React.useSyncExternalStore(promptInspectorSubscribe, () => promptInspectorSeat.revision, () => promptInspectorSeat.revision);
      const open = promptInspectorSeat.open === true;
      const sessionId = promptInspectorSessionIdOf(props);
      const toggle = (event) => {
        if (event !== null && typeof event.preventDefault === 'function') event.preventDefault();
        if (event !== null && typeof event.stopPropagation === 'function') event.stopPropagation();
        if (open) {
          promptInspectorDismiss(props);
          return;
        }
        const doc = composerBarDocumentOf(props);
        const returnFocus = doc !== null && doc !== undefined && doc.activeElement !== undefined ? doc.activeElement : null;
        promptInspectorOpen({ sessionId, returnFocus });
      };
      return h(
        'button',
        {
          type: 'button',
          'data-plugin': 'dsh-prompt-setting',
          'data-region': 'composer-prompt-inspector-button',
          'data-action': 'prompt-inspector-toggle',
          'data-inspector-open': open ? 'true' : 'false',
          'data-inspector-session': sessionId,
          'aria-label': t('barAssemblyLabel'),
          'aria-expanded': open ? 'true' : 'false',
          'aria-haspopup': 'dialog',
          title: t('barAssemblyLabel'),
          onClick: toggle,
          onMouseDown: (event) => {
            if (event !== null && typeof event.preventDefault === 'function') event.preventDefault();
          },
          style: { ...PROMPT_INSPECTOR_STYLE.button, color: open ? token.stateBusiness : token.labelSecondary },
        },
        composerBarIconOf('sections', 'currentColor'),
      );
    }

    /**
     * The panel: scrim + dialog, four read-only blocks, three close paths. Hooks
     * run before the `open` early return; every visible fact carries a `data-*`
     * marker, so a probe reads attributes instead of text.
     */
    function ComposerPromptInspectorPanel(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      React.useSyncExternalStore(promptInspectorSubscribe, () => promptInspectorSeat.revision, () => promptInspectorSeat.revision);
      const open = promptInspectorSeat.open === true;
      const sessionId = promptInspectorSessionIdOf(props) || promptInspectorSeat.sessionId;
      const live = usePromptInspectorRead({ open, sessionId });
      const read = live.read;
      React.useEffect(() => {
        if (!open) return undefined;
        const doc = composerBarDocumentOf(props);
        if (doc === null || doc === undefined || typeof doc.addEventListener !== 'function') return undefined;
        const onKeyDown = (event) => {
          if (event !== null && event !== undefined && (event.key === 'Escape' || event.key === 'Esc')) {
            promptInspectorDismiss(props);
          }
        };
        doc.addEventListener('keydown', onKeyDown);
        return () => {
          try {
            doc.removeEventListener('keydown', onKeyDown);
          } catch {
            // A dead document is already gone; the listener dies with it.
          }
        };
      }, [open]);
      if (!open) return null;
      const dismiss = (event) => {
        if (event !== null && typeof event.preventDefault === 'function') event.preventDefault();
        if (event !== null && typeof event.stopPropagation === 'function') event.stopPropagation();
        promptInspectorDismiss(props);
      };
      const phase = read.phase;
      const rows = phase === 'ready' ? promptInspectorSectionRows(read.snapshot) : [];
      const totals = promptInspectorTotals(rows);
      const layers = phase === 'ready'
        ? {
            user: composerBarLayerFact('user', read.snapshot, read.overrides),
            workspace: composerBarLayerFact('workspace', read.snapshot, read.overrides),
          }
        : null;
      const assembly = phase === 'ready' ? promptInspectorAssemblyFactOf(read.assembly) : { kind: 'loading' };
      const frozen = phase === 'ready' ? promptInspectorFrozenFactOf(read.snapshot) : null;
      const summaryText =
        phase === 'ready'
          ? `${t('viewSections')}${t('assemblyLayerSep')}${totals.sections} · ${fmt(t('colChars'), { n: String(totals.chars) })}`
          : phase === 'no-session'
            ? t('barNoSession')
            : phase === 'error'
              ? `${t('loadFailed')}${read.error === null ? '' : ` — ${errorText(t, read.error)}`}`
              : t('loading');
      const assemblyText =
        assembly.kind === 'loading'
          ? t('loading')
          : assembly.kind === 'error'
            ? t('loadFailed')
            : assembly.kind === 'none'
              ? t('mineStatusNoRecord')
              : `${t('assemblyLayerAssembly')}${t('assemblyLayerSep')}${assemblyVerdictOf(t, assembly.notice)} · `
                + `${t('assemblyLayerDelivery')}${t('assemblyLayerSep')}${deliveryVerdictOf(t, assembly.notice)}`;
      const layerRow = (layer) => {
        const fact = layers === null ? { kind: 'loading', total: 0, ineffective: 0 } : layers[layer];
        const value =
          fact.kind === 'error'
            ? t('loadFailed')
            : fact.kind === 'disabled'
              ? t('stDisabled')
              : fact.kind === 'none'
                ? t('stNone')
                : fmt(t('mineStatusCoverage'), {
                    total: String(fact.total),
                    ineffective: String(fact.ineffective),
                  });
        return h(
          'div',
          {
            key: layer,
            'data-inspector-layer': layer,
            'data-layer-kind': fact.kind,
            'data-layer-enabled': fact.kind === 'disabled' ? 'false' : fact.kind === 'error' ? '' : 'true',
            'data-layer-total': String(fact.total),
            'data-layer-ineffective': String(fact.ineffective),
            style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, fontSize: 12, color: token.labelSecondary },
          },
          h('span', { style: { color: token.labelPrimary } }, t(layer === 'user' ? 'stUserLayer' : 'stWorkspaceLayer')),
          h('span', null, value),
        );
      };
      const sectionRow = (row) =>
        h(
          'li',
          {
            key: row.key,
            'data-section-row': '',
            'data-section-name': row.name,
            'data-section-index': row.index === null ? '' : String(row.index),
            'data-section-chars': String(row.chars),
            'data-section-origin': row.origin,
            'data-section-applied': row.applied ? 'true' : 'false',
            'data-section-override-layer': row.overrideLayer === null ? '' : row.overrideLayer,
            'data-section-action': row.action === null ? '' : row.action,
            style: PROMPT_INSPECTOR_STYLE.row,
          },
          h(
            'div',
            { style: PROMPT_INSPECTOR_STYLE.rowTop },
            h('span', { style: { fontWeight: 600, color: token.labelPrimary, wordBreak: 'break-word' } },
              `${row.index === null ? '—' : `#${row.index}`} ${row.name}`),
            h('span', { style: { flex: 'none', color: token.labelTertiary } },
              fmt(t('colChars'), { n: String(row.chars) })),
          ),
          h(
            'div',
            { style: PROMPT_INSPECTOR_STYLE.rowMeta },
            h('span', { 'data-section-meta': 'origin' }, t(originKey(row.origin))),
            row.overrideLayer === null
              ? null
              : h('span', { 'data-section-meta': 'override' }, `${row.overrideLayer} · ${row.action === null ? '—' : row.action}`),
            row.applied
              ? null
              : h('span', { 'data-section-meta': 'reason', style: { color: token.stateWarn } },
                  `${t('stDisabled')}${row.reason === '' ? '' : ` · ${fmt(t('mineLayerDisabledReason'), { reason: row.reason })}`}`),
          ),
        );
      return [
        h('div', { key: 'scrim', 'data-inspector-scrim': '', onClick: dismiss, style: PROMPT_INSPECTOR_STYLE.scrim }),
        h(
          'div',
          {
            key: 'panel',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('barAssemblyLabel'),
            'data-plugin': 'dsh-prompt-setting',
            'data-region': PROMPT_INSPECTOR_REGION,
            'data-inspector-panel': '',
            'data-inspector-phase': phase,
            'data-inspector-session': sessionId,
            'data-inspector-total-sections': phase === 'ready' ? String(totals.sections) : '',
            'data-inspector-total-chars': phase === 'ready' ? String(totals.chars) : '',
            onClick: (event) => {
              if (event !== null && typeof event.stopPropagation === 'function') event.stopPropagation();
            },
            style: PROMPT_INSPECTOR_STYLE.panel,
          },
          h(
            'div',
            { style: PROMPT_INSPECTOR_STYLE.header },
            h('h2', { style: { margin: 0, fontSize: 14, fontWeight: 600, lineHeight: '20px' } }, t('barAssemblyLabel')),
            h(
              'button',
              {
                type: 'button',
                'data-action': 'prompt-inspector-close',
                'aria-label': t('presetDialogClose'),
                title: t('presetDialogClose'),
                onClick: dismiss,
                style: PROMPT_INSPECTOR_STYLE.close,
              },
              '×',
            ),
          ),
          h(
            'div',
            { 'data-inspector-body': '', style: PROMPT_INSPECTOR_STYLE.body },
            h(
              'p',
              {
                'data-inspector-summary': '',
                'data-inspector-empty': phase === 'no-session' ? 'no-session' : undefined,
                'data-inspector-error': phase === 'error' ? 'true' : undefined,
                role: 'status',
                style: { ...PROMPT_INSPECTOR_STYLE.line, color: phase === 'error' ? token.stateError : token.labelSecondary },
              },
              summaryText,
            ),
            phase === 'ready'
              ? h(
                  'section',
                  { 'data-inspector-block': 'sections', style: PROMPT_INSPECTOR_STYLE.block },
                  h('h3', { style: PROMPT_INSPECTOR_STYLE.heading }, t('viewSections')),
                  h('ol', { style: PROMPT_INSPECTOR_STYLE.list }, rows.map(sectionRow)),
                )
              : null,
            phase === 'ready'
              ? h(
                  'section',
                  { 'data-inspector-block': 'layers', style: PROMPT_INSPECTOR_STYLE.block },
                  h('h3', { style: PROMPT_INSPECTOR_STYLE.heading }, t('stateHeading')),
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, PROMPT_INSPECTOR_LAYERS.map(layerRow)),
                )
              : null,
            phase === 'ready'
              ? h(
                  'section',
                  { 'data-inspector-block': 'assembly', 'data-inspector-assembly': assembly.kind, style: PROMPT_INSPECTOR_STYLE.block },
                  h('h3', { style: PROMPT_INSPECTOR_STYLE.heading }, t('barAssemblyLabel')),
                  h('p', { style: PROMPT_INSPECTOR_STYLE.line }, assemblyText),
                  frozen === null
                    ? null
                    : h(
                        'p',
                        { 'data-inspector-frozen': 'true', style: { ...PROMPT_INSPECTOR_STYLE.line, color: token.stateWarn } },
                        `${t('stFrozenSession')}${frozen.section === '' ? '' : ` · ${frozen.section}`}`
                          + `${frozen.reason === '' ? '' : ` · ${fmt(t('mineLayerDisabledReason'), { reason: frozen.reason })}`}`,
                      ),
                )
              : null,
          ),
        ),
      ];
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * g-039 fourth round: a read-only handle for this bundle's own unit tests.
       * A browser bundle has no exports, and the panel-height resolver deserves
       * assertions of its own (clamping, the viewport boundary, the fallback
       * path) that a rendered tree cannot express. The loader only ever reads
       * `inject` and `apply`; nothing in the page reads this.
       */
      __internals: {
        historyPanelHeight,
        workspaceRows,
        shared: CHUNK_FACILITIES,
        /**
         * g-062 (Revision 46): the toaster's IO-free half, exported for the same
         * reason as the two above — "which notices are new", "what does the
         * stored cursor say" and "what is the sentence" are policies a rendered
         * tree cannot express. Nothing in the page reads this.
         */
        assemblyNotice: {
          HAS_TOAST,
          parseToastCursor: parseAssemblyToastCursor,
          serializeToastCursor: serializeAssemblyToastCursor,
          planToasts: planAssemblyToasts,
          composeToast: composeAssemblyToastText,
          // Review C4: what really happened to the overlay registration —
          // `absent` (no Toast primitive), `pending` (slot never declared),
          // `ready` (registered) or `failed` (declared and refused).
          overlaySeat: () => overlaySeat.state,
          // g-062 fix round / g-063: the capability probe's own facts — which
          // namespace the toast decision used (`module` / `default` / `none`),
          // the branch really in use and, since g-063 E1, the render-time failure
          // record. The two always-on diagnostic rows that used to print the
          // `require` details and the `Button`/`Toast` `typeof` table were
          // removed in g-063's wrap-up, and their fields with them; a rendered
          // tree still asserts the surviving rows, and these let a unit case
          // assert the decisions behind them.
          toastNamespace: () => toastNamespaceSource,
          primitivesProbe: () => ({
            ...primitivesProbe,
            renderer: activeRenderer(),
            renderFailed: primitivesRenderFailed,
            renderFailure: primitivesRenderFailure,
          }),
        },
        /**
         * g-086: the composer assembly bar's IO-free half, exported for the same
         * reason as the blocks above — "which regions exist", "what does one
         * layer's fact say", "which URLs would be read" and "does this Host
         * expose a settings opener" are policies a rendered tree cannot express
         * without a transport. Nothing in the bar reads this.
         */
        composerBar: {
          REGION: COMPOSER_BAR_REGION,
          REGIONS: COMPOSER_BAR_REGIONS,
          HUES: COMPOSER_BAR_HUES,
          ORDER: COMPOSER_BAR_ORDER,
          hueOf: composerBarHueOf,
          toneColor: composerBarToneColor,
          sessionIdOf: composerBarSessionIdOf,
          requestUrls: composerBarRequestUrls,
          sectionCount: composerBarSectionCount,
          layerFact: composerBarLayerFact,
          noticeOf: composerBarNoticeOf,
          settingsOpener: composerBarSettingsOpener,
          // g-086 R1: the two seats behind the settings entry — the Host command
          // invoke (pure given the service) and the bounded panel/section aim.
          invokeSettingsShortcut: composerBarInvokeSettingsShortcut,
          // g-086 R2: the real opener chain — public catalog + synthetic keydown
          // first, the private registry method as the last resort.
          dispatchSettingsShortcut: composerBarDispatchSettingsShortcut,
          bindingById: composerBarBindingById,
          keyboardInit: composerBarKeyboardInit,
          globalWindow: composerBarGlobalWindow,
          documentOf: composerBarDocumentOf,
          settingsPane: composerBarSettingsPane,
          navButtonIn: composerBarNavButton,
          clickSection: composerBarClickSection,
          aimAtSection: composerBarAimAtSection,
          AIM_TIMEOUT_MS: COMPOSER_BAR_AIM_TIMEOUT_MS,
          // g-086 R3: the width→density policy (labels off below 640px).
          densityOf: composerBarDensityOf,
          COMPACT_WIDTH: COMPOSER_BAR_COMPACT_WIDTH,
          // g-086 R5: the on/off preference bus (settings page ⇄ bar).
          enabled: () => composerBarEnabled(),
          setEnabled: setComposerBarEnabled,
          subscribeEnabled: subscribeComposerBarEnabled,
          PREF_KEY: COMPOSER_BAR_PREF_KEY,
          // g-089: the live half's IO-free policy. "Should this trigger read,
          // wait, join a queued read or defer?" and "did the four facts really
          // change?" are decisions a rendered tree cannot express without a
          // clock and a transport — so they are asserted directly here, with
          // injected time, visibility and in-flight state.
          POLL_MS: COMPOSER_BAR_POLL_MS,
          MIN_GAP_MS: COMPOSER_BAR_MIN_GAP_MS,
          WRITE_GAP_MS: COMPOSER_BAR_WRITE_GAP_MS,
          LIVE_KEY: COMPOSER_BAR_LIVE_KEY,
          liveRevision: () => composerBarLiveRevision(),
          liveTopic: () => composerBarLiveBus.lastTopic,
          subscribeLive: subscribeComposerBarLive,
          notifyWrite: notifyComposerBarWrite,
          writeTopicOf: composerBarWriteTopicOf,
          writeMethodOf: composerBarWriteMethodOf,
          notifyWriteOf: notifyComposerBarWriteOf,
          probeValue: composerBarLiveProbeValue,
          writeProbe: writeComposerBarLiveProbe,
          visibleNow: composerBarVisibleNow,
          triggerGapOf: composerBarLiveTriggerGapOf,
          liveDecision: composerBarLiveDecision,
          readOf: composerBarReadOf,
          factsSignature: composerBarFactsSignature,
          nextRead: composerBarNextRead,
          // The Host's snapshot is a read-only Map from SessionId to SessionStatus.
          // The tick folds the contract's own fields (`running` /
          // `completionUnread` / `pendingInteraction`), and also accepts a
          // plain-object map (an older or double Host, and what a unit case can
          // write by hand).
          sessionStatusTick: composerBarSessionStatusTick,
          sessionStatusEntryOf: composerBarSessionStatusEntryOf,
          sessionTick: composerBarSessionTick,
          liveIoOf: composerBarLiveIoOf,
        },
        /** g-097: the inspector's IO-free half (rows / totals / seat / focus), asserted directly. */
        promptInspector: {
          REGION: PROMPT_INSPECTOR_REGION,
          BUTTON_ORDER: PROMPT_INSPECTOR_BUTTON_ORDER,
          BUTTON_SLOT: PROMPT_INSPECTOR_BUTTON_SLOT,
          PANEL_SLOT: PROMPT_INSPECTOR_PANEL_SLOT,
          BUTTON_ID: PROMPT_INSPECTOR_BUTTON_ID,
          PANEL_ID: PROMPT_INSPECTOR_PANEL_ID,
          LAYERS: PROMPT_INSPECTOR_LAYERS,
          seat: promptInspectorSeat,
          subscribe: promptInspectorSubscribe,
          open: promptInspectorOpen,
          close: promptInspectorClose,
          dismiss: promptInspectorDismiss,
          sessionIdOf: promptInspectorSessionIdOf,
          requestUrls: composerBarRequestUrls,
          sectionRows: promptInspectorSectionRows,
          totals: promptInspectorTotals,
          assemblyFactOf: promptInspectorAssemblyFactOf,
          frozenFactOf: promptInspectorFrozenFactOf,
          readOf: promptInspectorReadOf,
          focusInput: promptInspectorFocusInput,
        },
      },
      apply(ctx) {
        // Every locale call is guarded. `ctx.locale.subscribe` and
        // `getSnapshot().revision` are the one unproven part of the 0.1.7-rc.2
        // client contract (NOTES.md §7), and a throw from either would happen
        // *during render* — React would then unmount the whole settings
        // subtree and the panel would go blank. Losing live language switching
        // is an acceptable degradation; a white screen is not.
        const locale = ctx.locale;
        const t = typeof locale?.bind === 'function' ? locale.bind(NS) : (key) => key;
        fallbackT = t;
        // g-092: the dictionaries follow the Host's own language catalog (8 languages
        // in DSH 0.2.2). `LOCALE_DICTS` is emitted by `locale-pack.mjs` into the
        // `src/*-locale-*.js` segments — one entry per language, in `LOCALES` order —
        // so this block carries **no second language list**.
        //
        // Compatibility ladder (peer floor is still a zh/en-only Host):
        //   1. the baseline `{ zh, en }` object form first — that is the only shape
        //      every Host since 0.2.1 understands, and without a baseline
        //      registration there is nothing to degrade to (its throw fails apply,
        //      exactly as before g-092);
        //   2. then every other language through the single-language form
        //      `register(ns, locale, dict)`, each in its own `try` — a Host that
        //      rejects the extra languages loses those languages and nothing else.
        //      A white screen is still the one outcome this may never cause.
        ctx.effect(() => {
          if (typeof locale?.register !== 'function') return undefined;
          locale.register(NS, { zh, en });
          for (const [name, dict] of Object.entries(LOCALE_DICTS)) {
            if (name === 'zh' || name === 'en') continue;
            try {
              locale.register(NS, name, dict);
            } catch {
              // An older Host, or one that refuses this locale id: keep zh/en only.
            }
          }
          return undefined;
        }, 'prompt-setting: section dictionaries');

        const canSubscribe = typeof locale?.subscribe === 'function';
        const canReadRevision = typeof locale?.getSnapshot === 'function';

        /**
         * g-086 R1: open the Host's settings panel from this plugin.
         *
         * `shortcuts` is read optionally through `ctx.get` — deliberately **not**
         * listed in the descriptor's `inject`, because a Host without the shortcuts
         * service must still apply this plugin (the same discipline `locale`
         * follows above). Every read is guarded: a missing service, a service that
         * throws on read, and a command that refuses all answer `false`, and the
         * bar then shows its explicit fallback sentence instead of a dead button.
         * @returns `true` only when the Host's `settings.open` was really invoked.
         */
        const invokeSettingsShortcut = () => {
          try {
            const shortcuts = typeof ctx.get === 'function' ? ctx.get('shortcuts') : undefined;
            return composerBarInvokeSettingsShortcut(shortcuts);
          } catch {
            return false;
          }
        };

        /**
         * g-086 R2: the working opener chain.
         *
         * The public `Shortcuts` interface has no `invoke` (that method belongs to
         * the private `ShortcutRegistry`), so R1's probe could never succeed on a
         * real Host. This reads the public **catalog**, turns `settings.open`'s
         * binding into a real `KeyboardEvent` and dispatches it on the window —
         * the Host's own keyboard adapter then resolves the command exactly as if
         * the user pressed the shortcut. `registry.invoke` stays as the last
         * resort (callable at runtime, private in the type surface), and `none`
         * means the bar must show its explicit fallback sentence.
         * @returns `key` / `invoke` / `none`.
         */
        const openSettingsByShortcut = () => {
          try {
            const shortcuts = typeof ctx.get === 'function' ? ctx.get('shortcuts') : undefined;
            return composerBarDispatchSettingsShortcut({ shortcuts, window: composerBarGlobalWindow() });
          } catch {
            return 'none';
          }
        };

        // Built once so `React.useSyncExternalStore` sees stable identities.
        const face = {
          subscribeLocale: (listener) => {
            if (!canSubscribe) return noopSubscribe();
            try {
              const unsubscribe = locale.subscribe(listener);
              return typeof unsubscribe === 'function' ? unsubscribe : noopSubscribe();
            } catch {
              return noopSubscribe();
            }
          },
          getLocaleRevision: () => {
            if (!canReadRevision) return zeroRevision();
            try {
              return locale.getSnapshot()?.revision ?? zeroRevision();
            } catch {
              return zeroRevision();
            }
          },
        };

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'prompt-setting',
              // Existing orders: account -10, general 0, models 10, plugins 15,
              // agent-presets 20 — 30 appends without touching any of them.
              order: 30,
              label: () => t('nav'),
              locale: NS,
              inject: () => face,
            },
            PromptSettingSection,
          ),
        );

        // 0.2.2 (changelog:「插件可为自己的设置页面提供导航图标，卸载后恢复
        // 默认图标」): the optional nav glyph for this section. The shell
        // declares `settings.section.icon` as a list slot and renders a
        // contribution only for the row whose id matches its `settings.section`
        // id; with no contribution it keeps its default gear. `slots.inject`
        // runs its callback only once the slot is declared, so a Host older
        // than 0.2.2 never calls back — no registration, no throw, and its
        // gear stays exactly as before. The `try` covers the third state (a
        // Host that declares the slot and then refuses the entry): the same
        // honest degradation, never a failed apply.
        ctx.slots.inject('settings.section.icon', () => {
          try {
            return ctx.slots.register(
              { name: 'settings.section.icon', id: 'prompt-setting' },
              PromptSettingNavIcon,
            );
          } catch {
            return undefined;
          }
        });

        // g-062 (Revision 46): the proactive half. `shell.overlay` is the frame's
        // own floating layer (a **list** slot: an id is added beside the shipped
        // entries, never over them, and it stays click-through until an entry
        // opts into pointer events — which the official Toast does only for its
        // action text, so nothing here can block the app underneath).
        //
        // Two guards, both deliberate:
        //   - no `Toast` primitive ⇒ nothing is registered at all. A component
        //     that cannot draw is worse than no component: it would be a
        //     registered overlay that silently does nothing, and the settings
        //     block already states this degradation on the page;
        //   - `slots.inject` runs the callback only once the Host has declared
        //     the slot, and a Host that never declares it never calls back — so a
        //     pre-`shell.overlay` Host loses the toast, not the plugin.
        //
        // Review C4: the **seat** is what the page reports on, so the two
        // outcomes (registered / not) are told apart by a fact rather than by
        // the capability probe. `slots.inject` runs synchronously for a slot the
        // Host already declared, so the page's first render already knows.
        if (HAS_TOAST) {
          ctx.slots.inject('shell.overlay', () => {
            try {
              const disposer = ctx.slots.register(
                {
                  name: 'shell.overlay',
                  id: 'prompt-setting-toast',
                  // After the shell's own chrome, before nothing in particular:
                  // toasts only order among themselves, and 60 keeps this entry
                  // from jumping ahead of the shipped ones.
                  order: 60,
                  locale: NS,
                  inject: () => face,
                },
                AssemblyToasterRoot,
              );
              markOverlaySeat('ready');
              return disposer;
            } catch {
              // A Host that declares the slot and then refuses the registration
              // gets the same honest degradation as one that never declared it.
              markOverlaySeat('failed');
              return undefined;
            }
          });
        }

        // g-086: the resident assembly bar above the composer.
        //
        // `conversation.input.dock` is a **list** slot ("full-width entries above
        // the composer card"), so this registration is one entry appended beside
        // the shipped `todo` (0) and `queue` (20) entries — it cannot shadow the
        // composer and the composer cannot shadow it. `slots.inject` runs the
        // callback only once the Host has declared the slot, so a Host older than
        // 0.2.1-rc.3 loses the bar and nothing else: no registration, no throw,
        // no request (the component is what issues reads, and it never mounts).
        //
        // The registration is guarded for the same reason the toaster's is: a Host
        // that declares the slot and then refuses the entry is a degradation, not
        // a crash.
        ctx.slots.inject('conversation.input.dock', () => {
          try {
            return ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: 'prompt-setting-assembly-bar',
                order: COMPOSER_BAR_ORDER,
                locale: NS,
                // Session-scoped `inject` receives the scope id. The bar reads the
                // Session from the owner's `session` snapshot first and takes this
                // as the second seat — a Host shape change can lose one of them,
                // never both, and "no id at all" still means "no request".
                inject: (sessionId) => ({
                  barSessionId: typeof sessionId === 'string' ? sessionId : '',
                  // The settings opener rides the same face so the component has
                  // one capability surface, not a prop it has to be handed by a
                  // future Host slot that does not exist yet.
                  openSettingsByShortcut,
                }),
              },
              ComposerAssemblyBar,
            );
          } catch {
            return undefined;
          }
        });

        // g-097: the inspector's two entries. Both guarded like the bar: the
        // callback runs only once the Host declares the slot, and a refused entry
        // loses that entry, never the plugin. The button sits at order 10 in the
        // tool row (right of dsh-meme's order 5); the panel uses the Host's own
        // `conversation.input.overlay` list, so no slot is shared or shadowed.
        ctx.slots.inject(PROMPT_INSPECTOR_BUTTON_SLOT, () => {
          try {
            return ctx.slots.register(
              {
                name: PROMPT_INSPECTOR_BUTTON_SLOT,
                id: PROMPT_INSPECTOR_BUTTON_ID,
                order: PROMPT_INSPECTOR_BUTTON_ORDER,
                locale: NS,
                inject: (sessionId) => ({
                  inspectorSessionId: typeof sessionId === 'string' ? sessionId : '',
                }),
              },
              ComposerPromptInspectorButton,
            );
          } catch {
            return undefined;
          }
        });
        ctx.slots.inject(PROMPT_INSPECTOR_PANEL_SLOT, () => {
          try {
            return ctx.slots.register(
              {
                name: PROMPT_INSPECTOR_PANEL_SLOT,
                id: PROMPT_INSPECTOR_PANEL_ID,
                // Same order as the button: the overlay is its own list and
                // coexists with dsh-meme's `order: 5` board.
                order: PROMPT_INSPECTOR_BUTTON_ORDER,
                locale: NS,
                inject: (sessionId) => ({
                  inspectorSessionId: typeof sessionId === 'string' ? sessionId : '',
                }),
              },
              ComposerPromptInspectorPanel,
            );
          } catch {
            return undefined;
          }
        });
      },
    };
    }

    /**
     * The last resort when {@link buildPlugin} throws: say so once, then publish
     * whatever can still be published.
     *
     * Nothing here may throw — that is the whole point — so every step is
     * guarded and the return value is always a valid descriptor. When `react`
     * itself is what failed there is nothing to render a card *with*, so nothing
     * is registered at all: an empty plugin leaves the settings panel without a
     * Prompt section, and the console line is the only trace (that is the honest
     * degradation, not a blank panel).
     *
     * The card's text is intentionally not localized: the dictionaries and the
     * locale binding are part of the body that just failed to build, and a
     * diagnostic line is worth more than a translation here (NOTES.md §91).
     * @param require - the loader's require.
     * @param error - the thrown value.
     * @returns a plugin descriptor: degraded, never broken.
     */
    function degradedPlugin(require, error) {
      const cause = error && error.message ? String(error.message).split('\n')[0] : String(error);
      const line =
        '[dsh-prompt-setting] 客户端半加载失败：设置页将以降级提示卡呈现，DSH 其余功能不受影响。'
        + `首因：${cause}。排查见 README「出问题时」。`;
      try {
        if (typeof console !== 'undefined' && typeof console.error === 'function') console.error(line);
      } catch {
        // No usable console: the failure goes unrecorded, but the page boots.
      }

      let React = null;
      try {
        React = require('react');
      } catch {
        React = null;
      }
      if (React === null || typeof React !== 'object' || typeof React.createElement !== 'function') {
        // No React: registering anything would throw while the host renders it,
        // which would be worse than registering nothing at all.
        return { inject: [], apply() {} };
      }
      const h = React.createElement;

      /**
       * The degraded settings section: same machine markers as the real page, so
       * a browser-side check can still see that this plugin is the one that
       * failed — `data-build` and `data-plugin-version` included, each `unknown`.
       * @returns the failure card element.
       */
      function PromptSettingFailureSection() {
        return h(
          'div',
          {
            'data-plugin': 'dsh-prompt-setting',
            'data-renderer': 'none',
            'data-render-state': 'error',
            'data-build': 'unknown',
            // g-029: the same marker the real page and the render-failure card
            // carry, for the same reason — a probe reads one attribute, not a
            // map of which render state carries which marker.
            'data-plugin-version': 'unknown',
            style: { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 860 },
          },
          h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '26px' } },
            'Prompt settings — load failure'),
          h('p', { style: { margin: 0, fontSize: 13, wordBreak: 'break-word' } }, line),
        );
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          // Registering the card is best effort: it must not throw back into the
          // loader either.
          try {
            ctx.slots.inject('settings.section', () => ctx.slots.register({
              name: 'settings.section',
              id: 'prompt-setting',
              order: 30,
              label: () => 'Prompt settings',
              inject: () => ({}),
            }, PromptSettingFailureSection));
          } catch {
            // A host that will not take the card still boots.
          }
        },
      };
    }
    /* @build-fingerprint:end */
  },
});

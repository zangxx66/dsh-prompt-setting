              ),
            ),
        h(
          'label',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('span', { style: metaStyle }, t('mineTextLabel')),
          h(UI.Textarea, {
            'data-role': 'mine-text',
            // g-056: the box says whether it holds unsaved text (`draft`) or the
            // target's stored value (`stored`), so "my text is gone" is
            // answerable without reading any copy.
            'data-mine-text-source': textSource,
            value: m.mineText,
            onChange: a.setMineText,
            rows: 10,
            placeholder: t('minePlaceholder'),
          }),
        ),
        // g-056: the draft's own scope, read from the draft rather than from the
        // current view — so a「查看范围」change cannot make the box look like it
        // belongs to the scope it just moved to.
        draftScope === null
          ? null
          : h(
              'p',
              { 'data-mine-draft-scope': draftScopeName, style: { margin: 0, ...metaStyle } },
              fmt(t('mineDraftScope'), { scope: draftScopeName }),
            ),
        h(
          'p',
          {
            'data-mine-state': state,
            // g-021: the machine-readable half of "saved ≠ effective". The
            // effect is `none` for a certain freeze, `unknown` for the
            // §2.4/§7.2 unknown case, and `next-turn` otherwise — so the pair
            // (`saved`, `none`) is assertable offline without reading any copy.
            'data-mine-effect': !frozen ? 'next-turn' : uncertain ? 'unknown' : 'none',
            style: {
              margin: 0,
              fontSize: 12,
              color:
                state === 'error'
                  ? token.stateError
                  : state === 'saved'
                    ? frozen
                      ? token.stateWarn
                      : token.stateSuccess
                    : token.labelTertiary,
              wordBreak: 'break-word',
            },
          },
          stateText,
        ),
        // A failed write keeps the host's own words: the mapped copy names the
        // code, and the banner adds the code itself and the host message — the
        // same shape every other failed request on this page has.
        state === 'error' && m.mineError
          ? h('div', { 'data-mine-error': 'true' }, errorBanner(t, m.mineError, t('mineFailed')))
          : null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(
            UI.Button,
            {
              variant: 'primary',
              'data-action': 'mine-save',
              'data-mine-layer': layer,
              disabled: m.busy,
              onClick: a.saveMine,
            },
            state === 'saving' ? t('mineSaving') : t('mineSave'),
          ),
          // g-027: 「取消」 drops the unsaved draft and falls back to the layer's
          // *stored* text. It is the counterpart of 「恢复默认」, which is the
          // one that deletes stored text; so this one is offered exactly while
          // there is something unsaved to drop, and asks nothing first — it
          // destroys nothing that was ever stored (§13.1).
          h(
            UI.Button,
            {
              'data-action': 'mine-cancel',
              'data-mine-layer': layer,
              disabled: m.busy || state !== 'dirty',
              onClick: a.cancelMine,
            },
            t('mineCancel'),
          ),
          h(
            UI.Button,
            {
              'data-action': 'mine-reset',
              'data-mine-layer': layer,
              disabled: m.busy || !m.mineConfigured,
              onClick: a.requestMineReset,
            },
            t('mineReset'),
          ),
        ),
      );
    }

    // #region chunk boundary (g-045)
    /**
     * Every chunk of this bundle, with the digest of the bytes this file was
     * written against.
     *
     * `SELF_BUILD` cannot see a chunk: those bytes are not part of
     * `promptSettingFactory.toString()`. This manifest is the bridge. It sits
     * **inside** the fingerprint region, so it is part of the main digest — a
     * chunk added, renamed or dropped moves the main stamp — and the page
     * compares it, item by item, against the digests the host reports for the
     * chunk files it actually serves (`clientBuild.chunks`). A chunk edited
     * without this manifest moving therefore reads as `false`, never as「一致」.
     *
     * It is rewritten by `scripts/client-chunks.mjs` and asserted against the
     * real files by `test/build.test.mjs`: a manifest that lied about a chunk
     * would be exactly the silently false「一致」the stamp exists to prevent.
     */
    const CHUNK_STAMPS = Object.freeze([
      { name: 'client.advanced.js', hash: '22e9b127', size: 29441 },
      { name: 'client.history.js', hash: 'a3ec9d47', size: 50647 },
      { name: 'client.overview.js', hash: '525dad60', size: 32356 },
      { name: 'client.presets.js', hash: 'e1a665bb', size: 24079 },
      { name: 'client.transfer.js', hash: '01b94760', size: 15861 },
    ]);

    /**
     * The main factory's half of every cross-chunk facility.
     *
     * A chunk gets its own `React.createElement`, token table and helpers from
     * **this** object through `require('dsh-prompt-setting').__internals.shared`
     * — never from a copy. Two copies would be two values that can drift, and a
     * second `h` built on a second `React` would break the one-React-instance
     * rule the whole page rests on.
     */
    const CHUNK_FACILITIES = Object.freeze({
      h,
      token,
      UI,
      fmt,
      tabs,
      primitives,
      cardStyle,
      metaStyle,
      headingStyle,
      scopeSummaryStyle,
      scopeSummaryTextStyle,
      errorBanner,
      stampOf,
      layerLabel,
      historyActionLabel,
      diffBlockLabels,
      diffOpMarker,
      diffKey,
      diffTone,
      // A function, not a boolean snapshot: the chunk must ask per render, so a
      // `DiffBlock` render failure can really switch the diff back to the
      // hand-built one (g-063 E1).
      diffBlockUsable,
      DIFF_CURRENT,
      DIFF_BLOCK_MAX_LINES,
      MAX_DIFF_LINES_SHOWN,
      HISTORY_SCOPE_LIST_HEIGHT,
      HISTORY_PANEL_HEIGHT,
      HISTORY_VIEWPORT_OFFSET,
      HISTORY_PANEL_MIN_HEIGHT,
      RESERVED_SECTION_NAME,
      VIEWS,
      fingerprintOf,
      // g-046: what the tab chunks added to that surface. Same rule as above —
      // these are this factory's own instances (one pure-function set, one
      // constant table), never copies: a copy is a second value that can drift
      // away from the page the chunk renders in.
      LAYER_FILTERS,
      OVERRIDABLE_FILTERS,
      ORIGIN_FILTERS,
      MAX_VIEW_LINES,
      IMPORT_MODES,
      MAX_EXPORT_PREVIEW,
      DOWNLOAD_REGIONS,
      LAYERS,
      sectionLayer,
      originOf,
      originKey,
      originTone,
      filterLabelKey,
      layerKey,
      editGate,
      ineffectiveCause,
      splitLines,
      countMatches,
      highlightNodes,
      chunkDiff,
      diffSections,
      composeSections,
      errorText,
      regionKey,
      renderStatusDetail,
      renderUpdateApplyStatus,
      chunkTab,
      // g-061 batch 2: the four render facilities the tab chunks draw with.
      // Same rule again — one binding each, taken off the surface under its own
      // name, never copied into a chunk.
      scrimStyle,
      errorLine,
      emptyCard,
      monoTextBox,
      // g-061 batch 3: the dialog shell, its two rows, the three ghost button
      // families and the shared search comparison. Same rule once more — one
      // binding each, taken off the surface under its own name, never copied
      // into a chunk.
      dialogCardStyle,
      dialogTitleStyle,
      dialogActionsStyle,
      chipButtonStyle,
      miniButtonStyle,
      sessionRowStyle,
      normalizeNeedle,
      matchesNeedle,
      // g-065: the two-layer observation block moved from 「我的 Prompt」 to the
      // top of 「高级」. Same rule once more — the chunk takes this one binding
      // off the surface under its own name, so there is exactly one copy of the
      // block in the bundle and the two tabs can never drift apart.
      renderAssemblyStatus,
    });

    /** Chunks this page has really loaded, by file name: `{hash, size}`. */
    const loadedChunks = new Map();
    /** Subscribers waiting for a chunk to arrive (`useSyncExternalStore`). */
    const chunkLoadListeners = new Set();
    /** How many chunks have loaded — the stable snapshot that hook reads. */
    let chunkLoadCount = 0;
    /** Whether a notification is already queued for this microtask turn. */
    let chunkNotifying = false;

    /**
     * Subscribe to「a chunk has finished loading」(g-045).
     *
     * The `data-build-*` attributes live on the **root** container, and a chunk
     * finishing its load re-renders only the Suspense subtree below it — so
     * without this seat the page would keep publishing "no chunk has run" while
     * the reader is looking straight at one.
     * @param listener - React's re-render callback.
     * @returns the unsubscribe function.
     */
    function subscribeChunkLoads(listener) {
      chunkLoadListeners.add(listener);
      return () => {
        chunkLoadListeners.delete(listener);
      };
    }

    /**
     * The chunk-load snapshot: a counter, never the Map or a fresh array.
     *
     * `useSyncExternalStore` compares this value between renders, so it has to be
     * stable unless the store really changed (a new array each pass would
     * re-render forever).
     * @returns the number of chunks loaded so far.
     */
    function chunkLoadRevision() {
      return chunkLoadCount;
    }

    /**
     * Tell the page a chunk has arrived — **not** from inside the render phase.
     *
     * `recordLoadedChunk` runs in `React.lazy`'s resolve callback, i.e. while
     * React is rendering; calling a subscriber right there would be an update
     * during render. The notification is queued to a microtask instead (with a
     * synchronous fallback for an engine without one), which lands after React
     * has finished the pass that resolved the chunk.
     */
    function notifyChunkLoad() {
      if (chunkNotifying) return;
      chunkNotifying = true;
      const flush = () => {
        chunkNotifying = false;
        for (const listener of [...chunkLoadListeners]) {
          try {
            listener();
          } catch {
            // One broken subscriber must not stop the others: the stamp is
            // diagnostics, and losing it may never take the page down.
          }
        }
      };
      if (typeof queueMicrotask === 'function') queueMicrotask(flush);
      // Deliberately **not** a synchronous fallback: `recordLoadedChunk` runs
      // inside `React.lazy`'s resolve callback, i.e. while React is rendering,
      // and flushing right here would make this an update during render — the
      // exact thing the deferral exists to avoid. `setTimeout` keeps the "after
      // this pass" ordering; an engine with neither cannot render this page.
      else setTimeout(flush, 0);
    }

    /**
     * Ask the module loader for one chunk of this bundle.
     *
     * `require.async` with a `./`-prefixed spec is the loader's one relative
     * form (`@deepseek-ai/dsh-client-modules` `importChunk`): the spec must match
     * `client.*.js` and the file must sit next to `client.js`. The direction is
     * main → chunk only; a chunk reaches back through
     * `require('dsh-prompt-setting')`, and since the main factory is already
     * materialized by then the pair cannot form a cycle.
     * @param fileName - the chunk's file name (`client.history.js`).
     * @returns whatever the loader answered (a thenable), or `null`.
     */
    function loadChunk(fileName) {
      if (typeof require.async !== 'function') return null;
      return require.async(`./${fileName}`);
    }

    /**
     * Remember a loaded chunk's own digest, so the page can verify the bytes it
     * is really running and not just the manifest written into this file.
     * @param fileName - the chunk's file name.
     * @param chunkExports - the chunk factory's exports.
     */
    function recordLoadedChunk(fileName, chunkExports) {
      const build = chunkExports && typeof chunkExports === 'object' ? chunkExports.build : null;
      if (build !== null && typeof build === 'object' && typeof build.hash === 'string' && build.hash.length > 0) {
        loadedChunks.set(fileName, {
          hash: build.hash,
          size: typeof build.size === 'number' ? build.size : null,
        });
        chunkLoadCount += 1;
        notifyChunkLoad();
      }
    }

    /** Every chunk digest this page has verified so far. */
    function loadedChunkStamps() {
      const out = [];
      for (const [name, build] of loadedChunks) out.push({ name, hash: build.hash, size: build.size });
      return out;
    }

    /**
     * The readable card a chunk that could not be loaded renders **instead of**
     * blanking the tab.
     *
     * `React.lazy` re-throws a rejected load while rendering, which would take
     * the whole settings subtree down with it. A chunk can genuinely fail to
     * arrive (an entry missing from `files`, a 404, an offline host), so the
     * failure is converted into content rather than an exception — the same
     * trade the primitives probe makes when it degrades to the hand-built
     * renderer. The copy is deliberately mechanical: a file name and the
     * reason, no new dictionary key to keep in sync.
     * @param fileName - the chunk that failed.
     * @param error - whatever was thrown, or `null`.
     * @returns a component.
     */
    function chunkFailureComponent(fileName, error) {
      const reason =
        error && error.message ? String(error.message) : error === null || error === undefined ? '' : String(error);
      return function ChunkFailure(props) {
        const t = props && typeof props.t === 'function' ? props.t : fallbackT || ((key) => key);
        return h(
          'div',
          {
            'data-region': 'chunk-failure',
            'data-chunk': fileName,
            'data-chunk-state': 'error',
            style: { ...cardStyle, display: 'flex', flexDirection: 'column', gap: 6 },
          },
          h('strong', { style: { fontSize: 14, fontWeight: 600 } }, `${safeT(t, 'renderErrorLabel', 'Error')}: ${fileName}`),
          h(
            'span',
            { style: { fontSize: 12, color: token.stateError, wordBreak: 'break-word' } },
            reason.length === 0 ? fileName : reason,
          ),
        );
      };
    }

    /**
     * Pick one exported component out of a chunk's exports, or explain why it
     * could not be picked.
     * @param fileName - the chunk's file name.
     * @param chunkExports - the chunk factory's exports.
     * @param pick - selects the component.
     * @returns a component (never a throw).
     */
    function pickChunkComponent(fileName, chunkExports, pick) {
      try {
        const component = pick(chunkExports);
        // A function by construction: this is one of **our own** chunks, whose
        // tab component is the named function `chunkTab()` builds
        // (`client.history.js` exports `HistoryTab`, its `name` preserved) — not
        // a Host atom. The `forwardRef`-aware judge is for the Host's exports
        // only (g-063).
        if (typeof component === 'function') {
          recordLoadedChunk(fileName, chunkExports);
          return component;
        }
      } catch (error) {
        return chunkFailureComponent(fileName, error);
      }
      return chunkFailureComponent(fileName, null);
    }

    /**
     * The `{default}` module object `React.lazy` expects for one chunk — with
     * every failure already turned into a readable component.
     *
     * The wrapper exists because `React.lazy`'s `load()` may only fail or
     * resolve; there is no third arm for "say so on screen". Doing it here keeps
     * the lazy call itself one line per chunk.
     * @param fileName - the chunk's file name.
     * @param pick - selects the component out of the chunk's exports.
     * @returns a thenable resolving to `{default: Component}`.
     */
    function chunkModule(fileName, pick) {
      let source = null;
      let failure = null;
      try {
        source = loadChunk(fileName);
      } catch (error) {
        failure = error;
      }
      if (source === null || typeof source.then !== 'function') {
        return { then: (onLoaded) => onLoaded({ default: chunkFailureComponent(fileName, failure) }) };
      }
      return {
        then: (onLoaded) =>
          source.then(
            (chunkExports) => onLoaded({ default: pickChunkComponent(fileName, chunkExports, pick) }),
            (error) => onLoaded({ default: chunkFailureComponent(fileName, error) }),
          ),
      };
    }

    /**
     * Whether this React instance can host the lazy chunk boundary at all.
     *
     * `React.lazy` needs `React.Suspense` beside it (both since 16.6), and the
     * page must not *require* either to stay alive: a React without them would
     * otherwise turn one tab's laziness into the whole panel's failure — the
     * same reasoning that makes the primitives probe a probe. When they are
     * missing the tab renders its own readable card instead of throwing.
     */
    const HAS_REACT_LAZY = typeof React.lazy === 'function' && React.Suspense !== undefined;

    /**
     * 「版本历史」 as a lazily loaded chunk.
     *
     * The tab's renderer lives in `client.history.js`, next to this file, and is
     * fetched the first time the tab is rendered — a page that never opens it
     * pays nothing for it. Nothing about the tab's tree changes: the chunk calls
     * the very same `renderHistoryTab(t, m, a)` this file used to call.
     */
    const HistoryTabChunk = HAS_REACT_LAZY
      ? React.lazy(() => chunkModule('client.history.js', (chunkExports) => chunkExports && chunkExports.HistoryTab))
      : null;

    /**
     * Mount the lazy chunk behind a `Suspense` boundary.
     *
     * The fallback is a sized, marked placeholder rather than the tab's own
     * frame: an empty panel would be indistinguishable from "no history
     * recorded", and the reader would be told something false for as long as the
     * fetch takes.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the boundary element.
     */
    function renderHistoryChunk(t, m, a) {
      if (HistoryTabChunk === null) {
        const Unsupported = chunkFailureComponent('client.history.js', null);
        return h(Unsupported, { t });
      }
      return h(
        React.Suspense,
        {
          key: 'history',
          fallback: h('div', {
            'data-region': 'history-chunk-loading',
            style: { minHeight: HISTORY_PANEL_MIN_HEIGHT },
          }),
        },
        h(HistoryTabChunk, { t, m, a }),
      );
    }

    /**
     * 「提示词总览」 / 「备份与恢复」 / 「高级」 as lazily loaded chunks (g-046).
     *
     * Same shape as {@link HistoryTabChunk}: each tab's renderer lives in its
     * own flat sibling of this file and is fetched the first time that tab is
     * rendered, so a page that opens one tab pays nothing for the other two.
     *
     * The **default** tab (「我的 Prompt」) is deliberately *not* a chunk, and
     * that is a design decision rather than an omission: it is the tab the
     * settings page opens on, so it is built on the very first render — a chunk
     * there would turn first-screen code into a second round trip, and a failed
     * fetch into a blank default tab. The other three are only ever reached by a
     * click, which is exactly the case a lazy boundary is for.
     */
    const OverviewTabChunk = HAS_REACT_LAZY
      ? React.lazy(() => chunkModule('client.overview.js', (chunkExports) => chunkExports && chunkExports.OverviewTab))
      : null;
    const TransferTabChunk = HAS_REACT_LAZY
      ? React.lazy(() => chunkModule('client.transfer.js', (chunkExports) => chunkExports && chunkExports.TransferTab))
      : null;
    const AdvancedTabChunk = HAS_REACT_LAZY
      ? React.lazy(() => chunkModule('client.advanced.js', (chunkExports) => chunkExports && chunkExports.AdvancedTab))
      : null;
    /**
     * g-060: 「预设」 as a lazily loaded chunk.
     *
     * Same shape as its three siblings, and for the same reason: the catalogue
     * is only ever reached by a click, so a page that never opens it pays
     * nothing for it.
     */
    const PresetsTabChunk = HAS_REACT_LAZY
      ? React.lazy(() => chunkModule('client.presets.js', (chunkExports) => chunkExports && chunkExports.PresetsTab))
      : null;

    /**
     * g-061: the props adapter every lazy tab chunk used to write for itself.
     *
     * `renderChunkTab` below mounts a chunk's default export as
     * `h(Component, { t, m, a })`, and each chunk's export unpacks that one
     * object back into the three positional arguments its own renderer takes.
     * Five chunks wrote that same one-liner under five function names — the
     * unpacking is a shape, not a per-tab decision, so it lives here once and
     * each chunk keeps its own export name.
     *
     * This is **not** `renderChunkTab`: that one builds the `Suspense` boundary
     * and the「chunk unavailable」card and takes the lazy *component*; this one
     * builds the component the boundary finally mounts. Both halves are needed;
     * only this half was duplicated five times.
     * @param render - the chunk's own `(t, m, a)` renderer.
     * @param name - the export's name, so the component reports what it always did.
     * @returns a React function component.
     */
    function chunkTab(render, name) {
      const Tab = function tabComponent(props) {
        return render(props.t, props.m, props.a);
      };
      // The five local declarations were named functions (`function HistoryTab`),
      // so the mounted component's `name` is part of what the page always said
      // about itself; a factory-made component keeps that name.
      Object.defineProperty(Tab, 'name', { value: name, configurable: true });
      return Tab;
    }

    /**
     * Mount one tab chunk behind a `Suspense` boundary.
     *
     * The fallback is a sized, marked placeholder rather than the tab's own
     * frame: an empty panel would be indistinguishable from "this tab has
     * nothing to show", and the reader would be told something false for as
     * long as the fetch takes. A chunk that cannot be loaded at all renders the
     * same readable card every other chunk failure renders, so one tab's 404
     * never takes the page (or its other tabs) down with it.
     * @param Component - the lazy component, or `null` without `React.lazy`.
     * @param fileName - the chunk's file name.
     * @param region - the tab's own region name (`overview`), which names the
     *   placeholder's marker as `${region}-chunk-loading`.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the boundary element.
     */
    function renderChunkTab(Component, fileName, region, t, m, a) {
      if (Component === null) {
        const Unsupported = chunkFailureComponent(fileName, null);
        return h(Unsupported, { t });
      }
      return h(
        React.Suspense,
        {
          key: region,
          fallback: h('div', {
            'data-region': `${region}-chunk-loading`,
            style: { minHeight: HISTORY_PANEL_MIN_HEIGHT },
          }),
        },
        h(Component, { t, m, a }),
      );
    }

    /**
     * The three lazy tab boundaries, one thin wrapper each.
     *
     * They stay here rather than in `renderSection`'s dispatch so the whole
     * chunk surface (which file, which export, which placeholder) is readable
     * in one place — and so the dispatch itself keeps the shape it always had.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the tab element.
     */
    function renderOverviewChunk(t, m, a) {
      return renderChunkTab(OverviewTabChunk, 'client.overview.js', 'overview', t, m, a);
    }
    function renderBackupChunk(t, m, a) {
      return renderChunkTab(TransferTabChunk, 'client.transfer.js', 'backup', t, m, a);
    }
    function renderAdvancedChunk(t, m, a) {
      return renderChunkTab(AdvancedTabChunk, 'client.advanced.js', 'advanced', t, m, a);
    }
    /** g-060:「预设」 — the fourth lazy tab boundary. */
    function renderPresetsChunk(t, m, a) {
      return renderChunkTab(PresetsTabChunk, 'client.presets.js', 'presets', t, m, a);
    }
    // #endregion

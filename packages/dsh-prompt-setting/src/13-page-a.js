// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。

    /**
     * The settings section page.
     *
     * Hooks run before the `try`: their call order must be identical on every
     * render, including the render that catches. The returned tree is built
     * inside the `try` so that no failure below can escape into React's
     * reconciler and blank the panel — a readable failure card is always
     * preferable to a white screen.
     * @param props - owner props (`close`, `useSessions`, …) merged with the
     *   `locale` seat (`t`) and this entry's inject face (`subscribeLocale`,
     *   `getLocaleRevision`).
     * @returns the rendered page; never throws.
     */
    function PromptSettingSection(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const subscribe = typeof props.subscribeLocale === 'function' ? props.subscribeLocale : noopSubscribe;
      const revision =
        typeof props.getLocaleRevision === 'function' ? props.getLocaleRevision : zeroRevision;
      // Re-render this page on its own when the DSH language changes, instead
      // of relying on the shell to re-render us. Both seats are already
      // exception-free by construction (see `apply`), so this hook cannot be
      // the call that throws.
      React.useSyncExternalStore(subscribe, revision, revision);
      // g-045: the chunk half of the build stamp, on the same seat. A chunk that
      // finishes loading writes `loadedChunks` during React's own render pass
      // (that is when `React.lazy` resolves), which re-renders the Suspense
      // subtree — and **not** this root, where `data-build-loaded` and the
      // verdict live. Without this subscription the page would report "no chunk
      // has run" until some unrelated state change happened to re-render it, and
      // the third check — the one that compares the chunk bytes this browser is
      // really running against the ones the host serves — would never run when
      // it matters.
      React.useSyncExternalStore(subscribeChunkLoads, chunkLoadRevision, chunkLoadRevision);
      // g-062 (Revision 46, review C4): the overlay seat, on the same seat. A
      // Host that declares `shell.overlay` after this page first rendered would
      // otherwise leave the degradation note on screen until some unrelated
      // state change happened to re-render the block.
      React.useSyncExternalStore(subscribeOverlaySeat, overlaySeatRevision, overlaySeatRevision);

      // The session seat: a root-level hook on props, no inject required. The
      // `typeof` branch is stable for the life of a mount, and a hook that
      // throws degrades to the manual picker instead of blanking the panel.
      const seat = readSessionSeat(props.useSessions);
      // The workspace seat, from the *other* root hook
      // (`dsh-client-ui-workspace` provides `useWorkspaces`). Absent or
      // throwing ⇒ the flat list, announced on the page.
      const wsSeat = readWorkspaceSeat(props.useWorkspaces);

      const [selection, setSelection] = React.useState(null);
      const [manualId, setManualId] = React.useState('');
      const [sessionQuery, setSessionQuery] = React.useState('');
      const [sessionActive, setSessionActive] = React.useState(-1);
      const [scopeExpanded, setScopeExpanded] = React.useState({});
      // g-016: the「查看范围」block ships collapsed. `false` keeps the tab bar
      // and the tab panel on the first screen;「更改」opens the picker, and
      // picking a scope closes it again (see the actions below).
      const [scopeOpen, setScopeOpen] = React.useState(false);
      const [scopeLimits, setScopeLimits] = React.useState({});
      // Only one row can be hovered or focused at a time, so one slot each is
      // enough — and it keeps the interaction state out of a per-row component
      // (which would nest hooks under this page's render).
      const [scopeHover, setScopeHover] = React.useState('');
      const [scopeFocus, setScopeFocus] = React.useState('');
      // The first-level tab. 「我的 Prompt」 is first *and default*: it is the
      // only surface that writes, so it is where the page opens (g-015).
      const [tab, setTab] = React.useState('mine');
      // The read-only inner view of 「提示词总览」, unchanged from Revision 6.
      const [view, setView] = React.useState('sections');
      const [search, setSearch] = React.useState('');
      const [filters, setFilters] = React.useState({ layer: 'all', overridable: 'all', origin: 'all' });
      const [fullOrigin, setFullOrigin] = React.useState('all');
      const [expanded, setExpanded] = React.useState('');
      const [snap, setSnap] = React.useState({ phase: 'loading', data: null, error: null });
      const [ovs, setOvs] = React.useState({ phase: 'loading', data: null, error: null });
      const [reload, setReload] = React.useState(0);
      // 「我的 Prompt」: the selected layer, the user's unsaved drafts, and the
      // last operation's outcome.
      //
      // g-056: the drafts are a small map **keyed by write target**
      // (`mineDraftKeyOf` — `user`, or `workspace:` + the workspace root), not
      // one slot keyed by layer+session. One slot is what made a「查看范围」change
      // miss the key and silently drop the text, and it also meant typing in a
      // second scope destroyed the first scope's text (review R2). A target with
      // no entry shows what is stored, which keeps a fresh load, a layer switch
      // and a post-save reload correct without clobbering typing.
      const [mineLayer, setMineLayer] = React.useState('user');
      const [mineDrafts, setMineDrafts] = React.useState({});
      const [mineStatus, setMineStatus] = React.useState({ kind: 'idle', error: null });
      // Revision 9: the switch's own request state. Kept apart from
      // `mineStatus` because the switch is a config-level fact with its own
      // failure mode (a refusal names the text the write face will not accept),
      // and folding the two would let a failed toggle look like a failed save.
      const [mineInterpolate, setMineInterpolate] = React.useState({ kind: 'idle', error: null });
      // Revision 12 (audit F2): the advisories the host returns with a write or
      // an arming. They are *not* failures — the save happened — so they live in
      // their own slot and the panel renders them beside the state they qualify,
      // instead of inside an error banner that would deny the write.
      const [mineWarnings, setMineWarnings] = React.useState([]);
      /**
       * g-062:「装配状态提示」— the observation this page renders, its switch's
       * state, and the last switch attempt.
       *
       * `data` is the Host's answer verbatim (`record` is `null` until it has
       * observed an assembly for the selected session), `enabled` is the switch
       * as the **Host** reports it (`null` until it answered — the page never
       * guesses), and `status` is the switch's own request state, kept separate
       * from the read's, so a failed toggle cannot read as a failed read.
       */
      const [assembly, setAssembly] = React.useState({
        phase: 'idle',
        data: null,
        error: null,
        enabled: null,
        status: { kind: 'idle', error: null },
      });
      const [notice, setNotice] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      // g-060 (Revision 37; dialog-based since Revision 38 / review R3): the
      // preset library tab's own state.
      //
      // Four slots, and the split is the same one 「我的 Prompt」 uses: the
      // **library read** (`presets`) is a fact about one host file, the
      // **draft** (`presetDraft`) is what the editor dialog shows and what the
      // catalogue writes send, the **request state** (`presetStatus`) is what
      // the last write answered, and the **open dialog** (`presetDialog`) is
      // which of the two overlays is on screen (`edit` or `apply`). A failed
      // write must never look like a failed read, so the last three are not
      // folded into the first.
      const [presets, setPresets] = React.useState({ phase: 'idle', data: null, error: null });
      const [presetDraft, setPresetDraft] = React.useState({ id: null, name: '', action: 'replace', text: '' });
      const [presetStatus, setPresetStatus] = React.useState({ kind: 'idle', error: null });
      // `null` | `{kind: 'edit'}` | `{kind: 'apply', presetId}`. The editor is a
      // dialog rather than an in-tab form (review R3): the tab is the catalogue,
      // and both writes it can start happen in an overlay that a reader has to
      // dismiss.
      const [presetDialog, setPresetDialog] = React.useState(null);
      // Stage 2 state: history, the comparison, the pending confirmation and
      // the export/import surface. All of it is view state — nothing here is
      // derived from a real config file until a route answers.
      const [hist, setHist] = React.useState({ phase: 'idle', data: null, error: null });
      const [historyLayer, setHistoryLayer] = React.useState('user');
      // g-038: the version history's **own** scope, deliberately not the page's
      // 「查看范围」. `null` means「跟随当前会话」(the current workspace); a string
      // is the session id the reader picked in the history scope selector. The
      // page-level scope may change all it likes — this list does not follow it.
      const [historyScope, setHistoryScope] = React.useState(null);
      // g-038 (second round): the scope selector is a disclosure — one summary
      // row, and a picker (search box + fixed-height candidate list) rendered
      // only while it is open. Collapsed is the default, so the panel's height
      // never depends on how many workspaces exist.
      const [historyScopeOpen, setHistoryScopeOpen] = React.useState(false);
      const [historyScopeSearch, setHistoryScopeSearch] = React.useState('');
      // g-038: the offset of the history page on screen. The page **size** is the
      // host's (`pageLimit` in its response) and is never hardcoded here.
      const [historyOffset, setHistoryOffset] = React.useState(0);
      // g-039: which record a preview would show, by its history id (`null` =
      // nothing). Like `diffSel`, it points **into one file**, so
      // `resetHistoryView` clears it; paging deliberately does not (CONTRACT
      // §13.3), and a page that does not hold it renders the `missing` state.
      const [previewId, setPreviewId] = React.useState(null);
      // g-039 (fifth round): the record list owns the whole panel now, so the
      // preview and the comparison live in **modals** — viewport overlays with an
      // explicit close — instead of in a second column that squeezed the list.
      // One state holds both, because they are mutually exclusive by
      // construction: `null` | `'preview'` | `'diff'`.
      const [historyModal, setHistoryModal] = React.useState(null);
      // Esc closes whichever modal is open — the keyboard half of the explicit
      // close entry point (the button is the other half).
      React.useEffect(() => {
        if (historyModal === null) return undefined;
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        const onKeyDown = (event) => {
          const key = event === null || event === undefined ? '' : String(event.key === undefined ? '' : event.key);
          if (key === 'Escape' || key === 'Esc') setHistoryModal(null);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [historyModal]);
      // g-039 (fourth round): the panel's height is **measured**, not guessed —
      // one ref on the panel, one number in state, and `null` meaning "use the
      // constant path" (`HISTORY_PANEL_HEIGHT`). The measurement is reported on
      // the panel as `data-history-height-source`, so a real page answers "which
      // path am I on" without a debugger.
      const historyPanelRef = React.useRef(null);
      /**
       * The `body.style.overflow` this page had before a modal locked it, so the
       * lock is undone with the **exact** previous value rather than with `''`.
       */
      const pageOverflowRef = React.useRef(null);
      // While a modal is open the page behind it must not scroll: it is a
      // viewport overlay, and a scrolling background is what makes a modal feel
      // broken. The effect runs for both directions (lock on open, restore on
      // close) rather than relying on the cleanup alone, and `restore` is also
      // returned as the cleanup so an unmount while a modal is open cannot leave
      // the page locked.
      React.useEffect(() => {
        if (typeof document === 'undefined' || document === null) return undefined;
        const body = document.body;
        if (body === undefined || body === null || body.style === undefined) return undefined;
        const restore = () => {
          const previous = pageOverflowRef.current;
          pageOverflowRef.current = null;
          if (previous !== null) body.style.overflow = previous;
        };
        if (historyModal === null) {
          restore();
          return restore;
        }
        if (pageOverflowRef.current === null) pageOverflowRef.current = body.style.overflow;
        body.style.overflow = 'hidden';
        return restore;
      }, [historyModal]);
      const [historyPanelPx, setHistoryPanelPx] = React.useState(null);
      // g-073 (Revision 55):「提示词总览」's **own** scope, deliberately not the
      // page's「查看范围」. `null` means「跟随当前会话」; a string is the session id
      // the reader picked in the overview scope selector. The shape is *by
      // workspace group, down to one session*, not one option per workspace: the
      // host's `/snapshot` reads `session` twice — it resolves the workspace layer
      // file *and* probes the assembly in that session's own scope — and the
      // frozen verdict and variable resolution are per-scope facts (§2.4), so a
      // "first session of the workspace" stand-in would show a verdict that is
      // not the reader's session's.
      const [overviewScope, setOverviewScope] = React.useState(null);
      const [overviewScopeOpen, setOverviewScopeOpen] = React.useState(false);
      const [overviewScopeSearch, setOverviewScopeSearch] = React.useState('');
      // The overview's own read of `/snapshot`. It is taken **only** while that
      // tab is open (one request per tab open / scope change / reload), because
      // every `/snapshot` answer costs two `assemble()` runs on the host (§2.6).
      const [overviewSnap, setOverviewSnap] = React.useState({ phase: 'loading', data: null, error: null });
      // g-073 (Revision 55):「高级」's **own** workspace selector. Layer-wide
      // operations (`reset=true` / `legacy=true`) clear a whole workspace file —
      // every session in it shares that file — so the thing to choose here is a
      // **workspace**, not a session, and it is no longer inherited from the
      // page's「查看范围」. `null` means「跟随当前会话」.
      const [advancedScope, setAdvancedScope] = React.useState(null);
      const [advancedScopeOpen, setAdvancedScopeOpen] = React.useState(false);
      const [advancedScopeSearch, setAdvancedScopeSearch] = React.useState('');
      // The advanced tab's own override read: the legacy list and the two
      // layer-wide counts describe the layer the selector names, so they may not
      // be taken from a page-scoped response. Its snapshot read is the other half
      // of the same question — `applied` is a fact about the assembly in **this**
      // scope, so a row cannot be judged against another workspace's assembly.
      const [advancedOvs, setAdvancedOvs] = React.useState({ phase: 'idle', data: null, error: null });
      const [advancedSnap, setAdvancedSnap] = React.useState({ phase: 'loading', data: null, error: null });
      // 「高级」 picks its own layer: the two layer-wide buttons are destructive,
      // and silently sharing another tab's selector would make selecting a log
      // filter change what a clear button is aimed at.
      const [advancedLayer, setAdvancedLayer] = React.useState('user');
      const [diffSel, setDiffSel] = React.useState({ from: null, to: DIFF_CURRENT });
      const [diff, setDiff] = React.useState({ phase: 'idle', data: null, error: null });
      const [confirm, setConfirm] = React.useState(null);
      /**
       * g-043:「自定义镜像源」dialog: `null` when closed, otherwise
       * `{value, error, phase}`. Its own state rather than a `confirm` kind
       * because the error has to survive the dialog staying open — a confirm
       * carries a body, not a form.
       */
      const [regionDialog, setRegionDialog] = React.useState(null);
      const [transfer, setTransfer] = React.useState({ phase: 'idle', plan: null, error: null, exportText: '', fileName: '' });
      const [importText, setImportText] = React.useState('');
      const [importMode, setImportMode] = React.useState('merge');
      // The build stamp's transport half: what this tab runs (`self`, computed
      // once at module scope) and what the host said it serves. Starts as
      //「未知」and stays that way unless the host really answered a hash — a
      // missing/failed ping must never be rendered as「过期」.
      // `version` and `repositoryUrl` ride on the *same* ping (g-029): one
      // request answers both questions, so the page can never show a build from
      // one host boot and a version (or a link) from another.
      const [boot, setBoot] = React.useState({
        self: SELF_BUILD,
        server: null,
        version: null,
        repositoryUrl: null,
        // g-036: which shape the host was started in, verbatim from the ping.
        // `null` until the host answers — and `null` forever on an old host that
        // never sends it — which selects the shape-neutral copy.
        launchKind: null,
        pingFailed: false,
      });
      // g-030: the update check's own view state. `enabled` is the **Host's**
      // answer (`null` until it answered — the mirror alone is never treated as
      // the truth), `data` is the payload of a confirmed newer release or
      // `null`, `check` is the last **successful** payload whatever it decided
      // (so "upstream has no usable information" and "the check failed" can read
      // differently, §17.2), and `dismissed` is this session's "stop showing it".
      const [update, setUpdate] = React.useState({
        enabled: null,
        data: null,
        check: null,
        dismissed: false,
        phase: 'idle',
        /**
         * g-032: the running (or last) install, exactly as the **Host** reports
         * it. `null` until this page starts one, and then never guessed at: the
         * phase, the version, the application verdict and the structured error
         * all come from `GET /update-apply`, because the official manager
         * deletes its own record when an install settles.
         */
        apply: null,
        /** Milliseconds since that install started, for the「已用时」line. */
        applyElapsed: null,
        /** The wall-clock start, which drives the elapsed ticker. */
        applyStartedAt: null,
        /**
         * g-043:「下载区域」, exactly as the **Host** reports it:
         * `{phase, region, registry, custom, detected, stored, error}`, or `null`
         * until the Host has answered. The three things that matter here are
         * `region` (what the dropdown shows — never the option the user just
         * clicked), `detected` (the Host chose it by availability, so the page
         * says so) and `error` (a saved custom address the Host cannot use).
         * `null` is not「默认」: it is「this page has not been told yet」, and the
         * card renders it as the shipped default while saying nothing about
         * where it came from.
         */
        region: null,
      });

      const session = selection === null ? seat.currentId || GLOBAL_SESSION : selection;
      const sessionArg = session === GLOBAL_SESSION ? null : session;
      // Tree when both root hooks answered, flat when only the session hook did,
      // manual when even that is missing. `scope` is null in the two degraded
      // modes, where the flat list keeps its own (bounded) projection.
      const scopeMode = seat.mode === 'manual' ? 'manual' : wsSeat.mode === 'workspaces' ? 'tree' : 'flat';
      const scope =
        scopeMode === 'tree'
          ? deriveScope({
              rows: seat.rows,
              currentId: seat.currentId,
              workspaces: wsSeat.items,
              pinned: wsSeat.pinned,
              archived: wsSeat.archived,
              query: sessionQuery,
              expanded: scopeExpanded,
              limits: scopeLimits,
              labels: {
                defaultName: t('scopeDefaultWorkspace'),
                untitled: t('scopeUntitledWorkspace'),
                ungrouped: t('scopeUngrouped'),
              },
            })
          : null;
      // Every match is computed; only a bounded window is ever rendered.
      const sessionMatches = scope === null ? filterSessions(seat.rows, sessionQuery) : [];
      const sessionVisible =
        scope === null ? sessionMatches.slice(0, SESSION_MATCH_LIMIT) : scope.rows;

      // ---- g-038: the version history's own scope (never the page's) ----
      // `historyScope` is the reader's pick or `null` for「跟随当前会话」. The
      // effective value is a session id: for the workspace layer it is the
      // session that **locates** the log (and only that — the host returns the
      // workspace's whole log), and the user layer ignores it entirely.
      const historyScopes = historyScopeOptionsOf(wsSeat, seat);
      const historyScopeAuto = (() => {
        const owner = historyScopes.options.find((option) => option.sessionIds.includes(seat.currentId));
        if (owner !== undefined) return owner.value;
        if (seat.currentId.length > 0) return seat.currentId;
        return historyScopes.options.length > 0 ? historyScopes.options[0].value : '';
      })();
      const historyScopeValue =
        historyScope !== null && historyScopes.options.some((option) => option.value === historyScope)
          ? historyScope
          : historyScopeAuto;
      const historyScopeSelected = historyScopes.options.find((option) => option.value === historyScopeValue) ?? null;
      const historyScopeName =
        historyScopeSelected === null
          ? historyScopeValue
          : historyScopeSelected.workspaceId.length > 0
            ? historyScopeSelected.label
            : sessionLabelOf(seat.rows, historyScopeValue) || historyScopeSelected.label;
      // The scope enters a **request** only for the workspace layer: the user
      // layer is global, so moving the selector must not re-fetch — let alone
      // re-slice — a log the scope cannot describe.
      const historyScopeArg = historyLayer === 'workspace' ? historyScopeValue : '';
      useLayoutEffect(() => {
        if (tab !== 'history') return undefined;
        const measure = () => {
          const node = historyPanelRef.current === undefined ? null : historyPanelRef.current;
          const rect = node !== null && typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
          const boundary = scrollBoundaryOf(node);
          const boundaryRect =
            boundary !== null && typeof boundary.getBoundingClientRect === 'function' ? boundary.getBoundingClientRect() : null;
          const resolved = historyPanelHeight({
            panelTop: rect === null ? null : rect.top,
            boundaryBottom: boundaryRect === null ? null : boundaryRect.bottom,
            viewportHeight: typeof window !== 'undefined' ? window.innerHeight : null,
            minHeight: HISTORY_PANEL_MIN_HEIGHT,
            gap: HISTORY_PANEL_GAP,
          });
          const next = resolved.source === 'measured' ? resolved.height : null;
          // The same number must not setState: a `ResizeObserver` on the parent
          // would otherwise feed itself a render on every measurement.
          setHistoryPanelPx((current) => (current === next ? current : next));
        };
        measure();
        const cleanups = [];
        if (typeof window !== 'undefined') {
          if (typeof window.addEventListener === 'function') {
            window.addEventListener('resize', measure);
            cleanups.push(() => window.removeEventListener('resize', measure));
          }
          // A dialog that resizes without a window resize (a dragged splitter, a
          // changed padding) is what the observer is for; a runtime without it
          // still gets the window-resize path.
          const parent =
            historyPanelRef.current === null || historyPanelRef.current === undefined
              ? null
              : historyPanelRef.current.parentElement === undefined
                ? null
                : historyPanelRef.current.parentElement;
          if (parent !== null && typeof ResizeObserver === 'function') {
            try {
              const observer = new ResizeObserver(measure);
              observer.observe(parent);
              cleanups.push(() => observer.disconnect());
            } catch {
              // An observer that will not take this element is not a failure: the
              // resize listener above is still in place.
            }
          }
        }
        return () => {
          for (const cleanup of cleanups) cleanup();
        };
      }, [tab, historyLayer, historyScopeArg, reload]);
      // The candidate list the open picker renders: search narrows it, and it is
      // always bounded by the scrolling box rather than by a render cap, because
      // the box — not the page — is what grows.
      const historyScopeMatches = (() => {
        const needle = normalizeNeedle(historyScopeSearch);
        if (needle.length === 0) return historyScopes.options;
        // g-061 batch 3: field by field, with no cache — this list is bounded by
        // the scrolling box, and it is compared exactly as it was before. It is
        // deliberately **not** handed a joined haystack: a match could then span
        // two fields, which would be a new hit and would move
        // `data-history-scope-shown`.
        return historyScopes.options.filter((option) =>
          matchesNeedle([option.label, option.value, option.workspaceId], needle),
        );
      })();

      // ---- g-073 (Revision 55): the two tab-owned scopes --------------------
      // Neither of these is the page's「查看范围」: that one serves「我的 Prompt」
      // alone now (§13.7). Each **state** starts as `null` (「跟随当前会话」), and
      // the effective value it then falls back to is a real session id —
      // `seat.currentId` (or, with nothing current, the first candidate) — so a
      // fresh page behaves exactly as it did; what changed is **who may move
      // them**, and that the page scope can no longer move them.
      //
      // 「提示词总览」: one group per workspace, one option per **session**
      // (see `overviewScopeOptionsOf` for why a session id is required here).
      const overviewScopes = overviewScopeOptionsOf(wsSeat, seat);
      const overviewScopeAuto =
        seat.currentId.length > 0
          ? seat.currentId
          : overviewScopes.options.length > 0
            ? overviewScopes.options[0].value
            : '';
      const overviewScopeValue =
        overviewScope !== null && overviewScopes.options.some((option) => option.value === overviewScope)
          ? overviewScope
          : overviewScopeAuto;
      // The readable name of the overview scope, as **data**: `''` means the
      // global scope, and the chunk that renders it turns that into
      // `sessionGlobal` — no key may be produced on this component's own path,
      // where a throwing translator has to reach the failure card instead
      // (g-063 E1).
      const overviewScopeName =
        overviewScopeValue.length === 0 ? '' : sessionLabelOf(seat.rows, overviewScopeValue) || overviewScopeValue;
      const overviewScopeArg = overviewScopeValue.length > 0 ? overviewScopeValue : null;
      // The candidate groups the open overview picker renders: the search narrows
      // each group's options, and a group left with no option is not rendered at
      // all (an empty heading is not a hit). No cache: the list is bounded by the
      // scrolling box, not by a render cap, and it is compared field by field so
      // a match can never span two fields.
      const overviewScopeGroups = (() => {
        const needle = normalizeNeedle(overviewScopeSearch);
        if (needle.length === 0) return overviewScopes.groups;
        const filtered = [];
        for (const group of overviewScopes.groups) {
          const options = group.options.filter((option) =>
            matchesNeedle([option.label, option.value, group.label], needle),
          );
          if (options.length > 0) filtered.push({ ...group, options });
        }
        return filtered;
      })();

      // 「高级」: a **workspace** dimension, exactly like the version history's own
      // scope (`historyScopeOptionsOf`), because a workspace layer file — and what
      // `reset=true` / `legacy=true` clear — is per workspace, shared by every
      // session in it. The option's value is still a session id: the host resolves
      // a workspace root from a session and a client never supplies a path (§4.2).
      const advancedScopes = historyScopeOptionsOf(wsSeat, seat);
      const advancedScopeAuto = (() => {
        const owner = advancedScopes.options.find((option) => option.sessionIds.includes(seat.currentId));
        // The owner lookup is the history selector's, but the **value** is the
        // current session itself, not the workspace's first one: this selector
        // also decides which session's assembly record the status block reads,
        // and records are keyed by session id. Standing a different session in
        // would silently move the default view off the conversation the reader
        // is looking at.
        if (owner !== undefined) return seat.currentId;
        if (seat.currentId.length > 0) return seat.currentId;
        return advancedScopes.options.length > 0 ? advancedScopes.options[0].value : '';
      })();
      const advancedScopeValue =
        advancedScope !== null && advancedScopes.options.some((option) => option.value === advancedScope)
          ? advancedScope
          : advancedScopeAuto;
      const advancedScopeOwner =
        advancedScopes.options.find((option) => option.sessionIds.includes(advancedScopeValue)) ?? null;
      // The name is the **workspace**'s, because that is what the layer actions
      // act on; while the scope still follows the current session, the session's
      // own name rides along so "which conversation's record is this" is not a
      // question the reader has to guess at.
      const advancedScopeName = (() => {
        const sessionName = sessionLabelOf(seat.rows, advancedScopeValue) || advancedScopeValue;
        if (advancedScopeOwner === null) return sessionName;
        if (advancedScope !== null) return advancedScopeOwner.label;
        if (sessionName.length === 0 || sessionName === advancedScopeOwner.label) return advancedScopeOwner.label;
        return `${advancedScopeOwner.label} · ${sessionName}`;
      })();
      const advancedScopeArg = advancedScopeValue.length > 0 ? advancedScopeValue : null;
      const advancedScopeMatches = (() => {
        const needle = normalizeNeedle(advancedScopeSearch);
        if (needle.length === 0) return advancedScopes.options;
        return advancedScopes.options.filter((option) =>
          matchesNeedle([option.label, option.value, option.workspaceId], needle),
        );
      })();

      React.useEffect(() => {
        let cancelled = false;
        setSnap({ phase: 'loading', data: null, error: null });
        setOvs({ phase: 'loading', data: null, error: null });
        const query = sessionArg === null ? '' : `?session=${encodeURIComponent(sessionArg)}`;
        // Stage 1A side channel: the same ping tells the Host which renderer
        // branch this browser actually got (index.js `clientRenderer`). Since
        // Revision 6 it is *consumed* rather than fired and forgotten: its
        // `clientBuild` is the host's own digest of the bundle it serves, and
        // comparing it with this tab's self-digest is the whole build stamp.
        // The URL is unchanged (`?renderer=…`), so an old host keeps working:
        // no `clientBuild` ⇒「未知」, never a false「过期」.
        const sendPing = async () => {
          const ping = await requestJson(`${PING_PATH}?renderer=${RENDERER}`);
          if (cancelled) return;
          const body = ping.ok && ping.payload ? ping.payload : null;
          const build = body ? body.clientBuild : null;
          // g-029: the *same* answer also carries the plugin version and the
          // repository it links to, so the facts on screen always describe one
          // host boot. Only a string that declares something is kept; anything
          // else (absent, `null`, a number, `''`, whitespace only) stays `null`
          // and renders as「未知」(version) or as plain text (repository) rather
          // than being coerced into a value the host never sent.
          const version = body ? body.version : null;
          const repositoryUrl = body ? body.repositoryUrl : null;
          // g-036: the same ping also carries the host's launch shape. Only the
          // two decided values are kept; everything else (an old host, `null`, a
          // typo) stays `null` and renders the shape-neutral copy — an unknown
          // shape must never be mistaken for a command line.
          const launchKind = body ? body.launchKind : null;
          setBoot({
            self: SELF_BUILD,
            server:
              build && typeof build === 'object' && typeof build.hash === 'string' && build.hash.length > 0
                ? {
                    hash: build.hash,
                    size: typeof build.size === 'number' ? build.size : null,
                    mtime: typeof build.mtime === 'string' ? build.mtime : null,
                    // g-045: the host's digests for every chunk file it really
                    // serves. Absent on an old host, which is what keeps the
                    // pre-split answer (`clientBuild` alone) readable; any other
                    // shape is kept as it arrived, so the verdict can refuse it
                    // instead of silently treating it as "no list".
                    chunks: build.chunks === undefined ? null : build.chunks,
                  }
                : null,
            version: typeof version === 'string' && version.trim().length > 0 ? version : null,
            repositoryUrl:
              typeof repositoryUrl === 'string' && repositoryUrl.trim().length > 0 ? repositoryUrl : null,
            launchKind: launchKind === LAUNCH_KIND_CLI || launchKind === LAUNCH_KIND_DESKTOP ? launchKind : null,
            pingFailed: !ping.ok,
          });
        };
        void sendPing();
        // g-030: one update check per mount — and **none at all** when this
        // browser already knows the switch is off. The mirror is checked first
        // precisely so that a closed switch costs nothing on page load (not even
        // a local request); when the mirror says nothing, the Host is asked once
        // and its answer — which reports `enabled` — fills the mirror.
        //
        // Nothing here paints the main page: a newer release renders the banner,
        // a failure renders nothing anywhere, and every undecided upstream
        // answer (`hasUpdate:null`) is explained only inside 「高级」's card, by
        // `renderUpdateSetting` — which since g-046 lives in that tab's chunk,
        // `client.advanced.js`.
        if (readUpdatePref() === false) {
          // The g-032 install state is carried over, never reset by a check:
          // this effect also re-runs on `reload`, and losing a running install's
          // row there would take its cancel button with it.
          setUpdate((current) => ({ ...current, enabled: false, data: null, check: null, dismissed: false, phase: 'ready' }));
        } else {
          const checkUpdate = async () => {
            const result = await requestJson(UPDATE_CHECK_PATH);
            if (cancelled) return;
            if (!result.ok) {
              // A failed check is not a fact about upstream: keep the last
              // successful `check` (if any) and say nothing new.
              setUpdate((current) => ({ ...current, phase: 'error' }));
              return;
            }
            const enabled = result.payload.enabled !== false;
            writeUpdatePref(enabled);
            setUpdate((current) => ({
              ...current,
              enabled,
              data: result.payload.hasUpdate === true && typeof result.payload.latest === 'string' ? result.payload : null,
              check: result.payload,
              dismissed: false,
              phase: 'ready',
            }));
          };
          void checkUpdate();
          // g-043: the download region rides on the same mount, and on the same
          // zero-request promise: with the mirror saying「off」nothing is asked at
          // all, and the region is loaded when the switch is turned back on
          // (`toggleUpdate`). While the switch is on, this one `GET` is what
          // decides the first-visit default — the page has already rendered, so
          // the detection arrives asynchronously and never blocks the first
          // paint, and the Host caps each probe at 2.5 s (§17.9).
          void loadRegion();
        }
        const load = async () => {
          const snapshot = await requestJson(`${SNAPSHOT_PATH}${query}`);
          if (cancelled) return;
          setSnap(
            snapshot.ok
              ? { phase: 'ready', data: snapshot.payload, error: null }
              : { phase: 'error', data: null, error: snapshot.error },
          );
          const overrides = await requestJson(`${OVERRIDES_PATH}${query}`);
          if (cancelled) return;
          setOvs(
            overrides.ok
              ? { phase: 'ready', data: overrides.payload, error: null }
              : { phase: 'error', data: null, error: overrides.error },
          );
        };
        void load();
        return () => {
          cancelled = true;
        };
      }, [sessionArg, reload]);

      // g-073 (Revision 55): the preset library is **not** read in the page scope
      // any more. It is one global file plus the records each workspace states
      // (§20.2), and the page's「查看范围」serves「我的 Prompt」alone — so this read
      // carries no `?session=` at all, and moving the page scope neither
      // re-slices nor re-fetches it. It still rides on `reload`, because the
      // writes that change that file (a save, a delete, an applied import) are
      // what bump that counter. A library reason is still *not* an error of this
      // page: `GET /presets` answers `200` with an `error` field, which the tab
      // renders as a library problem rather than as「没有预设」.
      React.useEffect(() => {
        let cancelled = false;
        const run = async () => {
          const presetsResult = await requestJson(PRESETS_PATH);
          if (cancelled) return;
          setPresets(
            presetsResult.ok
              ? { phase: 'ready', data: presetsResult.payload, error: null }
              : { phase: 'error', data: null, error: presetsResult.error },
          );
        };
        void run();
        return () => {
          cancelled = true;
        };
      }, [reload]);

      // g-073 (Revision 55):「提示词总览」reads the snapshot in **its own** scope.
      // The read happens on the tab's **first** open, on a scope change and on a
      // reload — not on every re-entry — because every `/snapshot` answer costs
      // the host two `assemble()` runs (§2.6): re-reading it on every render (or
      // on every move of the page's「查看范围」) is exactly what this shape avoids.
      // The page scope can move all it likes; this request never carries it.
      // g-073 (R3): what「提示词总览」has already read, as `{scope, reload}`. It is
      // written **only when an answer really arrived**, so a read that was
      // cancelled by a tab switch is not remembered — switching back re-reads
      // instead of leaving the panel on a loading frame forever. A tab switch
      // that finds its own scope and generation already recorded reuses what is
      // on screen: no request, and no `loading` frame (review R3-1).
      const overviewReadRef = React.useRef(null);
      React.useEffect(() => {
        if (tab !== 'overview') return undefined;
        const scopeKey = overviewScopeArg === null ? '' : overviewScopeArg;
        const read = overviewReadRef.current;
        if (read !== null && read.scope === scopeKey && read.reload === reload) return undefined;
        // A **different** scope drops the old data (another scope's assembly must
        // never look like this one's); a reload of the **same** scope keeps it,
        // so the panel stays readable while the fresh answer is in flight.
        const sameScope = read !== null && read.scope === scopeKey;
        let cancelled = false;
        setOverviewSnap((current) => ({
          phase: 'loading',
          data: sameScope ? current.data : null,
          error: null,
        }));
        const query = scopeKey === '' ? '' : `?session=${encodeURIComponent(scopeKey)}`;
        const run = async () => {
          const result = await requestJson(`${SNAPSHOT_PATH}${query}`);
          if (cancelled) return;
          overviewReadRef.current = { scope: scopeKey, reload };
          setOverviewSnap(
            result.ok
              ? { phase: 'ready', data: result.payload, error: null }
              : { phase: 'error', data: null, error: result.error },
          );
        };
        void run();
        return () => {
          cancelled = true;
        };
      }, [tab, overviewScopeArg, reload]);

      // g-073 (Revision 55):「高级」reads **both** halves of its own scope — the
      // override lists the legacy view renders and the snapshot its `applied`
      // verdicts come from. The legacy list and the two layer-wide counts
      // describe one layer file, so they may not come from the page-scoped
      // response — that one belongs to「我的 Prompt」. Gated on the tab being open,
      // exactly like the assembly-status read below, so a mount that never opens
      // this tab still pays nothing.
      // g-073 (R3): the same `{scope, reload}` bookkeeping as the overview's above
      // (and the same rule: recorded only when an answer arrived, so a cancelled
      // read is retried rather than remembered).
      const advancedReadRef = React.useRef(null);
      React.useEffect(() => {
        if (tab !== 'advanced') return undefined;
        const scopeKey = advancedScopeArg === null ? '' : advancedScopeArg;
        const read = advancedReadRef.current;
        if (read !== null && read.scope === scopeKey && read.reload === reload) return undefined;
        const sameScope = read !== null && read.scope === scopeKey;
        let cancelled = false;
        setAdvancedOvs((current) => ({ phase: 'loading', data: sameScope ? current.data : null, error: null }));
        setAdvancedSnap((current) => ({ phase: 'loading', data: sameScope ? current.data : null, error: null }));
        const query = scopeKey === '' ? '' : `?session=${encodeURIComponent(scopeKey)}`;
        const run = async () => {
          const overrides = await requestJson(`${OVERRIDES_PATH}${query}`);
          if (cancelled) return;
          setAdvancedOvs(
            overrides.ok
              ? { phase: 'ready', data: overrides.payload, error: null }
              : { phase: 'error', data: null, error: overrides.error },
          );
          const snapshot = await requestJson(`${SNAPSHOT_PATH}${query}`);
          if (cancelled) return;
          advancedReadRef.current = { scope: scopeKey, reload };
          setAdvancedSnap(
            snapshot.ok
              ? { phase: 'ready', data: snapshot.payload, error: null }
              : { phase: 'error', data: null, error: snapshot.error },
          );
        };
        void run();
        return () => {
          cancelled = true;
        };
      }, [tab, advancedScopeArg, reload]);

      // The assembly-status read belongs to 「高级」: since g-065 that tab owns
      // the two-layer observation block (its own chunk renders it), so the read
      // follows the block instead of the write surface. A mount that never opens
      // that tab still issues no assembly-status request at all.
      //
      // g-073 (Revision 55): it is asked in the advanced tab's **own** scope. The
      // host keys one record per session id (`core/assembly-watch.js`), so the
      // selector's value — a member session of the chosen workspace — is what
      // names the record to read; the page's「查看范围」no longer does.
      // g-073 (R3): the same `{scope, reload}` bookkeeping, so switching back to
      // this tab reuses the observation instead of asking again — the block never
      // blanks (its state is never reset to a loading phase), and the follow-up
      // poll below is unaffected because it re-enters `run` directly.
      const assemblyReadRef = React.useRef(null);
      React.useEffect(() => {
        if (tab !== 'advanced') return undefined;
        const scopeKey = advancedScopeArg === null ? '' : advancedScopeArg;
        const read = assemblyReadRef.current;
        if (read !== null && read.scope === scopeKey && read.reload === reload) return undefined;
        let cancelled = false;
        let timer = null;
        const query = scopeKey === '' ? '' : `?session=${encodeURIComponent(scopeKey)}`;
        // One read per mount/tab/scope change, plus a short follow-up **only**
        // while the Host reports a notice whose delivery layer is still
        // `waiting`: that verdict is settled by a session event which arrives
        // after the assembly, so a single read may legitimately see it pending.
        // Nothing here writes to a session and nothing reaches the model.
        const run = async () => {
          const result = await requestJson(`${ASSEMBLY_STATUS_PATH}${query}`);
          if (cancelled) return;
          // Recorded only once an answer really arrived: a read cancelled by a tab
          // switch is retried, never remembered as done.
          assemblyReadRef.current = { scope: scopeKey, reload };
          if (!result.ok) {
            setAssembly((current) => ({ ...current, phase: 'error', error: result.error }));
            return;
          }
          const payload = result.payload;
          setAssembly((current) => ({
            ...current,
            phase: 'ready',
            data: payload,
            error: null,
            enabled: payload !== null && typeof payload === 'object' && payload.enabled === true,
          }));
          const waiting =
            payload !== null &&
            typeof payload === 'object' &&
            payload.record !== null &&
            typeof payload.record === 'object' &&
            payload.record.notice !== null &&
            typeof payload.record.notice === 'object' &&
            payload.record.notice.delivery !== null &&
            typeof payload.record.notice.delivery === 'object' &&
            payload.record.notice.delivery.state === 'waiting';
          if (waiting) timer = setTimeout(run, ASSEMBLY_POLL_MS);
        };
        void run();
        return () => {
          cancelled = true;
          if (timer !== null) clearTimeout(timer);
        };
      }, [tab, advancedScopeArg, reload]);

      // History is loaded only while 「版本历史」 is open: 「我的 Prompt」 and
      // 「提示词总览」 must not pay for a log they never show, and a mount that
      // never opens that tab must issue exactly the baseline requests.
      //
      // g-038: the request is `layer` + `offset` (+ `workspace` for the
      // workspace layer) and **no** `session` — the page's 「查看范围」 is not a
      // parameter of this read at all, so changing it can never re-slice or
      // re-fetch the log. `limit` is omitted on purpose: the host owns the page
      // size and answers it as `pageLimit`, which is what the pager then steps
      // by. The user layer is global; the workspace layer needs a locatable
      // workspace, so an unresolved scope shows the note instead of a request
      // the host must refuse.
      // g-073 (R3): the log is a tab-owned read like the other two, so it gets the
      // same `{scope, reload}` bookkeeping. Its scope key is the whole read — the
      // layer, the locating session and the offset — because paging or switching
      // the history layer really is a different page of the file; a tab switch
      // that changes **none** of them reuses what is on screen.
      const historyReadRef = React.useRef(null);
      React.useEffect(() => {
        if (tab !== 'history') return undefined;
        if (historyLayer === 'workspace' && historyScopeValue.length === 0) {
          setHist({ phase: 'idle', data: null, error: null });
          return undefined;
        }
        const readKey = `${historyLayer}|${historyScopeArg}|${historyOffset}`;
        const read = historyReadRef.current;
        if (read !== null && read.key === readKey && read.reload === reload) return undefined;
        let cancelled = false;
        setHist((current) => ({ ...current, phase: 'loading' }));
        const query = `${historyScopeQuery(historyLayer, historyScopeArg)}&offset=${historyOffset}`;
        const run = async () => {
          const result = await requestJson(`${HISTORY_PATH}?${query}`);
          if (cancelled) return;
          historyReadRef.current = { key: readKey, reload };
          setHist(
            result.ok
              ? { phase: 'ready', data: result.payload, error: null }
              : { phase: 'error', data: null, error: result.error },
          );
        };
        void run();
        return () => {
          cancelled = true;
        };
      }, [tab, historyLayer, historyScopeArg, historyOffset, reload]);

      const snapshot = snap.data;
      // g-038: the paging numbers of the last log read (the host's own page
      // size, offset, total and page count), plus the two steps the pager may
      // take. Both steps clamp, so a stale number can never ask for page 0 or
      // past the end.
      const histPage = historyPagerInfo(hist.data);
      // g-039: the record the detail pane previews, resolved against the page on
      // screen. `missing` is an explicit state rather than an empty panel: a
      // paged list legitimately stops holding a selection (paging does not reset
      // it, §13.3), and saying so is better than rendering nothing.
      const historyRecords = hist.data && Array.isArray(hist.data.records) ? hist.data.records : [];
      const previewRecord =
        previewId === null ? null : historyRecords.find((record) => String(record.id) === previewId) ?? null;
      const previewInfo = {
        id: previewId,
        record: previewRecord,
        state: previewId === null ? 'none' : previewRecord === null ? 'missing' : 'ready',
      };
      // g-039 fourth round: the panel's own height decision, as the data it is —
      // a px number with source `measured`, or `null` with source `fallback`,
      // which the renderer turns into `HISTORY_PANEL_HEIGHT`.
      const historyPanel = {
        height: historyPanelPx,
        source: historyPanelPx === null ? 'fallback' : 'measured',
      };
      /**
       * Reset everything that points **into the file that was on screen**.
       *
       * g-038 fix: `diffSel` holds history ids, and an id is only meaningful
       * inside one history file. Switching the layer (user ↔ workspace) or the
       * workspace scope changes which file that is, so a selection made against
       * the old file must not survive: it would highlight a row of the new file
       * that it never referred to, and would leave the detail column describing
       * a version that is no longer comparable. The page number resets with it
       * (the old offset can land past the end of a shorter new file).
       *
       * **Paging does not call this.** `historyPrev` / `historyNext` move within
       * one file, so the reader's selection stays — see CONTRACT §13.3.
       */
      const resetHistoryView = () => {
        setHistoryOffset(0);
        setDiffSel({ from: null, to: DIFF_CURRENT });
        setDiff({ phase: 'idle', data: null, error: null });
        setPreviewId(null);
        // g-039 fifth round: an open modal describes a record — possibly one the
        // new file does not even contain — so it goes with the selection.
        setHistoryModal(null);
      };
      const historyPrev = () =>
        setHistoryOffset(Math.max(0, histPage.offset - Math.max(1, histPage.pageSize)));
      const historyNext = () => {
        if (histPage.pageSize <= 0) return;
        const lastOffset = Math.max(0, (Math.max(1, histPage.pageCount) - 1) * histPage.pageSize);
        setHistoryOffset(Math.min(lastOffset, histPage.offset + histPage.pageSize));
      };
      const fz = frozenState(snapshot, sessionArg !== null);
      const effectiveSections =
        snapshot && snapshot.effective && Array.isArray(snapshot.effective.sections)
          ? snapshot.effective.sections
          : [];
      const phase = snap.phase === 'ready' && effectiveSections.length === 0 ? 'empty' : snap.phase;
      const incoming = incomingNames(snapshot);
      // g-073 (Revision 55): the four derived facts「提示词总览」renders, taken from
      // **its own** snapshot. They are separate values rather than a switched
      // source so the page-scoped ones above keep describing「我的 Prompt」exactly
      // as before, in every tab, and a tab switch cannot change what another
      // surface's model says.
      const overviewSnapshot = overviewSnap.data;
      const overviewFz = frozenState(overviewSnapshot, overviewScopeArg !== null);
      const overviewEffectiveSections =
        overviewSnapshot && overviewSnapshot.effective && Array.isArray(overviewSnapshot.effective.sections)
          ? overviewSnapshot.effective.sections
          : [];
      const overviewIncoming = incomingNames(overviewSnapshot);
      // g-073 (Revision 55): the same two facts for「高级」, from **its own**
      // snapshot — the legacy list's `applied` verdict is a statement about the
      // assembly in this scope, not about the page scope's.
      const advancedSnapshot = advancedSnap.data;
      const advancedEffectiveSections =
        advancedSnapshot && advancedSnapshot.effective && Array.isArray(advancedSnapshot.effective.sections)
          ? advancedSnapshot.effective.sections
          : [];
      const advancedIncoming = incomingNames(advancedSnapshot);

      // ---- 「我的 Prompt」: the reserved section's stored value and its state
      // g-056: the draft is keyed by the **write target**, so a draft typed for
      // `user` is not shown as if it were the workspace layer's, and switching
      // back restores it rather than losing it — while a「查看范围」change that
      // does not move the target (the same workspace, or any session at all on
      // the user layer) no longer takes the text off the screen.
      const mineWorkspaceRoot = workspaceRootOfSession(wsSeat.items, sessionArg);
      const mineKey = mineDraftKeyOf(mineLayer, sessionArg, mineWorkspaceRoot);
      // The draft records the scope it was typed in as **data**, never as
      // localized copy: no key may be produced on the component's own path (a
      // translator that throws must still land in the failure card).
      const mineScope = { layer: mineLayer, session: sessionArg, root: mineWorkspaceRoot };
      /**
       * The readable name of one recorded draft scope. It is called from event
       * handlers only — never from this component's own render path, where a
       * throwing `t` has to reach the failure card instead.
       */
      const draftScopeNameOf = (scope) =>
        scope === null || scope === undefined ? '' : mineScopeNameOf(t, scope.layer, scope.session, seat.rows);
      const mineStored = reservedTextOf(ovs.data, mineLayer);
      // g-058: the mode **this layer's file** stores (`null` = the layer states
      // none), read from the same per-layer view as the text (g-054).
      const mineStoredMode = reservedModeOf(ovs.data, mineLayer);
      const mineConfigured = mineStored !== null && mineStored.length > 0;
      const mineEntry = mineDrafts[mineKey] ?? null;
      const mineText = mineEntry === null ? (mineStored === null ? '' : mineStored) : mineEntry.text;
      /**
       * g-058: the mode the box is showing — the draft's while one exists, the
       * stored one otherwise. A layer that states no mode reads as「覆盖」, which
       * is what its entry already did and what a save would write again; the
       * *display* still tells「未设置」from「显式覆盖」separately (the stored-mode
       * line below), exactly as the interpolation switch does (§16.1).
       */
      const mineMode =
        mineEntry === null ? (mineStoredMode ?? RESERVED_SECTION_DEFAULT_MODE) : draftModeOf(mineEntry);
      /**
       * g-056 (review R1): the draft of **another** write target that is still
       * unsaved work there. It is neither shown in this box nor allowed to be
       * silently written over, so it is stated and the save below refuses while
       * it exists.
       *
       * Three facts each disqualify a draft, and all three are needed — and since
       * g-058 each of them compares the draft's **mode** as well as its text,
       * because a draft that differs only in mode is still work a save would
       * overwrite:
       *   - it holds nothing this save would write (no text, and the default
       *     mode), or
       *   - it equals what this save would write — same text, same mode (nothing
       *     can be lost), or
       *   - it equals `baseline`/`baselineMode`, what this page last **wrote** to
       *     that target (the post-save draft §13.1 deliberately keeps, so a
       *     successful save followed by a layer/scope switch is no longer
       *     reported as unsaved work), or
       *   - it equals that target's own stored entry — text **and** mode — read
       *     from the layer's own view (`layerReservedTextOf` /
       *     `layerReservedModeOf`, never `merged`).
       * When the target is a workspace this request never read, none of the last
       * two can be decided: the draft stays「possibly unsaved」and is reported —
       * warning about text that may already be saved is the tolerable error,
       * silently overwriting it is not.
       */
      const mineForeignDraft = (() => {
        for (const key of Object.keys(mineDrafts)) {
          if (key === mineKey) continue;
          const draft = mineDrafts[key];
          if (draft === null || draft === undefined || draft.text.length === 0) continue;
          if (draft.text === mineText && draftModeOf(draft) === mineMode) continue;
          if (
            draft.text === (draft.baseline ?? null)
            && draftModeOf(draft) === (draft.baselineMode ?? RESERVED_SECTION_DEFAULT_MODE)
          ) {
            continue;
          }
          const own = draftTargetOf(ovs.data, draft.scope, mineWorkspaceRoot);
          if (own.known && own.text === draft.text && (own.mode ?? RESERVED_SECTION_DEFAULT_MODE) === draftModeOf(draft)) {
            continue;
          }
          return { key, text: draft.text, scope: draft.scope ?? null };
        }
        return null;
      })();
      // g-021: the panel separates *certainly frozen* from *unknown*, and the
      // verdict is the host's alone — `frozenState` reads the snapshot's
      // `frozen` / `frozenScope` (§2.4/§7.2), which covers both the certain
      // cases and the `frozenScope: "global"` + session case that must never be
      // presented as frozen (the snapshot froze the unscoped assembly, not this
      // session).
      //
      // The reserved entry's own `applied: false` is deliberately NOT a second
      // vote. `applied: false` is the *normal* state of a section with no
      // override (§15.3 defines it that way, and `reason` is `null` when there
      // is nothing to explain), and every non-frozen failure reports it too — a
      // `replace` that did not stick, a `hide` that did not stick, an entry the
      // pipeline dropped. Reading any of them as a freeze is what made a
      // freshly installed, still-unconfigured plugin show「该作用域已被冻结」on
      // first open, next to a status card that said the session was not frozen.
      const mineFrozen = (() => {
        if (fz.certain && fz.frozen) return { reason: fz.reason ? String(fz.reason) : '', certain: true };
        if (fz.kind === 'unknown' && fz.frozen) return { reason: fz.reason ? String(fz.reason) : '', certain: false };
        return null;
      })();
      const mineFrozenReason = mineFrozen === null ? null : mineFrozen.reason;
      const mineFrozenCertain = mineFrozen !== null && mineFrozen.certain;
      const mineState =
        mineStatus.kind === 'saving'
          ? 'saving'
          : mineStatus.kind === 'saved'
            ? 'saved'
            : mineStatus.kind === 'error'
              ? 'error'
              : !mineConfigured && mineText.length === 0 && mineMode === RESERVED_SECTION_DEFAULT_MODE
                ? 'unconfigured'
                : mineStored !== mineText
                    || (mineStoredMode ?? RESERVED_SECTION_DEFAULT_MODE) !== mineMode
                  ? 'dirty'
                  : 'idle';
      // ---- Revision 9: the variable-substitution switch, as the host reports
      // it. `effective` is what this session's assembly will do; the per-layer
      // value is what the layer itself states, and `null` there means "states
      // nothing", which is *not* the same as `false` (the workspace layer then
      // inherits the user layer, §16.1).
      const mineInterpolateInfo =
        snapshot && snapshot.layers && snapshot.layers.interpolate ? snapshot.layers.interpolate : null;
      const mineInterpolateOn = mineInterpolateInfo !== null && mineInterpolateInfo.effective === true;
      const mineInterpolateStated = mineInterpolateInfo === null ? null : mineInterpolateInfo[mineLayer];
      const mineInterpolateLocked = mineLayer === 'workspace' && sessionArg === null;
      // Revision 12 (audit F4): the SAME fact as a name, which is what the three
      // state controls select between: `inherit` is the absent key, `on`/`off`
      // are the stated booleans. Deriving it here rather than in the tree keeps
      // one source of truth for "what does this layer say".
      const mineInterpolateState =
        mineInterpolateStated === true ? 'on' : mineInterpolateStated === false ? 'off' : 'inherit';
      // Revision 12 (audit F2/F5): what the host said about the layer the user is
      // editing. A degraded layer contributes nothing to any assembly, so the
      // panel has to say so where the text box is — the advanced tab's status
      // block is one scroll too far for "your prompt is not in the prompt".
      const mineLayerInfo =
        snapshot && snapshot.layers
          ? mineLayer === 'workspace'
            ? snapshot.layers.workspace
            : snapshot.layers.user
          : null;
      const mineLayerDisabled =
        mineLayerInfo !== null && mineLayerInfo !== undefined && mineLayerInfo.enabled === false
        && (mineLayer === 'user' || sessionArg !== null)
          ? String(mineLayerInfo.reason ? mineLayerInfo.reason : '')
          : null;
      /**
       * Ask the host for a comparison and store the result. `from`/`to` are a
       * history id or {@link DIFF_CURRENT}; a half-made selection clears the
       * panel rather than sending a request that cannot answer anything.
       *
       * g-038: the comparison is scoped exactly like the log beside it — the
       * version history's own scope, never the page's 「查看范围」 — so the two
       * can never describe different files.
       */
      const runDiff = async (from, to) => {
        if (from === null || to === null) {
          setDiff({ phase: 'idle', data: null, error: null });
          return;
        }
        setDiff({ phase: 'loading', data: null, error: null });
        const query = `${historyScopeQuery(historyLayer, historyScopeArg)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
        const result = await requestJson(`${DIFF_PATH}?${query}`);
        setDiff(
          result.ok
            ? { phase: 'ready', data: result.payload, error: null }
            : { phase: 'error', data: null, error: result.error },
        );
      };

      /**
       * g-039: roll the history's own layer back to one recorded version.
       *
       * The request carries the version-history scope (`workspace` for the
       * workspace layer) exactly as the list and the comparison do, so the file
       * that is written is the file that was read. It is the **only** write this
       * tab starts, and it never fires without the second confirmation.
       *
       * On success the log has one more record and the layer has new content, so
       * the view is reset and the data reloaded: the list, the comparison and
       * the current value all come back from the host rather than being patched
       * in place, which is what keeps the pager from describing a page that no
       * longer exists.
       */
      /**
       * g-056 (review R2/R3): remove **one** write target's draft.
       *
       * Every local reset goes through this — 「取消」, 「恢复默认」, the g-050
       * reconciliation and「放弃那份草稿」— so none of them can clear a draft that
       * belongs to another target (R3), and typing in a second target leaves the
       * first target's text where it is (R2). No request, no disk byte: this is
       * view state only.
       * @param key - the write-target key whose draft to drop.
       */
      const dropMineDraft = (key) => {
        setMineDrafts((current) => {
          if (current[key] === undefined) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
      };

      /**
       * Reconcile the「我的 Prompt」draft after an operation changed a layer's
       * stored text **behind the editor's back** (g-050: rollback, a whole-layer
       * reset, or an applied import).
       *
       * The box renders the draft while one exists (see `mineText`), so without
       * this the editor keeps showing text that is no longer the stored value and
       * the operation reads as «nothing happened». The two cases are deliberately
       * different:
       *   - a draft that still equals the stored text has nothing the user typed,
       *     so it is dropped and the editor follows the new value;
       *   - a draft that differs **is** unsaved work — it is kept, and the caller
       *     appends `mineDraftKept` to the notice instead of silently destroying
       *     the reader's text. §15.4's「no path clears what the user typed」is
       *     about exactly this second case.
       * @returns `true` when the editor follows the stored text, `false` when a
       *   differing draft was kept.
       */
      const settleMineDraft = () => {
        if (mineEntry === null) return true;
        const previous = mineStored === null ? '' : mineStored;
        if (mineEntry.text !== previous) return false;
        // g-058: the mode is part of the comparison. A draft that still matches
        // the stored text but states the *other* mode is unsaved work — dropping
        // it would take the user's mode choice off the screen.
        if (draftModeOf(mineEntry) !== (mineStoredMode ?? RESERVED_SECTION_DEFAULT_MODE)) return false;
        dropMineDraft(mineKey);
        return true;
      };

      const rollbackTo = async (pending) => {
        setBusy(true);

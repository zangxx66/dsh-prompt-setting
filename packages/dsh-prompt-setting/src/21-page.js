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
        const query = historyScopeQuery(historyLayer, historyScopeArg);
        const result = await requestJson(`${ROLLBACK_PATH}?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ layer: pending.layer ?? historyLayer, seq: pending.seq }),
        });
        setBusy(false);
        if (!result.ok) {
          setNotice({ tone: 'error', text: fmt(t('histRollbackFailed'), { reason: errorText(t, result.error) }) });
          return;
        }
        const followed = settleMineDraft();
        setNotice({
          tone: 'success',
          text: fmt(t('histRollbackDone'), { id: pending.id }) + (followed ? '' : ` ${t('mineDraftKept')}`),
        });
        resetHistoryView();
        setReload((value) => value + 1);
      };

      /**
       * Clear one whole layer (`DELETE …&reset=true`).
       *
       * g-073 (Revision 55): the workspace is the one **「高级」's own selector**
       * names, not the page's「查看范围」. The semantics are worth restating: on the
       * workspace layer this clears the **whole workspace file** — every session in
       * that workspace shares it — so the selector aims at a workspace, and which
       * member session stands for it changes nothing about what is cleared. The
       * user layer is global and reads no session at all.
       */
      const resetLayer = async (layer) => {
        setBusy(true);
        const result = await requestJson(`${OVERRIDES_PATH}?${layerQuery(layer, advancedScopeArg)}&reset=true`, { method: 'DELETE' });
        setBusy(false);
        if (!result.ok) {
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        const count = result.payload && typeof result.payload.count === 'number' ? result.payload.count : 0;
        const followed = settleMineDraft();
        setNotice({
          tone: 'success',
          text: (count > 0 ? fmt(t('resetDoneNotice'), { count }) : t('resetNoneNotice')) + (followed ? '' : ` ${t('mineDraftKept')}`),
        });
        setReload((value) => value + 1);
      };

      /**
       * Fetch the export document, hold its text, and try to download it.
       *
       * g-073 (Revision 55): the request carries **no** page scope. A backup is
       * not a view of one range — since Revision 53 it carries every layer's
       * overrides, every workspace layer, the preset library and the preferences
       * (§10) — so the page's「查看范围」has no business in it, and a document that
       * depended on which session happened to be selected could not be called a
       * backup. The host's `?session=` (still accepted) only ever located the one
       * workspace layer view it used to narrow the document to.
       */
      const exportNow = async () => {
        setBusy(true);
        const result = await requestJson(EXPORT_PATH);
        setBusy(false);
        if (!result.ok) {
          setTransfer((current) => ({ ...current, phase: 'error', error: result.error, plan: null }));
          setNotice({ tone: 'error', text: fmt(t('exportFailed'), { reason: errorText(t, result.error) }) });
          return;
        }
        // `ok` is this plugin's own liveness flag, not part of the document: a
        // downloaded file must be importable by anything that reads the schema.
        const document = { ...result.payload };
        delete document.ok;
        const text = JSON.stringify(document, null, 2);
        const fileName = exportFileName(document.exportedAt);
        const download = downloadText(text, fileName);
        // g-066: the failure reason is a dictionary lookup, not the browser's
        // own wording — `error.download-failed` is not a host rejection code,
        // so `errorText` falls back to the localized `errUnknown` and the
        // English phrase never reaches the notice.
        const downloadError = download.ok ? null : { code: download.code };
        setTransfer({
          phase: download.ok ? 'exported' : 'error',
          plan: null,
          error: downloadError,
          exportText: text,
          fileName,
        });
        setNotice({
          tone: download.ok ? 'success' : 'error',
          text: download.ok ? fmt(t('downloadDone'), { name: fileName }) : fmt(t('downloadFailed'), { reason: errorText(t, downloadError) }),
        });
      };

      /** Load an export document from a chosen file, when the file API exists. */
      const pickImportFile = async (event) => {
        const file = event && event.target && event.target.files ? event.target.files[0] : null;
        if (!file) return;
        if (typeof file.text !== 'function') {
          setTransfer((current) => ({
            ...current,
            phase: 'error',
            plan: null,
            error: { code: 'invalid-export', message: 'this browser cannot read a chosen file; paste the JSON instead' },
          }));
          return;
        }
        setBusy(true);
        try {
          const text = await file.text();
          setImportText(String(text));
          setTransfer((current) => ({ ...current, phase: 'idle', plan: null, error: null }));
        } catch (error) {
          setTransfer((current) => ({
            ...current,
            phase: 'error',
            plan: null,
            error: { code: 'invalid-export', message: error && error.message ? String(error.message) : String(error) },
          }));
        }
        setBusy(false);
      };

      /** Dry-run the pasted document: a preview, and provably no write. */
      const previewImport = async () => {
        const raw = String(importText).trim();
        if (raw.length === 0) {
          setNotice({ tone: 'error', text: t('importNeedText') });
          return;
        }
        try {
          JSON.parse(raw);
        } catch (error) {
          setTransfer((current) => ({
            ...current,
            phase: 'error',
            plan: null,
            error: { code: 'invalid-json', message: error && error.message ? String(error.message) : String(error) },
          }));
          return;
        }
        setTransfer((current) => ({ ...current, phase: 'previewing', error: null }));
        setBusy(true);
        const query = `dryRun=true&mode=${encodeURIComponent(importMode)}`;
        const result = await requestJson(`${IMPORT_PATH}?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        setBusy(false);
        if (!result.ok) {
          setTransfer((current) => ({ ...current, phase: 'error', error: result.error, plan: null }));
          return;
        }
        setTransfer((current) => ({ ...current, phase: 'preview', plan: result.payload, error: null }));
      };

      /** Perform the confirmed import. */
      const applyImport = async () => {
        const raw = String(importText).trim();
        setTransfer((current) => ({ ...current, phase: 'applying', error: null }));
        setBusy(true);
        const query = `mode=${encodeURIComponent(importMode)}`;
        const result = await requestJson(`${IMPORT_PATH}?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        setBusy(false);
        if (!result.ok) {
          setTransfer((current) => ({ ...current, phase: 'error', error: result.error }));
          setNotice({ tone: 'error', text: `${errorText(t, result.error)} ${t('importUnchangedWarning')}` });
          return;
        }
        const totals = result.payload && result.payload.totals ? result.payload.totals : {};
        const count = (totals.added || 0) + (totals.replaced || 0) + (totals.removed || 0);
        setTransfer((current) => ({ ...current, phase: 'applied', plan: result.payload, error: null }));
        const followed = settleMineDraft();
        setNotice({
          tone: 'success',
          text: (result.payload && result.payload.unchanged === true
            ? t('importUnchangedNotice')
            : fmt(t('importAppliedNotice'), {
                written: result.payload && Array.isArray(result.payload.written) ? result.payload.written.length : 0,
                count,
              })) + (followed ? '' : ` ${t('mineDraftKept')}`),
        });
        setReload((value) => value + 1);
      };

      /**
       * Revision 9: open or close variable substitution for「我的 Prompt」.
       *
       * The switch is written to the **selected layer**, and the value sent is
       * the negation of the *effective* one the host reported: the button says
       * "turn it off" whenever this session interpolates, so a click always
       * produces the state the label promised — even when the effective value
       * came from the other layer (a workspace layer that states nothing
       * inherits the user layer).
       *
       * A refusal is the host's own words (usually `unresolvable-variable`,
       * naming the stored text the write face will not accept): the panel shows the code and
       * the message rather than a generic failure, because the fix is in the
       * text box right below.
       */
      const toggleMineInterpolate = async () => {
        const layer = mineLayer;
        if (layer === 'workspace' && sessionArg === null) {
          setMineInterpolate({ kind: 'error', error: { code: 'workspace-unresolved' } });
          setNotice({ tone: 'error', text: errorText(t, { code: 'workspace-unresolved' }) });
          return;
        }
        const next = !mineInterpolateOn;
        setMineInterpolate({ kind: 'saving', error: null });
        setBusy(true);
        // The two-valued spelling on purpose: this is the shortcut that goes
        // between ON and "unstated", which is what makes on→off an exact byte
        // revert (§16.7). The explicit OFF is a separate, deliberate choice and
        // lives on the three-state control below.
        const body = { enabled: next, layer };
        if (sessionArg !== null) body.session = sessionArg;
        const result = await requestJson(INTERPOLATE_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy(false);
        if (!result.ok) {
          setMineInterpolate({ kind: 'error', error: result.error });
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        const applied = result.payload && result.payload.interpolateCustom === true;
        setMineWarnings(payloadWarnings(result.payload));
        setMineInterpolate({ kind: 'saved', error: null });
        setNotice({
          tone: 'success',
          text: fmt(t('mineInterpolateSaved'), { state: t(applied ? 'mineInterpolateOn' : 'mineInterpolateOff') }),
        });
        setReload((value) => value + 1);
      };

      /**
       * Revision 12 (audit F4): state one of the three values for the selected
       * layer — `inherit` (the key is removed), `on` (`true`) or `off` (the
       * boolean `false`).
       *
       * This is the control that makes「显式关」reachable at all: the two-valued
       * toggle can only return a layer to unstated, so a workspace layer could
       * never close the switch the user layer had opened, and the panel showed
       * OFF while the session really inherited ON.
       * @param choice - `inherit` | `on` | `off`.
       */
      const setMineInterpolateState = async (choice) => {
        const layer = mineLayer;
        const state = choice === 'on' || choice === 'off' ? choice : 'inherit';
        if (layer === 'workspace' && sessionArg === null) {
          setMineInterpolate({ kind: 'error', error: { code: 'workspace-unresolved' } });
          setNotice({ tone: 'error', text: errorText(t, { code: 'workspace-unresolved' }) });
          return;
        }
        setMineInterpolate({ kind: 'saving', error: null });
        setBusy(true);
        const body = { state, layer };
        if (sessionArg !== null) body.session = sessionArg;
        const result = await requestJson(INTERPOLATE_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy(false);
        if (!result.ok) {
          setMineInterpolate({ kind: 'error', error: result.error });
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        setMineWarnings(payloadWarnings(result.payload));
        setMineInterpolate({ kind: 'saved', error: null });
        setNotice({
          tone: 'success',
          text: fmt(t('mineInterpolateStateSaved'), {
            state: t(
              state === 'on' ? 'mineInterpolateSetOn' : state === 'off' ? 'mineInterpolateSetOff' : 'mineInterpolateSetInherit',
            ),
          }),
        });
        setReload((value) => value + 1);
      };

      /**
       * g-062: turn the assembly-status notice on or off.
       *
       * One `PUT` of the boolean the Host stores in `preferences.json`, merged
       * with whatever else that document holds. The switch is the user's, so a
       * write failure is reported in the block rather than retried silently; the
       * page's own state is the Host's answer, never the wish.
       */
      const toggleAssemblyNotice = async () => {
        const next = assembly.enabled !== true;
        setAssembly((current) => ({ ...current, status: { kind: 'saving', error: null } }));
        setBusy(true);
        const result = await requestJson(ASSEMBLY_STATUS_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        });
        setBusy(false);
        if (!result.ok) {
          setAssembly((current) => ({ ...current, status: { kind: 'error', error: result.error } }));
          setNotice({ tone: 'error', text: `${t('assemblySaveFailed')} — ${errorText(t, result.error)}` });
          return;
        }
        const applied = result.payload !== null && typeof result.payload === 'object' && result.payload.enabled === true;
        setAssembly((current) => ({
          ...current,
          enabled: applied,
          data:
            current.data === null || typeof current.data !== 'object'
              ? current.data
              : { ...current.data, enabled: applied },
          status: { kind: 'saved', error: null },
        }));
        setNotice({ tone: 'success', text: t(applied ? 'assemblyEnabledNow' : 'assemblyDisabledNow') });
      };

      /**
       * 「我的 Prompt」 save: `PUT /prompt-setting/overrides` with the reserved
       * name and `replace`, which is the entire write face since Revision 7
       * (§4.1). The text is sent exactly as typed — trimming someone's prompt
       * would be a silent edit of the thing they are configuring — and a
       * workspace write without a session is refused here, with the same code
       * the Host would answer, instead of being sent to be rejected.
       *
       * g-056: it is also refused while the user has unsaved text in **another**
       * scope (`mineForeignDraft`). In that state the box is showing this
       * target's *stored* text, so sending it would be the silently-successful
       * overwrite with `""` this goal exists to remove — the request is not sent
       * at all, and the notice names the scope that really holds the text.
       */
      const saveMine = async () => {
        const layer = mineLayer;
        if (layer === 'workspace' && sessionArg === null) {
          // The host would answer exactly this; refusing here keeps a known
          // answer from being turned into a round trip.
          setMineStatus({ kind: 'error', error: { code: 'workspace-unresolved' } });
          setNotice({ tone: 'error', text: errorText(t, { code: 'workspace-unresolved' }) });
          return;
        }
        if (mineForeignDraft !== null) {
          setMineStatus({ kind: 'idle', error: null });
          setNotice({
            tone: 'error',
            text: fmt(t('mineSaveBlockedDraftElsewhere'), {
              scope: draftScopeNameOf(mineForeignDraft.scope),
              chars: mineForeignDraft.text.length,
            }),
          });
          return;
        }
        setMineStatus({ kind: 'saving', error: null });
        setBusy(true);
        const body = {
          layer,
          // g-058: the mode travels with the text in the same one entry — the
          // body still names one layer, so the other layer's file is not part of
          // this request at all.
          section: { name: RESERVED_SECTION_NAME, action: mineMode, text: mineText },
        };
        if (sessionArg !== null) body.session = sessionArg;
        const result = await requestJson(OVERRIDES_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy(false);
        if (!result.ok) {
          setMineWarnings([]);
          setMineStatus({ kind: 'error', error: result.error });
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        // Keep the draft: it is what was just written, so the box does not
        // flicker back to the stored value while the re-read is in flight — and
        // `baseline` records that this page really wrote exactly this text there,
        // so the kept draft is never later reported as unsaved work (R1).
        setMineDrafts((current) => ({
          ...current,
          [mineKey]: { text: mineText, mode: mineMode, scope: mineScope, baseline: mineText, baselineMode: mineMode },
        }));
        // Revision 12 (audit F2): an accepted save may still carry advisories —
        // a registered reference the probe had no value for. They are shown, not
        // dropped, and they are not an error: the write did happen.
        setMineWarnings(payloadWarnings(result.payload));
        setMineStatus({ kind: 'saved', error: null });
        // g-021: the write succeeded, so the banner stays a success banner — but
        // in a frozen scope it may not read as bare success either. The notice is
        // the most visible surface on the page, so it carries the same condition
        // the panel's state line does.
        setNotice({
          tone: 'success',
          text: fmt(
            t(
              mineFrozenReason === null
                ? 'savedNotice'
                : mineFrozenCertain
                  ? 'savedNoticeFrozen'
                  : 'savedNoticeUnknown',
            ),
            { layer: layerLabel(t, layer) },
          ),
        });
        setReload((value) => value + 1);
      };

      /**
       * g-027: 「取消」 for 「我的 Prompt」 — drop the unsaved draft so the box
       * shows the layer's already stored text again. It is deliberately not a
       * write: no request, no disk byte, and unlike 「恢复默认」 nothing that was
       * ever stored is destroyed, so it asks nothing first. Resetting the draft
       * is the whole operation: a draft belongs to one **write target**
       * (`mineKey`, g-056), so a draft typed for another key is left where it
       * is, and the state falls back to whatever the stored value says (`idle`,
       * or `unconfigured` for a layer that has none). Only reachable while the
       * panel is `dirty`, which excludes `saving` / `saved` / `error`.
       */
      const cancelMine = () => {
        dropMineDraft(mineKey);
      };

      /**
       * g-056: throw away the draft that belongs to **another** scope, so the
       * save above can go through. It is the explicit way out of the block —
       * like「取消」 it is a local state reset (no request, no byte), and it is
       * only offered beside the notice that names the scope being dropped. R2/R3:
       * it names the exact target it drops rather than clearing the store.
       */
      const dropForeignDraft = () => {
        if (mineForeignDraft === null) return;
        dropMineDraft(mineForeignDraft.key);
      };

      /**
       * 「恢复默认」 for 「我的 Prompt」: the single-name `DELETE`, which since
       * Revision 7 is exactly the reserved section. Confirmed first (§12.1): it
       * destroys text the user wrote.
       */
      const resetMine = async () => {
        const layer = mineLayer;
        setMineStatus({ kind: 'saving', error: null });
        setBusy(true);
        const query = `${layerQuery(layer, sessionArg)}&name=${encodeURIComponent(RESERVED_SECTION_NAME)}`;
        const result = await requestJson(`${OVERRIDES_PATH}?${query}`, { method: 'DELETE' });
        setBusy(false);
        if (!result.ok) {
          setMineStatus({ kind: 'error', error: result.error });
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        // R3: only **this** write target's draft goes with the value it deleted;
        // another target's unsaved text is not this operation's to destroy.
        dropMineDraft(mineKey);
        setMineStatus({ kind: 'idle', error: null });
        setNotice({
          tone: 'success',
          text: fmt(t('deletedNotice'), { layer: layerLabel(t, layer) }),
        });
        setReload((value) => value + 1);
      };

      /**
       * Clear one layer's frozen (non-reserved) overrides: `legacy=true`, which
       * keeps 「我的 Prompt」 (§12.2). The same shape as the layer reset, one
       * flag apart, so the two share this reporting path.
       */
      const clearLegacy = async (layer) => {
        setBusy(true);
        const result = await requestJson(`${OVERRIDES_PATH}?${layerQuery(layer, advancedScopeArg)}&legacy=true`, { method: 'DELETE' });
        setBusy(false);
        if (!result.ok) {
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        const count = result.payload && typeof result.payload.count === 'number' ? result.payload.count : 0;
        setNotice({
          tone: 'success',
          text: count > 0 ? fmt(t('resetDoneNotice'), { count }) : t('resetNoneNotice'),
        });
        setReload((value) => value + 1);
      };

      /**
       * Close the「查看范围」picker after a scope was actually chosen (g-016):
       * picking a row, the current session, a typed id or 「全局」 is the end of
       * that interaction, so the summary comes back without a second click. It
       * is deliberately *not* called by the search box, the group headers or
       * 「显示更多」 — those browse the picker, they do not finish with it.
       */
      /**
       * g-043: read the stored「下载区域」— and, on the first visit ever, let the
       * Host decide it by availability. One `GET`; a failure leaves the previous
       * answer alone and says nothing (this is a read-out, not a task).
       *
       * The Host's answer is copied into the view state field by field, so
       * nothing on screen is invented here: an unknown region id reads as
       *「默认」, a non-string address as「no address」, `detected` only as the
       * Host's own boolean.
       */
      const loadRegion = async () => {
        const result = await requestJson(DOWNLOAD_REGION_PATH);
        if (!result.ok) {
          setUpdate((current) => ({ ...current, region: { ...(current.region ?? {}), phase: 'error' } }));
          return;
        }
        setUpdate((current) => ({ ...current, region: regionStateOf(result.payload) }));
      };

      /**
       * g-043: send one region choice and fold the Host's answer back into the
       * card. Returns the transport result so the dialog can decide whether to
       * close: `ok:true` means the choice is in force *now*, and anything else
       * means nothing was written.
       *
       * A successful switch drops the previous check's fact (`data` / `check`):
       * it was an answer from the **old** source, and leaving it would let the
       * banner announce a version the new source may not even carry — the
       * 「install this」button would then install the old source's artifact while
       * the dropdown said otherwise. The re-check below refills it from the new
       * source.
       */
      const saveRegion = async (body) => {
        const previous = update.region !== null && update.region !== undefined && update.region.phase === 'error' ? 'error' : 'ready';
        setUpdate((current) => ({ ...current, region: { ...(current.region ?? {}), phase: 'saving' } }));
        setBusy(true);
        const result = await requestJson(DOWNLOAD_REGION_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy(false);
        if (!result.ok) {
          // Nothing was written: the control must keep showing the source that is
          // actually in force, and the region's phase returns to what it was.
          setUpdate((current) => ({ ...current, region: { ...(current.region ?? {}), phase: previous } }));
          return result;
        }
        setUpdate((current) => ({ ...current, region: regionStateOf(result.payload), data: null, check: null, dismissed: false }));
        if (update.enabled !== false) await recheckUpdate();
        return result;
      };

      /**
       * g-043: the dropdown's own `change`. `default` / `cn` are saved straight
       * away — there is nothing to type and nothing to validate. `custom` only
       * **opens the dialog**: the address is not a choice the dropdown can
       * express, and saving the word「自定义」without an address would leave the
       * npm path unusable.
       */
      const setDownloadRegion = async (event) => {
        const wanted = event && event.target ? String(event.target.value) : '';
        if (wanted === 'custom') {
          setRegionDialog({
            value:
              update.region !== null && update.region !== undefined && typeof update.region.custom === 'string'
                ? update.region.custom
                : '',
            error: null,
            phase: 'idle',
          });
          return;
        }
        if (wanted !== 'default' && wanted !== 'cn') return;
        const result = await saveRegion({ region: wanted });
        if (result.ok) {
          setNotice({ tone: 'success', text: fmt(t('updateRegionSaved'), { region: t(regionKey(wanted, '')) }) });
          return;
        }
        setNotice({ tone: 'error', text: errorText(t, result.error) });
      };

      /** g-043: the dialog's field. Typing clears the red line. */
      const setRegionCustomValue = (event) => {
        const value = event && event.target ? String(event.target.value) : '';
        setRegionDialog((current) => (current === null ? null : { ...current, value, error: null }));
      };

      /** g-043: close the dialog without writing anything. */
      const cancelRegionCustom = () => setRegionDialog(null);

      /**
       * g-043: submit the typed address. The Host validates **before** it writes,
       * so:
       *   - `ok:true` ⇒ the dialog closes and the new source is already in force;
       *   - `ok:false` ⇒ the dialog **stays open** with the Host's code rendered
       *     as a red line inside it, and the saved value is untouched. The page
       *     notice is deliberately *not* used: it renders behind the overlay.
       * A transport failure (no answer at all) is the same red line with the
       * page's own network copy.
       */
      const submitRegionCustom = async () => {
        const dialog = regionDialog;
        if (dialog === null) return;
        const address = String(dialog.value ?? '').trim();
        setRegionDialog((current) => (current === null ? null : { ...current, phase: 'saving', error: null }));
        const result = await saveRegion({ region: 'custom', registry: address });
        if (result.ok) {
          setRegionDialog(null);
          setNotice({ tone: 'success', text: fmt(t('updateRegionSaved'), { region: t(regionKey('custom', '')) }) });
          return;
        }
        setRegionDialog((current) => (current === null ? null : { ...current, phase: 'idle', error: result.error }));
      };

      /**
       * g-030: run the update check again, bypassing the Host's six-hour cache
       * (`?force=1`). The button that calls this is only rendered while the
       * switch is on, so "check now" can never be the thing that re-enables a
       * feature the user turned off.
       *
       * A failure is silent on the main page (this is a background question, not
       * a task the user asked for). Inside 「高级」 the card distinguishes the two
       * cases it can be in: a **failed** check leaves the last successful answer
       * (or nothing) on screen, while a **successful** `hasUpdate:null` gets the
       * plain-language explanation that upstream had nothing to compare against
       * (`renderUpdateSetting`, in the 「高级」 chunk `client.advanced.js`).
       */
      const recheckUpdate = async () => {
        setUpdate((current) => ({ ...current, phase: 'checking' }));
        const result = await requestJson(`${UPDATE_CHECK_PATH}?force=1`);
        if (!result.ok) {
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

      /**
       * g-030: open or close the upstream update check.
       *
       * The value sent is the negation of the state the Host last reported, so
       * one click always produces the state the label promised. Turning it **on**
       * runs one immediate check (there is nothing to show otherwise, and the
       * user just asked for it); turning it **off** writes the preference and
       * stops — no further request is made by this page for the rest of the
       * session, and the next mount skips the round trip entirely through the
       * local mirror.
       */
      const toggleUpdate = async () => {
        const next = update.enabled === false;
        setUpdate((current) => ({ ...current, phase: 'saving' }));
        setBusy(true);
        const result = await requestJson(UPDATE_CHECK_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        });
        setBusy(false);
        if (!result.ok) {
          setUpdate((current) => ({ ...current, phase: 'error' }));
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        const enabled = result.payload && result.payload.enabled === false ? false : true;
        writeUpdatePref(enabled);
        // The switch changed, so the previous check's fact is stale: it is
        // dropped, and turning the switch on immediately asks again below. The
        // g-032 install state is **kept**: a switch flip is not an install, and
        // forgetting a running one would strand it with no cancel button.
        setUpdate((current) => ({ ...current, enabled, data: null, check: null, dismissed: false, phase: 'ready' }));
        setNotice({
          tone: 'success',
          text: fmt(t('updateToggleSaved'), { state: t(enabled ? 'updateSettingOn' : 'updateSettingOff') }),
        });
        if (enabled) {
          // g-043: a mount that ran while the switch was off asked the region
          // nothing at all (the zero-request promise), so the first thing the
          // switch being turned back on has to fetch is the region — which is
          // also where the first-visit availability detection happens.
          if (update.region === null || update.region === undefined) await loadRegion();
          await recheckUpdate();
        }
      };

      /**
       * g-032:「立即更新」— the three actions the banner and 「高级」 share.
       *
       * The install is the **host's** work: this page starts it, polls it and can
       * cancel it, and it never fakes a phase locally. Everything on screen comes
       * from `GET /update-apply`, which is the only record that survives the
       * official manager deleting a settled request.
       */

      /** Where one install's request id is remembered across a page reload. */
      const UPDATE_APPLY_STORE_KEY = 'dsh-prompt-setting.updateApply';
      /** How long a remembered id is still worth resuming. */
      const UPDATE_APPLY_RESUME_MS = 30 * 60 * 1000;

      /**
       * The two helpers behind the reload-resume, defined before their readers.
       *
       * `sessionStorage` (not `localStorage`) on purpose: this is one tab's
       * in-flight work, and a second tab opened later must not adopt it. Both
       * sides are best-effort — a browser that refuses storage loses the resume,
       * never the install, which the **host** is running either way.
       */
      const rememberApply = (requestId, startedAt) => {
        try {
          if (typeof sessionStorage === 'undefined' || sessionStorage === null) return;
          if (requestId === null) sessionStorage.removeItem(UPDATE_APPLY_STORE_KEY);
          else sessionStorage.setItem(UPDATE_APPLY_STORE_KEY, JSON.stringify({ requestId, at: startedAt ?? Date.now() }));
        } catch {
          // A browser that refuses storage only loses the reload-resume.
        }
      };

      /** Read back the remembered install, if it is recent enough to be one. */
      const recalledApply = () => {
        try {
          if (typeof sessionStorage === 'undefined' || sessionStorage === null) return null;
          const raw = sessionStorage.getItem(UPDATE_APPLY_STORE_KEY);
          if (typeof raw !== 'string' || raw.length === 0) return null;
          const parsed = JSON.parse(raw);
          const requestId = parsed !== null && typeof parsed.requestId === 'string' ? parsed.requestId : null;
          const at = Number.isFinite(parsed?.at) ? parsed.at : 0;
          if (requestId === null || Date.now() - at > UPDATE_APPLY_RESUME_MS) return null;
          return { requestId, at };
        } catch {
          return null;
        }
      };

      /**
       * Resume an install that was already running when this page mounted.
       *
       * This is why the host tracks its own request table and answers a bare
       * `GET`: the official manager deletes a settled request, and a page that
       * was reloaded mid-install has no id in memory. The remembered id is tried
       * first (it is exact), then the host's own oldest live request — the one
       * request that can only name an install this mount started.
       *
       * Runs once per mount, deliberately: its own polling must not be restarted
       * by the state it writes.
       */
      React.useEffect(() => {
        let cancelled = false;
        const resume = async () => {
          const remembered = recalledApply();
          let status = null;
          if (remembered !== null) {
            const result = await requestJson(`${UPDATE_APPLY_PATH}?requestId=${encodeURIComponent(remembered.requestId)}`);
            if (cancelled) return;
            status = result.ok ? result.payload.status ?? null : null;
            if (status === null || status.status !== 'running') {
              // The remembered id settled (or is gone). The host's **bare** `GET`
              // only ever names a *running* install, so it can add a fact here —
              // it can never replace one: a remembered `done`
              // (`restart-required`) must survive the `null` this probe answers,
              // or the page would drop「已安装 vX.Y.Z，请手动重启」and offer the
              // update button again for a version that is already installed.
              const live = await requestJson(UPDATE_APPLY_PATH);
              if (cancelled) return;
              const fresh = live.ok ? live.payload.status ?? null : null;
              status = fresh ?? status;
            }
          } else {
            const live = await requestJson(UPDATE_APPLY_PATH);
            if (cancelled) return;
            status = live.ok ? live.payload.status ?? null : null;
          }
          if (cancelled || status === null || status.status !== 'running') {
            if (!cancelled && status !== null && status.status !== 'running') {
              setUpdate((current) => ({ ...current, apply: status, applyElapsed: null }));
            }
            return;
          }
          const startedAt = Date.now();
          rememberApply(status.requestId, startedAt);
          setUpdate((current) => ({ ...current, apply: status, applyElapsed: 0, applyStartedAt: startedAt }));
          await pollApply(status.requestId, startedAt);
        };
        void resume();
        return () => {
          cancelled = true;
        };
      }, []);

      /** The elapsed-time ticker, so「已用时」is a fact rather than a decoration. */
      React.useEffect(() => {
        const startedAt = update.applyStartedAt;
        if (!Number.isFinite(startedAt)) return undefined;
        const timer = setInterval(() => setUpdate((current) => ({ ...current, applyElapsed: Date.now() - startedAt })), 1000);
        return () => clearInterval(timer);
      }, [update.applyStartedAt]);

      /**
       * Poll one install until it settles.
       *
       * The loop is bounded twice — the host's own worst case (a lock wait plus
       * pnpm's silence timeout) and a hard budget — so a tab cannot poll forever
       * after the host went away. A 「not known any more」 answer is a real ending,
       * not a reason to keep asking: the copy says what it means.
       *
       * `cancelled` is a local flag rather than a React state read, because this
       * function is captured by a promise that outlives the render that started
       * it.
       */
      const pollApply = async (requestId, startedAt) => {
        let delay = UPDATE_APPLY_POLL_MS;
        while (Date.now() - startedAt < UPDATE_APPLY_POLL_BUDGET_MS) {
          const result = await requestJson(`${UPDATE_APPLY_PATH}?requestId=${encodeURIComponent(requestId)}`);
          if (!result.ok) {
            setUpdate((current) => ({
              ...current,
              apply: { status: 'failed', phase: 'failed', error: result.error ?? {} },
            }));
            rememberApply(null);
            return;
          }
          const status = result.payload.status ?? null;
          if (status === null) {
            setUpdate((current) => ({ ...current, apply: { status: 'unknown', phase: 'unknown' } }));
            rememberApply(null);
            return;
          }
          setUpdate((current) => ({
            ...current,
            apply: status,
            applyElapsed: Date.now() - startedAt,
          }));
          if (status.status !== 'running') {
            rememberApply(null);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(Math.round(delay * 1.4), UPDATE_APPLY_POLL_MAX_MS);
        }
        // The budget ran out with the host still reporting "running": stop
        // asking, and say so rather than pretending to know.
        setUpdate((current) => ({ ...current, apply: { status: 'unknown', phase: 'unknown' } }));
        rememberApply(null);
      };

      /**
       * Start one install. Never awaited by a click handler for longer than the
       * host's own start route — that route answers with a `requestId` before the
       * package manager runs, which is the whole reason it exists.
       */
      const startUpdateApply = async (latest, latestTag) => {
        setBusy(true);
        setNotice(null);
        const result = await requestJson(UPDATE_APPLY_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(latestTag === null || latestTag === undefined ? {} : { tag: latestTag }),
        });
        setBusy(false);
        if (!result.ok) {
          // A structured refusal (`no update`, a `link:` profile, no plugin
          // manager) arrives here, because this page's transport treats a body
          // whose `ok` is not `true` as the failure it is. The **host's own
          // sentence** is what the user needs; `errorText` falls back to it
          // rather than to the code, so nothing renders as
          // `error.development-link`.
          const failure = result.error ?? {};
          const reason = typeof failure.message === 'string' && failure.message.length > 0 ? failure.message : null;
          setNotice({ tone: 'error', text: reason ?? errorText(t, failure) });
          setUpdate((current) => ({
            ...current,
            apply: {
              status: 'failed',
              phase: 'failed',
              requestId: current.apply === null ? null : current.apply.requestId,
              version: current.apply === null ? null : current.apply.version,
              tag: current.apply === null ? null : current.apply.tag,
              error: { code: failure.code ?? null, message: reason, manual: failure.manual },
            },
          }));
          return;
        }
        const status = result.payload.status ?? null;
        const requestId = status === null ? null : status.requestId;
        if (result.payload.reused === true) setNotice({ tone: 'info', text: t('updateApplyReused') });
        // The profile already held exactly this artifact, so the host answered a
        // finished `restart-required` without calling the package manager at all.
        // There is nothing to poll and nothing to wait for: saying so and showing
        // the install state is the whole response (a real desktop run turned this
        // case into 「安装失败」 before, because `pnpm add` on an unchanged
        // dependency makes the manager throw `ambiguous-install`).
        if (result.payload.alreadyInstalled === true) {
          setUpdate((current) => ({ ...current, apply: status, applyElapsed: null }));
          const version = status !== null && typeof status.version === 'string' ? status.version : '';
          setNotice({ tone: 'success', text: fmt(t(updateApplyCopyKey('already', normalizeLaunchKind(boot.launchKind))), { version }) });
          return;
        }
        if (requestId === null || requestId === undefined) {
          setUpdate((current) => ({ ...current, apply: { status: 'unknown', phase: 'unknown' } }));
          return;
        }
        const startedAt = Date.now();
        rememberApply(requestId, startedAt);
        setUpdate((current) => ({ ...current, apply: status, applyElapsed: 0, applyStartedAt: startedAt }));
        await pollApply(requestId, startedAt);
      };

      /**
       * The confirmation the button opens; the install itself runs on confirm.
       *
       * `latest` is **display only** (the modal names the version). The tag that
       * is actually installed is re-read from the current check when the
       * confirmation is accepted, so a stale click cannot install a version the
       * banner no longer names — which is why no tag is passed through here.
       */
      const requestUpdateApply = (latest) => setConfirm({ kind: 'update-apply', latest });

      /** Confirm: start it, using the version the check reported. */
      const confirmUpdateApply = async () => {
        const data = update.data;
        const latest = data !== null && typeof data.latest === 'string' ? data.latest : null;
        if (latest === null) {
          setNotice({ tone: 'error', text: t(updateApplyCopyKey('unknownState', normalizeLaunchKind(boot.launchKind))) });
          return;
        }
        await startUpdateApply(latest, data.latestTag ?? null);
      };

      /** Cancel: ask the host, which forwards it to the plugin manager. */
      const cancelUpdateApply = async () => {
        const apply = update.apply ?? null;
        const requestId = apply === null ? null : apply.requestId;
        if (requestId === null || requestId === undefined) return;
        setUpdate((current) => ({
          ...current,
          apply: current.apply === null ? null : { ...current.apply, phase: 'cancelling' },
        }));
        const result = await requestJson(UPDATE_APPLY_CANCEL_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId }),
        });
        if (!result.ok || result.payload.ok !== true) {
          // The poll is the source of truth and will report whatever really
          // happened; a refused cancel says so on the notice line.
          setNotice({ tone: 'error', text: errorText(t, result.error) || (result.payload && result.payload.code) || t(updateApplyCopyKey('unknownState', normalizeLaunchKind(boot.launchKind))) });
        }
      };

      /** Retry a failed install: same confirm, same route, new request id. */
      const retryUpdateApply = async () => {
        setUpdate((current) => ({ ...current, apply: null, applyElapsed: null, applyStartedAt: null }));
        await confirmUpdateApply();
      };

      const closeScope = () => setScopeOpen(false);

      /**
       * g-058 (Revision 36): write one of the editor's two facts into this
       * target's draft, leaving the other as it was.
       *
       * Both editors — the text box and the「覆盖 / 叠加」control — produce the
       * same draft shape (`{text, mode, scope, baseline, baselineMode}`), and
       * neither may erase the other's edit: typing must not reset the mode to
       * the stored one, and choosing a mode must not blank the text. The
       * fallback for whichever field the patch omits is **what the box is
       * showing now** — the existing draft when there is one, this target's
       * stored value otherwise — so a mode switch on an untouched box produces a
       * draft that differs from the file in exactly one field.
       *
       * `baseline`/`baselineMode` record what this page last **wrote** to this
       * target and are carried across edits (g-056 R1).
       * @param patch - `{text?}` or `{mode?}`.
       */
      const updateMineDraft = (patch) => {
        setMineDrafts((current) => {
          const existing = current[mineKey] ?? null;
          const text = patch.text !== undefined
            ? patch.text
            : existing === null
              ? (mineStored === null ? '' : mineStored)
              : existing.text;
          const mode = patch.mode !== undefined
            ? patch.mode
            : existing === null
              ? (mineStoredMode ?? RESERVED_SECTION_DEFAULT_MODE)
              : draftModeOf(existing);
          return {
            ...current,
            [mineKey]: {
              text,
              mode,
              scope: mineScope,
              baseline: existing === null ? null : existing.baseline ?? null,
              baselineMode: existing === null ? null : existing.baselineMode ?? null,
            },
          };
        });
      };

      /**
       * g-060 (Revision 37): the preset library's writes.
       *
       * Five actions, and the split is exactly the host's (`CONTRACT.md` §20):
       * three go to the catalogue (`PUT` / `DELETE`, plus the `GET` a refresh
       * re-runs) and two to the layer (`apply` / `unapply`). The catalogue
       * actions never name a layer; the two layer actions always send the
       * `session` of the picked workspace, because that is the only identity the
       * host can resolve a workspace root from (§4.2).
       *
       * Every write goes through `requestJson`, so a refusal arrives as
       * `{ok: false, code, message}` and is rendered by the same
       * `errorText` mapping the rest of the page uses. A write that succeeds
       * bumps `reload`, which re-reads the library and both layer views — the
       * same "write, then re-read" shape every other write on this page has.
       */
      const savePresetDraft = async () => {
        const name = presetDraft.name.trim();
        if (name.length === 0) {
          // The host would answer exactly this; refusing here keeps a known
          // answer from being turned into a round trip. The refusal stays **in
          // the dialog** (review R3): the editor's own error line, never the
          // page notice, which would sit behind the overlay.
          setPresetStatus({ kind: 'error', error: { code: 'invalid-name' } });
          return;
        }
        setPresetStatus({ kind: 'saving', error: null });
        setBusy(true);
        const body = { name: presetDraft.name, action: presetDraft.action, text: presetDraft.text };
        // An `id` is what makes this an edit rather than an insert; without one
        // the host mints the id (§20.3).
        if (presetDraft.id !== null) body.id = presetDraft.id;
        const result = await requestJson(PRESETS_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy(false);
        if (!result.ok) {
          // A refused save leaves the dialog **open** with the reason on its own
          // line: closing it would throw the draft away and hide why.
          setPresetStatus({ kind: 'error', error: result.error });
          return;
        }
        const preset = result.payload && result.payload.preset ? result.payload.preset : null;
        // Keep the written entry as the editor's draft (so a re-open starts from
        // what the library now holds), and close the dialog: the save is done,
        // and the refreshed list is what the reader came back for.
        if (preset !== null) {
          setPresetDraft({
            id: preset.id,
            name: typeof preset.name === 'string' ? preset.name : '',
            action: preset.action === 'append' ? 'append' : 'replace',
            text: typeof preset.text === 'string' ? preset.text : '',
          });
        }
        setPresetStatus({ kind: 'saved', error: null });
        setPresetDialog(null);
        setNotice({ tone: 'success', text: t('presetSavedNotice') });
        setReload((value) => value + 1);
      };

      const deletePreset = async (id) => {
        setPresetStatus({ kind: 'saving', error: null });
        setBusy(true);
        const result = await requestJson(`${PRESETS_PATH}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        setBusy(false);
        if (!result.ok) {
          setPresetStatus({ kind: 'error', error: result.error });
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        // The editor must not keep pointing at an entry that is gone: it would
        // send its id on the next save and be answered `404 preset-not-found`.
        // An open dialog on that entry closes with it (review R3): its subject
        // no longer exists. (Checked before the draft is cleared, so the editor
        // dialog is recognised by the id it was opened on.)
        if (presetDialog !== null && (presetDialog.kind === 'apply' ? presetDialog.presetId === id : presetDraft.id === id)) {
          setPresetDialog(null);
        }
        if (presetDraft.id === id) setPresetDraft({ id: null, name: '', action: 'replace', text: '' });
        setPresetStatus({ kind: 'saved', error: null });
        const restored = result.payload && typeof result.payload.restoredWorkspaces === 'number'
          ? result.payload.restoredWorkspaces
          : 0;
        setNotice({
          tone: 'success',
          text: fmt(t(restored > 0 ? 'presetDeletedRestoredNotice' : 'presetDeletedNotice'), { count: restored }),
        });
        setReload((value) => value + 1);
      };

      const applyPreset = async (presetId, session) => {
        if (typeof presetId !== 'string' || presetId.length === 0) return;
        if (typeof session !== 'string' || session.length === 0) {
          // Review R3: the refusal is rendered **inside the apply dialog**, which
          // is where the reader is looking — a page notice would sit behind the
          // scrim and read as "nothing happened".
          setPresetStatus({ kind: 'error', error: { code: 'workspace-unresolved' } });
          return;
        }
        setPresetStatus({ kind: 'saving', error: null });
        setBusy(true);
        const result = await requestJson(PRESETS_APPLY_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ presetId, session }),
        });
        setBusy(false);
        if (!result.ok) {
          setPresetStatus({ kind: 'error', error: result.error });
          return;
        }
        setPresetStatus({ kind: 'saved', error: null });
        // Revision 39: an application the layer already carried wrote nothing, so
        // it must not read as an ordinary「已应用」— the page says what really
        // happened.
        setNotice({
          tone: 'success',
          text: t(result.payload.alreadyApplied === true ? 'presetAlreadyAppliedNotice' : 'presetAppliedNotice'),
        });
        setReload((value) => value + 1);
      };

      const unapplyPreset = async (session, presetId) => {
        if (typeof session !== 'string' || session.length === 0) {
          setPresetStatus({ kind: 'error', error: { code: 'workspace-unresolved' } });
          return;
        }
        // Revision 41: cancelling names the preset to take off the stack — a
        // workspace may hold several, and「取消应用」is per application now.
        if (typeof presetId !== 'string' || presetId.length === 0) {
          setPresetStatus({ kind: 'error', error: { code: 'missing-preset-id' } });
          return;
        }
        setPresetStatus({ kind: 'saving', error: null });
        setBusy(true);
        const result = await requestJson(PRESETS_UNAPPLY_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session, presetId }),
        });
        setBusy(false);
        if (!result.ok) {
          setPresetStatus({ kind: 'error', error: result.error });
          return;
        }
        setPresetStatus({ kind: 'saved', error: null });
        setNotice({ tone: 'success', text: t('presetUnappliedNotice') });
        setReload((value) => value + 1);
      };

      /**
       * g-060: the workspaces the two layer actions can name.
       *
       * The host has no workspace-list route, so the picker offers what this page
       * already holds: one row per workspace from the workspace seat, each
       * carrying its first session id — the identity `apply`/`unapply` need to
       * resolve a root (`CONTRACT.md` §4.2). A profile without that seat degrades
       * to the session list, exactly as the version history's scope picker does
       * (g-038), and a row whose root is unknown simply states no applied state
       * rather than guessing one.
       */
      const presetWorkspaces = workspaceRows(wsSeat, seat, { withRoot: true });
      /**
       * g-060 (review R1, re-pointed by R3): does the editor hold an **unsaved**
       * change?
       *
       * `POST /presets/apply` names a preset by **id** and the host reads that
       * preset out of the library, so an unsaved edit can never be what a layer
       * write stores — the apply dialog says so in words, and the editor dialog
       * never lets the draft disappear silently.
       *
       * `presetDirty` covers the *stored* case (the draft names an entry and
       * differs from it, or names one the library no longer has — a `404` this
       * page must not dress up as a save); `presetDraftDirty` is the wider
       * question the **close** control asks, and it also covers a brand-new
       * draft with anything typed into it, which has no stored counterpart to
       * compare against.
       * @returns whether the editor differs from the stored preset it names.
       */
      const presetSavedEntry = presetDraft.id === null
        ? null
        : (presets.data && Array.isArray(presets.data.presets) ? presets.data.presets : [])
          .find((entry) => entry.id === presetDraft.id) ?? null;
      const presetDirty = presetDraft.id !== null
        && (presetSavedEntry === null
          || presetSavedEntry.name !== presetDraft.name
          || (presetSavedEntry.action === 'append' ? 'append' : RESERVED_SECTION_DEFAULT_MODE) !== presetDraft.action
          || (typeof presetSavedEntry.text === 'string' ? presetSavedEntry.text : '') !== presetDraft.text);
      /** Whether closing the editor dialog would throw work away. */
      const presetDraftDirty = presetDraft.id === null
        ? presetDraft.name.trim().length > 0 || presetDraft.text.length > 0
        : presetDirty;

      const actions = {
        refresh: () => setReload((value) => value + 1),
        // The「更改」switch: the same button opens and shuts the picker, and
        // `aria-expanded` on it reports which state it is in.
        toggleScopeOpen: () => setScopeOpen((open) => !open),
        setTab,
        setView,
        setMineLayer: (value) => {
          setMineLayer(value === 'workspace' ? 'workspace' : 'user');
          setMineWarnings([]);
          setMineStatus({ kind: 'idle', error: null });
        },
        setMineText: (event) => {
          const value = event && event.target ? String(event.target.value) : '';
          // g-056: the draft carries its own scope, so the box can say whose text
          // it holds after the「查看范围」moved on — and R2: the entry is written
          // into a map keyed by write target, so typing here cannot destroy the
          // draft another target is holding. g-058: the mode it was typed under
          // survives the edit (see `updateMineDraft`).
          updateMineDraft({ text: value });
          setMineWarnings([]);
          setMineStatus({ kind: 'idle', error: null });
        },
        // g-058 (Revision 36): the「覆盖 / 叠加」choice. It is view state until
        // 「保存」 — the file is written by `saveMine` alone, with one layer and
        // one entry — so switching the mode back and forth never touches a disk.
        setMineMode: (value) => {
          updateMineDraft({ mode: value === 'append' ? 'append' : RESERVED_SECTION_DEFAULT_MODE });
          setMineWarnings([]);
          setMineStatus({ kind: 'idle', error: null });
        },
        saveMine,
        cancelMine,
        dropForeignDraft,
        toggleMineInterpolate,
        setMineInterpolateState,
        // g-062: the assembly-status notice's own switch (page-only feature).
        toggleAssemblyNotice,
        // g-060:「预设」— the catalogue editor, the two layer actions, and the
        // workspace they name. Everything here is view state until a click on
        // 「保存」/「应用」/「取消应用」, which are the only three controls that write.
        setPresetName: (event) => {
          const value = event && event.target ? String(event.target.value) : '';
          setPresetDraft((current) => ({ ...current, name: value }));
          setPresetStatus({ kind: 'idle', error: null });
        },
        setPresetText: (event) => {
          const value = event && event.target ? String(event.target.value) : '';
          setPresetDraft((current) => ({ ...current, text: value }));
          setPresetStatus({ kind: 'idle', error: null });
        },
        setPresetAction: (value) => {
          setPresetDraft((current) => ({
            ...current,
            action: value === 'append' ? 'append' : RESERVED_SECTION_DEFAULT_MODE,
          }));
          setPresetStatus({ kind: 'idle', error: null });
        },
        // Review R3: 「新建」/「编辑」 both **open the editor dialog** and put the
        // draft behind it. Nothing is written until a click on 「保存」, and the
        // dialog is the only surface those fields exist on.
        newPreset: () => {
          setPresetDraft({ id: null, name: '', action: RESERVED_SECTION_DEFAULT_MODE, text: '' });
          setPresetStatus({ kind: 'idle', error: null });
          setPresetDialog({ kind: 'edit' });
        },
        editPreset: (id) => {
          const list = presets.data && Array.isArray(presets.data.presets) ? presets.data.presets : [];
          const preset = list.find((entry) => entry.id === id) ?? null;
          if (preset === null) return;
          setPresetDraft({
            id: preset.id,
            name: typeof preset.name === 'string' ? preset.name : '',
            action: preset.action === 'append' ? 'append' : RESERVED_SECTION_DEFAULT_MODE,
            text: typeof preset.text === 'string' ? preset.text : '',
          });
          setPresetStatus({ kind: 'idle', error: null });
          setPresetDialog({ kind: 'edit' });
        },
        // 「从当前文本另存为预设」: it starts a **new** preset from the text the
        // 「我的 Prompt」 panel is showing and writes nothing — the name and the
        // save are still the user's to give (§20.9).
        saveAsCurrentPreset: () => {
          setPresetDraft({ id: null, name: '', action: RESERVED_SECTION_DEFAULT_MODE, text: mineText });
          setPresetStatus({ kind: 'idle', error: null });
          setPresetDialog({ kind: 'edit' });
        },
        // The apply dialog is opened **from a list row**, so the preset it acts
        // on is the row's own id — never "whatever the editor happens to hold"
        // (review R3), which is also why an unsaved draft cannot be applied by
        // accident: the dialog names a stored preset and says so in words.
        requestPresetApplyTo: (id) => {
          if (typeof id !== 'string' || id.length === 0) return;
          setPresetStatus({ kind: 'idle', error: null });
          setPresetDialog({ kind: 'apply', presetId: id });
        },
        closePresetDialog: () => {
          setPresetDialog(null);
          setPresetStatus({ kind: 'idle', error: null });
        },
        // Review R4: the close control of the **editor** asks first when the
        // draft is dirty — through the page's one confirmation overlay, not a
        // bespoke dialog — so throwing typing away is an answered question.
        // Everything else (a clean draft, the apply dialog) closes directly: a
        // confirmation for a no-op is noise.
        requestPresetDialogClose: () => {
          if (presetDialog !== null && presetDialog.kind === 'edit' && presetDraftDirty === true) {
            setConfirm({ kind: 'preset-discard' });
            return;
          }
          setPresetDialog(null);
          setPresetStatus({ kind: 'idle', error: null });
        },
        savePreset: () => {
          void savePresetDraft();
        },
        // Review R4: the row's「删除」only *asks*. The DELETE happens through
        // `confirmYes`, like every other destructive act on this page.
        requestPresetDelete: (id) => {
          const list = presets.data && Array.isArray(presets.data.presets) ? presets.data.presets : [];
          const preset = list.find((entry) => entry.id === id) ?? null;
          if (preset === null) return;
          // Revision 50 (g-069): the question must state what the deletion really
          // does. Every workspace whose record holds this preset is about to have
          // its layer restored, so the confirmation lists them — a count plus an
          // identifiable label (the page's own workspace label when it has one,
          // the root otherwise) — instead of promising that nothing is touched.
          const applied = presets.data && Array.isArray(presets.data.applied) ? presets.data.applied : [];
          const restorable = applied
            .filter((record) => Array.isArray(record.stack) && record.stack.some((link) => link.presetId === id))
            .map((record) => {
              const row = presetWorkspaces.find((entry) => entry.root === record.workspaceRoot) ?? null;
              const label = row === null || typeof row.label !== 'string' || row.label.length === 0
                ? record.workspaceRoot
                : row.label;
              return { root: record.workspaceRoot, label };
            });
          setConfirm({ kind: 'preset-delete', id, name: preset.name, workspaces: restorable });
        },
        deletePreset: (id) => {
          void deletePreset(id);
        },
        applyPreset: (presetId, session) => {
          void applyPreset(presetId, session);
        },
        unapplyPreset: (session, presetId) => {
          void unapplyPreset(session, presetId);
        },
        loadPresets: () => setReload((value) => value + 1),
        // g-030: the update banner's dismissal and the switch in 「高级」.
        dismissUpdate: () => setUpdate((current) => ({ ...current, dismissed: true })),
        toggleUpdate,
        recheckUpdate,
        // g-043:「下载区域」 — the dropdown, and the「自定义」dialog behind it.
        setDownloadRegion,
        setRegionCustomValue,
        submitRegionCustom,
        cancelRegionCustom,
        // g-032:「立即更新」— open the confirmation, start it, cancel it, retry it.
        requestUpdateApply,
        cancelUpdateApply,
        retryUpdateApply,
        requestMineReset: () => setConfirm({ kind: 'mine-reset', layer: mineLayer }),
        setAdvancedLayer: (value) => setAdvancedLayer(value === 'workspace' ? 'workspace' : 'user'),
        setSearch: (event) => setSearch(event && event.target ? String(event.target.value) : ''),
        setManualId: (event) => setManualId(event && event.target ? String(event.target.value) : ''),
        setSessionQuery: (event) => {
          setSessionQuery(event && event.target ? String(event.target.value) : '');
          setSessionActive(-1);
        },
        // Expansion is local view state, keyed by the sidebar's own group key
        // (the workspace id, or '' for the ungrouped bucket). The effective
        // state is passed in, so the toggle is exact even when a search forced
        // a group open.
        toggleScope: (key, open) => setScopeExpanded((current) => ({ ...current, [key]: open })),
        // Keyboard parity for the pointer toggle: Enter and Space both flip the
        // workspace node, exactly like the sidebar's own tree rows.
        onScopeHeaderKeyDown: (event, key, open) => {
          const pressed = event && event.key ? String(event.key) : '';
          if (pressed !== 'Enter' && pressed !== ' ' && pressed !== 'Spacebar') return;
          if (typeof event.preventDefault === 'function') event.preventDefault();
          setScopeExpanded((current) => ({ ...current, [key]: open }));
        },
        setScopeHover,
        setScopeFocus,
        showMoreScope: (key) =>
          setScopeLimits((current) => {
            const value = Number.isInteger(current[key]) ? current[key] : SCOPE_GROUP_PAGE;
            return { ...current, [key]: Math.min(SCOPE_GROUP_MAX, value + SCOPE_GROUP_STEP) };
          }),
        pickSession: (id) => {
          setSelection(id);
          // g-047: the box holds the user's own words. Picking a row moves the
          // selection and nothing else — the query keeps filtering the list, and
          // 「当前选中」 is shown by the summary, the `session-current` line and
          // the pinned entry, not by overwriting what the user typed.
          setSessionActive(-1);
          closeScope();
        },
        useCurrent: () => {
          if (seat.currentId.length === 0) return;
          setSelection(seat.currentId);
          // g-047: same rule as pickSession — the search box is not a label.
          setSessionActive(-1);
          closeScope();
        },
        useTypedId: () => {
          const id = sessionQuery.trim();
          if (id.length === 0) return;
          setSelection(id);
          setSessionActive(-1);
          closeScope();
        },
        onSessionKeyDown: (event) => {
          const key = event && event.key ? String(event.key) : '';
          if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            if (sessionVisible.length === 0) return;
            setSessionActive((index) => {
              const next = key === 'ArrowDown' ? index + 1 : index - 1;
              return Math.max(0, Math.min(next, sessionVisible.length - 1));
            });
            return;
          }
          if (key === 'Enter') {
            const picked = sessionVisible[sessionActive] || sessionVisible[0];
            if (picked) {
              setSelection(picked.id);
              // g-047: as with a click, Enter moves the selection only — the
              // typed query survives, so the next Enter still resolves the row
              // it highlights instead of hunting a title as if it were an id.
              setSessionActive(-1);
              closeScope();
              return;
            }
            const typed = sessionQuery.trim();
            if (typed.length > 0) {
              setSelection(typed);
              closeScope();
            }
            return;
          }
          if (key === 'Escape') {
            setSessionQuery('');
            setSessionActive(-1);
          }
        },
        applyManual: () => {
          setSelection(manualId.trim().length > 0 ? manualId.trim() : GLOBAL_SESSION);
          closeScope();
        },
        useGlobal: () => {
          setSelection(GLOBAL_SESSION);
          setSessionQuery('');
          setSessionActive(-1);
          closeScope();
        },
        setLayerFilter: (value) => setFilters((current) => ({ ...current, layer: value })),
        setOverridableFilter: (value) => setFilters((current) => ({ ...current, overridable: value })),
        setOriginFilter: (value) => setFilters((current) => ({ ...current, origin: value })),
        setFullOrigin,
        toggleExpanded: (name) => setExpanded((current) => (current === name ? '' : name)),
        setHistoryLayer: (value) => {
          setHistoryLayer(value === 'workspace' ? 'workspace' : 'user');
          resetHistoryView();
        },
        // g-038: the version-history scope selector's own action. It is
        // deliberately not `pickSession`: this one moves no snapshot and no
        // override read, and the page's scope does not move this one.
        //
        // Picking a scope **finishes the interaction**: the picker collapses and
        // the search box is dropped, exactly like the page-level picker (§13.7).
        setHistoryScope: (value) => {
          setHistoryScope(typeof value === 'string' && value.length > 0 ? value : null);
          setHistoryScopeOpen(false);
          setHistoryScopeSearch('');
          // A different scope means a different history file: see resetHistoryView.
          resetHistoryView();
        },
        toggleHistoryScopeOpen: () => setHistoryScopeOpen((open) => !open),
        setHistoryScopeSearch: (event) =>
          setHistoryScopeSearch(event && event.target ? String(event.target.value) : ''),
        // g-073 (Revision 55): the two tab-owned scopes. Like the history scope's
        // own action, neither of these is `pickSession`: moving one moves no
        // page-scoped read and never touches `setSelection`. Picking **finishes
        // the interaction** — the disclosure collapses and the search box is
        // dropped — exactly as the page-level picker does (§13.7).
        setOverviewScope: (value) => {
          setOverviewScope(typeof value === 'string' && value.length > 0 ? value : null);
          setOverviewScopeOpen(false);
          setOverviewScopeSearch('');
        },
        toggleOverviewScopeOpen: () => setOverviewScopeOpen((open) => !open),
        setOverviewScopeSearch: (event) =>
          setOverviewScopeSearch(event && event.target ? String(event.target.value) : ''),
        setAdvancedScope: (value) => {
          setAdvancedScope(typeof value === 'string' && value.length > 0 ? value : null);
          setAdvancedScopeOpen(false);
          setAdvancedScopeSearch('');
        },
        toggleAdvancedScopeOpen: () => setAdvancedScopeOpen((open) => !open),
        setAdvancedScopeSearch: (event) =>
          setAdvancedScopeSearch(event && event.target ? String(event.target.value) : ''),
        historyPrev,
        historyNext,
        // g-039 fifth round: the preview lives in a modal, and this is what opens
        // it. It issues no request at all — the record came with the page the
        // list was rendered from — and the way out is the close button or Esc,
        // never a second click on the same record.
        previewHistoryRecord: (id) => {
          setPreviewId(String(id));
          setHistoryModal('preview');
        },
        /** Close whichever modal is open. The selection is deliberately kept. */
        closeHistoryModal: () => setHistoryModal(null),
        // The rollback button only *asks*: the write happens through the shared
        // confirmation overlay (CONTRACT §13.5), never on the click itself. How
        // many *other* sections that version overrode travels with the question,
        // so the confirmation can say they will not be restored.
        requestRollback: (id) => {
          const record = historyRecords.find((entry) => String(entry.id) === String(id)) ?? null;
          const snapshot = record !== null && Array.isArray(record.snapshot) ? record.snapshot : [];
          setConfirm({
            kind: 'rollback',
            layer: historyLayer,
            seq: Number(id),
            id: String(id),
            foreign: snapshot.filter((entry) => entry.name !== RESERVED_SECTION_NAME).length,
          });
        },
        // g-039 third round: the row itself is the primary control. The first
        // row picked becomes `from`; the second becomes `to`, and that is when
        // the comparison is requested **and its modal opens**; from the third on
        // it is a sliding window (`to` becomes `from`, the new row becomes `to`,
        // and the modal opens again on the new pair). Clicking the record already
        // holding one of the two slots steps back out of it, and `diff-clear`
        // resets both.
        pickHistoryRow: (id) => {
          const next =
            id === diffSel.from
              ? { from: null, to: null }
              : id === diffSel.to
                ? { from: diffSel.from, to: null }
                : diffSel.from === null
                  ? { from: id, to: null }
                  : diffSel.to === null
                    ? { from: diffSel.from, to: id }
                    : { from: diffSel.to, to: id };
          setDiffSel(next);
          setHistoryModal(next.from === null || next.to === null ? null : 'diff');
          void runDiff(next.from, next.to);
        },
        // The explicit way back: the same pair a reset installs (`current` is the
        // default `to`), so "cleared" and "just opened" cannot drift apart, plus
        // the request state and the modal are dropped rather than left showing a
        // result nobody is comparing any more.
        clearDiff: () => {
          setDiffSel({ from: null, to: DIFF_CURRENT });
          setDiff({ phase: 'idle', data: null, error: null });
          setHistoryModal(null);
        },
        requestResetLayer: (layer, count) => setConfirm({ kind: 'reset-layer', layer, count }),
        requestLegacyClear: (layer, count) => setConfirm({ kind: 'legacy-clear', layer, count }),
        cancelConfirm: () => setConfirm(null),
        confirmYes: async () => {
          const pending = confirm;
          if (pending === null) return;
          setConfirm(null);
          if (pending.kind === 'mine-reset') {
            await resetMine();
            return;
          }
          if (pending.kind === 'legacy-clear') {
            await clearLegacy(pending.layer);
            return;
          }
          if (pending.kind === 'reset-layer') {
            await resetLayer(pending.layer);
            return;
          }
          if (pending.kind === 'rollback') {
            await rollbackTo(pending);
            return;
          }
          if (pending.kind === 'update-apply') {
            await confirmUpdateApply();
            return;
          }
          // g-060 review R4: the two preset confirmations. Both do exactly what
          // their button said and nothing else — one DELETE, or one closed dialog
          // with the draft dropped.
          if (pending.kind === 'preset-delete') {
            await deletePreset(pending.id);
            return;
          }
          if (pending.kind === 'preset-discard') {
            setPresetDialog(null);
            setPresetStatus({ kind: 'idle', error: null });
            return;
          }
          await applyImport();
        },
        exportNow,
        setImportText: (event) => {
          setImportText(event && event.target ? String(event.target.value) : '');
          setTransfer((current) => ({ ...current, phase: 'idle', plan: null, error: null }));
        },
        setImportMode: (value) => {
          setImportMode(value === 'replace' ? 'replace' : 'merge');
          setTransfer((current) => ({ ...current, plan: null, error: null, phase: 'idle' }));
        },
        pickImportFile,
        previewImport,
        requestImportApply: () => setConfirm({ kind: 'import' }),
        copy: async () => {
          // g-073 (Revision 55): the copy buttons live in 「提示词总览」, so they
          // copy **that tab's** assembly — the one its own scope produced.
          const text =
            fullOrigin === 'all'
              ? String(overviewSnapshot && overviewSnapshot.rendered ? overviewSnapshot.rendered : '')
              : composeSections(overviewEffectiveSections, fullOrigin);
          const copied = await copyText(text);
          setNotice({ tone: copied ? 'success' : 'error', text: copied ? t('copied') : t('copyFail') });
        },
      };

      const model = {
        seat,
        wsSeat,
        scopeMode,
        scope,
        scopeOpen,
        scopeHover,
        scopeFocus,
        session,
        sessionArg,
        sessionQuery,
        sessionActive,
        sessionMatches,
        sessionVisible,
        manualId,
        tab,
        mineLayer,
        mineText,
        // g-058 (Revision 36): the mode the box is showing (`replace` | `append`)
        // and the mode this layer's file stores (`null` = the layer states none).
        // The pair is what `data-mine-mode` and `data-mine-mode-stored` report.
        mineMode,
        mineStoredMode,
        // g-056: which side of the box is being shown (`draft` | `stored`), the
        // readable scope the shown draft belongs to (or null), and the draft
        // that belongs to another scope and therefore blocks a save.
        mineTextSource: mineEntry === null ? 'stored' : 'draft',
        mineDraftScope: mineEntry === null ? null : mineEntry.scope ?? null,
        mineForeignDraft:
          mineForeignDraft === null
            ? null
            : { scope: mineForeignDraft.scope ?? null, chars: mineForeignDraft.text.length },
        mineConfigured,
        mineState,
        mineError: mineStatus.error,
        mineInterpolateOn,
        mineInterpolateStated,
        mineInterpolateState,
        mineInterpolateLocked,
        mineInterpolateStatus: mineInterpolate,
        mineWarnings,
        mineLayerDisabled,
        mineFrozenReason,
        mineFrozenCertain,
        // g-062: the assembly-status observation the「我的 Prompt」block renders —
        // the Host's answer verbatim, the switch as the Host reported it, and the
        // switch's own request state.
        assembly,
        assemblyEnabled: assembly.enabled,
        assemblyPhase: assembly.phase,
        assemblyError: assembly.error,
        assemblyStatus: assembly.status,
        // g-060: the preset tab's state slots, the open dialog, the workspace
        // list the apply dialog renders, and the text「从当前文本另存为预设」reads.
        presets,
        presetDraft,
        presetStatus,
        // `null` | `{kind:'edit'}` | `{kind:'apply', presetId}` (review R3).
        presetDialog,
        presetWorkspaces,
        // g-060 (review R1, re-pointed by R3): the draft differs from the stored
        // preset it names, and whether closing the editor would discard work.
        // The second is what the close control reads (`presetDialogDiscard`).
        presetDirty,
        presetDraftDirty,
        presetCurrentText: mineText === null || mineText === undefined ? '' : String(mineText),
        advancedLayer,
        view,
        search,
        filters,
        fullOrigin,
        expanded,
        snap,
        ovs,
        // g-073 (Revision 55):「提示词总览」's own snapshot read and its own scope.
        // The overview chunk reads these four — never `snap` / `fz` /
        // `effectiveSections` / `incoming`, which keep describing the page-scoped
        // assembly「我的 Prompt」writes to.
        overviewSnap,
        overviewSnapshot,
        overviewFz,
        overviewEffectiveSections,
        overviewIncoming,
        overviewScope,
        overviewScopeValue,
        overviewScopeName,
        overviewScopeOptions: overviewScopes.options,
        overviewScopeGroups,
        overviewScopeMode: overviewScopes.mode,
        overviewScopeOpen,
        overviewScopeSearch,
        // g-073 (Revision 55):「高级」's own workspace selector, the override read
        // it scopes, and the session its assembly record is read for.
        advancedScope,
        advancedScopeValue,
        advancedScopeName,
        advancedScopeOptions: advancedScopes.options,
        advancedScopeMatches,
        advancedScopeMode: advancedScopes.mode,
        advancedScopeOpen,
        advancedScopeSearch,
        advancedOvs,
        advancedSnap,
        advancedEffectiveSections,
        advancedIncoming,
        assemblySession: advancedScopeArg,
        notice,
        busy,
        hist,
        historyLayer,
        // g-038: the version history's own scope and its paging.
        historyScope,
        historyScopeValue,
        historyScopeName,
        historyScopeOptions: historyScopes.options,
        historyScopeMode: historyScopes.mode,
        historyScopeOpen,
        historyScopeSearch,
        historyScopeMatches,
        histPage,
        diffSel,
        diff,
        preview: previewInfo,
        historyPanel,
        historyPanelRef,
        // g-039 fifth round: `null` | `'preview'` | `'diff'` — at most one modal
        // at a time, by construction.
        historyModal,
        confirm,
        // g-043: `null` when the「自定义镜像源」dialog is closed.
        regionDialog,
        transfer,
        importText,
        importMode,
        boot,
        update,
        fz,
        effectiveSections,
        incoming,
        phase,
        passesFilters: (section) => {
          if (filters.layer !== 'all' && sectionLayer(section) !== filters.layer) return false;
          if (filters.overridable === 'yes' && section.overridable !== true) return false;
          if (filters.overridable === 'no' && section.overridable !== false) return false;
          if (filters.origin !== 'all' && originOf(section) !== filters.origin) return false;
          return true;
        },
      };

      try {
        const tree = renderSection(t, model, actions);
        // Only the primitives branch needs a boundary: the hand-built atoms are
        // this page's own code, and a render-time throw from them is a bug the
        // outer `catch` (and the failure card) already answers. The Host's atoms
        // are the ones this page cannot see through (g-063 E1).
        if (!primitivesActive()) return tree;
        return h(
          PrimitivesErrorBoundary,
          {
            // Rebuilds the same page with the hand-built atoms — the same call
            // the try above makes, so the degraded page is the real page, not a
            // placeholder. Its own throw still lands on the failure card.
            renderFallback: () => {
              try {
                return renderSection(t, model, actions);
              } catch (error) {
                return renderFailureCard(t, error);
              }
            },
          },
          tree,
        );
      } catch (error) {
        return renderFailureCard(t, error);
      }
    }

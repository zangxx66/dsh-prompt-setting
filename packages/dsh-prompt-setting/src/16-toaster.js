     * sentence. A toast that disagreed with the page it summarizes would be
     * worse than no toast at all.
     * @param t - the bound translator.
     * @param notice - one public notice.
     * @returns the localized verdict.
     */
    function assemblyVerdictOf(t, notice) {
      return notice.kind === 'first-assembly'
        ? t(notice.assembly.assembled === true ? 'assemblyFirstAssembled' : 'assemblyFirstEmpty')
        : t(notice.assembly.state === 'read' ? 'assemblyChangeRead' : 'assemblyChangeNotRead');
    }

    /**
     * The delivery layer's verdict, in words (g-062's second layer).
     *
     * "Not observable from a plugin" is part of the sentence, not a footnote: a
     * `waiting`/`unconfirmed` toast must not read as "it failed" when the truth
     * is "no `system/message` proved it".
     * @param t - the bound translator.
     * @param notice - one public notice.
     * @returns the localized verdict.
     */
    function deliveryVerdictOf(t, notice) {
      if (notice.delivery.state === 'delivered') {
        return fmt(t('assemblyDeliveryDelivered'), {
          op: t(notice.delivery.surfaceOp === 'replace' ? 'assemblyOpReplace' : 'assemblyOpAppend'),
        });
      }
      return notice.delivery.state === 'waiting' ? t('assemblyDeliveryWaiting') : t('assemblyDeliveryUnconfirmed');
    }

    /**
     * One notice as the single line a toast can carry: the key node, then both
     * layers, joined by the language's own separator.
     * @param t - the bound translator.
     * @param notice - one public notice.
     * @returns the toast text.
     */
    function composeAssemblyToastText(t, notice) {
      const join = t('assemblyToastJoin');
      const sep = t('assemblyLayerSep');
      return [
        t(notice.kind === 'first-assembly' ? 'assemblyToastFirst' : 'assemblyToastChange'),
        `${t('assemblyLayerAssembly')}${sep}${assemblyVerdictOf(t, notice)}`,
        `${t('assemblyLayerDelivery')}${sep}${deliveryVerdictOf(t, notice)}`,
      ].join(join);
    }

    /**
     * One stored cursor, read defensively.
     *
     * Three answers, like the update-switch mirror: a valid cursor, or
     * `{bootId: null, cursor: null}` for "this tab has shown nothing" — which is
     * what a missing store, a hand-edited value and a document from an older
     * shape must all produce. `null` means **start from now**, never "replay
     * everything" (a fresh tab must not toast the whole retained history).
     * @param raw - the stored string, or anything else.
     * @returns `{bootId, cursor}`.
     */
    function parseAssemblyToastCursor(raw) {
      const empty = { bootId: null, cursor: null };
      if (typeof raw !== 'string' || raw.length === 0) return empty;
      let stored = null;
      try {
        stored = JSON.parse(raw);
      } catch {
        return empty;
      }
      if (stored === null || typeof stored !== 'object') return empty;
      if (stored.v !== ASSEMBLY_TOAST_CURSOR_VERSION) return empty;
      return {
        bootId: typeof stored.bootId === 'string' && stored.bootId.length > 0 ? stored.bootId : null,
        cursor: Number.isSafeInteger(stored.cursor) && stored.cursor >= 0 ? stored.cursor : null,
      };
    }

    /**
     * The inverse of {@link parseAssemblyToastCursor}.
     * @param state - `{bootId, cursor}`.
     * @returns the string to store.
     */
    function serializeAssemblyToastCursor(state) {
      const bootId = state !== null && typeof state === 'object' && typeof state.bootId === 'string' ? state.bootId : null;
      const cursor =
        state !== null && typeof state === 'object' && Number.isSafeInteger(state.cursor) && state.cursor >= 0
          ? state.cursor
          : null;
      return JSON.stringify({ v: ASSEMBLY_TOAST_CURSOR_VERSION, bootId, cursor });
    }

    /** This tab's cursor; every failure degrades to "start from now". */
    function readAssemblyToastCursor() {
      try {
        if (typeof sessionStorage === 'undefined' || sessionStorage === null) return { bootId: null, cursor: null };
        return parseAssemblyToastCursor(sessionStorage.getItem(ASSEMBLY_TOAST_STORE_KEY));
      } catch {
        return { bootId: null, cursor: null };
      }
    }

    /**
     * Remember this tab's cursor. Best effort by design: a browser that refuses
     * storage replays at worst the notices born while the page was open — the
     * in-memory cursor still prevents a repeat within one page's lifetime.
     * @param state - `{bootId, cursor}`.
     */
    function writeAssemblyToastCursor(state) {
      try {
        if (typeof sessionStorage === 'undefined' || sessionStorage === null) return;
        sessionStorage.setItem(ASSEMBLY_TOAST_STORE_KEY, serializeAssemblyToastCursor(state));
      } catch {
        // The cursor is an optimisation; a refusal is not an error.
      }
    }

    /**
     * One incremental answer plus the cursor this tab already had → the notices
     * worth showing, and the cursor to keep.
     *
     * This is where "same fact never twice" is enforced on the client, so it is
     * the one function here with no IO and no React in it (`__internals` exposes
     * it to `test/client.test.mjs`). The rules, in order:
     *   - **no feed** (an older Host, or a failed read): change nothing, show
     *     nothing — the settings-page block is still there;
     *   - **another mount** (`bootId` differs, i.e. the Host restarted) or **no
     *     cursor yet**: restart from the feed's own cursor and show nothing. The
     *     numbers are not comparable across mounts, and a first connection must
     *     never replay history;
     *   - **switch off**: advance the cursor without showing anything, and report
     *     `muted` so a toast already queued is dropped rather than played out —
     *     "off" means silent now, not "silent after the queue drains";
     *   - otherwise: the notices with `seq` above the cursor, oldest first, at
     *     most `limit` of them (the newest ones — a client that has been away
     *     long enough should see where things stand, not a queue of everything
     *     it missed), and the cursor advanced to the feed's.
     * @param input - `{state, payload, limit}`.
     * @returns `{bootId, cursor, toasts, muted}`; a toast is `{session, notice}`
     *   and `muted` is true only when the switch itself is off.
     */
    function planAssemblyToasts(input) {
      const state = input !== null && typeof input === 'object' && input.state !== null && typeof input.state === 'object'
        ? input.state
        : { bootId: null, cursor: null };
      const limit =
        Number.isSafeInteger(input?.limit) && input.limit > 0 ? input.limit : ASSEMBLY_TOAST_LIMIT;
      const payload = input !== null && typeof input === 'object' && input.payload !== null && typeof input.payload === 'object'
        ? input.payload
        : null;
      const feed = payload === null ? null : payload.notifications;
      if (feed === null || feed === undefined || typeof feed !== 'object') {
        return { bootId: state.bootId, cursor: state.cursor, toasts: [], muted: false };
      }
      const bootId = typeof feed.bootId === 'string' && feed.bootId.length > 0 ? feed.bootId : null;
      const cursor = Number.isSafeInteger(feed.cursor) && feed.cursor >= 0 ? feed.cursor : null;
      const enabled = payload.enabled === true;
      if (bootId === null || cursor === null || state.cursor === null || bootId !== state.bootId) {
        return { bootId, cursor, toasts: [], muted: false };
      }
      if (enabled !== true) return { bootId, cursor, toasts: [], muted: true };
      const toasts = (Array.isArray(feed.notices) ? feed.notices : [])
        .filter(
          (entry) =>
            entry !== null && typeof entry === 'object' && entry.notice !== null && typeof entry.notice === 'object',
        )
        // Exclusive on purpose: the cursor names a notice this client has
        // already shown, so `seq === cursor` is **not** news. This is the client
        // half of "同一事实不得弹两次".
        .filter((entry) => Number.isSafeInteger(entry.notice.seq) && entry.notice.seq > state.cursor)
        .sort((left, right) => left.notice.seq - right.notice.seq)
        .slice(-limit)
        .map((entry) => ({ session: typeof entry.session === 'string' ? entry.session : null, notice: entry.notice }));
      return { bootId, cursor, toasts, muted: false };
    }

    /**
     * g-062 (Revision 46): the resident toaster, mounted in `shell.overlay`.
     *
     * It is the whole reason the notice stopped being settings-only: it lives
     * outside the settings page, so a key node reaches the user wherever they
     * are. Four properties are load-bearing:
     *   - **observer only** — it draws text that already exists and never posts
     *     anything but the switch the page owns; nothing it does can change a
     *     prompt or an assembly;
     *   - **once per fact** — the cursor, not a re-read, decides what is new, and
     *     a notice is dropped from the queue the moment its toast reports done;
     *   - **visibility-aware** — a hidden tab stops reading (browsers throttle
     *     its timers anyway) and reads once when it comes back, which is the
     *     honest form of "you will see it when you return";
     *   - **fail-open** — every read is guarded and every failure is silent: a
     *     toaster must never be the reason a user's turn looks broken.
     * @param props - the shell-overlay owner props (`t`, the session hooks) plus
     *   this mount's `activity` snapshot.
     * @returns the current toast, or nothing.
     */
    function AssemblyToaster(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const [queue, setQueue] = React.useState([]);
      const cursorRef = React.useRef(null);
      const lastPullRef = React.useRef(0);
      const startedRef = React.useRef(false);
      if (cursorRef.current === null) cursorRef.current = readAssemblyToastCursor();

      React.useEffect(() => {
        let cancelled = false;
        let timer = null;
        let inflight = false;
        const hidden = () => {
          try {
            return typeof document !== 'undefined' && document !== null && document.visibilityState === 'hidden';
          } catch {
            return false;
          }
        };
        /**
         * One read. `force` is only for the mount, and for a tab that just came
         * back: those two must not be rate-limited by the activity throttle.
         */
        const pull = async (force) => {
          if (cancelled || inflight) return;
          if (force !== true && Date.now() - lastPullRef.current < ASSEMBLY_TOAST_MIN_GAP_MS) return;
          inflight = true;
          lastPullRef.current = Date.now();
          try {
            const state = cursorRef.current;
            const query = state !== null && Number.isSafeInteger(state.cursor) ? `?since=${state.cursor}` : '';
            const result = await requestJson(`${ASSEMBLY_STATUS_PATH}${query}`);
            if (cancelled || result.ok !== true) return;
            const plan = planAssemblyToasts({
              state: cursorRef.current,
              payload: result.payload,
              limit: ASSEMBLY_TOAST_LIMIT,
            });
            cursorRef.current = { bootId: plan.bootId, cursor: plan.cursor };
            writeAssemblyToastCursor(cursorRef.current);
            // The switch being off is a statement about **now**: a queued toast
            // is dropped rather than played out (review C5).
            if (plan.muted === true) setQueue([]);
            else if (plan.toasts.length > 0) {
              setQueue((list) => [...list, ...plan.toasts].slice(-ASSEMBLY_TOAST_LIMIT));
            }
          } catch {
            // Fail open: a toaster is never worth a broken page.
          } finally {
            inflight = false;
          }
        };
        const first = startedRef.current !== true;
        startedRef.current = true;
        void pull(first);
        const arm = () => {
          if (cancelled) return;
          timer = setTimeout(() => {
            if (cancelled) return;
            if (!hidden()) void pull(false);
            arm();
          }, ASSEMBLY_TOAST_POLL_MS);
        };
        arm();
        const onVisibility = () => {
          if (!hidden()) void pull(true);
        };
        let watched = null;
        try {
          watched =
            typeof document !== 'undefined' && document !== null && typeof document.addEventListener === 'function'
              ? document
              : null;
        } catch {
          watched = null;
        }
        if (watched !== null) watched.addEventListener('visibilitychange', onVisibility);
        return () => {
          cancelled = true;
          if (timer !== null) clearTimeout(timer);
          if (watched !== null) watched.removeEventListener('visibilitychange', onVisibility);
        };
      }, [props.activity]);

      const current = queue.length > 0 ? queue[0] : null;
      if (current === null) return null;
      // The namespace the capability probe settled on (`toastPrimitives`, not
      // `primitives`): the fix round's whole point is that these two can
      // disagree, and the renderer's branch must not be the one to decide.
      // Still guarded — `HAS_TOAST` is what keeps this component from ever
      // mounting without a drawable `Toast`, and a component that cannot draw
      // is worse than none. g-063: the guard asks the **same** question as the
      // capability probe (`hasComponentExport`, not `typeof === 'function'`),
      // because a `forwardRef` Toast would otherwise ship a registered overlay
      // that can never draw a single notice: probe says yes, renderer says no.
      // Review F1: and once the Host's atoms have failed anywhere in this module
      // instance, that atom is not rendered again — the entry above returns
      // `null`, and this guard is the second, cheaper half of the same rule.
      if (
        primitivesRenderFailed ||
        toastPrimitives === null ||
        !hasComponentExport(toastPrimitives, 'Toast')
      ) {
        return null;
      }
      // The official Toast owns its own lifetime and reports completion; keying
      // by the notice id is what lets the same text appear again for a **new**
      // fact (the primitive restarts its cycle only when remounted).
      return h(toastPrimitives.Toast, {
        key: `assembly-toast-${current.notice.id}`,
        text: composeAssemblyToastText(t, current.notice),
        holdMs: ASSEMBLY_TOAST_HOLD_MS,
        onDone: () => setQueue((list) => list.slice(1)),
      });
    }

    /**
     * The same toaster, wired to the one client-side event that really exists.
     *
     * A `shell.overlay` entry receives the root hooks (proven by
     * `dsh-plugin-whale-pet`), and a change in the session-status map means a
     * step ended somewhere — which is exactly when a key node's delivery verdict
     * has just settled. The hook is called inside a guard because a throwing hook
     * must cost the event, never the overlay.
     * @param props - the shell-overlay owner props.
     * @returns the toaster.
     */
    function ConnectedAssemblyToaster(props) {
      let activity = null;
      try {
        activity = props.useSessionStatus((map) => map);
      } catch {
        activity = null;
      }
      return h(AssemblyToaster, { ...props, activity });
    }

    /**
     * The registered entry: the event-driven toaster when the Host offers the
     * hook, the timer-only one when it does not.
     *
     * Since g-063 (reviews E1 / F1) it sits behind the same boundary as the
     * settings page, because the toaster is the other place this plugin renders
     * a Host atom and an overlay entry that throws during render would take the
     * shell's overlay subtree with it. Two rules, in this order:
     *
     *   1. **Once the Host's atoms have failed anywhere in this module
     *      instance, this entry renders nothing.** The flip is instance-wide and
     *      one-way, so after it there is no `primitivesActive()` branch to fall
     *      into: wrapping the entry again would re-render the very atom that
     *      threw, and dropping the wrapper (the pre-F1 shape) would do it
     *      *unwrapped*. `null` is the only shape that cannot throw — the
     *      settings page's own block still says everything the toast would.
     *   2. While the atoms are still in use, the boundary is what converts a
     *      first failure into that `null` (and into the instance-wide flip).
     *
     * The g-062 baseline is untouched: a Host whose probe never passed has no
     * `Toast` to render in the first place, and gets the plain entry back.
     * @param props - the shell-overlay owner props.
     * @returns the toaster, the boundary around it, or `null` after a failure.
     */
    function AssemblyToasterRoot(props) {
      if (primitivesRenderFailed) return null;
      const supported = typeof props.useSessionStatus === 'function';
      const toaster = supported ? h(ConnectedAssemblyToaster, props) : h(AssemblyToaster, { ...props, activity: null });
      if (!primitivesActive()) return toaster;
      return h(PrimitivesErrorBoundary, { renderFallback: () => null }, toaster);
    }

    // #endregion

    /**
     * g-062:「装配状态提示」— the two-layer observation, rendered in this page
     * only.
     *
     * It states the two verdicts the goal fixes, and nothing it renders can

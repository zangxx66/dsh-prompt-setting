// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。

    /**
     * g-089: the composer bar's **live** half — when to re-read, and how not to
     * storm the Host while doing it.
     *
     * g-086 shipped the bar as a read-once entry: its three `GET`s ran on mount,
     * on a Session change and on the user's refresh click, which meant a save in
     * the settings panel left the bar showing yesterday's numbers. This segment
     * adds the four triggers the goal names, and nothing else:
     *
     *   - **same-tab writes** — `requestJson` is the page's single write funnel
     *     (all five chunks go through it), so one broadcast from there covers
     *     "save「我的 Prompt」", "apply/unapply a preset", "delete a preset",
     *     "import", "rollback", "reset a layer" and "delete an override" at once;
     *   - **the Session status map** — the only client-side event the Host really
     *     has for "a step ended", which is when an assembly verdict settles;
     *   - **visibility / focus** — a tab that comes back re-reads immediately, and
     *     a hidden tab stops polling entirely;
     *   - **`storage`** — a second tab's write lands on this tab's listener; the
     *     writing tab drops a probe value under one key, and the key is the whole
     *     message ("something in this plugin changed").
     *
     * The fallback timer is a **chained `setTimeout`**, never `setInterval`: it is
     * armed only while `enabled && Session && visible`, and it is cleared the
     * moment the tab hides or the bar switches off. That is what keeps g-086 R5's
     * "off means zero requests" true.
     *
     * Every fact this segment needs from a clock, a document or a window is
     * injectable through owner props (`liveSetTimeout`, `liveClearTimeout`,
     * `liveDocument`, `liveWindow`, `liveStorage`, `liveNow`, `livePollMs`,
     * `liveMinGapMs`, `liveWriteGapMs`), and every policy decision is a pure
     * function exported through `__internals.composerBar` — so the four branches
     * the goal requires (event ⇒ read, hidden ⇒ no poll, visible ⇒ read now,
     * stale answer dropped) are asserted without a browser and without waiting.
     */

    /**
     * The visible-tab fallback window.
     *
     * 20 s is the same number the g-062 toaster settled on: long enough that a
     * resident bar costs one read per 20 s instead of a poll loop, short enough
     * that a change made by an outside editor shows up while the user is still
     * looking. The primary triggers are events; this is the honest transport for
     * a Host that exposes no push channel (`01-shared-head.js` §ASSEMBLY_*).
     */
    const COMPOSER_BAR_POLL_MS = 20000;
    /**
     * Shortest gap between two reads triggered by a **non-write** event.
     *
     * The Session status map can change several times per step (waiting ⇒
     * assembled ⇒ delivered); collapsing those into one read 2.5 s later is what
     * keeps one turn from costing a read per transition. `ASSEMBLY_TOAST_MIN_GAP_MS`
     * (3000) is the same idea in the toaster and the two are deliberately close.
     */
    const COMPOSER_BAR_MIN_GAP_MS = 2500;
    /**
     * The coalescing window for same-tab writes.
     *
     * A user action is the one trigger that must feel instant (the goal's ≤1 s),
     * so it is never held back by the 2.5 s throttle — but a form that saves
     * twice in 200 ms should still cost one read, not two. 300 ms is below the
     * eye's "did anything happen" threshold and above one keystroke's burst.
     */
    const COMPOSER_BAR_WRITE_GAP_MS = 300;
    /**
     * The key two tabs use to tell each other that something changed.
     *
     * **A probe, not a transport**: the value carries the change's topic and a
     * timestamp only so a human debugging a stuck bar can read it. The listener
     * reacts to the key, never to the value — a second tab must not be able to
     * make this one trust a payload it did not fetch.
     */
    const COMPOSER_BAR_LIVE_KEY = 'dsh-prompt-setting:composer-bar-live';
    /**
     * The write routes that cannot change any of the bar's four facts.
     *
     * Everything else — including a route added in a future revision — is treated
     * as relevant: a wasted read is a recoverable cost, while a missed one is
     * exactly the stale bar this goal exists to remove. The ignored list is
     * therefore **closed and justified**, not a whitelist to keep extending:
     *   - `/presets` and `/presets/tags` are the catalogue itself (a named text
     *     library); applying one is `/presets/apply`, which is *not* ignored;
     *   - `/assembly-status` writes the toaster switch, which changes no notice;
     *   - `/update-check`, `/download-region`, `/update-apply` are release
     *     plumbing and never touch a layer or an assembly.
     */
    const COMPOSER_BAR_LIVE_IGNORED_PATHS = Object.freeze([
      ASSEMBLY_STATUS_PATH,
      UPDATE_CHECK_PATH,
      DOWNLOAD_REGION_PATH,
      UPDATE_APPLY_PATH,
      PRESETS_PATH,
      PRESETS_TAGS_PATH,
    ]);

    /**
     * The page's write broadcast: a revision counter plus its listeners.
     *
     * The identical shape `overlaySeat` and the on/off bus already use
     * (`01-shared-head.js`): a **number** is the snapshot, so a subscriber that
     * asks twice gets the same value and nothing re-renders by accident.
     */
    const composerBarLiveBus = {
      revision: 0,
      listeners: new Set(),
      lastTopic: '',
    };

    /**
     * The bus's snapshot (a number, never a fresh object).
     * @returns the revision.
     */
    function composerBarLiveRevision() {
      return composerBarLiveBus.revision;
    }

    /**
     * Subscribe to same-tab write broadcasts.
     * @param listener - called with the changed route's topic after a write.
     * @returns an idempotent unsubscribe.
     */
    function subscribeComposerBarLive(listener) {
      if (typeof listener !== 'function') return () => {};
      composerBarLiveBus.listeners.add(listener);
      return () => {
        composerBarLiveBus.listeners.delete(listener);
      };
    }

    /**
     * Broadcast one successful write.
     *
     * Called from `requestJson` — never during a render, always after a response
     * really said `ok: true` — so notifying subscribers here is an ordinary
     * update rather than an update-during-render. One throwing listener must not
     * cost the others their read.
     * @param topic - the route that changed, or `''` to broadcast nothing.
     * @returns whether anything was broadcast.
     */
    function notifyComposerBarWrite(topic) {
      const name = typeof topic === 'string' ? topic : '';
      if (name.length === 0) return false;
      composerBarLiveBus.revision += 1;
      composerBarLiveBus.lastTopic = name;
      for (const listener of [...composerBarLiveBus.listeners]) {
        try {
          listener(name);
        } catch {
          // One bad listener must not keep the others from updating.
        }
      }
      return true;
    }

    /**
     * The HTTP method one `requestJson` call really used.
     *
     * `fetch`'s default is `GET`, and a caller that passes no init is a read —
     * so the absent case must answer `GET`, not "unknown". Only the four write
     * verbs the page uses are accepted; anything else is not broadcast.
     * @param init - the fetch init, if any.
     * @returns the upper-cased method, or `''`.
     */
    function composerBarWriteMethodOf(init) {
      const method =
        init !== null && typeof init === 'object' && typeof init.method === 'string' ? init.method.toUpperCase() : '';
      if (method.length === 0) return 'GET';
      return method === 'PUT' || method === 'POST' || method === 'DELETE' || method === 'PATCH' ? method : '';
    }

    /**
     * Which route (if any) one write changes among the bar's four facts.
     *
     * The answer is the path itself, which doubles as the topic a listener sees:
     * the bar only needs "something relevant changed", and a topic is what a
     * human debugging a stuck bar wants in the console.
     * @param path - the request path (may carry a query string).
     * @returns the topic, or `''` when the write cannot matter.
     */
    function composerBarWriteTopicOf(path) {
      const value = typeof path === 'string' ? path.split('?')[0] : '';
      if (value.length === 0) return '';
      return COMPOSER_BAR_LIVE_IGNORED_PATHS.includes(value) ? '' : value;
    }

    /**
     * The probe value this tab leaves for the others.
     *
     * Pure, and injectable, so a case can assert the value without a clock. The
     * value is **not** trusted by anyone: the receiving tab re-reads the Host.
     * @param topic - the changed route.
     * @param now - the write's timestamp (ms).
     * @returns the string to store under {@link COMPOSER_BAR_LIVE_KEY}.
     */
    function composerBarLiveProbeValue(topic, now) {
      const name = typeof topic === 'string' ? topic : '';
      const stamp = typeof now === 'number' && Number.isFinite(now) ? String(now) : '0';
      return `${stamp}:${name}`;
    }

    /** The `localStorage` this realm may write a probe to, or null. */
    function composerBarLiveStorageOf() {
      const storage = composerBarStorage();
      return storage !== null && typeof storage.setItem === 'function' ? storage : null;
    }

    /**
     * Store the cross-tab probe, best effort.
     *
     * A privacy mode, a full quota and a realm without `localStorage` all end the
     * same way: this tab's own bar still updated (the broadcast is in memory),
     * and the other tabs fall back to their 20 s window. Never a throw.
     * @param value - the probe string.
     * @param storage - the storage to use; omitted means "discover it".
     * @returns whether anything was stored.
     */
    function writeComposerBarLiveProbe(value, storage) {
      try {
        const target = storage === undefined ? composerBarLiveStorageOf() : storage;
        if (target === null || typeof target !== 'object' || typeof target.setItem !== 'function') return false;
        target.setItem(COMPOSER_BAR_LIVE_KEY, String(value));
        return true;
      } catch {
        return false;
      }
    }

    /**
     * The one function `requestJson` calls after a successful write.
     *
     * It answers "was this a write", "does it matter to the bar" and "tell the
     * other tabs" in that order, and it never throws — a transport helper must
     * not fail because a notification did.
     * @param path - the request path.
     * @param init - the fetch init.
     * @returns whether a broadcast happened.
     */
    function notifyComposerBarWriteOf(path, init) {
      const method = composerBarWriteMethodOf(init);
      if (method !== 'PUT' && method !== 'POST' && method !== 'DELETE' && method !== 'PATCH') return false;
      const topic = composerBarWriteTopicOf(path);
      if (topic.length === 0) return false;
      writeComposerBarLiveProbe(composerBarLiveProbeValue(topic, composerBarLiveNow()));
      return notifyComposerBarWrite(topic);
    }

    /** The clock the probe uses; `Date.now`, guarded against an exotic realm. */
    function composerBarLiveNow() {
      try {
        return Date.now();
      } catch {
        return 0;
      }
    }

    /**
     * Is this document visible right now?
     *
     * An absent document answers **true**: a realm with no `document` (a test
     * double, a worker) must not be mistaken for a hidden tab, or the bar would
     * stop reading for a reason that is not about visibility.
     * @param doc - a document, or anything else.
     * @returns `true` unless the document says it is hidden.
     */
    function composerBarVisibleNow(doc) {
      if (doc === null || typeof doc !== 'object') return true;
      try {
        return doc.visibilityState !== 'hidden' && doc.visibilityState !== 'prerender';
      } catch {
        return true;
      }
    }

    /**
     * The minimum gap one trigger has to respect.
     *
     * `visible` (the tab came back), `manual` (the user clicked refresh) and
     * `poll` are **not** throttled: the first two are the user speaking, and the
     * fallback timer is already 20 s apart — throttling it again would only make
     * one poll stretch into two reads through the deferral branch.
     * @param trigger - `write` | `visible` | `manual` | `status` | `poll` | `storage`.
     * @param minGapMs - the configured non-write gap.
     * @param writeGapMs - the configured write coalescing window.
     * @returns the gap in ms (0 = read now).
     */
    function composerBarLiveTriggerGapOf(trigger, minGapMs, writeGapMs) {
      const name = typeof trigger === 'string' ? trigger : '';
      if (name === 'visible' || name === 'manual' || name === 'enable' || name === 'poll') return 0;
      if (name === 'write') return writeGapMs;
      return minGapMs;
    }

    /**
     * The whole read policy, as one pure decision.
     *
     * Four answers, and each one is a branch the tests assert:
     *   - `skip`   — off, no Session, or hidden while the trigger is not manual;
     *   - `dirty`  — a read is already in flight; remember it and follow up once;
     *   - `merged` — a deferred read is already queued; this trigger joins it;
     *   - `defer`  — inside the trigger's gap; read when the gap ends;
     *   - `read`   — read now.
     * @param input - `{enabled, sessionId, visible, trigger, inflight, pending, now, lastAt, minGapMs, writeGapMs}`.
     * @returns `{action, delayMs}`.
     */
    function composerBarLiveDecision(input) {
      const source = input !== null && typeof input === 'object' ? input : {};
      if (source.enabled !== true) return { action: 'skip', delayMs: 0 };
      if (typeof source.sessionId !== 'string' || source.sessionId.length === 0) return { action: 'skip', delayMs: 0 };
      const trigger = typeof source.trigger === 'string' ? source.trigger : 'manual';
      // A hidden tab reads nothing on its own initiative; a manual click and an
      // explicit `enable` are the user speaking, and are honoured anyway.
      if (source.visible === false && trigger !== 'manual' && trigger !== 'enable') {
        return { action: 'skip', delayMs: 0 };
      }
      if (source.inflight === true) return { action: 'dirty', delayMs: 0 };
      if (source.pending === true) return { action: 'merged', delayMs: 0 };
      const minGapMs =
        typeof source.minGapMs === 'number' && Number.isFinite(source.minGapMs) && source.minGapMs > 0
          ? source.minGapMs
          : COMPOSER_BAR_MIN_GAP_MS;
      const writeGapMs =
        typeof source.writeGapMs === 'number' && Number.isFinite(source.writeGapMs) && source.writeGapMs >= 0
          ? source.writeGapMs
          : COMPOSER_BAR_WRITE_GAP_MS;
      const gapMs = composerBarLiveTriggerGapOf(trigger, minGapMs, writeGapMs);
      const elapsed =
        typeof source.now === 'number' &&
        Number.isFinite(source.now) &&
        typeof source.lastAt === 'number' &&
        Number.isFinite(source.lastAt)
          ? source.now - source.lastAt
          : Number.POSITIVE_INFINITY;
      if (gapMs <= 0 || elapsed >= gapMs) return { action: 'read', delayMs: 0 };
      return { action: 'defer', delayMs: gapMs - elapsed };
    }

    /**
     * One read result set, normalized into this bar's view state.
     * @param results - `{snapshot, overrides, assembly}`, each a `requestJson` answer.
     * @returns `{phase: 'ready', snapshot, overrides, assembly}`.
     */
    function composerBarReadOf(results) {
      const source = results !== null && typeof results === 'object' ? results : {};
      const payloadOf = (result) =>
        result !== null && typeof result === 'object' && result.ok === true ? result.payload : null;
      return {
        phase: 'ready',
        snapshot: payloadOf(source.snapshot),
        overrides: payloadOf(source.overrides),
        assembly: payloadOf(source.assembly),
      };
    }

    /**
     * The four facts the bar prints, as one comparable string.
     *
     * Only what the five regions **show** is folded in: the section count, the
     * two layers' `{kind,total,ineffective}` and the notice's two verdicts. A
     * timestamp the Host puts in the snapshot (`generatedAt` is a fresh `new
     * Date()` per request) must not count as a change, or every read would
     * re-render a bar that says exactly the same thing.
     * @param state - `{snapshot, overrides, assembly}`.
     * @returns a stable signature (empty string for an unusable state).
     */
    function composerBarFactsSignature(state) {
      if (state === null || typeof state !== 'object') return '';
      const snapshot = state.snapshot === undefined ? null : state.snapshot;
      const overrides = state.overrides === undefined ? null : state.overrides;
      const notice = composerBarNoticeOf(state.assembly === undefined ? null : state.assembly);
      const user = composerBarLayerFact('user', snapshot, overrides);
      const workspace = composerBarLayerFact('workspace', snapshot, overrides);
      const assembly =
        notice === null
          ? null
          : {
              assembled: notice.assembly !== null && typeof notice.assembly === 'object' && notice.assembly.assembled === true,
              delivery:
                notice.delivery !== null && typeof notice.delivery === 'object' && typeof notice.delivery.state === 'string'
                  ? notice.delivery.state
                  : null,
            };
      return JSON.stringify({
        sections: composerBarSectionCount(snapshot),
        user: [user.kind, user.total, user.ineffective],
        workspace: [workspace.kind, workspace.total, workspace.ineffective],
        assembly,
      });
    }

    /**
     * The next view state, **keeping the previous object when nothing changed**.
     *
     * React bails out of a re-render when `setState` receives the very value it
     * holds, which is the mechanical form of the goal's "unchanged facts must not
     * change the rendered text" (no flicker, no focus move). Returning a fresh
     * object with identical contents would look the same on screen but would
     * re-render the row — and re-render is exactly what a `role="status"` live
     * region must not do for free.
     * @param previous - the state currently on screen.
     * @param results - the fresh read answers.
     * @returns the state to install (possibly `previous` itself).
     */
    function composerBarNextRead(previous, results) {
      const next = composerBarReadOf(results);
      if (previous === null || typeof previous !== 'object' || previous.phase !== 'ready') return next;
      return composerBarFactsSignature(previous) === composerBarFactsSignature(next) ? previous : next;
    }

    /**
     * Fold the Host's session-status map into one **number**.
     *
     * `useSessionStatus` is an external-store hook: a selector that returns a
     * fresh object on every call re-renders its subscriber forever (React
     * compares snapshots with `Object.is`). A number is the only shape that is
     * both a legal snapshot and a signal — it changes when the map's size or any
     * entry's `state`/`status`/`phase` spelling changes, which is all this bar
     * needs to know that "a step probably ended".
     * @param map - the Host's status map, or anything else.
     * @returns a stable non-negative number.
     */
    function composerBarSessionStatusTick(map) {
      if (map === null || typeof map !== 'object') return 0;
      let tick = 0;
      try {
        const keys = Object.keys(map);
        tick = keys.length;
        for (const key of keys) {
          const entry = map[key];
          const text =
            typeof entry === 'string'
              ? entry
              : entry !== null && typeof entry === 'object'
                ? [entry.state, entry.status, entry.phase]
                    .map((value) => (value === undefined || value === null ? '' : String(value)))
                    .join('|')
                : '';
          const sample = `${key}:${text}`;
          for (let index = 0; index < sample.length; index += 1) {
            tick = (tick * 31 + sample.charCodeAt(index)) % 100000007;
          }
        }
      } catch {
        return 0;
      }
      return tick;
    }

    /**
     * Ask the Host's own session-status hook for the tick, or answer 0.
     *
     * The hook is called **through the owner props** and only when it exists; a
     * Host that predates it, a hook that throws and a hook that answers a
     * non-number all degrade to "no event", which leaves the fallback timer as
     * the only trigger — the documented degradation, not an error.
     * @param props - the entry's owner props.
     * @returns the tick (0 when the hook is unavailable).
     */
    function composerBarSessionTick(props) {
      const hook = props !== null && typeof props === 'object' ? props.useSessionStatus : undefined;
      if (typeof hook !== 'function') return 0;
      try {
        const value = hook((map) => composerBarSessionStatusTick(map));
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
      } catch {
        return 0;
      }
    }

    /**
     * The injectable IO this segment needs, resolved from owner props once.
     *
     * Every field falls back to the realm's own object and then to `null`, so a
     * hook can run in a realm with no timers, no document and no window without
     * a single `typeof` check leaking into its body.
     * @param props - the entry's owner props.
     * @returns `{setTimer, clearTimer, document, window, storage, now, pollMs, minGapMs, writeGapMs}`.
     */
    function composerBarLiveIoOf(props) {
      const source = props !== null && typeof props === 'object' ? props : {};
      const numberOr = (value, fallback) =>
        typeof value === 'number' && Number.isFinite(value) ? value : fallback;
      const setTimer =
        typeof source.liveSetTimeout === 'function'
          ? source.liveSetTimeout
          : typeof setTimeout === 'function'
            ? setTimeout
            : null;
      const clearTimer =
        typeof source.liveClearTimeout === 'function'
          ? source.liveClearTimeout
          : typeof clearTimeout === 'function'
            ? clearTimeout
            : null;
      const doc =
        source.liveDocument !== undefined && source.liveDocument !== null
          ? source.liveDocument
          : composerBarDocumentOf(source);
      const view =
        source.liveWindow !== undefined && source.liveWindow !== null ? source.liveWindow : composerBarGlobalWindow();
      const storage =
        source.liveStorage !== undefined && source.liveStorage !== null
          ? source.liveStorage
          : composerBarLiveStorageOf();
      const now = typeof source.liveNow === 'function' ? source.liveNow : () => composerBarLiveNow();
      return {
        setTimer,
        clearTimer,
        document: doc === undefined ? null : doc,
        window: view === undefined ? null : view,
        storage: storage === undefined ? null : storage,
        now,
        pollMs: numberOr(source.livePollMs, COMPOSER_BAR_POLL_MS),
        minGapMs: numberOr(source.liveMinGapMs, COMPOSER_BAR_MIN_GAP_MS),
        writeGapMs: numberOr(source.liveWriteGapMs, COMPOSER_BAR_WRITE_GAP_MS),
      };
    }

    /**
     * Stop the fallback poll, if one is armed.
     *
     * A free function over the booking record rather than a closure of the
     * effect, because two places must be able to call it: the effect's own
     * teardown **and** its next run. A handle the realm no longer knows is
     * already stopped, so a throwing `clearTimeout` is not an error.
     * @param book - the hook's persistent booking record.
     * @param io - the resolved IO.
     */
    function stopLivePoll(book, io) {
      if (book === null || typeof book !== 'object' || book.pollTimer === null) return;
      if (io !== null && typeof io === 'object' && io.clearTimer !== null) {
        try {
          io.clearTimer(book.pollTimer);
        } catch {
          // Already stopped.
        }
      }
      book.pollTimer = null;
    }

    /**
     * The bar's data layer: read, and the four triggers that make it live.
     *
     * There is still exactly **one** read path — the effect below, keyed by
     * `[enabled, sessionId, nonce]` — and every trigger is `refresh(trigger)`,
     * i.e. one `setNonce`. That is what keeps g-086's guarantees intact: off and
     * no-Session still short-circuit *before* any `fetch`, a Session change still
     * drops the old verdicts, and a manual refresh still costs exactly one read.
     *
     * Concurrency: `round` is bumped by every effect run, so a response that
     * arrives after its effect was replaced can neither write state nor clear the
     * in-flight flag of the newer round. `dirty` is the "one follow-up read" the
     * goal asks for when a trigger lands mid-flight, and `pendingTimer` is the
     * coalescing seat for a trigger that arrived inside its gap.
     * @param options - `{enabled, sessionId, props}`.
     * @returns `{read, refresh}` for the bar to render with.
     */
    function useComposerBarLiveRead(options) {
      const source = options !== null && typeof options === 'object' ? options : {};
      const enabled = source.enabled === true;
      const sessionId = typeof source.sessionId === 'string' ? source.sessionId : '';
      const props = source.props !== null && typeof source.props === 'object' ? source.props : {};
      const io = composerBarLiveIoOf(props);
      const [read, setRead] = React.useState({
        phase: sessionId === '' ? 'no-session' : 'loading',
        snapshot: null,
        overrides: null,
        assembly: null,
      });
      const [nonce, setNonce] = React.useState(0);
      const bookRef = React.useRef(null);
      if (bookRef.current === null) {
        bookRef.current = {
          round: 0,
          inflight: false,
          dirty: false,
          pendingTimer: null,
          // The fallback poll's handle and the teardown queue live on the book,
          // not in the effect's closure: the effect clears them on every run (see
          // below), which is what makes "off means no timer" true even on a
          // renderer that skips cleanups.
          pollTimer: null,
          disposers: [],
          lastTriggerAt: Number.NEGATIVE_INFINITY,
        };
      }
      const book = bookRef.current;

      /**
       * The single entry point every trigger uses.
       * @param trigger - `write` | `visible` | `manual` | `status` | `poll` | `storage`.
       * @returns the decision that was taken (`read` / `defer` / `dirty` / …).
       */
      const refresh = (trigger) => {
        const decision = composerBarLiveDecision({
          enabled,
          sessionId,
          visible: composerBarVisibleNow(io.document),
          trigger,
          inflight: book.inflight,
          pending: book.pendingTimer !== null,
          now: io.now(),
          lastAt: book.lastTriggerAt,
          minGapMs: io.minGapMs,
          writeGapMs: io.writeGapMs,
        });
        if (decision.action === 'skip') return 'skip';
        if (decision.action === 'dirty') {
          book.dirty = true;
          return 'dirty';
        }
        if (decision.action === 'merged') return 'merged';
        const fire = () => {
          book.pendingTimer = null;
          book.lastTriggerAt = io.now();
          setNonce((value) => value + 1);
        };
        if (decision.action === 'defer') {
          // A realm without a timer must still read: the wait is an optimisation,
          // not a requirement (the goal's ≤1 s applies to the write branch).
          if (io.setTimer === null) {
            fire();
            return 'read';
          }
          const timer = io.setTimer(fire, decision.delayMs);
          book.pendingTimer = timer === undefined ? null : timer;
          if (book.pendingTimer === null) {
            fire();
            return 'read';
          }
          return 'defer';
        }
        fire();
        return 'read';
      };

      // ── the one read path (g-086's effect, unchanged in shape) ──────────────
      React.useEffect(() => {
        if (!enabled) {
          book.inflight = false;
          book.dirty = false;
          setRead({ phase: 'off', snapshot: null, overrides: null, assembly: null });
          return undefined;
        }
        const urls = composerBarRequestUrls(sessionId);
        if (urls === null) {
          book.inflight = false;
          book.dirty = false;
          setRead({ phase: 'no-session', snapshot: null, overrides: null, assembly: null });
          return undefined;
        }
        let cancelled = false;
        book.round += 1;
        const round = book.round;
        book.inflight = true;
        book.lastTriggerAt = io.now();
        setRead((current) => ({
          phase: 'loading',
          // A refresh keeps the last answer on screen instead of blanking the
          // bar; only the phase changes, so the row does not jump.
          snapshot: current === null || typeof current !== 'object' ? null : current.snapshot,
          overrides: current === null || typeof current !== 'object' ? null : current.overrides,
          assembly: current === null || typeof current !== 'object' ? null : current.assembly,
        }));
        // A round that has been replaced stops issuing its remaining requests:
        // the three reads are serial, so a superseded round that kept going would
        // put two reads in flight at once — the one thing the goal forbids.
        const stale = () => cancelled === true || book.round !== round;
        const retire = () => {
          if (book.round === round) book.inflight = false;
        };
        const load = async () => {
          let results = null;
          try {
            const snapshot = await requestJson(urls.snapshot);
            if (stale()) {
              retire();
              return;
            }
            const overrides = await requestJson(urls.overrides);
            if (stale()) {
              retire();
              return;
            }
            const assembly = await requestJson(urls.assembly);
            results = { snapshot, overrides, assembly };
          } catch {
            results = null;
          }
          // Only the newest round owns the flags: a superseded round must not
          // clear the newer one's in-flight state nor write its stale answers.
          if (book.round !== round) return;
          book.inflight = false;
          if (cancelled) return;
          if (results !== null) setRead((current) => composerBarNextRead(current, results));
          // A trigger that landed mid-flight gets exactly one follow-up read.
          const again = book.dirty === true;
          book.dirty = false;
          if (again) setNonce((value) => value + 1);
        };
        void load();
        return () => {
          cancelled = true;
        };
      }, [enabled, sessionId, nonce]);

      // ── the Session status trigger (the one client event that exists) ───────
      const activity = composerBarSessionTick(props);
      const activityRef = React.useRef(null);
      React.useEffect(() => {
        // The first observation is the mount's own read, not a change.
        if (activityRef.current === null) {
          activityRef.current = activity;
          return;
        }
        if (activityRef.current === activity) return;
        activityRef.current = activity;
        refresh('status');
      }, [activity]);

      // ── writes, visibility, focus, storage, and the fallback timer ──────────
      const pollMs = io.pollMs;
      React.useEffect(() => {
        // Teardown is also done at the **start** of every run, not only in the
        // cleanup: a renderer that never calls a cleanup (this bundle's unit-test
        // double is one) must not accumulate timers and listeners across renders,
        // and doing it here makes the effect idempotent either way.
        stopLivePoll(book, io);
        for (const dispose of book.disposers) {
          try {
            dispose();
          } catch {
            // One failed teardown must not skip the others.
          }
        }
        book.disposers = [];
        if (!enabled || sessionId === '') return undefined;
        const doc = io.document;
        const view = io.window;
        const addDisposer = (dispose) => {
          book.disposers.push(dispose);
        };
        addDisposer(subscribeComposerBarLive(() => refresh('write')));
        const armPoll = () => {
          stopLivePoll(book, io);
          if (pollMs <= 0 || io.setTimer === null) return;
          // A hidden tab arms nothing at all: no timer, no request, no wake-up.
          if (!composerBarVisibleNow(doc)) return;
          const timer = io.setTimer(() => {
            book.pollTimer = null;
            if (!composerBarVisibleNow(doc)) return;
            refresh('poll');
            armPoll();
          }, pollMs);
          book.pollTimer = timer === undefined ? null : timer;
        };
        if (doc !== null && typeof doc.addEventListener === 'function') {
          const onVisibility = () => {
            if (composerBarVisibleNow(doc)) {
              refresh('visible');
              armPoll();
            } else {
              stopLivePoll(book, io);
            }
          };
          try {
            doc.addEventListener('visibilitychange', onVisibility);
            addDisposer(() => {
              try {
                doc.removeEventListener('visibilitychange', onVisibility);
              } catch {
                // A document that refuses removal is already gone.
              }
            });
          } catch {
            // A document that refuses listeners leaves the timer as the trigger.
          }
        }
        if (view !== null && typeof view.addEventListener === 'function') {
          const onFocus = () => {
            if (composerBarVisibleNow(doc)) refresh('visible');
          };
          const onStorage = (event) => {
            // The key is the message; the value is never trusted (it names a route
            // this tab did not fetch).
            const key =
              event !== null && typeof event === 'object' && typeof event.key === 'string'
                ? event.key
                : COMPOSER_BAR_LIVE_KEY;
            if (key !== COMPOSER_BAR_LIVE_KEY) return;
            refresh('storage');
          };
          try {
            view.addEventListener('focus', onFocus);
            view.addEventListener('storage', onStorage);
            addDisposer(() => {
              try {
                view.removeEventListener('focus', onFocus);
                view.removeEventListener('storage', onStorage);
              } catch {
                // Same as above.
              }
            });
          } catch {
            // A window that refuses listeners keeps the fallback timer only.
          }
        }
        armPoll();
        return () => {
          stopLivePoll(book, io);
          for (const dispose of book.disposers) {
            try {
              dispose();
            } catch {
              // One failed teardown must not skip the others.
            }
          }
          book.disposers = [];
        };
      }, [enabled, sessionId, pollMs]);

      return { read, refresh };
    }

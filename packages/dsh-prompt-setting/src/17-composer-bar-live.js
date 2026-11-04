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
     *   - **the Session status snapshot** (`ReadonlyMap` of SessionId → `SessionStatus`,
     *     the Host's `useSessionStatus`) — the only client-side event the Host
     *     really has for "a step ended", which is when an assembly verdict
     *     settles; it is folded to one number over the contract's own fields
     *     (`running` / `completionUnread` / `pendingInteraction`);
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
     * The status snapshot can change several times per step (pending ⇒ running
     * false ⇒ delivered); collapsing those into one read 2.5 s later is what
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
     *   - `/presets/tags` is the library's own tag set (a catalogue); it never
     *     touches a layer;
     *   - `/assembly-status` writes the toaster switch, which changes no notice;
     *   - `/update-check`, `/download-region`, `/update-apply` are release
     *     plumbing and never touch a layer or an assembly.
     *
     * `/presets` is **method-dependent** and is therefore not in this list:
     * creating/renaming a preset (`PUT`/`POST`) is catalogue-only, but **deleting**
     * one (`DELETE ?id=`) is not — when the deleted preset is applied, the Host
     * restores the workspace layer before answering (`handleDeletePreset` →
     * `appliedRootsOf` → `planPresetRemoval` → `writeConfig` → `notePromptWrite`
     * → `recordHistory`, then `{ok: true}`), so the four facts really change and
     * the bar must re-read (review B1: the goal's「删除预设」was ignored). See
     * {@link composerBarWriteTopicOf}.
     */
    const COMPOSER_BAR_LIVE_IGNORED_PATHS = Object.freeze([
      ASSEMBLY_STATUS_PATH,
      UPDATE_CHECK_PATH,
      DOWNLOAD_REGION_PATH,
      UPDATE_APPLY_PATH,
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
     *
     * The query string is dropped (a topic is a route, not a payload), and one
     * route is judged **by method**: `DELETE /presets?id=` removes one of the
     * user's named texts, and deleting an *applied* one makes the Host restore
     * the workspace layer before it answers — the four facts change (review B1).
     * The catalogue's own `PUT`/`POST` writes still do not.
     * @param path - the request path (may carry a query string).
     * @param method - the upper-cased HTTP method (`DELETE` matters for `/presets`).
     * @returns the topic, or `''` when the write cannot matter.
     */
    function composerBarWriteTopicOf(path, method) {
      const value = typeof path === 'string' ? path.split('?')[0] : '';
      if (value.length === 0) return '';
      const verb = typeof method === 'string' ? method.toUpperCase() : '';
      if (value === PRESETS_PATH) return verb === 'DELETE' ? value : '';
      return COMPOSER_BAR_LIVE_IGNORED_PATHS.includes(value) ? '' : value;
    }

    /** A monotonic counter behind {@link composerBarLiveProbeValue}'s sequence. */
    let composerBarLiveProbeSeq = 0;

    /**
     * The probe value this tab leaves for the others.
     *
     * Pure, and injectable, so a case can assert the value without a clock. The
     * value is **not** trusted by anyone: the receiving tab re-reads the Host.
     *
     * `seq` exists because a millisecond stamp alone repeats when two writes land
     * in the same tick — and a `storage` event only fires when the **value**
     * differs, so the second write would be invisible to the other tab (it would
     * still catch up on its 20 s window). The sequence makes the value distinct;
     * it is omitted from the string when the caller does not pass one.
     * @param topic - the changed route.
     * @param now - the write's timestamp (ms).
     * @param seq - a positive monotonic number, or omitted.
     * @returns the string to store under {@link COMPOSER_BAR_LIVE_KEY}.
     */
    function composerBarLiveProbeValue(topic, now, seq) {
      const name = typeof topic === 'string' ? topic : '';
      const stamp = typeof now === 'number' && Number.isFinite(now) ? String(now) : '0';
      const order = typeof seq === 'number' && Number.isFinite(seq) && seq > 0 ? `${seq}:` : '';
      return `${stamp}:${order}${name}`;
    }

    /**
     * The storage this page's writes drop their cross-tab probe into.
     *
     * `requestJson` — the write funnel — has no props, so the live hook registers
     * the seat it was given here. Two consequences that matter to a test: an
     * injected `liveStorage` really receives the probe (assertable), and a realm
     * with no `localStorage` writes nothing instead of reaching for a real one.
     */
    const composerBarLiveProbeSeat = { storage: null };

    /**
     * Register the storage the probe writes to (called by the live hook).
     * @param storage - the resolved storage, or null to clear the seat.
     */
    function setComposerBarLiveProbeStorage(storage) {
      composerBarLiveProbeSeat.storage = storage === null || typeof storage !== 'object' ? null : storage;
    }

    /**
     * The storage a probe should use: the registered seat first, the realm's own
     * `localStorage` only when nothing was registered.
     * @returns the storage, or null.
     */
    function composerBarLiveProbeStorageOf() {
      return composerBarLiveProbeSeat.storage === null ? composerBarLiveStorageOf() : composerBarLiveProbeSeat.storage;
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
      const topic = composerBarWriteTopicOf(path, method);
      if (topic.length === 0) return false;
      composerBarLiveProbeSeq += 1;
      writeComposerBarLiveProbe(
        composerBarLiveProbeValue(topic, composerBarLiveNow(), composerBarLiveProbeSeq),
        composerBarLiveProbeStorageOf(),
      );
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
     * Does this trigger outrank an already-queued deferral?
     *
     * `write` (the user just saved something), `manual` (they clicked refresh) and
     * `visible` (the tab just came back) are the three triggers the goal promises
     * within ~1 s; a pending 2.5 s window must not delay them. `status`, `poll`
     * and `storage` are background signals and may merge into the window.
     * @param trigger - one trigger name.
     * @returns `true` for the three user-facing triggers.
     */
    function composerBarLiveIsUrgentTrigger(trigger) {
      const name = typeof trigger === 'string' ? trigger : '';
      return name === 'write' || name === 'manual' || name === 'visible';
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
     * The **assembly** region's fact, with the three states it really prints.
     *
     * The cell says three different things and they must never be conflated
     * (review BLOCK-1: folding `notice === null` to the same `null` as a failed
     * read made「加载失败」sticky — `nextRead` saw "unchanged" and kept the old
     * state, so the cell could never recover, not even on a manual refresh):
     *   - **`absent`** — the `/assembly-status` read itself failed (`read.assembly
     *     === null`); the cell prints「加载失败」({@link composerBarNoticeOf} sees
     *     an unusable payload);
     *   - **`none`** — the read succeeded but there is no key node (`record:
     *     null`); the cell prints the page's own「无观察」;
     *   - **a notice** — folded by everything the cell and its tooltip print:
     *     `assembled` / `kind` / `assembly.state` / `delivery.state` /
     *     `delivery.surfaceOp` (the tooltip is `assemblyVerdictOf` +
     *     `deliveryVerdictOf`, and `kind`/`state`/`surfaceOp` change those two
     *     sentences while `assembled`/`delivered` stay put).
     * @param payload - `read.assembly` (a payload, or `null` for a failed read).
     * @returns `'absent'` | `'none'` | the notice's folded fields.
     */
    function composerBarAssemblyFactOf(payload) {
      if (payload === null || typeof payload !== 'object') return 'absent';
      const notice = composerBarNoticeOf(payload);
      if (notice === null) return 'none';
      const assembly = notice.assembly !== null && typeof notice.assembly === 'object' ? notice.assembly : null;
      const delivery = notice.delivery !== null && typeof notice.delivery === 'object' ? notice.delivery : null;
      return {
        assembled: assembly !== null && assembly.assembled === true,
        kind: typeof notice.kind === 'string' ? notice.kind : null,
        assemblyState: assembly !== null && typeof assembly.state === 'string' ? assembly.state : null,
        deliveryState: delivery !== null && typeof delivery.state === 'string' ? delivery.state : null,
        surfaceOp: delivery !== null && typeof delivery.surfaceOp === 'string' ? delivery.surfaceOp : null,
      };
    }

    /**
     * The four facts the bar prints, as one comparable string.
     *
     * Only what the five regions **show** is folded in: the section count, the
     * two layers' `{kind,total,ineffective}`, and the assembly region's three-way
     * fact (see {@link composerBarAssemblyFactOf}). A timestamp the Host puts in
     * the snapshot (`generatedAt` is a fresh `new Date()` per request) must not
     * count as a change, or every read would re-render a bar that says exactly
     * the same thing.
     * @param state - `{snapshot, overrides, assembly}`.
     * @returns a stable signature (empty string for an unusable state).
     */
    function composerBarFactsSignature(state) {
      if (state === null || typeof state !== 'object') return '';
      const snapshot = state.snapshot === undefined ? null : state.snapshot;
      const overrides = state.overrides === undefined ? null : state.overrides;
      const user = composerBarLayerFact('user', snapshot, overrides);
      const workspace = composerBarLayerFact('workspace', snapshot, overrides);
      return JSON.stringify({
        sections: composerBarSectionCount(snapshot),
        user: [user.kind, user.total, user.ineffective],
        workspace: [workspace.kind, workspace.total, workspace.ineffective],
        assembly: composerBarAssemblyFactOf(state.assembly === undefined ? null : state.assembly),
      });
    }

    /**
     * Does this view state already hold an answer the bar can print?
     *
     * `ready` is the answer state — including one whose payloads came back `null`
     * (a failed read still prints the page's own「加载失败」line, which is an
     * answer, not a placeholder). This is the gate the signature comparison uses,
     * **not** "the phase is ready right now": a refresh deliberately keeps the
     * phase at `ready`, so the comparison stays reachable on the live path
     * (review BLOCK 1: it was previously only reachable on a first read).
     * @param state - a view state, or anything else.
     * @returns `true` when the state is an answer.
     */
    function composerBarHasAnswer(state) {
      return state !== null && typeof state === 'object' && state.phase === 'ready';
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
     * @param force - `true` for a different Session: its answer must replace the
     *   old one even when the four facts happen to look the same.
     * @returns the state to install (possibly `previous` itself).
     */
    function composerBarNextRead(previous, results, force) {
      const next = composerBarReadOf(results);
      if (force === true) return next;
      if (!composerBarHasAnswer(previous)) return next;
      return composerBarFactsSignature(previous) === composerBarFactsSignature(next) ? previous : next;
    }

    /**
     * Fold the Host's session-status snapshot into one **number**.
     *
     * The Host's `SessionStatusSnapshot` type is a read-only `Map` from `SessionId`
     * to `SessionStatus` (`dsh-client-ui-session` types, the
     * `GlobalStandardProps.useSessionStatus` hook); `SessionStatus` is
     * `{running, pendingInteraction, completionUnread}`. **A `Map` is not a plain object**: `Object.keys(map)`
     * is `[]`, so a tick built from it is a constant `0` and the status trigger
     * would be dead code on the real contract (review BLOCK-A — the previous
     * version also read `state`/`status`/`phase`, three fields the contract does
     * not have, so its unit case was a false positive). This folds the **real**
     * fields and accepts both shapes:
     *   - a `Map` (the Host's shape) is walked with `forEach`;
     *   - a plain object is walked with `Object.keys` — the arm an older or double
     *     Host answers with, and the one a unit case can write by hand.
     *
     * `useSessionStatus` is an external-store hook, so the answer must be a
     * **number** (a fresh object re-renders the subscriber forever) and must be
     * **deterministic**: the same snapshot always folds to the same value. The
     * fold is a polynomial over one canonical string per entry (sorted, so a
     * Map's iteration order cannot matter), never over object identity and never
     * through `JSON.stringify` (which has nothing to say about a `Map`).
     * @param map - the Host's status snapshot, or anything else.
     * @returns a stable non-negative number.
     */
    function composerBarSessionStatusTick(map) {
      if (map === null || typeof map !== 'object') return 0;
      const parts = [];
      try {
        if (typeof map.forEach === 'function') {
          map.forEach((entry, key) => {
            parts.push(`${String(key)}=${composerBarSessionStatusEntryOf(entry)}`);
          });
        } else {
          for (const key of Object.keys(map)) {
            parts.push(`${key}=${composerBarSessionStatusEntryOf(map[key])}`);
          }
        }
      } catch {
        return 0;
      }
      parts.sort();
      let tick = parts.length;
      for (const part of parts) {
        for (let index = 0; index < part.length; index += 1) {
          tick = (tick * 31 + part.charCodeAt(index)) % 100000007;
        }
        // A separator after every entry, so ("ab", "c") and ("a", "bc") differ.
        tick = (tick * 31 + 1) % 100000007;
      }
      return tick;
    }

    /**
     * One `SessionStatus` entry's contribution to the tick.
     *
     * Exactly the three fields the contract carries: `running`,
     * `completionUnread` and `pendingInteraction`. The interaction contributes by
     * its **stable identity** (`kind` + `key` + `sessionId`), not by object
     * identity — the Host is free to hand a fresh object for the same pending
     * interaction, and a tick that changed on that alone would read for nothing.
     * @param entry - one `SessionStatus`, or anything else.
     * @returns a canonical string (empty for an unusable entry).
     */
    function composerBarSessionStatusEntryOf(entry) {
      if (entry === null || typeof entry !== 'object') return '';
      const running = entry.running === true ? '1' : '0';
      const unread = entry.completionUnread === true ? '1' : '0';
      const interaction = entry.pendingInteraction;
      let pending = '';
      if (interaction !== null && typeof interaction === 'object') {
        const kind = typeof interaction.kind === 'string' ? interaction.kind : '';
        const key = typeof interaction.key === 'string' ? interaction.key : '';
        const sessionId = typeof interaction.sessionId === 'string' ? interaction.sessionId : '';
        pending = `${kind}/${key}/${sessionId}`;
      }
      return `${running}${unread}|${pending}`;
    }

    /**
     * Ask one resolved session-status seat for the tick, or answer 0.
     *
     * The seat is `{hook, selector}`, produced **once** by the live hook (see
     * there): the Host's `useSessionStatus` is a real hook and must be called on
     * every render, so its identity has to be stable for the life of the mount —
     * resolving it per render would make the call conditional and change the hook
     * count the moment props change (review BLOCK "一并修 1").
     * @param seat - `{hook, selector}`, or anything else.
     * @returns the tick (0 when the seat has no hook, or it throws).
     */
    function composerBarSessionTickOf(seat) {
      if (seat === null || typeof seat !== 'object' || typeof seat.hook !== 'function') return 0;
      try {
        // Called as a **bare function**, not `seat.hook(...)`: the Host's hook is
        // a React hook, not a method of this booking record.
        const hook = seat.hook;
        const value = hook(seat.selector);
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
      } catch {
        return 0;
      }
    }

    /**
     * The same question asked of an owner-props object (the `__internals` entry).
     *
     * Kept as a thin wrapper over {@link composerBarSessionTickOf} so the export a
     * unit case drives and the call the component really makes are one code path.
     * @param props - the entry's owner props.
     * @returns the tick (0 when the hook is unavailable).
     */
    function composerBarSessionTick(props) {
      const hook = props !== null && typeof props === 'object' ? props.useSessionStatus : undefined;
      if (typeof hook !== 'function') return 0;
      return composerBarSessionTickOf({ hook, selector: (map) => composerBarSessionStatusTick(map) });
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
      // Every timer is a **thin wrapper**, never the bare global. In a browser
      // `setTimeout` / `clearTimeout` are `Window` methods, and storing one in a
      // variable and later calling it as `io.setTimer(...)` sets `this` to `io` —
      // WebIDL then throws `TypeError: Illegal invocation` on the very first
      // render (the fallback poll is armed inside a mount effect). Node's timers
      // do not check `this`, which is exactly why 365 unit cases stayed green
      // while the real dock entry crashed. A wrapper makes the call a **bare
      // function call** again (`setTimeout(callback, delay)`), which browsers
      // accept. An injected source is invoked as a **method of the props object**
      // (`source.liveSetTimeout(...)`, i.e. `this === source`), which is all this
      // facade can promise: a fake whose functions close over their own state (the
      // unit cases) is unaffected, while one that expected to be called as a
      // method of some third object would not be.
      const setTimer =
        typeof source.liveSetTimeout === 'function'
          ? (callback, delay) => source.liveSetTimeout(callback, delay)
          : typeof setTimeout === 'function'
            ? (callback, delay) => setTimeout(callback, delay)
            : null;
      const clearTimer =
        typeof source.liveClearTimeout === 'function'
          ? (handle) => source.liveClearTimeout(handle)
          : typeof clearTimeout === 'function'
            ? (handle) => clearTimeout(handle)
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
      const now =
        typeof source.liveNow === 'function' ? () => source.liveNow() : () => composerBarLiveNow();
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
     * Cancel a deferred read (the coalescing window's timer).
     *
     * Two callers, for the same reason {@link stopLivePoll} has two: the effect's
     * next run and its teardown. A deferral armed while the tab was visible must
     * not fire into a hidden tab — that would be a request the goal forbids.
     * @param book - the hook's persistent booking record.
     * @param io - the resolved IO.
     */
    function cancelLiveDefer(book, io) {
      if (book === null || typeof book !== 'object') return;
      if (book.pendingTimer !== null) {
        if (io !== null && typeof io === 'object' && io.clearTimer !== null) {
          try {
            io.clearTimer(book.pendingTimer);
          } catch {
            // Already fired.
          }
        }
        book.pendingTimer = null;
      }
      book.dirty = false;
    }

    /**
     * The bar's data layer: read, and the four triggers that make it live.
     *
     * There is still exactly **one** read path — the effect below, keyed by
     * `[enabled, sessionId, nonce]` — and every trigger is `refresh(trigger)`,
     * i.e. one `setNonce`. That is what keeps g-086's guarantees intact: off and
     * no-Session still short-circuit *before* any `fetch`, a manual refresh still
     * costs exactly one read, and a Session change replaces the answer (the
     * `force` argument of {@link composerBarNextRead}) — with one honest caveat:
     * the previous Session's answer stays **on screen** until the new read lands,
     * because a refresh is not allowed to blank the row (review BLOCK 1). A Host
     * that unmounts and remounts the entry on a Session switch never shows that
     * window at all.
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
          /** The Session the last installed answer belongs to (forces a replace on switch). */
          lastSession: null,
        };
      }
      const book = bookRef.current;

      /**
       * The single entry point every trigger uses.
       *
       * `refresh` is re-created on every render (it closes over the current
       * `enabled` / `sessionId` / `io`), and {@link refreshRef} publishes it so the
       * long-lived effects — the bus subscription, the DOM listeners, the poll
       * chain — always call the **latest** one instead of the closure that was
       * current when they were registered. A stale closure here would judge a
       * trigger against an old Session or an old visibility state (review
       * "一并修 3").
       * @param trigger - `write` | `visible` | `manual` | `status` | `poll` | `storage`.
       * @returns the decision that was taken (`read` / `defer` / `dirty` / …).
       */
      const refresh = (trigger) => {
        // A queued deferral must not swallow a **user action**. `write`, `manual`
        // and `visible` are the goal's ≤1 s branches; merging into a window that
        // is already 1.5 s out would make the bar lag past that promise (review
        // B2). The queued read is cancelled and this trigger re-decides from the
        // shorter window it is entitled to.
        if (book.pendingTimer !== null && composerBarLiveIsUrgentTrigger(trigger)) {
          cancelLiveDefer(book, io);
        }
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
        // `manual` (the user's click) and `enable` (the switch) are the user
        // speaking and are honoured even on a hidden tab; every other trigger
        // re-checks visibility **at fire time**, because a deferral can outlive
        // the visibility it was armed under.
        const mayRead = () =>
          trigger === 'manual' || trigger === 'enable' || composerBarVisibleNow(io.document);
        const fire = () => {
          book.pendingTimer = null;
          if (!mayRead()) return false;
          book.lastTriggerAt = io.now();
          setNonce((value) => value + 1);
          return true;
        };
        if (decision.action === 'defer') {
          // A realm without a timer must still read: the wait is an optimisation,
          // not a requirement (the goal's ≤1 s applies to the write branch).
          if (io.setTimer === null) return fire() ? 'read' : 'skip';
          const timer = io.setTimer(fire, decision.delayMs);
          book.pendingTimer = timer === undefined ? null : timer;
          if (book.pendingTimer === null) return fire() ? 'read' : 'skip';
          return 'defer';
        }
        return fire() ? 'read' : 'skip';
      };
      const refreshRef = React.useRef(null);
      // A render-phase ref write on purpose: `refresh` is a pure function of this
      // render's props, publishing the latest one is the documented escape hatch,
      // and nothing reads the ref during a render.
      refreshRef.current = refresh;
      const triggerRead = (trigger) => {
        const current = refreshRef.current;
        return typeof current === 'function' ? current(trigger) : 'skip';
      };
      /** Is the tab hidden right now? (The read path's "may I install this?" gate.) */
      const hiddenNow = () => !composerBarVisibleNow(io.document);

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
        // **A refresh never rewrites the answer.** With a previous answer on screen
        // the phase stays `ready` and nothing is set, so the five cells keep their
        // exact text (and `aria-live` stays silent) until the new answer really
        // differs. Only the first read — or a read after off / no-Session — shows
        // `loading` (review BLOCK 1).
        setRead((current) =>
          composerBarHasAnswer(current)
            ? current
            : { phase: 'loading', snapshot: null, overrides: null, assembly: null },
        );
        // A round that has been replaced — or whose tab went hidden — stops
        // issuing its remaining requests: the three reads are serial, so a round
        // that kept going would either put two reads in flight at once (the one
        // thing the goal forbids) or keep the Host busy for a tab nobody is
        // looking at (review BLOCK 2).
        const stale = () => cancelled === true || book.round !== round || hiddenNow();
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
          const again = book.dirty === true;
          book.dirty = false;
          if (cancelled) return;
          // A hidden tab writes **nothing**: the answer is dropped and the next
          // `visible` trigger re-reads. That is both "hidden must not write state"
          // and "returning reads once" (review BLOCK 2).
          if (hiddenNow()) return;
          const changedSession = book.lastSession !== sessionId;
          book.lastSession = sessionId;
          if (results !== null) setRead((current) => composerBarNextRead(current, results, changedSession));
          // A trigger that landed mid-flight gets exactly one follow-up read — and
          // only where the tab is still visible (checked just above).
          if (again) setNonce((value) => value + 1);
        };
        void load();
        return () => {
          cancelled = true;
        };
      }, [enabled, sessionId, nonce]);

      // ── the Session status trigger (the one client event that exists) ───────
      // The Host hook is resolved **once** (on mount) and then called on every
      // render, unconditionally: `useSessionStatus` is a real hook, so calling it
      // only when the prop happens to be a function would change the hook count
      // the moment props change (review "一并修 1"). The resolved identity is
      // stable for the life of the mount, which is what React requires.
      const sessionSeatRef = React.useRef(null);
      if (sessionSeatRef.current === null) {
        sessionSeatRef.current = {
          hook: typeof props.useSessionStatus === 'function' ? props.useSessionStatus : null,
          selector: (map) => composerBarSessionStatusTick(map),
        };
      }
      const activity = composerBarSessionTickOf(sessionSeatRef.current);
      const activityRef = React.useRef(null);
      React.useEffect(() => {
        // The first observation is the mount's own read, not a change.
        if (activityRef.current === null) {
          activityRef.current = activity;
          return;
        }
        if (activityRef.current === activity) return;
        activityRef.current = activity;
        triggerRead('status');
      }, [activity]);

      // ── writes, visibility, focus, storage, and the fallback timer ──────────
      const pollMs = io.pollMs;
      const storage = io.storage;
      React.useEffect(() => {
        // The write funnel has no props, so this is where an injected storage
        // becomes the probe's destination (review "一并修 2").
        setComposerBarLiveProbeStorage(storage);
        return () => setComposerBarLiveProbeStorage(null);
      }, [storage]);
      React.useEffect(() => {
        // Teardown is also done at the **start** of every run, not only in the
        // cleanup: a renderer that never calls a cleanup (this bundle's unit-test
        // double is one) must not accumulate timers and listeners across renders,
        // and doing it here makes the effect idempotent either way.
        stopLivePoll(book, io);
        cancelLiveDefer(book, io);
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
        addDisposer(subscribeComposerBarLive(() => triggerRead('write')));
        const armPoll = () => {
          stopLivePoll(book, io);
          if (pollMs <= 0 || io.setTimer === null) return;
          // A hidden tab arms nothing at all: no timer, no request, no wake-up.
          if (!composerBarVisibleNow(doc)) return;
          const timer = io.setTimer(() => {
            book.pollTimer = null;
            if (!composerBarVisibleNow(doc)) return;
            triggerRead('poll');
            armPoll();
          }, pollMs);
          book.pollTimer = timer === undefined ? null : timer;
        };
        if (doc !== null && typeof doc.addEventListener === 'function') {
          const onVisibility = () => {
            if (composerBarVisibleNow(doc)) {
              triggerRead('visible');
              armPoll();
            } else {
              // Hidden means: no poll, **and** no queued deferral that would fire
              // into a hidden tab (review BLOCK 2).
              stopLivePoll(book, io);
              cancelLiveDefer(book, io);
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
            if (composerBarVisibleNow(doc)) triggerRead('visible');
          };
          const onStorage = (event) => {
            // The key is the message; the value is never trusted (it names a route
            // this tab did not fetch).
            const key =
              event !== null && typeof event === 'object' && typeof event.key === 'string'
                ? event.key
                : COMPOSER_BAR_LIVE_KEY;
            if (key !== COMPOSER_BAR_LIVE_KEY) return;
            triggerRead('storage');
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
          cancelLiveDefer(book, io);
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

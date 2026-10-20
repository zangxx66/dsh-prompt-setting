// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。
    // #region launch shape (g-036)
    /**
     * The three launch shapes the restart copy is partitioned into.
     *
     * The host judges the shape from the official profile name
     * (`core/launch-kind.js`) and reports it as `launchKind` on the ping; this
     * page only has to pick a key. Choosing is deliberately *not* a
     * re-derivation: a browser cannot see the Host's profile, and a second
     * judgement would be a second thing to keep in sync.
     */
    const LAUNCH_KIND_CLI = 'cli';
    const LAUNCH_KIND_DESKTOP = 'desktop';
    const LAUNCH_KIND_UNKNOWN = 'unknown';
    /**
     * Which dictionary key each g-036 copy family uses per launch shape.
     *
     * The bare key is the `unknown` copy — what an old host (no `launchKind`), a
     * failed ping or an unrecognized value get — and its text names no launch
     * form, so a terminal user and a desktop user can both follow it. The
     * mapping is an **explicit table**, never string concatenation: every
     * sentence this page shows comes from the registered dictionaries, and a key
     * built at render time is exactly how one of them goes missing unnoticed.
     */
    const UPDATE_APPLY_COPY_KEYS = Object.freeze({
      restartNote: Object.freeze({
        cli: 'updateApplyRestartNoteCli',
        desktop: 'updateApplyRestartNoteDesktop',
        unknown: 'updateApplyRestartNote',
      }),
      done: Object.freeze({
        cli: 'updateApplyDoneCli',
        desktop: 'updateApplyDoneDesktop',
        unknown: 'updateApplyDone',
      }),
      already: Object.freeze({
        cli: 'updateApplyAlreadyCli',
        desktop: 'updateApplyAlreadyDesktop',
        unknown: 'updateApplyAlready',
      }),
      unknownState: Object.freeze({
        cli: 'updateApplyUnknownCli',
        desktop: 'updateApplyUnknownDesktop',
        unknown: 'updateApplyUnknown',
      }),
    });

    /**
     * Fold whatever the ping answered into the three-state enum.
     *
     * Only the two decided values survive; `undefined` (an old host that never
     * sent the field), `null` (a failed ping) and any other spelling become
     * `'unknown'`, which is the copy both launch shapes can follow.
     * @param value - `boot.launchKind`, or anything else.
     * @returns one of the three launch kinds.
     */
    function normalizeLaunchKind(value) {
      return value === LAUNCH_KIND_CLI || value === LAUNCH_KIND_DESKTOP ? value : LAUNCH_KIND_UNKNOWN;
    }

    /**
     * The launch shape one page model is rendering for.
     * @param model - the page model, or anything else.
     * @returns one of the three launch kinds.
     */
    function modelLaunchKind(model) {
      const boot = model === null || model === undefined ? null : model.boot;
      return normalizeLaunchKind(boot === null || boot === undefined ? null : boot.launchKind);
    }

    /**
     * The dictionary key for one g-036 copy family and launch shape.
     * @param family - a key of {@link UPDATE_APPLY_COPY_KEYS}.
     * @param launchKind - the value the host's ping carried.
     * @returns the key to translate; never `undefined`.
     */
    function updateApplyCopyKey(family, launchKind) {
      const table = UPDATE_APPLY_COPY_KEYS[family];
      if (table === undefined) return 'updateApplyUnknown';
      const key = table[normalizeLaunchKind(launchKind)];
      return typeof key === 'string' ? key : 'updateApplyUnknown';
    }
    // #endregion

    // #region primitives probe
    // Never let the probe throw past this factory: a failure here must degrade
    // to the hand-built renderer, not blank the settings panel.
    let primitivesModule = null;
    let primitivesFailure = '';
    try {
      primitivesModule = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      primitivesModule = null;
      primitivesFailure = error && error.message ? String(error.message) : String(error);
    }
    const primitives =
      primitivesModule !== null && typeof primitivesModule === 'object' ? primitivesModule : null;
    /**
     * The brand one React factory stamps on the component **object** it returns,
     * read off a real product of this Host's factory.
     *
     * `React.forwardRef` hands back `{ $$typeof, render }` and `React.memo`
     * `{ $$typeof, type }`; both are components, both are `typeof === 'object'`.
     * Reading the brand from React itself keeps this file from restating a
     * string React owns — a React double without that factory answers
     * `undefined` and the documented `Symbol.for(...)` spelling still applies.
     * @param factory - `React.forwardRef` / `React.memo`, or anything at all.
     * @param argument - what that factory accepts (a render function / component).
     * @returns the brand, or `undefined` when it cannot be observed.
     */
    function reactFactoryBrand(factory, argument) {
      if (typeof factory !== 'function') return undefined;
      try {
        const product = factory(argument);
        return product !== null && typeof product === 'object' && typeof product.$$typeof === 'symbol'
          ? product.$$typeof
          : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * The component kinds that are **objects** rather than functions: brand →
     * the structural field that must be there too.
     *
     * Only the two shapes this page's atoms can arrive in are listed, and each
     * one is validated structurally (`render` is a function; `type` is itself a
     * component), so an object that merely *claims* a brand — or carries a kind
     * this page cannot render — is **not** mistaken for a component. The brand
     * value comes from React's own factories above, with `Symbol.for(...)` —
     * React's global-registry spelling, shared by the Host's React copy and
     * this plugin's — as the documented fallback.
     */
    const OBJECT_COMPONENT_FIELDS = new Map();
    {
      const registrySymbol = (key) =>
        typeof Symbol === 'function' && typeof Symbol.for === 'function' ? Symbol.for(key) : undefined;
      const brands = [
        [reactFactoryBrand(React.forwardRef, () => null), 'render'],
        [reactFactoryBrand(React.memo, () => null), 'type'],
        [registrySymbol('react.forward_ref'), 'render'],
        [registrySymbol('react.memo'), 'type'],
      ];
      for (const [brand, field] of brands) {
        if (typeof brand === 'symbol' && !OBJECT_COMPONENT_FIELDS.has(brand)) OBJECT_COMPONENT_FIELDS.set(brand, field);
      }
    }

    /**
     * Is this export value something React can render?
     *
     * `typeof === 'function'` is the whole story only for function components:
     * `React.forwardRef(...)` — which is exactly what the Host's `Button` and
     * `Input` are — returns an object, so a probe keyed on `typeof` alone reads
     * every `forwardRef` atom as absent. That is why this page spent its whole
     * life on the hand-built renderer while the official atoms were right there
     * (g-063).
     *
     * Deliberately conservative in the other direction: an object whose brand is
     * unknown, whose brand-carrying field is missing (or is not a function),
     * answers **false** — which keeps the page on the hand-built renderer
     * instead of handing React a type it cannot render.
     * @param value - one export of a candidate module namespace.
     * @returns `true` when React can render it.
     */
    function isComponentExport(value) {
      if (typeof value === 'function') return true;
      if (value === null || value === undefined || typeof value !== 'object') return false;
      let brand;
      try {
        brand = value.$$typeof;
      } catch {
        return false;
      }
      const field = OBJECT_COMPONENT_FIELDS.get(brand);
      if (field === undefined) return false;
      let inner;
      try {
        inner = value[field];
      } catch {
        return false;
      }
      // `memo` wraps another component (possibly a `forwardRef` one);
      // `forwardRef` wraps the render function it was handed.
      return field === 'type' ? isComponentExport(inner) : typeof inner === 'function';
    }

    /**
     * {@link isComponentExport} asked of one namespace member, never a throw.
     *
     * A namespace member behind a throwing getter must read as "not usable"
     * (the fallback renderer draws instead), never take the page down: the whole
     * probe is fail-open.
     * @param namespace - a candidate module namespace, or nothing at all.
     * @param name - the export to ask about.
     * @returns `true` when that export is a component React can render.
     */
    function hasComponentExport(namespace, name) {
      if (namespace === null || namespace === undefined) return false;
      try {
        return isComponentExport(namespace[name]);
      } catch {
        return false;
      }
    }

    /**
     * Does one namespace carry the atoms this page draws?
     *
     * Extracted so the **renderer** probe and the **toast** probe (which may
     * unwrap) can ask the same question of different candidates without either
     * one restating the rule. g-063: the question is asked with
     * {@link hasComponentExport}, because the Host's `Button` is a `forwardRef`
     * component and `typeof` it is `'object'`, not `'function'`.
     * @param namespace - a candidate module namespace.
     * @returns `true` only for an object whose `Button` really is a component.
     */
    function isPrimitivesNamespace(namespace) {
      return namespace !== null && typeof namespace === 'object' && hasComponentExport(namespace, 'Button');
    }
    const primitivesUsable = isPrimitivesNamespace(primitives);
    /** Which renderer this module instance **probed** for: 'primitives' | 'fallback'. */
    const RENDERER = primitivesUsable ? 'primitives' : 'fallback';
    /**
     * Whether the Host's atoms have already thrown **while React rendered them**
     * (g-063, review E1).
     *
     * A different failure from the probe's, and reachable only now that this page
     * really enters the primitives branch: the probe can only see `require`
     * returning a namespace, while React calls the component long after that. The
     * error boundary below flips this the moment a Host atom throws mid-render,
     * and **every** branch decision made after the flip is the hand-built one —
     * which is what turns "the official `Button` blew up" into "the page keeps
     * drawing" instead of a blank panel.
     */
    let primitivesRenderFailed = false;
    /** The boundary's one-line account of that failure, for the diagnosis rows. */
    let primitivesRenderFailure = '';
    /**
     * Is the Host's atom set the one **this** render should use?
     *
     * Exactly `RENDERER === 'primitives'`, plus "and it has not blown up yet".
     * One place decides, so the atoms, the tab control, the icons and the diff
     * block can never disagree about which renderer is in force.
     * @returns `true` when this render may draw the Host's atoms.
     */
    function primitivesActive() {
      return RENDERER === 'primitives' && !primitivesRenderFailed;
    }
    /** Which renderer the page is **really** using right now, for its markers. */
    function activeRenderer() {
      return primitivesActive() ? 'primitives' : 'fallback';
    }
    /**
     * Record a render-time failure of the Host's atoms and settle this module
     * instance on the hand-built renderer for good.
     *
     * Deliberately **one-way**: a component that threw once is not retried on
     * the next render, because retrying is exactly what would let the same
     * failure take the whole subtree down twice.
     * @param error - the thrown value.
     */
    function capturePrimitivesRenderFailure(error) {
      primitivesRenderFailed = true;
      primitivesRenderFailure = error && error.message ? String(error.message) : String(error);
    }
    /**
     * Which folder/caret artwork the tree actually renders. The primitives
     * module is used when it really exposes the sidebar's icon components;
     * otherwise the identical inlined geometry is drawn (NOTES §54).
     *
     * A function, not a constant: after a render-time failure the icons must
     * fall back with everything else (g-063 E1).
     * @returns `'primitives'` or `'inline'`.
     */
    function iconSource() {
      return primitivesActive() &&
        hasComponentExport(primitives, 'IconFolderOpenRegular') &&
        hasComponentExport(primitives, 'IconFolderCloseRegular') &&
        hasComponentExport(primitives, 'IconTriangleRightFillRegular')
        ? 'primitives'
        : 'inline';
    }
    /**
     * g-062 fix round: the one interop gap a direct property read can fall into.
     *
     * A CJS `require` of an ESM module may hand back a **wrapper** whose named
     * exports sit on `.default` (the `__toESM(mod, 1)` shape every official
     * client bundle normalizes: `dshmarket/client/client.js:30`). The wrapper is
     * still an object, so it passes the "is this an object" check and then has
     * no `Toast` on it — and a probe that only looked at the top level would
     * report "this Host has no Toast" about a Host that has one.
     *
     * `undefined` means **no wrapper** (this is the flat shape, take it as it
     * is); an object means the caller must use that object instead.
     * @param module - the raw result of the `require`.
     * @returns the unwrapped namespace, or `undefined` when there is none.
     */
    function unwrapNamespaceDefault(module) {
      if (module === null || typeof module !== 'object') return undefined;
      if (typeof module.default !== 'object' || module.default === null) return undefined;
      return module.default;
    }

    /**
     * g-062 (Revision 46): can this Host show a toast at all?
     *
     * Probed, never assumed — and probed **independently** of `Button`, which is
     * what `RENDERER` keys on: a Host may ship the atoms this page draws while
     * predating the `Toast` primitive (the peer range starts at `0.2.1-0` and
     * the version that added `Toast` is not pinned), so one probe cannot answer
     * both questions. When this is false the toaster is never registered and the
     * settings-page block stays the only surface — the documented degradation,
     * not an error.
     *
     * That independence is now **structural**, not just a comment: the toast
     * side may unwrap an interop wrapper, while `primitives` / `primitivesUsable`
     * / `RENDERER` keep reading the raw module exactly as before (the lead's
     * boundary for this round: fix the toast, leave the settings page's renderer
     * branch alone).
     */
    const toastPrimitivesModule = unwrapNamespaceDefault(primitivesModule);
    const toastPrimitives =
      hasComponentExport(toastPrimitivesModule, 'Toast')
        ? toastPrimitivesModule
        : hasComponentExport(primitives, 'Toast')
          ? primitives
          : null;
    const HAS_TOAST = toastPrimitives !== null;
    /**
     * The namespace the toast question was really asked of: the wrapper's
     * `.default` when there is one, otherwise the module. `undefined` means the
     * `require` failed outright, and then there is nothing to inspect at all.
     */
    const toastProbeTarget = toastPrimitives !== null ? toastPrimitives : toastPrimitivesModule;
    /** Which shape the toast namespace came from, for the diagnosis line. */
    const toastNamespaceSource =
      toastPrimitives === null ? 'none' : toastPrimitives === toastPrimitivesModule ? 'default' : 'module';
    /**
     * The probe's last step, kept as one value so the diagnostics section can
     * only restate what this decision really used.
     *
     * g-063 wrap-up: the two **always-on** diagnostic rows (the `require`
     * details and the `Button`/`Toast` `typeof` table) were removed once they had
     * done their job — g-062's fix round and g-063 added them to locate the
     * `forwardRef` defect on a real machine, and the branch is settled now. What
     * remains is exactly what the surviving rows read: the namespace the toast
     * decision used (`toastSource`, printed on the toast row) and the branch in
     * use (`renderer`); the render-time failure record lives outside this object
     * (`primitivesRenderFailed` / `primitivesRenderFailure`) because it is a
     * runtime fact, not a load-time probe result.
     */
    const primitivesProbe = {
      toastSource: toastNamespaceSource,
      renderer: primitivesUsable ? 'primitives' : 'fallback',
    };
    /**
     * g-062 (Revision 46, review C4): is an overlay toaster **really** there?
     *
     * `HAS_TOAST` answers "can this Host draw a toast"; this seat answers "is one
     * actually registered". They are different questions and the difference is
     * visible to the user: a Host that exposes the primitive but never declares
     * the `shell.overlay` slot gets **no** overlay at all, and a page that keyed
     * its degradation notice off `HAS_TOAST` alone would stay silent — "no
     * notice" and "not working" would look identical, which is the one outcome
     * this feature must never produce.
     *
     * Three states, none of them a guess: `ready` (the slot was declared and the
     * entry is registered), `failed` (the Host declared it and refused the
     * registration), and `pending` (this Host has not declared the slot — and
     * since `slots.inject` runs synchronously for a slot that already exists,
     * that is what a Host without the slot looks like forever). `absent` is
     * decided up front by the capability probe, before any slot is involved.
     */
    const overlaySeat = {
      state: HAS_TOAST ? 'pending' : 'absent',
      listeners: new Set(),
      revision: 0,
    };

    /** The seat's snapshot for `useSyncExternalStore` — a counter, never an object. */
    function overlaySeatRevision() {
      return overlaySeat.revision;
    }

    /**
     * Subscribe to seat changes.
     * @param listener - called after the seat's state changed.
     * @returns the unsubscribe.
     */
    function subscribeOverlaySeat(listener) {
      overlaySeat.listeners.add(listener);
      return () => {
        overlaySeat.listeners.delete(listener);
      };
    }

    /**
     * Record what really happened to the overlay registration.
     *
     * Called from the slot callback (never during a render), so notifying
     * subscribers here is an ordinary update rather than an update-during-render.
     * @param state - `'ready'` or `'failed'`.
     */
    function markOverlaySeat(state) {
      if (overlaySeat.state === state) return;
      overlaySeat.state = state;
      overlaySeat.revision += 1;
      for (const listener of [...overlaySeat.listeners]) {
        try {
          listener();
        } catch {
          // One subscriber that throws must not cost the others their update.
        }
      }
    }
    // #endregion

    /** Locale namespace owned by this plugin (zh/en dictionaries are inlined). */
    const NS = 'settings.promptSetting';
    /** Stage 1A probe route; kept as a renderer-reporting side channel. */
    const PING_PATH = '/prompt-setting/ping';
    const SNAPSHOT_PATH = '/prompt-setting/snapshot';
    const OVERRIDES_PATH = '/prompt-setting/overrides';
    /** Stage 2 routes (CONTRACT.md Revision 4). */
    const HISTORY_PATH = '/prompt-setting/history';
    const DIFF_PATH = '/prompt-setting/diff';
    /**
     * g-039: move one layer back to a recorded version. The only **write** the
     * version-history tab can start, and the reason the rollback button is the
     * one control on a record row that asks for a second confirmation.
     */
    const ROLLBACK_PATH = '/prompt-setting/rollback';
    const EXPORT_PATH = '/prompt-setting/export';
    const IMPORT_PATH = '/prompt-setting/import';
    /**
     * Revision 9: the「我的 Prompt」variable-substitution switch. Its own route
     * because it is a config-level fact, not a property of one override.
     */
    const INTERPOLATE_PATH = '/prompt-setting/interpolate';
    /**
     * g-030: the upstream update check and its on/off switch — one route,
     * because the `GET` that answers "is there a newer release" also reports
     * whether checking is on at all.
     */
    const UPDATE_CHECK_PATH = '/prompt-setting/update-check';
    /**
     * g-043:「下载区域」— which source the check and the install use.
     *
     * `GET` reads the choice (and, on the very first visit, lets the Host decide
     * it by availability); `PUT {region, registry?}` records one, with a `custom`
     * address validated by the Host **before** anything is written. The page never
     * probes a registry itself: CORS would make that a lie in the browser, and the
     * address is untrusted input (§17.8).
     */
    const DOWNLOAD_REGION_PATH = '/prompt-setting/download-region';
    /**
     * g-060 (Revision 37): the preset library — the user's own catalogue of
     * texts for the reserved section.
     *
     * Three paths, mirroring the host half exactly: the catalogue
     * (`GET` / `PUT` / `DELETE ?id=`) and the two layer actions (`apply`,
     * `unapply`). The catalogue routes never name a layer; the two actions take
     * the `session` of the workspace they act on, which is the only identity the
     * host can resolve a root from (`CONTRACT.md` §4.2, §20).
     */
    const PRESETS_PATH = '/prompt-setting/presets';
    // g-082: the library's own tag set — one upsert (`PUT`) and one deletion
    // (`DELETE ?id=`) that cascades through every preset's `tagIds`.
    const PRESETS_TAGS_PATH = '/prompt-setting/presets/tags';
    const PRESETS_APPLY_PATH = '/prompt-setting/presets/apply';
    const PRESETS_UNAPPLY_PATH = '/prompt-setting/presets/unapply';
    /**
     * g-062:「装配状态提示」— one path, two methods.
     *
     * `GET ?session=` answers the observation for one conversation (the last key
     * node's assembly-layer and delivery-layer verdicts) plus the switch's state;
     * `GET ?since=` answers the incremental feed the shell-overlay toaster reads
     * (no session needed, each notice tagged with its conversation); `PUT
     * {enabled}` records the switch. Neither surface reaches the model: a notice
     * never enters the model context, costs no tokens and does not change the
     * prompt an assembly returns.
     */
    const ASSEMBLY_STATUS_PATH = '/prompt-setting/assembly-status';
    /**
     * How long the page waits before re-reading a notice whose delivery layer is
     * still `waiting` (g-062). Short enough to settle within one step and long
     * enough to cost one request, not a poll loop.
     */
    const ASSEMBLY_POLL_MS = 2500;
    /**
     * g-062 (Revision 46): the toaster's own cadence.
     *
     * The **primary** trigger is an event the client really has — a change in the
     * session status map the shell hands to a `shell.overlay` entry — and the
     * timer below is only the fallback for a Host whose hook is missing or whose
     * event was dropped. Everything is visibility-aware: a hidden tab does not
     * poll (browser timers are throttled there anyway) and re-reads the moment it
     * becomes visible, which is exactly what "you see it when you come back"
     * means. There is no push channel to subscribe to: DSH exposes no plugin
     * `EventSource`, and the one WebSocket the page owns is the Host's own RPC
     * mux, so a low-frequency read is the honest transport.
     */
    const ASSEMBLY_TOAST_POLL_MS = 20000;
    /** Shortest gap between two reads triggered by session-status changes. */
    const ASSEMBLY_TOAST_MIN_GAP_MS = 3000;
    /** How long one toast holds at full opacity before it fades. */
    const ASSEMBLY_TOAST_HOLD_MS = 7000;
    /** How many notices one session's toaster will queue at once. */
    const ASSEMBLY_TOAST_LIMIT = 4;
    /** Bumped when the stored cursor's shape changes; an older shape is dropped. */
    const ASSEMBLY_TOAST_CURSOR_VERSION = 1;
    /**
     * Where this **tab** keeps its cursor.
     *
     * `sessionStorage`, not `localStorage`: the cursor answers "which notices has
     * this tab already shown", and two tabs sharing one key would let the first
     * to advance the second's cursor (a lost toast) or have both replay it (the
     * one thing the goal forbids). It survives a reload, which is what keeps a
     * notice from being toasted twice after one.
     */
    const ASSEMBLY_TOAST_STORE_KEY = 'dsh-prompt-setting:assembly-toast-cursor';
    /** The three region ids, in dropdown order — the only values the contract accepts. */
    const DOWNLOAD_REGIONS = ['default', 'cn', 'custom'];
    /**
     * The switch's local mirror (g-030).
     *
     * The authoritative preference lives in the Host's `preferences.json`, but a
     * page that has seen "off" needs no round trip to know it must not ask: the
     * mirror is what makes "关闭后零网络请求（含页面挂载时）" true of the page as
     * well as of the Host. It is a cache — never the source of truth — so a
     * missing `localStorage`, a quota error or a hand-edited value all degrade to
     * "ask once, then let the Host answer".
     */
    const UPDATE_PREF_KEY = 'dsh-prompt-setting.updateCheck';
    /**
     * g-032: 「立即更新」— the install route the host owns.
     *
     * `POST` starts an install and answers with a `requestId` **immediately**,
     * `GET ?requestId=` reports its phase and `POST .../cancel` stops it. The
     * page polls the `GET` because an install legitimately takes minutes (a
     * profile lock wait plus pnpm's own silence timeout), and because the host's
     * own record is the only one that survives a page reload.
     */
    const UPDATE_APPLY_PATH = '/prompt-setting/update-apply';
    /** The cancel face of the same request. */
    const UPDATE_APPLY_CANCEL_PATH = '/prompt-setting/update-apply/cancel';
    /** How often the page asks for the install's phase, and the two bounds on that loop. */
    const UPDATE_APPLY_POLL_MS = 1500;
    const UPDATE_APPLY_POLL_MAX_MS = 5000;
    /**
     * The longest a poll loop may run before it stops asking and says so.
     *
     * The host's own worst case is bounded (a ~2 min lock wait plus a 10 min
     * silence timeout), so a loop that outlives this is not waiting for an
     * install any more — it is waiting for a host that went away. Stopping is
     * what keeps a backgrounded page from polling forever.
     */
    const UPDATE_APPLY_POLL_BUDGET_MS = 16 * 60 * 1000;
    /** Sentinel for "no session": never a legal `Agent.id`, so it cannot collide. */
    const GLOBAL_SESSION = '\u0000global';
    /**
     * The reserved section name — the *only* name any write route accepts
     * since Revision 7 (CONTRACT.md §15.1). It is the literal twin of
     * `CUSTOM_SECTION_NAME` in `core/custom.js`: a browser module cannot import
     * host code, so the two copies are kept in sync **by assertion** rather
     * than by construction — `test/client.test.mjs` imports the constant from
     * `core/custom.js` and compares it, character for character, with the name
     * this page puts into every save and delete it sends.
     */
    const RESERVED_SECTION_NAME = 'prompt-setting:custom-prompt';
    /**
     * The actions the reserved name accepts on `PUT` (§4.1): `replace` (覆盖)
     * covers the other layer, and — since Revision 36, g-058 — `append` (叠加)
     * stacks this layer's text after it. The list is the twin of
     * `RESERVED_WRITABLE_ACTIONS` in `core/custom.js`, and the two are compared
     * by `test/client.test.mjs` rather than by construction (a browser module
     * cannot import host code).
     */
    const RESERVED_SECTION_MODES = ['replace', 'append'];
    /** The mode a save sends when the layer stores none (the historical default). */
    const RESERVED_SECTION_DEFAULT_MODE = 'replace';
    /**
     * The six first-level tabs, in the fixed order they are presented.
     * 「我的 Prompt」 is first and is the default: it is the only write surface
     * for the reserved section's **text**, so it is where a user who opened this
     * page for a reason lands. g-038 split the old 「历史与备份」 in two:
     * 「版本历史」 is the log and its comparison, 「备份与恢复」 is export/import —
     * one tab may no longer be both a read-only log and the page's way to
     * overwrite every file. g-060 adds 「预设」 directly after 「我的 Prompt」: it is
     * the catalogue of named texts that tab writes, so the two sit together.
     */
    const MAIN_TABS = ['mine', 'presets', 'overview', 'history', 'backup', 'advanced'];
    /**
     * The two *read-only* views inside 「提示词总览」. `sections` is the
     * assembled segment list; `full` is the assembled text. The Revision 6
     * `overrides` view is gone from this list: its read-only half moved to
     * 「高级」, and its history/transfer halves to the two tabs g-038 split them
     * into (「版本历史」 / 「备份与恢复」).
     */
    const VIEWS = ['sections', 'full'];
    /** The layers 「我的 Prompt」 may write to, in presentation order. */
    const LAYERS = ['user', 'workspace'];
    /** CONTRACT.md §2.2 — the four `origin` values, in presentation order. */
    const ORIGINS = ['registered', 'appended', 'downstream-added', 'unmatched-override'];
    const LAYER_FILTERS = ['all', 'default', 'user', 'workspace'];
    const OVERRIDABLE_FILTERS = ['all', 'yes', 'no'];
    const ORIGIN_FILTERS = ['all', 'registered', 'appended', 'downstream-added', 'unmatched-override'];
    /** Upper bound on rendered lines put into the DOM (a long prompt is real). */
    const MAX_VIEW_LINES = 3000;
    /**
     * g-039 (third round): the「版本历史」panel is bounded by the **viewport**,
     * not by a fixed px height per scroll box.
     *
     * The boxes used to be `320px` each, and the two columns were allowed to
     * wrap, which is what made the page scroll: at the settings dialog's width
     * the columns stacked, so choosing a record and reading the result were one
     * screen apart. The panel now takes its height from the viewport and the
     * **columns never stack**, so the only thing that scrolls is a column's own
     * content.
     *
     * g-039 (fourth round): how much of the viewport is really available is
     * **measured at run time** ({@link historyPanelHeight}) instead of guessed,
     * because this card renders inside the settings dialog and the room left
     * above it is the dialog's business, not this bundle's. The constants below
     * are the **fallback** path, used whenever the measurement is not usable
     * (no layout, a zero-sized rect, no `window`): a panel a few pixels shorter
     * than the space it has costs nothing, while a panel a few pixels taller is
     * exactly the page scrollbar this layout removes. `HISTORY_PANEL_MIN_HEIGHT`
     * is the floor for a very short window: below it the page scrolls rather
     * than rendering two useless slivers.
     */
    const HISTORY_VIEWPORT_OFFSET = 260;
    const HISTORY_PANEL_HEIGHT = `calc(100vh - ${HISTORY_VIEWPORT_OFFSET}px)`;
    const HISTORY_PANEL_MIN_HEIGHT = 320;
    /**
     * Room kept between the panel's bottom edge and its measured boundary.
     *
     * g-044: 8, not 16. The number is subtracted from a **measured** room (it is
     * never an estimate of the dialog's own chrome), so halving it hands the
     * list eight more pixels at no risk of the panel crossing its boundary —
     * measured at 1440×900 the panel went 480 → 488 (CONTRACT §13.2, Revision 27).
     */
    const HISTORY_PANEL_GAP = 8;
    /**
     * g-039 fourth round: `useLayoutEffect` measures **before the paint**, which
     * is what a panel sized from its own position wants — measuring after the
     * paint would show one frame at the fallback height. A runtime without it
     * (an old React, a test double) falls back to `useEffect`, where the panel is
     * simply sized one paint later.
     */
    const useLayoutEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect;
    /**
     * g-038: the fixed height (px) of the version history's **scope candidate
     * list**. The scope selector is a disclosure whose picker renders inside
     * this box, so opening it costs one row plus a fixed list however many
     * workspaces exist — the same reason the record list above has a box.
     */
    const HISTORY_SCOPE_LIST_HEIGHT = 200;
    /** Conflict strategies the import panel offers (CONTRACT §11.4). */
    const IMPORT_MODES = ['merge', 'replace'];
    /** Upper bound on the JSON preview the panel keeps in the DOM. */
    const MAX_EXPORT_PREVIEW = 20000;
    /** Upper bound on collapsed diff lines rendered by the fallback branch. */
    const MAX_DIFF_LINES_SHOWN = 400;
    /** Bound handed to the primitives `DiffBlock` (its own collapse default is smaller). */
    const DIFF_BLOCK_MAX_LINES = 200;
    /** The two ends of a comparison; `current` is the live layer, not a record. */
    const DIFF_CURRENT = 'current';
    /**
     * Upper bound on session rows rendered at once in the flat (degraded)
     * list. The session catalog grows with use (every session ever opened is a
     * row), so the picker may never render the whole list.
     */
    const SESSION_MATCH_LIMIT = 20;
    /**
     * Bounds of the workspace tree. The tree renders a *window* over the
     * catalog in every case: at most {@link SCOPE_GROUP_PAGE} session rows per
     * expanded workspace group, raised by {@link SCOPE_GROUP_STEP} per
     * 「显示更多」 click up to {@link SCOPE_GROUP_MAX}, and never more than
     * {@link SCOPE_TOTAL_MAX} session rows or {@link SCOPE_GROUP_LIMIT} group
     * headers overall (the group holding the current session may add exactly
     * one header when it falls outside that slice).
     */
    const SCOPE_GROUP_PAGE = 10;
    const SCOPE_GROUP_STEP = 10;
    const SCOPE_GROUP_MAX = 50;
    const SCOPE_TOTAL_MAX = 100;
    const SCOPE_GROUP_LIMIT = 40;


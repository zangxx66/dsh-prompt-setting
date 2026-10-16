
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
     * predating the `Toast` primitive (the peer range starts at `0.1.7-rc.2` and
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

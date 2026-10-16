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
        ctx.effect(
          () =>
            typeof locale?.register === 'function' ? locale.register(NS, { zh, en }) : undefined,
          'prompt-setting: section dictionaries',
        );

        const canSubscribe = typeof locale?.subscribe === 'function';
        const canReadRevision = typeof locale?.getSnapshot === 'function';

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

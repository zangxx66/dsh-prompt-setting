// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。

    /**
     * g-086: the resident assembly bar above the composer.
     *
     * One read-only line in the Host's `conversation.input.dock` slot — "full-width
     * entries above the composer card" (Host contract 0.2.1-rc.3). Four properties
     * are load-bearing:
     *   - **a list entry, never a shadow** — the slot is `kind: 'list'`, so this
     *     registration is appended beside the shipped ones (`queue`, `todo`);
     *     `ctx.slots.inject` runs only once the Host has declared the slot, so a
     *     Host without it loses the bar, not the plugin (the same degradation the
     *     `shell.overlay` toaster relies on);
     *   - **read-only** — every request here is a `GET`; the bar never saves a
     *     prompt, never enables an assembly and never switches a layer. Its only
     *     write-like act is a re-read the user asked for;
     *   - **the page's own口径** — the two layer regions call `mineCoverageOf`,
     *     the very function「我的 Prompt」's summary uses (g-084), and the
     *     notice region calls `assemblyVerdictOf` / `deliveryVerdictOf`, the same
     *     two verdicts the settings page and the toaster print. A bar that
     *     disagreed with the page it summarizes would be worse than no bar;
     *   - **zero requests without a Session** — the Host renders this slot only
     *     with a Session (`InputZone` needs one), but the component does not rely
     *     on that: an absent Session id short-circuits *before* any `fetch`.
     *
     * Scope: the five data regions are addressed by `data-region` and the semantic
     * colour by `data-tone` (`normal` / `warn` / `error` / `unknown`), so a probe
     * reads attributes instead of guessing at text.
     */

    /** `conversation.input.dock` ordering: shipped entries are `todo` (0) and `queue` (20); 30 sits nearest the composer. */
    const COMPOSER_BAR_ORDER = 30;
    /** The bar's own root marker（与五个分区的 `data-region` 区分开）. */
    const COMPOSER_BAR_REGION = 'composer-assembly-bar';
    /**
     * The five region keys, in display order. Frozen and exported through
     * `__internals` so a test (and a probe) can assert the roster instead of
     * re-typing it.
     */
    const COMPOSER_BAR_REGIONS = Object.freeze([
      'bar-sections',
      'bar-user-layer',
      'bar-workspace-layer',
      'bar-assembly',
      'bar-settings',
    ]);
    /**
     * One distinguishable hue per region, Host theme tokens first.
     *
     * The hue is carried by the region's left rule and its label, never by the
     * value text: the value is coloured semantically (`data-tone`), so a theme
     * that maps a hue token onto a low-contrast colour can only weaken the rule,
     * not make the number unreadable. Five fallbacks are plain CSS colours with
     * enough contrast on both light and dark module backgrounds.
     */
    const COMPOSER_BAR_HUES = Object.freeze({
      'bar-sections': 'var(--dsw-alias-state-business-primary, #2563eb)',
      'bar-user-layer': 'var(--dsw-alias-state-success-primary, #15803d)',
      'bar-workspace-layer': 'var(--dsw-alias-state-warning-primary, #b45309)',
      'bar-assembly': 'var(--dsw-alias-brand-primary, #7c3aed)',
      'bar-settings': 'var(--dsw-alias-state-info-primary, #0e7490)',
    });

    /**
     * One short inline-SVG glyph per region (g-086 R4).
     *
     * Each entry is a list of `path` data strings drawn on a 24×24 grid with
     * `stroke="currentColor"`. No dependency, no icon font, no external asset:
     * the glyph inherits the region's hue from the `color` the caller sets.
     */
    const COMPOSER_BAR_ICONS = Object.freeze({
      brand: ['M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z'],
      sections: ['M4 6h16', 'M4 12h16', 'M4 18h10'],
      user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 20a8 8 0 0 1 16 0'],
      workspace: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
      assembly: ['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5'],
      // R5: the real gear (lucide `settings`): toothed outline plus a centre
      // circle. The old cross-hair read as a target at 16px.
      settings: [
        'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
        { tag: 'circle', attrs: { cx: 12, cy: 12, r: 3 } },
      ],
      refresh: ['M20 12a8 8 0 1 1-2.3-5.7', 'M20 4v4h-4'],
    });

    /**
     * One glyph, drawn with `currentColor` so the caller's `color` is the hue.
     * @param name - the icon key.
     * @param color - the CSS colour that `currentColor` resolves to.
     * @returns the svg element, or null for an unknown key.
     */
    function composerBarIconOf(name, color) {
      const paths = COMPOSER_BAR_ICONS[name];
      if (paths === undefined) return null;
      // Each entry is a `path` data string, or a `{tag, attrs}` shape for the few
      // glyphs that need a second primitive (the gear's centre circle).
      return h(
        'svg',
        {
          'data-bar-icon': name,
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { flex: 'none', display: 'block', color: color },
        },
        paths.map((glyph, index) =>
          typeof glyph === 'string'
            ? h('path', { key: String(index), d: glyph })
            : h(glyph.tag, { key: String(index), ...(glyph.attrs === undefined ? {} : glyph.attrs) }),
        ),
      );
    }

    /**
     * The semantic colour of one verdict, as a theme token.
     * @param tone - `normal` | `warn` | `error` | `unknown`.
     * @returns the CSS colour for the value text.
     */
    function composerBarToneColor(tone) {
      if (tone === 'error') return token.stateError;
      if (tone === 'warn') return token.stateWarn;
      if (tone === 'normal') return token.labelPrimary;
      return token.labelTertiary;
    }

    /**
     * The Hue of one region.
     * @param region - one of {@link COMPOSER_BAR_REGIONS}.
     * @returns its CSS colour, or the tertiary label colour for an unknown key.
     */
    function composerBarHueOf(region) {
      return COMPOSER_BAR_HUES[region] === undefined ? token.labelTertiary : COMPOSER_BAR_HUES[region];
    }

    /**
     * The Session this bar reads, from the several seats a Host may use.
     *
     * `conversation.input.dock`'s owner share is `InputZone {session, input}`, so
     * `props.session.sessionId` is the intended seat; `barSessionId` is this
     * registration's own inject face (the Host passes the scope id to a
     * Session-scoped `inject`), and a bare `sessionId` is accepted for the same
     * reason. Anything else is "no Session", which issues **no request**.
     * @param props - the entry's props.
     * @returns the Session id, or `''`.
     */
    function composerBarSessionIdOf(props) {
      const snapshot = props === null || props === undefined ? null : props.session;
      const fromSnapshot = snapshot !== null && typeof snapshot === 'object' ? snapshot.sessionId : undefined;
      if (typeof fromSnapshot === 'string' && fromSnapshot.length > 0) return fromSnapshot;
      for (const candidate of [props === null || props === undefined ? undefined : props.barSessionId, props === null || props === undefined ? undefined : props.sessionId]) {
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
      }
      return '';
    }

    /**
     * The three reads this bar needs, as URLs — or `null` when there is no Session.
     *
     * `?session=` is the whole scope: the Host resolves the workspace layer from
     * it (§2.4), so the client never has to name a workspace root it does not own.
     * Pure and side-effect free, which is what makes "no Session ⇒ no request"
     * assertable without a transport.
     * @param sessionId - the Session id, or `''`.
     * @returns `{snapshot, overrides, assembly}`, or `null`.
     */
    function composerBarRequestUrls(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
      const query = `?session=${encodeURIComponent(sessionId)}`;
      return {
        snapshot: `${SNAPSHOT_PATH}${query}`,
        overrides: `${OVERRIDES_PATH}${query}`,
        assembly: `${ASSEMBLY_STATUS_PATH}${query}`,
      };
    }

    /**
     * The assembled section count — `effective.sections.length`.
     *
     * The same number「提示词总览」counts (`sectionsShown`) and the same one
     * `emptyTitle` calls "no sections": the post-waterfall view, including
     * entries that produced no rendered section. Counting only `index !== null`
     * would silently disagree with the settings page, which is the one thing this
     * bar must not do.
     * @param payload - a `GET /prompt-setting/snapshot` payload, or null.
     * @returns the count, or `null` when the payload cannot answer.
     */
    function composerBarSectionCount(payload) {
      if (payload === null || typeof payload !== 'object') return null;
      const effective = payload.effective;
      if (effective === null || typeof effective !== 'object') return null;
      return Array.isArray(effective.sections) ? effective.sections.length : null;
    }

    /**
     * One layer's read-only verdict.
     *
     * The coverage half is **exactly**「我的 Prompt」's second line: the same
     * `mineCoverageOf(layer, overrides, effective.sections)` call, so "this layer
     * stores N overrides and M of them did not take effect" means the same thing
     * in both places. The disability half reads the snapshot's own
     * `layers[layer].enabled` (§2), because a disabled layer is not "zero
     * overrides" — it is a layer the Host refuses to apply.
     * @param layer - `user` | `workspace`.
     * @param snapshot - a `GET /prompt-setting/snapshot` payload, or null.
     * @param overrides - a `GET /prompt-setting/overrides` payload, or null.
     * @returns `{kind, total, ineffective}` where `kind` is `ready`, `none`,
     *   `disabled` or `error`.
     */
    function composerBarLayerFact(layer, snapshot, overrides) {
      if (snapshot === null || typeof snapshot !== 'object') return { kind: 'error', total: 0, ineffective: 0 };
      if (overrides === null || typeof overrides !== 'object') return { kind: 'error', total: 0, ineffective: 0 };
      const layers = snapshot.layers !== null && typeof snapshot.layers === 'object' ? snapshot.layers : null;
      const view = layers !== null && layers[layer] !== null && typeof layers[layer] === 'object' ? layers[layer] : null;
      if (view !== null && view.enabled === false) return { kind: 'disabled', total: 0, ineffective: 0 };
      const sections =
        snapshot.effective !== null && typeof snapshot.effective === 'object' && Array.isArray(snapshot.effective.sections)
          ? snapshot.effective.sections
          : [];
      const coverage = mineCoverageOf(layer, overrides, sections);
      return {
        kind: coverage.total === 0 ? 'none' : 'ready',
        total: coverage.total,
        ineffective: coverage.ineffective,
      };
    }

    /**
     * The key node's notice, or `null` when there is nothing to summarize.
     *
     * A notice without its two verdict objects is not a notice this bar can
     * print; treating it as absent is the honest answer (the settings page's
     * summary does the same).
     * @param payload - a `GET /prompt-setting/assembly-status` payload, or null.
     * @returns the notice, or `null`.
     */
    function composerBarNoticeOf(payload) {
      if (payload === null || typeof payload !== 'object') return null;
      const record = payload.record;
      if (record === null || typeof record !== 'object') return null;
      const notice = record.notice;
      if (notice === null || typeof notice !== 'object') return null;
      if (notice.assembly === null || typeof notice.assembly !== 'object') return null;
      if (notice.delivery === null || typeof notice.delivery !== 'object') return null;
      return notice;
    }

    /**
     * An opener the entry props themselves carry, if any — the first seat the
     * button tries.
     *
     * No 0.2.1-rc.3 slot hands `openSettings` to an unrelated entry (that owner
     * prop belongs to `settings.launcher`), so in practice this returns `null`;
     * it stays because a Host that ever does pass one must not need a code change
     * here to get the direct path.
     * @param props - the entry's props.
     * @returns a zero-argument opener, or `null`.
     */
    function composerBarSettingsOpener(props) {
      if (props === null || props === undefined) return null;
      for (const name of ['openSettings', 'openSettingsPanel']) {
        const candidate = props[name];
        if (typeof candidate === 'function') return () => candidate.call(props);
      }
      return null;
    }

    /**
     * Invoke the Host's own `settings.open` command, through the shortcuts
     * registry's **public** `invoke(id, context)` (g-086 R1).
     *
     * This is the honest answer to "how does a bar open the settings panel":
     * `ui-settings-general` registers `settings.open` with `modals:
     * ["settings"]`, and `ShortcutRegistry.invoke` checks only
     * `context.modal !== null && !command.modals.includes(context.modal)` before
     * running `resolve(...)`. Passing `modal: null` therefore elects the command
     * and runs its `shellInstance.actions.open()` branch — the panel opens from a
     * plugin that never occupied `settings.launcher`. (Dispatching a synthetic
     * keyboard event would also "work" and is exactly the kind of fragile
     * mechanism this avoids: the registry's own entry point is a documented one.)
     *
     * `shortcuts` is read through `ctx.get('shortcuts')` rather than declared in
     * `inject`: a Host without the service must still apply this plugin (the
     * same optional-read discipline `locale` follows), and a refused or throwing
     * read must degrade to `false`, never to a throw inside a click handler.
     * @param shortcuts - the shortcuts service, or anything else.
     * @returns `true` only when the command was really invoked.
     */
    function composerBarInvokeSettingsShortcut(shortcuts) {
      if (shortcuts === null || typeof shortcuts !== 'object' || typeof shortcuts.invoke !== 'function') return false;
      try {
        shortcuts.invoke('settings.open', { region: 'page', modal: null, target: null });
        return true;
      } catch {
        return false;
      }
    }

    /**
     * The normalized binding the Host currently has for `settings.open`, or null.
     *
     * Read from the **public** catalog (`shortcuts.catalog`, a documented
     * an `ObservableSnapshot` of `ShortcutCatalogEntry[]`), so this works on the real
     * `ShortcutsService` — `invoke` is a method of the private registry, not of
     * the public `Shortcuts` interface, which is exactly why the R1 attempt
     * degraded on a real Host (NOTES §168).
     * @param rows - `catalog.getSnapshot()`.
     * @param id - the command id.
     * @returns the binding, or null.
     */
    function composerBarBindingById(rows, id) {
      if (rows === null || typeof rows !== 'object' || typeof rows.length !== 'number') return null;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (row === null || typeof row !== 'object' || row.id !== id) continue;
        const binding = row.binding;
        if (binding === null || typeof binding !== 'object' || typeof binding.code !== 'string') return null;
        return binding;
      }
      return null;
    }

    /**
     * The `KeyboardEvent` init for one binding.
     *
     * The Host's adapter matches on `event.code` plus the four modifier booleans
     * and never looks at `event.key`, so `key` is a plain value — the physical
     * code is what identifies the keystroke. `bubbles/cancelable/composed` are
     * set so the event behaves like a real one for the listeners it passes.
     * @param binding - a normalized binding.
     * @returns a `KeyboardEventInit`.
     */
    function composerBarKeyboardInit(binding) {
      const modifiers = Array.isArray(binding.modifiers) ? binding.modifiers : [];
      return {
        code: binding.code,
        key: binding.code,
        ctrlKey: modifiers.indexOf('control') >= 0,
        altKey: modifiers.indexOf('alt') >= 0,
        shiftKey: modifiers.indexOf('shift') >= 0,
        metaKey: modifiers.indexOf('meta') >= 0,
        bubbles: true,
        cancelable: true,
        composed: true,
      };
    }

    /** The browser window, or null in a non-DOM realm. */
    function composerBarGlobalWindow() {
      try {
        return typeof window === 'undefined' || window === null || typeof window !== 'object' ? null : window;
      } catch {
        return null;
      }
    }

    /**
     * Open the Host's settings panel through its own keyboard channel, in the
     * order of "most public first".
     *
     * 1. **`catalog` → synthetic `KeyboardEvent`** — the documented surface. The
     *    Host's `keydown` listener (window bubbling phase) reads `event.code` and
     *    the modifier booleans, resolves the command, and with no modal open runs
     *    `shellInstance.actions.open()`. It does not check `isTrusted`, so a
     *    dispatched event is indistinguishable to it from a user's keypress —
     *    this is "press the shortcut for the user", not a shortcut bypass.
     * 2. **`registry.invoke`** — the R1 path. The registry method is public in JS
     *    at runtime but `private` in the service's TypeScript surface, so it is a
     *    **last resort**: if a future Host drops `catalog` or the binding, this is
     *    still better than a dead button, and its privacy risk is a build-time
     *    type fact, not a runtime one.
     * 3. **none** — the caller shows the explicit fallback sentence.
     *
     * Every step is guarded; a throwing read never escapes a click handler.
     * @param options - `shortcuts` (the service), `window` (the DOM window).
     * @returns `key` / `invoke` / `none`.
     */
    function composerBarDispatchSettingsShortcut(options) {
      const shortcuts = options === null || typeof options !== 'object' ? undefined : options.shortcuts;
      const view = options === null || typeof options !== 'object' ? null : options.window;
      // 1. the public channel
      try {
        const catalog =
          shortcuts !== null && typeof shortcuts === 'object' && shortcuts.catalog !== null && typeof shortcuts.catalog === 'object' && typeof shortcuts.catalog.getSnapshot === 'function'
            ? shortcuts.catalog.getSnapshot()
            : null;
        const binding = composerBarBindingById(catalog, 'settings.open');
        const Ctor =
          view !== null && typeof view === 'object' && typeof view.KeyboardEvent === 'function'
            ? view.KeyboardEvent
            : typeof KeyboardEvent === 'function'
              ? KeyboardEvent
              : null;
        if (binding !== null && Ctor !== null && view !== null && typeof view.dispatchEvent === 'function') {
          view.dispatchEvent(new Ctor('keydown', composerBarKeyboardInit(binding)));
          return 'key';
        }
      } catch {
        // Fall through to the last resort.
      }
      // 2. the private-but-callable registry method
      try {
        const registry = shortcuts !== null && typeof shortcuts === 'object' ? shortcuts.registry : undefined;
        if (registry !== null && typeof registry === 'object' && typeof registry.invoke === 'function') {
          registry.invoke('settings.open', { region: 'page', modal: null, target: null });
          return 'invoke';
        }
      } catch {
        // Fall through to the fallback sentence.
      }
      return 'none';
    }

    /** How long the bar keeps looking for the settings panel after the opener ran. */
    const COMPOSER_BAR_AIM_TIMEOUT_MS = 800;

    /**
     * Below this content width the bar switches to its compact form (g-086 R3).
     *
     * 640px is the width at which the five cells stop fitting on one line with
     * their labels (measured against the dock's own inset budget): the settings
     * button is the last fixed piece, so the threshold sits above it.
     */
    const COMPOSER_BAR_COMPACT_WIDTH = 640;

    /**
     * One container width → the bar's density.
     *
     * `full` keeps the labels; `compact` drops them and shortens the layer
     * values, which is what keeps a docked sidebar from wrapping the row. An
     * unknown width (no `ResizeObserver`, a first paint before measurement) is
     * `full`: the row still cannot wrap (it is `nowrap`), it just ellipsizes
     * until the measurement arrives.
     * @param width - the surface's content width in CSS pixels, or null.
     * @returns `full` | `compact`.
     */
    function composerBarDensityOf(width) {
      return typeof width === 'number' && Number.isFinite(width) && width > 0 && width < COMPOSER_BAR_COMPACT_WIDTH
        ? 'compact'
        : 'full';
    }

    /** The document the bar may touch: an explicit prop first, the global one second. */
    function composerBarDocumentOf(props) {
      const explicit = props === null || props === undefined ? undefined : props.document;
      if (explicit !== null && typeof explicit === 'object' && typeof explicit.querySelector === 'function') return explicit;
      const globalDocument = typeof document === 'undefined' ? undefined : document;
      return globalDocument !== null && typeof globalDocument === 'object' && typeof globalDocument.querySelector === 'function'
        ? globalDocument
        : null;
    }

    /**
     * The settings panel in one document, or `null`.
     *
     * The anchor is the Host's own semantic marker (`data-shortcut-modal="settings"`,
     * carried by the portaled dialog), never a build-time class name.
     * @param root - a document (or any query-capable root).
     * @returns the panel element, or `null`.
     */
    function composerBarSettingsPane(root) {
      if (root === null || root === undefined || typeof root !== 'object' || typeof root.querySelector !== 'function') return null;
      try {
        const pane = root.querySelector('[data-shortcut-modal="settings"]');
        return pane !== null && typeof pane === 'object' ? pane : null;
      } catch {
        return null;
      }
    }

    /**
     * The nav row whose visible text is exactly `label`, inside one settings pane.
     *
     * The panel's nav rows are button elements whose text is the section's registered
     * label — so the plugin's own `t('nav')` is the precise needle, and an exact
     * trimmed match is what keeps a sibling section from being clicked by accident.
     * @param pane - the settings panel.
     * @param label - the section label to match.
     * @returns the clickable row, or `null`.
     */
    function composerBarNavButton(pane, label) {
      if (pane === null || typeof pane !== 'object' || typeof pane.querySelectorAll !== 'function') return null;
      const wanted = typeof label === 'string' ? label.trim() : '';
      if (wanted.length === 0) return null;
      let buttons;
      try {
        buttons = pane.querySelectorAll('nav button');
      } catch {
        return null;
      }
      if (buttons === null || typeof buttons !== 'object' || typeof buttons.length !== 'number') return null;
      for (let index = 0; index < buttons.length; index += 1) {
        const button = buttons[index];
        if (button === null || typeof button !== 'object') continue;
        const text = typeof button.textContent === 'string' ? button.textContent.trim() : '';
        if (text === wanted && typeof button.click === 'function') return button;
      }
      return null;
    }

    /**
     * Click one settings section by its label, when the panel is already there.
     * @param root - the document.
     * @param label - the section label.
     * @returns `clicked` (the row was clicked), `panel` (open, no such row) or
     *   `missing` (no panel yet).
     */
    function composerBarClickSection(root, label) {
      const pane = composerBarSettingsPane(root);
      if (pane === null) return 'missing';
      const button = composerBarNavButton(pane, label);
      if (button === null) return 'panel';
      try {
        button.click();
      } catch {
        return 'panel';
      }
      return 'clicked';
    }

    /**
     * Wait — for at most {@link COMPOSER_BAR_AIM_TIMEOUT_MS} — for the panel the
     * opener just opened, then click this plugin's own nav row.
     *
     * Two properties matter:
     *   - **bounded and disposable** — one observer plus one timeout, both
     *     released by the returned stopper (which the component calls on unmount
     *     and before every new attempt). No `setTimeout` chain, no polling, and
     *     no second observer per render;
     *   - **best effort** — a panel that never appears, a row that never matches
     *     and a Host that changes its nav markup all end the same way: the panel
     *     is open (the user asked for settings and got settings), the bar keeps
     *     working, and nothing is thrown. Section selection is a bonus, not a
     *     requirement for the entry to be honest.
     *
     * The DOM hooks are injectable (`document` / `MutationObserver` / `raf` /
     * timer functions) so the whole wait is testable without a browser.
     * @param options - `document`, `label`, `timeoutMs` plus optional IO overrides.
     * @returns an idempotent stopper.
     */
    function composerBarAimAtSection(options) {
      const io = options === null || typeof options !== 'object' ? {} : options;
      const doc = io.document === undefined ? null : io.document;
      const label = io.label;
      const timeoutMs =
        typeof io.timeoutMs === 'number' && io.timeoutMs > 0 ? io.timeoutMs : COMPOSER_BAR_AIM_TIMEOUT_MS;
      const view = doc !== null && typeof doc === 'object' && doc.defaultView !== null && doc.defaultView !== undefined ? doc.defaultView : null;
      const setTimer = typeof io.setTimeout === 'function' ? io.setTimeout : typeof setTimeout === 'function' ? setTimeout : null;
      const clearTimer =
        typeof io.clearTimeout === 'function' ? io.clearTimeout : typeof clearTimeout === 'function' ? clearTimeout : null;
      const raf =
        typeof io.raf === 'function'
          ? io.raf
          : view !== null && typeof view.requestAnimationFrame === 'function'
            ? view.requestAnimationFrame.bind(view)
            : null;
      const cancelRaf =
        typeof io.cancelAnimationFrame === 'function'
          ? io.cancelAnimationFrame
          : view !== null && typeof view.cancelAnimationFrame === 'function'
            ? view.cancelAnimationFrame.bind(view)
            : null;
      const ObserverCtor =
        typeof io.MutationObserver === 'function'
          ? io.MutationObserver
          : view !== null && typeof view.MutationObserver === 'function'
            ? view.MutationObserver
            : typeof MutationObserver === 'function'
              ? MutationObserver
              : null;
      let observer = null;
      let timer = null;
      let frame = null;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (observer !== null) {
          try {
            observer.disconnect();
          } catch {
            // A disconnected observer is the goal; a throwing one is already dead.
          }
          observer = null;
        }
        if (timer !== null && clearTimer !== null) {
          try {
            clearTimer(timer);
          } catch {
            // Same as above: nothing to keep alive.
          }
          timer = null;
        }
        if (frame !== null && cancelRaf !== null) {
          try {
            cancelRaf(frame);
          } catch {
            // Same.
          }
          frame = null;
        }
      };
      const attempt = () => {
        if (stopped) return;
        if (composerBarClickSection(doc, label) === 'clicked') stop();
      };
      const schedule = () => {
        if (stopped || frame !== null) return;
        const run = () => {
          frame = null;
          attempt();
        };
        if (raf !== null) {
          try {
            frame = raf(run);
            return;
          } catch {
            frame = null;
          }
        }
        run();
      };
      if (doc === null) return stop;
      // The opener may have painted the panel synchronously (React commits before
      // the handler returns in a portal): ask once before waiting for mutations.
      attempt();
      if (stopped) return stop;
      if (ObserverCtor !== null) {
        try {
          observer = new ObserverCtor(schedule);
          const target = doc.body !== null && typeof doc.body === 'object' ? doc.body : doc;
          observer.observe(target, { childList: true, subtree: true });
        } catch {
          observer = null;
        }
      }
      if (setTimer !== null) {
        timer = setTimer(() => {
          timer = null;
          if (stopped) return;
          const pane = composerBarSettingsPane(doc);
          stop();
          // The deadline passed. "The panel opened but its nav row was not found"
          // is not a failure the user must be told about (the panel is open);
          // "no panel at all" is — otherwise the click looks dead.
          if (pane === null && typeof io.onTimeout === 'function') {
            try {
              io.onTimeout();
            } catch {
              // A throwing callback must not turn the deadline into an exception.
            }
          }
        }, timeoutMs);
      }
      return stop;
    }

    /**
     * One region's element: a hue rule, an optional small label, a semantic value
     * and an optional trailing control.
     *
     * An empty label/value renders no span at all — the settings region is a
     * button and a hue rule, and an empty span element there would be a phantom cell
     * a probe could mistake for content.
     * @param options - `region`, `label`, `value`, `tone`, `extra`.
     * @returns the region element.
     */
    function composerBarRegionOf(options) {
      const hue = composerBarHueOf(options.region);
      const hasLabel = typeof options.label === 'string' && options.label.length > 0;
      const hasValue = typeof options.value === 'string' && options.value.length > 0;
      return h(
        'div',
        {
          'data-region': options.region,
          'data-tone': options.tone,
          'data-bar-hue': hue,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            // R3: every cell may shrink (and its value ellipsize); the settings
            // seat is the one exception — it keeps its size and sits at the end.
            flex: options.flex === undefined ? '0 1 auto' : options.flex,
            minWidth: 0,
            // R4: the hue lives on the glyph and the small label — no 3px strip.
            ...(options.region === 'bar-settings' ? { marginLeft: 'auto', gap: 8 } : {}),
          },
        },
        options.icon === undefined ? null : composerBarIconOf(options.icon, hue),
        hasLabel
          ? h(
              'span',
              {
                'data-bar-label': '',
                style: { fontSize: 11, lineHeight: '14px', color: token.labelSecondary, whiteSpace: 'nowrap' },
              },
              options.label,
            )
          : null,
        hasValue
          ? h(
              'span',
              {
                'data-bar-value': '',
                // The full sentence is often wider than the cell's budget; the
                // tooltip keeps the tail readable without letting one long
                // verdict push the other regions off the row.
                title: options.title === undefined ? options.value : options.title,
                style: {
                  fontSize: 12,
                  lineHeight: '16px',
                  fontWeight: 500,
                  color: composerBarToneColor(options.tone),
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  // R3: the value gives way before the row does — it shrinks and
                  // ellipsizes (full text stays in the tooltip), and the cell's
                  // own width is the only ceiling.
                  flex: '0 1 auto',
                  minWidth: 0,
                  maxWidth: 'none',
                },
              },
              options.value,
            )
          : null,
        options.extra === undefined ? null : options.extra,
      );
    }

    /**
     * The label colour of one region — the hue itself when the Host's tokens make
     * it legible, the tertiary label otherwise. Deliberately the *same* colour the
     * rule uses: two colours would make a region look like two regions.
     * @param hue - the region's CSS colour.
     * @returns the colour for the small label.
     */
    function composerBarLabelColorOf(hue) {
      return typeof hue === 'string' && hue.length > 0 ? hue : token.labelTertiary;
    }

    /**
     * The whole bar.
     *
     * Renders five `data-region` cells in one wrapped row. The reads happen on
     * mount, on Session change and on the user's explicit refresh — never on a
     * timer: a resident poll would be a request the user did not ask for on every
     * open tab, and the facts it would pick up (a save in the settings panel)
     * arrive with a fresh mount or one click.
     * @param props - the entry's props (`session`, `barSessionId`, `t`, …).
     * @returns the bar element.
     */
    function ComposerAssemblyBar(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const sessionId = composerBarSessionIdOf(props);
      const [read, setRead] = React.useState({
        phase: sessionId === '' ? 'no-session' : 'loading',
        snapshot: null,
        overrides: null,
        assembly: null,
      });
      const [nonce, setNonce] = React.useState(0);
      const [hint, setHint] = React.useState(false);
      // g-086 R3: the surface never wraps, so it needs to know how much room it
      // has: the root's own width is measured (ResizeObserver) and the compact
      // form takes over below COMPOSER_BAR_COMPACT_WIDTH. A case may hand the
      // width in through `props.barWidth` instead of a DOM measurement.
      const [barWidth, setBarWidth] = React.useState(typeof props.barWidth === 'number' ? props.barWidth : null);
      const observerRef = React.useRef(null);
      const attachRef = React.useRef(null);
      if (attachRef.current === null) {
        attachRef.current = (node) => {
          if (observerRef.current !== null) {
            try {
              observerRef.current.disconnect();
            } catch {
              // Already dead; nothing to release.
            }
            observerRef.current = null;
          }
          if (node === null || node === undefined) return;
          const Ctor =
            typeof props.ResizeObserver === 'function'
              ? props.ResizeObserver
              : typeof ResizeObserver === 'function'
                ? ResizeObserver
                : null;
          if (Ctor !== null) {
            try {
              const observer = new Ctor((entries) => {
                const entry = Array.isArray(entries) ? entries[0] : null;
                const measured =
                  entry !== null && entry !== undefined && entry.contentRect !== null && entry.contentRect !== undefined && typeof entry.contentRect.width === 'number'
                    ? entry.contentRect.width
                    : node.clientWidth;
                setBarWidth(typeof measured === 'number' && Number.isFinite(measured) ? measured : null);
              });
              observer.observe(node);
              observerRef.current = observer;
            } catch {
              observerRef.current = null;
            }
          }
          // First paint: measure synchronously so the very first frame already
          // knows whether labels fit (the observer only reports on changes).
          if (typeof node.clientWidth === 'number' && node.clientWidth > 0) setBarWidth(node.clientWidth);
        };
      }
      const compact = composerBarDensityOf(barWidth) === 'compact';
      // g-086 R5: the switch. Same seat the settings page uses, so flipping it
      // there hides this bar (and its reads) on the same frame.
      const enabled = React.useSyncExternalStore(
        subscribeComposerBarEnabled,
        composerBarEnabled,
        composerBarEnabled,
      );
      // One pending "find the settings panel" attempt at a time: kept in a ref so
      // the component can stop it before starting another and on unmount.
      const aimRef = React.useRef(null);
      const stopAim = () => {
        const stop = aimRef.current;
        aimRef.current = null;
        if (typeof stop === 'function') {
          try {
            stop();
          } catch {
            // The stopper is best effort; a throwing one must not break unmount.
          }
        }
      };
      // Unmount cleanup. An empty dependency array means the cleanup runs once,
      // when the entry is torn down (session switch / plugin unload), which is
      // exactly when a lingering observer would otherwise scan a document the bar
      // no longer belongs to.
      React.useEffect(() => stopAim, []);

      React.useEffect(() => {
        if (!enabled) {
          // Off means off: no snapshot, no overrides, no assembly-status — the
          // whole point of the switch is that a hidden bar costs nothing.
          setRead({ phase: 'off', snapshot: null, overrides: null, assembly: null });
          return undefined;
        }
        const urls = composerBarRequestUrls(sessionId);
        if (urls === null) {
          // No Session ⇒ no request at all. This is the promise `verify` cannot
          // make for us: a component that asked "just in case" would leak a
          // request per mounted blank composer.
          setRead({ phase: 'no-session', snapshot: null, overrides: null, assembly: null });
          return undefined;
        }
        let cancelled = false;
        setRead((current) => ({
          phase: 'loading',
          // A refresh keeps the last answer on screen instead of blanking the
          // bar; only the phase changes, so the row does not jump.
          snapshot: current.snapshot,
          overrides: current.overrides,
          assembly: current.assembly,
        }));
        const load = async () => {
          const snapshot = await requestJson(urls.snapshot);
          const overrides = await requestJson(urls.overrides);
          const assembly = await requestJson(urls.assembly);
          if (cancelled) return;
          setRead({
            phase: 'ready',
            snapshot: snapshot.ok === true ? snapshot.payload : null,
            overrides: overrides.ok === true ? overrides.payload : null,
            assembly: assembly.ok === true ? assembly.payload : null,
          });
        };
        void load();
        return () => {
          cancelled = true;
        };
      }, [enabled, sessionId, nonce]);

      const phase = read.phase;
      const notice = composerBarNoticeOf(read.assembly);
      const layerLine = (layer) => {
        if (phase === 'no-session') return { text: t('barNoSession'), tone: 'unknown' };
        if (phase !== 'ready') return { text: t('loading'), tone: 'unknown' };
        const fact = composerBarLayerFact(layer, read.snapshot, read.overrides);
        if (fact.kind === 'error') return { text: t('loadFailed'), tone: 'error' };
        if (fact.kind === 'disabled') return { text: t('stDisabled'), tone: 'warn' };
        if (fact.kind === 'none') return { text: t('stNone'), tone: 'unknown' };
        const params = { total: String(fact.total), ineffective: String(fact.ineffective) };
        return {
          // g-086 R3: short in the cell, the settings page's full sentence in
          // the tooltip — the meaning is unchanged, only the width is.
          text: fmt(t('barCoverageShort'), params),
          title: fmt(t('mineStatusCoverage'), params),
          tone: fact.ineffective > 0 ? 'warn' : 'normal',
        };
      };
      const sectionsValue =
        phase === 'no-session'
          ? { text: t('barNoSession'), tone: 'unknown' }
          : phase !== 'ready'
            ? { text: t('loading'), tone: 'unknown' }
            : composerBarSectionCount(read.snapshot) === null
              ? { text: t('loadFailed'), tone: 'error' }
              : { text: String(composerBarSectionCount(read.snapshot)), tone: 'normal' };
      const assemblyValue =
        phase === 'no-session'
          ? { text: t('barNoSession'), tone: 'unknown' }
          : phase !== 'ready'
            ? { text: t('loading'), tone: 'unknown' }
            : read.assembly === null
              ? { text: t('loadFailed'), tone: 'error' }
              : notice === null
                ? { text: t('barSummaryNone'), tone: 'unknown' }
                : {
                    // g-086 R2: the cell is one line wide, so it says the two
                    // verdicts in two words; the full sentences move to the
                    // tooltip. The tone rule is unchanged (delivered ⇒ normal).
                    text:
                      notice.assembly === null || notice.assembly.assembled !== true
                        ? t('barSummaryNotAssembled')
                        : notice.delivery.state === 'delivered'
                          ? t('barSummaryDelivered')
                          : t('barSummaryUnconfirmed'),
                    tone: notice.delivery.state === 'delivered' ? 'normal' : 'warn',
                    title: [
                      `${t('assemblyLayerAssembly')}${t('assemblyLayerSep')}${assemblyVerdictOf(t, notice)}`,
                      `${t('assemblyLayerDelivery')}${t('assemblyLayerSep')}${deliveryVerdictOf(t, notice)}`,
                    ].join(' · '),
                  };

      const userLine = layerLine('user');
      const workspaceLine = layerLine('workspace');
      // Off ⇒ the entry renders nothing. Every hook above has already run, so the
      // hook order is identical in both states.
      if (!enabled) return null;
      const refreshButton = h(
        'button',
        {
          type: 'button',
          'data-action': 'composer-bar-refresh',
          'aria-label': t('refresh'),
          title: t('refresh'),
          onClick: () => setNonce((value) => value + 1),
          style: {
            font: 'inherit',
            padding: 0,
            border: 'none',
            borderRadius: 0,
            background: 'transparent',
            color: token.labelSecondary,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
          },
        },
        // An icon, not a translation: the accessible name stays the localized
        // verb (`refresh`), while the cell spends no horizontal room on words.
        composerBarIconOf('refresh', token.labelSecondary),
      );
      const settingsButton = h(
        'button',
        {
          type: 'button',
          'data-action': 'composer-bar-settings',
          'aria-label': t('nav'),
          title: t('nav'),
          onClick: () => {
            stopAim();
            // g-086 R1: two seats, in order. The entry-props opener (a Host that
            // hands one over), then the Host's own `settings.open` command via the
            // shortcuts registry. Both are guarded: a throwing opener is "not
            // available", not a broken click.
            let opened = false;
            const open = composerBarSettingsOpener(props);
            if (open !== null) {
              try {
                open();
                opened = true;
              } catch {
                opened = false;
              }
            }
            // g-086 R2: the R1 probe (`shortcuts.invoke`) never existed on the
            // real service, so the entry now asks for the identity of the opener
            // path itself — `key` (public catalog + synthetic KeyboardEvent),
            // `invoke` (private-but-callable registry method) or `none`.
            if (!opened && typeof props.openSettingsByShortcut === 'function') {
              try {
                opened = props.openSettingsByShortcut() !== 'none';
              } catch {
                opened = false;
              }
            }
            if (!opened && typeof props.invokeSettingsShortcut === 'function') {
              try {
                opened = props.invokeSettingsShortcut() === true;
              } catch {
                opened = false;
              }
            }
            if (!opened) {
              // The honest degradation: the button stays visible and says why it
              // cannot do what it looks like it does — never a silent no-op.
              setHint(true);
              return;
            }
            setHint(false);
            // The panel is expected to open; selecting *this* plugin's page is
            // best effort (bounded, disposable, anchored on semantic attributes
            // only). If no panel shows up within the deadline, the click would
            // otherwise look dead — so the explicit fallback sentence appears.
            aimRef.current = composerBarAimAtSection({
              document: composerBarDocumentOf(props),
              label: t('nav'),
              onTimeout: () => setHint(true),
            });
          },
          style: {
            font: 'inherit',
            padding: 0,
            border: 'none',
            borderRadius: 0,
            background: 'transparent',
            color: token.labelSecondary,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
          },
        },
        // R4: a bare gear. The accessible name (`t('nav')`) is the only place the
        // entry's name lives now — the brand area carries the visible name.
        composerBarIconOf('settings', token.labelSecondary),
      );

      // g-086 R2: two boxes, exactly like the Host's own dock entries
      // (`QueueDock` / `TodoPanel`). The outer box owns the composer's width
      // rule — `100%` minus the side clearance and the dock inset, capped by the
      // card's max width — so the bar lines up with the input card and follows a
      // docked sidebar (the variables live on the conversation body and inherit).
      // The inner box owns the visible surface and its own padding, so the
      // alignment is never affected by how much padding the bar wants.
      return h(
        'div',
        {
          'data-plugin': 'dsh-prompt-setting',
          'data-region': COMPOSER_BAR_REGION,
          'data-composer-bar-state': phase,
          'data-composer-bar-session': sessionId === '' ? '' : sessionId,
          role: 'status',
          'aria-live': 'polite',
          ref: attachRef.current,
          style: {
            boxSizing: 'border-box',
            width:
              'calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px)'
              + ' - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px))',
            maxWidth:
              'calc(var(--dsh-composer-card-max-width, 920px) - var(--dsh-composer-dock-inset, 8px)'
              + ' - var(--dsh-composer-dock-inset, 8px))',
            margin: '0 auto 6px',
            padding: '0 var(--dsh-composer-dock-inset, 8px)',
            flex: 'none',
          },
        },
        h(
          'div',
          {
            'data-composer-bar-surface': '',
            style: {
              display: 'flex',
              // R3: never wrap. A narrower dock shrinks the cells (each one may
              // shrink, values ellipsize) instead of pushing the settings button
              // onto a second line.
              flexWrap: 'nowrap',
              alignItems: 'center',
              // R4: a 30px pill with the card fill and one hairline — the bar
              // reads as an instrument strip, not as a form row.
              gap: 12,
              minWidth: 0,
              minHeight: 30,
              padding: '5px 12px',
              border: `1px solid ${token.surfaceStroke}`,
              borderRadius: 999,
              background: token.surface,
              color: token.labelPrimary,
              font: 'inherit',
              fontSize: 12,
              lineHeight: '16px',
            },
          },
          // R4: the brand seat. A coloured glyph plus the plugin's name in the
          // primary label weight — the settings entry itself is a bare gear, so
          // this is the only visible place the bar names itself.
          h(
            'span',
            {
              'data-bar-brand': '',
              style: { display: 'flex', alignItems: 'center', gap: 6, flex: '0 1 auto', minWidth: 0 },
            },
            composerBarIconOf('brand', token.stateBusiness),
            compact
              ? null
              : h(
                  'span',
                  {
                    'data-bar-brand-name': '',
                    style: {
                      fontWeight: 600,
                      color: token.labelPrimary,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    },
                  },
                  t('nav'),
                ),
          ),
          composerBarRegionOf({
          region: 'bar-sections',
          icon: 'sections',
          label: compact ? '' : t('viewSections'),
          value: sectionsValue.text,
          tone: sectionsValue.tone,
        }),
        composerBarRegionOf({
          region: 'bar-user-layer',
          icon: 'user',
          label: compact ? '' : t('barUserLabel'),
          value: userLine.text,
          tone: userLine.tone,
          title: userLine.title,
        }),
        composerBarRegionOf({
          region: 'bar-workspace-layer',
          icon: 'workspace',
          label: compact ? '' : t('barWorkspaceLabel'),
          value: workspaceLine.text,
          tone: workspaceLine.tone,
          title: workspaceLine.title,
        }),
        composerBarRegionOf({
          region: 'bar-assembly',
          icon: 'assembly',
          label: compact ? '' : t('barAssemblyLabel'),
          value: assemblyValue.text,
          tone: assemblyValue.tone,
          title: assemblyValue.title,
        }),
        composerBarRegionOf({
          region: 'bar-settings',
          label: '',
          value: '',
          tone: 'unknown',
          // Never compressed: this is the one cell whose whole point is to stay
          // visible and clickable when the row is tight.
          flex: '0 0 auto',
          extra: h(
            'span',
            {
              'data-bar-actions': '',
              style: { display: 'flex', alignItems: 'center', gap: 8 },
            },
            refreshButton,
            settingsButton,
          ),
        }),
        hint === true
          ? h(
              'p',
              {
                'data-region': 'bar-settings-hint',
                'data-composer-bar-hint': 'unavailable',
                role: 'status',
                style: {
                  margin: 0,
                  flexBasis: '100%',
                  fontSize: 11,
                  lineHeight: '14px',
                  color: token.labelSecondary,
                  wordBreak: 'break-word',
                },
              },
              t('barSettingsFallback'),
            )
          : null,
        ),
      );
    }


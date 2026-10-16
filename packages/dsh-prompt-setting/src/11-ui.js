
    /** The atoms as the Host ships them, wrapped so every call site keeps its shape. */
    const PRIMITIVES_UI = {
      Button: (props) =>
        h(
          primitives.Button,
          {
            ...props,
            variant: props.variant === 'primary' ? 'primary' : 'outline',
            size: 'sm',
            disabled: props.disabled,
          },
          props.children,
        ),
      Input: (props) => (hasComponentExport(primitives, 'Input') ? h(primitives.Input, props) : h(FxInput, props)),
      Textarea: FxTextarea,
      Tag: (props) =>
        hasComponentExport(primitives, 'Tag') ? h(primitives.Tag, { tone: props.tone }, props.children) : h(FxTag, props),
    };
    /** The same four seats, hand-built (no Host module involved at all). */
    const FALLBACK_UI = {
      Button: FxButton,
      Input: FxInput,
      Textarea: FxTextarea,
      Tag: FxTag,
    };
    /**
     * Resolve the atoms **at render time**, not once at load.
     *
     * It has to be a getter object rather than a frozen choice: when a Host atom
     * throws while React renders it, the boundary below switches
     * {@link primitivesActive} off and the *very next* render of the same tree
     * has to be the hand-built one. Every call site keeps writing `UI.Button`,
     * so there is exactly one place that decides (g-063 E1).
     */
    const UI = {
      get Button() {
        return primitivesActive() ? PRIMITIVES_UI.Button : FALLBACK_UI.Button;
      },
      get Input() {
        return primitivesActive() ? PRIMITIVES_UI.Input : FALLBACK_UI.Input;
      },
      get Textarea() {
        return FALLBACK_UI.Textarea;
      },
      get Tag() {
        return primitivesActive() ? PRIMITIVES_UI.Tag : FALLBACK_UI.Tag;
      },
    };

    /**
     * Why the tab strip is the **one** place that deliberately does NOT use the
     * Host's atoms (g-063, real-machine rounds 1–3 — the decision, and the two
     * rejected repairs).
     *
     * The official `SegmentedTabs` sets
     * `gridTemplateColumns: repeat(items.length, minmax(0, 1fr))` **inline** on
     * its root (`lib/index.js:3312`), i.e. it divides its own width into n equal
     * columns. That premise fits short labels and a wide container; this page has
     * **six Chinese labels** and the settings panel's content width. Two real
     * machines readings, both recorded as **observations**:
     *
     *   - Too narrow: `minmax(0, 1fr)` has a `0` minimum, so every column may
     *     shrink below its label → the labels wrapped inside their cells. The
     *     mechanism here is read straight off the inline style and is not in
     *     doubt.
     *   - Forced wide (`min-width: max-content`, the first repair): every tab
     *     inflated ("显得过大") and the strip ran out of the panel ("往右偏移、
     *     跑出页面"). The inflation follows from `max-content`: each `1fr` track
     *     resolves to the **widest** label's width. **Why the
     *     `overflow-x: auto` on our own `div[data-region="tabs"]` did not absorb
     *     the overflow is NOT established** — the hypothesis once written here
     *     (the control's `max-content` minimum propagating up through a flex item
     *     and widening an ancestor column) does not survive a read of the Host's
     *     `SettingsRoot.module.css`: `settings.section` is a list slot rendered
     *     without a DOM wrapper, `.options` is a **block-level scrolling
     *     container** (`display` default) so this plugin's root is an ordinary
     *     block child and `min-width: auto` does not apply to it, and `.content`
     *     already carries `min-width: 0`. Content that overflows `.options`
     *     should therefore scroll inside it rather than widen an ancestor. The
     *     symptom was real; its cause is **unproven** pending a real-machine DOM
     *     look.
     *
     * The hand-built strip (below) lays out with `flex-wrap`: buttons keep their
     * content width and a row that does not fit moves to the next line. It is the
     * layout this page used for its whole life before g-063, and it never once
     * drew a complaint. So this one control stays hand-built **on purpose**: the
     * Host's `Button`, `Input`, `Tag`, `DiffBlock`, the sidebar icons and `Toast`
     * all still come from the official module — only the tabs do not (NOTES §4.2,
     * `CONTRACT.md` §13.4 Revision 49). Note what that does and does not settle:
     * it removes the failed repair and returns to a layout with no complaint
     * against it, which is the right choice under **either** explanation.
     *
     * Rejected repairs, kept for the record: `min-width: max-content` (inflated
     * tabs, and an overflow whose path is unexplained), `white-space: nowrap`
     * alone (labels would then overflow or overlap their cells), and leaving the
     * official equal fractions as they are (labels wrapped). The lesson worth
     * keeping: **an equal-fraction control assumes short labels**; long localized
     * labels need a wrapping, content-sized layout instead.
     *
     * g-070 keeps the exemption and narrows what it covers. The **first-level**
     * strip is now its own renderer ({@link mainTabStrip}): plain text with an
     * underlined selection, the look the operator asked for. `tabs()` below stays
     * the **chip** family — every sub-group selector still uses it — so one
     * function no longer has to speak two visual languages. The first-level strip
     * is also single-line now (`flex-wrap: nowrap` + `overflow-x: auto`) instead
     * of wrapping, and it buys that safety from the scroll container rather than
     * from a wrap: a block-level box with `overflow-x: auto` is only as wide as
     * its parent says, and the CSS automatic minimum size — the rule that would
     * let content push it wide — does not apply to a scroll container. Still no
     * equal fractions and no `max-content` anywhere in it.
     */

    /**
     * Render a segmented control — **always hand-built** (see the decision
     * comment above).
     *
     * Since g-070 `tabs()` is the **chip** family and {@link mainTabStrip} draws
     * the first-level bar. `tabs()` itself is unchanged and still renders every
     * **sub-group** selector in the bundle: `mine-layer` (this file),
     * `advanced-layer`, `history-layer`, `view` and the overview filter groups,
     * `full-origin`, `import-mode` and `preset-mode` — eight rendered call sites
     * across the entry and the four chunks, which take this same binding off
     * `__internals.shared.tabs`. Both renderers emit the same markers, so a test
     * that clicks a tab by value does not care which one drew it.
     *
     * Deliberately *not* a component: it is called during tree building so it
     * emits real host button nodes (role="tab") carrying the `data-tab-*` markers
     * the tests assert on. It is also part of the one control this page keeps
     * hand-built on a primitives Host — the tab strips (this chip family and
     * {@link mainTabStrip}) — and it keeps the content-sized `flex-wrap` row it has
     * always drawn; the official `SegmentedTabs` divides its width into n equal
     * fractions instead, which is what fails the first-level bar's six long Chinese
     * labels (NOTES §4.2 / CONTRACT §13.4 Revisions 49 and 51).
     * @param items - `{value, label, id, panelId}` entries, non-empty.
     * @param value - the selected value.
     * @param onChange - selection callback.
     * @param label - accessible name for the tab list.
     * @param group - marker key identifying which filter group this is.
     * @returns the tab list element.
     */
    function tabs(items, value, onChange, label, group) {
      return h(
        'div',
        {
          role: 'tablist',
          'aria-label': label,
          'data-tab-group': group,
          style: { display: 'flex', gap: 6, flexWrap: 'wrap' },
        },
        items.map((item) =>
          h(
            'button',
            {
              key: item.value,
              type: 'button',
              role: 'tab',
              'aria-selected': item.value === value,
              tabIndex: item.value === value ? 0 : -1,
              'data-tab-key': group,
              'data-tab-value': item.value,
              onClick: () => onChange(item.value),
              // g-061 batch 3: the fallback tab is the chip family's own control.
              // The selected pair (the button fill under a transparent stroke) is
              // still decided here, and this is the one call site whose unselected
              // text colour is the secondary one — the pinned entries and the
              // search fallback use the primary.
              style: chipButtonStyle({
                cursor: 'pointer',
                color: item.value === value ? token.buttonLabel : token.labelSecondary,
                background: item.value === value ? token.buttonFill : 'transparent',
                border: item.value === value ? 'transparent' : token.borderL2,
              }),
            },
            item.label,
          ),
        ),
      );
    }

    /**
     * How many presets the library really holds — or `null` when that number is
     * not known (g-070).
     *
     * The count is only ever a **fact this page has already read**: 「还在加载」
     * /「请求失败」/「库文件读不出来」 all answer `null`, and the tab then renders
     * no suffix at all. `0` is reserved for a library that really came back
     * empty, because a `(0)` drawn before the read lands is a number the page
     * cannot stand behind (CONTRACT §13.4 Revision 51).
     *
     * The slot is the main entry's own (`m.presets`): g-060 already has the
     * library ride the same mount load as the snapshot and the overrides, asked
     * with the same `?session=` — so this count costs **no** extra request, no
     * second read and no polling. Choosing that over "ask the presets chunk to
     * report up" is stated in NOTES §149: the data is already here, and a
     * cross-chunk report would only be needed for a number the main entry never
     * had.
     * @param presets - the page model's preset-library slot (`{phase, data}`).
     * @returns the entry count, or `null` when unknown.
     */
    function presetCountOf(presets) {
      if (presets === null || presets === undefined || presets.phase !== 'ready') return null;
      const payload = presets.data;
      if (payload === null || typeof payload !== 'object') return null;
      // `GET /presets` answers `200` **with** an `error` field when the library
      // file cannot be read (CONTRACT §20.9): that is a library problem, not an
      // empty library, so it may not be shown as `(0)` either.
      if (payload.error) return null;
      return Array.isArray(payload.presets) ? payload.presets.length : null;
    }

    /**
     * Whether a newer release is on offer — the **objective** state the「高级」
     * red dot expresses (g-070).
     *
     * Deliberately the same test {@link renderUpdateNotice} makes — `latest` is a
     * non-empty string — minus one term: `dismissed` is **not** consulted here.
     * Dismissing closes the banner; it cannot un-happen a release, and the dot
     * exists to keep that fact visible after the banner is gone (CONTRACT §13.4
     * Revision 51).
     * @param update - the page model's update slot.
     * @returns `true` when a newer release is on offer.
     */
    function updateOffered(update) {
      if (update === null || update === undefined) return false;
      const data = update.data;
      if (data === null || data === undefined) return false;
      return typeof data.latest === 'string' && data.latest.length > 0;
    }

    /**
     * The **first-level** tab bar: plain text, one line, underlined selection
     * (g-070).
     *
     * A second renderer rather than another branch inside {@link tabs} on
     * purpose. `tabs()` is shared with every sub-group selector in the bundle,
     * which keeps the chip look, and one function carrying two visual languages is
     * the drift this split exists to prevent. The two do share every **marker** the
     * tests and the panel binding read (`role="tablist"` / `role="tab"` /
     * `aria-selected` / `tabIndex` / `data-tab-group` / `data-tab-key` /
     * `data-tab-value`), so only the drawing differs.
     *
     * The layout, and why each part is what it is:
     * - **No equal fractions.** Every button is `flex: 0 0 auto` at its own
     *   label's width — no `flex: 1`, no `grid`, no `repeat(n, …)`, no
     *   `min-width: max-content`. That is exactly what g-063 caught (labels
     *   wrapped, then the strip inflated the row; see the decision comment
     *   above).
     * - **One line, scrollable.** `flexWrap: 'nowrap'` + `overflowX: 'auto'`
     *   keeps six Chinese labels on one line and lets the strip scroll sideways
     *   when the panel is narrower than they are.
     * - **Nothing widens an ancestor.** The strip is a block-level scroll
     *   container, so it is only as wide as its parent allocates, and the CSS
     *   automatic minimum size does not apply to it (it would be `0` for a scroll
     *   container anyway).
     * - **The faint rule** under the whole bar is the container's `borderBottom`,
     *   taken from the weakest border token on the page. The selected tab's 2px
     *   indicator is drawn `bottom: 0` inside that button, i.e. pressed against
     *   the rule, with the button's own bottom padding as the gap.
     * - **Text-only tabs**: no fill, no stroke, no radius. Unselected is the
     *   secondary label colour, selected is the primary one plus a slightly
     *   stronger weight.
     * @param items - `{value, label, count, badge}` entries, in display order.
     *   `count` is a number or `null` (unknown); `badge` marks the red dot.
     * @param value - the selected value.
     * @param onChange - selection callback.
     * @param label - accessible name for the tab list.
     * @param badgeText - the readable description the red dot carries.
     * @returns the tab list element.
     */
    function mainTabStrip(items, value, onChange, label, badgeText) {
      return h(
        'div',
        {
          role: 'tablist',
          'aria-label': label,
          'data-tab-group': 'main',
          style: {
            display: 'flex',
            alignItems: 'stretch',
            flexWrap: 'nowrap',
            gap: 24,
            overflowX: 'auto',
            overflowY: 'hidden',
            borderBottom: `1px solid ${token.borderL1}`,
          },
        },
        items.map((item) => {
          const selected = item.value === value;
          const count = typeof item.count === 'number' ? item.count : null;
          return h(
            'button',
            {
              key: item.value,
              type: 'button',
              role: 'tab',
              'aria-selected': selected,
              tabIndex: selected ? 0 : -1,
              'data-tab-key': 'main',
              'data-tab-value': item.value,
              onClick: () => onChange(item.value),
              style: {
                // The tab itself is text: the fill/stroke pair `tabs()` draws
                // belongs to the chip family, not to this bar.
                position: 'relative',
                flex: '0 0 auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                margin: 0,
                padding: '6px 0 10px',
                font: 'inherit',
                fontSize: 13,
                lineHeight: '20px',
                fontWeight: selected ? 600 : 400,
                // One line per label, always: the strip scrolls instead.
                whiteSpace: 'nowrap',
                color: selected ? token.labelPrimary : token.labelSecondary,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                // The shell's own focus ring is drawn inset
                // (`outline-offset: -2px`), so it stays visible inside the
                // scrolling box instead of being clipped by `overflow`.
                outlineOffset: -2,
              },
            },
            item.label,
            count === null
              ? null
              : h(
                  'span',
                  {
                    key: 'count',
                    'data-role': 'tab-count',
                    style: {
                      fontSize: 11,
                      lineHeight: '16px',
                      fontWeight: 'inherit',
                      // One step weaker than the label's own colour — a token,
                      // never a second palette.
                      color: selected ? token.labelSecondary : token.labelTertiary,
                    },
                  },
                  ` (${count})`,
                ),
            item.badge !== true
              ? null
              : h('span', {
                  key: 'badge',
                  'data-role': 'tab-update-dot',
                  role: 'img',
                  // Readable in both channels: the tooltip for a pointer, and the
                  // text alternative the dot contributes to the tab's own name
                  // (「高级 有可用更新」) — a bare decorative dot would say nothing.
                  title: badgeText,
                  'aria-label': badgeText,
                  style: {
                    flex: '0 0 auto',
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: token.stateError,
                  },
                }),
            selected
              ? h('span', {
                  key: 'indicator',
                  'data-role': 'tab-indicator',
                  'data-tab-indicator': item.value,
                  'aria-hidden': 'true',
                  style: {
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: 2,
                    borderRadius: 1,
                    background: token.stateBusiness,
                    pointerEvents: 'none',
                  },
                })
              : null,
          );
        }),
      );
    }

    /** Subscribe stub used only when the framework hands no locale seat. */
    const noopSubscribe = () => () => {};
    /** Snapshot stub used only when the framework hands no locale seat. */
    const zeroRevision = () => 0;

    /**
     * Translate without ever throwing. Used only by the render-failure card,
     * where `t` itself may be the thing that broke.
     * @param t - candidate translator.
     * @param key - dictionary key.
     * @param literal - text used when the translator is absent or breaks.
     * @returns the localized text, or the literal.
     */
    function safeT(t, key, literal) {
      try {
        const value = t(key);
        return typeof value === 'string' && value.length > 0 ? value : literal;
      } catch {
        return literal;
      }
    }


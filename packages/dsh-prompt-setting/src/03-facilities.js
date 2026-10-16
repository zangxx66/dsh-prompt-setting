// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。

    /**
     * Last-resort translator, replaced by the bound `t` in `apply`. Only used
     * if the framework hands the component no `t` seat.
     * @param key - dictionary key.
     * @returns the key itself.
     */
    let fallbackT = (key) => key;

    /** Theme tokens only: the page must read correctly in light and dark. */
    const token = {
      labelPrimary: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      labelTertiary: 'var(--dsw-alias-label-tertiary)',
      borderL1: 'var(--dsw-alias-border-l1, var(--dsw-alias-border-l2))',
      borderL2: 'var(--dsw-alias-border-l2)',
      stateError: 'var(--dsw-alias-state-error-primary)',
      stateWarn: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-error-primary))',
      stateSuccess: 'var(--dsw-alias-state-success-primary)',
      /** Same token the sidebar tints the active workspace folder with. */
      stateBusiness: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary))',
      surface: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1, transparent))',
      surfaceStroke: 'var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2, transparent))',
      buttonFill: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, transparent))',
      buttonLabel: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      markFill: 'var(--dsw-alias-state-warning-fill, rgba(255, 200, 0, 0.35))',
      diffAddFill: 'var(--dsw-alias-state-success-fill, rgba(0, 200, 100, 0.16))',
      diffDelFill: 'var(--dsw-alias-state-error-fill, rgba(220, 60, 60, 0.16))',
      /** The sidebar's own row-hover fill (`Rows.module.css` uses this token). */
      hoverFill: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))',
      /**
       * The shell-wide focus ring: every product surface draws
       * `outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,
       * var(--dsw-alias-state-business-primary))` with `outline-offset: -2px`
       * (e.g. `dsh-client-ui-sidebar/lib/client.js`), so the page reuses it
       * instead of inventing a ring.
       */
      focusRing: 'var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    };

    /**
     * Folder and caret geometry copied **verbatim** from
     * `@deepseek-ai/dsh-client-ui-primitives` (0.1.7-rc.2):
     * `lib/index.js` `IconFolderOpenArtwork` (fill-only, three paths),
     * `FolderCloseArtwork` (stroke, two paths) and
     * `IconTriangleRightFillArtwork` (the sidebar's collapsed caret).
     *
     * The primitives branch renders those very components; the fallback
     * branch has no module to require, so it re-draws the identical
     * geometry with `React.createElement('svg', …)` — same artwork, no
     * new dependency, and the sidebar's workspace affordance stays
     * recognisable in both branches (NOTES §54).
     */
    const FOLDER_OPEN_PATHS = [
      { d: 'M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z', fill: 'currentColor', opacity: '0.16' },
      { d: 'M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z', fill: 'currentColor' },
      { d: 'M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z', fill: 'currentColor' },
    ];
    /** Closed-folder artwork: strokes, so the weight stays 1px like the sidebar. */
    const FOLDER_CLOSE_PATHS = [
      'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z',
      'M3.63501 7.66614H12.3647',
    ];
    /** Right-pointing caret; rotated 90° in place when the group is open. */
    const CARET_PATH = 'M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z';


    // #region fallback atoms (pure React.createElement + theme tokens)
    /**
     * Hand-built button. Extra props (including `data-*` markers) pass through
     * so the machine-readable attributes survive on the real DOM node.
     * @param props - `variant`, `disabled`, `onClick`, `data-*`, `style`.
     * @returns the button element.
     */
    function FxButton(props) {
      const primary = props.variant === 'primary';
      const disabled = props.disabled === true;
      const rest = { ...props };
      delete rest.variant;
      delete rest.children;
      delete rest.style;
      return h(
        'button',
        {
          ...rest,
          type: 'button',
          disabled,
          style: {
            font: 'inherit',
            fontSize: 13,
            lineHeight: '20px',
            padding: '6px 14px',
            borderRadius: 8,
            cursor: disabled ? 'default' : 'pointer',
            color: primary ? token.buttonLabel : token.labelPrimary,
            background: primary ? token.buttonFill : 'transparent',
            border: primary ? '1px solid transparent' : `1px solid ${token.borderL2}`,
            opacity: disabled ? 0.5 : 1,
            ...(props.style || {}),
          },
        },
        props.children,
      );
    }

    /**
     * Hand-built text input (single line).
     * @param props - native input props plus `data-*`.
     * @returns the input element.
     */
    function FxInput(props) {
      const rest = { ...props };
      delete rest.style;
      return h('input', {
        ...rest,
        type: props.type || 'text',
        style: {
          font: 'inherit',
          fontSize: 13,
          lineHeight: '20px',
          width: '100%',
          boxSizing: 'border-box',
          padding: '6px 10px',
          borderRadius: 8,
          color: token.labelPrimary,
          background: 'transparent',
          border: `1px solid ${token.borderL2}`,
          ...(props.style || {}),
        },
      });
    }

    /**
     * Hand-built multi-line editor (no primitive exists for a textarea).
     * @param props - `value`, `onChange`, `rows`, plus `data-*`.
     * @returns the textarea element.
     */
    function FxTextarea(props) {
      const rest = { ...props };
      delete rest.style;
      return h('textarea', {
        ...rest,
        rows: props.rows || 10,
        style: {
          font: `${13}px/20px ${token.mono}`,
          width: '100%',
          boxSizing: 'border-box',
          padding: '8px 10px',
          borderRadius: 8,
          resize: 'vertical',
          color: token.labelPrimary,
          background: 'transparent',
          border: `1px solid ${token.borderL2}`,
          ...(props.style || {}),
        },
      });
    }

    /**
     * Hand-built tag.
     * @param props - `tone` plus children.
     * @returns the tag element.
     */
    function FxTag(props) {
      const tone = props.tone === undefined ? 'outline' : props.tone;
      const color =
        tone === 'success'
          ? token.stateSuccess
          : tone === 'danger'
            ? token.stateError
            : tone === 'warning'
              ? token.stateWarn
              : token.labelTertiary;
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            fontSize: 12,
            lineHeight: '18px',
            padding: '1px 8px',
            borderRadius: 999,
            border: `1px solid ${token.borderL2}`,
            color,
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      );
    }
    // #endregion

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


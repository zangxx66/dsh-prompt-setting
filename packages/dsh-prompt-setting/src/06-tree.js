// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。

    // #region tree builders (host elements, so `data-*` markers survive)

    /** Shared card style. */
    const cardStyle = {
      border: `1px solid ${token.surfaceStroke}`,
      background: token.surface,
      borderRadius: 10,
      padding: '12px 14px',
    };
    /** Shared small meta text style. */
    const metaStyle = { fontSize: 12, color: token.labelTertiary };
    /** Shared heading style. */
    const headingStyle = { margin: 0, fontSize: 15, fontWeight: 600 };

    /**
     * g-061 batch 2: the four render facilities the entry and the tab chunks
     * all draw with. They are defined here — one binding, on the surface every
     * chunk reaches through `__internals.shared` — because a second copy of any
     * of them would be a second value that can drift away from the page it
     * renders in.
     *
     * Every parameter below is a difference the call sites really have, and
     * **none of them is defaulted into agreement**: the confirmation overlay's
     * 1200 against every tab dialog's 1000, the theme's monospace stack against
     * the preset dialog's `fontFamily: 'inherit'` against the history preview's
     * box, which states no family at all and takes the browser's own, and the
     * four text boxes' own maxHeight / padding / radius / border / break. A
     * default that quietly absorbed one call site's value is exactly the
     * regression these factories exist to make impossible.
     */

    /**
     * The modal scrim: one full-screen backdrop that dims the page behind a
     * dialog card, so the card reads as modal without stealing focus.
     *
     * Four copies differed in one number only — the layer the dialog sits on —
     * so the layer is the argument. It is deliberately **required** rather than
     * defaulted: the confirmation overlay passes 1200 because it is raised on
     * top of every tab-owned dialog (review R6 — at equal z-index the panel is
     * appended later and the question would be invisible and unanswerable), and
     * the「自定义」dialog, the history comparison modal and the two preset
     * dialogs pass 1000. That ordering is a stated contract, not a consequence
     * of which node happens to be appended last.
     * @param zIndex - the dialog's layer; the caller states it.
     * @returns the overlay style.
     */
    function scrimStyle(zIndex) {
      return {
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: 'rgba(0, 0, 0, 0.45)',
      };
    }

    /**
     * One red line stating why the last write — or the whole render — failed.
     *
     * Three copies shared the shape and the red and differed in everything a
     * reader can measure, so each of those is a parameter: the「自定义」dialog's
     * line is a `div` marked `data-role="region-error"` +
     * `data-region-error="…"` carrying the host's code, the preset dialog's is a
     * `div` marked
     * `data-role="preset-dialog-error"` + `data-preset-dialog-error="…"`
     * with a wrapping break and the `presetFailed` prefix, and the failure
     * card's is a `p` with `margin: 0` and the `renderErrorLabel` prefix. The
     * font size is the caller's for the same reason: 13 everywhere today is a
     * fact to assert, not a default to hide behind.
     * @param options - `{tag, role, probe, code, text, fontSize, wrap, margin}`.
     * @returns the line element.
     */
    function errorLine(options) {
      const style = { fontSize: options.fontSize, color: token.stateError };
      if (options.margin !== undefined) style.margin = options.margin;
      if (options.wrap === true) style.wordBreak = 'break-word';
      const attributes = { style };
      if (options.role !== undefined) attributes['data-role'] = options.role;
      if (options.probe !== undefined) {
        attributes[options.probe] = typeof options.code === 'string' ? options.code : 'unknown';
      }
      return h(options.tag ?? 'div', attributes, options.text);
    }

    /**
     * The「nothing here yet」card: the container a list renders instead of its
     * rows when there are none.
     *
     * Two of the four empty states the inventory named share this shape — a
     * `div` carrying `data-empty="…"` under `cardStyle` — and only those
     * two are merged. The other two are **not** this shape and stay as they
     * are: 「版本历史」prints one `metaStyle` line in a `div[data-empty]` with
     * no card at all, and「我的预设」prints a bare `p[data-region]` with
     * `margin: 0` in front of `metaStyle`. Different container, different
     * marker family, different box — merging them would change what the page
     * looks like, which this batch never does.
     * @param marker - the `data-empty` value the list has always published.
     * @param children - the card's text: one line, or a title plus a body.
     * @returns the card element.
     */
    function emptyCard(marker, children) {
      return h('div', { 'data-empty': marker, style: cardStyle }, children);
    }

    /**
     * The pre-wrap text box a stored text, a section body or a diff is shown
     * in.
     *
     * What the five call sites really share is the typesetting skeleton —
     * `margin: 0`, 12px, `white-space: pre-wrap` and `word-break: break-word` —
     * and that is all this factory fixes. The box around it is each call site's
     * own, and every one of those differences is an explicit parameter rather
     * than a default: `maxHeight` 200 / 220 / 320 / 460, `padding`
     * `'4px 6px'` / `'6px 8px'` / `'8px 10px'` / `'10px 12px'`, `radius` 6 or
     * 8, `border` `borderL1` or `borderL2` or none, `lineHeight` only where the
     * text is read line by line, `color` only where the box is not the primary
     * reading surface, and `scroll` as `'overflow'` or `'overflowY'` (the
     * history box scrolls on one axis only).
     *
     * The font family is the one three-state parameter, because the page really
     * has three states and「states nothing」is one of them: `mono: true` writes
     * the theme's monospace stack (the three overview boxes), `mono: false`
     * writes `inherit` (the preset preview, which follows the page font on
     * purpose), and **leaving it out writes no `fontFamily` at all** — the
     * history preview's box has never had one, and its pre element takes the
     * browser's own default. A two-state parameter here would have silently
     * moved that box off the UA font and onto the theme's, which is a visible
     * change this batch may not make.
     * @param options - `{maxHeight, mono, border, padding, radius, lineHeight, color, scroll}`.
     * @returns the style object.
     */
    function monoTextBox(options) {
      const style = {
        margin: 0,
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      };
      if (options.mono === true) style.fontFamily = token.mono;
      else if (options.mono === false) style.fontFamily = 'inherit';
      if (options.lineHeight !== undefined) style.lineHeight = options.lineHeight;
      if (options.color !== undefined) style.color = options.color;
      if (options.maxHeight !== undefined) style.maxHeight = options.maxHeight;
      if (options.scroll !== undefined) style[options.scroll] = 'auto';
      if (options.border !== undefined) style.border = `1px solid ${options.border}`;
      if (options.radius !== undefined) style.borderRadius = options.radius;
      if (options.padding !== undefined) style.padding = options.padding;
      return style;
    }

    /**
     * g-061 batch 3: the dialog shell, the two rows inside it, and the three
     * ghost button families the page draws its small controls with. Same rule as
     * batch 2 — a name lives here only because two or more call sites draw the
     * same shape, and every difference they really have is a stated argument
     * rather than a default that quietly absorbs it.
     *
     * **This batch repairs no drift.** Five values in this family disagree with
     * their neighbours — the preset dialogs' `maxWidth` 520 against the region
     * dialog's 480, their `overflow: 'auto'` against everyone else's
     * `overflowY: 'auto'`, the region dialog's missing `maxHeight` and
     * `overflow`, the pager's padding `'2px 10px'` against its family's
     * `'2px 8px'`, and the preset titles' 15 against the confirmation's 14 —
     * and **all five are kept exactly as they are**, each as an explicit
     * argument. The owner reviewed them and chose to keep the page as it looks
     * today; converging them would be a visible change this batch may not make.
     * Revision 44 records that decision, and the tests assert each value instead
     * of asserting that the family agrees.
     */

    /**
     * The dialog card inside a scrim: one box, its own size and its own scroll.
     *
     * Four call sites draw it — the confirmation overlay and the「自定义」dialog
     * in the entry, the two preset dialogs and the history comparison modal — and
     * what they share is the shell: the card's stroke, surface and radius, and
     * the dialog padding (`'16px 18px'`) and shadow (`0 12px 32px`) all four
     * state identically. Everything a reader can measure differently is an
     * argument: the width (`'100%'` on three, `min(1040px, 92vw)` on the history
     * modal — the reason it states an explicit `maxWidth: '92vw'` beside it as
     * well is not reconstructed here), the `maxWidth` (480 / 480 / **520** /
     * `'92vw'`), the `height` and `maxHeight` (the history modal states both;
     * the confirmation and the preset dialogs state `maxHeight: '80vh'`; the
     *「自定义」dialog states neither), the `overflow` (the confirmation and the
     * history modal scroll on one axis, the preset dialogs on both), the `gap`
     * (10 everywhere except the confirmation, which carries **no** gap at all —
     * its three-level grouping is the `marginTop` spacing §13.5 describes) and the
     * `position` (`'relative'` on the history modal alone, because its close
     * button is anchored to that corner).
     *
     * `overflow` is the **property name**, not a value: each call site says
     * which axis it scrolls, so `'overflowY'` and `'overflow'` stay two
     * different declarations exactly as they are today.
     * @param options - `{width, maxWidth, maxHeight, height, overflow, gap, position}`.
     * @returns the card style.
     */
    function dialogCardStyle(options) {
      const style = {
        ...cardStyle,
        display: 'flex',
        flexDirection: 'column',
        width: options.width,
      };
      if (options.gap !== undefined) style.gap = options.gap;
      if (options.maxWidth !== undefined) style.maxWidth = options.maxWidth;
      if (options.maxHeight !== undefined) style.maxHeight = options.maxHeight;
      if (options.height !== undefined) style.height = options.height;
      if (options.overflow !== undefined) style[options.overflow] = 'auto';
      if (options.position !== undefined) style.position = options.position;
      style.padding = '16px 18px';
      style.boxShadow = '0 12px 32px rgba(0, 0, 0, 0.35)';
      return style;
    }

    /**
     * The dialog's title line: the one emphasized line naming what the dialog is
     * about.
     *
     * Two call sites — the confirmation overlay, which the「自定义」dialog
     * reuses verbatim so that the two remain the **same object**, and the two
     * preset dialogs. What is shared is a `strong` node at weight 600; what
     * differs is stated: the font size (14 against the preset dialogs' **15**),
     * the tone (the confirmation wears the warning colour, the preset dialogs
     * inherit) and the line height (the confirmation states 1.4, the preset
     * dialogs state none).
     *
     * The history modal's head is **not** this shape — it is a flex row holding
     * a title beside an absolutely positioned close button — and stays as it is.
     * @param options - `{fontSize, tone, lineHeight}`.
     * @returns the title style.
     */
    function dialogTitleStyle(options) {
      const style = { fontSize: options.fontSize, fontWeight: 600 };
      if (options.lineHeight !== undefined) style.lineHeight = options.lineHeight;
      if (options.tone !== undefined) style.color = options.tone;
      return style;
    }

    /**
     * The dialog's button row: one flex line of buttons at the bottom of the
     * card.
     *
     * Two call sites — the confirmation overlay (reused by the「自定义」dialog)
     * and the two preset dialogs. Shared: an 8px gap between the buttons. Stated
     * by the caller: where the row sits horizontally (the confirmation starts at
     * the left edge, the preset dialogs push to the right) and whether it
     * carries the confirmation's **top divider** — the 16px gap, the 12px inset
     * and the rule §13.5 calls「behind a top divider」, which the preset dialogs do
     * not have. The preset dialogs also carry a `flexWrap` that their single
     * button never needs; it is kept, because dropping it is a change to a
     * declared style even where it has no visible effect.
     * @param options - `{align, divider, wrap}`.
     * @returns the actions style.
     */
    function dialogActionsStyle(options) {
      const style = { display: 'flex', gap: 8 };
      if (options.align !== undefined) style.justifyContent = options.align;
      if (options.divider === true) {
        style.marginTop = 16;
        style.paddingTop = 12;
        style.borderTop = `1px solid ${token.borderL1}`;
      }
      if (options.wrap === true) style.flexWrap = 'wrap';
      return style;
    }

    /**
     * The pill-shaped ghost button: the small chip control the page draws in its
     * rows and in the search fallback.
     *
     * Three call sites — the fallback tab button, the pinned「全局 / 当前会话」
     * entries and the「使用这串 id」button — share everything but their colour:
     * the inherited 12px/18px type, the `'3px 10px'` padding and the 999px radius
     * are the shape, and the text colour, the fill and the stroke are arguments.
     * The unselected text colour really differs (**secondary** on the chip-family
     * `tabs()` call sites, **primary** on the other two), so it is the caller's;
     * the selected state —
     * the button fill under a transparent stroke — stays the caller's own
     * expression, as does every attribute on the node.
     *
     * **A caveat worth stating, not a defect:** that second-renderer caveat is
     * gone as of g-063's third real-machine round — the tab strips are hand-built
     * under **both** renderers (the Host's `SegmentedTabs` divides its width into
     * equal fractions, which the first-level bar's six long Chinese labels do not
     * fit), so both renderers draw the same strips and they do look alike. Since
     * g-070 the first-level bar is {@link mainTabStrip}'s plain text, so this
     * factory is the **chip family's** shape — the sub-group selectors — and no
     * longer the whole strip's.
     * @param options - `{cursor, color, background, border}`; `border` is the
     *   stroke's colour, the 1px width belongs to the shape.
     * @returns the chip style.
     */
    function chipButtonStyle(options) {
      return {
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        padding: '3px 10px',
        borderRadius: 999,
        cursor: options.cursor,
        color: options.color,
        background: options.background,
        border: `1px solid ${options.border}`,
      };
    }

    /**
     * The small radius-6 ghost button: the page's tool-strip control.
     *
     * Five `miniButtonStyle` call sites —「更多」in a scope group, the history
     * row's side style (one call site that feeds two buttons), the history pager,
     * the overview section's expand toggle and one option row of the history
     * scope list — share the type, the 6px radius, the pointer cursor and the
     * fill role; the padding, the colour, the stroke and whether a line height is
     * stated at all are arguments — four different paddings among them
     * (`'2px 8px'` on three, `'2px 8px 2px 20px'` on「更多」, `'4px 8px'` on the
     * scope option row, `'2px 10px'` on the pager). **Three of them state no
     * `lineHeight` and the factory writes none for them**: adding the 18px their
     * neighbour「更多」carries would change how tall those rows are, which is not
     * this batch's to change. The pager's `'2px 10px'` sits beside its family's
     * `'2px 8px'` and is kept as it is.
     * @param options - `{padding, color, background, border, lineHeight, textAlign}`;
     *   `border` is the whole declaration, because one call site's is `none`.
     * @returns the button style.
     */
    function miniButtonStyle(options) {
      const style = { font: 'inherit', fontSize: 12 };
      if (options.lineHeight !== undefined) style.lineHeight = options.lineHeight;
      if (options.textAlign !== undefined) style.textAlign = options.textAlign;
      style.padding = options.padding;
      style.borderRadius = 6;
      style.cursor = 'pointer';
      style.color = options.color;
      style.background = options.background;
      style.border = options.border;
      return style;
    }

    /**
     * One session row: the interactive row button the「查看范围」tree and its
     * flat fallback list are both built from.
     *
     * The shared shape is the row itself — the inherited 12px/18px type over a
     * left-aligned flex line, the 6px radius, the pointer cursor and the
     * product's focus ring (all of those from `scopeRowStyle`), the primary text
     * colour, and the three-state fill: a selected or keyboard-highlighted row
     * takes the business fill, a hovered row the hover fill, everything else is
     * transparent. `padding` is the argument that really differs — the tree row
     * carries its 20px indent inside it (`'3px 8px 3px 20px'`), the flat row does
     * not (`'4px 8px'`) — and `selected` alone decides the left bar and the
     * stroke, exactly as before.
     *
     * **The ARIA shape is not here, and must not move here.** The tree row is a
     * level-2 `treeitem` marked `data-role="session-row"`; the flat row is an
     * `option` inside a `listbox`, marked `data-role="session-option"`; the tree
     * row alone carries `data-scope-parent` and `data-session-running`. Those
     * are attributes on different nodes with different meanings, and
     * `test/client.test.mjs` pins both trees. Only the paint moved.
     * @param options - `{padding, hovered, focused, selected, active}`.
     * @returns the row style.
     */
    function sessionRowStyle(options) {
      return {
        ...scopeRowStyle(options.hovered, options.focused),
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: options.padding,
        color: token.labelPrimary,
        background:
          options.selected || options.active
            ? token.diffAddFill
            : options.hovered
              ? token.hoverFill
              : 'transparent',
        boxShadow: options.selected ? `inset 3px 0 0 0 ${token.stateBusiness}` : undefined,
        border: `1px solid ${options.selected ? token.borderL2 : 'transparent'}`,
      };
    }

    /**
     * The needle every search box on this page compares against: trimmed and
     * lowercased, and `''` for anything that is not a string.
     * @param query - the raw box content.
     * @returns the normalized needle.
     */
    function normalizeNeedle(query) {
      return typeof query === 'string' ? query.trim().toLowerCase() : '';
    }

    /**
     * Whether a needle occurs in any of the fields one search box covers.
     *
     * `cached` is the one thing the two consumers really differ in. The session
     * list is lowercased **once**, when it is decoded, into `row.haystack` — one
     * pre-joined string covering id, title and directory — because it can hold
     * thousands of rows; the history scope list has no such cache and is compared
     * field by field. Both behaviours are kept: passing `cached` searches that
     * string, omitting it walks the fields.
     *
     * **The factory never joins the fields itself.** Joining would let a match
     * span a field boundary (the tail of one title against the head of the next
     * field), which is a **new** hit on the history side — it would move the
     * `data-history-scope-shown` count and the assertions that read it. The two
     * sides therefore keep the semantics they already had, and the shared
     * function is the shape they have in common rather than a convergence of
     * their answers.
     *
     * `indexOf` and `includes` ask the same question here; the shared path asks
     * it with `includes`, and the cached path keeps `indexOf` on the
     * pre-lowercased string.
     * @param values - the fields to compare, in the order the page has them.
     * @param needle - the already-normalized needle.
     * @param options - optional `{cached}`: a pre-lowercased haystack.
     * @returns whether any field carries the needle.
     */
    function matchesNeedle(values, needle, options) {
      if (needle.length === 0) return true;
      const cached = options !== undefined && typeof options.cached === 'string' ? options.cached : null;
      if (cached !== null) return cached.indexOf(needle) >= 0;
      return values.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
    }

    /**
     * The always-visible「查看范围」summary row (g-016). One flex line — a
     * heading, the readable scope name, an optional short state hint and the
     *「更改」switch — so the card's height collapses to its own padding plus
     * this row, and the tab bar below it stays on the first screen.
     */
    const scopeSummaryStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 24 };
    /** The readable scope name in the summary row. */
    const scopeSummaryTextStyle = { ...metaStyle, fontSize: 13, lineHeight: '20px', color: token.labelPrimary };
    /** The summary row's degradation hint (`scopeSummaryManual` / `scopeSummaryFlat`). */
    const scopeSummaryHintStyle = { ...metaStyle, lineHeight: '18px' };

    /**
     * The「我的 Prompt」block's leading rule, 3px with a 12px inset — the visual
     * claim that the scope row and the write surface are one block rather than
     * two page-level settings.
     *
     * g-055 gave it to **both** halves (the block above the tabs and the mine
     * panel). g-071 moved the block inside the mine panel, which already carries
     * the rule, so the rule is now stated once, by the panel: two nested copies
     * would draw two parallel bars a few pixels apart and read as two blocks —
     * exactly the reading g-055 introduced the rule to prevent.
     */
    const promptBlockBandStyle = { borderLeft: `3px solid ${token.stateBusiness}`, paddingLeft: 12 };
    /**
     * The block wrapper: one sentence, then the scope card. Since g-071 it is the
     * first child block **inside** the mine panel (after the panel's own `h3`),
     * so it states no rule of its own — see {@link promptBlockBandStyle}.
     */
    const promptBlockStyle = { display: 'flex', flexDirection: 'column', gap: 6 };
    /**
     * The one sentence that ties the scope to the write surface. Since the block
     * carries no heading of its own (review round 1: a second「我的 Prompt」title
     * two lines above the panel's own title repeated the name and the level),
     * this line is what names the grouping, so it is a step darker than plain
     * meta text.
     */
    const promptBlockNoteStyle = { margin: 0, ...metaStyle, lineHeight: '18px', color: token.labelSecondary };

    /**
     * Render one line of layer information.
     * @param t - the bound translator.
     * @param label - the localized layer name.
     * @param layer - `layers.user` / `layers.workspace`, or undefined.
     * @param key - `data-layer-status` marker value.
     * @returns the row element.
     */
    function layerLine(t, label, layer, key) {
      const enabled = layer ? layer.enabled === true : false;
      const reason = layer && layer.reason ? String(layer.reason) : '';
      return h(
        'div',
        {
          'data-layer-status': key,
          'data-enabled': String(enabled),
          style: { fontSize: 12, color: token.labelSecondary, display: 'flex', gap: 8, flexWrap: 'wrap' },
        },
        h('strong', { style: { fontWeight: 600 } }, label),
        h(UI.Tag, { tone: enabled ? 'success' : 'warning' }, enabled ? t('stEnabled') : t('stDisabled')),
        h(
          'span',
          { style: metaStyle },
          `${t('stPath')}: ${layer && layer.path ? String(layer.path) : t('stNone')}`,
        ),
        reason ? h('span', { style: { ...metaStyle, color: token.stateWarn } }, `${t('stReason')}: ${reason}`) : null,
      );
    }

    /**
     * Render an error banner for a failed request.
     * @param t - the bound translator.
     * @param error - the error descriptor.
     * @param title - the localized banner heading.
     * @returns the banner element.
     */
    function errorBanner(t, error, title) {
      return h(
        'div',
        {
          'data-error-code': error && error.code ? String(error.code) : '',
          'data-error-status': String(error && error.status ? error.status : 0),
          style: { ...cardStyle, borderColor: token.stateError },
        },
        h('strong', { style: { color: token.stateError, fontSize: 13 } }, title || t('errTitle')),
        h('div', { style: { marginTop: 4, fontSize: 13, color: token.labelPrimary } }, errorText(t, error)),
        error && error.code
          ? h('div', { style: { ...metaStyle, marginTop: 4 } }, `${t('errCode')}: ${error.code}`)
          : null,
        error && error.message
          ? h('div', { style: { ...metaStyle, marginTop: 2, wordBreak: 'break-word' } }, `${t('errDetail')}: ${error.message}`)
          : null,
      );
    }

    // #region stage 2 helpers (history / diff / reset / transfer)

    /**
     * Localized label for one history action.
     * @param t - the bound translator.
     * @param action - `replace` | `hide` | `append` | `remove` | `reset-layer`.
     * @returns the display string (the raw action for an unknown value).
     */
    function historyActionLabel(t, action) {
      const key = `histAction.${String(action)}`;
      const text = safeT(t, key, '');
      return text.length > 0 ? text : String(action);
    }

    /**
     * The pre-localization rendering, kept as the fallback for a value no
     * `Date` can parse. Shape-preserving rather than invented: an unknown
     * string is shown as it arrived, minus the `T`/millisecond noise.
     * @param at - a non-empty string.
     * @returns the fallback display string.
     */
    function rawStamp(at) {
      return at.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
    }

    let stampFormatter = null;
    let stampFormatterResolved = false;

    /**
     * The cached formatter for the **browser's own** time zone, or null when
     * this engine cannot build one.
     *
     * Built lazily and once: the zone cannot change while the tab is open, and
     * a history list calls the stamp per row, so constructing a formatter per
     * row would be the one cost this page does not need. An engine that rejects
     * `shortOffset` degrades to `short` (`GMT+8` either way on the engines this
     * page runs on) and then to no zone label at all — never to a blank cell.
     * @returns the formatter, or null.
     */
    function localStampFormatter() {
      if (stampFormatterResolved) return stampFormatter;
      stampFormatterResolved = true;
      if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return null;
      const skeleton = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      };
      for (const timeZoneName of ['shortOffset', 'short', null]) {
        try {
          stampFormatter = new Intl.DateTimeFormat(
            undefined,
            timeZoneName === null ? skeleton : { ...skeleton, timeZoneName },
          );
          return stampFormatter;
        } catch {
          stampFormatter = null;
        }
      }
      return null;
    }

    /**
     * The reader's-zone parts of one timestamp — `{date, time, zone}` in the
     * fixed `YYYY-MM-DD` / `HH:mm:ss` / `GMT±h[:mm]` shape — or null when the
     * value cannot be read as a time, or when this engine cannot build a
     * formatter.
     *
     * One extractor, two renderers: the visible stamp ({@link stampOf}) and the
     * export file name ({@link exportFileName}). A second parsing path would be
     * a second place for the zone to go wrong, and the two would then disagree
     * about the same instant.
     * @param at - a non-empty string.
     * @returns the parts, or null.
     */
    function localStampParts(at) {
      const value = Date.parse(at);
      if (!Number.isFinite(value)) return null;
      const formatter = localStampFormatter();
      if (formatter === null) return null;
      try {
        const parts = formatter.formatToParts(new Date(value));
        const part = (type) => {
          const found = parts.find((entry) => entry.type === type);
          return found === undefined ? '' : found.value;
        };
        return {
          date: `${part('year')}-${part('month')}-${part('day')}`,
          time: `${part('hour')}:${part('minute')}:${part('second')}`,
          zone: part('timeZoneName'),
        };
      } catch {
        return null;
      }
    }

    /**
     * A readable timestamp in the **reader's own time zone**.
     *
     * The host stores and answers UTC ISO strings, which is the right thing to
     * store and the wrong thing to read: `2024-01-02T10:00:00.000Z` is 18:00
     * for a reader at UTC+8, so echoing the stored string makes every reader do
     * the arithmetic — and, because the stored form carries no zone spelling,
     * makes them guess whether the `Z` even matters. The stamp is therefore
     * rendered in the browser's zone with the zone named:
     * `2024-01-02 18:00:00 GMT+8`.
     *
     * The *shape* stays fixed (`YYYY-MM-DD HH:mm:ss` + zone label) rather than
     * following the locale: what differs per reader is the zone, and only the
     * zone, so two people comparing notes still read the same skeleton. The
     * stored UTC value stays available as the node's `title`.
     *
     * Never throws, like the version it replaces: an unparsable value is echoed
     * (see {@link rawStamp}) and an engine without `Intl` prints the UTC string
     * rather than nothing.
     * @param at - the ISO timestamp, or null.
     * @returns the display string.
     */
    function stampOf(at) {
      if (typeof at !== 'string' || at.length === 0) return '';
      const local = localStampParts(at);
      if (local === null) return rawStamp(at);
      return local.zone.length > 0
        ? `${local.date} ${local.time} ${local.zone}`
        : `${local.date} ${local.time}`;
    }

    /**
     * The query string one stage 2 request needs for a layer.
     * @param layer - `user` | `workspace`.
     * @param sessionArg - the session id, or null.
     * @returns `layer=…&session=…`.
     */

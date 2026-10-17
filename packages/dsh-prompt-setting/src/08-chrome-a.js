// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。

    /**
     * The plugin version, beside the page title (Revision 17 — it was a chip on
     * the status line before, which made the page's identity look like one more
     * health verdict).
     *
     * The text is `v` + the version from the ping, or「版本未知」when that same
     * ping carried no usable one. The repository URL comes from that ping too —
     * the host derives it from its own `package.json` — so neither half writes a
     * URL down:
     *   - with a URL: an `a` element (`target="_blank"`,
     *     `rel="noreferrer noopener"`) whose `data-plugin-repository` carries the
     *     reported URL;
     *   - without one: the same node as a `span` marked
     *     `data-plugin-repository="unknown"` — **not clickable**, because a
     *     guessed or empty `href` would send the reader somewhere no manifest
     *     names.
     *
     * Both forms carry `data-role="plugin-version"`, the marker a probe reads;
     * the root container keeps its `data-plugin-version` (§13.8).
     * @param t - the bound translator.
     * @param m - the page model.
     * @returns the version node.
     */
    function renderPluginVersion(t, m) {
      const version = pluginVersionOf(m.boot);
      const repository = pluginRepositoryOf(m.boot);
      const text = version === 'unknown' ? t('stPluginVersionUnknown') : `v${version}`;
      const shared = {
        'data-role': 'plugin-version',
        'data-plugin-repository': repository === null ? 'unknown' : repository,
        title: t('stPluginVersion'),
        style: { fontSize: 13, color: token.labelTertiary },
      };
      if (repository === null) {
        return h('span', { key: 'version', ...shared }, text);
      }
      return h(
        'a',
        {
          key: 'version',
          ...shared,
          href: repository,
          target: '_blank',
          rel: 'noreferrer noopener',
          style: { ...shared.style, textDecoration: 'underline' },
        },
        text,
      );
    }

    /**
     * One line of the facts that decide whether a write here will do anything:
     * mounted, the frozen three-state verdict, and the build stamp's verdict.
     * (The plugin version is beside the page title instead — see
     * {@link renderPluginVersion}; Revision 17 moved it there and this line is
     * unchanged otherwise.)
     *
     * g-015 moved every *explanation* into 「高级」 (see
     * {@link renderStatusDetail}): the top of the page states the verdicts, and
     * the reason behind each one is one tab away rather than three paragraphs
     * of permanently visible text. Nothing is lost — each tag keeps its reason
     * as a `title`, and the full paragraph is rendered in the detail block.
     *
     * `data-region="status"` is unchanged, and so is the build stamp's
     * machine-readable copy on the root container (`data-build`,
     * `data-build-server`, `data-build-match`), so a probe that read the page
     * before this goal still reads it.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the section element.
     */
    function renderStatusLine(t, m, a) {
      const snapshot = m.snap.data;
      const fz = m.fz;
      const verdict = buildVerdict(m.boot);
      const mounted = snapshot ? snapshot.mounted === true : null;
      const mountedText =
        mounted === null ? t('stMountedUnknown') : mounted ? t('stMountedOn') : t('stMountedOff');
      return h(
        'section',
        {
          'data-region': 'status',
          'data-status-mount': mounted === null ? 'unknown' : String(mounted),
          'data-status-frozen': fz.kind,
          'data-status-build': verdict,
          style: { ...cardStyle, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
        },
        h('span', { style: { ...metaStyle, fontWeight: 600 } }, t('stateHeading')),
        h(
          UI.Tag,
          { tone: mounted === true ? 'success' : mounted === false ? 'danger' : 'outline', title: t('stMounted') },
          `${t('stMounted')}: ${mountedText}`,
        ),
        h(
          UI.Tag,
          {
            tone: fz.kind === 'unknown' ? 'warning' : fz.frozen ? 'danger' : 'success',
            title: fz.reason ? String(fz.reason) : undefined,
          },
          t(frozenKey(fz)),
        ),
        h(
          UI.Tag,
          { tone: verdict === 'true' ? 'success' : verdict === 'false' ? 'danger' : 'outline', title: t('stBuild') },
          `${t('stBuild')}: ${t(verdict === 'true' ? 'stBuildSame' : verdict === 'false' ? 'stBuildStale' : 'stBuildUnknown')}`,
        ),
        h(UI.Button, { variant: 'outline', 'data-action': 'refresh', onClick: a.refresh }, t('refresh')),
        // g-052: the two explanation lines belong on the first-screen summary
        // too — this is where the reader actually meets the verdict. The
        // container is a wrapping flex row, so each line takes `flexBasis: 100%`
        // and drops onto its own full-width row under the tags.
        ...(fz.kind === 'unknown' && !fz.pending
          ? unknownFrozenExplanation(
              t,
              { probe: 'frozen-line-probe', notFrozen: 'frozen-line-not-frozen' },
              [
                { flexBasis: '100%', margin: 0, color: token.stateWarn },
                { flexBasis: '100%', margin: 0, color: token.labelTertiary },
              ],
            )
          : []),
      );
    }

    /**
     * The two explanation lines an *unknown* frozen verdict carries (g-052):
     * what could not be probed, and what "unknown" does not claim.
     *
     * Each sentence is its own paragraph node — not one paragraph, not a
     * line-break element — so the two stay independently addressable. Two call
     * sites share them: the first-screen status line (where the reader meets the
     * verdict) and the full detail block in 「高级」. Each site passes its own
     * markers, because two copies of one `data-warning` on the same page would
     * break the uniqueness probes.
     *
     * @param t - the bound translator.
     * @param markers - `{probe, notFrozen}`: the two `data-warning` values.
     * @param styles - two style objects, in reading order; merged over the
     *   shared 12px / break-word base.
     * @returns the two paragraph elements, in reading order.
     */
    function unknownFrozenExplanation(t, markers, styles) {
      const base = { fontSize: 12, wordBreak: 'break-word' };
      return [
        h('p', { 'data-warning': markers.probe, style: { ...base, ...styles[0] } }, t('stFrozenUnknownProbe')),
        h(
          'p',
          { 'data-warning': markers.notFrozen, style: { ...base, ...styles[1] } },
          t('stFrozenUnknownNotFrozen'),
        ),
      ];
    }

    /**
     * The full status block, rendered in 「高级」: everything the one-line
     * summary compresses, plus the facts that were always detail — the
     * generation timestamp, both layers' `enabled`/`path`/`reason`, both build
     * digests, which renderer branch this page got, and why an unavailable
     * primitives module degraded it.
     *
     * Both non-green build states explain themselves, and neither is ever
     * rendered as「过期」unless both digests really answered and really differ;
     * the frozen verdict is likewise never reported as「未冻结」when it is
     * unknown.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @returns the section element.
     */
    function renderStatusDetail(t, m) {
      const snapshot = m.snap.data;
      const fz = m.fz;
      const verdict = buildVerdict(m.boot);
      const selfHash = m.boot && m.boot.self && typeof m.boot.self.hash === 'string' ? m.boot.self.hash : null;
      const serverHash =
        m.boot && m.boot.server && typeof m.boot.server.hash === 'string' ? m.boot.server.hash : null;
      const mounted = snapshot ? snapshot.mounted === true : null;
      const mountedText =
        mounted === null ? t('stMountedUnknown') : mounted ? t('stMountedOn') : t('stMountedOff');
      const frozenText = t(frozenKey(fz));
      const layers = snapshot && snapshot.layers ? snapshot.layers : {};
      // Revision 18: the stored UTC value is what the host answered, so it is
      // rendered — in the reader's zone — rather than echoed; the raw string
      // stays on the node's `title` for anyone comparing it with a host log.
      const rawGeneratedAt =
        snapshot && snapshot.generatedAt ? String(snapshot.generatedAt) : null;
      const generatedAt = rawGeneratedAt === null ? '' : stampOf(rawGeneratedAt);
      return h(
        'section',
        { 'data-region': 'status-detail', style: cardStyle },
        h('h3', { style: headingStyle }, t('stateHeading')),
        h(
          'div',
          { style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: metaStyle }, `${t('stMounted')}:`),
          h(UI.Tag, { tone: mounted === true ? 'success' : mounted === false ? 'danger' : 'outline' }, mountedText),
          h(UI.Tag, { tone: fz.kind === 'unknown' ? 'warning' : fz.frozen ? 'danger' : 'success' }, frozenText),
          h(
            'span',
            { style: metaStyle, title: rawGeneratedAt === null ? undefined : rawGeneratedAt },
            `${t('stGeneratedAt')}: ${generatedAt.length > 0 ? generatedAt : t('stNone')}`,
          ),
        ),
        h(
          'div',
          {
            'data-region': 'build',
            style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
          },
          h('span', { style: metaStyle }, `${t('stBuild')}:`),
          h(
            UI.Tag,
            { tone: verdict === 'true' ? 'success' : verdict === 'false' ? 'danger' : 'outline' },
            t(verdict === 'true' ? 'stBuildSame' : verdict === 'false' ? 'stBuildStale' : 'stBuildUnknown'),
          ),
          h('span', { style: metaStyle }, `${t('stBuildSelf')}: ${selfHash === null ? t('stNone') : selfHash}`),
          h('span', { style: metaStyle }, `${t('stBuildServer')}: ${serverHash === null ? t('stNone') : serverHash}`),
        ),
        verdict === 'false'
          ? h(
              'p',
              {
                'data-warning': 'client-build-stale',
                style: { margin: '8px 0 0', fontSize: 12, color: token.stateError, wordBreak: 'break-word' },
              },
              t('stBuildStaleHint'),
            )
          : null,
        verdict === 'unknown'
          ? h(
              'p',
              {
                'data-warning': 'client-build-unknown',
                style: { margin: '8px 0 0', fontSize: 12, color: token.labelTertiary, wordBreak: 'break-word' },
              },
              m.boot && m.boot.pingFailed
                ? `${t('stBuildUnknown')} — ${t('stBuildPingFailedHint')}`
                : t('stBuildUnknownHint'),
            )
          : null,
        fz.kind === 'unknown' && !fz.pending
          ? h(
              'p',
              {
                'data-warning': 'frozen-unknown',
                style: { margin: '8px 0 0', fontSize: 12, color: token.stateWarn, wordBreak: 'break-word' },
              },
              `${t('stFrozenUnknown')}${fz.reason ? ` — ${t('stReason')}: ${fz.reason}` : ''}`,
            )
          : null,
        // g-052: the same two explanation lines, with this block's own markers
        // (the first-screen copy uses different ones) and its stacked margins.
        ...(fz.kind === 'unknown' && !fz.pending
          ? unknownFrozenExplanation(
              t,
              { probe: 'frozen-unknown-probe', notFrozen: 'frozen-unknown-not-frozen' },
              [
                { margin: '4px 0 0', color: token.stateWarn },
                { margin: '2px 0 0', color: token.labelTertiary },
              ],
            )
          : []),
        fz.kind === 'unknown' && fz.frozen
          ? h(
              'p',
              { 'data-warning': 'frozen-global', style: { margin: '4px 0 0', fontSize: 12, color: token.stateWarn } },
              t('stFrozenGlobal'),
            )
          : null,
        fz.certain && fz.frozen
          ? h(
              'p',
              {
                'data-warning': 'frozen',
                style: { margin: '8px 0 0', fontSize: 12, color: token.stateError, wordBreak: 'break-word' },
              },
              `${frozenText}${fz.reason ? ` — ${t('stReason')}: ${fz.reason}` : ''}`,
            )
          : null,
        mounted === false
          ? h(
              'p',
              { 'data-warning': 'not-mounted', style: { margin: '8px 0 0', fontSize: 12, color: token.stateWarn } },
              t('stMountedOff'),
            )
          : null,
        h(
          'div',
          { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 } },
          layerLine(t, t('stUserLayer'), layers.user, 'user'),
          layerLine(t, t('stWorkspaceLayer'), layers.workspace, 'workspace'),
        ),
        h(
          'div',
          {
            'data-region': 'renderer-info',
            // g-063 E1: whether the Host's atoms have already thrown while React
            // rendered them. `data-renderer` is the branch **in use**; this says
            // why it is not the probed one, and the failure text sits in
            // `data-primitives-render-error` below.
            'data-primitives-render-failed': String(primitivesRenderFailed),
            style: { marginTop: 8, fontSize: 12, color: token.labelTertiary },
          },
          `${t('rendererLabel')}: ${t(activeRenderer() === 'primitives' ? 'rendererPrimitives' : 'rendererFallback')}`,
          activeRenderer() === 'fallback' && primitivesRenderFailed
            ? h(
                'div',
                { 'data-primitives-render-error': 'true', style: { marginTop: 2, wordBreak: 'break-word' } },
                `${t('primitivesFailure')}: ${primitivesRenderFailure}`,
              )
            : null,
          RENDERER === 'fallback' && primitivesFailure
            ? h(
                'div',
                { 'data-primitives-failure': 'true', style: { marginTop: 2, wordBreak: 'break-word' } },
                `${t('primitivesFailure')}: ${primitivesFailure}`,
              )
            : null,
          // g-063 wrap-up: the two always-on probe rows that used to sit here
          // (`data-primitives-detail`, `data-primitives-members` — the `require`
          // details and the `Button`/`Toast` `typeof` table, plus
          // `data-primitives-button-component`) were removed by the lead's
          // request. They were diagnostics for locating the `forwardRef` defect
          // on a real machine; that job is done, so the block keeps the branch
          // line above and the two **exceptional** reason rows below (both
          // render only when something actually went wrong).
          h(
            'div',
            {
              'data-primitives-toast-source': primitivesProbe.toastSource,
              style: { marginTop: 2, wordBreak: 'break-word' },
            },
            `${t('primitivesToastLabel')}: ${
              primitivesProbe.toastSource === 'none'
                ? t('toastNamespaceNone')
                : primitivesProbe.toastSource === 'default'
                  ? t('toastNamespaceDefault')
                  : t('toastNamespaceModule')
            }`,
          ),
        ),
      );
    }

    /**
     * Render the session selector (root `useSessions` seat, or the manual
     * degradation with its limitation spelled out).
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the section element.
     */
    /**
     * Does this event originate from a keyboard interaction?
     *
     * `:focus-visible` is the browser's own answer; when the event carries no
     * element to ask (or `matches` throws, as in a non-DOM environment) the ring
     * is shown — a visible ring is the safe direction to fail in.
     * @param event - a focus/blur event.
     * @returns whether the focus ring should be drawn.
     */
    function focusVisibleOf(event) {
      const target = event && event.target;
      if (target && typeof target.matches === 'function') {
        try {
          return target.matches(':focus-visible');
        } catch {
          return true;
        }
      }
      return true;
    }

    /**
     * The workspace folder glyph, open or closed, at the size the sidebar uses.
     * Primitives components when the module really exposes them, the identical
     * inlined geometry otherwise (NOTES §54).
     * @param open - whether the group is expanded.
     * @param size - rendered square size in px.
     * @returns the icon element.
     */
    function scopeFolderGlyph(open, size) {
      if (iconSource() === 'primitives') {
        const Icon = open ? primitives.IconFolderOpenRegular : primitives.IconFolderCloseRegular;
        return h(Icon, { size, 'data-role': 'scope-folder-glyph' });
      }
      if (open) {
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            xmlns: 'http://www.w3.org/2000/svg',
            'aria-hidden': 'true',
            'data-role': 'scope-folder-glyph',
          },
          FOLDER_OPEN_PATHS.map((path, index) =>
            h('path', {
              key: `p${index}`,
              d: path.d,
              fill: path.fill,
              opacity: path.opacity,
            }),
          ),
        );
      }
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          strokeWidth: 1,
          'data-role': 'scope-folder-glyph',
        },
        FOLDER_CLOSE_PATHS.map((d, index) => h('path', { key: `p${index}`, d, stroke: 'currentColor' })),
      );
    }

    /**
     * The expansion caret: the sidebar's own right-pointing triangle, rotated
     * in place while the group is open. Rotation is inline so the state is
     * visible without any stylesheet.
     * @param open - whether the group is expanded.
     * @param size - rendered square size in px.
     * @returns the caret element.
     */
    function scopeCaretGlyph(open, size) {
      const style = {
        display: 'inline-flex',
        transform: open ? 'rotate(90deg)' : 'none',
        transition: 'transform 0.15s',
        color: token.labelTertiary,
      };
      if (iconSource() === 'primitives') {
        return h('span', { style }, h(primitives.IconTriangleRightFillRegular, { size }));
      }
      return h(
        'span',
        { style },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            xmlns: 'http://www.w3.org/2000/svg',
            'aria-hidden': 'true',
            'data-role': 'scope-caret-glyph',
          },
          h('path', { d: CARET_PATH, fill: 'currentColor' }),
        ),
      );
    }

    /**
     * Shared interaction styling for one clickable row: pointer cursor, hover
     * fill, and the product's focus ring. The two states are mirrored into
     * `data-hover` / `data-focus` so they are machine-checkable without CSS.
     * @param hover - whether the pointer is over the row.
     * @param focus - whether the row holds keyboard focus.
     * @returns the style object.
     */
    function scopeRowStyle(hover, focus) {
      return {
        cursor: 'pointer',
        userSelect: 'none',
        background: hover ? token.hoverFill : 'transparent',
        outline: focus ? token.focusRing : 'none',
        outlineOffset: focus ? '-2px' : undefined,
        borderRadius: 6,
      };
    }

    /**
     * One pinned picker entry: always visible, never filtered, one click away.
     * It carries an explicit selected state (`data-selected` + a tick) rather
     * than relying on the label alone.
     * @param t - the bound translator.
     * @param key - 'global' | 'current' (the `data-pinned` marker).
     * @param label - localized label.
     * @param active - whether this entry is the current scope.
     * @param disabled - whether the entry cannot be used right now.
     * @param hovered - whether the pointer is over this entry.
     * @param focused - whether this entry holds keyboard focus.
     * @param onClick - selection callback.
     * @param setHover - hover state callback (`false` when leaving).
     * @param setFocus - focus state callback.
     * @returns the button element.
     */
    function pinnedSessionButton(t, key, label, active, disabled, hovered, focused, onClick, setHover, setFocus) {
      return h(
        'button',
        {
          type: 'button',
          'data-action': 'session-pinned',
          'data-role': 'pinned-option',
          'data-pinned': key,
          'data-pinned-active': String(active),
          'data-selected': String(active),
          'data-hover': String(hovered),
          'data-focus': String(focused),
          disabled,
          onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onFocus: (event) => setFocus(focusVisibleOf(event)),
          onBlur: () => setFocus(false),
          style: {
            ...chipButtonStyle({
              cursor: disabled ? 'default' : 'pointer',
              color: active ? token.buttonLabel : token.labelPrimary,
              background: active ? token.buttonFill : hovered && !disabled ? token.hoverFill : 'transparent',
              border: active ? 'transparent' : token.borderL2,
            }),
            // The pill is the chip family's; what this entry adds is the tick's
            // own row, its disabled opacity and its focus ring.
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            opacity: disabled ? 0.5 : 1,
            outline: focused ? token.focusRing : 'none',
            outlineOffset: focused ? '-2px' : undefined,
          },
        },
        active
          ? h('span', { key: 'mark', 'data-role': 'pinned-selected-mark', 'aria-hidden': 'true' }, '✓')
          : null,
        h('span', { key: 'label' }, label),
      );
    }

    /**
     * One workspace group of the「查看范围」tree: the interactive header row
     * (folder icon, expansion caret, label, path subtitle, session count) plus
     * its windowed session rows.
     *
     * Affordance is the point of this row (review feedback: the group header
     * looked like static text). It carries, like the left sidebar's project row:
     * a folder glyph whose state *is* the expansion state, a caret that rotates,
     * `cursor: pointer` on the whole row, a hover fill, the shell's focus ring,
     * `aria-expanded` in sync with `data-expanded`, and Enter/Space keyboard
     * toggling. Both the glyph column and the rest of the row trigger the same
     * toggle; the glyph stops propagation so one click is one toggle.
     *
     * `data-scope-group` / `data-scope-toggle` / `data-scope-more` /
     * `data-scope-parent` are distinct attribute names on purpose: each selector
     * a test or a script uses matches exactly one node per group.
     *
     * ARIA shape (g-009): the header row is a level-1 `treeitem` and the
     * windowed session rows are level-2 `treeitem`s inside the `group` that
     * follows it, so the branch reads `tree > treeitem + group > treeitem` and
     * a bare `div` never comes between the `tree` and its items. The group is a
     * *sibling* of the header, not a DOM child of it: the whole header row is
     * the toggle target, so nesting the rows inside it would make every session
     * click bubble into the toggle and would draw the focus ring around the
     * children. Its `marginTop: -1` cancels the tree's 2px gap so the header /
     * first-row distance stays the 1px gap the old wrapper had.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @param group - one derived group.
     * @param activeId - the keyboard-highlighted session id ('' when none).
     * @returns `[header, group|null]`: the group is omitted when the workspace
     *   renders no child row (shut, or nothing matched), so a collapsed node
     *   never carries an empty group.
     */
    function scopeGroupParts(t, m, a, group, activeId) {
      const hovered = m.scopeHover === `g:${group.key}`;
      const focused = m.scopeFocus === `g:${group.key}`;
      const label = group.label;
      const nodes = [
        h(
          'div',
          {
            key: `h:${group.key}`,
            role: 'treeitem',
            'aria-level': 1,
            tabIndex: 0,
            'data-role': 'group-toggle',
            'data-scope-group': group.key,
            'data-expanded': String(group.expanded),
            'data-scope-contains-current': String(group.containsCurrent),
            'data-hover': String(hovered),
            'data-focus': String(focused),
            'aria-expanded': group.expanded,
            'aria-label': fmt(t('scopeToggleAria'), { name: label }),
            onClick: () => a.toggleScope(group.key, !group.expanded),
            onKeyDown: (event) => a.onScopeHeaderKeyDown(event, group.key, !group.expanded),
            onMouseEnter: () => a.setScopeHover(`g:${group.key}`),
            onMouseLeave: () => a.setScopeHover(''),
            onFocus: (event) => {
              if (focusVisibleOf(event)) a.setScopeFocus(`g:${group.key}`);
            },
            onBlur: () => a.setScopeFocus(''),
            style: {
              ...scopeRowStyle(hovered, focused),
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              padding: '3px 6px',
              color: group.containsCurrent ? token.stateBusiness : token.labelPrimary,
              border: `1px solid ${group.containsCurrent ? token.borderL2 : 'transparent'}`,
            },
          },
          h(
            'span',
            {
              key: 'icon',
              'data-role': 'scope-folder-icon',
              'data-icon-state': group.expanded ? 'open' : 'closed',
              'data-icon-source': iconSource(),
              'data-scope-toggle': group.key,
              'aria-hidden': 'true',
              onClick: (event) => {
                // The glyph column is part of the target, not a second control:
                // stop the bubble so one click cannot toggle twice.
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                a.toggleScope(group.key, !group.expanded);
              },
              style: { display: 'inline-flex', flex: 'none', alignItems: 'center' },
            },
            scopeFolderGlyph(group.expanded, 16),
          ),
          h(
            'span',
            {
              key: 'caret',
              'data-role': 'scope-caret',
              'data-caret-open': String(group.expanded),
              'aria-hidden': 'true',
              style: { display: 'inline-flex', flex: 'none', alignItems: 'center' },
            },
            scopeCaretGlyph(group.expanded, 12),
          ),
          h(
            'span',
            {
              key: 'label',
              'data-role': 'scope-group-label',
              title: group.path || undefined,
              style: {
                fontSize: 13,
                fontWeight: 600,
                flex: 'none',
                maxWidth: '40%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            label,
          ),
          group.path
            ? h(
                'span',
                {
                  key: 'path',
                  title: group.path,
                  style: { ...metaStyle, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                },
                group.path,
              )
            : null,
          h(
            'span',
            { key: 'count', 'data-role': 'scope-group-count', style: { ...metaStyle, flex: 'none' } },
            fmt(t('scopeSessions'), { n: group.total }),
          ),
        ),
      ];

      // The workspace's children: level-2 treeitems, in a group of their own.
      const rows = [];

      for (const row of group.sessions) {
        const selected = row.id === m.sessionArg;
        const rowHovered = m.scopeHover === `s:${row.id}`;
        const rowFocused = m.scopeFocus === `s:${row.id}`;
        rows.push(
          h(
            'button',
            {
              key: `s:${row.id}`,
              type: 'button',
              role: 'treeitem',
              'aria-level': 2,
              'data-role': 'session-row',
              'data-session-id': row.id,
              'data-scope-parent': group.key,
              'data-selected': String(selected),
              'data-session-running': String(row.running === true),
              'data-session-active': String(row.id === activeId && activeId !== ''),
              'data-hover': String(rowHovered),
              'data-focus': String(rowFocused),
              'aria-selected': selected,
              onClick: () => a.pickSession(row.id),
              onMouseEnter: () => a.setScopeHover(`s:${row.id}`),
              onMouseLeave: () => a.setScopeHover(''),
              onFocus: (event) => {
                if (focusVisibleOf(event)) a.setScopeFocus(`s:${row.id}`);
              },
              onBlur: () => a.setScopeFocus(''),
              // g-061 batch 3: the row's paint is the shared session-row style —
              // and nothing else about this node moves. It stays a level-2
              // `treeitem` marked `session-row`, with its own `data-scope-parent`
              // and `data-session-running`; the flat list's row keeps being an
              // `option` marked `session-option`.
              style: sessionRowStyle({
                padding: '3px 8px 3px 20px',
                hovered: rowHovered,
                focused: rowFocused,
                selected,
                // The tree names the highlighted row by id. That is the rule now
                // — the flat list used to ask the same question by index, and the
                // rendered attribute is asserted to be value-for-value what the
                // index form produced.
                active: row.id === activeId && activeId !== '',
              }),
            },
            selected
              ? h(
                  'span',
                  {
                    key: 'mark',
                    'data-role': 'session-selected-mark',
                    title: t('scopeSelected'),
                    style: { flex: 'none', color: token.stateBusiness, fontSize: 11 },
                  },
                  '✓',
                )
              : null,

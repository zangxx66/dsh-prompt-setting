
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
            h(
              'span',
              { key: 'title', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              row.displayTitle || row.title || row.id,
            ),
            row.running === true
              ? h(
                  'span',
                  {
                    key: 'run',
                    'data-role': 'session-running',
                    title: t('scopeRunning'),
                    style: { flex: 'none', fontSize: 10, color: token.stateSuccess },
                  },
                  '●',
                )
              : null,
            row.cwd
              ? h(
                  'span',
                  {
                    key: 'cwd',
                    title: row.cwd,
                    style: {
                      ...metaStyle,
                      flex: 'none',
                      maxWidth: '45%',
                      marginLeft: 'auto',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                  },
                  row.cwd,
                )
              : null,
          ),
        );
      }

      if (group.more) {
        const moreHovered = m.scopeHover === `m:${group.key}`;
        const moreFocused = m.scopeFocus === `m:${group.key}`;
        rows.push(
          h(
            'button',
            {
              key: 'more',
              type: 'button',
              'data-action': 'scope-more',
              'data-scope-more': group.key,
              'data-hover': String(moreHovered),
              'data-focus': String(moreFocused),
              onClick: () => a.showMoreScope(group.key),
              onMouseEnter: () => a.setScopeHover(`m:${group.key}`),
              onMouseLeave: () => a.setScopeHover(''),
              onFocus: (event) => {
                if (focusVisibleOf(event)) a.setScopeFocus(`m:${group.key}`);
              },
              onBlur: () => a.setScopeFocus(''),
              style: {
                ...miniButtonStyle({
                  padding: '2px 8px 2px 20px',
                  lineHeight: '18px',
                  textAlign: 'left',
                  color: token.stateBusiness,
                  background: 'transparent',
                  border: 'none',
                }),
                // The hover fill and the focus ring come last, exactly where they
                // came before: they override the transparent fill above.
                ...scopeRowStyle(moreHovered, moreFocused),
              },
            },
            fmt(t('scopeMore'), { n: group.matched - group.sessions.length }),
          ),
        );
      } else if (group.expanded && group.hidden > 0) {
        rows.push(
          h(
            'p',
            { key: 'cut', 'data-scope-cut': group.key, style: { margin: '2px 0 2px 20px', ...metaStyle } },
            fmt(t('scopeCut'), { n: group.hidden }),
          ),
        );
      }

      // The children live in a `group` named after the workspace, so a screen
      // reader can tell the level-2 rows apart from the next workspace's.
      if (rows.length > 0) {
        nodes.push(
          h(
            'div',
            {
              key: `g:${group.key}`,
              role: 'group',
              'aria-label': label,
              style: { display: 'flex', flexDirection: 'column', gap: 1, marginTop: -1 },
            },
            rows,
          ),
        );
      }

      return nodes;
    }

    /**
     * The tree branch of the「查看范围」picker: group nodes in sidebar order,
     * each with its windowed session rows, plus the honest notices (hidden
     * archived rows, suppressed groups, the global render cap) that explain why
     * a session is not on screen.
     *
     * The branch is a real ARIA tree (g-009): the container is `role="tree"`
     * and its direct children are only `treeitem` (a workspace, level 1) or
     * `group` (that workspace's sessions, level 2). The notices below the tree
     * are siblings of the tree container, never children of it.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the tree block element.
     */
    function scopeTreeElement(t, m, a) {
      const scope = m.scope;
      const active = m.sessionActive >= 0 ? m.sessionVisible[m.sessionActive] : undefined;
      const activeId = active ? active.id : '';
      const parts = [
        h(
          'div',
          {
            key: 'tree',
            role: 'tree',
            'aria-label': t('sessionHeading'),
            'data-region': 'session-tree',
            'data-scope-groups': String(scope.groups.length),
            'data-scope-rendered': String(scope.shown),
            style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 },
          },
          scope.groups.flatMap((group) => scopeGroupParts(t, m, a, group, activeId)),
        ),
        h(
          'p',
          { key: 'hint', 'data-role': 'scope-search-hint', style: { margin: '6px 0 0', ...metaStyle } },
          t('scopeSearchHint'),
        ),
      ];
      if (scope.archivedHidden > 0) {
        parts.push(
          h(
            'p',
            { key: 'archived', 'data-warning': 'scope-archived-hidden', style: { margin: '4px 0 0', ...metaStyle } },
            fmt(t('scopeArchivedHidden'), { n: scope.archivedHidden }),
          ),
        );
      }
      if (scope.groupsSuppressed > 0) {
        parts.push(
          h(
            'p',
            { key: 'groups-cut', 'data-warning': 'scope-groups-truncated', style: { margin: '4px 0 0', ...metaStyle } },
            t('scopeGroupsTruncated'),
          ),
        );
      }
      if (scope.truncated) {
        parts.push(
          h(
            'p',
            { key: 'cut', 'data-warning': 'scope-truncated', style: { margin: '4px 0 0', ...metaStyle } },
            fmt(t('scopeTruncated'), { n: SCOPE_TOTAL_MAX }),
          ),
        );
      }
      return h('div', { key: 'scope', style: { display: 'flex', flexDirection: 'column' } }, parts);
    }

    /**
     * The session selector body: pinned entries, a live search box, and a
     * strictly bounded result area — a workspace tree when the root
     * `useWorkspaces` hook is present, the flat searchable list when it is not.
     *
     * Since g-016 this is the *body* only: {@link scopeSection} wraps it in the
     * one-line summary, and the body is rendered while that summary's「更改」
     * switch is open. Everything inside is unchanged by the collapse — the same
     * markers, the same interaction, the same bounds.
     *
     * Requirement this shape comes from: the session catalog grows monotonically
     * with use, so a control that spreads every row open becomes unusable at
     * scale (and inflates the DOM). Therefore: the two pinned entries every
     * scope needs are always rendered, the tree renders at most
     * {@link SCOPE_TOTAL_MAX} session rows (see {@link deriveScope}), the flat
     * list at most {@link SESSION_MATCH_LIMIT}, and a query that matches nothing
     * falls back to "view this id" instead of forcing a long list.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the section element.
     */
    /**
     * The readable name of the page's「查看范围」, on its own: the session's
     * readable title (or its raw id when no session service answered), or the
     * global scope's own name.
     *
     * g-055: one definition, because two places now say the same thing — the
     * summary row of the scope card and the write-target line inside「我的
     * Prompt」. The two must never drift apart, since the second exists precisely
     * to save the reader from looking back at the first.
     * @param t - the bound translator.
     * @param m - the page model.
     * @returns the scope name.
     */
    function scopeName(t, m) {
      return m.sessionArg !== null ? sessionLabelOf(m.seat.rows, m.sessionArg) || m.sessionArg : t('sessionGlobal');
    }

    /**
     * The「查看范围」card and its collapse rule (g-016).
     *
     * The picker used to be spread open above the tab bar: measured in the real
     * settings shell (1440×900) the block was ~500px tall, which pushed
     * `data-region="tabs"` to y≈789 and `data-region="tab-panel"` past the 900px
     * fold — opening the page showed no tab content at all. So the block now
     * renders **one summary line** (the readable scope name, a state hint only
     * when the picker is degraded, and the「更改」switch) and the body is
     * rendered only while `m.scopeOpen` is true.
     *
     * `data-scope-open` on the section and `aria-expanded` / `data-expanded` on
     * the switch report the same state, the way the「设置 → 模型」row and this
     * plugin's own workspace header (g-012) do. `data-region="scope-summary"`
     * is the always-present row; every body marker (`session-pinned`,
     * `session-tree`, `session-list`, the search box, the help copy) is absent
     * while it is shut.
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @param body - the picker body, rendered only while expanded.
     * @returns the section element.
     */
    function scopeSection(t, m, a, body) {
      const scoped = m.sessionArg !== null;
      const readable = scopeName(t, m);
      const summaryLabel = scoped ? fmt(t('sessionCurrentLabel'), { label: readable }) : readable;
      // A hint only when the scope itself is worth a word: the two degraded
      // seats, which change what the picker can do at all. The healthy tree
      // case says nothing extra, so the line stays short by construction.
      const isTree = m.seat.mode !== 'manual' && m.scopeMode === 'tree' && m.scope !== null;
      const hintKey = m.seat.mode === 'manual' ? 'scopeSummaryManual' : isTree ? null : 'scopeSummaryFlat';
      const parts = [
        h('h3', { key: 'heading', style: headingStyle }, t('sessionHeading')),
        h('span', { key: 'label', 'data-role': 'scope-summary-label', style: scopeSummaryTextStyle }, summaryLabel),
      ];
      if (hintKey !== null) {
        parts.push(h('span', { key: 'hint', 'data-role': 'scope-summary-hint', style: scopeSummaryHintStyle }, t(hintKey)));
      }
      parts.push(
        h(
          UI.Button,
          {
            key: 'toggle',
            variant: 'outline',
            'data-action': 'scope-toggle',
            'data-expanded': String(m.scopeOpen),
            'aria-expanded': m.scopeOpen,
            onClick: a.toggleScopeOpen,
          },
          m.scopeOpen ? t('scopeCollapse') : t('scopeEdit'),
        ),
      );
      return h(
        'section',
        { 'data-region': 'session', 'data-scope-open': String(m.scopeOpen), style: cardStyle },
        h('div', { key: 'summary', 'data-region': 'scope-summary', style: scopeSummaryStyle }, parts),
        ...(m.scopeOpen ? body : []),
      );
    }

    function renderSession(t, m, a) {
      const seat = m.seat;
      if (seat.mode === 'manual') {
        return scopeSection(t, m, a, [
          h(
            'div',
            { style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h(UI.Input, {
              'data-role': 'session-manual',
              placeholder: t('sessionManualPlaceholder'),
              value: m.manualId,
              onChange: a.setManualId,
              style: { maxWidth: 320 },
            }),
            h(UI.Button, { variant: 'outline', 'data-action': 'session-apply', onClick: a.applyManual }, t('sessionApply')),
            h(UI.Button, { variant: 'outline', 'data-action': 'session-global', onClick: a.useGlobal }, t('sessionGlobal')),
          ),
          h(
            'p',
            {
              'data-warning': 'session-degraded',
              style: { margin: '8px 0 0', fontSize: 12, color: token.stateWarn, wordBreak: 'break-word' },
            },
            t('sessionLimit'),
          ),
          seat.reason === 'hook-threw'
            ? h('p', { style: { margin: '4px 0 0', ...metaStyle } }, `${t('errDetail')}: ${seat.message}`)
            : null,
          h(
            'p',
            { 'data-session-note': m.sessionArg === null ? 'global' : 'session', style: { margin: '8px 0 0', ...metaStyle } },
            m.sessionArg === null ? t('sessionGlobalNote') : t('sessionSelectedNote'),
          ),
        ]);
      }

      const rows = seat.rows;
      const currentId = seat.currentId;
      const currentLabel = sessionLabelOf(rows, currentId);
      const isTree = m.scopeMode === 'tree' && m.scope !== null;
      const total = isTree ? m.scope.total : rows.length;
      const matched = isTree ? m.scope.matched : m.sessionMatches.length;
      const shown = isTree ? m.scope.shown : m.sessionVisible.length;
      const scoped = m.sessionArg !== null;
      const selectedLabel = scoped ? sessionLabelOf(rows, m.sessionArg) || m.sessionArg : t('sessionGlobal');

      const children = [
        // Pinned entries: always present, never filtered away, and — like the
        // group rows — visibly clickable and visibly selected.
        h(
          'div',
          { key: 'pinned', 'data-region': 'session-pinned', style: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' } },
          pinnedSessionButton(
            t,
            'global',
            t('sessionGlobal'),
            !scoped,
            false,
            m.scopeHover === 'p:global',
            m.scopeFocus === 'p:global',
            a.useGlobal,
            (on) => a.setScopeHover(on ? 'p:global' : ''),
            (on) => a.setScopeFocus(on ? 'p:global' : ''),
          ),
          pinnedSessionButton(
            t,
            'current',
            currentLabel ? fmt(t('sessionCurrentLabel'), { label: currentLabel }) : t('sessionCurrent'),
            scoped && m.sessionArg === currentId,
            currentId.length === 0,
            m.scopeHover === 'p:current',
            m.scopeFocus === 'p:current',
            a.useCurrent,
            (on) => a.setScopeHover(on ? 'p:current' : ''),
            (on) => a.setScopeFocus(on ? 'p:current' : ''),
          ),
        ),
        h(
          'div',
          { key: 'current', 'data-role': 'session-current', style: { marginTop: 8, ...metaStyle, wordBreak: 'break-word' } },
          fmt(t('sessionCurrentLabel'), { label: selectedLabel }),
        ),
        h(
          'label',
          { key: 'search', style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 420 } },
          h('span', { style: metaStyle }, t('sessionSearch')),
          h(UI.Input, {
            'data-role': 'session-search',
            value: m.sessionQuery,
            // g-047: the placeholder is copy, not a status field. 「当前选中」
            // has its own displays (the summary, the `session-current` line and
            // the pinned entry above), so the box never pretends to be one.
            placeholder: t('sessionSearch'),
            onChange: a.setSessionQuery,
            onKeyDown: a.onSessionKeyDown,
          }),
        ),
        h(
          'div',
          {
            key: 'counts',
            'data-session-shown': String(shown),
            'data-session-matched': String(matched),
            'data-session-total': String(total),
            style: { marginTop: 6, ...metaStyle },
          },
          fmt(t('sessionMatches'), { shown, matched, total }),
        ),
      ];

      if (isTree) {
        children.push(scopeTreeElement(t, m, a));
      } else {
        // g-061 batch 3: the flat list asked「is this the keyboard-highlighted
        // row」by index (`index === m.sessionActive`) while the tree asked it by
        // id. They are the same answer — the index names a row of the very list
        // being mapped — so both go through the id now. The rendered
        // `data-session-active` is asserted to be value-for-value what the index
        // form produced: at `-1`, at 0, at the last row and past the end.
        const activeRow = m.sessionActive >= 0 ? m.sessionVisible[m.sessionActive] : undefined;
        const flatActiveId = activeRow ? activeRow.id : '';
        children.push(
          h(
            'div',
            {
              key: 'list',
              role: 'listbox',
              'aria-label': t('sessionHeading'),
              'data-region': 'session-list',
              style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 },
            },
            m.sessionVisible.map((row) => {
              const selected = row.id === m.sessionArg;
              const hovered = m.scopeHover === `s:${row.id}`;
              const focused = m.scopeFocus === `s:${row.id}`;
              return h(
                'button',
                {
                  key: row.id,
                  type: 'button',
                  role: 'option',
                  'data-role': 'session-option',
                  'data-session-id': row.id,
                  'data-selected': String(selected),
                  'data-session-active': String(row.id === flatActiveId && flatActiveId !== ''),
                  'data-hover': String(hovered),
                  'data-focus': String(focused),
                  'aria-selected': selected,
                  onClick: () => a.pickSession(row.id),
                  onMouseEnter: () => a.setScopeHover(`s:${row.id}`),
                  onMouseLeave: () => a.setScopeHover(''),
                  onFocus: (event) => {
                    if (focusVisibleOf(event)) a.setScopeFocus(`s:${row.id}`);
                  },
                  onBlur: () => a.setScopeFocus(''),
                  style: sessionRowStyle({
                    padding: '4px 8px',
                    hovered,
                    focused,
                    selected,
                    active: row.id === flatActiveId && flatActiveId !== '',
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
                h('span', { key: 'label', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sessionRowLabel(row)),
              );
            }),
          ),
        );
      }

      // No match ⇒ the typed text is a session id, not a dead end.
      if (matched === 0 && m.sessionQuery.trim().length > 0) {
        children.push(
          h(
            'div',
            {
              key: 'no-match',
              'data-warning': 'session-no-match',
              style: { marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
            },
            h('span', { style: metaStyle }, t('sessionNoMatch')),
            h(
              'button',
              {
                type: 'button',
                'data-action': 'session-use-input',
                'data-session-id': m.sessionQuery.trim(),
                onClick: a.useTypedId,
                style: chipButtonStyle({
                  cursor: 'pointer',
                  color: token.labelPrimary,
                  background: 'transparent',
                  border: token.borderL2,
                }),
              },
              fmt(t('sessionUseInput'), { id: m.sessionQuery.trim() }),
            ),
          ),
        );
      }
      if (total === 0) {
        children.push(h('p', { key: 'empty', style: { margin: '6px 0 0', ...metaStyle } }, t('sessionEmpty')));
      }
      if (!isTree) {
        // The flat list is a degradation, not a silent difference: say it.
        children.push(
          h(
            'p',
            { key: 'degraded', 'data-warning': 'scope-degraded', style: { margin: '6px 0 0', ...metaStyle } },
            t('scopeDegraded'),
          ),
        );
      }
      children.push(
        h('p', { key: 'keys', style: { margin: '6px 0 0', ...metaStyle } }, t('sessionKeyboardHint')),
        h(
          'p',
          { key: 'note', 'data-session-note': scoped ? 'session' : 'global', style: { margin: '6px 0 0', ...metaStyle } },
          scoped ? t('sessionSelectedNote') : t('sessionGlobalNote'),
        ),
      );

      return scopeSection(t, m, a, children);
    }

    /**
     * g-055: the「我的 Prompt」block. Since g-071 it renders **inside** the mine
     * panel, right below that panel's own `h3`, and no longer above the tab bar.
     *
     * The「查看范围」selector is「我的 Prompt」's own state — it scopes **this
     * panel's** snapshot and override reads and it decides which layer a save
     * lands in — and it stays the *one* place that scope is changed. g-055 fixed
     * the reading (one sentence saying what the scope decides, then the card, in
     * one container) but kept the block above the tab bar; g-071 is the owner's
     * correction of that position: the block belongs to the surface it writes, so
     * it is rendered by that surface. **g-073 finished the thought**: the other
     * tabs are decoupled from this value — 「提示词总览」and「高级」have their own
     * selectors, 「我的预设」and「备份与恢复」carry no scope at all — so the page
     * states this scope in exactly one place, this block, and the other five tabs
     * render none of `data-region="session"` / `data-region="scope-summary"` /
     * `data-action="scope-toggle"`.
     *
     * The block deliberately has **no heading of its own** (review round 1): a
     * second `h3`「我的 Prompt」two lines above the panel's own title repeated the
     * same name at the same level, which both weakened the "one block" reading
     * and listed the title twice in a screen reader's heading list. The panel,
     * which owns the title, is the only place `mineHeading` is rendered; the
     * sentence below carries the binding instead. Moving the block in does **not**
     * change that: the panel's `h3` is still its first child, and the block's
     * sentence still follows it.
     *
     * The card keeps every frozen marker and its collapse rule exactly as they
     * were (`data-region="session"` / `"scope-summary"`, `data-scope-open`,
     * `data-action="scope-toggle"`); the wrapper carries `data-region="prompt-block"`
     * around it and moves nothing else.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the block element.
     */
    function renderPromptBlock(t, m, a) {
      return h(
        'section',
        { key: 'prompt-block', 'data-region': 'prompt-block', style: promptBlockStyle },
        h('p', { key: 'note', 'data-role': 'prompt-block-note', style: promptBlockNoteStyle }, t('promptBlockNote')),
        renderSession(t, m, a),
      );
    }

    /**
     * The confirmation dialog's typography: four levels instead of one uniform
     * gap — the title, the lead sentence that names the action, the sentence
     * that explains it, and a structural "cannot be undone" strip. zh and en
     * sentences both wrap inside the 480px card, so every level states its own
     * `lineHeight` instead of inheriting the shell's, and the spacing between
     * groups (not a single `gap`) is what carries the grouping.
     */
    const confirmTitleStyle = dialogTitleStyle({ fontSize: 14, tone: token.stateWarn, lineHeight: 1.4 });
    const confirmBodyStyle = { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 };
    const confirmLeadStyle = {
      fontSize: 13,
      fontWeight: 500,
      lineHeight: 1.6,
      color: token.labelPrimary,
      wordBreak: 'break-word',
    };
    const confirmTextStyle = {
      fontSize: 13,
      lineHeight: 1.6,
      color: token.labelSecondary,
      wordBreak: 'break-word',
    };
    const confirmIrreversibleStyle = {
      marginTop: 12,
      paddingLeft: 10,
      borderLeft: `3px solid ${token.stateError}`,
      fontSize: 12,
      lineHeight: 1.5,
      color: token.stateError,
    };
    const confirmActionsStyle = dialogActionsStyle({ divider: true });

    /**
     * Render the pending second confirmation. Every destructive action of this
     * page goes through here: the impact and the irreversibility are stated
     * before the click that performs it, never after.
     *
     * Four kinds remain, and they are exactly the four writes (or write-like
     * actions) the page can still start: `mine-reset` (drop 「我的 Prompt」 from
     * one layer), `legacy-clear` (`legacy=true`), `reset-layer` (`reset=true`)
     * and `import`. The Revision 6 `reset-section` kind is gone with the
     * generic per-name write it confirmed.
     *
     * It renders as a viewport-anchored modal (`data-region="confirm-overlay"`,
     * `position: fixed` + centered), not as an inline card in the page flow. The
     * trigger lives anywhere on a long panel — 「恢复默认」 sits at the bottom of
     * 「我的 Prompt」 — so an inline card appeared *above* the trigger (off-screen
     * on a scrolled page, which reads as "nothing happened") and pushed the
     * panel down as it appeared. The overlay is a backdrop only: it closes
     * nothing by itself, so the only ways out are the two buttons.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the overlay element, or null when nothing is pending.
     */
    function renderConfirm(t, m, a) {
      const confirm = m.confirm;
      if (confirm === null) return null;
      const body = [];
      if (confirm.kind === 'mine-reset') {
        body.push(fmt(t('mineResetTitle'), { layer: layerLabel(t, confirm.layer) }));
        body.push(t('mineResetBody'));
      } else if (confirm.kind === 'legacy-clear') {
        body.push(fmt(t('resetLegacyTitle'), { layer: layerLabel(t, confirm.layer) }));
        body.push(
          confirm.count === 0
            ? fmt(t('resetLegacyEmpty'), { layer: layerLabel(t, confirm.layer) })
            : fmt(t('resetLegacyBody'), { layer: layerLabel(t, confirm.layer), count: confirm.count }),
        );
      } else if (confirm.kind === 'reset-layer') {
        body.push(fmt(t('resetLayerTitle'), { layer: layerLabel(t, confirm.layer) }));
        body.push(
          confirm.count === 0
            ? fmt(t('resetLayerEmpty'), { layer: layerLabel(t, confirm.layer) })
            : fmt(t('resetLayerBody'), { layer: layerLabel(t, confirm.layer), count: confirm.count }),
        );
      } else if (confirm.kind === 'update-apply') {
        // g-032: the「立即更新」confirmation. It states the version, who installs
        // it and — the part a user must not discover afterwards — that the page
        // will **not** restart anything; the last restart is theirs to do.
        // g-036: *how* to do it depends on how the host was started, so the
        // sentence is selected by the launch shape the ping reported.
        body.push(fmt(t('updateApplyTitle'), { latest: confirm.latest ?? '' }));
        body.push(fmt(t('updateApplyBody'), { latest: confirm.latest ?? '' }));
        body.push(t(updateApplyCopyKey('restartNote', modelLaunchKind(m))));
      } else if (confirm.kind === 'preset-delete') {
        // g-060 review R4: deleting a preset is a catalogue write with a visible
        // consequence, so it asks first, through the same overlay every other
        // destructive act on this page uses (g-031's rule: one confirmation
        // surface, one layout, one pair of buttons).
        //
        // Revision 50 (g-069): the consequence is now「every workspace that had it
        // applied is restored」, so the body says exactly that and names them —
        // the count and the labels are what the reader is being asked to agree
        // to. A preset nothing applied keeps the plain sentence: there is no
        // restore to warn about, and inventing one would be false.
        body.push(fmt(t('presetDeleteConfirmTitle'), { name: confirm.name ?? '' }));
        const restorable = Array.isArray(confirm.workspaces) ? confirm.workspaces : [];
        if (restorable.length === 0) {
          body.push(t('presetDeleteConfirmBody'));
        } else {
          body.push(fmt(t('presetDeleteConfirmApplied'), { count: restorable.length }));
          body.push(
            h(
              'div',
              {
                'data-role': 'confirm-preset-workspaces',
                'data-preset-workspace-count': String(restorable.length),
                style: confirmTextStyle,
              },
              fmt(t('presetDeleteAppliedList'), { list: restorable.map((entry) => entry.label).join(', ') }),
            ),
          );
        }
      } else if (confirm.kind === 'preset-discard') {
        // …and closing a dirty editor throws typing away, which is the other act
        // this page never performs silently (review R3's promise, now asked for
        // explicitly rather than merely labelled).
        body.push(t('presetDiscardConfirmTitle'));
        body.push(t('presetDiscardConfirmBody'));
      } else if (confirm.kind === 'rollback') {
        // g-039: the version-history tab's only write. The body names the
        // version it will apply, states the scope the write face allows (the
        // reserved section and nothing else), and the shared
        // `resetIrreversible` line below carries the warning — a rollback is
        // itself logged, but the write it replaced is restored by nothing except
        // another rollback.
        const layerName = layerLabel(t, confirm.layer);
        body.push(fmt(t('histRollbackTitle'), { layer: layerName, id: confirm.id }));
        body.push(fmt(t('histRollbackBody'), { layer: layerName, id: confirm.id }));
        body.push(t('histRollbackScope'));
        if (confirm.foreign > 0) body.push(fmt(t('histRollbackForeign'), { n: confirm.foreign }));
      } else {
        body.push(t('importConfirmTitle'));
        body.push(fmt(t('importConfirmBody'), { mode: t(m.importMode === 'replace' ? 'importModeReplace' : 'importModeMerge') }));
      }
      return h(
        'div',
        {
          key: 'confirm-overlay',
          'data-region': 'confirm-overlay',
          // The confirmation is the **last** interaction — it is raised on top
          // of whatever dialog asked the question — so it states its own layer:
          // 1200, strictly above every tab-owned overlay (1000: this page's
          // `regionDialog`, the history comparison modal, and the two preset
          // dialogs). Since g-061 the backdrop itself is the shared
          // `scrimStyle`, and this call site is the one that passes 1200 — the
          // number is asserted where it is decided, never inherited from a
          // default that could quietly become 1000 again.
          style: scrimStyle(1200),
        },
        h(
          'div',
          {
            'data-region': 'confirm',
            'data-confirm-kind': confirm.kind,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('confirmTitle'),
            style: {
              ...dialogCardStyle({
                width: '100%',
                maxWidth: 480,
                maxHeight: '80vh',
                overflow: 'overflowY',
              }),
              // The confirmation wears the warning stroke, and the shell states
              // the surface one, so the warning is declared after the factory —
              // the later declaration is the one that wins. Everything else this
              // card used to spell out is now the factory's, at the values it
              // has always had.
              borderColor: token.stateWarn,
            },
          },
          h('strong', { style: confirmTitleStyle }, t('confirmTitle')),
          h(
            'div',
            { 'data-role': 'confirm-body', style: confirmBodyStyle },
            body.map((line, index) =>
              h('div', { key: `line-${index}`, style: index === 0 ? confirmLeadStyle : confirmTextStyle }, line),
            ),
          ),
          h('div', { 'data-role': 'confirm-irreversible', style: confirmIrreversibleStyle }, t('resetIrreversible')),
          h(
            'div',
            { 'data-role': 'confirm-actions', style: confirmActionsStyle },
            h(UI.Button, { variant: 'primary', 'data-action': 'confirm-yes', disabled: m.busy, onClick: a.confirmYes }, t('confirmYes')),
            h(UI.Button, { 'data-action': 'confirm-no', disabled: m.busy, onClick: a.cancelConfirm }, t('confirmNo')),
          ),
        ),
      );
    }

    /**
     * 「我的 Prompt」 — the page's only write surface.
     *
     * The layer selector reuses the `user` / `workspace` semantics the whole
     * page already has (`deriveScope` / `scopeMode`): the workspace layer needs
     * a session, and the page says so instead of letting the write fail with
     * `workspace-unresolved`. The text box is bound to the reserved section's
     * stored value for that layer, read from **that layer's own** override list
     * — `merged` deduplicates by name across layers, so it names at most one of
     * them per section and cannot answer "what did *this* layer store" (g-054) —
     * so what is shown is what that layer stored, not what the last render
     * happened to hold. The merged list still describes the assembly.
     *
     * Two states are stated rather than implied. `data-mine-state` is the
     * machine-readable one (`unconfigured` / `dirty` / `saving` / `saved` /
     * `error`), and a frozen or discarded scope renders
     * `data-warning="mine-frozen"` — §15.4 requires the panel to say that the
     * text will not reach the prompt rather than let a write look effective.
     *
     * g-055: the panel is the lower half of the「我的 Prompt」block whose header
     * is the scope card — at the top of **this panel** since g-071 moved it in
     * from above the tab bar — so it names its own write target
     * (`data-region="mine-target"`, read-only) instead of making the reader look
     * back up; the scope itself is still changed in exactly one place.
     *
     * @param t - the bound translator.
     * @param m - the page model.
     * @param a - the page actions.
     * @returns the panel element.
     */
    // #region g-062 (Revision 46) — the shell-overlay toaster

    /**
     * The assembly layer's verdict, in words (g-062's first layer).
     *
     * Shared by the settings-page block and the toast on purpose: one fact, one

// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。
    /**
     * g-097: the read-only prompt-injection inspector — one button in
     * `conversation.input.left` (order 10, right of the meme picker's 5) and the
     * panel it opens in `shell.overlay` (the frame's own layer, outside the composer).
     * Read-only (the bar's same
     * three GETs); no Session ⇒ zero requests; one row per `effective.sections`
     * (index:null included, characters = text.length); three close paths that
     * return focus to the composer; no listener/style survives unmount.
     */
    const PROMPT_INSPECTOR_BUTTON_ORDER = 10;
    const PROMPT_INSPECTOR_BUTTON_SLOT = 'conversation.input.left';
    const PROMPT_INSPECTOR_PANEL_SLOT = 'shell.overlay';
    const PROMPT_INSPECTOR_BUTTON_ID = 'prompt-setting-prompt-inspector';
    const PROMPT_INSPECTOR_PANEL_ID = 'prompt-setting-prompt-inspector-panel';
    const PROMPT_INSPECTOR_REGION = 'composer-prompt-inspector';
    const PROMPT_INSPECTOR_LAYERS = Object.freeze(['user', 'workspace']);
    /** Drag gate: a pointer move shorter than this is a click, not a drag. */
    const PROMPT_INSPECTOR_DRAG_THRESHOLD = 3;
    /** The minimum margin a dragged panel keeps from every viewport edge. */
    const PROMPT_INSPECTOR_DRAG_MARGIN = 8;
    /** Inline styles only: nothing is injected into the document, so unmount is total. */
    const PROMPT_INSPECTOR_STYLE = Object.freeze({
      line: { margin: 0, fontSize: 12, lineHeight: '18px', color: token.labelSecondary, wordBreak: 'break-word' },
      heading: { margin: 0, fontSize: 12, fontWeight: 600, color: token.labelPrimary },
      block: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      list: { display: 'flex', flexDirection: 'column', gap: 0, margin: 0, padding: 0, listStyle: 'none', border: `1px solid ${token.borderL2}`, borderRadius: 8, overflow: 'hidden' },
      row: { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 8px', borderBottom: `1px solid ${token.borderL2}` },
      rowTop: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
      rowMeta: { display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11, lineHeight: '16px', color: token.labelSecondary },
      panel: { position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: 2147483001, pointerEvents: 'auto', width: 'min(640px, calc(100vw - 32px))', maxHeight: 'min(70vh, 640px)', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', background: token.surface, color: token.labelPrimary, border: `1px solid ${token.surfaceStroke}`, borderRadius: 12, boxShadow: '0 12px 40px rgba(0, 0, 0, 0.18)', font: 'inherit', fontSize: 12, lineHeight: '18px', overflow: 'hidden' },
      scrim: { position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, zIndex: 2147483000, pointerEvents: 'auto', background: 'rgba(0, 0, 0, 0.12)' },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${token.borderL2}`, cursor: 'move', touchAction: 'none' },
      close: { flex: 'none', width: 24, height: 24, padding: 0, border: 'none', borderRadius: 6, background: 'transparent', color: token.labelSecondary, cursor: 'pointer', font: 'inherit', fontSize: 16, lineHeight: '24px' },
      body: { display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px 12px', overflowY: 'auto', minHeight: 0 },
      button: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, flex: 'none', padding: 0, border: 'none', borderRadius: 8, background: 'transparent', cursor: 'pointer', font: 'inherit' },
      pre: { margin: 0, padding: '6px 8px', fontSize: 11, lineHeight: '16px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflowY: 'auto', color: token.labelSecondary, borderTop: `1px solid ${token.borderL2}` },
    });

    /** The one seat the two entries share. `revision` is the store snapshot. */
    const promptInspectorSeat = { open: false, sessionId: '', returnFocus: null, dragCenter: null, dragState: null, revision: 0, listeners: new Set() };

    /** Subscribe to the seat; the returned unsubscribe is what unmount calls. */
    function promptInspectorSubscribe(listener) {
      promptInspectorSeat.listeners.add(listener);
      return () => {
        promptInspectorSeat.listeners.delete(listener);
      };
    }

    /** Bump the revision and notify every listener; one broken subscriber must not stop the rest. */
    function promptInspectorNotify() {
      promptInspectorSeat.revision += 1;
      for (const listener of [...promptInspectorSeat.listeners]) {
        try {
          listener();
        } catch {
          // One broken subscriber must not break the others.
        }
      }
    }

    /** Open the panel for one Session, remembering where focus came from. */
    function promptInspectorOpen(options) {
      const source = options !== null && typeof options === 'object' ? options : {};
      promptInspectorSeat.open = true;
      promptInspectorSeat.sessionId = typeof source.sessionId === 'string' ? source.sessionId : '';
      promptInspectorSeat.returnFocus = source.returnFocus === undefined ? null : source.returnFocus;
      // Reopening always starts centered again — a predictable position beats a
      // remembered one that may no longer be on screen. A drag left over from a
      // panel closed mid-drag must not keep moving the new one.
      promptInspectorSeat.dragCenter = null;
      promptInspectorSeat.dragState = null;
      promptInspectorNotify();
    }

    /** Close the panel without touching focus (the dismiss path adds it). */
    function promptInspectorClose() {
      if (promptInspectorSeat.open === false) return;
      promptInspectorSeat.open = false;
      promptInspectorSeat.sessionId = '';
      promptInspectorNotify();
    }

    /** Return focus to the composer editor; the recorded element is the last resort. */
    function promptInspectorFocusInput(documentLike, fallback) {
      const root =
        documentLike !== null && documentLike !== undefined && typeof documentLike.querySelector === 'function'
          ? documentLike
          : null;
      if (root !== null) {
        for (const selector of [
          '[data-composer-card] [contenteditable="true"]',
          '[data-composer-card] textarea',
          '[contenteditable="true"]',
          'textarea',
        ]) {
          let element = null;
          try {
            element = root.querySelector(selector);
          } catch {
            element = null;
          }
          if (element !== null && element !== undefined && typeof element.focus === 'function') {
            try {
              element.focus();
              return true;
            } catch {
              // Next selector.
            }
          }
        }
      }
      if (fallback !== null && fallback !== undefined && typeof fallback.focus === 'function') {
        try {
          fallback.focus();
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }

    /** The one dismiss path: close, then return focus to the composer. */
    function promptInspectorDismiss(props) {
      const fallback = promptInspectorSeat.returnFocus;
      promptInspectorSeat.returnFocus = null;
      // A dismiss can land in the middle of a drag (Escape). Drop the drag state
      // and restore the document styles here, or the document root keeps `user-select:none`
      // until the next completed drag.
      promptInspectorSeat.dragState = null;
      promptInspectorSetDragStyles(props, false);
      promptInspectorClose();
      return promptInspectorFocusInput(composerBarDocumentOf(props), fallback);
    }

    /** The Session seat (`InputZone.session` / the inject face); anything else is "no Session". */
    function promptInspectorSessionIdOf(props) {
      if (props === null || props === undefined) return '';
      const snapshot = props.session;
      const fromSnapshot = snapshot !== null && typeof snapshot === 'object' ? snapshot.sessionId : undefined;
      if (typeof fromSnapshot === 'string' && fromSnapshot.length > 0) return fromSnapshot;
      for (const candidate of [props.inspectorSessionId, props.sessionId]) {
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
      }
      return '';
    }

    /** Project `effective.sections` into rows: payload order, nothing filtered, `text.length`. */
    function promptInspectorSectionRows(payload) {
      const effective = payload !== null && typeof payload === 'object' ? payload.effective : null;
      const sections =
        effective !== null && typeof effective === 'object' && Array.isArray(effective.sections)
          ? effective.sections
          : [];
      return sections.map((section, position) => {
        const row = section !== null && typeof section === 'object' ? section : {};
        const text = typeof row.text === 'string' ? row.text : '';
        return {
          key: `${position}:${typeof row.name === 'string' ? row.name : ''}`,
          name: typeof row.name === 'string' ? row.name : '',
          index: Number.isInteger(row.index) ? row.index : null,
          chars: text.length,
          text,
          origin: typeof row.origin === 'string' ? row.origin : '',
          overrideLayer: typeof row.overrideLayer === 'string' ? row.overrideLayer : null,
          action: typeof row.action === 'string' ? row.action : null,
          applied: row.applied === true,
          reason: typeof row.reason === 'string' ? row.reason : '',
        };
      });
    }

    /** The two totals: section count and the sum of `text.length`. */
    function promptInspectorTotals(rows) {
      const list = Array.isArray(rows) ? rows : [];
      let chars = 0;
      for (const row of list) {
        if (row !== null && typeof row === 'object' && typeof row.chars === 'number' && Number.isFinite(row.chars)) {
          chars += row.chars;
        }
      }
      return { sections: list.length, chars };
    }

    /** The key node's two verdicts, or the state the panel must print instead. */
    function promptInspectorAssemblyFactOf(payload) {
      if (payload === null || typeof payload !== 'object') return { kind: 'error' };
      const notice = composerBarNoticeOf(payload);
      return notice === null ? { kind: 'none' } : { kind: 'notice', notice };
    }

    /** The frozen fact, straight from the snapshot's own flags. */
    function promptInspectorFrozenFactOf(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object' || snapshot.frozen !== true) return null;
      return {
        section: typeof snapshot.frozenSection === 'string' ? snapshot.frozenSection : '',
        reason: typeof snapshot.frozenReason === 'string' ? snapshot.frozenReason : '',
      };
    }

    /**
     * A dragged panel's center, clamped so its full box stays inside the
     * viewport (with `margin` on every side). Pure — the geometry is asserted
     * without a DOM. A box larger than the viewport is centered on that axis.
     */
    function promptInspectorClampCenter(center, viewport, size, margin) {
      const view = viewport !== null && typeof viewport === 'object' ? viewport : {};
      const box = size !== null && typeof size === 'object' ? size : {};
      const width = Number.isFinite(view.width) ? view.width : 0;
      const height = Number.isFinite(view.height) ? view.height : 0;
      const boxWidth = Number.isFinite(box.width) ? box.width : 0;
      const boxHeight = Number.isFinite(box.height) ? box.height : 0;
      const gap = Number.isFinite(margin) && margin >= 0 ? margin : 0;
      const points = center !== null && typeof center === 'object' ? center : {};
      const axis = (value, extent, boxExtent) => {
        const low = gap + boxExtent / 2;
        const high = extent - gap - boxExtent / 2;
        const target = Number.isFinite(value) ? value : extent / 2;
        if (!(low <= high)) return (low + high) / 2;
        return Math.min(high, Math.max(low, target));
      };
      return {
        x: axis(points.x, width, boxWidth),
        y: axis(points.y, height, boxHeight),
      };
    }

    /** One pointer move as a drag step: `{moved, x, y}` in center coordinates. */
    function promptInspectorDragCenter(origin, start, event, threshold) {
      const base = origin !== null && typeof origin === 'object' ? origin : {};
      const from = start !== null && typeof start === 'object' ? start : {};
      const source = event !== null && typeof event === 'object' ? event : {};
      const dx = (Number.isFinite(source.clientX) ? source.clientX : 0) - (Number.isFinite(from.x) ? from.x : 0);
      const dy = (Number.isFinite(source.clientY) ? source.clientY : 0) - (Number.isFinite(from.y) ? from.y : 0);
      const gate = Number.isFinite(threshold) && threshold > 0 ? threshold : 3;
      return {
        moved: Math.abs(dx) >= gate || Math.abs(dy) >= gate,
        x: (Number.isFinite(base.x) ? base.x : 0) + dx,
        y: (Number.isFinite(base.y) ? base.y : 0) + dy,
      };
    }

    /** The injection instant: `record.notice.at` first, then `record.lastAssembly.at`. */
    function promptInspectorTimestampOf(payload) {
      const record = payload !== null && typeof payload === 'object' && payload.record !== null && typeof payload.record === 'object'
        ? payload.record
        : null;
      if (record !== null) {
        const notice = record.notice !== null && typeof record.notice === 'object' ? record.notice : null;
        if (notice !== null && Number.isFinite(notice.at) && notice.at > 0) return { source: 'notice', at: notice.at };
        const last = record.lastAssembly !== null && typeof record.lastAssembly === 'object' ? record.lastAssembly : null;
        if (last !== null && Number.isFinite(last.at) && last.at > 0) return { source: 'lastAssembly', at: last.at };
      }
      return { source: 'none', at: null };
    }

    /** One millisecond timestamp in the reader's zone — the page's own `stampOf`. */
    function promptInspectorStampOf(at) {
      if (!Number.isFinite(at) || at <= 0) return '';
      let iso = null;
      try {
        iso = new Date(at).toISOString();
      } catch {
        return '';
      }
      const stamp = stampOf(iso);
      return typeof stamp === 'string' ? stamp : '';
    }

    /** The window a drag resizes against (injectable for tests). */
    function promptInspectorWindowOf(props) {
      const explicit = props !== null && props !== undefined ? props.window : undefined;
      if (explicit !== null && explicit !== undefined && typeof explicit === 'object') return explicit;
      return composerBarGlobalWindow();
    }

    /** The drag-time `user-select:none` + `cursor:move` on the root element, restored on release. */
    const promptInspectorDragStyleState = { active: false, userSelect: null, cursor: null };
    function promptInspectorSetDragStyles(props, active) {
      const doc = composerBarDocumentOf(props);
      const root = doc !== null && doc !== undefined ? doc.documentElement : null;
      const style = root !== null && root !== undefined ? root.style : null;
      if (style === null || style === undefined) return;
      if (active === true) {
        if (promptInspectorDragStyleState.active === true) return;
        promptInspectorDragStyleState.active = true;
        promptInspectorDragStyleState.userSelect = style.userSelect;
        promptInspectorDragStyleState.cursor = style.cursor;
        style.userSelect = 'none';
        style.cursor = 'move';
        return;
      }
      if (promptInspectorDragStyleState.active !== true) return;
      promptInspectorDragStyleState.active = false;
      style.userSelect = promptInspectorDragStyleState.userSelect;
      style.cursor = promptInspectorDragStyleState.cursor;
      promptInspectorDragStyleState.userSelect = null;
      promptInspectorDragStyleState.cursor = null;
    }

    /** Failed snapshot ⇒ `error`; failed overrides/assembly keeps the list, degrades one block. */
    function promptInspectorReadOf(results) {
      const source = results !== null && typeof results === 'object' ? results : {};
      const payloadOf = (result) =>
        result !== null && typeof result === 'object' && result.ok === true ? result.payload : null;
      const failureOf = (result) =>
        result !== null && typeof result === 'object' && result.ok !== true && result.error ? result.error : null;
      const snapshot = payloadOf(source.snapshot);
      const overrides = payloadOf(source.overrides);
      const assembly = payloadOf(source.assembly);
      const error = failureOf(source.snapshot) || failureOf(source.overrides) || failureOf(source.assembly);
      if (snapshot === null) return { phase: 'error', snapshot: null, overrides, assembly, error };
      return { phase: 'ready', snapshot, overrides, assembly, error };
    }

    /**
     * The panel's one read path: opened ⇒ three serial GETs, no Session ⇒ zero
     * transport calls, closed ⇒ `idle`. The latest round wins (stale answers are
     * dropped before they can issue the remaining requests).
     */
    function usePromptInspectorRead(options) {
      const source = options !== null && typeof options === 'object' ? options : {};
      const open = source.open === true;
      const sessionId = typeof source.sessionId === 'string' ? source.sessionId : '';
      const [read, setRead] = React.useState({
        phase: 'idle',
        snapshot: null,
        overrides: null,
        assembly: null,
        error: null,
      });
      const [nonce, setNonce] = React.useState(0);
      const bookRef = React.useRef(null);
      if (bookRef.current === null) bookRef.current = { round: 0 };
      const book = bookRef.current;
      const refresh = () => setNonce((value) => value + 1);
      React.useEffect(() => {
        const reset = (phase) => {
          book.round += 1;
          setRead({ phase, snapshot: null, overrides: null, assembly: null, error: null });
        };
        if (!open) {
          reset('idle');
          return undefined;
        }
        const urls = composerBarRequestUrls(sessionId);
        if (urls === null) {
          reset('no-session');
          return undefined;
        }
        let cancelled = false;
        book.round += 1;
        const round = book.round;
        setRead({ phase: 'loading', snapshot: null, overrides: null, assembly: null, error: null });
        const load = async () => {
          const snapshot = await requestJson(urls.snapshot);
          if (cancelled || book.round !== round) return;
          const overrides = await requestJson(urls.overrides);
          if (cancelled || book.round !== round) return;
          const assembly = await requestJson(urls.assembly);
          if (cancelled || book.round !== round) return;
          setRead(promptInspectorReadOf({ snapshot, overrides, assembly }));
        };
        load();
        return () => {
          cancelled = true;
        };
      }, [open, sessionId, nonce]);
      return { read, refresh };
    }

    /**
     * The toolbar button: one square icon in the Host's tool row. `onMouseDown`
     * is prevented so the click never steals focus from the composer; the
     * dismiss path returns focus explicitly.
     */
    function ComposerPromptInspectorButton(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      React.useSyncExternalStore(promptInspectorSubscribe, () => promptInspectorSeat.revision, () => promptInspectorSeat.revision);
      const open = promptInspectorSeat.open === true;
      const sessionId = promptInspectorSessionIdOf(props);
      const toggle = (event) => {
        if (event !== null && typeof event.preventDefault === 'function') event.preventDefault();
        if (event !== null && typeof event.stopPropagation === 'function') event.stopPropagation();
        if (open) {
          promptInspectorDismiss(props);
          return;
        }
        const doc = composerBarDocumentOf(props);
        const returnFocus = doc !== null && doc !== undefined && doc.activeElement !== undefined ? doc.activeElement : null;
        promptInspectorOpen({ sessionId, returnFocus });
      };
      return h(
        'button',
        {
          type: 'button',
          'data-plugin': 'dsh-prompt-setting',
          'data-region': 'composer-prompt-inspector-button',
          'data-action': 'prompt-inspector-toggle',
          'data-inspector-open': open ? 'true' : 'false',
          'data-inspector-session': sessionId,
          'aria-label': t('barAssemblyLabel'),
          'aria-expanded': open ? 'true' : 'false',
          'aria-haspopup': 'dialog',
          title: t('barAssemblyLabel'),
          onClick: toggle,
          onMouseDown: (event) => {
            if (event !== null && typeof event.preventDefault === 'function') event.preventDefault();
          },
          style: { ...PROMPT_INSPECTOR_STYLE.button, color: open ? token.stateBusiness : token.labelSecondary },
        },
        composerBarIconOf('sections', 'currentColor'),
      );
    }

    /**
     * The panel: scrim + dialog, four read-only blocks, three close paths. Hooks
     * run before the `open` early return; every visible fact carries a `data-*`
     * marker, so a probe reads attributes instead of text.
     */
    function ComposerPromptInspectorPanel(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      React.useSyncExternalStore(promptInspectorSubscribe, () => promptInspectorSeat.revision, () => promptInspectorSeat.revision);
      const open = promptInspectorSeat.open === true;
      const sessionId = promptInspectorSessionIdOf(props) || promptInspectorSeat.sessionId;
      // Per-row expansion, independent per row; a fresh Set per toggle so the
      // snapshot identity changes (React's state contract).
      const [expanded, setExpanded] = React.useState(() => new Set());
      const panelRef = React.useRef(null);
      const live = usePromptInspectorRead({ open, sessionId });
      const read = live.read;
      React.useEffect(() => {
        if (!open) return undefined;
        const doc = composerBarDocumentOf(props);
        if (doc === null || doc === undefined || typeof doc.addEventListener !== 'function') return undefined;
        const onKeyDown = (event) => {
          if (event !== null && event !== undefined && (event.key === 'Escape' || event.key === 'Esc')) {
            promptInspectorDismiss(props);
          }
        };
        doc.addEventListener('keydown', onKeyDown);
        return () => {
          try {
            doc.removeEventListener('keydown', onKeyDown);
          } catch {
            // A dead document is already gone; the listener dies with it.
          }
        };
      }, [open]);
      // A resized window must not leave the panel outside the viewport.
      React.useEffect(() => {
        if (!open) return undefined;
        const win = promptInspectorWindowOf(props);
        if (win === null || win === undefined || typeof win.addEventListener !== 'function') return undefined;
        const onResize = () => {
          if (promptInspectorSeat.dragCenter === null) return;
          const doc = composerBarDocumentOf(props);
          if (doc === null || doc === undefined) return;
          promptInspectorSeat.dragCenter = promptInspectorClampCenter(
            promptInspectorSeat.dragCenter,
            viewportOf(),
            panelSizeOf(),
            PROMPT_INSPECTOR_DRAG_MARGIN,
          );
          promptInspectorNotify();
        };
        win.addEventListener('resize', onResize);
        return () => {
          try {
            win.removeEventListener('resize', onResize);
          } catch {
            // A dead window is already gone.
          }
        };
      }, [open]);
      // A drag that outlives the panel must not leave the document root unselectable.
      React.useEffect(() => () => {
        promptInspectorSeat.dragState = null;
        promptInspectorSetDragStyles(props, false);
      }, []);
      if (!open) return null;
      const dismiss = (event) => {
        if (event !== null && typeof event.preventDefault === 'function') event.preventDefault();
        if (event !== null && typeof event.stopPropagation === 'function') event.stopPropagation();
        promptInspectorDismiss(props);
      };
      const toggleRow = (key) => {
        setExpanded((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      };
      const isExpanded = (key) => expanded !== null && typeof expanded.has === 'function' && expanded.has(key);
      const viewportOf = () => {
        const win = promptInspectorWindowOf(props);
        return {
          width: win !== null && win !== undefined && Number.isFinite(win.innerWidth) ? win.innerWidth : 0,
          height: win !== null && win !== undefined && Number.isFinite(win.innerHeight) ? win.innerHeight : 0,
        };
      };
      const panelSizeOf = () => {
        const node = panelRef.current;
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return { width: 0, height: 0 };
        try {
          const rect = node.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        } catch {
          return { width: 0, height: 0 };
        }
      };
      const clampCenter = (center) =>
        promptInspectorClampCenter(center, viewportOf(), panelSizeOf(), PROMPT_INSPECTOR_DRAG_MARGIN);
      const beginDrag = (event) => {
        if (event === null || event === undefined) return;
        if (typeof event.button === 'number' && event.button !== 0) return;
        const target = event.target;
        // The close button (and any other `data-action` control) keeps its click.
        if (target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('[data-action]') !== null) return;
        const origin = clampCenter(promptInspectorSeat.dragCenter);
        promptInspectorSeat.dragState = {
          start: { x: Number.isFinite(event.clientX) ? event.clientX : 0, y: Number.isFinite(event.clientY) ? event.clientY : 0 },
          origin,
          pointerId: event.pointerId,
          moved: false,
        };
        const handle = event.currentTarget;
        if (handle !== null && handle !== undefined && typeof handle.setPointerCapture === 'function' && event.pointerId !== undefined) {
          try {
            handle.setPointerCapture(event.pointerId);
          } catch {
            // A detached handle keeps the drag working without capture.
          }
        }
      };
      const moveDrag = (event) => {
        const drag = promptInspectorSeat.dragState;
        if (drag === null || drag === undefined || event === null || event === undefined) return;
        const next = promptInspectorDragCenter(drag.origin, drag.start, event, PROMPT_INSPECTOR_DRAG_THRESHOLD);
        if (next.moved === false) return;
        if (drag.moved === false) {
          drag.moved = true;
          promptInspectorSetDragStyles(props, true);
        }
        if (typeof event.preventDefault === 'function') event.preventDefault();
        promptInspectorSeat.dragCenter = clampCenter(next);
        promptInspectorNotify();
      };
      const endDrag = (event) => {
        const drag = promptInspectorSeat.dragState;
        promptInspectorSeat.dragState = null;
        if (drag === null || drag === undefined) return;
        promptInspectorSetDragStyles(props, false);
        const handle = event !== null && event !== undefined ? event.currentTarget : null;
        if (handle !== null && handle !== undefined && typeof handle.releasePointerCapture === 'function' && drag.pointerId !== undefined) {
          try {
            handle.releasePointerCapture(drag.pointerId);
          } catch {
            // Already released.
          }
        }
      };
      const dragCenter = promptInspectorSeat.dragCenter;
      const panelStyle = dragCenter === null
        ? PROMPT_INSPECTOR_STYLE.panel
        : { ...PROMPT_INSPECTOR_STYLE.panel, left: `${dragCenter.x}px`, top: `${dragCenter.y}px` };
      const phase = read.phase;
      const rows = phase === 'ready' ? promptInspectorSectionRows(read.snapshot) : [];
      const totals = promptInspectorTotals(rows);
      const layers = phase === 'ready'
        ? {
            user: composerBarLayerFact('user', read.snapshot, read.overrides),
            workspace: composerBarLayerFact('workspace', read.snapshot, read.overrides),
          }
        : null;
      const assembly = phase === 'ready' ? promptInspectorAssemblyFactOf(read.assembly) : { kind: 'loading' };
      const frozen = phase === 'ready' ? promptInspectorFrozenFactOf(read.snapshot) : null;
      const stampFact = phase === 'ready' ? promptInspectorTimestampOf(read.assembly) : { source: 'none', at: null };
      // "No observation record" and "the assembly-status read failed" are not the
      // same fact: only a *successful* payload with no record prints「（无）」.
      const stampText =
        stampFact.source === 'none'
          ? read.assembly === null
            ? t('loadFailed')
            : t('stNone')
          : promptInspectorStampOf(stampFact.at) || t('stNone');
      const summaryText =
        phase === 'ready'
          ? `${t('viewSections')}${t('assemblyLayerSep')}${totals.sections} · ${fmt(t('colChars'), { n: String(totals.chars) })}`
          : phase === 'no-session'
            ? t('barNoSession')
            : phase === 'error'
              ? `${t('loadFailed')}${read.error === null ? '' : ` — ${errorText(t, read.error)}`}`
              : t('loading');
      const assemblyText =
        assembly.kind === 'loading'
          ? t('loading')
          : assembly.kind === 'error'
            ? t('loadFailed')
            : assembly.kind === 'none'
              ? t('mineStatusNoRecord')
              : `${t('assemblyLayerAssembly')}${t('assemblyLayerSep')}${assemblyVerdictOf(t, assembly.notice)} · `
                + `${t('assemblyLayerDelivery')}${t('assemblyLayerSep')}${deliveryVerdictOf(t, assembly.notice)}`;
      const layerRow = (layer) => {
        const fact = layers === null ? { kind: 'loading', total: 0, ineffective: 0 } : layers[layer];
        const value =
          fact.kind === 'error'
            ? t('loadFailed')
            : fact.kind === 'disabled'
              ? t('stDisabled')
              : fact.kind === 'none'
                ? t('stNone')
                : fmt(t('mineStatusCoverage'), {
                    total: String(fact.total),
                    ineffective: String(fact.ineffective),
                  });
        return h(
          'div',
          {
            key: layer,
            'data-inspector-layer': layer,
            'data-layer-kind': fact.kind,
            'data-layer-enabled': fact.kind === 'disabled' ? 'false' : fact.kind === 'error' ? '' : 'true',
            'data-layer-total': String(fact.total),
            'data-layer-ineffective': String(fact.ineffective),
            style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, fontSize: 12, color: token.labelSecondary },
          },
          h('span', { style: { color: token.labelPrimary } }, t(layer === 'user' ? 'stUserLayer' : 'stWorkspaceLayer')),
          h('span', null, value),
        );
      };
      const actionLabelOf = (action) =>
        action === 'replace' ? t('ovEffective') : action === 'hide' ? t('stHidden') : action === 'append' ? t('stAppended') : String(action);
      const sectionRow = (row) => {
        const rowOpen = isExpanded(row.key);
        return h(
          'li',
          {
            key: row.key,
            role: 'button',
            tabIndex: 0,
            'aria-expanded': rowOpen ? 'true' : 'false',
            'data-section-row': '',
            'data-section-expanded': rowOpen ? 'true' : 'false',
            'data-section-name': row.name,
            'data-section-index': row.index === null ? '' : String(row.index),
            'data-section-chars': String(row.chars),
            'data-section-origin': row.origin,
            'data-section-applied': row.applied ? 'true' : 'false',
            'data-section-override-layer': row.overrideLayer === null ? '' : row.overrideLayer,
            'data-section-action': row.action === null ? '' : row.action,
            onClick: (event) => {
              if (event !== null && typeof event.stopPropagation === 'function') event.stopPropagation();
              toggleRow(row.key);
            },
            onKeyDown: (event) => {
              if (event !== null && event !== undefined && (event.key === 'Enter' || event.key === ' ')) {
                if (typeof event.preventDefault === 'function') event.preventDefault();
                toggleRow(row.key);
              }
            },
            style: { ...PROMPT_INSPECTOR_STYLE.row, cursor: 'pointer' },
          },
          h(
            'div',
            { style: PROMPT_INSPECTOR_STYLE.rowTop },
            h('span', { style: { fontWeight: 600, color: token.labelPrimary, wordBreak: 'break-word' } },
              `${row.index === null ? '—' : `#${row.index}`} ${row.name}`),
            h('span', { style: { flex: 'none', color: token.labelTertiary } },
              fmt(t('colChars'), { n: String(row.chars) })),
          ),
          h(
            'div',
            { style: PROMPT_INSPECTOR_STYLE.rowMeta },
            h('span', { 'data-section-meta': 'origin' }, t(originKey(row.origin))),
            row.overrideLayer === null
              ? null
              : h('span', { 'data-section-meta': 'override' }, t(layerKey(row.overrideLayer))),
            row.action === null
              ? null
              : h('span', { 'data-section-meta': 'status' }, actionLabelOf(row.action)),
            row.reason === ''
              ? null
              : h('span', { 'data-section-meta': 'reason', style: { color: token.stateWarn } },
                  `${t('colReason')}${t('assemblyLayerSep')}${row.reason}`),
          ),
          rowOpen
            ? h(
                'pre',
                {
                  'data-section-text': '',
                  style: PROMPT_INSPECTOR_STYLE.pre,
                  // Selecting/copying inside the text must not reach the row's
                  // toggle (a click on the selection would collapse it at once).
                  onMouseDown: (event) => {
                    if (event !== null && typeof event.stopPropagation === 'function') event.stopPropagation();
                  },
                  onClick: (event) => {
                    if (event !== null && typeof event.stopPropagation === 'function') event.stopPropagation();
                  },
                },
                row.text === '' ? t('stNone') : row.text,
              )
            : null,
        );
      };
      return [
        h('div', { key: 'scrim', 'data-inspector-scrim': '', onClick: dismiss, style: PROMPT_INSPECTOR_STYLE.scrim }),
        h(
          'div',
          {
            key: 'panel',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('barAssemblyLabel'),
            'data-plugin': 'dsh-prompt-setting',
            'data-region': PROMPT_INSPECTOR_REGION,
            'data-inspector-panel': '',
            'data-inspector-phase': phase,
            'data-inspector-session': sessionId,
            'data-inspector-total-sections': phase === 'ready' ? String(totals.sections) : '',
            'data-inspector-total-chars': phase === 'ready' ? String(totals.chars) : '',
            ref: panelRef,
            onClick: (event) => {
              if (event !== null && typeof event.stopPropagation === 'function') event.stopPropagation();
            },
            style: panelStyle,
          },
          h(
            'div',
            {
              'data-inspector-drag-handle': '',
              style: PROMPT_INSPECTOR_STYLE.header,
              onPointerDown: beginDrag,
              onPointerMove: moveDrag,
              onPointerUp: endDrag,
              onPointerCancel: endDrag,
            },
            h('h2', { style: { margin: 0, fontSize: 14, fontWeight: 600, lineHeight: '20px' } }, t('barAssemblyLabel')),
            h(
              'button',
              {
                type: 'button',
                'data-action': 'prompt-inspector-close',
                'aria-label': t('presetDialogClose'),
                title: t('presetDialogClose'),
                onClick: dismiss,
                style: PROMPT_INSPECTOR_STYLE.close,
              },
              '×',
            ),
          ),
          h(
            'div',
            { 'data-inspector-body': '', style: PROMPT_INSPECTOR_STYLE.body },
            h(
              'p',
              {
                'data-inspector-summary': '',
                'data-inspector-empty': phase === 'no-session' ? 'no-session' : undefined,
                'data-inspector-error': phase === 'error' ? 'true' : undefined,
                role: 'status',
                style: { ...PROMPT_INSPECTOR_STYLE.line, color: phase === 'error' ? token.stateError : token.labelSecondary },
              },
              summaryText,
            ),
            phase === 'ready'
              ? h(
                  'section',
                  { 'data-inspector-block': 'sections', style: PROMPT_INSPECTOR_STYLE.block },
                  h('h3', { style: PROMPT_INSPECTOR_STYLE.heading }, t('viewSections')),
                  h('ol', { style: PROMPT_INSPECTOR_STYLE.list }, rows.map(sectionRow)),
                )
              : null,
            phase === 'ready'
              ? h(
                  'section',
                  { 'data-inspector-block': 'layers', style: PROMPT_INSPECTOR_STYLE.block },
                  h('h3', { style: PROMPT_INSPECTOR_STYLE.heading }, t('stateHeading')),
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, PROMPT_INSPECTOR_LAYERS.map(layerRow)),
                )
              : null,
            phase === 'ready'
              ? h(
                  'section',
                  { 'data-inspector-block': 'assembly', 'data-inspector-assembly': assembly.kind, style: PROMPT_INSPECTOR_STYLE.block },
                  h('h3', { style: PROMPT_INSPECTOR_STYLE.heading }, t('barAssemblyLabel')),
                  assembly.kind === 'notice'
                    ? [
                        h(
                          'p',
                          { key: 'assembly-verdict', 'data-inspector-verdict': 'assembly', style: PROMPT_INSPECTOR_STYLE.line },
                          `${t('assemblyLayerAssembly')}${t('assemblyLayerSep')}${assemblyVerdictOf(t, assembly.notice)}`,
                        ),
                        h(
                          'p',
                          { key: 'delivery-verdict', 'data-inspector-verdict': 'delivery', style: PROMPT_INSPECTOR_STYLE.line },
                          `${t('assemblyLayerDelivery')}${t('assemblyLayerSep')}${deliveryVerdictOf(t, assembly.notice)}`,
                        ),
                      ]
                    : h('p', { 'data-inspector-verdict': 'summary', style: PROMPT_INSPECTOR_STYLE.line }, assemblyText),
                  h(
                    'p',
                    {
                      'data-inspector-time': '',
                      'data-inspector-time-source': stampFact.source,
                      style: PROMPT_INSPECTOR_STYLE.line,
                    },
                    `${t('histPreviewAt')}${t('assemblyLayerSep')}${stampText}`,
                  ),
                  frozen === null
                    ? null
                    : h(
                        'p',
                        { 'data-inspector-frozen': 'true', style: { ...PROMPT_INSPECTOR_STYLE.line, color: token.stateWarn } },
                        `${t('stFrozenSession')}${frozen.section === '' ? '' : ` · ${frozen.section}`}`
                          + `${frozen.reason === '' ? '' : ` · ${fmt(t('mineLayerDisabledReason'), { reason: frozen.reason })}`}`,
                      ),
                )
              : null,
          ),
        ),
      ];
    }

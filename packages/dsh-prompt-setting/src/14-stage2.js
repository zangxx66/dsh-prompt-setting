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
    function layerQuery(layer, sessionArg) {
      const parts = [`layer=${encodeURIComponent(layer)}`];
      if (sessionArg !== null) parts.push(`session=${encodeURIComponent(sessionArg)}`);
      return parts.join('&');
    }

    /**
     * g-038: the query one **version-history** request needs for a layer.
     *
     * Deliberately *not* {@link layerQuery}: the history scope is its own thing.
     * The user layer is global — no `session` at all, because history is not
     * something a "view scope" may slice (that was the defect this goal fixes).
     * The workspace layer is located by `workspace=…` (a session id that
     * resolves to the workspace), which names the
     * workspace whose log to read **without** narrowing it to that session's own
     * writes, so one workspace's log is read whole.
     * @param layer - `user` | `workspace`.
     * @param scopeSession - the session id resolving the scope, or ''.
     * @returns `layer=…[&workspace=…]`.
     */
    function historyScopeQuery(layer, scopeSession) {
      const parts = [`layer=${encodeURIComponent(layer)}`];
      if (layer === 'workspace' && typeof scopeSession === 'string' && scopeSession.length > 0) {
        parts.push(`workspace=${encodeURIComponent(scopeSession)}`);
      }
      return parts.join('&');
    }

    /**
     * g-038: the paging numbers of one history response, as this page reads
     * them.
     *
     * The **host** owns the page size (this bundle must never hardcode one), so
     * everything here is derived from the response it just read: the offset it
     * actually used (it clamps), the page count it computed and its `hasMore`.
     * The derived fallbacks exist only for a host that predates those fields —
     * they never override an answer the host gave.
     * @param data - the `GET /history` payload, or null.
     * @returns `{pageSize, offset, total, pageCount, pageIndex, hasMore}`.
     */
    function historyPagerInfo(data) {
      const page = data === null || data === undefined || typeof data !== 'object' ? {} : data;
      const total = Number.isInteger(page.total) && page.total > 0 ? page.total : 0;
      const pageSize = Number.isInteger(page.pageLimit) && page.pageLimit > 0 ? page.pageLimit : 0;
      const pageCount =
        Number.isInteger(page.pageCount) && page.pageCount > 0
          ? page.pageCount
          : pageSize > 0
            ? Math.max(1, Math.ceil(total / pageSize))
            : 0;
      const rawOffset = Number.isInteger(page.offset) && page.offset > 0 ? page.offset : 0;
      // The window is clamped into the pages that exist: an offset past the end
      // (a stale page, a host that answers before it clamps) must read as the
      // last page rather than as "page 6 of 3" with nothing under it.
      const pageIndex = pageSize > 0 && pageCount > 0
        ? Math.min(Math.floor(rawOffset / pageSize), pageCount - 1)
        : 0;
      const offset = pageSize > 0 ? pageIndex * pageSize : rawOffset;
      const lastPage = Math.max(1, pageCount) - 1;
      const hasMore =
        (typeof page.hasMore === 'boolean' ? page.hasMore : pageSize > 0 && offset + pageSize < total)
        && pageIndex < lastPage;
      return { pageSize, offset, total, pageCount, pageIndex, hasMore };
    }

    /**
     * g-039 (fourth round): how tall the「版本历史」panel may be, from what was
     * actually measured around it.
     *
     * The height used to be `calc(100vh - 260px)`, where 260 was the room the
     * settings page was *estimated* to spend above this card. That estimate is a
     * guess about someone else's dialog: a shell that adds its own padding or
     * header moves the real boundary, and a guess that is too small puts the
     * panel past the visible area — the page scrollbar this layout exists to
     * remove, back again. So the room is measured instead: the panel's own top
     * edge and the bottom of the nearest **scrollable ancestor** (the thing that
     * would actually scroll), or the viewport when there is no such ancestor.
     *
     * Pure and total by design: any input may be missing, zero or nonsense and
     * the answer is still usable — `{height: null, source: 'fallback'}`, which
     * the renderer turns into the constant `calc` string. The `source` is part
     * of the contract because it is reported on the panel
     * (`data-history-height-source`) and is the first thing to read on a real
     * page when the panel looks the wrong size.
     *
     * `panelTop <= 0` is treated as "not measured": a panel at the top of the
     * document cannot be distinguished from a rect that was never laid out
     * (every real card sits below the settings title, and an unlaid-out element
     * reports all zeros).
     * @param inputs - `{panelTop, boundaryBottom, viewportHeight, minHeight, gap}`.
     *   `panelTop` is the panel's `getBoundingClientRect().top`, `boundaryBottom`
     *   the scrollable ancestor's `.bottom` (or `null` when there is none), and
     *   `viewportHeight` the `window.innerHeight` fallback boundary.
     * @returns `{height, source}`: an integer px height with `source: 'measured'`,
     *   or `{height: null, source: 'fallback'}` for the constant path.
     */
    function historyPanelHeight(inputs) {
      const input = inputs === null || inputs === undefined ? {} : inputs;
      const usable = (value) => typeof value === 'number' && Number.isFinite(value);
      const floor = usable(input.minHeight) && input.minHeight > 0 ? input.minHeight : HISTORY_PANEL_MIN_HEIGHT;
      const gap = usable(input.gap) && input.gap > 0 ? input.gap : 0;
      const panelTop = usable(input.panelTop) && input.panelTop > 0 ? input.panelTop : null;
      if (panelTop === null) return { height: null, source: 'fallback' };
      const boundary = usable(input.boundaryBottom) && input.boundaryBottom > 0 ? input.boundaryBottom : null;
      const viewport = usable(input.viewportHeight) && input.viewportHeight > 0 ? input.viewportHeight : null;
      // No scrollable ancestor is not a failure: the viewport is the boundary
      // that always exists in a browser.
      const bottom = boundary === null ? viewport : boundary;
      if (bottom === null) return { height: null, source: 'fallback' };
      const available = bottom - panelTop - gap;
      if (!usable(available) || available <= 0) return { height: null, source: 'fallback' };
      return { height: Math.max(floor, Math.floor(available)), source: 'measured' };
    }

    /**
     * The nearest ancestor that would scroll this panel, or `null`.
     *
     * This is the boundary {@link historyPanelHeight} is measured against: the
     * settings dialog's own scroll container when there is one, so the panel
     * stops at the edge of what the user can actually see instead of at a
     * guessed offset. `overflow-y: auto | scroll` is the test — the same one the
     * browser uses — and it is read through `getComputedStyle` so a stylesheet
     * (not just an inline style) counts.
     * @param node - the panel element.
     * @returns the ancestor element, or `null` when there is none.
     */
    function scrollBoundaryOf(node) {
      if (node === null || node === undefined) return null;
      const style = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
        ? (element) => window.getComputedStyle(element)
        : null;
      if (style === null) return null;
      let current = node.parentElement === undefined ? null : node.parentElement;
      while (current !== null && current !== undefined) {
        let overflowY = '';
        try {
          overflowY = String(style(current).overflowY || '');
        } catch {
          overflowY = '';
        }
        if (overflowY === 'auto' || overflowY === 'scroll') return current;
        current = current.parentElement === undefined ? null : current.parentElement;
      }
      return null;
    }

    /**
     * g-061: one row per workspace the page can name, derived once for the two
     * callers that ask the same question — the version-history scope selector
     * (g-038, {@link historyScopeOptionsOf}) and the preset layer picker (g-060,
     * `presetWorkspaces`).
     *
     * Both hold the same workspace seat and need the same facts: a workspace's
     * first session id (the identity a Host resolves a root from — `CONTRACT.md`
     * §4.2, so a client never supplies a path), its title, and, with no title,
     * its directory name. They *label* those facts differently (`value` /
     * `workspaceId` / `sessionIds` for the selector, `session` / `root` for the
     * picker), so the derivation is shared and the field names stay at the call
     * sites: one computation, two output shapes, each of them exactly what it
     * was before.
     *
     * A workspace no session ever ran in is skipped — the Host resolves a root
     * from a session, so such a row could only produce a refusal. When the
     * profile lists no usable workspace the rows degrade to the session catalog,
     * the same fallback the selector has always announced in words.
     * @param wsSeat - the workspace seat (`{items}`); `null` reads as "no workspaces".
     * @param seat - the session seat (`{rows}`) the fallback reads; `null` for none.
     * @param options - `{withRoot}`: the picker's shape (adds `root`) instead of
     *   the selector's.
     * @returns the rows, in seat order.
     */
    function workspaceRows(wsSeat, seat, options) {
      const withRoot = Boolean(options && options.withRoot);
      const workspaces = Array.isArray(wsSeat && wsSeat.items) ? wsSeat.items : [];
      const rows = [];
      for (const workspace of workspaces) {
        const ids = Array.isArray(workspace && workspace.sessionIds)
          ? workspace.sessionIds.filter((id) => typeof id === 'string' && id.length > 0)
          : [];
        if (ids.length === 0) continue;
        const title = typeof workspace.title === 'string' ? workspace.title : '';
        const path = typeof workspace.path === 'string' ? workspace.path : '';
        const label = title.length > 0 ? title : basenameOf(path) || workspace.workspaceId || ids[0];
        rows.push(
          withRoot
            ? { session: ids[0], root: path.length > 0 ? path : null, label }
            : {
                value: ids[0],
                label,
                workspaceId: typeof workspace.workspaceId === 'string' ? workspace.workspaceId : '',
                sessionIds: ids,
              },
        );
      }
      if (rows.length > 0) return rows;
      const sessionRows = Array.isArray(seat && seat.rows) ? seat.rows : [];
      return sessionRows.slice(0, SESSION_MATCH_LIMIT).map((row) =>
        withRoot
          ? { session: row.id, root: null, label: sessionLabelOf(sessionRows, row.id) || row.id }
          : {
              value: row.id,
              label: sessionLabelOf(sessionRows, row.id) || row.id,
              workspaceId: '',
              sessionIds: [row.id],
            },
      );
    }

    /**
     * g-038: the options the version-history scope selector offers.
     *
     * The scope is a **workspace** dimension: one option per workspace the host
     * lists, labelled with its title (or, for a workspace with no title, its
     * directory name — the same fallback the 查看范围 tree uses). The option's
     * value is a session id, because a workspace's log is located through the
     * host's own session index and a client never supplies a path (§4.2) — one
     * member session stands for the workspace.
     *
     * When the profile provides no workspace list the selector degrades to the
     * session catalog (`mode: 'sessions'`, announced on the page), and with
     * neither there is no scope at all (`mode: 'none'`), which the panel says in
     * words instead of asking the host a question it must refuse.
     * @param wsSeat - the workspace seat (`{items}`).
     * @param seat - the session seat (`{rows}`).
     * @returns `{mode, options}` with options `{value, label, workspaceId, sessionIds}`.
     */
    function historyScopeOptionsOf(wsSeat, seat) {
      // Asked twice with one seat each time, so「which half answered」stays a
      // question of this call site — a `mode` — instead of a third branch inside
      // the shared derivation.
      const fromWorkspaces = workspaceRows(wsSeat, null, { withRoot: false });
      if (fromWorkspaces.length > 0) return { mode: 'workspaces', options: fromWorkspaces };
      const fromSessions = workspaceRows(null, seat, { withRoot: false });
      if (fromSessions.length === 0) return { mode: 'none', options: [] };
      return { mode: 'sessions', options: fromSessions };
    }

    /**
     * g-073 (Revision 55): the options「提示词总览」's own scope selector offers.
     *
     * The shape is dictated by what the host does with `?session=`: it resolves
     * the workspace layer file from it **and** probes the assembly in that
     * session's own scope, so the frozen verdict and the variable resolution the
     * overview shows are per-session facts (§2.4). A workspace is therefore a
     * **group**, never an option, and every option's value is a concrete session
     * id — never the workspace's first one. `historyScopeOptionsOf` may compress
     * a workspace into one member session because a log file really is per
     * workspace; this selector may not, and copying that shortcut here is the
     * mistake this derivation exists to prevent.
     *
     * A session the workspace list does not claim is offered last, under the
     * session catalogue's own order; an empty seat yields `mode: 'none'`, which
     * the panel states in words instead of asking the host a question it must
     * refuse.
     * @param wsSeat - the workspace seat (`{items}`).
     * @param seat - the session seat (`{rows}`).
     * @returns `{mode, groups, options}`; a group is `{id, label, options}`.
     */
    function overviewScopeOptionsOf(wsSeat, seat) {
      const rows = Array.isArray(seat && seat.rows) ? seat.rows : [];
      const workspaces = Array.isArray(wsSeat && wsSeat.items) ? wsSeat.items : [];
      const groups = [];
      const claimed = new Set();
      for (const workspace of workspaces) {
        const ids = Array.isArray(workspace && workspace.sessionIds)
          ? workspace.sessionIds.filter((id) => typeof id === 'string' && id.length > 0)
          : [];
        if (ids.length === 0) continue;
        const title = typeof workspace.title === 'string' ? workspace.title : '';
        const path = typeof workspace.path === 'string' ? workspace.path : '';
        const label = title.length > 0 ? title : basenameOf(path) || workspace.workspaceId || ids[0];
        const options = ids.map((id) => ({
          value: id,
          label: sessionLabelOf(rows, id) || id,
          workspaceId: typeof workspace.workspaceId === 'string' ? workspace.workspaceId : '',
        }));
        for (const option of options) claimed.add(option.value);
        groups.push({
          id: typeof workspace.workspaceId === 'string' && workspace.workspaceId.length > 0 ? workspace.workspaceId : label,
          label,
          options,
        });
      }
      const rest = [];
      for (const row of rows) {
        if (row === null || row === undefined || typeof row.id !== 'string' || row.id.length === 0) continue;
        if (claimed.has(row.id)) continue;
        rest.push({ value: row.id, label: sessionLabelOf(rows, row.id) || row.id, workspaceId: '' });
      }
      if (rest.length > 0) groups.push({ id: 'sessions', label: '', options: rest });
      const options = [];
      for (const group of groups) for (const option of group.options) options.push(option);
      if (options.length === 0) return { mode: 'none', groups: [], options: [] };
      return { mode: workspaces.length > 0 ? 'workspaces' : 'sessions', groups, options };
    }

    /**
     * The reserved section's stored text in one layer, read from **that layer's
     * own** override list (`payload.user.overrides` / `payload.workspace.overrides`,
     * CONTRACT.md §3) — the file the layer itself holds, so what 「我的 Prompt」
     * shows for a layer is what that layer stored.
     *
     * Deliberately not `merged` (g-054). The merged list is the *assembly* view:
     * it deduplicates by section name across layers, so a workspace entry
     * replaces a same-named user entry and only one layer is ever named per
     * section. Reading a specific layer's stored text from it reported `null`
     * — an empty box in the 「未配置」 state — whenever the other layer held the
     * same name, even though this layer's file had the text all along.
     *
     * `null` means "the layer has no reserved override at all" (the page shows
     * the unconfigured state); `''` means "configured, but as empty text".
     * @param ovs - the `GET /overrides` payload, or null.
     * @param layer - `user` | `workspace`.
     * @returns the stored text, or null when the entry is absent.
     */
    function reservedTextOf(ovs, layer) {
      const entry = reservedEntryOf(ovs, layer);
      if (entry === null) return null;
      return typeof entry.text === 'string' ? entry.text : '';
    }

    /**
     * g-058 (Revision 36): one layer's stored reserved **entry**, or `null`.
     *
     * The panel needs two facts from that entry since the mode exists — the text
     * ({@link reservedTextOf}) and the mode — and both must come from **that
     * layer's own** view of `GET /overrides` for the same reason the text does
     * (g-054): `merged` deduplicates by name, so it names at most one layer per
     * section and cannot answer "what did this layer store".
     * @param ovs - the `GET /overrides` payload, or null.
     * @param layer - `user` | `workspace`.
     * @returns the entry, or null when the layer holds no reserved entry.
     */
    function reservedEntryOf(ovs, layer) {
      const view = ovs !== null && typeof ovs === 'object' ? ovs[layer] : null;
      const list =
        view !== null && typeof view === 'object' && Array.isArray(view.overrides) ? view.overrides : [];
      const entry = list.find((candidate) => candidate && candidate.name === RESERVED_SECTION_NAME);
      return entry === undefined ? null : entry;
    }

    /**
     * g-058 (Revision 36): the mode one stored reserved entry carries.
     *
     * The stored word is authoritative: `append` is「叠加」, everything else
     * (including an entry written before this revision, which carries
     * `replace`) is「覆盖」— the behaviour that entry already had.
     * @param entry - a reserved entry, or null.
     * @returns `'replace'` | `'append'`, or null when there is no entry.
     */
    function modeOfEntry(entry) {
      if (entry === null || entry === undefined) return null;
      return entry.action === 'append' ? 'append' : RESERVED_SECTION_DEFAULT_MODE;
    }

    /**
     * g-058 (Revision 36): the mode **this layer's file** stores, or `null` when
     * the layer holds no reserved entry at all. `null` is not `'replace'`: the
     * panel distinguishes「未设置」from「显式覆盖」in words, exactly as it does
     * for the interpolation switch (§16.1).
     * @param ovs - the `GET /overrides` payload, or null.
     * @param layer - `user` | `workspace`.
     * @returns `'replace'` | `'append'` | null.
     */
    function reservedModeOf(ovs, layer) {
      return modeOfEntry(reservedEntryOf(ovs, layer));
    }

    /**
     * Localized layer name.
     * @param t - the bound translator.
     * @param layer - `user` | `workspace`.
     * @returns the display string.
     */
    function layerLabel(t, layer) {
      return t(layer === 'workspace' ? 'ovWorkspace' : 'ovUser');
    }

    /**
     * g-056: the workspace root that owns one session, read from the workspace
     * seat this page already holds.
     *
     * This is the client half of the Host's own resolution (`index.js`
     * `workspaceRootFor` → `workspaceRegistry.list()` → `owner.path`): the same
     * `WorkspaceView.path` field (`dsh-api-workspace-controller`), so both sides
     * name the same directory. `null` when the session belongs to no listed
     * workspace or the workspace hook degraded — the caller then falls back to
     * the session id, which is the **narrower** identity: it can only make two
     * drafts look different, it can never make one draft look like another
     * scope's.
     * @param items - the workspace seat's `items`.
     * @param sessionId - the session id, or null.
     * @returns the workspace root path, or null.
     */
    function workspaceRootOfSession(items, sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
      const list = Array.isArray(items) ? items : [];
      const owner = list.find(
        (workspace) =>
          workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.indexOf(sessionId) >= 0,
      );
      if (owner === undefined) return null;
      const path = typeof owner.path === 'string' ? owner.path.trim() : '';
      return path.length > 0 ? path : null;
    }

    /**
     * g-056: the key of the「我的 Prompt」draft — the identity of the **file** a
     * save would write, per layer.
     *
     * The old key was `layer|session`, which made the *view* own the text. The
     * write face says otherwise (`index.js` `targetFor`):
     *   - `user`: `targetFor('user', …)` ignores the session entirely — the
     *     `userConfigPath()` is one path for the whole profile — so every
     *     session writes the same file and the draft has no session at all;
     *   - `workspace`: the target is `workspaceConfigPath(workspaceRootFor(
     *     session))`, and every session of one workspace resolves to the same
     *     root, so the draft belongs to the **workspace**, not to the session
     *     that happened to be selected when it was typed.
     *
     * A session that resolves to no listed workspace keeps the session id as its
     * identity: inventing a root would be inventing a write target.
     * @param layer - `user` | `workspace`.
     * @param sessionId - the session id, or null.
     * @param workspaceRoot - the root from {@link workspaceRootOfSession}, or null.
     * @returns the draft key.
     */
    function mineDraftKeyOf(layer, sessionId, workspaceRoot) {
      if (layer !== 'workspace') return 'user';
      const identity = workspaceRoot !== null ? workspaceRoot : sessionId === null ? '' : sessionId;
      return `workspace|${identity}`;
    }

    /**
     * g-058 (Revision 36): the mode one recorded draft carries.
     *
     * A draft typed before this revision has no `mode` field, and it means
     * 「覆盖」— the only mode that existed when it was typed. Reading an old draft
     * as anything else would make an untouched editor look dirty, which is
     * exactly the silent state change §4.2 refuses.
     * @param draft - a recorded draft, or null.
     * @returns `'replace'` | `'append'`.
     */
    function draftModeOf(draft) {
      return draft !== null && draft !== undefined && draft.mode === 'append'
        ? 'append'
        : RESERVED_SECTION_DEFAULT_MODE;
    }

    /**
     * g-056: the readable name of the scope a draft belongs to, shown beside the
     * editor so the reader can tell whose text the box holds.
     * @param t - the bound translator.
     * @param layer - `user` | `workspace`.
     * @param sessionId - the session id, or null.
     * @param rows - the session seat's rows.
     * @returns the display string.
     */
    function mineScopeNameOf(t, layer, sessionId, rows) {
      const base = layerLabel(t, layer);
      if (layer !== 'workspace') return base;
      const label = sessionLabelOf(rows, sessionId === null ? '' : sessionId);
      return label.length > 0 ? `${base} · ${label}` : base;
    }

    /**
     * g-056 (review R1): the reserved text of one layer, read from **that
     * layer's own view** (`payload[layer].overrides`) rather than from `merged`.
     *
     * A draft's "is this still unsaved work?" question is a question about the
     * file the draft belongs to, so it may only be answered by that file's own
     * list — the merged list mixes both layers and would report one layer's text
     * as the other's stored value.
     * @param ovs - the `GET /overrides` payload, or null.
     * @param layer - `user` | `workspace`.
     * @returns the stored text, or null when that layer holds no reserved entry.
     */
    function layerReservedTextOf(ovs, layer) {
      const entry = reservedEntryOf(ovs, layer);
      if (entry === null) return null;
      return typeof entry.text === 'string' ? entry.text : '';
    }

    /**
     * g-058 (Revision 36): the mode that layer's own file stores, read from the
     * same per-layer view as {@link layerReservedTextOf} — a foreign draft is
     * "still unsaved work" for its **text and its mode** alike, so both have to
     * be answerable from the one file the draft belongs to.
     * @param ovs - the `GET /overrides` payload, or null.
     * @param layer - `user` | `workspace`.
     * @returns `'replace'` | `'append'` | null.
     */
    function layerReservedModeOf(ovs, layer) {
      return modeOfEntry(reservedEntryOf(ovs, layer));
    }

    /**
     * g-056 (review R1): the reserved entry a **recorded draft's own write
     * target** holds, as far as this render can know it.
     *
     * `known: false` means「this page has not read that file」: the draft's target
     * is a workspace other than the one the current request resolved, or the
     * draft records no scope at all (a draft from before g-056's shape). The
     * caller must then treat it as *possibly* unsaved — the panel may warn, but
     * it must never silently overwrite — which is the conservative half of the
     * trade recorded in `NOTES.md` §129.
     *
     * g-058 (Revision 36): the answer carries the **mode** beside the text,
     * because a draft's unsaved work is the pair. A draft whose text matches the
     * file but whose mode does not is still text the user would lose by saving
     * over it, so both facts come from the same per-layer read.
     * @param ovs - the `GET /overrides` payload, or null.
     * @param scope - the draft's `{layer, session, root}`.
     * @param currentRoot - the workspace root the current request resolved.
     * @returns `{known: true, text, mode}` or `{known: false, text: null, mode: null}`.
     */
    function draftTargetOf(ovs, scope, currentRoot) {
      if (scope === null || scope === undefined) return { known: false, text: null, mode: null };
      const layer = scope.layer === 'workspace' ? 'workspace' : 'user';
      if (layer === 'workspace') {
        const root = typeof scope.root === 'string' && scope.root.length > 0 ? scope.root : null;
        // A different workspace is a file this request never read: 「unknown」,
        // never「empty」.
        if (root === null || currentRoot === null || root !== currentRoot) {
          return { known: false, text: null, mode: null };
        }
      }
      return { known: true, text: layerReservedTextOf(ovs, layer), mode: layerReservedModeOf(ovs, layer) };
    }

    /**
     * Hand a JSON document to the browser as a download.
     *
     * Two surfaces are attempted in order, and the caller is told which one was
     * used so the UI can tell the truth when neither worked (the settings panel
     * must never claim a download that did not happen):
     * 1. `Blob` + an object URL — the real download;
     * 2. a `data:` URL on the same anchor — the fallback where `Blob` is absent.
     * @param text - the JSON text.
     * @param filename - the suggested file name.
     * @returns `{ok: true, mode}` or `{ok: false, code: 'download-failed'}`.
     */
    function downloadText(text, filename) {
      const click = (href) => {
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = filename;
        anchor.rel = 'noopener';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
      };
      try {
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
          // g-066: the answer is a *machine* code, never prose. What the user
          // reads comes from the dictionary (`errorText` → `errUnknown`), so an
          // English sentence written for a console log cannot leak into
          // localized copy (the export notice interpolates this reason).
          return { ok: false, code: 'download-failed' };
        }
        if (typeof Blob === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
          try {
            click(url);
          } finally {
            if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
          }
          return { ok: true, mode: 'blob' };
        }
        click(`data:application/json;charset=utf-8,${encodeURIComponent(text)}`);
        return { ok: true, mode: 'data-url' };
      } catch (error) {
        return { ok: false, code: 'download-failed' };
      }
    }

    /**
     * The suggested export file name: identifiable, ordered by time, and named
     * in the **reader's own time zone** (Revision 18).
     *
     * A file name is a stamp too — the one the user keeps on disk after the page
     * is gone — so naming it in UTC would leave the exported artifact reading in
     * the zone nobody reads while every stamp on the page reads local. The zone
     * label is deliberately absent here: a file name is not a place to explain a
     * clock, and `+` is a doubtful character inside one.
     *
     * The shape is `dsh-prompt-setting-YYYY-MM-DD-HH-mm-ss.json`. `:` is folded
     * to `-` because it is illegal in a name on Windows and hostile elsewhere,
     * the fixed-width fields keep the name sorting in exactly the order it
     * reads, and dropping the milliseconds loses nothing a user picks a file by.
     * A value this engine cannot read as a time still yields the pre-Revision-18
     * UTC spelling, so a page without `Intl` names the file rather than calling
     * it `export`.
     * @param at - the ISO export timestamp.
     * @returns `dsh-prompt-setting-…json`, with the export time in the name.
     */
    function exportFileName(at) {
      const value = String(at || '');
      const local = value.length === 0 ? null : localStampParts(value);
      const stamp =
        local === null
          ? value.replace(/[:.]/g, '-').replace('Z', '')
          : `${local.date}-${local.time.replace(/:/g, '-')}`;
      return `dsh-prompt-setting-${stamp.length > 0 ? stamp : 'export'}.json`;
    }

    /**
     * Whether this render may draw the official diff renderer.
     *
     * Probed, never assumed — exactly like the Button/Tag probes — and asked
     * **per render**, because the version-history chunk caches whatever it
     * reads: a `DiffBlock` that threw while React rendered it must be replaced
     * by the hand-built diff on the next render, not re-rendered from a stale
     * `true` (g-063 E1).
     * @returns `true` when the Host's `DiffBlock` is usable right now.
     */
    function diffBlockUsable() {
      return primitivesActive() && hasComponentExport(primitives, 'DiffBlock');
    }

    /**
     * The localized chrome `DiffBlock` asks its owner for.
     * @param t - the bound translator.
     * @returns the labels object.
     */
    function diffBlockLabels(t) {
      return {
        copy: t('diffBlockCopy'),
        copied: t('diffBlockCopied'),
        collapse: t('diffBlockCollapse'),
        expand: (hidden) => fmt(t('diffBlockExpand'), { n: hidden }),
        collapseAria: t('diffBlockCollapseAria'),
        expandAria: (hidden) => fmt(t('diffBlockExpandAria'), { n: hidden }),
        codeLabel: t('diffBlockCode'),
        wrapLabel: t('diffBlockWrap'),
        unwrapLabel: t('diffBlockUnwrap'),
      };
    }

    /** Localized label for a diff line op. */
    function diffOpMarker(type) {
      if (type === 'insert') return '+';
      if (type === 'delete') return '-';
      return ' ';
    }

    // #endregion

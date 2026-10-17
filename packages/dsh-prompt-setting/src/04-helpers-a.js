// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。
    // #region pure helpers

    /**
     * Interpolate `{name}` placeholders in already-localized copy.
     * @param text - the localized template.
     * @param params - placeholder values.
     * @returns the filled string.
     */
    function fmt(text, params) {
      return String(text).replace(/\{(\w+)\}/g, (match, key) =>
        params[key] === undefined || params[key] === null ? match : String(params[key]),
      );
    }

    /**
     * Separators for the compact session encoding. Control characters are not
     * typeable, and the decoding is positional, so a title can never forge a
     * field boundary (the display fields are flattened first).
     */
    const SESSION_ROW_SEP = '\u001e';
    const SESSION_FIELD_SEP = '\u001f';
    /** Record separator for the multi-section workspace payload. */
    const SCOPE_RECORD_SEP = '\u001c';
    /** List separator inside one workspace payload field (`sessionIds`). */
    const SCOPE_ID_SEP = '\u001d';

    /** Every separator, for the fast "does this field need flattening" test. */
    const SESSION_SEPARATOR_PATTERN = /[\u001c\u001d\u001e\u001f]/;

    /**
     * Flatten one display field so it cannot contain an encoding separator. The
     * common path is a single regex test: a title with no control character (the
     * normal case) is returned untouched, no allocation.
     */
    function flattenSessionField(value) {
      const text = typeof value === 'string' ? value : '';
      if (!SESSION_SEPARATOR_PATTERN.test(text)) return text;
      return text.replace(/[\u001c\u001d\u001e\u001f]/g, ' ');
    }

    /**
     * The single selector handed to the props `useSessions` root hook.
     *
     * `ctx.sessions.search` is deliberately NOT used: it searches the Host's
     * *message-content* index (`ISessions.search(query, signal)` → bounded
     * `SessionSearchResultItem[]`), not session metadata; it matches message
     * text rather than title/path/id, and reaching it would need a `sessions`
     * service injection plus an async round trip per keystroke. The `list`
     * snapshot is documented as "the metadata authority", so the picker filters
     * it locally and bounds what it renders.
     *
     * The selector returns a *string* (the hook's equality check sees a stable
     * value; compact fields rather than JSON keep it ~2× smaller at the 5000-row
     * extreme), and it never throws on a not-yet-ready snapshot.
     * @param state - `SessionListState` (or anything shaped like it).
     * @returns the encoded string.
     */
    function sessionsProbeSelector(state) {
      const ids = state && Array.isArray(state.ids) ? state.ids : [];
      const byId = state && state.byId && typeof state.byId === 'object' ? state.byId : {};
      let current = '';
      for (const id of ids) {
        const row = byId[id];
        // Product usage (dsh-client-ui-layout): the session the main view retains.
        if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) {
          current = id;
          break;
        }
      }
      const records = ids.map((id) => {
        const row = byId[id] || {};
        return [
          String(id),
          flattenSessionField(row.displayTitle || row.title),
          flattenSessionField(row.title),
          flattenSessionField(row.cwd),
          row.running === true ? '1' : '0',
          // The three fields the workspace tree orders and filters by, copied
          // from the sidebar's own projection (`deriveGroups`): recency order
          // needs `updatedAt`, blank rows are the provisional New Session, and
          // subagent-origin sessions are never listed.
          Number.isFinite(row.updatedAt) ? String(row.updatedAt) : '',
          row.blank === true ? '1' : '0',
          typeof row.origin === 'string' ? flattenSessionField(row.origin) : '',
        ].join(SESSION_FIELD_SEP);
      });
      return [current, ...records].join(SESSION_ROW_SEP);
    }

    /**
     * One-entry decode cache. The props hook re-runs our selector on every
     * render, so the payload string is rebuilt often; caching the decode (and
     * the lowercased search text inside it) is what keeps a keystroke cheap in a
     * large catalog. Keyed by the exact payload, so a changed catalog misses.
     */
    let sessionDecodeKey = null;
    let sessionDecodeValue = { currentId: '', rows: [] };

    /**
     * Decode {@link sessionsProbeSelector}'s output.
     *
     * Each row also carries a pre-lowercased `haystack` covering id, display
     * title, title and cwd, so matching one query is one `indexOf` per row
     * instead of four `toLowerCase` allocations.
     *
     * A payload with no row separator is treated as unconformant and yields an
     * empty catalog rather than a fabricated session id.
     * @param encoded - the selector value.
     * @returns `{currentId, rows: [{id, displayTitle, title, cwd, running, haystack}]}`.
     */
    function decodeSessions(encoded) {
      if (typeof encoded !== 'string' || encoded.length === 0) return { currentId: '', rows: [] };
      if (encoded === sessionDecodeKey) return sessionDecodeValue;
      const parts = encoded.split(SESSION_ROW_SEP);
      if (parts.length < 2) return { currentId: '', rows: [] };
      const rows = parts
        .slice(1)
        .map((record) => {
          const fields = record.split(SESSION_FIELD_SEP);
          const updatedAt = Number(fields[5]);
          const row = {
            id: fields[0] || '',
            displayTitle: fields[1] || '',
            title: fields[2] || '',
            cwd: fields[3] || '',
            running: fields[4] === '1',
            updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
            blank: fields[6] === '1',
            origin: fields[7] || '',
          };
          row.haystack = [row.id, row.displayTitle, row.title, row.cwd].join(' ').toLowerCase();
          return row;
        })
        .filter((row) => row.id.length > 0);
      sessionDecodeKey = encoded;
      sessionDecodeValue = { currentId: parts[0] || '', rows };
      return sessionDecodeValue;
    }

    /**
     * Case-insensitive substring match across every field a user may search by.
     * @param row - a decoded session row.
     * @param needle - the already-trimmed, already-lowercased query.
     * @returns whether the row matches.
     */
    function sessionMatchesQuery(row, needle) {
      if (needle.length === 0) return true;
      // g-061 batch 3: the same comparison the history scope list makes, with
      // this side's own cache handed over. `row.haystack` — the pre-lowercased
      // join `decodeSessions` builds once per list — stays, because a session
      // list can hold thousands of rows; the field-by-field walk is the fallback
      // for a row that arrived without it. The fields are listed here rather than
      // joined inside the shared function, because joining is what lets a match
      // span two fields: that is a property of this side's cached haystack, not
      // something the shared comparison may impose on the other side.
      return matchesNeedle([row.id, row.displayTitle, row.title, row.cwd], needle, { cached: row.haystack });
    }

    /**
     * Filter the session rows for the picker. Order is the service's (Host list
     * order); nothing is sorted here.
     * @param rows - the decoded rows.
     * @param query - the raw search box content.
     * @returns every matching row (the caller bounds what it renders).
     */
    function filterSessions(rows, query) {
      const list = Array.isArray(rows) ? rows : [];
      const needle = normalizeNeedle(query);
      if (needle.length === 0) return list.slice();
      return list.filter((row) => sessionMatchesQuery(row, needle));
    }

    /** The readable label of one session row. */
    function sessionRowLabel(row) {
      return `${row.displayTitle || row.title || row.id}${row.running ? ' ●' : ''}${row.cwd ? ` — ${row.cwd}` : ''}`;
    }

    /** The readable label of a session id inside a row list (falls back to the id). */
    function sessionLabelOf(rows, id) {
      if (typeof id !== 'string' || id.length === 0) return '';
      const row = (Array.isArray(rows) ? rows : []).find((candidate) => candidate.id === id);
      return row ? row.displayTitle || row.title || row.id : id;
    }

    /**
     * Read the session seat off `props.useSessions` without ever throwing.
     *
     * `useSessions` is a root-level hook contributed by
     * `dsh-client-ui-session`; it needs no inject and no require. When the
     * contribution is absent (`typeof !== 'function'`) or a call throws, the
     * picker degrades to a manual session id and says so on the page.
     * @param useSessions - the hook from props, or anything else.
     * @returns `{mode, currentId, rows, degraded, reason}`.
     */
    function readSessionSeat(useSessions) {
      if (typeof useSessions !== 'function') {
        return { mode: 'manual', currentId: '', rows: [], degraded: true, reason: 'no-hook' };
      }
      try {
        const decoded = decodeSessions(useSessions(sessionsProbeSelector));
        return {
          mode: 'sessions',
          currentId: decoded.currentId,
          rows: decoded.rows,
          degraded: false,
          reason: decoded.rows.length === 0 ? 'empty' : null,
        };
      } catch (error) {
        return {
          mode: 'manual',
          currentId: '',
          rows: [],
          degraded: true,
          reason: 'hook-threw',
          message: error && error.message ? String(error.message) : String(error),
        };
      }
    }

    /**
     * The single selector handed to the props `useWorkspaces` root hook.
     *
     * Shape confirmed by reading the installed 0.1.7-rc.2 package (NOTES §48):
     * `dsh-client-ui-workspace/lib/client.js:4137` contributes
     * `ctx.slots.provideRoot({hooks:{workspaces: workspaces.list}})`, which the
     * renderer synthesises into `useWorkspaces` for every root-scope slot
     * (`dsh-client-ui-renderer/lib/client.js:703-711`) — so, exactly like
     * `useSessions`, no inject and no require are needed. `WorkspaceSnapshot` is
     * `{items, archivedSessionIds, pinnedSessionIds, state, phase, error}`
     * (`dsh-api-workspace-controller/lib/types/client/model.d.ts`), and each
     * `WorkspaceView` is `{workspaceId, path, title, sessionIds, createdAt,
     * updatedAt}` (`.../lib/types/types.d.ts:19-33`).
     *
     * The payload is one compact string (the hook's equality check then sees a
     * stable value) laid out as four records:
     * `items \u001c pinned \u001c archived \u001c phase \u001c state`, where an item is
     * `workspaceId \u001f title \u001f path \u001f sessionIds(\u001d)`.
     * @param state - `WorkspaceSnapshot` (or anything shaped like it).
     * @returns the encoded string.
     */
    function workspacesProbeSelector(state) {
      const items = state && Array.isArray(state.items) ? state.items : [];
      const records = items.map((item) => {
        const workspace = item || {};
        const members = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
        return [
          flattenSessionField(workspace.workspaceId),
          flattenSessionField(workspace.title),
          flattenSessionField(workspace.path),
          members.map((id) => flattenSessionField(id)).join(SCOPE_ID_SEP),
        ].join(SESSION_FIELD_SEP);
      });
      const ids = (value) =>
        (Array.isArray(value) ? value : []).map((id) => flattenSessionField(id)).join(SCOPE_ID_SEP);
      return [
        records.join(SESSION_ROW_SEP),
        ids(state && state.pinnedSessionIds),
        ids(state && state.archivedSessionIds),
        state && typeof state.phase === 'string' ? state.phase : '',
        state && typeof state.state === 'string' ? state.state : '',
      ].join(SCOPE_RECORD_SEP);
    }

    /**
     * One-entry decode cache for {@link workspacesProbeSelector}, keyed by the
     * exact payload (a changed workspace list misses).
     */
    let workspaceDecodeKey = null;
    let workspaceDecodeValue = {
      items: [],
      pinned: [],
      archived: [],
      phase: '',
      state: '',
    };

    /**
     * Decode {@link workspacesProbeSelector}'s output. A payload with too few
     * records is unconformant and yields no workspaces rather than a fabricated
     * grouping.
     * @param encoded - the selector value.
     * @returns `{items: [{workspaceId, title, path, sessionIds}], pinned, archived, phase, state}`.
     */
    function decodeWorkspaces(encoded) {
      const empty = { items: [], pinned: [], archived: [], phase: '', state: '' };
      if (typeof encoded !== 'string' || encoded.length === 0) return empty;
      if (encoded === workspaceDecodeKey) return workspaceDecodeValue;
      const parts = encoded.split(SCOPE_RECORD_SEP);
      if (parts.length < 5) return empty;
      const splitIds = (value) => (value === '' ? [] : value.split(SCOPE_ID_SEP));
      const items = (parts[0] === '' ? [] : parts[0].split(SESSION_ROW_SEP))
        .map((record) => {
          const fields = record.split(SESSION_FIELD_SEP);
          return {
            workspaceId: fields[0] || '',
            title: fields[1] || '',
            path: fields[2] || '',
            sessionIds: splitIds(fields[3] || ''),
          };
        })
        .filter((workspace) => workspace.workspaceId.length > 0 || workspace.sessionIds.length > 0);
      workspaceDecodeKey = encoded;
      workspaceDecodeValue = {
        items,
        pinned: splitIds(parts[1] || ''),
        archived: splitIds(parts[2] || ''),
        phase: parts[3] || '',
        state: parts[4] || '',
      };
      return workspaceDecodeValue;
    }

    /**
     * Read the workspace seat off `props.useWorkspaces` without ever throwing.
     *
     * When the contribution is absent (`typeof !== 'function'`) or a call
     * throws, the picker degrades to the flat searchable list and says so on
     * the page — it never guesses a grouping.
     * @param useWorkspaces - the hook from props, or anything else.
     * @returns `{mode, items, pinned, archived, phase, state, degraded, reason}`.
     */
    function readWorkspaceSeat(useWorkspaces) {
      const base = { items: [], pinned: [], archived: [], phase: '', state: '' };
      if (typeof useWorkspaces !== 'function') {
        return { ...base, mode: 'degraded', degraded: true, reason: 'no-hook' };
      }
      try {
        const decoded = decodeWorkspaces(useWorkspaces(workspacesProbeSelector));
        return { ...decoded, mode: 'workspaces', degraded: false, reason: decoded.items.length === 0 ? 'empty' : null };
      } catch (error) {
        return {
          ...base,
          mode: 'degraded',
          degraded: true,
          reason: 'hook-threw',
          message: error && error.message ? String(error.message) : String(error),
        };
      }
    }

    /** Directory basename (both separators accepted), or '' when there is none. */
    function basenameOf(path) {
      const text = typeof path === 'string' ? path : '';
      const trimmed = text.replace(/[/\\]+$/, '');
      const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
      return trimmed.slice(separator + 1);
    }

    /**
     * Workspace node label: the workspace title, the localized name of the
     * product's default workspace, else the basename of its path — the same
     * precedence the sidebar uses (`workspaceDisplayTitle` +
     * `workspaceLabel`, `dsh-client-ui-workspace/lib/client.js:267-272`,
     * `:1053-1055`).
     * @param workspace - a decoded workspace item.
     * @param labels - `{defaultName, untitled}` already localized.
     * @returns the label text.
     */
    function workspaceLabelOf(workspace, labels) {
      const title = typeof workspace.title === 'string' ? workspace.title : '';
      if (title === 'default-workspace') return labels.defaultName;
      if (title.length > 0) return title;
      const base = basenameOf(workspace.path);
      return base.length > 0 ? base : workspace.path || labels.untitled;
    }

    /**
     * Project session ids by recency, newest first, id ascending as the
     * deterministic tie-break — copied verbatim from the sidebar's
     * `orderByRecency` (`dsh-client-ui-workspace/lib/client.js:278-298`).
     * @param ids - candidate ids.
     * @param byId - session rows by id.
     * @returns the ordered ids (unknown ids dropped).
     */
    function orderByRecency(ids, byId) {
      return ids
        .flatMap((id) => {
          const row = byId[id];
          if (row === undefined) return [];
          const rank = Number.isFinite(row.updatedAt) ? row.updatedAt : 0;
          return [{ id, rank }];
        })
        .sort((a, b) => {
          if (a.rank !== b.rank) return b.rank - a.rank;
          return a.id < b.id ? -1 : 1;
        })
        .map((member) => member.id);
    }

    /**
     * Order one group's members the way the sidebar does: recency order, the
     * selected provisional New Session first (`pinCurrentBlank`, :338-343),
     * then pinned rows ahead of the rest (`sectionMembers`, :373-386).
     * @param ids - the group's visible member ids.
     * @param byId - session rows by id.
     * @param pinned - the registry-global pin set.
     * @param currentId - the retained main-view session, if any.
     * @returns the ordered ids.
     */
    function scopeMemberOrder(ids, byId, pinned, currentId) {
      const recency = orderByRecency(ids, byId);
      const current = byId[currentId];
      const ordered =
        current !== undefined && current.blank === true && ids.indexOf(currentId) >= 0
          ? [currentId, ...recency.filter((id) => id !== currentId)]
          : recency;
      const placeholders = [];
      const leading = [];
      const rest = [];
      for (const id of ordered) {
        const row = byId[id];
        if (row.blank === true) placeholders.push(id);
        else if (pinned.has(id)) leading.push(id);
        else rest.push(id);
      }
      return [...placeholders, ...leading, ...rest];
    }

    /** Clamp one group's requested page size into its legal band. */
    function scopeGroupLimit(value) {
      if (!Number.isInteger(value)) return SCOPE_GROUP_PAGE;
      return Math.min(SCOPE_GROUP_MAX, Math.max(SCOPE_GROUP_PAGE, value));
    }

    /**
     * Derive the「查看范围」tree from the two root-hook seats.
     *
     * Grouping, ordering and visibility are copied from the product's own
     * workspace browser (`dsh-client-ui-workspace/lib/client.js`), so the picker
     * reads like the left sidebar:
     *   - groups follow the Host order of `WorkspaceSnapshot.items`, and the
     *     ungrouped bucket is appended last (`groupByWorkspace`, :418-437) —
     *     a session that belongs to no workspace is never dropped;
     *   - a session is listed unless it is subagent-origin, a non-selected
     *     blank row, or archived (`sessionVisible`, :358-372: the sidebar's
     *     default archived filter);
     *   - members are ordered by recency, then the selected blank row, then
     *     pinned rows (`orderByRecency` + `pinCurrentBlank` + `sectionMembers`).
     *
     * The tree is a **window** over the catalog, never a copy of it: at most
     * {@link SCOPE_GROUP_PAGE} session rows per expanded group, raised by
     * {@link SCOPE_GROUP_STEP} per 「显示更多」 up to {@link SCOPE_GROUP_MAX},
     * and at most {@link SCOPE_TOTAL_MAX} session rows plus
     * {@link SCOPE_GROUP_LIMIT} group headers overall. Groups without visible
     * members are dropped; the group holding the current session may add one
     * header beyond the limit so the default view always contains it.
     *
     * Search semantics: a non-empty query keeps only matching sessions **and
     * the workspace node that carries them** (every group with ≥1 match stays,
     * with its non-matching children dropped, and is forced open so the matches
     * are actually visible). A query that matches a workspace label or path
     * keeps every session of that workspace.
     * @param input - `{rows, currentId, workspaces, pinned, archived, query, expanded, limits, labels}`.
     * @returns the windowed tree plus its counters.
     */
    function deriveScope(input) {
      const rows = Array.isArray(input.rows) ? input.rows : [];
      const workspaces = Array.isArray(input.workspaces) ? input.workspaces : [];
      const currentId = typeof input.currentId === 'string' ? input.currentId : '';
      const needle = normalizeNeedle(input.query);
      const labels = input.labels && typeof input.labels === 'object' ? input.labels : {};
      const limits = input.limits && typeof input.limits === 'object' ? input.limits : {};
      const expanded = input.expanded && typeof input.expanded === 'object' ? input.expanded : {};
      const archived = new Set(Array.isArray(input.archived) ? input.archived : []);
      const pinned = new Set(Array.isArray(input.pinned) ? input.pinned : []);

      const byId = Object.create(null);
      for (const row of rows) byId[row.id] = row;

      const isVisible = (row) => {
        if (row.origin === 'subagent') return false;
        if (row.blank === true && row.id !== currentId) return false;
        if (archived.has(row.id)) return false;
        return true;
      };

      const accounted = new Set();
      for (const workspace of workspaces) {
        for (const id of workspace.sessionIds) accounted.add(id);
      }
      let currentGroupKey;
      if (currentId !== '') {
        const owner = workspaces.find((workspace) => workspace.sessionIds.indexOf(currentId) >= 0);
        currentGroupKey = owner ? owner.workspaceId : '';
      }

      const sections = workspaces.map((workspace) => ({
        key: workspace.workspaceId,
        workspaceId: workspace.workspaceId,
        path: workspace.path,
        label: workspaceLabelOf(workspace, labels),
        memberIds: workspace.sessionIds,
      }));
      const ungrouped = rows.map((row) => row.id).filter((id) => !accounted.has(id));
      if (ungrouped.length > 0) {
        sections.push({
          key: '',
          workspaceId: undefined,
          path: '',
          label: labels.ungrouped,
          memberIds: ungrouped,
        });
      }

      let total = 0;
      let matched = 0;
      let budget = SCOPE_TOTAL_MAX;
      let groupRows = 0;
      let archivedHidden = 0;
      let groupsSuppressed = 0;
      let truncated = false;
      const groups = [];
      const visible = [];

      for (const section of sections) {
        const known = [];
        for (const id of section.memberIds) {
          const row = byId[id];
          if (row === undefined) continue;
          if (!isVisible(row)) {
            archivedHidden += 1;
            continue;
          }
          known.push(id);
        }
        if (known.length === 0) continue;
        const ordered = scopeMemberOrder(known, byId, pinned, currentId);
        const labelText = `${section.label} ${section.path || ''}`.toLowerCase();
        const labelMatch = needle.length > 0 && labelText.indexOf(needle) >= 0;
        const matchedIds =
          needle.length === 0 || labelMatch
            ? ordered
            : ordered.filter((id) => sessionMatchesQuery(byId[id], needle));
        total += ordered.length;
        matched += matchedIds.length;
        // A search drops every group that carries no match: only the ancestors
        // of the matches survive.
        if (needle.length > 0 && matchedIds.length === 0) continue;

        const containsCurrent = currentGroupKey !== undefined && section.key === currentGroupKey;
        const explicit = expanded[section.key];
        const open =
          needle.length > 0
            ? matchedIds.length > 0
            : typeof explicit === 'boolean'
              ? explicit
              : containsCurrent;
        if (groupRows >= SCOPE_GROUP_LIMIT && !containsCurrent) {
          groupsSuppressed += 1;
          continue;
        }
        groupRows += 1;

        const limit = scopeGroupLimit(limits[section.key]);
        const windowIds = open ? matchedIds.slice(0, limit) : [];
        const room = Math.max(0, Math.min(windowIds.length, budget));
        const renderedIds = windowIds.slice(0, room);
        budget -= room;
        const hidden = open ? matchedIds.length - room : 0;
        if (open && room < windowIds.length) truncated = true;
        const sessions = renderedIds.map((id) => byId[id]);
        groups.push({
          key: section.key,
          workspaceId: section.workspaceId,
          path: section.path,
          label: section.label,
          total: ordered.length,
          matched: matchedIds.length,
          expanded: open,
          containsCurrent,
          hidden,
          limit,
          more: hidden > 0 && matchedIds.length > limit,
          sessions,
        });
        for (const row of sessions) visible.push(row);
      }

      return {
        groups,
        rows: visible,
        total,
        matched,
        shown: SCOPE_TOTAL_MAX - budget,
        archivedHidden,
        groupsShown: groupRows,
        groupsTotal: sections.length,
        groupsSuppressed,
        truncated,
        currentGroupKey,
      };
    }

    /** Effective layer of a section entry: 'default' | 'user' | 'workspace'. */
    function sectionLayer(section) {
      if (section && section.overrideLayer === 'user') return 'user';
      if (section && section.overrideLayer === 'workspace') return 'workspace';
      return 'default';
    }

    /** One of the four `origin` values, with a defensive fallback. */
    function originOf(section) {
      const origin = section ? section.origin : undefined;
      if (typeof origin === 'string' && ORIGINS.indexOf(origin) >= 0) return origin;
      return section && section.action === 'append' ? 'appended' : 'registered';
    }

    /** Localized label key for an origin value. */
    function originKey(origin) {
      if (origin === 'appended') return 'originAppended';
      if (origin === 'downstream-added') return 'originDownstream';
      if (origin === 'unmatched-override') return 'originUnmatched';
      return 'originRegistered';
    }

    /** Tag tone for an origin value; `downstream-added` is neutral, not a fault. */
    function originTone(origin) {
      if (origin === 'appended') return 'info';
      if (origin === 'unmatched-override') return 'warning';
      if (origin === 'downstream-added') return 'neutral';
      return 'outline';
    }

    /** Localized label key for one filter value (layer, overridable or origin). */
    function filterLabelKey(value) {
      if (value === 'user') return 'fUser';
      if (value === 'workspace') return 'fWorkspace';
      if (value === 'default') return 'fDefault';
      if (value === 'yes') return 'fYes';
      if (value === 'no') return 'fNo';
      if (value === 'all') return 'fAll';
      return originKey(value);
    }

    /** Localized label for a layer value. */
    function layerKey(layer) {
      if (layer === 'user') return 'fUser';
      if (layer === 'workspace') return 'fWorkspace';
      return 'fDefault';
    }

    /**
     * The three-state `frozenScope` presentation (CONTRACT.md §2.4, §7.2).
     *
     * - `frozenScope: "session"` → `frozen` describes the selected session;
     * - `frozenScope: "global"` **with** a selected session → the session's own
     *   state is *unknown*; this must never be presented as "not frozen";
     * - `frozenScope: "global"` without a session → it describes the global
     *   assembly.
     * @param snapshot - the snapshot payload, or null.
     * @param sessionSelected - whether the page is scoped to a session.

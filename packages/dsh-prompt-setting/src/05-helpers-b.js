// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。
     * @returns `{kind, scope, certain, frozen, reason, pending}`.
     */
    function frozenState(snapshot, sessionSelected) {
      if (!snapshot || typeof snapshot !== 'object') {
        return { kind: 'unknown', scope: 'none', certain: false, frozen: false, reason: null, pending: true };
      }
      const frozen = snapshot.frozen === true;
      const reason = snapshot.frozenReason ? String(snapshot.frozenReason) : null;
      if (snapshot.frozenScope === 'session') {
        return { kind: frozen ? 'frozen' : 'unfrozen', scope: 'session', certain: true, frozen, reason, pending: false };
      }
      if (sessionSelected) {
        return {
          kind: 'unknown',
          scope: 'global',
          certain: false,
          frozen,
          reason: snapshot.frozenScopeReason ? String(snapshot.frozenScopeReason) : null,
          pending: false,
        };
      }
      return { kind: frozen ? 'frozen' : 'unfrozen', scope: 'global', certain: true, frozen, reason, pending: false };
    }

    /** Localized copy for a frozen verdict. */
    function frozenKey(fz) {
      if (fz.kind === 'unknown') return 'stFrozenUnknown';
      if (fz.scope === 'session') return fz.frozen ? 'stFrozenSession' : 'stUnfrozenSession';
      return fz.frozen ? 'stFrozenGlobal' : 'stUnfrozenGlobal';
    }

    /**
     * Index a `[{name, hash}]` list by name, or `null` when it is not one.
     *
     * A malformed list is refused whole rather than half-read: comparing a
     * partial list would let a truncated answer look like a clean match.
     * @param list - anything.
     * @returns a `Map` from file name to digest, or `null`.
     */
    function chunkStampMap(list) {
      if (!Array.isArray(list)) return null;
      const map = new Map();
      for (const entry of list) {
        if (entry === null || typeof entry !== 'object') return null;
        const name = entry.name;
        const hash = entry.hash;
        if (typeof name !== 'string' || name.length === 0) return null;
        if (typeof hash !== 'string' || hash.length === 0) return null;
        map.set(name, hash);
      }
      return map;
    }

    /**
     * The build stamp's verdict, as the string the page exposes verbatim in
     * `data-build-match` (CONTRACT.md §14).
     *
     * Three states, and the asymmetry is the point: `'false'` requires a hash
     * on **both** sides and a difference. Every other case — no self-digest (an
     * engine that will not return the source), an old host without
     * `clientBuild`, a file whose region is unusable, a failed or unreachable
     * ping — is `'unknown'`. Rendering「过期」from a missing answer would send
     * the reader chasing a non-existent stale bundle, which is exactly the
     * confusion this feature exists to end.
     *
     * g-045 splits the bundle, so the main digest is no longer the whole
     * answer: the page's own chunks are *not* in `factory.toString()`. The
     * verdict therefore also compares, item by item, this file's manifest
     * ({@link CHUNK_STAMPS}, inside the region, hence inside `self`) with the
     * digests the host reports for the files it serves, and with the digest
     * every chunk this page has **really loaded** reported of itself. A host
     * that reports no chunk list at all (an old host) keeps the old answer;
     * a coverage gap — a chunk one side knows and the other does not — is
     * `'unknown'`, never「一致」.
     * @param boot - the `{self, server, pingFailed}` state.
     * @returns `'true'`, `'false'` or `'unknown'`.
     */
    function buildVerdict(boot) {
      const self = boot && boot.self && typeof boot.self.hash === 'string' ? boot.self.hash : null;
      const server = boot && boot.server && typeof boot.server.hash === 'string' ? boot.server.hash : null;
      if (self === null || server === null) return 'unknown';
      if (self !== server) return 'false';
      const loaded = loadedChunkStamps();
      const reportedList = boot && boot.server ? boot.server.chunks : null;
      if (reportedList === null || reportedList === undefined) {
        // An old host answers no chunk list: there is nothing to compare
        // against, and a page that has loaded no chunk has no evidence of its
        // own to contradict it. Once it has, the honest word is「未知」.
        return loaded.length === 0 ? 'true' : 'unknown';
      }
      // A list that is present but unreadable is refused **whole**: a half-read
      // answer could hide the one chunk that changed.
      const reported = Array.isArray(reportedList) ? chunkStampMap(reportedList) : null;
      if (reported === null) return 'unknown';
      const declared = chunkStampMap(CHUNK_STAMPS);
      if (declared === null || declared.size !== reported.size) return 'unknown';
      for (const [name, hash] of declared) {
        if (!reported.has(name)) return 'unknown';
        if (reported.get(name) !== hash) return 'false';
      }
      for (const entry of loaded) {
        if (!reported.has(entry.name)) return 'unknown';
        if (reported.get(entry.name) !== entry.hash) return 'false';
      }
      return 'true';
    }

    /**
     * The plugin version the page shows, taken from the ping's `version` field
     * (g-029) — the **only** source. This file carries no version literal of its
     * own: a second copy would be a second thing to keep in sync, which is
     * exactly the drift the display exists to end.
     *
     * `'unknown'` covers every way the same ping can fail to answer: no response
     * at all, a failed request, a body without `version`, a non-string value, or
     * a string that declares nothing — the empty string, or only whitespace. A
     * fabricated version here would be worse than none — the reader would be
     * told a version this build is not (CONTRACT.md §13.8).
     * @param boot - the `{self, server, version, pingFailed}` state.
     * @returns the version as the host reported it, or `'unknown'`.
     */
    function pluginVersionOf(boot) {
      const version = boot && boot.version;
      // Whitespace is not a declaration: `'   '` renders as「未知」rather than as
      // `v   `. A value that *does* carry text is returned byte for byte — a
      // legal version is never trimmed into a different one.
      return typeof version === 'string' && version.trim().length > 0 ? version : 'unknown';
    }

    /**
     * The repository the version links to (Revision 17), taken from the same
     * ping as the version itself — `repositoryUrl`, which the host derives from
     * its own `package.json`.
     *
     * `null` is the answer whenever the host reported none (an older host, a
     * failed ping, a non-string, or a blank one). The page then renders the
     * version as plain text: an anchor element with a guessed or empty `href`
     * would send
     * the reader somewhere no manifest ever pointed at.
     * @param boot - the `{self, server, version, repositoryUrl, pingFailed}` state.
     * @returns the repository URL as reported, or `null`.
     */
    function pluginRepositoryOf(boot) {
      const repository = boot && boot.repositoryUrl;
      return typeof repository === 'string' && repository.trim().length > 0 ? repository : null;
    }

    /**
     * Whether the edit controls must be disabled for a section.
     *
     * A section that cannot be overridden is always disabled. A frozen verdict
     * disables editing only when it is certain for the scope being viewed; the
     * `frozenScope: "global"` + session case warns instead of silently
     * allowing (CONTRACT.md §2.4: treat it as unknown, not as unfrozen).
     * @param section - the effective section entry, or null.
     * @param fz - the frozen presentation.
     * @param t - the bound translator.
     * @returns `{disabled, reasons, warn}`.
     */
    function editGate(section, fz, t) {
      const reasons = [];
      if (section && section.overridable === false) {
        reasons.push(section.reason ? String(section.reason) : t('editDisabledOverridable'));
      }
      if (fz.certain && fz.frozen) reasons.push(t('editDisabledFrozen'));
      return { disabled: reasons.length > 0, reasons, warn: !fz.certain && !fz.pending };
    }

    /**
     * The section names a real turn's waterfall already has when our listener
     * runs: the registered `base` names plus anything another listener added
     * before us (`origin: "downstream-added"`).
     *
     * A name our OWN `append` introduced is deliberately *not* here: the
     * override list is keyed by name, so re-saving that append is an upsert
     * that still takes effect (and blocking it would make an existing append
     * uneditable).
     * @param snapshot - the snapshot payload, or null.
     * @returns a Set of names.
     */
    function incomingNames(snapshot) {
      const names = new Set();
      if (!snapshot || typeof snapshot !== 'object') return names;
      const base = snapshot.base && Array.isArray(snapshot.base.sections) ? snapshot.base.sections : [];
      for (const section of base) {
        if (section && typeof section.name === 'string') names.add(section.name);
      }
      const effective =
        snapshot.effective && Array.isArray(snapshot.effective.sections) ? snapshot.effective.sections : [];
      for (const section of effective) {
        if (!section || typeof section.name !== 'string') continue;
        if (section.origin === 'appended') continue;
        if (section.origin === 'downstream-added') {
          names.add(section.name);
          continue;
        }
        // Defensive: a rendered section nothing overrides belongs to the
        // incoming assembly even if its `origin` is missing or unknown.
        if (
          section.index !== null &&
          section.index !== undefined &&
          section.overrideLayer === null &&
          section.action === null
        ) {
          names.add(section.name);
        }
      }
      return names;
    }

    /**
     * Whether one override would actually take effect, decided BEFORE the write
     * by the same two rules the Host's `applyOverrides` uses (CONTRACT §4.1):
     * `append` to a name already in the incoming assembly is skipped as
     * `name-already-present` (two sections may not share a name), and
     * `replace`/`hide` for a name that is not there is skipped as
     * `section-not-present`. A save that cannot take effect must never look
     * successful — that is the silent-invalidity mode this page exists to
     * prevent.
     * @param name - the requested section name.
     * @param action - 'replace' | 'hide' | 'append'.
     * @param incoming - the names {@link incomingNames} returned.
     * @returns `{blocked, code}`; `code` is null when the save may proceed.
     */
    function overrideFeasibility(name, action, incoming) {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (trimmed.length === 0) return { blocked: true, code: 'missing-name' };
      const present = incoming instanceof Set ? incoming.has(trimmed) : false;
      if (action === 'append') return present ? { blocked: true, code: 'name-already-present' } : { blocked: false, code: null };
      return present ? { blocked: false, code: null } : { blocked: true, code: 'section-not-present' };
    }

    /**
     * Localized, actionable copy for a blocked override.
     * @param t - the bound translator.
     * @param feasibility - the {@link overrideFeasibility} verdict.
     * @returns the display text.
     */
    function blockText(t, feasibility) {
      if (feasibility.code === 'missing-name') return t('blockMissingName');
      if (feasibility.code === 'name-already-present') return t('blockAppendExisting');
      return t('blockNotPresent');
    }

    /**
     * The real cause of an override that did not take effect, when the client
     * can prove it from the section names (the Host's own `reason` describes the
     * observation, not always the cause).
     * @param t - the bound translator.
     * @param entry - an `effective.sections` entry.
     * @param incoming - the names {@link incomingNames} returned.
     * @returns `{code, text}` or null when there is nothing provable to add.
     */
    function ineffectiveCause(t, entry, incoming) {
      if (!entry || entry.applied === true) return null;
      const feasibility = overrideFeasibility(entry.name, entry.action, incoming);
      if (!feasibility.blocked) return null;
      return { code: feasibility.code, text: blockText(t, feasibility) };
    }

    /** Split a text into lines without dropping a trailing empty line. */
    function splitLines(text) {
      return String(text === null || text === undefined ? '' : text).split('\n');
    }

    /** Number of non-overlapping case-insensitive occurrences. */
    function countMatches(text, query) {
      if (typeof query !== 'string' || query.length === 0) return 0;
      const haystack = String(text).toLowerCase();
      const needle = query.toLowerCase();
      let from = 0;
      let total = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) return total;
        total += 1;
        from = at + needle.length;
      }
    }

    /**
     * Split text into plain strings and highlighted `mark` nodes.
     * @param text - the text to render.
     * @param query - the search needle ('' = no highlight).
     * @returns an array of React children.
     */
    function highlightNodes(text, query) {
      const source = String(text);
      const needle = typeof query === 'string' ? query : '';
      if (needle.length === 0) return [source];
      const haystack = source.toLowerCase();
      const lower = needle.toLowerCase();
      const out = [];
      let cursor = 0;
      let index = 0;
      for (;;) {
        const at = haystack.indexOf(lower, cursor);
        if (at === -1) break;
        if (at > cursor) out.push(source.slice(cursor, at));
        out.push(
          h(
            'mark',
            {
              key: `hit-${index}`,
              'data-search-hit': 'true',
              style: { background: token.markFill, color: 'inherit', borderRadius: 3 },
            },
            source.slice(at, at + needle.length),
          ),
        );
        cursor = at + needle.length;
        index += 1;
      }
      if (cursor < source.length) out.push(source.slice(cursor));
      return out;
    }

    /**
     * Line-level common prefix/suffix trim: the cheap, honest way to point at
     * what actually changed between two section texts without an O(n·m) LCS on
     * a 50 KiB prompt.
     * @param baseText - the registered text.
     * @param effectiveText - the resulting text.
     * @returns `{base, effective}` — only the differing middle blocks.
     */
    function chunkDiff(baseText, effectiveText) {
      const a = splitLines(baseText);
      const b = splitLines(effectiveText);
      let prefix = 0;
      while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
      let suffix = 0;
      while (
        suffix < a.length - prefix &&
        suffix < b.length - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
      ) {
        suffix += 1;
      }
      return {
        base: a.slice(prefix, a.length - suffix),
        effective: b.slice(prefix, b.length - suffix),
      };
    }

    /**
     * Compare `base.sections` with `effective.sections` by name.
     * @param baseSections - `base.sections`.
     * @param effectiveSections - `effective.sections`.
     * @returns rows of `{name, status, base, effective}`.
     */
    function diffSections(baseSections, effectiveSections) {
      const base = Array.isArray(baseSections) ? baseSections : [];
      const effective = Array.isArray(effectiveSections) ? effectiveSections : [];
      const effectiveByName = new Map();
      for (const section of effective) effectiveByName.set(section.name, section);
      const seen = new Set();
      const rows = [];
      for (const section of base) {
        seen.add(section.name);
        const after = effectiveByName.get(section.name);
        if (!after) {
          rows.push({ name: section.name, status: 'removed', base: section, effective: null });
          continue;
        }
        const changed =
          String(after.text) !== String(section.text) || after.index === null || after.applied === true;
        rows.push({
          name: section.name,
          status: changed ? 'changed' : 'same',
          base: section,
          effective: after,
        });
      }
      for (const section of effective) {
        if (seen.has(section.name)) continue;
        rows.push({ name: section.name, status: 'added', base: null, effective: section });
      }
      return rows;
    }

    /** Localized label key for a diff status. */
    function diffKey(status) {
      if (status === 'changed') return 'diffChanged';
      if (status === 'added') return 'diffAdded';
      if (status === 'removed') return 'diffRemoved';
      return 'diffSame';
    }

    /** Tag tone for a diff status. */
    function diffTone(status) {
      if (status === 'changed' || status === 'added') return 'warning';
      if (status === 'removed') return 'danger';
      return 'outline';
    }

    /**
     * Recompose the final text from a filtered section list, honoring render
     * order and dropping suppressed (`index: null`) entries.
     * @param sections - `effective.sections`.
     * @param originFilter - one of the four origins, or 'all'.
     * @returns the joined text.
     */
    function composeSections(sections, originFilter) {
      return (Array.isArray(sections) ? sections : [])
        .filter((section) => section && section.index !== null && section.index !== undefined)
        .filter((section) => originFilter === 'all' || originOf(section) === originFilter)
        .map((section) => (typeof section.text === 'string' ? section.text : ''))
        .filter((text) => text.length > 0)
        .join('\n\n');
    }

    /**
     * The advisories one write/enable response carries (Revision 12, audit F2).
     *
     * Tolerant by construction: an older host has no `warnings` field at all, and
     * a malformed entry must not be able to blank the panel. Only entries with a
     * usable `name` survive, because that is what the copy names.
     * @param payload - a route payload, or anything else.
     * @returns `[{name, kind, message}]`, possibly empty.
     */
    function payloadWarnings(payload) {
      const list = payload && Array.isArray(payload.warnings) ? payload.warnings : [];
      return list
        .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.name === 'string' && entry.name.length > 0)
        .map((entry) => ({
          name: String(entry.name),
          kind: typeof entry.kind === 'string' ? entry.kind : 'undefined-value',
          message: typeof entry.message === 'string' ? entry.message : '',
        }));
    }

    /**
     * Turn a failed request into localized copy. Every documented `code` has a
     * dictionary entry; an unknown code still renders readable text plus the
     * raw code, never the code alone.
     * @param t - the bound translator.
     * @param error - `{code, message, status, network}`.
     * @returns the display string.
     */
    function errorText(t, error) {
      if (!error) return t('errUnknown');
      if (error.code) {
        const key = `error.${error.code}`;
        const text = safeT(t, key, '');
        // g-066: the locale lookup answers a miss with the key itself, so a
        // code with no entry would otherwise put `error.foo` on screen. Treat
        // "the answer is the key" as a miss and fall through to localized prose
        // (`errUnknown`) — the raw code still reaches the UI through the
        // banner's own `data-error-code` / `errCode` line.
        if (text.length > 0 && text !== key) return text;
      }
      if (error.network) return t('errNetwork');
      if (error.status) return fmt(t('errHttp'), { status: error.status });
      return t('errUnknown');
    }

    /**
     * One request, never throwing. Success requires `ok: true`, matching the
     * contract's shape for all four routes.
     * @param path - request path (may include a query string).
     * @param init - optional fetch init.
     * @returns `{ok, status, payload}` or `{ok: false, status, error}`.
     */
    async function requestJson(path, init) {
      try {
        const response = await fetch(path, {
          headers: { accept: 'application/json', ...(init && init.headers ? init.headers : {}) },
          ...(init || {}),
        });
        let text = '';
        try {
          text = await response.text();
        } catch {
          text = '';
        }
        let payload = null;
        try {
          payload = text.length > 0 ? JSON.parse(text) : null;
        } catch {
          payload = null;
        }
        if (response.ok && payload !== null && payload.ok === true) {
          return { ok: true, status: response.status, payload };
        }
        return {
          ok: false,
          status: response.status,
          error: {
            code: payload && typeof payload.code === 'string' ? payload.code : null,
            message:
              payload && typeof payload.message === 'string'
                ? payload.message
                : text.length > 0
                  ? text.slice(0, 300)
                  : '',
            status: response.status,
            network: false,
            // g-032: a refusal can carry a manual route ("update by hand"), and
            // it must survive the transport rather than be re-derived by every
            // caller.
            manual: payload && typeof payload.manual === 'object' ? payload.manual : null,
          },
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          error: {
            code: null,
            message: error && error.message ? String(error.message) : String(error),
            status: 0,
            network: true,
          },
        };
      }
    }

    /**
     * The switch's local mirror, read (g-030).
     *
     * Three answers, deliberately: `false` only for a real `'off'`, `true` for a
     * real `'on'`, and `null` for "this page does not know" — which is what a
     * missing `localStorage`, a privacy mode that throws on access, or a
     * hand-edited value must produce. `null` means "ask the Host once", never
     * "assume off" (that would silently disable a feature the user never
     * disabled) and never "assume on" (that would be a promise the mirror does
     * not hold).
     * @returns `true`, `false`, or `null`.
     */
    function readUpdatePref() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return null;
        const value = localStorage.getItem(UPDATE_PREF_KEY);
        return value === 'off' ? false : value === 'on' ? true : null;
      } catch {
        return null;
      }
    }

    /**
     * Remember the switch locally. Best-effort by design: a browser that refuses
     * storage loses an optimisation, not the setting — the Host already has it.
     * @param enabled - the state to mirror.
     */
    function writeUpdatePref(enabled) {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return;
        localStorage.setItem(UPDATE_PREF_KEY, enabled === true ? 'on' : 'off');
      } catch {
        // The mirror is an optimisation; a refusal is not an error.
      }
    }

    /**
     * g-043: one `GET`/`PUT /download-region` payload as this page's view state.
     *
     * Every field is copied defensively — an old Host that does not know this
     * route, a hand-edited answer and a region id from the future all have to
     * degrade to something renderable: an unknown id reads as `default`, an
     * address that is not a string as "no address", `detected` only as the Host's
     * own `true`. Nothing is inferred, because「自动判定」is a claim about what the
     * Host did and this page may not make it up.
     * @param payload - the response body, or anything else.
     * @returns the region view state.
     */
    function regionStateOf(payload) {
      const source = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      return {
        phase: 'ready',
        region: DOWNLOAD_REGIONS.includes(source.region) ? source.region : 'default',
        registry: typeof source.registry === 'string' && source.registry.length > 0 ? source.registry : null,
        custom: typeof source.custom === 'string' && source.custom.length > 0 ? source.custom : null,
        detected: source.detected === true,
        stored: source.stored === true,
        error:
          source.error !== null && typeof source.error === 'object' && typeof source.error.code === 'string'
            ? { code: source.error.code, message: typeof source.error.message === 'string' ? source.error.message : '' }
            : null,
      };
    }

    /**
     * Copy text, preferring the probe's own clipboard helper.
     * @param text - the text to copy.
     * @returns whether the copy succeeded.
     */
    async function copyText(text) {
      try {
        // NOT a component: `writeClipboard` is called as a function, so
        // `typeof === 'function'` stays the whole question here (g-063: the
        // `forwardRef`-aware probe is for exports React renders, not for this).
        if (primitives && typeof primitives.writeClipboard === 'function') {
          await primitives.writeClipboard(text);
          return true;
        }
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }
    // #endregion

// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。
      /**
       * Reconcile the「我的 Prompt」draft after an operation changed a layer's
       * stored text **behind the editor's back** (g-050: rollback, a whole-layer
       * reset, or an applied import).
       *
       * The box renders the draft while one exists (see `mineText`), so without
       * this the editor keeps showing text that is no longer the stored value and
       * the operation reads as «nothing happened». The two cases are deliberately
       * different:
       *   - a draft that still equals the stored text has nothing the user typed,
       *     so it is dropped and the editor follows the new value;
       *   - a draft that differs **is** unsaved work — it is kept, and the caller
       *     appends `mineDraftKept` to the notice instead of silently destroying
       *     the reader's text. §15.4's「no path clears what the user typed」is
       *     about exactly this second case.
       * @returns `true` when the editor follows the stored text, `false` when a
       *   differing draft was kept.
       */
      const settleMineDraft = () => {
        if (mineEntry === null) return true;
        const previous = mineStored === null ? '' : mineStored;
        if (mineEntry.text !== previous) return false;
        // g-058: the mode is part of the comparison. A draft that still matches
        // the stored text but states the *other* mode is unsaved work — dropping
        // it would take the user's mode choice off the screen.
        if (draftModeOf(mineEntry) !== (mineStoredMode ?? RESERVED_SECTION_DEFAULT_MODE)) return false;
        dropMineDraft(mineKey);
        return true;
      };

      const rollbackTo = async (pending) => {
        setBusy(true);
        const query = historyScopeQuery(historyLayer, historyScopeArg);
        const result = await requestJson(`${ROLLBACK_PATH}?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ layer: pending.layer ?? historyLayer, seq: pending.seq }),
        });
        setBusy(false);
        if (!result.ok) {
          setNotice({ tone: 'error', text: fmt(t('histRollbackFailed'), { reason: errorText(t, result.error) }) });
          return;
        }
        const followed = settleMineDraft();
        setNotice({
          tone: 'success',
          text: fmt(t('histRollbackDone'), { id: pending.id }) + (followed ? '' : ` ${t('mineDraftKept')}`),
        });
        resetHistoryView();
        setReload((value) => value + 1);
      };

      /**
       * Clear one whole layer (`DELETE …&reset=true`).
       *
       * g-073 (Revision 55): the workspace is the one **「高级」's own selector**
       * names, not the page's「查看范围」. The semantics are worth restating: on the
       * workspace layer this clears the **whole workspace file** — every session in
       * that workspace shares it — so the selector aims at a workspace, and which
       * member session stands for it changes nothing about what is cleared. The
       * user layer is global and reads no session at all.
       */
      const resetLayer = async (layer) => {
        setBusy(true);
        const result = await requestJson(`${OVERRIDES_PATH}?${layerQuery(layer, advancedScopeArg)}&reset=true`, { method: 'DELETE' });
        setBusy(false);
        if (!result.ok) {
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        const count = result.payload && typeof result.payload.count === 'number' ? result.payload.count : 0;
        const followed = settleMineDraft();
        setNotice({
          tone: 'success',
          text: (count > 0 ? fmt(t('resetDoneNotice'), { count }) : t('resetNoneNotice')) + (followed ? '' : ` ${t('mineDraftKept')}`),
        });
        setReload((value) => value + 1);
      };

      /**
       * Fetch the export document, hold its text, and try to download it.
       *
       * g-073 (Revision 55): the request carries **no** page scope. A backup is
       * not a view of one range — since Revision 53 it carries every layer's
       * overrides, every workspace layer, the preset library and the preferences
       * (§10) — so the page's「查看范围」has no business in it, and a document that
       * depended on which session happened to be selected could not be called a
       * backup. The host's `?session=` (still accepted) only ever located the one
       * workspace layer view it used to narrow the document to.
       */
      const exportNow = async () => {
        setBusy(true);
        const result = await requestJson(EXPORT_PATH);
        setBusy(false);
        if (!result.ok) {
          setTransfer((current) => ({ ...current, phase: 'error', error: result.error, plan: null }));
          setNotice({ tone: 'error', text: fmt(t('exportFailed'), { reason: errorText(t, result.error) }) });
          return;
        }
        // `ok` is this plugin's own liveness flag, not part of the document: a
        // downloaded file must be importable by anything that reads the schema.
        const document = { ...result.payload };
        delete document.ok;
        const text = JSON.stringify(document, null, 2);
        const fileName = exportFileName(document.exportedAt);
        const download = downloadText(text, fileName);
        // g-066: the failure reason is a dictionary lookup, not the browser's
        // own wording — `error.download-failed` is not a host rejection code,
        // so `errorText` falls back to the localized `errUnknown` and the
        // English phrase never reaches the notice.
        const downloadError = download.ok ? null : { code: download.code };
        setTransfer({
          phase: download.ok ? 'exported' : 'error',
          plan: null,
          error: downloadError,
          exportText: text,
          fileName,
        });
        setNotice({
          tone: download.ok ? 'success' : 'error',
          text: download.ok ? fmt(t('downloadDone'), { name: fileName }) : fmt(t('downloadFailed'), { reason: errorText(t, downloadError) }),
        });
      };

      /** Load an export document from a chosen file, when the file API exists. */
      const pickImportFile = async (event) => {
        const file = event && event.target && event.target.files ? event.target.files[0] : null;
        if (!file) return;
        if (typeof file.text !== 'function') {
          setTransfer((current) => ({
            ...current,
            phase: 'error',
            plan: null,
            error: { code: 'invalid-export', message: 'this browser cannot read a chosen file; paste the JSON instead' },
          }));
          return;
        }
        setBusy(true);
        try {
          const text = await file.text();
          setImportText(String(text));
          setTransfer((current) => ({ ...current, phase: 'idle', plan: null, error: null }));
        } catch (error) {
          setTransfer((current) => ({
            ...current,
            phase: 'error',
            plan: null,
            error: { code: 'invalid-export', message: error && error.message ? String(error.message) : String(error) },
          }));
        }
        setBusy(false);
      };

      /** Dry-run the pasted document: a preview, and provably no write. */
      const previewImport = async () => {
        const raw = String(importText).trim();
        if (raw.length === 0) {
          setNotice({ tone: 'error', text: t('importNeedText') });
          return;
        }
        try {
          JSON.parse(raw);
        } catch (error) {
          setTransfer((current) => ({
            ...current,
            phase: 'error',
            plan: null,
            error: { code: 'invalid-json', message: error && error.message ? String(error.message) : String(error) },
          }));
          return;
        }
        setTransfer((current) => ({ ...current, phase: 'previewing', error: null }));
        setBusy(true);
        const query = `dryRun=true&mode=${encodeURIComponent(importMode)}`;
        const result = await requestJson(`${IMPORT_PATH}?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        setBusy(false);
        if (!result.ok) {
          setTransfer((current) => ({ ...current, phase: 'error', error: result.error, plan: null }));
          return;
        }
        setTransfer((current) => ({ ...current, phase: 'preview', plan: result.payload, error: null }));
      };

      /** Perform the confirmed import. */
      const applyImport = async () => {
        const raw = String(importText).trim();
        setTransfer((current) => ({ ...current, phase: 'applying', error: null }));
        setBusy(true);
        const query = `mode=${encodeURIComponent(importMode)}`;
        const result = await requestJson(`${IMPORT_PATH}?${query}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        setBusy(false);
        if (!result.ok) {
          setTransfer((current) => ({ ...current, phase: 'error', error: result.error }));
          setNotice({ tone: 'error', text: `${errorText(t, result.error)} ${t('importUnchangedWarning')}` });
          return;
        }
        const totals = result.payload && result.payload.totals ? result.payload.totals : {};
        const count = (totals.added || 0) + (totals.replaced || 0) + (totals.removed || 0);
        setTransfer((current) => ({ ...current, phase: 'applied', plan: result.payload, error: null }));
        const followed = settleMineDraft();
        setNotice({
          tone: 'success',
          text: (result.payload && result.payload.unchanged === true
            ? t('importUnchangedNotice')
            : fmt(t('importAppliedNotice'), {
                written: result.payload && Array.isArray(result.payload.written) ? result.payload.written.length : 0,
                count,
              })) + (followed ? '' : ` ${t('mineDraftKept')}`),
        });
        setReload((value) => value + 1);
      };

      /**
       * Revision 9: open or close variable substitution for「我的 Prompt」.
       *
       * The switch is written to the **selected layer**, and the value sent is
       * the negation of the *effective* one the host reported: the button says
       * "turn it off" whenever this session interpolates, so a click always
       * produces the state the label promised — even when the effective value
       * came from the other layer (a workspace layer that states nothing
       * inherits the user layer).
       *
       * A refusal is the host's own words (usually `unresolvable-variable`,
       * naming the stored text the write face will not accept): the panel shows the code and
       * the message rather than a generic failure, because the fix is in the
       * text box right below.
       */
      const toggleMineInterpolate = async () => {
        const layer = mineLayer;
        if (layer === 'workspace' && sessionArg === null) {
          setMineInterpolate({ kind: 'error', error: { code: 'workspace-unresolved' } });
          setNotice({ tone: 'error', text: errorText(t, { code: 'workspace-unresolved' }) });
          return;
        }
        const next = !mineInterpolateOn;
        setMineInterpolate({ kind: 'saving', error: null });
        setBusy(true);
        // The two-valued spelling on purpose: this is the shortcut that goes
        // between ON and "unstated", which is what makes on→off an exact byte
        // revert (§16.7). The explicit OFF is a separate, deliberate choice and
        // lives on the three-state control below.
        const body = { enabled: next, layer };
        if (sessionArg !== null) body.session = sessionArg;
        const result = await requestJson(INTERPOLATE_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy(false);
        if (!result.ok) {
          setMineInterpolate({ kind: 'error', error: result.error });
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        const applied = result.payload && result.payload.interpolateCustom === true;
        setMineWarnings(payloadWarnings(result.payload));
        setMineInterpolate({ kind: 'saved', error: null });
        setNotice({
          tone: 'success',
          text: fmt(t('mineInterpolateSaved'), { state: t(applied ? 'mineInterpolateOn' : 'mineInterpolateOff') }),
        });
        setReload((value) => value + 1);
      };

      /**
       * Revision 12 (audit F4): state one of the three values for the selected
       * layer — `inherit` (the key is removed), `on` (`true`) or `off` (the
       * boolean `false`).
       *
       * This is the control that makes「显式关」reachable at all: the two-valued
       * toggle can only return a layer to unstated, so a workspace layer could
       * never close the switch the user layer had opened, and the panel showed
       * OFF while the session really inherited ON.
       * @param choice - `inherit` | `on` | `off`.
       */
      const setMineInterpolateState = async (choice) => {
        const layer = mineLayer;
        const state = choice === 'on' || choice === 'off' ? choice : 'inherit';
        if (layer === 'workspace' && sessionArg === null) {
          setMineInterpolate({ kind: 'error', error: { code: 'workspace-unresolved' } });
          setNotice({ tone: 'error', text: errorText(t, { code: 'workspace-unresolved' }) });
          return;
        }
        setMineInterpolate({ kind: 'saving', error: null });
        setBusy(true);
        const body = { state, layer };
        if (sessionArg !== null) body.session = sessionArg;
        const result = await requestJson(INTERPOLATE_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy(false);
        if (!result.ok) {
          setMineInterpolate({ kind: 'error', error: result.error });
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        setMineWarnings(payloadWarnings(result.payload));
        setMineInterpolate({ kind: 'saved', error: null });
        setNotice({
          tone: 'success',
          text: fmt(t('mineInterpolateStateSaved'), {
            state: t(
              state === 'on' ? 'mineInterpolateSetOn' : state === 'off' ? 'mineInterpolateSetOff' : 'mineInterpolateSetInherit',
            ),
          }),
        });
        setReload((value) => value + 1);
      };

      /**
       * g-062: turn the assembly-status notice on or off.
       *
       * One `PUT` of the boolean the Host stores in `preferences.json`, merged
       * with whatever else that document holds. The switch is the user's, so a
       * write failure is reported in the block rather than retried silently; the
       * page's own state is the Host's answer, never the wish.
       */
      const toggleAssemblyNotice = async () => {
        const next = assembly.enabled !== true;
        setAssembly((current) => ({ ...current, status: { kind: 'saving', error: null } }));
        setBusy(true);
        const result = await requestJson(ASSEMBLY_STATUS_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        });
        setBusy(false);
        if (!result.ok) {
          setAssembly((current) => ({ ...current, status: { kind: 'error', error: result.error } }));
          setNotice({ tone: 'error', text: `${t('assemblySaveFailed')} — ${errorText(t, result.error)}` });
          return;
        }
        const applied = result.payload !== null && typeof result.payload === 'object' && result.payload.enabled === true;
        setAssembly((current) => ({
          ...current,
          enabled: applied,
          data:
            current.data === null || typeof current.data !== 'object'
              ? current.data
              : { ...current.data, enabled: applied },
          status: { kind: 'saved', error: null },
        }));
        setNotice({ tone: 'success', text: t(applied ? 'assemblyEnabledNow' : 'assemblyDisabledNow') });
      };

      /**
       * 「我的 Prompt」 save: `PUT /prompt-setting/overrides` with the reserved
       * name and `replace`, which is the entire write face since Revision 7
       * (§4.1). The text is sent exactly as typed — trimming someone's prompt
       * would be a silent edit of the thing they are configuring — and a
       * workspace write without a session is refused here, with the same code
       * the Host would answer, instead of being sent to be rejected.
       *
       * g-056: it is also refused while the user has unsaved text in **another**
       * scope (`mineForeignDraft`). In that state the box is showing this
       * target's *stored* text, so sending it would be the silently-successful
       * overwrite with `""` this goal exists to remove — the request is not sent
       * at all, and the notice names the scope that really holds the text.
       */
      const saveMine = async () => {
        const layer = mineLayer;
        if (layer === 'workspace' && sessionArg === null) {
          // The host would answer exactly this; refusing here keeps a known
          // answer from being turned into a round trip.
          setMineStatus({ kind: 'error', error: { code: 'workspace-unresolved' } });
          setNotice({ tone: 'error', text: errorText(t, { code: 'workspace-unresolved' }) });
          return;
        }
        if (mineForeignDraft !== null) {
          setMineStatus({ kind: 'idle', error: null });
          setNotice({
            tone: 'error',
            text: fmt(t('mineSaveBlockedDraftElsewhere'), {
              scope: draftScopeNameOf(mineForeignDraft.scope),
              chars: mineForeignDraft.text.length,
            }),
          });
          return;
        }
        setMineStatus({ kind: 'saving', error: null });
        setBusy(true);
        const body = {
          layer,
          // g-058: the mode travels with the text in the same one entry — the
          // body still names one layer, so the other layer's file is not part of
          // this request at all.
          section: { name: RESERVED_SECTION_NAME, action: mineMode, text: mineText },
        };
        if (sessionArg !== null) body.session = sessionArg;
        const result = await requestJson(OVERRIDES_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy(false);
        if (!result.ok) {
          setMineWarnings([]);
          setMineStatus({ kind: 'error', error: result.error });
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        // Keep the draft: it is what was just written, so the box does not
        // flicker back to the stored value while the re-read is in flight — and
        // `baseline` records that this page really wrote exactly this text there,
        // so the kept draft is never later reported as unsaved work (R1).
        setMineDrafts((current) => ({
          ...current,
          [mineKey]: { text: mineText, mode: mineMode, scope: mineScope, baseline: mineText, baselineMode: mineMode },
        }));
        // Revision 12 (audit F2): an accepted save may still carry advisories —
        // a registered reference the probe had no value for. They are shown, not
        // dropped, and they are not an error: the write did happen.
        setMineWarnings(payloadWarnings(result.payload));
        setMineStatus({ kind: 'saved', error: null });
        // g-021: the write succeeded, so the banner stays a success banner — but
        // in a frozen scope it may not read as bare success either. The notice is
        // the most visible surface on the page, so it carries the same condition
        // the panel's state line does.
        setNotice({
          tone: 'success',
          text: fmt(
            t(
              mineFrozenReason === null
                ? 'savedNotice'
                : mineFrozenCertain
                  ? 'savedNoticeFrozen'
                  : 'savedNoticeUnknown',
            ),
            { layer: layerLabel(t, layer) },
          ),
        });
        setReload((value) => value + 1);
      };

      /**
       * g-027: 「取消」 for 「我的 Prompt」 — drop the unsaved draft so the box
       * shows the layer's already stored text again. It is deliberately not a
       * write: no request, no disk byte, and unlike 「恢复默认」 nothing that was
       * ever stored is destroyed, so it asks nothing first. Resetting the draft
       * is the whole operation: a draft belongs to one **write target**
       * (`mineKey`, g-056), so a draft typed for another key is left where it
       * is, and the state falls back to whatever the stored value says (`idle`,
       * or `unconfigured` for a layer that has none). Only reachable while the
       * panel is `dirty`, which excludes `saving` / `saved` / `error`.
       */
      const cancelMine = () => {
        dropMineDraft(mineKey);
      };

      /**
       * g-056: throw away the draft that belongs to **another** scope, so the
       * save above can go through. It is the explicit way out of the block —
       * like「取消」 it is a local state reset (no request, no byte), and it is
       * only offered beside the notice that names the scope being dropped. R2/R3:
       * it names the exact target it drops rather than clearing the store.
       */
      const dropForeignDraft = () => {
        if (mineForeignDraft === null) return;
        dropMineDraft(mineForeignDraft.key);
      };

      /**
       * 「恢复默认」 for 「我的 Prompt」: the single-name `DELETE`, which since
       * Revision 7 is exactly the reserved section. Confirmed first (§12.1): it
       * destroys text the user wrote.
       */
      const resetMine = async () => {
        const layer = mineLayer;
        setMineStatus({ kind: 'saving', error: null });
        setBusy(true);
        const query = `${layerQuery(layer, sessionArg)}&name=${encodeURIComponent(RESERVED_SECTION_NAME)}`;
        const result = await requestJson(`${OVERRIDES_PATH}?${query}`, { method: 'DELETE' });
        setBusy(false);
        if (!result.ok) {
          setMineStatus({ kind: 'error', error: result.error });
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        // R3: only **this** write target's draft goes with the value it deleted;
        // another target's unsaved text is not this operation's to destroy.
        dropMineDraft(mineKey);
        setMineStatus({ kind: 'idle', error: null });
        setNotice({
          tone: 'success',
          text: fmt(t('deletedNotice'), { layer: layerLabel(t, layer) }),
        });
        setReload((value) => value + 1);
      };

      /**
       * Clear one layer's frozen (non-reserved) overrides: `legacy=true`, which
       * keeps 「我的 Prompt」 (§12.2). The same shape as the layer reset, one
       * flag apart, so the two share this reporting path.
       */
      const clearLegacy = async (layer) => {
        setBusy(true);
        const result = await requestJson(`${OVERRIDES_PATH}?${layerQuery(layer, advancedScopeArg)}&legacy=true`, { method: 'DELETE' });
        setBusy(false);
        if (!result.ok) {
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        const count = result.payload && typeof result.payload.count === 'number' ? result.payload.count : 0;
        setNotice({
          tone: 'success',
          text: count > 0 ? fmt(t('resetDoneNotice'), { count }) : t('resetNoneNotice'),
        });
        setReload((value) => value + 1);
      };

      /**
       * Close the「查看范围」picker after a scope was actually chosen (g-016):
       * picking a row, the current session, a typed id or 「全局」 is the end of
       * that interaction, so the summary comes back without a second click. It
       * is deliberately *not* called by the search box, the group headers or
       * 「显示更多」 — those browse the picker, they do not finish with it.
       */
      /**
       * g-043: read the stored「下载区域」— and, on the first visit ever, let the
       * Host decide it by availability. One `GET`; a failure leaves the previous
       * answer alone and says nothing (this is a read-out, not a task).
       *
       * The Host's answer is copied into the view state field by field, so
       * nothing on screen is invented here: an unknown region id reads as
       *「默认」, a non-string address as「no address」, `detected` only as the
       * Host's own boolean.
       */
      const loadRegion = async () => {
        const result = await requestJson(DOWNLOAD_REGION_PATH);
        if (!result.ok) {
          setUpdate((current) => ({ ...current, region: { ...(current.region ?? {}), phase: 'error' } }));
          return;
        }
        setUpdate((current) => ({ ...current, region: regionStateOf(result.payload) }));
      };

      /**
       * g-043: send one region choice and fold the Host's answer back into the
       * card. Returns the transport result so the dialog can decide whether to
       * close: `ok:true` means the choice is in force *now*, and anything else
       * means nothing was written.
       *
       * A successful switch drops the previous check's fact (`data` / `check`):
       * it was an answer from the **old** source, and leaving it would let the
       * banner announce a version the new source may not even carry — the
       * 「install this」button would then install the old source's artifact while
       * the dropdown said otherwise. The re-check below refills it from the new
       * source.
       */
      const saveRegion = async (body) => {
        const previous = update.region !== null && update.region !== undefined && update.region.phase === 'error' ? 'error' : 'ready';
        setUpdate((current) => ({ ...current, region: { ...(current.region ?? {}), phase: 'saving' } }));
        setBusy(true);
        const result = await requestJson(DOWNLOAD_REGION_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy(false);
        if (!result.ok) {
          // Nothing was written: the control must keep showing the source that is
          // actually in force, and the region's phase returns to what it was.
          setUpdate((current) => ({ ...current, region: { ...(current.region ?? {}), phase: previous } }));
          return result;
        }
        setUpdate((current) => ({ ...current, region: regionStateOf(result.payload), data: null, check: null, dismissed: false }));
        if (update.enabled !== false) await recheckUpdate();
        return result;
      };

      /**
       * g-043: the dropdown's own `change`. `default` / `cn` are saved straight
       * away — there is nothing to type and nothing to validate. `custom` only
       * **opens the dialog**: the address is not a choice the dropdown can
       * express, and saving the word「自定义」without an address would leave the
       * npm path unusable.
       */
      const setDownloadRegion = async (event) => {
        const wanted = event && event.target ? String(event.target.value) : '';
        if (wanted === 'custom') {
          setRegionDialog({
            value:
              update.region !== null && update.region !== undefined && typeof update.region.custom === 'string'
                ? update.region.custom
                : '',
            error: null,
            phase: 'idle',
          });
          return;
        }
        if (wanted !== 'default' && wanted !== 'cn') return;
        const result = await saveRegion({ region: wanted });
        if (result.ok) {
          setNotice({ tone: 'success', text: fmt(t('updateRegionSaved'), { region: t(regionKey(wanted, '')) }) });
          return;
        }
        setNotice({ tone: 'error', text: errorText(t, result.error) });
      };

      /** g-043: the dialog's field. Typing clears the red line. */
      const setRegionCustomValue = (event) => {
        const value = event && event.target ? String(event.target.value) : '';
        setRegionDialog((current) => (current === null ? null : { ...current, value, error: null }));
      };

      /** g-043: close the dialog without writing anything. */
      const cancelRegionCustom = () => setRegionDialog(null);

      /**
       * g-043: submit the typed address. The Host validates **before** it writes,
       * so:
       *   - `ok:true` ⇒ the dialog closes and the new source is already in force;
       *   - `ok:false` ⇒ the dialog **stays open** with the Host's code rendered
       *     as a red line inside it, and the saved value is untouched. The page
       *     notice is deliberately *not* used: it renders behind the overlay.
       * A transport failure (no answer at all) is the same red line with the
       * page's own network copy.
       */
      const submitRegionCustom = async () => {
        const dialog = regionDialog;
        if (dialog === null) return;
        const address = String(dialog.value ?? '').trim();
        setRegionDialog((current) => (current === null ? null : { ...current, phase: 'saving', error: null }));
        const result = await saveRegion({ region: 'custom', registry: address });
        if (result.ok) {
          setRegionDialog(null);
          setNotice({ tone: 'success', text: fmt(t('updateRegionSaved'), { region: t(regionKey('custom', '')) }) });
          return;
        }
        setRegionDialog((current) => (current === null ? null : { ...current, phase: 'idle', error: result.error }));
      };

      /**
       * g-030: run the update check again, bypassing the Host's six-hour cache
       * (`?force=1`). The button that calls this is only rendered while the
       * switch is on, so "check now" can never be the thing that re-enables a
       * feature the user turned off.
       *
       * A failure is silent on the main page (this is a background question, not
       * a task the user asked for). Inside 「高级」 the card distinguishes the two
       * cases it can be in: a **failed** check leaves the last successful answer
       * (or nothing) on screen, while a **successful** `hasUpdate:null` gets the
       * plain-language explanation that upstream had nothing to compare against
       * (`renderUpdateSetting`, in the 「高级」 chunk `client.advanced.js`).
       */
      const recheckUpdate = async () => {
        setUpdate((current) => ({ ...current, phase: 'checking' }));
        const result = await requestJson(`${UPDATE_CHECK_PATH}?force=1`);
        if (!result.ok) {
          setUpdate((current) => ({ ...current, phase: 'error' }));
          return;
        }
        const enabled = result.payload.enabled !== false;
        writeUpdatePref(enabled);
        setUpdate((current) => ({
          ...current,
          enabled,
          data: result.payload.hasUpdate === true && typeof result.payload.latest === 'string' ? result.payload : null,
          check: result.payload,
          dismissed: false,
          phase: 'ready',
        }));
      };

      /**
       * g-030: open or close the upstream update check.
       *
       * The value sent is the negation of the state the Host last reported, so
       * one click always produces the state the label promised. Turning it **on**
       * runs one immediate check (there is nothing to show otherwise, and the
       * user just asked for it); turning it **off** writes the preference and
       * stops — no further request is made by this page for the rest of the
       * session, and the next mount skips the round trip entirely through the
       * local mirror.
       */
      const toggleUpdate = async () => {
        const next = update.enabled === false;
        setUpdate((current) => ({ ...current, phase: 'saving' }));
        setBusy(true);
        const result = await requestJson(UPDATE_CHECK_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        });
        setBusy(false);
        if (!result.ok) {
          setUpdate((current) => ({ ...current, phase: 'error' }));
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        const enabled = result.payload && result.payload.enabled === false ? false : true;
        writeUpdatePref(enabled);
        // The switch changed, so the previous check's fact is stale: it is
        // dropped, and turning the switch on immediately asks again below. The
        // g-032 install state is **kept**: a switch flip is not an install, and
        // forgetting a running one would strand it with no cancel button.
        setUpdate((current) => ({ ...current, enabled, data: null, check: null, dismissed: false, phase: 'ready' }));
        setNotice({
          tone: 'success',
          text: fmt(t('updateToggleSaved'), { state: t(enabled ? 'updateSettingOn' : 'updateSettingOff') }),
        });
        if (enabled) {
          // g-043: a mount that ran while the switch was off asked the region
          // nothing at all (the zero-request promise), so the first thing the
          // switch being turned back on has to fetch is the region — which is
          // also where the first-visit availability detection happens.
          if (update.region === null || update.region === undefined) await loadRegion();
          await recheckUpdate();
        }
      };

      /**
       * g-032:「立即更新」— the three actions the banner and 「高级」 share.
       *
       * The install is the **host's** work: this page starts it, polls it and can
       * cancel it, and it never fakes a phase locally. Everything on screen comes
       * from `GET /update-apply`, which is the only record that survives the
       * official manager deleting a settled request.
       */

      /** Where one install's request id is remembered across a page reload. */
      const UPDATE_APPLY_STORE_KEY = 'dsh-prompt-setting.updateApply';
      /** How long a remembered id is still worth resuming. */
      const UPDATE_APPLY_RESUME_MS = 30 * 60 * 1000;

      /**
       * The two helpers behind the reload-resume, defined before their readers.
       *
       * `sessionStorage` (not `localStorage`) on purpose: this is one tab's
       * in-flight work, and a second tab opened later must not adopt it. Both
       * sides are best-effort — a browser that refuses storage loses the resume,
       * never the install, which the **host** is running either way.
       */
      const rememberApply = (requestId, startedAt) => {
        try {
          if (typeof sessionStorage === 'undefined' || sessionStorage === null) return;
          if (requestId === null) sessionStorage.removeItem(UPDATE_APPLY_STORE_KEY);
          else sessionStorage.setItem(UPDATE_APPLY_STORE_KEY, JSON.stringify({ requestId, at: startedAt ?? Date.now() }));
        } catch {
          // A browser that refuses storage only loses the reload-resume.
        }
      };

      /** Read back the remembered install, if it is recent enough to be one. */
      const recalledApply = () => {
        try {
          if (typeof sessionStorage === 'undefined' || sessionStorage === null) return null;
          const raw = sessionStorage.getItem(UPDATE_APPLY_STORE_KEY);
          if (typeof raw !== 'string' || raw.length === 0) return null;
          const parsed = JSON.parse(raw);
          const requestId = parsed !== null && typeof parsed.requestId === 'string' ? parsed.requestId : null;
          const at = Number.isFinite(parsed?.at) ? parsed.at : 0;
          if (requestId === null || Date.now() - at > UPDATE_APPLY_RESUME_MS) return null;
          return { requestId, at };
        } catch {
          return null;
        }
      };

      /**
       * Resume an install that was already running when this page mounted.
       *
       * This is why the host tracks its own request table and answers a bare
       * `GET`: the official manager deletes a settled request, and a page that
       * was reloaded mid-install has no id in memory. The remembered id is tried
       * first (it is exact), then the host's own oldest live request — the one
       * request that can only name an install this mount started.
       *
       * Runs once per mount, deliberately: its own polling must not be restarted
       * by the state it writes.
       */
      React.useEffect(() => {
        let cancelled = false;
        const resume = async () => {
          const remembered = recalledApply();
          let status = null;
          if (remembered !== null) {
            const result = await requestJson(`${UPDATE_APPLY_PATH}?requestId=${encodeURIComponent(remembered.requestId)}`);
            if (cancelled) return;
            status = result.ok ? result.payload.status ?? null : null;
            if (status === null || status.status !== 'running') {
              // The remembered id settled (or is gone). The host's **bare** `GET`
              // only ever names a *running* install, so it can add a fact here —
              // it can never replace one: a remembered `done`
              // (`restart-required`) must survive the `null` this probe answers,
              // or the page would drop「已安装 vX.Y.Z，请手动重启」and offer the
              // update button again for a version that is already installed.
              const live = await requestJson(UPDATE_APPLY_PATH);
              if (cancelled) return;
              const fresh = live.ok ? live.payload.status ?? null : null;
              status = fresh ?? status;
            }
          } else {
            const live = await requestJson(UPDATE_APPLY_PATH);
            if (cancelled) return;
            status = live.ok ? live.payload.status ?? null : null;
          }
          if (cancelled || status === null || status.status !== 'running') {
            if (!cancelled && status !== null && status.status !== 'running') {
              setUpdate((current) => ({ ...current, apply: status, applyElapsed: null }));
            }
            return;
          }
          const startedAt = Date.now();
          rememberApply(status.requestId, startedAt);
          setUpdate((current) => ({ ...current, apply: status, applyElapsed: 0, applyStartedAt: startedAt }));
          await pollApply(status.requestId, startedAt);
        };
        void resume();
        return () => {
          cancelled = true;
        };
      }, []);

      /** The elapsed-time ticker, so「已用时」is a fact rather than a decoration. */
      React.useEffect(() => {
        const startedAt = update.applyStartedAt;
        if (!Number.isFinite(startedAt)) return undefined;
        const timer = setInterval(() => setUpdate((current) => ({ ...current, applyElapsed: Date.now() - startedAt })), 1000);
        return () => clearInterval(timer);
      }, [update.applyStartedAt]);

      /**
       * Poll one install until it settles.
       *
       * The loop is bounded twice — the host's own worst case (a lock wait plus
       * pnpm's silence timeout) and a hard budget — so a tab cannot poll forever
       * after the host went away. A 「not known any more」 answer is a real ending,
       * not a reason to keep asking: the copy says what it means.
       *
       * `cancelled` is a local flag rather than a React state read, because this
       * function is captured by a promise that outlives the render that started
       * it.
       */
      const pollApply = async (requestId, startedAt) => {
        let delay = UPDATE_APPLY_POLL_MS;
        while (Date.now() - startedAt < UPDATE_APPLY_POLL_BUDGET_MS) {
          const result = await requestJson(`${UPDATE_APPLY_PATH}?requestId=${encodeURIComponent(requestId)}`);
          if (!result.ok) {
            setUpdate((current) => ({
              ...current,
              apply: { status: 'failed', phase: 'failed', error: result.error ?? {} },
            }));
            rememberApply(null);
            return;
          }
          const status = result.payload.status ?? null;
          if (status === null) {
            setUpdate((current) => ({ ...current, apply: { status: 'unknown', phase: 'unknown' } }));
            rememberApply(null);
            return;
          }
          setUpdate((current) => ({
            ...current,
            apply: status,
            applyElapsed: Date.now() - startedAt,
          }));
          if (status.status !== 'running') {
            rememberApply(null);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(Math.round(delay * 1.4), UPDATE_APPLY_POLL_MAX_MS);
        }
        // The budget ran out with the host still reporting "running": stop
        // asking, and say so rather than pretending to know.
        setUpdate((current) => ({ ...current, apply: { status: 'unknown', phase: 'unknown' } }));
        rememberApply(null);
      };

      /**
       * Start one install. Never awaited by a click handler for longer than the
       * host's own start route — that route answers with a `requestId` before the
       * package manager runs, which is the whole reason it exists.
       */
      const startUpdateApply = async (latest, latestTag) => {
        setBusy(true);
        setNotice(null);
        const result = await requestJson(UPDATE_APPLY_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(latestTag === null || latestTag === undefined ? {} : { tag: latestTag }),
        });
        setBusy(false);
        if (!result.ok) {
          // A structured refusal (`no update`, a `link:` profile, no plugin
          // manager) arrives here, because this page's transport treats a body
          // whose `ok` is not `true` as the failure it is. The **host's own
          // sentence** is what the user needs; `errorText` falls back to it
          // rather than to the code, so nothing renders as
          // `error.development-link`.
          const failure = result.error ?? {};
          const reason = typeof failure.message === 'string' && failure.message.length > 0 ? failure.message : null;
          setNotice({ tone: 'error', text: reason ?? errorText(t, failure) });
          setUpdate((current) => ({
            ...current,
            apply: {
              status: 'failed',
              phase: 'failed',
              requestId: current.apply === null ? null : current.apply.requestId,
              version: current.apply === null ? null : current.apply.version,
              tag: current.apply === null ? null : current.apply.tag,
              error: { code: failure.code ?? null, message: reason, manual: failure.manual },
            },
          }));
          return;
        }
        const status = result.payload.status ?? null;
        const requestId = status === null ? null : status.requestId;
        if (result.payload.reused === true) setNotice({ tone: 'info', text: t('updateApplyReused') });
        // The profile already held exactly this artifact, so the host answered a
        // finished `restart-required` without calling the package manager at all.
        // There is nothing to poll and nothing to wait for: saying so and showing
        // the install state is the whole response (a real desktop run turned this
        // case into 「安装失败」 before, because `pnpm add` on an unchanged
        // dependency makes the manager throw `ambiguous-install`).
        if (result.payload.alreadyInstalled === true) {
          setUpdate((current) => ({ ...current, apply: status, applyElapsed: null }));
          const version = status !== null && typeof status.version === 'string' ? status.version : '';
          setNotice({ tone: 'success', text: fmt(t(updateApplyCopyKey('already', normalizeLaunchKind(boot.launchKind))), { version }) });
          return;
        }
        if (requestId === null || requestId === undefined) {
          setUpdate((current) => ({ ...current, apply: { status: 'unknown', phase: 'unknown' } }));
          return;
        }
        const startedAt = Date.now();
        rememberApply(requestId, startedAt);
        setUpdate((current) => ({ ...current, apply: status, applyElapsed: 0, applyStartedAt: startedAt }));
        await pollApply(requestId, startedAt);
      };

      /**
       * The confirmation the button opens; the install itself runs on confirm.
       *
       * `latest` is **display only** (the modal names the version). The tag that
       * is actually installed is re-read from the current check when the
       * confirmation is accepted, so a stale click cannot install a version the
       * banner no longer names — which is why no tag is passed through here.
       */
      const requestUpdateApply = (latest) => setConfirm({ kind: 'update-apply', latest });

      /** Confirm: start it, using the version the check reported. */
      const confirmUpdateApply = async () => {
        const data = update.data;
        const latest = data !== null && typeof data.latest === 'string' ? data.latest : null;
        if (latest === null) {
          setNotice({ tone: 'error', text: t(updateApplyCopyKey('unknownState', normalizeLaunchKind(boot.launchKind))) });
          return;
        }
        await startUpdateApply(latest, data.latestTag ?? null);
      };

      /** Cancel: ask the host, which forwards it to the plugin manager. */
      const cancelUpdateApply = async () => {
        const apply = update.apply ?? null;
        const requestId = apply === null ? null : apply.requestId;
        if (requestId === null || requestId === undefined) return;
        setUpdate((current) => ({
          ...current,
          apply: current.apply === null ? null : { ...current.apply, phase: 'cancelling' },
        }));
        const result = await requestJson(UPDATE_APPLY_CANCEL_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId }),
        });
        if (!result.ok || result.payload.ok !== true) {
          // The poll is the source of truth and will report whatever really
          // happened; a refused cancel says so on the notice line.
          setNotice({ tone: 'error', text: errorText(t, result.error) || (result.payload && result.payload.code) || t(updateApplyCopyKey('unknownState', normalizeLaunchKind(boot.launchKind))) });
        }
      };

      /** Retry a failed install: same confirm, same route, new request id. */
      const retryUpdateApply = async () => {
        setUpdate((current) => ({ ...current, apply: null, applyElapsed: null, applyStartedAt: null }));
        await confirmUpdateApply();
      };

      const closeScope = () => setScopeOpen(false);

      /**
       * g-058 (Revision 36): write one of the editor's two facts into this
       * target's draft, leaving the other as it was.
       *
       * Both editors — the text box and the「覆盖 / 叠加」control — produce the
       * same draft shape (`{text, mode, scope, baseline, baselineMode}`), and
       * neither may erase the other's edit: typing must not reset the mode to
       * the stored one, and choosing a mode must not blank the text. The
       * fallback for whichever field the patch omits is **what the box is
       * showing now** — the existing draft when there is one, this target's
       * stored value otherwise — so a mode switch on an untouched box produces a
       * draft that differs from the file in exactly one field.
       *
       * `baseline`/`baselineMode` record what this page last **wrote** to this
       * target and are carried across edits (g-056 R1).
       * @param patch - `{text?}` or `{mode?}`.
       */
      const updateMineDraft = (patch) => {
        setMineDrafts((current) => {
          const existing = current[mineKey] ?? null;
          const text = patch.text !== undefined
            ? patch.text
            : existing === null
              ? (mineStored === null ? '' : mineStored)
              : existing.text;
          const mode = patch.mode !== undefined
            ? patch.mode
            : existing === null
              ? (mineStoredMode ?? RESERVED_SECTION_DEFAULT_MODE)
              : draftModeOf(existing);
          return {
            ...current,
            [mineKey]: {
              text,
              mode,
              scope: mineScope,
              baseline: existing === null ? null : existing.baseline ?? null,
              baselineMode: existing === null ? null : existing.baselineMode ?? null,
            },
          };
        });
      };

      /**
       * g-060 (Revision 37): the preset library's writes.
       *
       * Five actions, and the split is exactly the host's (`CONTRACT.md` §20):
       * three go to the catalogue (`PUT` / `DELETE`, plus the `GET` a refresh
       * re-runs) and two to the layer (`apply` / `unapply`). The catalogue
       * actions never name a layer; the two layer actions always send the
       * `session` of the picked workspace, because that is the only identity the
       * host can resolve a workspace root from (§4.2).
       *
       * Every write goes through `requestJson`, so a refusal arrives as
       * `{ok: false, code, message}` and is rendered by the same
       * `errorText` mapping the rest of the page uses. A write that succeeds
       * bumps `reload`, which re-reads the library and both layer views — the
       * same "write, then re-read" shape every other write on this page has.
       */
      // g-082: the library's tag set, read off the same `GET /presets` payload
      // the catalogue uses. The handlers below and the model both take it from
      // this one binding, so a tag list rendered from it and a duplicate check
      // made against it can never disagree.
      const presetTags = presets.data && Array.isArray(presets.data.tags) ? presets.data.tags : [];
      const savePresetDraft = async () => {
        const name = presetDraft.name.trim();
        if (name.length === 0) {
          // The host would answer exactly this; refusing here keeps a known
          // answer from being turned into a round trip. The refusal stays **in
          // the dialog** (review R3): the editor's own error line, never the
          // page notice, which would sit behind the overlay.
          setPresetStatus({ kind: 'error', error: { code: 'invalid-name' } });
          return;
        }
        setPresetStatus({ kind: 'saving', error: null });
        setBusy(true);
        const body = {
          name: presetDraft.name,
          action: presetDraft.action,
          text: presetDraft.text,
          // g-082: the whole entry is what a PUT states, so an empty set is
          // sent explicitly (a preset being edited down to "no tags" must not
          // keep the old ones).
          tagIds: Array.isArray(presetDraft.tagIds) ? presetDraft.tagIds.slice() : [],
        };
        // An `id` is what makes this an edit rather than an insert; without one
        // the host mints the id (§20.3).
        if (presetDraft.id !== null) body.id = presetDraft.id;
        const result = await requestJson(PRESETS_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy(false);
        if (!result.ok) {
          // A refused save leaves the dialog **open** with the reason on its own
          // line: closing it would throw the draft away and hide why.
          setPresetStatus({ kind: 'error', error: result.error });
          return;
        }
        const preset = result.payload && result.payload.preset ? result.payload.preset : null;
        // Keep the written entry as the editor's draft (so a re-open starts from
        // what the library now holds), and close the dialog: the save is done,
        // and the refreshed list is what the reader came back for.
        if (preset !== null) {
          setPresetDraft({
            id: preset.id,
            name: typeof preset.name === 'string' ? preset.name : '',
            action: preset.action === 'append' ? 'append' : 'replace',
            text: typeof preset.text === 'string' ? preset.text : '',
            tagIds: Array.isArray(preset.tagIds) ? preset.tagIds.slice() : [],
          });
        }
        setPresetStatus({ kind: 'saved', error: null });
        setPresetDialog(null);
        setNotice({ tone: 'success', text: t('presetSavedNotice') });
        setReload((value) => value + 1);
      };

      const deletePreset = async (id) => {
        setPresetStatus({ kind: 'saving', error: null });
        setBusy(true);
        const result = await requestJson(`${PRESETS_PATH}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        setBusy(false);
        if (!result.ok) {
          setPresetStatus({ kind: 'error', error: result.error });
          setNotice({ tone: 'error', text: errorText(t, result.error) });
          return;
        }
        // The editor must not keep pointing at an entry that is gone: it would
        // send its id on the next save and be answered `404 preset-not-found`.
        // An open dialog on that entry closes with it (review R3): its subject
        // no longer exists. (Checked before the draft is cleared, so the editor
        // dialog is recognised by the id it was opened on.)
        if (presetDialog !== null && (presetDialog.kind === 'apply' ? presetDialog.presetId === id : presetDraft.id === id)) {
          setPresetDialog(null);
        }
        if (presetDraft.id === id) setPresetDraft({ id: null, name: '', action: 'replace', text: '', tagIds: [] });
        setPresetStatus({ kind: 'saved', error: null });
        const restored = result.payload && typeof result.payload.restoredWorkspaces === 'number'
          ? result.payload.restoredWorkspaces
          : 0;
        setNotice({
          tone: 'success',
          text: fmt(t(restored > 0 ? 'presetDeletedRestoredNotice' : 'presetDeletedNotice'), { count: restored }),
        });
        setReload((value) => value + 1);
      };

      /**
       * g-082: the library's tag writes.
       *
       * Two actions on the manager dialog — one upsert (`PUT /presets/tags`) and
       * one delete (`DELETE ?id=`, which the host cascades through every preset).
       * Both follow this page's one write shape: send, on failure keep the
       * dialog open with the answer on its own line, on success reset the
       * editor half and re-read the library. The delete is reached only through
       * `confirmYes` (the row's button *asks* first), exactly like preset
       * deletion.
       *
       * The affected-preset count the confirmation shows is computed from the
       * payload the page already holds (`presets.data.presets[].tagIds`); the
       * deletion answer carries the same number, so the notice reports what
       * really happened rather than what the page predicted.
       */
      const saveTagDraft = async () => {
        const name = presetTagDraft.name.trim();
        if (name.length === 0) {
          setPresetTagStatus({ kind: 'error', error: { code: 'invalid-tag-name' } });
          return;
        }
        setPresetTagStatus({ kind: 'saving', error: null });
        setBusy(true);
        const body = { name: presetTagDraft.name };
        if (presetTagDraft.id !== null) body.id = presetTagDraft.id;
        const result = await requestJson(PRESETS_TAGS_PATH, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy(false);
        if (!result.ok) {
          // The refusal stays in the tag dialog, on its own marked line.
          setPresetTagStatus({ kind: 'error', error: result.error });
          return;
        }
        setPresetTagStatus({ kind: 'saved', error: null });
        setPresetTagDraft({ id: null, name: '' });
        setReload((value) => value + 1);
      };


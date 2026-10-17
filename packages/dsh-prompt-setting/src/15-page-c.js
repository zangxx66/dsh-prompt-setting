// 本文件是 client.js 的片段，不是独立模块，不得单独 parse/lint/执行。
      const actions = {
        refresh: () => setReload((value) => value + 1),
        // The「更改」switch: the same button opens and shuts the picker (`aria-expanded` reports it).
        toggleScopeOpen: () => setScopeOpen((open) => !open),
        setTab,
        setView,
        setMineLayer: (value) => {
          setMineLayer(value === 'workspace' ? 'workspace' : 'user');
          setMineWarnings([]);
          setMineStatus({ kind: 'idle', error: null });
        },
        setMineText: (event) => {
          const value = event && event.target ? String(event.target.value) : '';
          // g-056: the draft carries its own scope, so the box can say whose text
          // it holds after the「查看范围」moved on — and R2: the entry is written
          // into a map keyed by write target, so typing here cannot destroy the
          // draft another target is holding. g-058: the mode it was typed under
          // survives the edit (see `updateMineDraft`).
          updateMineDraft({ text: value });
          setMineWarnings([]);
          setMineStatus({ kind: 'idle', error: null });
        },
        // g-058 (Revision 36): the「覆盖 / 叠加」choice. It is view state until
        // 「保存」 — the file is written by `saveMine` alone, with one layer and
        // one entry — so switching the mode back and forth never touches a disk.
        setMineMode: (value) => {
          updateMineDraft({ mode: value === 'append' ? 'append' : RESERVED_SECTION_DEFAULT_MODE });
          setMineWarnings([]);
          setMineStatus({ kind: 'idle', error: null });
        },
        saveMine,
        cancelMine,
        dropForeignDraft,
        toggleMineInterpolate,
        setMineInterpolateState,
        // g-062: the assembly-status notice's own switch (page-only feature).
        toggleAssemblyNotice,
        // g-060:「预设」— the catalogue editor, the two layer actions, and the
        // workspace they name. Everything here is view state until a click on
        // 「保存」/「应用」/「取消应用」, which are the only three controls that write.
        setPresetName: (event) => {
          const value = event && event.target ? String(event.target.value) : '';
          setPresetDraft((current) => ({ ...current, name: value }));
          setPresetStatus({ kind: 'idle', error: null });
        },
        setPresetText: (event) => {
          const value = event && event.target ? String(event.target.value) : '';
          setPresetDraft((current) => ({ ...current, text: value }));
          setPresetStatus({ kind: 'idle', error: null });
        },
        setPresetAction: (value) => {
          setPresetDraft((current) => ({
            ...current,
            action: value === 'append' ? 'append' : RESERVED_SECTION_DEFAULT_MODE,
          }));
          setPresetStatus({ kind: 'idle', error: null });
        },
        // Review R3: 「新建」/「编辑」 both **open the editor dialog** and put the
        // draft behind it. Nothing is written until a click on 「保存」, and the
        // dialog is the only surface those fields exist on.
        newPreset: () => {
          setPresetDraft({ id: null, name: '', action: RESERVED_SECTION_DEFAULT_MODE, text: '' });
          setPresetStatus({ kind: 'idle', error: null });
          setPresetDialog({ kind: 'edit' });
        },
        editPreset: (id) => {
          const list = presets.data && Array.isArray(presets.data.presets) ? presets.data.presets : [];
          const preset = list.find((entry) => entry.id === id) ?? null;
          if (preset === null) return;
          setPresetDraft({
            id: preset.id,
            name: typeof preset.name === 'string' ? preset.name : '',
            action: preset.action === 'append' ? 'append' : RESERVED_SECTION_DEFAULT_MODE,
            text: typeof preset.text === 'string' ? preset.text : '',
          });
          setPresetStatus({ kind: 'idle', error: null });
          setPresetDialog({ kind: 'edit' });
        },
        // 「从当前文本另存为预设」: it starts a **new** preset from the text the
        // 「我的 Prompt」 panel is showing and writes nothing — the name and the
        // save are still the user's to give (§20.9).
        saveAsCurrentPreset: () => {
          setPresetDraft({ id: null, name: '', action: RESERVED_SECTION_DEFAULT_MODE, text: mineText });
          setPresetStatus({ kind: 'idle', error: null });
          setPresetDialog({ kind: 'edit' });
        },
        // The apply dialog is opened **from a list row**, so the preset it acts
        // on is the row's own id — never "whatever the editor happens to hold"
        // (review R3), which is also why an unsaved draft cannot be applied by
        // accident: the dialog names a stored preset and says so in words.
        requestPresetApplyTo: (id) => {
          if (typeof id !== 'string' || id.length === 0) return;
          setPresetStatus({ kind: 'idle', error: null });
          setPresetDialog({ kind: 'apply', presetId: id });
        },
        closePresetDialog: () => {
          setPresetDialog(null);
          setPresetStatus({ kind: 'idle', error: null });
        },
        // Review R4: the close control of the **editor** asks first when the
        // draft is dirty — through the page's one confirmation overlay, not a
        // bespoke dialog — so throwing typing away is an answered question.
        // Everything else (a clean draft, the apply dialog) closes directly: a
        // confirmation for a no-op is noise.
        requestPresetDialogClose: () => {
          if (presetDialog !== null && presetDialog.kind === 'edit' && presetDraftDirty === true) {
            setConfirm({ kind: 'preset-discard' });
            return;
          }
          setPresetDialog(null);
          setPresetStatus({ kind: 'idle', error: null });
        },
        savePreset: () => {
          void savePresetDraft();
        },
        // Review R4: the row's「删除」only *asks*; the DELETE runs through `confirmYes`.
        requestPresetDelete: (id) => {
          const list = presets.data && Array.isArray(presets.data.presets) ? presets.data.presets : [];
          const preset = list.find((entry) => entry.id === id) ?? null;
          if (preset === null) return;
          // Revision 50 (g-069): the question must state what the deletion really
          // does. Every workspace whose record holds this preset is about to have
          // its layer restored, so the confirmation lists them — a count plus an
          // identifiable label (the page's own workspace label when it has one,
          // the root otherwise) — instead of promising that nothing is touched.
          const applied = presets.data && Array.isArray(presets.data.applied) ? presets.data.applied : [];
          const restorable = applied
            .filter((record) => Array.isArray(record.stack) && record.stack.some((link) => link.presetId === id))
            .map((record) => {
              const row = presetWorkspaces.find((entry) => entry.root === record.workspaceRoot) ?? null;
              const label = row === null || typeof row.label !== 'string' || row.label.length === 0
                ? record.workspaceRoot
                : row.label;
              return { root: record.workspaceRoot, label };
            });
          setConfirm({ kind: 'preset-delete', id, name: preset.name, workspaces: restorable });
        },
        deletePreset: (id) => {
          void deletePreset(id);
        },
        applyPreset: (presetId, session) => {
          void applyPreset(presetId, session);
        },
        unapplyPreset: (session, presetId) => {
          void unapplyPreset(session, presetId);
        },
        loadPresets: () => setReload((value) => value + 1),
        // g-030: the update banner's dismissal and the switch in 「高级」.
        dismissUpdate: () => setUpdate((current) => ({ ...current, dismissed: true })),
        toggleUpdate,
        recheckUpdate,
        // g-043:「下载区域」 — the dropdown, and the「自定义」dialog behind it.
        setDownloadRegion,
        setRegionCustomValue,
        submitRegionCustom,
        cancelRegionCustom,
        // g-032:「立即更新」— open the confirmation, start it, cancel it, retry it.
        requestUpdateApply,
        cancelUpdateApply,
        retryUpdateApply,
        requestMineReset: () => setConfirm({ kind: 'mine-reset', layer: mineLayer }),
        setAdvancedLayer: (value) => setAdvancedLayer(value === 'workspace' ? 'workspace' : 'user'),
        setSearch: (event) => setSearch(event && event.target ? String(event.target.value) : ''),
        setManualId: (event) => setManualId(event && event.target ? String(event.target.value) : ''),
        setSessionQuery: (event) => {
          setSessionQuery(event && event.target ? String(event.target.value) : '');
          setSessionActive(-1);
        },
        // Expansion is local view state, keyed by the sidebar's own group key
        // (the workspace id, or '' for the ungrouped bucket). The effective
        // state is passed in, so the toggle is exact even when a search forced
        // a group open.
        toggleScope: (key, open) => setScopeExpanded((current) => ({ ...current, [key]: open })),
        // Keyboard parity for the pointer toggle: Enter and Space both flip the
        // workspace node, exactly like the sidebar's own tree rows.
        onScopeHeaderKeyDown: (event, key, open) => {
          const pressed = event && event.key ? String(event.key) : '';
          if (pressed !== 'Enter' && pressed !== ' ' && pressed !== 'Spacebar') return;
          if (typeof event.preventDefault === 'function') event.preventDefault();
          setScopeExpanded((current) => ({ ...current, [key]: open }));
        },
        setScopeHover,
        setScopeFocus,
        showMoreScope: (key) =>
          setScopeLimits((current) => {
            const value = Number.isInteger(current[key]) ? current[key] : SCOPE_GROUP_PAGE;
            return { ...current, [key]: Math.min(SCOPE_GROUP_MAX, value + SCOPE_GROUP_STEP) };
          }),
        pickSession: (id) => {
          setSelection(id);
          // g-047: the box holds the user's own words. Picking a row moves the
          // selection and nothing else — the query keeps filtering the list, and
          // 「当前选中」 is shown by the summary, the `session-current` line and
          // the pinned entry, not by overwriting what the user typed.
          setSessionActive(-1);
          closeScope();
        },
        useCurrent: () => {
          if (seat.currentId.length === 0) return;
          setSelection(seat.currentId);
          // g-047: same rule as pickSession — the search box is not a label.
          setSessionActive(-1);
          closeScope();
        },
        useTypedId: () => {
          const id = sessionQuery.trim();
          if (id.length === 0) return;
          setSelection(id);
          setSessionActive(-1);
          closeScope();
        },
        onSessionKeyDown: (event) => {
          const key = event && event.key ? String(event.key) : '';
          if (key === 'ArrowDown' || key === 'ArrowUp') {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            if (sessionVisible.length === 0) return;
            setSessionActive((index) => {
              const next = key === 'ArrowDown' ? index + 1 : index - 1;
              return Math.max(0, Math.min(next, sessionVisible.length - 1));
            });
            return;
          }
          if (key === 'Enter') {
            const picked = sessionVisible[sessionActive] || sessionVisible[0];
            if (picked) {
              setSelection(picked.id);
              // g-047: as with a click, Enter moves the selection only — the
              // typed query survives, so the next Enter still resolves the row
              // it highlights instead of hunting a title as if it were an id.
              setSessionActive(-1);
              closeScope();
              return;
            }
            const typed = sessionQuery.trim();
            if (typed.length > 0) {
              setSelection(typed);
              closeScope();
            }
            return;
          }
          if (key === 'Escape') {
            setSessionQuery('');
            setSessionActive(-1);
          }
        },
        applyManual: () => {
          setSelection(manualId.trim().length > 0 ? manualId.trim() : GLOBAL_SESSION);
          closeScope();
        },
        useGlobal: () => {
          setSelection(GLOBAL_SESSION);
          setSessionQuery('');
          setSessionActive(-1);
          closeScope();
        },
        setLayerFilter: (value) => setFilters((current) => ({ ...current, layer: value })),
        setOverridableFilter: (value) => setFilters((current) => ({ ...current, overridable: value })),
        setOriginFilter: (value) => setFilters((current) => ({ ...current, origin: value })),
        setFullOrigin,
        toggleExpanded: (name) => setExpanded((current) => (current === name ? '' : name)),
        setHistoryLayer: (value) => {
          setHistoryLayer(value === 'workspace' ? 'workspace' : 'user');
          resetHistoryView();
        },
        // g-038: the version-history scope selector's own action. It is
        // deliberately not `pickSession`: this one moves no snapshot and no
        // override read, and the page's scope does not move this one.
        //
        // Picking a scope **finishes the interaction**: the picker collapses and
        // the search box is dropped, exactly like the page-level picker (§13.7).
        setHistoryScope: (value) => {
          setHistoryScope(typeof value === 'string' && value.length > 0 ? value : null);
          setHistoryScopeOpen(false);
          setHistoryScopeSearch('');
          // A different scope means a different history file: see resetHistoryView.
          resetHistoryView();
        },
        toggleHistoryScopeOpen: () => setHistoryScopeOpen((open) => !open),
        setHistoryScopeSearch: (event) =>
          setHistoryScopeSearch(event && event.target ? String(event.target.value) : ''),
        // g-073 (Revision 55): the two tab-owned scopes. Like the history scope's
        // own action, neither of these is `pickSession`: moving one moves no
        // page-scoped read and never touches `setSelection`. Picking **finishes
        // the interaction** — the disclosure collapses and the search box is
        // dropped — exactly as the page-level picker does (§13.7).
        setOverviewScope: (value) => {
          setOverviewScope(typeof value === 'string' && value.length > 0 ? value : null);
          setOverviewScopeOpen(false);
          setOverviewScopeSearch('');
        },
        toggleOverviewScopeOpen: () => setOverviewScopeOpen((open) => !open),
        setOverviewScopeSearch: (event) =>
          setOverviewScopeSearch(event && event.target ? String(event.target.value) : ''),
        setAdvancedScope: (value) => {
          setAdvancedScope(typeof value === 'string' && value.length > 0 ? value : null);
          setAdvancedScopeOpen(false);
          setAdvancedScopeSearch('');
        },
        toggleAdvancedScopeOpen: () => setAdvancedScopeOpen((open) => !open),
        setAdvancedScopeSearch: (event) =>
          setAdvancedScopeSearch(event && event.target ? String(event.target.value) : ''),
        historyPrev,
        historyNext,
        // g-039 fifth round: the preview lives in a modal, and this is what opens
        // it. It issues no request at all — the record came with the page the
        // list was rendered from — and the way out is the close button or Esc,
        // never a second click on the same record.
        previewHistoryRecord: (id) => {
          setPreviewId(String(id));
          setHistoryModal('preview');
        },
        /** Close whichever modal is open. The selection is deliberately kept. */
        closeHistoryModal: () => setHistoryModal(null),
        // The rollback button only *asks*: the write happens through the shared
        // confirmation overlay (CONTRACT §13.5), never on the click itself. How
        // many *other* sections that version overrode travels with the question,
        // so the confirmation can say they will not be restored.
        requestRollback: (id) => {
          const record = historyRecords.find((entry) => String(entry.id) === String(id)) ?? null;
          const snapshot = record !== null && Array.isArray(record.snapshot) ? record.snapshot : [];
          setConfirm({
            kind: 'rollback',
            layer: historyLayer,
            seq: Number(id),
            id: String(id),
            foreign: snapshot.filter((entry) => entry.name !== RESERVED_SECTION_NAME).length,
          });
        },
        // g-039 third round: the row itself is the primary control. The first
        // row picked becomes `from`; the second becomes `to`, and that is when
        // the comparison is requested **and its modal opens**; from the third on
        // it is a sliding window (`to` becomes `from`, the new row becomes `to`,
        // and the modal opens again on the new pair). Clicking the record already
        // holding one of the two slots steps back out of it, and `diff-clear`
        // resets both.
        pickHistoryRow: (id) => {
          const next =
            id === diffSel.from
              ? { from: null, to: null }
              : id === diffSel.to
                ? { from: diffSel.from, to: null }
                : diffSel.from === null
                  ? { from: id, to: null }
                  : diffSel.to === null
                    ? { from: diffSel.from, to: id }
                    : { from: diffSel.to, to: id };
          setDiffSel(next);
          setHistoryModal(next.from === null || next.to === null ? null : 'diff');
          void runDiff(next.from, next.to);
        },
        // The explicit way back: the same pair a reset installs (`current` is the
        // default `to`), so "cleared" and "just opened" cannot drift apart, plus
        // the request state and the modal are dropped rather than left showing a
        // result nobody is comparing any more.
        clearDiff: () => {
          setDiffSel({ from: null, to: DIFF_CURRENT });
          setDiff({ phase: 'idle', data: null, error: null });
          setHistoryModal(null);
        },
        requestResetLayer: (layer, count) => setConfirm({ kind: 'reset-layer', layer, count }),
        requestLegacyClear: (layer, count) => setConfirm({ kind: 'legacy-clear', layer, count }),
        cancelConfirm: () => setConfirm(null),
        confirmYes: async () => {
          const pending = confirm;
          if (pending === null) return;
          setConfirm(null);
          if (pending.kind === 'mine-reset') {
            await resetMine();
            return;
          }
          if (pending.kind === 'legacy-clear') {
            await clearLegacy(pending.layer);
            return;
          }
          if (pending.kind === 'reset-layer') {
            await resetLayer(pending.layer);
            return;
          }
          if (pending.kind === 'rollback') {
            await rollbackTo(pending);
            return;
          }
          if (pending.kind === 'update-apply') {
            await confirmUpdateApply();
            return;
          }
          // g-060 review R4: the two preset confirmations. Both do exactly what
          // their button said and nothing else — one DELETE, or one closed dialog
          // with the draft dropped.
          if (pending.kind === 'preset-delete') {
            await deletePreset(pending.id);
            return;
          }
          if (pending.kind === 'preset-discard') {
            setPresetDialog(null);
            setPresetStatus({ kind: 'idle', error: null });
            return;
          }
          await applyImport();
        },
        exportNow,
        setImportText: (event) => {
          setImportText(event && event.target ? String(event.target.value) : '');
          setTransfer((current) => ({ ...current, phase: 'idle', plan: null, error: null }));
        },
        setImportMode: (value) => {
          setImportMode(value === 'replace' ? 'replace' : 'merge');
          setTransfer((current) => ({ ...current, plan: null, error: null, phase: 'idle' }));
        },
        pickImportFile,
        previewImport,
        requestImportApply: () => setConfirm({ kind: 'import' }),
        copy: async () => {
          // g-073 (Revision 55): the copy buttons live in 「提示词总览」, so they
          // copy **that tab's** assembly — the one its own scope produced.
          const text =
            fullOrigin === 'all'
              ? String(overviewSnapshot && overviewSnapshot.rendered ? overviewSnapshot.rendered : '')
              : composeSections(overviewEffectiveSections, fullOrigin);
          const copied = await copyText(text);
          setNotice({ tone: copied ? 'success' : 'error', text: copied ? t('copied') : t('copyFail') });
        },
      };

      const model = {
        seat,
        wsSeat,
        scopeMode,
        scope,
        scopeOpen,
        scopeHover,
        scopeFocus,
        session,
        sessionArg,
        sessionQuery,
        sessionActive,
        sessionMatches,
        sessionVisible,
        manualId,
        tab,
        mineLayer,
        mineText,
        // g-058 (Revision 36): the mode the box is showing (`replace` | `append`)
        // and the mode this layer's file stores (`null` = the layer states none).
        // The pair is what `data-mine-mode` and `data-mine-mode-stored` report.
        mineMode,
        mineStoredMode,
        // g-056: which side of the box is being shown (`draft` | `stored`), the
        // readable scope the shown draft belongs to (or null), and the draft
        // that belongs to another scope and therefore blocks a save.
        mineTextSource: mineEntry === null ? 'stored' : 'draft',
        mineDraftScope: mineEntry === null ? null : mineEntry.scope ?? null,
        mineForeignDraft:
          mineForeignDraft === null
            ? null
            : { scope: mineForeignDraft.scope ?? null, chars: mineForeignDraft.text.length },
        mineConfigured,
        mineState,
        mineError: mineStatus.error,
        mineInterpolateOn,
        mineInterpolateStated,
        mineInterpolateState,
        mineInterpolateLocked,
        mineInterpolateStatus: mineInterpolate,
        mineWarnings,
        // g-080: the variable names the Host reported (null = not probed yet).
        mineVariables,
        mineLayerDisabled,
        mineFrozenReason,
        mineFrozenCertain,
        // g-062: the assembly-status observation the「我的 Prompt」block renders —
        // the Host's answer verbatim, the switch as the Host reported it, and the
        // switch's own request state.
        assembly,
        assemblyEnabled: assembly.enabled,
        assemblyPhase: assembly.phase,
        assemblyError: assembly.error,
        assemblyStatus: assembly.status,
        // g-060: the preset tab's state slots, the open dialog, the workspace
        // list the apply dialog renders, and the text「从当前文本另存为预设」reads.
        presets,
        presetDraft,
        presetStatus,
        // `null` | `{kind:'edit'}` | `{kind:'apply', presetId}` (review R3).
        presetDialog,
        presetWorkspaces,
        // g-060 (review R1, re-pointed by R3): the draft differs from the stored
        // preset it names, and whether closing the editor would discard work.
        // The second is what the close control reads (`presetDialogDiscard`).
        presetDirty,
        presetDraftDirty,
        presetCurrentText: mineText === null || mineText === undefined ? '' : String(mineText),
        advancedLayer,
        view,
        search,
        filters,
        fullOrigin,
        expanded,
        snap,
        ovs,
        // g-073 (Revision 55):「提示词总览」's own snapshot read and its own scope.
        // The overview chunk reads these four — never `snap` / `fz` /
        // `effectiveSections` / `incoming`, which keep describing the page-scoped
        // assembly「我的 Prompt」writes to.
        overviewSnap,
        overviewSnapshot,
        overviewFz,
        overviewEffectiveSections,
        overviewIncoming,
        overviewScope,
        overviewScopeValue,
        overviewScopeName,
        overviewScopeOptions: overviewScopes.options,
        overviewScopeGroups,
        overviewScopeMode: overviewScopes.mode,
        overviewScopeOpen,
        overviewScopeSearch,
        // g-073 (Revision 55):「高级」's own workspace selector, the override read
        // it scopes, and the session its assembly record is read for.
        advancedScope,
        advancedScopeValue,
        advancedScopeName,
        advancedScopeOptions: advancedScopes.options,
        advancedScopeMatches,
        advancedScopeMode: advancedScopes.mode,
        advancedScopeOpen,
        advancedScopeSearch,
        advancedOvs,
        advancedSnap,
        advancedEffectiveSections,
        advancedIncoming,
        assemblySession: advancedScopeArg,
        notice,
        busy,
        hist,
        historyLayer,
        // g-038: the version history's own scope and its paging.
        historyScope,
        historyScopeValue,
        historyScopeName,
        historyScopeOptions: historyScopes.options,
        historyScopeMode: historyScopes.mode,
        historyScopeOpen,
        historyScopeSearch,
        historyScopeMatches,
        histPage,
        diffSel,
        diff,
        preview: previewInfo,
        historyPanel,
        historyPanelRef,
        // g-039 fifth round: `null` | `'preview'` | `'diff'` — at most one modal
        // at a time, by construction.
        historyModal,
        confirm,
        // g-043: `null` when the「自定义镜像源」dialog is closed.
        regionDialog,
        transfer,
        importText,
        importMode,
        boot,
        update,
        fz,
        effectiveSections,
        incoming,
        phase,
        passesFilters: (section) => {
          if (filters.layer !== 'all' && sectionLayer(section) !== filters.layer) return false;
          if (filters.overridable === 'yes' && section.overridable !== true) return false;
          if (filters.overridable === 'no' && section.overridable !== false) return false;
          if (filters.origin !== 'all' && originOf(section) !== filters.origin) return false;
          return true;
        },
      };

      try {
        const tree = renderSection(t, model, actions);
        // Only the primitives branch needs a boundary: the hand-built atoms are
        // this page's own code, and a render-time throw from them is a bug the
        // outer `catch` (and the failure card) already answers. The Host's atoms
        // are the ones this page cannot see through (g-063 E1).
        if (!primitivesActive()) return tree;
        return h(
          PrimitivesErrorBoundary,
          {
            // Rebuilds the same page with the hand-built atoms — the same call
            // the try above makes, so the degraded page is the real page, not a
            // placeholder. Its own throw still lands on the failure card.
            renderFallback: () => {
              try {
                return renderSection(t, model, actions);
              } catch (error) {
                return renderFailureCard(t, error);
              }
            },
          },
          tree,
        );
      } catch (error) {
        return renderFailureCard(t, error);
      }
    }

    // #region launch shape (g-036)
    /**
     * The three launch shapes the restart copy is partitioned into.
     *
     * The host judges the shape from the official profile name
     * (`core/launch-kind.js`) and reports it as `launchKind` on the ping; this
     * page only has to pick a key. Choosing is deliberately *not* a
     * re-derivation: a browser cannot see the Host's profile, and a second
     * judgement would be a second thing to keep in sync.
     */
    const LAUNCH_KIND_CLI = 'cli';
    const LAUNCH_KIND_DESKTOP = 'desktop';
    const LAUNCH_KIND_UNKNOWN = 'unknown';
    /**
     * Which dictionary key each g-036 copy family uses per launch shape.
     *
     * The bare key is the `unknown` copy — what an old host (no `launchKind`), a
     * failed ping or an unrecognized value get — and its text names no launch
     * form, so a terminal user and a desktop user can both follow it. The
     * mapping is an **explicit table**, never string concatenation: every
     * sentence this page shows comes from the registered dictionaries, and a key
     * built at render time is exactly how one of them goes missing unnoticed.
     */
    const UPDATE_APPLY_COPY_KEYS = Object.freeze({
      restartNote: Object.freeze({
        cli: 'updateApplyRestartNoteCli',
        desktop: 'updateApplyRestartNoteDesktop',
        unknown: 'updateApplyRestartNote',
      }),
      done: Object.freeze({
        cli: 'updateApplyDoneCli',
        desktop: 'updateApplyDoneDesktop',
        unknown: 'updateApplyDone',
      }),
      already: Object.freeze({
        cli: 'updateApplyAlreadyCli',
        desktop: 'updateApplyAlreadyDesktop',
        unknown: 'updateApplyAlready',
      }),
      unknownState: Object.freeze({
        cli: 'updateApplyUnknownCli',
        desktop: 'updateApplyUnknownDesktop',
        unknown: 'updateApplyUnknown',
      }),
    });

    /**
     * Fold whatever the ping answered into the three-state enum.
     *
     * Only the two decided values survive; `undefined` (an old host that never
     * sent the field), `null` (a failed ping) and any other spelling become
     * `'unknown'`, which is the copy both launch shapes can follow.
     * @param value - `boot.launchKind`, or anything else.
     * @returns one of the three launch kinds.
     */
    function normalizeLaunchKind(value) {
      return value === LAUNCH_KIND_CLI || value === LAUNCH_KIND_DESKTOP ? value : LAUNCH_KIND_UNKNOWN;
    }

    /**
     * The launch shape one page model is rendering for.
     * @param model - the page model, or anything else.
     * @returns one of the three launch kinds.
     */
    function modelLaunchKind(model) {
      const boot = model === null || model === undefined ? null : model.boot;
      return normalizeLaunchKind(boot === null || boot === undefined ? null : boot.launchKind);
    }

    /**
     * The dictionary key for one g-036 copy family and launch shape.
     * @param family - a key of {@link UPDATE_APPLY_COPY_KEYS}.
     * @param launchKind - the value the host's ping carried.
     * @returns the key to translate; never `undefined`.
     */
    function updateApplyCopyKey(family, launchKind) {
      const table = UPDATE_APPLY_COPY_KEYS[family];
      if (table === undefined) return 'updateApplyUnknown';
      const key = table[normalizeLaunchKind(launchKind)];
      return typeof key === 'string' ? key : 'updateApplyUnknown';
    }
    // #endregion

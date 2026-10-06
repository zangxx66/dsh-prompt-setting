/**
 * `dsh-prompt-setting` — which shape this Host was started in, host side.
 *
 * Why this layer exists: since g-030/g-032 the plugin installs a new release
 * itself and then tells the user to restart. Until g-036 that instruction was
 * one hardcoded sentence — 「请手动重启 dsh web 生效」 — which is only ever
 * actionable for someone who started the Host from a terminal. A user of the
 * official desktop application (Electron, `/Applications/DeepSeek Harness.app`)
 * never sees that terminal: their restart is quitting and reopening the app, and
 * telling them to restart `dsh web` is an instruction they cannot carry out.
 * So the page has to know which shape it is talking to.
 *
 * The one judgement this module makes is the official profile's own name. DSH
 * builds `profileContext` from `options.profile` and provides it on the Host
 * context, and the official web-app patches read exactly this field
 * (`ctx.get('profileContext')?.name !== 'desktop'`), so `desktop` is the value
 * the desktop application itself runs. `dsh`'s CLI refuses that profile outright
 * (`rejectElectronProfile`), so a command-line Host cannot claim to be the
 * desktop one — the judgement has no false positive in the direction that
 * matters.
 *
 * Three states, deliberately:
 *   - `'desktop'` — the profile is named `desktop`;
 *   - `'cli'` — the profile is named something else (the CLI's `web`, `tui`, …);
 *   - `'unknown'` — the service is absent, threw, or answered a name that is not
 *     a usable string.
 *
 * `'unknown'` must never be folded into `'cli'`: a desktop user shown the
 * command-line copy is exactly the defect this goal removes. The copy for
 * `'unknown'` is one both shapes can follow.
 *
 * Pure by construction — no IO, no DSH import, no `process.env` — so
 * `node --test` can enumerate every input (`test/launch-kind.test.mjs`). The
 * environment markers the desktop app also happens to set
 * (`ELECTRON_RUN_AS_NODE`, `DSH_CLIENT_VERSION`) are deliberately **not** used:
 * the first is true of any Electron Node Host and the second is a variable a
 * user can set, so neither may turn an honest `'unknown'` into a guess.
 *
 * @module dsh-prompt-setting/core/launch-kind
 */

/** Started from a command line (`dsh web`, a service manager, …). */
export const LAUNCH_KIND_CLI = 'cli';
/** Started by the official DeepSeek Harness desktop application. */
export const LAUNCH_KIND_DESKTOP = 'desktop';
/** This Host cannot tell, so the page must use a copy both shapes can follow. */
export const LAUNCH_KIND_UNKNOWN = 'unknown';
/** Every value {@link launchKindOf} can answer, in contract order. */
export const LAUNCH_KINDS = Object.freeze([LAUNCH_KIND_CLI, LAUNCH_KIND_DESKTOP, LAUNCH_KIND_UNKNOWN]);
/** The official profile name the desktop application runs (`cordis.patch.yml`). */
export const DESKTOP_PROFILE_NAME = 'desktop';
/** The Host context slot DSH provides the profile descriptor under. */
export const PROFILE_CONTEXT_SLOT = 'profileContext';

/**
 * Fold any value into the three-state enum.
 *
 * This is the *client-side* half of the same rule: a page reading a Host answer
 * — or an old Host that never sent a `launchKind` at all — must land on
 * `'unknown'` for everything that is not exactly one of the two decided values.
 * @param value - anything a response carried under `launchKind`.
 * @returns one of {@link LAUNCH_KINDS}.
 */
export function normalizeLaunchKind(value) {
  return value === LAUNCH_KIND_CLI || value === LAUNCH_KIND_DESKTOP ? value : LAUNCH_KIND_UNKNOWN;
}

/**
 * Judge one profile name.
 *
 * Only the exact official name decides the desktop shape. Any other usable
 * string is the command line (the CLI's own profiles: `web`, `tui`, …); a
 * missing, non-string or blank value is `'unknown'` rather than `'cli'`, because
 * an unreadable profile is not evidence of a terminal.
 * @param name - `profileContext.name`, or anything else.
 * @returns one of {@link LAUNCH_KINDS}.
 */
export function launchKindOfName(name) {
  if (typeof name !== 'string') return LAUNCH_KIND_UNKNOWN;
  const trimmed = name.trim();
  if (trimmed.length === 0) return LAUNCH_KIND_UNKNOWN;
  return trimmed === DESKTOP_PROFILE_NAME ? LAUNCH_KIND_DESKTOP : LAUNCH_KIND_CLI;
}

/**
 * Judge one `profileContext` value, however malformed it is.
 * @param profileContext - the service's answer, or anything else.
 * @returns one of {@link LAUNCH_KINDS}.
 */
export function launchKindOfProfileContext(profileContext) {
  if (profileContext === null || typeof profileContext !== 'object') return LAUNCH_KIND_UNKNOWN;
  try {
    return launchKindOfName(profileContext.name);
  } catch {
    // A getter that throws is an answer this module cannot read: unknown, and
    // never a guess in the direction of the command line.
    return LAUNCH_KIND_UNKNOWN;
  }
}

/**
 * Read the launch shape off a Host context.
 *
 * The lookup is the *optional* one (`ctx.get`), never an entry in this plugin's
 * `inject`: a profile without the service still serves every route, and this
 * plugin must not become unloadable over a fact it can report as `'unknown'`.
 * @param ctx - the Host plugin context, or anything else.
 * @returns one of {@link LAUNCH_KINDS}; never throws.
 */
export function launchKindOf(ctx) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') return LAUNCH_KIND_UNKNOWN;
  let profileContext;
  try {
    profileContext = ctx.get(PROFILE_CONTEXT_SLOT);
  } catch {
    return LAUNCH_KIND_UNKNOWN;
  }
  return launchKindOfProfileContext(profileContext);
}

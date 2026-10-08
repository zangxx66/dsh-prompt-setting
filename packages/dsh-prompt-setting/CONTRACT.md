# `/prompt-setting` REST contract (frozen)

Stage 1B freeze. Stage 1C (the settings UI) may build against every field and
every status code below; changing any of them is a contract change, not an
implementation detail.

- **Prefix**: `/prompt-setting` — one `webServer` route of kind `prefix`, owned
  by this plugin. Nothing else may claim the prefix.
- **Encoding**: every response is JSON (`application/json; charset=utf-8`) with
  `cache-control: no-store`. The only non-JSON responses are the empty-body
  `405` and the bare status-code replies from the trust fence.
- **Trust fence**: every request first passes
  `ctx.connection.requestRejection(req)`. A non-`undefined` answer is written
  verbatim as the status with an empty body and no further routing. When the
  `connection` service is absent the route fails closed with `503`
  `trust-fence-unavailable`.
- **Session id**: a session is identified by `Agent.id`, which the Host shares
  with the session log. It is passed as `?session=<id>`; it is never used to
  build a filesystem path directly (see §4.2). It also selects the **scope** the
  snapshot is probed under (§2.4).

**Revision 2 (review fix).** Two defects found in review changed the snapshot's
semantics; both are reflected below and are breaking for anyone who had already
built on revision 1:

- the snapshot now probes the **session's own scope**, not the unscoped assembly,
  and reports which scope the verdict describes via the new `frozenScope` /
  `frozenScopeReason` fields (§2.4, §5.8). A preset that freezes a session with
  `{complete: true}` is now detected for that session;
- each probe's config is matched to its own `AssembleContext` by **object
  identity**, so a concurrent assembly by any other caller (including a real turn
  for the same session) can never receive the probe's synthetic section (§2.6).

**Revision 3 (live-machine fixes).** Two defects the real machine exposed:

- **`frozen` is now decided solely by whether this plugin's probe section
  survived** (§2.4). The previous rule also treated "the result is not
  `registered.length + 1` sections" as a freeze, which misfired on the entirely
  normal case of another plugin appending a section — it reported
  `frozen: true` and marked **every** section non-overridable, i.e. a read-only
  panel. Nothing about `frozen` or `overridable` is derived from a section count
  any more;
- **`rendered` never renders a missing variable value as a bare `undefined`,
  and `renderedResolved` / `unresolvedVariables` report it instead** (§2.3).

Also new: `effective[].origin` marks a section another listener added after the
waterfall, so the browser can label it instead of reading it as our override or
as an anomaly (§2.2).

**Revision 4 (stage 2 — history, diff, export/import).** Additive only: every
path, field and status code frozen in revisions 1–3 keeps its exact meaning and
its exact bytes. Concretely, the `PUT` and `DELETE /overrides` response bodies
are **byte-identical** to revision 3 — the new change log is read through its own
route, never smuggled into a frozen body. New in this revision:

- `GET /prompt-setting/history` — one layer's bounded change log (§8);
- `GET /prompt-setting/diff` — section-level and line-level comparison of two
  versions of one layer (§9);
- `GET /prompt-setting/export` — a schema-versioned JSON document (§10);
- `POST /prompt-setting/import` — the same document applied **atomically**, with
  a `dryRun` preview (§11);
- `DELETE /prompt-setting/overrides?reset=true` — whole-layer reset, as a new
  mode of the existing route and method (§12).

The three new error statuses an import can produce are `409` (an existing layer
file that cannot be read), `413` (a body over the import cap) and `500` (a staged
file that failed its own re-validation); a rejected import always leaves the
existing configuration byte-identical (§11.5).

**Revision 5 (refresh semantics — both layers, on the request path).** Revisions
1–4 refreshed the workspace layers only where a route happened to ask for one,
and read the user layer once at mount and thereafter only from this plugin's own
save paths. An external edit to `$DSH_HOME/prompt-setting/overrides.json` — a
hand edit, a config-sync tool, another process — was therefore invisible to a
running mount until it was reloaded. Revision 5 removes that asymmetry:

- one `refreshLayers()` re-reads the user layer **and** every known workspace
  layer as the first statement of every handled route request, before anything
  in that request can fail (§5.5). An external edit is visible to the very next
  request, with no remount and no file watcher;
- a request that then fails (any `4xx`/`5xx` a write path can produce, the
  rejected import included) still refreshed first, so a failed write can never
  desync memory from disk for longer than the request that failed;
- the assembly path is unchanged and still performs **no IO at all**: the
  waterfall listener reads the in-memory cache those refreshes maintain, so a
  change on disk is never observed *during* an assembly.

No response body and no status code changes: every shape frozen in revisions 1–4
keeps its exact bytes. Two layer-status refinements ride along, both expressed
inside the existing `enabled` / `reason` fields (§5.6):

- a user-layer file that this mount has read and that has since disappeared is
  reported `enabled: false` with `missing-file: … was removed after it had been
  read`, rather than degrading into "this layer holds no overrides";
- a file that has **never** existed is unchanged — an empty, `enabled: true`
  layer — which is the honest state of a profile that was never configured, and
  is what revisions 1–4 always reported.

**Revision 6 (client build stamp).** Additive, with exactly one new field: `GET
/prompt-setting/ping` now answers `clientBuild`, and the browser half renders the
comparison. The question this settles is「the tab I am looking at — which
`client.js` is it running?」, which until now could only be guessed at (a stale
tab keeps running the bundle it was loaded with; the host keeps serving the new
bytes, so both are "working" and they disagree).

- `clientBuild` — `{hash, size, mtime}`, computed **on every request** by reading
  the `client.js` this process publishes, or `null` when that file cannot be read
  or its marker region is unusable (§14.2);
- the page fingerprints **itself**, from the running factory's own source, and
  publishes `data-build` / `data-build-server` / `data-build-match`
  (`true` \| `false` \| `unknown`), rendering
  `data-warning="client-build-stale"` only when both digests really answered and
  really differ (§14.3).

Everything else is untouched: no other route, field, status code or response byte
changes, and the `E1–E5` probe, the snapshot, both override layers and every
stage-2 route keep their exact shapes.

**Revision 7 (one owned prompt section, and a write face narrowed to it).** The
plugin stops being a general "override any section" editor and becomes **one
prompt section of its own plus a read-only view of everything else**. This
revision is **breaking for the write routes** — deliberately, and it is the only
revision that narrows rather than adds:

- the Host half registers one section of its own during `apply`, with the
  reserved name `prompt-setting:custom-prompt`, `order: 1000000` (past every
  placement the shipped package defines), `text: ''` and `interpolate: false`
  (§15.1–§15.3);
- `PUT /overrides` accepts **one name and one action**: the reserved name with
  `action: "replace"`. Any other name is `403 write-locked`; any other action on
  the reserved name is `400 unsupported-action`. Both verdicts are reached
  before the layer is resolved and before anything is written, so a rejected
  write leaves every file byte-identical (§4.1, §15.5);
- the single-name `DELETE` accepts the reserved name only, and answers
  `403 write-locked` **before** it would answer `404 override-not-found` (§4.3);
- `DELETE ?legacy=true` is new: it removes the layer's frozen overrides and keeps
  the reserved one. `?reset=true` keeps its exact Revision 4 meaning — the whole
  layer, reserved entry included — and the two flags together are
  `400 conflicting-query` (§12.2, §15.6);
- `POST /import` refuses a document that carries any non-reserved section name
  with `403 write-locked`, in a dry run as well as in a real import (§11.1);
- `GET /export` carries only the reserved entry of each layer and declares what
  it dropped, per layer and in total, as `exportScope` (§10);
- an existing override of any other name keeps working **exactly** as it did in
  Revision 6 — same assembly result, byte for byte — but no route can create,
  update or import one any more. It is *frozen read-only*, and a hand edit of the
  layer's file remains the escape hatch (§15.8).

One consequence is stated rather than left to be discovered: the plugin's own
section is always registered, so it is always visible in `base`/`effective` and
counts as one more entry there — while contributing **zero bytes** to the
rendered prompt until a user writes something (§15.2). And a scope with an active
`complete: true` section still collapses to that one section, which means the
reserved section (and therefore the user's text) does not reach the prompt at all
in such a scope; the snapshot reports that, and the UI must say so (§15.4).

**Revision 8 (the reserved section is kept last — 「我的 Prompt」真·排最后).**
Strictly additive, and it changes no route, field, status code or response byte.
The live machine showed that `order: 1000000` does not actually put the user's
text last: another plugin (`dsh-expression`) registers its own
`system-prompt/assemble` listener **before** this one, appends
`dsh-expression:companion` after `next()` returns, and is therefore *outer* to
this plugin — its post-`next()` step runs later. What Revision 8 adds:

- a second `system-prompt/assemble` listener, registered `{prepend: true}` so it
  is outer to every listener registered **before** it (a later `{prepend: true}`
  registration would be outer to it in turn — §6·E2, §15.10 residual 2). Its single
  job: after `await next()`, if the reserved section exists, carries non-empty text
  and is not the last entry, move it to the end; otherwise return the downstream
  value **by reference** (§15.10);
- the **existing** override listener is untouched: same registration, same
  position, same `base` record, same probe consumption, same `detectFrozen`, same
  `applyOverrides` and same identity rule (§5.3). Nothing about the snapshot
  changes;
- the scope of the promise is stated exactly: **when the section has text**, it is
  the last entry of the final `assembly.sections` — past sections other listeners
  append in the waterfall — **except** in the three residual cases §15.10 and §7
  record (a `complete: true` scope, a listener prepended after this mount, and any
  reordering of sections this plugin does not own).

An empty reserved section is deliberately **not** moved: it renders zero bytes
(§15.2), so its position is unobservable in the prompt, while moving it would
break the identity rule of §5.3 and the zero-diff guarantee that rests on it. The
whole listener therefore does nothing at all until a user writes something.

**Revision 9 (a frozen scope is a block, not a footnote).** Client-half only, and
strictly additive to this document: no route, field, status code or response byte
changes. The panel that owns the write face (§15.4) used to state a frozen scope
in one red line while its save button stayed enabled and its success copy stayed
unconditional, so a stored write could be read as an effective one — the exact
misreading §15.4 exists to prevent. What Revision 9 fixes:

- the frozen block carries both `data-warning="mine-frozen"` (kept) and the
  boolean `data-mine-frozen="true"`, states three things — the reason, where the
  text went (the selected layer's configuration), and that it does **not** reach
  the assembly the verdict describes — and names what the user can do about it
  (switch to an agent preset that does not declare `complete`, or drop the
  declaration, then reload the session);
- the block also carries `data-mine-frozen-certainty`: `"certain"` for a certain
  frozen snapshot (`frozenScope: "session"` with `frozen: true`, or
  `frozenScope: "global"` with no session selected), `"unknown"` for the
  `frozenScope: "global"` + session case §2.4/§7.2 forbids presenting as frozen.
  Those two cases render their own copy (`mineFrozenWarn`/`mineFrozenBody` vs
  `mineFrozenUnknownWarn`/`mineFrozenUnknownBody`); the shared
  `mineFrozenHowTo` is the actionable half in both. The verdict is the
  snapshot's own `frozen`/`frozenScope` and nothing else — a reserved entry
  arriving as `applied: false` is **not** a freeze signal (issue #1: a section
  with no override is `applied: false` with `reason: null` per §15.3, so an
  unconfigured install renders no block at all);
- the state line carries `data-mine-effect`: `"none"` for a certain freeze,
  `"unknown"` for that unknown case, `"next-turn"` otherwise — so the pair
  (`data-mine-state="saved"`, `data-mine-effect="none"`) is assertable offline
  without reading any copy;
- the copy shown after a successful write while the scope is frozen is the
  conditional form (`mineSavedFrozen`, `savedNoticeFrozen`; `mineSavedUnknown`,
  `savedNoticeUnknown` for the unknown case) and never the bare `mineSaved` /
  `savedNotice` wording. The delete path keeps `deletedNotice` unconditioned:
  this revision is scoped to the success wording of the write that §15.4 is about;
- the write stays **enabled**: a frozen scope blocks the effect, not the
  configuration, and no path clears what the user typed — the draft survives the
  freeze, tab switches and layer switches, and saves normally once the scope is
  not frozen.

The three-state `frozenScope` semantics of §2.4 and §7.2 are untouched: a global
freeze with a selected session still reports **unknown**, never "not frozen" —
and the panel does not relabel that case as a frozen session either.

**Revision 10 (graded unresolved consequences — g-025).** Additive: two new
snapshot fields, `unresolvedThrowing` and `unresolvedLiteral`, and new client
copy. No existing field, route, status code or value changes: `rendered`,
`renderedResolved` and `unresolvedVariables` keep the exact meaning and bytes
they had in Revision 3 (§2.3).

The reason is that one sentence — "an unresolved `{{reference}}` is left
literal" — was hiding two very different outcomes. The shipped renderer
**throws** on an unresolved reference in a section that interpolates, so that
session's prompt cannot be assembled at all; in a section with
`interpolate: false` it hands the braces through untouched, so the preview **is**
the real prompt. The panel said the same cautious thing about both, which
alarmed the harmless case and understated the fatal one. What Revision 10 adds:

- `unresolvedThrowing` and `unresolvedLiteral` split the unresolved names by the
  section that carried them (§2.3), so the browser states the consequence
  instead of guessing it;
- the warning card for a throwing reference now says the **real assembly will
  fail** — the prompt cannot be built, and this text is not it — and names the
  literal half separately when both kinds are present in one render;
- a literal-only unresolved reference renders a **non-warning** card
  (`data-note="rendered-literal"`) that says the preview is the real prompt;
- the preview stays read-only throughout: nothing is written back into the
  assembly, no user section's `interpolate` is ever flipped on, and the prompt a
  turn actually receives is still produced by the shipped `renderPrompt` alone.

**Revision 11 (the「我的 Prompt」variable-substitution switch — g-026).** The
gate §15.3 installed becomes a switch the user can open. Revision 11 justified
that by teaching the write face to answer the renderer's own question; Revision 15
(§16.9) made the justification unnecessary — the section never interpolates, so
opening the switch cannot expose the session to the renderer at all. Every
Revision 1–10 field, route, status code and byte keeps its exact meaning; the
switch is **absent by default**, so an install that never opens it behaves
byte-for-byte as it did before.

- `interpolateCustom` is a **config-level** field of either layer (§16.1). Absent
  means OFF; the workspace layer wins over the user layer on *statedness* — a
  workspace layer that states nothing inherits the user layer, one that states
  `false` does not;
- `GET`/`PUT /prompt-setting/interpolate` read and write it (§16.4), and
  `GET /snapshot` reports it under `layers.interpolate` (§2.3a);
- with the switch ON, `PUT /overrides` and `POST /import` refuse text whose
  references could never expand, with `400 unresolvable-variable` and **zero bytes
  written** (§16.4). The judgement is a pure transcription of the shipped
  `interpolate()`: malformed group, illegal name, unregistered name
  (`dsh-system-prompt/lib/index.js:157-176`). Since Revision 15 this is a UX
  guard rather than a safety gate (§16.9) — the conditions it refuses are
  unchanged, the reason it refuses them is;
- opening the switch validates the text **already stored** in both layers
  (§16.5). Revisions 11–14 also degraded an armed layer found on disk; Revision 15
  removed that pass, because a layer's text can no longer break an assembly and
  degrading it would silently discard the user's prompt;
- Revisions 11–14 flipped the **live section definition object** the service was
  handed. **Revision 15 does not, and never will** (§16.2): `interpolate: false` is
  structural. The switch takes effect on the next turn by changing what the plugin
  expands, with no re-registration and no restart.

Two deliberate softenings, both stated rather than hidden:

- a reference whose name **is** registered but whose value is `undefined` in the
  probed assembly is a **warning**, not a refusal (§16.3). The value belongs to
  the session, not to the text: a probe with no active agent leaves agent-scoped
  providers valueless, and refusing the save would make the switch unusable
  whenever nothing is running. The strict reading is still implemented and
  asserted (`scanThrowingReference`, `test/interpolate.test.mjs`);
- the renderer's malformed-group condition is now also reported by the **preview**
  `unresolvedThrowing`, where the earlier reading called it prose (§16.6). It is
  reported with the same 16-character excerpt the Host's own message quotes.

**Revision 12 (the independent audit of Revision 11 — g-026).** Four findings,
two of them pure-UI reachable bypasses of the switch's one invariant ("no stored
text may make a real assembly throw"), are fixed here. Every Revision 1–11 field,
route, status code and byte keeps its exact meaning, and the two-valued
`PUT /interpolate` body keeps its exact spelling and effect:

- **F1 — the write verdict is about the text, not about the write target.** The
  old check asked "does the layer being written interpolate?" and let a text in
  through a layer that was closed *at that moment*, after which flipping **another**
  layer's switch armed it. The verdict is now `armedLayers` (§16.4): text is
  validated whenever some assembly that renders it has its switch ON. The audit's
  two-step bypass, its reverse direction (a write into the user layer while a
  workspace is armed) and its `import`/`dryRun` twin are all refusals now;
- **F3 — the assembly decides on its own context.** The process-wide flag the
  request path used to write is gone from the assembly path: the decision is
  taken per dispatch, from the config that dispatch resolved, and applied to the
  `sections` that dispatch renders (§16.2). A session-less request (the ping is
  one) can no longer move any session's behaviour. Revision 15 keeps this rule
  unchanged while deleting the field it used to write;
- **F2 — the advisories are on the wire.** The `undefined`-value warning the
  validator always computed was being discarded; it now rides the write, arming
  and import responses as an additive `warnings` array and is rendered in
  「我的 Prompt」 (§16.3);
- **F4 — the switch has three states.** `inherit` (the key is absent), `on`
  (`true`) and `off` (`false`), spelled `{"state": …}` on `PUT`; the legacy
  `{"enabled": false}` still means "back to unstated", byte for byte (§16.8).
  Without explicit OFF a workspace layer could not close a switch the user layer
  opened, so the panel showed OFF while the session really inherited ON;
- **F5 — a degraded layer is perceivable.** The load-time degradation keeps the
  `missing-file` shape (the whole layer contributes nothing), and the reason plus
  the recovery path are now rendered where the text box is, not only in 「高级」
  (§16.5).

The audit's four route-level reproductions are frozen as regressions in
`test/route.test.mjs` (§16.4, §16.5), and the differential fuzz against the real
`renderPrompt` keeps its 0-miss / 0-false-positive result.

**Revision 13 (the second independent audit of Revision 12 — g-026).** That audit
cleared F2–F5 and kept F1 blocked: the cross-layer rule was right, but two ways of
**taking its verdict from data other than the data the decision uses** were left
open. Both are closed here, under one standing rule:

> **Whenever the data a verdict needs is missing, or a verdict is taken from a
> source other than the one the decision actually uses, the outcome is
> fail-closed** — refuse the write, do not participate in interpolation, or
> degrade explicitly with a reason. There is no fail-open case.

- **D1 — the judged set and the write target now have one source.** The F1 verdict
  ranged over `state.workspaces` (the cache built by `refreshLayers()` at the top
  of the request) while the write target was resolved through
  `workspaceRegistry.list()` — so a workspace the registry started listing later
  in the same request was missing from the judged set, and
  `armedLayers(...).some((layer) => layer.root === target.root)` was `false` by
  construction. The write was then stored **unverified** and returned 200, and the
  session really did throw on its next turn. `targetFor` now loads the resolved
  root into the cache before any verdict is taken, and
  `assertTargetJudged` refuses (`400 write-target-unverified`) a target that is
  still not in the judged set (§16.4);
- **D2 (Revision 13; superseded by Revision 15, §16.9) — an unverifiable assembly
  renders literally instead of throwing.** The
  load-time self-check can only check names when it holds a variable table, and
  the table arrives with the first HTTP request — so between `mount` and that
  request a hand-armed layer carrying `{{nope}}` slipped through and took the
  first real turn of the session down. The assembly path now takes its verdict
  from **the variable table that assembly itself carries**
  (`assembly.variables`), not from the cached one, and holds substitution back
  for that turn when the text cannot be resolved: the text renders literally, the
  reason was recorded per scope and exposed as
  `layers.interpolationHold` on the snapshot (§16.5, now deleted). The window's
  **real** consequence was one literal turn, never a throw and never a silent
  acceptance — and Revision 15 closed the window by construction instead
  (§16.9).

Both reproductions are frozen as regressions — the timing one in
`test/route.test.mjs` (a registry that lists the workspace only while the body is
being read) and the first-turn one against the **real** `renderPrompt` in
`test/integration.test.mjs`.

**Revision 14 (the third independent audit of Revision 13 — g-026).** That audit
kept F1/F3–F5 and the D1 half of the verdict closed, and found that the
**assembly** half of the verdict was still taken from the wrong data — twice over
— plus one bookkeeping defect. The standing rule of Revision 13 is applied one
level deeper: *the assembly's verdict must be taken from the very objects the
renderer will read, at the very point after which nothing can change them.*

- **E1 (Revision 14; superseded by Revision 15) — an `undefined` value is a throw
  condition, and the assembly treated it as one.** `interpolateHoldReason` used `lintPromptText().errors`, which routes
  `undefined` to `warnings` (§16.3's write-face reading) — so `{{cwd}}` with no
  value in this very assembly was interpolated anyway and `renderPrompt` threw
  `prompt variable "{{cwd}}" has no value for this assembly`, with no hold and no
  reason. The reachability was demonstrated, not theorised: DSH's shipped sections
  carry no `{{...}}` at all (the persona text comes from deployment config), so
  for a name with no shipped reference the reserved section is the *only* thing
  that can throw, and the panel explicitly invites the user to write
  `provider`/`model`/`cwd`. The assembly now judges with the **strict**
  transcription (`scanThrowingReference`); the write face keeps the soft reading
  on purpose, because its table is a probe's, not the session's (§16.3);
- **E2 (Revision 14; superseded by Revision 15) — the verdict was taken from the
  finished assembly, at the outermost point.** It ran inside `assembleHandler` and read `customTextOf(resolved)` — the
  config on disk. A listener that rewrote the reserved section after `next()`
  returned was therefore judged by text that is no longer rendered (a throwing
  final text could slip through), and a listener outer to that point could change
  the section or the table after the verdict was taken. The verdict now runs in
  the `{prepend: true}` listener's post-`next()` step — which Revision 14 believed
  was the last point at which this plugin could change the assembly — over the
  **final** `sections` text and the **final** `variables` table. (Revision 15
  deleted the whole verdict; the admission that the position was only believed,
  never guaranteed, is why.) The config one dispatch resolved is carried
  across the waterfall by object identity (`state.resolvedByContext`, a `WeakMap`
  keyed by the assembly context), so the probe slot is still consumed exactly
  where it must be and two concurrent dispatches cannot be confused for each
  other;
- **E3 (Revision 14; superseded by Revision 15) — the hold record was the current
  state, not a log.** `state.interpolationHolds` was append-only, so a snapshot kept returning a reason (and
  a timestamp) from a turn that no longer existed — after the text was made safe,
  after the section stopped rendering, after the switch was closed. A turn that
  does not hold now **deletes** its scope's key, so `null` means "not holding
  right now" (§2.3b). The clear route is the one this revision takes — the panel
  is not asked to render an explanation for a turn that no longer needs one;
- **E4 — `assertTargetJudged` stays as a defensive guard, and §16.4 now records
  why it is normally unreachable.** `targetFor` loads the target into the cache
  before any verdict, so the guard's branch is only reachable if a future refactor
  removes that step; it is kept because the direction it can be wrong in is
  over-refusal, which is explainable and repairable.

Every Revision 1–13 field, route, status code and byte keeps its meaning; the
only wire-visible changes are the two documented above (§2.3b's `null` semantics
and the fourth row of §16.3's table).

**Revision 15 (the final rework, design A — g-026; §16.9 is the authority).**
The fourth audit falsified the position premise the Revision 14 verdict rested on
(`{prepend: true}` is an `unshift`, so a listener registered **after** this plugin
can still be outer to it, and a host that drops the options object removes the
outermost slot entirely). Rather than patch the premise again, the section stopped
being an interpolated section at all:

- the reserved section stays `interpolate: false` **at every assembly** — the
  strict renderer can never see the text, so the four throw conditions above are
  unreachable through it. This is the design's whole value: the failure mode is
  structurally impossible, not prevented;
- the switch now means "the plugin expands the text itself", leniently, from the
  variable table the assembly carries; a reference that cannot resolve stays
  literal, and the answer never throws and never prints a bare `undefined`;
- `interpolateHoldReason`, the hold map, `layers.interpolationHold`,
  `resolvedByContext`, the load-time self-check and the layer degradation it drove
  are all **deleted** (D2, E1, E2, E3 above describe machinery that no longer
  exists, kept in this history because the audits and the regressions they
  produced are still the evidence for why the new design is shaped this way);
- the write face is unchanged in what it refuses — it is now a UX guard, and its
  messages say so. §16.10 lists every assertion this rewrite changed and what
  carries the coverage. The three reproductions are frozen in
`test/route.test.mjs` (a valueless name held with a reason; a final-section
rewrite held while a final-table registration is not; the record cleared by fixed
text and by a closed switch) and against the **real** `renderPrompt` in
`test/integration.test.mjs` (the 0-miss/0-false-positive differential corpus with
the `undefined` class required to be held, and a real first turn whose arming
layer names a registered-but-valueless provider).

---

**Revision 16 (the plugin version on the settings page — g-029).** Additive, and
the **client half only**: the settings page now states which version of this
plugin the host is running, read from the `version` field the ping has answered
since stage 1A (filled from `PLUGIN_VERSION`). No route, field, status code or
response byte changes; what is new is that the page consumes a field it used to
ignore:

- the root container publishes `data-plugin-version="<version>"` — the ping's
  value verbatim, or the string `unknown`. Every root container publishes it,
  including both failure cards (always `unknown`: neither can have reached the
  host);
- the status line adds the `stPluginVersion` tag (`插件版本: v<version>` /
  `Plugin version: v<version>`), beside the build stamp it shares that answer
  with (§13.8);
- `unknown` covers a failed or unreachable ping, a body without `version`, a
  non-string value and a string that declares nothing (`''`, whitespace only) —
  rendered as「版本未知」, never as a number. A value that carries text is shown
  byte for byte. It is the same asymmetry §14.3 applies to the build stamp, for
  the same reason: an invented answer is worse than an honest「未知」.

The client half carries **no version literal of its own**, and `package.json`'s
`version` is asserted equal to `index.js`'s `PLUGIN_VERSION` by reading both
files, so the one copy the page displays can no longer drift from the one the
host publishes.

---

**Revision 17 (the version moves beside the title, and links to the repository —
g-029).** Additive on the wire, and a placement change on the page:

- `GET /prompt-setting/ping` answers one more field, **`repositoryUrl`** —
  derived at import time from this package's own `package.json` by
  `repositoryUrlOf(manifest)`, in npm's order of authority: `repository.url`
  (trailing slashes folded first, then the `git+` prefix and a trailing `.git`
  stripped), else a bare `repository` string treated the same way, else
  `homepage` with its `#…` fragment dropped, else `null`. What survives must be
  `http://` or `https://`: an SSH spelling (`git@host:path`, `ssh://…`) is **not**
  rewritten into https — that would be guessing a different address — so it
  answers `null` and lets `homepage` (or plain text) answer instead. Never
  throws: an unreadable or field-less manifest answers `null`;
- the version **moves from the status line to the page title**: it renders in the
  heading's own row as `data-role="plugin-version"`, and the status line no
  longer renders a version node at all. The root container keeps
  `data-plugin-version`, and both failure cards keep their `unknown` (§13.8);
- with a `repositoryUrl` the node is an `a` element (`target="_blank"`,
  `rel="noreferrer noopener"`) whose `href` is that URL; with `null` it is a
  `span` marked `data-plugin-repository="unknown"` — **plain text, not a link**;
- neither half writes a repository URL (or a version) down: the URL is the
  ping's, the version is the ping's, and the manifest is the only place either
  can be edited.

---

**Revision 18 (timestamps are rendered in the reader's time zone).** Display-only:
**no wire field, no route and no stored byte changes.** The host keeps answering
UTC ISO 8601 (`…Z`) everywhere it already did — `snapshot.generatedAt`, a history
record's `at`, `exportedAt`, `checkedAt`, the install's `startedAt`/`finishedAt` —
and the page now **renders** what it shows to a human in the browser's own zone,
with the zone named:

- `snapshot.generatedAt` (the「快照生成时间」 in `data-region="status-detail"`) and
  a history record's `at` (`data-history-row`'s time node) both render as
  `YYYY-MM-DD HH:mm:ss GMT±h[:mm]` — e.g. a stored `2024-01-02T10:00:00.000Z`
  reads `2024-01-02 18:00:00 GMT+8` for a reader at UTC+8;
- the **export file name** (§13.3a) is a stamp too, and the one the user keeps on
  disk, so it is named in the same zone: `dsh-prompt-setting-YYYY-MM-DD-HH-mm-ss.json`
  — e.g. `dsh-prompt-setting-2024-01-02-18-00-00.json` for the same stored value.
  It carries **no zone label** (`:` folded to `-` because it is illegal in a
  Windows name, `+` doubtful in any name; the milliseconds are dropped), keeps the
  fixed-width fields that make it sort in exactly the order it reads, and derives
  from the **same** `exportedAt` the document carries — no second time source;
- the **shape is fixed, the zone is not**: the skeleton does not follow the
  locale (no 12-hour clock, no re-ordered fields), because what differs per
  reader is the zone and only the zone — two people comparing notes still read
  the same shape;
- the **stored UTC string stays reachable** as the node's `title`, so the value a
  host log shows is one hover away rather than lost;
- the renderer **degrades, never throws**: a value no `Date` can parse is echoed
  with the pre-Revision-18 `T`/millisecond fix-ups (and, for the file name, the
  pre-Revision-18 UTC spelling), an engine without `Intl` (or without
  `timeZoneName`) falls back to the UTC string or to no zone label, and a
  non-string/empty `at` renders nothing — exactly the input set the old helper
  accepted;
- the `?before=` bound and the log's own ordering are untouched: the server still
  filters and sorts on the stored strings (`seq` descending, `at < before`), so
  a `TZ` change on the reader's machine can never reorder or hide a record.

---

**Revision 19 (the version history stands alone — g-038).** Three changes, and
one of them is a **defect fix** rather than a feature: the settings page had one
tab that was both a read-only log and the page's way to overwrite every file, and
the log it showed was sliced by the page-level「查看范围」.

- **The tab is split in two (§13.0).** The first-level tabs are now five, in this
  fixed order: 「我的 Prompt」 / 「提示词总览」 / **「版本历史」** / **「备份与恢复」**
  / 「高级」. 「我的 Prompt」 is still the default. The export/import surface
  (`data-region="transfer"`, its export scope, import file, dry-run plan and
  second confirmation) moved **whole** into 「备份与恢复」, and 「版本历史」 renders
  no export/import entry point of any kind.
- **The history scope is decoupled from「查看范围」(§8, §13.3).** A history request
  is now `layer` + `offset`, plus the scope that *locates* the file: `session`
  filters **only when it is explicitly supplied and non-empty**, and the new
  `workspace` parameter locates a workspace's log **without** narrowing it to the
  writes of the one session that located it. The user layer is global: its log is
  the layer's whole log, whatever session wrote each record. 「版本历史」 has its
  own scope selector (workspace dimension, default = the current workspace) which
  the page-level「查看范围」does not touch — and which does not touch it.
- **The list is paged and bounded (§8.2, §13.3).** `GET /history` takes an
  `offset` (clamped, never an error) and answers `offset` / `pageCount` /
  `hasMore` beside the existing `pageLimit` and `total`; the page renders exactly
  one page of records inside a fixed-height, internally scrolling box, with
  「上一页」/「下一页」 disabled at the two ends. The page size is the **host's**
  (`pageLimit`): the bundle carries no page-size literal, and the first request
  sends no `limit` at all.
- Every Revision 1–18 field, route, status code and byte keeps its meaning. The
  `?session=` filter, the `?before=` bound, the `.jsonl` format, the retention
  bound, the corrupt-line tolerance and the lazy-fetch rule all survive; what
  changed is that a *reader* no longer has to know a session to see a layer's log,
  and that a log is no longer able to grow the page.
- `.jsonl` records are unchanged: a record still carries the `session` id of the
  write that produced it (`null` for a global write). Revision 19 changes who may
  **filter** by that field, not what is stored.

---

**Revision 20 (the scope becomes a disclosure, and a new file resets the view —
g-038 rework).** Client-half only: **no route, no query parameter and no stored
byte changes**, so `?workspace=` / `?session=` / `?offset=` keep their Revision 19
meaning exactly.

- **The version-history scope is no longer a wall of tabs.** Revision 19 rendered
  one tab per workspace, which grows a row at a time as workspaces appear. It is
  now a **disclosure**: one summary row (the current scope's name + 「更改」) with
  `data-scope-open`, and a picker rendered only while open — a search box over a
  fixed-height, internally scrolling candidate list, which collapses again the
  moment a candidate is picked (§13.3). Same interaction and copy as the
  page-level「查看范围」(§13.7, g-016), including the reused `scopeEdit` /
  `scopeCollapse` labels; only the label, the search placeholder
  (`histScopeSearch`) and the no-match line (`histScopeNoMatch`) are new. The
  「用户级 / 工作区级」layer selector is untouched: it has exactly two values, so
  it stays a segmented control.
- **A layer or scope change now clears the comparison state.** `diffSel` holds
  history ids, and an id means nothing outside the file it came from; changing
  either the layer or the scope used to leave the old selection highlighted and
  the old comparison on screen. Both paths now reset the offset to `0`, the
  selection to its default and the comparison to its empty state together
  (§13.3). **Paging deliberately does not reset it** — it moves inside one file —
  and that difference is pinned by a test.
- **The invariants of Revision 19 are untouched**: the history scope is still
  independent of「查看范围」, the user layer is still asked for globally, the
  workspace layer is still located-and-not-filtered by `?workspace=`, and
  `?session=` still filters only when explicitly supplied and non-empty.

---

## 1. Routes and methods

| Path | Methods | Purpose |
| --- | --- | --- |
| `/prompt-setting/ping` | `GET` | Stage 1A liveness probe. Behaviour unchanged, plus `clientBuild` since Revision 6 (§14.2), the page's own `version` read since Revision 16, `repositoryUrl` since Revision 17 (§13.8) and `launchKind` since g-036 (§14.2, §18.8). |
| `/prompt-setting/snapshot` | `GET` | Base + effective section views, frozen verdict, layering. |
| `/prompt-setting/overrides` | `GET` | Both layers and the merged list. |
| `/prompt-setting/overrides` | `PUT` | Upsert **the reserved section** into one layer; any other name is `403` (Revision 7, §4.1). |
| `/prompt-setting/overrides` | `DELETE` | Drop the **reserved** override; `?reset=true` clears the whole layer (§12); `?legacy=true` clears only its frozen overrides (§12.2). |
| `/prompt-setting/history` | `GET` | One layer's bounded change log, newest first (Revision 4, §8); paged by `offset` and scoped by `session` / `workspace` since Revision 19. |
| `/prompt-setting/diff` | `GET` | Section + line comparison of two versions of one layer (Revision 4, §9); same scope as §8 since Revision 19. |
| `/prompt-setting/rollback` | `POST` | Move the **reserved section** back to a recorded version, appending a section-level `rollback` record (Revision 21; narrowed to that one section in Revision 22, §19). |
| `/prompt-setting/export` | `GET` | One or both layers as a schema-versioned JSON document (Revision 4, §10). |
| `/prompt-setting/import` | `POST` | Apply such a document atomically, with a `dryRun` preview (Revision 4, §11). |
| `/prompt-setting/interpolate` | `GET` | The「我的 Prompt」variable-substitution switch, per layer and effective (Revision 11, §16.4). |
| `/prompt-setting/interpolate` | `PUT` | Set that switch for one layer: `{"enabled": bool}` (Revision 11) or `{"state": "inherit"|"on"|"off"}` (Revision 12, §16.8). |
| `/prompt-setting/update-check` | `GET` | The upstream release check: is a newer release published, and is checking on at all? Always `200`, failures included (g-030, §17). |
| `/prompt-setting/update-check` | `PUT` | Record the on/off switch for that check: `{"enabled": bool}` (g-030, §17.4). |
| `/prompt-setting/update-apply` | `POST` | Start installing the release the last check named, through the official `pluginManager`, and answer a `requestId` immediately: §18.2. Carries `launchKind` (g-036, §18.8). |
| `/prompt-setting/update-apply` | `GET` | The phase of one tracked install (`?requestId=`), or — with no id — this mount's oldest **running** install: §18.3. Carries `launchKind` (g-036, §18.8). |
| `/prompt-setting/update-apply/cancel` | `POST` | Stop a running install: `{"requestId": string}` (§18.4). Carries `launchKind` (g-036, §18.8). |

- An unknown path under the prefix is `404` with
  `{ "code": "not-found", "message": "no route for <path>" }` (no `ok` key —
  this is the stage 1A shape, preserved on purpose).
- A known path with an unsupported method is `405` with an `allow` header
  listing the supported methods and an **empty** body. `/prompt-setting/ping`
  answers `allow: GET`; `/prompt-setting/overrides` answers
  `allow: GET, PUT, DELETE`; `history`, `diff` and `export` answer `allow: GET`;
  `import` and `rollback` answer `allow: POST`; `interpolate` and `update-check`
  answer `allow: GET, PUT`; `update-apply` answers `allow: GET, POST` and
  `update-apply/cancel` answers `allow: POST`.
- The fence runs **before** the method check and before any route logic.

## 2. `GET /prompt-setting/snapshot`

Query: `session` (optional). `session` selects **both** the workspace layer and
the **scope** the assembly is probed under (§2.4). Without it the workspace layer
is inactive and the verdict describes the global assembly.

```json
{
  "ok": true,
  "mounted": true,
  "generatedAt": "2024-01-01T00:00:00.000Z",
  "frozen": false,
  "frozenSection": null,
  "frozenReason": null,
  "frozenScope": "global",
  "frozenScopeReason": null,
  "base":      { "sections": [ { "name": "harness:identity", "index": 0, "text": "…", "complete": false } ] },
  "effective": { "sections": [ { "name": "harness:identity", "index": 0, "text": "…", "applied": false,
                                 "overridable": true, "reason": null,
                                 "overrideLayer": null, "action": null } ] },
  "rendered": "…",
  "layers": {
    "user":      { "enabled": true,  "path": "/home/u/.dsh/prompt-setting/overrides.json", "reason": null },
    "workspace": { "enabled": false, "path": null, "reason": "no ?session= was supplied, so the workspace layer is inactive for this view" },
    "interpolate": { "effective": false, "user": null, "workspace": null }
  },
  "experiments": { "E1": "…", "E2": "…", "E3": "…", "E4": "…", "E5": "…" }
}
```

### 2.1 `base.sections[]`

The sections **as registered, before the waterfall** — the input the override
engine saw, not the output.

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | The registered section name. |
| `index` | integer | Position in this array. **This is the order.** The assembly carries no `order` field and `getSectionOrder()` accepts only a closed enum of repository names, so no numeric order is ever invented. |
| `text` | string | The registered text, before interpolation. |
| `complete` | `true` \| `false` \| `"unknown"` | `true` only when the frozen probe proved this section is the active `complete: true` section; `false` only when the same probe proved no complete section is active; `"unknown"` otherwise. |

### 2.2 `effective.sections[]`

One entry per rendered section, in render order, followed by every registered
section or override that produced **no** rendered section.

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | Section name. |
| `index` | integer \| null | Position in the rendered array. `null` means the section is not in the rendered prompt at all. |
| `text` | string | The text in the result. For an `index: null` entry it is the suppressed original text where one exists (a successful `hide`), otherwise `""`. |
| `origin` | `"registered"` \| `"appended"` \| `"downstream-added"` \| `"unmatched-override"` | Where the entry came from — see below. |
| `applied` | boolean | Whether the override for this name achieved what it asked for. `false` for a section with no override. |
| `overridable` | boolean | Whether this plugin can change the section at all. `false` for every section of a frozen scope, and `false` where a change was observed to be reverted. When nothing is frozen, a section with no override is `true`. |
| `reason` | string \| null | Human-readable explanation whenever `applied` is `false` or `overridable` is `false`; `null` when there is nothing to explain. |
| `overrideLayer` | `"user"` \| `"workspace"` \| null | Which layer supplied the override, `null` when none did. |
| `action` | `"replace"` \| `"hide"` \| `"append"` \| null | The requested action, `null` when no override targets this name. |

**`origin` — why `base` and `effective` can differ by name.** `base` is the
pre-waterfall registered sections; `effective` is the final result. Another
plugin may add or remove sections in its own `system-prompt/assemble` listener
(a live profile had a plugin append a companion section), so the two name sets
legitimately differ. `origin` is how the browser tells those apart instead of
reading them as an override or a fault:

| Value | Meaning | UI treatment |
| --- | --- | --- |
| `registered` | The name was in `base`. | A normal, editable row. |
| `appended` | This plugin's own `append` override introduced it. | An override row (`action: "append"`). |
| `downstream-added` | Neither of the above: it entered the result after the waterfall, contributed by another listener. | **"Added by another plugin"** — not an override, not an anomaly. It is still overridable: this plugin applies its overrides on top of the downstream result, so a `replace`/`hide` targeting it works. |
| `unmatched-override` | An override whose target exists neither in `base` nor in the result. | An override that had nothing to act on; `reason` says so. |

### 2.3 `rendered`, `renderedResolved`, `unresolvedVariables`, `unresolvedThrowing`, `unresolvedLiteral`

`rendered` is `effective`'s text: each section interpolated and dropped when
empty, the rest joined with a blank line.

**Documented difference from the shipped `renderPrompt`**: an unresolved
`{{reference}}` is left literal instead of throwing, because the snapshot is a
read-only view that must never fail on provider text, and this module cannot
import the shipped renderer (it is not resolvable from a linked plugin package).

A reference is **unresolved** when the variable is absent, or present with an
`undefined`/`null` value. That really happens: the shipped renderer documents
that a provider may return `undefined`, and a probe without an agent leaves
agent-scoped providers valueless. Two rules follow, and they are what the UI
must rely on:

- `rendered` **never contains a bare `undefined`** produced from a missing value;
- the reference stays literal as `{{name}}` and its inner text is listed in
  `unresolvedVariables` (sorted, deduplicated), with
  `renderedResolved: unresolvedVariables.length === 0`.

`unresolvedVariables` also carries malformed-but-complete groups such as
`{{Upper}}`, since the shipped renderer treats those as errors too. A lone `{{`
with no closing group is prose, exactly as the shipped renderer treats it, and
is not listed.

**The consequence of an unresolved reference depends on the section that carried
it, and the two fields keep them apart** (Revision 10). "Left literal" describes
what the *preview* does; what the *real* assembly does is decided by the
section's `interpolate`:

| Field | Reference sits in a section with | What the real assembly does | What the preview is worth |
| --- | --- | --- | --- |
| `unresolvedVariables`, `unresolvedThrowing` | `interpolate` not `false` | **Throws on every turn** — that session's prompt cannot be assembled | Not the real prompt; that session has no prompt |
| `unresolvedLiteral` | `interpolate: false` | Hands the text through untouched — the braces **are** what the model reads | The real prompt, exactly as shown |

- `unresolvedThrowing` carries the same sorted, deduplicated list as
  `unresolvedVariables`; the second name exists so a reader (and the UI) never
  has to infer the grading from the older field. Both are unchanged in meaning
  from Revision 3: they name the references that make the real render fail.
- `unresolvedLiteral` is sorted and deduplicated in the same way, and is
  **disjoint** from them — a reference belongs to exactly one section, so it
  appears in exactly one list. A resolvable reference in a non-interpolated
  section appears in **neither**: its value exists, it is simply never
  substituted, which is why the literal braces are not a fault.
- `renderedResolved` keeps its original definition
  (`unresolvedVariables.length === 0`), so an assembly whose only unresolved
  references are literal still reports `renderedResolved: true` together with a
  non-empty `unresolvedLiteral`: nothing there can fail the assembly, and the
  preview really is the prompt. The UI **must not** present that case as a
  warning — it is a statement of fact, not a defect.

**This section is read-only, and none of it changes what the model receives.**
`rendered` and both graded lists are computed for the browser from the probe
assembly. Nothing is written back into the assembly, and the prompt a real turn
receives is still produced by the shipped `renderPrompt` alone. The grading
exists so the UI can say what that renderer *will do* with the text it is showing
— including that it will throw.

**Revision 11 amended one clause of the paragraph above; Revision 15 removed the
amendment again.** For three revisions the one section this plugin owns had its
`interpolate` flipped at runtime when the user turned the switch on. Under
Revision 15 (design A, §16.9) that never happens: `prompt-setting:custom-prompt`
is registered `interpolate: false` and stays that way at every assembly, so the
paragraph above holds **verbatim and unconditionally** — no user section's
`interpolate` is ever turned on, by this plugin or by anything else it does. What
the switch turns on is the plugin's own expansion of that section's text, which
is a change to the **text**, not to the section's interpolation flag.

**A session-scope probe resolves agent-scoped variables; the global one cannot.**
Measured: a provider that returns a value only when `context.agent` is present
resolves under `?session=<active>` (the probe passes `{agent, scope: agent}`) and
returns `undefined` without a session. So:

- `frozenScope: "session"` ⇒ `renderedResolved` should be `true` for ordinary
  compositions;
- `frozenScope: "global"` ⇒ agent-scoped values are absent, `renderedResolved`
  may be `false`, and the UI should label the full-text view as partial rather
  than show placeholders as if they were the real prompt. Every shipped section
  interpolates, so those absent values are graded into `unresolvedThrowing`: the
  warning is then the literal truth rather than a hedge — a real turn composed
  the same way would throw.

### 2.3a `layers.interpolate` (Revision 11)

```json
"interpolate": { "effective": false, "user": null, "workspace": null }
```

- `user` / `workspace` are the value each layer **states**: `true`, `false`, or
  `null` for "states nothing". `null` is not `false` — it is what makes "the
  workspace layer inherits the user layer" observable to the browser (§16.1);
- `effective` is what this request's assembly will actually do, resolved the way
  the merge resolves it: workspace-stated, else user-stated, else OFF;
- the field sits **under `layers`** rather than at the top level on purpose: a
  Revision 10 client asserts the snapshot body's exact top-level key set, and
  Revision 11 may not break it. It is additive inside a container whose keys were
  never enumerated.

### 2.3b `layers.interpolationHold` — **removed in Revision 15**

Revisions 13 and 14 exposed a per-scope hold here:

```json
"interpolationHold": { "at": "2026-10-02T00:00:00.000Z", "reason": "the reserved section references `{{nope}}`, …" }
```

It recorded why an assembly had rendered the reserved section literally instead of
interpolating it. Revision 15 deleted the mechanism it described, and the key with
it: the section is never interpolated, so no turn is ever "held back", and the
reason a reference did not substitute is the plain one g-025 already grades —
`unresolvedLiteral`. `test/route.test.mjs` and `test/integration.test.mjs` assert
that `layers` carries **no** `interpolationHold` key at all, in both switch states
and after a hand-armed file. The three-key shape of the sibling `interpolate`
object (§2.3a) is unchanged.

The key used to be a sibling of `interpolate` rather than a field inside it, because that
object's three-key shape is frozen by the Revision 12 assertions.

### 2.4 `frozen` and `frozenScope`

`frozen: true` means the assembled scope no longer reflects the registered
sections. The UI **must** disable editing on such a scope and say why; a
silently failing edit is the failure mode this field exists to prevent.

**`complete` is a per-scope fact, so the verdict must name its scope.**
`Scoped` registrations are inherited through the scope's parent chain, so a
`complete: true` section registered by a preset's standing scope freezes every
session composed under it while the unscoped assembly stays unfrozen. Probing
globally would therefore report `frozen: false` and `overridable: true` for a
scope where no edit can take effect — the exact silent failure this field
exists to prevent.

| `frozenScope` | The probed scope | When |
| --- | --- | --- |
| `"session"` | `assemble({agent, scope: agent})` — the **same context object shape** a real turn uses, with the session's live `Agent` as the scope key | `?session=` was supplied and `ctx.agents.get(sessionId)` returned an active Agent |
| `"global"` | `assemble({scope: PROBE_SCOPE})`, this plugin's private object with no scoped registrations, which resolves exactly the global sections | `?session=` was absent, **or** it named a session with no active Agent |

`frozenScopeReason` is `null` for the two intended cases and a sentence
otherwise. A session that names no active Agent is **never** silently reported
as global: `frozenScope` is `"global"` and `frozenScopeReason` says the verdict
describes the unscoped assembly because the session's scope could not be probed
(a complete section registered there would not be visible). The UI should treat
that as "unknown for this session", not as "not frozen".

The verdict never claims more than it observed, and it is decided by **one
thing only — whether this plugin's own probe section survived the waterfall**:

1. The snapshot runs a **frozen probe**: an `assemble()` **under the target
   scope** with the single synthetic append `__dsh-prompt-setting-probe__`.
   - **it survived** ⇒ `frozen: false`. Nothing replaced the scope's `sections`.
     **Other plugins adding or removing sections in their own
     `system-prompt/assemble` listeners is normal and is NOT a freeze** — a live
     profile had a plugin append a companion section, and an earlier rule that
     compared the result's length against `registered.length + 1` called that a
     freeze on every scope, marking every section non-overridable. No section
     count and no whole-list comparison feeds this verdict any more.
   - **it is gone and the result is exactly one section** ⇒ `frozen: true`,
     `frozenSection` names that section: the scope collapsed to its single
     `complete` section.
   - **it is gone and the result is anything else** ⇒ `frozen: true` with the
     wording "this plugin's appended probe section was removed after the
     waterfall". It deliberately does **not** claim a `complete` section did it.
2. The only other input is the degenerate case where a registered section
   already owns the probe name, so no marker is available; there the two
   observations are compared directly.

A consequence worth stating: a section another listener *added* is not frozen
and is still `overridable: true`, because this plugin applies its overrides on
top of the downstream result.

`frozenSection` names the single section the scope collapsed to when that is
what happened (the complete one), otherwise `null`. `frozenReason` is always a
sentence naming what was observed.

`complete: true` semantics measured in E3: with such a section registered, the
Host replaces the entire scope's `sections` with that one section **after** the
waterfall, using its **original registered text**. The listener loses for every
section, not just the complete one, and rewriting that section's text is
reverted too.

### 2.5 `mounted`

`true` only when this plugin's own waterfall listener actually observed both
probes. Because the listener and the routes are registered by the same plugin,
a reachable `/prompt-setting/snapshot` normally implies `mounted: true`; the
flag makes the fact observable rather than assumed. When the plugin is disabled
or unloaded, its routes are unregistered with it, so the UI observes an
unreachable endpoint rather than `mounted: false` (E5).

### 2.6 Cost and probe correlation

The snapshot runs **two** `assemble()` calls, both under the target scope:

1. the **frozen probe** (config = the single synthetic append) — the sole input
   to the `frozen` verdict;
2. the **override probe** (config = this session's merged layers) — the input to
   `base`/`effective`/`rendered`.

Both results are discarded apart from their section lists. This is an on-demand
settings route, not a per-turn path.

Each probe's config is handed to the waterfall listener only for the exact
`AssembleContext` object this plugin passed to `assemble()`, matched by
**object identity**. Matching on a scope value instead would not be safe:
a real turn for the same session passes a different context object that carries
the *same* `Agent` as its scope, so a scope-keyed match would let that turn
consume the probe's synthetic append and receive
`__dsh-prompt-setting-probe__` in its own prompt. Identity matching makes that
impossible — no other caller can hold this plugin's context object — and the
consumption still happens synchronously, before the listener's first `await`.

## 3. `GET /prompt-setting/overrides`

Query: `session` (optional, selects the workspace layer).

```json
{
  "ok": true,
  "user":      { "layer": "user", "enabled": true, "path": "…", "reason": null,
                 "overrides": [ { "name": "project:alpha", "action": "replace", "text": "…" } ] },
  "workspace": { "layer": "workspace", "enabled": false, "path": null, "reason": "…", "overrides": [] },
  "merged":    { "overrides": [ { "name": "project:alpha", "action": "replace", "text": "…", "layer": "workspace" } ] }
}
```

`merged` is exactly the list the assembly handler applies for this session.
`enabled: false` always carries a `reason`; the layer still reports its `path`
when one could be resolved.

## 4. `PUT` and `DELETE /prompt-setting/overrides`

### 4.1 `PUT` (Revision 7: the reserved section and `replace`, nothing else)

Body:

```json
{ "layer": "user" | "workspace", "session": "<id>", "section": { "name": "prompt-setting:custom-prompt", "action": "replace", "text": "…" } }
```

**The write face is one name wide.** `section.name` must be exactly
`prompt-setting:custom-prompt` (§15.1) and `section.action` must be exactly
`replace`. The policy is evaluated in this order, before the target layer is
resolved and before the current config is read — i.e. before any byte could be
written:

1. `layer` must be `user` \| `workspace`, else `400 unknown-layer`;
2. a `name` that is a non-empty string other than the reserved one is
   **`403 write-locked`**. This is a wall, not a field error: the name is legal,
   this route simply may not write it any more. The message names both the
   refused name and the one writable name;
3. the reserved name accepts **exactly** `action: "replace"`. Anything else —
   including an absent or unknown action — is **`400 unsupported-action`**. The
   action is therefore never validated by the field validator on this route, which
   is what makes the narrowing two codes instead of a soup of field errors;
4. only then are the `replace` fields validated (`400 missing-text`,
   `413 text-too-large`) and the layer resolved (`400 workspace-unresolved`,
   `409 layer-not-writable`).

A request with no usable `name` at all (absent, empty, not a string) is **not** a
policy question: it is a malformed override, so the policy does not fire and the
field validator still answers `400 missing-name` / `400 invalid-override`.

Other rules, unchanged from Revision 6:

- `session` may be given in the body or as `?session=`; the body wins.
- Upsert keyed by `name`, so saving the reserved section twice replaces rather
  than duplicates, and a frozen entry in the same layer is never touched.
- `order` is only legal for `append`, which this route no longer accepts; a body
  carrying it is refused by rule 3 before that rule is ever consulted.

Response `200` (byte-identical to Revision 6):

```json
{ "ok": true, "saved": { "name": "prompt-setting:custom-prompt", "action": "replace", "text": "…", "layer": "user" }, "effectiveFrom": "next-turn" }
```

### 4.2 Target paths — the client never supplies one

| Layer | Path | Resolved from |
| --- | --- | --- |
| `user` | `$DSH_HOME/prompt-setting/overrides.json` | `process.env.DSH_HOME`, else `~/.dsh`. |
| `workspace` | `<workspaceRoot>/.dsh-prompt-setting/overrides.json` | `ctx.workspaceRegistry.list()` filtered by `sessionIds.includes(sessionId)`. |

`process.cwd()` is never used. A client-supplied path is not a parameter of any
route, so an attacker cannot redirect a write.

### 4.3 `DELETE` (Revision 7: the reserved name only)

Query: `layer` (required), `name` (required), `session` (required for the
`workspace` layer).

The order of the checks is part of the contract:

1. `layer` must be `user` \| `workspace`, else `400 unknown-layer`;
2. request shape: `400 missing-name` when `?name=` is absent or empty, and
   `400 name-too-long` when it is over 200 characters — a name this route could
   not act on under any policy;
3. **`403 write-locked`** when the name is not the reserved one. This verdict is
   reached **before** the presence lookup, so "this name is frozen" is never
   reported as `404 override-not-found` — those are different facts, and only one
   of them is true;
4. `404 override-not-found` when the reserved override is not in that layer.

Response `200` (unchanged): `{ "ok": true, "removed": true, "layer": "…", "name": "prompt-setting:custom-prompt", "effectiveFrom": "next-turn" }`.

### 4.4 Errors

Every rejection is `{ "ok": false, "code": "…", "message": "…" }` with a
human-readable `message`.

| Status | `code` | Cause |
| --- | --- | --- |
| `400` | `invalid-json` | The `PUT` body is not valid JSON. |
| `400` | `invalid-override` | `section` is missing or not an object. |
| `400` | `missing-name` | `name` missing/empty (PUT `section`, or DELETE `?name=`). |
| `400` | `name-too-long` | `name` longer than 200 characters. |
| `400` | `invalid-name` | `name` contains control characters. |
| `400` | `unknown-action` | `action` is not `replace` \| `hide` \| `append`. |
| `400` | `missing-text` | `replace`/`append` without a string `text`. |
| `400` | `unexpected-text` | `hide` carrying `text`. |
| `400` | `invalid-order` | `order` is not a non-negative integer. |
| `400` | `unexpected-order` | `order` on a `replace`/`hide`. |
| `400` | `unknown-layer` | `layer` is not `user` \| `workspace` (also for a missing `layer`). |
| `400` | `workspace-unresolved` | `layer=workspace` with no session, or a session no workspace owns. |
| `403` | `write-locked` | **Revision 7.** `PUT`/single-name `DELETE` named a section other than the reserved one, or an import document carried one. Nothing was written (§15.5, §15.7). |
| `400` | `unsupported-action` | **Revision 7.** The reserved name was written with an action other than `replace` — including an absent or unknown one (§4.1). |
| `400` | `conflicting-query` | **Revision 7.** `?reset=true` and `?legacy=true` were both supplied (§12.2). |
| `404` | `override-not-found` | `DELETE` for the reserved name that layer does not hold. |
| `405` | — (empty body + `allow`) | Unsupported method on a known path. |
| `409` | `layer-not-writable` | The target file exists but is not a valid config; it is never overwritten. |
| `413` | `text-too-large` | `text` over 200 KiB (204800 UTF-8 **bytes**). |
| `413` | `body-too-large` | The whole request body over 256 KiB. |
| `503` | `assemble-failed` | `systemPrompt.assemble()` threw while building the snapshot. |
| `503` | `trust-fence-unavailable` | No `connection` service to run the fence. |
| `400` | `invalid-export` | The import body is not a JSON object. |
| `400` | `unknown-export-schema` | `schema` is not `dsh-prompt-setting/export`. |
| `400` | `missing-export-version` | The document has no integer `version`. |
| `400` | `unsupported-export-version` | `version` is not the version this build accepts. |
| `400` | `missing-export-layers` | `layers` is absent, not an object, or carries no known layer. |
| `400` | `missing-export-layer` | `?layer=` names a layer the document does not carry. |
| `400` | `invalid-export-layer` | A layer is not an object, or `overrides` is not an array. |
| `400` | `unknown-import-mode` | `mode` is not `merge` or `replace`. |
| `400` | `missing-diff-selector` | `diff` was called with neither `?from=` nor `?to=`. |
| `400` | `invalid-diff-selector` | A selector is neither `current` nor a history id. |
| `404` | `history-not-found` | `diff` named a history id that layer's log does not hold. |
| `500` | `import-verify-failed` | A staged temp file failed its own read-back validation; nothing was replaced. |
| `500` | `import-staging-failed` | A staged temp file could not be written; nothing was replaced. |
| `500` | `import-commit-failed` | A rename failed during the commit; the message says how many layers were already replaced. |

An import **reuses** the stage 1B field-validation codes verbatim for a bad
entry inside the document (`invalid-override`, `missing-name`, `name-too-long`,
`invalid-name`, `unknown-action`, `missing-text`, `unexpected-text`,
`invalid-order`, `unexpected-order`, `duplicate-name`, `text-too-large`), with
the exact location in `message` (`layers.user.overrides[1]: …`). `unknown-layer`,
`workspace-unresolved` and `layer-not-writable` keep their meaning for every
stage 2 route as well. `body-too-large` keeps its `413` status; its message
names the cap that applied (256 KiB for `PUT`, 4 MiB for `import`).

Since Revision 7 the order between the document's own validation and the write
lock is fixed: the document is schema- and field-validated **first**, so a
malformed entry answers its field code, and only a *well-formed* entry with a
frozen name reaches `403 write-locked` (§11.1). On `PUT` the order is the
opposite by design — the name is the subject of that request, so the wall comes
before every field rule except `layer` and the absence of a name (§4.1).

Two writes deliberately refuse rather than guess: an unreadable layer file is
`409` and is left untouched, and a workspace that cannot be resolved is `400`
rather than a fallback path.

## 5. Semantics

### 5.1 `order` is an array index

`PromptAssembly.sections` is already in canonical order and carries no `order`
field; `getSectionOrder(name)` accepts only a closed enum of repository names
and returns `undefined` for a third-party section. The contract therefore
exposes `index` (the array position) everywhere and treats `append`'s `order` as
a target index. **No numeric order is ever fabricated.**

### 5.2 Two layers, workspace wins

`user` and `workspace` are merged before application. A workspace override wins
over a user override for the same `name` and keeps the user entry's position, so
switching layers never reshuffles. A workspace-only override is appended after
the user entries, in file order.

### 5.3 Zero-diff without overrides

With no override resolving for a scope, the waterfall listener returns the
downstream assembly **by identity** — the same object the Host would have
returned. With overrides, only the `sections` array is replaced; nothing else in
the assembly is touched. The listener always calls `next()`, so it never vetoes
another listener.

Revision 7 adds one always-present empty section to the *registered* list
(§15.2), which does not affect this rule: identity is decided by whether an
override resolved, never by a section count. The stronger claim this revision adds
is about the **rendered prompt**: unconfigured, it is byte-identical to the prompt
of a profile without this plugin, asserted against the shipped renderer in
`test/integration.test.mjs`.

Revision 8 adds a second listener on the same event, and it obeys this rule twice
over: it returns the downstream value **by identity** unless it actually moves the
reserved section, and the move itself replaces only `sections` (§15.10). So "no
override configured" still means the same object comes back, and "nothing to move"
means it comes back even when an override *was* applied.

### 5.4 Effect boundary

`effectiveFrom: "next-turn"` is literal: config is held in memory and read by
the listener, so a save affects the **next** assembly (next turn / next
session). A turn already assembling is unaffected.

### 5.5 Refresh semantics and no IO on the assembly path

Layers are read when the plugin mounts and then re-read — **both of them**, as
peers — by `refreshLayers()`, the first statement of every handled route request
and therefore before anything in that request can fail (Revision 5):

- an external edit (a hand edit, a config-sync tool, another process) is visible
  to the very next request, with no remount and no file watcher;
- a request that fails refreshed first too, so a failed write or a rejected
  import leaves the cache no further behind the files than that single request.
  Every write path reaches the cache only after its own file write returned, so
  a failure cannot reach it at all;
- the waterfall listener performs **no IO whatsoever**: it reads the in-memory
  cache these refreshes maintain and nothing else. A change on disk is never
  observed *during* an assembly — it is observed by the next request, and a real
  turn picks it up from there.

A workspace created after mount is picked up by the next handled request; until
that request its layer contributes nothing (it is not silently guessed). The same
now holds for a workspace or user file edited outside this plugin.

Requests that never reach a handler — a fence rejection, an unknown path, a wrong
method — perform no IO and answer exactly as they did before.

### 5.6 Failure isolation

A layer that cannot be read or validated is reported as `enabled: false` with a
`reason` and contributes nothing. An error inside the override application fails
**open** (the assembly is returned unchanged) so a broken override can never
break a user's turn.

An absent file is not a failure. A file that has never existed is an empty,
`enabled: true` layer (and this is what a fresh install reports). The one absence
reported as a failure is a **user-layer file this mount read and that has since
been removed**: `enabled: false` with a `missing-file: …` reason, so "the file is
gone" can never be read as "this layer holds no overrides" (§5.5). Either way the
layer contributes nothing, so an override can never stay alive on a file that is
no longer there.

### 5.7 Per-turn workspace selection

Real turns dispatch `assemble()` with `AssembleContext = { agent, scope: agent }`
(`dsh-agent`'s `assembleContextFor`), and `Agent.id` is the session id. The
listener reads `context.agent.id` (falling back to `context.scope.id`) to choose
the cached workspace layer — still zero IO.

### 5.8 Scope of the snapshot

The snapshot describes the assembly **under the requested scope**: the session's
own `Agent` scope when `?session=` names a live agent, otherwise the global view
via this plugin's private probe scope. `base`/`effective` therefore contain the
scoped sections a real turn for that session would see, and `frozenScope` always
says which of the two the verdict is about (§2.4).

Two consequences worth stating:

- the same mount can legitimately report `frozen: true` for one session and
  `frozen: false` for the global view — that is the point, not an inconsistency;
- a session that supplies no workspace row still gets a scope-correct verdict;
  the two selectors are independent.

The override handler itself is scope-correct for every scope it sees, including
any scope this plugin never probes.

## 6. E1–E5: measured conclusions

Every line is an observation from `test/integration.test.mjs`, which runs the
real `@deepseek-ai/dsh-system-prompt` and `@deepseek-ai/cordis` packages in a
real Cordis context. The snapshot republishes the same text in `experiments`.

- **E1** — `assemble()` with no argument is legal and returns the registered
  global sections already in canonical order (`harness:identity`,
  `deployment:persona-prefix`, custom sections by their `order`,
  `deployment:persona-suffix`). Each section is `{name, text}` only: no `order`
  and no `complete`. Their position **is** the order.
- **E2** — `system-prompt/assemble` is an outermost-first waterfall. Listeners
  run in registration order (`outer:in → inner:in → inner:out → outer:out`),
  `next()` resolves the downstream value, a listener that never calls `next()`
  vetoes every later listener and its return value becomes authoritative, and a
  listener may `await next()` to transform the downstream result. Registration
  order is not the whole story: a listener with `{prepend: true}` is **unshifted**
  to the front (the platform itself registers this way), so it is outer to every
  listener that was already registered — and, symmetrically, a listener registered
  **after** it with the same option becomes outer to it. `prepend` is therefore a
  relative ordering, not a promise of being the outermost listener in the
  waterfall. Revision 8's keeper is such a listener; it is outer to every listener
  registered before this plugin, which is what lets it run after their
  post-`next()` steps (§15.10). Revision 15's expansion does not depend on this
  position at all (§16.9.4).
- **E3** — a registered `complete: true` section overrides the whole scope: even
  with the section list rewritten inside a listener, the final assembly is
  exactly `[that section]` with its **original registered text** (a rewritten
  copy is reverted). The listener loses for every section, not just that one.
  Without a complete section the same edit survives.
- **E4** — a scoped section shadows a global section of the same name within its
  scope while the global view is unchanged, and a listener registered on the
  **root** context does receive scoped dispatches (a listener tagged below the
  dispatch scope would not).
- **E5** — the snapshot reports `mounted: true` only when this plugin's listener
  observed the probes. When the plugin is disabled or unloaded its routes are
  unregistered with it, so the UI observes the absence as an unreachable
  endpoint rather than as `mounted: false`. **This is an inference from the
  plugin lifecycle, not a live observation of a disabled plugin** — the
  integration checkpoint (supervisor-side) is what would confirm the disabled
  case end to end.

## 7. Known limitations (stated, not hidden)

1. **`rendered` interpolates differently from a real turn** for unresolved
   `{{references}}` (§2.3). Deliberate: the snapshot must not throw, and it must
   never show a value that does not exist. `renderedResolved` /
   `unresolvedVariables` are how the UI stays honest about it, and since
   Revision 10 `unresolvedThrowing` / `unresolvedLiteral` say whether the real
   assembly would throw or would read the braces as written.
2. **A session with no active Agent gets a `frozenScope: "global"` verdict, not
   a session one** (§2.4). The response says so in `frozenScopeReason`; the UI
   must present that as unknown-for-this-session rather than as "not frozen".
   Probing a session whose Agent has not been created yet is not possible through
   this API.
3. **A workspace the Host has not published yet contributes nothing.** The
   plugin re-reads `workspaceRegistry.list()` — and every layer file — at the
   start of every handled request (§5.5), so a workspace created after mount
   becomes visible at the next request: never mid-request, and never through a
   watcher. A workspace the registry has not listed yet is invisible until it
   does; the plugin never guesses a path.
4. **A scope whose registered sections change between the two probes** could
   make `base` reflect the first probe while `effective` reflects the second.
   Both probes are `assemble()` calls microseconds apart; the frozen verdict
   itself depends only on the first probe, so this cannot corrupt it.
5. **`complete` is `"unknown"`** when no probe can prove it. It is never
   guessed.
6. **The probed context is not byte-identical to a real turn's**: this plugin
   passes `{agent, scope: agent}` (no `signal`), so a section or variable
   provider that branches on `context.signal` would see a difference. No shipped
   provider reads it.
7. **`unresolvedVariables` cannot distinguish "no such variable" from "the
   provider returned `undefined`"** — the assembly only carries the value. Both
   are reported the same way, and both mean the same thing to a reader: the
   value had no context here.

Stage 2 (Revision 4) adds these:

8. **A history record carries full text**, so one record can hold up to two
   200 KiB bodies. The file is bounded by `retentionLimit` records, not by
   bytes; lowering `historyLimit` is the only way to bound it further.
9. **The history log is per directory and outlives the config it describes.**
   Deleting `overrides.json` by hand does not clear `history.jsonl`, and a layer
   whose config file is invalid (`409 layer-not-writable`) can still have a
   readable log.
10. **An import commits per file, not across layers** (§11.6). The renames are
    atomic individually; a filesystem failure between them can leave one layer
    replaced. Everything before the renames is all-or-nothing.
11. **`sections` in a diff carries no text.** Two versions are compared from
    their `{name, action, hash, bytes}` snapshots, so a name that differs is
    reported — with its actions and digests — but its text is only available for
    the one section the comparison focuses on (§9.3).
12. **`hash` is not text equality across unrelated writes**: it is a SHA-256 of
    the UTF-8 text, so equal hashes mean equal text, but a `hide` has no hash at
    all and therefore compares by action only.
13. **The fallback diff renderer shows at most 400 ops** and says so. The host's
    op list is capped at 4000 entries with `truncated: true`; neither cap loses
    the counts, only the rendered rows.
14. **The client's import file picker uses `File.text()`**. A browser without it
    gets the paste-the-JSON path (and the panel says so) rather than a second
    reading implementation.

Stage 3 (Revision 5) adds one:

15. **The refresh bounds a desync to one request; it does not explain an
    observation already made.** A measured session showed an override in effect
    at one turn and absent at a later one with its file byte-identical, after a
    rejected import. Revision 5 makes a *stale cache* (an override that keeps
    applying to a file that no longer says so) impossible beyond one request,
    and its tests pin that no write path — the rejected import included — can
    leave the cache disagreeing with the files. It does **not** claim to explain
    an override that *stops* applying while its file is intact: the desync that
    can be constructed and pinned here is the opposite direction.

Revision 7 adds these:

16. **A frozen override is writable only by hand.** No route creates, updates or
    imports one; `?legacy=true` removes the whole frozen half and `?reset=true`
    removes everything. That is a policy choice with a cost, stated here rather
    than discovered: a user who wants to change one frozen entry must edit the
    layer's file (§15.6, §15.8).
17. **The plugin's own section is visible in `base`/`effective` even when empty**
    (§15.2). The rendered prompt is unaffected, but any consumer that compares
    those arrays to a Revision 6 baseline will see one extra entry.
18. **A `complete: true` scope discards the user's text** (§15.4). Reported as
    `frozen` with a reason and `applied: false` on the reserved entry, but it is
    not prevented: this plugin does not (and cannot) outrank a complete section.
19. **The registered section's effect on a *real* `dsh web` process is not
    verified here** — observing it needs a Host restart. Everything observable
    offline is verified against the real service and the real renderer (§15.9).
20. **`order: 1000000` is not a guarantee against a third party** (§15.1). It
    sorts after every section the DSH repository defines; another plugin may
    still legitimately register a larger finite order and sort after this one.
21. **Resolved in g-015: the client no longer offers the Revision 6 editor.**
    The settings page is the first-level tabs of §13 (five since Revision 19),
    and its only write surface is
    「我的 Prompt」, which writes the reserved name with `replace` — so no UI
    path can ask for a write the Host would refuse. What remains a *limitation*
    of the narrowed write face is recorded in §15.8: a frozen override can only
    be removed by the layer-wide `?legacy=true` clear (§12.2) or by hand.
    The tab order, defaults and markers are specified in §13.0; the client
    cannot enforce the freeze, only state it.

Revision 8 adds these — the three residuals of the lastness promise (§15.10),
stated here because none of them can be fixed from inside this plugin:

22. **A `complete: true` scope still discards the whole section list, the keeper's
    move included** (§15.4, §15.10 residual 1). The user's text does not reach the
    prompt in such a scope. The snapshot reports the freeze rather than hiding it,
    but the outcome is not prevented: a complete section outranks every listener.
23. **A listener that registers with `{prepend: true}` *after* this mount can still
    append a section after ours** (§15.10 residual 2). `prepend` is first-come,
    first-served at the front of the list, so a later prepend outranks the keeper;
    whatever such a listener appends really is last. The plugin cannot claim
    otherwise, and does not try to re-order sections it does not own.
24. **The keeper is not verified on a live `dsh web`** (§15.10). It is a Host-half
    change, so observing it needs a Host restart, which Revision 8 did not do —
    exactly the same standing limitation item 19 records for the registration
    itself. What is verified against the real service, the real renderer and a
    `dsh-expression`-shaped listener is in `test/integration.test.mjs`.

## 8. `GET /prompt-setting/history` (Revision 4; scope and paging in Revision 19)

Query: `layer` (**required** — a log lives beside one layer's config file, so
there is no meaningful default), `session` (optional), `workspace` (optional,
Revision 19), `name` (optional filter), `limit` (optional page size), `offset`
(optional page start, Revision 19), `before` (optional **exclusive** ISO upper
bound on `at`).

`session` and `workspace` are both session ids, and the difference between them
is the point of Revision 19:

| Parameter | Meaning |
| --- | --- |
| `session` | **Explicit filter.** Absent or empty ⇒ the layer's **whole** log, which is what the user layer always is. Present ⇒ the log is narrowed to the records that session wrote (and, as before, it locates the workspace root for `layer=workspace`). |
| `workspace` | **Resolution scope only.** A session id that says *which workspace* the reader is looking at: it locates that workspace's `history.jsonl` and **never** narrows the records. This is what 「版本历史」's own workspace selector sends, so choosing a workspace shows that workspace's whole log rather than the slice written by the one session that happened to resolve it. |

Neither parameter is ever a path: a workspace root still comes from the Host's own
session index (§4.2). When both are supplied, `session` resolves and filters while
`workspace` is only consulted if `session` could not resolve a root.

### 8.1 Where the log lives

| Layer | Path |
| --- | --- |
| `user` | `$DSH_HOME/prompt-setting/history.jsonl` |
| `workspace` | `<workspaceRoot>/.dsh-prompt-setting/history.jsonl` |

One JSON object per line, appended. A client-supplied path is still not a
parameter of any route (§4.2).

### 8.2 Response

```json
{
  "ok": true,
  "layer": "user",
  "session": null,
  "scopeSession": null,
  "path": "/home/u/.dsh/prompt-setting/history.jsonl",
  "enabled": true,
  "reason": null,
  "retentionLimit": 100,
  "pageLimit": 50,
  "offset": 0,
  "total": 3,
  "pageCount": 1,
  "hasMore": false,
  "corrupt": 0,
  "unreadable": null,
  "lastError": null,
  "records": [
    {
      "id": "3", "seq": 3, "at": "2024-01-02T10:00:00.000Z",
      "layer": "user", "session": null,
      "action": "replace", "name": "project:alpha", "origin": "ui",
      "before": { "text": "alpha base", "hash": "…", "bytes": 10 },
      "after":  { "text": "alpha overridden", "hash": "…", "bytes": 16 },
      "entries": null,
      "snapshot": [ { "name": "project:alpha", "action": "replace", "hash": "…", "bytes": 16 } ],
      "note": null
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | `String(seq)`. **The stable handle** a client passes back as `?from=` / `?to=`. It survives trimming; an array index would not. |
| `seq` | Per-file monotonic counter, assigned at append time. |
| `at` | ISO timestamp of the write. |
| `action` | `replace` \| `hide` \| `append` \| `remove` \| `reset-layer`. |
| `name` | The targeted section; `null` **only** for `reset-layer`, whose subject is the whole layer. |
| `origin` | `ui` (the settings page) \| `import` (`POST /import`). |
| `before` / `after` | `{text, hash, bytes}` or `null`. `hash` is the SHA-256 of the UTF-8 text, `bytes` its UTF-8 length. `null` means "no value": a `hide` has no text, the first write of a name has no `before`, a removal has no `after`. |
| `entries` | Only on a `reset-layer` record: the removed overrides with their **full text** (`{name, action, text?, order?}`), so a reset is reconstructible from the log alone. |
| `snapshot` | The layer's override list **after** that write, as `{name, action, hash, bytes}` — no text. This is what makes §9 possible without loading N prompt bodies. |
| `note` | Free-form provenance (`import mode=merge status=replaced`), or `null`. |

Top-level fields beyond §8.2's original set:

| Field | Meaning |
| --- | --- |
| `session` | The **filter** actually applied: the explicit `?session=` value, or `null` when none was supplied (or it was empty). A `null` here means "this layer's whole log". |
| `scopeSession` | The session id that **located** the file (`?session=` if it was given, else `?workspace=`, else `null`). Independent of `session`: `?layer=workspace&workspace=s1` answers `scopeSession: "s1"` with `session: null`, i.e. that workspace's whole log. |
| `offset` | The page start **actually used**, after clamping (Revision 19). |
| `pageCount` | `ceil(total / pageLimit)`, or `0` when `pageLimit` is `0` (the counts-only request). |
| `hasMore` | Whether a page after this one exists: `pageLimit > 0 && offset + pageLimit < total`. |

Records are returned **newest first** (`seq` descending) and the page is a window
into that ordered, filtered list: `total` counts every match before paging, and
`offset`/`limit` select the window. `limit` is clamped to `[0, 500]` and `0` is a
legal request for the counts alone; an unusable `limit` falls back to `50`. An
**unusable** `offset` (absent, empty, negative, fractional, unparsable) means `0`,
and an `offset` **past the end** is clamped to the start of the last page — so a
stale page number renders the newest records rather than an empty window, and no
page number is ever an error (Revision 19).

### 8.3 Bounded by construction

- The newest **N** records of each layer are kept. `N` is 100 by default and is
  configurable — `apply(ctx, {historyLimit})`, or the environment variable
  `DSH_PROMPT_SETTING_HISTORY_LIMIT` when config does not say — clamped to
  `[10, 10000]`. An unusable value is ignored, never fatal.
- Appending is one `appendFileSync`: the existing bytes are a prefix of the new
  file. The file is rewritten only when it must be — when the append would pass
  the bound, or to heal a line that could not be parsed.
- Reading is tolerant: a corrupt line is counted in `corrupt` and skipped. An
  unreadable file answers `unreadable` with the records it could still parse,
  and the route still returns `200`.
- `lastError` carries the most recent **failed append** (`{at, reason}`) for this
  file, or `null`. This is where a history write failure becomes observable: a
  successful write's own response body is frozen (§8.4), so the failure cannot
  be reported there.

### 8.4 A history failure never changes a write's outcome

`PUT` and `DELETE /prompt-setting/overrides` keep their revision 3 response
bodies **byte for byte** — no new field, no new key. The config file is written
first, then the record is appended; if the append fails, the write still
succeeds and the failure appears as `lastError` on the next `GET /history`.
History is a log, not the source of truth (same isolation rule as §5.6).
`DELETE …&reset=true` is new in this revision, so its body *does* report the
history outcome (§12).

## 9. `GET /prompt-setting/diff` (Revision 4; scope in Revision 19)

Query: `layer` (required), `session` / `workspace` (the scope, read exactly as
§8 reads it since Revision 19 — `workspace` locates, `session` filters, so a
comparison always describes the same file the log beside it lists), `from` and
`to` (each a history id or the literal `current`), `name` (optional: which
section to compare line by line).

Exactly one of `from`/`to` may be omitted, and the omitted one means `current`.
Omitting **both** is `400 missing-diff-selector`: there is nothing to compare.

### 9.1 Response

```json
{
  "ok": true,
  "layer": "user",
  "session": null,
  "scopeSession": null,
  "historyPath": "/home/u/.dsh/prompt-setting/history.jsonl",
  "scope": "layer",
  "from": { "kind": "history", "label": "#1", "layer": "user", "session": null,
            "id": "1", "seq": 1, "at": "…", "action": "replace", "name": "project:alpha" },
  "to":   { "kind": "current", "label": "current", "layer": "user", "session": null,
            "id": null, "seq": null, "at": null, "action": null, "name": null },
  "sections": [
    { "name": "project:alpha", "status": "changed",
      "before": { "action": "replace", "hash": "…", "bytes": 10 },
      "after":  { "action": "replace", "hash": "…", "bytes": 16 } }
  ],
  "sectionsCounts": { "total": 1, "changed": 1, "added": 0, "removed": 0, "same": 0 },
  "lines": {
    "name": "project:alpha",
    "ops": [ { "type": "equal",  "text": "alpha", "beforeLine": 1, "afterLine": 1 },
             { "type": "delete", "text": "base",  "beforeLine": 2, "afterLine": null },
             { "type": "insert", "text": "overridden", "beforeLine": null, "afterLine": 2 } ],
    "stats": { "added": 1, "removed": 1, "same": 1 },
    "mode": "lcs",
    "crlfNormalized": false,
    "truncated": false,
    "textBefore": "alpha\nbase",
    "textAfter": "alpha\noverridden"
  },
  "lineReason": null,
  "stats": { "added": 0, "removed": 0, "changed": 1, "same": 0, "lineAdded": 1, "lineRemoved": 1 }
}
```

### 9.2 Section level

`sections` compares the two versions' `snapshot` lists by name:

| `status` | Meaning |
| --- | --- |
| `same` | Present in both with the same `action`, `hash` and `bytes`. |
| `changed` | Present in both, but the action or the content digest differs. |
| `added` | Only in the newer version. |
| `removed` | Only in the older version. |

A version's snapshot is the layer's override list **after** that write (`current`
is the layer's live list). Rows keep the older version's order, then the
newer-only names.

### 9.3 Line level

The comparison picks **one** section to compare text by text, in this order:
the explicit `?name=`; then the section both versions are about (when `from` and
`to` name the same one); then the single differing section; then the section one
side is about; otherwise `lines` is `null` and `lineReason` says why (`more than
one section differs; pass ?name= to compare one of them`).

- `textBefore` / `textAfter` are that section's two values (`null` when a side
  holds no text, e.g. the section did not exist) and are what a renderer such as
  the primitives `DiffBlock` consumes. Each is bounded by the 200 KiB
  per-override cap.
- `ops` is the diff itself: `equal` carries both line numbers, `delete` only
  `beforeLine`, `insert` only `afterLine`; every op carries its `text`.
- `mode` is `"lcs"` when the exact comparison ran and `"bounded"` when the input
  exceeded the budget (`2000` lines per side, `1 000 000` table cells). A bounded
  result keeps the shared prefix and suffix as `equal` rows and reports the
  differing middle as one delete block followed by one insert block — it is
  labelled, never passed off as exact.
- Line ending handling is explicit: `\r\n` and `\r` both split lines, so two
  texts that differ only in line endings compare equal, and `crlfNormalized:
  true` says the difference was ignored rather than hidden.
- `ops` is capped at 4000 entries with `truncated: true`; `stats` still
  describes the whole change.

## 10. `GET /prompt-setting/export` (Revision 4; narrowed in Revision 7)

Query: `layer` (optional — limit the document to one layer), `session` (to
resolve the `workspace` layer).

```json
{
  "ok": true,
  "schema": "dsh-prompt-setting/export",
  "version": 1,
  "exportedAt": "2024-01-02T10:00:00.000Z",
  "plugin": { "name": "dsh-prompt-setting", "version": "0.1.5" },
  "pluginVersion": "0.1.5",
  "layers": {
    "user":      { "layer": "user", "enabled": true,
                   "reason": null,
                   "overrides": [ { "name": "prompt-setting:custom-prompt", "action": "replace", "text": "…" } ] },
    "workspace": { "layer": "workspace", "enabled": false,
                   "reason": "no ?session= was supplied, so the workspace layer is inactive for this view",
                   "overrides": [] }
  },
  "exportScope": { "only": "prompt-setting:custom-prompt", "omitted": { "user": 2, "workspace": 0, "total": 2 } }
}
```

`ok` is this plugin's liveness flag; the rest of the body **is** the document and
is what a client should save. No absolute path is exported: the document is
portable. With `?layer=user` only that layer is present. An export taken without
a session therefore carries an empty, disabled `workspace` layer, and that same
document can be re-imported without a session (§11.3).

**Revision 7 — the document is the reserved section only, and it says so.**
`layers.<layer>.overrides` holds at most the reserved override, because that is
the only entry an import would accept again (§15.7). Frozen entries are **not
silently dropped**: `exportScope` is a new top-level field of the response that
declares the scope of this export.

| Field | Meaning |
| --- | --- |
| `exportScope.only` | The one section name the document may carry: `prompt-setting:custom-prompt`. |
| `exportScope.omitted.<layer>` | How many overrides that layer holds but this export left out, computed from the layer view this process could read. |
| `exportScope.omitted.total` | The sum over the layers this export covers. |

`omitted` is keyed by exactly the layers the response carries (so
`?layer=user` yields `{ "user": n, "total": n }`), and a layer whose config is
unusable contributes `0` with its own `reason` — `0` means "none readable", not a
claim that the file is empty. The `schema`, `version`, `plugin`, `pluginVersion`
and `layers.*.layer/enabled/reason` fields are byte-identical to Revision 6; a
consumer that ignores `exportScope` reads exactly what it read before, minus the
entries it could no longer import.

## 11. `POST /prompt-setting/import` (Revision 4; narrowed in Revision 7)

Query: `dryRun` (exactly `true` to preview), `mode` (`merge` | `replace`),
`layer` (optional — import only that layer), `session`. Body: one export
document. Body cap: **4 MiB** (`413 body-too-large` beyond it).

### 11.1 The order is the contract

1. **parse** the body as JSON (`400 invalid-json`), and cap its size;
2. **validate** the document: schema, version, layers, and every override field
   through the same validator `PUT` uses (§4.4);
3. **apply the write lock** (Revision 7): the document must carry no section name
   other than the reserved one, **in any layer**, else `403 write-locked`. This
   step sits before the dry-run branch on purpose — a dry run answers the same
   question the real run would answer, and neither may touch a byte (§15.7);
4. **resolve** every target — the layer, and the workspace root for
   `workspace` (`400 workspace-unresolved`) — and refuse to overwrite a config
   file that cannot be read (`409 layer-not-writable`);
5. **apply the conflict strategy** in memory and compute the plan;
6. on `dryRun`, **return the plan and stop** — nothing has been opened for
   writing;
7. **stage** each target: write a uniquely named temp file in the target's
   directory, then **read it back and validate it**;
8. **commit**: `rename` each staged temp file over its target (atomic per file).

A failure in steps 1–5 or 7 removes every temp file and throws. The real config
files were never opened for writing before step 8, so they are **byte-identical**
to what they were — this is asserted in `test/stage2.test.mjs` with a SHA-256 of
each file, not merely with a 4xx status.

### 11.2 Response

```json
{
  "ok": true, "dryRun": false, "mode": "merge", "session": null,
  "layers": {
    "user": { "counts": { "added": 1, "replaced": 1, "unchanged": 0, "removed": 0, "kept": 1 },
              "changes": [ { "name": "project:alpha", "status": "replaced", "action": "replace" } ],
              "path": "…", "enabled": true }
  },
  "imported": ["user"],
  "skipped": [ { "layer": "workspace", "reason": "…", "entries": 0 } ],
  "totals": { "added": 1, "replaced": 1, "unchanged": 0, "removed": 0, "kept": 1 },
  "unchanged": false,
  "applied": true,
  "written": ["/home/u/.dsh/prompt-setting/overrides.json"],
  "history": { "user": [ { "name": "project:alpha", "status": "replaced", "ok": true, "id": "4", "seq": 4, "dropped": 0, "rewritten": false } ] }
}
```

`counts.kept` is the number of local entries the document does not mention and
that survive the strategy. `unchanged: true` means the plan changes nothing: no
file is written, no history is appended, `applied: false`. `changes[].name` is
reported with `status` `added` \| `replaced` \| `unchanged` \| `removed`; the
body never carries prompt text.

### 11.3 Which layers an import touches

- Without `?layer=`, the layers the document carries.
- A layer the document carries that **cannot be resolved** (a `workspace` layer
  with no session/workspace) is **skipped** and reported in `skipped` when the
  document asks for nothing in it (`entries: 0`). When the document *does* carry
  entries for it, the import fails with `400 workspace-unresolved` **before
  anything is staged** — a silent partial import is the failure mode this rule
  exists to prevent.

### 11.4 Conflict strategy

| `mode` | Rule |
| --- | --- |
| `merge` (**default**) | The imported entry wins on a name clash; a local entry the document does not mention is kept, in place. |
| `replace` | The layer becomes exactly what the document says, so a local entry the document omits is **removed** (its `status` is `removed`). |

`mode` may be given as `?mode=` or as a `mode` field in the body; the query wins.
An unknown value is `400 unknown-import-mode` rather than a silent fallback (the
pure kernel falls back to `merge` only when called without a mode at all).

### 11.5 What an import records

Every changed section gets one history record with `origin: "import"`, its
`action` (`replace`/`hide`/`append`, or `remove` for a `replace`-mode deletion),
its `before`/`after` text and a synthetic `note` (`import mode=… status=…`). The
snapshot on each record is the layer as it stands **after** the import. The
`history` map in the response reports the append outcome per layer; as in §8.4, a
history failure does not undo the import.

### 11.6 Residual risk, stated

The commit is atomic **per file**, not across layers. A filesystem failure
between two `rename` calls leaves the earlier layer replaced and the later one
untouched; the thrown `500 import-commit-failed` message says how many layers
were already committed. No stage before the renames can leave a partial state.

## 12. `DELETE /prompt-setting/overrides` (Revision 4; `legacy` added in Revision 7)

### 12.1 `?reset=true` — clear the whole layer

Clears one whole layer. `layer` is required, `session` as for a write. The value
must be exactly `true`: any other value (including `reset=1`) is **not** the
reset switch and falls through to the single-name semantics, which then requires
`name` (§4.3).

```json
{
  "ok": true, "reset": true, "layer": "user",
  "removed": ["project:alpha", "prompt-setting:custom-prompt"],
  "count": 2,
  "entries": [ { "name": "project:alpha", "action": "replace", "text": "…" },
               { "name": "prompt-setting:custom-prompt", "action": "replace", "text": "…" } ],
  "effectiveFrom": "next-turn",
  "history": { "ok": true, "id": "5", "seq": 5, "dropped": 0, "rewritten": false }
}
```

- The layer's file is rewritten as an empty, valid config (`{"version":1,
  "overrides":[]}`), so a reset is observable on disk rather than implied.
- **Revision 7 does not change this**: a reset clears everything, the reserved
  override included. It is the one write that still removes the reserved entry.
- The removed content is written to history **first-class**: one record with
  `action: "reset-layer"`, `name: null` and `entries` holding every removed
  override with its full text. A reset is therefore reconstructible.
- Resetting an already-empty layer is a success with `count: 0`, `removed: []`,
  `history: null` and no log entry — there was no change to record.
- `effectiveFrom: "next-turn"` is literal (§5.4): the next assembly sees the
  cleared layer; a turn already assembling is unaffected.
- A section-level "restore default" is **not** a route of its own: it is the
  existing single-name `DELETE` applied to each layer that holds the name — which
  since Revision 7 means the reserved section only. For a frozen entry the escape
  hatch is a hand edit of the file (§15.8). The UI performs the second
  confirmation (§13.5) and the host keeps one single-layer write.

### 12.2 `?legacy=true` — clear only the frozen overrides (Revision 7)

Removes every override of the layer whose name is not the reserved one, and keeps
the reserved override. This is the way back from "frozen read-only" to a clean
layer without hand-editing anything.

```json
{
  "ok": true, "legacy": true, "layer": "user",
  "removed": ["project:alpha", "project:beta"],
  "count": 2,
  "entries": [ { "name": "project:alpha", "action": "replace", "text": "…" },
               { "name": "project:beta", "action": "hide" } ],
  "effectiveFrom": "next-turn",
  "history": { "ok": true, "id": "6", "seq": 6, "dropped": 0, "rewritten": false }
}
```

- The response is the reset response with `legacy` in place of `reset`: same
  keys, same types, one flag swapped, so a client that renders one renders the
  other.
- `count: 0` means the layer held nothing frozen. Then **no file is written at
  all** (`history: null`, no log entry, `entries` absent) — "there was nothing to
  remove" must not be recorded as a write, and the file's bytes are left exactly
  as they were.
- The removal is logged as `action: "legacy-clear"`, `name: null`, with every
  removed override and its full text in `entries` and the surviving layer in
  `snapshot`. It is deliberately **not** a `reset-layer` record: the layer still
  holds the reserved override afterwards, and a reader must be able to tell the
  two apart.
- `reset=true` and `legacy=true` together are **`400 conflicting-query`**, with
  nothing read and nothing written.
- The value must be exactly `true`: `legacy=1` is not the legacy switch and falls
  through to the single-name semantics, exactly as `reset=1` does — which then
  requires `name`, and answers `403 write-locked` for any name but the reserved
  one.
- Like every other write, it needs a resolvable layer: `400 unknown-layer` /
  `400 workspace-unresolved`.

### 12.3 The history action vocabulary (Revision 7; `rollback` in Revision 21, narrowed in Revision 22)

`HISTORY_ACTIONS` is now `replace`, `hide`, `append`, `remove`, `reset-layer`,
`legacy-clear`, `rollback`. The first five are Revision 6's set, unchanged and in
the same order, so every existing history file still reads; `rollback` was
appended in Revision 21, so an old reader's vocabulary is a prefix of the new
one. `reset-layer` and `legacy-clear` are the *layer-wide* actions: their subject
is the whole layer, so they are the only records that carry `name: null` and the
only ones rejected when they name a section. **`rollback` is the opposite shape
(Revision 22): it adjusts the reserved section — the only name the write face
accepts (§4.1, §15.7) — so it is an ordinary section record, with `name` =
`prompt-setting:custom-prompt`, `before` / `after` = that section's text and
`entries: null`.** It is deliberately *not* in `LAYER_WIDE_ACTIONS`: a
layer-wide rollback would be a fourth write path around the write lock (§19.1).
`GET /history`
and `GET /diff` report the action verbatim; a client with no label for it must
render the raw value rather than guess. The shipped client has had a label for
every action in this list since g-015 (`histAction.legacy-clear`, and
`histAction.rollback` since g-039), and §13.3 asserts the label reaches the screen
instead of the raw enum.

## 13. Client-side contract (Revision 4; re-ordered in Revision 7, g-015; collapsed scope in g-016)

### 13.0 The five first-level tabs

Since g-015 the settings page is a fixed, ordered set of first-level tabs with
the first one open by default; Revision 19 (g-038) split the old
「历史与备份」 into 「版本历史」 and 「备份与恢复」, so there are five. Above them
there are exactly three things: the
title line — which carries the plugin version beside the heading since Revision
17 (§13.8) — one line of deciding facts, and the session selector every tab
shares — the selector itself is **one line** until「更改」is clicked (§13.7), so
the tab bar and the tab panel are on the first screen.

| order | `data-tab-value` | tab | what it is |
| --- | --- | --- | --- |
| 1 (default) | `mine` | 「我的 Prompt」 | the **only** write surface |
| 2 | `overview` | 「提示词总览」 | strictly read-only |
| 3 | `history` | 「版本历史」 | the log, its own scope and the comparison |
| 4 | `backup` | 「备份与恢复」 | export / import, and nothing else |
| 5 | `advanced` | 「高级」 | legacy list, the two layer-wide clears, full status |

Markers, on top of the Revision 3/4 ones this revision keeps:

- the tab list is `data-region="tabs"` with `data-active-tab="<value>"`, and the
  root container carries the same `data-active-tab`;
- each tab control carries `data-tab-value="<value>"` and its group
  (`data-tab-key="main"` in the fallback branch); the group marker
  `data-tab-group="main"` is carried by the group's container in **both**
  renderer branches — when the official `SegmentedTabs` is used, a
  `display: contents` wrapper carries it, because the official control owns its
  own DOM and cannot be asked to;
- exactly **one** tab panel is rendered: `data-region="tab-panel"` with
  `data-tab-value="<value>"`. Switching a tab renders that tab's panel and no
  other tab's top-level regions. In particular the export/import actions
  (`data-action="export"` / `"import-preview"` / `"import-apply"`, the
  `data-role="import-file"` input and the whole `data-region="transfer"` block)
  exist **only** in the `backup` panel, and the log's own regions
  (`data-region="history"`, `"history-list"`) exist **only** in the `history`
  panel.

### 13.1 「我的 Prompt」 — the one write surface

- The panel is `data-region="mine"`, the layer control is
  `data-region="mine-layer"` (group `mine-layer`, values `user` / `workspace`),
  the text box is `data-role="mine-text"`, and the three controls are
  `data-action="mine-save"`, `data-action="mine-cancel"` and
  `data-action="mine-reset"`.
- The value shown is the reserved section's stored text **for the selected
  layer**, read from the `merged` list of `GET /overrides` — the list the
  assembly applies (§3). An absent entry means "unconfigured", and the panel
  says so in words; it never shows a blank box as if the layer held `""`.
- Saving is exactly `PUT /prompt-setting/overrides` with
  `section: { name: "prompt-setting:custom-prompt", action: "replace", text }`
  (§4.1) and, when a session is selected, `session`. The text is sent verbatim.
- 「恢复默认」 is the single-name `DELETE` (§12.1) for the reserved name and the
  selected layer, behind a second confirmation of kind `mine-reset`.
- 「取消」 (g-027) is the non-destructive counterpart of 「恢复默认」: it drops the
  panel's **unsaved draft** and falls back to the selected layer's stored text
  — one client-side state reset, no request of any kind, no disk byte, and
  **no** second confirmation (nothing that was ever stored is destroyed). It is
  offered exactly while the panel is `data-mine-state="dirty"` (i.e. while
  there is a draft to drop) and is `disabled` otherwise; the stored value, the
  layer's configuration and 「保存」 / 「恢复默认」 are untouched. Both cancel and
  the drafts it drops are scoped to one layer+session key, so cancelling in one
  layer never discards another layer's draft.
- `data-mine-state` is the machine-readable state: `unconfigured` | `dirty` |
  `saving` | `saved` | `error`. A failed write renders a full
  `data-mine-error="true"` banner (`data-error-code`, the mapped copy, the
  host's own `message`) — a failed save is never rendered as `saved`.
- A scope where the text cannot take effect renders
  `data-warning="mine-frozen"` with the reason: `frozenScope: "session"` with
  `frozen: true`, or `frozenScope: "global"` with `frozen: true` while a session
  is selected (the unknown case of §2.4/§7.2). The verdict is the snapshot's
  `frozen`/`frozenScope` **alone** — the reserved entry arriving as
  `applied: false` is not a freeze signal (issue #1): §15.3 defines that as the
  normal state of a section with no override (`reason: null`), and the
  non-frozen failures of the same section — a `replace` that did not stick, a
  `hide` that did not stick, an entry the pipeline dropped — carry
  `applied: false` with a reason too. The write is still allowed (the text is
  stored and takes effect when the freeze lifts); what is forbidden is letting
  it look effective.
- Writing to `workspace` without a session is refused locally, with the same
  `error.workspace-unresolved` copy the host would answer, and sends nothing.

### 13.2 「提示词总览」 is read-only

- The tab renders **no** `data-region="editor"` and **no** write action: the
  strings `edit`, `append-new`, `delete`, `save`, `cancel`, `undo` and
  `reset-section` never appear as a `data-action` in its tree, in either
  renderer branch and in either inner view. This is structural — the row
  builder takes no form and no caller builds one — not a runtime check.
- The Revision 3/4 read-only markers are unchanged: `data-region="sections"`
  with per-row `data-section-row` / `data-origin` / `data-layer` /
  `data-overridable` / `data-applied` / `data-index`, `data-region="filters"`,
  `data-region="full"` with `data-full-text`, `data-region="diff"` with
  `data-diff-*`, plus `data-action="expand"` (full-text disclosure) and
  `data-action="copy"`.
- A row additionally carries the state the applied action produced
  (replace/hide/append) as a tag, and the `editGate` verdict as a read-only
  `data-warning="edit-disabled"` note rather than as a disabled control.
- The reserved section listed in §15.1 is **not** rendered here (it belongs to
  「我的 Prompt」); a `data-note="reserved-own-tab"` line says so. The list and
  the counts therefore exclude it.
- The two inner views (`data-region="view-tabs"`, group `view`, values
  `sections` / `full`) keep their Revision 3 meaning; the Revision 6
  `overrides` view no longer exists.

### 13.3 「版本历史」(Revision 19: its own scope, paging and a two-column layout; scope disclosure and state resets in Revision 20; record preview and rollback in Revision 21; preview policy and the narrowed rollback in Revision 22; viewport-sized layout, row picking and clearing in Revision 23; the panel height measured at run time in Revision 24; one column and viewport modals in Revision 25; the modal details settled in Revision 26; the row's section name removed and the panel's chrome tightened in Revision 27)

- The panel is `data-region="history"` (with `data-history-layer`,
  `data-history-state`, `data-history-total`, `data-history-corrupt`,
  `data-history-unreadable`, `data-history-last-error` as before) and the
  comparison is `data-region="history-diff"` with its `data-diff-*` markers. Both
  keep their Revision 4–18 meaning.
- **The log's own scope.** `data-region="history-scope"` carries
  `data-history-scope-mode` (`workspaces` | `sessions` | `none`),
  `data-history-scope-value` (the session id that locates the file, `''` for
  none), `data-history-scope-options` (how many candidates exist in total) and
  `data-history-scope-applies` (`true` only for the workspace layer — the user
  layer is global). A visible sentence states what is on screen right now:
  `data-role="history-scope-note"` with `data-history-note="global"` (user layer:
  the whole layer, no session filter), `"workspace"` (the named workspace's log,
  with the session that located it) or `"no-session"` (no scope could be
  resolved, so nothing is asked for). When the workspace list is unavailable the
  scope degrades to the session catalog and says so:
  `data-warning="history-scope-degraded"`.
- **The scope is a collapsed disclosure (Revision 20).** It is **one summary
  row** — `data-region="history-scope-summary"` holding
  `data-role="history-scope-summary-label"` (the current scope's name) and one
  switch `data-action="history-scope-toggle"` labelled with the shared
  `scopeEdit` / `scopeCollapse` copy — so the panel's height does not depend on
  how many workspaces exist. `data-scope-open="true" | "false"` on
  `data-region="history-scope"` reports the disclosure, `aria-expanded` /
  `data-expanded` repeat it on the switch, and the picker's body exists **only**
  while it is open. There is no scope control at all when
  `data-history-scope-options` is `0`: the summary row then holds
  `data-role="history-scope-empty"` with the `histScopeNone` copy and renders no
  switch.
- **The open picker.** `data-region="history-scope-picker"` holds a search box
  `data-role="history-scope-search"` and a **fixed-height, internally scrolling**
  candidate list `data-history-scope-list="scroll"` (height = `maxHeight`,
  `overflowY: auto`; `data-history-scope-shown` = how many candidates the search
  left). Each candidate is a `button` with `data-role="history-scope-option"`,
  `data-history-scope-option="<session id>"` and `data-selected="true" | "false"`.
  A search that matches nothing renders `data-role="history-scope-no-match"`
  instead of an empty box. Picking a candidate **finishes the interaction**: the
  scope applies, the picker collapses (`data-scope-open="false"`, the picker and
  the search box are gone) and the search text is dropped — the same
  one-click-closes-it rule as the page-level picker (§13.7).
- **A new file voids every reference into the old one (Revision 20; the preview
  joins it in Revision 21).**
  `diffSel` holds history ids, and an id is only meaningful inside one
  `history.jsonl`. Changing the **layer** (`user` ↔ `workspace`) or the
  **scope** (one workspace → another) changes which file that is, so both paths
  reset the view together: the offset returns to `0`, `diffSel` returns to its
  default (`data-history-selected` empty on every record row, the 「当前生效值」
  row back to `"to"`), the preview record is dropped and **any open modal is
  closed** (Revision 25): no `data-region="history-modal-overlay"`, no
  `data-region="history-preview"`, no `data-region="history-diff"` and no
  `data-diff-sections`.
  **Paging does not reset it**: `data-action="history-prev"` / `"history-next"`
  move inside one file, so the reader's selection and its result stay — and are
  not re-requested.
- **This scope is independent of「查看范围」(§13.7).** The history request is
  built from it, never from the page-level session: changing the page scope
  changes no history request, re-slices no list and re-renders no record. The
  user layer is asked for by `layer=user` **alone** — no `session` at all.
- **Paging.** The pager is `data-region="history-pager"` with
  `data-history-page` (1-based), `data-history-pages` (the response's
  `pageCount`), `data-history-page-size` (the response's `pageLimit`),
  `data-history-offset` (the offset really used, after the host's clamping) and
  the two controls `data-action="history-prev"` / `"history-next"` with
  `data-role="history-page-label"` between them reading「第 x / y 页 · 共 N 条」.
  「上一页」 is `disabled` on the first page, 「下一页」 on the last
  (`hasMore: false`). The bundle carries **no** page-size literal: the first
  request sends no `limit`, and every later step is `pageLimit` from the last
  response. A response whose offset is past the end is clamped into the pages
  that exist, so the label can never read「page 6 / 3」.
- **Bounded rendering (Revision 23: a filled box, not a fixed one).** Records
  render inside an internally scrolling box `data-region="history-list"`
  (`data-history-list="scroll"`, `data-history-box-height="viewport"`,
  `flex: 1 1 auto`, `minHeight: 0`, `overflowY: auto`), so exactly the current
  page's records are in the DOM and the box **fills what the panel leaves**
  instead of being a fixed 320px tall. The 「当前生效值」 row stays the last row of
  that box. `data-history-box-height` is the string `"viewport"`, not a number:
  the bound comes from the panel (below), not from this box.
- **One column (Revision 25; the two-column layout of Revision 23 is gone).**
  `data-region="history-tab"` is a single `column` flex container
  (`data-history-layout="single"`) whose only child is the list panel
  `data-region="history"`. There is **no** `data-history-columns`, no
  `data-region="history-list-column"`, no `data-region="history-detail"` and no
  `data-region="history-detail-box"`: the record list owns the panel's full
  width. Revision 23's two columns put the list at about half the settings
  dialog's width and made every row cramped to read — which is what a second
  column beside a list of records costs — so the preview and the comparison moved
  into viewport modals (below) instead.
- **The panel height is measured at run time (Revision 23; measured instead of
  guessed in Revision 24).** `history-tab` carries a px `height` / `maxHeight`
  and a px `minHeight` floor for a very short window. Revision 23 computed the
  height as the constant `calc(100vh - <offset>px)`, where the offset was an
  **estimate** of the room the settings page spends above this card — a guess
  about someone else's dialog, and a guess that is too small puts the panel past
  the visible area (the page scrollbar this layout exists to remove, back again).
  Revision 24 measures it instead:
  - **boundary** = the bottom of the nearest **scrollable ancestor** (the first
    parent whose computed `overflow-y` is `auto` or `scroll` — the thing that
    would actually scroll, read through `getComputedStyle` so a stylesheet
    counts), or `window.innerHeight` when there is no such ancestor;
  - **height** = `clamp(minHeight, boundary − panelTop − gap)`, with the px floor
    `HISTORY_PANEL_MIN_HEIGHT` (320) and a `gap` of `HISTORY_PANEL_GAP` (8 since
    Revision 27; it was 16 — the gap is subtracted from a *measured* room, so
    halving it only hands the list those pixels);
  - the measurement is the pure function `historyPanelHeight(inputs)` →
    `{height, source}`, and it is **total**: a missing/zero/`NaN` `panelTop`, a
    boundary that is not below the panel, or no usable boundary at all (no
    observable ancestor *and* no `window`) yields
    `{height: null, source: 'fallback'}`, and the renderer then uses the constant
    `calc(100vh − HISTORY_VIEWPORT_OFFSET)` string. `panelTop <= 0` counts as
    "not measured": an unlaid-out element reports all zeros.
  - It runs in `useLayoutEffect` (so the panel is sized before the paint), once on
    mount and again on `window.resize`; a `ResizeObserver` on the parent is added
    when the runtime has one. The same value never calls `setState`, so a
    measurement cannot feed itself a render loop.
  - The decision is reported on the panel: `data-history-height-source` is
    `"measured"` | `"fallback"` and `data-history-panel-height` is the px number
    or the string `"fallback"` — the first thing to read on a real page when the
    panel looks the wrong size. `data-history-viewport-offset` still reports the
    fallback constant, and a runtime without any measured geometry (a test
    double, a server render, a zero-sized rect) renders the constant path exactly
    as Revision 23 did.
  Below the panel, the record box is `flex: 1 1 auto; minHeight: 0`, so the list
  takes exactly the height that is left. **Revision 27:** how much that is also
  depends on the panel's own chrome, which is therefore part of this contract —
  one heading, the layer tabs, one collapsed notes disclosure and the pager row
  (which now carries the clear control and the record count), with a `gap: 4`
  between them; a 31px record row that never wraps at the dialog's width. The
  page's own height is therefore
  independent of how much history exists — and, since Revision 25, independent of
  how long a preview or a comparison is: those render in modals (below), which are
  capped to the viewport and scroll internally. The **reset rules are untouched** by any of this: changing the
  layer or the scope still resets the offset, the selection, the comparison and
  the preview, and paging still does not (§13.3, Revision 20/21) — the panel's
  height is not part of the file-scoped state.
- **Preview and comparison are viewport modals, and at most one is open
  (Revision 25).** One state picks at most one of them, so they are mutually
  exclusive by construction; there is no `data-history-detail` marker and no
  inline detail pane any more. Each is:
  - an overlay `data-region="history-modal-overlay"` with
    `data-history-modal` = `"history-preview-modal"` | `"history-diff-modal"`,
    `position: fixed`, centred, on a dimmed backdrop;
  - a dialog `data-region="history-preview-modal"` |
    `data-region="history-diff-modal"` with `role="dialog"` +
    `aria-modal="true"` + `aria-label`, `width: min(1040px, 92vw)`,
    `height: maxHeight: min(82vh, 900px)` and `overflow-y: auto`, so a long
    preview or comparison scrolls **inside the dialog**;
  - closed by a button anchored in the dialog's **top-right corner**
    (`data-action="history-modal-close"`, `position: absolute` with `top`/`right`,
    inside a `position: relative` dialog, with an `aria-label` / `title` of
    `histModalClose`) **and** by `Esc`, which the page binds while one is open.
    Both close only the modal: the selection survives. The dialog itself explains
    nothing about how to build a comparison — that sentence belongs to the list.
  - While one is open the page behind it is locked
    (`document.body.style.overflow = 'hidden'`, restored to its exact previous
    value on close), so the overlay cannot scroll the page underneath it.
  The preview dialog contains `data-region="history-preview"` (whose
  `data-preview-state` is `"ready"` | `"missing"`), and the comparison dialog
  contains `data-region="history-diff"` with its `data-diff-*` markers. A
  comparison that is still `loading`, or that failed, renders in the same dialog.
- **Picking a comparison by clicking rows (Revision 23).** A record row is itself
  a control (`data-action="history-row-pick"`, `data-history-row`, `title` /
  `data-history-pick-hint` = `histRowPickHint`, `cursor: pointer`). Clicking rows
  builds the pair in order: the first row picked becomes `from` (nothing is
  requested — one side is not a comparison), the second becomes `to` **and that is
  what fires `GET /diff`**, and from the third on it is a sliding window — the old
  `to` becomes `from` and the clicked row becomes `to`. Clicking the row that
  currently holds `from` clears the pair; clicking the one holding `to` steps back
  to `from` alone. **There are no per-row `from`/`to` buttons** (Revision 26
  removed them, and with them `pickDiffSide` and the `histPickFrom` / `histPickTo`
  copy): the row *is* the control, and the two buttons left on a row are the ones
  that open something. The 「当前生效值」 row is picked the same way
  (`data-action="history-row-pick"` + `data-history-row="current"`), so it stays
  comparable with a record without a pair of buttons of its own. **A completed
  pair opens the comparison modal by itself** (Revision 25), and closing that modal
  keeps the pair, so the reader can put the comparison away without losing it; a
  third row slides the window and re-opens the modal on the new pair.
- **Clearing the comparison (Revision 23; moved out of the dialog in
  Revision 26).** The control is `data-action="diff-clear"` (disabled while there
  is nothing to clear) and it lives in the **list**, in
  `data-region="history-diff-tools"` — **never inside a dialog**: what acts on the
  list's selection belongs to the list. It restores the default pair
  (`from: null`, `to: "current"` — the same pair a layer/scope reset installs, so
  "cleared" and "just opened" cannot drift apart), drops the comparison **and
  closes the modal**: with no pair there is nothing to show, and a dialog left open
  on an empty state is how a stale result gets read as a current one.
- **The list says how to compare (Revision 26).** Right below the scope sentence
  (`data-role="history-scope-note"`) sits `data-role="history-compare-hint"` with
  the `histCompareHint` copy — the one place that explains the row-picking
  interaction. The comparison dialog carries no such sentence (and no
  `histDiffHint` copy exists any more). **Revision 27:** both sentences, the
  retention sentence and the scope sentence, live inside the collapsed
  `data-role="history-notes-toggle"` disclosure — still rendered, still in this
  order, no longer occupying the list's height by default.
- **Record preview (Revision 21; the policy line in Revision 22).** Every record
  row carries
  `data-action="history-preview"` (with `data-history-id`), and the panel it opens
  is `data-region="history-preview"` with `data-preview-state`
  (`"ready"` | `"missing"`), `data-preview-id` and `data-preview-snapshot-count`.
  A ready panel carries `data-preview-field` for `action` / `at` / `layer` /
  `origin` / `note` — the facts that say *which* version this is (Revision 27
  dropped `name` from this list; see the Revision 27 paragraph) — the two
  texts `data-preview-text="before"` / `"after"` (`data-preview-bytes` = the stored
  byte count, the text itself being the node's content), and one
  `data-preview-snapshot="<name>"` per snapshot entry with its
  `data-preview-snapshot-action`. The `at` **value** is Revision 18's rendering of
  the stored timestamp — the reader's own zone, `YYYY-MM-DD HH:mm:ss GMT±h[:mm]` —
  produced by the same `stampOf` a list row uses, with the record's raw UTC string
  on the node's `title`; the dialog and the row can therefore never disagree about
  what time a version was written. The preview lives in the modal described above
  (Revision 25), closed by `data-action="history-modal-close"` or `Esc`; opening it
  is always one click on the row's preview button, with no toggle to reason
  about.
  **A preview issues no request at all.** Everything it shows already arrived with
  the page it was rendered from, so "preview writes nothing" is structural rather
  than a promise: `test/client.test.mjs` asserts that the preview path leaves the
  router with zero non-GET calls and never touches `POST /rollback`.
- **What a rollback would touch is stated before the click (Revision 22).** A ready
  preview carries `data-preview-policy="reserved-only"` with the `histPreviewPolicy`
  sentence — preview and rollback concern the reserved section only — and, when the
  previewed version's snapshot names any *other* section,
  `data-preview-foreign="<n>"` with the `histRollbackForeign` sentence saying those
  `n` sections are not restored. The same two sentences are repeated in the
  confirmation body (`histRollbackScope`, and `histRollbackForeign` when
  `n > 0`): a user must be able to see what the write does **and** what it
  deliberately leaves alone, before confirming it.
- **Preview and paging (Revision 21).** Paging does **not** clear the preview, the
  same rule the comparison selection follows above. A page that does not hold the
  previewed record therefore renders `data-preview-state="missing"` with
  `data-preview-missing="true"` inside the still-open dialog (plus the
  `histPreviewMissingHint` line) instead of an empty one. Changing the **layer**
  or the **scope** does clear it, together with everything else that points into
  the file that just left the screen.
- **One-click rollback (Revision 21; narrowed to the reserved section in
  Revision 22).** Every record row carries
  `data-action="history-rollback"`, which **only asks**: it opens the shared
  confirmation overlay (§13.5) with `data-confirm-kind="rollback"`, naming the
  version, stating the scope (above) and carrying the standard
  `data-role="confirm-irreversible"` line. No
  request is made until `data-action="confirm-yes"` is clicked. Confirming sends
  exactly one `POST /prompt-setting/rollback` (§19) whose body is
  `{layer, seq}` — the version-history scope travels in the query string, exactly
  as it does for `GET /history` and `GET /diff`. The write restores **the reserved
  section only**: every other entry of the layer, present or historical, is left
  exactly as it is (§19.3). On success the page **re-reads**
  rather than patches: the offset returns to `0`, the selection, the comparison
  and the preview are reset, and the log, the current value and both layer views
  are re-fetched from the host, so the list and the「当前生效值」reflect the write
  without a manual refresh. A refusal renders the ordinary error notice and
  resets nothing.
- **The lazy rule now keys off this tab**, and only this tab: a page that never
  opens it issues exactly the baseline requests (ping, snapshot, overrides and —
  g-030 — update-check, the last one only while the check is on). Opening it asks
  for one page: `…?layer=user&offset=0` (Revision 19 — no `session`, no `limit`),
  or `…?layer=workspace&workspace=<session>&offset=0` for the workspace layer.
- **Revision 18:** a row's time node renders the record's stored `at` in the
  **browser's own zone** (`YYYY-MM-DD HH:mm:ss GMT±h[:mm]`), keeping the raw UTC
  string on the node's `title`. The panel's markers and ordering are otherwise
  unchanged.

**Revision 23 (a viewport-sized, never-stacking layout; row picking; clearing —
g-039 third round).** Client-half only: **no route, no query parameter and no
stored byte changes**, so every host behaviour above keeps its meaning exactly
(including §19's narrowed rollback and the §13.3 reset rules).

- **What was wrong.** Revision 19's two-column row wrapped (`flexWrap: wrap`) with
  `1 1 420px` + `1 1 360px` bases, and each box was a fixed `320px` tall. At the
  settings dialog's width (~700px) the columns therefore **stacked**, and the
  panel's own chrome pushed the page past the viewport: picking a record and
  reading the result were one page-scroll apart, which is precisely the defect
  g-039 was opened to fix. Revision 19's "stack on a narrow screen" rule is
  withdrawn — a narrower panel narrows the columns, it never stacks them.
- **Now.** The row is `flexWrap: nowrap`, both columns are `flex: 1 1 0` with
  `minWidth: 0`, the panel is `calc(100vh − offset)` tall with a px floor, and both
  scroll boxes are `flex: 1 1 auto; minHeight: 0`. The page's own vertical
  scrollbar is therefore not something this tab can produce; the only scroll is
  inside a column.
- **Interaction (as of Revision 23; Revision 25/26 replaced the pane with modals
  and removed the per-row side buttons).** Clicking a row is the primary way to
  build a comparison (first = `from`, second = `to` and the request fires, then a
  sliding window), and `data-action="diff-clear"` clears the pair and the result.

**Revision 24 (the panel height is measured, not guessed — g-039 fourth round).**
Client-half only: **no route, no query parameter and no stored byte changes**, and
the layout and interaction rules above are unchanged (`flexWrap: nowrap`, both
columns `1 1 0`, both boxes `1 1 auto; minHeight: 0`).

- **Why.** Revision 23's `calc(100vh − 260px)` made the panel's height depend on a
  **guessed** offset. This card renders inside the DSH settings dialog, whose own
  padding and height rules are the shell's business: an offset a few dozen pixels
  too small puts the panel past the visible area and the page scrolls again —
  exactly the symptom the layout was introduced to remove.
- **Now.** The available room is measured at run time against the nearest
  scrollable ancestor (or the viewport), the result is clamped to a px floor, and
  the panel renders that px height. A measurement that is unusable in any way
  falls back to the Revision 23 constant, so an environment with no layout
  behaves exactly as before.
- **Diagnostics.** `data-history-height-source` and `data-history-panel-height`
  report which path is in use and what was measured. `data-history-viewport-offset`
  keeps reporting the fallback constant.
- **Unit tests.** The resolver is a pure function exported through the bundle's
  documented test handle (`__internals.historyPanelHeight` on the factory's
  return value): clamping, the viewport boundary, `gap`, and every fallback input
  are asserted directly, plus two rendered cases (measured and re-measured on
  resize) that hand the page a fake element to measure.
- **Unchanged invariants.** The file-scoped reset rules are untouched: a layer or
  scope change still resets offset + selection + comparison + preview, paging
  still resets nothing, and §19's rollback is still the reserved section only.

**Revision 25 (one column, and the preview/comparison as viewport modals —
g-039 fifth round).** Client-half only: **no route, no query parameter and no
stored byte changes**, and §19's narrowed rollback is untouched.

- **Why.** The two-column row of Revision 23 put the record list at roughly half
  the settings dialog's width. Every row carries an id, an action tag, a section
  name, a timestamp and four buttons, so half a dialog's width made the list
  cramped to read — the reviewer's report — and the second column was only ever
  showing one of two things anyway.
- **Now.** `history-tab` is a single column (`data-history-layout="single"`) whose
  only child is the list panel; the record list owns the panel's full width. The
  preview and the comparison moved into modals: `position: fixed`, centred,
  `role="dialog"` + `aria-modal="true"`, `min(1040px, 92vw)` wide,
  `min(82vh, 900px)` tall, internally scrolling, with a close button and `Esc`.
  At most one is open at a time, by construction.
- **Removed with the layout.** `data-history-columns`,
  `data-region="history-list-column"`, `data-region="history-detail"`,
  `data-region="history-detail-box"`, `data-history-detail`, the
  `history-detail-pending` idle note and `data-action="preview-close"`. Nothing
  half-built is left behind: the list's box, its pager, the scope disclosure and
  the panel-height measurement are exactly as Revision 24 left them.
- **Interaction, made explicit.** Clicking rows still builds the pair (first =
  `from`, second = `to`, then a sliding window), and a **completed** pair opens the
  comparison modal by itself; closing that modal keeps the pair, and a third row
  re-opens it on the new pair. The preview button opens the preview modal. The
  modal's close button and `Esc` are the only ways out (there is no
  click-the-record-again toggle).
- **Reset rules.** A layer or scope change still resets offset + selection +
  comparison + preview — and now closes the modal too, since a modal describes a
  record of the file that just left the screen. Paging still resets nothing. The
  panel height is still measured at run time (Revision 24) and is not part of the
  file-scoped state.
- **Page scroll.** While a modal is open the page behind it is locked
  (`document.body.style.overflow = 'hidden'`; the previous value is restored
  exactly on close, and on unmount), so the overlay cannot scroll the page
  underneath it.

**Revision 26 (six modal and row details settled — g-039 sixth round).**
Client-half only: **no route, no query parameter and no stored byte changes**, and
none of the invariants above move (single column, measured panel height, modal
mutual exclusion, close-keeps-the-selection, the file-scoped resets, §19's narrowed
rollback).

- **The close button sits in the dialog's top-right corner.** The dialog is
  `position: relative`; the button is `position: absolute` with `top` / `right`, so
  it cannot drift with the title's length or the scroll position. Ids, label and
  the `Esc` path are unchanged.
- **Clearing moved out of the dialog**, into the list's tool row
  (`data-region="history-diff-tools"`, `data-action="diff-clear"`, same disabled
  rule). No dialog contains a `diff-clear` control any more.
- **Timestamps inside a dialog are localized** by the same `stampOf` a row uses;
  the raw UTC string is only the node's `title`.
- **The how-to sentence moved to the list**: `data-role="history-compare-hint"`
  (`histCompareHint`) renders right below the scope sentence, and no dialog
  explains the interaction. `histDiffHint` is gone **with the copy key**, alongside
  `histPickFrom` / `histPickTo`.
- **The per-row `from`/`to` buttons are gone**, and so is the `pickDiffSide`
  action. The 「当前生效值」 row is picked by clicking it like any record row, so it
  remains comparable. The two buttons left on a row are `history-preview` and
  `history-rollback`.

**Revision 27 (the row loses its section name, and the panel stops spending its
height on chrome — g-044).** Client-half only: **no route, no query parameter and
no stored byte changes**, and none of the invariants above move (single column,
measured panel height, modal mutual exclusion, close-keeps-the-selection, the
file-scoped resets, §19's narrowed rollback).

- **Why.** Two defects a reader sees on a normal desktop window. First, at the
  settings dialog's height the panel rendered **one** record. Measured on a real
  page (1440px wide, 757px high) the cause was neither the measurement nor the
  boundary — `data-history-height-source` said `measured`, and the number was
  right — but what the panel spent its height on: the panel had 389px, its own
  chrome (heading + retention sentence + layer tabs + scope block + tool row +
  count) took 268 of them, and a record row was **65px** tall because it carried
  the id, the action tag, **the section name**, the timestamp and two buttons, and
  at the dialog's width those wrapped onto three lines. 268px of chrome plus one
  65px row is the whole panel. Second, the row and the preview both displayed the
  record's **section name** (`prompt-setting:custom-prompt`, and the
  `stage2-e2e` / `ui-e2e-ok` names left over from the era when a reader could add
  sections by hand). The write surface has since narrowed to the single reserved
  section, so the name says nothing a reader can act on.
- **The row renders no section name.** `#id`, the action tag, the timestamp,
  `entries` when the record carries them, and the two buttons remain; the node
  that held `record.name` — and the `histWholeLayer` placeholder a `name === null`
  record used there — is gone, and both copy keys (`histWholeLayer`,
  `histPreviewName`) are deleted rather than left dead. The name itself is still
  the row's `data-history-name` (`''` for a null name), which is what tests and
  diagnostics read. **Records are not filtered**: a log holding hand-written names
  still lists every one of them, it just no longer says what they are.
- **The preview follows the row.** `data-preview-field="name"` is gone, and a
  snapshot entry renders `{action} · {bytes}` (`histPreviewSnapshotEntry` no
  longer carries `{name}`); the entry's `data-preview-snapshot="<name>"` marker
  stays.
- **The panel stops spending its height on chrome.** The retention sentence, the
  scope sentence, the "this scope belongs to this tab" sentence and the picking
  rule now live in one **collapsed** `data-region="history-notes"` disclosure
  behind `data-role="history-notes-toggle"` (the new `histNotesToggle` copy);
  their nodes and `data-role`s are still rendered inside it, so nothing promised
  about them above changes — only their default visibility does.
  `data-region="history-diff-tools"` (`data-action="diff-clear"`) and the record
  count (`data-history-total` / `data-history-corrupt`) moved into the **pager
  row** (`data-region="history-pager"`) instead of a row of their own.
- **What this is worth on a real page.** Measured with headless Chrome against
  this bundle at a 1440px-wide viewport: chrome above the list fell 268 → 118px, a
  row 65 → 31px, and the visible record rows in the list box went 1 → **6** at a
  757px-high viewport, **9** at 900px and **9** at 1080px (the dialog stops
  growing at 800px tall, so the last two agree). The panel is still measured at
  run time (Revision 24) and grew 340 → 440 → 488px as the viewport went
  700 → 800 → 956px; no page-level scrollbar appeared in any of those runs. The
  fallback path was measured too (a panel whose own rect is unusable ⇒
  `source: "fallback"`, `calc(100vh − 260px)` = 640px at a 900px viewport):
  **13** visible rows, so a runtime without geometry never falls back to the
  one-row panel.
- **Unit tests.** The row case asserts the new shape directly: the legacy names
  `stage2-e2e` / `ui-e2e-ok` are on `data-history-name` and in **no** rendered
  text, every record is still listed, the whole-layer placeholder copy is unused,
  and the row carries the tightened padding/gap. The preview case asserts the
  missing field, the missing copy key and a snapshot entry that renders no name;
  the two panel-height cases moved 684 → 692 and 484 → 492 with
  `HISTORY_PANEL_GAP`.

### 13.3a 「备份与恢复」(Revision 19)

- The tab is `data-region="backup-tab"` and contains the transfer panel
  `data-region="transfer"` **and nothing else**: the export button and its scope,
  the export preview (`data-role="export-text"`, `data-export-name`), the import
  text box and file input (`data-role="import-text"` / `"import-file"`), the
  conflict-strategy control (`data-tab-group="import-mode"`), the dry-run plan
  (`data-import-plan`, `data-import-change`, `data-import-counts`,
  `data-import-skipped`, `data-import-unchanged`) and the `import` second
  confirmation all keep their Revision 4–18 behaviour and markers, and all of
  them live here.
- Nothing of the log is rendered here: no `data-region="history"`, no
  `data-history-row`, and opening this tab issues no history request. The reverse
  holds too (§13.0): the log's tab shows no export/import entry point at all —
  the two surfaces cannot be reached from one another's tab.
- Revision 18's export file name rule is unchanged
  (`dsh-prompt-setting-YYYY-MM-DD-HH-mm-ss.json`, the reader's zone, derived from
  the document's own `exportedAt`).

### 13.4 「高级」

- The legacy override list is `data-region="overrides"` with the Revision 6
  per-row markers (`data-override-row`, `-layer`, `-action`, `-applied`,
  `-reason`, `data-overrides-total`), plus `data-override-reserved` marking the
  reserved entry, and it is **read-only**: it offers no `undo` and no
  `reset-section`. A `data-note="overrides-read-only"` line states that the
  generic per-name write no longer exists.
- The two layer-wide clears are `data-region="layer-reset"` (with
  `data-reset-layer`, `data-reset-count`, `data-reset-frozen-count`,
  `data-reset-reserved-count` and its own `data-region="advanced-layer"`
  selector): `data-action="legacy-clear"` sends `DELETE …&legacy=true` (§12.2)
  and **keeps** the reserved override, while `data-action="reset-layer"` sends
  `DELETE …&reset=true` (§12.1) and clears the whole layer.
- The full status block is `data-region="status-detail"`: mounted, frozen,
  `generatedAt`, both layers' `enabled`/`path`/`reason`, the build stamp
  (`data-region="build"`), every frozen/build explanation, and the renderer
  self-check (`data-region="renderer-info"`, `data-primitives-failure` when the
  primitives module was unavailable). The one-line summary at the top carries
  the three verdicts as `data-status-mount` / `data-status-frozen` /
  `data-status-build` on `data-region="status"`. **Revision 18:** `generatedAt`
  renders in the browser's own zone, with the stored UTC string on the node's
  `title` (see the Revision 18 paragraph above).

### 13.5 Second confirmation is required

Every destructive action renders a `data-region="confirm"` card first, carrying
`data-confirm-kind` (`mine-reset` | `legacy-clear` | `reset-layer` | `import`),
naming the affected layer or the change counts, stating that the action cannot
be undone, and offering `data-action="confirm-yes"` / `data-action="confirm-no"`.
No request is sent before `confirm-yes` — asserted for all four kinds.

The card is a **viewport-anchored modal**, not a card in the page flow: it
renders inside `data-region="confirm-overlay"` (`position: fixed`, all four
insets `0`, `display: flex` centering its child both ways, `z-index: 1000`), and
carries `role="dialog"` and `aria-modal="true"` itself. The trigger can sit
anywhere on a long panel —「恢复默认」 is at the bottom of「我的 Prompt」— and an
inline card landed *above* the trigger, off-screen for a scrolled page and
pushing the panel down as it appeared. The overlay is a backdrop only: it closes
nothing by itself, so the exits are exactly `confirm-yes` and `confirm-no`, and
the panel never carries the card.

The dialog's copy is set in **three levels**, and the grouping is structural
rather than one uniform `gap`: `data-role="confirm-body"` holds the lead
sentence (the action itself — 13px, `fontWeight: 500`, `labelPrimary`) above the
sentence that explains it (13px, `labelSecondary`), both at `lineHeight: 1.6`
because zh and en sentences wrap inside the 480px card;
`data-role="confirm-irreversible"` is the warning strip (12px,
`lineHeight: 1.5`, `stateError`, a 3px left border) and states the
irreversibility **once** — the sentences no longer repeat it; and
`data-role="confirm-actions"` holds the two buttons behind a top divider. The
card states its own padding (`16px 18px`).

An import always previews first: `import-apply` is disabled until a `dryRun`
plan is on screen, and the click opens the confirmation card rather than writing.

### 13.6 The reserved name is asserted against the host constant

The client hardcodes `prompt-setting:custom-prompt` (a browser module cannot
import host code), and `test/client.test.mjs` imports `CUSTOM_SECTION_NAME`
from `core/custom.js` and asserts that the name in the save body and in the
delete URL equals it **character for character**. The two copies cannot drift
apart silently.

### 13.7 The「查看范围」picker is collapsed by default (g-016)

Measured in the real settings shell at 1440×900 before this revision: the
expanded selector was ~500px tall (search box + the grouped tree + paging +
pinned rows + four lines of help), which pushed `data-region="tabs"` to
`y≈789` and `data-region="tab-panel"` past the 900px fold — the page opened
with **no tab content visible**. The selector is therefore a disclosure.

**Collapsed (the default).** The card is `data-region="session"` with
`data-scope-open="false"` and renders **exactly one row**:
`data-region="scope-summary"`, holding the heading, the readable name of the
current scope (`data-role="scope-summary-label"`: `sessionGlobal` for the
global scope, `sessionCurrentLabel` for a session, filled with the session's
readable title — or the raw id when no session service is available), an
optional one-word degradation hint (`data-role="scope-summary-hint"`:
`scopeSummaryManual` when `useSessions` is absent/threw, `scopeSummaryFlat`
when `useWorkspaces` is absent/threw), and **one** switch.

**The switch.** `data-action="scope-toggle"` is the same button in both
directions: `aria-expanded` and `data-expanded` report `m.scopeOpen`, its label
is `scopeEdit` (「更改」) when shut and `scopeCollapse` (「收起」) when open.
This is the row-expansion convention of DSH's own settings rows and of this
plugin's workspace header (§13 of g-012's work, `NOTES.md` §90).

**Expanded.** Only then are the Revision 3/4 selector body nodes rendered:
`data-region="session-pinned"`, the search box (`data-role="session-search"`),
the count line (`data-session-shown` / `-matched` / `-total`), the ARIA tree
(`data-region="session-tree"`, unchanged shape) or the flat
`data-region="session-list"`, paging (`data-action="scope-more"`), the notices
and the help copy. Their behaviour, markers and bounds are **unchanged**; the
collapse only decides whether they are rendered at all. While collapsed, none
of those nodes exists (`session-tree` / `session-pinned` / the search input are
asserted absent, not merely hidden).

**Picking a scope closes the picker.** `pickSession` (a row click or Enter on
the highlighted row), `useCurrent` (the pinned current-view entry),
`useTypedId` (「按该 id 查看」), `useGlobal` (the pinned global entry) and
`applyManual` all set the disclosure back to collapsed, and the summary label
follows the new scope in the same render. Browsing actions — typing in the
search box, toggling a workspace group,「显示更多」 — deliberately do **not**
close it: they do not finish the choice.

**This picker no longer feeds the version history (Revision 19).** It scopes the
snapshot and the override reads (`my Prompt`, `提示词总览`, `高级`); the version
history reads its own scope (§13.3) and is not a consumer of this one. Before
Revision 19 the same value was appended to the history request as `?session=`,
which is exactly why the log looked like it lost records when the scope moved.

### 13.8 The plugin version on the page (g-029)

The page states **which version of this plugin the host is running**, and takes
it from exactly one place: the `version` field of the ping it already sends
(`GET /prompt-setting/ping`, §1). The client half carries **no version literal of
its own** — asserted against the real file, by quoting the current version and
requiring its absence — because a second copy is a second thing to keep in sync,
which is the drift this display exists to end. The repository URL it links to
comes from that **same** answer (`repositoryUrl`, Revision 17), so neither half
writes one down either.

- **Where it renders (Revision 17):** in the page's **title row**, as a sibling
  of the `h2` heading, marked `data-role="plugin-version"` — the page's identity,
  not a status chip. The **status line renders no version node at all**
  (`data-region="status"` carries the mounted/frozen/build verdicts only), so in
  the **normal render** the placement is unique: exactly one
  `data-role="plugin-version"` node. The two failure cards render **no** such node
  — they have no title row — which is precisely why the machine-readable version
  lives on the **root container** instead: `data-plugin-version` is present in
  **every** render state, so a probe reads one attribute and never has to know
  which state it got;
- **the text** is `v` + the version (`v0.1.5`), or `stPluginVersionUnknown`
  (「版本未知」 / `Version unknown`) when the ping carried no usable one. The
  node's `title` is `stPluginVersion` (「插件版本」 / `Plugin version`);
- **the link:** with a `repositoryUrl` the node is an `a` element whose `href` is
  exactly that URL, with `target="_blank"` and `rel="noreferrer noopener"`, and
  `data-plugin-repository` carries the same URL. With `null` it is a `span`
  marked `data-plugin-repository="unknown"` — **plain text, not clickable** — and
  the version text renders just the same. An unseen URL is never guessed and an
  empty `href` is never emitted: both would send the reader somewhere no manifest
  names. A known URL with an unknown version is still a link. The host only ever
  reports an `http(s)` address (§14.2), so the `href` is always one a browser
  will open;
- **the root container** carries `data-plugin-version="<version>"`: the ping's
  `version` verbatim, or the string `unknown`. **Every** root container carries
  it, in every render state — the real page, the render-failure card
  (`data-renderer="fallback"`, `data-render-state="error"`) and the load-failure
  card (`data-renderer="none"`), the last two always `unknown` — so a probe reads
  one attribute instead of knowing which state is supposed to carry which marker;
- the version (and the URL) come from the **same answer** as the build stamp
  (`data-build`, `data-build-server`, `data-build-match`, §14.3): one ping, one
  host boot, so the facts on screen can never describe two different hosts;
- **`unknown`** — the same asymmetry as the build stamp, for the same reason: a
  failed or unreachable ping, a body without `version`, a non-string value
  (`42`, `{}`, `null`), or a string that declares nothing (the empty string, or
  only whitespace). A version no host answered with is **never** rendered: an
  invented number is worse than an honest「未知」;
- a value that **does** carry text is published and rendered **byte for byte**:
  `'   '` is not a version, but trimming the padding off a real one is not this
  page's decision either — only the emptiness check looks at whitespace, and the
  value that is kept and rendered is the ping's own string.

The cost is one attribute, one node and one extra ping field on a request the page
already makes: no new route and no new request.

### 13.9 The upstream update banner and its switch (g-030)

Two surfaces, both fed by `GET /prompt-setting/update-check` (§17):

- **the banner** — rendered above the tab bar (`data-region="update-notice"`) with
  `data-update-available="true"` and `data-update-latest="<version>"`, the
  `<version>` being the host's normalized `latest` verbatim. Inside it: the
  sentence naming both versions, the release link (`data-update-release-link`,
  `href` = the host's `releaseUrl`, `target="_blank"`,
  `rel="noreferrer noopener"` — the `rel` is required, not decorative: without it
  the opened page gets a `window.opener` back into this settings page) and the
  dismissal button `data-action="update-dismiss"`. **Dismissal is view state**:
  it renders `null` afterwards, sends nothing, and writes nothing;
- **the banner exists only for a confirmed newer release.** No update
  (`hasUpdate:false`), no usable information (`hasUpdate:null`: no release yet, an
  unparsable tag, an absent `tag_name`) and every failure (`ok:false`) render
  **nothing at all on the main page** — no banner, no error banner, no red text and
  no notice. This is a background question the user did not ask, so it may only
  ever be silent or useful. Inside the「高级」card the two *undecided* kinds are
  told apart, which is the opposite of blurring them: `hasUpdate:null` — upstream
  answered, there was just nothing comparable — renders one neutral line
  (`data-update-state="unknown"`, `data-update-unknown="true"`, text
  `updateUnknown`), while a **failed** check renders no such line at all. A
  confirmed release renders the version line instead
  (`data-update-state="available"`), and "up to date" renders no line either, so
  the two states are mutually exclusive and the four upstream facts cannot be
  misread as "the plugin cannot reach the network";
- **the switch** — in 「高级」, `data-region="update-setting"` carrying
  `data-update-enabled="true"|"false"`, with `data-action="update-toggle"`
  (`aria-pressed` mirrors the state) and, only while it is on,
  `data-action="update-recheck"`. The state it shows is the **host's**
  `enabled`, never the page's optimism: a `GET` that failed leaves the last known
  state alone, and a refused `PUT` is reported in the existing error notice while
  the switch stays where the host says it is. Turning it on asks once immediately
  (`?force=1`); turning it off sends the `PUT` and stops;
- **zero requests while it is off** (criterion 4). The page keeps a
  `localStorage` mirror (`dsh-prompt-setting.updateCheck` = `'on'`/`'off'`) purely
  so a closed switch survives a reload without a round trip: on mount, a mirror
  reading `'off'` means the page issues **no** update-check request at all, and
  the host's own `check()` reads `preferences.json` first, so a closed switch
  performs no outbound request even if a request does arrive (`?force=1`
  included). Anything other than `'off'` — a missing `localStorage`, a privacy
  mode that throws, a hand-edited value — means "ask once", never "assume off";
- **the mirror's drift is an accepted trade, and it trades in the safe
  direction.** The mirror can disagree with the host: a hand edit of
  `preferences.json` back to `true`, or the same install opened in another browser
  (empty mirror, or still `'off'`), leaves「高级」showing「已关闭」while the
  preference file says otherwise — until the user clicks the switch once, at which
  point the write plus the fresh answer settle both sides. The page does not spend
  a request on mount to reconcile them, because the mirror exists precisely so a
  closed switch costs **zero** requests: **consistency of the display yields to the
  zero-request guarantee**. Neither direction of the drift can produce an unwanted
  outbound request, and both are asserted:
  - mirror `'off'` while the file says `true` — the page asks nothing (a *missed*
    check, never an extra one) and shows「已关闭」until the next click. This is the
    one direction the display can be wrong in, and its cost is display-only;
  - mirror `'on'`/absent while the file says `false` — the page may send the `GET`,
    and the **host** reads `preferences.json` first and answers `enabled:false`
    with **zero** outbound requests; the page then writes `'off'` into the mirror
    from that answer, so the next mount is silent as well;
- the switch renders as a **card in 「高级」**, on by default, next to the
  read-out. It is real UI rather than a documented config file because the owner
  rejected the degradation explicitly: a privacy switch nobody can find is not a
  switch.

`test/client.test.mjs` freezes every branch above, including the two negative
ones that matter most: a failed check paints no error, and a mirrored `'off'`
makes the mount request nothing.

---

## 14. Client build stamp (Revision 6)

### 14.1 The problem this answers

A settings tab runs the `client.js` it was handed when its module was loaded. In
DSH 0.1.7-rc.2 that is **not** normally the end of the story: the client half
carries an HMR path for plugins (`@deepseek-ai/dsh-client-hmr` subscribes to the
SSE channel `/plugins/events` and, on a `rebuilt` frame for this plugin id, calls
`ctx.modules.entries.reload(id, rev)`; `@deepseek-ai/dsh-client-modules`'
`replace()` then prefetches, tears the entry fiber down, re-`import`s and refreshes
it). A rebuild therefore usually reaches an open tab within milliseconds, **without
reloading the document**.

What is left, and what this stamp is for, is the case where that did not happen:
the page is running bytes that are not what the file says, because the HMR path did
not do its job for this tab (the event stream is broken, blocked, or was unhealthy
when the tab booted) or because the write has happened and the `rebuilt` event has
not arrived yet. In exactly those cases "the fix is not visible" and "the page is
not the current bytes" look identical on screen, and until Revision 6 nothing on
the page said which bytes it was running. (On this machine `Cmd+Shift+R` is taken
over by DSH, which removed the easy manual check as well.)

### 14.2 `clientBuild` in the ping

`GET /prompt-setting/ping` answers the stage 1A shape plus the fields added since
(`clientBuild` here; `repositoryUrl` in Revision 17, §13.8; `launchKind` in
g-036, §18.8). The body
below is a **shape example**: `hash`, `size` and `mtime` all move with the
bundle's bytes and the file's timestamp, so the numbers in it are placeholders —
not this machine's (and not any machine's) current values. Comparing them with a
live probe would read a normal rebuild as a defect.

```json
{
  "ok": true,
  "plugin": "dsh-prompt-setting",
  "version": "0.1.5",
  "repositoryUrl": "https://github.com/zangxx66/dsh-prompt-setting",
  "time": "2026-09-28T12:00:00.000Z",
  "clientRenderer": "fallback",
  "clientReportedAt": "2026-09-28T12:00:00.000Z",
  "clientBuild": { "hash": "7065b7d2", "size": 240949, "mtime": "2026-09-28T11:58:31.000Z" },
  "launchKind": "cli"
}
```

The real values come from the probe itself (or `clientBuildInfo(path)`) against the
file in question. As a reference point, this package at the commit that introduced
§14 recomputed offline to `hash: "63cf17c0"`, `size: 248093`
([`NOTES.md`](./NOTES.md) §82); any later edit of `client.js` is expected to move
both.

- `hash` — 8 lowercase hex digits: **FNV-1a 32** of the marker region (§14.4);
- `size` — the length of that region in **UTF-16 code units** (not bytes: see
  §14.4 for why the browser and the host can only agree on this length);
- `mtime` — the file's modification time as an ISO 8601 string;
- `repositoryUrl` — **Revision 17**: this package's own repository, derived at
  import time from its `package.json` (`repositoryUrlOf`: `repository.url`, else a
  bare `repository` string, else `homepage` — each with its git decoration
  `git+…​.git` or `#fragment` removed, trailing slashes folded), or `null` when the
  manifest declares none **or** declares something that is not an `http(s)`
  address (an SSH remote is not rewritten; see §13.8). It is answered here so the
  page can link the version without either half writing a URL down;
- `clientBuild` is **`null`**, with the rest of the response unchanged and the
  status still `200`, when the bundle cannot be read, or when it is readable but
  its marker region is unusable (markers removed, duplicated or reversed). A
  fabricated digest here would be read as「过期」, so「unknown」is the answer;
- `launchKind` — **g-036**: `"cli"`, `"desktop"` or `"unknown"`, the shape this
  Host was started in, judged from the official `profileContext.name` (§18.8).
  It is the field the page selects its restart copy with; `"unknown"` is also
  what a **pre-g-036 Host's absence of the field** means to the page, so both
  halves agree on the three states without a version check.

**How it is computed is part of the contract: on every request,** by reading the
file this process publishes (`fileURLToPath(new URL('./client.js', import.meta.url))`
of the installed package), never from a cache, a constant or a build-time value.
A cached stamp would keep claiming「一致」after the file changed — i.e. it would
lie exactly when it matters. The read is one `readFileSync` per probe and the
probe is never on the assembly path, so this costs nothing per turn.

Reading a file per request is the deliberate exception to §5.5's "read once, hold
in memory": the override layers are configuration, where a stale cache is a bug;
the stamp is a claim about *the bytes on disk right now*, where a cache would be
the bug.

### 14.3 The three states, and why the third exists

The page fingerprints itself — the running factory's own source, via
`factory.toString()` — and compares it with the field above. It publishes the
result on the root container:

| `data-build-match` | When | What the page renders |
| --- | --- | --- |
| `"true"` | both digests answered and are equal | tag「与宿主一致」 |
| `"false"` | both digests answered and differ | tag「页面版本已过期」 + `data-warning="client-build-stale"` |
| `"unknown"` | anything else | tag「构建戳未知」 + `data-warning="client-build-unknown"` |

- `data-build` — the page's **own** digest (or the string `unknown` when it could
  not compute one);
- `data-build-server` — the host's digest as reported (or `unknown`);
- `data-build-match` — the verdict above.

`"unknown"` covers: an older host that does not send `clientBuild`; a host whose
bundle is unreadable (`clientBuild: null`); a `client.js` whose markers were
edited away; a failed or unreachable ping. **None of those may ever be rendered as
「过期」**: the whole point is to stop chasing a bundle that is fine. The
asymmetry is deliberate —「一致」 and「过期」 each require a real digest on both
sides, so the only unsupported verdicts degrade to「未知」, and the page's own
digest is reported even then (the page always knows what it is running, even when
it cannot compare).

The comparison cannot say which side is *newer*; `false` means "these are
different bytes", and it is a statement about **this page against the file on
disk**, nothing more. What to do about it follows from §14.1 rather than from the
digest alone:

- `"true"` — normal. The tab is running the bytes the host is publishing;
- `"false"` — the tab really is not on those bytes. First action: reload the page.
  Because `clientBuild` is re-read from disk and DSH's reload trigger is not
  (§14.5), a `false` that survives a reload means the DSH side did not rebuild/notify
  — a broken or blocked `/plugins/events` stream, an unhealthy watch, or the window
  before `rebuilt` — and that is not something this plugin can fix;
- `"unknown"` — not comparable. Nothing is claimed, and nothing should be concluded.

The page's copy says「页面版本已过期」for `false` because that is the ordinary case
(a tab that missed the reload), but the honest reading is「本页不是当前字节」, and
the reader is told to reload rather than told a story about why.

### 14.4 The region, the normalization, and what this cannot claim

`client.js` carries exactly one pair of marker comments, inside the factory body:
`/* @build-fingerprint:begin */` and `/* @build-fingerprint:end */`. The region is
the text **between** them and it must cover the factory's entire body — anything
outside it could change without moving the digest, which would be a silently
false「一致」. Both flags are test-asserted against the real file
(`test/build.test.mjs`), as is the requirement that each marker occurs exactly
once: two markers would make the region ambiguous, and an ambiguous region is
refused (`null` ⇒「未知」) rather than resolved arbitrarily.

Before hashing, both sides apply the same normalization: drop one leading BOM,
and fold `\r\n`/`\r` to `\n`. Without it, any hop that rewrites line endings
between disk and browser would fabricate a mismatch out of a non-difference.

The digest is FNV-1a 32 over **UTF-16 code units** of the normalized region, not
over UTF-8 bytes, and `size` is that code-unit count. That is the only length
both halves can compute: the browser has no `Buffer`, and `readFileSync(path,
'utf8')` plus `charCodeAt` reproduces the server side exactly. The algorithm is
pinned by its official test vectors in `test/build.test.mjs`, so a change to the
prime, the offset or the order cannot pass by agreeing with itself.

**The transport assumption, checked as far as static reading goes (see NOTES.md
§81.1):** the browser must run the same region text that is on disk. The bundle the
client actually evaluates is not the raw file — `@deepseek-ai/dsh-client-modules`
concatenates the enabled plugins' bundles and, per resource, strips a trailing
`//# sourceURL=` / `//# sourceMappingURL=` trailer and appends a newline if the file
does not end in one (`prepareSource`), then separates resources with `;\n`
(`buildComboScript`). Every one of those edits is applied **outside** the marker
region — at the very end of the file or between files — so the region survives
verbatim and the self-digest still matches. What has *not* been observed is the
payload a real browser receives, byte for byte, so this stays an item in NOTES.md
§81.1 rather than a verified claim here. Should any transform ever touch the region
(minification, comment stripping, rewriting), the two digests would differ and the
page would show「过期」: the visibly wrong direction — a rewrite can never be
reported as「一致」 — but wrong all the same.

**Accepted limitation, also stated rather than hidden:** the region is the factory
*body* only. `begin` has to be the body's first statement and `end` its last, so
everything that wraps the function — the file header comment, the
`window.__ModuleLoader__.load({` call, the `id:` line, the `factory:` line and the
closing `};` / `},` / `});` — sits **outside** it. Editing only those lines
therefore does not move the digest, and a tab running the older bytes would report
`data-build-match: "true"` (a false「一致」; never a false「过期」). The alternative
does not exist: the page's only access to its own bytes is `factory.toString()`, so
markers moved outside the function would simply not be seen by the self-check. The
boundary is acceptable because what lives outside is comments and binding lines —
the registration surface — whose edits are both rare and loud. See NOTES.md §81.5.

### 14.5 What this stamp is not: content fingerprint vs. DSH's served artifact

The two digests being compared do **not** come from the same mechanism, and the
difference matters in one window:

- `clientBuild` is a **content fingerprint**: the host re-reads the file on every
  probe, so it always describes the bytes on disk *right now* (§14.2);
- what the page is running is whatever DSH last handed it. On the host side
  `@deepseek-ai/dsh-client-modules` captures the bundle when it publishes a
  generation — `rebuilt(id)` computes
  `artifactRevision(baseline) = framedHash("plugin-artifact", [String(mtimeMs), String(ctimeMs), String(size)])`
  and **returns without reading or notifying when the rev is unchanged**; only a
  changed rev makes it re-read the file and notify the SSE channel, after which the
  client reloads that entry (§14.1). The trigger is therefore **metadata**
  (mtime/ctime/size), and the bytes the page gets are the ones captured at that
  moment.

Consequences, stated rather than discovered later:

- between a write and the `rebuilt` that follows it, the two can legitimately
  disagree. Reporting `false` there is **correct**, not a false alarm: the page
  really is not running the current file.
- a `false` does **not** promise that reloading the page will fix it. If DSH has
  not rebuilt (watch unhealthy, event stream blocked, a rev it considers unchanged),
  a reload can be served the same older artifact. "Refresh and it will be new" is
  not something this stamp — or this plugin — can claim; that is DSH's cache and
  watch semantics, and the honest instruction is §14.3's: reload first, and treat a
  surviving `false` as a DSH-side condition to investigate.
- conversely, `true` says nothing about HMR health: it only says that at the moment
  of the probe the running bytes and the file agreed.

## 15. The owned prompt section and the write lock (Revision 7; lastness added in Revision 8)

### 15.1 The reserved name and the registration

The Host half registers **one** prompt section of its own during `apply`, through
`ctx.systemPrompt.section({...})`:

```js
{ name: 'prompt-setting:custom-prompt', order: 1000000, text: '', interpolate: false }
```

- **Reserved name.** `prompt-setting:custom-prompt` is simultaneously the name of
  the registered section and the name of the one override every write route
  accepts (§15.5). It is namespaced on purpose: the shipped section names are the
  unprefixed `harness:` / `deployment:` / `tool:` families (a preset may add
  `preset:*` / `session:*`), and `systemPrompt.section()` refuses a duplicate name
  within a layer, so a `prompt-setting:`-prefixed name cannot collide with a
  section this repository ships.
- **`order: 1000000`.** The shipped package's own placement table
  (`@deepseek-ai/dsh-system-prompt`, the `SECTION_ORDERS` table at the top of
  `lib/index.js`) defines its maximum as `DEPLOYMENT_PERSONA_SUFFIX = 10200`. The
  promise this value buys is exactly: **this plugin's section sorts after every
  section the DSH repository defines.** Another plugin may legitimately register a
  larger finite order — the platform documents external contributions as free to
  place themselves anywhere — and when one does, its section sorts after ours.
  That is the documented boundary of what an `order` value can promise, not a
  violated invariant. Revision 8 closes the **practical** half of that gap — a
  third party that appends its section in an outer waterfall listener — without
  changing what `order` promises; see §15.10.
- **`text: ''`.** Empty at registration (§15.2).
- **The user's text is never read on the assembly path.** It reaches the section
  through the existing override engine — a `replace` whose name is the reserved
  one, applied by the one `system-prompt/assemble` listener — so this revision adds
  no configuration read, no IO and no new branch to that path.
- **The disposer is accounted for like the other two effects.** Registration goes
  through the same `registerEffect` guard as the route and the listener, so
  unloading the plugin, or a later step of the same mount failing, removes the
  registration instead of leaving a name in the global layer that a remount would
  collide with (§15.9). The registration is the **last** of the three effects: the
  rule is most-likely-failure-first, so the failure a real profile actually hits
  (a duplicate route prefix) happens with the least to undo.

### 15.2 Zero contribution when unconfigured

An empty section survives into `assembly.sections` — a waterfall listener can see
it — but the shipped `renderPrompt` drops it in its
`.filter((text) => text.length > 0)` pass. So **an unconfigured install renders a
prompt byte-identical to a profile without this plugin**, which
`test/integration.test.mjs` asserts against the real renderer rather than against
our own copy of it.

Two consequences to plan for, both intended:

- `base.sections` and `effective.sections` in the snapshot **do** gain one entry
  (ours, empty, last). Anything comparing those arrays to a Revision 6 baseline
  must expect it; anything comparing the **prompt** must not see a difference.
- The section is always registered, so a `complete: true` collapse (§15.4) can
  throw it away — see that subsection.

### 15.3 Why `interpolate: false` is a requirement

The shipped renderer scans every section that does not carry `interpolate: false`
and **throws** on an unknown variable name, on a variable whose provider returned
`undefined`, on a `{{...}}` group whose inner text is not a valid variable name,
and on a malformed group that has a later `}}`. A provider throwing fails the
whole pre-step — there is no per-section fallback.

User text is arbitrary, so a user who typed one `{{reference}}` would otherwise
break **every subsequent turn** of that session, not just the turn that wrote it.
With `interpolate: false` the renderer hands the text back byte for byte: no scan,
no substitution, no throw. `test/integration.test.mjs` asserts both halves — the
literal round trip *and*, as a control, that the very same text in an
interpolating section does throw.

The price is stated plainly: with this flag, a reference a user writes into their
own prompt is **never** substituted, so `{{model}}` in「我的 Prompt」reaches the
model as those literal characters. That is the default trade — the field is free
text, not a template language.

**Revision 11 made the flag a choice; Revision 15 made the flag permanent
again — and moved the choice somewhere safe.** The default is still `false` and
the section is still registered with `false`; what Revision 15 removed is the
runtime flip, so the strict renderer can never be aimed at this text at all
(§16.9). The user's choice now governs the plugin's own expansion of the text,
which the write face still validates (§16). Nothing in this section changes while
the switch is off, and nothing in it can change while the switch is on: the flag
itself is constant.

### 15.4 `complete: true` still wins, and the snapshot says so

The reserved section is an ordinary section: it is registered in the global layer,
and a scope that has an active `complete: true` section collapses to that one
section after the waterfall. In such a scope:

- the user's text does **not** reach the prompt, because the entire section list is
  replaced by the complete section;
- the snapshot reports it rather than hiding it: `frozen: true` with the
  `frozenSection` and `frozenReason` Revision 3 already defines (the verdict is
  proven by the survival probe, not guessed), the reserved override appears in
  `effective.sections` with `applied: false` and
  `reason: "the section was removed from the assembled result"`, and every entry
  is `overridable: false`.

This is the same degradation §2.4 and §7 already describe for any section, applied
to ours; the UI half must state it in the「我的 Prompt」panel rather than let a
user write text that silently does nothing. Revision 9 pins that half down: the
blocking block carries `data-warning="mine-frozen"` **and**
`data-mine-frozen="true"` with its `data-mine-frozen-certainty`, the state line
carries `data-mine-effect` (`"none"` for a certain freeze, `"unknown"` for the
§2.4/§7.2 unknown case, `"next-turn"` otherwise), and every success wording in a
frozen scope is the conditional form — a stored write can never read as an
effective one, and an unknown verdict is never relabelled as a frozen session.

### 15.5 The write lock, precisely

The complete matrix for `PUT /prompt-setting/overrides`:

| `section.name` | `section.action` | Result |
| --- | --- | --- |
| a non-empty string ≠ reserved | anything | `403 write-locked` |
| reserved | `replace` | validated (`missing-text`, `text-too-large`) and written |
| reserved | `hide` \| `append` \| unknown \| absent | `400 unsupported-action` |
| absent / empty / not a string | anything | the field validator answers (`400 missing-name`, `400 invalid-override`) |

And for the single-name `DELETE`:

| `?name=` | Result |
| --- | --- |
| a non-empty string ≠ reserved | `403 write-locked` (before the presence lookup) |
| reserved, the layer holds it | `200`, removed |
| reserved, the layer does not hold it | `404 override-not-found` |
| absent / empty | `400 missing-name` |
| longer than 200 characters | `400 name-too-long` |

**Nothing is written on any refusal.** The policy runs before the layer is
resolved, before the current config is read and before any write call, so a
rejected `PUT`/`DELETE` leaves the layer's file byte-identical — asserted with a
SHA-256 of the file in `test/route.test.mjs`, not merely with a status code.

One ordering note worth keeping: on `PUT` the name wall precedes *every* field
rule except `layer` and a missing name, so `{name: "a", action: "explode"}` is
`403`, not `400 unknown-action`. `unknown-action`, `unexpected-text` and
`invalid-order` remain reachable exactly where they belong — in the override
validator (`test/overrides.test.mjs`) and through `import`'s document validation
(§11.1).

### 15.6 `?legacy=true` and the frozen state

See §12.2 for the shape and §12.3 for the history action. The state this operation
exists for:

- an override whose name is not the reserved one was written by Revision 6 or
  earlier, by hand, or by a config-sync tool. It **keeps working**: the override
  engine, `mergeLayers`, `buildEffective` and `detectFrozen` are unchanged by this
  revision, so the assembly result for such a layer is byte-for-byte what it was.
- no route can create, update or import one any more. It is therefore *frozen
  read-only*: visible in `GET /overrides` and in every snapshot view, removable as
  a whole with `?legacy=true`, removable one name at a time only by…
- …**hand-editing the layer's file**. That is the documented escape hatch: the
  file stays the source of truth, every route request re-reads it before doing
  anything else (§5.5), and an external edit is visible to the very next request
  with no remount. There is deliberately no route that reopens the write face.

### 15.7 Import: names only, and never silently

The import write lock is on **names**: a document carrying any entry whose `name`
is not the reserved one is refused with `403 write-locked`, in **any** layer of
the document (including a layer this request would not import), under `dryRun` as
well as a real run. Nothing is written, no temp file is left, and every file's
SHA-256 is unchanged — the same assertion the rest of the import atomicity tests
use (§11.1).

The **action** of a reserved-name entry is *not* additionally constrained: the
document is applied as it stands. That is deliberate. The name is the security
boundary this revision draws (an import may not create, resurrect or modify a
frozen override); constraining actions as well would break the round trip for a
hand-edited layer that, say, hides the reserved section — an export of it could
not be re-imported. Such an entry is applied exactly as `planImport` always
applied it (§11.4).

Because an export now carries at most one entry per layer, the multi-entry plan
shapes (`replaced`, `kept`, and `removed` in `merge` mode) are exercised at the
route level through `mode=replace` plus a seeded frozen entry rather than through
several imported names; the multi-name kernel behaviour itself is unchanged and
pinned in `test/transfer.test.mjs`.

### 15.8 What a frozen override is, and is not

| | Frozen override (any other name) | Reserved override |
| --- | --- | --- |
| Applies to the prompt | yes, exactly as in Revision 6 | yes, via the registered section |
| `PUT` | `403 write-locked` | `200` (with `replace` only) |
| `DELETE` (single name) | `403 write-locked` | `200` / `404` |
| `DELETE ?legacy=true` | removed | kept |
| `DELETE ?reset=true` | removed | removed |
| Exported | no — counted in `exportScope.omitted` | yes |
| Imported | `403 write-locked` | yes |
| Editable by hand | yes (the file is the source of truth) | yes |

### 15.9 Failure behaviour of the registration

Registration failure follows the g-013 resilience rule exactly like the route and
the listener, and the failure modes are asserted offline in
`test/boot.test.mjs`:

- `ctx.systemPrompt.section` missing, or throwing (a name already registered in
  the global layer, a non-finite order — the platform validates both), or
  returning something that is not a disposer: **one readable line** on the
  terminal and on `ctx.logger`, every earlier effect unwound, and **no boot
  failure**. `apply` never throws outward;
- the registration is the last of the four effects (Revision 8 added the keeper),
  so a failure there unwinds the route and both listeners with it. A mount
  therefore either registers all four or registers none;
- the one residual this cannot fix is the same one §7 already records for the
  route: a host that accepts the registration and hands back no remover leaves
  that half beyond any plugin's reach. It is reported rather than hidden, because a
  surviving registration would make a remount collide with the name it still owns.
- the keeper is the same `ctx.on` effect as the override listener, on the same
  g-013 ledger: a host where `ctx.on` is unavailable or throws fails the mount with
  one readable line and unwinds everything, exactly as before. A host whose
  `ctx.on` ignores the third argument still registers the listener (it just does not
  get the front slot) — a degraded order, never a failed mount.

**Not verified in this revision.** Whether a real `dsh web` process picks the
registered section up into the final prompt can only be observed after a Host
restart, which was out of scope here. What *is* verified: the registration is made
against the real `@deepseek-ai/dsh-system-prompt` service in a real Cordis context,
the real `renderPrompt` renders the section's text byte for byte and drops it when
empty, and disposing the mount removes the registration (all in
`test/integration.test.mjs`). See NOTES.md §93.

### 15.10 Lastness: keeping the reserved section at the end (Revision 8)

`order: 1000000` sorts the registered section after every section the DSH
repository defines (§15.1). It does **not** make the user's text the last thing the
model reads, and the live machine proved it: `dsh-expression` registers its own
`system-prompt/assemble` listener **before** this plugin, appends
`dsh-expression:companion` after `next()` returns, and is therefore outer to this
plugin — its post-`next()` step runs after ours (§6·E2). Revision 8 adds one
listener that closes that gap at the only point where it can be closed.

**The listener.** Registered with `{prepend: true}`, which unshifts it in front of
every listener registered before it, so its post-`next()` step runs after theirs
and it sees every section they appended after `next()` returned. The claim is
**relative to the registrations that exist at that moment**, not absolute: a
listener registered later with `{prepend: true}` is unshifted in front of this one
in turn (residual 2 below), and a host that drops the options object removes the
front slot altogether. Revision 15's expansion deliberately depends on none of
this (§16.9.4). It is a second effect on the same
g-013 ledger as the route, the override listener and the section registration —
unloaded, or unwound when a later step fails, with them (§15.9). Its whole body:

1. `await next()` — it always delegates, so it never vetoes another listener;
2. hand the result to the pure kernel `reservedSectionLast` and return what that
   returns.

**What the kernel does — four identity cases.** `reservedSectionLast` returns its
input **by reference** when `sections` is not an array, when no entry is named
`prompt-setting:custom-prompt`, when the reserved section **is already last**, or
when its `text` is not a non-empty string. It is pure and total: no IO, no clock,
no `ctx`, and no shape it can throw on. Only when the section exists, carries text
and is not last does it return a shallow copy of the assembly with a fresh
`sections` array holding the *same* section objects in a new order — only
`sections` is replaced, and the section objects themselves are never copied
(§5.3).

**Why only a section with text is moved.** An empty section renders zero bytes
(§15.2), so its position in `sections` is not observable in the prompt at all;
moving it would buy nothing. What it would cost is real: it would give up the
identity rule of §5.3 on every ordinary unconfigured assembly, and with it the
zero-diff promise Revision 7 rests on. So the unconfigured install takes the
identity path, and the whole listener is a no-op until a user writes something.

**The promise, precisely.** When `prompt-setting:custom-prompt` carries non-empty
text, the final `assembly.sections` — the value `systemPrompt.assemble()` returns —
has that section as its **last entry**, including past sections other listeners
append inside the waterfall. `renderPrompt` therefore ends with the user's text,
byte for byte. The bounds of that claim:

- the *registered* order (`base.sections`, the snapshot's registered view) is
  unchanged — the section is already last there by `order`, and `base` is captured
  before the keeper runs;
- the section objects, their names, their text and every other assembly field are
  untouched: this listener moves one entry of one array and nothing else;
- the promise is about the **assembly the waterfall returns**. A `complete: true`
  scope replaces that list afterwards (residual 1 below).

**Residual boundaries (stated, not hidden).**

1. **A `complete: true` scope.** The platform restores the complete section *after*
   the waterfall and replaces the entire section list with it. The keeper's move —
   like every other listener's edit — is discarded, and the user's text does not
   reach the prompt. This plugin cannot outrank a complete section; the snapshot
   reports it (`frozen: true` with `frozenReason`, the reserved override
   `applied: false`) and the UI must say so (§15.4).
2. **A listener prepended *after* this mount.** `prepend` puts a listener at the
   front of the list, so a plugin that registers with `{prepend: true}` after this
   one becomes the outermost listener instead, and its post-`next()` step runs
   after the keeper's — any section it appends then really is last. The keeper
   cannot defend against a listener that outranks it, and it does not try.
3. **Sections this plugin does not own.** The keeper moves only
   `prompt-setting:custom-prompt`. The relative order of every other section —
   including one appended by an outer listener, and one that listener deliberately
   placed after another — is preserved exactly: the move is a splice, not a sort.

**Failure behaviour.** The kernel is pure and total, and the listener wraps it in
the same fail-open `try` the override listener uses for `applyOverrides`: any throw
returns the untouched downstream value instead of breaking a user's turn. There is
no IO, no configuration read and no new service call on this path.

**Not verified in this revision.** The keeper is a **Host-half** change, so a
running `dsh web` must be restarted before the real prompt can be observed. This
revision did **not** restart it and therefore claims nothing about the live
process. What *is* verified, against the real `@deepseek-ai/dsh-system-prompt` and a
real `dsh-expression`-shaped listener in a real Cordis context: the move happens
when the section has text (final order `…, dsh-expression:companion,
prompt-setting:custom-prompt`), does not happen when it is empty (final order `…,
prompt-setting:custom-prompt, dsh-expression:companion`), `renderPrompt` equals the
no-plugin prompt plus `\n\n` and the user's text, the move is discarded in a
complete scope with the frozen verdict unchanged, a hand-edited `hide` leaves the
keeper a pass-through, and disposing the mount removes the listener with the section
it guards. See NOTES.md §95.


---

## 16. The「我的 Prompt」variable-substitution switch (Revisions 11–15, g-026)

**Revision 15 (design A) re-founded this feature, and §16.9 is the authority for
it.** The reserved section is registered `interpolate: false` and never changes,
so DSH's strict interpolator can never see its text; the switch means "this plugin
expands the `{{...}}` itself, leniently, during the assembly". The verdict, the
hold map and the load-time degradation that Revisions 12–14 built around the old
design are deleted. §16.1–§16.8 keep their numbering and describe the parts that
survive (config semantics, the routes, the write-face validation, preview
grading, reversibility, the three states); §16.10 lists every assertion this
rewrite changed and what carries its coverage; §16.11 lists what the feature still
does not do.

### 16.1 Where the switch lives, and what "absent" means

The switch is the config-level boolean `interpolateCustom`, valid in **either**
layer's `overrides.json`:

```json
{ "version": 1, "interpolateCustom": true, "overrides": [ … ] }
```

- **Absent means OFF**, and an absent key is the only shape a config written by
  any earlier revision has. `PUT` writes OFF as the **absence** of the key, so
  opening and closing the switch restores the file byte for byte (§16.7);
- `null` also means "states nothing"; a present non-boolean value is
  `400 invalid-interpolate-flag` from `validateConfig`, and the layer is disabled
  with that reason on the load path. `"false"` is rejected rather than read:
  a truthy string is exactly how a safety switch becomes a bomb;
- the layers merge on **statedness**, not on truthiness: a workspace layer that
  states a boolean wins; otherwise the user layer's stated boolean applies;
  otherwise the merged config states nothing, which is OFF. A workspace layer
  that states nothing therefore **inherits** the user layer instead of silently
  turning the switch off;
- `interpolateCustom` is a config-level field, not an override field, and it is
  carried across every rebuild (`upsertOverride`, `removeOverride`,
  `legacyPlan`, `planImport`) so that saving a prompt, clearing a layer or
  importing a document never turns the switch off by accident.

### 16.2 Runtime switching: the definition is never touched

The reserved section is registered with `interpolate: false` and **stays that
way**. Revision 15 (design A) deleted the old runtime switching — the code that
pushed `interpolate: true` onto the live definition object — together with the
`state.customDefinition` reference it needed. The definition object the service
holds is a constant as far as this plugin is concerned; only unloading the plugin
disposers it.

The switch is therefore applied **per assembly**, on the assembly's own context,
and it decides **whether the plugin expands the text**, not whether DSH does:

- `assembleHandler` already resolves the config this dispatch must apply —
  `mergeLayers(userLayer, workspaceLayerOf(session))` for a real turn, the probe's
  own config for the snapshot — and `mergeLayers` carries the statedness-merged
  flag on it. That single value is what `GET /snapshot` reports as
  `layers.interpolate.effective`, and what gates the expansion a few lines later
  (§16.9);
- no process-wide field is read on the assembly path, so two sessions with
  different flags cannot describe each other and a session-less ping cannot move a
  session's behaviour (Revision 12's F3, unchanged and still asserted).

This is strictly simpler than what it replaces. Revisions 11–14 needed three
measured Host properties — that `NamedEntries` stores the definition by reference,
that `assemble()` copies `section.interpolate` before any listener runs, and that
`renderPrompt` reads the field off the sections it is given — to argue that
mutating the definition at the right moment was observable, and that the right
moment was the outermost listener's post-`next()` step. Under design A none of
that matters: the field is never mutated, and the expansion's correctness does not
depend on where in the waterfall it runs (§16.9.4). The F1/F2 regressions in
`test/integration.test.mjs` measure the two ways that assumption used to be
falsifiable — a `{prepend: true}` listener registered after the mount, and a host
that drops the options object — and both now cost at most an unexpanded turn.

### 16.3 What the validator answers, and what it no longer decides

`core/interpolate.js` transcribes the shipped `interpolate()` line by line, with
the Host's own `VARIABLE_NAME` and `GROUP_AT` expressions. Revision 15 (design A)
leaves that transcription alone and changes **who is asked what**: the reserved
section never interpolates, so the assembly no longer "holds anything back" — the
plugin's own lenient expansion (§16.9) decides, per reference, whether it
substitutes or stays literal.

| Condition | Shipped behaviour (strict section) | Write face | Reserved section (Revision 15: `interpolate: false`, plugin expansion) |
| --- | --- | --- | --- |
| a `{{` with no complete group **and a later `}}`** | throws `malformed prompt variable reference` | `400 unresolvable-variable` | stays literal; the two braces are written out and the scan continues |
| inner text not matching `^[a-z][a-z0-9_]*$` | throws `malformed prompt variable reference "…"` | `400 unresolvable-variable` | stays literal |
| name not registered in `assembly.variables` | throws `unknown prompt variable` | `400 unresolvable-variable` | stays literal |
| registered name whose value is `undefined` | throws `prompt variable "…" has no value` | **warning, save proceeds** | stays literal (Revisions 13–14 held the turn back instead) |
| registered name whose value is `null` | renders the string `null` | accepted, not reported | rendered as `null` — identical |
| a `{{` with **no** later `}}` | literal prose | accepted, not reported | literal prose — identical |
| a substituted value | never re-scanned | never re-scanned | never re-scanned — identical |
| no variable table available while the text carries `{{` | would throw on the first reference | `503 variable-lookup-failed` | everything stays literal |

Only one row is a real asymmetry, and it is the `undefined` value:

- the **write face** asks "would this text ever expand for *some* session?", and
  the table it holds is a probe's table, not the session's. `undefined` is a
  property of the **assembly that was probed**, not of the text: the shipped
  renderer documents that a provider may return `undefined`, and a probe with no
  active agent leaves agent-scoped providers valueless. Refusing the save would
  make the switch unusable whenever nothing is running, and the same text can be
  perfectly fine in a live session. So the save proceeds and the advisory rides
  the response;
- the **reserved section** asks nothing at all. Its expansion resolves what this
  turn's table can resolve and leaves the rest literal, so an `undefined` value
  costs one unsubstituted reference — never a turn (§16.9).

Two functions survive, and Revision 15 gives each a different job than it had:

- `scanThrowingReference` — the strict transcription, all four throw conditions,
  `undefined` included, a missing table read as "every name is unknown". No
  decision path calls it any more; it is the **oracle** the tests diff the
  expansion against, so "we still know exactly what the shipped renderer would do"
  stays measurable (§16.9.1);
- `lintPromptText` — the same walk with `undefined` routed to `warnings`, still
  the write face's only judge.

Both are pinned against the real `renderPrompt` in `test/interpolate.test.mjs` and
`test/integration.test.mjs`.

**Revision 12 (audit F2): the warning is on the wire.****Revision 12 (audit F2): the warning is on the wire.** Until Revision 12 the
validator returned it and the routes threw it away, so the one user who needed it
— the one whose reference is registered but valueless in the probed assembly —
could not see it at all. Now `PUT /overrides`, `PUT /interpolate` (arming) and
`POST /import` attach it as an additive, **conditional** field:

```json
"warnings": [
  { "name": "model", "kind": "undefined-value", "code": "unresolved-at-save",
    "message": "the user layer (…) references `{{model}}`, which is registered but has no value …" }
]
```

- the field is present exactly when there is something to say (at most three
  entries, in scan order), so a response with nothing to report is byte-identical
  to the one earlier revisions returned;
- it is **not** an error: the write did happen, and the panel renders it as an
  advisory next to the switch, not inside a failure banner;
- `test/route.test.mjs` asserts both directions (a valueless reference is saved
  and reported; a clean text carries no field), and
  `test/client.test.mjs` asserts it reaches the screen and is cleared by the next
  write.

The variable table is obtained from a real `assemble()` under this plugin's own
private scope (`probe`, the same mechanism the snapshot uses), cached per mount,
and **re-probed on every write validation** so a name registered after the mount
started is never refused on a stale reading. A profile where that probe fails
answers `503 variable-lookup-failed` rather than guessing — a guess of "safe"
is how a bomb gets in.

Two guards exist because the probe is a snapshot of a live object:

- the condition list above is checked for **fatal** faults only, and a table that
  could not be obtained at all is read as "every name is unknown" on the write
  path (fail closed). Revision 15 removed the load-path reading entirely: it
  existed so that one failed probe would not disable a layer, and no layer is
  disabled for its text any more (§16.5);
- substituted values are not re-scanned, because only the input is walked — the
  same guarantee the shipped renderer makes, and the reason a variable whose
  value contains `{{…}}` is not a bomb.

### 16.4 `GET` and `PUT /prompt-setting/interpolate`

`GET` (query `session`, optional) answers:

```json
{
  "ok": true,
  "interpolateCustom": false,
  "layers": { "user": null, "workspace": null },
  "variables": ["cwd", "model", "provider"],
  "variablesError": null
}
```

`variables` is the assembled table's key set, or `null` with a reason in
`variablesError` when this mount could not obtain one.

`PUT` takes `{ enabled: boolean, layer?: "user" | "workspace", session?: string }`
(`layer` defaults to `user`; `session` may also be `?session=`), or the
Revision 12 three-valued spelling `{ state: "inherit" | "on" | "off", … }`
(§16.8).

- one of the two spellings must be present: a body with neither is
  **`400 invalid-enabled`**, and a `state` outside the three is
  **`400 invalid-state`**. An unknown layer is `400 unknown-layer`, the same code
  every other route answers;
- **a transition to ON** validates the text already stored in every layer whose
  text this change would arm (§16.5's rule, below). A refusal is
  `400 unresolvable-variable` and names the file and the way out;
- **`off` and `inherit`** validate nothing: they can only ever make text safer;
- the write is `writeConfig` + the in-memory cache. Nothing else has to be
  refreshed: the definition is never flipped, and the expansion is derived per
  assembly from the config that assembly resolves (§16.2, §16.9). The answer is
  `{ "ok": true, "interpolateCustom": true, "layer": "user", "state": "on", "saved": { "enabled": true, "state": "on" }, "effectiveFrom": "next-turn" }`
  plus `warnings` when there is something to report;
- a refusal leaves **both layer files byte-identical**: the shape check, the
  target resolution, the stored-text check and the variable probe all run before
  the first `writeConfig`, and `test/route.test.mjs` hashes the files around
  every one of them.

**The F1 rule (Revision 12): what decides whether a text is validated.** Not "the
layer being written", which was the bypass, but whether the text can reach an
assembly whose switch is ON (`armedLayers`, `index.js`) — i.e. an assembly whose
turn would expand it:

- the **user** text is merged into every session that carries no workspace entry
  of its own, so it is validated as soon as the user layer or **any** visible
  workspace layer states ON. (Slightly conservative on purpose: a workspace that
  states ON *and* carries its own text does not in fact use the user's, and the
  write is refused anyway — this is the audit's "write the user layer while a
  workspace is armed" case);
- a **workspace** text is rendered only for that workspace's sessions, where the
  merge decides: it is validated exactly when `effectiveInterpolate(user,
  workspace)` is ON. An explicitly closed workspace is therefore the one
  configuration whose literal braces provably reach no expansion, and it is not
  refused — which is what makes §16.8's explicit OFF worth having;
- the verdict is computed on the **post-write** view, so the change being
  requested is what is judged.

The audit text also suggests the blunt "if any layer is ON, validate every
visible layer". That variant is **not** used: it would refuse the writes that make
explicit OFF useful. Every case the audit reproduced is refused by the rule
above — `test/route.test.mjs` freezes all of them (the two-step
bypass, the reverse direction, `import` with and without `dryRun`) and one
counter-case (a closed workspace keeps its literal braces):

| Route | What is validated | On failure |
| --- | --- | --- |
| `PUT /overrides` | the text about to be stored, when it is armed after the write | `400 unresolvable-variable`, zero bytes |
| `POST /import` | the document's reserved-section text, when it is armed after the write | `400 unresolvable-variable`, zero bytes, dry run included |
| `PUT /interpolate` | every stored text this change arms | `400 unresolvable-variable`, zero bytes |

Each of the three routes attaches `warnings` (§16.3) to a successful answer.

**D1 (Revision 13): the judged set and the write target are one source.** The F1
rule above is only as good as the set it ranges over, and Revision 12 took that
set from the cache (`state.workspaces`) while `targetFor` resolved the target
through `workspaceRegistry.list()`. A workspace the registry starts listing
*after* the request's `refreshLayers()` is absent from the cache, so
`armedLayers(next, target).some((layer) => layer.root === target.root)` could not
be true — the write was accepted unverified, and `cacheWritten` then put the
layer into the cache so the session really did interpolate the bomb. Two
independent guards now hold, and both are fail-closed:

- `targetFor` loads the resolved root through `loadWorkspace` — the same reader
  the refresh uses — before any verdict is taken, so the two sources cannot
  disagree about which layers exist;
- `assertTargetJudged` then refuses the write with
  **`400 write-target-unverified`** if the target is nevertheless not in the
  judged set. It is deliberately a refusal and not a silent skip: a text whose
  participation could not be judged is exactly the text the switch exists to
  stop. The code is new, the status is the same `400` every other shape refusal
  uses, and the file is left byte-identical.

  **Normally unreachable, kept on purpose (Revision 14, audit E4).** With the
  `targetFor` guard above in place, the target is always in the judged set by the
  time this runs — the audit confirmed the D1 reproduction is closed and could not
  reach it. It stays as a belt-and-braces guard rather than being deleted: it is
  the only thing that stands between a future refactor of `targetFor` and a
  fail-open write, it costs one `Array.some` over the layers, and the direction it
  can be wrong in (over-refusal, `400`, no bytes) is explainable and repairable.
  Nothing in the contract depends on it firing.

`test/route.test.mjs` freezes the audit's timing — `registry.list()` returns `[]`
for the request's cache refresh and the workspace for the `targetFor` that runs
after `readJsonBody` — and asserts the refusal plus zero bytes.

### 16.5 Historical text: what is checked, and what is deliberately not

Opening the switch still validates what is **already stored** before it writes
anything (§16.4), and the refusal is still actionable: it names the references,
the layer file, the registered variable names, and the ways out (delete the
reference, use a registered name, or keep the switch off).

What Revision 15 changed is **why**. With the section permanently
`interpolate: false`, an old `{{typo}}` is no longer a per-turn throw, so that
check is a courtesy which stops the user from arming text that will never
substitute — not a safety gate. Two consequences, both deliberate:

- **No load-time degradation.** `selfCheckConfig`, `enforceVisibleTextsSafe` and
  the `unresolvable-variable` degradation are deleted. A config that reaches disk
  armed — a hand edit, a config-sync tool, a file written while the plugin was
  down — is read as written: the layer stays `enabled`, its text reaches the
  prompt, and its dead references render literally (graded `unresolvedLiteral`,
  §2.3). Disabling the layer would have deleted the user's prompt in order to
  prevent a failure that can no longer happen;
- **No cross-layer pass and no timing window.** Revision 12's F1 pass existed to
  catch text that *another* layer's flag armed, and Revision 13's D2 found the
  window between `mount` and the first request, when the variable table was still
  missing. Both problems were about *when a verdict could be taken*; with no
  verdict to take, there is no window. The first assembly after a hand edit is as
  safe as the thousandth, and `test/integration.test.mjs` asserts exactly that
  (no route request has run; the real `renderPrompt` must not throw), including
  the `undefined`-value variant (`cwd` registered with a provider that returns
  `undefined`, `Object.hasOwn(variables, 'cwd')` asserted true so the case cannot
  silently degrade into the unregistered one).

The F1 rule survives **only** on the write face, where it is unchanged in effect
(§16.4): the question there is still "does this text reach an assembly whose
switch is ON?", because that is the text a user would be misled about. F5's panel
half — a disabled layer is named, explained and given a way out
(`data-warning="mine-layer-disabled"`) — is untouched; it now applies to
file-level problems (invalid JSON, an invalid field, a deleted file) and to
`invalid-interpolate-flag`, which are the only reasons a layer can be disabled any
more. `test/client.test.mjs` still freezes that path.

### 16.6 The preview agrees with the behaviour

`rendered`, `renderedResolved`, `unresolvedThrowing` and `unresolvedLiteral`
(§2.3) are computed from the section list the snapshot's own probe produced — and
that probe runs the real waterfall, so the reserved section it sees is the one the
plugin has already expanded (or deliberately left alone) for that assembly. There
is no separate "preview rule" that could drift:

- switch OFF (default): the reserved section is `interpolate: false` and its text
  is untouched, so its unresolved references are graded `unresolvedLiteral` and
  `renderedResolved` stays `true` — the braces in the preview are the real prompt;
- switch ON: the preview carries the **substituted** bytes exactly as the real
  turn does. A reference that resolved is gone from the preview (so it cannot be
  reported as unresolved, correctly); a reference that did not resolve is still
  there, still `interpolate: false`, and still graded `unresolvedLiteral` — which
  under Revision 15 is the truth for the real renderer as well, because the
  section is never interpolated;
- a **throwing** reserved section is therefore unreachable as a preview state —
  not because a hold hides it, but because nothing about this section can throw.
  `unresolvedThrowing` still describes every **other** section in the assembly,
  which is what it was always about, and the reserved section's own dead
  references are exactly the literals the user wrote.

Revision 11's grading correction stands and Revision 15 does not touch it: a
malformed group (a `{{` with a later `}}` that no group matches) is reported as
**throwing** in a section that interpolates, rather than called prose, with the
same 16-character excerpt the Host's own message quotes.
`test/interpolate.test.mjs` asserts the correction *and* the old reading's miss,
so the difference cannot regress silently.

### 16.7 Reversibility

- closing the switch removes the key from the config file, restoring the
  pre-switch bytes exactly (asserted with SHA-256 over the whole file);
- the same request makes the next assembly literal again: with the key gone the
  effective value is OFF and `assembleHandler` performs no expansion, so the
  `{{...}}` reach the model exactly as written. There is no definition to restore,
  because none is ever moved (Revision 15);
- ON → OFF → ON is idempotent in both directions: a repeated ON rewrites the same
  bytes, and the expansion is a pure function of (text, table), so nothing
  accumulates anywhere;
- a hand-edited file is picked up by the next request (the layers are re-read at
  the top of every handled request and the expansion is derived from that read)
  and by mount, so a restart is never required to observe the switch.

### 16.8 The three states (Revision 12, audit F4)

The switch is not a boolean, it is a three-valued field, and the distinction is
what the merge rule rests on:

| State | On disk | Merged meaning |
| --- | --- | --- |
| `inherit` | the key is **absent** | this layer states nothing: the other layer's stated value applies |
| `on` | `"interpolateCustom": true` | this layer states ON |
| `off` | `"interpolateCustom": false` | this layer states OFF, and the other layer's ON cannot override it |

`GET /interpolate` and `GET /snapshot` have always reported it that way
(`true` / `false` / `null`).

`PUT` accepts both spellings, and they are deliberately **not** the same thing:

- `{"enabled": true}` → `on`; `{"enabled": false}` → `inherit`, i.e. the key is
  **deleted**. That is the Revision 11 spelling and it keeps its exact effect, so
  an on→off cycle on a layer that never declared the field is still a
  byte-for-byte revert (§16.7);
- `{"state": "on" | "off" | "inherit"}` is the three-valued spelling. `off`
  writes the boolean, which `enabled` cannot express — and without it a workspace
  layer could not close a switch the user layer had opened: the write would
  delete nothing (the key was already absent), the layer would keep inheriting
  ON, and the panel would say OFF while the session interpolated.

The browser presents all three side by side (`data-action="mine-interpolate-state"`)
and keeps the two-valued toggle as the shortcut between ON and "unstated"; when a
layer inherits ON it says so and points at 「显式关」, because turning such a layer
"off" with the two-valued spelling only keeps it unstated. An unknown `state` is
`400 invalid-state` with zero bytes written.

### 16.9 Revision 15 (design A): the section never interpolates, the plugin expands it

Revisions 11–14 tried to earn the right to let DSH interpolate the reserved
section, and paid for it with a verdict, a hold map and a position assumption.
Revision 15 removes the failure mode structurally instead:

1. **The reserved section is `interpolate: false` forever.** It is registered that
   way (`core/custom.js`) and **nothing ever flips it** — not a route, not a mount
   step, not an assembly. DSH's strict interpolator therefore never sees this
   text, so "an unknown, valueless or malformed reference throws every turn" is
   not prevented, it is impossible. This restores and strengthens g-014's gate;
2. **The switch now means "this plugin expands the text itself".** With it ON,
   `assembleHandler` substitutes `{{name}}` in the reserved section's text during
   the assembly, using the variable table **that assembly carries**
   (`downstream.variables ?? assembly.variables`) — never a cached probe reading
   and never a config reading;
3. **The expansion is lenient** (`expandPromptText`, `core/interpolate.js`). It
   walks the text with the shipped renderer's own scan (the `{{` search,
   `VARIABLE_GROUP` at the scan position, the "lone `{{` with no later `}}` is
   prose" rule, and "a substituted value is never scanned again"):
   - a **registered name with a value** becomes `String(value)` — byte-identical
     to what the strict renderer produces for the same text;
   - an **unregistered name**, an **`undefined` value** and a **malformed group**
     stay **literal**. It never throws, and it never writes a bare `undefined`;
   - every shape the shipped renderer throws on is therefore a shape this function
     accepts, and §16.9.1 states each difference exactly;
4. **Position does not matter.** The expansion runs right after `applyOverrides`
   inside the ordinary `assembleHandler`. It does not rely on `{prepend: true}`
   and it does not claim to be the outermost listener. If a listener outer to it
   rewrites the sections afterwards, the worst outcome is **"this turn was not
   expanded"** — the user sees the literal braces — and never a failed assembly.
   That is the whole point of the design;
5. **The hold mechanism is gone.** `interpolateHoldReason`, the per-scope hold
   map, `layers.interpolationHold` and the Revision 14 `resolvedByContext`
   hand-off were all machinery for "judge whether this turn would throw". There is
   nothing to judge any more. A reference this assembly cannot resolve is reported
   exactly where g-025 already reports it: `unresolvedLiteral` (§2.3), because the
   section is `interpolate: false`;
6. **The load-time interpolation self-check is gone too.** `selfCheckConfig`,
   `enforceVisibleTextsSafe` and the `unresolvable-variable` degradation of a
   layer are deleted: nothing stored in a layer can break an assembly, so
   disabling a layer for its text would only discard the user's prompt. A
   hand-armed file is loaded as written, and its dead references render literally;
7. **The write face is unchanged in what it refuses** (§16.3, §16.4, §16.5): an
   armed text whose reference could never expand is still
   `400 unresolvable-variable`, and a registered-but-valueless name is still saved
   with a warning. It is no longer a safety requirement — it is UX, so that a user
   does not save text which will silently never substitute. The messages say that
   now, instead of promising a throw that cannot happen.

#### 16.9.1 The deliberate differences from the shipped renderer

| Shape | Shipped `interpolate()` (strict section) | This plugin's expansion (reserved section) |
| --- | --- | --- |
| registered name with a value | `String(value)` | `String(value)` — **identical** |
| registered name whose value is `null` | renders `null` | renders `null` — **identical** |
| a substituted value containing `{{…}}` | never re-scanned | never re-scanned — **identical** |
| a `{{` with no later `}}` | prose | prose — **identical** |
| unregistered name | **throws** `unknown prompt variable` | stays literal |
| illegal name (`{{Upper}}`, `{{a b}}`) | **throws** | stays literal |
| malformed group (`{{ lone {{c}}`, `{{{{a}}}}`) | **throws** | the two braces are written out and the scan continues from there, so a well-formed group later in the same string still resolves |
| registered name whose value is `undefined` | **throws** `has no value` | stays literal |
| no variable table available | would throw on the first reference | everything stays literal |

`test/integration.test.mjs` pins the first four rows differentially against the
real `renderPrompt` over an enumerated corpus (every pairing of the shapes the
shipped scanner branches on): **on the resolvable subset the plugin's bytes are
the renderer's bytes**, and for every other shape the renderer really does throw
while the expansion does not. `test/interpolate.test.mjs` pins the same table in
the small, and `test/route.test.mjs` / `test/integration.test.mjs` pin the two
position regressions — F1, a `{prepend: true}` listener registered **after** the
mount; F2, a host that ignores listener options — where the real `renderPrompt`
must not throw and "not expanded" is the accepted degradation.

#### 16.9.4 Where the expansion runs, and the one premise a later listener must keep

The expansion is **position-independent**: it runs inside this plugin's own
`assembleHandler`, after `applyOverrides` has written the stored text into the
reserved section, and it needs nothing from any other listener. That is the whole
point of Revision 15 — the safety of「我的 Prompt」no longer depends on this plugin
being the last (or the outermost) listener. Cordis implements `{prepend: true}` as
`unshift`, so a listener registered **later** with `{prepend: true}` runs *outside*
this one; the order is a property of registration time, not a promise this plugin
can make.

Two consequences, both accepted and both measured:

- if a later listener rewrites the section's **text**, the expansion has already
  run and the rewrite wins: that turn renders the rewritten text, and the worst
  case is **one unexpanded turn** — never a throw;
- if a later listener rebuilds the reserved section as a fresh object (for example
  `{ name, text }`), it must carry the `interpolate` field over. That field is what
  the shipped renderer branches on: `renderPrompt` interpolates unless the value is
  exactly `false`, so **dropping the field is equivalent to turning interpolation
  on** and re-introduces the strict path this revision removes. This plugin's three
  rebuild sites all spread the original section (`{ ...sections[at], text }`), and
  `test/integration.test.mjs` asserts the field survives every assembled shape it
  constructs; a third-party rebuilder that drops it owns that outcome.

### 16.10 Assertion rewrites in Revision 15 (each one, and why)

The rewrite policy for this goal: assertions written before g-026 are untouchable;
assertions this goal added and this design disproves may be rewritten minimally,
in the direction of **tighter or equivalent**, with the coverage carried by a
replacement case. Every changed assertion is listed here.

| Rewritten assertion (Revisions 11–14) | Why it had to change | What replaces it (tighter or equal) |
| --- | --- | --- |
| "enabling flips the LIVE definition to `true`" (`test/route.test.mjs`) | the definition is never flipped | the definition and the registration snapshot stay `false` through ON, **and** the next assembly's text is asserted expanded — strictly more than the old flag check |
| "the switch survives a remount because mount flips the definition" | mount writes nothing any more | the remount is asserted to restore the **expanded render**, which is the behaviour that mattered |
| "a layer that arms a bomb on disk is degraded" | nothing is degraded any more | the same file is asserted **enabled**, its text present, and its dead reference graded `unresolvedLiteral` with zero throwing references |
| "a hand-armed layer degrades the unstated layer it arms" (cross-layer pass) | the pass is deleted | both layers stay enabled and the dead reference is asserted literal in the scoped preview |
| "the assembly holds an `undefined` value back" / "`interpolationHold` carries the reason" | the hold field and the strict holding rule are gone | the same turn is asserted **literal** (`interpolate: false`, text unchanged), and `layers` is asserted to have **no** `interpolationHold` key at all |
| "the hold verdict is exact against the renderer — 0 misses, 0 false positives" (two differential tests) | there is no hold verdict | replaced by the **expansion** differential over the same enumerated corpus: byte-identical on the resolvable subset, no-throw on the rest (stronger — it compares bytes, not verdicts) |
| "the first turn of an armed layer with a valueless name holds instead of throwing" | replaced by the same literal-turn assertion | the first turn after mount is asserted to render literally, and `renderPrompt` is asserted not to throw |
| "E2: the verdict reads the final sections and the final variable table" | the verdict is gone; the expansion is position-independent | three listener shapes (inner rewrite, late `prepend` rewrite, late variable) are each asserted to keep `interpolate: false` and to leave the real renderer un-thrown |
| "E3: a hold is the current state — fixing the text or closing the switch clears it" | the hold record is deleted | ON expands / OFF is literal, and the snapshot is asserted to carry no hold key in either state |
| the shipped-vs-plugin validator table (§16.3) | the assembly column no longer "holds back" | the table now reads "stays literal", and §16.9.1 states the intended differences explicitly |

Nothing was weakened: every rewrite either adds an assertion (the render half) or
replaces a "verdict" assertion with a "byte" assertion, and the exhaustive
differential corpus from Revisions 13/14 is kept and re-aimed rather than dropped.
The validator section of `test/interpolate.test.mjs`, the warning and
degraded-layer paths of `test/client.test.mjs`, and every assertion written before
g-026 are untouched.

### 16.11 What Revisions 11–15 do not do

- They do not add an escape syntax. DSH has none, so with the switch ON a literal
  `{{...}}` cannot be written in「我的 Prompt」 — the panel says so next to the
  switch rather than letting the save fail mysteriously. The one exception is a
  layer that explicitly states OFF: its text reaches no expansion, so its braces
  are storable (§16.4);
- they do not make the switch per-section or per-text. It is one field per layer,
  and it governs the one section this plugin owns;
- they do not check other plugins' sections, and they do not turn anybody else's
  interpolation on or off;
- Revision 15 does **not** change the write face's conditions: unregistered,
  illegal and malformed references stayed `400 unresolvable-variable`, and a
  registered-but-valueless name stayed a warning (§16.3). Only the wording now
  says the truth — nothing throws;
- Revision 15 does **not** claim the expansion is the last word on the assembly.
  A later listener may overwrite it (§16.9.4); that is accepted, and the price is
  one unexpanded turn;
- they do not claim anything about a running `dsh web`: like every revision
  before them, the Host half needs the process to pick the new code up, and what
  is verified here is verified offline against the real
  `@deepseek-ai/dsh-system-prompt` in a real Cordis context.

---

## 17. The upstream update check (g-030; npm first in Revision 27, g-042)

**Revision 27 (npm is the primary source, GitHub Releases the fallback — g-042).**
The check used to ask the GitHub Releases API and nothing else. It now asks the
**npm registry** first (`<registry>/dsh-prompt-setting`, read for
`dist-tags.latest`) and falls back to the GitHub Releases API only when npm could
not answer. Every answer carries a new **`source`** marker (`"npm"` / `"github"` /
`null`) and, for an npm answer, the packument's own **`versions[<version>].dist.tarball`** —
which §18.2 then installs from. The registry base address is **injectable**
(`updateCheck.registry`, default `https://registry.npmjs.org/`); that one slot is
what g-043's download-region choice wires into. **No route, no query parameter,
no preference-file byte and no existing field changes meaning**: `source` and
`tarball` are additive, so a pre-g-042 client renders exactly as it did.

### 17.1 Why a Host route, and why npm first

This plugin is installed as a tarball or a `link:`, so nothing in npm's own
tooling ever tells a user that upstream moved on. The check exists to answer that,
and it asks the address the package is actually **published** to: the owner's
original decision (2026-10-03) was one `GET` against the **GitHub Releases API**;
g-042 re-founded it on the **npm registry** — the registry is where
`dsh plugin add dsh-prompt-setting` resolves from and the one address a mirror can
be pointed at — and kept GitHub Releases as the **degradation path**, so a profile
behind a registry that does not carry the package still gets an answer. The request
is made by the **Host**, not the page: Node has no CORS wall, the answer can be
cached, the request can time out, and the whole feature can be switched off
server-side. The page only ever reads the result.

Four properties are contract, not implementation:

- **never a false positive.** `hasUpdate: true` is emitted only when both
  versions parse and `latest > current`. Every undecidable case is
  `hasUpdate: null`;
- **a failure is a value.** The route answers `200` for every outcome it can
  have — including a network error, a timeout and an HTTP error from either
  upstream. Only a malformed `PUT` body is an ordinary `400` (§17.4). No update
  check can produce a `5xx`, and none can paint the settings page red;
- **npm first, GitHub only as the fallback.** The fallback runs when npm **could
  not answer** — never because its answer was inconvenient: a registry that says
  "you are up to date" *is* the answer (§17.2);
- **one identifiable request per upstream, no user data, and the answer names its
  source.** At most one `GET` per upstream, `user-agent:
  dsh-prompt-setting/<version>`, `accept: application/json` for the registry and
  `accept: application/vnd.github+json` for GitHub. No body, no cookies, no query
  derived from this machine, this session or this workspace — and `source` says
  which upstream produced the payload the page is reading.

### 17.2 `GET /prompt-setting/update-check`

Query: `force` (optional). The **npm** URL is `updateCheck.registry` (default
`https://registry.npmjs.org/`) plus the package name; a registry that is not an
`http(s)` URL disables the npm path rather than silently asking the default one.
The **GitHub** URL is the fallback's: `package.json`'s `repository.url`, parsed
once per check by `parseRepositorySlug` into `{owner, repo}`; nothing is hardcoded
a second time and no request input reaches either URL. The accepted manifest
spellings are `git+https://…`, `https://…`, `git://…`, `git+ssh://git@…`, the
scp-style `git@github.com:owner/repo.git` and the `github:owner/repo` shorthand;
anything that is not `github.com` with exactly two path segments is refused
(`200`, `ok:false`, `error.code: "no-repository"`).

**Decision order, and it is the whole of g-042's change:**

| # | Asked | Outcome |
| --- | --- | --- |
| 1 | the switch (§17.4) | off ⇒ `hasUpdate: false`, **zero requests**, `source: null` |
| 2 | the cache (§17.3) | fresh ⇒ the cached payload with `cached: true`, `source` preserved |
| 3 | the npm registry | a `dist-tags.latest` that parses ⇒ **that is the answer**, `source: "npm"`, GitHub is not asked |
| 4 | the npm registry | impossible to answer (see below) ⇒ go to 5 |
| 5 | the GitHub Releases API | a 2xx release ⇒ the answer, `source: "github"` |
| 6 | — | neither answered ⇒ `ok:false`, `source: "github"`, `error` naming the GitHub attempt and `error.npm` naming the npm attempt |

The npm attempt is **unusable** — and the check goes on to GitHub — when: there is
no usable registry, the transport throws, the request times out, the status is not
2xx (including `404`: this registry does not carry the package), the body is not a
package document, `dist-tags` or `dist-tags.latest` is missing, or
`dist-tags.latest` is not a version. Not one of those is reported as "upstream
says nothing": they are npm's silence, and the fallback exists for exactly them.

The body of an **npm** answer:

```json
{
  "ok": true,
  "enabled": true,
  "current": "0.1.5",
  "latest": "0.2.0",
  "latestTag": "0.2.0",
  "hasUpdate": true,
  "releaseUrl": null,
  "publishedAt": "2026-09-25T00:00:00.000Z",
  "source": "npm",
  "tarball": "https://registry.npmjs.org/dsh-prompt-setting/-/dsh-prompt-setting-0.2.0.tgz",
  "checkedAt": "2026-10-08T09:00:00.000Z",
  "cached": false,
  "error": null
}
```

The body of a **GitHub** answer (the pre-Revision-27 shape, plus `source`):

```json
{
  "ok": true,
  "enabled": true,
  "current": "0.1.5",
  "latest": "0.2.0",
  "latestTag": "v0.2.0",
  "hasUpdate": true,
  "releaseUrl": "https://github.com/zangxx66/dsh-prompt-setting/releases/tag/v0.2.0",
  "publishedAt": "2026-10-01T00:00:00Z",
  "source": "github",
  "tarball": null,
  "checkedAt": "2026-10-08T09:00:00.000Z",
  "cached": false,
  "error": null
}
```

| Field | Meaning |
| --- | --- |
| `ok` | `true` when the check produced a decidable or explicitly undecidable answer; `false` on a failure, with `error` set. |
| `enabled` | The switch as persisted (§17.4). Answered on both verbs so the page needs one round trip, not two. |
| `current` | This package's `PLUGIN_VERSION` (the same constant the ping reports). |
| `latest` | The normalized `major.minor.patch` of the reported version, or `null` when there is nothing usable. The raw string is never echoed as a version. |
| `hasUpdate` | `true` only for a confirmed newer version; `false` when the current version is equal or newer; `null` when it cannot be decided. |
| `latestTag` | The version **as published**, verbatim, for the same version as `latest` — the GitHub release tag, or npm's `dist-tags.latest` — or `null` when the answer is not about a published version. `latest` is canonicalized (`v0.1.2` → `0.1.2`) and is therefore the wrong string for a release **asset** path; both travel on one payload, from one request, so「install this version」can never name a tag the check did not see (g-032, §18.2). |
| `releaseUrl` | GitHub: the release's `html_url`, else `https://github.com/{owner}/{repo}/releases/tag/{tag}`, else `null`. npm: always `null` — the page's one link is labelled for a release page, and pointing that label at a registry URL is g-043's copy to write. |
| `publishedAt` | GitHub: the release's `published_at`. npm: the registry document's `time[<latest>]`. Either way `null` when upstream did not say. |
| `source` | **Which upstream produced this payload**: `"npm"`, `"github"`, or `null` when no upstream was consulted at all (the switch is off, or the runtime has no `fetch`). Additive, for display and diagnostics. |
| `tarball` | **The npm answer's install spec**: the packument's `versions[<version>].dist.tarball`, verbatim — or `null` on any answer that is not an npm one, and `null` when the document carried no usable string. What the field *is* is upstream's word; whether it may be handed to pnpm is decided in §18.2. |

**Where the tarball is read from (revision 27 review fix).** A real npm packument
has **no top-level `dist`** — full (`application/json`) and abbreviated
(`application/vnd.npm.install-v1+json`) documents alike put every version's
artifact at **`versions[<version>].dist.tarball`**; the top level carries `name`,
`dist-tags`, `versions`, `time` and friends. The first revision of §17 read
`body.dist` and answered `tarball: null` for **every real check** while passing its
own tests — the defect the owner's real-machine review caught, and the reason the
lookup below is stated as contract:

1. `versions[dist-tags.latest]` — the dist-tag **verbatim** (`v0.2.0`);
2. `versions[<canonical version>]` — the same version canonicalized (`0.2.0`), for a
   dist-tag that carries a `v` the version keys do not;
3. a top-level `dist.tarball` — a **tolerance** for a non-standard registry, never
   the primary source.

The request keeps `accept: application/json` (the full packument, whose `time`
object is what `publishedAt` reads). Switching to the abbreviated document would
not move the tarball path at all, but it would drop `publishedAt`; that is a
deliberate non-change, not an oversight.
| `checkedAt` | When this answer was produced (ISO 8601), including a cached one — it names the check, not the read. |
| `cached` | `true` when the answer comes from the cache rather than a fresh request. |
| `error` | `null`, or `{code, message}` plus `status` for an HTTP error. Codes: `no-repository`, `fetch-unavailable`, `network-error`, `timeout`, `http-error`, `invalid-response`, `no-release`, `unparsable-tag`, `uncomparable-version`. When **both** upstreams failed, the payload carries the GitHub attempt's code/message and the npm attempt's own reason as `error.npm` (`{code, message, status?}`, present only when the npm path really ran). |

The decision table, which is the whole point:

| Situation | `ok` | `hasUpdate` | `error.code` | `source` |
| --- | --- | --- | --- | --- |
| npm `latest > current` | `true` | `true` | — | `npm` |
| npm equal, or `current` newer | `true` | `false` | — | `npm` |
| npm unusable, GitHub `latest > current` | `true` | `true` | — | `github` |
| npm unusable, GitHub equal/newer | `true` | `false` | — | `github` |
| npm unusable, GitHub 404 (no release yet) | `true` | `null` | `no-release` | `github` |
| npm unusable, GitHub tag is not a version (`nightly`, `1.2`, `1.2.3.4`) | `true` | `null` | `unparsable-tag` | `github` |
| npm unusable, GitHub body is not a release object / has no `tag_name` | `true` | `null` | `invalid-response` | `github` |
| npm version parses, this package's own does not | `true` | `null` | `uncomparable-version` | `npm` |
| both fail to answer (network error, timeout, HTTP ≠ 2xx) | `false` | `null` | `network-error` / `timeout` / `http-error` (+ `error.npm`) | `github` |
| npm unusable, no usable repository URL either | `false` | `null` | `no-repository` | `github` |
| no `fetch` at all | `false` | `null` | `fetch-unavailable` | `null` |
| switch off (`enabled: false`) | `true` | `false` | — | `null` |

`hasUpdate: null` renders **nothing on the main page** (no banner, no error — §13.9);
inside 「高级」 it gets one neutral sentence (「上游暂时没有可用的版本信息」), because it
is a *fact about upstream* rather than a failure of the check. The distinction is
deliberate and asserted both ways: a **failed** check (`ok:false`) renders no such
sentence and no red line either. The two used to share one condition, which read
the sentence on failure and hid it for the four upstream cases it was written for.

Semver parsing tolerates a leading `v`/`V` and a `-prerelease`/`+build` suffix, and
**compares only the core triple** — a documented simplification with a known
direction:

- `1.0.0` and `1.0.0-rc.1` compare **equal**, so `hasUpdate` is `false`. That is a
  **missed** update (a prerelease is never reported as newer), never a false
  positive: the rule "never claim an update that is not one" outranks "never miss
  one", and a missed prerelease costs nothing here because `/releases/latest`
  excludes prereleases upstream by definition and this package ships stable
  releases. Making `1.0.0-rc.1 < 1.0.0` would mean implementing full semver
  precedence for a case the data source cannot produce;
- comparison is numeric per segment, so `0.10.0` is newer than `0.9.9`;
- an npm `dist-tags.latest` that carries npm's own `v`-less spelling is compared
  the same way; a `latest` that reads `beta`/`next`-style is not a version and
  sends the check to the fallback rather than being guessed at.

### 17.3 Cache, timeout, and what is never cached

- **TTL 6 hours** (`UPDATE_CHECK_TTL_MS`). A repeat inside the window answers the
  cached payload with `cached: true` and performs **no** request — including a
  payload whose `source` is `github`, which is **not** re-opened by asking npm
  again. The cache lives on the mount, so a `dsh web` restart starts fresh;
- **`?force=1`** skips the cache — the「立即重查」button and the tests — and
  skips **only** the cache: a closed switch still answers without asking;
- **decidable answers are cached, failures are not.** `hasUpdate: true|false` and
  the determinate "nothing usable" answers (a GitHub 404, an unparsable tag) are
  cached, so an upstream without releases does not get re-asked on every page
  load. A network error, a timeout and an HTTP error are never cached: the next
  request starts at npm again;
- **timeout 5 s** (`UPDATE_CHECK_TIMEOUT_MS`), enforced with both an
  `AbortController` signal and an internal race, so even a transport double that
  ignores the signal cannot wedge a page. It is **per upstream attempt**: a check
  that has to fall back costs at most two timeouts, and a fallback is never
  retried inside one check;
- the transport, the clock, the two bounds **and the registry base address** are
  injectable through the plugin config
  (`updateCheck: {fetch, registry, now, ttlMs, timeoutMs}`), which is how the
  tests drive the real route offline. A profile that declares nothing gets the
  shipped defaults (`https://registry.npmjs.org/`).

### 17.4 `PUT /prompt-setting/update-check`, and the preference file

Body: `{"enabled": boolean}`. Anything else is **`400 invalid-enabled`** — the
same code and the same shape-refusal rule as `PUT /interpolate` — and no file is
written.

The answer is always `200`:
`{"ok": true, "enabled": false, "saved": {"enabled": false}, "effectiveFrom": "immediate", "error": null}`.
A write that cannot be persisted (an unwritable `$DSH_HOME`) answers
`200 {"ok": false, "enabled": <unchanged>, "error": {"code": "preferences-unwritable", …}}`
rather than a `5xx`: this feature's promise not to break the settings page covers
its own configuration too.

The preference lives in **its own file**, `<DSH_HOME>/prompt-setting/preferences.json`:

```json
{ "updateCheck": false }
```

- **not** in `overrides.json`. The switch is a fact about this installation's
  behaviour, not an override of any prompt section, and putting it in the layer
  config would drag it through the export / import / history / snapshot schemas —
  every one of which is a frozen contract that must not grow a field because a
  switch was added;
- **default `true`** (checking on). A missing, unreadable or malformed file all
  answer "on", and a malformed one is reported (`error.code: "invalid-json"`)
  rather than silently rewritten — the next save repairs it;
- **only the boolean `false` closes the switch.** `"false"`, `0`, `null` and
  anything else fall back to the documented default rather than being
  truthy-coerced into a privacy decision;
- `enabled:false` means **zero outbound requests**, including on page mount
  (§13.9) and including `?force=1`.

### 17.5 What this does not do

- no automatic download and no automatic install **by this check**: it reports,
  and the user follows the link. Installing is a separate, explicitly confirmed
  route added by g-032 (§18) — and that one never restarts anything either;
- no DSH platform version check — that is `scripts/check-compat.mjs` (g-013);
- **no mirror choice and no region detection** (Revision 27). This revision makes
  the registry base address injectable and stops there: which registry a user
  should be pointed at, how that is stored and how it is presented are g-043's
  download-region work, and no runtime geo-judgement is made anywhere here;
- no new runtime dependency: Node's built-in `fetch`, nothing else;
- no change to any existing route's response shape. `ping`, `snapshot`,
  `overrides`, `history`, `diff`, `export`, `import` and `interpolate` answer
  exactly what they answered before; the eighth route is additive, and the two
  fields Revision 27 adds to it (`source`, `tarball`) are additive too;
- no user data on the wire, and no per-session/per-workspace variation: the
  answer is the same for every session of one install.

## 18. 「立即更新」— installing a release through the official plugin manager (g-032; the npm install spec in Revision 27, g-042)

### 18.1 What it is, and what it deliberately is not

The update check (§17) tells a user that upstream moved on; it does not act.
This revision adds the one action the owner asked for (2026-10-03): a
「立即更新」button that has the **Host** install the release it just named, using
the official `pluginManager` service — and then asks the user to restart the
thing they actually started (g-036: `dsh web` from a terminal, or the DeepSeek
Harness application; §18.8).

The shape of the promise is the contract, and every negative is as load-bearing
as the positive:

- **the Host installs, the page only asks.** The page never runs a package
  manager, never downloads a tarball and never writes a file;
- **never a restart.** No route, no `inject`ed service call and no client code
  restarts `dsh web`. `ChangeResult.application === 'restart-required'` is a
  **success**, and its instruction —「已安装 vX.Y.Z」followed by what *this*
  launch shape has to do — is what reaches the page. The sentence is chosen from
  `launchKind` (§18.8) and is never written into a route: which launch shape the
  Host has is a fact about the Host, not about the request;
- **never a 5xx.** Every outcome is a `200`: a refusal
  (`{ok:false, code, message}`), a running install, a finished one, a failed one.
  Only a request whose **shape** is wrong is an ordinary `400`;
- **never an unapproved build script.** `installBundle` is called without
  `approvedBuilds`, so nothing writes the profile's `allowBuilds`. Approving a
  build script is a decision that must be made by a person looking at the script,
  not a side effect of pressing an update button;
- **never an unvetted spec.** The install spec comes from the check's own answer
  and from nowhere else; on the npm branch it must also pass an explicit
  `http(s)`/`.tgz` gate before pnpm ever sees it, and on the GitHub branch it is
  built from the checked tag and version (§18.2). A value that fails the gate is a
  named refusal, not an install;
- **never a `link:` overwrite.** A profile whose `dsh-prompt-setting` dependency
  is a local path is a development working copy; installing over it would replace
  that link with a published package and leave no way back. That case is refused
  with `development-link` and a manual route (owner's decision A1,
  2026-10-04);
- **never a second install.** While one install of this mount is live, a new
  `POST` answers the **running** request's id (`reused: true`) instead of starting
  a second `pnpm add` that would queue on the profile lock behind the first.

### 18.2 `POST /prompt-setting/update-apply`

Body (optional): `{"tag": string}`.

The tag is a **guard**, not an input: when it is present it must equal the tag
the current update check reported, and a mismatch is `400 invalid-request`. The
install spec is always derived from the checker's own answer — the same cached
answer the banner rendered — so「提示的版本 = 安装的版本」holds even though the
browser is untrusted. **Revision 27: which spec that is now follows the check's
`source` (§17.2) — and neither branch is ever taken from the request:**

| `source` | Install spec | Rule |
| --- | --- | --- |
| `"npm"` | the check payload's `tarball` — the packument's `versions[<version>].dist.tarball` (§17.2), verbatim | it must be a string that parses as an absolute `http(s)` URL whose path ends in `.tgz`. A payload that names **nothing** is refused `asset-missing`; a value that is present but is not such a URL (`file:`, `ftp:`, `data:`, `javascript:`, a `.zip`/`.tar.gz`, a relative path) is refused `asset-unverified`. **Neither is ever handed to pnpm** |
| `"github"`, or absent (a pre-Revision-27 Host) | the release asset | `https://github.com/zangxx66/dsh-prompt-setting/releases/download/<tag>/dsh-prompt-setting-<version>.tgz` |

**Both npm refusals still carry a clickable manual route** (revision 27 review
fix). An npm answer's `releaseUrl` is always `null` (§17.2), so a refusal that only
echoed it would leave the person with nothing to click. The `manual.releaseUrl` of
these two refusals is therefore, in order: the check's own `releaseUrl` when it has
one, else `https://github.com/{owner}/{repo}/releases/tag/{tag}`, else the
package's npm page (`https://www.npmjs.com/package/dsh-prompt-setting`). The first
two are exactly what a GitHub-branch refusal has always sent, so no client copy
changes and g-043's labelling work is unaffected.

The `.tgz` requirement is not decoration in either branch: DSH refuses a URL that
is neither a git host nor a tarball, and pnpm needs the extension to treat it as
one. In the GitHub branch `<tag>` is used verbatim (it is a path segment, and
`v0.1.2` and `0.1.2` are different asset paths) and every segment is
`encodeURIComponent`-ed before the result is parsed as a `URL`, so no request
input can escape its segment. In the npm branch the URL is upstream's own string:
it is validated and then passed through unchanged, and the profile's literal
"already installed" comparison (§18.2, below) works on that same string.

**Why a tarball.** This repository's package carries a `prepare` script, and
pnpm's build-script approval gate is enforced on the **git** fetch path
(`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`, measured on pnpm 12.3.4). The tarball
path does not execute `prepare` on the consumer side, so this route needs no
build approval at all. Two long-term constraints follow, and both are release
process:

- **every release must upload its `npm pack` asset**, named exactly
  `dsh-prompt-setting-<version>.tgz`. Until it does, the button answers the
  named `asset-missing` failure for that release — which is the *expected*
  outcome for any release published before this feature existed, and is why that
  branch must never be silent;
- **this package must not add `postinstall`/`install` scripts.** A tarball
  carrying one is stopped by `ERR_PNPM_IGNORED_BUILDS` (measured). `prepare` may
  stay as it is: the tarball path does not run it.

**The one shortcut that is not an install.** Before the manager is called, the
spec this install would use is compared **literally** with the profile's own
`dependencies['dsh-prompt-setting']` (the same read A1 uses). If they are
identical, the answer is a **finished success**:

```json
{ "ok": true, "reused": false, "alreadyInstalled": true, "launchKind": "cli", "status": { "phase": "done", "status": "done", "application": "restart-required", "restartRequired": true, "installed": true, "error": null, "…": "…" } }
```

Nothing was installed and nothing needs to be, so the page's remaining step is the
manual restart it was going to ask for anyway. This is not politeness: `pnpm add`
on an unchanged dependency reports no new dependency, and the official manager
then throws `ambiguous-install` (`dsh-plugin-manager/lib/index.js:1782`,
`installed.length !== 1`). Letting that happen turned a user's second click into
「安装失败」 on a real desktop profile and spent a pnpm round trip to learn
something this plugin reads from one file. A **different** spec — an older tarball
URL, an npm version, a registry range, a `link:` — still installs normally.

Otherwise, the answer:

```json
{
  "ok": true,
  "reused": false,
  "launchKind": "cli",
  "status": {
    "requestId": "i1-7f3k2a9c",
    "phase": "installing",
    "status": "running",
    "known": true,
    "application": null,
    "version": "0.2.0",
    "tag": "v0.2.0",
    "startedAt": "2026-10-04T09:00:00.000Z",
    "finishedAt": null,
    "cancelRequested": false,
    "cancellable": true,
    "restartRequired": false,
    "installed": false,
    "error": null
  }
}
```

A refusal — nothing was started, so there is no request to track:

```json
{
  "ok": false,
  "code": "development-link",
  "message": "this profile installs dsh-prompt-setting from a local path (link:../x), which is a development working copy: …",
  "launchKind": "cli",
  "manual": {
    "releaseUrl": "https://github.com/zangxx66/dsh-prompt-setting/releases/tag/0.2.0",
    "releaseLink": "open the 0.2.0 release page",
    "command": "dsh plugin add <tarball-or-path>",
    "current": "link:../x"
  }
}
```

Every `update-apply` answer — the started install, the no-op success and the
refusal alike — carries **`launchKind`** (g-036, §18.8): the same enum the ping
reports, read from the Host context while the response is assembled. It is
additive, so a client that ignores it renders exactly as before, and it is a fact
about the Host: no request body or query can set it.

| Refusal code | Meaning |
| --- | --- |
| `installer-unavailable` | No `pluginManager` service in this profile, the profile directory could not be resolved, or the profile's `package.json` could not be read/parsed (so the install form cannot be checked). Nothing was installed, and nothing was written. |
| `development-link` | The profile holds this package as `link:`/`file:`/a path (§18.1, A1). |
| `no-update` | The last check confirmed no newer version, or could not decide. |
| `invalid-request` | The body's `tag` disagrees with the check's tag, or a `requestId` is missing/empty/absurdly long. |
| `asset-missing` | The artifact the check named is not there: the release asset (`404`/`410` from the probe, or pnpm's `ERR_PNPM_FETCH_404`/`E404`), **or** an npm document that names no `dist.tarball` at all (Revision 27). |
| `asset-unverified` | The artifact could not be confirmed: the asset probe answered `401`/`403`, **or** — Revision 27 — the npm document's `dist.tarball` is not an `http(s)` `.tgz` URL. Nothing was installed either way. |

The two artifact codes keep their meanings and their sentences; Revision 27 only
widens *which upstream artifact* they can be about, and the sentence names that
upstream (a registry tarball reads "the npm registry's tarball for vX.Y.Z …"
instead of "the release has no … asset").

**Why the route answers before the install settles.** One install can block for
the profile lock (measured worst case ~2 minutes) plus pnpm's silence timeout
(10 minutes). A settings page cannot hold a request open for that, so the route
returns a `requestId` as soon as the install is *started*, and the page polls
§18.3. The player is the **Host's own** request table (§18.5) because the
official manager deletes a settled request.

**What is checked before anything is started**, in order: the update check's
answer (cached, so zero outbound requests), the install spec's own admissibility
(Revision 27: the npm `dist.tarball` gate above), the tag guard, whether an
install is already running, the plugin manager's presence, the profile directory,
the profile manifest (readable? which install form?), and one `HEAD` against that
spec.

Two of those checks **fail closed**, because "I could not find out" is not
evidence that installing is safe:

- a profile manifest that exists but cannot be read or parsed refuses with
  `installer-unavailable` — it is **not** treated as "this profile does not
  declare the package" (which would skip the A1 check on a profile that was never
  inspected). A manifest that is simply **absent** is different: that is a real,
  readable answer, and the install proceeds (it is what restoring a real install
  means);
- the `HEAD` is a **shortcut, never a gate**. Only two answers refuse:
  **`404`/`410` ⇒ `asset-missing`** (the artifact is not there — the state of
  every release published before this feature existed) and **`401`/`403` ⇒
  `asset-unverified`** (it cannot be fetched anonymously). **Every other answer —
  `500`, `429`, `405`, a redirect that never resolved, a throw, no `fetch` at
  all — means "I could not find out" and must not block an install**: the install
  runs and pnpm's own verdict is the answer. The probe exists to turn the
  *expected* case into a named answer in seconds, not to become a refusal the
  person cannot act on.

The probe reuses the same injected transport as the update check, so a profile
(or a test) that stubs one cannot accidentally reach the network through the
other.

### 18.3 `GET /prompt-setting/update-apply`

Query: `requestId` (optional).

- with a `requestId` this mount knows: the tracked request's phase, its
  application verdict and its structured error (the shape in §18.2);
- with a `requestId` it does not know (or one evicted from the table): `200`
  with `{ "ok": true, "status": { …, "known": false, "status": "unknown", … } }`.
  The official manager deletes a settled request, so "this page no longer knows"
  is a real answer, and it is deliberately not a `404`: nothing about the server
  went wrong, and the client has one branch to render;
- **with no `requestId` at all**: `200` with
  `{ "ok": true, "status": <the oldest running install> | null }`. This is the
  fresh-page question — a browser reloaded mid-install has no id in memory — and
  it can only ever name an install **this mount** started.

Only an empty or absurdly long id is a `400 invalid-request`; the bare `GET` is a
question, not a shape mistake.

Every one of those answers carries `launchKind` beside `ok`/`status` (g-036,
§18.8) — including the `status: null` one, so a client never has to branch on the
field being present.

The `status` values the page branches on are `running`, `done`, `failed` and
`cancelled`, plus `unknown`. `phase` is the finer host-side step
(`installing`/`cancelling`/`done`/`failed`/`cancelled`) and is reported only
through the `data-update-apply-phase` marker (§18.7); the page branches on
`status`, so the two names cannot silently swap roles. Every field is present on
every answer, including the unknown-request one.

### 18.4 `POST /prompt-setting/update-apply/cancel`

Body: `{"requestId": string}`.

The host records the cancel intent in its table — that is what the page's next
poll reads — and forwards it to the manager's `cancelInstall` **without
awaiting** it: the official call resolves only after the install has settled and
its files are restored, which can be minutes, and a cancel button may not hang
for that.

- a live request: `200` `{ "ok": true, "code": "cancelling", "launchKind": "cli", "status": {…} }`;
- a settled, unknown or absent request: `200`
  `{ "ok": false, "code": "not-running", "launchKind": "cli", "status": {…} }`.
  Nothing was stopped;
  that is a fact about the request, not a server error.

A cancel that **races a success** is not reported as a cancellation: if the
install reached the apply step, the settled row says `done` and the page shows
the installed version. Claiming otherwise would be a lie the next poll would
contradict. — The `already-installed` row (§18.2) is settled the moment it is
created, so cancelling it is `not-running` for the same reason: there is nothing
running to stop, and the outcome it already reported stands.

### 18.5 The host's request table

The official manager keeps `requestId → control` only while the install is live
and deletes it when it settles (`installBundle`'s own `finally`), so the state a
page polls must be the Host's. `core/install.js` owns that table as pure policy
(no IO, no clock of its own beyond an injected one):

- bounded at `INSTALL_REQUEST_LIMIT` (20) entries, with the settled entries
  beyond `INSTALL_SETTLED_RETENTION` (10) newest evicted oldest-first;
- a **live** entry is never evicted, even when that leaves the table above its
  cap: the page must be able to keep polling something that is still changing the
  profile;
- an evicted entry answers `status: "unknown"`, which is distinguishable from an
  id that was never issued (`known: false` in both cases, `status: "unknown"` in
  both — the two are the same sentence on purpose: "this page cannot look that
  up any more");
- one retained diagnostic per request, clamped by `INSTALL_MESSAGE_MAX` (240
  chars, one line): pnpm output is a log, not a payload.

### 18.6 Failure classification

`classifyInstallFailure` names every failure, and each name has a sentence and a
manual route. It reads **both** places the official manager reports a reason, in
this order:

1. the probe's own answer, when it is the thing being classified
   (`404`/`410` ⇒ `asset-missing`, `401`/`403` ⇒ `asset-unverified`);
2. **`changeResult.error.code`** — the official `ManagementError.code`. This is
   the most specific fact available (the manager named the case itself), so it
   decides before any text matching, which also keeps a `stale-approval` whose
   diagnostic mentions `prepare` from being read as `build-blocked`;
3. **`changeResult.packageResult.kind`** — pnpm's `PluginInstallFailureKind`;
4. the diagnostic text (an `ERR_PNPM_*` code, an errno);
5. only then `unknown`.

`operation-error` is a **wrapper**, not a reason: the manager puts a
non-`ManagementFailure` (in practice pnpm's output) there, so it is deliberately
never returned as a code — steps 3–4 decide. Every other code is returned
verbatim, and every one has its own sentence:

| Code | When |
| --- | --- |
| `asset-missing` | A `404`/`410` (from the probe or from pnpm's `ERR_PNPM_FETCH_404`/`E404`), or an npm document that names no `dist.tarball` (Revision 27). **The expected outcome for a release with no asset** — e.g. a release published before this feature. |
| `build-blocked` | pnpm's build-script gate: `ERR_PNPM_IGNORED_BUILDS`, "Ignored build scripts". |
| `network` | `ENOTFOUND`/`ECONNRESET`/`ETIMEDOUT`/`ECONNREFUSED`/`EAI_AGAIN`/`ERR_PNPM_META_FETCH_FAIL`/… or a probe that could not answer. |
| `pnpm-missing` | The manager reported `pnpm-missing` (`ENOENT` running pnpm). |
| `asset-unverified` | A `401`/`403` from the probe. |
| `ambiguous-install` | `pnpm add` changed no dependency, so the manager found no new dependency to report: the thing being installed is already what the profile holds. Answered as a **success** before the manager is ever called (§18.2); this code remains for the case where a *different* spec still produces no change. |
| `stale-approval` | pnpm asked for a build-script approval that is no longer valid. |
| `incompatible-version` | The new version's peer range rejects this DSH version. |
| `not-bundle` | The package declares no `dsh.bundle`. |
| `not-removable`, `stop-profile`, `bundle-in-use` | The bundle cannot be removed / the profile must be stopped / the bundle is in use. |
| `management-required` | The plugin is supplied by the DSH installation itself. |
| `unaddressable`, `unknown-plugin` | The manager could not address or find this profile's entry. |
| `invalid-spec` | The manager refused the install spec (this button cannot produce one). |
| `operation-error` | Only when pnpm's `kind` and log said nothing either. |
| `timeout`, `not-found`, `no-matching-version`, `integrity`, `permission`, `disk-full`, `unknown` | The remaining categories, each keeping its own name and sentence. |

**About rollbacks.** A sentence may say the profile's files were restored **only**
for a failure where the official manager really did run its restore
(`timeout`, and the pnpm-run failures). The management-code sentences — including
`ambiguous-install`, which changed nothing at all — do **not** claim a rollback:
"nothing changed" and "everything was put back" are different facts.

**`unknown` says what it is.** Its sentence is "the install failed and the host
reported no reason for it; update by hand" — it is reachable only when **neither**
source named a reason, and it never claims a cause or a rollback.

Nothing retries automatically. A failure is a state with a manual link, and a
**retry button only when the classified failure is `retryable`** (the host says
so per code); the only automatic action anywhere in this feature is the page's own
poll of a running install, which is bounded by
`UPDATE_APPLY_POLL_BUDGET_MS` (16 min, the host's own worst case plus margin).

### 18.7 Client surface (g-032)

| Marker | Where | Meaning |
| --- | --- | --- |
| `data-region="update-notice"` `data-update-available="true"` | the banner (g-030) | A confirmed newer release is known. |
| `data-update-latest` | the banner | The version the button would install. |
| `data-update-apply` | the banner | `idle` before anything is started, otherwise the **`status`** the page branches on: `running`/`done`/`failed`/`cancelled`/`unknown`. (A payload that carried no `status` falls back to its `phase`; the host always sends one, so the two enumerations agree in practice — the guard test asserts it.) |
| `data-update-apply-status` | the status row | The same **`status`**: `running`/`done`/`failed`/`cancelled`/`unknown`. The row itself only exists once there is an install, so `idle` — which only the banner can be — never appears here. |
| `data-update-apply-phase` | the status row | The host's finer `phase`: `installing`/`cancelling`/`done`/`failed`/`cancelled`/`unknown` — never the branch value. |
| `data-action="update-apply"` | the banner **and** 「高级」 | Opens the second confirmation. Absent once the announced version **is** the installed one; disabled while an install runs. |
| `data-action="update-apply-cancel"` | the status row | Cancels a running install. |
| `data-action="update-apply-retry"` | the status row | Re-opens the confirmation after a failure. |
| `data-region="update-apply-status"` | the banner and 「高级」 | The install's own line(s). |
| `data-update-apply-manual` | the status row | A link to the release page, for a failure with a manual route. |
| `data-confirm-kind="update-apply"` | the confirm modal | The second confirmation, which states the version, that the restart is the user's to do, and **how** to do it for this launch shape (g-036, §18.8). |
| `data-launch-kind` | the root container | `cli`/`desktop`/`unknown` (g-036, §18.8): the shape every restart sentence on the page was selected for. On the root so a real-machine check reads one attribute instead of matching sentences. |

`status` and `phase` are two names for two different facts and are never
interchanged: the page **branches on `status`**, `phase` is reported only through
`data-update-apply-phase`. `status` is also what `data-update-apply` carries, so
the banner's marker and the status row can never disagree about what is
happening. The three enumerations above are the **complete** set a rendered page
can carry, and `test/client.test.mjs` asserts exactly that (including that `idle`
appears only on the banner): a marker value the contract does not list cannot be
produced without turning that test red.

- The install state is rendered in **both** the banner and 「高级」: neither
  dismissing the banner nor turning the update-check switch off may take away the
  only place a running install can be cancelled or a failed one retried. The
  switch only gates the button that **starts** an install, so an install that was
  started while the switch was on stays controllable after it is turned off;
- 「立即更新」 is hidden once the announced version **is** the installed one (that
  is what `restart-required` means) and returns when a later release is
  announced: a button that reinstalls what is already installed is the「我是不是
  点了两次」confusion this banner must not create;
- while an install is live the banner shows the install, **not**「有新版本」: two
  competing statements about one version is what makes a user press the button
  twice;
- the page remembers the `requestId` in `sessionStorage` (per tab, 30 min) and
  falls back to the bare `GET` (§18.3) if that is gone. The mirror is an
  optimisation: the install state itself always comes from the Host.

### 18.8 The restart copy is partitioned by launch shape (g-036)

The install ends at a restart, and until g-036 the page said so with one
hardcoded sentence —「请手动重启 dsh web 生效」— which only a user who started the
Host from a terminal can carry out. The official desktop application
(`/Applications/DeepSeek Harness.app`, Electron) never shows that terminal: those
users quit and reopen the app, and the old sentence named an action they do not
have.

**Where the shape comes from.** The Host judges it from the official
`profileContext` service's `name` (`core/launch-kind.js`: a pure function, no IO,
no DSH import, exhaustively enumerated by `test/launch-kind.test.mjs`):

| `profileContext.name` | `launchKind` |
| --- | --- |
| `"desktop"` | `"desktop"` |
| any other non-blank string (`"web"`, `"tui"`, …) | `"cli"` |
| missing, non-string, blank, an unreadable service, or a lookup that throws | `"unknown"` |

- the lookup is the **optional** `ctx.get('profileContext')`, never an entry in
  this plugin's `inject`: a profile without the service still serves every route,
  and the fact degrades to `"unknown"` instead of failing the mount;
- the official web-app patches read the same field
  (`ctx.get('profileContext')?.name !== 'desktop'`), and `dsh`'s CLI refuses the
  `desktop` profile outright — so a command-line Host cannot claim to be the
  desktop one, and the judgement has no false positive in the direction that
  matters;
- the environment markers the desktop app also happens to set
  (`ELECTRON_RUN_AS_NODE`, `DSH_CLIENT_VERSION`) are deliberately **not** used:
  the first is true of any Electron Node Host, and the second is a variable the
  user can set. `"unknown"` stays honest instead of being guessed;
- `"unknown"` is **never** folded into `"cli"`. A desktop user shown the
  command-line copy is the defect this section removes.

**Where it is reported.** The ping (§14.2) and all three `update-apply` answers
(§18.2–§18.4) carry `launchKind`, always one of the three strings. It is read while
a response is assembled, so no request input can influence it, and it is additive:
a pre-g-036 Host simply omits the field.

**What the page does with it.** Four copy families — `updateApplyRestartNote`,
`updateApplyDone`, `updateApplyAlready`, `updateApplyUnknown` — exist in three
spellings in both dictionaries: the bare key (the shape-neutral fallback), `…Cli`
and `…Desktop`. The page selects by `launchKind`, and a missing or unrecognized
value selects the bare key:

| `launchKind` | Copy | Marker |
| --- | --- | --- |
| `"cli"` | names re-running `dsh web` | `data-launch-kind="cli"` |
| `"desktop"` | says to quit and reopen DeepSeek Harness, and **must not contain `dsh web`** | `data-launch-kind="desktop"` |
| `"unknown"` (or the field absent) | names no launch form, so both readers can act | `data-launch-kind="unknown"` |

The desktop copy deliberately promises no in-app restart button: the shipped
application has none (and on macOS closing the window does not quit it), so the
instruction is to quit the app completely and reopen it.

**Backward compatibility.** An old Host answers without `launchKind`, which the
page reads as `"unknown"` and renders with the shape-neutral copy: the same render
points, the same non-empty sentences, no new error and no blank. What changes for
such a Host is only that the fallback no longer asserts a command line —
deliberate, because a desktop user behind an old Host is exactly the reader it
must not mislead.

## 19. `POST /prompt-setting/rollback` (Revision 21; narrowed to the reserved section in Revision 22, g-039)

Move the **reserved section** back to a version the layer's own log already
describes, and log that move as a new version.

### 19.1 Why one section, and not the layer

Since Revision 7 the write face *is* the reserved section (§4.1, §15.7):
`PUT /prompt-setting/overrides`, the single-name `DELETE` and
`POST /prompt-setting/import` all refuse any other name, and the write lock is
pinned by SHA-256 in `test/route.test.mjs` and `test/stage2.test.mjs`. A
whole-layer rollback would be a **fourth write path** around that policy: it
would put a non-reserved override back into the assembly — one the user has no
page control to create or remove — and change the next turn's prompt through a
route the policy says does not exist.

Revision 21 shipped that shape. Revision 22 replaced it with this one, and the
restriction is therefore not a presentation choice but the write face applied to
a new route. What a rollback may touch is the reserved section, full stop.

### 19.2 Request

`{ "layer": "user" | "workspace", "seq": positive integer, "session"?: string,
"workspace"?: string }`. `seq` is a record's stable history id (`GET /history`'s
`id` / `seq`). Scope is read exactly as §8 and §9 read it: `session` filters,
`workspace` only **locates** the file, and `session` wins when both are given —
the same `readScopeOf` rule, so the file that is written is the file that was
listed. Either value may also be supplied in the query string; the body wins.
Because a rollback writes, the layer must be **resolvable** (`workspace` needs a
session id, §4.2).

### 19.3 What is written

The layer's **current** override list with exactly one entry adjusted:

- the target version's `snapshot` **holds** the reserved section ⇒ that entry is
  set to the text that version held;
- the target version's `snapshot` **does not hold** it ⇒ the entry is **removed**
  from the layer (back to "not configured");
- **every other entry is carried through untouched, in place** — including a
  non-reserved entry a hand-edited or pre-Revision-7 file still carries. A
  rollback never adds, removes, reorders or edits one, whether or not the target
  version named it. `test/stage2.test.mjs` cuts those entries out of the
  formatted config file by name and compares their bytes before and after the
  write.

### 19.4 Where the text comes from

A `snapshot` entry is `{name, action, hash, bytes}` and carries **no text**
(§8), so it says which section a version held — that is the *only* thing it is
used for here. The text comes from the record chain: every record carries the
text of the one section it touched (`before` / `after`), so the records that
mention the reserved section are walked **backwards** from the newest one and
each write is undone, which lands that one entry exactly where the target record
left it. A whole-layer `reset-layer` record is undone from its `entries`
(which is where the reserved section's text is when a clear removed it); a
`legacy-clear` record cannot have moved the reserved section at all and is
skipped; records for any other section are skipped, because they cannot have
moved this one.

If the target version claims the section held text the chain cannot supply, the
request is **refused** (`history-rollback-unavailable`) rather than written
approximately. A target whose section was hidden needs no text at all.

Two limits are worth stating:

- a record whose `snapshot` is **absent or empty** is refused
  (`history-snapshot-missing`). Old records predate the field, and a whole-layer
  clear legitimately snapshots `[]`; neither says what structure the version had,
  and "back to an empty layer" is what `DELETE …?reset=true` (§12.1) already
  does, with a record that says so;
- `append`'s `order` (a target index, §5.1) is not part of a snapshot and is not
  part of any record: it survives only for a section still in the current config,
  and is otherwise dropped. Rebuilding a position out of nothing would be a guess
  about a value no version ever recorded.

### 19.5 Order is the contract

Resolve the layer → read the layer's current config (`writableConfig`; an
unusable file is `409 layer-not-writable`) → read its log → rebuild that one
entry → validate the rebuilt config → **only then** write, and finally append the
record. Every refusal happens before the first write, so a rejected rollback
leaves the layer's file byte-identical. `test/stage2.test.mjs` checks that with a
SHA-256 of the file around every failure, not merely with a status code.

### 19.6 Response

```json
{
  "ok": true,
  "rolledBack": true,
  "layer": "user",
  "session": null,
  "seq": 7,
  "section": "prompt-setting:custom-prompt",
  "restored": true,
  "skipped": 2,
  "count": 3,
  "overrides": [{ "name": "…", "action": "replace", "text": "…" }],
  "effectiveFrom": "next-turn",
  "history": { "ok": true, "id": "12", "seq": 12, "dropped": 0, "rewritten": false }
}
```

- `section` is the one section the write adjusted;
- `restored` says whether the target version held it at all (`false` = the
  entry was removed);
- `skipped` counts the **other** sections the target version overrode, which are
  deliberately not restored — this is the number a client puts in front of the
  user before the write (see §13.3), and it is the response's own statement of
  the policy rather than something a client has to re-derive;
- `count` and `overrides` are the layer **after** the write, so a caller can
  render the new state without a second read;
- `history` is the §8.4 shape: a history failure is reported and never undoes or
  blocks the config write that already happened;
- `effectiveFrom: "next-turn"` is the same promise every write makes (§5.4): the
  next assembly sees the new value, because the config cache is updated with the
  file.

### 19.7 What is recorded

A `rollback` record (§12.3) that is an ordinary **section record**: `name` = the
reserved section, `before` / `after` = its text on either side of the write,
`entries: null`, `snapshot` = the layer it produced, `note` = `"rollback to
#<seq>"`, `origin: "ui"`. Nothing about it is layer-wide, so the replay above
undoes it through exactly the same branch as any other section write — which is
what keeps a rollback reversible: it can be diffed, previewed and rolled back
again.

### 19.8 Errors

All are `OverrideError` shapes (`{ok: false, code, message}`, §4.4):

| Code | Status | When |
| --- | --- | --- |
| `unknown-layer` | 400 | `layer` is neither `user` nor `workspace`. |
| `invalid-seq` | 400 | `seq` is missing, not an integer, or `< 1`. |
| `workspace-unresolved` | 400 | `layer: "workspace"` with no session id that resolves a root. |
| `history-not-found` | 404 | No record with that `seq` exists in the layer's log. |
| `layer-not-writable` | 409 | The layer's own file exists but is not a valid config. |
| `history-snapshot-missing` | 409 | The record carries no (or an empty) whole-layer snapshot. |
| `invalid-history-snapshot` | 409 | The snapshot is not an array of unique `{name, action}`, with `action` one of §4.1's. |
| `history-replay-unavailable` | 409 | A record the replay needs cannot be undone (a `reset-layer` record with no `entries`). |
| `history-rollback-unavailable` | 409 | The target version requires text of the reserved section that the chain cannot supply. |

### 19.9 Why this is safe by construction

Every check runs on data read *before* the write, and the only write is a single
`writeConfig` of a config `validateConfig` has already accepted. There is no path
that writes a partially rebuilt layer, no path that invents text, and no path
that adds, removes or edits a non-reserved entry — a version is either exactly
what the log records for the one section this route owns, or the request is
refused.

**Revision 22 is a narrowing, not a new feature.** A Host running Revision 21's
implementation is the one this replaces; the response gains `section`,
`restored` and `skipped`, and the `rollback` record changes shape from
layer-wide to section-level. A log written by Revision 21 (a `rollback` record
with `name: null`) no longer validates and is counted as a corrupt line by §8's
tolerant reader, which is the documented behaviour for a record this contract
does not describe.

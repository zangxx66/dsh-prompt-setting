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
  is the **outermost** listener for that event. Its single job: after `await
  next()`, if the reserved section exists, carries non-empty text and is not the
  last entry, move it to the end; otherwise return the downstream value **by
  reference** (§15.10);
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
- the block also carries `data-mine-frozen-certainty`: `"certain"` when the
  verdict has direct proof (a certain frozen snapshot, or the reserved section
  reported `applied: false`), `"unknown"` for the `frozenScope: "global"` +
  session case §2.4/§7.2 forbids presenting as frozen. Those two cases render
  their own copy (`mineFrozenWarn`/`mineFrozenBody` vs
  `mineFrozenUnknownWarn`/`mineFrozenUnknownBody`); the shared
  `mineFrozenHowTo` is the actionable half in both;
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
gate §15.3 installed becomes a switch the user can open, and opening it is only
safe because the write face can now answer the renderer's own question. Every
Revision 1–10 field, route, status code and byte keeps its exact meaning; the
switch is **absent by default**, so an install that never opens it behaves
byte-for-byte as it did before.

- `interpolateCustom` is a **config-level** field of either layer (§16.1). Absent
  means OFF; the workspace layer wins over the user layer on *statedness* — a
  workspace layer that states nothing inherits the user layer, one that states
  `false` does not;
- `GET`/`PUT /prompt-setting/interpolate` read and write it (§16.4), and
  `GET /snapshot` reports it under `layers.interpolate` (§2.3a);
- with the switch ON, `PUT /overrides` and `POST /import` refuse text the shipped
  renderer would throw on, with `400 unresolvable-variable` and **zero bytes
  written** (§16.4). The judgement is a pure transcription of the shipped
  `interpolate()`: malformed group, illegal name, unregistered name
  (`dsh-system-prompt/lib/index.js:157-176`);
- opening the switch validates the text **already stored** in both layers, and a
  layer that is already armed with a bomb on disk is **degraded with a reason**
  on the load path (§16.5), exactly like `missing-file`;
- the switch flips the **live section definition object** the service was handed,
  so it takes effect on the next turn with no re-registration and no restart
  (§16.2).

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
  layer's switch armed it. The verdict is now `layerTextIsArmed` (§16.4): text is
  validated whenever some assembly that renders it interpolates. The audit's
  two-step bypass, its reverse direction (a write into the user layer while a
  workspace is armed) and its `import`/`dryRun` twin are all refusals now;
- **F3 — the assembly decides on its own context.** The process-wide flag the
  request path used to write is gone from the assembly path: the decision is
  taken per dispatch, from the config that dispatch resolved, and applied to the
  `sections` that dispatch renders (§16.2). A session-less request (the ping is
  one) can no longer move any session's behaviour;
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

---

## 1. Routes and methods

| Path | Methods | Purpose |
| --- | --- | --- |
| `/prompt-setting/ping` | `GET` | Stage 1A liveness probe. Behaviour unchanged, plus `clientBuild` since Revision 6 (§14.2). |
| `/prompt-setting/snapshot` | `GET` | Base + effective section views, frozen verdict, layering. |
| `/prompt-setting/overrides` | `GET` | Both layers and the merged list. |
| `/prompt-setting/overrides` | `PUT` | Upsert **the reserved section** into one layer; any other name is `403` (Revision 7, §4.1). |
| `/prompt-setting/overrides` | `DELETE` | Drop the **reserved** override; `?reset=true` clears the whole layer (§12); `?legacy=true` clears only its frozen overrides (§12.2). |
| `/prompt-setting/history` | `GET` | One layer's bounded change log, newest first (Revision 4, §8). |
| `/prompt-setting/diff` | `GET` | Section + line comparison of two versions of one layer (Revision 4, §9). |
| `/prompt-setting/export` | `GET` | One or both layers as a schema-versioned JSON document (Revision 4, §10). |
| `/prompt-setting/import` | `POST` | Apply such a document atomically, with a `dryRun` preview (Revision 4, §11). |
| `/prompt-setting/interpolate` | `GET` | The「我的 Prompt」variable-substitution switch, per layer and effective (Revision 11, §16.4). |
| `/prompt-setting/interpolate` | `PUT` | Set that switch for one layer: `{"enabled": bool}` (Revision 11) or `{"state": "inherit"|"on"|"off"}` (Revision 12, §16.8). |

- An unknown path under the prefix is `404` with
  `{ "code": "not-found", "message": "no route for <path>" }` (no `ok` key —
  this is the stage 1A shape, preserved on purpose).
- A known path with an unsupported method is `405` with an `allow` header
  listing the supported methods and an **empty** body. `/prompt-setting/ping`
  answers `allow: GET`; `/prompt-setting/overrides` answers
  `allow: GET, PUT, DELETE`; `history`, `diff` and `export` answer `allow: GET`;
  `import` answers `allow: POST`; `interpolate` answers `allow: GET, PUT`.
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

**Revision 11 amends exactly one clause of the paragraph above.** The word "no
user section ever has its `interpolate` turned on" now has one exception, and it
is the one section this plugin owns: `prompt-setting:custom-prompt` has its
`interpolate` switched at runtime **when, and only when, the user turns the
switch on** (§16). Nothing else is touched — `index.js` mutates one field of the
definition object it itself handed to `systemPrompt.section()`, never a private
service field, never another plugin's section, and never a value the user did not
ask for. With the switch OFF — the default, and the state of every install that
never opens it — the paragraph above holds verbatim: the reserved section is
registered `interpolate: false` and stays that way.

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
  order is not the whole story: a listener registered last with
  `{prepend: true}` is placed **first** and is therefore the outermost one (the
  platform itself registers this way). Revision 8's keeper is exactly such a
  listener — that is what lets it run after every other listener's post-`next()`
  step (§15.10).
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
    The settings page is the four tabs of §13, and its only write surface is
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

## 8. `GET /prompt-setting/history` (Revision 4)

Query: `layer` (**required** — a log lives beside one layer's config file, so
there is no meaningful default), `session` (required to resolve the `workspace`
layer, exactly as for a write), `name` (optional filter), `limit` (optional page
size), `before` (optional **exclusive** ISO upper bound on `at`).

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
  "path": "/home/u/.dsh/prompt-setting/history.jsonl",
  "enabled": true,
  "reason": null,
  "retentionLimit": 100,
  "pageLimit": 20,
  "total": 3,
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

Records are returned **newest first** (`seq` descending). `total` counts every
match before paging; `limit` is clamped to `[0, 500]` and `0` is a legal request
for the counts alone. An unusable `limit` falls back to `50` rather than failing
the read.

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

## 9. `GET /prompt-setting/diff` (Revision 4)

Query: `layer` (required), `session` (for `workspace`), `from` and `to` (each a
history id or the literal `current`), `name` (optional: which section to compare
line by line).

Exactly one of `from`/`to` may be omitted, and the omitted one means `current`.
Omitting **both** is `400 missing-diff-selector`: there is nothing to compare.

### 9.1 Response

```json
{
  "ok": true,
  "layer": "user",
  "session": null,
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
  "plugin": { "name": "dsh-prompt-setting", "version": "0.1.0" },
  "pluginVersion": "0.1.0",
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

### 12.3 The history action vocabulary (Revision 7)

`HISTORY_ACTIONS` is now `replace`, `hide`, `append`, `remove`, `reset-layer`,
`legacy-clear`. The first five are Revision 6's set, unchanged and in the same
order, so every existing history file still reads. `reset-layer` and
`legacy-clear` are the two *layer-wide* actions: their subject is the whole
layer, so they are the only records that carry `name: null` and the only ones
rejected when they name a section. `GET /history` and `GET /diff` report the new
action verbatim; a client with no label for it must render the raw value rather
than guess. The shipped client has had a label for every action in this list
since g-015 (`histAction.legacy-clear`), and §13.3 asserts the label reaches the
screen instead of the raw enum.

## 13. Client-side contract (Revision 4; re-ordered in Revision 7, g-015; collapsed scope in g-016)

### 13.0 The four first-level tabs

Since g-015 the settings page is four first-level tabs, in a fixed order, with
the first one open by default. Above them there are exactly three things: the
title, one line of deciding facts, and the session selector every tab shares —
the selector itself is **one line** until「更改」is clicked (§13.7), so the tab
bar and the tab panel are on the first screen.

| order | `data-tab-value` | tab | what it is |
| --- | --- | --- | --- |
| 1 (default) | `mine` | 「我的 Prompt」 | the **only** write surface |
| 2 | `overview` | 「提示词总览」 | strictly read-only |
| 3 | `history` | 「历史与备份」 | log, comparison, export/import |
| 4 | `advanced` | 「高级」 | legacy list, the two layer-wide clears, full status |

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
  other tab's top-level regions.

### 13.1 「我的 Prompt」 — the one write surface

- The panel is `data-region="mine"`, the layer control is
  `data-region="mine-layer"` (group `mine-layer`, values `user` / `workspace`),
  the text box is `data-role="mine-text"`, and the two controls are
  `data-action="mine-save"` and `data-action="mine-reset"`.
- The value shown is the reserved section's stored text **for the selected
  layer**, read from the `merged` list of `GET /overrides` — the list the
  assembly applies (§3). An absent entry means "unconfigured", and the panel
  says so in words; it never shows a blank box as if the layer held `""`.
- Saving is exactly `PUT /prompt-setting/overrides` with
  `section: { name: "prompt-setting:custom-prompt", action: "replace", text }`
  (§4.1) and, when a session is selected, `session`. The text is sent verbatim.
- 「恢复默认」 is the single-name `DELETE` (§12.1) for the reserved name and the
  selected layer, behind a second confirmation of kind `mine-reset`.
- `data-mine-state` is the machine-readable state: `unconfigured` | `dirty` |
  `saving` | `saved` | `error`. A failed write renders a full
  `data-mine-error="true"` banner (`data-error-code`, the mapped copy, the
  host's own `message`) — a failed save is never rendered as `saved`.
- A scope where the text cannot take effect renders
  `data-warning="mine-frozen"` with the reason: `frozenScope: "session"` with
  `frozen: true`, or the reserved entry arriving as `applied: false`
  (§15.4). The write is still allowed (the text is stored and takes effect when
  the freeze lifts); what is forbidden is letting it look effective.
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

### 13.3 「历史与备份」

- Unchanged in content: the history panel (`data-region="history"` plus its
  `data-history-*` markers), the comparison (`data-region="history-diff"`,
  `data-diff-*`) and the transfer panel (`data-region="transfer"` plus its
  `data-import-*` markers).
- The lazy rule now keys off this **tab**, not the old 覆盖 view: a page that
  never opens it issues exactly the three baseline requests (ping, snapshot,
  overrides), and the history request is `…&limit=20`.

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
  `data-status-build` on `data-region="status"`.

### 13.5 Second confirmation is required

Every destructive action renders a `data-region="confirm"` card first, carrying
`data-confirm-kind` (`mine-reset` | `legacy-clear` | `reset-layer` | `import`),
naming the affected layer or the change counts, stating that the action cannot
be undone, and offering `data-action="confirm-yes"` / `data-action="confirm-no"`.
No request is sent before `confirm-yes` — asserted for all four kinds.

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

`GET /prompt-setting/ping` answers the stage 1A shape plus one field. The body
below is a **shape example**: `hash`, `size` and `mtime` all move with the
bundle's bytes and the file's timestamp, so the numbers in it are placeholders —
not this machine's (and not any machine's) current values. Comparing them with a
live probe would read a normal rebuild as a defect.

```json
{
  "ok": true,
  "plugin": "dsh-prompt-setting",
  "version": "0.1.0",
  "time": "2026-09-28T12:00:00.000Z",
  "clientRenderer": "fallback",
  "clientReportedAt": "2026-09-28T12:00:00.000Z",
  "clientBuild": { "hash": "7065b7d2", "size": 240949, "mtime": "2026-09-28T11:58:31.000Z" }
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
- `clientBuild` is **`null`**, with the rest of the response unchanged and the
  status still `200`, when the bundle cannot be read, or when it is readable but
  its marker region is unusable (markers removed, duplicated or reversed). A
  fabricated digest here would be read as「过期」, so「unknown」is the answer.

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

**Revision 11 makes the flag a choice rather than a constant.** The default is
still `false` and the section is still registered with `false`; the user may turn
it on for their own layer, and the write face then refuses text this renderer
would throw on (§16). Nothing in this section changes while the switch is off.

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

**The listener.** Registered with `{prepend: true}`, which places it **first** in
the waterfall and therefore makes it the outermost listener for this event: its
post-`next()` step is the last one to touch the assembly, so it sees every section
any listener appended after `next()` returned. It is a second effect on the same
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

## 16. The「我的 Prompt」variable-substitution switch (Revisions 11–12, g-026)

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

### 16.2 Runtime switching: the decision belongs to the assembly, not to a process-wide field

The reserved section is registered with the definition object
`customSection()` returns and with `interpolate: false`, which is the fallback:
an assembly that this plugin never gets to judge renders the text literally.

The switch is applied **per assembly**, on the assembly's own context
(`applyAssemblyInterpolate`, `index.js`). The waterfall listener already resolves
the config this dispatch must apply — `mergeLayers(userLayer, workspaceLayerOf
(session))` for a real turn, the probe's own config for the snapshot — and
`mergeLayers` carries the statedness-merged flag on it. That single value is:

- what `GET /snapshot` reports as `layers.interpolate.effective`, and
- what the listener copies onto the reserved section of the `sections` array the
  renderer will read (`{...section, interpolate: true|false}`), returning the
  input array **by reference** when nothing has to change.

Three measured properties of the Host make this the only correct place, and none
of them is a private-field access:

1. `NamedEntries.insert(name, section)` stores the definition object **by
   reference** (dsh-scope `lib/index.js`), so the service is holding the object
   this plugin registered;
2. every `assemble()` copies `section.interpolate` from that object into the
   assembly it hands the waterfall **before any listener runs**
   (`dsh-system-prompt/lib/index.js`, the `sections.map(…)` at the top of
   `assemble`) — so mutating the definition inside a listener can never affect
   the assembly in flight, and mutating it from a *request* can only describe
   whichever session made the last request;
3. `renderPrompt` reads the field off the sections it is given, so the value the
   listener writes is the value the renderer uses.

**What Revision 11 did instead, and why it was wrong.** It pushed the effective
value of the last handled request onto the one definition object. One process has
one such object and many sessions, so the value was whichever request came last:
a session-less ping reset it to the user layer's value (disarming a workspace
session that states ON), and two sessions with different flags could not both be
right. `state.customDefinition.interpolate` is still maintained, but only as a
**mirror of the unscoped view** (the user layer alone) — the same value a route
without `?session=` reports — so a session-less request recomputes what is
already there. Nothing on the assembly path reads it.
`test/route.test.mjs` pins the consequence: a ping cannot change what a session
assembles, and interleaved sessions keep their reported `effective` and their
real render in step.

**Cross-version dependency, stated.** This rests on the waterfall listener
running for scoped assemblies too (it is the same listener that has applied
overrides since Revision 7) and on `renderPrompt` reading the field off the
sections. A Host that froze `interpolate` per section at registration time would
make the switch a no-op; the fallback would then be to dispose and re-register
the section (`test/integration.test.mjs` asserts this path against the installed
`@deepseek-ai/dsh-system-prompt`, so the change would be caught rather than
shipped).

### 16.3 What the validator answers, and the one place it is softer

`core/interpolate.js` transcribes the shipped `interpolate()` line by line, with
the Host's own `VARIABLE_NAME` and `GROUP_AT` expressions:

| Condition | Shipped behaviour | Write face |
| --- | --- | --- |
| a `{{` with no complete group **and a later `}}`** | throws `malformed prompt variable reference` | `400 unresolvable-variable` |
| inner text not matching `^[a-z][a-z0-9_]*$` | throws `malformed prompt variable reference "…"` | `400 unresolvable-variable` |
| name not registered in `assembly.variables` | throws `unknown prompt variable` | `400 unresolvable-variable` |
| registered name whose value is `undefined` | throws `prompt variable "…" has no value` | **warning, save proceeds** |
| registered name whose value is `null` | renders the string `null` | accepted, not reported |
| a `{{` with **no** later `}}` | literal prose | accepted, not reported |
| a substituted value | never re-scanned | never re-scanned |

The one softening is the fourth row, and it is deliberate. `undefined` is a
property of the **assembly that was probed**, not of the text: the shipped
renderer documents that a provider may return `undefined`, and a probe with no
active agent leaves agent-scoped providers valueless. Refusing the save would
therefore make the switch unusable whenever nothing is running, and the same text
would be perfectly safe in a live session. The strict verdict — the one that
matches the renderer exactly — is still implemented (`scanThrowingReference`) and
is what `test/interpolate.test.mjs` and `test/integration.test.mjs` pin against
the real `renderPrompt`.

**Revision 12 (audit F2): the warning is on the wire.** Until Revision 12 the
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
  path (fail closed) and as "cannot check names" on the load path (so one failed
  probe never disables a layer);
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
- the write is `writeConfig` + the in-memory cache, then the definition mirror is
  refreshed (§16.2). The answer is
  `{ "ok": true, "interpolateCustom": true, "layer": "user", "state": "on", "saved": { "enabled": true, "state": "on" }, "effectiveFrom": "next-turn" }`
  plus `warnings` when there is something to report;
- a refusal leaves **both layer files byte-identical**: the shape check, the
  target resolution, the stored-text check and the variable probe all run before
  the first `writeConfig`, and `test/route.test.mjs` hashes the files around
  every one of them.

**The F1 rule (Revision 12): what decides whether a text is validated.** Not "the
layer being written", which was the bypass, but whether the text can reach an
assembly that interpolates (`layerTextIsArmed`, `index.js`):

- the **user** text is merged into every session that carries no workspace entry
  of its own, so it is validated as soon as the user layer or **any** visible
  workspace layer states ON. (Slightly conservative on purpose: a workspace that
  states ON *and* carries its own text does not in fact use the user's, and the
  write is refused anyway — this is the audit's "write the user layer while a
  workspace is armed" case);
- a **workspace** text is rendered only for that workspace's sessions, where the
  merge decides: it is validated exactly when `effectiveInterpolate(user,
  workspace)` is ON. An explicitly closed workspace is therefore the one
  configuration whose literal braces provably reach no interpolating assembly,
  and it is not refused — which is what makes §16.8's explicit OFF worth having;
- the verdict is computed on the **post-write** view, so the change being
  requested is what is judged.

The audit text also suggests the blunt "if any layer is ON, validate every
visible layer". That variant is **not** used: it would refuse the writes that
make explicit OFF useful, and it would degrade an explicitly closed layer at load
time for text that cannot throw there. Every case the audit reproduced is refused
by the rule above — `test/route.test.mjs` freezes all of them (the two-step
bypass, the reverse direction, `import` with and without `dryRun`) and one
counter-case (a closed workspace keeps its literal braces):

| Route | What is validated | On failure |
| --- | --- | --- |
| `PUT /overrides` | the text about to be stored, when it is armed after the write | `400 unresolvable-variable`, zero bytes |
| `POST /import` | the document's reserved-section text, when it is armed after the write | `400 unresolvable-variable`, zero bytes, dry run included |
| `PUT /interpolate` | every stored text this change arms | `400 unresolvable-variable`, zero bytes |

Each of the three routes attaches `warnings` (§16.3) to a successful answer.

### 16.5 Historical text, and the load-time self-check

Opening the switch is what turns an old `{{typo}}` into a per-turn throw, so the
opening action validates what is **already stored** before it writes anything
(§16.4). The refusal is actionable: it names the references, the layer file, the
registered variable names, and the three ways out (delete the reference, use a
registered name, or keep the switch off).

A config can still reach disk armed — a hand edit, a config-sync tool, a file
written while the plugin was down. The load path therefore re-checks each layer
with the same validator, using the `missing-file` precedent exactly:

- a layer that states ON and carries text the renderer would throw on is
  **degraded with a reason**: `config: null`, `error: { code:
  "unresolvable-variable", message: … }`. The snapshot reports it as
  `layers.<name>.enabled: false` with that reason, and the layer contributes
  nothing to any assembly;
- it is **not** reported as an invalid **file** (the code is not
  `invalid-config`), and it is **not** silently accepted. The reason says the
  layer was disabled so the real assembly keeps working, and names the fix;
- a layer that states nothing, or states OFF, is untouched **unless**
  §16.4's rule says its text is armed — Revision 12 (audit F1) added that
  cross-layer pass (`enforceVisibleTextsSafe`), because the per-layer check reads
  only the layer's own flag and therefore misses the exact bypass the audit ran:
  a user layer that states ON arms an unstated workspace layer's bomb, and that
  workspace layer's own self-check sees "this layer states nothing, nothing to
  check". The pass runs after both layers are read, on the per-text rule, and
  again after any later re-read of a layer (a `?session=` view re-loads its
  workspace layer; without that second pass the read would resurrect what the
  refresh had just degraded);
- when this mount has no variable table (its first request, or a profile where
  the probe failed), only the grammar conditions are checked — a failed probe
  must never disable a layer. The next request, with a table in hand, checks the
  names too.

**F5, stated as the trade it is (Revision 12).** The degradation disables the
**whole layer**, not just the offending entry, so a layer whose「我的 Prompt」text
is a bomb loses its other overrides too. That is a deliberate choice and not an
oversight:

- it is the `missing-file` paradigm, which this contract has used since stage 1B:
  one unusable file = one layer that contributes nothing, reported with a reason;
- the alternative — dropping only the reserved entry in memory — would leave the
  user's file and the plugin's view of it out of step, and would still need a
  channel to say "part of your layer is not in the prompt", which is exactly the
  channel the reason already is;
- what Revision 12 added is that the reason is now **perceivable where it
  matters**: 「我的 Prompt」 renders the disabled layer, the host's own reason and
  the recovery path next to the text box (`data-warning="mine-layer-disabled"`),
  instead of leaving it to the status block in 「高级」. The plugin never rewrites
  the user's file; the fix is a hand edit of the named reference, and the next
  read picks it up.

`test/route.test.mjs` freezes the cross-layer pass (a hand-armed user layer
degrades the unstated workspace layer it arms, while a safe workspace layer is
untouched) and `test/client.test.mjs` freezes the panel half.

### 16.6 The preview agrees with the behaviour

`rendered`, `renderedResolved`, `unresolvedThrowing` and `unresolvedLiteral`
(§2.3) are computed from the same `section.interpolate` the real renderer will
read — the snapshot's own probe goes through the listener and therefore carries
the value that session's assembly will use (Revision 12, §16.2) — so opening the
switch re-grades the reserved section automatically:

- switch OFF (default): the reserved section is `interpolate: false`, so its
  unresolved references are graded `unresolvedLiteral` and `renderedResolved`
  stays `true` — the braces in the preview are the real prompt;
- switch ON: the same section now carries `interpolate: true`, so the same
  references are graded `unresolvedThrowing` and `renderedResolved` becomes
  `false` — the preview says the real assembly will fail, which is true.

Revision 11 also closes one gap in that grading: a malformed group (a `{{` with a
later `}}` that no group matches) is now reported as **throwing** rather than
called prose, with the same 16-character excerpt the Host's own message quotes.
It was the one condition where the preview could say "nothing will throw" while
the renderer threw. `test/interpolate.test.mjs` asserts the correction *and* the
old reading's miss, so the difference cannot regress silently.

### 16.7 Reversibility

- closing the switch removes the key from the config file, restoring the
  pre-switch bytes exactly (asserted with SHA-256 over the whole file);
- the live definition returns to `interpolate: false` on the same request, so the
  next turn is literal again;
- ON → OFF → ON is idempotent in both directions: a repeated ON rewrites the same
  bytes, and the definition write is a no-op when the value already matches;
- a hand-edited file is picked up by the next request (the layers are re-read at
  the top of every handled request, and the assembly decision is derived from
  that read), and by mount, so a restart is never required to observe the switch;
- the `state.customDefinition.interpolate` mirror still returns to `false` when
  the unscoped view is off, but it is not what makes the next turn literal: the
  per-assembly decision is (§16.2).

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

### 16.9 What Revisions 11–12 do not do

- They do not add an escape syntax. DSH has none, so with the switch ON a literal
  `{{...}}` cannot be written in「我的 Prompt」 — the panel says so next to the
  switch rather than letting the save fail mysteriously. The one exception is a
  layer that explicitly states OFF: its text is armed by no interpolating
  assembly, so its braces are storable (§16.4);
- they do not make the switch per-section or per-text. It is one field per
  layer, and it governs the one section this plugin owns;
- they do not check other plugins' sections, and they do not turn anybody else's
  interpolation on or off;
- they do not claim anything about a running `dsh web`: like every revision
  before them, the Host half needs the process to pick the new code up, and what
  is verified here is verified offline against the real
  `@deepseek-ai/dsh-system-prompt` in a real Cordis context.

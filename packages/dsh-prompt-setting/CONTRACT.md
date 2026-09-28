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

---

## 1. Routes and methods

| Path | Methods | Purpose |
| --- | --- | --- |
| `/prompt-setting/ping` | `GET` | Stage 1A liveness probe. Behaviour unchanged, plus `clientBuild` since Revision 6 (§14.2). |
| `/prompt-setting/snapshot` | `GET` | Base + effective section views, frozen verdict, layering. |
| `/prompt-setting/overrides` | `GET` | Both layers and the merged list. |
| `/prompt-setting/overrides` | `PUT` | Upsert one override into one layer. |
| `/prompt-setting/overrides` | `DELETE` | Drop one override from one layer; `?reset=true` clears the whole layer (§12). |
| `/prompt-setting/history` | `GET` | One layer's bounded change log, newest first (Revision 4, §8). |
| `/prompt-setting/diff` | `GET` | Section + line comparison of two versions of one layer (Revision 4, §9). |
| `/prompt-setting/export` | `GET` | One or both layers as a schema-versioned JSON document (Revision 4, §10). |
| `/prompt-setting/import` | `POST` | Apply such a document atomically, with a `dryRun` preview (Revision 4, §11). |

- An unknown path under the prefix is `404` with
  `{ "code": "not-found", "message": "no route for <path>" }` (no `ok` key —
  this is the stage 1A shape, preserved on purpose).
- A known path with an unsupported method is `405` with an `allow` header
  listing the supported methods and an **empty** body. `/prompt-setting/ping`
  answers `allow: GET`; `/prompt-setting/overrides` answers
  `allow: GET, PUT, DELETE`; `history`, `diff` and `export` answer `allow: GET`;
  `import` answers `allow: POST`.
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
    "workspace": { "enabled": false, "path": null, "reason": "no ?session= was supplied, so the workspace layer is inactive for this view" }
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

### 2.3 `rendered`, `renderedResolved`, `unresolvedVariables`

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

**A session-scope probe resolves agent-scoped variables; the global one cannot.**
Measured: a provider that returns a value only when `context.agent` is present
resolves under `?session=<active>` (the probe passes `{agent, scope: agent}`) and
returns `undefined` without a session. So:

- `frozenScope: "session"` ⇒ `renderedResolved` should be `true` for ordinary
  compositions;
- `frozenScope: "global"` ⇒ agent-scoped values are absent, `renderedResolved`
  may be `false`, and the UI should label the full-text view as partial rather
  than show placeholders as if they were the real prompt.

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

### 4.1 `PUT`

Body:

```json
{ "layer": "user" | "workspace", "session": "<id>", "section": { "name": "…", "action": "replace", "text": "…", "order": 0 } }
```

- `session` may be given in the body or as `?session=`; the body wins.
- `order` is only legal for `append` and is a **target index** in the resulting
  section array, clamped to `[0, length]`. Absent means "at the end".
- Upsert keyed by `name`, so saving the same name twice replaces rather than
  duplicates.

Response `200`:

```json
{ "ok": true, "saved": { "name": "…", "action": "replace", "text": "…", "layer": "user" }, "effectiveFrom": "next-turn" }
```

### 4.2 Target paths — the client never supplies one

| Layer | Path | Resolved from |
| --- | --- | --- |
| `user` | `$DSH_HOME/prompt-setting/overrides.json` | `process.env.DSH_HOME`, else `~/.dsh`. |
| `workspace` | `<workspaceRoot>/.dsh-prompt-setting/overrides.json` | `ctx.workspaceRegistry.list()` filtered by `sessionIds.includes(sessionId)`. |

`process.cwd()` is never used. A client-supplied path is not a parameter of any
route, so an attacker cannot redirect a write.

### 4.3 `DELETE`

Query: `layer` (required), `name` (required), `session` (required for the
`workspace` layer).

Response `200`: `{ "ok": true, "removed": true, "layer": "…", "name": "…", "effectiveFrom": "next-turn" }`.

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
| `404` | `override-not-found` | `DELETE` for a name that layer does not hold. |
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
  listener may `await next()` to transform the downstream result.
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
   `unresolvedVariables` are how the UI stays honest about it.
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

## 10. `GET /prompt-setting/export` (Revision 4)

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
                   "overrides": [ { "name": "project:alpha", "action": "replace", "text": "…" } ] },
    "workspace": { "layer": "workspace", "enabled": false,
                   "reason": "no ?session= was supplied, so the workspace layer is inactive for this view",
                   "overrides": [] }
  }
}
```

`ok` is this plugin's liveness flag; the rest of the body **is** the document and
is what a client should save. No absolute path is exported: the document is
portable. With `?layer=user` only that layer is present. An export taken without
a session therefore carries an empty, disabled `workspace` layer, and that same
document can be re-imported without a session (§11.3).

## 11. `POST /prompt-setting/import` (Revision 4)

Query: `dryRun` (exactly `true` to preview), `mode` (`merge` | `replace`),
`layer` (optional — import only that layer), `session`. Body: one export
document. Body cap: **4 MiB** (`413 body-too-large` beyond it).

### 11.1 The order is the contract

1. **parse** the body as JSON (`400 invalid-json`), and cap its size;
2. **validate** the document: schema, version, layers, and every override field
   through the same validator `PUT` uses (§4.4);
3. **resolve** every target — the layer, and the workspace root for
   `workspace` (`400 workspace-unresolved`) — and refuse to overwrite a config
   file that cannot be read (`409 layer-not-writable`);
4. **apply the conflict strategy** in memory and compute the plan;
5. on `dryRun`, **return the plan and stop** — nothing has been opened for
   writing;
6. **stage** each target: write a uniquely named temp file in the target's
   directory, then **read it back and validate it**;
7. **commit**: `rename` each staged temp file over its target (atomic per file).

A failure in steps 1–4 or 6 removes every temp file and throws. The real config
files were never opened for writing before step 7, so they are **byte-identical**
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

## 12. `DELETE /prompt-setting/overrides?reset=true` (Revision 4)

Clears one whole layer. `layer` is required, `session` as for a write. The value
must be exactly `true`: any other value (including `reset=1`) is **not** the
reset switch and falls through to the frozen single-name semantics, which then
requires `name` (§4.3).

```json
{
  "ok": true, "reset": true, "layer": "user",
  "removed": ["project:alpha", "project:beta"],
  "count": 2,
  "entries": [ { "name": "project:alpha", "action": "replace", "text": "…" },
               { "name": "project:beta", "action": "hide" } ],
  "effectiveFrom": "next-turn",
  "history": { "ok": true, "id": "5", "seq": 5, "dropped": 0, "rewritten": false }
}
```

- The layer's file is rewritten as an empty, valid config (`{"version":1,
  "overrides":[]}`), so a reset is observable on disk rather than implied.
- The removed content is written to history **first-class**: one record with
  `action: "reset-layer"`, `name: null` and `entries` holding every removed
  override with its full text. A reset is therefore reconstructible.
- Resetting an already-empty layer is a success with `count: 0`, `removed: []`,
  `history: null` and no log entry — there was no change to record.
- `effectiveFrom: "next-turn"` is literal (§5.4): the next assembly sees the
  cleared layer; a turn already assembling is unaffected.
- A section-level "restore default" is **not** a route of its own: it is the
  existing single-name `DELETE` applied to each layer that holds the name. The
  UI performs the second confirmation (§13.2) and the host keeps one
  single-layer write.

## 13. Client-side stage 2 contract (Revision 4)

### 13.1 What the panel renders

- The history panel is fetched **only** while the 覆盖 view is open: a page that
  never opens that tab issues exactly the three revision 3 requests. The panel
  carries `data-region="history"`, `data-history-layer`, `data-history-state`,
  `data-history-total`, `data-history-corrupt`, `data-history-unreadable`,
  `data-history-last-error`, and one `data-history-row="<id>"` per record with
  `data-history-action` / `data-history-name` / `data-history-origin` /
  `data-history-selected`. The live value is a row with
  `data-history-row="current"` and `data-history-current="true"`.
- The comparison carries `data-region="history-diff"`, `data-diff-state`,
  `data-diff-from`, `data-diff-to`, `data-diff-sections` (+ `-changed`/`-added`/
  `-removed`/`-same`), one `data-hd-row="<name>"` with `data-hd-status` per
  section, `data-diff-no-lines` when the host could not compare lines, and
  `data-diff-line-name` / `data-diff-mode` / `data-diff-line-added` /
  `data-diff-line-removed` / `data-diff-renderer` for the line comparison.
- `data-diff-renderer` is `"diffblock"` when the primitives module really
  exposes `DiffBlock` (probed, never assumed) and `"fallback"` otherwise. The
  fallback renders the **host's own ops** — the same comparison, a second
  renderer, not a second algorithm — with `data-region="diffblock"`,
  `data-diff-block="fallback"`, `data-diff-ops` / `data-diff-ops-shown`, and one
  `data-diff-op="equal|insert|delete"` row per line (capped at 400 rows, and it
  says so).
- The reset controls are `data-region="layer-reset"` with `data-reset-layer` /
  `data-reset-count` and a `data-action="reset-layer"` button; a section-level
  restore is a `data-action="reset-section"` button carrying
  `data-section-name` and `data-reset-layers` (the layers that will be cleared).
- The transfer panel is `data-region="transfer"` with `data-transfer-phase`,
  `data-import-mode`, `data-action="export"`, `data-role="export-text"`,
  `data-role="import-text"`, `data-role="import-file"`,
  `data-action="import-preview"`, `data-action="import-apply"`, and a
  `data-import-plan="true"` block carrying `data-import-added` / `-replaced` /
  `-unchanged-count` / `-removed` / `-kept` / `-changes` / `-applied` plus one
  `data-import-change="<name>"` row with `data-import-status` and
  `data-import-layer`. A failed import renders the standalone flag
  `data-import-unchanged="true"`
  together with the mapped error copy.

### 13.2 Second confirmation is required

Every destructive stage 2 action renders a `data-region="confirm"` card first,
carrying `data-confirm-kind` (`reset-section` \| `reset-layer` \| `import`),
naming the affected layers or the change counts, stating that the action cannot
be undone, and offering `data-action="confirm-yes"` / `data-action="confirm-no"`.
No request is sent before `confirm-yes`.

An import always previews first: `import-apply` is disabled until a `dryRun`
plan is on screen, and the click opens the confirmation card rather than writing.

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

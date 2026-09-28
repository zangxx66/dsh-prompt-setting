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

---

## 1. Routes and methods

| Path | Methods | Purpose |
| --- | --- | --- |
| `/prompt-setting/ping` | `GET` | Stage 1A liveness probe. Behaviour unchanged. |
| `/prompt-setting/snapshot` | `GET` | Base + effective section views, frozen verdict, layering. |
| `/prompt-setting/overrides` | `GET` | Both layers and the merged list. |
| `/prompt-setting/overrides` | `PUT` | Upsert one override into one layer. |
| `/prompt-setting/overrides` | `DELETE` | Drop one override from one layer. |

- An unknown path under the prefix is `404` with
  `{ "code": "not-found", "message": "no route for <path>" }` (no `ok` key —
  this is the stage 1A shape, preserved on purpose).
- A known path with an unsupported method is `405` with an `allow` header
  listing the supported methods and an **empty** body. `/prompt-setting/ping`
  answers `allow: GET`; `/prompt-setting/overrides` answers
  `allow: GET, PUT, DELETE`.
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
| `applied` | boolean | Whether the override for this name achieved what it asked for. `false` for a section with no override. |
| `overridable` | boolean | Whether this plugin can change the section at all. `false` for every section of a frozen scope, and `false` where a change was observed to be reverted. |
| `reason` | string \| null | Human-readable explanation whenever `applied` is `false` or `overridable` is `false`; `null` when there is nothing to explain. |
| `overrideLayer` | `"user"` \| `"workspace"` \| null | Which layer supplied the override, `null` when none did. |
| `action` | `"replace"` \| `"hide"` \| `"append"` \| null | The requested action, `null` when no override targets this name. |

### 2.3 `rendered`

`effective`'s rendered text: each section interpolated and dropped when empty,
the rest joined with a blank line. **Documented difference from the shipped
`renderPrompt`**: an unknown or malformed `{{reference}}` is left literal
instead of throwing, because the snapshot is a read-only view that must never
fail on provider text. Provenance text containing `{{…}}` therefore renders
literally here while a real turn would throw. See §4.4.

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

The verdict never claims more than it observed:

1. The snapshot runs a **frozen probe**: an `assemble()` **under the target
   scope** with the single synthetic append `__dsh-prompt-setting-probe__`. If
   that section is absent from the result — or the list changed size without it
   — the pipeline replaced the scope's `sections` after the waterfall. A
   `complete: true` section does exactly this, and it is the only mechanism
   observed to do so.
2. If the probe survived, the snapshot also compares the sections this plugin
   handed downstream with the sections that came back, and reports a discarded
   override.

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

The snapshot runs **two** `assemble()` calls (frozen probe + the session's real
config), both under the target scope. Both are discarded apart from their
section lists. This is an on-demand settings route, not a per-turn path.

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

### 5.5 No IO on the assembly path

Layers are read when the plugin mounts and refreshed at the start of every route
request. The waterfall listener only reads in-memory state. A workspace created
after mount is therefore picked up by the next route request; until then its
layer contributes nothing (it is not silently guessed).

### 5.6 Failure isolation

A layer that cannot be read or validated is reported as `enabled: false` with a
`reason` and contributes nothing. An error inside the override application fails
**open** (the assembly is returned unchanged) so a broken override can never
break a user's turn.

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

1. **`rendered` interpolates differently from a real turn** for unknown
   `{{references}}` (§2.3). Deliberate: the snapshot must not throw.
2. **A session with no active Agent gets a `frozenScope: "global"` verdict, not
   a session one** (§2.4). The response says so in `frozenScopeReason`; the UI
   must present that as unknown-for-this-session rather than as "not frozen".
   Probing a session whose Agent has not been created yet is not possible through
   this API.
3. **A workspace created after mount contributes nothing until a route request
   refreshes the cache** (§5.5).
4. **A scope whose registered sections change between the two probes** could
   make the frozen verdict reflect the first probe while `base`/`effective`
   reflect the second. Both probes are `assemble()` calls microseconds apart and
   no shipped package registers dynamic *sections*.
5. **`complete` is `"unknown"`** when neither probe can prove it. It is never
   guessed.
6. **The probed context is not byte-identical to a real turn's**: this plugin
   passes `{agent, scope: agent}` (no `signal`), so a section or variable
   provider that branches on `context.signal` would see a difference. No shipped
   provider reads it.

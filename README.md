![dsh-prompt-setting: System Prompt management for DSH](./assets/hero.jpg)

# dsh-prompt-setting

English | [中文](./README_zh.md)

**System Prompt management for DSH (DeepSeek Harness).** It adds a Prompt manager to the Web GUI's
Settings: you can **see** the system prompt a session actually assembles on every turn, search it,
write your own instructions into it, and roll back a bad edit — all **without touching the global DSH
install**.

![license](https://img.shields.io/badge/license-MIT-blue)
![version](https://img.shields.io/badge/version-0.1.5-blue)
![dsh](https://img.shields.io/badge/DSH-%3E%3D0.1.7--rc.2%20%3C0.2.2--0-blueviolet)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

- **Zero runtime dependencies, zero build step**: one package of plain JS — nothing to fetch, nothing to compile.
- **Upgrade-safe**: configuration is written only to the plugin's own data directory, so upgrading or
  reinstalling DSH neither loses nor overwrites it.

---

## 1. What problem this solves

Every DSH turn is injected with a base system prompt assembled by `@deepseek-ai/dsh-system-prompt`.
Until now the only way to adjust it was to **hand-edit files inside the global pnpm `node_modules`**.
The cost of that:

- the next DSH upgrade overwrites it and your changes are gone;
- it pollutes a global install, so nobody else — and no other machine — can reproduce it;
- there is no record of what changed, or of what it looked like before;
- and worst of all, **you cannot see what the finally assembled system prompt actually looks like**.

This plugin moves that into the Settings page: the assembly is laid out section by section, the part you
write is its own section pinned to the end, every other built-in section stays read-only, and changes
come with history, diffs and exportable backups.

## 2. What you get after installing

Settings gains a **"Prompt settings"** pane (`id: prompt-setting`) with five top-level tabs:

| Tab | What you can do |
| --- | --- |
| **My Prompt** | The only write surface: write your own system-level instructions (pick a layer → edit → save), plus a one-click "Restore default". This text is **placed after every built-in section**. |
| **Prompt overview** | Read-only: the assembled section list (status marks / search / filters / copy), the full text, and a `base ↔ effective` diff — so you can see exactly what your change did. |
| **Version history** | The history list (fixed-height, internally scrolling, paged — 50 per page by default) and line-level version diffs. The log has its **own scope selector** (workspace dimension), independent of the "View scope" selector above: the user layer's log is global and is never sliced by session. |
| **Backup & restore** | Export the configuration for download, and preview an import (review the change plan before anything is written). |
| **Advanced** | A read-only list of legacy overrides, two double-confirm buttons ("clear all overrides", "reset the whole layer"), the **"Check for updates" switch** (on by default; off means this plugin makes no network request at all), the **"Update now"** action (the host installs the version the banner named; you restart yourself — re-run `dsh web` after a command-line start, or quit and reopen DeepSeek Harness in the desktop app), and a full status area (mount state / build fingerprint / renderer self-check). |

> All UI copy follows DSH's language setting: switch DSH to Chinese and this page turns Chinese, with no
> refresh or restart.

### Network access: it checks for updates once (and you can turn it off)

When the settings page opens, the **host** (Node side) sends one `GET` to
`https://api.github.com/repos/zangxx66/dsh-prompt-setting/releases/latest` — a URL derived from this
package's `package.json` (`repository.url`), never hardcoded a second time. That is the plugin's
**only** outbound request, and it is switchable:

- **one request, nothing else**: no body, no cookies, no local/session/workspace data;
  `User-Agent: dsh-prompt-setting/<version>`; a 5-second timeout; not repeated within six hours in the
  same process;
- **it speaks up only for a confirmed newer release**: a **dismissible** banner at the top of the page
  (the new version + a link to the release page). No update, no release yet, or a failed request shows
  **nothing at all** at the top of the page — no prompt and no error. "No release yet / unparsable tag" is
  a *fact about upstream*, so it gets one neutral line inside the Advanced switch card; a **failed** check
  does not get that line;
- **turning it off**: Settings → Prompt settings → Advanced → turn **"Check for updates"** off. With it
  off there are **zero requests**, including on page load, and `<DSH_HOME>/prompt-setting/preferences.json`
  records `{"updateCheck": false}`. Hand-editing that file — or deleting it to return to the default
  (on) — works the same way;
- **what it never does**: no automatic download, no automatic install, **no automatic restart**, and no
  DSH platform version check.

### Installing the update ("Update now")

**The version gets installed; the restart is still yours — and the page says how.** The banner's
**Update now** button opens a second confirmation (which says so), and on confirm the **host** installs
that release's `.tgz` into the current profile through the official plugin manager. Afterwards the page
answers for the **launch shape** it is talking to: a command-line host says "vX.Y.Z is installed — restart
`dsh web` yourself", the official desktop app says "quit and reopen DeepSeek Harness" (a desktop user has
no terminal, so `dsh web` never appears there), and an undecidable shape falls back to copy both readers
can follow. **Nothing here restarts anything.**

- **what it installs**: the release **asset**
  `https://github.com/zangxx66/dsh-prompt-setting/releases/download/<tag>/dsh-prompt-setting-<version>.tgz`,
  with `<tag>`/`<version>` taken from the *same* update check — so the version announced is the version
  installed, and a cached check still costs zero outbound requests. Being an asset, it needs no pnpm
  build-script approval;
- **how it runs**: the click returns a `requestId` at once and the page polls it (1.5–5 s, up to 16
  minutes) with a **cancel** button. A failure names its category (asset missing 404 / build blocked /
  network / pnpm missing / …) with a retry — **never an automatic retry, never an automatic restart**;
- **a `link:` install is refused**: a profile that holds this package as a `link:`/local path is a
  development working tree, so the button refuses and points at the manual route instead of overwriting
  that link with a published version;
- **for releasers**: every release must upload its `npm pack` asset, named exactly
  `dsh-prompt-setting-<version>.tgz`, and this package must **not** add `postinstall`/`install` scripts
  (a tarball carrying one is stopped by pnpm's build gate). See `packages/dsh-prompt-setting/NOTES.md`
  §107.

## 3. Installation

**Prerequisites**: DSH installed (`>= 0.1.7-rc.2 < 0.2.0 || >= 0.2.0-0 < 0.2.1-0 || >= 0.2.1-0 < 0.2.2-0`:
every 0.1.x from `0.1.7-rc.2` on, every `0.2.0` and `0.2.1` prerelease — `alpha`, `beta`, `rc.N`, and the
synthetic `-0` floor — and the **`0.2.0` and `0.2.1` releases themselves** are in range; `0.2.2-0` and
everything after it are out, because a new minor is unverified). Node `>= 22` is needed only to run the
tests or to develop.

**The registry is the primary way in** (this package is published; npm `latest` is `0.1.5`):

```sh
dsh plugin --profile <name> add dsh-prompt-setting
```

The Web GUI's profile is `web`. The other three routes — git/GitHub, a local checkout, a tarball — are the
**development / offline / fallback** ones. All four routes put **this package into one DSH profile** — the
same profile files, the same package manager, the same log — so pick by what you have at hand. Do not
hand-edit profile config files.

### The GUI's own Plugins page (no terminal)

Current DSH carries a **standalone Plugins page in the Web GUI sidebar**. It is not under Settings —
Settings → *Built-in plugins* is the read-only inventory, not an installer:

1. Sidebar → **Plugins** → **Add plugin**;
2. type the same spec you would hand `dsh plugin add`, then **Install**:
   - **the registry name** — `dsh-prompt-setting` (**primary**; pulls the latest version from npm);
   - **a local path** (**development**) — the absolute path of this repository's package directory:
     `<absolute path to repo>/packages/dsh-prompt-setting` (clone or download the repository first; a
     relative path is refused, because the host's working directory means nothing to a browser);
   - **a git address** (**development / fallback**) —
     `github:zangxx66/dsh-prompt-setting#path:/packages/dsh-prompt-setting` (the `#path:` part is required
     for this monorepo);
   - **a tarball** (**offline / fallback**) — `dsh-prompt-setting-<version>.tgz`, on disk or over http(s);
3. the **Host reads the spec before anything installs** (name, version, one-liner, whether the package
   really carries a bundle) and says so under the field instead of installing when it cannot; an accepted
   spec then streams pnpm's output behind **Show install details**, with **Cancel install** at hand, and a
   failed or cancelled run puts the profile files back;
4. a finished install offers **Enable now**; the bundle's own page carries its switch, its rows and
   **uninstall**. If pnpm blocked a dependency's install scripts, the failure screen lists the packages
   and offers **Allow these scripts and retry**.

**A local path installs as a `link:`** — the profile and your checkout become the same files. That is a
development working tree, and the plugin's own "Update now" button deliberately refuses to overwrite it
with a published version (see the "Update now" note above): update such an install with `git pull`.

If your DSH build has no **Plugins** entry in the sidebar, use the `dsh` command line below.

### Hand the repository address to the agent in a session

Paste the address into a session and say what to do with it — the agent installs it into the profile that
session is running:

> install `https://github.com/zangxx66/dsh-prompt-setting` into this profile

In Creator mode the agent has the `plugin_manager` tool and calls it directly:

```
plugin_manager(action: "install_bundle", target: "github:zangxx66/dsh-prompt-setting#path:/packages/dsh-prompt-setting", enabled: true)
```

- **the `#path:` part is required**: this repository is a monorepo and the plugin lives in a subdirectory.
  Without it pnpm installs the synthetic `0.0.0` empty package rooted at the repository, and the plugin
  never shows up;
- **what you are approving**: an install rewrites the profile's `package.json` and bundle selection, and
  the installed Host code then runs in-process, outside the workspace sandbox — the tool therefore
  requires `danger-full-access`, or a per-call approval. Read the spec before approving it.

### The `dsh` command line

`dsh plugin --profile <name> <pnpm args…>` runs pnpm inside that profile's directory and selects the
bundle the run added. The Web GUI's profile is `web`:

```sh
# from the registry (primary)
dsh plugin --profile web add dsh-prompt-setting

# straight from GitHub — development / fallback; no clone first; the #path: part is required for this monorepo
dsh plugin --profile web add 'github:zangxx66/dsh-prompt-setting#path:/packages/dsh-prompt-setting'

# a local checkout — development (absolute path; installed as link:)
dsh plugin --profile web add '<absolute path to repo>/packages/dsh-prompt-setting'

# a tarball built from the package directory — offline / fallback; same behaviour
cd packages/dsh-prompt-setting && pnpm pack
dsh plugin --profile web add '<absolute path to the .tgz>'
```

pnpm ≥10 does **not** run a git dependency's build scripts by default, so a git install fails the first
time and prints an **exact package key** (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`); copy that key into the
profile's `pnpm-workspace.yaml` under `allowBuilds` and re-run `add`. **That grant means "this package's
code may execute on your machine at install time"**, so grant it only to sources you trust and pin the
commit (`…#<sha>`). This package is zero-build: `prepare` only runs a release self-check — are all
declared entry points present, are they all inside the `files` allowlist, does every patch row resolve.
To avoid the grant entirely, `pnpm pack` a tarball and `add` that instead; behaviour is identical.

### Confirm it is mounted

Open the DSH Web GUI → Settings: the **"Prompt settings"** pane should be there. To confirm the host
half is mounted, the page's "raw response" area shows the JSON returned by `GET /prompt-setting/ping`,
or run `await (await fetch('/prompt-setting/ping')).json()` in the page console.

> A bare `curl` against that route is rejected (`401`): it requires the browser's cookie authentication.
> That is expected behaviour and does not mean the route is missing. See
> [`NOTES.md`](./packages/dsh-prompt-setting/NOTES.md) §4.

Measured output, the full check table and the untested items are in
[`NOTES.md`](./packages/dsh-prompt-setting/NOTES.md) §96; the package-level summary — what it is, features
and install, bilingual — is in [`packages/dsh-prompt-setting/README.md`](./packages/dsh-prompt-setting/README.md).

## 4. Things to know (the easy-to-trip-on edges)

- **When it takes effect**: saved text applies from the **next turn / next session**; it never rewrites
  a turn already in flight.
- **The write surface is narrow**: only the "My Prompt" section is writable. Every other built-in section
  is **read-only** — `PUT`, single-name `DELETE` and `import` all return `403 write-locked` (and touch not
  one byte of the files when they refuse).
- **Two layers**: a user-level default plus a workspace-level override, **workspace wins**; handy for
  "one global set, plus a few extra lines in this project".
- **Installed but empty = not installed**: with no text, the section contributes nothing to the final
  prompt and the rendering is byte-for-byte identical.
- **Where the data lives**: only the plugin's own data directory (one user-level and one workspace-level
  layer file, plus a `history.jsonl`).

### "My Prompt" injects text — it is not a behaviour switch

- **What it does is inject your text at the end of the system prompt**, after every built-in section
  (measured on this machine: 100% present and 100% last across `standard` sessions since 2026-09-30
  21:32). It is **not** a hard switch over model behaviour.
- **Surface style — output language and the like — usually works.** But the effect on **reasoning /
  internal-thinking language is not reliable; the model and the platform decide**. We measured visible
  Chinese output next to fully-English reasoning in the same session. That is not the same as "the plugin
  did not work".
- **Two cases where it provably cannot take effect** (keep them apart from "the model ignored it"):
  ① the session's agent preset declares `complete: true` (the built-in `minimal`, and this machine's
  "梁神模式") — the platform collapses the assembly into a single section, so this plugin's text cannot
  enter the final prompt, and the Settings page raises a blocking notice; ② the plugin is not loaded at
  all — a broken plugin never affects DSH startup, so the terminal is the only signal; run
  `node scripts/check-compat.mjs` first.

**Prove it for this session (two paths plus a failure rule):**

```bash
# Path 1 (hardest evidence): read this session's persisted final prompt
ls ~/.dsh/sessions                              # find your workspace dir (escaped; non-ASCII becomes ~XXXX~)
F=~/.dsh/sessions/<workspace-dir>/<session-id>/session.v4.jsonl.zstd   # e.g. --Users-me-Documents-proj--
zstd -dc "$F" | jq -r 'select(.type=="system/message") | .data.message.content[0].text[-200:]'
```

- **Path 2 (GUI)**: Settings → **Prompt settings** → the "My Prompt" panel for the freeze warning, and the
  Advanced tab's status card for the freeze state and the build fingerprint (`matches host` / `page is
  stale` / `unknown`; "stale" only means the page is old — refresh).
- **How to read the result**: your lines at the end ⇒ injection is fine, and if the model does not comply
  the cause is **model compliance or a frozen preset**; no such lines (or an empty text) ⇒ check that
  session's `agentPreset` and freeze state first.

## 5. Repository layout

```
packages/dsh-prompt-setting/   # the plugin package (publishable to npm on its own)
├── index.js                   # host half: routes + assembly listeners + the reserved section
├── client.js                  # client half: the four Settings tabs
├── core/                      # pure-function kernels + the only module that touches the filesystem
├── cordis.patch.yml           # bundle patch (one insert row mounting both halves)
├── scripts/                   # check-compat.mjs (read-only diagnostic) + prepare.mjs (git-install gate)
├── CONTRACT.md                # the frozen REST contract (the client is written against it)
├── NOTES.md                   # design trade-offs, measurements, untested items
└── test/                      # eighteen test suites
assets/                        # the hero image for this README
.dsh-graph/                    # project board and event log (separate inner repo, not part of this one)
.worktrees/                    # isolated worktrees for subagents (not part of this one)
```

## 6. Development and testing

```bash
cd packages/dsh-prompt-setting

# syntax
node --check index.js && node --check client.js && for f in core/*.js scripts/*.mjs; do node --check "$f"; done

node --test                    # eighteen suites; the integration suite runs against the real DSH package and must pass (not skip)
node scripts/check-compat.mjs  # read-only compatibility self-check (no network, never throws, always exit 0)
node scripts/prepare.mjs       # the prepare gate pnpm runs on a git install (exit 1 when it fails)
npm pack --dry-run             # confirm the published artifact is clean (24 files, no test/, no .dsh-graph)
```

Latest run on this machine: `node --test` **634 tests, all passing, 0 skipped** (31 of them in the
integration suite); `npm pack --dry-run` reports 24 files (measured 2026-10-08).

Worth knowing:

- `test/integration.test.mjs` resolves the real `@deepseek-ai/dsh-system-prompt` and the real Cordis from
  your local DSH install root, and verifies assembly semantics (waterfall order, `complete` freezing,
  scope shadowing) in a real context — **these conclusions are measured, not guessed** — and the same
  conclusions are written into [`CONTRACT.md`](./packages/dsh-prompt-setting/CONTRACT.md) and the snapshot's
  `experiments` field.
- When the real package cannot be resolved, the suite `skip`s, so `node --test` stays green on a machine
  without DSH; **on a development machine you must see it pass, not skip** — a skip means the evidence is missing.
- The tests need no browser: `client.js` runs inside a `node:vm` sandbox with `require` / React / `fetch`
  all stubbed, so "primitives available / unavailable" and "probe ok / HTTP error / network error" are all
  asserted offline.
- The tests never read or write your real `~/.dsh`: the relevant suites point `$DSH_HOME` at a temp directory.

When the plugin does not show up after a DSH upgrade and the terminal says nothing, run
`node scripts/check-compat.mjs` first — it prints the terminal signature of the four boot failure modes
and the rescue steps. How a code change takes effect, and the maintainer commands, are in the package
README's "For maintainers" section; the detailed measurements are in
[`NOTES.md`](./packages/dsh-prompt-setting/NOTES.md) §91.

## 7. Design notes

- **Visible**: the host half calls `ctx.systemPrompt.assemble({scope: agent})` and gets back the sections
  (`sections[{name,text}]`) plus the full text.
- **Writable, without touching the core**: it registers the official `system-prompt/assemble` waterfall
  hook and replaces / hides / appends by section name — **no change to DSH's core, none to the global install**.
- **The plugin registers its own section**: during `apply` it registers the reserved section
  `prompt-setting:custom-prompt` (empty text, `interpolate: false`); your text lands on that section
  through the override engine and is moved to the **end** of the final assembly by an outermost listener.
  `interpolate: false` is not a style choice: once user text takes part in interpolation, a single
  `{{unknown-variable}}` would make every later assembly throw.
- **Layered so it can be tested**: apart from `store.js`, everything under `core/` is plain data in,
  plain data out; `store.js` is the only module that touches the filesystem, and it is not on the
  assembly path. Listeners on the assembly path read memory only and always call `next()`.
- **Conservative failure posture**: an exception during registration, self-check or assembly never makes
  DSH fail to start; a mid-`apply` failure rolls back the effects already registered, leaving no half-mount.

## 8. Documentation map

| Document | For | Contents |
| --- | --- | --- |
| This file | everyone | what it is, how to install, how to use, the repository at a glance |
| [`packages/dsh-prompt-setting/README.md`](./packages/dsh-prompt-setting/README.md) | users / developers | package summary and features (bilingual), install, maintainer notes, troubleshooting |
| [`CONTRACT.md`](./packages/dsh-prompt-setting/CONTRACT.md) | developers | the frozen REST contract: every field, action enum, size limit and 4xx |
| [`NOTES.md`](./packages/dsh-prompt-setting/NOTES.md) | developers | design trade-offs and measurements (including untested items and conclusions we had to retract) |
| [`CHANGELOG.md`](./CHANGELOG.md) | users / developers | User-visible changes per release (bilingual; published — the current npm `latest` is 0.1.5) |

## 9. Status and roadmap

- **Delivered**: the plugin skeleton and local profile mounting (both halves, the Settings entry), the
  host-side assembly snapshot + `system-prompt/assemble` override engine + user/workspace two-layer
  persistence, the Settings Prompt manager (section browsing, full-text search, in-place editing with
  non-overridable sections marked, override management), version history + diffs, restore-default, export / import.
- **Current shape (contract Revision 8)**: the write surface is narrowed to the reserved "My Prompt"
  section; every other section is read-only; Settings is split into four top-level tabs by function and
  frequency of use.
- **On-machine acceptance status, remaining edges and untested items** are in the three package documents
  above; progress and acceptance evidence live on the `.dsh-graph` board.

## 10. License

MIT — see [`LICENSE`](./LICENSE) (`packages/dsh-prompt-setting/LICENSE` is the same file, shipped with the npm package).

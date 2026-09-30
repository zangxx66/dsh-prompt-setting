![dsh-prompt-setting: System Prompt management for DSH](./assets/hero.jpg)

# dsh-prompt-setting

English | [中文](./README_zh.md)

**System Prompt management for DSH (DeepSeek Harness).** It adds a Prompt manager to the Web GUI's
Settings: you can **see** the system prompt a session actually assembles on every turn, search it,
write your own instructions into it, and roll back a bad edit — all **without touching the global DSH
install**.

![license](https://img.shields.io/badge/license-MIT-blue)
![version](https://img.shields.io/badge/version-0.1.0-blue)
![dsh](https://img.shields.io/badge/DSH-%3E%3D0.1.7--rc.2-blueviolet)
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

Settings gains a **"Prompt settings"** pane (`id: prompt-setting`) with four top-level tabs:

| Tab | What you can do |
| --- | --- |
| **My Prompt** | The only write surface: write your own system-level instructions (pick a layer → edit → save), plus a one-click "Restore default". This text is **placed after every built-in section**. |
| **Prompt overview** | Read-only: the assembled section list (status marks / search / filters / copy), the full text, and a `base ↔ effective` diff — so you can see exactly what your change did. |
| **History & backup** | History list + version diffs (line-level); export the configuration for download, and preview an import (review the change plan before anything is written). |
| **Advanced** | A read-only list of legacy overrides, two double-confirm buttons ("clear all overrides", "reset the whole layer"), and a full status area (mount state / build fingerprint / renderer self-check). |

> All UI copy follows DSH's language setting: switch DSH to Chinese and this page turns Chinese, with no
> refresh or restart.

## 3. Installation

**Prerequisites**: DSH installed (`>= 0.1.7-rc.2 < 0.1.8`). Node `>= 22` is needed only to run the tests
or to develop.

1. Clone or download this repository anywhere on disk;
2. Install the plugin directory with DSH's plugin manager, using an **absolute path** (**do not**
   hand-edit profile config files):

   ```
   plugin_manager(action: "install_bundle", target: "<absolute path to repo>/packages/dsh-prompt-setting")
   ```

3. Open the DSH Web GUI → Settings; the "Prompt settings" pane should be there;
4. To confirm the host half is mounted: the page's "raw response" area shows the JSON returned by
   `GET /prompt-setting/ping`, or run `await (await fetch('/prompt-setting/ping')).json()` in the page console.

> A bare `curl` against that route is rejected (`401`): it requires the browser's cookie authentication.
> That is expected behaviour and does not mean the route is missing. See
> [`NOTES.md`](./packages/dsh-prompt-setting/NOTES.md) §4.

### Installing straight from GitHub (optional)

If you would rather not clone first, pnpm can install from git directly. This repository is a monorepo
and the plugin lives in a subdirectory, so the **`#path:` part is required** (without it you get the
synthetic `0.0.0` empty package rooted at the repository, and the plugin never shows up):

```sh
dsh plugin --profile demo add 'github:zangxx66/dsh-prompt-setting#path:/packages/dsh-prompt-setting'
```

pnpm ≥10 does **not** run a git dependency's build scripts by default, so the first attempt fails and
prints an **exact package key** (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`); copy that key into the
profile's `pnpm-workspace.yaml` under `allowBuilds` and re-run `add`. **That grant means "this package's
code may execute on your machine at install time"**, so grant it only to sources you trust and pin the
commit (`…#<sha>`). This package is zero-build: `prepare` only runs a release self-check — are all
declared entry points present, are they all inside the `files` allowlist, does every patch row resolve.
To avoid the grant entirely, `pnpm pack` a tarball and `add` that instead; behaviour is identical.

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
└── test/                      # fourteen test suites
assets/                        # the hero image for this README
.dsh-graph/                    # project board and event log (separate inner repo, not part of this one)
.worktrees/                    # isolated worktrees for subagents (not part of this one)
```

## 6. Development and testing

```bash
cd packages/dsh-prompt-setting

# syntax
node --check index.js && node --check client.js && for f in core/*.js scripts/*.mjs; do node --check "$f"; done

node --test                    # fourteen suites; the integration suite runs against the real DSH package and must pass (not skip)
node scripts/check-compat.mjs  # read-only compatibility self-check (no network, never throws, always exit 0)
node scripts/prepare.mjs       # the prepare gate pnpm runs on a git install (exit 1 when it fails)
npm pack --dry-run             # confirm the published artifact is clean (20 files, no test/, no .dsh-graph)
```

Latest run on this machine: `node --test` **395 assertions, all passing, 0 skipped** (21 of them in the
integration suite); `npm pack --dry-run` reports 20 files (measured 2026-09-30).

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
| [`CHANGELOG.md`](./CHANGELOG.md) | users / developers | User-visible changes per release (bilingual; currently 0.1.0, unpublished) |

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

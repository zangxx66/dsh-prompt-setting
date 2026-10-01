/**
 * Two-layer JSON persistence for `dsh-prompt-setting`.
 *
 * This is the ONLY module in the package that touches the filesystem, and it
 * is never on the prompt-assembly path: layers are read when the plugin mounts
 * and refreshed by the REST routes, then held in memory.
 *
 * Guarantees
 * - every write is atomic (temp file in the target directory, then `rename`),
 *   so a reader never observes a half-written config and a crash cannot
 *   truncate the previous one;
 * - every read is validated and reports a structured error instead of
 *   throwing, so one corrupt file disables one layer and never breaks a turn;
 * - no path is ever derived from `process.cwd()` — the user layer comes from
 *   `$DSH_HOME` (or `~/.dsh`) and the workspace layer from a workspace root
 *   the Host resolved from a session, never from client input.
 *
 * It also owns {@link clientBuildInfo}: the one read the「构建戳」needs (the
 * bytes of `client.js` this Host actually publishes). It lives here, not in a
 * second FS module, so the "exactly one module touches the filesystem"
 * invariant survives the feature — `core/build.js` stays pure text.
 *
 * @module dsh-prompt-setting/core/store
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { fingerprintOf } from './build.js';
import {
  DEFAULT_HISTORY_LIMIT,
  makeRecord,
  parseHistory,
  serializeHistory,
  serializeRecord,
  trimRecords,
} from './history.js';
import { OverrideError, emptyConfig, interpolateFlagOf, validateConfig, withInterpolate } from './overrides.js';

/** Directory (under `$DSH_HOME`) that owns the user layer. */
const USER_DIRECTORY = 'prompt-setting';
/** Config file name inside either layer directory. */
const FILE_NAME = 'overrides.json';
/** History file name inside either layer directory (one JSON record per line). */
const HISTORY_FILE_NAME = 'history.jsonl';
/** Directory (under a workspace root) that owns the workspace layer. */
const WORKSPACE_DIRECTORY = '.dsh-prompt-setting';

/** Distinguishes two temp files written within the same millisecond. */
let tempCounter = 0;

/**
 * Build a uniquely named temp path next to a target file, so the `rename` that
 * follows stays within one filesystem (and is therefore atomic).
 * @param path - the target path.
 * @returns the temp path.
 */
function tempPathFor(path) {
  tempCounter += 1;
  return join(dirname(path), `.${basename(path)}.${process.pid}.${tempCounter}.tmp`);
}

/**
 * Remove a temp file, ignoring any failure: the caller's error is the signal.
 * @param path - the temp path.
 */
function discardTemp(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // best effort only
  }
}

/**
 * Resolve `$DSH_HOME`.
 * @param env - the environment to read (defaults to `process.env`).
 * @returns the DSH home directory, or `~/.dsh` when unset or blank.
 */
export function resolveDshHome(env = process.env) {
  const configured = env?.DSH_HOME;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return join(homedir(), '.dsh');
}

/**
 * The user layer's config path.
 * @param env - the environment to read.
 * @returns `<DSH_HOME>/prompt-setting/overrides.json`.
 */
export function userConfigPath(env = process.env) {
  return join(resolveDshHome(env), USER_DIRECTORY, FILE_NAME);
}

/**
 * The workspace layer's config path for one workspace root.
 * @param workspaceRoot - an absolute workspace root resolved by the Host.
 * @returns `<workspaceRoot>/.dsh-prompt-setting/overrides.json`.
 */
export function workspaceConfigPath(workspaceRoot) {
  return join(String(workspaceRoot), WORKSPACE_DIRECTORY, FILE_NAME);
}

/**
 * The history file that belongs to a layer, derived from its config path so a
 * layer can never write history into another layer's directory.
 * @param configPath - the layer's `overrides.json` path.
 * @returns `<dir>/history.jsonl`.
 */
export function historyPath(configPath) {
  return join(dirname(String(configPath)), HISTORY_FILE_NAME);
}

/**
 * Read the published client bundle and fingerprint its marker region.
 *
 * Deliberately **uncached**: this is called on every `GET /prompt-setting/ping`
 * precisely because a cached answer would be a lie the moment the file
 * changes — and 「this file changed but my tab did not」 is the whole point of
 * the build stamp. The read is one `readFileSync` of a ~250 kB file per ping,
 * which is a user-initiated probe, never on the assembly path.
 *
 * Never throws. `null` means "unknown", and unknown is rendered as unknown: a
 * readable file whose marker region is unusable (markers edited away, removed
 * or duplicated) is `null` too, because a fabricated digest would show up as a
 * false「页面版本过期」.
 * @param clientPath - the bundle path (`index.js` resolves it from its own URL).
 * @returns `{hash, size, mtime}` — 8 hex digits, the region's UTF-16 code-unit
 *   length and the file's mtime as an ISO string — or `null`.
 */
export function clientBuildInfo(clientPath) {
  try {
    const raw = readFileSync(clientPath, 'utf8');
    const stats = statSync(clientPath);
    const fingerprint = fingerprintOf(raw);
    if (fingerprint === null) return null;
    return { hash: fingerprint.hash, size: fingerprint.size, mtime: stats.mtime.toISOString() };
  } catch {
    return null;
  }
}

/**
 * Read and validate one layer's config file.
 *
 * Never throws: a missing file is an empty, enabled layer; an unreadable,
 * unparsable or invalid file is a disabled layer carrying a reason.
 * @param path - the config path.
 * @returns `{config, missing, error}` where `error` is `{code, message}|null`.
 */
export function readConfig(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: emptyConfig(), missing: true, error: null };
    return {
      config: null,
      missing: false,
      error: { code: 'unreadable-file', message: `cannot read ${path}: ${error?.message ?? String(error)}` },
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      config: null,
      missing: false,
      error: { code: 'invalid-json', message: `${path} is not valid JSON: ${error?.message ?? String(error)}` },
    };
  }
  try {
    return { config: validateConfig(parsed), missing: false, error: null };
  } catch (error) {
    const code = error instanceof OverrideError ? error.code : 'invalid-config';
    return { config: null, missing: false, error: { code, message: `${path}: ${error?.message ?? String(error)}` } };
  }
}

/**
 * Write one layer's config atomically.
 *
 * The bytes go to a uniquely named temp file in the same directory and are then
 * `rename`d over the target. `rename` is atomic within a filesystem, so a
 * concurrent reader sees either the old file or the new one, never a prefix of
 * the new one; a failure before the rename leaves the old file untouched.
 * @param path - the config path.
 * @param config - the validated config to persist.
 * @returns `{ok: true, path}`.
 * @throws {OverrideError} when the bytes cannot be written or renamed.
 */
export function writeConfig(path, config) {
  const directory = dirname(path);
  let serialized;
  try {
    serialized = `${JSON.stringify(config, null, 2)}\n`;
  } catch (error) {
    throw new OverrideError('unserializable-config', `cannot serialize config: ${error?.message ?? String(error)}`, 500);
  }
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    throw new OverrideError('unwritable-directory', `cannot create ${directory}: ${error?.message ?? String(error)}`, 500);
  }
  tempCounter += 1;
  const temp = join(directory, `.${FILE_NAME}.${process.pid}.${tempCounter}.tmp`);
  try {
    writeFileSync(temp, serialized, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The temp file is best-effort cleanup; the original error is the signal.
    }
    throw new OverrideError('write-failed', `cannot write ${path}: ${error?.message ?? String(error)}`, 500);
  }
  return { ok: true, path };
}

/**
 * Insert or replace one override in a config, keyed by section name.
 *
 * The interpolation switch is a config-level field (Revision 9), so it is
 * carried across the rebuild: saving a prompt must not turn the switch off.
 * @param config - the current validated config.
 * @param override - the normalized override to persist.
 * @returns a fresh config with the override upserted in place.
 */
export function upsertOverride(config, override) {
  const overrides = (config?.overrides ?? []).slice();
  const at = overrides.findIndex((entry) => entry.name === override.name);
  if (at === -1) overrides.push(override);
  else overrides[at] = override;
  return withInterpolate(
    { version: config?.version ?? emptyConfig().version, overrides },
    interpolateFlagOf(config),
  );
}

/**
 * Remove one override from a config, keyed by section name.
 *
 * Like {@link upsertOverride}, the switch survives the rebuild.
 * @param config - the current validated config.
 * @param name - the section name to drop.
 * @returns `{config, removed}`.
 */
export function removeOverride(config, name) {
  const overrides = (config?.overrides ?? []).slice();
  const at = overrides.findIndex((entry) => entry.name === name);
  if (at === -1) return { config, removed: false };
  overrides.splice(at, 1);
  return {
    config: withInterpolate(
      { version: config?.version ?? emptyConfig().version, overrides },
      interpolateFlagOf(config),
    ),
    removed: true,
  };
}

/**
 * Read one layer's history file.
 *
 * Never throws: a missing file is empty history, and an unreadable file is
 * reported as an error so the caller can say so instead of pretending there
 * was no history. Corrupt lines inside a readable file are counted and skipped
 * (`parseHistory`), because history is a log, not a config.
 * @param path - the history path.
 * @returns `{records, corrupt, maxSeq, missing, error}`.
 */
export function readHistoryFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { records: [], corrupt: 0, maxSeq: 0, missing: true, error: null };
    }
    return {
      records: [],
      corrupt: 0,
      maxSeq: 0,
      missing: false,
      error: { code: 'unreadable-file', message: `cannot read ${path}: ${error?.message ?? String(error)}` },
    };
  }
  const parsed = parseHistory(raw);
  return { ...parsed, missing: false, error: null };
}

/**
 * Write text to a path atomically: temp file in the same directory, then
 * `rename`. Used for history rewrites; config writes keep using
 * {@link writeConfig} unchanged.
 * @param path - the target path.
 * @param text - the exact bytes to write.
 * @returns `{ok: true, path}`.
 * @throws {OverrideError} when the bytes cannot be written or renamed.
 */
export function writeTextAtomic(path, text) {
  const directory = dirname(path);
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    throw new OverrideError('unwritable-directory', `cannot create ${directory}: ${error?.message ?? String(error)}`, 500);
  }
  const temp = tempPathFor(path);
  try {
    writeFileSync(temp, text, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    discardTemp(temp);
    throw new OverrideError('write-failed', `cannot write ${path}: ${error?.message ?? String(error)}`, 500);
  }
  return { ok: true, path };
}

/**
 * Append one history record to a layer's history file, keeping it bounded.
 *
 * The record's `seq` continues the file's high-water mark, so an id survives
 * trimming. The common path is a single `appendFileSync` — one line written,
 * nothing rewritten. The file is rewritten only when it must be: when the
 * append would exceed `limit`, or when a corrupt line has to be healed out.
 * @param path - the history path.
 * @param fields - the record fields; `seq` is assigned here.
 * @param limit - the retention bound.
 * @returns `{record, dropped, rewritten}`.
 * @throws {OverrideError} when the history file cannot be read or written.
 */
export function appendHistoryRecord(path, fields, limit = DEFAULT_HISTORY_LIMIT) {
  const current = readHistoryFile(path);
  if (current.error !== null) {
    throw new OverrideError(
      'history-unusable',
      `cannot append to ${path} (${current.error.code}: ${current.error.message})`,
      500,
    );
  }
  const record = makeRecord({ ...fields, seq: current.maxSeq + 1 });
  const trimmed = trimRecords([...current.records, record], limit);
  const rewrite = trimmed.trimmed || current.corrupt > 0;
  try {
    if (rewrite) {
      writeTextAtomic(path, serializeHistory(trimmed.kept));
    } else {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, serializeRecord(record), 'utf8');
    }
  } catch (error) {
    if (error instanceof OverrideError) throw error;
    throw new OverrideError('history-write-failed', `cannot write ${path}: ${error?.message ?? String(error)}`, 500);
  }
  return { record, dropped: trimmed.dropped, rewritten: rewrite };
}

/**
 * Replace several config files with one all-or-nothing guarantee as strong as
 * the filesystem allows.
 *
 * Phase 1 stages every layer: serialize, create the directory chain, write a
 * temp file next to the target, then **read the temp file back and validate
 * it**. Any failure here removes every temp file and throws — the real config
 * files were never opened for writing, so they are byte-identical to what they
 * were. Phase 2 renames the staged temp files into place, which is atomic per
 * file.
 *
 * Residual risk, stated rather than hidden: the multi-file commit is not a
 * transaction. A filesystem failure between two renames leaves the earlier
 * layer replaced and the later one untouched; the thrown error says how many
 * layers were committed so the caller can report it truthfully.
 * @param entries - `[{path, config}]`.
 * @returns `{ok: true, paths}`.
 * @throws {OverrideError} when staging or committing fails.
 */
export function writeConfigsAtomically(entries) {
  const list = (Array.isArray(entries) ? entries : []).map((entry) => ({
    path: String(entry.path),
    serialized: `${JSON.stringify(entry.config, null, 2)}\n`,
  }));
  const staged = [];
  try {
    for (const entry of list) {
      const directory = dirname(entry.path);
      mkdirSync(directory, { recursive: true });
      const temp = tempPathFor(entry.path);
      writeFileSync(temp, entry.serialized, 'utf8');
      staged.push({ temp, path: entry.path });
      const verify = readConfig(temp);
      if (verify.error !== null) {
        throw new OverrideError(
          'import-verify-failed',
          `the staged file for ${entry.path} did not validate (${verify.error.code}: ${verify.error.message})`,
          500,
        );
      }
    }
  } catch (error) {
    for (const item of staged) discardTemp(item.temp);
    if (error instanceof OverrideError) throw error;
    throw new OverrideError('import-staging-failed', `cannot stage the import: ${error?.message ?? String(error)}`, 500);
  }

  const committed = [];
  try {
    for (const item of staged) {
      renameSync(item.temp, item.path);
      committed.push(item.path);
    }
  } catch (error) {
    for (const item of staged) discardTemp(item.temp);
    throw new OverrideError(
      'import-commit-failed',
      `the staged import could not be committed: ${error?.message ?? String(error)} (${committed.length} of ${staged.length} layer(s) were already replaced)`,
      500,
    );
  }
  return { ok: true, paths: committed };
}


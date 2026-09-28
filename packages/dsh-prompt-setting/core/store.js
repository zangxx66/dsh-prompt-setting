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
 * @module dsh-prompt-setting/core/store
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { OverrideError, emptyConfig, validateConfig } from './overrides.js';

/** Directory (under `$DSH_HOME`) that owns the user layer. */
const USER_DIRECTORY = 'prompt-setting';
/** Config file name inside either layer directory. */
const FILE_NAME = 'overrides.json';
/** Directory (under a workspace root) that owns the workspace layer. */
const WORKSPACE_DIRECTORY = '.dsh-prompt-setting';

/** Distinguishes two temp files written within the same millisecond. */
let tempCounter = 0;

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
 * @param config - the current validated config.
 * @param override - the normalized override to persist.
 * @returns a fresh config with the override upserted in place.
 */
export function upsertOverride(config, override) {
  const overrides = (config?.overrides ?? []).slice();
  const at = overrides.findIndex((entry) => entry.name === override.name);
  if (at === -1) overrides.push(override);
  else overrides[at] = override;
  return { version: config?.version ?? emptyConfig().version, overrides };
}

/**
 * Remove one override from a config, keyed by section name.
 * @param config - the current validated config.
 * @param name - the section name to drop.
 * @returns `{config, removed}`.
 */
export function removeOverride(config, name) {
  const overrides = (config?.overrides ?? []).slice();
  const at = overrides.findIndex((entry) => entry.name === name);
  if (at === -1) return { config, removed: false };
  overrides.splice(at, 1);
  return { config: { version: config?.version ?? emptyConfig().version, overrides }, removed: true };
}

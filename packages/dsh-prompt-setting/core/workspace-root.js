/**
 * The one path-safety rule for a workspace root, shared by every reader
 * (`CONTRACT.md` §11.7, Revision 53 / g-074 R1).
 *
 * It lives in a module of its own because **two** document fields name a
 * workspace root and both must be judged by the very same rule:
 * `workspaces[].root` (read by `core/transfer.js`) and
 * `presets.applied[].workspaceRoot` (read by `core/presets.js`). While the rule
 * sat inside `core/transfer.js`, `core/presets.js` could not import it without
 * creating a cycle (`transfer.js` already imports `presets.js`), so the two
 * drifted: `workspaces[].root` was checked and `applied[].workspaceRoot` was
 * not — which is exactly the hole g-074 R1 closed.
 *
 * Pure like every other kernel module here: constants plus one function over
 * plain data — no `fs`, no `ctx`, no clock. This is the **shape** half of the
 * rule; the registry half (「is this one of the workspaces this Host knows?」)
 * lives in `index.js`, because only the Host can answer it.
 *
 * @module dsh-prompt-setting/core/workspace-root
 */

import { fail } from './overrides.js';

/** Upper bound on a workspace `root`, in UTF-16 code units. */
export const MAX_WORKSPACE_ROOT_LENGTH = 4096;
/**
 * An absolute path as the two platforms this plugin runs on write one: POSIX
 * (`/…`), a drive (`C:\…`), or a UNC share (`\\server\…`).
 */
export const ABSOLUTE_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
/** Control characters, refused anywhere in a `root`. */
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Validate one workspace `root` **as a path**, without any registry knowledge.
 *
 * It answers "could this string possibly be a workspace root this plugin may
 * write into?", and it refuses everything a later step would have to be
 * careful about:
 * - a non-string, an empty string, or one over {@link MAX_WORKSPACE_ROOT_LENGTH};
 * - a control character (a NUL is how a path-looking string becomes a
 *   different path in the filesystem layer);
 * - anything that is not absolute — a relative path would resolve against the
 *   Host process's own `cwd`, which is never what a backup means;
 * - a `..` segment, which is how an absolute-looking path escapes its root;
 * - the filesystem root itself (`/`, `C:\`): the plugin's directory must be a
 *   *child* of a workspace, never the root of a volume.
 *
 * Passing it means the string is *shaped* like a root; it says nothing about
 * whether this machine has that workspace. Every caller must follow it with the
 * registry check (`assertKnownWorkspaceRoot` in `index.js`) before a byte is
 * written — a shape check alone would still let a document name `/etc`.
 * @param value - the candidate `root`.
 * @param where - the field name to name in the message (defaults to `"root"`).
 * @returns the root, unchanged.
 * @throws {OverrideError} `invalid-workspace-root` (400).
 */
export function validateWorkspaceRoot(value, where = '"root"') {
  if (typeof value !== 'string' || value.length === 0) {
    throw fail('invalid-workspace-root', `a workspace entry requires a non-empty string ${where}`);
  }
  if (value.length > MAX_WORKSPACE_ROOT_LENGTH) {
    throw fail('invalid-workspace-root', `${where} exceeds ${MAX_WORKSPACE_ROOT_LENGTH} characters`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw fail('invalid-workspace-root', `${where} must not contain control characters`);
  }
  if (!ABSOLUTE_ROOT.test(value)) {
    throw fail('invalid-workspace-root', `${where} must be an absolute path, not ${JSON.stringify(value)}`);
  }
  if (value.split(/[\\/]+/).includes('..')) {
    throw fail('invalid-workspace-root', `${where} must not contain a ".." segment: ${JSON.stringify(value)}`);
  }
  const trimmed = value.replace(/[\\/]+$/, '');
  if (trimmed.length === 0 || /^[A-Za-z]:$/.test(trimmed)) {
    throw fail('invalid-workspace-root', `${where} must name a directory, not a filesystem root: ${JSON.stringify(value)}`);
  }
  return value;
}

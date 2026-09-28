/**
 * Diff kernel for `dsh-prompt-setting`.
 *
 * Pure like the rest of `core/`: no `fs`, no `ctx`, no clock, no `diff`
 * package. The line comparison is a real LCS over lines with an explicit
 * budget; when a prompt is too large for the budget the module degrades to a
 * common-prefix/suffix trim and says so in `mode` instead of silently
 * pretending the result is exact.
 *
 * Two granularities, because they answer two different questions:
 * - **section level** ({@link diffSnapshots}) — which sections differ between
 *   two versions of a layer. It compares the layer *snapshot* stored on each
 *   history record, which carries `{name, action, hash, bytes}` and no text, so
 *   comparing two versions never loads a hundred prompt bodies.
 * - **line level** ({@link diffLines}) — how one section's text changed.
 *
 * `normalizeLines` is where CRLF is handled: a line ending is a line ending, so
 * `\r\n` and `\r` both split, and `crlfNormalized` reports that the comparison
 * ignored the difference rather than hiding it.
 *
 * @module dsh-prompt-setting/core/diff
 */

/** Per-side line cap before the bounded fallback replaces the LCS. */
export const MAX_DIFF_LINES = 2000;
/** LCS dynamic-programming budget, in cells (`(m+1) * (n+1)`). */
export const MAX_DIFF_CELLS = 1_000_000;
/** Ops returned at most; a longer diff is cut and flagged `truncated`. */
export const MAX_DIFF_OPS = 4000;

/**
 * Split text into lines for comparison, remembering whether CRLF was present.
 * @param text - the text (null/undefined reads as '').
 * @returns `{lines, crlf}`.
 */
export function normalizeLines(text) {
  const source = String(text === null || text === undefined ? '' : text);
  return { lines: source.split(/\r\n|\r|\n/), crlf: /\r\n|\r/.test(source) };
}

/**
 * Compare two texts line by line.
 *
 * `ops` is the ordered op list: `equal` rows carry both line numbers, `delete`
 * rows only `beforeLine`, `insert` rows only `afterLine`. Every op also carries
 * the line's `text` so a renderer never has to index back into the source.
 * @param beforeText - the older text.
 * @param afterText - the newer text.
 * @param options - `{maxLines, maxCells, maxOps}` budget overrides.
 * @returns `{ops, stats, mode, crlfNormalized, truncated}` where `mode` is
 *   `"lcs"` (exact) or `"bounded"` (prefix/suffix trim + one replace block).
 */
export function diffLines(beforeText, afterText, options = {}) {
  const maxLines = Number.isInteger(options.maxLines) ? options.maxLines : MAX_DIFF_LINES;
  const maxCells = Number.isInteger(options.maxCells) ? options.maxCells : MAX_DIFF_CELLS;
  const maxOps = Number.isInteger(options.maxOps) ? options.maxOps : MAX_DIFF_OPS;
  const left = normalizeLines(beforeText);
  const right = normalizeLines(afterText);
  const a = left.lines;
  const b = right.lines;

  let ops = null;
  let mode = 'lcs';
  if (a.length <= maxLines && b.length <= maxLines && (a.length + 1) * (b.length + 1) <= maxCells) {
    ops = lcsOps(a, b);
  }
  if (ops === null) {
    mode = 'bounded';
    ops = boundedOps(a, b);
  }

  const stats = { added: 0, removed: 0, same: 0 };
  for (const op of ops) {
    if (op.type === 'insert') stats.added += 1;
    else if (op.type === 'delete') stats.removed += 1;
    else stats.same += 1;
  }
  const truncated = ops.length > maxOps;
  return {
    ops: truncated ? ops.slice(0, maxOps) : ops,
    stats,
    mode,
    crlfNormalized: left.crlf || right.crlf,
    truncated,
  };
}

/**
 * Exact line ops via a full LCS table.
 * @param a - the older lines.
 * @param b - the newer lines.
 * @returns the op list.
 */
function lcsOps(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j]
        ? table[(i + 1) * cols + (j + 1)] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', text: a[i], beforeLine: i + 1, afterLine: j + 1 });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) {
      ops.push({ type: 'delete', text: a[i], beforeLine: i + 1, afterLine: null });
      i += 1;
    } else {
      ops.push({ type: 'insert', text: b[j], beforeLine: null, afterLine: j + 1 });
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push({ type: 'delete', text: a[i], beforeLine: i + 1, afterLine: null });
    i += 1;
  }
  while (j < b.length) {
    ops.push({ type: 'insert', text: b[j], beforeLine: null, afterLine: j + 1 });
    j += 1;
  }
  return ops;
}

/**
 * Bounded fallback: keep the shared prefix and suffix as `equal` rows and
 * report the differing middle as one delete block followed by one insert block.
 * It never claims precision it does not have — `mode: "bounded"` says so.
 * @param a - the older lines.
 * @param b - the newer lines.
 * @returns the op list.
 */
function boundedOps(a, b) {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix
    && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const ops = [];
  for (let index = 0; index < prefix; index += 1) {
    ops.push({ type: 'equal', text: a[index], beforeLine: index + 1, afterLine: index + 1 });
  }
  for (let index = prefix; index < a.length - suffix; index += 1) {
    ops.push({ type: 'delete', text: a[index], beforeLine: index + 1, afterLine: null });
  }
  for (let index = prefix; index < b.length - suffix; index += 1) {
    ops.push({ type: 'insert', text: b[index], beforeLine: null, afterLine: index + 1 });
  }
  for (let index = 0; index < suffix; index += 1) {
    const beforeLine = a.length - suffix + index + 1;
    const afterLine = b.length - suffix + index + 1;
    ops.push({ type: 'equal', text: a[beforeLine - 1], beforeLine, afterLine });
  }
  return ops;
}

/**
 * Compare two layer snapshots by section name.
 * @param before - the older snapshot (`{name, action, hash, bytes}[]`).
 * @param after - the newer snapshot.
 * @returns rows of `{name, status, before, after}` in "before order, then
 *   after-only" order; `status` is `same` | `changed` | `added` | `removed`.
 */
export function diffSnapshots(before, after) {
  const left = Array.isArray(before) ? before : [];
  const right = Array.isArray(after) ? after : [];
  const rightByName = new Map(right.map((entry) => [entry.name, entry]));
  const seen = new Set();
  const rows = [];
  for (const entry of left) {
    seen.add(entry.name);
    const other = rightByName.get(entry.name);
    if (other === undefined) {
      rows.push({ name: entry.name, status: 'removed', before: entry, after: null });
      continue;
    }
    const changed = entry.action !== other.action || entry.hash !== other.hash || entry.bytes !== other.bytes;
    rows.push({ name: entry.name, status: changed ? 'changed' : 'same', before: entry, after: other });
  }
  for (const entry of right) {
    if (seen.has(entry.name)) continue;
    rows.push({ name: entry.name, status: 'added', before: null, after: entry });
  }
  return rows;
}

/** Count the rows of a snapshot diff by status. */
export function countStatuses(rows) {
  const counts = { total: 0, changed: 0, added: 0, removed: 0, same: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    counts.total += 1;
    if (Object.hasOwn(counts, row.status)) counts[row.status] += 1;
  }
  return counts;
}

/**
 * Choose the section a line-level diff should describe.
 *
 * Explicit wins; then the two versions' own section when they name the same
 * one; then the single differing section. Anything else is ambiguous and says
 * so instead of picking arbitrarily.
 * @param rows - the snapshot diff rows.
 * @param options - `{focusName, fromName, toName}`.
 * @returns `{name, reason}`; `name` is null when no section is unambiguous.
 */
export function focusSection(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const explicit = options.focusName ?? null;
  if (explicit !== null) {
    const row = list.find((entry) => entry.name === explicit);
    if (row === undefined) {
      return { name: null, reason: `no section named ${JSON.stringify(explicit)} differs between these two versions` };
    }
    return { name: explicit, reason: null };
  }
  if (options.fromName !== null && options.fromName !== undefined && options.fromName === options.toName) {
    return { name: options.fromName, reason: null };
  }
  const differing = list.filter((row) => row.status !== 'same');
  if (differing.length === 1) return { name: differing[0].name, reason: null };
  if (differing.length === 0) {
    // Nothing differs section by section, but the caller may still want the
    // text of the section one side is about — a no-op rewrite is a real case.
    const own = ownNameOf(list, options);
    if (own !== null) return { name: own, reason: null };
    return { name: null, reason: 'the two versions are identical' };
  }
  const own = ownNameOf(list, options);
  if (own !== null) return { name: own, reason: null };
  return { name: null, reason: 'more than one section differs; pass ?name= to compare one of them' };
}

/**
 * The section one of the two sides is about, when it is present in the rows.
 * @param rows - the snapshot diff rows.
 * @param options - `{fromName, toName}`.
 * @returns the name, or null.
 */
function ownNameOf(rows, options) {
  for (const candidate of [options.fromName, options.toName]) {
    if (candidate === null || candidate === undefined) continue;
    if (rows.some((row) => row.name === candidate)) return candidate;
  }
  return null;
}

/**
 * Assemble the whole diff response body.
 *
 * A *side* is `{kind, label, layer, session, id, at, action, name, snapshot,
 * texts}` where `texts` maps a section name to that side's text for it. A
 * history side carries one entry (its own section); a `current` side carries
 * the layer's live values.
 * @param input - `{from, to, focusName?}`.
 * @returns the response payload (without `ok`).
 */
export function buildDiff({ from, to, focusName = null }) {
  const sections = diffSnapshots(from.snapshot, to.snapshot);
  const counts = countStatuses(sections);
  const focus = focusSection(sections, {
    focusName,
    fromName: from.name,
    toName: to.name,
  });
  const describe = (side) => ({
    kind: side.kind,
    label: side.label,
    layer: side.layer,
    session: side.session ?? null,
    id: side.id ?? null,
    seq: side.seq ?? null,
    at: side.at ?? null,
    action: side.action ?? null,
    name: side.name ?? null,
  });

  let lines = null;
  let lineReason = focus.reason;
  if (focus.name !== null) {
    const beforeText = Object.hasOwn(from.texts ?? {}, focus.name) ? from.texts[focus.name] : null;
    const afterText = Object.hasOwn(to.texts ?? {}, focus.name) ? to.texts[focus.name] : null;
    if (beforeText === null && afterText === null) {
      lineReason = 'neither version holds text for this section';
    } else {
      const diff = diffLines(beforeText, afterText);
      // The two texts travel with the ops so a renderer that diffs by itself
      // (the primitives `DiffBlock`) does not have to fetch or re-derive them.
      // Each side is bounded by the 200 KiB per-override cap.
      lines = {
        name: focus.name,
        ...diff,
        textBefore: beforeText,
        textAfter: afterText,
      };
      lineReason = null;
    }
  }

  return {
    scope: 'layer',
    from: describe(from),
    to: describe(to),
    sections,
    sectionsCounts: counts,
    lines,
    lineReason,
    stats: {
      added: counts.added,
      removed: counts.removed,
      changed: counts.changed,
      same: counts.same,
      lineAdded: lines === null ? 0 : lines.stats.added,
      lineRemoved: lines === null ? 0 : lines.stats.removed,
    },
  };
}

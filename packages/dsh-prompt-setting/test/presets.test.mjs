/**
 * Preset-library assertions (g-060, `CONTRACT.md` Revision 37).
 *
 * Two layers of evidence, like the other feature suites:
 * - the pure half (`core/presets.js`, `core/store.js`) is driven directly, with
 *   no Host at all;
 * - the route half runs through a fake Host that reproduces the parts of the
 *   real `systemPrompt` service this feature touches (a live `section()`
 *   registration, an outermost-first waterfall, `assemble()` reading the
 *   registered definitions), so `GET /presets`, `PUT`, `DELETE`, `apply` and
 *   `unapply` are exercised without a `dsh web` restart.
 *
 * The negative cases hash the presets file around every refusal: "rejected"
 * must mean "byte-identical", not merely "answered 4xx".
 *
 * Run: `node --test test/presets.test.mjs`
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { apply } from '../index.js';
import { CUSTOM_SECTION_NAME } from '../core/custom.js';
import { MAX_TEXT_BYTES, RESERVED_STACK_SEPARATOR } from '../core/overrides.js';
import {
  MAX_PRESET_NAME_LENGTH,
  emptyPresets,
  normalizePresets,
  planApply,
  planUnapply,
  presetById,
  publicApplied,
  publicPresets,
  removePreset,
  upsertPreset,
  validatePresetId,
  validatePresetInput,
} from '../core/presets.js';
import { readPresets, userPresetsPath, writePresets } from '../core/store.js';

const PRESETS_PATH = '/prompt-setting/presets';
const PRESETS_APPLY_PATH = '/prompt-setting/presets/apply';
const PRESETS_UNAPPLY_PATH = '/prompt-setting/presets/unapply';
const SNAPSHOT_PATH = '/prompt-setting/snapshot';
const OVERRIDES_PATH = '/prompt-setting/overrides';

/** Two ids that satisfy the documented shape, used where the Host would mint one. */
const PRESET_A = 'preset-aaaaaaaa';
const PRESET_B = 'preset-bbbbbbbb';

/** The sections a fresh fake Host registers, in registration order. */
const DEFAULT_SECTIONS = [
  { name: 'harness:identity', order: -1000, text: 'You are an AI agent.' },
  { name: 'project:alpha', order: 1000, text: 'ALPHA BODY' },
];

let home;
let workspaceRoot;
let otherRoot;
let previousHome;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-prompt-setting-presets-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'dsh-prompt-setting-ws-'));
  otherRoot = mkdtempSync(join(tmpdir(), 'dsh-prompt-setting-ws2-'));
  previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(otherRoot, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
});

/** The library path for the current temp `DSH_HOME`. */
function presetsPath() {
  return userPresetsPath();
}

/** A workspace layer's config path. */
function layerPath(root) {
  return join(root, '.dsh-prompt-setting', 'overrides.json');
}

/** SHA-256 of a file, or `missing` — the byte-identity currency. */
function sha256(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'missing';
}

/** Write a raw file, creating its directory. */
function writeRaw(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** A minimal Node response double. */
function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    end(chunk) {
      this.body = chunk === undefined || chunk === null ? '' : String(chunk);
    },
  };
}

/** A minimal Node request double. */
function makeRequest({ method = 'GET', url = PRESETS_PATH, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  return {
    method,
    url,
    headers: {},
    destroy() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** Parse a response body. */
function json(res) {
  return JSON.parse(res.body);
}

/**
 * Mount the plugin against a fake Host.
 *
 * Only what this feature needs: one `webServer.register` slot, a
 * `workspaceRegistry` that maps session ids to roots, and a `systemPrompt` whose
 * `assemble()` runs the registered waterfall so `GET /snapshot` really reflects
 * what the layers resolve to.
 * @param options.workspaces - `list()` rows for the fake registry.
 * @returns `{route, unmount}`.
 */
function mount(options = {}) {
  const workspaces = options.workspaces ?? [];
  const registered = DEFAULT_SECTIONS.map((section) => ({ ...section }));
  const listeners = [];
  const routes = [];
  const cleanups = [];
  const registry = workspaces.length === 0 ? undefined : { list: () => workspaces };

  const systemPrompt = {
    section(definition) {
      registered.push(definition);
      return () => {
        const at = registered.indexOf(definition);
        if (at >= 0) registered.splice(at, 1);
      };
    },
    async assemble(context = {}) {
      const sorted = [...registered].sort(
        (left, right) => left.order - right.order || (left.name < right.name ? -1 : 1),
      );
      const assembly = {
        sections: sorted.map((section) => ({
          name: section.name,
          text: typeof section.text === 'function' ? section.text(context) : section.text,
          ...(section.interpolate === undefined ? {} : { interpolate: section.interpolate }),
        })),
        contexts: [],
        tools: [],
        variables: {},
      };
      const queue = listeners.map((listener) => listener.callback);
      const inner = () => Promise.resolve(assembly);
      const next = () => {
        const callback = queue.shift() ?? inner;
        return callback(assembly, context, next);
      };
      return next();
    },
  };

  const ctx = {
    connection: { requestRejection: () => undefined },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    systemPrompt,
    get(name) {
      if (name === 'workspaceRegistry') return registry;
      return undefined;
    },
    on(name, callback, listenerOptions) {
      const listener = { name, callback, options: listenerOptions };
      if (listenerOptions?.prepend === true) listeners.unshift(listener);
      else listeners.push(listener);
      return () => {};
    },
    effect(factory) {
      const disposer = factory();
      cleanups.push(disposer);
      return disposer;
    },
  };
  apply(ctx, {});
  return {
    route: routes[0],
    unmount() {
      for (const disposer of cleanups.splice(0).reverse()) disposer();
    },
  };
}

/** Call the prefix route with a request double. */
async function call(route, options = {}) {
  const res = makeResponse();
  await route.handler(makeRequest(options), res);
  return res;
}

/** One workspace row whose session id is `session`. */
function workspaceRow(root, session) {
  return { path: root, sessionIds: [session] };
}

/** A library file written straight to disk, so a route test can start from it. */
function seedLibrary(presets = [], applied = []) {
  writeRaw(presetsPath(), `${JSON.stringify({ version: 1, presets, applied }, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// The pure half
// ---------------------------------------------------------------------------

test('presets: the library lives in its own file under the user directory', () => {
  assert.equal(presetsPath(), join(home, 'prompt-setting', 'presets.json'));
  assert.equal(emptyPresets().version, 1);
  assert.deepEqual(emptyPresets().presets, []);
  assert.deepEqual(emptyPresets().applied, []);
});

test('presets store: a missing file is an empty library, a malformed one is reported', () => {
  const missing = readPresets(presetsPath());
  assert.equal(missing.missing, true);
  assert.equal(missing.error, null);
  assert.deepEqual(missing.document, emptyPresets());

  writeRaw(presetsPath(), '{not json');
  const broken = readPresets(presetsPath());
  assert.equal(broken.error.code, 'invalid-json');
  assert.deepEqual(broken.document, emptyPresets());

  writeRaw(presetsPath(), JSON.stringify({ version: 99, presets: [] }));
  const version = readPresets(presetsPath());
  assert.equal(version.error.code, 'unsupported-presets-version');

  writeRaw(presetsPath(), JSON.stringify([1, 2, 3]));
  assert.equal(readPresets(presetsPath()).error.code, 'invalid-presets');
});

test('presets store: write/read round-trips one document byte for byte', () => {
  const document = upsertPreset(emptyPresets(), { name: '短答', action: 'replace', text: 'Be brief.' }, {
    id: PRESET_A,
    at: '2024-01-01T00:00:00.000Z',
  }).document;
  const written = writePresets(presetsPath(), document);
  assert.deepEqual(written, document);
  const back = readPresets(presetsPath());
  assert.equal(back.error, null);
  assert.deepEqual(back.document, document);
  // The file ends with a newline and is pretty-printed, like every other file
  // this plugin owns.
  assert.ok(readFileSync(presetsPath(), 'utf8').endsWith('\n'));
});

test('presets logic: validatePresetInput refuses every field-level mistake with a code', () => {
  const cases = [
    [null, 'invalid-preset'],
    [[], 'invalid-preset'],
    [{ action: 'replace', text: 'x' }, 'invalid-name'],
    [{ name: '   ', action: 'replace', text: 'x' }, 'invalid-name'],
    [{ name: 'a'.repeat(MAX_PRESET_NAME_LENGTH + 1), action: 'replace', text: 'x' }, 'name-too-long'],
    [{ name: 'a\u0007b', action: 'replace', text: 'x' }, 'invalid-name'],
    [{ name: 'n', text: 'x' }, 'unsupported-action'],
    [{ name: 'n', action: 'hide', text: 'x' }, 'unsupported-action'],
    [{ name: 'n', action: 'replace' }, 'missing-text'],
    [{ name: 'n', action: 'replace', text: 42 }, 'missing-text'],
    [{ name: 'n', action: 'append', text: 'x'.repeat(MAX_TEXT_BYTES + 1) }, 'text-too-large'],
  ];
  for (const [input, code] of cases) {
    assert.throws(() => validatePresetInput(input), (error) => error.code === code, `expected ${code}`);
  }
  assert.deepEqual(validatePresetInput({ name: 'n', action: 'append', text: '' }), {
    name: 'n',
    action: 'append',
    text: '',
  });
  assert.equal(validatePresetId(PRESET_A), PRESET_A);
  assert.throws(() => validatePresetId('../etc/passwd'), (error) => error.code === 'invalid-id');
  assert.throws(() => validatePresetId('a'.repeat(65)), (error) => error.code === 'invalid-id');
});

test('presets logic: normalizePresets drops unusable entries and de-duplicates applied roots', () => {
  const normalized = normalizePresets({
    version: 1,
    presets: [
      { id: PRESET_A, name: 'ok', action: 'replace', text: 'A' },
      { id: 'bad id!', name: 'nope', action: 'replace', text: 'A' },
      { id: PRESET_B, name: 'nope', action: 'hide', text: 'A' },
      { id: PRESET_A, name: 'duplicate', action: 'replace', text: 'B' },
      'not an object',
    ],
    applied: [
      { workspaceRoot: '/w', presetId: PRESET_A, before: null, appliedAt: 't1' },
      { workspaceRoot: '/w', presetId: PRESET_B, before: { action: 'replace', text: 'old' }, appliedAt: 't2' },
      { workspaceRoot: '/other', presetId: PRESET_A, before: { action: 'nope', text: 'x' }, appliedAt: 't3' },
    ],
  });
  assert.equal(normalized.presets.length, 1);
  assert.equal(normalized.presets[0].name, 'ok');
  assert.equal(normalized.applied.length, 1);
  assert.equal(normalized.applied[0].presetId, PRESET_B);
  assert.deepEqual(normalized.applied[0].before, { action: 'replace', text: 'old' });
});

test('presets logic: upsert inserts with a Host id, edits in place, and refuses an unknown id', () => {
  const created = upsertPreset(emptyPresets(), { name: '一', action: 'replace', text: 'A' }, {
    id: PRESET_A,
    at: '2024-01-01T00:00:00.000Z',
  });
  assert.equal(created.created, true);
  assert.equal(created.preset.createdAt, '2024-01-01T00:00:00.000Z');
  assert.equal(created.preset.updatedAt, '2024-01-01T00:00:00.000Z');

  const edited = upsertPreset(created.document, { id: PRESET_A, name: '二', action: 'append', text: 'B' }, {
    at: '2024-02-02T00:00:00.000Z',
  });
  assert.equal(edited.created, false);
  assert.equal(edited.preset.createdAt, '2024-01-01T00:00:00.000Z');
  assert.equal(edited.preset.updatedAt, '2024-02-02T00:00:00.000Z');
  assert.equal(edited.document.presets.length, 1);
  assert.equal(presetById(edited.document, PRESET_A).name, '二');

  assert.throws(
    () => upsertPreset(edited.document, { id: PRESET_B, name: 'x', action: 'replace', text: 'x' }, { at: 't' }),
    (error) => error.code === 'preset-not-found' && error.status === 404,
  );
  const removed = removePreset(edited.document, PRESET_A);
  assert.equal(removed.removed.id, PRESET_A);
  assert.equal(removed.document.presets.length, 0);
  // Removing an id that is not there is a no-op the caller reports as 404.
  assert.equal(removePreset(removed.document, PRESET_A).removed, null);
});

test('presets logic: planApply replaces in replace mode and truly stacks in append mode', () => {
  const appendDoc = upsertPreset(emptyPresets(), { name: 'p', action: 'append', text: 'PRESET TEXT' }, {
    id: PRESET_A,
    at: 't0',
  }).document;
  const replaceDoc = upsertPreset(emptyPresets(), { name: 'p', action: 'replace', text: 'PRESET TEXT' }, {
    id: PRESET_A,
    at: 't0',
  }).document;
  const empty = { version: 1, overrides: [] };
  // An empty layer contributes no separator: append is just the text.
  const onEmpty = planApply(appendDoc, { presetId: PRESET_A, workspaceRoot: '/w', current: empty, at: 't1' });
  assert.equal(onEmpty.before, null);
  assert.equal(onEmpty.alreadyApplied, false);
  assert.deepEqual(onEmpty.config.overrides, [{ name: CUSTOM_SECTION_NAME, action: 'append', text: 'PRESET TEXT' }]);

  const current = {
    version: 1,
    interpolateCustom: true,
    overrides: [
      { name: 'frozen:one', action: 'replace', text: 'keep me' },
      { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
    ],
  };
  // Revision 39: append keeps what the layer holds and stacks the preset after
  // it, joined by the very separator the cross-layer stack uses.
  const stacked = planApply(appendDoc, { presetId: PRESET_A, workspaceRoot: '/w', current, at: 't2' });
  assert.deepEqual(stacked.before, { action: 'replace', text: 'MINE' });
  assert.equal(stacked.alreadyApplied, false);
  assert.equal(stacked.text, `MINE${RESERVED_STACK_SEPARATOR}PRESET TEXT`);
  assert.equal(stacked.config.interpolateCustom, true);
  assert.deepEqual(stacked.config.overrides[0], { name: 'frozen:one', action: 'replace', text: 'keep me' });
  assert.deepEqual(stacked.config.overrides[1], {
    name: CUSTOM_SECTION_NAME,
    action: 'append',
    text: `MINE${RESERVED_STACK_SEPARATOR}PRESET TEXT`,
  });
  // One record per root: the second application replaces the first.
  assert.equal(stacked.document.applied.length, 1);

  // replace still replaces, and still records the pair.
  const replaced = planApply(replaceDoc, { presetId: PRESET_A, workspaceRoot: '/w', current, at: 't3' });
  assert.equal(replaced.alreadyApplied, false);
  assert.deepEqual(replaced.config.overrides[1], { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'PRESET TEXT' });
  assert.deepEqual(replaced.before, { action: 'replace', text: 'MINE' });

  assert.throws(
    () => planApply(replaceDoc, { presetId: 'nope', workspaceRoot: '/w', current, at: 't4' }),
    (error) => error.code === 'preset-not-found' && error.status === 404,
  );
});

test('presets logic: an idempotent application changes nothing at all', () => {
  const appendDoc = upsertPreset(emptyPresets(), { name: 'p', action: 'append', text: 'PRESET TEXT' }, {
    id: PRESET_A,
    at: 't0',
  }).document;
  const stackedText = `MINE${RESERVED_STACK_SEPARATOR}PRESET TEXT`;
  const stacked = {
    version: 1,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'append', text: stackedText }],
  };

  // The layer already carries the stack and a record exists: the document and
  // the record come back **exactly as they were** (review R5 — the snapshot is
  // what「取消应用」restores, so a second click may not overwrite it).
  const withRecord = {
    version: 1,
    presets: appendDoc.presets,
    applied: [{ workspaceRoot: '/w', presetId: PRESET_A, before: null, appliedAt: 'first' }],
  };
  const again = planApply(withRecord, { presetId: PRESET_A, workspaceRoot: '/w', current: stacked, at: 't1' });
  assert.equal(again.alreadyApplied, true);
  assert.equal(again.text, stackedText);
  assert.deepEqual(again.document, withRecord, 'the document is returned unchanged');
  assert.equal(again.record, withRecord.applied[0], 'and the record is the first application’s');

  // The layer already carries the text but has no record: nothing to restore, so
  // no record is invented and the document is untouched.
  const noRecord = { version: 1, presets: appendDoc.presets, applied: [] };
  const none = planApply(noRecord, {
    presetId: PRESET_A,
    workspaceRoot: '/w',
    current: { version: 1, overrides: [{ name: CUSTOM_SECTION_NAME, action: 'append', text: 'PRESET TEXT' }] },
    at: 't2',
  });
  assert.equal(none.alreadyApplied, true);
  assert.equal(none.record, null, 'no change to restore ⇒ no record');
  assert.deepEqual(none.document, noRecord);

  // replace is idempotent on the same rule.
  const replaceDoc = upsertPreset(emptyPresets(), { name: 'p', action: 'replace', text: 'PRESET TEXT' }, {
    id: PRESET_B,
    at: 't0',
  }).document;
  const replaceRecord = {
    version: 1,
    presets: replaceDoc.presets,
    applied: [
      { workspaceRoot: '/w', presetId: PRESET_B, before: { action: 'replace', text: 'OLD' }, appliedAt: 'first' },
    ],
  };
  const same = planApply(replaceRecord, {
    presetId: PRESET_B,
    workspaceRoot: '/w',
    current: { version: 1, overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'PRESET TEXT' }] },
    at: 't3',
  });
  assert.equal(same.alreadyApplied, true);
  assert.deepEqual(same.document, replaceRecord);
  assert.equal(same.record, replaceRecord.applied[0]);

  // …but the same text stored under the other mode is still a real change: the
  // mode is part of what gets written.
  const modeChange = planApply(replaceRecord, {
    presetId: PRESET_B,
    workspaceRoot: '/w',
    current: { version: 1, overrides: [{ name: CUSTOM_SECTION_NAME, action: 'append', text: 'PRESET TEXT' }] },
    at: 't4',
  });
  assert.equal(modeChange.alreadyApplied, false);
  assert.notEqual(modeChange.document, replaceRecord);
  assert.equal(modeChange.config.overrides[0].action, 'replace');
});

test('presets logic: planUnapply restores the snapshot, or removes the entry when there was none', () => {
  const withRecord = {
    version: 1,
    presets: [],
    applied: [{ workspaceRoot: '/w', presetId: PRESET_A, before: { action: 'replace', text: 'MINE' }, appliedAt: 't' }],
  };
  const current = {
    version: 1,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'append', text: 'PRESET TEXT' }],
  };
  const restored = planUnapply(withRecord, { workspaceRoot: '/w', current });
  assert.equal(restored.restored, true);
  assert.deepEqual(restored.config.overrides, [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' }]);
  assert.equal(restored.document.applied.length, 0);

  // A snapshot whose action was `append` is restored with that action, not
  // flattened to `replace` (Revision 39: the mode is part of the content).
  const appendRecord = {
    version: 1,
    presets: [],
    applied: [{ workspaceRoot: '/w', presetId: PRESET_A, before: { action: 'append', text: 'ORIGINAL' }, appliedAt: 't' }],
  };
  const appendBack = planUnapply(appendRecord, { workspaceRoot: '/w', current });
  assert.deepEqual(appendBack.config.overrides, [{ name: CUSTOM_SECTION_NAME, action: 'append', text: 'ORIGINAL' }]);

  const withoutEntry = {
    version: 1,
    presets: [],
    applied: [{ workspaceRoot: '/w', presetId: PRESET_A, before: null, appliedAt: 't' }],
  };
  const removed = planUnapply(withoutEntry, { workspaceRoot: '/w', current });
  assert.equal(removed.restored, false);
  assert.deepEqual(removed.config.overrides, []);

  assert.throws(
    () => planUnapply({ version: 1, presets: [], applied: [] }, { workspaceRoot: '/w', current }),
    (error) => error.code === 'not-applied' && error.status === 404,
  );
});

test('presets logic: a deleted preset becomes an orphan record with its snapshot intact', () => {
  const document = upsertPreset(emptyPresets(), { name: 'p', action: 'replace', text: 'A' }, {
    id: PRESET_A,
    at: 't0',
  }).document;
  const applied = planApply(document, {
    presetId: PRESET_A,
    workspaceRoot: '/w',
    current: { version: 1, overrides: [] },
    at: 't1',
  }).document;
  const after = removePreset(applied, PRESET_A).document;
  assert.deepEqual(publicPresets(after), []);
  const [record] = publicApplied(after);
  assert.equal(record.orphan, true);
  assert.equal(record.presetName, null);
  assert.equal(record.presetId, PRESET_A);
  assert.equal(record.before, null);
});

// ---------------------------------------------------------------------------
// The route half
// ---------------------------------------------------------------------------

test('route: GET /presets answers an empty library and the resolved workspace root', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1')] });
  const empty = json(await call(route, { url: PRESETS_PATH }));
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.presets, []);
  assert.deepEqual(empty.applied, []);
  assert.equal(empty.error, null);
  assert.equal(empty.path, presetsPath());

  const scoped = json(await call(route, { url: `${PRESETS_PATH}?session=s-1` }));
  assert.equal(scoped.workspaceRoot, workspaceRoot);
  const unscoped = json(await call(route, { url: `${PRESETS_PATH}?session=nope` }));
  assert.equal(unscoped.workspaceRoot, null);
  assert.equal(unscoped.ok, true);
});

test('route: PUT /presets creates, edits and persists one preset', async () => {
  const { route } = mount();
  const created = json(await call(route, {
    method: 'PUT',
    url: PRESETS_PATH,
    body: JSON.stringify({ name: '短答', action: 'replace', text: 'Be brief.' }),
  }));
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.preset.name, '短答');
  assert.equal(created.preset.action, 'replace');
  assert.match(created.preset.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  assert.equal(created.presets.length, 1);

  const edited = json(await call(route, {
    method: 'PUT',
    url: PRESETS_PATH,
    body: JSON.stringify({ id: created.preset.id, name: '更短', action: 'append', text: 'Terse.' }),
  }));
  assert.equal(edited.created, false);
  assert.equal(edited.preset.id, created.preset.id);
  assert.equal(edited.preset.createdAt, created.preset.createdAt);
  assert.equal(edited.preset.updatedAt, edited.preset.createdAt === null ? null : edited.preset.updatedAt);
  assert.ok(edited.preset.updatedAt >= edited.preset.createdAt);

  // Re-read the file, not the answer: the library really persisted.
  const onDisk = readPresets(presetsPath());
  assert.equal(onDisk.error, null);
  assert.equal(onDisk.document.presets.length, 1);
  assert.equal(onDisk.document.presets[0].name, '更短');
  assert.equal(onDisk.document.presets[0].action, 'append');
  const listed = json(await call(route, { url: PRESETS_PATH }));
  assert.equal(listed.presets[0].text, 'Terse.');
});

test('route: PUT /presets refuses bad input with 400/404 and never touches the file', async () => {
  const { route } = mount();
  seedLibrary([{ id: PRESET_A, name: 'keep', action: 'replace', text: 'KEEP', createdAt: 't', updatedAt: 't' }]);
  const before = sha256(presetsPath());
  const bodies = [
    [JSON.stringify({ action: 'replace', text: 'x' }), 400, 'invalid-name'],
    [JSON.stringify({ name: '  ', action: 'replace', text: 'x' }), 400, 'invalid-name'],
    [JSON.stringify({ name: 'n', action: 'hide', text: 'x' }), 400, 'unsupported-action'],
    [JSON.stringify({ name: 'n', action: 'replace' }), 400, 'missing-text'],
    [JSON.stringify({ name: 'n', action: 'replace', text: 'x'.repeat(MAX_TEXT_BYTES + 1) }), 400, 'text-too-large'],
    [JSON.stringify({ id: 'nope-0000', name: 'n', action: 'replace', text: 'x' }), 404, 'preset-not-found'],
    [JSON.stringify({ id: 'bad id!', name: 'n', action: 'replace', text: 'x' }), 400, 'invalid-id'],
    ['not json', 400, 'invalid-json'],
  ];
  for (const [body, status, code] of bodies) {
    const res = await call(route, { method: 'PUT', url: PRESETS_PATH, body });
    assert.equal(res.statusCode, status, `${code}: status`);
    assert.equal(json(res).code, code);
    assert.equal(sha256(presetsPath()), before, `${code}: the library is byte-identical`);
  }
  // A library file this revision cannot read is a 409, and is left alone too.
  writeRaw(presetsPath(), '{broken');
  const brokenBefore = sha256(presetsPath());
  const refused = await call(route, {
    method: 'PUT',
    url: PRESETS_PATH,
    body: JSON.stringify({ name: 'n', action: 'replace', text: 'x' }),
  });
  assert.equal(refused.statusCode, 409);
  assert.equal(json(refused).code, 'presets-not-writable');
  assert.equal(sha256(presetsPath()), brokenBefore);
  // The read face still answers 200 with the reason beside an empty library.
  const read = json(await call(route, { url: PRESETS_PATH }));
  assert.equal(read.ok, true);
  assert.equal(read.error.code, 'invalid-json');
});

test('route: DELETE /presets?id= removes one preset, and refuses unknown or missing ids untouched', async () => {
  const { route } = mount();
  seedLibrary([
    { id: PRESET_A, name: 'a', action: 'replace', text: 'A', createdAt: 't', updatedAt: 't' },
    { id: PRESET_B, name: 'b', action: 'append', text: 'B', createdAt: 't', updatedAt: 't' },
  ]);
  const missing = await call(route, { method: 'DELETE', url: PRESETS_PATH });
  assert.equal(missing.statusCode, 400);
  assert.equal(json(missing).code, 'missing-id');

  const before = sha256(presetsPath());
  const unknown = await call(route, { method: 'DELETE', url: `${PRESETS_PATH}?id=${'nope-0000'}` });
  assert.equal(unknown.statusCode, 404);
  assert.equal(json(unknown).code, 'preset-not-found');
  assert.equal(sha256(presetsPath()), before);

  const removed = json(await call(route, { method: 'DELETE', url: `${PRESETS_PATH}?id=${PRESET_A}` }));
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.equal(removed.id, PRESET_A);
  assert.deepEqual(removed.presets.map((preset) => preset.id), [PRESET_B]);
});

test('route: POST /presets/apply writes the reserved section and /snapshot renders it', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1')] });
  seedLibrary([{ id: PRESET_A, name: 'a', action: 'replace', text: 'PRESET TEXT', createdAt: 't', updatedAt: 't' }]);

  const applied = json(await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A, session: 's-1' }),
  }));
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.equal(applied.workspaceRoot, workspaceRoot);
  assert.equal(applied.before, null);
  assert.deepEqual(applied.after, { action: 'replace', text: 'PRESET TEXT' });

  // The workspace layer on disk holds the preset, and the assembly renders it.
  const layer = JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8'));
  assert.deepEqual(layer.overrides, [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'PRESET TEXT' }]);
  const snapshot = json(await call(route, { url: `${SNAPSHOT_PATH}?session=s-1` }));
  assert.ok(snapshot.rendered.includes('PRESET TEXT'), 'the assembly renders the applied preset');
  const section = snapshot.effective.sections.find((entry) => entry.name === CUSTOM_SECTION_NAME);
  assert.equal(section.text, 'PRESET TEXT');

  // The library recorded the pair, with the snapshot it took.
  const listed = json(await call(route, { url: PRESETS_PATH }));
  assert.equal(listed.applied.length, 1);
  assert.equal(listed.applied[0].presetId, PRESET_A);
  assert.equal(listed.applied[0].orphan, false);
  assert.equal(listed.applied[0].before, null);

  // Negative: an unknown preset and an unresolvable session are refused with no
  // write at all.
  const layerBefore = sha256(layerPath(workspaceRoot));
  const unknown = await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: 'nope-0000', session: 's-1' }),
  });
  assert.equal(unknown.statusCode, 404);
  assert.equal(json(unknown).code, 'preset-not-found');
  assert.equal(sha256(layerPath(workspaceRoot)), layerBefore);

  const noSession = await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A }),
  });
  assert.equal(noSession.statusCode, 400);
  assert.equal(json(noSession).code, 'workspace-unresolved');
  assert.equal(sha256(layerPath(workspaceRoot)), layerBefore);

  const noPresetId = await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ session: 's-1' }),
  });
  assert.equal(noPresetId.statusCode, 400);
  assert.equal(json(noPresetId).code, 'missing-preset-id');
  assert.equal(sha256(layerPath(workspaceRoot)), layerBefore);
});

test('route: POST /presets/unapply restores the exact pre-application content', async () => {
  const { route } = mount({
    workspaces: [workspaceRow(workspaceRoot, 's-1'), workspaceRow(otherRoot, 's-2')],
  });
  // A workspace that already had text, a switch and a frozen entry.
  const original = {
    version: 1,
    interpolateCustom: true,
    overrides: [
      { name: 'frozen:one', action: 'replace', text: 'KEEP' },
      { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
    ],
  };
  writeRaw(layerPath(workspaceRoot), `${JSON.stringify(original, null, 2)}\n`);
  writeRaw(layerPath(otherRoot), `${JSON.stringify({ version: 1, overrides: [] }, null, 2)}\n`);
  const userBefore = sha256(join(home, 'prompt-setting', 'overrides.json'));
  const otherBefore = sha256(layerPath(otherRoot));

  seedLibrary([
    { id: PRESET_A, name: 'a', action: 'append', text: 'PRESET TEXT', createdAt: 't', updatedAt: 't' },
  ]);
  const applied = json(await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A, session: 's-1' }),
  }));
  assert.deepEqual(applied.before, { action: 'replace', text: 'MINE' });
  assert.deepEqual(applied.record.before, { action: 'replace', text: 'MINE' });
  // Revision 39: the append preset is stacked after what the layer held.
  assert.deepEqual(applied.after, {
    action: 'append',
    text: `MINE${RESERVED_STACK_SEPARATOR}PRESET TEXT`,
  });

  const unapplied = json(await call(route, {
    method: 'POST',
    url: PRESETS_UNAPPLY_PATH,
    body: JSON.stringify({ session: 's-1' }),
  }));
  assert.equal(unapplied.ok, true);
  assert.equal(unapplied.unapplied, true);
  assert.equal(unapplied.restored, true);
  assert.equal(unapplied.presetId, PRESET_A);
  assert.deepEqual(unapplied.after, { action: 'replace', text: 'MINE' });
  // The layer is back to the content it had before the application — the same
  // JSON value (key order is the layer writer's, exactly as every other write),
  // and nothing else moved a byte.
  assert.deepEqual(JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8')), original);
  assert.equal(sha256(layerPath(otherRoot)), otherBefore);
  assert.equal(sha256(join(home, 'prompt-setting', 'overrides.json')), userBefore);
  assert.equal(json(await call(route, { url: PRESETS_PATH })).applied.length, 0);

  // A second unapply has nothing to restore: 404, still nothing written.
  const again = await call(route, {
    method: 'POST',
    url: PRESETS_UNAPPLY_PATH,
    body: JSON.stringify({ session: 's-1' }),
  });
  assert.equal(again.statusCode, 404);
  assert.equal(json(again).code, 'not-applied');
  assert.equal(sha256(layerPath(otherRoot)), otherBefore);
});

test('route: unapply removes an entry that did not exist before, and leaves other layers alone', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1')] });
  seedLibrary([{ id: PRESET_A, name: 'a', action: 'replace', text: 'PRESET', createdAt: 't', updatedAt: 't' }]);
  await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A, session: 's-1' }),
  });
  assert.deepEqual(
    JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8')).overrides.map((entry) => entry.name),
    [CUSTOM_SECTION_NAME],
  );
  const unapplied = json(await call(route, {
    method: 'POST',
    url: PRESETS_UNAPPLY_PATH,
    body: JSON.stringify({ session: 's-1' }),
  }));
  assert.equal(unapplied.restored, false);
  // No reserved entry any more — the layer had none before the application.
  assert.deepEqual(JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8')).overrides, []);
  const snapshot = json(await call(route, { url: `${SNAPSHOT_PATH}?session=s-1` }));
  assert.equal(snapshot.rendered.includes('PRESET'), false);
});

test('route: deleting an applied preset keeps the layer and flags the record orphan', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1')] });
  seedLibrary([{ id: PRESET_A, name: 'a', action: 'replace', text: 'PRESET', createdAt: 't', updatedAt: 't' }]);
  await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A, session: 's-1' }),
  });
  const layerAfterApply = sha256(layerPath(workspaceRoot));

  const deleted = json(await call(route, { method: 'DELETE', url: `${PRESETS_PATH}?id=${PRESET_A}` }));
  assert.equal(deleted.ok, true);
  assert.equal(deleted.orphaned, 1);
  assert.equal(sha256(layerPath(workspaceRoot)), layerAfterApply, 'deleting a preset never rewrites a layer');

  const listed = json(await call(route, { url: PRESETS_PATH }));
  assert.equal(listed.applied.length, 1);
  assert.equal(listed.applied[0].orphan, true);
  assert.equal(listed.applied[0].presetName, null);

  // And「取消应用」still restores the snapshot of an orphan record.
  const unapplied = json(await call(route, {
    method: 'POST',
    url: PRESETS_UNAPPLY_PATH,
    body: JSON.stringify({ session: 's-1' }),
  }));
  assert.equal(unapplied.ok, true);
  assert.equal(unapplied.presetId, PRESET_A);
  assert.deepEqual(JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8')).overrides, []);
});

test('route: the preset routes answer 405 with the documented allow list', async () => {
  const { route } = mount();
  const cases = [
    [PRESETS_PATH, 'POST', 'GET, PUT, DELETE'],
    [PRESETS_APPLY_PATH, 'GET', 'POST'],
    [PRESETS_APPLY_PATH, 'PUT', 'POST'],
    [PRESETS_UNAPPLY_PATH, 'GET', 'POST'],
    [PRESETS_UNAPPLY_PATH, 'DELETE', 'POST'],
  ];
  for (const [url, method, allow] of cases) {
    const res = await call(route, { method, url });
    assert.equal(res.statusCode, 405, `${method} ${url}`);
    assert.equal(res.headers.allow, allow, `${method} ${url}`);
    assert.equal(res.body, '');
  }
});

test('route: apply → apply again → unapply still restores the original layer', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1')] });
  seedLibrary([{ id: PRESET_A, name: 'a', action: 'append', text: 'STACKED', createdAt: 't', updatedAt: 't' }]);

  // Path 1 — the layer had no reserved entry at all.
  writeRaw(layerPath(workspaceRoot), `${JSON.stringify({ version: 1, overrides: [] }, null, 2)}\n`);
  const first = json(await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A, session: 's-1' }),
  }));
  assert.equal(first.alreadyApplied, false);
  assert.equal(first.before, null);
  const libraryAfterFirst = sha256(presetsPath());
  assert.deepEqual(readPresets(presetsPath()).document.applied[0].before, null, 'the snapshot is “there was none”');

  // The idempotent second click: no layer write, no history record, and the
  // library file is not written either (review R5).
  const second = json(await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A, session: 's-1' }),
  }));
  assert.equal(second.alreadyApplied, true);
  assert.equal(second.history, null);
  assert.equal(second.record.before, null, 'the answer reports the first snapshot');
  assert.equal(sha256(presetsPath()), libraryAfterFirst, 'presets.json is byte-identical');
  assert.deepEqual(readPresets(presetsPath()).document.applied[0].before, null, 'and the stored snapshot is unchanged');

  // …so「取消应用」really goes back: the entry that was not there disappears.
  const unapplied = json(await call(route, {
    method: 'POST',
    url: PRESETS_UNAPPLY_PATH,
    body: JSON.stringify({ session: 's-1' }),
  }));
  assert.equal(unapplied.restored, false);
  assert.deepEqual(
    JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8')),
    { version: 1, overrides: [] },
    'the layer is back to the state before the first application',
  );

  // Path 2 — the layer held text of its own.
  const original = {
    version: 1,
    overrides: [
      { name: 'frozen:one', action: 'replace', text: 'KEEP' },
      { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
    ],
  };
  writeRaw(layerPath(workspaceRoot), `${JSON.stringify(original, null, 2)}\n`);
  await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A, session: 's-1' }),
  });
  const stackedLayer = JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8'));
  assert.equal(
    stackedLayer.overrides[1].text,
    `MINE${RESERVED_STACK_SEPARATOR}STACKED`,
    'append stacked the preset after the layer’s own text',
  );
  const libraryAfterStack = sha256(presetsPath());
  const repeat = json(await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A, session: 's-1' }),
  }));
  assert.equal(repeat.alreadyApplied, true);
  assert.equal(sha256(presetsPath()), libraryAfterStack);
  assert.deepEqual(
    readPresets(presetsPath()).document.applied[0].before,
    { action: 'replace', text: 'MINE' },
    'the snapshot is still the text that was there before the first application',
  );
  const back = json(await call(route, {
    method: 'POST',
    url: PRESETS_UNAPPLY_PATH,
    body: JSON.stringify({ session: 's-1' }),
  }));
  assert.equal(back.restored, true);
  assert.deepEqual(
    JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8')),
    original,
    'and the layer is exactly what it was before the first application',
  );
});

test('route: /presets is not part of the export or the overrides schema', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1')] });
  seedLibrary([{ id: PRESET_A, name: 'a', action: 'replace', text: 'PRESET', createdAt: 't', updatedAt: 't' }]);
  await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A, session: 's-1' }),
  });
  const exported = json(await call(route, { url: '/prompt-setting/export?session=s-1' }));
  // The export document's own frozen shape: adding the library must not have
  // grown it a field. (Compared field by field rather than by substring — the
  // temp workspace paths this suite uses may contain any word at all.)
  assert.deepEqual(Object.keys(exported).sort(), [
    'exportScope',
    'exportedAt',
    'layers',
    'ok',
    'plugin',
    'pluginVersion',
    'schema',
    'version',
  ]);
  for (const view of Object.values(exported.layers)) {
    for (const entry of view.overrides ?? []) {
      assert.deepEqual(Object.keys(entry).sort(), ['action', 'name', 'text']);
    }
  }
  // The workspace layer's own schema is the frozen one: version, overrides, and
  // at most the interpolation switch.
  const layer = JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8'));
  assert.deepEqual(Object.keys(layer).sort(), ['overrides', 'version']);
  const listed = json(await call(route, { url: `${OVERRIDES_PATH}?session=s-1` }));
  for (const entry of listed.workspace.overrides) {
    assert.deepEqual(Object.keys(entry).sort(), ['action', 'name', 'text']);
  }
});

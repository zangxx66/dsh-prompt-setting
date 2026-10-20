/**
 * Preset-library assertions (g-060, `CONTRACT.md` Revision 41).
 *
 * Two layers of evidence, like the other feature suites:
 * - the pure half (`core/presets.js`, `core/store.js`) is driven directly, with
 *   no Host at all;
 * - the route half runs through a fake Host that reproduces the parts of the
 *   real `systemPrompt` service this feature touches (a live `section()`
 *   registration, an outermost-first waterfall, `assemble()` reading the
 *   registered definitions), so the five preset routes are exercised without a
 *   `dsh web` restart.
 *
 * The model under test (Revision 41) is **one base plus a stack per workspace**:
 * `base` is the reserved entry as it stood before the first application, the
 * stack is every preset applied since (each link keeping the `{action, text}` it
 * wrote), and the layer's text is always their recomposition — which is what
 * makes cancelling a single preset possible without losing the others.
 *
 * The negative cases hash the two files around every refusal: "rejected" must
 * mean "byte-identical", not merely "answered 4xx".
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
  MAX_PRESET_TAGS,
  MAX_TAGS,
  MAX_TAG_NAME_LENGTH,
  appliedRootsOf,
  emptyPresets,
  normalizePresets,
  planApply,
  planPresetRemoval,
  planUnapply,
  presetById,
  presetsWithTag,
  publicApplied,
  publicPresets,
  publicTags,
  removePreset,
  removeTag,
  tagById,
  upsertPreset,
  upsertTag,
  validatePresetId,
  validatePresetInput,
  validatePresetsDocument,
  validateTagInput,
} from '../core/presets.js';
import { historyPath, readHistoryFile, readPresets, userPresetsPath, writePresets } from '../core/store.js';

const PRESETS_PATH = '/prompt-setting/presets';
const PRESETS_TAGS_PATH = '/prompt-setting/presets/tags';
const PRESETS_APPLY_PATH = '/prompt-setting/presets/apply';
const PRESETS_UNAPPLY_PATH = '/prompt-setting/presets/unapply';
const SNAPSHOT_PATH = '/prompt-setting/snapshot';
const OVERRIDES_PATH = '/prompt-setting/overrides';
const ASSEMBLY_STATUS_PATH = '/prompt-setting/assembly-status';

/** Two ids that satisfy the documented shape, used where the Host would mint one. */
const PRESET_A = 'preset-aaaaaaaa';
const PRESET_B = 'preset-bbbbbbbb';

/** The separator one stack link is joined with, spelled out for readability. */
const SEP = RESERVED_STACK_SEPARATOR;

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
      // The assemble waterfall's own listeners only (g-062: the plugin also
      // listens to `agent/pre-step` / `session/event` / `session/disposed`).
      const queue = listeners
        .filter((listener) => listener.name === 'system-prompt/assemble')
        .map((listener) => listener.callback);
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
function seedLibrary(presets = [], applied = [], extras = {}) {
  const document = {
    version: extras.version ?? 2,
    tags: extras.tags ?? [],
    presets,
    applied,
  };
  writeRaw(presetsPath(), `${JSON.stringify(document, null, 2)}\n`);
}

/** A stored preset as the library file spells it. */
function storedPreset(id, name, action, text, tagIds = []) {
  return { id, name, action, text, tagIds, createdAt: 't', updatedAt: 't' };
}

/** A stored tag as the library file spells it (g-082). */
function storedTag(id, name) {
  return { id, name, createdAt: 't', updatedAt: 't' };
}

/** The two tag ids these route cases use. */
const TAG_A = 'tag-aaaaaaaa';
const TAG_B = 'tag-bbbbbbbb';

// ---------------------------------------------------------------------------
// The pure half
// ---------------------------------------------------------------------------

test('presets: the library lives in its own file under the user directory', () => {
  assert.equal(presetsPath(), join(home, 'prompt-setting', 'presets.json'));
  assert.equal(emptyPresets().version, 2);
  assert.deepEqual(emptyPresets().tags, []);
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
  assert.equal(readPresets(presetsPath()).error.code, 'unsupported-presets-version');

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
    tagIds: [],
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
      { workspaceRoot: '/w', base: null, stack: [{ presetId: PRESET_A, appliedAt: 't1' }] },
      {
        workspaceRoot: '/w',
        base: { action: 'replace', text: 'OLD' },
        stack: [
          { presetId: PRESET_B, appliedAt: 't2' },
          { presetId: 'bad id!', appliedAt: 't3' },
          { presetId: PRESET_A, appliedAt: 't4', action: 'append', text: 'A' },
        ],
      },
      { workspaceRoot: '/other', base: { action: 'nope', text: 'x' }, stack: [] },
    ],
  });
  assert.equal(normalized.presets.length, 1);
  assert.equal(normalized.presets[0].name, 'ok');
  // One record per root, and the later one wins; its unusable link is dropped.
  assert.equal(normalized.applied.length, 1);
  const [record] = normalized.applied;
  assert.equal(record.workspaceRoot, '/w');
  assert.deepEqual(record.base, { action: 'replace', text: 'OLD' });
  assert.deepEqual(record.stack.map((item) => item.presetId), [PRESET_B, PRESET_A]);
  // A link that carried no snapshot takes what the library knows; one whose
  // preset the library no longer has falls back to `append` and no text (there is
  // nothing left to take it from).
  assert.equal(record.stack[0].action, 'append');
  assert.equal(record.stack[0].text, '');
  assert.equal(record.stack[1].text, 'A');
});

test('presets logic: normalizePresets migrates the Revision 37 record shape', () => {
  const migrated = normalizePresets({
    version: 1,
    presets: [{ id: PRESET_A, name: 'a', action: 'append', text: 'FROM LIBRARY' }],
    applied: [
      { workspaceRoot: '/w', presetId: PRESET_A, before: { action: 'replace', text: 'OLD' }, appliedAt: 't1' },
      { workspaceRoot: '/none', presetId: PRESET_B, before: null, appliedAt: 't2' },
    ],
  });
  assert.equal(migrated.applied.length, 2);
  assert.deepEqual(migrated.applied[0], {
    workspaceRoot: '/w',
    base: { action: 'replace', text: 'OLD' },
    stack: [{ presetId: PRESET_A, appliedAt: 't1', action: 'append', text: 'FROM LIBRARY' }],
  });
  // A link whose preset is already gone keeps what the old record held (its
  // action and no text) instead of being dropped.
  assert.deepEqual(migrated.applied[1].stack, [{ presetId: PRESET_B, appliedAt: 't2', action: 'replace', text: '' }]);
  assert.equal(migrated.applied[1].base, null);
});

test('presets logic: upsert inserts with a Host id, edits in place, and refuses an unknown id', () => {
  const created = upsertPreset(emptyPresets(), { name: '一', action: 'replace', text: 'A' }, {
    id: PRESET_A,
    at: '2024-01-01T00:00:00.000Z',
  });
  assert.equal(created.created, true);
  assert.equal(created.preset.createdAt, '2024-01-01T00:00:00.000Z');

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
  assert.equal(removePreset(removed.document, PRESET_A).removed, null);
});

test('presets logic: planApply snapshots a base once and pushes every application onto the stack', () => {
  let document = emptyPresets();
  document = upsertPreset(document, { name: 'one', action: 'append', text: 'ONE' }, { id: PRESET_A, at: 't0' }).document;
  document = upsertPreset(document, { name: 'two', action: 'replace', text: 'TWO' }, { id: PRESET_B, at: 't0' }).document;

  const empty = { version: 1, interpolateCustom: true, overrides: [] };
  const first = planApply(document, { presetId: PRESET_A, workspaceRoot: '/w', current: empty, at: 't1' });
  assert.equal(first.alreadyApplied, false);
  assert.equal(first.base, null, 'an empty layer has no base');
  assert.equal(first.text, 'ONE');
  assert.deepEqual(first.stack.map((item) => item.presetId), [PRESET_A]);
  assert.deepEqual(first.config.overrides, [{ name: CUSTOM_SECTION_NAME, action: 'append', text: 'ONE' }]);
  assert.equal(first.config.interpolateCustom, true, 'the switch is carried across');

  const second = planApply(first.document, {
    presetId: PRESET_B,
    workspaceRoot: '/w',
    current: first.config,
    at: 't2',
  });
  assert.equal(second.base, null, 'the base stays what it was');
  assert.equal(second.text, `ONE${SEP}TWO`, 'links are composed in application order');
  assert.deepEqual(second.stack.map((item) => item.presetId), [PRESET_A, PRESET_B]);
  // The entry's mode follows the newest link.
  assert.equal(second.config.overrides[0].action, 'replace');
  assert.equal(second.document.applied.length, 1, 'one record per workspace root');

  // A layer that already held text snapshots it as the base.
  const current = {
    version: 1,
    overrides: [
      { name: 'frozen:one', action: 'replace', text: 'keep me' },
      { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
    ],
  };
  const onTop = planApply(document, { presetId: PRESET_A, workspaceRoot: '/w', current, at: 't3' });
  assert.deepEqual(onTop.base, { action: 'replace', text: 'MINE' });
  assert.equal(onTop.text, `MINE${SEP}ONE`);
  assert.equal(onTop.config.overrides[0].name, 'frozen:one', 'other entries survive');

  assert.throws(
    () => planApply(document, { presetId: 'nope', workspaceRoot: '/w', current, at: 't4' }),
    (error) => error.code === 'preset-not-found' && error.status === 404,
  );
});

test('presets logic: a preset already on the stack is an idempotent no-op', () => {
  const document = upsertPreset(emptyPresets(), { name: 'one', action: 'append', text: 'ONE' }, {
    id: PRESET_A,
    at: 't0',
  }).document;
  const first = planApply(document, {
    presetId: PRESET_A,
    workspaceRoot: '/w',
    current: { version: 1, overrides: [] },
    at: 't1',
  });
  const again = planApply(first.document, {
    presetId: PRESET_A,
    workspaceRoot: '/w',
    current: first.config,
    at: 't2',
  });
  assert.equal(again.alreadyApplied, true, 'the link is already there');
  assert.deepEqual(again.document, first.document, 'the document is returned unchanged');
  assert.equal(again.record, first.document.applied[0], 'and so is the record');
  assert.deepEqual(again.stack.map((item) => item.presetId), [PRESET_A], 'the stack does not grow');
  assert.equal(again.base, null);
});

test('presets logic: unapply pops one link and keeps the others (Revision 41)', () => {
  let document = emptyPresets();
  document = upsertPreset(document, { name: 'one', action: 'append', text: 'ONE' }, { id: PRESET_A, at: 't0' }).document;
  document = upsertPreset(document, { name: 'two', action: 'replace', text: 'TWO' }, { id: PRESET_B, at: 't0' }).document;
  const original = {
    version: 1,
    interpolateCustom: true,
    overrides: [
      { name: 'frozen:one', action: 'replace', text: 'KEEP' },
      { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
    ],
  };
  const first = planApply(document, { presetId: PRESET_A, workspaceRoot: '/w', current: original, at: 't1' });
  const second = planApply(first.document, {
    presetId: PRESET_B,
    workspaceRoot: '/w',
    current: first.config,
    at: 't2',
  });
  assert.equal(second.text, `MINE${SEP}ONE${SEP}TWO`);

  // Cancelling the *first* preset keeps the second — the reported defect.
  const dropFirst = planUnapply(second.document, { workspaceRoot: '/w', presetId: PRESET_A, current: second.config });
  assert.equal(dropFirst.removed.presetId, PRESET_A);
  assert.deepEqual(dropFirst.stack.map((item) => item.presetId), [PRESET_B]);
  assert.deepEqual(dropFirst.base, { action: 'replace', text: 'MINE' }, 'the base never moves');
  assert.equal(
    dropFirst.config.overrides[1].text,
    `MINE${SEP}TWO`,
    'the remaining link is still composed on the base',
  );
  assert.equal(dropFirst.restored, false, 'one link shorter is not “back to the base”');
  assert.equal(dropFirst.config.interpolateCustom, true);

  // Cancelling the last one restores the base itself.
  const dropLast = planUnapply(dropFirst.document, {
    workspaceRoot: '/w',
    presetId: PRESET_B,
    current: dropFirst.config,
  });
  assert.deepEqual(dropLast.stack, [], 'the stack is empty');
  assert.equal(dropLast.restored, true);
  assert.deepEqual(dropLast.config.overrides, original.overrides, 'the layer is the base again');
  assert.equal(dropLast.document.applied.length, 0, 'and the record is gone');
});

test('presets logic: unapply removes the entry when the base was “there was none”', () => {
  const document = upsertPreset(emptyPresets(), { name: 'one', action: 'append', text: 'ONE' }, {
    id: PRESET_A,
    at: 't0',
  }).document;
  const first = planApply(document, {
    presetId: PRESET_A,
    workspaceRoot: '/w',
    current: { version: 1, interpolateCustom: false, overrides: [] },
    at: 't1',
  });
  const back = planUnapply(first.document, { workspaceRoot: '/w', presetId: PRESET_A, current: first.config });
  assert.equal(back.restored, false);
  assert.deepEqual(back.stack, []);
  assert.deepEqual(back.config.overrides, [], 'the entry that was not there is gone again');
  assert.equal(back.config.interpolateCustom, false, 'the switch is left exactly as it was');
});

test('presets logic: unapply refuses a preset that is not on the stack', () => {
  const document = upsertPreset(emptyPresets(), { name: 'one', action: 'append', text: 'ONE' }, {
    id: PRESET_A,
    at: 't0',
  }).document;
  const current = { version: 1, overrides: [] };
  assert.throws(
    () => planUnapply(document, { workspaceRoot: '/w', presetId: PRESET_A, current }),
    (error) => error.code === 'not-applied' && error.status === 404,
  );
  const applied = planApply(document, { presetId: PRESET_A, workspaceRoot: '/w', current, at: 't1' });
  assert.throws(
    () => planUnapply(applied.document, { workspaceRoot: '/w', presetId: PRESET_B, current: applied.config }),
    (error) => error.code === 'not-applied' && error.status === 404,
  );
});

test('presets logic: a deleted preset keeps composing and cancelling as an orphan link', () => {
  let document = emptyPresets();
  document = upsertPreset(document, { name: 'one', action: 'append', text: 'ONE' }, { id: PRESET_A, at: 't0' }).document;
  document = upsertPreset(document, { name: 'two', action: 'replace', text: 'TWO' }, { id: PRESET_B, at: 't0' }).document;
  const first = planApply(document, {
    presetId: PRESET_A,
    workspaceRoot: '/w',
    current: { version: 1, overrides: [] },
    at: 't1',
  });
  const second = planApply(first.document, {
    presetId: PRESET_B,
    workspaceRoot: '/w',
    current: first.config,
    at: 't2',
  });
  const after = removePreset(second.document, PRESET_A).document;
  const [record] = publicApplied(after);
  assert.deepEqual(record.stack.map((item) => [item.presetId, item.presetName, item.orphan]), [
    [PRESET_A, null, true],
    [PRESET_B, 'two', false],
  ]);
  // The link's own snapshot is what keeps the composition (and the cancel) right.
  const drop = planUnapply(after, { workspaceRoot: '/w', presetId: PRESET_A, current: second.config });
  assert.equal(drop.config.overrides[0].text, 'TWO');
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
  assert.match(created.preset.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

  const edited = json(await call(route, {
    method: 'PUT',
    url: PRESETS_PATH,
    body: JSON.stringify({ id: created.preset.id, name: '更短', action: 'append', text: 'Terse.' }),
  }));
  assert.equal(edited.created, false);
  assert.equal(edited.preset.id, created.preset.id);
  assert.equal(edited.preset.createdAt, created.preset.createdAt);

  const onDisk = readPresets(presetsPath());
  assert.equal(onDisk.error, null);
  assert.equal(onDisk.document.presets.length, 1);
  assert.equal(onDisk.document.presets[0].name, '更短');
  const listed = json(await call(route, { url: PRESETS_PATH }));
  assert.equal(listed.presets[0].text, 'Terse.');
});

test('route: PUT /presets refuses bad input with 400/404 and never touches the file', async () => {
  const { route } = mount();
  seedLibrary([storedPreset(PRESET_A, 'keep', 'replace', 'KEEP')]);
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
  const read = json(await call(route, { url: PRESETS_PATH }));
  assert.equal(read.ok, true);
  assert.equal(read.error.code, 'invalid-json');
});

test('route: DELETE /presets?id= removes one preset, and refuses unknown or missing ids untouched', async () => {
  const { route } = mount();
  seedLibrary([storedPreset(PRESET_A, 'a', 'replace', 'A'), storedPreset(PRESET_B, 'b', 'append', 'B')]);
  const missing = await call(route, { method: 'DELETE', url: PRESETS_PATH });
  assert.equal(missing.statusCode, 400);
  assert.equal(json(missing).code, 'missing-id');

  const before = sha256(presetsPath());
  const unknown = await call(route, { method: 'DELETE', url: `${PRESETS_PATH}?id=nope-0000` });
  assert.equal(unknown.statusCode, 404);
  assert.equal(json(unknown).code, 'preset-not-found');
  assert.equal(sha256(presetsPath()), before);

  const removed = json(await call(route, { method: 'DELETE', url: `${PRESETS_PATH}?id=${PRESET_A}` }));
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.presets.map((preset) => preset.id), [PRESET_B]);
});

test('route: POST /presets/apply composes the layer and /snapshot renders it', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1')] });
  seedLibrary([storedPreset(PRESET_A, 'a', 'replace', 'PRESET TEXT')]);

  const applied = json(await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A, session: 's-1' }),
  }));
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.equal(applied.alreadyApplied, false);
  assert.equal(applied.base, null);
  assert.deepEqual(applied.after, { action: 'replace', text: 'PRESET TEXT' });
  assert.deepEqual(applied.stack.map((item) => item.presetId), [PRESET_A]);
  assert.equal(applied.record.base, null);

  const layer = JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8'));
  assert.deepEqual(layer.overrides, [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'PRESET TEXT' }]);
  const snapshot = json(await call(route, { url: `${SNAPSHOT_PATH}?session=s-1` }));
  assert.ok(snapshot.rendered.includes('PRESET TEXT'), 'the assembly renders the applied preset');

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

test('route: applying a preset twice is idempotent and writes no file at all', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1')] });
  seedLibrary([storedPreset(PRESET_A, 'a', 'append', 'STACKED')]);
  writeRaw(layerPath(workspaceRoot), `${JSON.stringify({ version: 1, overrides: [] }, null, 2)}\n`);

  const first = json(await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A, session: 's-1' }),
  }));
  assert.equal(first.alreadyApplied, false);
  const layerAfterFirst = sha256(layerPath(workspaceRoot));
  const libraryAfterFirst = sha256(presetsPath());

  const second = json(await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A, session: 's-1' }),
  }));
  assert.equal(second.alreadyApplied, true);
  assert.equal(second.history, null);
  assert.deepEqual(second.stack.map((item) => item.presetId), [PRESET_A]);
  assert.equal(sha256(layerPath(workspaceRoot)), layerAfterFirst, 'the layer is byte-identical');
  assert.equal(sha256(presetsPath()), libraryAfterFirst, 'and so is the library');
});

test('route: apply → apply another → unapply one keeps the other, unapply both returns the base', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1')] });
  seedLibrary([storedPreset(PRESET_A, 'one', 'append', 'ONE'), storedPreset(PRESET_B, 'two', 'replace', 'TWO')]);
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
  const second = json(await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_B, session: 's-1' }),
  }));
  assert.deepEqual(second.base, { action: 'replace', text: 'MINE' });
  assert.equal(second.after.text, `MINE${SEP}ONE${SEP}TWO`);
  assert.deepEqual(readPresets(presetsPath()).document.applied[0].base, { action: 'replace', text: 'MINE' });

  // Cancelling the first link keeps the second: the reported defect.
  const dropFirst = json(await call(route, {
    method: 'POST',
    url: PRESETS_UNAPPLY_PATH,
    body: JSON.stringify({ session: 's-1', presetId: PRESET_A }),
  }));
  assert.equal(dropFirst.ok, true);
  assert.equal(dropFirst.unapplied, true);
  assert.equal(dropFirst.presetId, PRESET_A);
  assert.equal(dropFirst.restored, false);
  assert.deepEqual(dropFirst.stack.map((item) => item.presetId), [PRESET_B]);
  assert.equal(
    JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8')).overrides[1].text,
    `MINE${SEP}TWO`,
    'the remaining preset is still composed on the base',
  );

  // Cancelling the last one returns the layer to the base — byte for byte.
  const dropLast = json(await call(route, {
    method: 'POST',
    url: PRESETS_UNAPPLY_PATH,
    body: JSON.stringify({ session: 's-1', presetId: PRESET_B }),
  }));
  assert.equal(dropLast.restored, true);
  assert.deepEqual(dropLast.stack, []);
  assert.deepEqual(JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8')), original);
  assert.equal(readPresets(presetsPath()).document.applied.length, 0);

  // The same chain on a layer that never had an entry.
  writeRaw(layerPath(workspaceRoot), `${JSON.stringify({ version: 1, overrides: [] }, null, 2)}\n`);
  await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A, session: 's-1' }),
  });
  await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_B, session: 's-1' }),
  });
  const gone = json(await call(route, {
    method: 'POST',
    url: PRESETS_UNAPPLY_PATH,
    body: JSON.stringify({ session: 's-1', presetId: PRESET_B }),
  }));
  assert.equal(gone.restored, false);
  assert.deepEqual(
    JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8')).overrides.map((entry) => entry.name),
    [CUSTOM_SECTION_NAME],
  );
  await call(route, {
    method: 'POST',
    url: PRESETS_UNAPPLY_PATH,
    body: JSON.stringify({ session: 's-1', presetId: PRESET_A }),
  });
  assert.deepEqual(JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8')).overrides, []);
});

test('route: unapply without a presetId is 400, and a preset that is not applied is 404', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1')] });
  seedLibrary([storedPreset(PRESET_A, 'one', 'append', 'ONE'), storedPreset(PRESET_B, 'two', 'replace', 'TWO')]);
  writeRaw(layerPath(workspaceRoot), `${JSON.stringify({ version: 1, overrides: [] }, null, 2)}\n`);
  await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A, session: 's-1' }),
  });
  const layerBefore = sha256(layerPath(workspaceRoot));
  const libraryBefore = sha256(presetsPath());

  const missing = await call(route, {
    method: 'POST',
    url: PRESETS_UNAPPLY_PATH,
    body: JSON.stringify({ session: 's-1' }),
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(json(missing).code, 'missing-preset-id');
  assert.equal(sha256(layerPath(workspaceRoot)), layerBefore);
  assert.equal(sha256(presetsPath()), libraryBefore);

  const notOnStack = await call(route, {
    method: 'POST',
    url: PRESETS_UNAPPLY_PATH,
    body: JSON.stringify({ session: 's-1', presetId: PRESET_B }),
  });
  assert.equal(notOnStack.statusCode, 404);
  assert.equal(json(notOnStack).code, 'not-applied');
  assert.equal(sha256(layerPath(workspaceRoot)), layerBefore, 'both files stay byte-identical');
  assert.equal(sha256(presetsPath()), libraryBefore);

  const malformed = await call(route, {
    method: 'POST',
    url: PRESETS_UNAPPLY_PATH,
    body: JSON.stringify({ session: 's-1', presetId: 'bad id!' }),
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(json(malformed).code, 'invalid-id');
  assert.equal(sha256(layerPath(workspaceRoot)), layerBefore);
});

test('route: deleting an applied preset cancels it everywhere and restores every layer (Revision 50)', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1'), workspaceRow(otherRoot, 's-2')] });
  seedLibrary([storedPreset(PRESET_A, 'a', 'replace', 'PRESET')]);
  // Two different bases, so「back to the base」cannot be satisfied by writing an
  // empty layer: the first held an entry, the second also carries another entry
  // and its own interpolation switch (both must survive untouched).
  const baseOne = { version: 1, overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' }] };
  const baseTwo = {
    version: 1,
    interpolateCustom: false,
    overrides: [
      { name: 'frozen:one', action: 'replace', text: 'KEEP' },
      { name: CUSTOM_SECTION_NAME, action: 'append', text: 'OTHER' },
    ],
  };
  writeRaw(layerPath(workspaceRoot), `${JSON.stringify(baseOne, null, 2)}\n`);
  writeRaw(layerPath(otherRoot), `${JSON.stringify(baseTwo, null, 2)}\n`);
  for (const session of ['s-1', 's-2']) {
    const applied = json(await call(route, {
      method: 'POST',
      url: PRESETS_APPLY_PATH,
      body: JSON.stringify({ presetId: PRESET_A, session }),
    }));
    assert.equal(applied.applied, true);
  }
  const writesAfterApply = json(await call(route, { url: ASSEMBLY_STATUS_PATH })).counts.writes;

  const deleted = json(await call(route, { method: 'DELETE', url: `${PRESETS_PATH}?id=${PRESET_A}` }));
  assert.equal(deleted.ok, true);
  assert.equal(deleted.removed, true);
  assert.equal(deleted.restoredWorkspaces, 2, 'both workspaces were restored');
  assert.equal(deleted.links, 2, 'one stack link each');
  assert.deepEqual(
    deleted.workspaces.map((entry) => [entry.workspaceRoot, entry.links, entry.restored]),
    [[workspaceRoot, 1, true], [otherRoot, 1, true]],
  );
  assert.deepEqual(
    JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8')),
    baseOne,
    'the first layer is back to the base it held before the application',
  );
  assert.deepEqual(
    JSON.parse(readFileSync(layerPath(otherRoot), 'utf8')),
    baseTwo,
    '…and so is the second, its other entry and its switch included',
  );
  assert.deepEqual(readPresets(presetsPath()).document.applied, [], 'no orphan link survives the deletion');
  const listed = json(await call(route, { url: PRESETS_PATH }));
  assert.deepEqual(listed.applied, [], 'and the read face says the same');

  // g-062's registration is reached exactly as the `unapply` route reaches it:
  // one prompt-write note per restored workspace, and one history record.
  const writes = json(await call(route, { url: ASSEMBLY_STATUS_PATH })).counts.writes;
  assert.equal(writes, writesAfterApply + 2, 'one prompt-change note per restored workspace');
  const record = readHistoryFile(historyPath(layerPath(workspaceRoot)));
  assert.equal(record.records.length, 2, 'the apply and the restore');
  const last = record.records[record.records.length - 1];
  assert.equal(last.note, `delete preset ${PRESET_A}`);
  assert.equal(last.origin, 'ui');
  assert.equal(last.name, CUSTOM_SECTION_NAME);
  assert.equal(last.action, 'replace', 'the base write is a replace');
  assert.equal(last.after.text, 'MINE', 'and the record states what the layer went back to');
});

test('route: deleting a preset that nothing applied writes no layer at all (Revision 50)', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1')] });
  seedLibrary([storedPreset(PRESET_A, 'a', 'replace', 'A'), storedPreset(PRESET_B, 'b', 'append', 'B')]);
  writeRaw(layerPath(workspaceRoot), `${JSON.stringify({ version: 1, overrides: [] }, null, 2)}\n`);
  const layerBefore = sha256(layerPath(workspaceRoot));
  const libraryBefore = sha256(presetsPath());
  const writesBefore = json(await call(route, { url: ASSEMBLY_STATUS_PATH })).counts.writes;

  const removed = json(await call(route, { method: 'DELETE', url: `${PRESETS_PATH}?id=${PRESET_A}` }));
  assert.equal(removed.ok, true);
  assert.equal(removed.restoredWorkspaces, 0, 'nothing was applied, so nothing was restored');
  assert.equal(removed.links, 0);
  assert.deepEqual(removed.workspaces, []);
  // The assertion Revision 49 made for the applied case, kept in the case where
  // it is still true: with no application to cancel, the deletion never opens a
  // workspace layer.
  assert.equal(sha256(layerPath(workspaceRoot)), layerBefore, 'deleting an unapplied preset never rewrites a layer');
  assert.notEqual(sha256(presetsPath()), libraryBefore, 'the library itself did change');
  assert.equal(
    json(await call(route, { url: ASSEMBLY_STATUS_PATH })).counts.writes,
    writesBefore,
    'and no prompt-change note was taken',
  );
});

test('route: deleting one preset of a stack keeps the presets that remain (Revision 50)', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1')] });
  seedLibrary([storedPreset(PRESET_A, 'one', 'append', 'ONE'), storedPreset(PRESET_B, 'two', 'append', 'TWO')]);
  writeRaw(layerPath(workspaceRoot), `${JSON.stringify({
    version: 1,
    overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' }],
  }, null, 2)}\n`);
  for (const presetId of [PRESET_A, PRESET_B]) {
    await call(route, {
      method: 'POST',
      url: PRESETS_APPLY_PATH,
      body: JSON.stringify({ presetId, session: 's-1' }),
    });
  }

  const deleted = json(await call(route, { method: 'DELETE', url: `${PRESETS_PATH}?id=${PRESET_A}` }));
  assert.equal(deleted.restoredWorkspaces, 1);
  assert.equal(deleted.links, 1);
  assert.deepEqual(deleted.workspaces, [{ workspaceRoot, links: 1, restored: false, missing: false }]);
  assert.equal(
    JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8')).overrides[0].text,
    `MINE${SEP}TWO`,
    'the remaining preset is still composed on the base',
  );
  const kept = readPresets(presetsPath()).document.applied[0].stack;
  assert.deepEqual(kept.map((link) => link.presetId), [PRESET_B], 'only the deleted preset left the stack');

  // …and the link that stayed is the ordinary, cancellable kind: the workspace
  // is back to its base only when the second application is cancelled too.
  const unapplied = json(await call(route, {
    method: 'POST',
    url: PRESETS_UNAPPLY_PATH,
    body: JSON.stringify({ session: 's-1', presetId: PRESET_B }),
  }));
  assert.equal(unapplied.restored, true);
  assert.deepEqual(
    JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8')).overrides,
    [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' }],
  );
});

test('route: a workspace that cannot be restored refuses the whole deletion, preset included (Revision 50)', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1'), workspaceRow(otherRoot, 's-2')] });
  seedLibrary(
    [storedPreset(PRESET_A, 'a', 'replace', 'PRESET')],
    [
      { workspaceRoot, base: null, stack: [{ presetId: PRESET_A, appliedAt: 't', action: 'replace', text: 'PRESET' }] },
      { workspaceRoot: otherRoot, base: null, stack: [{ presetId: PRESET_A, appliedAt: 't', action: 'replace', text: 'PRESET' }] },
    ],
  );
  // The negative control: one of the two layers is unusable, so its restore can
  // never be planned. The other one is perfectly fine — and must stay untouched.
  writeRaw(layerPath(workspaceRoot), '{broken');
  writeRaw(layerPath(otherRoot), `${JSON.stringify({ version: 1, overrides: [] }, null, 2)}\n`);
  const libraryBefore = sha256(presetsPath());
  const otherBefore = sha256(layerPath(otherRoot));

  const refused = await call(route, { method: 'DELETE', url: `${PRESETS_PATH}?id=${PRESET_A}` });
  assert.equal(json(refused).ok, false);
  assert.equal(json(refused).code, 'preset-unapply-failed');
  assert.equal(refused.statusCode, 409, 'the layer refusal keeps its own status');
  assert.ok(json(refused).message.includes(JSON.stringify(workspaceRoot)), 'the unusable workspace is named');
  // g-069 review B: the refusal names the workspace whose restore really failed —
  // never the ones the read had not reached yet.
  assert.ok(
    json(refused).message.includes(`restoring workspace ${JSON.stringify(workspaceRoot)} failed`),
    'the failing workspace is the one called failed',
  );
  assert.equal(
    json(refused).message.includes(`restoring workspace ${JSON.stringify(otherRoot)} failed`),
    false,
    'the workspace that was never reached is not called a failure',
  );
  assert.ok(json(refused).message.includes('restored: none'), 'nothing was restored');
  assert.ok(json(refused).message.includes('not restored:'), 'and the answer states what was left');
  assert.ok(json(refused).message.includes('was NOT deleted'));
  assert.equal(sha256(presetsPath()), libraryBefore, 'the preset survives a refused deletion');
  assert.equal(sha256(layerPath(otherRoot)), otherBefore, 'and no workspace was rewritten on the way out');
  const listed = json(await call(route, { url: PRESETS_PATH }));
  assert.deepEqual(listed.presets.map((preset) => preset.id), [PRESET_A]);
});

test('route: a workspace whose layer is gone is skipped, and nothing is rebuilt (Revision 50)', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1'), workspaceRow(otherRoot, 's-2')] });
  seedLibrary(
    [storedPreset(PRESET_A, 'a', 'replace', 'PRESET')],
    [
      {
        workspaceRoot,
        base: null,
        stack: [
          { presetId: PRESET_A, appliedAt: 't1', action: 'replace', text: 'PRESET' },
          { presetId: PRESET_A, appliedAt: 't2', action: 'replace', text: 'PRESET' },
        ],
      },
      { workspaceRoot: otherRoot, base: null, stack: [{ presetId: PRESET_A, appliedAt: 't', action: 'replace', text: 'PRESET' }] },
    ],
  );
  // The user deleted that workspace directory, layer and all — but its applied
  // record is still in the library. There is no text to restore there, and the
  // deletion must not invent one (g-069 review A: the ghost root the old code
  // rebuilt through `writeConfig`'s `mkdirSync`).
  rmSync(workspaceRoot, { recursive: true, force: true });
  writeRaw(layerPath(otherRoot), `${JSON.stringify({ version: 1, overrides: [] }, null, 2)}\n`);
  assert.equal(existsSync(workspaceRoot), false);
  const writesBefore = json(await call(route, { url: ASSEMBLY_STATUS_PATH })).counts.writes;

  const deleted = json(await call(route, { method: 'DELETE', url: `${PRESETS_PATH}?id=${PRESET_A}` }));
  assert.equal(deleted.ok, true);
  assert.equal(existsSync(workspaceRoot), false, 'no ghost workspace directory is rebuilt');
  assert.equal(existsSync(layerPath(workspaceRoot)), false, 'and no layer file is invented');
  assert.equal(deleted.restoredWorkspaces, 1, 'only the workspace that really had a layer was restored');
  assert.equal(deleted.links, 3, 'every stack link is cancelled, the gone workspace’s two included');
  const ghost = deleted.workspaces.find((entry) => entry.workspaceRoot === workspaceRoot);
  assert.equal(ghost.missing, true, 'the absent layer is reported as such');
  assert.equal(ghost.restored, false);
  assert.equal(ghost.links, 2);
  const real = deleted.workspaces.find((entry) => entry.workspaceRoot === otherRoot);
  assert.equal(real.missing, false);
  // A workspace with no layer is not a restore, so it takes no prompt-write note.
  assert.equal(
    json(await call(route, { url: ASSEMBLY_STATUS_PATH })).counts.writes,
    writesBefore + 1,
    'one note for the one workspace that was really written',
  );
  // …but its links are gone all the same: the deletion leaves no orphan behind.
  assert.deepEqual(readPresets(presetsPath()).document.applied, []);
  const listed = json(await call(route, { url: PRESETS_PATH }));
  assert.deepEqual(listed.applied, []);
  assert.deepEqual(listed.presets, []);
});

test('presets logic: planPresetRemoval cancels every link of a hand-edited record (Revision 50)', () => {
  const document = {
    version: 1,
    presets: [{ id: PRESET_A, name: 'one', action: 'append', text: 'ONE', createdAt: 't', updatedAt: 't' }],
    // A hand-edited record that names the same preset twice: the deletion must
    // leave no link behind, which takes one pop per occurrence.
    applied: [
      {
        workspaceRoot: '/w',
        base: { action: 'replace', text: 'BASE' },
        stack: [
          { presetId: PRESET_A, appliedAt: 't1', action: 'append', text: 'ONE' },
          { presetId: PRESET_B, appliedAt: 't2', action: 'append', text: 'TWO' },
          { presetId: PRESET_A, appliedAt: 't3', action: 'append', text: 'ONE' },
        ],
      },
      { workspaceRoot: '/other', base: null, stack: [{ presetId: PRESET_B, appliedAt: 't4', action: 'append', text: 'TWO' }] },
    ],
  };
  assert.deepEqual(appliedRootsOf(document, PRESET_A), ['/w']);
  const plan = planPresetRemoval(document, {
    presetId: PRESET_A,
    currentOf: () => ({
      version: 1,
      overrides: [{ name: CUSTOM_SECTION_NAME, action: 'append', text: `BASE${SEP}ONE${SEP}TWO${SEP}ONE` }],
    }),
  });
  assert.equal(plan.removed.id, PRESET_A);
  assert.equal(plan.links, 2, 'both links of the hand-edited record are cancelled');
  assert.deepEqual(plan.document.presets, []);
  const [record] = publicApplied(plan.document);
  assert.deepEqual(record.stack.map((link) => link.presetId), [PRESET_B]);
  assert.equal(record.workspaceRoot, '/w');
  assert.equal(
    plan.plans[0].config.overrides[0].text,
    `BASE${SEP}TWO`,
    'the text is recomposed from the base plus the link that stayed',
  );
  // Nothing applied it: the plan is a catalogue write with no layer at all.
  const untouched = planPresetRemoval(document, { presetId: 'preset-nobody', currentOf: () => {
    throw new Error('no layer must be read for a preset nothing applied');
  } });
  assert.equal(untouched.removed, null);
  assert.deepEqual(untouched.plans, []);

  // g-069 review A: a layer file that is gone (the caller answered `null`) is
  // planned as a cleanup — the links come off, and there is no config to write.
  const ghost = planPresetRemoval(
    {
      version: 1,
      presets: [{ id: PRESET_A, name: 'one', action: 'append', text: 'ONE', createdAt: 't', updatedAt: 't' }],
      applied: [{ workspaceRoot: '/gone', base: null, stack: [{ presetId: PRESET_A, appliedAt: 't', action: 'append', text: 'ONE' }] }],
    },
    { presetId: PRESET_A, currentOf: () => null },
  );
  assert.equal(ghost.links, 1, 'the link is cancelled even though the layer is gone');
  assert.deepEqual(ghost.document.applied, [], 'so the deletion leaves no orphan behind');
  assert.deepEqual(ghost.document.presets, []);
  assert.equal(ghost.plans[0].missing, true);
  assert.equal(ghost.plans[0].config, null, 'nothing to write');
  assert.equal(ghost.plans[0].restored, false);
  assert.equal(ghost.plans[0].before, null);
  assert.equal(ghost.plans[0].after, null);
});


test('route: the preset routes answer 405 with the documented allow list', async () => {
  const { route } = mount();
  const cases = [
    [PRESETS_PATH, 'POST', 'GET, PUT, DELETE'],
    [PRESETS_APPLY_PATH, 'GET', 'POST'],
    [PRESETS_UNAPPLY_PATH, 'DELETE', 'POST'],
  ];
  for (const [url, method, allow] of cases) {
    const res = await call(route, { method, url });
    assert.equal(res.statusCode, 405, `${method} ${url}`);
    assert.equal(res.headers.allow, allow, `${method} ${url}`);
    assert.equal(res.body, '');
  }
});

test('route: the library travels inside the export document, and never inside a layer file', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1')] });
  seedLibrary([storedPreset(PRESET_A, 'a', 'replace', 'PRESET')]);
  await call(route, {
    method: 'POST',
    url: PRESETS_APPLY_PATH,
    body: JSON.stringify({ presetId: PRESET_A, session: 's-1' }),
  });
  const exported = json(await call(route, { url: '/prompt-setting/export?session=s-1' }));
  assert.deepEqual(Object.keys(exported).sort(), [
    'exportScope',
    'exportedAt',
    'layers',
    'ok',
    'plugin',
    'pluginVersion',
    'preferences',
    'presets',
    'schema',
    'version',
    'workspaces',
  ]);
  // Revision 53 (g-074): the catalogue is part of the backup — as its own
  // top-level document, never folded into a layer's `overrides`, so the layer
  // file and the `/overrides` view keep exactly the shape they always had.
  assert.equal(exported.version, 2);
  assert.deepEqual(exported.presets.presets.map((preset) => preset.name), ['a']);
  for (const view of Object.values(exported.layers)) {
    for (const entry of view.overrides ?? []) {
      assert.deepEqual(Object.keys(entry).sort(), ['action', 'name', 'text']);
    }
  }
  const layer = JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8'));
  assert.deepEqual(Object.keys(layer).sort(), ['overrides', 'version']);
  const listed = json(await call(route, { url: `${OVERRIDES_PATH}?session=s-1` }));
  for (const entry of listed.workspace.overrides) {
    assert.deepEqual(Object.keys(entry).sort(), ['action', 'name', 'text']);
  }
});

// ---------------------------------------------------------------------------
// g-082: the tag set (pure half)
// ---------------------------------------------------------------------------

test('presets tags: a version 1 file reads as version 2 with an empty tag set, losslessly', () => {
  const v1 = normalizePresets({
    version: 1,
    presets: [{ id: PRESET_A, name: 'one', action: 'replace', text: 'ONE' }],
    applied: [],
  });
  assert.equal(v1.version, 2);
  assert.deepEqual(v1.tags, []);
  assert.deepEqual(v1.presets[0].tagIds, []);
  // No migration write is needed to read it: the write face re-serializes the
  // same document as version 2, and the round trip is lossless.
  writePresets(presetsPath(), v1);
  const back = readPresets(presetsPath());
  assert.equal(back.error, null);
  assert.deepEqual(back.document, v1);
  assert.equal(JSON.parse(readFileSync(presetsPath(), 'utf8')).version, 2);
});

test('presets tags: normalizePresets keeps known ids in order, and drops the rest leniently', () => {
  const normalized = normalizePresets({
    version: 2,
    tags: [
      storedTag(TAG_A, 'one'),
      storedTag(TAG_B, 'two'),
      { id: 'bad id!', name: 'nope' },
      { id: TAG_A, name: 'duplicate id' },
      { id: 'tag-cccccccc', name: '' },
      'not an object',
    ],
    presets: [
      storedPreset(PRESET_A, 'p', 'replace', 'P', [TAG_B, 'tag-unknown', TAG_A, TAG_B, 'bad id!']),
    ],
    applied: [],
  });
  assert.deepEqual(normalized.tags.map((tag) => [tag.id, tag.name]), [[TAG_A, 'one'], [TAG_B, 'two']]);
  assert.deepEqual(normalized.presets[0].tagIds, [TAG_B, TAG_A]);
  // The public view always states the array, whatever the stored shape was.
  assert.deepEqual(publicTags(normalized).map((tag) => tag.id), [TAG_A, TAG_B]);
  assert.deepEqual(publicPresets(normalized)[0].tagIds, [TAG_B, TAG_A]);
});

test('presets tags: validateTagInput refuses empty/long/control/duplicate names and stores the trim', () => {
  const tags = [storedTag(TAG_A, '短答')];
  assert.deepEqual(validateTagInput({ name: '  代码审查  ' }), { name: '代码审查' });
  const cases = [
    [null, 'invalid-tag'],
    [{}, 'invalid-tag-name'],
    [{ name: '   ' }, 'invalid-tag-name'],
    [{ name: 'a'.repeat(MAX_TAG_NAME_LENGTH + 1) }, 'tag-name-too-long'],
    [{ name: 'a\u0007b' }, 'invalid-tag-name'],
    [{ name: '短答' }, 'duplicate-tag-name'],
    [{ name: '短答 ' }, 'duplicate-tag-name'],
  ];
  for (const [input, code] of cases) {
    assert.throws(() => validateTagInput(input, { tags }), (error) => error.code === code, `expected ${code}`);
  }
  // Editing the tag itself is not a duplicate of itself, and a different tag may
  // take a name only when that tag is the one being excluded.
  assert.deepEqual(validateTagInput({ name: '短答' }, { tags, excludeId: TAG_A }), { name: '短答' });
  assert.throws(
    () => validateTagInput({ name: '短答' }, { tags, excludeId: TAG_B }),
    (error) => error.code === 'duplicate-tag-name',
  );
});

test('presets tags: upsertTag mints, edits in place, keeps createdAt and refuses an unknown id', () => {
  const created = upsertTag(emptyPresets(), { name: '短答' }, { id: TAG_A, at: '2024-01-01T00:00:00.000Z' });
  assert.equal(created.created, true);
  assert.equal(created.tag.createdAt, '2024-01-01T00:00:00.000Z');
  const edited = upsertTag(created.document, { id: TAG_A, name: '更短' }, { at: '2024-02-02T00:00:00.000Z' });
  assert.equal(edited.created, false);
  assert.equal(edited.tag.name, '更短');
  assert.equal(edited.tag.createdAt, '2024-01-01T00:00:00.000Z');
  assert.equal(edited.tag.updatedAt, '2024-02-02T00:00:00.000Z');
  assert.equal(tagById(edited.document, TAG_A).name, '更短');
  assert.throws(
    () => upsertTag(edited.document, { id: TAG_B, name: 'x' }, { at: 't' }),
    (error) => error.code === 'tag-not-found' && error.status === 404,
  );
  // The library's ceiling is creation-only: editing never grows the set.
  let document = emptyPresets();
  for (let index = 0; index < MAX_TAGS; index += 1) {
    document = upsertTag(document, { name: `t${index}` }, { id: `tag-${String(index).padStart(8, '0')}`, at: 't' }).document;
  }
  assert.equal(document.tags.length, MAX_TAGS);
  assert.throws(
    () => upsertTag(document, { name: 'one-more' }, { id: 'tag-deadbeef', at: 't' }),
    (error) => error.code === 'tag-limit-reached' && error.status === 400,
  );
  const renamed = upsertTag(document, { id: document.tags[0].id, name: 'renamed' }, { at: 't' });
  assert.equal(renamed.tag.name, 'renamed');
});

test('presets tags: removeTag cascades through every preset and keeps the other tags', () => {
  const document = {
    version: 2,
    tags: [storedTag(TAG_A, 'one'), storedTag(TAG_B, 'two')],
    presets: [
      storedPreset(PRESET_A, 'a', 'replace', 'A', [TAG_A, TAG_B]),
      storedPreset(PRESET_B, 'b', 'replace', 'B', [TAG_B]),
      storedPreset('preset-cccccccc', 'c', 'replace', 'C'),
    ],
    applied: [],
  };
  const removed = removeTag(document, TAG_A);
  assert.equal(removed.removed.id, TAG_A);
  assert.deepEqual(removed.document.tags.map((tag) => tag.id), [TAG_B]);
  assert.deepEqual(removed.document.presets.map((preset) => preset.tagIds), [[TAG_B], [TAG_B], []]);
  assert.deepEqual(presetsWithTag(removed.document, TAG_A), [], 'no dangling reference survives');
  assert.equal(removeTag(removed.document, TAG_A).removed, null, 'an unknown id changes nothing');
  const untouched = removeTag(removed.document, 'tag-unknown');
  assert.equal(untouched.document, removed.document, 'nothing named, nothing rewritten');
});

test('presets tags: validatePresetsDocument is strict about tags and tagIds', () => {
  const ok = validatePresetsDocument({
    version: 2,
    tags: [storedTag(TAG_A, 'one')],
    presets: [storedPreset(PRESET_A, 'p', 'replace', 'P', [TAG_A])],
    applied: [],
  });
  assert.deepEqual(ok.tags.map((tag) => tag.id), [TAG_A]);
  assert.deepEqual(ok.presets[0].tagIds, [TAG_A]);
  // The old backup (no `tags`, no `tagIds`) imports as an empty tag set.
  const old = validatePresetsDocument({ version: 1, presets: [storedPreset(PRESET_A, 'p', 'replace', 'P')] });
  assert.equal(old.version, 2);
  assert.deepEqual(old.tags, []);
  assert.deepEqual(old.presets[0].tagIds, []);
  const tooManyTags = Array.from({ length: MAX_TAGS + 1 }, (_, index) => storedTag(`tag-${String(index).padStart(8, '0')}`, `t${index}`));
  const tooManyPresetTags = Array.from({ length: MAX_PRESET_TAGS + 1 }, (_, index) => `tag-${String(index).padStart(8, '0')}`);
  const cases = [
    [{ version: 9, presets: [] }, 'unsupported-presets-version'],
    [{ version: 2, tags: 'nope', presets: [] }, 'invalid-presets'],
    [{ version: 2, tags: [{ id: TAG_A, name: 'n', extra: 1 }], presets: [] }, 'invalid-presets'],
    [{ version: 2, tags: [{ id: 'bad id!', name: 'n' }], presets: [] }, 'invalid-tag-id'],
    [{ version: 2, tags: [{ id: TAG_A, name: '  ' }], presets: [] }, 'invalid-tag-name'],
    [{ version: 2, tags: [{ id: TAG_A, name: 'a'.repeat(MAX_TAG_NAME_LENGTH + 1) }], presets: [] }, 'tag-name-too-long'],
    [{ version: 2, tags: [storedTag(TAG_A, 'one'), storedTag(TAG_A, 'two')], presets: [] }, 'duplicate-tag-id'],
    [{ version: 2, tags: [storedTag(TAG_A, 'same'), storedTag(TAG_B, ' same ')], presets: [] }, 'duplicate-tag-name'],
    [{ version: 2, tags: tooManyTags, presets: [] }, 'tag-limit-reached'],
    [{ version: 2, tags: [storedTag(TAG_A, 'one')], presets: [storedPreset(PRESET_A, 'p', 'replace', 'P', [TAG_B])] }, 'unknown-tag'],
    [{ version: 2, tags: [storedTag(TAG_A, 'one')], presets: [storedPreset(PRESET_A, 'p', 'replace', 'P', [TAG_A, TAG_A])] }, 'duplicate-tag-id'],
    [{ version: 2, tags: [storedTag(TAG_A, 'one')], presets: [storedPreset(PRESET_A, 'p', 'replace', 'P', 'nope')] }, 'invalid-tag-ids'],
    [
      {
        version: 2,
        tags: Array.from({ length: MAX_PRESET_TAGS + 1 }, (_, index) => storedTag(`tag-${String(index).padStart(8, '0')}`, `t${index}`)),
        presets: [storedPreset(PRESET_A, 'p', 'replace', 'P', tooManyPresetTags)],
      },
      'too-many-preset-tags',
    ],
  ];
  for (const [document, code] of cases) {
    assert.throws(() => validatePresetsDocument(document), (error) => error.code === code, `expected ${code}`);
  }
});

test('presets tags: validatePresetInput dedupes tagIds, preserves order and refuses unknown ids', () => {
  const tags = [storedTag(TAG_A, 'one'), storedTag(TAG_B, 'two')];
  assert.deepEqual(
    validatePresetInput({ name: 'n', action: 'replace', text: 'x', tagIds: [TAG_B, TAG_B, TAG_A] }, tags),
    { name: 'n', action: 'replace', text: 'x', tagIds: [TAG_B, TAG_A] },
  );
  assert.deepEqual(validatePresetInput({ name: 'n', action: 'replace', text: 'x', tagIds: null }, tags).tagIds, []);
  const cases = [
    [{ name: 'n', action: 'replace', text: 'x', tagIds: 'nope' }, 'invalid-tag-ids'],
    [{ name: 'n', action: 'replace', text: 'x', tagIds: ['bad id!'] }, 'invalid-tag-id'],
    [{ name: 'n', action: 'replace', text: 'x', tagIds: ['tag-unknown'] }, 'unknown-tag'],
    [
      {
        name: 'n',
        action: 'replace',
        text: 'x',
        tagIds: Array.from({ length: MAX_PRESET_TAGS + 1 }, (_, index) => `tag-${String(index).padStart(8, '0')}`),
      },
      'too-many-preset-tags',
    ],
  ];
  const wide = Array.from({ length: MAX_PRESET_TAGS + 1 }, (_, index) => storedTag(`tag-${String(index).padStart(8, '0')}`, `t${index}`));
  for (const [input, code] of cases) {
    assert.throws(() => validatePresetInput(input, wide), (error) => error.code === code, `expected ${code}`);
  }
});

test('presets tags: upsertPreset persists tagIds and an unstated set keeps the stored one', () => {
  const created = upsertPreset(emptyPresets(), { name: 'p', action: 'replace', text: 'P', tagIds: [TAG_A] }, {
    id: PRESET_A,
    at: 't1',
  });
  assert.deepEqual(created.preset.tagIds, [TAG_A]);
  const edited = upsertPreset(created.document, { id: PRESET_A, name: 'p2', action: 'replace', text: 'P2' }, { at: 't2' });
  assert.deepEqual(edited.preset.tagIds, [TAG_A], 'a caller that does not state tags keeps them');
  const cleared = upsertPreset(created.document, { id: PRESET_A, name: 'p3', action: 'replace', text: 'P3', tagIds: [] }, { at: 't3' });
  assert.deepEqual(cleared.preset.tagIds, [], 'stating an empty set really clears it');
  assert.deepEqual(created.document.tags, [], 'and the preset write keeps the document-level tag list');
});

// ---------------------------------------------------------------------------
// g-082: the tag set (route half)
// ---------------------------------------------------------------------------

test('route: GET /presets answers the tag set and every preset’s tagIds', async () => {
  const { route } = mount();
  seedLibrary(
    [storedPreset(PRESET_A, 'a', 'replace', 'A', [TAG_B, TAG_A])],
    [],
    { tags: [storedTag(TAG_A, 'one'), storedTag(TAG_B, 'two')] },
  );
  const listed = json(await call(route, { url: PRESETS_PATH }));
  assert.equal(listed.ok, true);
  assert.equal(listed.version, 2);
  assert.deepEqual(listed.tags.map((tag) => [tag.id, tag.name]), [[TAG_A, 'one'], [TAG_B, 'two']]);
  assert.deepEqual(listed.presets[0].tagIds, [TAG_B, TAG_A], 'the stored order survives');
});

test('route: PUT /presets/tags creates and edits, and every refusal is byte-identical', async () => {
  const { route } = mount();
  seedLibrary([], [], { tags: [storedTag(TAG_A, '短答')] });
  const before = sha256(presetsPath());
  const bodies = [
    [JSON.stringify({ name: '短答' }), 400, 'duplicate-tag-name'],
    [JSON.stringify({ name: '   ' }), 400, 'invalid-tag-name'],
    [JSON.stringify({ name: 'x'.repeat(MAX_TAG_NAME_LENGTH + 1) }), 400, 'tag-name-too-long'],
    [JSON.stringify({ name: 'a\u0007b' }), 400, 'invalid-tag-name'],
    [JSON.stringify({ id: 'tag-unknown', name: 'x' }), 404, 'tag-not-found'],
    [JSON.stringify({ id: 'bad id!', name: 'x' }), 400, 'invalid-tag-id'],
    ['not json', 400, 'invalid-json'],
  ];
  for (const [body, status, code] of bodies) {
    const res = await call(route, { method: 'PUT', url: PRESETS_TAGS_PATH, body });
    assert.equal(res.statusCode, status, `${code}: status`);
    assert.equal(json(res).code, code);
    assert.equal(sha256(presetsPath()), before, `${code}: the library is byte-identical`);
  }
  const created = json(await call(route, {
    method: 'PUT',
    url: PRESETS_TAGS_PATH,
    body: JSON.stringify({ name: '  代码审查  ' }),
  }));
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.tag.name, '代码审查', 'the route stores the trimmed name');
  assert.match(created.tag.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  assert.deepEqual(created.tags.map((tag) => tag.name), ['短答', '代码审查']);

  const edited = json(await call(route, {
    method: 'PUT',
    url: PRESETS_TAGS_PATH,
    body: JSON.stringify({ id: TAG_A, name: '更短' }),
  }));
  assert.equal(edited.created, false);
  assert.equal(edited.tag.id, TAG_A);
  assert.equal(edited.tag.createdAt, 't');
  const onDisk = readPresets(presetsPath());
  assert.equal(onDisk.error, null);
  assert.deepEqual(onDisk.document.tags.map((tag) => tag.name), ['更短', '代码审查']);
});

test('route: PUT /presets accepts tagIds, dedupes them, and rejects an unknown tag untouched', async () => {
  const { route } = mount();
  seedLibrary([], [], { tags: [storedTag(TAG_A, 'one'), storedTag(TAG_B, 'two')] });
  const created = json(await call(route, {
    method: 'PUT',
    url: PRESETS_PATH,
    body: JSON.stringify({ name: 'p', action: 'replace', text: 'P', tagIds: [TAG_B, TAG_B, TAG_A] }),
  }));
  assert.equal(created.ok, true);
  assert.deepEqual(created.preset.tagIds, [TAG_B, TAG_A]);

  const before = sha256(presetsPath());
  const refused = await call(route, {
    method: 'PUT',
    url: PRESETS_PATH,
    body: JSON.stringify({ id: created.preset.id, name: 'p', action: 'replace', text: 'P', tagIds: ['tag-unknown'] }),
  });
  assert.equal(refused.statusCode, 400);
  assert.equal(json(refused).code, 'unknown-tag');
  assert.equal(sha256(presetsPath()), before);

  const cleared = json(await call(route, {
    method: 'PUT',
    url: PRESETS_PATH,
    body: JSON.stringify({ id: created.preset.id, name: 'p', action: 'replace', text: 'P' }),
  }));
  assert.deepEqual(cleared.preset.tagIds, [], 'an omitted set is an empty set (the body is the whole entry)');
});

test('route: DELETE /presets/tags?id= cascades in one write and refuses an unknown id untouched', async () => {
  const { route } = mount();
  seedLibrary(
    [
      storedPreset(PRESET_A, 'a', 'replace', 'A', [TAG_A, TAG_B]),
      storedPreset(PRESET_B, 'b', 'replace', 'B', [TAG_B]),
    ],
    [],
    { tags: [storedTag(TAG_A, 'one'), storedTag(TAG_B, 'two')] },
  );
  const missing = await call(route, { method: 'DELETE', url: PRESETS_TAGS_PATH });
  assert.equal(missing.statusCode, 400);
  assert.equal(json(missing).code, 'missing-id');

  const before = sha256(presetsPath());
  const unknown = await call(route, { method: 'DELETE', url: `${PRESETS_TAGS_PATH}?id=tag-unknown` });
  assert.equal(unknown.statusCode, 404);
  assert.equal(json(unknown).code, 'tag-not-found');
  assert.equal(sha256(presetsPath()), before);

  const removed = json(await call(route, { method: 'DELETE', url: `${PRESETS_TAGS_PATH}?id=${TAG_A}` }));
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.equal(removed.affectedPresets, 1);
  assert.deepEqual(removed.tags.map((tag) => tag.id), [TAG_B]);
  assert.deepEqual(removed.presets.map((preset) => preset.tagIds), [[TAG_B], [TAG_B]]);
  // The bytes on disk agree with the answer: the cascade is the same write.
  const onDisk = readPresets(presetsPath());
  assert.equal(onDisk.error, null);
  assert.deepEqual(onDisk.document.tags.map((tag) => tag.id), [TAG_B]);
  assert.deepEqual(onDisk.document.presets.map((preset) => preset.tagIds), [[TAG_B], [TAG_B]]);
});

test('route: the tag route answers 405 with the documented allow list', async () => {
  const { route } = mount();
  for (const method of ['GET', 'POST']) {
    const res = await call(route, { method, url: PRESETS_TAGS_PATH });
    assert.equal(res.statusCode, 405, `${method}: status`);
    assert.equal(res.headers.allow, 'PUT, DELETE');
    assert.equal(res.body, '');
  }
});

test('route: the full backup carries tags, and an old backup imports an empty tag set', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1')] });
  seedLibrary([storedPreset(PRESET_A, 'a', 'replace', 'A', [TAG_A])], [], { tags: [storedTag(TAG_A, 'one')] });
  const exported = json(await call(route, { url: '/prompt-setting/export?session=s-1' }));
  assert.deepEqual(exported.presets.tags.map((tag) => tag.id), [TAG_A]);
  assert.deepEqual(exported.presets.presets[0].tagIds, [TAG_A]);

  // An old backup (a version 1 preset document with no `tags`) is accepted and
  // written as version 2 with an empty tag set — the import face never invents
  // a tag, and never leaves the old shape on disk.
  const imported = await call(route, {
    method: 'POST',
    url: '/prompt-setting/import',
    body: JSON.stringify({
      schema: 'dsh-prompt-setting/export',
      version: 2,
      layers: { user: { overrides: [] } },
      presets: { version: 1, presets: [storedPreset(PRESET_B, 'b', 'replace', 'B')], applied: [] },
    }),
  });
  assert.equal(imported.statusCode, 200, imported.body);
  const onDisk = readPresets(presetsPath());
  assert.equal(onDisk.error, null);
  assert.equal(onDisk.document.version, 2);
  assert.deepEqual(onDisk.document.tags, []);
  assert.deepEqual(onDisk.document.presets.map((preset) => [preset.id, preset.tagIds]), [[PRESET_B, []]]);
});

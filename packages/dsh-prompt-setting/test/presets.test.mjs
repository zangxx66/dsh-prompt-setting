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
  emptyPresets,
  normalizePresets,
  planApply,
  planUnapply,
  presetById,
  publicApplied,
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
function seedLibrary(presets = [], applied = []) {
  writeRaw(presetsPath(), `${JSON.stringify({ version: 1, presets, applied }, null, 2)}\n`);
}

/** A stored preset as the library file spells it. */
function storedPreset(id, name, action, text) {
  return { id, name, action, text, createdAt: 't', updatedAt: 't' };
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

test('route: deleting an applied preset keeps the layer and flags that link orphan', async () => {
  const { route } = mount({ workspaces: [workspaceRow(workspaceRoot, 's-1')] });
  seedLibrary([storedPreset(PRESET_A, 'a', 'replace', 'PRESET')]);
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
  const [link] = listed.applied[0].stack;
  assert.equal(link.presetId, PRESET_A);
  assert.equal(link.presetName, null);
  assert.equal(link.orphan, true);

  // …and the orphan link still cancels, using its own snapshot.
  const unapplied = json(await call(route, {
    method: 'POST',
    url: PRESETS_UNAPPLY_PATH,
    body: JSON.stringify({ session: 's-1', presetId: PRESET_A }),
  }));
  assert.equal(unapplied.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(layerPath(workspaceRoot), 'utf8')).overrides, []);
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

test('route: /presets is not part of the export or the overrides schema', async () => {
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
    'schema',
    'version',
  ]);
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

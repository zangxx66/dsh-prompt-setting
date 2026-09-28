/**
 * Route assertions for stage 2: history, diff, export, import and the layer
 * reset, driven through the same kind of fake Host `route.test.mjs` uses (the
 * stage 1B routes stay covered there).
 *
 * The load-bearing tests are the atomicity ones: every rejected import is
 * checked with a SHA-256 of the **existing config files**, not merely with a
 * 4xx status, because "the file was not touched" is the actual guarantee.
 *
 * Run: `node --test test/`
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { DEFAULT_HISTORY_LIMIT, MIN_HISTORY_LIMIT } from '../core/history.js';
import { apply } from '../index.js';

const OVERRIDES_PATH = '/prompt-setting/overrides';
const HISTORY_PATH = '/prompt-setting/history';
const DIFF_PATH = '/prompt-setting/diff';
const EXPORT_PATH = '/prompt-setting/export';
const IMPORT_PATH = '/prompt-setting/import';

let home;
let previousHome;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-prompt-setting-stage2-'));
  previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  delete process.env.DSH_PROMPT_SETTING_HISTORY_LIMIT;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  delete process.env.DSH_PROMPT_SETTING_HISTORY_LIMIT;
});

/** Minimal Node response double. */
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

/** Minimal Node request double, body stream included. */
function makeRequest({ method = 'GET', url = HISTORY_PATH, body } = {}) {
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

/**
 * Mount the plugin against a fake Host.
 * @param options - `config`, `workspaces`, `sections`, `omitWorkspaceRegistry`,
 *   `requestRejection`.
 * @returns the captured route and the harness handles.
 */
function mount(options = {}) {
  const routes = [];
  const registry = options.workspaces === undefined
    ? undefined
    : { list: () => options.workspaces };
  const agents = new Map(
    (options.workspaces ?? []).flatMap((workspace) => (workspace.sessionIds ?? []).map((id) => [id, { id }])),
  );
  const ctx = {
    connection: { requestRejection: options.requestRejection ?? (() => undefined) },
    webServer: {
      register(route) {
        routes.push(route);
      },
    },
    systemPrompt: {
      async assemble() {
        return { sections: options.sections ?? [{ name: 'harness:identity', text: 'identity' }], variables: {} };
      },
    },
    get(name) {
      if (name === 'workspaceRegistry') return options.omitWorkspaceRegistry === true ? undefined : registry;
      if (name === 'agents') return { get: (id) => agents.get(id) };
      return undefined;
    },
    on: () => () => {},
    effect: (factory) => factory(),
  };
  apply(ctx, options.config);
  return { ctx, routes, route: routes[0] };
}

/** Call the prefix route. */
async function call(route, options = {}) {
  const res = makeResponse();
  await route.handler(makeRequest(options), res);
  return res;
}

/** Parse a JSON response body. */
function json(res) {
  return JSON.parse(res.body);
}

/** The user layer's config path. */
function userPath() {
  return join(home, 'prompt-setting', 'overrides.json');
}

/** The user layer's history path. */
function userHistoryPath() {
  return join(home, 'prompt-setting', 'history.jsonl');
}

/** Create one workspace directory and return its registry row. */
function workspaceWith(id, sessionId) {
  const root = join(home, id);
  mkdirSync(join(root, '.dsh-prompt-setting'), { recursive: true });
  return { id, path: root, title: id, sessionIds: [sessionId] };
}

/** The workspace layer's config path. */
function workspacePath(id) {
  return join(home, id, '.dsh-prompt-setting', 'overrides.json');
}

/** The workspace layer's history path. */
function workspaceHistoryPath(id) {
  return join(home, id, '.dsh-prompt-setting', 'history.jsonl');
}

/** SHA-256 of a file, or `missing` — the atomicity assertion's only currency. */
function fingerprint(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'missing';
}

/** Fingerprint several files at once. */
function fingerprints(paths) {
  return Object.fromEntries(paths.map((path) => [path, fingerprint(path)]));
}

/** Every leftover temp file under a directory tree. */
function tempFiles(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.tmp')) found.push(path);
    }
  };
  walk(root);
  return found;
}

/** Put one user-layer override. */
function put(route, section, query = '') {
  return call(route, {
    method: 'PUT',
    url: `${OVERRIDES_PATH}${query}`,
    body: JSON.stringify({ layer: 'user', section }),
  });
}

/** Read the user layer's history records. */
async function history(route, query = '') {
  const res = await call(route, { url: `${HISTORY_PATH}?layer=user${query}` });
  assert.equal(res.statusCode, 200);
  return json(res);
}

// #region dispatch

test('stage2: the new routes answer 405 with their own allow list, unchanged for the old ones', async () => {
  const { route } = mount();
  const cases = [
    [{ method: 'POST', url: HISTORY_PATH }, 'GET'],
    [{ method: 'GET', url: DIFF_PATH }, 'GET', 200],
    [{ method: 'POST', url: EXPORT_PATH }, 'GET'],
    [{ method: 'GET', url: IMPORT_PATH }, 'POST'],
  ];
  for (const [request, allow, expected] of cases) {
    const res = await call(route, request);
    if (expected === undefined) {
      assert.equal(res.statusCode, 405, `${request.method} ${request.url}`);
      assert.equal(res.headers.allow, allow);
      assert.equal(res.body, '', 'a 405 has an empty body');
    }
  }
  const import405 = await call(route, { method: 'GET', url: IMPORT_PATH });
  assert.equal(import405.headers.allow, 'POST');
  // The frozen stage 1B table is untouched.
  assert.equal((await call(route, { method: 'POST', url: OVERRIDES_PATH })).headers.allow, 'GET, PUT, DELETE');
  assert.equal((await call(route, { url: '/prompt-setting/nope' })).statusCode, 404);
  assert.equal((await call(route, { url: `${HISTORY_PATH}?layer=nope` })).statusCode, 400);
  assert.equal(json(await call(route, { url: `${HISTORY_PATH}?layer=nope` })).code, 'unknown-layer');
});

test('stage2: the fence runs in front of every new route too', async () => {
  const { route } = mount({ requestRejection: () => 403 });
  for (const request of [
    { url: HISTORY_PATH },
    { url: DIFF_PATH },
    { url: EXPORT_PATH },
    { method: 'POST', url: IMPORT_PATH },
  ]) {
    const res = await call(route, request);
    assert.equal(res.statusCode, 403, `${request.url}`);
    assert.equal(res.body, '');
  }
});

// #endregion

// #region history

test('stage2: a successful PUT and DELETE each append one history record, newest first', async () => {
  const { route } = mount();
  const first = await put(route, { name: 'project:alpha', action: 'replace', text: 'A1' });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(Object.keys(json(first)).sort(), ['effectiveFrom', 'ok', 'saved'], 'the PUT body is still the stage 1B shape');

  await put(route, { name: 'project:alpha', action: 'replace', text: 'A2\nsecond line' });
  const deleted = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&name=project%3Aalpha` });
  assert.deepEqual(Object.keys(json(deleted)).sort(), ['effectiveFrom', 'layer', 'name', 'ok', 'removed'], 'so is the DELETE body');

  const page = await history(route);
  assert.equal(page.total, 3);
  assert.deepEqual(page.records.map((record) => [record.id, record.action, record.name, record.origin]), [
    ['3', 'remove', 'project:alpha', 'ui'],
    ['2', 'replace', 'project:alpha', 'ui'],
    ['1', 'replace', 'project:alpha', 'ui'],
  ]);
  assert.equal(page.retentionLimit, DEFAULT_HISTORY_LIMIT);
  assert.equal(page.corrupt, 0);

  const second = page.records[1];
  assert.equal(second.before.text, 'A1');
  assert.equal(second.after.text, 'A2\nsecond line');
  assert.equal(second.before.bytes, 2);
  assert.equal(second.after.bytes, 14, 'A2 + newline + second line');
  assert.match(second.before.hash, /^[0-9a-f]{64}$/);
  assert.equal(Number.isNaN(Date.parse(second.at)), false);
  assert.equal(second.layer, 'user');
  assert.equal(second.session, null);
  assert.deepEqual(second.snapshot.map((entry) => entry.name), ['project:alpha'], 'the snapshot holds no text');
  assert.equal(JSON.stringify(second.snapshot).includes('A2'), false);

  const removed = page.records[0];
  assert.equal(removed.after, null);
  assert.equal(removed.before.text, 'A2\nsecond line');
  assert.deepEqual(removed.snapshot, []);
});

test('stage2: a hide override records no text on the after side', async () => {
  const { route } = mount();
  await put(route, { name: 'project:beta', action: 'hide' });
  const page = await history(route);
  assert.equal(page.records[0].action, 'hide');
  assert.equal(page.records[0].before, null);
  assert.equal(page.records[0].after, null);
});

test('stage2: history pages and filters by name, and by an exclusive before bound', async () => {
  const { route } = mount();
  await put(route, { name: 'a', action: 'replace', text: '1' });
  await put(route, { name: 'b', action: 'replace', text: '2' });
  await put(route, { name: 'a', action: 'replace', text: '3' });

  const all = await history(route);
  assert.deepEqual(all.records.map((record) => record.id), ['3', '2', '1']);

  const named = await history(route, '&name=a');
  assert.deepEqual(named.records.map((record) => record.id), ['3', '1']);
  assert.equal(named.total, 2);

  const paged = await history(route, '&limit=1');
  assert.deepEqual(paged.records.map((record) => record.id), ['3']);
  assert.equal(paged.total, 3, 'total counts every match, not the page');
  assert.equal(paged.pageLimit, 1);

  const clamped = await history(route, '&limit=99999');
  assert.equal(clamped.pageLimit, 500);

  // `before` is exclusive, and two writes can share a millisecond, so the
  // expectation is derived from the records themselves rather than guessed.
  const newest = all.records[0].at;
  const older = all.records.filter((record) => record.at < newest);
  const bounded = await history(route, `&before=${encodeURIComponent(newest)}`);
  assert.deepEqual(bounded.records.map((record) => record.id), older.map((record) => record.id));
  assert.equal(bounded.total, older.length);
});

test('stage2: a workspace layer keeps its own separate history file', async () => {
  const workspaces = [workspaceWith('ws-one', 's1')];
  const { route } = mount({ workspaces });
  await put(route, { name: 'w', action: 'replace', text: 'W' }, '?session=s1');
  await call(route, {
    method: 'PUT',
    url: `${OVERRIDES_PATH}?session=s1`,
    body: JSON.stringify({ layer: 'workspace', session: 's1', section: { name: 'w2', action: 'hide' } }),
  });

  const userPage = await history(route);
  assert.equal(userPage.total, 1);
  const workspacePage = json(await call(route, { url: `${HISTORY_PATH}?layer=workspace&session=s1` }));
  assert.equal(workspacePage.records.length, 1);
  assert.equal(workspacePage.records[0].session, 's1');
  assert.equal(workspacePage.path, workspaceHistoryPath('ws-one'));
  assert.equal(existsSync(workspaceHistoryPath('ws-one')), true);
  assert.equal(existsSync(userHistoryPath()), true);
  assert.equal(existsSync(join(home, 'ws-one', '.dsh-prompt-setting', 'history.jsonl')), true);
});

test('stage2: the retention bound is configurable and enforced on disk', async () => {
  const limit = MIN_HISTORY_LIMIT;
  const { route } = mount({ config: { historyLimit: limit } });
  for (let index = 0; index < limit + 2; index += 1) {
    await put(route, { name: 'a', action: 'replace', text: `v${index}` });
  }
  const page = await history(route);
  assert.equal(page.retentionLimit, limit);
  assert.equal(page.records.length, limit);
  assert.equal(page.total, limit);
  assert.equal(page.records[0].after.text, `v${limit + 1}`, 'the newest record survives');
  assert.equal(page.records[page.records.length - 1].after.text, 'v2', 'the oldest two were trimmed');
  assert.equal(readFileSync(userHistoryPath(), 'utf8').split('\n').filter((line) => line.length > 0).length, limit);
});

test('stage2: the environment can set the retention bound when config does not', async () => {
  process.env.DSH_PROMPT_SETTING_HISTORY_LIMIT = '12';
  const { route } = mount();
  const page = await history(route);
  assert.equal(page.retentionLimit, 12);
});

test('stage2: an unreadable history file is reported, never fatal to the config write', async () => {
  const { route } = mount();
  // A directory where the history file belongs: readable config, hopeless log.
  mkdirSync(userHistoryPath(), { recursive: true });
  const page = await history(route);
  assert.equal(page.records.length, 0);
  assert.match(page.unreadable, /unreadable-file/);
  assert.equal(page.lastError, null, 'nothing has failed to append yet');

  // The write succeeds and the file it wrote is real; only the log failed, and
  // the failure becomes observable on the next history read (CONTRACT §8.4).
  assert.equal((await put(route, { name: 'a', action: 'hide' })).statusCode, 200);
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')).overrides, [{ name: 'a', action: 'hide' }]);
  const after = await history(route);
  assert.match(after.lastError.reason, /history-unusable/);
  assert.equal(Number.isNaN(Date.parse(after.lastError.at)), false);
});

// #endregion

// #region reset

test('stage2: resetting a layer clears it, records the removed list and takes effect next turn', async () => {
  const { route } = mount();
  await put(route, { name: 'a', action: 'replace', text: 'A' });
  await put(route, { name: 'b', action: 'hide' });

  const res = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&reset=true` });
  assert.equal(res.statusCode, 200);
  const payload = json(res);
  assert.equal(payload.ok, true);
  assert.equal(payload.reset, true);
  assert.equal(payload.count, 2);
  assert.deepEqual(payload.removed, ['a', 'b']);
  assert.equal(payload.effectiveFrom, 'next-turn');
  assert.deepEqual(payload.entries, [
    { name: 'a', action: 'replace', text: 'A' },
    { name: 'b', action: 'hide' },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')), { version: 1, overrides: [] });
  assert.equal((await call(route, { url: OVERRIDES_PATH })).body.includes('"a"'), false, 'the read view agrees');

  const page = await history(route);
  const reset = page.records[0];
  assert.equal(reset.action, 'reset-layer');
  assert.equal(reset.name, null);
  assert.deepEqual(reset.entries, [
    { name: 'a', action: 'replace', text: 'A' },
    { name: 'b', action: 'hide' },
  ]);
  assert.deepEqual(reset.snapshot, []);
  assert.equal(reset.id, payload.history.id);

  // Resetting an already-empty layer is a success that writes nothing.
  const again = json(await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&reset=true` }));
  assert.equal(again.count, 0);
  assert.deepEqual(again.removed, []);
  assert.equal(again.history, null);
  assert.equal((await history(route)).total, 3, 'no second reset record for a no-op');
});

test('stage2: a reset needs a resolvable layer, and a non-raw "true" is not a reset', async () => {
  const { route } = mount();
  const unresolved = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=workspace&reset=true` });
  assert.equal(unresolved.statusCode, 400);
  assert.equal(json(unresolved).code, 'workspace-unresolved');

  await put(route, { name: 'a', action: 'hide' });
  const notReset = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&reset=1&name=a` });
  assert.equal(notReset.statusCode, 200, 'reset=1 is not the reset switch; the name path runs');
  assert.equal(json(notReset).removed, true);

  const missingName = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&reset=1` });
  assert.equal(missingName.statusCode, 400);
  assert.equal(json(missingName).code, 'missing-name', 'the frozen single-name semantics still apply');
});

// #endregion

// #region diff

test('stage2: two history records of one section diff at section and line level', async () => {
  const { route } = mount();
  await put(route, { name: 'a', action: 'replace', text: 'one\ntwo' });
  await put(route, { name: 'a', action: 'replace', text: 'one\nTWO\nthree' });
  await put(route, { name: 'b', action: 'hide' });

  const res = await call(route, { url: `${DIFF_PATH}?layer=user&from=1&to=2` });
  assert.equal(res.statusCode, 200);
  const payload = json(res);
  assert.equal(payload.ok, true);
  assert.equal(payload.scope, 'layer');
  assert.equal(payload.from.id, '1');
  assert.equal(payload.to.id, '2');
  assert.equal(payload.from.kind, 'history');
  assert.equal(payload.from.at, (await history(route)).records.find((record) => record.id === '1').at);
  assert.deepEqual(payload.sectionsCounts, { total: 1, changed: 1, added: 0, removed: 0, same: 0 },
    'records 1 and 2 both concern section a only');
  assert.equal(payload.lines.name, 'a');
  assert.equal(payload.lines.mode, 'lcs');
  assert.deepEqual(payload.lines.stats, { added: 2, removed: 1, same: 1 });
  assert.deepEqual(payload.lines.ops.map((op) => [op.type, op.text]), [
    ['equal', 'one'],
    ['delete', 'two'],
    ['insert', 'TWO'],
    ['insert', 'three'],
  ]);
  assert.deepEqual(payload.stats, { added: 0, removed: 0, changed: 1, same: 0, lineAdded: 2, lineRemoved: 1 });
  assert.equal(JSON.stringify(payload.from).includes('texts'), false, 'the response never dumps both texts');
});

test('stage2: a history version can be compared with the live value', async () => {
  const { route } = mount();
  await put(route, { name: 'a', action: 'replace', text: 'first' });
  await put(route, { name: 'a', action: 'replace', text: 'second' });

  const payload = json(await call(route, { url: `${DIFF_PATH}?layer=user&from=1` }));
  assert.equal(payload.from.kind, 'history');
  assert.equal(payload.to.kind, 'current');
  assert.equal(payload.to.label, 'current');
  assert.equal(payload.to.at, null);
  assert.equal(payload.lines.name, 'a');
  assert.deepEqual(payload.lines.stats, { added: 1, removed: 1, same: 0 });
  assert.equal(payload.lines.ops.find((op) => op.type === 'delete').text, 'first');
  assert.equal(payload.lines.ops.find((op) => op.type === 'insert').text, 'second');

  const reversed = json(await call(route, { url: `${DIFF_PATH}?layer=user&to=1` }));
  assert.equal(reversed.from.kind, 'current');
  assert.equal(reversed.to.id, '1');
  assert.equal(reversed.lines.ops.find((op) => op.type === 'insert').text, 'first');
});

test('stage2: the diff selector is strict and says which input was wrong', async () => {
  const { route } = mount();
  await put(route, { name: 'a', action: 'replace', text: 'x' });

  const missing = await call(route, { url: `${DIFF_PATH}?layer=user` });
  assert.equal(missing.statusCode, 400);
  assert.equal(json(missing).code, 'missing-diff-selector');

  const badId = await call(route, { url: `${DIFF_PATH}?layer=user&from=abc` });
  assert.equal(badId.statusCode, 400);
  assert.equal(json(badId).code, 'invalid-diff-selector');

  const notFound = await call(route, { url: `${DIFF_PATH}?layer=user&from=99` });
  assert.equal(notFound.statusCode, 404);
  assert.equal(json(notFound).code, 'history-not-found');

  const unknownLayer = await call(route, { url: `${DIFF_PATH}?layer=nope&from=1` });
  assert.equal(unknownLayer.statusCode, 400);

  const ambiguous = await call(route, { url: `${DIFF_PATH}?layer=user&from=current&to=current` });
  assert.equal(ambiguous.statusCode, 200);
  assert.equal(json(ambiguous).lines, null);
  assert.match(json(ambiguous).lineReason, /identical/);
});

test('stage2: a reset record diffs against the live layer as a set of additions', async () => {
  const { route } = mount();
  await put(route, { name: 'a', action: 'replace', text: 'A' });
  await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&reset=true` });
  await put(route, { name: 'b', action: 'replace', text: 'B' });

  const payload = json(await call(route, { url: `${DIFF_PATH}?layer=user&from=1` }));
  assert.equal(payload.from.action, 'replace', 'record 1 is the write that came before the reset');
  assert.equal(payload.from.name, 'a');
  assert.equal(payload.from.label, '#1');
  const payload2 = json(await call(route, { url: `${DIFF_PATH}?layer=user&from=2` }));
  assert.equal(payload2.from.action, 'reset-layer');
  assert.equal(payload2.from.name, null);
  assert.deepEqual(payload2.sectionsCounts, { total: 1, changed: 0, added: 1, removed: 0, same: 0 });
  // The reset version holds no text, so the section that appeared after it is
  // reported as pure insertion rather than as a rewrite.
  assert.equal(payload2.lines.name, 'b');
  assert.equal(payload2.lineReason, null);
  assert.equal(payload2.lines.ops.filter((op) => op.type === 'insert')[0].text, 'B');
  assert.equal(payload2.lines.ops.filter((op) => op.type === 'delete')[0].text, '');
});

// #endregion

// #region export

test('stage2: export carries the schema, both layers and no absolute path', async () => {
  const { route } = mount();
  await put(route, { name: 'a', action: 'replace', text: 'A' });
  const res = await call(route, { url: EXPORT_PATH });
  assert.equal(res.statusCode, 200);
  const payload = json(res);
  assert.equal(payload.ok, true);
  assert.equal(payload.schema, 'dsh-prompt-setting/export');
  assert.equal(payload.version, 1);
  assert.equal(payload.pluginVersion, '0.1.0');
  assert.deepEqual(payload.plugin, { name: 'dsh-prompt-setting', version: '0.1.0' });
  assert.equal(Number.isNaN(Date.parse(payload.exportedAt)), false);
  assert.deepEqual(Object.keys(payload.layers), ['user', 'workspace']);
  assert.deepEqual(payload.layers.user.overrides, [{ name: 'a', action: 'replace', text: 'A' }]);
  assert.equal(payload.layers.workspace.enabled, false);
  assert.match(payload.layers.workspace.reason, /no \?session=/);
  assert.equal(JSON.stringify(payload).includes(home), false, 'no absolute path is exported');

  const usersOnly = json(await call(route, { url: `${EXPORT_PATH}?layer=user` }));
  assert.deepEqual(Object.keys(usersOnly.layers), ['user']);

  const bad = await call(route, { url: `${EXPORT_PATH}?layer=nope` });
  assert.equal(bad.statusCode, 400);
  assert.equal(json(bad).code, 'unknown-layer');
});

test('stage2: an export of the workspace layer needs a resolvable session', async () => {
  const workspaces = [workspaceWith('ws-two', 's2')];
  const { route } = mount({ workspaces });
  await call(route, {
    method: 'PUT',
    url: `${OVERRIDES_PATH}?session=s2`,
    body: JSON.stringify({ layer: 'workspace', session: 's2', section: { name: 'w', action: 'replace', text: 'W' } }),
  });
  const payload = json(await call(route, { url: `${EXPORT_PATH}?session=s2` }));
  assert.equal(payload.layers.workspace.enabled, true);
  assert.deepEqual(payload.layers.workspace.overrides, [{ name: 'w', action: 'replace', text: 'W' }]);
});

// #endregion

// #region import

test('stage2: a dry run reports the plan and writes nothing at all', async () => {
  const { route } = mount();
  await put(route, { name: 'a', action: 'replace', text: 'LOCAL' });
  await put(route, { name: 'b', action: 'hide' });
  const document = json(await call(route, { url: EXPORT_PATH }));
  document.layers.user.overrides = [
    { name: 'a', action: 'replace', text: 'IMPORTED' },
    { name: 'c', action: 'replace', text: 'NEW' },
  ];
  const before = fingerprints([userPath(), userHistoryPath()]);

  const res = await call(route, { method: 'POST', url: `${IMPORT_PATH}?dryRun=true`, body: JSON.stringify(document) });
  assert.equal(res.statusCode, 200);
  const payload = json(res);
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.applied, false);
  assert.equal(payload.mode, 'merge');
  assert.deepEqual(payload.totals, { added: 1, replaced: 1, unchanged: 0, removed: 0, kept: 1 });
  assert.deepEqual(payload.layers.user.counts, { added: 1, replaced: 1, unchanged: 0, removed: 0, kept: 1 });
  assert.deepEqual(payload.layers.user.changes, [
    { name: 'a', status: 'replaced', action: 'replace' },
    { name: 'c', status: 'added', action: 'replace' },
  ]);
  assert.deepEqual(payload.imported, ['user']);
  assert.deepEqual(payload.skipped, [{ layer: 'workspace', reason: 'layer "workspace" requires a "session" id to resolve the workspace root', entries: 0 }]);
  assert.equal(payload.unchanged, false);
  assert.deepEqual(fingerprints([userPath(), userHistoryPath()]), before, 'a dry run touches nothing');
});

test('stage2: re-importing an unchanged export is recognised as a no-op', async () => {
  const { route } = mount();
  await put(route, { name: 'a', action: 'replace', text: 'A' });
  const document = json(await call(route, { url: `${EXPORT_PATH}?layer=user` }));
  const before = fingerprints([userPath(), userHistoryPath()]);
  const payload = json(await call(route, { method: 'POST', url: IMPORT_PATH, body: JSON.stringify(document) }));
  assert.equal(payload.unchanged, true);
  assert.equal(payload.applied, false);
  assert.deepEqual(payload.written, []);
  assert.deepEqual(payload.totals, { added: 0, replaced: 0, unchanged: 1, removed: 0, kept: 0 });
  assert.deepEqual(fingerprints([userPath(), userHistoryPath()]), before, 'nothing was rewritten and no history was appended');
});

test('stage2: a real import applies both layers and logs every write as origin "import"', async () => {
  const workspaces = [workspaceWith('ws-three', 's3')];
  const { route } = mount({ workspaces });
  await call(route, {
    method: 'PUT',
    url: `${OVERRIDES_PATH}?session=s3`,
    body: JSON.stringify({ layer: 'workspace', session: 's3', section: { name: 'keep', action: 'hide' } }),
  });
  const document = {
    schema: 'dsh-prompt-setting/export',
    version: 1,
    exportedAt: '2024-01-01T00:00:00.000Z',
    layers: {
      user: { layer: 'user', overrides: [{ name: 'a', action: 'replace', text: 'A' }] },
      workspace: { layer: 'workspace', overrides: [{ name: 'w', action: 'replace', text: 'W' }] },
    },
  };
  const res = await call(route, {
    method: 'POST',
    url: `${IMPORT_PATH}?session=s3`,
    body: JSON.stringify(document),
  });
  assert.equal(res.statusCode, 200);
  const payload = json(res);
  assert.equal(payload.applied, true);
  assert.equal(payload.unchanged, false);
  assert.deepEqual(payload.imported, ['user', 'workspace']);
  assert.deepEqual(payload.totals, { added: 2, replaced: 0, unchanged: 0, removed: 0, kept: 1 });
  assert.deepEqual(payload.written.sort(), [userPath(), workspacePath('ws-three')].sort());
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')).overrides, [{ name: 'a', action: 'replace', text: 'A' }]);
  assert.deepEqual(
    JSON.parse(readFileSync(workspacePath('ws-three'), 'utf8')).overrides.map((entry) => entry.name),
    ['keep', 'w'],
    'merge keeps the local entry\'s position and appends the imported one',
  );
  assert.equal(payload.history.user[0].ok, true);
  assert.equal(payload.history.workspace[0].ok, true);

  const userPage = await history(route);
  assert.equal(userPage.records[0].origin, 'import');
  assert.equal(userPage.records[0].action, 'replace');
  assert.equal(userPage.records[0].before, null);
  assert.equal(userPage.records[0].after.text, 'A');
  assert.match(userPage.records[0].note, /import mode=merge status=added/);

  const workspacePage = json(await call(route, { url: `${HISTORY_PATH}?layer=workspace&session=s3` }));
  assert.equal(workspacePage.records[0].origin, 'import');
  assert.deepEqual(workspacePage.records[0].snapshot.map((entry) => entry.name), ['keep', 'w']);
});

test('stage2: mode=replace removes local extras and logs the removals', async () => {
  const { route } = mount();
  await put(route, { name: 'a', action: 'replace', text: 'LOCAL' });
  await put(route, { name: 'b', action: 'hide' });
  const document = {
    schema: 'dsh-prompt-setting/export',
    version: 1,
    layers: { user: { layer: 'user', overrides: [{ name: 'a', action: 'replace', text: 'IMPORTED' }] } },
  };
  const dry = json(await call(route, { method: 'POST', url: `${IMPORT_PATH}?dryRun=true&mode=replace`, body: JSON.stringify(document) }));
  assert.equal(dry.mode, 'replace');
  assert.deepEqual(dry.totals, { added: 0, replaced: 1, unchanged: 0, removed: 1, kept: 0 });
  assert.deepEqual(dry.layers.user.changes.map((change) => [change.name, change.status]), [['a', 'replaced'], ['b', 'removed']]);

  const applied = json(await call(route, { method: 'POST', url: `${IMPORT_PATH}?mode=replace`, body: JSON.stringify(document) }));
  assert.equal(applied.applied, true);
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')).overrides, [{ name: 'a', action: 'replace', text: 'IMPORTED' }]);
  const page = await history(route);
  assert.deepEqual(page.records.slice(0, 2).map((record) => [record.action, record.name, record.origin]), [
    ['remove', 'b', 'import'],
    ['replace', 'a', 'import'],
  ]);
  assert.equal(page.records[0].before, null, 'a hidden section has no text to record');
});

test('stage2: a body-supplied mode is honoured, and the query wins', async () => {
  const { route } = mount();
  await put(route, { name: 'local', action: 'hide' });
  const document = {
    schema: 'dsh-prompt-setting/export',
    version: 1,
    layers: { user: { layer: 'user', overrides: [] } },
  };
  const body = { ...document, mode: 'replace' };
  const byBody = json(await call(route, { method: 'POST', url: `${IMPORT_PATH}?dryRun=true`, body: JSON.stringify(body) }));
  assert.equal(byBody.mode, 'replace');
  assert.equal(byBody.totals.removed, 1);
  const byQuery = json(await call(route, { method: 'POST', url: `${IMPORT_PATH}?dryRun=true&mode=merge`, body: JSON.stringify(body) }));
  assert.equal(byQuery.mode, 'merge');
  assert.equal(byQuery.totals.removed, 0);
  const unknown = await call(route, { method: 'POST', url: `${IMPORT_PATH}?dryRun=true&mode=overwrite`, body: JSON.stringify(document) });
  assert.equal(unknown.statusCode, 400);
  assert.equal(json(unknown).code, 'unknown-import-mode');
});

test('stage2: the layer filter imports one layer and leaves the other alone', async () => {
  const workspaces = [workspaceWith('ws-four', 's4')];
  const { route } = mount({ workspaces });
  await put(route, { name: 'existing', action: 'hide' });
  const document = {
    schema: 'dsh-prompt-setting/export',
    version: 1,
    layers: {
      user: { layer: 'user', overrides: [{ name: 'u', action: 'hide' }] },
      workspace: { layer: 'workspace', overrides: [{ name: 'w', action: 'hide' }] },
    },
  };
  const payload = json(await call(route, {
    method: 'POST',
    url: `${IMPORT_PATH}?session=s4&layer=user`,
    body: JSON.stringify(document),
  }));
  assert.deepEqual(payload.imported, ['user']);
  assert.equal(payload.written.length, 1);
  assert.equal(existsSync(workspacePath('ws-four')), false, 'the workspace layer was never created');

  const missing = await call(route, {
    method: 'POST',
    url: `${IMPORT_PATH}?session=s4&layer=workspace`,
    body: JSON.stringify({ ...document, layers: { user: document.layers.user } }),
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(json(missing).code, 'missing-export-layer');
});

// #endregion

// #region import atomicity — every rejection is proven with a hash

/** Documents that must all be refused, with the code each one must answer. */
function rejectedDocuments() {
  return [
    ['not an object', JSON.stringify([1, 2, 3]), 'invalid-export'],
    ['wrong schema', JSON.stringify({ schema: 'nope', version: 1, layers: {} }), 'unknown-export-schema'],
    ['missing version', JSON.stringify({ schema: 'dsh-prompt-setting/export', layers: {} }), 'missing-export-version'],
    ['future version', JSON.stringify({ schema: 'dsh-prompt-setting/export', version: 99, layers: {} }), 'unsupported-export-version'],
    ['no layers', JSON.stringify({ schema: 'dsh-prompt-setting/export', version: 1 }), 'missing-export-layers'],
    [
      'bad action',
      JSON.stringify({ schema: 'dsh-prompt-setting/export', version: 1, layers: { user: { overrides: [{ name: 'a', action: 'delete', text: 'x' }] } } }),
      'unknown-action',
    ],
    [
      'missing text',
      JSON.stringify({ schema: 'dsh-prompt-setting/export', version: 1, layers: { user: { overrides: [{ name: 'a', action: 'replace' }] } } }),
      'missing-text',
    ],
    [
      'duplicate name',
      JSON.stringify({
        schema: 'dsh-prompt-setting/export',
        version: 1,
        layers: {
          user: {
            overrides: [
              { name: 'a', action: 'replace', text: 'x' },
              { name: 'a', action: 'replace', text: 'y' },
            ],
          },
        },
      }),
      'duplicate-name',
    ],
    [
      'oversized text',
      JSON.stringify({
        schema: 'dsh-prompt-setting/export',
        version: 1,
        layers: { user: { overrides: [{ name: 'a', action: 'replace', text: 'x'.repeat(200 * 1024 + 1) }] } },
      }),
      'text-too-large',
    ],
  ];
}

test('stage2: every rejected import leaves BOTH config files and the history byte-identical', async () => {
  const workspaces = [workspaceWith('ws-five', 's5')];
  const { route } = mount({ workspaces });
  await put(route, { name: 'local', action: 'replace', text: 'LOCAL TEXT' });
  await call(route, {
    method: 'PUT',
    url: `${OVERRIDES_PATH}?session=s5`,
    body: JSON.stringify({ layer: 'workspace', session: 's5', section: { name: 'w', action: 'hide' } }),
  });
  const paths = [userPath(), userHistoryPath(), workspacePath('ws-five'), workspaceHistoryPath('ws-five')];
  const before = fingerprints(paths);

  for (const [what, body, code] of rejectedDocuments()) {
    const res = await call(route, { method: 'POST', url: `${IMPORT_PATH}?session=s5`, body });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `${what} must be a 4xx, got ${res.statusCode}`);
    assert.equal(json(res).code, code, `${what} must answer ${code}`);
    assert.deepEqual(fingerprints(paths), before, `${what} must not touch any file`);
    assert.deepEqual(tempFiles(home), [], `${what} must leave no temp file`);
  }

  // An unparsable body is refused by the JSON reader, before the document is
  // even looked at.
  const broken = await call(route, { method: 'POST', url: IMPORT_PATH, body: '{ not json' });
  assert.equal(broken.statusCode, 400);
  assert.equal(json(broken).code, 'invalid-json');
  assert.deepEqual(fingerprints(paths), before);
});

test('stage2: an over-large import body is a 413 and the existing config is untouched', async () => {
  const { route } = mount();
  await put(route, { name: 'local', action: 'hide' });
  const before = fingerprints([userPath(), userHistoryPath()]);
  const oversize = JSON.stringify({
    schema: 'dsh-prompt-setting/export',
    version: 1,
    pad: 'x'.repeat(4 * 1024 * 1024 + 16),
    layers: { user: { overrides: [] } },
  });
  const res = await call(route, { method: 'POST', url: IMPORT_PATH, body: oversize });
  assert.equal(res.statusCode, 413);
  assert.equal(json(res).code, 'body-too-large');
  assert.deepEqual(fingerprints([userPath(), userHistoryPath()]), before);
  // The PUT cap is unchanged, and it is smaller than the import cap.
  const putTooLarge = await call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    body: JSON.stringify({ layer: 'user', section: { name: 'a', action: 'replace', text: 'x' }, pad: 'y'.repeat(300 * 1024) }),
  });
  assert.equal(putTooLarge.statusCode, 413);
});

test('stage2: a layer that cannot be read is never overwritten by an import', async () => {
  const { route } = mount();
  mkdirSync(join(home, 'prompt-setting'), { recursive: true });
  writeFileSync(userPath(), '{ this is not json', 'utf8');
  const before = fingerprint(userPath());
  const res = await call(route, {
    method: 'POST',
    url: IMPORT_PATH,
    body: JSON.stringify({
      schema: 'dsh-prompt-setting/export',
      version: 1,
      layers: { user: { overrides: [{ name: 'a', action: 'hide' }] } },
    }),
  });
  assert.equal(res.statusCode, 409);
  assert.equal(json(res).code, 'layer-not-writable');
  assert.equal(fingerprint(userPath()), before);
});

test('stage2: an unresolvable workspace aborts the whole import, user layer included', async () => {
  const { route } = mount();
  await put(route, { name: 'local', action: 'hide' });
  const before = fingerprints([userPath(), userHistoryPath()]);
  const res = await call(route, {
    method: 'POST',
    url: IMPORT_PATH,
    body: JSON.stringify({
      schema: 'dsh-prompt-setting/export',
      version: 1,
      layers: {
        user: { overrides: [{ name: 'u', action: 'hide' }] },
        workspace: { overrides: [{ name: 'w', action: 'hide' }] },
      },
    }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).code, 'workspace-unresolved');
  assert.deepEqual(fingerprints([userPath(), userHistoryPath()]), before, 'the user layer was not written either');
  assert.deepEqual(tempFiles(home), []);
});

test('stage2: an empty workspace layer with no session is skipped, not a failure', async () => {
  const { route } = mount();
  const res = await call(route, {
    method: 'POST',
    url: `${IMPORT_PATH}?dryRun=true`,
    body: JSON.stringify({
      schema: 'dsh-prompt-setting/export',
      version: 1,
      layers: {
        user: { overrides: [] },
        workspace: { overrides: [] },
      },
    }),
  });
  assert.equal(res.statusCode, 200);
  const payload = json(res);
  assert.deepEqual(payload.imported, ['user']);
  assert.equal(payload.skipped.length, 1);
  assert.equal(payload.skipped[0].layer, 'workspace');
  assert.match(payload.skipped[0].reason, /requires a "session"/);
});

// #endregion

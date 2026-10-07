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

import { DEFAULT_HISTORY_LIMIT, DEFAULT_HISTORY_PAGE, MIN_HISTORY_LIMIT } from '../core/history.js';
import { apply, CUSTOM_SECTION_NAME } from '../index.js';

const OVERRIDES_PATH = '/prompt-setting/overrides';
const HISTORY_PATH = '/prompt-setting/history';
const DIFF_PATH = '/prompt-setting/diff';
const ROLLBACK_PATH = '/prompt-setting/rollback';
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
      /**
       * The registration surface the plugin uses since Revision 7. It only has
       * to hand back a disposer: this suite never assembles through the fake.
       */
      section() {
        return () => {};
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

/**
 * Put one user-layer override.
 *
 * Since Revision 7 the only writable name is the reserved one, so this helper
 * always targets it; a legacy entry is produced by {@link seedUser} instead
 * (the documented escape hatch, which is also how every pre-Revision-7 layer
 * looks on disk).
 * @param route - the captured route.
 * @param section - the override body (its `name` is overwritten).
 * @param query - an extra query string, e.g. `?session=s1`.
 * @returns the response double.
 */
function put(route, section, query = '') {
  return call(route, {
    method: 'PUT',
    url: `${OVERRIDES_PATH}${query}`,
    body: JSON.stringify({ layer: 'user', section: { ...section, name: CUSTOM_SECTION_NAME } }),
  });
}

/**
 * Write the user layer's config file by hand — a hand edit, a config-sync tool,
 * or (for these tests) the way a frozen override comes to exist at all. The
 * next handled request re-reads it; the assembly path still reads only cache.
 * @param overrides - the override list.
 */
function seedUser(overrides) {
  mkdirSync(join(home, 'prompt-setting'), { recursive: true });
  writeFileSync(userPath(), `${JSON.stringify({ version: 1, overrides }, null, 2)}\n`, 'utf8');
}

/**
 * Write one workspace layer's config file by hand.
 * @param id - the workspace directory name.
 * @param overrides - the override list.
 */
function seedWorkspace(id, overrides) {
  const directory = join(home, id, '.dsh-prompt-setting');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'overrides.json'), `${JSON.stringify({ version: 1, overrides }, null, 2)}\n`, 'utf8');
}

/**
 * Append hand-written records to a layer's history file.
 *
 * Route writes can only ever name the reserved section now, so a log that
 * covers several names is the log a pre-Revision-7 layer already has. Every
 * field here is validated on read (`core/history.js`), so a mistake in this
 * helper fails loudly rather than silently.
 * @param path - the history file.
 * @param entries - `[seq, name, action]` triples, oldest first.
 */
function seedHistory(path, entries) {
  const lines = entries.map(([seq, name, action]) => JSON.stringify({
    seq,
    at: `2024-01-0${seq}T00:00:0${seq}.000Z`,
    layer: 'user',
    session: null,
    action,
    name,
    origin: 'ui',
    before: null,
    after: { text: `v${seq}`, hash: 'f'.repeat(64), bytes: 2 },
    entries: null,
    snapshot: [{ name, action, hash: 'f'.repeat(64), bytes: 2 }],
    note: null,
  }));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

/** Read the user layer's history records. */
async function history(route, query = '') {
  const res = await call(route, { url: `${HISTORY_PATH}?layer=user${query}` });
  assert.equal(res.statusCode, 200);
  return json(res);
}

/**
 * Write a layer's history file whose records carry **distinct** session ids.
 *
 * The route can only ever write the current session's id into a record (it
 * stamps `session` from the request), so a log that spans sessions — the log a
 * reader who switches sessions really has on disk — is seeded directly here.
 * @param path - the history file.
 * @param sessions - the `session` value of each record, oldest first.
 * @param layer - the record's layer name.
 */
function seedSessionHistory(path, sessions, layer = 'user') {
  const lines = sessions.map((session, index) => JSON.stringify({
    seq: index + 1,
    at: `2024-01-0${index + 1}T00:00:0${index + 1}.000Z`,
    layer,
    session,
    action: 'replace',
    name: CUSTOM_SECTION_NAME,
    origin: 'ui',
    before: null,
    after: { text: `v${index + 1}`, hash: 'f'.repeat(64), bytes: 2 },
    entries: null,
    snapshot: [],
    note: null,
  }));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

// #region dispatch

test('stage2: the new routes answer 405 with their own allow list, unchanged for the old ones', async () => {
  const { route } = mount();
  const cases = [
    [{ method: 'POST', url: HISTORY_PATH }, 'GET'],
    [{ method: 'GET', url: DIFF_PATH }, 'GET', 200],
    [{ method: 'GET', url: ROLLBACK_PATH }, 'POST'],
    [{ method: 'PUT', url: ROLLBACK_PATH }, 'POST'],
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
    { method: 'POST', url: ROLLBACK_PATH },
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
  const first = await put(route, { action: 'replace', text: 'A1' });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(Object.keys(json(first)).sort(), ['effectiveFrom', 'ok', 'saved'], 'the PUT body is still the stage 1B shape');

  await put(route, { action: 'replace', text: 'A2\nsecond line' });
  const deleted = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&name=${encodeURIComponent(CUSTOM_SECTION_NAME)}` });
  assert.deepEqual(Object.keys(json(deleted)).sort(), ['effectiveFrom', 'layer', 'name', 'ok', 'removed'], 'so is the DELETE body');

  const page = await history(route);
  assert.equal(page.total, 3);
  assert.deepEqual(page.records.map((record) => [record.id, record.action, record.name, record.origin]), [
    ['3', 'remove', CUSTOM_SECTION_NAME, 'ui'],
    ['2', 'replace', CUSTOM_SECTION_NAME, 'ui'],
    ['1', 'replace', CUSTOM_SECTION_NAME, 'ui'],
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
  assert.deepEqual(second.snapshot.map((entry) => entry.name), [CUSTOM_SECTION_NAME], 'the snapshot holds no text');
  assert.equal(JSON.stringify(second.snapshot).includes('A2'), false);

  const removed = page.records[0];
  assert.equal(removed.after, null);
  assert.equal(removed.before.text, 'A2\nsecond line');
  assert.deepEqual(removed.snapshot, []);
});

test('stage2: a hide override records no text on the after side', async () => {
  // `hide` is no longer writable through `PUT` (Revision 7 narrows the action to
  // `replace`), but it is still representable — an import document may carry the
  // action for the reserved name, and the log must handle a text-less write.
  const { route } = mount();
  const document = {
    schema: 'dsh-prompt-setting/export',
    version: 1,
    layers: { user: { layer: 'user', overrides: [{ name: CUSTOM_SECTION_NAME, action: 'hide' }] } },
  };
  const res = await call(route, { method: 'POST', url: IMPORT_PATH, body: JSON.stringify(document) });
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).applied, true);
  const page = await history(route);
  assert.equal(page.records[0].action, 'hide');
  assert.equal(page.records[0].name, CUSTOM_SECTION_NAME);
  assert.equal(page.records[0].before, null);
  assert.equal(page.records[0].after, null);
});

test('stage2: history pages and filters by name, and by an exclusive before bound', async () => {
  const { route } = mount();
  // A log that spans several names is what a layer written by an earlier
  // revision already has on disk; the reserved write is appended to it.
  seedHistory(userHistoryPath(), [[1, 'a', 'replace'], [2, 'b', 'replace']]);
  await put(route, { action: 'replace', text: '3' });

  const all = await history(route);
  assert.deepEqual(all.records.map((record) => record.id), ['3', '2', '1']);

  const named = await history(route, '&name=a');
  assert.deepEqual(named.records.map((record) => record.id), ['1']);
  assert.equal(named.total, 1);
  const mine = await history(route, `&name=${encodeURIComponent(CUSTOM_SECTION_NAME)}`);
  assert.deepEqual(mine.records.map((record) => record.id), ['3']);
  assert.equal(mine.total, 1);

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

test('stage2: the user layer log is whole without ?session=, and ?session= still filters (g-038)', async () => {
  const { route } = mount();
  // Three writes, three sessions (one of them global) — the log a reader who
  // switches sessions really has. Before g-038 the page always sent `?session=`,
  // so only one column of this file was ever visible.
  seedSessionHistory(userHistoryPath(), ['s1', 's2', null]);

  const all = await history(route);
  assert.deepEqual(all.records.map((record) => record.id), ['3', '2', '1'], 'the whole layer, newest first');
  assert.equal(all.total, 3);
  assert.equal(all.session, null, 'nothing was filtered');
  assert.equal(all.scopeSession, null, 'and no scope was named');

  // The explicit filter is kept, and still means what it always meant.
  const filtered = await history(route, '&session=s1');
  assert.deepEqual(filtered.records.map((record) => record.id), ['1']);
  assert.equal(filtered.total, 1);
  assert.equal(filtered.session, 's1');
  assert.equal(filtered.scopeSession, 's1', 'an explicit session resolves and filters');

  // An explicitly empty session is "no filter", never "records whose session is ''".
  const empty = await history(route, '&session=');
  assert.equal(empty.total, 3);
  assert.equal(empty.session, null);

  // The filter composes with paging: the page count describes the matches.
  const paged = await history(route, '&session=s1&limit=1&offset=0');
  assert.equal(paged.total, 1);
  assert.equal(paged.pageCount, 1);
  assert.equal(paged.hasMore, false);
});

test('stage2: ?offset= pages the log, clamps an unusable page and reports the page (g-038)', async () => {
  const { route } = mount();
  seedHistory(userHistoryPath(), [[1, 'a', 'replace'], [2, 'b', 'replace'], [3, 'a', 'replace']]);

  const first = await history(route, '&limit=1&offset=0');
  assert.deepEqual(first.records.map((record) => record.id), ['3']);
  assert.equal(first.offset, 0);
  assert.equal(first.pageLimit, 1);
  assert.equal(first.total, 3);
  assert.equal(first.pageCount, 3);
  assert.equal(first.hasMore, true);

  const second = await history(route, '&limit=1&offset=1');
  assert.deepEqual(second.records.map((record) => record.id), ['2']);
  assert.equal(second.offset, 1);
  assert.equal(second.hasMore, true);

  const third = await history(route, '&limit=1&offset=2');
  assert.deepEqual(third.records.map((record) => record.id), ['1']);
  assert.equal(third.offset, 2);
  assert.equal(third.hasMore, false, 'the last page says so');

  // An **unusable** page number is page one, never an error.
  for (const raw of ['-5', 'abc', '', ' ']) {
    const page = await history(route, `&limit=1&offset=${encodeURIComponent(raw)}`);
    assert.equal(page.offset, 0, `offset=${JSON.stringify(raw)} is page one`);
    assert.deepEqual(page.records.map((record) => record.id), ['3']);
    assert.equal(page.pageCount, 3);
    assert.equal(page.hasMore, true);
  }

  // A page **past the end** (or a fractional one, floored) is clamped to the
  // last page that exists, so the reader still sees records rather than nothing.
  for (const raw of ['3', '999', '2.7']) {
    const page = await history(route, `&limit=1&offset=${encodeURIComponent(raw)}`);
    assert.equal(page.offset, 2, `offset=${JSON.stringify(raw)} lands on the last page`);
    assert.deepEqual(page.records.map((record) => record.id), ['1']);
    assert.equal(page.pageCount, 3);
    assert.equal(page.hasMore, false);
  }

  // `limit=0` is the documented counts-only request: no records, no pages.
  const counts = await history(route, '&limit=0&offset=3');
  assert.deepEqual(counts.records, []);
  assert.equal(counts.total, 3);
  assert.equal(counts.pageCount, 0);
  assert.equal(counts.hasMore, false);
  assert.equal(counts.offset, 0);

  // No `limit` at all is the host's own default, and one page of it.
  const dflt = await history(route);
  assert.equal(dflt.pageLimit, DEFAULT_HISTORY_PAGE);
  assert.equal(dflt.offset, 0);
  assert.equal(dflt.pageCount, 1);
  assert.equal(dflt.hasMore, false);
});

test('stage2: a workspace log is located by ?workspace= and is not narrowed by it (g-038)', async () => {
  const workspaces = [workspaceWith('ws-one', 's1')];
  const { route } = mount({ workspaces });
  // One workspace, two sessions writing into it (plus a global write): the log
  // belongs to the workspace, so all three records are one log.
  seedSessionHistory(workspaceHistoryPath('ws-one'), ['s1', 's2', 's1'], 'workspace');

  const located = json(await call(route, { url: `${HISTORY_PATH}?layer=workspace&workspace=s1` }));
  assert.equal(located.path, workspaceHistoryPath('ws-one'), 'the workspace root came from the session index');
  assert.equal(located.scopeSession, 's1');
  assert.equal(located.session, null, '`workspace=` locates a file; it does not filter records');
  assert.equal(located.total, 3, 'the whole workspace log');
  assert.equal(located.records.some((record) => record.session === 's2'), true, "another session's record is shown");
  assert.equal(located.enabled, true);

  // The explicit filter still narrows the same file.
  const filtered = json(await call(route, { url: `${HISTORY_PATH}?layer=workspace&session=s1` }));
  assert.equal(filtered.path, workspaceHistoryPath('ws-one'));
  assert.equal(filtered.total, 2);
  assert.equal(filtered.session, 's1');

  // And paging applies to the located file.
  const paged = json(await call(route, { url: `${HISTORY_PATH}?layer=workspace&workspace=s1&limit=2&offset=2` }));
  assert.equal(paged.total, 3);
  assert.equal(paged.pageCount, 2);
  assert.equal(paged.records.length, 1);
  assert.equal(paged.hasMore, false);

  // An unknown workspace/session is still the ordinary refusal, not a crash.
  const unknown = await call(route, { url: `${HISTORY_PATH}?layer=workspace&workspace=nobody` });
  assert.equal(unknown.statusCode, 200);
  assert.equal(json(unknown).enabled, false);
  assert.equal(json(unknown).reason.includes('nobody'), true);

  // A comparison reads the very same file through the same scope (g-038).
  const diff = json(await call(route, { url: `${DIFF_PATH}?layer=workspace&workspace=s1&from=1&to=current` }));
  assert.equal(diff.historyPath, workspaceHistoryPath('ws-one'));
  assert.equal(diff.scopeSession, 's1');
  assert.equal(diff.session, null);
});

test('stage2: a workspace layer keeps its own separate history file', async () => {
  const workspaces = [workspaceWith('ws-one', 's1')];
  const { route } = mount({ workspaces });
  await put(route, { action: 'replace', text: 'W' }, '?session=s1');
  await call(route, {
    method: 'PUT',
    url: `${OVERRIDES_PATH}?session=s1`,
    body: JSON.stringify({ layer: 'workspace', session: 's1', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'W2' } }),
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
    await put(route, { action: 'replace', text: `v${index}` });
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
  assert.equal((await put(route, { action: 'replace', text: 'MINE' })).statusCode, 200);
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')).overrides, [
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
  ]);
  const after = await history(route);
  assert.match(after.lastError.reason, /history-unusable/);
  assert.equal(Number.isNaN(Date.parse(after.lastError.at)), false);
});

// #endregion

// #region reset

test('stage2: resetting a layer clears it, records the removed list and takes effect next turn', async () => {
  const { route } = mount();
  // The layer holds one frozen entry and one reserved one, in file order.
  seedUser([
    { name: 'a', action: 'replace', text: 'A' },
    { name: 'b', action: 'hide' },
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
  ]);

  const res = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&reset=true` });
  assert.equal(res.statusCode, 200);
  const payload = json(res);
  assert.equal(payload.ok, true);
  assert.equal(payload.reset, true);
  assert.equal(payload.count, 3);
  assert.deepEqual(payload.removed, ['a', 'b', CUSTOM_SECTION_NAME], 'a reset still clears the whole layer, reserved entry included');
  assert.equal(payload.effectiveFrom, 'next-turn');
  assert.deepEqual(payload.entries, [
    { name: 'a', action: 'replace', text: 'A' },
    { name: 'b', action: 'hide' },
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
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
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
  ]);
  assert.deepEqual(reset.snapshot, []);
  assert.equal(reset.id, payload.history.id);

  // Resetting an already-empty layer is a success that writes nothing.
  const again = json(await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&reset=true` }));
  assert.equal(again.count, 0);
  assert.deepEqual(again.removed, []);
  assert.equal(again.history, null);
  assert.equal((await history(route)).total, 1, 'no second reset record for a no-op');
});

test('stage2: a reset needs a resolvable layer, and a non-raw "true" is not a reset', async () => {
  const { route } = mount();
  const unresolved = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=workspace&reset=true` });
  assert.equal(unresolved.statusCode, 400);
  assert.equal(json(unresolved).code, 'workspace-unresolved');

  await put(route, { action: 'replace', text: 'MINE' });
  const notReset = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&reset=1&name=${encodeURIComponent(CUSTOM_SECTION_NAME)}` });
  assert.equal(notReset.statusCode, 200, 'reset=1 is not the reset switch; the name path runs');
  assert.equal(json(notReset).removed, true);

  const missingName = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&reset=1` });
  assert.equal(missingName.statusCode, 400);
  assert.equal(json(missingName).code, 'missing-name', 'the single-name semantics still apply');
});

// #endregion

// #region legacy clear (Revision 7)

test('stage2: legacy=true clears only the frozen overrides and keeps the reserved one', async () => {
  const { route } = mount();
  seedUser([
    { name: 'a', action: 'replace', text: 'A' },
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
    { name: 'b', action: 'append', text: 'B', order: 1 },
  ]);

  const res = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&legacy=true` });
  assert.equal(res.statusCode, 200);
  const payload = json(res);
  assert.equal(payload.ok, true);
  assert.equal(payload.legacy, true);
  assert.equal(payload.layer, 'user');
  assert.deepEqual(payload.removed, ['a', 'b']);
  assert.equal(payload.count, 2);
  assert.equal(payload.effectiveFrom, 'next-turn');
  assert.deepEqual(payload.entries, [
    { name: 'a', action: 'replace', text: 'A' },
    { name: 'b', action: 'append', text: 'B', order: 1 },
  ]);
  // The response is the reset response with `legacy` in place of `reset`: same
  // keys, one flag swapped.
  assert.deepEqual(Object.keys(payload).sort(), [
    'count', 'effectiveFrom', 'entries', 'history', 'layer', 'legacy', 'ok', 'removed',
  ]);
  const noop = json(await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&legacy=true` }));
  assert.equal(noop.count, 0, 'the reserved entry survived, so a second clear finds nothing');

  // The reserved entry is untouched and still applies.
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')).overrides, [
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
  ]);
  const page = await history(route);
  assert.equal(page.records[0].action, 'legacy-clear');
  assert.equal(page.records[0].name, null, 'a layer-wide action names no section');
  assert.equal(page.records[0].origin, 'ui');
  assert.deepEqual(page.records[0].entries, [
    { name: 'a', action: 'replace', text: 'A' },
    { name: 'b', action: 'append', text: 'B', order: 1 },
  ]);
  assert.deepEqual(page.records[0].snapshot.map((entry) => entry.name), [CUSTOM_SECTION_NAME]);
  assert.match(page.records[0].note, /legacy clear removed 2/);
  assert.equal(page.records[0].id, payload.history.id);
});

test('stage2: legacy=true on a layer with no frozen override writes nothing at all', async () => {
  const { route } = mount();
  await put(route, { action: 'replace', text: 'MINE' });
  const before = fingerprints([userPath(), userHistoryPath()]);

  const payload = json(await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&legacy=true` }));
  assert.equal(payload.ok, true);
  assert.equal(payload.legacy, true);
  assert.deepEqual(payload.removed, []);
  assert.equal(payload.count, 0);
  assert.equal(payload.entries, undefined, 'the zero-count body mirrors the zero-count reset body');
  assert.equal(payload.history, null);
  assert.deepEqual(fingerprints([userPath(), userHistoryPath()]), before, 'a no-op must not rewrite the file it did not change');
  assert.equal((await history(route)).total, 1, 'and it logs nothing');

  // A layer with no file at all is the same no-op, and still creates nothing.
  rmSync(userPath(), { force: true });
  rmSync(userHistoryPath(), { force: true });
  const fresh = mount();
  const empty = json(await call(fresh.route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&legacy=true` }));
  assert.equal(empty.count, 0);
  assert.equal(empty.history, null);
  assert.throws(() => readFileSync(userPath(), 'utf8'), /ENOENT/, 'a clear that found nothing writes nothing');
});

test('stage2: legacy=true and reset=true are mutually exclusive, and neither flag is guessed', async () => {
  const { route } = mount();
  seedUser([{ name: 'a', action: 'hide' }]);
  const before = fingerprint(userPath());

  const conflict = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&reset=true&legacy=true` });
  assert.equal(conflict.statusCode, 400);
  assert.equal(json(conflict).code, 'conflicting-query');
  assert.equal(fingerprint(userPath()), before, 'a refused clear touches nothing');

  const conflictReversed = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&legacy=true&reset=true` });
  assert.equal(conflictReversed.statusCode, 400);
  assert.equal(json(conflictReversed).code, 'conflicting-query');

  // A non-raw value is not the switch (the §4.3 rule `reset` already follows):
  // `legacy=1` falls through to the single-name semantics, which needs a name.
  const loose = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&legacy=1` });
  assert.equal(loose.statusCode, 400);
  assert.equal(json(loose).code, 'missing-name');
  assert.equal(fingerprint(userPath()), before);

  // `legacy=1` with a name is simply the single-name path — for the reserved
  // name it removes that one entry and nothing else.
  await put(route, { action: 'replace', text: 'MINE' });
  const named = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&legacy=1&name=${encodeURIComponent(CUSTOM_SECTION_NAME)}` });
  assert.equal(named.statusCode, 200);
  assert.equal(json(named).removed, true);
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')).overrides, [{ name: 'a', action: 'hide' }], 'the frozen entry is still there');

  // Both flags need a resolvable layer, exactly like reset.
  const unresolved = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=workspace&legacy=true` });
  assert.equal(unresolved.statusCode, 400);
  assert.equal(json(unresolved).code, 'workspace-unresolved');
  const unknown = await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?legacy=true` });
  assert.equal(unknown.statusCode, 400);
  assert.equal(json(unknown).code, 'unknown-layer');
});

// #endregion

// #region rollback (Revision 21, g-039)

test('stage2: rollback restores a recorded version, appends a rollback record and can be rolled back again (g-039)', async () => {
  const { route } = mount();
  await put(route, { action: 'replace', text: 'A1' });
  await put(route, { action: 'replace', text: 'A2' });
  assert.deepEqual((await history(route)).records.map((record) => record.seq), [2, 1], 'newest first');

  const res = await call(route, {
    method: 'POST',
    url: ROLLBACK_PATH,
    body: JSON.stringify({ layer: 'user', seq: 1 }),
  });
  assert.equal(res.statusCode, 200);
  const payload = json(res);
  assert.equal(payload.ok, true);
  assert.equal(payload.rolledBack, true);
  assert.equal(payload.seq, 1);
  assert.equal(payload.count, 1);
  assert.equal(payload.effectiveFrom, 'next-turn');
  assert.deepEqual(
    JSON.parse(readFileSync(userPath(), 'utf8')).overrides,
    [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'A1' }],
    'the layer on disk IS the recorded version',
  );

  const after = await history(route);
  assert.deepEqual(after.records.map((record) => record.seq), [3, 2, 1]);
  const rollbackRecord = after.records[0];
  assert.equal(rollbackRecord.action, 'rollback');
  assert.equal(rollbackRecord.name, null, 'a rollback is layer-wide');
  assert.equal(rollbackRecord.origin, 'ui');
  assert.equal(rollbackRecord.note, 'rollback to #1');
  assert.deepEqual(
    rollbackRecord.entries,
    [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'A2' }],
    'what the rollback replaced is recorded, which is what makes it a version',
  );
  assert.deepEqual(
    rollbackRecord.snapshot.map((entry) => [entry.name, entry.action]),
    [[CUSTOM_SECTION_NAME, 'replace']],
  );

  // Rolling back again — this time to the version the rollback replaced — proves
  // the rollback record is a version like any other: undoing it restores the
  // list its `entries` carry.
  const again = await call(route, {
    method: 'POST',
    url: ROLLBACK_PATH,
    body: JSON.stringify({ layer: 'user', seq: 2 }),
  });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')).overrides, [
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'A2' },
  ]);
  assert.deepEqual(
    (await history(route)).records.map((record) => record.action),
    ['rollback', 'rollback', 'replace', 'replace'],
    'every rollback is logged, and the log stays a chain',
  );
});

test('stage2: a rollback that cannot be rebuilt answers a stable code and leaves the file byte-identical (g-039)', async () => {
  const { route } = mount();
  await put(route, { action: 'replace', text: 'A1' });
  const before = fingerprint(userPath());

  for (const [body, status, code] of [
    [{ layer: 'user', seq: 99 }, 404, 'history-not-found'],
    [{ layer: 'user', seq: 0 }, 400, 'invalid-seq'],
    [{ layer: 'user', seq: 'x' }, 400, 'invalid-seq'],
    [{ layer: 'user' }, 400, 'invalid-seq'],
    [{ layer: 'nope', seq: 1 }, 400, 'unknown-layer'],
    [{ layer: 'workspace', seq: 1 }, 400, 'workspace-unresolved'],
  ]) {
    const res = await call(route, { method: 'POST', url: ROLLBACK_PATH, body: JSON.stringify(body) });
    assert.equal(res.statusCode, status, JSON.stringify(body));
    assert.equal(json(res).code, code, JSON.stringify(body));
    assert.equal(fingerprint(userPath()), before, `a refused rollback (${code}) touches nothing`);
  }

  // An empty snapshot — the version a whole-layer clear left behind. There is no
  // structure to rebuild, so the refusal is explicit; `?reset=true` is the
  // documented way to reach an empty layer.
  await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&reset=true` });
  const afterReset = fingerprint(userPath());
  const emptySnapshot = await call(route, {
    method: 'POST',
    url: ROLLBACK_PATH,
    body: JSON.stringify({ layer: 'user', seq: 2 }),
  });
  assert.equal(emptySnapshot.statusCode, 409);
  assert.equal(json(emptySnapshot).code, 'history-snapshot-missing');
  assert.equal(fingerprint(userPath()), afterReset);

  // A record that is readable but whose structure is unusable (a hand-edited
  // log): the snapshot entries are checked before anything is written.
  mkdirSync(join(home, 'prompt-setting'), { recursive: true });
  const seedLog = (snapshot) => writeFileSync(
    userHistoryPath(),
    `${JSON.stringify({
      seq: 1,
      at: '2024-01-01T00:00:00.000Z',
      layer: 'user',
      session: null,
      action: 'replace',
      name: 'a',
      origin: 'ui',
      before: null,
      after: { text: 'A1', hash: 'h', bytes: 2 },
      entries: null,
      snapshot,
      note: null,
    })}\n`,
    'utf8',
  );

  // The log and the layer disagree (the config was edited by hand, so the text
  // the snapshot requires is simply not in the chain): refuse rather than write
  // a config no version ever had.
  seedLog([{ name: 'a', action: 'replace', hash: 'h', bytes: 2 }]);
  writeFileSync(userPath(), '{"version":1,"overrides":[]}\n', 'utf8');
  const unavailable = await call(route, {
    method: 'POST',
    url: ROLLBACK_PATH,
    body: JSON.stringify({ layer: 'user', seq: 1 }),
  });
  assert.equal(unavailable.statusCode, 409);
  assert.equal(json(unavailable).code, 'history-rollback-unavailable');
  assert.equal(JSON.parse(readFileSync(userPath(), 'utf8')).overrides.length, 0);

  // A snapshot whose entries are malformed is refused by the same rule.
  seedLog([{ name: 'a', action: 'nope' }]);
  const seeded = fingerprint(userPath());
  const malformed = await call(route, {
    method: 'POST',
    url: ROLLBACK_PATH,
    body: JSON.stringify({ layer: 'user', seq: 1 }),
  });
  assert.equal(malformed.statusCode, 409);
  assert.equal(json(malformed).code, 'invalid-history-snapshot');
  assert.equal(fingerprint(userPath()), seeded);

  // A layer whose own file is unusable is not writable at all (§4.4).
  writeFileSync(userPath(), '{not json', 'utf8');
  const corrupt = fingerprint(userPath());
  const notWritable = await call(route, {
    method: 'POST',
    url: ROLLBACK_PATH,
    body: JSON.stringify({ layer: 'user', seq: 1 }),
  });
  assert.equal(notWritable.statusCode, 409);
  assert.equal(json(notWritable).code, 'layer-not-writable');
  assert.equal(fingerprint(userPath()), corrupt);
});

test('stage2: a workspace rollback is located by workspace=, and the body wins over the query (g-039)', async () => {
  const { route } = mount({ workspaces: [workspaceWith('ws1', 's1')] });
  const write = (text) => call(route, {
    method: 'PUT',
    url: `${OVERRIDES_PATH}?session=s1`,
    body: JSON.stringify({ layer: 'workspace', session: 's1', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text } }),
  });
  assert.equal((await write('W1')).statusCode, 200);
  assert.equal((await write('W2')).statusCode, 200);

  const res = await call(route, {
    method: 'POST',
    url: ROLLBACK_PATH,
    body: JSON.stringify({ layer: 'workspace', workspace: 's1', seq: 1 }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).session, 's1');
  assert.deepEqual(
    JSON.parse(readFileSync(workspacePath('ws1'), 'utf8')).overrides,
    [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'W1' }],
  );
  const log = await call(route, { url: `${HISTORY_PATH}?layer=workspace&workspace=s1` });
  assert.equal(log.statusCode, 200);
  assert.deepEqual(
    json(log).records.map((record) => record.seq),
    [3, 2, 1],
    'the workspace layer keeps its own log',
  );
});

// #endregion

// #region diff

test('stage2: two history records of one section diff at section and line level', async () => {
  const { route } = mount();
  await put(route, { action: 'replace', text: 'one\ntwo' });
  await put(route, { action: 'replace', text: 'one\nTWO\nthree' });
  // A frozen entry in the live layer must not appear in either history version.
  seedUser([
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'one\nTWO\nthree' },
    { name: 'b', action: 'hide' },
  ]);

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
    'records 1 and 2 both concern the reserved section only');
  assert.equal(payload.lines.name, CUSTOM_SECTION_NAME);
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
  await put(route, { action: 'replace', text: 'first' });
  await put(route, { action: 'replace', text: 'second' });

  const payload = json(await call(route, { url: `${DIFF_PATH}?layer=user&from=1` }));
  assert.equal(payload.from.kind, 'history');
  assert.equal(payload.to.kind, 'current');
  assert.equal(payload.to.label, 'current');
  assert.equal(payload.to.at, null);
  assert.equal(payload.lines.name, CUSTOM_SECTION_NAME);
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
  await put(route, { action: 'replace', text: 'x' });

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
  await put(route, { action: 'replace', text: 'A' });
  // A frozen entry the reset will also remove, seeded as a hand edit.
  seedUser([
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'A' },
    { name: 'a', action: 'replace', text: 'A' },
  ]);
  await call(route, { method: 'DELETE', url: `${OVERRIDES_PATH}?layer=user&reset=true` });
  await put(route, { action: 'replace', text: 'B' });

  const payload = json(await call(route, { url: `${DIFF_PATH}?layer=user&from=1` }));
  assert.equal(payload.from.action, 'replace', 'record 1 is the write that came before the reset');
  assert.equal(payload.from.name, CUSTOM_SECTION_NAME);
  assert.equal(payload.from.label, '#1');
  const payload2 = json(await call(route, { url: `${DIFF_PATH}?layer=user&from=2` }));
  assert.equal(payload2.from.action, 'reset-layer');
  assert.equal(payload2.from.name, null);
  assert.deepEqual(payload2.sectionsCounts, { total: 1, changed: 0, added: 1, removed: 0, same: 0 });
  // The reset version holds no text, so the section that appeared after it is
  // reported as pure insertion rather than as a rewrite.
  assert.equal(payload2.lines.name, CUSTOM_SECTION_NAME);
  assert.equal(payload2.lineReason, null);
  assert.equal(payload2.lines.ops.filter((op) => op.type === 'insert')[0].text, 'B');
  assert.equal(payload2.lines.ops.filter((op) => op.type === 'delete')[0].text, '');
});

// #endregion

// #region export

test('stage2: export carries the schema, both layers and no absolute path', async () => {
  const { route } = mount();
  await put(route, { action: 'replace', text: 'A' });
  const res = await call(route, { url: EXPORT_PATH });
  assert.equal(res.statusCode, 200);
  const payload = json(res);
  assert.equal(payload.ok, true);
  assert.equal(payload.schema, 'dsh-prompt-setting/export');
  assert.equal(payload.version, 1);
  assert.equal(payload.pluginVersion, '0.1.4');
  assert.deepEqual(payload.plugin, { name: 'dsh-prompt-setting', version: '0.1.4' });
  assert.equal(Number.isNaN(Date.parse(payload.exportedAt)), false);
  assert.deepEqual(Object.keys(payload.layers), ['user', 'workspace']);
  assert.deepEqual(payload.layers.user.overrides, [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'A' }]);
  assert.equal(payload.layers.workspace.enabled, false);
  assert.match(payload.layers.workspace.reason, /no \?session=/);
  assert.equal(JSON.stringify(payload).includes(home), false, 'no absolute path is exported');
  // Nothing was omitted, and the response still declares the scope explicitly.
  assert.deepEqual(payload.exportScope, { only: CUSTOM_SECTION_NAME, omitted: { user: 0, workspace: 0, total: 0 } });

  const usersOnly = json(await call(route, { url: `${EXPORT_PATH}?layer=user` }));
  assert.deepEqual(Object.keys(usersOnly.layers), ['user']);
  assert.deepEqual(usersOnly.exportScope.omitted, { user: 0, total: 0 }, 'the declaration covers the layers exported');

  const bad = await call(route, { url: `${EXPORT_PATH}?layer=nope` });
  assert.equal(bad.statusCode, 400);
  assert.equal(json(bad).code, 'unknown-layer');
});

test('stage2: export drops frozen overrides and SAYS how many it dropped', async () => {
  const workspaces = [workspaceWith('ws-export', 's-export')];
  const { route } = mount({ workspaces });
  seedUser([
    { name: 'legacy:one', action: 'replace', text: 'ONE' },
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' },
    { name: 'legacy:two', action: 'hide' },
  ]);
  seedWorkspace('ws-export', [{ name: 'legacy:three', action: 'replace', text: 'THREE' }]);

  const payload = json(await call(route, { url: `${EXPORT_PATH}?session=s-export` }));
  assert.deepEqual(payload.layers.user.overrides, [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'MINE' }]);
  assert.deepEqual(payload.layers.workspace.overrides, [], 'the workspace layer holds only a frozen entry');
  assert.deepEqual(payload.exportScope, { only: CUSTOM_SECTION_NAME, omitted: { user: 2, workspace: 1, total: 3 } },
    'a narrowed export is never a silent one');

  // The document it produced re-imports unchanged: it carries only what the
  // import route accepts.
  const document = { schema: payload.schema, version: payload.version, layers: payload.layers };
  const dry = json(await call(route, { method: 'POST', url: `${IMPORT_PATH}?dryRun=true&session=s-export`, body: JSON.stringify(document) }));
  assert.equal(dry.unchanged, true);
  assert.deepEqual(dry.totals, { added: 0, replaced: 0, unchanged: 1, removed: 0, kept: 3 },
    'the three frozen entries are kept, not rewritten');

  const userOnly = json(await call(route, { url: `${EXPORT_PATH}?layer=user` }));
  assert.deepEqual(userOnly.exportScope, { only: CUSTOM_SECTION_NAME, omitted: { user: 2, total: 2 } });
});

test('stage2: an export of the workspace layer needs a resolvable session', async () => {
  const workspaces = [workspaceWith('ws-two', 's2')];
  const { route } = mount({ workspaces });
  await call(route, {
    method: 'PUT',
    url: `${OVERRIDES_PATH}?session=s2`,
    body: JSON.stringify({ layer: 'workspace', session: 's2', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'W' } }),
  });
  const payload = json(await call(route, { url: `${EXPORT_PATH}?session=s2` }));
  assert.equal(payload.layers.workspace.enabled, true);
  assert.deepEqual(payload.layers.workspace.overrides, [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'W' }]);
});

// #endregion

// #region import

test('stage2: a dry run reports the plan and writes nothing at all', async () => {
  const { route } = mount();
  // Two frozen entries in the layer; the document brings one reserved entry.
  seedUser([
    { name: 'a', action: 'replace', text: 'LOCAL' },
    { name: 'b', action: 'hide' },
  ]);
  const document = json(await call(route, { url: EXPORT_PATH }));
  document.layers.user.overrides = [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'IMPORTED' }];
  const before = fingerprints([userPath(), userHistoryPath()]);

  const res = await call(route, { method: 'POST', url: `${IMPORT_PATH}?dryRun=true`, body: JSON.stringify(document) });
  assert.equal(res.statusCode, 200);
  const payload = json(res);
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.applied, false);
  assert.equal(payload.mode, 'merge');
  assert.deepEqual(payload.totals, { added: 1, replaced: 0, unchanged: 0, removed: 0, kept: 2 });
  assert.deepEqual(payload.layers.user.counts, { added: 1, replaced: 0, unchanged: 0, removed: 0, kept: 2 });
  assert.deepEqual(payload.layers.user.changes, [
    { name: CUSTOM_SECTION_NAME, status: 'added', action: 'replace' },
  ]);
  assert.deepEqual(payload.imported, ['user']);
  assert.deepEqual(payload.skipped, [{ layer: 'workspace', reason: 'layer "workspace" requires a "session" id to resolve the workspace root', entries: 0 }]);
  assert.equal(payload.unchanged, false);
  assert.deepEqual(fingerprints([userPath(), userHistoryPath()]), before, 'a dry run touches nothing');

  // The other half of the plan shape — `removed` and `kept` — is reachable
  // through `mode=replace`, which is the only way this narrowed write face can
  // still remove anything.
  const replace = json(await call(route, { method: 'POST', url: `${IMPORT_PATH}?dryRun=true&mode=replace`, body: JSON.stringify(document) }));
  assert.deepEqual(replace.totals, { added: 1, replaced: 0, unchanged: 0, removed: 2, kept: 0 });
  assert.deepEqual(replace.layers.user.changes.map((change) => [change.name, change.status]), [
    [CUSTOM_SECTION_NAME, 'added'],
    ['a', 'removed'],
    ['b', 'removed'],
  ]);
  assert.deepEqual(fingerprints([userPath(), userHistoryPath()]), before, 'and so does the replace dry run');
});

test('stage2: re-importing an unchanged export is recognised as a no-op', async () => {
  const { route } = mount();
  await put(route, { action: 'replace', text: 'A' });
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
  // The workspace layer's frozen entry, as a hand edit; the import below must
  // keep it and append its own after it.
  seedWorkspace('ws-three', [{ name: 'keep', action: 'hide' }]);
  const document = {
    schema: 'dsh-prompt-setting/export',
    version: 1,
    exportedAt: '2024-01-01T00:00:00.000Z',
    layers: {
      user: { layer: 'user', overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'A' }] },
      workspace: { layer: 'workspace', overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'W' }] },
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
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')).overrides, [
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'A' },
  ]);
  assert.deepEqual(
    JSON.parse(readFileSync(workspacePath('ws-three'), 'utf8')).overrides.map((entry) => entry.name),
    ['keep', CUSTOM_SECTION_NAME],
    'merge keeps the local entry\'s position and appends the imported one',
  );
  assert.equal(payload.history.user[0].ok, true);
  assert.equal(payload.history.workspace[0].ok, true);

  const userPage = await history(route);
  assert.equal(userPage.records[0].origin, 'import');
  assert.equal(userPage.records[0].action, 'replace');
  assert.equal(userPage.records[0].name, CUSTOM_SECTION_NAME);
  assert.equal(userPage.records[0].before, null);
  assert.equal(userPage.records[0].after.text, 'A');
  assert.match(userPage.records[0].note, /import mode=merge status=added/);

  const workspacePage = json(await call(route, { url: `${HISTORY_PATH}?layer=workspace&session=s3` }));
  assert.equal(workspacePage.records[0].origin, 'import');
  assert.deepEqual(workspacePage.records[0].snapshot.map((entry) => entry.name), ['keep', CUSTOM_SECTION_NAME]);
});

test('stage2: mode=replace removes local extras and logs the removals', async () => {
  const { route } = mount();
  seedUser([
    { name: 'a', action: 'replace', text: 'LOCAL' },
    { name: 'b', action: 'hide' },
  ]);
  const document = {
    schema: 'dsh-prompt-setting/export',
    version: 1,
    layers: { user: { layer: 'user', overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'IMPORTED' }] } },
  };
  const dry = json(await call(route, { method: 'POST', url: `${IMPORT_PATH}?dryRun=true&mode=replace`, body: JSON.stringify(document) }));
  assert.equal(dry.mode, 'replace');
  assert.deepEqual(dry.totals, { added: 1, replaced: 0, unchanged: 0, removed: 2, kept: 0 });
  assert.deepEqual(dry.layers.user.changes.map((change) => [change.name, change.status]), [
    [CUSTOM_SECTION_NAME, 'added'],
    ['a', 'removed'],
    ['b', 'removed'],
  ]);

  const applied = json(await call(route, { method: 'POST', url: `${IMPORT_PATH}?mode=replace`, body: JSON.stringify(document) }));
  assert.equal(applied.applied, true);
  assert.deepEqual(JSON.parse(readFileSync(userPath(), 'utf8')).overrides, [
    { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'IMPORTED' },
  ]);
  const page = await history(route);
  assert.deepEqual(page.records.map((record) => [record.action, record.name, record.origin]), [
    ['remove', 'b', 'import'],
    ['remove', 'a', 'import'],
    ['replace', CUSTOM_SECTION_NAME, 'import'],
  ]);
  assert.equal(page.records[0].before, null, 'a hidden section has no text to record');
});

test('stage2: a body-supplied mode is honoured, and the query wins', async () => {
  const { route } = mount();
  seedUser([{ name: 'local', action: 'hide' }]);
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
  seedUser([{ name: 'existing', action: 'hide' }]);
  const document = {
    schema: 'dsh-prompt-setting/export',
    version: 1,
    layers: {
      user: { layer: 'user', overrides: [{ name: CUSTOM_SECTION_NAME, action: 'hide' }] },
      workspace: { layer: 'workspace', overrides: [{ name: CUSTOM_SECTION_NAME, action: 'hide' }] },
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
      JSON.stringify({ schema: 'dsh-prompt-setting/export', version: 1, layers: { user: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'delete', text: 'x' }] } } }),
      'unknown-action',
    ],
    [
      'missing text',
      JSON.stringify({ schema: 'dsh-prompt-setting/export', version: 1, layers: { user: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace' }] } } }),
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
              { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'x' },
              { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'y' },
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
        layers: { user: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'x'.repeat(200 * 1024 + 1) }] } },
      }),
      'text-too-large',
    ],
    // Revision 7's write lock. Note the order: the document is schema-validated
    // first, so a malformed entry answers its field code above; a well-formed
    // legacy entry reaches this wall.
    [
      'a frozen section name',
      JSON.stringify({ schema: 'dsh-prompt-setting/export', version: 1, layers: { user: { overrides: [{ name: 'project:alpha', action: 'replace', text: 'x' }] } } }),
      'write-locked',
    ],
    [
      'a frozen name in a layer the request does not import',
      JSON.stringify({
        schema: 'dsh-prompt-setting/export',
        version: 1,
        layers: {
          user: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'x' }] },
          workspace: { overrides: [{ name: 'project:beta', action: 'hide' }] },
        },
      }),
      'write-locked',
    ],
  ];
}

test('stage2: every rejected import leaves BOTH config files and the history byte-identical', async () => {
  const workspaces = [workspaceWith('ws-five', 's5')];
  const { route } = mount({ workspaces });
  seedUser([{ name: 'local', action: 'replace', text: 'LOCAL TEXT' }]);
  seedWorkspace('ws-five', [{ name: 'w', action: 'hide' }]);
  const paths = [userPath(), userHistoryPath(), workspacePath('ws-five'), workspaceHistoryPath('ws-five')];
  const before = fingerprints(paths);

  for (const [what, body, code] of rejectedDocuments()) {
    const res = await call(route, { method: 'POST', url: `${IMPORT_PATH}?session=s5`, body });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `${what} must be a 4xx, got ${res.statusCode}`);
    assert.equal(json(res).code, code, `${what} must answer ${code}`);
    assert.deepEqual(fingerprints(paths), before, `${what} must not touch any file`);
    assert.deepEqual(tempFiles(home), [], `${what} must leave no temp file`);
    if (code === 'write-locked') {
      // The dry run must refuse the very same document: a dry run answers the
      // question the real run would answer.
      const dry = await call(route, { method: 'POST', url: `${IMPORT_PATH}?session=s5&dryRun=true`, body });
      assert.equal(dry.statusCode, 403, `${what} must be refused by a dry run too`);
      assert.equal(json(dry).code, 'write-locked');
      assert.deepEqual(fingerprints(paths), before, `${what} must not be touched by the dry run either`);
    }
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
  seedUser([{ name: 'local', action: 'hide' }]);
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
  // The PUT cap is unchanged, and it is smaller than the import cap. The size
  // cap is checked while reading the body, so it wins over any write policy.
  const putTooLarge = await call(route, {
    method: 'PUT',
    url: OVERRIDES_PATH,
    body: JSON.stringify({ layer: 'user', section: { name: CUSTOM_SECTION_NAME, action: 'replace', text: 'x' }, pad: 'y'.repeat(300 * 1024) }),
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
      layers: { user: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'x' }] } },
    }),
  });
  assert.equal(res.statusCode, 409);
  assert.equal(json(res).code, 'layer-not-writable');
  assert.equal(fingerprint(userPath()), before);
});

test('stage2: an unresolvable workspace aborts the whole import, user layer included', async () => {
  const { route } = mount();
  seedUser([{ name: 'local', action: 'hide' }]);
  const before = fingerprints([userPath(), userHistoryPath()]);
  const res = await call(route, {
    method: 'POST',
    url: IMPORT_PATH,
    body: JSON.stringify({
      schema: 'dsh-prompt-setting/export',
      version: 1,
      layers: {
        user: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'x' }] },
        workspace: { overrides: [{ name: CUSTOM_SECTION_NAME, action: 'replace', text: 'y' }] },
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

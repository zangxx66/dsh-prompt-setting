/**
 * Host-half assertions for stage 1A: the manifest contract, the read-only
 * probe route, the trust fence, and the failure modes the acceptance criteria
 * name explicitly (wrong method, missing browser trust marker).
 *
 * Run: `node --test test/`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply, inject } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8');
const patchSource = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8');

const PING_PATH = '/prompt-setting/ping';

/** Minimal Node response double: records status, headers and body. */
function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    end(chunk) {
      this.body = chunk === undefined || chunk === null ? '' : String(chunk);
      this.ended = true;
    },
  };
}

/** Minimal Node request double: the handler reads only these three fields. */
function makeRequest({ method = 'GET', url = PING_PATH, headers = {} } = {}) {
  return { method, url, headers };
}

/**
 * Mount the plugin against doubles.
 * @param options.requestRejection - what the connection service returns.
 * @param options.omitConnection - mount without a connection service.
 * @returns the captured route plus the ctx doubles.
 */
function mount(options = {}) {
  const routes = [];
  let disposed = 0;
  const ctx = {
    connection:
      options.omitConnection === true
        ? undefined
        : { requestRejection: options.requestRejection ?? (() => undefined) },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          disposed += 1;
        };
      },
    },
    effect(factory) {
      return factory();
    },
  };
  apply(ctx);
  return { ctx, routes, route: routes[0], disposedCount: () => disposed };
}

async function call(route, { method = 'GET', url = PING_PATH, rejection } = {}) {
  const res = makeResponse();
  await route.handler(makeRequest({ method, url }), res);
  return res;
}

test('manifest: bundle, client and publish contract', () => {
  assert.equal(packageJson.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(packageJson.dsh?.client?.platform, 'web');
  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.exports['.'], './index.js');
  assert.equal(packageJson.exports['./client'], './client.js');
  assert.equal(packageJson.exports['./package.json'], './package.json');
  assert.equal(packageJson.engines?.node, '>=22');
  assert.match(packageJson.peerDependencies['@deepseek-ai/dsh'], /^>=0\.1\.7-rc\.2 <0\.1\.8-0$/);
  assert.deepEqual(packageJson.dependencies, {}, 'zero runtime dependencies');
  assert.deepEqual(packageJson.files, [
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'README.md',
    'NOTES.md',
  ]);
  // The `files` allowlist is what keeps `npm pack` free of .dsh-graph,
  // node_modules and .worktrees entries.
  assert.equal(packageJson.files.includes('test'), false);
});

test('manifest: version constant stays in lockstep with package.json', async () => {
  const probe = await call(mount().route);
  assert.equal(JSON.parse(probe.body).version, packageJson.version);
});

test('bundle patch: one insert row named after the package', () => {
  assert.match(patchSource, /- insert:/);
  assert.match(patchSource, /id: prompt-setting/);
  assert.match(patchSource, new RegExp(`name: ${packageJson.name}`));
  // A second row with the same package name would run the Host apply twice and
  // double-register the /prompt-setting prefix.
  const rowCount = patchSource.split('name:').length - 1;
  assert.equal(rowCount, 1);
});

test('host: injects exactly webServer and connection', () => {
  assert.deepEqual(inject, ['webServer', 'connection']);
});

test('host: one prefix route owns the /prompt-setting prefix', () => {
  const { routes, route } = mount();
  assert.equal(routes.length, 1);
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/prompt-setting');
});

test('host: GET /prompt-setting/ping answers 200 JSON', async () => {
  const res = await call(mount().route);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.plugin, packageJson.name);
  assert.equal(payload.version, packageJson.version);
  assert.equal(Number.isNaN(Date.parse(payload.time)), false);
});

test('host: a non-GET ping is rejected with 405 and an allow header', async () => {
  const res = await call(mount().route, { method: 'POST' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['allow'], 'GET');
  assert.equal(res.body, '');
});

test('host: an unknown sub-path under the prefix is a JSON 404', async () => {
  const res = await call(mount().route, { url: '/prompt-setting/prompt/assemble' });
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).code, 'not-found');
});

test('host: no client report yet reads as null', async () => {
  const payload = JSON.parse((await call(mount().route)).body);
  assert.equal(payload.clientRenderer, null);
  assert.equal(payload.clientReportedAt, null);
});

test('host: a legal renderer report is recorded and echoed', async () => {
  const { route } = mount();
  const reported = JSON.parse((await call(route, { url: `${PING_PATH}?renderer=fallback` })).body);
  assert.equal(reported.clientRenderer, 'fallback');
  assert.equal(Number.isNaN(Date.parse(reported.clientReportedAt)), false);
  // The report persists for later probes, which is what makes one curl enough.
  const again = JSON.parse((await call(route)).body);
  assert.equal(again.clientRenderer, 'fallback');
  assert.equal(again.clientReportedAt, reported.clientReportedAt);
});

test('host: an illegal renderer report is ignored and the probe still answers 200', async () => {
  const hostile = ['../../etc/passwd', '1', 'true', 'PRIMITIVES', 'primitives,fallback', '\u0000'];
  for (const value of hostile) {
    const { route } = mount();
    const res = await call(route, { url: `${PING_PATH}?renderer=${encodeURIComponent(value)}` });
    assert.equal(res.statusCode, 200, `value ${JSON.stringify(value)} must not change the status`);
    const payload = JSON.parse(res.body);
    assert.equal(payload.clientRenderer, null, `value ${JSON.stringify(value)} must be ignored`);
    assert.equal(payload.clientReportedAt, null);
  }
  // An empty value is "present but not in the whitelist" — still ignored.
  const empty = JSON.parse((await call(mount().route, { url: `${PING_PATH}?renderer=` })).body);
  assert.equal(empty.clientRenderer, null);
});

test('host: an illegal report cannot overwrite a recorded one', async () => {
  const { route } = mount();
  await call(route, { url: `${PING_PATH}?renderer=primitives` });
  const res = await call(route, { url: `${PING_PATH}?renderer=../../etc/passwd` });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).clientRenderer, 'primitives');
});

test('host: a non-GET request never records a report', async () => {
  const { route } = mount();
  const res = await call(route, { method: 'POST', url: `${PING_PATH}?renderer=primitives` });
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse((await call(route)).body).clientRenderer, null);
});

test('host: a rejected request never records a report', async () => {
  const { route } = mount({ requestRejection: () => 403 });
  const res = await call(route, { url: `${PING_PATH}?renderer=primitives` });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, '');
});

test('host: a refused trust marker rejects before any route logic', async () => {
  const res = await call(mount({ requestRejection: () => 403 }).route);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, '');
});

test('host: the trust fence sees the request and runs before method checks', async () => {
  const seen = [];
  const res = await call(
    mount({
      requestRejection: (req) => {
        seen.push(req.method);
        return 401;
      },
    }).route,
    { method: 'POST' },
  );
  assert.deepEqual(seen, ['POST']);
  // Rejected as unauthenticated, not as a wrong method.
  assert.equal(res.statusCode, 401);
});

test('host: a missing connection service fails closed with 503', async () => {
  const res = await call(mount({ omitConnection: true }).route);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).code, 'trust-fence-unavailable');
});

test('client: registers as a lazy factory with the package name as id', () => {
  assert.match(clientSource, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(clientSource, new RegExp(`id: '${packageJson.name}'`));
  // No JSX and no build step: the module must only build elements through the
  // React factory it requires.
  assert.equal(/<[A-Za-z][^>]*>/.test(clientSource), false);
  assert.match(clientSource, /window\.__ModuleLoader__/);
});

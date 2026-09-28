/**
 * `dsh-prompt-setting` — Host half (stage 1A: skeleton + read-only probe).
 *
 * Stage 1A owns exactly one route: `GET /prompt-setting/ping`. The prompt
 * assembly/override engine of stage 1B adds further routes under the same
 * `/prompt-setting` prefix; the trust fence, the JSON responder and the
 * prefix-owned 404 below are meant to survive that change unchanged.
 *
 * No DSH Host package is imported. The only Host APIs used are the
 * `webServer` and `connection` services, read off `ctx`.
 *
 * @module dsh-prompt-setting
 */

/** Package name; echoed by the probe so the browser can assert identity. */
const PLUGIN_NAME = 'dsh-prompt-setting';
/** Package version; `test/host-probe.test.mjs` asserts it matches package.json. */
const PLUGIN_VERSION = '0.1.0';
/** The one prefix this plugin owns. Every future route lives under it. */
const ROUTE_PREFIX = '/prompt-setting';
/** Stage 1A's only route: a read-only liveness probe. */
const PING_PATH = `${ROUTE_PREFIX}/ping`;

/**
 * Required Host services. Declaring both makes the Loader resolve them before
 * `apply` runs, so the trust fence never meets a missing `connection` service
 * in a correctly composed profile.
 */
export const inject = ['webServer', 'connection'];

/**
 * Write one JSON response. `no-store`: a probe answer and the plugin version
 * are live facts, not cacheable assets.
 * @param res - the Node response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * 405 carrying the route's one supported method.
 * @param res - the Node response.
 * @param allow - the supported method name.
 */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405;
  res.setHeader('allow', allow);
  res.end();
}

/**
 * Answer an untrusted/unauthenticated request before any route logic runs —
 * the same fence `dsh-host-open-in-app` puts in front of its routes.
 * @param ctx - the Host plugin context.
 * @param req - the Node request.
 * @param res - the Node response.
 * @returns true when the request was already rejected and the handler must stop.
 */
function rejected(ctx, req, res) {
  const connection = Reflect.get(ctx, 'connection');
  if (connection === undefined || connection === null) {
    // Fail closed: without the fence we cannot tell a browser request from
    // anything else, so refuse rather than serve anything unauthenticated.
    sendJson(res, 503, {
      code: 'trust-fence-unavailable',
      message: 'the connection service is not available',
    });
    return true;
  }
  const rejection = connection.requestRejection(req);
  if (rejection === undefined) return false;
  res.statusCode = rejection;
  res.end();
  return true;
}

/**
 * Pathname of the request. A prefix route receives the full URL, so the
 * dispatcher resolves it against a throwaway origin instead of assuming a
 * stripped remainder.
 * @param req - the Node request.
 * @returns the request pathname.
 */
function pathnameOf(req) {
  return new URL(String(req.url ?? '/'), 'http://localhost').pathname;
}

/**
 * Mount the read-only probe route.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          if (rejected(ctx, req, res)) return;
          const pathname = pathnameOf(req);
          if (pathname !== PING_PATH) {
            sendJson(res, 404, {
              code: 'not-found',
              message: `no route for ${pathname}`,
            });
            return;
          }
          if (req.method !== 'GET') {
            sendMethodNotAllowed(res, 'GET');
            return;
          }
          sendJson(res, 200, {
            ok: true,
            plugin: PLUGIN_NAME,
            version: PLUGIN_VERSION,
            time: new Date().toISOString(),
          });
        },
      }),
    `prompt-setting: GET ${PING_PATH}`,
  );
}

// HTTP server: one Node http process, stdlib only.
//
// Routes, in order:
//   GET  /healthz                        -> 200 {"ok":true} (open)
//   /{owner}/{repo}.git/info/refs        -> git advertisement (auth)
//   /{owner}/{repo}.git/git-upload-pack  -> upload-pack v0/v2 (auth)
//   /{owner}/{repo}.git/git-receive-pack -> receive-pack v0 (auth)
//   /api/v3/...                          -> REST v3 (auth except / and /meta)
//   POST /api/graphql                    -> GraphQL (auth)
//   POST /mcp                            -> MCP JSON-RPC (auth)
// Everything else is a JSON 404, never HTML. Auth is Bearer
// MAKEFUN_SHOP_TOKEN; missing or wrong token is 401 with a JSON body.
// Bodies are capped (32 MiB) so a bad client cannot grow the process
// without bound. Keep-alive is on by default in Node's server, which is
// what the 2,000-request read workload needs.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { infoRefs, uploadPack, receivePack } from './githttp.ts';
import { handleRest, type RestReply } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY = 32 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, obj: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(body);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(body);
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function createApp(store: Store = new Store()) {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const method = req.method ?? 'GET';
        const path = decodeURIComponent(url.pathname);
        const segments = path.split('/').filter((s) => s !== '');

        if (path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const authed = store.checkToken(req.headers.authorization);
        if (!authed) {
          const needsAuth =
            (segments.length >= 3 && segments[1]!.endsWith('.git')) ||
            (segments[0] === 'api' && segments[1] === 'v3' && !(segments.length === 2 || (segments.length === 3 && segments[2] === 'meta'))) ||
            path === '/api/graphql' ||
            path === '/mcp';
          if (needsAuth) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
        }

        // ---- git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
          const owner = segments[0]!;
          const repoName = segments[1]!.slice(0, -4);
          const tail = segments.slice(2).join('/');
          if (tail === 'info/refs' && method === 'GET') {
            const service = url.searchParams.get('service');
            const isV2 = req.headers['git-protocol'] === 'version=2';
            const out = infoRefs(store, owner, repoName, service, isV2);
            sendRaw(res, out.status, out.contentType, out.body);
            return;
          }
          if (tail === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            const isV2 = req.headers['git-protocol'] === 'version=2';
            const out = uploadPack(store, owner, repoName, body, isV2);
            sendRaw(res, out.status, out.contentType, out.body);
            return;
          }
          if (tail === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            const out = receivePack(store, owner, repoName, body);
            sendRaw(res, out.status, out.contentType, out.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // ---- REST v3
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const restSegments = segments.slice(2);
          const raw = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
          let body: unknown = {};
          if (raw.length > 0) {
            const parsed = parseJsonBody(raw);
            if (!parsed.ok) {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
            body = parsed.value;
          }
          const reply: RestReply | null = handleRest({
            store,
            method,
            segments: restSegments,
            query: url.searchParams,
            body,
            host: req.headers.host ?? '127.0.0.1',
          });
          if (reply === null) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          store.reqCounter += 1;
          const headers: Record<string, string> = {
            'X-GitHub-Request-Id': `req-${store.reqCounter}`,
            ...(reply.headers ?? {}),
          };
          if (reply.status === 204) {
            res.writeHead(204, headers);
            res.end();
            return;
          }
          sendJson(res, reply.status, reply.json ?? { message: 'Not Found' }, headers);
          return;
        }

        // ---- GraphQL
        if (path === '/api/graphql' && method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          const out = handleGraphql(store, parsed.value);
          sendJson(res, out.status, out.json);
          return;
        }

        // ---- MCP
        if (path === '/mcp' && method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          const out = handleMcp(store, parsed.ok ? parsed.value : null, parsed.ok);
          sendJson(res, out.status, out.json);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: `internal error: ${(err as Error).message}` });
        } else {
          res.end();
        }
      }
    })();
  });
  return server;
}

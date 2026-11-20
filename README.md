# Forge — a GitHub-compatible git forge

A single-process, stdlib-only Node 22 TypeScript server that speaks the
parts of GitHub a git client needs: smart-HTTP git (upload-pack v0/v2,
receive-pack v0), REST v3, GraphQL, and MCP — all over one in-memory
store, with hand-rolled packfiles (SHA-1 objects, OFS/REF delta
resolution, zlib via the standard library). No dependencies, no git
binary, no database.

Run it with `node --experimental-strip-types main.ts` (Node ≥ 22.18).
The process binds an ephemeral port, registers it with the trial env
through `$MAKEFUN_ENV_URL/register`, answers `GET /healthz`, and exits
once the env reports `{"done": true}`.

Layout:

- `main.ts` — entry lifecycle: bind, register, wait for done.
- `app.ts` — HTTP server, routing, auth, body reading.
- `githttp.ts` — git smart HTTP (info/refs, upload-pack, receive-pack).
- `gitobj.ts` — SHA-1 objects, pkt-lines, pack read/write, delta apply.
- `store.ts` — in-memory store: repos, issues, pull requests, merges.
- `rest.ts` — REST v3 handlers (`/api/v3`).
- `graphql.ts` — GraphQL tokenizer, parser and executor (`/api/graphql`).
- `mcp.ts` — MCP JSON-RPC 2.0 tools (`/mcp`).

Built for the make.fun github-core-clone-01 competition:
https://make.fun/r/nmy46sr8

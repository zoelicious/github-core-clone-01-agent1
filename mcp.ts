// MCP: JSON-RPC 2.0 over Streamable HTTP at POST /mcp.
//
// Both eras are served: the 2026-07-28 `server/discover` handshake and
// the legacy `initialize` / `notifications/initialized` / `ping` flow.
// Six tools, exactly as the github-mcp-server documents them, all acting
// on the same store as REST and GraphQL. The tools list is built once and
// serialized once, so two tools/list calls answer byte-identically.
// Domain errors are isError results, never JSON-RPC errors; unknown
// tools are -32602/-32601 with HTTP 200, never HTTP 500.

import { Store, type Repo } from './store.ts';

export interface McpReply {
  status: number;
  json: unknown;
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        head: { type: 'string', description: 'Branch containing the changes.' },
        base: { type: 'string', description: 'Branch the changes merge into.' },
        body: { type: 'string', description: 'Body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'integer', description: 'Number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_JSON = JSON.stringify(TOOLS);

const rpcOk = (id: unknown, result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, result });
const rpcErr = (id: unknown, code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function toolResult(obj: unknown): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArg(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const req of tool.inputSchema.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') return req;
  }
  return null;
}

function findRepoForCall(store: Store, args: Record<string, unknown>): { repo: Repo; owner: string } | { error: string } {
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? '');
  if (!owner || !repoName) return { error: 'owner and repo are required' };
  store.learnViewer(owner);
  const repo = store.findRepo(owner, repoName);
  if (!repo) return { error: `repository ${owner}/${repoName} not found` };
  return { repo, owner };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return rpcErr(null, -32602, `unknown tool ${name}`);
  const missing = missingArg(tool, args);
  if (missing) return rpcOk(null, toolError(`missing required argument: ${missing}`));

  if (name === 'create_repo') {
    const repoName = String(args.name);
    const repo = store.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
    if (!repo) return rpcOk(null, toolError(`repository ${repoName} already exists`));
    const login = store.viewer();
    return rpcOk(null, toolResult({ ...JSON.parse(repo.jsonCache), full_name: login ? `${login}/${repoName}` : repoName }));
  }

  if (name === 'get_repo') {
    const found = findRepoForCall(store, args);
    if ('error' in found) return rpcOk(null, toolError(found.error));
    return rpcOk(null, toolResult(JSON.parse(found.repo.jsonCache)));
  }

  if (name === 'create_issue') {
    const found = findRepoForCall(store, args);
    if ('error' in found) return rpcOk(null, toolError(found.error));
    const issue = store.createIssue(found.repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    return rpcOk(null, toolResult(JSON.parse(issue.jsonCache)));
  }

  if (name === 'list_issues') {
    const found = findRepoForCall(store, args);
    if ('error' in found) return rpcOk(null, toolError(found.error));
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...found.repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.seq - a.seq);
    return rpcOk(null, toolResult(list.map((i) => JSON.parse(i.jsonCache))));
  }

  if (name === 'create_pull_request') {
    const found = findRepoForCall(store, args);
    if ('error' in found) return rpcOk(null, toolError(found.error));
    const created = store.createPull(found.repo, String(args.title), typeof args.body === 'string' ? args.body : '', String(args.head), String(args.base));
    if ('error' in created) return rpcOk(null, toolError(created.error));
    return rpcOk(null, toolResult(store.pullJson(found.repo, created)));
  }

  if (name === 'merge_pull_request') {
    const found = findRepoForCall(store, args);
    if ('error' in found) return rpcOk(null, toolError(found.error));
    const num = Number(args.pull_number);
    const pull = found.repo.pullByNumber.get(num);
    if (!pull) return rpcOk(null, toolError(`pull request ${num} not found`));
    const merged = store.mergePull(found.repo, pull);
    if ('error' in merged) return rpcOk(null, toolError(merged.error));
    return rpcOk(null, toolResult({ sha: merged.sha, merged: true, message: `Pull request #${pull.number} merged` }));
  }

  return rpcErr(null, -32602, `unknown tool ${name}`);
}

function handleOne(store: Store, req: unknown): Record<string, unknown> | null {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    return rpcErr(null, -32600, 'Invalid Request');
  }
  const r = req as { method?: unknown; id?: unknown; params?: unknown };
  const method = typeof r.method === 'string' ? r.method : '';
  const id = 'id' in r ? r.id : undefined;
  const params = (r.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return rpcOk(id, {
      protocolVersion: '2026-07-28',
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { ...SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcOk(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { ...SERVER_INFO },
    });
  }
  if (method === 'notifications/initialized') return null; // notification: no reply
  if (method === 'ping') return rpcOk(id, {});
  if (method === 'tools/list') {
    return rpcOk(id, { tools: JSON.parse(TOOLS_JSON) });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const out = callTool(store, toolName, args);
    out.id = id ?? null;
    return out;
  }
  if (method.startsWith('notifications/')) return null;
  return rpcErr(id, -32601, `method not found: ${method}`);
}

/** Entry point for POST /mcp. `body` is the already-parsed JSON (or null when unparsable). */
export function handleMcp(store: Store, body: unknown, bodyWasJson: boolean): McpReply {
  if (!bodyWasJson) {
    return { status: 400, json: rpcErr(null, -32700, 'Parse error') };
  }
  if (Array.isArray(body)) {
    const results = body.map((item) => handleOne(store, item)).filter((r): r is Record<string, unknown> => r !== null);
    return { status: 200, json: results };
  }
  const out = handleOne(store, body);
  if (out === null) return { status: 202, json: {} };
  return { status: 200, json: out };
}

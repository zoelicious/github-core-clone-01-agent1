// REST v3 handlers (the /api/v3 tree).
//
// Every reply here is JSON, carries X-GitHub-Request-Id (an incrementing
// counter — deterministic, never random), and uses the store's cached
// serializations on the read-heavy paths so 2,000 sequential issue GETs
// stay cheap. The router in app.ts owns auth gating and URL decoding;
// this module only decides what a path means for a known repo.

import { Store, DEFAULT_BRANCH, type Repo } from './store.ts';

export interface RestCtx {
  store: Store;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  host: string;
}

export interface RestReply {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  raw?: string;
}

function ok(status: number, json: unknown, headers?: Record<string, string>): RestReply {
  return { status, json, headers };
}

function err(status: number, message: string): RestReply {
  return { status, json: { message } };
}

const hasBody = (b: unknown): b is Record<string, unknown> => typeof b === 'object' && b !== null && !Array.isArray(b);

function stringField(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  return typeof v === 'string' ? v : null;
}

function boolField(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = body[key];
  return typeof v === 'boolean' ? v : fallback;
}

function isRepoSegment(parts: string[]): parts is [string, string, string] {
  return parts.length >= 3 && parts[0] === 'repos';
}

function findRepo(ctx: RestCtx): Repo | null {
  if (!isRepoSegment(ctx.segments)) return null;
  return ctx.store.findRepo(ctx.segments[1]!, ctx.segments[2]!);
}

function absoluteUrl(ctx: RestCtx, path: string): string {
  return `http://${ctx.host}${path}`;
}

function paginate<T>(ctx: RestCtx, items: readonly T[], path: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? 30) || 30));
  const pageNum = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (pageNum < totalPages) {
    const base = `${path}?per_page=${perPage}`;
    headers.Link = `<${absoluteUrl(ctx, `${base}&page=${pageNum + 1}`)}>; rel="next", <${absoluteUrl(ctx, `${base}&page=${totalPages}`)}>; rel="last"`;
  }
  return { page, headers };
}

export function handleRest(ctx: RestCtx): RestReply | null {
  const { store, method, segments } = ctx;
  if (segments.length === 0) {
    if (method === 'GET') return ok(200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'X-OAuth-Scopes': 'repo, read:org' });
    return err(404, 'Not Found');
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    return method === 'GET' ? ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true }) : err(404, 'Not Found');
  }
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const login = store.viewer();
      return ok(200, { login, id: 1, type: 'User', name: login, html_url: `https://example.invalid/${login}` });
    }
    if (segments[1] === 'repos') {
      if (method === 'GET') {
        const list = store.reposInOrder.map((r) => JSON.parse(r.jsonCache) as Record<string, unknown>);
        const { page, headers } = paginate(ctx, list, '/api/v3/user/repos');
        return ok(200, page, headers);
      }
      if (method === 'POST') {
        if (!hasBody(ctx.body)) return err(400, 'request body must be a JSON object');
        const name = stringField(ctx.body, 'name');
        if (!name) return err(422, 'name is required');
        const repo = store.createRepo(name, boolField(ctx.body, 'private', false), stringField(ctx.body, 'description') ?? '');
        if (!repo) return err(422, 'name already exists on this account');
        return ok(201, JSON.parse(repo.jsonCache));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }
  if (!isRepoSegment(segments)) return err(404, 'Not Found');
  const owner = segments[1]!;
  const name = segments[2]!;
  const repo = store.findRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  const rest = segments.slice(3);

  // ---- repo itself
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, JSON.parse(repo.jsonCache));
    if (method === 'PATCH') {
      if (!hasBody(ctx.body)) return err(400, 'request body must be a JSON object');
      const desc = stringField(ctx.body, 'description');
      if (desc !== null) repo.description = desc;
      store.refreshRepoJson(repo);
      return ok(200, JSON.parse(repo.jsonCache));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, json: undefined };
    }
    return err(404, 'Not Found');
  }

  // ---- branches
  if (rest[0] === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const out = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .sort()
        .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) } }));
      return ok(200, out);
    }
    if (rest.length === 2) {
      const branch = rest[1]!;
      const sha = repo.branchTip(branch);
      if (!sha) return err(404, 'Not Found');
      if (method !== 'GET') return err(404, 'Not Found');
      return ok(200, { name: branch, commit: { sha } });
    }
    return err(404, 'Not Found');
  }

  // ---- commits
  if (rest[0] === 'commits') {
    if (method !== 'GET') return err(404, 'Not Found');
    const ref = ctx.query.get('sha') ?? DEFAULT_BRANCH;
    const list = store.commitList(repo, ref).map((c) => ({
      sha: c.sha,
      commit: { message: c.message, author: { name: c.author }, committer: { name: c.committer } },
      author: { login: store.viewer() },
    }));
    return ok(200, list);
  }

  // ---- git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      if (!hasBody(ctx.body)) return err(400, 'request body must be a JSON object');
      const ref = stringField(ctx.body, 'ref');
      const sha = stringField(ctx.body, 'sha');
      if (!ref || !sha) return err(422, 'ref and sha are required');
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha } });
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = rest.slice(3).join('/');
      const sha = repo.branchTip(branch);
      if (!sha) return err(404, 'Not Found');
      return ok(200, { ref: `refs/heads/${branch}`, object: { sha } });
    }
    return err(404, 'Not Found');
  }

  // ---- contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (!path) return err(404, 'Not Found');
    if (method === 'GET') {
      const ref = ctx.query.get('ref') ?? DEFAULT_BRANCH;
      const file = store.fileAt(repo, ref, path);
      if (file) {
        return ok(200, {
          type: 'file',
          encoding: 'base64',
          size: file.blob.length,
          name: path.split('/').pop() ?? '',
          path,
          content: file.blob.toString('base64'),
          sha: file.oid,
        });
      }
      const dir = store.dirAt(repo, ref, path);
      if (dir) {
        return ok(200, dir.map((e) => ({
          type: e.type,
          name: e.name,
          path: e.path,
          sha: e.oid,
          size: 0,
          url: `/repos/${owner}/${name}/contents/${e.path}`,
        })));
      }
      return err(404, 'Not Found');
    }
    if (method === 'PUT') {
      if (!hasBody(ctx.body)) return err(400, 'request body must be a JSON object');
      const contentB64 = stringField(ctx.body, 'content');
      const message = stringField(ctx.body, 'message') ?? 'Update file';
      const branch = stringField(ctx.body, 'branch') ?? DEFAULT_BRANCH;
      const sha = stringField(ctx.body, 'sha');
      if (contentB64 === null) return err(422, 'content is required');
      let content: Buffer;
      try {
        content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      } catch {
        return err(422, 'content is not valid base64');
      }
      const existing = store.fileAt(repo, branch, path);
      if (existing && sha !== null && sha !== existing.oid) {
        return err(409, 'sha does not match the current file');
      }
      const wasCreate = !existing;
      const r = store.commitFile(repo, branch, path, content, message);
      return ok(wasCreate ? 201 : 200, {
        content: {
          type: 'file',
          encoding: 'base64',
          size: content.length,
          name: path.split('/').pop() ?? '',
          path,
          content: content.toString('base64'),
          sha: r.blobSha,
        },
        commit: { sha: r.commitSha },
      });
    }
    if (method === 'DELETE') {
      if (!hasBody(ctx.body)) return err(400, 'request body must be a JSON object');
      const message = stringField(ctx.body, 'message') ?? 'Delete file';
      const branch = stringField(ctx.body, 'branch') ?? DEFAULT_BRANCH;
      const sha = stringField(ctx.body, 'sha');
      const existing = store.fileAt(repo, branch, path);
      if (!existing) return err(404, 'Not Found');
      if (sha !== null && sha !== existing.oid) return err(409, 'sha does not match the current file');
      const r = store.deleteFile(repo, branch, path, message);
      if (!r) return err(404, 'Not Found');
      return ok(200, { commit: { sha: r.commitSha } });
    }
    return err(404, 'Not Found');
  }

  // ---- labels
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      if (!hasBody(ctx.body)) return err(400, 'request body must be a JSON object');
      const labelName = stringField(ctx.body, 'name');
      if (!labelName) return err(422, 'name is required');
      const label = { name: labelName, color: stringField(ctx.body, 'color') ?? 'ffffff' };
      repo.labels.set(labelName, label);
      return ok(201, label);
    }
    if (method === 'GET' && rest.length === 1) {
      return ok(200, [...repo.labels.values()]);
    }
    return err(404, 'Not Found');
  }

  // ---- issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        if (!hasBody(ctx.body)) return err(400, 'request body must be a JSON object');
        const title = stringField(ctx.body, 'title');
        if (!title) return err(422, 'title is required');
        const rawLabels = ctx.body.labels;
        const labels: Array<{ name: string; color: string }> = [];
        if (Array.isArray(rawLabels)) {
          for (const l of rawLabels) {
            const labelName = typeof l === 'string' ? l : typeof l === 'object' && l !== null ? String((l as Record<string, unknown>).name ?? '') : '';
            if (!labelName) continue;
            const found = repo.labels.get(labelName);
            if (!found) return err(422, `label ${labelName} does not exist`);
            labels.push(found);
          }
        }
        const issue = store.createIssue(repo, title, stringField(ctx.body, 'body') ?? '', labels);
        return ok(201, JSON.parse(issue.jsonCache));
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const direction = ctx.query.get('direction') ?? 'desc';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        return ok(200, list.map((i) => JSON.parse(i.jsonCache)));
      }
      return err(404, 'Not Found');
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num < 1) return err(404, 'Not Found');
    const issue = repo.issueByNumber.get(num);
    if (rest.length === 2) {
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') return ok(200, JSON.parse(issue.jsonCache));
      if (method === 'PATCH') {
        if (!hasBody(ctx.body)) return err(400, 'request body must be a JSON object');
        const state = stringField(ctx.body, 'state');
        if (state === 'closed' || state === 'open') issue.state = state;
        const title = stringField(ctx.body, 'title');
        if (title !== null) issue.title = title;
        const body = stringField(ctx.body, 'body');
        if (body !== null) issue.body = body;
        store.refreshIssueJson(repo, issue);
        return ok(200, JSON.parse(issue.jsonCache));
      }
      return err(404, 'Not Found');
    }
    if (rest[2] === 'comments') {
      if (!issue) return err(404, 'Not Found');
      if (method === 'POST') {
        if (!hasBody(ctx.body)) return err(400, 'request body must be a JSON object');
        const bodyText = stringField(ctx.body, 'body');
        if (bodyText === null) return err(422, 'body is required');
        const id = store.nextCommentId++;
        const comment = { id, gid: '', body: bodyText, userLogin: store.viewer() };
        comment.gid = `C:${repo.databaseId}:${issue.number}:${id}`;
        issue.comments.push(comment);
        store.refreshIssueJson(repo, issue);
        return ok(201, {
          id,
          node_id: comment.gid,
          body: bodyText,
          user: { login: store.viewer(), id: 1, type: 'User' },
          created_at: store.nowIso,
          updated_at: store.nowIso,
        });
      }
      if (method === 'GET') {
        return ok(200, issue.comments.map((c) => ({
          id: c.id,
          node_id: c.gid,
          body: c.body,
          user: { login: c.userLogin, id: 1, type: 'User' },
          created_at: store.nowIso,
          updated_at: store.nowIso,
        })));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // ---- pull requests
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        if (!hasBody(ctx.body)) return err(400, 'request body must be a JSON object');
        const title = stringField(ctx.body, 'title');
        const head = stringField(ctx.body, 'head');
        const base = stringField(ctx.body, 'base');
        if (!title || !head || !base) return err(422, 'title, head and base are required');
        const created = store.createPull(repo, title, stringField(ctx.body, 'body') ?? '', head, base);
        if ('error' in created) {
          const msg = created.error;
          if (msg.startsWith('a pull request already exists')) return err(422, msg);
          return err(422, msg);
        }
        return ok(201, store.pullJson(repo, created));
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.seq - a.seq);
        return ok(200, list.map((p) => store.pullJson(repo, p)));
      }
      return err(404, 'Not Found');
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num < 1) return err(404, 'Not Found');
    const pull = repo.pullByNumber.get(num);
    if (rest.length === 2) {
      if (!pull) return err(404, 'Not Found');
      if (method !== 'GET') return err(404, 'Not Found');
      return ok(200, store.pullJson(repo, pull));
    }
    if (rest[2] === 'files') {
      if (!pull) return err(404, 'Not Found');
      if (method !== 'GET') return err(404, 'Not Found');
      return ok(200, store.pullFiles(repo, pull));
    }
    if (rest[2] === 'merge') {
      if (!pull) return err(404, 'Not Found');
      if (method !== 'PUT') return err(404, 'Not Found');
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) return err(merged.status, merged.error);
      return ok(200, { sha: merged.sha, merged: true, message: `Pull request #${pull.number} merged` });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

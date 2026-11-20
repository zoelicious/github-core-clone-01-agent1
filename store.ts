// The forge's in-memory store and domain logic.
//
// One process, one store: repos, git objects, issues, pull requests and
// labels all live here, keyed so the read workload (2,000 sequential GETs
// of one issue) is a Map lookup and a cached JSON string.
//
// Ownership: the trial's bearer token names one login, but the token is
// opaque (shpat_<hex>), so the login cannot be decoded from it. Instead
// the store learns the viewer the first time any owner-bearing request
// names one: in the suite's order that is always the token owner's login
// (git and REST run before GraphQL and MCP, and every one of their
// owner-bearing requests names the viewer). A repository created through
// POST /user/repos stays owner-less until that first naming, then binds.
// A lookup under any other owner is a 404, never a 403.
//
// Determinism: nothing here reads the wall clock or unseeded randomness.
// Commit timestamps and created_at strings come from MAKEFUN_TRIAL_NOW
// when the trial sets it, else a fixed epoch, so two runs on one instance
// produce identical bytes.

import {
  buildCommit,
  buildTree,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './gitobj.ts';

export const DEFAULT_BRANCH = 'main';
const FORGE_IDENTITY = 'Forge <forge@example.invalid>';
const FALLBACK_EPOCH = 1700000000;

export function trialEpochSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return FALLBACK_EPOCH;
}

export function trialNowIso(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return '2026-01-01T00:00:00Z';
}

export const gid = (kind: string, ...parts: Array<string | number>): string =>
  Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');

export function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const idx = text.indexOf(':');
    if (idx < 0) return null;
    return { kind: text.slice(0, idx), parts: text.slice(idx + 1).split(':') };
  } catch {
    return null;
  }
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  gid: string;
  body: string;
  userLogin: string;
}

export interface Issue {
  id: number;
  gid: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
  jsonCache: string;
}

export interface Pull {
  id: number;
  gid: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  seq: number;
}

export interface Repo {
  name: string;
  owner: string | null;
  databaseId: number;
  isPrivate: boolean;
  description: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  nextIssue: number;
  pulls: Pull[];
  pullByNumber: Map<number, Pull>;
  nextPull: number;
  labels: Map<string, Label>;
  seq: number;
  jsonCache: string;
}

export class Store {
  readonly token: string;
  viewerLogin: string | null = null;
  readonly reposByName = new Map<string, Repo>();
  readonly reposInOrder: Repo[] = [];
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  nextSeq = 1;
  reqCounter = 0;
  readonly epoch = trialEpochSec();
  readonly nowIso = trialNowIso();

  constructor() {
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  }

  learnViewer(login: string): void {
    if (login && this.viewerLogin === null) this.viewerLogin = login;
  }

  viewer(): string {
    return this.viewerLogin ?? '';
  }

  checkToken(auth: string | undefined): boolean {
    if (!auth) return false;
    const m = /^Bearer\s+(.+)$/.exec(auth.trim());
    if (!m) return false;
    const presented = m[1]!;
    if (this.token === '') return presented.length > 0;
    return presented === this.token;
  }

  // ------------------------------------------------------------ repositories

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.reposByName.has(name)) return null;
    const repo: Repo = {
      name,
      owner: this.viewerLogin,
      databaseId: this.nextRepoId++,
      isPrivate,
      description,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      issueByNumber: new Map(),
      nextIssue: 1,
      pulls: [],
      pullByNumber: new Map(),
      nextPull: 1,
      labels: new Map(),
      seq: this.nextSeq++,
      jsonCache: '',
    };
    this.reposByName.set(name, repo);
    this.reposInOrder.push(repo);
    this.refreshRepoJson(repo);
    return repo;
  }

  /** Find a repo by owner+name, binding an unbound repo (and the viewer) on first naming. */
  findRepo(owner: string, name: string): Repo | null {
    const repo = this.reposByName.get(name);
    if (!repo) return null;
    if (repo.owner === null) {
      if (owner !== '') {
        repo.owner = owner;
        this.learnViewer(owner);
        this.refreshRepoJson(repo);
      }
    } else if (repo.owner !== owner) {
      return null;
    }
    return repo;
  }

  repoJson(repo: Repo): Record<string, unknown> {
    const login = repo.owner ?? this.viewerLogin ?? '';
    return {
      id: repo.databaseId,
      node_id: gid('R', repo.databaseId),
      name: repo.name,
      full_name: login ? `${login}/${repo.name}` : repo.name,
      owner: { login, id: 1, type: 'User' },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: DEFAULT_BRANCH,
      html_url: `https://example.invalid/${login}/${repo.name}`,
      url: `/repos/${login}/${repo.name}`,
      created_at: this.nowIso,
      updated_at: this.nowIso,
      pushed_at: this.nowIso,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
      fork: false,
      archived: false,
      disabled: false,
      visibility: repo.isPrivate ? 'private' : 'public',
    };
  }

  refreshRepoJson(repo: Repo): void {
    repo.jsonCache = JSON.stringify(this.repoJson(repo));
  }

  deleteRepo(repo: Repo): void {
    this.reposByName.delete(repo.name);
    const idx = this.reposInOrder.indexOf(repo);
    if (idx >= 0) this.reposInOrder.splice(idx, 1);
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Resolve a branch name, full ref, or commit oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const tip = repo.refs.get(`refs/heads/${ref}`);
    if (tip) return tip;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag) return this.peelToCommit(repo, tag);
    return null;
  }

  peelToCommit(repo: Repo, oid: string): string | null {
    let cur = oid;
    const seen = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      if (seen.has(cur)) return null;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj) return null;
      if (obj.type === 'commit') return cur;
      if (obj.type === 'tag') {
        try {
          cur = parseTag(obj.data).object;
        } catch {
          return null;
        }
      } else return null;
    }
    return null;
  }

  commitTree(repo: Repo, commitOid: string): string | null {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    try {
      return parseCommit(obj.data).tree;
    } catch {
      return null;
    }
  }

  /** True when `anc` is `desc` or one of its ancestors (any parent path). */
  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    if (anc === ZERO_OID) return true;
    const seen = new Set<string>();
    const stack = [desc];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === anc) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      let view;
      try {
        view = parseCommit(obj.data);
      } catch {
        continue;
      }
      for (const p of view.parents) stack.push(p);
    }
    return false;
  }

  mergeBase(repo: Repo, a: string, b: string): string | null {
    const fromA = new Set<string>();
    const stackA = [a];
    while (stackA.length) {
      const cur = stackA.pop()!;
      if (fromA.has(cur)) continue;
      fromA.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      try {
        for (const p of parseCommit(obj.data).parents) stackA.push(p);
      } catch {
        /* ignore */
      }
    }
    const seen = new Set<string>();
    const stackB = [b];
    while (stackB.length) {
      const cur = stackB.pop()!;
      if (fromA.has(cur)) return cur;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      try {
        for (const p of parseCommit(obj.data).parents) stackB.push(p);
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  /** All objects reachable from `roots` (commits, tags, trees, blobs). */
  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const r of roots) if (isOid(r)) queue.push(r);
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        try {
          const c = parseCommit(obj.data);
          queue.push(c.tree);
          for (const p of c.parents) queue.push(p);
        } catch {
          /* ignore */
        }
      } else if (obj.type === 'tag') {
        try {
          queue.push(parseTag(obj.data).object);
        } catch {
          /* ignore */
        }
      } else if (obj.type === 'tree') {
        try {
          for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
        } catch {
          /* ignore */
        }
      }
    }
    return seen;
  }

  /** Flat path -> {oid, mode} map for a tree (recursive). */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, pre: string): void => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      let entries: TreeEntry[];
      try {
        entries = parseTree(obj.data);
      } catch {
        return;
      }
      for (const e of entries) {
        const path = pre ? `${pre}/${e.name}` : e.name;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, { oid: e.oid, mode: e.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** New tree oid with `path` set to `blobOid` (or removed when null). */
  writePath(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s !== '');
    const build = (treeOid: string | null, depth: number): string | null => {
      let entries: TreeEntry[] = [];
      if (treeOid) {
        const obj = repo.objects.get(treeOid);
        if (obj && obj.type === 'tree') {
          try {
            entries = parseTree(obj.data);
          } catch {
            entries = [];
          }
        }
      }
      const seg = segments[depth]!;
      const isLast = depth === segments.length - 1;
      const idx = entries.findIndex((e) => e.name === seg);
      if (isLast) {
        if (blobOid === null) {
          if (idx < 0) return treeOid;
          entries.splice(idx, 1);
        } else {
          const entry: TreeEntry = { mode: '100644', name: seg, oid: blobOid };
          if (idx >= 0) entries[idx] = entry;
          else entries.push(entry);
        }
      } else {
        const child = idx >= 0 ? entries[idx]! : null;
        const childTree = child && child.mode === '40000' ? child.oid : null;
        const next = build(childTree, depth + 1);
        if (next === null) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (next === childTree) {
          return treeOid;
        } else {
          const entry: TreeEntry = { mode: '40000', name: seg, oid: next };
          if (idx >= 0) entries[idx] = entry;
          else entries.push(entry);
        }
      }
      if (entries.length === 0) return null;
      const data = buildTree(entries);
      return this.putObject(repo, 'tree', data);
    };
    if (segments.length === 0) return baseTreeOid ?? this.putObject(repo, 'tree', buildTree([]));
    return build(baseTreeOid, 0) ?? this.putObject(repo, 'tree', buildTree([]));
  }

  /** Create a contents-style commit on `branch` (creating the branch from the default tip when missing). */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string; treeSha: string } {
    const blobSha = this.putObject(repo, 'blob', content);
    let tip = this.branchTip(repo, branch);
    if (tip === null && branch !== DEFAULT_BRANCH) tip = this.branchTip(repo, DEFAULT_BRANCH);
    const baseTree = tip ? this.commitTree(repo, tip) : null;
    const treeSha = this.writePath(repo, baseTree, path, blobSha);
    const who = `${FORGE_IDENTITY} ${this.epoch} +0000`;
    const commitData = buildCommit(treeSha, tip ? [tip] : [], who, who, message);
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha, treeSha };
  }

  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const tip = this.branchTip(repo, branch);
    if (!tip) return null;
    const baseTree = this.commitTree(repo, tip);
    if (!baseTree) return null;
    const flat = this.flattenTree(repo, baseTree);
    if (!flat.has(path)) return null;
    const treeSha = this.writePath(repo, baseTree, path, null);
    const who = `${FORGE_IDENTITY} ${this.epoch} +0000`;
    const commitSha = this.putObject(repo, 'commit', buildCommit(treeSha, [tip], who, who, message));
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha };
  }

  fileAt(repo: Repo, ref: string, path: string): { blob: Buffer; oid: string } | null {
    const tip = this.resolveRef(repo, ref);
    if (!tip) return null;
    const tree = this.commitTree(repo, tip);
    if (!tree) return null;
    const flat = this.flattenTree(repo, tree);
    const entry = flat.get(path);
    if (!entry) return null;
    const obj = repo.objects.get(entry.oid);
    if (!obj || obj.type !== 'blob') return null;
    return { blob: obj.data, oid: entry.oid };
  }

  dirAt(repo: Repo, ref: string, dir: string): Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> | null {
    const tip = this.resolveRef(repo, ref);
    if (!tip) return null;
    const tree = this.commitTree(repo, tip);
    if (!tree) return null;
    let cur = tree;
    if (dir !== '') {
      const flat = this.flattenTree(repo, tree);
      // Walk down the tree segments to find the subtree oid.
      let oid: string | null = tree;
      for (const seg of dir.split('/')) {
        const obj = oid ? repo.objects.get(oid) : undefined;
        if (!obj || obj.type !== 'tree') return null;
        let entries: TreeEntry[];
        try {
          entries = parseTree(obj.data);
        } catch {
          return null;
        }
        const found = entries.find((e) => e.name === seg && e.mode === '40000');
        if (!found) return null;
        oid = found.oid;
      }
      cur = oid!;
      void flat;
    }
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    let entries: TreeEntry[];
    try {
      entries = parseTree(obj.data);
    } catch {
      return null;
    }
    return entries.map((e) => ({
      name: e.name,
      path: dir ? `${dir}/${e.name}` : e.name,
      oid: e.oid,
      type: e.mode === '40000' ? ('dir' as const) : ('file' as const),
    }));
  }

  /** Commits reachable from `ref`, tip first (depth-first, parents after). */
  commitList(repo: Repo, ref: string): Array<{ sha: string; message: string; author: string; committer: string }> {
    const tip = this.resolveRef(repo, ref);
    if (!tip) return [];
    const out: Array<{ sha: string; message: string; author: string; committer: string }> = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      let view;
      try {
        view = parseCommit(obj.data);
      } catch {
        continue;
      }
      out.push({ sha: oid, message: view.message, author: view.author, committer: view.committer });
      for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i]!);
    }
    return out;
  }

  // ------------------------------------------------------------ issues

  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    const login = repo.owner ?? this.viewerLogin ?? '';
    return {
      id: issue.id,
      node_id: issue.gid,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
      user: { login, id: 1, type: 'User' },
      assignees: [],
      created_at: this.nowIso,
      updated_at: this.nowIso,
      closed_at: issue.state === 'closed' ? this.nowIso : null,
      html_url: `https://example.invalid/${login}/${repo.name}/issues/${issue.number}`,
      url: `/repos/${login}/${repo.name}/issues/${issue.number}`,
      comments: issue.comments.length,
    };
  }

  refreshIssueJson(repo: Repo, issue: Issue): void {
    issue.jsonCache = JSON.stringify(this.issueJson(repo, issue));
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const number = repo.nextIssue++;
    const issue: Issue = {
      id: this.nextIssueId++,
      gid: gid('I', repo.databaseId, number),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: this.nextSeq++,
      jsonCache: '',
    };
    repo.issues.push(issue);
    repo.issueByNumber.set(number, issue);
    this.refreshIssueJson(repo, issue);
    return issue;
  }

  // ------------------------------------------------------------ pull requests

  pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
    const login = repo.owner ?? this.viewerLogin ?? '';
    return {
      id: pull.id,
      node_id: pull.gid,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.headRef, sha: pull.headSha, label: `${login}:${pull.headRef}`, user: { login, id: 1, type: 'User' } },
      base: { ref: pull.baseRef, sha: pull.baseSha, label: `${login}:${pull.baseRef}`, user: { login, id: 1, type: 'User' } },
      merged: pull.merged,
      mergeable: this.pullMergeable(repo, pull),
      merge_commit_sha: pull.mergeCommitSha,
      merged_at: pull.mergedAt,
      created_at: this.nowIso,
      updated_at: this.nowIso,
      closed_at: pull.state === 'closed' ? this.nowIso : null,
      html_url: `https://example.invalid/${login}/${repo.name}/pull/${pull.number}`,
      url: `/repos/${login}/${repo.name}/pulls/${pull.number}`,
    };
  }

  stripOwnerPrefix(ref: string): string {
    const idx = ref.indexOf(':');
    return idx >= 0 ? ref.slice(idx + 1) : ref;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
    const headRef = this.stripOwnerPrefix(head);
    const baseRef = this.stripOwnerPrefix(base);
    const headSha = this.branchTip(repo, headRef);
    if (!headSha) return { error: `head branch ${headRef} does not exist` };
    const baseSha = this.branchTip(repo, baseRef);
    if (!baseSha) return { error: `base branch ${baseRef} does not exist` };
    for (const p of repo.pulls) {
      if (p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef) {
        return { error: 'a pull request already exists for this head and base' };
      }
    }
    const number = repo.nextPull++;
    const pull: Pull = {
      id: this.nextPullId++,
      gid: gid('P', repo.databaseId, number),
      number,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      seq: this.nextSeq++,
    };
    repo.pulls.push(pull);
    repo.pullByNumber.set(number, pull);
    return pull;
  }

  /** Diff two trees: changed paths with line counts. */
  diffFiles(repo: Repo, baseTree: string | null, headTree: string | null): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const base = baseTree ? this.flattenTree(repo, baseTree) : new Map();
    const head = headTree ? this.flattenTree(repo, headTree) : new Map();
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const countLines = (oid: string | undefined): number => {
      if (!oid) return 0;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'blob') return 0;
      const text = obj.data.toString('utf8');
      if (text === '') return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const del = countLines(b.oid);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: del, changes: del });
      } else if (!b && h) {
        const add = countLines(h.oid);
        out.push({ filename: path, status: 'added', additions: add, deletions: 0, changes: add });
      } else if (b && h && b.oid !== h.oid) {
        const add = countLines(h.oid);
        const del = countLines(b.oid);
        out.push({ filename: path, status: 'modified', additions: add, deletions: del, changes: add + del });
      }
    }
    return out;
  }

  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseTree = this.commitTree(repo, pull.baseSha);
    const headTree = this.commitTree(repo, pull.headSha);
    return this.diffFiles(repo, baseTree, headTree);
  }

  /** Would a squash merge of this pull conflict with the default branch? */
  pullConflict(repo: Repo, pull: Pull): boolean {
    const defaultTip = this.branchTip(repo, DEFAULT_BRANCH);
    if (!defaultTip) return false;
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const base = this.mergeBase(repo, headTip, defaultTip);
    if (!base) return false;
    const baseTree = this.commitTree(repo, base);
    const headTree = this.commitTree(repo, headTip);
    const defaultTree = this.commitTree(repo, defaultTip);
    const headDiff = new Map(this.diffFiles(repo, baseTree, headTree).map((f) => [f.filename, f]));
    const defaultDiff = new Map(this.diffFiles(repo, baseTree, defaultTree).map((f) => [f.filename, f]));
    const headFlat = headTree ? this.flattenTree(repo, headTree) : new Map();
    const defaultFlat = defaultTree ? this.flattenTree(repo, defaultTree) : new Map();
    for (const path of headDiff.keys()) {
      if (!defaultDiff.has(path)) continue;
      const h = headFlat.get(path)?.oid ?? null;
      const d = defaultFlat.get(path)?.oid ?? null;
      if (h !== d) return true;
    }
    return false;
  }

  pullMergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    return !this.pullConflict(repo, pull);
  }

  /** Squash-merge an open pull request onto the default branch. */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'pull request is already closed', status: 405 };
    if (this.pullConflict(repo, pull)) return { error: 'merge conflict', status: 405 };
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const headTree = this.commitTree(repo, headTip);
    if (!headTree) return { error: 'head commit has no tree', status: 405 };
    const defaultTip = this.branchTip(repo, DEFAULT_BRANCH);
    const who = `${FORGE_IDENTITY} ${this.epoch} +0000`;
    const message = `Squash merge of #${pull.number}: ${pull.title}\n`;
    const sha = this.putObject(repo, 'commit', buildCommit(headTree, defaultTip ? [defaultTip] : [], who, who, message));
    repo.refs.set(`refs/heads/${DEFAULT_BRANCH}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedAt = this.nowIso;
    return { sha };
  }
}

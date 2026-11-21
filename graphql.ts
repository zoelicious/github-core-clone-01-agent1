// GraphQL over POST /api/graphql: a small tokenizer, parser and executor
// for exactly the documents the suite sends (variables, aliases, inline
// fragments, batched arrays, introspection of Issue / PullRequest /
// Repository / SearchType). Unknown fields surface as an `errors` array
// with HTTP 200; an unknown repository yields data.repository = null
// with no errors — both are behaviours the suite asserts.

import { Store, DEFAULT_BRANCH, gid, parseGid, type Repo, type Issue, type Pull } from './store.ts';

// ---------------------------------------------------------------- tokenizer

type Tok =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'var'; value: string }
  | { kind: 'punct'; value: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '#') {
      if (c === '#') while (i < src.length && src[i] !== '\n') i += 1;
      else i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      toks.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!():=@[]{ }|'.includes(c)) {
      toks.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && isNameChar(src[j]!)) j += 1;
      toks.push({ kind: 'var', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (c === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        toks.push({ kind: 'string', value: src.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const esc = src[j + 1] ?? '';
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          out += map[esc] ?? esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      if (j >= src.length) throw new Error('unterminated string');
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      const text = src.slice(i, j);
      toks.push(/[.eE]/.test(text) ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j]!)) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return toks;
}

// ---------------------------------------------------------------- AST

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
  directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }>;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private next(): Tok {
    const t = this.toks[this.pos];
    if (!t) throw new Error('unexpected end of document');
    this.pos += 1;
    return t;
  }

  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${t.kind}:${t.value}`);
  }

  private expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got ${t.kind}:${t.value}`);
    if (v && t.value !== v) throw new Error(`expected ${v}, got ${t.value}`);
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.toks.length) ops.push(this.parseOperation());
    return ops;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t?.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = t.value as 'query' | 'mutation';
      this.next();
      const n = this.peek();
      if (n?.kind === 'name') name = this.next().value;
    }
    const varDefs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        const v = this.next();
        if (v.kind !== 'var') throw new Error('expected a variable in variable definitions');
        this.expectPunct(':');
        // Skip the type (name, possibly [..] / !).
        let depth = 0;
        for (;;) {
          const tk = this.next();
          if (tk.kind === 'punct' && tk.value === '[') depth += 1;
          else if (tk.kind === 'punct' && tk.value === ']') depth -= 1;
          else if (tk.kind === 'punct' && (tk.value === '=' || tk.value === ')' || tk.value === ',')) {
            if (tk.value === '=') {
              const def = this.parseValue();
              varDefs.push({ name: v.value, defaultValue: def });
            } else {
              varDefs.push({ name: v.value, defaultValue: null });
              this.pos -= 1;
            }
            break;
          }
          if (depth === 0 && tk.kind === 'punct' && (tk.value === ',' || tk.value === ')')) {
            varDefs.push({ name: v.value, defaultValue: null });
            this.pos -= 1;
            break;
          }
        }
        const after = this.peek();
        if (after?.kind === 'punct' && after.value === ',') this.next();
        if (after?.kind === 'punct' && after.value === ')') break;
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, varDefs, selections };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t?.kind === 'punct' && t.value === '...') {
      this.next();
      const n = this.peek();
      if (n?.kind === 'name' && n.value === 'on') {
        this.next();
        const cond = this.expectName();
        const dirs = this.parseDirectives();
        void dirs;
        return { kind: 'fragment', typeCondition: cond, selections: this.parseSelectionSet() };
      }
      if (n?.kind === 'name') {
        this.next();
        const dirs = this.parseDirectives();
        void dirs;
        return { kind: 'fragment', typeCondition: null, selections: [] };
      }
      return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
        const after = this.peek();
        if (after?.kind === 'punct' && after.value === ',') this.next();
      }
      this.expectPunct(')');
    }
    const directives = this.parseDirectives();
    let selections: SelectionNode[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections, directives };
  }

  private parseDirectives(): Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }> {
    const out: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }> = [];
    while (this.peek()?.kind === 'punct' && this.peek()!.value === '@') {
      this.next();
      const name = this.expectName();
      const args: Array<{ name: string; value: ValueNode }> = [];
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
        this.next();
        while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expectPunct(')');
      }
      out.push({ name, args });
    }
    return out;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'var') return { kind: 'variable', name: t.value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected token ${t.kind}:${t.value} as a value`);
  }
}

// ---------------------------------------------------------------- type model

interface FieldTypeInfo {
  name: string;
  kind: 'SCALAR' | 'OBJECT' | 'ENUM' | 'LIST';
  ofType?: FieldTypeInfo;
}

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR';
  fields: Record<string, FieldTypeInfo>;
  enumValues?: string[];
}

const S = (name: string): FieldTypeInfo => ({ name, kind: 'SCALAR' });
const O = (name: string): FieldTypeInfo => ({ name, kind: 'OBJECT' });
const E = (name: string): FieldTypeInfo => ({ name, kind: 'ENUM' });
const L = (of: FieldTypeInfo): FieldTypeInfo => ({ name: '', kind: 'LIST', ofType: of });

const TYPES: Record<string, TypeInfo> = {
  Query: {
    kind: 'OBJECT',
    fields: { viewer: O('User'), repository: O('Repository'), node: O('Node'), search: O('SearchResultItemConnection') },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: O('CreateIssuePayload'),
      closeIssue: O('CloseIssuePayload'),
      createPullRequest: O('CreatePullRequestPayload'),
      mergePullRequest: O('MergePullRequestPayload'),
      addComment: O('AddCommentPayload'),
    },
  },
  User: {
    kind: 'OBJECT',
    fields: { login: S('String'), id: S('ID'), name: S('String'), url: S('URI') },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: S('ID'),
      databaseId: S('Int'),
      name: S('String'),
      nameWithOwner: S('String'),
      owner: O('RepositoryOwner'),
      defaultBranchRef: O('Ref'),
      viewerPermission: E('RepositoryPermission'),
      hasIssuesEnabled: S('Boolean'),
      description: S('String'),
      isPrivate: S('Boolean'),
      createdAt: S('DateTime'),
      updatedAt: S('DateTime'),
      issue: O('Issue'),
      issues: O('IssueConnection'),
      pullRequest: O('PullRequest'),
      pullRequests: O('PullRequestConnection'),
    },
  },
  RepositoryOwner: { kind: 'OBJECT', fields: { login: S('String'), id: S('ID') } },
  Ref: { kind: 'OBJECT', fields: { name: S('String'), target: O('GitObject') } },
  GitObject: { kind: 'OBJECT', fields: { oid: S('String') } },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: S('ID'),
      databaseId: S('Int'),
      number: S('Int'),
      title: S('String'),
      body: S('String'),
      state: E('IssueState'),
      url: S('URI'),
      author: O('User'),
      labels: O('LabelConnection'),
      comments: O('IssueCommentConnection'),
      createdAt: S('DateTime'),
      updatedAt: S('DateTime'),
      closedAt: S('DateTime'),
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: S('ID'),
      databaseId: S('Int'),
      number: S('Int'),
      title: S('String'),
      body: S('String'),
      state: E('PullRequestState'),
      headRefName: S('String'),
      baseRefName: S('String'),
      headRefOid: S('String'),
      baseRefOid: S('String'),
      mergeable: E('MergeableState'),
      merged: S('Boolean'),
      mergeCommit: O('Commit'),
      files: O('PullRequestChangedFileConnection'),
      author: O('User'),
      createdAt: S('DateTime'),
      updatedAt: S('DateTime'),
      closedAt: S('DateTime'),
    },
  },
  Commit: { kind: 'OBJECT', fields: { oid: S('String'), message: S('String') } },
  IssueConnection: { kind: 'OBJECT', fields: { nodes: L(O('Issue')), edges: L(O('IssueEdge')), pageInfo: O('PageInfo'), totalCount: S('Int') } },
  IssueEdge: { kind: 'OBJECT', fields: { node: O('Issue'), cursor: S('String') } },
  PullRequestConnection: { kind: 'OBJECT', fields: { nodes: L(O('PullRequest')), edges: L(O('PullRequestEdge')), pageInfo: O('PageInfo'), totalCount: S('Int') } },
  PullRequestEdge: { kind: 'OBJECT', fields: { node: O('PullRequest'), cursor: S('String') } },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: { nodes: L(O('PullRequestChangedFile')), edges: L(O('PullRequestChangedFileEdge')), pageInfo: O('PageInfo'), totalCount: S('Int') } },
  PullRequestChangedFileEdge: { kind: 'OBJECT', fields: { node: O('PullRequestChangedFile'), cursor: S('String') } },
  PullRequestChangedFile: { kind: 'OBJECT', fields: { path: S('String'), additions: S('Int'), deletions: S('Int'), changeType: E('PullRequestChangeType') } },
  LabelConnection: { kind: 'OBJECT', fields: { nodes: L(O('Label')), edges: L(O('LabelEdge')), pageInfo: O('PageInfo'), totalCount: S('Int') } },
  LabelEdge: { kind: 'OBJECT', fields: { node: O('Label'), cursor: S('String') } },
  Label: { kind: 'OBJECT', fields: { id: S('ID'), name: S('String'), color: S('String') } },
  IssueCommentConnection: { kind: 'OBJECT', fields: { nodes: L(O('IssueComment')), edges: L(O('IssueCommentEdge')), pageInfo: O('PageInfo'), totalCount: S('Int') } },
  IssueCommentEdge: { kind: 'OBJECT', fields: { node: O('IssueComment'), cursor: S('String') } },
  IssueComment: { kind: 'OBJECT', fields: { id: S('ID'), databaseId: S('Int'), body: S('String'), author: O('User') } },
  PageInfo: { kind: 'OBJECT', fields: { hasNextPage: S('Boolean'), hasPreviousPage: S('Boolean'), startCursor: S('String'), endCursor: S('String') } },
  Node: { kind: 'OBJECT', fields: { id: S('ID') } },
  SearchResultItemConnection: { kind: 'OBJECT', fields: { nodes: L(O('SearchResultItem')), edges: L(O('SearchResultItemEdge')), pageInfo: O('PageInfo'), totalCount: S('Int') } },
  SearchResultItemEdge: { kind: 'OBJECT', fields: { node: O('SearchResultItem'), cursor: S('String') } },
  SearchResultItem: { kind: 'OBJECT', fields: { id: S('ID') } },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: O('Issue'), clientMutationId: S('String') } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: O('Issue'), clientMutationId: S('String') } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: O('PullRequest'), clientMutationId: S('String') } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: O('PullRequest'), clientMutationId: S('String') } },
  AddCommentPayload: { kind: 'OBJECT', fields: { commentEdge: O('IssueCommentEdge'), clientMutationId: S('String') } },
  IssueState: { kind: 'ENUM', fields: {}, enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: {}, enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: {}, enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', fields: {}, enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', fields: {}, enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  PullRequestChangeType: { kind: 'ENUM', fields: {}, enumValues: ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED', 'COPIED'] },
  OrderDirection: { kind: 'ENUM', fields: {}, enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', fields: {}, enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  __Type: { kind: 'OBJECT', fields: { name: S('String'), kind: E('__TypeKind'), fields: L(O('__Field')), enumValues: L(O('__EnumValue')) } },
  __Field: { kind: 'OBJECT', fields: { name: S('String'), type: O('__Type') } },
  __EnumValue: { kind: 'OBJECT', fields: { name: S('String') } },
  __TypeKind: { kind: 'ENUM', fields: {}, enumValues: ['OBJECT', 'ENUM', 'SCALAR', 'INTERFACE', 'UNION', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] },
};

// ---------------------------------------------------------------- executor

type AnyObj = Record<string, unknown>;

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function valueOf(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'variable': {
      const v = ctx.variables[node.name];
      return v === undefined ? null : v;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, ctx);
      return out;
    }
  }
}

function argMap(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = valueOf(a.value, ctx);
  return out;
}

function skipField(field: FieldNode, ctx: ExecCtx): boolean {
  for (const d of field.directives) {
    const args: Record<string, unknown> = {};
    for (const a of d.args) args[a.name] = valueOf(a.value, ctx);
    if (d.name === 'skip' && args.if === true) return true;
    if (d.name === 'include' && args.if === false) return true;
  }
  return false;
}

const cursorOf = (n: number): string => Buffer.from(String(n), 'utf8').toString('base64');
const cursorNum = (c: string | undefined | null): number | null => {
  if (!c) return null;
  try {
    const n = Number(Buffer.from(c, 'base64').toString('utf8'));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};

interface PageArgs {
  first: number | null;
  after: number | null;
}

function pageArgs(args: Record<string, unknown>): PageArgs {
  const first = typeof args.first === 'number' ? args.first : null;
  const after = typeof args.after === 'string' ? cursorNum(args.after) : null;
  return { first, after };
}

function paged<T>(items: readonly T[], args: PageArgs, key: (item: T, index: number) => number): { nodes: T[]; pageInfo: AnyObj; totalCount: number } {
  let list = items.map((it, i) => ({ it, k: key(it, i) }));
  if (args.after !== null) list = list.filter(({ k }) => k < args.after!);
  const totalCount = list.length;
  if (args.first !== null) list = list.slice(0, args.first);
  const hasNextPage = args.first !== null && totalCount > list.length;
  const endCursor = list.length > 0 ? cursorOf(list[list.length - 1]!.k) : null;
  const startCursor = list.length > 0 ? cursorOf(list[0]!.k) : null;
  return {
    nodes: list.map((x) => x.it),
    pageInfo: { hasNextPage, hasPreviousPage: args.after !== null, startCursor, endCursor },
    totalCount,
  };
}

// A resolved value carries its GraphQL type name so nested selections know
// which fields exist on it.
interface Typed {
  __typename: string;
  __value: unknown;
}

const T = (typename: string, value: unknown): Typed => ({ __typename: typename, __value: value });

function resolveField(parentType: string, parent: unknown, field: FieldNode, ctx: ExecCtx): Typed | null {
  const store = ctx.store;
  const args = argMap(field, ctx);
  const name = field.name;

  // ---- introspection
  if (name === '__type') {
    const typeName = String(args.name ?? '');
    const info = TYPES[typeName];
    if (!info) return T('__Type', null);
    return T('__Type', { __typeName: typeName, __typeInfo: info });
  }
  if (name === '__schema') {
    return T('__Schema', { queryType: 'Query', mutationType: 'Mutation' });
  }

  // ---- root Query
  if (parentType === 'Query') {
    if (name === 'viewer') {
      const login = store.viewer();
      return T('User', { login, id: '1', name: login, url: `https://example.invalid/${login}` });
    }
    if (name === 'repository') {
      const owner = String(args.owner ?? '');
      const repoName = String(args.name ?? '');
      if (owner) store.learnViewer(owner);
      const repo = store.findRepo(owner, repoName);
      if (!repo) return T('Repository', null);
      return T('Repository', repo);
    }
    if (name === 'node') {
      const parsed = parseGid(String(args.id ?? ''));
      if (!parsed) return T('Node', null);
      if (parsed.kind === 'R') {
        const dbId = Number(parsed.parts[0]);
        const repo = store.reposInOrder.find((r) => r.databaseId === dbId);
        if (!repo) return T('Node', null);
        return T('Repository', repo);
      }
      if (parsed.kind === 'I') {
        const dbId = Number(parsed.parts[0]);
        const num = Number(parsed.parts[1]);
        const repo = store.reposInOrder.find((r) => r.databaseId === dbId);
        const issue = repo?.issueByNumber.get(num);
        if (!issue) return T('Node', null);
        return T('Issue', { issue, repo });
      }
      if (parsed.kind === 'P') {
        const dbId = Number(parsed.parts[0]);
        const num = Number(parsed.parts[1]);
        const repo = store.reposInOrder.find((r) => r.databaseId === dbId);
        const pull = repo?.pullByNumber.get(num);
        if (!pull) return T('Node', null);
        return T('PullRequest', { pull, repo });
      }
      return T('Node', null);
    }
    if (name === 'search') {
      return T('SearchResultItemConnection', { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: 0 });
    }
  }

  // ---- root Mutation
  if (parentType === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'R' ? store.reposInOrder.find((r) => r.databaseId === Number(parsed.parts[0])) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'repository not found' });
        return T('CreateIssuePayload', null);
      }
      const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return T('CreateIssuePayload', { issue, repo });
    }
    if (name === 'closeIssue') {
      const parsed = parseGid(String(input.issueId ?? ''));
      const repo = parsed?.kind === 'I' ? store.reposInOrder.find((r) => r.databaseId === Number(parsed.parts[0])) : undefined;
      const issue = repo?.issueByNumber.get(Number(parsed?.parts[1] ?? NaN));
      if (!issue) {
        ctx.errors.push({ message: 'issue not found' });
        return T('CloseIssuePayload', null);
      }
      issue.state = 'closed';
      store.refreshIssueJson(repo!, issue);
      return T('CloseIssuePayload', { issue, repo });
    }
    if (name === 'createPullRequest') {
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'R' ? store.reposInOrder.find((r) => r.databaseId === Number(parsed.parts[0])) : undefined;
      if (!repo) {
        ctx.errors.push({ message: 'repository not found' });
        return T('CreatePullRequestPayload', null);
      }
      const created = store.createPull(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return T('CreatePullRequestPayload', null);
      }
      return T('CreatePullRequestPayload', { pull: created, repo });
    }
    if (name === 'mergePullRequest') {
      const parsed = parseGid(String(input.pullRequestId ?? ''));
      const repo = parsed?.kind === 'P' ? store.reposInOrder.find((r) => r.databaseId === Number(parsed.parts[0])) : undefined;
      const pull = repo?.pullByNumber.get(Number(parsed?.parts[1] ?? NaN));
      if (!pull || !repo) {
        ctx.errors.push({ message: 'pull request not found' });
        return T('MergePullRequestPayload', null);
      }
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) {
        ctx.errors.push({ message: merged.error });
        return T('MergePullRequestPayload', null);
      }
      return T('MergePullRequestPayload', { pull, repo });
    }
    if (name === 'addComment') {
      const parsed = parseGid(String(input.subjectId ?? ''));
      const repo = parsed?.kind === 'I' ? store.reposInOrder.find((r) => r.databaseId === Number(parsed.parts[0])) : undefined;
      const issue = repo?.issueByNumber.get(Number(parsed?.parts[1] ?? NaN));
      if (!issue || !repo) {
        ctx.errors.push({ message: 'subject not found' });
        return T('AddCommentPayload', null);
      }
      const id = store.nextCommentId++;
      const comment = { id, gid: gid('C', repo.databaseId, issue.number, id), body: String(input.body ?? ''), userLogin: store.viewer() };
      issue.comments.push(comment);
      store.refreshIssueJson(repo, issue);
      return T('AddCommentPayload', { commentEdge: { node: comment, cursor: cursorOf(id) } });
    }
  }

  // ---- object fields
  if (parent === null || parent === undefined) return T('__Null', null);
  const v = parent as AnyObj;

  if (parentType === 'Repository' && typeof v === 'object' && 'databaseId' in v) {
    const repo = v as unknown as Repo;
    const login = repo.owner ?? store.viewer();
    switch (name) {
      case 'id':
        return T('ID', gid('R', repo.databaseId));
      case 'databaseId':
        return T('Int', repo.databaseId);
      case 'name':
        return T('String', repo.name);
      case 'nameWithOwner':
        return T('String', login ? `${login}/${repo.name}` : repo.name);
      case 'owner':
        return T('RepositoryOwner', { login, id: '1' });
      case 'defaultBranchRef':
        return T('Ref', { name: DEFAULT_BRANCH, target: store.branchTip(repo, DEFAULT_BRANCH) });
      case 'viewerPermission':
        return T('RepositoryPermission', 'ADMIN');
      case 'hasIssuesEnabled':
        return T('Boolean', true);
      case 'description':
        return T('String', repo.description);
      case 'isPrivate':
        return T('Boolean', repo.isPrivate);
      case 'createdAt':
      case 'updatedAt':
        return T('DateTime', store.nowIso);
      case 'issue': {
        const issue = repo.issueByNumber.get(Number(args.number ?? NaN));
        if (!issue) return T('Issue', null);
        return T('Issue', { issue, repo });
      }
      case 'issues': {
        let list = [...repo.issues].sort((a, b) => b.number - a.number);
        const states = args.states;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const orderBy = args.orderBy as Record<string, unknown> | undefined;
        const dir = String(orderBy?.direction ?? 'DESC');
        if (dir === 'ASC') list.sort((a, b) => a.number - b.number);
        const page = paged(list, pageArgs(args), (i) => i.number);
        return T('IssueConnection', {
          nodes: page.nodes.map((i) => ({ issue: i, repo })),
          edges: page.nodes.map((i) => ({ node: { issue: i, repo }, cursor: cursorOf(i.number) })),
          pageInfo: page.pageInfo,
          totalCount: page.totalCount,
        });
      }
      case 'pullRequest': {
        const pull = repo.pullByNumber.get(Number(args.number ?? NaN));
        if (!pull) return T('PullRequest', null);
        return T('PullRequest', { pull, repo });
      }
      case 'pullRequests': {
        const list = [...repo.pulls].sort((a, b) => b.number - a.number);
        const page = paged(list, pageArgs(args), (p) => p.number);
        return T('PullRequestConnection', {
          nodes: page.nodes.map((p) => ({ pull: p, repo })),
          edges: page.nodes.map((p) => ({ node: { pull: p, repo }, cursor: cursorOf(p.number) })),
          pageInfo: page.pageInfo,
          totalCount: page.totalCount,
        });
      }
    }
  }

  if (parentType === 'Issue' && typeof v === 'object' && 'issue' in v) {
    const { issue, repo } = v as unknown as { issue: Issue; repo: Repo };
    switch (name) {
      case 'id':
        return T('ID', issue.gid);
      case 'databaseId':
        return T('Int', issue.id);
      case 'number':
        return T('Int', issue.number);
      case 'title':
        return T('String', issue.title);
      case 'body':
        return T('String', issue.body);
      case 'state':
        return T('IssueState', issue.state === 'open' ? 'OPEN' : 'CLOSED');
      case 'url':
        return T('URI', `https://example.invalid/${repo.owner ?? store.viewer()}/${repo.name}/issues/${issue.number}`);
      case 'author':
        return T('User', { login: repo.owner ?? store.viewer(), id: '1' });
      case 'labels': {
        const page = paged(issue.labels, pageArgs(args), (_, idx) => idx + 1);
        return T('LabelConnection', {
          nodes: page.nodes,
          edges: page.nodes.map((l, i) => ({ node: l, cursor: cursorOf(i + 1) })),
          pageInfo: page.pageInfo,
          totalCount: page.totalCount,
        });
      }
      case 'comments': {
        const page = paged(issue.comments, pageArgs(args), (c) => c.id);
        return T('IssueCommentConnection', {
          nodes: page.nodes,
          edges: page.nodes.map((c) => ({ node: c, cursor: cursorOf(c.id) })),
          pageInfo: page.pageInfo,
          totalCount: page.totalCount,
        });
      }
      case 'createdAt':
      case 'updatedAt':
        return T('DateTime', store.nowIso);
      case 'closedAt':
        return T('DateTime', issue.state === 'closed' ? store.nowIso : null);
    }
  }

  if (parentType === 'PullRequest' && typeof v === 'object' && 'pull' in v) {
    const { pull, repo } = v as unknown as { pull: Pull; repo: Repo };
    switch (name) {
      case 'id':
        return T('ID', pull.gid);
      case 'databaseId':
        return T('Int', pull.id);
      case 'number':
        return T('Int', pull.number);
      case 'title':
        return T('String', pull.title);
      case 'body':
        return T('String', pull.body);
      case 'state':
        return T('PullRequestState', pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED');
      case 'headRefName':
        return T('String', pull.headRef);
      case 'baseRefName':
        return T('String', pull.baseRef);
      case 'headRefOid':
        return T('String', store.branchTip(repo, pull.headRef) ?? pull.headSha);
      case 'baseRefOid':
        return T('String', store.branchTip(repo, pull.baseRef) ?? pull.baseSha);
      case 'mergeable': {
        if (pull.state !== 'open') return T('MergeableState', 'UNKNOWN');
        return T('MergeableState', store.pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE');
      }
      case 'merged':
        return T('Boolean', pull.merged);
      case 'mergeCommit':
        return T('Commit', pull.mergeCommitSha ? { oid: pull.mergeCommitSha } : null);
      case 'files': {
        const files = store.pullFiles(repo, pull);
        const page = paged(files, pageArgs(args), (_, idx) => idx + 1);
        return T('PullRequestChangedFileConnection', {
          nodes: page.nodes,
          edges: page.nodes.map((f, i) => ({ node: f, cursor: cursorOf(i + 1) })),
          pageInfo: page.pageInfo,
          totalCount: page.totalCount,
        });
      }
      case 'author':
        return T('User', { login: repo.owner ?? store.viewer(), id: '1' });
      case 'createdAt':
      case 'updatedAt':
        return T('DateTime', store.nowIso);
      case 'closedAt':
        return T('DateTime', pull.state === 'closed' ? store.nowIso : null);
    }
  }

  if (parentType === 'User' && typeof v === 'object' && 'login' in v) {
    const u = v as unknown as { login: string; id: string; name?: string; url?: string };
    if (name === 'login') return T('String', u.login);
    if (name === 'id') return T('ID', u.id ?? '1');
    if (name === 'name') return T('String', u.name ?? u.login);
    if (name === 'url') return T('URI', u.url ?? `https://example.invalid/${u.login}`);
  }

  if (parentType === 'RepositoryOwner' && typeof v === 'object' && 'login' in v) {
    const u = v as unknown as { login: string; id: string };
    if (name === 'login') return T('String', u.login);
    if (name === 'id') return T('ID', u.id ?? '1');
  }

  if (parentType === 'Ref' && typeof v === 'object' && 'name' in v) {
    const r = v as unknown as { name: string; target: string | null };
    if (name === 'name') return T('String', r.name);
    if (name === 'target') return T('GitObject', r.target ? { oid: r.target } : null);
  }

  if (parentType === 'GitObject' && typeof v === 'object' && 'oid' in v) {
    if (name === 'oid') return T('String', (v as { oid: string }).oid);
  }

  if (parentType === 'Commit' && typeof v === 'object' && 'oid' in v) {
    if (name === 'oid') return T('String', (v as { oid: string }).oid);
    if (name === 'message') return T('String', '');
  }

  if (parentType === 'PageInfo' && typeof v === 'object') {
    const p = v as AnyObj;
    if (name in p) return T(name === 'hasNextPage' || name === 'hasPreviousPage' ? 'Boolean' : 'String', p[name]);
  }

  if ((parentType === 'IssueConnection' || parentType === 'PullRequestConnection' || parentType === 'PullRequestChangedFileConnection' || parentType === 'LabelConnection' || parentType === 'IssueCommentConnection' || parentType === 'SearchResultItemConnection') && typeof v === 'object') {
    const c = v as AnyObj;
    if (name === 'nodes') return T('List', c.nodes ?? []);
    if (name === 'edges') return T('List', c.edges ?? []);
    if (name === 'pageInfo') return T('PageInfo', c.pageInfo ?? { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null });
    if (name === 'totalCount') return T('Int', c.totalCount ?? 0);
  }

  if ((parentType === 'IssueEdge' || parentType === 'PullRequestEdge' || parentType === 'PullRequestChangedFileEdge' || parentType === 'LabelEdge' || parentType === 'IssueCommentEdge' || parentType === 'SearchResultItemEdge') && typeof v === 'object') {
    const e = v as AnyObj;
    if (name === 'node') {
      const node = e.node as unknown;
      if (node && typeof node === 'object' && 'issue' in (node as AnyObj)) return T('Issue', node);
      if (node && typeof node === 'object' && 'pull' in (node as AnyObj)) return T('PullRequest', node);
      if (node && typeof node === 'object' && 'filename' in (node as AnyObj)) return T('PullRequestChangedFile', node);
      if (node && typeof node === 'object' && 'name' in (node as AnyObj) && 'color' in (node as AnyObj)) return T('Label', node);
      if (node && typeof node === 'object' && 'body' in (node as AnyObj) && 'id' in (node as AnyObj)) return T('IssueComment', node);
      return T('Node', node ?? null);
    }
    if (name === 'cursor') return T('String', e.cursor ?? null);
  }

  if (parentType === 'PullRequestChangedFile' && typeof v === 'object') {
    const f = v as AnyObj;
    if (name === 'path') return T('String', f.filename ?? null);
    if (name === 'additions') return T('Int', f.additions ?? 0);
    if (name === 'deletions') return T('Int', f.deletions ?? 0);
    if (name === 'changeType') {
      const s = String(f.status ?? 'modified').toUpperCase();
      return T('PullRequestChangeType', s === 'ADDED' || s === 'MODIFIED' || s === 'REMOVED' ? s : 'MODIFIED');
    }
  }

  if (parentType === 'Label' && typeof v === 'object') {
    const l = v as AnyObj;
    if (name === 'name') return T('String', l.name ?? null);
    if (name === 'color') return T('String', l.color ?? null);
    if (name === 'id') return T('ID', `L:${String(l.name ?? '')}`);
  }

  if (parentType === 'IssueComment' && typeof v === 'object') {
    const c = v as AnyObj;
    if (name === 'id') return T('ID', c.gid ?? String(c.id ?? ''));
    if (name === 'databaseId') return T('Int', c.id ?? 0);
    if (name === 'body') return T('String', c.body ?? null);
    if (name === 'author') return T('User', { login: String(c.userLogin ?? store.viewer()), id: '1' });
  }

  if (parentType === 'CreateIssuePayload' || parentType === 'CloseIssuePayload') {
    const p = v as AnyObj;
    if (name === 'issue') {
      const issue = p.issue as Issue | undefined;
      if (!issue) return T('Issue', null);
      return T('Issue', { issue, repo: p.repo ?? store.reposInOrder.find((r) => r.issueByNumber.has(issue.number)) });
    }
    if (name === 'clientMutationId') return T('String', null);
  }

  if (parentType === 'CreatePullRequestPayload' || parentType === 'MergePullRequestPayload') {
    const p = v as AnyObj;
    if (name === 'pullRequest') {
      const pull = p.pull as Pull | undefined;
      if (!pull) return T('PullRequest', null);
      return T('PullRequest', { pull, repo: p.repo });
    }
    if (name === 'clientMutationId') return T('String', null);
  }

  if (parentType === 'AddCommentPayload' && typeof v === 'object') {
    const p = v as AnyObj;
    if (name === 'commentEdge') return T('IssueCommentEdge', p.commentEdge ?? null);
    if (name === 'clientMutationId') return T('String', null);
  }

  if (parentType === '__Type' && typeof v === 'object' && '__typeInfo' in v) {
    const info = (v as { __typeName: string; __typeInfo: TypeInfo }).__typeInfo;
    if (name === 'name') return T('String', (v as { __typeName: string }).__typeName);
    if (name === 'kind') return T('__TypeKind', info.kind);
    if (name === 'fields') {
      const fields = Object.entries(info.fields).map(([fname, ftype]) => ({ name: fname, type: ftype }));
      return T('List', fields);
    }
    if (name === 'enumValues') {
      return T('List', (info.enumValues ?? []).map((n) => ({ name: n })));
    }
  }

  if (parentType === '__Field' && typeof v === 'object' && 'name' in v) {
    const f = v as { name: string; type: FieldTypeInfo };
    if (name === 'name') return T('String', f.name);
    if (name === 'type') return T('__Type', { __typeName: f.type.name || 'String', __typeInfo: TYPES[f.type.name] ?? { kind: 'SCALAR', fields: {} } });
  }

  if (parentType === '__EnumValue' && typeof v === 'object' && 'name' in v) {
    if (name === 'name') return T('String', (v as { name: string }).name);
  }

  if (parentType === '__Schema' && typeof v === 'object') {
    if (name === 'queryType') return T('__Type', { __typeName: 'Query', __typeInfo: TYPES.Query! });
    if (name === 'mutationType') return T('__Type', { __typeName: 'Mutation', __typeInfo: TYPES.Mutation! });
  }

  if (parentType === 'Node' && typeof v === 'object') {
    if (name === 'id') {
      const node = v as AnyObj;
      if ('databaseId' in node) return T('ID', gid('R', (node as { databaseId: number }).databaseId));
      if ('issue' in node) return T('ID', (node as { issue: Issue }).issue.gid);
      if ('pull' in node) return T('ID', (node as { pull: Pull }).pull.gid);
    }
  }

  // A field that exists on no type we know: record the GraphQL error the
  // suite expects and yield null for that field.
  const known = TYPES[parentType];
  if (!known || !(name in known.fields)) {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
    return null;
  }
  return T('__Unknown', null);
}

function executeSelections(parentType: string, parent: unknown, selections: SelectionNode[], ctx: ExecCtx): AnyObj | null {
  if (parent === null || parent === undefined) return null;
  const out: AnyObj = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== parentType && sel.typeCondition !== 'Node') continue;
      const nested = executeSelections(parentType, parent, sel.selections, ctx);
      if (nested) Object.assign(out, nested);
      continue;
    }
    if (skipField(sel, ctx)) continue;
    const resolved = resolveField(parentType, parent, sel, ctx);
    if (resolved === null) {
      out[sel.alias ?? sel.name] = null;
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.selections.length === 0) {
      out[key] = resolved.__value;
      continue;
    }
    if (resolved.__value === null || resolved.__value === undefined) {
      out[key] = null;
      continue;
    }
    if (resolved.__typename === 'List') {
      const items = resolved.__value as unknown[];
      const itemType = inferListItemType(parentType, sel.name);
      out[key] = items.map((item) => {
        if (item === null || item === undefined) return null;
        return executeSelections(itemType, item, sel.selections, ctx);
      });
      continue;
    }
    out[key] = executeSelections(resolved.__typename, resolved.__value, sel.selections, ctx);
  }
  return out;
}

function inferListItemType(parentType: string, fieldName: string): string {
  const info = TYPES[parentType]?.fields[fieldName];
  if (info?.kind === 'LIST' && info.ofType) return info.ofType.name;
  // Connection `nodes` / `edges` are lists whose item type depends on the parent.
  if (fieldName === 'nodes') {
    if (parentType === 'IssueConnection') return 'Issue';
    if (parentType === 'PullRequestConnection') return 'PullRequest';
    if (parentType === 'PullRequestChangedFileConnection') return 'PullRequestChangedFile';
    if (parentType === 'LabelConnection') return 'Label';
    if (parentType === 'IssueCommentConnection') return 'IssueComment';
  }
  if (fieldName === 'edges') {
    if (parentType === 'IssueConnection') return 'IssueEdge';
    if (parentType === 'PullRequestConnection') return 'PullRequestEdge';
    if (parentType === 'PullRequestChangedFileConnection') return 'PullRequestChangedFileEdge';
    if (parentType === 'LabelConnection') return 'LabelEdge';
    if (parentType === 'IssueCommentConnection') return 'IssueCommentEdge';
  }
  if (fieldName === 'fields' && parentType === '__Type') return '__Field';
  if (fieldName === 'enumValues' && parentType === '__Type') return '__EnumValue';
  return 'Node';
}

function executeOperation(store: Store, op: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecCtx = { store, variables: { ...variables }, errors: [] };
  for (const def of op.varDefs) {
    if (!(def.name in ctx.variables) && def.defaultValue) ctx.variables[def.name] = valueOf(def.defaultValue, ctx);
  }
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, {}, op.selections, ctx);
  if (ctx.errors.length > 0) {
    return { data: null, errors: ctx.errors };
  }
  return { data };
}

/** Run one GraphQL request body (a single operation or a batched array). */
export function handleGraphql(store: Store, body: unknown): { status: number; json: unknown } {
  try {
    if (Array.isArray(body)) {
      const results = body.map((item) => runOne(store, item));
      return { status: 200, json: results };
    }
    return { status: 200, json: runOne(store, body) };
  } catch (err) {
    return { status: 200, json: { data: null, errors: [{ message: (err as Error).message }] } };
  }
}

function runOne(store: Store, item: unknown): Record<string, unknown> {
  if (typeof item !== 'object' || item === null) {
    return { data: null, errors: [{ message: 'GraphQL request must be an object' }] };
  }
  const req = item as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof req.query !== 'string') {
    return { data: null, errors: [{ message: 'GraphQL request must include a query string' }] };
  }
  const variables = (req.variables ?? {}) as Record<string, unknown>;
  let ops: Operation[];
  try {
    ops = new Parser(tokenize(req.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL syntax error: ${(err as Error).message}` }] };
  }
  if (ops.length === 0) return { data: null, errors: [{ message: 'empty GraphQL document' }] };
  let op = ops[0]!;
  if (typeof req.operationName === 'string') {
    const named = ops.find((o) => o.name === req.operationName);
    if (named) op = named;
  }
  return executeOperation(store, op, variables);
}

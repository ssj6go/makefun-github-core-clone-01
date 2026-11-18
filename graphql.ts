// graphql.ts — a small GraphQL v4 executor for the documents gh and
// github-mcp-server send: viewer, repository, issue(s), pullRequest(s),
// node(id:), __type introspection, the five mutations, and batched
// operation arrays. No GraphQL library: the parser and the resolver table
// below cover exactly the shapes the suite sends.
//
// Wire rules the checks rest on:
//   - an unknown field is HTTP 200 with an `errors` entry naming the field;
//   - an unknown repository is data.repository = null with no errors;
//   - an unauthenticated request is a 401 (decided by app.ts);
//   - a batched body (a JSON array of operations) is answered by an array
//     of per-operation bodies in the same order;
//   - global ids are opaque (base64 "Kind:rest") and stable across reads,
//     never the plain database id.

import { buildCommit } from './git.ts';
import {
  VIEWER_LOGIN,
  nodeId,
  store,
  userView,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { createIssueObject, mergeTree } from './rest.ts';

// ---------------------------------------------------------------------------
// document parsing
// ---------------------------------------------------------------------------

export type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue } | { __variable: string };

export interface GqlField {
  /** The response key: the alias when present, else the field name. */
  responseKey: string;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[] | null;
}

export type GqlSelection = GqlField | { fragment: string; typeCondition: string | null; selections: GqlSelection[] };

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():![]=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const next = source[i + 1]!;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let value = '';
      while (i < source.length && /[0-9.eE+-]/.test(source[i]!)) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'number', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`GraphQL parse error: unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('GraphQL parse error: unexpected end of document');
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`GraphQL parse error: expected "${value}", got ${token.value}`);
  }

  expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`GraphQL parse error: expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`GraphQL parse error: expected "${value}", got ${token.value}`);
    return token.value;
  }

  /** Skip a (...) group: variable definitions, directives, and the like. */
  skipParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return Number(token.value);
    if (token.kind === 'punct' && token.value === '$') return { __variable: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, GqlValue> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        object[key] = this.parseValue();
      }
      this.expectPunct('}');
      return object;
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // an enum value, read as its name
    }
    throw new Error(`GraphQL parse error: unexpected value ${token.value}`);
  }

  parseArguments(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    this.expectPunct('(');
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const key = this.expectName();
      this.expectPunct(':');
      args[key] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): GqlSelection {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { fragment: '', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        const name = this.next().value;
        return { fragment: name, typeCondition: null, selections: [] };
      }
      throw new Error('GraphQL parse error: bad fragment spread');
    }
    const first = this.expectName();
    let responseKey = first;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      name = this.expectName();
    }
    let args: Record<string, GqlValue> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') args = this.parseArguments();
    // Directives (@include, @skip, ...) are not used by the suite; skip them.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipParens();
    }
    let selections: GqlSelection[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selections = this.parseSelectionSet();
    return { responseKey, name, args, selections };
  }

  parseDocument(): { operations: GqlOperation[]; fragments: Map<string, GqlSelection[]> } {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlSelection[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipParens();
        operations.push({ kind, name, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        this.expectName();
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      throw new Error(`GraphQL parse error: unexpected token ${token.value}`);
    }
    return { operations, fragments };
  }
}

export function parseDocument(source: string): { operations: GqlOperation[]; fragments: Map<string, GqlSelection[]> } {
  return new Parser(tokenize(source)).parseDocument();
}

/** Resolve variables inside a parsed value. */
export function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if ('__variable' in value) return variables[(value as { __variable: string }).__variable] ?? null;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveValue(entry as GqlValue, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, variables));
  return value;
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

/** A resolved node in the response tree, carrying its GraphQL type. */
export interface GqlNode {
  __typename: string;
  [key: string]: unknown;
}

interface Ctx {
  variables: Record<string, unknown>;
  fragments: Map<string, GqlSelection[]>;
  errors: Array<{ message: string }>;
}

function arg<T>(field: GqlField, name: string, ctx: Ctx, fallback: T): T {
  const raw = field.args[name];
  if (raw === undefined) return fallback;
  return resolveValue(raw, ctx.variables) as T;
}

function decodeNodeId(id: string): { kind: string; rest: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), rest: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoNode(repo: Repo): GqlNode {
  return { __typename: 'Repository', repo };
}

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): GqlNode {
  return { __typename: 'PullRequest', repo, pull };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** The issues connection: OPEN/CLOSED filter, CREATED_AT ordering, cursors. */
function issuesConnection(repo: Repo, field: GqlField, ctx: Ctx): GqlNode {
  const first = arg<number | null>(field, 'first', ctx, null);
  const after = arg<string | null>(field, 'after', ctx, null);
  const states = arg<string[] | null>(field, 'states', ctx, null);
  const orderBy = arg<Record<string, unknown> | null>(field, 'orderBy', ctx, null);
  let list = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const direction = String(orderBy?.direction ?? 'DESC').toUpperCase();
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const afterNumber = cursorNumber(after);
  if (afterNumber !== null) {
    // Numbers run newest-first, so "after" a cursor means smaller numbers.
    list = direction === 'ASC' ? list.filter((i) => i.number > afterNumber) : list.filter((i) => i.number < afterNumber);
  }
  const page = first === null ? list : list.slice(0, first);
  const hasNextPage = first !== null && list.length > first;
  const endCursor = page.length === 0 ? null : cursorFor(page[page.length - 1]!.number);
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => issueNode(repo, i)),
    edges: page.map((i) => ({ __typename: 'IssueEdge', node: issueNode(repo, i), cursor: cursorFor(i.number) })),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: page.length === 0 ? null : cursorFor(page[0]!.number) },
    totalCount: list.length,
  };
}

function pullsConnection(repo: Repo, field: GqlField, ctx: Ctx): GqlNode {
  const first = arg<number | null>(field, 'first', ctx, null);
  const list = [...repo.pulls].sort((a, b) => b.number - a.number);
  const page = first === null ? list : list.slice(0, first);
  const hasNextPage = first !== null && list.length > first;
  const endCursor = page.length === 0 ? null : cursorFor(page[page.length - 1]!.number);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((p) => pullNode(repo, p)),
    edges: page.map((p) => ({ __typename: 'PullRequestEdge', node: pullNode(repo, p), cursor: cursorFor(p.number) })),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: page.length === 0 ? null : cursorFor(page[0]!.number) },
    totalCount: list.length,
  };
}

/** The introspection field lists gh's feature probes read. */
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'resourcePath', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'url', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'isPrivate', 'url', 'defaultBranch'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Ref: ['id', 'name', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

/** Resolve one field of one node; unknown fields become errors, not throws. */
function resolveField(node: GqlNode, field: GqlField, ctx: Ctx): unknown {
  const type = node.__typename;
  switch (type) {
    case 'Query': {
      if (field.name === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN, id: store.userId(VIEWER_LOGIN)! };
      if (field.name === 'repository') {
        const owner = arg<string>(field, 'owner', ctx, '');
        const name = arg<string>(field, 'name', ctx, '');
        const repo = store.getRepo(owner, name);
        return repo === undefined ? null : repoNode(repo);
      }
      if (field.name === 'node') {
        const id = arg<string>(field, 'id', ctx, '');
        const decoded = decodeNodeId(id);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = [...store.allRepos()].find((r) => r.id === Number(decoded.rest));
          return repo === undefined ? null : repoNode(repo);
        }
        if (decoded.kind === 'Issue') {
          const [repoId, number] = decoded.rest.split(':');
          const repo = [...store.allRepos()].find((r) => r.id === Number(repoId));
          const issue = repo?.issues.find((i) => i.number === Number(number));
          return issue === undefined || repo === undefined ? null : issueNode(repo, issue);
        }
        if (decoded.kind === 'PullRequest') {
          const [repoId, number] = decoded.rest.split(':');
          const repo = [...store.allRepos()].find((r) => r.id === Number(repoId));
          const pull = repo?.pulls.find((p) => p.number === Number(number));
          return pull === undefined || repo === undefined ? null : pullNode(repo, pull);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = arg<string>(field, 'name', ctx, '');
        return { __typename: '__Type', name, fields: TYPE_FIELDS[name] ?? null, enumValues: TYPE_ENUM_VALUES[name] ?? null };
      }
      if (field.name === '__schema') return { __typename: '__Schema', queryType: { __typename: '__Type', name: 'Query' } };
      break;
    }
    case 'User': {
      if (field.name === 'login') return node.login;
      if (field.name === 'id') return nodeId('User', node.id as number);
      if (field.name === 'name') return node.login;
      if (field.name === 'email') return `${node.login}@example.invalid`;
      if (field.name === 'url') return `https://github.com/${node.login}`;
      break;
    }
    case 'Repository': {
      const repo = node.repo as Repo;
      if (field.name === 'id') return repo.view().node_id;
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return repo.fullName;
      if (field.name === 'owner') return { __typename: 'User', login: repo.ownerLogin, id: repo.ownerId };
      if (field.name === 'defaultBranchRef') {
        const tip = repo.defaultTip;
        return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      if (field.name === 'viewerPermission') return repo.ownerLogin === VIEWER_LOGIN ? 'ADMIN' : 'WRITE';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'description') return repo.description;
      if (field.name === 'isPrivate') return repo.private;
      if (field.name === 'url') return `https://github.com/${repo.fullName}`;
      if (field.name === 'createdAt') return repo.createdAt;
      if (field.name === 'updatedAt') return repo.updatedAt;
      if (field.name === 'defaultBranch') return repo.defaultBranch;
      if (field.name === 'issue') {
        const number = arg<number>(field, 'number', ctx, 0);
        const issue = repo.issues.find((i) => i.number === number);
        return issue === undefined ? null : issueNode(repo, issue);
      }
      if (field.name === 'issues') return issuesConnection(repo, field, ctx);
      if (field.name === 'pullRequests') return pullsConnection(repo, field, ctx);
      if (field.name === 'pullRequest') {
        const number = arg<number>(field, 'number', ctx, 0);
        const pull = repo.pulls.find((p) => p.number === number);
        return pull === undefined ? null : pullNode(repo, pull);
      }
      break;
    }
    case 'Issue': {
      const issue = node.issue as Issue;
      if (field.name === 'id') return issue.node_id;
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state.toUpperCase();
      if (field.name === 'body') return issue.body;
      if (field.name === 'createdAt') return issue.created_at;
      if (field.name === 'updatedAt') return issue.updated_at;
      if (field.name === 'closedAt') return issue.closed_at;
      if (field.name === 'author') return { __typename: 'User', login: issue.user.login, id: issue.user.id };
      if (field.name === 'url') return issue.html_url;
      if (field.name === 'resourcePath') return `/${(node.repo as Repo).fullName}/issues/${issue.number}`;
      if (field.name === 'repository') return repoNode(node.repo as Repo);
      break;
    }
    case 'PullRequest': {
      const pull = node.pull as Pull;
      const repo = node.repo as Repo;
      if (field.name === 'id') return pull.node_id;
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'mergeable') {
        if (pull.state !== 'open') return 'UNKNOWN';
        return mergeTree(repo, pull.base_sha_at_open, pull.head.sha, pull.base.ref).conflict ? 'CONFLICTING' : 'MERGEABLE';
      }
      if (field.name === 'headRefName') return pull.head.ref;
      if (field.name === 'baseRefName') return pull.base.ref;
      if (field.name === 'headRef') return { __typename: 'Ref', name: pull.head.ref };
      if (field.name === 'baseRef') return { __typename: 'Ref', name: pull.base.ref };
      if (field.name === 'createdAt') return pull.created_at;
      if (field.name === 'updatedAt') return pull.updated_at;
      if (field.name === 'closedAt') return pull.closed_at;
      if (field.name === 'mergedAt') return pull.merged_at;
      if (field.name === 'author') return { __typename: 'User', login: pull.user.login, id: pull.user.id };
      if (field.name === 'url') return pull.html_url;
      if (field.name === 'repository') return repoNode(repo);
      if (field.name === 'files') {
        const first = arg<number | null>(field, 'first', ctx, null);
        const files = repo.diffFiles(pull.base_sha_at_open, pull.head.sha);
        const page = first === null ? files : files.slice(0, first);
        return {
          __typename: 'PullRequestFileConnection',
          nodes: page.map((f) => ({ __typename: 'PullRequestFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() })),
          edges: page.map((f) => ({ __typename: 'PullRequestFileEdge', node: { __typename: 'PullRequestFile', path: f.filename }, cursor: cursorFor(0) })),
          pageInfo: { __typename: 'PageInfo', hasNextPage: first !== null && files.length > first, endCursor: null, hasPreviousPage: false, startCursor: null },
          totalCount: files.length,
        };
      }
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return node.name;
      if (field.name === 'id') return nodeId('Ref', String(node.name));
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection': {
      if (field.name === 'nodes') return node.nodes;
      if (field.name === 'edges') return node.edges;
      if (field.name === 'pageInfo') return node.pageInfo;
      if (field.name === 'totalCount') return node.totalCount;
      break;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestFileEdge': {
      if (field.name === 'node') return node.node;
      if (field.name === 'cursor') return node.cursor;
      break;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return node.hasNextPage;
      if (field.name === 'hasPreviousPage') return node.hasPreviousPage;
      if (field.name === 'startCursor') return node.startCursor;
      if (field.name === 'endCursor') return node.endCursor;
      break;
    }
    case 'PullRequestFile': {
      if (field.name === 'path') return node.path;
      if (field.name === 'additions') return node.additions;
      if (field.name === 'deletions') return node.deletions;
      if (field.name === 'changeType') return node.changeType;
      break;
    }
    case '__Type': {
      if (field.name === 'name') return node.name;
      if (field.name === 'kind') return node.enumValues !== null ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        const names = (node.fields as string[] | null) ?? [];
        return names.map((name) => ({ __typename: '__Field', name }));
      }
      if (field.name === 'enumValues') {
        const names = (node.enumValues as string[] | null) ?? [];
        return names.map((name) => ({ __typename: '__EnumValue', name }));
      }
      break;
    }
    case '__Field': {
      if (field.name === 'name') return node.name;
      if (field.name === 'description') return null;
      if (field.name === 'args') return [];
      break;
    }
    case '__EnumValue': {
      if (field.name === 'name') return node.name;
      if (field.name === 'description') return null;
      break;
    }
    case '__Schema': {
      if (field.name === 'queryType') return node.queryType;
      break;
    }
  }
  ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${type}'` });
  return null;
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

export function createPullObject(repo: Repo, head: string, base: string, title: string, body: string): Pull | null {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const number = repo.numberSeq;
  repo.numberSeq += 1;
  const created = repo.nextStamp();
  const repoView = repo.view();
  const pull: Pull = {
    id: store.nextPullId(),
    node_id: nodeId('PullRequest', `${repo.id}:${number}`),
    number,
    title,
    body,
    state: 'open',
    merged: false,
    mergeable: true,
    merged_at: null,
    merge_commit_sha: null,
    user: userView(VIEWER_LOGIN, store.userId(VIEWER_LOGIN)!, 'User'),
    head: { ref: head, sha: headSha, repo: repoView },
    base: { ref: base, sha: baseSha, repo: repoView },
    base_sha_at_open: baseSha,
    created_at: created,
    updated_at: created,
    closed_at: null,
    html_url: `https://github.com/${repo.fullName}/pull/${number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${number}`,
    comments: [],
  };
  repo.pulls.push(pull);
  return pull;
}

/** Squash-merge a pull request; returns false on conflict or a closed PR. */
export function mergePullObject(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const baseRef = `refs/heads/${pull.base.ref}`;
  const currentBase = repo.refs.get(baseRef);
  if (currentBase === undefined) return false;
  const merged = mergeTree(repo, pull.base_sha_at_open, pull.head.sha, pull.base.ref);
  if (merged.conflict || merged.treeOid === null) return false;
  const message = `${pull.title} (#${pull.number})`;
  const mergeOid = repo.putObject('commit', buildCommit({ tree: merged.treeOid, parents: [currentBase], message }));
  repo.refs.set(baseRef, mergeOid);
  repo.pushedAt = repo.nextStamp();
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = repo.nextStamp();
  pull.merge_commit_sha = mergeOid;
  pull.closed_at = pull.merged_at;
  pull.updated_at = pull.merged_at;
  return true;
}

/** Resolve one mutation field into its payload node. */
function resolveMutation(field: GqlField, ctx: Ctx): GqlNode | null {
  const input = arg<Record<string, unknown>>(field, 'input', ctx, {});
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  switch (field.name) {
    case 'createIssue': {
      const decoded = decodeNodeId(str(input.repositoryId));
      const repo = decoded?.kind === 'Repository' ? [...store.allRepos()].find((r) => r.id === Number(decoded.rest)) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided' });
        return null;
      }
      const created = createIssueObject(repo, { title: str(input.title), body: str(input.body) });
      if (!('number' in created)) {
        ctx.errors.push({ message: 'Could not create the issue' });
        return null;
      }
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, created as Issue) };
    }
    case 'closeIssue': {
      const decoded = decodeNodeId(str(input.issueId));
      const repo = decoded?.kind === 'Issue' ? [...store.allRepos()].find((r) => r.id === Number(decoded.rest.split(':')[0])) : undefined;
      const issue = repo?.issues.find((i) => i.number === Number(decoded?.rest.split(':')[1]));
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided' });
        return null;
      }
      issue.state = 'closed';
      issue.closed_at = repo.nextStamp();
      issue.updated_at = issue.closed_at;
      return { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue) };
    }
    case 'createPullRequest': {
      const decoded = decodeNodeId(str(input.repositoryId));
      const repo = decoded?.kind === 'Repository' ? [...store.allRepos()].find((r) => r.id === Number(decoded.rest)) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided' });
        return null;
      }
      const pull = createPullObject(repo, str(input.headRefName), str(input.baseRefName), str(input.title), str(input.body));
      if (pull === null) {
        ctx.errors.push({ message: 'Could not create the pull request: the head or base branch does not exist' });
        return null;
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
    }
    case 'mergePullRequest': {
      const decoded = decodeNodeId(str(input.pullRequestId));
      const repo = decoded?.kind === 'PullRequest' ? [...store.allRepos()].find((r) => r.id === Number(decoded.rest.split(':')[0])) : undefined;
      const pull = repo?.pulls.find((p) => p.number === Number(decoded?.rest.split(':')[1]));
      if (repo === undefined || pull === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided' });
        return null;
      }
      if (!mergePullObject(repo, pull)) {
        ctx.errors.push({ message: 'Merge conflict' });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
    }
    case 'addComment': {
      const decoded = decodeNodeId(str(input.subjectId));
      const repo = decoded !== null ? [...store.allRepos()].find((r) => r.id === Number(decoded.rest.split(':')[0])) : undefined;
      const issue = decoded?.kind === 'Issue' ? repo?.issues.find((i) => i.number === Number(decoded.rest.split(':')[1])) : undefined;
      const pull = decoded?.kind === 'PullRequest' ? repo?.pulls.find((p) => p.number === Number(decoded.rest.split(':')[1])) : undefined;
      const target = issue ?? pull;
      if (repo === undefined || target === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a subject with the id provided' });
        return null;
      }
      const id = store.nextCommentId();
      const created = repo.nextStamp();
      const comment = {
        id,
        node_id: nodeId('IssueComment', `${repo.id}:${target.number}:${id}`),
        body: str(input.body),
        user: userView(VIEWER_LOGIN, store.userId(VIEWER_LOGIN)!, 'User'),
        created_at: created,
        updated_at: created,
        html_url: `https://github.com/${repo.fullName}/issues/${target.number}#issuecomment-${id}`,
        url: `/api/v3/repos/${repo.fullName}/issues/comments/${id}`,
      };
      target.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: comment.node_id, body: comment.body },
          cursor: cursorFor(0),
        },
      };
    }
    default: {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Mutation'` });
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// selection execution
// ---------------------------------------------------------------------------

function executeValue(value: unknown, selections: GqlSelection[] | null, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => executeValue(entry, selections, ctx));
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    if (selections === null) return value;
    return executeSelections(value as GqlNode, selections, ctx);
  }
  return value;
}

function executeSelections(node: GqlNode, selections: GqlSelection[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if ('fragment' in selection) {
      if (selection.fragment !== '') {
        const frag = ctx.fragments.get(selection.fragment);
        if (frag !== undefined) Object.assign(out, executeSelections(node, frag, ctx));
      } else if (selection.typeCondition === null || selection.typeCondition === node.__typename) {
        Object.assign(out, executeSelections(node, selection.selections, ctx));
      }
      continue;
    }
    const value = resolveField(node, selection, ctx);
    out[selection.responseKey] = executeValue(value, selection.selections, ctx);
  }
  return out;
}

/** Execute one parsed operation against the store. */
export function executeOperation(operation: GqlOperation, variables: Record<string, unknown>, fragments: Map<string, GqlSelection[]>): { data: Record<string, unknown>; errors: Array<{ message: string }> } {
  const ctx: Ctx = { variables, fragments, errors: [] };
  if (operation.kind === 'mutation') {
    const out: Record<string, unknown> = {};
    for (const selection of operation.selections) {
      if ('fragment' in selection) continue;
      const payload = resolveMutation(selection, ctx);
      out[selection.responseKey] = payload === null ? null : executeValue(payload, selection.selections, ctx);
    }
    return { data: out, errors: ctx.errors };
  }
  const root: GqlNode = { __typename: 'Query' };
  return { data: executeSelections(root, operation.selections, ctx), errors: ctx.errors };
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

export interface GraphQLHttpResult {
  status: number;
  body: unknown;
}

/** Run one operation body ({query, variables, operationName}) and answer it. */
function runOne(body: unknown): { status: number; body: Record<string, unknown> } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { errors: [{ message: 'The request body must be a JSON object with a query string' }] } };
  }
  const query = (body as Record<string, unknown>).query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { status: 400, body: { errors: [{ message: 'A query string is required' }] } };
  }
  const variables = (body as Record<string, unknown>).variables;
  const vars: Record<string, unknown> = variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
  let parsed: { operations: GqlOperation[]; fragments: Map<string, GqlSelection[]> };
  try {
    parsed = parseDocument(query);
  } catch (err) {
    return { status: 200, body: { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] } };
  }
  if (parsed.operations.length === 0) {
    return { status: 200, body: { data: null, errors: [{ message: 'The document holds no operation' }] } };
  }
  const operationName = (body as Record<string, unknown>).operationName;
  let operation = parsed.operations[0]!;
  if (typeof operationName === 'string' && operationName !== '') {
    operation = parsed.operations.find((op) => op.name === operationName) ?? operation;
  }
  const result = executeOperation(operation, vars, parsed.fragments);
  const out: Record<string, unknown> = { data: result.data };
  if (result.errors.length > 0) out.errors = result.errors;
  return { status: 200, body: out };
}

/**
 * Handle a POST /api/graphql request body (already parsed JSON, or null when
 * the body was not valid JSON). A JSON array is GitHub's operation batching:
 * one response per operation, in order.
 */
export function handleGraphQL(body: unknown, bodyMalformed: boolean): GraphQLHttpResult {
  if (bodyMalformed) {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => runOne(entry).body) };
  }
  return runOne(body);
}

// rest.ts — the GitHub REST v3 surface: repositories, branches, commits,
// contents, issues, comments, labels, pull requests, files and merges.
//
// Conventions the suite checks, kept in one place:
//   - every reply is application/json and carries a non-empty
//     X-GitHub-Request-Id, including 401s and 404s;
//   - errors are {"message": "<non-empty string>"} with the GitHub status
//     (401 no token, 404 unknown repo/route, 409 stale sha, 422 validation);
//   - a malformed JSON body is a 400;
//   - list replies honour page/per_page and carry a Link header with
//     rel="next" while there are more pages;
//   - issues and pull requests share one number counter per repo.

import {
  parseCommit,
  parseTree,
  ZERO_OID,
  buildCommit,
  buildTree,
  type GitObject,
} from './git.ts';
import {
  DEFAULT_BRANCH,
  ORG_LOGIN,
  VIEWER_LOGIN,
  nodeId,
  stamp,
  store,
  userView,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** The parsed JSON body, or undefined when there is none. */
  body: unknown;
  /** True when the body was present but not valid JSON. */
  bodyMalformed: boolean;
  headers: Record<string, string | undefined>;
  /** The request's origin, e.g. "http://127.0.0.1:4123", for Link headers. */
  origin: string;
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

export function json(status: number, body: unknown, extra: Record<string, string> = {}): RestResponse {
  return { status, body, headers: { 'x-github-request-id': requestId(), ...extra } };
}

function err(status: number, message: string): RestResponse {
  return json(status, { message });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyOf(req: RestRequest): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** page/per_page from the query, clamped to GitHub's ranges. */
export function pagination(req: RestRequest): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** A page slice plus the Link header for the next page, when there is one. */
export function pageOf<T>(req: RestRequest, items: readonly T[]): { items: T[]; link: string | null } {
  const { page, perPage } = pagination(req);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const url = new URL(req.path, req.origin);
    url.searchParams.set('page', String(page + 1));
    url.searchParams.set('per_page', String(perPage));
    link = `<${url.toString()}>; rel="next"`;
  }
  return { items: slice, link };
}

function paged(req: RestRequest, items: readonly unknown[]): RestResponse {
  const { items: slice, link } = pageOf(req, items);
  return json(200, slice, link === null ? {} : { link });
}

// ---------------------------------------------------------------------------
// shared views
// ---------------------------------------------------------------------------

export function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.node_id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: issue.user,
    labels: issue.labels.map((l) => labelView(repo, l)),
    assignees: issue.assignees,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: issue.html_url,
    url: issue.url,
  };
}

export function labelView(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: label.node_id,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: label.url,
  };
}

export function commentView(repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.node_id,
    body: comment.body,
    user: comment.user,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: comment.html_url,
    url: comment.url,
  };
}

/** The three-way merge of `head` onto `base`, from their merge-base. */
export function mergeTree(repo: Repo, baseOid: string, headOid: string, baseRef: string): { conflict: boolean; treeOid: string | null } {
  const baseFiles = repo.filesOf(baseOid);
  const headFiles = repo.filesOf(headOid);
  const currentBase = repo.refs.get(`refs/heads/${baseRef}`) ?? baseOid;
  const currentFiles = repo.filesOf(currentBase);
  const merged = new Map(currentFiles);
  for (const [path, entry] of headFiles) {
    const baseEntry = baseFiles.get(path);
    const currentEntry = currentFiles.get(path);
    if (baseEntry?.oid === entry.oid) continue; // unchanged on the head side
    if (currentEntry?.oid !== baseEntry?.oid && currentEntry?.oid !== entry.oid) {
      return { conflict: true, treeOid: null }; // changed on both sides, differently
    }
    merged.set(path, entry);
  }
  for (const path of baseFiles.keys()) {
    if (headFiles.has(path)) continue; // deleted on the head side
    const baseEntry = baseFiles.get(path)!;
    const currentEntry = currentFiles.get(path);
    if (currentEntry?.oid !== baseEntry.oid) return { conflict: true, treeOid: null };
    merged.delete(path);
  }
  // Rebuild the tree from the merged file map.
  const root = buildTreeFromMap(repo, merged);
  return { conflict: false, treeOid: root };
}

/** Build a tree object from a flat path map, creating intermediate trees. */
export function buildTreeFromMap(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  return buildFromRelative(repo, files);
}

function buildFromRelative(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  const entries: Array<{ mode: string; name: string; oid: string; type: 'blob' | 'tree' }> = [];
  const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
  for (const [path, entry] of files) {
    const slash = path.indexOf('/');
    if (slash < 0) entries.push({ mode: entry.mode, name: path, oid: entry.oid, type: 'blob' });
    else {
      const dir = path.slice(0, slash);
      if (!dirs.has(dir)) dirs.set(dir, new Map());
      dirs.get(dir)!.set(path.slice(slash + 1), entry);
    }
  }
  for (const [dir, sub] of dirs) {
    entries.push({ mode: '40000', name: dir, oid: buildFromRelative(repo, sub), type: 'tree' });
  }
  return repo.putObject('tree', buildTree(entries));
}

export function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  const headRepo = pull.head.repo;
  const baseRepo = pull.base.repo;
  return {
    id: pull.id,
    node_id: pull.node_id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? !mergeTree(repo, pull.base_sha_at_open, pull.head.sha, pull.base.ref).conflict : null,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    user: pull.user,
    head: {
      ref: pull.head.ref,
      sha: pull.head.sha,
      repo: headRepo,
      label: headRepo === null ? pull.head.ref : `${headRepo.owner.login}:${pull.head.ref}`,
    },
    base: {
      ref: pull.base.ref,
      sha: pull.base.sha,
      repo: baseRepo,
      label: baseRepo === null ? pull.base.ref : `${baseRepo.owner.login}:${pull.base.ref}`,
    },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    html_url: pull.html_url,
    url: pull.url,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commitView(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.getObject(sha);
  if (!object || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  const author = { name: 'github-core-clone', email: 'forge@localhost', date: stamp(repo.id) };
  return {
    sha,
    node_id: nodeId('Commit', sha),
    commit: {
      author,
      committer: author,
      message: view.message,
      tree: { sha: view.tree, url: `/api/v3/repos/${repo.fullName}/git/trees/${view.tree}` },
      url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
      comment_count: 0,
    },
    author: userView(VIEWER_LOGIN, store.userId(VIEWER_LOGIN)!, 'User'),
    committer: userView(VIEWER_LOGIN, store.userId(VIEWER_LOGIN)!, 'User'),
    parents: view.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.fullName}/git/commits/${p}` })),
    url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
    html_url: `https://github.com/${repo.fullName}/commit/${sha}`,
  };
}

/** Commits reachable from `tip`, newest first (breadth-first from the tip). */
function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    const object = repo.getObject(sha);
    if (!object || object.type !== 'commit') continue;
    seen.add(sha);
    out.push(sha);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

type Handler = (req: RestRequest, params: Record<string, string>) => RestResponse;

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, pattern: string, handler: Handler): void {
  const keys: string[] = [];
  const source = pattern.replace(/:([a-zA-Z_]+)/g, (_m, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
}

function findRepo(owner: string, name: string): Repo | null {
  return store.getRepo(decodeURIComponent(owner), decodeURIComponent(name)) ?? null;
}

function requireRepo(req: RestRequest, owner: string, name: string): Repo | RestResponse {
  const repo = findRepo(owner, name);
  if (repo === null) return err(404, 'Not Found');
  return repo;
}

// ---------------------------------------------------------------------------
// API root, meta, rate limit, user
// ---------------------------------------------------------------------------

route('GET', '/api/v3', () => {
  return json(200, {
    current_user_url: '/api/v3/user',
    current_user_authorizations_html_url: 'https://github.com/settings/applications',
    authorizations_url: '/api/v3/authorizations',
    code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
    commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
    emails_url: '/api/v3/user/emails',
    emojis_url: '/api/v3/emojis',
    events_url: '/api/v3/events',
    feeds_url: '/api/v3/feeds',
    followers_url: '/api/v3/user/followers',
    following_url: '/api/v3/user/following{/target}',
    gists_url: '/api/v3/gists{/gist_id}',
    hub_url: '/api/v3/hub',
    issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
    issues_url: '/api/v3/issues',
    keys_url: '/api/v3/user/keys',
    label_search_url: '/api/v3/search/labels?q={query}{&repository_id}{&page,per_page}',
    notifications_url: '/api/v3/notifications',
    organization_url: '/api/v3/orgs/{org}',
    organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
    organization_teams_url: '/api/v3/orgs/{org}/teams',
    public_gists_url: '/api/v3/gists/public',
    rate_limit_url: '/api/v3/rate_limit',
    repository_url: '/api/v3/repos/{owner}/{repo}',
    repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
    current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
    starred_url: '/api/v3/user/starred{/owner}{/repo}',
    starred_gists_url: '/api/v3/gists/starred',
    topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
    user_url: '/api/v3/users/{user}',
    user_organizations_url: '/api/v3/user/orgs',
    user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
    user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
  }, { 'x-oauth-scopes': 'repo, read:org' });
});

route('GET', '/api/v3/meta', () => {
  return json(200, {
    verifiable_password_authentication: true,
    installed_version: '1.0.0',
    ssh_key_fingerprints: {},
    hooks: [],
    git: [],
    pages: [],
    importer: [],
    actions: [],
    dependabot: [],
  });
});

route('GET', '/api/v3/rate_limit', () => {
  const reset = 1735689600 + 3600;
  return json(200, {
    resources: {
      core: { limit: 5000, remaining: 4999, reset, used: 1 },
      search: { limit: 30, remaining: 30, reset, used: 0 },
      graphql: { limit: 5000, remaining: 5000, reset, used: 0 },
    },
    rate: { limit: 5000, remaining: 4999, reset, used: 1 },
  });
});

route('GET', '/api/v3/user', () => {
  return json(200, userView(VIEWER_LOGIN, store.userId(VIEWER_LOGIN)!, 'User'));
});

route('GET', '/api/v3/users/:login', (_req, params) => {
  const login = decodeURIComponent(params.login!);
  const id = store.userId(login);
  if (id === undefined) return err(404, 'Not Found');
  return json(200, userView(login, id, store.userType(login)));
});

route('GET', '/api/v3/orgs/:org', (_req, params) => {
  const login = decodeURIComponent(params.org!);
  const id = store.userId(login);
  if (id === undefined) return err(404, 'Not Found');
  return json(200, userView(login, id, 'Organization'));
});

// ---------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------

function validRepoName(name: string): boolean {
  return name.length >= 1 && name.length <= 100 && /^[A-Za-z0-9._-]+$/.test(name);
}

route('POST', '/api/v3/user/repos', (req) => {
  if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
  const body = bodyOf(req);
  const name = str(body.name);
  if (!validRepoName(name)) return err(422, 'Validation Failed: name is invalid');
  if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return err(422, 'Validation Failed: name already exists on this account');
  const repo = store.createRepo(VIEWER_LOGIN, name, {
    private: body.private === true,
    description: typeof body.description === 'string' ? body.description : null,
  });
  return json(201, repo.view());
});

route('POST', '/api/v3/orgs/:org/repos', (req, params) => {
  if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
  const org = decodeURIComponent(params.org!);
  if (store.userId(org) === undefined) return err(404, 'Not Found');
  const body = bodyOf(req);
  const name = str(body.name);
  if (!validRepoName(name)) return err(422, 'Validation Failed: name is invalid');
  if (store.getRepo(org, name) !== undefined) return err(422, 'Validation Failed: name already exists on this account');
  const repo = store.createRepo(org, name, {
    private: body.private === true,
    description: typeof body.description === 'string' ? body.description : null,
  });
  return json(201, repo.view());
});

route('GET', '/api/v3/user/repos', (req) => {
  return paged(req, store.reposOf(VIEWER_LOGIN).map((r) => r.view()));
});

route('GET', '/api/v3/orgs/:org/repos', (req, params) => {
  const org = decodeURIComponent(params.org!);
  if (store.userId(org) === undefined) return err(404, 'Not Found');
  return paged(req, store.reposOf(org).map((r) => r.view()));
});

route('GET', '/api/v3/users/:login/repos', (req, params) => {
  const login = decodeURIComponent(params.login!);
  if (store.userId(login) === undefined) return err(404, 'Not Found');
  return paged(req, store.reposOf(login).map((r) => r.view()));
});

route('GET', '/api/v3/repos/:owner/:repo', (_req, params) => {
  const repo = requireRepo(_req, params.owner!, params.repo!);
  if (!('view' in repo)) return repo as RestResponse;
  return json(200, (repo as Repo).view());
});

route('PATCH', '/api/v3/repos/:owner/:repo', (req, params) => {
  if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const body = bodyOf(req);
  if (typeof body.description === 'string' || body.description === null) repo.description = body.description;
  if (typeof body.name === 'string' && validRepoName(body.name) && body.name !== repo.name) {
    if (store.getRepo(repo.ownerLogin, body.name) !== undefined) return err(422, 'Validation Failed: name already exists on this account');
    store.deleteRepo(repo.ownerLogin, repo.name);
    (repo as unknown as { name: string }).name = body.name;
    store.repos.set(repo.fullName, repo);
  }
  repo.updatedAt = stamp(repo.id * 1000 + 1);
  return json(200, repo.view());
});

route('DELETE', '/api/v3/repos/:owner/:repo', (req, params) => {
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  store.deleteRepo(repo.ownerLogin, repo.name);
  return json(204, null);
});

// ---------------------------------------------------------------------------
// branches, commits, git data
// ---------------------------------------------------------------------------

route('GET', '/api/v3/repos/:owner/:repo/branches', (req, params) => {
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const list = repo.branches().map((name) => ({
    name,
    commit: { sha: repo.refs.get(`refs/heads/${name}`)!, url: `/api/v3/repos/${repo.fullName}/git/commits/${repo.refs.get(`refs/heads/${name}`)!}` },
    protected: false,
  }));
  return paged(req, list);
});

route('GET', '/api/v3/repos/:owner/:repo/branches/:branch', (req, params) => {
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const branch = decodeURIComponent(params.branch!);
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) return err(404, 'Not Found');
  return json(200, {
    name: branch,
    commit: { sha, url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
    protected: false,
  });
});

route('GET', '/api/v3/repos/:owner/:repo/commits', (req, params) => {
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const shaParam = req.query.get('sha');
  let tip: string | undefined;
  if (shaParam !== null && shaParam !== '') {
    tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.getObject(shaParam)?.type === 'commit' ? shaParam : undefined);
    if (tip === undefined) return err(404, 'Not Found');
  } else {
    tip = repo.defaultTip;
  }
  if (tip === undefined) return json(200, []);
  const shas = listCommits(repo, tip);
  const views = shas.map((sha) => commitView(repo, sha)).filter((v): v is Record<string, unknown> => v !== null);
  return paged(req, views);
});

route('GET', '/api/v3/repos/:owner/:repo/commits/:sha', (req, params) => {
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const view = commitView(repo, decodeURIComponent(params.sha!));
  if (view === null) return err(404, 'Not Found');
  return json(200, view);
});

route('POST', '/api/v3/repos/:owner/:repo/git/refs', (req, params) => {
  if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const body = bodyOf(req);
  const ref = str(body.ref);
  const sha = str(body.sha);
  if (!ref.startsWith('refs/')) return err(422, 'Validation Failed: ref must start with refs/');
  if (!/^[0-9a-f]{40}$/i.test(sha)) return err(422, 'Validation Failed: sha is invalid');
  const object = repo.getObject(sha.toLowerCase());
  if (object === undefined || object.type !== 'commit') return err(422, 'Validation Failed: sha is not a commit');
  if (repo.refs.has(ref)) return err(422, 'Validation Failed: ref already exists');
  repo.refs.set(ref, sha.toLowerCase());
  return json(201, {
    ref,
    node_id: nodeId('Ref', `${repo.id}:${ref}`),
    url: `/api/v3/repos/${repo.fullName}/git/refs/${ref.replace(/^refs\//, '')}`,
    object: { sha: sha.toLowerCase(), type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha.toLowerCase()}` },
  });
});

// (GET /git/refs/<ref...> is handled by prefix matching in handleRest,
// because a ref can be any number of segments deep.)

route('GET', '/api/v3/repos/:owner/:repo/git/commits/:sha', (req, params) => {
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const sha = decodeURIComponent(params.sha!).toLowerCase();
  const object = repo.getObject(sha);
  if (!object || object.type !== 'commit') return err(404, 'Not Found');
  const view = parseCommit(object.data);
  return json(200, {
    sha,
    node_id: nodeId('Commit', sha),
    url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
    author: { name: 'github-core-clone', email: 'forge@localhost', date: stamp(repo.id) },
    committer: { name: 'github-core-clone', email: 'forge@localhost', date: stamp(repo.id) },
    message: view.message,
    tree: { sha: view.tree, url: `/api/v3/repos/${repo.fullName}/git/trees/${view.tree}` },
    parents: view.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.fullName}/git/commits/${p}` })),
  });
});

route('POST', '/api/v3/repos/:owner/:repo/git/commits', (req, params) => {
  if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const body = bodyOf(req);
  const message = str(body.message);
  const tree = str(body.tree);
  const parents = Array.isArray(body.parents) ? body.parents.map((p) => str(p)).filter((p) => /^[0-9a-f]{40}$/i.test(p)) : [];
  if (message === '' || !/^[0-9a-f]{40}$/i.test(tree)) return err(422, 'Validation Failed: message and tree are required');
  const treeObject = repo.getObject(tree.toLowerCase());
  if (!treeObject || treeObject.type !== 'tree') return err(422, 'Validation Failed: tree does not exist');
  const oid = repo.putObject('commit', buildCommit({ tree: tree.toLowerCase(), parents: parents.map((p) => p.toLowerCase()), message }));
  return json(201, { sha: oid, node_id: nodeId('Commit', oid), url: `/api/v3/repos/${repo.fullName}/git/commits/${oid}`, message, tree: { sha: tree.toLowerCase() }, parents: parents.map((p) => ({ sha: p })) });
});

route('GET', '/api/v3/repos/:owner/:repo/git/trees/:sha', (req, params) => {
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const sha = decodeURIComponent(params.sha!).toLowerCase();
  const object = repo.getObject(sha);
  if (!object || object.type !== 'tree') return err(404, 'Not Found');
  const recursive = req.query.get('recursive') === '1';
  const entries: Array<Record<string, unknown>> = [];
  const walk = (treeOid: string, prefix: string): void => {
    const obj = repo.getObject(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      entries.push({ path, mode: entry.mode, type: entry.type, sha: entry.oid, url: `/api/v3/repos/${repo.fullName}/git/${entry.type === 'tree' ? 'trees' : 'blobs'}/${entry.oid}` });
      if (recursive && entry.type === 'tree') walk(entry.oid, path);
    }
  };
  walk(sha, '');
  return json(200, { sha, url: `/api/v3/repos/${repo.fullName}/git/trees/${sha}`, tree: entries, truncated: false });
});

route('GET', '/api/v3/repos/:owner/:repo/git/blobs/:sha', (req, params) => {
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const sha = decodeURIComponent(params.sha!).toLowerCase();
  const object = repo.getObject(sha);
  if (!object || object.type !== 'blob') return err(404, 'Not Found');
  return json(200, {
    sha,
    size: object.data.length,
    content: object.data.toString('base64'),
    encoding: 'base64',
    url: `/api/v3/repos/${repo.fullName}/git/blobs/${sha}`,
  });
});

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function contentFileView(repo: Repo, path: string, blobOid: string, ref: string): Record<string, unknown> {
  const object = repo.getObject(blobOid)!;
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: object.data.length,
    name,
    path,
    content: object.data.toString('base64'),
    sha: blobOid,
    url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
    git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`,
    html_url: `https://github.com/${repo.fullName}/blob/${ref}/${path}`,
    download_url: null,
    _links: { git: `/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`, self: `/api/v3/repos/${repo.fullName}/contents/${path}`, html: `https://github.com/${repo.fullName}/blob/${ref}/${path}` },
  };
}

function resolveRef(repo: Repo, refParam: string | null): { tip: string; refName: string } | null {
  if (refParam === null || refParam === '') {
    const tip = repo.defaultTip;
    return tip === undefined ? null : { tip, refName: repo.defaultBranch };
  }
  const branchTip = repo.refs.get(`refs/heads/${refParam}`);
  if (branchTip !== undefined) return { tip: branchTip, refName: refParam };
  const object = repo.getObject(refParam.toLowerCase());
  if (object && object.type === 'commit') return { tip: refParam.toLowerCase(), refName: refParam };
  return null;
}

function contentsGet(req: RestRequest, repo: Repo, path: string): RestResponse {
  const resolved = resolveRef(repo, req.query.get('ref'));
  if (resolved === null) return err(404, 'Not Found');
  const files = repo.filesOf(resolved.tip);
  if (path === '') {
    // Root listing: the top-level entries of the tree.
    const object = repo.getObject(parseCommit(repo.getObject(resolved.tip)!.data).tree);
    if (!object || object.type !== 'tree') return json(200, []);
    const entries = parseTree(object.data).map((entry) => ({
      type: entry.type,
      size: entry.type === 'tree' ? 0 : repo.getObject(entry.oid)?.data.length ?? 0,
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
      url: `/api/v3/repos/${repo.fullName}/contents/${entry.name}`,
      git_url: `/api/v3/repos/${repo.fullName}/git/${entry.type === 'tree' ? 'trees' : 'blobs'}/${entry.oid}`,
      html_url: `https://github.com/${repo.fullName}/tree/${resolved.refName}/${entry.name}`,
      download_url: null,
      _links: { self: `/api/v3/repos/${repo.fullName}/contents/${entry.name}`, git: `/api/v3/repos/${repo.fullName}/git/${entry.type === 'tree' ? 'trees' : 'blobs'}/${entry.oid}`, html: `https://github.com/${repo.fullName}/tree/${resolved.refName}/${entry.name}` },
    }));
    return json(200, entries);
  }
  const file = files.get(path);
  if (file !== undefined) return json(200, contentFileView(repo, path, file.oid, resolved.refName));
  // A directory: any file below this path.
  const prefix = `${path}/`;
  const children = new Map<string, { oid: string; mode: string; isDir: boolean }>();
  for (const [filePath, entry] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) children.set(rest, { oid: entry.oid, mode: entry.mode, isDir: false });
    else children.set(rest.slice(0, slash), { oid: '', mode: '40000', isDir: true });
  }
  if (children.size === 0) return err(404, 'Not Found');
  const entries = [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, child]) => {
    const childPath = `${path}/${name}`;
    if (child.isDir) {
      // The subtree oid: find it in the tree.
      return {
        type: 'dir',
        size: 0,
        name,
        path: childPath,
        sha: dirOid(repo, resolved.tip, childPath) ?? ZERO_OID,
        url: `/api/v3/repos/${repo.fullName}/contents/${childPath}`,
        git_url: `/api/v3/repos/${repo.fullName}/git/trees/${dirOid(repo, resolved.tip, childPath) ?? ZERO_OID}`,
        html_url: `https://github.com/${repo.fullName}/tree/${resolved.refName}/${childPath}`,
        download_url: null,
        _links: { self: `/api/v3/repos/${repo.fullName}/contents/${childPath}`, git: `/api/v3/repos/${repo.fullName}/git/trees/${dirOid(repo, resolved.tip, childPath) ?? ZERO_OID}`, html: `https://github.com/${repo.fullName}/tree/${resolved.refName}/${childPath}` },
      };
    }
    return {
      type: 'file',
      size: repo.getObject(child.oid)?.data.length ?? 0,
      name,
      path: childPath,
      sha: child.oid,
      url: `/api/v3/repos/${repo.fullName}/contents/${childPath}`,
      git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${child.oid}`,
      html_url: `https://github.com/${repo.fullName}/blob/${resolved.refName}/${childPath}`,
      download_url: null,
      _links: { self: `/api/v3/repos/${repo.fullName}/contents/${childPath}`, git: `/api/v3/repos/${repo.fullName}/git/blobs/${child.oid}`, html: `https://github.com/${repo.fullName}/blob/${resolved.refName}/${childPath}` },
    };
  });
  return json(200, entries);
}

/** The tree oid of the directory at `dirPath` in the commit's tree. */
function dirOid(repo: Repo, commitOid: string, dirPath: string): string | null {
  const commit = repo.getObject(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  for (const part of dirPath.split('/')) {
    const tree = repo.getObject(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === part && e.type === 'tree');
    if (!entry) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

// The contents routes are handled by prefix matching in handleRest below,
// because a file path can be any number of segments deep.

function contentsPut(req: RestRequest, params: Record<string, string>, path: string): RestResponse {
  if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const body = bodyOf(req);
  const message = str(body.message);
  const contentB64 = str(body.content);
  if (message === '' || contentB64 === '') return err(422, 'Validation Failed: message and content are required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  } catch {
    return err(422, 'Validation Failed: content is not valid base64');
  }
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined) {
    // A new branch starts at the default branch tip (or an empty repo).
    const base = repo.defaultTip;
    if (base !== undefined) repo.refs.set(ref, base);
    tip = repo.refs.get(ref);
  }
  const files = repo.filesOf(tip);
  const existing = files.get(path);
  const shaParam = typeof body.sha === 'string' ? body.sha.toLowerCase() : null;
  if (existing !== undefined) {
    if (shaParam === null) return err(422, 'Validation Failed: sha is required to update a file');
    if (shaParam !== existing.oid) return err(409, 'Conflict: sha does not match the current file');
    const { commitOid, blobOid } = repo.commitFile(branch, path, content, message);
    return json(200, {
      content: { ...contentFileView(repo, path, blobOid, branch), content: content.toString('base64') },
      commit: { sha: commitOid, node_id: nodeId('Commit', commitOid), message, url: `/api/v3/repos/${repo.fullName}/git/commits/${commitOid}` },
    });
  }
  if (shaParam !== null) return err(422, 'Validation Failed: sha does not match — the file does not exist');
  const { commitOid, blobOid } = repo.commitFile(branch, path, content, message);
  return json(201, {
    content: { ...contentFileView(repo, path, blobOid, branch), content: content.toString('base64') },
    commit: { sha: commitOid, node_id: nodeId('Commit', commitOid), message, url: `/api/v3/repos/${repo.fullName}/git/commits/${commitOid}` },
  });
}

function contentsDelete(req: RestRequest, params: Record<string, string>, path: string): RestResponse {
  if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const body = bodyOf(req);
  const message = str(body.message);
  const shaParam = typeof body.sha === 'string' ? body.sha.toLowerCase() : null;
  if (message === '' || shaParam === null) return err(422, 'Validation Failed: message and sha are required');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const files = repo.filesOf(tip);
  const existing = files.get(path);
  if (existing === undefined) return err(404, 'Not Found');
  if (existing.oid !== shaParam) return err(409, 'Conflict: sha does not match the current file');
  const { commitOid } = repo.deleteFile(branch, path, message);
  return json(200, {
    commit: { sha: commitOid, node_id: nodeId('Commit', commitOid), message, url: `/api/v3/repos/${repo.fullName}/git/commits/${commitOid}` },
  });
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

route('GET', '/api/v3/repos/:owner/:repo/labels', (req, params) => {
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  return paged(req, [...repo.labels.values()].map((l) => labelView(repo, l)));
});

route('POST', '/api/v3/repos/:owner/:repo/labels', (req, params) => {
  if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const body = bodyOf(req);
  const name = str(body.name);
  if (name === '') return err(422, 'Validation Failed: name is required');
  const label = repo.addLabel(name, typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed', typeof body.description === 'string' ? body.description : '');
  return json(201, labelView(repo, label));
});

// ---------------------------------------------------------------------------
// issues and comments
// ---------------------------------------------------------------------------

export function createIssueObject(repo: Repo, body: Record<string, unknown>): Issue | RestResponse {
  const title = str(body.title);
  if (title === '') return err(422, 'Validation Failed: title is required');
  const labels: Label[] = [];
  if (Array.isArray(body.labels)) {
    for (const raw of body.labels) {
      const name = typeof raw === 'string' ? raw : str((raw as Record<string, unknown>)?.name);
      const label = repo.labels.get(name);
      if (!label) return err(422, `Validation Failed: label "${name}" does not exist`);
      labels.push(label);
    }
  }
  const number = repo.numberSeq;
  repo.numberSeq += 1;
  const id = store.nextIssueId();
  const created = repo.nextStamp();
  const issue: Issue = {
    id,
    node_id: nodeId('Issue', `${repo.id}:${number}`),
    number,
    title,
    body: str(body.body),
    state: 'open',
    user: userView(VIEWER_LOGIN, store.userId(VIEWER_LOGIN)!, 'User'),
    labels,
    assignees: [],
    comments: [],
    created_at: created,
    updated_at: created,
    closed_at: null,
    html_url: `https://github.com/${repo.fullName}/issues/${number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${number}`,
  };
  repo.issues.push(issue);
  return issue;
}

route('POST', '/api/v3/repos/:owner/:repo/issues', (req, params) => {
  if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const created = createIssueObject(repo, bodyOf(req));
  if (!('number' in created)) return created as RestResponse;
  return json(201, issueView(repo, created as Issue));
});

route('GET', '/api/v3/repos/:owner/:repo/issues', (req, params) => {
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const state = req.query.get('state') ?? 'open';
  const sort = req.query.get('sort') ?? 'created';
  const direction = req.query.get('direction') ?? 'desc';
  let list = [...repo.issues];
  // Pull requests also appear in the issue list, as on GitHub.
  if (state === 'all') list = [...repo.issues, ...pullsAsIssues(repo)];
  else list = list.filter((i) => i.state === state);
  if (sort === 'created') {
    list.sort((a, b) => (direction === 'asc' ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at)));
  }
  return paged(req, list.map((i) => issueView(repo, i)));
});

function pullsAsIssues(repo: Repo): Issue[] {
  return repo.pulls.map((p) => ({
    id: p.id,
    node_id: p.node_id,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    user: p.user,
    labels: [],
    assignees: [],
    comments: [],
    created_at: p.created_at,
    updated_at: p.updated_at,
    closed_at: p.closed_at,
    html_url: p.html_url,
    url: p.url,
  }));
}

route('GET', '/api/v3/repos/:owner/:repo/issues/:number', (req, params) => {
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const number = Number.parseInt(params.number!, 10);
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) return err(404, 'Not Found');
  return json(200, issueView(repo, issue));
});

route('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', (req, params) => {
  if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const number = Number.parseInt(params.number!, 10);
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) return err(404, 'Not Found');
  const body = bodyOf(req);
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') {
    issue.state = body.state;
    issue.closed_at = body.state === 'closed' ? repo.nextStamp() : null;
  }
  issue.updated_at = repo.nextStamp();
  return json(200, issueView(repo, issue));
});

route('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', (req, params) => {
  if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const number = Number.parseInt(params.number!, 10);
  const issue = repo.issues.find((i) => i.number === number) ?? repo.pulls.find((p) => p.number === number);
  if (!issue) return err(404, 'Not Found');
  const body = bodyOf(req);
  if (str(body.body) === '') return err(422, 'Validation Failed: body is required');
  const id = store.nextCommentId();
  const created = repo.nextStamp();
  const comment = {
    id,
    node_id: nodeId('IssueComment', `${repo.id}:${number}:${id}`),
    body: str(body.body),
    user: userView(VIEWER_LOGIN, store.userId(VIEWER_LOGIN)!, 'User'),
    created_at: created,
    updated_at: created,
    html_url: `https://github.com/${repo.fullName}/issues/${number}#issuecomment-${id}`,
    url: `/api/v3/repos/${repo.fullName}/issues/comments/${id}`,
  };
  if ('comments' in issue) issue.comments.push(comment);
  return json(201, commentView(repo, issue as Issue, comment));
});

route('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', (req, params) => {
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const number = Number.parseInt(params.number!, 10);
  const issue = repo.issues.find((i) => i.number === number) ?? repo.pulls.find((p) => p.number === number);
  if (!issue || !('comments' in issue)) return err(404, 'Not Found');
  return paged(req, issue.comments.map((c) => commentView(repo, issue as Issue, c)));
});

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

route('POST', '/api/v3/repos/:owner/:repo/pulls', (req, params) => {
  if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const body = bodyOf(req);
  const head = str(body.head);
  const base = str(body.base);
  const title = str(body.title);
  if (head === '' || base === '' || title === '') return err(422, 'Validation Failed: head, base and title are required');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined) return err(422, `Validation Failed: head branch "${head}" does not exist`);
  if (baseSha === undefined) return err(422, `Validation Failed: base branch "${base}" does not exist`);
  const number = repo.numberSeq;
  repo.numberSeq += 1;
  const id = store.nextPullId();
  const created = repo.nextStamp();
  const repoView = repo.view();
  const pull: Pull = {
    id,
    node_id: nodeId('PullRequest', `${repo.id}:${number}`),
    number,
    title,
    body: str(body.body),
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
  return json(201, pullView(repo, pull));
});

route('GET', '/api/v3/repos/:owner/:repo/pulls', (req, params) => {
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const state = req.query.get('state') ?? 'open';
  let list = [...repo.pulls];
  if (state !== 'all') list = list.filter((p) => p.state === state);
  list.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return paged(req, list.map((p) => pullView(repo, p)));
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number', (req, params) => {
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const number = Number.parseInt(params.number!, 10);
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) return err(404, 'Not Found');
  return json(200, pullView(repo, pull));
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', (req, params) => {
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const number = Number.parseInt(params.number!, 10);
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) return err(404, 'Not Found');
  return paged(req, repo.diffFiles(pull.base_sha_at_open, pull.head.sha));
});

route('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', (req, params) => {
  if (req.bodyMalformed) return err(400, 'Problems parsing JSON');
  const found = requireRepo(req, params.owner!, params.repo!);
  if (!('view' in found)) return found as RestResponse;
  const repo = found as Repo;
  const number = Number.parseInt(params.number!, 10);
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) return err(404, 'Not Found');
  if (pull.state !== 'open') return err(405, 'Pull request is already closed');
  const baseRef = `refs/heads/${pull.base.ref}`;
  const currentBase = repo.refs.get(baseRef);
  if (currentBase === undefined) return err(422, 'Validation Failed: base branch does not exist');
  const merged = mergeTree(repo, pull.base_sha_at_open, pull.head.sha, pull.base.ref);
  if (merged.conflict || merged.treeOid === null) return err(405, 'Merge conflict');
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
  return json(200, { sha: mergeOid, merged: true, message: 'Pull Request successfully merged' });
});

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

/** Match a method+path against the registered routes. */
function matchRoute(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(path);
    if (m === null) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((key, i) => {
      params[key] = m[i + 1]!;
    });
    return { handler: r.handler, params };
  }
  return null;
}

/**
 * Handle one REST request. Paths under /api/v3 are routed here; auth is
 * decided by the caller (app.ts) except for the API root, which the starter
 * answers without a token.
 */
export function handleRest(req: RestRequest, authorized: boolean): RestResponse {
  const path = req.path.replace(/\/+$/, '') || '/';

  // Contents paths carry an arbitrary-depth file path after /contents/.
  const contentsMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents(?:\/(.*))?$/.exec(path);
  if (contentsMatch !== null) {
    if (!authorized) return err(401, 'Bad credentials');
    const owner = contentsMatch[1]!;
    const name = contentsMatch[2]!;
    const filePath = contentsMatch[3] === undefined ? '' : decodeURIComponent(contentsMatch[3]);
    const found = requireRepo(req, owner, name);
    if (!('view' in found)) return found as RestResponse;
    const repo = found as Repo;
    if (req.method === 'GET') return contentsGet(req, repo, filePath);
    if (req.method === 'PUT') return contentsPut(req, { owner, repo: name }, filePath);
    if (req.method === 'DELETE') return contentsDelete(req, { owner, repo: name }, filePath);
    return err(404, 'Not Found');
  }

  // git/refs paths carry an arbitrary-depth ref after /git/refs/.
  const refMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs\/(.+)$/.exec(path);
  if (refMatch !== null && req.method === 'GET') {
    if (!authorized) return err(401, 'Bad credentials');
    const found = requireRepo(req, refMatch[1]!, refMatch[2]!);
    if (!('view' in found)) return found as RestResponse;
    const repo = found as Repo;
    const ref = `refs/${decodeURIComponent(refMatch[3]!)}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return err(404, 'Not Found');
    return json(200, {
      ref,
      node_id: nodeId('Ref', `${repo.id}:${ref}`),
      url: `/api/v3/repos/${repo.fullName}/git/refs/${ref.replace(/^refs\//, '')}`,
      object: { sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
    });
  }

  const matched = matchRoute(req.method, path);
  if (matched === null) return err(404, 'Not Found');
  // The API root answers without a token, exactly as the starter does.
  if (path !== '/api/v3' && !authorized) return err(401, 'Bad credentials');
  if (req.bodyMalformed && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    // Handlers check this themselves; this is a backstop for routes that do not.
    return err(400, 'Problems parsing JSON');
  }
  return matched.handler(req, matched.params);
}

// store.ts — the forge's in-memory store: users, repositories, issues, pull
// requests, labels and comments, plus the git object database. Every view —
// REST v3, GraphQL v4, MCP and git smart HTTP — reads and writes this one
// store, so an object created through one surface is visible through all of
// them with the same ids.
//
// Determinism: ids are sequential counters, timestamps are fixed to the
// scenario epoch (2025-01-01T00:00:00Z) plus a per-object second offset, so a
// repeated trial produces the same shapes. Nothing here reads the clock.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  parseCommit,
  parseTree,
  treeToMap,
  type GitObject,
  type GitObjectType,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const TEAMMATE_LOGIN = 'quinnkeller';
export const STRANGER_LOGIN = 'olgabauer';
export const ORG_LOGIN = 'faint-meadow-org';
export const FIRST_REPO_NAME = 'amber-thistle';
export const DEFAULT_BRANCH = 'main';

/** A fixed clock: the scenario epoch plus `n` seconds, as an ISO string. */
export function stamp(n: number): string {
  return new Date(Date.UTC(2025, 0, 1, 0, 0, 0) + n * 1000).toISOString();
}

export interface UserView {
  login: string;
  id: number;
  node_id: string;
  type: 'User' | 'Organization';
  avatar_url: string;
  html_url: string;
  url: string;
}

export function nodeId(kind: string, id: number | string): string {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}

export function userView(login: string, id: number, type: 'User' | 'Organization'): UserView {
  return {
    login,
    id,
    node_id: nodeId('User', id),
    type,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    html_url: `https://github.com/${login}`,
    url: `/api/v3/users/${login}`,
  };
}

export interface Label {
  id: number;
  node_id: string;
  name: string;
  color: string;
  description: string;
  url: string;
}

export interface Comment {
  id: number;
  node_id: string;
  body: string;
  user: UserView;
  created_at: string;
  updated_at: string;
  html_url: string;
  url: string;
}

export interface Issue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  user: UserView;
  labels: Label[];
  assignees: UserView[];
  comments: Comment[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  url: string;
}

export interface PullFile {
  sha: string;
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
}

export interface Pull {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: UserView;
  head: { ref: string; sha: string; repo: RepoView | null };
  base: { ref: string; sha: string; repo: RepoView | null };
  base_sha_at_open: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  url: string;
  comments: Comment[];
}

export interface RepoView {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: UserView;
  private: boolean;
  description: string | null;
  homepage: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  html_url: string;
  url: string;
  clone_url: string;
  git_url: string;
  ssh_url: string;
  language: null;
  forks_count: number;
  stargazers_count: number;
  watchers_count: number;
  open_issues_count: number;
  has_issues: boolean;
  has_projects: boolean;
  has_wiki: boolean;
  archived: boolean;
  disabled: boolean;
  visibility: 'public' | 'private';
}

/** One repository: its metadata, its issue tracker, and its git database. */
export class Repo {
  readonly id: number;
  readonly name: string;
  readonly ownerLogin: string;
  readonly ownerId: number;
  readonly ownerType: 'User' | 'Organization';
  private: boolean;
  description: string | null;
  defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  pushedAt: string;
  readonly seq: number;

  /** ref name -> commit oid. */
  refs = new Map<string, string>();
  /** oid -> git object. */
  objects = new Map<string, GitObject>();
  labels = new Map<string, Label>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  /** Shared issue/PR numbering, GitHub style: one counter per repo. */
  numberSeq = 1;
  commentSeq = 1;
  private objectSeq = 1;

  constructor(store: Store, ownerLogin: string, ownerId: number, ownerType: 'User' | 'Organization', name: string, opts: { private?: boolean; description?: string | null; defaultBranch?: string } = {}) {
    this.id = store.nextRepoId();
    this.seq = this.id;
    this.name = name;
    this.ownerLogin = ownerLogin;
    this.ownerId = ownerId;
    this.ownerType = ownerType;
    this.private = opts.private ?? false;
    this.description = opts.description ?? null;
    this.defaultBranch = opts.defaultBranch ?? DEFAULT_BRANCH;
    this.createdAt = stamp(this.id);
    this.updatedAt = this.createdAt;
    this.pushedAt = this.createdAt;
  }

  get fullName(): string {
    return `${this.ownerLogin}/${this.name}`;
  }

  get defaultRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  get defaultTip(): string | undefined {
    return this.refs.get(this.defaultRef);
  }

  view(): RepoView {
    const openCount = this.issues.filter((i) => i.state === 'open').length + this.pulls.filter((p) => p.state === 'open').length;
    return {
      id: this.id,
      node_id: nodeId('Repository', this.id),
      name: this.name,
      full_name: this.fullName,
      owner: userView(this.ownerLogin, this.ownerId, this.ownerType),
      private: this.private,
      description: this.description,
      homepage: null,
      default_branch: this.defaultBranch,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
      pushed_at: this.pushedAt,
      html_url: `https://github.com/${this.fullName}`,
      url: `/api/v3/repos/${this.fullName}`,
      clone_url: `https://github.com/${this.fullName}.git`,
      git_url: `git://github.com/${this.fullName}.git`,
      ssh_url: `git@github.com:${this.fullName}.git`,
      language: null,
      forks_count: 0,
      stargazers_count: 0,
      watchers_count: 0,
      open_issues_count: openCount,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      archived: false,
      disabled: false,
      visibility: this.private ? 'private' : 'public',
    };
  }

  /** Store an object, returning its id (idempotent: same bytes, same id). */
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** All refs sorted by name, HEAD first when present. */
  refList(): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    const tip = this.defaultTip;
    if (tip !== undefined) out.push({ name: 'HEAD', oid: tip });
    for (const name of [...this.refs.keys()].sort()) out.push({ name, oid: this.refs.get(name)! });
    return out;
  }

  /** Branch names, sorted. */
  branches(): string[] {
    const out: string[] = [];
    for (const name of this.refs.keys()) if (name.startsWith('refs/heads/')) out.push(name.slice('refs/heads/'.length));
    return out.sort();
  }

  /** The next deterministic timestamp for a new tracker object. */
  nextStamp(): string {
    this.objectSeq += 1;
    return stamp(this.id * 1000 + this.objectSeq);
  }

  /** Create a label (or return the existing one). */
  addLabel(name: string, color = 'ededed', description = ''): Label {
    const existing = this.labels.get(name);
    if (existing) return existing;
    const label: Label = {
      id: this.id * 10000 + this.labels.size + 1,
      node_id: nodeId('Label', `${this.id}:${name}`),
      name,
      color,
      description,
      url: `/api/v3/repos/${this.fullName}/labels/${encodeURIComponent(name)}`,
    };
    this.labels.set(name, label);
    return label;
  }

  /** Find an issue or pull request by number (shared numbering). */
  findNumbered(number: number): Issue | Pull | undefined {
    return this.issues.find((i) => i.number === number) ?? this.pulls.find((p) => p.number === number);
  }

  /** A commit on `branch` that replaces the file at `path` with `content`. */
  commitFile(branch: string, path: string, content: Buffer, message: string): { commitOid: string; blobOid: string } {
    const ref = `refs/heads/${branch}`;
    const parent = this.refs.get(ref) ?? this.defaultTip;
    let treeOid: string;
    if (parent === undefined) {
      treeOid = this.putObject('tree', Buffer.alloc(0));
    } else {
      treeOid = parseCommit(this.objects.get(parent)!.data).tree;
    }
    const blobOid = this.putObject('blob', content);
    treeOid = this.writePath(treeOid, path.split('/'), blobOid, '100644');
    const commitOid = this.putObject(
      'commit',
      buildCommit({ tree: treeOid, parents: parent === undefined ? [] : [parent], message }),
    );
    this.refs.set(ref, commitOid);
    this.pushedAt = this.nextStamp();
    return { commitOid, blobOid };
  }

  /** Delete the file at `path` on `branch`, committing the result. */
  deleteFile(branch: string, path: string, message: string): { commitOid: string } {
    const ref = `refs/heads/${branch}`;
    const parent = this.refs.get(ref) ?? this.defaultTip;
    if (parent === undefined) throw new Error('cannot delete from an empty repository');
    const treeOid = parseCommit(this.objects.get(parent)!.data).tree;
    const newTree = this.writePath(treeOid, path.split('/'), null, '100644');
    const commitOid = this.putObject('commit', buildCommit({ tree: newTree, parents: [parent], message }));
    this.refs.set(ref, commitOid);
    this.pushedAt = this.nextStamp();
    return { commitOid };
  }

  /**
   * Return a new tree oid with `path` set to `blobOid` (or removed when
   * `blobOid` is null), rebuilding every tree on the way down.
   */
  writePath(treeOid: string, parts: readonly string[], blobOid: string | null, mode: string): string {
    const tree = this.objects.get(treeOid);
    const entries = tree && tree.type === 'tree' ? parseTree(tree.data) : [];
    const [head, ...rest] = parts;
    if (head === undefined) throw new Error('empty path');
    const idx = entries.findIndex((e) => e.name === head);
    if (rest.length === 0) {
      if (blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode, name: head, oid: blobOid, type: 'blob' };
      } else {
        entries.push({ mode, name: head, oid: blobOid, type: 'blob' });
      }
    } else {
      const childOid = idx >= 0 && entries[idx]!.type === 'tree' ? entries[idx]!.oid : this.putObject('tree', Buffer.alloc(0));
      const newChild = this.writePath(childOid, rest, blobOid, mode);
      if (idx >= 0) entries[idx] = { mode: '40000', name: head, oid: newChild, type: 'tree' };
      else entries.push({ mode: '40000', name: head, oid: newChild, type: 'tree' });
    }
    return this.putObject('tree', buildTree(entries));
  }

  /** The file map (path -> blob) of the commit's tree, or of the empty tree. */
  filesOf(commitOid: string | undefined): Map<string, { oid: string; mode: string }> {
    if (commitOid === undefined) return new Map();
    const commit = this.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return new Map();
    return treeToMap((oid) => this.objects.get(oid), parseCommit(commit.data).tree);
  }

  /** The files changed between two commits, with their new contents. */
  diffFiles(baseOid: string | undefined, headOid: string): PullFile[] {
    const base = this.filesOf(baseOid);
    const head = this.filesOf(headOid);
    const out: PullFile[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b?.oid === h?.oid) continue;
      const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
      const additions = h === undefined ? 0 : 1;
      const deletions = b === undefined ? 0 : 1;
      out.push({
        sha: (h ?? b)!.oid,
        filename: path,
        status,
        additions,
        deletions,
        changes: additions + deletions,
        blob_url: `https://github.com/${this.fullName}/blob/${headOid}/${path}`,
        raw_url: `https://github.com/${this.fullName}/raw/${headOid}/${path}`,
        contents_url: `/api/v3/repos/${this.fullName}/contents/${path}`,
      });
    }
    return out;
  }

  /** The set of object ids reachable from all refs (for pack building). */
  reachableFromRefs(): Set<string> {
    return collectReachable((oid) => this.objects.get(oid), this.refs.values());
  }
}

// ---------------------------------------------------------------------------
// the store itself
// ---------------------------------------------------------------------------

/** The whole forge: users, repos, and the counters that keep ids stable. */
export class Store {
  /** login -> user id. The viewer, the teammate, the stranger and the org. */
  readonly users = new Map<string, { id: number; type: 'User' | 'Organization' }>();
  /** "owner/name" -> repo. */
  readonly repos = new Map<string, Repo>();
  private repoIdSeq = 0;
  private userIdSeq = 0;
  private issueIdSeq = 0;
  private pullIdSeq = 0;
  private commentIdSeq = 0;

  constructor() {
    this.addUser(VIEWER_LOGIN, 'User');
    this.addUser(TEAMMATE_LOGIN, 'User');
    this.addUser(STRANGER_LOGIN, 'User');
    this.addUser(ORG_LOGIN, 'Organization');
    this.seedScenario();
  }

  addUser(login: string, type: 'User' | 'Organization'): number {
    const existing = this.users.get(login);
    if (existing) return existing.id;
    const id = (this.userIdSeq += 1) * 1000 + 100;
    this.users.set(login, { id, type });
    return id;
  }

  userId(login: string): number | undefined {
    return this.users.get(login)?.id;
  }

  userType(login: string): 'User' | 'Organization' {
    return this.users.get(login)?.type ?? 'User';
  }

  nextRepoId(): number {
    this.repoIdSeq += 1;
    return this.repoIdSeq;
  }

  nextIssueId(): number {
    this.issueIdSeq += 1;
    return this.issueIdSeq;
  }

  nextPullId(): number {
    this.pullIdSeq += 1;
    return this.pullIdSeq;
  }

  nextCommentId(): number {
    this.commentIdSeq += 1;
    return this.commentIdSeq;
  }

  /** Create a repo (201 semantics live in rest.ts; this is the storage half). */
  createRepo(ownerLogin: string, name: string, opts: { private?: boolean; description?: string | null; defaultBranch?: string } = {}): Repo {
    const ownerId = this.userId(ownerLogin) ?? this.addUser(ownerLogin, 'User');
    const ownerType = this.userType(ownerLogin);
    const repo = new Repo(this, ownerLogin, ownerId, ownerType, name, opts);
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  /** All repos owned by `login`, in creation order. */
  reposOf(login: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.ownerLogin === login);
  }

  /** All repos, in creation order. */
  allRepos(): Repo[] {
    return [...this.repos.values()];
  }

  /**
   * The seeded scenario the wire describes: the viewer `adaiversen`, the
   * teammate `quinnkeller`, the stranger `olgabauer`, the org
   * `faint-meadow-org`, the viewer's first repo `amber-thistle` on `main`
   * with its first blob `config/token.css` and the six standard labels.
   * Seeded at boot so every check sees the same world.
   */
  private seedScenario(): void {
    const repo = this.createRepo(VIEWER_LOGIN, FIRST_REPO_NAME, { description: 'The viewer\u2019s first repository' });
    for (const name of ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']) {
      repo.addLabel(name);
    }
    const blob = Buffer.from(':root {\n  --token-color: #0366d6;\n}\n', 'utf8');
    repo.commitFile(DEFAULT_BRANCH, 'config/token.css', blob, 'Seed config/token.css');
  }
}

/** The one store the server answers from. */
export const store = new Store();

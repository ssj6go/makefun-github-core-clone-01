// mcp.ts — the Model Context Protocol endpoint (POST /mcp), streamable HTTP.
//
// The 2026-07-28 revision is served: `server/discover` answers the server's
// identity, capabilities and supported revisions in one request, and every
// request declares its revision in `_meta`. The 2025-11-25 handshake era is
// also answered (`initialize` + `notifications/initialized`) for a client
// that predates discovery. There is no protocol-level session and no GET
// stream: each POST is answered by one JSON body.
//
// The six tools speak to the same store as REST, GraphQL and git, so an
// object a tool creates is visible through every other view with the same
// ids (the rest-parity checks read them back over REST).

import { VIEWER_LOGIN, store, userView } from './store.ts';
import { createIssueObject } from './rest.ts';
import { createPullObject, mergePullObject } from './graphql.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/**
 * The tool list, fixed at module load so two tools/list calls answer
 * byte-identical arrays. The required properties are exactly the ones the
 * suite can fill from a check's semantic arguments.
 */
export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: unknown; isError?: boolean };

function toolOk(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function argNumber(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Run one tool by name with its arguments. */
function callTool(name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name');
      if (repoName === '') return toolError('create_repo: the required argument "name" is missing');
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return toolError(`create_repo: repository "${repoName}" already exists`);
      const repo = store.createRepo(VIEWER_LOGIN, repoName, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : null,
      });
      const view = repo.view();
      return toolOk({ id: view.id, node_id: view.node_id, name: view.name, full_name: view.full_name, private: view.private, description: view.description, default_branch: view.default_branch, html_url: view.html_url, url: view.url });
    }
    case 'get_repo': {
      const repo = store.getRepo(argString(args, 'owner'), argString(args, 'repo'));
      if (repo === undefined) return toolError('get_repo: repository not found');
      return toolOk(repo.view());
    }
    case 'create_issue': {
      const owner = argString(args, 'owner');
      const repoName = argString(args, 'repo');
      const title = argString(args, 'title');
      if (owner === '' || repoName === '' || title === '') return toolError('create_issue: the required arguments "owner", "repo" and "title" must be provided');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError('create_issue: repository not found');
      const created = createIssueObject(repo, { title, body: argString(args, 'body') });
      if (!('number' in created)) return toolError('create_issue: could not create the issue');
      const issue = created;
      return toolOk({ id: issue.id, node_id: issue.node_id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, html_url: issue.html_url, url: issue.url });
    }
    case 'list_issues': {
      const owner = argString(args, 'owner');
      const repoName = argString(args, 'repo');
      if (owner === '' || repoName === '') return toolError('list_issues: the required arguments "owner" and "repo" must be provided');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError('list_issues: repository not found');
      const state = argString(args, 'state') || 'open';
      const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      return toolOk({
        issues: list.map((i) => ({ id: i.id, node_id: i.node_id, number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels.map((l) => l.name), html_url: i.html_url, url: i.url })),
        total_count: list.length,
      });
    }
    case 'create_pull_request': {
      const owner = argString(args, 'owner');
      const repoName = argString(args, 'repo');
      const title = argString(args, 'title');
      const head = argString(args, 'head');
      const base = argString(args, 'base');
      if (owner === '' || repoName === '' || title === '' || head === '' || base === '') {
        return toolError('create_pull_request: the required arguments "owner", "repo", "title", "head" and "base" must be provided');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError('create_pull_request: repository not found');
      const pull = createPullObject(repo, head, base, title, argString(args, 'body'));
      if (pull === null) return toolError('create_pull_request: the head or base branch does not exist');
      return toolOk({ id: pull.id, node_id: pull.node_id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: { ref: pull.head.ref, sha: pull.head.sha }, base: { ref: pull.base.ref, sha: pull.base.sha }, html_url: pull.html_url, url: pull.url });
    }
    case 'merge_pull_request': {
      const owner = argString(args, 'owner');
      const repoName = argString(args, 'repo');
      const number = argNumber(args, 'pull_number');
      if (owner === '' || repoName === '' || number === null) return toolError('merge_pull_request: the required arguments "owner", "repo" and "pull_number" must be provided');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError('merge_pull_request: repository not found');
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return toolError('merge_pull_request: pull request not found');
      if (!mergePullObject(repo, pull)) return toolError('merge_pull_request: the pull request cannot be merged (conflict or already closed)');
      return toolOk({ number: pull.number, id: pull.node_id, merged: true, state: 'closed', merge_commit_sha: pull.merge_commit_sha, html_url: pull.html_url, url: pull.url });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function serverInfo(): Record<string, unknown> {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

/**
 * Handle one POST /mcp request. `rawBody` is the exact request bytes;
 * `authorized` is the bearer check app.ts already made. Returns the HTTP
 * status and the exact body text to send.
 */
export function handleMcp(rawBody: Buffer, authorized: boolean): { status: number; body: string } {
  let request: RpcRequest;
  try {
    request = JSON.parse(rawBody.toString('utf8')) as RpcRequest;
  } catch {
    return { status: 400, body: JSON.stringify(rpcError(null, -32700, 'Parse error')) };
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 400, body: JSON.stringify(rpcError(null, -32700, 'Parse error')) };
  }
  const id = request.id === undefined ? null : request.id;
  const isNotification = request.id === undefined;

  if (!authorized) {
    if (isNotification) return { status: 202, body: '' };
    return { status: 401, body: JSON.stringify(rpcError(id, -32001, 'Unauthorized')) };
  }

  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params) ? (request.params as Record<string, unknown>) : {};

  // Notifications carry no id and get no JSON-RPC answer.
  if (isNotification) {
    return { status: 202, body: '' };
  }

  if (method === 'server/discover') {
    const result = {
      resultType: 'discover',
      supportedVersions: [MCP_REVISION],
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible forge: repositories, issues, pull requests and git over one store.',
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    };
    return { status: 200, body: JSON.stringify(rpcResult(id, result)) };
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = MCP_LEGACY_REVISIONS.includes(offered) ? offered : MCP_REVISION;
    if (offered !== '' && !MCP_LEGACY_REVISIONS.includes(offered) && offered !== MCP_REVISION) {
      return { status: 200, body: JSON.stringify(rpcError(id, -32602, `Unsupported protocol version: ${offered}`)) };
    }
    return {
      status: 200,
      body: JSON.stringify(rpcResult(id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: serverInfo() })),
    };
  }

  if (method === 'ping') {
    return { status: 200, body: JSON.stringify(rpcResult(id, {})) };
  }

  if (method === 'tools/list') {
    return { status: 200, body: JSON.stringify(rpcResult(id, { tools: MCP_TOOLS })) };
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    if (name === '') {
      return { status: 200, body: JSON.stringify(rpcError(id, -32602, 'Invalid params: a tool name is required')) };
    }
    if (!MCP_TOOLS.some((tool) => tool.name === name)) {
      return { status: 200, body: JSON.stringify(rpcError(id, -32601, `Method not found: ${name}`)) };
    }
    const result = callTool(name, args);
    return { status: 200, body: JSON.stringify(rpcResult(id, result)) };
  }

  return { status: 200, body: JSON.stringify(rpcError(id, -32601, `Method not found: ${method}`)) };
}

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/ssj6go/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/ssj6go/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# github-core-clone-01 — a GitHub-compatible forge

A single-process server (TypeScript, Node 22, stdlib only, no dependencies, no
install step) that re-implements the core of GitHub from its own store:

- **git smart HTTP** — `info/refs`, `git-upload-pack` (protocol v2 and v0,
  shallow fetch and deepen, thin packs) and `git-receive-pack` (v0,
  fast-forward rules, per-ref `ok`/`ng` report). The packfile, pkt-line and
  delta codecs are implemented in-process with `node:zlib` + `node:crypto`;
  there is no git binary in the runtime.
- **REST v3** (`/api/v3/...`) — repositories, branches, commits, contents,
  issues, comments, labels, pull requests, files and merges, with GitHub
  status codes, JSON bodies, pagination `Link` headers and bearer auth.
- **GraphQL v4** (`POST /api/graphql`) — the documents `gh` and
  `github-mcp-server` send: `viewer`, `repository`, `issue`, `issues`,
  `pullRequests`, `node`, `__type`, plus the `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest` and `addComment` mutations.
  Batched operation arrays are answered in order.
- **MCP** (`POST /mcp`) — the 2026-07-28 revision (`server/discover`) with a
  legacy `initialize` fallback, and six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`)
  whose effects are visible through the REST view with the same ids.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http`, `node:crypto`, `node:zlib` and its own modules only, and the
trial has no package manager and no internet.

## The lifecycle (main.ts)

The entry binds an ephemeral port, registers it with the harness
(`POST $MAKEFUN_ENV_URL/register`), then polls `GET $MAKEFUN_ENV_URL/done`
until the trial ends and exits 0. The process stays alive for the whole
trial: this is a server, not a script that finishes.

## Layout

- `main.ts` — entrypoint: the entry <-> env lifecycle.
- `app.ts` — the HTTP server, routing, auth and the git smart-HTTP handlers.
- `store.ts` — the in-memory store: repos, issues, pull requests, labels,
  comments and the git object database, kept consistent across every view.
- `git.ts` — pkt-lines, SHA-1 object ids, packfile read/write, delta
  application, tree and commit codecs.
- `rest.ts` — the GitHub REST v3 resources.
- `graphql.ts` — the GraphQL v4 executor.
- `mcp.ts` — the MCP endpoint and its tools.

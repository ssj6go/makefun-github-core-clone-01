// app.ts — the HTTP server: routing, auth, body parsing, and the git smart
// HTTP handlers (info/refs, git-upload-pack, git-receive-pack). The REST,
// GraphQL and MCP surfaces live in their own modules; this file is the
// transport that ties them to one store.
//
// Auth: every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
// (the same token is in the environment). /healthz is the boot probe and
// takes none; the API root answers without one, exactly as the starter did.
// When MAKEFUN_SHOP_TOKEN is unset (local development only) any non-empty
// bearer token is accepted.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  parseCommit,
  parseTag,
  pktDelim,
  pktFlush,
  readPack,
  writePack,
  type GitObject,
} from './git.ts';
import { store, type Repo } from './store.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest, type RestResponse } from './rest.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';
const AGENT = 'github-core-clone/1.0';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function isAuthorized(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length);
  if (token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

/** Read the whole request body as bytes. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    ...extra,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': requestId(), ...extra });
    res.end();
    return;
  }
  sendBuffer(res, status, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), JSON_TYPE, extra);
}

function sendRest(res: ServerResponse, result: RestResponse): void {
  sendJson(res, result.status, result.body, result.headers);
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

function gitRepo(owner: string, name: string): Repo | null {
  return store.getRepo(decodeURIComponent(owner), decodeURIComponent(name)) ?? null;
}

/** The v0 capability list for upload-pack, with the HEAD symref. */
function uploadPackCapsV0(repo: Repo): string {
  return [
    'multi_ack',
    'thin-pack',
    'side-band',
    'side-band-64k',
    'ofs-delta',
    `agent=${AGENT}`,
    'shallow',
    'no-progress',
    'include-tag',
    'object-format=sha1',
    'fetch',
    'ls-refs',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
  ].join(' ');
}

function receivePackCapsV0(): string {
  return ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`].join(' ');
}

/** Ref lines for a v0 advertisement, first line carrying `caps` after NUL. */
function v0RefLines(repo: Repo, caps: string): Buffer {
  const parts: Buffer[] = [];
  const refs = repo.refList();
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(encodePktLine(line));
      const object = repo.getObject(ref.oid);
      if (object?.type === 'tag') {
        parts.push(encodePktLine(`${parseTag(object.data).object} ${ref.name}^{}\n`));
      }
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow\n'),
    encodePktLine('server-option\n'),
    encodePktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, name: string, service: string): void {
  const repo = gitRepo(owner, name);
  if (repo === null) {
    sendBuffer(res, 404, Buffer.from('Not Found\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendBuffer(res, 404, Buffer.from('Not Found\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const contentType = `application/x-${service}-advertisement`;
  const serviceLine = encodePktLine(`# service=${service}\n`);
  if (service === 'git-receive-pack') {
    sendBuffer(res, 200, Buffer.concat([serviceLine, pktFlush(), v0RefLines(repo, receivePackCapsV0())]), contentType);
    return;
  }
  if ((req.headers['git-protocol'] ?? '') === 'version=2') {
    sendBuffer(res, 200, Buffer.concat([serviceLine, pktFlush(), v2Advertisement()]), contentType);
    return;
  }
  sendBuffer(res, 200, Buffer.concat([serviceLine, pktFlush(), v0RefLines(repo, uploadPackCapsV0(repo))]), contentType);
}

/** Sideband-wrap `data` into pkt-lines of band `band` (1 = pack, 2 = progress). */
function sideband(data: Buffer, band: number): Buffer {
  const parts: Buffer[] = [];
  const maxChunk = 65515;
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxChunk));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

interface FetchPlan {
  /** Objects to send, in pack order. */
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

/**
 * Plan a fetch: which objects the client still needs, which commits become
 * the new shallow boundary, and the acknowledgement lines. `depth` is null
 * for a full fetch.
 */
function planFetch(repo: Repo, wants: string[], haves: string[], prevShallow: string[], depth: number | null): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.getObject(oid);
  // Generation (distance from the nearest want) of every reachable commit.
  const generation = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = wants.map((oid) => ({ oid, depth: 0 }));
  while (queue.length > 0) {
    const { oid, depth: gen } = queue.shift()!;
    if (generation.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    generation.set(oid, gen);
    if (depth !== null && gen + 1 >= depth) continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: gen + 1 });
  }
  const haveObjects = collectReachable(lookup, haves);
  const sendCommits = [...generation.keys()].filter((oid) => !haveObjects.has(oid));
  const sendObjects = collectReachable(lookup, sendCommits);
  const objects: GitObject[] = [];
  for (const oid of sendObjects) {
    if (haveObjects.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  objects.sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of sendCommits) {
      const gen = generation.get(oid)!;
      if (gen !== depth - 1) continue;
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const hasParentBeyond = parents.some((p) => lookup(p) !== undefined && !sendCommits.includes(p) && !haveObjects.has(p));
      if (parents.length > 0 && hasParentBeyond) shallow.push(oid);
    }
  }
  for (const prev of prevShallow) {
    if (!sendCommits.includes(prev)) continue;
    const object = lookup(prev);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    const resolved = parents.every((p) => lookup(p) === undefined || sendCommits.includes(p) || haveObjects.has(p));
    if (resolved) unshallow.push(prev);
  }

  const presentHaves = haves.filter((oid) => lookup(oid) !== undefined);
  return { objects, shallow, unshallow, acks: presentHaves, nak: presentHaves.length === 0 };
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = gitRepo(owner, name);
  if (repo === null) {
    sendBuffer(res, 404, Buffer.from('Not Found\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const contentType = 'application/x-git-upload-pack-result';
  const packets = decodePktLines(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));

  if ((req.headers['git-protocol'] ?? '') === 'version=2') {
    handleUploadPackV2(res, repo, lines, contentType);
    return;
  }
  handleUploadPackV0(res, repo, lines, contentType);
}

/** The ls-refs answer for protocol v2. */
function lsRefsV2(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const tip = repo.defaultTip;
  if (tip === undefined) {
    if (unborn && keep('HEAD')) {
      parts.push(encodePktLine(`unborn refs/heads/${repo.defaultBranch} symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    if (keep('HEAD')) {
      const attrs = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(encodePktLine(`${tip} HEAD${attrs}\n`));
    }
    for (const ref of repo.refList()) {
      if (ref.name === 'HEAD') continue;
      if (!keep(ref.name)) continue;
      const object = repo.getObject(ref.oid);
      let attrs = '';
      if (peel && object?.type === 'tag') attrs += ` peeled:${parseTag(object.data).object}`;
      parts.push(encodePktLine(`${ref.oid} ${ref.name}${attrs}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleUploadPackV2(res: ServerResponse, repo: Repo, lines: string[], contentType: string): void {
  const command = (lines[0] ?? '').trim();
  if (command === 'command=ls-refs') {
    sendBuffer(res, 200, lsRefsV2(repo, lines.slice(1)), contentType);
    return;
  }
  if (command !== 'command=fetch') {
    sendBuffer(res, 400, Buffer.from('unknown command\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines.slice(1)) {
    const text = line.trim();
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10);
  }
  if (wants.length === 0) {
    sendBuffer(res, 200, encodePktLines(['acknowledgments\n', 'NAK\n', 'delim', 'flush']), contentType);
    return;
  }
  const missing = wants.filter((oid) => repo.getObject(oid) === undefined);
  if (missing.length > 0) {
    const parts = [encodePktLine('acknowledgments\n'), encodePktLine('NAK\n'), pktDelim(), encodePktLine('packfile\n'), sideband(Buffer.from(`ERR object not found: ${missing[0]}\n`, 'utf8'), 3), pktFlush()];
    sendBuffer(res, 200, Buffer.concat(parts), contentType);
    return;
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [encodePktLine('acknowledgments\n')];
  if (plan.nak) parts.push(encodePktLine('NAK\n'));
  else {
    for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    parts.push(encodePktLine('ready\n'));
  }
  parts.push(pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (plan.objects.length > 0) {
    parts.push(encodePktLine('packfile\n'));
    parts.push(sideband(writePack(plan.objects), 1));
  }
  parts.push(pktFlush());
  sendBuffer(res, 200, Buffer.concat(parts), contentType);
}

function handleUploadPackV0(res: ServerResponse, repo: Repo, lines: string[], contentType: string): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]!);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10);
  }
  if (wants.length === 0) {
    sendBuffer(res, 200, encodePktLines(['NAK\n', 'flush']), contentType);
    return;
  }
  const missing = wants.filter((oid) => repo.getObject(oid) === undefined);
  if (missing.length > 0) {
    const parts = [encodePktLine('NAK\n'), sideband(Buffer.from(`ERR object not found: ${missing[0]}\n`, 'utf8'), 3), pktFlush()];
    sendBuffer(res, 200, Buffer.concat(parts), contentType);
    return;
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  if (plan.nak) parts.push(encodePktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) parts.push(sideband(writePack(plan.objects), 1));
  parts.push(pktFlush());
  sendBuffer(res, 200, Buffer.concat(parts), contentType);
}

function handleReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = gitRepo(owner, name);
  if (repo === null) {
    sendBuffer(res, 404, Buffer.from('Not Found\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const contentType = 'application/x-git-receive-pack-result';
  // The command list is pkt-lines up to the first flush; the rest is the pack.
  let offset = 0;
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packStart = body.length;
  while (offset + 4 <= body.length) {
    const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0 || len > 65520) break;
    if (len === 0) {
      packStart = offset + 4;
      break;
    }
    if (len === 1) {
      offset += 4;
      continue;
    }
    const payload = body.subarray(offset + 4, offset + len).toString('utf8');
    const nul = payload.indexOf('\0');
    const command = (nul >= 0 ? payload.slice(0, nul) : payload).trim();
    const parts = command.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    offset += len;
  }
  const packBytes = body.subarray(packStart);
  const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.getObject(oid));
      for (const [oid, object] of objects) repo.objects.set(oid, object);
    } catch (err) {
      unpackOk = false;
      for (const command of commands) report.push({ ref: command.ref, ok: false, reason: `unpack error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          report.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          report.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
        } else {
          repo.refs.delete(command.ref);
          report.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      const newObject = repo.getObject(command.newOid);
      if (!newObject || newObject.type !== 'commit') {
        report.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          report.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        report.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (command.oldOid !== current) {
        report.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      // Fast-forward: the old tip must be an ancestor of the new commit.
      const reachable = collectReachable((oid) => repo.getObject(oid), [command.newOid]);
      if (!reachable.has(current)) {
        report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push({ ref: command.ref, ok: true, reason: '' });
    }
    repo.pushedAt = new Date(Date.UTC(2025, 0, 1, 0, 0, 0) + repo.id * 1000).toISOString();
  }
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
  for (const entry of report) {
    reportLines.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
  }
  const framed = encodePktLines(reportLines);
  sendBuffer(res, 200, Buffer.concat([sideband(framed, 1), pktFlush()]), contentType);
}

// ---------------------------------------------------------------------------
// server and routing
// ---------------------------------------------------------------------------

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      try {
        // The env's boot check calls this twice: 200 {"ok":true}, no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const authorized = isAuthorized(req);

        // Git smart HTTP: /<owner>/<repo>.git/info/refs, git-upload-pack, git-receive-pack.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          if (!authorized) {
            sendBuffer(res, 401, Buffer.from('Unauthorized\n', 'utf8'), 'text/plain; charset=utf-8');
            return;
          }
          const owner = gitMatch[1]!;
          const name = gitMatch[2]!;
          const action = gitMatch[3]!;
          if (method === 'GET' && action === 'info/refs') {
            handleInfoRefs(req, res, owner, name, queryOf(req).get('service') ?? '');
            return;
          }
          if (method === 'POST' && (action === 'git-upload-pack' || action === 'git-receive-pack')) {
            const body = await readBody(req);
            if (action === 'git-upload-pack') handleUploadPack(req, res, owner, name, body);
            else handleReceivePack(req, res, owner, name, body);
            return;
          }
          sendBuffer(res, 404, Buffer.from('Not Found\n', 'utf8'), 'text/plain; charset=utf-8');
          return;
        }

        // GraphQL v4.
        if (method === 'POST' && path === '/api/graphql') {
          if (!authorized) {
            sendJson(res, 401, { errors: [{ message: 'Bad credentials' }] });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown = null;
          let malformed = false;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            malformed = true;
          }
          const result = handleGraphQL(parsed, malformed);
          sendJson(res, result.status, result.body);
          return;
        }

        // MCP over streamable HTTP.
        if (method === 'POST' && path === '/mcp') {
          const raw = await readBody(req);
          const result = handleMcp(raw, authorized);
          if (result.body === '') {
            res.writeHead(result.status, { 'x-github-request-id': requestId() });
            res.end();
            return;
          }
          sendBuffer(res, result.status, Buffer.from(result.body, 'utf8'), JSON_TYPE);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const raw = await readBody(req);
          let parsed: unknown;
          let malformed = false;
          if (raw.length === 0) {
            parsed = undefined;
          } else {
            try {
              parsed = JSON.parse(raw.toString('utf8'));
            } catch {
              malformed = true;
            }
          }
          const restReq: RestRequest = {
            method,
            path,
            query: queryOf(req),
            body: parsed,
            bodyMalformed: malformed,
            headers: req.headers as Record<string, string | undefined>,
            origin: originOf(req),
          };
          sendRest(res, handleRest(restReq, authorized));
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
}

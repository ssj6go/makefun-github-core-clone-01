// git.ts — the git object layer, implemented from the wire up: SHA-1 object ids,
// pkt-line framing, packfile read/write (plain objects plus OFS/REF deltas),
// tree and commit codecs, and reachability walks. No git binary is involved:
// the trial runtime has none, and node:zlib + node:crypto are the only tools.
//
// A note on inflate: a pack entry is a zlib stream whose length is not stored
// anywhere, so the reader must know exactly where each stream ends. Node's
// zlib.inflateSync does not report the consumed byte count, so this file
// carries its own small DEFLATE decoder (RFC 1951) that returns the offset
// just past the stream. Pack *writing* uses zlib.deflateSync, which needs no
// such bookkeeping.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** The SHA-1 id of an object: sha1("<type> <size>\0<bytes>"). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Build one object and its id together. */
export function makeObject(type: GitObjectType, data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, data), object: { type, data } };
}

// ---------------------------------------------------------------------------
// pkt-line framing (git's length-prefixed lines; 0000 = flush, 0001 = delim)
// ---------------------------------------------------------------------------

export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a mixed list of lines, 'flush' and 'delim' markers into one stream. */
export function encodePktLines(lines: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

export interface GitPacket {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode a whole pkt-line stream. Throws on a truncated or malformed frame. */
export function decodePktLines(buf: Buffer): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('pkt-line stream is truncated');
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0 || len > 65520) throw new Error(`bad pkt-line length ${buf.subarray(offset, offset + 4).toString('ascii')}`);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + len > buf.length) throw new Error('pkt-line stream is truncated');
      packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return packets;
}

/** Split a decoded stream into its data lines as text (flush/delim dropped). */
export function pktLinesToText(packets: readonly GitPacket[]): string[] {
  return packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
}

// ---------------------------------------------------------------------------
// DEFLATE (RFC 1951) — a small decoder that reports where the stream ends
// ---------------------------------------------------------------------------

class BitReader {
  private readonly buf: Buffer;
  private pos: number;
  private bit = 0;

  constructor(buf: Buffer, start: number) {
    this.buf = buf;
    this.pos = start;
  }

  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      if (this.pos >= this.buf.length) throw new Error('deflate stream is truncated');
      const byte = this.buf[this.pos]!;
      value |= ((byte >> this.bit) & 1) << i;
      this.bit += 1;
      if (this.bit === 8) {
        this.bit = 0;
        this.pos += 1;
      }
    }
    return value;
  }

  alignByte(): void {
    if (this.bit !== 0) {
      this.bit = 0;
      this.pos += 1;
    }
  }

  get bytePos(): number {
    return this.pos;
  }

  copyBytes(count: number): Buffer {
    this.alignByte();
    if (this.pos + count > this.buf.length) throw new Error('deflate stream is truncated');
    const out = this.buf.subarray(this.pos, this.pos + count);
    this.pos += count;
    return out;
  }
}

/** Canonical Huffman codes from a list of code lengths (RFC 1951 §3.2.2). */
class Huffman {
  /** Per length: a map from code value to symbol. */
  private readonly byLength: Array<Map<number, number>> = [];

  constructor(lengths: readonly number[]) {
    const maxBits = Math.max(0, ...lengths);
    const blCount = new Array<number>(maxBits + 1).fill(0);
    for (const len of lengths) if (len > 0) blCount[len]! += 1;
    const nextCode = new Array<number>(maxBits + 1).fill(0);
    let code = 0;
    for (let bits = 1; bits <= maxBits; bits += 1) {
      code = (code + blCount[bits - 1]!) << 1;
      nextCode[bits] = code;
    }
    for (let symbol = 0; symbol < lengths.length; symbol += 1) {
      const len = lengths[symbol]!;
      if (len === 0) continue;
      const value = nextCode[len]!;
      nextCode[len] = value + 1;
      if (!this.byLength[len]) this.byLength[len] = new Map();
      this.byLength[len]!.set(value, symbol);
    }
  }

  decode(reader: BitReader): number {
    let code = 0;
    for (let len = 1; len < this.byLength.length; len += 1) {
      code = (code << 1) | reader.readBits(1);
      const table = this.byLength[len];
      if (table !== undefined) {
        const symbol = table.get(code);
        if (symbol !== undefined) return symbol;
      }
    }
    throw new Error('deflate stream has an invalid Huffman code');
  }
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function fixedTables(): { lit: Huffman; dist: Huffman } {
  const litLengths = new Array<number>(288).fill(0);
  for (let i = 0; i < 144; i += 1) litLengths[i] = 8;
  for (let i = 144; i < 256; i += 1) litLengths[i] = 9;
  for (let i = 256; i < 280; i += 1) litLengths[i] = 7;
  for (let i = 280; i < 288; i += 1) litLengths[i] = 8;
  return { lit: new Huffman(litLengths), dist: new Huffman(new Array<number>(30).fill(5)) };
}

function dynamicTables(reader: BitReader): { lit: Huffman; dist: Huffman } {
  const hlit = reader.readBits(5) + 257;
  const hdist = reader.readBits(5) + 1;
  const hclen = reader.readBits(4) + 4;
  const clenLengths = new Array<number>(19).fill(0);
  for (let i = 0; i < hclen; i += 1) clenLengths[CLEN_ORDER[i]!] = reader.readBits(3);
  const clen = new Huffman(clenLengths);
  const lengths = new Array<number>(hlit + hdist).fill(0);
  let i = 0;
  while (i < hlit + hdist) {
    const symbol = clen.decode(reader);
    if (symbol <= 15) {
      lengths[i] = symbol;
      i += 1;
    } else if (symbol === 16) {
      if (i === 0) throw new Error('deflate repeat with no previous length');
      const repeat = reader.readBits(2) + 3;
      for (let j = 0; j < repeat; j += 1) lengths[i + j] = lengths[i - 1]!;
      i += repeat;
    } else if (symbol === 17) {
      i += reader.readBits(3) + 3;
    } else if (symbol === 18) {
      i += reader.readBits(7) + 11;
    } else {
      throw new Error(`deflate code-length symbol ${symbol} is invalid`);
    }
  }
  return { lit: new Huffman(lengths.slice(0, hlit)), dist: new Huffman(lengths.slice(hlit)) };
}

/** Inflate one raw DEFLATE stream starting at `offset`; returns the bytes and the next offset. */
export function inflateRaw(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const reader = new BitReader(buf, offset);
  const out: number[] = [];
  for (;;) {
    const bfinal = reader.readBits(1);
    const btype = reader.readBits(2);
    if (btype === 0) {
      reader.alignByte();
      const len = reader.copyBytes(2).readUInt16LE(0);
      reader.copyBytes(2); // NLEN, ignored
      const chunk = reader.copyBytes(len);
      for (const byte of chunk) out.push(byte);
    } else {
      const tables = btype === 1 ? fixedTables() : btype === 2 ? dynamicTables(reader) : null;
      if (tables === null) throw new Error('deflate stream has a reserved block type');
      for (;;) {
        const symbol = tables.lit.decode(reader);
        if (symbol === 256) break;
        if (symbol < 256) {
          out.push(symbol);
        } else {
          const li = symbol - 257;
          if (li >= LENGTH_BASE.length) throw new Error('deflate length symbol is out of range');
          const length = LENGTH_BASE[li]! + reader.readBits(LENGTH_EXTRA[li]!);
          const dsymbol = tables.dist.decode(reader);
          if (dsymbol >= DIST_BASE.length) throw new Error('deflate distance symbol is out of range');
          const distance = DIST_BASE[dsymbol]! + reader.readBits(DIST_EXTRA[dsymbol]!);
          if (distance > out.length) throw new Error('deflate distance goes before the start');
          for (let j = 0; j < length; j += 1) out.push(out[out.length - distance]!);
        }
      }
    }
    if (bfinal === 1) break;
  }
  reader.alignByte();
  return { data: Buffer.from(out), next: reader.bytePos };
}

/** Inflate one zlib stream starting at `offset`; returns the bytes and the offset past the Adler-32. */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  if (offset + 2 > buf.length) throw new Error('zlib stream is truncated');
  const cmf = buf[offset]!;
  const flg = buf[offset + 1]!;
  if ((cmf & 0x0f) !== 8) throw new Error('zlib stream is not deflate');
  if (((cmf << 8) + flg) % 31 !== 0) throw new Error('zlib header checksum failed');
  if ((flg & 0x20) !== 0) throw new Error('zlib stream needs a preset dictionary');
  const raw = inflateRaw(buf, offset + 2);
  if (raw.next + 4 > buf.length) throw new Error('zlib stream is truncated');
  return { data: raw.data, next: raw.next + 4 };
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const PACK_TYPE_NAMES: Array<GitObjectType | null> = [null, 'commit', 'tree', 'blob', 'tag', null, 'ofs-delta', 'ref-delta'];
const PACK_TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta varint is truncated');
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset += delta[offset]! * 2 ** (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize += delta[offset]! * 2 ** (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta insert is truncated');
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/** Read a packfile and resolve every object, including OFS/REF deltas. */
export function readPack(buf: Buffer, resolveBase?: ObjectLookup): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const expected = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  const actual = buf.subarray(trailerStart).toString('hex');
  if (expected !== actual) throw new Error('pack trailer checksum does not match its bytes');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const entries: RawEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = buf[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: the base offset is encoded as a backwards distance.
      byte = buf[offset]!;
      offset += 1;
      let value = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[offset]!;
        offset += 1;
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(buf, offset);
    offset = inflated.next;
    entries.push({ offset: entryOffset, typeCode, size, data: inflated.data, baseOffset, baseOid });
    if (inflated.data.length !== size) throw new Error(`pack entry at ${entryOffset} inflated to ${inflated.data.length} bytes, expected ${size}`);
  }

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, RawEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      const type = PACK_TYPE_NAMES[entry.typeCode] as GitObjectType;
      const object: GitObject = { type, data: entry.data };
      objects.set(hashObject(type, entry.data), object);
      return object;
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let base: GitObject | undefined;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      base = resolve(baseEntry);
    } else if (entry.typeCode === 7) {
      for (const other of entries) {
        if (other.typeCode >= 1 && other.typeCode <= 4) {
          const type = PACK_TYPE_NAMES[other.typeCode] as GitObjectType;
          if (hashObject(type, other.data) === entry.baseOid) {
            base = { type, data: other.data };
            break;
          }
        }
      }
      if (!base && resolveBase) base = resolveBase(entry.baseOid!);
      if (!base) throw new Error(`ref-delta base ${entry.baseOid} is neither in the pack nor supplied`);
    } else {
      throw new Error(`pack entry type ${entry.typeCode} is invalid`);
    }
    resolving.delete(entry.offset);
    const data = applyDelta(base.data, entry.data);
    const object: GitObject = { type: base.type, data };
    objects.set(hashObject(base.type, data), object);
    return object;
  };
  for (const entry of entries) resolve(entry);
  return objects;
}

/** Build a packfile (version 2, plain objects, no deltas) from a list of objects. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    const typeCode = PACK_TYPE_CODES[object.type];
    const size = object.data.length;
    const headerBytes: number[] = [];
    let byte = (typeCode << 4) | (size & 0x0f);
    let remaining = size >> 4;
    while (remaining > 0) {
      headerBytes.push(byte | 0x80);
      byte = remaining & 0x7f;
      remaining >>= 7;
    }
    headerBytes.push(byte);
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// trees and commits
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
  type: 'blob' | 'tree';
}

/** Parse a tree object's entries (mode SP name NUL 20-byte oid). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid, type: mode === '40000' ? 'tree' : 'blob' });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object's bytes from entries (sorted git order: dirs sort as if named with '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.type === 'tree' ? `${a.name}/` : a.name;
    const bn = b.type === 'tree' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's header lines and message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** The forge's deterministic identity for commits it creates (no clock reads). */
export const FORGE_IDENT = 'github-core-clone <forge@localhost> 1735689600 +0000';

/** Build a commit object's bytes. */
export function buildCommit(fields: { tree: string; parents: readonly string[]; message: string; author?: string; committer?: string }): Buffer {
  const author = fields.author ?? FORGE_IDENT;
  const committer = fields.committer ?? FORGE_IDENT;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse a tag object's target. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  const object = /^object ([0-9a-f]{40})$/m.exec(text)?.[1] ?? '';
  const type = /^type (\w+)$/m.exec(text)?.[1] ?? '';
  const tag = /^tag (.*)$/m.exec(text)?.[1] ?? '';
  return { object, type, tag };
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

/**
 * All object ids reachable from `tips` (commits, their trees and blobs, tags
 * and their targets), following only objects present in `lookup`. When
 * `stopAt` names commits, their parents are not followed: the caller has
 * those commits but not their history (a shallow boundary).
 */
export function collectReachable(lookup: ObjectLookup, tips: Iterable<string>, stopAt: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      queue.push(view.tree);
      if (!stopAt.has(oid)) for (const parent of view.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Flatten a tree into path -> {oid, mode}, recursing into subtrees. */
export function treeToMap(lookup: ObjectLookup, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.type === 'tree') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

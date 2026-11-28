// Test helpers: generate a dissector, build pcaps, run tshark with and without it, and read fields (with their byte
// ranges) out of PDML, to compare with Wireshark's own dissectors.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import compiler from 'kaitai-struct-compiler';
import { generateDissector, type Ksy } from '../src/index.ts';

export const FIXTURES = join(import.meta.dirname, 'fixtures');
const FORMATS = process.env.KSF_DIR ?? join(import.meta.dirname, '../../../../kaitai_struct_formats');
const SPEC_DIRS = [FIXTURES, FORMATS, join(FORMATS, 'network')];

// tshark won't load Lua plugins as root, so as root it runs as the user `ws`.
const asUser = process.getuid?.() === 0 ? 'ws' : undefined;
const has = (cmd: string, arg: string) => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;

// CI sets KAITAI_WIRESHARK_REQUIRE, so a broken environment fails instead of skipping everything
function unless(ok: boolean, why: string): string | undefined {
  if (!ok && process.env.KAITAI_WIRESHARK_REQUIRE) throw new Error(why);
  return ok ? undefined : why;
}

/** Why tshark can't run here, or undefined when it can: node:test's `skip`. */
export const skip =
  unless(has('tshark', '--version'), 'tshark is not installed') ??
  unless(!asUser || has('id', asUser), `running as root and there is no user ${asUser} to run tshark as`);

/** The same, for the tests that also need kaitai_struct_formats. */
export const skipFormats =
  skip ?? unless(existsSync(SPEC_DIRS[2]), `no kaitai_struct_formats at ${FORMATS} (set KSF_DIR)`);

const dir = mkdtempSync(join(tmpdir(), 'kaitai-wireshark-'));
chmodSync(dir, 0o755);
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
let files = 0;
export function write(ext: string, data: string | Uint8Array): string {
  const path = join(dir, `${files++}.${ext}`);
  writeFileSync(path, data, { mode: 0o644 });
  return path;
}

/**
 * Writes the dissector for a spec and returns its path. `spec` is a parsed .ksy or a name in test/fixtures or
 * kaitai_struct_formats ("network/dns_packet"), where imports resolve too; `ws` replaces its meta["-wireshark"].
 */
export async function generate(spec: string | Ksy, ws?: Record<string, unknown>): Promise<string> {
  const read = async (name: string) => {
    const found = SPEC_DIRS.map((d) => join(d, `${name}.ksy`)).find((p) => existsSync(p));
    if (!found) throw new Error(`${name}.ksy: not found`);
    return load(readFileSync(found, 'utf8')) as Ksy;
  };
  const ksy = typeof spec === 'string' ? await read(spec) : structuredClone(spec);
  if (ws) ksy.meta['-wireshark'] = ws;
  const { lua } = await generateDissector({ ksy, compiler, importer: { importYaml: read }, ksyUri: 'spec.ksy' });
  return write('lua', lua);
}

/** Runs tshark, with a dissector from generate() if given, and returns stdout. */
export function tshark(lua: string | undefined, args: string[]): string {
  // `timeout -s KILL` and a memory cap, so a runaway dissector fails alone: tshark only stops on SIGTERM between
  // packets, and killing `su` would leave it running. args go first: older tsharks only take -G as the first option.
  const argv = ['timeout', '-s', 'KILL', '60', 'tshark', ...args, '-n', ...(lua ? ['-X', `lua_script:${lua}`] : [])];
  const script = `ulimit -v ${4 << 20}; exec ${argv.map((s) => `'${s.replaceAll("'", "'\\''")}'`).join(' ')}`;
  const [cmd, cmdArgs] = asUser ? ['su', [asUser, '-s', '/bin/sh', '-c', script]] : ['/bin/sh', ['-c', script]];
  const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0 || /Lua: Error/.test(r.stderr)) throw new Error(`tshark exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

// pcap ----------------------------------------------------------------------------------------------------------------

/** A pcap file of the given frames. Linktype 1 is Ethernet, 147 is user DLT 0. */
export function pcap(frames: Uint8Array[], linktype = 1): string {
  const head = Buffer.alloc(24);
  head.writeUInt32LE(0xa1b2c3d4, 0);
  head.writeUInt16LE(2, 4);
  head.writeUInt16LE(4, 6);
  head.writeUInt32LE(262144, 16);
  head.writeUInt32LE(linktype, 20);
  const records = frames.flatMap((f, i) => {
    const h = Buffer.alloc(16);
    h.writeUInt32LE(i, 0);
    h.writeUInt32LE(f.length, 8);
    h.writeUInt32LE(f.length, 12);
    return [h, f];
  });
  return write('pcap', Buffer.concat([head, ...records]));
}

export function ethernet(payload: Uint8Array, type = 0x0800): Buffer {
  const h = Buffer.from('001122334455668899aabbcc0000', 'hex');
  h.writeUInt16BE(type, 12);
  return Buffer.concat([h, payload]);
}

/** An Ethernet frame with an IPv4 packet from 192.0.2.<from> to the other of 192.0.2.1 and 192.0.2.2. */
export function ipv4(proto: number, payload: Uint8Array, from = 1): Buffer {
  const h = Buffer.alloc(20);
  h.set([0x45, 0, 0, 0, 0x12, 0x34, 0x40, 0, 64, proto]); // id 0x1234, don't fragment, TTL 64
  h.writeUInt16BE(20 + payload.length, 2);
  h.set([192, 0, 2, from], 12);
  h.set([192, 0, 2, 3 - from], 16);
  return ethernet(Buffer.concat([h, payload]));
}

export function udp(sport: number, dport: number, payload: Uint8Array, from = 1): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt16BE(sport, 0);
  h.writeUInt16BE(dport, 2);
  h.writeUInt16BE(8 + payload.length, 4);
  return ipv4(17, Buffer.concat([h, payload]), from);
}

export function tcp(sport: number, dport: number, payload: Uint8Array, seq = 1000, ack = 1, flags = 0x18, from = 1) {
  const h = Buffer.alloc(20);
  h.writeUInt16BE(sport, 0);
  h.writeUInt16BE(dport, 2);
  h.writeUInt32BE(seq, 4);
  h.writeUInt32BE(ack, 8);
  h[12] = 5 << 4;
  h[13] = flags;
  h.writeUInt16BE(65535, 14);
  return ipv4(6, Buffer.concat([h, payload]), from);
}

export type Chunk = { from: 'c' | 's'; data: Uint8Array };

/**
 * A TCP connection to port: handshake, then each chunk's bytes from client (c) or server (s), cut into segments of
 * at most mss bytes, then FINs. Each segment is acked by the next packet the other side sends.
 */
export function conversation(chunks: Chunk[], port: number, mss = 1460): Buffer[] {
  const seq = { c: 1000, s: 5000 };
  const out: Buffer[] = [];
  const segment = (from: 'c' | 's', flags: number, data: Uint8Array = new Uint8Array()) => {
    const to = from === 'c' ? 's' : 'c';
    const ports = from === 'c' ? [40000, port] : [port, 40000];
    out.push(tcp(ports[0], ports[1], data, seq[from], flags === 0x02 ? 0 : seq[to], flags, from === 'c' ? 1 : 2));
    seq[from] += data.length + (flags & 0x03 ? 1 : 0);
  };
  segment('c', 0x02);
  segment('s', 0x12);
  segment('c', 0x10);
  for (const { from, data } of chunks) {
    for (let i = 0; i < data.length; i += mss) segment(from, 0x18, data.subarray(i, i + mss));
  }
  segment('c', 0x11);
  segment('s', 0x11);
  return out;
}

/** The TCP payloads of an Ethernet/IPv4 pcap, in order, tagged by whether they go to port. */
export function tcpPayloads(file: string, port: number): Chunk[] {
  const buf = readFileSync(file);
  const out: Chunk[] = [];
  for (let off = 24; off < buf.length; ) {
    const len = buf.readUInt32LE(off + 8);
    const ip = buf.subarray(off + 16 + 14, off + 16 + len);
    off += 16 + len;
    if (ip[9] !== 6) continue;
    const t = ip.subarray((ip[0] & 15) * 4, ip.readUInt16BE(2));
    const data = t.subarray((t[12] >> 4) * 4);
    if (data.length > 0) out.push({ from: t.readUInt16BE(2) === port ? 'c' : 's', data });
  }
  return out;
}

// PDML ----------------------------------------------------------------------------------------------------------------

export interface Field {
  name: string;
  /** The tree item's text. */
  showname: string;
  /** The value as displayed. */
  show: string;
  /** The field's bytes, in hex. */
  value: string;
  pos: number;
  size: number;
  depth: number;
}
export type Packet = Field[];

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

/** Dissects a pcap and returns each packet's fields, in tree order. */
export function dissect(lua: string | undefined, capture: string, args: string[] = []): Packet[] {
  const packets: Packet[] = [];
  let depth = 0;
  const xml = tshark(lua, ['-o', 'gui.max_tree_depth:64', '-r', capture, '-T', 'pdml', ...args]);
  for (const [, close, tag, attrs, selfClose] of xml.matchAll(/<(\/?)(packet|proto|field)\b([^>]*?)(\/?)>/g)) {
    if (tag === 'packet') {
      if (!close) packets.push([]);
      depth = 0;
    } else if (close) {
      depth--;
    } else {
      const a: Record<string, string> = {};
      for (const [, k, v] of attrs.matchAll(/(\w+)="([^"]*)"/g)) {
        a[k] = v.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: keyof typeof ENTITIES) => ENTITIES[e]);
      }
      const { name = '', showname = '', show = '', value = '' } = a;
      packets.at(-1)?.push({ name, showname, show, value, pos: Number(a.pos), size: Number(a.size), depth });
      if (!selfClose) depth++;
    }
  }
  return packets;
}

/** The fields named `name` in a packet. */
export const all = (p: Packet, name: string) => p.filter((f) => f.name === name);

/** The first field named `name` in a packet. */
export function one(p: Packet, name: string): Field {
  const f = p.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name} in packet: ${[...new Set(p.map((x) => x.name))].join(' ')}`);
  return f;
}

/** The fields under `f` in its packet `p`. */
export function subtree(p: Packet, f: Field): Field[] {
  const rest = p.slice(p.indexOf(f) + 1);
  const end = rest.findIndex((x) => x.depth <= f.depth);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The Lua errors and expert items a dissector for `proto` reported. */
export function problems(packets: Packet[], proto: string): string[] {
  const names = ['_ws.lua.error', '_ws.malformed', `${proto}.malformed`, `${proto}.instance`];
  return packets.flatMap((p) => p.filter((f) => names.includes(f.name)).map((f) => f.showname || f.show));
}

/**
 * [our field (without the protocol's prefix), Wireshark's field, what to compare]. By default both the displayed
 * value and the byte range; 'value' or 'range' for only one, 'raw' for the bytes and the range (addresses, which
 * Wireshark formats), or a function from our displayed value to theirs.
 */
export type Pair = [string, string, ('value' | 'range' | 'raw' | ((show: string) => unknown))?];

// numbers (decimal or 0x hex) and booleans compare as numbers
function norm(show: string): unknown {
  if (/^(true|false)$/i.test(show)) return /^true$/i.test(show) ? 1 : 0;
  return /^-?(\d+|0x[0-9a-f]+)$/i.test(show) ? Number(show) : show;
}

/** Asserts that every occurrence of each pair's fields is the same in our packets and Wireshark's. */
export function assertSame(ours: Packet[], theirs: Packet[], prefix: string, pairs: Pair[]): void {
  const pick = (packets: Packet[], mine: boolean) =>
    packets.flatMap((p, i) =>
      pairs.map(([o, t, how]) => ({
        packet: i + 1,
        fields: `${o} ~ ${t}`,
        values: all(p, mine ? `${prefix}.${o}` : t).map((f) => ({
          ...(how !== 'range' && {
            v: how === 'raw' ? f.value : mine && typeof how === 'function' ? how(f.show) : norm(f.show),
          }),
          ...(how !== 'value' && { pos: f.pos, size: f.size }),
        })),
      })),
    );
  assert.deepEqual(pick(ours, true), pick(theirs, false));
}

// Shared helpers for the format cross-checks: generate a dissector from a spec in kaitai_struct_formats, build pcaps,
// run tshark with and without it, and read fields (with their byte ranges) out of PDML.
//
// tshark refuses Lua plugins when run as root, so as root it runs as the user `ws` (KS_TSHARK_USER overrides).
// Every check skips, rather than fails, when tshark, that user, or kaitai_struct_formats is missing.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import compiler from 'kaitai-struct-compiler';
import { generateDissector, type Importer } from '../../src/index.ts';
import type { Ksy } from '../../src/schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const FORMATS = process.env.KSF_DIR ?? join(here, '../../../../../kaitai_struct_formats');
export const FIXTURES = join(here, 'fixtures');

const RUN_AS = process.env.KS_TSHARK_USER ?? 'ws';
const isRoot = process.getuid?.() === 0;

function has(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
}

/** Why the cross-checks can't run here, or undefined when they can. Pass it as node:test's `skip`. */
export const skip: string | undefined = (() => {
  let why: string | undefined;
  if (!has('tshark', ['--version'])) why = 'tshark not installed';
  else if (isRoot && !has('id', [RUN_AS])) why = `running as root and there is no user ${RUN_AS} to run tshark as`;
  else if (!existsSync(join(FORMATS, 'network'))) why = `kaitai_struct_formats not found at ${FORMATS} (set KSF_DIR)`;
  // CI sets this, so a broken environment fails instead of skipping everything
  if (why && process.env.KAITAI_WIRESHARK_REQUIRE) throw new Error(why);
  return why;
})();

// Path relative to kaitai_struct_formats, e.g. "network/dns_packet".
export function readSpec(name: string): Ksy {
  return load(readFileSync(join(FORMATS, `${name}.ksy`), 'utf8')) as Ksy;
}

/**
 * Generates a dissector for a spec with meta["-wireshark"] set to `ws`. `spec` is a path in kaitai_struct_formats
 * ("network/dns_packet"), or a parsed .ksy whose imports resolve there.
 */
export async function dissectorFor(
  spec: string | Ksy,
  ws: Record<string, unknown>,
): Promise<{ lua: string; warnings: string[] }> {
  const name = typeof spec === 'string' ? spec : 'network/_';
  const ksy = typeof spec === 'string' ? readSpec(spec) : structuredClone(spec);
  ksy.meta['-wireshark'] = ws;
  // the compiler gives absolute imports ("/network/x") without the slash and mode "abs"; relative ones resolve from
  // the importing spec, which it doesn't say, so try every directory seen so far (like bin/ksy2wireshark.ts)
  const dirs = [dirname(name)];
  const importer: Importer = {
    async importYaml(imp, mode) {
      const bare = imp.replace(/^\//, '');
      const candidates = mode === 'abs' || imp.startsWith('/') ? [bare] : dirs.map((d) => join(d, bare));
      const rel = candidates.find((c) => existsSync(join(FORMATS, `${c}.ksy`)));
      if (!rel) throw new Error(`import ${imp}: not found`);
      dirs.push(dirname(rel));
      return readSpec(rel);
    },
  };
  const { lua, warnings } = await generateDissector({ ksy, compiler, importer });
  return { lua, warnings };
}

// pcap ----------------------------------------------------------------------------------------------------------------

export const LINKTYPE_ETHERNET = 1;
export const LINKTYPE_USER0 = 147;

/** A classic pcap file of the given frames. */
export function pcap(frames: Buffer[], linktype = LINKTYPE_ETHERNET): Buffer {
  const head = Buffer.alloc(24);
  head.writeUInt32LE(0xa1b2c3d4, 0);
  head.writeUInt16LE(2, 4);
  head.writeUInt16LE(4, 6);
  head.writeUInt32LE(65535, 16);
  head.writeUInt32LE(linktype, 20);
  const recs = frames.map((f, i) => {
    const h = Buffer.alloc(16);
    h.writeUInt32LE(1700000000 + i, 0);
    h.writeUInt32LE(f.length, 8);
    h.writeUInt32LE(f.length, 12);
    return Buffer.concat([h, f]);
  });
  return Buffer.concat([head, ...recs]);
}

function checksum(...parts: Buffer[]): number {
  const b = Buffer.concat(parts);
  let s = 0;
  for (let i = 0; i < b.length; i += 2) s += (b[i] << 8) | (b[i + 1] ?? 0);
  while (s > 0xffff) s = (s & 0xffff) + (s >>> 16);
  return ~s & 0xffff;
}

const ip4 = (a: string) => Buffer.from(a.split('.').map(Number));
const mac = (m: string) => Buffer.from(m.split(':').map((x) => Number.parseInt(x, 16)));

export interface Ip {
  src?: string;
  dst?: string;
  ttl?: number;
  id?: number;
}

export function ipv4(
  proto: number,
  payload: Buffer,
  { src = '192.0.2.1', dst = '192.0.2.2', ttl = 64, id = 0x1234 }: Ip = {},
): Buffer {
  const h = Buffer.alloc(20);
  h[0] = 0x45;
  h.writeUInt16BE(20 + payload.length, 2);
  h.writeUInt16BE(id, 4);
  h.writeUInt16BE(0x4000, 6); // DF
  h[8] = ttl;
  h[9] = proto;
  ip4(src).copy(h, 12);
  ip4(dst).copy(h, 16);
  h.writeUInt16BE(checksum(h), 10);
  return Buffer.concat([h, payload]);
}

function pseudo(src: string, dst: string, proto: number, len: number): Buffer {
  const p = Buffer.alloc(12);
  ip4(src).copy(p, 0);
  ip4(dst).copy(p, 4);
  p[9] = proto;
  p.writeUInt16BE(len, 10);
  return p;
}

export function udp(sport: number, dport: number, payload: Buffer, ip: Ip = {}): Buffer {
  const { src = '192.0.2.1', dst = '192.0.2.2' } = ip;
  const h = Buffer.alloc(8);
  h.writeUInt16BE(sport, 0);
  h.writeUInt16BE(dport, 2);
  h.writeUInt16BE(8 + payload.length, 4);
  h.writeUInt16BE(checksum(pseudo(src, dst, 17, 8 + payload.length), h, payload) || 0xffff, 6);
  return ipv4(17, Buffer.concat([h, payload]), ip);
}

export interface Tcp {
  seq?: number;
  ack?: number;
  flags?: number;
  window?: number;
}

export function tcp(
  sport: number,
  dport: number,
  payload: Buffer,
  { seq = 1000, ack = 0, flags = 0x18, window = 64240 }: Tcp = {},
  ip: Ip = {},
): Buffer {
  const { src = '192.0.2.1', dst = '192.0.2.2' } = ip;
  const h = Buffer.alloc(20);
  h.writeUInt16BE(sport, 0);
  h.writeUInt16BE(dport, 2);
  h.writeUInt32BE(seq >>> 0, 4);
  h.writeUInt32BE(ack >>> 0, 8);
  h[12] = 5 << 4;
  h[13] = flags;
  h.writeUInt16BE(window, 14);
  h.writeUInt16BE(checksum(pseudo(src, dst, 6, 20 + payload.length), h, payload), 16);
  return ipv4(6, Buffer.concat([h, payload]), ip);
}

export function ethernet(
  payload: Buffer,
  { dst = '00:11:22:33:44:55', src = '66:77:88:99:aa:bb', type = 0x0800 } = {},
): Buffer {
  const t = Buffer.alloc(2);
  t.writeUInt16BE(type);
  return Buffer.concat([mac(dst), mac(src), t, payload]);
}

// tshark --------------------------------------------------------------------------------------------------------------

export interface Workdir {
  dir: string;
  write(name: string, data: string | Buffer): string;
  /** Runs tshark in the dir (as RUN_AS when root), killing it after `timeout` seconds. Returns stdout and stderr. */
  tshark(args: string[], timeout?: number): { stdout: string; stderr: string };
  remove(): void;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function workdir(): Workdir {
  const dir = mkdtempSync(join(tmpdir(), 'ks-xcheck-'));
  chmodSync(dir, 0o755);
  return {
    dir,
    write(name, data) {
      const p = join(dir, name);
      writeFileSync(p, data);
      chmodSync(p, 0o644);
      return p;
    },
    tshark(args, timeout = 60) {
      // `timeout` (coreutils) rather than spawnSync's, which would only kill su and leave tshark running
      // SIGKILL: tshark treats SIGTERM as "stop after this packet", which never comes in a runaway dissector; and a
      // memory cap, so a runaway one fails alone instead of starving the machine
      const argv = ['timeout', '-s', 'KILL', String(timeout), 'tshark', '-n', '-o', 'gui.max_tree_depth:64', ...args];
      const script = `ulimit -v ${4 << 20}; cd ${shq(dir)} && exec ${argv.map(shq).join(' ')}`;
      const [cmd, cmdArgs] = isRoot ? ['su', [RUN_AS, '-s', '/bin/sh', '-c', script]] : ['/bin/sh', ['-c', script]];
      const r = spawnSync(cmd, cmdArgs as string[], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
      if (r.status === 124 || r.status === 137) throw new Error(`tshark did not finish within ${timeout}s`);
      if (r.status !== 0) throw new Error(`tshark exited ${r.status}: ${r.stderr}`);
      return { stdout: r.stdout, stderr: r.stderr };
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// PDML ----------------------------------------------------------------------------------------------------------------

export interface PField {
  name: string;
  showname: string;
  show: string;
  value: string;
  pos: number;
  size: number;
  depth: number;
}

function unescapeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#x([0-9a-f]+)|#(\d+));/gi, (_, e, hx, dec) => {
    if (hx) return String.fromCodePoint(Number.parseInt(hx, 16));
    if (dec) return String.fromCodePoint(Number(dec));
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e as string] as string;
  });
}

/** The fields of each packet in a PDML document, in tree order. */
export function pdml(xml: string): PField[][] {
  const packets: PField[][] = [];
  let cur: PField[] = [];
  let depth = 0;
  for (const m of xml.matchAll(/<(\/?)(packet|proto|field)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, attrs, selfClose] = m;
    if (tag === 'packet') {
      if (close) packets.push(cur);
      else cur = [];
      depth = 0;
      continue;
    }
    if (close) {
      depth--;
      continue;
    }
    const a: Record<string, string> = {};
    for (const [, k, v] of attrs.matchAll(/(\w+)="([^"]*)"/g)) a[k] = unescapeXml(v);
    cur.push({
      name: a.name ?? '',
      showname: a.showname ?? '',
      show: a.show ?? '',
      value: a.value ?? '',
      pos: Number(a.pos ?? -1),
      size: Number(a.size ?? -1),
      depth,
    });
    if (!selfClose) depth++;
  }
  return packets;
}

export interface Dissected {
  /** PDML fields of each packet. */
  packets: PField[][];
  stderr: string;
}

/** Dissects a pcap with tshark, optionally loading a Lua dissector, and returns the PDML fields of every packet. */
export function dissect(
  w: Workdir,
  pcapFile: string,
  { lua, args = [], timeout }: { lua?: string; args?: string[]; timeout?: number } = {},
): Dissected {
  const pre = lua ? ['-X', `lua_script:${lua}`] : [];
  const { stdout, stderr } = w.tshark([...pre, '-r', pcapFile, '-T', 'pdml', ...args], timeout);
  return { packets: pdml(stdout), stderr };
}

/** Fields named `name` (exactly) in a packet. */
export function all(p: PField[], name: string): PField[] {
  return p.filter((f) => f.name === name);
}

/** The single field named `name` in a packet; throws when there are none. */
export function one(p: PField[], name: string): PField {
  const f = p.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name} in packet: ${[...new Set(p.map((x) => x.name))].join(' ')}`);
  return f;
}

/** Lua errors and expert warnings a dissector reported, from tshark's stderr and the tree. */
export function problems(d: Dissected, proto: string): string[] {
  const out: string[] = [];
  for (const line of d.stderr.split('\n'))
    if (/lua|error/i.test(line) && !/running as user/i.test(line)) out.push(line);
  for (const p of d.packets) {
    for (const f of p) {
      if (['_ws.lua.error', '_ws.malformed', `${proto}.malformed`, `${proto}.instance`].includes(f.name)) {
        out.push(`${f.name}: ${f.showname || f.show}`);
      }
    }
  }
  return out;
}

// Comparing with Wireshark's own dissectors -----------------------------------------------------------------------------

/** A field's displayed value, normalized so ours and Wireshark's compare: numbers (decimal or 0x hex) and booleans
 * become numbers, anything else stays as shown. */
export function norm(show: string): string | number {
  if (/^(true|false)$/i.test(show)) return /^true$/i.test(show) ? 1 : 0;
  if (/^-?(\d+|0x[0-9a-f]+)$/i.test(show)) return Number(show);
  return show;
}

export interface Pair {
  /** Our field's abbreviation. */
  ours: string;
  /** The built-in dissector's field. */
  theirs: string;
  /** Maps our displayed value to theirs (default: norm). */
  map?: (show: string) => string | number;
  /** Compare values (default true). */
  value?: boolean;
  /** Compare byte ranges (default true). */
  range?: boolean;
}

/** Every occurrence of each pair, ours and theirs side by side, in packet order: [ours[], theirs[]] for deepEqual. */
export function sideBySide(ours: PField[][], theirs: PField[][], pairs: Pair[]): [unknown[], unknown[]] {
  const a: unknown[] = [];
  const b: unknown[] = [];
  ours.forEach((p, i) => {
    for (const { ours: o, theirs: t, map = norm, value = true, range = true } of pairs) {
      const pick = (f: PField, m: (s: string) => unknown) => ({
        ...(value && { v: m(f.show) }),
        ...(range && { pos: f.pos, size: f.size }),
      });
      a.push({ packet: i + 1, field: `${o} ~ ${t}`, values: all(p, o).map((f) => pick(f, map)) });
      b.push({ packet: i + 1, field: `${o} ~ ${t}`, values: all(theirs[i] ?? [], t).map((f) => pick(f, norm)) });
    }
  });
  return [a, b];
}

/** "c0:00:02:01" -> "192.0.2.1" */
export const dotted = (s: string) =>
  s
    .split(':')
    .map((x) => Number.parseInt(x, 16))
    .join('.');

/** "20:01:0d:b8:00:..." -> "2001:db8::1", the way Wireshark shows IPv6 addresses. */
export function ipv6Text(s: string): string {
  const b = s.split(':').map((x) => Number.parseInt(x, 16));
  const words = Array.from({ length: 8 }, (_, i) => ((b[2 * i] << 8) | b[2 * i + 1]).toString(16));
  // longest run of two or more zero words becomes "::"
  let best = [-1, 0];
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && words[j] === '0') j++;
    if (j - i > best[1]) best = [i, j - i];
    i = j === i ? i + 1 : j;
  }
  if (best[1] < 2) return words.join(':');
  return `${words.slice(0, best[0]).join(':')}::${words.slice(best[0] + best[1]).join(':')}`;
}

/** "65:78:61" -> "exa" */
export const ascii = (s: string) => Buffer.from(s.replace(/:/g, ''), 'hex').toString('latin1');

/** The fields under `f` in its packet `p` (PDML is flattened in tree order, so they're the deeper ones after it). */
export function subtree(p: PField[], f: PField): PField[] {
  const i = p.indexOf(f);
  const out: PField[] = [];
  for (let j = i + 1; j < p.length && p[j].depth > f.depth; j++) out.push(p[j]);
  return out;
}

// Test helpers: pcap writing and reading, and running tshark with a generated dissector.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { load } from 'js-yaml';
import compiler from 'kaitai-struct-compiler';
import { generateDissector, type Importer } from '../src/index.ts';
import type { Ksy } from '../src/schema.ts';

export const fixtures = new URL('fixtures/', import.meta.url).pathname;

// tshark won't load Lua plugins as root, so as root run it as another user.
const asUser = process.getuid?.() === 0 ? 'ws' : undefined;
export const tsharkMissing = (() => {
  if (spawnSync('tshark', ['--version']).status !== 0) return 'tshark is not installed';
  if (asUser && spawnSync('id', [asUser]).status !== 0) return `running as root and there is no user ${asUser}`;
  return false;
})();

export function readKsy(path: string): Ksy {
  return load(readFileSync(path, 'utf8')) as Ksy;
}

export async function generate(path: string): Promise<{ lua: string; warnings: string[] }> {
  const importer: Importer = {
    async importYaml(name) {
      return readKsy(join(dirname(path), `${name}.ksy`));
    },
  };
  return generateDissector({ ksy: readKsy(path), compiler, importer, ksyUri: path });
}

/** Runs tshark over a pcap with the dissector for a .ksy loaded, returning stdout. */
export async function tshark(ksy: string, pcap: Uint8Array | string, args: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'kaitai-wireshark-'));
  chmodSync(dir, 0o755);
  const { lua } = await generate(ksy);
  writeFileSync(join(dir, 'dissector.lua'), lua, { mode: 0o644 });
  const input = join(dir, 'in.pcap');
  writeFileSync(input, typeof pcap === 'string' ? readFileSync(pcap) : pcap, { mode: 0o644 });
  const argv = ['-n', '-X', `lua_script:${join(dir, 'dissector.lua')}`, '-r', input, ...args];
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const [cmd, cmdArgs] = asUser
    ? ['su', [asUser, '-s', '/bin/sh', '-c', ['tshark', ...argv].map(quote).join(' ')]]
    : ['tshark', argv];
  return execFileSync(cmd, cmdArgs as string[], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** tshark -T fields output as rows of columns. */
export async function fields(ksy: string, pcap: Uint8Array | string, names: string[], filter?: string) {
  const out = await tshark(ksy, pcap, [
    ...(filter ? ['-Y', filter] : []),
    '-T',
    'fields',
    ...names.flatMap((n) => ['-e', n]),
  ]);
  return out
    .trimEnd()
    .split('\n')
    .map((l) => l.split('\t'));
}

// pcap writing ----------------------------------------------------------------------------------------------------

export function pcap(packets: Uint8Array[], linktype = 1): Uint8Array {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0);
  header.writeUInt16LE(2, 4);
  header.writeUInt16LE(4, 6);
  header.writeUInt32LE(262144, 16);
  header.writeUInt32LE(linktype, 20);
  parts.push(header);
  packets.forEach((p, i) => {
    const rec = Buffer.alloc(16);
    rec.writeUInt32LE(i, 0);
    rec.writeUInt32LE(p.length, 8);
    rec.writeUInt32LE(p.length, 12);
    parts.push(rec, Buffer.from(p));
  });
  return Buffer.concat(parts);
}

function ipv4(proto: number, src: number, dst: number, payload: Uint8Array): Buffer {
  const h = Buffer.alloc(20);
  h.writeUInt8(0x45, 0);
  h.writeUInt16BE(20 + payload.length, 2);
  h.writeUInt8(64, 8);
  h.writeUInt8(proto, 9);
  h.writeUInt32BE(src, 12);
  h.writeUInt32BE(dst, 16);
  const eth = Buffer.alloc(14);
  eth.writeUInt16BE(0x0800, 12);
  return Buffer.concat([eth, h, payload]);
}

const CLIENT = 0x0a000001;
const SERVER = 0x0a000002;

export function udp(payload: Uint8Array, dport: number, sport = 40000): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt16BE(sport, 0);
  h.writeUInt16BE(dport, 2);
  h.writeUInt16BE(8 + payload.length, 4);
  return ipv4(17, CLIENT, SERVER, Buffer.concat([h, payload]));
}

/**
 * A TCP connection to port: handshake, then each chunk's bytes from client (c) or server (s), cut into segments of
 * at most mss bytes, then FINs. Each segment is acked by the next packet the other side sends.
 */
export function tcp(chunks: { from: 'c' | 's'; data: Uint8Array }[], port: number, mss = 1460): Buffer[] {
  const seq = { c: 1000, s: 5000 };
  const ends = { c: [CLIENT, 40000], s: [SERVER, port] } as const;
  const out: Buffer[] = [];
  const segment = (from: 'c' | 's', flags: number, data: Uint8Array = new Uint8Array()) => {
    const to = from === 'c' ? 's' : 'c';
    const h = Buffer.alloc(20);
    h.writeUInt16BE(ends[from][1], 0);
    h.writeUInt16BE(ends[to][1], 2);
    h.writeUInt32BE(seq[from], 4);
    h.writeUInt32BE(flags & 0x02 && from === 'c' ? 0 : seq[to], 8);
    h.writeUInt8(5 << 4, 12);
    h.writeUInt8(flags, 13);
    h.writeUInt16BE(65535, 14);
    out.push(ipv4(6, ends[from][0], ends[to][0], Buffer.concat([h, data])));
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
export function tcpPayloads(file: string, port: number): { from: 'c' | 's'; data: Buffer }[] {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0xa1b2c3d4 || buf.readUInt32LE(20) !== 1)
    throw new Error(`${file}: not an Ethernet pcap`);
  const out: { from: 'c' | 's'; data: Buffer }[] = [];
  for (let off = 24; off < buf.length; ) {
    const len = buf.readUInt32LE(off + 8);
    const frame = buf.subarray(off + 16, off + 16 + len);
    off += 16 + len;
    if (frame.readUInt16BE(12) !== 0x0800 || frame[23] !== 6) continue;
    const ip = frame.subarray(14);
    const ipLen = (ip[0] & 15) * 4;
    const t = ip.subarray(ipLen, ip.readUInt16BE(2));
    const data = t.subarray((t[12] >> 4) * 4);
    if (data.length > 0) out.push({ from: t.readUInt16BE(2) === port ? 'c' : 's', data });
  }
  return out;
}

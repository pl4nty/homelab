import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseTar, writeTar, type TarEntry } from '../src/core/tar.ts';

const enc = new TextEncoder();
const long = 'a'.repeat(60) + '/' + 'b'.repeat(60) + '/' + 'c'.repeat(80) + '.txt';

test('round-trips entries including PAX long names and symlinks', () => {
  const entries: TarEntry[] = [
    { path: 'etc', type: 'dir', mode: 0o755, uid: 0, gid: 0, mtime: 1 },
    { path: 'etc/hosts', type: 'file', mode: 0o644, uid: 1, gid: 2, mtime: 3, data: enc.encode('127.0.0.1 localhost\n') },
    { path: long, type: 'file', mode: 0o600, uid: 0, gid: 0, mtime: 4, data: enc.encode('x'.repeat(1000)) },
    { path: 'lnk', type: 'symlink', mode: 0o777, uid: 0, gid: 0, mtime: 5, linkname: '/' + long },
  ];
  const out = parseTar(writeTar(entries));
  assert.deepEqual(
    out.map(({ uname: _u, gname: _g, devmajor: _a, devminor: _b, ...e }) => e),
    entries,
  );
});

test('interoperates with GNU tar in both directions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tar-'));
  mkdirSync(join(dir, 'src', 'a'.repeat(60), 'b'.repeat(60)), { recursive: true });
  writeFileSync(join(dir, 'src', 'a'.repeat(60), 'b'.repeat(60), 'c'.repeat(80) + '.txt'), 'hello');
  symlinkSync('a'.repeat(60), join(dir, 'src', 'link'));
  for (const format of ['gnu', 'pax', 'ustar']) {
    const archive = join(dir, `${format}.tar`);
    try {
      execFileSync('tar', ['-C', join(dir, 'src'), `--format=${format}`, '-cf', archive, '.']);
    } catch {
      continue; // ustar cannot store the 200-char path; GNU tar refuses
    }
    const entries = parseTar(readFileSync(archive));
    const f = entries.find((e) => e.path === long);
    assert.ok(f, `${format}: long path parsed`);
    assert.equal(new TextDecoder().decode(f.data), 'hello');
    assert.equal(entries.find((e) => e.path === 'link')?.linkname, 'a'.repeat(60));
  }
  const ours = join(dir, 'ours.tar');
  writeFileSync(ours, writeTar([
    { path: long, type: 'file', mode: 0o644, uid: 0, gid: 0, mtime: 0, data: enc.encode('ours') },
  ]));
  mkdirSync(join(dir, 'x'));
  execFileSync('tar', ['-C', join(dir, 'x'), '-xf', ours]);
  assert.equal(readFileSync(join(dir, 'x', long), 'utf8'), 'ours');
});

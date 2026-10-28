import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Overlay, Tree, join, type FsNode } from '../src/core/overlay.ts';
import { parseTar, writeTar, type TarEntry } from '../src/core/tar.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const f = (path: string, text: string, mode = 0o644): TarEntry => ({ path, type: 'file', mode, uid: 0, gid: 0, mtime: 0, data: enc.encode(text) });
const d = (path: string): TarEntry => ({ path, type: 'dir', mode: 0o755, uid: 0, gid: 0, mtime: 0 });
const l = (path: string, linkname: string): TarEntry => ({ path, type: 'symlink', mode: 0o777, uid: 0, gid: 0, mtime: 0, linkname });

function baseTree(): Tree {
  const t = new Tree();
  t.applyLayer([d('usr'), d('usr/bin'), f('usr/bin/sh', '#!sh', 0o755), l('bin', 'usr/bin'), d('etc'), f('etc/os-release', 'v1'), f('etc/motd', 'hi'), d('var/cache'), f('var/cache/a', 'a'), f('var/cache/b', 'b')]);
  t.applyLayer([
    f('etc/.wh.motd', ''), // whiteout from lower layer
    f('var/cache/.wh..wh..opq', ''),
    f('var/cache/c', 'c'), // same layer as opaque marker: must survive
    f('etc/os-release', 'v2'),
    { path: 'etc/hard', type: 'hardlink', mode: 0o644, uid: 0, gid: 0, mtime: 0, linkname: 'etc/os-release' },
  ]);
  return t;
}

/** Snapshot of everything visible through an overlay or a tree. */
function snapshot(o: Overlay, dir = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [name, node] of o.readdir(dir).sort()) {
    const p = join(dir, name);
    out[p] = node.type === 'file' ? `file:${node.mode.toString(8)}:${dec.decode(node.data)}` : node.type === 'symlink' ? `link:${node.linkname}` : 'dir';
    if (node.type === 'dir') snapshot(o, p, out);
  }
  return out;
}

test('applies whiteouts, opaque dirs and hardlinks per the OCI layer spec', () => {
  const t = baseTree();
  assert.equal(t.get('etc/motd'), undefined);
  assert.deepEqual(t.list('var/cache').sort(), ['c']);
  assert.equal(dec.decode(t.get('etc/os-release')!.data), 'v2');
  assert.equal(dec.decode(t.get('etc/hard')!.data), 'v2');
});

test('resolves symlinks in intermediate and final components', () => {
  const o = new Overlay(baseTree());
  assert.equal(dec.decode(o.readFile('bin/sh')), '#!sh');
  assert.deepEqual(o.readdir('bin').map(([n]) => n), ['sh']);
  assert.equal(o.stat('bin').isLink, true);
  assert.equal(o.stat('bin').node.type, 'dir');
  // Writing through the symlink lands in the real directory.
  assert.equal(o.writeFile('bin/new', enc.encode('n'), { create: true, overwrite: false }), 'usr/bin/new');
});

test('tracks changes and produces a layer equivalent to the overlay view', () => {
  const o = new Overlay(baseTree());
  o.writeFile('etc/os-release', enc.encode('edited'), { create: false, overwrite: true });
  o.writeFile('etc/new.conf', enc.encode('new'), { create: true, overwrite: false });
  o.delete('var/cache', true);
  o.mkdir('var/cache');
  o.writeFile('var/cache/z', enc.encode('z'), { create: true, overwrite: false });
  o.delete('usr/bin/sh', false);
  o.mkdir('opt');
  o.rename('etc/hard', 'opt/hard', false);

  assert.deepEqual(o.changes().map((c) => `${c.status} ${c.path}`), [
    'deleted etc/hard',
    'added etc/new.conf',
    'modified etc/os-release',
    'added opt/hard',
    'deleted usr/bin/sh',
    'added var/cache/z',
  ]);
  assert.equal(o.stat('etc/os-release').node.mode, 0o644, 'mode preserved on edit');

  const expected = snapshot(o);
  // Serialise the upper layer, re-parse it and apply onto a fresh base: same view.
  const layer = parseTar(writeTar(o.toLayerEntries()));
  assert.ok(layer.some((e) => e.path === 'var/cache/.wh..wh..opq'));
  assert.ok(layer.some((e) => e.path === 'usr/bin/.wh.sh'));
  const t = baseTree();
  t.applyLayer(layer);
  assert.deepEqual(snapshot(new Overlay(t)), expected);

  // flatten() does the same in place and clears pending changes.
  o.flatten();
  assert.equal(o.isDirty(), false);
  assert.deepEqual(snapshot(o), expected);
});

test('discard restores base content and serialisation round-trips', () => {
  const o = new Overlay(baseTree());
  o.writeFile('etc/os-release', enc.encode('edited'), { create: false, overwrite: true });
  o.delete('var', true);
  const copy = new Overlay(baseTree());
  copy.restore(JSON.parse(JSON.stringify(o.serialize())));
  assert.deepEqual(snapshot(copy), snapshot(o));

  o.discard('var');
  assert.equal(dec.decode(o.readFile('var/cache/c')), 'c');
  o.discardAll();
  assert.equal(dec.decode(o.readFile('etc/os-release')), 'v2');
  assert.equal(o.isDirty(), false);
});

test('rejects invalid operations with FileSystemError codes', () => {
  const o = new Overlay(baseTree());
  assert.throws(() => o.writeFile('nope/x', enc.encode(''), { create: true, overwrite: true }), /FileNotFound/);
  assert.throws(() => o.writeFile('etc', enc.encode(''), { create: true, overwrite: true }), /FileIsADirectory/);
  assert.throws(() => o.writeFile('etc/os-release', enc.encode(''), { create: true, overwrite: false }), /FileExists/);
  assert.throws(() => o.delete('etc', false), /NoPermissions/);
  assert.throws(() => o.readdir('etc/os-release'), /FileNotADirectory/);
  const n: FsNode | undefined = o.lookup('etc/motd');
  assert.equal(n, undefined);
});

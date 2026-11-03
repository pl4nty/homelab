import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Overlay, Tree } from '../src/core/overlay.ts';
import { findFiles, globToRegExp, pathFilter, searchText, type TextMatch } from '../src/core/search.ts';
import type { TarEntry } from '../src/core/tar.ts';

const enc = new TextEncoder();
const f = (path: string, text: string | Uint8Array): TarEntry => ({
  path,
  type: 'file',
  mode: 0o644,
  uid: 0,
  gid: 0,
  mtime: 0,
  data: typeof text === 'string' ? enc.encode(text) : text,
});

function overlay(): Overlay {
  const t = new Tree();
  t.applyLayer([
    f('etc/nginx/nginx.conf', 'worker_processes auto;\nhttp {\n  server_tokens off;\n}\n'),
    f('etc/hosts', '127.0.0.1 localhost\n'),
    f('usr/bin/tool', new Uint8Array([0x7f, 0x45, 0, 1, 0x6c, 0x6f, 0x63, 0x61, 0x6c])),
    f('srv/app/€uro.txt', 'price: 5€ localhost\r\nnext line\n'),
    { path: 'etc/link', type: 'symlink', mode: 0o777, uid: 0, gid: 0, mtime: 0, linkname: '/etc' },
  ]);
  const o = new Overlay(t);
  o.writeFile('etc/new.conf', enc.encode('server_tokens on;\n'), { create: true, overwrite: false });
  o.delete('etc/hosts', false);
  return o;
}

test('globs follow VS Code semantics', () => {
  assert.ok(globToRegExp('**/*.conf').test('etc/nginx/nginx.conf'));
  assert.ok(globToRegExp('**/*.conf').test('a.conf'));
  assert.ok(globToRegExp('etc/{nginx,ssl}/*').test('etc/ssl/x'));
  assert.ok(!globToRegExp('etc/*').test('etc/nginx/nginx.conf'));
  assert.ok(pathFilter({ excludes: ['etc/nginx'] })('srv/app/x'));
  assert.ok(!pathFilter({ excludes: ['etc/nginx'] })('etc/nginx/nginx.conf'), 'folder exclude covers descendants');
  assert.ok(!pathFilter({ includes: ['srv/**'] })('etc/new.conf'));
});

test('file search sees the merged view, fuzzy-matches and does not follow symlinks', () => {
  const o = overlay();
  assert.deepEqual(findFiles(o, ''), ['etc/new.conf', 'etc/nginx/nginx.conf', 'srv/app/€uro.txt', 'usr/bin/tool']);
  assert.deepEqual(findFiles(o, 'ngcf'), ['etc/nginx/nginx.conf']);
  assert.deepEqual(findFiles(o, 'conf', { excludes: ['**/nginx/**'] }), ['etc/new.conf']);
  assert.equal(findFiles(o, '', { maxResults: 2 }).length, 2);
});

test('text search reports UTF-16 ranges, skips binary files and honours limits', () => {
  const o = overlay();
  const hits: TextMatch[] = [];
  searchText(o, { pattern: 'LOCALHOST' }, { onMatch: (m) => hits.push(m) });
  assert.deepEqual(
    hits.map((h) => [h.path, h.start, h.preview]),
    [['srv/app/€uro.txt', { line: 0, character: 10 }, 'price: 5€ localhost']],
    'deleted /etc/hosts and binary usr/bin/tool are not searched',
  );

  hits.length = 0;
  searchText(
    o,
    { pattern: 'server_tokens (on|off)', isRegExp: true, isCaseSensitive: true },
    { onMatch: (m) => hits.push(m) },
  );
  assert.deepEqual(
    hits.map((h) => `${h.path}:${h.start.line}:${h.start.character}-${h.end.character}`),
    ['etc/new.conf:0:0-16', 'etc/nginx/nginx.conf:2:2-19'],
  );

  hits.length = 0;
  searchText(
    o,
    { pattern: 'http \\{\\n  server', isRegExp: true, isMultiline: true },
    { onMatch: (m) => hits.push(m) },
  );
  assert.deepEqual(
    [hits[0].start, hits[0].end, hits[0].preview],
    [{ line: 1, character: 0 }, { line: 2, character: 8 }, 'http {\n  server_tokens off;'],
  );

  assert.equal(searchText(o, { pattern: 'worker', isWordMatch: true }).matches, 0);
  assert.deepEqual(searchText(o, { pattern: 'e' }, { maxResults: 3 }), { matches: 3, limitHit: true });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXTENSIONS } from '../src/gallery/extensions.ts';
import {
  contentsUrl,
  fetchRepoFile,
  gitTreeUrl,
  groupByCategory,
  parseGitTree,
  rawUrl,
  toEntries,
} from '../src/gallery/listing.ts';
import { dirname, normalizePath, readMeta, resolveImport } from '../src/gallery/spec.ts';
import { bundledPaths, extensionOf, suggestFor } from '../src/gallery/suggest.ts';

test('parses the GitHub git tree API', () => {
  const json = {
    sha: 'abc',
    truncated: false,
    tree: [
      { path: 'image', mode: '040000', type: 'tree', sha: '1' },
      { path: 'image/png.ksy', mode: '100644', type: 'blob', sha: '2', size: 10 },
      { path: 'image/README.md', mode: '100644', type: 'blob', sha: '3' },
      { path: 'common/vlq_base128_le.ksy', mode: '100644', type: 'blob', sha: '4' },
      { path: '_build/x.ksy', mode: '100644', type: 'blob', sha: '5' },
      { path: '.github/y.ksy', mode: '100644', type: 'blob', sha: '6' },
      { path: 'root.ksy', mode: '100644', type: 'blob', sha: '7' },
      { path: 'dir.ksy', mode: '040000', type: 'tree', sha: '8' },
    ],
  };
  const { entries, truncated } = parseGitTree(json);
  assert.equal(truncated, false);
  assert.deepEqual(entries, [
    { path: 'common/vlq_base128_le.ksy', category: 'common', name: 'vlq_base128_le' },
    { path: 'image/png.ksy', category: 'image', name: 'png' },
    { path: 'root.ksy', category: '', name: 'root' },
  ]);
  assert.throws(() => parseGitTree({ message: 'API rate limit exceeded' }), /rate limit/);
});

test('groups by category and sorts', () => {
  const groups = groupByCategory(toEntries(['b/z.ksy', 'a/y.ksy', 'b/a.ksy', 'top.ksy']));
  assert.deepEqual(
    groups.map((g) => [g.name, g.entries.map((e) => e.name)]),
    [
      ['', ['top']],
      ['a', ['y']],
      ['b', ['a', 'z']],
    ],
  );
});

test('urls', () => {
  assert.equal(gitTreeUrl('o/r', 'main'), 'https://api.github.com/repos/o/r/git/trees/main?recursive=1');
  assert.equal(rawUrl('o/r', 'v1', '/a b/c.ksy'), 'https://raw.githubusercontent.com/o/r/v1/a%20b/c.ksy');
});

test('resolves relative and absolute imports', () => {
  assert.equal(resolveImport('image/png.ksy', '/common/vlq_base128_le'), 'common/vlq_base128_le.ksy');
  assert.equal(resolveImport('media/tracker_modules/s3m.ksy', 'xm_common'), 'media/tracker_modules/xm_common.ksy');
  assert.equal(resolveImport('network/some_ip/some_ip.ksy', '../ipv4_packet'), 'network/ipv4_packet.ksy');
  assert.equal(resolveImport('root.ksy', 'sibling'), 'sibling.ksy');
  assert.equal(resolveImport('a/b.ksy', '../../escape'), undefined);
  assert.equal(normalizePath('/a/./b/../c'), 'a/c');
  assert.equal(normalizePath('a/../..'), undefined);
  assert.equal(dirname('a/b/c.ksy'), 'a/b');
  assert.equal(dirname('c.ksy'), '');
});

test('reads meta, tolerating broken YAML and scalar file-extension', () => {
  const m = readMeta(
    'meta:\n  id: png\n  title: PNG file\n  file-extension: [PNG, .apng]\n  imports:\n    - /common/x\n    - y\n',
  );
  assert.deepEqual(m, { title: 'PNG file', fileExtensions: ['png', 'apng'], imports: ['/common/x', 'y'] });
  assert.deepEqual(readMeta('meta:\n  id: z\n  file-extension: zip\n').fileExtensions, ['zip']);
  assert.deepEqual(readMeta(': : [').fileExtensions, []);
  assert.deepEqual(readMeta('seq: []').imports, []);
  assert.deepEqual(readMeta('meta:\n  imports: [a, null]\n').imports, ['a']);
});

test('extension map lookup and suggestions', () => {
  assert.deepEqual(EXTENSIONS.png, ['image/png.ksy']);
  assert.ok(EXTENSIONS.zip.includes('archive/zip.ksy'));
  assert.equal(extensionOf('/x/photo.PNG'), 'png');
  assert.equal(extensionOf('/x/.bashrc'), undefined);
  assert.equal(extensionOf('/x/noext'), undefined);
  assert.deepEqual(suggestFor('png', []), ['image/png.ksy']);
  assert.deepEqual(suggestFor('.PNG', []), ['image/png.ksy']);
  assert.deepEqual(suggestFor('constructor', []), []);
  assert.deepEqual(suggestFor(undefined, []), []);
  // Restricted to the listing when one is loaded; entries named after the extension and fetched meta count too.
  const entries = toEntries(['image/png.ksy', 'misc/foo.ksy', 'misc/bar.ksy']);
  assert.deepEqual(suggestFor('png', entries), ['image/png.ksy']);
  assert.deepEqual(suggestFor('zip', entries), []);
  assert.deepEqual(suggestFor('foo', entries, new Map([['misc/bar.ksy', { fileExtensions: ['foo'] }]])), [
    'misc/bar.ksy',
    'misc/foo.ksy',
  ]);
  const all = bundledPaths();
  assert.ok(all.includes('image/png.ksy') && all.length > 100);
});

test('falls back to the contents API when raw.githubusercontent.com is blocked', async (t) => {
  const seen: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    seen.push(url);
    if (url.startsWith('https://raw.')) throw new TypeError('Failed to fetch');
    assert.equal(new Headers(init?.headers).get('Accept'), 'application/vnd.github.raw');
    return url.includes('missing') ? new Response('', { status: 404 }) : new Response('meta: {}');
  });
  assert.equal(await fetchRepoFile('o/r', 'v1', 'a/b.ksy'), 'meta: {}');
  assert.equal(seen[1], contentsUrl('o/r', 'v1', 'a/b.ksy'));
  assert.equal(seen[1], 'https://api.github.com/repos/o/r/contents/a/b.ksy?ref=v1');
  assert.equal(await fetchRepoFile('o/r', 'v1', 'missing.ksy'), undefined);
});

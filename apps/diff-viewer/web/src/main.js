import '@fontsource/titillium-web/400.css';
import '@fontsource/titillium-web/600.css';
import '@fontsource/titillium-web/700.css';
import '@fontsource/fira-code/400.css';
import './style.css';
import { CodeView, parseDiffFromFile, parsePatchFiles } from '@pierre/diffs';
import { decodeFragment, encodeFragment, LINK_LIMIT, seal, unseal } from './codec.js';

const $ = (id) => document.getElementById(id);
const form = $('editor');
const diff = $('diff');
const message = $('message');
const share = $('share');

const prefs = load('prefs') ?? {
  diffStyle: matchMedia('(max-width: 50rem)').matches ? 'unified' : 'split',
  wrap: false,
};
let mode = 'texts';
let doc; // the document on screen
let link; // its share link, once it has one
let viewer;

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return undefined;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const longDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });

function say(text, { error = false, url } = {}) {
  message.replaceChildren(text);
  if (url) {
    const input = Object.assign(document.createElement('input'), { value: url, readOnly: true });
    input.addEventListener('focus', () => input.select());
    message.append(input);
  }
  message.classList.toggle('error', error);
  message.hidden = !text;
}

const stored = (expires) =>
  `Stored encrypted until ${longDate.format(new Date(expires))}. Anyone with the link can open it until then.`;

function setMode(next) {
  mode = next;
  for (const b of form.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', b.dataset.mode === mode);
  $('texts').hidden = mode !== 'texts';
  $('patch-pane').hidden = mode !== 'patch';
  $('name').hidden = mode !== 'texts';
}

function showEditor() {
  viewer?.cleanUp();
  viewer = undefined;
  diff.hidden = true;
  $('actions').hidden = true;
  $('stats').hidden = true;
  form.hidden = false;
  if (doc) {
    setMode(doc.patch === undefined ? 'texts' : 'patch');
    $('a').value = doc.a ?? '';
    $('b').value = doc.b ?? '';
    $('name').value = doc.name ?? '';
    $('patch').value = doc.patch ?? '';
  } else {
    setMode(mode);
  }
  (mode === 'texts' ? $('a') : $('patch')).focus();
}

function toItems(next) {
  if (next.patch !== undefined) {
    return parsePatchFiles(next.patch, 'patch')
      .flatMap((p) => p.files)
      .map((fileDiff, i) => ({ id: `f${i}`, type: 'diff', fileDiff }));
  }
  const name = next.name || 'text';
  const fileDiff = parseDiffFromFile({ name, contents: next.a }, { name, contents: next.b });
  return [{ id: 'f0', type: 'diff', fileDiff }];
}

function options() {
  return {
    theme: { dark: 'pierre-dark', light: 'pierre-light' },
    themeType: 'system',
    diffStyle: prefs.diffStyle,
    overflow: prefs.wrap ? 'wrap' : 'scroll',
    stickyHeaders: true,
    lineDiffType: 'word',
  };
}

function syncControls() {
  for (const b of document.querySelectorAll('[data-style]')) {
    b.setAttribute('aria-pressed', b.dataset.style === prefs.diffStyle);
  }
  $('wrap').setAttribute('aria-pressed', prefs.wrap);
}

function showDiff(next) {
  doc = next;
  const items = toItems(next);
  if (!items.length) {
    say('That patch has no file changes in it.', { error: true });
    showEditor();
    return;
  }
  let add = 0;
  let del = 0;
  for (const { fileDiff } of items) {
    for (const h of fileDiff.hunks) {
      add += h.additionLines;
      del += h.deletionLines;
    }
  }
  const stats = $('stats');
  stats.innerHTML = `<span class="add">+${add}</span> <span class="del">−${del}</span>`;
  stats.title = `${items.length} file${items.length === 1 ? '' : 's'}`;
  stats.hidden = false;

  form.hidden = true;
  $('actions').hidden = false;
  diff.hidden = false;
  syncControls();
  viewer?.cleanUp();
  viewer = new CodeView(options());
  viewer.setup(diff);
  viewer.setItems(items);
  viewer.render();
}

function readEditor() {
  if (mode === 'patch') return { patch: $('patch').value };
  const next = { a: $('a').value, b: $('b').value };
  const name = $('name').value.trim();
  if (name) next.name = name;
  return next;
}

async function route() {
  say('');
  const fragment = location.hash.slice(1);
  const id = location.pathname.match(/^\/d\/([\w-]{16})$/)?.[1];
  try {
    if (id && fragment) {
      say('Loading…');
      const res = await fetch(`/api/diffs/${id}`);
      if (res.status === 404) throw new Error('This diff has expired or never existed.');
      if (!res.ok) throw new Error(`The server returned ${res.status}.`);
      const expires = res.headers.get('Diff-Expires');
      const blob = new Uint8Array(await res.arrayBuffer());
      link = location.href;
      showDiff(await unseal(blob, fragment).catch(() => Promise.reject(new Error('The key in this link is wrong.'))));
      say(stored(expires));
    } else if (fragment) {
      link = location.href;
      showDiff(await decodeFragment(fragment).catch(() => Promise.reject(new Error('This link is damaged.'))));
    } else if (history.state?.local && doc) {
      link = undefined;
      showDiff(doc);
    } else {
      showEditor();
    }
  } catch (e) {
    say(e.message, { error: true });
    showEditor();
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = readEditor();
  const fragment = await encodeFragment(next);
  const url = `${location.origin}/#${fragment}`;
  doc = next;
  if (url.length <= LINK_LIMIT) {
    history.pushState(null, '', url);
  } else {
    // too long for a link: keep it in memory until someone shares it
    history.pushState({ local: true }, '', '/');
  }
  await route();
});

form.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
});

for (const b of form.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));

for (const area of form.querySelectorAll('textarea')) {
  area.addEventListener('dragover', (e) => {
    e.preventDefault();
    area.classList.add('drop');
  });
  area.addEventListener('dragleave', () => area.classList.remove('drop'));
  area.addEventListener('drop', async (e) => {
    e.preventDefault();
    area.classList.remove('drop');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    area.value = await file.text();
    if (area.id !== 'patch' && !$('name').value) $('name').value = file.name;
  });
}

for (const b of document.querySelectorAll('[data-style]')) {
  b.addEventListener('click', () => {
    prefs.diffStyle = b.dataset.style;
    save('prefs', prefs);
    syncControls();
    viewer?.setOptions(options());
    viewer?.render();
  });
}

$('wrap').addEventListener('click', () => {
  prefs.wrap = !prefs.wrap;
  save('prefs', prefs);
  syncControls();
  viewer?.setOptions(options());
  viewer?.render();
});

$('edit').addEventListener('click', () => {
  history.pushState(null, '', '/');
  say('');
  showEditor();
});

async function upload() {
  const { blob, key } = await seal(doc);
  const res = await fetch('/api/diffs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
  if (res.status === 413) throw new Error('This diff is too large to store.');
  if (res.status === 507) throw new Error('The server is out of space for new diffs.');
  if (!res.ok) throw new Error(`The server returned ${res.status}.`);
  const { id, expires } = await res.json();
  const url = `${location.origin}/d/${id}#${key}`;
  history.replaceState(null, '', url);
  return { url, expires };
}

share.addEventListener('click', async () => {
  share.disabled = true;
  let expires;
  const pending = link
    ? Promise.resolve(link)
    : upload().then((r) => {
        link = r.url;
        expires = r.expires;
        return r.url;
      });
  try {
    // Safari only lets a page write the clipboard during the click, so hand it a promise
    await navigator.clipboard.write([
      new ClipboardItem({ 'text/plain': pending.then((url) => new Blob([url], { type: 'text/plain' })) }),
    ]);
    say(expires ? `Link copied. ${stored(expires)}` : 'Link copied.');
  } catch (e) {
    const url = await pending.catch(() => undefined);
    if (url) say(expires ? `${stored(expires)} Copy the link:` : 'Copy the link:', { url });
    else say(e.message, { error: true });
  } finally {
    share.disabled = false;
  }
});

window.addEventListener('popstate', route);
window.addEventListener('hashchange', route);
route();

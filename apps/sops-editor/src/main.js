import { identityToRecipient } from 'age-encryption';
import { parseDocument } from 'yaml';
import { GitHub } from './github.js';
import { decrypt, encrypt, newContext, parseIdentities } from './sops.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  },
  set: (k, v) => {
    try {
      if (v) localStorage.setItem(k, v);
      else localStorage.removeItem(k);
    } catch {}
  },
};

let gh;
let branch;
let files = [];
let open; // { path, sha, ctx, plain, isNew }

function status(msg, error = false) {
  $('status').textContent = msg;
  $('status').className = error ? 'error' : '';
}

async function run(label, fn) {
  status(`${label}…`);
  try {
    await fn();
  } catch (e) {
    console.error(e);
    status(`${label} failed: ${e.message}`, true);
  }
}

const dirty = () => open && $('text').value !== open.plain;

function identities() {
  const ids = parseIdentities($('key').value);
  if (!ids.length) throw new Error('add your age key in Settings');
  return ids;
}

function renderFiles() {
  const q = $('filter').value.toLowerCase();
  $('files').replaceChildren(
    ...files
      .filter((f) => f.toLowerCase().includes(q))
      .map((f) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = f;
        b.title = f;
        b.className = open?.path === f ? 'active' : '';
        b.onclick = () => openFile(f);
        li.append(b);
        return li;
      }),
  );
}

function showEditor() {
  $('editor').hidden = false;
  $('path').textContent = open.path + (open.isNew ? ' (new)' : '');
  $('text').value = open.plain;
  $('message').value = '';
  $('message').placeholder = `${open.isNew ? 'feat: add' : 'chore: update'} ${open.path}`;
  $('commit-link').hidden = true;
  renderFiles();
}

async function sopsConfig() {
  try {
    return (await gh.read('.sops.yaml', branch)).text;
  } catch (e) {
    if (e.status === 404) return 'creation_rules: [{}]';
    throw e;
  }
}

async function connect() {
  const token = $('token').value.trim();
  const repo = $('repo').value.trim();
  if (!token || !repo) {
    $('settings').hidden = false;
    throw new Error('add a GitHub token and repository in Settings');
  }
  store.set('token', token);
  store.set('repo', repo);
  store.set('branch', $('branch').value.trim());
  store.set('key', $('remember-key').checked ? $('key').value.trim() : '');
  gh = new GitHub(token, repo);
  branch = $('branch').value.trim() || (await gh.defaultBranch());
  const rules = (parseDocument(await sopsConfig()).toJS()?.creation_rules ?? []).map(
    (r) => new RegExp(r.path_regex ?? '.*'),
  );
  const all = await gh.tree(branch).catch(async (e) => {
    if (e.status === 404) return gh.tree(await gh.defaultBranch());
    throw e;
  });
  files = all.filter((p) => /\.ya?ml$/.test(p) && rules.some((r) => r.test(p)));
  renderFiles();
  $('settings').hidden = true;
  status(`${files.length} files on ${branch}`);
}

async function openFile(path) {
  if (dirty() && !confirm('Discard unsaved changes?')) return;
  await run(`Decrypting ${path}`, async () => {
    const { text, sha } = await gh.read(path, branch);
    const { plain, ctx } = await decrypt(text, identities());
    open = { path, sha, ctx, plain };
    showEditor();
    status(`Decrypted ${path}`);
  });
}

async function newFile() {
  if (dirty() && !confirm('Discard unsaved changes?')) return;
  const path = prompt('Path of the new file', 'kubernetes/oke/app.sops.yaml')?.trim();
  if (!path) return;
  await run(`Creating ${path}`, async () => {
    const recipients = await Promise.all(identities().map(identityToRecipient));
    const ctx = await newContext(path, await sopsConfig(), recipients);
    const name = path
      .split('/')
      .pop()
      .replace(/\.sops\.ya?ml$/, '');
    const plain = `apiVersion: v1\nkind: Secret\nmetadata:\n${' '.repeat(ctx.indent)}name: ${name}\nstringData:\n${' '.repeat(ctx.indent)}KEY: value\n`;
    open = { path, sha: undefined, ctx, plain: '', isNew: true };
    showEditor();
    $('text').value = plain;
    status(`New file, encrypted to ${recipients.join(', ')}`);
  });
}

async function save() {
  if (!open) return;
  await run('Encrypting', async () => {
    const plain = $('text').value;
    const text = await encrypt(plain, open.ctx);
    const check = await decrypt(text, identities());
    const json = (t) => JSON.stringify(parseDocument(t).toJS());
    if (json(check.plain) !== json(plain)) throw new Error('round-trip check failed, not committing');
    status('Committing…');
    const created = await gh.ensureBranch(branch);
    const { sha, url } = await gh.write(
      open.path,
      branch,
      text,
      open.sha,
      $('message').value.trim() || $('message').placeholder,
    );
    open = { path: open.path, sha, ctx: check.ctx, plain };
    if (!files.includes(open.path)) files = [...files, open.path].sort();
    showEditor();
    $('commit-link').href = url;
    $('commit-link').hidden = false;
    status(created ? `Committed to new branch ${branch}` : `Committed to ${branch}`);
  });
}

$('token').value = store.get('token');
$('repo').value = store.get('repo') || 'pl4nty/homelab';
$('branch').value = store.get('branch');
$('key').value = store.get('key');
$('remember-key').checked = !!store.get('key');

$('settings-toggle').onclick = () => {
  $('settings').hidden = !$('settings').hidden;
};
$('settings').onsubmit = (e) => {
  e.preventDefault();
  run('Connecting', connect);
};
$('filter').oninput = renderFiles;
$('new').onclick = newFile;
$('save').onclick = save;
$('revert').onclick = () => {
  if (open) $('text').value = open.plain;
};
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (dirty()) e.preventDefault();
});

if ($('token').value) run('Connecting', connect);
else $('settings').hidden = false;

import { checkConfig, names as checkNames } from './hardening.js';
import { Kconfig, TRI_STR } from './kconfig.js';
import manifest from './trees.json';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const present = (children) => children.flat(Infinity).filter((c) => c != null && c !== false);
const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...present(children));
  return e;
};
const NUMBER = /^[nmy]$|^-?(0x)?[0-9a-f]+$/i;
const HARDENING = ':hardening';

const PREC = { '|': 1, '&': 2, '!': 3, C: 5 };
const OPS = { '&': ' && ', '|': ' || ' };

let tree;
let arch;
let kconf;
let index;
let baseline = [];
let baselineText = '';
let current = null;
let names;
let hardened = null;
let failuresOnly = true;
let pendingUrl = new URLSearchParams(location.search).get('config');

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).json();
}

const dataUrl = (path) => `data/${tree.id}/${path}?h=${tree.hash[arch]}`;
const storeKey = () => `kconfig:${tree.id}/${arch}`;

function status(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function prompt(s) {
  return kconf.symNodes[s].find((n) => n.p !== undefined)?.p ?? '';
}

function buildIndex() {
  index = [];
  kconf.syms.forEach((sym, s) => {
    if (sym.k) return;
    index.push({
      s,
      name: sym.n.toLowerCase(),
      prompt: prompt(s).toLowerCase(),
      help: kconf.symNodes[s]
        .map((n) => n.h ?? '')
        .join('\n')
        .toLowerCase(),
    });
  });
}

function search(query) {
  const q = query
    .trim()
    .toLowerCase()
    .replace(/^config_/, '');
  const changed = $('changed').checked;
  const words = q.split(/\s+/).filter(Boolean);
  const hits = [];
  for (const entry of index) {
    if (changed && kconf.user[entry.s] === baseline[entry.s]) continue;
    let score = 5;
    if (!words.length) score = 0;
    else if (entry.name === q) score = 0;
    else if (entry.name.startsWith(q)) score = 1;
    else if (entry.name.includes(q)) score = 2;
    else if (words.every((w) => entry.name.includes(w) || entry.prompt.includes(w))) score = 3;
    else if (words.every((w) => entry.name.includes(w) || entry.prompt.includes(w) || entry.help.includes(w)))
      score = 4;
    if (score < 5) hits.push([score, entry]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
  return hits;
}

function valueBadge(s) {
  const sym = kconf.syms[s];
  const val = kconf.str(s);
  const tri = sym.t === 'bool' || sym.t === 'tristate';
  const cls = tri ? `v-${val}` : 'v-str';
  const badge = el('span', { className: `badge ${cls}`, textContent: tri ? val : val || '""' });
  if (!sym.k && !kconf.vis(s)) badge.classList.add('locked');
  return badge;
}

function renderResults() {
  const list = $('results');
  const hits = search($('search').value);
  list.replaceChildren(
    ...hits.slice(0, 300).map(([, { s }]) => {
      const sym = kconf.syms[s];
      return el(
        'li',
        {},
        el(
          'button',
          {
            type: 'button',
            className: s === current ? 'active' : '',
            onclick: () => navigate(sym.n),
          },
          el('code', { textContent: sym.n }),
          valueBadge(s),
          el('span', { className: 'prompt', textContent: prompt(s) }),
        ),
      );
    }),
  );
  if (hits.length > 300) list.append(el('li', { className: 'more', textContent: `${hits.length - 300} more` }));
  if (!hits.length) list.append(el('li', { className: 'more', textContent: 'No matches' }));
}

function symLink(s) {
  const sym = kconf.syms[s];
  if (sym.k === 'const' || (sym.k === 'undef' && NUMBER.test(sym.n))) {
    return el('span', { className: 'const', textContent: NUMBER.test(sym.n) ? sym.n : `"${sym.n}"` });
  }
  if (sym.k === 'undef')
    return el('span', { className: 'undef', title: 'Not defined in this tree', textContent: sym.n });
  return el(
    'span',
    { className: 'ref' },
    el('a', { href: `#${tree.id}/${arch}/${sym.n}`, textContent: sym.n }),
    valueBadge(s),
  );
}

function renderExpr(ref, min = 0) {
  if (ref >= 0) return symLink(ref);
  const e = kconf.exprs[-1 - ref];
  const prec = PREC[e[0]] ?? 4;
  let parts;
  if (e[0] === 'C') parts = [el('span', { className: 'const', textContent: '<choice>' })];
  else if (e[0] === '!') parts = ['!', renderExpr(e[1], 3)];
  else if (OPS[e[0]]) parts = [renderExpr(e[1], prec), OPS[e[0]], renderExpr(e[2], prec)];
  else parts = [renderExpr(e[1], 5), ` ${e[0]} `, renderExpr(e[2], 5)];
  return prec < min ? el('span', {}, '(', parts, ')') : el('span', {}, parts);
}

function exprBlock(ref) {
  const v = kconf.ev(ref);
  return el(
    'div',
    { className: 'expr' },
    renderExpr(ref),
    el('span', { className: `result v-${TRI_STR[v]}`, textContent: ` → ${TRI_STR[v]}` }),
  );
}

function splitOr(ref) {
  if (ref < 0 && kconf.exprs[-1 - ref][0] === '|') {
    const e = kconf.exprs[-1 - ref];
    return [...splitOr(e[1]), ...splitOr(e[2])];
  }
  return kconf.syms[ref]?.k === 'const' && kconf.ev(ref) === 0 ? [] : [ref];
}

const isY = (ref) => ref >= 0 && kconf.syms[ref].k === 'const' && kconf.syms[ref].n === 'y';

function section(title, ...body) {
  const items = body.flat().filter(Boolean);
  return items.length ? el('section', {}, el('h3', { textContent: title }), items) : null;
}

function ownCond(s, cond) {
  const deps = new Set(kconf.symNodes[s].map((n) => n.d));
  if (deps.has(cond)) return null;
  const e = cond < 0 && kconf.exprs[-1 - cond];
  return e && e[0] === '&' && deps.has(e[2]) ? e[1] : cond;
}

function condList(s, pairs, first) {
  let active = !first;
  return pairs.map(([target, full]) => {
    const cond = ownCond(s, full);
    const on = kconf.ev(full) > 0;
    const mark = first && on && !active;
    if (mark) active = true;
    return el(
      'div',
      { className: `pair${mark ? ' chosen' : ''}${on ? '' : ' off'}` },
      ...(target === null ? [] : [renderExpr(target)]),
      cond === null || isY(cond) ? null : el('span', { className: 'if' }, ' if ', renderExpr(cond)),
    );
  });
}

function controls(s) {
  const sym = kconf.syms[s];
  const user = kconf.user[s];
  const reset = el('button', {
    type: 'button',
    textContent: 'Unset',
    disabled: user === undefined,
    onclick: () => change(() => kconf.unsetValue(s)),
  });
  if (sym.t === 'bool' || sym.t === 'tristate') {
    const allowed = new Set(kconf.assignable(s));
    const val = kconf.tri(s);
    const values = sym.t === 'bool' || kconf.type(s) === 'bool' ? [0, 2] : [0, 1, 2];
    return el(
      'div',
      { className: 'controls', role: 'radiogroup', ariaLabel: 'Value' },
      values.map((v) =>
        el('button', {
          type: 'button',
          role: 'radio',
          ariaChecked: String(val === v),
          className: `tri v-${TRI_STR[v]}${val === v ? ' on' : ''}`,
          textContent: TRI_STR[v],
          disabled: !allowed.has(v),
          onclick: () => change(() => kconf.setValue(s, v)),
        }),
      ),
      reset,
    );
  }
  const input = el('input', {
    value: kconf.str(s),
    disabled: !kconf.vis(s),
    spellcheck: false,
    ariaLabel: 'Value',
  });
  const set = el('button', {
    type: 'button',
    className: 'primary',
    textContent: 'Set',
    disabled: !kconf.vis(s),
    onclick: () => {
      if (!change(() => kconf.setValue(s, input.value))) status(`${input.value} is not a valid ${sym.t}`, true);
    },
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && set.click());
  return el('div', { className: 'controls' }, input, set, reset);
}

async function availability(name) {
  names ??= await fetchJson(`data/names.json.gz?h=${manifest.names}`);
  const have = new Set((names.names[name] ?? []).map((i) => names.keys[i]));
  return manifest.trees.map((t) =>
    el(
      'span',
      { className: 'trees' },
      el('strong', { textContent: t.name }),
      t.arches.map((a) => {
        const key = `${t.id}/${a}`;
        if (!have.has(key)) return el('span', { className: 'chip missing', textContent: a });
        return el('a', {
          className: `chip${t === tree && a === arch ? ' here' : ''}`,
          href: `#${key}/${name}`,
          textContent: a,
        });
      }),
    ),
  );
}

function hardening() {
  hardened ??= checkConfig(manifest.hardening, kconf.write());
  return hardened;
}

function optLink(name) {
  const bare = name.replace(/^CONFIG_/, '');
  const s = kconf.byName.get(bare);
  return s === undefined
    ? el('span', { className: 'undef', title: 'Not defined in this tree', textContent: bare })
    : symLink(s);
}

function expected(e) {
  if (e === 'is not set' || e === 'is present' || e === 'is not off') return ` ${e}`;
  if (e.startsWith('*') && e.endsWith('*')) return ` contains "${e.slice(1, -1)}"`;
  return ` = ${e}`;
}

function renderCheck(check, nested = false) {
  if (check.v) return el('span', { className: 'const', textContent: `kernel >= ${check.v.join('.')}` });
  if (!check.opts) return el('span', {}, optLink(check.n), expected(check.e));
  const parts = check.opts.map((o, i) => [i ? (check.op === 'or' ? ' || ' : ' && ') : null, renderCheck(o, true)]);
  return el('span', {}, nested ? ['(', parts, ')'] : parts);
}

function checkRow(r) {
  return el(
    'div',
    { className: 'khc' },
    el('span', { className: `badge ${r.ok ? 'v-y' : 'v-fail'}`, textContent: r.ok ? 'OK' : 'FAIL' }),
    el(
      'div',
      {},
      el('div', { className: 'expr' }, renderCheck(r.check)),
      el('div', { className: 'why', textContent: `${r.decision} · ${r.reason} · ${r.result}` }),
    ),
  );
}

function renderHardening() {
  const h = hardening();
  const detail = $('detail');
  const title = el('div', { className: 'title' }, el('h2', { textContent: 'Hardening' }));
  const source = el(
    'p',
    {},
    'Checks from ',
    el('a', {
      href: 'https://github.com/a13xp0p0v/kernel-hardening-checker',
      target: '_blank',
      rel: 'noopener',
      textContent: `kernel-hardening-checker ${manifest.hardening.version}`,
    }),
    ', run against the current .config.',
  );
  if (h.error) {
    detail.replaceChildren(
      title,
      source,
      el('p', { className: 'note', textContent: `Can't check this config: ${h.error}.` }),
    );
    return;
  }
  const fails = h.results.filter((r) => !r.ok).length;
  const only = el('input', {
    type: 'checkbox',
    checked: failuresOnly,
    onchange: () => {
      failuresOnly = only.checked;
      renderHardening();
    },
  });
  detail.replaceChildren(
    title,
    source,
    el(
      'p',
      { className: 'row' },
      el('span', { className: 'badge v-y', textContent: `${h.results.length - fails} OK` }),
      el('span', { className: 'badge v-fail', textContent: `${fails} FAIL` }),
      el('label', { className: 'check' }, only, 'Failures only'),
    ),
    ...h.results.filter((r) => !failuresOnly || !r.ok).map(checkRow),
  );
}

function renderDetail() {
  const detail = $('detail');
  if (current === HARDENING) {
    renderHardening();
    return;
  }
  if (current === null) {
    detail.replaceChildren(
      el(
        'div',
        { className: 'empty' },
        el('p', {
          textContent: `${tree.name} (${tree.version}) for ${arch}, ${index.length.toLocaleString()} symbols.`,
        }),
        el('p', {
          textContent: 'Search for a symbol, pick a defconfig to start from, then download the .config or defconfig.',
        }),
        el('p', {}, el('a', { href: `#${tree.id}/${arch}/${HARDENING}`, textContent: 'Check hardening' })),
      ),
    );
    return;
  }
  const s = current;
  const sym = kconf.syms[s];
  const nodes = kconf.symNodes[s];
  const choice = sym.ch !== undefined ? kconf.choices[sym.ch] : null;
  const vis = kconf.vis(s);
  const where = nodes.map((n) =>
    el('a', {
      href: `${tree.repo}/blob/${tree.commit}/${n.f}#L${n.l}`,
      target: '_blank',
      rel: 'noopener',
      textContent: `${n.f}:${n.l}`,
    }),
  );
  const promptConds = nodes.filter((n) => n.p !== undefined && n.pc !== sym.d).map((n) => exprBlock(n.pc));
  const selected = splitOr(sym.r).sort((a, b) => kconf.ev(b) - kconf.ev(a));
  const implied = splitOr(sym.w).sort((a, b) => kconf.ev(b) - kconf.ev(a));
  const checks = (hardening().results ?? []).filter((r) => checkNames(r.check).includes(`CONFIG_${sym.n}`));
  const avail = el('div', { className: 'avail' }, 'Loading…');
  availability(sym.n).then(
    (chips) => avail.replaceChildren(...chips),
    (e) => avail.replaceChildren(String(e)),
  );
  detail.replaceChildren(
    ...present([
      el(
        'div',
        { className: 'title' },
        el('h2', { textContent: `CONFIG_${sym.n}` }),
        valueBadge(s),
        el('span', { className: 'type', textContent: sym.t || 'untyped' }),
        kconf.user[s] !== baseline[s] ? el('span', { className: 'type changed', textContent: 'changed' }) : null,
        sym.tr ? el('span', { className: 'type', textContent: 'transitional' }) : null,
      ),
      el('p', { className: 'prompt', textContent: prompt(s) || '(no prompt: set only by defaults, select or imply)' }),
      controls(s),
      vis ? null : el('p', { className: 'note', textContent: 'Not user-settable now: no prompt is visible.' }),
      el('div', { className: 'where' }, where),
      section(
        'Help',
        nodes.filter((n) => n.h).map((n) => el('pre', { className: 'help', textContent: n.h })),
      ),
      section('Depends on', isY(sym.d) ? null : exprBlock(sym.d)),
      section('Prompt visible if', promptConds),
      choice
        ? section(
            `Choice: ${kconf.choiceNodes[sym.ch].find((n) => n.p)?.p ?? choice.n ?? ''}`,
            choice.sy.map((c) =>
              el('div', { className: `pair${kconf.choiceSel(sym.ch) === c ? ' chosen' : ''}` }, symLink(c)),
            ),
          )
        : null,
      section(
        'Selected by',
        selected.map((r) => exprBlock(r)),
      ),
      section(
        'Implied by',
        implied.map((r) => exprBlock(r)),
      ),
      section('Defaults', condList(s, sym.df ?? [], true)),
      section(
        'Range',
        (sym.rg ?? []).map(([lo, hi, c]) =>
          el(
            'div',
            { className: `pair${kconf.ev(c) ? '' : ' off'}` },
            renderExpr(lo),
            ' – ',
            renderExpr(hi),
            isY(c) ? null : el('span', { className: 'if' }, ' if ', renderExpr(c)),
          ),
        ),
      ),
      section('Selects', condList(s, sym.sel ?? [], false)),
      section('Implies', condList(s, sym.imp ?? [], false)),
      section('Hardening', checks.map(checkRow)),
      section('Available in', avail),
    ]),
  );
}

function persist() {
  hardened = null;
  store.set(storeKey(), { baseline: baselineText, config: kconf.minConfig() });
}

function change(fn) {
  const ok = fn();
  persist();
  renderAll();
  return ok !== false;
}

function renderAll() {
  const changed = kconf.syms.filter((sym, s) => !sym.k && kconf.user[s] !== baseline[s]).length;
  $('changed-count').textContent = changed ? `(${changed})` : '';
  renderResults();
  renderDetail();
}

function startFrom(text) {
  const missing = kconf.load(text);
  baseline = kconf.user.slice();
  baselineText = kconf.minConfig();
  persist();
  renderAll();
  return missing;
}

async function readConfig(blob) {
  const magic = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gzip = magic[0] === 0x1f && magic[1] === 0x8b;
  return new Response(gzip ? blob.stream().pipeThrough(new DecompressionStream('gzip')) : blob).text();
}

function rawUrl(url) {
  const u = new URL(url);
  const gh = u.hostname === 'github.com' && /^\/([^/]+\/[^/]+)\/(?:blob|raw)\/(.+)$/.exec(u.pathname);
  if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}`;
  u.pathname = u.pathname.replace('/-/blob/', '/-/raw/');
  return u.href;
}

function loaded(name, missing) {
  status(`Loaded ${name}${missing.length ? `, ${missing.length} symbols not in this tree` : ''}`);
}

async function loadUrl(url) {
  const src = rawUrl(url);
  let res;
  try {
    res = await fetch(src);
  } catch {
    throw new Error(`Couldn't fetch ${src}: the server may not allow cross-origin requests`);
  }
  if (!res.ok) throw new Error(`${src}: ${res.status}`);
  loaded(src, startFrom(await readConfig(await res.blob())));
}

async function fetchConfig(name) {
  const res = await fetch(dataUrl(`${arch}/configs/${name}`));
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res.text();
}

function download(name, text) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

function fillSelect(select, options, placeholder) {
  select.replaceChildren(
    ...(placeholder ? [el('option', { value: '', textContent: placeholder })] : []),
    ...options.map(([value, label]) => el('option', { value, textContent: label })),
  );
}

async function open(treeId, archId) {
  const next = manifest.trees.find((t) => t.id === treeId) ?? manifest.trees[0];
  const nextArch = next.arches.includes(archId) ? archId : next.arches[0];
  if (kconf && next === tree && nextArch === arch) return;
  tree = next;
  arch = nextArch;
  $('tree').value = tree.id;
  fillSelect(
    $('arch'),
    tree.arches.map((a) => [a, a]),
  );
  $('arch').value = arch;
  const configs = tree.configs[arch];
  fillSelect($('base'), [
    ['', 'alldefconfig (defaults only)'],
    ...configs.filter((c) => c.endsWith('defconfig')).map((c) => [c, c]),
  ]);
  fillSelect(
    $('fragment'),
    configs.filter((c) => c.endsWith('.config')).map((c) => [c, c]),
    configs.some((c) => c.endsWith('.config')) ? 'choose…' : 'none',
  );
  status(`Loading ${tree.name} ${arch}…`);
  $('toolbar').inert = true;
  kconf = null;
  hardened = null;
  const db = await fetchJson(dataUrl(`${arch}.json.gz`));
  kconf = new Kconfig(db);
  $('toolbar').inert = false;
  buildIndex();
  const saved = store.get(storeKey());
  baselineText = saved?.baseline ?? '';
  kconf.load(baselineText);
  baseline = kconf.user.slice();
  if (saved) kconf.load(saved.config);
  status(`${tree.name} · ${tree.version} · ${arch} · ${tree.commit.slice(0, 12)}`);
}

function navigate(name) {
  location.hash = `${tree.id}/${arch}/${name}`;
}

const here = () => (current === null || current === HARDENING ? (current ?? '') : kconf.syms[current].n);

async function route() {
  const [treeId, archId, name] = decodeURIComponent(location.hash.slice(1)).split('/');
  try {
    await open(treeId, archId);
  } catch (e) {
    status(String(e), true);
    return;
  }
  const s = name && name !== HARDENING ? kconf.byName.get(name.replace(/^CONFIG_/, '')) : undefined;
  current = name === HARDENING ? HARDENING : (s ?? null);
  if (name && current === null) status(`${name} is not defined in ${tree.name} ${arch}`, true);
  if (pendingUrl) {
    const url = pendingUrl;
    pendingUrl = null;
    history.replaceState(null, '', location.pathname + location.hash);
    $('url').value = url;
    try {
      await loadUrl(url);
    } catch (e) {
      status(String(e), true);
    }
  }
  renderAll();
  if (current !== null) $('detail').scrollTop = 0;
}

fillSelect(
  $('tree'),
  manifest.trees.map((t) => [t.id, t.name]),
);
$('tree').addEventListener('change', () => {
  location.hash = `${$('tree').value}/${arch}/${here()}`;
});
$('arch').addEventListener('change', () => {
  location.hash = `${tree.id}/${$('arch').value}/${here()}`;
});
let timer;
$('search').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => kconf && renderResults(), 80);
});
$('changed').addEventListener('change', () => kconf && renderResults());
$('base').addEventListener('change', async () => {
  const name = $('base').value;
  try {
    startFrom(name ? await fetchConfig(name) : '');
    status(`Started from ${name || 'alldefconfig'}`);
  } catch (e) {
    status(String(e), true);
  }
});
$('fragment').addEventListener('change', async () => {
  const name = $('fragment').value;
  if (!name) return;
  try {
    kconf.load(await fetchConfig(name), false);
    persist();
    renderAll();
    status(`Applied ${name}`);
  } catch (e) {
    status(String(e), true);
  }
  $('fragment').value = '';
});
$('upload').addEventListener('change', async () => {
  const file = $('upload').files[0];
  if (!file) return;
  loaded(file.name, startFrom(await readConfig(file)));
  $('upload').value = '';
});
$('url-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await loadUrl($('url').value);
  } catch (err) {
    status(String(err), true);
  }
});
$('hardening').addEventListener('click', () => navigate(HARDENING));
$('reset').addEventListener('click', () => {
  $('base').value = '';
  startFrom('');
  status('Reset to alldefconfig');
});
$('save-config').addEventListener('click', () => download('.config', kconf.write()));
$('save-defconfig').addEventListener('click', () => download('defconfig', kconf.minConfig()));
addEventListener('hashchange', route);
route();

const ARCHES = ['X86_64', 'X86_32', 'ARM64', 'ARM', 'RISCV'];
const REFINE = ['CONFIG_ARCH_MMAP_RND_BITS', 'CONFIG_ARCH_MMAP_RND_COMPAT_BITS'];

export function parseConfig(text) {
  const options = new Map();
  let arch = null;
  let multiple = false;
  let version = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const on = /^CONFIG_[a-zA-Z0-9_]+=.*$/.test(line);
    if (on) {
      const i = line.indexOf('=');
      options.set(line.slice(0, i), line.slice(i + 1));
    } else if (/^# CONFIG_[a-zA-Z0-9_]+ is not set$/.test(line)) {
      options.set(line.slice(2).split(' ', 1)[0], 'is not set');
    }
    const a = /^CONFIG_([A-Z0-9_]+)=y$/.exec(raw);
    if (a && ARCHES.includes(a[1])) {
      if (arch) multiple = true;
      arch = a[1];
    }
    if (!version && /^# Linux\/.+ Kernel Configuration$/.test(line)) {
      const numbers = line.split(/\s+/)[2].replace('+', '-').split('-', 1)[0].split('.');
      if (numbers.length >= 3 && numbers.every((x) => /^\d+$/.test(x))) version = numbers.slice(0, 3).map(Number);
    }
  }
  return { options, arch: multiple ? null : arch, version };
}

const tuple = (v) => `(${v.join(', ')})`;

function simple(check, options) {
  const state = options.get(check.n) ?? null;
  const e = check.e;
  if (e.startsWith('*') && e.endsWith('*')) {
    if (state === null) return 'FAIL: is not found';
    return state
      .replace(/^"+|"+$/g, '')
      .split(',')
      .includes(e.replace(/^\*+|\*+$/g, ''))
      ? `OK: in ${state}`
      : `FAIL: not in ${state}`;
  }
  if (e === 'is present') return state === null ? 'FAIL: is not present' : 'OK: is present';
  if (e === 'is not off') {
    if (state === null) return 'FAIL: is off, not found';
    if (state === 'off') return 'FAIL: is off';
    if (
      state
        .replace(/^"+|"+$/g, '')
        .split(',')
        .includes('off') ||
      state === '0' ||
      state === 'is not set'
    )
      return `FAIL: is off (${state})`;
    return `OK: is not off (${state})`;
  }
  if (e === state) return 'OK';
  if (state === null) return e === 'is not set' ? 'OK: is not found' : 'FAIL: is not found';
  return `FAIL: "${state}"`;
}

function versionCheck(check, version) {
  const [a, b, c] = version;
  const [x, y, z] = check.v;
  const ok = a !== x ? a > x : b !== y ? b > y : c >= z;
  return ok ? `OK: version >= ${tuple(check.v)}` : `FAIL: version < ${tuple(check.v)}`;
}

export const first = (check) => (check.opts ? first(check.opts[0]) : check);

function run(check, ctx) {
  if (check.v) return versionCheck(check, ctx.version);
  if (!check.opts) return simple(check, ctx.options);
  if (check.op === 'or') {
    for (const [i, opt] of check.opts.entries()) {
      const r = run(opt, ctx);
      if (!r.startsWith('OK')) continue;
      if (i === 0 || opt.v) return r;
      const name = first(opt).n;
      const expected = first(opt).e;
      if (r === 'OK') return `OK: ${name} is "${expected}"`;
      if (r.startsWith('OK: in ')) return `OK: "${expected.replace(/^\*+|\*+$/g, '')}" is in ${name}`;
      if (r === 'OK: is not found') return `OK: ${name} is not found`;
      if (r === 'OK: is present') return `OK: ${name} is present`;
      return `OK: ${name} is not off`;
    }
    return run(check.opts[0], ctx);
  }
  for (let i = check.opts.length - 1; i > 0; i--) {
    const opt = check.opts[i];
    const r = run(opt, ctx);
    if (r.startsWith('OK')) continue;
    if (opt.v) return r;
    const { n, e } = first(opt);
    if (r.startsWith('FAIL: "') || r === 'FAIL: is not found') return `FAIL: ${n} is not "${e}"`;
    if (r.startsWith('FAIL: not in ')) return `FAIL: "${e.replace(/^\*+|\*+$/g, '')}" is not in ${n}`;
    if (r === 'FAIL: is not present') return `FAIL: ${n} is not present`;
    if (r === 'FAIL: is off' || r.startsWith('FAIL: is off (')) return `FAIL: ${n} is off`;
    return `FAIL: ${n} is off, not found`;
  }
  return run(check.opts[0], ctx);
}

export function names(check) {
  if (check.v) return [];
  return check.opts ? check.opts.flatMap(names) : [check.n];
}

export function checkConfig(hardening, text) {
  const { options, arch, version } = parseConfig(text);
  if (!arch) return { error: 'no single architecture (CONFIG_ARM64, CONFIG_X86_64, …) is set' };
  if (!version) return { error: 'no kernel version in the config header' };
  let checks = structuredClone(hardening.checks[arch]);
  for (const target of REFINE) {
    const source = options.get(`${target}_MAX`);
    if (source) {
      for (const check of checks) {
        if (first(check).n !== target) continue;
        if (check.opts) for (const o of check.opts) if (o.n === target) o.e = source;
        if (!check.opts) check.e = source;
      }
    } else {
      checks = checks.filter((c) => first(c).n !== target);
    }
  }
  const ctx = { options, version };
  return {
    arch,
    version,
    results: checks.map((check) => {
      const result = run(check, ctx);
      const { n, r, d } = first(check);
      return { check, name: n, reason: r, decision: d, result, ok: result.startsWith('OK') };
    }),
  };
}

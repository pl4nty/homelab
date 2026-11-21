const TRI = { n: 0, m: 1, y: 2 };
export const TRI_STR = ['n', 'm', 'y'];
const BOOL_TRI = new Set(['bool', 'tristate']);

const BASE_RE = {
  0: /^[+-]?(0[xX]_?[0-9a-fA-F]+(_[0-9a-fA-F]+)*|0[oO]_?[0-7]+(_[0-7]+)*|0[bB]_?[01]+(_[01]+)*|[1-9]\d*(_\d+)*|0+(_0+)*)$/,
  10: /^[+-]?\d+(_\d+)*$/,
  16: /^[+-]?(0[xX]_?)?[0-9a-fA-F]+(_[0-9a-fA-F]+)*$/,
};

export function parseNum(s, base) {
  const t = s.trim();
  if (!BASE_RE[base].test(t)) return null;
  const neg = t[0] === '-';
  let digits = t.replace(/^[+-]/, '').replaceAll('_', '');
  let prefix = base === 16 ? '0x' : '';
  if (/^0[xob]/i.test(digits) && (base === 0 || base === 16)) {
    prefix = digits.slice(0, 2).toLowerCase();
    digits = digits.slice(2);
  }
  const n = BigInt(prefix + digits);
  return neg ? -n : n;
}

const pyHex = (n) => (n < 0n ? `-0x${(-n).toString(16)}` : `0x${n.toString(16)}`);
const strcmp = (a, b) => (a > b) - (a < b);
const escapeStr = (s) => s.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
const unescapeStr = (s) => s.replace(/\\(.)/g, '$1');
const BASE = { int: 10, hex: 16 };

export class Kconfig {
  constructor(db) {
    this.db = db;
    this.syms = db.syms;
    this.exprs = db.exprs;
    this.choices = db.choices;
    this.modules = db.modules;
    this.byName = new Map();
    this.syms.forEach((s, i) => {
      if (!s.k) this.byName.set(s.n, i);
    });
    this.symNodes = this.syms.map(() => []);
    this.choiceNodes = this.choices.map(() => []);
    this.nodes = [];
    const walk = (node, parent) => {
      node.parent = parent;
      node.id = this.nodes.length;
      this.nodes.push(node);
      if (node.s !== undefined) this.symNodes[node.s].push(node);
      if (node.c !== undefined) this.choiceNodes[node.c].push(node);
      const ch = node.ch ?? [];
      ch.forEach((c, i) => {
        walk(c, node);
        c.next = ch[i + 1];
      });
    };
    walk(db.top, undefined);
    this.user = new Array(this.syms.length);
    this.choiceUser = this.choices.map(() => ({}));
    this.invalidate();
  }

  invalidate() {
    const n = this.syms.length;
    this.cTri = new Array(n);
    this.cStr = new Array(n);
    this.cVis = new Array(n);
    this.cWrite = new Array(n);
    this.cChoiceTri = new Array(this.choices.length);
    this.cChoiceVis = new Array(this.choices.length);
    this.cChoiceSel = new Array(this.choices.length);
  }

  origType(s) {
    const sym = this.syms[s];
    if (sym.k === 'const') return sym.n in TRI ? 'tristate' : '';
    return sym.t ?? '';
  }

  type(s) {
    const sym = this.syms[s];
    const t = this.origType(s);
    if (t === 'tristate' && ((sym.ch !== undefined && this.choiceTri(sym.ch) === 2) || !this.modulesOn()))
      return 'bool';
    return t;
  }

  modulesOn() {
    return this.modules != null && this.tri(this.modules) !== 0;
  }

  ev(ref) {
    if (ref >= 0) return this.tri(ref);
    const e = this.exprs[-1 - ref];
    switch (e[0]) {
      case '&': {
        const v = this.ev(e[1]);
        return v ? Math.min(v, this.ev(e[2])) : 0;
      }
      case '|': {
        const v = this.ev(e[1]);
        return v === 2 ? 2 : Math.max(v, this.ev(e[2]));
      }
      case '!':
        return 2 - this.ev(e[1]);
      case 'C':
        return this.choiceTri(e[1]);
    }
    const comp = this.compare(e[1], e[2]);
    switch (e[0]) {
      case '=':
        return comp === 0 ? 2 : 0;
      case '!=':
        return comp !== 0 ? 2 : 0;
      case '<':
        return comp < 0 ? 2 : 0;
      case '<=':
        return comp <= 0 ? 2 : 0;
      case '>':
        return comp > 0 ? 2 : 0;
      case '>=':
        return comp >= 0 ? 2 : 0;
    }
    throw new Error(`unknown operator ${e[0]}`);
  }

  compare(a, b) {
    if (this.origType(a) === 'string' && this.origType(b) === 'string') return strcmp(this.str(a), this.str(b));
    const x = this.toNum(a);
    const y = this.toNum(b);
    if (x === null || y === null) return strcmp(this.str(a), this.str(b));
    return x < y ? -1 : x > y ? 1 : 0;
  }

  toNum(s) {
    const t = this.origType(s);
    if (BOOL_TRI.has(t)) return BigInt(this.tri(s));
    return parseNum(this.str(s), BASE[t] ?? 0);
  }

  strOf(ref) {
    return ref >= 0 ? this.str(ref) : TRI_STR[this.ev(ref)];
  }

  vis(s) {
    if (this.cVis[s] !== undefined) return this.cVis[s];
    const sym = this.syms[s];
    let vis = 0;
    if (sym.tr) {
      vis = 2;
    } else {
      for (const node of this.symNodes[s]) if (node.p !== undefined) vis = Math.max(vis, this.ev(node.pc));
      const t = this.origType(s);
      if (sym.ch !== undefined) {
        const choice = this.choices[sym.ch];
        if (
          (choice.t === 'tristate' && t !== 'tristate' && this.choiceTri(sym.ch) !== 2) ||
          (t === 'tristate' && vis === 1 && this.choiceTri(sym.ch) === 2)
        )
          vis = -1;
      }
      if (vis === -1) vis = 0;
      else if (vis === 1 && this.type(s) !== 'tristate') vis = 2;
    }
    this.cVis[s] = vis;
    return vis;
  }

  tri(s) {
    if (this.cTri[s] !== undefined) return this.cTri[s];
    const sym = this.syms[s];
    if (sym.k === 'const') return TRI[sym.n] ?? 0;
    if (!BOOL_TRI.has(sym.t)) {
      this.cTri[s] = 0;
      return 0;
    }
    const vis = this.vis(s);
    let write = vis !== 0;
    let val = 0;
    const user = this.user[s];
    if (sym.ch === undefined) {
      if (vis && user !== undefined) {
        val = Math.min(user, vis);
      } else {
        for (const [d, c] of sym.df ?? []) {
          const dv = this.ev(c);
          if (dv) {
            val = Math.min(this.ev(d), dv);
            if (val) write = true;
            break;
          }
        }
        const wv = this.ev(sym.w);
        if (wv && this.ev(sym.d)) {
          val = Math.max(wv, val);
          write = true;
        }
      }
      const rv = this.ev(sym.r);
      if (rv) {
        val = Math.max(rv, val);
        write = true;
      }
      if (val === 1 && (this.type(s) === 'bool' || this.ev(sym.w) === 2)) val = 2;
    } else if (vis === 2) {
      val = this.choiceSel(sym.ch) === s ? 2 : 0;
    } else if (vis && user) {
      val = 1;
    }
    this.cTri[s] = val;
    this.cWrite[s] = write;
    return val;
  }

  str(s) {
    if (this.cStr[s] !== undefined) return this.cStr[s];
    const sym = this.syms[s];
    if (sym.k) return sym.n;
    const t = sym.t;
    if (BOOL_TRI.has(t)) return TRI_STR[this.tri(s)];
    if (!t) return sym.n;
    let val = '';
    const vis = this.vis(s);
    let write = vis !== 0;
    const user = this.user[s];
    if (t in BASE) {
      const base = BASE[t];
      let range = null;
      for (const [lo, hi, c] of sym.rg ?? []) {
        if (this.ev(c)) {
          range = [parseNum(this.strOf(lo), base) ?? 0n, parseNum(this.strOf(hi), base) ?? 0n];
          break;
        }
      }
      let useDefaults = true;
      if (vis && user) {
        const uv = parseNum(user, base);
        if (!range || (range[0] <= uv && uv <= range[1])) {
          val = user;
          useDefaults = false;
        }
      }
      if (useDefaults) {
        let num = 0n;
        for (const [d, c] of sym.df ?? []) {
          if (this.ev(c)) {
            write = true;
            val = this.strOf(d);
            num = parseNum(val, base) ?? 0n;
            break;
          }
        }
        if (range) {
          const clamp = num < range[0] ? range[0] : num > range[1] ? range[1] : null;
          if (clamp !== null) val = t === 'int' ? clamp.toString() : pyHex(clamp);
        }
      }
    } else if (t === 'string') {
      if (vis && user !== undefined) {
        val = user;
      } else {
        for (const [d, c] of sym.df ?? []) {
          if (this.ev(c)) {
            val = this.strOf(d);
            write = true;
            break;
          }
        }
      }
    }
    if (sym.env) write = false;
    this.cStr[s] = val;
    this.cWrite[s] = write;
    return val;
  }

  choiceType(c) {
    const t = this.choices[c].t;
    return t === 'tristate' && !this.modulesOn() ? 'bool' : t;
  }

  choiceVis(c) {
    if (this.cChoiceVis[c] !== undefined) return this.cChoiceVis[c];
    let vis = 0;
    for (const node of this.choiceNodes[c]) if (node.p !== undefined) vis = Math.max(vis, this.ev(node.pc));
    if (vis === 1 && this.choiceType(c) !== 'tristate') vis = 2;
    this.cChoiceVis[c] = vis;
    return vis;
  }

  choiceTri(c) {
    if (this.cChoiceTri[c] !== undefined) return this.cChoiceTri[c];
    let val = this.choices[c].o ? 0 : 1;
    const mode = this.choiceUser[c].mode;
    if (mode !== undefined) val = Math.max(val, mode);
    val = Math.min(val, this.choiceVis(c));
    if (val === 1 && this.choiceType(c) === 'bool') val = 2;
    this.cChoiceTri[c] = val;
    return val;
  }

  choiceSel(c) {
    if (this.cChoiceSel[c] !== undefined) return this.cChoiceSel[c];
    let sel = null;
    if (this.choiceTri(c) === 2) {
      const user = this.choiceUser[c].sel;
      sel = user !== undefined && this.vis(user) ? user : this.choiceDefault(c);
    }
    this.cChoiceSel[c] = sel;
    return sel;
  }

  choiceDefault(c) {
    const choice = this.choices[c];
    for (const [s, cond] of choice.df) if (this.ev(cond) && this.vis(s)) return s;
    for (const s of choice.sy) if (this.vis(s)) return s;
    return null;
  }

  assignable(s) {
    const sym = this.syms[s];
    if (!BOOL_TRI.has(sym.t)) return [];
    const vis = this.vis(s);
    if (!vis) return [];
    const rv = this.ev(sym.r);
    const boolish = this.type(s) === 'bool' || this.ev(sym.w) === 2;
    if (vis === 2) {
      if (sym.ch !== undefined) return [2];
      if (!rv) return boolish ? [0, 2] : [0, 1, 2];
      if (rv === 2) return [2];
      return boolish ? [2] : [1, 2];
    }
    if (!rv) return this.ev(sym.w) !== 2 ? [0, 1] : [0, 2];
    if (rv === 2) return [2];
    return [1];
  }

  setValue(s, value) {
    const sym = this.syms[s];
    let v = value;
    if (BOOL_TRI.has(sym.t) && v in TRI) v = TRI[v];
    const ok =
      (sym.t === 'bool' && (v === 0 || v === 2)) ||
      (sym.t === 'tristate' && (v === 0 || v === 1 || v === 2)) ||
      (typeof v === 'string' &&
        (sym.t === 'string' ||
          (sym.t === 'int' && parseNum(v, 10) !== null) ||
          (sym.t === 'hex' && parseNum(v, 16) !== null && parseNum(v, 16) >= 0n)));
    if (!ok) return false;
    this.user[s] = v;
    if (sym.ch !== undefined && v === 2) this.choiceUser[sym.ch].sel = s;
    this.invalidate();
    return true;
  }

  unsetValue(s) {
    this.user[s] = undefined;
    this.invalidate();
  }

  setChoiceMode(c, value) {
    const v = value in TRI ? TRI[value] : value;
    const t = this.choices[c].t;
    if (!((t === 'bool' && (v === 0 || v === 2)) || (t === 'tristate' && v >= 0 && v <= 2))) return false;
    this.choiceUser[c].mode = v;
    this.invalidate();
    return true;
  }

  load(text, replace = true) {
    if (replace) {
      this.user.fill(undefined);
      this.choiceUser = this.choices.map(() => ({}));
    }
    const missing = [];
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd();
      let name;
      let val;
      const set = /^CONFIG_([^=]+)=(.*)/.exec(line);
      if (set) {
        [, name, val] = set;
      } else {
        const unset = /^# CONFIG_([^ ]+) is not set/.exec(line);
        if (!unset) continue;
        name = unset[1];
        val = 'n';
      }
      const s = this.byName.get(name);
      if (s === undefined) {
        missing.push(name);
        continue;
      }
      const sym = this.syms[s];
      if (BOOL_TRI.has(sym.t)) {
        if (!(sym.t === 'bool' ? /^[yn]/ : /^[ymn]/).test(val)) continue;
        val = val[0];
        if (set && sym.ch !== undefined && val !== 'n') this.setChoiceMode(sym.ch, val);
      } else if (!set) {
        continue;
      } else if (sym.t === 'string') {
        const m = /^"((?:[^\\"]|\\.)*)"/.exec(val);
        if (!m) continue;
        val = unescapeStr(m[1]);
      }
      this.setValue(s, val);
    }
    this.invalidate();
    return missing;
  }

  configString(s) {
    const sym = this.syms[s];
    const val = this.str(s);
    if (!this.cWrite[s] || sym.tr) return '';
    if (BOOL_TRI.has(sym.t)) return val !== 'n' ? `CONFIG_${sym.n}=${val}\n` : `# CONFIG_${sym.n} is not set\n`;
    if (sym.t === 'string') return `CONFIG_${sym.n}="${escapeStr(val)}"\n`;
    return `CONFIG_${sym.n}=${val}\n`;
  }

  header() {
    return `#\n# Automatically generated file; DO NOT EDIT.\n# ${this.db.title}\n#\n`;
  }

  write(header = this.header()) {
    const chunks = [header];
    const visited = new Set();
    let after = false;
    const top = this.db.top;
    let node = top;
    for (;;) {
      if (node.ch) {
        node = node.ch[0];
      } else if (node.next) {
        node = node.next;
      } else {
        let found = false;
        while (node.parent) {
          node = node.parent;
          if (node.k === 'menu' && this.ev(node.d) && this.ev(node.v) && node !== top) {
            chunks.push(`# end of ${node.p}\n`);
            after = true;
          }
          if (node.next) {
            node = node.next;
            found = true;
            break;
          }
        }
        if (!found) return chunks.join('');
      }
      if (node.s !== undefined) {
        if (visited.has(node.s)) continue;
        visited.add(node.s);
        const cs = this.configString(node.s);
        if (!cs) continue;
        if (after) {
          after = false;
          chunks.push('\n');
        }
        chunks.push(cs);
      } else if (this.ev(node.d) && ((node.k === 'menu' && this.ev(node.v)) || node.k === 'comment')) {
        chunks.push(`\n#\n# ${node.p}\n#\n`);
        after = false;
      }
    }
  }

  strDefault(s) {
    const sym = this.syms[s];
    if (BOOL_TRI.has(sym.t)) {
      let val = 0;
      if (sym.ch === undefined) {
        for (const [d, c] of sym.df ?? []) {
          const cv = this.ev(c);
          if (cv) {
            val = Math.min(this.ev(d), cv);
            break;
          }
        }
        val = Math.max(this.ev(sym.r), this.ev(sym.w), val);
        if (val === 1 && this.type(s) === 'bool') val = 2;
      }
      return TRI_STR[val];
    }
    if (sym.t) for (const [d, c] of sym.df ?? []) if (this.ev(c)) return this.strOf(d);
    return '';
  }

  minConfig(header = '') {
    const chunks = [header];
    this.syms.forEach((sym, s) => {
      if (sym.k) return;
      if (sym.ch === undefined && this.vis(s) <= this.ev(sym.r)) return;
      if (this.str(s) === this.strDefault(s)) return;
      if (
        sym.ch !== undefined &&
        !this.choices[sym.ch].o &&
        this.choiceDefault(sym.ch) === s &&
        sym.t === 'bool' &&
        this.tri(s) === 2
      )
        return;
      chunks.push(this.configString(s));
    });
    return chunks.join('');
  }
}

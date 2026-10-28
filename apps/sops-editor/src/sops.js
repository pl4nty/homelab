// Port of the sops YAML store + AES-GCM tree cipher (github.com/getsops/sops/v3 sops.go, aes/cipher.go).
import * as age from 'age-encryption';
import { Document, isAlias, isMap, isScalar, isSeq, parseDocument, Scalar } from 'yaml';

const ENC_RE = /^ENC\[AES256_GCM,data:(.+),iv:(.+),tag:(.+),type:(.+)\]/;
const MAC_ONLY_ENCRYPTED_INIT = new Uint8Array([
  0x8a, 0x3f, 0xd2, 0xad, 0x54, 0xce, 0x66, 0x52, 0x7b, 0x10, 0x34, 0xf3, 0xd1, 0x47, 0xbe, 0xb, 0xb, 0x97, 0x5b, 0x3b,
  0xf4, 0x4f, 0x72, 0xc6, 0xfd, 0xad, 0xec, 0x81, 0x76, 0xf2, 0x7d, 0x69,
]);
const SOPS_VERSION = '3.13.3';

const TS_RE =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:(?:[Tt]|[ \t]+)(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d+))?(?:[ \t]*(Z|[-+]\d{2}:\d{2}))?)?$/;

// yaml.v3 resolves timestamps to time.Time, which sops hashes and encrypts as RFC3339Nano
export class GoTime {
  constructor(src) {
    this.src = src;
    const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '', tz = 'Z'] = TS_RE.exec(src);
    const p2 = (n) => n.padStart(2, '0');
    const f = frac.slice(0, 9).replace(/0+$/, '');
    this.text = `${y}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(s)}${f ? `.${f}` : ''}${/^[-+]00:00$/.test(tz) ? 'Z' : tz}`;
  }
  toString() {
    return this.src;
  }
}

const timestamp = {
  tag: 'tag:yaml.org,2002:timestamp',
  default: true,
  identify: (v) => v instanceof GoTime,
  test: TS_RE,
  resolve: (s) => new GoTime(s),
  stringify: ({ value }) => value.src,
};
const PARSE_OPTS = { uniqueKeys: true, customTags: [timestamp] };

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Go strconv.FormatFloat(f, 'f', -1, 64)
export function goFloat(f) {
  if (Number.isNaN(f)) return 'NaN';
  if (!Number.isFinite(f)) return f > 0 ? '+Inf' : '-Inf';
  const s = String(f);
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const [, sign, int, frac = '', e] = m;
  const exp = Number(e);
  const digits = int + frac;
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  return sign + digits.padEnd(exp + 1, '0');
}

function toPlain(v) {
  switch (v.type) {
    case 'str':
    case 'comment':
      return v.value;
    case 'int':
      return String(v.value);
    case 'float':
      return goFloat(v.value);
    case 'bool':
      return v.value ? 'True' : 'False';
    case 'time':
      return v.value.text;
  }
}

function fromPlain(type, s) {
  switch (type) {
    case 'str':
    case 'comment':
      return s;
    case 'time':
      return new GoTime(s);
    case 'int':
      return Number.parseInt(s, 10);
    case 'float':
      return s === 'NaN' ? NaN : s === '+Inf' ? Infinity : s === '-Inf' ? -Infinity : Number(s);
    case 'bool':
      if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(s)) return true;
      if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(s)) return false;
      throw new Error(`invalid bool ${s}`);
    default:
      throw new Error(`unsupported sops type ${type}`);
  }
}

async function aesKey(raw) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function decryptValue(key, s, aad) {
  const m = ENC_RE.exec(s);
  if (!m) throw new Error(`not a sops value: ${s}`);
  const [data, iv, tag] = m.slice(1, 4).map(unb64);
  const ct = new Uint8Array(data.length + tag.length);
  ct.set(data);
  ct.set(tag, data.length);
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, ct),
  );
  return { type: m[4], plain: dec.decode(pt), iv };
}

async function encryptValue(key, type, plain, aad, iv = crypto.getRandomValues(new Uint8Array(32))) {
  const out = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(plain)),
  );
  return `ENC[AES256_GCM,data:${b64(out.subarray(0, -16))},iv:${b64(iv)},tag:${b64(out.subarray(-16))},type:${type}]`;
}

function shouldBeEncrypted(meta, path) {
  let encrypted = true;
  if (meta.unencrypted_suffix && path.some((p) => p.endsWith(meta.unencrypted_suffix))) encrypted = false;
  if (meta.encrypted_suffix) encrypted = path.some((p) => p.endsWith(meta.encrypted_suffix));
  if (meta.unencrypted_regex && path.some((p) => new RegExp(meta.unencrypted_regex).test(p))) encrypted = false;
  if (meta.encrypted_regex) encrypted = path.some((p) => new RegExp(meta.encrypted_regex).test(p));
  return encrypted;
}

// sops gives scalar values Go types via yaml.v3; mirror that from the parsed node
function scalarType(node, src) {
  const v = node.value;
  if (v instanceof GoTime) return 'time';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') {
    const text = src && node.range ? src.slice(node.range[0], node.range[1]) : String(v);
    return /[.eE]|inf|nan/i.test(text) && !/^[-+]?0x/i.test(text) ? 'float' : 'int';
  }
  return 'str';
}

const COMMENT_FIELDS = ['commentBefore', 'comment'];

// Visit leaves and comments in sops tree order. fn(kind, holder, field, path) where kind is 'value' or 'comment'.
async function walk(node, path, fn) {
  if (node == null) return;
  if (isAlias(node)) throw new Error('YAML anchors/aliases are not supported');
  for (const f of COMMENT_FIELDS) if (node[f] && (isMap(node) || isSeq(node))) await fn('comment', node, f, path);
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('only string keys are supported');
      if (path.length === 0 && pair.key.value === 'sops') continue;
      for (const f of COMMENT_FIELDS) if (pair.key[f]) await fn('comment', pair.key, f, path);
      const p = [...path, pair.key.value];
      if (isScalar(pair.value)) {
        for (const f of COMMENT_FIELDS) if (pair.value[f]) await fn('comment', pair.value, f, path);
        await fn('value', pair, 'value', p);
      } else await walk(pair.value, p, fn);
    }
  } else if (isSeq(node)) {
    for (let i = 0; i < node.items.length; i++) {
      const item = node.items[i];
      if (isScalar(item)) {
        for (const f of COMMENT_FIELDS) if (item[f]) await fn('comment', item, f, path);
        await fn('value', node.items, i, path);
      } else await walk(item, path, fn);
    }
  } else if (isScalar(node)) {
    throw new Error('YAML documents that are values are not supported');
  }
}

function liftSeqComments(node) {
  if (isMap(node)) for (const p of node.items) liftSeqComments(p.value);
  if (!isSeq(node)) return;
  const pending = [];
  const items = [];
  for (const item of node.items) {
    if (item?.sopsComment !== undefined) {
      pending.push(item.sopsComment);
      continue;
    }
    if (pending.length)
      item.commentBefore = [...pending.splice(0), item.commentBefore].filter((c) => c != null).join('\n');
    liftSeqComments(item);
    items.push(item);
  }
  if (pending.length) node.comment = [node.comment, ...pending].filter((c) => c != null).join('\n');
  node.items = items;
}

async function walkDoc(doc, fn) {
  for (const f of COMMENT_FIELDS) if (doc[f]) await fn('comment', doc, f, []);
  await walk(doc.contents, [], fn);
}

function getValueNode(holder, field) {
  return field === 'value' ? holder.value : holder[field];
}

function parse(text) {
  const doc = parseDocument(text, PARSE_OPTS);
  if (doc.errors.length) throw new Error(doc.errors.map((e) => e.message).join('\n'));
  return doc;
}

function detectIndent(text) {
  const m = /^\S.*:\s*\n( +)\S/m.exec(text);
  return m ? m[1].length : 2;
}

const toStringOpts = (indent) => ({ indent, lineWidth: 0, minContentWidth: 0, flowCollectionPadding: false });

// Keeps the metadata block verbatim so saves only touch lastmodified and mac
function readMeta(doc, text, indent) {
  const pair = isMap(doc.contents) && doc.contents.items.find((p) => p.key?.value === 'sops');
  if (!pair || !isMap(pair.value)) throw new Error('not a sops file (no sops metadata)');
  const meta = pair.value.toJS(doc);
  if (meta.encrypted_comment_regex || meta.unencrypted_comment_regex)
    throw new Error('comment regexes are not supported');
  const start = text.search(/^sops:/m);
  const metaText = doc.contents.items.at(-1) === pair && start >= 0 ? text.slice(start) : metaToText(meta, indent);
  if (pair.key.commentBefore) doc.comment = [doc.comment, pair.key.commentBefore].filter((c) => c != null).join('\n');
  doc.delete('sops');
  return { meta, metaText };
}

function metaToText(meta, indent) {
  const doc = new Document({ sops: meta });
  for (const m of doc.getIn(['sops', 'age'], true)?.items ?? []) m.get('enc', true).type = Scalar.BLOCK_LITERAL;
  return doc.toString(toStringOpts(indent));
}

export function parseIdentities(text) {
  return text.match(/AGE-SECRET-KEY-(?:PQ-)?1[0-9A-Z]+/g) ?? [];
}

async function unwrapDataKey(meta, identities) {
  if (!meta.age?.length) throw new Error('file has no age recipients');
  const d = new age.Decrypter();
  for (const id of identities) d.addIdentity(id);
  const errors = [];
  for (const { enc: armored } of meta.age) {
    try {
      return await d.decrypt(age.armor.decode(armored), 'uint8array');
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(`no identity matched the file's age recipients (${errors.join('; ')})`);
}

async function sha512Hex(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }
  const h = new Uint8Array(await crypto.subtle.digest('SHA-512', buf));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

// Returns the decrypted YAML (without metadata) and the context needed to re-encrypt it.
export async function decrypt(text, identities) {
  const doc = parse(text);
  const indent = detectIndent(text);
  const { meta, metaText } = readMeta(doc, text, indent);
  const rawKey = await unwrapDataKey(meta, identities);
  const key = await aesKey(rawKey);
  const stash = new Map();
  const macChunks = meta.mac_only_encrypted ? [MAC_ONLY_ENCRYPTED_INIT] : [];

  await walkDoc(doc, async (kind, holder, field, path) => {
    if (kind === 'comment') {
      const lines = holder[field].split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('ENC[')) continue;
        let r;
        for (let n = path.length; n >= 0 && !r; n--) {
          try {
            r = await decryptValue(key, lines[i], `${path.slice(0, n).join(':')}:`);
          } catch {}
        }
        if (!r) throw new Error(`could not decrypt comment at ${path.join('.')}`);
        lines[i] = r.plain;
      }
      holder[field] = lines.join('\n');
      return;
    }
    const node = getValueNode(holder, field);
    if (node.value == null) return;
    const encrypted = shouldBeEncrypted(meta, path);
    let v;
    if (encrypted && typeof node.value === 'string' && node.value.startsWith('ENC[')) {
      const aad = `${path.join(':')}:`;
      const r = await decryptValue(key, node.value, aad);
      if (r.type === 'comment') {
        // sops emits encrypted comments inside sequences as items
        holder[field] = Object.assign(new Scalar(null), { sopsComment: r.plain });
        return;
      }
      v = { type: r.type, value: fromPlain(r.type, r.plain) };
      stash.set(`${aad}\0${r.type}\0${r.plain}`, r.iv);
      const s = new Scalar(v.value);
      s.comment = node.comment;
      s.commentBefore = node.commentBefore;
      if (field === 'value') holder.value = s;
      else holder[field] = s;
    } else {
      if (encrypted && node.value !== '') throw new Error(`value at ${path.join('.')} should be encrypted but is not`);
      v = { type: scalarType(node, text), value: node.value };
    }
    if (!meta.mac_only_encrypted || encrypted) macChunks.push(enc.encode(toPlain(v)));
  });

  const mac = await decryptValue(key, meta.mac, meta.lastmodified);
  const want = await sha512Hex(macChunks);
  if (mac.plain !== want) throw new Error('MAC mismatch: file was modified or this is an unsupported sops feature');

  liftSeqComments(doc.contents);
  return { plain: doc.toString(toStringOpts(indent)), ctx: { rawKey, meta, metaText, stash, indent } };
}

async function encryptDoc(doc, plainText, ctx, now) {
  const { meta, stash, indent } = ctx;
  const key = await aesKey(ctx.rawKey);
  const macChunks = meta.mac_only_encrypted ? [MAC_ONLY_ENCRYPTED_INIT] : [];

  await walkDoc(doc, async (kind, holder, field, path) => {
    const encrypted = shouldBeEncrypted(meta, path);
    const aad = `${path.join(':')}:`;
    const seal = async (type, plain) => encryptValue(key, type, plain, aad, stash.get(`${aad}\0${type}\0${plain}`));
    if (kind === 'comment') {
      if (!encrypted) return;
      const lines = holder[field].split('\n');
      for (let i = 0; i < lines.length; i++) if (lines[i] !== '') lines[i] = await seal('comment', lines[i]);
      holder[field] = lines.join('\n');
      return;
    }
    const node = getValueNode(holder, field);
    if (node.value == null) return;
    const v = { type: scalarType(node, plainText), value: node.value };
    if (!meta.mac_only_encrypted || encrypted) macChunks.push(enc.encode(toPlain(v)));
    if (!encrypted || v.value === '') return;
    const s = new Scalar(await seal(v.type, toPlain(v)));
    s.type = Scalar.PLAIN;
    s.comment = node.comment;
    s.commentBefore = node.commentBefore;
    if (field === 'value') holder.value = s;
    else holder[field] = s;
  });

  const lastmodified = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const mac = await encryptValue(key, 'str', await sha512Hex(macChunks), lastmodified);
  const trailing = doc.comment;
  doc.comment = null;
  const body = doc.contents?.items?.length ? doc.toString(toStringOpts(indent)) : '';
  const comments = trailing
    ? trailing
        .split('\n')
        .map((l) => `#${l}\n`)
        .join('')
    : '';
  const metaText = ctx.metaText
    .replace(/^(\s+lastmodified:).*$/m, (_, k) => `${k} "${lastmodified}"`)
    .replace(/^(\s+mac:).*$/m, (_, k) => `${k} ${mac}`);
  return body + comments + metaText;
}

// Re-encrypts edited plaintext with the original data key. Unchanged values keep their IVs, so diffs stay minimal.
export async function encrypt(plainText, ctx, now = new Date()) {
  const doc = parse(plainText);
  if (doc.contents && !isMap(doc.contents)) throw new Error('top level must be a mapping');
  if (doc.contents?.has('sops')) throw new Error('top-level key "sops" is reserved');
  return encryptDoc(doc, plainText, ctx, now);
}

// Creates a context for a new file from a .sops.yaml creation rule, encrypting a fresh data key to the recipients.
export async function newContext(path, sopsConfigText, recipients) {
  const conf = parseDocument(sopsConfigText).toJS() ?? {};
  const rule = (conf.creation_rules ?? []).find((r) => !r.path_regex || new RegExp(r.path_regex).test(path));
  if (!rule) throw new Error(`no creation rule in .sops.yaml matches ${path}`);
  const ageRecipients = rule.age
    ? String(rule.age)
        .split(',')
        .map((r) => r.trim())
    : recipients;
  if (!ageRecipients.length) throw new Error('no age recipients');
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const age_ = [];
  for (const r of ageRecipients) {
    const e = new age.Encrypter();
    e.addRecipient(r);
    age_.push({ recipient: r, enc: age.armor.encode(await e.encrypt(rawKey)) });
  }
  const meta = { age: age_, lastmodified: '', mac: '' };
  for (const k of [
    'unencrypted_suffix',
    'encrypted_suffix',
    'unencrypted_regex',
    'encrypted_regex',
    'mac_only_encrypted',
  ])
    if (rule[k]) meta[k] = rule[k];
  meta.version = SOPS_VERSION;
  const indent = conf.stores?.yaml?.indent ?? 4;
  return { rawKey, meta, metaText: metaToText(meta, indent), stash: new Map(), indent };
}

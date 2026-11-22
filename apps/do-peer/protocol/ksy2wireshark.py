#!/usr/bin/env python3
"""Generate a Wireshark Lua dissector from a Kaitai Struct .ksy file.

usage: ksy2wireshark.py spec.ksy > spec.lua
"""

import json
import re
import sys
from pathlib import Path

import yaml

LUA_KEYWORDS = {
    "and",
    "break",
    "do",
    "else",
    "elseif",
    "end",
    "false",
    "for",
    "function",
    "goto",
    "if",
    "in",
    "local",
    "nil",
    "not",
    "or",
    "repeat",
    "return",
    "then",
    "true",
    "until",
    "while",
}
ENCODINGS = {
    "ASCII": "ENC_ASCII",
    "UTF-8": "ENC_UTF_8",
    "UTF-16LE": "ENC_UTF_16 + ENC_LITTLE_ENDIAN",
    "UTF-16BE": "ENC_UTF_16 + ENC_BIG_ENDIAN",
}
INT = re.compile(r"([us])([1248])(le|be)?$")
TOKEN = re.compile(
    r"\s*(?:(0x[0-9a-fA-F]+|\d+|\"[^\"\\]*\"|'[^'\\]*'|[a-z_][a-z0-9_]*(?:::[a-z_][a-z0-9_]*)?"
    r"|==|!=|<=|>=|[-+*/%<>().])|$)"
)
LEVELS = [("or",), ("and",), ("==", "!=", "<", ">", "<=", ">="), ("+", "-"), ("*", "/", "%")]
PREAMBLE = """
local null = setmetatable({}, { __index = function() return function(self) return self end end })

local function fail(item, msg)
  item:add_proto_expert_info(e_invalid, msg)
  error({ invalid = msg })
end

local function check(off, n, lim, sub, tree, exact)
  if off + n <= lim then return end
  if sub then fail(tree, "truncated") end
  error({ need = exact and off + n - lim or DESEGMENT_ONE_MORE_SEGMENT })
end

local function join(...)
  local t = {}
  for i = 1, select("#", ...) do
    local s = select(i, ...)
    if s and s ~= "" then t[#t + 1] = tostring(s) end
  end
  return table.concat(t, " ")
end
"""
DISSECTOR = """
local streams = {}

function proto.init()
  streams = {}
end

function proto.dissector(buf, pinfo, root)
  local key = tcp_stream().value .. "/" .. tostring(pinfo.src) .. "/" .. pinfo.src_port
  local st = streams[key]
  if not st then
    st = {}
    streams[key] = st
  end
  pinfo.cols.protocol = %(column)s
  if st.bad and pinfo.number > st.bad then
    root:add(proto, buf()):add_proto_expert_info(e_desync)
    pinfo.cols.info = "[Not dissected]"
    return
  end
  local first = %(has_prefix)s and (not st.prefix or pinfo.number <= st.prefix)
  local off, len, info = 0, buf:len(), {}
  while off < len do
    local prefix = first and off == 0
    local parse = prefix and p[""] or p[%(record)s]
    local ok, r = pcall(parse, buf, off, len, null)
    if not ok and type(r) ~= "table" then error(r, 0) end
    if not ok and r.need then
      pinfo.desegment_offset = off
      pinfo.desegment_len = r.need
      break
    end
    local tree = root:add(proto, buf(off, (ok and r or len) - off))
    local _, _, v = pcall(parse, buf, off, len, tree)
    if not ok then
      st.bad = st.bad or pinfo.number
      info[#info + 1] = "[Malformed: " .. r.invalid .. "]"
      break
    end
    if prefix then st.prefix = pinfo.number end
    info[#info + 1] = v._s ~= "" and v._s or (prefix and %(prefix_title)s or %(record_title)s)
    off = r
  end
  if #info > 0 then
    pinfo.cols.info = (pinfo.private[proto.name] and ", " or "") .. table.concat(info, ", ")
    pinfo.cols.info:fence()
    pinfo.private[proto.name] = "1"
  end
end

DissectorTable.get("tcp.port"):add(%(port)d, proto)
"""


def die(msg):
    sys.exit(f"ksy2wireshark: unsupported: {msg}")


def check_keys(d, allowed, where):
    for k in d:
        if k not in allowed and not str(k).startswith("-"):
            die(f"key '{k}' in {where}")


def lua(s):
    return json.dumps(s, ensure_ascii=False)


def title(ident):
    return ident.replace("_", " ").title()


class Expr:
    """Translates the subset of the Kaitai expression language that has an obvious Lua equivalent."""

    def __init__(self, src, scope, enums):
        self.src = str(src).lower() if isinstance(src, bool) else str(src)
        self.scope, self.enums, self.i, self.toks = scope, enums, 0, []
        pos = 0
        while pos < len(self.src):
            m = TOKEN.match(self.src, pos) or self.die(f"syntax at '{self.src[pos:]}'")
            self.toks += filter(None, [m[1]])
            pos = m.end()

    def die(self, why):
        die(f"expression '{self.src}' ({why})")

    def peek(self):
        return self.toks[self.i] if self.i < len(self.toks) else None

    def next(self):
        self.i += 1
        return self.toks[self.i - 1]

    def parse(self, want=None):
        code, kind = self.binary(0)
        if self.peek() is not None:
            self.die(f"unexpected '{self.peek()}'")
        if want and kind != want:
            self.die(f"expected {want}, got {kind}")
        return code, kind

    def binary(self, level):
        if level == len(LEVELS):
            return self.unary()
        if level == 2 and self.peek() == "not":
            self.next()
            code, kind = self.binary(2)
            if kind != "bool":
                self.die("'not' needs a boolean")
            return f"(not {code})", "bool"
        code, kind = self.binary(level + 1)
        while self.peek() in LEVELS[level]:
            op = self.next()
            rhs, rkind = self.binary(level + 1)
            if kind != rkind:
                self.die(f"'{op}' on {kind} and {rkind}")
            if level < 2:
                ok, out = kind == "bool", "bool"
            elif level == 2:
                ok, out = kind in ("int", "str") or (kind == "bool" and op in ("==", "!=")), "bool"
            else:
                ok, out = kind == "int" or (kind == "str" and op == "+"), kind
            if not ok:
                self.die(f"'{op}' on {kind}")
            if op == "/":
                code = f"math.floor({code} / {rhs})"
            else:
                op = {"!=": "~=", "+": ".." if kind == "str" else "+"}.get(op, op)
                code = f"({code} {op} {rhs})"
            kind = out
        return code, kind

    def unary(self):
        if self.peek() == "-":
            self.next()
            code, kind = self.unary()
            if kind != "int":
                self.die("'-' needs an integer")
            return f"(-{code})", "int"
        code, kind = self.atom()
        while self.peek() == ".":
            self.next()
            attr = self.next() if self.peek() else ""
            if attr == "length" and kind == "bytes":
                code, kind = f"{code}:len()", "int"
            elif attr == "length" and kind == "str":
                code, kind = f"#{code}", "int"
            else:
                self.die(f"'.{attr}' on {kind}")
        return code, kind

    def atom(self):
        tok = self.next() if self.peek() is not None else self.die("unexpected end")
        if tok[0].isdigit():
            return str(int(tok, 0)), "int"
        if tok[0] in "\"'":
            return lua(tok[1:-1]), "str"
        if tok == "(":
            code, kind = self.binary(0)
            if self.next() != ")":
                self.die("missing ')'")
            return code, kind
        if tok in ("true", "false"):
            return tok, "bool"
        if "::" in tok:
            enum, member = tok.split("::")
            for value, name in self.enums.get(enum, {}).items():
                if name == member:
                    return str(value), "int"
            self.die(f"unknown enum value {tok}")
        if tok in self.scope:
            return f"v.{tok}", self.scope[tok]
        self.die(f"'{tok}' is not an earlier field of this type")


class Generator:
    def __init__(self, ksy, source):
        check_keys(ksy, {"meta", "doc", "doc-ref", "seq", "types", "enums"}, "the top level")
        meta = ksy["meta"]
        check_keys(
            meta,
            {
                "id",
                "title",
                "endian",
                "encoding",
                "application",
                "file-extension",
                "license",
                "ks-version",
                "xref",
            },
            "meta",
        )
        self.id, self.endian, self.encoding = meta["id"], meta.get("endian"), meta.get("encoding")
        if self.endian not in (None, "be", "le"):
            die("calculated endianness")
        hints = meta.get("-wireshark") or {}
        if not isinstance(hints.get("tcp-port"), int):
            die("meta needs '-wireshark: { tcp-port: N }'")
        self.enums = {
            name: {int(k): e["id"] if isinstance(e, dict) else e for k, e in values.items()}
            for name, values in ksy.get("enums", {}).items()
        }
        self.types = ksy.get("types", {})
        self.fields, self.out = {}, []

        seq = ksy.get("seq") or []
        last = seq[-1] if seq else {}
        if (
            last.get("repeat") != "eos"
            or last.get("type") not in self.types
            or last.keys() & {"size", "if"}
        ):
            die(
                "the top-level seq must end with a 'repeat: eos' field of a user type (the stream's record)"
            )
        for name, spec in self.types.items():
            check_keys(spec, {"seq", "doc", "doc-ref"}, f"type {name}")
            self.emit_type(name, spec.get("seq") or [])
        if len(seq) > 1:
            self.emit_type("", seq[:-1])

        desc = meta.get("title", self.id)
        print(f"-- Generated by {Path(__file__).name} from {source}. Do not edit.")
        print(
            f"-- Regenerate: python3 {Path(__file__).name} {source} > {Path(source).with_suffix('.lua')}"
        )
        print(
            f"-- Load: wireshark -X lua_script:{Path(source).with_suffix('.lua')}, or copy to the plugins folder.\n"
        )
        print(f"local proto = Proto({lua(self.id)}, {lua(desc)})")
        print('local tcp_stream = Field.new("tcp.stream")')
        print(
            f'local e_invalid = ProtoExpert.new("{self.id}.invalid", "Validation failed", '
            "expert.group.MALFORMED, expert.severity.ERROR)"
        )
        print(
            f'local e_desync = ProtoExpert.new("{self.id}.desync", "Not dissected: an earlier error '
            'desynchronized this stream", expert.group.UNDECODED, expert.severity.WARN)'
        )
        print("proto.experts = { e_invalid, e_desync }\n")
        print("local vs = {")
        for name, values in self.enums.items():
            print(
                f"  {name} = {{ "
                + ", ".join(f"[{k}] = {lua(title(e))}" for k, e in values.items())
                + " },"
            )
        print("}\n\nlocal f = {")
        for key, ctor in self.fields.items():
            print(f"  [{lua(key)}] = {ctor},")
        print("}\nproto.fields = f")
        print(PREAMBLE)
        print("local p = {}")
        print("\n".join(self.out))
        print(
            DISSECTOR
            % {
                "column": lua(self.id.upper()),
                "port": hints["tcp-port"],
                "has_prefix": str(len(seq) > 1).lower(),
                "record": lua(last["type"]),
                "record_title": lua(title(last["type"])),
                "prefix_title": lua(", ".join(title(x["id"]) for x in seq[:-1])),
            },
            end="",
        )

    def field(self, key, ctor, name, *args, doc=None):
        abbr = f"{self.id}.{key}"
        args = [lua(abbr), lua(name), *args]
        if doc:
            pad = {"uint": 3, "int": 3, "bytes": 1, "string": 1, "none": 0}[
                ctor.rstrip("0123456789")
            ]
            args += ["nil"] * (pad - len(args) + 2) + [lua(" ".join(str(doc).split()))]
        ctor = f"ProtoField.{ctor}({', '.join(args)})"
        if self.fields.setdefault(key, ctor) != ctor:
            die(f"field name clash on {abbr}")
        return f"f[{lua(key)}]"

    def emit_type(self, name, seq):
        w = self.out.append
        w(f"\np[{lua(name)}] = function(buf, off, lim, tree, sub)")
        w("  local v, n, item = {}")
        scope, summary = {}, []
        for spec in seq:
            where = f"{name or 'seq'}.{spec.get('id')}"
            check_keys(
                spec,
                {
                    "id",
                    "type",
                    "size",
                    "size-eos",
                    "encoding",
                    "valid",
                    "if",
                    "repeat",
                    "enum",
                    "doc",
                    "doc-ref",
                },
                where,
            )
            fid = spec["id"]
            if fid in LUA_KEYWORDS or fid == "_s":
                die(f"field id '{fid}' is reserved in Lua")
            if spec.get("repeat", "eos") != "eos":
                die(f"repeat: {spec['repeat']} in {where}")
            ind = "  "
            if "if" in spec:
                w(f"{ind}if {Expr(spec['if'], scope, self.enums).parse('bool')[0]} then")
                ind += "  "
            target = f"v.{fid}"
            if "repeat" in spec:
                w(f"{ind}v.{fid} = {{}}")
                w(f"{ind}while off < lim do")
                ind += "  "
                w(f"{ind}local e")
                target = "e"
            kind, lines = self.emit_field(name, spec, target, scope, where, spec is seq[-1])
            self.out += [ind + line for line in lines]
            if "repeat" in spec:
                w(f"{ind}v.{fid}[#v.{fid} + 1] = e")
                ind = ind[2:]
                w(f"{ind}end")
                kind = "list"
            if "if" in spec:
                w("  end")
            scope[fid] = kind
            if kind == "struct":
                summary.append(f'type(v.{fid}) == "table" and v.{fid}._s')
            elif "enum" in spec and kind == "int":
                summary.append(f"v.{fid} and (vs.{spec['enum']}[v.{fid}] or v.{fid})")
        template = self.types.get(name, {}).get("-webide-representation")
        if template is not None:
            w(f"  v._s = {self.interpolate(template, scope, seq)}")
        else:
            w(f"  v._s = {'join(' + ', '.join(summary) + ')' if summary else lua('')}")
        if summary or template:
            w('  if v._s ~= "" then tree:append_text(": " .. v._s) end')
        w("  return off, v")
        w("end")

    def interpolate(self, template, scope, seq):
        enums = {x["id"]: x["enum"] for x in seq if "enum" in x}
        parts = []
        for i, part in enumerate(re.split(r"\{([^}]*)\}", template)):
            if i % 2 == 0:
                if part:
                    parts.append(lua(part))
            elif part in enums:
                parts.append(f"tostring(vs.{enums[part]}[v.{part}] or v.{part})")
            else:
                code, kind = Expr(part, scope, self.enums).parse()
                if kind not in ("int", "str", "bool"):
                    die(f"'{{{part}}}' in -webide-representation is a {kind}")
                parts.append(f"tostring({code})")
        return " .. ".join(parts) or lua("")

    def emit_field(self, tname, spec, target, scope, where, last):
        fid, typ, doc = spec["id"], spec.get("type"), spec.get("doc")
        key = f"{tname}.{fid}" if tname else fid
        expr = lambda src, want=None: Expr(src, scope, self.enums).parse(want)[0]
        if spec.get("size-eos"):
            size = "lim - off"
        elif "size" in spec:
            size = expr(spec["size"], "int")
        else:
            size = None
        sized = [f"n = {size}", f"check(off, n, lim, sub, tree{', sub == nil' if last else ''})"]

        if isinstance(typ, dict):
            check_keys(typ, {"switch-on", "cases"}, where)
            on, on_kind = Expr(typ["switch-on"], scope, self.enums).parse()
            lines, default, word = [], None, "if"
            for case, case_type in typ["cases"].items():
                if case == "_":
                    default = case_type
                    continue
                lines.append(f"{word} {on} == {expr(case, on_kind)} then")
                lines += [
                    "  " + line
                    for line in self.emit_struct(case_type, target, size is not None, where)
                ]
                word = "elseif"
            lines.append("else")
            if default:
                lines += [
                    "  " + line
                    for line in self.emit_struct(default, target, size is not None, where)
                ]
            elif size is None:
                die(f"switch without a size or a default case in {where}")
            else:
                f = self.field(key, "bytes", title(fid), doc=doc)
                lines += [
                    f"  {target} = buf(off, n)",
                    f"  if n > 0 then tree:add({f}, buf(off, n)) end",
                ]
            lines.append("end")
            if size is not None:
                lines = [*sized, *lines, "off = off + n"]
            return "struct", lines

        if typ in self.types:
            lines = self.emit_struct(typ, target, size is not None, where)
            if size is not None:
                lines = [*sized, *lines, "off = off + n"]
            return "struct", lines

        m = INT.match(typ or "")
        if m:
            sign, width, endian = m[1], int(m[2]), m[3] or self.endian
            if width > 1 and not endian:
                die(f"{typ} without meta.endian in {where}")
            if size is not None:
                die(f"size on {typ} in {where}")
            le = "le_" if endian == "le" and width > 1 else ""
            read = f"{le}{'u' if sign == 'u' else ''}int{'64():tonumber()' if width == 8 else '()'}"
            args = ["base.DEC"] + ([f"vs.{spec['enum']}"] if "enum" in spec else [])
            if "enum" in spec and spec["enum"] not in self.enums:
                die(f"unknown enum {spec['enum']} in {where}")
            f = self.field(
                key, f"{'uint' if sign == 'u' else 'int'}{width * 8}", title(fid), *args, doc=doc
            )
            lines = [
                f"check(off, {width}, lim, sub, tree)",
                f"{target} = buf(off, {width}):{read}",
                f"item = tree:{'add_le' if le else 'add'}({f}, buf(off, {width}))",
                f"off = off + {width}",
            ]
            return "int", lines + self.emit_valid(spec, target, "int", scope, where)

        if "enum" in spec:
            die(f"enum on a non-integer in {where}")
        if size is None:
            die(
                f"type {typ!r} without size in {where}"
                if typ in (None, "str")
                else f"type {typ!r} in {where}"
            )
        lines = list(sized)
        if typ == "str":
            encoding = spec.get("encoding", self.encoding)
            if encoding not in ENCODINGS:
                die(f"encoding {encoding} in {where}")
            f = self.field(key, "string", title(fid), doc=doc)
            lines += [
                f"{target} = buf(off, n):string({ENCODINGS[encoding]})",
                f"item = tree:add({f}, buf(off, n), {target})",
            ]
            kind = "str"
        elif typ is None:
            f = self.field(key, "bytes", title(fid), doc=doc)
            lines += [f"{target} = buf(off, n)", f"item = tree:add({f}, buf(off, n))"]
            kind = "bytes"
        else:
            die(f"type {typ!r} in {where}")
        return kind, lines + ["off = off + n"] + self.emit_valid(spec, target, kind, scope, where)

    def emit_struct(self, typ, target, sized, where):
        if typ not in self.types:
            die(f"type {typ!r} in {where}")
        f = self.field(typ, "none", title(typ), doc=self.types[typ].get("doc"))
        if sized:
            return [
                f"item = tree:add({f}, buf(off, n))",
                f"{target} = select(2, p[{lua(typ)}](buf, off, off + n, item, true))",
            ]
        return [
            f"item = tree:add({f}, buf(off, lim - off))",
            f"n, {target} = p[{lua(typ)}](buf, off, lim, item, sub or false)",
            "item:set_len(n - off)",
            "off = n",
        ]

    def emit_valid(self, spec, target, kind, scope, where):
        if "valid" not in spec:
            return []
        if kind == "bytes":
            die(f"valid on bytes in {where}")
        valid = spec["valid"] if isinstance(spec["valid"], dict) else {"eq": spec["valid"]}
        check_keys(valid, {"eq", "min", "max", "any-of"}, f"valid of {where}")
        expr = lambda src: Expr(src, scope, self.enums).parse(kind)[0]
        tests = []
        if "eq" in valid:
            tests.append((f"{target} ~= {expr(valid['eq'])}", f"expected {valid['eq']}"))
        if "min" in valid:
            tests.append((f"{target} < {expr(valid['min'])}", f"expected at least {valid['min']}"))
        if "max" in valid:
            tests.append((f"{target} > {expr(valid['max'])}", f"expected at most {valid['max']}"))
        if "any-of" in valid:
            any_of = " or ".join(f"{target} == {expr(x)}" for x in valid["any-of"])
            tests.append(
                (f"not ({any_of})", f"expected one of {', '.join(map(str, valid['any-of']))}")
            )
        return [
            f"if {test} then fail(item, {lua(f'{where}: {msg}, got ')} .. tostring({target})) end"
            for test, msg in tests
        ]


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    Generator(yaml.safe_load(Path(sys.argv[1]).read_text()), Path(sys.argv[1]).name)

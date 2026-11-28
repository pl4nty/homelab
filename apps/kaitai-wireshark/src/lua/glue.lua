-- Wireshark glue for a Kaitai Struct parser compiled by kaitai-struct-compiler -t lua.
--
-- The generator (src/index.ts) prepends three locals:
--   MODULES: Lua module name -> source (the Kaitai Lua runtime and the compiled .ksy files)
--   SPECS:   the .ksy and the specs it imports, as Lua tables; SPECS[1] is the one to dissect
--   KSY:     where the .ksy came from, for "Open in Kaitai IDE"
--
-- The compiled parser is used unchanged. Field offsets come from tracing the runtime:
--   * every KaitaiStream:read_* call records the stream and byte range it read
--   * every class made by class.class() reports field assignments on its instances
--   * every KaitaiStream built over a string records where that string came from
-- A field's range is that of the last read before its assignment. A field assigned with no read since the previous
-- assignment is computed (a value instance) and has no range.

-- The modules load into a private environment, so two Kaitai dissectors (which both define a global KaitaiStream)
-- don't share state.
local env, loaded = setmetatable({}, { __index = _G }), {}
function env.require(name)
  if loaded[name] == nil then
    local src = MODULES[name] or error("kaitai: no module named " .. name)
    loaded[name] = true -- specs can import each other, so a module counts as loaded while it runs
    loaded[name] = assert(load(src, "=" .. name .. ".lua", "t", env))(name) or true
  end
  return loaded[name]
end

local class = env.require("class")
env.require("kaitaistruct")
local Struct, Stream, StringStream = env.KaitaiStruct, env.KaitaiStream, env.require("string_stream")

-- The parse in progress (nil outside one):
--   top      the PDU's stream            streams  stream -> where its bytes are (see locate)
--   order    struct nodes, as created    nodes    struct -> node
--   read     the last read { io, a, b, val }, and `fresh` while no field has taken it
--   raw      the last _raw_ assignment { name, io, a, b }: the bytes that go into a substream or `process`
--   sources  `process` output -> Tvb, when Wireshark made it (zlib)
local S

-- Schema types by Lua class, filled in below.
local BY_CLASS = {}

-- Tracing -------------------------------------------------------------------------------------------------------------

-- Reads nest (read_u2le calls read_bytes). The outermost returns last, so its record is the one that stays.
for name, read in pairs(Stream) do
  if type(read) == "function" and name:find("^read_") then
    Stream[name] = function(io, ...)
      if not S then return read(io, ...) end
      local p, bits = io._io:seek(), io.bits_left
      local v = read(io, ...)
      -- a bit field that starts in a partly read byte starts one byte back
      S.read, S.fresh, S.raw = { io = io, a = bits > 0 and p - 1 or p, b = io._io:seek(), val = v }, true, nil
      return v
    end
  end
end

-- A short read on the PDU's own stream raises a table, so TCP can supply the missing bytes. Anywhere else (a substream
-- with a `size`) it's a malformed packet, and the runtime's own error stands.
local read_exact = Stream._read_bytes_not_aligned
function Stream:_read_bytes_not_aligned(n)
  local left = S and self == S.top and self:size() - self._io:seek()
  if left and n > left then error({ need = n - left }, 0) end
  return read_exact(self, n)
end

local stream_init = Stream._init
function Stream:_init(io)
  stream_init(self, io)
  if S and getmetatable(io) == StringStream then
    local buf, r = io._buf, S.read
    if r and type(r.val) == "string" and r.val:sub(1, #buf) == buf then
      -- the bytes just read, or what `terminator` or `pad-right` kept of them
      S.streams[self] = { parent = r.io, base = r.a }
    else
      S.streams[self] = { bytes = buf, tvb = S.sources[buf], base = 0, name = S.raw and S.raw.name }
    end
  end
end

-- Resolves a range of a stream to a TvbRange and its Tvb, following substreams up to the PDU's tvb. Bytes made by
-- `process` become a data source named after the field.
local function locate(io, a, b)
  local m = S.streams[io]
  while m and m.parent do
    a, b, io = a + m.base, b + m.base, m.parent
    m = S.streams[io]
  end
  if not m then return nil end
  m.tvb = m.tvb or ByteArray.new(m.bytes, true):tvb(m.name or "Kaitai")
  local len = m.tvb:len() - m.base
  if a > len then return nil end
  return m.tvb:range(m.base + a, math.min(b, len) - a), m.tvb
end

-- Wireshark has zlib; the runtime's pure Lua fallback (zzlib) isn't bundled.
function Stream.process_zlib(data)
  local r = S and data == S.read.val and locate(S.read.io, S.read.a, S.read.b)
  local out = r and r:uncompress_zlib(S.raw.name) or error("zlib: decompression failed")
  S.sources[out:raw()] = out:tvb()
  return out:raw()
end

local struct_init = Struct._init
function Struct._init(obj, io)
  struct_init(obj, io)
  if S then
    local n = { obj = obj, io = io, a = io:pos(), kids = {} }
    S.nodes[obj], S.order[#S.order + 1] = n, n
  end
end

-- The tree node for value v of schema field f: a struct's own node, an array (filled in as elements are assigned),
-- or a leaf.
local function make_node(f, v, owner)
  local n = type(v) == "table" and S.nodes[v]
  if n and not n.owner then -- otherwise a value instance naming a struct already in the tree, shown as its summary
    n.f, n.name, n.owner, n.b = f, f.id, owner, n.io:pos()
    -- a struct over a whole substream (`size` + `type`) spans the substream, not only what it read
    if n.io ~= owner.io and n.a == 0 then n.b = n.io:size() end
    return n
  end
  if type(v) == "table" and getmetatable(v) == nil and next(v) == nil then -- `self.x = {}` starts an array
    local arr = { name = f.id, array = true, kids = {} }
    setmetatable(v, {
      __newindex = function(t, i, x)
        rawset(t, i, x)
        local e = make_node(f, x, owner)
        e.index = i - 1
        arr.kids[i], S.last = e, e
      end,
    })
    return arr
  end
  n = { f = f, name = f.id, value = v }
  local r = S.fresh and S.read or S.raw and S.raw.name == f.id and S.raw -- `process` with no `type` reads as _raw_
  if r then n.io, n.a, n.b = r.io, r.a, r.b end
  S.fresh = false
  return n
end

local function on_assign(obj, k, v)
  if k:find("^_raw_") then
    -- _raw_x and _raw__raw_x hold the bytes of x's substream or `process` input; x is _m_x for an instance
    local name = k:gsub("^_raw_", ""):gsub("^_raw_", ""):gsub("^_m_", "")
    if S.fresh then S.raw = { name = name, io = S.read.io, a = S.read.a, b = S.read.b } end
    S.fresh = false
    return
  end
  local t, owner = BY_CLASS[getmetatable(obj)], S.nodes[obj]
  local f = t and t.fields[k:match("^_m_(.*)") or k]
  if not f or not owner then return end -- _io, _parent, _root, parameters
  S.last = make_node(f, v, owner)
  owner.kids[#owner.kids + 1] = S.last
end

local make_class = class.class
function class.class(...)
  local cls = make_class(...)
  if cls.is_a[Struct] then
    local set = cls.__newindex
    function cls.__newindex(obj, k, v)
      set(obj, k, v)
      if S then on_assign(obj, k, v) end
    end
  end
  return cls
end

-- Schema --------------------------------------------------------------------------------------------------------------

local ROOT = SPECS[1].meta.id
local W = SPECS[1].meta["-wireshark"] or {}
local TYPES, ENUMS = {}, {} -- by path: "do_peer.message", "do_peer.message_id"

-- kaitai-struct-compiler's class naming: snake_case to UpperCamelCase.
local function camel(s) return (("_" .. s):gsub("_+(%w)", string.upper)) end

-- The Wireshark field type (a key of ftypes) for a seq attribute or instance.
local function kind(a)
  local t = a.type
  if a.value ~= nil then return "STRING" end
  if t == nil then return "BYTES" end
  if type(t) == "table" then -- a switch is a struct when every case is one; otherwise it's shown as text
    for _, c in pairs(t.cases or {}) do
      if kind({ type = c }) ~= "NONE" then return "STRING" end
    end
    return next(t.cases or {}) and "NONE" or "STRING"
  end
  local sign, n = t:match("^([us])([1248])[lb]?e?$")
  if n then return (sign == "u" and "UINT" or "INT") .. n * 8 end
  n = tonumber(t:match("^b(%d+)[lb]?e?$"))
  if n then return n == 1 and "BOOLEAN" or "UINT" .. (n <= 8 and 8 or n <= 16 and 16 or n <= 32 and 32 or 64) end
  n = t:match("^f([48])[lb]?e?$")
  if n then return n == "4" and "FLOAT" or "DOUBLE" end
  return (t == "str" or t == "strz") and "STRING" or "NONE"
end

local function add_type(spec, path, cls)
  if not cls then error("kaitai: no Lua class for type " .. path) end
  for name, values in pairs(spec.enums or {}) do
    local vs = {}
    for v, label in pairs(values) do vs[v] = type(label) == "table" and label.id or label end
    ENUMS[path .. "." .. name] = vs
  end
  local t = { name = path:match("[^.]+$"), spec = spec, cls = cls, fields = {}, instances = {} }
  -- filter names: <root>.<field> for the top-level type, <root>.<type path>.<field> for the rest
  t.abbr = path == ROOT and "" or (path:find(ROOT .. ".", 1, true) == 1 and path:sub(#ROOT + 2) or path) .. "."
  for i, a in ipairs(spec.seq or {}) do
    local id = a.id or "_unnamed" .. i - 1
    t.fields[id] = { id = id, attr = a, kind = kind(a), str = a.type == "str" or a.type == "strz" }
  end
  for id, a in pairs(spec.instances or {}) do
    t.fields[id] = { id = id, attr = a, kind = kind(a) }
    t.instances[#t.instances + 1] = id
  end
  table.sort(t.instances)
  TYPES[path], BY_CLASS[cls] = t, t
  for name, sub in pairs(spec.types or {}) do add_type(sub, path .. "." .. name, rawget(cls, camel(name))) end
end
for _, spec in ipairs(SPECS) do
  env.require(spec.meta.id)
  add_type(spec, spec.meta.id, rawget(env, camel(spec.meta.id)))
end

-- Enum and type names resolve outwards from where they're used, like the compiler's lookup; a name in an imported
-- spec ("other::kind") resolves at the outermost level.
local function resolve(map, path, ref)
  if not ref then return nil end
  ref = ref:gsub("::", ".")
  while path do
    local found = map[path .. "." .. ref]
    if found then return found end
    path = path:match("^(.*)%.[^.]*$")
  end
  return map[ref] or error("kaitai: " .. ref .. " not found")
end

local NAME, TITLE = ROOT, SPECS[1].meta.title or ROOT
local ok, proto = pcall(Proto, NAME, TITLE)
if not ok then -- the name is taken (Wireshark has its own dissector for many formats)
  NAME = "ks_" .. ROOT
  proto = Proto(NAME, TITLE)
end

local fields = {}
for path, t in pairs(TYPES) do
  for id, f in pairs(t.fields) do
    local int, doc = f.kind:find("INT"), type(f.attr.doc) == "string" and f.attr.doc:match("^%s*([^\n]*)") or nil
    local labels = int and resolve(ENUMS, path, f.attr.enum) or nil
    local display = int and base.DEC or f.kind == "STRING" and base.UNICODE or base.NONE
    f.pf = ProtoField.new(id, NAME .. "." .. t.abbr .. id, ftypes[f.kind], labels, display, nil, doc)
    fields[#fields + 1] = f.pf
  end
end
proto.fields = fields

local e_malformed = ProtoExpert.new(NAME .. ".malformed", "Malformed", expert.group.MALFORMED, expert.severity.ERROR)
local e_instance = ProtoExpert.new(NAME .. ".instance", "Instance failed", expert.group.MALFORMED, expert.severity.WARN)
proto.experts = { e_malformed, e_instance }

-- Rendering -----------------------------------------------------------------------------------------------------------

local summarize

-- A value as text: an enum's label, a struct's summary, a string (the first 16 bytes in hex when it isn't text).
local function text(v)
  if type(v) == "table" then return S.nodes[v] and summarize(S.nodes[v]) or v.label or "[" .. #v .. "]" end
  if type(v) ~= "string" or (utf8.len(v) and not v:find("%c")) then return tostring(v) end
  return ("%02x"):rep(math.min(#v, 16)):format(v:byte(1, 16)) .. (#v > 16 and "…" or "")
end

-- A struct's summary, for its tree item and the Info column: its `-webide-representation` ("{a} n={b.c}"; a :hex,
-- :dec or :str suffix is ignored), or else its enum values and its structs' summaries.
function summarize(n)
  if n.summary then return n.summary end
  local t, parts = BY_CLASS[getmetatable(n.obj)], {}
  local repr = t and t.spec["-webide-representation"]
  if repr then
    n.summary = repr:gsub("{([^}:]+)[^}]*}", function(path)
      local ok, v = pcall(function()
        local v = n.obj
        for part in path:gmatch("[^.]+") do
          local struct = type(v) == "table" and S.nodes[v]
          if (part == "length" or part == "size") and not struct then v = #v else v = v[part] end
        end
        return v
      end)
      return ok and v ~= nil and text(v) or "?"
    end)
    return n.summary
  end
  for _, k in ipairs(n.kids) do
    local s = k.obj and summarize(k) or type(k.value) == "table" and k.value.label or ""
    if s ~= "" and #parts < 4 then parts[#parts + 1] = s end
  end
  n.summary = table.concat(parts, " ")
  return n.summary
end

local function span(n)
  if n.array and n.kids[1] then
    -- TvbRange:tvb() makes a new Tvb, so compare the Tvbs locate() resolved to
    local r1, t1 = span(n.kids[1])
    local r2, t2 = span(n.kids[#n.kids])
    if r1 and r2 and t1 == t2 then return t1:range(r1:offset(), r2:offset() + r2:len() - r1:offset()), t1 end
    return r1, t1
  end
  if n.io then return locate(n.io, n.a, n.b) end
end

-- What TreeItem:add takes for a leaf's field, or nil to show the value as text.
local function field_value(f, v, r)
  if f.kind == "STRING" then return f.str and v or text(v) end
  if f.kind == "NONE" then return nil end -- a switch that matched no case leaves raw bytes
  if type(v) == "table" then v = v.value end -- an enum
  -- TreeItem:add copies as many bytes as the range has, so not what `terminator` or `pad-right` shortened
  if f.kind == "BYTES" then return r and r:len() == #v and v or nil end
  if f.kind == "UINT64" then return UInt64.fromhex(("%016x"):format(v)) end
  if f.kind == "INT64" then return Int64.fromhex(("%016x"):format(v)) end
  return v
end

-- Error text can quote bytes from the packet, and a NUL would end it.
local function add_expert(item, e, msg) item:add_proto_expert_info(e, (msg:gsub("%c", "."))) end

local function render(tree, n)
  local f, r = n.f, span(n)
  local label = n.index and "[" .. n.index .. "]" or n.name
  -- ...: a ProtoField and maybe its value, or text
  local function add(...)
    if not r then return tree:add(...):set_generated() end
    if type(...) == "string" then return tree:add(r, ...) end
    return tree:add(..., r, select(2, ...))
  end
  local item
  if n.obj then
    item = (f and f.kind == "NONE") and add(f.pf) or add(label)
    if n.index and f and f.kind == "NONE" then item:prepend_text("[" .. n.index .. "] ") end
    if summarize(n) ~= "" then item:append_text(": " .. n.summary) end
  elseif n.array then
    item = add(n.name .. " (" .. #n.kids .. ")")
  elseif n.failed then
    item = add(n.name .. ": " .. n.failed)
    add_expert(item, e_instance, n.failed)
  else
    local v = field_value(f, n.value, r)
    if v ~= nil then
      item = add(f.pf, v)
      if n.index then item:prepend_text("[" .. n.index .. "] ") end
    else
      item = add(label .. ": " .. text(n.value))
    end
  end
  if n.error then add_expert(item, e_malformed, n.error) end
  for _, k in ipairs(n.kids or {}) do render(item, k) end
end

-- Parsing -------------------------------------------------------------------------------------------------------------

-- Instances can recurse without end (a DNS name that points at itself), so they stop after this many structs.
local MAX_STRUCTS = 4096

-- A Lua error without its "file:line: ".
local function message(err) return (err:gsub("^[^:]*:%d+: ", "")) end

-- Parses one PDU of schema type t at tvb offset off. Returns the state, the bytes consumed, and an error: nil, a
-- table (the PDU needs more bytes: `need` of them, when known), or a message.
local function parse(t, tvb, off)
  local io = Stream(StringStream(tvb:raw(off)))
  local st = { top = io, streams = { [io] = { tvb = tvb, base = off } }, nodes = {}, order = {}, sources = {} }
  S = st
  local ok, err = pcall(t.cls, io)
  local used, root = io:pos(), st.order[1]
  st.blame = st.last -- the field assigned last before the error
  if type(err) == "string" then
    -- a `terminator` that isn't in the PDU's stream yet
    err = err:find("end of stream reached", 1, true) and io:is_eof() and {} or message(err)
  end
  -- A struct joins the tree when its parent assigns it, which is after it's read. When a read fails, the structs
  -- being read were never assigned; hang each on its parent, so the fields read before the failure still show.
  for i = 2, ok and 0 or #st.order do
    local n = st.order[i]
    if not n.owner then
      local parent = st.nodes[rawget(n.obj, "_parent")] or root
      n.name, n.owner, n.b = BY_CLASS[getmetatable(n.obj)].name .. " (incomplete)", parent, n.io:pos()
      parent.kids[#parent.kids + 1] = n
    end
  end
  -- Evaluate every instance of every struct, including the structs that makes, so the tree shows them. One that
  -- fails gets an expert warning and doesn't stop the others.
  local i = 1
  while st.order[i] and i <= MAX_STRUCTS do
    local n = st.order[i]
    for _, id in ipairs(BY_CLASS[getmetatable(n.obj)].instances) do
      local ok, e = pcall(function() return n.obj[id] end)
      if not ok then
        e = type(e) == "table" and "past the end of the data" or message(e)
        n.kids[#n.kids + 1] = { name = id, failed = e }
      end
    end
    i = i + 1
  end
  local stopped = st.order[i] and { name = "instances", failed = "stopped after " .. MAX_STRUCTS .. " structs" }
  root.kids[#root.kids + 1] = stopped or nil
  S = nil
  return st, used, not ok and err or nil
end

-- TCP state: which PDU is the first of each direction, and the frame where a direction lost its framing.
local PDU, FIRST = resolve(TYPES, ROOT, W.pdu) or TYPES[ROOT], resolve(TYPES, ROOT, W["first-pdu"])
local first_pdu, desync = {}, {}
function proto.init()
  first_pdu, desync = {}, {}
end

local tcp_stream = Field.new("tcp.stream")

function proto.dissector(tvb, pinfo, tree)
  local stream = tcp_stream()
  local dir = stream and stream.value .. " " .. tostring(pinfo.src) .. ":" .. pinfo.src_port
  if dir and desync[dir] and pinfo.number > desync[dir] then
    -- record boundaries after an error can't be trusted
    tree:add(proto, tvb()):append_text(" (not dissected: an earlier error in this direction of the stream)")
    return
  end

  local off, len, infos = 0, tvb:len(), {}
  while off < len do
    -- A reassembled PDU is a data source of its own, at offset 0. The bytes after it in the same frame come in
    -- another call, at their offset in the frame.
    local key = FIRST and dir and pinfo.number .. ":" .. tvb:offset() + off
    local first = key and (first_pdu[dir] == key or (not first_pdu[dir] and not pinfo.visited))
    local t = first and FIRST or PDU

    local st, used, err = parse(t, tvb, off)
    if type(err) == "table" then
      if dir then
        -- TCP calls again with the PDU's start and more bytes
        pinfo.desegment_offset, pinfo.desegment_len = off, err.need or DESEGMENT_ONE_MORE_SEGMENT
        break
      end
      err = "truncated: needs more bytes than the packet has"
    end
    if first then first_pdu[dir] = key end
    if err then used = len - off end
    if err and dir and not pinfo.visited then desync[dir] = pinfo.number end

    S = st
    local root, last = st.order[1], st.blame
    local summary = summarize(root)
    infos[#infos + 1] = summary ~= "" and summary or t.name
    local item = tree:add(proto, tvb(off, used)):append_text(", " .. infos[#infos])
    if err and last and (err:find("^Validation") or err:find("^not equal")) then
      -- a failed `valid` or `contents` is about the field just read, and is marked there
      last.error, err = err .. ": " .. last.name .. " = " .. text(last.value), nil
    elseif err and last then
      -- anything else (a short read, a bad encoding) happened while reading the next one
      err = err .. " (after " .. last.name .. ")"
    end
    for _, k in ipairs(root.kids) do render(item, k) end
    S = nil
    if err then add_expert(item, e_malformed, err) end
    if used == 0 then break end
    off = off + used
  end

  if #infos > 0 then
    -- TCP fences the Info column after each PDU, so a second call for the same frame (the bytes after a reassembled
    -- PDU) adds to it. The protocol column says whether this is one.
    local again = tostring(pinfo.cols.protocol) == NAME:upper()
    pinfo.cols.protocol = NAME:upper()
    pinfo.cols.info = (again and ", " or "") .. table.concat(infos, ", ")
  end
end

-- Registration --------------------------------------------------------------------------------------------------------

for _, t in ipairs({ "tcp", "udp" }) do
  local ports, by_port = W[t .. "-port"], DissectorTable.get(t .. ".port")
  by_port:add_for_decode_as(proto)
  if type(ports) == "table" then ports = table.concat(ports, ",") end
  if ports then by_port:add(tostring(ports), proto) end
end
if W["user-dlt"] then DissectorTable.get("wtap_encap"):add(wtap_encaps.USER0 + W["user-dlt"], proto) end

-- Packet menu: writes the selected frame's first PDU to a temp file and opens it, with the spec, in the Kaitai IDE.
proto.prefs.ksy = Pref.string("Kaitai Struct spec", KSY, "The .ksy file to open in the Kaitai IDE")

local function uri_component(s)
  return (s:gsub("[^%w%-%._~]", function(c) return ("%%%02X"):format(c:byte()) end))
end

if gui_enabled() then
  register_packet_menu("Kaitai/Open " .. TITLE .. " in Kaitai IDE", function(...)
    local frame
    for _, fi in ipairs({ ... }) do
      if fi.name == "frame.number" then frame = fi.value end
      if fi.name == NAME then
        local dir = os.getenv("TMPDIR") or os.getenv("TEMP") or "/tmp"
        local path = dir .. package.config:sub(1, 1) .. ROOT .. "-" .. frame .. ".bin"
        local fh = assert(io.open(path, "wb"))
        fh:write(fi.range:raw())
        fh:close()
        local ksy = proto.prefs.ksy ~= "" and "&ksy=" .. uri_component(proto.prefs.ksy) or ""
        return browser_open_url("vscode://pl4nty.kaitai-ide/open?data=" .. uri_component(path) .. ksy)
      end
    end
  end, NAME)
end

-- Wireshark glue for a Kaitai Struct parser compiled by kaitai-struct-compiler -t lua.
--
-- The generator prepends two locals to this file:
--   MODULES: Lua module name -> source (the Kaitai Lua runtime and the compiled .ksy files)
--   SPEC:    the field schema and Wireshark settings derived from the .ksy (see src/schema.ts)
--
-- The compiled parser is used unchanged. Field offsets come from tracing the runtime instead:
--   * every KaitaiStream:read_* call records the stream and byte range it read
--   * every class made by class.class() reports field assignments on its instances
--   * every KaitaiStream built over a string records where that string came from
-- A field's range is the range of the last read before its assignment. A field assigned with no read since the
-- previous assignment is a computed value (a value instance or a parameter) and has no range.

-- Each dissector file loads its own runtime into a private environment, so two Kaitai dissectors (which define the
-- same global KaitaiStream) don't share state.
local env = setmetatable({}, { __index = _G })
local loaded = {}
function env.require(name)
  local m = loaded[name]
  if m == nil then
    local src = MODULES[name] or error("kaitai: no module named " .. name, 2)
    -- specs can import each other (ipv4_packet and protocol_body do), so a module counts as loaded while it runs
    loaded[name] = true
    m = assert(load(src, "=" .. name .. ".lua", "t", env))(name)
    if m == nil then m = true end
    loaded[name] = m
  end
  return m
end

local class = env.require("class")
env.require("kaitaistruct")
local Struct, Stream = env.KaitaiStruct, env.KaitaiStream
local StringStream = env.require("string_stream")

-- S is the state of the parse in progress, nil outside a parse.
local S

-- Metatable of the error raised when a read runs past the end of the PDU's buffer.
local EOF = {}
local function is_eof(err) return getmetatable(err) == EOF end

-- Read tracing ------------------------------------------------------------------------------------------------------

-- Reads nest (read_u2le calls read_bytes). The outermost returns last, so its record is the one that stays.
for name, read in pairs(Stream) do
  if type(read) == "function" and name:sub(1, 5) == "read_" then
    Stream[name] = function(io, ...)
      if not S then return read(io, ...) end
      local p, bits = io._io:seek(), io.bits_left
      local v = read(io, ...)
      S.seq = S.seq + 1
      S.raw = nil
      -- a bit field that starts in a partly read byte starts one byte back
      S.io, S.a, S.b, S.val = io, bits > 0 and p - 1 or p, io._io:seek(), v
      return v
    end
  end
end

-- A short read on the PDU's own buffer means TCP should supply more bytes. Anywhere else (a substream with a
-- `size`) it's a malformed packet, and the runtime's own error stands.
local read_exact = Stream._read_bytes_not_aligned
function Stream:_read_bytes_not_aligned(n)
  if S and self == S.top then
    local left = self:size() - self._io:seek()
    if n > left then error(setmetatable({ need = n - left }, EOF), 0) end
  end
  return read_exact(self, n)
end

for _, name in ipairs({ "read_bytes_term", "read_bytes_term_multi" }) do
  local read = Stream[name]
  Stream[name] = function(io, term, include, consume, eos_error, ...)
    if S and io == S.top and eos_error then
      local ok, v = pcall(read, io, term, include, consume, eos_error, ...)
      if ok then return v end
      if type(v) == "string" and v:find("end of stream reached", 1, true) then error(setmetatable({}, EOF), 0) end
      error(v, 0)
    end
    return read(io, term, include, consume, eos_error, ...)
  end
end

-- Where a stream's bytes come from: the PDU's tvb, a range of another stream, or bytes made by `process`.
local stream_init = Stream._init
function Stream:_init(io)
  stream_init(self, io)
  if S and getmetatable(io) == StringStream then
    local buf = io._buf
    -- the bytes just read, or what `terminator` or `pad-right` kept of them
    if S.io and type(S.val) == "string" and S.val:sub(1, #buf) == buf then
      S.streams[self] = { parent = S.io, base = S.a }
    else
      S.streams[self] = { bytes = buf, tvb = S.sources[buf], base = 0, name = S.raw_name }
    end
  end
end

-- Resolves a range of a stream to a TvbRange and its Tvb, following substreams to the PDU's tvb. Bytes made by `process`
-- become a new data source named after the field.
local function locate(io, a, b)
  local m = S.streams[io]
  while m and m.parent do
    a, b, io = a + m.base, b + m.base, m.parent
    m = S.streams[io]
  end
  if not m then return nil end
  if not m.tvb then m.tvb = ByteArray.new(m.bytes, true):tvb(m.name or "Kaitai") end
  local len = m.tvb:len() - m.base
  if a > len then return nil end
  return m.tvb:range(m.base + a, math.min(b, len) - a), m.tvb
end

-- Wireshark has zlib; the runtime's pure Lua fallback (zzlib) isn't bundled.
function Stream.process_zlib(data)
  local r = S and data == S.val and locate(S.io, S.a, S.b)
  if not r then error("kaitai: zlib input is not a captured byte range") end
  local out = r:uncompress_zlib(S.raw_name or "zlib")
  if not out then error("zlib: decompression failed") end
  local s = out:raw()
  S.sources[s] = out:tvb()
  return s
end

-- Parse tree ----------------------------------------------------------------------------------------------------------

local struct_init = Struct._init
function Struct._init(obj, io)
  struct_init(obj, io)
  if S then
    local n = { kind = "struct", obj = obj, io = io, a = io:pos(), kids = {} }
    S.nodes[obj] = n
    S.order[#S.order + 1] = n
    S.root = S.root or n
  end
end

local function is_struct(v) return type(v) == "table" and S.nodes[v] end

local function add_kid(owner, n)
  owner.kids[#owner.kids + 1] = n
  S.last = n
end

local function make_node(name, v, owner)
  local child = is_struct(v)
  if child then
    if child.owner then
      -- a value instance that refers to a struct already in the tree
      return { name = name, owner = owner, ref = child }
    end
    child.name, child.owner = name, owner
    child.b = child.io:pos()
    -- a struct over a whole substream (`size` + `type`) spans the substream, not only what it read
    if child.io ~= owner.io and child.a == 0 then child.b = child.io:size() end
    return child
  end
  if type(v) == "table" and getmetatable(v) == nil and next(v) == nil then
    -- `self.x = {}` starts an array; trace its elements
    local arr = { kind = "array", name = name, owner = owner, kids = {} }
    setmetatable(v, {
      __newindex = function(t, i, x)
        rawset(t, i, x)
        local e = make_node(name, x, owner)
        e.index = i - 1
        add_kid(arr, e)
      end,
    })
    return arr
  end
  local n = { name = name, value = v, owner = owner }
  local raw = S.raw
  if S.seq ~= S.mark then
    n.io, n.a, n.b, n.exact = S.io, S.a, S.b, v == S.val
  elseif raw and raw.name == name then
    -- `process` with no `type`: the value comes from the _raw_ bytes read just before
    n.io, n.a, n.b = raw.io, raw.a, raw.b
  end
  S.mark = S.seq
  return n
end

-- Schema types by Lua class, filled in once the compiled modules are loaded.
local CLASSES = {}
local function type_of(obj) return CLASSES[getmetatable(obj)] end

local function on_assign(obj, k, v)
  if k:find("^_raw_") then
    -- _raw_x and _raw__raw_x hold the bytes of x's substream or `process` input; x is _m_x for an instance
    local name = k:gsub("^_raw_", ""):gsub("^_raw_", ""):gsub("^_m_", "")
    S.raw_name = name
    if S.seq ~= S.mark then S.raw = { name = name, io = S.io, a = S.a, b = S.b } end
    -- the read is x's, not that of whatever is assigned next (a value instance that a switch reads, say)
    S.mark = S.seq
    return
  end
  local name = k:match("^_m_(.*)") or k
  if name:find("^_") and not name:find("^_unnamed") then return end -- _io, _parent, _root
  local owner = S.nodes[obj]
  local t = type_of(obj)
  if not owner or (t and t.params[name]) then return end
  add_kid(owner, make_node(name, v, owner))
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

-- Schema ----------------------------------------------------------------------------------------------------------------

-- Resolve each schema type's Lua class ("Rich.Body") in the environment.
env.require(SPEC.root)
for path, t in pairs(SPEC.types) do
  local cls = env
  for part in t.lua:gmatch("[^.]+") do cls = cls and rawget(cls, part) end
  if not cls then error("kaitai: no Lua class " .. t.lua .. " for type " .. path) end
  t.path, t.cls = path, cls
  t.params = {}
  for _, p in ipairs(t.param_ids) do t.params[p] = true end
  t.by_id = {}
  for _, f in ipairs(t.fields) do t.by_id[f.id] = f end
  CLASSES[cls] = t
end

-- Protocol and fields -----------------------------------------------------------------------------------------------

local ok, proto = pcall(Proto, SPEC.name, SPEC.title)
if not ok then
  -- the name is taken (Wireshark has its own dissector for many formats)
  SPEC.name = "ks_" .. SPEC.name
  proto = Proto(SPEC.name, SPEC.title)
end

local VALUESTRINGS = {}
for path, e in pairs(SPEC.enums) do
  local vs = {}
  for v, label in pairs(e) do vs[tonumber(v)] = label end
  VALUESTRINGS[path] = vs
end

local INT = {
  u1 = "uint8", u2 = "uint16", u4 = "uint32", u8 = "uint64",
  s1 = "int8", s2 = "int16", s4 = "int32", s8 = "int64",
}
local fields = {}
for path, t in pairs(SPEC.types) do
  -- <name>.<field> for the top-level type, <name>.<type path>.<field> for the rest
  local rel = path .. "."
  if rel:sub(1, #SPEC.root + 1) == SPEC.root .. "." then rel = rel:sub(#SPEC.root + 2) end
  for _, f in ipairs(t.fields) do
    local abbr, label, desc = SPEC.name .. "." .. rel .. f.id, f.id, f.doc
    local k, pf = f.kind
    if INT[k] then
      local vs = f.enum and VALUESTRINGS[f.enum]
      pf = ProtoField[INT[k]](abbr, label, base.DEC, vs, nil, desc)
    elseif k == "bool" then
      pf = ProtoField.bool(abbr, label, base.NONE, nil, nil, desc)
    elseif k == "float" or k == "double" then
      pf = ProtoField[k](abbr, label, nil, desc)
    elseif k == "bytes" then
      pf = ProtoField.bytes(abbr, label, base.NONE, desc)
    elseif k == "struct" then
      pf = ProtoField.none(abbr, label, desc)
    else -- "string", and anything whose type is only known at run time
      pf = ProtoField.string(abbr, label, base.UNICODE, desc)
    end
    f.pf = pf
    fields[#fields + 1] = pf
  end
end
proto.fields = fields

local e_malformed = ProtoExpert.new(SPEC.name .. ".malformed", "Malformed", expert.group.MALFORMED, expert.severity.ERROR)
local e_instance = ProtoExpert.new(SPEC.name .. ".instance", "Instance failed", expert.group.MALFORMED, expert.severity.WARN)
local e_desync = ProtoExpert.new(SPEC.name .. ".desync", "Not dissected: an earlier error in this direction of the stream",
  expert.group.UNDECODED, expert.severity.WARN)
proto.experts = { e_malformed, e_instance, e_desync }

-- Values ----------------------------------------------------------------------------------------------------------------

-- The first 16 bytes of s.
local function hex(s)
  local n = math.min(#s, 16)
  return ("%02x"):rep(n):format(s:byte(1, n)) .. (n < #s and "…" or "")
end

local function show(v, kind)
  local t = type(v)
  if t == "table" then
    if v.label then return v.label end
    local n = is_struct(v)
    if n then return n.summary or "{…}" end
    return "[" .. #v .. "]"
  elseif t == "string" then
    local text = kind == "string" or ((kind == "value" or kind == "switch") and utf8.len(v) and not v:find("[%c]"))
    if text then return '"' .. v .. '"' end
    return #v == 0 and "<empty>" or hex(v)
  end
  return tostring(v)
end

-- The value to give TreeItem:add for a field, or nil to show it as text.
local function wire_value(f, v)
  local k = f.kind
  if INT[k] then
    if type(v) == "table" then v = v.value end -- an enum
    if math.type(v) ~= "integer" then return nil end
    if k == "u8" then return UInt64.fromhex(string.format("%016x", v)) end
    if k == "s8" then return Int64.fromhex(string.format("%016x", v)) end
    return v
  elseif k == "bool" then
    if type(v) == "boolean" then return v end
  elseif k == "float" or k == "double" then
    return type(v) == "number" and v or nil
  elseif k == "bytes" then
    return type(v) == "string" and ByteArray.new(v, true) or nil
  elseif type(v) == "string" and k == "string" then
    return v
  elseif k == "string" or k == "value" or k == "switch" then
    return show(v, k)
  end
end

-- `-webide-representation`: "{a} {b.c:hex}"
local function represent(n)
  local t = type_of(n.obj)
  local fmt = t and t.repr
  if not fmt then return nil end
  return (fmt:gsub("{([^}:]+):?([^}]*)}", function(path, how)
    local ok, v = pcall(function()
      local v = n.obj
      for part in path:gmatch("[^.]+") do
        if (part == "length" or part == "size") and (type(v) == "string" or (type(v) == "table" and not is_struct(v))) then
          v = #v
        else
          v = v[part]
        end
      end
      return v
    end)
    if not ok or v == nil then return "?" end
    if type(v) == "table" and v.value ~= nil then
      if how == "dec" or how == "hex" then v = v.value else return v.label end
    end
    if how == "hex" and math.type(v) == "integer" then return string.format("0x%x", v) end
    if how == "dec" and type(v) == "number" then return tostring(v) end
    if type(v) == "string" then return (how == "str" or utf8.len(v) and not v:find("%c")) and v or hex(v) end
    return show(v)
  end))
end

-- Default summary: enum values and nested summaries, the way Wireshark's Info column reads.
local function summarize(n)
  if n.summary then return n.summary end
  local s = represent(n)
  if not s then
    local parts = {}
    for _, k in ipairs(n.kids) do
      if #parts >= 4 then break end
      if k.kind == "struct" then
        local ks = summarize(k)
        if ks ~= "" then parts[#parts + 1] = ks end
      elseif type(k.value) == "table" and k.value.label then
        parts[#parts + 1] = k.value.label
      end
    end
    s = table.concat(parts, " ")
  end
  n.summary = s
  return s
end

-- Rendering ---------------------------------------------------------------------------------------------------------------

local function span(n)
  if n.kind == "array" then
    local first, last = n.kids[1], n.kids[#n.kids]
    if not first then return nil end
    -- TvbRange:tvb() makes a new Tvb, so compare the Tvbs locate() resolved to
    local r1, t1 = span(first)
    local r2, t2 = span(last)
    if r1 and r2 and t1 == t2 then return t1:range(r1:offset(), r2:offset() + r2:len() - r1:offset()), t1 end
    return r1, t1
  end
  if n.io then return locate(n.io, n.a, n.b) end
end

-- Error text can quote bytes from the packet, and a NUL would end it.
local function add_expert(item, e, text) item:add_proto_expert_info(e, (text:gsub("%c", "."))) end

local function field_of(n)
  local t = type_of(n.owner.obj)
  return t and t.by_id[n.name]
end

local render

local function render_kids(item, n)
  for _, k in ipairs(n.kids) do render(item, k) end
end

function render(tree, n)
  local f = field_of(n)
  local r = span(n)
  local label = n.index and "[" .. n.index .. "]" or n.name
  local item
  if n.kind == "struct" then
    if f and f.kind == "struct" then
      item = r and tree:add(f.pf, r) or tree:add(f.pf)
      if n.index then item:prepend_text("[" .. n.index .. "] ") end
    else
      item = r and tree:add(r, label) or tree:add(label)
    end
    local s = summarize(n)
    if s ~= "" then item:append_text(": " .. s) end
    render_kids(item, n)
  elseif n.kind == "array" then
    item = r and tree:add(r, n.name) or tree:add(n.name)
    item:append_text(" (" .. #n.kids .. ")")
    render_kids(item, n)
  elseif n.ref then
    item = tree:add(n.name .. ": " .. (n.ref.summary or n.ref.name or ""))
    item:set_generated()
  elseif n.failed then
    item = tree:add(n.name .. ": " .. n.failed)
    item:set_generated()
    add_expert(item, e_instance, n.failed)
  else
    local v = f and wire_value(f, n.value)
    if v ~= nil then
      if r and f.kind == "bytes" and n.exact then
        item = tree:add(f.pf, r)
      elseif r then
        item = tree:add(f.pf, r, v)
      else
        item = tree:add(f.pf, v)
      end
      if n.value == "" then item:set_text(label .. ": <empty>") end
      if n.index then item:prepend_text("[" .. n.index .. "] ") end
      if f.enum and type(n.value) ~= "table" then item:append_text(" (not in enum)") end
    else
      local text = label .. ": " .. show(n.value, f and f.kind)
      item = r and tree:add(r, text) or tree:add(text)
    end
    if not r then item:set_generated() end
  end
  n.item = item
  if n.error then add_expert(item, e_malformed, n.error) end
end

-- Parsing -------------------------------------------------------------------------------------------------------------

local function message(err)
  if type(err) == "string" then return (err:gsub("^[^:]*:%d+: ", "")) end
  return tostring(err)
end

-- Evaluates every instance of every struct in the tree, breadth first, so the tree shows them. An instance that
-- fails gets an expert warning and doesn't stop the others.
-- Instances can recurse without end (a DNS name pointer to itself), so stop after this many structs.
local MAX_STRUCTS = 4096

local function force_instances(root)
  local queue, i = { root }, 1
  while queue[i] do
    if i > MAX_STRUCTS then
      add_kid(root, { name = "instances", owner = root, failed = "stopped after " .. MAX_STRUCTS .. " structs" })
      return
    end
    local n = queue[i]
    i = i + 1
    local t = type_of(n.obj)
    for _, id in ipairs(t and t.instances or {}) do
      local ok, err = pcall(function() return n.obj[id] end)
      if not ok then
        add_kid(n, { name = id, owner = n, failed = is_eof(err) and "past the end of the data" or message(err) })
      end
    end
    for _, k in ipairs(n.kids) do
      for _, s in ipairs(k.kind == "array" and k.kids or { k }) do
        if s.kind == "struct" then queue[#queue + 1] = s end
      end
    end
  end
end

-- A struct joins the tree when its parent assigns it, which is after it's read. When a read fails, the structs being
-- read were never assigned; hang each on the struct reading it, so the fields read before the failure still show.
local function adopt_unfinished(st)
  local open = {}
  for _, n in ipairs(st.order) do
    if n ~= st.root and not n.owner then
      local parent = st.nodes[rawget(n.obj, "_parent")] or open[#open] or st.root
      local t = type_of(n.obj)
      n.name, n.owner, n.b = (t and t.path:match("[^.]+$") or "?") .. " (incomplete)", parent, n.io:pos()
      parent.kids[#parent.kids + 1] = n
      open[#open + 1] = n
    end
  end
end

-- Parses one PDU of schema type t at tvb offset off. Returns the state, the bytes consumed, and an error: nil, an
-- EOF table (needs more data), or a message.
local function parse(t, tvb, off)
  local io = Stream(StringStream(tvb:raw(off)))
  local st = { top = io, streams = { [io] = { tvb = tvb, base = off } }, nodes = {}, order = {}, sources = {}, seq = 0,
    mark = 0 }
  S = st
  local ok, err = pcall(t.cls, io)
  local used = io:pos()
  -- the field assigned last before the error, which instances would replace
  st.last_read = st.last
  if not ok then adopt_unfinished(st) end
  force_instances(st.root)
  S = nil
  if ok then return st, used end
  return st, used, is_eof(err) and err or message(err)
end

-- TCP state: which PDU is the first of each direction, and the frame where a direction desynchronized.
local first_pdu, desync = {}, {}
function proto.init()
  first_pdu, desync = {}, {}
end

local tcp_stream = Field.new("tcp.stream")
local function direction(pinfo)
  local s = tcp_stream()
  if not s then return nil end
  return tostring(s.value) .. " " .. tostring(pinfo.src) .. ":" .. pinfo.src_port
end

local PDU = SPEC.types[SPEC.pdu or SPEC.root]
local FIRST = SPEC.types[SPEC.first_pdu]

-- The first PDU of each recently dissected frame, for "Open in Kaitai IDE".
local recent, recent_order = {}, {}
local function remember(frame, raw)
  if not recent[frame] then
    recent_order[#recent_order + 1] = frame
    if #recent_order > 64 then recent[table.remove(recent_order, 1)] = nil end
  end
  recent[frame] = raw
end

-- The Info text of the last call. TCP fences the column after each PDU, so a second call for the same frame (the
-- bytes after a reassembled PDU) adds to it.
local last_info

-- stream: reassemble over TCP and keep per-direction state
local function dissect(tvb, pinfo, tree, stream)
  local dir = stream and direction(pinfo)
  if dir and desync[dir] and pinfo.number > desync[dir] then
    tree:add(proto, tvb()):add_proto_expert_info(e_desync)
    return tvb:len()
  end

  local off, len, infos = 0, tvb:len(), {}
  while off < len do
    -- A reassembled PDU is a data source of its own, at offset 0. The bytes after it in the same frame come in
    -- another call, at their offset in the frame.
    local key = FIRST and dir and pinfo.number .. ":" .. tvb:offset() + off
    local first = key and (first_pdu[dir] == key or (not first_pdu[dir] and not pinfo.visited))
    local t = first and FIRST or PDU

    local st, used, err = parse(t, tvb, off)
    if dir and is_eof(err) then
      pinfo.desegment_offset = off
      pinfo.desegment_len = err.need or DESEGMENT_ONE_MORE_SEGMENT
      -- returning less than the buffer would tell TCP we rejected it, with desegment_* set
      off = len
      break
    end
    if first then first_pdu[dir] = key end
    if is_eof(err) then err = "truncated: needs more bytes than the packet has" end
    -- record boundaries after an error can't be trusted, so it takes the rest of the buffer
    if err then used = len - off end

    local item = tree:add(proto, tvb(off, used))
    local root, last = st.root, st.last_read
    S = st
    local s = summarize(root)
    if s ~= "" then item:append_text(", " .. s) end
    infos[#infos + 1] = s ~= "" and s or t.path:match("[^.]+$")
    if err and last then
      if err:find("^Validation") or err:find("^not equal") then
        -- a failed `valid` or `contents` is about the field just read
        local f = field_of(last)
        err = err .. ": " .. last.name .. " = " .. show(last.value, f and f.kind)
        last.error = err
      else
        -- anything else (a short read, a bad encoding) happened while reading the next one
        err = err .. " (after " .. last.name .. ")"
      end
    end
    render_kids(item, root)
    S = nil
    if err then
      if not (last and last.error and last.item) then add_expert(item, e_malformed, err) end
      if dir and not pinfo.visited then desync[dir] = pinfo.number end
    end
    if used == 0 then break end
    if off == 0 then remember(pinfo.number, tvb:raw(0, used)) end
    off = off + used
  end

  if #infos > 0 then
    local info = table.concat(infos, ", ")
    if tostring(pinfo.cols.info) == last_info then
      pinfo.cols.info = ", " .. info
      info = last_info .. ", " .. info
    else
      pinfo.cols.info = info
    end
    last_info = info
    pinfo.cols.protocol = SPEC.name:upper()
  end
  return off
end

function proto.dissector(tvb, pinfo, tree)
  return dissect(tvb, pinfo, tree, true)
end

-- Registration ----------------------------------------------------------------------------------------------------------

local ws = SPEC.wireshark
proto.prefs.tcp_ports = Pref.range("TCP ports", ws.tcp_ports or "", "TCP ports to dissect as " .. SPEC.title, 65535)
proto.prefs.udp_ports = Pref.range("UDP ports", ws.udp_ports or "", "UDP ports to dissect as " .. SPEC.title, 65535)
proto.prefs.ksy = Pref.string("Kaitai Struct spec", SPEC.ksy or "", "The .ksy file to open in the Kaitai IDE")

local registered = { tcp = "", udp = "" }
local function register_ports()
  for _, t in ipairs({ "tcp", "udp" }) do
    local ports = DissectorTable.get(t .. ".port")
    if registered[t] ~= "" then ports:remove(registered[t], proto) end
    registered[t] = proto.prefs[t .. "_ports"]
    if registered[t] ~= "" then ports:add(registered[t], proto) end
  end
end
proto.prefs_changed = register_ports
register_ports()

DissectorTable.get("tcp.port"):add_for_decode_as(proto)
DissectorTable.get("udp.port"):add_for_decode_as(proto)
if ws.user_dlt then DissectorTable.get("wtap_encap"):add(wtap_encaps.USER0 + ws.user_dlt, proto) end

-- Accepts a packet when the whole payload parses as one PDU. Only offered for specs whose first field is a magic
-- (`contents` or `valid`), since almost anything parses as a spec with no checks.
local function heuristic(tvb, pinfo, tree)
  local _, used, err = parse(PDU, tvb, 0)
  if err or used ~= tvb:len() then return false end
  dissect(tvb, pinfo, tree, false)
  return true
end
for _, t in ipairs(ws.heuristic) do proto:register_heuristic(t, heuristic) end

-- Open in Kaitai IDE ------------------------------------------------------------------------------------------------------

local function uri_component(s)
  return (s:gsub("[^%w%-%._~]", function(c) return string.format("%%%02X", c:byte()) end))
end

if gui_enabled() and register_packet_menu then
  register_packet_menu("Kaitai/Open " .. SPEC.title .. " in Kaitai IDE", function(...)
    local frame
    for _, fi in ipairs({ ... }) do
      if fi.name == "frame.number" then frame = fi.value end
    end
    local pdu = frame and recent[frame]
    if not pdu then return end
    local dir = os.getenv("TMPDIR") or os.getenv("TEMP") or "/tmp"
    local sep = package.config:sub(1, 1)
    local path = dir .. sep .. SPEC.root .. "-" .. frame .. ".bin"
    local fh = assert(io.open(path, "wb"))
    fh:write(pdu)
    fh:close()
    local url = "vscode://pl4nty.kaitai-ide/open?data=" .. uri_component(path)
    if proto.prefs.ksy ~= "" then url = url .. "&ksy=" .. uri_component(proto.prefs.ksy) end
    browser_open_url(url)
  end, SPEC.name)
end

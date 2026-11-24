local class = require("class")
local stringstream = require("string_stream")

KaitaiStruct = class.class()

function KaitaiStruct:_init(io)
    self._io = io
end

function KaitaiStruct:close()
    self._io:close()
end

function KaitaiStruct:from_file(filename)
    local inp = assert(io.open(filename, "rb"))

    return self(KaitaiStream(inp))
end

function KaitaiStruct:from_string(s)
    local ss = stringstream(s)

    return self(KaitaiStream(ss))
end

KaitaiStream = class.class()

function KaitaiStream:_init(io)
    self._io = io
    self:align_to_byte()
end

function KaitaiStream:close()
    self._io:close()
end

--=============================================================================
-- Stream positioning
--=============================================================================

function KaitaiStream:is_eof()
    if self.bits_left > 0 then
        return false
    end
    local current = self._io:seek()
    local dummy = self._io:read(1)
    self._io:seek("set", current)

    return dummy == nil
end

function KaitaiStream:seek(n)
    self:align_to_byte()
    self._io:seek("set", n)
end

function KaitaiStream:pos()
    return self._io:seek()
end

function KaitaiStream:size()
    local current = self._io:seek()
    local size = self._io:seek("end")
    self._io:seek("set", current)

    return size
end

--=============================================================================
-- Integer numbers
--=============================================================================

-------------------------------------------------------------------------------
-- Signed
-------------------------------------------------------------------------------

function KaitaiStream:read_s1()
    return string.unpack('b', self:read_bytes(1))
end

--.............................................................................
-- Big-endian
--.............................................................................

function KaitaiStream:read_s2be()
    return string.unpack('>i2', self:read_bytes(2))
end

function KaitaiStream:read_s4be()
    return string.unpack('>i4', self:read_bytes(4))
end

function KaitaiStream:read_s8be()
    return string.unpack('>i8', self:read_bytes(8))
end

--.............................................................................
-- Little-endian
--.............................................................................

function KaitaiStream:read_s2le()
    return string.unpack('<i2', self:read_bytes(2))
end

function KaitaiStream:read_s4le()
    return string.unpack('<i4', self:read_bytes(4))
end

function KaitaiStream:read_s8le()
    return string.unpack('<i8', self:read_bytes(8))
end

-------------------------------------------------------------------------------
-- Unsigned
-------------------------------------------------------------------------------

function KaitaiStream:read_u1()
    return string.unpack('B', self:read_bytes(1))
end

--.............................................................................
-- Big-endian
--.............................................................................

function KaitaiStream:read_u2be()
    return string.unpack('>I2', self:read_bytes(2))
end

function KaitaiStream:read_u4be()
    return string.unpack('>I4', self:read_bytes(4))
end

function KaitaiStream:read_u8be()
    return string.unpack('>I8', self:read_bytes(8))
end

--.............................................................................
-- Little-endian
--.............................................................................

function KaitaiStream:read_u2le()
    return string.unpack('<I2', self:read_bytes(2))
end

function KaitaiStream:read_u4le()
    return string.unpack('<I4', self:read_bytes(4))
end

function KaitaiStream:read_u8le()
    return string.unpack('<I8', self:read_bytes(8))
end

--=============================================================================
-- Floating point numbers
--=============================================================================

-------------------------------------------------------------------------------
-- Big-endian
-------------------------------------------------------------------------------

function KaitaiStream:read_f4be()
    return string.unpack('>f', self:read_bytes(4))
end

function KaitaiStream:read_f8be()
    return string.unpack('>d', self:read_bytes(8))
end

-------------------------------------------------------------------------------
-- Little-endian
-------------------------------------------------------------------------------

function KaitaiStream:read_f4le()
    return string.unpack('<f', self:read_bytes(4))
end

function KaitaiStream:read_f8le()
    return string.unpack('<d', self:read_bytes(8))
end

--=============================================================================
-- Unaligned bit values
--=============================================================================

function KaitaiStream:align_to_byte()
    self.bits_left = 0
    self.bits = 0
end

function KaitaiStream:read_bits_int_be(n)
    local res = 0

    local bits_needed = n - self.bits_left
    self.bits_left = -bits_needed % 8

    if bits_needed > 0 then
        -- 1 bit  => 1 byte
        -- 8 bits => 1 byte
        -- 9 bits => 2 bytes
        local bytes_needed = math.ceil(bits_needed / 8)
        local buf = {self:_read_bytes_not_aligned(bytes_needed):byte(1, bytes_needed)}
        for i = 1, bytes_needed do
            res = res << 8 | buf[i]
        end

        local new_bits = res
        res = res >> self.bits_left | self.bits << bits_needed
        self.bits = new_bits -- will be masked at the end of the function
    else
        res = self.bits >> -bits_needed -- shift unneeded bits out
    end

    local mask = (1 << self.bits_left) - 1 -- `bits_left` is in range 0..7
    self.bits = self.bits & mask

    return res
end

--
-- Unused since Kaitai Struct Compiler v0.9+ - compatibility with older versions
--
-- Deprecated, use read_bits_int_be() instead.
--
function KaitaiStream:read_bits_int(n)
    return self:read_bits_int_be(n)
end

function KaitaiStream:read_bits_int_le(n)
    local res = 0
    local bits_needed = n - self.bits_left

    if bits_needed > 0 then
        -- 1 bit  => 1 byte
        -- 8 bits => 1 byte
        -- 9 bits => 2 bytes
        local bytes_needed = math.ceil(bits_needed / 8)
        local buf = {self:_read_bytes_not_aligned(bytes_needed):byte(1, bytes_needed)}
        for i = 1, bytes_needed do
            res = res | buf[i] << ((i - 1) * 8) -- NB: Lua uses 1-based indexing, but we need 0-based here
        end

        local new_bits = res >> bits_needed
        res = res << self.bits_left | self.bits
        self.bits = new_bits
    else
        res = self.bits
        self.bits = self.bits >> n
    end

    self.bits_left = -bits_needed % 8

    local mask = (1 << n) - 1 -- unlike some other languages, no problem with this in Lua
    res = res & mask
    return res
end

--=============================================================================
-- Byte arrays
--=============================================================================

function KaitaiStream:read_bytes(n)
    self:align_to_byte()
    return self:_read_bytes_not_aligned(n)
end

function KaitaiStream:_read_bytes_not_aligned(n)
    local r = self._io:read(n)
    if r == nil then
        r = ""
    end

    if #r < n then
        error("requested " .. n .. " bytes, but only " .. #r .. " bytes available")
    end

    return r
end

function KaitaiStream:read_bytes_full()
    self:align_to_byte()
    local r = self._io:read("*all")
    if r == nil then
        r = ""
    end

    return r
end

function KaitaiStream:read_bytes_term(term, include_term, consume_term, eos_error)
    self:align_to_byte()
    local r = ""

    while true do
        local c = self._io:read(1)

        if c == nil then
            if eos_error then
                error("end of stream reached, but no terminator " .. term .. " found")
            end

            return r
        end

        if c:byte() == term then
            if include_term then
                r = r .. c
            end

            if not consume_term then
                self._io:seek("cur", -1)
            end

            return r
        end

        r = r .. c
    end
end

function KaitaiStream:read_bytes_term_multi(term, include_term, consume_term, eos_error)
    self:align_to_byte()
    local unit_size = #term
    local r = ""

    while true do
        local c = self._io:read(unit_size)

        if c == nil then
            c = ""
        end

        if #c < unit_size then
            if eos_error then
                error("end of stream reached, but no terminator " .. term .. " found")
            end

            r = r .. c
            return r
        end

        if c == term then
            if include_term then
                r = r .. c
            end

            if not consume_term then
                self._io:seek("cur", -unit_size)
            end

            return r
        end

        r = r .. c
    end
end

function KaitaiStream:ensure_fixed_contents(expected)
    local actual = self:read_bytes(#expected)

    if actual ~= expected then
        error("unexpected fixed contents: got " ..  actual .. ", was waiting for " .. expected)
    end

    return actual
end

function KaitaiStream.bytes_strip_right(src, pad_byte)
    local new_len = #src

    while new_len >= 1 and src:byte(new_len) == pad_byte do
        new_len = new_len - 1
    end

    return src:sub(1, new_len)
end

function KaitaiStream.bytes_terminate(src, term, include_term)
    local new_len = 1
    local max_len = #src

    while new_len <= max_len and src:byte(new_len) ~= term do
        new_len = new_len + 1
    end

    if include_term and new_len <= max_len then
        new_len = new_len + 1
    end

    return src:sub(1, new_len - 1)
end

function KaitaiStream.bytes_terminate_multi(src, term, include_term)
    local unit_size = #term

    for i = 1, #src, unit_size do
        if src:sub(i, i + unit_size - 1) == term then
            if include_term then
                local i = i + unit_size
            end
            return src:sub(1, i - 1)
        end
    end

    return src
end

--=============================================================================
-- Byte array processing
--=============================================================================

function KaitaiStream.process_xor_one(data, key)
    local r = ""

    for i = 1, #data do
        local c = data:byte(i) ~ key
        r = r .. string.char(c)
    end

    return r
end

function KaitaiStream.process_xor_many(data, key)
    local r = ""
    local kl = #key
    local ki = 1

    for i = 1, #data do
        local c = data:byte(i) ~ key:byte(ki)
        r = r .. string.char(c)
        ki = ki + 1
        if ki > kl then
            ki = 1
        end
    end

    return r
end

function KaitaiStream.process_rotate_left(data, amount, group_size)
    if group_size ~= 1 then
        error("unable to rotate group of " .. group_size .. " bytes yet")
    end

    local result = ""
    local mask = group_size * 8 - 1
    local anti_amount = -amount & mask

    for i = 1, #data  do
        local c = data:byte(i)
        c = ((c << amount) & 0xFF) | (c >> anti_amount)
        result = result .. string.char(c)
    end

    return result
end

--=============================================================================
-- zlib byte array processing
--=============================================================================

local zzlib, zzlib_load_err = (function()
    local old_pkg_path = package.path
    local old_pkg_loaded_keys = {}

    local load_err = nil

    -- check that the debug library is available, otherwise we can't resolve the script path
    if debug ~= nil then
        for key, _ in pairs(package.loaded) do
            old_pkg_loaded_keys[key] = true
        end

        if package.path:sub(1, 1) ~= ";" then
            package.path = ";" .. package.path
        end
        -- Get current script path - combined various suggestions from
        -- https://stackoverflow.com/a/35072122
        package.path = (debug.getinfo(2, "S").source:match("^@(.*[/\\])") or "") .. "zzlib/?.lua" .. package.path
    end

    local success, zzlib = pcall(function() return require("zzlib") end)
    if not success then
        load_err = zzlib
        zzlib = nil
    end

    if debug ~= nil then
        package.path = old_pkg_path
        for key, _ in pairs(package.loaded) do
            if not old_pkg_loaded_keys[key] then
                package.loaded[key] = nil
            end
        end
    end

    return zzlib, load_err
end)()

function KaitaiStream.process_zlib(data)
    if zzlib == nil then
        error("can't decompress zlib - failed to load submodule 'zzlib': " .. zzlib_load_err)
    end
    return zzlib.inflate(data)
end

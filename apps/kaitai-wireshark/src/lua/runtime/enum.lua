--
-- Each enum "value" is a table containing both a string label and an integer
-- value. When two enums are compared these labels and values are individually
-- compared.
--

local enum = {}

function enum.Enum(t)
    local e = { _enums = {} }

    for k, v in pairs(t) do
        e._enums[k] = {
            label = k,
            value = v,
        }
    end

    return setmetatable(e, {
        -- Retrieve an enum entry by its string label
        __index = function(table, key)
            return rawget(table._enums, key)
        end,

        -- Retrieve an enum entry by integer value, or return the raw value if
        -- it wasn't found in the enum
        __call = function(table, value)
            for k, v in pairs(table._enums) do
                if v.value == value then
                    return v
                end
            end

            return value
        end,

        __eq = function(lhs, rhs)
            for k, v in pairs(lhs._enums) do
                if v ~= rhs._enums[k] then
                    return false
                end
            end

            return true
        end
    })
end

function enum.is_defined(v)
    return type(v) == "table"
end

function enum.to_int(v)
    if type(v) == "table" then
        return v.value
    else
        return v
    end
end

return enum

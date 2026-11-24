// Name mangling of the Kaitai Struct compiler's JavaScript target.

/** `my_format` -> `MyFormat`: the generated class name of a spec or type id. */
export function toUpperCamel(id: string) {
  return id
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/** `num_entries` -> `numEntries`: the generated property name of a field id. */
export function toLowerCamel(id: string) {
  const u = toUpperCamel(id);
  return u.charAt(0).toLowerCase() + u.slice(1);
}

/** Best-effort inverse of {@link toLowerCamel}; it cannot restore `icc_4` from `icc4`. */
export function toSnake(name: string) {
  return name.replace(/(?<=[a-z0-9])[A-Z]/g, '_$&').toLowerCase();
}

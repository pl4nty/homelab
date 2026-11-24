// Parser-agnostic model of a parsed binary structure. The Kaitai engine produces it; the
// tree view, hex view and exporters consume it.

export interface ByteRange {
  /** Absolute document offset, inclusive. */
  start: number;
  /** Absolute document offset, exclusive. */
  end: number;
}

export interface FieldDef {
  /** Generated class name of the containing type, e.g. `Png` or `Chunk` (UpperCamel of the type id). */
  type: string;
  /** Field id in `seq` or `instances`. */
  field: string;
}

export type NodeKind = 'struct' | 'array' | 'bucket' | 'bytes' | 'string' | 'number' | 'boolean' | 'enum' | 'other';

export interface StructureNode {
  /** Stable path such as `png/chunks/[0]/len`; survives re-parses so expansion state is kept. */
  readonly id: string;
  /** Field id as written in the .ksy (snake_case). */
  readonly name: string;
  readonly parent?: StructureNode;
  readonly kind: NodeKind;
  /** Kaitai type name (UpperCamel class name for structs), when known. */
  readonly type?: string;
  /** Short display value for leaves. */
  readonly value?: string;
  /** Raw JS value for leaves (number, bigint, string, Uint8Array, boolean). */
  readonly raw?: unknown;
  /** Absolute byte range, when it is in the document (not inside a processed stream). */
  readonly range?: ByteRange;
  /** Set for bit-sized fields. Byte range then covers the bytes the bits were read from. */
  readonly bits?: number;
  /** Instance (lazy `instances:` entry) rather than a `seq` field. */
  readonly instance?: boolean;
  /** Error raised while parsing this node. */
  readonly error?: string;
  /** Where the field is defined, for go-to-definition. */
  readonly def?: FieldDef;
  readonly hasChildren: boolean;
  /** Lazily computes and caches children. Reading instances may parse more data. */
  children(): StructureNode[];
}

export interface ParseResult {
  roots: StructureNode[];
  /** Set when `_read()` threw. The tree is still usable up to that point. */
  error?: string;
}

/** The deepest node whose range contains `offset`. Expands only nodes on the path. */
export function findDeepestNode(nodes: StructureNode[], offset: number): StructureNode | undefined {
  let best: StructureNode | undefined;
  let level = nodes;
  for (;;) {
    let next: StructureNode | undefined;
    for (const node of level) {
      const r = node.range;
      if (r && r.start <= offset && offset < r.end) {
        // Smallest containing range wins: seq fields never overlap, but instances can point anywhere.
        if (!next || r.end - r.start < next.range!.end - next.range!.start) next = node;
      }
    }
    if (!next) return best;
    best = next;
    level = next.hasChildren ? next.children() : [];
  }
}

export interface Region {
  start: number;
  end: number;
  /** Node id, for selection sync. */
  id: string;
  /** Nesting depth, for colouring. */
  depth: number;
  /** Tooltip text: `path = value`. */
  label: string;
  error?: boolean;
}

/**
 * Leaf regions that intersect [start, end), sorted by start. Instances are not expanded here
 * (reading them could trigger expensive parses); only seq fields, arrays and buckets are.
 */
export function regionsInRange(roots: StructureNode[], start: number, end: number, limit = 20000): Region[] {
  const out: Region[] = [];
  const visit = (node: StructureNode, depth: number) => {
    if (out.length >= limit) return;
    const r = node.range;
    if (r && (r.end <= start || r.start >= end)) return;
    if (node.hasChildren && node.kind !== 'bytes') {
      const before = out.length;
      for (const child of node.children()) if (!child.instance) visit(child, depth + 1);
      // A struct whose fields all live in a processed stream still covers its raw bytes.
      if (out.length === before && r && r.end > r.start) out.push(region(node, depth));
      return;
    }
    if (r && r.end > r.start) out.push(region(node, depth));
  };
  for (const root of roots) visit(root, 0);
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  return out;
}

function region(node: StructureNode, depth: number): Region {
  return {
    start: node.range!.start,
    end: node.range!.end,
    id: node.id,
    depth,
    label: node.value === undefined ? node.id : `${node.id} = ${node.value}`,
    error: node.error !== undefined || undefined,
  };
}

/** Finds a node by id, expanding along the path. */
export function findById(roots: StructureNode[], id: string): StructureNode | undefined {
  let level = roots;
  let found: StructureNode | undefined;
  for (;;) {
    found = level.find((n) => id === n.id || id.startsWith(`${n.id}/`));
    if (!found || found.id === id) return found;
    // Buckets share their array's id prefix; descend into whichever one matches.
    level = found.hasChildren ? found.children() : [];
  }
}

/** Plain-JSON view of a subtree, for export. Instances are included. */
export function toJson(node: StructureNode, depth = 64): unknown {
  if (depth <= 0) return '…';
  if (node.kind === 'struct') {
    const o: Record<string, unknown> = {};
    for (const c of node.children()) o[c.name] = c.error && !c.hasChildren ? { error: c.error } : toJson(c, depth - 1);
    return o;
  }
  if (node.kind === 'array' || node.kind === 'bucket') {
    return node.children().flatMap((c) => (c.kind === 'bucket' ? (toJson(c, depth - 1) as unknown[]) : [toJson(c, depth - 1)]));
  }
  const v = node.raw;
  if (v instanceof Uint8Array) return Array.from(v);
  if (typeof v === 'bigint') return v.toString();
  return v ?? null;
}

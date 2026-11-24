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
  /**
   * Absolute byte range, when it is in the document (not inside a processed stream). For
   * bit-sized fields it covers the bytes the bits were read from.
   */
  readonly range?: ByteRange;
  /** Instance (`instances:` entry) rather than a `seq` field. */
  readonly instance?: boolean;
  /** Error raised while parsing this node. */
  readonly error?: string;
  /** Where the field is defined, for go-to-definition. */
  readonly def?: FieldDef;
  /** For structs read from a processed stream: the decoded bytes of that stream. */
  readonly streamBytes?: () => Uint8Array;
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
  /** Colour key, see `colourKey`. */
  key: number;
  /** Tooltip text: `path = value`. */
  label: string;
  error?: boolean;
}

/** Hue families of region colours. Adjacent nesting levels use different families. */
export const HUES = 6;
/** Tone variants per hue: two alternating tones plus a third that views use to break rare ties. */
export const TONES = 3;

/**
 * Colour key (`hue * TONES + tone`) of a leaf from its path of sibling indices, root first.
 * Consecutive fields of one struct differ in tone, and leaves of sibling structs differ in hue.
 */
export function colourKey(path: readonly number[]): number {
  const d = path.length - 1;
  if (d <= 0) return 0;
  const hue = ((d - 1) * 2 + (path[d - 1] & 1)) % HUES;
  return hue * TONES + (path[d] & 1);
}

/**
 * Leaf regions that intersect [start, end), sorted by start; at most `limit` of them. Instances
 * are not expanded here (reading them could trigger expensive parses); only seq fields, arrays
 * and buckets are. The result for a byte does not depend on the window, so views can load a file
 * block by block.
 */
export function regionsInRange(roots: StructureNode[], start: number, end: number, limit = 20000): Region[] {
  const out: Region[] = [];
  // Sibling indices from the root to the node being visited, counted among ranged, non-empty
  // seq fields. Buckets only group the tree display, so array items count as one sequence.
  const path: number[] = [];
  const outside = (r: ByteRange | undefined) => r !== undefined && (r.end <= start || r.start >= end);
  const visit = (node: StructureNode) => {
    const r = node.range;
    if (out.length >= limit || outside(r)) return;
    let leaf = !node.hasChildren || node.kind === 'bytes';
    if (!leaf) {
      // A struct whose fields all live in a processed stream still covers its raw bytes.
      leaf = true;
      let index = 0;
      const walk = (children: StructureNode[]) => {
        for (const child of children) {
          // Instances can point anywhere (or back at a parent, via `value: _parent`), so they are
          // left out to keep regions non-overlapping and the walk finite; the tree still shows them.
          // Range-less children (processed streams, value instances) have nothing to colour.
          if (child.instance || !child.range) continue;
          leaf = false;
          if (child.kind === 'bucket') {
            if (!outside(child.range)) walk(child.children());
            continue;
          }
          // Array items carry their absolute index, which keeps tones stable across buckets.
          const item = /^\[(\d+)\]$/.exec(child.name);
          path.push(item ? Number(item[1]) : index);
          visit(child);
          path.pop();
          if (child.range && child.range.end > child.range.start) index++;
        }
      };
      walk(node.children());
    }
    if (leaf && r && r.end > r.start) {
      out.push({
        start: r.start,
        end: r.end,
        id: node.id,
        key: colourKey(path),
        label: node.value === undefined ? node.id : `${node.id} = ${node.value}`,
        error: node.error !== undefined || undefined,
      });
    }
  };
  roots.forEach((root, i) => {
    path.push(i);
    visit(root);
    path.pop();
  });
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
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
    return node
      .children()
      .flatMap((c) => (c.kind === 'bucket' ? (toJson(c, depth - 1) as unknown[]) : [toJson(c, depth - 1)]));
  }
  const v = node.raw;
  if (v instanceof Uint8Array) return Array.from(v);
  if (typeof v === 'bigint') return v.toString();
  return v ?? null;
}

// What the worker hands back for one tile. Positions are metres in the tile's own frame:
// x east from the west edge, y up from BASE, z south from the south edge (so north is -z).
export const BASE = 556; // Lake Burley Griffin's surface, metres AHD

export interface MeshData {
  pos: Float32Array;
  normal: Float32Array;
  color: Uint8Array;
  index: Uint32Array;
  /** Buildings only: [metres along the wall, metres above the base, style, wall height] per vertex. */
  wall?: Float32Array;
  /** Buildings only: where each vertex falls in the tile's facade atlas, or -1 where it has no photograph. */
  fuv?: Float32Array;
}

export interface Label {
  x: number;
  y: number;
  z: number;
  name: string;
  /** Larger shows from further away. */
  rank: number;
}

export interface Built {
  x: number;
  y: number;
  /** (DEM_N + 1)^2 heights above BASE, row-major from the south-west. */
  heights: Float32Array;
  ground: ImageBitmap;
  /** What the ground is made of: red asphalt, green paving, blue vegetation. */
  mask: ImageBitmap;
  /** Aerial photograph of the tile, where the survey covers it. */
  photo: ImageBitmap | null;
  /** Facade photographs packed into one image, where the offline pipeline has made them. */
  facade: ImageBitmap | null;
  /** The photographers to credit for it. */
  facadeCredits: string[];
  terrain: { pos: Float32Array; normal: Float32Array; uv: Float32Array; index: Uint32Array };
  buildings: MeshData | null;
  bridges: MeshData | null;
  water: { pos: Float32Array; index: Uint32Array } | null;
  /** Per tree: x, y, z, height, crown radius, kind, seed. */
  trees: Float32Array;
  /** Per parked car: x, y, z, heading, colour index. */
  cars: Float32Array;
  /** Per street light: x, y, z, height. */
  lights: Float32Array;
  /** Per traffic lane: point count, one-way flag, then x, y, z triples; cars run along these. */
  lanes: Float32Array;
  /** Like `heights`, but water reads as its surface: what a vehicle rides on. */
  surface: Float32Array;
  /** Per bridge deck: point count, half width, then x, y, z triples along its centreline. */
  decks: Float32Array;
  /** Per building: point count, bounding box (min x, min z, max x, max z), then x, z pairs of its outline. */
  solids: Float32Array;
  labels: Label[];
  /** Source buildings a hand-built model replaces: which model, and where the source puts it. */
  landmarks: { id: string; x: number; z: number }[];
  stats: { buildings: number; trees: number; missing: string };
}

export interface BuildRequest {
  id: number;
  x: number;
  y: number;
  res: number;
  /** Repaint the ground at a new resolution, nothing else. */
  groundOnly?: boolean;
}

export type BuildReply =
  | { id: number; ok: true; built: Built }
  | { id: number; ok: true; ground: ImageBitmap; mask: ImageBitmap; photo: ImageBitmap | null }
  | { id: number; ok: false; error: string };

/** The index the facade pipeline writes beside each atlas. */
export interface FacadeIndex {
  size: number;
  /** Atlas rectangle [x, y, width, height] by wall, keyed by its end points in tile decimetres. */
  walls: Record<string, [number, number, number, number]>;
  credits: string[];
}

export function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Growable mesh buffers. */
export class MeshBuilder {
  pos: number[] = [];
  normal: number[] = [];
  color: number[] = [];
  wall: number[] = [];
  fuv: number[] = [];
  index: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    c: number,
    w0 = 0,
    w1 = 0,
    w2 = 0,
    w3 = 0,
  ): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.normal.push(nx, ny, nz);
    this.color.push((c >> 16) & 255, (c >> 8) & 255, c & 255);
    this.wall.push(w0, w1, w2, w3);
    this.fuv.push(-1, -1);
    return i;
  }

  /** A flat-shaded triangle; the normal comes from the winding. */
  tri(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    c: number,
  ) {
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const i = this.vertex(ax, ay, az, nx, ny, nz, c);
    this.vertex(bx, by, bz, nx, ny, nz, c);
    this.vertex(cx, cy, cz, nx, ny, nz, c);
    this.index.push(i, i + 1, i + 2);
  }

  quad(a: number[], b: number[], c: number[], d: number[], col: number) {
    this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], col);
    this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], col);
  }

  /** An axis-free box from a centre, two horizontal half-axes and a vertical span. */
  box(
    cx: number,
    cz: number,
    ux: number,
    uz: number,
    vx: number,
    vz: number,
    y0: number,
    y1: number,
    side: number,
    top: number,
  ) {
    const p = [
      [cx - ux - vx, cz - uz - vz],
      [cx + ux - vx, cz + uz - vz],
      [cx + ux + vx, cz + uz + vz],
      [cx - ux + vx, cz - uz + vz],
    ];
    for (let i = 0; i < 4; i++) {
      const a = p[i];
      const b = p[(i + 1) % 4];
      this.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], side);
    }
    this.quad([p[0][0], y1, p[0][1]], [p[1][0], y1, p[1][1]], [p[2][0], y1, p[2][1]], [p[3][0], y1, p[3][1]], top);
  }

  finish(withWall: boolean): MeshData | null {
    if (!this.index.length) return null;
    const out: MeshData = {
      pos: new Float32Array(this.pos),
      normal: new Float32Array(this.normal),
      color: new Uint8Array(this.color),
      index: new Uint32Array(this.index),
    };
    if (withWall) {
      out.wall = new Float32Array(this.wall);
      out.fuv = new Float32Array(this.fuv);
    }
    return out;
  }
}

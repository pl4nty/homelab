// Builds one world tile from the source blocks around it.
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { TILE_Z, tileBoundsWorld } from '../shared/geo.ts';
import {
  type BBox,
  clipLine,
  clipPolygon,
  lineLength,
  pointInPolygon,
  type Ring,
  ringArea,
  simplifyLine,
  simplifyRing,
} from '../shared/poly.ts';
import { type Area, type Building, DEM_N, type Road, TILE_VERSION, type Tile, TreeKind } from '../shared/tile.ts';
import { type ActBlock, type ActPolygon, actBlock } from './arcgis.ts';
import { type DiskCache, Lru } from './cache.ts';
import type { Dem } from './dem.ts';
import type { OvBase, OvBuilding, Overture, OvSegment } from './overture.ts';

const gz = promisify(gzip);
const gunz = promisify(gunzip);

/** Bump when a source block's stored shape changes. */
const BLOCK_VERSION = 1;

interface BuildingBlock {
  buildings: OvBuilding[];
  parts: OvBuilding[];
}

function hash(x: number, y: number): number {
  let h = (Math.imul(Math.round(x * 10), 374761393) + Math.imul(Math.round(y * 10), 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function centroid(r: Ring): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = r.length; i < n; i += 2) {
    const j = (i + 2) % n;
    const f = r[i] * r[j + 1] - r[j] * r[i + 1];
    a += f;
    cx += (r[i] + r[j]) * f;
    cy += (r[i + 1] + r[j + 1]) * f;
  }
  if (Math.abs(a) < 1e-6) return [r[0], r[1]];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Buckets boxes on a grid so overlap tests only look at neighbours. */
class Grid<T extends { bbox: BBox }> {
  private cells = new Map<number, T[]>();
  constructor(
    items: T[],
    private size = 64,
  ) {
    for (const it of items)
      this.each(it.bbox, (k) => {
        const c = this.cells.get(k);
        if (c) c.push(it);
        else this.cells.set(k, [it]);
      });
  }
  private each(b: BBox, fn: (key: number) => void) {
    const s = this.size;
    for (let gx = Math.floor(b[0] / s); gx <= Math.floor(b[2] / s); gx++) {
      for (let gy = Math.floor(b[1] / s); gy <= Math.floor(b[3] / s); gy++) fn(gx * 100003 + gy);
    }
  }
  query(b: BBox): Set<T> {
    const out = new Set<T>();
    this.each(b, (k) => {
      for (const it of this.cells.get(k) ?? []) {
        if (it.bbox[0] <= b[2] && it.bbox[2] >= b[0] && it.bbox[1] <= b[3] && it.bbox[3] >= b[1]) out.add(it);
      }
    });
    return out;
  }
}

/** Two footprints describe the same building when either's centre falls inside the other. */
function sameBuilding(a: { rings: Ring[]; bbox: BBox }, b: { rings: Ring[]; bbox: BBox }): boolean {
  const [ax, ay] = centroid(a.rings[0]);
  if (pointInPolygon(ax, ay, b.rings)) return true;
  const [bx, by] = centroid(b.rings[0]);
  return pointInPolygon(bx, by, a.rings);
}

const ACT_KIND: Record<string, string> = {
  RESIDENTIAL: 'res',
  COMMERCIAL: 'com',
  COMMUNITY: 'civ',
  EDUCATION: 'edu',
  GOVERNMENT: 'gov',
  NATIONAL: 'nat',
  HEALTH: 'med',
  DEFENCE: 'def',
  DIPLOMATIC: 'dip',
  TRANSPORT: 'tra',
  'RECREATIONAL/TOURIST': 'rec',
};
const OV_KIND: Record<string, string> = {
  residential: 'res',
  commercial: 'com',
  industrial: 'ind',
  education: 'edu',
  civic: 'civ',
  religious: 'rel',
  medical: 'med',
  outbuilding: 'out',
  entertainment: 'rec',
  service: 'ser',
  agricultural: 'agr',
  military: 'def',
  transportation: 'tra',
};
const TALL_CLASSES = new Set(['apartments', 'hotel', 'dormitory', 'office']);
const SHED_CLASSES = new Set(['garage', 'garages', 'shed', 'carport', 'roof', 'hut', 'greenhouse', 'kiosk', 'toilets']);

function kindOf(o: OvBuilding | undefined, act: ActPolygon | undefined): string {
  if (o?.cls && SHED_CLASSES.has(o.cls)) return 'out';
  if (o?.cls === 'apartments' || o?.cls === 'dormitory' || o?.cls === 'hotel') return 'apt';
  if (act) {
    const use = act.use ?? '';
    if (act.k === 'RESIDENTIAL' && /MULTI|APARTMENT|FLAT|UNIT/.test(use)) return 'apt';
    if (ACT_KIND[act.k]) return ACT_KIND[act.k];
  }
  return (o?.subtype && OV_KIND[o.subtype]) || '';
}

/** A plausible height where no source measured one. */
function guessHeight(kind: string, area: number, cls: string | undefined, seed: number): number {
  if (kind === 'out' || area < 45) return 2.6 + seed * 0.5;
  if (cls && TALL_CLASSES.has(cls)) return area > 800 ? 18 : 10;
  switch (kind) {
    case 'apt':
      return area > 900 ? 15 : 9;
    case 'res':
      return seed > 0.82 ? 6.6 : 4.2 + seed * 0.8;
    case 'com':
    case 'ind':
      return area > 4000 ? 10 : area > 800 ? 7.5 : 5;
    case 'edu':
    case 'civ':
    case 'gov':
    case 'med':
    case 'nat':
    case 'def':
    case 'dip':
      return area > 1500 ? 9 : 6;
    default:
      return area > 2500 ? 9 : area > 400 ? 6 : 4.2 + seed * 0.8;
  }
}

const GENUS: [TreeKind, string[]][] = [
  [TreeKind.Eucalypt, ['eucalyptus', 'corymbia', 'angophora', 'lophostemon']],
  [TreeKind.Columnar, ['populus']],
  [
    TreeKind.Conifer,
    [
      'pinus',
      'cedrus',
      'cupressus',
      'callitris',
      'picea',
      'abies',
      'sequoia',
      'sequoiadendron',
      'araucaria',
      'thuja',
      'juniperus',
      'chamaecyparis',
      'cupressocyparis',
      'taxodium',
      'metasequoia',
      'calocedrus',
    ],
  ],
  [
    TreeKind.Deciduous,
    [
      'quercus',
      'ulmus',
      'fraxinus',
      'platanus',
      'acer',
      'prunus',
      'pyrus',
      'malus',
      'liquidambar',
      'pistacia',
      'betula',
      'zelkova',
      'celtis',
      'robinia',
      'gleditsia',
      'koelreuteria',
      'lagerstroemia',
      'melia',
      'tilia',
      'sorbus',
      'crataegus',
      'salix',
      'liriodendron',
      'nyssa',
      'sapium',
      'triadica',
      'ginkgo',
      'styphnolobium',
      'sophora',
      'catalpa',
      'cercis',
      'aesculus',
      'carpinus',
      'fagus',
      'juglans',
      'morus',
      'paulownia',
    ],
  ],
];
const GENUS_KIND = new Map<string, TreeKind>();
for (const [kind, names] of GENUS) for (const n of names) GENUS_KIND.set(n, kind);

export function treeKind(genus: string): TreeKind {
  return GENUS_KIND.get(genus.trim().toLowerCase().split(/\s+/)[0]) ?? TreeKind.Evergreen;
}

/** Joins lines that meet end to end, so a bridge drawn as several segments becomes one span. */
export function chainLines<T extends { p: number[] }>(lines: T[]): T[] {
  const key = (x: number, y: number) => `${Math.round(x * 5)},${Math.round(y * 5)}`;
  const ends = new Map<string, T[]>();
  for (const l of lines) {
    for (const k of [key(l.p[0], l.p[1]), key(l.p[l.p.length - 2], l.p[l.p.length - 1])]) {
      const e = ends.get(k);
      if (e) e.push(l);
      else ends.set(k, [l]);
    }
  }
  const used = new Set<T>();
  const out: T[] = [];
  const reversed = (p: number[]) => {
    const r: number[] = [];
    for (let i = p.length - 2; i >= 0; i -= 2) r.push(p[i], p[i + 1]);
    return r;
  };
  for (const start of lines) {
    if (used.has(start)) continue;
    used.add(start);
    let p = start.p.slice();
    for (let side = 0; side < 2; side++) {
      for (;;) {
        const k = key(p[p.length - 2], p[p.length - 1]);
        const next = (ends.get(k) ?? []).filter((l) => !used.has(l));
        // A junction of three or more is a real fork, not a continuation.
        if (next.length !== 1 || (ends.get(k)?.length ?? 0) !== 2) break;
        const n = next[0];
        used.add(n);
        const np = key(n.p[0], n.p[1]) === k ? n.p : reversed(n.p);
        p = p.concat(np.slice(2));
      }
      p = reversed(p);
    }
    out.push({ ...start, p });
  }
  return out;
}

export interface BakeResult {
  body: Buffer;
  /** Sources that failed; a tile with any is served but not kept. */
  missing: string[];
}

export class Baker {
  private memory = new Lru<Promise<unknown>>(48);

  constructor(
    private disk: DiskCache,
    private overture: Overture,
    private dem: Dem,
  ) {}

  get release(): string {
    return this.overture.release;
  }

  /** A source block: from memory, else disk, else upstream. */
  private block<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.memory.get(key) as Promise<T> | undefined;
    if (!p) {
      p = this.disk
        .getOrBuild(`blocks/v${BLOCK_VERSION}/${key}.json.gz`, async () => gz(JSON.stringify(await load())))
        .then(async (buf) => JSON.parse((await gunz(buf)).toString('utf8')) as T);
      p.catch(() => this.memory.delete(key));
      this.memory.set(key, p);
    }
    return p;
  }

  async tile(x: number, y: number): Promise<BakeResult> {
    const key = `tiles/v${TILE_VERSION}-${this.overture.release}/${x}/${y}.json.gz`;
    const hit = await this.disk.get(key);
    if (hit) return { body: hit, missing: [] };
    const { tile, missing } = await this.bake(x, y);
    const body = await gz(JSON.stringify(tile));
    if (!missing.length) await this.disk.set(key, body);
    return { body, missing };
  }

  async bake(x: number, y: number): Promise<{ tile: Tile; missing: string[] }> {
    const missing: string[] = [];
    const [x0, y0, x1, y1] = tileBoundsWorld(TILE_Z, x, y);
    const rel = this.overture.release;
    const bx = x >> 1;
    const by = y >> 1;
    const attempt = async <T>(name: string, p: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await p;
      } catch (e) {
        console.warn(`tile ${x}/${y}: ${name} failed: ${(e as Error).message}`);
        missing.push(name);
        return fallback;
      }
    };
    const emptyAct: ActBlock = {
      footprints: [],
      crowns: [],
      assets: [],
      genus: [],
      lights: [],
      carparks: [],
      fields: [],
      stops: [],
    };
    const [ov, segs, base, act, height] = await Promise.all([
      attempt(
        'overture buildings',
        this.block<BuildingBlock>(`ov-${rel}/b/${bx}/${by}`, () => this.overture.buildings(bx, by)),
        { buildings: [], parts: [] },
      ),
      attempt(
        'overture transportation',
        this.block<OvSegment[]>(`ov-${rel}/t/${bx}/${by}`, () => this.overture.segments(bx, by)),
        [],
      ),
      attempt(
        'overture base',
        this.block<OvBase>(`ov-${rel}/base/${x >> 2}/${y >> 2}`, () => this.overture.base(x >> 2, y >> 2)),
        { areas: [], lines: [] },
      ),
      attempt(
        'act open data',
        this.block<ActBlock>(`act/${bx}/${by}`, () => actBlock(bx, by)),
        emptyAct,
      ),
      attempt('elevation', this.dem.sampler(x0 - 900, y0 - 900, x1 + 900, y1 + 900), () => 580),
    ]);

    const q = (v: number, o: number) => Math.round((v - o) * 10);
    const local = (r: number[]) => {
      const out = new Array<number>(r.length);
      for (let i = 0; i < r.length; i += 2) {
        out[i] = q(r[i], x0);
        out[i + 1] = q(r[i + 1], y0);
      }
      return out;
    };
    const owns = (b: BBox) => {
      const cx = (b[0] + b[2]) / 2;
      const cy = (b[1] + b[3]) / 2;
      return cx >= x0 && cx < x1 && cy >= y0 && cy < y1;
    };

    // --- terrain
    const dem: number[] = [];
    let min = Infinity;
    const step = (x1 - x0) / DEM_N;
    const raw: number[] = [];
    for (let j = 0; j <= DEM_N; j++) {
      for (let i = 0; i <= DEM_N; i++) {
        const h = height(x0 + i * step, y0 + j * step);
        raw.push(h);
        if (h < min) min = h;
      }
    }
    min = Math.floor(min);
    for (const h of raw) dem.push(Math.round((h - min) * 10));

    // --- buildings: OpenStreetMap shapes win, ACT footprints replace machine-traced ones
    const buildings: Building[] = [];
    const actGrid = new Grid(act.footprints);
    const ovGrid = new Grid(ov.buildings);
    const partsOf = new Map<string, OvBuilding[]>();
    for (const p of ov.parts) {
      if (!p.parent) continue;
      const list = partsOf.get(p.parent);
      if (list) list.push(p);
      else partsOf.set(p.parent, [p]);
    }
    // Buildings with a measured height, to estimate the unmeasured ones around them.
    const measured: { x: number; y: number; h: number }[] = [];
    for (const o of ov.buildings) {
      if (o.h == null && !o.floors) continue;
      if ((o.bbox[2] - o.bbox[0]) * (o.bbox[3] - o.bbox[1]) < 300) continue;
      measured.push({
        x: (o.bbox[0] + o.bbox[2]) / 2,
        y: (o.bbox[1] + o.bbox[3]) / 2,
        h: o.h ?? o.floors! * 3.2 + 0.8,
      });
    }
    const neighbourHeight = (x: number, y: number): number | undefined => {
      const near: number[] = [];
      for (const m of measured) if ((m.x - x) ** 2 + (m.y - y) ** 2 < 180 * 180) near.push(m.h);
      if (near.length < 4) return undefined;
      near.sort((a, b) => a - b);
      return near[near.length >> 1];
    };
    const colour = (c: string | undefined) =>
      c && /^#[0-9a-f]{6}$/i.test(c) ? Number.parseInt(c.slice(1), 16) : undefined;
    const emit = (rings: Ring[], o: OvBuilding | undefined, a: ActPolygon | undefined, inherit?: OvBuilding) => {
      const area = Math.abs(ringArea(rings[0]));
      if (area < 4) return;
      const k = kindOf(o ?? inherit, a);
      const seed = hash(rings[0][0], rings[0][1]);
      let h = o?.h ?? inherit?.h;
      let hs: Building['hs'] = 's';
      const floors = o?.floors ?? inherit?.floors;
      if (h == null && floors) {
        h = floors * 3.2 + 0.8;
        hs = 'f';
      }
      if (h == null) {
        h = guessHeight(k, area, o?.cls ?? inherit?.cls, seed);
        // A large unmeasured building among measured ones is more likely their height than a default.
        if (area > 300 && k !== 'res' && k !== 'out') {
          const around = neighbourHeight(rings[0][0], rings[0][1]);
          if (around != null && around > h) h = around * (0.75 + seed * 0.4);
        }
        hs = 'e';
      }
      const b: Building = {
        p: rings.map((r) => local(simplifyRing(r, 0.15))),
        h: Math.round(Math.max(h, 2.2) * 10) / 10,
        k,
        hs,
      };
      if (o?.mh) b.mh = Math.round(o.mh * 10) / 10;
      if (o?.roof && o.roof !== 'flat') b.roof = o.roof;
      if (o?.roofH) b.roofH = o.roofH;
      const name = o?.name ?? inherit?.name;
      if (name) b.name = name;
      if (o?.cut) b.cut = 1;
      const fc = colour(o?.fc);
      const rc = colour(o?.rc);
      if (fc != null) b.fc = fc;
      if (rc != null) b.rc = rc;
      buildings.push(b);
    };
    for (const o of ov.buildings) {
      if (!owns(o.bbox)) continue;
      const matches = [...actGrid.query(o.bbox)].filter((a) => sameBuilding(a, o));
      if (o.src !== 'osm' && matches.length) continue;
      const parts = o.hasParts ? partsOf.get(o.id) : undefined;
      if (parts?.length) continue;
      emit(o.rings, o, matches[0]);
    }
    const parents = new Map(ov.buildings.map((b) => [b.id, b]));
    for (const p of ov.parts) {
      if (!owns(p.bbox)) continue;
      const parent = p.parent ? parents.get(p.parent) : undefined;
      emit(p.rings, p, undefined, parent);
    }
    for (const a of act.footprints) {
      if (!owns(a.bbox)) continue;
      const matches = [...ovGrid.query(a.bbox)].filter((o) => sameBuilding(a, o));
      if (matches.some((o) => o.src === 'osm')) continue;
      // The machine-traced outlines carry the only height estimate, so keep it with the surveyed shape.
      let best: OvBuilding | undefined;
      for (const o of matches) if (o.h != null && (!best || o.h > best.h!)) best = o;
      emit(a.rings, best ? { ...best, cut: false, name: undefined } : undefined, a);
    }

    // --- roads
    const roads: Road[] = [];
    const roadBox: BBox = [x0 - 25, y0 - 25, x1 + 25, y1 + 25];
    const bridges = chainLines(segs.filter((s) => (s.f ?? 0) & 1));
    for (const s of bridges) {
      // A span belongs to the tile under its midpoint, and is sent whole so the deck is built once.
      const n = s.p.length >> 1;
      const mi = (n >> 1) * 2;
      const mx = n % 2 ? s.p[mi] : (s.p[mi - 2] + s.p[mi]) / 2;
      const my = n % 2 ? s.p[mi + 1] : (s.p[mi - 1] + s.p[mi + 1]) / 2;
      if (mx < x0 || mx >= x1 || my < y0 || my >= y1) continue;
      const end = (i: number, j: number) => {
        // Look a little past the abutment: the mapped end of a bridge often sits over the gap.
        const dx = s.p[i] - s.p[j];
        const dy = s.p[i + 1] - s.p[j + 1];
        const len = Math.hypot(dx, dy) || 1;
        return Math.max(height(s.p[i], s.p[i + 1]), height(s.p[i] + (dx / len) * 12, s.p[i + 1] + (dy / len) * 12));
      };
      const last = s.p.length - 2;
      const road: Road = {
        p: local(simplifyLine(s.p, 0.2)),
        c: s.c,
        f: 1,
        e: [Math.round(end(0, 2) * 10) / 10, Math.round(end(last, last - 2) * 10) / 10],
      };
      if (s.s) road.s = s.s;
      if (s.l) road.l = s.l;
      if (s.name) road.name = s.name;
      roads.push(road);
    }
    for (const s of segs) {
      if ((s.f ?? 0) & 1) continue;
      if (s.c === 'unknown') continue;
      for (const piece of clipLine(s.p, roadBox)) {
        if (lineLength(piece) < 0.5) continue;
        const road: Road = { p: local(simplifyLine(piece, 0.2)), c: s.c };
        if (s.s) road.s = s.s;
        if (s.f) road.f = s.f;
        if (s.l) road.l = s.l;
        if (s.name) road.name = s.name;
        roads.push(road);
      }
    }

    // --- ground cover and water
    const areas: Area[] = [];
    const water: Area[] = [];
    const paintBox: BBox = [x0 - 3, y0 - 3, x1 + 3, y1 + 3];
    const rank: Record<string, number> = { cover: 0, use: 1, land: 2, infra: 3 };
    const clipArea = (rings: Ring[], k: string, name: string | undefined, tol: number): Area | null => {
      const clipped = clipPolygon(rings, paintBox).map((r) => local(simplifyRing(r, tol)));
      if (!clipped.length || clipped[0].length < 6) return null;
      const a: Area = { p: clipped, k };
      if (name) a.name = name;
      return a;
    };
    const sorted = base.areas.filter((a) => a.layer !== 'water').sort((a, b) => rank[a.layer] - rank[b.layer]);
    for (const a of sorted) {
      let k = a.layer === 'cover' ? `cover/${a.k}` : a.k;
      if (a.surface) k += `/${a.surface}`;
      const out = clipArea(a.rings, k, a.name, a.layer === 'cover' ? 2 : 0.4);
      if (out) areas.push(out);
    }
    for (const a of base.areas) {
      if (a.layer !== 'water') continue;
      const out = clipArea(a.rings, a.k, a.name, 0.4);
      if (out) water.push(out);
    }
    const streams: Tile['streams'] = [];
    for (const l of base.lines) {
      for (const piece of clipLine(l.p, paintBox)) streams.push({ p: local(simplifyLine(piece, 0.5)), k: l.k });
    }
    const assetAreas = (list: ActPolygon[]) => {
      const out: Area[] = [];
      for (const a of list) {
        const c = clipArea(a.rings, a.k, a.name, 0.3);
        if (c) out.push(c);
      }
      return out;
    };

    // --- trees: LiDAR crowns give place and size, the tree register gives the species
    const trees: number[] = [];
    const cell = 6;
    const assetCells = new Map<number, number[]>();
    const cellKey = (px: number, py: number) => Math.floor(px / cell) * 100003 + Math.floor(py / cell);
    for (let i = 0; i < act.assets.length; i += 2) {
      const k = cellKey(act.assets[i], act.assets[i + 1]);
      const c = assetCells.get(k);
      if (c) c.push(i);
      else assetCells.set(k, [i]);
    }
    const matched = new Set<number>();
    for (let i = 0; i < act.crowns.length; i += 4) {
      const tx = act.crowns[i];
      const ty = act.crowns[i + 1];
      if (tx < x0 || tx >= x1 || ty < y0 || ty >= y1) continue;
      const h = act.crowns[i + 2];
      const r = Math.min(11, Math.max(1.2, Math.sqrt(act.crowns[i + 3] / Math.PI)));
      const reach = Math.max(3, r);
      let best = -1;
      let bestD = reach * reach;
      for (let gx = -1; gx <= 1; gx++) {
        for (let gy = -1; gy <= 1; gy++) {
          for (const a of assetCells.get(cellKey(tx + gx * cell, ty + gy * cell)) ?? []) {
            const d = (act.assets[a] - tx) ** 2 + (act.assets[a + 1] - ty) ** 2;
            if (d < bestD) {
              bestD = d;
              best = a;
            }
          }
        }
      }
      let kind: TreeKind;
      if (best >= 0) {
        matched.add(best);
        kind = treeKind(act.genus[best >> 1]);
      } else {
        const s = hash(tx, ty);
        kind =
          s < 0.8
            ? TreeKind.Eucalypt
            : s < 0.92
              ? TreeKind.Deciduous
              : s < 0.96
                ? TreeKind.Conifer
                : TreeKind.Evergreen;
      }
      trees.push(q(tx, x0), q(ty, y0), Math.round(h * 10), Math.round(r * 10), kind);
    }
    // Registered trees the survey did not pick out as a crown are young or small.
    for (let i = 0; i < act.assets.length; i += 2) {
      if (matched.has(i)) continue;
      const tx = act.assets[i];
      const ty = act.assets[i + 1];
      if (tx < x0 || tx >= x1 || ty < y0 || ty >= y1) continue;
      const s = hash(tx, ty);
      trees.push(
        q(tx, x0),
        q(ty, y0),
        Math.round((3.5 + s * 3) * 10),
        Math.round((1.3 + s * 1.2) * 10),
        treeKind(act.genus[i >> 1]),
      );
    }

    const lights: number[] = [];
    for (let i = 0; i < act.lights.length; i += 3) {
      const lx = act.lights[i];
      const ly = act.lights[i + 1];
      if (lx < x0 || lx >= x1 || ly < y0 || ly >= y1) continue;
      lights.push(q(lx, x0), q(ly, y0), Math.round(act.lights[i + 2] * 10));
    }
    const stops: Tile['stops'] = act.stops
      .filter((s) => s.x >= x0 && s.x < x1 && s.y >= y0 && s.y < y1)
      .map((s) => ({ x: q(s.x, x0), y: q(s.y, y0), name: s.name, k: 'bus' as const }));

    const tile: Tile = {
      v: TILE_VERSION,
      x,
      y,
      dem: { min, h: dem },
      buildings,
      roads,
      areas,
      water,
      streams,
      trees,
      lights,
      carparks: assetAreas(act.carparks),
      fields: assetAreas(act.fields),
      stops,
    };
    return { tile, missing };
  }
}

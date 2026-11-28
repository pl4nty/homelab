// Overture Maps tiles (OpenStreetMap, Microsoft ML Buildings and Esri community data, conflated),
// read by HTTP range request from the PMTiles archives Overture publishes for each release.
import { VectorTile, type VectorTileFeature } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { PMTiles, type Source as PmSource, type RangeResponse } from 'pmtiles';
import { K, mercToWorldX, mercToWorldY, tileBoundsMerc } from '../shared/geo.ts';
import { type BBox, cleanRing, clipPolygon, type Ring, ringArea, ringBBox, sliceLine } from '../shared/poly.ts';
import { fetchBuffer } from './net.ts';

const BUCKET = 'https://overturemaps-extras-us-west-2.s3.amazonaws.com';
// tippecanoe's default buffer: 5/256 of the 4096-unit extent each side.
const BUFFER = 64;

export const BUILDING_Z = 14;
export const SEGMENT_Z = 14;
export const BASE_Z = 13;

class RangeSource implements PmSource {
  constructor(private url: string) {}
  getKey() {
    return this.url;
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const buf = await fetchBuffer(this.url, { headers: { range: `bytes=${offset}-${offset + length - 1}` } });
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer };
  }
}

/** Overture keeps about two months of releases, so the newest is looked up, not pinned. */
export async function latestRelease(): Promise<string> {
  const xml = (await fetchBuffer(`${BUCKET}/?list-type=2&prefix=tiles/&delimiter=/`)).toString('utf8');
  const all = [...xml.matchAll(/<Prefix>tiles\/([0-9][^/<]*)\/<\/Prefix>/g)].map((m) => m[1]).sort();
  if (!all.length) throw new Error('no Overture releases listed');
  return all[all.length - 1];
}

export interface OvBuilding {
  id: string;
  rings: Ring[];
  bbox: BBox;
  h?: number;
  mh?: number;
  floors?: number;
  subtype?: string;
  cls?: string;
  roof?: string;
  roofH?: number;
  name?: string;
  hasParts?: boolean;
  /** For a part: the id of the building it belongs to. */
  parent?: string;
  cut?: boolean;
  /** osm or ml. */
  src: string;
  fc?: string;
  rc?: string;
}

export interface OvSegment {
  p: number[];
  c: string;
  s?: string;
  f?: number;
  l?: number;
  /** One-way in the direction drawn. */
  o?: 1;
  name?: string;
}

export interface OvArea {
  rings: Ring[];
  /** Source layer: cover, use, land, water or infra. */
  layer: string;
  k: string;
  name?: string;
  surface?: string;
}

export interface OvBase {
  areas: OvArea[];
  lines: { p: number[]; layer: string; k: string; name?: string }[];
}

type Props = Record<string, string | number | boolean | undefined>;

function toWorld(z: number, x: number, y: number, extent: number) {
  const b = tileBoundsMerc(z, x, y);
  const w = b[2] - b[0];
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    x: (px: number) => r(mercToWorldX(b[0] + (px / extent) * w)),
    y: (py: number) => r(mercToWorldY(b[3] - (py / extent) * w)),
    unit: (w / extent) * K,
  };
}

/** Groups a vector tile polygon's rings into [outline, ...holes] sets, as flat tile-unit rings. */
function polygons(f: VectorTileFeature): Ring[][] {
  const out: Ring[][] = [];
  let sign = 0;
  for (const ring of f.loadGeometry()) {
    const flat: number[] = [];
    for (const pt of ring) flat.push(pt.x, pt.y);
    const a = ringArea(flat);
    if (a === 0) continue;
    if (sign === 0) sign = Math.sign(a);
    if (Math.sign(a) === sign || !out.length) out.push([flat]);
    else out[out.length - 1].push(flat);
  }
  return out;
}

function touchesBuffer(rings: Ring[], extent: number): boolean {
  for (const r of rings) for (const v of r) if (v <= -BUFFER + 1 || v >= extent + BUFFER - 1) return true;
  return false;
}

async function readTile(pm: PMTiles, z: number, x: number, y: number): Promise<VectorTile | null> {
  const res = await pm.getZxy(z, x, y);
  if (!res) return null;
  return new VectorTile(new PbfReader(new Uint8Array(res.data)));
}

function parse<T>(v: unknown): T | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    return JSON.parse(v) as T;
  } catch {
    return undefined;
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export class Overture {
  private pm = new Map<string, PMTiles>();
  constructor(public release: string) {}

  private archive(theme: string): PMTiles {
    let p = this.pm.get(theme);
    if (!p) {
      p = new PMTiles(new RangeSource(`${BUCKET}/tiles/${this.release}/${theme}.pmtiles`));
      this.pm.set(theme, p);
    }
    return p;
  }

  /** Buildings and parts whose centre lies in the tile; anything cut by the tile buffer is trimmed to the tile. */
  async buildings(x: number, y: number): Promise<{ buildings: OvBuilding[]; parts: OvBuilding[] }> {
    const vt = await readTile(this.archive('buildings'), BUILDING_Z, x, y);
    const out = { buildings: [] as OvBuilding[], parts: [] as OvBuilding[] };
    if (!vt) return out;
    for (const [layerName, target] of [
      ['building', out.buildings],
      ['building_part', out.parts],
    ] as const) {
      const layer = vt.layers[layerName];
      if (!layer) continue;
      const w = toWorld(BUILDING_Z, x, y, layer.extent);
      const box: BBox = [0, 0, layer.extent, layer.extent];
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        const p = f.properties as Props;
        if (p.is_underground === true) continue;
        for (let rings of polygons(f)) {
          const cut = touchesBuffer(rings, layer.extent);
          if (cut) {
            rings = clipPolygon(rings, box);
            if (!rings.length) continue;
          } else {
            const b = ringBBox(rings[0]);
            const cx = (b[0] + b[2]) / 2;
            const cy = (b[1] + b[3]) / 2;
            // Half-open, so a building centred on an edge has one owner.
            if (cx < 0 || cy < 0 || cx >= layer.extent || cy >= layer.extent) continue;
          }
          const world = rings.map((r) => {
            const o: number[] = [];
            for (let k = 0; k < r.length; k += 2) o.push(w.x(r[k]), w.y(r[k + 1]));
            return cleanRing(o);
          });
          if (world[0].length < 6) continue;
          const b: OvBuilding = {
            id: String(p.id ?? ''),
            rings: world.filter((r) => r.length >= 6),
            bbox: ringBBox(world[0]),
            src: p['@geometry_source'] === 'OpenStreetMap' ? 'osm' : 'ml',
          };
          b.h = num(p.height);
          b.mh = num(p.min_height);
          b.floors = num(p.num_floors);
          b.subtype = str(p.subtype);
          b.cls = str(p.class);
          b.roof = str(p.roof_shape);
          b.roofH = num(p.roof_height);
          b.name = str(p['@name']);
          b.fc = str(p.facade_color);
          b.rc = str(p.roof_color);
          if (p.has_parts === true) b.hasParts = true;
          if (cut) b.cut = true;
          if (layerName === 'building_part') b.parent = str(p.building_id);
          target.push(b);
        }
      }
    }
    return out;
  }

  /** Road and rail centrelines, split where a bridge, tunnel or level rule starts and ends. */
  async segments(x: number, y: number): Promise<OvSegment[]> {
    const vt = await readTile(this.archive('transportation'), SEGMENT_Z, x, y);
    const layer = vt?.layers.segment;
    const out: OvSegment[] = [];
    if (!layer) return out;
    const w = toWorld(SEGMENT_Z, x, y, layer.extent);
    type Rule<T> = { value?: T; values?: string[]; between?: [number, number] };
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const p = f.properties as Props;
      const subtype = str(p.subtype);
      if (subtype !== 'road' && subtype !== 'rail') continue;
      let cls = str(p.class) ?? 'unknown';
      if (subtype === 'rail') cls = cls === 'light_rail' || cls === 'tram' ? 'tram' : 'rail';
      const flags = parse<Rule<never>[]>(p.road_flags) ?? parse<Rule<never>[]>(p.rail_flags) ?? [];
      const levels = parse<Rule<number>[]>(p.level_rules) ?? [];
      const subs = parse<Rule<string>[]>(p.subclass_rules) ?? [];
      const name = str(p['@name']);
      const access =
        parse<{ access_type?: string; when?: { heading?: string; mode?: string[] } }[]>(p.access_restrictions) ?? [];
      const oneway = access.some((a) => a.access_type === 'denied' && a.when?.heading === 'backward' && !a.when.mode);
      const parts = f.loadGeometry();
      // A line the tile clipped has lost the length its rules are measured along.
      const whole =
        parts.length === 1 &&
        !parts[0].some(
          (pt) =>
            pt.x <= -BUFFER + 1 ||
            pt.y <= -BUFFER + 1 ||
            pt.x >= layer.extent + BUFFER - 1 ||
            pt.y >= layer.extent + BUFFER - 1,
        );
      const cuts = new Set<number>([0, 1]);
      if (whole)
        for (const r of [...flags, ...levels, ...subs]) if (r.between) cuts.add(r.between[0]).add(r.between[1]);
      const stops = [...cuts].sort((a, b) => a - b);
      for (const part of parts) {
        const line: number[] = [];
        for (const pt of part) line.push(w.x(pt.x), w.y(pt.y));
        if (line.length < 4) continue;
        for (let s = 0; s + 1 < stops.length; s++) {
          const a = stops[s];
          const b = stops[s + 1];
          if (b - a < 1e-6) continue;
          const mid = (a + b) / 2;
          const applies = (r: { between?: [number, number] }) =>
            !r.between || (whole ? mid >= r.between[0] && mid <= r.between[1] : r.between[1] - r.between[0] > 0.5);
          let flag = 0;
          for (const r of flags) {
            if (!applies(r)) continue;
            if (r.values?.includes('is_bridge')) flag |= 1;
            if (r.values?.includes('is_tunnel')) flag |= 2;
          }
          const level = levels.find(applies)?.value;
          const sub = subs.find(applies)?.value ?? (subs.length ? undefined : str(p.subclass));
          const piece = stops.length > 2 ? sliceLine(line, a, b) : line;
          if (piece.length < 4) continue;
          const seg: OvSegment = { p: piece.map((v) => Math.round(v * 100) / 100), c: cls };
          if (sub) seg.s = sub;
          if (flag) seg.f = flag;
          if (level) seg.l = level;
          if (oneway) seg.o = 1;
          if (name) seg.name = name;
          out.push(seg);
        }
      }
    }
    return out;
  }

  /** Land cover, land use, natural land, water and bridge or pier outlines. */
  async base(x: number, y: number): Promise<OvBase> {
    const vt = await readTile(this.archive('base'), BASE_Z, x, y);
    const out: OvBase = { areas: [], lines: [] };
    if (!vt) return out;
    const layers: [string, string][] = [
      ['land_cover', 'cover'],
      ['land_use', 'use'],
      ['land', 'land'],
      ['water', 'water'],
      ['infrastructure', 'infra'],
    ];
    for (const [layerName, tag] of layers) {
      const layer = vt.layers[layerName];
      if (!layer) continue;
      const w = toWorld(BASE_Z, x, y, layer.extent);
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        const p = f.properties as Props;
        const subtype = str(p.subtype) ?? '';
        const cls = str(p.class) ?? '';
        if (tag === 'infra' && subtype !== 'bridge' && subtype !== 'pier' && cls !== 'pier' && cls !== 'platform')
          continue;
        if (tag === 'land' && (subtype === 'tree' || cls === 'tree_row')) continue;
        if (typeof p.level === 'number' && p.level < 0) continue;
        const k = tag === 'cover' ? subtype : `${subtype}/${cls}`;
        const name = str(p['@name']);
        if (f.type === 3) {
          for (const rings of polygons(f)) {
            const world = rings
              .map((r) => {
                const o: number[] = [];
                for (let n = 0; n < r.length; n += 2) o.push(w.x(r[n]), w.y(r[n + 1]));
                return cleanRing(o);
              })
              .filter((r) => r.length >= 6);
            if (!world.length) continue;
            const a: OvArea = { rings: world, layer: tag, k };
            if (name) a.name = name;
            const surface = str(p.surface);
            if (surface) a.surface = surface;
            out.areas.push(a);
          }
        } else if (f.type === 2 && tag === 'water') {
          for (const part of f.loadGeometry()) {
            const line: number[] = [];
            for (const pt of part) line.push(w.x(pt.x), w.y(pt.y));
            if (line.length >= 4) out.lines.push({ p: line, layer: tag, k, ...(name ? { name } : {}) });
          }
        }
      }
    }
    return out;
  }
}

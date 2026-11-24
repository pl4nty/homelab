// The baked tile the server sends. Planar coordinates are integers in decimetres from the
// tile's south-west corner (x east, y north); heights are metres unless noted.
export const TILE_VERSION = 5;
export const DEM_N = 64;

export interface Building {
  /** Rings as flat [x0, y0, x1, y1, ...]; the first is the outline, the rest are holes. */
  p: number[][];
  /** Height of the top above the base, metres. */
  h: number;
  /** Height of the underside above the base, for building parts that float. */
  mh?: number;
  /** Use: res, com, ind, edu, civ, rel, med, out, gov, nat, dip, def, tra, rec or '' when unknown. */
  k: string;
  /** Roof shape when the source records one. */
  roof?: string;
  roofH?: number;
  name?: string;
  /** Where the height came from: s = source data, f = floors, e = estimated. */
  hs: 's' | 'f' | 'e';
  /** Cut at a source tile edge, so a pitched roof would not line up. */
  cut?: 1;
  /** Wall and roof colours as 0xRRGGBB when the source records them. */
  fc?: number;
  rc?: number;
}

export interface Road {
  p: number[];
  /** Overture class, or 'rail', 'tram'. */
  c: string;
  /** Subclass such as parking_aisle, driveway, sidewalk, crosswalk. */
  s?: string;
  /** 1 = bridge, 2 = tunnel. */
  f?: number;
  /** Vertical level from the source. */
  l?: number;
  /** One-way in the direction drawn. */
  o?: 1;
  /** For a bridge: ground height in metres at the first and last point. */
  e?: [number, number];
  name?: string;
}

export interface Area {
  p: number[][];
  /** "subtype/class" from the source, such as park/park or recreation/pitch. */
  k: string;
  name?: string;
}

export interface Tile {
  v: number;
  x: number;
  y: number;
  /** Terrain heights, (DEM_N + 1)^2 values row-major from the south-west corner, decimetres above `min`. */
  dem: { min: number; h: number[] };
  buildings: Building[];
  roads: Road[];
  /** Painted on the ground in order: land cover, land use, land. */
  areas: Area[];
  water: Area[];
  /** Watercourses drawn as lines: flat [k, n, x0, y0, ...] is avoided; each entry is a polyline. */
  streams: { p: number[]; k: string }[];
  /** Flat [x, y, height dm, crown radius dm, kind] per tree. */
  trees: number[];
  /** Flat [x, y, height dm] per street light. */
  lights: number[];
  /** Car parks and sports fields from ACT asset registers. */
  carparks: Area[];
  fields: Area[];
  stops: { x: number; y: number; name: string; k: 'bus' | 'tram' }[];
}

export enum TreeKind {
  Eucalypt = 0,
  Deciduous = 1,
  Conifer = 2,
  Columnar = 3,
  Evergreen = 4,
}

export interface LiveVehicle {
  id: string;
  k: 'tram' | 'bus';
  route: string;
  headsign?: string;
  /** Trams: the shape the trip follows, and [unix seconds, metres along it, ...] around now. */
  shape?: string;
  knots?: number[];
  /** Buses: reported position in world metres, degrees clockwise from north, and when it was reported. */
  x?: number;
  y?: number;
  bearing?: number;
  at?: number;
}

export interface LiveFeed {
  ts: number;
  vehicles: LiveVehicle[];
  sources: { name: string; ok: boolean; note?: string }[];
}

export interface Transit {
  /** Light rail track centrelines by GTFS shape id, flat world [x, y, ...]. */
  shapes: Record<string, number[]>;
  stations: { x: number; y: number; name: string }[];
}

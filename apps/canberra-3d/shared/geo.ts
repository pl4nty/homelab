// World frame: Web Mercator scaled to metres at Capital Hill, x east and y north.
// Distances are within half a percent of true: spherical Mercator stretches north-south by 0.3%
// on the ellipsoid, and the scale drifts 0.2% over 20 km of latitude.
export const EARTH_R = 6378137;
export const HALF = Math.PI * EARTH_R;
export const ORIGIN = { lon: 149.1244, lat: -35.3082 };
export const TILE_Z = 15;

const D2R = Math.PI / 180;
export const K = Math.cos(ORIGIN.lat * D2R);

export const mercX = (lon: number) => EARTH_R * lon * D2R;
export const mercY = (lat: number) => EARTH_R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
export const MX0 = mercX(ORIGIN.lon);
export const MY0 = mercY(ORIGIN.lat);

export const mercToWorldX = (mx: number) => (mx - MX0) * K;
export const mercToWorldY = (my: number) => (my - MY0) * K;
export const worldToMercX = (x: number) => x / K + MX0;
export const worldToMercY = (y: number) => y / K + MY0;

export function lonLatToWorld(lon: number, lat: number): [number, number] {
  return [mercToWorldX(mercX(lon)), mercToWorldY(mercY(lat))];
}

export function worldToLonLat(x: number, y: number): [number, number] {
  const mx = worldToMercX(x);
  const my = worldToMercY(y);
  return [mx / EARTH_R / D2R, (2 * Math.atan(Math.exp(my / EARTH_R)) - Math.PI / 2) / D2R];
}

/** Mercator bounds of an XYZ tile as [minX, minY, maxX, maxY]. */
export function tileBoundsMerc(z: number, x: number, y: number): [number, number, number, number] {
  const w = (2 * HALF) / 2 ** z;
  return [x * w - HALF, HALF - (y + 1) * w, (x + 1) * w - HALF, HALF - y * w];
}

export function tileBoundsWorld(z: number, x: number, y: number): [number, number, number, number] {
  const b = tileBoundsMerc(z, x, y);
  return [mercToWorldX(b[0]), mercToWorldY(b[1]), mercToWorldX(b[2]), mercToWorldY(b[3])];
}

/** Side of a world tile in metres (about 998 m). */
export const TILE_SIZE = ((2 * HALF) / 2 ** TILE_Z) * K;

export function worldToTile(x: number, y: number, z = TILE_Z): [number, number] {
  const w = (2 * HALF) / 2 ** z;
  return [Math.floor((worldToMercX(x) + HALF) / w), Math.floor((HALF - worldToMercY(y)) / w)];
}

/** Tiles the app will serve: the ACT and a margin of NSW around Queanbeyan. */
export const EXTENT = { west: 148.74, south: -35.95, east: 149.42, north: -35.1 };

export function tileInExtent(x: number, y: number): boolean {
  const [x0, y1] = worldToTile(...lonLatToWorld(EXTENT.west, EXTENT.south));
  const [x1, y0] = worldToTile(...lonLatToWorld(EXTENT.east, EXTENT.north));
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

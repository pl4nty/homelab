// ACT Government open data, served as ArcGIS Online feature layers.
import { mercToWorldX, mercToWorldY, tileBoundsMerc } from '../shared/geo.ts';
import { type BBox, cleanRing, type Ring, ringArea, ringBBox } from '../shared/poly.ts';
import { fetchJson } from './net.ts';

export const ACT_SERVICES = 'https://services1.arcgis.com/E5n4f1VY84i0xSjy/arcgis/rest/services';
export const ACT_Z = 14;

interface EsriFeature {
  attributes: Record<string, string | number | null>;
  geometry?: { x?: number; y?: number; rings?: number[][][]; paths?: number[][][] };
}
interface EsriResult {
  features?: EsriFeature[];
  exceededTransferLimit?: boolean;
  error?: { code: number; message: string };
}

/** Every feature of a layer that meets a Web Mercator box, following the server's paging. */
export async function queryLayer(
  service: string,
  layer: number,
  fields: string[],
  box?: BBox,
  where = '1=1',
): Promise<EsriFeature[]> {
  const out: EsriFeature[] = [];
  for (let offset = 0; offset < 200000; ) {
    const u = new URL(`${ACT_SERVICES}/${service}/FeatureServer/${layer}/query`);
    const q: Record<string, string> = {
      where,
      outFields: fields.join(','),
      outSR: '3857',
      geometryPrecision: '2',
      resultType: 'tile',
      resultOffset: String(offset),
      orderByFields: 'OBJECTID',
      f: 'json',
    };
    if (box) {
      q.geometry = box.join(',');
      q.geometryType = 'esriGeometryEnvelope';
      q.inSR = '3857';
      q.spatialRel = 'esriSpatialRelIntersects';
    }
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    const res = await fetchJson<EsriResult>(u.toString());
    if (res.error) throw new Error(`ArcGIS ${service}: ${res.error.message}`);
    const got = res.features ?? [];
    out.push(...got);
    if (!res.exceededTransferLimit || !got.length) break;
    offset += got.length;
  }
  return out;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

function worldRings(rings: number[][][]): Ring[][] {
  const polys: Ring[][] = [];
  let sign = 0;
  for (const ring of rings) {
    const flat: number[] = [];
    for (const [mx, my] of ring) flat.push(r2(mercToWorldX(mx)), r2(mercToWorldY(my)));
    const clean = cleanRing(flat);
    if (clean.length < 6) continue;
    const a = ringArea(clean);
    if (sign === 0) sign = Math.sign(a);
    if (Math.sign(a) === sign || !polys.length) polys.push([clean]);
    else polys[polys.length - 1].push(clean);
  }
  return polys;
}

export interface ActPolygon {
  rings: Ring[];
  bbox: BBox;
  /** Layer-specific label: building type, car park type, field surface. */
  k: string;
  use?: string;
  name?: string;
}

export interface ActBlock {
  footprints: ActPolygon[];
  /** Flat [x, y, crown height m, canopy area m2] from the 2020 LiDAR survey. */
  crowns: number[];
  /** Flat [x, y] of street and park trees, with the genus of each alongside. */
  assets: number[];
  genus: string[];
  /** Flat [x, y, column height m]. */
  lights: number[];
  carparks: ActPolygon[];
  fields: ActPolygon[];
  stops: { x: number; y: number; name: string }[];
}

/** One z14 block of ACT data. Polygons belong to the block that holds their centre; points to the block they fall in. */
export async function actBlock(x: number, y: number): Promise<ActBlock> {
  const box = tileBoundsMerc(ACT_Z, x, y);
  const owns = (mx: number, my: number) => mx >= box[0] && mx < box[2] && my >= box[1] && my < box[3];
  const polygonsOf = (features: EsriFeature[], label: (a: EsriFeature['attributes']) => Partial<ActPolygon>) => {
    const out: ActPolygon[] = [];
    for (const f of features) {
      if (!f.geometry?.rings) continue;
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const [mx, my] of f.geometry.rings[0] ?? []) {
        cx += mx;
        cy += my;
        n++;
      }
      if (!n || !owns(cx / n, cy / n)) continue;
      for (const rings of worldRings(f.geometry.rings))
        out.push({ rings, bbox: ringBBox(rings[0]), k: '', ...label(f.attributes) });
    }
    return out;
  };
  const points = (features: EsriFeature[]) =>
    features.filter((f) => f.geometry?.x != null && owns(f.geometry.x, f.geometry.y!));

  const [footprints, crowns, assets, lights, carparks, fields, stops] = await Promise.all([
    queryLayer(
      'ACTGOV_BUILDING_FOOTPRINTS',
      0,
      ['BUILDING_TYPE', 'USE_DESCRIPTION'],
      box,
      "CURRENT_LIFECYCLE_STAGE IN ('CONSTRUCTED','OPERATIONAL')",
    ),
    queryLayer('ACTGOV_Mature_Trees_2020_Centre_Points', 0, ['crownHeight', 'canopyArea'], box),
    queryLayer('ACTGOV_Tree_Assets', 0, ['GENUS'], box),
    queryLayer('ACTGOV_Streetlight_Column_Assets', 1, ['COLUMN_HEIGHT'], box),
    queryLayer('ACTGOV_Car_Park_Assets', 1, ['CAR_PARK_TYPE', 'ASSET_NAME'], box),
    queryLayer('ACTGOV_Sports_Field_Assets', 1, ['ASSET_SUB_TYPE', 'SURFACE_MATERIAL', 'ASSET_NAME'], box),
    queryLayer('Transport_Canberra_Bus_Stop_view', 1, ['BUS_STOP_NAME'], box),
  ]);

  const block: ActBlock = {
    footprints: polygonsOf(footprints, (a) => ({
      k: String(a.BUILDING_TYPE ?? ''),
      use: a.USE_DESCRIPTION ? String(a.USE_DESCRIPTION) : undefined,
    })),
    crowns: [],
    assets: [],
    genus: [],
    lights: [],
    carparks: polygonsOf(carparks, (a) => ({
      k: String(a.CAR_PARK_TYPE ?? ''),
      name: a.ASSET_NAME ? String(a.ASSET_NAME) : undefined,
    })),
    fields: polygonsOf(fields, (a) => ({
      k: `${a.ASSET_SUB_TYPE ?? ''}/${a.SURFACE_MATERIAL ?? ''}`,
      name: a.ASSET_NAME ? String(a.ASSET_NAME) : undefined,
    })),
    stops: [],
  };
  for (const f of points(crowns)) {
    const h = Number(f.attributes.crownHeight) || 0;
    const area = Number(f.attributes.canopyArea) || 0;
    if (h < 2) continue;
    block.crowns.push(
      r2(mercToWorldX(f.geometry!.x!)),
      r2(mercToWorldY(f.geometry!.y!)),
      Math.round(h * 10) / 10,
      Math.round(area),
    );
  }
  for (const f of points(assets)) {
    block.assets.push(r2(mercToWorldX(f.geometry!.x!)), r2(mercToWorldY(f.geometry!.y!)));
    block.genus.push(String(f.attributes.GENUS ?? ''));
  }
  for (const f of points(lights)) {
    block.lights.push(
      r2(mercToWorldX(f.geometry!.x!)),
      r2(mercToWorldY(f.geometry!.y!)),
      Number(f.attributes.COLUMN_HEIGHT) || 9,
    );
  }
  for (const f of points(stops)) {
    block.stops.push({
      x: r2(mercToWorldX(f.geometry!.x!)),
      y: r2(mercToWorldY(f.geometry!.y!)),
      name: String(f.attributes.BUS_STOP_NAME ?? ''),
    });
  }
  return block;
}

export interface LightRail {
  /** Centreline from Alinga Street to Gungahlin Place, flat world [x, y, ...]. */
  line: number[];
  stations: { x: number; y: number; name: string }[];
}

export async function lightRail(): Promise<LightRail> {
  const [routes, stations] = await Promise.all([
    queryLayer('Transport_Canberra_Light_Rail_Route_view', 1, ['LIGHT_RAIL_ROUTE_NAME']),
    queryLayer('Transport_Canberra_Light_Rail_Station_view', 1, ['LIGHT_RAIL_STOP_NAME']),
  ]);
  let line: number[] = [];
  for (const f of routes) {
    for (const path of f.geometry?.paths ?? []) {
      const flat: number[] = [];
      for (const [mx, my] of path) flat.push(r2(mercToWorldX(mx)), r2(mercToWorldY(my)));
      if (flat.length > line.length) line = flat;
    }
  }
  // South to north, so a fraction along it reads as progress towards Gungahlin.
  if (line.length >= 4 && line[1] > line[line.length - 1]) {
    const rev: number[] = [];
    for (let i = line.length - 2; i >= 0; i -= 2) rev.push(line[i], line[i + 1]);
    line = rev;
  }
  return {
    line,
    stations: stations
      .filter((f) => f.geometry?.x != null)
      .map((f) => ({
        x: r2(mercToWorldX(f.geometry!.x!)),
        y: r2(mercToWorldY(f.geometry!.y!)),
        name: String(f.attributes.LIGHT_RAIL_STOP_NAME ?? ''),
      })),
  };
}

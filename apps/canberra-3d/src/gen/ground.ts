// Paints a tile's ground as one texture: land cover, roads, markings, paths and soft shade under
// buildings and trees. It is far cheaper than geometry and reads well from the air.
import { TILE_SIZE } from '../../shared/geo.ts';
import type { Area, Road, Tile } from '../../shared/tile.ts';
import { GROUND as G } from './palette.ts';
import { hash2 } from './types.ts';

/** Carriageway width in metres by road class. */
export function roadWidth(r: Road): number {
  switch (r.c) {
    case 'motorway':
      return r.s === 'link' ? 6.5 : 9.5;
    case 'trunk':
      return r.s === 'link' ? 6 : 8.5;
    case 'primary':
      return r.s === 'link' ? 6 : 8.5;
    case 'secondary':
      return 8;
    case 'tertiary':
      return 7.5;
    case 'residential':
      return 7;
    case 'unclassified':
      return 6.5;
    case 'living_street':
      return 5.5;
    case 'service':
      return r.s === 'driveway' ? 2.8 : r.s === 'parking_aisle' ? 5.6 : r.s === 'alley' ? 3.4 : 4.2;
    case 'pedestrian':
      return 4;
    case 'cycleway':
      return 2.6;
    case 'footway':
      return r.s === 'crosswalk' ? 2.4 : 1.7;
    case 'steps':
      return 1.8;
    case 'path':
      return 1.4;
    case 'track':
    case 'bridleway':
      return 2.6;
    case 'rail':
      return 3.2;
    case 'tram':
      return 3;
    default:
      return 4;
  }
}

const MAJOR = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'unclassified',
  'living_street',
]);

function areaColour(k: string): string | null {
  const [a, b, c] = k.split('/');
  if (a === 'cover') {
    return (
      {
        forest: G.coverForest,
        shrub: G.scrub,
        urban: G.yard,
        barren: G.barren,
        crop: G.farm,
        grass: G.grass,
        wetland: G.wetland,
        moss: G.grass,
      }[b] ?? null
    );
  }
  switch (a) {
    case 'residential':
      return G.yard;
    case 'park':
      return G.lawn;
    case 'managed':
      return b === 'grass' || b === 'village_green' ? G.lawn : G.garden;
    case 'horticulture':
      return b === 'flowerbed' ? '#b96a8f' : G.garden;
    case 'recreation':
      if (b === 'pitch' || b === 'track') {
        if (c === 'recreation_paved' || c === 'acrylic' || c === 'asphalt' || c === 'concrete') return G.court;
        if (c === 'clay' || c === 'recreation_sand' || c === 'tartan') return G.courtClay;
        return G.pitch;
      }
      if (b === 'playground') return '#dcc9a0';
      if (b === 'marina' || b === 'water_park') return null;
      return G.lawn;
    case 'golf':
      if (b === 'bunker') return G.sand;
      if (b === 'green' || b === 'tee') return '#8fdd69';
      if (b === 'fairway' || b === 'driving_range') return '#7ccc5e';
      if (b === 'water_hazard' || b === 'lateral_water_hazard') return G.water;
      return '#86b862';
    case 'education':
    case 'religious':
    case 'medical':
      return '#9bbf70';
    case 'developed':
      return G.paved;
    case 'construction':
    case 'landfill':
    case 'resource_extraction':
      return G.dirt;
    case 'pedestrian':
      return G.plaza;
    case 'cemetery':
      return '#8db873';
    case 'military':
      return '#9bb071';
    case 'transportation':
      return G.apron;
    case 'agriculture':
      return G.farm;
    case 'campground':
      return G.lawn;
    case 'forest':
      return G.forest;
    case 'shrub':
      return G.scrub;
    case 'grass':
      return b === 'meadow' ? G.farm : G.grass;
    case 'rock':
      return G.rock;
    case 'sand':
      return G.sand;
    case 'wetland':
      return G.wetland;
    case 'barren':
      return G.barren;
    case 'bridge':
    case 'pier':
      return null;
    default:
      return null;
  }
}

export function paintGround(tile: Tile, res: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(res, res);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  // Tile coordinates are decimetres with y north; the canvas has y down from the north edge.
  const s = res / (TILE_SIZE * 10);
  const m = res / TILE_SIZE; // pixels per metre
  ctx.setTransform(s, 0, 0, -s, 0, res);

  const trace = (rings: number[][]) => {
    ctx.beginPath();
    for (const r of rings) {
      ctx.moveTo(r[0], r[1]);
      for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i], r[i + 1]);
      ctx.closePath();
    }
  };
  const fillArea = (a: Area, colour: string) => {
    trace(a.p);
    ctx.fillStyle = colour;
    ctx.fill('evenodd');
  };

  ctx.fillStyle = G.base;
  ctx.fillRect(-100, -100, TILE_SIZE * 10 + 200, TILE_SIZE * 10 + 200);

  for (const a of tile.areas) {
    const colour = areaColour(a.k);
    if (colour) fillArea(a, colour);
  }

  // Mottle the grass so large areas are not one flat colour. Seeded by position, so tiles agree.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (let i = 0; i < 260; i++) {
    const px = hash2(tile.x * 977 + i, tile.y * 131) * res;
    const py = hash2(tile.x * 31 + i * 7, tile.y * 613 + i) * res;
    const r = (10 + hash2(i, tile.x + tile.y) * 46) * (res / 1024);
    const g = ctx.createRadialGradient(px, py, 0, px, py, r);
    const dark = hash2(i * 13, tile.y) > 0.5;
    g.addColorStop(0, dark ? 'rgba(40,70,20,0.10)' : 'rgba(230,235,150,0.10)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(px - r, py - r, r * 2, r * 2);
  }
  ctx.restore();

  // Sports pitches get mowing stripes; ACT's field register adds any the map lacks.
  for (const f of tile.fields) {
    if (/SYNTHETIC|GRASS|TURF|^[^/]*\/$/i.test(f.k) || !/HARD|CONCRETE|ASPHALT|BITUMEN/i.test(f.k))
      fillArea(f, G.pitch);
    else fillArea(f, G.court);
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  for (const a of [
    ...tile.areas.filter((a) => a.k.startsWith('recreation/pitch') || a.k.startsWith('recreation/track')),
    ...tile.fields,
  ]) {
    trace(a.p);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 6;
    ctx.stroke();
  }

  for (const w of tile.water) fillArea(w, w.k.includes('swimming_pool') ? G.pool : G.water);
  ctx.lineCap = 'round';
  for (const st of tile.streams) {
    ctx.beginPath();
    ctx.moveTo(st.p[0], st.p[1]);
    for (let i = 2; i < st.p.length; i += 2) ctx.lineTo(st.p[i], st.p[i + 1]);
    ctx.strokeStyle = G.water;
    ctx.globalAlpha = st.k.startsWith('river') ? 1 : 0.7;
    ctx.lineWidth = st.k.startsWith('river') ? 60 : st.k.startsWith('canal') || st.k.includes('drain') ? 16 : 22;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (const c of tile.carparks) fillArea(c, G.carpark);

  // --- roads, lowest class first so junctions resolve in favour of the bigger road
  const order = [
    'track',
    'bridleway',
    'path',
    'steps',
    'footway',
    'cycleway',
    'pedestrian',
    'service',
    'living_street',
    'unclassified',
    'residential',
    'tertiary',
    'secondary',
    'primary',
    'trunk',
    'motorway',
    'rail',
    'tram',
  ];
  const byClass = new Map<string, Road[]>();
  for (const r of tile.roads) {
    if (r.f) continue; // bridges are built as decks; tunnels are out of sight
    const list = byClass.get(r.c);
    if (list) list.push(r);
    else byClass.set(r.c, [r]);
  }
  const strokeRoads = (roads: Road[], colour: string, extra: number, scale = 1, dash?: number[]) => {
    const byWidth = new Map<number, Road[]>();
    for (const r of roads) {
      const w = roadWidth(r) * scale + extra;
      const l = byWidth.get(w);
      if (l) l.push(r);
      else byWidth.set(w, [r]);
    }
    ctx.strokeStyle = colour;
    ctx.setLineDash(dash ?? []);
    for (const [w, list] of byWidth) {
      ctx.beginPath();
      for (const r of list) {
        ctx.moveTo(r.p[0], r.p[1]);
        for (let i = 2; i < r.p.length; i += 2) ctx.lineTo(r.p[i], r.p[i + 1]);
      }
      ctx.lineWidth = w * 10;
      ctx.stroke();
    }
    ctx.setLineDash([]);
  };
  // Kerbs first, across all sealed roads, so one road's kerb never crosses another's surface.
  const sealed = tile.roads.filter((r) => !r.f && MAJOR.has(r.c));
  strokeRoads(sealed, G.kerb, 1.3);
  for (const cls of order) {
    const roads = byClass.get(cls);
    if (!roads) continue;
    switch (cls) {
      case 'track':
      case 'bridleway':
        strokeRoads(roads, G.track, 0);
        break;
      case 'path':
        strokeRoads(roads, G.track, 0);
        break;
      case 'footway':
      case 'steps': {
        const cross = roads.filter((r) => r.s === 'crosswalk');
        strokeRoads(
          roads.filter((r) => r.s !== 'crosswalk'),
          G.footway,
          0,
        );
        ctx.lineCap = 'butt';
        strokeRoads(cross, G.marking, 0, 1, [6, 6]);
        ctx.lineCap = 'round';
        break;
      }
      case 'cycleway':
        strokeRoads(roads, G.cycleway, 0);
        break;
      case 'pedestrian':
        strokeRoads(roads, G.plaza, 0);
        break;
      case 'service':
        strokeRoads(roads, G.asphaltLight, 0);
        break;
      case 'rail':
        strokeRoads(roads, G.ballast, 0);
        strokeRoads(roads, G.rail, 0, 0.5);
        strokeRoads(roads, G.ballast, 0, 0.38);
        break;
      case 'tram':
        strokeRoads(roads, G.tramBed, 0.4);
        strokeRoads(roads, G.rail, 0, 0.52);
        strokeRoads(roads, G.tramBed, 0, 0.42);
        break;
      default:
        strokeRoads(roads, G.asphalt, 0);
    }
  }
  // Markings once every surface is down.
  ctx.lineCap = 'butt';
  if (m >= 0.9) {
    for (const cls of ['motorway', 'trunk', 'primary']) {
      const roads = (byClass.get(cls) ?? []).filter((r) => r.s !== 'link');
      // Edge lines: a white band just inside the kerb, then the lanes painted back over it.
      strokeRoads(roads, G.marking, -0.9);
      strokeRoads(roads, G.asphalt, -1.5);
      strokeRoads(roads, G.marking, 0, 0.022, [30, 90]);
    }
    for (const cls of ['secondary', 'tertiary']) strokeRoads(byClass.get(cls) ?? [], G.marking, 0, 0.022, [30, 90]);
  }
  ctx.lineCap = 'round';

  // --- shade: a soft dark skirt round each building, a pad beneath it, and a blot under each tree
  ctx.save();
  ctx.shadowColor = 'rgba(20,30,40,0.55)';
  ctx.shadowBlur = 5 * m;
  ctx.fillStyle = G.pad;
  for (const b of tile.buildings) {
    if (b.mh) continue;
    trace(b.p);
    ctx.fill('evenodd');
  }
  ctx.restore();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const t = tile.trees;
  for (let i = 0; i < t.length; i += 5) {
    const px = t[i] * s;
    const py = res - t[i + 1] * s;
    const r = Math.max(1.5, (t[i + 3] / 10) * m * 1.15);
    const g = ctx.createRadialGradient(px, py, r * 0.2, px, py, r);
    g.addColorStop(0, 'rgba(28,58,22,0.42)');
    g.addColorStop(1, 'rgba(28,58,22,0)');
    ctx.fillStyle = g;
    ctx.fillRect(px - r, py - r, r * 2, r * 2);
  }
  return canvas;
}

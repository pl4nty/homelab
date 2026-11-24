// Turns a baked tile into render-ready buffers. Runs in a worker.
import earcut from 'earcut';
import { TILE_SIZE } from '../../shared/geo.ts';
import { lineLength, pointInPolygon, ringArea, ringBBox } from '../../shared/poly.ts';
import { DEM_N, type Road, type Tile } from '../../shared/tile.ts';
import { buildBuildings } from './buildings.ts';
import { paintGround, roadWidth } from './ground.ts';
import { BASE, type Built, hash2, type Label, MeshBuilder } from './types.ts';

const N = DEM_N + 1;
const STEP = TILE_SIZE / DEM_N;

const DECK = 0x4f525a;
const CONCRETE = 0xc9c5b8;
const CONCRETE_DARK = 0xa9a598;

function deckProfile(r: Road, hAt: (x: number, y: number) => number) {
  const p = r.p.map((v) => v / 10);
  const total = lineLength(p) || 1;
  const e0 = (r.e?.[0] ?? BASE) - BASE;
  const e1 = (r.e?.[1] ?? BASE) - BASE;
  // A slight camber, and never below the ground it crosses.
  const camber = Math.min(1.2, total * 0.006);
  const pts: { x: number; y: number; h: number; ground: number }[] = [];
  let acc = 0;
  for (let i = 0; i < p.length; i += 2) {
    if (i) acc += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    const t = acc / total;
    const ground = hAt(p[i], p[i + 1]);
    const h = Math.max(e0 + (e1 - e0) * t + Math.sin(Math.PI * t) * camber, ground) + 0.45;
    pts.push({ x: p[i], y: p[i + 1], h, ground });
  }
  return { pts, total };
}

function buildBridges(tile: Tile, hAt: (x: number, y: number) => number): MeshBuilder {
  const mb = new MeshBuilder();
  for (const r of tile.roads) {
    if (r.f !== 1) continue;
    const { pts } = deckProfile(r, hAt);
    if (pts.length < 2) continue;
    const foot = r.c === 'footway' || r.c === 'path' || r.c === 'cycleway' || r.c === 'steps' || r.c === 'pedestrian';
    const half = roadWidth(r) / 2 + (foot ? 0.5 : 1.1);
    const depth = foot ? 0.5 : 1.3;
    const surface = foot ? 0xcfc8b6 : r.c === 'rail' || r.c === 'tram' ? 0x8a857c : DECK;
    const rail = foot ? 1.1 : 0.9;
    // Offset each point to both sides along the averaged direction of its neighbours.
    const left: number[][] = [];
    const right: number[][] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      left.push([pts[i].x + nx * half, pts[i].h, -(pts[i].y + ny * half)]);
      right.push([pts[i].x - nx * half, pts[i].h, -(pts[i].y - ny * half)]);
    }
    const down = (p: number[], d: number) => [p[0], p[1] - d, p[2]];
    const up = (p: number[], d: number) => [p[0], p[1] + d, p[2]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const l0 = left[i];
      const l1 = left[i + 1];
      const r0 = right[i];
      const r1 = right[i + 1];
      mb.quad(r0, r1, l1, l0, surface);
      mb.quad(l0, l1, down(l1, depth), down(l0, depth), CONCRETE);
      mb.quad(r1, r0, down(r0, depth), down(r1, depth), CONCRETE);
      mb.quad(down(l0, depth), down(l1, depth), down(r1, depth), down(r0, depth), CONCRETE_DARK);
      // Parapets, seen from both sides.
      mb.quad(l1, l0, up(l0, rail), up(l1, rail), CONCRETE);
      mb.quad(l0, l1, up(l1, rail), up(l0, rail), CONCRETE);
      mb.quad(r0, r1, up(r1, rail), up(r0, rail), CONCRETE);
      mb.quad(r1, r0, up(r0, rail), up(r1, rail), CONCRETE);
    }
    // Piers wherever the deck stands clear of the ground.
    let since = 12;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / (seg || 1);
      const uy = (b.y - a.y) / (seg || 1);
      for (let d = 28 - since; d < seg; d += 28) {
        const t = d / seg;
        const px = a.x + (b.x - a.x) * t;
        const py = a.y + (b.y - a.y) * t;
        const top = a.h + (b.h - a.h) * t - depth;
        const ground = hAt(px, py) - 2;
        if (top - ground < 3.5) continue;
        const w = foot ? 0.35 : 0.8;
        mb.box(
          px,
          -py,
          ux * w,
          -uy * w,
          -uy * (half - 0.6),
          -ux * (half - 0.6),
          ground,
          top,
          CONCRETE_DARK,
          CONCRETE_DARK,
        );
      }
      since = (since + seg) % 28;
    }
  }
  return mb;
}

export function buildTile(tile: Tile, res: number, missing: string): Built {
  // --- terrain heights, mutable so water can press them down
  const heights = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) heights[i] = tile.dem.min + tile.dem.h[i] / 10 - BASE;
  const hAt = (x: number, y: number): number => {
    const fx = Math.min(DEM_N, Math.max(0, x / STEP));
    const fy = Math.min(DEM_N, Math.max(0, y / STEP));
    const ix = Math.min(DEM_N - 1, Math.floor(fx));
    const iy = Math.min(DEM_N - 1, Math.floor(fy));
    const ax = fx - ix;
    const ay = fy - iy;
    const i = iy * N + ix;
    return (
      (heights[i] * (1 - ax) + heights[i + 1] * ax) * (1 - ay) +
      (heights[i + N] * (1 - ax) + heights[i + N + 1] * ax) * ay
    );
  };

  // --- water: still water lies flat at its lowest bank, running water follows the bed
  const surface = new Float32Array(N * N).fill(Number.NaN);
  const wPos: number[] = [];
  const wIdx: number[] = [];
  for (const w of tile.water) {
    if (w.k.includes('swimming_pool') || w.k.includes('fountain')) continue;
    const rings = w.p.map((r) => r.map((v) => v / 10));
    const area = Math.abs(ringArea(rings[0]));
    if (area < 250) continue;
    const samples: number[] = [];
    for (const r of rings) for (let i = 0; i < r.length; i += 2) samples.push(hAt(r[i], r[i + 1]));
    const box = ringBBox(rings[0]);
    const i0 = Math.max(0, Math.floor(box[0] / STEP));
    const i1 = Math.min(DEM_N, Math.ceil(box[2] / STEP));
    const j0 = Math.max(0, Math.floor(box[1] / STEP));
    const j1 = Math.min(DEM_N, Math.ceil(box[3] / STEP));
    const inside: number[] = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (pointInPolygon(i * STEP, j * STEP, rings)) {
          inside.push(j * N + i);
          samples.push(heights[j * N + i]);
        }
      }
    }
    // The level is a low percentile, not the minimum: one bad elevation sample must not drain a lake.
    samples.sort((a, b) => a - b);
    const lo = samples[Math.floor(samples.length * 0.15)];
    const hi = samples[Math.floor(samples.length * 0.9)];
    const flat = hi - lo < 4 || w.k.startsWith('lake') || w.k.startsWith('reservoir');
    const coords: number[] = [];
    const holes: number[] = [];
    for (const [i, r] of rings.entries()) {
      if (i) holes.push(coords.length / 2);
      coords.push(...r);
    }
    const first = wPos.length / 3;
    for (let i = 0; i < coords.length; i += 2)
      wPos.push(coords[i], flat ? lo + 0.3 : hAt(coords[i], coords[i + 1]) + 0.3, -coords[i + 1]);
    const tris = earcut(coords, holes);
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i];
      const b = tris[i + 1];
      const c = tris[i + 2];
      const cross =
        (coords[b * 2] - coords[a * 2]) * (coords[c * 2 + 1] - coords[a * 2 + 1]) -
        (coords[b * 2 + 1] - coords[a * 2 + 1]) * (coords[c * 2] - coords[a * 2]);
      if (cross > 0) wIdx.push(first + a, first + b, first + c);
      else wIdx.push(first + a, first + c, first + b);
    }
    for (const i of inside) {
      // What a vehicle rides on: the water's surface, not its bed.
      surface[i] = flat ? lo + 0.3 : heights[i] + 0.3;
      heights[i] = flat ? Math.min(heights[i], lo) - 1.6 : heights[i] - 1.2;
    }
  }
  for (let i = 0; i < N * N; i++) if (Number.isNaN(surface[i])) surface[i] = heights[i];

  // --- terrain mesh
  const pos = new Float32Array(N * N * 3);
  const normal = new Float32Array(N * N * 3);
  const uv = new Float32Array(N * N * 2);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      pos[k * 3] = i * STEP;
      pos[k * 3 + 1] = heights[k];
      pos[k * 3 + 2] = -j * STEP;
      uv[k * 2] = i / DEM_N;
      uv[k * 2 + 1] = 1 - j / DEM_N;
      const hx = heights[j * N + Math.min(DEM_N, i + 1)] - heights[j * N + Math.max(0, i - 1)];
      const hy = heights[Math.min(DEM_N, j + 1) * N + i] - heights[Math.max(0, j - 1) * N + i];
      const sx = (Math.min(DEM_N, i + 1) - Math.max(0, i - 1)) * STEP;
      const sy = (Math.min(DEM_N, j + 1) - Math.max(0, j - 1)) * STEP;
      let nx = -hx / sx;
      let nz = hy / sy;
      const l = Math.hypot(nx, 1, nz);
      nx /= l;
      nz /= l;
      normal[k * 3] = nx;
      normal[k * 3 + 1] = 1 / l;
      normal[k * 3 + 2] = nz;
    }
  }
  const index = new Uint32Array(DEM_N * DEM_N * 6);
  let n = 0;
  for (let j = 0; j < DEM_N; j++) {
    for (let i = 0; i < DEM_N; i++) {
      const a = j * N + i;
      index[n++] = a;
      index[n++] = a + 1;
      index[n++] = a + N + 1;
      index[n++] = a;
      index[n++] = a + N + 1;
      index[n++] = a + N;
    }
  }

  const labels: Label[] = [];
  const landmarks: Built['landmarks'] = [];
  const buildings = buildBuildings(tile, hAt, labels, landmarks);
  const bridges = buildBridges(tile, hAt);

  // --- trees
  const trees = new Float32Array((tile.trees.length / 5) * 7);
  for (let i = 0, o = 0; i < tile.trees.length; i += 5, o += 7) {
    const x = tile.trees[i] / 10;
    const y = tile.trees[i + 1] / 10;
    trees[o] = x;
    trees[o + 1] = hAt(x, y);
    trees[o + 2] = -y;
    trees[o + 3] = tile.trees[i + 2] / 10;
    trees[o + 4] = tile.trees[i + 3] / 10;
    trees[o + 5] = tile.trees[i + 4];
    trees[o + 6] = hash2(tile.trees[i] + tile.x * 131, tile.trees[i + 1] + tile.y * 977);
  }

  // --- parked cars: nose-in along car park aisles, and the odd one at the kerb of a street
  const footprints = tile.buildings
    .filter((b) => !b.mh)
    .map((b) => {
      const rings = b.p.map((r) => r.map((v) => v / 10));
      return { rings, box: ringBBox(rings[0]) };
    });
  const blocked = (x: number, y: number) => {
    for (const f of footprints) {
      if (x < f.box[0] - 1 || x > f.box[2] + 1 || y < f.box[1] - 1 || y > f.box[3] + 1) continue;
      if (pointInPolygon(x, y, f.rings)) return true;
    }
    return false;
  };
  const cars: number[] = [];
  const lanes: number[] = [];
  for (const r of tile.roads) {
    if (r.f === 2) continue;
    const p = r.p.map((v) => v / 10);
    const aisle = r.c === 'service' && r.s === 'parking_aisle';
    const street = r.c === 'residential' && !r.f;
    if ((aisle || street) && cars.length < 5 * 3500) {
      const spacing = aisle ? 2.7 : 6.2;
      const offset = aisle ? 5.3 : roadWidth(r) / 2 - 1.15;
      let carry = spacing / 2;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const dx = p[i + 2] - p[i];
        const dy = p[i + 3] - p[i + 1];
        const len = Math.hypot(dx, dy);
        if (len < 0.01) continue;
        const ux = dx / len;
        const uy = dy / len;
        for (let d = carry; d < len; d += spacing) {
          for (const side of [1, -1]) {
            const cx = p[i] + ux * d - uy * offset * side;
            const cy = p[i + 1] + uy * d + ux * offset * side;
            if (cx < 0 || cy < 0 || cx >= TILE_SIZE || cy >= TILE_SIZE) continue;
            const roll = hash2(Math.round(cx * 4) + tile.x * 17, Math.round(cy * 4) + tile.y * 29);
            if (roll > (aisle ? 0.6 : 0.16)) continue;
            if (blocked(cx, cy)) continue;
            const heading = Math.atan2(ux, uy) + (aisle ? (side * Math.PI) / 2 : side > 0 ? 0 : Math.PI);
            cars.push(cx, hAt(cx, cy), -cy, heading, Math.floor(roll * 9973) % 14);
          }
        }
        carry = (carry + Math.ceil((len - carry) / spacing) * spacing - len) % spacing;
      }
    }
    // Lanes for moving traffic on the through roads.
    if (
      ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(r.c) &&
      p.length >= 4 &&
      lineLength(p) > 40
    ) {
      const profile = r.f === 1 ? deckProfile(r, hAt).pts : null;
      lanes.push(p.length / 2, r.o ? 1 : 0);
      for (let i = 0; i < p.length; i += 2)
        lanes.push(p[i], profile ? profile[i / 2].h + 0.05 : hAt(p[i], p[i + 1]), -p[i + 1]);
    }
  }

  // --- for driving: bridge decks to ride on and building outlines to stop at
  const decks: number[] = [];
  for (const r of tile.roads) {
    if (r.f !== 1) continue;
    const { pts } = deckProfile(r, hAt);
    if (pts.length < 2) continue;
    decks.push(pts.length, roadWidth(r) / 2 + 1);
    for (const p of pts) decks.push(p.x, p.h, -p.y);
  }
  const solids: number[] = [];
  for (const f of footprints) {
    const r = f.rings[0];
    solids.push(r.length / 2, f.box[0], -f.box[3], f.box[2], -f.box[1]);
    for (let i = 0; i < r.length; i += 2) solids.push(r[i], -r[i + 1]);
  }

  const lights = new Float32Array((tile.lights.length / 3) * 4);
  for (let i = 0, o = 0; i < tile.lights.length; i += 3, o += 4) {
    const x = tile.lights[i] / 10;
    const y = tile.lights[i + 1] / 10;
    lights[o] = x;
    lights[o + 1] = hAt(x, y);
    lights[o + 2] = -y;
    lights[o + 3] = tile.lights[i + 2] / 10;
  }
  for (const a of tile.areas) {
    if (!a.name || !/^(park|recreation|education|golf)/.test(a.k)) continue;
    const box = ringBBox(a.p[0]);
    const cx = (box[0] + box[2]) / 20;
    const cy = (box[1] + box[3]) / 20;
    if (cx < 0 || cy < 0 || cx >= TILE_SIZE || cy >= TILE_SIZE) continue;
    labels.push({
      x: cx,
      y: hAt(cx, cy) + 12,
      z: -cy,
      name: a.name,
      rank: Math.round(Math.sqrt(Math.abs(ringArea(a.p[0])) / 100) * 0.6),
    });
  }

  const painted = paintGround(tile, res);
  const ground = painted.colour.transferToImageBitmap();
  const mask = painted.mask.transferToImageBitmap();
  return {
    x: tile.x,
    y: tile.y,
    heights,
    ground,
    mask,
    photo: null,
    terrain: { pos, normal, uv, index },
    buildings: buildings.finish(true),
    bridges: bridges.finish(false),
    water: wIdx.length ? { pos: new Float32Array(wPos), index: new Uint32Array(wIdx) } : null,
    trees,
    cars: new Float32Array(cars),
    lights,
    lanes: new Float32Array(lanes),
    surface,
    decks: new Float32Array(decks),
    solids: new Float32Array(solids),
    labels,
    landmarks,
    stats: { buildings: tile.buildings.length, trees: tile.trees.length / 5, missing },
  };
}

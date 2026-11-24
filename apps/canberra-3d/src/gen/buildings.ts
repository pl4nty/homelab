// Extrudes footprints into walls and roofs. Small houses get pitched roofs fitted to their
// bounding rectangle; everything else gets a flat roof with a parapet line and plant on top.
import earcut from 'earcut';
import { TILE_Z, tileBoundsWorld } from '../../shared/geo.ts';
import { pointInPolygon, ringArea } from '../../shared/poly.ts';
import type { Building, Tile } from '../../shared/tile.ts';
import { ROOF_FLAT, ROOF_HOUSE, WALL_APT, WALL_CIVIC, WALL_COM, WALL_HOUSE, WALL_SHED } from './palette.ts';
import { MAST } from './sites.ts';
import { hash2, type Label, MeshBuilder } from './types.ts';

/** Window styles the wall shader understands. */
const STYLE_NONE = 0;
const STYLE_HOUSE = 1;
const STYLE_GRID = 2;
const STYLE_GLASS = 3;
const STYLE_CIVIC = 4;

/** Named source buildings that a hand-built model stands in for. */
const REPLACED: [RegExp, string][] = [
  [/^(black mountain|telstra) tower$/i, 'tower'],
  [/^national carillon$/i, 'carillon'],
];

const pick = <T>(list: T[], r: number) => list[Math.min(list.length - 1, Math.floor(r * list.length))];

function shade(c: number, f: number): number {
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return (ch((c >> 16) & 255) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255);
}

/** The smallest rectangle around a ring that shares a side's direction: centre, long axis, half sizes. */
function boundingRect(r: number[]) {
  let best = { area: Infinity, cx: 0, cy: 0, ux: 1, uy: 0, a: 0, b: 0 };
  const n = r.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    let ux = r[j] - r[i];
    let uy = r[j + 1] - r[i + 1];
    const len = Math.hypot(ux, uy);
    if (len < 0.3) continue;
    ux /= len;
    uy /= len;
    let lo = Infinity;
    let hi = -Infinity;
    let lo2 = Infinity;
    let hi2 = -Infinity;
    for (let k = 0; k < n; k += 2) {
      const p = r[k] * ux + r[k + 1] * uy;
      const q = -r[k] * uy + r[k + 1] * ux;
      if (p < lo) lo = p;
      if (p > hi) hi = p;
      if (q < lo2) lo2 = q;
      if (q > hi2) hi2 = q;
    }
    const area = (hi - lo) * (hi2 - lo2);
    if (area < best.area) {
      const pc = (lo + hi) / 2;
      const qc = (lo2 + hi2) / 2;
      best = { area, cx: pc * ux - qc * uy, cy: pc * uy + qc * ux, ux, uy, a: (hi - lo) / 2, b: (hi2 - lo2) / 2 };
    }
  }
  if (best.b > best.a) best = { ...best, ux: -best.uy, uy: best.ux, a: best.b, b: best.a };
  return best;
}

interface Look {
  wall: number;
  roof: number;
  style: number;
  pitched: boolean;
}

function lookOf(b: Building, area: number, seed: number, seed2: number): Look {
  const tall = b.h > 11;
  let wall: number;
  let roof: number;
  let style: number;
  switch (b.k) {
    case 'out':
      wall = pick(WALL_SHED, seed);
      roof = pick(ROOF_FLAT, seed2);
      style = STYLE_NONE;
      break;
    case 'res':
      wall = pick(WALL_HOUSE, seed);
      roof = pick(ROOF_HOUSE, seed2);
      style = STYLE_HOUSE;
      break;
    case 'apt':
      wall = pick(WALL_APT, seed);
      roof = pick(ROOF_FLAT, seed2);
      style = STYLE_GRID;
      break;
    case 'com':
    case 'ind':
    case 'ser':
    case 'tra':
      wall = pick(WALL_COM, seed);
      roof = pick(ROOF_FLAT, seed2);
      style = tall && seed2 > 0.45 ? STYLE_GLASS : area > 1500 && !tall ? STYLE_NONE : STYLE_GRID;
      break;
    case 'gov':
    case 'nat':
    case 'civ':
    case 'edu':
    case 'med':
    case 'dip':
    case 'def':
    case 'rel':
    case 'rec':
      wall = pick(WALL_CIVIC, seed);
      roof = pick(ROOF_FLAT, seed2);
      style = b.k === 'rel' ? STYLE_NONE : STYLE_CIVIC;
      break;
    default:
      // Unlabelled: size tells a house from a block of offices.
      if (area < 420 && b.h < 9) {
        wall = pick(WALL_HOUSE, seed);
        roof = pick(ROOF_HOUSE, seed2);
        style = area < 45 ? STYLE_NONE : STYLE_HOUSE;
      } else {
        wall = pick(tall ? WALL_COM : WALL_APT, seed);
        roof = pick(ROOF_FLAT, seed2);
        style = tall && seed2 > 0.5 ? STYLE_GLASS : STYLE_GRID;
      }
  }
  if (b.fc != null) wall = b.fc;
  if (b.rc != null) roof = b.rc;
  const houseLike = style === STYLE_HOUSE || (b.k === 'out' && area > 30);
  const mapped = b.roof === 'hipped' || b.roof === 'gabled' || b.roof === 'pyramidal' || b.roof === 'half-hipped';
  const pitched =
    !b.cut &&
    !b.mh &&
    b.p.length === 1 &&
    ((houseLike && area >= 28 && area <= 520 && b.h <= 9.5) || (mapped && area < 4000));
  return { wall, roof, style, pitched };
}

export function buildBuildings(
  tile: Tile,
  hAt: (x: number, y: number) => number,
  labels: Label[],
  landmarks: { id: string; x: number; z: number }[],
): MeshBuilder {
  const mb = new MeshBuilder();
  const origin = tileBoundsWorld(TILE_Z, tile.x, tile.y);
  const mastX = MAST[0] - origin[0];
  const mastY = MAST[1] - origin[1];
  for (const b of tile.buildings) {
    // Decimetres to metres; outline counter-clockwise, holes clockwise.
    const rings = b.p.map((r, i) => {
      const m = r.map((v) => v / 10);
      const a = ringArea(m);
      if ((i === 0 && a < 0) || (i > 0 && a > 0)) {
        const rev: number[] = [];
        for (let k = m.length - 2; k >= 0; k -= 2) rev.push(m[k], m[k + 1]);
        return rev;
      }
      return m;
    });
    const outline = rings[0];
    if (outline.length < 6) continue;
    const area = Math.abs(ringArea(outline));
    const seed = hash2(Math.round(outline[0] * 10) + tile.x * 7919, Math.round(outline[1] * 10) + tile.y * 104729);
    const seed2 = hash2(Math.round(outline[2] * 10) + 17, Math.round(outline[3] * 10) + tile.x);
    const look = lookOf(b, area, seed, seed2);

    let lo = Infinity;
    let hi = -Infinity;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < outline.length; i += 2) {
      const h = hAt(outline[i], outline[i + 1]);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
      cx += outline[i];
      cy += outline[i + 1];
    }
    cx /= outline.length / 2;
    cy /= outline.length / 2;
    const replaced = b.name ? REPLACED.find(([re]) => re.test(b.name!)) : undefined;
    if (replaced) {
      landmarks.push({ id: replaced[1], x: cx, z: -cy });
      continue;
    }
    // The mast's legs: tall slivers, and the collars they stand on, within the mast's footprint.
    if (Math.hypot(cx - mastX, cy - mastY) < 42 && (b.h >= 45 || ((b.mh ?? 0) >= 19 && b.h < 28 && area < 60)))
      continue;
    // Floor sits a little above the low side; walls run below ground so no slope shows a gap.
    const base = lo + Math.min(1.2, (hi - lo) * 0.35);
    const top = base + b.h;
    const bottom = b.mh ? base + b.mh : lo - 1.5;

    let eave = top;
    let rect: ReturnType<typeof boundingRect> | null = null;
    let roofH = 0;
    if (look.pitched) {
      rect = boundingRect(outline);
      const fit = area / (rect.a * rect.b * 4);
      if (fit < 0.68 && !b.roof) rect = null;
      else {
        roofH = b.roofH ?? Math.min(3.2, Math.max(0.9, rect.b * 0.5));
        roofH = Math.min(roofH, b.h - 2.2);
        if (roofH < 0.5) rect = null;
        else eave = top - roofH;
      }
    }

    // A dome sits on a drum: the walls stop where it springs.
    const domed = !rect && !b.cut && (b.roof === 'dome' || b.roof === 'onion');
    const domeR = Math.sqrt(area / Math.PI);
    const domeH = domed ? Math.min(b.roofH ?? domeR * 0.7, b.h * 0.75) : 0;
    if (domed) eave = top - domeH;

    // --- walls
    const wallH = eave - base;
    for (const ring of rings) {
      let along = 0;
      const n = ring.length;
      for (let i = 0; i < n; i += 2) {
        const j = (i + 2) % n;
        const ax = ring[i];
        const ay = ring[i + 1];
        const bx = ring[j];
        const by = ring[j + 1];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 0.05) continue;
        const nx = (by - ay) / len;
        const nz = (bx - ax) / len;
        // Vary each face a touch so adjoining walls separate even in flat light.
        const c = shade(look.wall, 0.94 + hash2(i + n, Math.round(ax * 3)) * 0.1);
        const v0 = mb.vertex(ax, bottom, -ay, nx, 0, nz, c, along, bottom - base, look.style + seed2 * 0.9, wallH);
        mb.vertex(bx, bottom, -by, nx, 0, nz, c, along + len, bottom - base, look.style + seed2 * 0.9, wallH);
        mb.vertex(bx, eave, -by, nx, 0, nz, c, along + len, wallH, look.style + seed2 * 0.9, wallH);
        mb.vertex(ax, eave, -ay, nx, 0, nz, c, along, wallH, look.style + seed2 * 0.9, wallH);
        mb.index.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
        along += len;
      }
    }

    // --- roof
    if (rect) {
      const over = 0.45;
      const a = rect.a + over;
      const bb = rect.b + over;
      const { ux, uy } = rect;
      const vx = -uy;
      const vy = ux;
      const P = (su: number, sv: number, y: number) => [
        rect!.cx + ux * su + vx * sv,
        y,
        -(rect!.cy + uy * su + vy * sv),
      ];
      const p1 = P(-a, -bb, eave);
      const p2 = P(a, -bb, eave);
      const p3 = P(a, bb, eave);
      const p4 = P(-a, bb, eave);
      const gabled = b.roof === 'gabled' || (!b.roof && seed > 0.72);
      const ridge = gabled ? a : Math.max(0, a - bb);
      const r1 = P(-ridge, 0, top);
      const r2 = P(ridge, 0, top);
      const roofA = look.roof;
      const roofB = shade(look.roof, 0.9);
      mb.quad(p1, p2, r2, r1, roofA);
      mb.quad(p3, p4, r1, r2, roofA);
      mb.tri(p2[0], p2[1], p2[2], p3[0], p3[1], p3[2], r2[0], r2[1], r2[2], gabled ? look.wall : roofB);
      mb.tri(p4[0], p4[1], p4[2], p1[0], p1[1], p1[2], r1[0], r1[1], r1[2], gabled ? look.wall : roofB);
      // Close the eaves so the overhang is not see-through from below.
      mb.quad(p4, p3, p2, p1, shade(look.wall, 0.8));
    } else if (domed) {
      const rings2 = 6;
      const segs = 18;
      const colour = b.rc ?? 0x8fb8a4;
      const at = (ring: number, seg: number) => {
        const phi = (ring / rings2) * (Math.PI / 2);
        const th = (seg / segs) * Math.PI * 2;
        return [
          cx + Math.cos(th) * Math.cos(phi) * domeR,
          eave + Math.sin(phi) * domeH,
          -(cy + Math.sin(th) * Math.cos(phi) * domeR),
        ];
      };
      for (let r = 0; r < rings2; r++) {
        for (let sg = 0; sg < segs; sg++)
          mb.quad(
            at(r, sg),
            at(r, sg + 1),
            at(r + 1, sg + 1),
            at(r + 1, sg),
            shade(colour, 0.92 + (r / rings2) * 0.16),
          );
      }
    } else {
      const flat: number[] = [];
      const holes: number[] = [];
      for (const [i, ring] of rings.entries()) {
        if (i) holes.push(flat.length / 2);
        flat.push(...ring);
      }
      const tris = earcut(flat, holes);
      const first = mb.count;
      const roof = look.style === STYLE_HOUSE ? look.roof : shade(look.roof, 0.96 + seed * 0.08);
      for (let i = 0; i < flat.length; i += 2) mb.vertex(flat[i], top, -flat[i + 1], 0, 1, 0, roof);
      for (let i = 0; i < tris.length; i += 3) {
        const a = tris[i];
        const bI = tris[i + 1];
        const c = tris[i + 2];
        const cross =
          (flat[bI * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) -
          (flat[bI * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
        if (cross > 0) mb.index.push(first + a, first + bI, first + c);
        else mb.index.push(first + a, first + c, first + bI);
      }
      if (b.mh) {
        // A floating part needs an underside.
        const under = mb.count;
        for (let i = 0; i < flat.length; i += 2)
          mb.vertex(flat[i], bottom, -flat[i + 1], 0, -1, 0, shade(look.wall, 0.7));
        for (let i = 0; i < tris.length; i += 3) {
          const a = tris[i];
          const bI = tris[i + 1];
          const c = tris[i + 2];
          const cross =
            (flat[bI * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) -
            (flat[bI * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
          if (cross > 0) mb.index.push(under + a, under + c, under + bI);
          else mb.index.push(under + a, under + bI, under + c);
        }
      }
      // Lift motor rooms, plant and skylights onto big flat roofs.
      if (area > 350 && b.h > 5 && !b.mh && b.roof == null) {
        const count = Math.min(5, 1 + Math.floor(area / 900));
        for (let i = 0; i < count; i++) {
          const r1 = hash2(Math.round(cx * 7) + i * 31, Math.round(cy * 7));
          const r2 = hash2(Math.round(cx * 3), Math.round(cy * 11) + i * 53);
          const rect2 = boundingRect(outline);
          const px = rect2.cx + rect2.ux * (r1 - 0.5) * rect2.a * 1.3 - rect2.uy * (r2 - 0.5) * rect2.b * 1.3;
          const py = rect2.cy + rect2.uy * (r1 - 0.5) * rect2.a * 1.3 + rect2.ux * (r2 - 0.5) * rect2.b * 1.3;
          const hw = 1.5 + r2 * Math.min(4, rect2.b * 0.3);
          const hl = 1.5 + r1 * Math.min(5, rect2.a * 0.3);
          let inside = true;
          for (const [su, sv] of [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ]) {
            const qx = px + rect2.ux * hl * su - rect2.uy * hw * sv;
            const qy = py + rect2.uy * hl * su + rect2.ux * hw * sv;
            if (!pointInPolygon(qx, qy, rings)) inside = false;
          }
          if (!inside) continue;
          const boxH = 1.2 + r1 * 2.2;
          const colour = r2 > 0.6 ? 0x9aa2aa : 0xc8c8c4;
          mb.box(
            px,
            -py,
            rect2.ux * hl,
            -rect2.uy * hl,
            -rect2.uy * hw,
            -rect2.ux * hw,
            top - 0.1,
            top + boxH,
            shade(colour, 0.85),
            colour,
          );
        }
      }
    }

    if (
      b.name &&
      !b.mh &&
      (area > 600 || b.h > 25 || ['nat', 'gov', 'civ', 'rel', 'rec', 'edu', 'med'].includes(b.k))
    ) {
      labels.push({
        x: cx,
        y: top + 6,
        z: -cy,
        name: b.name,
        rank: Math.round(Math.sqrt(area) + b.h * 2 + (b.k === 'nat' ? 80 : 0)),
      });
    }
  }
  return mb;
}

// Tree shapes and instancing. Positions and sizes come from the LiDAR crown survey, so each
// instance is a real tree; the shapes are five low-poly species groups.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TreeKind } from '../shared/tile.ts';
import { foliageMaterial } from './materials.ts';

/** Face colours are stored relative to the species colour, which each instance supplies. */
function tinted(g: THREE.BufferGeometry, hex: number, species: number, jitter = 0, seed = 1): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const pos = geo.attributes.position;
  let s = seed * 9301 + 49297;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  if (jitter) {
    // Move coincident corners together, or faces would tear apart.
    const moved = new Map<string, [number, number, number]>();
    for (let i = 0; i < pos.count; i++) {
      const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
      let d = moved.get(key);
      if (!d) {
        d = [(rnd() - 0.5) * jitter, (rnd() - 0.5) * jitter, (rnd() - 0.5) * jitter];
        moved.set(key, d);
      }
      pos.setXYZ(i, pos.getX(i) + d[0], pos.getY(i) + d[1], pos.getZ(i) + d[2]);
    }
  }
  const base = new THREE.Color(hex);
  const rel = new THREE.Color(species);
  base.setRGB(base.r / rel.r, base.g / rel.g, base.b / rel.b);
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 3) {
    // One shade per face.
    const f = 0.86 + rnd() * 0.28;
    for (let k = 0; k < 3; k++) {
      col[(i + k) * 3] = base.r * f;
      col[(i + k) * 3 + 1] = base.g * f;
      col[(i + k) * 3 + 2] = base.b * f;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // Solid parts sample the atlas's opaque white cell.
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.count * 2).fill(0.75), 2));
  geo.computeVertexNormals();
  return geo;
}

const at = (g: THREE.BufferGeometry, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) =>
  g.scale(sx, sy, sz).translate(x, y, z);

const SPECIES: Record<TreeKind, number> = {
  [TreeKind.Eucalypt]: 0x6f9352,
  [TreeKind.Deciduous]: 0x529c39,
  [TreeKind.Conifer]: 0x2e6b3a,
  [TreeKind.Columnar]: 0x67a544,
  [TreeKind.Evergreen]: 0x4a8744,
};

/**
 * A crown as a cluster of flat cards, each showing a spray of leaves from the atlas. Normals point
 * out from the crown's centre, so the cluster is lit as one rounded mass, not as separate planes.
 */
function cards(
  count: number,
  centre: [number, number, number],
  radii: [number, number, number],
  size: number,
  seed: number,
): THREE.BufferGeometry {
  let s = seed * 7919 + 104729;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  for (let c = 0; c < count; c++) {
    // Towards the outside of the crown, where the leaves are.
    const r = 0.45 + rnd() * 0.5;
    const th = rnd() * Math.PI * 2;
    const ph = Math.acos(1 - 2 * rnd());
    const px = centre[0] + Math.sin(ph) * Math.cos(th) * radii[0] * r;
    const py = centre[1] + Math.cos(ph) * radii[1] * r;
    const pz = centre[2] + Math.sin(ph) * Math.sin(th) * radii[2] * r;
    const yaw = rnd() * Math.PI * 2;
    const tilt = (rnd() - 0.5) * 1.1;
    const half = (size * (0.8 + rnd() * 0.45)) / 2;
    const u = [Math.cos(yaw) * half, 0, Math.sin(yaw) * half];
    const v = [-Math.sin(yaw) * Math.sin(tilt) * half, Math.cos(tilt) * half, Math.cos(yaw) * Math.sin(tilt) * half];
    const cell = Math.floor(rnd() * 3);
    const u0 = (cell % 2) * 0.5 + 0.01;
    const v0 = Math.floor(cell / 2) * 0.5 + 0.01;
    const tone = 0.9 + rnd() * 0.38;
    const corner = (su: number, sv: number) => {
      const x = px + u[0] * su + v[0] * sv;
      const y = py + u[1] * su + v[1] * sv;
      const z = pz + u[2] * su + v[2] * sv;
      pos.push(x, y, z);
      let nx = (x - centre[0]) / radii[0];
      let ny = (y - centre[1]) / radii[1] + 0.35;
      let nz = (z - centre[2]) / radii[2];
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      nor.push(nx, ny, nz);
      col.push(tone, tone, tone);
      uv.push(u0 + ((su + 1) / 2) * 0.48, v0 + ((sv + 1) / 2) * 0.48);
    };
    corner(-1, -1);
    corner(1, -1);
    corner(1, 1);
    corner(-1, -1);
    corner(1, 1);
    corner(-1, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** Three sprays of leaves and one opaque cell, drawn pale so species and season colour them. */
function leafAtlas(): THREE.CanvasTexture {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  let s = 4242;
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const half = size / 2;
  for (let cell = 0; cell < 3; cell++) {
    const ox = (cell % 2) * half + half / 2;
    const oy = Math.floor(cell / 2) * half + half / 2;
    for (let i = 0; i < 230; i++) {
      // Dense in the middle, ragged at the rim.
      const r = Math.sqrt(rnd()) * half * 0.46 * (0.7 + rnd() * 0.3);
      const a = rnd() * Math.PI * 2;
      const tone = 150 + Math.floor(rnd() * 105);
      ctx.fillStyle = `rgb(${tone - 12},${tone},${tone - 30})`;
      ctx.beginPath();
      ctx.ellipse(
        ox + Math.cos(a) * r,
        oy + Math.sin(a) * r,
        9 + rnd() * 9,
        5 + rnd() * 5,
        rnd() * Math.PI,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect(half, half, half, half);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  // Unflipped, so v runs down the canvas: cells 0 to 2 hold leaves and the last one is opaque.
  t.flipY = false;
  t.anisotropy = 4;
  return t;
}

/** Unit trees: 1 tall, crown about 1 wide; the instance scales them to the measured tree. */
function shapes(): Record<TreeKind, THREE.BufferGeometry> {
  const make = (kind: TreeKind) => {
    const sp = SPECIES[kind];
    const dark = new THREE.Color(sp).multiplyScalar(0.62).getHex();
    return {
      trunk: (h: number, r: number, hex: number) =>
        tinted(at(new THREE.CylinderGeometry(r * 0.7, r, h, 5), 0, h / 2, 0), hex, sp),
      // A dark core, so the gaps between leaf cards show shade and not sky.
      core: (r: number, x: number, y: number, z: number, sy = 1) =>
        tinted(at(new THREE.IcosahedronGeometry(r, 0), x, y, z, 1, sy, 1), dark, sp, r * 0.2, 7),
      cone: (r: number, h: number, y: number, hex: number) =>
        tinted(at(new THREE.ConeGeometry(r, h, 7), 0, y, 0), hex, sp),
    };
  };
  const gum = make(TreeKind.Eucalypt);
  const oak = make(TreeKind.Deciduous);
  const pine = make(TreeKind.Conifer);
  const poplar = make(TreeKind.Columnar);
  const wattle = make(TreeKind.Evergreen);
  return {
    // Gum: pale bare trunk, open crown in a few separate clumps.
    [TreeKind.Eucalypt]: mergeGeometries([
      gum.trunk(0.66, 0.035, 0xd8cfbb),
      gum.core(0.13, 0.02, 0.76, 0, 0.8),
      cards(5, [0.02, 0.76, 0], [0.3, 0.2, 0.3], 0.44, 1),
      cards(4, [-0.22, 0.62, 0.12], [0.22, 0.15, 0.22], 0.36, 2),
      cards(4, [0.2, 0.6, -0.16], [0.2, 0.14, 0.2], 0.34, 3),
    ]),
    // Oak, elm, plane: short trunk, one dense round crown.
    [TreeKind.Deciduous]: mergeGeometries([
      oak.trunk(0.36, 0.05, 0x6b5440),
      oak.core(0.24, 0, 0.62, 0, 0.85),
      cards(14, [0, 0.64, 0], [0.44, 0.36, 0.44], 0.56, 4),
    ]),
    // Pine and cedar: stacked cones under a fringe of needles.
    [TreeKind.Conifer]: mergeGeometries([
      pine.trunk(0.2, 0.04, 0x5a4636),
      pine.cone(0.3, 0.55, 0.42, 0x2e6b3a),
      pine.cone(0.2, 0.5, 0.74, 0x357a42),
      cards(8, [0, 0.5, 0], [0.34, 0.3, 0.34], 0.34, 8),
    ]),
    // Lombardy poplar: a tall narrow flame.
    [TreeKind.Columnar]: mergeGeometries([
      poplar.trunk(0.18, 0.04, 0x6b5a46),
      poplar.core(0.11, 0, 0.58, 0, 3.2),
      cards(10, [0, 0.58, 0], [0.17, 0.4, 0.17], 0.36, 5),
    ]),
    // Wattle, casuarina, bottlebrush: small and dark.
    [TreeKind.Evergreen]: mergeGeometries([
      wattle.trunk(0.3, 0.045, 0x5d4a3a),
      wattle.core(0.21, 0, 0.62, 0, 0.8),
      cards(11, [0, 0.63, 0], [0.4, 0.32, 0.4], 0.5, 6),
    ]),
  };
}

/** Autumn in the deciduous streets: what the species turn to. */
const AUTUMN = [0xd9622b, 0xe08a2c, 0xc23b22, 0xe6b33a, 0xb84a2a, 0xdba13a];

export type Season = 'summer' | 'autumn';

export class TreeFactory {
  private near = shapes();
  private far: THREE.BufferGeometry;
  private leaves = leafAtlas();
  private nearMat = foliageMaterial(this.leaves);
  // Shadows must follow the leaves, not the cards they are drawn on.
  private nearDepth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: this.leaves,
    alphaTest: 0.3,
  });
  private farMat = new THREE.MeshLambertMaterial();
  season: Season = 'summer';

  constructor() {
    const g = new THREE.OctahedronGeometry(0.5, 0).scale(1, 0.72, 1).translate(0, 0.62, 0);
    g.computeVertexNormals();
    g.deleteAttribute('uv');
    this.far = g;
  }

  private colour(kind: TreeKind, seed: number, out: THREE.Color): THREE.Color {
    if (this.season === 'autumn' && kind === TreeKind.Deciduous) {
      return out.setHex(AUTUMN[Math.floor(seed * 977) % AUTUMN.length]).multiplyScalar(0.85 + seed * 0.3);
    }
    return out.setHex(SPECIES[kind]).multiplyScalar(0.8 + seed * 0.4);
  }

  /** One instanced mesh per species for close range, or one cheap mesh of everything for distance. */
  build(trees: Float32Array, near: boolean): THREE.InstancedMesh[] {
    const count = trees.length / 7;
    if (!count) return [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    const place = (mesh: THREE.InstancedMesh, slot: number, i: number) => {
      const o = i * 7;
      const h = trees[o + 3];
      const r = trees[o + 4];
      const seed = trees[o + 6];
      const kind = trees[o + 5] as TreeKind;
      const width = kind === TreeKind.Columnar ? Math.max(2.2, r * 1.3) : Math.max(r * 2.1, h * 0.28);
      p.set(trees[o], trees[o + 1] - 0.2, trees[o + 2]);
      s.set(width, h, width * (0.9 + seed * 0.2));
      q.setFromAxisAngle(up, seed * Math.PI * 2);
      mesh.setMatrixAt(slot, m.compose(p, q, s));
      mesh.setColorAt(slot, this.colour(kind, seed, c));
    };
    if (!near) {
      const mesh = new THREE.InstancedMesh(this.far, this.farMat, count);
      for (let i = 0; i < count; i++) place(mesh, i, i);
      mesh.instanceMatrix.needsUpdate = true;
      return [mesh];
    }
    const counts = [0, 0, 0, 0, 0];
    for (let i = 0; i < count; i++) counts[trees[i * 7 + 5]]++;
    const out: THREE.InstancedMesh[] = [];
    for (let kind = 0; kind < 5; kind++) {
      if (!counts[kind]) continue;
      const mesh = new THREE.InstancedMesh(this.near[kind as TreeKind], this.nearMat, counts[kind]);
      let slot = 0;
      for (let i = 0; i < count; i++) if (trees[i * 7 + 5] === kind) place(mesh, slot++, i);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = this.nearDepth;
      out.push(mesh);
    }
    return out;
  }
}

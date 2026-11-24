// Tree shapes and instancing. Positions and sizes come from the LiDAR crown survey, so each
// instance is a real tree; the shapes are five low-poly species groups.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TreeKind } from '../shared/tile.ts';

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
  geo.deleteAttribute('uv');
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

/** Unit trees: 1 tall, crown about 1 wide; the instance scales them to the measured tree. */
function shapes(): Record<TreeKind, THREE.BufferGeometry> {
  const make = (kind: TreeKind) => {
    const sp = SPECIES[kind];
    return {
      trunk: (h: number, r: number, hex: number) =>
        tinted(at(new THREE.CylinderGeometry(r * 0.7, r, h, 5), 0, h / 2, 0), hex, sp),
      blob: (r: number, x: number, y: number, z: number, hex: number, sy = 1, detail = 0, seed = 1) =>
        tinted(at(new THREE.IcosahedronGeometry(r, detail), x, y, z, 1, sy, 1), hex, sp, r * 0.3, seed),
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
    // Gum: pale bare trunk, open grey-green crown in a few clumps.
    [TreeKind.Eucalypt]: mergeGeometries([
      gum.trunk(0.62, 0.035, 0xd8cfbb),
      gum.blob(0.3, 0.02, 0.72, 0.0, 0x6f9352, 0.8, 0, 1),
      gum.blob(0.24, -0.22, 0.62, 0.12, 0x7da35b, 0.75, 0, 2),
      gum.blob(0.22, 0.2, 0.6, -0.16, 0x628648, 0.75, 0, 3),
    ]),
    // Oak, elm, plane: short trunk, one dense round crown.
    [TreeKind.Deciduous]: mergeGeometries([
      oak.trunk(0.34, 0.05, 0x6b5440),
      oak.blob(0.46, 0, 0.62, 0, 0x5cab3b, 0.82, 1, 4),
    ]),
    // Pine and cedar: stacked cones.
    [TreeKind.Conifer]: mergeGeometries([
      pine.trunk(0.2, 0.04, 0x5a4636),
      pine.cone(0.36, 0.55, 0.42, 0x2e6b3a),
      pine.cone(0.26, 0.5, 0.74, 0x357a42),
    ]),
    // Lombardy poplar: a tall narrow flame.
    [TreeKind.Columnar]: mergeGeometries([
      poplar.trunk(0.18, 0.04, 0x6b5a46),
      poplar.blob(0.2, 0, 0.58, 0, 0x67a544, 2.1, 0, 5),
    ]),
    // Wattle, casuarina, bottlebrush: small and dark.
    [TreeKind.Evergreen]: mergeGeometries([
      wattle.trunk(0.3, 0.045, 0x5d4a3a),
      wattle.blob(0.42, 0, 0.62, 0, 0x4a8744, 0.8, 0, 6),
    ]),
  };
}

/** Autumn in the deciduous streets: what the species turn to. */
const AUTUMN = [0xd9622b, 0xe08a2c, 0xc23b22, 0xe6b33a, 0xb84a2a, 0xdba13a];

export type Season = 'summer' | 'autumn';

export class TreeFactory {
  private near = shapes();
  private far: THREE.BufferGeometry;
  private nearMat = new THREE.MeshLambertMaterial({ vertexColors: true });
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
      out.push(mesh);
    }
    return out;
  }
}

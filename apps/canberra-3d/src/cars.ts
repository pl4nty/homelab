// Vehicles: five body styles built from a side profile and a glazed cabin, with wheels and lamps.
// One material draws them all; each instance supplies its paint colour.
import earcut from 'earcut';
import * as THREE from 'three';
import { shared } from './materials.ts';

type V3 = [number, number, number];

/** A body style, metres, nose towards -z. The profile runs from the front sill over the top to the rear sill. */
interface Style {
  /** Half the width of the body. */
  half: number;
  /** Side profile of the body below the windows, as [z, y]. */
  body: [number, number][];
  /** The cabin: where it starts and ends along the car at its base and at the roof, and its heights and half-widths. */
  cabin: { base: [number, number]; top: [number, number]; y: [number, number]; half: [number, number] };
  /** Axle positions along the car, and wheel radius. */
  axles: [number, number];
  wheel: number;
  /** A load bed behind the cabin, as [front z, rear z, floor height]. */
  tray?: [number, number, number];
}

const STYLES: Style[] = [
  // Sedan
  {
    half: 0.9,
    body: [
      [-2.2, 0.3],
      [-2.27, 0.58],
      [-2.12, 0.8],
      [-0.95, 0.93],
      [1.5, 0.95],
      [2.18, 0.9],
      [2.27, 0.58],
      [2.2, 0.3],
    ],
    cabin: { base: [-1.0, 1.55], top: [-0.25, 0.95], y: [0.92, 1.42], half: [0.84, 0.68] },
    axles: [-1.38, 1.36],
    wheel: 0.32,
  },
  // Hatchback
  {
    half: 0.88,
    body: [
      [-1.95, 0.3],
      [-2.02, 0.58],
      [-1.88, 0.82],
      [-0.85, 0.95],
      [1.9, 0.98],
      [2.02, 0.6],
      [1.95, 0.3],
    ],
    cabin: { base: [-0.9, 1.88], top: [-0.2, 1.5], y: [0.94, 1.48], half: [0.82, 0.68] },
    axles: [-1.25, 1.25],
    wheel: 0.31,
  },
  // SUV
  {
    half: 0.95,
    body: [
      [-2.25, 0.38],
      [-2.32, 0.7],
      [-2.2, 1.0],
      [-1.0, 1.1],
      [2.22, 1.12],
      [2.32, 0.7],
      [2.25, 0.38],
    ],
    cabin: { base: [-1.05, 2.2], top: [-0.45, 1.95], y: [1.08, 1.72], half: [0.9, 0.76] },
    axles: [-1.42, 1.4],
    wheel: 0.38,
  },
  // Ute
  {
    half: 0.94,
    body: [
      [-2.55, 0.4],
      [-2.62, 0.72],
      [-2.5, 1.0],
      [-1.3, 1.1],
      [2.55, 1.1],
      [2.62, 0.72],
      [2.55, 0.4],
    ],
    cabin: { base: [-1.35, 0.55], top: [-0.75, 0.35], y: [1.08, 1.74], half: [0.88, 0.75] },
    axles: [-1.7, 1.55],
    wheel: 0.39,
    tray: [0.7, 2.5, 0.72],
  },
  // Van
  {
    half: 0.98,
    body: [
      [-2.4, 0.36],
      [-2.47, 0.7],
      [-2.36, 1.02],
      [-1.75, 1.12],
      [2.42, 1.12],
      [2.47, 0.7],
      [2.4, 0.36],
    ],
    cabin: { base: [-1.8, 2.4], top: [-1.25, 2.38], y: [1.1, 2.0], half: [0.96, 0.9] },
    axles: [-1.55, 1.5],
    wheel: 0.36,
  },
];

const PAINT = 0xffffff;
const GLASS = 0x10161d;
const TRIM = 0x17191c;
const TYRE = 0x121315;
const HUB = 0x8d9399;

class Builder {
  pos: number[] = [];
  normal: number[] = [];
  color: number[] = [];
  /** 1 where the instance's paint colour applies, 0 where the surface keeps its own. */
  paint: number[] = [];
  /** Light a lamp gives off after dark. */
  glow: number[] = [];
  private c = new THREE.Color();

  tri(a: V3, b: V3, c: V3, hex: number, paint: number, glow: V3 = [0, 0, 0]) {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    this.c.setHex(hex);
    for (const p of [a, b, c]) {
      this.pos.push(...p);
      this.normal.push(nx, ny, nz);
      this.color.push(this.c.r, this.c.g, this.c.b);
      this.paint.push(paint);
      this.glow.push(...glow);
    }
  }

  /** A four-sided face, turned to face away from `from` whatever order its corners come in. */
  quad(a: V3, b: V3, c: V3, d: V3, from: V3, hex: number, paint: number, glow?: V3) {
    const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const out = nx * (a[0] - from[0]) + ny * (a[1] - from[1]) + nz * (a[2] - from[2]) >= 0;
    if (out) {
      this.tri(a, b, c, hex, paint, glow);
      this.tri(a, c, d, hex, paint, glow);
    } else {
      this.tri(a, c, b, hex, paint, glow);
      this.tri(a, d, c, hex, paint, glow);
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.color, 3));
    g.setAttribute('paint', new THREE.Float32BufferAttribute(this.paint, 1));
    g.setAttribute('glow', new THREE.Float32BufferAttribute(this.glow, 3));
    return g;
  }
}

function build(s: Style): THREE.BufferGeometry {
  const b = new Builder();
  const w = s.half;
  const mid: V3 = [0, 0.75, 0];

  // --- body: the profile swept across the width, capped by its two sides
  const n = s.body.length;
  for (let i = 0; i < n; i++) {
    const [z0, y0] = s.body[i];
    const [z1, y1] = s.body[(i + 1) % n];
    // The closing edge is the floor: dark, like everything under the sills.
    const floor = i === n - 1;
    b.quad([-w, y0, z0], [w, y0, z0], [w, y1, z1], [-w, y1, z1], mid, floor ? TRIM : PAINT, floor ? 0 : 1);
  }
  const flat = s.body.flat();
  const tris = earcut(flat);
  for (const side of [-1, 1]) {
    for (let i = 0; i < tris.length; i += 3) {
      const p = [tris[i], tris[i + 1], tris[i + 2]].map((k) => [side * w, flat[k * 2 + 1], flat[k * 2]] as V3);
      const cross = (p[1][1] - p[0][1]) * (p[2][2] - p[0][2]) - (p[1][2] - p[0][2]) * (p[2][1] - p[0][1]);
      if (Math.sign(cross) === side) b.tri(p[0], p[1], p[2], PAINT, 1);
      else b.tri(p[0], p[2], p[1], PAINT, 1);
    }
  }
  // A dark sill along each side, and bumpers, break up the slab of paint.
  const front = s.body[0][0];
  const rear = s.body[n - 1][0];
  const sill = s.body[0][1];
  for (const side of [-1, 1]) {
    const x = side * (w + 0.012);
    b.quad(
      [x, sill, front + 0.25],
      [x, sill, rear - 0.25],
      [x, sill + 0.14, rear - 0.25],
      [x, sill + 0.14, front + 0.25],
      mid,
      TRIM,
      0,
    );
  }
  const noseZ = s.body[1][0] - 0.012;
  const tailZ = s.body[n - 2][0] + 0.012;
  const lampY = s.body[1][1] + 0.1;
  b.quad(
    [-w * 0.92, sill + 0.02, noseZ + 0.03],
    [w * 0.92, sill + 0.02, noseZ + 0.03],
    [w * 0.92, lampY - 0.12, noseZ],
    [-w * 0.92, lampY - 0.12, noseZ],
    mid,
    TRIM,
    0,
  );
  b.quad(
    [-w * 0.92, sill + 0.02, tailZ - 0.03],
    [w * 0.92, sill + 0.02, tailZ - 0.03],
    [w * 0.92, lampY - 0.14, tailZ],
    [-w * 0.92, lampY - 0.14, tailZ],
    mid,
    TRIM,
    0,
  );
  for (const side of [-1, 1]) {
    const x0 = side * w * 0.5;
    const x1 = side * w * 0.94;
    // Headlamps are pale by day and bright by night; tail lamps red.
    b.quad(
      [x0, lampY - 0.07, noseZ + 0.02],
      [x1, lampY - 0.07, noseZ + 0.05],
      [x1, lampY + 0.09, noseZ + 0.09],
      [x0, lampY + 0.09, noseZ + 0.06],
      mid,
      0xf4f1e4,
      0,
      [3.2, 2.9, 2.2],
    );
    b.quad(
      [x0, lampY - 0.06, tailZ - 0.02],
      [x1, lampY - 0.06, tailZ - 0.05],
      [x1, lampY + 0.1, tailZ - 0.08],
      [x0, lampY + 0.1, tailZ - 0.05],
      mid,
      0xb01818,
      0,
      [2.2, 0.12, 0.08],
    );
  }

  // --- cabin: glass on four sides under a painted roof, with pillars at the corners and between the doors
  const { base, top, y, half } = s.cabin;
  const cab: V3 = [0, (y[0] + y[1]) / 2, (base[0] + base[1]) / 2];
  const lo = (x: number, z: number): V3 => [x * half[0], y[0], z];
  const hi = (x: number, z: number): V3 => [x * half[1], y[1], z];
  b.quad(lo(-1, base[0]), lo(1, base[0]), hi(1, top[0]), hi(-1, top[0]), cab, GLASS, 0);
  b.quad(lo(-1, base[1]), lo(1, base[1]), hi(1, top[1]), hi(-1, top[1]), cab, GLASS, 0);
  b.quad(hi(-1, top[0]), hi(1, top[0]), hi(1, top[1]), hi(-1, top[1]), cab, PAINT, 1);
  for (const side of [-1, 1]) {
    b.quad(lo(side, base[0]), lo(side, base[1]), hi(side, top[1]), hi(side, top[0]), cab, GLASS, 0);
    // Pillars: thin painted strips just proud of the glass.
    const out = side * 0.012;
    const pillar = (t: number, width: number) => {
      const zb = base[0] + (base[1] - base[0]) * t;
      const zt = top[0] + (top[1] - top[0]) * t;
      b.quad(
        [side * half[0] + out, y[0], zb - width],
        [side * half[0] + out, y[0], zb + width],
        [side * half[1] + out, y[1], zt + width],
        [side * half[1] + out, y[1], zt - width],
        cab,
        PAINT,
        1,
      );
    };
    pillar(0.02, 0.05);
    pillar(0.5, 0.06);
    pillar(0.98, 0.05);
  }

  if (s.tray) {
    // A ute's bed: a dark well in the top of the body behind the cab.
    const [z0, z1, fy] = s.tray;
    const ty = s.body[4][1] + 0.01;
    const e = 0.08;
    b.quad([-w + e, ty, z0], [w - e, ty, z0], [w - e, ty, z1 - e], [-w + e, ty, z1 - e], [0, fy - 1, 1.5], TRIM, 0);
  }

  // --- wheels: a tyre and a hub cap on each corner
  const sides = 10;
  for (const z of s.axles) {
    for (const side of [-1, 1]) {
      const r = s.wheel;
      const x0 = side * (w - 0.2);
      const x1 = side * (w + 0.03);
      const centre: V3 = [side * (w - 0.1), r, z];
      for (let k = 0; k < sides; k++) {
        const a0 = (k / sides) * Math.PI * 2;
        const a1 = ((k + 1) / sides) * Math.PI * 2;
        const p0: [number, number] = [r + Math.cos(a0) * r, z + Math.sin(a0) * r];
        const p1: [number, number] = [r + Math.cos(a1) * r, z + Math.sin(a1) * r];
        b.quad([x0, p0[0], p0[1]], [x1, p0[0], p0[1]], [x1, p1[0], p1[1]], [x0, p1[0], p1[1]], centre, TYRE, 0);
        // The outer face of the tyre, and a hub cap just proud of it, as fans about the axle.
        const face = (x: number, k: number, hex: number) => {
          const hub: V3 = [x, r, z];
          const e0: V3 = [x, r + Math.cos(a0) * r * k, z + Math.sin(a0) * r * k];
          const e1: V3 = [x, r + Math.cos(a1) * r * k, z + Math.sin(a1) * r * k];
          if (side > 0) b.tri(hub, e1, e0, hex, 0);
          else b.tri(hub, e0, e1, hex, 0);
        };
        face(x1, 1, TYRE);
        face(x1 + side * 0.004, 0.55, HUB);
      }
    }
  }
  return b.geometry();
}

/** Paint follows the instance colour only where the model says so, and lamps light up after dark. */
function carMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = shared.night;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float paint;\nattribute vec3 glow;\nvarying vec3 vGlow;',
      )
      .replace(
        '#include <color_vertex>',
        /* glsl */ `vColor = vec4(1.0);
        vColor.rgb *= color;
        #ifdef USE_INSTANCING_COLOR
          vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, paint);
        #endif
        vGlow = glow;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlow;\nuniform float uNight;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow * uNight;',
      );
  };
  return m;
}

export class Cars {
  readonly styles = STYLES.map(build);
  readonly material = carMaterial();

  /** Which body style a car at a given spot gets: mostly sedans, hatches and SUVs, the odd ute and van. */
  styleFor(seed: number): number {
    return seed < 0.3 ? 0 : seed < 0.56 ? 1 : seed < 0.84 ? 2 : seed < 0.94 ? 3 : 4;
  }

  /**
   * One instanced mesh per body style for a set of cars. `at` gives each car's style seed, and is
   * handed the mesh and slot to place it in.
   */
  meshes(
    count: number,
    seedOf: (i: number) => number,
    place: (mesh: THREE.InstancedMesh, slot: number, i: number) => void,
  ): THREE.InstancedMesh[] {
    const groups: number[][] = this.styles.map(() => []);
    for (let i = 0; i < count; i++) groups[this.styleFor(seedOf(i))].push(i);
    const out: THREE.InstancedMesh[] = [];
    for (const [style, members] of groups.entries()) {
      if (!members.length) continue;
      const mesh = new THREE.InstancedMesh(this.styles[style], this.material, members.length);
      for (const [slot, i] of members.entries()) place(mesh, slot, i);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.members = members;
      out.push(mesh);
    }
    return out;
  }
}

// Hand-built models of the structures no footprint extrusion can stand in for.
import * as THREE from 'three';
import { lonLatToWorld } from '../shared/geo.ts';
import { MAST } from './gen/sites.ts';

const lambert = (hex: number, extra: THREE.MeshLambertMaterialParameters = {}) =>
  new THREE.MeshLambertMaterial({ color: hex, ...extra });
const CONCRETE = lambert(0xd9d6cc);
const WHITE = lambert(0xf4f2ec);
const STEEL = lambert(0xc4c9ce);
const GLASS = lambert(0x24323f);
const RED = lambert(0xc8322b);

function part(geo: THREE.BufferGeometry, mat: THREE.Material, y = 0, x = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Black Mountain Tower: 195 m of concrete shaft, galleries and antenna above the city. */
function blackMountainTower(): THREE.Group {
  const g = new THREE.Group();
  g.add(part(new THREE.CylinderGeometry(15, 16, 9, 24), CONCRETE, 4.5));
  g.add(part(new THREE.CylinderGeometry(4.2, 6.2, 132, 20), CONCRETE, 66));
  // Public galleries and the revolving level.
  for (const [y, r, h, mat] of [
    [52, 11, 3, CONCRETE],
    [55.5, 13.5, 4, GLASS],
    [59.5, 14.5, 3.4, CONCRETE],
    [63, 13, 3.6, GLASS],
    [66.5, 11, 3, CONCRETE],
    [80, 8.5, 9, CONCRETE],
    [87, 9.5, 2.4, GLASS],
    [100, 7, 2, CONCRETE],
    [112, 6.2, 2, CONCRETE],
  ] as [number, number, number, THREE.Material][]) {
    g.add(part(new THREE.CylinderGeometry(r, r * 0.94, h, 24), mat, y));
  }
  // Antenna in aviation bands.
  for (let i = 0; i < 7; i++) {
    const r = 1.5 - i * 0.16;
    g.add(part(new THREE.CylinderGeometry(r * 0.9, r, 9, 8), i % 2 ? WHITE : RED, 136.5 + i * 9));
  }
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff4030 }));
  beacon.position.y = 196;
  beacon.name = 'beacon';
  g.add(beacon);
  return g;
}

/** Parliament House flag mast: four stainless legs meeting 81 m up, under a flag the size of a bus. */
function flagMast(): THREE.Group {
  const g = new THREE.Group();
  const half = 23;
  for (const [sx, sz] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      // Each leg leans in, then straightens as it nears the collar.
      const spread = half * (1 - t) ** 1.7;
      pts.push(new THREE.Vector3(sx * spread, t * 64, sz * spread));
    }
    g.add(part(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 1.25, 3), STEEL));
  }
  g.add(part(new THREE.CylinderGeometry(1.6, 2.4, 5, 8), STEEL, 64));
  g.add(part(new THREE.CylinderGeometry(0.35, 0.6, 17, 6), STEEL, 72.5));
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#012169';
  ctx.fillRect(0, 0, 256, 128);
  // Canton: the Union Jack reduced to its crosses.
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(128, 64);
  ctx.moveTo(128, 0);
  ctx.lineTo(0, 64);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillRect(52, 0, 24, 64);
  ctx.fillRect(0, 22, 128, 20);
  ctx.fillStyle = '#e4002b';
  ctx.fillRect(57, 0, 14, 64);
  ctx.fillRect(0, 26, 128, 12);
  const star = (x: number, y: number, r: number) => {
    ctx.beginPath();
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 - Math.PI / 2;
      const rr = i % 2 ? r * 0.45 : r;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.fillStyle = '#fff';
    ctx.fill();
  };
  star(64, 98, 18);
  for (const [x, y, r] of [
    [192, 22, 9],
    [160, 58, 9],
    [224, 50, 9],
    [192, 106, 9],
    [208, 74, 5],
  ])
    star(x, y, r);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const flagGeo = new THREE.PlaneGeometry(12.8, 6.4, 12, 1);
  const flag = new THREE.Mesh(flagGeo, new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide }));
  flag.position.set(6.6, 77.2, 0);
  flag.name = 'flag';
  flag.castShadow = true;
  g.add(flag);
  return g;
}

/** National Carillon: three angled white columns on Queen Elizabeth II Island, 50 m tall. */
function carillon(): THREE.Group {
  const g = new THREE.Group();
  const column = (h: number) => {
    const shape = new THREE.Shape();
    shape.moveTo(-3.2, -2.2);
    shape.lineTo(3.2, -2.2);
    shape.lineTo(0, 4.6);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    return geo;
  };
  for (const [i, h] of [50, 44, 38].entries()) {
    const m = part(column(h), WHITE);
    const a = (i / 3) * Math.PI * 2;
    m.position.set(Math.sin(a) * 5.4, 0, Math.cos(a) * 5.4);
    m.rotation.y = a;
    g.add(m);
  }
  // The clavier chamber and bell deck slung between them.
  g.add(part(new THREE.CylinderGeometry(7.2, 7.2, 6, 3), WHITE, 27));
  g.add(part(new THREE.CylinderGeometry(6.2, 6.2, 5, 3), lambert(0x4a4f55), 34));
  return g;
}

/** Australian-American Memorial at Russell: a 73 m aluminium column under an eagle with raised wings. */
function eagle(): THREE.Group {
  const g = new THREE.Group();
  g.add(part(new THREE.CylinderGeometry(4.2, 5, 3, 8), CONCRETE, 1.5));
  g.add(part(new THREE.CylinderGeometry(1.1, 2.3, 60, 8), STEEL, 33));
  g.add(part(new THREE.SphereGeometry(2.6, 10, 8), STEEL, 64.5));
  const wing = new THREE.Shape();
  wing.moveTo(0, 0);
  wing.lineTo(2.2, 0.5);
  wing.lineTo(3.4, 9);
  wing.lineTo(1.2, 5);
  wing.closePath();
  for (const side of [1, -1]) {
    const m = part(new THREE.ExtrudeGeometry(wing, { depth: 0.6, bevelEnabled: false }), STEEL, 65);
    m.scale.x = side;
    m.position.x = side * 0.6;
    g.add(m);
  }
  g.add(part(new THREE.ConeGeometry(0.9, 2.2, 6), STEEL, 68.6, 0, 1.3));
  return g;
}

/** Captain Cook Memorial Jet: a plume up to 147 m over the Central Basin. */
function cookJet(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false });
  const column = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 1.1, 118, 10, 1, true), mat);
  column.position.y = 59;
  const crown = new THREE.Mesh(new THREE.SphereGeometry(7, 10, 8), mat);
  crown.scale.set(1, 1.5, 1);
  crown.position.y = 118;
  // The wind carries the falling water off to one side.
  const veil = new THREE.Mesh(
    new THREE.ConeGeometry(16, 110, 10, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  veil.position.set(9, 60, 3);
  veil.rotation.z = -0.12;
  g.add(column, crown, veil);
  g.name = 'jet';
  return g;
}

function balloon(hex: number, stripe: number): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.SphereGeometry(9, 12, 10);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const a = new THREE.Color(hex);
  const b = new THREE.Color(stripe);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    // Pinch the lower half into the classic teardrop.
    if (y < 0) {
      const k = 1 + (y / 9) * 0.55;
      pos.setX(i, pos.getX(i) * k);
      pos.setZ(i, pos.getZ(i) * k);
      pos.setY(i, y * 1.35);
    }
    const band = Math.floor((Math.atan2(pos.getZ(i), pos.getX(i)) / Math.PI + 1) * 6 + 0.001) % 2;
    const c = band ? a : b;
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  g.add(part(geo, new THREE.MeshLambertMaterial({ vertexColors: true }), 0));
  g.add(part(new THREE.BoxGeometry(1.6, 1.3, 1.6), lambert(0x8a6a44), -15.5));
  return g;
}

interface Placed {
  id: string;
  object: THREE.Object3D;
  x: number;
  z: number;
  /** Metres above the ground the model's origin sits. */
  lift: number;
  settled: boolean;
}

export interface Place {
  name: string;
  note: string;
  lon: number;
  lat: number;
  dist: number;
  bearing: number;
  tilt: number;
}

/** Views worth flying to. Bearing is the way the camera looks. */
export const PLACES: Place[] = [
  { name: 'Parliament House', note: 'Capital Hill', lon: 149.1246, lat: -35.3078, dist: 1100, bearing: 205, tilt: 62 },
  {
    name: 'Lake Burley Griffin',
    note: 'Central Basin and the bridges',
    lon: 149.1305,
    lat: -35.2925,
    dist: 3200,
    bearing: 200,
    tilt: 60,
  },
  {
    name: 'Civic',
    note: 'City centre and light rail terminus',
    lon: 149.1302,
    lat: -35.2795,
    dist: 1300,
    bearing: 345,
    tilt: 60,
  },
  {
    name: 'Black Mountain Tower',
    note: '195 m above the summit',
    lon: 149.0978,
    lat: -35.2752,
    dist: 1400,
    bearing: 285,
    tilt: 66,
  },
  {
    name: 'Australian War Memorial',
    note: 'Foot of Mount Ainslie',
    lon: 149.1487,
    lat: -35.2815,
    dist: 1000,
    bearing: 45,
    tilt: 62,
  },
  {
    name: 'National Carillon',
    note: 'Queen Elizabeth II Island',
    lon: 149.1417,
    lat: -35.2988,
    dist: 700,
    bearing: 150,
    tilt: 64,
  },
  { name: 'National Museum', note: 'Acton Peninsula', lon: 149.1205, lat: -35.2925, dist: 900, bearing: 250, tilt: 60 },
  {
    name: 'Australian National University',
    note: 'Acton',
    lon: 149.1189,
    lat: -35.2777,
    dist: 1500,
    bearing: 300,
    tilt: 58,
  },
  { name: 'Kingston Foreshore', note: 'East Basin', lon: 149.1464, lat: -35.3103, dist: 1000, bearing: 130, tilt: 60 },
  { name: 'Belconnen', note: 'Lake Ginninderra', lon: 149.0694, lat: -35.2372, dist: 1900, bearing: 20, tilt: 60 },
  { name: 'Woden', note: 'Town centre', lon: 149.0862, lat: -35.3451, dist: 1300, bearing: 200, tilt: 60 },
  {
    name: 'Gungahlin',
    note: 'Northern light rail terminus',
    lon: 149.1341,
    lat: -35.1853,
    dist: 1300,
    bearing: 20,
    tilt: 60,
  },
  { name: 'Tuggeranong', note: 'Lake Tuggeranong', lon: 149.0673, lat: -35.4155, dist: 1800, bearing: 180, tilt: 60 },
  { name: 'Canberra Airport', note: 'Majura', lon: 149.1937, lat: -35.3053, dist: 2600, bearing: 60, tilt: 60 },
  {
    name: 'National Arboretum',
    note: 'Molonglo Valley',
    lon: 149.0703,
    lat: -35.2878,
    dist: 1900,
    bearing: 260,
    tilt: 60,
  },
];

export class Landmarks {
  readonly group = new THREE.Group();
  private placed: Placed[] = [];
  private balloons: {
    object: THREE.Object3D;
    phase: number;
    radius: number;
    height: number;
    cx: number;
    cz: number;
  }[] = [];
  private jet: THREE.Object3D;
  private flag: THREE.Mesh | undefined;
  private flagBase: Float32Array | undefined;
  private beacon: THREE.Object3D | undefined;

  constructor() {
    const put = (id: string, object: THREE.Object3D, lon: number, lat: number, lift = 0) => {
      const [x, y] = lonLatToWorld(lon, lat);
      object.position.set(x, 0, -y);
      this.placed.push({ id, object, x, z: -y, lift, settled: false });
      this.group.add(object);
      return object;
    };
    const tower = put('tower', blackMountainTower(), 149.09777, -35.27554);
    this.beacon = tower.getObjectByName('beacon');
    const mast = put('mast', flagMast(), 149.12445, -35.30816, 20);
    const mastAt = this.placed[this.placed.length - 1];
    mastAt.x = MAST[0];
    mastAt.z = -MAST[1];
    mast.position.set(MAST[0], 0, -MAST[1]);
    this.flag = mast.getObjectByName('flag') as THREE.Mesh;
    this.flagBase = (this.flag.geometry.attributes.position.array as Float32Array).slice();
    put('carillon', carillon(), 149.14174, -35.2985);
    put('eagle', eagle(), 149.15003, -35.29756);
    this.jet = put('jet', cookJet(), 149.12893, -35.28893);
    const liveries: [number, number][] = [
      [0xd8452e, 0xf2c14e],
      [0x2f6fb5, 0xf4f2ec],
      [0x3c9a5f, 0xf2d24b],
      [0x8a3fa0, 0xf08a3c],
      [0xe06a8c, 0xf4f2ec],
      [0xf2a83b, 0x2b4a8c],
      [0xc8322b, 0xf4f2ec],
    ];
    const [bx, by] = lonLatToWorld(149.1285, -35.2965);
    for (const [i, [a, b]] of liveries.entries()) {
      const object = balloon(a, b);
      this.group.add(object);
      this.balloons.push({
        object,
        phase: i * 0.9,
        radius: 500 + i * 260,
        height: 160 + ((i * 53) % 190),
        cx: bx + ((i * 331) % 900) - 450,
        cz: -by + ((i * 577) % 700) - 350,
      });
    }
  }

  /** Stands each model on the ground once its tile has arrived. */
  settle(heightAt: (x: number, z: number) => number | undefined, coarse: (x: number, z: number) => number) {
    for (const p of this.placed) {
      if (p.settled) continue;
      const h = heightAt(p.x, p.z);
      p.object.position.y = (h ?? coarse(p.x, p.z)) + p.lift;
      if (h != null) p.settled = true;
    }
  }

  /** Moves a model to where the source data maps the real structure. */
  moveTo(id: string, x: number, z: number) {
    const p = this.placed.find((q) => q.id === id);
    if (!p) return;
    p.x = x;
    p.z = z;
    p.object.position.x = x;
    p.object.position.z = z;
    p.settled = false;
  }

  /** Tiles reload when the camera returns, and the ground under a model may have been pressed down by water. */
  unsettle() {
    for (const p of this.placed) p.settled = false;
  }

  update(time: number, hour: number, night: number) {
    // The jet runs through the middle of the day, as the real one does.
    const on = hour >= 10.5 && hour <= 16.5;
    this.jet.visible = on;
    this.jet.scale.set(1, 1 + Math.sin(time * 1.7) * 0.03, 1);
    if (this.flag && this.flagBase) {
      const pos = this.flag.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = this.flagBase[i * 3];
        pos.setZ(i, Math.sin(x * 0.7 - time * 4) * 0.5 * ((x + 6.4) / 12.8));
      }
      pos.needsUpdate = true;
    }
    if (this.beacon) this.beacon.visible = night > 0.3 && Math.sin(time * 3) > 0;
    // Balloons fly at dawn; a few linger through the morning.
    const aloft = hour > 5.5 && hour < 10.5;
    for (const b of this.balloons) {
      b.object.visible = aloft;
      if (!aloft) continue;
      const a = b.phase + time * 0.012;
      b.object.position.set(
        b.cx + Math.cos(a) * b.radius,
        b.height + Math.sin(time * 0.2 + b.phase) * 12,
        b.cz + Math.sin(a * 1.3) * b.radius * 0.6,
      );
    }
  }
}

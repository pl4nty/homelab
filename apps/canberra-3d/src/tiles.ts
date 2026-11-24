// Streams tiles in around the camera and turns worker output into scene objects.
import * as THREE from 'three';
import { TILE_SIZE, TILE_Z, tileBoundsWorld, tileInExtent, worldToTile } from '../shared/geo.ts';
import { DEM_N } from '../shared/tile.ts';
import { CAR } from './gen/palette.ts';
import type { BuildReply, BuildRequest, Built, Label, MeshData } from './gen/types.ts';
import { buildingMaterial, vertexColourMaterial, waterMaterial } from './materials.ts';
import type { TreeFactory } from './trees.ts';

const N = DEM_N + 1;
const NEAR_RES = 1024;
const FAR_RES = 512;
export const MASK_SIZE = 128;

interface Entry {
  key: string;
  x: number;
  y: number;
  state: 'queued' | 'loading' | 'ready' | 'error';
  group?: THREE.Group;
  built?: Built;
  ground?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  res: number;
  repainting?: boolean;
  near: boolean;
  nearObjects: THREE.Object3D[];
  farTrees: THREE.InstancedMesh[];
  lamps?: THREE.Points;
  lanes?: { start: number; count: number; length: number }[];
  retryAt?: number;
  originX: number;
  originZ: number;
}

function meshFrom(d: MeshData, material: THREE.Material): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(d.color, 3, true));
  if (d.wall) g.setAttribute('wall', new THREE.BufferAttribute(d.wall, 4));
  g.setIndex(new THREE.BufferAttribute(d.index, 1));
  const m = new THREE.Mesh(g, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function carGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(1.8, 0.62, 4.3).translate(0, 0.52, 0).toNonIndexed();
  const cabin = new THREE.BoxGeometry(1.62, 0.52, 2.3).translate(0, 1.08, -0.15).toNonIndexed();
  const paint = (g: THREE.BufferGeometry, v: number) => {
    const c = new Float32Array(g.attributes.position.count * 3).fill(v);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.deleteAttribute('uv');
  };
  paint(body, 1);
  paint(cabin, 0.12);
  const pos = new Float32Array(body.attributes.position.count * 3 * 2);
  const nor = new Float32Array(pos.length);
  const col = new Float32Array(pos.length);
  for (const [i, g] of [body, cabin].entries()) {
    pos.set(g.attributes.position.array, i * body.attributes.position.count * 3);
    nor.set(g.attributes.normal.array, i * body.attributes.position.count * 3);
    col.set(g.attributes.color.array, i * body.attributes.position.count * 3);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

function lampSprite(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,220,160,0.55)');
  g.addColorStop(1, 'rgba(255,200,120,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class TileManager {
  readonly group = new THREE.Group();
  readonly tiles = new Map<string, Entry>();
  /** One byte per tile around the origin: 255 where a tile is drawn, so the far terrain can step aside. */
  readonly mask: THREE.DataTexture;
  readonly maskOrigin: [number, number];
  private maskTile: [number, number];
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private jobs = new Map<number, { entry: Entry; worker: Worker; ground: boolean }>();
  private nextId = 1;
  private buildings = buildingMaterial();
  private plain = vertexColourMaterial();
  private water = waterMaterial();
  private carGeo = carGeometry();
  private carMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private poleGeo = new THREE.CylinderGeometry(0.07, 0.1, 1, 4).translate(0, 0.5, 0);
  private poleMat = new THREE.MeshLambertMaterial({ color: 0x8d9296 });
  readonly lampMat: THREE.PointsMaterial;
  maxAnisotropy = 8;
  onLabels?: (key: string, labels: Label[] | null, origin: [number, number]) => void;
  onChange?: () => void;
  focus = new THREE.Vector2();
  missing = new Set<string>();

  constructor(
    private trees: TreeFactory,
    workerCount: number,
  ) {
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(new URL('./gen/worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<BuildReply>) => this.onReply(w, e.data);
      this.workers.push(w);
      this.idle.push(w);
    }
    const [ox, oy] = worldToTile(0, 0);
    this.maskTile = [ox - MASK_SIZE / 2, oy - MASK_SIZE / 2];
    const b = tileBoundsWorld(TILE_Z, this.maskTile[0], this.maskTile[1]);
    this.maskOrigin = [b[0], -b[3]];
    this.mask = new THREE.DataTexture(new Uint8Array(MASK_SIZE * MASK_SIZE), MASK_SIZE, MASK_SIZE, THREE.RedFormat);
    this.mask.magFilter = this.mask.minFilter = THREE.NearestFilter;
    this.mask.needsUpdate = true;
    this.lampMat = new THREE.PointsMaterial({
      map: lampSprite(),
      size: 13,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: 0xffd9a0,
      opacity: 0,
    });
  }

  get loading(): number {
    let n = 0;
    for (const e of this.tiles.values()) if (e.state === 'queued' || e.state === 'loading') n++;
    return n;
  }

  private setMask(e: Entry, on: boolean) {
    const mx = e.x - this.maskTile[0];
    const my = e.y - this.maskTile[1];
    if (mx < 0 || my < 0 || mx >= MASK_SIZE || my >= MASK_SIZE) return;
    (this.mask.image.data as Uint8Array)[my * MASK_SIZE + mx] = on ? 255 : 0;
    this.mask.needsUpdate = true;
  }

  /** Ground height above BASE at scene x, z; undefined where no tile is loaded. */
  heightAt(x: number, z: number): number | undefined {
    const [tx, ty] = worldToTile(x, -z);
    const e = this.tiles.get(`${tx}/${ty}`);
    if (!e?.built) return undefined;
    const h = e.built.heights;
    const step = TILE_SIZE / DEM_N;
    const fx = Math.min(DEM_N, Math.max(0, (x - e.originX) / step));
    const fy = Math.min(DEM_N, Math.max(0, (e.originZ - z) / step));
    const ix = Math.min(DEM_N - 1, Math.floor(fx));
    const iy = Math.min(DEM_N - 1, Math.floor(fy));
    const ax = fx - ix;
    const ay = fy - iy;
    const i = iy * N + ix;
    return (h[i] * (1 - ax) + h[i + 1] * ax) * (1 - ay) + (h[i + N] * (1 - ax) + h[i + N + 1] * ax) * ay;
  }

  /** Loads what lies within `radius` of the focus, drops what is well outside it, and sets detail. */
  update(fx: number, fz: number, radius: number, nearRadius: number) {
    this.focus.set(fx, fz);
    const [cx, cy] = worldToTile(fx, -fz);
    const reach = Math.ceil(radius / TILE_SIZE);
    const wanted = new Set<string>();
    const now = performance.now();
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!tileInExtent(x, y)) continue;
        if (this.distance(x, y, fx, fz) > radius) continue;
        const key = `${x}/${y}`;
        wanted.add(key);
        let e = this.tiles.get(key);
        if (!e) {
          const b = tileBoundsWorld(TILE_Z, x, y);
          e = {
            key,
            x,
            y,
            state: 'queued',
            res: FAR_RES,
            near: false,
            nearObjects: [],
            farTrees: [],
            originX: b[0],
            originZ: -b[1],
          };
          this.tiles.set(key, e);
        } else if (e.state === 'error' && e.retryAt && now > e.retryAt) {
          e.state = 'queued';
        }
      }
    }
    for (const [key, e] of this.tiles) {
      if (wanted.has(key)) continue;
      // Keep a margin so panning back and forth does not thrash.
      if (this.distance(e.x, e.y, fx, fz) > radius * 1.35 + TILE_SIZE) this.drop(e);
    }
    for (const e of this.tiles.values()) {
      if (e.state !== 'ready') continue;
      const d = this.distance(e.x, e.y, fx, fz);
      const near = d < (e.near ? nearRadius * 1.2 : nearRadius);
      if (near !== e.near) this.setDetail(e, near);
      const res = d < nearRadius * 0.9 ? NEAR_RES : FAR_RES;
      if (res > e.res && !e.repainting) this.repaint(e, res);
    }
    this.pump();
  }

  private distance(x: number, y: number, fx: number, fz: number): number {
    const b = tileBoundsWorld(TILE_Z, x, y);
    // Nearest point of the tile, so the tile under the camera counts as distance zero.
    const dx = Math.max(b[0] - fx, 0, fx - b[2]);
    const dz = Math.max(-b[3] - fz, 0, fz + b[1]);
    return Math.hypot(dx, dz);
  }

  private pump() {
    if (!this.idle.length) return;
    const queued = [...this.tiles.values()].filter((e) => e.state === 'queued');
    queued.sort(
      (a, b) =>
        this.distance(a.x, a.y, this.focus.x, this.focus.y) - this.distance(b.x, b.y, this.focus.x, this.focus.y),
    );
    for (const e of queued) {
      const w = this.idle.pop();
      if (!w) break;
      e.state = 'loading';
      const near = this.distance(e.x, e.y, this.focus.x, this.focus.y) < 600;
      e.res = near ? NEAR_RES : FAR_RES;
      this.send(w, e, { x: e.x, y: e.y, res: e.res }, false);
    }
  }

  private send(w: Worker, entry: Entry, req: Omit<BuildRequest, 'id'>, ground: boolean) {
    const id = this.nextId++;
    this.jobs.set(id, { entry, worker: w, ground });
    w.postMessage({ id, ...req } satisfies BuildRequest);
  }

  private repaint(e: Entry, res: number) {
    const w = this.idle.pop();
    if (!w) return;
    e.repainting = true;
    this.send(w, e, { x: e.x, y: e.y, res, groundOnly: true }, true);
  }

  private onReply(w: Worker, reply: BuildReply) {
    const job = this.jobs.get(reply.id);
    this.jobs.delete(reply.id);
    this.idle.push(w);
    if (job) {
      const e = job.entry;
      const alive = this.tiles.get(e.key) === e;
      if (!reply.ok) {
        if (job.ground) e.repainting = false;
        else {
          e.state = 'error';
          e.retryAt = performance.now() + 15000;
          console.warn(reply.error);
        }
      } else if ('ground' in reply) {
        e.repainting = false;
        if (alive && e.ground) {
          e.ground.material.map?.dispose();
          e.ground.material.map = this.texture(reply.ground);
          e.res = reply.ground.width;
        } else reply.ground.close();
      } else if (alive) this.attach(e, reply.built);
      else reply.built.ground.close();
    }
    this.pump();
    this.onChange?.();
  }

  private texture(bitmap: ImageBitmap): THREE.Texture {
    const t = new THREE.Texture(bitmap);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    t.anisotropy = this.maxAnisotropy;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    // The pixels live on the GPU after the first upload; free the copy.
    t.onUpdate = () => bitmap.close();
    return t;
  }

  private attach(e: Entry, b: Built) {
    const group = new THREE.Group();
    group.position.set(e.originX, 0, e.originZ);
    group.matrixAutoUpdate = false;
    group.updateMatrix();

    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(b.terrain.pos, 3));
    tg.setAttribute('normal', new THREE.BufferAttribute(b.terrain.normal, 3));
    tg.setAttribute('uv', new THREE.BufferAttribute(b.terrain.uv, 2));
    tg.setIndex(new THREE.BufferAttribute(b.terrain.index, 1));
    const ground = new THREE.Mesh(tg, new THREE.MeshLambertMaterial({ map: this.texture(b.ground) }));
    ground.receiveShadow = true;
    group.add(ground);
    e.ground = ground;

    if (b.buildings) group.add(meshFrom(b.buildings, this.buildings));
    if (b.bridges) group.add(meshFrom(b.bridges, this.plain));
    if (b.water) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.BufferAttribute(b.water.pos, 3));
      wg.setIndex(new THREE.BufferAttribute(b.water.index, 1));
      wg.computeVertexNormals();
      const wm = new THREE.Mesh(wg, this.water);
      wm.receiveShadow = true;
      wm.renderOrder = 1;
      group.add(wm);
    }
    e.farTrees = this.trees.build(b.trees, false);
    for (const t of e.farTrees) group.add(t);

    if (b.lights.length) {
      const pos = new Float32Array((b.lights.length / 4) * 3);
      for (let i = 0, o = 0; i < b.lights.length; i += 4, o += 3) {
        pos[o] = b.lights[i];
        pos[o + 1] = b.lights[i + 1] + b.lights[i + 3];
        pos[o + 2] = b.lights[i + 2];
      }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      e.lamps = new THREE.Points(lg, this.lampMat);
      e.lamps.renderOrder = 3;
      group.add(e.lamps);
    }

    // Index the traffic lanes: where each starts in the buffer and how long it runs.
    e.lanes = [];
    for (let i = 0; i < b.lanes.length; ) {
      const count = b.lanes[i];
      let length = 0;
      for (let k = 1; k < count; k++) {
        const o = i + 1 + k * 3;
        length += Math.hypot(b.lanes[o] - b.lanes[o - 3], b.lanes[o + 2] - b.lanes[o - 1]);
      }
      e.lanes.push({ start: i + 1, count, length });
      i += 1 + count * 3;
    }

    e.group = group;
    e.built = b;
    e.state = 'ready';
    if (b.stats.missing) this.missing.add(b.stats.missing);
    this.group.add(group);
    this.setMask(e, true);
    this.onLabels?.(e.key, b.labels, [e.originX, e.originZ]);
  }

  private setDetail(e: Entry, near: boolean) {
    e.near = near;
    const b = e.built!;
    for (const o of e.nearObjects) this.dispose(o);
    e.nearObjects = [];
    for (const t of e.farTrees) t.visible = !near;
    if (!near) return;
    for (const t of this.trees.build(b.trees, true)) {
      e.group!.add(t);
      e.nearObjects.push(t);
    }
    const cars = b.cars.length / 5;
    if (cars) {
      const mesh = new THREE.InstancedMesh(this.carGeo, this.carMat, cars);
      const m = new THREE.Matrix4();
      const c = new THREE.Color();
      for (let i = 0; i < cars; i++) {
        const o = i * 5;
        m.makeRotationY(-b.cars[o + 3]).setPosition(b.cars[o], b.cars[o + 1], b.cars[o + 2]);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, c.setHex(CAR[b.cars[o + 4] % CAR.length]));
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      e.group!.add(mesh);
      e.nearObjects.push(mesh);
    }
    const lights = b.lights.length / 4;
    if (lights) {
      const mesh = new THREE.InstancedMesh(this.poleGeo, this.poleMat, lights);
      const m = new THREE.Matrix4();
      for (let i = 0; i < lights; i++) {
        const o = i * 4;
        m.makeScale(1, b.lights[o + 3], 1).setPosition(b.lights[o], b.lights[o + 1], b.lights[o + 2]);
        mesh.setMatrixAt(i, m);
      }
      e.group!.add(mesh);
      e.nearObjects.push(mesh);
    }
  }

  /** Rebuilds tree instances everywhere, for a change of season. */
  refreshTrees() {
    for (const e of this.tiles.values()) {
      if (e.state !== 'ready' || !e.built) continue;
      for (const t of e.farTrees) this.dispose(t);
      e.farTrees = this.trees.build(e.built.trees, false);
      for (const t of e.farTrees) e.group!.add(t);
      this.setDetail(e, e.near);
    }
  }

  private dispose(o: THREE.Object3D) {
    o.removeFromParent();
    if (o instanceof THREE.InstancedMesh) o.dispose();
    else if (o instanceof THREE.Mesh || o instanceof THREE.Points) o.geometry.dispose();
  }

  private drop(e: Entry) {
    this.tiles.delete(e.key);
    if (!e.group) return;
    this.setMask(e, false);
    this.onLabels?.(e.key, null, [0, 0]);
    this.group.remove(e.group);
    e.ground?.material.map?.dispose();
    e.ground?.material.dispose();
    for (const o of [...e.group.children]) this.dispose(o);
    e.built?.ground.close();
  }

  /** Ready tiles close enough to carry moving traffic. */
  nearTiles(): Entry[] {
    const out: Entry[] = [];
    for (const e of this.tiles.values()) if (e.state === 'ready' && e.near) out.push(e);
    return out;
  }
}

export type TileEntry = Entry;

// Ambient traffic: cars running along the through roads of the tiles near the camera.
// It is set dressing, not data; the live vehicles are in live.ts.
import * as THREE from 'three';
import { CAR } from './gen/palette.ts';
import { hash2 } from './gen/types.ts';
import type { TileEntry, TileManager } from './tiles.ts';

/** Per car: lane, metres along it, speed, direction (+1 or -1). */
const STRIDE = 4;

export class Traffic {
  enabled = true;
  private m = new THREE.Matrix4();
  private c = new THREE.Color();

  constructor(private tiles: TileManager) {}

  private spawn(e: TileEntry) {
    const lanes = e.lanes ?? [];
    const cars: number[] = [];
    for (const [i, lane] of lanes.entries()) {
      const length = lane.cum[lane.count - 1];
      // A car every 70 m or so, fewer on short stubs.
      const n = Math.min(8, Math.floor(length / 70 + hash2(i, e.x * 31 + e.y) * 0.9));
      for (let k = 0; k < n && cars.length < 90 * STRIDE; k++) {
        const r = hash2(i * 7 + k, e.x + e.y * 17);
        cars.push(i, r * length, 11 + r * 6, lane.oneway || hash2(k, i) > 0.5 ? 1 : -1);
      }
    }
    if (!cars.length) return;
    const mesh = new THREE.InstancedMesh(this.tiles.carGeo, this.tiles.carMat, cars.length / STRIDE);
    for (let k = 0; k < cars.length / STRIDE; k++)
      mesh.setColorAt(k, this.c.setHex(CAR[Math.floor(hash2(k, e.x * 3 + e.y) * CAR.length)]));
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    e.group!.add(mesh);
    e.traffic = { mesh, cars: new Float32Array(cars) };
  }

  update(dt: number) {
    for (const e of this.tiles.nearTiles()) {
      if (!e.traffic) {
        if (!this.enabled || !e.lanes?.length) continue;
        this.spawn(e);
        if (!e.traffic) {
          e.lanes = [];
          continue;
        }
      }
      const { mesh, cars } = e.traffic!;
      mesh.visible = this.enabled;
      if (!this.enabled) continue;
      const buf = e.built!.lanes;
      for (let k = 0, n = cars.length / STRIDE; k < n; k++) {
        const o = k * STRIDE;
        const lane = e.lanes![cars[o]];
        const length = lane.cum[lane.count - 1];
        const dir = cars[o + 3];
        let s = cars[o + 1] + cars[o + 2] * dt * dir;
        if (s > length) s -= length;
        else if (s < 0) s += length;
        cars[o + 1] = s;
        let i = 1;
        while (i < lane.count - 1 && lane.cum[i] < s) i++;
        const a = lane.start + (i - 1) * 3;
        const b = a + 3;
        const t = (s - lane.cum[i - 1]) / (lane.cum[i] - lane.cum[i - 1] || 1);
        let dx = (buf[b] - buf[a]) * dir;
        let dz = (buf[b + 2] - buf[a + 2]) * dir;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
        // Keep left: one-way roads are a carriageway already, two-way roads split about the centreline.
        const off = lane.oneway ? 0 : 1.75;
        this.m.makeRotationY(Math.atan2(-dx, -dz));
        this.m.setPosition(
          buf[a] + (buf[b] - buf[a]) * t + dz * off,
          buf[a + 1] + (buf[b + 1] - buf[a + 1]) * t,
          buf[a + 2] + (buf[b + 2] - buf[a + 2]) * t - dx * off,
        );
        mesh.setMatrixAt(k, this.m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

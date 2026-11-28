// The coarse terrain beyond the loaded tiles: ranges on the horizon, cut away wherever real tiles are drawn.
import * as THREE from 'three';
import { TILE_SIZE } from '../shared/geo.ts';
import { BASE } from './gen/types.ts';
import { MASK_SIZE, type TileManager } from './tiles.ts';

interface FarTerrain {
  box: [number, number, number, number];
  n: number;
  h: number[];
}

export class Far {
  mesh: THREE.Mesh | null = null;
  private data: FarTerrain | null = null;

  async load(tiles: TileManager): Promise<THREE.Mesh> {
    const d = (await (await fetch('/api/far')).json()) as FarTerrain;
    this.data = d;
    const n = d.n + 1;
    const [x0, y0, x1, y1] = d.box;
    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const sx = (x1 - x0) / d.n;
    const sy = (y1 - y0) / d.n;
    const straw = new THREE.Color(0xa9b56c);
    const bush = new THREE.Color(0x5d8a4e);
    const high = new THREE.Color(0x4a7354);
    const c = new THREE.Color();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const h = d.h[k];
        pos[k * 3] = x0 + i * sx;
        // Sunk a little, so it never pokes through the detailed ground at the seam.
        pos[k * 3 + 1] = h - BASE - 6;
        pos[k * 3 + 2] = -(y0 + j * sy);
        const hx = d.h[j * n + Math.min(d.n, i + 1)] - d.h[j * n + Math.max(0, i - 1)];
        const hy = d.h[Math.min(d.n, j + 1) * n + i] - d.h[Math.max(0, j - 1) * n + i];
        const slope = Math.hypot(hx / (2 * sx), hy / (2 * sy));
        // Flats are pasture; slopes and high country are forest.
        const wooded = Math.min(1, Math.max(0, slope * 9 - 0.25) + Math.max(0, (h - 760) / 300));
        c.copy(straw)
          .lerp(bush, wooded)
          .lerp(high, Math.min(1, Math.max(0, (h - 1100) / 500)));
        col[k * 3] = c.r;
        col[k * 3 + 1] = c.g;
        col[k * 3 + 2] = c.b;
      }
    }
    const index = new Uint32Array(d.n * d.n * 6);
    let m = 0;
    for (let j = 0; j < d.n; j++) {
      for (let i = 0; i < d.n; i++) {
        const a = j * n + i;
        index[m++] = a;
        index[m++] = a + 1;
        index[m++] = a + n + 1;
        index[m++] = a;
        index[m++] = a + n + 1;
        index[m++] = a + n;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uMask = { value: tiles.mask };
      shader.uniforms.uMaskOrigin = { value: new THREE.Vector2(...tiles.maskOrigin) };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vTile;\nuniform vec2 uMaskOrigin;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>\nvTile = (position.xz - uMaskOrigin) / ${TILE_SIZE.toFixed(4)};`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vTile;\nuniform sampler2D uMask;')
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>\nif (texture2D(uMask, (floor(vTile) + 0.5) / ${MASK_SIZE}.0).r > 0.5) discard;`,
        );
    };
    this.mesh = new THREE.Mesh(g, mat);
    return this.mesh;
  }

  /** Coarse ground height above BASE, for where no tile has loaded yet. */
  heightAt(x: number, z: number): number {
    const d = this.data;
    if (!d) return 20;
    const fx = Math.min(d.n - 1e-3, Math.max(0, ((x - d.box[0]) / (d.box[2] - d.box[0])) * d.n));
    const fy = Math.min(d.n - 1e-3, Math.max(0, ((-z - d.box[1]) / (d.box[3] - d.box[1])) * d.n));
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const n = d.n + 1;
    const ax = fx - ix;
    const ay = fy - iy;
    const i = iy * n + ix;
    return (d.h[i] * (1 - ax) + d.h[i + 1] * ax) * (1 - ay) + (d.h[i + n] * (1 - ax) + d.h[i + n + 1] * ax) * ay - BASE;
  }
}

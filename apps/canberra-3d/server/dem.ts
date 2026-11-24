// Ground elevation from the Mapzen/AWS Terrain Tiles (Terrarium encoding), which mosaic the best
// open DEM for each area.
import { decode } from 'fast-png';
import { HALF, worldToMercX, worldToMercY } from '../shared/geo.ts';
import { type DiskCache, Lru } from './cache.ts';
import { fetchBuffer } from './net.ts';

const DEM_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium';
const PX = 256;

/**
 * The mosaic has stray pixels thousands of metres off (one cluster sits beside Scrivener Dam).
 * Any pixel far from the median of its neighbourhood is replaced by that median.
 */
export function despike(h: Float32Array, threshold: number, size = PX): number {
  const at = (x: number, y: number) =>
    h[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))];
  const fixes: [number, number][] = [];
  const win: number[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = h[y * size + x];
      const cross = (at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2)) / 4;
      // Cheap test first: most pixels sit close to their neighbours and need no median.
      if (v > -200 && v < 6000 && Math.abs(v - cross) < threshold / 2) continue;
      win.length = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) win.push(at(x + dx, y + dy));
      win.sort((a, b) => a - b);
      const median = win[win.length >> 1];
      if (Math.abs(v - median) > threshold) fixes.push([y * size + x, median]);
    }
  }
  for (const [i, v] of fixes) h[i] = v;
  return fixes.length;
}

export class Dem {
  private tiles = new Lru<Promise<Float32Array>>(64);
  constructor(
    private disk: DiskCache,
    public z = 14,
  ) {}

  private tile(tx: number, ty: number): Promise<Float32Array> {
    const key = `${this.z}/${tx}/${ty}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = this.disk
        .getOrBuild(`dem/${key}.png`, () => fetchBuffer(`${DEM_URL}/${key}.png`))
        .then((png) => {
          const img = decode(png);
          const out = new Float32Array(PX * PX);
          const ch = img.channels;
          for (let i = 0; i < PX * PX; i++) {
            out[i] = img.data[i * ch] * 256 + img.data[i * ch + 1] + img.data[i * ch + 2] / 256 - 32768;
          }
          // A pixel is 8 m at zoom 14; coarser zooms span more ground, so allow more relief per pixel.
          despike(out, 60 * Math.max(1, 2 ** (14 - this.z) / 2));
          return out;
        });
      // A failed download must not be remembered.
      t.catch(() => this.tiles.delete(key));
      this.tiles.set(key, t);
    }
    return t;
  }

  /** A sampler over a world-metre box; pixels load up front so sampling is synchronous. */
  async sampler(minX: number, minY: number, maxX: number, maxY: number): Promise<(x: number, y: number) => number> {
    const scale = (2 ** this.z * PX) / (2 * HALF);
    const gx = (x: number) => (worldToMercX(x) + HALF) * scale - 0.5;
    const gy = (y: number) => (HALF - worldToMercY(y)) * scale - 0.5;
    const tx0 = Math.floor(gx(minX)) >> 8;
    const tx1 = (Math.floor(gx(maxX)) + 1) >> 8;
    const ty0 = Math.floor(gy(maxY)) >> 8;
    const ty1 = (Math.floor(gy(minY)) + 1) >> 8;
    const loaded = new Map<number, Float32Array>();
    const jobs: Promise<void>[] = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        jobs.push(this.tile(tx, ty).then((t) => void loaded.set(tx * 65536 + ty, t)));
      }
    }
    await Promise.all(jobs);
    const px = (ix: number, iy: number) => {
      const t = loaded.get((ix >> 8) * 65536 + (iy >> 8));
      return t ? t[(iy & 255) * PX + (ix & 255)] : 0;
    };
    return (x, y) => {
      const fx = gx(x);
      const fy = gy(y);
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const ax = fx - ix;
      const ay = fy - iy;
      const top = px(ix, iy) * (1 - ax) + px(ix + 1, iy) * ax;
      const bottom = px(ix, iy + 1) * (1 - ax) + px(ix + 1, iy + 1) * ax;
      return top * (1 - ay) + bottom * ay;
    };
  }
}

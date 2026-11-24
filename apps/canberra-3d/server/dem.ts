// Ground elevation from the Mapzen/AWS Terrain Tiles (Terrarium encoding), which mosaic the best
// open DEM for each area.
import { decode } from 'fast-png';
import { HALF, worldToMercX, worldToMercY } from '../shared/geo.ts';
import { type DiskCache, Lru } from './cache.ts';
import { fetchBuffer } from './net.ts';

const DEM_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium';
const PX = 256;

/** No ground in south-east Australia is outside this range of metres above sea level. */
const PLAUSIBLE: [number, number] = [0, 2300];

/**
 * The mosaic has stray pixels thousands of metres off: clusters, and whole one-pixel seams along
 * 149 degrees east. A sweep of the ACT found them in 28 of 1,568 zoom-14 tiles.
 *
 * Two passes. Heights that cannot be ground here are grown over from their valid neighbours,
 * whatever the size of the cluster. Then any pixel far from the median of its neighbourhood is
 * replaced by that median, which catches the smear around a spike that is still a plausible height.
 * Returns how many pixels changed.
 */
export function despike(h: Float32Array, threshold: number, size = PX, range = PLAUSIBLE): number {
  let changed = 0;
  let bad: number[] = [];
  for (let i = 0; i < h.length; i++) if (!(h[i] >= range[0] && h[i] <= range[1])) bad.push(i);
  // A tile with no valid pixel at all has nothing to grow from; leave it for the caller's fallback.
  if (bad.length && bad.length < h.length) {
    const invalid = new Uint8Array(h.length);
    for (const i of bad) invalid[i] = 1;
    changed += bad.length;
    const near: number[] = [];
    while (bad.length) {
      const next: number[] = [];
      const filled: [number, number][] = [];
      for (const i of bad) {
        const x = i % size;
        const y = (i - x) / size;
        // The median of the valid neighbours, so a half-wrong pixel beside the spike does not leak in.
        near.length = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size || invalid[ny * size + nx]) continue;
            near.push(h[ny * size + nx]);
          }
        }
        if (near.length) filled.push([i, near.sort((p, q) => p - q)[near.length >> 1]]);
        else next.push(i);
      }
      // Apply a whole ring at once, so the fill grows evenly inwards.
      for (const [i, v] of filled) {
        h[i] = v;
        invalid[i] = 0;
      }
      if (!filled.length) break;
      bad = next;
    }
  }

  const at = (x: number, y: number) =>
    h[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))];
  const fixes: [number, number][] = [];
  const win: number[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = h[y * size + x];
      const cross = (at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2)) / 4;
      // Cheap test first: most pixels sit close to their neighbours and need no median.
      if (Math.abs(v - cross) < threshold / 2) continue;
      win.length = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) win.push(at(x + dx, y + dy));
      win.sort((a, b) => a - b);
      const median = win[win.length >> 1];
      if (Math.abs(v - median) > threshold) fixes.push([y * size + x, median]);
    }
  }
  for (const [i, v] of fixes) h[i] = v;
  return changed + fixes.length;
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

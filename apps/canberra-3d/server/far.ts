// A coarse height grid of the whole region, so the ranges stand on the horizon beyond the loaded tiles.
import { lonLatToWorld } from '../shared/geo.ts';
import type { DiskCache } from './cache.ts';
import { Dem } from './dem.ts';

export interface FarTerrain {
  /** World-metre box and grid size; heights in metres, row-major from the south-west. */
  box: [number, number, number, number];
  n: number;
  h: number[];
}

let cached: Promise<FarTerrain> | null = null;

export function farTerrain(disk: DiskCache): Promise<FarTerrain> {
  if (!cached) {
    cached = (async () => {
      const coarse = new Dem(disk, 10);
      const [x0, y0] = lonLatToWorld(148.62, -35.78);
      const [x1, y1] = lonLatToWorld(149.62, -34.92);
      const sample = await coarse.sampler(x0, y0, x1, y1);
      const n = 192;
      const h: number[] = [];
      for (let j = 0; j <= n; j++) {
        for (let i = 0; i <= n; i++) h.push(Math.round(sample(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * j) / n)));
      }
      return { box: [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)] as FarTerrain['box'], n, h };
    })();
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}

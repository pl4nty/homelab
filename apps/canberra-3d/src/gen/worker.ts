import { TILE_VERSION, type Tile } from '../../shared/tile.ts';
import { buildTile } from './build.ts';
import { paintGround } from './ground.ts';
import type { BuildReply, BuildRequest, Built, FacadeIndex } from './types.ts';

function transferables(b: Built): Transferable[] {
  const out: Transferable[] = [
    b.ground,
    b.mask,
    b.heights.buffer,
    b.terrain.pos.buffer,
    b.terrain.normal.buffer,
    b.terrain.uv.buffer,
    b.terrain.index.buffer,
    b.trees.buffer,
    b.cars.buffer,
    b.lights.buffer,
    b.lanes.buffer,
    b.surface.buffer,
    b.decks.buffer,
    b.solids.buffer,
  ];
  for (const m of [b.buildings, b.bridges]) {
    if (!m) continue;
    out.push(m.pos.buffer, m.normal.buffer, m.color.buffer, m.index.buffer);
    if (m.wall) out.push(m.wall.buffer);
    if (m.fuv) out.push(m.fuv.buffer);
  }
  if (b.water) out.push(b.water.pos.buffer, b.water.index.buffer);
  return out;
}

// ACT Government aerial photography (CC BY, ACT and Aerometrex), in the same tile scheme as the model.
const PHOTO =
  'https://tiles.arcgis.com/tiles/E5n4f1VY84i0xSjy/arcgis/rest/services/ACT_Aerial_Imagery_Current_3857/MapServer/tile';

/** The photograph of one tile, stitched from 256 px pieces: 2 m a pixel far off, half a metre up close. */
async function photograph(x: number, y: number, res: number): Promise<ImageBitmap | null> {
  const k = res >= 2048 ? 3 : res >= 1024 ? 2 : 1;
  const n = 2 ** k;
  const canvas = new OffscreenCanvas(n * 256, n * 256);
  const ctx = canvas.getContext('2d')!;
  let got = 0;
  const jobs: Promise<void>[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      jobs.push(
        (async () => {
          try {
            const r = await fetch(`${PHOTO}/${15 + k}/${y * n + j}/${x * n + i}`);
            if (!r.ok) return;
            const piece = await createImageBitmap(await r.blob());
            ctx.drawImage(piece, i * 256, j * 256);
            piece.close();
            got++;
          } catch {
            // A missing piece stays transparent and the drawn colours show through.
          }
        })(),
      );
    }
  }
  await Promise.all(jobs);
  return got ? canvas.transferToImageBitmap() : null;
}

/** Facade photographs for a tile, if the offline pipeline has made any. */
async function facadesFor(x: number, y: number): Promise<{ index: FacadeIndex; atlas: ImageBitmap } | null> {
  try {
    const r = await fetch(`/api/facades/15/${x}/${y}.json`);
    if (!r.ok) return null;
    const index = (await r.json()) as FacadeIndex;
    const img = await fetch(`/api/facades/15/${x}/${y}.webp`);
    if (!img.ok) return null;
    return { index, atlas: await createImageBitmap(await img.blob()) };
  } catch {
    return null;
  }
}

// Recently built tiles, kept so the ground can be repainted sharper without another download.
const recent = new Map<string, Tile>();

async function load(x: number, y: number): Promise<{ tile: Tile; missing: string }> {
  const key = `${x}/${y}`;
  const hit = recent.get(key);
  if (hit) return { tile: hit, missing: '' };
  // The version in the address keeps browsers and the CDN from serving tiles baked by an older build.
  const r = await fetch(`/api/tile/15/${key}?v=${TILE_VERSION}`);
  if (!r.ok) throw new Error(`tile ${key}: ${r.status}`);
  const tile = (await r.json()) as Tile;
  recent.set(key, tile);
  if (recent.size > 48) recent.delete(recent.keys().next().value!);
  return { tile, missing: r.headers.get('x-missing') ?? '' };
}

const post = (reply: BuildReply, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = async (e: MessageEvent<BuildRequest>) => {
  const { id, x, y, res, groundOnly } = e.data;
  try {
    const [{ tile, missing }, photo] = await Promise.all([load(x, y), photograph(x, y, res)]);
    if (groundOnly) {
      const painted = paintGround(tile, res);
      const ground = painted.colour.transferToImageBitmap();
      const mask = painted.mask.transferToImageBitmap();
      post({ id, ok: true, ground, mask, photo }, photo ? [ground, mask, photo] : [ground, mask]);
    } else {
      const facades = await facadesFor(x, y);
      const built = buildTile(tile, res, missing, facades?.index ?? null);
      built.photo = photo;
      built.facade = facades?.atlas ?? null;
      const extra = [photo, built.facade].filter((b) => b !== null);
      post({ id, ok: true, built }, [...transferables(built), ...extra]);
    }
  } catch (err) {
    post({ id, ok: false, error: (err as Error).message });
  }
};

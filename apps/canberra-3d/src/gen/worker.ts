import { TILE_VERSION, type Tile } from '../../shared/tile.ts';
import { buildTile } from './build.ts';
import { paintGround } from './ground.ts';
import type { BuildReply, BuildRequest, Built } from './types.ts';

function transferables(b: Built): Transferable[] {
  const out: Transferable[] = [
    b.ground,
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
  }
  if (b.water) out.push(b.water.pos.buffer, b.water.index.buffer);
  return out;
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
    const { tile, missing } = await load(x, y);
    if (groundOnly) {
      const ground = paintGround(tile, res).transferToImageBitmap();
      post({ id, ok: true, ground }, [ground]);
    } else {
      const built = buildTile(tile, res, missing);
      post({ id, ok: true, built }, transferables(built));
    }
  } catch (err) {
    post({ id, ok: false, error: (err as Error).message });
  }
};

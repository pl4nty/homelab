// Byte helpers built on Web platform APIs available in both Node >= 18 and web workers.

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const body = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export const gzip = (data: Uint8Array) => pipe(data, new CompressionStream('gzip'));
export const gunzip = (data: Uint8Array) => pipe(data, new DecompressionStream('gzip'));

export async function sha256(data: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  return 'sha256:' + Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

function nativeZstd(): boolean {
  try {
    new DecompressionStream('zstd' as CompressionFormat);
    return true;
  } catch {
    return false;
  }
}

const isGzip = (b: Uint8Array) => b[0] === 0x1f && b[1] === 0x8b;
// Zstandard frame (28 b5 2f fd) or skippable frame (5? 2a 4d 18), as written by zstd:chunked.
const isZstd = (b: Uint8Array) =>
  (b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) ||
  ((b[0] & 0xf0) === 0x50 && b[1] === 0x2a && b[2] === 0x4d && b[3] === 0x18);

export async function unzstd(data: Uint8Array): Promise<Uint8Array> {
  if (nativeZstd()) return pipe(data, new DecompressionStream('zstd' as CompressionFormat));
  const { decompress } = await import('fzstd');
  return decompress(data);
}

/** Decompress a layer blob (gzip, zstd or uncompressed), sniffing magic bytes since some registries mislabel. */
export async function decompressLayer(mediaType: string, blob: Uint8Array): Promise<Uint8Array> {
  if (isGzip(blob)) return gunzip(blob);
  if (isZstd(blob)) return unzstd(blob);
  if (mediaType.endsWith('+gzip') || mediaType.endsWith('+zstd')) throw new Error(`layer is not ${mediaType.split('+').pop()}-compressed`);
  return blob;
}

export function toBase64(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

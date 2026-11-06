// A diff document is { a, b, name } (two texts) or { patch } (unified diff).
// Short documents live in the URL fragment; longer ones are encrypted in the browser
// and uploaded, and the key stays in the fragment so the server never sees it.

export const LINK_LIMIT = 10_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function pipe(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export const compress = (doc) => pipe(encoder.encode(JSON.stringify(doc)), new CompressionStream('deflate-raw'));

export const decompress = async (bytes) =>
  JSON.parse(decoder.decode(await pipe(bytes, new DecompressionStream('deflate-raw'))));

export const encodeFragment = async (doc) => toBase64Url(await compress(doc));

export const decodeFragment = (fragment) => decompress(fromBase64Url(fragment));

// The blob is the 12-byte IV followed by the AES-GCM ciphertext of the compressed document.
export async function seal(doc) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await compress(doc));
  const blob = new Uint8Array(iv.length + ciphertext.byteLength);
  blob.set(iv);
  blob.set(new Uint8Array(ciphertext), iv.length);
  return { blob, key: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', key))) };
}

export async function unseal(blob, keyText) {
  const key = await crypto.subtle.importKey('raw', fromBase64Url(keyText), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, 12) }, key, blob.subarray(12));
  return decompress(new Uint8Array(plain));
}

// "Copy As" formats for a byte selection, matching the VS Code Hex Editor's list. No vscode imports (unit-tested).

const hex2 = (b: number) => b.toString(16).padStart(2, '0');
const list = (bytes: Uint8Array, f: (b: number) => string) => Array.from(bytes, f).join(', ');

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const COPY_FORMATS = {
  hexOctets: { label: 'Hex Octets', detail: '89 50 4e 47', format: (b) => Array.from(b, hex2).join(' ') },
  hex: { label: 'Hex', detail: '89504e47', format: (b) => Array.from(b, hex2).join('') },
  literal: {
    label: 'Literal',
    detail: '"\\x89\\x50\\x4e\\x47"',
    format: (b) => `"${Array.from(b, (x) => `\\x${hex2(x)}`).join('')}"`,
  },
  utf8: { label: 'UTF-8', detail: 'Text, decoded as UTF-8', format: (b) => new TextDecoder().decode(b) },
  c: {
    label: 'C',
    detail: 'unsigned char data[4] = { 0x89, … };',
    format: (b) => `unsigned char data[${b.length}] = { ${list(b, (x) => `0x${hex2(x)}`)} };`,
  },
  go: {
    label: 'Go',
    detail: 'data := []byte{0x89, …}',
    format: (b) => `data := []byte{${list(b, (x) => `0x${hex2(x)}`)}}`,
  },
  java: {
    label: 'Java',
    detail: 'byte[] data = { (byte) 0x89, … };',
    format: (b) => `byte[] data = { ${list(b, (x) => (x > 0x7f ? `(byte) 0x${hex2(x)}` : `0x${hex2(x)}`))} };`,
  },
  python: {
    label: 'Python',
    detail: "data = b'\\x89\\x50…'",
    format: (b) => `data = b'${Array.from(b, (x) => `\\x${hex2(x)}`).join('')}'`,
  },
  json: { label: 'JSON', detail: '[137, 80, 78, 71]', format: (b) => JSON.stringify(Array.from(b)) },
  base64: { label: 'Base64', detail: 'iVBORw==', format: base64 },
} satisfies Record<string, { label: string; detail: string; format: (bytes: Uint8Array) => string }>;

export type CopyFormat = keyof typeof COPY_FORMATS;

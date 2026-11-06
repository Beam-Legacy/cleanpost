/**
 * PNG text chunks (tEXt, Latin-1): how a synthetic card made by Cleanpost's simulators carries its
 * own answer for the stand-in card reader (DEC-31). Pure; works in the browser and in Node.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let table: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const latin1 = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
const isPng = (bytes: Uint8Array) => bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);

/** The tEXt chunks of a PNG, by keyword (empty for anything that is not a PNG). */
export function pngText(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  if (!isPng(bytes)) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'tEXt') {
      const data = bytes.subarray(at + 8, at + 8 + len);
      const zero = data.indexOf(0);
      if (zero > 0) {
        const text = Array.from(data.subarray(zero + 1), (b) => String.fromCharCode(b)).join('');
        out.set(String.fromCharCode(...data.subarray(0, zero)), text);
      }
    }
    if (type === 'IEND') break;
    at += 12 + len;
  }
  return out;
}

/** The PNG with a tEXt chunk added after its header. Text outside Latin-1 must be escaped first. */
export function addPngText(png: Uint8Array, keyword: string, text: string): Uint8Array {
  if (!isPng(png)) throw new Error('not a PNG');
  const data = new Uint8Array([...latin1(keyword), 0, ...latin1(text)]);
  const type = latin1('tEXt');
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(type, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(new Uint8Array([...type, ...data])));
  // After IHDR (8-byte signature + 25-byte IHDR chunk).
  const head = 8 + 12 + new DataView(png.buffer, png.byteOffset).getUint32(8);
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, head), 0);
  out.set(chunk, head);
  out.set(png.subarray(head), head + chunk.length);
  return out;
}

/** JSON whose non-ASCII characters are escaped, so it fits a tEXt chunk. */
export const asciiJson = (v: unknown) =>
  JSON.stringify(v).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** The keyword under which Cleanpost's synthetic cards carry their own answer. */
export const SYNTHETIC_CARD_KEYWORD = 'cleanpost-synthetic-card';

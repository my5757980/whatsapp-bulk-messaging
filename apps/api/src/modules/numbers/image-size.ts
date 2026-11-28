// Feature 010 (US7, research R11): the type and pixel size of a PNG or JPEG from its bytes, so profile
// pictures are checked (square, at least 192 px) before anything goes to Meta. No image library is needed.

export interface ImageSize {
  type: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** JPEG start-of-frame markers that carry the size (not DHT C4, JPG C8 or DAC CC). */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** The image's type and size, or null when it is not a readable PNG or JPEG. */
export function imageSize(bytes: Buffer): ImageSize | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { type: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      // Fill bytes and markers without a length.
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        offset += 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (SOF.has(marker)) return { type: 'image/jpeg', height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      if (marker === 0xda || length < 2) return null;
      offset += 2 + length;
    }
  }
  return null;
}

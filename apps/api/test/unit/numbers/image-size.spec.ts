import { describe, expect, it } from 'vitest';
import { imageSize } from '../../../src/modules/numbers/image-size.js';
import { jpegHeader, pngHeader } from '../../support/images.js';

// Feature 010 (US7): profile pictures are measured from their bytes.
describe('imageSize', () => {
  it('reads PNG and JPEG sizes', () => {
    expect(imageSize(pngHeader(640, 640))).toEqual({ type: 'image/png', width: 640, height: 640 });
    expect(imageSize(jpegHeader(3000, 2000))).toEqual({ type: 'image/jpeg', width: 3000, height: 2000 });
  });

  it('refuses other files', () => {
    expect(imageSize(Buffer.from('GIF89a................'))).toBeNull();
    expect(imageSize(Buffer.from('not an image at all'))).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBeNull();
  });
});

// Converts src/MapwrightIcon.png into src/icon.ico
// Uses @napi-rs/canvas to resize, then encodes as ICO with embedded PNGs.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src  = join(__dirname, '../src/MapwrightIcon.png');
const dest = join(__dirname, '../src/icon.ico');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  const img = await loadImage(readFileSync(src));

  const pngBuffers = SIZES.map(size => {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    return canvas.toBuffer('image/png');
  });

  // ICO header: reserved(2) + type(2) + count(2)
  const count = SIZES.length;
  const headerSize = 6 + count * 16;
  let offset = headerSize;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);     // reserved
  header.writeUInt16LE(1, 2);     // type: icon
  header.writeUInt16LE(count, 4); // image count

  const entries = pngBuffers.map((buf, i) => {
    const size = SIZES[i];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);  // width (0 = 256)
    entry.writeUInt8(size === 256 ? 0 : size, 1);  // height
    entry.writeUInt8(0, 2);                         // color count
    entry.writeUInt8(0, 3);                         // reserved
    entry.writeUInt16LE(1, 4);                      // color planes
    entry.writeUInt16LE(32, 6);                     // bits per pixel
    entry.writeUInt32LE(buf.length, 8);             // image data size
    entry.writeUInt32LE(offset, 12);                // offset
    offset += buf.length;
    return entry;
  });

  const ico = Buffer.concat([header, ...entries, ...pngBuffers]);
  writeFileSync(dest, ico);
  console.log(`Written: ${dest} (${SIZES.join(', ')}px, ${(ico.length / 1024).toFixed(1)} KB)`);
}

main().catch(err => { console.error(err); process.exit(1); });

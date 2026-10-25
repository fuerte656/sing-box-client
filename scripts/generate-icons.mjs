// Generates the app and tray icons (no image dependencies needed):
//   public/icons/app.png      256px app icon (exe icon, window/taskbar icon)
//   public/favicon.ico        16/32/48px app icon
//   public/tray/*.png         32px tray status icons
// Run: node scripts/generate-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const APP_COLOR = [21, 101, 192];
const TRAY_ICONS = {
  running: [46, 157, 79],
  stopped: [128, 128, 128],
  busy: [224, 160, 32],
};

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** Fraction of a pixel covered by a shape, 4x4 supersampled for anti-aliasing. */
function coverage(x, y, inside) {
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits++;
    }
  }
  return hits / 16;
}

/**
 * Renders the "hub" mark (white ring + center dot) on a colored background shape.
 * Shape is a disc for tray icons and a rounded square for the app icon.
 */
function render(size, [r, g, b], shape) {
  const c = size / 2;
  const unit = size / 32; // geometry is designed on a 32px grid
  const dist = (x, y) => Math.hypot(x - c, y - c);
  const background =
    shape === 'disc'
      ? (x, y) => dist(x, y) <= 15 * unit
      : (x, y) => {
          // Rounded square with a 7/32 corner radius and 1/32 margin.
          const half = 15 * unit;
          const radius = 7 * unit;
          const dx = Math.max(Math.abs(x - c) - (half - radius), 0);
          const dy = Math.max(Math.abs(y - c) - (half - radius), 0);
          return Math.hypot(dx, dy) <= radius;
        };
  const mark = (x, y) => {
    const d = dist(x, y) / unit;
    return (d >= 7.5 && d <= 10.5) || d <= 3.5;
  };

  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const alpha = coverage(x, y, background);
      const white = coverage(x, y, mark);
      const i = y * stride + 1 + x * 4;
      raw[i] = Math.round(r + (255 - r) * white);
      raw[i + 1] = Math.round(g + (255 - g) * white);
      raw[i + 2] = Math.round(b + (255 - b) * white);
      raw[i + 3] = Math.round(255 * alpha);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO container with PNG-compressed entries (supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const publicDir = path.join(import.meta.dirname, '..', 'public');
const write = (relative, data) => {
  const target = path.join(publicDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  console.log(`public/${relative}`);
};

write('icons/app.png', render(256, APP_COLOR, 'square'));
write('favicon.ico', ico([16, 32, 48].map((size) => ({ size, png: render(size, APP_COLOR, 'square') }))));
for (const [name, color] of Object.entries(TRAY_ICONS)) {
  write(`tray/${name}.png`, render(32, color, 'disc'));
}

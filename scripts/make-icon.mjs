import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const outDir = path.resolve("build");
const iconsetDir = path.join(outDir, "icon.iconset");
const pngSizes = [16, 32, 64, 128, 256, 512, 1024];
const crcTable = makeCrcTable();
const icnsTypes = new Map([
  [16, "icp4"],
  [32, "icp5"],
  [64, "icp6"],
  [128, "ic07"],
  [256, "ic08"],
  [512, "ic09"],
  [1024, "ic10"]
]);

await mkdir(iconsetDir, { recursive: true });

const pngs = new Map();
for (const size of pngSizes) {
  const png = makePng(size);
  pngs.set(size, png);
  await writeFile(path.join(iconsetDir, `icon_${size}x${size}.png`), png);
  if (size <= 512) {
    await writeFile(path.join(iconsetDir, `icon_${size / 2}x${size / 2}@2x.png`), png);
  }
}

await writeFile(path.join(outDir, "icon.png"), pngs.get(1024));
await writeFile(path.join(outDir, "icon.icns"), makeIcns(pngs));

function makePng(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const inside = roundedRectContains(x + 0.5, y + 0.5, 0, 0, size, size, radius);

      if (!inside) {
        rgba[index + 3] = 0;
        continue;
      }

      const t = y / size;
      rgba[index] = Math.round(247 - 35 * t);
      rgba[index + 1] = Math.round(108 - 42 * t);
      rgba[index + 2] = Math.round(166 - 18 * t);
      rgba[index + 3] = 255;
    }
  }

  drawRounded(rgba, size, size * 0.16, size * 0.14, size * 0.68, size * 0.72, size * 0.06, [255, 238, 246, 255]);
  drawRounded(rgba, size, size * 0.21, size * 0.2, size * 0.58, size * 0.6, size * 0.035, [78, 32, 58, 255]);

  const panelX = size * 0.27;
  const panelW = size * 0.46;
  const panelH = size * 0.13;
  const gap = size * 0.05;
  const colors = [
    [255, 205, 228, 255],
    [255, 157, 202, 255],
    [196, 104, 198, 255]
  ];

  for (let i = 0; i < 3; i += 1) {
    drawRounded(rgba, size, panelX, size * 0.28 + i * (panelH + gap), panelW, panelH, size * 0.018, colors[i]);
  }

  drawRounded(rgba, size, size * 0.28, size * 0.73, size * 0.44, size * 0.055, size * 0.02, [255, 238, 246, 255]);
  return encodePng(size, size, rgba);
}

function roundedRectContains(x, y, rx, ry, rw, rh, radius) {
  const cx = Math.max(rx + radius, Math.min(x, rx + rw - radius));
  const cy = Math.max(ry + radius, Math.min(y, ry + rh - radius));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function drawRounded(rgba, size, x, y, width, height, radius, color) {
  const startX = Math.max(0, Math.floor(x));
  const endX = Math.min(size, Math.ceil(x + width));
  const startY = Math.max(0, Math.floor(y));
  const endY = Math.min(size, Math.ceil(y + height));

  for (let py = startY; py < endY; py += 1) {
    for (let px = startX; px < endX; px += 1) {
      if (!roundedRectContains(px + 0.5, py + 0.5, x, y, width, height, radius)) {
        continue;
      }
      const index = (py * size + px) * 4;
      rgba[index] = color[0];
      rgba[index + 1] = color[1];
      rgba[index + 2] = color[2];
      rgba[index + 3] = color[3];
    }
  }
}

function encodePng(width, height, rgba) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const lineStart = y * (width * 4 + 1);
    scanlines[lineStart] = 0;
    rgba.copy(scanlines, lineStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.concat([uint32(width), uint32(height), Buffer.from([8, 6, 0, 0, 0])])),
    pngChunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function makeIcns(pngs) {
  const chunks = [];
  for (const [size, png] of pngs) {
    const type = icnsTypes.get(size);
    if (!type) {
      continue;
    }
    chunks.push(Buffer.concat([Buffer.from(type), uint32(png.length + 8), png]));
  }

  const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return Buffer.concat([Buffer.from("icns"), uint32(totalLength), ...chunks]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const crcInput = Buffer.concat([typeBuffer, data]);
  return Buffer.concat([uint32(data.length), typeBuffer, data, uint32(crc32(crcInput))]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function makeCrcTable() {
  return new Uint32Array(256).map((_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
  });
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

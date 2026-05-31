import { copyFile, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceIcon = path.resolve("assets/app-icon.png");
const outDir = path.resolve("build");
const iconsetDir = path.join(outDir, "icon.iconset");
const iconTargets = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_64x64.png", 64],
  ["icon_64x64@2x.png", 128],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024]
];

await rm(iconsetDir, { recursive: true, force: true });
await mkdir(iconsetDir, { recursive: true });
await mkdir(outDir, { recursive: true });
await copyFile(sourceIcon, path.join(outDir, "icon.png"));

for (const [fileName, size] of iconTargets) {
  await execFileAsync("/usr/bin/sips", ["-z", String(size), String(size), sourceIcon, "--out", path.join(iconsetDir, fileName)]);
}

await rm(path.join(outDir, "icon.icns"), { force: true });
await execFileAsync("/usr/bin/iconutil", ["-c", "icns", iconsetDir, "-o", path.join(outDir, "icon.icns")]);

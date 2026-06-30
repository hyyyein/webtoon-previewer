import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } from "electron";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import type { AppCommand, ImageItem, ImportResult, SortMode } from "./types.js";

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".wbpb", ".psd", ".clip"]);
const browserExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".wbpb"]);
const maxPsdPixels = 40_000_000;
const maxHeavySourceBytes = 512 * 1024 * 1024;
const maxImportEntries = 500;
const conversionConcurrency = 3;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegSignature = Buffer.from([0xff, 0xd8, 0xff]);
const cspChunkSignature = Buffer.from("CSFCHUNK", "ascii");
const collator = new Intl.Collator("ko-KR", { numeric: true, sensitivity: "base" });

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 360,
    minHeight: 520,
    title: "Webtoon Previewer",
    backgroundColor: "#2f2f2f",
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist-electron/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow = window;

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    window.loadFile(path.join(app.getAppPath(), "dist/index.html"));
  }

  return window;
}

app.whenReady().then(() => {
  createWindow();
  createMenu();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("dialog:open-folder", async (event): Promise<ImportResult | null> => {
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  if (!targetWindow || targetWindow.isDestroyed()) {
    return null;
  }

  return chooseFolder(targetWindow);
});

ipcMain.handle(
  "files:import-paths",
  async (_event, paths: unknown, sortMode: unknown = "natural"): Promise<ImportResult> => {
    return importPaths(normalizeImportPaths(paths), normalizeSortMode(sortMode));
  }
);

ipcMain.handle("files:open-original", async (_event, filePath: unknown): Promise<void> => {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new Error("열 원본 파일 경로가 올바르지 않습니다.");
  }

  const targetPath = filePath.trim();
  await access(targetPath);
  const errorMessage = await shell.openPath(targetPath);
  if (errorMessage) {
    throw new Error(errorMessage);
  }
});

ipcMain.handle("window:fit-content-width", (event, width: number): void => {
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  if (!targetWindow || !Number.isFinite(width)) {
    return;
  }

  const contentBounds = targetWindow.getContentBounds();
  const nextWidth = Math.min(Math.max(Math.round(width), 360), 1800);
  targetWindow.setContentSize(nextWidth, contentBounds.height);
});

ipcMain.handle("export:choose-png-path", async (event, defaultName: unknown): Promise<string | null> => {
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  if (!targetWindow || targetWindow.isDestroyed()) {
    return null;
  }

  const result = await dialog.showSaveDialog(targetWindow, {
    title: "이어붙인 PNG 저장",
    buttonLabel: "저장",
    defaultPath: normalizeDefaultPngName(defaultName),
    filters: [
      { name: "PNG 이미지", extensions: ["png"] },
      { name: "모든 파일", extensions: ["*"] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  return normalizePngExportPath(result.filePath);
});

ipcMain.handle("export:write-png-file", async (_event, filePath: unknown, data: unknown): Promise<void> => {
  const targetPath = normalizePngExportPath(filePath);
  const pngData = normalizePngExportData(data);

  if (!pngData.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error("PNG 데이터가 아닙니다.");
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, pngData);
});

function createMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Webtoon Previewer",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "파일",
      submenu: [
        {
          label: "파일/폴더 열기",
          accelerator: "CommandOrControl+O",
          click: async () => {
            const targetWindow = getUsableWindow() ?? createWindow();
            const result = await chooseFolder(targetWindow);
            if (result && !targetWindow.isDestroyed()) {
              targetWindow.webContents.send("files:loaded", result);
            }
          }
        },
        { type: "separator" },
        {
          label: "파일 순서 편집",
          accelerator: "CommandOrControl+Shift+O",
          click: () => sendAppCommand("open-order-editor")
        },
        {
          label: "기본 정렬로 되돌리기",
          click: () => sendAppCommand("reset-natural")
        },
        {
          label: "PNG로 내보내기",
          accelerator: "CommandOrControl+Shift+E",
          click: () => sendAppCommand("export-png")
        }
      ]
    },
    {
      label: "보기",
      submenu: [
        {
          label: "뷰어로 보기",
          accelerator: "CommandOrControl+Enter",
          click: () => sendAppCommand("enter-reader")
        },
        { type: "separator" },
        ...(!app.isPackaged ? [
          { role: "reload" as const },
          { role: "toggleDevTools" as const },
          { type: "separator" as const }
        ] : []),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function normalizeDefaultPngName(value: unknown) {
  const fallback = "webtoon-preview.png";
  if (typeof value !== "string") {
    return fallback;
  }

  const cleaned = value
    .trim()
    .replace(/[\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ");
  if (!cleaned) {
    return fallback;
  }

  return cleaned.toLowerCase().endsWith(".png") ? cleaned : `${cleaned}.png`;
}

function normalizePngExportPath(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("저장할 PNG 경로가 올바르지 않습니다.");
  }

  const trimmed = value.trim();
  return path.extname(trimmed).toLowerCase() === ".png" ? trimmed : `${trimmed}.png`;
}

function normalizePngExportData(value: unknown) {
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }

  throw new Error("저장할 PNG 데이터가 올바르지 않습니다.");
}

function sendAppCommand(command: AppCommand) {
  const targetWindow = getUsableWindow();
  if (targetWindow) {
    targetWindow.webContents.send("app-command", command);
  }
}

function getUsableWindow() {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow && !focusedWindow.isDestroyed()) {
    return focusedWindow;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  return null;
}

async function chooseFolder(parentWindow: BrowserWindow): Promise<ImportResult | null> {
  const result = await dialog.showOpenDialog(parentWindow, {
    title: "웹툰 이미지 파일 또는 폴더 열기",
    properties: ["openFile", "openDirectory", "multiSelections"],
    filters: [
      { name: "지원 이미지", extensions: ["jpg", "jpeg", "png", "webp", "wbpb", "psd", "clip"] },
      { name: "모든 파일", extensions: ["*"] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return importPaths(result.filePaths, "natural");
}

async function importPaths(inputPaths: string[], sortMode: SortMode): Promise<ImportResult> {
  const normalizedInputPaths = normalizeImportPaths(inputPaths);
  const normalizedSortMode = normalizeSortMode(sortMode);
  const discovered: string[] = [];

  for (const inputPath of normalizedInputPaths) {
    try {
      const entryStat = await stat(inputPath);
      if (entryStat.isDirectory()) {
        const names = await readdir(inputPath);
        for (const name of names) {
          discovered.push(path.join(inputPath, name));
        }
      } else {
        discovered.push(inputPath);
      }
    } catch {
      discovered.push(inputPath);
    }
  }

  const candidates = discovered.filter((filePath) => imageExtensions.has(path.extname(filePath).toLowerCase()));
  const ordered =
    normalizedSortMode === "natural"
      ? [...candidates].sort((a, b) => collator.compare(path.basename(a), path.basename(b)))
      : candidates;

  const items = await mapWithConcurrency(ordered, conversionConcurrency, createImageItem);

  return {
    sourceLabel: makeSourceLabel(normalizedInputPaths),
    sourcePaths: normalizedInputPaths,
    sortMode: normalizedSortMode,
    items
  };
}

async function createImageItem(filePath: string, index: number): Promise<ImageItem> {
  const extension = path.extname(filePath).toLowerCase();
  const base = {
    id: `${index}-${filePath}`,
    index,
    name: path.basename(filePath),
    path: filePath,
    extension
  };

  if (browserExtensions.has(extension)) {
    const size = await readImageSize(filePath);
    return {
      ...base,
      status: "ready",
      kind: extension === ".png" ? "png" : extension === ".webp" || extension === ".wbpb" ? "webp" : "jpg",
      src: pathToFileURL(filePath).toString(),
      width: size?.width,
      height: size?.height
    };
  }

  if (extension === ".psd") {
    return convertPsd(filePath, base);
  }

  if (extension === ".clip") {
    return convertClip(filePath, base);
  }

  return {
    ...base,
    status: "unsupported",
    kind: "clip",
    message: "지원하지 않는 이미지 형식입니다."
  };
}

async function readImageSize(filePath: string) {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) {
    return undefined;
  }
  return image.getSize();
}

async function convertPsd(
  filePath: string,
  base: Pick<ImageItem, "id" | "index" | "name" | "path" | "extension">
): Promise<ImageItem> {
  const outputDir = path.join(app.getPath("userData"), "preview-cache");
  const outputPath = path.join(outputDir, `${hashFilePath(filePath)}.psd.png`);
  await mkdir(outputDir, { recursive: true });

  try {
    await renderPsdCompositeToPng(filePath, outputPath);
    const size = await readImageSize(outputPath);

    return {
      ...base,
      status: "ready",
      kind: "psd",
      src: pathToFileURL(outputPath).toString(),
      width: size?.width,
      height: size?.height,
      message: "PSD 합성 이미지를 앱 안에서 직접 추출했습니다."
    };
  } catch (directError) {
    const converter = await findConverter();
    if (!converter) {
      return {
        ...base,
        status: "error",
        kind: "psd",
        message: `PSD 합성 미리보기를 읽지 못했습니다. ${getErrorMessage(directError)} ImageMagick도 설치되어 있지 않아 이 파일은 건너뜁니다.`
      };
    }

    try {
      await runConverter(converter, filePath, outputPath);
      const size = await readImageSize(outputPath);

      return {
        ...base,
        status: "ready",
        kind: "psd",
        src: pathToFileURL(outputPath).toString(),
        width: size?.width,
        height: size?.height,
        message: "ImageMagick으로 PSD 미리보기를 변환했습니다."
      };
    } catch (converterError) {
      return {
        ...base,
        status: "error",
        kind: "psd",
        message: `PSD 파일을 미리보기 이미지로 변환하지 못했습니다. ${getErrorMessage(converterError)}`
      };
    }
  }
}

async function convertClip(
  filePath: string,
  base: Pick<ImageItem, "id" | "index" | "name" | "path" | "extension">
): Promise<ImageItem> {
  const outputDir = path.join(app.getPath("userData"), "preview-cache");
  await mkdir(outputDir, { recursive: true });

  try {
    const preview = await extractClipPreview(filePath, outputDir);
    const outputPath = path.join(outputDir, `${hashFilePath(filePath)}.clip-preview.${preview.extension}`);
    await writeFile(outputPath, preview.data);
    const size = await readImageSize(outputPath);

    return {
      ...base,
      status: "ready",
      kind: "clip",
      src: pathToFileURL(outputPath).toString(),
      width: size?.width,
      height: size?.height,
      message: preview.source === "canvas-preview"
        ? "CLIP 내부 CanvasPreview 미리보기를 추출했습니다."
        : "CLIP 파일 안에 들어있는 PNG/JPEG 미리보기를 추출했습니다."
    };
  } catch (error) {
    return {
      ...base,
      status: "unsupported",
      kind: "clip",
      message: `CLIP 파일 안에서 CanvasPreview 또는 PNG/JPEG 미리보기를 찾지 못했습니다. Clip Studio의 버전 호환 정보 저장을 켜고 다시 저장하거나 PNG/JPG/PSD로 내보낸 파일을 함께 열어주세요. ${getErrorMessage(error)}`
    };
  }
}

async function renderPsdCompositeToPng(inputPath: string, outputPath: string) {
  await assertFileIsNotTooLarge(inputPath, "PSD");
  const buffer = await readFile(inputPath);
  const png = decodePsdComposite(buffer);
  await writeFile(outputPath, png);
}

function decodePsdComposite(buffer: Buffer) {
  let offset = 0;
  const signature = readAscii(buffer, offset, 4, "PSD signature");
  offset += 4;
  if (signature != "8BPS") {
    throw new Error("PSD 서명이 아닙니다.");
  }

  const version = readUInt16(buffer, offset, "PSD version");
  offset += 2;
  if (version != 1) {
    throw new Error("PSB 또는 지원하지 않는 PSD 버전입니다.");
  }

  offset += 6;
  const channels = readUInt16(buffer, offset, "channel count");
  offset += 2;
  if (channels < 1 || channels > 16) {
    throw new Error("PSD 채널 수가 너무 많거나 올바르지 않습니다.");
  }
  const height = readUInt32(buffer, offset, "height");
  offset += 4;
  const width = readUInt32(buffer, offset, "width");
  offset += 4;
  const depth = readUInt16(buffer, offset, "depth");
  offset += 2;
  const colorMode = readUInt16(buffer, offset, "color mode");
  offset += 2;

  if (depth != 8) {
    throw new Error(`${depth}bit PSD는 아직 지원하지 않습니다.`);
  }
  if (![1, 3, 4].includes(colorMode)) {
    throw new Error("RGB/Grayscale/CMYK PSD만 지원합니다.");
  }
  if (width <= 0 || height <= 0 || width * height > maxPsdPixels) {
    throw new Error("이미지 크기가 너무 큽니다.");
  }

  offset = skipLengthBlock(buffer, offset, "color mode data");
  offset = skipLengthBlock(buffer, offset, "image resources");
  offset = skipLengthBlock(buffer, offset, "layer and mask data");

  const compression = readUInt16(buffer, offset, "compression");
  offset += 2;

  const planes = compression == 0
    ? readRawPlanes(buffer, offset, channels, width, height)
    : compression == 1
      ? readRlePlanes(buffer, offset, channels, width, height)
      : (() => { throw new Error("ZIP 압축 PSD 합성 이미지는 아직 지원하지 않습니다."); })();

  return encodePng(width, height, composePsdRgba(planes, channels, colorMode, width * height));
}

function readRawPlanes(buffer: Buffer, offset: number, channels: number, width: number, height: number) {
  const pixelCount = width * height;
  const keptChannels = Math.min(channels, 4);
  const planes = Array.from({ length: keptChannels }, () => new Uint8Array(pixelCount));

  for (let channel = 0; channel < channels; channel += 1) {
    ensureLength(buffer, offset, pixelCount, "raw channel data");
    if (channel < keptChannels) {
      planes[channel].set(buffer.subarray(offset, offset + pixelCount));
    }
    offset += pixelCount;
  }

  return planes;
}

function readRlePlanes(buffer: Buffer, offset: number, channels: number, width: number, height: number) {
  const rowCount = channels * height;
  const rowLengths: number[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    rowLengths.push(readUInt16(buffer, offset, "RLE row length"));
    offset += 2;
  }

  const pixelCount = width * height;
  const keptChannels = Math.min(channels, 4);
  const planes = Array.from({ length: keptChannels }, () => new Uint8Array(pixelCount));

  for (let channel = 0; channel < channels; channel += 1) {
    for (let row = 0; row < height; row += 1) {
      const rowLength = rowLengths[channel * height + row];
      ensureLength(buffer, offset, rowLength, "RLE row data");
      if (channel < keptChannels) {
        decodePackBitsRow(buffer, offset, rowLength, planes[channel], row * width, width);
      }
      offset += rowLength;
    }
  }

  return planes;
}

function decodePackBitsRow(buffer: Buffer, offset: number, length: number, output: Uint8Array, outputOffset: number, width: number) {
  const end = offset + length;
  let written = 0;

  while (offset < end && written < width) {
    const header = buffer.readInt8(offset);
    offset += 1;

    if (header >= 0) {
      const count = header + 1;
      ensureLength(buffer, offset, count, "RLE literal");
      const copyCount = Math.min(count, width - written);
      output.set(buffer.subarray(offset, offset + copyCount), outputOffset + written);
      offset += count;
      written += copyCount;
    } else if (header >= -127) {
      ensureLength(buffer, offset, 1, "RLE repeat");
      const count = 1 - header;
      const value = buffer[offset];
      offset += 1;
      output.fill(value, outputOffset + written, outputOffset + written + Math.min(count, width - written));
      written += count;
    }
  }

  if (written < width) {
    throw new Error("PSD RLE 데이터를 끝까지 해석하지 못했습니다.");
  }
}

function composePsdRgba(planes: Uint8Array[], channels: number, colorMode: number, pixelCount: number) {
  const rgba = Buffer.alloc(pixelCount * 4);
  const first = planes[0];
  const second = planes[1];
  const third = planes[2];
  const fourth = planes[3];

  for (let index = 0; index < pixelCount; index += 1) {
    const out = index * 4;
    if (colorMode == 1) {
      const value = first?.[index] ?? 0;
      rgba[out] = value;
      rgba[out + 1] = value;
      rgba[out + 2] = value;
      rgba[out + 3] = channels >= 2 ? second?.[index] ?? 255 : 255;
    } else if (colorMode == 4) {
      const c = first?.[index] ?? 0;
      const m = second?.[index] ?? 0;
      const y = third?.[index] ?? 0;
      const k = fourth?.[index] ?? 0;
      rgba[out] = 255 - Math.min(255, c + k);
      rgba[out + 1] = 255 - Math.min(255, m + k);
      rgba[out + 2] = 255 - Math.min(255, y + k);
      rgba[out + 3] = 255;
    } else {
      rgba[out] = first?.[index] ?? 0;
      rgba[out + 1] = second?.[index] ?? 0;
      rgba[out + 2] = third?.[index] ?? 0;
      rgba[out + 3] = channels >= 4 ? fourth?.[index] ?? 255 : 255;
    }
  }

  return rgba;
}

async function extractClipPreview(filePath: string, outputDir: string) {
  await assertFileIsNotTooLarge(filePath, "CLIP");
  const buffer = await readFile(filePath);

  let canvasPreviewError: unknown = null;
  try {
    const canvasPreview = await extractClipCanvasPreview(buffer, filePath, outputDir);
    if (canvasPreview) {
      return { ...canvasPreview, source: "canvas-preview" as const };
    }
  } catch (error) {
    canvasPreviewError = error;
  }

  const png = findLargestEmbeddedPng(buffer);
  if (png) {
    return { extension: "png" as const, data: png, source: "embedded" as const };
  }

  const jpeg = findLargestEmbeddedJpeg(buffer);
  if (jpeg) {
    return { extension: "jpg" as const, data: jpeg, source: "embedded" as const };
  }

  throw new Error(canvasPreviewError ? `내장 미리보기 없음 (${getErrorMessage(canvasPreviewError)})` : "내장 미리보기 없음");
}

async function extractClipCanvasPreview(buffer: Buffer, filePath: string, outputDir: string) {
  const sqliteChunk = findClipSqliteChunk(buffer);
  if (!sqliteChunk) {
    return null;
  }

  const cacheKey = hashFilePath(filePath);
  const sqlitePath = path.join(outputDir, `${cacheKey}.clip.sqlite`);
  const previewPath = path.join(outputDir, `${cacheKey}.clip-canvas-preview`);

  await writeFile(sqlitePath, sqliteChunk);
  try {
    await exportCanvasPreviewFromSqlite(sqlitePath, previewPath);
    const data = await readFile(previewPath);
    const extension = detectPreviewExtension(data);
    if (!extension) {
      throw new Error("CLIP CanvasPreview 이미지 형식을 확인하지 못했습니다.");
    }
    return { extension, data };
  } finally {
    await removeIfExists(sqlitePath);
    await removeIfExists(previewPath);
  }
}

function findClipSqliteChunk(buffer: Buffer) {
  if (buffer.length < 40 || !buffer.subarray(0, cspChunkSignature.length).equals(cspChunkSignature)) {
    return null;
  }

  let offset = 24;
  while (offset + 16 <= buffer.length) {
    const marker = buffer.toString("ascii", offset, offset + 4);
    if (marker !== "CHNK") {
      return null;
    }

    const chunkName = buffer.toString("ascii", offset + 4, offset + 8);
    const chunkSize = buffer.readUInt32BE(offset + 12);
    const dataStart = offset + 16;
    const dataEnd = dataStart + chunkSize;
    if (chunkSize < 0 || dataEnd > buffer.length) {
      return null;
    }

    if (chunkName === "SQLi") {
      return buffer.subarray(dataStart, dataEnd);
    }

    offset = dataEnd;
  }

  return null;
}

async function exportCanvasPreviewFromSqlite(sqlitePath: string, outputPath: string) {
  const sqlite = await findExecutable("sqlite3");
  if (!sqlite) {
    throw new Error("macOS sqlite3 실행 파일을 찾지 못했습니다.");
  }

  const sql = `SELECT writefile(${quoteSqlString(outputPath)}, ImageData) FROM CanvasPreview WHERE ImageData IS NOT NULL LIMIT 1;`;
  await runProcess(sqlite, [sqlitePath, sql], 15000);
}

function detectPreviewExtension(data: Buffer): "png" | "jpg" | null {
  if (data.subarray(0, pngSignature.length).equals(pngSignature)) {
    return "png";
  }
  if (data.subarray(0, jpegSignature.length).equals(jpegSignature)) {
    return "jpg";
  }
  return null;
}

function quoteSqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function removeIfExists(filePath: string) {
  try {
    await unlink(filePath);
  } catch {
    // Temporary files are best-effort cleanup only.
  }
}

function findLargestEmbeddedPng(buffer: Buffer) {
  let searchFrom = 0;
  let best: Buffer | null = null;

  while (searchFrom < buffer.length) {
    const start = buffer.indexOf(pngSignature, searchFrom);
    if (start == -1) {
      break;
    }
    const end = findPngEnd(buffer, start);
    if (end > start) {
      const candidate = buffer.subarray(start, end);
      if (!best || candidate.length > best.length) {
        best = candidate;
      }
      searchFrom = end;
    } else {
      searchFrom = start + pngSignature.length;
    }
  }

  return best;
}

function findPngEnd(buffer: Buffer, start: number) {
  let offset = start + pngSignature.length;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = readAscii(buffer, offset + 4, 4, "PNG chunk type");
    const next = offset + 8 + length + 4;
    if (next > buffer.length) {
      return -1;
    }
    if (type == "IEND") {
      return next;
    }
    offset = next;
  }
  return -1;
}

function findLargestEmbeddedJpeg(buffer: Buffer) {
  let searchFrom = 0;
  let best: Buffer | null = null;

  while (searchFrom < buffer.length) {
    const start = buffer.indexOf(jpegSignature, searchFrom);
    if (start == -1) {
      break;
    }
    const end = findJpegEnd(buffer, start + 2);
    if (end > start) {
      const candidate = buffer.subarray(start, end);
      if (!best || candidate.length > best.length) {
        best = candidate;
      }
      searchFrom = end;
    } else {
      searchFrom = start + 3;
    }
  }

  return best;
}

function findJpegEnd(buffer: Buffer, offset: number) {
  while (offset + 1 < buffer.length) {
    if (buffer[offset] == 0xff && buffer[offset + 1] == 0xd9) {
      return offset + 2;
    }
    offset += 1;
  }
  return -1;
}

function encodePng(width: number, height: number, rgba: Buffer) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const lineStart = y * (width * 4 + 1);
    scanlines[lineStart] = 0;
    rgba.copy(scanlines, lineStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.concat([uint32(width), uint32(height), Buffer.from([8, 6, 0, 0, 0])])),
    pngChunk("IDAT", zlib.deflateSync(scanlines, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type: string, data: Buffer) {
  const typeBuffer = Buffer.from(type);
  const crcInput = Buffer.concat([typeBuffer, data]);
  return Buffer.concat([uint32(data.length), typeBuffer, data, uint32(crc32(crcInput))]);
}

function uint32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function skipLengthBlock(buffer: Buffer, offset: number, label: string) {
  const length = readUInt32(buffer, offset, `${label} length`);
  offset += 4;
  ensureLength(buffer, offset, length, label);
  return offset + length;
}

function readAscii(buffer: Buffer, offset: number, length: number, label: string) {
  ensureLength(buffer, offset, length, label);
  return buffer.toString("ascii", offset, offset + length);
}

function readUInt16(buffer: Buffer, offset: number, label: string) {
  ensureLength(buffer, offset, 2, label);
  return buffer.readUInt16BE(offset);
}

function readUInt32(buffer: Buffer, offset: number, label: string) {
  ensureLength(buffer, offset, 4, label);
  return buffer.readUInt32BE(offset);
}

function ensureLength(buffer: Buffer, offset: number, length: number, label: string) {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`${label} 데이터가 부족합니다.`);
  }
}

function hashFilePath(filePath: string) {
  return createHash("sha1").update(filePath).digest("hex");
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function findConverter() {
  const candidates = [
    { command: "magick", args: (input: string, output: string) => [input + "[0]", "-background", "none", "-flatten", output] },
    { command: "convert", args: (input: string, output: string) => [input + "[0]", "-background", "none", "-flatten", output] }
  ];

  for (const candidate of candidates) {
    const executable = await findExecutable(candidate.command);
    if (executable) {
      return { ...candidate, executable };
    }
  }

  return null;
}

async function findExecutable(command: string) {
  const pathCandidates = [
    ...(process.env.PATH?.split(path.delimiter) ?? []),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ];
  for (const directory of pathCandidates) {
    try {
      const executable = path.join(directory, command);
      await access(executable);
      return executable;
    } catch {
      continue;
    }
  }
  return null;
}

function runConverter(
  converter: { executable: string; args: (input: string, output: string) => string[] },
  input: string,
  output: string
) {
  return runProcess(converter.executable, converter.args(input, output), 30000);
}

function runProcess(command: string, args: string[], timeout: number) {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(command, args, {
      timeout,
      cwd: os.homedir(),
      env: {
        ...process.env,
        PATH: buildToolPath()
      }
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${path.basename(command)} exited with ${code}`));
      }
    });
    child.on("error", reject);
  });
}

async function assertFileIsNotTooLarge(filePath: string, label: string) {
  const sourceStat = await stat(filePath);
  if (sourceStat.size > maxHeavySourceBytes) {
    throw new Error(`${label} 파일이 너무 큽니다. PNG/JPG로 내보낸 파일을 열어주세요.`);
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function normalizeImportPaths(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((filePath): filePath is string => typeof filePath === "string" && filePath.length > 0)
    .slice(0, maxImportEntries);
}

function normalizeSortMode(value: unknown): SortMode {
  return value === "manual" ? "manual" : "natural";
}

function buildToolPath() {
  const pathEntries = process.env.PATH?.split(path.delimiter) ?? [];
  return [...pathEntries, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter);
}

function makeSourceLabel(paths: string[]) {
  if (paths.length === 0) {
    return "선택 없음";
  }
  if (paths.length === 1) {
    return path.basename(paths[0]) || paths[0];
  }
  return `${paths.length}개 항목`;
}

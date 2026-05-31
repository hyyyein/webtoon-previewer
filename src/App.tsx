import { useEffect, useMemo, useRef, useState } from "react";
import type { AppCommand } from "./global";
import type { ImageItem, ImportResult, SortMode } from "./types";

type BackgroundKey = "white" | "black";
type WidthMode = "fixed" | "fitWindow" | "fitImage";
type ViewMode = "editor" | "reader";
type ExportableImageItem = ImageItem & { src: string; width: number; height: number; status: "ready" };

interface ExportSegment {
  item: ExportableImageItem;
  sourceY: number;
  sourceHeight: number;
  targetY: number;
  targetHeight: number;
}

interface ExportPart {
  height: number;
  segments: ExportSegment[];
}

const fixedWidths = [360, 430, 500, 690, 800, 1000, 1200];
const backgroundValues: Record<BackgroundKey, string> = {
  white: "#ffffff",
  black: "#050505"
};
const settingsKey = "webtoon-previewer-settings";
const recentKey = "webtoon-previewer-recent-source";
const manualOrderPrefix = "webtoon-previewer-manual-order:";
const maxExportCanvasPixels = 48_000_000;
const maxExportPartHeight = 30_000;

interface StoredSettings {
  background?: BackgroundKey;
  fixedWidth?: number;
  fitImageToWindow?: boolean;
  panelOpen?: boolean;
  sortMode?: SortMode;
  widthMode?: WidthMode;
}

const storedSettings = readStoredSettings();

export default function App() {
  const [items, setItems] = useState<ImageItem[]>([]);
  const [sourceLabel, setSourceLabel] = useState("선택 없음");
  const [sourcePaths, setSourcePaths] = useState<string[]>([]);
  const [lastSourcePaths, setLastSourcePaths] = useState<string[]>(readRecentSource());
  const [sortMode, setSortMode] = useState<SortMode>(storedSettings.sortMode ?? "natural");
  const [widthMode, setWidthMode] = useState<WidthMode>(storedSettings.widthMode ?? "fixed");
  const [fixedWidth, setFixedWidth] = useState(storedSettings.fixedWidth ?? 500);
  const [background, setBackground] = useState<BackgroundKey>(storedSettings.background ?? "white");
  const [fitImageToWindow, setFitImageToWindow] = useState(storedSettings.fitImageToWindow ?? true);
  const [panelOpen, setPanelOpen] = useState(storedSettings.panelOpen ?? true);
  const [viewMode, setViewMode] = useState<ViewMode>("editor");
  const [isOrderEditorOpen, setIsOrderEditorOpen] = useState(false);
  const [draftOrder, setDraftOrder] = useState<ImageItem[]>([]);
  const [draftSourceKey, setDraftSourceKey] = useState<string | null>(null);
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [notice, setNotice] = useState("파일을 열어주세요.");
  const dragDepth = useRef(0);
  const draggedItemIdRef = useRef<string | null>(null);
  const viewerRef = useRef<HTMLElement | null>(null);

  const readyCount = items.filter((item) => item.status === "ready").length;
  const errorCount = items.length - readyCount;
  const widestImage = useMemo(() => {
    const maxWidth = Math.max(...items.map((item) => item.width ?? 0));
    return Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : fixedWidth;
  }, [fixedWidth, items]);

  const displayWidth = widthMode === "fitImage" ? widestImage : fixedWidth;
  const editorPreviewStyle =
    widthMode === "fitWindow"
      ? { width: "100%" }
      : { width: `${displayWidth}px`, maxWidth: fitImageToWindow ? "100%" : "none" };
  const readerPreviewStyle =
    widthMode === "fitWindow"
      ? { width: "100%", maxWidth: "none" }
      : { width: `${displayWidth}px`, maxWidth: "none" };

  useEffect(() => {
    const unsubscribeImport = window.webtoonPreviewer.onImportResult((result) => applyImportResult(result));
    const unsubscribeCommand = window.webtoonPreviewer.onAppCommand(handleAppCommand);
    return () => {
      unsubscribeImport();
      unsubscribeCommand();
    };
  }, [items, sourcePaths, displayWidth, widthMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isOrderEditorOpen) {
          closeOrderEditor();
        } else if (viewMode === "reader") {
          exitReaderMode();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOrderEditorOpen, viewMode]);

  useEffect(() => {
    const settings: StoredSettings = {
      background,
      fixedWidth,
      fitImageToWindow,
      panelOpen,
      sortMode,
      widthMode
    };
    localStorage.setItem(settingsKey, JSON.stringify(settings));
  }, [background, fixedWidth, fitImageToWindow, panelOpen, sortMode, widthMode]);

  useEffect(() => {
    if (!fitImageToWindow || widthMode === "fitWindow" || items.length === 0 || viewMode === "reader") {
      return;
    }
    window.webtoonPreviewer.fitWindowToWidth(displayWidth).catch(() => undefined);
  }, [displayWidth, fitImageToWindow, items.length, widthMode, viewMode]);

  async function openFolder() {
    setNotice("Finder 선택창에서 이미지 파일이나 폴더를 선택하세요.");
    setIsBusy(true);
    await waitForPaint();

    try {
      const result = await window.webtoonPreviewer.openFolder();
      if (result) {
        setNotice("이미지를 불러오는 중입니다.");
        applyImportResult(result);
      } else {
        setNotice("선택이 취소되었습니다.");
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function importDroppedFiles(files: FileList) {
    const paths = Array.from(files)
      .map((file) => window.webtoonPreviewer.getPathForFile(file))
      .filter(Boolean);

    if (paths.length === 0) {
      setNotice("가져올 수 있는 파일 경로가 없습니다.");
      return;
    }

    setIsBusy(true);
    setNotice("이미지를 불러오는 중입니다.");
    try {
      const result = await window.webtoonPreviewer.importPaths(paths, "natural");
      applyImportResult(result);
    } finally {
      setIsBusy(false);
    }
  }

  function applyImportResult(result: ImportResult, options: { restoreManual?: boolean } = {}) {
    closeOrderEditor();
    dragDepth.current = 0;
    setIsDragging(false);

    const restoreManual = options.restoreManual ?? true;
    const restored = restoreManual ? restoreManualOrder(result.items, result.sourcePaths) : null;
    const nextItems = restored?.items ?? result.items;
    const nextSortMode = restored ? "manual" : result.sortMode;

    setItems(nextItems);
    setSourceLabel(result.sourceLabel);
    setSourcePaths(result.sourcePaths);
    setSortMode(nextSortMode);
    setLastSourcePaths(result.sourcePaths);
    localStorage.setItem(recentKey, JSON.stringify(result.sourcePaths));
    setNotice(
      result.items.length > 0
        ? `${result.items.length}개 파일을 불러왔습니다.`
        : "지원하는 이미지 파일을 찾지 못했습니다."
    );
  }

  async function reopenLastSource() {
    if (lastSourcePaths.length === 0) {
      setNotice("최근 항목이 없습니다.");
      return;
    }
    setIsBusy(true);
    setNotice("최근 항목을 불러오는 중입니다.");
    try {
      const result = await window.webtoonPreviewer.importPaths(lastSourcePaths, "natural");
      applyImportResult(result);
    } finally {
      setIsBusy(false);
    }
  }

  function openOrderEditor() {
    if (items.length === 0) {
      setNotice("순서를 바꿀 이미지가 없습니다.");
      return;
    }
    setDraftOrder(items);
    setDraftSourceKey(manualOrderStorageKey(sourcePaths));
    draggedItemIdRef.current = null;
    setDraggedItemId(null);
    setIsOrderEditorOpen(true);
  }

  function closeOrderEditor() {
    setIsOrderEditorOpen(false);
    setDraftSourceKey(null);
    draggedItemIdRef.current = null;
    setDraggedItemId(null);
  }

  function startDraftDrag(itemId: string) {
    draggedItemIdRef.current = itemId;
    setDraggedItemId(itemId);
  }

  function finishDraftDrag() {
    draggedItemIdRef.current = null;
    setDraggedItemId(null);
  }

  function moveDraftItem(targetId: string, position: DropPosition) {
    const itemId = draggedItemIdRef.current ?? draggedItemId;
    if (!itemId || itemId === targetId) {
      return;
    }

    moveDraftItemToTarget(itemId, targetId, position);
  }

  function moveDraftItemToTarget(itemId: string, targetId: string, position: DropPosition) {
    setDraftOrder((current) => {
      const fromIndex = current.findIndex((item) => item.id === itemId);
      const targetIndex = current.findIndex((item) => item.id === targetId);
      if (fromIndex === -1 || targetIndex === -1 || fromIndex === targetIndex) {
        return current;
      }

      let insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
      if (fromIndex < insertIndex) {
        insertIndex -= 1;
      }
      if (fromIndex === insertIndex) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(insertIndex, 0, moved);
      return next;
    });
  }

  function moveDraftItemByOffset(itemId: string, offset: number) {
    setDraftOrder((current) => {
      const fromIndex = current.findIndex((item) => item.id === itemId);
      if (fromIndex === -1) {
        return current;
      }

      const toIndex = Math.max(0, Math.min(current.length - 1, fromIndex + offset));
      if (fromIndex === toIndex) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  function applyManualOrder() {
    const currentSourceKey = manualOrderStorageKey(sourcePaths);
    if (draftSourceKey !== currentSourceKey) {
      setNotice("열려 있는 파일 묶음이 바뀌었습니다. 파일 순서 창을 다시 열어주세요.");
      closeOrderEditor();
      return;
    }

    const orderedPaths = draftOrder.map((item) => item.path);
    localStorage.setItem(currentSourceKey, JSON.stringify(orderedPaths));
    setItems(draftOrder.map((item, index) => ({ ...item, index })));
    setSortMode("manual");
    setNotice("사용자 파일 순서를 적용했습니다.");
    closeOrderEditor();
  }

  async function resetNaturalOrder() {
    if (sourcePaths.length === 0) {
      setNotice("기본 정렬로 되돌릴 파일이 없습니다.");
      return;
    }

    localStorage.removeItem(manualOrderStorageKey(sourcePaths));
    setIsBusy(true);
    setNotice("기본 숫자 정렬로 되돌리는 중입니다.");
    try {
      const result = await window.webtoonPreviewer.importPaths(sourcePaths, "natural");
      applyImportResult(result, { restoreManual: false });
      setSortMode("natural");
    } finally {
      setIsBusy(false);
      closeOrderEditor();
    }
  }

  function enterReaderMode() {
    if (items.length === 0) {
      setNotice("먼저 이미지를 열어주세요.");
      return;
    }

    setViewMode("reader");
    closeOrderEditor();
    requestAnimationFrame(() => {
      viewerRef.current?.scrollTo({ top: 0, left: 0 });
      if (widthMode !== "fitWindow") {
        window.webtoonPreviewer.fitWindowToWidth(displayWidth).catch(() => undefined);
      }
    });
  }

  function exitReaderMode() {
    setViewMode("editor");
  }

  async function openOriginalFile(item: ImageItem) {
    setNotice(`${sourceAppLabel(item)}으로 원본 파일을 여는 중입니다.`);
    try {
      await window.webtoonPreviewer.openOriginalFile(item.path);
      setNotice(`${item.name} 원본 파일을 열었습니다.`);
    } catch (error) {
      setNotice(`원본 파일 열기 실패: ${getErrorMessage(error)}`);
    }
  }

  async function exportMergedPng() {
    if (isBusy) {
      return;
    }

    const exportItems = items.filter(isExportableImageItem);
    if (exportItems.length === 0) {
      setNotice("PNG로 저장할 수 있는 이미지가 없습니다.");
      return;
    }

    const exportWidth = Math.max(1, Math.round(widthMode === "fitWindow" ? widestImage : displayWidth));
    const partHeightLimit = Math.max(1, Math.min(maxExportPartHeight, Math.floor(maxExportCanvasPixels / exportWidth)));
    if (partHeightLimit < 256) {
      setNotice("표시폭이 너무 넓어 PNG 저장이 어렵습니다. 표시폭을 줄인 뒤 다시 시도하세요.");
      return;
    }

    const parts = buildExportParts(exportItems, exportWidth, partHeightLimit);
    if (parts.length === 0) {
      setNotice("PNG로 저장할 이미지 높이를 계산하지 못했습니다.");
      return;
    }

    setIsBusy(true);
    setNotice("이어붙인 PNG 저장 위치를 고르세요.");
    await waitForPaint();

    try {
      const targetPath = await window.webtoonPreviewer.chooseExportPath(makeExportFileName(sourceLabel));
      if (!targetPath) {
        setNotice("PNG 저장이 취소되었습니다.");
        return;
      }

      for (const [index, part] of parts.entries()) {
        setNotice(`이어붙인 PNG 저장 중입니다. ${index + 1}/${parts.length}`);
        await waitForPaint();
        const data = await renderExportPart(part, exportWidth, backgroundValues[background]);
        await window.webtoonPreviewer.writePngFile(makePartPath(targetPath, index, parts.length), data);
      }

      const savedName = fileNameFromPath(targetPath);
      setNotice(
        parts.length === 1
          ? `PNG 저장 완료: ${savedName} (${exportWidth}px 폭)`
          : `PNG ${parts.length}개로 나누어 저장 완료: ${savedName} (${exportWidth}px 폭)`
      );
    } catch (error) {
      setNotice(`PNG 저장 실패: ${getErrorMessage(error)}`);
    } finally {
      setIsBusy(false);
    }
  }

  function handleAppCommand(command: AppCommand) {
    if (command === "enter-reader") {
      enterReaderMode();
    }
    if (command === "open-order-editor") {
      openOrderEditor();
    }
    if (command === "reset-natural") {
      void resetNaturalOrder();
    }
    if (command === "export-png") {
      void exportMergedPng();
    }
  }

  function onDragEnter(event: React.DragEvent) {
    if (!isFileDrag(event) || isOrderEditorOpen || isBusy) {
      return;
    }

    event.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }

  function onDragLeave(event: React.DragEvent) {
    if (!isFileDrag(event) || isOrderEditorOpen) {
      return;
    }

    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) {
      setIsDragging(false);
    }
  }

  function onDragOver(event: React.DragEvent) {
    if (!isFileDrag(event) || isOrderEditorOpen || isBusy) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  async function onDrop(event: React.DragEvent) {
    if (!isFileDrag(event) || isOrderEditorOpen || isBusy) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setIsDragging(false);
    await importDroppedFiles(event.dataTransfer.files);
  }

  return (
    <main
      className={`app-shell ${viewMode === "reader" ? "reader-mode" : "editor-mode"} ${isDragging ? "is-dragging" : ""}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {viewMode === "editor" ? (
        <section className="control-band xp-panel">
          <div className="toolbar">
            <button className="primary-button" type="button" onClick={openFolder} disabled={isBusy}>
              파일 열기
            </button>
            <button type="button" onClick={reopenLastSource} disabled={isBusy || lastSourcePaths.length === 0}>
              최근 열기
            </button>

            <label className="field">
              <span>표시폭</span>
              <select
                disabled={isBusy}
                value={fixedWidth}
                onChange={(event) => {
                  setFixedWidth(Number(event.target.value));
                  setWidthMode("fixed");
                }}
              >
                {fixedWidths.map((width) => (
                  <option key={width} value={width}>
                    {width}
                  </option>
                ))}
              </select>
            </label>

            <label className="checkbox-field">
              <input
                type="checkbox"
                disabled={isBusy}
                checked={widthMode === "fitWindow"}
                onChange={(event) => setWidthMode(event.target.checked ? "fitWindow" : "fixed")}
              />
              <span>창 너비 맞춤</span>
            </label>

            <label className="checkbox-field">
              <input
                type="checkbox"
                disabled={isBusy}
                checked={fitImageToWindow}
                onChange={(event) => setFitImageToWindow(event.target.checked)}
              />
              <span>이미지 폭에 창 맞춤</span>
            </label>

            <button className="reader-button" type="button" onClick={enterReaderMode} disabled={isBusy || items.length === 0}>
              뷰어로 보기
            </button>
          </div>

          <div className="toolbar secondary-toolbar">
            <div className="segmented" aria-label="배경색">
              <span>배경</span>
              <button className={background === "white" ? "selected" : ""} type="button" onClick={() => setBackground("white")} disabled={isBusy}>
                흰색
              </button>
              <button className={background === "black" ? "selected" : ""} type="button" onClick={() => setBackground("black")} disabled={isBusy}>
                검정
              </button>
            </div>

            <button type="button" onClick={openOrderEditor} disabled={isBusy || items.length === 0}>
              파일 순서
            </button>
            <button type="button" onClick={() => void resetNaturalOrder()} disabled={isBusy || items.length === 0}>
              기본 정렬
            </button>
            <button type="button" onClick={() => setWidthMode("fitImage")} disabled={isBusy || items.length === 0}>
              원본 폭
            </button>
            <button type="button" onClick={() => void exportMergedPng()} disabled={isBusy || readyCount === 0}>
              PNG 저장
            </button>
            <button type="button" onClick={() => setPanelOpen((value) => !value)} disabled={isBusy}>
              {panelOpen ? "패널 접기" : "패널 열기"}
            </button>
          </div>

          {panelOpen && (
            <div className="status-row">
              <span>이미지 개수: {items.length}</span>
              <span>표시 가능: {readyCount}</span>
              <span>표시폭: {widthMode === "fitWindow" ? "창 너비" : `${displayWidth}px`}</span>
              <span>정렬: {sortMode === "manual" ? "사용자 순서" : "기본 정렬"}</span>
              <span className="source-status" title={sourceLabel}>소스: {sourceLabel}</span>
              {errorCount > 0 && <span>표시 불가: {errorCount}</span>}
              {isBusy && <span>상태: 처리 중</span>}
            </div>
          )}
        </section>
      ) : (
        <section className="reader-bar">
          <span>Webtoon Previewer</span>
          <button type="button" onClick={exitReaderMode}>
            설정 펼치기
          </button>
        </section>
      )}

      <section
        ref={viewerRef}
        className="viewer-band"
        style={{ backgroundColor: backgroundValues[background] }}
      >
        {items.length === 0 ? (
          <div className="empty-state xp-panel">
            <strong>Webtoon Previewer</strong>
            <span>{notice}</span>
          </div>
        ) : (
          <div
            className={`image-column ${viewMode === "reader" && widthMode === "fitWindow" ? "reader-fill" : ""}`}
            style={viewMode === "reader" ? readerPreviewStyle : editorPreviewStyle}
          >
            {items.map((item) => (
              <PreviewItem key={item.id} item={item} onOpenOriginal={openOriginalFile} />
            ))}
          </div>
        )}
      </section>

      {isOrderEditorOpen && (
        <OrderEditor
          draftOrder={draftOrder}
          draggedItemId={draggedItemId}
          onApply={applyManualOrder}
          onClose={closeOrderEditor}
          onDragEnd={finishDraftDrag}
          onDragStart={startDraftDrag}
          onMoveByOffset={moveDraftItemByOffset}
          onMoveOver={moveDraftItem}
          onResetNatural={() => void resetNaturalOrder()}
        />
      )}

      {isBusy && <div className="busy-pill">{notice}</div>}
      {isDragging && <div className="drop-overlay">여기에 놓으면 바로 미리보기</div>}
    </main>
  );
}

function isExportableImageItem(item: ImageItem): item is ExportableImageItem {
  return item.status === "ready" && Boolean(item.src) && isPositiveNumber(item.width) && isPositiveNumber(item.height);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function buildExportParts(items: ExportableImageItem[], exportWidth: number, partHeightLimit: number): ExportPart[] {
  const parts: ExportPart[] = [];
  let current: ExportPart = { height: 0, segments: [] };

  const pushCurrent = () => {
    if (current.segments.length > 0) {
      parts.push(current);
    }
    current = { height: 0, segments: [] };
  };

  for (const item of items) {
    const scale = exportWidth / item.width;
    const fullTargetHeight = Math.max(1, Math.round(item.height * scale));
    let consumedTargetHeight = 0;

    while (consumedTargetHeight < fullTargetHeight) {
      if (current.height >= partHeightLimit) {
        pushCurrent();
      }

      const remainingPartHeight = partHeightLimit - current.height;
      const remainingItemHeight = fullTargetHeight - consumedTargetHeight;
      const targetHeight = Math.min(remainingPartHeight, remainingItemHeight);
      if (targetHeight <= 0) {
        pushCurrent();
        continue;
      }

      current.segments.push({
        item,
        sourceY: consumedTargetHeight / scale,
        sourceHeight: targetHeight / scale,
        targetY: current.height,
        targetHeight
      });
      current.height += targetHeight;
      consumedTargetHeight += targetHeight;
    }
  }

  pushCurrent();
  return parts;
}

async function renderExportPart(part: ExportPart, exportWidth: number, backgroundColor: string) {
  const canvas = document.createElement("canvas");
  canvas.width = exportWidth;
  canvas.height = Math.max(1, part.height);

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("PNG 캔버스를 만들 수 없습니다.");
  }

  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const imageCache = new Map<string, HTMLImageElement>();
  try {
    for (const segment of part.segments) {
      let image = imageCache.get(segment.item.id);
      if (!image) {
        image = await loadHtmlImage(segment.item.src);
        imageCache.set(segment.item.id, image);
      }

      const sourceScaleY = image.naturalHeight / segment.item.height;
      context.drawImage(
        image,
        0,
        segment.sourceY * sourceScaleY,
        image.naturalWidth,
        segment.sourceHeight * sourceScaleY,
        0,
        segment.targetY,
        exportWidth,
        segment.targetHeight
      );
    }

    const blob = await canvasToPngBlob(canvas);
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    imageCache.clear();
    canvas.width = 1;
    canvas.height = 1;
  }
}

function loadHtmlImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지를 PNG 저장용으로 읽지 못했습니다."));
    image.src = src;
  });
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("PNG 데이터를 만들지 못했습니다. 이미지가 너무 클 수 있습니다."));
      }
    }, "image/png");
  });
}

function makeExportFileName(sourceLabel: string) {
  const cleaned = sourceLabel
    .replace(/[\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

  return `${cleaned && cleaned !== "선택 없음" ? cleaned : "webtoon-preview"}.png`;
}

function makePartPath(targetPath: string, partIndex: number, totalParts: number) {
  const pngPath = targetPath.toLowerCase().endsWith(".png") ? targetPath : `${targetPath}.png`;
  if (totalParts === 1) {
    return pngPath;
  }

  const dotIndex = pngPath.toLowerCase().lastIndexOf(".png");
  const digits = Math.max(2, String(totalParts).length);
  return `${pngPath.slice(0, dotIndex)}-${String(partIndex + 1).padStart(digits, "0")}.png`;
}

function fileNameFromPath(filePath: string) {
  return filePath.split(/[\/]/).pop() ?? filePath;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function PreviewItem({ item, onOpenOriginal }: { item: ImageItem; onOpenOriginal: (item: ImageItem) => void }) {
  const openButton = (
    <button
      className="open-original-button"
      type="button"
      onClick={() => onOpenOriginal(item)}
      title="macOS 기본 앱으로 원본 파일 열기"
    >
      원본 열기
    </button>
  );

  if (item.status !== "ready" || !item.src) {
    return (
      <div className="error-item">
        <strong>{item.name}</strong>
        <span>{item.message ?? "이 파일은 표시할 수 없습니다."}</span>
        {openButton}
      </div>
    );
  }

  return (
    <div className="preview-frame">
      <div className="file-name-badge" title={item.name}>
        {item.index + 1}. {item.name}
      </div>
      <img className="preview-image" src={item.src} alt={item.name} loading="lazy" draggable={false} />
      {openButton}
    </div>
  );
}

function sourceAppLabel(item: ImageItem) {
  if (item.kind === "psd") {
    return "Photoshop 또는 PSD 기본 앱";
  }
  if (item.kind === "clip") {
    return "Clip Studio 또는 CLIP 기본 앱";
  }
  return "macOS 기본 앱";
}

function OrderEditor({
  draftOrder,
  draggedItemId,
  onApply,
  onClose,
  onDragEnd,
  onDragStart,
  onMoveByOffset,
  onMoveOver,
  onResetNatural
}: {
  draftOrder: ImageItem[];
  draggedItemId: string | null;
  onApply: () => void;
  onClose: () => void;
  onDragEnd: () => void;
  onDragStart: (id: string) => void;
  onMoveByOffset: (id: string, offset: number) => void;
  onMoveOver: (id: string, position: DropPosition) => void;
  onResetNatural: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="파일 순서 편집"
      onDragEnter={(event) => event.stopPropagation()}
      onDragLeave={(event) => event.stopPropagation()}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="order-dialog xp-window">
        <div className="xp-titlebar">
          <span>파일 순서 편집</span>
          <button type="button" onClick={onClose} aria-label="닫기">
            X
          </button>
        </div>
        <div className="order-help">항목을 위아래로 드래그한 뒤 적용을 누르세요.</div>
        <div className="order-list">
          {draftOrder.map((item, index) => (
            <div
              key={item.id}
              className={`order-row ${draggedItemId === item.id ? "is-dragged" : ""}`}
              draggable
              onDragEnd={(event) => {
                event.stopPropagation();
                onDragEnd();
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                onMoveOver(item.id, getDropPosition(event));
              }}
              onDragStart={(event) => {
                event.stopPropagation();
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", item.id);
                onDragStart(item.id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDragEnd();
              }}
            >
              <span className="order-index">{index + 1}</span>
              <div className="order-thumb">{item.src ? <img src={item.src} alt="" draggable={false} /> : <span>!</span>}</div>
              <div className="order-meta">
                <strong>{item.name}</strong>
                <span>{item.status === "ready" ? `${item.width ?? "?"} x ${item.height ?? "?"}` : item.message ?? "표시 불가"}</span>
              </div>
              <div className="order-stepper" aria-label="순서 미세 조정">
                <button type="button" onClick={() => onMoveByOffset(item.id, -1)} disabled={index === 0} aria-label={`${item.name} 위로 이동`}>
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => onMoveByOffset(item.id, 1)}
                  disabled={index === draftOrder.length - 1}
                  aria-label={`${item.name} 아래로 이동`}
                >
                  ▼
                </button>
              </div>
              <span className="order-grip" aria-hidden="true">↕</span>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onResetNatural}>
            기본 정렬
          </button>
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button className="primary-button" type="button" onClick={onApply}>
            적용
          </button>
        </div>
      </div>
    </div>
  );
}

type DropPosition = "before" | "after";

function getDropPosition(event: React.DragEvent<HTMLElement>): DropPosition {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
}

function restoreManualOrder(items: ImageItem[], sourcePaths: string[]) {
  try {
    const raw = localStorage.getItem(manualOrderStorageKey(sourcePaths));
    const savedPaths = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(savedPaths) || savedPaths.length === 0) {
      return null;
    }

    const itemsByPath = new Map<string, ImageItem[]>();
    for (const item of items) {
      const bucket = itemsByPath.get(item.path) ?? [];
      bucket.push(item);
      itemsByPath.set(item.path, bucket);
    }

    const ordered: ImageItem[] = [];
    for (const savedPath of savedPaths) {
      if (typeof savedPath !== "string") {
        continue;
      }
      const bucket = itemsByPath.get(savedPath);
      const item = bucket?.shift();
      if (item) {
        ordered.push(item);
      }
    }

    if (ordered.length === 0) {
      return null;
    }

    const usedIds = new Set(ordered.map((item) => item.id));
    ordered.push(...items.filter((item) => !usedIds.has(item.id)));
    return { items: ordered.map((item, index) => ({ ...item, index })) };
  } catch {
    return null;
  }
}

function manualOrderStorageKey(sourcePaths: string[]) {
  return `${manualOrderPrefix}${[...sourcePaths].sort().join("|")}`;
}

function readStoredSettings(): StoredSettings {
  try {
    const raw = localStorage.getItem(settingsKey);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const value = parsed as Record<string, unknown>;
    return {
      background: isBackgroundKey(value.background) ? value.background : undefined,
      fixedWidth: isFixedWidth(value.fixedWidth) ? value.fixedWidth : undefined,
      fitImageToWindow: typeof value.fitImageToWindow === "boolean" ? value.fitImageToWindow : undefined,
      panelOpen: typeof value.panelOpen === "boolean" ? value.panelOpen : undefined,
      sortMode: isSortMode(value.sortMode) ? value.sortMode : undefined,
      widthMode: isWidthMode(value.widthMode) ? value.widthMode : undefined
    };
  } catch {
    return {};
  }
}

function isBackgroundKey(value: unknown): value is BackgroundKey {
  return value === "white" || value === "black";
}

function isWidthMode(value: unknown): value is WidthMode {
  return value === "fixed" || value === "fitWindow" || value === "fitImage";
}

function isSortMode(value: unknown): value is SortMode {
  return value === "natural" || value === "manual";
}

function isFixedWidth(value: unknown): value is number {
  return typeof value === "number" && fixedWidths.includes(value);
}

function isFileDrag(event: React.DragEvent) {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function readRecentSource(): string[] {
  try {
    const raw = localStorage.getItem(recentKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function waitForPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

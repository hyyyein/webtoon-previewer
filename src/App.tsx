import { useEffect, useMemo, useRef, useState } from "react";
import type { AppCommand } from "./global";
import type { ImageItem, ImportResult, SortMode } from "./types";

type BackgroundKey = "white" | "gray" | "black";
type WidthMode = "fixed" | "fitWindow" | "fitImage";
type ViewMode = "editor" | "reader";

const fixedWidths = [360, 430, 500, 690, 800, 1000, 1200];
const backgroundValues: Record<BackgroundKey, string> = {
  white: "#ffffff",
  gray: "#8b8b8b",
  black: "#050505"
};
const settingsKey = "webtoon-previewer-settings";
const recentKey = "webtoon-previewer-recent-source";
const manualOrderPrefix = "webtoon-previewer-manual-order:";

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
              <button className={background === "gray" ? "selected" : ""} type="button" onClick={() => setBackground("gray")} disabled={isBusy}>
                회색
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
            <button type="button" onClick={() => window.webtoonPreviewer.fitWindowToWidth(displayWidth)} disabled={isBusy || items.length === 0}>
              창 맞춤
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
              <PreviewItem key={item.id} item={item} />
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

function PreviewItem({ item }: { item: ImageItem }) {
  if (item.status !== "ready" || !item.src) {
    return (
      <div className="error-item">
        <strong>{item.name}</strong>
        <span>{item.message ?? "이 파일은 표시할 수 없습니다."}</span>
      </div>
    );
  }

  return <img className="preview-image" src={item.src} alt={item.name} loading="lazy" draggable={false} />;
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
  return value === "white" || value === "gray" || value === "black";
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

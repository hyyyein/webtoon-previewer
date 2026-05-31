import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AppCommand, ImportResult, SortMode } from "./types.js";

const api = {
  openFolder: (): Promise<ImportResult | null> => ipcRenderer.invoke("dialog:open-folder"),
  importPaths: (paths: string[], sortMode?: SortMode): Promise<ImportResult> =>
    ipcRenderer.invoke("files:import-paths", paths, sortMode),
  fitWindowToWidth: (width: number): Promise<void> => ipcRenderer.invoke("window:fit-content-width", width),
  chooseExportPath: (defaultName: string): Promise<string | null> => ipcRenderer.invoke("export:choose-png-path", defaultName),
  writePngFile: (filePath: string, data: Uint8Array): Promise<void> =>
    ipcRenderer.invoke("export:write-png-file", filePath, data),
  onImportResult: (callback: (result: ImportResult) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: ImportResult) => callback(result);
    ipcRenderer.on("files:loaded", listener);
    return () => ipcRenderer.removeListener("files:loaded", listener);
  },
  onAppCommand: (callback: (command: AppCommand) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: AppCommand) => callback(command);
    ipcRenderer.on("app-command", listener);
    return () => ipcRenderer.removeListener("app-command", listener);
  },
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
};

contextBridge.exposeInMainWorld("webtoonPreviewer", api);

declare global {
  interface Window {
    webtoonPreviewer: typeof api;
  }
}

export type WebtoonPreviewerApi = typeof api;

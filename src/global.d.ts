import type { ImportResult, SortMode } from "./types";

export type AppCommand = "enter-reader" | "open-order-editor" | "reset-natural" | "export-png";

declare global {
  interface Window {
    webtoonPreviewer: {
      openFolder: () => Promise<ImportResult | null>;
      importPaths: (paths: string[], sortMode?: SortMode) => Promise<ImportResult>;
      fitWindowToWidth: (width: number) => Promise<void>;
      chooseExportPath: (defaultName: string) => Promise<string | null>;
      writePngFile: (filePath: string, data: Uint8Array) => Promise<void>;
      onImportResult: (callback: (result: ImportResult) => void) => () => void;
      onAppCommand: (callback: (command: AppCommand) => void) => () => void;
      getPathForFile: (file: File) => string;
    };
  }
}

export {};

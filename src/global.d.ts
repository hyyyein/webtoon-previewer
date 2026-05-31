import type { ImportResult, SortMode } from "./types";

export type AppCommand = "enter-reader" | "open-order-editor" | "reset-natural";

declare global {
  interface Window {
    webtoonPreviewer: {
      openFolder: () => Promise<ImportResult | null>;
      importPaths: (paths: string[], sortMode?: SortMode) => Promise<ImportResult>;
      fitWindowToWidth: (width: number) => Promise<void>;
      onImportResult: (callback: (result: ImportResult) => void) => () => void;
      onAppCommand: (callback: (command: AppCommand) => void) => () => void;
      getPathForFile: (file: File) => string;
    };
  }
}

export {};

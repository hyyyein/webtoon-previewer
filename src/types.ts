export type SortMode = "natural" | "manual";

export type ImageKind = "jpg" | "png" | "webp" | "psd" | "clip";

export type ImageStatus = "ready" | "error" | "unsupported";

export interface ImageItem {
  id: string;
  index: number;
  name: string;
  path: string;
  extension: string;
  kind: ImageKind;
  status: ImageStatus;
  src?: string;
  width?: number;
  height?: number;
  message?: string;
}

export interface ImportResult {
  sourceLabel: string;
  sourcePaths: string[];
  sortMode: SortMode;
  items: ImageItem[];
}

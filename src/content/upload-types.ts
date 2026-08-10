import type { UploadResult } from '../shared/types';

/** Shared upload primitives (kept separate to avoid circular imports). */

export interface UploadHandle {
  promise: Promise<UploadResult>;
  cancel(): void;
}

export class UploadNotConfiguredError extends Error {
  constructor() {
    super('上傳 API 尚未依 DISCOVERY 結果設定');
    this.name = 'UploadNotConfiguredError';
  }
}

export class UploadCancelledError extends Error {
  constructor() {
    super('上傳已取消');
    this.name = 'UploadCancelledError';
  }
}

/**
 * A resolved upload destination. image-drop.ts only talks to this interface;
 * the concrete implementation (Wiki.js flow / generic API) is picked by
 * createUploadTarget() in image-uploader.ts based on wikiConfig.assets.mode.
 */
export interface UploadTarget {
  folderPath: string;
  /** Normalize a filename the way the target server will store it. */
  normalize(name: string): string;
  /** Filenames already present in the folder (for -1/-2 dedup). */
  existingNames(): Promise<string[]>;
  begin(file: File, fileName: string, onProgress: (fraction: number) => void): UploadHandle;
}

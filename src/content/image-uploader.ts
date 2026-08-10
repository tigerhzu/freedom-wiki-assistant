import { wikiConfig } from '../config/wiki-config';
import type { UploadApiConfig, UploadResult } from '../shared/types';
import { encodeAssetPath, sanitizeFileName } from './sanitize-filename';
import { UploadCancelledError, type UploadHandle, type UploadTarget } from './upload-types';
import {
  listFolderFilenames,
  normalizeWikijsFileName,
  resolveFolderId,
  uploadToWikijs,
} from './wikijs-upload';

export { UploadCancelledError, UploadNotConfiguredError } from './upload-types';
export type { UploadHandle, UploadTarget } from './upload-types';

/**
 * Upload dispatch. Priority (per spec):
 *  1. The wiki's own upload flow ('wikijs' mode — Wiki.js 2.x POST /u).
 *  2. Generic same-origin API described in config ('api' mode).
 *  3. Fallback: no network call at all; the UI guides the user to the
 *     wiki's own upload interface.
 *
 * Login state is reused via cookies on same-origin requests
 * (withCredentials); we never read or store credentials. Images are never
 * inlined as Base64.
 */

/**
 * Resolve a folder path into a concrete UploadTarget.
 * Returns null when the current mode has no API to call (fallback).
 * Throws WikijsFolderNotFoundError when the folder does not exist in Wiki.js
 * and `autoCreate` is false, or WikijsFolderCreateError if `autoCreate` is
 * true and creating a missing segment fails.
 */
export async function createUploadTarget(
  folderPath: string,
  options: { autoCreate?: boolean } = {},
): Promise<UploadTarget | null> {
  switch (wikiConfig.assets.mode) {
    case 'wikijs': {
      const { id: folderId, slugPath } = await resolveFolderId(folderPath, options);
      let cachedNames: string[] | null = null;
      return {
        folderPath,
        normalize: normalizeWikijsFileName,
        async existingNames() {
          if (cachedNames === null) cachedNames = await listFolderFilenames(folderId);
          return cachedNames;
        },
        begin(file, fileName, onProgress) {
          // Use the folder's real stored slug path (not the caller's input)
          // to build the URL — Wiki.js lowercases ASCII slugs server-side,
          // so an existing folder can differ in case from the derived
          // article path (confirmed on the real site: building the URL from
          // the input path instead of this 404s).
          return uploadToWikijs(file, fileName, folderId, slugPath, onProgress);
        },
      };
    }
    case 'api': {
      const cfg = wikiConfig.assets.uploadApi;
      if (!cfg) return null;
      return {
        folderPath,
        normalize: sanitizeFileName,
        // Generic APIs give us no listing — dedup only within this session.
        existingNames: async () => [],
        begin(file, fileName, onProgress) {
          return uploadViaConfiguredApi(cfg, file, fileName, folderPath, onProgress);
        },
      };
    }
    case 'fallback':
      return null;
  }
}

/* ── generic config-driven API ('api' mode) ── */

function readCookie(name: string): string | null {
  // Used ONLY to copy a CSRF token into a request header when the wiki uses
  // the cookie-to-header pattern. The value is never stored or logged.
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function resolveCsrfToken(cfg: UploadApiConfig): { headerName: string; token: string } | null {
  if (!cfg.csrf) return null;
  let token: string | null = null;
  switch (cfg.csrf.source) {
    case 'cookie':
      token = readCookie(cfg.csrf.key);
      break;
    case 'meta':
      token = document.querySelector<HTMLMetaElement>(`meta[name="${cfg.csrf.key}"]`)?.content ?? null;
      break;
    case 'input':
      token = document.querySelector<HTMLInputElement>(cfg.csrf.key)?.value ?? null;
      break;
  }
  if (!token) throw new Error('找不到 CSRF Token，請確認 wiki-config.ts 的 csrf 設定');
  return { headerName: cfg.csrf.headerName, token };
}

function pickByDotPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function uploadViaConfiguredApi(
  cfg: UploadApiConfig,
  file: File,
  fileName: string,
  folder: string,
  onProgress: (fraction: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest();
  let cancelled = false;

  const promise = new Promise<UploadResult>((resolve, reject) => {
    const url = cfg.endpoint.startsWith('http')
      ? cfg.endpoint
      : new URL(cfg.endpoint, wikiConfig.origin).toString();

    xhr.open(cfg.method, url, true);
    xhr.withCredentials = true;

    const csrf = resolveCsrfToken(cfg);
    if (csrf) xhr.setRequestHeader(csrf.headerName, csrf.token);

    const form = new FormData();
    form.append(cfg.fileField, file, fileName);
    if (cfg.folderField) form.append(cfg.folderField, folder);
    for (const [k, v] of Object.entries(cfg.extraFields ?? {})) form.append(k, v);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`上傳失敗 (HTTP ${xhr.status})`));
        return;
      }
      let finalUrl: string;
      if (cfg.responseUrlPath) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch {
          reject(new Error('上傳回應不是 JSON，無法取得圖片路徑'));
          return;
        }
        const value = pickByDotPath(parsed, cfg.responseUrlPath);
        if (typeof value !== 'string' || !value) {
          reject(new Error(`上傳回應中找不到 ${cfg.responseUrlPath}`));
          return;
        }
        finalUrl = value;
      } else {
        finalUrl = encodeAssetPath(`${folder.replace(/\/$/, '')}/${fileName}`);
      }
      resolve({ url: finalUrl, fileName });
    });
    xhr.addEventListener('error', () => reject(new Error('上傳失敗（網路錯誤）')));
    xhr.addEventListener('abort', () =>
      reject(cancelled ? new UploadCancelledError() : new Error('上傳中斷')),
    );

    xhr.send(form);
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      xhr.abort();
    },
  };
}

/**
 * Fallback mode: open the wiki's assets manager when it has a standalone
 * page. Wiki.js keeps it inside the editor modal, so this usually returns
 * false and the caller shows instructions instead.
 */
export function openAssetsManagerFallback(): boolean {
  const url = wikiConfig.assets.assetsManagerUrl;
  if (!url) return false;
  window.open(new URL(url, wikiConfig.origin).toString(), '_blank', 'noopener');
  return true;
}

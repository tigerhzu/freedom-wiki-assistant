import { sanitizePathSegments, wikiConfig } from '../config/wiki-config';
import type { UploadResult } from '../shared/types';
import { encodeAssetPath } from './sanitize-filename';
import { UploadCancelledError, type UploadHandle } from './upload-types';

/**
 * Wiki.js 2.x asset upload flow, mirroring the official media modal
 * (client/components/editor/editor-modal-media.vue) and upload controller
 * (server/controllers/upload.js):
 *
 *   1. Resolve the target folder path to a folderId by walking the
 *      GraphQL `assets.folders(parentFolderId)` tree from the root (0).
 *   2. POST /u with multipart FormData:
 *        mediaUpload = JSON string {"folderId": N}   (metadata field)
 *        mediaUpload = <file>                        (file field, same name)
 *      GraphQL calls work with the session cookie alone (withCredentials),
 *      but the /u upload route is guarded by passport-jwt's bearer-only
 *      extractor — confirmed on the real site: a cookie-only POST to /u
 *      comes back 403 "You are not authorized to upload files.", exactly
 *      like the official media modal, which reads the non-HttpOnly `jwt`
 *      cookie and resends it as `Authorization: Bearer`. We do the same
 *      here, only for this one request; the token is never logged or
 *      persisted.
 *   3. The response body is just "ok" — the final asset URL is
 *      /<folder slugs>/<normalized filename> (no locale segment).
 *
 * Verified end-to-end against the real site on the /en/eng/ExtensionTest
 * test page (2026-07-24): CodeMirror selectors, GraphQL folder/list shape,
 * upload field name, "ok" response, filename normalization (lowercase +
 * space/comma → "_"), and the no-locale asset URL all matched. Same-name
 * uploads silently overwrite the existing asset server-side (no auto
 * rename), which is why the client-side -1/-2 dedup below is required.
 */

export class WikijsFolderNotFoundError extends Error {
  constructor(folderPath: string) {
    super(`Assets 中找不到資料夾 ${folderPath}（需先在 Wiki.js Assets 介面建立）`);
    this.name = 'WikijsFolderNotFoundError';
  }
}

/**
 * A folder segment failed to auto-create. Carries enough detail to build a
 * precise error message: which layer failed, the raw GraphQL/API response,
 * and a best-effort guess at whether it's a permission problem (Wiki.js
 * returns that as a normal `responseResult.message`, not an HTTP status).
 */
export class WikijsFolderCreateError extends Error {
  constructor(
    public readonly folderPath: string,
    public readonly failedSegment: string,
    public readonly serverResponse: string,
    public readonly likelyPermissionIssue: boolean,
  ) {
    super(
      `建立資料夾失敗：「${folderPath}」（${failedSegment} 這一層）` +
        (likelyPermissionIssue ? '，可能是權限不足' : '') +
        `。伺服器回應：${serverResponse}`,
    );
    this.name = 'WikijsFolderCreateError';
  }
}

function looksLikePermissionIssue(message: string): boolean {
  return /permission|not authoriz|forbidden|denied|unauthorized/i.test(message);
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(new URL(wikiConfig.assets.wikijs.graphqlEndpoint, wikiConfig.origin), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL 查詢失敗 (HTTP ${res.status})`);
  const payload = (await res.json()) as GraphQLResponse<T>;
  if (payload.errors?.length) throw new Error(`GraphQL 錯誤：${payload.errors[0].message}`);
  if (!payload.data) throw new Error('GraphQL 回應沒有資料');
  return payload.data;
}

interface FolderListData {
  assets: { folders: Array<{ id: number; slug: string; name: string }> };
}

/** List sub-folders of a folder (0 = root). */
export async function listSubFolders(
  parentFolderId: number,
): Promise<Array<{ id: number; slug: string }>> {
  const data = await gql<FolderListData>(
    `query ($parentFolderId: Int!) {
      assets { folders(parentFolderId: $parentFolderId) { id slug name } }
    }`,
    { parentFolderId },
  );
  return data.assets.folders;
}

interface CreateFolderData {
  assets: {
    createFolder: {
      responseResult: { succeeded: boolean; errorCode: number; message: string };
    };
  };
}

/**
 * `assets.createFolder(parentFolderId, slug)` — the exact mutation the
 * official "New Folder" dialog sends (captured from the real site's network
 * traffic; introspection is disabled in production so this couldn't be read
 * from the schema). Cookie-only auth is enough here — unlike the /u upload
 * route, GraphQL mutations don't require the Bearer header. Confirmed on the
 * real site: the server always lowercases the slug it's given and accepts
 * CJK slugs unchanged (both end-to-end tested: folder created, file
 * uploaded into it, final URL fetched successfully). There is no
 * `deleteFolder` mutation in the Wiki.js 2.x schema — folders created here
 * cannot be removed through the API, so auto-creation only ever runs
 * immediately before an actual upload, never speculatively.
 */
async function createFolder(
  parentFolderId: number,
  slug: string,
): Promise<{ succeeded: boolean; message: string }> {
  const data = await gql<CreateFolderData>(
    `mutation ($parentFolderId: Int!, $slug: String!) {
      assets { createFolder(parentFolderId: $parentFolderId, slug: $slug) { responseResult { succeeded errorCode message } } }
    }`,
    { parentFolderId, slug },
  );
  return data.assets.createFolder.responseResult;
}

export interface ResolvedFolder {
  id: number;
  /**
   * The folder path built from each segment's REAL stored slug, not the
   * caller's input. Wiki.js always lowercases ASCII slugs server-side (CJK
   * segments are kept as-is) — confirmed on the real site that an existing
   * folder can have a different case than the article path that derived it
   * (e.g. an article at ".../ExtensionTest/..." resolving into a folder
   * that was actually created as "extensiontest"). Building the final
   * asset URL from the caller's input path instead of this would silently
   * 404. Empty string for the root.
   */
  slugPath: string;
}

/**
 * Resolve an asset folder path like "/eng/MeetingMinutes" to its folderId by
 * walking the folder tree. Returns id 0 / slugPath "" (root) for an empty
 * path.
 *
 * With `autoCreate: false` (default), throws WikijsFolderNotFoundError as
 * soon as a segment is missing. With `autoCreate: true`, creates each
 * missing segment in order (root → leaf) via the `createFolder` mutation
 * before continuing; throws WikijsFolderCreateError with the failed layer,
 * the raw server response and a permission-issue guess if any layer fails.
 */
export async function resolveFolderId(
  folderPath: string,
  options: { autoCreate?: boolean } = {},
): Promise<ResolvedFolder> {
  const segments = sanitizePathSegments(folderPath);
  let current = 0;
  let walked = '';
  const slugs: string[] = [];
  for (const segment of segments) {
    const children = await listSubFolders(current);
    const match = children.find((f) => f.slug.toLowerCase() === segment.toLowerCase());
    walked += `/${segment}`;
    if (match) {
      current = match.id;
      slugs.push(match.slug);
      continue;
    }
    if (!options.autoCreate) throw new WikijsFolderNotFoundError(walked);

    // The server lowercases slugs regardless of what we send — send it
    // pre-lowercased so our own case-insensitive matching above stays in
    // sync with what actually gets stored.
    const slug = segment.toLowerCase();
    let result: { succeeded: boolean; message: string };
    try {
      result = await createFolder(current, slug);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new WikijsFolderCreateError(walked, segment, message, looksLikePermissionIssue(message));
    }
    if (!result.succeeded) {
      throw new WikijsFolderCreateError(
        walked,
        segment,
        result.message,
        looksLikePermissionIssue(result.message),
      );
    }

    // createFolder's response carries no id/slug for the new folder — re-list
    // the parent to find it.
    const refreshed = await listSubFolders(current);
    const created = refreshed.find((f) => f.slug.toLowerCase() === slug);
    if (!created) {
      throw new WikijsFolderCreateError(
        walked,
        segment,
        `建立成功但重新查詢時找不到資料夾 "${slug}"`,
        false,
      );
    }
    current = created.id;
    slugs.push(created.slug);
  }
  return { id: current, slugPath: slugs.length > 0 ? `/${slugs.join('/')}` : '' };
}

/** Read the non-HttpOnly `jwt` cookie so it can be resent as a Bearer token for /u. */
function readJwtCookie(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)jwt=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

interface AssetListData {
  assets: { list: Array<{ id: number; filename: string }> };
}

/** Existing filenames in a folder — used for -1/-2 dedup so nothing is overwritten. */
export async function listFolderFilenames(folderId: number): Promise<string[]> {
  const data = await gql<AssetListData>(
    `query ($folderId: Int!) {
      assets { list(folderId: $folderId, kind: ALL) { id filename } }
    }`,
    { folderId },
  );
  return data.assets.list.map((a) => a.filename);
}

export interface AssetInfo {
  id: number;
  filename: string;
  fileSize: number;
  updatedAt: string;
}

interface AssetListFullData {
  assets: { list: AssetInfo[] };
}

/** Full image listing for a folder (id/size/updatedAt) — used by the "review folder photos" panel. */
export async function listFolderImages(folderId: number): Promise<AssetInfo[]> {
  const data = await gql<AssetListFullData>(
    `query ($folderId: Int!) {
      assets { list(folderId: $folderId, kind: IMAGE) { id filename fileSize updatedAt } }
    }`,
    { folderId },
  );
  return data.assets.list;
}

interface DeleteAssetData {
  assets: {
    deleteAsset: {
      responseResult: { succeeded: boolean; errorCode: number; message: string };
    };
  };
}

/** `assets.deleteAsset(id)` — matches the official Assets manager's delete action (server/graph/schemas/asset.graphql). */
export async function deleteWikijsAsset(id: number): Promise<{ succeeded: boolean; message: string }> {
  const data = await gql<DeleteAssetData>(
    `mutation ($id: Int!) {
      assets { deleteAsset(id: $id) { responseResult { succeeded errorCode message } } }
    }`,
    { id },
  );
  return data.assets.deleteAsset.responseResult;
}

interface RenameAssetData {
  assets: {
    renameAsset: {
      responseResult: { succeeded: boolean; errorCode: number; message: string };
    };
  };
}

/**
 * Wiki.js updates the asset row before it asks the configured storage backend
 * to move the physical file. Azure Blob Storage reports this exact message
 * when its credential cannot copy and/or delete the blob required for a
 * rename. This is deliberately narrower than a generic "not authorized"
 * check: an `AssetRenameForbidden` result is a Wiki.js folder permission
 * issue, while this means the server-side storage integration must be fixed.
 */
export function isWikijsAssetStorageRenameFailure(message: string): boolean {
  return /this request is not authorized to perform this operation|authorizationpermissionmismatch|authorizationfailure|authenticationfailed/i.test(
    message,
  );
}

/**
 * `assets.renameAsset(id, filename)` (server/graph/resolvers/asset.js). The
 * server re-runs `sanitize-filename` + `.toLowerCase()` on `filename` itself
 * — a *different* rule from the upload path's normalizeWikijsFileName below
 * (upload.js additionally turns whitespace/commas/hashes into "_"; rename
 * does not), and independently rejects two cases the caller must not rely on
 * being caught client-side: changing the file extension
 * (AssetRenameInvalidExt) and a same-folder filename collision
 * (AssetRenameCollision). Callers should re-fetch the folder listing after a
 * successful rename rather than assume the requested name was stored as-is.
 */
export async function renameWikijsAsset(
  id: number,
  filename: string,
): Promise<{ succeeded: boolean; message: string }> {
  const data = await gql<RenameAssetData>(
    `mutation ($id: Int!, $filename: String!) {
      assets { renameAsset(id: $id, filename: $filename) { responseResult { succeeded errorCode message } } }
    }`,
    { id, filename },
  );
  return data.assets.renameAsset.responseResult;
}

/**
 * Normalize a filename the way the Wiki.js 2.x server does
 * (server/controllers/upload.js): lowercase, whitespace/comma/semicolon/hash
 * → "_", then strip characters removed by the sanitize-filename library.
 * Pre-normalizing client-side keeps the final asset path predictable, since
 * the upload response body is just "ok". Confirmed against the real server:
 * "測試 圖片,一.png" → "測試_圖片_一.png", "Test File Upper CASE.png" →
 * "test_file_upper_case.png".
 */
export function normalizeWikijsFileName(original: string): string {
  const normalized = original.normalize('NFC');
  const dot = normalized.lastIndexOf('.');
  const rawBase = dot > 0 ? normalized.slice(0, dot) : normalized;
  const rawExt = dot > 0 ? normalized.slice(dot + 1) : '';

  const base =
    rawBase
      .toLowerCase()
      .replace(/[\s,;#]+/g, '_')
      // characters removed by the sanitize-filename npm package
      .replace(/[\\/?<>:*|"^]/g, '')
      .replace(/\p{Cc}/gu, '')
      .replace(/^\.+/, '') || 'image';
  const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext ? `${base}.${ext}` : base;
}

/**
 * Upload one file to a resolved Wiki.js folder. `folderSlugPath` must be the
 * folder's REAL stored slug path (ResolvedFolder.slugPath), not the
 * caller-derived path — it's what the final asset URL is built from.
 */
export function uploadToWikijs(
  file: File,
  fileName: string,
  folderId: number,
  folderSlugPath: string,
  onProgress: (fraction: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest();
  let cancelled = false;

  const promise = new Promise<UploadResult>((resolve, reject) => {
    const maxBytes = wikiConfig.assets.wikijs.maxFileSizeMB * 1024 * 1024;
    if (file.size > maxBytes) {
      reject(new Error(`檔案超過 Wiki.js 上限 ${wikiConfig.assets.wikijs.maxFileSizeMB}MB`));
      return;
    }

    xhr.open('POST', new URL(wikiConfig.assets.wikijs.uploadEndpoint, wikiConfig.origin).toString(), true);
    xhr.withCredentials = true;
    const jwt = readJwtCookie();
    if (jwt) xhr.setRequestHeader('Authorization', `Bearer ${jwt}`);

    const field = wikiConfig.assets.wikijs.uploadField;
    const form = new FormData();
    // Metadata part first, then the file part — same order as FilePond.
    form.append(field, JSON.stringify({ folderId }));
    form.append(field, file, fileName);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`上傳失敗 (HTTP ${xhr.status})`));
        return;
      }
      const url = encodeAssetPath(`${folderSlugPath.replace(/\/$/, '')}/${fileName}`);
      resolve({ url, fileName });
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

/**
 * Pure filename helpers for image upload. Unit tested in
 * tests/sanitize-filename.test.ts.
 */

const UNSAFE = /[\\/:*?"<>|#%{}^~[\]`;'@&=+$,!()]/g;

/**
 * Sanitize a filename for upload:
 *  - keeps the (lower-cased) extension
 *  - whitespace → "-"
 *  - strips characters that are unsafe in URLs/paths
 *  - keeps CJK characters (URL-encoding happens later, at Markdown insertion)
 */
export function sanitizeFileName(original: string): string {
  const normalized = original.normalize('NFC');
  const dot = normalized.lastIndexOf('.');
  const rawBase = dot > 0 ? normalized.slice(0, dot) : normalized;
  const rawExt = dot > 0 ? normalized.slice(dot + 1) : '';

  let base = rawBase
    .replace(/\s+/g, '-')
    .replace(UNSAFE, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!base) base = 'image';

  const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext ? `${base}.${ext}` : base;
}

/**
 * Given a desired name and the set of names that already exist in the target
 * folder, return a unique name by appending -1, -2, -3 … before the extension.
 * Existing files are never overwritten.
 */
export function uniqueFileName(desired: string, existingNames: readonly string[]): string {
  const existing = new Set(existingNames.map((n) => n.toLowerCase()));
  if (!existing.has(desired.toLowerCase())) return desired;

  const dot = desired.lastIndexOf('.');
  const base = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : '';
  for (let i = 1; ; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
}

/** Extract the lower-cased extension without the dot ("" if none). */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * URL-encode each segment of an asset path (supports CJK filenames) while
 * keeping the "/" separators readable.
 */
export function encodeAssetPath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/** Build the Markdown image line from the user-configurable format string. */
export function buildImageMarkdown(format: string, name: string, url: string): string {
  return format.replaceAll('{name}', name).replaceAll('{url}', url);
}

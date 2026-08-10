import { bridgeCall, ensureBridge } from './bridge';

export interface ArticlePath {
  locale: string;
  /** Slash-separated, no leading slash, no locale segment, e.g. "eng/ExtensionTest". */
  path: string;
}

interface BridgePagePath {
  locale: string;
  path: string;
  isNew: boolean;
}

/**
 * The current article's path, read straight from Wiki.js's own Vuex `page`
 * store module via page-bridge.ts — the exact value Wiki.js itself uses when
 * saving, confirmed on the real site to be populated even for a brand-new,
 * not-yet-saved page. Never guessed from document.title.
 *
 * Falls back to parsing the editor URL (/e/<locale>/<path>) only if the
 * bridge/store shape is unavailable (e.g. a future Wiki.js version); returns
 * null if neither source has anything usable, so the caller can fall back to
 * the folder picker.
 */
export async function getCurrentArticlePath(): Promise<ArticlePath | null> {
  try {
    await ensureBridge();
    const result = bridgeCall<BridgePagePath>('getPagePath');
    if (result.path) return { locale: result.locale, path: result.path };
  } catch {
    // Bridge unavailable or store shape changed — fall through to the URL.
  }
  return pathFromEditUrl(location.pathname);
}

/** Fallback only: derive locale + path from /e/<locale>/<path...>. Exported for unit testing. */
export function pathFromEditUrl(pathname: string): ArticlePath | null {
  const segs = pathname.split('/').filter(Boolean);
  if (segs[0] !== 'e') return null; // not an edit URL — nothing reliable to derive
  segs.shift();
  let locale = '';
  if (segs.length > 0 && /^[a-z]{2}(-[a-z]{2,4})?$/i.test(segs[0])) {
    locale = segs.shift()!;
  }
  if (segs.length === 0) return null;
  return { locale, path: segs.join('/') };
}

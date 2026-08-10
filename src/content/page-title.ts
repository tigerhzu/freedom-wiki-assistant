import { wikiConfig } from '../config/wiki-config';

/**
 * Human-readable title of the page currently open, preferring the article's
 * own H1 (wikiConfig.pageTitle.selector) over document.title — the latter is
 * Wiki.js page metadata and can be "Untitled Page". Shared by the template
 * panel's {{page_title}} placeholder and the customer drawer's
 * 「將目前頁面加入分支」, so both name a page the same way.
 */
export function readCurrentPageTitle(): string {
  const fallback = document.title;
  const selector = wikiConfig.pageTitle.selector;
  if (!selector) return fallback;
  const heading = document.querySelector(selector);
  // Strip the leading "¶" toc-anchor permalink icon Wiki.js prepends to headings.
  const text = heading?.querySelector('.toc-anchor')
    ? heading.textContent?.replace(/^\s*¶\s*/, '')
    : heading?.textContent;
  return text?.trim() || fallback;
}

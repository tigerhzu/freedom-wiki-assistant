/**
 * SPA-aware page observer. The wiki may swap articles without a full page
 * load, so we watch for URL changes and significant DOM mutations and let
 * the caller re-detect the editor.
 */
export class PageObserver {
  private observer: MutationObserver | null = null;
  private lastHref = location.href;
  private debounceTimer: number | undefined;

  constructor(private readonly onPageMaybeChanged: () => void) {}

  start(): void {
    this.observer = new MutationObserver(() => {
      if (location.href !== this.lastHref) {
        this.lastHref = location.href;
        this.fire();
        return;
      }
      // Editor containers can also be re-mounted without a URL change.
      this.fireDebounced();
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('popstate', this.fire);
    window.addEventListener('hashchange', this.fire);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    window.removeEventListener('popstate', this.fire);
    window.removeEventListener('hashchange', this.fire);
    window.clearTimeout(this.debounceTimer);
  }

  private readonly fire = (): void => {
    window.clearTimeout(this.debounceTimer);
    this.onPageMaybeChanged();
  };

  private fireDebounced(): void {
    window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => this.onPageMaybeChanged(), 400);
  }
}

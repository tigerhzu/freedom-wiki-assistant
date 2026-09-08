import { getSettings } from '../shared/storage';

const STYLE_ID = 'fwa-wiki-sidebar-theme';
const MARKER_CLASS = 'fwa-wiki-sidebar';
// Page-origin localStorage copy of the last applied theme. chrome.storage is
// async, so at document_start this synchronous cache is the only way to have
// the color in place before the first paint.
const THEME_CACHE_KEY = 'fwa:sidebar-theme';

export const SIDEBAR_COLOR_PRESETS = [
  '#287dea',
  '#ff7a1a',
  '#f5b82e',
  '#ef4444',
  '#ff6fa5',
  '#9b6bff',
  '#6366f1',
  '#3a82f7',
  '#06b6d4',
  '#14b8a6',
  '#2fb968',
  '#84cc16',
  '#64748b',
] as const;

function sidebarStyleFor(scope: string): string {
  return `
${scope},
${scope} .v-navigation-drawer__content {
  background-color: var(--fwa-sidebar-color) !important;
  background-image: var(--fwa-sidebar-gradient) !important;
  color: var(--fwa-sidebar-text) !important;
}

${scope} .v-list {
  background: transparent !important;
  color: var(--fwa-sidebar-text) !important;
}

${scope} .pa-3.d-flex {
  background-color: var(--fwa-sidebar-header-start) !important;
  background-image: var(--fwa-sidebar-header-gradient) !important;
}

${scope} .pa-3.d-flex > .v-btn {
  background-color: var(--fwa-sidebar-button) !important;
  color: var(--fwa-sidebar-text) !important;
}

${scope} .v-list-item,
${scope} .v-list-item__title,
${scope} .v-list-item__icon,
${scope} .v-list-item__avatar,
${scope} .v-icon,
${scope} .v-subheader {
  color: var(--fwa-sidebar-text) !important;
}

${scope} .v-list-item::before {
  background-color: var(--fwa-sidebar-text) !important;
}

${scope} .v-divider {
  border-color: var(--fwa-sidebar-divider) !important;
}
`;
}

// The fallback scope covers the window between first paint and the moment
// updateMarker() tags the drawer: it colors Wiki.js' own drawer directly,
// but only while no element carries the marker class yet.
const SIDEBAR_STYLE =
  sidebarStyleFor(`html[data-fwa-sidebar-color] .${MARKER_CLASS}`) +
  sidebarStyleFor(`html[data-fwa-sidebar-color]:not(:has(.${MARKER_CLASS})) .v-navigation-drawer`);

/** Accepts #rgb / #rrggbb and returns a consistent lowercase #rrggbb value. */
export function normalizeSidebarColor(value: string): string | null {
  const color = value.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(color);
  if (short) {
    return `#${[...short[1]].map((digit) => digit + digit).join('')}`;
  }
  return /^#[0-9a-f]{6}$/.test(color) ? color : null;
}

export function mixHex(color: string, target: '#000000' | '#ffffff', targetWeight: number): string {
  const normalized = normalizeSidebarColor(color);
  if (!normalized) throw new Error(`Invalid hex color: ${color}`);
  const weight = Math.min(1, Math.max(0, targetWeight));
  const targetValue = target === '#ffffff' ? 255 : 0;
  const channels = [1, 3, 5].map((offset) => {
    const source = Number.parseInt(normalized.slice(offset, offset + 2), 16);
    return Math.round(source * (1 - weight) + targetValue * weight)
      .toString(16)
      .padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

export function defaultSidebarGradientEnd(color: string): string {
  return mixHex(color, '#000000', 0.18);
}

export function resolveSidebarGradientEnd(primary: string, secondary: string): string {
  const normalizedPrimary = normalizeSidebarColor(primary);
  if (!normalizedPrimary) throw new Error(`Invalid hex color: ${primary}`);
  return normalizeSidebarColor(secondary) ?? defaultSidebarGradientEnd(normalizedPrimary);
}

function relativeLuminance(color: string): number {
  const normalized = normalizeSidebarColor(color);
  if (!normalized) return 0;
  const linearChannels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linearChannels[0] + 0.7152 * linearChannels[1] + 0.0722 * linearChannels[2];
}

/** Picks a readable foreground using the WCAG relative-luminance formula. */
export function readableTextColor(color: string): '#172033' | '#ffffff' {
  return relativeLuminance(color) > 0.48 ? '#172033' : '#ffffff';
}

/** Chooses the foreground with the best worst-case contrast across both gradient ends. */
export function readableGradientTextColor(start: string, end: string): '#172033' | '#ffffff' {
  const backgrounds = [relativeLuminance(start), relativeLuminance(end)];
  const dark = relativeLuminance('#172033');
  const contrast = (a: number, b: number) => {
    const lighter = Math.max(a, b);
    const darker = Math.min(a, b);
    return (lighter + 0.05) / (darker + 0.05);
  };
  const darkMinimum = Math.min(...backgrounds.map((background) => contrast(background, dark)));
  const whiteMinimum = Math.min(...backgrounds.map((background) => contrast(background, 1)));
  return darkMinimum >= whiteMinimum ? '#172033' : '#ffffff';
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = SIDEBAR_STYLE;
  (document.head || document.documentElement).appendChild(style);
}

function findWikiSidebar(): HTMLElement | null {
  const exact = Array.from(document.querySelectorAll<HTMLElement>('.v-navigation-drawer'));
  const candidates = exact.length > 0 ? exact : Array.from(document.querySelectorAll<HTMLElement>('nav'));
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
  const isRtl = document.documentElement.dir === 'rtl';

  return (
    candidates.find((element) => {
      const rect = element.getBoundingClientRect();
      const nearEdge = isRtl ? rect.right >= window.innerWidth - 4 : rect.left <= 4;
      return nearEdge && rect.width >= 160 && rect.width <= 420 && rect.height >= viewportHeight * 0.55;
    }) ?? null
  );
}

/**
 * Applies the saved color to Wiki.js' own navigation drawer. The marker is
 * re-established after SPA DOM updates, while the scoped stylesheet prevents
 * the chosen color from leaking into article content or extension panels.
 */
export class SidebarAppearance {
  private observer: MutationObserver | null = null;
  private refreshVersion = 0;

  attach(): void {
    ensureStyle();
    this.applyCachedTheme();
    void this.refresh();
    // MutationObserver callbacks run before the browser paints the DOM
    // changes that triggered them. Mark the replacement drawer immediately;
    // deferring this to requestAnimationFrame lets Wiki.js' default blue
    // drawer flash for one frame during SPA navigation.
    this.observer = new MutationObserver(() => {
      if (!chrome.runtime?.id) {
        // Extension reloaded — stop this orphaned script's observer.
        this.observer?.disconnect();
        return;
      }
      if (!document.documentElement.hasAttribute('data-fwa-sidebar-color')) return;
      // This fires on every mutation batch (every keystroke while editing) and
      // updateMarker forces layout for each drawer candidate. A marked drawer
      // that is still in the DOM stays valid — Vue patches it in place — and
      // the stylesheet's :has() fallback colors any window without a marker.
      if (document.querySelector(`.${MARKER_CLASS}`)) return;
      this.updateMarker();
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  detach(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.clearMarkers();
  }

  async refresh(): Promise<void> {
    const version = ++this.refreshVersion;
    const settings = await getSettings();
    if (version !== this.refreshVersion) return;
    this.applyColor(settings.sidebarColor, settings.sidebarGradientColor);
  }

  /**
   * Re-applies the last theme from the synchronous localStorage cache so the
   * color is set before the first paint; refresh() then confirms it against
   * chrome.storage. Without this, the async settings read leaves Wiki.js'
   * default blue visible on every full page load.
   */
  private applyCachedTheme(): void {
    try {
      const raw = localStorage.getItem(THEME_CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as { color?: unknown; gradient?: unknown };
      if (typeof cached.color !== 'string') return;
      this.applyColor(cached.color, typeof cached.gradient === 'string' ? cached.gradient : '');
    } catch {
      /* corrupt or blocked cache — refresh() applies the real settings */
    }
  }

  private cacheTheme(color: string | null, gradientValue: string): void {
    try {
      if (color) {
        localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ color, gradient: gradientValue }));
      } else {
        localStorage.removeItem(THEME_CACHE_KEY);
      }
    } catch {
      /* localStorage unavailable — only costs the pre-paint fast path */
    }
  }

  private applyColor(value: string, gradientValue: string): void {
    const root = document.documentElement;
    const color = normalizeSidebarColor(value);
    this.cacheTheme(color, gradientValue);
    if (!color) {
      root.removeAttribute('data-fwa-sidebar-color');
      root.style.removeProperty('--fwa-sidebar-color');
      root.style.removeProperty('--fwa-sidebar-gradient');
      root.style.removeProperty('--fwa-sidebar-header-start');
      root.style.removeProperty('--fwa-sidebar-header-gradient');
      root.style.removeProperty('--fwa-sidebar-button');
      root.style.removeProperty('--fwa-sidebar-divider');
      root.style.removeProperty('--fwa-sidebar-text');
      this.clearMarkers();
      return;
    }

    const gradientEnd = resolveSidebarGradientEnd(color, gradientValue);
    const text = readableGradientTextColor(color, gradientEnd);
    const headerStart = mixHex(color, '#000000', 0.14);
    const headerEnd = mixHex(gradientEnd, '#000000', 0.14);
    root.setAttribute('data-fwa-sidebar-color', color);
    root.style.setProperty('--fwa-sidebar-color', color);
    root.style.setProperty(
      '--fwa-sidebar-gradient',
      `linear-gradient(155deg, ${color} 0%, ${gradientEnd} 100%)`,
    );
    root.style.setProperty('--fwa-sidebar-header-start', headerStart);
    root.style.setProperty(
      '--fwa-sidebar-header-gradient',
      `linear-gradient(115deg, ${headerStart} 0%, ${headerEnd} 100%)`,
    );
    root.style.setProperty('--fwa-sidebar-button', mixHex(color, text === '#ffffff' ? '#ffffff' : '#000000', 0.08));
    root.style.setProperty(
      '--fwa-sidebar-divider',
      mixHex(gradientEnd, text === '#ffffff' ? '#ffffff' : '#000000', 0.24),
    );
    root.style.setProperty('--fwa-sidebar-text', text);
    this.updateMarker();
  }

  private updateMarker(): void {
    const sidebar = findWikiSidebar();
    for (const marked of document.querySelectorAll(`.${MARKER_CLASS}`)) {
      if (marked !== sidebar) marked.classList.remove(MARKER_CLASS);
    }
    sidebar?.classList.add(MARKER_CLASS);
  }

  private clearMarkers(): void {
    for (const marked of document.querySelectorAll(`.${MARKER_CLASS}`)) {
      marked.classList.remove(MARKER_CLASS);
    }
  }
}

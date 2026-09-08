import { wikiConfig } from '../config/wiki-config';
import editorActionsCss from '../styles/editor-actions.css?inline';
import {
  createBranch,
  createCustomer,
  createCustomerFolder,
  customerBranchKey,
  deleteBranch,
  deleteCustomer,
  exportCustomers,
  importCustomers,
  listAllBranches,
  listCustomerFolders,
  listCustomers,
  moveBranch,
  normalizeBranchTarget,
  reorderCustomer,
  resolveBranchUrl,
  updateCustomer,
  updateBranch,
  viewPathForBranch,
} from '../customers/customer-service';
import { PetWidget } from '../pet/pet-widget';
import { sendMessage } from '../shared/messages';
import { getSettings, saveSettings, STORAGE_KEYS } from '../shared/storage';
import type { Customer, CustomerBranch, CustomerFolder } from '../shared/types';
import type { AiLayoutFeature } from './ai-layout';
import { openAssetReviewModal } from './asset-review';
import { readCurrentPageTitle } from './page-title';
import { openCurrentPageTopology } from './page-topology';
import {
  defaultSidebarGradientEnd,
  mixHex,
  normalizeSidebarColor,
  readableGradientTextColor,
  resolveSidebarGradientEnd,
  SIDEBAR_COLOR_PRESETS,
} from './sidebar-appearance';
import type { TemplatePanel } from './template-panel';
import { createShadowHost, el, openModal, showToast } from './ui';
import { icon } from './icons';

const TOP_CONTROLS_STYLE_ID = 'fwa-editor-actions-style';

function stopTopControlPointerEvent(event: Event): void {
  // Keep Wiki.js toolbar handlers from consuming the gesture first.
  event.stopPropagation();
}

function ensureTopControlsStyle(): void {
  if (document.getElementById(TOP_CONTROLS_STYLE_ID)) return;
  const styleParent = document.head ?? document.documentElement;
  if (!styleParent) {
    // The manifest runs the content script at document_start. On a very early
    // parser tick even <html> may not exist yet; retry once the DOM root is
    // available instead of aborting MainNav (and all later content features).
    document.addEventListener('DOMContentLoaded', ensureTopControlsStyle, { once: true });
    return;
  }
  const style = document.createElement('style');
  style.id = TOP_CONTROLS_STYLE_ID;
  style.textContent = editorActionsCss;
  styleParent.appendChild(style);
}

function isDarkHeaderBackground(backgroundColor: string): boolean {
  const match = backgroundColor.match(/rgba?\(([^)]+)\)/i);
  if (!match) return false;

  const channels = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  if (channels.length < 3 || channels.slice(0, 3).some((channel) => !Number.isFinite(channel))) {
    return false;
  }

  const alpha = channels[3] ?? 1;
  if (!Number.isFinite(alpha) || alpha < 0.25) return false;

  const [red, green, blue] = channels;
  const luminance = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
  return luminance < 0.45;
}

interface TopHeaderMount {
  title: HTMLElement | null;
  host: HTMLElement;
}

interface WorkspaceAction {
  name: string;
  description: string;
  keywords: string;
  group: '瀏覽與整理' | '文章編輯' | '偏好設定';
  symbol: Parameters<typeof icon>[0];
  available: boolean;
  run: () => void;
}

interface DirectoryMenuAction {
  label: string;
  symbol?: Parameters<typeof icon>[0];
  destructive?: boolean;
  disabled?: boolean;
  run: () => void;
}

/** Whitespace-separated queries match every term, regardless of case. */
export function matchesWorkspaceQuery(query: string, ...fields: string[]): boolean {
  const text = fields.join(' ').normalize('NFKC').toLocaleLowerCase();
  return query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).every((term) => text.includes(term));
}

/** Keep a floating directory inside the usable viewport, beside its Pet. */
export function customerPanelPosition(anchor: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'> | null, viewport: { width: number; height: number }, headerBottom: number): { left: number; top: number; width: number; height: number } {
  const margin = 12;
  const gap = 12;
  const width = Math.min(436, Math.max(0, viewport.width - margin * 2));
  const safeTop = Math.min(Math.max(margin, headerBottom + gap), Math.max(margin, viewport.height - 120));
  const height = Math.min(550, Math.max(0, viewport.height - safeTop - margin));
  let left = viewport.width - width - margin;
  let top = safeTop;
  if (anchor) {
    if (anchor.left - gap - width >= margin) {
      left = anchor.left - gap - width;
      top = anchor.bottom - height;
    } else if (anchor.right + gap + width <= viewport.width - margin) {
      left = anchor.right + gap;
      top = anchor.bottom - height;
    } else {
      left = anchor.left;
      top = anchor.top - gap - height;
    }
  }
  return {
    left: Math.max(margin, Math.min(left, viewport.width - width - margin)),
    top: Math.max(safeTop, Math.min(top, viewport.height - height - margin)),
    width, height,
  };
}

export class MainNav {
  private readonly pet = new PetWidget();
  private petVisible = true;
  private petVisibilityVersion = 0;
  private removePetPositionListener: (() => void) | null = null;
  private attached = false;
  private templatePanel: TemplatePanel | null = null;
  private aiLayout: AiLayoutFeature | null = null;
  private customerPanel: HTMLElement | null = null;
  private customerPanelHost: HTMLElement | null = null;
  private customerListEl: HTMLElement | null = null;
  private customerSearch = '';
  private customerReturnFocus: HTMLElement | null = null;
  private customerCountEl: HTMLElement | null = null;
  private customerRenderVersion = 0;
  private directoryMenu: { element: HTMLElement; trigger: HTMLButtonElement } | null = null;
  private workspaceHost: HTMLElement | null = null;
  private workspaceSearch: HTMLInputElement | null = null;
  private workspaceResults: HTMLElement | null = null;
  private workspaceControl: HTMLButtonElement | null = null;
  private workspaceReturnFocus: HTMLElement | null = null;
  private topologyControl: HTMLButtonElement | null = null;
  private assetReviewControl: HTMLButtonElement | null = null;
  private sidebarColorControl: HTMLButtonElement | null = null;
  private settingsControl: HTMLButtonElement | null = null;
  private editorActions: HTMLElement | null = null;
  private topControlsObserver: MutationObserver | null = null;
  private topControlsScheduled = false;
  private topControlsHost: HTMLElement | null = null;
  private topControlsResizeObserver: ResizeObserver | null = null;
  private onWindowResize: (() => void) | null = null;
  private assetReviewOpening = false;
  private draggingCustomerId: string | null = null;
  /**
   * Which customers are currently expanded, by branch key. Kept in memory
   * only: the drawer closes on navigation anyway, so persisting this would
   * just re-open branch lists the user has already moved on from.
   */
  private readonly expandedCustomers = new Set<string>();
  private readonly dismissCustomerPanelOnPointerDown = (event: PointerEvent): void => {
    if (!this.customerPanel) return;
    const path = event.composedPath();
    if (this.directoryMenu && !path.includes(this.directoryMenu.element) && !path.includes(this.directoryMenu.trigger)) {
      this.closeDirectoryMenu(false);
    }
    const clickedInsidePanel = this.customerPanelHost !== null && path.includes(this.customerPanelHost);
    const clickedPet = path.some(
      (node) => node instanceof HTMLElement && node.id === 'fwa-pet-host',
    );
    // Customer and branch forms use the shared modal host. They are launched
    // from this popover, so interacting with one must not dismiss its source.
    const clickedCustomerForm = path.some(
      (node) => node instanceof HTMLElement && node.id === 'fwa-modal-host',
    );
    // Also check the live host itself. Depending on where the pointer starts,
    // a Shadow DOM host is not always present in every composedPath variant.
    const customerFormOpen = Boolean(
      document.getElementById('fwa-modal-host')?.shadowRoot?.querySelector('.fwa-modal'),
    );
    if (!clickedInsidePanel && !clickedPet && !clickedCustomerForm && !customerFormOpen) {
      this.closeCustomerDrawer();
    }
  };
  private readonly dismissCustomerPanelOnEscape = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    const modalOpen = Array.from(document.querySelectorAll('[id^="fwa-"]')).some((host) => host.shadowRoot?.querySelector('.fwa-modal'));
    if (event.key === 'Escape' && !modalOpen) {
      if (this.directoryMenu) {
        event.preventDefault();
        event.stopPropagation();
        this.closeDirectoryMenu();
        return;
      }
      this.closeCustomerDrawer();
    }
  };
  private readonly onWorkspaceShortcut = (event: KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.openWorkspace();
    }
  };
  private readonly onSettingsChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    const change = changes[STORAGE_KEYS.settings];
    if (area === 'local' && change && change.oldValue?.showPet !== change.newValue?.showPet) void this.refreshPetVisibility();
  };

  attach(): void {
    if (this.attached) return;
    if (!document.documentElement) {
      // Keep the document_start entry point safe on the earliest parser tick.
      // index.ts will otherwise continue into independent features before a
      // root exists, so retry the complete navigation attach here only after
      // the DOM can accept a host and MutationObserver target.
      document.addEventListener('DOMContentLoaded', () => this.attach(), { once: true });
      return;
    }
    this.attached = true;
    this.pet.setVisible(false);
    this.pet.attach(() => this.onCustomersClick());
    this.removePetPositionListener = this.pet.onPositionChange(() => this.updateCustomerDrawerInset());
    chrome.storage.onChanged.addListener(this.onSettingsChanged);
    void this.refreshPetVisibility();
    document.addEventListener('keydown', this.onWorkspaceShortcut);
    ensureTopControlsStyle();
    this.mountTopControls();
    this.onWindowResize = () => {
      this.scheduleTopControlsMount();
      this.fitTopControls();
      this.updateCustomerDrawerInset();
    };
    window.addEventListener('resize', this.onWindowResize);
    this.topControlsObserver = new MutationObserver(() => {
      if (!chrome.runtime?.id) {
        // Extension reloaded/updated — release this orphaned script's
        // document-wide observer and resize listener.
        this.topControlsObserver?.disconnect();
        this.topControlsResizeObserver?.disconnect();
        document.removeEventListener('keydown', this.onWorkspaceShortcut);
        if (this.onWindowResize) window.removeEventListener('resize', this.onWindowResize);
        chrome.storage.onChanged.removeListener(this.onSettingsChanged);
        this.removePetPositionListener?.();
        this.pet.detach();
        return;
      }
      this.scheduleTopControlsMount();
    });
    this.topControlsObserver.observe(document.documentElement, { childList: true, subtree: true });
    void this.restoreExpandedState();
  }

  async refreshPetVisibility(): Promise<void> {
    const version = ++this.petVisibilityVersion;
    try {
      const settings = await getSettings();
      if (version !== this.petVisibilityVersion || !this.attached) return;
      this.petVisible = settings.showPet;
      this.pet.setVisible(this.petVisible);
      this.renderWorkspaceActions();
    } catch (error) {
      this.reportTopControlError('Pet 顯示設定', error);
    }
  }

  private async togglePetVisibility(): Promise<void> {
    try {
      const settings = await getSettings();
      await saveSettings({ ...settings, showPet: !settings.showPet });
      await this.refreshPetVisibility();
      showToast(this.petVisible ? 'Pet 已顯示，點擊即可開啟客戶目錄' : 'Pet 已隱藏，可從工作台或設定再次顯示', 'info');
    } catch (error) {
      this.reportTopControlError('Pet 顯示設定', error);
    }
  }

  detach(): void {
    this.attached = false;
    this.petVisibilityVersion++;
    this.closeWorkspace(false);
    this.closeCustomerDrawer();
    this.topControlsObserver?.disconnect();
    this.topControlsObserver = null;
    this.topControlsResizeObserver?.disconnect();
    this.topControlsResizeObserver = null;
    document.removeEventListener('keydown', this.onWorkspaceShortcut);
    chrome.storage.onChanged.removeListener(this.onSettingsChanged);
    if (this.onWindowResize) window.removeEventListener('resize', this.onWindowResize);
    this.onWindowResize = null;
    this.removePetPositionListener?.();
    this.removePetPositionListener = null;
    this.pet.detach();
  }

  private scheduleTopControlsMount(): void {
    if (this.topControlsScheduled) return;
    this.topControlsScheduled = true;
    window.requestAnimationFrame(() => {
      this.topControlsScheduled = false;
      if (!this.attached) return;
      this.mountTopControls();
    });
  }

  private mountTopControls(): void {
    // Fast path: this runs on every mutation burst (every keystroke while
    // editing). When the host row and all top-bar controls are still in place
    // there is nothing to re-discover — findTopHeader forces style+layout
    // recalculation for every header candidate on the page.
    const mounted = this.topControlsHost;
    if (
      mounted?.isConnected &&
      this.workspaceControl?.parentElement === mounted &&
      this.assetReviewControl?.parentElement === mounted &&
      this.sidebarColorControl?.parentElement === mounted &&
      this.topologyControl?.parentElement === mounted &&
      this.settingsControl?.parentElement === mounted
    ) {
      this.mountEditorActions();
      return;
    }

    const header = this.findTopHeader();
    if (header) {
      // One header discovery + one mount resolution per pass; the previous
      // per-control lookups tripled the forced-layout cost.
      const mount = this.getTopHeaderMount(header);
      this.mountSidebarColorControl(mount);
      this.mountTopologyControl(mount);
      this.mountSettingsControl(mount);
      // The workspace is the first shortcut after Wiki.js' site title.
      this.mountAssetReviewControl(mount);
      this.mountWorkspaceControl(mount);
    }
    this.mountEditorActions();
    this.fitTopControls();
  }

  /** Nested Wiki title columns can be narrow even on a wide viewport. */
  private fitTopControls(): void {
    const host = this.topControlsHost;
    const parent = host?.parentElement;
    if (!host || !parent) return;
    host.classList.remove('is-compact', 'is-minimal', 'is-icon-only');
    const fits = (): boolean => {
      const next = host.nextElementSibling;
      const boundary = Math.min(parent.getBoundingClientRect().right,
        next instanceof HTMLElement && next.getBoundingClientRect().width > 0
          ? next.getBoundingClientRect().left : Infinity);
      return host.getBoundingClientRect().right + 5 <= boundary;
    };
    for (const mode of ['is-compact', 'is-minimal', 'is-icon-only']) {
      if (fits()) break;
      host.classList.add(mode);
    }
  }

  private mountWorkspaceControl({ host }: TopHeaderMount): void {
    if (!this.workspaceControl) {
      const button = el('button', {
        type: 'button', class: 'fwa-header-workspace', title: '開啟工作台 · Ctrl / ⌘ + Shift + K',
        'aria-label': '開啟 Wiki 工作台', 'aria-haspopup': 'dialog',
      }, [icon('grid', 16), el('span', { text: '工作台' })]);
      button.addEventListener('pointerdown', stopTopControlPointerEvent);
      button.addEventListener('mousedown', stopTopControlPointerEvent);
      button.addEventListener('click', (event) => { event.stopPropagation(); this.openWorkspace(); });
      this.workspaceControl = button;
    }
    this.placeAtStart(host, this.workspaceControl);
  }

  private mountAssetReviewControl({ host }: TopHeaderMount): void {
    const button = this.assetReviewControl ?? document.createElement('button');
    if (!this.assetReviewControl) {
      button.type = 'button';
      button.className = 'fwa-header-asset-review';
      button.append(icon('image', 16), el('span', { class: 'fwa-header-control-label', text: '照片' }));
      button.title = '檢閱目前文章資料夾內的照片';
      button.setAttribute('aria-label', '檢閱目前文章資料夾內的照片');
      button.addEventListener('pointerdown', stopTopControlPointerEvent);
      button.addEventListener('mousedown', stopTopControlPointerEvent);
      button.addEventListener('click', (event) => {
        stopTopControlPointerEvent(event);
        void this.openAssetReview();
      });
      this.assetReviewControl = button;
    }

    this.placeAtStart(host, button);
  }

  private async openAssetReview(): Promise<void> {
    if (this.assetReviewOpening) return;
    this.assetReviewOpening = true;
    const button = this.assetReviewControl;
    if (button) button.disabled = true;
    try {
      await openAssetReviewModal();
    } catch (error) {
      this.reportTopControlError('檢閱照片', error);
    } finally {
      this.assetReviewOpening = false;
      if (button?.isConnected) button.disabled = false;
    }
  }

  private mountTopologyControl({ host }: TopHeaderMount): void {
    const button = this.topologyControl ?? document.createElement('button');
    if (!this.topologyControl) {
      button.type = 'button';
      button.className = 'fwa-header-topology';
      button.append(icon('network', 16), el('span', { class: 'fwa-header-control-label', text: '拓譜' }));
      button.title = '頁面拓譜圖';
      button.setAttribute('aria-label', '頁面拓譜圖');
      button.addEventListener('pointerdown', stopTopControlPointerEvent);
      button.addEventListener('mousedown', stopTopControlPointerEvent);
      button.addEventListener('click', (event) => {
        // Wiki.js attaches click handlers to the surrounding toolbar as well.
        // Keep this control from being reinterpreted as a native toolbar click.
        stopTopControlPointerEvent(event);
        try {
          openCurrentPageTopology();
        } catch (error) {
          this.reportTopControlError('頁面拓譜圖', error);
        }
      });
      this.topologyControl = button;
    }

    this.placeAfter(host, button, this.sidebarColorControl);
  }

  private findTopHeader(): HTMLElement | null {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        'header.nav-header, .v-app-bar, header, [role="banner"], .v-toolbar',
      ),
    )
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const className = String(element.className);
        let score = 0;

        if (element.matches('header.nav-header, .v-app-bar')) score += 100;
        if (isDarkHeaderBackground(style.backgroundColor) || /\b(?:black|theme--dark)\b/i.test(className)) {
          score += 80;
        }
        if (style.position === 'fixed' || style.position === 'sticky') score += 25;
        if (element.querySelector('.v-toolbar__content')) score += 15;
        if (element.querySelector('.v-toolbar__title, .toolbar-title')) score += 15;
        if (element.querySelector('input, [aria-label*="search" i]')) score += 10;
        if (/breadcrumb|subheader|page-header|toolbar--dense|grey lighten/i.test(className)) score -= 80;

        score -= Math.max(0, rect.top);
        return { element, rect, score };
      })
      .filter(({ rect }) => {
        return (
          rect.top <= 8 &&
          rect.bottom >= 32 &&
          rect.height >= 32 &&
          rect.height <= 128 &&
          rect.width >= viewportWidth * 0.5
        );
      })
      .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top || b.rect.width - a.rect.width);

    return candidates[0]?.element ?? null;
  }

  private getTopHeaderMount(header: HTMLElement): TopHeaderMount {
    // Wiki.js renders the site title inside a nested .v-toolbar__content.
    // Do not use a generic <a> fallback here: on an early SPA render that can
    // be a breadcrumb link from the light page toolbar instead of the title.
    const title = header.querySelector<HTMLElement>('.v-toolbar__title, .toolbar-title, h1');
    const toolbarContent =
      Array.from(header.children).find(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && child.classList.contains('v-toolbar__content'),
      ) ?? header;
    const mountParent = title?.parentElement ?? toolbarContent;
    const host = this.ensureTopControlsHost(mountParent, title);
    host.classList.toggle('is-dark', isDarkHeaderBackground(window.getComputedStyle(header).backgroundColor) || header.classList.contains('theme--dark'));
    if (title) title.classList.add('fwa-header-title');
    return { title, host };
  }

  /**
   * Mount the controls in the same flex row as Wiki.js' title. This lets the
   * title shrink with an ellipsis when the viewport is narrow, instead of
   * putting a fixed overlay on top of the search column.
   */
  private ensureTopControlsHost(parent: HTMLElement, title: HTMLElement | null): HTMLElement {
    const host = this.topControlsHost ?? document.createElement('div');
    if (!this.topControlsHost) {
      host.className = 'fwa-header-controls-host';
      host.setAttribute('aria-label', 'Wiki 工具');
      for (const control of [this.sidebarColorControl, this.topologyControl, this.settingsControl]) {
        if (control) host.appendChild(control);
      }
      this.topControlsHost = host;
    }

    if (host.parentElement !== parent) {
      const afterTitle = title?.parentElement === parent ? title.nextSibling : null;
      parent.insertBefore(host, afterTitle);
      this.topControlsResizeObserver?.disconnect();
      this.topControlsResizeObserver = new ResizeObserver(() => this.fitTopControls());
      this.topControlsResizeObserver.observe(parent);
    } else if (title?.parentElement === parent && host.previousElementSibling !== title) {
      parent.insertBefore(host, title.nextSibling);
    }
    return host;
  }

  private placeAfter(host: HTMLElement, node: HTMLElement, reference: HTMLElement | null): void {
    const anchor = reference?.parentElement === host ? reference : null;
    if (!anchor) {
      if (node.parentElement !== host) host.appendChild(node);
      return;
    }

    if (node.parentElement === host && node.previousElementSibling === anchor) return;
    host.insertBefore(node, anchor.nextSibling);
  }

  private placeAtStart(host: HTMLElement, node: HTMLElement): void {
    if (node.parentElement === host && node === host.firstElementChild) return;
    host.insertBefore(node, host.firstElementChild);
  }

  private mountSidebarColorControl({ host }: TopHeaderMount): void {
    const button = this.sidebarColorControl ?? document.createElement('button');
    if (!this.sidebarColorControl) {
      button.type = 'button';
      button.className = 'fwa-header-color-swatch';
      button.append(el('span', { class: 'fwa-header-color-chip', 'aria-hidden': 'true' }));
      button.title = '調整左側導覽列顏色';
      button.setAttribute('aria-label', '調整左側導覽列顏色');
      button.addEventListener('pointerdown', stopTopControlPointerEvent);
      button.addEventListener('mousedown', stopTopControlPointerEvent);
      button.addEventListener('click', (event) => {
        stopTopControlPointerEvent(event);
        void this.openSidebarColorModal().catch((error: unknown) => {
          this.reportTopControlError('左側顏色設定', error);
        });
      });
      this.sidebarColorControl = button;
      // Painting the swatch reads chrome.storage; do it when the button is
      // created and on settings changes (index.ts calls the refresh hook),
      // not on every mutation-triggered mount pass.
      void this.refreshSidebarColorControl();
    }

    this.placeAtStart(host, button);
  }

  private mountSettingsControl({ title, host }: TopHeaderMount): void {
    const button = this.settingsControl ?? document.createElement('button');
    if (!this.settingsControl) {
      button.type = 'button';
      button.className = 'fwa-header-settings';
      button.append(icon('settings', 16));
      button.title = '開啟 Wiki 設定';
      button.setAttribute('aria-label', '開啟 Wiki 設定');
      button.addEventListener('pointerdown', stopTopControlPointerEvent);
      button.addEventListener('mousedown', stopTopControlPointerEvent);
      button.addEventListener('click', (event) => {
        stopTopControlPointerEvent(event);
        void this.openSettingsPage();
      });
      this.settingsControl = button;
    }

    const anchor =
      (this.topologyControl?.parentElement === host ? this.topologyControl : null) ??
      (this.sidebarColorControl?.parentElement === host ? this.sidebarColorControl : null) ??
      title;
    this.placeAfter(host, button, anchor);
  }

  private async openSettingsPage(): Promise<void> {
    try {
      const response = (await sendMessage({ type: 'fwa:open-settings' })) as
        | { ok?: boolean; error?: string }
        | undefined;
      if (response?.ok === false) {
        throw new Error(response.error || '設定頁無法開啟');
      }
    } catch (error) {
      this.reportTopControlError('設定頁', error);
    }
  }

  /** Repaints the header swatch from saved settings. Also called from
   * index.ts whenever the settings storage key changes. */
  async refreshSidebarColorControl(): Promise<void> {
    const button = this.sidebarColorControl;
    if (!button?.isConnected) return;
    const settings = await getSettings();
    const primary = normalizeSidebarColor(settings.sidebarColor) ?? '#1976d2';
    const secondary = resolveSidebarGradientEnd(primary, settings.sidebarGradientColor);
    button.style.setProperty('--fwa-color-start', primary);
    button.style.setProperty('--fwa-color-end', secondary);
    const colorDescription = primary === secondary ? primary : `${primary} → ${secondary}`;
    button.title = `調整左側導覽列顏色（${colorDescription}）`;
    button.setAttribute('aria-label', `調整左側導覽列顏色，目前為 ${colorDescription}`);
  }

  private reportTopControlError(label: string, error: unknown): void {
    console.error(`[FWA] ${label}開啟失敗`, error instanceof Error ? error.message : error);
    showToast(`${label}暫時無法開啟，請重新整理頁面後再試。`, 'error');
  }

  private mountEditorActions(): void {
    const shouldShow = this.templatePanel !== null && this.aiLayout !== null;
    if (!shouldShow) {
      this.editorActions?.remove();
      this.editorActions = null;
      return;
    }
    if (this.editorActions?.isConnected) return;

    const saveIcon = document.querySelector<HTMLElement>(wikiConfig.editor.saveButtonIconSelector);
    const saveButton = saveIcon?.closest<HTMLButtonElement>('button') ?? null;
    const host = saveButton?.parentElement ?? null;
    if (!saveButton || !host) return;

    const actions = document.createElement('div');
    actions.className = 'fwa-editor-actions';
    const header = host.closest<HTMLElement>('header, .v-toolbar, [role="banner"]');
    actions.classList.toggle('is-dark', Boolean(header && (isDarkHeaderBackground(window.getComputedStyle(header).backgroundColor) || header.classList.contains('theme--dark'))));
    for (const [label, title, symbol, onClick] of [
      ['模板', '開啟文章模板', 'template', () => this.onTemplatesClick()],
      ['AI 排版', '開啟 AI 排版選項', 'sparkles', () => this.onAiLayoutClick()],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fwa-editor-action';
      button.append(icon(symbol, 16), el('span', { text: label }));
      button.title = title;
      button.setAttribute('aria-label', title);
      button.addEventListener('click', onClick);
      actions.appendChild(button);
    }

    const modeToolbar = host.querySelector<HTMLElement>('.fwa-mode-toolbar');
    host.insertBefore(actions, modeToolbar ?? saveButton);
    this.editorActions = actions;
  }

  private async openSidebarColorModal(): Promise<void> {
    const settings = await getSettings();
    const modal = openModal('調整 Wiki 左側顏色', 'fwa-sidebar-color-modal-host');
    const presetRow = el('div', { class: 'fwa-sidebar-color-grid', 'aria-label': '常用顏色' });
    const preview = el('div', { class: 'fwa-sidebar-color-preview' }, [
      el('div', { class: 'fwa-sidebar-color-preview-head', text: '⌂　Browse' }),
      el('div', { class: 'fwa-sidebar-color-preview-item active', text: '▣　Home' }),
      el('div', { class: 'fwa-sidebar-color-preview-item', text: '▣　Engineering' }),
      el('div', { class: 'fwa-sidebar-color-preview-item', text: '▣　Customers' }),
    ]);
    const primaryPicker = el('input', {
      class: 'fwa-sidebar-color-picker',
      type: 'color',
      'aria-label': '選擇左側導覽列主色',
    });
    const primaryHex = el('input', {
      class: 'fwa-hex-input fwa-sidebar-color-hex',
      type: 'text',
      placeholder: '#1976d2',
      'aria-label': '左側導覽列主色 HEX',
    });
    const secondaryPicker = el('input', {
      class: 'fwa-sidebar-color-picker',
      type: 'color',
      'aria-label': '選擇左側導覽列漸層色',
    });
    const secondaryHex = el('input', {
      class: 'fwa-hex-input fwa-sidebar-color-hex',
      type: 'text',
      placeholder: '#1561ac',
      'aria-label': '左側導覽列漸層色 HEX',
    });
    const status = el('span', { class: 'fwa-sidebar-color-status' });
    let saveTimer: number | undefined;

    const render = () => {
      const primary = normalizeSidebarColor(settings.sidebarColor) ?? '#1976d2';
      const secondary = resolveSidebarGradientEnd(primary, settings.sidebarGradientColor);
      const text = readableGradientTextColor(primary, secondary);
      const headerStart = mixHex(primary, '#000000', 0.14);
      const headerEnd = mixHex(secondary, '#000000', 0.14);
      primaryPicker.value = primary;
      primaryHex.value = settings.sidebarColor;
      secondaryPicker.value = secondary;
      secondaryHex.value = settings.sidebarGradientColor || secondary;
      preview.style.setProperty(
        '--fwa-preview-gradient',
        `linear-gradient(155deg, ${primary} 0%, ${secondary} 100%)`,
      );
      preview.style.setProperty(
        '--fwa-preview-header-gradient',
        `linear-gradient(115deg, ${headerStart} 0%, ${headerEnd} 100%)`,
      );
      preview.style.setProperty(
        '--fwa-preview-button',
        mixHex(primary, text === '#ffffff' ? '#ffffff' : '#000000', 0.08),
      );
      preview.style.setProperty('--fwa-preview-text', text);
      for (const swatch of presetRow.querySelectorAll<HTMLElement>('.fwa-sidebar-color-swatch')) {
        swatch.classList.toggle('active', swatch.dataset.color === normalizeSidebarColor(settings.sidebarColor));
      }
    };
    const scheduleSave = () => {
      window.clearTimeout(saveTimer);
      status.textContent = '套用中…';
      saveTimer = window.setTimeout(async () => {
        const latest = await getSettings();
        latest.sidebarColor = settings.sidebarColor;
        latest.sidebarGradientColor = settings.sidebarGradientColor;
        await saveSettings(latest);
        status.textContent = '已套用';
        void this.refreshSidebarColorControl();
      }, 100);
    };
    const setPrimaryColor = (value: string) => {
      const color = normalizeSidebarColor(value);
      if (!color) return;
      const previous = normalizeSidebarColor(settings.sidebarColor);
      const currentSecondary = normalizeSidebarColor(settings.sidebarGradientColor);
      const secondaryWasAutomatic =
        !currentSecondary || (previous ? currentSecondary === defaultSidebarGradientEnd(previous) : true);
      settings.sidebarColor = color;
      if (secondaryWasAutomatic) settings.sidebarGradientColor = defaultSidebarGradientEnd(color);
      render();
      scheduleSave();
    };
    const setSecondaryColor = (value: string) => {
      const color = normalizeSidebarColor(value);
      if (!color) return;
      settings.sidebarGradientColor = color;
      render();
      scheduleSave();
    };

    for (const color of SIDEBAR_COLOR_PRESETS) {
      const gradientEnd = defaultSidebarGradientEnd(color);
      const swatch = el('button', {
        class: 'fwa-sidebar-color-swatch',
        type: 'button',
        title: `${color} → ${gradientEnd}`,
        'aria-label': `套用 ${color} 漸層`,
      });
      swatch.dataset.color = color;
      swatch.style.setProperty('--fwa-swatch-color', color);
      swatch.style.setProperty('--fwa-swatch-gradient-color', gradientEnd);
      swatch.addEventListener('click', () => {
        settings.sidebarColor = color;
        settings.sidebarGradientColor = gradientEnd;
        render();
        scheduleSave();
      });
      presetRow.appendChild(swatch);
    }
    primaryPicker.addEventListener('input', () => setPrimaryColor(primaryPicker.value));
    primaryHex.addEventListener('input', () => {
      const color = normalizeSidebarColor(primaryHex.value);
      if (color) setPrimaryColor(color);
    });
    primaryHex.addEventListener('change', () => {
      if (!normalizeSidebarColor(primaryHex.value)) {
        status.textContent = '主色請輸入 #RGB 或 #RRGGBB';
        render();
      }
    });
    secondaryPicker.addEventListener('input', () => setSecondaryColor(secondaryPicker.value));
    secondaryHex.addEventListener('input', () => {
      const color = normalizeSidebarColor(secondaryHex.value);
      if (color) setSecondaryColor(color);
    });
    secondaryHex.addEventListener('change', () => {
      if (!normalizeSidebarColor(secondaryHex.value)) {
        status.textContent = '請輸入 #RGB 或 #RRGGBB';
        render();
      }
    });

    modal.body.append(
      el('div', { class: 'fwa-sidebar-color-layout' }, [
        el('div', {}, [
          el('div', { class: 'fwa-modal-section-title', text: '常用顏色' }),
          presetRow,
          el('div', { class: 'fwa-sidebar-gradient-controls' }, [
            el('label', { class: 'fwa-sidebar-color-field' }, [
              el('span', { text: '主色' }),
              el('span', { class: 'fwa-sidebar-color-controls' }, [primaryPicker, primaryHex]),
            ]),
            el('label', { class: 'fwa-sidebar-color-field' }, [
              el('span', { text: '漸層色' }),
              el('span', { class: 'fwa-sidebar-color-controls' }, [secondaryPicker, secondaryHex]),
            ]),
            status,
          ]),
          el('div', {
            class: 'fwa-hint',
            text: '兩端顏色會立即儲存；文字會依整段漸層自動選擇清楚的顏色。',
          }),
        ]),
        preview,
      ]),
    );

    const reset = el('button', { class: 'fwa-btn', text: '恢復 Wiki 原始顏色' });
    reset.addEventListener('click', () => {
      settings.sidebarColor = '';
      settings.sidebarGradientColor = '';
      render();
      scheduleSave();
    });
    const close = el('button', { class: 'fwa-btn fwa-btn-primary', text: '完成' });
    close.addEventListener('click', () => modal.close());
    modal.footer.append(reset, close);
    render();
  }

  /** Registered by index.ts whenever an editor mounts/unmounts; null while browsing (no editor on the page). */
  setTemplatePanel(panel: TemplatePanel | null): void {
    this.templatePanel = panel;
    this.mountEditorActions();
    this.renderWorkspaceActions();
  }

  /** Registered by index.ts whenever an editor mounts/unmounts; null while browsing (no editor on the page). */
  setAiLayout(feature: AiLayoutFeature | null): void {
    this.aiLayout = feature;
    this.mountEditorActions();
    this.renderWorkspaceActions();
  }

  private workspaceActions(): WorkspaceAction[] {
    return [
      { name: '客戶目錄', description: '客戶、分支與收藏頁面', keywords: 'customers directory folders bookmarks 書籤 資料夾', group: '瀏覽與整理', symbol: 'folder', available: true, run: () => this.onCustomersClick() },
      { name: '圖片資料庫', description: '檢閱這篇文章的照片與圖片', keywords: 'images assets gallery photos 檢閱照片 圖片', group: '瀏覽與整理', symbol: 'image', available: true, run: () => { void this.openAssetReview(); } },
      { name: '頁面拓譜', description: '檢視文章的連結關係', keywords: 'network topology graph 拓譜圖', group: '瀏覽與整理', symbol: 'network', available: true, run: () => { try { openCurrentPageTopology(); } catch (error) { this.reportTopControlError('頁面拓譜圖', error); } } },
      { name: '文章模板', description: this.templatePanel ? '選擇模板並插入文章' : '進入文章編輯頁後即可使用', keywords: 'templates 編輯 範本', group: '文章編輯', symbol: 'template', available: this.templatePanel !== null, run: () => this.onTemplatesClick() },
      { name: 'AI 排版', description: this.aiLayout ? '整理文章結構，先檢閱再套用' : '進入文章編輯頁後即可使用', keywords: 'ai layout format 人工智慧 格式', group: '文章編輯', symbol: 'sparkles', available: this.aiLayout !== null, run: () => this.onAiLayoutClick() },
      { name: '側欄外觀', description: '調整 Wiki 導覽列的顏色', keywords: 'sidebar appearance color palette 顏色', group: '偏好設定', symbol: 'palette', available: true, run: () => { void this.openSidebarColorModal().catch((error: unknown) => this.reportTopControlError('側欄外觀', error)); } },
      { name: this.petVisible ? '隱藏 Pet' : '顯示 Pet', description: this.petVisible ? '隱藏浮動寵物，保留工作台入口' : '顯示浮動寵物，點擊開啟客戶目錄', keywords: 'pet mascot 寵物 顯示 隱藏 客戶', group: '偏好設定', symbol: 'grid', available: true, run: () => { void this.togglePetVisibility(); } },
      { name: '設定', description: '管理 AI 服務、編輯偏好與資料', keywords: 'settings preferences provider', group: '偏好設定', symbol: 'settings', available: true, run: () => { void this.openSettingsPage(); } },
    ];
  }

  private openWorkspace(): void {
    // An existing form or review owns the keyboard until it closes.
    if (Array.from(document.querySelectorAll('[id^="fwa-"]')).some((host) => host.shadowRoot?.querySelector('.fwa-modal'))) return;
    if (this.workspaceHost) {
      this.workspaceSearch?.focus();
      this.workspaceSearch?.select();
      return;
    }
    this.closeCustomerDrawer();
    this.templatePanel?.close();
    const active = document.activeElement;
    this.workspaceReturnFocus = (active?.shadowRoot?.activeElement ?? active) instanceof HTMLElement
      ? (active?.shadowRoot?.activeElement ?? active) as HTMLElement : null;
    const { host, root } = createShadowHost('fwa-workspace-host');
    this.workspaceHost = host;
    const close = el('button', { type: 'button', class: 'fwa-workspace-close', title: '關閉工作台 · Esc', 'aria-label': '關閉工作台' }, [icon('close', 18)]);
    close.addEventListener('click', () => this.closeWorkspace());
    this.workspaceSearch = el('input', { type: 'search', placeholder: '搜尋工具與功能…', 'aria-label': '搜尋工作台工具', autocomplete: 'off', 'aria-controls': 'fwa-workspace-results' });
    this.workspaceSearch.addEventListener('input', () => this.renderWorkspaceActions());
    this.workspaceResults = el('div', { class: 'fwa-workspace-results', id: 'fwa-workspace-results' });
    const panel = el('section', { class: 'fwa-workspace', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fwa-workspace-title' }, [
      el('header', { class: 'fwa-workspace-header' }, [
        el('h2', { id: 'fwa-workspace-title', text: '工作台' }), close,
      ]),
      el('div', { class: 'fwa-workspace-search' }, [icon('search', 20), this.workspaceSearch, el('kbd', { text: 'ESC' })]),
      this.workspaceResults,
      el('footer', { class: 'fwa-workspace-footer' }, [el('span', { text: '↑ ↓ 選擇 · Enter 開啟' }), el('span', { text: 'Ctrl / ⌘ + Shift + K' })]),
    ]);
    const backdrop = el('div', { class: 'fwa-workspace-backdrop' }, [panel]);
    backdrop.addEventListener('pointerdown', (event) => { if (event.target === backdrop) this.closeWorkspace(); });
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); this.closeWorkspace(); return;
      }
      const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>('.fwa-workspace-action:not(:disabled)'));
      const focused = root.activeElement;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const index = buttons.findIndex((button) => button === focused);
        const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index <= 0 ? buttons.length - 1 : index - 1);
        buttons[next]?.focus();
      } else if (event.key === 'Enter' && focused === this.workspaceSearch) {
        event.preventDefault(); buttons[0]?.click();
      } else if (event.key === 'Tab') {
        const focusables = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), input'));
        const first = focusables[0]; const last = focusables.at(-1);
        if (event.shiftKey && focused === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && focused === last) { event.preventDefault(); first?.focus(); }
      }
    });
    root.appendChild(backdrop);
    this.workspaceControl?.setAttribute('aria-expanded', 'true');
    this.renderWorkspaceActions();
    this.workspaceSearch.focus();
  }

  private closeWorkspace(restoreFocus = true): void {
    this.workspaceHost?.remove();
    this.workspaceHost = null;
    this.workspaceSearch = null;
    this.workspaceResults = null;
    this.workspaceControl?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && this.workspaceReturnFocus?.isConnected) this.workspaceReturnFocus.focus();
    this.workspaceReturnFocus = null;
  }

  private renderWorkspaceActions(): void {
    const results = this.workspaceResults;
    if (!results) return;
    const query = this.workspaceSearch?.value ?? '';
    const actions = this.workspaceActions().filter((action) => matchesWorkspaceQuery(query, action.name, action.description, action.keywords, action.group));
    results.replaceChildren();
    if (!actions.length) {
      results.append(el('div', { class: 'fwa-workspace-empty', role: 'status' }, [icon('search', 24), el('strong', { text: '沒有符合的工具' }), el('span', { text: '試試「照片」、「模板」或「設定」。' })]));
      return;
    }
    for (const group of ['瀏覽與整理', '文章編輯', '偏好設定'] as const) {
      const items = actions.filter((action) => action.group === group);
      if (!items.length) continue;
      const section = el('section', { class: 'fwa-workspace-group', 'aria-label': group }, [el('h3', { text: group })]);
      for (const action of items) {
        const button = el('button', { type: 'button', class: 'fwa-workspace-action' }, [
          el('span', { class: 'fwa-workspace-action-icon' }, [icon(action.symbol, 20)]),
          el('span', { class: 'fwa-workspace-action-copy' }, [el('strong', { text: action.name }), el('span', { text: action.description })]),
          action.available ? icon('arrowRight', 16) : el('span', { class: 'fwa-workspace-unavailable', text: '編輯時可用' }),
        ]);
        button.disabled = !action.available;
        button.addEventListener('click', () => { this.closeWorkspace(); action.run(); });
        section.appendChild(button);
      }
      results.appendChild(section);
    }
  }

  private async restoreExpandedState(): Promise<void> {
    const settings = await getSettings();
    // Older versions restored the customer drawer after navigation. It is now
    // a transient Pet popover, so clear any previously persisted open state.
    if (settings.customersPanelOpen) {
      settings.customersPanelOpen = false;
      await saveSettings(settings);
    }
  }

  private onTemplatesClick(): void {
    if (!this.templatePanel) {
      showToast('請先進入文章編輯頁才能使用模板功能', 'info');
      return;
    }
    this.closeCustomerDrawer();
    this.templatePanel.toggle();
  }

  private onAiLayoutClick(): void {
    if (!this.aiLayout) {
      showToast('請先進入文章編輯頁才能使用 AI 排版功能', 'info');
      return;
    }
    this.closeCustomerDrawer();
    this.templatePanel?.close();
    const modal = openModal('AI 排版');
    modal.body.append(
      el('div', { class: 'fwa-ai-launch-intro' }, [
        el('span', { class: 'fwa-workspace-action-icon' }, [icon('sparkles', 24)]),
        el('h3', { text: '讓文章的結構更清楚' }),
        el('p', { text: '依照你的排版規則，整理目前文章或選取的內容。完成後會先顯示差異，讓你決定要套用的版本。' }),
      ]),
      el('div', { class: 'fwa-hint', text: '開始後，內容會交由設定中的 AI 服務處理。你可以在設定中調整服務與排版規則。' }),
    );
    const cancel = el('button', { type: 'button', class: 'fwa-btn', text: '稍後再說' });
    cancel.addEventListener('click', () => modal.close());
    const start = el('button', { type: 'button', class: 'fwa-btn fwa-btn-primary', text: '開始 AI 排版' });
    start.prepend(icon('sparkles', 16));
    start.addEventListener('click', () => {
      const feature = this.aiLayout;
      modal.close();
      if (feature) void feature.openAi();
      else showToast('編輯器已關閉，請重新進入文章編輯頁。', 'info');
    });
    modal.footer.append(cancel, start);
  }

  private onCustomersClick(): void {
    if (Array.from(document.querySelectorAll('[id^="fwa-"]')).some((host) => host.shadowRoot?.querySelector('.fwa-modal'))) return;
    this.closeWorkspace(false);
    this.templatePanel?.close();
    if (this.customerPanel) this.closeCustomerDrawer();
    else this.openCustomerDrawer();
  }

  private closeCustomerDrawer(): void {
    if (!this.customerPanel) return;
    const hadFocus = Boolean(this.customerPanelHost?.shadowRoot?.activeElement);
    this.closeDirectoryMenu(false);
    document.removeEventListener('pointerdown', this.dismissCustomerPanelOnPointerDown);
    document.removeEventListener('keydown', this.dismissCustomerPanelOnEscape);
    this.customerPanelHost?.remove();
    this.customerPanel = null;
    this.customerPanelHost = null;
    this.customerListEl = null;
    this.customerCountEl = null;
    this.customerRenderVersion += 1;
    this.pet.setExpanded(false);
    if (hadFocus && this.customerReturnFocus?.isConnected) this.customerReturnFocus.focus({ preventScroll: true });
    this.customerReturnFocus = null;
  }

  private openCustomerDrawer(): void {
    if (this.customerPanel) return;
    const active = document.activeElement;
    const original = active?.shadowRoot?.activeElement ?? active;
    this.customerReturnFocus = original instanceof HTMLElement ? original : null;
    const { host, root } = createShadowHost('fwa-customer-panel-host');
    this.customerSearch = '';
    const close = el('button', { type: 'button', class: 'fwa-workspace-close', 'aria-label': '關閉客戶目錄', title: '關閉客戶目錄 · Esc' }, [icon('close', 18)]);
    close.addEventListener('click', () => this.closeCustomerDrawer());
    const addBtn = el('button', {
      type: 'button', class: 'fwa-directory-control fwa-customer-add-primary',
      title: '新增客戶', 'aria-label': '新增客戶',
    }, [icon('plus', 20)]);
    addBtn.addEventListener('click', () => { this.closeDirectoryMenu(false); void this.openAddCustomerModal(); });
    const more = this.createDirectoryMenuButton('更多客戶目錄操作', [
      { label: '收藏目前頁面', symbol: 'book', run: () => this.openAddCurrentInterfaceModal() },
      { label: '新增資料夾', symbol: 'folder', run: () => this.openAddFolderModal() },
      { label: '匯入客戶', symbol: 'upload', run: () => this.importCustomers() },
      { label: '匯出客戶', symbol: 'download', run: () => { void this.exportCustomers(); } },
    ]);
    const heading = el('header', { class: 'fwa-directory-header' }, [
      el('h2', { id: 'fwa-directory-title', text: '客戶目錄' }),
      el('div', { class: 'fwa-directory-header-actions' }, [addBtn, more, close]),
    ]);
    const search = el('input', { type: 'search', 'aria-label': '搜尋客戶名稱、頁面路徑與分支', placeholder: '搜尋客戶或頁面路徑…', autocomplete: 'off' });
    search.addEventListener('input', () => { this.customerSearch = search.value; void this.renderCustomerList(); });
    const searchRow = el('div', { class: 'fwa-directory-search' }, [icon('search', 18), search]);
    this.customerListEl = el('div', { class: 'fwa-panel-list fwa-customer-list' });
    this.customerCountEl = el('span', { class: 'fwa-customer-count', role: 'status', 'aria-live': 'polite' });
    this.customerPanel = el('section', { class: 'fwa-panel fwa-customer-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'fwa-directory-title' }, [
      el('div', { class: 'fwa-directory-topbar' }, [heading, searchRow]),
      this.customerListEl,
      el('footer', { class: 'fwa-customer-summary' }, [this.customerCountEl, el('span', { class: 'fwa-customer-drag-hint', text: '拖曳排序' })]),
    ]);
    this.customerPanelHost = host;
    root.appendChild(this.customerPanel);
    this.customerPanel.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const focusables = Array.from(this.customerPanel?.querySelectorAll<HTMLElement>('button:not(:disabled), input, a[href], select') ?? [])
        .filter((element) => !element.closest('[hidden]'));
      const first = focusables[0];
      const last = focusables.at(-1);
      if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    this.pet.setExpanded(true);
    this.updateCustomerDrawerInset();
    document.addEventListener('pointerdown', this.dismissCustomerPanelOnPointerDown);
    document.addEventListener('keydown', this.dismissCustomerPanelOnEscape);
    void this.renderCustomerList();
    search.focus();
    // This transient popover has no settings to save when it opens or closes.
  }

  private createDirectoryMenuButton(label: string, actions: DirectoryMenuAction[]): HTMLButtonElement {
    const button = el('button', {
      type: 'button', class: 'fwa-directory-control fwa-directory-more',
      title: label, 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    }, [icon('more', 19)]);
    button.addEventListener('click', () => {
      if (this.directoryMenu?.trigger === button) this.closeDirectoryMenu();
      else this.openDirectoryMenu(button, actions);
    });
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      event.stopPropagation();
      this.openDirectoryMenu(button, actions, event.key === 'ArrowUp');
    });
    return button;
  }

  private openDirectoryMenu(trigger: HTMLButtonElement, actions: DirectoryMenuAction[], focusLast = false): void {
    if (!this.customerPanel) return;
    this.closeDirectoryMenu(false);
    const menu = el('div', { class: 'fwa-directory-menu', role: 'menu', 'aria-label': trigger.getAttribute('aria-label') ?? '更多操作' });
    for (const action of actions) {
      const item = el('button', {
        type: 'button', class: `fwa-directory-menu-item${action.destructive ? ' is-destructive' : ''}`,
        role: 'menuitem', tabindex: '-1',
      }, [el('span', { text: action.label }), ...(action.symbol ? [icon(action.symbol, 17)] : [])]);
      item.disabled = Boolean(action.disabled);
      item.addEventListener('click', () => {
        // Restore the persistent trigger before a nested modal captures its opener.
        this.closeDirectoryMenu();
        action.run();
      });
      menu.appendChild(item);
    }
    this.directoryMenu = { element: menu, trigger };
    trigger.setAttribute('aria-expanded', 'true');
    this.customerPanel.appendChild(menu);
    const panelRect = this.customerPanel.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const width = menuRect.width || 220;
    const height = menuRect.height || actions.length * 42 + 12;
    const panelWidth = panelRect.width || Number.parseFloat(this.customerPanel.style.width) || 436;
    const panelHeight = panelRect.height || Number.parseFloat(this.customerPanel.style.height) || 550;
    const below = triggerRect.bottom - panelRect.top + 6;
    const top = below + height <= panelHeight - 10 ? below : triggerRect.top - panelRect.top - height - 6;
    menu.style.left = `${Math.max(10, Math.min(triggerRect.right - panelRect.left - width, panelWidth - width - 10))}px`;
    menu.style.top = `${Math.max(10, Math.min(top, panelHeight - height - 10))}px`;
    menu.style.maxHeight = `${Math.max(44, panelHeight - 20)}px`;
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); this.closeDirectoryMenu();
      } else if (event.key === 'Tab') {
        // Continue normal tab navigation from the stable trigger after dismissal.
        event.stopPropagation(); this.closeDirectoryMenu();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const index = items.indexOf(menu.getRootNode() instanceof ShadowRoot ? (menu.getRootNode() as ShadowRoot).activeElement as HTMLButtonElement : document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    });
    (focusLast ? items.at(-1) : items[0])?.focus();
  }

  private closeDirectoryMenu(restoreFocus = true): void {
    const menu = this.directoryMenu;
    if (!menu) return;
    this.directoryMenu = null;
    menu.element.remove();
    menu.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && menu.trigger.isConnected) menu.trigger.focus({ preventScroll: true });
  }

  private updateCustomerDrawerInset(): void {
    if (!this.customerPanel?.isConnected) return;
    const headerBottom = this.findTopHeader()?.getBoundingClientRect().bottom ?? 64;
    const position = customerPanelPosition(this.pet.getBounds(), { width: window.innerWidth, height: window.innerHeight }, headerBottom);
    Object.assign(this.customerPanel.style, {
      left: `${position.left}px`, top: `${position.top}px`, right: 'auto', bottom: 'auto',
      width: `${position.width}px`, height: `${position.height}px`, maxHeight: `${position.height}px`,
    });
  }

  private async exportCustomers(): Promise<void> {
    const json = await exportCustomers();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a', {
      href: url,
      download: `fwa-customers-${new Date().toISOString().slice(0, 10)}.json`,
    });
    link.click();
    URL.revokeObjectURL(url);
    showToast('客戶目錄已匯出', 'success');
  }

  private importCustomers(): void {
    const input = el('input', { type: 'file', accept: 'application/json' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const result = await importCustomers(await file.text());
        showToast(
          `客戶已匯入：新增 ${result.customersAdded} 位客戶、${result.branchesAdded} 個分支；略過 ${result.customersSkipped} 位重複客戶、${result.branchesSkipped} 個重複分支`,
          'success',
          7000,
        );
        void this.renderCustomerList();
      } catch (err) {
        showToast(`客戶匯入失敗：${err instanceof Error ? err.message : String(err)}`, 'error', 7000);
      }
    });
    input.click();
  }

  private async persistExpanded(open: boolean): Promise<void> {
    const settings = await getSettings();
    settings.customersPanelOpen = open;
    await saveSettings(settings);
  }

  private async renderCustomerList(): Promise<void> {
    if (!this.customerListEl) return;
    const version = ++this.customerRenderVersion;
    const [customers, branchMap, folders] = await Promise.all([
      listCustomers(),
      listAllBranches(),
      listCustomerFolders(),
    ]);
    if (!this.customerListEl || version !== this.customerRenderVersion) return;
    if (this.directoryMenu && this.customerListEl.contains(this.directoryMenu.trigger)) this.closeDirectoryMenu(false);
    this.customerListEl.replaceChildren();
    const query = this.customerSearch.trim();
    const visibleCustomers = customers.filter((customer) => {
      const branches = branchMap[customerBranchKey(customer.name)] ?? [];
      return matchesWorkspaceQuery(query, customer.name, customer.pagePath, ...branches.flatMap((branch) => [branch.name, branch.target]));
    });
    if (this.customerCountEl) this.customerCountEl.textContent = query ? `${visibleCustomers.length} / ${customers.length} 位客戶` : `${customers.length} 位客戶 · ${folders.length} 個資料夾`;
    if (query && !visibleCustomers.length) {
      this.customerListEl.append(el('div', { class: 'fwa-customer-empty' }, [icon('search', 28), el('div', { class: 'fwa-customer-empty-title', text: '找不到符合的客戶' }), el('div', { class: 'fwa-customer-empty-description', text: '換個名稱、頁面路徑或常用頁面名稱試試。' })]));
      return;
    }
    if (customers.length === 0 && folders.length === 0) {
      const add = el('button', { class: 'fwa-btn fwa-btn-primary', text: '新增第一位客戶' });
      add.addEventListener('click', () => void this.openAddCustomerModal());
      this.customerListEl.appendChild(
        el('div', { class: 'fwa-customer-empty' }, [
          el('div', { class: 'fwa-customer-empty-icon', text: '＋' }),
          el('div', { class: 'fwa-customer-empty-title', text: '建立你的客戶目錄' }),
          el('div', {
            class: 'fwa-customer-empty-description',
            text: '加入客戶後，可以在這裡快速前往首頁並管理常用頁面。',
          }),
          add,
        ]),
      );
      return;
    }
    const folderIds = new Set(folders.map((folder) => folder.id));
    const unfiledCustomers = visibleCustomers.filter(
      (customer) => !customer.folderId || !folderIds.has(customer.folderId),
    );
    if (!query || unfiledCustomers.length) this.customerListEl.appendChild(this.renderCustomerFolder(null, unfiledCustomers, branchMap));
    for (const folder of folders) {
      const folderCustomers = visibleCustomers.filter((customer) => customer.folderId === folder.id);
      if (!query || folderCustomers.length) this.customerListEl.appendChild(this.renderCustomerFolder(folder, folderCustomers, branchMap));
    }
  }

  private renderCustomerFolder(
    folder: CustomerFolder | null,
    customers: Customer[],
    branchMap: Record<string, CustomerBranch[]>,
  ): HTMLElement {
    const folderId = folder?.id ?? null;
    const customerList = el('div', {
      class: 'fwa-customer-folder-list',
      'data-folder-id': folderId ?? '',
    });
    const title = folder?.name ?? '未分類';
    const header = el('div', { class: 'fwa-customer-folder-header' }, [
      el('span', { class: 'fwa-customer-folder-icon', 'aria-hidden': 'true' }, [icon('folder', 15)]),
      el('span', { class: 'fwa-customer-folder-name', text: title }),
      el('span', {
        class: 'fwa-customer-folder-count',
        text: `${customers.length} 位`,
      }),
    ]);
    const section = el('section', {
      class: `fwa-customer-folder${folder ? '' : ' is-unfiled'}`,
      'data-folder-id': folderId ?? '',
    }, [header, customerList]);

    if (customers.length === 0) {
      customerList.appendChild(el('div', {
        class: 'fwa-customer-folder-empty',
        text: '拖曳客戶到這裡分類',
      }));
    } else {
      for (const customer of customers) {
        const branches = branchMap[customerBranchKey(customer.name)] ?? [];
        customerList.appendChild(this.renderCustomerItem(customer, branches, folderId));
      }
    }

    customerList.addEventListener('dragover', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!this.readDraggedCustomerId(event) || target?.closest('.fwa-customer-group')) return;
      event.preventDefault();
      this.showCustomerFolderDropTarget(customerList);
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    customerList.addEventListener('dragleave', (event) => {
      if (!customerList.contains(event.relatedTarget as Node | null)) customerList.classList.remove('is-drag-over');
    });
    customerList.addEventListener('drop', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.fwa-customer-group')) return;
      event.preventDefault();
      event.stopPropagation();
      const id = this.readDraggedCustomerId(event);
      if (!id) return;
      void this.finishCustomerDrop(id, null, 'after', folderId);
    });
    return section;
  }

  private renderCustomerItem(
    customer: Customer,
    branches: CustomerBranch[],
    folderId: string | null,
  ): HTMLElement {
    const key = customerBranchKey(customer.name);
    const expanded = Boolean(this.customerSearch.trim()) || this.expandedCustomers.has(key);

    const dragHandle = el('button', {
      class: 'fwa-customer-drag-handle',
      type: 'button',
      draggable: 'true',
      title: '拖曳調整客戶順序',
      'aria-label': `拖曳調整 ${customer.name} 的位置`,
      'aria-grabbed': 'false',
      text: '⠿',
    });
    dragHandle.addEventListener('dragstart', (event) => {
      this.draggingCustomerId = customer.id;
      dragHandle.setAttribute('aria-grabbed', 'true');
      const group = (event.currentTarget as HTMLElement).closest('.fwa-customer-group');
      group?.classList.add('is-dragging');
      event.dataTransfer?.setData('text/plain', customer.id);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        // Keep the native drag image tiny so the list itself remains the source
        // of truth for the drop position (scale + gap indicate the target).
        event.dataTransfer.setDragImage(dragHandle, 9, 16);
      }
    });
    dragHandle.addEventListener('dragend', () => {
      dragHandle.setAttribute('aria-grabbed', 'false');
      this.clearCustomerDragState();
    });

    const toggle = el('button', {
      class: 'fwa-branch-toggle',
      type: 'button',
      title: '展開／收合分支',
      'aria-expanded': String(expanded),
      'aria-label': `展開或收合 ${customer.name} 的分支`,
    });
    toggle.append(icon(expanded ? 'chevronDown' : 'chevronRight', 16));
    const link = el('button', {
      class: 'fwa-customer-link',
      title: customer.pagePath,
      text: customer.name,
    });
    link.addEventListener('click', () => this.goToCustomer(customer));
    const meta = el('span', {
      class: 'fwa-customer-meta',
      text: customer.pagePath,
    });
    const more = this.createDirectoryMenuButton(`${customer.name} 的更多操作`, [
      { label: '編輯客戶', symbol: 'edit', run: () => { void this.openEditCustomerModal(customer); } },
      { label: '新增分支', symbol: 'plus', run: () => this.openBranchModal(customer, null) },
      { label: '刪除客戶', symbol: 'trash', destructive: true, run: () => this.confirmDeleteCustomer(customer) },
    ]);

    const branchList = this.renderBranchList(customer, branches);
    branchList.hidden = !expanded;
    const group = el('div', {
      class: `fwa-customer-group${expanded ? ' is-expanded' : ''}`,
      'data-customer-id': customer.id,
    });
    toggle.addEventListener('click', () => {
      const nowExpanded = branchList.hidden;
      if (nowExpanded) this.expandedCustomers.add(key);
      else this.expandedCustomers.delete(key);
      toggle.replaceChildren(icon(nowExpanded ? 'chevronDown' : 'chevronRight', 16));
      toggle.setAttribute('aria-expanded', String(nowExpanded));
      branchList.hidden = !nowExpanded;
      group.classList.toggle('is-expanded', nowExpanded);
    });

    group.append(
      el('div', { class: 'fwa-customer-item' }, [
        dragHandle,
        el('div', { class: 'fwa-customer-details' }, [
          el('div', { class: 'fwa-customer-name-row' }, [link]),
          meta,
        ]),
        el('div', { class: 'fwa-customer-actions' }, [more]),
        toggle,
      ]),
      branchList,
    );

    group.addEventListener('dragover', (event) => {
      const id = this.readDraggedCustomerId(event);
      if (!id || id === customer.id) return;
      event.preventDefault();
      event.stopPropagation();
      const row = group.querySelector<HTMLElement>('.fwa-customer-item') ?? group;
      const rect = row.getBoundingClientRect();
      const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      this.showCustomerDropTarget(group, position);
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    group.addEventListener('dragleave', (event) => {
      if (!group.contains(event.relatedTarget as Node | null)) {
        group.classList.remove('is-drag-target', 'is-drop-before', 'is-drop-after');
      }
    });
    group.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const id = this.readDraggedCustomerId(event);
      if (!id || id === customer.id) return;
      const rect = group.getBoundingClientRect();
      const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      void this.finishCustomerDrop(id, customer.id, position, folderId);
    });
    return group;
  }

  private renderBranchList(customer: Customer, branches: CustomerBranch[]): HTMLElement {
    const list = el('div', { class: 'fwa-branch-list' });
    if (branches.length === 0) {
      list.appendChild(
        el('div', { class: 'fwa-branch-empty', text: '還沒有分支，可從客戶的「更多操作」新增。' }),
      );
      return list;
    }
    branches.forEach((branch, index) => {
      const isLast = index === branches.length - 1;
      const link = el('button', {
        class: 'fwa-branch-link',
        title: branch.target,
        text: branch.name,
      });
      link.addEventListener('click', () => this.goToBranch(branch));

      const more = this.createDirectoryMenuButton(`${branch.name} 的分支操作`, [
        { label: '編輯分支', symbol: 'edit', run: () => this.openBranchModal(customer, branch) },
        { label: '上移', disabled: index === 0, run: () => { void this.moveAndRefresh(customer, branch, -1); } },
        { label: '下移', disabled: isLast, run: () => { void this.moveAndRefresh(customer, branch, 1); } },
        { label: '刪除分支', symbol: 'trash', destructive: true, run: () => this.confirmDeleteBranch(customer, branch) },
      ]);

      list.appendChild(
        el('div', { class: 'fwa-branch-item' }, [
          el('span', { class: 'fwa-branch-tee', 'aria-hidden': 'true', text: isLast ? '└' : '├' }),
          link,
          el('span', { class: 'fwa-branch-actions' }, [more]),
        ]),
      );
    });
    return list;
  }

  private async moveAndRefresh(
    customer: Customer,
    branch: CustomerBranch,
    delta: number,
  ): Promise<void> {
    await moveBranch(customer.name, branch.id, delta);
    await this.renderCustomerList();
  }

  private readDraggedCustomerId(event: DragEvent): string | null {
    return this.draggingCustomerId || event.dataTransfer?.getData('text/plain') || null;
  }

  private showCustomerDropTarget(group: HTMLElement, position: 'before' | 'after'): void {
    this.customerListEl?.querySelectorAll('.is-drag-target, .is-drag-over').forEach((element) => {
      element.classList.remove('is-drag-target', 'is-drag-over');
    });
    this.customerListEl?.querySelectorAll('.is-drop-before, .is-drop-after').forEach((element) => {
      element.classList.remove('is-drop-before', 'is-drop-after');
    });
    group.classList.add('is-drag-target', `is-drop-${position}`);
  }

  private showCustomerFolderDropTarget(customerList: HTMLElement): void {
    this.customerListEl?.querySelectorAll('.is-drag-target, .is-drag-over').forEach((element) => {
      element.classList.remove('is-drag-target', 'is-drag-over');
    });
    this.customerListEl?.querySelectorAll('.is-drop-before, .is-drop-after').forEach((element) => {
      element.classList.remove('is-drop-before', 'is-drop-after');
    });
    customerList.classList.add('is-drag-over');
  }

  private clearCustomerDragState(): void {
    this.draggingCustomerId = null;
    this.customerListEl?.querySelectorAll(
      '.is-dragging, .is-drag-target, .is-drop-before, .is-drop-after, .is-drag-over',
    ).forEach((element) => {
      element.classList.remove('is-dragging', 'is-drag-target', 'is-drop-before', 'is-drop-after', 'is-drag-over');
    });
  }

  private async finishCustomerDrop(
    id: string,
    targetId: string | null,
    position: 'before' | 'after',
    folderId: string | null,
  ): Promise<void> {
    this.clearCustomerDragState();
    try {
      await reorderCustomer(id, targetId, position, folderId);
      await this.renderCustomerList();
    } catch (err) {
      showToast(`客戶排序失敗：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  private goToCustomer(customer: Customer): void {
    this.navigateAndCloseDrawer(new URL(customer.pagePath, wikiConfig.origin).toString());
  }

  private goToBranch(branch: CustomerBranch): void {
    const url = resolveBranchUrl(branch.target);
    if (!url) {
      showToast(`分支「${branch.name}」的連結無法使用，請編輯後重試`, 'error');
      return;
    }
    this.navigateAndCloseDrawer(url);
  }

  private navigateAndCloseDrawer(url: string): void {
    // Close the drawer and persist that *before* navigating — otherwise the
    // "open" flag survives the navigation and the drawer silently reopens on
    // the destination page (settled asynchronously, so await it first or
    // the write can lose the race against the document unloading).
    this.customerPanel?.remove();
    this.customerPanel = null;
    this.customerPanelHost?.remove();
    this.customerPanelHost = null;
    this.customerListEl = null;
    this.customerCountEl = null;
    this.customerRenderVersion += 1;
    this.pet.setExpanded(false);
    document.removeEventListener('pointerdown', this.dismissCustomerPanelOnPointerDown);
    document.removeEventListener('keydown', this.dismissCustomerPanelOnEscape);
    void this.persistExpanded(false).finally(() => window.location.assign(url));
  }

  private folderSelect(folders: CustomerFolder[], selectedId?: string): HTMLSelectElement {
    const select = el('select', {
      class: 'fwa-customer-folder-select',
      'aria-label': '客戶資料夾',
    });
    select.appendChild(el('option', { value: '', text: '未分類' }));
    for (const folder of folders) {
      select.appendChild(el('option', { value: folder.id, text: folder.name }));
    }
    select.value = selectedId && folders.some((folder) => folder.id === selectedId) ? selectedId : '';
    return select;
  }

  private openAddFolderModal(): void {
    const modal = openModal('新增資料夾');
    const name = el('input', { type: 'text', placeholder: '例如：重要客戶、維護中、北區' });
    const error = el('div', { class: 'fwa-hint fwa-branch-error' });
    modal.body.append(
      el('label', { text: '資料夾名稱' }),
      name,
      el('div', { class: 'fwa-hint', text: '建立後可在新增或編輯客戶時選擇資料夾。' }),
      error,
    );
    const cancel = el('button', { class: 'fwa-btn', text: '取消' });
    const save = el('button', { class: 'fwa-btn fwa-btn-primary', text: '新增資料夾' });
    cancel.addEventListener('click', () => modal.close());
    save.addEventListener('click', async () => {
      error.textContent = '';
      name.style.borderColor = '';
      if (!name.value.trim()) {
        name.style.borderColor = '#cf222e';
        error.textContent = '請輸入資料夾名稱。';
        return;
      }
      try {
        const folder = await createCustomerFolder({ name: name.value });
        modal.close();
        showToast(`已新增資料夾：${folder.name}`, 'success');
        void this.renderCustomerList();
      } catch (err) {
        name.style.borderColor = '#cf222e';
        error.textContent = err instanceof Error ? err.message : String(err);
      }
    });
    modal.footer.append(cancel, save);
    name.focus();
  }

  private async openEditCustomerModal(customer: Customer): Promise<void> {
    const folders = await listCustomerFolders();
    const modal = openModal(`編輯客戶：${customer.name}`);
    const name = el('input', { type: 'text', value: customer.name });
    const path = el('input', { type: 'text', value: customer.pagePath });
    const folder = this.folderSelect(folders, customer.folderId);
    const error = el('div', { class: 'fwa-hint fwa-branch-error' });
    modal.body.append(
      el('label', { text: '客戶名稱' }),
      name,
      el('label', { text: 'Wiki 頁面路徑' }),
      path,
      el('label', { text: '資料夾分類' }),
      folder,
      error,
    );
    const cancel = el('button', { class: 'fwa-btn', text: '取消' });
    const save = el('button', { class: 'fwa-btn fwa-btn-primary', text: '儲存' });
    cancel.addEventListener('click', () => modal.close());
    save.addEventListener('click', async () => {
      name.style.borderColor = '';
      path.style.borderColor = '';
      error.textContent = '';
      if (!name.value.trim()) {
        name.style.borderColor = '#cf222e';
        error.textContent = '請輸入客戶名稱。';
        return;
      }
      if (!path.value.trim().startsWith('/')) {
        path.style.borderColor = '#cf222e';
        error.textContent = 'Wiki 頁面路徑請以「/」開頭。';
        return;
      }
      try {
        await updateCustomer(customer.id, {
          name: name.value,
          pagePath: path.value,
          folderId: folder.value || null,
        });
        modal.close();
        showToast(`已更新客戶：${name.value.trim()}`, 'success');
        void this.renderCustomerList();
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : String(err);
      }
    });
    modal.footer.append(cancel, save);
    name.focus();
  }

  /**
   * Add/edit form for one branch. Only the two fields the user asked for —
   * 顯示名稱 and Wiki URL／相對路徑 — plus a one-click「帶入目前頁面」that
   * fills both from the page being viewed (its H1 and its view URL, so an
   * edit URL never gets stored as a branch).
   */
  private openBranchModal(customer: Customer, branch: CustomerBranch | null): void {
    const modal = openModal(
      branch ? `編輯分支：${customer.name} / ${branch.name}` : `新增分支：${customer.name}`,
    );
    const name = el('input', { type: 'text', placeholder: '例如：SOP' });
    const target = el('input', {
      type: 'text',
      placeholder: `${customer.pagePath}/SOP 或完整網址`,
    });
    if (branch) {
      name.value = branch.name;
      target.value = branch.target;
      target.dataset.touched = '1';
    }
    // Same "suggest while untouched" behaviour as the 新增客戶 dialog.
    name.addEventListener('input', () => {
      if (target.dataset.touched) return;
      const slug = name.value.trim().replace(/^\/+|\/+$/g, '');
      target.value = slug ? `${customer.pagePath}/${slug}` : '';
    });
    target.addEventListener('input', () => {
      target.dataset.touched = '1';
    });

    const useCurrent = el('button', { class: 'fwa-btn', text: '帶入目前頁面' });
    useCurrent.addEventListener('click', () => {
      name.value = readCurrentPageTitle();
      target.value = viewPathForBranch(window.location.pathname);
      target.dataset.touched = '1';
      name.focus();
    });

    const error = el('div', { class: 'fwa-hint fwa-branch-error' });
    modal.body.append(
      el('label', { text: '顯示名稱' }),
      name,
      el('label', { text: 'Wiki URL 或相對路徑' }),
      target,
      el('div', { class: 'fwa-branch-prefill' }, [useCurrent]),
      el('div', {
        class: 'fwa-hint',
        text: '相對路徑請以「/」開頭；貼上本站完整網址會自動存成相對路徑。',
      }),
      error,
    );

    const cancel = el('button', { class: 'fwa-btn', text: '取消' });
    const save = el('button', {
      class: 'fwa-btn fwa-btn-primary',
      text: branch ? '儲存' : '新增',
    });
    cancel.addEventListener('click', () => modal.close());
    save.addEventListener('click', async () => {
      const trimmedName = name.value.trim();
      const normalized = normalizeBranchTarget(target.value);
      name.style.borderColor = '';
      target.style.borderColor = '';
      error.textContent = '';
      if (!trimmedName) {
        name.style.borderColor = '#cf222e';
        error.textContent = '請輸入顯示名稱。';
        return;
      }
      if (!normalized) {
        target.style.borderColor = '#cf222e';
        error.textContent = '請輸入以「/」開頭的 Wiki 路徑，或 http(s) 完整網址。';
        return;
      }
      const input = { name: trimmedName, target: normalized };
      if (branch) await updateBranch(customer.name, branch.id, input);
      else await createBranch(customer.name, input);
      modal.close();
      // A freshly added branch is only useful if its customer is showing.
      this.expandedCustomers.add(customerBranchKey(customer.name));
      showToast(branch ? `已更新分支：${trimmedName}` : `已新增分支：${trimmedName}`, 'success');
      void this.renderCustomerList();
    });
    modal.footer.append(cancel, save);
    name.focus();
  }

  private confirmDeleteBranch(customer: Customer, branch: CustomerBranch): void {
    const modal = openModal(`刪除分支：${branch.name}`);
    modal.body.append(
      el('div', {
        text: `確定要從「${customer.name}」移除分支「${branch.name}」嗎？這只會移除目錄裡的連結，不會刪除 Wiki 頁面本身。`,
      }),
    );
    const cancel = el('button', { class: 'fwa-btn', text: '取消' });
    const ok = el('button', { class: 'fwa-btn fwa-btn-danger', text: '刪除' });
    cancel.addEventListener('click', () => modal.close());
    ok.addEventListener('click', async () => {
      await deleteBranch(customer.name, branch.id);
      modal.close();
      showToast('已刪除分支', 'success');
      void this.renderCustomerList();
    });
    modal.footer.append(cancel, ok);
  }

  private openAddCurrentInterfaceModal(): void {
    const pagePath = viewPathForBranch(window.location.pathname);
    const modal = openModal('新增這個介面');
    const name = el('input', { type: 'text', placeholder: '例如：晨會' });
    name.value = readCurrentPageTitle();
    const error = el('div', { class: 'fwa-hint fwa-branch-error' });

    modal.body.append(
      el('label', { text: '介面名稱' }),
      name,
      el('div', { class: 'fwa-hint', text: `目前頁面：${pagePath}` }),
      error,
    );

    const cancel = el('button', { class: 'fwa-btn', text: '取消' });
    const save = el('button', { class: 'fwa-btn fwa-btn-primary', text: '新增' });
    cancel.addEventListener('click', () => modal.close());
    save.addEventListener('click', async () => {
      const trimmedName = name.value.trim();
      name.style.borderColor = '';
      error.textContent = '';
      if (!trimmedName) {
        name.style.borderColor = '#cf222e';
        error.textContent = '請輸入介面名稱。';
        return;
      }
      try {
        // No folder is supplied intentionally: the new shortcut starts in「未分類」.
        await createCustomer({ name: trimmedName, pagePath });
        modal.close();
        showToast(`已新增介面：${trimmedName}`, 'success');
        void this.renderCustomerList();
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : String(err);
      }
    });
    modal.footer.append(cancel, save);
    name.focus();
    name.select();
  }

  private async openAddCustomerModal(): Promise<void> {
    const folders = await listCustomerFolders();
    const modal = openModal('新增客戶');
    const name = el('input', { type: 'text', placeholder: '例如：Example Client' });
    const path = el('input', { type: 'text', placeholder: `${wikiConfig.customers.basePath}/example-client` });
    const folder = this.folderSelect(folders);
    const error = el('div', { class: 'fwa-hint fwa-branch-error' });
    name.addEventListener('input', () => {
      if (!path.dataset.touched) path.value = wikiConfig.customers.defaultPagePathFor(name.value);
    });
    path.addEventListener('input', () => {
      path.dataset.touched = '1';
    });

    modal.body.append(
      el('label', { text: '客戶名稱' }),
      name,
      el('label', { text: 'Wiki 頁面路徑' }),
      path,
      el('label', { text: '資料夾分類' }),
      folder,
      error,
    );

    const cancel = el('button', { class: 'fwa-btn', text: '取消' });
    const save = el('button', { class: 'fwa-btn fwa-btn-primary', text: '新增' });
    cancel.addEventListener('click', () => modal.close());
    save.addEventListener('click', async () => {
      const trimmedName = name.value.trim();
      const trimmedPath = path.value.trim().replace(/\/+$/, '');
      name.style.borderColor = '';
      path.style.borderColor = '';
      error.textContent = '';
      if (!trimmedName) {
        name.style.borderColor = '#cf222e';
        error.textContent = '請輸入客戶名稱。';
        return;
      }
      if (!trimmedPath.startsWith('/')) {
        path.style.borderColor = '#cf222e';
        error.textContent = 'Wiki 頁面路徑請以「/」開頭。';
        return;
      }
      try {
        await createCustomer({ name: trimmedName, pagePath: trimmedPath, folderId: folder.value || null });
        modal.close();
        showToast(`已新增客戶：${trimmedName}`, 'success');
        void this.renderCustomerList();
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : String(err);
      }
    });
    modal.footer.append(cancel, save);
    name.focus();
  }

  private confirmDeleteCustomer(customer: Customer): void {
    const modal = openModal(`刪除客戶：${customer.name}`);
    modal.body.append(
      el('div', {
        text: `確定要從目錄中移除「${customer.name}」及其所有分支嗎？這只會移除側邊目錄的連結，不會刪除 Wiki 頁面本身，此動作無法復原。`,
      }),
    );
    const cancel = el('button', { class: 'fwa-btn', text: '取消' });
    const ok = el('button', { class: 'fwa-btn fwa-btn-danger', text: '刪除' });
    cancel.addEventListener('click', () => modal.close());
    ok.addEventListener('click', async () => {
      await deleteCustomer(customer.id);
      modal.close();
      showToast('已刪除客戶', 'success');
      void this.renderCustomerList();
    });
    modal.footer.append(cancel, ok);
  }
}

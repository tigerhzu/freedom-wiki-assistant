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
import { getSettings, saveSettings } from '../shared/storage';
import type { Customer, CustomerBranch, CustomerFolder } from '../shared/types';
import type { AiLayoutFeature } from './ai-layout';
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

const TOP_CONTROLS_STYLE_ID = 'fwa-editor-actions-style';

function stopTopControlPointerEvent(event: Event): void {
  // Keep Wiki.js toolbar handlers from consuming the gesture first.
  event.stopPropagation();
}

function ensureTopControlsStyle(): void {
  if (document.getElementById(TOP_CONTROLS_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = TOP_CONTROLS_STYLE_ID;
  style.textContent = editorActionsCss;
  document.head.appendChild(style);
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

/**
 * Top-level navigation, mounted once for the lifetime of the content script
 * (unlike the editor-only features in index.ts) so it's visible on every
 * wiki page. A single pet-widget button (see pet/pet-widget.ts) opens a menu
 * of the extension's browsing actions: 檢閱照片 / 客戶 / 頁面拓譜圖.
 *
 *  - 模板與 AI 排版 are mounted in Wiki.js' native editor header
 *    only while an editor is available. They are deliberately not shown in
 *    the browsing-only pet menu.
 *  - 檢閱照片 calls the existing asset-review modal directly — that feature
 *    never depended on an editor adapter to begin with.
 *  - 客戶 opens a collapsible directory drawer backed by
 *    customers/customer-service.ts (chrome.storage.local — never hardcoded).
 *    Each customer row expands into that customer's own branches (sub-pages),
 *    which the user adds/edits/reorders from the same drawer.
 */
export class MainNav {
  private readonly pet = new PetWidget();
  private templatePanel: TemplatePanel | null = null;
  private aiLayout: AiLayoutFeature | null = null;
  private customerPanel: HTMLElement | null = null;
  private customerPanelHost: HTMLElement | null = null;
  private customerListEl: HTMLElement | null = null;
  private stopFollowingPet: (() => void) | null = null;
  private topologyControl: HTMLButtonElement | null = null;
  private sidebarColorControl: HTMLButtonElement | null = null;
  private settingsControl: HTMLButtonElement | null = null;
  private editorActions: HTMLElement | null = null;
  private topControlsObserver: MutationObserver | null = null;
  private topControlsScheduled = false;
  private topControlsHost: HTMLElement | null = null;
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
    if (event.key === 'Escape') this.closeCustomerDrawer();
  };

  attach(): void {
    this.pet.attach(() => this.onCustomersClick());
    ensureTopControlsStyle();
    this.mountTopControls();
    window.addEventListener('resize', () => this.scheduleTopControlsMount());
    this.topControlsObserver = new MutationObserver(() => this.scheduleTopControlsMount());
    this.topControlsObserver.observe(document.documentElement, { childList: true, subtree: true });
    void this.restoreExpandedState();
  }

  private scheduleTopControlsMount(): void {
    if (this.topControlsScheduled) return;
    this.topControlsScheduled = true;
    window.requestAnimationFrame(() => {
      this.topControlsScheduled = false;
      this.mountTopControls();
    });
  }

  private mountTopControls(): void {
    this.mountSidebarColorControl();
    this.mountTopologyControl();
    this.mountSettingsControl();
    this.mountEditorActions();
  }

  private mountTopologyControl(): void {
    const header = this.findTopHeader();
    if (!header) return;
    const { host } = this.getTopHeaderMount(header);

    const button = this.topologyControl ?? document.createElement('button');
    if (!this.topologyControl) {
      button.type = 'button';
      button.className = 'fwa-header-topology';
      button.textContent = '拓譜';
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

  private getTopHeaderMount(header: HTMLElement): {
    title: HTMLElement | null;
    host: HTMLElement;
  } {
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
      host.setAttribute('aria-label', 'Freedom Wiki Assistant 上方控制項');
      for (const control of [this.sidebarColorControl, this.topologyControl, this.settingsControl]) {
        if (control) host.appendChild(control);
      }
      this.topControlsHost = host;
    }

    if (host.parentElement !== parent) {
      const afterTitle = title?.parentElement === parent ? title.nextSibling : null;
      parent.insertBefore(host, afterTitle);
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

  private mountSidebarColorControl(): void {
    const header = this.findTopHeader();
    if (!header) return;
    const { host } = this.getTopHeaderMount(header);

    const button = this.sidebarColorControl ?? document.createElement('button');
    if (!this.sidebarColorControl) {
      button.type = 'button';
      button.className = 'fwa-header-color-swatch';
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
    }

    this.placeAtStart(host, button);
    void this.refreshSidebarColorControl();
  }

  private mountSettingsControl(): void {
    const header = this.findTopHeader();
    if (!header) return;
    const { title, host } = this.getTopHeaderMount(header);

    const button = this.settingsControl ?? document.createElement('button');
    if (!this.settingsControl) {
      button.type = 'button';
      button.className = 'fwa-header-settings';
      button.textContent = '設定';
      button.title = '開啟 Freedom Wiki Assistant 完整設定';
      button.setAttribute('aria-label', '開啟 Freedom Wiki Assistant 完整設定');
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

  private async refreshSidebarColorControl(): Promise<void> {
    const button = this.sidebarColorControl;
    if (!button?.isConnected) return;
    const settings = await getSettings();
    const primary = normalizeSidebarColor(settings.sidebarColor) ?? '#1976d2';
    const secondary = resolveSidebarGradientEnd(primary, settings.sidebarGradientColor);
    button.style.setProperty('--fwa-color-start', primary);
    button.style.setProperty('--fwa-color-end', secondary);
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

    const icon = document.querySelector<HTMLElement>(wikiConfig.editor.saveButtonIconSelector);
    const saveButton = icon?.closest<HTMLButtonElement>('button') ?? null;
    const host = saveButton?.parentElement ?? null;
    if (!saveButton || !host) return;

    const actions = document.createElement('div');
    actions.className = 'fwa-editor-actions';
    for (const [label, title, onClick] of [
      ['模板', '開啟文章模板', () => this.onTemplatesClick()],
      ['AI 排版', '使用 Azure OpenAI 排版文章', () => this.onAiLayoutClick()],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fwa-editor-action';
      button.textContent = label;
      button.title = title;
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
  }

  /** Registered by index.ts whenever an editor mounts/unmounts; null while browsing (no editor on the page). */
  setAiLayout(feature: AiLayoutFeature | null): void {
    this.aiLayout = feature;
    this.mountEditorActions();
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
    void this.aiLayout.openAi();
  }

  private onCustomersClick(): void {
    this.templatePanel?.close();
    if (this.customerPanel) this.closeCustomerDrawer();
    else this.openCustomerDrawer();
  }

  private closeCustomerDrawer(): void {
    if (!this.customerPanel) return;
    document.removeEventListener('pointerdown', this.dismissCustomerPanelOnPointerDown);
    document.removeEventListener('keydown', this.dismissCustomerPanelOnEscape);
    this.stopFollowingPet?.();
    this.stopFollowingPet = null;
    this.customerPanelHost?.remove();
    this.customerPanel = null;
    this.customerPanelHost = null;
    this.customerListEl = null;
    void this.persistExpanded(false);
  }

  private openCustomerDrawer(): void {
    if (this.customerPanel) return;
    const { host, root } = createShadowHost('fwa-customer-panel-host');
    const addBtn = el('button', {
      class: 'fwa-btn fwa-btn-primary fwa-customer-add-primary',
      text: '＋ 新增客戶',
    });
    addBtn.addEventListener('click', () => void this.openAddCustomerModal());
    const addCurrentPageBtn = el('button', {
      class: 'fwa-btn fwa-customer-secondary fwa-customer-current-page',
      title: '將目前正在瀏覽的 Wiki 頁面加入客戶目錄',
      text: '＋ 新增這個介面',
    });
    addCurrentPageBtn.addEventListener('click', () => this.openAddCurrentInterfaceModal());
    const addFolderBtn = el('button', {
      class: 'fwa-btn fwa-customer-secondary fwa-customer-folder-add',
      title: '建立資料夾來分類客戶',
      text: '＋ 新增資料夾',
    });
    addFolderBtn.addEventListener('click', () => this.openAddFolderModal());
    const importBtn = el('button', {
      class: 'fwa-btn fwa-customer-secondary',
      title: '從 JSON 匯入客戶',
      text: '匯入',
    });
    importBtn.addEventListener('click', () => this.importCustomers());
    const exportBtn = el('button', {
      class: 'fwa-btn fwa-customer-secondary',
      title: '將客戶匯出為 JSON',
      text: '匯出',
    });
    exportBtn.addEventListener('click', () => void this.exportCustomers());
    const header = el('div', { class: 'fwa-customer-toolbar' }, [
      el('div', { class: 'fwa-customer-toolbar-main' }, [addBtn, addCurrentPageBtn]),
      el('div', { class: 'fwa-customer-toolbar-utilities' }, [addFolderBtn, importBtn, exportBtn]),
    ]);

    this.customerListEl = el('div', { class: 'fwa-panel-list fwa-customer-list' });
    this.customerPanel = el('div', { class: 'fwa-panel fwa-customer-panel' }, [
      header,
      this.customerListEl,
    ]);
    this.customerPanelHost = host;
    root.appendChild(this.customerPanel);
    this.positionCustomerDrawer();
    this.stopFollowingPet = this.pet.onPositionChange(() => this.positionCustomerDrawer());
    window.requestAnimationFrame(() => this.positionCustomerDrawer());
    document.addEventListener('pointerdown', this.dismissCustomerPanelOnPointerDown);
    document.addEventListener('keydown', this.dismissCustomerPanelOnEscape);
    void this.renderCustomerList();
    // The customer list is now a transient Pet popover, so it must never reopen after navigation.
    void this.persistExpanded(false);
  }

  private positionCustomerDrawer(): void {
    const panel = this.customerPanel;
    const petBounds = this.pet.getBounds();
    if (!panel?.isConnected || !petBounds) return;

    const margin = 12;
    const panelWidth = panel.offsetWidth;
    const panelHeight = panel.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const roomOnLeft = petBounds.left - margin;
    const roomOnRight = viewportWidth - petBounds.right - margin;
    let left = roomOnLeft >= panelWidth || roomOnLeft >= roomOnRight
      ? petBounds.left - panelWidth - margin
      : petBounds.right + margin;
    left = Math.min(Math.max(margin, left), Math.max(margin, viewportWidth - panelWidth - margin));

    let top = petBounds.bottom - panelHeight;
    top = Math.min(Math.max(margin, top), Math.max(margin, viewportHeight - panelHeight - margin));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
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
    const [customers, branchMap, folders] = await Promise.all([
      listCustomers(),
      listAllBranches(),
      listCustomerFolders(),
    ]);
    if (!this.customerListEl) return; // drawer closed while we were reading storage
    this.customerListEl.replaceChildren();
    window.requestAnimationFrame(() => this.positionCustomerDrawer());
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
    const unfiledCustomers = customers.filter(
      (customer) => !customer.folderId || !folderIds.has(customer.folderId),
    );
    this.customerListEl.appendChild(this.renderCustomerFolder(null, unfiledCustomers, branchMap));
    for (const folder of folders) {
      const folderCustomers = customers.filter((customer) => customer.folderId === folder.id);
      this.customerListEl.appendChild(this.renderCustomerFolder(folder, folderCustomers, branchMap));
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
      el('span', { class: 'fwa-customer-folder-icon', 'aria-hidden': 'true', text: '▰' }),
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
    const expanded = this.expandedCustomers.has(key);

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
      text: expanded ? '▾' : '▸',
    });
    const link = el('button', {
      class: 'fwa-customer-link',
      title: customer.pagePath,
      text: customer.name,
    });
    link.addEventListener('click', () => this.goToCustomer(customer));
    const edit = el('button', {
      class: 'fwa-icon-btn fwa-customer-edit',
      type: 'button',
      title: `編輯 ${customer.name}`,
      'aria-label': `編輯 ${customer.name}`,
      text: '✎',
    });
    edit.addEventListener('click', () => void this.openEditCustomerModal(customer));
    const meta = el('span', {
      class: 'fwa-customer-meta',
      text: branches.length > 0 ? `${branches.length} 個常用頁面` : '尚無常用頁面',
    });
    const add = el('button', {
      class: 'fwa-icon-btn fwa-branch-add',
      type: 'button',
      title: `新增 ${customer.name} 的分支`,
      'aria-label': `新增 ${customer.name} 的分支`,
      text: '＋',
    });
    add.addEventListener('click', () => this.openBranchModal(customer, null));
    const del = el('button', {
      class: 'fwa-icon-btn fwa-customer-delete',
      type: 'button',
      title: `刪除 ${customer.name}`,
      'aria-label': `刪除 ${customer.name}`,
      text: '刪',
    });
    del.addEventListener('click', () => this.confirmDeleteCustomer(customer));

    const branchList = this.renderBranchList(customer, branches);
    branchList.hidden = !expanded;
    const group = el('div', {
      class: `fwa-customer-group${expanded ? ' is-expanded' : ''}`,
      'data-customer-id': customer.id,
    });
    toggle.addEventListener('click', () => {
      const nowExpanded = !this.expandedCustomers.has(key);
      if (nowExpanded) this.expandedCustomers.add(key);
      else this.expandedCustomers.delete(key);
      toggle.textContent = nowExpanded ? '▾' : '▸';
      toggle.setAttribute('aria-expanded', String(nowExpanded));
      branchList.hidden = !nowExpanded;
      group.classList.toggle('is-expanded', nowExpanded);
    });

    group.append(
      el('div', { class: 'fwa-customer-item' }, [
        dragHandle,
        el('div', { class: 'fwa-customer-details' }, [
          el('div', { class: 'fwa-customer-name-row' }, [link, edit]),
          meta,
        ]),
        el('div', { class: 'fwa-customer-actions' }, [add, del]),
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
        el('div', { class: 'fwa-branch-empty', text: '尚未新增分支，可按上方「＋」新增' }),
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

      const up = this.branchActionBtn('↑', '上移', () => void this.moveAndRefresh(customer, branch, -1));
      const down = this.branchActionBtn('↓', '下移', () => void this.moveAndRefresh(customer, branch, 1));
      up.disabled = index === 0;
      down.disabled = isLast;
      const edit = this.branchActionBtn('✎', '編輯分支', () => this.openBranchModal(customer, branch));
      const remove = this.branchActionBtn('✕', '刪除分支', () =>
        this.confirmDeleteBranch(customer, branch),
      );

      list.appendChild(
        el('div', { class: 'fwa-branch-item' }, [
          el('span', { class: 'fwa-branch-tee', 'aria-hidden': 'true', text: isLast ? '└' : '├' }),
          link,
          el('span', { class: 'fwa-branch-actions' }, [up, down, edit, remove]),
        ]),
      );
    });
    return list;
  }

  private branchActionBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const btn = el('button', {
      class: 'fwa-icon-btn',
      type: 'button',
      title,
      'aria-label': title,
      text: label,
    });
    btn.addEventListener('click', onClick);
    return btn;
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
    this.stopFollowingPet?.();
    this.stopFollowingPet = null;
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

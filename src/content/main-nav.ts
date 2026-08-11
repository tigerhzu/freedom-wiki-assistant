import { wikiConfig } from '../config/wiki-config';
import {
  createBranch,
  createCustomer,
  customerBranchKey,
  deleteBranch,
  deleteCustomer,
  exportCustomers,
  importCustomers,
  listAllBranches,
  listCustomers,
  moveBranch,
  normalizeBranchTarget,
  resolveBranchUrl,
  updateBranch,
  viewPathForBranch,
} from '../customers/customer-service';
import { PetWidget, type PetMenuItem } from '../pet/pet-widget';
import { getSettings, saveSettings } from '../shared/storage';
import type { Customer, CustomerBranch } from '../shared/types';
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

/**
 * Top-level navigation, mounted once for the lifetime of the content script
 * (unlike the editor-only features in index.ts) so it's visible on every
 * wiki page. A single pet-widget button (see pet/pet-widget.ts) opens a menu
 * of the extension's three top-level actions: 模板 / 檢閱照片 / 客戶.
 *
 *  - 模板 delegates to whichever TemplatePanel is currently mounted (only
 *    exists while an editor is detected — see index.ts); if none, it just
 *    explains that an editor page is required, since template insertion has
 *    no meaning outside one.
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
  private customerListEl: HTMLElement | null = null;
  /**
   * Which customers are currently expanded, by branch key. Kept in memory
   * only: the drawer closes on navigation anyway, so persisting this would
   * just re-open branch lists the user has already moved on from.
   */
  private readonly expandedCustomers = new Set<string>();

  attach(): void {
    this.pet.attach(() => this.buildMenuItems());
    void this.restoreExpandedState();
  }

  private buildMenuItems(): PetMenuItem[] {
    return [
      { label: '調整左側顏色', onClick: () => void this.openSidebarColorModal() },
      { label: '頁面拓譜圖', onClick: () => openCurrentPageTopology() },
      { label: '模板', onClick: () => this.onTemplatesClick() },
      { label: '快速排版', onClick: () => this.onQuickFormatClick() },
      { label: 'AI 排版', onClick: () => this.onAiLayoutClick() },
      { label: '檢閱照片', onClick: () => void openAssetReviewModal() },
      { label: '客戶', onClick: () => this.onCustomersClick() },
    ];
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
  }

  /** Registered by index.ts whenever an editor mounts/unmounts; null while browsing (no editor on the page). */
  setAiLayout(feature: AiLayoutFeature | null): void {
    this.aiLayout = feature;
  }

  private async restoreExpandedState(): Promise<void> {
    const settings = await getSettings();
    if (settings.customersPanelOpen) this.openCustomerDrawer();
  }

  private onTemplatesClick(): void {
    if (!this.templatePanel) {
      showToast('請先進入文章編輯頁才能使用模板功能', 'info');
      return;
    }
    this.closeCustomerDrawer();
    this.templatePanel.toggle();
  }

  private onQuickFormatClick(): void {
    if (!this.aiLayout) {
      showToast('請先進入文章編輯頁才能使用快速排版功能', 'info');
      return;
    }
    this.closeCustomerDrawer();
    this.templatePanel?.close();
    this.aiLayout.openQuick();
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
    this.customerPanel.remove();
    this.customerPanel = null;
    this.customerListEl = null;
    void this.persistExpanded(false);
  }

  private openCustomerDrawer(): void {
    if (this.customerPanel) return;
    const { root } = createShadowHost('fwa-customer-panel-host');

    const closeBtn = el('button', { class: 'fwa-btn', text: '✕' });
    closeBtn.addEventListener('click', () => this.closeCustomerDrawer());
    const addBtn = el('button', { class: 'fwa-btn fwa-btn-primary', text: '＋ 新增客戶' });
    addBtn.addEventListener('click', () => this.openAddCustomerModal());
    const importBtn = el('button', { class: 'fwa-btn', text: '匯入 JSON' });
    importBtn.addEventListener('click', () => this.importCustomers());
    const exportBtn = el('button', { class: 'fwa-btn', text: '匯出 JSON' });
    exportBtn.addEventListener('click', () => void this.exportCustomers());
    const header = el('div', { class: 'fwa-panel-header' }, [
      el('span', { class: 'title', text: '客戶目錄' }),
      importBtn,
      exportBtn,
      addBtn,
      closeBtn,
    ]);

    this.customerListEl = el('div', { class: 'fwa-panel-list' });
    this.customerPanel = el('div', { class: 'fwa-panel' }, [header, this.customerListEl]);
    root.appendChild(this.customerPanel);
    void this.renderCustomerList();
    void this.persistExpanded(true);
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
    const [customers, branchMap] = await Promise.all([listCustomers(), listAllBranches()]);
    if (!this.customerListEl) return; // drawer closed while we were reading storage
    this.customerListEl.replaceChildren();
    if (customers.length === 0) {
      this.customerListEl.appendChild(el('div', { class: 'fwa-hint', text: '尚未新增任何客戶' }));
      return;
    }
    for (const customer of [...customers].sort((a, b) => a.name.localeCompare(b.name))) {
      const branches = branchMap[customerBranchKey(customer.name)] ?? [];
      this.customerListEl.appendChild(this.renderCustomerItem(customer, branches));
    }
  }

  private renderCustomerItem(customer: Customer, branches: CustomerBranch[]): HTMLElement {
    const key = customerBranchKey(customer.name);
    const expanded = this.expandedCustomers.has(key);

    const toggle = el('button', {
      class: 'fwa-branch-toggle',
      type: 'button',
      title: '展開／收合分支',
      'aria-expanded': String(expanded),
      'aria-label': `展開或收合 ${customer.name} 的分支`,
      text: expanded ? '▾' : '▸',
    });
    const link = el('button', { class: 'fwa-customer-link', text: customer.name });
    link.addEventListener('click', () => this.goToCustomer(customer));
    const count = el('span', {
      class: 'fwa-branch-count',
      text: branches.length > 0 ? String(branches.length) : '',
    });
    const add = el('button', {
      class: 'fwa-icon-btn fwa-branch-add',
      type: 'button',
      title: `新增 ${customer.name} 的分支`,
      'aria-label': `新增 ${customer.name} 的分支`,
      text: '＋',
    });
    add.addEventListener('click', () => this.openBranchModal(customer, null));
    const del = el('button', { class: 'fwa-btn fwa-btn-danger', text: '刪除' });
    del.addEventListener('click', () => this.confirmDeleteCustomer(customer));

    const branchList = this.renderBranchList(customer, branches);
    branchList.hidden = !expanded;
    toggle.addEventListener('click', () => {
      const nowExpanded = !this.expandedCustomers.has(key);
      if (nowExpanded) this.expandedCustomers.add(key);
      else this.expandedCustomers.delete(key);
      toggle.textContent = nowExpanded ? '▾' : '▸';
      toggle.setAttribute('aria-expanded', String(nowExpanded));
      branchList.hidden = !nowExpanded;
    });

    return el('div', { class: 'fwa-customer-group' }, [
      el('div', { class: 'fwa-customer-item' }, [toggle, link, count, add, del]),
      branchList,
    ]);
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
    this.customerListEl = null;
    void this.persistExpanded(false).finally(() => window.location.assign(url));
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

  private openAddCustomerModal(): void {
    const modal = openModal('新增客戶');
    const name = el('input', { type: 'text', placeholder: '例如：Example Client' });
    const path = el('input', { type: 'text', placeholder: `${wikiConfig.customers.basePath}/example-client` });
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
    );

    const cancel = el('button', { class: 'fwa-btn', text: '取消' });
    const save = el('button', { class: 'fwa-btn fwa-btn-primary', text: '新增' });
    cancel.addEventListener('click', () => modal.close());
    save.addEventListener('click', async () => {
      const trimmedName = name.value.trim();
      const trimmedPath = path.value.trim().replace(/\/+$/, '');
      if (!trimmedName) {
        name.style.borderColor = '#cf222e';
        return;
      }
      if (!trimmedPath.startsWith('/')) {
        path.style.borderColor = '#cf222e';
        return;
      }
      await createCustomer({ name: trimmedName, pagePath: trimmedPath });
      modal.close();
      showToast(`已新增客戶：${trimmedName}`, 'success');
      void this.renderCustomerList();
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

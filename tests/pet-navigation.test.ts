// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainNav, customerPanelPosition } from '../src/content/main-nav';
import { DEFAULT_SETTINGS } from '../src/shared/types';

let nav: MainNav;
let settings = { ...DEFAULT_SETTINGS };
let records: Record<string, unknown> = {};
const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();

function root(id: string): ShadowRoot | null {
  return document.getElementById(id)?.shadowRoot ?? null;
}

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS };
  records = {};
  vi.stubGlobal('chrome', {
    runtime: { id: 'test', getURL: (path: string) => `https://extension.test/${path}` },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: key === 'fwa:settings' ? settings : records[key] }),
        set: async (items: Record<string, unknown>) => {
          Object.assign(records, items);
          if (items['fwa:settings']) {
            const oldValue = settings;
            settings = items['fwa:settings'] as typeof settings;
            listeners.forEach((listener) => listener({ 'fwa:settings': { oldValue, newValue: settings } }, 'local'));
          }
        },
      },
      onChanged: { addListener: (listener: typeof listeners extends Set<infer T> ? T : never) => listeners.add(listener), removeListener: (listener: typeof listeners extends Set<infer T> ? T : never) => listeners.delete(listener) },
    },
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0);
  nav = new MainNav();
  nav.attach();
});

describe('compact customer action menus', () => {
  it('toggles the transient directory without saving settings or replacing the Pet', async () => {
    await nav.refreshPetVisibility();
    const save = vi.spyOn(chrome.storage.local, 'set');
    const petButton = root('fwa-pet-host')!.querySelector<HTMLButtonElement>('button')!;
    petButton.click();
    expect(root('fwa-customer-panel-host')).not.toBeNull();
    petButton.click();
    expect(root('fwa-customer-panel-host')).toBeNull();
    petButton.click();
    await Promise.resolve();
    expect(root('fwa-customer-panel-host')).not.toBeNull();
    expect(root('fwa-pet-host')!.querySelector('button')).toBe(petButton);
    expect(save).not.toHaveBeenCalled();
  });

  async function openDirectory(): Promise<ShadowRoot> {
    await nav.refreshPetVisibility();
    root('fwa-pet-host')!.querySelector<HTMLButtonElement>('button')!.click();
    return root('fwa-customer-panel-host')!;
  }

  function key(element: Element, value: string): void {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, composed: true, cancelable: true }));
  }

  it('keeps occasional actions in a keyboard-accessible menu and dismisses only that menu on Escape', async () => {
    const directory = await openDirectory();
    const more = directory.querySelector<HTMLButtonElement>('[aria-label="更多客戶目錄操作"]')!;
    expect(directory.querySelector('.fwa-customer-toolbar')).toBeNull();
    expect(directory.querySelector('.fwa-directory-topbar')?.textContent).not.toContain('DIRECTORY');
    expect(directory.querySelector('[role="menu"]')).toBeNull();
    more.focus();
    key(more, 'ArrowDown');
    const items = Array.from(directory.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(items.map((item) => item.textContent)).toEqual(['收藏目前頁面', '新增資料夾', '匯入客戶', '匯出客戶']);
    expect(directory.activeElement).toBe(items[0]);
    key(items[0], 'ArrowDown');
    expect(directory.activeElement).toBe(items[1]);
    key(items[1], 'End');
    expect(directory.activeElement).toBe(items[3]);
    key(items[3], 'ArrowDown');
    expect(directory.activeElement).toBe(items[0]);
    key(items[0], 'Escape');
    expect(directory.querySelector('[role="menu"]')).toBeNull();
    expect(root('fwa-customer-panel-host')).toBe(directory);
    expect(directory.activeElement).toBe(more);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    key(more, 'Escape');
    expect(root('fwa-customer-panel-host')).toBeNull();
  });

  it('closes the menu when using search or tabbing away without dismissing the directory', async () => {
    const directory = await openDirectory();
    const more = directory.querySelector<HTMLButtonElement>('[aria-label="更多客戶目錄操作"]')!;
    more.click();
    const lastItem = directory.querySelector<HTMLElement>('[role="menuitem"]')!;
    key(lastItem, 'Tab');
    expect(directory.querySelector('[role="menu"]')).toBeNull();
    expect(root('fwa-customer-panel-host')).toBe(directory);
    more.click();
    directory.querySelector('input')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    expect(directory.querySelector('[role="menu"]')).toBeNull();
    expect(root('fwa-customer-panel-host')).toBe(directory);
  });

  it('closes the action menu before a form opens and restores focus to its persistent trigger', async () => {
    const directory = await openDirectory();
    const more = directory.querySelector<HTMLButtonElement>('[aria-label="更多客戶目錄操作"]')!;
    more.click();
    Array.from(directory.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((item) => item.textContent === '新增資料夾')!.click();
    const form = root('fwa-modal-host')!;
    expect(form.querySelector('.fwa-modal-title')?.textContent).toContain('資料夾');
    expect(directory.querySelector('[role="menu"]')).toBeNull();
    key(form.querySelector('.fwa-modal')!, 'Escape');
    expect(root('fwa-customer-panel-host')).toBe(directory);
    expect(directory.activeElement).toBe(more);
  });

  it('preserves customer and branch operations with disabled reorder boundaries', async () => {
    records['fwa:customers'] = [{ id: 'client-a', name: 'Acme', pagePath: '/clients/acme', createdAt: '2026-01-01' }];
    records['fwa:customerBranches'] = { ACME: [{ id: 'branch-a', name: 'SOP', target: '/clients/acme/sop', createdAt: '2026-01-01' }] };
    const directory = await openDirectory();
    await vi.waitFor(() => expect(directory.querySelector('.fwa-customer-link')?.textContent).toBe('Acme'));
    const more = directory.querySelector<HTMLButtonElement>('[aria-label="Acme 的更多操作"]')!;
    more.click();
    expect(Array.from(directory.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent)).toEqual(['編輯客戶', '新增分支', '刪除客戶']);
    key(directory.querySelector('[role="menuitem"]')!, 'Escape');
    directory.querySelector<HTMLButtonElement>('.fwa-branch-toggle')!.click();
    directory.querySelector<HTMLButtonElement>('[aria-label="SOP 的分支操作"]')!.click();
    const items = Array.from(directory.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(items.map((item) => item.textContent)).toEqual(['編輯分支', '上移', '下移', '刪除分支']);
    expect(items[1].disabled).toBe(true);
    expect(items[2].disabled).toBe(true);
    key(items[0], 'ArrowDown');
    expect(directory.activeElement).toBe(items[3]);
  });
});

afterEach(async () => {
  nav.detach();
  // Detach persists the closed state asynchronously; drain it before removing chrome.
  await new Promise((resolve) => setTimeout(resolve, 0));
  listeners.clear();
  document.querySelectorAll('[id^="fwa-"]').forEach((element) => element.remove());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Pet directory and visibility controls', () => {
  it('shows the current navigation color in the header control instead of a palette glyph', async () => {
    nav.detach();
    settings = { ...settings, sidebarColor: '#ef4444', sidebarGradientColor: '#c43838' };
    document.body.innerHTML = '<header class="nav-header"><div class="v-toolbar__content"><div class="v-toolbar__title">Wiki</div></div></header>';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.matches('header.nav-header')) return new DOMRect(0, 0, 1200, 64);
      return new DOMRect(0, 0, 180, 32);
    });
    nav = new MainNav();
    nav.attach();
    await nav.refreshSidebarColorControl();

    const control = document.querySelector<HTMLButtonElement>('.fwa-header-color-swatch')!;
    expect(control.querySelector('.fwa-header-color-chip')).not.toBeNull();
    expect(control.querySelector('svg')).toBeNull();
    expect(control.style.getPropertyValue('--fwa-color-start')).toBe('#ef4444');
    expect(control.style.getPropertyValue('--fwa-color-end')).toBe('#c43838');
    expect(control.getAttribute('aria-label')).toContain('#ef4444 → #c43838');
  });

  it('opens the customer dialog directly and returns focus to Pet after Escape', async () => {
    await nav.refreshPetVisibility();
    const pet = root('fwa-pet-host')!.querySelector<HTMLButtonElement>('button')!;
    pet.focus();
    pet.click();
    const directory = root('fwa-customer-panel-host')!.querySelector('[role="dialog"]');
    expect(directory?.getAttribute('aria-modal')).toBe('false');
    expect(root('fwa-workspace-host')).toBeNull();
    expect(pet.getAttribute('aria-expanded')).toBe('true');
    expect(root('fwa-customer-panel-host')!.activeElement?.tagName).toBe('INPUT');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root('fwa-customer-panel-host')).toBeNull();
    expect(root('fwa-pet-host')!.activeElement).toBe(pet);
    expect(pet.getAttribute('aria-expanded')).toBe('false');
  });

  it('can hide and restore Pet through the always-available keyboard workbench', async () => {
    await nav.refreshPetVisibility();
    const openWorkspace = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    const action = (text: string) => Array.from(root('fwa-workspace-host')!.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes(text))!;
    openWorkspace();
    action('隱藏 Pet').click();
    await vi.waitFor(() => expect(root('fwa-pet-host')!.querySelector<HTMLButtonElement>('button')!.hidden).toBe(true));
    expect(settings.showPet).toBe(false);
    openWorkspace();
    expect(action('客戶目錄')).toBeDefined();
    action('顯示 Pet').click();
    await vi.waitFor(() => expect(root('fwa-pet-host')!.querySelector<HTMLButtonElement>('button')!.hidden).toBe(false));
    expect(settings.showPet).toBe(true);
  });

  it('responds to visibility changes from the settings page without rebuilding navigation', async () => {
    await nav.refreshPetVisibility();
    const pet = root('fwa-pet-host')!.querySelector<HTMLButtonElement>('button')!;
    await chrome.storage.local.set({ 'fwa:settings': { ...settings, showPet: false } });
    await vi.waitFor(() => expect(pet.hidden).toBe(true));
    expect(root('fwa-pet-host')!.querySelector('button')).toBe(pet);
    await chrome.storage.local.set({ 'fwa:settings': { ...settings, showPet: true } });
    await vi.waitFor(() => expect(pet.hidden).toBe(false));
  });
});

describe('floating customer panel placement', () => {
  it('sits to the left of a bottom-right Pet', () => {
    const position = customerPanelPosition({ left: 1100, right: 1172, top: 700, bottom: 772 }, { width: 1200, height: 800 }, 64);
    expect(position.left + position.width).toBe(1088);
    expect(position.top + position.height).toBe(772);
  });

  it('moves to the right when Pet is near the left edge', () => {
    const position = customerPanelPosition({ left: 12, right: 84, top: 700, bottom: 772 }, { width: 1200, height: 800 }, 64);
    expect(position.left).toBe(96);
  });

  it('fits small screens and stays below wrapped native save controls', () => {
    const position = customerPanelPosition({ left: 276, right: 348, top: 520, bottom: 592 }, { width: 360, height: 640 }, 104);
    expect(position.width).toBe(336);
    expect(position.left).toBe(12);
    expect(position.top).toBeGreaterThanOrEqual(116);
    expect(position.top + position.height).toBeLessThanOrEqual(628);
  });
});

// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import settingsHtml from '../src/settings/settings.html?raw';
import { STORAGE_KEYS } from '../src/shared/storage';
import type { Settings } from '../src/shared/types';

const store = new Map<string, unknown>();
const storageListeners: Array<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void> = [];

beforeAll(async () => {
  vi.stubGlobal('chrome', {
    storage: {
      onChanged: { addListener: (callback: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => storageListeners.push(callback) },
      local: {
        get: async (key: string) => ({ [key]: store.get(key) }),
        set: async (items: Record<string, unknown>) => {
          const changes: Record<string, chrome.storage.StorageChange> = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: store.get(key), newValue: value };
            store.set(key, value);
          }
          for (const listener of storageListeners) listener(changes, 'local');
        },
      },
    },
    runtime: { sendMessage: vi.fn() },
  });
  document.open();
  document.write(settingsHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, ''));
  document.close();
  await import('../src/settings/settings');
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#aiProviderOrnith')).not.toBeNull());
});

afterAll(() => {
  storageListeners.length = 0;
  vi.unstubAllGlobals();
});

function input(id: string): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>(`#${id}`);
  if (!element) throw new Error(`missing #${id}`);
  return element;
}

function fieldset(id: string): HTMLFieldSetElement {
  const element = document.querySelector<HTMLFieldSetElement>(`#${id}`);
  if (!element) throw new Error(`missing #${id}`);
  return element;
}

async function persistedSettings(): Promise<Settings> {
  await vi.waitFor(() => expect(store.has(STORAGE_KEYS.settings)).toBe(true));
  return store.get(STORAGE_KEYS.settings) as Settings;
}

describe('AI provider settings UI', () => {
  it('keeps only the four functional categories and omits the marked explanatory blocks', () => {
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(4);
    expect(document.querySelector('#tab-guide')).toBeNull();
    expect(document.querySelector('.studio-brand')).toBeNull();
    expect(document.querySelector('.rail-label')).toBeNull();
    expect(document.querySelector('.rail-foot')).toBeNull();
    expect(document.querySelector('.settings-topbar')).toBeNull();
    expect(document.querySelector('.page-heading')).toBeNull();
    expect(document.querySelector('#showPetHelp')).toBeNull();
    expect(document.querySelector('#defaultImageFolder')).toBeNull();
    expect(document.querySelector('#imageMarkdownFormat')).toBeNull();
    expect(document.body.textContent).not.toContain('使用指南');
    expect(document.body.textContent).not.toContain('快捷入口');
    expect(document.body.textContent).not.toContain('示意預覽');
  });

  it('locks the other provider after a key is saved and unlocks only after removal', async () => {
    const ornithRadio = input('aiProviderOrnith');
    const azureRadio = input('aiProviderAzure');
    expect(fieldset('ornithSettings').disabled).toBe(true);
    expect(fieldset('azureSettings').disabled).toBe(true);

    ornithRadio.click();
    await vi.waitFor(() => expect(fieldset('ornithSettings').disabled).toBe(false));
    expect(fieldset('azureSettings').disabled).toBe(true);

    const ornithKey = input('ornithApiKey');
    ornithKey.value = 'ornith-secret';
    ornithKey.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(azureRadio.disabled).toBe(true));
    expect((await persistedSettings()).aiProvider).toBe('ornith');

    document.querySelector<HTMLButtonElement>('#removeOrnithSettings')?.click();
    await vi.waitFor(() => expect(azureRadio.disabled).toBe(false));
    expect((await persistedSettings()).ornithApiKey).toBe('');
    expect((await persistedSettings()).aiProvider).toBe('');

    azureRadio.click();
    await vi.waitFor(() => expect(fieldset('azureSettings').disabled).toBe(false));
    const azureKey = input('azureApiKey');
    azureKey.value = 'azure-secret';
    azureKey.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(ornithRadio.disabled).toBe(true));
    expect((await persistedSettings()).aiProvider).toBe('azure');
    expect(fieldset('ornithSettings').disabled).toBe(true);
  });

  it('keeps section navigation and keyboard focus in sync', () => {
    const appearance = document.querySelector<HTMLButtonElement>('#tab-appearance')!;
    const editor = document.querySelector<HTMLButtonElement>('#tab-editor')!;
    appearance.click();
    appearance.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(editor.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(editor);
    expect(document.querySelector<HTMLElement>('#pane-editor')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#pane-appearance')?.hidden).toBe(true);
    expect(document.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.querySelector('#tab-backup')?.getAttribute('aria-selected')).toBe('true');
  });

  it('persists editing preferences and distinguishes pending text edits from saved fields', async () => {
    const formatting = input('enableFormattingMenu');
    const previous = formatting.checked;
    formatting.click();
    await vi.waitFor(async () => expect((await persistedSettings()).enableFormattingMenu).toBe(!previous));

    const deployment = input('azureDeployment');
    deployment.value = 'azure-next';
    deployment.dispatchEvent(new Event('input'));
    expect(document.querySelector<HTMLElement>('#status')?.dataset.state).toBe('changed');
    deployment.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => expect((await persistedSettings()).azureDeployment).toBe('azure-next'));
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#status')?.dataset.state).toBe('saved'));
  });

  it('saves Pet visibility while retaining editing and provider settings', async () => {
    const pet = input('showPet');
    expect(pet.checked).toBe(true);
    const before = await persistedSettings();

    pet.click();
    await vi.waitFor(async () => expect((await persistedSettings()).showPet).toBe(false));
    expect((await persistedSettings()).aiProvider).toBe(before.aiProvider);
    expect((await persistedSettings()).enableFormattingMenu).toBe(before.enableFormattingMenu);

    pet.click();
    await vi.waitFor(async () => expect((await persistedSettings()).showPet).toBe(true));
    expect(pet.getAttribute('aria-label')).toBe('顯示 Pet');
  });

  it('reflects Pet actions from another Wiki page without losing unfinished input', async () => {
    const deployment = input('azureDeployment');
    deployment.value = 'unfinished-deployment';
    deployment.dispatchEvent(new Event('input'));
    const next = { ...(await persistedSettings()), showPet: false, petPosition: { xRatio: 0.4, yRatio: 0.6 } };
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });

    expect(input('showPet').checked).toBe(false);
    expect(deployment.value).toBe('unfinished-deployment');
    deployment.dispatchEvent(new Event('change'));
    await vi.waitFor(async () => expect((await persistedSettings()).azureDeployment).toBe('unfinished-deployment'));
    expect((await persistedSettings()).showPet).toBe(false);
    expect((await persistedSettings()).petPosition).toEqual({ xRatio: 0.4, yRatio: 0.6 });
  });
});

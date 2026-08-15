import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: store.get(key) }),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      },
    },
  },
});

import { exportFullSettings, importFullSettings } from '../src/settings/settings-backup';
import {
  getCustomerBranches,
  getCustomerFolders,
  getCustomers,
  getSettings,
  getTemplates,
  saveCustomerBranches,
  saveCustomerFolders,
  saveCustomers,
  saveSettings,
  saveTemplates,
} from '../src/shared/storage';
import { DEFAULT_SETTINGS } from '../src/shared/types';

beforeEach(() => store.clear());

describe('settings-backup', () => {
  it('uses the current brand palette for fresh installs', async () => {
    expect((await getSettings()).sidebarColor).toBe('#a93d3d');
    expect((await getSettings()).sidebarGradientColor).toBe('#531abc');
    expect(DEFAULT_SETTINGS.sidebarColor).toBe('#a93d3d');
    expect(DEFAULT_SETTINGS.sidebarGradientColor).toBe('#531abc');
  });

  it('can export the complete snapshot without exposing the API key', async () => {
    const settings = await getSettings();
    settings.azureApiKey = 'secret-api-key';
    settings.sidebarColor = '#a93d3d';
    await saveSettings(settings);

    const payload = JSON.parse(await exportFullSettings({ includeApiKey: false }));

    expect(payload.settings.azureApiKey).toBe('');
    expect((await getSettings()).azureApiKey).toBe('secret-api-key');
    expect(payload.settings.sidebarColor).toBe('#a93d3d');
  });

  it('round-trips all local settings in one portable JSON file', async () => {
    const settings = await getSettings();
    settings.sidebarColor = '#a93d3d';
    settings.sidebarGradientColor = '#531abc';
    settings.customSwatches = ['#a1b2c3'];
    await saveSettings(settings);
    await saveTemplates([
      {
        id: 'tpl-1',
        name: 'SOP',
        category: '工程',
        description: 'desc',
        content: '# SOP',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await saveCustomerFolders([{ id: 'folder-1', name: '重要客戶', createdAt: '2026-01-01T00:00:00.000Z' }]);
    await saveCustomers([
      {
        id: 'cust-1',
        name: 'ExampleCo',
        pagePath: '/docs/clients/example',
        folderId: 'folder-1',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await saveCustomerBranches({
      EXAMPLECO: [{ id: 'branch-1', name: 'SOP', target: '/docs/clients/example/SOP', createdAt: '2026-01-01T00:00:00.000Z' }],
    });

    const backup = await exportFullSettings();
    store.clear();
    await importFullSettings(backup);

    expect((await getSettings()).sidebarColor).toBe('#a93d3d');
    expect((await getSettings()).customSwatches).toEqual(['#a1b2c3']);
    expect((await getTemplates()).map((template) => template.name)).toEqual(['SOP']);
    expect((await getCustomerFolders()).map((folder) => folder.name)).toEqual(['重要客戶']);
    expect((await getCustomers())[0].folderId).toBe('folder-1');
    expect(Object.keys(await getCustomerBranches())).toEqual(['EXAMPLECO']);
  });

  it('rejects an invalid backup before changing current data', async () => {
    const settings = await getSettings();
    settings.sidebarColor = '#123456';
    await saveSettings(settings);

    await expect(importFullSettings('{"format":"wrong"}')).rejects.toThrow('不是有效的');
    expect((await getSettings()).sidebarColor).toBe('#123456');
  });
});

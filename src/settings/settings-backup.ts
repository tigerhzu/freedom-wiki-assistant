import {
  getCustomerBranches,
  getCustomerFolders,
  getCustomers,
  getSettings,
  getTemplates,
  STORAGE_KEYS,
} from '../shared/storage';
import { DEFAULT_SETTINGS, type Customer, type CustomerBranch, type CustomerBranchMap, type CustomerFolder, type Settings, type Template } from '../shared/types';
import { normalizeAiProviderSettings } from '../shared/ai-provider-settings';

/** Portable snapshot of every user-owned value stored by the extension. */
export interface FullSettingsBackup {
  format: 'freedom-wiki-assistant-settings';
  version: 1;
  exportedAt: string;
  settings: Settings;
  templates: Template[];
  customers: Customer[];
  customerFolders: CustomerFolder[];
  customerBranches: CustomerBranchMap;
}

export interface FullSettingsImportResult {
  templateCount: number;
  customerCount: number;
  folderCount: number;
}

export async function exportFullSettings(options: { includeApiKey?: boolean } = {}): Promise<string> {
  const [settings, templates, customers, customerFolders, customerBranches] = await Promise.all([
    getSettings(),
    getTemplates(),
    getCustomers(),
    getCustomerFolders(),
    getCustomerBranches(),
  ]);
  if (options.includeApiKey === false) {
    settings.azureApiKey = '';
    settings.ornithApiKey = '';
  }
  const payload: FullSettingsBackup = {
    format: 'freedom-wiki-assistant-settings',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    templates,
    customers,
    customerFolders,
    customerBranches,
  };
  return JSON.stringify(payload, null, 2);
}

/** Replaces all known local data with one validated backup snapshot. */
export async function importFullSettings(json: string): Promise<FullSettingsImportResult> {
  const backup = parseFullSettingsBackup(json);

  // Keep these writes in one storage.set call so a restore cannot leave the
  // settings page and customer directory pointing at different snapshots.
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: backup.settings,
    [STORAGE_KEYS.templates]: backup.templates,
    [STORAGE_KEYS.customers]: backup.customers,
    [STORAGE_KEYS.customerFolders]: backup.customerFolders,
    [STORAGE_KEYS.customerBranches]: backup.customerBranches,
  });

  return {
    templateCount: backup.templates.length,
    customerCount: backup.customers.length,
    folderCount: backup.customerFolders.length,
  };
}

function parseFullSettingsBackup(json: string): FullSettingsBackup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('設定檔不是有效的 JSON');
  }
  if (!isRecord(parsed) || parsed.format !== 'freedom-wiki-assistant-settings' || parsed.version !== 1) {
    throw new Error('不是有效的 Freedom Wiki Assistant 設定檔');
  }

  return {
    format: 'freedom-wiki-assistant-settings',
    version: 1,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
    settings: normalizeSettings(parsed.settings),
    templates: normalizeTemplates(parsed.templates),
    customers: normalizeCustomers(parsed.customers),
    customerFolders: normalizeCustomerFolders(parsed.customerFolders),
    customerBranches: normalizeCustomerBranches(parsed.customerBranches),
  };
}

function normalizeSettings(value: unknown): Settings {
  if (!isRecord(value)) throw new Error('設定檔缺少有效的 settings');
  let settings = { ...DEFAULT_SETTINGS, ...value } as Settings;
  const booleanKeys: Array<keyof Settings> = [
    'enableFormattingMenu',
    'enableImageDrop',
    'enableClipboardImage',
    'customersPanelOpen',
    'showPet',
    'debugMode',
  ];
  const stringKeys: Array<keyof Settings> = [
    'defaultImageFolder',
    'imageMarkdownFormat',
    'defaultTextColor',
    'sidebarColor',
    'sidebarGradientColor',
    'ornithBaseUrl',
    'ornithModel',
    'ornithApiKey',
    'azureEndpoint',
    'azureDeployment',
    'azureApiKey',
    'azureApiVersion',
  ];
  for (const key of booleanKeys) {
    if (typeof settings[key] !== 'boolean') throw new Error(`設定檔的 ${String(key)} 格式不正確`);
  }
  for (const key of stringKeys) {
    if (typeof settings[key] !== 'string') throw new Error(`設定檔的 ${String(key)} 格式不正確`);
  }
  if (!Number.isInteger(settings.onboardingVersion) || settings.onboardingVersion < 0) {
    throw new Error('設定檔的 onboardingVersion 格式不正確');
  }
  if (!['classic', 'hybrid', 'raw'].includes(settings.editorMode)) {
    throw new Error('設定檔的 editorMode 格式不正確');
  }
  if (!['currentPath', 'parentFolder', 'manual'].includes(settings.folderStrategy)) {
    throw new Error('設定檔的 folderStrategy 格式不正確');
  }
  if (!Array.isArray(settings.customSwatches) || !settings.customSwatches.every((value) => typeof value === 'string')) {
    throw new Error('設定檔的 customSwatches 格式不正確');
  }
  if (!Array.isArray(settings.recentFolders) || !settings.recentFolders.every((value) => typeof value === 'string')) {
    throw new Error('設定檔的 recentFolders 格式不正確');
  }
  if (settings.petPosition !== null && !isRecord(settings.petPosition)) {
    throw new Error('設定檔的 petPosition 格式不正確');
  }
  if (!['', 'ornith', 'azure'].includes(settings.aiProvider)) {
    throw new Error('設定檔的 aiProvider 格式不正確');
  }
  settings = normalizeAiProviderSettings(settings, {
    legacyAzureDefault: !Object.prototype.hasOwnProperty.call(value, 'aiProvider'),
  });
  return settings;
}

function normalizeTemplates(value: unknown): Template[] {
  if (!Array.isArray(value)) throw new Error('設定檔缺少有效的 templates');
  return value.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.category !== 'string' ||
      typeof item.description !== 'string' ||
      typeof item.content !== 'string' ||
      typeof item.createdAt !== 'string' ||
      typeof item.updatedAt !== 'string'
    ) {
      throw new Error(`設定檔第 ${index + 1} 筆模板格式不正確`);
    }
    return {
      id: item.id,
      name: item.name,
      category: item.category,
      description: item.description,
      content: item.content,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  });
}

function normalizeCustomers(value: unknown): Customer[] {
  if (!Array.isArray(value)) throw new Error('設定檔缺少有效的 customers');
  return value.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.pagePath !== 'string' ||
      typeof item.createdAt !== 'string' ||
      (item.folderId !== undefined && typeof item.folderId !== 'string')
    ) {
      throw new Error(`設定檔第 ${index + 1} 筆客戶格式不正確`);
    }
    return {
      id: item.id,
      name: item.name,
      pagePath: item.pagePath,
      createdAt: item.createdAt,
      ...(item.folderId ? { folderId: item.folderId } : {}),
    };
  });
}

function normalizeCustomerFolders(value: unknown): CustomerFolder[] {
  if (!Array.isArray(value)) throw new Error('設定檔缺少有效的 customerFolders');
  return value.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.createdAt !== 'string'
    ) {
      throw new Error(`設定檔第 ${index + 1} 筆資料夾格式不正確`);
    }
    return { id: item.id, name: item.name, createdAt: item.createdAt };
  });
}

function normalizeCustomerBranches(value: unknown): CustomerBranchMap {
  if (!isRecord(value)) throw new Error('設定檔缺少有效的 customerBranches');
  const branches = Object.create(null) as CustomerBranchMap;
  for (const [customerKey, rawList] of Object.entries(value)) {
    if (!Array.isArray(rawList)) throw new Error(`客戶 ${customerKey} 的分支格式不正確`);
    branches[customerKey] = rawList.map((item, index) => {
      if (
        !isRecord(item) ||
        typeof item.id !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.target !== 'string' ||
        typeof item.createdAt !== 'string'
      ) {
        throw new Error(`客戶 ${customerKey} 的第 ${index + 1} 個分支格式不正確`);
      }
      return {
        id: item.id,
        name: item.name,
        target: item.target,
        createdAt: item.createdAt,
      } satisfies CustomerBranch;
    });
  }
  return branches;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

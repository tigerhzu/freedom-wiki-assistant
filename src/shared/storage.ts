import {
  DEFAULT_SETTINGS,
  type Customer,
  type CustomerBranchMap,
  type CustomerFolder,
  type Settings,
  type Template,
} from './types';
import { normalizeAiProviderSettings } from './ai-provider-settings';

/** Typed wrapper around chrome.storage.local. Nothing else touches storage directly. */

const KEYS = {
  settings: 'fwa:settings',
  templates: 'fwa:templates',
  customers: 'fwa:customers',
  customerFolders: 'fwa:customerFolders',
  customerBranches: 'fwa:customerBranches',
} as const;

export async function getSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(KEYS.settings);
  const stored = raw[KEYS.settings] as Partial<Settings> | undefined;
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  merged.showPet = typeof stored?.showPet === 'boolean' ? stored.showPet : DEFAULT_SETTINGS.showPet;
  return normalizeAiProviderSettings(merged, {
    legacyAzureDefault: !!stored && !Object.prototype.hasOwnProperty.call(stored, 'aiProvider'),
    // A manually edited/corrupt storage record must never make both providers usable.
    clearConflictingKeys: true,
  });
}

export async function saveSettings(settings: Settings): Promise<void> {
  const normalized = normalizeAiProviderSettings(settings);
  await chrome.storage.local.set({ [KEYS.settings]: normalized });
}

export async function getTemplates(): Promise<Template[]> {
  const raw = await chrome.storage.local.get(KEYS.templates);
  return (raw[KEYS.templates] as Template[] | undefined) ?? [];
}

export async function saveTemplates(templates: Template[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.templates]: templates });
}

export async function getCustomers(): Promise<Customer[]> {
  const raw = await chrome.storage.local.get(KEYS.customers);
  return (raw[KEYS.customers] as Customer[] | undefined) ?? [];
}

export async function saveCustomers(customers: Customer[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.customers]: customers });
}

export async function getCustomerFolders(): Promise<CustomerFolder[]> {
  const raw = await chrome.storage.local.get(KEYS.customerFolders);
  return (raw[KEYS.customerFolders] as CustomerFolder[] | undefined) ?? [];
}

export async function saveCustomerFolders(folders: CustomerFolder[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.customerFolders]: folders });
}

/** Sub-pages per customer code. Separate key from `customers` so the existing customer list is never rewritten by branch edits. */
export async function getCustomerBranches(): Promise<CustomerBranchMap> {
  const raw = await chrome.storage.local.get(KEYS.customerBranches);
  return (raw[KEYS.customerBranches] as CustomerBranchMap | undefined) ?? {};
}

export async function saveCustomerBranches(branches: CustomerBranchMap): Promise<void> {
  await chrome.storage.local.set({ [KEYS.customerBranches]: branches });
}

export function onStorageChanged(
  cb: (changedKeys: string[], changes: Record<string, chrome.storage.StorageChange>) => void,
): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') cb(Object.keys(changes), changes);
  });
}

export const STORAGE_KEYS = KEYS;

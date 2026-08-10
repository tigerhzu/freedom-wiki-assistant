import {
  DEFAULT_SETTINGS,
  type Customer,
  type CustomerBranchMap,
  type Settings,
  type Template,
} from './types';

/** Typed wrapper around chrome.storage.local. Nothing else touches storage directly. */

const KEYS = {
  settings: 'fwa:settings',
  templates: 'fwa:templates',
  customers: 'fwa:customers',
  customerBranches: 'fwa:customerBranches',
} as const;

export async function getSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(raw[KEYS.settings] as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEYS.settings]: settings });
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

/** Sub-pages per customer code. Separate key from `customers` so the existing customer list is never rewritten by branch edits. */
export async function getCustomerBranches(): Promise<CustomerBranchMap> {
  const raw = await chrome.storage.local.get(KEYS.customerBranches);
  return (raw[KEYS.customerBranches] as CustomerBranchMap | undefined) ?? {};
}

export async function saveCustomerBranches(branches: CustomerBranchMap): Promise<void> {
  await chrome.storage.local.set({ [KEYS.customerBranches]: branches });
}

export function onStorageChanged(cb: (changedKeys: string[]) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') cb(Object.keys(changes));
  });
}

export const STORAGE_KEYS = KEYS;

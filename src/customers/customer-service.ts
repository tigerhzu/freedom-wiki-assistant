import { sanitizePathSegments, wikiConfig } from '../config/wiki-config';
import {
  getCustomerBranches,
  getCustomerFolders,
  getCustomers,
  saveCustomerBranches,
  saveCustomerFolders,
  saveCustomers,
} from '../shared/storage';
import type { Customer, CustomerBranch, CustomerBranchMap, CustomerFolder } from '../shared/types';

/**
 * CRUD for the "客戶" nav directory and each customer's branches (sub-pages).
 * Entries live in chrome.storage.local (never hardcoded in source) so they
 * survive reloads, mirroring templates/template-service.ts.
 */

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function listCustomers(): Promise<Customer[]> {
  return getCustomers();
}

export async function listCustomerFolders(): Promise<CustomerFolder[]> {
  return getCustomerFolders();
}

export interface CustomerInput {
  name: string;
  pagePath: string;
  folderId?: string | null;
}

export interface CustomerFolderInput {
  name: string;
}

export interface CustomerExportBranch {
  name: string;
  target: string;
}

export interface CustomerExportEntry {
  name: string;
  pagePath: string;
  branches: CustomerExportBranch[];
  /** Folder name is used instead of the local folder ID so backups stay portable. */
  folder?: string;
}

/** Portable backup format. IDs and timestamps are intentionally omitted on export. */
export interface CustomerExport {
  format: 'freedom-wiki-assistant-customers';
  version: 1;
  exportedAt: string;
  customers: CustomerExportEntry[];
  folders?: Array<{ name: string }>;
}

export interface CustomerImportResult {
  customersAdded: number;
  branchesAdded: number;
  customersSkipped: number;
  branchesSkipped: number;
}

export async function createCustomer(input: CustomerInput): Promise<Customer> {
  const { name, pagePath, folderId } = validateCustomerInput(input);
  await assertFolderExists(folderId);
  const customer: Customer = {
    id: newId('cust'),
    createdAt: new Date().toISOString(),
    name,
    pagePath,
    ...(folderId ? { folderId } : {}),
  };
  const all = await getCustomers();
  await saveCustomers([...all, customer]);
  return customer;
}

export async function createCustomerFolder(input: CustomerFolderInput): Promise<CustomerFolder> {
  const name = normalizeFolderName(input.name);
  if (!name) throw new Error('資料夾名稱不可為空');
  const folders = await getCustomerFolders();
  if (folders.some((folder) => folder.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new Error('已有同名資料夾');
  }
  const folder: CustomerFolder = { id: newId('folder'), name, createdAt: new Date().toISOString() };
  await saveCustomerFolders([...folders, folder]);
  return folder;
}

/** Updates a customer and keeps its branch bucket attached when its name changes. */
export async function updateCustomer(id: string, input: CustomerInput): Promise<void> {
  const { name, pagePath, folderId } = validateCustomerInput(input);
  await assertFolderExists(folderId);
  const all = await getCustomers();
  const current = all.find((customer) => customer.id === id);
  if (!current) return;
  const nextKey = customerBranchKey(name);
  if (all.some((customer) => customer.id !== id && customerBranchKey(customer.name) === nextKey)) {
    throw new Error('已有同名客戶');
  }

  const updated: Customer = {
    ...current,
    name,
    pagePath,
    ...(folderId ? { folderId } : {}),
  };
  const nextCustomers = all.map((customer) => (customer.id === id ? updated : customer));
  const oldKey = customerBranchKey(current.name);
  if (oldKey !== nextKey) {
    const branches = await getCustomerBranches();
    const oldBucket = branches[oldKey];
    const oldKeyStillUsed = all.some(
      (customer) => customer.id !== id && customerBranchKey(customer.name) === oldKey,
    );
    if (oldBucket && !oldKeyStillUsed) {
      const nextBranches = { ...branches, [nextKey]: oldBucket };
      delete nextBranches[oldKey];
      await Promise.all([saveCustomers(nextCustomers), saveCustomerBranches(nextBranches)]);
      return;
    }
  }
  await saveCustomers(nextCustomers);
}

/** Reorders the customer array; array order is the display order within folders. */
export async function moveCustomer(id: string, delta: number): Promise<void> {
  const all = await getCustomers();
  const from = all.findIndex((customer) => customer.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= all.length) return;
  const reordered = [...all];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  await saveCustomers(reordered);
}

/** Moves a customer before/after another row and optionally changes its folder. */
export async function reorderCustomer(
  id: string,
  targetId: string | null,
  position: 'before' | 'after' = 'before',
  folderId?: string | null,
): Promise<void> {
  const all = await getCustomers();
  const moving = all.find((customer) => customer.id === id);
  if (!moving) return;
  await assertFolderExists(folderId);
  const nextFolderId = folderId === undefined ? moving.folderId : normalizeFolderId(folderId);
  const withoutMoving = all.filter((customer) => customer.id !== id);
  const moved: Customer = nextFolderId
    ? { ...moving, folderId: nextFolderId }
    : (() => {
        const withoutFolder = { ...moving };
        delete withoutFolder.folderId;
        return withoutFolder;
      })();

  if (targetId && targetId !== id) {
    const targetIndex = withoutMoving.findIndex((customer) => customer.id === targetId);
    if (targetIndex >= 0) {
      withoutMoving.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, moved);
      await saveCustomers(withoutMoving);
      return;
    }
  }

  // A drop on a folder's empty area appends after the last customer in that folder.
  let insertionIndex = -1;
  for (let index = 0; index < withoutMoving.length; index += 1) {
    if (normalizeFolderId(withoutMoving[index].folderId) === normalizeFolderId(nextFolderId)) {
      insertionIndex = index + 1;
    }
  }
  withoutMoving.splice(insertionIndex < 0 ? withoutMoving.length : insertionIndex, 0, moved);
  await saveCustomers(withoutMoving);
}

/**
 * Removes the directory entry and, unless another entry still shares the same
 * customer code, its branch bucket — otherwise deleted customers would leave
 * unreachable branch data behind forever.
 */
export async function deleteCustomer(id: string): Promise<void> {
  const all = await getCustomers();
  const removed = all.find((c) => c.id === id);
  await saveCustomers(all.filter((c) => c.id !== id));
  if (!removed) return;

  const key = customerBranchKey(removed.name);
  const stillUsed = all.some((c) => c.id !== id && customerBranchKey(c.name) === key);
  if (stillUsed) return;
  const branches = await getCustomerBranches();
  if (!(key in branches)) return;
  const next = { ...branches };
  delete next[key];
  await saveCustomerBranches(next);
}

/* ── import / export ── */

/** Exports the directory and its branches without local-only IDs or timestamps. */
export async function exportCustomers(): Promise<string> {
  const [customers, folders, branchMap] = await Promise.all([
    getCustomers(),
    getCustomerFolders(),
    getCustomerBranches(),
  ]);
  const folderNames = new Map(folders.map((folder) => [folder.id, folder.name]));
  const payload: CustomerExport = {
    format: 'freedom-wiki-assistant-customers',
    version: 1,
    exportedAt: new Date().toISOString(),
    folders: folders.map(({ name }) => ({ name })),
    customers: customers.map((customer) => ({
      name: customer.name,
      pagePath: customer.pagePath,
      branches: (branchMap[customerBranchKey(customer.name)] ?? []).map(({ name, target }) => ({ name, target })),
      ...(customer.folderId && folderNames.has(customer.folderId)
        ? { folder: folderNames.get(customer.folderId) }
        : {}),
    })),
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Imports a customer backup as a non-destructive merge. Customers are matched
 * by their case-insensitive customer code; branches by their name and target.
 * All input is validated before either storage key is written.
 */
export async function importCustomers(json: string): Promise<CustomerImportResult> {
  const incoming = parseCustomerExport(json);
  const [existingCustomers, existingFolders, existingBranches] = await Promise.all([
    getCustomers(),
    getCustomerFolders(),
    getCustomerBranches(),
  ]);
  const nextCustomers = [...existingCustomers];
  const nextFolders = [...existingFolders];
  const nextBranches: CustomerBranchMap = Object.fromEntries(
    Object.entries(existingBranches).map(([key, branches]) => [key, [...branches]]),
  );
  const knownFolderNames = new Map(
    nextFolders.map((folder) => [folder.name.trim().toLocaleLowerCase(), folder.id]),
  );
  const importedFolderNames = new Set([
    ...(incoming.folders ?? []).map((folder) => folder.name),
    ...incoming.customers.flatMap((customer) => (customer.folder ? [customer.folder] : [])),
  ]);
  for (const folderName of importedFolderNames) {
    const normalized = normalizeFolderName(folderName);
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (knownFolderNames.has(key)) continue;
    const folder: CustomerFolder = { id: newId('folder'), name: normalized, createdAt: new Date().toISOString() };
    nextFolders.push(folder);
    knownFolderNames.set(key, folder.id);
  }
  const knownCustomerKeys = new Set(nextCustomers.map((customer) => customerBranchKey(customer.name)));
  let customersAdded = 0;
  let branchesAdded = 0;
  let customersSkipped = 0;
  let branchesSkipped = 0;

  for (const entry of incoming.customers) {
    const key = customerBranchKey(entry.name);
    if (knownCustomerKeys.has(key)) {
      customersSkipped += 1;
    } else {
      const folderId = entry.folder ? knownFolderNames.get(entry.folder.toLocaleLowerCase()) : undefined;
      nextCustomers.push({
        id: newId('cust'),
        name: entry.name,
        pagePath: entry.pagePath,
        createdAt: new Date().toISOString(),
        ...(folderId ? { folderId } : {}),
      });
      knownCustomerKeys.add(key);
      customersAdded += 1;
    }

    const bucket = nextBranches[key] ?? [];
    const knownBranches = new Set(bucket.map((branch) => branchIdentity(branch.name, branch.target)));
    for (const branch of entry.branches) {
      const identity = branchIdentity(branch.name, branch.target);
      if (knownBranches.has(identity)) {
        branchesSkipped += 1;
        continue;
      }
      bucket.push({ id: newId('branch'), ...branch, createdAt: new Date().toISOString() });
      knownBranches.add(identity);
      branchesAdded += 1;
    }
    if (bucket.length > 0) nextBranches[key] = bucket;
  }

  await Promise.all([
    saveCustomers(nextCustomers),
    saveCustomerFolders(nextFolders),
    saveCustomerBranches(nextBranches),
  ]);
  return { customersAdded, branchesAdded, customersSkipped, branchesSkipped };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCustomerPagePath(input: string): string | null {
  const path = input.trim().replace(/\/+$/, '');
  if (!path || !path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) return null;
  return path;
}

function normalizeFolderName(input: string): string {
  return input.trim().replace(/[\r\n]+/g, ' ');
}

function normalizeFolderId(input: string | null | undefined): string | undefined {
  const trimmed = input?.trim();
  return trimmed || undefined;
}

async function assertFolderExists(folderId: string | null | undefined): Promise<void> {
  const normalized = normalizeFolderId(folderId);
  if (!normalized) return;
  const folders = await getCustomerFolders();
  if (!folders.some((folder) => folder.id === normalized)) throw new Error('指定的資料夾不存在');
}

function validateCustomerInput(input: CustomerInput): {
  name: string;
  pagePath: string;
  folderId?: string;
} {
  const name = input.name.trim();
  const pagePath = normalizeCustomerPagePath(input.pagePath);
  if (!name) throw new Error('客戶名稱不可為空');
  if (!pagePath) throw new Error('Wiki 頁面路徑必須是以「/」開頭的路徑');
  const folderId = normalizeFolderId(input.folderId);
  return { name, pagePath, ...(folderId ? { folderId } : {}) };
}

function branchIdentity(name: string, target: string): string {
  return `${name}\u0000${target}`;
}

function parseCustomerExport(json: string): CustomerExport {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed) || parsed.format !== 'freedom-wiki-assistant-customers' || parsed.version !== 1) {
    throw new Error('不是有效的客戶匯出檔');
  }
  if (!Array.isArray(parsed.customers)) throw new Error('客戶匯出檔缺少 customers 陣列');

  const customers: CustomerExportEntry[] = parsed.customers.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.pagePath !== 'string' || !Array.isArray(raw.branches)) {
      throw new Error(`第 ${index + 1} 筆客戶資料格式不正確`);
    }
    const name = raw.name.trim();
    const pagePath = normalizeCustomerPagePath(raw.pagePath);
    if (!name || !pagePath) throw new Error(`第 ${index + 1} 筆客戶名稱或 Wiki 路徑無效`);
    const folder = raw.folder === undefined
      ? undefined
      : typeof raw.folder === 'string' && normalizeFolderName(raw.folder)
        ? normalizeFolderName(raw.folder)
        : null;
    if (folder === null) throw new Error(`第 ${index + 1} 筆客戶資料夾名稱無效`);
    const branches: CustomerExportBranch[] = raw.branches.map((branch, branchIndex) => {
      if (!isRecord(branch) || typeof branch.name !== 'string' || typeof branch.target !== 'string') {
        throw new Error(`第 ${index + 1} 筆客戶的第 ${branchIndex + 1} 個分支格式不正確`);
      }
      return validateBranchInput({ name: branch.name, target: branch.target });
    });
    return { name, pagePath, branches, ...(folder ? { folder } : {}) };
  });

  let folders: Array<{ name: string }> | undefined;
  if (parsed.folders !== undefined) {
    if (!Array.isArray(parsed.folders)) throw new Error('客戶匯出檔的 folders 格式不正確');
    folders = parsed.folders.map((folder, index) => {
      if (!isRecord(folder) || typeof folder.name !== 'string' || !normalizeFolderName(folder.name)) {
        throw new Error(`第 ${index + 1} 個資料夾名稱無效`);
      }
      return { name: normalizeFolderName(folder.name) };
    });
  }

  return {
    format: 'freedom-wiki-assistant-customers',
    version: 1,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
    customers,
    ...(folders ? { folders } : {}),
  };
}

/* ── branches (客戶分支) ── */

/**
 * The storage bucket key for a customer: its code, case-folded so differently
 * cased names use the same customer bucket. Derived from the entry's name — no customer
 * code is ever hardcoded here.
 */
export function customerBranchKey(customerName: string): string {
  return customerName.trim().toUpperCase();
}

export interface CustomerBranchInput {
  /** 顯示名稱, e.g. "Account Info/Plan". */
  name: string;
  /** Wiki URL 或相對路徑. */
  target: string;
}

/**
 * Canonical stored form of a branch target, or null if it can never be a safe
 * link:
 *  - a URL on this wiki  → stored path-only, so entries keep working if the
 *                          origin ever changes (and export/import stays clean)
 *  - any other http(s) URL → kept absolute (some customer pages live elsewhere)
 *  - anything else        → treated as a wiki-relative path and given a
 *                          leading "/"; other schemes (javascript:, data:…)
 *                          are rejected outright so a pasted value can never
 *                          become a script-executing link.
 */
export function normalizeBranchTarget(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.origin !== wikiConfig.origin) return url.toString();
    return stripTrailingSlash(`${url.pathname}${url.search}${url.hash}`);
  }
  // "mailto:", "javascript:", "//evil.example" — never a wiki page path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  return stripTrailingSlash(raw.startsWith('/') ? raw : `/${raw}`);
}

function stripTrailingSlash(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed || '/';
}

/** Absolute URL to navigate to for a stored target, or null if it is unusable. */
export function resolveBranchUrl(target: string): string | null {
  const normalized = normalizeBranchTarget(target);
  if (!normalized) return null;
  if (/^https?:\/\//i.test(normalized)) return normalized;
  return new URL(normalized, wikiConfig.origin).toString();
}

/**
 * View path for the page currently being looked at, used by「將目前頁面加入
 * 此客戶分支」. Wiki.js edit URLs are /e/<locale>/<path>; a branch should
 * point at the readable page (/<locale>/<path>), not back into the editor.
 */
export function viewPathForBranch(pathname: string): string {
  const segs = sanitizePathSegments(pathname);
  if (segs[0] === 'e') segs.shift();
  return segs.length > 0 ? `/${segs.join('/')}` : '/';
}

/** Every customer's branches at once — one storage read for the whole drawer. */
export async function listAllBranches(): Promise<CustomerBranchMap> {
  return getCustomerBranches();
}

export async function listBranches(customerName: string): Promise<CustomerBranch[]> {
  const all = await getCustomerBranches();
  return all[customerBranchKey(customerName)] ?? [];
}

export async function createBranch(
  customerName: string,
  input: CustomerBranchInput,
): Promise<CustomerBranch> {
  const { name, target } = validateBranchInput(input);
  const key = customerBranchKey(customerName);
  const all = await getCustomerBranches();
  const branch: CustomerBranch = {
    id: newId('branch'),
    name,
    target,
    createdAt: new Date().toISOString(),
  };
  await saveCustomerBranches({ ...all, [key]: [...(all[key] ?? []), branch] });
  return branch;
}

export async function updateBranch(
  customerName: string,
  id: string,
  input: CustomerBranchInput,
): Promise<void> {
  const { name, target } = validateBranchInput(input);
  const key = customerBranchKey(customerName);
  const all = await getCustomerBranches();
  const list = all[key];
  if (!list?.some((b) => b.id === id)) return;
  await saveCustomerBranches({
    ...all,
    [key]: list.map((b) => (b.id === id ? { ...b, name, target } : b)),
  });
}

export async function deleteBranch(customerName: string, id: string): Promise<void> {
  const key = customerBranchKey(customerName);
  const all = await getCustomerBranches();
  if (!all[key]) return;
  const remaining = all[key].filter((b) => b.id !== id);
  const next = { ...all };
  if (remaining.length > 0) next[key] = remaining;
  else delete next[key]; // keep storage free of empty buckets
  await saveCustomerBranches(next);
}

/** Reorders one branch by `delta` positions; a no-op at either end. */
export async function moveBranch(
  customerName: string,
  id: string,
  delta: number,
): Promise<void> {
  const key = customerBranchKey(customerName);
  const all = await getCustomerBranches();
  const list = all[key];
  if (!list) return;
  const from = list.findIndex((b) => b.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return;
  const reordered = [...list];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  await saveCustomerBranches({ ...all, [key]: reordered });
}

function validateBranchInput(input: CustomerBranchInput): { name: string; target: string } {
  const name = input.name.trim();
  const target = normalizeBranchTarget(input.target);
  if (!name) throw new Error('分支顯示名稱不可為空');
  if (!target) throw new Error('分支連結必須是 Wiki 路徑或 http(s) 網址');
  return { name, target };
}

import { sanitizePathSegments, wikiConfig } from '../config/wiki-config';
import {
  getCustomerBranches,
  getCustomers,
  saveCustomerBranches,
  saveCustomers,
} from '../shared/storage';
import type { Customer, CustomerBranch, CustomerBranchMap } from '../shared/types';

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

export interface CustomerInput {
  name: string;
  pagePath: string;
}

export interface CustomerExportBranch {
  name: string;
  target: string;
}

export interface CustomerExportEntry {
  name: string;
  pagePath: string;
  branches: CustomerExportBranch[];
}

/** Portable backup format. IDs and timestamps are intentionally omitted on export. */
export interface CustomerExport {
  format: 'freedom-wiki-assistant-customers';
  version: 1;
  exportedAt: string;
  customers: CustomerExportEntry[];
}

export interface CustomerImportResult {
  customersAdded: number;
  branchesAdded: number;
  customersSkipped: number;
  branchesSkipped: number;
}

export async function createCustomer(input: CustomerInput): Promise<Customer> {
  const customer: Customer = { id: newId('cust'), createdAt: new Date().toISOString(), ...input };
  const all = await getCustomers();
  await saveCustomers([...all, customer]);
  return customer;
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
  const [customers, branchMap] = await Promise.all([getCustomers(), getCustomerBranches()]);
  const payload: CustomerExport = {
    format: 'freedom-wiki-assistant-customers',
    version: 1,
    exportedAt: new Date().toISOString(),
    customers: customers.map((customer) => ({
      name: customer.name,
      pagePath: customer.pagePath,
      branches: (branchMap[customerBranchKey(customer.name)] ?? []).map(({ name, target }) => ({ name, target })),
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
  const [existingCustomers, existingBranches] = await Promise.all([getCustomers(), getCustomerBranches()]);
  const nextCustomers = [...existingCustomers];
  const nextBranches: CustomerBranchMap = Object.fromEntries(
    Object.entries(existingBranches).map(([key, branches]) => [key, [...branches]]),
  );
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
      nextCustomers.push({
        id: newId('cust'),
        name: entry.name,
        pagePath: entry.pagePath,
        createdAt: new Date().toISOString(),
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

  await Promise.all([saveCustomers(nextCustomers), saveCustomerBranches(nextBranches)]);
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
    const branches: CustomerExportBranch[] = raw.branches.map((branch, branchIndex) => {
      if (!isRecord(branch) || typeof branch.name !== 'string' || typeof branch.target !== 'string') {
        throw new Error(`第 ${index + 1} 筆客戶的第 ${branchIndex + 1} 個分支格式不正確`);
      }
      return validateBranchInput({ name: branch.name, target: branch.target });
    });
    return { name, pagePath, branches };
  });

  return {
    format: 'freedom-wiki-assistant-customers',
    version: 1,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
    customers,
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

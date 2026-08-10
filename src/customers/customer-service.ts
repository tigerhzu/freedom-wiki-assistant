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

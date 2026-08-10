import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Minimal chrome.storage.local mock so the service can be tested in Node. */
const store = new Map<string, unknown>();
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: store.get(key) }),
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) store.set(k, v);
      },
    },
  },
});

import {
  createBranch,
  createCustomer,
  customerBranchKey,
  deleteBranch,
  deleteCustomer,
  listAllBranches,
  listBranches,
  listCustomers,
  moveBranch,
  normalizeBranchTarget,
  resolveBranchUrl,
  updateBranch,
  viewPathForBranch,
} from '../src/customers/customer-service';
import { wikiConfig } from '../src/config/wiki-config';

beforeEach(() => store.clear());

describe('customer-service', () => {
  it('starts empty and is never hardcoded', async () => {
    expect(await listCustomers()).toEqual([]);
  });

  it('creates and deletes customers', async () => {
    const example = await createCustomer({ name: 'ExampleCo', pagePath: '/docs/clients/example-client' });
    const sample = await createCustomer({ name: 'SampleCo', pagePath: '/docs/clients/sample-client' });
    expect(await listCustomers()).toHaveLength(2);
    expect(example.id).not.toBe(sample.id);
    expect(new Date(example.createdAt).toString()).not.toBe('Invalid Date');

    await deleteCustomer(example.id);
    const remaining = await listCustomers();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(sample.id);
  });

  it('persists across separate calls (simulating a page reload)', async () => {
    await createCustomer({ name: 'BEN', pagePath: '/customers/ben' });
    // A fresh listCustomers() call re-reads from the (mocked) chrome.storage.local backing store.
    expect((await listCustomers())[0].name).toBe('BEN');
  });
});

describe('customer branches', () => {
  const names = (branches: { name: string }[]) => branches.map((b) => b.name);

  it('groups by customer code, not by id, and never hardcodes one', async () => {
    expect(customerBranchKey('  sampleco ')).toBe('SAMPLECO');
    await createBranch('SampleCo', { name: 'SOP', target: '/docs/clients/sample-client/SOP' });
    await createBranch('ExampleCo', { name: 'ChangeJournal', target: '/docs/clients/example-client/ChangeJournal' });

    expect(names(await listBranches('SampleCo'))).toEqual(['SOP']);
    // Same code in a different case resolves to the same bucket.
    expect(names(await listBranches('sampleco'))).toEqual(['SOP']);
    expect(names(await listBranches('ExampleCo'))).toEqual(['ChangeJournal']);
    expect(Object.keys(await listAllBranches()).sort()).toEqual(['EXAMPLECO', 'SAMPLECO']);
  });

  it('has no branches for a customer that never got any', async () => {
    expect(await listBranches('SampleCo')).toEqual([]);
  });

  it('appends in insertion order and reorders with moveBranch', async () => {
    for (const name of ['Account Info/Plan', 'ProvisioningData', 'SOP']) {
      await createBranch('SampleCo', { name, target: `/docs/clients/sample-client/${name}` });
    }
    const [first, , third] = await listBranches('SampleCo');
    expect(names(await listBranches('SampleCo'))).toEqual([
      'Account Info/Plan',
      'ProvisioningData',
      'SOP',
    ]);

    await moveBranch('SampleCo', third.id, -1);
    expect(names(await listBranches('SampleCo'))).toEqual([
      'Account Info/Plan',
      'SOP',
      'ProvisioningData',
    ]);

    // Moving past either end is a no-op rather than an error or a wrap-around.
    await moveBranch('SampleCo', first.id, -1);
    await moveBranch('SampleCo', first.id, 5);
    expect(names(await listBranches('SampleCo'))).toEqual([
      'Account Info/Plan',
      'SOP',
      'ProvisioningData',
    ]);
  });

  it('edits and deletes a single branch without touching its siblings', async () => {
    const sop = await createBranch('SampleCo', { name: 'SOP', target: '/docs/clients/sample-client/SOP' });
    await createBranch('SampleCo', { name: '客戶報表', target: '/docs/clients/sample-client/Report' });

    await updateBranch('SampleCo', sop.id, { name: 'SOP（新）', target: 'docs/clients/sample-client/SOP2/' });
    const updated = (await listBranches('SampleCo'))[0];
    expect(updated.id).toBe(sop.id);
    expect(updated.name).toBe('SOP（新）');
    expect(updated.target).toBe('/docs/clients/sample-client/SOP2');
    expect(updated.createdAt).toBe(sop.createdAt);

    await deleteBranch('SampleCo', sop.id);
    expect(names(await listBranches('SampleCo'))).toEqual(['客戶報表']);
  });

  it('rejects an empty name or an unusable link', async () => {
    await expect(createBranch('SampleCo', { name: '  ', target: '/x' })).rejects.toThrow();
    await expect(createBranch('SampleCo', { name: 'SOP', target: '   ' })).rejects.toThrow();
    await expect(
      createBranch('SampleCo', { name: 'SOP', target: 'javascript:alert(1)' }),
    ).rejects.toThrow();
    expect(await listBranches('SampleCo')).toEqual([]);
  });

  it('drops a customer\'s branches when that customer is deleted', async () => {
    const sample = await createCustomer({ name: 'SampleCo', pagePath: '/docs/clients/sample-client' });
    await createCustomer({ name: 'ExampleCo', pagePath: '/docs/clients/example-client' });
    await createBranch('SampleCo', { name: 'SOP', target: '/docs/clients/sample-client/SOP' });
    await createBranch('ExampleCo', { name: 'SOP', target: '/docs/clients/example-client/SOP' });

    await deleteCustomer(sample.id);
    expect(await listBranches('SampleCo')).toEqual([]);
    expect(names(await listBranches('ExampleCo'))).toEqual(['SOP']); // other customers untouched
    expect(Object.keys(await listAllBranches())).toEqual(['EXAMPLECO']);
  });

  it('keeps branches when another entry still shares the same code', async () => {
    const dup = await createCustomer({ name: 'SampleCo', pagePath: '/docs/clients/sample-client' });
    await createCustomer({ name: 'sampleco', pagePath: '/docs/clients/sampleco' });
    await createBranch('SampleCo', { name: 'SOP', target: '/docs/clients/sample-client/SOP' });

    await deleteCustomer(dup.id);
    expect(names(await listBranches('SampleCo'))).toEqual(['SOP']);
  });
});

describe('normalizeBranchTarget / resolveBranchUrl', () => {
  it('stores this wiki\'s own URLs as relative paths', () => {
    expect(normalizeBranchTarget(`${wikiConfig.origin}/docs/clients/sample-client/SOP`)).toBe(
      '/docs/clients/sample-client/SOP',
    );
    expect(normalizeBranchTarget(`${wikiConfig.origin}/docs/clients/sample-client/SOP#step2`)).toBe(
      '/docs/clients/sample-client/SOP#step2',
    );
  });

  it('keeps URLs from other sites absolute', () => {
    expect(normalizeBranchTarget('https://portal.example.com/sample-client')).toBe(
      'https://portal.example.com/sample-client',
    );
  });

  it('adds a leading slash and trims trailing slashes on relative input', () => {
    expect(normalizeBranchTarget('docs/clients/sample-client/SOP')).toBe('/docs/clients/sample-client/SOP');
    expect(normalizeBranchTarget('  /docs/clients/sample-client/SOP//  ')).toBe(
      '/docs/clients/sample-client/SOP',
    );
    expect(normalizeBranchTarget('/')).toBe('/');
  });

  it('rejects empty input and non-http schemes so a branch can never run script', () => {
    expect(normalizeBranchTarget('')).toBeNull();
    expect(normalizeBranchTarget('   ')).toBeNull();
    expect(normalizeBranchTarget('javascript:alert(1)')).toBeNull();
    expect(normalizeBranchTarget('JavaScript:alert(1)')).toBeNull();
    expect(normalizeBranchTarget('data:text/html,<script></script>')).toBeNull();
    expect(normalizeBranchTarget('mailto:someone@example.com')).toBeNull();
    expect(normalizeBranchTarget('//evil.example/path')).toBeNull();
  });

  it('resolves relative targets against the wiki origin and passes absolute ones through', () => {
    expect(resolveBranchUrl('/docs/clients/sample-client/SOP')).toBe(
      `${wikiConfig.origin}/docs/clients/sample-client/SOP`,
    );
    expect(resolveBranchUrl('https://portal.example.com/sample-client')).toBe(
      'https://portal.example.com/sample-client',
    );
    expect(resolveBranchUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('viewPathForBranch (「將目前頁面加入分支」)', () => {
  it('turns an edit URL into the readable page path', () => {
    expect(viewPathForBranch('/e/en/docs/clients/sample-client/SOP')).toBe('/en/docs/clients/sample-client/SOP');
  });

  it('leaves a view URL alone', () => {
    expect(viewPathForBranch('/en/docs/clients/sample-client/SOP')).toBe('/en/docs/clients/sample-client/SOP');
  });

  it('drops traversal segments and falls back to the site root', () => {
    expect(viewPathForBranch('/en/../eng/./SOP')).toBe('/en/eng/SOP');
    expect(viewPathForBranch('/')).toBe('/');
  });
});

describe('wikiConfig.customers.defaultPagePathFor (real-site path: /en/eng/Customers/<name>)', () => {
  const derive = (name: string) => wikiConfig.customers.defaultPagePathFor(name);

  it('preserves the customer name\'s case — real pages are not necessarily lowercased', () => {
    expect(derive('ExampleCo')).toBe('/docs/clients/ExampleCo');
    expect(derive('exampleco')).toBe('/docs/clients/exampleco');
  });

  it('trims surrounding whitespace', () => {
    expect(derive('  DEMO  ')).toBe('/docs/clients/DEMO');
  });

  it('replaces slashes so a name can never inject extra path segments', () => {
    expect(derive('A/B')).toBe('/docs/clients/A-B');
  });

  it('falls back to "customer" when nothing usable is left', () => {
    expect(derive('')).toBe('/docs/clients/customer');
  });
});

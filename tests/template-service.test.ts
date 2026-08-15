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
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  exportTemplates,
  filterTemplates,
  importTemplates,
  listCategories,
  listTemplates,
  reorderTemplate,
  seedDefaultTemplatesIfEmpty,
  updateTemplate,
} from '../src/templates/template-service';

beforeEach(() => store.clear());

describe('template-service', () => {
  it('seeds the default morning-meeting template once', async () => {
    await seedDefaultTemplatesIfEmpty();
    const all = await listTemplates();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('工程部晨會會議紀錄');
    expect(all[0].category).toBe('會議');

    await seedDefaultTemplatesIfEmpty();
    expect(await listTemplates()).toHaveLength(1);
  });

  it('creates, updates, duplicates and deletes templates', async () => {
    const tpl = await createTemplate({ name: 'T', category: 'C', description: 'D', content: 'X' });
    expect((await listTemplates())[0].id).toBe(tpl.id);

    await updateTemplate(tpl.id, { name: 'T2' });
    expect((await listTemplates())[0].name).toBe('T2');

    const copy = await duplicateTemplate(tpl.id);
    expect(copy?.name).toBe('T2 (複製)');
    expect(await listTemplates()).toHaveLength(2);

    await deleteTemplate(tpl.id);
    const remaining = await listTemplates();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(copy?.id);
  });

  it('reorders templates before and after another template', async () => {
    const first = await createTemplate({ name: 'A', category: '', description: '', content: 'a' });
    const second = await createTemplate({ name: 'B', category: '', description: '', content: 'b' });
    const third = await createTemplate({ name: 'C', category: '', description: '', content: 'c' });

    // createTemplate prepends, so the initial order is C, B, A.
    await reorderTemplate(first.id, third.id, 'before');
    expect((await listTemplates()).map((template) => template.name)).toEqual(['A', 'C', 'B']);

    await reorderTemplate(second.id, first.id, 'after');
    expect((await listTemplates()).map((template) => template.name)).toEqual(['A', 'B', 'C']);
  });

  it('filters by query and category', async () => {
    await createTemplate({ name: '晨會', category: '會議', description: '', content: 'abc' });
    await createTemplate({ name: '週報', category: '報告', description: '', content: 'def' });
    const all = await listTemplates();
    expect(filterTemplates(all, '晨', '')).toHaveLength(1);
    expect(filterTemplates(all, '', '報告')).toHaveLength(1);
    expect(filterTemplates(all, 'def', '報告')).toHaveLength(1);
    expect(filterTemplates(all, 'def', '會議')).toHaveLength(0);
  });

  it('normalizes categories and repairs incomplete import metadata', async () => {
    const payload = JSON.stringify({
      format: 'freedom-wiki-assistant-templates',
      version: 1,
      templates: [
        { id: 'same-id', name: ' A ', category: ' 強 ', content: 'x' },
        { id: 'same-id', name: 'B', category: '強', content: 'y' },
      ],
    });

    expect(await importTemplates(payload, 'replace')).toBe(2);
    const all = await listTemplates();
    expect(new Set(all.map((template) => template.id)).size).toBe(2);
    expect(all[0].name).toBe('A');
    expect(all[0].category).toBe('強');
    expect(all[0].createdAt).not.toBe('');
    expect(listCategories(all)).toEqual(['強']);
    expect(filterTemplates(all, '', '強')).toHaveLength(2);
  });

  it('round-trips export/import and rejects invalid JSON payloads', async () => {
    await createTemplate({ name: 'A', category: '', description: '', content: '1' });
    const json = await exportTemplates();

    store.clear();
    expect(await importTemplates(json, 'replace')).toBe(1);
    expect((await listTemplates())[0].name).toBe('A');

    // merge with duplicate ids → new ids assigned, nothing lost
    expect(await importTemplates(json, 'merge')).toBe(1);
    const all = await listTemplates();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((t) => t.id)).size).toBe(2);

    await expect(importTemplates('{"format":"nope"}', 'merge')).rejects.toThrow('不是有效的模板匯出檔');
  });
});

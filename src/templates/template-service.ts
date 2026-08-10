import { getTemplates, saveTemplates } from '../shared/storage';
import type { Template } from '../shared/types';
import { DEFAULT_TEMPLATES } from './default-templates';

/** CRUD + import/export for templates stored in chrome.storage.local. */

function newId(): string {
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function listTemplates(): Promise<Template[]> {
  return getTemplates();
}

export async function seedDefaultTemplatesIfEmpty(): Promise<void> {
  const existing = await getTemplates();
  if (existing.length === 0) {
    await saveTemplates([...DEFAULT_TEMPLATES]);
  }
}

export interface TemplateInput {
  name: string;
  category: string;
  description: string;
  content: string;
}

export async function createTemplate(input: TemplateInput): Promise<Template> {
  const now = new Date().toISOString();
  const tpl: Template = { id: newId(), createdAt: now, updatedAt: now, ...input };
  const all = await getTemplates();
  await saveTemplates([tpl, ...all]);
  return tpl;
}

export async function updateTemplate(id: string, input: Partial<TemplateInput>): Promise<Template | null> {
  const all = await getTemplates();
  const idx = all.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  const updated: Template = { ...all[idx], ...input, updatedAt: new Date().toISOString() };
  all[idx] = updated;
  await saveTemplates(all);
  return updated;
}

export async function deleteTemplate(id: string): Promise<void> {
  const all = await getTemplates();
  await saveTemplates(all.filter((t) => t.id !== id));
}

export async function duplicateTemplate(id: string): Promise<Template | null> {
  const all = await getTemplates();
  const src = all.find((t) => t.id === id);
  if (!src) return null;
  return createTemplate({
    name: `${src.name} (複製)`,
    category: src.category,
    description: src.description,
    content: src.content,
  });
}

export function filterTemplates(all: Template[], query: string, category: string): Template[] {
  const q = query.trim().toLowerCase();
  return all.filter((t) => {
    if (category && t.category !== category) return false;
    if (!q) return true;
    return (
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.content.toLowerCase().includes(q)
    );
  });
}

export function listCategories(all: Template[]): string[] {
  return [...new Set(all.map((t) => t.category).filter(Boolean))].sort();
}

/* ── import / export / backup ── */

export interface TemplateExport {
  format: 'freedom-wiki-assistant-templates';
  version: 1;
  exportedAt: string;
  templates: Template[];
}

export async function exportTemplates(): Promise<string> {
  const templates = await getTemplates();
  const payload: TemplateExport = {
    format: 'freedom-wiki-assistant-templates',
    version: 1,
    exportedAt: new Date().toISOString(),
    templates,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Import templates from an export JSON string.
 * mode 'merge': keeps existing templates; imported ones with duplicate ids get new ids.
 * mode 'replace': replaces the whole template list (used for「還原」).
 */
export async function importTemplates(json: string, mode: 'merge' | 'replace'): Promise<number> {
  const parsed = JSON.parse(json) as Partial<TemplateExport>;
  if (parsed.format !== 'freedom-wiki-assistant-templates' || !Array.isArray(parsed.templates)) {
    throw new Error('不是有效的模板匯出檔');
  }
  const incoming = parsed.templates.filter(
    (t): t is Template =>
      typeof t?.id === 'string' && typeof t?.name === 'string' && typeof t?.content === 'string',
  );

  if (mode === 'replace') {
    await saveTemplates(incoming);
    return incoming.length;
  }

  const existing = await getTemplates();
  const existingIds = new Set(existing.map((t) => t.id));
  const merged = [
    ...existing,
    ...incoming.map((t) => (existingIds.has(t.id) ? { ...t, id: newId() } : t)),
  ];
  await saveTemplates(merged);
  return incoming.length;
}

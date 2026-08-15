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

/** Moves one template before/after another template in the saved display order. */
export async function reorderTemplate(
  id: string,
  targetId: string | null,
  position: 'before' | 'after' = 'before',
): Promise<void> {
  const all = await getTemplates();
  const moving = all.find((template) => template.id === id);
  if (!moving || id === targetId) return;

  const withoutMoving = all.filter((template) => template.id !== id);
  if (targetId) {
    const targetIndex = withoutMoving.findIndex((template) => template.id === targetId);
    if (targetIndex >= 0) {
      withoutMoving.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, moving);
      await saveTemplates(withoutMoving);
      return;
    }
  }

  // Dropping on the blank area of the list places the template at the end.
  withoutMoving.push(moving);
  await saveTemplates(withoutMoving);
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
    if (category && t.category.trim() !== category) return false;
    if (!q) return true;
    return (
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.content.toLowerCase().includes(q)
    );
  });
}

export function listCategories(all: Template[]): string[] {
  return [...new Set(all.map((t) => t.category.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'zh-Hant'),
  );
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

  const importedAt = new Date().toISOString();
  const incoming = parsed.templates
    .map((value) => normalizeImportedTemplate(value, importedAt))
    .filter((template): template is Template => template !== null);

  if (mode === 'replace') {
    const usedIds = new Set<string>();
    await saveTemplates(
      incoming.map((template) => ({
        ...template,
        id: uniqueTemplateId(template.id, usedIds),
      })),
    );
    return incoming.length;
  }

  const existing = await getTemplates();
  const existingIds = new Set(existing.map((t) => t.id));
  const merged = [...existing];
  for (const template of incoming) {
    merged.push({ ...template, id: uniqueTemplateId(template.id, existingIds) });
  }
  await saveTemplates(merged);
  return incoming.length;
}

function normalizeImportedTemplate(value: unknown, fallbackDate: string): Template | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<Template>;
  if (
    typeof candidate.id !== 'string' ||
    !candidate.id.trim() ||
    typeof candidate.name !== 'string' ||
    !candidate.name.trim() ||
    typeof candidate.content !== 'string'
  ) {
    return null;
  }

  return {
    id: candidate.id.trim(),
    name: candidate.name.trim(),
    category: typeof candidate.category === 'string' ? candidate.category.trim() : '',
    description: typeof candidate.description === 'string' ? candidate.description.trim() : '',
    content: candidate.content,
    createdAt: validDateString(candidate.createdAt, fallbackDate),
    updatedAt: validDateString(candidate.updatedAt, fallbackDate),
  };
}

function validDateString(value: unknown, fallback: string): string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function uniqueTemplateId(preferred: string, usedIds: Set<string>): string {
  let id = preferred;
  while (usedIds.has(id)) id = newId();
  usedIds.add(id);
  return id;
}

import { wikiConfig } from '../config/wiki-config';
import type { Template } from '../shared/types';
import {
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  exportTemplates,
  filterTemplates,
  importTemplates,
  listCategories,
  listTemplates,
  updateTemplate,
  type TemplateInput,
} from '../templates/template-service';
import {
  resolvePlaceholders,
  SUPPORTED_PLACEHOLDERS,
  type PlaceholderContext,
} from '../templates/placeholder-service';
import type { EditorAdapter } from './editor-adapter';
import { readCurrentPageTitle } from './page-title';
import { createShadowHost, el, openModal, showToast } from './ui';

/**
 * Collapsible template panel docked at the right edge of the wiki editor.
 * Its own toggle trigger is owned by main-nav.ts (the "模板" entry in the
 * top-level nav) — this class only owns the drawer's content and behaviour.
 */
export class TemplatePanel {
  private panel: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private query = '';
  private category = '';

  constructor(private readonly adapter: EditorAdapter) {}

  isOpen(): boolean {
    return this.panel !== null;
  }

  /** Closes the drawer if open; no-op otherwise. Used by main-nav.ts for mutual exclusion with other drawers. */
  close(): void {
    if (this.panel) this.toggle();
  }

  detach(): void {
    document.getElementById('fwa-panel-host')?.remove();
    this.panel = null;
  }

  private placeholderContext(): PlaceholderContext {
    const currentUser = wikiConfig.user.resolveCurrentUser?.() ?? '';
    return { now: new Date(), pageTitle: readCurrentPageTitle(), currentUser: currentUser || '' };
  }

  toggle(): void {
    if (this.panel) {
      this.panel.remove();
      this.panel = null;
      return;
    }
    const { root } = createShadowHost('fwa-panel-host');

    const closeBtn = el('button', { class: 'fwa-btn', text: '✕' });
    const newBtn = el('button', { class: 'fwa-btn fwa-btn-primary', text: '＋ 新增' });
    const header = el('div', { class: 'fwa-panel-header' }, [
      el('span', { class: 'title', text: '文章模板' }),
      newBtn,
      closeBtn,
    ]);
    closeBtn.addEventListener('click', () => this.toggle());
    newBtn.addEventListener('click', () => this.openEditor(null));

    const search = el('input', { type: 'search', placeholder: '搜尋模板…' });
    search.addEventListener('input', () => {
      this.query = search.value;
      void this.renderList();
    });
    const catSelect = el('select');
    catSelect.addEventListener('change', () => {
      this.category = catSelect.value;
      void this.renderList();
    });
    const tools = el('div', { class: 'fwa-panel-tools' }, [search, catSelect]);

    this.listEl = el('div', { class: 'fwa-panel-list' });

    const saveCurrentBtn = el('button', { class: 'fwa-btn', text: '將目前文章存為模板' });
    saveCurrentBtn.addEventListener('click', () => {
      const content = this.adapter.getValue();
      this.openEditor(null, { content, name: this.placeholderContext().pageTitle });
    });
    const exportBtn = el('button', { class: 'fwa-btn', text: '匯出 JSON' });
    exportBtn.addEventListener('click', () => void this.doExport());
    const importBtn = el('button', { class: 'fwa-btn', text: '匯入 JSON' });
    importBtn.addEventListener('click', () => void this.doImport('merge'));
    const restoreBtn = el('button', { class: 'fwa-btn', text: '還原備份' });
    restoreBtn.addEventListener('click', () => void this.doImport('replace'));
    const footer = el('div', { class: 'fwa-panel-footer' }, [
      saveCurrentBtn,
      exportBtn,
      importBtn,
      restoreBtn,
    ]);

    this.panel = el('div', { class: 'fwa-panel' }, [header, tools, this.listEl, footer]);
    root.appendChild(this.panel);
    void this.renderList(catSelect);
  }

  private async renderList(catSelect?: HTMLSelectElement): Promise<void> {
    if (!this.listEl) return;
    const all = await listTemplates();

    if (catSelect) {
      catSelect.replaceChildren(el('option', { value: '', text: '全部分類' }));
      for (const c of listCategories(all)) {
        catSelect.appendChild(el('option', { value: c, text: c }));
      }
      catSelect.value = this.category;
    }

    const filtered = filterTemplates(all, this.query, this.category);
    this.listEl.replaceChildren();
    if (filtered.length === 0) {
      this.listEl.appendChild(el('div', { class: 'fwa-hint', text: '沒有符合的模板' }));
      return;
    }
    for (const tpl of filtered) {
      this.listEl.appendChild(this.renderItem(tpl));
    }
  }

  private renderItem(tpl: Template): HTMLElement {
    const actions = el('div', { class: 'actions' });
    const buttons: Array<[string, () => void, string?]> = [
      ['插入', () => this.insert(tpl, 'cursor'), 'fwa-btn fwa-btn-primary'],
      ['取代全文', () => this.insert(tpl, 'replace')],
      ['預覽', () => this.preview(tpl)],
      ['編輯', () => this.openEditor(tpl)],
      ['複製', () => void this.duplicate(tpl)],
      ['刪除', () => this.remove(tpl), 'fwa-btn fwa-btn-danger'],
    ];
    for (const [label, fn, cls] of buttons) {
      const btn = el('button', { class: cls ?? 'fwa-btn', text: label });
      btn.addEventListener('click', fn);
      actions.appendChild(btn);
    }
    const head = el('div', {}, [el('span', { class: 'name', text: tpl.name })]);
    if (tpl.category) head.appendChild(el('span', { class: 'cat', text: tpl.category }));
    return el('div', { class: 'fwa-tpl-item' }, [
      head,
      el('div', { class: 'desc', text: tpl.description }),
      actions,
    ]);
  }

  private insert(tpl: Template, mode: 'cursor' | 'replace'): void {
    const resolved = resolvePlaceholders(tpl.content, this.placeholderContext());
    const modal = openModal(`插入預覽：${tpl.name}`);
    modal.body.append(el('pre', { class: 'preview', text: resolved }));
    const cancel = el('button', { class: 'fwa-btn', text: '取消' });
    const ok = el('button', {
      class: 'fwa-btn fwa-btn-primary',
      text: mode === 'cursor' ? '插入游標位置' : '取代目前全文',
    });
    cancel.addEventListener('click', () => modal.close());
    ok.addEventListener('click', () => {
      modal.close();
      if (mode === 'cursor') this.adapter.insertAtCursor(resolved);
      else this.adapter.setValue(resolved);
      this.adapter.focus();
      showToast(`已套用模板：${tpl.name}`, 'success');
    });
    modal.footer.append(cancel, ok);
  }

  private preview(tpl: Template): void {
    const resolved = resolvePlaceholders(tpl.content, this.placeholderContext());
    const modal = openModal(`預覽：${tpl.name}`);
    modal.body.append(el('pre', { class: 'preview', text: resolved }));
    const close = el('button', { class: 'fwa-btn', text: '關閉' });
    close.addEventListener('click', () => modal.close());
    modal.footer.append(close);
  }

  private openEditor(tpl: Template | null, preset?: Partial<TemplateInput>): void {
    const modal = openModal(tpl ? `編輯模板：${tpl.name}` : '新增模板');
    const name = el('input', { type: 'text', value: tpl?.name ?? preset?.name ?? '' });
    const category = el('input', { type: 'text', value: tpl?.category ?? preset?.category ?? '' });
    const description = el('input', { type: 'text', value: tpl?.description ?? '' });
    const content = el('textarea');
    content.value = tpl?.content ?? preset?.content ?? '';

    modal.body.append(
      el('label', { text: '名稱' }),
      name,
      el('label', { text: '分類' }),
      category,
      el('label', { text: '說明' }),
      description,
      el('label', { text: `內容（支援變數：${SUPPORTED_PLACEHOLDERS.join(' ')}）` }),
      content,
    );

    const cancel = el('button', { class: 'fwa-btn', text: '取消' });
    const save = el('button', { class: 'fwa-btn fwa-btn-primary', text: '儲存' });
    cancel.addEventListener('click', () => modal.close());
    save.addEventListener('click', async () => {
      if (!name.value.trim()) {
        name.style.borderColor = '#cf222e';
        return;
      }
      const input: TemplateInput = {
        name: name.value.trim(),
        category: category.value.trim(),
        description: description.value.trim(),
        content: content.value,
      };
      if (tpl) await updateTemplate(tpl.id, input);
      else await createTemplate(input);
      modal.close();
      showToast('模板已儲存', 'success');
      void this.renderList();
    });
    modal.footer.append(cancel, save);
  }

  private async duplicate(tpl: Template): Promise<void> {
    await duplicateTemplate(tpl.id);
    showToast(`已複製模板：${tpl.name}`, 'success');
    void this.renderList();
  }

  private remove(tpl: Template): void {
    const modal = openModal(`刪除模板：${tpl.name}`);
    modal.body.append(el('div', { text: '確定要刪除這個模板嗎？此動作無法復原。' }));
    const cancel = el('button', { class: 'fwa-btn', text: '取消' });
    const ok = el('button', { class: 'fwa-btn fwa-btn-danger', text: '刪除' });
    cancel.addEventListener('click', () => modal.close());
    ok.addEventListener('click', async () => {
      await deleteTemplate(tpl.id);
      modal.close();
      showToast('模板已刪除', 'success');
      void this.renderList();
    });
    modal.footer.append(cancel, ok);
  }

  private async doExport(): Promise<void> {
    const json = await exportTemplates();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `fwa-templates-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(url);
    showToast('模板已匯出', 'success');
  }

  private doImport(mode: 'merge' | 'replace'): void {
    const input = el('input', { type: 'file', accept: 'application/json' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const count = await importTemplates(await file.text(), mode);
        showToast(mode === 'replace' ? `已還原 ${count} 個模板` : `已匯入 ${count} 個模板`, 'success');
        void this.renderList();
      } catch (err) {
        showToast(`匯入失敗：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    });
    input.click();
  }
}

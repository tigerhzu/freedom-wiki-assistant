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
  reorderTemplate,
  updateTemplate,
  type TemplateInput,
} from '../templates/template-service';
import {
  resolvePlaceholders,
  SUPPORTED_PLACEHOLDERS,
  type PlaceholderContext,
} from '../templates/placeholder-service';
import type { EditorAdapter } from './editor-adapter';
import { WikiDocumentSync } from './document-sync';
import { icon } from './icons';
import { readCurrentPageTitle } from './page-title';
import { createShadowHost, el, openModal, showToast } from './ui';

function formatTemplateDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '日期未知' : date.toLocaleDateString('zh-TW');
}

const PLACEHOLDER_HELP: Record<string, { label: string; description: string }> = {
  '{{date}}': { label: '標準日期', description: '今天日期，格式為 YYYY-MM-DD。' },
  '{{date_slash}}': { label: '斜線日期', description: '今天日期，格式為 YYYY/MM/DD。' },
  '{{date_compact}}': { label: '精簡日期', description: '今天日期，格式為 YYYYMMDD。' },
  '{{time}}': { label: '目前時間', description: '目前時間，格式為 HH:mm。' },
  '{{year}}': { label: '年份', description: '目前年份，例如 2026。' },
  '{{month}}': { label: '月份', description: '目前月份，例如 08。' },
  '{{day}}': { label: '日期', description: '今天是當月第幾天，例如 14。' },
  '{{weekday_zh}}': { label: '中文星期', description: '目前星期，例如 星期五。' },
  '{{page_title}}': { label: '頁面標題', description: '目前 Wiki 頁面的標題。' },
  '{{current_user}}': { label: '目前使用者', description: '目前登入者名稱，無法取得時會留白。' },
};

const PLACEHOLDER_DRAG_MIME = 'application/x-fwa-placeholder';
const SUPPORTED_PLACEHOLDER_SET = new Set<string>(SUPPORTED_PLACEHOLDERS);

/**
 * Collapsible template panel docked at the right edge of the wiki editor.
 * Its own toggle trigger is owned by main-nav.ts (the "模板" entry in the
 * top-level nav) — this class only owns the drawer's content and behaviour.
 */
export class TemplatePanel {
  private panel: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private categorySelectEl: HTMLSelectElement | null = null;
  private placeholderGuide: HTMLElement | null = null;
  private query = '';
  private category = '';
  private draggingTemplateId: string | null = null;
  private renderVersion = 0;
  private returnFocus: HTMLElement | null = null;
  private readonly positionPanel = (): void => {
    const nativeSave = document.querySelector(wikiConfig.editor.saveButtonIconSelector)?.closest('button');
    const header = nativeSave?.closest('header, nav, .v-toolbar') ?? nativeSave?.parentElement;
    const top = Math.max(64, Math.round(header?.getBoundingClientRect().bottom ?? 64)) + 12;
    this.panel?.style.setProperty('--fwa-panel-top', `${top}px`);
  };
  private readonly onPanelKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.panel) return;
    // A dialog launched by the library owns Escape until it has closed.
    if (document.getElementById('fwa-modal-host')?.shadowRoot?.querySelector('.fwa-modal-backdrop')) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  constructor(
    private readonly adapter: EditorAdapter,
    private readonly documentSync = new WikiDocumentSync(adapter),
  ) {}

  isOpen(): boolean {
    return this.panel !== null;
  }

  /** Closes the drawer if open; no-op otherwise. Used by main-nav.ts for mutual exclusion with other drawers. */
  close(): void {
    if (this.panel) this.toggle();
  }

  detach(): void {
    document.removeEventListener('keydown', this.onPanelKeyDown);
    window.removeEventListener('resize', this.positionPanel);
    this.renderVersion++;
    this.clearTemplateDragState();
    this.closePlaceholderGuide();
    document.getElementById('fwa-panel-host')?.remove();
    this.panel = null;
    this.listEl = null;
    this.summaryEl = null;
    this.categorySelectEl = null;
  }

  private placeholderContext(): PlaceholderContext {
    const currentUser = wikiConfig.user.resolveCurrentUser?.() ?? '';
    return { now: new Date(), pageTitle: readCurrentPageTitle(), currentUser: currentUser || '' };
  }

  private closePlaceholderGuide(): void {
    this.placeholderGuide?.remove();
    this.placeholderGuide = null;
  }

  private mountPlaceholderGuide(layer: HTMLElement, content: HTMLTextAreaElement): void {
    this.closePlaceholderGuide();
    const guide = el('aside', { class: 'fwa-template-placeholder-drawer' }, [
      el('div', { class: 'fwa-template-placeholder-drawer-header' }, [
        el('div', { class: 'fwa-template-placeholder-guide-title', text: '變數說明' }),
        el('div', {
          class: 'fwa-template-placeholder-guide-hint',
          text: '點擊代碼可複製，也可以直接拖曳到右側內容欄位。',
        }),
      ]),
    ]);
    const guideList = el('div', { class: 'fwa-template-placeholder-list' });
    const placeholderContext = this.placeholderContext();
    for (const token of SUPPORTED_PLACEHOLDERS) {
      const help = PLACEHOLDER_HELP[token];
      const example = resolvePlaceholders(token, placeholderContext);
      const copy = el('button', {
        class: 'fwa-template-placeholder-token',
        type: 'button',
        text: token,
        title: `複製 ${token}`,
        'aria-label': `複製 ${token}`,
      });
      copy.addEventListener('click', () => void this.copyPlaceholder(token));
      const row = el('div', {
        class: 'fwa-template-placeholder-row',
        draggable: 'true',
        title: `拖曳 ${token} 到內容欄位`,
      }, [
        copy,
        el('div', { class: 'fwa-template-placeholder-detail' }, [
          el('div', { class: 'fwa-template-placeholder-label', text: help?.label ?? '模板變數' }),
          el('div', { class: 'fwa-template-placeholder-description', text: help?.description ?? '' }),
          el('div', {
            class: 'fwa-template-placeholder-example',
            text: `範例：${example || '（空白）'}`,
          }),
        ]),
      ]);
      row.addEventListener('dragstart', (event) => {
        const dataTransfer = event.dataTransfer;
        if (!dataTransfer) return;
        dataTransfer.effectAllowed = 'copy';
        dataTransfer.setData(PLACEHOLDER_DRAG_MIME, token);
        dataTransfer.setData('text/plain', token);
        row.classList.add('is-dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
      guideList.appendChild(row);
    }
    guide.appendChild(guideList);
    // Mount the guide inside the modal's own backdrop layer. This keeps both
    // surfaces in the same stacking context, so clicking a variable card does
    // not land on the backdrop and dismiss the editor underneath it.
    guide.addEventListener('mousedown', (event) => event.stopPropagation());
    layer.appendChild(guide);
    this.placeholderGuide = guide;

    const clearDropState = () => content.classList.remove('fwa-template-placeholder-drop-target');
    content.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types.includes(PLACEHOLDER_DRAG_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      content.classList.add('fwa-template-placeholder-drop-target');
    });
    content.addEventListener('dragleave', clearDropState);
    content.addEventListener('drop', (event) => {
      const dataTransfer = event.dataTransfer;
      const token = dataTransfer?.getData(PLACEHOLDER_DRAG_MIME) || dataTransfer?.getData('text/plain');
      if (!token || !SUPPORTED_PLACEHOLDER_SET.has(token)) return;
      event.preventDefault();
      clearDropState();
      content.focus();
      const start = content.selectionStart ?? content.value.length;
      const end = content.selectionEnd ?? start;
      content.setRangeText(token, start, end, 'end');
      content.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  private async copyPlaceholder(token: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(token);
      } else {
        throw new Error('Clipboard API unavailable');
      }
    } catch {
      const fallback = document.createElement('textarea');
      fallback.value = token;
      fallback.setAttribute('readonly', 'true');
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      document.body.appendChild(fallback);
      fallback.select();
      const copied = document.execCommand('copy');
      fallback.remove();
      if (!copied) {
        showToast('無法複製變數，請手動選取後複製', 'error');
        return;
      }
    }
    showToast(`已複製 ${token}`, 'success', 2200);
  }

  toggle(): void {
    if (this.panel) {
      document.removeEventListener('keydown', this.onPanelKeyDown);
      window.removeEventListener('resize', this.positionPanel);
      this.renderVersion++;
      this.clearTemplateDragState();
      this.panel.remove();
      this.panel = null;
      this.listEl = null;
      this.summaryEl = null;
      this.categorySelectEl = null;
      if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
      return;
    }
    const { root } = createShadowHost('fwa-panel-host');
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const closeBtn = el('button', {
      class: 'fwa-btn fwa-template-close',
      title: '關閉模板',
      'aria-label': '關閉模板',
    }, [icon('close', 17)]);
    const newBtn = el('button', {
      class: 'fwa-btn fwa-btn-primary fwa-template-add',
      title: '建立新模板',
      'aria-label': '建立新模板',
    }, [icon('plus', 18)]);
    const header = el('div', { class: 'fwa-template-panel-header' }, [
      el('div', { class: 'fwa-template-heading' }, [
        el('div', { class: 'title', id: 'fwa-template-title', text: '文章模板' }),
        el('div', { class: 'subtitle', text: '搜尋、預覽，插入常用內容。' }),
      ]),
      newBtn,
      closeBtn,
    ]);
    closeBtn.addEventListener('click', () => this.toggle());
    newBtn.addEventListener('click', () => this.openEditor(null));

    const search = el('input', { type: 'search', placeholder: '搜尋模板或內容…', 'aria-label': '搜尋模板', value: this.query });
    search.addEventListener('input', () => {
      this.query = search.value;
      void this.renderList();
    });
    const catSelect = el('select', { 'aria-label': '模板分類' });
    catSelect.addEventListener('change', () => {
      this.category = catSelect.value;
      void this.renderList();
    });
    this.categorySelectEl = catSelect;
    const tools = el('div', { class: 'fwa-template-tools' }, [
      el('div', { class: 'fwa-template-search' }, [icon('search', 16), search]), catSelect,
    ]);

    this.listEl = el('div', { class: 'fwa-panel-list fwa-template-list' });
    this.bindTemplateListDragEvents(this.listEl);
    this.summaryEl = el('div', { class: 'fwa-template-summary', 'aria-live': 'polite' });

    const saveCurrentBtn = el('button', {
      class: 'fwa-btn fwa-btn-primary',
      text: '收藏目前文章為模板',
    });
    saveCurrentBtn.addEventListener('click', () => {
      const content = this.documentSync.markdown;
      this.openEditor(null, { content, name: this.placeholderContext().pageTitle });
    });
    const exportBtn = el('button', { class: 'fwa-btn', text: '匯出模板' });
    exportBtn.addEventListener('click', () => void this.doExport());
    const importBtn = el('button', { class: 'fwa-btn', text: '匯入模板' });
    importBtn.addEventListener('click', () => void this.doImport('merge'));
    const restoreBtn = el('button', { class: 'fwa-btn', text: '還原備份' });
    restoreBtn.addEventListener('click', () => void this.doImport('replace'));
    const footer = el('div', { class: 'fwa-template-footer' }, [
      el('div', { class: 'fwa-template-save-row' }, [saveCurrentBtn]),
      el('div', { class: 'fwa-template-utility-row' }, [exportBtn, importBtn, restoreBtn]),
    ]);

    this.panel = el('aside', { class: 'fwa-panel fwa-template-panel', 'aria-labelledby': 'fwa-template-title' }, [
      header,
      tools,
      this.summaryEl,
      this.listEl,
      footer,
    ]);
    root.appendChild(this.panel);
    this.positionPanel();
    window.addEventListener('resize', this.positionPanel);
    document.addEventListener('keydown', this.onPanelKeyDown);
    search.focus({ preventScroll: true });
    void this.renderList(catSelect);
  }

  private async renderList(catSelect?: HTMLSelectElement): Promise<void> {
    if (!this.listEl) return;
    const version = ++this.renderVersion;
    const all = await listTemplates();
    if (!this.listEl || version !== this.renderVersion) return;

    const categorySelect = catSelect ?? this.categorySelectEl;
    const categories = listCategories(all);
    if (this.category && !categories.includes(this.category)) this.category = '';
    if (categorySelect) {
      categorySelect.replaceChildren(el('option', { value: '', text: '全部分類' }));
      for (const c of categories) {
        categorySelect.appendChild(el('option', { value: c, text: c }));
      }
      categorySelect.value = this.category;
    }

    const filtered = filterTemplates(all, this.query, this.category);
    if (this.summaryEl) {
      this.summaryEl.replaceChildren(
        el('span', { class: 'fwa-template-count', text: `${filtered.length} 個模板` }),
        el('span', {
          class: 'fwa-template-summary-hint',
          text: this.query || this.category ? `全部 ${all.length} 個` : '拖曳排列 · 插入前可確認',
        }),
      );
    }
    this.listEl.replaceChildren();
    if (filtered.length === 0) {
      this.listEl.appendChild(
        el('div', { class: 'fwa-template-empty' }, [
          el('div', { class: 'fwa-template-empty-icon' }, [icon('template', 25)]),
          el('div', { class: 'fwa-template-empty-title', text: '找不到模板' }),
          el('div', {
            class: 'fwa-template-empty-description',
            text: '調整搜尋或分類條件，或建立一個新的模板。',
          }),
        ]),
      );
      return;
    }
    for (const tpl of filtered) {
      this.listEl.appendChild(this.renderItem(tpl));
    }
  }

  private renderItem(tpl: Template): HTMLElement {
    const actions = el('div', { class: 'actions' });
    const secondaryActions = el('div', { class: 'fwa-template-secondary-actions' });
    const buttons: Array<[string, () => void, string?]> = [
      ['插入', () => this.insert(tpl, 'cursor'), 'fwa-btn fwa-btn-primary'],
      ['預覽', () => this.preview(tpl)],
      ['取代全文', () => this.insert(tpl, 'replace')],
      ['編輯', () => this.openEditor(tpl)],
      ['複製', () => void this.duplicate(tpl)],
      ['刪除', () => this.remove(tpl), 'fwa-btn fwa-btn-danger'],
    ];
    for (const [index, [label, fn, cls]] of buttons.entries()) {
      const btn = el('button', { class: cls ?? 'fwa-btn', text: label });
      btn.addEventListener('click', fn);
      (index < 2 ? actions : secondaryActions).appendChild(btn);
    }
    actions.appendChild(el('details', { class: 'fwa-template-more' }, [
      el('summary', { class: 'fwa-btn', 'aria-label': `管理模板：${tpl.name}`, title: '管理模板' }, [icon('more', 17)]),
      secondaryActions,
    ]));
    const dragHandle = el('button', {
      class: 'fwa-template-drag-handle',
      type: 'button',
      draggable: 'true',
      title: '拖曳調整模板順序',
      'aria-label': `拖曳調整 ${tpl.name} 的位置`,
      'aria-grabbed': 'false',
      text: '⠿',
    });
    const head = el('div', { class: 'fwa-template-card-head' }, [
      dragHandle,
      el('span', { class: 'name', text: tpl.name }),
    ]);
    if (tpl.category) head.appendChild(el('span', { class: 'cat', text: tpl.category }));
    const contentPreview = tpl.content.replace(/\s+/g, ' ').trim();
    const preview = contentPreview.length > 120 ? `${contentPreview.slice(0, 117)}…` : contentPreview;
    const meta = el('div', { class: 'fwa-template-card-meta' }, [
      el('span', { text: `${tpl.content.split(/\r?\n/).length} 行內容` }),
      el('span', { text: formatTemplateDate(tpl.updatedAt) }),
    ]);
    const card = el('div', {
      class: 'fwa-tpl-item',
      'data-template-id': tpl.id,
    }, [
      head,
      tpl.description ? el('div', { class: 'desc', text: tpl.description }) : el('div'),
      preview ? el('div', { class: 'fwa-template-card-preview', text: preview }) : el('div'),
      meta,
      actions,
    ]);
    dragHandle.addEventListener('dragstart', (event) => {
      this.draggingTemplateId = tpl.id;
      dragHandle.setAttribute('aria-grabbed', 'true');
      card.classList.add('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tpl.id);
        event.dataTransfer.setDragImage(dragHandle, 9, 16);
      }
    });
    dragHandle.addEventListener('dragend', () => {
      dragHandle.setAttribute('aria-grabbed', 'false');
      this.clearTemplateDragState();
    });
    card.addEventListener('dragover', (event) => {
      const id = this.readDraggedTemplateId(event);
      if (!id || id === tpl.id) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = card.getBoundingClientRect();
      const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      this.showTemplateDropTarget(card, position);
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    card.addEventListener('dragleave', (event) => {
      if (!card.contains(event.relatedTarget as Node | null)) {
        card.classList.remove('is-drag-target', 'is-drop-before', 'is-drop-after');
      }
    });
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const id = this.readDraggedTemplateId(event);
      if (!id || id === tpl.id) return;
      const rect = card.getBoundingClientRect();
      const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      void this.finishTemplateDrop(id, tpl.id, position);
    });
    return card;
  }

  private bindTemplateListDragEvents(list: HTMLElement): void {
    list.addEventListener('dragover', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!this.readDraggedTemplateId(event) || target?.closest('.fwa-tpl-item')) return;
      event.preventDefault();
      this.showTemplateListEndTarget();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget as Node | null)) list.classList.remove('is-drag-over');
    });
    list.addEventListener('drop', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.fwa-tpl-item')) return;
      event.preventDefault();
      event.stopPropagation();
      const id = this.readDraggedTemplateId(event);
      if (!id) return;
      void this.finishTemplateDrop(id, null, 'after');
    });
  }

  private readDraggedTemplateId(event: DragEvent): string | null {
    return this.draggingTemplateId || event.dataTransfer?.getData('text/plain') || null;
  }

  private showTemplateDropTarget(card: HTMLElement, position: 'before' | 'after'): void {
    this.clearTemplateDropVisuals();
    card.classList.add('is-drag-target', `is-drop-${position}`);
  }

  private showTemplateListEndTarget(): void {
    this.clearTemplateDropVisuals();
    this.listEl?.classList.add('is-drag-over');
  }

  private clearTemplateDropVisuals(): void {
    this.listEl?.querySelectorAll(
      '.is-drag-target, .is-drop-before, .is-drop-after, .is-drag-over',
    ).forEach((element) => {
      element.classList.remove('is-drag-target', 'is-drop-before', 'is-drop-after', 'is-drag-over');
    });
  }

  private clearTemplateDragState(): void {
    this.draggingTemplateId = null;
    this.listEl?.querySelectorAll(
      '.is-dragging, .is-drag-target, .is-drop-before, .is-drop-after, .is-drag-over',
    ).forEach((element) => {
      element.classList.remove('is-dragging', 'is-drag-target', 'is-drop-before', 'is-drop-after', 'is-drag-over');
    });
  }

  private async finishTemplateDrop(
    id: string,
    targetId: string | null,
    position: 'before' | 'after',
  ): Promise<void> {
    this.clearTemplateDragState();
    try {
      await reorderTemplate(id, targetId, position);
      await this.renderList();
    } catch (err) {
      showToast(`模板排序失敗：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
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
      const result = mode === 'cursor'
        ? this.documentSync.insertAtCursor(resolved, { origin: 'template', view: 'template' })
        : this.documentSync.setValue(resolved, { origin: 'template', view: 'template' });
      if (result.status === 'conflict') {
        showToast('目前存在未解決的 Markdown 衝突，模板未套用；兩側內容仍保留。', 'error', 7000);
        return;
      }
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
      el('label', { text: '內容' }),
      content,
    );
    this.mountPlaceholderGuide(modal.layer, content);
    modal.onClose(() => this.closePlaceholderGuide());

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

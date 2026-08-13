import hybridCss from '../styles/hybrid-preview.css?inline';
import { wikiConfig } from '../config/wiki-config';
import { getSettings, saveSettings } from '../shared/storage';
import type { EditorMode, Settings } from '../shared/types';
import type { EditorAdapter } from './editor-adapter';
import { parseHybridBlocks, type HybridMarkdownBlock } from './hybrid-blocks';
import { canVisuallyEdit, serializeNewVisualBlock, serializeVisualBlock } from './hybrid-serialize';
import { collectImageFiles, type ImageDropHandler } from './image-drop';
import { parseMarkdownImage } from './markdown-image';
import { minimalDiff } from './markdown-format';
import { createShadowHost, el, showToast } from './ui';

const STYLE_ID = 'fwa-hybrid-preview-style';
const SOURCE_INDEX_ATTR = 'data-fwa-source-index';
const EXACT_SOURCE_ATTR = 'data-fwa-markdown-source';
const VISUAL_BLOCK_STYLE_ATTR = 'data-fwa-visual-block-style';
const BOX_STYLE_PROPS = [
  'border',
  'border-left',
  'border-radius',
  'background-color',
  'padding',
  'margin',
] as const;

const VISUAL_BOX_PRESETS = [
  { label: '一般資訊框', style: { border: '1px solid #cccccc', borderRadius: '6px', padding: '10px', margin: '8px 0' } },
  { label: '藍色資訊框', style: { borderLeft: '4px solid #0d6efd', backgroundColor: '#f0f7ff', padding: '10px 12px', margin: '8px 0' } },
  { label: '黃色注意框', style: { borderLeft: '4px solid #ffc107', backgroundColor: '#fffbf0', padding: '10px 12px', margin: '8px 0' } },
  { label: '紅色警告框', style: { borderLeft: '4px solid #dc3545', backgroundColor: '#fff5f5', padding: '10px 12px', margin: '8px 0' } },
  { label: '綠色完成框', style: { borderLeft: '4px solid #198754', backgroundColor: '#f2fbf5', padding: '10px 12px', margin: '8px 0' } },
  { label: '灰色補充框', style: { borderLeft: '4px solid #6c757d', backgroundColor: '#f6f8fa', padding: '10px 12px', margin: '8px 0' } },
] as const;

function sourceIndexOf(element: HTMLElement): number | null {
  const raw = element.getAttribute(SOURCE_INDEX_ATTR);
  if (raw === null) return null;
  const index = Number(raw);
  return Number.isInteger(index) ? index : null;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = hybridCss;
  document.head.appendChild(style);
}

function actionButton(label: string, title: string, className = ''): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.title = title;
  element.className = className;
  return element;
}

export class HybridPreviewFeature {
  private preview: HTMLElement | null = null;
  private previewContent: HTMLElement | null = null;
  private toolbar: HTMLElement | null = null;
  private rawHost: HTMLElement | null = null;
  private rawTextarea: HTMLTextAreaElement | null = null;
  private visualRoot: HTMLElement | null = null;
  private visualSource = '';
  private visualBlocks: HybridMarkdownBlock[] = [];
  private observer: MutationObserver | null = null;
  private refreshTimer: number | undefined;
  private contextMenu: HTMLElement | null = null;
  private contextRange: Range | null = null;
  private contextImage: HTMLImageElement | null = null;
  private activeImageUploads = 0;
  private mode: EditorMode;

  constructor(
    private readonly adapter: EditorAdapter,
    private readonly settings: Settings,
    private readonly imageDrop: ImageDropHandler | null = null,
  ) {
    this.mode = settings.editorMode;
  }

  attach(): void {
    const preview = document.querySelector<HTMLElement>(wikiConfig.editor.previewContainerSelector);
    const content = document.querySelector<HTMLElement>(wikiConfig.editor.previewContentSelector);
    if (!preview || !content) return;

    ensureStyle();
    this.preview = preview;
    this.previewContent = content;
    preview.classList.add('fwa-mode-frame');
    this.toolbar = this.buildModeToolbar();
    this.mountToolbarBesideNativeActions();

    this.observer = new MutationObserver(() => {
      if (this.mode === 'hybrid' && (!this.visualRoot || !this.visualRoot.isConnected)) this.scheduleVisualRefresh();
    });
    this.observer.observe(content, { childList: true, subtree: true });
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
    document.addEventListener('mousedown', this.onDocumentMouseDown, true);
    document.addEventListener('click', this.onNativeSaveCapture, true);
    this.applyMode();
  }

  detach(): void {
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    document.removeEventListener('mousedown', this.onDocumentMouseDown, true);
    document.removeEventListener('click', this.onNativeSaveCapture, true);
    this.observer?.disconnect();
    this.observer = null;
    window.clearTimeout(this.refreshTimer);
    this.closeContextMenu();
    this.deactivateVisualDocument();
    this.rawHost?.remove();
    this.rawHost = null;
    this.rawTextarea = null;
    if (this.previewContent) this.previewContent.style.display = '';
    this.toolbar?.remove();
    this.toolbar = null;
    this.preview?.classList.remove('fwa-mode-frame', 'fwa-hybrid-fullscreen');
    this.preview?.style.removeProperty('--fwa-future-top');
    document.documentElement.classList.remove('fwa-hybrid-page-open');
    this.preview = null;
    this.previewContent = null;
  }

  private buildModeToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'fwa-mode-toolbar';

    const choices: Array<[EditorMode, string]> = [
      ['classic', 'Classic'],
      ['hybrid', 'Future'],
    ];
    for (const [mode, label] of choices) {
      const control = actionButton(label, `${label} Markdown`, `fwa-mode-button fwa-mode-${mode}`);
      control.dataset.mode = mode;
      control.addEventListener('click', () => this.setMode(mode));
      toolbar.appendChild(control);
    }
    return toolbar;
  }

  private mountToolbarBesideNativeActions(): void {
    const icon = document.querySelector<HTMLElement>(wikiConfig.editor.saveButtonIconSelector);
    const saveButton = icon?.closest<HTMLButtonElement>('button') ?? null;
    const parent = saveButton?.parentElement ?? null;
    if (!saveButton || !parent || !this.toolbar) return;

    parent.insertBefore(this.toolbar, saveButton);

    const nativeHeader = this.findNativeHeader(saveButton);
    const headerBottom = nativeHeader?.getBoundingClientRect().bottom ?? saveButton.getBoundingClientRect().bottom;
    this.preview?.style.setProperty('--fwa-future-top', `${Math.max(0, Math.round(headerBottom))}px`);
  }

  private findNativeHeader(button: HTMLElement): HTMLElement | null {
    const semantic = button.closest<HTMLElement>('header, nav, .v-toolbar');
    if (semantic) return semantic;

    let current = button.parentElement;
    while (current && current !== document.body) {
      const rect = current.getBoundingClientRect();
      if (rect.top <= 4 && rect.height >= 36 && rect.height <= 96 && rect.width >= window.innerWidth * 0.5) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  private setMode(mode: EditorMode): void {
    if (mode === this.mode && mode === 'hybrid') return;
    if (this.mode === 'hybrid' && !this.commitVisualDocument()) return;
    if (this.mode === 'raw') this.commitRaw();
    this.mode = mode;
    this.applyMode();
    void this.persistMode();
  }

  private async persistMode(): Promise<void> {
    const settings = await getSettings();
    settings.editorMode = this.mode;
    await saveSettings(settings);
  }

  private updateModeButtons(): void {
    for (const control of Array.from(this.toolbar?.querySelectorAll<HTMLButtonElement>('[data-mode]') ?? [])) {
      control.classList.toggle('is-active', control.dataset.mode === this.mode);
    }
  }

  private applyMode(): void {
    if (!this.preview || !this.previewContent) return;
    this.closeContextMenu();
    this.deactivateVisualDocument();
    this.rawHost?.remove();
    this.rawHost = null;
    this.rawTextarea = null;
    this.previewContent.style.display = '';
    this.preview.classList.remove('fwa-hybrid-fullscreen');
    document.documentElement.classList.remove('fwa-hybrid-page-open');
    this.updateModeButtons();

    if (this.mode === 'raw') {
      this.mountRawEditor();
      return;
    }
    if (this.mode === 'hybrid') {
      this.preview.classList.add('fwa-hybrid-fullscreen');
      document.documentElement.classList.add('fwa-hybrid-page-open');
      this.activateVisualDocument();
    }
  }

  private mountRawEditor(): void {
    if (!this.preview || !this.previewContent) return;
    this.previewContent.style.display = 'none';
    const host = document.createElement('div');
    host.className = 'fwa-raw-editor';
    const textarea = document.createElement('textarea');
    textarea.className = 'fwa-hybrid-source';
    textarea.value = this.adapter.getValue();
    textarea.spellcheck = false;
    textarea.addEventListener('blur', () => this.commitRaw());
    host.appendChild(textarea);
    this.preview.appendChild(host);
    this.rawHost = host;
    this.rawTextarea = textarea;
  }

  private commitRaw(): void {
    const textarea = this.rawTextarea;
    if (!textarea) return;
    const current = this.adapter.getValue();
    if (textarea.value === current) return;
    this.adapter.setSelection(0, current.length);
    this.adapter.replaceSelection(textarea.value);
  }

  private scheduleVisualRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      if (this.mode === 'hybrid') this.activateVisualDocument();
    }, 100);
  }

  private activateVisualDocument(): void {
    const root = this.previewContent?.firstElementChild as HTMLElement | null;
    if (!root) return;
    this.deactivateVisualDocument();
    this.visualSource = this.adapter.getValue();
    this.visualBlocks = parseHybridBlocks(this.visualSource);
    this.mapSourceBlocks(root);
    root.classList.add('fwa-hybrid-document');
    root.contentEditable = 'true';
    root.spellcheck = true;
    root.addEventListener('contextmenu', this.onVisualContextMenu);
    root.addEventListener('input', this.onVisualInput);
    root.addEventListener('paste', this.onVisualPaste);
    root.addEventListener('dragover', this.onVisualDragOver);
    root.addEventListener('drop', this.onVisualDrop);
    for (const image of Array.from(root.querySelectorAll<HTMLElement>('img'))) image.contentEditable = 'false';
    this.visualRoot = root;
    root.focus();
  }

  private deactivateVisualDocument(): void {
    const root = this.visualRoot;
    if (!root) return;
    root.removeEventListener('contextmenu', this.onVisualContextMenu);
    root.removeEventListener('input', this.onVisualInput);
    root.removeEventListener('paste', this.onVisualPaste);
    root.removeEventListener('dragover', this.onVisualDragOver);
    root.removeEventListener('drop', this.onVisualDrop);
    root.contentEditable = 'false';
    root.classList.remove('fwa-hybrid-document');
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(`[${SOURCE_INDEX_ATTR}]`))) {
      element.removeAttribute(SOURCE_INDEX_ATTR);
      element.removeAttribute('title');
      element.contentEditable = 'inherit';
    }
    this.visualRoot = null;
  }

  private mapSourceBlocks(root: HTMLElement): void {
    const rendered = Array.from(root.children) as HTMLElement[];
    if (rendered.length === this.visualBlocks.length) {
      rendered.forEach((element, index) => this.markSourceElement(element, this.visualBlocks[index], index));
      return;
    }

    const unused = new Set(this.visualBlocks.map((_, index) => index));
    for (const element of rendered) {
      const line = Number(element.dataset.line);
      if (!Number.isInteger(line)) continue;
      const index = this.visualBlocks.findIndex((block, idx) => unused.has(idx) && block.startLine === line);
      if (index >= 0) {
        this.markSourceElement(element, this.visualBlocks[index], index);
        unused.delete(index);
      }
    }
  }

  private markSourceElement(element: HTMLElement, block: HybridMarkdownBlock, index: number): void {
    element.setAttribute(SOURCE_INDEX_ATTR, String(index));
    if (!canVisuallyEdit(block)) {
      element.contentEditable = 'false';
      element.title = block.type === 'image'
        ? '圖片內容受保護，可使用圖片功能更換'
        : '特殊 Markdown 區塊受保護，請切換 Raw 模式修改';
    }
  }

  private commitVisualDocument(): boolean {
    const root = this.visualRoot;
    if (!root) return true;
    if (this.activeImageUploads > 0) {
      showToast('圖片仍在上傳中，請等待上傳完成後再儲存。', 'info', 4500);
      return false;
    }
    const current = this.adapter.getValue();
    if (current !== this.visualSource) {
      showToast('左側 Markdown 在視覺編輯期間已變動，為避免覆寫，請先退出再重新進入 Future。', 'error', 7000);
      return false;
    }

    const children = Array.from(root.children) as HTMLElement[];
    const structureUnchanged =
      children.length === this.visualBlocks.length &&
      children.every((element, index) => sourceIndexOf(element) === index);
    let next: string;

    if (structureUnchanged) {
      next = current;
      for (let index = children.length - 1; index >= 0; index--) {
        const block = this.visualBlocks[index];
        if (!canVisuallyEdit(block)) continue;
        const replacement = serializeVisualBlock(block, children[index]);
        if (replacement === null) return this.serializationFailed();
        next = next.slice(0, block.startOffset) + replacement + next.slice(block.endOffset);
      }
    } else {
      const serialized: string[] = [];
      for (const element of children) {
        const sourceIndex = sourceIndexOf(element);
        const block = sourceIndex === null ? undefined : this.visualBlocks[sourceIndex];
        const value = block
          ? (canVisuallyEdit(block) ? serializeVisualBlock(block, element) : block.rawMarkdown)
          : serializeNewVisualBlock(element);
        if (value === null) return this.serializationFailed();
        if (value.trim() !== '') serialized.push(value);
      }
      next = serialized.join('\n\n');
      if (/\r?\n$/.test(current) && next !== '') next += '\n';
    }

    if (next !== current) {
      const diff = minimalDiff(current, next);
      this.visualRoot = null;
      this.adapter.setSelection(diff.from, diff.to);
      this.adapter.replaceSelection(diff.insert);
      this.scheduleVisualRefresh();
    }
    return true;
  }

  private serializationFailed(): false {
    showToast('頁面包含無法安全轉回 Markdown 的新結構，未套用修改；可切換 Raw 模式處理。', 'error', 7500);
    return false;
  }

  private readonly onVisualPaste = (event: ClipboardEvent): void => {
    const files = collectImageFiles(event.clipboardData?.files);
    if (files.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      if (!this.settings.enableClipboardImage) {
        showToast('剪貼簿圖片上傳功能尚未啟用。', 'info');
        return;
      }
      void this.uploadVisualImages(files, this.selectionRangeInVisualRoot());
      return;
    }
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData?.getData('text/plain') ?? '');
  };

  private readonly onVisualInput = (): void => {
    // Future edits live in the rendered DOM until Save is pressed, so Wiki.js
    // may still consider its native button "SAVED" and disable it. Keep that
    // original action clickable; its capture handler commits Future first.
    const icon = document.querySelector<HTMLElement>(wikiConfig.editor.saveButtonIconSelector);
    const saveButton = icon?.closest<HTMLButtonElement>('button');
    if (!saveButton) return;
    saveButton.disabled = false;
    saveButton.removeAttribute('aria-disabled');
    saveButton.classList.remove('v-btn--disabled');
  };

  private readonly onVisualDragOver = (event: DragEvent): void => {
    if (!this.settings.enableImageDrop || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  private readonly onVisualDrop = (event: DragEvent): void => {
    const files = collectImageFiles(event.dataTransfer?.files);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (!this.settings.enableImageDrop) {
      showToast('圖片拖放上傳功能尚未啟用。', 'info');
      return;
    }
    void this.uploadVisualImages(files, this.rangeFromPoint(event.clientX, event.clientY));
  };

  private selectionRangeInVisualRoot(): Range | null {
    const root = this.visualRoot;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    return root.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
  }

  private rangeFromPoint(x: number, y: number): Range | null {
    const root = this.visualRoot;
    if (!root) return null;
    const range = document.caretRangeFromPoint?.(x, y) ?? null;
    return range && root.contains(range.commonAncestorContainer) ? range : null;
  }

  private async uploadVisualImages(files: File[], range: Range | null): Promise<void> {
    const root = this.visualRoot;
    if (!root || !this.imageDrop) {
      showToast('圖片上傳功能無法使用，請確認擴充功能的圖片上傳設定。', 'error', 5500);
      return;
    }

    const marker = document.createElement('span');
    marker.className = 'fwa-hybrid-upload-placeholder';
    marker.contentEditable = 'false';
    marker.setAttribute(EXACT_SOURCE_ATTR, '');
    marker.textContent = '圖片上傳中…';
    if (range) {
      range.deleteContents();
      range.insertNode(marker);
    } else {
      root.appendChild(marker);
    }

    this.activeImageUploads++;
    try {
      const lines = await this.imageDrop.uploadFiles(files);
      if (!marker.isConnected) return;
      if (lines.length === 0) {
        marker.remove();
        return;
      }

      const fragment = document.createDocumentFragment();
      const inserted = lines.map((line) => this.visualImageForMarkdown(line));
      inserted.forEach((image, index) => {
        if (index > 0) fragment.appendChild(document.createElement('br'));
        fragment.appendChild(image);
      });
      if (marker.parentElement === root) {
        const paragraph = document.createElement('p');
        paragraph.appendChild(fragment);
        marker.replaceWith(paragraph);
      } else {
        marker.replaceWith(fragment);
      }

      const lastInserted = inserted.at(-1);
      if (lastInserted?.parentNode) {
        const caret = document.createRange();
        caret.setStartAfter(lastInserted);
        caret.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(caret);
      }
    } finally {
      this.activeImageUploads--;
    }
  }

  private visualImageForMarkdown(markdown: string): HTMLElement {
    const token = parseMarkdownImage(markdown, 0);
    if (!token || token.end !== markdown.length) {
      const fallback = document.createElement('span');
      fallback.className = 'fwa-hybrid-uploaded-image-fallback';
      fallback.contentEditable = 'false';
      fallback.setAttribute(EXACT_SOURCE_ATTR, markdown);
      fallback.textContent = '圖片已上傳';
      return fallback;
    }

    const image = document.createElement('img');
    image.src = token.url;
    image.alt = token.alt;
    if (token.title) image.title = token.title;
    image.contentEditable = 'false';
    image.setAttribute(EXACT_SOURCE_ATTR, markdown);
    return image;
  }

  private readonly onVisualContextMenu = (event: MouseEvent): void => {
    const root = this.visualRoot;
    const selection = window.getSelection();
    if (!root) return;
    const image = (event.target as HTMLElement | null)?.closest<HTMLImageElement>('img') ?? null;
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const hasTextSelection = Boolean(
      selection && !selection.isCollapsed && range && root.contains(range.commonAncestorContainer),
    );
    if (!image && !hasTextSelection) return;
    event.preventDefault();
    event.stopPropagation();
    this.contextRange = hasTextSelection && range ? range.cloneRange() : null;
    this.contextImage = image && root.contains(image) ? image : null;
    this.openContextMenu(event.clientX, event.clientY, this.contextImage !== null);
  };

  private openContextMenu(x: number, y: number, forImage: boolean): void {
    this.contextMenu?.remove();
    const { root } = createShadowHost('fwa-hybrid-visual-menu-host');
    const menu = el('div', { class: 'fwa-menu' });
    const addSection = (label: string, controls: HTMLElement[]) => {
      const row = el('div', { class: 'fwa-btn-row' }, controls);
      menu.append(el('div', { class: 'fwa-menu-section' }, [el('div', { class: 'fwa-menu-label', text: label }), row]));
    };
    const command = (label: string, title: string, run: () => void) => {
      const control = el('button', { class: 'fwa-btn', text: label, title });
      control.addEventListener('mousedown', (event) => event.preventDefault());
      control.addEventListener('click', () => {
        run();
        this.closeContextMenu();
      });
      return control;
    };

    if (forImage) this.buildVisualImageMenu(menu, addSection, command);
    else this.buildVisualTextMenu(menu, addSection, command);

    root.appendChild(menu);
    this.contextMenu = menu;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  }

  private buildVisualTextMenu(
    menu: HTMLElement,
    addSection: (label: string, controls: HTMLElement[]) => void,
    command: (label: string, title: string, run: () => void) => HTMLButtonElement,
  ): void {
    const divider = () => menu.append(el('div', { class: 'fwa-divider' }));
    const colorControls = [
      ...wikiConfig.formatting.presetColors.map((color) => color.value),
      ...this.settings.customSwatches,
    ].map((color) => {
      const control = el('button', { class: 'fwa-swatch', title: color, style: `background:${color}` });
      control.addEventListener('mousedown', (event) => event.preventDefault());
      control.addEventListener('click', () => {
        this.execCommand('foreColor', color);
        this.closeContextMenu();
      });
      return control;
    });
    addSection('文字顏色', colorControls);
    divider();
    addSection('文字大小', [
      command('小', '小字', () => this.execCommand('fontSize', '2')),
      command('一般', '一般大小', () => this.execCommand('fontSize', '3')),
      command('中', '中等大小', () => this.execCommand('fontSize', '4')),
      command('大', '大字', () => this.execCommand('fontSize', '5')),
      command('特大', '特大字', () => this.execCommand('fontSize', '6')),
    ]);
    divider();
    addSection('其他格式', [
      command('粗體', '粗體', () => this.execCommand('bold')),
      command('斜體', '斜體', () => this.execCommand('italic')),
      command('底線', '底線', () => this.execCommand('underline')),
      command('刪除線', '刪除線', () => this.execCommand('strikeThrough')),
      command('背景標記', '醒目提示', () => this.execCommand('hiliteColor', '#fff3a3')),
      command('程式碼', '行內程式碼', () => this.wrapSelectionWithCode()),
      command('清除格式', '清除文字格式', () => this.execCommand('removeFormat')),
    ]);
    divider();
    addSection('段落排版', [
      command('引用區塊', '切換引用區塊', () => this.execCommand('formatBlock', 'blockquote')),
      command('靠左', '靠左對齊', () => this.applyVisualBlockStyles({ textAlign: 'left' })),
      command('置中', '置中對齊', () => this.applyVisualBlockStyles({ textAlign: 'center' })),
      command('靠右', '靠右對齊', () => this.applyVisualBlockStyles({ textAlign: 'right' })),
      command('取消對齊', '移除對齊', () => this.applyVisualBlockStyles({ textAlign: '' })),
      command('增加縮排', '增加段落縮排', () => this.changeVisualIndent(1)),
      command('減少縮排', '減少段落縮排', () => this.changeVisualIndent(-1)),
      command('清除 HTML', '清除 HTML 與區塊樣式', () => this.clearVisualHtml()),
    ]);
    divider();
    addSection('文字框', [
      command('文字框', '套用一般文字框', () => this.applyVisualBox(VISUAL_BOX_PRESETS[0].style)),
      command('文字框設定', '自訂文字框框線', () => this.promptVisualBoxSettings()),
      command('實線框', '套用 2px 實線框', () => this.applyVisualBox({ border: '2px solid #cccccc', borderRadius: '6px', padding: '10px', margin: '8px 0' })),
      command('虛線框', '套用虛線框', () => this.applyVisualBox({ border: '2px dashed #6c757d', borderRadius: '6px', padding: '10px', margin: '8px 0' })),
      command('移除文字框', '只移除文字框樣式', () => this.removeVisualBox()),
    ]);
    addSection('快速資訊樣式', VISUAL_BOX_PRESETS.map((preset) =>
      command(preset.label, preset.label, () => this.applyVisualBox(preset.style)),
    ));
    divider();

    const textColor = el('input', { type: 'color', class: 'fwa-color-input', title: '自訂文字顏色' });
    textColor.addEventListener('change', () => {
      this.execCommand('foreColor', textColor.value);
      this.closeContextMenu();
    });
    const background = el('input', { type: 'color', class: 'fwa-color-input', title: '自訂背景顏色' });
    background.value = '#fff3a3';
    background.addEventListener('change', () => {
      this.execCommand('hiliteColor', background.value);
      this.closeContextMenu();
    });
    addSection('自訂顏色（字色／背景）', [textColor, background]);
  }

  private buildVisualImageMenu(
    menu: HTMLElement,
    addSection: (label: string, controls: HTMLElement[]) => void,
    command: (label: string, title: string, run: () => void) => HTMLButtonElement,
  ): void {
    const name = this.contextImage?.getAttribute('src')?.split('/').at(-1) ?? '圖片';
    addSection(`圖片：${name}`, [
      ...['25%', '50%', '75%', '100%', '200px', '400px', '600px'].map((width) =>
        command(width, `圖片寬度 ${width}`, () => this.setVisualImageSize(width)),
      ),
      command('自訂大小', '輸入自訂圖片寬度', () => this.promptVisualImageSize()),
      command('原始尺寸', '清除寬高設定', () => this.clearVisualImageSize()),
    ]);
    menu.append(el('div', { class: 'fwa-divider' }));
    addSection('圖片排版', [
      command('靠左', '圖片靠左', () => this.alignVisualImage('left')),
      command('置中', '圖片置中', () => this.alignVisualImage('center')),
      command('靠右', '圖片靠右', () => this.alignVisualImage('right')),
      command('取消對齊', '清除圖片對齊', () => this.alignVisualImage(null)),
      command('圓角', '切換圖片圓角', () => this.toggleVisualImageStyle('borderRadius', '8px')),
      command('框線', '切換圖片框線', () => this.toggleVisualImageStyle('border', '1px solid #cccccc')),
      command('框線設定', '自訂圖片框線', () => this.promptVisualImageBorder()),
      command('粗框線', '切換 3px 圖片框線', () => this.toggleVisualImageStyle('border', '3px solid #6c757d')),
      command('移除樣式', '移除全部圖片樣式', () => this.removeVisualImageStyle()),
      command('還原 Markdown', '還原成 Markdown 圖片', () => this.removeVisualImageStyle()),
    ]);
  }

  private restoreContextSelection(): void {
    if (!this.contextRange) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(this.contextRange.cloneRange());
  }

  private selectedVisualBlocks(): HTMLElement[] {
    const root = this.visualRoot;
    const range = this.contextRange;
    if (!root || !range) return [];
    return Array.from(root.children).filter((child): child is HTMLElement => {
      if (!(child instanceof HTMLElement)) return false;
      try {
        return range.intersectsNode(child);
      } catch {
        return false;
      }
    });
  }

  private applyVisualBlockStyles(styles: Record<string, string>): void {
    for (const block of this.selectedVisualBlocks()) {
      block.setAttribute(VISUAL_BLOCK_STYLE_ATTR, 'true');
      for (const [property, value] of Object.entries(styles)) {
        if (value) block.style.setProperty(property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`), value);
        else block.style.removeProperty(property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`));
      }
    }
  }

  private changeVisualIndent(direction: 1 | -1): void {
    for (const block of this.selectedVisualBlocks()) {
      const current = Number.parseFloat(block.style.marginLeft) || 0;
      const next = Math.max(0, Math.min(12, current + direction * 2));
      this.applyStyleToBlock(block, 'margin-left', next ? `${next}em` : '');
    }
  }

  private applyStyleToBlock(block: HTMLElement, property: string, value: string): void {
    block.setAttribute(VISUAL_BLOCK_STYLE_ATTR, 'true');
    if (value) block.style.setProperty(property, value);
    else block.style.removeProperty(property);
  }

  private applyVisualBox(styles: Readonly<Record<string, string>>): void {
    for (const block of this.selectedVisualBlocks()) {
      for (const property of BOX_STYLE_PROPS) block.style.removeProperty(property);
      block.setAttribute(VISUAL_BLOCK_STYLE_ATTR, 'true');
      for (const [property, value] of Object.entries(styles)) {
        block.style.setProperty(property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`), value);
      }
    }
  }

  private removeVisualBox(): void {
    for (const block of this.selectedVisualBlocks()) {
      for (const property of BOX_STYLE_PROPS) block.style.removeProperty(property);
    }
  }

  private promptVisualBoxSettings(): void {
    const border = window.prompt('輸入文字框框線，例如 2px dashed #0d6efd', '2px solid #cccccc')?.trim();
    if (!border || /[;{}]/.test(border)) return;
    const radius = window.prompt('輸入圓角，例如 6px；不需要圓角可輸入 0', '6px')?.trim() ?? '6px';
    this.applyVisualBox({ border, borderRadius: radius, padding: '10px 12px', margin: '8px 0' });
  }

  private clearVisualHtml(): void {
    const blocks = this.selectedVisualBlocks();
    this.restoreContextSelection();
    document.execCommand('removeFormat');
    for (const block of blocks) {
      block.removeAttribute('style');
      block.removeAttribute(VISUAL_BLOCK_STYLE_ATTR);
    }
  }

  private editContextImage(edit: (image: HTMLImageElement) => void): void {
    const image = this.contextImage;
    if (!image) return;
    image.removeAttribute(EXACT_SOURCE_ATTR);
    edit(image);
  }

  private setVisualImageSize(width: string): void {
    this.editContextImage((image) => {
      image.style.width = width;
      image.style.height = 'auto';
    });
  }

  private promptVisualImageSize(): void {
    const current = this.contextImage?.style.width || '400px';
    const width = window.prompt('輸入圖片寬度，例如 400px 或 50%', current)?.trim();
    if (!width || !/^\d+(?:\.\d+)?(?:px|%)$/.test(width)) return;
    const height = window.prompt('輸入圖片高度，例如 300px；保持比例請輸入 auto', 'auto')?.trim();
    if (!height || !/^(?:auto|\d+(?:\.\d+)?(?:px|%))$/.test(height)) return;
    this.editContextImage((image) => {
      image.style.width = width;
      image.style.height = height;
    });
  }

  private clearVisualImageSize(): void {
    this.editContextImage((image) => {
      image.style.removeProperty('width');
      image.style.removeProperty('height');
      image.style.removeProperty('max-width');
      image.style.removeProperty('max-height');
    });
  }

  private alignVisualImage(align: 'left' | 'center' | 'right' | null): void {
    this.editContextImage((image) => {
      if (!align) {
        image.style.removeProperty('display');
        image.style.removeProperty('margin-left');
        image.style.removeProperty('margin-right');
        return;
      }
      image.style.display = 'block';
      image.style.marginLeft = align === 'left' ? '0' : 'auto';
      image.style.marginRight = align === 'right' ? '0' : 'auto';
    });
  }

  private toggleVisualImageStyle(property: 'border' | 'borderRadius', value: string): void {
    this.editContextImage((image) => {
      if (image.style[property]) image.style.removeProperty(property === 'borderRadius' ? 'border-radius' : property);
      else image.style[property] = value;
    });
  }

  private promptVisualImageBorder(): void {
    const current = this.contextImage?.style.border || '2px solid #cccccc';
    const border = window.prompt('輸入圖片框線，例如 2px solid #0d6efd', current)?.trim();
    if (!border || /[;{}]/.test(border)) return;
    this.editContextImage((image) => {
      image.style.border = border;
    });
  }

  private removeVisualImageStyle(): void {
    this.editContextImage((image) => image.removeAttribute('style'));
  }

  private execCommand(command: string, value?: string): void {
    this.restoreContextSelection();
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand(command, false, value);
  }

  private wrapSelectionWithCode(): void {
    this.restoreContextSelection();
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const wrapper = document.createElement('code');
    wrapper.appendChild(range.extractContents());
    range.insertNode(wrapper);
  }

  private closeContextMenu(): void {
    this.contextMenu?.remove();
    this.contextMenu = null;
    this.contextRange = null;
    this.contextImage = null;
  }

  private readonly onDocumentMouseDown = (event: MouseEvent): void => {
    if (!this.contextMenu) return;
    if (!event.composedPath().includes(this.contextMenu)) this.closeContextMenu();
  };

  private saveThroughWiki(): void {
    if (this.mode === 'hybrid' && !this.commitVisualDocument()) return;
    if (this.mode === 'raw') this.commitRaw();
    window.setTimeout(() => {
      const icon = document.querySelector<HTMLElement>(wikiConfig.editor.saveButtonIconSelector);
      const save = icon?.closest<HTMLButtonElement>('button');
      if (save) save.click();
      else showToast('找不到 Wiki.js 原生 Save 按鈕，內容仍保留在原生 Markdown Editor。', 'error', 6000);
    }, 0);
  }

  private readonly onNativeSaveCapture = (event: MouseEvent): void => {
    if (this.mode !== 'hybrid') return;
    const icon = document.querySelector<HTMLElement>(wikiConfig.editor.saveButtonIconSelector);
    const saveButton = icon?.closest<HTMLButtonElement>('button');
    if (!saveButton || !event.composedPath().includes(saveButton)) return;
    if (this.commitVisualDocument()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.contextMenu) {
      event.preventDefault();
      this.closeContextMenu();
      return;
    }
    if (event.key === 'Escape' && this.mode === 'hybrid') {
      event.preventDefault();
      this.setMode('classic');
      return;
    }
    if (this.mode === 'classic' || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    event.stopPropagation();
    this.saveThroughWiki();
  };
}

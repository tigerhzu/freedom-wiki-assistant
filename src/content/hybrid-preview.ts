import hybridCss from '../styles/hybrid-preview.css?inline';
import { wikiConfig } from '../config/wiki-config';
import { getSettings, saveSettings } from '../shared/storage';
import type { EditorMode, SelectionInfo, Settings } from '../shared/types';
import type { EditorAdapter } from './editor-adapter';
import {
  applyBox,
  applyCustomColor,
  changeIndent,
  removeBox,
  setBlockAlign,
  stripHtml,
  toggleBlockquote,
} from './block-format';
import { parseHybridBlocks, type HybridMarkdownBlock } from './hybrid-blocks';
import {
  canSerializeVisualBlock,
  canVisuallyEdit,
  serializeNewVisualBlock,
  serializeVisualBlock,
} from './hybrid-serialize';
import { collectImageFiles, type ImageDropHandler } from './image-drop';
import { BOX_PRESETS, DEFAULT_BOX, parseBorderShorthand } from './html-style';
import { parseMarkdownImage } from './markdown-image';
import {
  applyColor,
  applySize,
  clearFormatting,
  minimalDiff,
  toggleBold,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleStrike,
  toggleUnderline,
  type EditResult,
} from './markdown-format';
import { createShadowHost, el, showToast } from './ui';
import {
  findMarkdownTextRangeCandidates,
  findMarkdownTextRanges,
  findNormalizedTextRange,
} from './visual-selection';

const STYLE_ID = 'fwa-hybrid-preview-style';
const SOURCE_INDEX_ATTR = 'data-fwa-source-index';
const DIRTY_BLOCK_ATTR = 'data-fwa-visual-dirty';
const EXACT_SOURCE_ATTR = 'data-fwa-markdown-source';
// Keep visual typing local while the user is active. Once they pause, the
// current visual block is flushed as one source edit instead of one edit per
// character, so Wiki.js never gets a chance to re-render between keystrokes.
// The rendered DOM is still updated immediately; this delay only controls the
// background write to the native editor and intentionally groups a short
// English/number burst into one Wiki.js render.
const VISUAL_SYNC_DELAY_MS = 700;
const VISUAL_REFRESH_DELAY_MS = 16;
type SourceEdit = (text: string, start: number, end: number) => EditResult;

interface VisualSourceSpan {
  start: number;
  end: number;
  text: string;
  firstIndex: number;
  lastIndex: number;
}

interface VisualSelectionPoint {
  path: number[];
  offset: number;
  textOffset: number;
}

interface VisualSelectionBookmark {
  start: VisualSelectionPoint;
  end: VisualSelectionPoint;
}

interface VisualBlockEdit {
  index: number;
  element: HTMLElement;
  start: number;
  end: number;
  replacement: string;
}

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
  private visualDirty = false;
  private observer: MutationObserver | null = null;
  private refreshTimer: number | undefined;
  private renderWaitTimer: number | undefined;
  private visualSyncTimer: number | undefined;
  private awaitingPreviewRender = false;
  private unsubscribeAdapterChanges: (() => void) | null = null;
  private applyingSourceChange = false;
  private visualComposing = false;
  private pendingVisualSelection: VisualSelectionBookmark | null = null;
  private selectionRestoreTimer: number | undefined;
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
    this.unsubscribeAdapterChanges = this.adapter.subscribe(this.onAdapterChange);

    this.observer = new MutationObserver(() => {
      if (this.mode === 'raw') return;
      if (this.awaitingPreviewRender) {
        this.awaitingPreviewRender = false;
        window.clearTimeout(this.renderWaitTimer);
        this.scheduleVisualRefresh();
        return;
      }
      if (!this.visualRoot || !this.visualRoot.isConnected || !this.visualMappingIsCurrent()) {
        this.scheduleVisualRefresh();
      }
    });
    this.observer.observe(content, { childList: true, characterData: true, subtree: true });
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
    document.addEventListener('mousedown', this.onDocumentMouseDown, true);
    document.addEventListener('click', this.onNativeSaveCapture, true);
    document.addEventListener('click', this.onNativeCloseCapture, true);
    this.applyMode();
  }

  detach(): void {
    if (this.mode !== 'raw' && !this.visualComposing) this.flushVisualCommit();
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    document.removeEventListener('mousedown', this.onDocumentMouseDown, true);
    document.removeEventListener('click', this.onNativeSaveCapture, true);
    document.removeEventListener('click', this.onNativeCloseCapture, true);
    this.observer?.disconnect();
    this.observer = null;
    this.unsubscribeAdapterChanges?.();
    this.unsubscribeAdapterChanges = null;
    window.clearTimeout(this.refreshTimer);
    window.clearTimeout(this.renderWaitTimer);
    window.clearTimeout(this.visualSyncTimer);
    this.visualSyncTimer = undefined;
    window.clearTimeout(this.selectionRestoreTimer);
    this.pendingVisualSelection = null;
    this.awaitingPreviewRender = false;
    this.closeContextMenu();
    this.deactivateVisualDocument();
    this.rawHost?.remove();
    this.rawHost = null;
    this.rawTextarea = null;
    if (this.previewContent) {
      this.previewContent.style.display = '';
      this.previewContent.classList.remove('fwa-future-shell');
    }
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

  private setMode(mode: EditorMode, persist = true): boolean {
    if (mode === this.mode && mode === 'hybrid') return true;
    if (this.mode !== 'raw' && !this.flushVisualCommit()) return false;
    if (this.mode === 'raw') this.commitRaw();
    this.mode = mode;
    this.applyMode();
    if (persist) void this.persistMode();
    return true;
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
    this.previewContent.classList.remove('fwa-future-shell');
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
      this.previewContent.classList.add('fwa-future-shell');
    }
    this.activateVisualDocument();
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
    textarea.addEventListener('input', () => this.commitRaw());
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
    this.writeSourceValue(0, current.length, textarea.value, current);
  }

  /**
   * Native editor changes are the other half of the shared source-of-truth
   * contract. Wiki.js normally redraws its preview itself, but Future needs
   * to know when that redraw belongs to a new Markdown snapshot so it can
   * discard its old source offsets and rebind to the new DOM.
   */
  private readonly onAdapterChange = (): void => {
    if (this.applyingSourceChange) return;

    const source = this.adapter.getValue();
    if (this.mode === 'raw') {
      if (this.rawTextarea && document.activeElement !== this.rawTextarea) {
        this.rawTextarea.value = source;
      }
      return;
    }
    if (source === this.visualSource) return;

    window.clearTimeout(this.visualSyncTimer);
    this.visualSyncTimer = undefined;
    if (this.visualRoot?.contains(document.activeElement)) this.rememberVisualSelection();
    this.visualDirty = false;
    this.deactivateVisualDocument(true);
    this.waitForPreviewRender();
  };

  private writeSourceValue(
    start: number,
    end: number,
    replacement: string,
    sourceBefore: string,
    reparse = true,
  ): void {
    this.applyingSourceChange = true;
    try {
      this.adapter.replaceRange(start, end, replacement);
    } finally {
      this.applyingSourceChange = false;
    }
    // The replacement is exact for every supported adapter, so avoid a second
    // bridge round-trip just to read back the value we already know.
    const actual = sourceBefore.slice(0, start) + replacement + sourceBefore.slice(end);
    this.visualSource = actual;
    if (reparse) this.visualBlocks = parseHybridBlocks(actual);
  }

  /** Update cached source offsets after replacing one already-mapped block. */
  private updateVisualBlocksAfterEdit(
    start: number,
    end: number,
    replacement: string,
    sourceBefore: string,
  ): void {
    const delta = replacement.length - (end - start);
    const oldLineBreaks = (sourceBefore.slice(start, end).match(/\n/g) ?? []).length;
    const newLineBreaks = (replacement.match(/\n/g) ?? []).length;
    const lineDelta = newLineBreaks - oldLineBreaks;

    this.visualBlocks = this.visualBlocks.map((block) => {
      if (block.endOffset <= start) return block;
      if (block.startOffset >= end) {
        const startOffset = block.startOffset + delta;
        const endOffset = block.endOffset + delta;
        return {
          ...block,
          id: `${block.type}:${startOffset}:${endOffset}`,
          startOffset,
          endOffset,
          startLine: block.startLine + lineDelta,
          endLine: block.endLine + lineDelta,
        };
      }

      const endOffset = block.endOffset + delta;
      return {
        ...block,
        id: `${block.type}:${block.startOffset}:${endOffset}`,
        rawMarkdown: this.visualSource.slice(block.startOffset, endOffset),
        endOffset,
        endLine: block.endLine + lineDelta,
      };
    });
  }

  /** Remember the live caret before Wiki.js replaces the rendered preview. */
  private rememberVisualSelection(preserveExisting = false): void {
    if (preserveExisting && this.pendingVisualSelection) return;
    const bookmark = this.captureVisualSelection();
    if (!bookmark) return;
    this.pendingVisualSelection = bookmark;
    window.clearTimeout(this.selectionRestoreTimer);
    this.selectionRestoreTimer = window.setTimeout(() => {
      this.pendingVisualSelection = null;
    }, 1500);
  }

  private captureVisualSelection(): VisualSelectionBookmark | null {
    const root = this.visualRoot;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

    const point = (node: Node, offset: number): VisualSelectionPoint | null => {
      const path = this.visualNodePath(root, node);
      if (!path) return null;
      const max = node.nodeType === Node.TEXT_NODE
        ? (node.textContent ?? '').length
        : node.childNodes.length;
      const safeOffset = Math.max(0, Math.min(offset, max));
      const prefix = document.createRange();
      try {
        prefix.selectNodeContents(root);
        prefix.setEnd(node, safeOffset);
      } catch {
        return null;
      }
      return { path, offset: safeOffset, textOffset: prefix.toString().length };
    };

    const start = point(range.startContainer, range.startOffset);
    const end = point(range.endContainer, range.endOffset);
    return start && end ? { start, end } : null;
  }

  private visualNodePath(root: HTMLElement, node: Node): number[] | null {
    if (node === root) return [];
    const path: number[] = [];
    let current: Node | null = node;
    while (current && current !== root) {
      const parent: Node | null = current.parentNode;
      if (!parent) return null;
      const index = Array.prototype.indexOf.call(parent.childNodes, current);
      if (index < 0) return null;
      path.unshift(index);
      current = parent;
    }
    return current === root ? path : null;
  }

  private visualNodeAtPath(root: HTMLElement, path: number[]): Node | null {
    let node: Node = root;
    for (const index of path) {
      const child = node.childNodes[index];
      if (!child) return null;
      node = child;
    }
    return node;
  }

  private visualPointAtTextOffset(root: HTMLElement, target: number): { node: Node; offset: number } {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let remaining = Math.max(0, target);
    let last: Node | null = null;
    while (node) {
      last = node;
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) return { node, offset: remaining };
      remaining -= length;
      node = walker.nextNode();
    }
    return last
      ? { node: last, offset: last.textContent?.length ?? 0 }
      : { node: root, offset: root.childNodes.length };
  }

  private restoreVisualSelection(root: HTMLElement, bookmark: VisualSelectionBookmark): boolean {
    const point = (saved: VisualSelectionPoint): { node: Node; offset: number } => {
      const node = this.visualNodeAtPath(root, saved.path);
      if (!node) return this.visualPointAtTextOffset(root, saved.textOffset);
      const max = node.nodeType === Node.TEXT_NODE
        ? (node.textContent ?? '').length
        : node.childNodes.length;
      return { node, offset: Math.max(0, Math.min(saved.offset, max)) };
    };
    const start = point(bookmark.start);
    const end = point(bookmark.end);
    const range = document.createRange();
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } catch {
      // A renderer may keep the same block path while changing its inline
      // wrapper tree. Fall back to the saved document text offsets instead of
      // focusing the root with a new caret at the heading.
      const fallbackStart = this.visualPointAtTextOffset(root, bookmark.start.textOffset);
      const fallbackEnd = this.visualPointAtTextOffset(root, bookmark.end.textOffset);
      try {
        range.setStart(fallbackStart.node, fallbackStart.offset);
        range.setEnd(fallbackEnd.node, fallbackEnd.offset);
      } catch {
        return false;
      }
    }
    root.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  private visualMappingIsCurrent(): boolean {
    const root = this.visualRoot;
    if (!root || !root.isConnected) return false;
    const mapped = Array.from(root.children)
      .map((child) => sourceIndexOf(child as HTMLElement))
      .filter((index): index is number => index !== null);
    return mapped.length > 0 || this.visualBlocks.length === 0;
  }

  private scheduleVisualRefresh(): void {
    if (this.visualRoot?.contains(document.activeElement)) this.rememberVisualSelection(true);
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      if (this.mode !== 'raw') this.activateVisualDocument();
    }, VISUAL_REFRESH_DELAY_MS);
  }

  /**
   * Wiki.js updates its rendered preview asynchronously after CodeMirror is
   * changed. Wait for an actual preview mutation before binding Future to the
   * new DOM; otherwise Future can attach to the stale tree and appear unchanged
   * until the user toggles modes. The timeout is only a fallback for renderers
   * that replace no child nodes for a particular edit.
   */
  private waitForPreviewRender(): void {
    window.clearTimeout(this.refreshTimer);
    window.clearTimeout(this.renderWaitTimer);
    this.awaitingPreviewRender = true;
    this.renderWaitTimer = window.setTimeout(() => {
      this.awaitingPreviewRender = false;
      if (this.mode !== 'raw') this.scheduleVisualRefresh();
    }, 1000);
  }

  /**
   * Debounce source writes while the user is typing. The browser updates the
   * contenteditable immediately; only the latest version of this visual block
   * is sent to the native Markdown editor after a short pause.
   */
  private scheduleVisualCommit(): void {
    window.clearTimeout(this.visualSyncTimer);
    this.visualSyncTimer = window.setTimeout(() => {
      this.visualSyncTimer = undefined;
      if (this.visualComposing) return;
      if (this.visualRoot && this.mode !== 'raw') this.commitVisualDocument(true);
    }, VISUAL_SYNC_DELAY_MS);
  }

  private flushVisualCommit(keepVisualEditing = false): boolean {
    window.clearTimeout(this.visualSyncTimer);
    this.visualSyncTimer = undefined;
    return this.commitVisualDocument(keepVisualEditing);
  }

  private activateVisualDocument(): void {
    const root = this.previewContent?.firstElementChild as HTMLElement | null;
    if (!root) return;
    const bookmark = this.pendingVisualSelection;
    this.deactivateVisualDocument();
    this.visualSource = this.adapter.getValue();
    this.visualBlocks = parseHybridBlocks(this.visualSource);
    this.mapSourceBlocks(root);
    root.classList.add('fwa-visual-document');
    root.classList.toggle('fwa-hybrid-document', this.mode === 'hybrid');
    root.contentEditable = 'true';
    root.spellcheck = true;
    root.addEventListener('contextmenu', this.onVisualContextMenu);
    root.addEventListener('input', this.onVisualInput);
    root.addEventListener('compositionstart', this.onVisualCompositionStart);
    root.addEventListener('compositionend', this.onVisualCompositionEnd);
    root.addEventListener('focusout', this.onVisualFocusOut);
    root.addEventListener('copy', this.onVisualClipboard);
    root.addEventListener('cut', this.onVisualClipboard);
    root.addEventListener('paste', this.onVisualPaste);
    root.addEventListener('dragover', this.onVisualDragOver);
    root.addEventListener('drop', this.onVisualDrop);
    for (const image of Array.from(root.querySelectorAll<HTMLElement>('img'))) image.contentEditable = 'false';
    this.visualRoot = root;
    this.visualDirty = false;
    if (bookmark) {
      const restored = this.restoreVisualSelection(root, bookmark);
      window.clearTimeout(this.selectionRestoreTimer);
      this.selectionRestoreTimer = undefined;
      if (!restored) root.focus({ preventScroll: true });
    } else if (this.mode === 'hybrid') {
      root.focus({ preventScroll: true });
    }
    this.pendingVisualSelection = null;
  }

  private deactivateVisualDocument(preserveLayout = false): void {
    const root = this.visualRoot;
    if (!root) return;
    root.removeEventListener('contextmenu', this.onVisualContextMenu);
    root.removeEventListener('input', this.onVisualInput);
    root.removeEventListener('compositionstart', this.onVisualCompositionStart);
    root.removeEventListener('compositionend', this.onVisualCompositionEnd);
    root.removeEventListener('focusout', this.onVisualFocusOut);
    root.removeEventListener('copy', this.onVisualClipboard);
    root.removeEventListener('cut', this.onVisualClipboard);
    root.removeEventListener('paste', this.onVisualPaste);
    root.removeEventListener('dragover', this.onVisualDragOver);
    root.removeEventListener('drop', this.onVisualDrop);
    root.contentEditable = 'false';
    if (!preserveLayout) root.classList.remove('fwa-visual-document', 'fwa-hybrid-document');
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(`[${SOURCE_INDEX_ATTR}]`))) {
      element.removeAttribute(SOURCE_INDEX_ATTR);
      element.removeAttribute(DIRTY_BLOCK_ATTR);
      element.removeAttribute('title');
      element.contentEditable = 'inherit';
    }
    this.visualRoot = null;
    this.visualDirty = false;
    this.visualComposing = false;
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
    if (block.type === 'image') {
      const image = element.tagName === 'IMG'
        ? element as HTMLImageElement
        : element.querySelector<HTMLImageElement>('img');
      image?.setAttribute(EXACT_SOURCE_ATTR, block.rawMarkdown);
    }
    if (!canVisuallyEdit(block)) {
      element.contentEditable = 'false';
      element.title = block.type === 'image'
        ? '圖片內容受保護，可使用圖片功能更換'
        : '特殊 Markdown 區塊受保護，請切換 Raw 模式修改';
    } else {
      element.contentEditable = 'inherit';
      element.removeAttribute('title');
    }
  }

  /**
   * Fast path for ordinary typing/deletion. The rendered block already holds
   * the complete latest value, so replace only that block in the native source
   * and shift cached offsets after it. This avoids a full-document diff and
   * parse on every English character.
   */
  private commitVisualBlockEdits(current: string, children: HTMLElement[]): boolean {
    const edits: VisualBlockEdit[] = [];
    for (let index = 0; index < children.length; index++) {
      const element = children[index];
      if (!element.hasAttribute(DIRTY_BLOCK_ATTR)) continue;
      const block = this.visualBlocks[index];
      if (!block || !canSerializeVisualBlock(block)) continue;
      const replacement = serializeVisualBlock(block, element);
      if (replacement === null) return this.serializationFailed();
      if (replacement !== block.rawMarkdown) {
        edits.push({
          index,
          element,
          start: block.startOffset,
          end: block.endOffset,
          replacement,
        });
      }
    }

    // Apply from the end so earlier source offsets stay valid while multiple
    // blocks are being flushed in the same input burst.
    if (edits.length > 0) this.rememberVisualSelection(true);
    let source = current;
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
      this.writeSourceValue(edit.start, edit.end, edit.replacement, source, false);
      this.updateVisualBlocksAfterEdit(edit.start, edit.end, edit.replacement, source);
      source = this.visualSource;
      edit.element.removeAttribute(DIRTY_BLOCK_ATTR);
    }

    this.visualDirty = false;
    for (const element of children) element.removeAttribute(DIRTY_BLOCK_ATTR);
    return true;
  }

  private commitVisualDocument(keepVisualEditing = false): boolean {
    const root = this.visualRoot;
    if (!root) return true;
    if (!this.visualDirty) return true;
    if (this.activeImageUploads > 0) {
      showToast('圖片仍在上傳中，請等待上傳完成後再儲存。', 'info', 4500);
      return false;
    }
    const current = this.adapter.getValue();
    if (current !== this.visualSource) {
      showToast('左側 Markdown 在右側視覺編輯期間已變動，為避免覆寫，請等待預覽重新同步後再試。', 'error', 7000);
      return false;
    }

    const children = Array.from(root.children) as HTMLElement[];
    const structureUnchanged =
      children.length === this.visualBlocks.length &&
      children.every((element, index) => sourceIndexOf(element) === index);
    if (keepVisualEditing && structureUnchanged) {
      return this.commitVisualBlockEdits(current, children);
    }

    let next: string;

    if (structureUnchanged) {
      next = current;
      for (let index = children.length - 1; index >= 0; index--) {
        const block = this.visualBlocks[index];
        if (!children[index].hasAttribute(DIRTY_BLOCK_ATTR)) continue;
        if (!canSerializeVisualBlock(block)) continue;
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
          ? (element.hasAttribute(DIRTY_BLOCK_ATTR) && canSerializeVisualBlock(block)
              ? serializeVisualBlock(block, element)
              : block.rawMarkdown)
          : serializeNewVisualBlock(element);
        if (value === null) return this.serializationFailed();
        if (value.trim() !== '') serialized.push(value);
      }
      next = serialized.join('\n\n');
      if (/\r?\n$/.test(current) && next !== '') next += '\n';
    }

    if (next !== current) {
      const diff = minimalDiff(current, next);
      this.rememberVisualSelection();
      this.deactivateVisualDocument(true);
      this.waitForPreviewRender();
      this.writeSourceValue(diff.from, diff.to, diff.insert, current);
    } else {
      this.visualDirty = false;
      for (const element of children) element.removeAttribute(DIRTY_BLOCK_ATTR);
    }
    return true;
  }

  private markVisualDirty(element: Element | null = null): void {
    this.visualDirty = true;
    element?.closest<HTMLElement>(`[${SOURCE_INDEX_ATTR}]`)?.setAttribute(DIRTY_BLOCK_ATTR, 'true');
  }

  private markVisualDirtyFromNode(node: Node | null): void {
    const element = node instanceof Element ? node : node?.parentElement ?? null;
    this.markVisualDirty(element);
  }

  private serializationFailed(): false {
    showToast('頁面包含無法安全轉回 Markdown 的新結構，未套用修改；可切換 Raw 模式處理。', 'error', 7500);
    return false;
  }

  private readonly onVisualPaste = (event: ClipboardEvent): void => {
    event.stopPropagation();
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
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text === '') return;

    const inserted = document.execCommand('insertText', false, text);
    if (!inserted) {
      // Chromium normally supports insertText in contenteditable, but keep a
      // DOM Range fallback for Wiki.js pages that override execCommand.
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!this.visualRoot?.contains(range.commonAncestorContainer)) return;
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    this.markVisualDirtyFromNode(window.getSelection()?.anchorNode ?? null);
    this.scheduleVisualCommit();
  };

  /** Keep Wiki.js' document-level clipboard handlers from seeing a visual
   * edit, while leaving the browser's native copy/cut action untouched. */
  private readonly onVisualClipboard = (event: ClipboardEvent): void => {
    event.stopPropagation();
  };

  private readonly onVisualInput = (event: Event): void => {
    // Wiki.js does not own this contenteditable surface. Do not let its
    // document-level input handlers treat every visual keystroke as a native
    // Markdown editor change and start another preview render.
    event.stopPropagation();
    this.markVisualDirtyFromNode(window.getSelection()?.anchorNode ?? event.target as Node | null);
    // The browser has already applied the edit to the contenteditable DOM.
    // Defer the bridge/source write so that the input event itself never waits
    // on CodeMirror/Monaco/Ace or a full block serialization.
    const isComposing = this.visualComposing || (event as InputEvent).isComposing === true;
    if (!isComposing) this.scheduleVisualCommit();

    // Keep the native action clickable while Wiki.js processes the new source
    // value. Its own dirty-state update can otherwise briefly disable Save.
    const icon = document.querySelector<HTMLElement>(wikiConfig.editor.saveButtonIconSelector);
    const saveButton = icon?.closest<HTMLButtonElement>('button');
    if (!saveButton) return;
    saveButton.disabled = false;
    saveButton.removeAttribute('aria-disabled');
    saveButton.classList.remove('v-btn--disabled');
  };

  private readonly onVisualCompositionStart = (): void => {
    this.visualComposing = true;
  };

  private readonly onVisualCompositionEnd = (): void => {
    this.visualComposing = false;
    // The final input event may be delivered before or after compositionend;
    // schedule one commit after the completed IME value is in the DOM.
    this.scheduleVisualCommit();
  };

  private readonly onVisualFocusOut = (): void => {
    if (this.mode !== 'classic') return;
    window.setTimeout(() => {
      const root = this.visualRoot;
      if (!root || this.contextMenu || root.contains(document.activeElement)) return;
      this.flushVisualCommit();
    }, 0);
  };

  /** Flush visual or Raw edits before another feature reads/writes the Markdown adapter. */
  prepareExternalEditorAction(): boolean {
    if (this.mode === 'raw') {
      this.commitRaw();
      return true;
    }
    return this.flushVisualCommit();
  }

  /**
   * Map the live selection in Classic/Future's rendered document back to the
   * Markdown source. Prefer an exact text match; when renderer-owned markup
   * makes that impossible, return the complete intersected source block(s)
   * so an external action never silently expands to the whole article.
   */
  getVisualSelection(): SelectionInfo | null {
    const root = this.visualRoot;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    const selectedText = selection.toString();
    const mapped = this.mapVisualRangeToSource(range, selectedText, true);
    if (mapped) return mapped;

    // A nested table cell may not have a source-index marker of its own. If
    // the projected text is unique in the article, expose that one precise
    // range to AI/template actions instead of treating the selection as empty.
    const projected = this.mapVisualRangeToSourceSegments(range, selectedText, true);
    return projected?.length === 1 ? projected[0] : null;
  }

  /**
   * Resolve a rendered DOM range to its original Markdown offsets. Formatting
   * commands must opt out of block fallback: wrapping a whole source block
   * when only a few rendered characters were selected would rewrite list and
   * Wiki.js directive layout.
   */
  private mapVisualRangeToSource(
    range: Range,
    selectedText: string,
    allowBlockFallback: boolean,
  ): SelectionInfo | null {
    const root = this.visualRoot;
    if (!root || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const sourceSpan = this.visualSourceSpan(range);
    if (!sourceSpan) return null;
    const { start: spanStart, end: spanEnd, text: span, firstIndex, lastIndex } = sourceSpan;

    // Resolve through the rendered projection before looking at the raw
    // source string. A direct indexOf() can accidentally land on a Markdown
    // link target, an HTML attribute, or a formatting marker rather than the
    // text the user actually selected.
    const projected = findMarkdownTextRanges(span, selectedText);
    if (projected && projected.length > 0) {
      const start = spanStart + projected[0].start;
      const end = spanStart + projected.at(-1)!.end;
      if (projected.length === 1 || allowBlockFallback) {
        return { start, end, text: this.visualSource.slice(start, end) };
      }
    }

    // Repeated text inside one rendered block is still unambiguous from the
    // user's caret position. Match its occurrence number in the DOM to the
    // same occurrence in that block's Markdown instead of refusing common
    // selections such as a repeated product or account name.
    if (firstIndex === lastIndex) {
      const candidates = findMarkdownTextRangeCandidates(span, selectedText);
      const sourceElement = this.visualSourceElement(firstIndex);
      if (candidates && candidates.length > 1 && sourceElement) {
        const ordinal = this.renderedOccurrenceBeforeElement(sourceElement, range, selectedText);
        const matched = candidates[ordinal];
        if (matched) {
          const start = spanStart + matched[0].start;
          const end = spanStart + matched.at(-1)!.end;
          if (matched.length === 1 || allowBlockFallback) {
            return { start, end, text: this.visualSource.slice(start, end) };
          }
        }
      }
    }

    const normalizedRange = findNormalizedTextRange(span, selectedText);
    if (normalizedRange) {
      const start = spanStart + normalizedRange.start;
      const end = spanStart + normalizedRange.end;
      return { start, end, text: this.visualSource.slice(start, end) };
    }

    return allowBlockFallback ? { start: spanStart, end: spanEnd, text: span } : null;
  }

  private visualSourceSpan(range: Range): VisualSourceSpan | null {
    const root = this.visualRoot;
    if (!root) return null;
    const sourceIndexes = new Set<number>();

    const addAncestorSourceIndex = (node: Node): void => {
      let current: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
      while (current && current !== root) {
        const sourceIndex = sourceIndexOf(current);
        if (sourceIndex !== null) {
          sourceIndexes.add(sourceIndex);
          return;
        }
        current = current.parentElement;
      }
    };

    addAncestorSourceIndex(range.startContainer);
    addAncestorSourceIndex(range.endContainer);
    for (const child of Array.from(root.children)) {
      if (!(child instanceof HTMLElement)) continue;
      try {
        if (!range.intersectsNode(child)) continue;
      } catch {
        continue;
      }
      const sourceIndex = sourceIndexOf(child);
      if (sourceIndex !== null) sourceIndexes.add(sourceIndex);
    }
    if (sourceIndexes.size === 0) return null;

    const indexes = [...sourceIndexes];
    const firstIndex = Math.min(...indexes);
    const lastIndex = Math.max(...indexes);
    const firstBlock = this.visualBlocks[firstIndex];
    const lastBlock = this.visualBlocks[lastIndex];
    if (!firstBlock || !lastBlock) return null;
    const start = firstBlock.startOffset;
    const end = lastBlock.endOffset;
    return { start, end, text: this.visualSource.slice(start, end), firstIndex, lastIndex };
  }

  private visualSourceElement(index: number): HTMLElement | null {
    const root = this.visualRoot;
    if (!root) return null;
    return Array.from(root.querySelectorAll<HTMLElement>(`[${SOURCE_INDEX_ATTR}]`))
      .find((element) => sourceIndexOf(element) === index) ?? null;
  }

  private renderedOccurrenceBeforeElement(element: HTMLElement, range: Range, selectedText: string): number {
    if (!element.contains(range.startContainer)) return 0;
    const prefix = document.createRange();
    try {
      prefix.selectNodeContents(element);
      prefix.setEnd(range.startContainer, range.startOffset);
    } catch {
      return 0;
    }
    const needle = selectedText.trim().replace(/\s+/g, ' ');
    if (!needle) return 0;
    const text = prefix.toString().replace(/\s+/g, ' ');
    let count = 0;
    for (let offset = 0; offset <= text.length - needle.length;) {
      const index = text.indexOf(needle, offset);
      if (index < 0) break;
      count++;
      offset = index + Math.max(1, needle.length);
    }
    return count;
  }

  private mapVisualRangeToSourceSegments(
    range: Range,
    selectedText: string,
    allowGlobalFallback = true,
  ): SelectionInfo[] | null {
    const exact = /\r?\n/.test(selectedText) ? null : this.mapVisualRangeToSource(range, selectedText, false);
    if (exact) return [exact];
    const span = this.visualSourceSpan(range);
    // Some Wiki.js renderers wrap tables, figures, and other blocks in an
    // extra container. In that case the browser selection intersects the
    // nested cell/text node but none of the editor's direct children carries
    // our source-index marker, so visualSourceSpan() is unavailable. A
    // unique whole-document projection is still safe for inline formatting
    // (and fixes selections such as a single table-cell value), while block
    // commands explicitly opt out and retain their conservative fallback.
    const source = span?.text ?? (allowGlobalFallback ? this.visualSource : null);
    if (source === null) return null;
    const baseOffset = span?.start ?? 0;
    let projected = findMarkdownTextRanges(source, selectedText);
    if ((!projected || projected.length === 0) && allowGlobalFallback && span) {
      projected = findMarkdownTextRanges(this.visualSource, selectedText);
      if (projected) {
        return projected.map((item) => ({
          start: item.start,
          end: item.end,
          text: this.visualSource.slice(item.start, item.end),
        }));
      }
    }
    if ((!projected || projected.length === 0) && allowGlobalFallback) {
      const candidates = findMarkdownTextRangeCandidates(this.visualSource, selectedText);
      if (candidates) {
        const ordinal = this.renderedOccurrenceBefore(range, selectedText);
        const selected = candidates[ordinal];
        if (selected) {
          return selected.map((item) => ({
            start: item.start,
            end: item.end,
            text: this.visualSource.slice(item.start, item.end),
          }));
        }
      }
    }
    if (!projected || projected.length === 0) return null;
    return projected.map((item) => ({
      start: baseOffset + item.start,
      end: baseOffset + item.end,
      text: source.slice(item.start, item.end),
    }));
  }

  private renderedOccurrenceBefore(range: Range, selectedText: string): number {
    const root = this.visualRoot;
    if (!root || !root.contains(range.startContainer)) return 0;
    const prefix = document.createRange();
    try {
      prefix.selectNodeContents(root);
      prefix.setEnd(range.startContainer, range.startOffset);
    } catch {
      return 0;
    }
    const needle = selectedText.trim().replace(/\s+/g, ' ');
    if (!needle) return 0;
    const text = prefix.toString().replace(/\s+/g, ' ');
    let count = 0;
    for (let offset = 0; offset <= text.length - needle.length;) {
      const index = text.indexOf(needle, offset);
      if (index < 0) break;
      count++;
      offset = index + Math.max(1, needle.length);
    }
    return count;
  }

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
    this.markVisualDirty(marker);

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
        this.markVisualDirty(paragraph);
      } else {
        const parent = marker.parentElement;
        marker.replaceWith(fragment);
        this.markVisualDirty(parent);
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
      this.flushVisualCommit(true);
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
        this.applyVisualSourceEdit((text, start, end) => applyColor(text, start, end, color));
        this.closeContextMenu();
      });
      return control;
    });
    addSection('文字顏色', colorControls);
    divider();
    const sizeStrategy = wikiConfig.formatting.fontSizeStrategy;
    const sizeValue = (key: keyof typeof wikiConfig.formatting.fontSizes): string => {
      const config = wikiConfig.formatting.fontSizes[key];
      return sizeStrategy === 'span-style' ? config.spanStyle : config.fontAttr;
    };
    addSection('文字大小', [
      command('小', '小字', () => this.applyVisualSourceEdit((text, start, end) =>
        applySize(text, start, end, sizeValue('small'), sizeStrategy))),
      command('一般', '一般大小', () => this.applyVisualSourceEdit((text, start, end) =>
        applySize(text, start, end, null, sizeStrategy))),
      command('中', '中等大小', () => this.applyVisualSourceEdit((text, start, end) =>
        applySize(text, start, end, sizeValue('medium'), sizeStrategy))),
      command('大', '大字', () => this.applyVisualSourceEdit((text, start, end) =>
        applySize(text, start, end, sizeValue('large'), sizeStrategy))),
      command('特大', '特大字', () => this.applyVisualSourceEdit((text, start, end) =>
        applySize(text, start, end, sizeValue('xlarge'), sizeStrategy))),
    ]);
    divider();
    addSection('其他格式', [
      command('粗體', '粗體', () => this.applyVisualSourceEdit(toggleBold)),
      command('斜體', '斜體', () => this.applyVisualSourceEdit(toggleItalic)),
      command('底線', '底線', () => this.applyVisualSourceEdit((text, start, end) =>
        toggleUnderline(text, start, end, wikiConfig.formatting.underlineTag))),
      command('刪除線', '刪除線', () => this.applyVisualSourceEdit(toggleStrike)),
      command('背景標記', '醒目提示', () => this.applyVisualSourceEdit((text, start, end) =>
        toggleHighlight(text, start, end, wikiConfig.formatting.highlightTag))),
      command('程式碼', '行內程式碼', () => this.applyVisualSourceEdit(toggleInlineCode)),
      command('清除格式', '清除文字格式', () => this.applyVisualSourceEdit(clearFormatting)),
    ]);
    divider();
    addSection('段落排版', [
      command('引用區塊', '切換引用區塊', () => this.applyVisualSourceEdit(toggleBlockquote, true)),
      command('靠左', '靠左對齊', () => this.applyVisualSourceEdit((text, start, end) =>
        setBlockAlign(text, start, end, 'left'), true)),
      command('置中', '置中對齊', () => this.applyVisualSourceEdit((text, start, end) =>
        setBlockAlign(text, start, end, 'center'), true)),
      command('靠右', '靠右對齊', () => this.applyVisualSourceEdit((text, start, end) =>
        setBlockAlign(text, start, end, 'right'), true)),
      command('取消對齊', '移除對齊', () => this.applyVisualSourceEdit((text, start, end) =>
        setBlockAlign(text, start, end, null), true)),
      command('增加縮排', '增加段落縮排', () => this.applyVisualSourceEdit((text, start, end) =>
        changeIndent(text, start, end, 1), true)),
      command('減少縮排', '減少段落縮排', () => this.applyVisualSourceEdit((text, start, end) =>
        changeIndent(text, start, end, -1), true)),
      command('清除 HTML', '清除 HTML 與區塊樣式', () => this.applyVisualSourceEdit(stripHtml, true)),
    ]);
    divider();
    addSection('文字框', [
      command('文字框', '套用一般文字框', () => this.applyVisualSourceEdit((text, start, end) =>
        applyBox(text, start, end, DEFAULT_BOX), true)),
      command('文字框設定', '自訂文字框框線', () => this.promptVisualBoxSettings()),
      command('實線框', '套用 2px 實線框', () => this.applyVisualSourceEdit((text, start, end) =>
        applyBox(text, start, end, { ...DEFAULT_BOX, width: '2px' }), true)),
      command('虛線框', '套用虛線框', () => this.applyVisualSourceEdit((text, start, end) =>
        applyBox(text, start, end, { ...DEFAULT_BOX, width: '2px', style: 'dashed', color: '#6c757d' }), true)),
      command('移除文字框', '只移除文字框樣式', () => this.applyVisualSourceEdit(removeBox, true)),
    ]);
    addSection('快速資訊樣式', BOX_PRESETS.map((preset) =>
      command(preset.label, preset.label, () => this.applyVisualSourceEdit((text, start, end) =>
        applyBox(text, start, end, preset.spec), true)),
    ));
    divider();

    const textColor = el('input', { type: 'color', class: 'fwa-color-input', title: '自訂文字顏色' });
    textColor.addEventListener('change', () => {
      this.applyVisualSourceEdit((text, start, end) => applyColor(text, start, end, textColor.value));
      this.closeContextMenu();
    });
    const background = el('input', { type: 'color', class: 'fwa-color-input', title: '自訂背景顏色' });
    background.value = '#fff3a3';
    background.addEventListener('change', () => {
      this.applyVisualSourceEdit((text, start, end) =>
        applyCustomColor(text, start, end, 'background-color', background.value));
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

  private promptVisualBoxSettings(): void {
    const border = window.prompt('輸入文字框框線，例如 2px dashed #0d6efd', '2px solid #cccccc')?.trim();
    if (!border || /[;{}]/.test(border)) return;
    const radius = window.prompt('輸入圓角，例如 6px；不需要圓角可輸入 0', '6px')?.trim() ?? '6px';
    const parsed = parseBorderShorthand(border);
    this.applyVisualSourceEdit((text, start, end) => applyBox(text, start, end, {
      ...DEFAULT_BOX,
      width: parsed.width,
      style: parsed.style,
      color: parsed.color,
      radius,
      padding: '10px 12px',
    }), true);
  }

  private editContextImage(edit: (image: HTMLImageElement) => void): void {
    const image = this.contextImage;
    if (!image) return;
    image.removeAttribute(EXACT_SOURCE_ATTR);
    edit(image);
    this.markVisualDirty(image);
    this.flushVisualCommit(true);
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

  /**
   * Apply a right-click formatting action directly to Markdown. Mutating the
   * contenteditable DOM would mark an entire list/blockquote dirty and the
   * visual serializer could then rebuild unrelated layout. Source edits change
   * only the intended range (or whole lines for an explicit block action).
   */
  private applyVisualSourceEdit(edit: SourceEdit, allowBlockFallback = false): void {
    const range = this.contextRange;
    if (!range || range.collapsed) return;

    const selectedText = range.toString();
    // If the user formats immediately after typing, commit the current DOM
    // snapshot while keeping the same contenteditable tree alive. This updates
    // visualSource/offsets before syntax mapping without losing the Range.
    if (this.visualDirty && this.canKeepVisualEditing(range) && !this.flushVisualCommit(true)) return;
    const precise = this.mapVisualRangeToSourceSegments(range, selectedText, !allowBlockFallback) ?? [];
    let mapped = precise;
    if (allowBlockFallback && precise.length > 1) {
      const start = precise[0].start;
      const end = precise.at(-1)!.end;
      mapped = [{ start, end, text: this.visualSource.slice(start, end) }];
    } else if (allowBlockFallback && precise.length === 0) {
      mapped = [this.mapVisualRangeToSource(range, selectedText, true)]
        .filter((item): item is SelectionInfo => item !== null);
    }
    if (mapped.length === 0 || mapped.every((item) => item.text.trim() === '')) {
      showToast('無法安全對應這段選取內容；請縮小反白範圍後再套用格式。', 'error', 6000);
      return;
    }

    const aggregateStart = mapped[0].start;
    const aggregateEnd = mapped.at(-1)!.end;
    const aggregateText = this.visualSource.slice(aggregateStart, aggregateEnd);

    // Flush other pending visual edits first. The colour operation itself has
    // not touched the DOM, so it never sends the selected block through the
    // lossy visual serializer merely to add a font tag.
    if (this.visualDirty && !this.flushVisualCommit()) return;

    const current = this.adapter.getValue();
    let delta = 0;
    if (current.slice(aggregateStart, aggregateEnd) !== aggregateText) {
      const relocated = current.indexOf(aggregateText);
      if (relocated < 0 || relocated !== current.lastIndexOf(aggregateText)) {
        showToast('內容已變動，無法安全定位選取文字；請重新選取後再試。', 'error', 6000);
        return;
      }
      delta = relocated - aggregateStart;
    }

    let next = current;
    let finalSelection = { start: aggregateStart + delta, end: aggregateEnd + delta };
    for (let index = mapped.length - 1; index >= 0; index--) {
      const item = mapped[index];
      const result = edit(next, item.start + delta, item.end + delta);
      next = result.text;
      finalSelection = { start: result.start, end: result.end };
    }
    if (next === current) return;
    const diff = minimalDiff(current, next);
    this.rememberVisualSelection();
    this.deactivateVisualDocument(true);
    this.waitForPreviewRender();
    this.writeSourceValue(diff.from, diff.to, diff.insert, current);
    this.adapter.setSelection(finalSelection.start, finalSelection.end);
  }

  private canKeepVisualEditing(range: Range): boolean {
    const root = this.visualRoot;
    if (!root || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return false;
    const children = Array.from(root.children);
    return children.length === this.visualBlocks.length &&
      children.every((element, index) => sourceIndexOf(element as HTMLElement) === index);
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
    if (this.mode !== 'raw' && !this.flushVisualCommit()) return;
    if (this.mode === 'raw') this.commitRaw();
    window.setTimeout(() => {
      const icon = document.querySelector<HTMLElement>(wikiConfig.editor.saveButtonIconSelector);
      const save = icon?.closest<HTMLButtonElement>('button');
      if (save) save.click();
      else showToast('找不到 Wiki.js 原生 Save 按鈕，內容仍保留在原生 Markdown Editor。', 'error', 6000);
    }, 0);
  }

  private readonly onNativeSaveCapture = (event: MouseEvent): void => {
    if (this.mode === 'raw') return;
    const icon = document.querySelector<HTMLElement>(wikiConfig.editor.saveButtonIconSelector);
    const saveButton = icon?.closest<HTMLButtonElement>('button');
    if (!saveButton || !event.composedPath().includes(saveButton)) return;
    if (this.flushVisualCommit()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  /**
   * Future still uses Wiki.js' native Close action.  Before that handler runs,
   * leave the fixed Future shell through the same Classic cleanup path.  The
   * old fixed preview/body lock could otherwise survive the SPA navigation and
   * make the Close action look frozen.  We deliberately keep the native event
   * flowing after the cleanup so Classic and Future use one button and one
   * Wiki.js close implementation.
   */
  private readonly onNativeCloseCapture = (event: MouseEvent): void => {
    if (this.mode !== 'hybrid') return;
    const closeButton = this.findNativeCloseButton();
    if (!closeButton || !event.composedPath().includes(closeButton)) return;

    // Keep the native Close semantics: pending visual edits are first synced
    // to the Markdown adapter, but Wiki.js still decides whether to save,
    // prompt, or leave the page. Do not persist the temporary Classic mode —
    // the user's preferred Future mode should remain the default next time.
    if (!this.setMode('classic', false)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  };

  private findNativeCloseButton(): HTMLButtonElement | null {
    const saveIcon = document.querySelector<HTMLElement>(wikiConfig.editor.saveButtonIconSelector);
    const saveButton = saveIcon?.closest<HTMLButtonElement>('button') ?? null;
    const header = saveButton ? this.findNativeHeader(saveButton) : null;
    const candidates = Array.from((header ?? document).querySelectorAll<HTMLButtonElement>('button'));
    return candidates.find((button) => {
      const label = [
        button.textContent ?? '',
        button.getAttribute('aria-label') ?? '',
        button.getAttribute('title') ?? '',
      ].join(' ').replace(/\s+/g, ' ').trim();
      if (/\bclose\b/i.test(label) || /關閉|退出(?:編輯|全螢幕)?/.test(label)) return true;

      const classNames = [button, ...Array.from(button.querySelectorAll<HTMLElement>('[class]'))]
        .flatMap((element) => Array.from(element.classList));
      return classNames.some((name) => /(?:mdi|icon)[-_]?close|close[-_]?icon/i.test(name));
    }) ?? null;
  }

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
    if (this.mode !== 'raw' && this.isVisualEditingContext(event)) {
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && key === 'z') {
        event.preventDefault();
        event.stopPropagation();
        this.applyVisualHistory(event.shiftKey ? 'redo' : 'undo');
        return;
      }
      if (modifier && key === 'y') {
        event.preventDefault();
        event.stopPropagation();
        this.applyVisualHistory('redo');
        return;
      }
    }
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    event.stopPropagation();
    this.saveThroughWiki();
  };

  private isVisualEditingContext(event: KeyboardEvent): boolean {
    const root = this.visualRoot;
    if (!root) return false;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      return root.contains(target);
    }
    if (target instanceof Node && root.contains(target)) return true;
    if (document.activeElement && root.contains(document.activeElement)) return true;
    const selection = window.getSelection();
    return Boolean(selection && selection.rangeCount > 0 && root.contains(selection.getRangeAt(0).commonAncestorContainer));
  }

  private applyVisualHistory(direction: 'undo' | 'redo'): void {
    // Let contenteditable's native history undo the last direct visual typing,
    // cut, or paste operation at the same granularity the user expects.
    if (direction === 'undo' && this.visualRoot && this.visualRoot.contains(document.activeElement)) {
      const before = this.visualRoot.innerHTML;
      if (document.execCommand('undo') && this.visualRoot.innerHTML !== before) {
        this.markVisualDirtyFromNode(window.getSelection()?.anchorNode ?? null);
        return;
      }
    } else if (direction === 'redo' && this.visualRoot && this.visualRoot.contains(document.activeElement)) {
      const before = this.visualRoot.innerHTML;
      if (document.execCommand('redo') && this.visualRoot.innerHTML !== before) {
        this.markVisualDirtyFromNode(window.getSelection()?.anchorNode ?? null);
        return;
      }
    }

    if (!this.flushVisualCommit()) return;
    const before = this.adapter.getValue();
    try {
      const changed = direction === 'undo' ? this.adapter.undo() : this.adapter.redo();
      const after = this.adapter.getValue();
      if (!changed && after === before) return;
    } catch (error) {
      showToast(`無法${direction === 'undo' ? '復原' : '重做'}目前編輯：${error instanceof Error ? error.message : String(error)}`, 'error', 6000);
      return;
    }

    this.deactivateVisualDocument(true);
    this.waitForPreviewRender();
  }
}

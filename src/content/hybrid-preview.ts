import hybridCss from '../styles/hybrid-preview.css?inline';
import { wikiConfig } from '../config/wiki-config';
import { bridgeCall } from './bridge';
import { getSettings, saveSettings } from '../shared/storage';
import type { EditorMode, SelectionInfo, Settings } from '../shared/types';
import type { EditorAdapter } from './editor-adapter';
import { WikiDocumentSync, type DocumentSyncEvent } from './document-sync';
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
  semanticTypeFromRenderedElement,
  trailingAttributeLines,
} from './hybrid-serialize';
import { collectImageFiles, type ImageDropHandler } from './image-drop';
import { icon, type IconName } from './icons';
import { BOX_PRESETS, DEFAULT_BOX, parseBorderShorthand } from './html-style';
import { findImages, parseMarkdownImage } from './markdown-image';
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
import { VisualRevisionGate, type VisualRevisionToken } from './visual-revision';
import { createVisualPasteEdit, visualMarkup, type VisualPasteEdit } from './visual-paste-history';
import {
  findMarkdownTextRangeCandidates,
  findMarkdownTextRanges,
  findNormalizedTextRange,
} from './visual-selection';

const STYLE_ID = 'fwa-hybrid-preview-style';
const SOURCE_INDEX_ATTR = 'data-fwa-source-index';
const DIRTY_BLOCK_ATTR = 'data-fwa-visual-dirty';
const EXACT_SOURCE_ATTR = 'data-fwa-markdown-source';
const SEMANTIC_TYPE_ATTR = 'data-fwa-semantic-type';
// Ordinary visual input is recorded in the foreground journal immediately and
// serialized by the same short debounce that the editor used before the
// synchronization fix. The delay only groups a typing burst; it is not an
// input lock and never triggers a visual rebind.
const VISUAL_SYNC_DELAY_MS = 700;
const VISUAL_BACKGROUND_COMMIT_DELAY_MS = VISUAL_SYNC_DELAY_MS;
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

interface PendingVisualRender {
  generation: VisualRevisionToken;
  transactionId?: string;
  workingSeq?: number;
  reconcile?: boolean;
}

interface VisualWorkingOperation {
  sequence: number;
  transactionId: string;
  generation: VisualRevisionToken;
}

type VisualSpaceBoundary = 'start' | 'middle' | 'end';

interface VisualSpaceEdit {
  range: Range;
  colorElement: HTMLElement;
  boundary: VisualSpaceBoundary;
}

function sourceIndexOf(element: HTMLElement): number | null {
  const raw = element.getAttribute(SOURCE_INDEX_ATTR);
  if (raw === null) return null;
  const index = Number(raw);
  return Number.isInteger(index) ? index : null;
}

/**
 * Check the cheap structural facts that survive a Wiki.js render. This is
 * intentionally permissive for paragraphs and divs because Wiki.js changes
 * their wrapper tags between Markdown versions; semantic classes, when
 * present, are the stronger identity signal.
 */
function visualElementMatchesBlock(element: HTMLElement, block: HybridMarkdownBlock): boolean {
  const renderedSemantic = semanticTypeFromRenderedElement(element);
  if (
    renderedSemantic &&
    (!block.semanticType || renderedSemantic.toLowerCase() !== block.semanticType.toLowerCase())
  ) return false;

  switch (element.tagName) {
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return block.type === 'heading';
    case 'P':
      return ['paragraph', 'link', 'mixed', 'image'].includes(block.type);
    case 'BLOCKQUOTE':
      return block.type === 'blockquote';
    case 'UL':
    case 'OL':
      return block.type === 'list';
    case 'TABLE':
      return block.type === 'table';
    case 'PRE':
      return block.type === 'code-fence';
    case 'HR':
      return block.type === 'horizontal-rule';
    case 'IMG':
      return block.type === 'image';
    case 'DIV':
      return ['html', 'paragraph', 'link', 'mixed'].includes(block.type);
    default:
      return true;
  }
}

function isVisualColorElement(element: HTMLElement): boolean {
  if (element.tagName === 'FONT') return element.hasAttribute('color');
  if (element.tagName !== 'SPAN') return false;
  return /(?:^|;)\s*color\s*:/i.test(element.getAttribute('style') ?? '');
}

function visualNodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
  if (node instanceof HTMLElement && (node.tagName === 'BR' || node.tagName === 'IMG')) return 1;
  return Array.from(node.childNodes).reduce((total, child) => total + visualNodeLength(child), 0);
}

/** Return the rendered-text offset of a DOM caret point inside an ancestor. */
function visualPointOffsetWithin(node: Node, offset: number, ancestor: HTMLElement): number | null {
  if (node !== ancestor && !ancestor.contains(node)) return null;
  const childNodes = Array.from(node.childNodes);
  const safeOffset = Math.max(0, Math.min(
    offset,
    node.nodeType === Node.TEXT_NODE ? (node.textContent ?? '').length : childNodes.length,
  ));
  let result = node.nodeType === Node.TEXT_NODE
    ? safeOffset
    : childNodes.slice(0, safeOffset).reduce((total, child) => total + visualNodeLength(child), 0);
  let current = node;
  while (current !== ancestor) {
    const parent = current.parentNode;
    if (!parent) return null;
    const index = Array.prototype.indexOf.call(parent.childNodes, current);
    if (index < 0) return null;
    result += Array.from(parent.childNodes)
      .slice(0, index)
      .reduce((total, sibling) => total + visualNodeLength(sibling), 0);
    current = parent;
  }
  return result;
}

function visualColorElementAt(node: Node, root: HTMLElement): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== root) {
    if (current instanceof HTMLElement && isVisualColorElement(current)) return current;
    current = current.parentNode;
  }
  return null;
}

function visualAdjacentNodeAtPoint(node: Node, offset: number, direction: -1 | 1): Node | null {
  let current = node;
  if (node.nodeType === Node.TEXT_NODE) {
    const length = node.textContent?.length ?? 0;
    if ((direction < 0 && offset !== 0) || (direction > 0 && offset !== length)) return null;
  } else {
    const children = Array.from(node.childNodes);
    const safeOffset = Math.max(0, Math.min(offset, children.length));
    const index = direction < 0 ? safeOffset - 1 : safeOffset;
    if (children[index]) return children[index];
  }

  while (current.parentNode) {
    const parent = current.parentNode;
    const index = Array.prototype.indexOf.call(parent.childNodes, current);
    const adjacent = parent.childNodes[index + (direction < 0 ? -1 : 1)];
    if (adjacent) return adjacent;
    current = parent;
  }
  return null;
}

function visualColorAtEdge(
  node: Node | null,
  direction: -1 | 1,
  root: HTMLElement,
): HTMLElement | null {
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) return visualColorElementAt(node, root);

  let current: Node | null = node;
  while (current && current !== root) {
    if (current instanceof HTMLElement && isVisualColorElement(current)) return current;
    const children: Node[] = Array.from(current.childNodes);
    if (children.length === 0) return null;
    const edge: Node = children[direction < 0 ? children.length - 1 : 0];
    if (edge.nodeType === Node.TEXT_NODE) return visualColorElementAt(edge, root);
    current = edge;
  }
  return null;
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
  private visualToolbar: HTMLElement | null = null;
  private toolbarRange: Range | null = null;
  private readonly overlayEscapeEvents = new WeakSet<KeyboardEvent>();
  private rawHost: HTMLElement | null = null;
  private rawTextarea: HTMLTextAreaElement | null = null;
  private visualRoot: HTMLElement | null = null;
  /** Latest renderer-owned root waiting behind a still-active local root. */
  private deferredRenderedRoot: HTMLElement | null = null;
  private visualSource = '';
  private visualBlocks: HybridMarkdownBlock[] = [];
  /** Last foreground DOM snapshot used only if a renderer ignores the page
   * boundary guard and overwrites the same contenteditable root. */
  private foregroundMarkupSnapshot: string | null = null;
  private readonly visualPasteUndo: VisualPasteEdit[] = [];
  private readonly visualPasteRedo: VisualPasteEdit[] = [];
  private visualDirty = false;
  private observer: MutationObserver | null = null;
  private refreshTimer: number | undefined;
  private renderWaitTimer: number | undefined;
  private visualSyncTimer: number | undefined;
  private futureScrollRestoreFrame: number | undefined;
  private awaitingPreviewRender = false;
  private awaitingPreviewGeneration: VisualRevisionToken | null = null;
  private pendingVisualRenders: PendingVisualRender[] = [];
  private ignoreNextObserverMutation = false;
  private expectedObserverRoot: HTMLElement | null = null;
  private expectedObserverTarget: Node | null = null;
  private ignoreNextVisualInputMutation = false;
  private readonly visualRevisionGate = new VisualRevisionGate();
  private latestVisualOperation: VisualWorkingOperation | null = null;
  private visualReconciliationPending = false;
  private lastVisualConflictId: string | null = null;
  private unsubscribeAdapterChanges: (() => void) | null = null;
  private visualComposing = false;
  /** Plain text node created when a space exits an inline colour wrapper. */
  private visualPlainTypingNode: Text | null = null;
  /** True while the browser still considers the visual working surface focused. */
  private visualFocused = false;
  private pendingVisualSelection: VisualSelectionBookmark | null = null;
  private selectionRestoreTimer: number | undefined;
  private contextMenu: HTMLElement | null = null;
  private contextRange: Range | null = null;
  private contextImage: HTMLImageElement | null = null;
  private activeImageUploads = 0;
  private cachedSaveButton: HTMLButtonElement | null = null;
  private bypassNativeSaveCapture = false;
  private futureContentMinHeight: string | null = null;
  private pendingFutureScrollTop: number | null = null;
  private mode: EditorMode;
  private readonly documentSync: WikiDocumentSync;
  private readonly ownsDocumentSync: boolean;

  constructor(
    private readonly adapter: EditorAdapter,
    private readonly settings: Settings,
    private readonly imageDrop: ImageDropHandler | null = null,
    documentSync?: WikiDocumentSync,
  ) {
    this.mode = settings.editorMode;
    this.documentSync = documentSync ?? new WikiDocumentSync(adapter, { debug: settings.debugMode });
    this.ownsDocumentSync = documentSync === undefined;
  }

  private currentVisualGeneration(): VisualRevisionToken {
    return this.visualRevisionGate.snapshot();
  }

  private isCurrentVisualGeneration(generation: VisualRevisionToken): boolean {
    return this.visualRevisionGate.isCurrent(generation);
  }

  /**
   * Invalidate asynchronous visual work without changing the Markdown
   * document revision. This is deliberately separate from WikiDocumentModel:
   * a visual DOM draft can advance before its serializer has produced a
   * source transaction.
   */
  private rescheduleLatestVisualWork(): void {
    if (this.mode === 'raw') return;
    const generation = this.currentVisualGeneration();
    if (this.documentSync.hasConflict) {
      this.restoreConflictedVisualRoot(generation);
      if (this.visualRoot && (this.visualDirty || this.latestVisualOperation)) {
        this.scheduleVisualCommit(generation);
      }
      return;
    }
    if (this.pendingVisualRenders.length > 0 && !this.awaitingPreviewRender) {
      this.armPreviewRenderWait();
    }
    if (this.visualRoot && (this.visualDirty || this.latestVisualOperation)) {
      this.scheduleVisualCommit(generation);
      return;
    }
    if (this.visualRoot && this.pendingVisualRenders.length > 0) return;
    this.scheduleVisualRefresh(generation);
  }

  private visualSyncOptions(generation: VisualRevisionToken): {
    startVisualRevision: number;
    startInputEpoch: number;
    isVisualRevisionCurrent: () => boolean;
  } {
    return {
      startVisualRevision: generation.startVisualRevision,
      startInputEpoch: generation.startInputEpoch,
      isVisualRevisionCurrent: () => this.isCurrentVisualGeneration(generation),
    };
  }

  /** The active root may remain connected while Wiki.js moves it out of the
   * preview container. Preview membership, rather than isConnected alone, is
  * the ownership boundary used by reconciliation. */
  private visualRootIsMounted(root = this.visualRoot): boolean {
    return Boolean(root && this.previewContent?.contains(root));
  }

  private hasExternalPreviewMutation(
    records: readonly MutationRecord[],
    liveRoot: HTMLElement | null,
  ): boolean {
    const content = this.previewContent;
    if (!content) return false;
    return records.some((record) => {
      if (record.target === content) return true;
      if (!liveRoot || !liveRoot.contains(record.target)) return true;
      // Removed nodes are no longer descendants by the time MutationObserver
      // runs, so the target is the reliable ownership signal for an in-root
      // contenteditable mutation.
      return false;
    });
  }

  private markOwnPreviewMutation(expectedRoot: HTMLElement, target: Node | null = this.previewContent): void {
    this.ignoreNextObserverMutation = true;
    this.expectedObserverRoot = expectedRoot;
    this.expectedObserverTarget = target;
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
    this.visualToolbar = this.buildVisualToolbar();
    preview.insertBefore(this.visualToolbar, content);
    document.addEventListener('selectionchange', this.onToolbarSelectionChange);
    this.unsubscribeAdapterChanges = this.documentSync.subscribe(this.onDocumentSyncEvent);
    this.documentSync.setWorkingCopyRecovery(() => this.rescheduleLatestVisualWork());

    // Wiki.js scroll-syncs this preview to the CodeMirror cursor after every
    // change — including our background visual-edit writes, which would yank
    // the document away from where the user is typing in Classic and Future.
    try {
      bridgeCall('guardScrollSync');
    } catch {
      // Textarea pages have no bridge, and non-Wiki.js editors no scrollSync.
    }

    this.observer = new MutationObserver((records) => {
      if (this.mode === 'raw') return;
      if (this.ignoreNextObserverMutation) {
        const expectedRoot = this.expectedObserverRoot;
        const expectedTarget = this.expectedObserverTarget;
        this.ignoreNextObserverMutation = false;
        this.expectedObserverRoot = null;
        this.expectedObserverTarget = null;
        // Only consume the mutation generated by our own single-root
        // replaceChildren(). If Wiki.js finishes a render in a later task and
        // appends/replaces another root, it must still be observed.
        if (
          expectedRoot &&
          this.previewContent?.firstElementChild === expectedRoot &&
          this.previewContent?.children.length === 1 &&
          records.every((record) =>
            record.type === 'childList' &&
            record.target === (expectedTarget ?? this.previewContent),
          )
        ) return;
      }
      const liveRoot = this.visualRoot;
      const previewStructureChanged = this.hasExternalPreviewMutation(records, liveRoot);
      const onlyVisualInputMutation = Boolean(
        this.visualRootIsMounted(liveRoot) &&
        records.length > 0 &&
        liveRoot !== null &&
        records.every((record) => liveRoot.contains(record.target)),
      );
      if (this.ignoreNextVisualInputMutation && onlyVisualInputMutation) {
        // The browser's own contenteditable mutation is not a Wiki.js render.
        // Do not consume a pending render token for a keystroke that has just
        // entered the local visual draft.
        this.ignoreNextVisualInputMutation = false;
        return;
      }
      this.ignoreNextVisualInputMutation = false;

      // Wiki.js 2.x keeps the editorPreview element and assigns its
      // innerHTML during the debounced Markdown render. That mutation targets
      // this same live root, so there is no detached-root signal to trigger
      // the normal reconciliation branch. Rebind source metadata immediately
      // and restore an existing live selection only for this renderer
      // boundary; the page-world projection guard normally prevents this
      // mutation altogether for a visual-originated write.
      if (
        liveRoot &&
        this.visualRootIsMounted(liveRoot) &&
        records.some((record) => record.type === 'childList' && record.target === liveRoot)
      ) {
        this.reconcileSameRootRendererMutation(liveRoot);
      }

      if (previewStructureChanged) this.rememberDeferredRenderedRoot(liveRoot);

      // Once a visual root is active it is the foreground working surface.
      // Mutations inside it are either browser input or renderer noise; neither
      // may cause the root to be rebound while the user is editing it.
      if (this.awaitingPreviewRender) {
        const renderGeneration = this.awaitingPreviewGeneration;
        window.clearTimeout(this.renderWaitTimer);
        this.renderWaitTimer = undefined;
        if (!renderGeneration) {
          this.awaitingPreviewRender = false;
          this.awaitingPreviewGeneration = null;
          this.scheduleVisualRefresh(this.currentVisualGeneration(), this.visualReconciliationPending);
        } else {
          this.finishPreviewRender(renderGeneration);
          if (!this.isCurrentVisualGeneration(renderGeneration)) {
            // A new visual input arrived while Wiki.js was rendering the old
            // source snapshot. The render is obsolete; keep the live draft and
            // let the newest generation serialize without rebinding the root.
            if (this.visualRoot && this.visualOwnsForeground()) this.restoreStaleVisualRoot();
            this.rescheduleLatestVisualWork();
          } else if (this.visualReconciliationPending && !this.visualDirty && !this.latestVisualOperation) {
            this.scheduleVisualRefresh(renderGeneration, true);
          } else if (this.pendingVisualRenders.length > 0) {
            this.armPreviewRenderWait();
          } else if (this.deferredRenderedRoot && liveRoot && this.visualRootIsMounted(liveRoot)) {
            this.scheduleVisualRefresh(renderGeneration, true);
          } else if (liveRoot && !this.visualRootIsMounted(liveRoot)) {
            this.reconcileDetachedVisualRoot(renderGeneration);
          }
        }
        return;
      }

      if (this.visualRoot && !this.visualRootIsMounted(this.visualRoot)) {
        // Never serialize synchronously from a renderer callback. Keep the
        // same node only when it is still the foreground working copy; an
        // unowned detached node must not cover the renderer's latest DOM.
        this.reconcileDetachedVisualRoot();
        return;
      }

      if (!this.visualRoot || !this.visualMappingIsCurrent()) {
        if (this.documentSync.hasConflict) return;
        if (this.documentSync.hasPendingProjection) return;
        this.scheduleVisualRefresh(this.currentVisualGeneration(), this.visualReconciliationPending);
      } else if (previewStructureChanged && this.deferredRenderedRoot) {
        // An untagged/late Wiki.js render can arrive after the acknowledgement
        // token was consumed. Adopt it only after the foreground has released
        // the old root; scheduleVisualRefresh() performs that ownership check.
        this.scheduleVisualRefresh(this.currentVisualGeneration(), true);
      }
    });
    this.observer.observe(content, { childList: true, characterData: true, subtree: true });
    window.addEventListener('keydown', this.onWindowKeyDownCapture, true);
    window.addEventListener('resize', this.updateNativeHeaderOffset);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);
    document.addEventListener('beforeinput', this.onVisualBeforeInput, true);
    document.addEventListener('mousedown', this.onDocumentMouseDown, true);
    document.addEventListener('focusin', this.onDocumentFocusIn, true);
    document.addEventListener('click', this.onNativeSaveCapture, true);
    document.addEventListener('click', this.onNativeCloseCapture, true);
    // A SPA/editor remount can create a new feature instance while the old
    // visual root still owns focus. Treat that as background reattachment,
    // not as a fresh Future-mode activation that may focus the first block.
    this.applyMode(true);
  }

  detach(): void {
    const preserveExistingForeground = Boolean(
      this.visualRoot && this.visualOwnsForeground(this.visualRoot),
    );
    if (this.mode !== 'raw' && !this.visualComposing) this.flushVisualCommit();
    // PageObserver may tear down this feature after Wiki.js has detached the
    // preview root but before our observer gets a chance to restore it. Keep
    // the foreground node in the shared preview so the next feature instance
    // can bind to the same DOM instead of focusing the first heading.
    if (preserveExistingForeground && this.visualRoot && !this.visualRootIsMounted(this.visualRoot)) {
      this.restoreStaleVisualRoot();
    }
    if (!preserveExistingForeground) this.promoteDeferredRenderedRoot();
    window.removeEventListener('keydown', this.onWindowKeyDownCapture, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
    document.removeEventListener('beforeinput', this.onVisualBeforeInput, true);
    document.removeEventListener('mousedown', this.onDocumentMouseDown, true);
    document.removeEventListener('focusin', this.onDocumentFocusIn, true);
    document.removeEventListener('click', this.onNativeSaveCapture, true);
    document.removeEventListener('click', this.onNativeCloseCapture, true);
    document.removeEventListener('selectionchange', this.onToolbarSelectionChange);
    window.removeEventListener('resize', this.updateNativeHeaderOffset);
    this.observer?.disconnect();
    this.observer = null;
    this.unsubscribeAdapterChanges?.();
    this.unsubscribeAdapterChanges = null;
    window.clearTimeout(this.refreshTimer);
    window.clearTimeout(this.renderWaitTimer);
    window.clearTimeout(this.visualSyncTimer);
    this.visualSyncTimer = undefined;
    this.clearFutureScrollSnapshot();
    window.clearTimeout(this.selectionRestoreTimer);
    this.pendingVisualSelection = null;
    this.awaitingPreviewRender = false;
    this.awaitingPreviewGeneration = null;
    this.pendingVisualRenders = [];
    this.ignoreNextObserverMutation = false;
    this.expectedObserverRoot = null;
    this.expectedObserverTarget = null;
    this.ignoreNextVisualInputMutation = false;
    this.latestVisualOperation = null;
    this.visualReconciliationPending = false;
    this.visualPasteUndo.length = 0;
    this.visualPasteRedo.length = 0;
    this.deferredRenderedRoot = null;
    this.closeContextMenu();
    this.deactivateVisualDocument(false, preserveExistingForeground);
    this.documentSync.setActiveEditor(null);
    this.documentSync.setWorkingCopyRecovery(null);
    this.rawHost?.remove();
    this.rawHost = null;
    this.rawTextarea = null;
    if (this.previewContent) {
      this.previewContent.style.display = '';
      this.previewContent.classList.remove('fwa-future-shell');
    }
    this.toolbar?.remove();
    this.toolbar = null;
    this.visualToolbar?.remove();
    this.visualToolbar = null;
    this.toolbarRange = null;
    this.cachedSaveButton = null;
    this.preview?.classList.remove('fwa-mode-frame', 'fwa-hybrid-fullscreen');
    this.preview?.style.removeProperty('--fwa-future-top');
    document.documentElement.classList.remove('fwa-hybrid-page-open');
    this.preview = null;
    this.previewContent = null;
    if (this.ownsDocumentSync) this.documentSync.dispose();
  }

  private buildModeToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'fwa-mode-toolbar';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', '編輯方式');

    const choices: Array<[EditorMode, string]> = [
      ['classic', '原始碼'],
      ['hybrid', '視覺編輯'],
    ];
    for (const [mode, label] of choices) {
      const control = actionButton(label, mode === 'classic' ? '並排編輯 Markdown 與預覽' : '直接在文章上編輯', `fwa-mode-button fwa-mode-${mode}`);
      control.prepend(icon(mode === 'classic' ? 'code' : 'edit', 14));
      control.dataset.mode = mode;
      control.addEventListener('click', () => this.setMode(mode));
      toolbar.appendChild(control);
    }
    return toolbar;
  }

  /** Editor chrome stays beside the preview content, never inside serialized article DOM. */
  private buildVisualToolbar(): HTMLElement {
    const toolbar = el('div', {
      class: 'fwa-visual-toolbar', role: 'toolbar', 'aria-label': '文字與段落格式',
      'aria-keyshortcuts': 'Alt+F10', tabindex: '0',
    });
    const selectionLabel = el('span', { class: 'fwa-visual-selection-label', text: '選取文字以設定格式' });
    const group = (label: string) => el('div', { class: 'fwa-visual-tool-group', role: 'group', 'aria-label': label });
    const inline = group('文字樣式');
    const paragraph = group('段落對齊');
    const command = (label: string, title: string, edit: SourceEdit, block = false, className = '', glyph?: IconName) => {
      const button = el('button', {
        class: `fwa-visual-tool ${className}`.trim(), type: 'button', title, 'aria-label': title,
        'data-selection-command': '', text: label,
      });
      if (glyph) button.replaceChildren(icon(glyph, 17));
      button.addEventListener('click', () => this.runToolbarEdit(edit, block));
      return button;
    };
    inline.append(
      command('B', '粗體（Ctrl+B）', toggleBold, false, 'fwa-tool-bold', 'bold'),
      command('I', '斜體（Ctrl+I）', toggleItalic, false, 'fwa-tool-italic', 'italic'),
      command('U', '底線（Ctrl+U）', (text, start, end) =>
        toggleUnderline(text, start, end, wikiConfig.formatting.underlineTag), false, 'fwa-tool-underline', 'underline'),
      command('標記', '背景標記', (text, start, end) =>
        toggleHighlight(text, start, end, wikiConfig.formatting.highlightTag)),
    );
    for (const [label, align, glyph] of [['靠左', 'left', 'alignLeft'], ['置中', 'center', 'alignCenter'], ['靠右', 'right', 'alignRight']] as const) {
      paragraph.append(command(label, `段落${label}`, (text, start, end) =>
        setBlockAlign(text, start, end, align), true, '', glyph));
    }
    const more = el('button', {
      class: 'fwa-visual-tool fwa-visual-tool-more', type: 'button', text: '更多格式',
      title: '文字顏色、字級、資訊框與完整格式', 'aria-haspopup': 'true',
      'data-selection-command': '',
    });
    more.append(icon('chevronDown', 14));
    more.addEventListener('click', (event) => {
      if (!this.restoreToolbarSelection()) return;
      const rect = more.getBoundingClientRect();
      this.openContextMenu(rect.left, rect.bottom + 8, false);
      if (event.detail === 0) this.contextMenu?.querySelector<HTMLButtonElement>('button')?.focus();
    });
    toolbar.append(
      selectionLabel, inline, paragraph, more,
      el('span', { class: 'fwa-visual-toolbar-guide', text: '圖片按右鍵 · Ctrl+S 儲存 · Alt+F10 工具', title: 'Alt+F10 移至格式工具列；Escape 回到文章' }),
    );
    // Pointer use keeps the live range and caret intact. Keyboard users enter
    // with Tab / Alt+F10; the captured range is restored before a command runs.
    toolbar.addEventListener('mousedown', (event) => {
      if ((event.target as HTMLElement | null)?.closest('button')) event.preventDefault();
    });
    toolbar.addEventListener('keydown', (event) => {
      const controls = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || controls.length === 0) return;
      event.preventDefault();
      const current = controls.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 :
        current < 0 ? (event.key === 'ArrowLeft' ? controls.length - 1 : 0) :
          (current + (event.key === 'ArrowLeft' ? -1 : 1) + controls.length) % controls.length;
      controls[index].focus();
    });
    return toolbar;
  }

  private readonly onToolbarSelectionChange = (): void => {
    const root = this.visualRoot;
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (root && range && !range.collapsed && range.toString().trim() !== '' && root.contains(range.startContainer) && root.contains(range.endContainer)) {
      this.toolbarRange = range.cloneRange();
    } else if (!this.visualToolbar?.contains(document.activeElement) && !this.contextMenu) {
      this.toolbarRange = null;
    }
    this.updateVisualToolbar();
  };

  private updateVisualToolbar(): void {
    const root = this.visualRoot;
    const range = this.toolbarRange;
    const available = Boolean(root && range && !range.collapsed && range.toString().trim() !== '' &&
      root.contains(range.startContainer) && root.contains(range.endContainer));
    for (const button of Array.from(this.visualToolbar?.querySelectorAll<HTMLButtonElement>('[data-selection-command]') ?? [])) {
      button.disabled = !available;
    }
    const label = this.visualToolbar?.querySelector('.fwa-visual-selection-label');
    if (label) label.textContent = available ? '編輯選取文字' : '選取文字以設定格式';
  }

  private restoreToolbarSelection(): boolean {
    const root = this.visualRoot;
    const range = this.toolbarRange;
    if (!root || !range || range.collapsed || range.toString().trim() === '' || !root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      this.updateVisualToolbar();
      return false;
    }
    this.closeContextMenu();
    root.focus({ preventScroll: true });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range.cloneRange());
    this.contextRange = range.cloneRange();
    return true;
  }

  private runToolbarEdit(edit: SourceEdit, block = false): void {
    if (!this.restoreToolbarSelection()) return;
    this.applyVisualSourceEdit(edit, block);
    this.closeContextMenu();
  }

  private mountToolbarBesideNativeActions(): void {
    const icon = document.querySelector<HTMLElement>(wikiConfig.editor.saveButtonIconSelector);
    const saveButton = icon?.closest<HTMLButtonElement>('button') ?? null;
    const parent = saveButton?.parentElement ?? null;
    if (!saveButton || !parent || !this.toolbar) return;

    parent.insertBefore(this.toolbar, saveButton);
    this.updateNativeHeaderOffset();
  }

  private readonly updateNativeHeaderOffset = (): void => {
    const saveButton = document.querySelector<HTMLElement>(wikiConfig.editor.saveButtonIconSelector)?.closest<HTMLButtonElement>('button');
    if (!saveButton || !this.preview) return;
    const nativeHeader = this.findNativeHeader(saveButton);
    const headerBottom = nativeHeader?.getBoundingClientRect().bottom ?? saveButton.getBoundingClientRect().bottom;
    this.preview.style.setProperty('--fwa-future-top', `${Math.max(0, Math.round(headerBottom))}px`);
  };

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

  /** Open Future mode when the action originates from the onboarding guide. */
  async activateFutureMode(): Promise<boolean> {
    if (!this.preview || !this.previewContent) return false;
    const activated = this.setMode('hybrid', false);
    if (!activated) return false;
    try {
      await this.persistMode();
    } catch {
      // The Future surface is already active; a later settings save can retry
      // persisting the preferred mode without blocking the visual transition.
    }
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
      control.setAttribute('aria-pressed', String(control.dataset.mode === this.mode));
    }
  }

  private applyMode(preserveExistingForeground = false): void {
    if (!this.preview || !this.previewContent) return;
    const preserveForegroundFocus = preserveExistingForeground &&
      this.previewContent.contains(document.activeElement);
    this.clearFutureScrollSnapshot();
    this.closeContextMenu();
    if (!preserveForegroundFocus) this.promoteDeferredRenderedRoot();
    this.deactivateVisualDocument();
    this.rawHost?.remove();
    this.rawHost = null;
    this.rawTextarea = null;
    this.previewContent.style.display = '';
    this.previewContent.classList.remove('fwa-future-shell');
    this.preview.classList.remove('fwa-hybrid-fullscreen');
    document.documentElement.classList.remove('fwa-hybrid-page-open');
    this.updateModeButtons();
    if (this.visualToolbar) this.visualToolbar.hidden = this.mode !== 'hybrid';
    this.toolbarRange = null;
    this.updateVisualToolbar();

    if (this.mode === 'raw') {
      this.mountRawEditor();
      return;
    }
    if (this.mode === 'hybrid') {
      this.preview.classList.add('fwa-hybrid-fullscreen');
      document.documentElement.classList.add('fwa-hybrid-page-open');
      this.previewContent.classList.add('fwa-future-shell');
    }
    this.activateVisualDocument(this.currentVisualGeneration(), !preserveForegroundFocus);
  }

  private mountRawEditor(): void {
    if (!this.preview || !this.previewContent) return;
    this.previewContent.style.display = 'none';
    const host = document.createElement('div');
    host.className = 'fwa-raw-editor';
    const textarea = document.createElement('textarea');
    textarea.className = 'fwa-hybrid-source';
    textarea.value = this.documentSync.markdown;
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
    const current = this.documentSync.markdown;
    if (textarea.value === current) return;
    // Write only the changed range: a whole-document replace re-tokenizes the
    // full CodeMirror buffer on every Raw keystroke. Skip the block re-parse
    // too — activateVisualDocument() re-parses when leaving Raw mode anyway.
    const diff = minimalDiff(current, textarea.value);
    this.writeSourceValue(diff.from, diff.to, diff.insert, current, false, 'system');
  }

  /**
   * Native changes update background status; the active visual root stays put.
   */
  private readonly onDocumentSyncEvent = (event: DocumentSyncEvent): void => {
    if (this.mode === 'raw') {
      if (this.rawTextarea && document.activeElement !== this.rawTextarea) {
        this.rawTextarea.value = this.documentSync.markdown;
      }
      return;
    }
    if (event.type === 'transaction') return;
    if (event.type === 'projection') {
      if (this.visualRoot && this.visualOwnsForeground()) this.rememberVisualSelection();
      if (event.projectionApplied === false) {
        const generation = event.startVisualRevision !== undefined && event.startInputEpoch !== undefined
          ? {
              startVisualRevision: event.startVisualRevision,
              startInputEpoch: event.startInputEpoch,
            }
          : undefined;
        this.dropVisualRender(event.transactionId, generation);
        this.rescheduleLatestVisualWork();
      } else if (
        this.pendingVisualRenders.length > 0 &&
        !this.awaitingPreviewRender &&
        !(event.startVisualRevision !== undefined && event.startInputEpoch !== undefined &&
          !this.isCurrentVisualGeneration({
            startVisualRevision: event.startVisualRevision,
            startInputEpoch: event.startInputEpoch,
          }))
      ) {
        // Do not arm the observer before native projection completes: the
        // input DOM mutation itself is not a Wiki.js render.
        this.armPreviewRenderWait();
      }
      return;
    }

    if (
      event.startVisualRevision !== undefined &&
      event.startInputEpoch !== undefined &&
      !this.isCurrentVisualGeneration({
        startVisualRevision: event.startVisualRevision,
        startInputEpoch: event.startInputEpoch,
      })
    ) {
      // The event belongs to an older visual serialization. It must not
      // deactivate or restore the currently edited DOM.
      this.rescheduleLatestVisualWork();
      return;
    }

    if (event.type === 'conflict') {
      this.restoreConflictedVisualRoot();
      return;
    }

    // Native source changes redraw the preview asynchronously just like
    // Future-originated writes. Capture the fullscreen viewport before that
    // redraw can temporarily collapse the preview and clamp scrollTop to 0.
    this.rememberFutureScroll();

    // A successful rebase already contains the local visual transaction. Keep
    // the active DOM alive; it is the foreground working copy.
    if (
      event.type === 'rebase' ||
      this.visualDirty ||
      this.latestVisualOperation ||
      this.documentSync.currentSeq > this.documentSync.ackSeq
    ) {
      return;
    }

    // Rebinding is an explicit reconciliation path for a clean visual editor
    // only. Background projection/render events never call deactivate.
    this.visualReconciliationPending = true;
    const generation = this.currentVisualGeneration();
    this.waitForPreviewRender(generation, true);
  };

  private writeSourceValue(
    start: number,
    end: number,
    replacement: string,
    sourceBefore: string,
    reparse = true,
    origin: 'classic-preview' | 'future' | 'system' = this.mode === 'hybrid' ? 'future' : 'classic-preview',
    visualGeneration: VisualRevisionToken | null = null,
    workingOperation: VisualWorkingOperation | null = null,
  ): boolean {
    const generation = visualGeneration ?? this.currentVisualGeneration();
    if (
      (origin === 'future' || origin === 'classic-preview') &&
      !this.isCurrentVisualGeneration(generation)
    ) {
      this.rescheduleLatestVisualWork();
      return false;
    }
    if ((origin === 'future' || origin === 'classic-preview') && this.visualOwnsForeground()) {
      this.rememberVisualSelection();
    }
    this.rememberFutureScroll();
    const actual = sourceBefore.slice(0, start) + replacement + sourceBefore.slice(end);
    const result = this.documentSync.applySnapshot(sourceBefore, actual, {
      origin,
      view: this.mode === 'hybrid' ? 'future' : this.mode === 'classic' ? 'classic-preview' : 'raw',
      ...(origin === 'future' || origin === 'classic-preview'
        ? {
            ...this.visualSyncOptions(generation),
            transactionId: workingOperation?.transactionId,
            workingSeq: workingOperation?.sequence,
            // Ordinary typing/image edits have already changed the live
            // foreground DOM and must not be rendered back over it. A direct
            // formatting command changes only Markdown, so Wiki.js must be
            // allowed to render the new color/style into the preview.
            suppressPreviewRender: workingOperation !== null,
          }
        : {}),
    });
    if (result.status === 'conflict') {
      if (result.conflict?.id !== this.lastVisualConflictId) {
        showToast('編輯內容與另一個 Markdown 版本衝突；已保留目前畫面與外部版本，未覆寫任一方。', 'error', 7000);
        this.lastVisualConflictId = result.conflict?.id ?? null;
      }
      this.visualDirty = true;
      if (this.isCurrentVisualGeneration(generation)) this.restoreConflictedVisualRoot(generation);
      return false;
    }
    if (
      (origin === 'future' || origin === 'classic-preview') &&
      !this.isCurrentVisualGeneration(generation)
    ) {
      this.rescheduleLatestVisualWork();
      return false;
    }
    if ((origin === 'future' || origin === 'classic-preview') && result.transaction) {
      this.lastVisualConflictId = null;
      // Keep one ordered render token per visual source transaction. A later
      // input may make this token obsolete before Wiki.js mutates the preview;
      // the observer then preserves the live root and waits for the newer
      // token instead of binding the stale rendered tree.
      this.queueVisualRender(generation, result.transaction.transactionId, result.transaction.workingSeq);
    }
    this.visualSource = actual;
    if (reparse) this.visualBlocks = parseHybridBlocks(actual);
    return true;
  }

  /**
   * A visual root is still a foreground working surface when it has a draft,
   * owns focus, or owns the browser selection. This is intentionally based on
   * live DOM ownership, not only on `visualDirty`: a user can stop typing and
   * leave the caret focused while the background renderer catches up.
   */
  private visualOwnsForeground(root = this.visualRoot): boolean {
    if (!root) return false;
    if (this.visualDirty || this.latestVisualOperation || this.visualFocused) return true;
    if (root.contains(document.activeElement)) return true;
    // A stale browser Selection can survive a real blur and even point into a
    // detached tree. It is useful as a restore bookmark, but it is not proof
    // that the old root still owns the foreground. Ownership is explicit:
    // focus, a live draft, or an in-flight visual operation.
    return false;
  }

  /** Remember the live caret before Wiki.js replaces the rendered preview. */
  private rememberVisualSelection(preserveExisting = false): void {
    if (!(preserveExisting && this.pendingVisualSelection)) {
      const bookmark = this.captureVisualSelection();
      if (!bookmark) return;
      this.pendingVisualSelection = bookmark;
    }
    window.clearTimeout(this.selectionRestoreTimer);
    this.selectionRestoreTimer = window.setTimeout(() => {
      this.selectionRestoreTimer = undefined;
      const root = this.visualRoot;
      const foregroundStillOwnsSelection = Boolean(
        root && (
          this.visualDirty ||
          this.latestVisualOperation ||
          this.visualFocused ||
          root.contains(document.activeElement) ||
          this.awaitingPreviewRender ||
          this.pendingVisualRenders.length > 0
        ),
      );
      if (foregroundStillOwnsSelection) {
        this.rememberVisualSelection(true);
        return;
      }
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

  private restoreVisualSelection(
    root: HTMLElement,
    bookmark: VisualSelectionBookmark,
    focus = true,
  ): boolean {
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
    if (focus) root.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  /**
   * Wiki.js replaces the rendered preview after each source write. In Future
   * mode the outer preview is the scroll container, so removing the old root
   * can briefly reduce its scroll height to one viewport and make the browser
   * clamp scrollTop to zero. Hold both the offset and the old content height
   * until the replacement root has been laid out.
   */
  private rememberFutureScroll(): void {
    if (this.mode !== 'hybrid' || !this.preview || !this.previewContent) return;
    if (this.pendingFutureScrollTop !== null) return;
    this.futureContentMinHeight = this.previewContent.style.minHeight;
    this.pendingFutureScrollTop = this.preview.scrollTop;
    const height = Math.max(this.previewContent.scrollHeight, this.preview.scrollHeight);
    if (height > 0) this.previewContent.style.minHeight = `${height}px`;
  }

  private restoreFutureScroll(): void {
    const preview = this.preview;
    const content = this.previewContent;
    const scrollTop = this.pendingFutureScrollTop;
    if (this.mode !== 'hybrid' || !preview || !content || scrollTop === null) return;

    window.cancelAnimationFrame(this.futureScrollRestoreFrame ?? 0);
    preview.scrollTop = scrollTop;
    this.futureScrollRestoreFrame = window.requestAnimationFrame(() => {
      preview.scrollTop = scrollTop;
      this.futureScrollRestoreFrame = window.requestAnimationFrame(() => {
        this.restoreFutureContentMinHeight(content);
        preview.scrollTop = scrollTop;
        this.pendingFutureScrollTop = null;
        this.futureScrollRestoreFrame = undefined;
      });
    });
  }

  private clearFutureScrollSnapshot(): void {
    const hadSnapshot = this.pendingFutureScrollTop !== null;
    window.cancelAnimationFrame(this.futureScrollRestoreFrame ?? 0);
    this.futureScrollRestoreFrame = undefined;
    this.pendingFutureScrollTop = null;
    if (hadSnapshot && this.previewContent) this.restoreFutureContentMinHeight(this.previewContent);
    else this.futureContentMinHeight = null;
  }

  private restoreFutureContentMinHeight(content: HTMLElement): void {
    if (this.futureContentMinHeight) content.style.minHeight = this.futureContentMinHeight;
    else content.style.removeProperty('min-height');
    this.futureContentMinHeight = null;
  }

  private visualMappingIsCurrent(): boolean {
    const root = this.visualRoot;
    if (!root || !this.visualRootIsMounted(root)) return false;
    const mapped = Array.from(root.children)
      .map((child) => sourceIndexOf(child as HTMLElement))
      .filter((index): index is number => index !== null);
    return (
      this.visualBlocks.length === 0
        ? root.children.length === 0
        : mapped.length === root.children.length &&
          new Set(mapped).size === mapped.length &&
          mapped.every((index) => index >= 0 && index < this.visualBlocks.length)
    );
  }

  private sameVisualGeneration(left: VisualRevisionToken, right: VisualRevisionToken): boolean {
    return left.startVisualRevision === right.startVisualRevision &&
      left.startInputEpoch === right.startInputEpoch;
  }

  /** Record the render that Wiki.js owes for a visual source projection. */
  private queueVisualRender(
    generation: VisualRevisionToken,
    transactionId?: string,
    workingSeq?: number,
    arm = false,
    reconcile = false,
  ): void {
    const alreadyQueued = this.pendingVisualRenders.find((item) =>
      this.sameVisualGeneration(item.generation, generation),
    );
    if (alreadyQueued) {
      alreadyQueued.transactionId ??= transactionId;
      alreadyQueued.workingSeq ??= workingSeq;
      alreadyQueued.reconcile = alreadyQueued.reconcile || reconcile;
    } else {
      const awaited = this.awaitingPreviewRender ? this.pendingVisualRenders[0] : undefined;
      this.pendingVisualRenders = awaited
        ? [awaited, { generation, transactionId, workingSeq, reconcile }]
        : [{ generation, transactionId, workingSeq, reconcile }];
    }
    if (arm && !this.awaitingPreviewRender) this.armPreviewRenderWait();
  }

  private dropVisualRender(transactionId?: string, generation?: VisualRevisionToken): void {
    const index = this.pendingVisualRenders.findIndex((item) =>
      (transactionId !== undefined && item.transactionId === transactionId) ||
      (generation !== undefined && this.sameVisualGeneration(item.generation, generation)),
    );
    const droppingAwaited = index === 0 && this.awaitingPreviewGeneration !== null &&
      this.sameVisualGeneration(this.awaitingPreviewGeneration, this.pendingVisualRenders[0]?.generation);
    if (index >= 0) this.pendingVisualRenders.splice(index, 1);
    if (droppingAwaited) {
      window.clearTimeout(this.renderWaitTimer);
      this.renderWaitTimer = undefined;
      this.awaitingPreviewRender = false;
      this.awaitingPreviewGeneration = null;
    }
    if (!this.awaitingPreviewRender && this.pendingVisualRenders.length > 0) this.armPreviewRenderWait();
  }

  private armPreviewRenderWait(): void {
    const next = this.pendingVisualRenders[0];
    if (!next) {
      this.awaitingPreviewRender = false;
      this.awaitingPreviewGeneration = null;
      window.clearTimeout(this.renderWaitTimer);
      this.renderWaitTimer = undefined;
      return;
    }
    this.awaitingPreviewRender = true;
    this.awaitingPreviewGeneration = next.generation;
    window.clearTimeout(this.renderWaitTimer);
    this.renderWaitTimer = window.setTimeout(() => {
      this.renderWaitTimer = undefined;
      this.finishPreviewRender(next.generation);
      if (this.mode === 'raw') return;
      if (this.documentSync.hasConflict) {
        this.restoreConflictedVisualRoot();
        return;
      }
      if (!this.isCurrentVisualGeneration(next.generation)) {
        if (this.visualRoot && this.visualOwnsForeground()) this.restoreStaleVisualRoot();
        else if (this.visualRoot && !this.visualRootIsMounted(this.visualRoot)) {
          this.reconcileDetachedVisualRoot();
        }
        this.rescheduleLatestVisualWork();
        return;
      }
      if (this.pendingVisualRenders.length > 0) {
        this.armPreviewRenderWait();
        return;
      }
      if (next.reconcile && !this.visualDirty && !this.latestVisualOperation) {
        this.scheduleVisualRefresh(this.currentVisualGeneration(), true);
      } else if (!this.visualRoot) {
        this.scheduleVisualRefresh(this.currentVisualGeneration(), true);
      } else if (this.visualRoot && !this.visualRootIsMounted(this.visualRoot)) {
        this.reconcileDetachedVisualRoot();
      }
    }, 1000);
  }

  private finishPreviewRender(generation: VisualRevisionToken): void {
    const index = this.pendingVisualRenders.findIndex((item) =>
      this.sameVisualGeneration(item.generation, generation),
    );
    const completed = index >= 0 ? this.pendingVisualRenders[index] : undefined;
    if (index >= 0) this.pendingVisualRenders.splice(index, 1);
    if (completed?.workingSeq !== undefined) this.documentSync.markRendered(completed.workingSeq);
    this.awaitingPreviewRender = false;
    this.awaitingPreviewGeneration = null;
  }

  private reconcileSameRootRendererMutation(root: HTMLElement): void {
    const ownsForeground = this.visualOwnsForeground(root);
    const bookmark = ownsForeground
      ? (this.pendingVisualSelection ?? this.captureVisualSelection())
      : null;
    const restoreForeground = ownsForeground &&
      this.foregroundMarkupSnapshot !== null &&
      this.visualSource === this.documentSync.markdown;

    if (restoreForeground) {
      // The renderer has already overwritten the root. Restore the saved
      // foreground subtree with a DOM fragment, then only reapply bookkeeping.
      // This path is a fallback for hosts where the page-world guard cannot
      // intercept the framework setter; it never constructs a new editor root.
      const template = document.createElement('template');
      template.innerHTML = this.foregroundMarkupSnapshot!;
      this.markOwnPreviewMutation(root, root);
      root.replaceChildren(...Array.from(template.content.childNodes));
      this.visualBlocks = parseHybridBlocks(this.visualSource);
    } else {
      // For a clean/native render, the renderer has already applied the current
      // native snapshot to this root. Rebuild only the extension's bookkeeping;
      // never replace the root from the Markdown parser here.
      this.visualSource = this.documentSync.markdown;
      this.visualBlocks = parseHybridBlocks(this.visualSource);
    }
    this.mapSourceBlocks(root);

    // This is only the fallback for hosts where the page-world render guard
    // cannot intercept the framework's innerHTML assignment. It restores the
    // same live editing surface and bookmark, rather than focusing a newly
    // mounted heading or title input.
    if (ownsForeground && bookmark && this.restoreVisualSelection(root, bookmark, true)) {
      this.visualFocused = true;
    }
    this.foregroundMarkupSnapshot = root.innerHTML;
  }

  /**
   * Reattach the foreground working tree only when it still owns the user.
   * When the node was detached, capture the existing DOM selection before
   * putting it back. This is a same-node recovery for an externally removed
   * active surface, not a background selection remap; if the bookmark cannot
   * be restored we deliberately leave focus alone instead of inventing a
   * caret at the first block.
   */
  private restoreStaleVisualRoot(): void {
    const root = this.visualRoot;
    const content = this.previewContent;
    if (!root || !content || this.mode === 'raw') return;
    const wasDetached = !this.visualRootIsMounted(root);
    const shouldRestoreFocus = wasDetached && (
      this.visualFocused ||
      root.contains(document.activeElement)
    );
    // Prefer the bookmark captured synchronously by the input handler. After a
    // renderer detaches a contenteditable root, the browser may already have
    // collapsed its live Selection to the first block; using that post-detach
    // value would faithfully restore the wrong caret.
    const bookmark = shouldRestoreFocus
      ? (this.pendingVisualSelection ?? this.captureVisualSelection())
      : null;
    if (wasDetached) {
      this.markOwnPreviewMutation(root);
      content.replaceChildren(root);
    }
    root.classList.add('fwa-visual-document');
    root.classList.toggle('fwa-hybrid-document', this.mode === 'hybrid');
    root.contentEditable = 'true';
    this.restoreFutureScroll();
    this.visualReconciliationPending = false;
    this.documentSync.setActiveEditor(this.mode === 'hybrid' ? 'future' : 'classic-preview');
    if (shouldRestoreFocus && bookmark && this.restoreVisualSelection(root, bookmark, true)) {
      this.visualFocused = true;
    }
  }

  /**
   * Handle a renderer replacement without assuming that the old visual root
   * must win. A focused/dirty/selected root is the foreground working copy
   * and is restored. An unowned root is released so the newest Wiki.js tree
   * can be adopted by the normal background refresh path.
   */
  private reconcileDetachedVisualRoot(generation = this.currentVisualGeneration()): void {
    const root = this.visualRoot;
    if (!root || this.visualRootIsMounted(root)) return;
    this.rememberDeferredRenderedRoot(root);
    if (this.documentSync.hasConflict || this.visualOwnsForeground(root)) {
      if (this.documentSync.hasConflict) this.deferredRenderedRoot = null;
      this.restoreStaleVisualRoot();
      if (this.visualDirty || this.latestVisualOperation) this.rescheduleLatestVisualWork();
      return;
    }

    // The detached node no longer owns the foreground. Do not reattach it and
    // cover the renderer's latest semantic DOM. If another render is queued,
    // wait for that latest token before adopting anything.
    if (this.pendingVisualRenders.length > 0) {
      this.deactivateVisualDocument();
      if (!this.awaitingPreviewRender) this.armPreviewRenderWait();
      return;
    }
    if (this.adoptDeferredRenderedRoot(generation)) return;
    this.deactivateVisualDocument();
    this.scheduleVisualRefresh(generation, true);
  }

  private scheduleVisualRefresh(
    generation = this.currentVisualGeneration(),
    allowActiveReconciliation = false,
  ): void {
    this.rememberFutureScroll();
    if (allowActiveReconciliation && this.visualRoot?.contains(document.activeElement)) {
      this.rememberVisualSelection(true);
    }
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.mode === 'raw') return;
      if (this.documentSync.hasConflict) {
        this.restoreConflictedVisualRoot();
        return;
      }
      if (!this.isCurrentVisualGeneration(generation)) {
        this.rescheduleLatestVisualWork();
        return;
      }
      const root = this.visualRoot;
      if (root && this.visualRootIsMounted(root)) {
        const backgroundSettled = this.pendingVisualRenders.length === 0 &&
          !this.documentSync.hasPendingProjection &&
          this.documentSync.currentSeq <= this.documentSync.ackSeq;
        if (this.deferredRenderedRoot && backgroundSettled && !this.visualOwnsForeground(root)) {
          if (this.adoptDeferredRenderedRoot(generation)) return;
        }
        // The active DOM is already the user's working copy. Background
        // catch-up must not rebind listeners, replace the node, or touch the
        // caret/selection merely because the renderer finished.
        this.visualReconciliationPending = false;
        return;
      }

      if (root && !this.visualRootIsMounted(root)) {
        this.reconcileDetachedVisualRoot(generation);
        return;
      }

      if (this.pendingVisualRenders.length > 0 || this.documentSync.hasPendingProjection) return;

      this.visualReconciliationPending = false;
      this.deferredRenderedRoot = null;
      // Background adoption is deliberately non-focusing. Explicit attach or
      // mode changes use the default focused activation path below.
      this.activateVisualDocument(generation, false);
    }, VISUAL_REFRESH_DELAY_MS);
  }

  /**
   * Wiki.js updates its rendered preview asynchronously after CodeMirror is
   * changed. Wait for an actual preview mutation before binding Future to the
   * new DOM; otherwise Future can attach to the stale tree and appear unchanged
   * until the user toggles modes. The timeout is only a fallback for renderers
   * that replace no child nodes for a particular edit.
   */
  private waitForPreviewRender(
    generation = this.currentVisualGeneration(),
    reconcile = false,
  ): void {
    window.clearTimeout(this.refreshTimer);
    if (this.visualRoot && this.visualOwnsForeground()) this.rememberVisualSelection();
    this.visualReconciliationPending = reconcile;
    this.queueVisualRender(generation, undefined, this.documentSync.modelSeq, true, reconcile);
  }

  /**
   * A stale conflict is a preservation state, not a reason to bind a fresh
   * Wiki.js tree. Wiki.js may already have detached the old root by the time
   * MutationObserver runs; put that same live node back so the user's local
   * DOM remains the active editing surface while the model retains the
   * external Markdown in conflict state.
   */
  private restoreConflictedVisualRoot(generation = this.currentVisualGeneration()): boolean {
    const root = this.visualRoot;
    const content = this.previewContent;
    if (!root || !content || this.mode === 'raw') return false;
    if (!this.isCurrentVisualGeneration(generation)) {
      this.rescheduleLatestVisualWork();
      return false;
    }
    window.clearTimeout(this.refreshTimer);
    window.clearTimeout(this.renderWaitTimer);
    this.renderWaitTimer = undefined;
    this.pendingVisualRenders = [];
    this.deferredRenderedRoot = null;
    this.awaitingPreviewGeneration = null;
    this.awaitingPreviewRender = false;
    this.visualReconciliationPending = false;
    if (!this.visualRootIsMounted(root)) this.restoreStaleVisualRoot();
    root.classList.add('fwa-visual-document');
    root.classList.toggle('fwa-hybrid-document', this.mode === 'hybrid');
    root.contentEditable = 'true';
    this.visualDirty = true;
    this.documentSync.setActiveEditor(this.mode === 'hybrid' ? 'future' : 'classic-preview');
    return true;
  }

  /** Schedule serialization without making the foreground editor wait. */
  private scheduleVisualCommit(
    generation = this.currentVisualGeneration(),
    delay = this.visualComposing ? VISUAL_SYNC_DELAY_MS : VISUAL_BACKGROUND_COMMIT_DELAY_MS,
  ): void {
    window.clearTimeout(this.visualSyncTimer);
    this.visualSyncTimer = window.setTimeout(() => {
      this.visualSyncTimer = undefined;
      if (this.visualComposing) return;
      if (this.mode === 'raw' || !this.visualRoot) return;
      if (!this.isCurrentVisualGeneration(generation)) {
        this.rescheduleLatestVisualWork();
        return;
      }
      // Failure is surfaced by commitVisualDocument (conflict, upload, or an
      // unsafe structure). Do not spin a zero-delay retry loop that competes
      // with the foreground editor.
      this.commitVisualDocument(true, generation);
    }, delay);
  }

  private flushVisualCommit(
    keepVisualEditing = false,
    generation = this.currentVisualGeneration(),
  ): boolean {
    window.clearTimeout(this.visualSyncTimer);
    this.visualSyncTimer = undefined;
    if (!this.isCurrentVisualGeneration(generation)) {
      this.rescheduleLatestVisualWork();
      return false;
    }
    return this.commitVisualDocument(keepVisualEditing, generation);
  }

  private activateVisualDocument(
    generation = this.currentVisualGeneration(),
    focus = true,
  ): void {
    if (this.documentSync.hasConflict) {
      this.restoreConflictedVisualRoot(generation);
      return;
    }
    if (!this.isCurrentVisualGeneration(generation)) {
      this.rescheduleLatestVisualWork();
      return;
    }
    const root = this.previewContent?.firstElementChild as HTMLElement | null;
    if (!root) return;
    const bookmark = focus ? this.pendingVisualSelection : null;
    this.deactivateVisualDocument();
    this.visualSource = this.documentSync.markdown;
    this.visualBlocks = parseHybridBlocks(this.visualSource);
    this.mapSourceBlocks(root);
    root.classList.add('fwa-visual-document');
    root.classList.toggle('fwa-hybrid-document', this.mode === 'hybrid');
    root.contentEditable = 'true';
    root.spellcheck = true;
    root.addEventListener('contextmenu', this.onVisualContextMenu);
    root.addEventListener('input', this.onVisualInput);
    // Chromium may deliver a space through beforeinput without a useful
    // keydown (IME, virtual keyboard, or an editor that consumes keydown).
    // Capture it on the actual editing host before the browser applies its
    // inherited inline typing style.
    root.addEventListener('beforeinput', this.onVisualBeforeInput, true);
    root.addEventListener('compositionstart', this.onVisualCompositionStart);
    root.addEventListener('compositionend', this.onVisualCompositionEnd);
    root.addEventListener('focusin', this.onVisualFocusIn);
    root.addEventListener('focusout', this.onVisualFocusOut);
    root.addEventListener('copy', this.onVisualClipboard);
    root.addEventListener('cut', this.onVisualClipboard);
    root.addEventListener('paste', this.onVisualPaste);
    root.addEventListener('dragover', this.onVisualDragOver);
    root.addEventListener('drop', this.onVisualDrop);
    for (const image of Array.from(root.querySelectorAll<HTMLElement>('img'))) image.contentEditable = 'false';
    this.visualRoot = root;
    this.visualDirty = false;
    this.documentSync.setActiveEditor(this.mode === 'hybrid' ? 'future' : 'classic-preview');
    this.foregroundMarkupSnapshot = root.innerHTML;
    if (focus && bookmark) {
      const restored = this.restoreVisualSelection(root, bookmark);
      window.clearTimeout(this.selectionRestoreTimer);
      this.selectionRestoreTimer = undefined;
      if (!restored) root.focus({ preventScroll: true });
    } else if (focus && this.mode === 'hybrid') {
      root.focus({ preventScroll: true });
    }
    this.restoreFutureScroll();
    if (!focus) {
      window.clearTimeout(this.selectionRestoreTimer);
      this.selectionRestoreTimer = undefined;
    }
    this.pendingVisualSelection = null;
  }

  /** Save the renderer's replacement while the local root remains foreground. */
  private rememberDeferredRenderedRoot(localRoot: HTMLElement | null): void {
    const content = this.previewContent;
    const candidates = content
      ? (Array.from(content.children) as HTMLElement[]).filter((candidate) => candidate !== localRoot)
      : [];
    // A renderer can remove the local root in one task and append its new root
    // in another. Keep the newest non-local child, not only firstElementChild,
    // so the second mutation is not lost after the local root is restored.
    const candidate = candidates.at(-1) ?? null;
    if (candidate) this.deferredRenderedRoot = candidate;
  }

  /**
   * Keep the newest Wiki.js tree separate from a still-active local tree.
   * This is used when the user explicitly changes mode or the feature is
   * detached; neither operation should leave a renderer result stranded in a
   * private field while the old editable root is removed.
   */
  private promoteDeferredRenderedRoot(): void {
    const content = this.previewContent;
    const next = this.deferredRenderedRoot;
    if (!content || !next) return;
    this.deferredRenderedRoot = null;
    if (content.firstElementChild !== next) {
      this.markOwnPreviewMutation(next);
      content.replaceChildren(next);
    }
  }

  /** Adopt a renderer-owned tree only after the foreground has released it. */
  private adoptDeferredRenderedRoot(generation = this.currentVisualGeneration()): boolean {
    const content = this.previewContent;
    const next = this.deferredRenderedRoot;
    if (
      !content ||
      !next ||
      this.documentSync.hasConflict ||
      !this.isCurrentVisualGeneration(generation) ||
      (this.visualRoot && this.visualOwnsForeground(this.visualRoot))
    ) return false;

    this.deferredRenderedRoot = null;
    this.visualReconciliationPending = false;
    // Detach the old working tree first, then bind the already-rendered tree
    // without focusing it. The observer sees this as one extension-owned
    // reconciliation and cannot turn it into a Wiki.js render acknowledgement.
    if (content.firstElementChild !== next) {
      this.markOwnPreviewMutation(next);
      content.replaceChildren(next);
    }
    this.deactivateVisualDocument();
    this.activateVisualDocument(generation, false);
    return this.visualRoot === next;
  }

  private deactivateVisualDocument(preserveLayout = false, preserveEditable = false): void {
    const root = this.visualRoot;
    if (!root) return;
    root.removeEventListener('contextmenu', this.onVisualContextMenu);
    root.removeEventListener('input', this.onVisualInput);
    root.removeEventListener('beforeinput', this.onVisualBeforeInput, true);
    root.removeEventListener('compositionstart', this.onVisualCompositionStart);
    root.removeEventListener('compositionend', this.onVisualCompositionEnd);
    root.removeEventListener('focusin', this.onVisualFocusIn);
    root.removeEventListener('focusout', this.onVisualFocusOut);
    root.removeEventListener('copy', this.onVisualClipboard);
    root.removeEventListener('cut', this.onVisualClipboard);
    root.removeEventListener('paste', this.onVisualPaste);
    root.removeEventListener('dragover', this.onVisualDragOver);
    root.removeEventListener('drop', this.onVisualDrop);
    if (!preserveEditable) root.contentEditable = 'false';
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
    this.visualPlainTypingNode = null;
    this.visualFocused = false;
    this.documentSync.setActiveEditor(null);
  }

  private mapSourceBlocks(root: HTMLElement): void {
    const rendered = Array.from(root.children) as HTMLElement[];
    const previousIndexes = rendered.map((element) => sourceIndexOf(element));
    // A local Enter can change the number of rendered children, while a
    // renderer replacement can remove every extension marker. Do not choose
    // one positional strategy for both cases: retain valid old markers, use
    // Wiki.js' line markers for fresh trees, and then use the semantic class
    // before falling back to document order.
    for (const element of rendered) element.removeAttribute(SOURCE_INDEX_ATTR);

    const assignments: Array<number | null> = rendered.map(() => null);
    const unused = new Set(this.visualBlocks.map((_, index) => index));
    const claim = (renderedIndex: number, sourceIndex: number): boolean => {
      if (assignments[renderedIndex] !== null || !unused.has(sourceIndex)) return false;
      const block = this.visualBlocks[sourceIndex];
      const element = rendered[renderedIndex];
      if (!block || !element || !visualElementMatchesBlock(element, block)) return false;
      assignments[renderedIndex] = sourceIndex;
      unused.delete(sourceIndex);
      return true;
    };

    // Existing markers are the most reliable identity for a foreground DOM.
    // A type/semantic check prevents an old warning marker from being reused
    // for a newly inserted paragraph at the same ordinal.
    previousIndexes.forEach((sourceIndex, renderedIndex) => {
      if (sourceIndex !== null && sourceIndex >= 0 && sourceIndex < this.visualBlocks.length) {
        claim(renderedIndex, sourceIndex);
      }
    });

    // Fresh Wiki.js trees expose the source line on most direct children.
    rendered.forEach((element, renderedIndex) => {
      if (assignments[renderedIndex] !== null) return;
      const line = Number(element.dataset.line);
      if (!Number.isInteger(line)) return;
      const sourceIndex = this.visualBlocks.findIndex(
        (block, index) => unused.has(index) && block.startLine === line && visualElementMatchesBlock(element, block),
      );
      if (sourceIndex >= 0) claim(renderedIndex, sourceIndex);
    });

    // If a local edit shifted line numbers, Wiki.js' semantic class remains
    // stable (`is-warning`, `is-info`, ...). Match it before ordinal fallback
    // so an untouched alert keeps its source attrs and colour.
    rendered.forEach((element, renderedIndex) => {
      if (assignments[renderedIndex] !== null) return;
      const semantic = semanticTypeFromRenderedElement(element)?.toLowerCase();
      if (!semantic) return;
      const sourceIndex = this.visualBlocks.findIndex(
        (block, index) => unused.has(index) &&
          block.semanticType?.toLowerCase() === semantic &&
          visualElementMatchesBlock(element, block),
      );
      if (sourceIndex >= 0) claim(renderedIndex, sourceIndex);
    });

    // Pair the remaining nodes with the remaining blocks in source order.
    // Prefer a compatible block, but keep the final permissive pass for
    // renderer-specific wrappers that do not expose a predictable tag.
    rendered.forEach((element, renderedIndex) => {
      if (assignments[renderedIndex] !== null) return;
      const prior = assignments
        .slice(0, renderedIndex)
        .filter((index): index is number => index !== null)
        .at(-1) ?? -1;
      const compatible = [...unused].find(
        (sourceIndex) => sourceIndex > prior && visualElementMatchesBlock(element, this.visualBlocks[sourceIndex]),
      );
      const sourceIndex = compatible ?? [...unused].find((index) => visualElementMatchesBlock(element, this.visualBlocks[index]));
      if (sourceIndex !== undefined) claim(renderedIndex, sourceIndex);
    });

    rendered.forEach((element, renderedIndex) => {
      const sourceIndex = assignments[renderedIndex];
      if (sourceIndex !== null) this.markSourceElement(element, this.visualBlocks[sourceIndex], sourceIndex);
    });
  }

  private markSourceElement(element: HTMLElement, block: HybridMarkdownBlock, index: number): void {
    element.setAttribute(SOURCE_INDEX_ATTR, String(index));
    // Remove only a semantic class previously owned by this extension. Other
    // Wiki.js classes (including site-specific variants) must stay untouched.
    const previousSemanticType = semanticTypeFromRenderedElement(element);
    if (previousSemanticType) element.classList.remove(`is-${previousSemanticType}`);
    if (block.semanticType) {
      // The class is Wiki.js' existing semantic hook; the data attribute is
      // the extension's durable ownership metadata. Neither relies on a
      // sampled background colour, so a renderer rebind cannot turn an alert
      // into an anonymous quote.
      element.setAttribute(SEMANTIC_TYPE_ATTR, block.semanticType);
      element.classList.add(`is-${block.semanticType}`);
    } else {
      element.removeAttribute(SEMANTIC_TYPE_ATTR);
    }
    if (!['code-fence', 'raw'].includes(block.type)) {
      const images = element.tagName === 'IMG'
        ? [element as HTMLImageElement]
        : Array.from(element.querySelectorAll<HTMLImageElement>('img'));
      const tokens = findImages(block.rawMarkdown);
      let nextToken = 0;
      for (const image of images) {
        // Preserve one image's source, including dimensions and HTML attrs,
        // never the surrounding paragraph or its semantic attribute lines.
        const index = tokens.findIndex((token, index) => index >= nextToken && token.url === image.getAttribute('src'));
        if (index < 0) continue;
        image.setAttribute(EXACT_SOURCE_ATTR, tokens[index].raw);
        nextToken = index + 1;
      }
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
   * A renderer root can contain one extra wrapper or omit an invisible attrs
   * node, leaving an alert without a source-index marker. Never let that
   * fallback serialize the visible alert as an anonymous quote: recover the
   * suffix from the matching source block, or from Wiki.js' semantic class as
   * a final safe fallback.
   */
  private serializeUnmappedVisualBlock(
    element: HTMLElement,
    usedSourceIndexes: Set<number>,
  ): string | null {
    const markdown = serializeNewVisualBlock(element);
    if (markdown === null) return null;

    const semantic = semanticTypeFromRenderedElement(element);
    if (!semantic) return markdown;
    const semanticLower = semantic.toLowerCase();
    const sourceBlock = this.visualBlocks.find((block, index) =>
      !usedSourceIndexes.has(index) && block.semanticType?.toLowerCase() === semanticLower,
    );
    const attrs = sourceBlock
      ? trailingAttributeLines(sourceBlock.rawMarkdown)
      : [`{.is-${semantic}}`];
    if (attrs.length === 0 || trailingAttributeLines(markdown).length > 0) return markdown;
    return `${markdown.replace(/\n+$/, '')}\n${attrs.join('\n')}`;
  }

  /**
   * Fast path for ordinary typing/deletion. The rendered block already holds
   * the complete latest value, so replace only that block in the native source
   * and shift cached offsets after it. This avoids a full-document diff and
   * parse on every English character.
   */
  private commitVisualBlockEdits(
    current: string,
    children: HTMLElement[],
    generation: VisualRevisionToken,
  ): boolean {
    if (!this.isCurrentVisualGeneration(generation)) {
      this.rescheduleLatestVisualWork();
      return false;
    }
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

    // Coalesce all dirty blocks from this foreground operation into one source
    // transaction. The operation journal retains the input ordering; the
    // projection layer only needs the latest resulting Markdown snapshot.
    const operation = this.latestVisualOperation &&
      this.sameVisualGeneration(this.latestVisualOperation.generation, generation)
      ? this.latestVisualOperation
      : null;
    let source = current;
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
      source = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
    }
    if (source !== current) {
      this.rememberVisualSelection(true);
      const diff = minimalDiff(current, source);
      if (!this.writeSourceValue(
        diff.from,
        diff.to,
        diff.insert,
        current,
        false,
        undefined,
        generation,
        operation,
      )) return false;
      this.visualBlocks = parseHybridBlocks(source);
      for (const edit of edits) edit.element.removeAttribute(DIRTY_BLOCK_ATTR);
    }

    if (!this.isCurrentVisualGeneration(generation)) {
      this.rescheduleLatestVisualWork();
      return false;
    }
    this.visualDirty = false;
    for (const element of children) element.removeAttribute(DIRTY_BLOCK_ATTR);
    if (operation && this.latestVisualOperation?.sequence === operation.sequence) {
      this.latestVisualOperation = null;
    }
    if (this.visualRoot) {
      this.mapSourceBlocks(this.visualRoot);
      this.foregroundMarkupSnapshot = this.visualRoot.innerHTML;
    }
    return true;
  }

  private commitVisualDocument(
    keepVisualEditing = false,
    generation = this.currentVisualGeneration(),
  ): boolean {
    const root = this.visualRoot;
    if (!root) return true;
    if (!this.visualDirty) return true;
    if (!this.isCurrentVisualGeneration(generation)) {
      this.rescheduleLatestVisualWork();
      return false;
    }
    if (this.activeImageUploads > 0) {
      showToast('圖片仍在上傳中，請等待上傳完成後再儲存。', 'info', 4500);
      return false;
    }
    const current = this.documentSync.markdown;

    const children = Array.from(root.children) as HTMLElement[];
    const structureUnchanged =
      children.length === this.visualBlocks.length &&
      children.every((element, index) => sourceIndexOf(element) === index);
    if (keepVisualEditing && structureUnchanged && current === this.visualSource) {
      return this.commitVisualBlockEdits(current, children, generation);
    }

    let next: string;

    if (structureUnchanged) {
      // The DOM is a snapshot of visualSource. If native Markdown advanced in
      // the meantime, applySnapshot() will rebase this candidate instead of
      // splicing visual offsets into the newer source directly.
      next = this.visualSource;
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
      const usedSourceIndexes = new Set<number>();
      for (const element of children) {
        const sourceIndex = sourceIndexOf(element);
        const block = sourceIndex === null ? undefined : this.visualBlocks[sourceIndex];
        const value = block
          ? (element.hasAttribute(DIRTY_BLOCK_ATTR) && canSerializeVisualBlock(block)
              ? serializeVisualBlock(block, element)
              : block.rawMarkdown)
          : this.serializeUnmappedVisualBlock(element, usedSourceIndexes);
        if (value === null) return this.serializationFailed();
        if (sourceIndex !== null && block) usedSourceIndexes.add(sourceIndex);
        if (value.trim() !== '') serialized.push(value);
      }
      next = serialized.join('\n\n');
      if (/\r?\n$/.test(this.visualSource) && next !== '') next += '\n';
    }

    const operation = this.latestVisualOperation &&
      this.sameVisualGeneration(this.latestVisualOperation.generation, generation)
      ? this.latestVisualOperation
      : null;
    if (next !== this.visualSource) {
      const diff = minimalDiff(this.visualSource, next);
      if (!this.writeSourceValue(
        diff.from,
        diff.to,
        diff.insert,
        this.visualSource,
        true,
        undefined,
        generation,
        operation,
      )) return false;
      if (!this.isCurrentVisualGeneration(generation)) {
        this.rescheduleLatestVisualWork();
        return false;
      }
      // Keep the current contenteditable tree alive. Wiki.js may render this
      // source later, but that render is a background acknowledgement rather
      // than a replacement for the foreground working copy.
      this.visualDirty = false;
      for (const element of children) element.removeAttribute(DIRTY_BLOCK_ATTR);
      if (operation && this.latestVisualOperation?.sequence === operation.sequence) {
        this.latestVisualOperation = null;
      }
      this.mapSourceBlocks(root);
    } else {
      if (!this.isCurrentVisualGeneration(generation)) {
        this.rescheduleLatestVisualWork();
        return false;
      }
      this.visualDirty = false;
      for (const element of children) element.removeAttribute(DIRTY_BLOCK_ATTR);
      if (operation && this.latestVisualOperation?.sequence === operation.sequence) {
        this.latestVisualOperation = null;
      }
    }
    this.foregroundMarkupSnapshot = root.innerHTML;
    return true;
  }

  private markVisualDirty(element: Element | null = null): VisualRevisionToken {
    // Capture the post-input DOM caret before any serializer/projection or
    // renderer callback can detach the working root.
    this.rememberVisualSelection();
    // A real contenteditable input normally has the root as activeElement. Do
    // not infer focus from a synthetic/programmatic input event: formatting
    // and tests can dispatch input while another control owns focus, and that
    // must remain eligible for background adoption.
    if (this.visualRoot?.contains(document.activeElement)) this.visualFocused = true;
    const generation = this.visualRevisionGate.beginInput();
    const origin = this.mode === 'hybrid' ? 'future' : 'classic-preview';
    const view = this.mode === 'hybrid' ? 'future' : 'classic-preview';
    const operation = this.documentSync.beginWorkingInput({
      origin,
      view,
      startVisualRevision: generation.startVisualRevision,
      startInputEpoch: generation.startInputEpoch,
      snapshot: this.visualRoot?.innerHTML,
    });
    this.latestVisualOperation = {
      sequence: operation.sequence,
      transactionId: operation.id,
      generation,
    };
    this.ignoreNextVisualInputMutation = true;
    this.visualDirty = true;
    this.foregroundMarkupSnapshot = this.visualRoot?.innerHTML ?? null;
    element?.closest<HTMLElement>(`[${SOURCE_INDEX_ATTR}]`)?.setAttribute(DIRTY_BLOCK_ATTR, 'true');
    return generation;
  }

  private markVisualDirtyFromNode(node: Node | null): VisualRevisionToken {
    const element = node instanceof Element ? node : node?.parentElement ?? null;
    return this.markVisualDirty(element);
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

    // Explicit soft breaks keep one clipboard newline equal to one source
    // newline. Record this controlled DOM edit separately from native typing
    // so undo does not skip the paste and remove earlier text instead.
    if (!this.insertVisualPasteText(text)) return;
    const generation = this.markVisualDirtyFromNode(window.getSelection()?.anchorNode ?? null);
    this.scheduleVisualCommit(generation);
  };

  private insertVisualPasteText(text: string): boolean {
    const root = this.visualRoot;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return false;

    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return false;
    const before = visualMarkup(root);
    let replaced = document.createDocumentFragment();
    let historyNodes: Node[] | null = null;

    const normalizedText = text.replace(/\r\n?/g, '\n');
    const lines = normalizedText.split('\n');
    const fragment = document.createDocumentFragment();
    const insertedNodes: Node[] = [];
    const codeContainer = (range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement)?.closest('pre,code');
    if (codeContainer && root.contains(codeContainer)) {
      // Code fences need a literal newline in textContent; a <br> is a
      // renderer element and would disappear when serializeFence reads code.
      const node = document.createTextNode(normalizedText);
      replaced = range.extractContents();
      range.insertNode(node);
      insertedNodes.push(node);
    } else {
      lines.forEach((line, index) => {
        if (index > 0) {
          const br = document.createElement('br');
          fragment.appendChild(br);
          insertedNodes.push(br);
        }
        if (line !== '') {
          const node = document.createTextNode(line);
          fragment.appendChild(node);
          insertedNodes.push(node);
        }
      });

      replaced = range.extractContents();
      if (range.startContainer === root) {
        // A click in the whitespace between top-level blocks can place the
        // caret directly on the editing root. Root-level text nodes are not
        // part of the block serializer, so give the paste an explicit
        // paragraph before inserting it.
        const paragraph = document.createElement('p');
        paragraph.appendChild(fragment);
        range.insertNode(paragraph);
        historyNodes = [paragraph];
      } else {
        range.insertNode(fragment);
      }
    }
    const lastInserted = insertedNodes.at(-1);
    if (!lastInserted?.parentNode) return false;
    this.visualPasteUndo.push(createVisualPasteEdit(root, before, historyNodes ?? insertedNodes, replaced));
    if (this.visualPasteUndo.length > 50) this.visualPasteUndo.shift();
    this.visualPasteRedo.length = 0;

    const caret = document.createRange();
    caret.setStartAfter(lastInserted);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
    this.visualPlainTypingNode = null;
    root.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertFromPaste',
      data: text,
    }));
    return true;
  }

  /** Keep Wiki.js' document-level clipboard handlers from seeing a visual
   * edit, while leaving the browser's native copy/cut action untouched. */
  private readonly onVisualClipboard = (event: ClipboardEvent): void => {
    event.stopPropagation();
  };

  private visualEventTargetsRoot(event: Event, root: HTMLElement): boolean {
    const target = event.target;
    if (target instanceof Node && root.contains(target)) return true;
    if (event.composedPath().includes(root)) return true;
    const active = document.activeElement;
    return active instanceof Node && root.contains(active);
  }

  /**
   * Keep text typed immediately after a colour-exiting space outside the
   * previous inline wrapper. Chromium can retain the previous editing style
   * even when the caret visually sits in a plain text node; writing directly
   * into that node makes the source/preview result deterministic.
   */
  private insertPlainVisualText(event: Event, text: string): boolean {
    const root = this.visualRoot;
    const node = this.visualPlainTypingNode;
    if (!root || !node || text === '' || !root.contains(node)) return false;
    if (!this.visualEventTargetsRoot(event, root)) return false;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      this.visualPlainTypingNode = null;
      return false;
    }
    const range = selection.getRangeAt(0);
    if (!range.collapsed || !root.contains(range.startContainer)) return false;

    let offset: number | null = null;
    if (range.startContainer === node) {
      offset = Math.max(0, Math.min(range.startOffset, node.data.length));
    } else if (range.startContainer === node.parentNode) {
      const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
      if (range.startOffset === index + 1) offset = node.data.length;
    }
    if (offset === null) return false;

    node.data = `${node.data.slice(0, offset)}${text}${node.data.slice(offset)}`;
    const caret = document.createRange();
    caret.setStart(node, offset + text.length);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
    root.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text,
    }));
    return true;
  }

  private readonly onVisualBeforeInput = (event: InputEvent): void => {
    if (event.defaultPrevented || event.isComposing || this.visualComposing || event.inputType !== 'insertText') return;
    const text = event.data ?? '';
    if (text === ' ') {
      const edit = this.visualSpaceEdit(event);
      if (edit && this.insertVisualSpace(edit)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (this.insertPlainVisualText(event, text)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private readonly onVisualInput = (event: Event): void => {
    // Wiki.js does not own this contenteditable surface. Do not let its
    // document-level input handlers treat every visual keystroke as a native
    // Markdown editor change and start another preview render.
    event.stopPropagation();
    if (!['historyUndo', 'historyRedo'].includes((event as InputEvent).inputType)) this.visualPasteRedo.length = 0;
    const generation = this.markVisualDirtyFromNode(
      window.getSelection()?.anchorNode ?? event.target as Node | null,
    );
    // The browser has already applied the edit to the contenteditable DOM.
    // Record that foreground operation immediately, then let the background
    // serializer/projection catch up. No await or native write is allowed in
    // this input event.
    const isComposing = this.visualComposing || (event as InputEvent).isComposing === true;
    this.scheduleVisualCommit(generation, isComposing ? VISUAL_SYNC_DELAY_MS : VISUAL_BACKGROUND_COMMIT_DELAY_MS);

    // Keep the native action clickable while Wiki.js processes the new source
    // value. Its own dirty-state update can otherwise briefly disable Save.
    const saveButton = this.nativeSaveButton();
    if (!saveButton) return;
    if (
      saveButton.disabled ||
      saveButton.hasAttribute('aria-disabled') ||
      saveButton.classList.contains('v-btn--disabled')
    ) {
      saveButton.disabled = false;
      saveButton.removeAttribute('aria-disabled');
      saveButton.classList.remove('v-btn--disabled');
    }
  };

  /** The native Save button, resolved once and re-queried only after Wiki.js
   * replaces the editor header (per-keystroke document queries are not free). */
  private nativeSaveButton(): HTMLButtonElement | null {
    if (!this.cachedSaveButton?.isConnected) {
      const icon = document.querySelector<HTMLElement>(wikiConfig.editor.saveButtonIconSelector);
      this.cachedSaveButton = icon?.closest<HTMLButtonElement>('button') ?? null;
    }
    return this.cachedSaveButton;
  }

  private readonly onVisualFocusIn = (): void => {
    this.visualFocused = true;
  };

  /**
   * Renderer replacement can generate a focusout without any user blur. Keep
   * visualFocused until a real focus/mouse interaction lands outside the
   * working surface; otherwise a late render can release the root and the next
   * activation will focus its first block.
   */
  private readonly onDocumentFocusIn = (event: FocusEvent): void => {
    const root = this.visualRoot;
    if (!root || !this.visualRootIsMounted(root)) return;
    const target = event.target;
    if (target instanceof Node && (root.contains(target) || this.visualToolbar?.contains(target))) {
      this.visualFocused = true;
      return;
    }
    this.releaseVisualForeground();
  };

  private readonly onVisualCompositionStart = (): void => {
    this.visualComposing = true;
  };

  private readonly onVisualCompositionEnd = (): void => {
    this.visualComposing = false;
    // The final input event may be delivered before or after compositionend;
    // schedule one commit after the completed IME value is in the DOM.
    this.scheduleVisualCommit(this.currentVisualGeneration());
  };

  private readonly onVisualFocusOut = (event: FocusEvent): void => {
    const root = this.visualRoot;
    if (this.visualRootIsMounted(root)) {
      const next = event.relatedTarget;
      this.visualFocused = next instanceof Node ? root!.contains(next) || Boolean(this.visualToolbar?.contains(next)) : false;
    }
    // A renderer can detach the focused root before the focusout event is
    // delivered. Keep the pre-detach ownership in that case regardless of the
    // browser-provided relatedTarget; restore the same working DOM before a
    // later, real blur can release it.
    if (!root || !this.visualRootIsMounted(root)) return;
    if (this.visualFocused) return;
    if (this.hasPendingVisualLifecycle()) return;
    this.releaseVisualForeground();
  };

  private hasPendingVisualLifecycle(): boolean {
    return this.awaitingPreviewRender ||
      this.pendingVisualRenders.length > 0 ||
      this.visualReconciliationPending ||
      this.documentSync.hasPendingProjection;
  }

  private releaseVisualForeground(): void {
    this.visualFocused = false;
    const generation = this.currentVisualGeneration();
    window.setTimeout(() => {
      const root = this.visualRoot;
      if (!root || this.contextMenu || root.contains(document.activeElement) || this.visualToolbar?.contains(document.activeElement)) return;
      if (!this.isCurrentVisualGeneration(generation)) {
        this.rescheduleLatestVisualWork();
        return;
      }
      if (!this.flushVisualCommit(false, generation)) return;
      if (this.deferredRenderedRoot && !this.visualOwnsForeground(root)) {
        this.scheduleVisualRefresh(generation, true);
      }
    }, 0);
  }

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
    const replacedContent = range?.extractContents() ?? document.createDocumentFragment();
    if (range) {
      range.insertNode(marker);
    } else {
      root.appendChild(marker);
    }
    const uploadGeneration = this.markVisualDirty(marker);
    const restoreSelection = (): void => {
      if (!root.contains(marker)) return;
      const parent = marker.parentElement;
      marker.replaceWith(replacedContent);
      this.markVisualDirty(parent);
    };

    this.activeImageUploads++;
    try {
      const lines = await this.imageDrop.uploadFiles(files);
      // Typing advances the revision, but the marker remains the insertion
      // anchor. Only discard a result if its editor/anchor was removed.
      if (this.visualRoot !== root || !root.isConnected || !root.contains(marker)) return;
      const restoreCaret = this.isCurrentVisualGeneration(uploadGeneration);
      if (lines.length === 0) {
        restoreSelection();
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
      if (restoreCaret && lastInserted?.parentNode) {
        const caret = document.createRange();
        caret.setStartAfter(lastInserted);
        caret.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(caret);
      }
    } catch (error) {
      if (this.visualRoot === root) restoreSelection();
      showToast(`圖片上傳失敗：${error instanceof Error ? error.message : String(error)}`, 'error', 5500);
    } finally {
      this.activeImageUploads--;
      if (this.activeImageUploads === 0 && this.visualDirty) {
        this.scheduleVisualCommit(this.currentVisualGeneration());
      }
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
      image.removeAttribute('width');
      image.removeAttribute('height');
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
    this.editContextImage((image) => {
      image.removeAttribute('style');
      image.removeAttribute('width');
      image.removeAttribute('height');
    });
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
    const generation = this.currentVisualGeneration();

    const selectedText = range.toString();
    // If the user formats immediately after typing, commit the current DOM
    // snapshot while keeping the same contenteditable tree alive. This updates
    // visualSource/offsets before syntax mapping without losing the Range.
    if (this.visualDirty && this.canKeepVisualEditing(range) && !this.flushVisualCommit(true, generation)) return;
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
    if (this.visualDirty && !this.flushVisualCommit(false, generation)) return;

    if (!this.isCurrentVisualGeneration(generation)) {
      this.rescheduleLatestVisualWork();
      return;
    }

    const current = this.documentSync.markdown;
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
    // This operation changes Markdown without changing the foreground DOM.
    // Let the renderer's result become the new visual surface; otherwise the
    // same-root reconciliation fallback would restore the pre-format markup
    // and make the new color appear to have no effect.
    this.foregroundMarkupSnapshot = null;
    if (!this.writeSourceValue(diff.from, diff.to, diff.insert, current, true, undefined, generation)) return;
    if (!this.isCurrentVisualGeneration(generation)) {
      this.rescheduleLatestVisualWork();
      return;
    }
    // Formatting is an explicit source operation, so it may reconcile the
    // rendered view after Wiki.js acknowledges it. It still must not disable
    // the active editor while that render is in flight.
    this.waitForPreviewRender(generation, true);
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
    const root = this.visualRoot;
    const target = event.target;
    if (root && (!(target instanceof Node) || (!root.contains(target) && !this.visualToolbar?.contains(target)))) {
      this.releaseVisualForeground();
    }
    if (!this.contextMenu) return;
    if (!event.composedPath().includes(this.contextMenu)) this.closeContextMenu();
  };

  private saveThroughWiki(): void {
    if (this.mode === 'raw') this.commitRaw();
    else this.rescheduleLatestVisualWork();

    const target = this.documentSync.captureSaveTarget();
    void this.documentSync.prepareWikiSave(target).then((prepared) => {
      if (!prepared) {
        showToast('Markdown 同步尚未收斂，未執行 Wiki.js Save；目前內容仍保留。', 'error', 7000);
        return;
      }
      const save = this.nativeSaveButton();
      if (!save) {
        showToast('找不到 Wiki.js 原生 Save 按鈕，內容仍保留在原生 Markdown Editor。', 'error', 6000);
        return;
      }
      this.bypassNativeSaveCapture = true;
      save.click();
      // Wiki.js handles the actual persistence. This only records the revision
      // that was handed to that flow; later edits keep the model dirty.
      this.documentSync.markWikiSaved(prepared.revision, prepared.sequence);
    });
  }

  private readonly onNativeSaveCapture = (event: MouseEvent): void => {
    if (this.mode === 'raw') return;
    const saveButton = this.nativeSaveButton();
    if (!saveButton || !event.composedPath().includes(saveButton)) return;
    if (this.bypassNativeSaveCapture) {
      this.bypassNativeSaveCapture = false;
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.saveThroughWiki();
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
    // findNativeCloseButton scans every button on the page; don't pay that on
    // the vast majority of clicks that hit no button at all.
    const clickedButton = event
      .composedPath()
      .find((node): node is HTMLButtonElement => node instanceof HTMLButtonElement);
    if (!clickedButton) return;
    const closeButton = this.findNativeCloseButton();
    if (!closeButton || closeButton !== clickedButton) return;

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

  /**
   * Wiki.js is configured to render a Markdown newline as a visual line break.
   * Letting contenteditable handle Enter as a paragraph split makes the visual
   * serializer emit `\n\n`, so one key press becomes a blank source line. Keep
   * native paragraph/list behavior where it carries Markdown structure, and
   * use a real `<br>` for ordinary visual text instead.
   */
  private visualSpaceEdit(event: Event): VisualSpaceEdit | null {
    const root = this.visualRoot;
    if (!root) return null;
    const target = event.target;
    const active = document.activeElement;
    const targetInRoot = target instanceof Node && root.contains(target);
    const activeInRoot = active instanceof Node && root.contains(active);
    if (!targetInRoot && !activeInRoot && !event.composedPath().includes(root)) return null;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) return null;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!range.collapsed || !root.contains(range.startContainer)) return null;

    const startElement = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
    if (!startElement || startElement.closest('[contenteditable="false"]')) return null;
    if (startElement.closest('pre,code')) return null;

    const colorElement = visualColorElementAt(range.startContainer, root);
    if (colorElement) {
      const offset = visualPointOffsetWithin(range.startContainer, range.startOffset, colorElement);
      if (offset === null) return null;
      const length = visualNodeLength(colorElement);
      const boundary: VisualSpaceBoundary = offset <= 0
        ? 'start'
        : offset >= length
          ? 'end'
          : 'middle';
      return { range: range.cloneRange(), colorElement, boundary };
    }

    // Chromium may represent a caret immediately after an inline element as
    // a boundary in its parent instead of the last text node inside `<font>`.
    // Detect that form too, otherwise the first space looks plain but the next
    // typed character can still inherit the color from the left sibling.
    const leftColor = visualColorAtEdge(
      visualAdjacentNodeAtPoint(range.startContainer, range.startOffset, -1),
      -1,
      root,
    );
    const rightColor = visualColorAtEdge(
      visualAdjacentNodeAtPoint(range.startContainer, range.startOffset, 1),
      1,
      root,
    );
    if (leftColor) return { range: range.cloneRange(), colorElement: leftColor, boundary: 'end' };
    if (rightColor) return { range: range.cloneRange(), colorElement: rightColor, boundary: 'start' };
    return null;
  }

  /** Insert a plain space at a color boundary, or a colored space in its body. */
  private insertVisualSpace(edit: VisualSpaceEdit): boolean {
    const root = this.visualRoot;
    if (!root || !root.contains(edit.range.commonAncestorContainer)) return false;

    try {
      const insertion = document.createRange();
      if (edit.boundary === 'middle') {
        insertion.setStart(edit.range.startContainer, edit.range.startOffset);
        insertion.collapse(true);
      } else {
        insertion.selectNode(edit.colorElement);
        insertion.collapse(edit.boundary === 'start');
      }
      insertion.deleteContents();
      const space = document.createTextNode(' ');
      insertion.insertNode(space);

      const caret = document.createRange();
      // Keep the caret inside the unformatted text node. A caret collapsed at
      // the parent boundary immediately after `<font>` can make Chromium
      // inherit the previous element's typing style for the next character,
      // even though the space itself is visibly unformatted.
      caret.setStart(space, space.length);
      caret.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
      this.visualPlainTypingNode = edit.boundary === 'middle' ? null : space;
      root.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: ' ',
      }));
      return true;
    } catch {
      return false;
    }
  }

  private visualLineBreakColorBoundary(
    range: Range,
  ): { colorElement: HTMLElement; boundary: 'start' | 'end' } | null {
    const root = this.visualRoot;
    if (!root || !range.collapsed) return null;

    const colorElement = visualColorElementAt(range.startContainer, root);
    if (colorElement) {
      const offset = visualPointOffsetWithin(range.startContainer, range.startOffset, colorElement);
      if (offset === null) return null;
      const length = visualNodeLength(colorElement);
      if (offset <= 0) return { colorElement, boundary: 'start' };
      if (offset >= length) return { colorElement, boundary: 'end' };
      return null;
    }

    const leftColor = visualColorAtEdge(
      visualAdjacentNodeAtPoint(range.startContainer, range.startOffset, -1),
      -1,
      root,
    );
    if (leftColor) return { colorElement: leftColor, boundary: 'end' };
    const rightColor = visualColorAtEdge(
      visualAdjacentNodeAtPoint(range.startContainer, range.startOffset, 1),
      1,
      root,
    );
    if (rightColor) return { colorElement: rightColor, boundary: 'start' };
    return null;
  }

  /** Insert a line break outside a colour wrapper and keep the next input plain. */
  private insertVisualLineBreakOutsideColor(
    colorElement: HTMLElement,
    boundary: 'start' | 'end',
  ): boolean {
    const root = this.visualRoot;
    if (!root || !root.contains(colorElement)) return false;

    try {
      const insertion = document.createRange();
      insertion.selectNode(colorElement);
      insertion.collapse(boundary === 'start');
      const br = document.createElement('br');
      insertion.insertNode(br);
      const plain = document.createTextNode('');
      const parent = br.parentNode;
      if (!parent) return false;
      parent.insertBefore(plain, br.nextSibling);
      const caret = document.createRange();
      caret.setStart(plain, 0);
      caret.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
      this.visualPlainTypingNode = plain;
      root.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertLineBreak',
      }));
      return true;
    } catch {
      return false;
    }
  }

  private visualLineBreakRange(event: KeyboardEvent): Range | null {
    const root = this.visualRoot;
    if (!root) return null;
    const target = event.target;
    const active = document.activeElement;
    const targetInRoot = target instanceof Node && root.contains(target);
    const activeInRoot = active instanceof Node && root.contains(active);
    if (!targetInRoot && !activeInRoot) return null;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) return null;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

    const startElement = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
    if (!startElement || startElement.closest('[contenteditable="false"]')) return null;

    // Enter in lists and headings changes Markdown structure and should keep
    // the browser's native behavior (new list item / following paragraph).
    if (startElement.closest('h1,h2,h3,h4,h5,h6,li,pre,code')) return null;
    return range.cloneRange();
  }

  private insertVisualLineBreak(range: Range): boolean {
    const root = this.visualRoot;
    if (!root || !root.contains(range.commonAncestorContainer)) return false;
    const before = root.innerHTML;
    const boundary = this.visualLineBreakColorBoundary(range);
    if (boundary) return this.insertVisualLineBreakOutsideColor(boundary.colorElement, boundary.boundary);

    try {
      // Use one explicit <br> instead of the browser's paragraph-splitting
      // command. Wiki.js renders a Markdown newline as <br>; execCommand can
      // create a second block wrapper and turn one Enter into two source lines.
      range.deleteContents();
      const br = document.createElement('br');
      range.insertNode(br);
      const caret = document.createRange();
      caret.setStartAfter(br);
      caret.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
    } catch {
      return false;
    }
    this.visualPlainTypingNode = null;
    root.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }));
    const changed = root.innerHTML !== before;
    if (changed && !this.visualDirty) {
      const generation = this.markVisualDirtyFromNode(window.getSelection()?.anchorNode ?? root);
      this.scheduleVisualCommit(generation);
    }
    return changed;
  }

  /** Open extension surfaces own their keys before the background editor. */
  private extensionOverlayOwnsKey(event: KeyboardEvent, includeUnfocusedPanels = true): boolean {
    if (event.defaultPrevented) return true;
    const overlaySelector = '.fwa-panel, [role="dialog"], [aria-modal="true"]';
    const path = event.composedPath();
    // The dispatch path survives DOM removal. A capture listener registered
    // earlier may already have closed its panel before this listener runs.
    if (
      path.some((node) => node instanceof ShadowRoot && node.host.id.startsWith('fwa-')) &&
      path.some((node) => node instanceof HTMLElement && node.matches(overlaySelector))
    ) return true;
    // A panel can receive Escape through a later document listener even when
    // the key originated outside it. Closed surfaces remove their contents;
    // their reusable shadow hosts and toast hosts must not block the editor.
    const globalSelector = includeUnfocusedPanels ? overlaySelector : '[role="dialog"], [aria-modal="true"]';
    return Array.from(document.querySelectorAll<HTMLElement>('[id^="fwa-"]')).some((host) => {
      if (!host.shadowRoot || host.closest('[hidden], [aria-hidden="true"]')) return false;
      return Array.from(host.shadowRoot.querySelectorAll<HTMLElement>(globalSelector)).some((overlay) =>
        !overlay.closest('[hidden], [aria-hidden="true"]'),
      );
    });
  }

  private readonly onWindowKeyDownCapture = (event: KeyboardEvent): void => {
    // Window capture runs before every document handler, regardless of their
    // registration order. Remember the overlay before its handler removes it.
    if (event.key === 'Escape' && this.extensionOverlayOwnsKey(event)) {
      this.overlayEscapeEvents.add(event);
    }
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && (this.overlayEscapeEvents.has(event) || this.extensionOverlayOwnsKey(event))) return;
    if ((event.ctrlKey || event.metaKey || (event.altKey && event.key === 'F10')) && this.extensionOverlayOwnsKey(event, false)) return;
    if (this.mode === 'hybrid' && event.altKey && event.key === 'F10') {
      event.preventDefault();
      event.stopPropagation();
      this.onToolbarSelectionChange();
      (this.visualToolbar?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? this.visualToolbar)?.focus();
      return;
    }
    if (event.key === 'Escape' && this.contextMenu) {
      event.preventDefault();
      this.closeContextMenu();
      this.visualRoot?.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'Escape' && this.visualToolbar?.contains(document.activeElement)) {
      event.preventDefault();
      event.stopPropagation();
      if (!this.restoreToolbarSelection()) this.visualRoot?.focus({ preventScroll: true });
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
      if (modifier && !event.altKey && !event.isComposing && ['b', 'i', 'u'].includes(key)) {
        this.onToolbarSelectionChange();
        if (this.toolbarRange && !this.toolbarRange.collapsed) {
          event.preventDefault();
          event.stopPropagation();
          const edit: SourceEdit = key === 'b' ? toggleBold : key === 'i' ? toggleItalic :
            (text, start, end) => toggleUnderline(text, start, end, wikiConfig.formatting.underlineTag);
          this.runToolbarEdit(edit);
          return;
        }
      }
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
    const isSpaceKey = event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space';
    if (
      isSpaceKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.isComposing &&
      !event.defaultPrevented
    ) {
      const edit = this.visualSpaceEdit(event);
      if (edit && this.insertVisualSpace(edit)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    // Fallback for browsers/editors that do not emit beforeinput for a normal
    // printable key. Once a boundary space created a plain node, keep the
    // following characters in that node so the previous colour cannot leak
    // back into the next word.
    if (
      event.key !== ' ' &&
      event.key !== 'Spacebar' &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.isComposing &&
      !event.defaultPrevented &&
      this.insertPlainVisualText(event, event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.isComposing &&
      !event.defaultPrevented
    ) {
      const range = this.visualLineBreakRange(event);
      if (range) {
        event.preventDefault();
        event.stopPropagation();
        this.insertVisualLineBreak(range);
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
    const target = event.composedPath()[0] ?? event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      return root.contains(target);
    }
    if (target instanceof Node && root.contains(target)) return true;
    if (document.activeElement && root.contains(document.activeElement)) return true;
    const selection = window.getSelection();
    return Boolean(selection && selection.rangeCount > 0 && root.contains(selection.getRangeAt(0).commonAncestorContainer));
  }

  private applyVisualHistory(direction: 'undo' | 'redo'): void {
    const stack = direction === 'undo' ? this.visualPasteUndo : this.visualPasteRedo;
    const edit = stack.at(-1);
    if (edit && this.visualRoot === edit.root &&
      visualMarkup(edit.root) === (direction === 'undo' ? edit.after : edit.before) && edit.swap()) {
      stack.pop();
      (direction === 'undo' ? this.visualPasteRedo : this.visualPasteUndo).push(edit);
      // A replacement can span more than one mapped block.
      edit.root.querySelectorAll<HTMLElement>(`[${SOURCE_INDEX_ATTR}]`)
        .forEach(element => element.setAttribute(DIRTY_BLOCK_ATTR, 'true'));
      this.visualPlainTypingNode = null;
      edit.root.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: direction === 'undo' ? 'historyUndo' : 'historyRedo',
      }));
      return;
    }
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
    const before = this.documentSync.markdown;
    try {
      const changed = direction === 'undo' ? this.documentSync.undoNative() : this.documentSync.redoNative();
      const after = this.documentSync.markdown;
      if (!changed && after === before) return;
    } catch (error) {
      showToast(`無法${direction === 'undo' ? '復原' : '重做'}目前編輯：${error instanceof Error ? error.message : String(error)}`, 'error', 6000);
      return;
    }

    const generation = this.currentVisualGeneration();
    this.waitForPreviewRender(generation, true);
  }

}

import { wikiConfig } from '../config/wiki-config';
import type { EditorKind, SelectionInfo } from '../shared/types';
import { bridgeCall, ensureBridge } from './bridge';

/**
 * Unified editor abstraction. Every other feature (formatting menu, image
 * drop, template panel) goes through this interface and must never touch
 * editor-specific DOM directly.
 */
export interface EditorAdapter {
  readonly kind: EditorKind;
  /** Element to attach contextmenu / drop / paste listeners to. */
  readonly rootElement: HTMLElement;
  getValue(): string;
  setValue(value: string): void;
  getSelection(): SelectionInfo;
  /** Extension to the spec interface: required to restore the caret after edits. */
  setSelection(start: number, end: number): void;
  /** Replace a source range without focusing or moving the native editor caret. */
  replaceRange(start: number, end: number, value: string): void;
  replaceSelection(value: string): void;
  insertAtCursor(value: string): void;
  /** Undo/redo the editor's own history without requiring its UI to be focused. */
  undo(): boolean;
  redo(): boolean;
  focus(): void;
  notifyChange(): void;
  /** Subscribe to changes made through the native editor UI. */
  subscribe(listener: () => void): () => void;
}

/* ────────────────────────────── textarea ────────────────────────────── */

export class TextareaAdapter implements EditorAdapter {
  readonly kind: EditorKind = 'textarea';
  constructor(private readonly el: HTMLTextAreaElement) {}

  get rootElement(): HTMLElement {
    return this.el;
  }

  getValue(): string {
    return this.el.value;
  }

  setValue(value: string): void {
    // Use the native prototype setter so frameworks (React/Vue) that patch
    // the value property still see the change through the input event.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(this.el, value);
    else this.el.value = value;
    this.notifyChange();
  }

  getSelection(): SelectionInfo {
    const { selectionStart, selectionEnd, value } = this.el;
    return { start: selectionStart, end: selectionEnd, text: value.slice(selectionStart, selectionEnd) };
  }

  setSelection(start: number, end: number): void {
    this.el.setSelectionRange(start, end);
  }

  replaceRange(start: number, end: number, value: string): void {
    // Visual edits are written to the native Markdown editor in the
    // background. Preserve its selection so CodeMirror does not scroll to the
    // changed source line while the user is typing in the rendered document.
    this.el.setRangeText(value, start, end, 'preserve');
    this.notifyChange();
  }

  replaceSelection(value: string): void {
    this.el.setRangeText(value, this.el.selectionStart, this.el.selectionEnd, 'end');
    this.notifyChange();
  }

  insertAtCursor(value: string): void {
    this.replaceSelection(value);
  }

  undo(): boolean {
    this.el.focus();
    return document.execCommand('undo');
  }

  redo(): boolean {
    this.el.focus();
    return document.execCommand('redo');
  }

  focus(): void {
    this.el.focus();
  }

  notifyChange(): void {
    this.el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    this.el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  subscribe(listener: () => void): () => void {
    this.el.addEventListener('input', listener);
    this.el.addEventListener('change', listener);
    return () => {
      this.el.removeEventListener('input', listener);
      this.el.removeEventListener('change', listener);
    };
  }
}

/* ─────────────── page-bridge adapter (CodeMirror/Monaco/Ace) ─────────────── */

const TARGET_ATTR = 'data-fwa-editor-target';

export class BridgeAdapter implements EditorAdapter {
  constructor(
    readonly kind: EditorKind,
    private readonly el: HTMLElement,
  ) {
    for (const target of Array.from(document.querySelectorAll<HTMLElement>(`[${TARGET_ATTR}]`))) {
      if (target !== el) target.removeAttribute(TARGET_ATTR);
    }
    el.setAttribute(TARGET_ATTR, '1');
  }

  get rootElement(): HTMLElement {
    return this.el;
  }

  getValue(): string {
    return bridgeCall<string>('getValue', { kind: this.kind });
  }

  setValue(value: string): void {
    bridgeCall('setValue', { kind: this.kind, value });
  }

  getSelection(): SelectionInfo {
    return bridgeCall<SelectionInfo>('getSelection', { kind: this.kind });
  }

  setSelection(start: number, end: number): void {
    bridgeCall('setSelection', { kind: this.kind, start, end });
  }

  replaceRange(start: number, end: number, value: string): void {
    bridgeCall('replaceRange', { kind: this.kind, start, end, value });
  }

  replaceSelection(value: string): void {
    bridgeCall('replaceSelection', { kind: this.kind, value });
  }

  insertAtCursor(value: string): void {
    bridgeCall('insertAtCursor', { kind: this.kind, value });
  }

  undo(): boolean {
    return this.historyCommand('undo');
  }

  redo(): boolean {
    return this.historyCommand('redo');
  }

  private historyCommand(command: 'undo' | 'redo'): boolean {
    const before = this.getValue();
    bridgeCall(command, { kind: this.kind });
    return this.getValue() !== before;
  }

  focus(): void {
    bridgeCall('focus', { kind: this.kind });
  }

  notifyChange(): void {
    // CodeMirror/Monaco/Ace fire their own change events when edited through
    // their APIs — nothing extra to dispatch here.
  }

  subscribe(listener: () => void): () => void {
    const onChange = () => listener();
    this.el.addEventListener('fwa:editor-change', onChange);
    // These native events are a useful fallback for editor versions that do
    // not expose a page-world change hook (and cover CodeMirror 6 input).
    this.el.addEventListener('input', onChange);
    this.el.addEventListener('change', onChange);
    try {
      bridgeCall('watchChanges', { kind: this.kind });
    } catch {
      // The DOM listeners above still provide a best-effort fallback.
    }
    return () => {
      this.el.removeEventListener('fwa:editor-change', onChange);
      this.el.removeEventListener('input', onChange);
      this.el.removeEventListener('change', onChange);
    };
  }
}

/* ────────────────────────────── detection ────────────────────────────── */

export interface DetectedEditor {
  kind: EditorKind;
  element: HTMLElement;
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 100 && rect.height > 60;
}

/**
 * Find the Markdown editor on the current page.
 * Order: configured selectors from wiki-config (filled in by Phase-1
 * discovery) first, then generic detection of well-known editors.
 */
export function detectEditor(root: ParentNode = document): DetectedEditor | null {
  for (const cand of wikiConfig.editor.candidateSelectors) {
    const el = root.querySelector<HTMLElement>(cand.selector);
    if (el) return { kind: cand.kind, element: el };
  }

  if (!wikiConfig.editor.genericDetection) return null;

  const cm6 = root.querySelector<HTMLElement>('.cm-content');
  if (cm6 && isVisible(cm6)) return { kind: 'codemirror6', element: cm6 };

  const cm5 = root.querySelector<HTMLElement>('.CodeMirror');
  if (cm5 && isVisible(cm5)) return { kind: 'codemirror5', element: cm5 };

  const monaco = root.querySelector<HTMLElement>('.monaco-editor');
  if (monaco && isVisible(monaco)) return { kind: 'monaco', element: monaco };

  const ace = root.querySelector<HTMLElement>('.ace_editor');
  if (ace && isVisible(ace)) return { kind: 'ace', element: ace };

  const textareas = Array.from(root.querySelectorAll<HTMLTextAreaElement>('textarea'));
  const ta = textareas.find(isVisible);
  if (ta) return { kind: 'textarea', element: ta };

  return null;
}

export async function createAdapter(detected: DetectedEditor): Promise<EditorAdapter> {
  if (detected.kind === 'textarea') {
    return new TextareaAdapter(detected.element as HTMLTextAreaElement);
  }
  await ensureBridge();
  const adapter = new BridgeAdapter(detected.kind, detected.element);
  // Probe once so a broken bridge fails fast and callers can fall back.
  adapter.getValue();
  return adapter;
}

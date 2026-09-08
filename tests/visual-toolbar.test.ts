/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorAdapter, EditorChangeListener } from '../src/content/editor-adapter';
import { HybridPreviewFeature } from '../src/content/hybrid-preview';
import { WikiDocumentSync } from '../src/content/document-sync';
import type { EditorMutationContext } from '../src/content/wiki-document-model';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { createShadowHost, openModal } from '../src/content/ui';

vi.mock('../src/shared/storage', () => ({
  getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
  saveSettings: vi.fn(async () => undefined),
}));

class MemoryAdapter implements EditorAdapter {
  readonly kind = 'textarea' as const;
  readonly rootElement = document.createElement('textarea');
  private listeners = new Set<EditorChangeListener>();
  private selection = { start: 0, end: 0 };
  constructor(private value: string) {}
  getValue(): string { return this.value; }
  setValue(value: string, context?: EditorMutationContext): void {
    this.value = value;
    this.notifyChange(context);
  }
  getSelection() { return { ...this.selection, text: this.value.slice(this.selection.start, this.selection.end) }; }
  setSelection(start: number, end: number): void { this.selection = { start, end }; }
  replaceRange(start: number, end: number, value: string, context?: EditorMutationContext): void {
    this.setValue(this.value.slice(0, start) + value + this.value.slice(end), context);
  }
  replaceSelection(value: string, context?: EditorMutationContext): void {
    this.replaceRange(this.selection.start, this.selection.end, value, context);
  }
  insertAtCursor(value: string, context?: EditorMutationContext): void { this.replaceSelection(value, context); }
  undo(): boolean { return false; }
  redo(): boolean { return false; }
  focus(): void {}
  notifyChange(context?: EditorMutationContext): void {
    this.listeners.forEach((listener) => listener({ origin: context?.origin ?? 'native', transactionId: context?.transactionId, value: this.value }));
  }
  subscribe(listener: EditorChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

describe('visual formatting toolbar', () => {
  let feature: HybridPreviewFeature;
  let sync: WikiDocumentSync;
  let root: HTMLElement;
  let toolbar: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<header><button><i class="mdi-check"></i>Save</button></header>' +
      '<div class="editor-markdown-preview"><div class="editor-markdown-preview-content"><article><p>hello world</p><p>untouched</p></article></div></div>';
    document.head.querySelector('#fwa-hybrid-preview-style')?.remove();
    root = document.querySelector('article')!;
    const adapter = new MemoryAdapter('hello world\n\nuntouched');
    sync = new WikiDocumentSync(adapter);
    feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode: 'hybrid' }, null, sync,
    );
    feature.attach();
    toolbar = document.querySelector('.fwa-visual-toolbar')!;
  });

  afterEach(() => {
    feature.detach();
    sync.dispose();
    window.getSelection()?.removeAllRanges();
    document.getElementById('fwa-hybrid-visual-menu-host')?.remove();
    document.querySelectorAll('[id^="fwa-toolbar-test-"]').forEach((host) => host.remove());
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('tracks wrapped native save controls on resize without replacing the visual draft', () => {
    const header = document.querySelector('header')!;
    const preview = document.querySelector<HTMLElement>('.editor-markdown-preview')!;
    const bounds = vi.spyOn(header, 'getBoundingClientRect');
    bounds.mockReturnValue({ bottom: 104 } as DOMRect);
    window.dispatchEvent(new Event('resize'));
    expect(preview.style.getPropertyValue('--fwa-future-top')).toBe('104px');
    bounds.mockReturnValue({ bottom: 64 } as DOMRect);
    window.dispatchEvent(new Event('resize'));
    expect(preview.style.getPropertyValue('--fwa-future-top')).toBe('64px');
    expect(document.querySelector('article')).toBe(root);
    expect(root.textContent).toBe('hello worlduntouched');
    feature.detach();
    bounds.mockClear();
    window.dispatchEvent(new Event('resize'));
    expect(bounds).not.toHaveBeenCalled();
  });

  function selectHello(): void {
    root.focus();
    const range = document.createRange();
    range.setStart(root.firstElementChild!.firstChild!, 0);
    range.setEnd(root.firstElementChild!.firstChild!, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }

  it('keeps toolbar chrome outside the serializable article and exposes the active mode', async () => {
    expect(root.contains(toolbar)).toBe(false);
    expect(toolbar.hidden).toBe(false);
    expect(document.querySelector('[data-mode="hybrid"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-mode="hybrid"]')?.textContent).toBe('視覺編輯');
    expect(document.querySelector('[data-mode="classic"]')?.textContent).toBe('原始碼');
    expect(toolbar.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    const paragraph = root.firstElementChild!;
    paragraph.textContent = 'hello world!';
    paragraph.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    await vi.advanceTimersByTimeAsync(700);
    expect(sync.markdown).toBe('hello world!\n\nuntouched');
  });

  it('formats only selected text after entering the toolbar with the keyboard', async () => {
    selectHello();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', altKey: true, bubbles: true, cancelable: true }));
    const bold = toolbar.querySelector<HTMLButtonElement>('.fwa-tool-bold')!;
    expect(document.activeElement).toBe(bold);
    bold.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(toolbar.querySelector('.fwa-tool-italic'));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(bold);
    // Browser focus or assistive technology may clear the live selection.
    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    bold.click();
    await sync.projectionQueue.whenIdle();
    expect(sync.markdown).toBe('**hello** world\n\nuntouched');
  });

  it('supports direct formatting shortcuts without changing unrelated paragraphs', async () => {
    selectHello();
    const shortcut = new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, bubbles: true, cancelable: true });
    root.dispatchEvent(shortcut);
    await sync.projectionQueue.whenIdle();
    expect(shortcut.defaultPrevented).toBe(true);
    expect(sync.markdown).toBe('*hello* world\n\nuntouched');
  });

  it('opens the complete format controls for a captured selection', async () => {
    selectHello();
    toolbar.querySelector<HTMLButtonElement>('.fwa-visual-tool-more')!.click();
    const menu = document.getElementById('fwa-hybrid-visual-menu-host')?.shadowRoot;
    const red = menu?.querySelector<HTMLButtonElement>('.fwa-swatch[title="red"]');
    expect(red).toBeTruthy();
    red!.click();
    await sync.projectionQueue.whenIdle();
    expect(sync.markdown).toBe('<font color="red">hello</font> world\n\nuntouched');
  });

  it('returns from the toolbar to the same selection without leaving visual mode', () => {
    selectHello();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', altKey: true, bubbles: true }));
    const active = document.activeElement!;
    active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(root);
    expect(window.getSelection()!.toString()).toBe('hello');
    expect(document.querySelector('.fwa-hybrid-fullscreen')).toBeTruthy();
  });

  it.each(['before', 'after'] as const)('lets a drawer own Escape when its listener runs %s the editor listener', (order) => {
    feature.detach();
    const { root: shadow } = createShadowHost('fwa-toolbar-test-drawer');
    const drawer = document.createElement('aside');
    drawer.className = 'fwa-panel';
    shadow.appendChild(drawer);
    const closeDrawer = (event: KeyboardEvent) => {
      if (event.key === 'Escape') drawer.remove();
    };
    if (order === 'before') document.addEventListener('keydown', closeDrawer, true);
    feature.attach();
    if (order === 'after') document.addEventListener('keydown', closeDrawer, true);
    try {
      drawer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true }));
      expect(shadow.querySelector('.fwa-panel')).toBeNull();
      expect(document.querySelector('.fwa-hybrid-fullscreen')).toBeTruthy();
      // The empty reusable host must not swallow the next editor Escape.
      root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(document.querySelector('.fwa-hybrid-fullscreen')).toBeNull();
    } finally {
      document.removeEventListener('keydown', closeDrawer, true);
    }
  });

  it('closes a shared modal without switching the visual editor behind it', () => {
    const modal = openModal('格式設定', 'fwa-toolbar-test-modal');
    try {
      // A document handler may own the key even if its target is not inside
      // the shadow surface (for example, while focus is being restored).
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(modal.element.isConnected).toBe(false);
      expect(document.querySelector('.fwa-hybrid-fullscreen')).toBeTruthy();
    } finally {
      modal.close();
    }
  });

  it('keeps formatting and toolbar shortcuts inside an open dialog', async () => {
    selectHello();
    const modal = openModal('模板名稱', 'fwa-toolbar-test-modal');
    const input = document.createElement('input'); modal.body.appendChild(input); input.focus();
    try {
      for (const key of [
        { key: 'F10', altKey: true }, { key: 'b', ctrlKey: true },
        { key: 'i', ctrlKey: true }, { key: 'u', ctrlKey: true },
      ]) {
        const event = new KeyboardEvent('keydown', { ...key, bubbles: true, composed: true, cancelable: true });
        input.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect((modal.element.getRootNode() as ShadowRoot).activeElement).toBe(input);
      }
      await sync.projectionQueue.whenIdle();
      expect(sync.markdown).toBe('hello world\n\nuntouched');
    } finally { modal.close(); }
  });

  it('keeps article shortcuts working beside an open nonmodal drawer', async () => {
    const { root: shadow } = createShadowHost('fwa-toolbar-test-drawer');
    const drawer = document.createElement('aside'); drawer.className = 'fwa-panel'; shadow.appendChild(drawer);
    selectHello();
    const shortcut = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true });
    root.dispatchEvent(shortcut);
    await sync.projectionQueue.whenIdle();
    expect(shortcut.defaultPrevented).toBe(true);
    expect(sync.markdown).toBe('**hello** world\n\nuntouched');
    expect(drawer.isConnected).toBe(true);
  });
});

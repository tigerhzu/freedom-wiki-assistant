/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HybridPreviewFeature } from '../src/content/hybrid-preview';
import type { EditorAdapter } from '../src/content/editor-adapter';
import { DEFAULT_SETTINGS } from '../src/shared/types';

class MemoryAdapter implements EditorAdapter {
  readonly kind = 'textarea' as const;
  readonly rootElement = document.createElement('textarea');
  private listeners = new Set<() => void>();

  constructor(private value: string) {}

  getValue(): string { return this.value; }
  setValue(value: string): void { this.value = value; }
  getSelection() { return { start: 0, end: 0, text: '' }; }
  setSelection(_start: number, _end: number): void { return; }
  replaceRange(start: number, end: number, value: string): void {
    this.value = this.value.slice(0, start) + value + this.value.slice(end);
  }
  replaceSelection(value: string): void { this.value += value; }
  insertAtCursor(value: string): void { this.value += value; }
  undo(): boolean { return false; }
  redo(): boolean { return false; }
  focus(): void { return; }
  notifyChange(): void { this.listeners.forEach((listener) => listener()); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

describe('Future scroll preservation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    document.head.querySelector('#fwa-hybrid-preview-style')?.remove();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('restores the fullscreen viewport after Wiki.js replaces the preview root', async () => {
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<p>one</p><p>two</p>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    Object.defineProperty(preview, 'scrollHeight', { configurable: true, get: () => 2400 });
    Object.defineProperty(content, 'scrollHeight', { configurable: true, get: () => 2400 });

    const adapter = new MemoryAdapter('one\n\ntwo');
    const feature = new HybridPreviewFeature(adapter, { ...DEFAULT_SETTINGS, editorMode: 'hybrid' });
    feature.attach();
    preview.scrollTop = 840;

    const secondParagraph = root.lastElementChild as HTMLElement;
    secondParagraph.textContent = 'two!';
    secondParagraph.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    await vi.advanceTimersByTimeAsync(700);

    expect(adapter.getValue()).toBe('one\n\ntwo!');
    expect(content.style.minHeight).toBe('2400px');

    const replacement = document.createElement('article');
    replacement.innerHTML = '<p>one</p><p>two!</p>';
    content.replaceChildren(replacement);
    preview.scrollTop = 0; // Browser clamp while the old tall root is absent.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);

    expect(preview.scrollTop).toBe(840);
    await vi.advanceTimersByTimeAsync(40);
    expect(preview.scrollTop).toBe(840);
    expect(content.style.minHeight).toBe('');

    feature.detach();
  });
});

/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorAdapter, EditorChangeEvent, EditorChangeListener } from '../src/content/editor-adapter';
import { HybridPreviewFeature } from '../src/content/hybrid-preview';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import type { EditorMutationContext } from '../src/content/wiki-document-model';
import { WikiDocumentSync } from '../src/content/document-sync';

class DeferredVisualAdapter implements EditorAdapter {
  readonly kind = 'textarea' as const;
  readonly rootElement = document.createElement('textarea');
  private readonly listeners = new Set<EditorChangeListener>();
  private selection = { start: 0, end: 0 };
  private deferFirstProjection: boolean;
  private releaseDeferredProjection: (() => void) | null = null;
  private startedResolve: () => void = () => undefined;
  readonly firstProjectionStarted: Promise<void>;

  constructor(private value: string, deferFirstProjection = true) {
    this.deferFirstProjection = deferFirstProjection;
    this.firstProjectionStarted = new Promise<void>((resolve) => {
      this.startedResolve = resolve;
    });
  }

  getValue(): string { return this.value; }
  setValue(value: string, context?: EditorMutationContext): void {
    this.value = value;
    this.emit(context);
  }
  getSelection() {
    return { start: this.selection.start, end: this.selection.end, text: this.value.slice(this.selection.start, this.selection.end) };
  }
  setSelection(start: number, end: number): void { this.selection = { start, end }; }

  replaceRange(start: number, end: number, value: string, context?: EditorMutationContext): void | Promise<void> {
    const projected = this.value.slice(0, start) + value + this.value.slice(end);
    if (context?.origin === 'projection' && this.deferFirstProjection) {
      this.deferFirstProjection = false;
      this.startedResolve();
      return new Promise<void>((resolve) => {
        this.releaseDeferredProjection = () => {
          this.releaseDeferredProjection = null;
          this.setValue(projected, context);
          resolve();
        };
      });
    }
    this.setValue(projected, context);
  }

  replaceSelection(value: string, context?: EditorMutationContext): void | Promise<void> {
    return this.replaceRange(this.selection.start, this.selection.end, value, context);
  }
  insertAtCursor(value: string, context?: EditorMutationContext): void | Promise<void> {
    return this.replaceSelection(value, context);
  }
  undo(): boolean { return false; }
  redo(): boolean { return false; }
  focus(): void {}
  notifyChange(context?: EditorMutationContext): void { this.emit(context); }
  subscribe(listener: EditorChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  releaseProjection(): void {
    this.releaseDeferredProjection?.();
  }

  private emit(context?: EditorMutationContext): void {
    const event: EditorChangeEvent = {
      origin: context?.origin ?? 'native',
      transactionId: context?.transactionId,
      value: this.value,
    };
    this.listeners.forEach((listener) => listener(event));
  }
}

describe('Hybrid visual synchronization race', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    document.head.querySelector('#fwa-hybrid-preview-style')?.remove();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the S2 visual root when the S1 render arrives late', async () => {
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<p>one</p>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const adapter = new DeferredVisualAdapter('one');
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode: 'hybrid' },
      null,
      sync,
    );
    feature.attach();

    const paragraph = root.firstElementChild as HTMLElement;
    paragraph.textContent = 'one!';
    paragraph.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    expect(sync.currentSeq).toBe(1);
    await vi.advanceTimersByTimeAsync(700);
    await adapter.firstProjectionStarted;
    expect(root.contentEditable).toBe('true');

    // S2 arrives on the still-live visual root while S1 is in flight.
    paragraph.textContent = 'one!!';
    paragraph.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    expect(sync.currentSeq).toBe(2);
    await vi.advanceTimersByTimeAsync(700);
    expect(sync.markdown).toBe('one!!');
    expect(root.contentEditable).toBe('true');

    adapter.releaseProjection();
    await sync.projectionQueue.whenIdle();

    // Wiki.js now returns the stale S1 render. The feature must put the
    // existing S2 root back instead of activating this replacement.
    const staleS1Root = document.createElement('article');
    staleS1Root.innerHTML = '<p>one!</p>';
    content.replaceChildren(staleS1Root);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(content.firstElementChild).toBe(root);
    expect(root.textContent).toBe('one!!');

    // The next render is the S2 snapshot and may now become active.
    const latestS2Root = document.createElement('article');
    latestS2Root.innerHTML = '<p>one!!</p>';
    content.replaceChildren(latestS2Root);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);

    expect(content.firstElementChild?.textContent).toBe('one!!');
    expect(adapter.getValue()).toBe('one!!');
    feature.detach();
  });

  it('adopts a source-only color formatting render instead of restoring the old DOM', async () => {
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<p>hello</p>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const adapter = new DeferredVisualAdapter('hello', false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode: 'hybrid' },
      null,
      sync,
    );
    feature.attach();

    const text = root.firstElementChild!.firstChild!;
    root.focus();
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));

    const red = document
      .getElementById('fwa-hybrid-visual-menu-host')
      ?.shadowRoot
      ?.querySelector<HTMLButtonElement>('button.fwa-swatch[title="red"]');
    expect(red).not.toBeNull();
    red!.click();
    await sync.projectionQueue.whenIdle();

    // Wiki.js keeps this wrapper and replaces its innerHTML after the source
    // update. A source-only format operation must keep that rendered result.
    root.innerHTML = '<p><font color="red">hello</font></p>';
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelector('font')?.getAttribute('color')).toBe('red');
    expect(sync.markdown).toBe('<font color="red">hello</font>');
    feature.detach();
  });

  it.each(['hybrid', 'classic'] as const)('turns Enter into one Markdown line break in %s visual mode', async (editorMode) => {
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<p>寫在最下色區塊</p>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const adapter = new DeferredVisualAdapter('寫在最下色區塊', false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode },
      null,
      sync,
    );
    feature.attach();

    const paragraph = root.firstElementChild as HTMLElement;
    const text = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(text, '寫在最下'.length);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    root.focus();

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    paragraph.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(paragraph.innerHTML).toContain('<br>');

    await vi.advanceTimersByTimeAsync(700);
    await sync.projectionQueue.whenIdle();
    expect(sync.markdown).toBe('寫在最下\n色區塊');
    expect(adapter.getValue()).toBe('寫在最下\n色區塊');
    expect(sync.markdown.match(/\n/g)).toHaveLength(1);
    feature.detach();
  });

  it.each(['hybrid', 'classic'] as const)('keeps a space inside a color span when typed in the middle in %s visual mode', async (editorMode) => {
    const source = '前<font color="red">紅色文字</font>後';
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<p>前<font color="red">紅色文字</font>後</p>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const adapter = new DeferredVisualAdapter(source, false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode },
      null,
      sync,
    );
    feature.attach();

    const paragraph = root.firstElementChild as HTMLElement;
    const font = paragraph.querySelector('font')!;
    const text = font.firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    root.focus();

    const space = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });
    paragraph.dispatchEvent(space);

    expect(space.defaultPrevented).toBe(true);
    expect(font.textContent).toBe('紅色 文字');
    await vi.advanceTimersByTimeAsync(700);
    await sync.projectionQueue.whenIdle();
    expect(sync.markdown).toBe('前<font color="red">紅色 文字</font>後');
    expect(adapter.getValue()).toBe(sync.markdown);
    feature.detach();
  });

  it.each(['hybrid', 'classic'] as const)('leaves a color span when a space is typed at its end in %s visual mode', async (editorMode) => {
    const source = '前<font color="red">紅色文字</font>後';
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<p>前<font color="red">紅色文字</font>後</p>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const adapter = new DeferredVisualAdapter(source, false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode },
      null,
      sync,
    );
    feature.attach();

    const paragraph = root.firstElementChild as HTMLElement;
    const font = paragraph.querySelector('font')!;
    const range = document.createRange();
    const fontIndex = Array.prototype.indexOf.call(paragraph.childNodes, font);
    range.setStart(paragraph, fontIndex + 1);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    root.focus();

    const space = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });
    paragraph.dispatchEvent(space);

    expect(space.defaultPrevented).toBe(true);
    expect(font.textContent).toBe('紅色文字');
    const insertedSpace = font.nextSibling!;
    expect(insertedSpace?.textContent).toBe(' ');
    const selectionAfterSpace = window.getSelection()!;
    expect(selectionAfterSpace.anchorNode).toBe(insertedSpace);
    expect(selectionAfterSpace.anchorOffset).toBe(1);

    // The next character must be inserted into the plain-space text node too;
    // otherwise Chromium can reopen the left font at this exact boundary.
    const followUp = document.createTextNode('124');
    const followUpRange = document.createRange();
    followUpRange.setStart(insertedSpace, 1);
    followUpRange.collapse(true);
    followUpRange.insertNode(followUp);
    const followUpCaret = document.createRange();
    followUpCaret.setStartAfter(followUp);
    followUpCaret.collapse(true);
    selectionAfterSpace.removeAllRanges();
    selectionAfterSpace.addRange(followUpCaret);
    paragraph.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '124' }));
    await vi.advanceTimersByTimeAsync(700);
    await sync.projectionQueue.whenIdle();
    expect(sync.markdown).toBe('前<font color="red">紅色文字</font> 124後');
    expect(adapter.getValue()).toBe(sync.markdown);
    feature.detach();
  });

  it.each(['hybrid', 'classic'] as const)('handles beforeinput space and keeps following text plain at a color boundary in %s visual mode', async (editorMode) => {
    const source = '前<font color="red">紅色文字</font>後';
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<p>前<font color="red">紅色文字</font>後</p>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const adapter = new DeferredVisualAdapter(source, false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode },
      null,
      sync,
    );
    feature.attach();

    const paragraph = root.firstElementChild as HTMLElement;
    const font = paragraph.querySelector('font')!;
    const text = font.firstChild!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    root.focus();

    // A real Chromium editing surface can reach this path even when keydown
    // is consumed by the editor or the input method.
    const beforeInput = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: ' ',
    });
    font.dispatchEvent(beforeInput);

    expect(beforeInput.defaultPrevented).toBe(true);
    expect(font.textContent).toBe('紅色文字');
    const insertedSpace = font.nextSibling!;
    expect(insertedSpace.textContent).toBe(' ');
    expect(selection.anchorNode).toBe(insertedSpace);
    expect(selection.anchorOffset).toBe(1);

    const nextCharacter = new KeyboardEvent('keydown', {
      key: '1',
      code: 'Digit1',
      bubbles: true,
      cancelable: true,
    });
    paragraph.dispatchEvent(nextCharacter);

    expect(nextCharacter.defaultPrevented).toBe(true);
    expect(insertedSpace.textContent).toBe(' 1');
    await vi.advanceTimersByTimeAsync(700);
    await sync.projectionQueue.whenIdle();
    expect(sync.markdown).toBe('前<font color="red">紅色文字</font> 1後');
    expect(adapter.getValue()).toBe(sync.markdown);
    feature.detach();
  });

  it.each(['hybrid', 'classic'] as const)('leaves a colour wrapper before Enter at its end in %s visual mode', async (editorMode) => {
    const source = '前<font color="red">紅色文字</font>後';
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<p>前<font color="red">紅色文字</font>後</p>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const adapter = new DeferredVisualAdapter(source, false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode },
      null,
      sync,
    );
    feature.attach();

    const paragraph = root.firstElementChild as HTMLElement;
    const font = paragraph.querySelector('font')!;
    const text = font.firstChild!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    root.focus();

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    font.dispatchEvent(enter);

    expect(enter.defaultPrevented).toBe(true);
    expect(font.textContent).toBe('紅色文字');
    const lineBreak = font.nextSibling!;
    expect(lineBreak.nodeName).toBe('BR');
    const plainLine = lineBreak.nextSibling!;
    expect(plainLine.textContent).toBe('');
    expect(selection.anchorNode).toBe(plainLine);
    expect(selection.anchorOffset).toBe(0);

    const nextCharacter = new KeyboardEvent('keydown', {
      key: '1',
      code: 'Digit1',
      bubbles: true,
      cancelable: true,
    });
    paragraph.dispatchEvent(nextCharacter);

    expect(nextCharacter.defaultPrevented).toBe(true);
    expect(plainLine.textContent).toBe('1');
    await vi.advanceTimersByTimeAsync(700);
    await sync.projectionQueue.whenIdle();
    expect(sync.markdown).toBe('前<font color="red">紅色文字</font>\n1後');
    expect(adapter.getValue()).toBe(sync.markdown);
    feature.detach();
  });

  it.each(['hybrid', 'classic'] as const)('pastes multiline text as soft breaks without adding a blank line in %s visual mode', async (editorMode) => {
    const source = ['上方', '', '下方'].join('\n');
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<p>上方</p><p>下方</p>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const adapter = new DeferredVisualAdapter(source, false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode },
      null,
      sync,
    );
    feature.attach();

    const firstParagraph = root.firstElementChild as HTMLElement;
    const text = firstParagraph.firstChild!;
    root.focus();
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        files: [],
        getData: (type: string) => type === 'text/plain' ? '第一行\r\n第二行' : '',
      },
    });
    firstParagraph.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(true);
    expect(firstParagraph.querySelector('br')).not.toBeNull();
    expect(root.children).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(700);
    await sync.projectionQueue.whenIdle();

    expect(sync.markdown).toBe(['上方第一行', '第二行', '', '下方'].join('\n'));
    expect(sync.markdown).not.toContain('第一行\n\n第二行');
    expect(adapter.getValue()).toBe(sync.markdown);
    feature.detach();
  });

  it.each(['hybrid', 'classic'] as const)('keeps a multiline paste made between top-level blocks in %s visual mode', async (editorMode) => {
    const source = ['上方', '', '下方'].join('\n');
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<p>上方</p><p>下方</p>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const adapter = new DeferredVisualAdapter(source, false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode },
      null,
      sync,
    );
    feature.attach();

    root.focus();
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(root, 1);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        files: [],
        getData: (type: string) => type === 'text/plain' ? '第一行\n第二行' : '',
      },
    });
    root.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(true);
    expect(root.children).toHaveLength(3);
    expect(root.children[1].querySelector('br')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(700);
    await sync.projectionQueue.whenIdle();

    expect(sync.markdown).toBe(['上方', '', '第一行', '第二行', '', '下方'].join('\n'));
    expect(adapter.getValue()).toBe(sync.markdown);
    feature.detach();
  });

  it.each(['hybrid', 'classic'] as const)('preserves literal newlines when pasting into a code fence in %s visual mode', async (editorMode) => {
    const source = ['```', '原本', '```'].join('\n');
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<pre><code>原本</code></pre>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const adapter = new DeferredVisualAdapter(source, false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode },
      null,
      sync,
    );
    feature.attach();

    const code = root.querySelector('code')!;
    const text = code.firstChild!;
    root.focus();
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        files: [],
        getData: (type: string) => type === 'text/plain' ? '第一行\r\n第二行' : '',
      },
    });
    code.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    await sync.projectionQueue.whenIdle();

    expect(sync.markdown).toBe(['```', '原本第一行', '第二行', '```'].join('\n'));
    expect(adapter.getValue()).toBe(sync.markdown);
    feature.detach();
  });

  it('keeps the focused caret in Block C through native reconciliation', async () => {
    const source = ['Block A', 'Block B', 'Block C 12345678901234567890'].join('\n');
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<p>Block A</p><p>Block B</p><p>Block C 12345678901234567890</p>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const adapter = new DeferredVisualAdapter(source, false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode: 'hybrid' },
      null,
      sync,
    );
    feature.attach();

    const blockC = root.children[2];
    const text = blockC.firstChild;
    expect(text).not.toBeNull();
    root.focus();
    const range = document.createRange();
    range.setStart(text!, 20);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    // A native edit schedules a preview reconciliation while the visual root
    // is still the focused working surface.
    adapter.setValue(['Block A', 'Block B changed', 'Block C 12345678901234567890'].join('\n'));
    await vi.advanceTimersByTimeAsync(0);

    const rendered = document.createElement('article');
    rendered.innerHTML = '<p>Block A</p><p>Block B changed</p><p>Block C 12345678901234567890</p>';
    const outside = document.createElement('button');
    outside.type = 'button';
    document.body.appendChild(outside);
    content.replaceChildren(rendered);
    // Browser focusout can arrive after Wiki.js has detached the old root and
    // report the new render/body as relatedTarget. That event must not release
    // the pre-detach foreground ownership before the observer restores it.
    root.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);

    expect(content.firstElementChild).toBe(root);
    expect(document.activeElement).toBe(root);
    const currentSelection = window.getSelection()!;
    expect(currentSelection.anchorNode).toBe(text);
    expect(currentSelection.anchorOffset).toBe(20);

    // The newest renderer tree was deferred while the caret-owned root was
    // foreground. Once the user leaves the editor, adopt that tree without
    // focusing it or moving the selection to its first block.
    outside.focus();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(content.firstElementChild).toBe(rendered);
    expect(document.activeElement).toBe(outside);
    feature.detach();
  });

  it('adopts the latest Wiki.js alert DOM when the old root is unowned', async () => {
    const source = [
      '# Title',
      '',
      '> Warning text',
      '{.is-warning}',
      '',
      '> Info text',
      '{.is-info}',
      '',
      '> Danger text',
      '{.is-danger}',
    ].join('\n');
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = [
      '<h1>Title</h1>',
      '<blockquote class="is-warning line"><p>Warning text</p></blockquote>',
      '<blockquote class="is-info line"><p>Info text</p></blockquote>',
      '<blockquote class="is-danger line"><p>Danger text</p></blockquote>',
    ].join('');
    content.appendChild(root);
    preview.appendChild(content);
    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = 'outside';
    document.body.append(preview, outside);

    const adapter = new DeferredVisualAdapter(source, false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode: 'hybrid' },
      null,
      sync,
    );
    feature.attach();
    outside.focus();
    await vi.advanceTimersByTimeAsync(0);
    window.getSelection()?.removeAllRanges();

    // Edit only the title in the local visual DOM.
    const title = root.firstElementChild as HTMLElement;
    title.textContent = 'Title TEST';
    title.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    expect(sync.currentSeq).toBe(1);
    await vi.advanceTimersByTimeAsync(700);
    await sync.projectionQueue.whenIdle();
    expect(sync.markdown).toContain('Title TEST');
    expect(sync.markdown).toContain('{.is-warning}');
    expect(sync.markdown).toContain('{.is-info}');
    expect(sync.markdown).toContain('{.is-danger}');

    // The renderer returns a fresh semantic tree. The old local root must not
    // be reattached over it when no user focus/draft owns that root.
    const latest = document.createElement('article');
    latest.innerHTML = [
      '<h1>Title TEST</h1>',
      '<blockquote class="is-warning line"><p>Warning text</p></blockquote>',
      '<blockquote class="is-info line"><p>Info text</p></blockquote>',
      '<blockquote class="is-danger line"><p>Danger text</p></blockquote>',
    ].join('');
    content.replaceChildren(latest);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);

    expect(content.firstElementChild).toBe(latest);
    for (const [index, semanticType] of ['warning', 'info', 'danger'].entries()) {
      const alert = latest.children[index + 1] as HTMLElement;
      expect(alert.classList.contains(`is-${semanticType}`)).toBe(true);
      expect(alert.dataset.fwaSemanticType).toBe(semanticType);
    }
    expect(document.activeElement).toBe(outside);
    feature.detach();
  });

  it('does not focus the first block when the SPA remounts the feature', () => {
    const source = ['Block A', 'Block B', 'Block C'].join('\n');
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<p>Block A</p><p>Block B</p><p>Block C</p>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const adapter = new DeferredVisualAdapter(source, false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode: 'hybrid' },
      null,
      sync,
    );
    feature.attach();

    const text = root.children[2].firstChild!;
    root.focus();
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    feature.detach();
    const remountedFeature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode: 'hybrid' },
      null,
      sync,
    );
    remountedFeature.attach();

    expect(document.activeElement).toBe(root);
    expect(selection.anchorNode).toBe(text);
    expect(selection.anchorOffset).toBe(2);
    remountedFeature.detach();
  });

  it('keeps the focused root through a split renderer replacement and remount', async () => {
    const source = ['Block A', 'Block B', 'Block C 12345678901234567890'].join('\n');
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<p>Block A</p><p>Block B</p><p>Block C 12345678901234567890</p>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const adapter = new DeferredVisualAdapter(source, false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode: 'hybrid' },
      null,
      sync,
    );
    feature.attach();

    const text = root.children[2].firstChild!;
    root.focus();
    const range = document.createRange();
    range.setStart(text, 20);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    // Native Markdown changes arm a render wait. The renderer then removes
    // the old root in one task and inserts its replacement in a later task.
    adapter.setValue(['Block A', 'Block B changed', 'Block C 12345678901234567890'].join('\n'));
    await vi.advanceTimersByTimeAsync(0);
    content.replaceChildren();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);

    // Before the renderer inserts its result, a SPA observer may remount the
    // feature. The old focused root must be put back first, or the new feature
    // would focus the first heading and lose the caret.
    feature.detach();
    expect(content.firstElementChild).toBe(root);

    const remountedFeature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode: 'hybrid' },
      null,
      sync,
    );
    remountedFeature.attach();
    expect(document.activeElement).toBe(root);
    expect(selection.anchorNode).toBe(text);
    expect(selection.anchorOffset).toBe(20);
    remountedFeature.detach();
  });

  it('observes a renderer root appended after local-root restoration', async () => {
    const source = ['# Title', '', '> Warning text', '{.is-warning}'].join('\n');
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<h1>Title</h1><blockquote class="is-warning line"><p>Warning text</p></blockquote>';
    content.appendChild(root);
    preview.appendChild(content);
    const outside = document.createElement('button');
    outside.type = 'button';
    document.body.append(preview, outside);

    const adapter = new DeferredVisualAdapter(source, false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode: 'hybrid' },
      null,
      sync,
    );
    feature.attach();

    const text = root.children[0].firstChild!;
    root.focus();
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    adapter.setValue(['# Title TEST', '', '> Warning text', '{.is-warning}'].join('\n'));
    await vi.advanceTimersByTimeAsync(0);

    // First half of the renderer lifecycle: the old root disappears. The
    // feature restores it because it still owns the foreground caret.
    content.replaceChildren();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);
    expect(content.firstElementChild).toBe(root);

    // Second half: Wiki.js appends the actual rendered root after the local
    // root has been restored. This mutation must not be swallowed as our own
    // reattach; it stays deferred until the user leaves the editor.
    const latest = document.createElement('article');
    latest.innerHTML = '<h1>Title TEST</h1><blockquote class="is-warning line"><p>Warning text</p></blockquote>';
    content.appendChild(latest);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);
    expect(content.firstElementChild).toBe(root);
    expect(root.querySelector<HTMLElement>('blockquote')?.dataset.fwaSemanticType).toBe('warning');

    outside.focus();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(content.firstElementChild).toBe(latest);
    expect(latest.querySelector<HTMLElement>('blockquote')?.dataset.fwaSemanticType).toBe('warning');
    expect(document.activeElement).toBe(outside);
    feature.detach();
  });

  it('keeps the foreground tree when Wiki.js rewrites innerHTML on the same root', async () => {
    const source = [
      '# Title',
      '',
      'Block A',
      '',
      '> Warning text',
      '{.is-warning}',
    ].join('\n');
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('div');
    root.innerHTML = '<h1>Title</h1><p>Block A</p><blockquote class="is-warning line"><p>Warning text</p></blockquote>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const adapter = new DeferredVisualAdapter(source, false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode: 'hybrid' },
      null,
      sync,
    );
    feature.attach();

    const block = root.children[1] as HTMLElement;
    const text = block.firstChild!;
    root.focus();
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(text, 3);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    block.textContent = 'Block A!';
    range.setStart(block.firstChild!, 8);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    block.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));

    await vi.advanceTimersByTimeAsync(700);
    await sync.projectionQueue.whenIdle();

    // Wiki.js' Vue domProps path keeps the editorPreview element and replaces
    // only its innerHTML. This is the real renderer lifecycle on the page.
    root.innerHTML = '<h1>Title</h1><p>Block A!</p><blockquote class="is-warning line"><p>Warning text</p></blockquote>';
    // Chromium collapses a contenteditable selection when its children are
    // replaced. Model that renderer side effect before MutationObserver runs;
    // the feature must restore the saved range on the same root.
    const rendererHeading = root.children[0].firstChild!;
    selection.removeAllRanges();
    const rendererRange = document.createRange();
    rendererRange.setStart(rendererHeading, 0);
    rendererRange.collapse(true);
    selection.addRange(rendererRange);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);

    expect(document.activeElement).toBe(root);
    expect(selection.anchorNode?.textContent).toBe('Block A!');
    expect(selection.anchorOffset).toBe(8);
    expect(root.children[2].classList.contains('is-warning')).toBe(true);
    expect(root.children[2].getAttribute('data-fwa-semantic-type')).toBe('warning');
    expect(sync.markdown).toContain('{.is-warning}');

    // A second typing burst is what exposes the metadata loss: without
    // re-mapping the same root after innerHTML, every child is treated as a
    // new block and the untouched warning suffix is omitted.
    const secondBlock = root.children[1] as HTMLElement;
    secondBlock.textContent = 'Block A!!';
    const secondRange = document.createRange();
    secondRange.setStart(secondBlock.firstChild!, 9);
    secondRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(secondRange);
    secondBlock.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    await vi.advanceTimersByTimeAsync(700);
    await sync.projectionQueue.whenIdle();
    expect(sync.markdown).toContain('{.is-warning}');
    feature.detach();
  });

  it.each([
    ['an hr directly after the attrs line', ['> Warning text', '{.is-warning}', '---'].join('\n')],
    ['one blank line before the attrs line', ['> Warning text', '', '{.is-warning}', '', '---'].join('\n')],
  ])('keeps a warning colour after editing above it when %s', async (_caseName, suffix) => {
    const source = ['# Title', '', suffix].join('\n');
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<h1>Title</h1><blockquote class="is-warning line"><p>Warning text</p></blockquote><hr>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const adapter = new DeferredVisualAdapter(source, false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode: 'hybrid' },
      null,
      sync,
    );
    feature.attach();

    const title = root.firstElementChild as HTMLElement;
    title.textContent = 'Title edited';
    title.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    await vi.advanceTimersByTimeAsync(700);
    await sync.projectionQueue.whenIdle();

    expect(sync.markdown).toContain('{.is-warning}');
    expect(adapter.getValue()).toContain('{.is-warning}');
    feature.detach();
  });

  it('keeps the focused block and untouched box metadata through repeated autosync', async () => {
    const source = [
      '# Title',
      '',
      '<div style="background-color: #fffbf0; border-left: 4px solid #ffc107;">',
      '',
      '黃色 Block',
      '',
      '</div>',
      '',
      '<div style="background-color: #f0f7ff; border-left: 4px solid #0d6efd;">',
      '',
      '藍色 Block',
      '',
      '</div>',
      '',
      '> 特殊 Block',
      '{.is-danger}',
    ].join('\n');
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = [
      '<h1>Title</h1>',
      '<div style="background-color: #fffbf0; border-left: 4px solid #ffc107;"><p>黃色 Block</p></div>',
      '<div style="background-color: #f0f7ff; border-left: 4px solid #0d6efd;"><p>藍色 Block</p></div>',
      '<blockquote class="is-danger line"><p>特殊 Block</p></blockquote>',
    ].join('');
    content.appendChild(root);
    preview.appendChild(content);
    const title = document.createElement('input');
    title.name = 'title';
    document.body.append(title, preview);

    const adapter = new DeferredVisualAdapter(source, false);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode: 'hybrid' },
      null,
      sync,
    );
    feature.attach();

    const yellowBox = root.children[1] as HTMLElement;
    const yellowText = yellowBox.querySelector('p')!.firstChild!;
    root.focus();
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(yellowText, yellowText.textContent!.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    const rootFocus = vi.spyOn(root, 'focus');

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      yellowText.textContent = `黃色 Block ${attempt}`;
      range.setStart(yellowText, yellowText.textContent.length);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      yellowBox.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));

      // Allow the debounce plus the renderer-ack fallback timer to settle;
      // this models a real pause between repeated typing bursts.
      await vi.advanceTimersByTimeAsync(3000);
      await sync.projectionQueue.whenIdle();

      expect(document.activeElement).toBe(root);
      expect(selection.anchorNode).toBe(yellowText);
      expect(selection.anchorOffset).toBe(yellowText.textContent.length);
      expect(sync.markdown).toContain('background-color: #fffbf0');
      expect(sync.markdown).toContain('border-left: 4px solid #0d6efd');
      expect(sync.markdown).toContain('{.is-danger}');
      expect(sync.markdown).toContain(`黃色 Block ${attempt}`);
      expect(content.firstElementChild).toBe(root);
    }

    // No renderer reconciliation was needed for a local projection, so the
    // autosync path must not focus the root (or any title control) again.
    expect(rootFocus).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(title);
    feature.detach();
  });

  it('hands Classic ownership from the right preview to native Markdown and back', async () => {
    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('article');
    root.innerHTML = '<p>one</p>';
    content.appendChild(root);
    preview.appendChild(content);

    const adapter = new DeferredVisualAdapter('one', false);
    document.body.append(adapter.rootElement, preview);
    const sync = new WikiDocumentSync(adapter);
    const feature = new HybridPreviewFeature(
      adapter,
      { ...DEFAULT_SETTINGS, editorMode: 'classic' },
      null,
      sync,
    );
    feature.attach();

    // The engineer first edits the rendered right pane. Moving focus to the
    // native Markdown pane must flush that foreground draft before the left
    // pane can become the next writer.
    root.focus();
    const paragraph = root.firstElementChild as HTMLElement;
    paragraph.textContent = 'one right';
    const rightSelection = window.getSelection()!;
    const rightRange = document.createRange();
    rightRange.selectNodeContents(paragraph);
    rightRange.collapse(false);
    rightSelection.removeAllRanges();
    rightSelection.addRange(rightRange);
    paragraph.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    adapter.rootElement.focus();
    await vi.advanceTimersByTimeAsync(0);
    await sync.projectionQueue.whenIdle();

    expect(adapter.getValue()).toBe('one right');
    expect(sync.markdown).toBe('one right');

    // Native Markdown now owns the document. Its renderer result may replace
    // the released right tree, and Classic adopts it without resurrecting the
    // older right-hand draft.
    adapter.setValue('one right left');
    const nativeRender = document.createElement('article');
    nativeRender.innerHTML = '<p>one right left</p>';
    content.replaceChildren(nativeRender);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);

    expect(content.firstElementChild).toBe(nativeRender);
    expect(nativeRender.textContent).toBe('one right left');
    expect(document.activeElement).toBe(adapter.rootElement);

    // Clicking back into the right pane transfers ownership again; the next
    // visual projection is based on the latest native Markdown snapshot.
    nativeRender.focus();
    const latestParagraph = nativeRender.firstElementChild as HTMLElement;
    latestParagraph.textContent = 'one right left right';
    const latestRange = document.createRange();
    latestRange.selectNodeContents(latestParagraph);
    latestRange.collapse(false);
    rightSelection.removeAllRanges();
    rightSelection.addRange(latestRange);
    latestParagraph.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    await vi.advanceTimersByTimeAsync(700);
    await sync.projectionQueue.whenIdle();

    expect(adapter.getValue()).toBe('one right left right');
    expect(sync.markdown).toBe('one right left right');
    feature.detach();
  });
});

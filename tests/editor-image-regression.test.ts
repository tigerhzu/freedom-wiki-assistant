/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextareaAdapter } from '../src/content/editor-adapter';
import { WikiDocumentSync } from '../src/content/document-sync';
import { HybridPreviewFeature } from '../src/content/hybrid-preview';
import { parseHybridBlocks } from '../src/content/hybrid-blocks';
import { findImages } from '../src/content/markdown-image';
import { serializeNewVisualBlock } from '../src/content/hybrid-serialize';
import type { ImageDropHandler } from '../src/content/image-drop';
import { DEFAULT_SETTINGS, type EditorMode } from '../src/shared/types';

interface EditorActions {
  uploadVisualImages(files: File[], range: Range | null): Promise<void>;
  setMode(mode: EditorMode, persist: boolean): boolean;
}

const features: HybridPreviewFeature[] = [];
function mount(source: string, html: string, mode: EditorMode, uploadFiles = vi.fn(async () => [] as string[])) {
  document.body.innerHTML = '<textarea></textarea><div class="editor-markdown-preview"><div class="editor-markdown-preview-content"><article></article></div></div>';
  const textarea = document.querySelector('textarea')!;
  textarea.value = source;
  const root = document.querySelector('article')!;
  root.innerHTML = html;
  const adapter = new TextareaAdapter(textarea);
  const sync = new WikiDocumentSync(adapter);
  const feature = new HybridPreviewFeature(adapter, { ...DEFAULT_SETTINGS, editorMode: mode }, { uploadFiles } as unknown as ImageDropHandler, sync);
  feature.attach();
  features.push(feature);
  return { root, adapter, sync, actions: feature as unknown as EditorActions };
}

function input(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}

function imageCommand(image: HTMLImageElement, label: string) {
  image.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const menu = document.getElementById('fwa-hybrid-visual-menu-host')!.shadowRoot!;
  const button = Array.from(menu.querySelectorAll('button')).find(button => button.textContent === label);
  expect(button, label).toBeDefined();
  button!.click();
}

function paste(root: HTMLElement, range: Range, text: string) {
  root.focus();
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: () => text } });
  root.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

function history(root: HTMLElement, key: 'z' | 'y') {
  root.focus();
  root.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key }));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  features.splice(0).forEach(feature => feature.detach());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('image block boundaries', () => {
  it.each([
    '![one](/one.png)\n![two](/two.png)',
    '![one](/one.png) caption\n![two](/two.png)',
    '<img src="/one.png">\n<img src="/two.png">',
  ])('does not classify a group as one image: %s', source => {
    expect(parseHybridBlocks(source)[0].type).not.toBe('image');
  });

  it('serializes a newly inserted bare image with a space in its URL', () => {
    const image = document.createElement('img');
    image.setAttribute('src', '/image (1).png');
    image.alt = 'one';
    expect(serializeNewVisualBlock(image)).toBe('![one](</image (1).png>)');
  });
});

describe.each(['classic', 'hybrid'] as const)('image editing in %s mode', mode => {
  it('maps a paragraph-wrapped single image and keeps its exact size and metadata', async () => {
    const image = '![one](/one.png =400x300)\n{.is-note}';
    const { root, adapter } = mount(`# Title\n\n${image}`, '<h1>Title</h1><p class="is-note"><img src="/one.png" alt="one" width="400" height="300"></p>', mode);
    expect(root.children[1].getAttribute('data-fwa-source-index')).toBe('1');
    const heading = root.firstElementChild as HTMLElement;
    heading.textContent = 'Changed';
    input(heading);
    await vi.advanceTimersByTimeAsync(750);
    expect(adapter.getValue()).toBe(`# Changed\n\n${image}`);
  });

  it('keeps all four adjacent images when inserting a paragraph and switching modes', async () => {
    const images = [1, 2, 3, 4].map(n => `![image-${n}](/image-${n}.png)`);
    const { root, adapter, actions } = mount(`# Report\n\n${images.join('\n')}`, `<h1>Report</h1><p>${images.map((_, i) => `<img src="/image-${i + 1}.png" alt="image-${i + 1}">`).join('<br>')}</p>`, mode);
    expect(root.children[1].getAttribute('data-fwa-source-index')).toBe('1');
    const paragraph = document.createElement('p');
    paragraph.textContent = 'New instructions';
    root.prepend(paragraph);
    input(paragraph);
    await vi.advanceTimersByTimeAsync(750);
    expect(findImages(adapter.getValue()).map(i => i.raw)).toEqual(images);
    expect(actions.setMode(mode === 'classic' ? 'hybrid' : 'classic', false)).toBe(true);
    expect(findImages(adapter.getValue()).map(i => i.raw)).toEqual(images);
  });

  it('preserves image tokens inside a text paragraph when its text changes', async () => {
    const images = '![one](</image (1).png> =400x300)\n<img src="/two.png" alt="two" width="300" loading="lazy">';
    const { root, adapter } = mount(`Before\n${images}`, ' <p>Before<br><img src="/image (1).png" alt="one" width="400" height="300"><br><img src="/two.png" alt="two" width="300" loading="lazy"></p>', mode);
    const paragraph = root.firstElementChild as HTMLElement;
    paragraph.firstChild!.textContent = 'After';
    input(paragraph);
    await vi.advanceTimersByTimeAsync(750);
    expect(adapter.getValue()).toBe(`After\n${images}`);
  });

  it('finishes an upload after the user types, keeping the newer caret', async () => {
    let finish!: (lines: string[]) => void;
    const uploader = vi.fn(() => new Promise<string[]>(resolve => { finish = resolve; }));
    const { root, adapter, actions } = mount('Before', '<p>Before</p>', mode, uploader);
    const upload = actions.uploadVisualImages([new File(['x'], 'new.png', { type: 'image/png' })], null);
    const paragraph = root.firstElementChild as HTMLElement;
    paragraph.textContent = 'Before and newer text';
    root.focus();
    const caret = document.createRange();
    caret.selectNodeContents(paragraph);
    caret.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(caret);
    input(paragraph);
    finish(['![new](/new.png)']);
    await upload;
    await vi.advanceTimersByTimeAsync(750);
    expect(root.querySelector('img')?.getAttribute('src')).toBe('/new.png');
    expect(root.querySelector('.fwa-hybrid-upload-placeholder')).toBeNull();
    expect(adapter.getValue()).toContain('Before and newer text');
    expect(findImages(adapter.getValue()).map(i => i.url)).toEqual(['/new.png']);
    expect(paragraph.contains(window.getSelection()!.anchorNode)).toBe(true);
  });

  it('restores selected content when an upload fails or is cancelled', async () => {
    const { root, adapter, actions } = mount('Keep this text', '<p>Keep this text</p>', mode);
    const range = document.createRange();
    range.selectNodeContents(root.firstElementChild!);
    await actions.uploadVisualImages([new File(['x'], 'new.png', { type: 'image/png' })], range);
    await vi.advanceTimersByTimeAsync(750);
    expect(root.textContent).toBe('Keep this text');
    expect(adapter.getValue()).toBe('Keep this text');
  });

  it('resizes, aligns, borders, and resets one image without changing its neighbors', async () => {
    const images = [1, 2, 3, 4].map(n => `![image-${n}](/image-${n}.png)`);
    const { root, adapter, sync } = mount(images.join('\n'), `<p>${images.map((_, i) => `<img src="/image-${i + 1}.png" alt="image-${i + 1}">`).join('<br>')}</p>`, mode);
    const image = root.querySelectorAll('img')[1];
    for (const command of ['50%', '置中', '圓角', '框線', '原始尺寸', '還原 Markdown']) {
      imageCommand(image, command);
      await sync.projectionQueue.whenIdle();
      const result = findImages(adapter.getValue());
      expect(result.map(i => i.url), command).toEqual([1, 2, 3, 4].map(n => `/image-${n}.png`));
      expect([result[0].raw, result[2].raw, result[3].raw], command).toEqual([images[0], images[2], images[3]]);
    }
    expect(adapter.getValue()).toBe(images.join('\n'));
  });

  it('clears renderer width and height attributes when restoring the original size', async () => {
    const { root, adapter, sync } = mount('![one](/one.png =400x300)', '<p><img src="/one.png" alt="one" width="400" height="300"></p>', mode);
    imageCommand(root.querySelector('img')!, '原始尺寸');
    await sync.projectionQueue.whenIdle();
    expect(root.querySelector('img')!.hasAttribute('width')).toBe(false);
    expect(root.querySelector('img')!.hasAttribute('height')).toBe(false);
    expect(adapter.getValue()).toBe('![one](/one.png)');
  });

  it('restores a selected image when the upload service rejects', async () => {
    const uploader = vi.fn(async (): Promise<string[]> => { throw new Error('Upload unavailable'); });
    const { root, adapter, actions } = mount('![old](/old.png)', '<p><img src="/old.png" alt="old"></p>', mode, uploader);
    const range = document.createRange();
    range.selectNode(root.querySelector('img')!);
    await actions.uploadVisualImages([new File(['x'], 'new.png', { type: 'image/png' })], range);
    await vi.advanceTimersByTimeAsync(750);
    expect(root.querySelector('img')?.getAttribute('src')).toBe('/old.png');
    expect(adapter.getValue()).toBe('![old](/old.png)');
  });

  it('keeps concurrent uploads even when they finish in reverse order', async () => {
    const finishes: Array<(lines: string[]) => void> = [];
    const uploader = vi.fn(() => new Promise<string[]>(resolve => finishes.push(resolve)));
    const { root, adapter, actions } = mount('Before', '<p>Before</p>', mode, uploader);
    const file = new File(['x'], 'new.png', { type: 'image/png' });
    const first = actions.uploadVisualImages([file], null);
    const second = actions.uploadVisualImages([file], null);
    finishes[1](['![second](/second.png)']);
    await second;
    finishes[0](['![first](/first.png)']);
    await first;
    await vi.advanceTimersByTimeAsync(750);
    expect(findImages(adapter.getValue()).map(i => i.url)).toEqual(['/first.png', '/second.png']);
    expect(root.querySelectorAll('.fwa-hybrid-upload-placeholder')).toHaveLength(0);
  });

  it('undoes and redoes multiline paste without removing prior text or images', async () => {
    const source = 'Before\n![one](/one.png)';
    const { root, adapter } = mount(source, '<p>Before<br><img src="/one.png" alt="one"></p>', mode);
    const range = document.createRange();
    range.setStart(root.firstElementChild!.firstChild!, 6);
    range.collapse(true);
    paste(root, range, 'first\nsecond');
    await vi.advanceTimersByTimeAsync(750);
    const pasted = 'Beforefirst\nsecond\n![one](/one.png)';
    expect(adapter.getValue()).toBe(pasted);
    history(root, 'z');
    await vi.advanceTimersByTimeAsync(750);
    expect(adapter.getValue()).toBe(source);
    expect(root.querySelectorAll('img')).toHaveLength(1);
    history(root, 'y');
    expect(root.textContent).toContain('Beforefirstsecond');
    await vi.advanceTimersByTimeAsync(1700);
    expect(adapter.getValue()).toBe(pasted);
  });

  it('restores an image replaced by text when undoing paste', async () => {
    const { root, adapter } = mount('![one](/one.png)', '<p><img src="/one.png" alt="one"></p>', mode);
    const range = document.createRange();
    range.selectNode(root.querySelector('img')!);
    paste(root, range, 'replacement');
    await vi.advanceTimersByTimeAsync(750);
    expect(adapter.getValue()).toBe('replacement');
    history(root, 'z');
    await vi.advanceTimersByTimeAsync(750);
    expect(adapter.getValue()).toBe('![one](/one.png)');
    expect(root.querySelector('img')?.getAttribute('src')).toBe('/one.png');
    history(root, 'y');
    await vi.advanceTimersByTimeAsync(1700);
    expect(adapter.getValue()).toBe('replacement');
  });

  it('undoes paste between blocks without retaining an empty paragraph', async () => {
    const { root, adapter } = mount('Before\n\nAfter', '<p>Before</p><p>After</p>', mode);
    const range = document.createRange();
    range.setStart(root, 1);
    range.collapse(true);
    paste(root, range, 'first\nsecond');
    await vi.advanceTimersByTimeAsync(750);
    expect(adapter.getValue()).toBe('Before\n\nfirst\nsecond\n\nAfter');
    history(root, 'z');
    await vi.advanceTimersByTimeAsync(750);
    expect(root.children).toHaveLength(2);
    expect(adapter.getValue()).toBe('Before\n\nAfter');
    history(root, 'y');
    await vi.advanceTimersByTimeAsync(1700);
    expect(adapter.getValue()).toBe('Before\n\nfirst\nsecond\n\nAfter');
  });
});

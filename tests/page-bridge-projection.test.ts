/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeCall } from '../src/content/bridge';

describe('page bridge visual projection boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '';
    document.documentElement.querySelector('#fwa-bridge-node')?.remove();
  });

  it('keeps Wiki.js from rewriting the foreground preview for a visual change', async () => {
    const bridgeNode = document.createElement('div');
    bridgeNode.id = 'fwa-bridge-node';
    document.documentElement.appendChild(bridgeNode);

    const preview = document.createElement('div');
    preview.className = 'editor-markdown-preview';
    const content = document.createElement('div');
    content.className = 'editor-markdown-preview-content';
    const root = document.createElement('div');
    root.innerHTML = '<h1>Title</h1><p>Foreground text</p>';
    content.appendChild(root);
    preview.appendChild(content);
    document.body.appendChild(preview);

    const changeHandlers: Array<(cm: unknown, change: { origin: string }) => void> = [];
    let value = 'source';
    const doc = {
      getCursor: () => ({ line: 0, ch: value.length }),
      indexFromPos: (position: { line: number; ch: number }) => position.ch,
      posFromIndex: (index: number) => ({ line: 0, ch: index }),
      getSelection: () => '',
      replaceRange: (
        replacement: string,
        from: { ch: number },
        to: { ch: number },
        origin: string,
      ) => {
        value = value.slice(0, from.ch) + replacement + value.slice(to.ch);
        changeHandlers.forEach((handler) => handler(cm, { origin }));
      },
    };
    const cm = {
      on: (event: string, handler: (cm: unknown, change: { origin: string }) => void) => {
        if (event === 'change') changeHandlers.push(handler);
      },
      getDoc: () => doc,
      getValue: () => value,
      somethingSelected: () => false,
      focus: () => undefined,
    };
    const editor = document.createElement('div');
    editor.className = 'CodeMirror';
    (editor as HTMLElement & { CodeMirror?: unknown }).CodeMirror = cm;
    editor.setAttribute('data-fwa-editor-target', '1');
    document.body.appendChild(editor);

    await import('../src/content/page-bridge');
    bridgeCall('watchChanges', { kind: 'codemirror5' });
    bridgeCall('replaceRange', {
      kind: 'codemirror5',
      start: 0,
      end: 0,
      value: 'visual ',
      context: {
        origin: 'projection',
        transactionId: 'visual-tx',
        suppressPreviewRender: true,
      },
    });

    const foregroundMarkup = root.innerHTML;
    root.innerHTML = '<h1>Title</h1><p>Wiki.js native render</p>';
    expect(root.innerHTML).toBe(foregroundMarkup);
    expect(cm.somethingSelected()).toBe(true);

    // A real native Markdown edit is a new ownership boundary. It must be
    // allowed to render normally and restore native scroll-sync behaviour.
    doc.replaceRange('native ', { ch: 0 }, { ch: 0 }, 'input');
    expect(cm.somethingSelected()).toBe(false);
    root.innerHTML = '<h1>Title</h1><p>Native render</p>';
    expect(root.innerHTML).toBe('<h1>Title</h1><p>Native render</p>');

    // A source-only formatting action (for example, adding a font color from
    // the visual context menu) must let Wiki.js render the changed preview.
    bridgeCall('replaceRange', {
      kind: 'codemirror5',
      start: 0,
      end: 0,
      value: 'format ',
      context: {
        origin: 'projection',
        transactionId: 'format-tx',
        suppressPreviewRender: false,
      },
    });
    root.innerHTML = '<h1>Title</h1><p><font color="red">Formatted</font></p>';
    expect(root.innerHTML).toBe('<h1>Title</h1><p><font color="red">Formatted</font></p>');
  });
});

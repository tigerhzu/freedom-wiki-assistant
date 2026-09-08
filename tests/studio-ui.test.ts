// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { el, openModal, showToast } from '../src/content/ui';

const handles: Array<ReturnType<typeof openModal>> = [];
afterEach(() => { handles.reverse().forEach((handle) => handle.close()); handles.length = 0; document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('Studio dialog keyboard lifecycle', () => {
  it('names dialogs, closes only the top layer on Escape, and returns focus to its opener', () => {
    const opener = el('button', { text: '開啟' });
    document.body.appendChild(opener);
    opener.focus();
    const parent = openModal('圖片資料庫', 'studio-test-parent'); handles.push(parent);
    const confirmButton = el('button', { text: '刪除選取' });
    parent.body.appendChild(confirmButton);
    confirmButton.focus();
    const child = openModal('確認刪除', 'studio-test-child'); handles.push(child);
    expect(child.element.getAttribute('role')).toBe('dialog');
    const titleId = child.element.getAttribute('aria-labelledby')!;
    expect(child.element.querySelector(`#${titleId}`)?.textContent).toBe('確認刪除');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(child.element.isConnected).toBe(false);
    expect(parent.element.isConnected).toBe(true);
    expect(confirmButton.getRootNode()).toBe(parent.element.getRootNode());
    expect((parent.element.getRootNode() as ShadowRoot).activeElement).toBe(confirmButton);
    parent.close();
    expect(document.activeElement).toBe(opener);
  });

  it('wraps keyboard focus within the dialog and cleans replacement callbacks once', () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ width: 32, height: 32 }] as unknown as DOMRectList);
    const dialog = openModal('原始對話框', 'studio-test-replace'); handles.push(dialog);
    const last = el('button', { text: '完成' }); dialog.footer.appendChild(last);
    const backwards = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(backwards);
    expect(backwards.defaultPrevented).toBe(true);
    expect((dialog.element.getRootNode() as ShadowRoot).activeElement).toBe(last);
    last.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect((dialog.element.getRootNode() as ShadowRoot).activeElement).toBe(dialog.element.querySelector('.fwa-modal-close'));
    const cleanup = vi.fn(); dialog.onClose(cleanup);
    const replacement = openModal('新對話框', 'studio-test-replace'); handles.push(replacement);
    expect(cleanup).toHaveBeenCalledOnce();
    dialog.close();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(replacement.element.isConnected).toBe(true);
  });

  it('announces errors without treating the message as markup', () => {
    showToast('<img src=x onerror=alert(1)>', 'error', 10);
    const root = document.getElementById('fwa-toast-host')!.shadowRoot!;
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('<img');
    expect(root.querySelector('img')).toBeNull();
  });
});

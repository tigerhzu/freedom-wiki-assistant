import cssText from '../styles/extension.css?inline';

/**
 * Shadow-DOM helpers shared by all content UI. Each feature gets its own
 * shadow root so extension CSS never affects the wiki page (and vice versa).
 */

export function createShadowHost(id: string): { host: HTMLElement; root: ShadowRoot } {
  const existing = document.getElementById(id);
  if (existing?.shadowRoot) {
    return { host: existing, root: existing.shadowRoot };
  }
  existing?.remove();
  const host = document.createElement('div');
  host.id = id;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = cssText;
  root.appendChild(style);
  document.documentElement.appendChild(host);
  return { host, root };
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

/* ── toasts ── */

let toastArea: HTMLElement | null = null;

function ensureToastArea(): HTMLElement {
  const { root } = createShadowHost('fwa-toast-host');
  if (!toastArea || !root.contains(toastArea)) {
    toastArea = el('div', { class: 'fwa-toast-area' });
    root.appendChild(toastArea);
  }
  return toastArea;
}

export function showToast(message: string, kind: 'info' | 'success' | 'error' = 'info', ms = 4000): void {
  const area = ensureToastArea();
  const toast = el('div', { class: `fwa-toast ${kind}` }, [el('span', { class: 'msg', text: message })]);
  area.appendChild(toast);
  window.setTimeout(() => toast.remove(), ms);
}

export interface LoadingToastHandle {
  close(): void;
  /** Replace the text in place — used for「第 3/7 段」on a chunked AI 排版 run. */
  setMessage(message: string): void;
}

/** Indeterminate "still working" toast (no progress fraction) — closed by the caller once the async call settles. */
export function showLoadingToast(message: string): LoadingToastHandle {
  const area = ensureToastArea();
  const label = el('span', { class: 'msg', text: message });
  const toast = el('div', { class: 'fwa-toast info' }, [label]);
  area.appendChild(toast);
  return {
    close: () => toast.remove(),
    setMessage: (next: string) => {
      label.textContent = next;
    },
  };
}

export interface ProgressHandle {
  setProgress(fraction: number): void;
  finish(message: string, kind: 'success' | 'error'): void;
  element: HTMLElement;
}

/** Toast with a progress bar and a cancel button (for uploads). */
export function showProgressToast(label: string, onCancel: () => void): ProgressHandle {
  const area = ensureToastArea();
  const bar = el('div');
  const progress = el('div', { class: 'fwa-progress' }, [bar]);
  const msg = el('span', { class: 'msg', text: label });
  const cancel = el('button', { class: 'fwa-btn fwa-btn-danger', text: '取消' });
  const body = el('div', { style: 'flex:1' }, [msg, progress]);
  const toast = el('div', { class: 'fwa-toast' }, [body, cancel]);
  cancel.addEventListener('click', () => {
    onCancel();
    toast.remove();
  });
  area.appendChild(toast);
  return {
    element: toast,
    setProgress(fraction: number) {
      bar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    },
    finish(message: string, kind: 'success' | 'error') {
      toast.remove();
      showToast(message, kind);
    },
  };
}

/**
 * Non-blocking "將上傳至：X" confirmation with a "變更資料夾" override
 * button. Resolves 'proceed' once `ms` elapses without the button being
 * clicked, or 'change' the instant it is — giving the user a genuine window
 * to redirect before any network call happens, without a modal in the way
 * for the common case.
 */
export function showFolderConfirmToast(folderPath: string, ms = 3000): Promise<'proceed' | 'change'> {
  return new Promise((resolve) => {
    const area = ensureToastArea();
    let done = false;
    const finish = (result: 'proceed' | 'change') => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      toast.remove();
      resolve(result);
    };
    const msg = el('span', { class: 'msg', text: `將上傳至：${folderPath}` });
    const change = el('button', { class: 'fwa-btn', text: '變更資料夾' });
    change.addEventListener('click', () => finish('change'));
    const toast = el('div', { class: 'fwa-toast info' }, [msg, change]);
    area.appendChild(toast);
    const timer = window.setTimeout(() => finish('proceed'), ms);
  });
}

/* ── generic modal ── */

export interface ModalHandle {
  close(): void;
  onClose(callback: () => void): void;
  body: HTMLElement;
  footer: HTMLElement;
  element: HTMLElement;
  /** The backdrop layer. Overlay UI that belongs to this modal can be mounted here. */
  layer: HTMLElement;
}

export function openModal(
  title: string,
  hostId = 'fwa-modal-host',
  extraClass = '',
  dismissible = true,
): ModalHandle {
  const { root } = createShadowHost(hostId);
  root.querySelector('.fwa-modal-backdrop')?.remove();

  const body = el('div', { class: 'fwa-modal-body' });
  const footer = el('div', { class: 'fwa-modal-footer' });
  const modal = el('div', { class: extraClass ? `fwa-modal ${extraClass}` : 'fwa-modal' }, [
    el('div', { class: 'fwa-modal-header', text: title }),
    body,
    footer,
  ]);
  const backdrop = el('div', { class: 'fwa-modal-backdrop' }, [modal]);
  let closed = false;
  const closeCallbacks = new Set<() => void>();

  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    for (const callback of closeCallbacks) callback();
    closeCallbacks.clear();
  };
  const onKey = (e: KeyboardEvent) => {
    if (dismissible && e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  backdrop.addEventListener('mousedown', (e) => {
    if (dismissible && e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey, true);

  root.appendChild(backdrop);
  return {
    close,
    onClose(callback) {
      if (closed) callback();
      else closeCallbacks.add(callback);
    },
    body,
    footer,
    element: modal,
    layer: backdrop,
  };
}

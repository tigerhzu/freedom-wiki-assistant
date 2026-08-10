/**
 * Shared plumbing for talking to page-bridge.js (the MAIN-world script).
 * Isolated content-script worlds cannot see page-world JS objects (Vue
 * instances, CodeMirror/Monaco/Ace instances), so requests/responses travel
 * through DOM attributes on a shared element instead. See page-bridge.ts for
 * the MAIN-world side of this protocol.
 */

const BRIDGE_ELEMENT_ID = 'fwa-bridge-node';
let bridgeReady: Promise<void> | null = null;
let bridgeSeq = 0;
let asyncBridgeTail: Promise<unknown> = Promise.resolve();

export function ensureBridge(): Promise<void> {
  if (bridgeReady) return bridgeReady;
  bridgeReady = new Promise<void>((resolve, reject) => {
    let node = document.getElementById(BRIDGE_ELEMENT_ID);
    if (!node) {
      node = document.createElement('div');
      node.id = BRIDGE_ELEMENT_ID;
      node.style.display = 'none';
      document.documentElement.appendChild(node);
    }
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('page-bridge.js');
    script.onload = () => {
      script.remove();
      resolve();
    };
    script.onerror = () => reject(new Error('page-bridge.js failed to load'));
    document.documentElement.appendChild(script);
  });
  return bridgeReady;
}

interface BridgeResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export function bridgeCall<T>(op: string, args: Record<string, unknown> = {}): T {
  const node = document.getElementById(BRIDGE_ELEMENT_ID);
  if (!node) throw new Error('bridge node missing');
  const id = ++bridgeSeq;
  node.setAttribute('data-fwa-req', JSON.stringify({ id, op, args }));
  node.dispatchEvent(new CustomEvent('fwa:bridge-request'));
  const raw = node.getAttribute('data-fwa-res');
  node.removeAttribute('data-fwa-req');
  if (!raw) throw new Error(`bridge did not answer op=${op}`);
  const res = JSON.parse(raw) as BridgeResponse;
  if (res.id !== id) throw new Error(`bridge answered wrong request (${res.id} != ${id})`);
  if (!res.ok) throw new Error(res.error ?? `bridge op failed: ${op}`);
  return res.value as T;
}

/**
 * Async bridge calls are serialized because the bridge intentionally uses one
 * hidden DOM node. This also keeps concurrent topology expansions from
 * overwriting one another's request/response attributes.
 */
export function bridgeCallAsync<T>(
  op: string,
  args: Record<string, unknown> = {},
  timeoutMs = 20_000,
): Promise<T> {
  const call = asyncBridgeTail.catch(() => undefined).then(async () => {
    await ensureBridge();
    const node = document.getElementById(BRIDGE_ELEMENT_ID);
    if (!node) throw new Error('bridge node missing');
    const id = ++bridgeSeq;

    return await new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        node.removeEventListener('fwa:bridge-response', onResponse);
        node.removeAttribute('data-fwa-req');
      };
      const onResponse = () => {
        const raw = node.getAttribute('data-fwa-res');
        if (!raw) return;
        const res = JSON.parse(raw) as BridgeResponse;
        if (res.id !== id) return;
        cleanup();
        if (!res.ok) reject(new Error(res.error ?? `bridge op failed: ${op}`));
        else resolve(res.value as T);
      };
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error(`bridge op timed out: ${op}`));
      }, timeoutMs);

      node.addEventListener('fwa:bridge-response', onResponse);
      node.setAttribute('data-fwa-req', JSON.stringify({ id, op, args }));
      node.dispatchEvent(new CustomEvent('fwa:bridge-request'));
    });
  });

  asyncBridgeTail = call;
  return call;
}

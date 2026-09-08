/** Isolated browser storage for the local preview; never imported by production. */
export function installPreviewChrome(): void {
  const store: Record<string, unknown> = JSON.parse(sessionStorage.getItem('wiki-studio-preview') || '{}');
  const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  Object.defineProperty(window, 'chrome', { configurable: true, value: {
    runtime: {
      id: 'wiki-studio-local-preview',
      getURL: (path: string) => path === 'page-bridge.js' ? '/dist/page-bridge.js' : path.startsWith('pet/') ? `/src/${path}` : `/${path}`,
      onMessage: { addListener: () => {}, removeListener: () => {} },
      sendMessage: async (message: { type: string }, callback?: (value: unknown) => void) => {
        if (message.type === 'fwa:open-settings') window.open('/src/settings/settings.html?preview=1', '_blank');
        const result = { ok: false, error: '互動預覽未連線至 Wiki 或 AI 服務。' };
        callback?.(result);
        return result;
      },
      openOptionsPage: () => window.open('/src/settings/settings.html?preview=1', '_blank'),
    },
    storage: {
      onChanged: { addListener: (fn: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => listeners.add(fn), removeListener: (fn: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void) => listeners.delete(fn) },
      local: {
        get: async (keys?: string | string[] | null) => !keys ? structuredClone(store) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(store[key])])),
        set: async (items: Record<string, unknown>) => {
          const changes = Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { oldValue: store[key], newValue: value }]));
          Object.assign(store, structuredClone(items));
          sessionStorage.setItem('wiki-studio-preview', JSON.stringify(store));
          listeners.forEach((fn) => fn(changes, 'local'));
        },
      },
    },
  } });
}

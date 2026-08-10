/** Typed runtime messages between content script and background service worker. */

export interface OpenSettingsMessage {
  type: 'fwa:open-settings';
}

export interface OpenTabMessage {
  type: 'fwa:open-tab';
  url: string;
}

/**
 * Sent by content/ai-layout.ts, handled by background/service-worker.ts.
 * Only the raw page content crosses this boundary — the Azure OpenAI
 * request/response and the API key never leave the background context.
 */
export interface AiLayoutRequestMessage {
  type: 'fwa:ai-layout-request';
  content: string;
  /**
   * 1-based position when the content script had to split a long article
   * (see content/markdown-chunk.ts). Both omitted for a single-shot request,
   * which is the common case. The chunk framing goes into the *user* message
   * only — the system prompt must stay byte-identical for the prompt cache.
   */
  chunkIndex?: number;
  chunkTotal?: number;
}

export type RuntimeMessage = OpenSettingsMessage | OpenTabMessage | AiLayoutRequestMessage;

export function sendMessage(message: RuntimeMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

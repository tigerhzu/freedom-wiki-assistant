import { AiLayoutError, runAiLayout } from './ai-layout-service';
import type { AiLayoutRequestMessage, RuntimeMessage } from '../shared/messages';
import { getSettings } from '../shared/storage';
import type { AiLayoutResponse } from '../shared/ai-layout-types';
import { seedDefaultTemplatesIfEmpty } from '../templates/template-service';
import { WIKI_ORIGIN } from '../config/wiki-config';

/**
 * Background service worker. Seeds default templates on install, handles a
 * couple of UI messages, and — for "AI 排版" — is the only context that
 * holds the Azure OpenAI API key and makes the network call (see
 * ai-layout-service.ts / azure-openai-client.ts for why: CORS and key
 * exposure, same reasoning as the HaloPSA extension's service-worker.js).
 */

chrome.runtime.onInstalled.addListener(() => {
  void seedDefaultTemplatesIfEmpty();
});

async function handleAiLayoutRequest(message: AiLayoutRequestMessage): Promise<AiLayoutResponse> {
  try {
    const settings = await getSettings();
    const result = await runAiLayout(message.content, settings, {
      index: message.chunkIndex ?? 1,
      total: message.chunkTotal ?? 1,
    });
    return { ok: true, result };
  } catch (err) {
    if (err instanceof AiLayoutError) {
      return { ok: false, error: err.message, code: err.code };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err), code: 'unknown' };
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  switch (message.type) {
    case 'fwa:open-settings':
      void chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;
    case 'fwa:open-tab': {
      // Only ever open pages on the wiki origin.
      if (message.url.startsWith(WIKI_ORIGIN)) {
        void chrome.tabs.create({ url: message.url });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'origin not allowed' });
      }
      return false;
    }
    case 'fwa:ai-layout-request':
      void handleAiLayoutRequest(message).then(sendResponse);
      return true; // async sendResponse
    default:
      return false;
  }
});

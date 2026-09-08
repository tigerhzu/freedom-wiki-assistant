import { AiLayoutError, runAiLayout } from './ai-layout-service';
import type {
  AiLayoutRequestMessage,
  ActivateFutureResponse,
  OpenOnboardingResponse,
  RuntimeMessage,
} from '../shared/messages';
import { getSettings } from '../shared/storage';
import type { AiLayoutResponse } from '../shared/ai-layout-types';
import { seedDefaultTemplatesIfEmpty } from '../templates/template-service';
import { WIKI_ORIGIN } from '../config/wiki-config';

/**
 * Background service worker. Seeds default templates on install, handles a
 * couple of UI messages, and — for "AI 排版" — is the only context that
 * holds the selected provider API key and makes the network call (see
 * ai-layout-service.ts and the provider clients for why: CORS and key
 * exposure, same reasoning as the HaloPSA extension's service-worker.js).
 */

chrome.runtime.onInstalled.addListener(() => {
  void seedDefaultTemplatesIfEmpty();
});

let onboardingTabId: number | null = null;
let onboardingSourceTabId: number | null = null;

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

function sourceEditorTabId(sender: chrome.runtime.MessageSender): number | null {
  const tabId = sender.tab?.id;
  const rawUrl = sender.tab?.url;
  if (tabId === undefined || !rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return url.origin === WIKI_ORIGIN && url.pathname.startsWith('/e/') ? tabId : null;
  } catch {
    return null;
  }
}

async function handleOpenOnboarding(sender: chrome.runtime.MessageSender): Promise<OpenOnboardingResponse> {
  const onboardingUrl = chrome.runtime.getURL('src/onboarding/onboarding.html');
  onboardingSourceTabId = sourceEditorTabId(sender);

  try {
    const existingTabs = await chrome.tabs.query({ url: onboardingUrl });
    const existing = existingTabs.find((tab) => tab.id !== undefined);
    if (existing?.id !== undefined) {
      onboardingTabId = existing.id;
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId !== undefined) {
        try {
          await chrome.windows.update(existing.windowId, { focused: true });
        } catch {
          // Activating the tab is sufficient when window focus is blocked.
        }
      }
      return { ok: true };
    }
  } catch {
    // If URL lookup is unavailable, still try creating the dedicated page.
  }

  try {
    const created = await chrome.tabs.create({ url: onboardingUrl, active: true });
    if (created.id !== undefined) {
      onboardingTabId = created.id;
      return { ok: true };
    }
  } catch {
    // Fall through to the actionable message below.
  }

  return {
    ok: false,
    error: '無法開啟首次登入提示分頁，請重新整理後再試。',
  };
}

async function handleActivateFuture(): Promise<ActivateFutureResponse> {
  const sourceTabId = onboardingSourceTabId;
  if (sourceTabId === null) {
    return { ok: false, error: '請從 Wiki 編輯頁開啟首次登入提示，才能使用 Future 模式。' };
  }

  try {
    const sourceTab = await chrome.tabs.get(sourceTabId);
    await chrome.tabs.update(sourceTabId, { active: true });
    if (sourceTab.windowId !== undefined) {
      try {
        await chrome.windows.update(sourceTab.windowId, { focused: true });
      } catch {
        // Activating the tab is sufficient when window focus is blocked.
      }
    }
    const response = await chrome.tabs.sendMessage(sourceTabId, { type: 'fwa:activate-future' });
    return (response as ActivateFutureResponse | undefined) ?? {
      ok: false,
      error: '目前 Wiki 編輯頁無法開啟 Future 模式，請重新整理後再試。',
    };
  } catch {
    return { ok: false, error: '找不到原本的 Wiki 編輯頁，請重新整理後再試。' };
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  switch (message.type) {
    case 'fwa:open-settings':
      void chrome.runtime
        .openOptionsPage()
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    case 'fwa:open-onboarding':
      void handleOpenOnboarding(sender).then(sendResponse);
      return true;
    case 'fwa:close-onboarding':
      if (sender.tab?.id !== undefined) {
        if (sender.tab.id === onboardingTabId) {
          onboardingTabId = null;
          onboardingSourceTabId = null;
        }
        void chrome.tabs.remove(sender.tab.id).catch(() => undefined);
      }
      sendResponse({ ok: true });
      return false;
    case 'fwa:activate-future':
      void handleActivateFuture().then(sendResponse);
      return true;
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

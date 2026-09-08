import { wikiConfig } from '../config/wiki-config';
import type { RuntimeMessage } from '../shared/messages';
import { getSettings, onStorageChanged, STORAGE_KEYS } from '../shared/storage';
import { seedDefaultTemplatesIfEmpty } from '../templates/template-service';
import { AiLayoutFeature } from './ai-layout';
import { createAdapter, detectEditor, type EditorAdapter } from './editor-adapter';
import { WikiDocumentSync } from './document-sync';
import { FormattingMenu } from './formatting-menu';
import { HybridPreviewFeature } from './hybrid-preview';
import { ImageDropHandler } from './image-drop';
import { MainNav } from './main-nav';
import { maybeShowOnboarding } from './onboarding';
import { PageObserver } from './page-observer';
import { SidebarAppearance } from './sidebar-appearance';
import { TemplatePanel } from './template-panel';

/**
 * Content script entry point. Only injected on the wiki origin declared in
 * manifest.json.
 *
 * MainNav (檢閱照片/頁面拓譜/客戶) is mounted once and lives for the whole
 * content-script lifetime — it doesn't depend on an editor being present.
 * FormattingMenu, ImageDropHandler and TemplatePanel are editor-only: they
 * mount/unmount as the Markdown editor (re-)detects across SPA navigation.
 */

let currentEditorEl: HTMLElement | null = null;
let features: Array<{ detach(): void }> = [];
let initializing = false;
let debugMode = false;
let mainNav: MainNav | null = null;
let sidebarAppearance: SidebarAppearance | null = null;
let pageObserver: PageObserver | null = null;
let currentHybridPreview: HybridPreviewFeature | null = null;
// mount() re-entrancy: calls that arrive while a mount is awaiting are queued
// (not dropped), and teardown() invalidates any in-flight mount so it never
// finishes attaching features built from a pre-teardown settings snapshot.
let remountQueued = false;
let mountEpoch = 0;

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.type !== 'fwa:activate-future') return false;
  void (async () => {
    const activated = await currentHybridPreview?.activateFutureMode() ?? false;
    sendResponse({
      ok: activated,
      ...(activated ? {} : { error: '目前 Wiki 編輯頁尚未準備好 Future 模式。' }),
    });
  })();
  return true;
});

function debug(...args: unknown[]): void {
  // Never logs tokens, cookies or article content — only lifecycle info.
  if (debugMode) console.debug('[FWA]', ...args);
}

function teardown(): void {
  mountEpoch++;
  currentHybridPreview = null;
  for (const f of features) {
    try {
      f.detach();
    } catch {
      /* already detached */
    }
  }
  features = [];
  currentEditorEl = null;
  mainNav?.setTemplatePanel(null);
  mainNav?.setAiLayout(null);
}

async function mount(): Promise<void> {
  if (initializing) {
    remountQueued = true;
    return;
  }
  initializing = true;
  try {
    if (!wikiConfig.editor.editPagePattern.test(location.pathname)) {
      if (currentEditorEl) {
        debug('left editor route, tearing down');
        teardown();
      }
      return;
    }
    const detected = detectEditor();
    if (!detected) {
      if (currentEditorEl) {
        debug('editor removed, tearing down');
        teardown();
      }
      return;
    }
    if (detected.element === currentEditorEl) return; // already mounted

    teardown();
    const epoch = mountEpoch;
    let settings;
    try {
      settings = await getSettings();
    } catch (err) {
      if (!chrome.runtime?.id) {
        // Extension reloaded/updated: this orphaned script can never reach
        // chrome.storage again. Stop observing instead of rejecting on every
        // future mutation until the page is refreshed.
        pageObserver?.stop();
        teardown();
        return;
      }
      debug('getSettings failed', err instanceof Error ? err.message : err);
      return;
    }
    if (epoch !== mountEpoch) {
      remountQueued = true; // torn down while awaiting — retry with fresh state
      return;
    }
    debugMode = settings.debugMode;
    debug('editor detected:', detected.kind);

    let adapter: EditorAdapter;
    try {
      adapter = await createAdapter(detected);
    } catch (err) {
      debug('adapter init failed', err instanceof Error ? err.message : err);
      return;
    }
    if (epoch !== mountEpoch) {
      remountQueued = true;
      return;
    }
    currentEditorEl = detected.element;

    const documentSync = new WikiDocumentSync(adapter, { debug: settings.debugMode });

    let imageDrop: ImageDropHandler | null = null;
    if (settings.enableImageDrop || settings.enableClipboardImage) {
      imageDrop = new ImageDropHandler(adapter, settings, documentSync);
      imageDrop.attach();
      features.push(imageDrop);
    }

    const hybridPreview = new HybridPreviewFeature(adapter, settings, imageDrop, documentSync);
    hybridPreview.attach();
    currentHybridPreview = hybridPreview;
    features.push(hybridPreview);

    if (settings.enableFormattingMenu) {
      const menu = new FormattingMenu(adapter, settings, documentSync);
      menu.attach();
      features.push(menu);
    }
    const panel = new TemplatePanel(adapter, documentSync);
    features.push(panel);
    mainNav?.setTemplatePanel(panel);

    const aiLayout = new AiLayoutFeature(
      adapter,
      () => hybridPreview.prepareExternalEditorAction(),
      () => hybridPreview.getVisualSelection(),
      documentSync,
    );
    features.push(aiLayout);
    mainNav?.setAiLayout(aiLayout);
    // Detach the shared sync controller after the editor features have
    // flushed their pending visual work during teardown.
    features.push(documentSync);
    debug('features mounted');
  } finally {
    initializing = false;
    if (remountQueued) {
      remountQueued = false;
      void mount();
    }
  }
}

/** Settings that only change how existing UI is painted. They are applied via
 * the cheap refresh paths below — remounting the whole feature stack for them
 * would tear down the editor features ~10×/second while the color picker's
 * debounced saves stream in during a drag. */
const APPEARANCE_ONLY_SETTINGS = new Set(['sidebarColor', 'sidebarGradientColor', 'showPet', 'petPosition', 'customersPanelOpen']);

function needsFeatureRemount(change: chrome.storage.StorageChange | undefined): boolean {
  if (!change) return true;
  const before = (change.oldValue ?? {}) as Record<string, unknown>;
  const after = (change.newValue ?? {}) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (APPEARANCE_ONLY_SETTINGS.has(key)) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) return true;
  }
  return false;
}

function startFeatures(): void {
  void seedDefaultTemplatesIfEmpty();

  mainNav = new MainNav();
  mainNav.attach();
  void maybeShowOnboarding();

  void mount();

  pageObserver = new PageObserver(() => void mount());
  pageObserver.start();

  // Re-mount features when the user changes settings.
  onStorageChanged((keys, changes) => {
    if (!keys.includes(STORAGE_KEYS.settings)) return;
    void sidebarAppearance?.refresh();
    void mainNav?.refreshSidebarColorControl();
    if (!needsFeatureRemount(changes[STORAGE_KEYS.settings])) return;
    teardown();
    void mount();
  });
}

function main(): void {
  if (location.origin !== wikiConfig.origin) {
    // Defense in depth: manifest matches should already guarantee this.
    return;
  }
  if (!document.documentElement) {
    // document_start can run before the parser has created <html>. Defer the
    // complete bootstrap so one missing DOM root cannot disable every feature.
    document.addEventListener('DOMContentLoaded', main, { once: true });
    return;
  }

  // The script runs at document_start so the saved sidebar color is applied
  // before the page's first paint. Everything else needs the DOM and waits
  // for DOMContentLoaded.
  sidebarAppearance = new SidebarAppearance();
  sidebarAppearance.attach();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startFeatures, { once: true });
  } else {
    startFeatures();
  }
}

main();

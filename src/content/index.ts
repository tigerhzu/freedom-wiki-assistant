import { wikiConfig } from '../config/wiki-config';
import { getSettings, onStorageChanged, STORAGE_KEYS } from '../shared/storage';
import { seedDefaultTemplatesIfEmpty } from '../templates/template-service';
import { AiLayoutFeature } from './ai-layout';
import { createAdapter, detectEditor, type EditorAdapter } from './editor-adapter';
import { FormattingMenu } from './formatting-menu';
import { ImageDropHandler } from './image-drop';
import { MainNav } from './main-nav';
import { PageObserver } from './page-observer';
import { SidebarAppearance } from './sidebar-appearance';
import { TemplatePanel } from './template-panel';

/**
 * Content script entry point. Only injected on the wiki origin declared in
 * manifest.json.
 *
 * MainNav (模板/檢閱照片/客戶) is mounted once and lives for the whole
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

function debug(...args: unknown[]): void {
  // Never logs tokens, cookies or article content — only lifecycle info.
  if (debugMode) console.debug('[FWA]', ...args);
}

function teardown(): void {
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
  if (initializing) return;
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
    const settings = await getSettings();
    debugMode = settings.debugMode;
    debug('editor detected:', detected.kind);

    let adapter: EditorAdapter;
    try {
      adapter = await createAdapter(detected);
    } catch (err) {
      debug('adapter init failed', err instanceof Error ? err.message : err);
      return;
    }
    currentEditorEl = detected.element;

    if (settings.enableFormattingMenu) {
      const menu = new FormattingMenu(adapter, settings);
      menu.attach();
      features.push(menu);
    }
    if (settings.enableImageDrop || settings.enableClipboardImage) {
      const drop = new ImageDropHandler(adapter, settings);
      drop.attach();
      features.push(drop);
    }
    const panel = new TemplatePanel(adapter);
    features.push(panel);
    mainNav?.setTemplatePanel(panel);

    const aiLayout = new AiLayoutFeature(adapter);
    features.push(aiLayout);
    mainNav?.setAiLayout(aiLayout);
    debug('features mounted');
  } finally {
    initializing = false;
  }
}

function main(): void {
  if (location.origin !== wikiConfig.origin) {
    // Defense in depth: manifest matches should already guarantee this.
    return;
  }
  void seedDefaultTemplatesIfEmpty();

  mainNav = new MainNav();
  mainNav.attach();
  sidebarAppearance = new SidebarAppearance();
  sidebarAppearance.attach();

  void mount();

  const observer = new PageObserver(() => void mount());
  observer.start();

  // Re-mount features when the user changes settings.
  onStorageChanged((keys) => {
    if (keys.includes(STORAGE_KEYS.settings)) {
      void sidebarAppearance?.refresh();
      teardown();
      void mount();
    }
  });
}

main();

import { getSettings, saveSettings } from '../shared/storage';
import type { Settings } from '../shared/types';
import { exportTemplates, importTemplates } from '../templates/template-service';
import {
  defaultSidebarGradientEnd,
  mixHex,
  normalizeSidebarColor,
  readableGradientTextColor,
  resolveSidebarGradientEnd,
  SIDEBAR_COLOR_PRESETS,
} from '../content/sidebar-appearance';

/** Options page logic: bind form ↔ chrome.storage.local settings. */

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const statusEl = $('status');
let statusTimer: number | undefined;

function flashStatus(msg: string): void {
  statusEl.textContent = msg;
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => (statusEl.textContent = ''), 2500);
}

let settings: Settings;
let sidebarPersistTimer: number | undefined;

function renderSwatches(): void {
  const list = $('swatch-list');
  list.replaceChildren();
  for (const color of settings.customSwatches) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'swatch';
    dot.style.background = color;
    dot.title = `${color}（點擊移除）`;
    dot.addEventListener('click', () => {
      settings.customSwatches = settings.customSwatches.filter((c) => c !== color);
      void persist();
      renderSwatches();
    });
    list.appendChild(dot);
  }
}

async function persist(): Promise<void> {
  await saveSettings(settings);
  flashStatus('已儲存');
}

function renderSidebarColor(): void {
  const preview = $<HTMLElement>('sidebarPreview');
  const textInput = $<HTMLInputElement>('sidebarColor');
  const picker = $<HTMLInputElement>('sidebarColorPicker');
  const gradientInput = $<HTMLInputElement>('sidebarGradientColor');
  const gradientPicker = $<HTMLInputElement>('sidebarGradientColorPicker');
  const color = normalizeSidebarColor(settings.sidebarColor) ?? '#1976d2';
  const gradientEnd = resolveSidebarGradientEnd(color, settings.sidebarGradientColor);
  const text = readableGradientTextColor(color, gradientEnd);
  const headerStart = mixHex(color, '#000000', 0.14);
  const headerEnd = mixHex(gradientEnd, '#000000', 0.14);

  preview.style.setProperty(
    '--preview-gradient',
    `linear-gradient(155deg, ${color} 0%, ${gradientEnd} 100%)`,
  );
  preview.style.setProperty(
    '--preview-header-gradient',
    `linear-gradient(115deg, ${headerStart} 0%, ${headerEnd} 100%)`,
  );
  preview.style.setProperty('--preview-button', mixHex(color, text === '#ffffff' ? '#ffffff' : '#000000', 0.08));
  preview.style.setProperty('--preview-text', text);
  textInput.value = settings.sidebarColor;
  picker.value = color;
  gradientInput.value = settings.sidebarGradientColor || gradientEnd;
  gradientPicker.value = gradientEnd;

  for (const swatch of document.querySelectorAll<HTMLElement>('.sidebar-color-swatch')) {
    swatch.classList.toggle('active', swatch.dataset.color === normalizeSidebarColor(settings.sidebarColor));
  }
}

function scheduleSidebarPersist(): void {
  window.clearTimeout(sidebarPersistTimer);
  sidebarPersistTimer = window.setTimeout(() => void persist(), 100);
}

function setSidebarColor(value: string, saveImmediately = true): void {
  const color = normalizeSidebarColor(value);
  if (!color) return;
  const previous = normalizeSidebarColor(settings.sidebarColor);
  const currentSecondary = normalizeSidebarColor(settings.sidebarGradientColor);
  const secondaryWasAutomatic =
    !currentSecondary || (previous ? currentSecondary === defaultSidebarGradientEnd(previous) : true);
  settings.sidebarColor = color;
  if (secondaryWasAutomatic) settings.sidebarGradientColor = defaultSidebarGradientEnd(color);
  renderSidebarColor();
  if (saveImmediately) scheduleSidebarPersist();
}

function setSidebarGradientColor(value: string): void {
  const color = normalizeSidebarColor(value);
  if (!color) return;
  settings.sidebarGradientColor = color;
  renderSidebarColor();
  scheduleSidebarPersist();
}

function bindSidebarColor(): void {
  const presets = $('sidebar-color-presets');
  for (const color of SIDEBAR_COLOR_PRESETS) {
    const gradientEnd = defaultSidebarGradientEnd(color);
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'sidebar-color-swatch';
    swatch.dataset.color = color;
    swatch.style.setProperty('--sw', color);
    swatch.style.setProperty('--sw-end', gradientEnd);
    swatch.title = `${color} → ${gradientEnd}`;
    swatch.setAttribute('aria-label', `套用 ${color} 漸層`);
    swatch.addEventListener('click', () => {
      settings.sidebarColor = color;
      settings.sidebarGradientColor = gradientEnd;
      renderSidebarColor();
      scheduleSidebarPersist();
    });
    presets.appendChild(swatch);
  }

  const picker = $<HTMLInputElement>('sidebarColorPicker');
  picker.addEventListener('input', () => setSidebarColor(picker.value));

  const textInput = $<HTMLInputElement>('sidebarColor');
  textInput.addEventListener('input', () => {
    const color = normalizeSidebarColor(textInput.value);
    if (color) setSidebarColor(color);
  });
  textInput.addEventListener('change', () => {
    if (!normalizeSidebarColor(textInput.value)) {
      flashStatus('顏色格式錯誤，請輸入 #RGB 或 #RRGGBB');
      renderSidebarColor();
    }
  });

  const gradientPicker = $<HTMLInputElement>('sidebarGradientColorPicker');
  gradientPicker.addEventListener('input', () => setSidebarGradientColor(gradientPicker.value));

  const gradientInput = $<HTMLInputElement>('sidebarGradientColor');
  gradientInput.addEventListener('input', () => {
    const color = normalizeSidebarColor(gradientInput.value);
    if (color) setSidebarGradientColor(color);
  });
  gradientInput.addEventListener('change', () => {
    if (!normalizeSidebarColor(gradientInput.value)) {
      flashStatus('漸層色格式錯誤，請輸入 #RGB 或 #RRGGBB');
      renderSidebarColor();
    }
  });

  $('resetSidebarColor').addEventListener('click', () => {
    settings.sidebarColor = '';
    settings.sidebarGradientColor = '';
    renderSidebarColor();
    scheduleSidebarPersist();
  });

  renderSidebarColor();
}

function bindCheckbox(id: keyof Settings & string): void {
  const input = $<HTMLInputElement>(id);
  input.checked = settings[id] as boolean;
  input.addEventListener('change', () => {
    (settings as unknown as Record<string, unknown>)[id] = input.checked;
    void persist();
  });
}

function bindText(id: keyof Settings & string): void {
  const input = $<HTMLInputElement>(id);
  input.value = settings[id] as string;
  input.addEventListener('change', () => {
    (settings as unknown as Record<string, unknown>)[id] = input.value.trim();
    void persist();
  });
}

function bindEditorMode(): void {
  const select = $<HTMLSelectElement>('editorMode');
  select.value = settings.editorMode;
  select.addEventListener('change', () => {
    settings.editorMode = select.value as Settings['editorMode'];
    void persist();
  });
}

function bindAzureSettings(): void {
  bindText('azureEndpoint');
  bindText('azureDeployment');
  bindText('azureApiVersion');
  bindText('azureApiKey');

  const keyInput = $<HTMLInputElement>('azureApiKey');
  const toggle = $<HTMLButtonElement>('toggleAzureApiKey');
  toggle.addEventListener('click', () => {
    const isPassword = keyInput.type === 'password';
    keyInput.type = isPassword ? 'text' : 'password';
    toggle.textContent = isPassword ? '隱藏' : '顯示';
  });
}

function bindFolderStrategy(): void {
  const radios = [
    $<HTMLInputElement>('folderStrategyCurrentPath'),
    $<HTMLInputElement>('folderStrategyParentFolder'),
    $<HTMLInputElement>('folderStrategyManual'),
  ];
  for (const radio of radios) {
    radio.checked = radio.value === settings.folderStrategy;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      settings.folderStrategy = radio.value as Settings['folderStrategy'];
      void persist();
    });
  }
}

async function init(): Promise<void> {
  settings = await getSettings();

  bindEditorMode();
  bindCheckbox('enableFormattingMenu');
  bindCheckbox('enableImageDrop');
  bindCheckbox('enableClipboardImage');
  bindCheckbox('debugMode');
  bindFolderStrategy();
  bindText('defaultImageFolder');
  bindText('imageMarkdownFormat');
  bindText('defaultTextColor');
  bindAzureSettings();
  bindSidebarColor();
  renderSwatches();

  $('addSwatch').addEventListener('click', () => {
    const input = $<HTMLInputElement>('newSwatch');
    const v = input.value.trim().toLowerCase();
    if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(v)) {
      flashStatus('色票格式錯誤，請輸入 #rrggbb');
      return;
    }
    if (!settings.customSwatches.includes(v)) {
      settings.customSwatches.push(v);
      void persist();
      renderSwatches();
    }
    input.value = '';
  });

  $('exportTemplates').addEventListener('click', async () => {
    const json = await exportTemplates();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fwa-templates-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    flashStatus('模板已匯出');
  });

  const pickAndImport = (mode: 'merge' | 'replace') => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const count = await importTemplates(await file.text(), mode);
        flashStatus(mode === 'replace' ? `已還原 ${count} 個模板` : `已匯入 ${count} 個模板`);
      } catch (err) {
        flashStatus(`匯入失敗：${err instanceof Error ? err.message : String(err)}`);
      }
    });
    input.click();
  };
  $('importTemplates').addEventListener('click', () => pickAndImport('merge'));
  $('restoreTemplates').addEventListener('click', () => pickAndImport('replace'));
}

void init();

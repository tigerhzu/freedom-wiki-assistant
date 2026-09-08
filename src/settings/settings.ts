import { getSettings, onStorageChanged, saveSettings, STORAGE_KEYS } from '../shared/storage';
import {
  DEFAULT_SETTINGS,
  ORNITH_DEFAULT_BASE_URL,
  ORNITH_DEFAULT_MODEL,
  type AiProvider,
  type Settings,
} from '../shared/types';
import {
  defaultSidebarGradientEnd,
  mixHex,
  normalizeSidebarColor,
  readableGradientTextColor,
  resolveSidebarGradientEnd,
  SIDEBAR_COLOR_PRESETS,
} from '../content/sidebar-appearance';
import { exportFullSettings, importFullSettings } from './settings-backup';

/** Options page logic: bind form ↔ chrome.storage.local settings. */

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const statusEl = $('status');
let statusTimer: number | undefined;

function flashStatus(msg: string, state: 'saved' | 'changed' | 'error' = 'saved'): void {
  statusEl.textContent = msg;
  statusEl.dataset.state = state;
  window.clearTimeout(statusTimer);
  if (state === 'saved') {
    statusTimer = window.setTimeout(() => (statusEl.textContent = '所有變更已儲存'), 3000);
  }
}

let settings: Settings;
let sidebarPersistTimer: number | undefined;

async function persist(): Promise<void> {
  flashStatus('正在儲存…', 'changed');
  try {
    await saveSettings({ ...settings });
    flashStatus('已儲存至此瀏覽器');
  } catch (error) {
    flashStatus(`儲存失敗：${error instanceof Error ? error.message : String(error)}`, 'error');
  }
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
    const active = swatch.dataset.color === normalizeSidebarColor(settings.sidebarColor);
    swatch.classList.toggle('active', active);
    swatch.setAttribute('aria-pressed', String(active));
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
      flashStatus('顏色格式錯誤，請輸入 #RGB 或 #RRGGBB', 'error');
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
      flashStatus('漸層色格式錯誤，請輸入 #RGB 或 #RRGGBB', 'error');
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

function bindBooleanPreferences(): void {
  const keys = ['showPet', 'enableFormattingMenu', 'enableImageDrop', 'enableClipboardImage'] as const;
  for (const key of keys) {
    const input = $<HTMLInputElement>(key);
    input.checked = settings[key];
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      void persist();
    });
  }
}

function syncPetPreferences(): void {
  onStorageChanged((keys, changes) => {
    if (!keys.includes(STORAGE_KEYS.settings)) return;
    const next = changes[STORAGE_KEYS.settings]?.newValue as Partial<Settings> | undefined;
    if (!next) return;
    // Pet actions also live on Wiki pages. Keep these fields current without
    // replacing other preferences while the user is editing this form.
    settings.showPet = next.showPet ?? DEFAULT_SETTINGS.showPet;
    settings.petPosition = next.petPosition ?? DEFAULT_SETTINGS.petPosition;
    $<HTMLInputElement>('showPet').checked = settings.showPet;
  });
}

function bindNavigation(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"][data-pane]')];
  const activate = (tab: HTMLButtonElement): void => {
    for (const candidate of tabs) {
      const selected = candidate === tab;
      candidate.setAttribute('aria-selected', String(selected));
      candidate.tabIndex = selected ? 0 : -1;
      $(`pane-${candidate.dataset.pane}`).hidden = !selected;
    }
    // The hash also makes individual settings sections directly linkable.
    window.history.replaceState(null, '', `#${tab.dataset.pane}`);
  };
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (event) => {
      let target: number | undefined;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') target = (index + 1) % tabs.length;
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') target = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') target = 0;
      if (event.key === 'End') target = tabs.length - 1;
      if (target === undefined) return;
      event.preventDefault();
      activate(tabs[target]);
      tabs[target].focus();
    });
  }
  const fromHash = (): void => activate(tabs.find((tab) => `#${tab.dataset.pane}` === window.location.hash) ?? tabs[0]);
  window.addEventListener('hashchange', fromHash);
  fromHash();
  const media = window.matchMedia('(max-width: 800px)');
  const updateOrientation = (): void => {
    document.querySelector('[role="tablist"]')?.setAttribute('aria-orientation', media.matches ? 'horizontal' : 'vertical');
  };
  media.addEventListener('change', updateOrientation);
  updateOrientation();
  // Fields save on commit (blur / Enter); keep pending edits visible meanwhile.
  document.querySelectorAll<HTMLInputElement>('.settings-pane input').forEach((input) => {
    input.addEventListener('input', () => flashStatus('尚有變更 · 完成輸入後自動儲存', 'changed'));
  });
}

function confirmSettingsAction(title: string, description: string, action: string): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('settingsConfirm');
  $('confirmTitle').textContent = title;
  $('confirmDescription').textContent = description;
  $('confirmProceed').textContent = action;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

function bindApiKeyToggle(inputId: string, toggleId: string): void {
  const keyInput = $<HTMLInputElement>(inputId);
  const toggle = $<HTMLButtonElement>(toggleId);
  toggle.addEventListener('click', () => {
    const isPassword = keyInput.type === 'password';
    keyInput.type = isPassword ? 'text' : 'password';
    toggle.textContent = isPassword ? '隱藏' : '顯示';
  });
}

const AI_TEXT_FIELDS = [
  'ornithBaseUrl',
  'ornithModel',
  'ornithApiKey',
  'azureEndpoint',
  'azureDeployment',
  'azureApiVersion',
  'azureApiKey',
] as const satisfies ReadonlyArray<keyof Settings & string>;

function lockedProvider(): Exclude<AiProvider, ''> | '' {
  if (settings.ornithApiKey.trim()) return 'ornith';
  if (settings.azureApiKey.trim()) return 'azure';
  return '';
}

function renderAiSettings(): void {
  const locked = lockedProvider();
  const providerRadios = [
    $<HTMLInputElement>('aiProviderOrnith'),
    $<HTMLInputElement>('aiProviderAzure'),
  ];
  for (const radio of providerRadios) {
    radio.checked = radio.value === settings.aiProvider;
    radio.disabled = !!locked && radio.value !== locked;
  }

  $<HTMLFieldSetElement>('ornithSettings').disabled = settings.aiProvider !== 'ornith';
  $<HTMLFieldSetElement>('azureSettings').disabled = settings.aiProvider !== 'azure';
  $('ornithSettings').hidden = settings.aiProvider !== 'ornith';
  $('azureSettings').hidden = settings.aiProvider !== 'azure';
  $<HTMLElement>('providerLockStatus').textContent = locked
    ? `目前已儲存 ${locked === 'ornith' ? 'Local Ornith' : 'Azure OpenAI'} API Key；若要切換，請先移除此 Provider 設定。`
    : settings.aiProvider
      ? '填入設定後會儲存在此瀏覽器本機。'
      : '請先選擇一個 Provider。';
}

function syncAiInputs(): void {
  for (const id of AI_TEXT_FIELDS) $<HTMLInputElement>(id).value = settings[id];
}

function bindAiSettings(): void {
  syncAiInputs();
  for (const id of AI_TEXT_FIELDS) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener('change', async () => {
      settings[id] = input.value.trim();
      await persist();
      renderAiSettings();
    });
  }

  const providerRadios = [
    $<HTMLInputElement>('aiProviderOrnith'),
    $<HTMLInputElement>('aiProviderAzure'),
  ];
  for (const radio of providerRadios) {
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      const locked = lockedProvider();
      if (locked && locked !== radio.value) {
        flashStatus('請先移除目前 Provider 設定');
        renderAiSettings();
        return;
      }
      settings.aiProvider = radio.value as Exclude<AiProvider, ''>;
      await persist();
      renderAiSettings();
    });
  }

  bindApiKeyToggle('ornithApiKey', 'toggleOrnithApiKey');
  bindApiKeyToggle('azureApiKey', 'toggleAzureApiKey');

  $<HTMLButtonElement>('removeOrnithSettings').addEventListener('click', async () => {
    settings.ornithBaseUrl = ORNITH_DEFAULT_BASE_URL;
    settings.ornithModel = ORNITH_DEFAULT_MODEL;
    settings.ornithApiKey = '';
    if (settings.aiProvider === 'ornith') settings.aiProvider = '';
    syncAiInputs();
    await persist();
    renderAiSettings();
  });

  $<HTMLButtonElement>('removeAzureSettings').addEventListener('click', async () => {
    settings.azureEndpoint = '';
    settings.azureDeployment = '';
    settings.azureApiKey = '';
    settings.azureApiVersion = DEFAULT_SETTINGS.azureApiVersion;
    if (settings.aiProvider === 'azure') settings.aiProvider = '';
    syncAiInputs();
    await persist();
    renderAiSettings();
  });

  renderAiSettings();
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

async function downloadFullSettings(includeApiKey: boolean): Promise<void> {
  try {
    if (includeApiKey && !(await confirmSettingsAction(
      '將 API 金鑰一起備份？',
      '這份 JSON 檔案會包含你的 API 金鑰。任何取得檔案的人都可能使用對應的 AI 服務，請將備份保存在私人位置。',
      '下載含金鑰的備份',
    ))) return;
    const json = await exportFullSettings({ includeApiKey });
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = includeApiKey
      ? `fwa-settings-${new Date().toISOString().slice(0, 10)}.json`
      : `fwa-settings-no-api-key-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    flashStatus(includeApiKey ? '完整設定（含 API Key）已匯出' : '完整設定（不含 API Key）已匯出');
  } catch (err) {
    flashStatus(`匯出失敗：${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

async function init(): Promise<void> {
  settings = await getSettings();

  bindNavigation();
  bindBooleanPreferences();
  syncPetPreferences();
  bindFolderStrategy();
  bindAiSettings();
  bindSidebarColor();

  $('exportFullSettings').addEventListener('click', () => void downloadFullSettings(true));
  $('exportSettingsWithoutApiKey').addEventListener('click', () => void downloadFullSettings(false));

  $('importFullSettings').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        if (!(await confirmSettingsAction(
          '用備份還原工作空間？',
          `「${file.name}」將取代目前的設定、客戶、資料夾與模板。若想保留現況，請取消並先下載一份備份。`,
          '還原這份備份',
        ))) return;
        const result = await importFullSettings(await file.text());
        flashStatus(`已還原設定：${result.customerCount} 位客戶、${result.templateCount} 個模板`);
        window.setTimeout(() => window.location.reload(), 400);
      } catch (err) {
        flashStatus(`匯入失敗：${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    });
    input.click();
  });
}

void init().catch((error) => flashStatus(`無法載入設定：${error instanceof Error ? error.message : String(error)}`, 'error'));

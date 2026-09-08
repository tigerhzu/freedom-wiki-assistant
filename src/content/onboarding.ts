import { wikiConfig } from '../config/wiki-config';
import { sendMessage, type ActivateFutureResponse } from '../shared/messages';
import { getSettings, saveSettings } from '../shared/storage';
import { ORNITH_DEFAULT_BASE_URL, ORNITH_DEFAULT_MODEL, type AiProvider, type Settings } from '../shared/types';
import { el, openModal, type ModalHandle } from './ui';

/** Increment this whenever the onboarding content or sequence changes. */
export const ONBOARDING_VERSION = 8;

const ONBOARDING_PAGE_MARKER = 'data-fwa-onboarding-page';

interface OnboardingStep {
  label: string;
  title: string;
  hint: string;
  showHeading?: boolean;
  render(settings: Settings, context: OnboardingRenderContext): HTMLElement;
  save?(section: HTMLElement): Promise<Partial<Settings> | null>;
}

interface OnboardingRenderContext {
  requestFutureMode(): void;
}

const steps: OnboardingStep[] = [
  {
    label: 'Pet 與客戶',
    title: 'Pet 與客戶捷徑',
    hint: '點擊 Pet 開啟客戶懸浮視窗。Pet 可拖曳移動，或在「設定 → 外觀」選擇顯示與隱藏。',
    render: renderCustomerStep,
  },
  {
    label: '連接 AI',
    title: '連接 AI 排版服務',
    hint: '選擇你的 AI 服務，或先略過。沒有 API 金鑰也能使用所有一般編輯工具。',
    render: renderApiStep,
    save: saveApiStep,
  },
  {
    label: '開始編輯',
    title: '試用視覺編輯',
    hint: '試著修改下方的示範內容，再切換原始碼查看。實際文章請使用 Wiki 的「儲存」按鈕保存。',
    render: (_settings, context) => renderEditorStep(context.requestFutureMode),
  },
];

let activeOnboarding: ModalHandle | null = null;
let openingOnboarding = false;

export async function maybeShowOnboarding(): Promise<void> {
  try {
    const settings = await getSettings();
    if (settings.onboardingVersion >= ONBOARDING_VERSION) return;
    await sendMessage({ type: 'fwa:open-onboarding' });
  } catch (error) {
    console.warn('[FWA] 無法開啟Wiki 使用指南分頁', error);
  }
}

function isOnboardingPage(): boolean {
  return document.documentElement.getAttribute(ONBOARDING_PAGE_MARKER) === 'true';
}

function closeOnboardingPage(): void {
  if (!isOnboardingPage()) return;
  void sendMessage({ type: 'fwa:close-onboarding' }).catch(() => window.close());
}

const WIKI_HOME_URL = `${wikiConfig.origin}/en/home`;

/** Open the guide on demand from the settings page, even after it was completed. */
export async function openOnboarding(force = false): Promise<boolean> {
  if (activeOnboarding || openingOnboarding) return true;
  openingOnboarding = true;

  try {
    let settings = await getSettings();
    const standalonePage = isOnboardingPage();
    if (!force && settings.onboardingVersion >= ONBOARDING_VERSION) {
      if (standalonePage) closeOnboardingPage();
      return false;
    }

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modal = openModal('Wiki 使用指南', 'fwa-onboarding-host', 'fwa-onboarding-modal', !standalonePage);
    activeOnboarding = modal;
    modal.layer.classList.add('fwa-onboarding-backdrop');
    if (standalonePage) modal.layer.classList.add('fwa-onboarding-page-layer');
    modal.element.setAttribute('role', 'dialog');
    modal.element.setAttribute('aria-modal', 'true');
    modal.element.setAttribute('aria-label', 'Wiki 使用指南');
    modal.element.removeAttribute('aria-labelledby');

    const close = el('button', {
      class: 'fwa-onboarding-close',
      type: 'button',
      'aria-label': '關閉 Wiki 使用指南',
      text: '×',
    });
    const header = modal.element.querySelector<HTMLElement>('.fwa-modal-header');
    header?.replaceChildren(el('div', { class: 'fwa-onboarding-header-title' }, [el('span', { class: 'fwa-studio-kicker', text: '開始使用 Wiki' })]), close);


    const progress = buildProgress();
    const content = el('div', { class: 'fwa-onboarding-step-stack' });
    const sections = steps.map((_step, index) => {
      const section = el('section', {
        class: 'fwa-onboarding-step',
      });
      if (_step.showHeading === false) section.setAttribute('aria-label', _step.title);
      else section.setAttribute('aria-labelledby', `fwa-onboarding-step-title-${index}`);
      content.append(section);
      return section;
    });
    const status = el('div', {
      class: 'fwa-onboarding-status',
      role: 'status',
      'aria-live': 'polite',
    });
    modal.body.replaceChildren(progress, content, status);

    const previous = el('button', { class: 'fwa-btn', type: 'button', text: '上一步' });
    const skip = el('button', { class: 'fwa-btn', type: 'button', text: '略過這一步' });
    const next = el('button', { class: 'fwa-btn fwa-btn-primary', type: 'button', text: '下一步 →' });
    previous.setAttribute('aria-label', '回到上一步');
    skip.setAttribute('aria-label', '略過目前這一步');
    next.setAttribute('aria-label', '儲存目前設定並前往下一步');
    modal.footer.setAttribute('aria-label', 'Wiki 使用指南操作');
    modal.footer.append(previous, skip, next);

    let currentStep = 0;
    let busy = false;
    let futureActivating = false;
    let finalizing = false;
    let completionShown = false;
    let closing = false;

    const setStatus = (message = '', isError = false): void => {
      status.textContent = message;
      status.classList.toggle('is-error', isError);
    };

    const persistPatch = async (patch: Partial<Settings>): Promise<void> => {
      // Re-read immediately before saving so onboarding only merges its own
      // fields into the latest settings instead of replacing other settings.
      const latest = await getSettings();
      const merged = { ...latest, ...patch };
      await saveSettings(merged);
      settings = await getSettings();
    };

    const requestFutureMode = (): void => {
      if (futureActivating || finalizing || completionShown) return;
      futureActivating = true;
      previous.disabled = true;
      skip.disabled = true;
      next.disabled = true;
      setStatus('正在開啟視覺編輯…');
      void sendMessage({ type: 'fwa:activate-future' })
        .then(async (rawResponse) => {
          const response = rawResponse as ActivateFutureResponse | undefined;
          if (!response?.ok) {
            setStatus(response?.error ?? '目前無法開啟視覺編輯，請重新整理後再試。', true);
            return;
          }
          await persistPatch({ onboardingVersion: ONBOARDING_VERSION });
          closing = true;
          modal.close();
          closeOnboardingPage();
        })
        .catch((error) => {
          setStatus(`視覺編輯開啟失敗：${error instanceof Error ? error.message : String(error)}`, true);
        })
        .finally(() => {
          if (closing) return;
          futureActivating = false;
          previous.disabled = currentStep === 0 || busy;
          skip.disabled = busy;
          next.disabled = busy;
        });
    };

    const saveCurrentStep = async (): Promise<boolean> => {
      const save = steps[currentStep].save;
      if (!save) return true;
      const patch = await save(sections[currentStep]);
      if (patch === null) return false;
      if (Object.keys(patch).length > 0) await persistPatch(patch);
      return true;
    };

    const saveAndClose = async (showCompletion: boolean): Promise<void> => {
      if (finalizing || completionShown) return;
      finalizing = true;
      try {
        const optionalApiIsBlank = currentStep === 1
          && !sections[currentStep].querySelector<HTMLSelectElement>('#fwa-onboarding-ai-provider')?.value;
        if (!optionalApiIsBlank && !(await saveCurrentStep())) {
          finalizing = false;
          return;
        }
        await persistPatch({ onboardingVersion: ONBOARDING_VERSION });
        if (showCompletion) {
          completionShown = true;
          renderCompletionView();
          finalizing = false;
        } else {
          closing = true;
          modal.close();
          closeOnboardingPage();
        }
      } catch (error) {
        setStatus(`儲存失敗：${error instanceof Error ? error.message : String(error)}`, true);
        finalizing = false;
      }
    };

    const renderCompletionView = (): void => {
      modal.element.classList.add('fwa-onboarding-complete-modal');
      modal.body.replaceChildren(
        el('div', { class: 'fwa-onboarding-complete-view' }, [
          el('div', { class: 'fwa-onboarding-complete-icon', 'aria-hidden': 'true', text: '✓' }),
          el('h2', { tabindex: '-1', text: '設定完成' }),
          el('p', { text: '回到 Wiki 即可開始使用。之後可從設定重新開啟指南。' }),
          el('div', { class: 'fwa-onboarding-complete-actions' }, [
            (() => {
              const button = el('button', { class: 'fwa-btn fwa-btn-primary', type: 'button', text: '開啟完整設定' });
              button.addEventListener('click', () => {
                closing = true;
                void sendMessage({ type: 'fwa:open-settings' }).catch((error) => {
                  console.warn('[FWA] 無法開啟設定頁', error);
                });
                modal.close();
                closeOnboardingPage();
              });
              return button;
            })(),
            (() => {
              const button = el('button', { class: 'fwa-btn', type: 'button', text: '回到 Wiki 主頁' });
              button.addEventListener('click', () => {
                closing = true;
                modal.close();
                window.location.assign(WIKI_HOME_URL);
              });
              return button;
            })(),
          ]),
        ]),
      );
      modal.footer.replaceChildren();
      close.setAttribute('aria-label', '關閉完成提示');
      window.requestAnimationFrame(() => modal.element.querySelector<HTMLElement>('.fwa-onboarding-complete-view h2')?.focus({ preventScroll: true }));
    };

    const renderCurrentStep = (): void => {
      const step = steps[currentStep];
      sections.forEach((section, index) => {
        const isCurrent = index === currentStep;
        section.hidden = !isCurrent;
        if (!isCurrent) return;
        const stepContent: Node[] = [step.render(settings, { requestFutureMode })];
        if (step.showHeading !== false) {
          stepContent.unshift(
            el('h2', { id: `fwa-onboarding-step-title-${index}`, tabindex: '-1', text: step.title }),
            el('p', { class: 'fwa-onboarding-step-hint', text: step.hint }),
          );
        }
        section.replaceChildren(...stepContent);
      });
      progress.querySelectorAll<HTMLElement>('li').forEach((item, index) => {
        item.classList.toggle('is-current', index === currentStep);
        item.classList.toggle('is-complete', index < currentStep);
        if (index === currentStep) item.setAttribute('aria-current', 'step');
        else item.removeAttribute('aria-current');
      });
      modal.element.classList.toggle('fwa-onboarding-modal--guide', currentStep >= 2);
      previous.hidden = currentStep === 0;
      previous.disabled = currentStep === 0 || busy;
      skip.disabled = busy;
      next.disabled = busy;
      next.textContent = currentStep === steps.length - 1 ? '完成，開始使用' : currentStep === 1 ? '儲存並繼續 →' : '下一步 →';
      skip.textContent = currentStep === steps.length - 1 ? '略過並完成' : '略過這一步';
      next.setAttribute('aria-label', currentStep === steps.length - 1 ? '完成 Wiki 使用指南' : currentStep === 1 ? '儲存目前設定並前往下一步' : '前往下一步');
      skip.setAttribute('aria-label', currentStep === steps.length - 1 ? '略過導覽並完成 Wiki 使用指南' : '略過目前這一步');
      setStatus();
      window.requestAnimationFrame(() => modal.element.querySelector<HTMLElement>(`#fwa-onboarding-step-title-${currentStep}`)?.focus({ preventScroll: true }));
    };

    modal.onClose(() => {
      activeOnboarding = null;
      if (previousFocus?.isConnected) previousFocus.focus();
      if (!closing && !completionShown) {
        closing = true;
        void (async () => {
          try {
            await saveCurrentStep();
            await persistPatch({ onboardingVersion: ONBOARDING_VERSION });
          } catch (error) {
            console.warn('[FWA] 無法保存Wiki 使用指南狀態', error);
          }
        })();
      }
    });

    close.addEventListener('click', () => {
      if (completionShown) {
        closing = true;
        modal.close();
        closeOnboardingPage();
      } else {
        void saveAndClose(false);
      }
    });
    previous.addEventListener('click', () => {
      if (currentStep === 0 || busy) return;
      currentStep -= 1;
      renderCurrentStep();
    });
    skip.addEventListener('click', () => {
      if (busy) return;
      if (currentStep === steps.length - 1) {
        void saveAndClose(true);
        return;
      }
      currentStep += 1;
      renderCurrentStep();
    });
    next.addEventListener('click', () => {
      if (busy) return;
      busy = true;
      previous.disabled = true;
      skip.disabled = true;
      next.disabled = true;
      void (async () => {
        try {
          if (!(await saveCurrentStep())) {
            busy = false;
            previous.disabled = currentStep === 0;
            skip.disabled = false;
            next.disabled = false;
            return;
          }
          if (currentStep === steps.length - 1) {
            busy = false;
            await saveAndClose(true);
            return;
          }
          currentStep += 1;
          busy = false;
          renderCurrentStep();
        } catch (error) {
          setStatus(`儲存失敗：${error instanceof Error ? error.message : String(error)}`, true);
          busy = false;
          previous.disabled = currentStep === 0;
          skip.disabled = false;
          next.disabled = false;
        }
      })();
    });

    renderCurrentStep();
    return true;
  } finally {
    openingOnboarding = false;
  }
}

function buildProgress(): HTMLElement {
  const progress = el('ol', {
    class: 'fwa-onboarding-progress',
    'aria-label': 'Wiki 使用指南進度',
  });
  steps.forEach((step, index) => {
    progress.append(
      el('li', { class: index === 0 ? 'is-current' : '', 'aria-current': index === 0 ? 'step' : '' }, [
        el('span', { class: 'fwa-onboarding-progress-dot', 'aria-hidden': 'true', text: String(index + 1).padStart(2, '0') }),
        el('span', { class: 'fwa-onboarding-progress-label', text: step.label }),
      ]),
    );
  });
  return progress;
}

function renderCustomerStep(): HTMLElement {
  const items: Array<[string, string, string]> = [
    ['01', 'Pet 與客戶', '點擊 Pet 開啟客戶視窗，依資料夾整理捷徑、加入目前頁面，也可隱藏 Pet。'],
    ['02', '圖片與文件模板', '拖入或貼上圖片完成上傳；用模板快速開始一篇文件。'],
    ['03', '工作台與格式工具', '頂部工作台或 Ctrl / ⌘ + Shift + K 開啟工具。反白文字後按右鍵調整格式。'],
  ];
  const features = el('div', { class: 'fwa-studio-feature-grid' }, items.map(([number, title, copy]) =>
    el('article', { class: 'fwa-studio-feature' }, [
      el('span', { class: 'fwa-studio-feature-icon', 'aria-hidden': 'true', text: number }),
      el('div', { class: 'fwa-studio-feature-copy' }, [el('h3', { text: title }), el('p', { text: copy })]),
    ]),
  ));
  const list = el('div', { class: 'fwa-studio-workspace-list' });
  const demoNames = ['產品文件', '客戶知識庫', '維運手冊'];
  const renderList = (): void => {
    list.replaceChildren(...demoNames.map((name) => el('div', { class: 'fwa-studio-workspace-row' }, [
      el('span', { 'aria-hidden': 'true', text: '▤' }), el('span', { text: name }),
      el('span', { class: 'fwa-studio-workspace-arrow', 'aria-hidden': 'true', text: '↗' }),
    ])));
  };
  renderList();
  const launcher = el('button', { class: 'fwa-btn fwa-btn-primary', type: 'button', 'aria-expanded': 'true', text: 'Pet · 客戶' });
  const add = el('button', { class: 'fwa-btn', type: 'button', text: '＋ 加入示範頁面' });
  const status = el('p', { class: 'fwa-studio-demo-note', role: 'status', 'aria-live': 'polite', text: '互動示範：點擊按鈕收合客戶視窗，或加入一個頁面。' });
  const panel = el('div', { class: 'fwa-studio-workspace-panel' }, [list, add]);
  launcher.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    launcher.setAttribute('aria-expanded', String(!panel.hidden));
    status.textContent = panel.hidden ? '客戶視窗已收合，再點一次即可開啟。' : '客戶視窗已開啟。';
  });
  add.addEventListener('click', () => {
    demoNames.push('我的新頁面');
    renderList();
    add.disabled = true;
    status.textContent = '示範頁面已加入。實際客戶視窗會將捷徑保存在這個瀏覽器。';
  });
  return el('div', { class: 'fwa-studio-welcome' }, [features,
    el('div', { class: 'fwa-studio-demo' }, [
      el('div', { class: 'fwa-studio-demo-bar' }, [el('strong', { text: '客戶視窗操作示範' }), launcher]),
      panel, status,
    ]),
  ]);
}

function renderApiStep(settings: Settings): HTMLElement {
  const provider = el('select', { id: 'fwa-onboarding-ai-provider', 'aria-label': 'AI Provider' });
  provider.append(el('option', { value: '', text: '請選擇 Provider' }));
  provider.append(el('option', { value: 'ornith', text: 'Local Ornith' }));
  provider.append(el('option', { value: 'azure', text: 'Azure OpenAI' }));
  provider.value = settings.aiProvider;

  const ornithBaseUrl = makeOnboardingInput(
    'fwa-onboarding-ornith-base-url',
    ORNITH_DEFAULT_BASE_URL,
    settings.ornithBaseUrl,
  );
  const ornithModel = makeOnboardingInput(
    'fwa-onboarding-ornith-model',
    ORNITH_DEFAULT_MODEL,
    settings.ornithModel,
  );
  const ornithApiKey = makeOnboardingInput('fwa-onboarding-ornith-api-key', '貼上 Ornith API Key', settings.ornithApiKey);
  ornithApiKey.type = 'password';
  ornithApiKey.autocomplete = 'new-password';
  ornithApiKey.spellcheck = false;

  const endpoint = makeOnboardingInput('fwa-onboarding-azure-endpoint', 'https://your-resource.openai.azure.com', settings.azureEndpoint);
  const deployment = makeOnboardingInput('fwa-onboarding-azure-deployment', '例如：gpt-4.1 或自訂部署名稱', settings.azureDeployment);
  const apiVersion = makeOnboardingInput('fwa-onboarding-azure-api-version', '例如：2024-12-01-preview', settings.azureApiVersion);
  const apiKey = makeOnboardingInput('fwa-onboarding-azure-api-key', '貼上 Azure OpenAI API Key', settings.azureApiKey);
  apiKey.type = 'password';
  apiKey.autocomplete = 'new-password';
  apiKey.spellcheck = false;

  const createToggle = (input: HTMLInputElement, label: string): HTMLButtonElement => {
    const toggle = el('button', { class: 'fwa-onboarding-key-toggle', type: 'button', text: '顯示' });
    toggle.setAttribute('aria-label', `顯示或隱藏 ${label} API Key`);
    toggle.addEventListener('click', () => {
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      toggle.textContent = hidden ? '隱藏' : '顯示';
    });
    return toggle;
  };
  const ornithToggle = createToggle(ornithApiKey, 'Ornith');
  const azureToggle = createToggle(apiKey, 'Azure OpenAI');

  const ornithGroup = el('fieldset', { class: 'fwa-onboarding-provider-group' }, [
    el('legend', { text: 'Local Ornith' }),
    createOnboardingField('Ornith Base URL', ornithBaseUrl),
    createOnboardingField('Ornith Model', ornithModel),
    el('label', { class: 'fwa-onboarding-field', for: ornithApiKey.id }, [
      el('span', { text: 'Ornith API Key' }),
      el('div', { class: 'fwa-onboarding-input-with-action' }, [ornithApiKey, ornithToggle]),
    ]),
  ]) as HTMLFieldSetElement;

  const azureGroup = el('fieldset', { class: 'fwa-onboarding-provider-group' }, [
    el('legend', { text: 'Azure OpenAI' }),
    createOnboardingField('Azure Endpoint', endpoint),
    createOnboardingField('Azure Deployment Name', deployment),
    createOnboardingField('Azure API Version', apiVersion),
    el('label', { class: 'fwa-onboarding-field', for: apiKey.id }, [
      el('span', { text: 'Azure OpenAI API Key' }),
      el('div', { class: 'fwa-onboarding-input-with-action' }, [apiKey, azureToggle]),
    ]),
  ]) as HTMLFieldSetElement;

  const lockStatus = createInlineStatus('api-provider-lock');
  const locked: Exclude<AiProvider, ''> | '' = settings.ornithApiKey.trim()
    ? 'ornith'
    : settings.azureApiKey.trim()
      ? 'azure'
      : '';
  const renderProvider = (): void => {
    const selected = provider.value as AiProvider;
    ornithGroup.disabled = selected !== 'ornith';
    azureGroup.disabled = selected !== 'azure';
    ornithGroup.hidden = selected !== 'ornith';
    azureGroup.hidden = selected !== 'azure';
    provider.disabled = !!locked;
    lockStatus.textContent = locked
      ? `已儲存 ${locked === 'ornith' ? 'Local Ornith' : 'Azure OpenAI'} API Key；請到完整設定頁移除後才能切換。`
      : selected
        ? ''
        : '請先選擇一個 Provider。';
  };
  provider.addEventListener('change', renderProvider);

  const fields = el('div', { class: 'fwa-onboarding-api-fields' }, [
    createOnboardingField('AI Provider', provider),
    ornithGroup,
    azureGroup,
    lockStatus,
  ]);
  renderProvider();
  return el('div', { class: 'fwa-onboarding-form-card fwa-onboarding-api-card' }, [fields, createInlineStatus('api')]);
}

async function saveApiStep(section: HTMLElement): Promise<Partial<Settings> | null> {
  const read = (id: string): string => section.querySelector<HTMLInputElement>(`#${id}`)?.value.trim() ?? '';
  const aiProvider = (section.querySelector<HTMLSelectElement>('#fwa-onboarding-ai-provider')?.value ?? '') as AiProvider;
  if (!aiProvider) {
    setStepStatus(section, '請先選擇 Local Ornith 或 Azure OpenAI。', true);
    return null;
  }
  setStepStatus(section, 'API 設定已儲存；API Key 也可以之後再到設定頁補上。');
  return {
    aiProvider,
    ornithBaseUrl: read('fwa-onboarding-ornith-base-url'),
    ornithModel: read('fwa-onboarding-ornith-model'),
    ornithApiKey: read('fwa-onboarding-ornith-api-key'),
    azureEndpoint: read('fwa-onboarding-azure-endpoint'),
    azureDeployment: read('fwa-onboarding-azure-deployment'),
    azureApiVersion: read('fwa-onboarding-azure-api-version'),
    azureApiKey: read('fwa-onboarding-azure-api-key'),
  };
}

function createInlineStatus(kind: string): HTMLElement {
  return el('div', {
    class: 'fwa-onboarding-inline-status',
    'data-onboarding-status': kind,
    role: 'status',
    'aria-live': 'polite',
  });
}

function makeOnboardingInput(id: string, placeholder: string, value = ''): HTMLInputElement {
  const input = el('input', {
    id,
    type: 'text',
    placeholder,
    autocomplete: 'off',
  });
  input.value = value;
  return input;
}

function createOnboardingField(label: string, control: HTMLElement): HTMLElement {
  return el('label', { class: 'fwa-onboarding-field', for: control.id }, [
    el('span', { text: label }),
    control,
  ]);
}

function setStepStatus(section: HTMLElement, message: string, isError = false): void {
  const status = section.querySelector<HTMLElement>('[data-onboarding-status]');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-error', isError);
}

/** A local, editable guide; no article or remote service is changed here. */
function renderEditorStep(requestFutureMode: () => void): HTMLElement {
  const source = el('textarea', {
    class: 'fwa-studio-demo-source',
    'aria-label': '示範文章原始碼',
    spellcheck: 'false',
  });
  const title = el('h3', { contenteditable: 'true', tabindex: '0', role: 'textbox', 'aria-label': '示範文章標題', text: '部署前檢查' });
  const paragraph = el('p', { contenteditable: 'true', tabindex: '0', role: 'textbox', 'aria-label': '示範文章內容', text: '確認服務版本、設定檔與資料備份，再開始部署。點擊這段文字即可修改。' });
  const visual = el('div', { class: 'fwa-studio-demo-content' }, [title, paragraph]);
  const visualButton = el('button', { class: 'fwa-btn active', type: 'button', 'aria-pressed': 'true', text: '視覺編輯' });
  const sourceButton = el('button', { class: 'fwa-btn', type: 'button', 'aria-pressed': 'false', text: '原始碼' });
  const feedback = el('p', { class: 'fwa-studio-demo-note', role: 'status', 'aria-live': 'polite', text: '直接點選文字即可編輯。這份示範不會修改你的 Wiki。' });
  let visualMode = true;
  const toSource = (): void => { source.value = '# ' + (title.textContent ?? '') + '\n\n' + (paragraph.innerText || paragraph.textContent || ''); };
  const toVisual = (): void => {
    const lines = source.value.split('\n');
    title.textContent = (lines.shift() ?? '').replace(/^#\s*/, '');
    paragraph.textContent = lines.join('\n').replace(/^\n/, '');
  };
  const setMode = (visualSelected: boolean): void => {
    if (visualSelected === visualMode) return;
    if (visualSelected) toVisual();
    else toSource();
    visualMode = visualSelected;
    visual.hidden = !visualSelected;
    source.hidden = visualSelected;
    visualButton.classList.toggle('active', visualSelected);
    sourceButton.classList.toggle('active', !visualSelected);
    visualButton.setAttribute('aria-pressed', String(visualSelected));
    sourceButton.setAttribute('aria-pressed', String(!visualSelected));
    feedback.textContent = visualSelected ? '已切換至視覺編輯，試著直接改寫內容。' : '同一份內容，以 Markdown 呈現。你可以在這裡繼續修改。';
  };
  visualButton.addEventListener('click', () => setMode(true));
  sourceButton.addEventListener('click', () => setMode(false));
  visual.addEventListener('input', () => { feedback.textContent = '示範內容已修改。切換原始碼就能看見對應文字。'; });
  // Plain text paste keeps this intentionally small demo predictable.
  visual.addEventListener('paste', (event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    const selection = visual.getRootNode() instanceof ShadowRoot
      ? (visual.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() ?? window.getSelection()
      : window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!visual.contains(range.commonAncestorContainer)) return;
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  });
  source.hidden = true;
  const open = el('button', { class: 'fwa-btn fwa-btn-primary', type: 'button', text: '前往 Wiki，開始視覺編輯 →' });
  open.addEventListener('click', requestFutureMode);
  return el('div', { class: 'fwa-studio-demo' }, [
    el('div', { class: 'fwa-studio-demo-bar' }, [el('strong', { text: '編輯操作示範' }), el('div', { class: 'fwa-studio-demo-modes', role: 'group', 'aria-label': '示範編輯模式' }, [sourceButton, visualButton])]),
    visual, source, feedback,
    el('div', { class: 'fwa-studio-demo-actions' }, [open]),
  ]);
}

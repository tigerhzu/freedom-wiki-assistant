import topbarGuideHtml from '../onboarding-guides/freedom-wiki-topbar-guide.html?raw';
import editorToolbarGuideHtml from '../onboarding-guides/freedom-wiki-editor-toolbar-guide.html?raw';
import { wikiConfig } from '../config/wiki-config';
import { sendMessage } from '../shared/messages';
import { getSettings, saveSettings } from '../shared/storage';
import type { Settings } from '../shared/types';
import { el, openModal, type ModalHandle } from './ui';

/** Increment this whenever the onboarding content or sequence changes. */
export const ONBOARDING_VERSION = 4;

const ONBOARDING_PAGE_MARKER = 'data-fwa-onboarding-page';

interface OnboardingStep {
  label: string;
  title: string;
  hint: string;
  render(settings: Settings): HTMLElement;
  save?(section: HTMLElement): Promise<Partial<Settings> | null>;
}

const steps: OnboardingStep[] = [
  {
    label: '客戶',
    title: '1. 點擊 pet 管理客戶',
    hint: '點擊 Wiki 左下角的 pet 開啟客戶面板，就能新增、編輯或移除客戶。',
    render: renderCustomerStep,
  },
  {
    label: 'API',
    title: '2. 設定 AI API',
    hint: '沒有 API Key 可以先略過，之後再到 Extension 設定補上；金鑰只儲存在本機瀏覽器。',
    render: renderApiStep,
    save: saveApiStep,
  },
  {
    label: '上方控制列',
    title: '3. Wiki 上方控制列',
    hint: '這裡示範 Wiki 上方的顏色、拓譜與設定入口；滑過或點擊按鈕可以查看功能提示。',
    render: () => buildGuide(topbarGuideHtml, 'topbar'),
  },
  {
    label: '編輯工具列',
    title: '4. Wiki 編輯器工具列',
    hint: '這裡示範模板、AI 排版與 Classic／Future 模式；箭頭會指出目前頁面上的控制位置。',
    render: () => buildGuide(editorToolbarGuideHtml, 'editor-toolbar'),
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
    console.warn('[FWA] 無法開啟首次登入提示分頁', error);
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
    const modal = openModal('首次登入提示', 'fwa-onboarding-host', 'fwa-onboarding-modal', !standalonePage);
    activeOnboarding = modal;
    modal.layer.classList.add('fwa-onboarding-backdrop');
    if (standalonePage) modal.layer.classList.add('fwa-onboarding-page-layer');
    modal.element.setAttribute('role', 'dialog');
    modal.element.setAttribute('aria-modal', 'true');
    modal.element.setAttribute('aria-labelledby', 'fwa-onboarding-dialog-title');

    const close = el('button', {
      class: 'fwa-onboarding-close',
      type: 'button',
      'aria-label': '關閉首次登入提示',
      text: '×',
    });
    const title = el('h1', { id: 'fwa-onboarding-dialog-title', text: '首次登入提示' });
    const header = modal.element.querySelector<HTMLElement>('.fwa-modal-header');
    header?.replaceChildren(el('div', { class: 'fwa-onboarding-header-title' }, [title]), close);

    const intro = el('p', {
      class: 'fwa-onboarding-intro',
      text: '用四個簡短步驟完成 Wiki 客戶、AI 與編輯工具設定；每一步都可以略過。',
    });
    const progress = buildProgress();
    const content = el('div', { class: 'fwa-onboarding-step-stack' });
    const sections = steps.map((_step, index) => {
      const section = el('section', {
        class: 'fwa-onboarding-step',
        'aria-labelledby': `fwa-onboarding-step-title-${index}`,
      });
      content.append(section);
      return section;
    });
    const status = el('div', {
      class: 'fwa-onboarding-status',
      role: 'status',
      'aria-live': 'polite',
    });
    modal.body.replaceChildren(intro, progress, content, status);

    const previous = el('button', { class: 'fwa-btn', type: 'button', text: '上一步' });
    const skip = el('button', { class: 'fwa-btn', type: 'button', text: '略過這一步' });
    const next = el('button', { class: 'fwa-btn fwa-btn-primary', type: 'button', text: '儲存並繼續' });
    previous.setAttribute('aria-label', '回到上一步');
    skip.setAttribute('aria-label', '略過目前這一步');
    next.setAttribute('aria-label', '儲存目前設定並前往下一步');
    modal.footer.setAttribute('aria-label', '首次登入提示操作');
    modal.footer.append(previous, skip, next);

    let currentStep = 0;
    let busy = false;
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
      settings = merged;
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
        if (!(await saveCurrentStep())) {
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
          el('h2', { tabindex: '-1', text: '首次登入提示已完成' }),
          el('p', { text: '之後可從 Extension 的「設定」重新開啟此頁面。' }),
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
      window.requestAnimationFrame(() => modal.element.querySelector<HTMLElement>('.fwa-onboarding-complete-view h2')?.focus());
    };

    const renderCurrentStep = (): void => {
      const step = steps[currentStep];
      sections.forEach((section, index) => {
        const isCurrent = index === currentStep;
        section.hidden = !isCurrent;
        if (!isCurrent) return;
        section.replaceChildren(
          el('h2', { id: `fwa-onboarding-step-title-${index}`, tabindex: '-1', text: step.title }),
          el('p', { class: 'fwa-onboarding-step-hint', text: step.hint }),
          step.render(settings),
        );
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
      next.textContent = currentStep === steps.length - 1 ? '完成設定' : '儲存並繼續';
      skip.textContent = currentStep === steps.length - 1 ? '略過並完成' : '略過這一步';
      next.setAttribute('aria-label', currentStep === steps.length - 1 ? '完成首次登入提示' : '儲存目前設定並前往下一步');
      skip.setAttribute('aria-label', currentStep === steps.length - 1 ? '略過導覽並完成首次登入提示' : '略過目前這一步');
      setStatus();
      window.requestAnimationFrame(() => modal.element.querySelector<HTMLElement>(`#fwa-onboarding-step-title-${currentStep}`)?.focus());
    };

    const trapFocus = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        modal.element.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([hidden]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => !node.hidden);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapFocus, true);

    modal.onClose(() => {
      activeOnboarding = null;
      document.removeEventListener('keydown', trapFocus, true);
      if (previousFocus?.isConnected) previousFocus.focus();
      if (!closing && !completionShown) {
        closing = true;
        void (async () => {
          try {
            if (await saveCurrentStep()) await persistPatch({ onboardingVersion: ONBOARDING_VERSION });
          } catch (error) {
            console.warn('[FWA] 無法保存首次登入提示狀態', error);
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
    'aria-label': '首次登入提示進度',
  });
  steps.forEach((step, index) => {
    progress.append(
      el('li', { class: index === 0 ? 'is-current' : '', 'aria-current': index === 0 ? 'step' : '' }, [
        el('span', { class: 'fwa-onboarding-progress-label', text: step.label }),
      ]),
    );
  });
  return progress;
}

function renderCustomerStep(): HTMLElement {
  const drawer = el('div', { class: 'fwa-customer-guide-drawer' });
  const pet = el('button', {
    class: 'fwa-customer-guide-pet',
    type: 'button',
    'aria-label': '點擊 pet 開啟或關閉客戶面板',
    'aria-expanded': 'true',
    title: '點擊 pet 開啟或關閉客戶面板',
  });
  const status = el('div', {
    class: 'fwa-customer-guide-status',
    role: 'status',
    'aria-live': 'polite',
    text: '示意操作：點擊 pet 開／關面板，或用面板按鈕增減客戶。',
  });

  const demoCustomers = [
    { name: 'ACB', pageCount: '1 個常用頁面' },
    { name: 'ATT', pageCount: '尚無常用頁面' },
    { name: 'APR', pageCount: '1 個常用頁面' },
  ];

  const renderDrawer = (): void => {
    const addCustomer = el('button', {
      class: 'fwa-btn fwa-btn-primary fwa-customer-guide-add',
      type: 'button',
      text: '＋ 新增客戶',
    });
    const count = el('span', { class: 'fwa-customer-guide-count', text: `${demoCustomers.length} 位` });
    const list = el('div', { class: 'fwa-customer-guide-list' });

    const renderRows = (): void => {
      list.replaceChildren(
        ...demoCustomers.map((customer, index) => {
          const remove = el('button', {
            class: 'fwa-customer-guide-remove',
            type: 'button',
            'aria-label': `移除示意客戶 ${customer.name}`,
            text: '×',
          });
          remove.addEventListener('click', () => {
            demoCustomers.splice(index, 1);
            renderRows();
            count.textContent = `${demoCustomers.length} 位`;
            status.textContent = `已示範移除客戶「${customer.name}」；實際操作會更新你的客戶清單。`;
          });
          const edit = el('button', {
            class: 'fwa-customer-guide-edit',
            type: 'button',
            'aria-label': `編輯示意客戶 ${customer.name}`,
            text: '✎',
          });
          edit.addEventListener('click', () => {
            status.textContent = `實際操作點擊鉛筆即可編輯「${customer.name}」的名稱與 Wiki 路徑。`;
          });
          return el('div', { class: 'fwa-customer-guide-row' }, [
            el('span', { class: 'fwa-customer-guide-drag', 'aria-hidden': 'true', text: '⠿' }),
            el('div', { class: 'fwa-customer-guide-row-copy' }, [
              el('strong', { text: customer.name }),
              el('span', { text: customer.pageCount }),
            ]),
            edit,
            remove,
          ]);
        }),
      );
    };

    addCustomer.addEventListener('click', () => {
      const nextNumber = demoCustomers.length + 1;
      const name = `NEW${nextNumber}`;
      demoCustomers.push({ name, pageCount: '尚無常用頁面' });
      renderRows();
      count.textContent = `${demoCustomers.length} 位`;
      status.textContent = `已示範新增客戶「${name}」；實際操作會開啟新增客戶表單。`;
    });

    drawer.replaceChildren(
      el('div', { class: 'fwa-customer-guide-toolbar' }, [
        addCustomer,
        el('button', { class: 'fwa-customer-guide-secondary', type: 'button', text: '＋ 新增這個介面' }),
        el('button', { class: 'fwa-customer-guide-secondary', type: 'button', text: '＋ 新增資料夾' }),
      ]),
      el('div', { class: 'fwa-customer-guide-section-heading' }, [
        el('span', { text: '▰　未分類' }),
        count,
      ]),
      list,
    );
    renderRows();
  };

  const setDrawerOpen = (open: boolean): void => {
    drawer.hidden = !open;
    pet.setAttribute('aria-expanded', String(open));
    status.textContent = open
      ? '客戶面板已開啟：可以新增、編輯或移除客戶。'
      : '面板已收起；再次點擊 pet 就能開啟客戶管理。';
  };

  pet.addEventListener('click', () => setDrawerOpen(drawer.hidden));
  pet.style.backgroundImage = `url("${chrome.runtime.getURL('pet/claude-crab/spritesheet.png')}")`;
  renderDrawer();

  return el('div', { class: 'fwa-onboarding-form-card fwa-onboarding-customer-card' }, [
    el('div', { class: 'fwa-onboarding-form-title', text: '點擊左下角的 pet，就能管理客戶' }),
    el('p', {
      class: 'fwa-onboarding-form-help',
      text: '這是操作示意圖。實際在 Wiki 點擊 pet 後，可以新增客戶、編輯資料，或從客戶面板移除不需要的項目。',
    }),
    el('div', { class: 'fwa-customer-guide-demo' }, [
      el('div', { class: 'fwa-customer-guide-wiki' }, [
        el('div', { class: 'fwa-customer-guide-wiki-topbar' }, [
          el('strong', { text: 'Freedom Systems Documentation site' }),
          el('span', { text: 'Search...' }),
        ]),
        el('div', { class: 'fwa-customer-guide-wiki-body' }, [
          el('div', { class: 'fwa-customer-guide-wiki-sidebar' }, [
            el('span', { text: '⌂　Home' }),
            el('span', { text: '⌁　Collaboration' }),
            el('span', { text: '●　CSM' }),
            el('span', { text: '⚒　Engineering' }),
            el('span', { text: '≡　PM' }),
          ]),
          el('div', { class: 'fwa-customer-guide-wiki-content' }, [
            el('span', { class: 'fwa-customer-guide-skeleton skeleton-title' }),
            el('span', { class: 'fwa-customer-guide-skeleton skeleton-line' }),
            el('span', { class: 'fwa-customer-guide-skeleton skeleton-line short' }),
            el('span', { class: 'fwa-customer-guide-skeleton skeleton-block' }),
          ]),
        ]),
      ]),
      drawer,
      el('div', { class: 'fwa-customer-guide-pet-callout' }, [
        el('span', { class: 'fwa-customer-guide-callout-label', text: '點擊 pet' }),
        el('span', { class: 'fwa-customer-guide-callout-arrow', 'aria-hidden': 'true', text: '↙' }),
      ]),
      pet,
    ]),
    status,
  ]);
}

function renderApiStep(settings: Settings): HTMLElement {
  const provider = el('select', { id: 'fwa-onboarding-ai-provider', 'aria-label': 'AI Provider' });
  provider.append(el('option', { value: 'azure', text: 'Azure OpenAI' }));
  provider.value = 'azure';

  const endpoint = makeOnboardingInput('fwa-onboarding-azure-endpoint', 'https://your-resource.openai.azure.com', settings.azureEndpoint);
  const deployment = makeOnboardingInput('fwa-onboarding-azure-deployment', '例如：gpt-4.1 或自訂部署名稱', settings.azureDeployment);
  const apiVersion = makeOnboardingInput('fwa-onboarding-azure-api-version', '例如：2024-12-01-preview', settings.azureApiVersion);
  const apiKey = makeOnboardingInput('fwa-onboarding-azure-api-key', '貼上 Azure OpenAI API Key', settings.azureApiKey);
  apiKey.type = 'password';
  apiKey.autocomplete = 'off';
  apiKey.spellcheck = false;

  const toggle = el('button', { class: 'fwa-onboarding-key-toggle', type: 'button', text: '顯示' });
  toggle.setAttribute('aria-label', '顯示或隱藏 Azure OpenAI API Key');
  toggle.addEventListener('click', () => {
    const hidden = apiKey.type === 'password';
    apiKey.type = hidden ? 'text' : 'password';
    toggle.textContent = hidden ? '隱藏' : '顯示';
  });

  const fields = el('div', { class: 'fwa-onboarding-api-fields' }, [
    createOnboardingField('AI Provider', provider),
    createOnboardingField('Azure Endpoint', endpoint),
    createOnboardingField('Azure Deployment Name', deployment),
    createOnboardingField('Azure API Version', apiVersion),
    el('label', { class: 'fwa-onboarding-field', for: apiKey.id }, [
      el('span', { text: 'Azure OpenAI API Key' }),
      el('div', { class: 'fwa-onboarding-input-with-action' }, [apiKey, toggle]),
    ]),
  ]);
  return el('div', { class: 'fwa-onboarding-form-card fwa-onboarding-api-card' }, [fields, createInlineStatus('api')]);
}

async function saveApiStep(section: HTMLElement): Promise<Partial<Settings>> {
  const read = (id: string): string => section.querySelector<HTMLInputElement>(`#${id}`)?.value.trim() ?? '';
  setStepStatus(section, 'API 設定已儲存；API Key 也可以之後再到設定頁補上。');
  return {
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

function buildGuide(rawHtml: string, kind: 'topbar' | 'editor-toolbar'): HTMLElement {
  const parsed = new DOMParser().parseFromString(rawHtml, 'text/html');
  const wrapper = el('div', { class: `fwa-onboarding-guide fwa-onboarding-${kind}-guide` });
  const sourceStyle = parsed.querySelector('style');
  if (sourceStyle) {
    const style = document.createElement('style');
    style.textContent = sourceStyle.textContent ?? '';
    wrapper.append(style);
  }
  const arrowStyle = document.createElement('style');
  arrowStyle.textContent = `
    .fwa-onboarding-guide .demo,
    .fwa-onboarding-guide .topbar,
    .fwa-onboarding-guide .control-group,
    .fwa-onboarding-guide .edit-tools { overflow: visible !important; }
    .fwa-onboarding-guide .three-arrows { display: grid !important; visibility: visible !important; z-index: 20 !important; }
    .fwa-onboarding-guide .mini-arrow,
    .fwa-onboarding-guide .arrow {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
      z-index: 21 !important;
      pointer-events: none !important;
    }
    .fwa-onboarding-guide .mini-arrow path,
    .fwa-onboarding-guide .arrow path { stroke: #d85b63 !important; }
    .fwa-onboarding-guide .mini-arrow polygon,
    .fwa-onboarding-guide .arrow polygon { fill: #d85b63 !important; }
  `;
  wrapper.append(arrowStyle);

  const pageSource = parsed.querySelector('.page');
  if (!(pageSource instanceof HTMLElement)) return wrapper;
  const page = pageSource.cloneNode(true) as HTMLElement;
  page.querySelectorAll('script, iframe, object, embed, link, base, .toast, .legend, .guide, .ai-note').forEach((node) => node.remove());
  page.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.type = 'button';
    button.removeAttribute('formaction');
    button.removeAttribute('formmethod');
    button.removeAttribute('formtarget');
  });
  page.querySelectorAll<HTMLAnchorElement>('a').forEach((anchor) => {
    anchor.removeAttribute('href');
    anchor.removeAttribute('target');
    anchor.removeAttribute('rel');
  });
  wrapper.append(page);

  const status = el('div', {
    class: 'fwa-onboarding-guide-status',
    role: 'status',
    'aria-live': 'polite',
  });
  wrapper.append(status);
  page.querySelectorAll<HTMLElement>('[data-key], [data-target]').forEach((control) => {
    control.addEventListener('click', () => {
      const label = control.textContent?.replace(/\s+/g, ' ').trim() || '這個控制項';
      status.textContent = `預覽提示：${label}`;
    });
  });
  return wrapper;
}

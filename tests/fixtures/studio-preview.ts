import { installPreviewChrome } from './preview-chrome';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import { getSettings, saveSettings, saveCustomers, saveCustomerFolders } from '../../src/shared/storage';
import { TextareaAdapter } from '../../src/content/editor-adapter';
import { WikiDocumentSync } from '../../src/content/document-sync';
import { HybridPreviewFeature } from '../../src/content/hybrid-preview';
import { FormattingMenu } from '../../src/content/formatting-menu';
import { MainNav } from '../../src/content/main-nav';
import { TemplatePanel } from '../../src/content/template-panel';
import { AiLayoutFeature } from '../../src/content/ai-layout';
import { seedDefaultTemplatesIfEmpty } from '../../src/templates/template-service';
import { buildImgTag, findImages } from '../../src/content/markdown-image';

installPreviewChrome();
const sample = `# 工作站部署指南\n\n本文件記錄新設備的標準部署流程，適用於工程團隊的 Windows 工作站。完成後，請在工單中記錄設備編號與驗收結果。\n\n> 部署前確認使用者已備份資料，並備妥公司帳號與設備資產編號。\n\n## 01 環境準備\n\n依序完成帳號、網路與安全性設定：\n\n- 啟用公司帳號，設定雙重驗證\n- 安裝標準軟體與最新系統更新\n- 確認 VPN 與內部系統連線\n\n## 02 驗收項目\n\n| 檢查項目 | 驗收標準 |\n| --- | --- |\n| 公司帳號 | 可登入並通過雙重驗證 |\n| 網路連線 | 可存取內部 Wiki 與檔案服務 |\n| 設備資訊 | 資產編號已登錄至工單 |\n\n## 03 交付紀錄\n\n在工單中附上驗收結果，確認使用者可正常登入與操作，再更新部署狀態。例外情況請記錄處理方式與後續負責人。`;

// A deliberately small fixture renderer. The production extension continues
// to use Wiki.js' renderer; regression tests cover its projection boundary.
function render(source: string): string {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (text: string) => {
    let result = '';
    let offset = 0;
    for (const image of findImages(text)) {
      result += escape(text.slice(offset, image.start));
      result += image.kind === 'html' ? image.raw : buildImgTag({
        url: image.url, alt: image.alt, title: image.title, decls: [],
      });
      offset = image.end;
    }
    return (result + escape(text.slice(offset)))
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>\n');
  };
  return source.split(/\n\s*\n/).map((block) => {
    const heading = /^(#{1,6}) (.*)$/.exec(block);
    if (heading) return `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;
    if (block.startsWith('> ')) return `<blockquote><p>${inline(block.replace(/^> ?/gm, ''))}</p></blockquote>`;
    if (block.startsWith('- ')) return `<ul>${block.split('\n').map((line) => `<li>${inline(line.slice(2))}</li>`).join('')}</ul>`;
    if (block.startsWith('|')) {
      const rows = block.split('\n').filter((line) => !/^\|[\s|:-]+$/.test(line));
      return `<table>${rows.map((line, index) => `<tr>${line.split('|').slice(1, -1).map((cell) => `<${index ? 'td' : 'th'}>${inline(cell.trim())}</${index ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table>`;
    }
    // Source formatter emits HTML. Only known fixture-generated local content
    // is rendered here; the local preview is not a general Markdown service.
    if (block.startsWith('<')) return block;
    return `<p>${inline(block)}</p>`;
  }).join('\n');
}

if (!sessionStorage.getItem('wiki-studio-preview-seeded')) {
  await saveSettings({ ...DEFAULT_SETTINGS, editorMode: 'hybrid', onboardingVersion: 999 });
  await saveCustomerFolders([{ id: 'sample-folder', name: '專案協作', createdAt: '2026-09-01T00:00:00Z' }]);
  await saveCustomers([
    { id: 'sample-1', name: '晨光設計', pagePath: '/zh/projects/morning', folderId: 'sample-folder', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'sample-2', name: '山嶼科技', pagePath: '/zh/projects/island', folderId: 'sample-folder', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'sample-3', name: '團隊知識庫', pagePath: '/zh/team', createdAt: '2026-09-01T00:00:00Z' },
  ]);
  sessionStorage.setItem('wiki-studio-preview-seeded', 'true');
}
await seedDefaultTemplatesIfEmpty();
const source = document.querySelector<HTMLTextAreaElement>('.source-pane textarea')!;
const content = document.querySelector<HTMLElement>('.editor-markdown-preview-content')!;
const initialSample = new URLSearchParams(location.search).has('images')
  ? '# 圖片編輯測試\n\n測試說明：四張連續圖片，調整其中一張後其餘圖片應保留。\n' +
    ['16', '32', '48', '128'].map(size => `![測試圖片 ${size}](/src/icons/wiki_logo_${size}.png)`).join('\n') +
    '\n\n在這裡測試文字輸入、換行、貼上與復原。'
  : sample;
source.value = initialSample;
content.firstElementChild!.innerHTML = render(initialSample);
const adapter = new TextareaAdapter(source);
const sync = new WikiDocumentSync(adapter);
const settings = await getSettings();
const hybrid = new HybridPreviewFeature(adapter, settings, null, sync);
hybrid.attach();
const menu = new FormattingMenu(adapter, settings, sync);
menu.attach();
const nav = new MainNav();
nav.attach();
const templates = new TemplatePanel(adapter, sync);
nav.setTemplatePanel(templates);
nav.setAiLayout(new AiLayoutFeature(adapter, () => hybrid.prepareExternalEditorAction(), () => hybrid.getVisualSelection(), sync));
let renderTimer: ReturnType<typeof setTimeout>;
source.addEventListener('input', () => {
  if (document.activeElement !== source) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { content.firstElementChild!.innerHTML = render(source.value); }, 120);
});
document.querySelector('.save')?.addEventListener('click', () => {
  document.querySelector('.preview-status')!.textContent = '範例已儲存於本次預覽 · 未傳送至 Wiki';
});

import { wikiConfig } from '../config/wiki-config';
import type { Settings } from '../shared/types';
import { getSettings, saveSettings } from '../shared/storage';
import type { EditorAdapter } from './editor-adapter';
import { createUploadTarget, openAssetsManagerFallback } from './image-uploader';
import { getCurrentArticlePath } from './page-path';
import { UploadCancelledError, type UploadTarget } from './upload-types';
import { WikijsFolderCreateError, WikijsFolderNotFoundError } from './wikijs-upload';
import { buildImageMarkdown, fileExtension, uniqueFileName } from './sanitize-filename';
import { el, openModal, showFolderConfirmToast, showProgressToast, showToast } from './ui';

/**
 * Drag-and-drop + clipboard-paste image upload.
 *
 * Flow: collect image files → determine target assets folder (current
 * article's own path by default — see wiki-config's folderForArticlePath —
 * or its parent folder, or always-manual, per settings.folderStrategy) →
 * briefly confirm the destination (auto-proceeds; a "變更資料夾" button
 * opens the picker instead) → auto-create any missing folder layer → upload
 * each via the wiki's upload flow (progress + cancel) → insert one Markdown
 * line per image at the caret.
 */
export class ImageDropHandler {
  /** Names uploaded during this page session, used for -1/-2 suffixing. */
  private readonly uploadedNames: string[] = [];

  private readonly onDragOver = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  private readonly onDrop = (e: DragEvent) => {
    if (!this.settings.enableImageDrop) return;
    const files = collectImageFiles(e.dataTransfer?.files);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    void this.handleFiles(files);
  };
  private readonly onPaste = (e: ClipboardEvent) => {
    if (!this.settings.enableClipboardImage) return;
    const files = collectImageFiles(e.clipboardData?.files);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    void this.handleFiles(files);
  };

  constructor(
    private readonly adapter: EditorAdapter,
    private readonly settings: Settings,
  ) {}

  attach(): void {
    const root = this.adapter.rootElement;
    root.addEventListener('dragover', this.onDragOver, true);
    root.addEventListener('drop', this.onDrop, true);
    root.addEventListener('paste', this.onPaste, true);
  }

  detach(): void {
    const root = this.adapter.rootElement;
    root.removeEventListener('dragover', this.onDragOver, true);
    root.removeEventListener('drop', this.onDrop, true);
    root.removeEventListener('paste', this.onPaste, true);
  }

  private async handleFiles(files: File[]): Promise<void> {
    if (wikiConfig.assets.mode === 'fallback') {
      this.enterFallbackMode();
      return;
    }

    const target = await this.resolveUploadTarget();
    if (!target) return;

    let taken: string[] = [...this.uploadedNames];
    try {
      taken = [...(await target.existingNames()), ...this.uploadedNames];
    } catch {
      // Listing failed — continue with session-only dedup rather than block.
      showToast('無法取得資料夾現有檔案清單，僅以本次上傳去重。', 'info');
    }

    const lines: string[] = [];
    for (const file of files) {
      const desired = target.normalize(file.name || `screenshot.${extFromMime(file.type)}`);
      const name = uniqueFileName(desired, taken);
      const line = await this.uploadOne(target, file, name);
      if (line) {
        lines.push(line);
        taken.push(name);
        this.uploadedNames.push(name);
      }
    }
    if (lines.length === 0) return;

    this.adapter.insertAtCursor(lines.join('\n') + '\n');
    this.adapter.focus();
  }

  private async uploadOne(target: UploadTarget, file: File, name: string): Promise<string | null> {
    const progress = showProgressToast(`上傳中：${name}`, () => handle?.cancel());
    const handle = target.begin(file, name, (f) => progress.setProgress(f));
    try {
      const result = await handle.promise;
      progress.finish(`上傳成功：${result.fileName}`, 'success');
      return buildImageMarkdown(this.settings.imageMarkdownFormat, result.fileName, result.url);
    } catch (err) {
      if (err instanceof UploadCancelledError) {
        progress.finish(`已取消：${name}`, 'error');
      } else {
        progress.finish(
          `上傳失敗：${name} — ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
      return null;
    }
  }

  private enterFallbackMode(): void {
    if (openAssetsManagerFallback()) {
      showToast('上傳流程尚未實站驗證，已開啟 Assets 管理頁，請使用原站介面上傳。', 'info', 6000);
    } else {
      showToast(
        '圖片直接上傳尚未啟用（等待實站驗證）。請先使用編輯器工具列的「插入資源」上傳。',
        'info',
        8000,
      );
    }
  }

  /**
   * Determine the upload target folder.
   *
   * settings.folderStrategy === 'manual' skips straight to the picker (the
   * old always-ask behaviour). Otherwise: derive the folder from the current
   * article's real Wiki.js path (page.path via the Vuex store — never
   * document.title, see page-path.ts), show a short, non-blocking "將上傳
   *至：X" confirmation with a "變更資料夾" override, then auto-create any
   * missing folder layer right before uploading (Wiki.js has no
   * deleteFolder mutation, so we only ever create on an actual upload, never
   * speculatively). Falls back to the picker if detection fails, the user
   * asks to change the folder, or auto-creation fails.
   */
  private async resolveUploadTarget(): Promise<UploadTarget | null> {
    let hint: string | undefined;
    if (this.settings.folderStrategy !== 'manual') {
      const auto = await this.detectAutoFolder();
      if (auto) {
        hint = auto;
        const choice = await showFolderConfirmToast(auto);
        if (choice === 'proceed') {
          const target = await this.tryCreateTarget(auto, false);
          if (target) return target;
          // Auto-create failed (error already shown) — fall through to the picker.
        }
      }
    }

    for (;;) {
      const folder = await this.showFolderPicker(hint);
      if (folder === null) return null;
      const target = await this.tryCreateTarget(folder, true);
      if (target) return target;
    }
  }

  /** Current article path (currentPath/parentFolder strategy) → user default → null (picker). */
  private async detectAutoFolder(): Promise<string | null> {
    const article = await getCurrentArticlePath();
    if (article) {
      return this.settings.folderStrategy === 'parentFolder'
        ? wikiConfig.assets.parentFolderForArticlePath(article.path)
        : wikiConfig.assets.folderForArticlePath(article.path);
    }
    return this.settings.defaultImageFolder || null;
  }

  /** Always auto-creates missing folder layers — that's the whole point of this flow. */
  private async tryCreateTarget(folder: string, fromPicker: boolean): Promise<UploadTarget | null> {
    try {
      return await createUploadTarget(folder, { autoCreate: true });
    } catch (err) {
      if (err instanceof WikijsFolderCreateError) {
        showToast(err.message, 'error', 8000);
        return null;
      }
      if (err instanceof WikijsFolderNotFoundError) {
        // Shouldn't normally surface with autoCreate: true — kept as a safety net.
        showToast(
          fromPicker
            ? `${err.message}，請重新選擇。`
            : `自動判斷的資料夾不存在（${folder}），請手動選擇。`,
          fromPicker ? 'error' : 'info',
          6000,
        );
        return null;
      }
      showToast(`無法連線 Assets 服務：${err instanceof Error ? err.message : String(err)}`, 'error');
      throw err;
    }
  }

  private showFolderPicker(defaultValue?: string): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = openModal('選擇圖片上傳資料夾');
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        modal.close();
        resolve(value);
      };

      const input = el('input', {
        type: 'text',
        placeholder: '/docs/clients/example-client',
        value: defaultValue ?? this.settings.recentFolders[0] ?? '',
      });
      modal.body.append(
        el('label', { text: 'Assets 資料夾路徑（不存在的話會自動建立）' }),
        input,
      );

      if (this.settings.recentFolders.length > 0) {
        const recentWrap = el('div', { class: 'fwa-btn-row' });
        for (const f of this.settings.recentFolders.slice(0, 6)) {
          const btn = el('button', { class: 'fwa-btn', text: f });
          btn.addEventListener('click', () => {
            input.value = f;
          });
          recentWrap.appendChild(btn);
        }
        modal.body.append(el('label', { text: '最近使用' }), recentWrap);
      }

      const cancel = el('button', { class: 'fwa-btn', text: '取消' });
      const ok = el('button', { class: 'fwa-btn fwa-btn-primary', text: '上傳到此資料夾' });
      cancel.addEventListener('click', () => finish(null));
      ok.addEventListener('click', () => {
        const folder = input.value.trim().replace(/\/+$/, '');
        if (!folder.startsWith('/')) {
          input.style.borderColor = '#cf222e';
          return;
        }
        void this.rememberFolder(folder);
        finish(folder);
      });
      modal.footer.append(cancel, ok);
      input.focus();
    });
  }

  private async rememberFolder(folder: string): Promise<void> {
    const settings = await getSettings();
    settings.recentFolders = [folder, ...settings.recentFolders.filter((f) => f !== folder)].slice(0, 10);
    this.settings.recentFolders = settings.recentFolders;
    await saveSettings(settings);
  }
}

function collectImageFiles(list: FileList | null | undefined): File[] {
  if (!list) return [];
  const allowed = new Set<string>(wikiConfig.assets.allowedExtensions);
  return Array.from(list).filter((f) => {
    if (!f.type.startsWith('image/')) return false;
    const ext = fileExtension(f.name) || extFromMime(f.type);
    return allowed.has(ext);
  });
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return map[mime] ?? 'png';
}

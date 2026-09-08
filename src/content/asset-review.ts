import { wikiConfig } from '../config/wiki-config';
import { encodeAssetPath } from './sanitize-filename';
import { getCurrentArticlePath } from './page-path';
import { el, openModal, showToast } from './ui';
import {
  type AssetInfo,
  deleteWikijsAsset,
  isWikijsAssetStorageRenameFailure,
  listFolderImages,
  listSubFolders,
  renameWikijsAsset,
  resolveFolderId,
  WikijsFolderNotFoundError,
} from './wikijs-upload';

/**
 * "檢閱資料夾照片" — browse every image under a folder (current article's own
 * Assets folder by default) and its sub-folders, so images left over from
 * drag-drop uploads can actually be found and removed. Wiki.js has no bulk
 * "assets in this subtree" API, so this walks assets.folders()/assets.list()
 * recursively (see wikijs-upload.ts) and flattens the result client-side.
 */

export interface FolderImages {
  /** Real stored slug path of this folder, e.g. "/eng/ExtensionTest". */
  folderPath: string;
  images: AssetInfo[];
}

/** Depth-first walk: this folder's images first, then each sub-folder in turn. */
async function collectFolderTree(folderId: number, folderPath: string): Promise<FolderImages[]> {
  const [images, subFolders] = await Promise.all([
    listFolderImages(folderId),
    listSubFolders(folderId),
  ]);
  const result: FolderImages[] = [{ folderPath, images }];
  for (const sub of subFolders) {
    result.push(...(await collectFolderTree(sub.id, `${folderPath.replace(/\/$/, '')}/${sub.slug}`)));
  }
  return result;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function assetUrl(folderPath: string, filename: string): string {
  const path = encodeAssetPath(`${folderPath.replace(/\/$/, '')}/${filename}`);
  return new URL(path, wikiConfig.origin).toString();
}

export async function openAssetReviewModal(): Promise<void> {
  if (wikiConfig.assets.mode !== 'wikijs') {
    showToast('此功能僅支援 Wiki.js 上傳模式（目前 assets.mode 非 wikijs）', 'info');
    return;
  }

  const article = await getCurrentArticlePath();
  const defaultPath = article ? wikiConfig.assets.folderForArticlePath(article.path) : '';

  const modal = openModal('圖片資料庫', 'fwa-assets-modal-host', 'fwa-modal-wide');
  const pathInput = el('input', {
    type: 'text',
    placeholder: '/docs/clients/example-client',
    value: defaultPath,
    'aria-label': '圖片資料夾路徑',
  });
  const loadBtn = el('button', { class: 'fwa-btn fwa-btn-primary', text: '載入' });
  const statusEl = el('div', { class: 'fwa-hint', text: '正在整理圖片…', role: 'status' });
  const listEl = el('div', { class: 'fwa-asset-list' });

  modal.body.append(
    el('label', { text: '資料夾路徑（會一併檢查子資料夾）' }),
    el('div', { class: 'fwa-btn-row fwa-asset-path-row' }, [pathInput, loadBtn]),
    statusEl,
    listEl,
  );

  /** asset id → display name, for the selected-for-deletion set. */
  const selected = new Map<number, string>();
  const deleteSelectedBtn = el('button', { class: 'fwa-btn fwa-btn-danger', text: '刪除已選取 (0)' });
  const closeBtn = el('button', { class: 'fwa-btn', text: '關閉' });
  modal.footer.append(deleteSelectedBtn, closeBtn);
  closeBtn.addEventListener('click', () => modal.close());

  const updateDeleteBtnLabel = () => {
    deleteSelectedBtn.textContent = `刪除已選取 (${selected.size})`;
    deleteSelectedBtn.disabled = selected.size === 0;
  };
  updateDeleteBtnLabel();

  const renderCard = (folderPath: string, asset: AssetInfo): HTMLElement => {
    const checkbox = el('input', { type: 'checkbox', 'aria-label': `選取 ${asset.filename}` });
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.set(asset.id, asset.filename);
      else selected.delete(asset.id);
      updateDeleteBtnLabel();
    });
    const img = el('img', { class: 'fwa-asset-thumb', src: assetUrl(folderPath, asset.filename), alt: asset.filename, loading: 'lazy' });
    const meta = el('div', { class: 'fwa-asset-meta' }, [
      renderEditableName(asset),
      el('div', {
        class: 'fwa-asset-sub',
        text: `${formatFileSize(asset.fileSize)} · ${formatUpdatedAt(asset.updatedAt)}`,
      }),
    ]);
    const delBtn = el('button', { class: 'fwa-btn fwa-btn-danger', text: '刪除' });
    delBtn.addEventListener('click', () => void confirmAndDelete([{ id: asset.id, filename: asset.filename }]));
    return el('div', { class: 'fwa-asset-card' }, [checkbox, img, meta, delBtn]);
  };

  // Guards against a slow, superseded load() (e.g. a large recursive scan
  // still in flight) overwriting a later, faster load()'s results — this is
  // not hypothetical: pointing the picker at a high-level folder and then
  // retargeting it before the first scan finishes reproduces it every time.
  let loadToken = 0;
  modal.onClose(() => { loadToken++; });

  const load = async (): Promise<void> => {
    const token = ++loadToken;
    const folder = pathInput.value.trim().replace(/\/+$/, '') || '/';
    selected.clear();
    updateDeleteBtnLabel();
    listEl.replaceChildren();
    statusEl.textContent = '載入中…';
    try {
      const { id, slugPath } = await resolveFolderId(folder, { autoCreate: false });
      const tree = await collectFolderTree(id, slugPath || '/');
      if (token !== loadToken) return;
      listEl.replaceChildren();
      let total = 0;
      for (const folderEntry of tree) {
        if (folderEntry.images.length === 0) continue;
        total += folderEntry.images.length;
        const grid = el(
          'div',
          { class: 'fwa-asset-grid' },
          folderEntry.images.map((img) => renderCard(folderEntry.folderPath, img)),
        );
        listEl.append(
          el('div', { class: 'fwa-asset-folder' }, [
            el('div', { class: 'fwa-asset-folder-title', text: folderEntry.folderPath || '/' }),
            grid,
          ]),
        );
      }
      statusEl.textContent = total === 0 ? '此資料夾及子資料夾內沒有圖片' : `共 ${total} 張圖片`;
    } catch (err) {
      if (token !== loadToken) return;
      statusEl.textContent =
        err instanceof WikijsFolderNotFoundError
          ? err.message
          : `載入失敗：${err instanceof Error ? err.message : String(err)}`;
    }
  };

  const confirmAndDelete = (items: Array<{ id: number; filename: string }>): Promise<void> => {
    return new Promise((resolve) => {
      const confirmModal = openModal(`刪除 ${items.length} 個檔案`, 'fwa-assets-confirm-host');
      let confirmed = false;
      confirmModal.onClose(() => { if (!confirmed) resolve(); });
      confirmModal.body.append(
        el('div', { text: '確定要刪除以下檔案嗎？Wiki.js 沒有資源回收桶，此動作無法復原。' }),
        el(
          'div',
          { class: 'fwa-hint' },
          items.map((i) => el('div', { text: i.filename })),
        ),
      );
      const cancel = el('button', { class: 'fwa-btn', text: '取消' });
      const ok = el('button', { class: 'fwa-btn fwa-btn-danger', text: '刪除' });
      cancel.addEventListener('click', () => {
        confirmModal.close();
        resolve();
      });
      ok.addEventListener('click', async () => {
        confirmed = true;
        confirmModal.close();
        let succeeded = 0;
        const failures: string[] = [];
        for (const item of items) {
          try {
            const result = await deleteWikijsAsset(item.id);
            if (result.succeeded) succeeded++;
            else failures.push(`${item.filename}：${result.message}`);
          } catch (err) {
            failures.push(`${item.filename}：${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (succeeded > 0) showToast(`已刪除 ${succeeded} 個檔案`, 'success');
        if (failures.length > 0) showToast(`刪除失敗：\n${failures.join('\n')}`, 'error', 8000);
        await load();
        resolve();
      });
      confirmModal.footer.append(cancel, ok);
    });
  };

  /**
   * The filename doubles as an inline rename field: click into it, edit the
   * base name, commit on blur/Enter. The extension is split off and shown
   * as a fixed suffix (never editable, never sent to the server for
   * editing) because the server rejects a changed extension outright
   * (AssetRenameInvalidExt). The server also re-lowercases/sanitizes the
   * base name using a different rule than upload normalization (see
   * renameWikijsAsset), so every attempt reloads the whole list afterward
   * instead of assuming the typed name stuck (or didn't) as reported —
   * confirmed on the real site that Wiki.js can patch the DB filename and
   * *then* throw on a later storage step, reporting the whole rename as
   * failed even though the name already changed.
   */
  const renderEditableName = (asset: AssetInfo): HTMLElement => {
    const dot = asset.filename.lastIndexOf('.');
    const base = dot > 0 ? asset.filename.slice(0, dot) : asset.filename;
    const ext = dot > 0 ? asset.filename.slice(dot) : '';

    const input = el('input', { type: 'text', class: 'fwa-asset-name-input', value: base, title: asset.filename, 'aria-label': `重新命名 ${asset.filename}` });
    let committing = false;

    const revert = () => {
      input.value = base;
    };

    const commit = async () => {
      if (committing) return;
      const trimmed = input.value.trim();
      if (!trimmed || trimmed === base) {
        revert();
        return;
      }
      const newFilename = `${trimmed}${ext}`;
      committing = true;
      input.disabled = true;
      let storageRenameFailure = false;
      try {
        const result = await renameWikijsAsset(asset.id, newFilename);
        if (result.succeeded) {
          showToast(`已重新命名：${asset.filename} → ${newFilename}`, 'success');
        } else {
          storageRenameFailure = isWikijsAssetStorageRenameFailure(result.message);
          showToast(
            storageRenameFailure
              ? '重新命名沒有完成：Wiki.js 的儲存空間沒有搬移檔案的權限。請管理員修正 Azure Blob／儲存後端的複製與刪除權限後再試。'
              : `重新命名失敗：${result.message}`,
            'error',
            10000,
          );
        }
      } catch (err) {
        showToast(`重新命名失敗：${err instanceof Error ? err.message : String(err)}`, 'error', 8000);
      } finally {
        // Always reload — never assume the reported outcome reflects what
        // actually happened server-side. Replaces this card (and input)
        // either way, so there's nothing left here to revert/re-enable.
        await load();
        if (storageRenameFailure) {
          statusEl.textContent =
            '注意：Wiki.js 已嘗試更新檔名，但儲存空間拒絕搬移檔案。請先由管理員修正儲存後端權限，再確認圖片是否仍可開啟。';
        }
      }
    };

    input.addEventListener('blur', () => void commit());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        revert();
        input.blur();
      }
    });

    return el('div', { class: 'fwa-asset-name' }, [input, el('span', { class: 'fwa-asset-ext', text: ext })]);
  };

  deleteSelectedBtn.addEventListener('click', () => {
    if (selected.size === 0) return;
    void confirmAndDelete([...selected.entries()].map(([id, filename]) => ({ id, filename })));
  });
  loadBtn.addEventListener('click', () => void load());

  void load();
}

// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { openAssetReviewModal } from '../src/content/asset-review';

vi.mock('../src/content/page-path', () => ({ getCurrentArticlePath: async () => ({ path: 'team/guide' }) }));
vi.mock('../src/content/wikijs-upload', () => ({
  resolveFolderId: async () => ({ id: 1, slugPath: '/team/guide' }),
  listFolderImages: async () => [{ id: 1, filename: 'guide.png', fileSize: 2048, updatedAt: '2026-09-01T00:00:00Z' }],
  listSubFolders: async () => [],
  deleteWikijsAsset: vi.fn(), renameWikijsAsset: vi.fn(),
  isWikijsAssetStorageRenameFailure: () => false,
  WikijsFolderNotFoundError: class extends Error {},
}));

describe('Studio image library', () => {
  it('keeps the library and selection open when a nested delete is canceled with Escape', async () => {
    await openAssetReviewModal();
    const root = document.getElementById('fwa-assets-modal-host')!.shadowRoot!;
    await vi.waitFor(() => expect(root.querySelectorAll('.fwa-asset-card')).toHaveLength(1));
    const bulk = root.querySelector<HTMLButtonElement>('.fwa-modal-footer .fwa-btn-danger')!;
    expect(bulk.disabled).toBe(true);
    expect(root.querySelector('img')?.alt).toBe('guide.png');
    const selected = root.querySelector<HTMLInputElement>('.fwa-asset-card input[type="checkbox"]')!;
    selected.click();
    expect(bulk.disabled).toBe(false);
    bulk.click();
    const confirmation = document.getElementById('fwa-assets-confirm-host')!.shadowRoot!;
    expect(confirmation.querySelector('[role="dialog"]')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(confirmation.querySelector('[role="dialog"]')).toBeNull();
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(selected.checked).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
});

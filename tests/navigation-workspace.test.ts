import { describe, expect, it } from 'vitest';
import { matchesWorkspaceQuery } from '../src/content/main-nav';

describe('workspace and directory search', () => {
  it('shows all items for an empty or whitespace-only query', () => {
    expect(matchesWorkspaceQuery('', '客戶目錄')).toBe(true);
    expect(matchesWorkspaceQuery('  \t ', '客戶目錄')).toBe(true);
  });

  it('finds Chinese names and English aliases without case sensitivity', () => {
    expect(matchesWorkspaceQuery('照片', '照片資料庫', 'images assets')).toBe(true);
    expect(matchesWorkspaceQuery('IMAGES', '照片資料庫', 'images assets')).toBe(true);
  });

  it('matches every search term across different fields', () => {
    expect(matchesWorkspaceQuery('Acme  onboarding', 'ACME', '/clients/acme', 'Onboarding guide')).toBe(true);
    expect(matchesWorkspaceQuery('Acme missing', 'ACME', '/clients/acme', 'Onboarding guide')).toBe(false);
  });

  it('normalizes full-width characters and preserves path searches', () => {
    expect(matchesWorkspaceQuery('ＡＩ', 'AI 排版')).toBe(true);
    expect(matchesWorkspaceQuery('/clients/acme', '客戶 A', '/clients/acme')).toBe(true);
  });

  it('treats punctuation as literal text rather than a regular expression', () => {
    expect(matchesWorkspaceQuery('[', '客戶 [測試]')).toBe(true);
    expect(matchesWorkspaceQuery('.*', '所有客戶')).toBe(false);
  });
});

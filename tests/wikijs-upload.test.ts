import { describe, expect, it } from 'vitest';
import {
  isWikijsAssetStorageRenameFailure,
  normalizeWikijsFileName,
} from '../src/content/wikijs-upload';
import { wikiConfig } from '../src/config/wiki-config';

describe('normalizeWikijsFileName (mirrors Wiki.js 2.x server rules)', () => {
  it('lowercases and converts whitespace to underscores', () => {
    expect(normalizeWikijsFileName('My Screen Shot.PNG')).toBe('my_screen_shot.png');
  });

  it('converts commas, semicolons and hashes to underscores', () => {
    expect(normalizeWikijsFileName('a,b;c#d.png')).toBe('a_b_c_d.png');
  });

  it('strips characters removed by sanitize-filename', () => {
    expect(normalizeWikijsFileName('a<b>:c?*|d.png')).toBe('abcd.png');
  });

  it('keeps CJK characters', () => {
    expect(normalizeWikijsFileName('架構 圖.png')).toBe('架構_圖.png');
  });

  it('falls back to image when nothing is left', () => {
    expect(normalizeWikijsFileName('???.png')).toBe('image.png');
  });
});

describe('isWikijsAssetStorageRenameFailure', () => {
  it('recognizes the Azure Blob authorization response from a failed storage move', () => {
    expect(
      isWikijsAssetStorageRenameFailure('This request is not authorized to perform this operation. RequestId:abc'),
    ).toBe(true);
  });

  it('does not confuse a normal Wiki.js folder permission denial with a storage failure', () => {
    expect(isWikijsAssetStorageRenameFailure('You are not authorized to rename this asset.')).toBe(false);
  });
});

describe('deriveFolderFromPath (Wiki.js URL rules, nothing hardcoded)', () => {
  const derive = wikiConfig.assets.deriveFolderFromPath;

  it('derives folder from a view URL with locale prefix', () => {
    expect(
      derive('/en/eng/MeetingMinutes/DailyOperationMeeting/OperationMeeting20260723_C'),
    ).toBe('/eng/MeetingMinutes/DailyOperationMeeting');
  });

  it('derives folder from an edit URL (/e/ prefix)', () => {
    expect(derive('/e/en/eng/ExtensionTest')).toBe('/eng');
  });

  it('handles multi-part locales like zh-tw', () => {
    expect(derive('/zh-tw/docs/clients/example-client/some-page')).toBe('/docs/clients/example-client');
  });

  it('returns null for top-level pages (no folder to derive)', () => {
    expect(derive('/en/home')).toBeNull();
    expect(derive('/')).toBeNull();
  });
});

describe('folderForArticlePath (currentPath strategy — default, real-site verified)', () => {
  it('uses the full article path, including the article name itself', () => {
    expect(wikiConfig.assets.folderForArticlePath('docs/clients/example-client/SOP/onboarding')).toBe(
      '/docs/clients/example-client/SOP/onboarding',
    );
  });

  it('preserves case and CJK — Wiki.js Assets folders accept both (confirmed via GraphQL createFolder)', () => {
    expect(wikiConfig.assets.folderForArticlePath('eng/ExtensionTest')).toBe('/eng/ExtensionTest');
  });

  it('falls back to the default uploads folder for the homepage', () => {
    expect(wikiConfig.assets.folderForArticlePath('home')).toBe('/uploads');
  });

  it('falls back to the default uploads folder for an empty path', () => {
    expect(wikiConfig.assets.folderForArticlePath('')).toBe('/uploads');
  });

  it('drops "../", empty segments and repeated slashes defensively', () => {
    expect(wikiConfig.assets.folderForArticlePath('docs//../clients///example-client')).toBe('/docs/clients/example-client');
  });
});

describe('parentFolderForArticlePath (parentFolder strategy)', () => {
  it('drops the article name, keeping the containing directory', () => {
    expect(wikiConfig.assets.parentFolderForArticlePath('docs/clients/example-client/SOP/onboarding')).toBe(
      '/docs/clients/example-client/SOP',
    );
  });

  it('falls back to the default uploads folder for a top-level article', () => {
    expect(wikiConfig.assets.parentFolderForArticlePath('ExtensionTest')).toBe('/uploads');
  });
});

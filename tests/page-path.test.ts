import { describe, expect, it } from 'vitest';
import { pathFromEditUrl } from '../src/content/page-path';

describe('pathFromEditUrl (URL fallback, only used if the Vuex bridge is unavailable)', () => {
  it('derives locale + full path (article name included) from an edit URL', () => {
    expect(pathFromEditUrl('/e/en/docs/clients/example-client/SOP/onboarding')).toEqual({
      locale: 'en',
      path: 'docs/clients/example-client/SOP/onboarding',
    });
  });

  it('handles multi-part locales like zh-tw', () => {
    expect(pathFromEditUrl('/e/zh-tw/eng/ExtensionTest')).toEqual({
      locale: 'zh-tw',
      path: 'eng/ExtensionTest',
    });
  });

  it('returns null for non-edit URLs', () => {
    expect(pathFromEditUrl('/en/eng/ExtensionTest')).toBeNull();
  });

  it('returns null when nothing follows the locale', () => {
    expect(pathFromEditUrl('/e/en')).toBeNull();
  });
});

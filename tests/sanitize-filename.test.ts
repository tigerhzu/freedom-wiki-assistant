import { describe, expect, it } from 'vitest';
import {
  buildImageMarkdown,
  encodeAssetPath,
  fileExtension,
  sanitizeFileName,
  uniqueFileName,
} from '../src/content/sanitize-filename';

describe('sanitizeFileName', () => {
  it('converts spaces to dashes and keeps the extension', () => {
    expect(sanitizeFileName('my screen shot.PNG')).toBe('my-screen-shot.png');
  });

  it('strips unsafe characters', () => {
    expect(sanitizeFileName('a<b>:c?*|d.png')).toBe('abcd.png');
  });

  it('keeps Chinese characters', () => {
    expect(sanitizeFileName('架構 圖.png')).toBe('架構-圖.png');
  });

  it('collapses repeated dashes and trims edge dashes/dots', () => {
    expect(sanitizeFileName('--a  b--.png')).toBe('a-b.png');
  });

  it('falls back to "image" when nothing is left', () => {
    expect(sanitizeFileName('###.png')).toBe('image.png');
  });
});

describe('uniqueFileName', () => {
  it('returns the name unchanged when unused', () => {
    expect(uniqueFileName('a.png', [])).toBe('a.png');
  });

  it('appends -1, -2 for duplicates and never overwrites (case-insensitive)', () => {
    expect(uniqueFileName('a.png', ['a.png'])).toBe('a-1.png');
    expect(uniqueFileName('a.png', ['A.PNG', 'a-1.png'])).toBe('a-2.png');
  });
});

describe('encodeAssetPath', () => {
  it('URL-encodes CJK segments but keeps slashes', () => {
    expect(encodeAssetPath('/eng/客戶/架構圖.png')).toBe(
      '/eng/%E5%AE%A2%E6%88%B6/%E6%9E%B6%E6%A7%8B%E5%9C%96.png',
    );
  });
});

describe('helpers', () => {
  it('fileExtension', () => {
    expect(fileExtension('a.JPG')).toBe('jpg');
    expect(fileExtension('noext')).toBe('');
  });

  it('buildImageMarkdown', () => {
    expect(buildImageMarkdown('![{name}]({url})', 'a.png', '/eng/a.png')).toBe('![a.png](/eng/a.png)');
  });
});

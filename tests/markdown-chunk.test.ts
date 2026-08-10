import { describe, expect, it } from 'vitest';
import { AI_CHUNK_CHARS, splitMarkdownForAi } from '../src/content/markdown-chunk';

const para = (label: string, size: number): string => `${label}${'字'.repeat(size)}`;

describe('splitMarkdownForAi', () => {
  it('returns a single chunk when the content is within the safe length', () => {
    const text = '# 標題\n\n短短的一段內容。';
    expect(splitMarkdownForAi(text)).toEqual([text]);
  });

  it('returns nothing for blank content', () => {
    expect(splitMarkdownForAi('   \n\n  ')).toEqual([]);
  });

  it('splits long content into several chunks, each within the limit', () => {
    const text = Array.from({ length: 8 }, (_, i) => para(`段落${i}：`, 500)).join('\n\n');
    const chunks = splitMarkdownForAi(text, 1200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1200);
  });

  it('never splits a fenced code block across chunks', () => {
    const fence = ['```powershell', ...Array.from({ length: 40 }, (_, i) => `Get-Item ${i}`), '```'].join('\n');
    const text = [para('前言：', 400), fence, para('後記：', 400)].join('\n\n');
    const chunks = splitMarkdownForAi(text, 500);
    for (const chunk of chunks) {
      const fenceCount = (chunk.match(/^```/gm) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
    expect(chunks.some((c) => c.includes('```powershell') && c.includes('Get-Item 39'))).toBe(true);
  });

  it('never splits a table across chunks', () => {
    const table = ['| 欄 | 值 |', '| --- | --- |', ...Array.from({ length: 30 }, (_, i) => `| a${i} | b${i} |`)].join(
      '\n',
    );
    const text = [para('前言：', 400), table].join('\n\n');
    const chunks = splitMarkdownForAi(text, 400);
    const withTable = chunks.filter((c) => c.includes('| --- |'));
    expect(withTable).toHaveLength(1);
    expect(withTable[0]).toContain('| a29 | b29 |');
  });

  it('never splits a list across chunks', () => {
    const list = Array.from({ length: 40 }, (_, i) => `- 第 ${i} 步，這是一個比較長的步驟說明文字。`).join('\n');
    const chunks = splitMarkdownForAi([para('前言：', 300), list].join('\n\n'), 500);
    const withList = chunks.filter((c) => c.includes('- 第 0 步'));
    expect(withList).toHaveLength(1);
    expect(withList[0]).toContain('- 第 39 步');
  });

  it('prefers to start a new chunk at a heading', () => {
    const text = [
      '## 第一章',
      para('內容：', 900),
      '## 第二章',
      para('內容：', 900),
      '## 第三章',
      para('內容：', 900),
    ].join('\n\n');
    const chunks = splitMarkdownForAi(text, 1500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(1)) expect(chunk.startsWith('## ')).toBe(true);
  });

  it('keeps an oversized single block whole instead of cutting it', () => {
    const fence = ['```', 'x'.repeat(3000), '```'].join('\n');
    const chunks = splitMarkdownForAi(fence, 500);
    expect(chunks).toEqual([fence]);
  });

  it('normalizes CRLF before chunking', () => {
    expect(splitMarkdownForAi('a\r\nb')).toEqual(['a\nb']);
  });

  it('keeps the default chunk size well under the 4096 max_tokens output budget', () => {
    expect(AI_CHUNK_CHARS).toBeLessThanOrEqual(3000);
  });
});

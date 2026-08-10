import { describe, expect, it } from 'vitest';
import { quickFormat, splitMarkdownBlocks } from '../src/content/quick-format';

const lines = (text: string): string[] => text.split('\n');

describe('quickFormat 空行與間距', () => {
  it('collapses runs of blank lines down to one', () => {
    expect(quickFormat('第一段\n\n\n\n第二段')).toBe('第一段\n\n第二段');
  });

  it('inserts a blank line before and after a heading', () => {
    expect(quickFormat('說明文字\n## 章節\n內文')).toBe('說明文字\n\n## 章節\n\n內文');
  });

  it('inserts a blank line around a fenced code block', () => {
    const input = ['前言', '```bash', 'ls -la', '```', '後記'].join('\n');
    expect(quickFormat(input)).toBe(['前言', '', '```bash', 'ls -la', '```', '', '後記'].join('\n'));
  });

  it('separates a list block from the surrounding paragraphs', () => {
    const input = ['步驟如下：', '- 第一步', '- 第二步', '完成後請回報。'].join('\n');
    // 「完成後請回報。」是 lazy continuation，屬於清單項，不能被切出去。
    expect(quickFormat(input)).toBe(['步驟如下：', '', '- 第一步', '- 第二步', '完成後請回報。'].join('\n'));
  });

  it('keeps a tight list tight', () => {
    const input = ['- a', '- b', '- c'].join('\n');
    expect(quickFormat(input)).toBe(input);
  });

  it('collapses extra blank lines inside a loose list without splitting it', () => {
    const input = ['- a', '', '', '- b'].join('\n');
    expect(quickFormat(input)).toBe(['- a', '', '- b'].join('\n'));
  });

  it('strips leading blank lines and keeps a single trailing newline when the input had one', () => {
    expect(quickFormat('\n\n內容\n\n\n')).toBe('內容\n');
    expect(quickFormat('內容')).toBe('內容');
  });

  it('collapses the whitespace after a heading marker', () => {
    expect(quickFormat('##    章節')).toBe('## 章節');
  });

  it('does not turn a non-heading into a heading', () => {
    // `#章節` 在 CommonMark 裡不是標題；補上空格會改變渲染結果。
    expect(quickFormat('#章節')).toBe('#章節');
  });

  it('is idempotent', () => {
    const messy = [
      '# 標題',
      '說明',
      '## 步驟',
      '',
      '',
      '1. 第一步',
      '2. 第二步',
      '```powershell',
      'Get-Service   ',
      '```',
      '> **警告：** 會中斷服務',
      '| 欄 | 值 |',
      '| --- | --- |',
      '| a | b |',
    ].join('\n');
    const once = quickFormat(messy);
    expect(quickFormat(once)).toBe(once);
  });
});

describe('quickFormat 保留規則', () => {
  it('never touches anything inside a fenced code block', () => {
    const input = ['```', '  縮排的程式碼', '', '', '#不是標題', '   ', '```'].join('\n');
    expect(quickFormat(input)).toBe(input);
  });

  it('preserves URLs, IPs, image paths and inline code verbatim', () => {
    const input = [
      '請連到 https://wiki.example.invalid/docs/Test?a=1#frag 確認。',
      '主機 10.0.0.5 的設定在 `C:\\Program Files\\app\\config.ini`。',
      '![螢幕截圖](/assets/eng/test/shot%201.png)',
      '[附件：SOP](https://example.com/a(b).pdf)',
    ].join('\n');
    const out = quickFormat(input);
    expect(out).toContain('https://wiki.example.invalid/docs/Test?a=1#frag');
    expect(out).toContain('10.0.0.5');
    expect(out).toContain('`C:\\Program Files\\app\\config.ini`');
    expect(out).toContain('![螢幕截圖](/assets/eng/test/shot%201.png)');
    expect(out).toContain('[附件：SOP](https://example.com/a(b).pdf)');
  });

  it('leaves the inside of a block-format <div> wrapper untouched', () => {
    const input = [
      '<div style="border: 1px solid red; padding: 8px;">',
      '',
      '**重點**',
      '',
      '</div>',
    ].join('\n');
    expect(quickFormat(input)).toBe(input);
  });

  it('does not change indentation', () => {
    const input = ['- 第一層', '   - 三個空格的第二層', '       - 七個空格的第三層'].join('\n');
    expect(quickFormat(input)).toBe(input);
  });

  it('keeps a Markdown hard line break (two trailing spaces) but drops other trailing whitespace', () => {
    expect(quickFormat('第一行  \n第二行   ')).toBe('第一行  \n第二行');
    expect(quickFormat('唯一一行  ')).toBe('唯一一行');
  });

  it('preserves a setext heading underline instead of splitting it off', () => {
    expect(quickFormat('標題\n====')).toBe('標題\n====');
  });

  it('does not create a table out of pipe lines that follow a paragraph', () => {
    // GFM 的表格無法打斷段落；插入空行會把原本不是表格的內容變成表格。
    const input = ['說明文字', '| a | b |', '| --- | --- |'].join('\n');
    expect(quickFormat(input)).toBe(input);
  });

  it('normalizes CRLF line endings', () => {
    expect(quickFormat('a\r\n\r\n\r\nb')).toBe('a\n\nb');
  });
});

describe('splitMarkdownBlocks', () => {
  it('keeps a fenced code block as one block including blank lines', () => {
    const blocks = splitMarkdownBlocks(lines(['前言', '```', 'a', '', 'b', '```', '後記'].join('\n')));
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'fence', 'paragraph']);
    expect(blocks[1].lines).toEqual(['```', 'a', '', 'b', '```']);
  });

  it('keeps a table as one block', () => {
    const blocks = splitMarkdownBlocks(lines(['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('table');
  });

  it('keeps a <div> wrapper as one html block', () => {
    const blocks = splitMarkdownBlocks(lines(['<div style="text-align: center;">', '', '內容', '', '</div>'].join('\n')));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('html');
    expect(blocks[0].lines).toHaveLength(5);
  });

  it('treats an unclosed block tag as a paragraph rather than swallowing the rest', () => {
    const blocks = splitMarkdownBlocks(lines(['<div>', '內容', '', '## 後面的章節'].join('\n')));
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'heading']);
  });

  it('splits each heading into its own block', () => {
    const blocks = splitMarkdownBlocks(lines(['# A', '## B', '內文'].join('\n')));
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'heading', 'paragraph']);
  });

  it('drops blank-only input', () => {
    expect(splitMarkdownBlocks(lines('\n\n  \n'))).toEqual([]);
  });
});

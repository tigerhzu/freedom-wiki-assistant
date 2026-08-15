import { describe, expect, it } from 'vitest';
import { findMarkdownTextRanges, findNormalizedTextRange } from '../src/content/visual-selection';

describe('findNormalizedTextRange', () => {
  it('maps browser-collapsed whitespace back to exact Markdown offsets', () => {
    const source = '> 第一行\n第二行   內容\n第三行';
    const selected = '第一行 第二行 內容';
    const range = findNormalizedTextRange(source, selected);

    expect(range).not.toBeNull();
    expect(source.slice(range!.start, range!.end)).toBe('第一行\n第二行   內容');
  });

  it('can locate a partial selection after a blockquote marker', () => {
    const source = '> 警告內容\n下一項';
    const range = findNormalizedTextRange(source, '警告內容');

    expect(range).not.toBeNull();
    expect(source.slice(range!.start, range!.end)).toBe('警告內容');
  });

  it('refuses an ambiguous selection instead of choosing the wrong occurrence', () => {
    expect(findNormalizedTextRange('重複文字\n重複文字', '重複文字')).toBeNull();
  });
});

describe('findMarkdownTextRanges', () => {
  it('maps a two-line rendered selection through separate bold wrappers', () => {
    const source = '**第一行粗體**\n**第二行粗體**';
    const ranges = findMarkdownTextRanges(source, '第一行粗體\n第二行粗體');

    expect(ranges?.map((range) => source.slice(range.start, range.end))).toEqual([
      '第一行粗體',
      '第二行粗體',
    ]);
  });

  it('ignores list markers, link targets, HTML formatting and Wiki.js directives', () => {
    const source = [
      '1. [文件名稱](/private/path.docx)',
      '2. <font color="red">紅色內容</font>',
      '{.is-danger}',
    ].join('\n');
    const ranges = findMarkdownTextRanges(source, '文件名稱\n紅色內容');

    expect(ranges?.map((range) => source.slice(range.start, range.end))).toEqual([
      '文件名稱',
      '紅色內容',
    ]);
  });

  it('maps a table-cell selection through a renderer wrapper and font tag', () => {
    const source = [
      '## 全愛外',
      '',
      '| 客戶名稱 | 組別 | 速撥碼 | 備註 | TAM |',
      '| --- | --- | --- | --- | --- |',
      '| [PHE/智璞](/eng/customers/phe) | OpA | 712 | <font color="red">PME</font> | |',
    ].join('\n');
    const ranges = findMarkdownTextRanges(source, 'PME');

    expect(ranges).toEqual([{ start: source.indexOf('PME'), end: source.indexOf('PME') + 3 }]);
    expect(source.slice(ranges![0].start, ranges![0].end)).toBe('PME');
  });

  it('refuses ambiguous projected text', () => {
    expect(findMarkdownTextRanges('**重複**\n*重複*', '重複')).toBeNull();
  });
});

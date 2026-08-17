import { describe, expect, it } from 'vitest';
import {
  findMarkdownTextRangeCandidates,
  findMarkdownTextRanges,
  findNormalizedTextRange,
} from '../src/content/visual-selection';

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

  it('exposes repeated projected occurrences for DOM-based disambiguation', () => {
    const source = '第一個手機\n第二個手機';
    const candidates = findMarkdownTextRangeCandidates(source, '手機');

    expect(candidates).toHaveLength(2);
    expect(candidates?.map((ranges) => source.slice(ranges[0].start, ranges[0].end))).toEqual([
      '手機',
      '手機',
    ]);
  });

  it('maps a selection across HTML color and bold Markdown syntax', () => {
    const source = '2. **設定雲端電話系統**，須<font color="red">設定分機</font> & **手機 (軟體_eVox易熙)** //在 DC01 上收信';
    const ranges = findMarkdownTextRanges(source, '& 手機 (軟體_eVox易熙) //在 DC01 上收信');

    expect(ranges?.map((range) => source.slice(range.start, range.end))).toEqual([
      '& ',
      '手機 (軟體_eVox易熙)',
      ' //在 DC01 上收信',
    ]);

    const wider = findMarkdownTextRanges(source, '設定分機 & 手機 (軟體_eVox易熙) //在 DC01 上收信');
    expect(wider?.map((range) => source.slice(range.start, range.end))).toEqual([
      '設定分機',
      ' & ',
      '手機 (軟體_eVox易熙)',
      ' //在 DC01 上收信',
    ]);
  });

  it('decodes browser-rendered HTML entities before mapping to source', () => {
    const source = '2. **設定** &amp; <span style="color:red">手機&nbsp;分機</span> &#x1F4DE;';
    const ranges = findMarkdownTextRanges(source, '設定 & 手機 分機 📞');

    expect(ranges?.map((range) => source.slice(range.start, range.end))).toEqual([
      '設定',
      ' &amp; ',
      '手機&nbsp;分機',
      ' &#x1F4DE;',
    ]);
  });

  it('recognizes additional inline markers without treating the visible syntax as text', () => {
    const source = '___粗體斜體___ ==醒目== ~~刪除~~';
    const ranges = findMarkdownTextRanges(source, '粗體斜體 醒目 刪除');

    expect(ranges?.map((range) => source.slice(range.start, range.end))).toEqual([
      '粗體斜體',
      '醒目',
      '刪除',
    ]);
  });

  it('keeps an underscore inside an identifier as visible text', () => {
    const source = '**軟體_eVox易熙**';
    const ranges = findMarkdownTextRanges(source, '軟體_eVox易熙');

    expect(ranges).toEqual([{ start: 2, end: source.length - 2 }]);
  });

  it('maps literal Markdown markers when the renderer exposes them as text', () => {
    const source = '(<font color="purple">窗口</font>會提供分機和手機，並加入**該員工的手機號碼，**才能接收簡訊驗證**)';
    const selected = '**該員工的手機號碼，**才能接收簡訊驗證**)';
    const ranges = findMarkdownTextRanges(source, selected);

    expect(ranges?.map((range) => source.slice(range.start, range.end))).toEqual([selected]);
  });
});

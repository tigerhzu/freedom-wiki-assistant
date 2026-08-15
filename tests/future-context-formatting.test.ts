import { describe, expect, it } from 'vitest';
import {
  applyBox,
  applyCustomColor,
  changeIndent,
  removeBox,
  setBlockAlign,
  stripHtml,
  toggleBlockquote,
} from '../src/content/block-format';
import { BOX_PRESETS, DEFAULT_BOX } from '../src/content/html-style';
import {
  applyColor,
  applySize,
  clearFormatting,
  toggleBold,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleStrike,
  toggleUnderline,
  type EditResult,
} from '../src/content/markdown-format';
import { findMarkdownTextRanges } from '../src/content/visual-selection';

type EditFn = (text: string, start: number, end: number) => EditResult;

const TARGET = 'MDO P1授權';
const ARTICLE = [
  '# APR 新旭 SOP',
  '',
  '> 離職人員暫無SOP，請依照案件TICKET的內容執行',
  '每月定期產出 Worry free & O365 的office 授權 清單',
  '{.is-danger}',
  '',
  '## Client',
  '',
  '1. [新旭usb權限sop.docx](/eng/customers/apr/usb.docx)',
  '2. [新旭人員到職sop.docx](/eng/customers/apr/onboard.docx)',
  '',
  `(2023/1/1 新人到職，每位員工都要給予 ${TARGET})`,
  '',
  '3. 離職人員處理-窗口會發案件，根據案件上的敘述作業方式即可。',
  '',
  '> 2023/1/1 新人到職，每位員工都要給予 MOD P1授權',
  '{.is-danger}',
].join('\n');

const TABLE_ARTICLE = [
  '## 全愛外',
  '',
  '| 客戶名稱 | 組別 | 速撥碼 | 備註 | TAM |',
  '| --- | --- | --- | --- | --- |',
  '| [PHE/智璞](/eng/customers/phe) | OpA | 712 | <font color="red">PME</font> | |',
].join('\n');

function applyAtTarget(edit: EditFn, source = ARTICLE, target = TARGET): EditResult {
  const start = source.indexOf(target);
  expect(start).toBeGreaterThanOrEqual(0);
  return edit(source, start, start + target.length);
}

function expectOnlyTargetChanged(edit: EditFn, replacement: string): void {
  const result = applyAtTarget(edit);
  expect(result.text).toBe(ARTICLE.replace(TARGET, replacement));
}

describe('Future right-click inline formatting', () => {
  const cases: Array<[string, EditFn, string]> = [
    ['字色', (text, start, end) => applyColor(text, start, end, 'red'), `<font color="red">${TARGET}</font>`],
    ['小字', (text, start, end) => applySize(text, start, end, '12px'), `<span style="font-size:12px">${TARGET}</span>`],
    ['中字', (text, start, end) => applySize(text, start, end, '18px'), `<span style="font-size:18px">${TARGET}</span>`],
    ['大字', (text, start, end) => applySize(text, start, end, '24px'), `<span style="font-size:24px">${TARGET}</span>`],
    ['特大字', (text, start, end) => applySize(text, start, end, '32px'), `<span style="font-size:32px">${TARGET}</span>`],
    ['粗體', toggleBold, `**${TARGET}**`],
    ['斜體', toggleItalic, `*${TARGET}*`],
    ['底線', toggleUnderline, `<u>${TARGET}</u>`],
    ['刪除線', toggleStrike, `~~${TARGET}~~`],
    ['背景標記', toggleHighlight, `<mark>${TARGET}</mark>`],
    ['程式碼', toggleInlineCode, `\`${TARGET}\``],
    [
      '自訂背景顏色',
      (text, start, end) => applyCustomColor(text, start, end, 'background-color', '#fff3a3'),
      `<span style="background-color: #fff3a3;">${TARGET}</span>`,
    ],
  ];

  it.each(cases)('%s只修改反白內容，不改動清單、連結、換行或 Wiki.js directive', (_label, edit, replacement) => {
    expectOnlyTargetChanged(edit, replacement);
  });

  it('一般大小只移除既有字級 wrapper', () => {
    const wrapped = ARTICLE.replace(TARGET, `<span style="font-size:24px">${TARGET}</span>`);
    const result = applyAtTarget((text, start, end) => applySize(text, start, end, null), wrapped);
    expect(result.text).toBe(ARTICLE);
  });

  it('清除格式只移除選取文字周圍由選單產生的格式', () => {
    const wrapped = ARTICLE.replace(TARGET, `<font color="red"><u>**${TARGET}**</u></font>`);
    const result = applyAtTarget(clearFormatting, wrapped);
    expect(result.text).toBe(ARTICLE);
  });

  it('跨兩行反白會逐行套用格式，不讓 wrapper 穿過換行或既有粗體', () => {
    const source = '**第一行內容**\n**第二行內容**';
    const ranges = findMarkdownTextRanges(source, '第一行內容\n第二行內容');
    expect(ranges).not.toBeNull();

    let next = source;
    for (let index = ranges!.length - 1; index >= 0; index--) {
      next = applyColor(next, ranges![index].start, ranges![index].end, 'red').text;
    }
    expect(next).toBe(
      '**<font color="red">第一行內容</font>**\n**<font color="red">第二行內容</font>**',
    );
  });

  it('跨兩行套用粗體會產生兩組完整標記，不跨行包成一大段', () => {
    const source = '第一行內容\n第二行內容';
    const ranges = findMarkdownTextRanges(source, source);
    expect(ranges).toHaveLength(2);

    let next = source;
    for (let index = ranges!.length - 1; index >= 0; index--) {
      next = toggleBold(next, ranges![index].start, ranges![index].end).text;
    }
    expect(next).toBe('**第一行內容**\n**第二行內容**');
  });

  it('表格儲存格反白可安全套用所有文字格式，不破壞 Markdown 表格結構', () => {
    const ranges = findMarkdownTextRanges(TABLE_ARTICLE, 'PME');
    expect(ranges).toHaveLength(1);
    const target = ranges![0];
    const cases: Array<[string, EditFn]> = [
      ['字色', (text, start, end) => applyColor(text, start, end, 'blue')],
      ['字級', (text, start, end) => applySize(text, start, end, '18px')],
      ['粗體', toggleBold],
      ['斜體', toggleItalic],
      ['底線', toggleUnderline],
      ['刪除線', toggleStrike],
      ['背景標記', toggleHighlight],
      ['程式碼', toggleInlineCode],
      ['清除格式', clearFormatting],
    ];

    for (const [label, edit] of cases) {
      const result = edit(TABLE_ARTICLE, target.start, target.end);
      expect(result.text, label).toContain('| [PHE/智璞](/eng/customers/phe) | OpA | 712 |');
      expect(result.text, label).toContain('PME');
      expect(result.text, label).toContain('| |');
      expect((result.text.match(/^\|/gm) ?? []).length, label).toBe(3);
    }
  });
});

describe('Future right-click block formatting', () => {
  const blockTarget = '3. 離職人員處理-窗口會發案件，根據案件上的敘述作業方式即可。';

  function applyBlock(edit: EditFn, source = ARTICLE): EditResult {
    const start = source.indexOf(blockTarget);
    return edit(source, start, start + blockTarget.length);
  }

  function expectSentinelsPreserved(result: EditResult): void {
    expect(result.text).toContain('1. [新旭usb權限sop.docx](/eng/customers/apr/usb.docx)');
    expect(result.text).toContain('2. [新旭人員到職sop.docx](/eng/customers/apr/onboard.docx)');
    expect(result.text).toContain('> 離職人員暫無SOP，請依照案件TICKET的內容執行\n每月定期產出 Worry free & O365 的office 授權 清單\n{.is-danger}');
    expect(result.text).toContain('> 2023/1/1 新人到職，每位員工都要給予 MOD P1授權\n{.is-danger}');
  }

  it('引用區塊只切換選取行', () => {
    const result = applyBlock(toggleBlockquote);
    expect(result.text).toContain(`> ${blockTarget}`);
    expectSentinelsPreserved(result);
  });

  it.each(['left', 'center', 'right'] as const)('%s 對齊只包住選取行', (align) => {
    const result = applyBlock((text, start, end) => setBlockAlign(text, start, end, align));
    expect(result.text).toContain(`<div style="text-align: ${align};">\n\n${blockTarget}\n\n</div>`);
    expectSentinelsPreserved(result);
  });

  it('取消對齊會移除既有 wrapper 且還原原文', () => {
    const aligned = applyBlock((text, start, end) => setBlockAlign(text, start, end, 'center')).text;
    const start = aligned.indexOf(blockTarget);
    const result = setBlockAlign(aligned, start, start + blockTarget.length, null);
    expect(result.text).toBe(ARTICLE);
  });

  it('增加與減少縮排可以完整往返', () => {
    const indented = applyBlock((text, start, end) => changeIndent(text, start, end, 1));
    expect(indented.text).toContain('margin-left: 2em;');
    const start = indented.text.indexOf(blockTarget);
    const restored = changeIndent(indented.text, start, start + blockTarget.length, -1);
    expect(restored.text).toBe(ARTICLE);
  });

  it('清除 HTML 不會改寫選取範圍外的文章', () => {
    const decorated = ARTICLE.replace(blockTarget, `<span style="color: red;">${blockTarget}</span>`);
    const start = decorated.indexOf(blockTarget);
    const result = stripHtml(decorated, start, start + blockTarget.length);
    expect(result.text).toBe(ARTICLE);
  });

  it('一般、實線、虛線與所有快速資訊框都保留範圍外內容', () => {
    const specs = [
      DEFAULT_BOX,
      { ...DEFAULT_BOX, width: '2px' },
      { ...DEFAULT_BOX, width: '2px', style: 'dashed', color: '#6c757d' },
      ...BOX_PRESETS.map((preset) => preset.spec),
    ];
    for (const spec of specs) {
      const boxed = applyBlock((text, start, end) => applyBox(text, start, end, spec));
      expect(boxed.text).toContain(blockTarget);
      expectSentinelsPreserved(boxed);
      const start = boxed.text.indexOf(blockTarget);
      const restored = removeBox(boxed.text, start, start + blockTarget.length);
      expect(restored.text).toBe(ARTICLE);
    }
  });
});

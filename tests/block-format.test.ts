import { describe, expect, it } from 'vitest';
import {
  applyBox,
  applyBoxPatch,
  applyCustomColor,
  changeIndent,
  expandToLines,
  readBoxAt,
  removeBlockWrapper,
  removeBox,
  setBlockAlign,
  stripHtml,
  toggleBlockquote,
} from '../src/content/block-format';
import { BOX_PRESETS, DEFAULT_BOX } from '../src/content/html-style';

const PLAIN_BOX =
  '<div style="border: 1px solid #cccccc; border-radius: 6px; padding: 10px; margin: 8px 0;">';

describe('expandToLines', () => {
  it('grows to whole lines without swallowing the next one', () => {
    const text = 'aaa\nbbb\nccc';
    expect(expandToLines(text, 5, 6)).toEqual({ start: 4, end: 7 });
    expect(expandToLines(text, 4, 8)).toEqual({ start: 4, end: 7 });
  });
});

describe('applyBox', () => {
  it('wraps a single line in the documented format', () => {
    const r = applyBox('選取的內容', 0, 5, DEFAULT_BOX);
    expect(r.text).toBe(`${PLAIN_BOX}\n選取的內容\n</div>`);
    expect(r.text.slice(r.start, r.end)).toBe('選取的內容');
  });

  it('wraps multiple lines in one div', () => {
    const text = '第一行\n第二行';
    const r = applyBox(text, 0, text.length, DEFAULT_BOX);
    expect(r.text).toBe(`${PLAIN_BOX}\n第一行\n第二行\n</div>`);
    expect(r.text.match(/<div/g)).toHaveLength(1);
  });

  it('keeps inner Markdown parseable by padding with blank lines', () => {
    const text = '**重點** 與 ![圖](/a/b.png)';
    const r = applyBox(text, 0, text.length, DEFAULT_BOX);
    expect(r.text).toBe(`${PLAIN_BOX}\n\n${text}\n\n</div>`);
    expect(r.text.slice(r.start, r.end)).toBe(text);
  });

  it('produces the accent box from the spec', () => {
    const preset = BOX_PRESETS.find((p) => p.label === '紅色警告框')!;
    const r = applyBox('選取的內容', 0, 5, preset.spec);
    expect(r.text).toBe(
      '<div style="border-left: 4px solid #dc3545; background-color: #fff5f5;' +
        ' padding: 10px 12px; margin: 8px 0;">\n選取的內容\n</div>',
    );
  });

  it('re-styles an existing box instead of nesting a second div', () => {
    const boxed = applyBox('內容', 0, 2, DEFAULT_BOX);
    const preset = BOX_PRESETS.find((p) => p.label === '黃色注意框')!;
    const again = applyBox(boxed.text, boxed.start, boxed.end, preset.spec);
    expect(again.text.match(/<div/g)).toHaveLength(1);
    expect(again.text).toContain('border-left: 4px solid #ffc107;');
    expect(again.text).not.toContain('border: 1px solid');
    expect(again.text.slice(again.start, again.end)).toBe('內容');
  });

  it('re-styles from a caret inside the box (no selection of the div lines)', () => {
    const boxed = applyBox('內容', 0, 2, DEFAULT_BOX).text;
    const caret = boxed.indexOf('內容');
    const again = applyBox(boxed, caret, caret, DEFAULT_BOX);
    expect(again.text.match(/<div/g)).toHaveLength(1);
  });

  it('re-styles when the selection covers the whole box including its div lines', () => {
    const boxed = applyBox('內容', 0, 2, DEFAULT_BOX).text;
    const again = applyBox(boxed, 0, boxed.length, BOX_PRESETS[1].spec);
    expect(again.text.match(/<div/g)).toHaveLength(1);
    expect(again.text).toContain('border-left: 4px solid #0d6efd;');
  });
});

describe('applyBoxPatch', () => {
  it('changes one aspect and keeps the rest', () => {
    const boxed = applyBox('內容', 0, 2, DEFAULT_BOX);
    const r = applyBoxPatch(boxed.text, boxed.start, boxed.end, { color: '#ff0000', width: '3px' });
    expect(r.text).toContain('border: 3px solid #ff0000;');
    expect(r.text).toContain('border-radius: 6px;');
    expect(r.text).toContain('padding: 10px;');
  });

  it('creates a default box when there is none yet', () => {
    const r = applyBoxPatch('內容', 0, 2, { style: 'dashed' });
    expect(r.text).toContain('border: 1px solid #cccccc'.replace('solid', 'dashed'));
  });

  it('keeps the accent side when only the color changes', () => {
    const boxed = applyBox('內容', 0, 2, BOX_PRESETS[3].spec);
    const r = applyBoxPatch(boxed.text, boxed.start, boxed.end, { color: '#000000' });
    expect(r.text).toContain('border-left: 4px solid #000000;');
    expect(r.text).not.toContain('border:');
  });

  it('removes the radius when 無 is chosen', () => {
    const boxed = applyBox('內容', 0, 2, DEFAULT_BOX);
    const r = applyBoxPatch(boxed.text, boxed.start, boxed.end, { radius: '' });
    expect(r.text).not.toContain('border-radius');
  });
});

describe('readBoxAt', () => {
  it('reads back the applied spec', () => {
    const boxed = applyBox('內容', 0, 2, DEFAULT_BOX);
    expect(readBoxAt(boxed.text, boxed.start, boxed.end)).toEqual(DEFAULT_BOX);
  });

  it('returns null without a box', () => {
    expect(readBoxAt('內容', 0, 2)).toBeNull();
  });
});

describe('removeBox', () => {
  it('unwraps the div', () => {
    const boxed = applyBox('選取的內容', 0, 5, DEFAULT_BOX);
    const r = removeBox(boxed.text, boxed.start, boxed.end);
    expect(r.text).toBe('選取的內容');
    expect(r.text.slice(r.start, r.end)).toBe('選取的內容');
  });

  it('unwraps the blank-line form too', () => {
    const boxed = applyBox('**內容**', 0, 6, DEFAULT_BOX);
    expect(removeBox(boxed.text, boxed.start, boxed.end).text).toBe('**內容**');
  });

  it('keeps other block styles and only drops the box', () => {
    const boxed = applyBox('內容', 0, 2, DEFAULT_BOX);
    const centered = setBlockAlign(boxed.text, boxed.start, boxed.end, 'center');
    const r = removeBox(centered.text, centered.start, centered.end);
    expect(r.text).toBe('<div style="text-align: center;">\n內容\n</div>');
  });

  it('does nothing when there is no box', () => {
    expect(removeBox('內容', 0, 2).text).toBe('內容');
  });

  it('unwraps a multi-line blank-line box from a caret on its middle line', () => {
    const text = '**標題**\n第二行\n![圖](/a/b (1).png)';
    const boxed = applyBox(text, 0, text.length, DEFAULT_BOX).text;
    expect(boxed).toBe(`${PLAIN_BOX}\n\n${text}\n\n</div>`);
    const caret = boxed.indexOf('第二行') + 1;
    const r = removeBox(boxed, caret, caret);
    expect(r.text).toBe(text);
  });

  it('patches a box from a caret inside the blank-line form', () => {
    const boxed = applyBox('**內容**', 0, 6, DEFAULT_BOX).text;
    const caret = boxed.indexOf('**內容**') + 2;
    const r = applyBoxPatch(boxed, caret, caret, { width: '2px', style: 'dashed' });
    expect(r.text.match(/<div/g)).toHaveLength(1);
    expect(r.text).toContain('border: 2px dashed #cccccc;');
    expect(r.text.slice(r.start, r.end)).toBe('**內容**');
  });
});

describe('setBlockAlign / changeIndent', () => {
  it('aligns and re-aligns with one div', () => {
    const centered = setBlockAlign('內容', 0, 2, 'center');
    expect(centered.text).toBe('<div style="text-align: center;">\n內容\n</div>');
    const right = setBlockAlign(centered.text, centered.start, centered.end, 'right');
    expect(right.text).toBe('<div style="text-align: right;">\n內容\n</div>');
    expect(setBlockAlign(right.text, right.start, right.end, null).text).toBe('內容');
  });

  it('steps the indent and removes the wrapper at zero', () => {
    const one = changeIndent('內容', 0, 2, 1);
    expect(one.text).toBe('<div style="margin-left: 2em;">\n內容\n</div>');
    const two = changeIndent(one.text, one.start, one.end, 1);
    expect(two.text).toContain('margin-left: 4em;');
    const back = changeIndent(two.text, two.start, two.end, -1);
    expect(back.text).toContain('margin-left: 2em;');
    expect(changeIndent(back.text, back.start, back.end, -1).text).toBe('內容');
  });

  it('never indents with leading spaces (would become a code block)', () => {
    expect(changeIndent('內容', 0, 2, 1).text).not.toMatch(/^ {4}/m);
  });

  it('combines alignment with a box in a single div', () => {
    const boxed = applyBox('內容', 0, 2, DEFAULT_BOX);
    const centered = setBlockAlign(boxed.text, boxed.start, boxed.end, 'center');
    expect(centered.text.match(/<div/g)).toHaveLength(1);
    expect(centered.text).toContain('border: 1px solid #cccccc;');
    expect(centered.text).toContain('text-align: center;');
  });
});

describe('toggleBlockquote', () => {
  it('quotes and unquotes every selected line', () => {
    const text = '第一行\n第二行';
    const quoted = toggleBlockquote(text, 0, text.length);
    expect(quoted.text).toBe('> 第一行\n> 第二行');
    expect(toggleBlockquote(quoted.text, quoted.start, quoted.end).text).toBe(text);
  });
});

describe('applyCustomColor', () => {
  it('uses a span for a single line', () => {
    const r = applyCustomColor('內容', 0, 2, 'background-color', '#ffe9b3');
    expect(r.text).toBe('<span style="background-color: #ffe9b3;">內容</span>');
  });

  it('merges into the same span instead of nesting', () => {
    const first = applyCustomColor('內容', 0, 2, 'background-color', '#ffe9b3');
    const second = applyCustomColor(first.text, first.start, first.end, 'color', '#cf222e');
    expect(second.text).toBe(
      '<span style="background-color: #ffe9b3; color: #cf222e;">內容</span>',
    );
    expect(second.text.match(/<span/g)).toHaveLength(1);
  });

  it('replaces the value when applied again', () => {
    const first = applyCustomColor('內容', 0, 2, 'color', '#cf222e');
    const inner = first.text.indexOf('內容');
    const second = applyCustomColor(first.text, inner, inner + 2, 'color', '#0969da');
    expect(second.text).toBe('<span style="color: #0969da;">內容</span>');
  });

  it('removes the span when the color is cleared', () => {
    const first = applyCustomColor('內容', 0, 2, 'color', '#cf222e');
    const inner = first.text.indexOf('內容');
    expect(applyCustomColor(first.text, inner, inner + 2, 'color', '').text).toBe('內容');
  });

  it('uses a div for a multi-line selection', () => {
    const text = '第一行\n第二行';
    const r = applyCustomColor(text, 0, text.length, 'background-color', '#f6f8fa');
    expect(r.text).toBe(`<div style="background-color: #f6f8fa;">\n${text}\n</div>`);
  });
});

describe('stripHtml', () => {
  it('removes tags but keeps Markdown', () => {
    const text = '<span style="color: red;">**重點**</span>';
    const r = stripHtml(text, 0, text.length);
    expect(r.text).toBe('**重點**');
  });

  it('removes the wrapper the selection sits inside', () => {
    const boxed = applyBox('內容', 0, 2, DEFAULT_BOX).text;
    const inner = boxed.indexOf('內容');
    expect(stripHtml(boxed, inner, inner + 2).text).toBe('內容');
  });

  it('turns an img back into Markdown instead of deleting it', () => {
    const text = '<div style="text-align: center;"><img src="/a/b.png" alt="b" style="width: 50%;"></div>';
    expect(stripHtml(text, 0, text.length).text).toBe('![b](/a/b.png)');
  });

  it('keeps links untouched', () => {
    const text = '請見 [說明](/docs/a) 與 ![圖](/a/b.png)';
    expect(stripHtml(text, 0, text.length).text).toBe(text);
  });
});

describe('wrapper detection safety', () => {
  it('does not treat a neighbouring closed box as the selection\'s wrapper', () => {
    const text = ['<div style="border: 1px solid #cccccc;">', '框內', '</div>', '框外'].join('\n');
    const caret = text.indexOf('框外');
    const r = applyBox(text, caret, caret + 2, DEFAULT_BOX);
    expect(r.text.match(/<div/g)).toHaveLength(2);
    expect(r.text.endsWith(`${PLAIN_BOX}\n框外\n</div>`)).toBe(true);
  });

  it('does not reach across a blank line into an earlier block', () => {
    const text = ['<div style="border: 1px solid #cccccc;">', '框內', '</div>', '', '框外'].join('\n');
    const caret = text.indexOf('框外');
    expect(removeBox(text, caret, caret + 2).text).toBe(text);
  });
});

describe('removeBlockWrapper', () => {
  it('drops the wrapper entirely', () => {
    const centered = setBlockAlign('內容', 0, 2, 'center');
    expect(removeBlockWrapper(centered.text, centered.start, centered.end).text).toBe('內容');
  });
});

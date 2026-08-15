import { describe, expect, it } from 'vitest';
import {
  applyColor,
  applySize,
  clearFormatting,
  minimalDiff,
  toggleBold,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleStrike,
  toggleUnderline,
} from '../src/content/markdown-format';

describe('applyColor', () => {
  it('wraps plain selected text (acceptance #1)', () => {
    const text = '這是重要密碼喔';
    const r = applyColor(text, 2, 6, 'red');
    expect(r.text).toBe('這是<font color="red">重要密碼</font>喔');
    expect(r.text.slice(r.start, r.end)).toBe('<font color="red">重要密碼</font>');
  });

  it('replaces color when selection covers the whole font tag (acceptance #2)', () => {
    const text = 'A<font color="red">hello</font>B';
    const r = applyColor(text, 1, text.length - 1, 'blue');
    expect(r.text).toBe('A<font color="blue">hello</font>B');
    expect(r.text.match(/<font/g)).toHaveLength(1);
  });

  it('replaces color when selection is the inner text of a font tag', () => {
    const text = 'A<font color="red">hello</font>B';
    const start = text.indexOf('hello');
    const r = applyColor(text, start, start + 5, 'green');
    expect(r.text).toBe('A<font color="green">hello</font>B');
    expect(r.text.slice(r.start, r.end)).toBe('hello');
  });

  it('strips nested font tags inside the selection before wrapping', () => {
    const text = 'x<font color="red">a</font>y';
    const r = applyColor(text, 0, text.length, 'blue');
    expect(r.text).toBe('<font color="blue">xay</font>');
  });

  it('supports custom hex colors', () => {
    const r = applyColor('abc', 0, 3, '#a1b2c3');
    expect(r.text).toBe('<font color="#a1b2c3">abc</font>');
  });

  it('preserves every list marker, line break and Wiki.js directive around the selection', () => {
    const text = [
      '1. 新旭usb權限sop.docx',
      '2. 新旭人員到職sop-20210409.docx',
      '   (2023/1/1 新人到職，每位員工都要給予 MDO P1授權)',
      '',
      '> 2023/1/1 新人到職，每位員工都要給予 MOD P1授權',
      '{.is-danger}',
    ].join('\n');
    const selected = 'MDO P1授權';
    const start = text.indexOf(selected);
    const result = applyColor(text, start, start + selected.length, 'red');

    expect(result.text).toBe(text.replace(selected, `<font color="red">${selected}</font>`));
    expect(result.text.replace(`<font color="red">${selected}</font>`, selected)).toBe(text);
  });
});

describe('applySize (span-style strategy)', () => {
  it('wraps selection with a font-size span', () => {
    const r = applySize('hello', 0, 5, '18px');
    expect(r.text).toBe('<span style="font-size:18px">hello</span>');
  });

  it('replaces size instead of nesting when selection covers the span', () => {
    const text = '<span style="font-size:18px">hi</span>';
    const r = applySize(text, 0, text.length, '24px');
    expect(r.text).toBe('<span style="font-size:24px">hi</span>');
    expect(r.text.match(/<span/g)).toHaveLength(1);
  });

  it('replaces size when selection is the inner text', () => {
    const text = '<span style="font-size:18px">hi</span>';
    const start = text.indexOf('hi');
    const r = applySize(text, start, start + 2, '32px');
    expect(r.text).toBe('<span style="font-size:32px">hi</span>');
  });

  it('「一般」removes an existing size wrapper', () => {
    const text = 'A<span style="font-size:18px">hi</span>B';
    const start = text.indexOf('hi');
    const r = applySize(text, start, start + 2, null);
    expect(r.text).toBe('AhiB');
  });

  it('supports the font-size-attr strategy', () => {
    const r = applySize('hi', 0, 2, '4', 'font-size-attr');
    expect(r.text).toBe('<font size="4">hi</font>');
  });
});

describe('toggle wrappers', () => {
  it('bold wraps and unwraps', () => {
    const wrapped = toggleBold('hello', 0, 5);
    expect(wrapped.text).toBe('**hello**');
    expect(wrapped.text.slice(wrapped.start, wrapped.end)).toBe('hello');

    const unwrapped = toggleBold(wrapped.text, wrapped.start, wrapped.end);
    expect(unwrapped.text).toBe('hello');
  });

  it('unwraps when markers are inside the selection', () => {
    const r = toggleBold('**hello**', 0, 9);
    expect(r.text).toBe('hello');
  });

  it('italic / strike / code / underline / highlight produce correct markers', () => {
    expect(toggleItalic('x', 0, 1).text).toBe('*x*');
    expect(toggleStrike('x', 0, 1).text).toBe('~~x~~');
    expect(toggleInlineCode('x', 0, 1).text).toBe('`x`');
    expect(toggleUnderline('x', 0, 1).text).toBe('<u>x</u>');
    expect(toggleHighlight('x', 0, 1).text).toBe('<mark>x</mark>');
  });
});

describe('clearFormatting', () => {
  it('removes wrappers inside the selection', () => {
    const text = '<font color="red">**hi**</font>';
    const r = clearFormatting(text, 0, text.length);
    expect(r.text).toBe('hi');
  });

  it('removes wrappers immediately around the selection', () => {
    const text = 'A<font color="red">hi</font>B';
    const start = text.indexOf('hi');
    const r = clearFormatting(text, start, start + 2);
    expect(r.text).toBe('AhiB');
    expect(r.text.slice(r.start, r.end)).toBe('hi');
  });

  it('removes size spans, underline and mark tags', () => {
    const text = '<span style="font-size:18px"><u><mark>hi</mark></u></span>';
    const r = clearFormatting(text, 0, text.length);
    expect(r.text).toBe('hi');
  });
});

describe('minimalDiff', () => {
  it('finds the changed middle section', () => {
    const oldText = 'aaa hello bbb';
    const newText = 'aaa <font color="red">hello</font> bbb';
    const d = minimalDiff(oldText, newText);
    expect(oldText.slice(0, d.from) + d.insert + oldText.slice(d.to)).toBe(newText);
  });

  it('handles identical strings', () => {
    const d = minimalDiff('same', 'same');
    expect(d.insert).toBe('');
    expect(d.from).toBe(d.to);
  });

  it('handles pure insertion and deletion', () => {
    const ins = minimalDiff('ab', 'aXb');
    expect('ab'.slice(0, ins.from) + ins.insert + 'ab'.slice(ins.to)).toBe('aXb');
    const del = minimalDiff('aXb', 'ab');
    expect('aXb'.slice(0, del.from) + del.insert + 'aXb'.slice(del.to)).toBe('ab');
  });
});

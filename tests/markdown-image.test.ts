import { describe, expect, it } from 'vitest';
import {
  clearImageSize,
  findImageAt,
  findImages,
  parseHtmlImage,
  parseMarkdownImage,
  removeImageStyle,
  restoreMarkdownImage,
  setImageAlign,
  setImageSize,
  toCssLength,
  toMarkdownImage,
  toggleImageBorder,
  toggleImageRadius,
} from '../src/content/markdown-image';

const MD = '![netframework1.jpg](/eng/億康/netframework1.jpg)';

describe('parseMarkdownImage', () => {
  it('parses a CJK path', () => {
    const token = parseMarkdownImage(MD, 0);
    expect(token).toMatchObject({
      kind: 'markdown',
      alt: 'netframework1.jpg',
      url: '/eng/億康/netframework1.jpg',
      start: 0,
      end: MD.length,
    });
  });

  it('parses a filename containing parentheses', () => {
    const text = '![影像](/eng/億康/影像 (1).png)';
    const token = parseMarkdownImage(text, 0);
    expect(token?.url).toBe('/eng/億康/影像 (1).png');
    expect(token?.end).toBe(text.length);
  });

  it('parses an angle-bracketed destination and a title', () => {
    const token = parseMarkdownImage('![a](</x y (2).png> "說明")', 0);
    expect(token?.url).toBe('/x y (2).png');
    expect(token?.title).toBe('說明');
  });

  it('parses a markdown-it-imsize hint without polluting the url', () => {
    const token = parseMarkdownImage('![a](/x/y.png =400x)', 0);
    expect(token?.url).toBe('/x/y.png');
    expect(token?.sizeHint).toBe('400x');
  });

  it('rejects an unterminated token instead of swallowing the document', () => {
    expect(parseMarkdownImage('![a](/x/y.png\n下一行', 0)).toBeNull();
    expect(parseMarkdownImage('![a] (/x/y.png)', 0)).toBeNull();
  });
});

describe('parseHtmlImage', () => {
  it('parses src/alt/style and keeps unknown attributes', () => {
    const tag = '<img src="/a/b.png" alt="b" class="x" style="width: 400px; height: auto;">';
    const token = parseHtmlImage(tag, 0);
    expect(token).toMatchObject({ kind: 'html', url: '/a/b.png', alt: 'b', otherAttrs: 'class="x"' });
    expect(token?.decls).toEqual([
      { prop: 'width', value: '400px' },
      { prop: 'height', value: 'auto' },
    ]);
  });

  it('does not stop at a > inside an attribute value', () => {
    const tag = '<img src="/a/b>c.png" alt="x">';
    expect(parseHtmlImage(tag, 0)?.end).toBe(tag.length);
  });
});

describe('findImages / findImageAt', () => {
  it('finds every image on a line with other content', () => {
    const text = `- 前面 ${MD} 後面`;
    expect(findImages(text)).toHaveLength(1);
  });

  it('matches a caret placed inside the syntax', () => {
    const text = `說明\n${MD}\n其他`;
    const caret = text.indexOf('netframework1.jpg', 5) + 3;
    expect(findImageAt(text, caret, caret)?.url).toBe('/eng/億康/netframework1.jpg');
  });

  it('matches a caret elsewhere on the image line', () => {
    const text = `- 步驟一 ${MD}`;
    expect(findImageAt(text, 2, 2)?.kind).toBe('markdown');
  });

  it('matches a caret on the wrapping div line', () => {
    const text = `<div style="text-align: center;">\n  <img src="/a/b.png" alt="b">\n</div>`;
    expect(findImageAt(text, 5, 5)?.url).toBe('/a/b.png');
  });

  it('returns null when the caret is on an unrelated line', () => {
    const text = `純文字\n\n${MD}`;
    expect(findImageAt(text, 1, 1)).toBeNull();
  });

  it('prefers the image the selection overlaps', () => {
    const text = `${MD} ![b](/b.png)`;
    const start = text.indexOf('![b]');
    expect(findImageAt(text, start, text.length)?.url).toBe('/b.png');
  });
});

describe('setImageSize', () => {
  it('converts Markdown to an img with width 400px (spec example)', () => {
    const r = setImageSize(MD, 0, MD.length, '400px');
    expect(r.text).toBe(
      '<img src="/eng/億康/netframework1.jpg" alt="netframework1.jpg" style="width: 400px; height: auto;">',
    );
  });

  it('supports percentage widths', () => {
    const r = setImageSize(MD, 0, MD.length, '50%');
    expect(r.text).toContain('style="width: 50%; height: auto;"');
  });

  it('updates an existing img in place without nesting or duplicate style', () => {
    const html =
      '<img src="/eng/億康/netframework1.jpg" alt="netframework1.jpg" style="width: 400px; height: auto;">';
    const r = setImageSize(html, 0, html.length, '600px');
    expect(r.text).toBe(
      '<img src="/eng/億康/netframework1.jpg" alt="netframework1.jpg" style="width: 600px; height: auto;">',
    );
    expect(r.text.match(/<img/g)).toHaveLength(1);
    expect(r.text.match(/style=/g)).toHaveLength(1);
  });

  it('keeps an explicit height when the ratio is not locked', () => {
    const r = setImageSize(MD, 0, MD.length, '400px', '300px');
    expect(r.text).toContain('style="width: 400px; height: 300px;"');
  });

  it('works from a bare caret inside the Markdown', () => {
    const text = `文字\n${MD}\n文字`;
    const caret = text.indexOf('億康');
    const r = setImageSize(text, caret, caret, '25%');
    expect(r.text).toContain('style="width: 25%; height: auto;"');
    expect(r.text.startsWith('文字\n<img')).toBe(true);
  });

  it('escapes attribute values', () => {
    const r = setImageSize('![a"b](/x/a&b.png)', 0, 18, '10px');
    expect(r.text).toContain('src="/x/a&amp;b.png"');
    expect(r.text).toContain('alt="a&quot;b"');
  });

  it('leaves unrecognised content untouched', () => {
    const text = '這裡沒有圖片';
    expect(setImageSize(text, 0, 3, '400px').text).toBe(text);
  });
});

describe('toCssLength', () => {
  it('builds lengths and rejects junk', () => {
    expect(toCssLength('400', 'px')).toBe('400px');
    expect(toCssLength('50', '%')).toBe('50%');
    expect(toCssLength('400px', '%')).toBe('400px');
    expect(toCssLength('', 'px')).toBe('');
    expect(toCssLength('abc', 'px')).toBe('');
    expect(toCssLength('-5', 'px')).toBe('');
  });
});

describe('image size removal and decoration', () => {
  const html = '<img src="/a/b.png" alt="b" style="width: 400px; height: auto; border-radius: 6px;">';

  it('原始尺寸 removes only width/height', () => {
    const r = clearImageSize(html, 0, html.length);
    expect(r.text).toBe('<img src="/a/b.png" alt="b" style="border-radius: 6px;">');
  });

  it('移除尺寸設定 drops the whole style attribute', () => {
    const r = removeImageStyle(html, 0, html.length);
    expect(r.text).toBe('<img src="/a/b.png" alt="b">');
  });

  it('圓角 and 框線 toggle instead of stacking', () => {
    const plain = '<img src="/a/b.png" alt="b">';
    const rounded = toggleImageRadius(plain, 0, plain.length);
    expect(rounded.text).toContain('border-radius: 6px;');
    const off = toggleImageRadius(rounded.text, 0, rounded.text.length);
    expect(off.text).toBe(plain);

    const bordered = toggleImageBorder(plain, 0, plain.length);
    expect(bordered.text).toContain('border: 1px solid #cccccc;');
    expect(toggleImageBorder(bordered.text, 0, bordered.text.length).text).toBe(plain);
  });
});

describe('setImageAlign', () => {
  it('wraps a Markdown image in one alignment div', () => {
    const r = setImageAlign(MD, 0, MD.length, 'center');
    expect(r.text).toBe(
      '<div style="text-align: center;">\n' +
        '  <img src="/eng/億康/netframework1.jpg" alt="netframework1.jpg">\n' +
        '</div>',
    );
  });

  it('reuses the existing div when the alignment changes', () => {
    const centered = setImageAlign(MD, 0, MD.length, 'center').text;
    const right = setImageAlign(centered, 5, 5, 'right');
    expect(right.text.match(/<div/g)).toHaveLength(1);
    expect(right.text).toContain('text-align: right;');
  });

  it('keeps a single div when the size is changed afterwards', () => {
    const centered = setImageAlign(MD, 0, MD.length, 'center').text;
    const caret = centered.indexOf('<img') + 2;
    const sized = setImageSize(centered, caret, caret, '400px');
    expect(sized.text.match(/<div/g)).toHaveLength(1);
    expect(sized.text.match(/<img/g)).toHaveLength(1);
    expect(sized.text).toContain('style="width: 400px; height: auto;"');

    const again = setImageSize(sized.text, caret, caret, '50%');
    expect(again.text.match(/<div/g)).toHaveLength(1);
    expect(again.text).toContain('style="width: 50%; height: auto;"');
  });

  it('removes the div when the alignment is cleared', () => {
    const centered = setImageAlign(MD, 0, MD.length, 'center').text;
    const cleared = setImageAlign(centered, centered.indexOf('<img'), centered.indexOf('<img'), null);
    expect(cleared.text).toBe('<img src="/eng/億康/netframework1.jpg" alt="netframework1.jpg">');
  });

  it('stays on one line when the image shares its line', () => {
    const text = `- 步驟 ${MD}`;
    const r = setImageAlign(text, text.indexOf('!['), text.length, 'center');
    expect(r.text.split('\n')).toHaveLength(1);
    expect(r.text.startsWith('- 步驟 <div style="text-align: center;"><img')).toBe(true);
  });
});

describe('restoreMarkdownImage', () => {
  it('converts an img back to Markdown', () => {
    const html = '<img src="/eng/億康/netframework1.jpg" alt="netframework1.jpg" style="width: 400px;">';
    expect(restoreMarkdownImage(html, 0, html.length).text).toBe(MD);
  });

  it('drops an alignment-only wrapper div', () => {
    const centered = setImageAlign(MD, 0, MD.length, 'center').text;
    const caret = centered.indexOf('<img');
    expect(restoreMarkdownImage(centered, caret, caret).text).toBe(MD);
  });

  it('brackets a destination that contains spaces', () => {
    const html = '<img src="/eng/億康/影像 (1).png" alt="影像">';
    expect(restoreMarkdownImage(html, 0, html.length).text).toBe('![影像](</eng/億康/影像 (1).png>)');
  });

  it('unescapes attribute entities', () => {
    const html = '<img src="/x/a&amp;b.png" alt="a&quot;b">';
    expect(toMarkdownImage(parseHtmlImage(html, 0)!)).toBe('![a"b](/x/a&b.png)');
  });

  it('leaves a Markdown image alone', () => {
    expect(restoreMarkdownImage(MD, 0, MD.length).text).toBe(MD);
  });
});

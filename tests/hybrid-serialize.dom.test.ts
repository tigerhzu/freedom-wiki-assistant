/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { parseHybridBlocks } from '../src/content/hybrid-blocks';
import { serializeNewVisualBlock, serializeVisualBlock } from '../src/content/hybrid-serialize';

function div(style: string, innerHTML: string): HTMLElement {
  const element = document.createElement('div');
  element.setAttribute('style', style);
  element.innerHTML = innerHTML;
  return element;
}

describe('serializeVisualBlock: html boxes', () => {
  it('round-trips a blank-line box, keeping the frame and heading markers', () => {
    const raw = [
      '<div style="border:1px solid red;">',
      '',
      '### <font color="red">-使用前注意事項-</font>',
      '',
      '內文',
      '',
      '</div>',
    ].join('\n');
    const block = parseHybridBlocks(raw)[0];
    const element = div(
      'border:1px solid red;',
      '<h3><font color="red">-使用前注意事項-</font></h3><p>內文</p>',
    );
    expect(serializeVisualBlock(block, element)).toBe(
      [
        '<div style="border:1px solid red;">',
        '',
        '### <font color="red">-使用前注意事項-</font>',
        '',
        '內文',
        '',
        '</div>',
      ].join('\n'),
    );
  });

  it('round-trips a compact box as HTML without Markdown escaping', () => {
    const raw = '<div style="border:1px solid red;">\n*星號* [括號] A&B\n</div>';
    const block = parseHybridBlocks(raw)[0];
    const element = document.createElement('div');
    element.setAttribute('style', 'border:1px solid red;');
    element.textContent = '*星號* [括號] A&B';
    expect(serializeVisualBlock(block, element)).toBe(
      '<div style="border:1px solid red;">\n*星號* [括號] A&amp;B\n</div>',
    );
  });

  it('keeps inline HTML tags inside a compact box', () => {
    const raw = '<div style="padding:2px;">\n注意<font color="red">紅字</font><br>次行\n</div>';
    const block = parseHybridBlocks(raw)[0];
    const element = div('padding:2px;', '注意<font color="red">紅字</font><br>次行');
    expect(serializeVisualBlock(block, element)).toBe(
      '<div style="padding:2px;">\n注意<font color="red">紅字</font><br>次行\n</div>',
    );
  });

  it('collapses blank lines editing created inside a compact body', () => {
    const raw = '<div style="padding:2px;">\n甲\n乙\n</div>';
    const block = parseHybridBlocks(raw)[0];
    const element = document.createElement('div');
    element.setAttribute('style', 'padding:2px;');
    element.textContent = '甲\n\n\n乙';
    expect(serializeVisualBlock(block, element)).toBe('<div style="padding:2px;">\n甲\n乙\n</div>');
  });

  it('round-trips a nested inner div with all its attributes', () => {
    const raw = [
      '<div style="padding:4px;">',
      '',
      '段落',
      '',
      '<div class="note" style="border:1px solid blue;">',
      '內層文字',
      '</div>',
      '',
      '</div>',
    ].join('\n');
    const block = parseHybridBlocks(raw)[0];
    const element = div(
      'padding:4px;',
      '<p>段落</p><div class="note" style="border:1px solid blue;">\n內層文字\n</div>',
    );
    expect(serializeVisualBlock(block, element)).toBe(
      [
        '<div style="padding:4px;">',
        '',
        '段落',
        '',
        '<div class="note" style="border:1px solid blue;">',
        '內層文字',
        '</div>',
        '',
        '</div>',
      ].join('\n'),
    );
  });

  it('drops extension bookkeeping attributes when rebuilding tags', () => {
    const raw = '<div style="padding:2px;">\n\n內文\n\n</div>';
    const block = parseHybridBlocks(raw)[0];
    const element = div('padding:2px;', '<p>內文</p>');
    element.setAttribute('data-fwa-source-index', '0');
    element.setAttribute('data-fwa-visual-dirty', 'true');
    element.setAttribute('contenteditable', 'true');
    const inner = document.createElement('div');
    inner.setAttribute('style', 'color:red;');
    inner.setAttribute('data-fwa-visual-dirty', 'true');
    inner.textContent = '內層';
    element.appendChild(inner);
    expect(serializeVisualBlock(block, element)).toBe(
      [
        '<div style="padding:2px;">',
        '',
        '內文',
        '',
        '<div style="color:red;">',
        '內層',
        '</div>',
        '',
        '</div>',
      ].join('\n'),
    );
  });
});

describe('serializeVisualBlock: Wiki.js {.is-warning} blocks', () => {
  function rendered(tag: string, className: string, innerHTML: string): HTMLElement {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.innerHTML = innerHTML;
    return element;
  }

  it('does not turn soft line breaks (<br>\\n) into blank lines', () => {
    const raw = '案件一律cc窗口\nsysaid會自動寄送\n監控報告請手動寄送';
    const block = parseHybridBlocks(raw)[0];
    const element = rendered('p', 'line', '案件一律cc窗口<br>\nsysaid會自動寄送<br>\n監控報告請手動寄送');
    expect(serializeVisualBlock(block, element)).toBe(raw);
  });

  it('keeps a terminal line break created by Enter', () => {
    const raw = '寫在最下';
    const block = parseHybridBlocks(raw)[0];
    const element = rendered('p', 'line', '寫在最下<br>');
    expect(serializeVisualBlock(block, element)).toBe('寫在最下\n');
  });

  it('keeps a terminal line break outside a trailing inline font wrapper', () => {
    const raw = '前<font color="red">下面的黃色區塊</font>';
    const block = parseHybridBlocks(raw)[0];
    const element = rendered(
      'p',
      'line',
      '前<font color="red">下面的黃色區塊<br></font>',
    );

    expect(serializeVisualBlock(block, element)).toBe(
      '前<font color="red">下面的黃色區塊</font>\n',
    );
  });

  it('keeps a trailing space outside an inline font wrapper', () => {
    const raw = '前<font color="red">紅色文字</font>後';
    const block = parseHybridBlocks(raw)[0];
    const element = rendered(
      'p',
      'line',
      '前<font color="red">紅色文字 </font>後',
    );

    expect(serializeVisualBlock(block, element)).toBe(
      '前<font color="red">紅色文字</font> 後',
    );
  });

  it('keeps a trailing {.is-warning} line the renderer consumed into a class', () => {
    const raw = '案件一律cc窗口dd\nsysaid會自動寄送\n{.is-warning}';
    const block = parseHybridBlocks(raw)[0];
    const element = rendered('p', 'is-warning line', '案件一律cc窗口dd<br>\nsysaid會自動寄送');
    expect(serializeVisualBlock(block, element)).toBe(raw);
  });

  it('round-trips a lazy warning blockquote without adding > to untouched lines', () => {
    const raw = '> 案件一律cc窗口\nsysaid會自動寄送\n監控報告請手動寄送\n{.is-warning}';
    const block = parseHybridBlocks(raw)[0];
    const element = rendered(
      'blockquote',
      'is-warning line',
      '\n<p>案件一律cc窗口<br>\nsysaid會自動寄送<br>\n監控報告請手動寄送</p>\n',
    );
    expect(serializeVisualBlock(block, element)).toBe(raw);
  });

  it('keeps > on every line when the source prefixed every line', () => {
    const raw = '> 第一行\n> 第二行\n{.is-danger}';
    const block = parseHybridBlocks(raw)[0];
    const element = rendered('blockquote', 'is-danger line', '\n<p>第一行<br>\n第二行</p>\n');
    expect(serializeVisualBlock(block, element)).toBe(raw);
  });

  it('keeps a trailing attribute line after a list', () => {
    const raw = '- [文件A](/a)\n- [文件B](/b)\n{.links-list}';
    const block = parseHybridBlocks(raw)[0];
    const element = rendered(
      'ul',
      'links-list',
      '<li><a href="/a">文件A</a></li>\n<li><a href="/b">文件B</a></li>',
    );
    expect(serializeVisualBlock(block, element)).toBe(raw);
  });

  it('keeps trailing attrs when an image block is projected', () => {
    const raw = '![架構圖](/images/architecture.png)\n{.is-note custom-color}';
    const block = parseHybridBlocks(raw)[0];
    const element = document.createElement('img');
    element.setAttribute('src', '/images/architecture.png');
    element.setAttribute('alt', '架構圖');

    expect(serializeVisualBlock(block, element)).toBe(raw);
  });
});

describe('serializeNewVisualBlock: divs', () => {
  it('keeps an attributed div as a blank-line box when its body is blocks', () => {
    const element = div('border:1px solid red;', '<h3>標題</h3><p>內文</p>');
    expect(serializeNewVisualBlock(element)).toBe(
      '<div style="border:1px solid red;">\n\n### 標題\n\n內文\n\n</div>',
    );
  });

  it('keeps an attributed div compact when its body is inline', () => {
    const element = div('border:1px solid red;', '純文字');
    expect(serializeNewVisualBlock(element)).toBe('<div style="border:1px solid red;">\n純文字\n</div>');
  });

  it('flattens a bare div (contenteditable line noise)', () => {
    const element = document.createElement('div');
    element.textContent = '一行文字';
    expect(serializeNewVisualBlock(element)).toBe('一行文字');
  });
});

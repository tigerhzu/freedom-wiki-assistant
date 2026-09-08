import { describe, expect, it } from 'vitest';
import { parseHybridBlocks } from '../src/content/hybrid-blocks';
import { canVisuallyEdit, isEditableHtmlBox } from '../src/content/hybrid-serialize';

const BOX = [
  '<div style="border: 2px solid #d29922; border-radius: 6px; padding: 12px;">',
  '',
  '### <font color="red">-使用前注意事項-</font>',
  '內文',
  '',
  '</div>',
].join('\n');

describe('isEditableHtmlBox', () => {
  it('accepts the blank-line 文字框 form and makes it visually editable', () => {
    const blocks = parseHybridBlocks(BOX);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('html');
    expect(isEditableHtmlBox(blocks[0])).toBe(true);
    expect(canVisuallyEdit(blocks[0])).toBe(true);
  });

  it('accepts the compact form', () => {
    const compact = '<div style="border: 1px solid red;">\n內文\n</div>';
    const blocks = parseHybridBlocks(compact);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('html');
    expect(isEditableHtmlBox(blocks[0])).toBe(true);
    expect(canVisuallyEdit(blocks[0])).toBe(true);
  });

  it('accepts nested-div boxes', () => {
    const nested = [
      '<div style="padding: 4px;">',
      '',
      '<div style="border: 1px solid red;">',
      '',
      '內文',
      '',
      '</div>',
      '',
      '</div>',
    ].join('\n');
    const blocks = parseHybridBlocks(nested);
    expect(blocks).toHaveLength(1);
    expect(isEditableHtmlBox(blocks[0])).toBe(true);
  });

  it('rejects non-div html blocks and non-html blocks', () => {
    const details = '<details>\n\n內容\n\n</details>';
    const detailsBlocks = parseHybridBlocks(details);
    expect(detailsBlocks[0].type).toBe('html');
    expect(isEditableHtmlBox(detailsBlocks[0])).toBe(false);

    const paragraph = parseHybridBlocks('一般段落文字');
    expect(paragraph[0].type).toBe('paragraph');
    expect(isEditableHtmlBox(paragraph[0])).toBe(false);
  });
});

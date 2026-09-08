import { describe, expect, it } from 'vitest';
import { parseHybridBlocks } from '../src/content/hybrid-blocks';
import { canSerializeVisualBlock, canVisuallyEdit } from '../src/content/hybrid-serialize';

describe('parseHybridBlocks', () => {
  it('keeps exact source ranges for phase-one block types', () => {
    const source = [
      '# Hybrid Editor Test',
      '',
      'Gateway: <font color="red">192.168.1.1</font>',
      '',
      '- Firewall',
      '- Core Switch',
      '',
      '> Important network information',
      '',
      '| Device | IP |',
      '|---|---|',
      '| Firewall | 192.168.1.1 |',
      '',
      '```powershell',
      'Test-NetConnection 192.168.1.1',
      '```',
      '',
      '![Firewall](./images/firewall.png)',
    ].join('\n');

    const blocks = parseHybridBlocks(source);
    expect(blocks.map((block) => block.type)).toEqual([
      'heading',
      'mixed',
      'list',
      'blockquote',
      'table',
      'code-fence',
      'image',
    ]);
    for (const block of blocks) {
      expect(source.slice(block.startOffset, block.endOffset)).toBe(block.rawMarkdown);
    }
  });

  it('leaves blank separators outside block ranges', () => {
    const source = '# A\r\n\r\nParagraph\r\n\r\n- one\r\n- two\r\n';
    const blocks = parseHybridBlocks(source);
    expect(blocks.map((block) => block.rawMarkdown)).toEqual(['# A', 'Paragraph', '- one\r\n- two']);
    expect(source.slice(blocks[0].endOffset, blocks[1].startOffset)).toBe('\r\n\r\n');
  });

  it('keeps an unclosed fence as a raw fallback block', () => {
    const source = '```js\nconst x = 1;\n\nstill code';
    const [block] = parseHybridBlocks(source);
    expect(block.type).toBe('raw');
    expect(block.rawMarkdown).toBe(source);
  });

  it('classifies standalone links and unknown wiki directives conservatively', () => {
    const source = '[Google](https://google.com)\n\n{{ wiki.special }}';
    expect(parseHybridBlocks(source).map((block) => block.type)).toEqual(['link', 'raw']);
  });

  it('serializes image changes without making image blocks text-editable', () => {
    const [image] = parseHybridBlocks('![Network diagram](./images/network.png)');

    expect(image.type).toBe('image');
    expect(canVisuallyEdit(image)).toBe(false);
    expect(canSerializeVisualBlock(image)).toBe(true);
  });

  it('records Wiki.js alert semantics independently from rendered CSS', () => {
    const source = [
      '一般內容',
      '{.is-warning}',
      '',
      '> 藍色內容',
      '{.is-info}',
      '',
      '> 紅色內容',
      '{.is-danger}',
    ].join('\n');

    expect(parseHybridBlocks(source).map((block) => block.semanticType)).toEqual([
      'warning',
      'info',
      'danger',
    ]);
  });

  it('keeps alert metadata when Enter removes the blank separator before an hr', () => {
    const source = ['> Warning text', '{.is-warning}', '---'].join('\n');
    const blocks = parseHybridBlocks(source);

    expect(blocks.map((block) => [block.type, block.semanticType, block.rawMarkdown])).toEqual([
      ['blockquote', 'warning', '> Warning text\n{.is-warning}'],
      ['horizontal-rule', undefined, '---'],
    ]);
  });

  it('associates an alert attrs line after one accidental blank line', () => {
    const source = ['> Warning text', '', '{.is-warning}'].join('\n');
    const blocks = parseHybridBlocks(source);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('blockquote');
    expect(blocks[0].semanticType).toBe('warning');
    expect(blocks[0].rawMarkdown).toBe(source);
  });

  it('keeps site-specific semantic variants in the source model', () => {
    const source = ['成功內容', '{.is-success}', '', '備註內容', '{.is-note custom-color}'].join('\n');

    expect(parseHybridBlocks(source).map((block) => block.semanticType)).toEqual(['success', 'note']);
  });

  it('classifies an image with trailing attrs as an image block', () => {
    const [block] = parseHybridBlocks('![架構圖](/images/architecture.png)\n{.is-note}');

    expect(block.type).toBe('image');
    expect(block.semanticType).toBe('note');
    expect(block.rawMarkdown).toBe('![架構圖](/images/architecture.png)\n{.is-note}');
  });

  it('keeps an edit-in-place block identity independent from source offsets', () => {
    const before = parseHybridBlocks('第一個 block\n\n第二個 block');
    const after = parseHybridBlocks('第一個 block 變長了\n\n第二個 block');

    expect(after.map((block) => block.id)).toEqual(before.map((block) => block.id));
  });
});

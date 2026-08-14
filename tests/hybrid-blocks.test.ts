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
});

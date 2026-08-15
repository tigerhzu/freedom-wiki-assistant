import { describe, expect, it } from 'vitest';
import { splitMarkdownBlocks } from '../src/content/quick-format';

const lines = (text: string): string[] => text.split('\n');

describe('splitMarkdownBlocks', () => {
  it('keeps a fenced code block as one block including blank lines', () => {
    const blocks = splitMarkdownBlocks(lines(['前言', '```', 'a', '', 'b', '```', '後記'].join('\n')));
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'fence', 'paragraph']);
    expect(blocks[1].lines).toEqual(['```', 'a', '', 'b', '```']);
  });

  it('keeps a table as one block', () => {
    const blocks = splitMarkdownBlocks(lines(['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('table');
  });

  it('keeps a div wrapper as one HTML block', () => {
    const blocks = splitMarkdownBlocks(lines(['<div style="text-align: center;">', '', '內容', '', '</div>'].join('\n')));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('html');
    expect(blocks[0].lines).toHaveLength(5);
  });

  it('treats an unclosed block tag as a paragraph rather than swallowing the rest', () => {
    const blocks = splitMarkdownBlocks(lines(['<div>', '內容', '', '## 後面的章節'].join('\n')));
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'heading']);
  });

  it('splits each heading into its own block', () => {
    const blocks = splitMarkdownBlocks(lines(['# A', '## B', '內文'].join('\n')));
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'heading', 'paragraph']);
  });

  it('drops blank-only input', () => {
    expect(splitMarkdownBlocks(lines('\n\n  \n'))).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { diffLines, isDiffFeasible } from '../src/content/text-diff';

describe('diffLines', () => {
  it('marks unchanged lines as equal', () => {
    const result = diffLines('a\nb\nc', 'a\nb\nc');
    expect(result).toEqual([
      { type: 'equal', text: 'a' },
      { type: 'equal', text: 'b' },
      { type: 'equal', text: 'c' },
    ]);
  });

  it('detects an added line', () => {
    const result = diffLines('a\nc', 'a\nb\nc');
    expect(result).toEqual([
      { type: 'equal', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'equal', text: 'c' },
    ]);
  });

  it('detects a removed line', () => {
    const result = diffLines('a\nb\nc', 'a\nc');
    expect(result).toEqual([
      { type: 'equal', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'equal', text: 'c' },
    ]);
  });

  it('handles a full replacement', () => {
    const result = diffLines('old', 'new');
    expect(result).toEqual([
      { type: 'remove', text: 'old' },
      { type: 'add', text: 'new' },
    ]);
  });
});

describe('isDiffFeasible', () => {
  it('is true for typical wiki-page sizes', () => {
    const before = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    expect(isDiffFeasible(before, before)).toBe(true);
  });

  it('is false once the line-count product would blow past the cell limit', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    expect(isDiffFeasible(huge, huge)).toBe(false);
  });
});

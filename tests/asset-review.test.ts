import { describe, expect, it } from 'vitest';
import { formatFileSize, formatUpdatedAt } from '../src/content/asset-review';

describe('formatFileSize', () => {
  it('formats bytes', () => {
    expect(formatFileSize(512)).toBe('512 B');
  });

  it('formats kilobytes', () => {
    expect(formatFileSize(2048)).toBe('2.0 KB');
  });

  it('formats megabytes', () => {
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('formatUpdatedAt', () => {
  it('formats an ISO timestamp to minute precision', () => {
    expect(formatUpdatedAt('2026-07-24T09:05:30.000Z')).toBe('2026-07-24 09:05');
  });

  it('returns the original string for unparseable input', () => {
    expect(formatUpdatedAt('not-a-date')).toBe('not-a-date');
  });
});

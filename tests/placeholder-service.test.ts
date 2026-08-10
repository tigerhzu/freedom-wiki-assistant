import { describe, expect, it } from 'vitest';
import { resolvePlaceholders } from '../src/templates/placeholder-service';

// 2026-07-24 is a Friday.
const ctx = {
  now: new Date(2026, 6, 24, 9, 30),
  pageTitle: '每日晨會',
  currentUser: '',
};

describe('resolvePlaceholders', () => {
  it('resolves all date/time placeholders', () => {
    const out = resolvePlaceholders(
      '{{date}} {{date_slash}} {{date_compact}} {{time}} {{year}} {{month}} {{day}} {{weekday_zh}}',
      ctx,
    );
    expect(out).toBe('2026-07-24 2026/07/24 20260724 09:30 2026 07 24 星期五');
  });

  it('resolves page title and leaves current_user empty when unknown', () => {
    expect(resolvePlaceholders('[{{page_title}}][{{current_user}}]', ctx)).toBe('[每日晨會][]');
  });

  it('keeps unknown placeholders untouched', () => {
    expect(resolvePlaceholders('{{unknown_thing}}', ctx)).toBe('{{unknown_thing}}');
  });

  it('resolves the default morning-meeting template heading (acceptance #6)', () => {
    const out = resolvePlaceholders('# {{date_slash}} 工程部晨會會議紀錄', ctx);
    expect(out).toBe('# 2026/07/24 工程部晨會會議紀錄');
  });

  it('pads single-digit months and days', () => {
    const out = resolvePlaceholders('{{date}}', { ...ctx, now: new Date(2026, 0, 5, 8, 5) });
    expect(out).toBe('2026-01-05');
  });
});

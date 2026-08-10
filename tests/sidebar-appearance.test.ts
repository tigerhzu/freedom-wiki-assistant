import { describe, expect, it } from 'vitest';
import {
  defaultSidebarGradientEnd,
  mixHex,
  normalizeSidebarColor,
  readableGradientTextColor,
  readableTextColor,
  resolveSidebarGradientEnd,
} from '../src/content/sidebar-appearance';

describe('sidebar appearance colors', () => {
  it('normalizes supported HEX values', () => {
    expect(normalizeSidebarColor(' #3A8 ')).toBe('#33aa88');
    expect(normalizeSidebarColor('#3A82F7')).toBe('#3a82f7');
  });

  it('rejects values that are unsafe to place in page styles', () => {
    expect(normalizeSidebarColor('blue')).toBeNull();
    expect(normalizeSidebarColor('#12345')).toBeNull();
    expect(normalizeSidebarColor('#fff; color: red')).toBeNull();
  });

  it('derives stable shades for the sidebar layers', () => {
    expect(mixHex('#1976d2', '#000000', 0.16)).toBe('#1563b0');
    expect(mixHex('#1976d2', '#ffffff', 0.08)).toBe('#2b81d6');
  });

  it('uses dark text on light colors and white text on dark colors', () => {
    expect(readableTextColor('#f5b82e')).toBe('#172033');
    expect(readableTextColor('#1976d2')).toBe('#ffffff');
  });

  it('derives a subtle gradient end while preserving a custom second color', () => {
    expect(defaultSidebarGradientEnd('#1976d2')).toBe('#1561ac');
    expect(resolveSidebarGradientEnd('#1976d2', '')).toBe('#1561ac');
    expect(resolveSidebarGradientEnd('#1976d2', '#8b5cf6')).toBe('#8b5cf6');
  });

  it('keeps text readable across both ends of a gradient', () => {
    expect(readableGradientTextColor('#f5b82e', '#d4950f')).toBe('#172033');
    expect(readableGradientTextColor('#1976d2', '#4f46e5')).toBe('#ffffff');
  });
});

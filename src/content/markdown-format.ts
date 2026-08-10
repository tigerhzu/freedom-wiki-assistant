/**
 * Pure Markdown/HTML formatting functions.
 *
 * Every function takes the full editor text plus a selection range and returns
 * the new full text plus the new selection range. No DOM access — fully unit
 * testable (see tests/markdown-format.test.ts).
 */

export interface EditResult {
  text: string;
  /** New selection start (offset into `text`). */
  start: number;
  /** New selection end. */
  end: number;
}

const FONT_OPEN_BEFORE = /<font\s+color="([^"]*)"\s*>$/i;
const FONT_CLOSE_AFTER = /^<\/font\s*>/i;
const FONT_EXACT = /^<font\s+color="[^"]*"\s*>([\s\S]*)<\/font\s*>$/i;
const ANY_FONT_TAG = /<\/?font\b[^>]*>/gi;

const SIZE_OPEN_BEFORE = /<span\s+style="font-size:\s*[^";]*;?"\s*>$/i;
const SIZE_CLOSE_AFTER = /^<\/span\s*>/i;
const SIZE_EXACT = /^<span\s+style="font-size:\s*[^";]*;?"\s*>([\s\S]*)<\/span\s*>$/i;
const ANY_SIZE_SPAN = /<span\s+style="font-size:\s*[^";]*;?"\s*>|<\/span\s*>/gi;

const FONT_SIZE_ATTR_EXACT = /^<font\s+size="[^"]*"\s*>([\s\S]*)<\/font\s*>$/i;
const FONT_SIZE_ATTR_BEFORE = /<font\s+size="[^"]*"\s*>$/i;

/**
 * A span carrying a style attribute with any declarations — used only as a
 * fallback by applySize so a font size can share one span with the
 * declarations produced by block-format.ts (自訂背景/文字顏色) instead of
 * nesting a second span around it.
 */
const STYLE_SPAN_EXACT = /^<span\s+style="([^"]*)"\s*>([\s\S]*)<\/span\s*>$/i;
const STYLE_SPAN_BEFORE = /<span\s+style="([^"]*)"\s*>$/i;

/** Set, replace or (value === null) remove the font-size inside a style attribute. */
function setFontSizeInStyle(style: string, value: string | null): string {
  const parts = style
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const i = parts.findIndex((part) => /^font-size\s*:/i.test(part));
  if (value === null) {
    if (i >= 0) parts.splice(i, 1);
  } else if (i >= 0) {
    parts[i] = `font-size:${value}`;
  } else {
    parts.push(`font-size:${value}`);
  }
  return parts.join('; ');
}

function replaceRange(
  text: string,
  from: number,
  to: number,
  replacement: string,
  selectFrom: number,
  selectLen: number,
): EditResult {
  return {
    text: text.slice(0, from) + replacement + text.slice(to),
    start: selectFrom,
    end: selectFrom + selectLen,
  };
}

/**
 * Apply a font color to the selection, producing `<font color="...">sel</font>`.
 *
 * Rules (acceptance criteria 1 & 2):
 *  - If the selection already IS a font tag, or is the inner text of one,
 *    the existing tag's color is REPLACED — never nested.
 *  - Any stray font tags inside the selection are stripped before wrapping.
 */
export function applyColor(text: string, start: number, end: number, color: string): EditResult {
  const sel = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);

  // Case 1: selection covers a whole <font ...>...</font> element.
  const exact = sel.match(FONT_EXACT);
  if (exact) {
    const replacement = `<font color="${color}">${exact[1]}</font>`;
    return replaceRange(text, start, end, replacement, start, replacement.length);
  }

  // Case 2: selection is the inner text of an existing font element.
  const open = before.match(FONT_OPEN_BEFORE);
  const close = after.match(FONT_CLOSE_AFTER);
  if (open && close) {
    const openStart = start - open[0].length;
    const newOpen = `<font color="${color}">`;
    const newText = text.slice(0, openStart) + newOpen + sel + after;
    return { text: newText, start: openStart + newOpen.length, end: openStart + newOpen.length + sel.length };
  }

  // Case 3: strip nested font tags inside the selection, then wrap once.
  const inner = sel.replace(ANY_FONT_TAG, '');
  const replacement = `<font color="${color}">${inner}</font>`;
  return replaceRange(text, start, end, replacement, start, replacement.length);
}

export type FontSizeStrategy = 'span-style' | 'font-size-attr';

/**
 * Apply a font size. `sizeValue` is the strategy-specific value
 * (e.g. "18px" for span-style, "4" for font-size-attr).
 * Passing `null` removes any size wrapper (「一般」).
 */
export function applySize(
  text: string,
  start: number,
  end: number,
  sizeValue: string | null,
  strategy: FontSizeStrategy = 'span-style',
): EditResult {
  const sel = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);

  const exactRe = strategy === 'span-style' ? SIZE_EXACT : FONT_SIZE_ATTR_EXACT;
  const beforeRe = strategy === 'span-style' ? SIZE_OPEN_BEFORE : FONT_SIZE_ATTR_BEFORE;
  const afterRe = strategy === 'span-style' ? SIZE_CLOSE_AFTER : FONT_CLOSE_AFTER;
  const buildOpen = (v: string) =>
    strategy === 'span-style' ? `<span style="font-size:${v}">` : `<font size="${v}">`;
  const closeTag = strategy === 'span-style' ? '</span>' : '</font>';

  // Selection covers the whole size wrapper → replace or remove it.
  const exact = sel.match(exactRe);
  if (exact) {
    const inner = exact[1];
    const replacement = sizeValue === null ? inner : buildOpen(sizeValue) + inner + closeTag;
    return replaceRange(text, start, end, replacement, start, replacement.length);
  }

  // Selection is the inner text of a size wrapper.
  const open = before.match(beforeRe);
  const close = after.match(afterRe);
  if (open && close) {
    const openStart = start - open[0].length;
    const closeLen = close[0].length;
    const replacement = sizeValue === null ? sel : buildOpen(sizeValue) + sel + closeTag;
    return replaceRange(text, openStart, end + closeLen, replacement, openStart, replacement.length);
  }

  // Fallback for a span whose style holds more than just the font size
  // (e.g. 自訂背景顏色 was applied first): edit that style in place so the two
  // formats share one span. Only reached when the single-declaration forms
  // above did not match, so existing output stays byte-identical.
  if (strategy === 'span-style') {
    const multi = sel.match(STYLE_SPAN_EXACT);
    if (multi) {
      const style = setFontSizeInStyle(multi[1], sizeValue);
      const replacement = style ? `<span style="${style}">${multi[2]}</span>` : multi[2];
      return replaceRange(text, start, end, replacement, start, replacement.length);
    }
    const multiOpen = before.match(STYLE_SPAN_BEFORE);
    if (multiOpen && close) {
      const openStart = start - multiOpen[0].length;
      const style = setFontSizeInStyle(multiOpen[1], sizeValue);
      const replacement = style ? `<span style="${style}">${sel}</span>` : sel;
      return replaceRange(text, openStart, end + close[0].length, replacement, openStart, replacement.length);
    }
  }

  if (sizeValue === null) {
    // 「一般」 on unwrapped text: strip any size spans inside the selection.
    const inner = strategy === 'span-style' ? sel.replace(ANY_SIZE_SPAN, '') : sel.replace(ANY_FONT_TAG, '');
    return replaceRange(text, start, end, inner, start, inner.length);
  }

  const replacement = buildOpen(sizeValue) + sel + closeTag;
  return replaceRange(text, start, end, replacement, start, replacement.length);
}

/**
 * Toggle a symmetric wrapper (Markdown marker or HTML tag pair) around the
 * selection. Unwraps when the selection is already wrapped (either the
 * markers are inside the selection or immediately around it).
 */
export function toggleWrap(
  text: string,
  start: number,
  end: number,
  open: string,
  close: string = open,
): EditResult {
  const sel = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);

  // Markers inside the selection.
  if (sel.length >= open.length + close.length && sel.startsWith(open) && sel.endsWith(close)) {
    const inner = sel.slice(open.length, sel.length - close.length);
    return replaceRange(text, start, end, inner, start, inner.length);
  }

  // Markers immediately around the selection.
  if (before.endsWith(open) && after.startsWith(close)) {
    const from = start - open.length;
    const to = end + close.length;
    return replaceRange(text, from, to, sel, from, sel.length);
  }

  const replacement = open + sel + close;
  return { text: before + replacement + after, start: start + open.length, end: start + open.length + sel.length };
}

export const toggleBold = (t: string, s: number, e: number) => toggleWrap(t, s, e, '**');
export const toggleItalic = (t: string, s: number, e: number) => toggleWrap(t, s, e, '*');
export const toggleStrike = (t: string, s: number, e: number) => toggleWrap(t, s, e, '~~');
export const toggleInlineCode = (t: string, s: number, e: number) => toggleWrap(t, s, e, '`');
export const toggleUnderline = (t: string, s: number, e: number, tag = 'u') =>
  toggleWrap(t, s, e, `<${tag}>`, `</${tag}>`);
export const toggleHighlight = (t: string, s: number, e: number, tag = 'mark') =>
  toggleWrap(t, s, e, `<${tag}>`, `</${tag}>`);

/**
 * Remove all formatting produced by this extension from the selection:
 * font/span/u/mark tags and **, *, ~~, ` markers. Also removes wrappers
 * that sit immediately around the selection.
 */
export function clearFormatting(text: string, start: number, end: number): EditResult {
  let before = text.slice(0, start);
  let after = text.slice(end);
  let sel = text.slice(start, end);

  // Strip surrounding wrappers repeatedly (e.g. <font ...>|sel|</font>).
  const surroundOpen = /(?:<font\b[^>]*>|<span\s+style="font-size:[^"]*"\s*>|<u>|<mark>|\*\*|~~|\*|`)$/i;
  const surroundClose = /^(?:<\/font\s*>|<\/span\s*>|<\/u>|<\/mark>|\*\*|~~|\*|`)/i;
  for (;;) {
    const o = before.match(surroundOpen);
    const c = after.match(surroundClose);
    if (!o || !c) break;
    before = before.slice(0, before.length - o[0].length);
    after = after.slice(c[0].length);
  }

  sel = sel
    .replace(ANY_FONT_TAG, '')
    .replace(/<\/?span\b[^>]*>/gi, '')
    .replace(/<\/?u\s*>/gi, '')
    .replace(/<\/?mark\s*>/gi, '')
    .replace(/\*\*|~~|(?<!\*)\*(?!\*)|`/g, '');

  const startOut = before.length;
  return { text: before + sel + after, start: startOut, end: startOut + sel.length };
}

/**
 * Compute the minimal changed region between `oldText` and an EditResult so
 * the change can be applied through EditorAdapter.replaceSelection instead of
 * setValue (preserves editor undo history and scroll position).
 */
export function minimalDiff(
  oldText: string,
  newText: string,
): { from: number; to: number; insert: string } {
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > prefix && newEnd > prefix && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { from: prefix, to: oldEnd, insert: newText.slice(prefix, newEnd) };
}

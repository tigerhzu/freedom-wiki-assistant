/**
 * Block-level formatting (文字框 / 引用區塊 / 對齊 / 縮排 / 自訂顏色 /
 * 清除 HTML).
 *
 * Same contract as markdown-format.ts: every function is pure — it takes the
 * full editor text plus a selection range and returns the new full text plus
 * the new selection range. No DOM access (see tests/block-format.test.ts).
 *
 * Design rules that keep the generated Markdown clean:
 *  - A block format is ALWAYS expressed as exactly one wrapper `<div>` whose
 *    `style` attribute is merged. Applying 文字框 → 置中 → 縮排 therefore
 *    produces one div with three declarations, never three nested divs.
 *  - Inline formats reuse (or unwrap) an existing `<span style="...">`.
 *  - When the wrapped content contains Markdown that must still be rendered
 *    (**粗體**、清單、`![圖片]()`、超連結…) the wrapper is written in the
 *    blank-line form so markdown-it keeps parsing the inner text:
 *        <div style="…">
 *
 *        **內容**
 *
 *        </div>
 *    Plain text uses the compact form from the spec.
 */

import {
  BOX_PROPS,
  DEFAULT_BOX,
  boxSpecToDecls,
  extractStyleAttr,
  mergeStyleDecls,
  parseStyleDecls,
  readBoxSpec,
  serializeStyleDecls,
  stripStyleAttr,
  styleValue,
  type BoxSpec,
  type StyleDecl,
} from './html-style';
import { parseHtmlImage, toMarkdownImage } from './markdown-image';
import type { EditResult } from './markdown-format';

const DIV_OPEN_LINE = /^<div\b([^>]*)>$/i;
const DIV_CLOSE_LINE = /^<\/div\s*>$/i;

const INDENT_STEP_EM = 2;
const INDENT_MAX_EM = 12;

/** How far outwards a wrapper div is looked for (bounded so a stray tag far away is ignored). */
const WRAPPER_SEARCH_LIMIT = 200;

/* ────────────────────────────── line helpers ────────────────────────────── */

export interface LineRange {
  start: number;
  end: number;
}

export function lineRangeAt(text: string, pos: number): LineRange {
  const clamped = Math.max(0, Math.min(pos, text.length));
  const start = clamped <= 0 ? 0 : text.lastIndexOf('\n', clamped - 1) + 1;
  let end = text.indexOf('\n', clamped);
  if (end < 0) end = text.length;
  return { start, end };
}

/** Grow a selection to cover whole lines — block formats always act on lines. */
export function expandToLines(text: string, start: number, end: number): LineRange {
  const from = lineRangeAt(text, start).start;
  // A selection that ends exactly at a line break must not swallow the next line.
  const endPos = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const to = lineRangeAt(text, Math.max(from, endPos)).end;
  return { start: from, end: to };
}

interface Line {
  start: number;
  end: number;
  text: string;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let i = 0;
  for (;;) {
    let nl = text.indexOf('\n', i);
    if (nl < 0) nl = text.length;
    lines.push({ start: i, end: nl, text: text.slice(i, nl) });
    if (nl >= text.length) break;
    i = nl + 1;
  }
  return lines;
}

function lineIndexAt(lines: Line[], pos: number): number {
  for (let i = 0; i < lines.length; i++) {
    if (pos >= lines[i].start && pos <= lines[i].end) return i;
  }
  return lines.length - 1;
}

const isBlank = (line: Line): boolean => line.text.trim() === '';

/* ───────────────────────────── wrapper divs ───────────────────────────── */

export interface BlockWrapper {
  /** Offset of `<` of the opening div (start of its own line). */
  openStart: number;
  /** Offset just past `>` of the opening div (end of its own line). */
  openEnd: number;
  closeStart: number;
  closeEnd: number;
  /** Content region, excluding the blank padding lines. */
  innerStart: number;
  innerEnd: number;
  decls: StyleDecl[];
  /** Attributes other than `style`, preserved on rewrite. */
  otherAttrs: string;
}

/**
 * Find the wrapper div that already applies to the (line-expanded) region —
 * either because the region includes the `<div>`/`</div>` lines, or because
 * those lines sit immediately outside it (optionally separated by one blank
 * line). This is what stops repeated formatting from nesting divs.
 */
export function findBlockWrapper(text: string, from: number, to: number): BlockWrapper | null {
  const lines = splitLines(text);
  const a = lineIndexAt(lines, from);
  const b = lineIndexAt(lines, to);

  let openIdx = -1;
  let closeIdx = -1;

  if (b > a && DIV_OPEN_LINE.test(lines[a].text.trim()) && DIV_CLOSE_LINE.test(lines[b].text.trim())) {
    openIdx = a;
    closeIdx = b;
  } else {
    // The region sits inside the wrapper: scan outwards for the enclosing
    // `<div …>` / `</div>` lines. Hitting the opposite tag first means the
    // region is between two sibling blocks, not inside one.
    for (let p = a - 1; p >= 0 && a - p <= WRAPPER_SEARCH_LIMIT; p--) {
      const line = lines[p].text.trim();
      if (DIV_CLOSE_LINE.test(line)) break;
      if (DIV_OPEN_LINE.test(line)) {
        openIdx = p;
        break;
      }
    }
    for (let n = b + 1; openIdx >= 0 && n < lines.length && n - b <= WRAPPER_SEARCH_LIMIT; n++) {
      const line = lines[n].text.trim();
      if (DIV_OPEN_LINE.test(line)) break;
      if (DIV_CLOSE_LINE.test(line)) {
        closeIdx = n;
        break;
      }
    }
  }
  if (openIdx < 0 || closeIdx <= openIdx) return null;

  const attrs = lines[openIdx].text.trim().match(DIV_OPEN_LINE)?.[1] ?? '';
  let innerFirst = openIdx + 1;
  let innerLast = closeIdx - 1;
  if (innerFirst <= innerLast && isBlank(lines[innerFirst])) innerFirst++;
  if (innerFirst <= innerLast && isBlank(lines[innerLast])) innerLast--;
  const innerStart = innerFirst <= innerLast ? lines[innerFirst].start : lines[openIdx].end;
  const innerEnd = innerFirst <= innerLast ? lines[innerLast].end : innerStart;

  return {
    openStart: lines[openIdx].start,
    openEnd: lines[openIdx].end,
    closeStart: lines[closeIdx].start,
    closeEnd: lines[closeIdx].end,
    innerStart,
    innerEnd,
    decls: parseStyleDecls(extractStyleAttr(attrs)),
    otherAttrs: stripStyleAttr(attrs),
  };
}

function buildDivOpen(style: string, otherAttrs: string): string {
  const extra = otherAttrs ? ` ${otherAttrs}` : '';
  return `<div${extra} style="${style}">`;
}

/**
 * True when the wrapped text contains Markdown constructs that markdown-it
 * would stop parsing inside a compact raw-HTML block.
 */
export function needsBlankLines(inner: string): boolean {
  if (/\n[ \t]*\n/.test(inner)) return true;
  return /(\*\*|__|~~|`|!\[|\]\(|^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]|^[ \t]{0,3}#{1,6}[ \t]|^[ \t]{0,3}>|\|)/m.test(
    inner,
  );
}

function unwrap(text: string, w: BlockWrapper): EditResult {
  const inner = text.slice(w.innerStart, w.innerEnd);
  const newText = text.slice(0, w.openStart) + inner + text.slice(w.closeEnd);
  return { text: newText, start: w.openStart, end: w.openStart + inner.length };
}

/**
 * Merge `updates` into the wrapper div around the selection, creating the
 * wrapper if there is none and removing it once no declaration is left.
 *
 * `resetProps` are dropped from the existing style before merging, so a set of
 * related properties (a text box) is always replaced as a whole instead of
 * blending two presets together.
 */
export function applyBlockStyle(
  text: string,
  start: number,
  end: number,
  updates: StyleDecl[],
  resetProps: string[] = [],
): EditResult {
  const region = expandToLines(text, start, end);
  const wrapper = findBlockWrapper(text, region.start, region.end);

  if (wrapper) {
    const base = wrapper.decls.filter((d) => !resetProps.includes(d.prop));
    const style = serializeStyleDecls(mergeStyleDecls(base, updates));
    if (!style) return unwrap(text, wrapper);
    const open = buildDivOpen(style, wrapper.otherAttrs);
    const delta = open.length - (wrapper.openEnd - wrapper.openStart);
    const newText = text.slice(0, wrapper.openStart) + open + text.slice(wrapper.openEnd);
    return { text: newText, start: wrapper.innerStart + delta, end: wrapper.innerEnd + delta };
  }

  const style = serializeStyleDecls(mergeStyleDecls([], updates));
  if (!style) return { text, start, end }; // nothing to add and nothing to remove

  const inner = text.slice(region.start, region.end);
  const pad = needsBlankLines(inner) ? '\n' : '';
  const open = buildDivOpen(style, '');
  const block = `${open}\n${pad}${inner}\n${pad}</div>`;
  const innerStart = region.start + open.length + 1 + pad.length;
  return {
    text: text.slice(0, region.start) + block + text.slice(region.end),
    start: innerStart,
    end: innerStart + inner.length,
  };
}

/** Remove the wrapper div around the selection entirely (keeps its content). */
export function removeBlockWrapper(text: string, start: number, end: number): EditResult {
  const region = expandToLines(text, start, end);
  const wrapper = findBlockWrapper(text, region.start, region.end);
  return wrapper ? unwrap(text, wrapper) : { text, start, end };
}

/* ────────────────────────────── 文字框 ────────────────────────────── */

/** The box currently applied to the selection (for pre-filling the panel). */
export function readBoxAt(text: string, start: number, end: number): BoxSpec | null {
  const region = expandToLines(text, start, end);
  const wrapper = findBlockWrapper(text, region.start, region.end);
  return wrapper ? readBoxSpec(wrapper.decls) : null;
}

/** Apply a whole box spec (used by 文字框 and the 快速框線樣式 presets). */
export function applyBox(text: string, start: number, end: number, spec: BoxSpec): EditResult {
  return applyBlockStyle(text, start, end, boxSpecToDecls(spec), BOX_PROPS);
}

/**
 * Change one aspect of the box (框線顏色/粗細/樣式/圓角/內距/背景) while
 * keeping the rest. Falls back to the default box when none exists yet.
 */
export function applyBoxPatch(
  text: string,
  start: number,
  end: number,
  patch: Partial<BoxSpec>,
): EditResult {
  const current = readBoxAt(text, start, end) ?? DEFAULT_BOX;
  return applyBox(text, start, end, { ...current, ...patch });
}

/**
 * 移除文字框: drop only the box properties. Other block styles the user set
 * (置中、縮排) survive; the div disappears when nothing else is left.
 */
export function removeBox(text: string, start: number, end: number): EditResult {
  return applyBlockStyle(
    text,
    start,
    end,
    BOX_PROPS.map((prop) => ({ prop, value: '' })),
  );
}

/* ──────────────────── 對齊 / 縮排 / 引用 / 顏色 ──────────────────── */

export type TextAlign = 'left' | 'center' | 'right';

export function setBlockAlign(
  text: string,
  start: number,
  end: number,
  align: TextAlign | null,
): EditResult {
  return applyBlockStyle(text, start, end, [{ prop: 'text-align', value: align ?? '' }]);
}

/**
 * Indent by wrapping in a div with `margin-left` (in em) and stepping the
 * existing value. Leading spaces are deliberately NOT used: four spaces in
 * Markdown would turn the selection into a code block.
 */
export function changeIndent(text: string, start: number, end: number, direction: 1 | -1): EditResult {
  const region = expandToLines(text, start, end);
  const wrapper = findBlockWrapper(text, region.start, region.end);
  const current = wrapper ? Number.parseFloat(styleValue(wrapper.decls, 'margin-left')) || 0 : 0;
  const next = Math.max(0, Math.min(INDENT_MAX_EM, current + direction * INDENT_STEP_EM));
  return applyBlockStyle(text, start, end, [
    { prop: 'margin-left', value: next > 0 ? `${next}em` : '' },
  ]);
}

/** Toggle a `> ` Markdown blockquote on every selected line. */
export function toggleBlockquote(text: string, start: number, end: number): EditResult {
  const region = expandToLines(text, start, end);
  const lines = text.slice(region.start, region.end).split('\n');
  const quoted = lines.every((line) => line.trim() === '' || /^[ \t]*>[ \t]?/.test(line));
  const out = lines
    .map((line) => {
      if (quoted) return line.replace(/^([ \t]*)>[ \t]?/, '$1');
      if (line.trim() === '') return '>';
      return line.replace(/^([ \t]*)/, '$1> ');
    })
    .join('\n');
  return {
    text: text.slice(0, region.start) + out + text.slice(region.end),
    start: region.start,
    end: region.start + out.length,
  };
}

/**
 * Merge inline style declarations into a `<span style="...">` around the
 * selection, reusing an existing one (whether the selection covers the span or
 * sits inside it) so colors can be changed without nesting spans.
 */
export function applyInlineStyle(
  text: string,
  start: number,
  end: number,
  updates: StyleDecl[],
): EditResult {
  const sel = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);

  const exact = sel.match(/^<span\s+style="([^"]*)"\s*>([\s\S]*)<\/span\s*>$/i);
  if (exact) {
    const style = serializeStyleDecls(mergeStyleDecls(parseStyleDecls(exact[1]), updates));
    const replacement = style ? `<span style="${style}">${exact[2]}</span>` : exact[2];
    return {
      text: before + replacement + after,
      start,
      end: start + replacement.length,
    };
  }

  const open = before.match(/<span\s+style="([^"]*)"\s*>$/i);
  const close = after.match(/^<\/span\s*>/i);
  if (open && close) {
    const style = serializeStyleDecls(mergeStyleDecls(parseStyleDecls(open[1]), updates));
    const openStart = start - open[0].length;
    const head = text.slice(0, openStart);
    if (!style) {
      return { text: head + sel + after.slice(close[0].length), start: openStart, end: openStart + sel.length };
    }
    const newOpen = `<span style="${style}">`;
    return {
      text: head + newOpen + sel + after,
      start: openStart + newOpen.length,
      end: openStart + newOpen.length + sel.length,
    };
  }

  const style = serializeStyleDecls(mergeStyleDecls([], updates));
  if (!style) return { text, start, end };
  const replacement = `<span style="${style}">${sel}</span>`;
  return { text: before + replacement + after, start, end: start + replacement.length };
}

/**
 * 自訂背景顏色 / 自訂文字顏色. A single-line selection uses a span; anything
 * spanning lines uses the block wrapper (a span cannot style whole blocks).
 * An empty color removes the declaration.
 */
export function applyCustomColor(
  text: string,
  start: number,
  end: number,
  prop: 'color' | 'background-color',
  color: string,
): EditResult {
  const updates: StyleDecl[] = [{ prop, value: color }];
  if (text.slice(start, end).includes('\n')) return applyBlockStyle(text, start, end, updates);
  return applyInlineStyle(text, start, end, updates);
}

/* ──────────────────────────── 清除 HTML ──────────────────────────── */

const OPEN_TAG_AT_END = /<([a-zA-Z][\w:-]*)\b[^>]*>[\s]*$/;
const CLOSE_TAG_AT_START = /^[\s]*<\/([a-zA-Z][\w:-]*)\s*>/;

/**
 * Remove every HTML tag from the selection, plus the matching tag pairs that
 * sit immediately around it (a wrapper div/span the selection lives inside).
 *
 * Markdown is left untouched — that is the difference from
 * markdown-format.clearFormatting, which also strips `**`/`*`/`~~`/`` ` ``.
 * `<img>` tags are converted back to Markdown instead of being deleted so the
 * image itself never disappears.
 */
export function stripHtml(text: string, start: number, end: number): EditResult {
  let before = text.slice(0, start);
  let after = text.slice(end);
  let sel = text.slice(start, end);

  for (;;) {
    const open = before.match(OPEN_TAG_AT_END);
    const close = after.match(CLOSE_TAG_AT_START);
    if (!open || !close || open[1].toLowerCase() !== close[1].toLowerCase()) break;
    before = before.slice(0, before.length - open[0].length);
    after = after.slice(close[0].length);
  }

  sel = sel.replace(/<img\b[^>]*>/gi, (tag) => {
    const parsed = parseHtmlImage(tag, 0);
    return parsed ? toMarkdownImage(parsed) : '';
  });
  sel = sel.replace(/<\/?[a-zA-Z][\w:-]*\b[^>]*>/g, '');

  return { text: before + sel + after, start: before.length, end: before.length + sel.length };
}

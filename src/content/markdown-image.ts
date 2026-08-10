/**
 * Markdown / HTML image parsing and resizing.
 *
 * Pure functions (no DOM) — see tests/markdown-image.test.ts.
 *
 * Why a hand-written scanner instead of a regex: image paths on this wiki
 * contain CJK characters, spaces and parentheses (`影像 (1).png`). Splitting on
 * spaces or on the first `)` breaks those. `parseMarkdownImage` therefore scans
 * the `![…](…)` token with balanced-bracket counting and backslash-escape
 * awareness, exactly like a Markdown parser would.
 */

import {
  escapeHtmlAttr,
  mergeStyleDecls,
  parseStyleDecls,
  serializeStyleDecls,
  styleValue,
  unescapeHtmlAttr,
  type StyleDecl,
} from './html-style';
import type { EditResult } from './markdown-format';

export interface ImageTokenBase {
  /** Offset of the first character of the token. */
  start: number;
  /** Offset just past the last character of the token. */
  end: number;
  alt: string;
  url: string;
  title: string | null;
  raw: string;
}

export interface MarkdownImageToken extends ImageTokenBase {
  kind: 'markdown';
  /** markdown-it-imsize hint (`![a](u =400x300)`), preserved for reference. */
  sizeHint: string | null;
}

export interface HtmlImageToken extends ImageTokenBase {
  kind: 'html';
  decls: StyleDecl[];
  /** Attributes other than src/alt/title/style, kept verbatim on rewrite. */
  otherAttrs: string;
}

export type ImageToken = MarkdownImageToken | HtmlImageToken;

export const DEFAULT_IMAGE_BORDER = '1px solid #cccccc';
export const DEFAULT_IMAGE_RADIUS = '6px';

/* ────────────────────────────── parsing ────────────────────────────── */

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

/** Split a Markdown link destination into url + optional "title". */
function splitDestination(inside: string): { url: string; title: string | null; sizeHint: string | null } {
  let rest = inside.trim();
  let title: string | null = null;
  const titleMatch = rest.match(/\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')$/);
  if (titleMatch) {
    title = titleMatch[1] ?? titleMatch[2] ?? '';
    rest = rest.slice(0, rest.length - titleMatch[0].length).trim();
  }
  // markdown-it-imsize size hint: `![a](/x.png =400x300)`
  let sizeHint: string | null = null;
  const hintMatch = rest.match(/\s+=(\d*x\d*)$/i);
  if (hintMatch) {
    sizeHint = hintMatch[1];
    rest = rest.slice(0, rest.length - hintMatch[0].length).trim();
  }
  if (rest.startsWith('<') && rest.endsWith('>')) rest = rest.slice(1, -1).trim();
  return { url: rest, title, sizeHint };
}

export function parseMarkdownImage(text: string, index: number): MarkdownImageToken | null {
  if (text[index] !== '!' || text[index + 1] !== '[') return null;

  let i = index + 2;
  let depth = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n') return null; // alt text never spans lines
    if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) break;
    i++;
  }
  if (depth !== 0 || text[i + 1] !== '(') return null;
  const alt = text.slice(index + 2, i);

  let j = i + 2;
  let parens = 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '\n') return null; // destination never spans lines
    if (ch === '(') parens++;
    else if (ch === ')' && --parens === 0) break;
    j++;
  }
  if (parens !== 0) return null;

  const { url, title, sizeHint } = splitDestination(text.slice(i + 2, j));
  if (!url) return null;
  return {
    kind: 'markdown',
    start: index,
    end: j + 1,
    alt: alt.replace(/\\([[\]])/g, '$1'),
    url,
    title,
    sizeHint,
    raw: text.slice(index, j + 1),
  };
}

function parseAttrs(region: string): Array<{ name: string; value: string | null; raw: string }> {
  const out: Array<{ name: string; value: string | null; raw: string }> = [];
  const re = /([a-zA-Z_:][-\w:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region))) {
    const rawValue = m[2];
    let value: string | null = null;
    if (rawValue != null) {
      value =
        (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))
          ? rawValue.slice(1, -1)
          : rawValue;
    }
    out.push({ name: m[1].toLowerCase(), value, raw: m[0] });
  }
  return out;
}

export function parseHtmlImage(text: string, index: number): HtmlImageToken | null {
  if (!/^<img[\s/>]/i.test(text.slice(index, index + 5))) return null;

  let i = index + 4;
  let quote = '';
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      break;
    }
    i++;
  }
  if (i >= text.length) return null;

  const attrs = parseAttrs(text.slice(index + 4, i).replace(/\/\s*$/, ''));
  const find = (name: string) => attrs.find((a) => a.name === name)?.value ?? null;
  const src = find('src');
  if (src == null) return null;

  const known = new Set(['src', 'alt', 'title', 'style']);
  const title = find('title');
  return {
    kind: 'html',
    start: index,
    end: i + 1,
    alt: unescapeHtmlAttr(find('alt') ?? ''),
    url: unescapeHtmlAttr(src),
    title: title == null ? null : unescapeHtmlAttr(title),
    decls: parseStyleDecls(find('style') ?? ''),
    otherAttrs: attrs
      .filter((a) => !known.has(a.name))
      .map((a) => a.raw.trim())
      .join(' '),
    raw: text.slice(index, i + 1),
  };
}

/** Every Markdown and HTML image in the document, in document order. */
export function findImages(text: string): ImageToken[] {
  const out: ImageToken[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '!' && text[i + 1] === '[' && !isEscaped(text, i)) {
      const token = parseMarkdownImage(text, i);
      if (token) {
        out.push(token);
        i = token.end;
        continue;
      }
    } else if (ch === '<') {
      const token = parseHtmlImage(text, i);
      if (token) {
        out.push(token);
        i = token.end;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * Resolve which image the user means, in order of confidence:
 *  1. the image the selection overlaps (完整反白圖片語法);
 *  2. the image the caret sits inside (只把游標放在語法內);
 *  3. the image nearest the caret on the caret's own line — covers a caret
 *     anywhere on the image's line, whether the line holds only the image or
 *     other content around it.
 *
 * A caret on a lone `<div …>` / `</div>` line also matches the image it wraps,
 * so right-clicking the wrapper of a centred image still offers the tools.
 * Anything further away is deliberately NOT matched: the native context menu
 * must stay available everywhere else.
 */
export function findImageAt(text: string, start: number, end: number): ImageToken | null {
  const tokens = findImages(text);
  if (tokens.length === 0) return null;

  if (end > start) {
    const overlap = tokens.find((t) => t.start < end && t.end > start);
    if (overlap) return overlap;
  }
  const atCaret = tokens.find((t) => start >= t.start && start <= t.end);
  if (atCaret) return atCaret;

  const scope = caretSearchRange(text, start);
  const near = tokens.filter((t) => t.start < scope.end && t.end > scope.start);
  if (near.length === 0) return null;
  return near.reduce((best, t) => (distanceTo(t, start) < distanceTo(best, start) ? t : best));
}

function distanceTo(token: ImageToken, pos: number): number {
  if (pos < token.start) return token.start - pos;
  if (pos > token.end) return pos - token.end;
  return 0;
}

const LONE_DIV_LINE = /^<\/?div\b[^>]*>$/i;

/** The caret's line, widened by one line when the caret sits on a lone div tag. */
function caretSearchRange(text: string, pos: number): { start: number; end: number } {
  const lineStart = pos <= 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;
  let lineEnd = text.indexOf('\n', pos);
  if (lineEnd < 0) lineEnd = text.length;
  if (!LONE_DIV_LINE.test(text.slice(lineStart, lineEnd).trim())) {
    return { start: lineStart, end: lineEnd };
  }
  const prevStart = lineStart <= 1 ? 0 : text.lastIndexOf('\n', lineStart - 2) + 1;
  let nextEnd = text.indexOf('\n', lineEnd + 1);
  if (nextEnd < 0) nextEnd = text.length;
  return { start: prevStart, end: nextEnd };
}

/* ────────────────────────────── building ────────────────────────────── */

export function buildImgTag(image: {
  url: string;
  alt: string;
  title: string | null;
  decls: StyleDecl[];
  otherAttrs?: string;
}): string {
  const parts = [`src="${escapeHtmlAttr(image.url)}"`, `alt="${escapeHtmlAttr(image.alt)}"`];
  if (image.title) parts.push(`title="${escapeHtmlAttr(image.title)}"`);
  if (image.otherAttrs) parts.push(image.otherAttrs);
  const style = serializeStyleDecls(image.decls);
  if (style) parts.push(`style="${style}"`);
  return `<img ${parts.join(' ')}>`;
}

/** Render a token back as Markdown (`![alt](url "title")`). */
export function toMarkdownImage(image: ImageToken): string {
  const alt = image.alt.replace(/([[\]])/g, '\\$1');
  // CommonMark requires <> around destinations containing whitespace or
  // unbalanced parentheses — `影像 (1).png` stays readable, `a (b.png` stays valid.
  const url = /\s/.test(image.url) || !hasBalancedParens(image.url) ? `<${image.url}>` : image.url;
  const title = image.title ? ` "${image.title.replace(/"/g, '\\"')}"` : '';
  return `![${alt}](${url}${title})`;
}

function hasBalancedParens(value: string): boolean {
  let depth = 0;
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/* ────────────────────── wrapper div (置左/置中/置右) ────────────────────── */

export interface ImageWrapper {
  /** Offset of `<` of the opening div. */
  start: number;
  /** Offset just past the last `>` of `</div>`. */
  end: number;
  /** Offset just past `>` of the opening div. */
  openEnd: number;
  /** Offset of `<` of the closing `</div>`. */
  closeStart: number;
  decls: StyleDecl[];
}

/**
 * The alignment div immediately around an image, if any. At most one newline is
 * allowed on each side, so an unrelated div elsewhere in the document is never
 * mistaken for this image's wrapper — that is what keeps repeated alignment
 * from stacking divs.
 */
export function findImageWrapper(text: string, image: ImageToken): ImageWrapper | null {
  const open = text.slice(0, image.start).match(/(<div\b[^>]*>)([ \t]*\n?[ \t]*)$/i);
  const close = text.slice(image.end).match(/^([ \t]*\n?[ \t]*)(<\/div\s*>)/i);
  if (!open || !close) return null;
  const start = image.start - open[0].length;
  return {
    start,
    end: image.end + close[0].length,
    openEnd: start + open[1].length,
    closeStart: image.end + close[1].length,
    decls: parseStyleDecls(open[1].match(/\bstyle\s*=\s*"([^"]*)"/i)?.[1] ?? ''),
  };
}

/* ────────────────────────────── operations ────────────────────────────── */

const unchanged = (text: string, start: number, end: number): EditResult => ({ text, start, end });

function writeImage(text: string, image: ImageToken, decls: StyleDecl[]): EditResult {
  const tag = buildImgTag({
    url: image.url,
    alt: image.alt,
    title: image.title,
    decls,
    otherAttrs: image.kind === 'html' ? image.otherAttrs : '',
  });
  return {
    text: text.slice(0, image.start) + tag + text.slice(image.end),
    start: image.start,
    end: image.start + tag.length,
  };
}

/** Convert a Markdown image to `<img>` in place, so styles can be attached. */
function ensureHtmlImage(
  text: string,
  image: ImageToken,
): { text: string; image: HtmlImageToken } | null {
  if (image.kind === 'html') return { text, image };
  const written = writeImage(text, image, []);
  const parsed = parseHtmlImage(written.text, image.start);
  return parsed ? { text: written.text, image: parsed } : null;
}

function editStyle(
  text: string,
  start: number,
  end: number,
  updates: StyleDecl[] | ((decls: StyleDecl[]) => StyleDecl[]),
): EditResult {
  const found = findImageAt(text, start, end);
  if (!found) return unchanged(text, start, end);
  const html = ensureHtmlImage(text, found);
  if (!html) return unchanged(text, start, end);
  const decls =
    typeof updates === 'function' ? updates(html.image.decls) : mergeStyleDecls(html.image.decls, updates);
  return writeImage(html.text, html.image, decls);
}

export type SizeUnit = 'px' | '%';

/**
 * 調整圖片大小. `width`/`height` are complete CSS values ('400px', '50%', '');
 * an empty height becomes `auto` whenever a width is given, per the spec.
 */
export function setImageSize(
  text: string,
  start: number,
  end: number,
  width: string,
  height = '',
): EditResult {
  const resolvedHeight = height || (width ? 'auto' : '');
  return editStyle(text, start, end, [
    { prop: 'width', value: width },
    { prop: 'height', value: resolvedHeight },
  ]);
}

/** Build a CSS length from a number + unit, tolerating a value that has one. */
export function toCssLength(value: string, unit: SizeUnit): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^auto$/i.test(trimmed)) return 'auto';
  if (/(px|%|em|rem|vw|vh)$/i.test(trimmed)) return trimmed;
  const num = Number.parseFloat(trimmed);
  if (!Number.isFinite(num) || num <= 0) return '';
  return `${num}${unit}`;
}

/** 原始尺寸 — drop width/height, keep other styling (框線/圓角). */
export function clearImageSize(text: string, start: number, end: number): EditResult {
  return editStyle(text, start, end, [
    { prop: 'width', value: '' },
    { prop: 'height', value: '' },
  ]);
}

/** 移除圖片尺寸設定 — drop the whole inline style attribute. */
export function removeImageStyle(text: string, start: number, end: number): EditResult {
  return editStyle(text, start, end, () => []);
}

export function toggleImageRadius(text: string, start: number, end: number): EditResult {
  return editStyle(text, start, end, (decls) =>
    mergeStyleDecls(decls, [
      { prop: 'border-radius', value: styleValue(decls, 'border-radius') ? '' : DEFAULT_IMAGE_RADIUS },
    ]),
  );
}

export function toggleImageBorder(text: string, start: number, end: number): EditResult {
  return editStyle(text, start, end, (decls) =>
    mergeStyleDecls(decls, [
      { prop: 'border', value: styleValue(decls, 'border') ? '' : DEFAULT_IMAGE_BORDER },
    ]),
  );
}

/**
 * 置左 / 置中 / 置右 (null removes the alignment). Reuses the existing wrapper
 * div when there is one, so adjusting the size or alignment repeatedly never
 * adds another div.
 */
export function setImageAlign(
  text: string,
  start: number,
  end: number,
  align: 'left' | 'center' | 'right' | null,
): EditResult {
  const found = findImageAt(text, start, end);
  if (!found) return unchanged(text, start, end);
  const html = ensureHtmlImage(text, found);
  if (!html) return unchanged(text, start, end);
  const { text: t, image } = html;

  const wrapper = findImageWrapper(t, image);
  const tag = t.slice(image.start, image.end);

  if (wrapper) {
    const style = serializeStyleDecls(
      mergeStyleDecls(wrapper.decls, [{ prop: 'text-align', value: align ?? '' }]),
    );
    if (!style) {
      return {
        text: t.slice(0, wrapper.start) + tag + t.slice(wrapper.end),
        start: wrapper.start,
        end: wrapper.start + tag.length,
      };
    }
    const open = `<div style="${style}">`;
    const delta = open.length - (wrapper.openEnd - wrapper.start);
    return {
      text: t.slice(0, wrapper.start) + open + t.slice(wrapper.openEnd),
      start: image.start + delta,
      end: image.end + delta,
    };
  }

  if (!align) return { text: t, start: image.start, end: image.end };

  // Keep the image on one line when the line holds other content (a list
  // bullet, surrounding text) so the surrounding Markdown is not broken.
  const lineStart = image.start <= 0 ? 0 : t.lastIndexOf('\n', image.start - 1) + 1;
  let lineEnd = t.indexOf('\n', image.end);
  if (lineEnd < 0) lineEnd = t.length;
  const alone =
    t.slice(lineStart, image.start).trim() === '' && t.slice(image.end, lineEnd).trim() === '';

  const open = `<div style="text-align: ${align};">`;
  const block = alone ? `${open}\n  ${tag}\n</div>` : `${open}${tag}</div>`;
  const offset = alone ? open.length + 3 : open.length;
  return {
    text: t.slice(0, image.start) + block + t.slice(image.end),
    start: image.start + offset,
    end: image.start + offset + tag.length,
  };
}

/**
 * 將 HTML 圖片還原成 Markdown 圖片語法. An alignment-only wrapper div is
 * removed with it (Markdown cannot express it); a wrapper that carries other
 * styles is kept.
 */
export function restoreMarkdownImage(text: string, start: number, end: number): EditResult {
  const image = findImageAt(text, start, end);
  if (!image || image.kind === 'markdown') return unchanged(text, start, end);
  const markdown = toMarkdownImage(image);

  const wrapper = findImageWrapper(text, image);
  const alignOnly =
    wrapper != null && wrapper.decls.every((d) => d.prop === 'text-align');
  if (wrapper && alignOnly) {
    return {
      text: text.slice(0, wrapper.start) + markdown + text.slice(wrapper.end),
      start: wrapper.start,
      end: wrapper.start + markdown.length,
    };
  }
  return {
    text: text.slice(0, image.start) + markdown + text.slice(image.end),
    start: image.start,
    end: image.start + markdown.length,
  };
}

/** Human-readable summary shown in the menu header (「圖片：xxx.jpg」). */
export function describeImage(image: ImageToken): string {
  const name = image.url.split('/').pop() ?? image.url;
  const width = image.kind === 'html' ? styleValue(image.decls, 'width') : '';
  return width ? `${name}（${width}）` : name;
}

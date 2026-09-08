import { parseHtmlImage, parseMarkdownImage } from './markdown-image';

export type HybridBlockType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'blockquote'
  | 'code-fence'
  | 'image'
  | 'link'
  | 'html'
  | 'horizontal-rule'
  | 'mixed'
  | 'raw';

/** Semantic class suffix emitted by Wiki.js' markdown-it-attrs renderer. */
export type HybridSemanticType = string;

export interface HybridMarkdownBlock {
  id: string;
  type: HybridBlockType;
  /** Semantic meaning carried by a trailing Wiki.js attrs line, if any. */
  semanticType?: HybridSemanticType;
  rawMarkdown: string;
  renderedHTML: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

interface SourceLine {
  text: string;
  start: number;
  end: number;
  line: number;
}

const RE_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const RE_LIST = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const RE_QUOTE = /^ {0,3}>/;
const RE_HR = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const RE_INDENTED = /^[ \t]+\S/;
const RE_HTML_OPEN = /^ {0,3}<([a-zA-Z][\w:-]*)\b[^>]*>[ \t]*$/;
const BLOCK_TAGS = new Set(['div', 'details', 'section', 'figure', 'blockquote', 'table', 'aside']);
const RE_ATTRS_LINE = /^ {0,3}\{([^{}\n]*)\}[ \t]*$/;

/**
 * Read Wiki.js' semantic class from source, rather than from the renderer's
 * current paint. The renderer consumes `{.is-warning}` (and its siblings) into
 * a DOM class, so the source block must retain the meaning independently of
 * whichever DOM tree is currently mounted. Keeping the suffix open-ended also
 * preserves site-specific variants such as `success`, `note`, or a custom
 * `is-*` class without pretending the extension owns their CSS.
 */
export function semanticTypeFromMarkdown(markdown: string): HybridSemanticType | undefined {
  const lines = markdown.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (line === '') continue;
    const attrs = RE_ATTRS_LINE.exec(line);
    if (!attrs) break;
    const match = /(?:^|\s)\.is-([A-Za-z][\w-]*)(?=$|\s)/.exec(attrs[1]);
    if (match) return match[1];
  }
  return undefined;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  let line = 0;
  while (start < source.length) {
    const newline = source.indexOf('\n', start);
    const fullEnd = newline < 0 ? source.length : newline;
    const end = fullEnd > start && source[fullEnd - 1] === '\r' ? fullEnd - 1 : fullEnd;
    lines.push({ text: source.slice(start, end), start, end, line });
    if (newline < 0) break;
    start = newline + 1;
    line++;
  }
  return lines;
}

function tableStarts(lines: readonly SourceLine[], index: number): boolean {
  const next = lines[index + 1]?.text;
  if (!next) return false;
  return /\|/.test(lines[index].text) && /^ {0,3}\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
}

function interruptsParagraph(lines: readonly SourceLine[], index: number): boolean {
  const line = lines[index]?.text ?? '';
  return (
    RE_HEADING.test(line) ||
    RE_FENCE.test(line) ||
    RE_LIST.test(line) ||
    RE_QUOTE.test(line) ||
    RE_HR.test(line) ||
    tableStarts(lines, index)
  );
}

function classifyInline(raw: string): HybridBlockType {
  const trimmed = raw.trim();
  // A greedy expression also matches several adjacent images (or captions).
  // Only a token consuming the entire body is a standalone image block.
  const image = parseMarkdownImage(trimmed, 0) ?? parseHtmlImage(trimmed, 0);
  if (image?.end === trimmed.length) return 'image';
  if (/^\[[^\]]+\]\([\s\S]+\)$/.test(trimmed)) return 'link';
  if (/^(?:\{\{|\{%|:::|\[\[|<%)/.test(trimmed)) return 'raw';
  if (/<[a-zA-Z][^>]*>/.test(trimmed)) return 'mixed';
  return 'paragraph';
}

function stripTrailingAttributeLines(raw: string): string {
  const lines = raw.split(/\r?\n/);
  while (lines.length > 1 && RE_ATTRS_LINE.test(lines.at(-1)!.trim())) lines.pop();
  return lines.join('\n');
}

function makeBlock(source: string, lines: readonly SourceLine[], from: number, to: number, type: HybridBlockType): HybridMarkdownBlock {
  const first = lines[from];
  const last = lines[to];
  const rawMarkdown = source.slice(first.start, last.end);
  return {
    id: `${type}:${first.start}:${last.end}`,
    type,
    semanticType: semanticTypeFromMarkdown(rawMarkdown),
    rawMarkdown,
    renderedHTML: '',
    startOffset: first.start,
    endOffset: last.end,
    startLine: first.line,
    endLine: last.line,
  };
}

function isAttributeOnlyBlock(block: HybridMarkdownBlock): boolean {
  return block.rawMarkdown
    .split(/\r?\n/)
    .every((line) => RE_ATTRS_LINE.test(line.trim()));
}

/**
 * Some Markdown block rules stop before a following attrs line (notably
 * headings, tables, fences, and raw HTML). Wiki.js treats an adjacent
 * `{.variant}` line as metadata for the preceding block, not as a new text
 * paragraph. Attach those lines to the same source block so a later visual
 * edit cannot orphan or drop them.
 */
function attachAdjacentAttributeBlocks(
  source: string,
  blocks: readonly HybridMarkdownBlock[],
): HybridMarkdownBlock[] {
  const merged: HybridMarkdownBlock[] = [];
  for (const block of blocks) {
    const previous = merged.at(-1);
    const separator = previous
      ? source.slice(previous.endOffset, block.startOffset)
      : '';
    const isSingleBlankSeparator = /^(?:\r?\n)$/.test(separator);
    const isSemanticAttributeAfterBlank =
      block.semanticType !== undefined && /^(?:\r?\n)+$/.test(separator);
    if (
      previous &&
      isAttributeOnlyBlock(block) &&
      // A user pressing Enter at the end of a rendered alert can leave one
      // empty Markdown line before the attrs line. Wiki.js still renders the
      // attrs as metadata for the preceding block, so keep that metadata
      // attached instead of letting the visual round-trip turn the alert into
      // an unstyled quote. Semantic attrs may bridge more than one blank line
      // because older versions of the visual editor inserted two line breaks.
      (isSingleBlankSeparator || isSemanticAttributeAfterBlank)
    ) {
      const rawMarkdown = source.slice(previous.startOffset, block.endOffset);
      merged[merged.length - 1] = {
        ...previous,
        rawMarkdown,
        endOffset: block.endOffset,
        endLine: block.endLine,
        semanticType: semanticTypeFromMarkdown(rawMarkdown),
      };
      continue;
    }
    merged.push(block);
  }
  return merged;
}

/**
 * Conservative, offset-preserving block scan for the Hybrid UI. It never
 * normalizes or rejoins Markdown; untouched bytes between block ranges stay in
 * the native CodeMirror document exactly as they were.
 */
export function parseHybridBlocks(source: string): HybridMarkdownBlock[] {
  const lines = sourceLines(source);
  const blocks: HybridMarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].text.trim() === '') {
      i++;
      continue;
    }
    const from = i;
    const text = lines[i].text;
    const fence = RE_FENCE.exec(text);

    if (fence) {
      const marker = fence[1][0];
      const close = new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${fence[1].length},}[ \\t]*$`);
      i++;
      let closed = false;
      while (i < lines.length) {
        if (close.test(lines[i].text)) {
          closed = true;
          i++;
          break;
        }
        i++;
      }
      blocks.push(makeBlock(source, lines, from, i - 1, closed ? 'code-fence' : 'raw'));
      continue;
    }

    const html = RE_HTML_OPEN.exec(text);
    if (html && BLOCK_TAGS.has(html[1].toLowerCase())) {
      const tag = html[1].toLowerCase();
      const open = new RegExp(`^ {0,3}<${tag}\\b[^>]*>[ \\t]*$`, 'i');
      const close = new RegExp(`^ {0,3}</${tag}\\s*>[ \\t]*$`, 'i');
      let depth = 0;
      let closed = false;
      while (i < lines.length) {
        if (open.test(lines[i].text)) depth++;
        else if (close.test(lines[i].text)) {
          depth--;
          if (depth === 0) {
            i++;
            closed = true;
            break;
          }
        }
        i++;
      }
      blocks.push(makeBlock(source, lines, from, Math.max(from, i - 1), closed ? 'html' : 'raw'));
      continue;
    }

    if (RE_HEADING.test(text)) {
      blocks.push(makeBlock(source, lines, from, from, 'heading'));
      i++;
      continue;
    }
    if (RE_HR.test(text)) {
      blocks.push(makeBlock(source, lines, from, from, 'horizontal-rule'));
      i++;
      continue;
    }
    if (tableStarts(lines, i)) {
      i += 2;
      while (i < lines.length && lines[i].text.trim() !== '' && /\|/.test(lines[i].text)) i++;
      blocks.push(makeBlock(source, lines, from, i - 1, 'table'));
      continue;
    }
    if (RE_QUOTE.test(text)) {
      i++;
      while (i < lines.length && lines[i].text.trim() !== '') {
        // Attribute lines are metadata for this quote, not lazy quote text.
        // Stop after the suffix so a following thematic break cannot be
        // swallowed into the quote and hide the semantic class.
        if (RE_ATTRS_LINE.test(lines[i].text.trim())) {
          i++;
          while (i < lines.length && RE_ATTRS_LINE.test(lines[i].text.trim())) i++;
          break;
        }
        // A missing blank separator is easy to create by pressing Enter in
        // the visual editor. Keep the quote's attrs intact even in that
        // tolerant input by letting the following rule become its own block.
        if (RE_HR.test(lines[i].text)) break;
        if (RE_HEADING.test(lines[i].text) || RE_FENCE.test(lines[i].text)) break;
        i++;
      }
      blocks.push(makeBlock(source, lines, from, i - 1, 'blockquote'));
      continue;
    }
    if (RE_LIST.test(text)) {
      i++;
      while (i < lines.length) {
        if (lines[i].text.trim() === '') {
          let next = i + 1;
          while (next < lines.length && lines[next].text.trim() === '') next++;
          if (next < lines.length && (RE_LIST.test(lines[next].text) || RE_INDENTED.test(lines[next].text))) {
            i = next;
            continue;
          }
          break;
        }
        if (RE_HEADING.test(lines[i].text) || RE_FENCE.test(lines[i].text) || RE_QUOTE.test(lines[i].text)) break;
        i++;
      }
      blocks.push(makeBlock(source, lines, from, i - 1, 'list'));
      continue;
    }

    i++;
    while (i < lines.length && lines[i].text.trim() !== '' && !interruptsParagraph(lines, i)) i++;
    const provisional = makeBlock(source, lines, from, i - 1, 'paragraph');
    // markdown-it-attrs consumes a trailing attribute line from the rendered
    // DOM, but it is still part of this source block. Classify the body
    // without that metadata so an image/link with `{.variant}` does not get
    // downgraded to a generic paragraph during the round-trip.
    provisional.type = classifyInline(stripTrailingAttributeLines(provisional.rawMarkdown));
    provisional.id = `${provisional.type}:${provisional.startOffset}:${provisional.endOffset}`;
    blocks.push(provisional);
  }

  const blocksWithMetadata = attachAdjacentAttributeBlocks(source, blocks);

  // Offsets are bookkeeping, not identity. A text edit changes the offsets of
  // every following block, so using `start:end` as an id makes an unchanged
  // DOM block look newly created after every source projection. The ordinal is
  // stable for the common edit-in-place case; a real insert/delete is a
  // structural change and is allowed to shift later ordinals.
  return blocksWithMetadata.map((block, index) => ({
    ...block,
    id: `block:${index}`,
  }));
}

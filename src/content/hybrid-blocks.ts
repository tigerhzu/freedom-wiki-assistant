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

export interface HybridMarkdownBlock {
  id: string;
  type: HybridBlockType;
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
  if (/^!\[[^\]]*\]\([\s\S]+\)$/.test(trimmed) || /^<img\b[\s\S]*>$/i.test(trimmed)) return 'image';
  if (/^\[[^\]]+\]\([\s\S]+\)$/.test(trimmed)) return 'link';
  if (/^(?:\{\{|\{%|:::|\[\[|<%)/.test(trimmed)) return 'raw';
  if (/<[a-zA-Z][^>]*>/.test(trimmed)) return 'mixed';
  return 'paragraph';
}

function makeBlock(source: string, lines: readonly SourceLine[], from: number, to: number, type: HybridBlockType): HybridMarkdownBlock {
  const first = lines[from];
  const last = lines[to];
  const rawMarkdown = source.slice(first.start, last.end);
  return {
    id: `${type}:${first.start}:${last.end}`,
    type,
    rawMarkdown,
    renderedHTML: '',
    startOffset: first.start,
    endOffset: last.end,
    startLine: first.line,
    endLine: last.line,
  };
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
      while (i < lines.length && lines[i].text.trim() !== '' && !RE_HEADING.test(lines[i].text) && !RE_FENCE.test(lines[i].text)) i++;
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
    provisional.type = classifyInline(provisional.rawMarkdown);
    provisional.id = `${provisional.type}:${provisional.startOffset}:${provisional.endOffset}`;
    blocks.push(provisional);
  }

  return blocks;
}

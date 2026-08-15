export interface TextRange {
  start: number;
  end: number;
}

interface ProjectedToken extends TextRange {
  value: string;
}

interface NormalizedText {
  value: string;
  starts: number[];
  ends: number[];
}

function normalizeWithOffsets(value: string): NormalizedText {
  let normalized = '';
  const starts: number[] = [];
  const ends: number[] = [];

  for (let index = 0; index < value.length;) {
    if (/\s/.test(value[index])) {
      const start = index;
      while (index < value.length && /\s/.test(value[index])) index++;
      normalized += ' ';
      starts.push(start);
      ends.push(index);
      continue;
    }
    normalized += value[index];
    starts.push(index);
    index++;
    ends.push(index);
  }

  return { value: normalized, starts, ends };
}

/**
 * Locate rendered selection text inside Markdown while treating browser layout
 * whitespace (newlines, tabs and repeated spaces) as equivalent. Returned
 * offsets always point into the original Markdown string.
 */
export function findNormalizedTextRange(source: string, selectedText: string): TextRange | null {
  const trimmed = selectedText.trim();
  if (trimmed === '') return null;

  const haystack = normalizeWithOffsets(source);
  const needle = normalizeWithOffsets(trimmed).value;
  const normalizedStart = haystack.value.indexOf(needle);
  if (normalizedStart < 0 || normalizedStart !== haystack.value.lastIndexOf(needle)) return null;

  const normalizedEnd = normalizedStart + needle.length - 1;
  return {
    start: haystack.starts[normalizedStart],
    end: haystack.ends[normalizedEnd],
  };
}

function projectMarkdown(source: string, from = 0, to = source.length): ProjectedToken[] {
  const tokens: ProjectedToken[] = [];
  let index = from;
  let lineStart = index === 0 || source[index - 1] === '\n';

  const emit = (value: string, start: number, end: number) => tokens.push({ value, start, end });

  while (index < to) {
    if (lineStart) {
      const rest = source.slice(index, to);
      const directive = rest.match(/^\s*\{\.[^}\n]+\}(?=\s*(?:\n|$))/);
      if (directive) {
        index += directive[0].length;
        lineStart = false;
        continue;
      }
      const prefix = rest.match(/^(?: {0,3})(?:#{1,6}[ \t]+|>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+)/);
      if (prefix) index += prefix[0].length;
      lineStart = false;
      if (index >= to) break;
    }

    const char = source[index];
    if (char === '\n') {
      emit(char, index, index + 1);
      index++;
      lineStart = true;
      continue;
    }

    // Images have no selectable rendered text. Links expose only their label.
    const rest = source.slice(index, to);
    const image = rest.match(/^!\[([^\]\n]*)\]\([^\n)]*(?:\)[^\n)]*)?\)/);
    if (image) {
      index += image[0].length;
      continue;
    }
    const link = rest.match(/^\[([^\]\n]*)\]\([^\n)]*(?:\)[^\n)]*)?\)/);
    if (link) {
      const labelStart = index + 1;
      tokens.push(...projectMarkdown(source, labelStart, labelStart + link[1].length));
      index += link[0].length;
      continue;
    }

    const html = rest.match(/^<[^>\n]+>/);
    if (html) {
      if (/^<br\s*\/?\s*>$/i.test(html[0])) emit('\n', index, index + html[0].length);
      index += html[0].length;
      continue;
    }

    if (char === '\\' && index + 1 < to) {
      emit(source[index + 1], index, index + 2);
      index += 2;
      continue;
    }

    const marker = rest.match(/^(?:\*\*|__|~~|`+|\*(?=\S)|(?<=\S)\*)/);
    if (marker) {
      index += marker[0].length;
      continue;
    }

    emit(char, index, index + 1);
    index++;
  }
  return tokens;
}

interface NormalizedProjection {
  value: string;
  tokenStarts: number[];
  tokenEnds: number[];
}

function normalizeProjection(tokens: ProjectedToken[]): NormalizedProjection {
  let value = '';
  const tokenStarts: number[] = [];
  const tokenEnds: number[] = [];
  for (let index = 0; index < tokens.length;) {
    if (/\s/.test(tokens[index].value)) {
      const start = index;
      while (index < tokens.length && /\s/.test(tokens[index].value)) index++;
      value += ' ';
      tokenStarts.push(start);
      tokenEnds.push(index);
      continue;
    }
    value += tokens[index].value;
    tokenStarts.push(index);
    index++;
    tokenEnds.push(index);
  }
  return { value, tokenStarts, tokenEnds };
}

/**
 * Map rendered text back through Markdown syntax. Unlike
 * findNormalizedTextRange, this ignores formatting tags/markers, link targets,
 * block prefixes and Wiki.js directive lines. Discontinuous visible portions
 * are returned as separate ranges so an inline wrapper never crosses a list
 * item, line break or an existing Markdown wrapper.
 */
export function findMarkdownTextRanges(source: string, selectedText: string): TextRange[] | null {
  const trimmed = selectedText.trim();
  if (trimmed === '') return null;

  const tokens = projectMarkdown(source);
  const projection = normalizeProjection(tokens);
  const needle = normalizeWithOffsets(trimmed).value;
  const matchStart = projection.value.indexOf(needle);
  if (matchStart < 0 || matchStart !== projection.value.lastIndexOf(needle)) return null;

  const normalizedEnd = matchStart + needle.length - 1;
  const rawStart = projection.tokenStarts[matchStart];
  const rawEnd = projection.tokenEnds[normalizedEnd];
  const matched = tokens.slice(rawStart, rawEnd);
  const ranges: TextRange[] = [];
  let active: TextRange | null = null;

  for (const token of matched) {
    const raw = source.slice(token.start, token.end);
    if (raw.includes('\n')) {
      if (active) ranges.push(active);
      active = null;
      continue;
    }
    if (active && token.start === active.end) active.end = token.end;
    else {
      if (active) ranges.push(active);
      active = { start: token.start, end: token.end };
    }
  }
  if (active) ranges.push(active);

  return ranges.filter((range) => source.slice(range.start, range.end).trim() !== '');
}

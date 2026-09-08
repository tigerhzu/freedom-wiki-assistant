import type { HybridMarkdownBlock } from './hybrid-blocks';
import { toMarkdownImage } from './markdown-image';

const EXACT_SOURCE_ATTR = 'data-fwa-markdown-source';
const VISUAL_BLOCK_STYLE_ATTR = 'data-fwa-visual-block-style';

function isTwemojiImage(element: HTMLElement): boolean {
  return /\/_assets\/svg\/twemoji\//i.test(element.getAttribute('src') ?? '');
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([*_[\]])/g, '\\$1')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // A raw newline inside a rendered text node is only whitespace —
    // markdown-it emits soft breaks as `<br>\n`, and counting that trailing
    // newline again would turn every line break into a blank line.
    .replace(/\n/g, ' ');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  const padding = /^\s|\s$/.test(text) ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}

function serializeNodes(nodes: Iterable<Node>): string {
  return Array.from(nodes, (node) => serializeNode(node)).join('');
}

function splitTerminalLineBreaks(value: string): { body: string; suffix: string } {
  const match = value.match(/(?:\n[ \t]*)+$/);
  if (!match) return { body: value, suffix: '' };
  return { body: value.slice(0, -match[0].length), suffix: match[0] };
}

function splitTerminalInlineSuffix(value: string): { body: string; suffix: string } {
  const lineBreak = splitTerminalLineBreaks(value);
  const match = lineBreak.body.match(/[ \t]+$/);
  if (!match) return lineBreak;
  return {
    body: lineBreak.body.slice(0, -match[0].length),
    suffix: `${match[0]}${lineBreak.suffix}`,
  };
}

function wrapInline(opening: string, value: string, closing: string): string {
  const { body, suffix } = splitTerminalInlineSuffix(value);
  return `${opening}${body}${closing}${suffix}`;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? '');
  if (!(node instanceof HTMLElement)) return '';
  // Wiki.js turns Unicode emoji into Twemoji <img> elements while rendering.
  // Writing that renderer-owned image back would permanently change an emoji
  // into a normal Markdown image, which then renders at its intrinsic SVG size.
  if (node.tagName === 'IMG' && isTwemojiImage(node)) return node.getAttribute('alt') ?? '';
  const exactSource = node.getAttribute(EXACT_SOURCE_ATTR);
  if (exactSource !== null) return exactSource;
  const inner = () => serializeNodes(node.childNodes);

  switch (node.tagName) {
    case 'BR':
      return '\n';
    case 'STRONG':
    case 'B':
      return wrapInline('**', inner(), '**');
    case 'EM':
    case 'I':
      return wrapInline('*', inner(), '*');
    case 'CODE':
      return codeSpan(node.textContent ?? '');
    case 'DEL':
    case 'S':
      return wrapInline('~~', inner(), '~~');
    case 'U':
      return wrapInline('<u>', inner(), '</u>');
    case 'MARK':
      return wrapInline('<mark>', inner(), '</mark>');
    case 'A': {
      const href = node.getAttribute('href') ?? '';
      const title = node.getAttribute('title');
      const label = splitTerminalInlineSuffix(inner());
      return `[${label.body}](${href}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})${label.suffix}`;
    }
    case 'FONT': {
      const color = node.getAttribute('color');
      const size = node.getAttribute('size');
      const attrs = [
        color ? `color="${escapeAttribute(color)}"` : '',
        size ? `size="${escapeAttribute(size)}"` : '',
      ].filter(Boolean).join(' ');
      return attrs ? wrapInline(`<font ${attrs}>`, inner(), '</font>') : inner();
    }
    case 'IMG': {
      const alt = node.getAttribute('alt') ?? '';
      const src = node.getAttribute('src') ?? '';
      const title = node.getAttribute('title');
      const style = node.getAttribute('style')?.trim();
      if (node.hasAttribute('width') || node.hasAttribute('height')) return openingTag(node);
      if (style) {
        const attrs = [
          `src="${escapeAttribute(src)}"`,
          `alt="${escapeAttribute(node.getAttribute('alt') ?? '')}"`,
          title ? `title="${escapeAttribute(title)}"` : '',
          `style="${escapeAttribute(style)}"`,
        ].filter(Boolean);
        return `<img ${attrs.join(' ')}>`;
      }
      return toMarkdownImage({ alt, url: src, title });
    }
    case 'SPAN': {
      const style = node.getAttribute('style')?.trim();
      if (!style) return inner();
      const color = node.style.color;
      const remaining = style
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part && !/^color\s*:/i.test(part));
      if (color && remaining.length === 0) return wrapInline(
        `<font color="${escapeAttribute(color)}">`,
        inner(),
        '</font>',
      );
      return wrapInline(`<span style="${escapeAttribute(style)}">`, inner(), '</span>');
    }
    case 'P':
      return `${inner()}\n`;
    case 'DIV': {
      // A div with attributes is a deliberate wrapper (the 文字框 feature and
      // manual boxes); dropping it silently removes the visible frame.
      const opening = openingTag(node);
      return opening === '<div>' ? `${inner()}\n` : `${opening}${inner()}</div>`;
    }
    default:
      // Renderer-only wrappers and unsupported inline elements contribute
      // their children, never their Wiki.js classes/data attributes.
      return inner();
  }
}

function endsWithLineBreak(node: Node): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node.tagName === 'BR') return true;
  const children = Array.from(node.childNodes);
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index];
    if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() === '') continue;
    return endsWithLineBreak(child);
  }
  return false;
}

function hasTerminalLineBreak(nodes: readonly Node[]): boolean {
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() === '') continue;
    return endsWithLineBreak(node);
  }
  return false;
}

function cleanInline(value: string, preserveTerminalLineBreak = false): string {
  const normalized = value
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  const terminalLineBreak = preserveTerminalLineBreak && normalized.endsWith('\n');
  const trimmed = normalized.trim();
  return terminalLineBreak ? `${trimmed}\n` : trimmed;
}

function serializeInlineChildren(nodes: Iterable<Node>): string {
  const list = Array.from(nodes);
  return cleanInline(serializeNodes(list), hasTerminalLineBreak(list));
}

/* Wiki.js (markdown-it-attrs) consumes a trailing `{.is-warning}`-style line
 * into the rendered element's class list, so that line no longer exists as
 * text in the DOM. Re-attach it from the original source when writing the
 * edited block back, or editing the body would silently delete the styling. */
const RE_ATTRS_LINE = /^ {0,3}\{[^{}\n]*\}[ \t]*$/;

function splitTrailingAttrLines(raw: string): { content: string[]; attrs: string[] } {
  const content = raw.split(/\r?\n/);
  const attrs: string[] = [];
  while (content.length > 1 && RE_ATTRS_LINE.test(content.at(-1)!)) attrs.unshift(content.pop()!);
  return { content, attrs };
}

/** Return attrs that Wiki.js may have consumed into a rendered class. */
export function trailingAttributeLines(raw: string): string[] {
  return splitTrailingAttrLines(raw).attrs;
}

/** Read the semantic class that is visible on a freshly rendered Wiki.js block. */
export function semanticTypeFromRenderedElement(element: HTMLElement): string | undefined {
  const owned = element.getAttribute('data-fwa-semantic-type');
  if (owned && /^[A-Za-z][\w-]*$/.test(owned)) return owned;
  for (const className of Array.from(element.classList)) {
    const match = /^is-([A-Za-z][\w-]*)$/i.exec(className);
    if (match && match[1].toLowerCase() !== 'line') return match[1];
  }
  return undefined;
}

function withTrailingAttrLines(markdown: string, attrs: readonly string[]): string {
  return attrs.length === 0 ? markdown : [markdown, ...attrs].join('\n');
}

/* \u2500\u2500 verbatim-HTML write-back (compact \u6587\u5b57\u6846 bodies) \u2500\u2500
 * markdown-it emits a blank-line-free `<div>\u2026</div>` block verbatim, so its
 * body is HTML, not Markdown. Editing it must round-trip as HTML: Markdown
 * escaping (\*, \[) would show up literally on the page. */

const VOID_HTML_TAGS = new Set(['BR', 'HR', 'IMG']);

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Rebuild an element's opening tag from the live DOM, dropping only the
 * attributes this extension (or the renderer's line tracking) added. */
function openingTag(element: HTMLElement): string {
  const parts = [element.tagName.toLowerCase()];
  for (const attr of Array.from(element.attributes)) {
    if (attr.name.startsWith('data-fwa-') || attr.name === 'data-line') continue;
    if (attr.name === 'contenteditable' || attr.name === 'spellcheck') continue;
    parts.push(attr.value === '' ? attr.name : `${attr.name}="${escapeAttribute(attr.value)}"`);
  }
  return `<${parts.join(' ')}>`;
}

function serializeHtmlNodes(nodes: Iterable<Node>): string {
  return Array.from(nodes, (node) => serializeHtmlNode(node)).join('');
}

function serializeHtmlNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtmlText(node.textContent ?? '');
  if (!(node instanceof HTMLElement)) return '';
  // In-flight upload placeholders must never be written into the source.
  if (node.getAttribute(EXACT_SOURCE_ATTR) === '') return '';
  if (VOID_HTML_TAGS.has(node.tagName)) return openingTag(node);
  return `${openingTag(node)}${serializeHtmlNodes(node.childNodes)}</${node.tagName.toLowerCase()}>`;
}

/** A blank line inside a verbatim html_block would end it and hand the rest
 * of the body to the Markdown parser, so collapse any that editing created. */
function cleanCompactBody(html: string): string {
  return html
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Rendered-from-Markdown div bodies hold block elements; verbatim HTML
 * bodies hold bare text and inline elements. */
function divChildrenAreBlocks(element: HTMLElement): boolean {
  return Array.from(element.children).some(
    (child) =>
      /^H[1-6]$/.test(child.tagName) ||
      ['P', 'DIV', 'UL', 'OL', 'TABLE', 'BLOCKQUOTE', 'PRE', 'HR', 'FIGURE'].includes(child.tagName),
  );
}

function withVisualBlockStyle(element: HTMLElement, markdown: string): string {
  if (!element.hasAttribute(VISUAL_BLOCK_STYLE_ATTR)) return markdown;
  const style = element.getAttribute('style')?.trim();
  if (!style) return markdown;
  return `<div style="${escapeAttribute(style)}">\n\n${markdown}\n\n</div>`;
}

function serializeList(list: HTMLElement, raw: string, depth = 0): string {
  const ordered = list.tagName === 'OL';
  const rawMarker = /^\s*(?:([-+*])|(\d+)([.)]))\s+/m.exec(raw);
  const bullet = rawMarker?.[1] ?? '-';
  const delimiter = rawMarker?.[3] ?? '.';
  const start = Number(list.getAttribute('start') ?? rawMarker?.[2] ?? '1');
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  const items = Array.from(list.children).filter((child): child is HTMLLIElement => child.tagName === 'LI');

  items.forEach((item, index) => {
    const nested = Array.from(item.children).filter((child): child is HTMLElement => child.tagName === 'UL' || child.tagName === 'OL');
    const nestedSet = new Set(nested);
    const contentNodes = Array.from(item.childNodes).filter((node) => !(node instanceof HTMLElement && nestedSet.has(node)));
    const content = serializeInlineChildren(contentNodes).replace(/\n/g, `\n${indent}  `);
    const marker = ordered ? `${start + index}${delimiter}` : bullet;
    lines.push(`${indent}${marker} ${content}`.trimEnd());
    for (const childList of nested) lines.push(serializeList(childList, raw, depth + 1));
  });
  return lines.join('\n');
}

function serializeTable(table: HTMLElement, raw: string): string | null {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length === 0) return null;
  const values = rows.map((row) =>
    Array.from(row.children)
      .filter((cell) => cell.tagName === 'TH' || cell.tagName === 'TD')
      .map((cell) => serializeInlineChildren(cell.childNodes).replace(/\|/g, '\\|').replace(/\n/g, '<br>')),
  );
  const columns = values[0].length;
  if (columns === 0 || values.some((row) => row.length !== columns)) return null;

  const originalLines = raw.split(/\r?\n/);
  const originalDivider = originalLines.find((line) => /^\s*\|?\s*:?-{3,}/.test(line));
  const dividerCells = originalDivider?.split('|').map((cell) => cell.trim()).filter(Boolean);
  const divider = dividerCells?.length === columns ? dividerCells : Array.from({ length: columns }, () => '---');
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(values[0]), line(divider), ...values.slice(1).map(line)].join('\n');
}

function serializeFence(element: HTMLElement, raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  const opening = lines[0] || '```';
  const marker = /^ {0,3}(`{3,}|~{3,})/.exec(opening)?.[1];
  if (!marker) return null;
  const closing = lines.length > 1 ? lines.at(-1) : marker;
  if (!closing || !(marker[0] === '`' ? /^ {0,3}`{3,}\s*$/.test(closing) : /^ {0,3}~{3,}\s*$/.test(closing))) return null;
  let code = element.querySelector('code')?.textContent ?? element.innerText;
  const originalBody = lines.slice(1, -1).join('\n');
  if (!originalBody.endsWith('\n') && code.endsWith('\n')) code = code.slice(0, -1);
  return `${opening}\n${code}\n${closing}`;
}

const RE_BOX_OPEN = /^ {0,3}<div\b[^>]*>[ \t]*$/i;
const RE_BOX_CLOSE = /^ {0,3}<\/div\s*>[ \t]*$/i;

/**
 * A 文字框 html block: one wrapper `<div …>` line and its matching `</div>`
 * line. Both source forms round-trip — the blank-line form's body is
 * re-serialized as Markdown blocks, the compact (blank-line-free) form's
 * body as verbatim HTML — and nested divs are rebuilt from their live DOM
 * attributes, so the whole family is safe to edit visually.
 */
export function isEditableHtmlBox(block: HybridMarkdownBlock): boolean {
  if (block.type !== 'html') return false;
  const { content: lines } = splitTrailingAttrLines(block.rawMarkdown);
  if (lines.length < 2) return false;
  return RE_BOX_OPEN.test(lines[0]) && RE_BOX_CLOSE.test(lines.at(-1) ?? '');
}

/** Serialize an element whose children are block-level (a box div's body). */
function serializeBlockChildren(element: HTMLElement): string | null {
  const chunks: string[] = [];
  let inlineRun = '';
  const flushInline = () => {
    const text = cleanInline(inlineRun);
    inlineRun = '';
    if (text !== '') chunks.push(text);
  };
  for (const node of Array.from(element.childNodes)) {
    if (
      node instanceof HTMLElement &&
      (/^H[1-6]$/.test(node.tagName) ||
        ['P', 'DIV', 'UL', 'OL', 'TABLE', 'BLOCKQUOTE', 'PRE', 'HR', 'FIGURE'].includes(node.tagName))
    ) {
      flushInline();
      const chunk = serializeNewVisualBlock(node);
      if (chunk === null) return null;
      if (chunk.trim() !== '') chunks.push(chunk);
    } else {
      inlineRun += serializeNode(node);
    }
  }
  flushInline();
  return chunks.join('\n\n');
}

export function canVisuallyEdit(block: HybridMarkdownBlock): boolean {
  return (
    ['heading', 'paragraph', 'list', 'table', 'blockquote', 'code-fence', 'link', 'mixed'].includes(block.type) ||
    isEditableHtmlBox(block)
  );
}

/** Blocks whose rendered DOM can be written back without exposing them to text editing. */
export function canSerializeVisualBlock(block: HybridMarkdownBlock): boolean {
  return canVisuallyEdit(block) || block.type === 'image';
}

/** Serialize only the currently edited, supported block back to Markdown. */
export function serializeVisualBlock(block: HybridMarkdownBlock, element: HTMLElement): string | null {
  let markdown: string | null;
  switch (block.type) {
    case 'heading': {
      const prefix = /^ {0,3}#{1,6}[ \t]+/.exec(block.rawMarkdown)?.[0];
      markdown = prefix
        ? withTrailingAttrLines(
            `${prefix}${cleanInline(serializeNodes(element.childNodes))}`,
            splitTrailingAttrLines(block.rawMarkdown).attrs,
          )
        : null;
      break;
    }
    case 'paragraph':
    case 'link':
    case 'mixed': {
      // A one-line styled <div> box renders as the block element itself;
      // serializing only its children would strip the visible frame.
      const body = element.tagName === 'DIV' && element.getAttribute('style')?.trim()
        ? cleanInline(serializeNode(element))
        : serializeInlineChildren(element.childNodes);
      markdown = withTrailingAttrLines(body, splitTrailingAttrLines(block.rawMarkdown).attrs);
      break;
    }
    case 'image': {
      const { attrs } = splitTrailingAttrLines(block.rawMarkdown);
      markdown = withTrailingAttrLines(cleanInline(
        element.tagName === 'IMG' ? serializeNode(element) : serializeNodes(element.childNodes),
      ), attrs);
      break;
    }
    case 'list':
      markdown = withTrailingAttrLines(
        serializeList(element, block.rawMarkdown),
        splitTrailingAttrLines(block.rawMarkdown).attrs,
      );
      break;
    case 'blockquote': {
      const { content, attrs } = splitTrailingAttrLines(block.rawMarkdown);
      const body = serializeInlineChildren(element.childNodes);
      const lines = body.split('\n');
      // Wiki.js warning/info quotes are usually written lazily (`>` on the
      // first line only). Keep that style so an edit inside one line never
      // rewrites the untouched lines with `>` markers.
      const lazy =
        content.length > 1 &&
        content.slice(1).every((line) => !/^ {0,3}>/.test(line)) &&
        lines.every((line) => line.trim() !== '');
      markdown = lazy
        ? [`> ${lines[0]}`.trimEnd(), ...lines.slice(1)].join('\n')
        : lines.map((line) => `> ${line}`.trimEnd()).join('\n');
      markdown = withTrailingAttrLines(markdown, attrs);
      break;
    }
    case 'table': {
      const { content, attrs } = splitTrailingAttrLines(block.rawMarkdown);
      const table = serializeTable(element, content.join('\n'));
      markdown = table === null ? null : withTrailingAttrLines(table, attrs);
      break;
    }
    case 'code-fence': {
      const { content, attrs } = splitTrailingAttrLines(block.rawMarkdown);
      const fence = serializeFence(element, content.join('\n'));
      markdown = fence === null ? null : withTrailingAttrLines(fence, attrs);
      break;
    }
    case 'html': {
      if (!isEditableHtmlBox(block)) {
        markdown = null;
        break;
      }
      const { content: lines, attrs } = splitTrailingAttrLines(block.rawMarkdown);
      const opening = lines[0];
      const closing = lines.at(-1) ?? '</div>';
      if (lines.every((line) => line.trim() !== '')) {
        // Compact form: markdown-it emitted the block verbatim, so the body
        // is HTML and must stay blank-line-free to keep rendering that way.
        const body = cleanCompactBody(serializeHtmlNodes(element.childNodes));
        const box = body === '' ? `${opening}\n${closing}` : `${opening}\n${body}\n${closing}`;
        markdown = withTrailingAttrLines(box, attrs);
      } else {
        const body = serializeBlockChildren(element);
        markdown = body === null ? null : withTrailingAttrLines(
          `${opening}\n\n${body}\n\n${closing}`,
          attrs,
        );
      }
      break;
    }
    default:
      markdown = null;
  }
  return markdown === null ? null : withVisualBlockStyle(element, markdown);
}

/** Serialize a top-level element created by contenteditable (for example when Enter adds a new paragraph). */
export function serializeNewVisualBlock(element: HTMLElement): string | null {
  if (/^H[1-6]$/.test(element.tagName)) {
    const level = Number(element.tagName[1]);
    return `${'#'.repeat(level)} ${cleanInline(serializeNodes(element.childNodes))}`;
  }
  switch (element.tagName) {
    case 'P':
      return serializeInlineChildren(element.childNodes);
    case 'IMG':
      return serializeNode(element);
    case 'DIV': {
      // A bare div is contenteditable line noise; one with attributes is a
      // deliberate box whose visible frame must survive the round-trip.
      const opening = openingTag(element);
      if (opening === '<div>') return serializeInlineChildren(element.childNodes);
      if (divChildrenAreBlocks(element)) {
        const body = serializeBlockChildren(element);
        return body === null ? null : `${opening}\n\n${body}\n\n</div>`;
      }
      const body = cleanCompactBody(serializeHtmlNodes(element.childNodes));
      return body === '' ? `${opening}\n</div>` : `${opening}\n${body}\n</div>`;
    }
    case 'UL':
    case 'OL':
      return serializeList(element, '');
    case 'BLOCKQUOTE': {
      const body = serializeInlineChildren(element.childNodes);
      return body.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n');
    }
    case 'TABLE':
      return serializeTable(element, '');
    case 'PRE':
      return serializeFence(element, '');
    case 'HR':
      return '---';
    case 'FIGURE':
      return cleanInline(serializeNodes(element.childNodes));
    default:
      return null;
  }
}

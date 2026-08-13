import type { HybridMarkdownBlock } from './hybrid-blocks';

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
    .replace(/>/g, '&gt;');
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
      return `**${inner()}**`;
    case 'EM':
    case 'I':
      return `*${inner()}*`;
    case 'CODE':
      return codeSpan(node.textContent ?? '');
    case 'DEL':
    case 'S':
      return `~~${inner()}~~`;
    case 'U':
      return `<u>${inner()}</u>`;
    case 'MARK':
      return `<mark>${inner()}</mark>`;
    case 'A': {
      const href = node.getAttribute('href') ?? '';
      const title = node.getAttribute('title');
      return `[${inner()}](${href}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
    }
    case 'FONT': {
      const color = node.getAttribute('color');
      const size = node.getAttribute('size');
      const attrs = [
        color ? `color="${escapeAttribute(color)}"` : '',
        size ? `size="${escapeAttribute(size)}"` : '',
      ].filter(Boolean).join(' ');
      return attrs ? `<font ${attrs}>${inner()}</font>` : inner();
    }
    case 'IMG': {
      const alt = (node.getAttribute('alt') ?? '').replace(/([\]\\])/g, '\\$1');
      const src = node.getAttribute('src') ?? '';
      const title = node.getAttribute('title');
      const style = node.getAttribute('style')?.trim();
      if (style) {
        const attrs = [
          `src="${escapeAttribute(src)}"`,
          `alt="${escapeAttribute(node.getAttribute('alt') ?? '')}"`,
          title ? `title="${escapeAttribute(title)}"` : '',
          `style="${escapeAttribute(style)}"`,
        ].filter(Boolean);
        return `<img ${attrs.join(' ')}>`;
      }
      return `![${alt}](${src}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
    }
    case 'SPAN': {
      const style = node.getAttribute('style')?.trim();
      if (!style) return inner();
      const color = node.style.color;
      const remaining = style
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part && !/^color\s*:/i.test(part));
      if (color && remaining.length === 0) return `<font color="${escapeAttribute(color)}">${inner()}</font>`;
      return `<span style="${escapeAttribute(style)}">${inner()}</span>`;
    }
    case 'P':
    case 'DIV':
      return `${inner()}\n`;
    default:
      // Renderer-only wrappers and unsupported inline elements contribute
      // their children, never their Wiki.js classes/data attributes.
      return inner();
  }
}

function cleanInline(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
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
    const content = cleanInline(serializeNodes(contentNodes)).replace(/\n/g, `\n${indent}  `);
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
      .map((cell) => cleanInline(serializeNodes(cell.childNodes)).replace(/\|/g, '\\|').replace(/\n/g, '<br>')),
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

export function canVisuallyEdit(block: HybridMarkdownBlock): boolean {
  return ['heading', 'paragraph', 'list', 'table', 'blockquote', 'code-fence', 'link', 'mixed'].includes(block.type);
}

/** Serialize only the currently edited, supported block back to Markdown. */
export function serializeVisualBlock(block: HybridMarkdownBlock, element: HTMLElement): string | null {
  let markdown: string | null;
  switch (block.type) {
    case 'heading': {
      const prefix = /^ {0,3}#{1,6}[ \t]+/.exec(block.rawMarkdown)?.[0];
      markdown = prefix ? `${prefix}${cleanInline(serializeNodes(element.childNodes))}` : null;
      break;
    }
    case 'paragraph':
    case 'link':
    case 'mixed':
      markdown = cleanInline(serializeNodes(element.childNodes));
      break;
    case 'list':
      markdown = serializeList(element, block.rawMarkdown);
      break;
    case 'blockquote': {
      const body = cleanInline(serializeNodes(element.childNodes));
      markdown = body.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n');
      break;
    }
    case 'table':
      markdown = serializeTable(element, block.rawMarkdown);
      break;
    case 'code-fence':
      markdown = serializeFence(element, block.rawMarkdown);
      break;
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
    case 'DIV':
      return cleanInline(serializeNodes(element.childNodes));
    case 'UL':
    case 'OL':
      return serializeList(element, '');
    case 'BLOCKQUOTE': {
      const body = cleanInline(serializeNodes(element.childNodes));
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

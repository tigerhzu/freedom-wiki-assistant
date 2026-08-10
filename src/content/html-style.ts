/**
 * Inline-style plumbing shared by the block formatter (block-format.ts) and the
 * image tools (markdown-image.ts).
 *
 * No DOM access — pure string/array work so everything stays unit testable and
 * safe to run against the editor's raw Markdown text.
 */

export interface StyleDecl {
  /** Lower-cased CSS property name. */
  prop: string;
  value: string;
}

/* ───────────────────────── attribute escaping ───────────────────────── */

/**
 * Escape a value so it can be placed inside a double-quoted HTML attribute.
 * Wiki paths may legitimately contain `&` (query-ish names) or angle brackets;
 * without this a single odd filename would break the generated tag.
 */
export function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Inverse of escapeHtmlAttr (used when converting HTML back to Markdown). */
export function unescapeHtmlAttr(value: string): string {
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/* ─────────────────────────── style declarations ─────────────────────────── */

export function parseStyleDecls(style: string): StyleDecl[] {
  return style
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf(':');
      if (i < 0) return { prop: part.toLowerCase(), value: '' };
      return { prop: part.slice(0, i).trim().toLowerCase(), value: part.slice(i + 1).trim() };
    })
    .filter((d) => d.prop && d.value);
}

export function serializeStyleDecls(decls: StyleDecl[]): string {
  return decls
    .filter((d) => d.prop && d.value)
    .map((d) => `${d.prop}: ${d.value};`)
    .join(' ');
}

/**
 * Apply `updates` onto `base`, in place where the property already exists
 * (so re-applying a format never produces a second declaration for it).
 * An empty update value REMOVES the property.
 */
export function mergeStyleDecls(base: StyleDecl[], updates: StyleDecl[]): StyleDecl[] {
  const out = base.map((d) => ({ ...d }));
  for (const update of updates) {
    const prop = update.prop.toLowerCase();
    const i = out.findIndex((d) => d.prop === prop);
    if (!update.value) {
      if (i >= 0) out.splice(i, 1);
      continue;
    }
    if (i >= 0) out[i].value = update.value;
    else out.push({ prop, value: update.value });
  }
  return out;
}

export function styleValue(decls: StyleDecl[], prop: string): string {
  return decls.find((d) => d.prop === prop.toLowerCase())?.value ?? '';
}

/** Read a `style="..."` attribute out of a raw tag attribute string. */
export function extractStyleAttr(attrs: string): string {
  return attrs.match(/\bstyle\s*=\s*"([^"]*)"/i)?.[1] ?? attrs.match(/\bstyle\s*=\s*'([^']*)'/i)?.[1] ?? '';
}

/** The same attribute string with `style="..."` removed (other attrs preserved). */
export function stripStyleAttr(attrs: string): string {
  return attrs.replace(/\s*\bstyle\s*=\s*("[^"]*"|'[^']*')/i, '').trim();
}

/* ────────────────────────────── text boxes ────────────────────────────── */

const BORDER_STYLE_KEYWORDS = [
  'none',
  'hidden',
  'solid',
  'dashed',
  'dotted',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
];

/**
 * Structured view of a text box, so tweaking one aspect (「框線顏色」) can
 * rebuild the `border` shorthand without losing the others.
 */
export interface BoxSpec {
  /** 'all' → `border`, 'left' → `border-left` (accent/notice boxes). */
  side: 'all' | 'left';
  width: string;
  style: string;
  color: string;
  /** '' = no rounded corners. */
  radius: string;
  padding: string;
  margin: string;
  /** '' = transparent. */
  background: string;
}

/** Every property a text box owns. Re-applied as a set so presets never mix. */
export const BOX_PROPS = [
  'border',
  'border-left',
  'border-radius',
  'background-color',
  'padding',
  'margin',
];

export const DEFAULT_BOX: BoxSpec = {
  side: 'all',
  width: '1px',
  style: 'solid',
  color: '#cccccc',
  radius: '6px',
  padding: '10px',
  margin: '8px 0',
  background: '',
};

export function parseBorderShorthand(value: string): { width: string; style: string; color: string } {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  let width = '';
  let style = '';
  const rest: string[] = [];
  for (const token of tokens) {
    if (!style && BORDER_STYLE_KEYWORDS.includes(token.toLowerCase())) style = token.toLowerCase();
    else if (!width && /^(?:[\d.]+(?:px|em|rem|pt|%)|thin|medium|thick)$/i.test(token)) width = token;
    else rest.push(token);
  }
  return {
    width: width || DEFAULT_BOX.width,
    style: style || DEFAULT_BOX.style,
    color: rest.join(' ') || DEFAULT_BOX.color,
  };
}

/** Read the box currently described by `decls`, or null when there is no box. */
export function readBoxSpec(decls: StyleDecl[]): BoxSpec | null {
  const all = styleValue(decls, 'border');
  const left = styleValue(decls, 'border-left');
  if (!all && !left) return null;
  const shorthand = parseBorderShorthand(all || left);
  return {
    side: all ? 'all' : 'left',
    width: shorthand.width,
    style: shorthand.style,
    color: shorthand.color,
    radius: styleValue(decls, 'border-radius'),
    padding: styleValue(decls, 'padding') || DEFAULT_BOX.padding,
    margin: styleValue(decls, 'margin') || DEFAULT_BOX.margin,
    background: styleValue(decls, 'background-color'),
  };
}

/**
 * Declarations for a box, in the canonical order used by the docs/examples:
 *   border / border-left → border-radius → background-color → padding → margin.
 * The unused border property is emitted as an empty removal so switching
 * between a full-border box and an accent box never leaves both behind.
 */
export function boxSpecToDecls(spec: BoxSpec): StyleDecl[] {
  const border = `${spec.width} ${spec.style} ${spec.color}`.trim();
  return [
    { prop: 'border', value: spec.side === 'all' ? border : '' },
    { prop: 'border-left', value: spec.side === 'left' ? border : '' },
    { prop: 'border-radius', value: spec.radius },
    { prop: 'background-color', value: spec.background },
    { prop: 'padding', value: spec.padding },
    { prop: 'margin', value: spec.margin },
  ];
}

export interface BoxPreset {
  label: string;
  spec: BoxSpec;
}

/** 「快速框線樣式」— the presets shown as one-click buttons. */
export const BOX_PRESETS: BoxPreset[] = [
  { label: '一般資訊框', spec: { ...DEFAULT_BOX } },
  {
    label: '藍色資訊框',
    spec: {
      side: 'left',
      width: '4px',
      style: 'solid',
      color: '#0d6efd',
      radius: '',
      padding: '10px 12px',
      margin: '8px 0',
      background: '#f0f7ff',
    },
  },
  {
    label: '黃色注意框',
    spec: {
      side: 'left',
      width: '4px',
      style: 'solid',
      color: '#ffc107',
      radius: '',
      padding: '10px 12px',
      margin: '8px 0',
      background: '#fffbf0',
    },
  },
  {
    label: '紅色警告框',
    spec: {
      side: 'left',
      width: '4px',
      style: 'solid',
      color: '#dc3545',
      radius: '',
      padding: '10px 12px',
      margin: '8px 0',
      background: '#fff5f5',
    },
  },
  {
    label: '綠色完成框',
    spec: {
      side: 'left',
      width: '4px',
      style: 'solid',
      color: '#198754',
      radius: '',
      padding: '10px 12px',
      margin: '8px 0',
      background: '#f2fbf5',
    },
  },
  {
    label: '灰色補充框',
    spec: {
      side: 'left',
      width: '4px',
      style: 'solid',
      color: '#6c757d',
      radius: '',
      padding: '10px 12px',
      margin: '8px 0',
      background: '#f6f8fa',
    },
  },
];

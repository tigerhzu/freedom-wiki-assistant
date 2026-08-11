/**
 * Heuristic safety net for the "AI 排版" feature: after the model returns its
 * rewrite, check that everything it must never touch — image paths,
 * hyperlinks, IPs, inline code/commands, fenced code blocks — still appears
 * verbatim in the output. This never blocks the result (the user always sees
 * a full diff and must confirm manually), it only adds a warning so a
 * silently-dropped path/IP/command doesn't slip past a quick read.
 *
 * This is a best-effort text match, not a semantic check: legitimate
 * re-wrapping of a fenced code block (e.g. re-indented) can still trigger a
 * false-positive warning. That's an acceptable trade-off given warnings are
 * advisory, not blocking.
 */

const PRESERVE_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/g, // fenced code blocks (commands / multi-line technical content)
  /`[^`\n]+`/g, // inline code spans
  /!\[[^\]]*\]\(([^)\s]+)\)/g, // markdown images -> capture URL/path
  /\[[^\]]*\]\(([^)\s]+)\)/g, // markdown links -> capture URL/path
  /https?:\/\/[^\s)>\]]+/g, // raw URLs
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, // IPv4 addresses
];

/**
 * Passwords are intentionally checked separately from the general preserved
 * tokens: if a model masks one, the result must not be offered for apply at
 * all. The value alone is captured so normal Markdown emphasis around it does
 * not produce a false positive.
 */
const PASSWORD_VALUE = /(?:^|[\s,，;；])(?:密碼|password|passwd|pwd)\s*(?:[:：=]|為|是)?\s*(?:\*{1,3}|`)?([^\s*`<>,，。;；]+)(?:\*{1,3}|`)?/gim;

function extractTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const pattern of PRESERVE_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const value = match[1] ?? match[0];
      if (value && value.trim().length > 2) tokens.add(value);
    }
  }
  return tokens;
}

function extractPasswordValues(text: string): Set<string> {
  const values = new Set<string>();
  const re = new RegExp(PASSWORD_VALUE.source, PASSWORD_VALUE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const value = match[1];
    if (value && value.length > 0) values.add(value);
  }
  return values;
}

/**
 * Second safety net, for the colour-annotation rules in shared/layout-rules.ts:
 * the model now *adds* markup (`<font color>`, `<mark>`, `<u>`), and a dropped
 * closing tag would bleed colour across the rest of the page once Wiki.js
 * renders it. Counted outside code spans so a fenced example containing a
 * literal `<font>` doesn't trigger a false positive.
 */
const CODE_SPANS = /```[\s\S]*?```|`[^`\n]+`/g;
const BALANCED_TAGS = ['font', 'mark', 'u'] as const;

/** Returns one description per formatting tag whose open/close counts don't match. */
export function findUnbalancedFormattingTags(text: string): string[] {
  const stripped = text.replace(CODE_SPANS, '');
  const issues: string[] = [];
  for (const tag of BALANCED_TAGS) {
    const open = stripped.match(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))?.length ?? 0;
    const close = stripped.match(new RegExp(`</${tag}\\s*>`, 'gi'))?.length ?? 0;
    if (open !== close) issues.push(`<${tag}> ${open} 個 / </${tag}> ${close} 個`);
  }
  return issues;
}

/**
 * `<span style="color:…">` renders fine but the extension's own 「清除格式」
 * only strips `<font …>` and `<span style="font-size:…">` (see
 * content/markdown-format.ts), so colour written this way can't be undone from
 * the right-click menu. layout-rules.ts forbids it; this flags it if the model
 * ignores that rule — but only for colour the model introduced, not colour the
 * page already had.
 */
const SPAN_COLOR = /<span\s+style="[^"]*\bcolor\s*:/gi;

export function findForbiddenColorSyntax(original: string, formatted: string): number {
  const before = original.match(SPAN_COLOR)?.length ?? 0;
  const after = formatted.match(SPAN_COLOR)?.length ?? 0;
  return Math.max(0, after - before);
}

/**
 * Returns password values present in the source but absent from the result.
 * Callers must not expose these values in a warning or log; they are only a
 * signal to reject a result that would lose source data.
 */
export function findMissingPasswordValues(original: string, formatted: string): string[] {
  return [...extractPasswordValues(original)].filter((value) => !formatted.includes(value));
}

/** Returns the (capped) list of original tokens that no longer appear in the formatted output. */
export function findMissingPreservedTokens(original: string, formatted: string): string[] {
  const originalTokens = extractTokens(original);
  const missing: string[] = [];
  for (const token of originalTokens) {
    if (!formatted.includes(token)) missing.push(token);
    if (missing.length >= 20) break;
  }
  return missing;
}

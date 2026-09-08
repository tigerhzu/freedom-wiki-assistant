/**
 * Contract for the "AI 排版" feature. Shared between the content script
 * (which only ever sees this shape) and the background service worker
 * (which is the only place allowed to use the selected provider API key).
 */

/**
 * Token usage of one Azure OpenAI call.
 *
 * `cachedTokens` is the prompt-cache hit reported at
 * `usage.prompt_tokens_details.cached_tokens`. Azure enables prompt caching
 * automatically for GPT-4o and newer models (no request parameter, no opt-out)
 * as long as the first 1024 tokens of the prompt are byte-identical between
 * requests — which is why the layout rules live in a fixed system prompt and
 * the article content always goes last. `cacheReported` is false when the
 * deployment's model / API version didn't return the field at all, so the
 * console log can say "not reported" instead of implying zero cache hits.
 */
export interface AiLayoutUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReported: boolean;
  /** Provider-reported hidden reasoning tokens, when available. */
  reasoningTokens?: number;
  /** End-to-end provider request duration measured by the client. */
  durationMs?: number;
  /** completionTokens / duration, useful for comparing warm Ornith runs. */
  outputTokensPerSecond?: number;
}

export interface AiLayoutResult {
  formatted_content: string;
  changes: string[];
  warnings: string[];
  /** Token usage reported by the configured AI provider when available. */
  usage?: AiLayoutUsage;
}

export type AiLayoutErrorCode =
  | 'config-missing'
  | 'timeout'
  | 'token-limit'
  | 'invalid-json'
  | 'empty-response'
  | 'content-preservation-failed'
  | 'http-error'
  | 'unknown';

export type AiLayoutResponse =
  | { ok: true; result: AiLayoutResult }
  | { ok: false; error: string; code: AiLayoutErrorCode };

import type { AiLayoutErrorCode, AiLayoutUsage } from './ai-layout-types';
import type { CallOptions, ChatCompletionResult, ChatMessage } from './azure-openai-client';

/** Minimal OpenAI-compatible client for the company-hosted Ornith endpoint. */
export class OrnithApiError extends Error {
  constructor(
    message: string,
    readonly code: AiLayoutErrorCode,
  ) {
    super(message);
    this.name = 'OrnithApiError';
  }
}

export interface OrnithCredentials {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface OrnithRawSettings {
  ornithBaseUrl: string;
  ornithModel: string;
  ornithApiKey: string;
}

export function normalizeOrnithBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new OrnithApiError('Ornith Base URL 格式不正確，請填入有效的 HTTPS /v1 網址。', 'config-missing');
  }
  if (
    url.protocol !== 'https:' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !url.pathname.replace(/\/$/, '').endsWith('/v1')
  ) {
    throw new OrnithApiError('Ornith Base URL 必須是 HTTPS 且以 /v1 結尾，不可包含帳密、查詢或片段。', 'config-missing');
  }
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

export function validateOrnithCredentials(settings: OrnithRawSettings): OrnithCredentials {
  if (!settings.ornithApiKey.trim()) {
    throw new OrnithApiError('尚未設定 Ornith API Key，請至擴充套件設定頁填入。', 'config-missing');
  }
  const baseUrl = normalizeOrnithBaseUrl(settings.ornithBaseUrl);
  const model = settings.ornithModel.trim();
  if (!model) {
    throw new OrnithApiError('尚未設定 Ornith Model，請至擴充套件設定頁填入。', 'config-missing');
  }
  return { baseUrl, model, apiKey: settings.ornithApiKey };
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readUsage(data: unknown, durationMs: number): AiLayoutUsage | null {
  const usage =
    data && typeof data === 'object' && 'usage' in data
      ? ((data as { usage?: unknown }).usage as Record<string, unknown> | undefined)
      : undefined;
  if (!usage || typeof usage !== 'object') return null;
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const completionDetails = usage.completion_tokens_details as Record<string, unknown> | undefined;
  const cacheReported = !!promptDetails && typeof promptDetails === 'object' && 'cached_tokens' in promptDetails;
  const reasoningReported =
    (!!completionDetails && typeof completionDetails === 'object' && 'reasoning_tokens' in completionDetails) ||
    'reasoning_tokens' in usage;
  const completionTokens = toCount(usage.completion_tokens);
  return {
    promptTokens: toCount(usage.prompt_tokens),
    cachedTokens: cacheReported ? toCount(promptDetails?.cached_tokens) : 0,
    completionTokens,
    totalTokens: toCount(usage.total_tokens),
    cacheReported,
    ...(reasoningReported
      ? { reasoningTokens: toCount(completionDetails?.reasoning_tokens ?? usage.reasoning_tokens) }
      : {}),
    durationMs,
    outputTokensPerSecond: durationMs > 0 ? Number(((completionTokens * 1000) / durationMs).toFixed(1)) : 0,
  };
}

/**
 * Qwen-family thinking models understand /no_think in either the system or
 * user message. This is the prompt-level fallback for gateways that partially
 * apply the hard chat_template_kwargs.enable_thinking=false switch below.
 * Keep both controls Ornith-only so Azure receives the original prompt
 * byte-for-byte.
 */
function disableThinking(messages: ChatMessage[]): ChatMessage[] {
  let applied = false;
  const normalized = messages.map((message) => {
    if (applied || message.role !== 'system') return { ...message };
    applied = true;
    return { ...message, content: `/no_think\n\n${message.content}` };
  });
  if (!applied && normalized.length > 0) {
    normalized[0] = { ...normalized[0], content: `/no_think\n\n${normalized[0].content}` };
  }
  return normalized;
}

function readMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('')
    .trim();
}

export async function callOrnithChatCompletion(
  creds: OrnithCredentials,
  messages: ChatMessage[],
  opts: CallOptions = {},
): Promise<ChatCompletionResult> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(`${creds.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify({
        model: creds.model,
        messages: disableThinking(messages),
        // Layout is a deterministic transformation. Greedy decoding avoids
        // spending work on creative alternatives and produces stabler JSON.
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 4096,
        n: 1,
        stream: false,
        // vLLM/Qwen hard switch. /no_think above remains as a second layer.
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new OrnithApiError(`Ornith API 請求逾時（超過 ${Math.round(timeoutMs / 1000)} 秒）`, 'timeout');
    }
    throw new OrnithApiError(
      `無法連線至 Ornith API：${err instanceof Error ? err.message : String(err)}`,
      'http-error',
    );
  } finally {
    clearTimeout(timer);
  }

  const data: unknown = await resp.json().catch(() => null);
  const errorObj =
    data && typeof data === 'object' && 'error' in data
      ? ((data as { error?: unknown }).error as { code?: string; message?: string } | undefined)
      : undefined;

  if (!resp.ok) {
    const message = errorObj?.message || `Ornith API 回應 HTTP ${resp.status}`;
    if (errorObj?.code === 'context_length_exceeded' || /maximum context length|context length/i.test(message)) {
      throw new OrnithApiError('內容超過模型 Token 上限，請縮短內容後再試一次。', 'token-limit');
    }
    if (
      (resp.status === 400 || resp.status === 422) &&
      /chat_template_kwargs|enable_thinking|extra inputs|unknown field|unexpected/i.test(message)
    ) {
      throw new OrnithApiError(
        'Ornith Gateway 不支援硬性停用推理參數（chat_template_kwargs.enable_thinking=false）。' +
          '請更新 Gateway／vLLM 的 OpenAI-compatible API；為避免再次耗盡推理 Token，本次不會退回推理模式。',
        'http-error',
      );
    }
    throw new OrnithApiError(message, 'http-error');
  }

  const choice =
    data && typeof data === 'object' && 'choices' in data
      ? (data as {
          choices?: Array<{
            finish_reason?: unknown;
            message?: { content?: unknown; reasoning_content?: unknown };
          }>;
        }).choices?.[0]
      : undefined;
  const content = choice?.message?.content;
  const text = readMessageText(content);
  if (!text) {
    const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'unknown';
    const reasoning = choice?.message?.reasoning_content;
    const reasoningLength = typeof reasoning === 'string' ? reasoning.length : 0;
    console.warn('[FWA] Ornith API 沒有最終內容', {
      finishReason,
      reasoningLength,
      contentType: Array.isArray(content) ? 'array' : typeof content,
    });
    if (finishReason === 'length') {
      throw new OrnithApiError(
        'Ornith 的輸出 Token 已用完，尚未產生最終內容。Gateway 可能未套用 /no_think。',
        'empty-response',
      );
    }
    if (reasoningLength > 0) {
      throw new OrnithApiError(
        'Ornith 只回傳推理內容，沒有最終答案。Gateway 可能未套用 /no_think。',
        'empty-response',
      );
    }
    throw new OrnithApiError('Ornith API 回傳空內容，且沒有可用的最終答案。', 'empty-response');
  }
  return { text, usage: readUsage(data, Date.now() - startedAt) };
}

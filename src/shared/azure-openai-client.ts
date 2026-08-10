import type { AiLayoutErrorCode, AiLayoutUsage } from './ai-layout-types';

/**
 * Minimal Azure OpenAI chat-completions client.
 *
 * Deliberately framework-agnostic (fetch + AbortController only, no chrome.*,
 * no wiki-specific imports) so it can be reused without coupling it to a
 * Wiki page or Chrome APIs.
 *
 * Only ever import this from background/service-worker context: it needs
 * host_permissions + a fetch that isn't subject to the wiki page's own CORS
 * policy, and the API key must never reach the content script / page.
 */

export class AzureOpenAiError extends Error {
  constructor(
    message: string,
    readonly code: AiLayoutErrorCode,
  ) {
    super(message);
    this.name = 'AzureOpenAiError';
  }
}

export interface AzureOpenAiCredentials {
  endpoint: string;
  deployment: string;
  apiKey: string;
  apiVersion: string;
}

export interface AzureOpenAiRawSettings {
  azureEndpoint: string;
  azureDeployment: string;
  azureApiKey: string;
  azureApiVersion: string;
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/** Same validation rules as HaloPSA's normalizeAzureEndpoint(). */
export function normalizeAzureEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AzureOpenAiError(
      'Azure Endpoint 格式不正確，請填入 https://<resource>.openai.azure.com',
      'config-missing',
    );
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname.toLowerCase().endsWith('.openai.azure.com') ||
    (url.pathname && url.pathname !== '/') ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new AzureOpenAiError(
      'Azure Endpoint 必須是 https://<resource>.openai.azure.com，不要包含 API 路徑或參數',
      'config-missing',
    );
  }
  return url.origin;
}

/** Validates settings pulled from chrome.storage.local — never hardcoded, never bundled at build time. */
export function validateAzureCredentials(settings: AzureOpenAiRawSettings): AzureOpenAiCredentials {
  if (!settings.azureApiKey.trim()) {
    throw new AzureOpenAiError('尚未設定 Azure OpenAI API Key，請至擴充套件設定頁填入。', 'config-missing');
  }
  const endpoint = normalizeAzureEndpoint(settings.azureEndpoint);
  const deployment = settings.azureDeployment.trim();
  if (!deployment) {
    throw new AzureOpenAiError('尚未設定 Azure Deployment Name，請至擴充套件設定頁填入。', 'config-missing');
  }
  const apiVersion = settings.azureApiVersion.trim();
  if (!apiVersion) {
    throw new AzureOpenAiError('尚未設定 Azure OpenAI API Version，請至擴充套件設定頁填入。', 'config-missing');
  }
  return { endpoint, deployment, apiKey: settings.azureApiKey, apiVersion };
}

export interface CallOptions {
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompletionResult {
  text: string;
  /** null when the response carried no usage object at all. */
  usage: AiLayoutUsage | null;
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Reads token usage, including the prompt-cache hit count.
 *
 * Prompt caching on Azure is automatic for GPT-4o and newer models and cannot
 * be turned off; there is no request parameter to set. `prompt_cache_key` and
 * `prompt_cache_retention` are deliberately NOT sent — they only matter for
 * gpt-5.6+, and posting an unknown field to an older API version risks a 400.
 */
function readUsage(data: unknown): AiLayoutUsage | null {
  const usage =
    data && typeof data === 'object' && 'usage' in data
      ? ((data as { usage?: unknown }).usage as Record<string, unknown> | undefined)
      : undefined;
  if (!usage || typeof usage !== 'object') return null;

  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const cacheReported = !!details && typeof details === 'object' && 'cached_tokens' in details;
  return {
    promptTokens: toCount(usage.prompt_tokens),
    cachedTokens: cacheReported ? toCount(details?.cached_tokens) : 0,
    completionTokens: toCount(usage.completion_tokens),
    totalTokens: toCount(usage.total_tokens),
    cacheReported,
  };
}

export async function callAzureChatCompletion(
  creds: AzureOpenAiCredentials,
  messages: ChatMessage[],
  opts: CallOptions = {},
): Promise<ChatCompletionResult> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const url =
    `${creds.endpoint}/openai/deployments/${encodeURIComponent(creds.deployment)}` +
    `/chat/completions?api-version=${encodeURIComponent(creds.apiVersion)}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': creds.apiKey,
      },
      body: JSON.stringify({
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 4096,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AzureOpenAiError(`Azure OpenAI 請求逾時（超過 ${Math.round(timeoutMs / 1000)} 秒）`, 'timeout');
    }
    throw new AzureOpenAiError(
      `無法連線至 Azure OpenAI：${err instanceof Error ? err.message : String(err)}`,
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
    const message = errorObj?.message || `Azure OpenAI 回應 HTTP ${resp.status}`;
    if (errorObj?.code === 'context_length_exceeded' || /maximum context length/i.test(message)) {
      throw new AzureOpenAiError('內容超過模型 Token 上限，請縮短內容後再試一次。', 'token-limit');
    }
    throw new AzureOpenAiError(message, 'http-error');
  }

  const choice =
    data && typeof data === 'object' && 'choices' in data
      ? (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]
      : undefined;
  const content = choice?.message?.content;
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) {
    throw new AzureOpenAiError('Azure OpenAI 回傳空內容', 'empty-response');
  }
  return { text, usage: readUsage(data) };
}

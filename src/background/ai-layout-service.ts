import {
  AzureOpenAiError,
  callAzureChatCompletion,
  validateAzureCredentials,
  type ChatCompletionResult,
  type ChatMessage,
} from '../shared/azure-openai-client';
import {
  findForbiddenColorSyntax,
  findMissingPasswordValues,
  findMissingPreservedTokens,
  findUnbalancedFormattingTags,
} from '../shared/ai-layout-guard';
import type { AiLayoutErrorCode, AiLayoutResult, AiLayoutUsage } from '../shared/ai-layout-types';
import { buildLayoutRulesPrompt } from '../shared/layout-rules';
import type { Settings } from '../shared/types';

/**
 * Orchestrates one "AI 排版" run: builds the prompt, calls Azure OpenAI
 * (via the shared client — see azure-openai-client.ts for why this isn't
 * literally the same module as HaloPSA's), parses the required JSON
 * contract, and layers a heuristic preserved-content check on top.
 *
 * Deliberately background-only: this is the one place allowed to see the
 * Azure OpenAI API key and to make the network call, per the same CORS +
 * key-exposure reasoning HaloPSA's service-worker.js documents.
 */

export class AiLayoutError extends Error {
  constructor(
    message: string,
    readonly code: AiLayoutErrorCode,
  ) {
    super(message);
    this.name = 'AiLayoutError';
  }
}

/**
 * Per-request length guard.
 *
 * This is a *per-call* limit, not a whole-article limit: the content script
 * splits long articles into chunks (content/markdown-chunk.ts) and sends one
 * message per chunk. The number has to stay in proportion to MAX_TOKENS below,
 * because the JSON contract asks the model to return the whole chunk back —
 * an input that only just fits the context window would still get its reply
 * truncated mid-JSON, which surfaces as an unfixable 'invalid-json' retry loop.
 */
const MAX_CONTENT_CHARS = 6000;
const MAX_TOKENS = 4096;
const REQUEST_TIMEOUT_MS = 60000;

/**
 * The layout rules themselves live in shared/layout-rules.ts — the single
 * source shared with the /wiki-layout-extension Claude Code Skill, so the
 * button and the Skill can't drift into two different house styles on the
 * same page. Only the prompt plumbing (role, task framing, JSON contract)
 * is written here.
 *
 * This string must stay byte-identical between requests: it is the prefix
 * Azure's prompt cache keys on (first 1024 tokens must match exactly). Nothing
 * per-request — chunk position, content length, page path — may be interpolated
 * into it; that all belongs in the user message built by buildMessages().
 */
const SYSTEM_PROMPT = [
  '你是企業內部 Wiki／SOP 文件的排版助手，只負責整理 Markdown／HTML 的「格式」與重點標註，不是內容審核者或編輯。',
  '你可以調整標題層級、清單、表格、粗體／斜體、空白行與段落分段，並依下方色票為既有的重要資訊加上顏色註記，讓文件更清楚易讀。',
  '',
  buildLayoutRulesPrompt(),
  '',
  '輸出規則：只能輸出一個 JSON 物件，格式固定如下，不可有其他文字、註解或 Markdown code fence：',
  '{"formatted_content": "排版後的完整內容", "changes": ["整理項目說明，例如：統一標題層級"], "warnings": ["需要人工確認的項目，沒有則為空陣列"]}',
  'changes 必須包含顏色註記說明，格式為「顏色 → 標記的段落 → 理由」，並在最後一項回報彩色標記總處數。',
].join('\n');

export interface AiLayoutChunkInfo {
  /** 1-based; 1 when the content wasn't split. */
  index: number;
  total: number;
}

/**
 * The variable part of the prompt goes last, on purpose: Azure's prompt cache
 * matches on the *start* of the prompt, so the fixed system prompt plus the
 * fixed instruction line stay identical across calls and only the article text
 * differs at the tail.
 */
function buildMessages(content: string, chunk: AiLayoutChunkInfo): ChatMessage[] {
  const chunkNote =
    chunk.total > 1
      ? [
          `這是整篇文章切成 ${chunk.total} 段後的第 ${chunk.index} 段。`,
          '只處理這一段的內容：不要輸出其他段落，也不要補上這一段沒有的標題或章節。',
          '分段時保留既有的標題層級，不要跨段調整層級（你看不到其他段落）。',
          '',
        ]
      : [];

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [...chunkNote, '請依規則輸出整理後的 JSON。', '', '【原始內容開始】', content, '【原始內容結束】'].join(
        '\n',
      ),
    },
  ];
}

/**
 * Console record of what the prompt cache actually did. Lands in the service
 * worker console (edge://extensions → 檢查檢視 service worker); the content
 * script logs the per-run total in the page console as well.
 */
function logUsage(usage: AiLayoutUsage | null, chunk: AiLayoutChunkInfo, apiVersion: string): void {
  const where = chunk.total > 1 ? `chunk ${chunk.index}/${chunk.total}` : 'single';
  if (!usage) {
    console.info(`[FWA] AI 排版 ${where} — Azure 回應沒有 usage 物件，無法記錄 token 用量`);
    return;
  }
  if (!usage.cacheReported) {
    console.info(
      `[FWA] AI 排版 ${where} — input ${usage.promptTokens} / cached input 未回報 / output ${usage.completionTokens} / total ${usage.totalTokens}` +
        `（此 deployment 的模型或 api-version ${apiVersion} 沒有回傳 prompt_tokens_details.cached_tokens；Prompt Cache 需要 GPT-4o 或更新的模型）`,
    );
    return;
  }
  const hitRate = usage.promptTokens > 0 ? Math.round((usage.cachedTokens / usage.promptTokens) * 100) : 0;
  console.info(
    `[FWA] AI 排版 ${where} — input ${usage.promptTokens} / cached input ${usage.cachedTokens} (${hitRate}%) / output ${usage.completionTokens} / total ${usage.totalTokens}`,
  );
}

function stripJsonFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Pure parse/validate step — exported so it can be unit-tested without a network call. */
export function parseAiLayoutResponse(raw: string): AiLayoutResult {
  const stripped = stripJsonFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new AiLayoutError('AI 回傳內容不是有效的 JSON，請重試一次。', 'invalid-json');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new AiLayoutError('AI 回傳內容不是有效的 JSON，請重試一次。', 'invalid-json');
  }
  const obj = parsed as Record<string, unknown>;
  const formattedContent = typeof obj.formatted_content === 'string' ? obj.formatted_content.trim() : '';
  if (!formattedContent) {
    throw new AiLayoutError('AI 回傳內容為空，請重試一次。', 'empty-response');
  }
  return {
    formatted_content: formattedContent,
    changes: toStringArray(obj.changes),
    warnings: toStringArray(obj.warnings),
  };
}

export async function runAiLayout(
  content: string,
  settings: Settings,
  chunk: AiLayoutChunkInfo = { index: 1, total: 1 },
): Promise<AiLayoutResult> {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new AiLayoutError('目前頁面沒有內容可以排版。', 'empty-response');
  }
  if (trimmed.length > MAX_CONTENT_CHARS) {
    throw new AiLayoutError(
      `這一段內容（約 ${trimmed.length} 字）超過單次排版上限（${MAX_CONTENT_CHARS} 字）。` +
        '通常是單一超長的程式碼區塊或表格無法再切開，請手動分段後再排版。',
      'token-limit',
    );
  }

  let creds;
  try {
    creds = validateAzureCredentials(settings);
  } catch (err) {
    if (err instanceof AzureOpenAiError) throw new AiLayoutError(err.message, err.code);
    throw err;
  }

  let completion: ChatCompletionResult;
  try {
    completion = await callAzureChatCompletion(creds, buildMessages(content, chunk), {
      timeoutMs: REQUEST_TIMEOUT_MS,
      temperature: 0.2,
      maxTokens: MAX_TOKENS,
    });
  } catch (err) {
    if (err instanceof AzureOpenAiError) throw new AiLayoutError(err.message, err.code);
    throw new AiLayoutError(err instanceof Error ? err.message : String(err), 'unknown');
  }

  logUsage(completion.usage, chunk, creds.apiVersion);

  const result = parseAiLayoutResponse(completion.text);
  if (completion.usage) result.usage = completion.usage;

  // A masked password is data loss, not an advisory formatting concern. Do
  // not expose the value in an error, warning, or log; just refuse to offer
  // this result for apply so the editor remains untouched.
  if (findMissingPasswordValues(content, result.formatted_content).length > 0) {
    throw new AiLayoutError(
      'AI 回傳結果疑似遮蔽或改寫原文密碼；為避免資料遺失，已停止套用。請重試或改用快速排版。',
      'content-preservation-failed',
    );
  }

  const missing = findMissingPreservedTokens(content, result.formatted_content);
  if (missing.length > 0) {
    result.warnings = [
      ...result.warnings,
      `⚠ 偵測到下列原文內容可能遺失或被改寫，請仔細確認：${missing.join('、')}`,
    ];
  }

  // Colour-annotation guards: advisory only, same as the preserved-token check
  // above — the user always sees the full diff and confirms manually.
  const unbalanced = findUnbalancedFormattingTags(result.formatted_content);
  if (unbalanced.length > 0) {
    result.warnings = [
      ...result.warnings,
      `⚠ 顏色／格式標籤沒有成對，套用後可能讓顏色蔓延到後面的內容：${unbalanced.join('、')}`,
    ];
  }

  const spanColorCount = findForbiddenColorSyntax(content, result.formatted_content);
  if (spanColorCount > 0) {
    result.warnings = [
      ...result.warnings,
      `⚠ 新增了 ${spanColorCount} 處 <span style="color:…"> 上色語法，右鍵選單無法用它改色或清除格式，建議改用 <font color="…">。`,
    ];
  }

  return result;
}

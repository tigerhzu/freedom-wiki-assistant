import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AzureOpenAiError } from '../src/shared/azure-openai-client';
import { activeColorRoles, buildLayoutRulesPrompt, layoutSyntax } from '../src/shared/layout-rules';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types';

const callAzureChatCompletion = vi.fn();
vi.mock('../src/shared/azure-openai-client', async () => {
  const actual = await vi.importActual<typeof import('../src/shared/azure-openai-client')>(
    '../src/shared/azure-openai-client',
  );
  return {
    ...actual,
    callAzureChatCompletion: (...args: unknown[]) => callAzureChatCompletion(...args),
  };
});

import { AiLayoutError, parseAiLayoutResponse, runAiLayout } from '../src/background/ai-layout-service';

/** callAzureChatCompletion now returns { text, usage } — usage is asserted separately below. */
function completion(text: string, usage: unknown = null): { text: string; usage: unknown } {
  return { text, usage };
}

const settingsWithAzure: Settings = {
  ...DEFAULT_SETTINGS,
  azureEndpoint: 'https://r.openai.azure.com',
  azureDeployment: 'gpt-4.1',
  azureApiKey: 'key',
  azureApiVersion: '2024-12-01-preview',
};

describe('parseAiLayoutResponse', () => {
  it('parses a plain JSON response', () => {
    const result = parseAiLayoutResponse(
      '{"formatted_content": "整理後內容", "changes": ["統一標題層級"], "warnings": []}',
    );
    expect(result).toEqual({ formatted_content: '整理後內容', changes: ['統一標題層級'], warnings: [] });
  });

  it('strips a ```json code fence around the JSON', () => {
    const raw = '```json\n{"formatted_content": "內容", "changes": [], "warnings": []}\n```';
    expect(parseAiLayoutResponse(raw).formatted_content).toBe('內容');
  });

  it('defaults missing changes/warnings arrays to []', () => {
    const result = parseAiLayoutResponse('{"formatted_content": "內容"}');
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('coerces non-string array entries away instead of crashing', () => {
    const result = parseAiLayoutResponse('{"formatted_content": "內容", "changes": ["ok", 5, null], "warnings": []}');
    expect(result.changes).toEqual(['ok']);
  });

  it('throws invalid-json for unparsable content', () => {
    try {
      parseAiLayoutResponse('this is not json');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AiLayoutError);
      expect((err as AiLayoutError).code).toBe('invalid-json');
    }
  });

  it('throws empty-response when formatted_content is missing or blank', () => {
    try {
      parseAiLayoutResponse('{"formatted_content": "   "}');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AiLayoutError);
      expect((err as AiLayoutError).code).toBe('empty-response');
    }
  });
});

describe('runAiLayout', () => {
  beforeEach(() => {
    callAzureChatCompletion.mockReset();
  });

  it('rejects empty content without making a network call', async () => {
    await expect(runAiLayout('   ', settingsWithAzure)).rejects.toMatchObject({ code: 'empty-response' });
    expect(callAzureChatCompletion).not.toHaveBeenCalled();
  });

  it('rejects content over the per-request length guard without making a network call', async () => {
    const huge = 'x'.repeat(50000);
    await expect(runAiLayout(huge, settingsWithAzure)).rejects.toMatchObject({ code: 'token-limit' });
    expect(callAzureChatCompletion).not.toHaveBeenCalled();
  });

  it('surfaces missing Azure config as config-missing without a network call', async () => {
    await expect(runAiLayout('hello', { ...settingsWithAzure, azureApiKey: '' })).rejects.toMatchObject({
      code: 'config-missing',
    });
    expect(callAzureChatCompletion).not.toHaveBeenCalled();
  });

  it('returns the parsed result on success', async () => {
    callAzureChatCompletion.mockResolvedValue(
      completion('{"formatted_content": "整理後", "changes": ["a"], "warnings": []}'),
    );
    const result = await runAiLayout('原文', settingsWithAzure);
    expect(result.formatted_content).toBe('整理後');
    expect(result.changes).toEqual(['a']);
  });

  it('attaches the token usage reported by the client', async () => {
    const usage = {
      promptTokens: 3120,
      cachedTokens: 2560,
      completionTokens: 1180,
      totalTokens: 4300,
      cacheReported: true,
    };
    callAzureChatCompletion.mockResolvedValue(
      completion('{"formatted_content": "整理後", "changes": [], "warnings": []}', usage),
    );
    const result = await runAiLayout('原文', settingsWithAzure);
    expect(result.usage).toEqual(usage);
  });

  it('appends a preserved-content warning when the guard flags a dropped token', async () => {
    callAzureChatCompletion.mockResolvedValue(
      completion('{"formatted_content": "已整理完成", "changes": [], "warnings": []}'),
    );
    const original = '伺服器 IP 為 10.0.0.5，請確認。';
    const result = await runAiLayout(original, settingsWithAzure);
    expect(result.warnings.some((w) => w.includes('10.0.0.5'))).toBe(true);
  });

  it('rejects a result that masks a source password instead of offering it for apply', async () => {
    callAzureChatCompletion.mockResolvedValue(
      completion('{"formatted_content": "密碼：[已遮蔽]", "changes": [], "warnings": []}'),
    );
    await expect(runAiLayout('密碼：local-pass_123', settingsWithAzure)).rejects.toMatchObject({
      code: 'content-preservation-failed',
    });
  });

  it('propagates an AzureOpenAiError from the client as an AiLayoutError with the same code', async () => {
    callAzureChatCompletion.mockRejectedValue(new AzureOpenAiError('timed out', 'timeout'));
    await expect(runAiLayout('原文', settingsWithAzure)).rejects.toMatchObject({ code: 'timeout' });
  });
});

/**
 * The button and the /wiki-layout-extension Skill must lay pages out the same
 * way, so the system prompt is asserted to BE the shared rules block from
 * shared/layout-rules.ts rather than a copy that happens to look similar.
 */
describe('runAiLayout system prompt', () => {
  beforeEach(() => {
    callAzureChatCompletion.mockReset();
    callAzureChatCompletion.mockResolvedValue(
      completion('{"formatted_content": "整理後", "changes": [], "warnings": []}'),
    );
  });

  async function systemPrompt(): Promise<string> {
    await runAiLayout('原文', settingsWithAzure);
    const messages = callAzureChatCompletion.mock.calls[0][1] as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe('system');
    return messages[0].content;
  }

  it('embeds the shared layout rules verbatim', async () => {
    expect(await systemPrompt()).toContain(buildLayoutRulesPrompt());
  });

  it('names every active color and the font-tag syntax', async () => {
    const prompt = await systemPrompt();
    for (const role of activeColorRoles) expect(prompt).toContain(role.color);
    expect(prompt).toContain(layoutSyntax.colorTag('顏色', '文字'));
  });

  it('keeps the JSON output contract and asks for color usage in changes', async () => {
    const prompt = await systemPrompt();
    expect(prompt).toContain('"formatted_content"');
    expect(prompt).toContain('changes 必須包含顏色註記說明');
  });

  it('passes the page content as user data, not as instructions', async () => {
    await runAiLayout('原文內容', settingsWithAzure);
    const messages = callAzureChatCompletion.mock.calls[0][1] as Array<{ role: string; content: string }>;
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('【原始內容開始】');
    expect(messages[1].content).toContain('原文內容');
  });

  /**
   * Prompt-cache contract: Azure keys the cache on the first 1024 tokens, so the
   * system prompt must not vary with the request and the article content must be
   * the last thing in the prompt.
   */
  it('keeps the system prompt byte-identical whether or not the content is chunked', async () => {
    await runAiLayout('第一段', settingsWithAzure, { index: 1, total: 1 });
    await runAiLayout('第二段', settingsWithAzure, { index: 2, total: 7 });
    const [first, second] = callAzureChatCompletion.mock.calls.map(
      (call) => (call[1] as Array<{ content: string }>)[0].content,
    );
    expect(second).toBe(first);
  });

  it('puts the chunk framing in the user message and the article content last', async () => {
    await runAiLayout('這一段的內容', settingsWithAzure, { index: 3, total: 7 });
    const messages = callAzureChatCompletion.mock.calls[0][1] as Array<{ role: string; content: string }>;
    expect(messages[0].content).not.toContain('第 3');
    expect(messages[1].content).toContain('切成 7 段後的第 3 段');
    expect(messages[1].content.trimEnd().endsWith('【原始內容結束】')).toBe(true);
    expect(messages[1].content.indexOf('這一段的內容')).toBeGreaterThan(messages[1].content.indexOf('切成 7 段'));
  });

  it('adds no chunk framing for a single-shot request', async () => {
    await runAiLayout('整篇文章', settingsWithAzure);
    const messages = callAzureChatCompletion.mock.calls[0][1] as Array<{ role: string; content: string }>;
    expect(messages[1].content).not.toContain('段後的第');
  });
});

describe('runAiLayout color-markup guards', () => {
  beforeEach(() => {
    callAzureChatCompletion.mockReset();
  });

  function respond(formatted: string): void {
    callAzureChatCompletion.mockResolvedValue(
      completion(JSON.stringify({ formatted_content: formatted, changes: [], warnings: [] })),
    );
  }

  it('warns when a color tag is left unclosed', async () => {
    respond('<font color="red">警告：停機</font> 後續說明 <font color="orange">注意');
    const result = await runAiLayout('警告：停機 後續說明 注意', settingsWithAzure);
    expect(result.warnings.some((w) => w.includes('沒有成對'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('<font>'))).toBe(true);
  });

  it('does not warn about balanced color markup', async () => {
    respond('> **<font color="red">警告：</font>** 會<font color="red">中斷網路</font>。');
    const result = await runAiLayout('警告：會中斷網路。', settingsWithAzure);
    expect(result.warnings.some((w) => w.includes('沒有成對'))).toBe(false);
  });

  it('ignores tags inside code blocks when checking balance', async () => {
    const original = ['範例：', '```html', '<font color="red">不成對的範例', '```'].join('\n');
    respond(original);
    const result = await runAiLayout(original, settingsWithAzure);
    expect(result.warnings.some((w) => w.includes('沒有成對'))).toBe(false);
  });

  it('warns when the model introduces the forbidden span-color syntax', async () => {
    respond('<span style="color:red">警告</span>：停機');
    const result = await runAiLayout('警告：停機', settingsWithAzure);
    expect(result.warnings.some((w) => w.includes('<span style="color:…">'))).toBe(true);
  });

  it('does not blame the model for span-color that the original page already had', async () => {
    const original = '<span style="color:red">警告</span>：停機';
    respond(original);
    const result = await runAiLayout(original, settingsWithAzure);
    expect(result.warnings.some((w) => w.includes('<span style="color:…">'))).toBe(false);
  });
});

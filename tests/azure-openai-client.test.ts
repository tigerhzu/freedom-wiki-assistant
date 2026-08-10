import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AzureOpenAiError,
  callAzureChatCompletion,
  normalizeAzureEndpoint,
  validateAzureCredentials,
} from '../src/shared/azure-openai-client';

describe('normalizeAzureEndpoint', () => {
  it('accepts a bare Azure OpenAI resource URL', () => {
    expect(normalizeAzureEndpoint('https://my-resource.openai.azure.com')).toBe(
      'https://my-resource.openai.azure.com',
    );
  });

  it('rejects non-https', () => {
    expect(() => normalizeAzureEndpoint('http://my-resource.openai.azure.com')).toThrow(AzureOpenAiError);
  });

  it('rejects a URL that already includes an API path', () => {
    expect(() =>
      normalizeAzureEndpoint('https://my-resource.openai.azure.com/openai/deployments/gpt-4'),
    ).toThrow(AzureOpenAiError);
  });

  it('rejects a non-Azure hostname', () => {
    expect(() => normalizeAzureEndpoint('https://example.com')).toThrow(AzureOpenAiError);
  });
});

describe('validateAzureCredentials', () => {
  const base = { azureEndpoint: 'https://r.openai.azure.com', azureDeployment: 'gpt-4.1', azureApiKey: 'key', azureApiVersion: '2024-12-01-preview' };

  it('passes through valid settings', () => {
    expect(validateAzureCredentials(base)).toEqual({
      endpoint: 'https://r.openai.azure.com',
      deployment: 'gpt-4.1',
      apiKey: 'key',
      apiVersion: '2024-12-01-preview',
    });
  });

  it('rejects a missing API key with code config-missing', () => {
    try {
      validateAzureCredentials({ ...base, azureApiKey: '' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AzureOpenAiError);
      expect((err as AzureOpenAiError).code).toBe('config-missing');
    }
  });

  it('rejects a missing deployment name', () => {
    expect(() => validateAzureCredentials({ ...base, azureDeployment: '' })).toThrow(AzureOpenAiError);
  });

  it('rejects a missing API version', () => {
    expect(() => validateAzureCredentials({ ...base, azureApiVersion: '' })).toThrow(AzureOpenAiError);
  });
});

describe('callAzureChatCompletion', () => {
  const creds = { endpoint: 'https://r.openai.azure.com', deployment: 'gpt-4.1', apiKey: 'key', apiVersion: '2024-12-01-preview' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the message content on a successful call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '  排版後內容  ' } }] }),
      }),
    );
    const { text } = await callAzureChatCompletion(creds, [{ role: 'user', content: 'hi' }]);
    expect(text).toBe('排版後內容');
  });

  it('reads prompt-cache token usage from prompt_tokens_details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '內容' } }],
          usage: {
            prompt_tokens: 3120,
            completion_tokens: 1180,
            total_tokens: 4300,
            prompt_tokens_details: { cached_tokens: 2560 },
          },
        }),
      }),
    );
    const { usage } = await callAzureChatCompletion(creds, [{ role: 'user', content: 'hi' }]);
    expect(usage).toEqual({
      promptTokens: 3120,
      cachedTokens: 2560,
      completionTokens: 1180,
      totalTokens: 4300,
      cacheReported: true,
    });
  });

  it('flags cacheReported=false when the model did not return prompt_tokens_details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '內容' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      }),
    );
    const { usage } = await callAzureChatCompletion(creds, [{ role: 'user', content: 'hi' }]);
    expect(usage).toMatchObject({ cacheReported: false, cachedTokens: 0, promptTokens: 100 });
  });

  it('returns usage=null when the response carries no usage object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '內容' } }] }),
      }),
    );
    const { usage } = await callAzureChatCompletion(creds, [{ role: 'user', content: 'hi' }]);
    expect(usage).toBeNull();
  });

  it('maps a context_length_exceeded HTTP error to token-limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 'context_length_exceeded', message: 'too long' } }),
      }),
    );
    try {
      await callAzureChatCompletion(creds, [{ role: 'user', content: 'hi' }]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AzureOpenAiError);
      expect((err as AzureOpenAiError).code).toBe('token-limit');
    }
  });

  it('maps an AbortError (timeout) to code timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      }),
    );
    try {
      await callAzureChatCompletion(creds, [{ role: 'user', content: 'hi' }], { timeoutMs: 5 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AzureOpenAiError);
      expect((err as AzureOpenAiError).code).toBe('timeout');
    }
  });

  it('maps an empty completion to empty-response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '   ' } }] }),
      }),
    );
    try {
      await callAzureChatCompletion(creds, [{ role: 'user', content: 'hi' }]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AzureOpenAiError);
      expect((err as AzureOpenAiError).code).toBe('empty-response');
    }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OrnithApiError,
  callOrnithChatCompletion,
  normalizeOrnithBaseUrl,
  validateOrnithCredentials,
} from '../src/shared/ornith-client';

const creds = {
  baseUrl: 'https://ornith.example.invalid/v1',
  model: 'Ornith-1.5-35B-A3B',
  apiKey: 'secret',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Ornith settings', () => {
  it('normalizes an HTTPS /v1 Base URL', () => {
    expect(normalizeOrnithBaseUrl('https://ornith.example.invalid/v1/')).toBe(creds.baseUrl);
  });

  it('rejects an insecure or non-v1 Base URL', () => {
    expect(() => normalizeOrnithBaseUrl('http://ornith.example.invalid/v1')).toThrow(OrnithApiError);
    expect(() => normalizeOrnithBaseUrl('https://ornith.example.invalid')).toThrow(OrnithApiError);
  });

  it('requires the API key and model', () => {
    expect(() => validateOrnithCredentials({ ornithBaseUrl: creds.baseUrl, ornithModel: creds.model, ornithApiKey: '' })).toThrow(OrnithApiError);
    expect(() => validateOrnithCredentials({ ornithBaseUrl: creds.baseUrl, ornithModel: '', ornithApiKey: 'key' })).toThrow(OrnithApiError);
  });
});

describe('callOrnithChatCompletion', () => {
  it('uses the OpenAI-compatible URL, Bearer key, and model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 3 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOrnithChatCompletion(creds, [{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${creds.baseUrl}/chat/completions`);
    expect(request.headers).toMatchObject({ Authorization: 'Bearer secret' });
    const body = JSON.parse(request.body as string);
    expect(body).toMatchObject({
      model: creds.model,
      temperature: 0,
      max_tokens: 4096,
      n: 1,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(body.messages[0].content).toBe('/no_think\n\nhi');
  });

  it('adds /no_think to the system prompt without mutating the caller messages', async () => {
    const messages = [
      { role: 'system' as const, content: 'system rules' },
      { role: 'user' as const, content: 'article' },
    ];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await callOrnithChatCompletion(creds, messages);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].content).toBe('/no_think\n\nsystem rules');
    expect(body.messages[1].content).toBe('article');
    expect(messages[0].content).toBe('system rules');
  });

  it('accepts text-part arrays from an OpenAI-compatible response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'array result' }] } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));
    await expect(callOrnithChatCompletion(creds, [{ role: 'user', content: 'hi' }])).resolves.toMatchObject({
      text: 'array result',
    });
  });

  it('records duration, output rate, and provider-reported reasoning tokens', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(3000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          total_tokens: 140,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    const result = await callOrnithChatCompletion(creds, [{ role: 'user', content: 'hi' }]);
    expect(result.usage).toMatchObject({
      completionTokens: 40,
      reasoningTokens: 0,
      durationMs: 2000,
      outputTokensPerSecond: 20,
    });
  });

  it('does not silently fall back to thinking when the gateway rejects the hard switch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'unexpected field chat_template_kwargs' } }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    await expect(callOrnithChatCompletion(creds, [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      code: 'http-error',
      message: expect.stringContaining('不支援硬性停用推理參數'),
    });
  });

  it('maps OpenAI-compatible context errors to token-limit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'too long' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));
    await expect(callOrnithChatCompletion(creds, [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      code: 'token-limit',
    });
  });

  it('rejects a successful response with empty content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));
    await expect(callOrnithChatCompletion(creds, [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      code: 'empty-response',
    });
  });

  it('explains reasoning-only responses without exposing the reasoning text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: null, reasoning_content: 'sensitive chain' } }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));
    try {
      await callOrnithChatCompletion(creds, [{ role: 'user', content: 'hi' }]);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'empty-response' });
      expect((error as Error).message).toContain('只回傳推理內容');
      expect((error as Error).message).not.toContain('sensitive chain');
    }
  });

  it('explains when thinking exhausts the output token budget', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'thinking' } }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));
    await expect(callOrnithChatCompletion(creds, [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      code: 'empty-response',
      message: expect.stringContaining('輸出 Token 已用完'),
    });
  });
});

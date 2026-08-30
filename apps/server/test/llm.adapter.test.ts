import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyUpstreamStatus,
  extractLlmErrorFields,
  LlmAdapter,
  LlmProviderError,
  parseProviderConfigs,
} from '../src/llm/llm.adapter';

/** 最小 fetch 响应桩：adapter 只消费 ok/status/text()/json() */
interface FakeFetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

function fakeResponse(status: number, body: string): FakeFetchResponse {
  return {
    ok: status < 400,
    status,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  };
}

const PROVIDER_ENV = {
  FLOWAGENT_PROVIDERS_TEST__BASEURL: 'https://upstream.example.com/v1',
  FLOWAGENT_PROVIDERS_TEST__APIKEY: 'sk-secret-key',
  FLOWAGENT_PROVIDERS_TEST__MODELS: 'm-1',
};

describe('parseProviderConfigs', () => {
  it('解析完整 Provider（baseURL/apiKey/models）', () => {
    const providers = parseProviderConfigs({
      FLOWAGENT_PROVIDERS_OPENAI__BASEURL: 'https://api.openai.com/v1/',
      FLOWAGENT_PROVIDERS_OPENAI__APIKEY: 'sk-test',
      FLOWAGENT_PROVIDERS_OPENAI__MODELS: 'gpt-4o, gpt-4o-mini',
    });
    const openai = providers.get('openai');
    expect(openai).toBeDefined();
    expect(openai?.baseURL).toBe('https://api.openai.com/v1');
    expect(openai?.apiKey).toBe('sk-test');
    expect(openai?.models).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('缺 apiKey 的 Provider 被剔除', () => {
    const providers = parseProviderConfigs({
      FLOWAGENT_PROVIDERS_BROKEN__BASEURL: 'https://x.com/v1',
    });
    expect(providers.size).toBe(0);
  });

  it('无关环境变量被忽略', () => {
    const providers = parseProviderConfigs({
      DATABASE_URL: 'file:./x.db',
      PORT: '3000',
      FLOWAGENT_PROVIDERS_X__UNKNOWN_FIELD: 'y',
    });
    expect(providers.size).toBe(0);
  });

  it('Provider 名大小写归一化（环境变量惯例大写）', () => {
    const providers = parseProviderConfigs({
      FLOWAGENT_PROVIDERS_MYPROVIDER__BASEURL: 'https://x.com/v1',
      FLOWAGENT_PROVIDERS_MYPROVIDER__APIKEY: 'k',
    });
    expect(providers.has('myprovider')).toBe(true);
  });
});

describe('LlmAdapter（无网络路径）', () => {
  it('未配置的 Provider 抛 LlmProviderError 且不泄漏 key', async () => {
    const adapter = LlmAdapter.fromEnv({});
    await expect(adapter.chatCompletion('missing', 'm', { messages: [] })).rejects.toBeInstanceOf(
      LlmProviderError,
    );
  });
});

describe('classifyUpstreamStatus', () => {
  it('404 → model_not_found；401 → auth；403 → forbidden；429 → rate_limited；5xx → upstream_error', () => {
    expect(classifyUpstreamStatus(404).category).toBe('model_not_found');
    expect(classifyUpstreamStatus(401).category).toBe('auth');
    expect(classifyUpstreamStatus(403).category).toBe('forbidden');
    expect(classifyUpstreamStatus(429).category).toBe('rate_limited');
    expect(classifyUpstreamStatus(500).category).toBe('upstream_error');
    expect(classifyUpstreamStatus(503).category).toBe('upstream_error');
    expect(classifyUpstreamStatus(400).category).toBe('invalid_request');
  });

  it('每个归类都携带中文 hint（401 密钥问题与 403 无权访问分开提示）', () => {
    expect(classifyUpstreamStatus(404).hint).toBe('模型不存在或已下线');
    expect(classifyUpstreamStatus(401).hint).toBe('密钥无效或额度不足');
    expect(classifyUpstreamStatus(403).hint).toBe(
      '无权访问该模型（可能密钥权限不足、模型未开通或地域受限）',
    );
    expect(classifyUpstreamStatus(429).hint).toBe('上游限流，请稍后重试');
    expect(classifyUpstreamStatus(500).hint).toBe('上游服务错误');
  });
});

describe('LlmAdapter 错误归类（mock 上游响应）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function captureError(status: number, body: string): Promise<LlmProviderError> {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(status, body)));
    const adapter = LlmAdapter.fromEnv(PROVIDER_ENV);
    try {
      await adapter.chatCompletion('test', 'm-1', { messages: [] });
      throw new Error('应当抛出 LlmProviderError');
    } catch (error) {
      return error as LlmProviderError;
    }
  }

  it('404 归类为 model_not_found，error 消息为中文摘要、不含上游原文', async () => {
    const error = await captureError(
      404,
      'Thank you for participating in the Stealth Ox Alpha testing period. user_id=9527 billing=https://pay.stealth-ox.example/9527',
    );
    expect(error.classification.category).toBe('model_not_found');
    expect(error.classification.hint).toBe('模型不存在或已下线');
    expect(error.message).toBe('模型不存在或已下线（上游 404）');
    expect(error.statusCode).toBe(404);
    expect(error.message).not.toContain('Stealth Ox');
    expect(error.message).not.toContain('user_id');
    expect(error.message).not.toContain('sk-secret-key');
  });

  it('401 归类为 auth（密钥无效或额度不足），message 不含上游 "Insufficient balance" 原文', async () => {
    const error = await captureError(401, '{"error":{"message":"Insufficient balance"}}');
    expect(error.classification.category).toBe('auth');
    expect(error.message).toBe('密钥无效或额度不足（上游 401）');
    expect(error.message).not.toContain('Insufficient');
  });

  it('403 归类为 forbidden（无权访问该模型），message 不含上游 "not available in your region" 原文', async () => {
    const error = await captureError(
      403,
      "This model is not available in your region (request id: 9527)",
    );
    expect(error.classification.category).toBe('forbidden');
    expect(error.classification.hint).toBe(
      '无权访问该模型（可能密钥权限不足、模型未开通或地域受限）',
    );
    expect(error.message).toBe('无权访问该模型（可能密钥权限不足、模型未开通或地域受限）（上游 403）');
    expect(error.statusCode).toBe(403);
    expect(error.message).not.toContain('not available in your region');
    expect(error.message).not.toContain('sk-secret-key');
  });

  it('429 归类为 rate_limited', async () => {
    const error = await captureError(429, 'rate limited');
    expect(error.classification.category).toBe('rate_limited');
    expect(error.classification.hint).toBe('上游限流，请稍后重试');
  });

  it('5xx 归类为 upstream_error；其余 4xx 归类为 invalid_request', async () => {
    const serverError = await captureError(502, 'bad gateway');
    expect(serverError.classification.category).toBe('upstream_error');
    expect(serverError.message).toBe('上游服务错误（上游 502）');

    const clientError = await captureError(422, 'unprocessable');
    expect(clientError.classification.category).toBe('invalid_request');
  });

  it('upstreamExcerpt 截断至 200 字符以内，保留用于诊断', async () => {
    const error = await captureError(404, 'x'.repeat(1000));
    expect(error.classification.upstreamExcerpt).toHaveLength(200);
  });

  it('upstreamExcerpt 抹去可能被上游回显的 apiKey', async () => {
    const error = await captureError(401, 'invalid key: sk-secret-key (account 9527)');
    expect(error.classification.upstreamExcerpt).not.toContain('sk-secret-key');
    expect(error.classification.upstreamExcerpt).toContain('***');
  });

  it('超时归类为 timeout，message 含超时时长', async () => {
    const fetchMock = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<FakeFetchResponse>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = LlmAdapter.fromEnv(PROVIDER_ENV);
    const error = (await adapter
      .chatCompletion('test', 'm-1', { messages: [], timeoutMs: 20 })
      .catch((e: unknown) => e)) as LlmProviderError;
    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error.classification.category).toBe('timeout');
    expect(error.classification.hint).toBe('请求超时');
    expect(error.message).toContain('请求超时');
    expect(error.message).not.toContain('sk-secret-key');
  });

  it('网络错误归类为 network，message 不含底层异常细节', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed: dns lookup stealth-ox.internal failed');
      }),
    );
    const adapter = LlmAdapter.fromEnv(PROVIDER_ENV);
    const error = (await adapter
      .chatCompletion('test', 'm-1', { messages: [] })
      .catch((e: unknown) => e)) as LlmProviderError;
    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error.classification.category).toBe('network');
    expect(error.message).toBe('无法连接上游服务');
    expect(error.message).not.toContain('dns');
  });

  it('错误对象经 extractLlmErrorFields 提取为事件 payload 扩展字段', async () => {
    const error = await captureError(404, 'stealth-ox model retired');
    const fields = extractLlmErrorFields(error);
    expect(fields).toEqual({
      errorCategory: 'model_not_found',
      errorHint: '模型不存在或已下线',
      upstreamExcerpt: 'stealth-ox model retired',
    });
    expect(extractLlmErrorFields(new Error('普通错误'))).toEqual({});
  });

  it('HTTP 200 + 网关错误包（无 choices）归类为 invalid_response，提示检查 Base URL', async () => {
    const error = await captureError(200, '{"code":500,"msg":"404 NOT_FOUND","success":false}');
    expect(error.classification.category).toBe('invalid_response');
    expect(error.message).toContain('Base URL');
    expect(error.message).toContain('OpenAI 兼容');
    expect(error.classification.upstreamExcerpt).toContain('404 NOT_FOUND');
  });

  it('HTTP 200 + Anthropic 格式响应归类为 invalid_response，提示改用 OpenAI 兼容端点', async () => {
    const error = await captureError(
      200,
      '{"content":[{"type":"text","text":"好的"}],"stop_reason":"end_turn"}',
    );
    expect(error.classification.category).toBe('invalid_response');
    expect(error.message).toContain('Anthropic');
    expect(error.message).toContain('open.bigmodel.cn/api/paas/v4');
  });
});

describe('LlmAdapter.testProvider（连通性测试）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('上游 200 → { ok: true, latencyMs }，请求携带 max_tokens=1', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, '{"choices":[{"message":{"content":"pong"}}]}'),
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = LlmAdapter.fromEnv(PROVIDER_ENV);
    const outcome = await adapter.testProvider('test', 'm-1');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.latencyMs).toBeTypeOf('number');
      expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    }

    const calls = fetchMock.mock.calls as unknown as Array<
      [url: unknown, init?: { body?: string }]
    >;
    const init = calls[0]?.[1];
    const requestBody = JSON.parse(init?.body ?? '{}') as { max_tokens?: number };
    expect(requestBody.max_tokens).toBe(1);
  });

  it('上游 404 → { ok: false, message }（中文，绝不变 500 / 不抛出）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(404, 'stealth-ox upstream raw body')),
    );
    const adapter = LlmAdapter.fromEnv(PROVIDER_ENV);
    const outcome = await adapter.testProvider('test', 'ghost-model');
    expect(outcome).toEqual({ ok: false, message: '模型不存在或已下线（上游 404）' });
  });

  it('上游 401 → { ok: false, message: 密钥无效或额度不足 }', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(401, 'Insufficient balance')));
    const adapter = LlmAdapter.fromEnv(PROVIDER_ENV);
    const outcome = await adapter.testProvider('test', 'm-1');
    expect(outcome).toEqual({ ok: false, message: '密钥无效或额度不足（上游 401）' });
  });

  it('chatCompletion 意外异常也被兜底为 ok:false，不向上抛', async () => {
    const adapter = LlmAdapter.fromEnv(PROVIDER_ENV);
    vi.spyOn(adapter, 'chatCompletion').mockRejectedValue(new Error('boom'));
    const outcome = await adapter.testProvider('test', 'm-1');
    expect(outcome).toEqual({ ok: false, message: '测试请求失败，请稍后重试' });
  });
});

describe('LlmAdapter.listProviders', () => {
  it('解析多个 Provider 并按名称排序，只含 name/models', () => {
    const adapter = LlmAdapter.fromEnv({
      FLOWAGENT_PROVIDERS_ZETA__BASEURL: 'https://z.example.com/v1',
      FLOWAGENT_PROVIDERS_ZETA__APIKEY: 'sk-z',
      FLOWAGENT_PROVIDERS_ZETA__MODELS: 'z-2, z-1',
      FLOWAGENT_PROVIDERS_ALPHA__BASEURL: 'https://a.example.com/v1',
      FLOWAGENT_PROVIDERS_ALPHA__APIKEY: 'sk-a',
      FLOWAGENT_PROVIDERS_ALPHA__MODELS: 'a-1',
    });
    expect(adapter.listProviders()).toEqual([
      { name: 'alpha', models: ['a-1'] },
      { name: 'zeta', models: ['z-2', 'z-1'] },
    ]);
  });

  it('缺 apiKey 或 baseURL 的 Provider 不出现', () => {
    const adapter = LlmAdapter.fromEnv({
      FLOWAGENT_PROVIDERS_NOKEY__BASEURL: 'https://n.example.com/v1',
      FLOWAGENT_PROVIDERS_NOKEY__MODELS: 'm-1',
      FLOWAGENT_PROVIDERS_NOURL__APIKEY: 'sk-n',
    });
    expect(adapter.listProviders()).toEqual([]);
  });

  it('返回的 models 数组是副本，外部修改不影响内部状态', () => {
    const adapter = LlmAdapter.fromEnv({
      FLOWAGENT_PROVIDERS_OPENAI__BASEURL: 'https://api.openai.com/v1',
      FLOWAGENT_PROVIDERS_OPENAI__APIKEY: 'sk-test',
      FLOWAGENT_PROVIDERS_OPENAI__MODELS: 'gpt-4o',
    });
    const first = adapter.listProviders();
    first[0]?.models.push('mutated');
    expect(adapter.listProviders()[0]?.models).toEqual(['gpt-4o']);
  });
});

import { describe, expect, it } from 'vitest';

import { LlmAdapter, LlmProviderError, parseProviderConfigs } from '../src/llm/llm.adapter';

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

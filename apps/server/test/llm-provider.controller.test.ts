import { describe, expect, it } from 'vitest';

import { LlmAdapter } from '../src/llm/llm.adapter';
import { LlmProviderController } from '../src/llm/llm-provider.controller';

describe('LlmProviderController', () => {
  it('GET providers 返回 { providers: [{ name, models }] }，按名称排序', () => {
    const adapter = LlmAdapter.fromEnv({
      FLOWAGENT_PROVIDERS_BETA__BASEURL: 'https://b.example.com/v1',
      FLOWAGENT_PROVIDERS_BETA__APIKEY: 'sk-b',
      FLOWAGENT_PROVIDERS_BETA__MODELS: 'b-1',
      FLOWAGENT_PROVIDERS_ALPHA__BASEURL: 'https://a.example.com/v1',
      FLOWAGENT_PROVIDERS_ALPHA__APIKEY: 'sk-a',
      FLOWAGENT_PROVIDERS_ALPHA__MODELS: 'a-1, a-2',
    });
    const controller = new LlmProviderController(adapter);
    expect(controller.listProviders()).toEqual({
      providers: [
        { name: 'alpha', models: ['a-1', 'a-2'] },
        { name: 'beta', models: ['b-1'] },
      ],
    });
  });

  it('响应体任何位置不含 apiKey/baseURL 敏感字段', () => {
    const adapter = LlmAdapter.fromEnv({
      FLOWAGENT_PROVIDERS_OPENAI__BASEURL: 'https://api.openai.com/v1',
      FLOWAGENT_PROVIDERS_OPENAI__APIKEY: 'sk-super-secret',
      FLOWAGENT_PROVIDERS_OPENAI__MODELS: 'gpt-4o',
    });
    const controller = new LlmProviderController(adapter);
    const serialized = JSON.stringify(controller.listProviders());
    expect(serialized).not.toContain('sk-super-secret');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('baseURL');
    expect(serialized).not.toContain('api.openai.com');
  });

  it('无任何 Provider 配置时返回空列表', () => {
    const controller = new LlmProviderController(LlmAdapter.fromEnv({}));
    expect(controller.listProviders()).toEqual({ providers: [] });
  });
});

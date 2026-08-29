import { afterEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { ProviderTestOutcome } from '../src/llm/llm.adapter';
import { LlmAdapter } from '../src/llm/llm.adapter';
import { LlmProviderController } from '../src/llm/llm-provider.controller';

/** 最小 fetch 响应桩：adapter 只消费 ok/status/text()/json() */
function fakeResponse(status: number, body: string) {
  return {
    ok: status < 400,
    status,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  };
}

function makeController(): LlmProviderController {
  const adapter = LlmAdapter.fromEnv({
    FLOWAGENT_PROVIDERS_OPENAI__BASEURL: 'https://api.openai.com/v1',
    FLOWAGENT_PROVIDERS_OPENAI__APIKEY: 'sk-super-secret',
    FLOWAGENT_PROVIDERS_OPENAI__MODELS: 'gpt-4o',
  });
  return new LlmProviderController(adapter);
}

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

describe('LlmProviderController POST providers/test', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('上游正常 → 200 { ok: true, latencyMs }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(200, '{"choices":[{"message":{"content":"pong"}}]}')),
    );
    const outcome = await makeController().testProvider({ provider: 'openai', model: 'gpt-4o' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.latencyMs).toBeTypeOf('number');
      expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('请求体缺失/非法 → 400 中文错误', async () => {
    const controller = makeController();
    await expect(controller.testProvider({ provider: 'openai' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.testProvider({ model: 'gpt-4o' })).rejects.toThrow(
      'provider 与 model 必须为非空字符串',
    );
    await expect(controller.testProvider('not-an-object')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.testProvider(null)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('provider 未配置 → 404 中文错误', async () => {
    await expect(
      makeController().testProvider({ provider: 'nope', model: 'm' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      makeController().testProvider({ provider: 'nope', model: 'm' }),
    ).rejects.toThrow('Provider “nope” 未配置或不存在');
  });

  it('上游 404 → 200 { ok: false, message }（中文），不含上游原文与 apiKey', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse(
          404,
          'Thank you for participating in the Stealth Ox Alpha testing period. user_id=9527 billing=https://pay.stealth-ox.example/9527',
        ),
      ),
    );
    const outcome: ProviderTestOutcome = await makeController().testProvider({
      provider: 'openai',
      model: 'ghost-model',
    });
    expect(outcome).toEqual({ ok: false, message: '模型不存在或已下线（上游 404）' });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain('Stealth Ox');
    expect(serialized).not.toContain('user_id');
    expect(serialized).not.toContain('sk-super-secret');
  });

  it('上游 401 → 200 { ok: false, message: 密钥无效或额度不足 }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(401, '{"error":"Insufficient balance"}')),
    );
    const outcome = await makeController().testProvider({ provider: 'openai', model: 'gpt-4o' });
    expect(outcome).toEqual({ ok: false, message: '密钥无效或额度不足（上游 401）' });
  });

  it('上游 429 / 5xx → 200 { ok: false, message }，绝不变 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(429, 'rate limited')));
    await expect(
      makeController().testProvider({ provider: 'openai', model: 'gpt-4o' }),
    ).resolves.toEqual({ ok: false, message: '上游限流，请稍后重试（上游 429）' });

    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(500, 'internal error')));
    await expect(
      makeController().testProvider({ provider: 'openai', model: 'gpt-4o' }),
    ).resolves.toEqual({ ok: false, message: '上游服务错误（上游 500）' });
  });

  it('测试链路意外异常被兜底为 ok:false（不冒泡成 500）', async () => {
    const controller = makeController();
    const internal = controller as unknown as { llmAdapter: LlmAdapter };
    vi.spyOn(internal.llmAdapter, 'testProvider').mockRejectedValue(new Error('boom'));
    const outcome = await controller.testProvider({ provider: 'openai', model: 'gpt-4o' });
    expect(outcome).toEqual({ ok: false, message: '测试请求失败，请稍后重试' });
  });
});

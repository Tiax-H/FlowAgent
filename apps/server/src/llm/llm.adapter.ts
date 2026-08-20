/**
 * LLM Adapter：OpenAI 兼容客户端（自定义 baseURL，支持聚合平台）。
 *
 * 架构红线：任何模块不得直接 import 厂商 SDK，只能通过本适配层。
 * API key 只从环境变量读取，严禁写入日志、事件流或数据库。
 */

export interface LlmToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface LlmCompletionRequest {
  messages: LlmChatMessage[];
  tools?: LlmToolDefinition[];
  temperature?: number;
  timeoutMs?: number;
}

export interface LlmCompletionResult {
  content: string | null;
  toolCalls: LlmChatMessage['tool_calls'];
  usage?: { promptTokens?: number; completionTokens?: number };
}

export class LlmProviderError extends Error {
  constructor(
    message: string,
    public readonly providerName: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

export interface LlmProviderConfig {
  name: string;
  baseURL: string;
  apiKey: string;
  models: string[];
}

const PROVIDER_ENV_PREFIX = 'FLOWAGENT_PROVIDERS_';

/** 从环境变量解析 Provider 配置表：FLOWAGENT_PROVIDERS_<NAME>__BASEURL/__APIKEY/__MODELS */
export function parseProviderConfigs(
  env: NodeJS.ProcessEnv = process.env,
): Map<string, LlmProviderConfig> {
  const providers = new Map<string, LlmProviderConfig>();

  for (const [key, rawValue] of Object.entries(env)) {
    if (!key.startsWith(PROVIDER_ENV_PREFIX)) continue;
    const rest = key.slice(PROVIDER_ENV_PREFIX.length);
    const separatorIndex = rest.indexOf('__');
    if (separatorIndex === -1) continue;
    const providerName = rest.slice(0, separatorIndex).toLowerCase();
    const field = rest.slice(separatorIndex + 2).toLowerCase();
    if (!providerName || !rawValue) continue;

    let provider = providers.get(providerName);
    if (!provider) {
      provider = { name: providerName, baseURL: '', apiKey: '', models: [] };
      providers.set(providerName, provider);
    }
    if (field === 'baseurl') provider.baseURL = normalizeBaseUrl(rawValue);
    else if (field === 'apikey') provider.apiKey = rawValue;
    else if (field === 'models')
      provider.models = rawValue
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean);
  }

  for (const [name, provider] of [...providers]) {
    if (!provider.baseURL || !provider.apiKey) providers.delete(name);
  }
  return providers;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export class LlmAdapter {
  private readonly providers: Map<string, LlmProviderConfig>;

  constructor(providers: Map<string, LlmProviderConfig>) {
    this.providers = providers;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): LlmAdapter {
    return new LlmAdapter(parseProviderConfigs(env));
  }

  /** 是否存在可用 Provider（供启动日志/健康检查，不暴露 key） */
  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  listProviderNames(): string[] {
    return [...this.providers.keys()];
  }

  async chatCompletion(
    providerName: string,
    model: string,
    request: LlmCompletionRequest,
  ): Promise<LlmCompletionResult> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new LlmProviderError(
        `Provider 未配置或缺少 baseURL/apiKey: "${providerName}"`,
        providerName,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 120_000);

    try {
      const response = await fetch(`${provider.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: request.messages,
          ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new LlmProviderError(
          `Provider 响应错误 ${response.status}: ${body.slice(0, 300)}`,
          providerName,
          response.status,
        );
      }

      const data = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string | null; tool_calls?: LlmChatMessage['tool_calls'] };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = data.choices?.[0]?.message;
      return {
        content: choice?.content ?? null,
        toolCalls: choice?.tool_calls,
        usage: {
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
        },
      };
    } catch (error) {
      if (error instanceof LlmProviderError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LlmProviderError(`请求超时（${request.timeoutMs ?? 120_000}ms）`, providerName);
      }
      throw new LlmProviderError(
        `网络错误: ${error instanceof Error ? error.message : String(error)}`,
        providerName,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

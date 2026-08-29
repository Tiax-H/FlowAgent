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
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LlmCompletionResult {
  content: string | null;
  toolCalls: LlmChatMessage['tool_calls'];
  usage?: { promptTokens?: number; completionTokens?: number };
}

/**
 * 上游错误归类（机器可读）。事件流 payload 的 errorCategory 取值与此对齐。
 */
export type LlmErrorCategory =
  | 'model_not_found'
  | 'auth'
  | 'rate_limited'
  | 'invalid_request'
  | 'upstream_error'
  | 'timeout'
  | 'network'
  | 'provider_not_configured';

/** 各归类的中文一句话提示（单一事实源，事件流 errorHint 与测试端点共用） */
export const LLM_ERROR_HINTS: Record<LlmErrorCategory, string> = {
  model_not_found: '模型不存在或已下线',
  auth: '密钥无效或额度不足',
  rate_limited: '上游限流，请稍后重试',
  invalid_request: '请求被上游拒绝',
  upstream_error: '上游服务错误',
  timeout: '请求超时',
  network: '无法连接上游服务',
  provider_not_configured: 'Provider 未配置或缺少 baseURL/apiKey',
};

/** 结构化归类结果：hint 为中文提示；upstreamExcerpt 为上游原文截断脱敏摘录 */
export interface LlmErrorClassification {
  category: LlmErrorCategory;
  hint: string;
  upstreamExcerpt?: string;
}

/** 上游响应原文摘录上限：超过部分丢弃，防止脏数据整段落入事件流 */
const UPSTREAM_EXCERPT_LIMIT = 200;

/**
 * 将上游 HTTP 状态归类（adapter 边界与连通性测试端点共用同一套映射，不得各写一份）。
 * 未列出的 4xx 一律归为 invalid_request（请求被上游拒绝）。
 */
export function classifyUpstreamStatus(statusCode: number): {
  category: LlmErrorCategory;
  hint: string;
} {
  if (statusCode === 404) {
    return { category: 'model_not_found', hint: LLM_ERROR_HINTS.model_not_found };
  }
  if (statusCode === 401 || statusCode === 403) {
    return { category: 'auth', hint: LLM_ERROR_HINTS.auth };
  }
  if (statusCode === 429) {
    return { category: 'rate_limited', hint: LLM_ERROR_HINTS.rate_limited };
  }
  if (statusCode >= 500) {
    return { category: 'upstream_error', hint: LLM_ERROR_HINTS.upstream_error };
  }
  return { category: 'invalid_request', hint: LLM_ERROR_HINTS.invalid_request };
}

/** 上游原文截断脱敏：摘录 ≤200 字符，且抹去可能被上游回显的 API key */
export function excerptUpstreamBody(body: string, redactSecrets: string[] = []): string {
  let excerpt = body;
  for (const secret of redactSecrets) {
    if (secret) excerpt = excerpt.split(secret).join('***');
  }
  return excerpt.slice(0, UPSTREAM_EXCERPT_LIMIT);
}

/**
 * LLM 上游错误。message 恒为中文一句话摘要（可直接落事件流，绝不含上游原文与 API key）；
 * 归类细节通过 category/hint/upstreamExcerpt 结构化携带，供事件 payload 扩展字段使用。
 */
export class LlmProviderError extends Error {
  constructor(
    message: string,
    public readonly providerName: string,
    public readonly classification: LlmErrorClassification,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

/**
 * 从任意错误中提取事件 payload 的错误归类扩展字段（errorCategory/errorHint/upstreamExcerpt）。
 * 非 LlmProviderError（如引擎自身的中文错误）返回空对象，payload 保持只有 error 字段。
 */
export function extractLlmErrorFields(error: unknown): {
  errorCategory?: string;
  errorHint?: string;
  upstreamExcerpt?: string;
} {
  if (!(error instanceof LlmProviderError)) return {};
  const fields: {
    errorCategory?: string;
    errorHint?: string;
    upstreamExcerpt?: string;
  } = { errorCategory: error.classification.category, errorHint: error.classification.hint };
  if (error.classification.upstreamExcerpt !== undefined) {
    fields.upstreamExcerpt = error.classification.upstreamExcerpt;
  }
  return fields;
}

export interface LlmProviderConfig {
  name: string;
  baseURL: string;
  apiKey: string;
  models: string[];
}

/** 对外暴露的 Provider 信息（只含名称与模型列表，不含 baseURL/apiKey） */
export interface LlmProviderInfo {
  name: string;
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

/** Provider 连通性测试结果 */
export type ProviderTestOutcome =
  | { ok: true; latencyMs: number }
  | { ok: false; message: string };

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

  /** 已配置 Provider 的公开信息列表（按名称排序，绝不包含 baseURL/apiKey） */
  listProviders(): LlmProviderInfo[] {
    return [...this.providers.values()]
      .map(({ name, models }) => ({ name, models: [...models] }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
        { category: 'provider_not_configured', hint: LLM_ERROR_HINTS.provider_not_configured },
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
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const { category, hint } = classifyUpstreamStatus(response.status);
        throw new LlmProviderError(
          `${hint}（上游 ${response.status}）`,
          providerName,
          {
            category,
            hint,
            ...(body ? { upstreamExcerpt: excerptUpstreamBody(body, [provider.apiKey]) } : {}),
          },
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
        throw new LlmProviderError(
          `请求超时（${request.timeoutMs ?? 120_000}ms）`,
          providerName,
          { category: 'timeout', hint: LLM_ERROR_HINTS.timeout },
        );
      }
      throw new LlmProviderError(
        LLM_ERROR_HINTS.network,
        providerName,
        { category: 'network', hint: LLM_ERROR_HINTS.network },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Provider 连通性测试：发一条 max_tokens=1 的最小补全请求并计时。
   * 上游任何失败都归一化为 ok:false + 中文提示（复用 classifyUpstreamStatus 归类），绝不抛出。
   */
  async testProvider(
    providerName: string,
    model: string,
    timeoutMs = 15_000,
  ): Promise<ProviderTestOutcome> {
    const startedAt = Date.now();
    try {
      await this.chatCompletion(providerName, model, {
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
        timeoutMs,
      });
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof LlmProviderError ? error.message : '测试请求失败，请稍后重试',
      };
    }
  }
}

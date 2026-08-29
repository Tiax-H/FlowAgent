/** Provider 配置来源：env=环境变量（只读） / db=网页端加密存储（可增删改） */
export type ProviderSource = 'env' | 'db';

export interface ProviderInfo {
  /** Provider 名称（工作流节点 data.provider 引用该名称） */
  name: string;
  /** 该 Provider 下可用的模型列表 */
  models: string[];
  /** 配置来源；老后端不返回该字段，一律按 env 只读处理 */
  source?: ProviderSource;
  /** db 来源时的 baseURL（非机密，仅 db 条目返回，供编辑弹窗预填） */
  baseURL?: string;
  /** db 来源时的密钥后四位（仅用于卡片掩码展示，接口绝不返回明文） */
  apiKeyLast4?: string;
  /** db 来源时的最近一次更新时间（ISO 字符串） */
  updatedAt?: string;
}

export interface ProviderListResult {
  /** 服务端是否启用网页端密钥存储（依赖 FLOWAGENT_SECRET_KEY）；老后端不返回该字段，视为只读 */
  configurable?: boolean;
  providers: ProviderInfo[];
}

/** 新建/更新 Provider 的载荷；models 为逗号分隔字符串 */
export interface ProviderWritePayload {
  baseURL: string;
  /** 仅新建时必填；更新时省略该字段表示保留原值（留空 = 不修改） */
  apiKey?: string;
  models: string;
}

/** 更新 Provider 的载荷：省略字段保留原值（只携带与预填值有变更的字段） */
export type ProviderUpdatePayload = Partial<ProviderWritePayload>;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `HTTP ${response.status}`);
  }
  // DELETE 返回 204 空响应体，不能走 response.json()
  const text = await response.text();
  return text === '' ? (undefined as T) : (JSON.parse(text) as T);
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs?: number;
  /** ok=false 时的中文失败原因 */
  message?: string;
}

/** LLM Provider 列表与配置：list/test 兼容旧后端，create/update/remove 仅在新后端（网页端配置）可用 */
export const providersApi = {
  list: () => request<ProviderListResult>('/api/llm/providers'),
  /** 测试某个 Provider + 模型的连通性（按名称，网页端新配置立即可测） */
  test: (provider: string, model: string) =>
    request<ProviderTestResult>('/api/llm/providers/test', {
      method: 'POST',
      body: JSON.stringify({ provider, model }),
    }),
  /** 新建网页端 Provider → 201 { name }；400/409/503 返回中文错误 message */
  create: (payload: { name: string } & ProviderWritePayload) =>
    request<{ name: string }>('/api/llm/providers', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  /** 更新网页端 Provider → 200 { name }；省略的字段保留原值 */
  update: (name: string, payload: ProviderUpdatePayload) =>
    request<{ name: string }>(`/api/llm/providers/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  /** 删除网页端 Provider → 204 */
  remove: (name: string) =>
    request<void>(`/api/llm/providers/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};

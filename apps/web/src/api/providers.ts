export interface ProviderInfo {
  /** Provider 名称（工作流节点 data.provider 引用该名称） */
  name: string;
  /** 该 Provider 下可用的模型列表 */
  models: string[];
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs?: number;
  /** ok=false 时的中文失败原因 */
  message?: string;
}

/** 已配置的 LLM Provider 列表（来自服务端环境变量，不含 apiKey） */
export const providersApi = {
  list: () => request<{ providers: ProviderInfo[] }>('/api/llm/providers'),
  /** 测试某个 Provider + 模型的连通性（后端未上线时本请求会 404，由调用方如实呈现失败） */
  test: (provider: string, model: string) =>
    request<ProviderTestResult>('/api/llm/providers/test', {
      method: 'POST',
      body: JSON.stringify({ provider, model }),
    }),
};

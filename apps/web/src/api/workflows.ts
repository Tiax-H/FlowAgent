import type { WorkflowDefinition } from '@flowagent/shared';

import type { WorkflowRecord } from '../workflow/types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch (cause) {
    if (cause instanceof TypeError) {
      throw new Error('无法连接服务器，请确认 server 已启动（pnpm dev）');
    }
    throw cause;
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
      errors?: string[];
    } | null;
    const detail = body?.errors?.length ? `：${body.errors.join('；')}` : '';
    throw new Error(`${body?.message ?? `HTTP ${response.status}`}${detail}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  definition: WorkflowDefinition;
}

export const workflowsApi = {
  /** search 传参时按名称关键字过滤；老后端不识别该参数时返回全量，由调用方前端过滤兜底 */
  list: (search?: string) =>
    request<WorkflowRecord[]>(
      search ? `/api/workflows?search=${encodeURIComponent(search)}` : '/api/workflows',
    ),
  get: (id: string) => request<WorkflowRecord>(`/api/workflows/${id}`),
  create: (body: CreateWorkflowInput) =>
    request<WorkflowRecord>('/api/workflows', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<CreateWorkflowInput>) =>
    request<WorkflowRecord>(`/api/workflows/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  remove: (id: string) => request<void>(`/api/workflows/${id}`, { method: 'DELETE' }),
};

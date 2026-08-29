import type { WorkflowDefinition } from '@flowagent/shared';

import type { WorkflowRecord } from '../workflow/types';

/** 带 HTTP 状态码的错误；409 冲突时附后端返回的 currentVersion（保存冲突检测用） */
export class WorkflowApiError extends Error {
  readonly status: number;
  readonly currentVersion?: number;

  constructor(message: string, status: number, currentVersion?: number) {
    super(message);
    this.name = 'WorkflowApiError';
    this.status = status;
    this.currentVersion = currentVersion;
  }
}

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
    // 后端 JSON body 上限 1MB：413 统一映射为中文提示，不透出裸状态码
    if (response.status === 413) {
      throw new WorkflowApiError('输入内容超过 1MB 上限，请精简后重试', 413);
    }
    const body = (await response.json().catch(() => null)) as {
      message?: string;
      errors?: string[];
      currentVersion?: number;
    } | null;
    const detail = body?.errors?.length ? `：${body.errors.join('；')}` : '';
    throw new WorkflowApiError(
      `${body?.message ?? `HTTP ${response.status}`}${detail}`,
      response.status,
      body?.currentVersion,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  definition: WorkflowDefinition;
}

export interface UpdateWorkflowInput extends Partial<CreateWorkflowInput> {
  /** 乐观锁：后端版本与该值不符时返回 409 { message, currentVersion }；老后端忽略该字段 */
  expectedVersion?: number;
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
  update: (id: string, body: UpdateWorkflowInput) =>
    request<WorkflowRecord>(`/api/workflows/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  remove: (id: string) => request<void>(`/api/workflows/${id}`, { method: 'DELETE' }),
};

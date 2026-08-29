import type { HumanInputRequest, RunSummary, WorkflowEvent } from '@flowagent/shared';

import type { WorkflowRecord } from '../workflow/types';

/** 带 HTTP 状态码的错误：调用方据此区分 404（不存在）等场景 */
export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
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
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new HttpError(body?.message ?? `HTTP ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

export const runsApi = {
  start: (workflowId: string, input?: unknown) =>
    request<{ runId: string }>(`/api/workflows/${workflowId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ input: input ?? null }),
    }),
  list: () => request<RunSummary[]>('/api/runs'),
  get: (runId: string) => request<RunSummary>(`/api/runs/${runId}`),
  events: (runId: string) => request<WorkflowEvent[]>(`/api/runs/${runId}/events`),
  pause: (runId: string) => request<{ ok: true }>(`/api/runs/${runId}/pause`, { method: 'POST' }),
  resume: (runId: string) => request<{ ok: true }>(`/api/runs/${runId}/resume`, { method: 'POST' }),
  retry: (runId: string) => request<{ ok: true }>(`/api/runs/${runId}/retry`, { method: 'POST' }),
  cancel: (runId: string) => request<{ ok: true }>(`/api/runs/${runId}/cancel`, { method: 'POST' }),
  humanInput: (runId: string, body: HumanInputRequest) =>
    request<{ ok: true }>(`/api/runs/${runId}/human-input`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 删除运行（DELETE /api/runs/:id → 204）；404 返回 missing，由调用方提示「已不存在」 */
  remove: async (runId: string): Promise<'deleted' | 'missing'> => {
    let response: Response;
    try {
      response = await fetch(`/api/runs/${runId}`, { method: 'DELETE' });
    } catch (cause) {
      if (cause instanceof TypeError) {
        throw new Error('无法连接服务器，请确认 server 已启动（pnpm dev）');
      }
      throw cause;
    }
    if (response.status === 404) return 'missing';
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(body?.message ?? `HTTP ${response.status}`);
    }
    return 'deleted';
  },
};

export type { RunSummary, WorkflowEvent, WorkflowRecord };

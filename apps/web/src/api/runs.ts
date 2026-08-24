import type { HumanInputRequest, RunSummary, WorkflowEvent } from '@flowagent/shared';

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
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `HTTP ${response.status}`);
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
};

export type { RunSummary, WorkflowEvent, WorkflowRecord };

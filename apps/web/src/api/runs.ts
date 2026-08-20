import type { RunSummary, WorkflowEvent } from '@flowagent/shared';

import type { WorkflowRecord } from '../workflow/types';

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

export const runsApi = {
  start: (workflowId: string, input?: unknown) =>
    request<{ runId: string }>(`/api/workflows/${workflowId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ input: input ?? null }),
    }),
  list: () => request<RunSummary[]>('/api/runs'),
  get: (runId: string) => request<RunSummary>(`/api/runs/${runId}`),
  events: (runId: string) => request<WorkflowEvent[]>(`/api/runs/${runId}/events`),
};

export type { RunSummary, WorkflowEvent, WorkflowRecord };

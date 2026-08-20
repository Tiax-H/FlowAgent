import type { WorkflowDefinition } from '@flowagent/shared';

import type { WorkflowRecord } from '../workflow/types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
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
  list: () => request<WorkflowRecord[]>('/api/workflows'),
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

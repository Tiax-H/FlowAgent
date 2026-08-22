/**
 * FlowAgent REST API 客户端：bridge 与服务端唯一的耦合面。
 * baseUrl 指向 FlowAgent server（默认 http://localhost:3000，可用 FLOWAGENT_URL 覆盖）。
 */
import type { RunSummary } from '@flowagent/shared';

export interface WorkflowListItem {
  id: string;
  name: string;
  description: string | null;
  version: number;
}

/** bridge 所需的最小 API 面（测试以内存实现替换） */
export interface FlowAgentApi {
  listWorkflows(): Promise<WorkflowListItem[]>;
  /** 启动一次运行，返回持久句柄 runId */
  startRun(workflowId: string, input: unknown): Promise<string>;
  getRun(runId: string): Promise<RunSummary>;
}

const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'canceled'] as const;

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FlowAgentClient implements FlowAgentApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  async listWorkflows(): Promise<WorkflowListItem[]> {
    return this.request<WorkflowListItem[]>('/api/workflows');
  }

  async startRun(workflowId: string, input: unknown): Promise<string> {
    const result = await this.request<{ runId: string }>(`/api/workflows/${workflowId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ input: input ?? null }),
    });
    return result.runId;
  }

  async getRun(runId: string): Promise<RunSummary> {
    return this.request<RunSummary>(`/api/runs/${runId}`);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(`FlowAgent API ${path} 失败(HTTP ${response.status}): ${body?.message ?? ''}`);
    }
    return (await response.json()) as T;
  }
}

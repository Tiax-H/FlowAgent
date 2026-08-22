import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@flowagent/shared';

import type { FlowAgentApi, WorkflowListItem } from '../src/flowagent-client.js';
import { createBridgeServer } from '../src/bridge-server.js';

function makeSummary(runId: string, status: string): RunSummary {
  return {
    id: runId,
    workflowId: 'wf_1',
    workflowName: '测试流',
    workflowVersion: 1,
    status,
    input: null,
    output: status === 'completed' ? { ok: true } : null,
    error: status === 'failed' ? '节点失败' : null,
    nodes: [],
    startedAt: null,
    endedAt: null,
    waitingHuman:
      status === 'waiting_human'
        ? { nodeId: 'review', nodeType: 'human', name: '人工审查', prompt: '是否放行？' }
        : null,
  };
}

/** 内存 API：nextStatuses 依次决定每次 getRun 的状态推进 */
class FakeApi implements FlowAgentApi {
  workflows: WorkflowListItem[] = [];
  runs = new Map<string, RunSummary>();
  nextStatuses: string[] = [];
  started: Array<{ workflowId: string; input: unknown }> = [];
  private seq = 0;

  async listWorkflows(): Promise<WorkflowListItem[]> {
    return this.workflows;
  }
  async startRun(workflowId: string, input: unknown): Promise<string> {
    this.started.push({ workflowId, input });
    this.seq += 1;
    const runId = `run_${this.seq}`;
    this.runs.set(runId, makeSummary(runId, 'running'));
    return runId;
  }
  async getRun(runId: string): Promise<RunSummary> {
    const status = this.nextStatuses.shift();
    if (status !== undefined) this.runs.set(runId, makeSummary(runId, status));
    return this.runs.get(runId) ?? makeSummary(runId, 'running');
  }
}

async function connect(api: FakeApi): Promise<Client> {
  const server = await createBridgeServer(api, { pollIntervalMs: 1, defaultWaitMs: 50 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'bridge-test', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('bridge-server', () => {
  it('启动同步：tools/list 含 4 个通用工具 + 每工作流工具', async () => {
    const api = new FakeApi();
    api.workflows = [{ id: 'wf1', name: '审查', description: null, version: 1 }];
    const client = await connect(api);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('flowagent_list_workflows');
    expect(names).toContain('flowagent_run_workflow');
    expect(names).toContain('flowagent_get_run');
    expect(names).toContain('flowagent_refresh_tools');
    expect(names).toContain('flowagent_run_wf1');
  });

  it('flowagent_run_workflow 阻塞等待至 completed 并回传输出', async () => {
    const api = new FakeApi();
    api.nextStatuses = ['completed'];
    const client = await connect(api);
    const outcome = await callJson(client, 'flowagent_run_workflow', {
      workflowId: 'wf1',
      input: { score: 1 },
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.output).toEqual({ ok: true });
    expect(String(outcome.runId)).toMatch(/^run_\d+$/);
    expect(api.started).toEqual([{ workflowId: 'wf1', input: { score: 1 } }]);
  });

  it('waitMs=0 立即返回持久句柄', async () => {
    const api = new FakeApi();
    const client = await connect(api);
    const outcome = await callJson(client, 'flowagent_run_workflow', {
      workflowId: 'wf1',
      waitMs: 0,
    });
    expect(outcome.status).toBe('running');
    expect(String(outcome.note)).toContain('flowagent_get_run');
  });

  it('等待超时返回当前快照并附提示', async () => {
    const api = new FakeApi();
    const client = await connect(api);
    const outcome = await callJson(client, 'flowagent_run_workflow', {
      workflowId: 'wf1',
      waitMs: 5,
    });
    expect(outcome.status).toBe('running');
    expect(String(outcome.note)).toContain('未到终态');
  });

  it('waiting_human 时透出挂起信息与审批提示', async () => {
    const api = new FakeApi();
    api.nextStatuses = ['waiting_human'];
    const client = await connect(api);
    const outcome = await callJson(client, 'flowagent_run_workflow', { workflowId: 'wf1' });
    expect(outcome.status).toBe('waiting_human');
    expect(outcome.waitingHuman).toMatchObject({ nodeId: 'review', prompt: '是否放行？' });
    expect(String(outcome.note)).toContain('人工');
  });

  it('flowagent_get_run 查询指定 run', async () => {
    const api = new FakeApi();
    const runId = await api.startRun('wf1', null);
    api.nextStatuses = ['failed'];
    const client = await connect(api);
    const outcome = await callJson(client, 'flowagent_get_run', { runId });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('节点失败');
  });

  it('每工作流动态工具与 refresh 增量同步', async () => {
    const api = new FakeApi();
    api.workflows = [{ id: 'wf1', name: 'A', description: null, version: 1 }];
    const client = await connect(api);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('flowagent_run_wf1');

    api.workflows = [
      { id: 'wf1', name: 'A', description: null, version: 1 },
      { id: 'wf2', name: 'B', description: null, version: 1 },
    ];
    const refresh = await callJson(client, 'flowagent_refresh_tools', {});
    expect(refresh).toEqual({ added: 1, removed: 0, total: 2 });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('flowagent_run_wf2');

    api.workflows = [{ id: 'wf2', name: 'B', description: null, version: 1 }];
    const refresh2 = await callJson(client, 'flowagent_refresh_tools', {});
    expect(refresh2).toEqual({ added: 0, removed: 1, total: 1 });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('flowagent_run_wf1');
  });

  it('动态工具可直接运行工作流', async () => {
    const api = new FakeApi();
    api.workflows = [{ id: 'wf1', name: 'A', description: null, version: 1 }];
    api.nextStatuses = ['completed'];
    const client = await connect(api);
    const outcome = await callJson(client, 'flowagent_run_wf1', { input: { x: 1 } });
    expect(outcome.status).toBe('completed');
    expect(api.started).toEqual([{ workflowId: 'wf1', input: { x: 1 } }]);
  });
});

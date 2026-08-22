import { describe, expect, it } from 'vitest';

import { FlowAgentClient, isTerminalRunStatus } from '../src/flowagent-client.js';

/** 路由表 stub：path → 静态 JSON 或 (init) => JSON */
function makeFetch(routes: Record<string, unknown | ((init?: RequestInit) => unknown)>): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const handler = Object.entries(routes).find(([pattern]) => path === pattern)?.[1];
    if (handler === undefined) {
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }
    const body = typeof handler === 'function' ? handler(init) : handler;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe('FlowAgentClient', () => {
  it('listWorkflows 命中 /api/workflows 并解析列表', async () => {
    const client = new FlowAgentClient(
      'http://fa.test/',
      makeFetch({
        '/api/workflows': [
          { id: 'wf_1', name: '审查流', description: null, version: 3 },
        ],
      }),
    );
    const workflows = await client.listWorkflows();
    expect(workflows).toEqual([{ id: 'wf_1', name: '审查流', description: null, version: 3 }]);
  });

  it('startRun 发送 POST + JSON body 并返回 runId', async () => {
    let captured: RequestInit | undefined;
    const client = new FlowAgentClient(
      'http://fa.test',
      makeFetch({
        '/api/workflows/wf_1/runs': (init) => {
          captured = init;
          return { runId: 'run_9' };
        },
      }),
    );
    const runId = await client.startRun('wf_1', { score: 1 });
    expect(runId).toBe('run_9');
    expect(captured?.method).toBe('POST');
    expect(JSON.parse(String(captured?.body))).toEqual({ input: { score: 1 } });
  });

  it('非 2xx 抛错并携带服务端 message', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: '运行不存在: x' }), { status: 404 })) as typeof fetch;
    const client = new FlowAgentClient('http://fa.test', fetchImpl);
    await expect(client.getRun('x')).rejects.toThrow(/运行不存在: x/);
  });

  it('isTerminalRunStatus 三终态', () => {
    expect(isTerminalRunStatus('completed')).toBe(true);
    expect(isTerminalRunStatus('failed')).toBe(true);
    expect(isTerminalRunStatus('canceled')).toBe(true);
    expect(isTerminalRunStatus('running')).toBe(false);
    expect(isTerminalRunStatus('waiting_human')).toBe(false);
  });
});

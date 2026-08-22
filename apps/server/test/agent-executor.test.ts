import { describe, expect, it } from 'vitest';
import type { WorkflowEvent } from '@flowagent/shared';

import { createAgentExecutor } from '../src/engine/executors/agent.executor';
import type { NodeRuntimeServices } from '../src/engine/executors/types';
import type { WorkflowNode } from '@flowagent/shared';

function agentNode(data: Record<string, unknown>): WorkflowNode {
  return { id: 'agent_1', type: 'agent', name: 'A', position: { x: 0, y: 0 }, data };
}

function makeEmit(events: WorkflowEvent[]) {
  let seq = 0;
  return async (type: WorkflowEvent['type'], payload: Record<string, unknown>) => {
    seq += 1;
    events.push({ runId: 'r', seq, type, payload, timestamp: new Date().toISOString() });
  };
}

describe('Agent ReAct 执行器', () => {
  it('两轮循环：先调工具再给最终回复', async () => {
    const events: WorkflowEvent[] = [];
    const emit = makeEmit(events);

    const chatCalls: Array<{ tools?: unknown[] }> = [];
    const runtime: NodeRuntimeServices = {
      llm: {
        chatCompletion: async (_provider, _model, request) => {
          chatCalls.push({ tools: request.tools as unknown[] | undefined });
          if (chatCalls.length === 1) {
            return {
              content: null,
              toolCalls: [
                {
                  id: 'call_1',
                  type: 'function' as const,
                  function: { name: 'search__web_search', arguments: '{"query":"mcp"}' },
                },
              ],
            };
          }
          return { content: '{"answer":"mcp 是工具调用协议"}' };
        },
      },
      callTool: async (server, tool) => {
        expect(server).toBe('search');
        expect(tool).toBe('web_search');
        return { ok: true, result: [{ type: 'text', text: '[{"title":"MCP 规范"}]' }] };
      },
      listToolSchemas: async () => [
        {
          server: 'search',
          tool: 'web_search',
          description: '搜索',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
    };

    const executor = createAgentExecutor(runtime);
    const result = await executor({
      node: agentNode({
        provider: 'test',
        model: 'fake',
        prompt: '查一下 mcp',
        tools: [{ server: 'search', tool: 'web_search' }],
      }),
      context: { input: {}, variables: {}, nodeOutputs: {} },
      emit,
    });

    // 两轮 LLM，第一轮带 tools
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[0]?.tools).toHaveLength(1);
    expect(chatCalls[1]?.tools).toHaveLength(1);

    // 事件序列：LLM_REQUESTED → TOOL_CALLED → TOOL_RESULT → LLM_COMPLETED
    const types = events.map((event) => event.type);
    expect(types).toEqual(['LLM_REQUESTED', 'TOOL_CALLED', 'TOOL_RESULT', 'LLM_COMPLETED']);

    // 最终输出 JSON 解析
    expect(result.output).toEqual({ answer: 'mcp 是工具调用协议' });
    expect(result.suspended).toBeUndefined();
  });

  it('未绑定工具时直接单轮回复', async () => {
    const events: WorkflowEvent[] = [];
    const emit = makeEmit(events);

    const runtime: NodeRuntimeServices = {
      llm: {
        chatCompletion: async () => ({ content: '直接回答' }),
      },
      callTool: async () => ({ ok: true, result: [] }),
      listToolSchemas: async () => [],
    };

    const executor = createAgentExecutor(runtime);
    const result = await executor({
      node: agentNode({ provider: 'test', model: 'fake', prompt: '你好' }),
      context: { input: {}, variables: {}, nodeOutputs: {} },
      emit,
    });

    expect(result.output).toEqual({ text: '直接回答' });
    expect(events.map((event) => event.type)).toEqual(['LLM_REQUESTED', 'LLM_COMPLETED']);
  });

  it('达到 maxIterations 上限收敛为提示文本', async () => {
    const events: WorkflowEvent[] = [];
    const emit = makeEmit(events);

    let callCount = 0;
    const runtime: NodeRuntimeServices = {
      llm: {
        chatCompletion: async () => {
          callCount += 1;
          return {
            content: null,
            toolCalls: [
              {
                id: `call_${callCount}`,
                type: 'function' as const,
                function: { name: 'search__web_search', arguments: '{}' },
              },
            ],
          };
        },
      },
      callTool: async () => ({ ok: true, result: [] }),
      listToolSchemas: async () => [
        {
          server: 'search',
          tool: 'web_search',
          description: '搜索',
          inputSchema: { type: 'object' },
        },
      ],
    };

    const executor = createAgentExecutor(runtime);
    const result = await executor({
      node: agentNode({ provider: 'test', model: 'fake', prompt: 'x', maxIterations: 3 }),
      context: { input: {}, variables: {}, nodeOutputs: {} },
      emit,
    });

    expect(callCount).toBe(3);
    expect(result.output).toEqual({ text: 'Agent 达到最大轮数（3）未产生最终回复' });
  });
});

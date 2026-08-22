import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@flowagent/shared';

import { definitionToFlow, flowToDefinition } from '../src/workflow/convert';

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  name: 'roundtrip',
  nodes: [
    { id: 'start', type: 'start', name: '开始', position: { x: 80, y: 200 }, data: {} },
    {
      id: 'cond_1',
      type: 'condition',
      name: '分支',
      position: { x: 300, y: 200 },
      data: { branches: [{ id: 'ok', expression: 'true' }] },
    },
    {
      id: 'end',
      type: 'end',
      name: '结束',
      position: { x: 600, y: 200 },
      data: { outputs: { final: '{{cond_1.output}}' } },
    },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'cond_1' },
    { id: 'e2', source: 'cond_1', target: 'end', sourceHandle: 'ok' },
  ],
};

describe('definitionToFlow / flowToDefinition', () => {
  it('往返转换保持契约一致', () => {
    const flow = definitionToFlow(definition);
    expect(flow.nodes).toHaveLength(3);
    expect(flow.edges[1]?.sourceHandle).toBe('ok');

    const restored = flowToDefinition(flow.nodes, flow.edges, {
      schemaVersion: 1,
      name: 'roundtrip',
      nodes: [],
      edges: [],
    });
    expect(restored.nodes).toEqual(definition.nodes);
    expect(restored.edges).toEqual(definition.edges);
  });

  it('Condition 分支 data 保留在节点数据中', () => {
    const flow = definitionToFlow(definition);
    const conditionNode = flow.nodes.find((node) => node.id === 'cond_1');
    expect(conditionNode?.data).toMatchObject({
      nodeType: 'condition',
      name: '分支',
      branches: [{ id: 'ok', expression: 'true' }],
    });
  });
});

describe('节点级 timeoutMs/retry 往返保留（2026-08-22 复审修复）', () => {
  it('画布往返不丢失节点级韧性字段', () => {
    const withResilience: WorkflowDefinition = {
      schemaVersion: 1,
      name: 'resilience',
      nodes: [
        { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
        {
          id: 'llm_1',
          type: 'llm',
          name: '可重试',
          position: { x: 200, y: 0 },
          timeoutMs: 30_000,
          retry: { maxAttempts: 3, initialDelayMs: 200 },
          data: { provider: 'p', model: 'm', prompt: 'hi' },
        },
        { id: 'end', type: 'end', name: '结束', position: { x: 400, y: 0 }, data: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'llm_1' },
        { id: 'e2', source: 'llm_1', target: 'end' },
      ],
    };
    const flow = definitionToFlow(withResilience);
    const restored = flowToDefinition(flow.nodes, flow.edges, {
      schemaVersion: 1,
      name: 'resilience',
      nodes: [],
      edges: [],
    });
    const llm = restored.nodes.find((item) => item.id === 'llm_1');
    expect(llm?.timeoutMs).toBe(30_000);
    expect(llm?.retry).toEqual({ maxAttempts: 3, initialDelayMs: 200 });
    // __nodeExtras 不应泄漏进 data
    expect(llm?.data.__nodeExtras).toBeUndefined();
    // 无韧性字段的节点不产生空 extras
    const start = restored.nodes.find((item) => item.id === 'start');
    expect(start?.data.__nodeExtras).toBeUndefined();
    expect(start?.timeoutMs).toBeUndefined();
  });
});

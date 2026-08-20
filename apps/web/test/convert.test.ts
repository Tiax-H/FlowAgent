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

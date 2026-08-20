import { describe, expect, it } from 'vitest';
import { validateWorkflowDefinition, type WorkflowDefinition } from '@flowagent/shared';

import { definitionToFlow, flowToDefinition } from '../src/workflow/convert';

/**
 * 复现编辑器保存链路：definitionToFlow（加载）→ 用户改动 → flowToDefinition（保存）→ 校验。
 * 验证各类环必须被拦截。
 */

function makeDefinition(
  edgeList: Array<{ source: string; target: string; sourceHandle?: string }>,
): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'agent',
        type: 'agent',
        name: 'A',
        position: { x: 200, y: 0 },
        data: { provider: 'p', model: 'm' },
      },
      {
        id: 'llm',
        type: 'llm',
        name: 'B',
        position: { x: 400, y: 0 },
        data: { provider: 'p', model: 'm', prompt: 'x' },
      },
      { id: 'end', type: 'end', name: '结束', position: { x: 600, y: 0 }, data: {} },
    ],
    edges: edgeList.map((edge, index) => ({
      id: `e${index}`,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    })),
  };
}

function editorSavePipeline(
  definition: WorkflowDefinition,
): ReturnType<typeof validateWorkflowDefinition> {
  const flow = definitionToFlow(definition);
  const restored = flowToDefinition(flow.nodes, flow.edges, {
    schemaVersion: 1,
    name: 'x',
    nodes: [],
    edges: [],
  });
  return validateWorkflowDefinition(restored);
}

describe('编辑器保存链路的环检测', () => {
  it('A→B→A 互指环被拦截', () => {
    const result = editorSavePipeline(
      makeDefinition([
        { source: 'start', target: 'agent' },
        { source: 'agent', target: 'llm' },
        { source: 'llm', target: 'agent' },
        { source: 'llm', target: 'end' },
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((message) => message.includes('DAG'))).toBe(true);
  });

  it('节点自环（agent→agent）被拦截', () => {
    const result = editorSavePipeline(
      makeDefinition([
        { source: 'start', target: 'agent' },
        { source: 'agent', target: 'agent' },
        { source: 'agent', target: 'end' },
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((message) => message.includes('DAG'))).toBe(true);
  });

  it('Condition 分支回边成环被拦截', () => {
    const definition = makeDefinition([
      { source: 'start', target: 'agent' },
      { source: 'agent', target: 'llm' },
      { source: 'llm', target: 'agent', sourceHandle: 'back' },
      { source: 'llm', target: 'end' },
    ]);
    definition.nodes[1] = {
      ...definition.nodes[1]!,
      type: 'condition',
      data: { branches: [{ id: 'back', expression: 'true' }] },
    };
    const result = editorSavePipeline(definition);
    expect(result.valid).toBe(false);
    expect(result.errors.some((message) => message.includes('DAG'))).toBe(true);
  });

  it('合法线性图通过', () => {
    const result = editorSavePipeline(
      makeDefinition([
        { source: 'start', target: 'agent' },
        { source: 'agent', target: 'llm' },
        { source: 'llm', target: 'end' },
      ]),
    );
    expect(result.valid).toBe(true);
  });
});

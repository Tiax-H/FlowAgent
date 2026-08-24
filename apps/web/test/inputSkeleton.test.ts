import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@flowagent/shared';

import { buildInputSkeleton, collectInputFieldNames } from '../src/lib/inputSkeleton';

function definitionWith(nodes: WorkflowDefinition['nodes']): WorkflowDefinition {
  return { schemaVersion: 1, name: 't', nodes, edges: [] };
}

describe('collectInputFieldNames', () => {
  it('从提示词与模板中提取 {{input.xxx}} 的顶层字段并去重排序', () => {
    const definition = definitionWith([
      {
        id: 'llm_1',
        type: 'llm',
        name: '分析',
        position: { x: 0, y: 0 },
        data: { provider: 'p', model: 'm', prompt: '审查 diff：{{input.diff}}，背景 {{ input.topic }}' },
      },
      {
        id: 't_1',
        type: 'transform',
        name: '映射',
        position: { x: 100, y: 0 },
        data: { template: { a: '{{input.diff}}', b: '{{input.extra.note}}' } },
      },
    ]);
    expect(collectInputFieldNames(definition)).toEqual(['diff', 'extra', 'topic']);
  });

  it('忽略节点引用与非字符串字段，无引用时返回空数组', () => {
    const definition = definitionWith([
      {
        id: 'llm_1',
        type: 'llm',
        name: 'x',
        position: { x: 0, y: 0 },
        data: { provider: 'p', model: 'm', prompt: '总结 {{llm_0.output}}' },
      },
      { id: 'start', type: 'start', name: 's', position: { x: 0, y: 0 }, data: {} },
    ]);
    expect(collectInputFieldNames(definition)).toEqual([]);
  });
});

describe('buildInputSkeleton', () => {
  it('按引用生成顶层骨架对象', () => {
    const definition = definitionWith([
      {
        id: 'llm_1',
        type: 'llm',
        name: 'x',
        position: { x: 0, y: 0 },
        data: { provider: 'p', model: 'm', prompt: '审查 {{input.diff}}' },
      },
    ]);
    expect(buildInputSkeleton(definition)).toEqual({ diff: '' });
  });
});

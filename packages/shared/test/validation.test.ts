import { describe, expect, it } from 'vitest';

import { validateWorkflowDefinition } from '../src/validation';
import type { WorkflowDefinition } from '../src/workflow';

function baseDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
      { id: 'end', type: 'end', name: '结束', position: { x: 400, y: 0 }, data: {} },
    ],
    edges: [{ id: 'e1', source: 'start', target: 'end' }],
    ...overrides,
  };
}

describe('validateWorkflowDefinition', () => {
  it('最小合法定义通过', () => {
    const result = validateWorkflowDefinition(baseDefinition());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('带 Agent/Condition/Loop 的完整定义通过', () => {
    const definition = baseDefinition({
      nodes: [
        { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
        {
          id: 'agent_1',
          type: 'agent',
          name: '规划',
          position: { x: 100, y: 0 },
          data: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            tools: [{ server: 'search', tool: 'web_search' }],
          },
        },
        {
          id: 'cond_1',
          type: 'condition',
          name: '分支',
          position: { x: 200, y: 0 },
          data: {
            branches: [
              { id: 'ok', expression: 'result.score > 0.5' },
              { id: 'default', expression: 'true' },
            ],
          },
        },
        { id: 'end', type: 'end', name: '结束', position: { x: 400, y: 0 }, data: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'agent_1' },
        { id: 'e2', source: 'agent_1', target: 'cond_1' },
        { id: 'e3', source: 'cond_1', target: 'end', sourceHandle: 'ok' },
        { id: 'e4', source: 'cond_1', target: 'end', sourceHandle: 'default' },
      ],
    });
    const result = validateWorkflowDefinition(definition);
    expect(result.valid).toBe(true);
  });

  it('非对象输入被拒绝', () => {
    const result = validateWorkflowDefinition('not a workflow');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('缺少必填字段被拒绝', () => {
    const result = validateWorkflowDefinition({ schemaVersion: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('nodes'))).toBe(true);
  });

  it('未知节点类型被拒绝', () => {
    const definition = baseDefinition({
      nodes: [
        { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
        { id: 'rag', type: 'rag', name: '违规', position: { x: 100, y: 0 }, data: {} },
      ],
    });
    const result = validateWorkflowDefinition(definition);
    expect(result.valid).toBe(false);
  });

  it('节点 id 重复被拒绝', () => {
    const definition = baseDefinition({
      nodes: [
        { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
        { id: 'start', type: 'end', name: '结束', position: { x: 400, y: 0 }, data: {} },
      ],
      edges: [],
    });
    const result = validateWorkflowDefinition(definition);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('重复'))).toBe(true);
  });

  it('悬空边被拒绝', () => {
    const definition = baseDefinition({
      edges: [{ id: 'bad', source: 'start', target: 'ghost' }],
    });
    const result = validateWorkflowDefinition(definition);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('ghost'))).toBe(true);
  });

  it('多个 start 节点被拒绝', () => {
    const definition = baseDefinition({
      nodes: [
        { id: 'start', type: 'start', name: '开始1', position: { x: 0, y: 0 }, data: {} },
        { id: 'start2', type: 'start', name: '开始2', position: { x: 0, y: 100 }, data: {} },
        { id: 'end', type: 'end', name: '结束', position: { x: 400, y: 0 }, data: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'end' },
        { id: 'e2', source: 'start2', target: 'end' },
      ],
    });
    const result = validateWorkflowDefinition(definition);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('start 节点'))).toBe(true);
  });

  it('无 end 节点被拒绝', () => {
    const definition = baseDefinition({
      nodes: [{ id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    const result = validateWorkflowDefinition(definition);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('end 节点'))).toBe(true);
  });

  it('主图成环被拒绝并给出环路径', () => {
    const definition = baseDefinition({
      nodes: [
        { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
        {
          id: 'a',
          type: 'llm',
          name: 'A',
          position: { x: 100, y: 0 },
          data: { provider: 'p', model: 'm', prompt: 'x' },
        },
        {
          id: 'b',
          type: 'llm',
          name: 'B',
          position: { x: 200, y: 0 },
          data: { provider: 'p', model: 'm', prompt: 'x' },
        },
        { id: 'end', type: 'end', name: '结束', position: { x: 400, y: 0 }, data: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'a' },
        { id: 'e4', source: 'b', target: 'end' },
      ],
    });
    const result = validateWorkflowDefinition(definition);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((error) => error.includes('DAG') && error.includes('a → b → a')),
    ).toBe(true);
  });

  it('Condition 出边缺少 sourceHandle 被拒绝', () => {
    const definition = baseDefinition({
      nodes: [
        { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
        {
          id: 'cond_1',
          type: 'condition',
          name: '分支',
          position: { x: 100, y: 0 },
          data: { branches: [{ id: 'ok', expression: 'true' }] },
        },
        { id: 'end', type: 'end', name: '结束', position: { x: 400, y: 0 }, data: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'cond_1' },
        { id: 'e2', source: 'cond_1', target: 'end' },
      ],
    });
    const result = validateWorkflowDefinition(definition);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('sourceHandle'))).toBe(true);
  });

  it('sourceHandle 不属于任何分支被拒绝', () => {
    const definition = baseDefinition({
      nodes: [
        { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
        {
          id: 'cond_1',
          type: 'condition',
          name: '分支',
          position: { x: 100, y: 0 },
          data: { branches: [{ id: 'ok', expression: 'true' }] },
        },
        { id: 'end', type: 'end', name: '结束', position: { x: 400, y: 0 }, data: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'cond_1' },
        { id: 'e2', source: 'cond_1', target: 'end', sourceHandle: 'nonexistent' },
      ],
    });
    const result = validateWorkflowDefinition(definition);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('nonexistent'))).toBe(true);
  });

  it('不可达节点被拒绝', () => {
    const definition = baseDefinition({
      nodes: [
        { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
        { id: 'end', type: 'end', name: '结束', position: { x: 400, y: 0 }, data: {} },
        {
          id: 'island',
          type: 'llm',
          name: '孤岛',
          position: { x: 200, y: 200 },
          data: { provider: 'p', model: 'm', prompt: 'x' },
        },
      ],
      edges: [{ id: 'e1', source: 'start', target: 'end' }],
    });
    const result = validateWorkflowDefinition(definition);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('island'))).toBe(true);
  });
});

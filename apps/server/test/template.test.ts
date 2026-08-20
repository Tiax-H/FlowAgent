import { describe, expect, it } from 'vitest';

import { renderDeep, renderTemplate, type TemplateContext } from '../src/engine/template';

function context(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    input: { query: 'mcp', count: 2 },
    variables: { threshold: 0.6 },
    nodeOutputs: { agent_1: { output: { items: ['a', 'b'], score: 0.8 } }, raw: '纯文本' },
    ...overrides,
  };
}

describe('renderTemplate', () => {
  it('整体单个占位符保留原类型（对象）', () => {
    const value = renderTemplate('{{agent_1.output}}', context());
    expect(value).toEqual({ items: ['a', 'b'], score: 0.8 });
  });

  it('数组路径与数字索引', () => {
    expect(renderTemplate('{{agent_1.output.items.1}}', context())).toBe('b');
    expect(renderTemplate('{{agent_1.output.score}}', context())).toBe(0.8);
  });

  it('input.* 与 variables.*', () => {
    expect(renderTemplate('{{input.query}}', context())).toBe('mcp');
    expect(renderTemplate('{{variables.threshold}}', context())).toBe(0.6);
  });

  it('混合文本插值', () => {
    expect(renderTemplate('查询 {{input.query}} 得分 {{agent_1.output.score}}', context())).toBe(
      '查询 mcp 得分 0.8',
    );
  });

  it('未命中路径返回 null（整体）/ 空串（插值）', () => {
    expect(renderTemplate('{{agent_1.missing}}', context())).toBeNull();
    expect(renderTemplate('x{{agent_1.missing}}y', context())).toBe('xy');
  });

  it('loop.item / loop.index 上下文', () => {
    const ctx = context({ loop: { item: { id: 9 }, index: 3 } });
    expect(renderTemplate('{{loop.item.id}}', ctx)).toBe(9);
    expect(renderTemplate('{{loop.index}}', ctx)).toBe(3);
  });
});

describe('renderDeep', () => {
  it('递归渲染对象内模板', () => {
    const result = renderDeep(
      { title: '{{input.query}}', detail: { score: '{{agent_1.output.score}}' } },
      context(),
    );
    expect(result).toEqual({ title: 'mcp', detail: { score: 0.8 } });
  });

  it('数组元素渲染', () => {
    const result = renderDeep(['{{input.query}}', '{{variables.threshold}}'], context());
    expect(result).toEqual(['mcp', 0.6]);
  });

  it('非字符串值原样返回', () => {
    const result = renderDeep({ num: 42, flag: true, nil: null }, context());
    expect(result).toEqual({ num: 42, flag: true, nil: null });
  });
});

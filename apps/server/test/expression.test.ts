import { describe, expect, it } from 'vitest';

import { evaluateCondition } from '../src/engine/expression';
import type { TemplateContext } from '../src/engine/template';

function context(): TemplateContext {
  return {
    input: { query: 'mcp' },
    variables: { threshold: 0.6 },
    nodeOutputs: { agent_1: { output: { score: 0.8, items: [1, 2, 3] } } },
  };
}

describe('evaluateCondition', () => {
  it('属性访问 + 比较', () => {
    expect(evaluateCondition('agent_1.output.score > variables.threshold', context())).toBe(true);
    expect(evaluateCondition('agent_1.output.score < variables.threshold', context())).toBe(false);
  });

  it('逻辑组合', () => {
    expect(
      evaluateCondition('agent_1.output.score > 0.7 && input.query == "mcp"', context()),
    ).toBe(true);
    expect(evaluateCondition('false || agent_1.output.score > 0.9', context())).toBe(false);
  });

  it('字面量 true（默认分支）', () => {
    expect(evaluateCondition('true', context())).toBe(true);
  });

  it('数组 length 访问', () => {
    expect(evaluateCondition('agent_1.output.items.length > 2', context())).toBe(true);
  });

  it('未知变量抛错（不静默通过）', () => {
    expect(() => evaluateCondition('nonexistent.value > 1', context())).toThrow();
  });

  it('语法错误抛错', () => {
    expect(() => evaluateCondition('a >', context())).toThrow(/语法错误/);
  });
});

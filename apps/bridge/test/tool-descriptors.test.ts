import { describe, expect, it } from 'vitest';

import {
  describeWorkflowTool,
  diffToolNames,
  isEligibleWorkflowToolName,
  workflowToolName,
} from '../src/tool-descriptors.js';

const wf = { id: 'cmt3abc', name: '代码审查', description: '读 diff 并审查', version: 2 };

describe('tool-descriptors', () => {
  it('workflowToolName 用下划线拼接且通过严格客户端校验', () => {
    const name = workflowToolName(wf.id);
    expect(name).toBe('flowagent_run_cmt3abc');
    expect(isEligibleWorkflowToolName(name)).toBe(true);
  });

  it('isEligibleWorkflowToolName 拒绝冒号/超长/空', () => {
    expect(isEligibleWorkflowToolName('flowagent_run:cmt3abc')).toBe(false);
    expect(isEligibleWorkflowToolName(`flowagent_run_${'a'.repeat(70)}`)).toBe(false);
    expect(isEligibleWorkflowToolName('')).toBe(false);
  });

  it('describeWorkflowTool 汇总名称/版本/描述/用法', () => {
    const descriptor = describeWorkflowTool(wf);
    expect(descriptor.title).toBe('代码审查');
    expect(descriptor.description).toContain('代码审查');
    expect(descriptor.description).toContain('v2');
    expect(descriptor.description).toContain('读 diff 并审查');
    expect(descriptor.description).toContain('waitMs');
  });

  it('无描述时不输出空行占位', () => {
    const descriptor = describeWorkflowTool({ ...wf, description: null });
    expect(descriptor.description).not.toContain('null');
  });

  it('diffToolNames 计算增量', () => {
    expect(diffToolNames(['a', 'b'], ['b', 'c'])).toEqual({ toAdd: ['c'], toRemove: ['a'] });
    expect(diffToolNames([], [])).toEqual({ toAdd: [], toRemove: [] });
  });
});

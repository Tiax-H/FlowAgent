import { describe, expect, it } from 'vitest';

import { exportFileName, parseImportedWorkflow } from '../src/workflow/import';

const validDefinition = {
  schemaVersion: 1,
  name: '最小工作流',
  nodes: [
    { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
    { id: 'end', type: 'end', name: '结束', position: { x: 1, y: 1 }, data: {} },
  ],
  edges: [{ id: 'e1', source: 'start', target: 'end' }],
};

describe('parseImportedWorkflow', () => {
  it('合法定义解析成功并携带名称', () => {
    const result = parseImportedWorkflow(JSON.stringify(validDefinition));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('最小工作流');
      expect(result.value.definition.nodes).toHaveLength(2);
    }
  });

  it('非法 JSON 返回错误', () => {
    const result = parseImportedWorkflow('{oops');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('JSON');
  });

  it('结构非法（成环）返回校验错误', () => {
    const cyclic = {
      ...validDefinition,
      nodes: [
        ...validDefinition.nodes,
        { id: 'a', type: 'transform', name: 'A', position: { x: 2, y: 2 }, data: {} },
      ],
      edges: [
        ...validDefinition.edges,
        { id: 'e2', source: 'a', target: 'a' },
        { id: 'e3', source: 'end', target: 'a' },
      ],
    };
    const result = parseImportedWorkflow(JSON.stringify(cyclic));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('校验失败');
  });

  it('缺省名称回退为导入的工作流', () => {
    const result = parseImportedWorkflow(JSON.stringify({ ...validDefinition, name: '  ' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('导入的工作流');
  });
});

describe('exportFileName', () => {
  it('替换文件系统非法字符', () => {
    expect(exportFileName('报告/初稿:v2')).toBe('报告_初稿_v2.json');
    expect(exportFileName('a*b?c')).toBe('a_b_c.json');
  });
  it('空名称回退 workflow', () => {
    expect(exportFileName('   ')).toBe('workflow.json');
  });
});

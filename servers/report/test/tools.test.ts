import { describe, expect, it } from 'vitest';

import {
  formatCitations,
  generateMarkdownReport,
  validateCitations,
  validateReportInput,
} from '../src/tools';

const sampleInput = {
  title: '深度研究报告',
  sections: [
    { heading: '结论', body: 'MCP 已成为事实标准。' },
    { heading: '建议', body: '尽早接入。' },
  ],
  metadata: { 作者: 'FlowAgent', 轮次: '3' },
};

describe('validateReportInput', () => {
  it('空标题被拒', () => {
    expect(validateReportInput({ ...sampleInput, title: '  ' })).toContain('title');
  });

  it('空章节列表被拒', () => {
    expect(validateReportInput({ ...sampleInput, sections: [] })).toContain('sections');
  });

  it('空章节标题被拒', () => {
    expect(
      validateReportInput({ ...sampleInput, sections: [{ heading: ' ', body: 'x' }] }),
    ).toContain('heading');
  });

  it('合法输入通过', () => {
    expect(validateReportInput(sampleInput)).toBeNull();
  });
});

describe('generateMarkdownReport', () => {
  it('渲染标题、元数据表与章节', () => {
    const markdown = generateMarkdownReport(sampleInput);
    expect(markdown).toContain('# 深度研究报告');
    expect(markdown).toContain('| 键 | 值 |');
    expect(markdown).toContain('| 作者 | FlowAgent |');
    expect(markdown).toContain('## 结论');
    expect(markdown).toContain('MCP 已成为事实标准。');
  });

  it('无元数据时不输出表格', () => {
    const markdown = generateMarkdownReport({ title: 'T', sections: [{ heading: 'H', body: 'B' }] });
    expect(markdown).not.toContain('| 键 | 值 |');
    expect(markdown).toContain('## H');
  });
});

describe('validateCitations', () => {
  it('合法来源通过', () => {
    expect(validateCitations([{ title: '规范', url: 'https://example.com/spec' }])).toBeNull();
  });

  it('非法 URL 被拒', () => {
    expect(validateCitations([{ title: 'x', url: 'not-a-url' }])).toContain('格式非法');
  });

  it('非 http 协议被拒', () => {
    expect(validateCitations([{ title: 'x', url: 'ftp://example.com/a' }])).toContain('http');
  });
});

describe('formatCitations', () => {
  it('输出编号引用清单', () => {
    const text = formatCitations([
      { title: 'A 篇', url: 'https://a.example.com' },
      { title: 'B 篇', url: 'https://b.example.com' },
    ]);
    expect(text).toContain('- [1] A 篇 — https://a.example.com');
    expect(text).toContain('- [2] B 篇 — https://b.example.com');
  });
});

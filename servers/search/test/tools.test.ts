import { describe, expect, it } from 'vitest';

import { fetchPage, webSearch } from '../src/tools';

describe('webSearch', () => {
  it('按关键词命中', () => {
    const hits = webSearch('mcp protocol');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.title).toContain('Model Context Protocol');
  });

  it('limit 生效', () => {
    expect(webSearch('mcp', 1)).toHaveLength(1);
  });

  it('空查询返回空', () => {
    expect(webSearch('   ')).toEqual([]);
  });

  it('无命中返回空', () => {
    expect(webSearch('完全不存在的关键词xyz')).toEqual([]);
  });
});

describe('fetchPage', () => {
  it('已知 URL 返回页面内容', () => {
    const content = fetchPage('https://example.com/mcp-spec');
    expect(content).toContain('Model Context Protocol');
  });

  it('未知 URL 返回 404 提示', () => {
    const content = fetchPage('https://example.com/nope');
    expect(content).toContain('404');
  });
});

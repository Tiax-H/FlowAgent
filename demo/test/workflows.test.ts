import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { validateWorkflowDefinition } from '@flowagent/shared';

const workflowsDir = fileURLToPath(new URL('../workflows/', import.meta.url));

async function listDemoFiles(): Promise<string[]> {
  return (await readdir(workflowsDir)).filter((file) => file.endsWith('.json')).sort();
}

describe('demo 工作流资产', () => {
  it('包含三个演示工作流文件', async () => {
    expect(await listDemoFiles()).toEqual(['flagship.json', 'research.json', 'review.json']);
  });

  it('每个工作流通过 shared 校验且名称唯一', async () => {
    const names: string[] = [];
    for (const file of await listDemoFiles()) {
      const definition = JSON.parse(await readFile(join(workflowsDir, file), 'utf-8')) as unknown;
      const result = validateWorkflowDefinition(definition);
      expect(result.errors, `${file}: ${result.errors.join('; ')}`).toEqual([]);
      names.push((definition as { name?: string }).name ?? '');
    }
    expect(new Set(names).size).toBe(3);
  });

  it('旗舰流水线：廉价模型规划 → 双 Agent 并行 → human 审查 → 强模型汇总', async () => {
    const definition = JSON.parse(await readFile(join(workflowsDir, 'flagship.json'), 'utf-8')) as {
      nodes: Array<{ id: string; type: string }>;
      edges: Array<{ source: string; target: string }>;
    };
    const types = definition.nodes.map((node) => node.type);
    expect(types.filter((type) => type === 'agent')).toHaveLength(4);
    expect(types).toContain('human');
    const plannerTargets = definition.edges
      .filter((edge) => edge.source === 'planner')
      .map((edge) => edge.target);
    expect(plannerTargets).toEqual(['vision_agent', 'search_agent']);
    const reviewSources = definition.edges
      .filter((edge) => edge.target === 'review')
      .map((edge) => edge.source);
    expect(reviewSources.sort()).toEqual(['search_agent', 'vision_agent']);
  });

  it('深度研究：loop 子图内 agent 绑定 search 工具，report 工具节点绑定 report 服务', async () => {
    const definition = JSON.parse(await readFile(join(workflowsDir, 'research.json'), 'utf-8')) as {
      nodes: Array<{
        id: string;
        type: string;
        data?: {
          subgraph?: { nodes: Array<{ data?: { tools?: Array<{ server: string }> } }> };
          server?: string;
        };
      }>;
    };
    const loop = definition.nodes.find((node) => node.type === 'loop');
    expect(loop?.data?.subgraph?.nodes[0]?.data?.tools?.[0]?.server).toBe('search');
    const toolNode = definition.nodes.find((node) => node.type === 'tool');
    expect(toolNode?.data?.server).toBe('report');
  });

  it('代码审查：condition 分支 id 与出边 sourceHandle 一致', async () => {
    const definition = JSON.parse(await readFile(join(workflowsDir, 'review.json'), 'utf-8')) as {
      nodes: Array<{ id: string; type: string; data?: { branches?: Array<{ id: string }> } }>;
      edges: Array<{ source: string; sourceHandle?: string }>;
    };
    const gate = definition.nodes.find((node) => node.type === 'condition');
    const branchIds = (gate?.data?.branches ?? []).map((branch) => branch.id).sort();
    const handles = definition.edges
      .filter((edge) => edge.source === 'gate')
      .map((edge) => edge.sourceHandle ?? '')
      .sort();
    expect(branchIds).toEqual(handles);
    expect(handles).toContain('severe');
    expect(handles).toContain('auto');
  });
});

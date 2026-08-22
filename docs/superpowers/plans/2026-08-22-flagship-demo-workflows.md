# 旗舰 Demo 工作流与 UI 打磨 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 PROJECT_PLAN §8 的三个示例工作流（旗舰多模型协作流水线 / 深度研究 / 代码审查）+ 一键导入脚本 + 编辑器导入导出与列表删除，完成第 9 周收尾。

**Architecture:** 新增 `demo/` workspace 包（JSON 资产 + vitest 校验 + seed.mjs 导入脚本），工作流定义只依赖 `@flowagent/shared` 的既有契约（schemaVersion 1），导入走既有 REST `POST /api/workflows`（服务端复用 shared 校验）。UI 侧在编辑器加导入/导出（解析逻辑抽为可单测纯函数）、列表页接通已有的 `DELETE /api/workflows/:id`。

**Tech Stack:** TypeScript strict、@flowagent/shared（validateWorkflowDefinition）、vitest、React（既有编辑器）、pnpm workspace（`demo/` 需加入 pnpm-workspace.yaml——注意：当前 workspace 只含 apps/*、packages/*、servers/*）。

**Spec:** docs/PROJECT_PLAN.md §8（旗舰 Demo 与辅助 Demo 定义）、AGENTS.md（共享类型唯一事实源、文档同步）。

## Global Constraints

- 全 TypeScript strict；禁止 `any`（逃逸用 `unknown` + 收窄）。seed.mjs 为纯 JS（无类型检查）。
- 共享类型/校验只从 `@flowagent/shared` import。
- 提交信息：Conventional Commits + 中文描述。
- 工作流 JSON 必须通过 `validateWorkflowDefinition`（恰好一个 start、≥1 end、DAG、从 start 全可达、condition 出边 sourceHandle 必须命中分支 id、非 condition 出边不带 sourceHandle）。
- 运行时契约（demo JSON 设计依据，执行者写资产时不得偏离）：Agent/LLM 输出字符串会尝试 JSON.parse、失败退化为 `{text}`；模板支持整对象插值（`{{node.output}}`）；condition 表达式支持深层点分路径（`analyze.output.risk >= 7`）与 `&&`/`||`；human 节点 prompt 不做模板渲染（静态文字）；tool 节点 args 支持深层模板；loop 的 collection 支持模板、子图内用 `{{loop.item}}`。
- Provider 命名对齐 .env.example：`openai`（gpt-4o-mini / gpt-4o）与 `aggregator`（deepseek-chat / qwen-max）；工具绑定 server 名对齐 demo MCP Server 连接名 `search` / `report`（用户需先在 MCP 页连接）。
- 每任务收尾 `corepack pnpm lint` 零报错。
- 本机 Git Bash 全局 pnpm 可能不可用，统一 `corepack pnpm ...`。

---

### Task 1: demo 包与三个工作流 JSON 资产

**Files:**
- Modify: `pnpm-workspace.yaml`（packages 追加 `demo` 或 `demo/*`——用 `- demo` 单目录即可）
- Create: `demo/package.json`
- Create: `demo/workflows/flagship.json`
- Create: `demo/workflows/research.json`
- Create: `demo/workflows/review.json`
- Test: `demo/test/workflows.test.ts`

**Interfaces:**
- Consumes: `@flowagent/shared` 的 `validateWorkflowDefinition`。
- Produces: 三个合法 WorkflowDefinition JSON（name 分别为 `旗舰·多模型协作流水流线`——注意：`旗舰·多模型协作流水线`，见下方 JSON 原文 / `深度研究（Loop 多轮检索）` / `代码审查（条件 + 人工审批）`），供 Task 2 的 seed.mjs 与用户 UI 导入消费。

- [ ] **Step 1: 建包骨架**

`pnpm-workspace.yaml` 整体替换为：

```yaml
packages:
  - apps/*
  - packages/*
  - servers/*
  - demo
```

`demo/package.json`：

```json
{
  "name": "@flowagent/demo",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "seed": "node seed.mjs"
  },
  "devDependencies": {
    "@flowagent/shared": "workspace:*",
    "typescript": "^5.5.4",
    "vitest": "^2.1.8"
  }
}
```

Run: `corepack pnpm install`
Expected: 无错误。

- [ ] **Step 2: 写失败测试**

`demo/test/workflows.test.ts`：

```ts
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
```

Run: `corepack pnpm --filter @flowagent/demo exec vitest run`
Expected: FAIL——workflows 目录不存在/文件缺失。

- [ ] **Step 3: 写三个工作流 JSON**

`demo/workflows/flagship.json`（原文如下，含转义换行）：

```json
{
  "schemaVersion": 1,
  "name": "旗舰·多模型协作流水线",
  "description": "廉价模型规划 → 视觉/搜索 Agent 并行 → Human 审查 → 强模型汇总（PROJECT_PLAN §8 旗舰 Demo）。需先配置 openai/aggregator 两个 Provider，并在 MCP 页连接 search Server。",
  "nodes": [
    { "id": "start", "type": "start", "name": "开始", "position": { "x": 40, "y": 260 }, "data": {} },
    {
      "id": "planner",
      "type": "agent",
      "name": "规划（廉价模型）",
      "position": { "x": 260, "y": 260 },
      "timeoutMs": 60000,
      "retry": { "maxAttempts": 2, "initialDelayMs": 500 },
      "data": {
        "provider": "openai",
        "model": "gpt-4o-mini",
        "systemPrompt": "你是任务规划器。只输出严格 JSON，不加代码块围栏。",
        "prompt": "把下面的任务拆解为两条并行支线的输入，只输出 JSON：{\"vision_brief\": \"给视觉模型的观察要点\", \"search_query\": \"给检索代理的关键词\"}\n任务：{{input.topic}}"
      }
    },
    {
      "id": "vision_agent",
      "type": "agent",
      "name": "视觉 Agent",
      "position": { "x": 520, "y": 120 },
      "timeoutMs": 120000,
      "retry": { "maxAttempts": 2, "initialDelayMs": 500 },
      "data": {
        "provider": "openai",
        "model": "gpt-4o",
        "prompt": "基于以下规划产出视觉侧分析结论：\n{{planner.output}}"
      }
    },
    {
      "id": "search_agent",
      "type": "agent",
      "name": "搜索 Agent",
      "position": { "x": 520, "y": 400 },
      "timeoutMs": 120000,
      "retry": { "maxAttempts": 2, "initialDelayMs": 500 },
      "data": {
        "provider": "aggregator",
        "model": "deepseek-chat",
        "maxIterations": 5,
        "tools": [
          { "server": "search", "tool": "web_search" },
          { "server": "search", "tool": "fetch_page" }
        ],
        "prompt": "围绕规划检索资料并给出带来源的要点。规划：\n{{planner.output}}"
      }
    },
    {
      "id": "review",
      "type": "human",
      "name": "人工审查",
      "position": { "x": 800, "y": 260 },
      "data": {
        "prompt": "视觉与搜索两条支线已完成。请在事件时间轴中核对两者产出后批准继续汇总（可在补充输入中给出修改意见），或拒绝终止。"
      }
    },
    {
      "id": "merger",
      "type": "agent",
      "name": "汇总（强模型）",
      "position": { "x": 1040, "y": 260 },
      "timeoutMs": 120000,
      "retry": { "maxAttempts": 2, "initialDelayMs": 500 },
      "data": {
        "provider": "aggregator",
        "model": "qwen-max",
        "prompt": "汇总以下材料输出最终结论（Markdown，先给一句话答案再给依据）。视觉侧：\n{{vision_agent.output}}\n\n检索侧：\n{{search_agent.output}}\n\n审批补充：\n{{review.output}}"
      }
    },
    {
      "id": "end",
      "type": "end",
      "name": "结束",
      "position": { "x": 1280, "y": 260 },
      "data": { "outputs": { "summary": "{{merger.output}}" } }
    }
  ],
  "edges": [
    { "id": "e1", "source": "start", "target": "planner" },
    { "id": "e2", "source": "planner", "target": "vision_agent" },
    { "id": "e3", "source": "planner", "target": "search_agent" },
    { "id": "e4", "source": "vision_agent", "target": "review" },
    { "id": "e5", "source": "search_agent", "target": "review" },
    { "id": "e6", "source": "review", "target": "merger" },
    { "id": "e7", "source": "merger", "target": "end" }
  ]
}
```

`demo/workflows/research.json`：

```json
{
  "schemaVersion": 1,
  "name": "深度研究（Loop 多轮检索）",
  "description": "LLM 生成问题清单 → Loop 子图逐题检索（search Server）→ 交叉汇总 → report Server 生成报告。需配置 aggregator Provider 并连接 search/report Server。",
  "nodes": [
    { "id": "start", "type": "start", "name": "开始", "position": { "x": 40, "y": 240 }, "data": {} },
    {
      "id": "questions",
      "type": "llm",
      "name": "生成研究问题",
      "position": { "x": 250, "y": 240 },
      "timeoutMs": 60000,
      "retry": { "maxAttempts": 2, "initialDelayMs": 500 },
      "data": {
        "provider": "aggregator",
        "model": "deepseek-chat",
        "prompt": "针对主题生成 3 个可检索的研究问题。只输出严格 JSON：{\"list\": [\"问题1\", \"问题2\", \"问题3\"]}\n主题：{{input.topic}}"
      }
    },
    {
      "id": "research",
      "type": "loop",
      "name": "逐题检索",
      "position": { "x": 470, "y": 240 },
      "timeoutMs": 300000,
      "data": {
        "maxIterations": 5,
        "collection": "{{questions.output.list}}",
        "itemVariable": "question",
        "subgraph": {
          "nodes": [
            {
              "id": "lookup",
              "type": "agent",
              "name": "检索",
              "position": { "x": 0, "y": 0 },
              "data": {
                "provider": "aggregator",
                "model": "deepseek-chat",
                "maxIterations": 3,
                "tools": [{ "server": "search", "tool": "web_search" }],
                "prompt": "围绕问题检索并给出 3 条带来源的要点。问题：{{loop.item}}"
              }
            }
          ],
          "edges": []
        }
      }
    },
    {
      "id": "summarize",
      "type": "llm",
      "name": "交叉汇总",
      "position": { "x": 690, "y": 240 },
      "timeoutMs": 120000,
      "retry": { "maxAttempts": 2, "initialDelayMs": 500 },
      "data": {
        "provider": "aggregator",
        "model": "qwen-max",
        "prompt": "交叉验证并汇总以下逐题检索结果，输出 Markdown 要点：\n{{research.output}}"
      }
    },
    {
      "id": "report",
      "type": "tool",
      "name": "生成报告",
      "position": { "x": 910, "y": 240 },
      "data": {
        "server": "report",
        "tool": "generate_report",
        "args": {
          "title": "深度研究报告",
          "metadata": { "主题": "{{input.topic}}" },
          "sections": [
            { "heading": "核心结论", "body": "{{summarize.output}}" },
            { "heading": "检索记录", "body": "{{research.output}}" }
          ]
        }
      }
    },
    {
      "id": "end",
      "type": "end",
      "name": "结束",
      "position": { "x": 1140, "y": 240 },
      "data": { "outputs": { "report": "{{report.output}}" } }
    }
  ],
  "edges": [
    { "id": "e1", "source": "start", "target": "questions" },
    { "id": "e2", "source": "questions", "target": "research" },
    { "id": "e3", "source": "research", "target": "summarize" },
    { "id": "e4", "source": "summarize", "target": "report" },
    { "id": "e5", "source": "report", "target": "end" }
  ]
}
```

`demo/workflows/review.json`：

```json
{
  "schemaVersion": 1,
  "name": "代码审查（条件 + 人工审批）",
  "description": "LLM 分析 diff 产出风险分 → 条件分支：高风险转 Human 审批，低风险自动通过。只需配置一个 Provider（openai）。",
  "nodes": [
    { "id": "start", "type": "start", "name": "开始", "position": { "x": 40, "y": 240 }, "data": {} },
    {
      "id": "analyze",
      "type": "llm",
      "name": "风险分析",
      "position": { "x": 250, "y": 240 },
      "timeoutMs": 60000,
      "retry": { "maxAttempts": 2, "initialDelayMs": 500 },
      "data": {
        "provider": "openai",
        "model": "gpt-4o-mini",
        "prompt": "审查以下代码 diff，只输出严格 JSON：{\"risk\": 0到10的整数, \"comment\": \"一句话结论\"}\n{{input.diff}}"
      }
    },
    {
      "id": "gate",
      "type": "condition",
      "name": "风险分级",
      "position": { "x": 470, "y": 240 },
      "data": {
        "branches": [
          { "id": "severe", "label": "高风险", "expression": "analyze.output.risk >= 7" },
          { "id": "auto", "label": "自动通过", "expression": "true" }
        ]
      }
    },
    {
      "id": "human_review",
      "type": "human",
      "name": "人工审批",
      "position": { "x": 690, "y": 120 },
      "data": {
        "prompt": "高风险变更：请在事件时间轴中核对 analyze 节点的风险结论后批准放行（补充输入可写放行理由），或拒绝。"
      }
    },
    {
      "id": "severe_result",
      "type": "transform",
      "name": "人工结论",
      "position": { "x": 910, "y": 120 },
      "data": {
        "template": { "decision": "人工审批放行", "comment": "{{analyze.output.comment}}" }
      }
    },
    {
      "id": "auto_result",
      "type": "transform",
      "name": "自动结论",
      "position": { "x": 910, "y": 360 },
      "data": {
        "template": { "decision": "自动通过", "comment": "{{analyze.output.comment}}" }
      }
    },
    { "id": "end", "type": "end", "name": "结束", "position": { "x": 1140, "y": 240 }, "data": {} }
  ],
  "edges": [
    { "id": "e1", "source": "start", "target": "analyze" },
    { "id": "e2", "source": "analyze", "target": "gate" },
    { "id": "e3", "source": "gate", "target": "human_review", "sourceHandle": "severe" },
    { "id": "e4", "source": "human_review", "target": "severe_result" },
    { "id": "e5", "source": "gate", "target": "auto_result", "sourceHandle": "auto" },
    { "id": "e6", "source": "severe_result", "target": "end" },
    { "id": "e7", "source": "auto_result", "target": "end" }
  ]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `corepack pnpm --filter @flowagent/demo exec vitest run`
Expected: PASS（5 个用例）。

- [ ] **Step 5: lint + 提交**

```bash
corepack pnpm lint
git add pnpm-workspace.yaml demo pnpm-lock.yaml
git commit -m "feat: 三个示例工作流资产（旗舰协作/深度研究/代码审查）与 shared 校验单测"
```

---

### Task 2: seed.mjs 导入脚本与根脚本接线

**Files:**
- Create: `demo/seed.mjs`
- Modify: `package.json`（根，scripts 增加 seed:demos）

**Interfaces:**
- Consumes: Task 1 的 `demo/workflows/*.json`；既有 REST `GET /api/workflows` / `POST /api/workflows {name, description, definition}`。
- Produces: `pnpm seed:demos` 命令；按 name 幂等（已存在跳过）。

- [ ] **Step 1: 写 seed.mjs**

```js
#!/usr/bin/env node
/**
 * demo 工作流导入脚本：读取 demo/workflows/*.json，按名称幂等导入到 FlowAgent server。
 * 用法：先启动 server（pnpm dev），再 pnpm seed:demos；可用 FLOWAGENT_URL 覆盖地址。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = (process.env.FLOWAGENT_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const WORKFLOWS_DIR = fileURLToPath(new URL('./workflows/', import.meta.url));

async function api(path, init) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(`${path} HTTP ${response.status}: ${body?.message ?? ''}`);
  }
  return response.status === 204 ? null : response.json();
}

async function main() {
  const files = (await readdir(WORKFLOWS_DIR)).filter((file) => file.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`未找到 demo 工作流: ${WORKFLOWS_DIR}`);

  const existing = await api('/api/workflows');
  const existingNames = new Set(existing.map((workflow) => workflow.name));

  let created = 0;
  let skipped = 0;
  for (const file of files) {
    const definition = JSON.parse(await readFile(join(WORKFLOWS_DIR, file), 'utf-8'));
    if (typeof definition.name !== 'string' || definition.name.length === 0) {
      throw new Error(`${file} 缺少 name`);
    }
    if (existingNames.has(definition.name)) {
      console.log(`跳过（已存在）: ${definition.name}`);
      skipped += 1;
      continue;
    }
    await api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: definition.name,
        description: definition.description ?? null,
        definition,
      }),
    });
    console.log(`已导入: ${definition.name}`);
    created += 1;
  }
  console.log(`完成：导入 ${created} 个，跳过 ${skipped} 个（FlowAgent: ${BASE_URL}）`);
}

main().catch((error) => {
  console.error('seed 失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
```

- [ ] **Step 2: 根 package.json 接线**

在根 `package.json` 的 `scripts` 中（`mcp:serve` 之后）加入：

```json
"seed:demos": "pnpm --filter @flowagent/demo seed"
```

- [ ] **Step 3: 语法与目录自检**

Run: `node --check demo/seed.mjs && corepack pnpm --filter @flowagent/demo exec vitest run && corepack pnpm lint`
Expected: 语法零错误；demo 测试仍全 PASS；lint 零报错。（脚本行为在 Task 4 冒烟验证。）

- [ ] **Step 4: 提交**

```bash
git add demo/seed.mjs package.json
git commit -m "feat: demo 工作流一键导入脚本（按名称幂等）与 seed:demos 接线"
```

---

### Task 3: 编辑器导入/导出与工作流列表删除

**Files:**
- Create: `apps/web/src/workflow/import.ts`
- Test: `apps/web/test/import.test.ts`
- Modify: `apps/web/src/api/workflows.ts`（追加 remove 方法）
- Modify: `apps/web/src/pages/WorkflowEditorPage.tsx`（header 加导入/导出）
- Modify: `apps/web/src/App.tsx`（列表项加删除按钮）

**Interfaces:**
- Consumes: `@flowagent/shared` 的 `validateWorkflowDefinition` / `WorkflowDefinition`；编辑器既有 `definitionToFlow`；服务端既有 `DELETE /api/workflows/:id`。
- Produces:
  - `parseImportedWorkflow(raw: string): { ok: true; value: { name: string; definition: WorkflowDefinition } } | { ok: false; error: string }`
  - `exportFileName(name: string): string`
  - `workflowsApi.remove(workflowId: string): Promise<void>`

- [ ] **Step 1: 写失败测试**

`apps/web/test/import.test.ts`：

```ts
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
```

Run: `corepack pnpm --filter @flowagent/web exec vitest run test/import.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 2: 实现 import.ts**

```ts
/** 工作流 JSON 导入/导出的纯逻辑（解析、校验、文件名净化），供编辑器 UI 调用 */
import { validateWorkflowDefinition, type WorkflowDefinition } from '@flowagent/shared';

export interface ImportedWorkflow {
  name: string;
  definition: WorkflowDefinition;
}

export type ImportResult =
  | { ok: true; value: ImportedWorkflow }
  | { ok: false; error: string };

/** 解析导入的 JSON 文本；非法 JSON 或定义校验失败时返回可展示的错误 */
export function parseImportedWorkflow(raw: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件' };
  }
  const result = validateWorkflowDefinition(parsed);
  if (!result.valid) {
    return { ok: false, error: `工作流定义校验失败：${result.errors.slice(0, 3).join('；')}` };
  }
  const definition = parsed as WorkflowDefinition;
  return {
    ok: true,
    value: { name: definition.name?.trim() || '导入的工作流', definition },
  };
}

/** 导出文件名：替换文件系统非法字符，空名称回退 workflow */
export function exportFileName(name: string): string {
  const sanitized = name.trim().replace(/[\\/:*?"<>|]/g, '_');
  return `${sanitized || 'workflow'}.json`;
}
```

Run: `corepack pnpm --filter @flowagent/web exec vitest run test/import.test.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 3: api/workflows.ts 追加 remove**

在 `apps/web/src/api/workflows.ts` 的 `workflowsApi` 对象内（既有方法之后）追加：

```ts
  remove: (workflowId: string) => request<void>(`/api/workflows/${workflowId}`, { method: 'DELETE' }),
```

（若该文件的 request 助手签名与 `api/runs.ts` 不同，以文件内既有写法为准保持一致。）

- [ ] **Step 4: 编辑器 header 加导入/导出**

在 `apps/web/src/pages/WorkflowEditorPage.tsx` 的 `EditorCanvas` 内：

4a. import 区追加：

```ts
import { exportFileName, parseImportedWorkflow } from '../workflow/import';
```

并给组件加一个隐藏 file input 的 ref（在 `const { screenToFlowPosition } = useReactFlow();` 之后）：

```ts
  const fileInputRef = useRef<HTMLInputElement>(null);
```

（`useRef` 已在既有 react import 中。）在 `handleSave` 之后追加两个处理函数：

```ts
  function handleImportFile(file: File) {
    void file
      .text()
      .then((raw) => {
        const result = parseImportedWorkflow(raw);
        if (!result.ok) {
          setErrors([result.error]);
          return;
        }
        setErrors([]);
        setSaved(null);
        setRecord(null);
        setName(result.value.name);
        const flow = definitionToFlow(result.value.definition);
        setNodes(flow.nodes);
        setEdges(flow.edges);
      })
      .catch((cause: unknown) =>
        setErrors([cause instanceof Error ? cause.message : String(cause)]),
      );
  }

  function handleExport() {
    const payload = JSON.stringify({ ...definition, name }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exportFileName(name);
    anchor.click();
    URL.revokeObjectURL(url);
  }
```

4b. header 中「保存」按钮之前插入两个按钮与隐藏 input（插在 `{record && <span ...>v{record.version}</span>}` 之后）：

```tsx
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) handleImportFile(file);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100"
        >
          导入 JSON
        </button>
        <button
          type="button"
          onClick={handleExport}
          className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100"
        >
          导出 JSON
        </button>
```

- [ ] **Step 5: 列表项加删除按钮**

在 `apps/web/src/App.tsx`：

5a. 在 `handleRun` 函数之后追加：

```ts
  async function handleDelete(workflow: WorkflowRecord) {
    if (!window.confirm(`删除工作流「${workflow.name}」？此操作不可恢复。`)) return;
    try {
      await workflowsApi.remove(workflow.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
```

5b. 把 `<ul>` 里的 `<li key={workflow.id}>` 内容替换为「主按钮 + 删除按钮」结构：

```tsx
            {workflows.map((workflow) => (
              <li key={workflow.id} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage({ kind: 'editor', workflowId: workflow.id })}
                  className="flex flex-1 items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3 text-left transition-colors hover:border-neutral-400"
                >
                  <span className="text-sm font-medium">{workflow.name}</span>
                  <span className="text-xs text-neutral-400">v{workflow.version}</span>
                  <span className="ml-auto text-xs text-neutral-400">
                    {new Date(workflow.updatedAt).toLocaleString('zh-CN')}
                  </span>
                </button>
                <button
                  type="button"
                  title="删除工作流"
                  onClick={() => void handleDelete(workflow)}
                  className="rounded-lg border border-neutral-200 bg-white px-3 py-3 text-sm text-neutral-400 transition-colors hover:border-red-300 hover:text-red-600"
                >
                  删除
                </button>
              </li>
            ))}
```

- [ ] **Step 6: 全套验证**

Run: `corepack pnpm --filter @flowagent/web exec vitest run && corepack pnpm --filter @flowagent/web run build && corepack pnpm lint`
Expected: web 测试全 PASS（含新 6 例）；构建零错误；lint 零报错。

- [ ] **Step 7: 提交**

```bash
git add apps/web
git commit -m "feat: 编辑器导入/导出工作流 JSON 与列表删除"
```

---

### Task 4: README 示例工作流实操指引 + 冒烟 + 全量门禁

**Files:**
- Modify: `README.md`（「示例工作流」节整体替换）
- Modify: `docs/PROJECT_PLAN.md` §11（追加一行）

**Interfaces:** 无代码接口；产出文档、seed 冒烟证据、全量门禁绿。

- [ ] **Step 1: README「示例工作流」节替换**

将 README 中现有「## 示例工作流」整节（表格 + 其后无关节之间的内容）替换为：

```markdown
## 示例工作流

三个开箱即用的 demo（`demo/workflows/`）：

| Demo | 展示能力 | 依赖 |
|------|----------|------|
| 旗舰·多模型协作流水线 | 廉价模型规划 → 视觉/搜索 Agent 并行 → Human 审查 → 强模型汇总 | openai + aggregator 两个 Provider；search Server |
| 深度研究 | Loop 多轮检索 + 交叉汇总 + 报告生成 | aggregator Provider；search/report Server |
| 代码审查 | 条件分支 + 高风险转人工审批 | 任一 Provider（默认 openai） |

一条命令导入（需 server 已启动）：

```bash
pnpm seed:demos        # 按名称幂等，重复执行只跳过不覆盖
```

或在画布编辑器里用「导入 JSON」按钮导入 `demo/workflows/*.json`，「导出 JSON」可把当前画布存为文件分享。

首次运行前：`.env` 按示例配置 Provider（聚合平台一把 key 即可），在 MCP Servers 页连接 search/sandbox/report（命令见 `.env.example`）。
```

- [ ] **Step 2: PROJECT_PLAN §11 追加**

表格末尾追加：

```markdown
| —（版本不变） | 2026-08-22 | 第 9 周收尾：demo/ 三个示例工作流资产（旗舰多模型协作/深度研究/代码审查）、seed:demos 一键导入、编辑器导入导出与列表删除（§8 旗舰/辅助 Demo 落地） |
```

- [ ] **Step 3: seed 端到端冒烟（真实 server）**

```bash
corepack pnpm --filter @flowagent/server exec node dist/main.js &
sleep 6
corepack pnpm seed:demos
corepack pnpm seed:demos
curl -s http://localhost:3000/api/workflows | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const ws=JSON.parse(d);console.log('workflows:',ws.map(w=>w.name).join(' | '))})"
# 结束后按 PID 杀掉 server（netstat -ano | grep ':3000' → taskkill //PID <pid> //F）
```

Expected: 第一次 seed 输出「已导入」×3；第二次输出「跳过（已存在）」×3（幂等）；curl 列出三个工作流名。

- [ ] **Step 4: 全量门禁**

Run: `corepack pnpm test && corepack pnpm lint && corepack pnpm build`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add README.md docs/PROJECT_PLAN.md
git commit -m "docs: 示例工作流实操指引与第 9 周收尾变更记录"
```

---

## Self-Review 记录

- **Spec 覆盖**：PROJECT_PLAN §8 旗舰 Demo（多模型协作流水线）→ flagship.json；辅助 Demo 深度研究（Loop + 工具编排 + 引用溯源→format_citations 未用，检索要点经 web_search 来源呈现）→ research.json；代码审查（条件 + Human 审批）→ review.json；第 9 周「UI 打磨」→ Task 3 导入/导出/删除；README 演示 → Task 4。`format_citations` 工具未进 demo（引用已在检索要点中带来源），留给用户自行组合——非缺口。
- **占位符扫描**：无 TBD/TODO；全部代码/JSON/文档原文给出。
- **类型一致性**：`parseImportedWorkflow`/`exportFileName` 签名在 Task 3 测试、实现、编辑器消费三处一致；`workflowsApi.remove` 与 App.tsx 调用一致；demo JSON 的节点 data 形状对齐 AgentNodeData/LlmNodeData/ToolNodeData/ConditionNodeData/HumanNodeData/TransformNodeData/LoopNodeData（含 subgraph）。

# Workflow→MCP Bridge 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 FlowAgent 已保存的工作流反向暴露为 MCP Server，供 Claude Code / Codex 等作为工具调用（PROJECT_PLAN 第 9 周「Demo 与 Bridge」的 Bridge 部分）。

**Architecture:** 新增独立进程包 `apps/bridge`（@flowagent/bridge），通过 stdio（默认，供宿主 Agent 拉起）或 Streamable HTTP 暴露 MCP 工具；对内只经 REST API（`http://localhost:3000`，可用 `FLOWAGENT_URL` 覆盖）与 FlowAgent server 通信，零 Nest 耦合。工具面：3 个通用工具（列出/运行/查询）+ 每个工作流一个动态工具（启动时同步，`flowagent_refresh_tools` 增量同步并广播 list_changed）。长耗时语义 = runId 即持久句柄 + `flowagent_get_run` 轮询（durable execution 保证句柄跨进程存活）。

**Tech Stack:** TypeScript strict（NodeNext）、@modelcontextprotocol/sdk 1.30.0、zod 4、vitest、pnpm workspace + Turborepo。

**Spec:** docs/PROJECT_PLAN.md §3.4（Workflow→MCP Bridge）、§8 第 9 周行、AGENTS.md（技术约束/代码风格/安全）。

## Global Constraints

- 全 TypeScript strict；禁止 `any`（逃逸用 `unknown` + 收窄）。
- 只用 pnpm（本机 Git Bash 无全局 pnpm 时用 `corepack pnpm`）；不引入 npm/yarn lockfile。
- MCP 只用 `@modelcontextprotocol/sdk`；新包不 import 厂商 LLM SDK。
- 共享类型只从 `@flowagent/shared` import（RunSummary 等）。
- 提交信息：Conventional Commits + 中文描述（`feat:` / `test:` / `docs:` / `chore:`）。
- 文件命名 camelCase；不写无关注释；公共 API 用 TSDoc。
- 每个任务结束跑 `corepack pnpm lint`（根 eslint 覆盖全仓）必须零报错。
- 测试命令在仓库根 F:/Project/FlowAgent 下的 Git Bash 执行。
- REST 契约（已存在，勿改动）：`GET /api/workflows` → `WorkflowListItem[]`；`POST /api/workflows/:id/runs` body `{input}` → `{runId}`；`GET /api/runs/:id` → `RunSummary`（含 `status`/`output`/`error`/`waitingHuman`）。
- 终态判定：`completed` / `failed` / `canceled`（与 apps/server `isTerminalRunStatus` 一致）。

## 背景勘察结论（执行者必读）

- 参考实现：`servers/search/` 是现成的 demo MCP Server（setup.ts 工具注册 / http.ts Streamable HTTP 有状态会话 / index.ts stdio|http 双模式）。bridge 直接沿用该结构，但 http.ts 需改为接收「server 工厂」参数（每个会话一个 McpServer 实例，各自持有工具注册表）。
- SDK 关键 API（已验证存在于 1.30.0）：
  - `McpServer#registerTool(name, {title, description, inputSchema: ZodRawShape}, cb)`（servers/search/src/setup.ts 即此用法）；返回 `RegisteredTool`，有 `enable()/disable()`，disable 后从 tools/list 消失。
  - `McpServer#sendToolListChanged()` 通知客户端重拉工具列表。
  - `InMemoryTransport.createLinkedPair()`（`@modelcontextprotocol/sdk/inMemory.js`）+ `Client`（`client/index.js`）做进程内集成测试。
- SDK 1.30.0 带**实验性** Tasks 扩展（`server.experimental.tasks.registerToolTask`）。本计划 v0.1 **不使用**：宿主（Claude Code 等）当前只走普通 callTool，且 experimental API 不稳定。「持久句柄 + 轮询」语义由 runId（事件溯源天然持久）+ `flowagent_get_run` 达成；PROJECT_PLAN §3.4 措辞在 Task 5 同步修正（先改文档再偏离，见 AGENTS.md）。
- MCP 工具名字符集：严格客户端要求 `^[a-zA-Z0-9_-]{1,64}$`，**不允许冒号**——故工具名用 `flowagent_run_<workflowId>`（下划线），不是 PROJECT_PLAN 原文的 `flowagent_run:<id>`。cuid 为纯字母数字，`flowagent_run_` + 25 字符 = 39 ≤ 64，合法。
- zod v4 的 `z.record` 必须两参：`z.record(z.string(), z.unknown())`。
- workspace 包加入后需 `corepack pnpm install` 生成 symlink；turbo `test` 任务 dependsOn `build`，shared 的 dist 会先构建。

---

### Task 0: 提交第 8 周遗留变更（前置，保证干净基线）

**Files:** 无新增；仅 git 操作。当前工作区有 11 个修改 + 7 个未跟踪路径（第 8 周持久化执行产物，已全量验证）。

**Interfaces:** 无（后续任务从干净 main 开始）。

- [ ] **Step 1: 确认变更清单与预期一致**

Run: `git status --short`
Expected: 修改含 `apps/server/src/engine/scheduler.ts`、`apps/server/src/runs/runs.service.ts`、`apps/web/src/pages/RunDetailPage.tsx` 等；未跟踪含 `apps/server/prisma/migrations/20260822045517_add_run_definition_snapshot/`、`apps/server/src/engine/run-control.controller.ts`、`apps/server/test/{resume,retry,pause,crash}.test.ts`、`apps/server/test/engine-harness.ts`、`apps/web/src/runs/`。

- [ ] **Step 2: 分三段提交（引擎+数据 / 前端 / 文档）**

```bash
git add apps/server/prisma apps/server/src/engine apps/server/src/runs apps/server/test
git commit -m "feat: 持久化执行——投影驱动可续调度器、三路径恢复 API、节点超时重试"
git add apps/web
git commit -m "feat: 运行详情页操作栏与回放时间轴"
git add HANDOVER.md README.md docs package.json pnpm-lock.yaml
git commit -m "docs: 第 8 周持久化执行落地同步"
git status --short
```

Expected: 最后一条 `git status --short` 输出为空（`apps/server/.env` 已被 .gitignore 忽略，不会出现）。

---

### Task 1: bridge 包骨架 + REST 客户端

**Files:**
- Create: `apps/bridge/package.json`
- Create: `apps/bridge/tsconfig.json`
- Create: `apps/bridge/src/flowagent-client.ts`
- Test: `apps/bridge/test/flowagent-client.test.ts`

**Interfaces:**
- Consumes: `@flowagent/shared` 的 `RunSummary`。
- Produces（后续任务依赖的精确签名）:
  - `interface WorkflowListItem { id: string; name: string; description: string | null; version: number }`
  - `interface FlowAgentApi { listWorkflows(): Promise<WorkflowListItem[]>; startRun(workflowId: string, input: unknown): Promise<string>; getRun(runId: string): Promise<RunSummary> }`
  - `class FlowAgentClient implements FlowAgentApi`，构造 `new FlowAgentClient(baseUrl: string, fetchImpl: typeof fetch)`
  - `function isTerminalRunStatus(status: string): boolean`
  - `function sleep(ms: number): Promise<void>`

- [ ] **Step 1: 建包骨架（package.json / tsconfig.json）**

`apps/bridge/package.json`：

```json
{
  "name": "@flowagent/bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "node dist/index.js",
    "start:http": "node dist/index.js --http --port 3200"
  },
  "dependencies": {
    "@flowagent/shared": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.30.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "vitest": "^2.1.8"
  }
}
```

`apps/bridge/tsconfig.json`（与 servers/search 相同）：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "nodenext",
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 2: 安装 workspace 链接**

Run: `corepack pnpm install`
Expected: 输出含 `+ @flowagent/bridge`，无 peer 冲突错误。

- [ ] **Step 3: 写失败测试**

`apps/bridge/test/flowagent-client.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { FlowAgentClient, isTerminalRunStatus } from '../src/flowagent-client.js';

/** 路由表 stub：path → 静态 JSON 或 (init) => JSON */
function makeFetch(routes: Record<string, unknown | ((init?: RequestInit) => unknown)>): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const handler = Object.entries(routes).find(([pattern]) => path === pattern)?.[1];
    if (handler === undefined) {
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }
    const body = typeof handler === 'function' ? handler(init) : handler;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe('FlowAgentClient', () => {
  it('listWorkflows 命中 /api/workflows 并解析列表', async () => {
    const client = new FlowAgentClient(
      'http://fa.test/',
      makeFetch({
        '/api/workflows': [
          { id: 'wf_1', name: '审查流', description: null, version: 3 },
        ],
      }),
    );
    const workflows = await client.listWorkflows();
    expect(workflows).toEqual([{ id: 'wf_1', name: '审查流', description: null, version: 3 }]);
  });

  it('startRun 发送 POST + JSON body 并返回 runId', async () => {
    let captured: RequestInit | undefined;
    const client = new FlowAgentClient(
      'http://fa.test',
      makeFetch({
        '/api/workflows/wf_1/runs': (init) => {
          captured = init;
          return { runId: 'run_9' };
        },
      }),
    );
    const runId = await client.startRun('wf_1', { score: 1 });
    expect(runId).toBe('run_9');
    expect(captured?.method).toBe('POST');
    expect(JSON.parse(String(captured?.body))).toEqual({ input: { score: 1 } });
  });

  it('非 2xx 抛错并携带服务端 message', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: '运行不存在: x' }), { status: 404 })) as typeof fetch;
    const client = new FlowAgentClient('http://fa.test', fetchImpl);
    await expect(client.getRun('x')).rejects.toThrow(/运行不存在: x/);
  });

  it('isTerminalRunStatus 三终态', () => {
    expect(isTerminalRunStatus('completed')).toBe(true);
    expect(isTerminalRunStatus('failed')).toBe(true);
    expect(isTerminalRunStatus('canceled')).toBe(true);
    expect(isTerminalRunStatus('running')).toBe(false);
    expect(isTerminalRunStatus('waiting_human')).toBe(false);
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `corepack pnpm --filter @flowagent/bridge exec vitest run`
Expected: FAIL——`Cannot find module '../src/flowagent-client.js'`。

- [ ] **Step 5: 实现 flowagent-client.ts**

```ts
/**
 * FlowAgent REST API 客户端：bridge 与服务端唯一的耦合面。
 * baseUrl 指向 FlowAgent server（默认 http://localhost:3000，可用 FLOWAGENT_URL 覆盖）。
 */
import type { RunSummary } from '@flowagent/shared';

export interface WorkflowListItem {
  id: string;
  name: string;
  description: string | null;
  version: number;
}

/** bridge 所需的最小 API 面（测试以内存实现替换） */
export interface FlowAgentApi {
  listWorkflows(): Promise<WorkflowListItem[]>;
  /** 启动一次运行，返回持久句柄 runId */
  startRun(workflowId: string, input: unknown): Promise<string>;
  getRun(runId: string): Promise<RunSummary>;
}

const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'canceled'] as const;

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FlowAgentClient implements FlowAgentApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  async listWorkflows(): Promise<WorkflowListItem[]> {
    return this.request<WorkflowListItem[]>('/api/workflows');
  }

  async startRun(workflowId: string, input: unknown): Promise<string> {
    const result = await this.request<{ runId: string }>(`/api/workflows/${workflowId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ input: input ?? null }),
    });
    return result.runId;
  }

  async getRun(runId: string): Promise<RunSummary> {
    return this.request<RunSummary>(`/api/runs/${runId}`);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(`FlowAgent API ${path} 失败(HTTP ${response.status}): ${body?.message ?? ''}`);
    }
    return (await response.json()) as T;
  }
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `corepack pnpm --filter @flowagent/bridge exec vitest run`
Expected: PASS（4 个用例）。

- [ ] **Step 7: lint + 提交**

```bash
corepack pnpm lint
git add apps/bridge pnpm-lock.yaml
git commit -m "feat: bridge 包骨架与 FlowAgent REST 客户端"
```

Expected: lint 零报错；提交成功。

---

### Task 2: 工具描述符纯函数

**Files:**
- Create: `apps/bridge/src/tool-descriptors.ts`
- Test: `apps/bridge/test/tool-descriptors.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `WorkflowListItem`。
- Produces:
  - `function workflowToolName(workflowId: string): string`（返回 `flowagent_run_<id>`）
  - `function isEligibleWorkflowToolName(name: string): boolean`（`/^[a-zA-Z0-9_-]{1,64}$/`）
  - `interface WorkflowToolDescriptor { name: string; title: string; description: string }`
  - `function describeWorkflowTool(workflow: WorkflowListItem): WorkflowToolDescriptor`
  - `function diffToolNames(current: string[], next: string[]): { toAdd: string[]; toRemove: string[] }`

- [ ] **Step 1: 写失败测试**

`apps/bridge/test/tool-descriptors.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack pnpm --filter @flowagent/bridge exec vitest run test/tool-descriptors.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 tool-descriptors.ts**

```ts
/** 工作流 → MCP 工具描述符映射（纯函数，无副作用）。 */
import type { WorkflowListItem } from './flowagent-client.js';

/** MCP 工具名兼容字符集（Claude Code 等严格客户端）：字母数字下划线连字符，≤64 */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function workflowToolName(workflowId: string): string {
  return `flowagent_run_${workflowId}`;
}

export function isEligibleWorkflowToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}

export interface WorkflowToolDescriptor {
  name: string;
  title: string;
  description: string;
}

export function describeWorkflowTool(workflow: WorkflowListItem): WorkflowToolDescriptor {
  const lines: string[] = [`运行 FlowAgent 工作流「${workflow.name}」(v${workflow.version})。`];
  if (workflow.description) lines.push(workflow.description);
  lines.push('入参 input 为 Start 节点输入；返回 { runId, status, output?, error? }。');
  lines.push('waitMs=0 时立即返回持久句柄 runId，之后用 flowagent_get_run 轮询结果。');
  return {
    name: workflowToolName(workflow.id),
    title: workflow.name,
    description: lines.join('\n'),
  };
}

export function diffToolNames(
  current: string[],
  next: string[],
): { toAdd: string[]; toRemove: string[] } {
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  return {
    toAdd: next.filter((name) => !currentSet.has(name)),
    toRemove: current.filter((name) => !nextSet.has(name)),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `corepack pnpm --filter @flowagent/bridge exec vitest run`
Expected: PASS（Task 1 + Task 2 全部用例）。

- [ ] **Step 5: lint + 提交**

```bash
corepack pnpm lint
git add apps/bridge
git commit -m "feat: bridge 工具描述符与命名净化纯函数"
```

---

### Task 3: bridge MCP Server（工具注册、运行轮询、动态同步、双传输入口）

**Files:**
- Create: `apps/bridge/src/bridge-server.ts`
- Create: `apps/bridge/src/http.ts`
- Create: `apps/bridge/src/index.ts`
- Test: `apps/bridge/test/bridge-server.test.ts`

**Interfaces:**
- Consumes: Task 1 `FlowAgentApi` / `isTerminalRunStatus` / `sleep`；Task 2 描述符函数。
- Produces:
  - `interface BridgeServerOptions { pollIntervalMs?: number; defaultWaitMs?: number }`
  - `function createBridgeServer(api: FlowAgentApi, options?: BridgeServerOptions): Promise<McpServer>`（异步：await 首次工具同步；API 不可达时记 stderr 不抛错，返回可用的 server）
  - 工具清单（name → 语义）：
    - `flowagent_list_workflows`：无入参 → `WorkflowListItem[]`
    - `flowagent_run_workflow`：`{ workflowId: string, input?: object, waitMs?: int 0..600000 }` → `{ runId, status, output?, error?, waitingHuman?, note? }`
    - `flowagent_get_run`：`{ runId: string }` → 同上结果形状
    - `flowagent_refresh_tools`：无入参 → `{ added, removed, total }`，并 `sendToolListChanged()`
    - `flowagent_run_<workflowId>`（动态）：`{ input?, waitMs? }` → 同 run 结果形状

- [ ] **Step 1: 写失败测试**

`apps/bridge/test/bridge-server.test.ts`：

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@flowagent/shared';

import type { FlowAgentApi, WorkflowListItem } from '../src/flowagent-client.js';
import { createBridgeServer } from '../src/bridge-server.js';

function makeSummary(runId: string, status: string): RunSummary {
  return {
    id: runId,
    workflowId: 'wf_1',
    workflowName: '测试流',
    workflowVersion: 1,
    status,
    input: null,
    output: status === 'completed' ? { ok: true } : null,
    error: status === 'failed' ? '节点失败' : null,
    nodes: [],
    startedAt: null,
    endedAt: null,
    waitingHuman:
      status === 'waiting_human'
        ? { nodeId: 'review', nodeType: 'human', name: '人工审查', prompt: '是否放行？' }
        : null,
  };
}

/** 内存 API：nextStatuses 依次决定每次 getRun 的状态推进 */
class FakeApi implements FlowAgentApi {
  workflows: WorkflowListItem[] = [];
  runs = new Map<string, RunSummary>();
  nextStatuses: string[] = [];
  started: Array<{ workflowId: string; input: unknown }> = [];
  private seq = 0;

  async listWorkflows(): Promise<WorkflowListItem[]> {
    return this.workflows;
  }
  async startRun(workflowId: string, input: unknown): Promise<string> {
    this.started.push({ workflowId, input });
    this.seq += 1;
    const runId = `run_${this.seq}`;
    this.runs.set(runId, makeSummary(runId, 'running'));
    return runId;
  }
  async getRun(runId: string): Promise<RunSummary> {
    const status = this.nextStatuses.shift();
    if (status !== undefined) this.runs.set(runId, makeSummary(runId, status));
    return this.runs.get(runId) ?? makeSummary(runId, 'running');
  }
}

async function connect(api: FakeApi): Promise<Client> {
  const server = await createBridgeServer(api, { pollIntervalMs: 1, defaultWaitMs: 50 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'bridge-test', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('bridge-server', () => {
  it('启动同步：tools/list 含 4 个通用工具 + 每工作流工具', async () => {
    const api = new FakeApi();
    api.workflows = [{ id: 'wf1', name: '审查', description: null, version: 1 }];
    const client = await connect(api);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('flowagent_list_workflows');
    expect(names).toContain('flowagent_run_workflow');
    expect(names).toContain('flowagent_get_run');
    expect(names).toContain('flowagent_refresh_tools');
    expect(names).toContain('flowagent_run_wf1');
  });

  it('flowagent_run_workflow 阻塞等待至 completed 并回传输出', async () => {
    const api = new FakeApi();
    api.nextStatuses = ['completed'];
    const client = await connect(api);
    const outcome = await callJson(client, 'flowagent_run_workflow', {
      workflowId: 'wf1',
      input: { score: 1 },
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.output).toEqual({ ok: true });
    expect(String(outcome.runId)).toMatch(/^run_\d+$/);
    expect(api.started).toEqual([{ workflowId: 'wf1', input: { score: 1 } }]);
  });

  it('waitMs=0 立即返回持久句柄', async () => {
    const api = new FakeApi();
    const client = await connect(api);
    const outcome = await callJson(client, 'flowagent_run_workflow', {
      workflowId: 'wf1',
      waitMs: 0,
    });
    expect(outcome.status).toBe('running');
    expect(String(outcome.note)).toContain('flowagent_get_run');
  });

  it('等待超时返回当前快照并附提示', async () => {
    const api = new FakeApi();
    const client = await connect(api);
    const outcome = await callJson(client, 'flowagent_run_workflow', {
      workflowId: 'wf1',
      waitMs: 5,
    });
    expect(outcome.status).toBe('running');
    expect(String(outcome.note)).toContain('未到终态');
  });

  it('waiting_human 时透出挂起信息与审批提示', async () => {
    const api = new FakeApi();
    api.nextStatuses = ['waiting_human'];
    const client = await connect(api);
    const outcome = await callJson(client, 'flowagent_run_workflow', { workflowId: 'wf1' });
    expect(outcome.status).toBe('waiting_human');
    expect(outcome.waitingHuman).toMatchObject({ nodeId: 'review', prompt: '是否放行？' });
    expect(String(outcome.note)).toContain('人工');
  });

  it('flowagent_get_run 查询指定 run', async () => {
    const api = new FakeApi();
    const runId = await api.startRun('wf1', null);
    api.nextStatuses = ['failed'];
    const client = await connect(api);
    const outcome = await callJson(client, 'flowagent_get_run', { runId });
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('节点失败');
  });

  it('每工作流动态工具与 refresh 增量同步', async () => {
    const api = new FakeApi();
    api.workflows = [{ id: 'wf1', name: 'A', description: null, version: 1 }];
    const client = await connect(api);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('flowagent_run_wf1');

    api.workflows = [
      { id: 'wf1', name: 'A', description: null, version: 1 },
      { id: 'wf2', name: 'B', description: null, version: 1 },
    ];
    const refresh = await callJson(client, 'flowagent_refresh_tools', {});
    expect(refresh).toEqual({ added: 1, removed: 0, total: 2 });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('flowagent_run_wf2');

    api.workflows = [{ id: 'wf2', name: 'B', description: null, version: 1 }];
    const refresh2 = await callJson(client, 'flowagent_refresh_tools', {});
    expect(refresh2).toEqual({ added: 0, removed: 1, total: 1 });
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('flowagent_run_wf1');
  });

  it('动态工具可直接运行工作流', async () => {
    const api = new FakeApi();
    api.workflows = [{ id: 'wf1', name: 'A', description: null, version: 1 }];
    api.nextStatuses = ['completed'];
    const client = await connect(api);
    const outcome = await callJson(client, 'flowagent_run_wf1', { input: { x: 1 } });
    expect(outcome.status).toBe('completed');
    expect(api.started).toEqual([{ workflowId: 'wf1', input: { x: 1 } }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack pnpm --filter @flowagent/bridge exec vitest run test/bridge-server.test.ts`
Expected: FAIL——`../src/bridge-server.js` 不存在。

- [ ] **Step 3: 实现 bridge-server.ts**

```ts
/**
 * Workflow→MCP Bridge：把已保存工作流反向暴露为 MCP 工具。
 *
 * 长耗时语义：runId 即持久句柄（事件溯源保证跨进程存活），
 * waitMs=0 立即返回句柄，flowagent_get_run 轮询直至终态。
 */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpServer as McpServerCtor } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RunSummary } from '@flowagent/shared';
import { z } from 'zod';

import type { FlowAgentApi } from './flowagent-client.js';
import { isTerminalRunStatus, sleep } from './flowagent-client.js';
import {
  describeWorkflowTool,
  diffToolNames,
  isEligibleWorkflowToolName,
  workflowToolName,
} from './tool-descriptors.js';

export interface BridgeServerOptions {
  /** 运行轮询间隔毫秒（默认 1000；测试用 1） */
  pollIntervalMs?: number;
  /** 工具调用默认等待毫秒（默认 60000） */
  defaultWaitMs?: number;
}

interface RunOutcome {
  runId: string;
  status: string;
  output?: unknown;
  error?: string | null;
  waitingHuman?: { nodeId: string; name: string; prompt: string };
  note?: string;
}

function textResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function toOutcome(summary: RunSummary, note?: string): RunOutcome {
  const outcome: RunOutcome = { runId: summary.id, status: summary.status };
  if (summary.status === 'completed') outcome.output = summary.output ?? null;
  if (summary.error) outcome.error = summary.error;
  if (summary.waitingHuman) {
    outcome.waitingHuman = {
      nodeId: summary.waitingHuman.nodeId,
      name: summary.waitingHuman.name,
      prompt: summary.waitingHuman.prompt,
    };
  }
  if (note) outcome.note = note;
  return outcome;
}

async function pollUntilTerminal(
  api: FlowAgentApi,
  runId: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<RunSummary> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const summary = await api.getRun(runId);
    if (isTerminalRunStatus(summary.status)) return summary;
    if (Date.now() >= deadline) return summary;
    await sleep(intervalMs);
  }
}

export async function createBridgeServer(
  api: FlowAgentApi,
  options: BridgeServerOptions = {},
): Promise<McpServer> {
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const defaultWaitMs = options.defaultWaitMs ?? 60_000;
  const server = new McpServerCtor({ name: 'flowagent-bridge', version: '0.1.0' });

  const inputArgument = z
    .record(z.string(), z.unknown())
    .optional()
    .describe('运行输入（Start 节点输入，JSON 对象）');
  const waitArgument = z
    .number()
    .int()
    .min(0)
    .max(600_000)
    .optional()
    .describe('等待毫秒数；0 = 立即返回持久句柄 runId');

  const executeRun = async (
    workflowId: string,
    input: unknown,
    waitMs: number,
  ): Promise<RunOutcome> => {
    const runId = await api.startRun(workflowId, input);
    if (waitMs === 0) {
      return { runId, status: 'running', note: '持久句柄已返回，用 flowagent_get_run 轮询结果' };
    }
    const summary = await pollUntilTerminal(api, runId, pollIntervalMs, waitMs);
    if (!isTerminalRunStatus(summary.status)) {
      return toOutcome(summary, `等待 ${waitMs}ms 未到终态，返回当前快照；可用 flowagent_get_run 继续`);
    }
    return toOutcome(summary, summary.waitingHuman ? '等待人工审批：可在 Web 运行详情页批准/拒绝' : undefined);
  };

  server.registerTool(
    'flowagent_list_workflows',
    {
      title: '列出工作流',
      description: '列出 FlowAgent 中所有已保存工作流（id/名称/描述/版本）',
      inputSchema: {},
    },
    async () => textResult(await api.listWorkflows()),
  );

  server.registerTool(
    'flowagent_run_workflow',
    {
      title: '运行工作流',
      description: '按 id 运行工作流；waitMs>0 阻塞等待至终态或超时，waitMs=0 立即返回持久句柄 runId',
      inputSchema: {
        workflowId: z.string().describe('工作流 id（可用 flowagent_list_workflows 查询）'),
        input: inputArgument,
        waitMs: waitArgument,
      },
    },
    async ({ workflowId, input, waitMs }) =>
      textResult(await executeRun(workflowId, input ?? null, waitMs ?? defaultWaitMs)),
  );

  server.registerTool(
    'flowagent_get_run',
    {
      title: '查询运行',
      description: '按 runId 查询运行状态/输出/错误/人工挂起信息（持久句柄轮询入口）',
      inputSchema: { runId: z.string().describe('flowagent 运行 id') },
    },
    async ({ runId }) => textResult(toOutcome(await api.getRun(runId))),
  );

  // 动态工具：Map 永久持有 RegisteredTool（禁用而非注销，规避同名重复注册冲突）
  const tools = new Map<string, RegisteredTool>();

  const syncWorkflowTools = async (): Promise<{ added: number; removed: number; total: number }> => {
    const workflows = await api.listWorkflows();
    const eligible = workflows.filter((wf) => isEligibleWorkflowToolName(workflowToolName(wf.id)));
    const nextNames = eligible.map((wf) => workflowToolName(wf.id));
    const { toAdd, toRemove } = diffToolNames([...tools.keys()], nextNames);

    for (const workflow of eligible) {
      const name = workflowToolName(workflow.id);
      if (!toAdd.includes(name)) continue;
      const descriptor = describeWorkflowTool(workflow);
      const tool = server.registerTool(
        name,
        {
          title: descriptor.title,
          description: descriptor.description,
          inputSchema: { input: inputArgument, waitMs: waitArgument },
        },
        async ({ input, waitMs }) =>
          textResult(await executeRun(workflow.id, input ?? null, waitMs ?? defaultWaitMs)),
      );
      tools.set(name, tool);
    }
    for (const name of toRemove) tools.get(name)?.disable();
    for (const name of nextNames) {
      if (!toAdd.includes(name)) tools.get(name)?.enable();
    }
    if (toAdd.length > 0 || toRemove.length > 0) server.sendToolListChanged();
    return { added: toAdd.length, removed: toRemove.length, total: nextNames.length };
  };

  server.registerTool(
    'flowagent_refresh_tools',
    {
      title: '刷新工作流工具',
      description: '重新同步已保存工作流为工具（新增注册、删除下线），并通知客户端工具列表已变更',
      inputSchema: {},
    },
    async () => textResult(await syncWorkflowTools()),
  );

  // 首次同步；FlowAgent 未启动时降级为空工具集（refresh 工具仍可用）
  try {
    await syncWorkflowTools();
  } catch (error) {
    console.error('bridge 首次工作流同步失败（FlowAgent API 不可达？）:', error);
  }
  return server;
}
```

- [ ] **Step 4: 跑 bridge-server 测试确认通过**

Run: `corepack pnpm --filter @flowagent/bridge exec vitest run test/bridge-server.test.ts`
Expected: PASS（8 个用例）。若 `registerTool` 的 `inputSchema: {}` 空对象报错，改为省略该字段（两种写法 SDK 均支持，以实际编译/运行为准并保持测试通过）。

- [ ] **Step 5: 实现 http.ts（Streamable HTTP 模式，会话工厂模式）**

`apps/bridge/src/http.ts`（从 servers/search/src/http.ts 改造：createServer 参数换成 server 工厂）：

```ts
/**
 * bridge 的 HTTP（Streamable HTTP）模式。
 *
 * 有状态会话：每个新会话一个 StreamableHTTPServerTransport + 一个独立 McpServer 实例
 * （各自持有工具注册表），会话 id 由服务端生成并通过 mcp-session-id 头返回。
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

const sessions = new Map<string, StreamableHTTPServerTransport>();

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (raw.length === 0) return undefined;
  return JSON.parse(raw) as unknown;
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function handleMcpRequest(
  createBridge: () => Promise<McpServer>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const sessionId = request.headers['mcp-session-id'];
  const parsedBody = request.method === 'POST' ? await readJsonBody(request) : undefined;

  if (typeof sessionId === 'string' && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    await session.handleRequest(request, response, parsedBody);
    return;
  }
  if (typeof sessionId === 'string') {
    respondJson(response, 404, {
      jsonrpc: '2.0',
      error: { code: -32001, message: '会话不存在或已过期' },
    });
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) sessions.delete(id);
  };
  const server = await createBridge();
  await server.connect(transport);
  await transport.handleRequest(request, response, parsedBody);
  if (transport.sessionId) sessions.set(transport.sessionId, transport);
}

export function startHttpServer(createBridge: () => Promise<McpServer>, port: number): void {
  const httpServer = createHttpServer((request, response) => {
    const url = request.url ?? '/';
    if (url.split('?')[0] !== '/mcp') {
      respondJson(response, 404, { error: 'not found，MCP 端点为 /mcp' });
      return;
    }
    void handleMcpRequest(createBridge, request, response).catch((error: unknown) => {
      console.error('MCP 请求处理失败:', error);
      if (!response.headersSent) {
        respondJson(response, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'internal error' },
        });
      }
    });
  });
  httpServer.listen(port, () => {
    console.log(`flowagent-bridge HTTP MCP Server 监听 http://localhost:${port}/mcp`);
  });
}
```

- [ ] **Step 6: 实现 index.ts（stdio 默认 / --http 双模式入口）**

`apps/bridge/src/index.ts`：

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createBridgeServer } from './bridge-server.js';
import { FlowAgentClient } from './flowagent-client.js';
import { startHttpServer } from './http.js';

function parseArgs(argv: string[]): { http: boolean; port: number } {
  const http = argv.includes('--http');
  const portIndex = argv.indexOf('--port');
  const portArg = portIndex >= 0 ? argv[portIndex + 1] : undefined;
  const port = portArg !== undefined && /^\d+$/.test(portArg) ? Number(portArg) : 3200;
  return { http, port };
}

async function main(): Promise<void> {
  const { http, port } = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.FLOWAGENT_URL ?? 'http://localhost:3000';
  const api = new FlowAgentClient(baseUrl, fetch);

  if (http) {
    startHttpServer(() => createBridgeServer(api), port);
    return;
  }
  const server = await createBridgeServer(api);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error: unknown) => {
  console.error('flowagent-bridge 启动失败:', error);
  process.exit(1);
});
```

- [ ] **Step 7: 全包测试 + 构建**

Run: `corepack pnpm --filter @flowagent/bridge exec vitest run && corepack pnpm --filter @flowagent/bridge build`
Expected: 测试全 PASS；tsc 无错误，`apps/bridge/dist/index.js` 生成。

- [ ] **Step 8: lint + 提交**

```bash
corepack pnpm lint
git add apps/bridge
git commit -m "feat: Workflow→MCP Bridge——工作流反向暴露为 MCP 工具（stdio/HTTP 双传输）"
```

---

### Task 4: 根脚本接线 + 文档同步 + 端到端验证

**Files:**
- Modify: `package.json`（根，scripts 增加 mcp:serve）
- Modify: `docs/PROJECT_PLAN.md` §3.4 与 §11
- Modify: `README.md`（Workflow→MCP Bridge 使用说明）

**Interfaces:** 无代码接口；产出 `pnpm mcp:serve` 命令与文档。

- [ ] **Step 1: 根 package.json 增加 mcp:serve**

在根 `package.json` 的 `scripts` 中（`format` 之后）加入：

```json
"mcp:serve": "pnpm --filter @flowagent/bridge start"
```

- [ ] **Step 2: 更新 PROJECT_PLAN §3.4（先改文档再偏离，AGENTS.md 要求）**

将 §3.4 第二个列表项替换为：

```markdown
- 把已保存工作流暴露为 tool（`flowagent_run_<workflow_id>`，工具名受 MCP 严格客户端字符集约束用下划线）；新增工作流后客户端调 `flowagent_refresh_tools` 热同步
```

将第三个列表项替换为：

```markdown
- 长耗时工作流的持久句柄 + 轮询：runId 即跨进程持久句柄（事件溯源保证），`flowagent_get_run` 为轮询入口，`waitMs=0` 立即返回句柄。协议级 MCP Tasks 扩展待 SDK 结束 experimental 后接入（1.30.0 已有雏形）
```

§11 变更记录表追加一行：

```markdown
| —（版本不变） | 2026-08-22 | 第 9 周 Workflow→MCP Bridge 落地：apps/bridge 独立进程（stdio/Streamable HTTP），通用 + 每工作流动态工具，runId 持久句柄 + 轮询替代协议级 Tasks（SDK experimental 暂不采用） |
```

- [ ] **Step 3: README 增加 Bridge 使用节**

在「快速开始」的 Claude Code 配置块之前插入：

```markdown
### 把工作流当工具用（Workflow→MCP Bridge）

先启动 FlowAgent（`pnpm dev`），bridge 以独立进程把所有已保存工作流暴露为 MCP 工具：

```json
{ "mcpServers": { "flowagent": { "command": "pnpm", "args": ["mcp:serve"] } } }
```

可用工具：`flowagent_list_workflows` / `flowagent_run_workflow`（waitMs=0 立即返回持久句柄）/ `flowagent_get_run`（轮询）/ `flowagent_refresh_tools`（热同步新工作流）/ `flowagent_run_<workflowId>`（每个工作流一个专属工具）。
长任务不必阻塞会话：runId 跨进程持久，随时回来查询或回放。
```

- [ ] **Step 4: 端到端手动验证（真实 server + bridge + SDK Client）**

```bash
# 1. 起 server（另开终端）
corepack pnpm --filter @flowagent/server exec node dist/main.js
# 2. 确认至少有一个工作流（无则 POST /api/workflows 创建，参照 apps/bridge/test 的 wf JSON）
# 3. 起 bridge HTTP 模式
corepack pnpm --filter @flowagent/bridge start:http
# 4. 用 SDK Client 冒烟（脚本）
node --input-type=module -e "
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3200/mcp')));
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
const result = await client.callTool({ name: 'flowagent_list_workflows', arguments: {} });
console.log('workflows:', result.content[0].text);
await client.close();
"
```

Expected: `tools:` 含 4 个通用工具与至少一个 `flowagent_run_*`；`workflows:` 返回 JSON 列表。验证后停掉两个进程。

- [ ] **Step 5: 全量门禁 + 提交**

```bash
corepack pnpm test && corepack pnpm lint && corepack pnpm build
git add package.json README.md docs/PROJECT_PLAN.md
git commit -m "feat: mcp:serve 根脚本与 Bridge 文档（工具命名、Tasks 语义落地说明）"
```

Expected: 三项门禁全绿；提交成功。

---

## Self-Review 记录

- **Spec 覆盖**：§3.4「暴露为 tool」→ Task 3 动态工具 + refresh；「Tasks 模式」→ runId 句柄 + get_run 轮询实现，Task 4 同步修正文档措辞（先文档后代码，符合 AGENTS.md）；「README 演示」→ Task 4。第 9 周其余部分（demo Server 补齐、旗舰工作流、UI 打磨）属另外两个独立计划，不在本计划范围。
- **占位符扫描**：无 TBD/TODO；所有代码步骤给出完整代码。
- **类型一致性**：`FlowAgentApi` 三方法在 Task 1 定义、Task 3 FakeApi 与 executeRun 消费一致；`RunOutcome` 仅 Task 3 内部；`createBridgeServer` 返回 `Promise<McpServer>` 在 Task 3/Task 4 Step 4 使用一致。

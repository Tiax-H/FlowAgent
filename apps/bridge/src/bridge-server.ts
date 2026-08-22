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
    // waiting_human 非终态但已挂起：透出审批提示而非超时提示
    if (!isTerminalRunStatus(summary.status) && !summary.waitingHuman) {
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

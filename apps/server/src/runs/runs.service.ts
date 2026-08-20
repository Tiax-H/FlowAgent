import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { RunSummary, WorkflowEvent } from '@flowagent/shared';

import { PrismaService } from '../prisma/prisma.service';
import { EventStore } from '../engine/event-store.service';
import { emptyRunState, projectRunState } from '../engine/projection';

interface RunRow {
  id: string;
  workflowId: string;
  workflowVersion: number;
  input: string | null;
  status: string;
  output: string | null;
  error: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

@Injectable()
export class RunsService implements OnModuleInit {
  private readonly logger = new Logger(RunsService.name);
  /** 引擎注册的启动回调（避免循环依赖由 EngineModule 桥接 set） */
  private runStarter: ((runId: string, workflowId: string, input: unknown) => Promise<void>) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventStore: EventStore,
  ) {}

  onModuleInit(): void {
    // 进程重启时把孤儿 running 状态标记回投影真实值（恢复执行留第 8 周）
    void this.reconcileOrphanRuns().catch((error: unknown) => {
      this.logger.warn(`孤儿 run 状态对账失败: ${String(error)}`);
    });
  }

  setRunStarter(starter: (runId: string, workflowId: string, input: unknown) => Promise<void>): void {
    this.runStarter = starter;
  }

  /** 启动一次运行：落库 + 交给引擎执行 */
  async startRun(workflowId: string, input: unknown): Promise<string> {
    const workflow = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) throw new NotFoundException(`工作流不存在: ${workflowId}`);

    const run = await this.prisma.workflowRun.create({
      data: {
        workflowId,
        workflowVersion: workflow.version,
        input: JSON.stringify(input ?? null),
        status: 'pending',
      },
    });
    await this.eventStore.append(run.id, 1, 'RUN_STARTED', {
      workflowId,
      workflowVersion: workflow.version,
      input: input ?? null,
    });

    const inputJson = parseJson<unknown>(run.input, null);
    if (this.runStarter) {
      void this.runStarter(run.id, workflowId, inputJson).catch(() => undefined);
    }
    return run.id;
  }

  async listRuns(workflowId?: string): Promise<RunSummary[]> {
    const rows = await this.prisma.workflowRun.findMany({
      where: workflowId ? { workflowId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const workflowNames = new Map<string, string>();
    for (const row of rows) {
      if (!workflowNames.has(row.workflowId)) {
        const workflow = await this.prisma.workflow.findUnique({
          where: { id: row.workflowId },
          select: { name: true },
        });
        workflowNames.set(row.workflowId, workflow?.name ?? '(已删除)');
      }
    }
    return Promise.all(rows.map((row) => this.toSummary(row, workflowNames.get(row.workflowId) ?? '(已删除)')));
  }

  async getRun(runId: string): Promise<RunSummary> {
    const row = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!row) throw new NotFoundException(`运行不存在: ${runId}`);
    const workflow = await this.prisma.workflow.findUnique({
      where: { id: row.workflowId },
      select: { name: true },
    });
    return this.toSummary(row, workflow?.name ?? '(已删除)');
  }

  async getEvents(runId: string): Promise<WorkflowEvent[]> {
    await this.ensureRun(runId);
    return this.eventStore.readEvents(runId);
  }

  async ensureRun(runId: string): Promise<RunRow> {
    const row = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!row) throw new NotFoundException(`运行不存在: ${runId}`);
    return row;
  }

  /** 用事件投影刷新 run 的缓存字段（引擎在终止事件后调用） */
  async syncFromProjection(runId: string): Promise<void> {
    const events = await this.eventStore.readEvents(runId);
    const state = projectRunState(runId, events);
    await this.prisma.workflowRun
      .update({
        where: { id: runId },
        data: {
          status: state.status,
          output: JSON.stringify(state.output ?? null),
          error: state.error,
          startedAt: state.startedAt ? new Date(state.startedAt) : null,
          endedAt: state.endedAt ? new Date(state.endedAt) : null,
        },
      })
      .catch(() => undefined);
  }

  private async reconcileOrphanRuns(): Promise<void> {
    const orphans = await this.prisma.workflowRun.findMany({
      where: { status: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    for (const orphan of orphans) {
      await this.syncFromProjection(orphan.id);
    }
  }

  private async toSummary(row: RunRow, workflowName: string): Promise<RunSummary> {
    const events = await this.eventStore.readEvents(row.id);
    const state = events.length > 0 ? projectRunState(row.id, events) : emptyRunState(row.id);

    const nodeMetas = await this.loadNodeMetas(row.workflowId);
    const nodes = [...state.nodes.values()].map((node) => ({
      nodeId: node.nodeId,
      nodeType: nodeMetas.get(node.nodeId)?.type ?? 'unknown',
      name: nodeMetas.get(node.nodeId)?.name ?? node.nodeId,
      status: node.status,
      error: node.error,
    }));

    return {
      id: row.id,
      workflowId: row.workflowId,
      workflowName,
      workflowVersion: row.workflowVersion,
      status: state.status,
      input: parseJson<unknown>(row.input, null),
      output: state.output,
      error: state.error,
      nodes,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
    };
  }

  /** 节点元信息（type/name）缓存加载 */
  private nodeMetaCache = new Map<string, Array<{ id: string; type: string; name: string }>>();

  private async loadNodeMetas(
    workflowId: string,
  ): Promise<Map<string, { id: string; type: string; name: string }>> {
    let metas = this.nodeMetaCache.get(workflowId);
    if (!metas) {
      const workflow = await this.prisma.workflow.findUnique({
        where: { id: workflowId },
        select: { definition: true },
      });
      const definition = parseJson<{ nodes?: Array<{ id: string; type: string; name: string }> } | null>(
        workflow?.definition ?? null,
        null,
      );
      metas = definition?.nodes ?? [];
      this.nodeMetaCache.set(workflowId, metas);
    }
    return new Map(metas.map((meta) => [meta.id, meta] as const));
  }
}

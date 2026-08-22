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
  definitionSnapshot: string | null;
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
  private runStarter: ((runId: string) => Promise<void>) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventStore: EventStore,
  ) {}

  onModuleInit(): void {
    // 进程重启时对孤儿 run 追加崩溃挂起事件，恢复方式为用户手动调 resume API
    void this.reconcileOrphanRuns().catch((error: unknown) => {
      this.logger.warn(`孤儿 run 状态对账失败: ${String(error)}`);
    });
  }

  setRunStarter(starter: (runId: string) => Promise<void>): void {
    this.runStarter = starter;
  }

  /** 启动一次运行：落库（含定义快照）+ 交给引擎执行 */
  async startRun(workflowId: string, input: unknown): Promise<string> {
    const workflow = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) throw new NotFoundException(`工作流不存在: ${workflowId}`);

    const run = await this.prisma.workflowRun.create({
      data: {
        workflowId,
        workflowVersion: workflow.version,
        input: JSON.stringify(input ?? null),
        definitionSnapshot: workflow.definition,
        status: 'pending',
      },
    });
    await this.eventStore.append(run.id, 'RUN_STARTED', {
      workflowId,
      workflowVersion: workflow.version,
      input: input ?? null,
    });
    await this.syncFromProjection(run.id).catch(() => undefined);

    if (this.runStarter) {
      void this.runStarter(run.id).catch(() => undefined);
    }
    return run.id;
  }

  /**
   * 运行列表：直接读 workflow_runs 投影缓存列（syncFromProjection 维护）。
   * 列表页每 3 秒轮询，绝不能逐 run 全量回放事件（那是 O(runs × events) 的放大器）；
   * 节点级明细留给详情页（getRun）。缓存列在运行中由控制面动作刷新，
   * 状态变化粒度（running→终态）对本页足够。
   */
  async listRuns(workflowId?: string): Promise<RunSummary[]> {
    const rows = await this.prisma.workflowRun.findMany({
      where: workflowId ? { workflowId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const workflowIds = [...new Set(rows.map((row) => row.workflowId))];
    const workflows = await this.prisma.workflow.findMany({
      where: { id: { in: workflowIds } },
      select: { id: true, name: true },
    });
    const names = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
    return rows.map((row) => this.toCachedSummary(row, names.get(row.workflowId) ?? '(已删除)'));
  }

  /** 轻量状态查询（bridge 轮询用）：只读缓存列，零事件回放 */
  async getRunStatus(runId: string): Promise<{ id: string; status: string }> {
    const row = await this.ensureRun(runId);
    return { id: row.id, status: row.status };
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

  /** 用事件投影刷新 run 的缓存字段（引擎在终止事件后调用）；可传入已算好的投影省一次回放 */
  async syncFromProjection(runId: string, state?: ReturnType<typeof projectRunState>): Promise<void> {
    const projected =
      state ?? projectRunState(runId, await this.eventStore.readEvents(runId));
    await this.prisma.workflowRun
      .update({
        where: { id: runId },
        data: {
          status: projected.status,
          output: JSON.stringify(projected.output ?? null),
          error: projected.error,
          startedAt: projected.startedAt ? new Date(projected.startedAt) : null,
          endedAt: projected.endedAt ? new Date(projected.endedAt) : null,
        },
      })
      .catch(() => undefined);
  }

  /** 崩溃对账：DB 缓存为 pending/running 的孤儿 run，若事件流仍非终态则追加 RUN_SUSPENDED(crash) */
  private async reconcileOrphanRuns(): Promise<void> {
    const orphans = await this.prisma.workflowRun.findMany({
      where: { status: { in: ['pending', 'running'] } },
      select: { id: true },
    });
    for (const orphan of orphans) {
      const events = await this.eventStore.readEvents(orphan.id);
      const state = projectRunState(orphan.id, events);
      if (state.status === 'pending' || state.status === 'running') {
        // append-only 安全：waiting_human 被 fold 守卫保护，终态投影仅重同步不追加
        await this.eventStore.append(orphan.id, 'RUN_SUSPENDED', { reason: 'crash' });
      }
      await this.syncFromProjection(orphan.id, state);
    }
  }

  /** 纯缓存列摘要（列表页）：nodes 为空，节点明细见 getRun */
  private toCachedSummary(row: RunRow, workflowName: string): RunSummary {
    return {
      id: row.id,
      workflowId: row.workflowId,
      workflowName,
      workflowVersion: row.workflowVersion,
      status: row.status,
      input: parseJson<unknown>(row.input, null),
      output: parseJson<unknown>(row.output, null),
      error: row.error,
      nodes: [],
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      waitingHuman: null,
    };
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
      waitingHuman: this.resolveWaitingHuman(state, events, nodeMetas),
    };
  }

  /** waiting_human 时从最后一条 HUMAN_WAITING 事件提取挂起节点摘要 */
  private resolveWaitingHuman(
    state: ReturnType<typeof projectRunState>,
    events: WorkflowEvent[],
    nodeMetas: Map<string, { id: string; type: string; name: string }>,
  ): RunSummary['waitingHuman'] {
    if (state.status !== 'waiting_human' || !state.waitingHumanNodeId) return null;
    const nodeId = state.waitingHumanNodeId;
    let prompt = '';
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (!event) continue;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (event.type === 'HUMAN_WAITING' && payload.nodeId === nodeId) {
        prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
        break;
      }
    }
    return {
      nodeId,
      nodeType: nodeMetas.get(nodeId)?.type ?? 'unknown',
      name: nodeMetas.get(nodeId)?.name ?? nodeId,
      prompt,
    };
  }

  /** 节点元信息（type/name）缓存加载；按工作流 version 失效，编辑保存后自动刷新 */
  private nodeMetaCache = new Map<
    string,
    { version: number; metas: Array<{ id: string; type: string; name: string }> }
  >();

  private async loadNodeMetas(
    workflowId: string,
  ): Promise<Map<string, { id: string; type: string; name: string }>> {
    const workflow = await this.prisma.workflow.findUnique({
      where: { id: workflowId },
      select: { definition: true, version: true },
    });
    const cached = this.nodeMetaCache.get(workflowId);
    if (cached && cached.version === workflow?.version) {
      return new Map(cached.metas.map((meta) => [meta.id, meta] as const));
    }
    const definition = parseJson<{
      nodes?: Array<{ id: string; type: string; name: string }>;
    } | null>(workflow?.definition ?? null, null);
    const metas = definition?.nodes ?? [];
    if (workflow) this.nodeMetaCache.set(workflowId, { version: workflow.version, metas });
    return new Map(metas.map((meta) => [meta.id, meta] as const));
  }
}

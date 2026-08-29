/**
 * 运行删除（软删）回归（UX 问题 10）：
 * DELETE 语义 = 给投影缓存行打 hiddenAt 标记；事件表 append-only（禁止 UPDATE/DELETE），
 * 事件不动；已删 run 在列表中被过滤，详情/事件/状态查询一律 404。
 */
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { EventStore } from '../src/engine/event-store.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunsService, parseRunsListLimit } from '../src/runs/runs.service';
import { MemoryEventStore } from './engine-harness';

interface RunRecord {
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
  hiddenAt: Date | null;
}

function makeRun(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    workflowId: 'wf_1',
    workflowVersion: 1,
    input: null,
    definitionSnapshot: null,
    status: 'completed',
    output: null,
    error: null,
    startedAt: null,
    endedAt: null,
    createdAt: new Date(),
    hiddenAt: null,
    ...overrides,
  };
}

function makeService(runRows: RunRecord[] = [makeRun('run_a'), makeRun('run_b')]): {
  service: RunsService;
  runs: Map<string, RunRecord>;
  eventStore: MemoryEventStore;
} {
  const runs = new Map(runRows.map((row) => [row.id, row]));
  const runModel = {
    findMany: ({
      where,
      orderBy,
      take,
    }: {
      where?: { hiddenAt?: Date | null; workflowId?: string } | undefined;
      orderBy?: Record<string, 'asc' | 'desc'>;
      take?: number;
    }) => {
      let rows = [...runs.values()];
      if (where?.hiddenAt === null) rows = rows.filter((row) => row.hiddenAt === null);
      if (where?.workflowId) rows = rows.filter((row) => row.workflowId === where.workflowId);
      const direction = (orderBy && 'createdAt' in orderBy ? orderBy.createdAt : 'desc') ?? 'desc';
      rows.sort((a, b) =>
        direction === 'asc'
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime(),
      );
      if (take !== undefined) rows = rows.slice(0, take);
      return rows.map((row) => ({ ...row }));
    },
    findUnique: ({ where }: { where: { id: string } }): RunRecord | null => {
      const row = runs.get(where.id);
      return row ? { ...row } : null;
    },
    // Prisma 的 update 返回 Promise，stub 保持一致
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<RunRecord>;
    }): Promise<RunRecord> => {
      const row = runs.get(where.id);
      if (!row) throw new Error(`run not found: ${where.id}`);
      Object.assign(row, data);
      return { ...row };
    },
  };
  const workflowModel = {
    findMany: ({ where }: { where?: { id?: { in?: string[] } } | undefined }) =>
      [{ id: 'wf_1', name: '示例工作流' }].filter(
        (workflow) => !where?.id?.in || where.id.in.includes(workflow.id),
      ),
    findUnique: ({ where }: { where: { id: string } }) =>
      where.id === 'wf_1' ? { id: 'wf_1', name: '示例工作流' } : null,
  };
  const eventStore = new MemoryEventStore();
  const prismaStub = {
    workflowRun: runModel,
    workflow: workflowModel,
  } as unknown as PrismaService;
  const service = new RunsService(prismaStub, eventStore as unknown as EventStore);
  return { service, runs, eventStore };
}

describe('RunsService 删除运行（软删）', () => {
  it('deleteRun 给缓存行打 hiddenAt 标记，事件不清理（append-only）', async () => {
    const { service, runs, eventStore } = makeService();
    await eventStore.append('run_a', 'RUN_STARTED', { workflowId: 'wf_1' });

    await service.deleteRun('run_a');

    expect(runs.get('run_a')?.hiddenAt).not.toBeNull();
    expect(runs.get('run_b')?.hiddenAt).toBeNull();
    // 事件保持 append-only：不因删除而丢失
    expect(await eventStore.readEvents('run_a')).toHaveLength(1);
  });

  it('listRuns 过滤已删 run；按 workflowId 过滤仍然有效', async () => {
    const { service } = makeService();
    await service.deleteRun('run_a');

    const list = await service.listRuns();
    expect(list.map((row) => row.id)).toEqual(['run_b']);

    const byWorkflow = await service.listRuns('wf_1');
    expect(byWorkflow.map((row) => row.id)).toEqual(['run_b']);
  });

  it('已删 run 的详情/事件/状态一律 404（运行已删除）', async () => {
    const { service } = makeService();
    await service.deleteRun('run_a');

    await expect(service.getRun('run_a')).rejects.toThrow(NotFoundException);
    await expect(service.getRun('run_a')).rejects.toThrow('运行已删除');
    await expect(service.getEvents('run_a')).rejects.toThrow(NotFoundException);
    await expect(service.getRunStatus('run_a')).rejects.toThrow(NotFoundException);
    // 重复删除同样按 404 处理
    await expect(service.deleteRun('run_a')).rejects.toThrow(NotFoundException);
  });

  it('不存在的 run：删除/详情均 404（运行不存在）', async () => {
    const { service } = makeService();
    await expect(service.deleteRun('missing')).rejects.toThrow('运行不存在');
    await expect(service.getRun('missing')).rejects.toThrow('运行不存在');
  });

  it('未删 run 的详情/事件正常返回', async () => {
    const { service, eventStore } = makeService();
    await eventStore.append('run_a', 'RUN_STARTED', { workflowId: 'wf_1' });

    const detail = await service.getRun('run_a');
    expect(detail.id).toBe('run_a');
    expect(detail.workflowName).toBe('示例工作流');
    expect(await service.getEvents('run_a')).toHaveLength(1);
  });
});

/**
 * 运行列表 workflowDeleted 标志（UX 问题 C）：
 * 所属工作流记录已不存在时为 true（历史遗留孤儿 run），前端据此展示「原工作流已删除」横幅；
 * 工作流存在时字段缺省（不出现）。
 */
describe('RunsService workflowDeleted 标志', () => {
  it('所属工作流仍存在 → 列表/详情均不带 workflowDeleted 字段', async () => {
    const { service } = makeService([makeRun('run_a')]);

    const list = await service.listRuns();
    expect(list[0]?.workflowName).toBe('示例工作流');
    expect(list[0]).not.toHaveProperty('workflowDeleted');

    const detail = await service.getRun('run_a');
    expect(detail.workflowName).toBe('示例工作流');
    expect(detail).not.toHaveProperty('workflowDeleted');
  });

  it('所属工作流已删除（记录不存在）→ workflowName 兜底「(已删除)」且 workflowDeleted: true', async () => {
    const { service } = makeService([
      makeRun('run_a'),
      makeRun('run_ghost', { workflowId: 'wf_ghost' }),
    ]);

    const list = await service.listRuns();
    const ghost = list.find((row) => row.id === 'run_ghost');
    expect(ghost?.workflowName).toBe('(已删除)');
    expect(ghost?.workflowDeleted).toBe(true);
    const alive = list.find((row) => row.id === 'run_a');
    expect(alive?.workflowDeleted).toBeUndefined();

    const detail = await service.getRun('run_ghost');
    expect(detail.workflowName).toBe('(已删除)');
    expect(detail.workflowDeleted).toBe(true);
  });
});

/**
 * 运行列表 limit 参数（UX 问题 J-2）：
 * 默认 100、上限 500、非法值回退默认；按 createdAt 倒序取前 N。
 */
describe('RunsService 运行列表 limit', () => {
  function rowsByTime(count: number): RunRecord[] {
    const base = Date.now();
    return Array.from({ length: count }, (_, index) =>
      makeRun(`run_${String(index).padStart(3, '0')}`, { createdAt: new Date(base + index) }),
    );
  }

  it('缺省 limit 时默认 100 条（第 101 条起截断）', async () => {
    const { service } = makeService(rowsByTime(105));
    const list = await service.listRuns();
    expect(list).toHaveLength(100);
    // createdAt 倒序：最新在前
    expect(list[0]?.id).toBe('run_104');
  });

  it('limit=N 按现有排序取前 N 条', async () => {
    const { service } = makeService(rowsByTime(5));
    const list = await service.listRuns(undefined, 2);
    expect(list.map((row) => row.id)).toEqual(['run_004', 'run_003']);
  });

  it('limit 超过剩余条数时返回全部', async () => {
    const { service } = makeService(rowsByTime(3));
    expect(await service.listRuns(undefined, 10)).toHaveLength(3);
  });

  it('按 workflowId 过滤时 limit 同样生效', async () => {
    const { service } = makeService([
      ...rowsByTime(3),
      makeRun('run_other', { workflowId: 'wf_2', createdAt: new Date() }),
    ]);
    const list = await service.listRuns('wf_2', 5);
    expect(list.map((row) => row.id)).toEqual(['run_other']);
  });
});

describe('parseRunsListLimit', () => {
  it('缺省/空串回退默认 100', () => {
    expect(parseRunsListLimit(undefined)).toBe(100);
    expect(parseRunsListLimit('')).toBe(100);
    expect(parseRunsListLimit('   ')).toBe(100);
  });

  it('非法值（非数字/小数/0/负数/科学计数以外的怪值）回退默认 100', () => {
    expect(parseRunsListLimit('abc')).toBe(100);
    expect(parseRunsListLimit('1.5')).toBe(100);
    expect(parseRunsListLimit('0')).toBe(100);
    expect(parseRunsListLimit('-5')).toBe(100);
    expect(parseRunsListLimit('NaN')).toBe(100);
  });

  it('超过上限 500 截断为 500，合法值原样返回', () => {
    expect(parseRunsListLimit('501')).toBe(500);
    expect(parseRunsListLimit('999999')).toBe(500);
    expect(parseRunsListLimit('1')).toBe(1);
    expect(parseRunsListLimit('250')).toBe(250);
  });
});

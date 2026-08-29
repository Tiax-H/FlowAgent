/**
 * 运行删除（软删）回归（UX 问题 10）：
 * DELETE 语义 = 给投影缓存行打 hiddenAt 标记；事件表 append-only（禁止 UPDATE/DELETE），
 * 事件不动；已删 run 在列表中被过滤，详情/事件/状态查询一律 404。
 */
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { EventStore } from '../src/engine/event-store.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RunsService } from '../src/runs/runs.service';
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

function makeRun(id: string): RunRecord {
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
  };
}

function makeService(): {
  service: RunsService;
  runs: Map<string, RunRecord>;
  eventStore: MemoryEventStore;
} {
  const runs = new Map<string, RunRecord>();
  runs.set('run_a', makeRun('run_a'));
  runs.set('run_b', makeRun('run_b'));
  const runModel = {
    findMany: ({
      where,
    }: {
      where?: { hiddenAt?: Date | null; workflowId?: string } | undefined;
    }) =>
      [...runs.values()]
        .filter((row) => (where?.hiddenAt === null ? row.hiddenAt === null : true))
        .filter((row) => (where?.workflowId ? row.workflowId === where.workflowId : true))
        .map((row) => ({ ...row })),
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

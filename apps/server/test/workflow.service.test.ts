import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@flowagent/shared';

import { PrismaService } from '../src/prisma/prisma.service';
import { WorkflowService } from '../src/workflow/workflow.service';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  definition: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

type WorkflowWhereUnique = { id: string };

type WorkflowCreateData = {
  name: string;
  description?: string | null;
  definition: string;
};

type WorkflowUpdateData = {
  name?: string;
  description?: string | null;
  definition?: string;
  version?: { increment: number };
};

/** 运行记录（级联软删测试只关心 workflowId 与 hiddenAt） */
interface WorkflowRunRow {
  id: string;
  workflowId: string;
  hiddenAt: Date | null;
}

class InMemoryWorkflowRunModel {
  readonly rows: WorkflowRunRow[];

  constructor(rows: WorkflowRunRow[] = []) {
    this.rows = rows;
  }

  /** 对齐 Prisma updateMany 语义：hiddenAt: null 过滤 = 仅命中未软删行 */
  updateMany({
    where,
    data,
  }: {
    where: { workflowId: string; hiddenAt: Date | null };
    data: { hiddenAt: Date };
  }): Promise<{ count: number }> {
    let count = 0;
    for (const row of this.rows) {
      if (row.workflowId === where.workflowId && row.hiddenAt === null) {
        row.hiddenAt = data.hiddenAt;
        count += 1;
      }
    }
    return Promise.resolve({ count });
  }
}

class InMemoryWorkflowModel {
  private rows = new Map<string, WorkflowRow>();
  private counter = 0;
  private clock = Date.now();

  private nextDate(): Date {
    this.clock += 1;
    return new Date(this.clock);
  }

  create({ data }: { data: WorkflowCreateData }): WorkflowRow {
    this.counter += 1;
    const now = this.nextDate();
    const row: WorkflowRow = {
      id: `wf_${this.counter}`,
      name: data.name,
      description: data.description ?? null,
      definition: data.definition,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  findMany({ orderBy }: { orderBy?: Record<string, 'asc' | 'desc'> }): WorkflowRow[] {
    const rows = [...this.rows.values()];
    const field = orderBy && 'updatedAt' in orderBy ? 'updatedAt' : 'id';
    const direction = orderBy?.[orderBy ? 'updatedAt' : 'id'] ?? 'desc';
    rows.sort((a, b) => {
      const av = a[field];
      const bv = b[field];
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return direction === 'asc' ? cmp : -cmp;
    });
    return rows.map((row) => ({ ...row }));
  }

  findUnique({ where }: { where: WorkflowWhereUnique }): WorkflowRow | null {
    const row = this.rows.get(where.id);
    return row ? { ...row } : null;
  }

  update({ where, data }: { where: WorkflowWhereUnique; data: WorkflowUpdateData }): WorkflowRow {
    const row = this.rows.get(where.id);
    if (!row) throw new Error('Record does not exist');
    if (data.name !== undefined) row.name = data.name;
    if (data.description !== undefined) row.description = data.description;
    if (data.definition !== undefined) row.definition = data.definition;
    if (data.version !== undefined) row.version += data.version.increment;
    row.updatedAt = this.nextDate();
    return { ...row };
  }

  delete({ where }: { where: WorkflowWhereUnique }): WorkflowRow {
    const row = this.rows.get(where.id);
    if (!row) throw new Error('Record does not exist');
    this.rows.delete(where.id);
    return { ...row };
  }
}

function validDefinition(name?: string): WorkflowDefinition {
  return {
    schemaVersion: 1,
    name,
    nodes: [
      { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
      { id: 'end', type: 'end', name: '结束', position: { x: 400, y: 0 }, data: {} },
    ],
    edges: [{ id: 'e1', source: 'start', target: 'end' }],
  };
}

function cyclicDefinition(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'a',
        type: 'llm',
        name: 'A',
        position: { x: 100, y: 0 },
        data: { provider: 'p', model: 'm', prompt: 'x' },
      },
      {
        id: 'b',
        type: 'llm',
        name: 'B',
        position: { x: 200, y: 0 },
        data: { provider: 'p', model: 'm', prompt: 'x' },
      },
      { id: 'end', type: 'end', name: '结束', position: { x: 400, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'a' },
      { id: 'e2', source: 'a', target: 'b' },
      { id: 'e3', source: 'b', target: 'a' },
      { id: 'e4', source: 'b', target: 'end' },
    ],
  };
}

describe('WorkflowService', () => {
  let service: WorkflowService;
  let model: InMemoryWorkflowModel;
  let runModel: InMemoryWorkflowRunModel;

  beforeEach(async () => {
    model = new InMemoryWorkflowModel();
    runModel = new InMemoryWorkflowRunModel();
    const prismaStub = {
      workflow: model,
      workflowRun: runModel,
      // 对齐 Prisma $transaction 数组形式：顺序执行各操作
      $transaction: async (operations: unknown[]): Promise<unknown[]> => {
        const results: unknown[] = [];
        for (const operation of operations) results.push(await operation);
        return results;
      },
    } as unknown as PrismaService;
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: PrismaService, useValue: prismaStub }, WorkflowService],
    }).compile();
    service = moduleRef.get(WorkflowService);
  });

  it('创建合法工作流：version=1，definition 反序列化返回', async () => {
    const created = await service.create({ name: 'demo', definition: validDefinition() });
    expect(created.id).toBeTruthy();
    expect(created.version).toBe(1);
    expect(created.definition).toEqual(validDefinition());
    const stored = model.findUnique({ where: { id: created.id } });
    expect(typeof stored?.definition).toBe('string');
  });

  it('name 缺失抛 BadRequest', async () => {
    await expect(
      service.create({ name: '', definition: validDefinition() }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('definition 成环抛 422 且错误信息包含 DAG', async () => {
    try {
      await service.create({ name: 'bad', definition: cyclicDefinition() });
      expect.unreachable('应当抛出 UnprocessableEntityException');
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      const response = (error as UnprocessableEntityException).getResponse() as {
        errors: string[];
      };
      expect(response.errors.some((message) => message.includes('DAG'))).toBe(true);
    }
  });

  it('definition 非 JSON Schema 兼容结构抛 422', async () => {
    await expect(
      service.create({ name: 'bad', definition: { schemaVersion: 99 } }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('findAll 按 updatedAt 倒序', async () => {
    const first = await service.create({ name: 'first', definition: validDefinition() });
    const second = await service.create({ name: 'second', definition: validDefinition() });
    const list = await service.findAll();
    expect(list.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(first.name).toBe('first');
  });

  it('findAll 列表不返回 definition（列表页只用元信息，详情接口保留）', async () => {
    await service.create({ name: 'demo', definition: validDefinition() });
    const list = await service.findAll();
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]!)).not.toContain('definition');
  });

  it('findAll search 按 name contains 过滤且大小写不敏感（容忍首尾空白）', async () => {
    const alpha = await service.create({ name: 'Alpha Pipeline', definition: validDefinition() });
    await service.create({ name: 'beta flow', definition: validDefinition() });

    const lower = await service.findAll('alpha');
    expect(lower.map((item) => item.id)).toEqual([alpha.id]);
    const upper = await service.findAll('  ALPHA ');
    expect(upper.map((item) => item.id)).toEqual([alpha.id]);
    expect(await service.findAll('不存在的关键字')).toHaveLength(0);
  });

  it('name 超过 100 个字符 → create/update 均抛 422 中文错误', async () => {
    const longName = '名'.repeat(101);
    try {
      await service.create({ name: longName, definition: validDefinition() });
      expect.unreachable('应当抛出 UnprocessableEntityException');
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect((error as UnprocessableEntityException).message).toContain(
        '工作流名称不能超过 100 个字符',
      );
    }
    const created = await service.create({ name: 'demo', definition: validDefinition() });
    await expect(service.update(created.id, { name: longName })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    const row = model.findUnique({ where: { id: created.id } });
    expect(row?.name).toBe('demo');
  });

  it('name 恰好 100 个字符可创建', async () => {
    const name = '名'.repeat(100);
    const created = await service.create({ name, definition: validDefinition() });
    expect(created.name).toBe(name);
  });

  it('findOne 不存在抛 NotFound', async () => {
    await expect(service.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update 合法 definition 时 version 自增', async () => {
    const created = await service.create({ name: 'demo', definition: validDefinition() });
    const updated = await service.update(created.id, { name: 'renamed' });
    expect(updated.name).toBe('renamed');
    expect(updated.version).toBe(1);

    const nextDefinition = validDefinition('v2');
    const updated2 = await service.update(created.id, { definition: nextDefinition });
    expect(updated2.version).toBe(2);
    expect(updated2.definition).toEqual(nextDefinition);
  });

  it('update 非法 definition 抛 422 且不落库', async () => {
    const created = await service.create({ name: 'demo', definition: validDefinition() });
    await expect(
      service.update(created.id, { definition: cyclicDefinition() }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    const row = model.findUnique({ where: { id: created.id } });
    expect(row?.version).toBe(1);
  });

  it('update 不存在的工作流抛 NotFound', async () => {
    await expect(service.update('missing', { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('remove 删除后 findOne 抛 NotFound，重复删除抛 NotFound', async () => {
    const created = await service.create({ name: 'demo', definition: validDefinition() });
    await service.remove(created.id);
    await expect(service.findOne(created.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(created.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('remove 级联软删该工作流全部运行（hiddenAt 打标），其他工作流的 run 与已删 run 不受影响', async () => {
    const created = await service.create({ name: 'demo', definition: validDefinition() });
    const hiddenAt = new Date(1);
    runModel.rows.push(
      { id: 'run_1', workflowId: created.id, hiddenAt: null },
      { id: 'run_2', workflowId: created.id, hiddenAt: null },
      { id: 'run_other', workflowId: 'wf_other', hiddenAt: null },
      { id: 'run_hidden', workflowId: created.id, hiddenAt },
    );

    await service.remove(created.id);

    expect(model.findUnique({ where: { id: created.id } })).toBeNull();
    const hiddenAtOf = (id: string): Date | null =>
      runModel.rows.find((row) => row.id === id)?.hiddenAt ?? null;
    expect(hiddenAtOf('run_1')).not.toBeNull();
    expect(hiddenAtOf('run_2')).not.toBeNull();
    expect(hiddenAtOf('run_other')).toBeNull();
    // 已软删的 run 保持原标记（updateMany 只命中 hiddenAt: null）
    expect(hiddenAtOf('run_hidden')?.getTime()).toBe(1);
  });

  it('update 提供 matching expectedVersion 时正常保存', async () => {
    const created = await service.create({ name: 'demo', definition: validDefinition() });
    const updated = await service.update(created.id, { name: 'renamed', expectedVersion: 1 });
    expect(updated.name).toBe('renamed');
    expect(updated.version).toBe(1);
  });

  it('update expectedVersion 不等于当前版本 → 409，响应体含 currentVersion，且不落库', async () => {
    const created = await service.create({ name: 'demo', definition: validDefinition() });
    try {
      await service.update(created.id, { name: 'other', expectedVersion: 99 });
      expect.unreachable('应当抛出 ConflictException');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      const response = (error as ConflictException).getResponse() as {
        message: string;
        currentVersion: number;
      };
      expect(response.message).toBe('工作流已被其他会话修改（当前版本 v1），请刷新后重试');
      expect(response.currentVersion).toBe(1);
    }
    const row = model.findUnique({ where: { id: created.id } });
    expect(row?.name).toBe('demo');
  });

  it('update 未提供 expectedVersion 保持旧行为（后写者胜，向后兼容）', async () => {
    const created = await service.create({ name: 'demo', definition: validDefinition() });
    const updated = await service.update(created.id, { name: 'last-write' });
    expect(updated.name).toBe('last-write');
  });

  it('update expectedVersion 非整数（字符串/小数）→ 400', async () => {
    const created = await service.create({ name: 'demo', definition: validDefinition() });
    await expect(
      service.update(created.id, { name: 'x', expectedVersion: '1' as unknown as number }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update(created.id, { name: 'x', expectedVersion: 1.5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('definition 保存使 version 自增后，旧 expectedVersion 再次保存 → 409（currentVersion=2）', async () => {
    const created = await service.create({ name: 'demo', definition: validDefinition() });
    await service.update(created.id, { definition: validDefinition('v2'), expectedVersion: 1 });
    try {
      await service.update(created.id, { name: 'stale', expectedVersion: 1 });
      expect.unreachable('应当抛出 ConflictException');
    } catch (error) {
      const response = (error as ConflictException).getResponse() as { currentVersion: number };
      expect(response.currentVersion).toBe(2);
    }
  });
});

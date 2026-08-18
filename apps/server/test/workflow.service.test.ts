import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@flowagent/shared';

import { PrismaService } from '../src/prisma/prisma.service';
import { WorkflowService } from '../src/workflow/workflow.service';
import {
  BadRequestException,
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

  beforeEach(async () => {
    model = new InMemoryWorkflowModel();
    const prismaStub = { workflow: model } as unknown as PrismaService;
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
});

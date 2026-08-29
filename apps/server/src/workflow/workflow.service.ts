import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { validateWorkflowDefinition, WORKFLOW_NAME_MAX_LENGTH } from '@flowagent/shared';

import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateWorkflowDto,
  UpdateWorkflowDto,
  WorkflowListItemDto,
  WorkflowResponseDto,
} from './dto/workflow.dto';

interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  definition: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

function toResponse(row: WorkflowRow): WorkflowResponseDto {
  let definition: unknown;
  try {
    definition = JSON.parse(row.definition) as unknown;
  } catch {
    definition = null;
  }
  return { ...row, definition };
}

@Injectable()
export class WorkflowService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateWorkflowDto): Promise<WorkflowResponseDto> {
    this.assertName(dto.name);
    this.assertDefinition(dto.definition);
    const row = await this.prisma.workflow.create({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        definition: JSON.stringify(dto.definition),
      },
    });
    return toResponse(row);
  }

  /**
   * 工作流列表：不返回 definition（列表页只用元信息，见 WorkflowListItemDto），
   * 支持 name 的 contains 搜索（大小写不敏感）。
   * SQLite 的 Prisma contains 区分大小写且不支持 mode: 'insensitive'，故取回后内存过滤。
   */
  async findAll(search?: string): Promise<WorkflowListItemDto[]> {
    const rows = await this.prisma.workflow.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        version: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const keyword = search?.trim().toLowerCase();
    const matched =
      keyword !== undefined && keyword.length > 0
        ? rows.filter((row) => row.name.toLowerCase().includes(keyword))
        : rows;
    // 显式逐字段映射（而非展开 row），保证任何情况下都不会把 definition 带进列表响应
    return matched.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async findOne(id: string): Promise<WorkflowResponseDto> {
    const row = await this.prisma.workflow.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`工作流不存在: ${id}`);
    return toResponse(row);
  }

  async update(id: string, dto: UpdateWorkflowDto): Promise<WorkflowResponseDto> {
    const row = await this.prisma.workflow.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`工作流不存在: ${id}`);
    this.assertExpectedVersion(dto.expectedVersion, row.version);
    if (dto.name !== undefined) this.assertName(dto.name);
    if (dto.definition !== undefined) this.assertDefinition(dto.definition);

    const data: {
      name?: string;
      description?: string | null;
      definition?: string;
      version?: { increment: number };
    } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.definition !== undefined) {
      data.definition = JSON.stringify(dto.definition);
      data.version = { increment: 1 };
    }

    const updated = await this.prisma.workflow.update({ where: { id }, data });
    return toResponse(updated);
  }

  /**
   * 删除工作流，并级联软删其全部运行记录：两条写在同一事务内，
   * 避免删掉工作流后运行残留为孤儿（列表兜底「(已删除)」却仍可 retry 重跑）。
   * 运行复用软删机制（hiddenAt 标记，列表/详情/SSE/控制面一律按 404 处理）；
   * 事件表 append-only，不做任何事件清理。
   */
  async remove(id: string): Promise<void> {
    await this.ensureExists(id);
    await this.prisma.$transaction([
      this.prisma.workflowRun.updateMany({
        where: { workflowId: id, hiddenAt: null },
        data: { hiddenAt: new Date() },
      }),
      this.prisma.workflow.delete({ where: { id } }),
    ]);
  }

  /**
   * 乐观锁校验（PATCH expectedVersion）：提供且不等于当前版本 → 409 Conflict，
   * 响应体含当前版本号供前端提示「请刷新后重试」；未提供保持旧行为（向后兼容）。
   */
  private assertExpectedVersion(expectedVersion: unknown, currentVersion: number): void {
    if (expectedVersion === undefined) return;
    if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion)) {
      throw new BadRequestException('expectedVersion 必须为整数');
    }
    if (expectedVersion !== currentVersion) {
      throw new ConflictException({
        message: `工作流已被其他会话修改（当前版本 v${currentVersion}），请刷新后重试`,
        currentVersion,
      });
    }
  }

  private async ensureExists(id: string): Promise<void> {
    const row = await this.prisma.workflow.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`工作流不存在: ${id}`);
  }

  /** 名称校验：非空字符串 + 长度上限（上限常量在 shared，前后端同源） */
  private assertName(name: unknown): asserts name is string {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new BadRequestException('name 必须为非空字符串');
    }
    if (name.length > WORKFLOW_NAME_MAX_LENGTH) {
      throw new UnprocessableEntityException(
        `工作流名称不能超过 ${WORKFLOW_NAME_MAX_LENGTH} 个字符`,
      );
    }
  }

  private assertDefinition(definition: unknown): void {
    const result = validateWorkflowDefinition(definition);
    if (!result.valid) {
      throw new UnprocessableEntityException({
        message: '工作流定义校验失败',
        errors: result.errors,
      });
    }
  }
}

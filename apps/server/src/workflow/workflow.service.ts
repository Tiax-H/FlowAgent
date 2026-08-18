import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { validateWorkflowDefinition } from '@flowagent/shared';

import { PrismaService } from '../prisma/prisma.service';
import type { CreateWorkflowDto, UpdateWorkflowDto, WorkflowResponseDto } from './dto/workflow.dto';

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

  async findAll(): Promise<WorkflowResponseDto[]> {
    const rows = await this.prisma.workflow.findMany({ orderBy: { updatedAt: 'desc' } });
    return rows.map((row) => toResponse(row));
  }

  async findOne(id: string): Promise<WorkflowResponseDto> {
    const row = await this.prisma.workflow.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`工作流不存在: ${id}`);
    return toResponse(row);
  }

  async update(id: string, dto: UpdateWorkflowDto): Promise<WorkflowResponseDto> {
    await this.ensureExists(id);
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

    const row = await this.prisma.workflow.update({ where: { id }, data });
    return toResponse(row);
  }

  async remove(id: string): Promise<void> {
    await this.ensureExists(id);
    await this.prisma.workflow.delete({ where: { id } });
  }

  private async ensureExists(id: string): Promise<void> {
    const row = await this.prisma.workflow.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`工作流不存在: ${id}`);
  }

  private assertName(name: unknown): asserts name is string {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new BadRequestException('name 必须为非空字符串');
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

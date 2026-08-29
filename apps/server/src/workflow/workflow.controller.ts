import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';

import { WorkflowService } from './workflow.service';
import type {
  CreateWorkflowDto,
  UpdateWorkflowDto,
  WorkflowListItemDto,
  WorkflowResponseDto,
} from './dto/workflow.dto';

@Controller('workflows')
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Post()
  async create(@Body() body: CreateWorkflowDto): Promise<WorkflowResponseDto> {
    return this.workflowService.create(body);
  }

  /** 列表不返回 definition；search 按 name contains 过滤（大小写不敏感） */
  @Get()
  async findAll(@Query('search') search?: string): Promise<WorkflowListItemDto[]> {
    return this.workflowService.findAll(search);
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<WorkflowResponseDto> {
    return this.workflowService.findOne(id);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: UpdateWorkflowDto,
  ): Promise<WorkflowResponseDto> {
    return this.workflowService.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.workflowService.remove(id);
  }
}

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';

import type {
  CreateMcpServerDto,
  InvokeToolDto,
  InvokeToolResponseDto,
  McpServerResponseDto,
  McpToolResponseDto,
} from './dto/mcp.dto';
import { McpService } from './mcp.service';
import { McpRegistryService } from './mcp.registry';

@Controller('mcp')
export class McpController {
  constructor(
    private readonly mcpService: McpService,
    private readonly registry: McpRegistryService,
  ) {}

  @Post('servers')
  async createServer(@Body() body: CreateMcpServerDto): Promise<McpServerResponseDto> {
    return this.mcpService.createServer(body);
  }

  @Get('servers')
  async listServers(): Promise<McpServerResponseDto[]> {
    return this.mcpService.listServers();
  }

  @Delete('servers/:id')
  @HttpCode(204)
  async removeServer(@Param('id') id: string): Promise<void> {
    await this.mcpService.removeServer(id);
  }

  @Patch('servers/:id/reconnect')
  async reconnectServer(@Param('id') id: string): Promise<McpServerResponseDto> {
    await this.registry.connectServer(id).catch(() => undefined);
    return this.mcpService.findOne(id);
  }

  @Get('tools')
  async listTools(): Promise<McpToolResponseDto[]> {
    return this.mcpService.listTools();
  }

  @Post('tools/invoke')
  async invokeTool(@Body() body: InvokeToolDto): Promise<InvokeToolResponseDto> {
    return this.mcpService.invokeTool(body.server, body.tool, body.args);
  }
}

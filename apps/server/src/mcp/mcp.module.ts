import { Module, type OnModuleInit } from '@nestjs/common';

import { McpConnector } from './mcp.connector';
import { McpController } from './mcp.controller';
import { McpRegistryService } from './mcp.registry';
import { McpService } from './mcp.service';

@Module({
  controllers: [McpController],
  providers: [McpConnector, McpRegistryService, McpService],
  exports: [McpRegistryService],
})
export class McpModule implements OnModuleInit {
  constructor(private readonly registry: McpRegistryService) {}

  async onModuleInit(): Promise<void> {
    await this.registry.resumeEnabledServers();
  }
}

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    // 事件表是逐条 INSERT 的高频写入路径：WAL + NORMAL 显著降低每次提交的 fsync 成本
    try {
      await this.$queryRawUnsafe('PRAGMA journal_mode=WAL');
      await this.$queryRawUnsafe('PRAGMA synchronous=NORMAL');
    } catch (error) {
      this.logger.warn(`SQLite PRAGMA 设置失败（继续以默认 journal 运行）: ${String(error)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

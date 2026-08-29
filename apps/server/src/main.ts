import 'reflect-metadata';

import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// 从 cwd 逐级向上收集所有 .env 就近加载（dotenv 默认不覆盖已设置变量，近处优先）：
// apps/server/.env（Prisma 建的本地覆盖）与仓库根 .env（Provider 配置）可并存
const dotenvPaths: string[] = [];
for (let dir = process.cwd(); ; dir = resolve(dir, '..')) {
  const candidate = join(dir, '.env');
  if (existsSync(candidate)) dotenvPaths.push(candidate);
  if (resolve(dir, '..') === dir) break;
}
for (const path of dotenvPaths) loadDotenv({ path });

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { configureJsonBodyParser } from './body-parser';

async function bootstrap(): Promise<void> {
  // bodyParser: false + 显式注册 1MB JSON 解析器（默认 100KB 对工作流定义偏小），
  // 并把 body-parser 的英文裸 413/400 映射为中文 JSON（见 body-parser.ts）
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.setGlobalPrefix('api');
  configureJsonBodyParser(app);
  // 安全默认值：CORS 白名单（Vite dev server），可用 CORS_ORIGINS 环境变量扩展；
  // 监听 loopback（可用 HOST=0.0.0.0 显式放开，远程使用请自行加反向代理与鉴权）
  const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  app.enableCors({ origin: corsOrigins });
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
}
void bootstrap();

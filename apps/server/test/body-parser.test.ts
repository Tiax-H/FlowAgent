/**
 * 请求体上限与 body-parser 错误映射（UX 问题 E）：
 * - 超过 1MB 的 JSON → 413 中文提示（原先为英文裸 413）
 * - 非法 JSON → 400 中文提示
 * - 1MB 以内的合法 JSON 正常到达路由
 *
 * 走与 main.ts 完全相同的 configureJsonBodyParser 装配（bodyParser: false +
 * 显式 1MB 解析器 + 中文错误映射），用独立最小 Nest 应用 + 临时端口发起真实 HTTP 请求；
 * 不启动 AppModule（需数据库/迁移），映射函数本身另有单元断言兜底。
 */
import 'reflect-metadata';

import { Body, Controller, HttpCode, HttpStatus, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configureJsonBodyParser, mapBodyParserError } from '../src/body-parser';

@Controller()
class EchoController {
  @Post('echo')
  @HttpCode(HttpStatus.OK)
  echo(@Body() body: unknown): { ok: boolean; received: unknown } {
    return { ok: true, received: body };
  }
}

@Module({ controllers: [EchoController] })
class TestAppModule {}

describe('JSON 请求体上限与错误映射（集成）', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(TestAppModule, {
      bodyParser: false,
      logger: false,
    });
    configureJsonBodyParser(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it('超过 1MB 的 JSON 请求 → 413 中文提示（content-type 为 JSON）', async () => {
    const oversized = `{"payload":"${'x'.repeat(1024 * 1024 + 64 * 1024)}"}`;
    const response = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    });
    expect(response.status).toBe(413);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ message: '请求体过大（上限 1MB），请精简后重试' });
  });

  it('恰好 1MB 以内的合法 JSON 正常到达路由', async () => {
    const payload = { hello: '世界', pad: 'y'.repeat(512 * 1024) };
    const response = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, received: payload });
  });

  it('非法 JSON → 400 中文提示', async () => {
    const response = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: '请求体不是合法的 JSON，请检查后重试' });
  });
});

describe('mapBodyParserError（单元）', () => {
  it('entity.too.large → 413 中文', () => {
    const error = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
    });
    expect(mapBodyParserError(error)).toEqual({
      status: 413,
      body: { message: '请求体过大（上限 1MB），请精简后重试' },
    });
  });

  it('entity.parse.failed → 400 中文', () => {
    const error = Object.assign(new Error('Unexpected token n in JSON'), {
      type: 'entity.parse.failed',
      status: 400,
    });
    expect(mapBodyParserError(error)).toEqual({
      status: 400,
      body: { message: '请求体不是合法的 JSON，请检查后重试' },
    });
  });

  it('其余 body-parser 错误（charset.unsupported 等）→ 400 中文', () => {
    const error = Object.assign(new Error('unsupported charset'), {
      type: 'charset.unsupported',
      status: 415,
    });
    expect(mapBodyParserError(error)).toEqual({
      status: 400,
      body: { message: '请求体解析失败，请检查后重试' },
    });
  });

  it('非 body-parser 错误（无 type 或未知 type）返回 null，交回 Nest 处理', () => {
    expect(mapBodyParserError(new Error('boom'))).toBeNull();
    expect(mapBodyParserError(Object.assign(new Error('x'), { type: 'unknown.kind' }))).toBeNull();
    expect(mapBodyParserError('string error')).toBeNull();
    expect(mapBodyParserError(null)).toBeNull();
  });
});

/**
 * JSON 请求体解析配置与 body-parser 错误映射（main.ts 与集成测试共用，保证同一套行为）。
 *
 * 背景：Express 默认 JSON 上限 100KB，对含完整工作流定义的请求偏小；
 * 超限/非法 JSON 时 body-parser 抛出的英文裸错误（413/400）对用户不友好，
 * 这里显式放宽到 1MB 并把错误统一映射为中文 JSON 响应。
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

/** JSON 请求体上限（body-parser 的 limit 表达式） */
export const JSON_BODY_LIMIT = '1mb';

/** JSON_BODY_LIMIT 的人类可读展示（错误提示用，与实际上限保持一致） */
export const JSON_BODY_LIMIT_LABEL = '1MB';

/** body-parser 家族的全部错误 type（http-errors 附带，见 body-parser 文档错误码表） */
const BODY_PARSER_ERROR_TYPES = new Set([
  'entity.parse.failed',
  'entity.verify.failed',
  'entity.too.large',
  'request.aborted',
  'request.size.invalid',
  'stream.encoding.set',
  'parameters.too.many',
  'charset.unsupported',
  'encoding.unsupported',
]);

/** 错误映射结果：status 为 HTTP 状态码，body 为 JSON 响应体 */
export interface MappedBodyParserError {
  status: number;
  body: { message: string };
}

/**
 * 将 body-parser 错误映射为中文响应：
 * - entity.too.large → 413「请求体过大（上限 1MB）」
 * - entity.parse.failed → 400「请求体不是合法的 JSON」
 * - 其余 body 解析错误 → 400「请求体解析失败」
 * 非 body-parser 错误返回 null，由调用方交回 Nest 默认异常处理。
 */
export function mapBodyParserError(error: unknown): MappedBodyParserError | null {
  if (typeof error !== 'object' || error === null) return null;
  const type = (error as { type?: unknown }).type;
  if (typeof type !== 'string' || !BODY_PARSER_ERROR_TYPES.has(type)) return null;
  if (type === 'entity.too.large') {
    return {
      status: 413,
      body: { message: `请求体过大（上限 ${JSON_BODY_LIMIT_LABEL}），请精简后重试` },
    };
  }
  if (type === 'entity.parse.failed') {
    return { status: 400, body: { message: '请求体不是合法的 JSON，请检查后重试' } };
  }
  return { status: 400, body: { message: '请求体解析失败，请检查后重试' } };
}

/**
 * Express 错误处理中间件：拦截 body-parser 错误返回中文 JSON；
 * 其他错误原样交给后续异常处理（Nest 全局过滤器）。
 * 必须注册在 JSON 解析器之后、路由之前（见 configureJsonBodyParser）。
 */
function bodyParserErrorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  const mapped = mapBodyParserError(error);
  if (mapped === null) {
    next(error);
    return;
  }
  response.status(mapped.status).json(mapped.body);
}

/**
 * 配置 JSON 请求体解析：显式 1MB 上限（覆盖 Express 默认 100KB）+ body-parser
 * 错误的中文映射。必须在 Nest 路由初始化（listen/init）之前调用，
 * 且 NestFactory.create 需传 bodyParser: false 以免默认 100KB 解析器抢先注册。
 */
export function configureJsonBodyParser(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.use(bodyParserErrorHandler);
}

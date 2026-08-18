/**
 * search demo MCP Server 的 HTTP（Streamable HTTP）模式。
 *
 * 有状态会话：每个新会话一个 StreamableHTTPServerTransport 实例，
 * 会话 id 由服务端生成并通过 mcp-session-id 头返回。
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { createServer } from './setup.js';

interface ManagedSession {
  transport: StreamableHTTPServerTransport;
}

const sessions = new Map<string, ManagedSession>();

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return undefined;
  return JSON.parse(raw) as unknown;
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function handleMcpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const sessionId = request.headers['mcp-session-id'];
  const parsedBody = request.method === 'POST' ? await readJsonBody(request) : undefined;

  if (typeof sessionId === 'string' && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(request, response, parsedBody);
    return;
  }

  // 无会话 id：仅接受初始化请求建立新会话
  if (typeof sessionId === 'string') {
    respondJson(response, 404, { jsonrpc: '2.0', error: { code: -32001, message: '会话不存在或已过期' } });
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) sessions.delete(id);
  };

  const server = createServer();
  await server.connect(transport);

  await transport.handleRequest(request, response, parsedBody);
  if (transport.sessionId) {
    sessions.set(transport.sessionId, { transport });
  }
}

export function startHttpServer(port: number): void {
  const httpServer = createHttpServer((request, response) => {
    const url = request.url ?? '/';
    if (url.split('?')[0] !== '/mcp') {
      respondJson(response, 404, { error: 'not found，MCP 端点为 /mcp' });
      return;
    }
    void handleMcpRequest(request, response).catch((error: unknown) => {
      console.error('MCP 请求处理失败:', error);
      if (!response.headersSent) {
        respondJson(response, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'internal error' } });
      }
    });
  });

  httpServer.listen(port, () => {
    console.log(`flowagent-search HTTP MCP Server 监听 http://localhost:${port}/mcp（会话数: ${sessions.size}）`);
  });
}

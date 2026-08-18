import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { startHttpServer } from './http.js';
import { createServer } from './setup.js';

function parseArgs(argv: string[]): { http: boolean; port: number } {
  const http = argv.includes('--http');
  const portIndex = argv.indexOf('--port');
  const portArg = portIndex >= 0 ? argv[portIndex + 1] : undefined;
  const port = portArg !== undefined && /^\d+$/.test(portArg) ? Number(portArg) : 3100;
  return { http, port };
}

async function main(): Promise<void> {
  const { http, port } = parseArgs(process.argv.slice(2));

  if (http) {
    startHttpServer(port);
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error: unknown) => {
  console.error('search server 启动失败:', error);
  process.exit(1);
});

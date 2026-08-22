import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createBridgeServer } from './bridge-server.js';
import { FlowAgentClient } from './flowagent-client.js';
import { startHttpServer } from './http.js';

function parseArgs(argv: string[]): { http: boolean; port: number } {
  const http = argv.includes('--http');
  const portIndex = argv.indexOf('--port');
  const portArg = portIndex >= 0 ? argv[portIndex + 1] : undefined;
  const port = portArg !== undefined && /^\d+$/.test(portArg) ? Number(portArg) : 3200;
  return { http, port };
}

async function main(): Promise<void> {
  const { http, port } = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.FLOWAGENT_URL ?? 'http://localhost:3000';
  const api = new FlowAgentClient(baseUrl, fetch);

  if (http) {
    startHttpServer(() => createBridgeServer(api), port);
    return;
  }
  const server = await createBridgeServer(api);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error: unknown) => {
  console.error('flowagent-bridge 启动失败:', error);
  process.exit(1);
});

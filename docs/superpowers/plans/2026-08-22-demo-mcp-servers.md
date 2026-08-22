# Demo MCP Servers（sandbox + report）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 PROJECT_PLAN §7 目录结构中的另外两个 demo MCP Server——`servers/sandbox`（代码沙箱）与 `servers/report`（报告生成），为旗舰 Demo 工作流供给工具。

**Architecture:** 两个独立 workspace 包，完全复刻 `servers/search` 的既有模式（tools 纯函数 + setup 工具注册 + http Streamable 会话 + index 双传输入口）。sandbox 的执行红线：代码只在限额子进程内运行（`execFile(process.execPath, ['-e', code])` + timeout + maxBuffer），绝不在本进程 eval；输入限长、输出截断。report 为确定性纯函数渲染。

**Tech Stack:** TypeScript strict（NodeNext，同 search）、@modelcontextprotocol/sdk 1.30.0、zod 4、vitest、pnpm workspace（`servers/*` 已在 pnpm-workspace.yaml）。

**Spec:** docs/PROJECT_PLAN.md §3（架构图中的「代码沙箱/报告生成」生态位）、§7（servers/ 目录）、§8 第 9 周（3 个 demo MCP Server）；AGENTS.md 安全节（沙箱必须子进程隔离，不得直接 eval 用户输入）。

## Global Constraints

- 全 TypeScript strict；禁止 `any`（逃逸用 `unknown` + 收窄）。
- 只用 pnpm（本机 Git Bash 全局 pnpm 可能不可用，统一用 `corepack pnpm ...`）。
- MCP 只用 `@modelcontextprotocol/sdk`。
- 沙箱红线：用户代码只经限额子进程执行（timeout + maxBuffer + 输入限长 + 输出截断），禁止本进程 eval。
- 提交信息：Conventional Commits + 中文描述。
- 文件命名与包结构逐项对齐 `servers/search`（包名 `@flowagent/<name>-server`、http 默认端口 3100 段、test 无 vitest 配置文件）。
- 每任务收尾 `corepack pnpm lint` 零报错。

## 参考实现要点（执行者必读）

- `servers/search/` 是唯一事实参照：package.json（name/scripts/deps）、tsconfig.json（extends 基座 + NodeNext）、src/{index,setup,tools,http}.ts 四文件、test/tools.test.ts（纯函数直测，导入不带 `.js` 后缀）。
- src 内相对导入带 `.js` 后缀（NodeNext），test 内按 search 惯例不带后缀。
- 两个新包创建后需 `corepack pnpm install` 生成 workspace 链接；turbo 的 build/test 自动纳入。
- `execFile` 的 timeout 触发时回调 error 带 `killed: true`；`error === null` 即退出码 0。

---

### Task 1: servers/sandbox —— 代码沙箱 demo Server

**Files:**
- Create: `servers/sandbox/package.json`
- Create: `servers/sandbox/tsconfig.json`
- Create: `servers/sandbox/src/tools.ts`
- Create: `servers/sandbox/src/setup.ts`
- Create: `servers/sandbox/src/http.ts`
- Create: `servers/sandbox/src/index.ts`
- Test: `servers/sandbox/test/tools.test.ts`

**Interfaces:**
- Consumes: 无（独立包）。
- Produces: MCP 工具 `run_javascript { code: string, timeoutMs?: int 100..15000 }` → JSON 文本 `{ ok, stdout, stderr, durationMs, timedOut, truncated }`；模块导出 `validateCode(code: string): string | null`、`truncateOutput(text: string): { text: string; truncated: boolean }`、`runJavascript(code: string, timeoutMs?: number): Promise<SandboxResult>`（`SandboxResult` 含上述六字段）。

- [ ] **Step 1: 建包骨架并安装链接**

`servers/sandbox/package.json`：

```json
{
  "name": "@flowagent/sandbox-server",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "node dist/index.js",
    "start:http": "node dist/index.js --http --port 3101"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "vitest": "^2.1.8"
  }
}
```

`servers/sandbox/tsconfig.json`（与 servers/search 完全一致）：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "nodenext",
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Run: `corepack pnpm install`
Expected: 无 peer 冲突错误。

- [ ] **Step 2: 写失败测试**

`servers/sandbox/test/tools.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { runJavascript, truncateOutput, validateCode } from '../src/tools';

describe('validateCode', () => {
  it('空代码被拒', () => {
    expect(validateCode('   ')).toContain('不能为空');
  });

  it('超长代码被拒', () => {
    expect(validateCode('a'.repeat(10_001))).toContain('超限');
  });

  it('合法代码通过', () => {
    expect(validateCode('console.log(1)')).toBeNull();
  });
});

describe('truncateOutput', () => {
  it('短文本原样返回', () => {
    expect(truncateOutput('abc')).toEqual({ text: 'abc', truncated: false });
  });

  it('超长文本截断并标记', () => {
    const result = truncateOutput('a'.repeat(9_000));
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(9_000);
    expect(result.text).toContain('截断');
  });
});

describe('runJavascript', () => {
  it('执行成功并收集 stdout', async () => {
    const result = await runJavascript("console.log('你好', 1 + 1)");
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('你好 2');
    expect(result.timedOut).toBe(false);
  });

  it('异常退出时 ok=false 且带 stderr', async () => {
    const result = await runJavascript('throw new Error("boom")');
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('boom');
  });

  it('超时被杀', async () => {
    const result = await runJavascript('while (true) {}', 300);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });
});
```

Run: `corepack pnpm --filter @flowagent/sandbox-server exec vitest run`
Expected: FAIL——`Cannot find module '../src/tools'`。

- [ ] **Step 3: 实现 src/tools.ts**

```ts
/**
 * sandbox demo MCP Server 的代码执行实现。
 * 隔离红线：用户代码只在限额子进程内执行（限时/限长/输出截断），绝不在本进程 eval。
 */
import { execFile } from 'node:child_process';

export interface SandboxResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

const MAX_CODE_LENGTH = 10_000;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_BUFFER_BYTES = 64 * 1024;

export function validateCode(code: string): string | null {
  if (code.trim().length === 0) return 'code 不能为空';
  if (code.length > MAX_CODE_LENGTH) {
    return `code 长度超限（${code.length} > ${MAX_CODE_LENGTH}）`;
  }
  return null;
}

export function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(输出已截断)`, truncated: true };
}

export function runJavascript(code: string, timeoutMs = 5_000): Promise<SandboxResult> {
  const startedAt = Date.now();
  return new Promise<SandboxResult>((resolve) => {
    execFile(
      process.execPath,
      ['-e', code],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, shell: false },
      (error, stdout, stderr) => {
        const timedOut =
          (error as (NodeJS.ErrnoException & { killed?: boolean }) | null)?.killed === true;
        const out = truncateOutput(String(stdout));
        const err = truncateOutput(String(stderr));
        resolve({
          ok: error === null,
          stdout: out.text,
          stderr: err.text,
          durationMs: Date.now() - startedAt,
          timedOut,
          truncated: out.truncated || err.truncated,
        });
      },
    );
  });
}
```

Run: `corepack pnpm --filter @flowagent/sandbox-server exec vitest run`
Expected: PASS（8 个用例）。

- [ ] **Step 4: 实现 src/setup.ts（工具注册）**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { runJavascript, validateCode } from './tools.js';

/** 工具注册（stdio 与 HTTP 两种模式共用） */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'flowagent-sandbox', version: '0.1.0' });

  server.registerTool(
    'run_javascript',
    {
      title: '运行 JavaScript',
      description:
        '在限额子进程内执行一段 JavaScript（隔离执行：限时/限长/输出截断），返回 stdout/stderr/耗时',
      inputSchema: {
        code: z.string().describe('要执行的 JavaScript 源码'),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(15_000)
          .optional()
          .describe('执行超时毫秒，默认 5000，上限 15000'),
      },
    },
    async ({ code, timeoutMs }) => {
      const invalid = validateCode(code);
      if (invalid) throw new Error(invalid);
      const result = await runJavascript(code, timeoutMs ?? 5_000);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  return server;
}
```

- [ ] **Step 5: 实现 src/http.ts 与 src/index.ts**

`servers/sandbox/src/http.ts`（Streamable HTTP 模式，与 search 同构）：

```ts
/**
 * sandbox demo Server 的 HTTP（Streamable HTTP）模式。
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
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
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
    console.log(`flowagent-sandbox HTTP MCP Server 监听 http://localhost:${port}/mcp（会话数: ${sessions.size}）`);
  });
}
```

`servers/sandbox/src/index.ts`：

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { startHttpServer } from './http.js';
import { createServer } from './setup.js';

function parseArgs(argv: string[]): { http: boolean; port: number } {
  const http = argv.includes('--http');
  const portIndex = argv.indexOf('--port');
  const portArg = portIndex >= 0 ? argv[portIndex + 1] : undefined;
  const port = portArg !== undefined && /^\d+$/.test(portArg) ? Number(portArg) : 3101;
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
  console.error('sandbox server 启动失败:', error);
  process.exit(1);
});
```

- [ ] **Step 6: 全套验证**

Run: `corepack pnpm --filter @flowagent/sandbox-server exec vitest run && corepack pnpm --filter @flowagent/sandbox-server run build && corepack pnpm lint`
Expected: 测试全 PASS；tsc 零错误产出 `servers/sandbox/dist/index.js`；lint 零报错。

- [ ] **Step 7: 提交**

```bash
git add servers/sandbox pnpm-lock.yaml
git commit -m "feat: sandbox demo MCP Server——限额子进程 JavaScript 执行"
```

---

### Task 2: servers/report —— 报告生成 demo Server

**Files:**
- Create: `servers/report/package.json`
- Create: `servers/report/tsconfig.json`
- Create: `servers/report/src/tools.ts`
- Create: `servers/report/src/setup.ts`
- Create: `servers/report/src/http.ts`
- Create: `servers/report/src/index.ts`
- Test: `servers/report/test/tools.test.ts`

**Interfaces:**
- Consumes: 无（独立包；http.ts/index.ts 与 Task 1 同构，仅名称与端口不同）。
- Produces: MCP 工具 `generate_report { title, sections: [{heading, body}], metadata? }` → Markdown 文本；`format_citations { sources: [{title, url}] }` → Markdown 引用清单。模块导出 `validateReportInput(input: ReportInput): string | null`、`generateMarkdownReport(input: ReportInput): string`、`validateCitations(sources: CitationSource[]): string | null`、`formatCitations(sources: CitationSource[]): string`，及类型 `ReportInput`/`ReportSection`/`CitationSource`。

- [ ] **Step 1: 建包骨架并安装链接**

`servers/report/package.json`（与 sandbox 同构，name 与端口不同）：

```json
{
  "name": "@flowagent/report-server",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "node dist/index.js",
    "start:http": "node dist/index.js --http --port 3102"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "vitest": "^2.1.8"
  }
}
```

`servers/report/tsconfig.json`：与 Task 1 Step 1 的 tsconfig 完全一致（照抄一份）。

Run: `corepack pnpm install`
Expected: 无错误。

- [ ] **Step 2: 写失败测试**

`servers/report/test/tools.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import {
  formatCitations,
  generateMarkdownReport,
  validateCitations,
  validateReportInput,
} from '../src/tools';

const sampleInput = {
  title: '深度研究报告',
  sections: [
    { heading: '结论', body: 'MCP 已成为事实标准。' },
    { heading: '建议', body: '尽早接入。' },
  ],
  metadata: { 作者: 'FlowAgent', 轮次: '3' },
};

describe('validateReportInput', () => {
  it('空标题被拒', () => {
    expect(validateReportInput({ ...sampleInput, title: '  ' })).toContain('title');
  });

  it('空章节列表被拒', () => {
    expect(validateReportInput({ ...sampleInput, sections: [] })).toContain('sections');
  });

  it('空章节标题被拒', () => {
    expect(
      validateReportInput({ ...sampleInput, sections: [{ heading: ' ', body: 'x' }] }),
    ).toContain('heading');
  });

  it('合法输入通过', () => {
    expect(validateReportInput(sampleInput)).toBeNull();
  });
});

describe('generateMarkdownReport', () => {
  it('渲染标题、元数据表与章节', () => {
    const markdown = generateMarkdownReport(sampleInput);
    expect(markdown).toContain('# 深度研究报告');
    expect(markdown).toContain('| 键 | 值 |');
    expect(markdown).toContain('| 作者 | FlowAgent |');
    expect(markdown).toContain('## 结论');
    expect(markdown).toContain('MCP 已成为事实标准。');
  });

  it('无元数据时不输出表格', () => {
    const markdown = generateMarkdownReport({ title: 'T', sections: [{ heading: 'H', body: 'B' }] });
    expect(markdown).not.toContain('| 键 | 值 |');
    expect(markdown).toContain('## H');
  });
});

describe('validateCitations', () => {
  it('合法来源通过', () => {
    expect(validateCitations([{ title: '规范', url: 'https://example.com/spec' }])).toBeNull();
  });

  it('非法 URL 被拒', () => {
    expect(validateCitations([{ title: 'x', url: 'not-a-url' }])).toContain('格式非法');
  });

  it('非 http 协议被拒', () => {
    expect(validateCitations([{ title: 'x', url: 'ftp://example.com/a' }])).toContain('http');
  });
});

describe('formatCitations', () => {
  it('输出编号引用清单', () => {
    const text = formatCitations([
      { title: 'A 篇', url: 'https://a.example.com' },
      { title: 'B 篇', url: 'https://b.example.com' },
    ]);
    expect(text).toContain('- [1] A 篇 — https://a.example.com');
    expect(text).toContain('- [2] B 篇 — https://b.example.com');
  });
});
```

Run: `corepack pnpm --filter @flowagent/report-server exec vitest run`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 src/tools.ts**

```ts
/**
 * report demo MCP Server 的确定性报告生成实现（纯函数，无副作用）。
 */

export interface ReportSection {
  heading: string;
  body: string;
}

export interface ReportInput {
  title: string;
  sections: ReportSection[];
  metadata?: Record<string, string>;
}

export function validateReportInput(input: ReportInput): string | null {
  if (input.title.trim().length === 0) return 'title 不能为空';
  if (input.sections.length === 0) return 'sections 不能为空';
  for (const section of input.sections) {
    if (section.heading.trim().length === 0) return 'section.heading 不能为空';
  }
  return null;
}

export function generateMarkdownReport(input: ReportInput): string {
  const lines: string[] = [`# ${input.title}`, ''];
  const entries = Object.entries(input.metadata ?? {});
  if (entries.length > 0) {
    lines.push('| 键 | 值 |', '| --- | --- |');
    for (const [key, value] of entries) lines.push(`| ${key} | ${value} |`);
    lines.push('');
  }
  for (const section of input.sections) {
    lines.push(`## ${section.heading}`, '', section.body, '');
  }
  return `${lines.join('\n').trim()}\n`;
}

export interface CitationSource {
  title: string;
  url: string;
}

export function validateCitations(sources: CitationSource[]): string | null {
  for (const source of sources) {
    if (source.title.trim().length === 0) return 'source.title 不能为空';
    try {
      const parsed = new URL(source.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `source.url 只支持 http/https: ${source.url}`;
      }
    } catch {
      return `source.url 格式非法: ${source.url}`;
    }
  }
  return null;
}

export function formatCitations(sources: CitationSource[]): string {
  return sources
    .map((source, index) => `- [${index + 1}] ${source.title} — ${source.url}`)
    .join('\n');
}
```

Run: `corepack pnpm --filter @flowagent/report-server exec vitest run`
Expected: PASS（10 个用例）。

- [ ] **Step 4: 实现 src/setup.ts（两个工具）**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  formatCitations,
  generateMarkdownReport,
  validateCitations,
  validateReportInput,
  type CitationSource,
  type ReportInput,
} from './tools.js';

/** 工具注册（stdio 与 HTTP 两种模式共用） */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'flowagent-report', version: '0.1.0' });

  server.registerTool(
    'generate_report',
    {
      title: '生成报告',
      description: '把结构化章节渲染为 Markdown 报告（标题 + 元数据表 + 章节正文）',
      inputSchema: {
        title: z.string().describe('报告标题'),
        sections: z
          .array(z.object({ heading: z.string(), body: z.string() }))
          .min(1)
          .describe('章节列表'),
        metadata: z.record(z.string(), z.string()).optional().describe('元数据键值表'),
      },
    },
    async ({ title, sections, metadata }) => {
      const input: ReportInput = { title, sections, metadata };
      const invalid = validateReportInput(input);
      if (invalid) throw new Error(invalid);
      return { content: [{ type: 'text', text: generateMarkdownReport(input) }] };
    },
  );

  server.registerTool(
    'format_citations',
    {
      title: '格式化引用',
      description: '把来源列表格式化为 Markdown 引用清单（编号 + 标题 + URL）',
      inputSchema: {
        sources: z
          .array(z.object({ title: z.string(), url: z.string() }))
          .min(1)
          .describe('来源列表'),
      },
    },
    async ({ sources }) => {
      const typed: CitationSource[] = sources;
      const invalid = validateCitations(typed);
      if (invalid) throw new Error(invalid);
      return { content: [{ type: 'text', text: formatCitations(typed) }] };
    },
  );

  return server;
}
```

- [ ] **Step 5: 实现 src/http.ts 与 src/index.ts**

`servers/report/src/http.ts`：与 Task 1 Step 5 的 http.ts 完全同构，仅两处不同——文件头注释写 `report demo Server`，`startHttpServer` 的监听日志改为 `flowagent-report HTTP MCP Server 监听 http://localhost:${port}/mcp（会话数: ${sessions.size}）`。其余逐行一致。

`servers/report/src/index.ts`：与 Task 1 Step 5 的 index.ts 同构，三处不同——`parseArgs` 默认端口 `3102`、`main` 的错误前缀 `report server 启动失败:`。

- [ ] **Step 6: 全套验证**

Run: `corepack pnpm --filter @flowagent/report-server exec vitest run && corepack pnpm --filter @flowagent/report-server run build && corepack pnpm lint`
Expected: 测试全 PASS；tsc 零错误产出 `servers/report/dist/index.js`；lint 零报错。

- [ ] **Step 7: 提交**

```bash
git add servers/report pnpm-lock.yaml
git commit -m "feat: report demo MCP Server——Markdown 报告与引用生成"
```

---

### Task 3: 环境示例 + 文档同步 + 端到端冒烟 + 全量门禁

**Files:**
- Modify: `.env.example`（Demo MCP Servers 节追加两行）
- Modify: `docs/PROJECT_PLAN.md` §11（变更记录追加一行）

**Interfaces:** 无代码接口；产出 `.env.example` 示例、文档记录、两条端到端冒烟证据、全量门禁绿。

- [ ] **Step 1: .env.example 追加示例**

在 `.env.example` 的 `MCP_SEARCH_SERVER_CMD=...` 行之后追加：

```
MCP_SANDBOX_SERVER_CMD="node /absolute/path/to/servers/sandbox/dist/index.js"
MCP_REPORT_SERVER_CMD="node /absolute/path/to/servers/report/dist/index.js"
```

- [ ] **Step 2: PROJECT_PLAN §11 追加变更记录**

在 §11 表格末尾追加：

```markdown
| —（版本不变） | 2026-08-22 | 第 9 周 demo Server 补齐：servers/sandbox（限额子进程 JS 执行）与 servers/report（Markdown 报告/引用生成），对齐 §7 目录结构 |
```

- [ ] **Step 3: 端到端冒烟（stdio 直连，验证真实 MCP 协议）**

从仓库根运行（先确保已 build）：

```bash
corepack pnpm --filter @flowagent/sandbox-server run build
node --input-type=module -e "
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client = new Client({ name: 'smoke', version: '0.0.1' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['servers/sandbox/dist/index.js'] });
await client.connect(transport);
const result = await client.callTool({ name: 'run_javascript', arguments: { code: 'console.log(2 + 3)' } });
console.log('sandbox ->', result.content[0].text);
await client.close();
"
corepack pnpm --filter @flowagent/report-server run build
node --input-type=module -e "
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client = new Client({ name: 'smoke', version: '0.0.1' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['servers/report/dist/index.js'] });
await client.connect(transport);
const result = await client.callTool({ name: 'generate_report', arguments: { title: '冒烟', sections: [{ heading: '结果', body: '通过' }] } });
console.log('report ->', result.content[0].text.split('\n')[0]);
await client.close();
"
```

Expected: `sandbox ->` 输出含 `"ok": true` 与 stdout `5`；`report ->` 输出 `# 冒烟`。

- [ ] **Step 4: 全量门禁**

Run: `corepack pnpm test && corepack pnpm lint && corepack pnpm build`
Expected: 全绿（turbo 纳入两个新包的 test/build）。

- [ ] **Step 5: 提交**

```bash
git add .env.example docs/PROJECT_PLAN.md
git commit -m "docs: demo Server 环境示例与第 9 周变更记录"
```

---

## Self-Review 记录

- **Spec 覆盖**：PROJECT_PLAN §7「3 个 demo MCP Server」→ search（已有）+ Task 1 sandbox + Task 2 report；AGENTS.md 沙箱红线 → Task 1 的 execFile 限额设计 + 测试覆盖超时/限长；§11 文档同步 → Task 3。旗舰工作流与 UI 打磨不在本计划范围（独立后续计划）。
- **占位符扫描**：无 TBD/TODO；http.ts/index.ts 的「同构」说明均给出逐行差异清单（Task 2 Step 5），基准代码在 Task 1 完整给出。
- **类型一致性**：`SandboxResult` 六字段与工具描述一致；`ReportInput`/`CitationSource` 在 tools.ts 定义、setup.ts 以同名类型消费；两包端口 3101/3102 与 .env 示例无冲突。

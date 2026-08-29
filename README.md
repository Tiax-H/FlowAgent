# FlowAgent

> MCP 原生的多模型 Agent 工作流运行时（Durable Agent Runtime）

[![CI](https://github.com/Tiax-H/FlowAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/Tiax-H/FlowAgent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-orange.svg)](https://modelcontextprotocol.io)

**拖拽编排 DAG 工作流，Agent 节点通过 MCP 协议调用任意工具服务器——事件溯源、断点恢复、人工介入、多模型路由，全过程实时可视化与回放。**

把 Temporal 式 durable execution 思想引入 MCP 原生多模型 Agent 编排：进程崩溃后从断点继续，长任务可以挂起等待人工审批数小时再恢复，每一次执行都有完整的事件时间轴可回放审计。

## 核心特性

- **Durable Execution** — 事件溯源记录每次状态变更；失败断点恢复 / 主动暂停恢复 / Human 挂起恢复，三路径一套机制
- **MCP 原生** — stdio + Streamable HTTP 双传输；工具运行时动态发现与热更新（对齐 MCP 2026-07-28 规范）；长任务经 runId 持久句柄轮询
- **多模型路由** — 每个 Agent 节点独立绑定 Provider + 模型；OpenAI 兼容适配层，一把聚合平台 key 即可体验全部能力
- **双向 MCP** — 向下编排任意 MCP 工具；向上把整个工作流反向暴露为 MCP Server，供 Claude Code / Codex 作为工具调用
- **可视化编排** — 基于 React Flow 的 DAG 画布：并行分支、条件、循环、人工介入；执行过程节点级实时状态与日志流
- **执行回放** — 时间轴视图回放任意一次历史执行的事件流

## 架构

```
┌──────── Web：DAG 画布(React Flow) + 运行监控 + 执行回放时间轴 ────────┐
└──────── REST + SSE(执行事件流；Human 审批经 REST POST) ───────────────┘
┌─────────────────────────── Server (NestJS + TS) ──────────────────────┐
│ Workflow │ Run │ Event Store(事件溯源) │ LLM Adapter(多模型路由)         │
│ Execution Engine: 状态机 → 拓扑调度 → 并行/条件/Loop → checkpoint       │
│ MCP Gateway: 动态发现 → 工具注册表(热更新) → 调用路由                    │
│ Workflow→MCP Bridge: 工作流反向暴露为 MCP Server                      │
└──────────────── MCP (stdio + Streamable HTTP) ────────────────────────┘
```

详见 [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md)。

## 快速开始

> 项目处于积极开发阶段（目标 v0.1）。

```bash
# 前置：Node >= 20, pnpm >= 9
git clone https://github.com/Tiax-H/FlowAgent.git
cd FlowAgent
pnpm install
cp .env.example .env        # 填入你的 LLM Provider 配置
pnpm db:generate            # 生成 Prisma Client（首次必做）
pnpm db:migrate             # 建表（SQLite，首次必做）
pnpm dev                    # 同时启动 server(:3000) 与 web(:5173)
```

> 除环境变量外，服务端设置 `FLOWAGENT_SECRET_KEY` 后，还可在 Web 设置页直接增删改查 Provider（密钥加密存储、保存即生效）。

> 安全默认值：server 只监听 `127.0.0.1`，CORS 仅放行本地前端。远程使用请自行置于反向代理与鉴权之后（`HOST`/`CORS_ORIGINS` 环境变量可调）。Docker 一键部署在 Roadmap v0.4（尚未提供 compose 文件）。

### 把工作流当工具用（Workflow→MCP Bridge）

先启动 FlowAgent（`pnpm dev`），bridge 以独立进程把所有已保存工作流暴露为 MCP 工具：

首次使用前先构建：`pnpm build`（Turborepo 会连同依赖一起构建 bridge）。

```json
{ "mcpServers": { "flowagent": { "command": "pnpm", "args": ["mcp:serve"] } } }
```

可用工具：`flowagent_list_workflows` / `flowagent_run_workflow`（waitMs=0 立即返回持久句柄）/ `flowagent_get_run`（轮询）/ `flowagent_refresh_tools`（热同步新工作流）/ `flowagent_run_<workflowId>`（每个工作流一个专属工具）。
长任务不必阻塞会话：runId 跨进程持久，随时回来查询或回放。

## 示例工作流

三个开箱即用的 demo（`demo/workflows/`）：

| Demo | 展示能力 | 依赖 |
|------|----------|------|
| 旗舰·多模型协作流水线 | 廉价模型规划 → 视觉/搜索 Agent 并行 → Human 审查 → 强模型汇总 | openai + aggregator 两个 Provider；search Server |
| 深度研究 | Loop 多轮检索 + 交叉汇总 + 报告生成 | aggregator Provider；search/report Server |
| 代码审查 | 条件分支 + 高风险转人工审批 | 任一 Provider（默认 openai） |

一条命令导入（需 server 已启动）：

```bash
pnpm seed:demos        # 按名称幂等，重复执行只跳过不覆盖
```

或在画布编辑器里用「导入 JSON」按钮导入 `demo/workflows/*.json`，「导出 JSON」可把当前画布存为文件分享。

首次运行前：`.env` 按示例配置 Provider（聚合平台一把 key 即可），在 MCP Servers 页手动添加 search/sandbox/report 连接（先 `pnpm build` 生成 dist，命令用绝对路径，示例见 `.env.example` 注释）。

运行输入：三个 demo 分别消费 `input.topic`（旗舰/深度研究）与 `input.diff`（代码审查）。Web UI 的「▶ 运行」会先弹出输入对话框，直接填 JSON（如 `{"topic": "MCP 生态现状"}`）即可；也可走 API：

```bash
curl -X POST http://localhost:3000/api/workflows/<工作流id>/runs \
  -H 'Content-Type: application/json' \
  -d '{"input":{"topic":"MCP 生态现状"}}'
```

（或经 Workflow→MCP Bridge 的工具 `input` 参数传入。）

> 注：画布「导入 JSON → 保存」会完整保留节点级 `timeoutMs`/`retry` 字段（暂存于节点内部，导出时还原）；Loop 子图经属性面板的「子图 JSON」配置。

## Non-Goals

刻意不做：RAG/知识库节点、应用发布、模板市场、多租户、协作编辑。
FlowAgent 是执行运行时而非应用平台——不拼功能广度，把持久化执行、多模型路由、双向 MCP 做深。

## Roadmap

- [x] v0.1 — Monorepo 脚手架 + Workflow CRUD + MCP Gateway
- [x] v0.2 — DAG 编辑器 + Execution Engine（事件溯源）
- [x] v0.3 — Checkpoint/Resume + Human-in-the-loop + 回放时间轴
- [ ] v0.4 — Workflow→MCP Bridge + 示例工作流 + Docker 部署

完整十周计划见 [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md#8-十周开发路线)。

## 开发

```bash
pnpm build          # 构建所有包（Turborepo）
pnpm test           # Vitest 单测
pnpm lint           # ESLint + Prettier 检查
```

贡献指南与架构文档见 [docs/](docs/)。

## License

[MIT](LICENSE)

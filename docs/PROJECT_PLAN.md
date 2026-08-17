# FlowAgent 项目计划（v2.1 定稿）

> **一句话定位**：一个面向 MCP 生态的持久化 Agent 执行运行时（Durable Agent Runtime）——事件溯源、断点恢复、人工介入、多模型路由、工具动态发现。可视化画布是它的前端，不是它的本体。
>
> **面试锚点**：把 Temporal 式 durable execution 思想引入 MCP 原生多模型 Agent 编排。

---

## 1. 背景与动机

- **MCP（Model Context Protocol）** 已成为工具调用的事实标准（Anthropic 推出，OpenAI/Google 跟进），生态里已有数百个现成 MCP Server。
- **AI 应用层的可视化编排**（Dify/Flowise/n8n/Langflow）已经成熟，单纯复刻没有竞争力。
- **尚未被做深的空白**：Agent 工作流的**可靠执行**——进程崩溃后断点恢复、长时间挂起等待人工审批、执行过程可回放审计、长任务不依赖单次会话。这正是 Temporal/Restate 在传统工作流领域解决的问题，在 Agent 领域仍是稀缺品。
- MCP 2026-07-28 新规范（stateless 协议核心、Tasks 长任务扩展、subscriptions 变更通知）让"持久化执行 + MCP"在协议层天然契合，时机正确。

## 2. 竞品分析与差异化

### 2.1 与可视化编排平台（Dify / Flowise / n8n / Langflow）

不竞争功能广度（RAG、应用发布、模板市场、多租户），聚焦把三件事做深：

| # | 差异点 | 说明 |
|---|--------|------|
| 1 | **Durable Execution**（核心） | 事件溯源记录执行 → checkpoint → 断点恢复/主动暂停/Human 挂起恢复；免费获得执行回放时间轴视图 |
| 2 | **多模型编排** | 每个 Agent 节点独立绑定 Provider + 模型（OpenAI 兼容路由），按任务选模型（便宜模型规划、视觉模型看图、强模型终审） |
| 3 | **MCP 运行时动态发现** | 工具不静态写死：Server 连接后自动 discovery 注册进工具注册表，支持热更新，对齐 2026-07-28 规范 |
| 4 | **双向 MCP** | 向下：编排任意 MCP 工具；向上：把整个工作流反向暴露为 MCP Server，供 Claude Code/Codex 等作为工具调用 |

### 2.2 与交互式 Agent（Claude Code / Codex）

它们是**交互式应用**（人会话驱动），我们是**运行时/平台**（定义一次、无人值守、可重复执行）：

| 维度 | Claude Code / Codex | FlowAgent |
|------|--------------------|-----------|
| 执行模式 | 会话内即时执行，人驱动 | API/定时/手动触发，无人值守跑完整个 DAG |
| 持久性 | 会话结束/崩溃 ≈ 从头来 | 事件溯源 + checkpoint，重启后断点恢复 |
| Agent 结构 | 单主循环 + 临时 subagent（不可编排） | 显式 DAG：并行/条件/循环，自由组合 |
| 模型 | 单厂商锁定 | 每节点任意 OpenAI 兼容模型 |
| Human 介入 | 本质是人在聊天 | 挂起→审批→恢复是一等公民语义，可等数小时数天 |
| 长任务 | 单会话 context 会爆 | 每节点独立 context |

**类比**：Claude Code 之于 FlowAgent，就像 bash 之于 GitHub Actions/Temporal——交互式执行 vs 可重复、可恢复、无人值守的编排执行，是两种真实需求。

### 2.3 与 Agent Skills

| 维度 | Skill | 暴露为 MCP Server 的工作流 |
|------|-------|--------------------------|
| 本质 | 提示词级：注入操作指南 | 协议级：标准服务端点 |
| 执行者 | 宿主 Agent 自己的会话循环 | FlowAgent 运行时，独立进程 |
| Context 成本 | 中间步骤吃宿主 context | 宿主只收最终结果 |
| 持久性 | 随会话生死 | checkpoint，可挂起可恢复 |

两者是组合关系而非竞争：Skill 提供"何时调用"的判断，MCP 工作流提供"怎么干"的能力。

## 3. 核心架构

```
┌──────── Web：DAG 画布(React Flow) + 运行监控 + 执行回放时间轴 ────────┐
└──────────────── REST + SSE(执行事件流) + WS(Human 交互) ─────────────┘
┌─────────────────────────── Server (NestJS + TS) ──────────────────────┐
│ Workflow 模块 │ Run 模块 │ Event Store(事件溯源) │ LLM Adapter(多模型路由) │
│                                                                        │
│ Execution Engine:                                                        │
│   事件驱动状态机 → 拓扑调度 → 并行/条件/Loop → checkpoint → resume         │
│   节点级: 重试(指数退避)/超时/挂起等待 Human                               │
│                                                                        │
│ MCP Gateway: 运行时 discovery 动态注册 → 工具注册表(热更新) → 调用路由     │
│ Workflow→MCP Bridge: 工作流反向暴露为 MCP Server（供 Claude Code 调用）  │
└──────────────── MCP (stdio + Streamable HTTP) ────────────────────────┘
┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│ 官方FS │ │ 搜索器 │ │ 代码沙箱│ │ 报告生成│  ← 生态 Server + 自带 demo Server
└────────┘ └────────┘ └────────┘ └────────┘
```

### 3.1 Durable Execution 设计（核心卖点）

- 每次状态变更是不可变事件（`NODE_STARTED` / `LLM_TOKEN` / `TOOL_CALLED` / `NODE_SUCCEEDED` / `RUN_SUSENDED` …），追加写入 SQLite
- 节点/运行状态 = 事件回放的投影；checkpoint = 事件序号；恢复 = 重放事件重建状态后继续调度
- 三种恢复路径统一为一套机制：**失败断点恢复 / 主动暂停恢复 / Human 挂起恢复**
- 前端时间轴回放视图直接消费事件流

### 3.2 多模型路由

- Provider 配置表：`baseURL + apiKey 引用`（支持聚合平台，一把 key 调多模型）
- Agent 节点独立配置 `provider + model`；单 Provider 用户退化为普通单模型工作流，零门槛

### 3.3 MCP Gateway

- 双传输：stdio（本地进程）+ Streamable HTTP（远程）
- 连接生命周期管理、工具命名空间去重、调用路由
- 对齐 2026-07-28：stateless discovery、`subscriptions/listen` 工具热更新、Tasks 扩展（长任务持久句柄 ↔ checkpoint 对齐）

### 3.4 Workflow→MCP Bridge

- 引擎侧起 MCP Server，把已保存工作流暴露为 tool（`flowagent_run:<workflow_id>`）
- 长耗时工作流走 Tasks 模式（持久句柄 + 轮询）
- README 演示：Claude Code 一行配置调用 FlowAgent 工作流

## 4. 节点类型（8 种，刻意不膨胀）

| 节点 | 职责 |
|------|------|
| Start / End | 输入输出边界 |
| **Agent** | LLM + ReAct 循环 + 绑定 MCP 工具 + 独立模型配置 + Memory |
| LLM | 纯文本变换，无工具 |
| Tool | 直调单个 MCP 工具 |
| Condition | 表达式条件分支 |
| Loop | 子图迭代（主图保持严格 DAG，环语义收敛于此） |
| **Human** | 挂起等待审批/补充输入 |
| Transform | 数据映射（`{{node_x.output}}` 模板语法） |

## 5. Non-Goals（明确不做）

RAG/知识库节点、应用发布、模板市场、多租户、协作编辑。
理由：不与 Dify 拼功能广度；聚焦运行时深度。此节写进 README 体现判断力。

## 6. 技术栈

| 层 | 选型 |
|----|------|
| Monorepo | pnpm + Turborepo |
| 后端 | NestJS + TypeScript |
| 前端 | React 18 + Vite + @xyflow/react（React Flow） |
| UI | Tailwind CSS + shadcn/ui |
| LLM | OpenAI 兼容客户端（自定义 baseURL，支持聚合平台） |
| MCP | @modelcontextprotocol/sdk（stdio + Streamable HTTP） |
| 数据库 | SQLite + Prisma |
| 实时 | SSE（执行事件流）+ WebSocket（Human 交互） |
| 质量 | Vitest + ESLint + Prettier + GitHub Actions CI |
| 交付 | Docker Compose 一键部署 |

## 7. 目录结构

```
flowagent/
├── apps/
│   ├── server/            # NestJS（workflow/engine/mcp/llm/runs 模块）
│   └── web/               # React（canvas/panels/run）
├── packages/
│   └── shared/            # 工作流 JSON Schema、事件类型（前后端共享）
├── servers/               # 3 个 demo MCP Server（search/sandbox/report）
├── docs/                  # 项目文档
├── docker-compose.yml
└── .github/workflows/ci.yml
```

## 8. 十周开发路线

| 周 | 里程碑 | 交付物 |
|----|--------|--------|
| 1 | Monorepo 脚手架 + CI | pnpm+turbo、NestJS/Vite 模板、Prisma schema、Workflow CRUD |
| 2-3 | MCP Gateway | 双传输连接管理、动态发现、工具注册表（热更新）、Server 配置 UI |
| 4-5 | DAG 编辑器 | 画布/节点面板/属性面板、环检测校验、保存加载 |
| 6-7 | Execution Engine ★ | 事件溯源 Event Store、拓扑调度、并行/条件/Loop、Agent 节点 ReAct、多模型路由、SSE 事件流 |
| 8 | 持久化执行 | checkpoint/resume 三路径、Human 挂起、重试 + 回放时间轴 UI |
| 9 | Demo 与 Bridge | 3 个 demo MCP Server、多模型协作旗舰工作流、Workflow→MCP Bridge、UI 打磨 |
| 10 | 开源交付 | Docker 一键部署、README（架构图/GIF/Non-Goals）、引擎单测、v0.1 发布 |

**旗舰 Demo（多模型协作流水线）**：规划 Agent（廉价模型）→ 视觉 Agent + 搜索 Agent 并行 → Human 审查 → 汇总 Agent。具体模型绑定由用户自选（DeepSeek/MIMO/任意），流水线本身是能力示例。

**辅助 Demo**：深度研究（Loop 节点 + 工具编排）、代码审查（条件分支 + Human 审批）。

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| Agent 节点 ReAct 循环（LLM↔工具多轮）复杂 | 先用 OpenAI function calling 标准循环，第 6 周集中攻坚 |
| DAG 任意成环难以调度 | 循环语义收敛为 Loop 节点（子图迭代），主图保持严格 DAG |
| 聚合平台 API 不稳定 | Adapter 层超时/降级，支持多 Provider 切换 |
| 2-3 个月时间紧 | 每周末尾有可运行版本，第 9-10 周为弹性缓冲 |

## 10. 面试 FAQ（预置）

- **为什么不用 Dify？** 定位不同：Dify 是应用平台拼广度，FlowAgent 是执行运行时拼深度（durable execution / 多模型路由 / 双向 MCP）。
- **和 Claude Code 什么关系？** 互补。Claude Code 是交互式 MCP 客户端；FlowAgent 是无人值守的编排运行时，且能把工作流变成 Claude Code 可调用的 MCP 工具——它成了我的客户端。
- **和 Skill 什么区别？** Skill 是提示词级、吃宿主 context、随会话生死；工作流是协议级、独立进程、可挂起恢复。见 §2.3。
- **多模型是不是要买很多 API？** 不用。聚合平台（OpenRouter 等）一把 key 一个 baseURL 即可；只用一家也完全可用。

## 11. 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | — | 可视化 MCP Agent 编排平台（初版） |
| v2 | — | 重新定位为 Durable Agent Runtime；差异化三点；砍掉广度功能 |
| v2.1 | — | 新增 Workflow→MCP Bridge（双向 MCP）；补充 Skill 对比；旗舰 Demo 定为多模型协作流水线 |

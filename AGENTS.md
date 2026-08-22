# AGENTS.md

面向在本仓库工作的 AI 编码代理（opencode / Codex / Claude Code 等）的协作指南。人类开发者同样适用。

## 项目概要

FlowAgent 是一个 MCP 原生的多模型 Agent 工作流运行时（Durable Agent Runtime）。核心卖点按优先级：

1. **Durable Execution**：事件溯源 Event Store、checkpoint、三种恢复路径（失败断点 / 主动暂停 / Human 挂起）
2. **多模型路由**：每个 Agent 节点独立 Provider + 模型，OpenAI 兼容适配层
3. **MCP 运行时动态发现**：对齐 MCP 2026-07-28 规范（stateless discovery、subscriptions、Tasks）
4. **双向 MCP**：Workflow→MCP Bridge 把工作流反向暴露为 MCP Server

**动手前必读**：[docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md)——定位、架构、Non-Goals、十周路线都在里面。所有实现决策不得与该文档冲突；若确需偏离，先更新文档再改代码。

## 目录结构

```
apps/server     NestJS 后端（workflow / engine / mcp / llm / runs 模块）
apps/web        React + Vite + @xyflow/react 前端
packages/shared 前后端共享类型：工作流 JSON Schema、事件类型
servers/        自带的 demo MCP Server（search / sandbox / report）
docs/           项目文档（计划、架构决策、FAQ）
```

## 常用命令

```bash
pnpm install          # 安装依赖（只用 pnpm，不要引入 npm/yarn lockfile）
pnpm dev              # 并行启动 server(:3000) 与 web(:5173)
pnpm build            # 构建所有包（Turborepo 编排）
pnpm test             # Vitest 单测
pnpm lint             # ESLint + Prettier
```

> 脚手架落地前（第 1 周之前）这些命令可能尚不可用，落地的包内命令以各自 package.json 为准。

## 技术约束

- **语言**：全 TypeScript strict 模式（基座 tsconfig.base.json），禁止 `any`（确需逃逸用 `unknown` + 收窄）
- **后端**：NestJS 模块化，遵循依赖注入；新功能先建模块再挂路由
- **前端**：React 18 + @xyflow/react；UI 用 Tailwind CSS 自绘轻量组件，不引入重组件库
- **LLM 调用**：只通过 LLM Adapter（OpenAI 兼容 + 自定义 baseURL），任何模块不得直接 import 厂商 SDK
- **MCP**：只用 @modelcontextprotocol/sdk；工具调用必须经过 MCP Gateway 的工具注册表路由
- **数据库**：Prisma；改 schema 必须附迁移；事件表只追加（append-only），禁止 UPDATE/DELETE
- **共享类型**：工作流定义、事件类型的唯一事实源在 packages/shared，前后端只从那里 import

## 架构红线

- **主图必须是严格 DAG**：循环语义只存在于 Loop 节点（子图迭代），画布保存前必须做环检测
- **执行引擎的状态只能通过事件投影获得**：禁止在引擎里维护绕过 Event Store 的可变全局状态
- **Human 挂起 = 持久化挂起**：挂起状态必须落库，进程重启后仍可恢复，不许依赖内存
- **Non-Goals 是硬约束**：不做 RAG/知识库节点、应用发布、模板市场、多租户、协作编辑。收到相关需求时拒绝并引用 docs/PROJECT_PLAN.md §5

## 代码风格

- 提交信息：Conventional Commits 类型前缀 + 中文描述（如 `feat: 实现事件溯源存储`），类型含 `feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`
- 文件命名：组件 PascalCase，其余 camelCase/kebab-case 从包内既有惯例
- 不写无关注释；公共 API 用 TSDoc
- 每个包自带 Vitest；引擎核心（调度器、事件回放、恢复逻辑）改动必须带单测

## 安全

- API key 只存于环境变量 / Provider 配置表（加密存储），严禁写入代码、日志、事件流或提交到仓库
- MCP Server 的 stdio 命令与 HTTP URL 来自用户配置，渲染与执行前必须校验
- 代码沙箱 demo Server 的执行环境必须隔离（容器/子进程限额），不得直接 eval 用户输入

## 文档同步

- 影响架构/定位/路线的变更 → 更新 docs/PROJECT_PLAN.md（含版本变更记录）
- 新增模块/重大接口 → 在 docs/ 下补一页说明
- README 的特性列表与 Roadmap 勾选状态随里程碑同步

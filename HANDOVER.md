# 交接文档：第 8 周「持久化执行」实施（未完成）

> 交接时间：2026-08-22。前序 agent 已完成调研、总体计划、shared 契约演进与投影扩展；
> **调度器重构尚未动笔**。本文档固化全部设计决策与实现细节，接手者按 §4 步骤继续即可。
> 总体计划见 [docs/DURABLE_EXECUTION.md](docs/DURABLE_EXECUTION.md)（已写入，含背景/差距表）。

## 0. 一句话现状

第 1–7 周里程碑全部落地（见 git log）。当前在实施 PROJECT_PLAN 第 8 周里程碑：
**checkpoint/resume 三路径统一机制、Human 挂起持久化、节点级超时重试、回放时间轴 UI**。
shared 与投影层的契约改动已完成且编译通过；引擎/控制面/API/前端/测试均未开始。

## 1. 已完成的改动（未提交，工作区即现状）

| 文件 | 改动 |
|------|------|
| `docs/DURABLE_EXECUTION.md` | 新建。总体设计：投影驱动可续调度器、checkpoint 语义、三路径 API 表、韧性策略、快照列 |
| `packages/shared/src/events.ts` | 新增事件类型 `NODE_RETRYING`；新增 `NodeRetryingPayload { nodeId, nodeType, attempt, maxAttempts, delayMs, error }` |
| `packages/shared/src/workflow.ts` | 新增 `NodeRetryPolicy { maxAttempts, initialDelayMs?, backoffFactor?, maxDelayMs? }`；`WorkflowNodeBase` 增加 `timeoutMs?: number` 与 `retry?: NodeRetryPolicy` |
| `packages/shared/src/schema.ts` | JSON Schema 同步：nodes.items 增加 `timeoutMs`（minimum 1）与 `retry` 对象校验（maxAttempts 1–20 等） |
| `packages/shared/src/runs.ts` | 新增 `RunWaitingHuman { nodeId, nodeType, name, prompt }`；`RunSummary.waitingHuman: RunWaitingHuman \| null`；`HumanInputRequest { approved, input? }` |
| `apps/server/src/engine/projection.ts` | `ProjectedNodeState` 增加 `humanInput?: unknown` / `approved?: boolean`；`HUMAN_INPUT_RECEIVED` 分支捕获二者；文件末尾新增 `isTerminalRunStatus()` |

`pnpm --filter @flowagent/shared build` 已验证通过。**改完之后还没跑过全量 test/lint**。

## 2. 核心设计（必读）

**调度器改为「投影驱动、可重入」**：`execute()` 每次先回放该 run 的全部事件重建调度记账，
再从断点继续。首次运行 = 空投影的退化情形。三条恢复路径统一为：
**控制面追加一条恢复事件 → 重入 `execute()`**。所有控制动作都是追加事件，绝不 UPDATE 现有行（架构红线）。

### 2.1 checkpoint 语义
- checkpoint = 已消费的最大事件 seq。
- 每个节点 settle（成功/跳过/失败/挂起）后发射 `CHECKPOINT_SAVED`，payload `{ seq }`
  **注意：seq 必须是发射前最后一条已持久化事件的序号，即闭包变量 `seq - 1`**（emit 会先占用当前 seq 再自增）。

### 2.2 三条恢复路径 + 取消（API 设计）

| 路径 | API（POST） | 允许的前置状态（查 DB 缓存或投影） | 行为 |
|------|------------|-----------------------------------|------|
| Human 审批 | `/runs/:id/human-input` body=`HumanInputRequest` | `waiting_human` | approved=true → 追加 `HUMAN_INPUT_RECEIVED{nodeId:投影.waitingHumanNodeId, approved:true, input}` → 追加 `RUN_RESUMED{mode:'human'}` → 调 `engine.execute(runId)`；approved=false → 直接追加 `HUMAN_INPUT_RECEIVED` + `NODE_FAILED{error:'审批被拒绝'}` + `RUN_FAILED`（不重入引擎），之后可走 retry 路径 |
| 主动暂停 | `/runs/:id/pause` | 引擎正在跑（内存 running 集合内有该 run） | 仅设置内存暂停标志；主循环在调度间隙停机后补发 `RUN_SUSPENDED{reason:'paused'}`。不在运行中 → 409 |
| 恢复 | `/runs/:id/resume` | `suspended`（paused 或 crash） | 追加 `RUN_RESUMED{mode:'resume'}` → `execute(runId)` |
| 失败断点重试 | `/runs/:id/retry` | `failed` | 追加 `RUN_RESUMED{mode:'retry_failed'}` → `execute(runId)` |
| 取消 | `/runs/:id/cancel` | 任一非终态 | 引擎在跑 → 设取消标志，in-flight 排空后由主循环发 `RUN_CANCELED`；不在跑 → 直接追加 `RUN_CANCELED` 并 sync |

冲突一律抛 `ConflictException`（@nestjs/common），run 不存在抛 `NotFoundException`。
状态检查与追加事件之间存在极小的并发窗口（两次 await 之间），v0.1 接受此竞态，
用 `running.has(runId)` 做二次防御即可（execute 入口已有幂等守卫）。

### 2.3 崩溃对账（进程重启）
`RunsService.onModuleInit` 现有的 `reconcileOrphanRuns()` 改造：对 DB status ∈ {pending, running}
的孤儿 run **追加** `RUN_SUSPENDED{reason:'crash'}` 事件再 syncFromProjection（替换现在的静默对账）。
append-only 安全；若事件流真实状态是 waiting_human，投影 fold 中
`RUN_SUSPENDED` 分支有 `if (status !== 'waiting_human')` 守卫，不会覆盖 ✓。
恢复方式 = 用户手动调 resume API。

## 3. ★ 调度器重构规格（apps/server/src/engine/scheduler.ts 全量重写）

这是本阶段唯一复杂件，算法细节如下（已推演过与现运行时行为的逐位等价性，勿简化）：

### 3.1 签名变化
```ts
async execute(runId: string): Promise<void>   // 不再收 workflowId/input
```
内部流程：
1. `prisma.workflowRun.findUnique(runId)` 取 run 行（不存在 → 记 error 日志并终止）。
2. definition 来源：**优先 `run.definitionSnapshot`**，为 null 时回退 `workflow.definition`
   （快照列见 §5，回退保证旧数据可用）。解析失败/校验失败 → terminate RUN_FAILED（沿用现有逻辑）。
3. `eventStore.readEvents(runId)` → `projectRunState` 得到投影。
4. **幂等守卫**：投影已是终态（`isTerminalRunStatus`）→ 直接 return。
5. 从 events 里取最后一次 `RUN_RESUMED` 的 payload.mode（倒序 find），得 `rearmFailedNodes = mode === 'retry_failed'`。
6. 用 `rebuildSchedulingWorkset(definition, projected, { rearmFailedNodes })` 重建记账（§3.2）。
7. 进入主循环（结构同现有版本），新增暂停/取消守卫与 checkpoint 发射（§3.3/§3.4）。

### 3.2 rebuildSchedulingWorkset（导出纯函数，便于单测）

```ts
interface SchedulingWorkset {
  nodeOutputs: Record<string, unknown>;
  indegree: Map<string, number>;      // 可变记账
  adjacency: Map<string, string[]>;
  ready: string[];                    // 初始种子 + 处理过程中动态 push
  waitingHumanNodeId: string | null;  // 投影中仍未决的挂起锚点
}
```

处理顺序：**对 `topoSort(nodes, edges)` 结果单遍扫描**（topoSort 已存在，保持模块内复用）。
先复制一份原始入度（`initialIndegree`）用于种子判定，然后在副本上做减法记账：

对每个节点按其投影 status 分派：

- **succeeded**
  - `nodeOutputs[id] = { output: state.output }`；记录 `lastUpstream = id`（扫描结束后写
    `nodeOutputs['__last_upstream__'] = { output: 该节点output }`，供 end 节点默认输出语义）。
  - 普通节点：每条出边目标执行 `settleDecrement(target)`（见下）。
  - condition 节点：读 `state.output.selected`；出边 sourceHandle===selected →
    `settleDecrement(target)`；否则 → `killSubtree(target)`（不发 SKIPPED 事件，历史里已有）。
- **skipped**：`killSubtree(id)`。
- **suspended 且 `projected.waitingHumanNodeId === id`**：什么都不做（排除在 ready 外，
  下游靠入度饥饿天然不调度）；workset.waitingHumanNodeId = id。
- **running**（两种情形）
  - human 节点且 `state.approved === true`：视作已解决 →
    `nodeOutputs[id] = { output: state.humanInput ?? null }`，出边逐个 settleDecrement。
    （rejected 的运行已是终态，不会走到这。）
  - 其余：崩溃残留 → 视作待执行，不动作（入度归零时进 ready，即断点重跑语义）。
- **failed**：`rearmFailedNodes === true` → 视作待执行（不动作）；否则排除（防御分支，正常流走不到）。
- **idle**：不动作。

两个记账原语（**必须与运行期行为逐位一致**）：

```ts
// 正常结算：减一；归零且目标是“可执行态”则 push 进 ready
const settleDecrement = (target: string): void => {
  const remaining = indegree.get(target)! - 1;
  indegree.set(target, remaining);
  if (remaining === 0 && isRunnable(target)) ready.push(target);
};

// 剪枝链记账：等价于运行期 skipDownstream —— 减一，仅当恰好归零时递归；
// ★ 关键：永远不 push ready。否则“被剪枝子树的下游”会因入度归零而被错误调度
const killSubtree = (id: string): void => {
  for (const target of adjacency.get(id) ?? []) {
    const remaining = indegree.get(target)! - 1;
    indegree.set(target, remaining);
    if (remaining === 0) killSubtree(target);
  }
};

const isRunnable = (id: string): boolean => {
  const st = projected.nodes.get(id)?.status ?? 'idle';
  return st === 'idle' || st === 'running' || (st === 'failed' && rearmFailedNodes);
};
```

种子：扫描前把 `initialIndegree === 0` 且 `isRunnable` 的节点放入 ready。
（注意：join 语义自动正确——某节点若有一条入边来自被剪枝链、另一条来自正常完成的上游，
killSubtree 先减一次不 push，正常上游 settle 时再减到 0 会 push，与运行期一致。）

变量重建：`variables` 仍从 `definition.variables` 默认值初始化（与现状一致）。

### 3.3 主循环改造（在现有循环体上增量）

新增内存标志集合（EngineService 字段）：
```ts
private readonly pauseRequested = new Set<string>();
private readonly cancelRequested = new Set<string>();
```

- `stopDispatching = () => aborted || humanSuspended || cancelRequested.has(runId) || pauseRequested.has(runId)`；
  内外两层 while 的续跑条件都要带上它。
- `executeNode` 内部：
  - 执行调用包一层 `runWithResilience(node, attemptFn, emit)`（§3.4）。
  - 成功路径：写 nodeOutputs 后发射 `CHECKPOINT_SAVED { seq: seq - 1 }`。
  - condition 分支剪枝里每次 emit `NODE_SKIPPED` 后也各发一次 CHECKPOINT_SAVED（同 payload 规则）。
  - 失败路径：NODE_FAILED 后、RUN_FAILED 前，同样发 CHECKPOINT_SAVED。
  - Human 挂起路径：RUN_SUSPENDED{reason:'human'} 后发 CHECKPOINT_SAVED，置 `humanSuspended = true`。
- 循环排空后（`Promise.allSettled(inflight)` 之后）按优先级收尾：
  1. `cancelRequested.has(runId)` → 删除两标志，追加 `RUN_CANCELED{reason:'user'}`，syncFromProjection，return；
  2. 删除 pauseRequested；若有待发暂停（即本轮确实因暂停标志停机且无其他终止态）→ 追加
     `RUN_SUSPENDED{reason:'paused'}`，sync，return；
     （简单化：只要不是 canceled/aborted/humanSuspended 且 pause 标志曾被置位就发 paused；
     用局部布尔 `pauseSeen` 记录循环中是否观察到过该标志，避免误发。）
  3. `aborted` → return（RUN_FAILED 已发）；
  4. `humanSuspended` → sync，return（RUN_SUSPENDED 已发）；
  5. `workset.waitingHumanNodeId !== null` → sync，return（恢复轮次仍有历史挂起锚点，如崩溃于 waiting_human）；
  6. 否则按现有逻辑取 end 输出 → terminate RUN_COMPLETED。

### 3.4 韧性包装：超时 + 重试指数退避

```ts
private async runWithResilience(
  node: WorkflowNode,
  attempt: () => Promise<NodeExecutionResult>,
  emit: EmitFn,
): Promise<NodeExecutionResult>
```
- **human 节点直接透传**（挂起即业务语义，不吃超时/重试）。
- 解析 `node.retry`（`normalizeRetryPolicy`）：非法/缺失 → null（= 只试一次）；
  默认值 `initialDelayMs=500, backoffFactor=2, maxDelayMs=30_000`。
- 单次尝试 = `withTimeout(attempt(), node.timeoutMs, \`节点 ${node.id} 执行超时(${timeoutMs}ms)\`)`。
  withTimeout 用 `Promise.race` + setTimeout，`.finally` 里 clearTimeout 防句柄泄漏。
- 失败且还有剩余次数：`delay = min(round(initialDelayMs * backoffFactor^(attempt-1)), maxDelayMs)`，
  先 `emit('NODE_RETRYING', { nodeId, nodeType, attempt: 下一次序号, maxAttempts, delayMs, error })`
  再 `await sleep(delay)`（sleep = setTimeout Promise），attempt++ 继续。
- 耗尽：向上抛原错误（executeNode 现有 catch 负责 NODE_FAILED/RUN_FAILED）。
- 注意：executor 内部发的 LLM_REQUESTED/TOOL_CALLED 等审计事件每次尝试都会重复出现——这是期望行为。

## 4. 待办步骤（建议顺序与提交切分）

1. **Prisma 迁移**：`WorkflowRun` 增加 `definitionSnapshot String?`。
   在 apps/server 下 `pnpm exec prisma migrate dev --name add_run_definition_snapshot`
   （确认 .env DATABASE_URL 指向 prisma/data/flowagent.db）。迁移文件必须随代码提交。
2. **RunsService.startRun** 落库时写入 `definitionSnapshot: workflow.definition`。
3. **重写 scheduler.ts**（严格按 §3）。同时更新既有
   `apps/server/test/scheduler.test.ts`：`makeEngine` 的 prismaStub 需增加
   `workflowRun: { findUnique: async () => ({ id:'run_1', definitionSnapshot: JSON.stringify(definition), ... }) }`，
   所有用例改为 `engine.execute('run_1')`（不再传 workflowId/input）。现有 8 个用例语义应全部不变。
4. **EngineService 增加控制方法**：`pause/cancel/resume/retryFailed/submitHumanInput(runId, req)`
   （§2.2 行为表）。投影加载复用 `readEvents + projectRunState`。
5. **新建 `apps/server/src/engine/run-control.controller.ts`**（挂在 EngineModule controllers）：
   五条 POST 路由（§2.2）。EngineModule 已 import RunsModule，可直接注入 RunsService 做 sync。
6. **RunsService.toSummary** 填充 `waitingHuman`：status 为 waiting_human 时，从事件流找最后一条
   `HUMAN_WAITING`，取 payload.prompt + 节点元信息（loadNodeMetas 已有）；其余情况 null。
7. **崩溃对账改造**（§2.3）。
8. **单测**（vitest，test/ 目录，MemoryEventStore 模式照抄 scheduler.test.ts）：
   - resume.test：start→transform→human 挂起 → 手工 append HUMAN_INPUT_RECEIVED+RUN_RESUMED → execute → completed，
     断言 end 输出使用了 human 提交的 input；rejected 流程产出 RUN_FAILED。
   - retry.test：transform 带 retry{maxAttempts:3, initialDelayMs:1}，用可控失败的 executor 场景
     （如 template 引用不存在字段会稳定抛错——不行，那会一直失败；可让第一次 LLM 抛错第二次成功的 llmAdapter stub），
     断言 NODE_RETRYING 事件数与最终成功；指数退避 delay 序列断言（纯函数可直测 retryDelayMs，需导出）。
   - pause.test：需要让某个节点执行变慢以便在飞行中调 pause——给 transform 无法注入延迟，
     可测「暂停发生在 dispatch 边界」：execute 前 pauseRequested.add(runId)，断言产出
     RUN_SUSPENDED{reason:'paused'} 且无节点执行；再 resume 完成。
   - crash.test：构造半途事件流（手工 append 到 NODE_SUCCEEDED(t1) 为止），execute(runId) 应只执行剩余节点。
9. **前端**：
   - `apps/web/src/api/runs.ts` 增加 pause/resume/retry/cancel/humanInput 五个方法（POST JSON）。
   - RunDetailPage：header 加操作栏，按 summary.status 条件渲染
     （running→暂停/取消；suspended→恢复/取消；failed→重试/取消；waiting_human→审批表单(批准/拒绝+可选输入 textarea)/取消）。
     操作后刷新 summary。waitingHuman 数据已在 RunSummary 上。
   - 回放时间轴：终态 run 显示播放控件（播放/暂停/步进/滑块 range 0..events.length）。
     节点看板随回放位置联动：web 侧需要一个轻量事件折叠 reducer
     （server 的 projection.ts 在 apps/server 内不可跨包引用；务实做法：在 apps/web/src/runs/
     复制一个 ~50 行的 reduce 版本，或后续把 projection 提升进 packages/shared——本次不做提升）。
   - SSE done/onerror 后刷新 summary 的逻辑保留。
10. **文档同步**：PROJECT_PLAN.md §11 变更记录加一行（v2.1 → 本次不改版本号，追加说明第 8 周落地）；
    README roadmap 若有勾选项同步；docs/DURABLE_EXECUTION.md 如实现有偏差回改。
11. **全量验证**：`pnpm test && pnpm lint && pnpm build`。
12. **提交**（仓库约定：Conventional Commits + 中文描述，仅在用户要求时提交）：
    建议 `feat: 持久化执行——checkpoint/resume 三路径、Human 审批、节点超时重试` +
    `feat: 运行详情页操作栏与回放时间轴` + `docs: 第 8 周持久化执行设计与交接`。

## 5. 关键陷阱清单（踩过的坑/想清楚的点）

- `CHECKPOINT_SAVED.payload.seq` 必须是 `seq - 1`（emit 闭包先占号再自增），语义是“已消费到的序号”。
- killSubtree 绝不能 push ready——否则条件分支被剪掉的孙子节点会在入度归零后被误调度（运行期靠饥饿规避，回放必须保真）。
- ready 不能在扫描结束后统一计算，必须在 settleDeccrement 时动态 push（join 语义才与运行期一致）。
- 崩溃残留的 `running` 状态节点 = 断点重跑；但 human 节点 `running && approved===true` 是已解决挂起，两者必须区分（靠投影新字段 approved/humanInput）。
- RUN_SUSPENDED 对 waiting_human 无效：projection fold 有守卫，崩溃对账可以无脑 append。
- Human 节点忽略 timeoutMs/retry（runWithResilience 开头短路）。
- 旧测试 `makeEngine` 直接 new EngineService 且按位置传参——签名变更后必须同步改（§4.3）。
- 事件表 append-only 是红线；所有控制面动作只能追加事件，DB 缓存字段只经 syncFromProjection 更新。
- Loop 子图内部不落独立节点事件（runSubgraph 不 emit NODE_STARTED），因此 loop 中途崩溃恢复 = 整个 loop 节点重跑，属已知边界，文档里注明即可。
- 包管理只用 pnpm；禁止 `any`（逃逸用 unknown + 收窄）；不加无关注释。

## 6. 环境速查

- 启动：`pnpm dev`（server :3000 / web :5173）；测试：`pnpm test`；构建：`pnpm build`。
- shared 构建单独跑：`pnpm --filter @flowagent/shared build`（server/web 依赖其 dist）。
- vitest 配置：apps/server/vitest.config.ts，include `test/**/*.test.ts`，swc 插件。
- 本机没有 rg，grep 工具用内置 Grep。

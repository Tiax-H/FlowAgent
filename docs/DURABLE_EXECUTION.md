# Durable Execution 设计与实施（第 8 周）

> 对应 docs/PROJECT_PLAN.md §8 路线第 8 周里程碑：checkpoint/resume 三路径、Human 挂起持久化、节点重试 + 回放时间轴 UI。

## 1. 现状与差距

| 能力 | 现状 | 差距 |
|------|------|------|
| Event Store | append-only，seq 运行内单调 | ✓ |
| 投影 | `projectRunState` 纯函数回放 | ✓ |
| Human 挂起 | 发 `HUMAN_WAITING`/`RUN_SUSPENDED` 后停机 | 无恢复入口，挂起不可继续 |
| 失败 | `NODE_FAILED` → `RUN_FAILED` 即终止 | 无节点级重试、无断点续跑 |
| 暂停 | 无 | 无主动 pause/resume |
| 崩溃对账 | 启动时把孤儿 running 改缓存字段 | 不发事件（违反"状态=投影"），不可恢复执行 |
| checkpoint | `CHECKPOINT_SAVED` 类型已定义 | 从未发射 |

## 2. 核心设计：投影驱动的可续调度器

**一句话：调度器每次启动都先从事件流重建状态，再从断点继续；首次运行只是空投影的退化情形。三条恢复路径统一为同一机制——追加一条恢复事件，然后重入调度循环。**

### 2.1 execute() 重构

```
execute(runId):
  1. 读 run 行 + definition 快照
  2. eventStore.readEvents(runId) → projectRunState → 重建：
     - nodeOutputs（来自 NODE_SUCCEEDED / HUMAN_INPUT_RECEIVED）
     - indegree/skip 记账（含 condition 分支剪枝重放）
     - frontier：待调度的就绪节点
  3. 进入与原版相同的主循环（并发执行就绪节点）
```

### 2.2 投影重建算法（恢复的正确性核心）

按拓扑序遍历节点：

- **succeeded**：写入 nodeOutputs；condition 节点读 `output.selected` 重放剪枝（selected 分支目标 indegree--，其余分支下游标 skipped 并传播）；普通节点出边目标 indegree--
- **skipped**：传播 skip 至下游
- **failed**：锚点。默认 resume 不重跑它；retry 模式把它视作未执行，上游满足后重新调度
- **suspended（human waiting）且已有 HUMAN_INPUT_RECEIVED**：输出 = 提交的 input（下游 `{{node.output}}` 可用），其出边目标 indegree--
- 其余（idle/崩溃残留 running）：不动作，等 indegree 自然归零进入 ready

### 2.3 checkpoint 语义

- checkpoint = 已消费的最大事件 seq（事件序号即检查点）
- 每个节点 settle 后发射 `CHECKPOINT_SAVED { seq }`：崩溃后从该 seq+1 继续消费；时间轴上可见持久化节奏

### 2.4 崩溃对账（进程重启）

`OnModuleInit` 时对 status ∈ {pending, running} 的孤儿 run **追加** `RUN_SUSPENDED { reason: 'crash' }` 事件（append-only，不 UPDATE 缓存字段），投影自然变为 suspended，用户可手动 resume。in-flight 节点的半成品状态不存在于事件流中，重放天然安全。

## 3. 三条恢复路径 + 取消（控制面 API）

| 路径 | API | 前置状态 | 行为 |
|------|-----|---------|------|
| Human 挂起恢复 | `POST /runs/:id/human-input` `{approved, input}` | waiting_human | approved → emit `HUMAN_INPUT_RECEIVED` 后重入；rejected → 该节点 NODE_FAILED（可 retry） |
| 主动暂停 | `POST /runs/:id/pause` | running | 引擎在调度间隙停机（in-flight 节点跑完），emit `RUN_SUSPENDED {reason:'paused'}` |
| （暂停/Human/崩溃）恢复 | `POST /runs/:id/resume` | suspended / waiting_human(已批) | emit `RUN_RESUMED` 后重入调度 |
| 失败断点恢复 | `POST /runs/:id/retry` | failed | emit `RUN_RESUMED {mode:'retry_failed'}`，失败节点重新调度 |
| 取消 | `POST /runs/:id/cancel` | 非终态 | emit `RUN_CANCELED`，停止调度 |

- 暂停意图必须落库语义：pause 在运行中即时生效（内存标志）；若引擎已停机但投影为 suspended 则幂等返回。
- 所有控制动作都是事件，不是 UPDATE——重启后回放仍得到一致状态。

## 4. 节点级韧性：超时 + 重试（指数退避）

契约新增（packages/shared）：

```ts
interface NodeRetryPolicy {
  maxAttempts: number;        // 总尝试次数上限（>=1）
  initialDelayMs?: number;    // 默认 500
  backoffFactor?: number;     // 默认 2
  maxDelayMs?: number;        // 默认 30_000
}
// WorkflowNodeBase 增加：
timeoutMs?: number;           // 单次尝试超时；竞速计时
retry?: NodeRetryPolicy;
```

- 新事件类型 `NODE_RETRYING { nodeId, attempt, maxAttempts, delayMs, error }`
- 调度器包装 executor：超时竞速视为一次失败尝试 → 指数退避 sleep → 重试；耗尽 maxAttempts 才 `NODE_FAILED`
- Human 节点不参与超时/重试（挂起即业务语义）

## 5. 运行定义快照

`WorkflowRun` 增加 `definitionSnapshot String` 列（Prisma migration）：run 启动时锁定 definition 版本，resume/retry 重放使用快照而非最新定义，避免中途编辑工作流导致恢复错位。

## 6. 前端（apps/web）

1. RunDetailPage 操作栏：按投影状态渲染按钮——暂停/恢复/重试/取消；waiting_human 时渲染审批表单（批准/拒绝 + 可选输入）
2. 回放时间轴：终态 run 加载全量事件；播放/暂停/步进/滑块拖动逐事件回放，节点看板随回放位置联动（对事件前缀折叠 `applyEvent`）
3. RunsPage 状态徽标沿用现有映射

## 7. 阶段划分与验证

| 阶段 | 内容 | 验证 |
|------|------|------|
| A | shared 契约演进 | shared 单测 + server/web build |
| B | 引擎重构（投影驱动 + checkpoint + 崩溃对账 + 韧性 wrapper） | 新增 scheduler.resume.test.ts 等 |
| C | 控制面 API | 控制器单测 + 手动 curl |
| D | 前端操作栏 + 回放时间轴 | pnpm build |
| E | 文档同步（本文件、PROJECT_PLAN 变更记录、README roadmap） | — |

红线自查：事件表只追加 ✓；引擎无旁路全局状态（内存仅存调度工作集与 pause/cancel 标志）✓；Human 挂起落库（事件即持久化）✓。

## 8. 实现说明（2026-08-22 落地，与 §2-§6 设计的偏差与补强）

1. **崩溃对账加投影守卫**：`reconcileOrphanRuns` 只在事件流投影为 `pending`/`running` 时追加 `RUN_SUSPENDED{crash}`；投影已是 `waiting_human`（fold 守卫保护）或终态（DB 缓存滞后于事件流）时仅重同步，避免把已完成运行误标挂起。
2. **isRunnable 排除已解决的 Human 挂起**：`running + human + approved` 的节点视作已解决，既结算出边、也禁止被上游结算 push 进 ready——否则恢复轮次会重新执行 Human 节点并二次挂起（设计稿 §3.2 的简化版有此漏洞，实测修复）。
3. **事件序号同步分配 + 串行落库**：并行派发时多个 `NODE_STARTED` 曾在同一 tick 读到同一 `seq`（真库将触发唯一约束冲突）；现改为 emit 调用时同步占号，落库经 promise 队列串行（同时保证 SSE 推送按 seq 有序）。
4. **批准后的 Human 节点无 `NODE_SUCCEEDED` 事件**：投影状态保持 `running`（输出经 `humanInput` 重建），恢复轮次完成后看板上该节点显示 running 而非 succeeded，属已知外观边界。
5. **Loop 中途崩溃恢复 = 整个 Loop 节点重跑**：子图内部不落独立节点事件（`runSubgraph` 不 emit `NODE_STARTED`），无法定位迭代内断点，重放按 Loop 节点整体重执行。
6. **控制面 409 语义**：pause 仅对引擎在跑的 run 生效；resume 仅 `suspended`；retry 仅 `failed`；cancel 对非终态生效（在跑则排空 in-flight 后由主循环收尾）。冲突统一抛 `ConflictException`，run 不存在抛 `NotFoundException`。

## 9. 并发与一致性模型（2026-08-22 复审修订）

多轮对抗式代码评审（架构/性能/UX/安全四个维度）后，对并发正确性与读路径做如下修订：

### 9.1 事件写入单写者（修复 seq 竞争）

§8.3 的"emit 同步占号"只覆盖调度器内部并行，**控制面（resume/pause/human-input/取消）与调度轮并发时仍会与轮内计数器撞 `(runId, seq)` 唯一约束**，把健康 run 打成 RUN_FAILED（reentry 场景在真 SQLite 上必触发；此前测试因内存桩不校验唯一约束而漏检）。现改为：

- `EventStore.append(runId, type, payload)` 的 **seq 分配与落库在同一 per-run 串行队列临界区内原子完成**，所有写入者（调度 emit、控制面、启动、崩溃对账）共用该队列——并发写入不撞号、SSE 推送保序；
- 调度器不再预占号，`emit` 返回实际 seq，`CHECKPOINT_SAVED { seq }` 记录刚刚落库事件的真实序号；
- 测试基建 `MemoryEventStore` 同步实现该契约并强制唯一约束（撞号即抛），reentry 用例在桩上即可复现真实约束。

### 9.2 终态屏障（单一终态事件）

- 新增 `EventStore.appendTerminal`：临界区内检查流尾事件，已含 `RUN_COMPLETED/RUN_FAILED/RUN_CANCELED` 则跳过写入（幂等）。并行多节点同时失败至多落一条 `RUN_FAILED`；
- in-flight 节点在终态之后的结算事件（如另一并行节点成功）仍会写入——**这是刻意选择**：事件流如实记录已发生的副作用结果，避免失败重试时重跑已成功的节点（at-least-once 语义下少一次重复副作用优先于时间轴的"纯净"）。

### 9.3 控制面互斥与纪元化暂停意图

- 同一 run 的控制动作（pause/cancel/resume/retry/human-input）经 `withControlLock` 按 runId 串行：双击审批只会落一份 `HUMAN_INPUT_RECEIVED`，第二次请求读到已变更投影返回 409；
- 暂停/取消意图绑定**调度轮次纪元（epoch）**：过期纪元的标志不会被新一轮消费，也不会泄漏到下一次执行（execute 收尾统一清理）。已知边界（接受）：调度轮收尾的毫秒级窗口内到达的 pause 请求会返回成功但可能不被消费——影响是"这次没暂停成"（run 正常完成），不会再出现"审批被静默转成挂起"或跨轮污染。
- 单实例假设：`running/epochs/意图标志/控制锁` 均为进程内状态，**多进程部署同一 run 会双跑**。当前定位为单机自托管运行时，水平扩容不在 Non-Goals 之内的支持范围（如需，事件表按 runId 分片 + 分布式锁）。

### 9.4 副作用语义：at-least-once（明确契约）

崩溃于 `TOOL_CALLED` 与 `TOOL_RESULT` 之间、`retry_failed` 重跑失败节点、Loop 整体重跑（§8.5）都会**重放非幂等副作用**（LLM 计费调用、外部工具）。这是当前架构的明确契约而非缺陷隐瞒：节点事件不含 attempt 级幂等键，工具调用不传幂等参数。接入不可重复副作用的工具时，应由工具侧做幂等（如幂等键入参）。后续演进方向：`NODE_ATTEMPT_STARTED { attemptId }` 事件 + Tool 调用透传幂等键。

### 9.5 事件 payload 截断

`LLM_COMPLETED.content` / `TOOL_RESULT.result` / `NODE_SUCCEEDED.output` 入事件前截断（64KB，超出替换为 `{truncated, preview}`）——事件流是读路径（回放/SSE/列表）的共享字节底座，全文入库会让每次回放 O(Σbytes)。内存中的节点输出不受影响；**已知权衡**：崩溃恢复后从事件重建的 nodeOutputs 是截断值（触发条件：单值 > 64KB，实践中罕见）。

### 9.6 读路径分层（性能）

- **列表页/bridge 轮询读 `workflow_runs` 投影缓存列**（`syncFromProjection` 维护），零事件回放——此前 listRuns 对最近 100 个 run 各做一次全量回放，被前端 3 秒轮询放大成 O(runs×events)/3s；bridge `flowagent_get_run` 轮询同理改走轻量 `GET /runs/:id/status`，终态后才取一次完整摘要；
- 详情页 `getRun` 仍全量回放（需要节点级状态），每次页面加载一次，可接受；
- SQLite 启用 WAL + `synchronous=NORMAL`，缓解逐事件提交的 fsync 写放大。

### 9.7 SSE 修复

- **先订阅、后回放、再冲缓冲（seq 去重）**：关闭"回放与订阅之间落库的事件永久漏发"窗口；
- 支持 `Last-Event-ID` 断线续传（浏览器自动携带），重连不再全量重放；15s 心跳注释帧防代理掐断；
- 前端不再手动 `close()` 杀死原生自动重连，断线时显示重连横幅，事件按 seq 去重。

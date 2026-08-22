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

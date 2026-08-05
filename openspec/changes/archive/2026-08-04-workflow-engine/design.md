## Context

当前 openspec-orchestrate 将 phase、agent、维度与流转顺序硬编码在 `src/core/orchestrate/` 工具实现和 agent 定义中：多个 role-specific submit（tool/task/quality）各自校验、opx_status 按硬编码阶段渲染、看板按任务组阶段展示。issue 依附于 task 无独立流转，也无外部数据源（ADO/OpenSpec/GitHub）的拉取通道。新增一种任务类型或来源都需要改源码。

约束：引擎只做推荐、orchestrator 手动分派；状态文件持久化于主仓库；worktree 隔离开发；豁免按"谁提谁裁定"原则路由。

## Goals / Non-Goals

**Goals:**
- 用 YAML 声明 workflow（task / 自定义 source），新增 workflow 不改代码。
- 统一 WorkItem 模型，task 挂 issue（children 一层）。
- 通用 `opx_agent_submit` 按 step_id 路由任意步骤。
- 收集器 adapter 定时拉取外部项并回写。
- 看板 5 列化，卡片展示暂停与多 agent 进度。
- opx_status 通用化，不硬编码 agent 名。

**Non-Goals:**
- 不做引擎主动发起会话（保持 orchestrator 手动分派）。
- 不做多级 children（仅一层）。
- 不定义具体技术栈规范（由可插拔 skill 承载）。
- P4 之前不实现完整 ADO 接入（仅 stub）。

## Decisions

### 1. phase + suspended 双层状态，替代 phase=status 混用
- phase（todo/in_progress/review/done/cancelled）决定看板列；suspended 决定是否被调度。blocker 随时发生，不应插入流转图污染列映射——suspended 保留原列并跳过调度。
- 备选：blocked 作为 phase。理由：blocker 与流程推进无关，混入会破坏 5 列固定映射。
- 术语约定：WorkItem 的 phase 与 workflow YAML 的 phases 共用同一命名空间——YAML 的每个 phase 是该列状态下的步骤容器，phase 名与 WorkItem 的 5 列状态一一对应（todo→待办、in_progress→处理中、review→审核中、done→完成、cancelled→已取消）。"进入下一 phase"即 WorkItem.phase 的状态迁移，迁移边界为 YAML phase 容器边界；"phase 门禁"指当前 YAML phase 容器内全部 step passed 才允许迁移。

### 2. children 一层树 + phase 联动
- 正向推进做 gate：Low+ children 必须达到目标 phase；Info children 未声明解决则重置 todo。反向回退 children 独立判定：终态 child（done/cancelled）保持不动；已提交待裁定（review）的 child 由 reviewer 在当前轮次完成裁定后按结果落位；未提交（todo/in_progress）的 child 重置为 todo。reviewer 必须覆盖全部已提交 child。全部 children 终态 + 全部 agent passed 才允许 step 通过。
- issue WorkItem 不设独立 workflow，统一由 task workflow 的 children 机制承载；assets/workflows/ 下仅保留 task.yaml。
- 备选：issue 平铺无层级。理由：task 挂 issue 是自然关联，且 reviewer 全量覆盖校验需要层级。

### 3. tag 键值对裁决 `{step}:{agent}:{verdict}`，支持并行与缓存
- 多 agent 并行时引擎一次推荐全部 agent，各自提交写 tag。调度按 tag 缓存：passed 且非 always_run 跳过、failed 重派、pending 分派、always_run 强制执行。串行依赖通过拆 step + transition 表达。tags 仅承载 agent 裁决记录；children 的 exempt 等操作标记存于 child 自身 metadata，不写入 tags。
- 备选：维度枚举 + role-specific 路由。理由：通用化要求任意 step/agent 组合，枚举不可扩展。

### 4. 通用 `opx_agent_submit(step_id, ...)` 
- step_id 路由到 YAML step 配置，参数校验、gate 检查、children 更新由 step 配置 + workflow 规则动态加载，替代多个 role-specific submit。

### 5. 收集器 adapter（pull/transform/writeback）+ 定时拉取
- 各 source（ADO/OpenSpec/GitHub/自定义）以 adapter 隔离，poll 间隔默认 30s。transform 产出初始 WorkItem（todo/非 suspended/空 children 与 tags）。
- 备选：引擎内直接调外部 API。理由：source 异构，adapter 保持引擎无关性。

### 6. 引擎运行时状态并入 WorkItem.metadata（`_retryCount`、`_checkpoint`）
- 避免双存储同步不一致。放置规则：引擎内部运行时字段一律置于 metadata 下划线前缀（`_retryCount`、`_checkpoint`），看板不渲染下划线前缀字段；公开语义字段（如 `source`、`suspend_reason`）无前缀、看板可渲染；`writeback` 属外部契约字段（收集器 adapter 读写），保留顶层。
- 备选：独立 ExecutionContext 存储。理由：状态文件需原子一致，双存储易漂移。

### 7. 检查点：retryCount 触发，opx_status 呈现，orchestrator 会话内决策
- 触发条件：item 级 retryCount > 0 且 retryCount % effective_max_retries == 0 且仍存在未解决 children；effective_max_retries 取当前 step 的 max_retries，未声明时继承 workflow 级 max_retries。retryCount 在每次 on:fail 向后跳转时递增，首次进入（retryCount=0）不触发。
- continue → 重置 step tag + parent 回退；giveup → 未解决 children 强制 cancelled。引擎只通知不决策。
- 备选：引擎自动循环重试。理由：重试/放弃是业务决策，须留在 agent 会话。

### 8. 豁免按 metadata.source 路由
- 报 issue 的 agent_id 记入 issue 的 metadata.source。review step 的 agents 即其豁免裁定白名单：豁免申请依据 metadata.source 匹配所属 review step 的 agents（报源 agent 属于哪个 review step 的 agents 就由谁裁定）路由到对应 reviewer step，无匹配时交由 orchestrator 处理。裁定 dismissed→cancelled 或 rejected→todo，保持"谁提谁裁定"。

### 9. 引擎仅推荐，orchestrator 手动分派
- 与现有 agent 会话模型一致，引擎不主动发起 session。
- 备选：引擎发起 session。理由：会打破当前 orchestrator 主导的分派模式。

## Risks / Trade-offs

- [YAML 校验宽松导致运行时配置错误] → loader 全量加载校验 + 单元测试覆盖非法配置。
- [children/phase 门禁口径不一致造成状态机死锁] → 沿状态机推演连锁影响，门禁判定收敛为单一实现，配回归测试。
- [迁移期双轨运行成本] → P1-P3 先替换现有流程，P7 统一清理硬编码。
- [外部源回写失败数据丢失] → 非阻塞异步写回，writeback 记录 lastAttempt/lastSuccess/error，下次状态变更重试。
- [metadata 承载引擎状态暴露给看板] → 看板只读且不渲染下划线前缀字段。

## Migration Plan

按 P1→P7 分批实施：P1 引擎核心（WorkItem/YAML loader/tag 裁决/门禁/检查点）→ P2 通用 submit 替换 role-specific submit → P3 OpenSpec collector + task workflow 迁移现有流程 → P4 ADO stub + 收集器与回写调度 → P5 看板 5 列 → P6 opx_status 重构 → P7 清理硬编码常量。

可复用：state 读写、git 操作、dedup/issue gate 函数、FakeGitRunner、agent 定义、skill 定义。工具与 agent 文档同步更新，README 随实现收敛。

## Open Questions

- 无人值守模式（unattended）下检查点的具体行为细节，实施阶段补充。
- 引擎内部字段（`_retryCount` 等）在 WorkItem.metadata 中的对外暴露与序列化边界。
- 自定义 adapter 的注册/发现机制（静态注册 vs 目录扫描）。

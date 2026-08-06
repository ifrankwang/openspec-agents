# workflow-engine Specification

## Purpose
TBD - created by archiving change workflow-engine. Update Purpose after archive.
## Requirements
### Requirement: WorkItem 数据模型
系统 SHALL 使用统一 WorkItem 模型表示任务与 issue，包含 `id`、`source`、`externalId`、`type`（task|issue）、`title`、`description`、`phase`、`suspended`、`currentStep`、`tags`、`metadata`、`children`、`labels`、`severity`（仅 issue）、`writeback` 字段。children 仅一层，每个 child 拥有独立的 phase 与裁决状态。

WorkItem 的 phase 与 workflow YAML 的 phases 共用同一命名空间：YAML 的每个 phase 是该列状态下的步骤容器，phase 名与 5 列状态一一对应（todo→待办、in_progress→处理中、review→审核中、done→完成、cancelled→已取消），"进入下一 phase"即 WorkItem.phase 的状态迁移。tags 仅承载 `{step_id}:{agent_key}:{verdict}` 的 agent 裁决记录；引擎内部运行时字段（如 `_retryCount`、`_checkpoint`）置于 metadata 下划线前缀，`writeback` 为外部契约字段保留顶层。

#### Scenario: 收集器产出初始 WorkItem
- **WHEN** 收集器 transform 产出新的 WorkItem
- **THEN** 该 WorkItem 的 phase 为 todo、suspended 为 false、children 为空、tags 为空

#### Scenario: task 挂载 issue 子项
- **WHEN** 引擎为 task WorkItem 挂载 issue 子项
- **THEN** issue 作为 child 写入 children，且拥有独立的 phase 与 tags，不影响 task 自身的 tags

### Requirement: Workflow YAML 声明与加载
工作流 SHALL 由 YAML 声明，包含 workflow 级 `max_retries`、可选顶层 `common` 块与 phases 列表，每个 phase 包含 steps；step 必须声明 `id`、`agents`、`transitions`，可选声明 `always_run`、`instructions`、`constraints`、`max_retries`。`agents` 为对象列表，每个元素含非空 `id` 与必填的 `capability_tags`（非空字符串数组，即该 agent 的能力标签，skill 加载按此语义匹配）；skill 加载清单按当前调用者 agent 的 capability_tags 过滤，step 内各 agent 独立声明、互不相同。顶层 `common` 块声明跨 step 共享的 `instructions`/`constraints`（step 自动继承，渲染时 common 在前、step 在后合并进对应视图区块），step 级同名可选字段声明 step 专属操作指引与约束。`transitions` 中 on:pass 与 on:fail 各指向目标 step id 或特殊值 done/halt：done 表示 item 进入终态并触发写回，halt 表示 item 置为 suspended=true 并保留当前列等待人工处理。YAML 的每个 phase 是 WorkItem 对应列状态下的步骤容器，正向迁移 phase 要求当前 phase 内全部 step passed。loader SHALL 在加载时全量校验并报告非法配置。

#### Scenario: 合法 YAML 加载
- **WHEN** loader 加载语法与引用合法的 workflow YAML
- **THEN** workflow 可被引擎按 type 检索，step 的 transition 目标均可解析

#### Scenario: 非法 YAML 报错
- **WHEN** loader 加载缺失必需字段或 transition 目标不存在的 YAML
- **THEN** loader 返回错误并给出缺失或非法项的位置，不产生部分加载的工作流

### Requirement: tag 裁决与裁决缓存
每次 agent 提交 SHALL 以 `{step_id}:{agent_key}:{verdict}` 格式更新 tags。调度时按裁决缓存处理：step 内全部 agent passed 且非 always_run 时跳过该 step；存在 failed agent 时仅重新分派 failed 的 agent；全部 pending 时正常分派；always_run 为 true 时无视缓存强制执行。

#### Scenario: 全 passed 且非 always_run 时跳过
- **WHEN** 当前 step 所有 agent 的 tag 均为 passed 且 always_run 为 false
- **THEN** 引擎不推荐该 step 的 agent，沿 on:pass 继续推进

#### Scenario: 部分 failed 时仅重派 failed
- **WHEN** step 内某 agent 的 tag 为 failed 而其余为 passed
- **THEN** 引擎仅推荐 tag 为 failed 的 agent 重新执行

#### Scenario: always_run 强制执行
- **WHEN** step 的 always_run 为 true 且被再次进入
- **THEN** 引擎无视已 passed 的裁决缓存，推荐该 step 全部 agent 执行

### Requirement: children 联动与门禁
正向推进时系统 SHALL 执行 gate 检查：severity 为 Low 及以上的 children 必须全部达到目标 phase 所在阶段；Info 级别的 children 若未声明解决则重置为 todo。反向回退时 children 独立判定：处于终态（done/cancelled）的保持不动；已提交待裁定（review）的由 reviewer 在当前轮次完成裁定后按结果落位；未提交（todo/in_progress）的置为 todo。reviewer 必须覆盖全部已提交的 child。step 通过判定 SHALL 在 step 级执行：全部 agent passed 且全部 children 处于终态（done/cancelled）；phase gate SHALL 在跨 phase 迁移时执行：当前 phase 全部 step passed 且 Low+ children 达到目标 phase。

#### Scenario: 正向 gate 拦截未到位 children
- **WHEN** parent 正向推进而存在 severity 不低于 Low 的 child 未达到目标 phase
- **THEN** gate 检查不通过，parent 停留在当前 phase

#### Scenario: 反向回退终态 child 保持
- **WHEN** parent 回退而 child 处于终态（done/cancelled）
- **THEN** 该 child 保持原终态，不被强制回退

#### Scenario: 反向回退中间态由 reviewer 完成裁定
- **WHEN** parent 回退而某 child 处于 review 已提交待裁定
- **THEN** 该 child 由 reviewer 在当前轮次完成裁定，按裁定结果落位

#### Scenario: 反向回退未提交 child 置为 todo
- **WHEN** parent 回退而某 child 处于 todo 或 in_progress 且未提交
- **THEN** 该 child 被置为 todo

#### Scenario: children 未到终态则 step 保持 pending
- **WHEN** step 内全部 agent 已 passed 但仍有 child 未处于 done 或 cancelled
- **THEN** 该 step 判定为 pending，不沿 on:pass 推进

### Requirement: 重试检查点
当 item 级 retryCount 大于 0、retryCount 为 effective_max_retries 的整数倍且仍存在未解决 children 时，系统 SHALL 通过 opx_status 呈现检查点；effective_max_retries 取当前 step 的 max_retries，未声明时继承 workflow 级 max_retries。retryCount 在每次 on:fail 向后跳转时递增，首次进入（retryCount=0）不触发。orchestrator 决策 continue 时重置该 step 的 agent tag 并回退 parent；决策 giveup 时强制将未解决 children 置为 cancelled 并将 step 标记为 completed。

#### Scenario: 重试多次后呈现检查点
- **WHEN** 某 step 的 retryCount 大于 0 且为 effective_max_retries 的整数倍且仍有未解决 children
- **THEN** opx_status 呈现检查点，提示 orchestrator 在会话中决策 continue 或 giveup

#### Scenario: 首次进入不触发检查点
- **WHEN** 某 step 的 retryCount 为 0
- **THEN** 不呈现检查点，正常分派该 step

#### Scenario: continue 重置并回退
- **WHEN** orchestrator 在检查点决策 continue
- **THEN** 该 step 的 agent tag 被重置为 pending，parent 回退以便重新执行

#### Scenario: giveup 强制取消
- **WHEN** orchestrator 在检查点决策 giveup
- **THEN** 未解决的 children 被强制置为 cancelled，step 标记为 completed

### Requirement: suspended 调度跳过
suspended 为 true 的 WorkItem SHALL 被引擎跳过调度推荐，且保留当前 phase 与看板列；暂停原因（blocker/checkpoint）存于 metadata.suspend_reason，看板卡片展开可见。parent suspended 时其 children SHALL 同样暂停调度，但已进入 review 的 child 允许 reviewer 完成当前裁定。child 因暂停导致 parent 正向 gate 无法满足时，引擎 SHALL 通过 opx_status 呈现该阻塞并提示 orchestrator 手动干预，不自动取消或推进。

#### Scenario: 暂停项不被调度
- **WHEN** WorkItem 的 suspended 为 true
- **THEN** 引擎不推荐该 WorkItem 任何 step 的 agent

#### Scenario: 暂停原因可见
- **WHEN** 看板展开 suspended 的卡片
- **THEN** metadata.suspend_reason 中的暂停原因（blocker/checkpoint）被展示

#### Scenario: parent 暂停时 children 冻结
- **WHEN** parent WorkItem 的 suspended 为 true
- **THEN** 其 children 同样暂停调度，已进入 review 的 child 除外

#### Scenario: child 暂停阻塞 gate 时提示人工
- **WHEN** 某 child 的 suspended 为 true 且导致 parent 正向 gate 无法满足
- **THEN** opx_status 呈现该阻塞并提示 orchestrator 手动干预，不自动取消或推进


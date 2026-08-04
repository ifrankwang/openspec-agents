## Why

现有编排把 phase、agent、维度与流转顺序硬编码在工具实现和 agent 定义中，每引入一种新任务类型（issue、自定义来源）都要改源码。需要一个通用工作流引擎：用 YAML 声明 workflow，由收集器定时拉取外部项、引擎调度、一套通用 submit 工具路由任意步骤，看板按 phase 列展示。

## What Changes

- **BREAKING** WorkItem 数据模型：新增 `type`/`tags`/`metadata`/`children`/`severity`/`writeback` 等字段；phase（5 列）+ suspended（暂停）双层状态，替代 phase=status 混用。
- **BREAKING** Workflow YAML：以 YAML 声明 step（`agents`/`capability_tags`/`allowed_tools`/`timeout_ms`/`max_retries`/`transitions`），替代硬编码阶段、agent、维度。
- **BREAKING** 通用 `opx_agent_submit(step_id, ...)`：按 step_id 路由校验与门禁检查，替代现有多个 role-specific submit 工具。
- tag 裁决：`{step_id}:{agent_key}:{verdict}` 键值对，支持多 agent 并行与裁决缓存，替代维度枚举。
- children 树形结构（1 层）：task 挂 issue，正向前进做 gate 检查，反向回退独立判定。
- 收集器 CollectorAdapter（`pull`/`transform`/`writeback`）：支持 ADO / OpenSpec / GitHub / 自定义 source，定时拉取。
- 豁免路由：issue 的 `metadata.source` 记录报 issue 的 agent，豁免申请自动路由到对应 reviewer 裁定。
- 重试检查点：`retryCount % max_retries` 时经 opx_status 呈现检查点，orchestrator 在会话中决策 continue/giveup。
- 看板升级为 5 列（待办/处理中/审核中/完成/已取消），卡片展示 suspended 子状态与多 agent 进度 tag。
- opx_status 视图通用化：解耦硬编码 agent 名，按 workflow/step 动态渲染推荐与 skill 加载。
- 清理：移除硬编码 phase/agent/dimension 常量与 `execution_boundary_source` 等冗余概念。

## Capabilities

### New Capabilities
- `workflow-engine`: 通用工作流引擎核心——WorkItem 模型、workflow YAML 加载、tag 裁决、children/phase 门禁、检查点与 suspended 调度。
- `workflow-collectors`: 收集器适配机制（pull/transform/writeback），OpenSpec 先行、ADO stub，支持自定义 adapter。
- `workflow-submit`: 通用 opx_agent_submit——step_id 路由、参数校验、gate 检查、children 状态更新与回写调度。
- `workflow-board`: 编排看板 5 列化与卡片信息（suspended 子状态、多 agent 进度 tag、severity 色条）。
- `workflow-opx-status`: opx_status 视图通用化——按 workflow/step/agent 动态渲染推荐、skill 加载与检查点呈现。

### Modified Capabilities
- 无（本仓库尚无既有 spec，属全新引入；现有硬编码编排逻辑被上述能力取代）

## Impact

- 新增 `src/core/workflow/`（loader/executor/types），现有 `src/core/` 编排逻辑迁移或替换。
- 工具层：`opx_status`、`opx_agent_submit` 重写，多个 role-specific submit 合并为一个通用工具。
- agent 定义：`openspec-*` 各角色职责边界保留，流转不再硬编码于 agent/工具。
- dashboard：5 列看板与卡片渲染升级。
- 依赖：js-yaml 已存在，无需新增运行时依赖。
- 破坏性变更：opx_* 工具签名、状态文件结构、agent 提示词均受影响，需同步迁移。

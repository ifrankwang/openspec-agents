# Design — agent-merge-and-mode-config

## Context

变更动机与范围见 proposal.md - Why / What Changes，本文件只回答 how。相关背景事实（均已对照当前源码核实）：

- **身份解析现状**：MCP 形态下身份是 `_agent` 参数纯自述（`src/adapters/mcp-common/server.ts` 的 `resolveContext`，缺省视为编排主代理视角）；OpenCode 直载形态下身份由会话运行时 agent 名硬绑定（`src/adapters/opencode/tools.ts` 的 `makeCtx`），无法表达 9 种逻辑身份；`src/core/constants.ts` 的 `DIMENSION_AGENT_MAP` + `agentToReviewLayer`（tool/task/quality 三元组，其余 agent 返回 undefined）是视图路由、issue 报源反推（`reviewLayerFromMetadata`）、维度归属的唯一入口。
- **谁提谁裁定现状**：`src/core/workflow/submit.ts` 的 `resolveReviewStepForSource` 按「报源 ∈ review 阶段某 step 的 agents」反推裁定 step，纯数据驱动——只要 simple 审查者身份出现在某个 review step 的 agents 里，裁定路径天然通（clarify.md P3 已确认）。
- **workflow 加载现状**：`src/core/workflow/loader.ts` 从模块目录逐级上溯探测 `assets/workflows/task.yaml`（`TASK_WORKFLOW_PATH`），step 结构为 agents（id + capability_tags 必填）/ transitions（on_pass / on_fail，特殊值 done/halt）/ instructions / constraints；`assertQualityAgentsConsistent` 仅在存在 `verify_quality` step 时校验其 agents 与 5 维映射一致。loader 无任何 mode 概念。
- **状态与视图现状**：`src/core/workflow/engine.ts` 的 `REVIEW_STEP_TO_LAYER` 硬编码 3 个 verify step → 层；`src/core/workflow/status.ts` 的 `STEP_ID_TO_CONTEXT_KIND` 硬编码 6 个 step id（未命中则不渲染 children 区块）；`isAgentOwnedIssue` 对「反推不到层」的调用者只显示 todo 态 issue（待复核/待裁定清单不可见）；`OrchestrateState`（`src/core/types.ts`）无 mode 字段；`src/core/tools/lifecycle.ts` 的 `completeTaskGroupExecute` 收尾门禁为 worktree 干净 + blocking issue 终态 + task 终态 + blocker 全 resolved。
- **agent 注入现状**：`src/adapters/opencode/agents.ts` 扫描 `assets/agents/*.md` 注入（含主代理）；`src/adapters/plugin-common/index.ts` 的 `buildAgents` 排除 `openspec-main.md` 后注入 claude-code / zcode / codex 插件包；`src/adapters/deepseek-harness/index.ts` 按 frontmatter `permission.edit: deny` 推断禁用 DSH 子代理写工具；`src/adapters/codex/index.ts` 的 `AGENT_TOOLS` 硬编码每身份工具白名单。
- **agent 文件现状**：`assets/agents/` 10 个文件（9 子代理 + `openspec-main.md` 主代理模板）；权限现状：developer `edit: allow`，architect `edit: "*" deny + "*.md" allow`，其余 7 个 reviewer 全部 `edit: deny`、`bash: allow`。

## Goals / Non-Goals

**Goals:**
- 9 种逻辑身份（architect / reviewer-tool / reviewer-task / 5 维 reviewer / simple 审查者）仅经 `_agent` 参数承载，核心路由（状态视图、issue 归属与筛选、谁提谁裁定、state tags 的 key）全部逻辑化，不依赖独立 agent 文件存在。
- 新增模式配置（full / simple）并在变更开始时固化；simple 三步流程（implement → quality_review → done）在引擎、提交工具、视图、收尾全链路可跑通。
- OpenCode 由直载形态切换为 MCP 形态，各 harness 身份传递行为一致；文档标注「身份自述、无硬校验」安全边界。

**Non-Goals:**
- 不做 `_agent` 真实性硬校验（session→逻辑身份登记、签名等补偿机制）。
- 不做工具侧按逻辑身份动态授权（权限取并集，行为靠指令约束兜底）。
- 不支持中途切换模式 / 配置文件动态生效。
- 不改 full 模式的 step 结构与 verify_quality 5 逻辑身份并行审查语义（仅身份逻辑化）。

## Decisions

### D1：逻辑身份映射扩展（`src/core/constants.ts`）

`agentToReviewLayer` 增加一条映射：`openspec-reviewer` → `"quality"`（simple 审查者身份；full 模式不会分派该身份，映射只对 simple 生效，无副作用）。`agentToReviewDimension` 保持不变（openspec-reviewer 无固定维度，维度由 issue 显式声明的 `dimension` 承载）。

为什么选它：这是 issue 报源侧路径的最小改动点——`reviewLayerFromMetadata`（issue 报源反推层）、`collectFixedExemptLayers`（dev 修复后的分层重置归因）、`isAgentOwnedIssue`（视图归属）直接消费 `agentToReviewLayer`，一处映射即让 simple 审查者上报的 issue 归入 quality 层语义；层感知门禁的 step 侧（`stepCanPass` / `blockingStepChildren` 的 step 消费路径）由 D4 的 `REVIEW_STEP_TO_LAYER` 扩展覆盖，与「显式 dimension 声明 + quality 层谁提谁裁定」的已确认方向一致。

备选：为 simple 单建第三层（merged 层）——被否：会改动 `REVIEW_LAYERS` 三元组、门禁归因、blocked 视图推导等多处硬编码，收益只是语义标签更精确，而 quality 层 + 显式 dimension 已完整覆盖裁定与筛选需求。

### D2：模式配置载体与固化时机

新增项目级配置文件 `<repo>/openspec/workflow.yaml`（与既有 `openspec/config.yaml` 同级，属于每项目选择而非插件内容），内容仅 `mode: full | simple`（缺省 full；值域外报错，YAML 解析失败报错，文件缺失视为 full）。

固化语义（对齐 spec「模式在变更开始时固化」）：
- `opx_orch_init` 新建 state 时读取该文件并把 mode 写入 `state.mode`；state 已存在（含 recovery、重复初始化、切换任务组）时**不再读配置**，沿用 state 既有 mode；state 缺失 mode 字段的旧变更一律按 full 处理（读时兜底，不写回）。
- 此后配置文件改动不影响进行中的变更；"中途切模式重置 review tags"逻辑不存在（proposal 已确认删除）。

备选：模式放进 `assets/workflows/task.yaml` 顶层——被否：该文件随插件 bundle 分发，是全局行为，无法表达"每项目每变更的选择"；模式放 `.openspec.yaml`——被否：那是 openspec CLI 自身配置，混放污染其 schema 语义。

### D3：simple 流程定义来源——新增 `assets/workflows/task-simple.yaml` 静态文件

新增第二个 workflow 文件（随插件 bundle 与 `copyWorkflows` 一并分发），结构：

```yaml
id: task-simple
common: <复用 task.yaml common 的 _agent 指引等共享条目>
phases:
  - name: in_progress
    steps:
      - id: implement
        agents: [{ id: openspec-developer, capability_tags: [全部原 implement 能力] }]
        transitions: { on_pass: quality_review, on_fail: implement }   # 失败自循环重试
  - name: review
    steps:
      - id: quality_review
        agents: [{ id: openspec-reviewer, capability_tags: [quality-gate, api-testing, dev-practices, efficiency, style, architecture, performance, security, maintainability, tool-improvement] }]
        transitions: { on_pass: done, on_fail: implement }             # 失败回 implement 整步重审
```

关键内容取舍：
- implement step 的 constraints 不含 `{{allowed_directories}}` / `{{allowed_packages}}` / `{{notes}}` 边界占位符——simple 无 analyze 时 execution_boundary 永不写入，占位符会原样渲染；执行边界默认整个 worktree。
- quality_review 的 instructions / constraints = `verify_tool` + `verify_task` + `verify_quality` 三者的**语义合并改写**（clarify P6 已确认）：保留确定性工具检查与必做清单申报、task 验证（verified_tasks / failed_tasks）、维度审查与工具改进双报、只报不改；删除 `verify_quality` 的「禁止运行确定性工具检查」约束与「工具调用边界仅 opx_status/opx_agent_submit」中禁 bash 的表述（simple 审查者需要 bash 跑工具检查与文档/注释直改）。
- 能力集取并集的意义：`renderSkillSuggestions`（`src/core/views.ts`）与 `uncoveredMustDo`（`src/core/tools/gate.ts`）均按 capability_tags 驱动——并集使 simple 审查者的 Skill 加载清单与质量门必做清单自然覆盖全部维度与工具链，无需额外代码。
- 身份 id 用 `openspec-reviewer`（不在 `DIMENSION_AGENT_MAP` 内）→ `new_children` 的 dimension 显式声明校验（`src/core/tools/submit.ts` 的 `sourceDim` 分支）自动生效，零改动满足 spec「未声明维度拒绝上报」。

运行时选择：新增 `resolveWorkflowPath(state)` 辅助（simple → `task-simple.yaml`，否则 `task.yaml`），在三个消费点替换 `TASK_WORKFLOW_PATH` 直用：`lifecycle.statusExecute`、`lifecycle.applyRecoveryState`（增加 mode 参数）、`tools/submit.ts` 的 `loadTaskWorkflow`（先读 state 再选文件）。`loadWorkflowFile` 已有按路径缓存，双文件天然支持。

为什么静态文件而非运行时合并：运行时从 task.yaml 自动拼接会产生残留的 `verify_tool` 等原 step id 引用与互相矛盾的约束（如"禁止运行确定性工具检查"与"运行确定性工具检查"并存），改写成本高于直接维护；静态文件可读、可审计、loader 校验复用（`assertQualityAgentsConsistent` 只认 `verify_quality` step，simple 文件无此 step 自动跳过）。配置文件属非代码资产，不受代码级 DRY 原则约束。

### D4：引擎层适配（`src/core/workflow/engine.ts`）

- `REVIEW_STEP_TO_LAYER` 增加一行 `quality_review: "quality"`。该映射同时被 `stepCanPass`（本层 blocking issue 终态才可 pass）、`blockingStepChildren`（blocked 诊断）、`recommendForItem`（review step 补交推导 isReviewStep）、`renderBlocked`（待复核/待裁定区块）消费，一行改动全链联动。
- 门禁口径确认：quality_review 按 quality 层口径——审查者 failed 时 on_fail 回 implement；passed 时本层 blocking issue 须已终态（审查者先经 `recheck_adjudications` 把自报 issue 复核至 done）。与 full 的 verify_quality 一致。
- 单 agent step 的既有语义直接适用：`recommendAgents` 对非 passed 身份重派（单 agent step 返回 tag 非 passed 的 agent，implement failed 后 dev 必然被重派）；`applyTransition(fail)` 的 tag 清理仅发生在跨 phase 回退（`clearStepTags` 清回退目标 step 的 tags，如 quality_review 回 implement），同 phase 自循环（如 implement on_fail: implement）只切换 currentStep、不清 tags，dev 重派由 `recommendAgents` 非 passed 分支保证；`incrementRetry` 驱动检查点——「implement 失败自循环重试」「quality_review 失败回 implement 整步重审」零新增引擎逻辑。
- simple 模式不引入 verify_tool 的检查点增量检测分支（`renderToolChangesEvidence` / `_tool_review_checkpoint` 硬绑定 verify_tool step）：simple 每轮全量工具检查，换取实现简单；simple 的价值在轮次少而非扫描增量，后续如需可再增强。

备选：为 quality_review 泛化"层由 workflow 配置声明"——被否：`REVIEW_STEP_TO_LAYER` 的 3 个值就是 3 个 verify step 的固有语义，扩展一行映射与"配置驱动"实现量相当，但后者要改 loader schema 与校验，连锁更大。

### D5：提交工具适配（`src/core/tools/submit.ts`）

1. **工作区干净强检查**：`state.mode === "simple"` 且提交 step 为 `implement`（stepPhase === "in_progress"）时，在 `submitForStep` 之前执行 `isWorktreeClean(wtPath)`，不干净直接拒绝并提示先 commit。收尾门禁（`completeTaskGroupExecute` 的 worktree 干净检查）原样保留作为最终兜底（"收尾必过"）。
2. **`assertFailedHasReason` 新增 quality_review 分支**（现状存在死锁，必须修）：`stepId === "quality_review"` 时，理由判定 = 本次新报含 Low+ issue **或**存在 quality 报源（`resolveChildIssueFields().sourcePhase === "quality"`）的未终态阻塞 issue，**不按维度过滤**。现状 else 分支按 `agentToReviewDimension(agent)` 过滤——对 openspec-reviewer 该值为 undefined，导致任何 failed 提交都报「不存在未解决的阻塞 issue」死锁（simple 审查者报 issue 后无法 failed 提交，流程卡死）。full 模式各 verify step 分支不受影响。
3. **现状零改动的点（核实确认）**：
   - 谁提谁裁定：`resolveAdjudicatorStepForIssue` / `resolveReviewStepForSource` 按 review step agents 反推，simple 文件 `quality_review.agents = [openspec-reviewer]` 天然命中；
   - 重复提交守卫：按 tag 是否 passed 判定，failed 可重提——「审查失败回 implement 重审后重提」天然兼容；
   - `new_children` 的 dimension 必填校验（见 D3）；
   - `resetReviewTagsOnFix` / `clearReviewVerificationTags` 硬编码 `verify_*` tags：simple 模式无这些 tag，调用为空操作无害；quality_review 的 failed tag 不因 dev 修复被清除，恰好保证回 implement 后重进 quality_review 时审查者必然被重派（与 full 模式 failed 维重派语义一致）。

### D6：视图层适配（`src/core/workflow/status.ts` + `src/core/constants.ts`）

1. `STEP_ID_TO_CONTEXT_KIND` 增加 `quality_review → "review_merged"`，新增合并渲染器：Task(待验证) + Issue(待复核) + Issue(待裁定是否可豁免) 三个区块（复用 `renderTaskChildren` / `renderChildrenSection` 的既有渲染函数，任务验证语义来自 verify_task、issue 归属来自 quality 层）。
2. **`isAgentOwnedIssue` 归属扩展**：quality 层调用者但无维度（openspec-reviewer）时，归属判据 = 报源（`metadata.source`）=== 调用者，且 review 态。现状该场景落到「无层 → 仅 todo 态」分支，simple 审查者看不到自己名下的待复核/待裁定清单（clarify A 确认必须修）。
3. **待裁定豁免区块**：`isQualityAdjudicable` 增加无维度调用者分支——报源 === 调用者且带 `exempt_request` 标记即可裁定（与 blocked 视图 `isAdjudicableExempt` 口径一致）。
4. 分派视图无需改动：`renderProgressSection` / 分派 agent 列表均由 `workflow.phases` / `rec.agents` 驱动，simple 文件自动渲染 implement、quality_review 两行与 `openspec-reviewer` 分派指令；full 模式 verify_quality 的 5 逻辑身份并行提示（agents.length > 1 文案）已存在，仅需在文档/编排 skill 层注明"同一物理 reviewer 以不同 `_agent` 多次分派"。

备选：复用 `review_quality` 渲染类型并追加 Task 区块——被否：`review_quality` 语义绑定 verify_quality 的维度并行审查视图，与 simple 单审查者合并视图的归属口径不一致；新增 `review_merged` 类型语义更准确，且不影响 full 模式渲染。

### D7：生命周期适配（`src/core/tools/lifecycle.ts`）

1. **`opx_orch_init` 读模式**：新建 state 时读取 `<worktree>/openspec/workflow.yaml`，校验值域后写 `state.mode`；`OrchestrateState` 新增 `mode?: "full" | "simple"`（见 Data Model）。
2. **新建 WorkItem 初始 step 模式感知**：新建 item 经 `initExecute` / `applyRecoveryState` 置 phase `todo` + currentStep `analyze`——simple 文件没有 analyze step，会触发 `phaseStepMismatch` 状态异常拒绝执行，simple 模式需在 lifecycle.ts 这两处改为 phase `in_progress`、currentStep `implement`（无 analyze，执行边界默认整个 worktree，spec「SHALL 不执行 analyze 环节」）。
3. **`applyRecoveryState` 模式感知**：simple 分支——task_analysis / dev_impl 均落 in_progress/implement（task_analysis 重置 task children 全 todo，dev_impl 保留既有进度）；review 分支——`implement:openspec-developer` 置 passed、`quality_review` 的 failed tag 删除回 pending、currentStep 落 quality_review、task children 缺省 done；`reset_steps` / `review_layer` 参数在 simple 下无对应 verify step，接受但空操作（值域校验保持 `REVIEW_VERIFY_STEPS` / `REVIEW_LAYERS` 不变，文档标注 simple 下无效）。
4. **`completeTaskGroupExecute` 收尾语义**：simple 模式无 verify_cleanup step，现有门禁（worktree 干净、blocking issue 终态、task 终态、blocker 全 resolved）即"收尾必过"；合并冲突返回 blocked 的路径保留——dev 在 worktree 内把 baseBranch 合并进任务分支、解冲突、commit 后，编排者重调 complete 完成收尾（裸合并、无回归、无环境清理，用户已确认）。
5. 编排者专属工具（`setWorktreeExecute` / `setUnattendedExecute` / `statusExecute`）除 workflow 选择（D3）外无其他模式相关改动。

备选：simple 下拒绝 `reset_steps` / `review_layer` 参数（报错）——被否：二者是编排者视角的通用控制面，simple 下无对应 verify step 时接受但空操作，比按模式报错更符合「参数永远合法」的既有语义，也无需调用方按模式分支组织请求；值域校验保持不变。

### D8：物理 agent 合并与权限并集（`assets/agents/`）

- 保留 `openspec-developer.md`（承载 developer + architect 逻辑身份的提示词，角色内容合并），新建 `openspec-reviewer.md`（承载 tool / task / 5 维 / simple 审查者的提示词，角色内容合并），`openspec-main.md` 主代理模板保留，删除其余 8 个旧 agent 文件（openspec-architect + 7 个维度/层 reviewer）。
- 两个物理文件 permission 均取全部逻辑身份并集：`edit: allow`、`bash: allow`（developer 的 edit allow 与 architect 的 question allow 并入；dimension reviewer 因此获得 edit/write——用户已拍板）。行为约束靠提示词兜底：`openspec-reviewer.md` 写明"只报不改"——文档/注释类（不影响代码运行）可直改，逻辑类一律只报；`openspec-developer.md` 承载的 architect 身份沿用 analyze step 指令的"仅可 edit md 文档"约束。
- 身份自述安全边界写入 README.md：`_agent` 为纯自述、无硬校验，任何调用者可自报任意身份，裁定权与视图路由均信任自述值。

备选：按逻辑身份动态下发权限（工具侧维护 agent→permission 映射）——被否（clarify P2 用户已确认取并集）；session→身份登记做硬校验——被否（P1 用户已确认接受软约束）。

### D9：适配层改造

1. **OpenCode 直载 → MCP 形态**（BREAKING）：`src/adapters/opencode/tools.ts` 直载工具注册移除，插件壳改为注入 MCP server 配置（stdio bundle，`--worktree` 指向项目根），与 claude-code / zcode / codex 插件的 `.mcp.json` 形态一致；`makeCtx` 的身份推导路径随之删除，身份统一走 `mcp-common` 的 `_agent` 解析。`opencode/agents.ts` 的注入保留但只注入 2 个物理子代理 + 主代理模板。OpenCode 插件注入 MCP 配置的具体配置键按 opencode 插件 schema 实现时确认（见 Open Questions）。
2. **codex `AGENT_TOOLS` 扩展**：现状 7 个 reviewer 无独立条目、统一走 default 白名单（read/grep/glob/ls/bash，无写工具）；新增 `"openspec-reviewer": ["read", "grep", "glob", "ls", "bash", "apply_patch", "web"]`（审查者可直改文档/注释需要 apply_patch）；`openspec-developer` 条目不变，无需删除任何条目。
3. **deepseek-harness / plugin-common / claude-code / zcode**：消费逻辑均为扫描 `assets/agents/*.md` 全量注入，文件收敛后自动只生成 2 个物理子代理，代码零改动（`denyEditTools` 读到 reviewer 的 `edit: allow` 后自然不设写工具过滤，与并集语义一致）。
4. **common 块指引**：`task-simple.yaml` 的 common 保留 `_agent` 传递指引与"缺省视为编排视角"提示（`renderOrchestratorDispatch` 的 `identityDeclared === false` 兜底提示依赖该条文案）。

### D10：文档与配置同步（随 D1-D9 一起，避免双源）

- README.md：逻辑身份模型（9 身份经 `_agent` 承载）、模式语义（full/simple、init 固化、旧 state 默认 full）、身份自述安全边界、物理 agent 说明。
- `assets/agents/openspec-developer.md` / `openspec-reviewer.md`：按"agent 定义不含实现细节"原则只写角色定位与边界，不写流程。
- `assets/workflows/task.yaml`：full 文件除身份逻辑化（无文件级改动——逻辑身份名保持 `openspec-reviewer-tool` 等不变，仅物理承载变化）外不动。

## Data Model

本变更不涉及数据库持久化（无 DDL）。涉及编排状态文件（`openspec/states/*.json`，`src/core/state.ts` 读写）的结构变更：

`OrchestrateState`（`src/core/types.ts`）新增可选字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | `"full" \| "simple"`（可选） | 变更开始时固化的流程形态。缺失即旧变更，一律按 full 处理（读时兜底，不写回）。新变更由 `opx_orch_init` 从 `openspec/workflow.yaml` 读取后写入；已存在的 state 不再被配置改动覆盖。 |

其余 WorkItem / tags / issue metadata 结构不变：逻辑身份仍以 `metadata.source`（完整 agent 名）承载，state tags 的 key 仍为 `{stepId}:{agentKey}`，simple 模式的 quality_review tag 即 `quality_review:openspec-reviewer`。

## Risks / Trade-offs

- [维度 reviewer 获得 edit/write 写权，审查"只报不改"仅靠提示词] → 权限并集为用户明确拍板（clarify P2）；"只报不改"（文档/注释类可直改）写入 `openspec-reviewer.md` 角色与 quality_review step 约束双保险；工具层不加动态授权换取实现简单。
- [`_agent` 纯自述无硬校验，子代理可冒认身份裁定他人 issue / 提交他层 step] → 用户接受（P1）；README 标注安全边界；裁定路径本身仍受"报源须属于 review step agents"与"裁定者须等于报源"双重校验约束，冒认只能以自报身份行事，无法越出该身份自身的既有权限面。
- [simple 模式无 analyze / verify_cleanup，执行边界默认整个 worktree、合并冲突后零审查收尾] → 用户明确接受（spec 场景化定义）；收尾门禁（worktree 干净 / blocking 终态 / task 终态 / blocker resolved）保留，dev 提交干净强检查前置兜底。
- [`assertFailedHasReason` 对 openspec-reviewer 的维度过滤死锁（现状代码，若漏修 simple 审查失败提交即被拒）] → D5 新增 quality_review 分支按"quality 报源全部维度"判定理由，与"simple 审查者对全部质量层负责"语义一致。
- [视图层未扩展时 simple 审查者看不到自己名下待复核/待裁定清单，第一次复核或豁免即卡死] → D6 归属扩展 + `STEP_ID_TO_CONTEXT_KIND` 新增映射，纳入改造范围（clarify A 已确认）。
- [旧变更（无 mode）升级后行为不变，但若用户误以为配置已生效而改 workflow.yaml 无效] → 文档明确"模式在变更开始时固化，进行中配置改动不影响"；state 视图可展示固化模式便于确认。
- [物理 agent 收敛后 OpenCode 直载形态无法表达 9 种逻辑身份] → BREAKING 已声明，OpenCode 切换 MCP 形态后由 `_agent` 承载；直载壳保留兼容窗口直到双轨验证完成（现状注释已有该表述）。

## Migration Plan

1. **代码与配置实施顺序**（依赖序）：constants 映射（D1）→ workflow 文件与加载选择（D2/D3）→ 引擎/提交/视图/生命周期（D4-D7）→ agent 文件合并（D8）→ 适配层（D9）→ 文档（D10）。
2. **旧 state 兼容**：无 mode 字段一律 full，读时兜底，无需迁移脚本；recovery 沿用既有语义（full 分支代码路径不变）。
3. **插件包发布**：`assets/workflows/` 新增文件、`assets/agents/` 收敛后执行 `bun run build:plugins` 重建各 harness 插件包；已安装插件需重新安装/更新（`bun run sync` 更新本地缓存）。
4. **用户侧（OpenCode 直载用户）**：升级后需将接入方式切为 MCP 形态；文档给出切换指引。
5. **测试适配**：`tests/` 现有断言大量引用 9 个 agent 名与 full 流程流转（`FakeGitRunner` 驱动），agent 文件收敛不破坏 src 逻辑但测试断言需同步；新增 simple 模式用例（init 固化、三步流转、失败自循环、工作区干净拒绝、维度必填拒绝、清单可见、谁提谁裁定）。
6. **回滚**：`assets/agents/` 与 `assets/workflows/` 文件可从 git 恢复；state.mode 字段向后兼容（缺失即 full），无状态迁移风险；代码回滚后旧行为完整恢复。

## Open Questions

- OpenCode 插件注入 MCP server 配置的具体配置键与形态（opencode 插件 schema 是否支持在 config 中声明 mcp server），实现时按 opencode 官方插件文档确认；该细节不影响本方案的结构与其它 harness，可安全延后。

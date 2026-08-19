<!--
  模板说明：每个 ## N. 是一个独立迭代（task group），编排工具会逐个处理。
  每个迭代必须自带质量保证：实现代码 + 测试 + 项目质量门（见 AGENTS.md）。

  > **各组**可独立实施，组内全部完成后编译通过、可启动、测试通过。
  > **序号**即实施顺序——跨组依赖确保上游组提交后下游组可对接。
  > 每个源文件在 tasks.md 中最多出现**一次**（避免跨组并行修改冲突）。
-->

本 change 无外部前置 change 依赖；分组按 design.md Migration Plan 的依赖序组织（D1-D3 → D4-D7 → D8 → D9 → D10）。
注意：`src/core/tools/submit.ts` 在相邻组 1/2 中出现（严格顺序实施）；`src/core/tools/lifecycle.ts` 横跨组 1 与组 3（1.6 与 3.2 触及同一函数 `applyRecoveryState`，需严格顺序实施、组间先合并再开新组，无并行冲突）。

## 1. 模式固化与 simple 流程定义

<!-- 本组 4-8 个任务。独立迭代：实现 + 测试 + 质量门。
     组内任务按依赖链排列：定义 → 实现 → 测试 → 质量门。
     每个任务以 [spec:<capability>#<requirement>] 标注追溯（纯横切基础设施任务标 [infra]）。 -->

- [ ] 1.1 `src/core/constants.ts` 的 `agentToReviewLayer` 增加 `openspec-reviewer` → `"quality"` 映射；`agentToReviewDimension` 保持不变（openspec-reviewer 无固定维度，维度由 issue 显式声明承载）[spec:agent-identity#逻辑身份经 _agent 参数承载]
- [ ] 1.2 `src/core/types.ts` 的 `OrchestrateState` 新增可选字段 `mode: "full" | "simple"`（缺失即旧变更，读时兜底 full 不写回）；新增 `<repo>/openspec/workflow.yaml` 配置文件（内容仅 `mode: full | simple`，缺省 full，值域外报错、YAML 解析失败报错、文件缺失视为 full）[spec:workflow-mode#模式配置与缺省值]
- [ ] 1.3 `src/core/tools/lifecycle.ts` 的 `opx_orch_init` 固化模式：新建 state 时读取 `<worktree>/openspec/workflow.yaml`、校验值域后写入 `state.mode`；state 已存在（recovery / 重复初始化 / 切换任务组）时不再读配置，沿用 state 既有 mode；旧 state 缺 mode 字段一律按 full 处理 [spec:workflow-mode#模式在变更开始时固化]
- [ ] 1.4 新增 `assets/workflows/task-simple.yaml` 流程文件骨架：`implement`（agents: openspec-developer，transitions on_pass: quality_review / on_fail: implement 自循环，constraints 不含 `{{allowed_directories}}` / `{{allowed_packages}}` / `{{notes}}` 边界占位符——执行边界默认整个 worktree）+ `quality_review`（agents: openspec-reviewer，capability_tags: {quality-gate, api-testing, dev-practices, efficiency, style, architecture, performance, security, maintainability, tool-improvement}，transitions on_pass: done / on_fail: implement 回整步重审）；顶层 `common` 复用 task.yaml 的 `_agent` 传递指引与「缺省视为编排视角」提示文案。验收：task-simple.yaml 加载后 quality_review.capability_tags 应为上述 10 项集合 [spec:workflow-mode#simple 流程步骤]
- [ ] 1.5 `task-simple.yaml` 的 quality_review step 语义合并：instructions / constraints / capability_tags 为 verify_tool + verify_task + verify_quality 三者并集改写（确定性工具检查允许、任务验证 verified_tasks/failed_tasks、维度审查与工具改进双报、只报不改）；删除 verify_quality 的「禁止运行确定性工具检查」约束与「禁 bash」表述；能力集并集使 Skill 加载清单与必做清单（`renderSkillSuggestions` / `uncoveredMustDo`）自然覆盖全部维度与工具链。验收：constraints 不含「禁止运行确定性工具检查」与禁 bash 表述；instructions 含工具改进双报与只报不改语义 [spec:agent-definitions#simple 审查者执行确定性检查与任务验证]
- [ ] 1.6 `src/core/workflow/loader.ts` 新增 `resolveWorkflowPath(state)` 辅助（simple → task-simple.yaml，否则 task.yaml），替换三个消费点的 `TASK_WORKFLOW_PATH` 直用：`lifecycle.statusExecute`、`lifecycle.applyRecoveryState`（增加 mode 参数）、`src/core/tools/submit.ts` 的 `loadTaskWorkflow`（先读 state 再选文件）；其余编排者工具（setWorktree / setUnattended）无模式相关改动 [spec:workflow-mode#simple 流程步骤]
- [ ] 1.7 测试：模式固化（新建 state 写入 / 重复初始化与切换任务组沿用 / 旧 state 缺 mode 兜底 full 不写回）、配置值域外与 YAML 解析失败报错、task-simple.yaml 可经 `loadWorkflowFile` 加载且结构正确（双文件并行缓存）、`resolveWorkflowPath` 按 state.mode 选择文件 [spec:workflow-mode]
- [ ] 1.8 质量门：`bun run typecheck` 与 `bun test` 全量通过 [infra]

## 2. 引擎与提交适配（simple 门禁与提交检查）

<!-- 本组 4-8 个任务。独立迭代：实现 + 测试 + 质量门。
     组内任务按依赖链排列：定义 → 实现 → 测试 → 质量门。 -->

- [ ] 2.1 `src/core/workflow/engine.ts` 的 `REVIEW_STEP_TO_LAYER` 增加一行 `quality_review: "quality"`；确认 `stepCanPass`（本层 blocking issue 终态才可 pass）、`blockingStepChildren`（blocked 诊断）、`recommendForItem`（review step 补交推导）、`renderBlocked`（待复核/待裁定区块）全链联动生效 [spec:workflow-mode#simple 流程步骤]
- [ ] 2.2 `src/core/tools/submit.ts`：`state.mode === "simple"` 且提交 step 为 implement（in_progress）时，在 `submitForStep` 前执行 `isWorktreeClean(wtPath)` 强检查，不干净直接拒绝并提示先 commit；收尾门禁的 worktree 干净检查原样保留作最终兜底 [spec:workflow-mode#提交时工作区干净强检查]
- [ ] 2.3 `src/core/tools/submit.ts` 的 `assertFailedHasReason` 增加 quality_review 分支（修复 openspec-reviewer 维度过滤死锁）：`stepId === "quality_review"` 时理由判定 = 本次新报含 Low+ issue 或存在 quality 报源（`sourcePhase === "quality"`）未终态阻塞 issue，不按 `agentToReviewDimension` 过滤；full 模式各 verify step 分支不受影响 [spec:workflow-mode#quality_review 合并审查与整步重审]
- [ ] 2.4 测试：引擎门禁（quality_review 按 quality 层口径——阻塞 issue 终态才可 pass；blocked 推导与补交判定对 quality_review 生效；implement 失败自循环触发 `clearStepTags` 保证 dev 重派；quality_review 失败回 implement 整步重审与重派）[spec:workflow-mode#implement 失败自循环重试]
- [ ] 2.5 测试：提交工具（工作区不干净拒绝 / 干净放行；quality_review failed 理由判定不按维度过滤；谁提谁裁定按 quality_review step agents 反推天然命中；simple 审查者未声明 dimension 上报被拒；重复提交守卫按 tag passed 判定兼容失败重提；`resetReviewTagsOnFix` / `clearReviewVerificationTags` 对 verify_* tag 在 simple 下空操作无副作用）[spec:agent-identity#simple 审查者 issue 显式声明 dimension]
- [ ] 2.6 质量门：`bun run typecheck` 与 `bun test` 全量通过 [infra]

## 3. 视图与生命周期适配（simple 全链路运转）

<!-- 本组 4-8 个任务。独立迭代：实现 + 测试 + 质量门。
     组内任务按依赖链排列：定义 → 实现 → 测试 → 质量门。 -->

- [ ] 3.1 `src/core/tools/lifecycle.ts` 的 `createInitialWorkItem` 初始 step 模式感知：simple 模式新建 item（含非活跃组）初始 phase `in_progress`、currentStep `implement`（无 analyze，执行边界默认整个 worktree），避免 `phaseStepMismatch` 状态异常 [spec:workflow-mode#simple 流程步骤]
- [ ] 3.2 `src/core/tools/lifecycle.ts` 的 `applyRecoveryState` 模式感知：simple 分支——task_analysis / dev_impl 均落 in_progress/implement（task_analysis 重置 task children 全 todo，dev_impl 保留既有进度）；review 分支——implement 置 passed、quality_review 的 failed tag 删除回 pending、currentStep 落 quality_review、task children 缺省 done；`reset_steps` / `review_layer` 参数在 simple 下接受但空操作（值域校验不变，文档标注无效）[spec:workflow-mode#模式在变更开始时固化]
- [ ] 3.3 `src/core/workflow/status.ts` 的 `STEP_ID_TO_CONTEXT_KIND` 增加 `quality_review → "review_merged"`，新增合并渲染器：Task(待验证) + Issue(待复核) + Issue(待裁定是否可豁免) 三个区块（复用 `renderTaskChildren` / `renderChildrenSection`，任务验证语义来自 verify_task、issue 归属来自 quality 层）[spec:agent-identity#simple 审查者名下清单可见]
- [ ] 3.4 `src/core/workflow/status.ts` 的 `isAgentOwnedIssue` 归属扩展：quality 层调用者但无维度（openspec-reviewer）时，归属判据 = 报源（`metadata.source`）=== 调用者且 review 态；`isQualityAdjudicable` 增加无维度调用者分支——报源 === 调用者且带 `exempt_request` 标记即可裁定（与 blocked 视图 `isAdjudicableExempt` 口径一致）；分派视图（`renderProgressSection`）由 workflow.phases 驱动，无需改动 [spec:agent-identity#simple 审查者名下清单可见]
- [ ] 3.5 测试：视图归属与渲染（simple 审查者可见名下待复核 / 待裁定豁免清单；非名下 issue 不出现；full 模式 verify_quality 5 逻辑身份并行视图回归）[spec:agent-identity]
- [ ] 3.6 测试：生命周期（simple 新建 item 无 phaseStepMismatch；recovery 三阶段落位与 reset_steps/review_layer 空操作；收尾门禁保留——worktree 干净、blocking issue 终态、task 终态、blocker resolved；合并冲突返回 blocked 后 dev 解决冲突再重调 complete 完成收尾）[spec:workflow-mode#收尾裸合并]
- [ ] 3.7 质量门：`bun run typecheck` 与 `bun test` 全量通过 [infra]

## 4. 物理 agent 合并与权限并集

<!-- 本组 4-8 个任务。独立迭代：实现 + 测试 + 质量门。
     组内任务按依赖链排列：定义 → 实现 → 测试 → 质量门。 -->

- [ ] 4.1 合并 `assets/agents/openspec-developer.md`：承载 developer + architect 两个逻辑身份的提示词（角色内容合并）；permission 取并集 `edit: allow` + `bash: allow`；architect 身份的「仅可 edit md 文档」约束保留于提示词；按「agent 定义不含实现细节」原则只写角色定位与边界，不写流程 [spec:agent-definitions#仅两个物理 agent 定义]
- [ ] 4.2 合并 `assets/agents/openspec-reviewer.md`：承载 tool / task / 5 维度 / simple 审查者提示词（角色内容合并）；permission 取并集 `edit: allow` + `bash: allow`；写明「只报不改」指令——文档/注释类（不影响代码运行）可直改，逻辑类一律只报（full 模式维度审查同样适用）；含确定性检查与任务验证职责边界；不写流程细节 [spec:agent-definitions#审查者只报不改]
- [ ] 4.3 删除其余 8 个 agent 文件（openspec-architect.md、openspec-reviewer-tool/task/architecture/maintainability/performance/security/style.md），`openspec-main.md` 主代理模板保留；核对 `assets/workflows/task.yaml` 逻辑身份名（openspec-reviewer-tool 等）不变——无文件级改动，仅物理承载变化 [spec:agent-definitions#仅两个物理 agent 定义]
- [ ] 4.4 测试断言同步：`tests/adapters.inject.test.ts` / `tests/deepseek-harness.test.ts` / `tests/plugin.test.ts` 等引用已删除 agent 文件的断言改为断言 2 个物理子代理 + main 模板注入 [infra]
- [ ] 4.5 测试：权限并集与注入收敛（`assets/agents/` 只剩 3 个文件；permission frontmatter 为 `edit: allow`；DSH `denyEditTools` 读到 reviewer `edit: allow` 后不设写工具过滤；plugin-common / claude-code / zcode / codex 扫描注入自动收敛为 2 个物理子代理，零代码改动）[spec:agent-definitions#物理权限取并集]
- [ ] 4.6 质量门：`bun run typecheck` 与 `bun test` 全量通过 [infra]

## 5. 适配层改造（OpenCode MCP 化与 codex 白名单）

<!-- 本组 4-8 个任务。独立迭代：实现 + 测试 + 质量门。
     组内任务按依赖链排列：定义 → 实现 → 测试 → 质量门。 -->

- [ ] 5.1 OpenCode 直载改 MCP 形态（BREAKING）：`src/adapters/opencode/tools.ts` 移除直载工具注册与 `makeCtx` 身份推导路径；插件壳改为注入 MCP server 配置（stdio bundle，`--worktree` 指向项目根），与 claude-code / zcode / codex 插件的 `.mcp.json` 形态一致；身份统一走 mcp-common 的 `_agent` 解析；MCP 配置键的具体形态按 opencode 官方插件 schema 实现时确认（design.md Open Questions，不影响其余 harness）[spec:agent-identity#逻辑身份经 _agent 参数承载]
- [ ] 5.2 `src/adapters/opencode/agents.ts` 注入收敛为只注入 2 个物理子代理 + 主代理模板（扫描逻辑不变，文件收敛后自动生效，核对无其他适配改动）[spec:agent-definitions#仅两个物理 agent 定义]
- [ ] 5.3 `src/adapters/codex/index.ts` 的 `AGENT_TOOLS` 新增 `openspec-reviewer` 条目：`"openspec-reviewer": ["read", "grep", "glob", "ls", "bash", "apply_patch", "web"]`（审查者可直改文档/注释需要 apply_patch；现状 7 个 reviewer 无独立条目、统一走 default 白名单，无需删除任何条目）；`openspec-developer` 条目不变 [spec:agent-identity#逻辑身份经 _agent 参数承载]。注：实施同时移除 `AGENT_TOOLS` 中 openspec-architect 的死条目——已无对应 agent 文件（architect 逻辑身份由 openspec-developer 条目承载，读/写能力被该条目覆盖），保留只会继续悬挂无效引用
- [ ] 5.4 测试：opencode 插件产物（无直载工具注册、注入 MCP server 配置）、codex agents TOML 工具白名单、各 harness 身份传递行为一致（mcp-common `resolveContext` 的 `_agent` 解析回归，含缺省视为编排视角）[spec:agent-identity]
- [ ] 5.5 质量门：`bun run typecheck`、`bun test` 与 `bun run build:plugins`（全插件包构建）通过 [infra]

## 6. 文档同步与全量回归

<!-- 本组 4-8 个任务。独立迭代：实现 + 测试 + 质量门。
     组内任务按依赖链排列：定义 → 实现 → 测试 → 质量门。 -->

- [ ] 6.1 README.md 同步：逻辑身份模型（9 种逻辑身份经 `_agent` 参数承载、物理 agent 收敛说明）与模式语义（full/simple、init 固化、旧 state 默认 full、进行中配置改动不影响已开始变更）[spec:agent-identity#逻辑身份经 _agent 参数承载]
- [ ] 6.2 README.md 同步：身份自述安全边界（`_agent` 为纯自述、无硬校验，裁定权与视图路由信任自述值）与 OpenCode 用户切换 MCP 接入方式的迁移指引 [spec:agent-identity#身份自述软约束与安全边界]
- [ ] 6.3 测试：simple 模式端到端用例（FakeGitRunner 驱动完整链路——init 固化 → implement 提交（含工作区不干净拒绝）→ quality_review 清单可见与 issue 上报（维度必填）→ 谁提谁裁定复核/豁免 → 失败自循环重试 → 通过后收尾裸合并；含合并冲突由 dev 解决后直接收尾路径）[spec:workflow-mode#收尾裸合并]
- [ ] 6.4 测试：全量回归——`bun test` 与 `bun run typecheck` 全绿（含 full 模式既有流转断言不受身份逻辑化影响）[infra]
- [ ] 6.5 验证：`bun run build:plugins` 产物包含 `assets/workflows/task-simple.yaml` 与收敛后的 2 个物理 agent（bundle 内容与源文件一致）[infra]
- [ ] 6.6 `orchestrator/SKILL.md`（编排主代理 skill）注明 verify_quality 以同一物理 reviewer 不同 `_agent` 多次分派的分派范式 [infra]

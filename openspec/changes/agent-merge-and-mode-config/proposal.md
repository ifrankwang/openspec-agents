## Why

当前编排以 9 个物理 agent 文件承载 9 种身份（architect、reviewer-tool、reviewer-task、5 个维度 reviewer），定义冗余、维护成本高；OpenCode 直载形态下身份由会话运行时硬绑定，与其他 harness 行为不一致。同时 full 流程环节多、审查轮次多，轻量变更场景 token 消耗大。需要收敛为「2 个物理 agent + 逻辑身份路由」，并以模式配置支持精简流程。

## What Changes

- 物理 agent 合并：`assets/agents/` 只保留 `openspec-developer.md`、`openspec-reviewer.md`（主代理模板 `openspec-main.md` 保留），其余 agent 文件移除。**BREAKING**：9 种逻辑身份（architect、reviewer-tool、reviewer-task、5 维度 reviewer、simple 纯身份）不再有独立文件，统一经 `_agent` 参数承载，仅作为 `opx_status` 视图路由、issue 的 source/筛选、"谁提谁裁定"的依据与 state tags 的 key 组成部分；身份自述为软约束，无硬校验。
- 新增 `openspec/workflow.yaml` 模式配置（`mode: full | simple`，缺省 full）。模式在变更开始时经 `opx_orch_init` 固化存档（旧 state 无 mode 字段默认 full），进行中配置改动不影响已开始的变更；recovery 沿用定格模式；不支持中途切换。
- full 模式：现有 step 结构不变，仅身份逻辑化；verify_quality 仍按 5 个逻辑身份并行审查（同一物理 reviewer 多次分派、`_agent` 各异）。
- simple 模式：流程精简为 `implement → quality_review → done` 三步。无 analyze（执行边界默认整个 worktree）、无 verify_tool/verify_task/verify_cleanup（收尾由 `opx_orch_complete_task_group` 直接合并清理，裸合并、无回归、无环境清理）；implement 失败自循环重试；quality_review 由单一审查者合并承担工具检查 + 任务验证 + 质量审查（工具改进建议双报机制保留，由开发者实施），审查失败回 implement 整步重审；dev 提交时强检查工作区干净（收尾必过）；合并冲突由 dev 解决后直接收尾。
- 权限边界：物理权限取并集（维度 reviewer 获得 edit/write 能力）；审查行为以"只报不改"指令约束兜底——文档/注释类（不影响代码运行）问题审查者可直接修改，其余问题一律只报不改，full 模式维度审查同样保留该约束。
- 视图层改造：simple 审查者必须能通过 `opx_status` 看到自己名下的待复核、待批准清单；simple 审查者报 issue 显式声明归因 dimension，走 quality 层"谁提谁裁定"路由。
- OpenCode 适配层由直载形态改为 MCP 形态。**BREAKING**：身份传递统一走 `_agent` 参数，使各 harness（OpenCode / Claude Code / ZCode / Codex / DeepSeek Harness）行为一致；文档标注"身份自述、无硬校验"的安全边界。
- 各 harness 适配器、workflow 配置与 README 文档随以上变更同步。

## Capabilities

### New Capabilities

- `workflow-mode`: `openspec/workflow.yaml` 模式配置（full / simple）的语义、模式在变更开始时固化的行为，以及 simple 模式三步流程（implement → quality_review → done，含工作区干净强检查、收尾裸合并、无回归）的行为契约
- `agent-identity`: 物理 agent 合并后的逻辑身份模型——`_agent` 参数路由语义、身份自述软约束与安全边界、简单审查者的 issue 归属（显式 dimension 声明 + quality 层裁定）与清单可见性
- `agent-definitions`: 合并后的 agent 定义内容组织——`openspec-developer.md` / `openspec-reviewer.md` 的角色边界、权限并集语义与"只报不改"（文档/注释类可直改）指令约束

### Modified Capabilities

无。`openspec/specs/` 当前为空，本变更不修改任何既有 capability。

## Impact

- 编排核心：`src/core/tools/`（模式固化、implement 提交工作区干净强检查、收尾门禁口径）、`src/core/workflow/`（simple 流程状态机与 step 语义）、`src/core/workflow/status.ts` + `src/core/constants.ts`（视图层归属与清单展示）。
- 适配层：`src/adapters/opencode/` 改 MCP 形态；`src/adapters/claude-code/`、`src/adapters/zcode/`、`src/adapters/codex/`、`src/adapters/deepseek-harness/` 同步身份传递方式。
- 配置与文档：`assets/agents/`（agent 文件合并）、`assets/workflows/`（step 语义归属）、README.md（身份与模式语义说明）。
- 无新增外部依赖；既有 9 种逻辑身份的文件产物对用户可见形态发生变化（删除 8 个旧 agent 文件（openspec-architect + 7 个维度/层 reviewer））。

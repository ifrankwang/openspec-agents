# Clarification Record — agent-merge-and-mode-config

变更澄清记录。本文件基于逐轮 grilling 问答记录（`.review/interview.md`）整理，所有问题均基于对现有代码的核查提出（身份解析、状态机、workflow 加载、收尾门禁、agent 文件现状）。

## Open Questions

- **物理 agent 合并与身份退化（P1）**：OpenCode 直载形态身份由会话运行时硬绑定；改 MCP 形态后身份变为 `_agent` 工具参数纯自述，任何调用者传什么字符串就信什么。子代理可自称任意逻辑身份去裁定他人 issue、提交他层 step，是否需要补偿机制（如 session→逻辑身份登记）？
- **物理合并后权限边界（P2）**：一个物理文件只能有一份 permission。现状权限按身份分（architect 仅可 edit md、维度 reviewer 完全禁止 edit/write、task reviewer 可跑测试）。合并后取并集会让维度 reviewer 拿到 edit/write；不下沉到工具侧按 `_agent` 动态授权则权限边界名存实亡。选哪个？
- **simple 纯身份的归属路由（P3）**：`openspec-reviewer`（simple 纯身份）不在 agentToReviewDimension / agentToReviewLayer 映射表内。其报 issue 会撞强制校验（未命中维度映射必须显式声明 dimension）；报源为 `openspec-reviewer` 的 issue 在"谁提谁裁定"路由里属于哪层、谁能裁定，没有定义。
- **中途切模式的迁移（P4）**：模式动态生效则 verify_quality 期间切 simple 后旧维度 issue 的复核/裁定无人可做；定格则"中途切模式"场景不存在。"重置 review tags"与现有 recovery.reset_steps 机制是什么关系？
- **verify_cleanup 消失的代价（P5）**：verify_cleanup 职责含合并基准分支最新代码 + 解冲突、回归复验、环境清理；complete 工具只做分支合并 + worktree 清理，且收尾门禁要求 worktree 干净（有未提交内容直接拒绝）。simple 模式没有确认干净的步，谁在 quality_review 通过前 commit？
- **simple 审查语义来源（P6）**：`workflow.yaml` 只有 mode 字段，装不下 step 级审查语义；simple 的 quality_review 是全新 step，其 instructions/constraints/skill 清单从哪来？
- **simple 审查者的待办清单展示（A，追问）**：视图层硬编码——调用者身份反推不到层时只返回"待修复"态 issue（待复核、待批准清单不可见）；step id 硬编码 6 个，新 step 不命中则 children 区块整体不渲染。simple reviewer 会看不到自己名下的待复核/待批准清单，流程跑到第一次复核或豁免就卡死。要不要写进改造范围？
- **simple 审查者直接改 vs 只报（B，追问）**：simple 审查者发现小问题，直接顺手改掉（省轮次）还是只报问题等 dev 改？full 模式"只报不改"是否保留？
- **冲突解决后的验证（C，追问）**：合并冲突解决后的代码零审查、零回归直接收尾，接受吗？
- **模式固化时机（D，确认）**：模式在变更开始时固化存档，之后配置文件怎么改都不影响进行中的变更；提案里"中途切模式时重置 review tags"整条删掉。对吗？

## User Answers

- **P1**：接受裁定权变成纯提示词软约束。无补偿机制；文档须标注"身份自述、无硬校验"的安全边界。
- **P2**：取并集 = 维度 reviewer 拿到 edit/write。物理权限取并集；full 模式维度审查"只报不改"的行为约束作为指令保留（补充确认见 B）。
- **P3**：走显式 dimension 声明 + quality 层路由。simple reviewer 报 issue 显式声明归因维度；后续核查发现工具层裁定路径（按 step agents 反推报源）本就通，真正缺口在视图层（见 A）。
- **P4**：不允许单 change task group 中途切换。模式在变更开始时固化存档（`opx_orch_init` 时读 `openspec/workflow.yaml` 写入 state；旧 state 无 mode 字段默认 full）；之后配置文件改动不影响进行中的变更；recovery 沿用定格模式；提案原文"中途切模式时重置 review tags"整条删除（用户已确认）。
- **P5**：让 dev submit 时检查工作区是否干净就行了。implement 提交（submit）增加工作区干净强检查，收尾必过；simple 模式裸合并、无回归、无环境清理；合并冲突场景由 dev 解决冲突后直接收尾。
- **P6**：新 step 就是原几个 reviewer step 的 instructions/constraints/skill 合并，确定性、任务检查都是同一个 agent 来干，主要目的是通过共享 review 视角上下文 + 减少轮次往返来降低 token 消耗。
- **A**：ok。新环节的清单展示（待复核 / 待批准）纳入改造范围。
- **B**：除非只是文档层面、注释层面等不影响代码运行的问题，其他一律只报不改。simple 审查者对文档/注释类（不影响运行）问题可直接修改；代码逻辑类问题一律只报不改。full 模式维度审查同样保留"只报不改"指令约束。
- **C**：ok。接受，与"无回归"取舍一致。
- **D**：对。确认。

## Architecture Direction

方向总述：物理 agent 收敛为 2 个 + 1 套逻辑身份，流程按 `openspec/workflow.yaml` 的 mode 分为 full / simple 两种形态；full 保留现有流程结构，simple 精简为三步并合并审查职责；身份信任接受 `_agent` 自述软约束，权限取并集、审查行为以"只报不改"指令约束兜底。

已确认决策（HARD-GATE 已由用户确认）：

1. **物理 agent 合并**：`assets/agents/` 只保留 `openspec-developer.md`、`openspec-reviewer.md`（主代理模板 `openspec-main.md` 保留）；9 种逻辑身份（architect、reviewer-tool、reviewer-task、5 维度 reviewer、simple 模式的 reviewer）经 `_agent` 参数承载，不建独立 agent 文件，仅作为 `opx_status` 视图路由、issue 的 source/筛选、"谁提谁裁定"的依据、state tags 的 key 组成部分。
2. **模式配置**：新增 `openspec/workflow.yaml`（`mode: full|simple`，缺省 full）；变更开始时经 `opx_orch_init` 固化到 state（旧 state 无 mode 字段默认 full），进行中不受配置改动影响；recovery 沿用定格模式；"中途切模式时重置 review tags"整条删除。
3. **full 模式**：现有 step 结构不变，身份逻辑化；verify_quality 仍按 5 个逻辑身份并行（同一物理 reviewer 分派 5 次，`_agent` 各异）；`opx_status` 分派视图给出并行提示。
4. **simple 模式**：流程为 `implement → quality_review → done`；无 analyze（执行边界默认开放整个 worktree）、无 verify_tool/verify_task/verify_cleanup（收尾由 `opx_orch_complete_task_group` 直接合并清理）；`implement.on_fail -> implement` 自循环重试；quality_review 由单一审查者合并承担工具检查 + 任务验证 + 质量审查（指令与 skill 合并），审查失败回 implement 整步重审；dev 提交（submit）时强检查工作区干净，收尾必过；收尾裸合并、无回归、无环境清理；合并冲突由 dev 解决后直接收尾。
5. **身份信任**：接受 `_agent` 自述（软约束），OpenCode 改 MCP 形态，统一走 `_agent` 参数传递逻辑身份使所有 harness 行为一致；文档标注"身份自述、无硬校验"的安全边界。
6. **权限**：物理权限取并集（维度 reviewer 获得 edit/write 能力）；"只报不改"作为指令约束保留——文档/注释类（不影响代码运行）问题 simple 审查者可直接修改，其余一律只报不改；full 模式维度审查同样保留该指令约束。
7. **清单展示**：simple 新环节的审查者必须能看到自己名下的待复核、待批准清单——视图层的身份反推层逻辑与 step id 硬编码需改造，此项为改造范围必含。
8. **issue 归属**：simple reviewer 报 issue 显式声明归因 dimension，走 quality 层"谁提谁裁定"路由（工具层裁定路径本就通，缺口仅在视图层，见 7）。

备选方案与取舍：

- **身份补偿机制**：考虑过引入 session→逻辑身份登记做硬校验，被否——接受纯提示词软约束，换取实现简单与各 harness 行为一致，风险以文档标注安全边界承接。
- **权限动态授权**：考虑过在工具侧按 `_agent` 动态下发权限（保持维度 reviewer 无写权），被否——取权限并集，审查行为靠指令约束（只报不改）兜底。
- **模式动态生效**：考虑过配置文件实时生效并支持中途切模式（配合重置 review tags），被否——不允许单 change task group 中途切换，改为变更开始时固化，避免进行中状态机不一致。
- **simple 保留收尾验证环节**：考虑过在 simple 流程中保留类似 verify_cleanup 的确认步，被否——以 implement submit 时的工作区干净强检查替代，收尾裸合并、无回归、无环境清理（冲突解决后零审查直接收尾为用户明确接受）。

## Initial Capabilities

- `workflow-mode`: openspec/workflow.yaml 模式配置、模式固化、simple 流程生成
- `agent-identity`: 物理 agent 合并、逻辑身份路由、身份软约束语义
- `agent-definitions`: agent 文件合并与内容组织（openspec-developer.md / openspec-reviewer.md）

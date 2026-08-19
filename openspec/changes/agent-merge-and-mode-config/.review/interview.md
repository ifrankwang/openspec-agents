# Interview Record — agent-merge-and-mode-config

变更提议经逐轮 grilling 澄清，以下为完整问答记录。所有问题均基于对现有代码的核查提出（身份解析、状态机、workflow 加载、收尾门禁、agent 文件现状）。

## 变更提议原文（用户提供）

- 物理 agent 只保留 2 个：`openspec-developer.md`（执行者）+ `openspec-reviewer.md`（通用复核者，含 architect / tool / task / 5 维度）。
- 9 种逻辑身份（`openspec-architect`、`openspec-reviewer-tool`、`openspec-reviewer-task`、5 维度 reviewer、simple 模式的 `openspec-reviewer`）不再对应独立 agent 文件，只作为：`opx_status` 视图路由、issue 的 source/筛选、"谁提谁裁定"的依据、state tags 的 key 组成部分。
- 新增 `openspec/workflow.yaml`：`mode: simple` 或 `mode: full`（默认 full）。
- full 模式流程结构不变，reviewer 物理实体合并，身份逻辑化；`opx_status` 在 verify_quality 阶段提示主代理并行启动同一个 reviewer 5 次（不同 `_agent`）。
- simple 模式流程：`implement → quality_review → done`；无 analyze（执行边界默认开放整个 worktree）；无 verify_cleanup（收尾由 `opx_orch_complete_task_group` 直接合并清理）；`implement.on_fail -> implement` 自循环重试。
- OpenCode 改为 MCP 形态，统一走 `_agent` 参数传递逻辑身份，使所有 harness 行为一致。
- simple 模式专属逻辑：执行边界默认开放、整步重审、validation_steps 完整申报、中途切模式时重置 review tags。

## 问题与回答

### P1：OpenCode 身份绑定退化

**问题**：现状 OpenCode 直载形态身份由会话运行时硬绑定（子代理无法伪造）；MCP 形态身份是 `_agent` 工具参数纯自述（任何调用者传什么字符串就信什么）。改动把 OpenCode 降级为纯自述，子代理可自称任意逻辑身份去裁定他人 issue、提交他层 step。要不要补偿机制（如 session→逻辑身份登记）？

**回答**：接受裁定权变成纯提示词软约束。

**结论**：无补偿机制；文档须标注"身份自述、无硬校验"的安全边界。

### P2：物理合并后权限边界

**问题**：一个物理文件的 frontmatter 只能有一份 permission。现状权限按身份分（architect 仅可 edit md、维度 reviewer 完全禁止 edit/write、task reviewer 可跑测试）。合并后取并集 = 维度 reviewer 拿到 edit/write；不下沉到工具侧按 `_agent` 动态授权 = 权限边界名存实亡。选哪个？

**回答**：取并集 = 维度 reviewer 拿到 edit/write。

**结论**：物理权限取并集；full 模式维度审查"只报不改"的行为约束作为指令保留（补充确认见 B）。

### P3：simple 纯身份的归属路由

**问题**：`openspec-reviewer`（simple 纯身份）不在 agentToReviewDimension / agentToReviewLayer 映射表内。simple reviewer 报 issue 会撞强制校验（未命中维度映射必须显式声明 dimension）；报源为 `openspec-reviewer` 的 issue 在"谁提谁裁定"路由里属于哪层、谁能裁定，没有定义。怎么走？

**回答**：走显式 dimension 声明 + quality 层路由。

**结论**：simple reviewer 报 issue 显式声明归因维度；后续核查发现工具层裁定路径（按 step agents 反推报源）本就通，真正缺口在视图层（见 A）。

### P4：中途切模式的迁移

**问题**：模式动态生效则 verify_quality 期间切 simple 后旧维度 issue 的复核/裁定无人可做；定格则"中途切模式"场景不存在。动态还是定格？"重置 review tags"与现有 recovery.reset_steps 机制是什么关系？

**回答**：不允许单 change task group 中途切换。

**结论**：模式在变更开始时固化存档（`opx_orch_init` 时读 `openspec/workflow.yaml` 写入 state；旧 state 无 mode 字段默认 full）；之后配置文件改动不影响进行中的变更；recovery 沿用定格模式；提案原文"中途切模式时重置 review tags"整条删除（用户已确认）。

### P5：verify_cleanup 消失的代价

**问题**：verify_cleanup 职责里有合并基准分支最新代码 + 解冲突、回归复验、环境清理，complete 工具只做分支合并 + worktree 清理，且收尾门禁要求 worktree 干净（有未提交内容直接拒绝）。simple 模式没有确认干净的步，谁在 quality_review 通过前 commit？

**回答**：让 dev submit 时检查工作区是否干净就行了。

**结论**：implement 提交（submit）增加工作区干净强检查，收尾必过；simple 模式裸合并、无回归、无环境清理；合并冲突场景由 dev 解决冲突后直接收尾。

### P6：simple 审查语义来源

**问题**：`workflow.yaml` 只有 mode 字段装不下 step 级审查语义；simple 的 quality_review 是全新 step，instructions/constraints/skill 清单从哪来？

**回答**：新 step 就是原几个 reviewer step 的 instructions/constraints/skill 合并，确定性、任务检查都是同一个 agent 来干，主要目的是通过共享 review 视角上下文 + 减少轮次往返来降低 token 消耗。

**结论**：simple 模式由一个审查者承担原 verify_tool + verify_task + verify_quality 的全部职责（合并指令与 skill 集）；动机为降 token。

### A：simple 审查者的待办清单展示（追问）

**问题**：核查发现视图层硬编码：调用者身份反推不到层时只返回"待修复"态 issue（待复核、待批准清单不可见）；step id 硬编码 6 个，新 step 不命中则 children 区块整体不渲染。simple reviewer 会看不到自己名下的待复核/待批准清单，流程跑到第一次复核或豁免就卡死。这项要不要写进改造范围？

**回答**：ok。

**结论**：新环节的清单展示（待复核 / 待批准）纳入改造范围。

### B：simple 审查者直接改 vs 只报（追问）

**问题**：simple 审查者发现小问题，直接顺手改掉（省轮次）还是只报问题等 dev 改？full 模式"只报不改"是否保留？

**回答**：除非只是文档层面、注释层面等不影响代码运行的问题，其他一律只报不改。

**结论**：simple 审查者对文档/注释类（不影响运行）问题可直接修改；代码逻辑类问题一律只报不改。full 模式维度审查同样保留"只报不改"指令约束。

### C：冲突解决后的验证（追问）

**问题**：合并冲突解决后的代码零审查、零回归直接收尾，接受吗？

**回答**：ok。

**结论**：接受，与"无回归"取舍一致。

### D：模式固化时机（确认）

**问题**：模式在变更开始时固化存档，之后配置文件怎么改都不影响进行中的变更；提案里"中途切模式时重置 review tags"整条删掉。对吗？

**回答**：对。

**结论**：确认。

## Architecture Direction（HARD-GATE 已由用户确认）

1. **物理 agent 合并**：`assets/agents/` 只保留 `openspec-developer.md`、`openspec-reviewer.md`（主代理模板 `openspec-main.md` 保留）；9 种逻辑身份经 `_agent` 参数承载，不建独立 agent 文件。
2. **模式配置**：新增 `openspec/workflow.yaml`（`mode: full|simple`，缺省 full）；变更开始时固化到 state，进行中不受配置改动影响。
3. **full 模式**：现有 step 结构不变，身份逻辑化；verify_quality 仍按 5 个逻辑身份并行（同一物理 reviewer 分派 5 次，`_agent` 各异）；`opx_status` 分派视图给出并行提示。
4. **simple 模式**：`implement → quality_review → done`；无 analyze（执行边界默认开放 worktree）、无 verify_tool/verify_task/verify_cleanup；quality_review 由单一审查者合并承担工具检查 + 任务验证 + 质量审查（指令与 skill 合并）；审查失败回 implement 整步重审；收尾裸合并、无回归；dev 提交时强检查工作区干净；冲突由 dev 解决后直接收尾。
5. **身份信任**：接受 `_agent` 自述（软约束），OpenCode 改 MCP 形态，文档标注安全边界。
6. **权限**：物理权限取并集；"只报不改"作为指令约束保留（文档/注释类问题 simple 审查者可直接改，其余只报）。
7. **清单展示**：simple 新环节的审查者必须能看到自己名下的待复核、待批准清单（改造范围必含）。
8. **issue 归属**：simple reviewer 报 issue 显式声明 dimension，走 quality 层路由。

## Initial Capabilities

- `workflow-mode`: openspec/workflow.yaml 模式配置、模式固化、simple 流程生成
- `agent-identity`: 物理 agent 合并、逻辑身份路由、身份软约束语义
- `agent-definitions`: agent 文件合并与内容组织（openspec-developer.md / openspec-reviewer.md）

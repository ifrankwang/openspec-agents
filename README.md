# openspec-orchestrate

OpenCode 编排插件。提供 OpenSpec change 编排、workflow 引擎驱动的任务流转、阻塞升级、隔离开发与三层 Review 门禁。

## 架构

`analyze → implement → verify_tool → verify_task → verify_quality → done → 收尾`

编排由 workflow 引擎按 step 驱动，各 step 的裁决统一通过 `opx_agent_submit` 提交。
编排者（orchestrator）只负责分派子代理，不自已写代码、审查或测试。

### 整体流程

每个 task WorkItem 由 workflow 引擎按 step 驱动执行：

`todo(analyze) → in_progress(implement) → review(verify_tool → verify_task → verify_quality) → done`

| Phase | step | 目标 |
|------|------|------|
| todo | analyze | 架构师校验需求、设计、任务与实施前提，输出执行边界 |
| in_progress | implement | developer 实施任务、验证改动，提交时声明完成/阻塞 |
| review | verify_tool → verify_task → verify_quality | 依次执行工具、任务与质量门禁 |
| done | （终态） | 全部审核通过，由 `opx_orch_complete_task_group` 收尾合并分支 |

编排者只分派子代理，不编写代码、不审查、不测试。每次子代理返回后，编排者调用 `opx_status`；该工具是下一步调度的唯一事实源。

Review 阶段依次执行 tool、task、quality 三层门禁；verify_tool 依据上次工具检查以来的变更检测结果，无代码/配置变更时直接提交通过，有变更时运行全量工具检查，或经审查确认变更仅为注释/文档性且无逻辑影响后免全量提交；免全量时该轮不执行确定性质量扫描，由 dev 本地构建与后续任务/质量门禁兜底。质量门 skill 在 frontmatter 声明机器可读的必做清单（`must_do`，与正文必做检查表格一一对应）；verify_tool 提交 passed 时 `validation_steps` 须逐项覆盖该必做清单（completed=true 附结果，或 completed=false 以结构化 `skip_reason` 申报降级理由：JSON 含 item/category/adjudication，adjudication 取值 user_response/unattended_auto/env_unavailable），遗漏必做项或缺结构化降级理由的提交被门禁拒绝——未声明 `must_do` 的 skill 与解析不到质量门 skill 的 step 自动豁免；无变更直提/注释性变更免全量分支以 step 名首段为 `no_change` 的条目申报整体豁免必做清单。任一 step 裁决 failed 回退 implement 修复（analyze 失败回退 analyze 重查）。某 step 重试次数达到上限（默认 10 次）且仍存在未解决 children 时引擎进入检查点态，由编排者经 `opx_agent_submit` 的 `checkpoint_decision` 决策：`continue` 重置该 step 重试继续，`giveup` 放弃遗留 issue（置 cancelled）并将该 step 标记完成，随后自动沿状态机推进——末位 step 直接落 done 可收尾，非末位 step 落下一个待执行 step，同时把未解决 blockers 置为已解决，避免放弃后无法收尾；giveup 前对质量门 step 先核对必做清单覆盖度，未覆盖项须经 `checkpoint_skip_reasons` 逐项提供结构化降级理由，缺理由拒绝 giveup（杜绝放弃审查后无痕推进收尾的绕过通道）。需用户拍板的需求/设计问题由架构师在 analyze step 直接向用户确认（有人值守）或自行裁决（无人值守），确认/裁决后当场继续、不留档；确属阻塞的缺口由架构师上报 blocker，同环节继续复核至完成。quality reviewer 对可工具化的 pattern 在报业务 issue 的同时须报工具改进 issue，通过调整确定性质量扫描工具配置（规则收紧/新增规则）统一收敛同类问题，减少人工重复审查。

issue 与任务共享 phase 体系：reviewer 提报 → todo → developer 修复并经 `fixed_issue_ids` 上报 → review（待复核）→ 报 issue 的 reviewer 复核裁定（谁提谁裁定）：通过置 done，驳回回 todo 并累计修复未过次数（≥2 须先 5-Why 根因分析）。done/cancelled 终态由复核（verify_* 各层）、豁免裁定或检查点 giveup 置入；developer 提交修复只进入 review 待复核，不直接置终态。多 agent 聚合 step（verify_quality 5 维并行）中，维度名下有未裁定豁免申请时会在聚合等待期重新唤起报源 reviewer 履行裁定权；维度名下 blocking issue 已全部终态且无在途豁免申请时该维度自动视为通过，避免 failed 维度永不重派导致聚合无法收敛。

具体阶段流转、工具参数、状态与门禁规则以 `src/core/` 与 `assets/workflows/` 实现为准。README 不重复这些细节，避免文档与代码漂移。

## Workflow 引擎

编排状态机由单一 task workflow 驱动：`assets/workflows/task.yaml` 声明任务流转（phase → steps → agents → transitions），并通过顶层 `common` 块与 step 级 `instructions`/`constraints` 承载跨 step 共享与 step 专属的操作指引与约束，由 `opx_status` 合并渲染。`opx_agent_submit` 提交裁决后沿 transitions 推进状态机；`src/core/workflow/` 为引擎实现（loader / engine / submit / status），collector 负责从外部源拉取并产出 WorkItem，poller 定时将新增项写入 state.workItems。

## 快速开始

### 安装

```bash
# 在 OpenCode 项目中将此插件加入依赖
bun add @opencode-ai/openspec-orchestrate
```

### 使用

1. 在 OpenCode 配置中注册插件
2. 编排者调用 `opx_orch_init` 初始化任务组
3. 根据 `opx_status` 提示分派角色或准备 worktree
4. 按 `opx_status` 指引分派子代理，完成 analyze → implement → 三层 Review 与收尾

### 编排看板

插件加载时自动在 `http://127.0.0.1:4519` 启动编排进度看板。按 WorkItem phase 展示 5 列看板（todo/in_progress/review/done/cancelled），卡片含各 step:agent 裁决与 children 明细。只读、2s 轮询刷新。端口被占用时自动递增探测。

## 命令

| 命令 | 用途 |
|------|------|
| `bun test` | 运行所有测试 |
| `bun run typecheck` | TypeScript 类型检查 |

## 项目结构

```
src/index.ts                  — 插件入口与工具注册
src/adapters/opencode/        — OpenCode 适配层（工具注册、参数 schema、agent/skill 注入）
src/core/tools/               — 编排工具实现（生命周期、通用 step 提交）
src/core/workflow/            — workflow 引擎（状态机、collector、poller、状态视图）
src/core/                     — 状态持久化、视图渲染、看板投影、git/命名空间等基础设施
src/skills/                   — skill 扫描与解析
src/dashboard/                — 看板页面服务
assets/agents/                — agent 定义
assets/skills/                — 内置 skill 定义
assets/workflows/             — workflow 定义（task.yaml）
assets/dashboard/             — 看板页面
tests/                        — Bun 测试，使用 FakeGitRunner
```

## 核心特性

- **Workflow 引擎**：`assets/workflows/task.yaml` 声明 step 流转与 agent 归属，引擎驱动状态机；collector 从外部源（OpenSpec change / ADO）拉取并产出 WorkItem，poller 定时写入 state.workItems
- **编排进度看板**：插件加载时启动 HTTP 看板服务，按 WorkItem phase 实时展示 5 列看板及 step:agent 裁决、children 明细（2s 轮询、只读）
- **状态持久化**：状态文件按 changeId 拆分并写入主仓库；会话通过工具显式传入的 change_id 定位状态文件；worktree 内 session 通过 `context.json` 指针辅助解析
- **阻塞升级**：不可自主决策的问题持久化、暂停、用户恢复、架构复核
- **Worktree 隔离**：`git worktree` 分支隔离，自动合并清理。`opx_agent_submit` 检测到主仓库本 change 目录下的 openspec 文档污染时自动并入 worktree 分支并清理主仓库工作树
- **执行边界**：架构师限定 developer 的目录和包范围，reviewer 新报 issue 自动扩展
- **豁免机制**：developer 通过 `exempt_issue_ids` 申请豁免，issue 进入 review（待裁定）态 → 报 issue 的 review step 通过 `exempt_adjudications` 裁定（dismissed→cancelled、rejected→回修）。裁定为 dismissed 且 issue 携带工具规则（rule）时，豁免结论写入主仓库根 `.opencode/.orchestrate_state/exemptions.json` 项目级跨 change 豁免清单（原子写 + 专用目录锁，并发安全）；后续新 change 的 tool review 全量扫描提报同 (rule+file+line) 的存量问题时自动降为 Info 级，不阻塞、无需重复豁免，视图以「存量豁免提示」标注
- **校验守卫**：多维度校验确保流程完整性
- **状态异常防护**：`opx_status` 检测到 phase ↔ step 归属错位（含 currentStep 指向未声明 step）时，子代理一律收到 ⛔ 状态异常拒绝视图（禁止执行任何 opx_* 变更操作），orchestrator 收到 ⚠️ 诊断并指引 `opx_orch_init(recovery=...)` 恢复；`opx_agent_submit` 对错位态提交同样抛错拒绝，零状态变更
- **空返回续派兜底**：子代理空返回/取消（未提交、无返回结果）时，编排者调 `opx_status` 携带 `resume_sessions` 登记最近分派会话；该子代理仍待分派时，分派视图提示用 task 工具 `task_id` 复用原会话续派（保留上下文、避免全新重派重复消耗），已提交后记录自动清除
- **资源隔离命名空间**：每个 change 分配稳定隔离标识（SHA256(changeId) 前 6 位 hex），Agent 通过 `opx_status` 视图获取；隔离标识派生 SonarQube projectKey 后缀、docker compose 项目名与应用端口，并发 change 在外部共享资源（扫描项目、应用端口、容器）上互不冲突。历史进行中 change 的状态读取时自动补全隔离标识，无需手动迁移；旧 key 产生的扫描数据不可追溯，但 issue 清单已固化在 state，不影响继续编排

## 文档检索渠道

子代理需要外部框架/工具的权威文档（规则语义、API 用法、配置说明）时，统一通过文档检索渠道获取，禁止为获取此类知识解析源码、jar 包或执行 AST dump。渠道分层与降级路径如下：

| 层级 | 职责 | 说明 |
|------|------|------|
| 主渠道 | 按库名查任意框架的权威文档 | 免 key 起步，支持可选 API key 提升配额 |
| 备选渠道 | 查任意公开 GitHub 仓库（文档与代码） | 动态端点，无需预选仓库 |
| 兜底 | opencode 内置 websearch / webfetch | 前两者不可用时使用 |

### 规则定义权威源

PMD 规则定义（category XML 声明式定义，GitHub raw 直拉）与官方文档锚点页、SonarQube Web API（`/api/rules/search`）返回的规则定义均属声明式规则定义来源，非规则实现源码，归入文档检索渠道，供技能方法论检索规则语义使用。

### 配置方式

在用户级 `~/.config/opencode/opencode.json` 的 `mcp` 块声明上述远程 MCP server。主渠道可选：配置 `CONTEXT7_API_KEY` 环境变量并相应在 headers 中引用后，可获得更高免费配额。

### 降级路径

主渠道不可用（超时/配额耗尽/服务故障）时依次尝试备选渠道与兜底工具；仍不可获取时按阻塞流程上报，不以翻源码替代。

### 免费配额与隐私

主渠道免费额度 1000 次/月，调用仅上送库名与查询文本，不上送项目源码或其他上下文；备选渠道仅访问公开仓库内容。

## 关键技术约定

- 工具前缀 `opx_`
- Agent 命名模式 `openspec-{role}`
- Orchestrator mode=primary，其余 mode=subagent
- Orchestrator 仅允许 opx_* 工具和 git/ls/find/grep 命令

## 测试

```bash
bun test                    # 全部测试
bun test tests/orchestrate.flow.test.ts  # 单一文件
```

测试基于 `FakeGitRunner` 伪造 Git，零外部依赖。`orchestrate.status_dispatch.test.ts` 覆盖 opx_status 分派判定（活跃 item、checkpoint giveup、blocked 视图、verify_quality 聚合等待期、回退/recovery 分派、多任务组切换、git 抛错容错）与 baseRef 省略"变更范围"的执行视图。

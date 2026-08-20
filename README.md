# openspec-agents

OpenSpec 流程的 Agent Team：面向实施阶段的多 Agent 工作流编排。

> 当前定位：把已确定的 OpenSpec change 落地为高质量代码。
> 未来方向：向前扩展「探索 + 方案制定」，覆盖 OpenSpec 更早期环节。

## 它解决什么问题

OpenSpec 把需求、设计、任务拆解成规范文档后，实施阶段仍然需要多步开发、验证、质量审查和收尾。本项目用一组 Agent 角色 + workflow 引擎，把这一过程编排成可重复、可审计的流水线：

`analyze → implement → verify_tool → verify_task → verify_quality → verify_cleanup → done`（full 模式；simple 模式见「编排流程」）

主代理负责调度，子代理负责实施、审查、质量验证和清理；所有裁决通过统一 `opx_*` 工具提交，状态持久化到仓库内。

## 编排流程

实施流程按变更开始时固化的模式执行：模式经 `opx_orch_init` 的 `mode` 参数在变更开始时固化（`full` 完整流程 / `simple` 精简流程，不传缺省 simple）。已开始的变更不受后续参数影响；恢复（recovery）沿用固化模式；旧变更（状态无模式存档）一律按 full 处理，不支持中途切换。

### full 模式

`analyze → implement → verify_tool → verify_task → verify_quality → verify_cleanup → done`

分析、实现、三层审查（工具检查 / 任务验证 / 五维质量审查）与收尾验证逐步推进，问题可回退、可豁免、可检查点决策。

### simple 模式

`implement → quality_review → done`

面向轻量变更的精简流程：无 analyze 环节（执行边界默认整个 worktree），无 verify_tool / verify_task / verify_cleanup 环节。implement 失败自循环重试；quality_review 由单一审查者合并承担工具检查、任务验证与质量审查（工具改进建议双报机制保留，由开发者实施），失败回 implement 整步重审；开发者提交 implement 成果时强检查工作区干净（不干净拒绝并提示先 commit），收尾为直接合并分支并清理（裸合并，无回归、无环境清理；合并冲突由开发者解决后直接收尾）。tasks.md 复选框在任务组收尾（opx_orch_complete_task_group）时统一勾选当前任务组，勾选提交落在 worktree 分支、随合并带回主分支；full 与 simple 行为一致，任务完成状态以状态文件为准。

## 身份与角色

物理 agent 定义收敛为两个子代理（`assets/agents/` 下的 `openspec-developer.md`、`openspec-reviewer.md`，主代理模板 `openspec-main.md` 保留），9 种逻辑身份（architect、reviewer-tool、reviewer-task、style / architecture / performance / security / maintainability 五维审查者、simple 审查者）不再有独立定义文件，统一经 `_agent` 参数承载：子代理调用 `opx_*` 工具时传自身角色名，系统按该逻辑身份路由状态视图、issue 来源与筛选、「谁提谁裁定」与状态标识。

- 开发者物理 agent 承载 developer 与 architect 两个逻辑身份；审查者物理 agent 承载 tool / task / 五维 / simple 审查者逻辑身份。full 模式的质量审查以 5 个逻辑身份并行执行——同一物理审查者被多次分派，每次以不同 `_agent` 参数承载对应逻辑身份。
- 物理权限取各逻辑身份权限并集（维度审查者因此具备编辑与写入能力）；审查行为以「只报不改」指令约束兜底——文档/注释等不影响代码运行的问题可直接修改，逻辑类问题只上报，full 模式同样适用。
- `_agent` 为纯自述、无硬校验：任何调用者可自报任意身份，裁定权与视图路由均信任自述值；冒认只能以自报身份行事，无法越出该身份自身的既有权限面。

## 特色

- **Agent 无关**：内核不绑定具体 Agent，opencode / claude code / codex / zcode / deepseek harness 通过各自原生插件/适配器接入同一套状态机。
- **Workflow 驱动**：步骤、角色、门禁在 workflow 中声明，`opx_status` 是下一步调度的唯一事实源。
- **多 Agent 团队**：主代理编排，2 个物理子代理承载 9 种逻辑身份分工协作，避免单一大模型从头写到尾失控。
- **强 Review 门禁**：full 模式 tool / task / quality 三层审查 + 收尾验证；simple 模式单一审查者合并审查。问题可回退、可豁免、可检查点决策。
- **隔离与安全**：每个 change 使用独立 git worktree、资源隔离命名空间，减少相互干扰。
- **可观测**：内置进度看板，状态/豁免/并发锁持久化到 `openspec/states/`。

## 优缺点

| | |
|---|---|
| 优点 | 产出代码质量高；有明确流程和门禁，结果不会太过偏离目标；过程可审计、可恢复 |
| 缺点 | 慢（多轮 Agent 调用 + 多级 review）；贵（token/API 消耗高于单 Agent 直接改） |

适合对质量、可控性要求高，且愿意用成本换稳定产出的实施场景。

## 接入方式

项目已为各 Agent 工具提供官方插件/适配器，普通使用时直接按对应工具的原生机制接入即可，无需手动拼装或启动 MCP Server。

依赖：Node.js ≥ 23.6（或 Bun）、git。

```bash
# 安装依赖
bun install

# 测试 / 类型检查
bun test
bun run typecheck
```

各 Agent 接入：

- **OpenCode**：以 npm 插件形式加载，插件注入 agent/skill 与 MCP server 配置（`config.mcp` 的 stdio server，自包含 bundle，`--worktree` 指向当前项目根）。
  ```bash
  npm install -D @ifrankwang/openspec-agents
  ```
  然后在 OpenCode 配置中加载 `@ifrankwang/openspec-agents` 插件并重启 OpenCode（MCP server 配置在启动时加载）：`opx_*` 工具以 `mcp__opx__*` 形态出现（如 `mcp__opx__status`、`mcp__opx__agent_submit`，serverName=opx），身份经 `_agent` 参数承载（缺省视为编排视角）。

- **Claude Code**：通过官方插件市场安装。
  ```bash
  claude plugin marketplace add https://github.com/ifrankwang/claude-code-plugins
  claude plugin install openspec-agents@ifrankwang
  ```

- **Codex**：通过官方插件市场安装。
  ```bash
  codex plugin marketplace add https://github.com/ifrankwang/codex-plugins
  codex plugin add openspec-agents@ifrankwang
  ```

- **ZCode**：在 ZCode 插件页添加市场 `ifrankwang/zcode-plugins`，然后安装 `openspec-agents`。

- **DeepSeek Harness（DSH）**：通过 DSH 的 bundle 插件机制接入。发布到 npm 后可直接安装：
  ```bash
  dsh plugin --profile web add @ifrankwang/openspec-agents
  ```
  本地开发时也可使用构建产物：
  ```bash
  bun run build:plugins
  dsh plugin --profile web add ./dist/deepseek-harness-plugin
  ```
  安装后重启 `dsh web`：
  - `opx_*` 会以 `mcp__opx__*`（如 `mcp__opx__status`、`mcp__opx__agent_submit`） 原生工具出现；
  - `assets/skills` 会作为额外 skill 根被扫描；
  - 每个子代理会注册为 DSH 原生 subagent 工具：`openspec_developer` 与 `openspec_reviewer` 两个物理子代理，编排主代理可直接分派（9 种逻辑身份经 `_agent` 参数承载，同一物理子代理可被多次分派）。

## 常用命令

| 命令 | 说明 |
|------|------|
| `bun test` | 运行所有测试 |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun run build:plugins` | 构建 Claude Code / Codex / ZCode / DeepSeek Harness 插件包（CI/内部使用） |
| `bun run sync` | 同步本地最新开发版本到各 harness 插件缓存，并安装/刷新依赖 |

## 项目结构

```
src/core/                  — Agent 无关内核（状态机、工具执行器、状态持久化）
src/adapters/              — opencode / claude-code / codex / zcode / deepseek-harness / mcp 适配层
assets/agents/             — Agent 定义
assets/skills/             — 内置 skill（含 orchestrator）
assets/workflows/          — workflow 定义
tests/                     — 测试
```

详细实现见 `AGENTS.md` 与 `src/core/`、`assets/workflows/`。

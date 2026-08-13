# openspec-orchestrate

agent 无关的 OpenSpec change 编排内核：workflow 引擎驱动的任务流转、阻塞升级、隔离开发与三层 Review 门禁。内核不绑定任何 agent 工具，opencode / claude code / codex / zcode 通过统一契约（MCP Server + 各 agent 原生接入形态：配置注入或官方插件包）接入同一套编排状态机。

## 架构

`analyze → implement → verify_tool → verify_task → verify_quality → done → 收尾`

编排由 workflow 引擎按 step 驱动，各 step 的裁决统一通过 `opx_agent_submit` 提交。

### 整体流程

每个 task WorkItem 由 workflow 引擎按 step 驱动执行：

`todo(analyze) → in_progress(implement) → review(verify_tool → verify_task → verify_quality) → done`

| Phase | step | 目标 |
|------|------|------|
| todo | analyze | 架构师校验需求、设计、任务与实施前提，输出执行边界 |
| in_progress | implement | developer 实施任务、验证改动，提交时声明完成/阻塞 |
| review | verify_tool → verify_task → verify_quality | 依次执行工具、任务与质量门禁 |
| done | （终态） | 全部审核通过，由 `opx_orch_complete_task_group` 收尾合并分支 |

编排者职责由各 agent 的主代理承载（无独立 orchestrator 子代理角色）：主代理只分派子代理，不编写代码、不审查、不测试。每次子代理返回后，主代理调用 `opx_status`；该工具是下一步调度的唯一事实源。

Review 阶段依次执行 tool、task、quality 三层门禁；verify_tool 依据上次工具检查以来的变更检测结果，无代码/配置变更时直接提交通过，有变更时运行全量工具检查，或经审查确认变更仅为注释/文档性且无逻辑影响后免全量提交；免全量时该轮不执行确定性质量扫描，由 dev 本地构建与后续任务/质量门禁兜底。质量门 skill 在 frontmatter 声明机器可读的必做清单（`must_do`，与正文必做检查表格一一对应）；verify_tool 提交 passed 时 `validation_steps` 须逐项覆盖该必做清单（completed=true 附结果，或 completed=false 以结构化 `skip_reason` 申报降级理由：JSON 含 item/category/adjudication，adjudication 取值 user_response/unattended_auto/env_unavailable），遗漏必做项或缺结构化降级理由的提交被门禁拒绝——未声明 `must_do` 的 skill 与解析不到质量门 skill 的 step 自动豁免；无变更直提/注释性变更免全量分支以 step 名首段为 `no_change` 的条目申报整体豁免必做清单。任一 step 裁决 failed 回退 implement 修复（analyze 失败回退 analyze 重查）。某 step 重试次数达到上限（默认 10 次）且仍存在未解决 children 时引擎进入检查点态，由编排者经 `opx_agent_submit` 的 `checkpoint_decision` 决策：`continue` 重置该 step 重试继续，`giveup` 放弃遗留 issue（置 cancelled）并将该 step 标记完成，随后自动沿状态机推进——末位 step 直接落 done 可收尾，非末位 step 落下一个待执行 step，同时把未解决 blockers 置为已解决，避免放弃后无法收尾；giveup 前对质量门 step 先核对必做清单覆盖度，未覆盖项须经 `checkpoint_skip_reasons` 逐项提供结构化降级理由，缺理由拒绝 giveup（杜绝放弃审查后无痕推进收尾的绕过通道）。需用户拍板的需求/设计问题由架构师在 analyze step 直接向用户确认（有人值守）或自行裁决（无人值守），确认/裁决后当场继续、不留档；确属阻塞的缺口由架构师上报 blocker，同环节继续复核至完成。quality reviewer 对可工具化的 pattern 在报业务 issue 的同时须报工具改进 issue，通过调整确定性质量扫描工具配置（规则收紧/新增规则）统一收敛同类问题，减少人工重复审查。

issue 与任务共享 phase 体系：reviewer 提报 → todo → developer 修复并经 `fixed_issue_ids` 上报 → review（待复核）→ 报 issue 的 reviewer 复核裁定（谁提谁裁定）：通过置 done，驳回回 todo 并累计修复未过次数（≥2 须先 5-Why 根因分析）。done/cancelled 终态由复核（verify_* 各层）、豁免裁定或检查点 giveup 置入；developer 提交修复只进入 review 待复核，不直接置终态。多 agent 聚合 step（verify_quality 5 维并行）中，维度名下有未裁定豁免申请时会在聚合等待期重新唤起报源 reviewer 履行裁定权；维度名下 blocking issue 已全部终态且无在途豁免申请时该维度自动视为通过，避免 failed 维度永不重派导致聚合无法收敛。

具体阶段流转、工具参数、状态与门禁规则以 `src/core/` 与 `assets/workflows/` 实现为准。README 不重复这些细节，避免文档与代码漂移。

## 包形态

npm 包以 agent 无关内核为主入口，各 agent 适配器为子导出：

| 子导出 | 内容 |
|--------|------|
| `.` / `./core` | 内核（状态机、工具执行器、schema、派生逻辑） |
| `./provider` | Provider 契约接口（IRuntimeProvider / ToolRegistry / JSONSchema） |
| `./opencode` | OpenCode 插件壳（兼容过渡入口） |
| `./server` | OpenCode npm 插件约定入口（opencode 经 `exports["./server"]` 解析，指向插件壳） |
| `./claude-code` | claude code 适配器（Claude Code 官方插件包生成） |
| `./codex` | codex 适配器（agent/MCP 配置注入） |
| `./zcode` | zcode 适配器（ZCode 官方插件包生成） |
| `./mcp` | 通用 MCP Server（HTTP/stdio transport 承载 6 个 opx_* 工具） |
| `./mcp/cli` | MCP server 可执行入口 |

`@opencode-ai/plugin` 为 optional peer：仅 OpenCode 插件壳形态需要，内核与 MCP 形态不依赖任何 agent 专有 API，可在纯 Node 环境运行（源码为显式 `.ts` 扩展名导入，Node ≥ 23.6 原生直接执行；Node 22.6–23.5 需 `--experimental-strip-types` 开启 type stripping）。

## Workflow 引擎

编排状态机由单一 task workflow 驱动：`assets/workflows/task.yaml` 声明任务流转（phase → steps → agents → transitions），并通过顶层 `common` 块与 step 级 `instructions`/`constraints` 承载跨 step 共享与 step 专属的操作指引与约束，由 `opx_status` 合并渲染。`opx_agent_submit` 提交裁决后沿 transitions 推进状态机；`src/core/workflow/` 为引擎实现（loader / engine / submit / status），collector 负责从外部源拉取并产出 WorkItem，poller 定时将新增项写入 state.workItems。

## 状态目录

编排状态（主状态、豁免清单、并发锁、worktree 指针）存储于主仓库根 `openspec/states/`，不绑定任何 agent 目录布局：

- `openspec/states/{changeId}.json` — 主状态
- `openspec/states/exemptions.json` — 项目级跨 change 豁免清单
- `openspec/states/{changeId}.review.lock/` — 并发锁
- `<worktree>/openspec/states/context.json` — worktree 会话指针

旧布局 `.opencode/.orchestrate_state/` 读取时双读兼容，首次新目录写入时自动幂等迁移（主状态/exemptions/锁/context 指针），迁移不删除旧文件。`openspec/states/` 已加入 gitignore。

## 快速开始

### MCP Server

所有 agent 形态共享同一个 MCP server（承载 6 个 opx_* 工具 + dashboard/collector/poller 副作用）。HTTP transport 端点固定为 `http://<host>:<port>/mcp`（server 仅路由 `/mcp` 路径，根路径 `/` 仅返回健康检查）：

```bash
# HTTP transport（OpenCode 等）
node <pkg>/src/adapters/mcp-common/cli.ts --worktree . --port 4525

# 经 ./mcp/cli 子导出入口等价启动（npm 安装后按包名解析到同一 cli.ts）
node -e "import('openspec-orchestrate/mcp/cli').then(({ main }) => main(process.argv.slice(1)))" -- --worktree . --port 4525

# stdio transport（codex 分发 / zcode 插件 MCP 声明用，默认无人值守）
node <pkg>/src/adapters/mcp-common/cli.ts --transport stdio --worktree . --unattended
```

非 OpenCode agent（claude code / codex / zcode）走编排时默认开启无人值守（`--unattended`）：会话初始化自动置 `state.unattended=true`，需拍板事项由主代理依据 orchestrator skill 自行裁决，不向用户提问。无人值守仅影响 analyze 确认模式视图渲染与 agent 行为准则，不抑制检查点决策——检查点决策是 `opx_agent_submit` 工具调用，主代理可自行执行。

### OpenCode 接入

**MCP 形态（推荐）**：两条路径在 opencode.json 中并列生效——`plugin` 块按 npm 包名加载插件壳（opencode 经包 `exports["./server"]` 解析到插件壳入口，负责 agent/skill 配置注入），`mcp` 块配置 MCP client 指向 MCP server（`http://127.0.0.1:4525/mcp`，负责 6 个 opx_* 工具）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["openspec-orchestrate"],
  "mcp": {
    "openspec-orchestrate": {
      "type": "remote",
      "url": "http://127.0.0.1:4525/mcp",
      "enabled": true
    }
  }
}
```

MCP server 需先按上文 MCP Server 章节启动。

**插件壳形态（兼容过渡）**：以插件方式加载（opencode 经包 `exports["./server"]` 解析到插件壳），工具直载 + agent/skill 注入；dashboard/collector/poller 副作用已迁移至 MCP server 进程，插件壳形态不再启动。

```bash
bun add openspec-orchestrate @opencode-ai/plugin
```

插件壳兼容过渡的退出条件：OpenCode 的 MCP client 形态（server + 配置注入）在真实编排流程中与插件壳形态状态机行为一致（同一套 core 执行器，`tests/dual-track.test.ts` 对同一 change 分别在插件壳与 MCP 形态跑相同工具序列并断言状态文件一致），且社区版本支持所需的 MCP 配置注入后，移除插件壳。

### claude code 接入

1. 生成插件包与市场清单：`bun run claude:plugin`（产物：`dist/claude-code-plugin/` 插件包 + 仓库根 `.claude-plugin/marketplace.json`；生成依赖本机 bun 环境）
2. CLI 安装（建议 `--scope project`：写入 `.claude/settings.json` 的 enabledPlugins，随 git 团队共享自动启用）：
   ```bash
   claude plugin marketplace add ./ --scope project
   claude plugin install openspec-orchestrate --scope project
   ```
   或会话内 `/plugin marketplace add ./` → `/plugin install openspec-orchestrate`；安装后如提示则执行 `/reload-plugins`
3. 禁用/卸载：`/plugin uninstall openspec-orchestrate`（或按作用域移除 `.claude/settings.json` 的 enabledPlugins），插件整体消失

claude code 接入走官方插件包形态（`.claude-plugin/plugin.json` 清单 + `agents/` + `skills/` + `assets/workflows/`（task.yaml workflow 定义，bundle 按部署深度逐级上溯探测读取）+ `.mcp.json` + 自包含 MCP server bundle），不再向目标仓库落盘 `.claude/agents`、`.claude/skills` 与 `.mcp.json`。插件子代理为只读形态（插件子代理不支持 `hooks`/`mcpServers`/`permissionMode` frontmatter——本项目子代理本就只读，无冲突）；MCP server key 由 Claude Code 自动命名空间（`plugin:<name>:<server>`）。MCP server 为 stdio + 默认无人值守，`--worktree` 指向当前打开项目根（官方模板变量 `${CLAUDE_PROJECT_DIR}`），插件安装后跨项目生效。`agents/*.md` 仅保留 `name`/`description` frontmatter，opencode 的 `mode`/`permission`/`steps` 等字段被丢弃。插件安装时复制到本地缓存（`~/.claude/plugins/cache`），MCP server 入口为插件内自包含 bundle，不依赖目标环境 node_modules。

分发边界：插件产物不入库（`dist/` 已在 `.gitignore`），clone 仓库后 `dist/claude-code-plugin/` 不存在，需先在目标环境运行 `bun run claude:plugin` 生成产物再做本地安装；`.claude-plugin/marketplace.json` 本身入库，其 source 为相对路径，本机生成产物后即可作为本地安装源。团队分发仅支持「目标环境先生成产物、再本地安装」；github source 分发留作未来评估。

已知限制：插件包生成测试含 `claude plugin validate` 门禁（本机无 claude CLI 时跳过）；`claude plugin install` / 会话内 `/plugin install` 为人工步骤、插件实际加载与 MCP 连接未经端到端实测——默认无人值守兜底。claude code 子代理不能向用户提问（AskUserQuestion 仅主代理可用）：需拍板问题返回主代理处理；默认无人值守规避提问依赖。子代理调用 opx_* 工具时通过 `_agent` 参数传自身角色名（如 `openspec-reviewer-tool`），缺省为编排主代理视角；主代理分派时按 orchestrator skill 分派范式在分派 prompt 中附 `_agent` 身份指令（未携带时子代理首次查询会拿到编排视角视图，视图给出补传提示）。

### codex 接入

1. 运行 `injectCodexAgents(repoRoot)` 注入子代理到 `.codex/agents/*.toml`
2. 运行 `injectCodexMcp(repoRoot, "<pkg>/src/adapters/mcp-common/cli.ts")` 写入 `.codex/config.toml`（serverEntry 为 MCP server 的 node 脚本入口路径；stdio + `--unattended`）

已知限制：codex 的 `request_user_input` 工具仅根线程（主代理）可用，且普通模式需开启对应 feature flag（`--experimental-auto-plan` 相关配置），codex exec 不可用；默认无人值守，需拍板事项由主代理自行裁决。

### zcode 接入

1. 生成插件包与市场清单：`bun run zcode:plugin`（产物：`dist/zcode-plugin/` 插件包 + 仓库根 `marketplace.json`；生成依赖本机 bun 环境）
2. ZCode GUI 本地安装：设置 → 插件 → Create → Add marketplace → 选择仓库根目录（marketplace.json 所在目录，source 相对路径解析到本机生成的 `dist/zcode-plugin/`）→ Personal 区找到 openspec-orchestrate → Install。安装即生效（agent/skill/MCP 组件注册进当前工作区）；Disable/Uninstall 即全部组件消失

zcode 接入走官方插件包形态（`.zcode-plugin/plugin.json` 清单 + `agents/` + `skills/` + `assets/workflows/`（task.yaml workflow 定义，bundle 按部署深度逐级上溯探测读取）+ `.mcp.json` + 自包含 MCP server bundle），安装/启用/禁用/卸载均为 GUI 动作，不再落盘 `~/.zcode` 与项目根 `.zcode/config.json`。插件子代理为只读形态；MCP server key 由 ZCode 自动命名空间（`plugin:openspec-orchestrate:openspec-orchestrate`）。MCP server 为 stdio + 默认无人值守，`--worktree` 指向当前打开项目根（官方模板变量 `${CLAUDE_PROJECT_DIR}`），插件用户级安装后跨项目生效。`agents/*.md` 仅保留 `name`/`description` frontmatter，opencode 的 `mode`/`permission`/`steps` 等字段被丢弃，zcode 以自己的工具体系定义行为。

分发边界：插件产物不入库（`dist/` 已在 `.gitignore`），clone 仓库后 `dist/zcode-plugin/` 不存在，需先在目标环境运行 `bun run zcode:plugin` 生成产物再做本地目录安装；`marketplace.json` 本身入库，其 source 为相对路径，本机生成产物后即可作为本地安装源。团队分发仅支持「目标环境先生成产物、再本地安装」；输出目录纳入版本管理或 github source 分发留作未来评估。

已知限制：zcode 自定义子代理为 Beta；适配器按官方插件格式实现，测试仅验证生成结构与官方 schema 一致，GUI 安装动作为人工步骤、zcode 子代理实际可用性与提问能力未经端到端实测——默认无人值守兜底。

## 编排者角色

编排者职责由各 agent 的主代理承担（不再注册独立的 openspec-orchestrator agent）：

- 内核以「编排视角」角色判定（`orchestrator` 字段）做独占工具校验与状态视图路由，不依赖 agent 名
- 主代理身份与权限（mode=primary、read/edit/write 权限边界）在各适配器主代理注入定义中（opencode：`assets/agents/openspec-main.md`）
- 编排者身份定位、行为准则、禁止事项、分派范式与无人值守行为约定由 `orchestrator` skill 承载（`assets/skills/orchestrator/`，按 capability tag 匹配加载），不含具体阶段流转与工具内部实现

## 编排看板

MCP server 启动时自动在 `http://127.0.0.1:4519` 启动编排进度看板（端口占用自动递增）。按 WorkItem phase 展示 5 列看板（todo/in_progress/review/done/cancelled），卡片含各 step:agent 裁决与 children 明细。只读、2s 轮询刷新。

## 命令

| 命令 | 用途 |
|------|------|
| `bun test` | 运行所有测试 |
| `bun run typecheck` | TypeScript 类型检查 |
| `npm run sync` | 同步源码到本机全部安装缓存（多目标） |

## 项目结构

```
src/core/                     — agent 无关内核（状态机、工具执行器、状态持久化、Provider 契约）
src/core/tools/               — 编排工具实现（生命周期、通用 step 提交、纯 JSON Schema 参数定义）
src/core/workflow/            — workflow 引擎（状态机、collector、poller、状态视图）
src/adapters/opencode/        — OpenCode 适配层（插件壳、JSON Schema→链式 schema 转换、agent/skill 注入）
src/adapters/mcp-common/      — 通用 MCP Server（HTTP/stdio transport 承载 6 个工具 + 副作用）
src/adapters/claude-code/     — claude code 适配器（Claude Code 官方插件包生成）
src/adapters/codex/           — codex 适配器（agent/MCP 配置注入）
src/adapters/zcode/           — zcode 适配器（ZCode 官方插件包生成）
src/adapters/plugin-common/   — 插件包共享生成器（zcode / claude code 复用）
src/skills/                   — skill 扫描与解析
src/dashboard/                — 看板页面服务
assets/agents/                — agent 定义（子代理 + 主代理注入模板）
assets/skills/                — 内置 skill 定义（含 orchestrator）
assets/workflows/             — workflow 定义（task.yaml）
assets/dashboard/             — 看板页面（index.html，随 files 分发）
tests/                        — Bun 测试，使用 FakeGitRunner
```

## 核心特性

- **Workflow 引擎**：`assets/workflows/task.yaml` 声明 step 流转与 agent 归属，引擎驱动状态机；collector 从外部源（OpenSpec change / ADO）拉取并产出 WorkItem，poller 定时写入 state.workItems
- **多 agent 接入**：一套内核契约（Provider 接口 + 纯 JSON Schema），MCP Server 统一承载工具，各 agent 以原生机制注入 agent/skill 定义
- **编排进度看板**：MCP server 进程承载 HTTP 看板服务，按 WorkItem phase 实时展示 5 列看板及 step:agent 裁决、children 明细（2s 轮询、只读）
- **状态持久化**：状态文件按 changeId 拆分并写入主仓库根 `openspec/states/`；旧 `.opencode` 布局双读兼容 + 首次写入幂等迁移；worktree 内 session 通过 `context.json` 指针辅助解析
- **阻塞升级**：不可自主决策的问题持久化、暂停、用户恢复、架构复核
- **Worktree 隔离**：`git worktree` 分支隔离，自动合并清理。`opx_agent_submit` 检测到主仓库本 change 目录下的 openspec 文档污染时自动并入 worktree 分支并清理主仓库工作树
- **执行边界**：架构师限定 developer 的目录和包范围，reviewer 新报 issue 自动扩展
- **豁免机制**：developer 通过 `exempt_issue_ids` 申请豁免，issue 进入 review（待裁定）态 → 报 issue 的 review step 通过 `exempt_adjudications` 裁定（dismissed→cancelled、rejected→回修）。裁定为 dismissed 且 issue 携带工具规则（rule）时，豁免结论写入主仓库根 `openspec/states/exemptions.json` 项目级跨 change 豁免清单（原子写 + 专用目录锁，并发安全）；后续新 change 的 tool review 全量扫描提报同 (rule+file+line) 的存量问题时自动降为 Info 级，不阻塞、无需重复豁免，视图以「存量豁免提示」标注
- **校验守卫**：多维度校验确保流程完整性
- **状态异常防护**：`opx_status` 检测到 phase ↔ step 归属错位（含 currentStep 指向未声明 step）时，子代理一律收到 ⛔ 状态异常拒绝视图（禁止执行任何 opx_* 变更操作），编排者收到 ⚠️ 诊断并指引 `opx_orch_init(recovery=...)` 恢复；`opx_agent_submit` 对错位态提交同样抛错拒绝，零状态变更
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

- 工具前缀 `opx_`，6 个工具：`opx_orch_init` / `opx_orch_set_worktree` / `opx_status` / `opx_orch_complete_task_group` / `opx_orch_set_unattended` / `opx_agent_submit`
- Agent 命名模式 `openspec-{role}`
- 编排者 = 各 agent 主代理（编排视角角色判定，无独立 orchestrator 子代理）
- 主代理仅允许 opx_* 工具和 git/ls/find/grep 命令（edit/write 强制禁止），可加载 skill
- 工具参数 schema 以 `src/core/tools/schemas.ts` 纯 JSON Schema 为单一事实源

## 测试

```bash
bun test                    # 全部测试
bun test tests/orchestrate.flow.test.ts  # 单一文件
```

测试基于 `FakeGitRunner` 伪造 Git，零外部依赖。`orchestrate.status_dispatch.test.ts` 覆盖 opx_status 分派判定（活跃 item、checkpoint giveup、blocked 视图、verify_quality 聚合等待期、回退/recovery 分派、多任务组切换、git 抛错容错）与 baseRef 省略"变更范围"的执行视图；`mcp-common.test.ts` 覆盖 MCP server 形态下同一状态机的工具承载、角色路由与默认无人值守；`dual-track.test.ts` 覆盖插件壳 vs MCP 双轨对比（同一 change 两端跑相同工具序列，归一化动态字段后断言状态文件一致）。

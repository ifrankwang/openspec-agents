## 1. P1 内核契约（零破坏，其他组依赖）

- [x] 1.1 新建 src/core/tools/schemas.ts：6 个工具（opx_orch_init/opx_orch_set_worktree/opx_status/opx_orch_complete_task_group/opx_orch_set_unattended/opx_agent_submit）的纯 JSON Schema 定义（与现有 OpenCode 链式 schema 语义逐一对齐，含嵌套 object/array 校验） [spec:agent-runtime]
- [x] 1.2 新建 src/core/provider.ts：IRuntimeProvider / ToolRegistry / IRuntimeConfig / JSONSchema 接口定义（工具注册、参数 schema、context 注入、agent/skill 注入、提问回调、dashboard 可选） [spec:agent-runtime]
- [x] 1.3 src/core/index.ts 导出新增 schema 与 provider 接口；package.json 新增 ./provider 子导出 [spec:agent-runtime]
- [x] 1.4 验收：bun test 全绿、bun run typecheck 通过、新接口可被外部 import（不破坏现有 OpenCode 插件行为）

## 2. P2 状态目录中性化

- [x] 2.1 constants.ts/state.ts/paths.ts：STATE_DIR_NAME 改为可配置，默认 openspec/states/（旧 .opencode 保留读兼容） [spec:state-layout]
- [x] 2.2 新增迁移函数：读旧 .opencode/.orchestrate_state/ 数据、首次新目录写入时幂等迁移（主状态/exemptions/锁/worktree context.json 指针） [spec:state-layout]
- [x] 2.3 gitignore 增加 openspec/states/；核查 openspec/ 目录与 openspec 规范数据（openspec/changes 等）共存无冲突 [spec:state-layout]
- [x] 2.4 验收：旧状态文件可读、新状态写入新目录、迁移幂等、bun test 全绿
- [x] 2.5 新建/扩展 tests/state.migration.test.ts，覆盖状态目录迁移幂等、旧 .opencode 双读兼容、worktree context.json 指针迁移 [spec:state-layout]

## 3. P3 编排主代理化（orchestrator-skill）

- [x] 3.1 ToolContext 增加「编排视角」角色字段（tools/types.ts）；适配层透传带上角色判定 [spec:orchestrator-skill]
- [x] 3.2 derive.ts assertOrchestrator 判定、lifecycle.ts 4 处独占工具校验（opx_orch_init / opx_orch_set_worktree / opx_orch_complete_task_group / opx_orch_set_unattended）、lifecycle.ts 与 status.ts 视图路由判断共 6 处 agent 名字符串比较，统一改为角色判定 [spec:orchestrator-skill]
- [x] 3.3 新建 assets/skills/orchestrator/SKILL.md：编排主代理 skill（身份定位、行为准则、禁止事项、分派范式、无人值守行为约定；frontmatter 声明 capabilities，不含具体阶段流转与工具内部实现） [spec:orchestrator-skill]
- [x] 3.4 assets/agents/openspec-orchestrator.md 处置：删除独立角色，frontmatter（mode/permission）迁移至各适配器主代理注入定义 [spec:orchestrator-skill]
- [x] 3.5 tests 迁移：helpers.ts 去 OpenCode 类型依赖（ToolContext 改从 src/core/tools/types 导入）、16 个测试文件（另含 1 个 helper）openspec-orchestrator 上下文迁移到编排视角角色机制 [spec:orchestrator-skill]
- [x] 3.6 验收：bun test 全绿、OpenCode 实际跑一轮编排流程行为不变（状态 JSON 格式兼容）

## 4. P4 通用 MCP 承载 + claude code 适配器

- [x] 4.1 新建 src/adapters/mcp-common/：MCP Server（HTTP transport）承载 6 个 opx_* 工具，参数取 P1 纯 JSON Schema [spec:mcp-bridge]
- [x] 4.2 新建 src/adapters/claude-code/：官方插件包生成（.claude-plugin/plugin.json 清单 + agents/skills/.mcp.json + 自包含 MCP server bundle + 仓库根 .claude-plugin/marketplace.json），替代手动文件分发（不再落盘 .claude/agents、.claude/skills 与项目根 .mcp.json），与 zcode 复用 plugin-common 共享生成器（CLI：bun run claude:plugin），默认无人值守 [spec:unattended-default]
- [x] 4.3 OpenCode 适配器重构：schemas/tools 消费 P1 纯 JSON Schema（OpenCode 链式 API 仅作转换目标）、插件壳保留兼容入口、dashboard/collector 副作用迁移到 MCP server 进程 [spec:agent-runtime]
- [x] 4.4 校正 tools.ts 中 unattended 工具描述与实际实现一致（检查点仍由 opx_agent_submit 决策，不因 unattended 抑制） [spec:unattended-default]
- [x] 4.5 验收：claude code 可发现并调用 6 个工具、跑通一轮编排流程；bun test 全绿
- [x] 4.6 OpenCode 插件壳与 MCP 形态双轨并行验证（同一 change 在两种形态下状态机行为一致），并明确插件壳兼容过渡的退出条件 [spec:agent-runtime]

## 5. P5 多适配器 + 发布形态

- [x] 5.1 新建 src/adapters/codex/：agent 定义注入（.codex/agents/*.toml）、MCP 配置分发（config.toml，TOML 格式）、默认无人值守、文档注明 request_user_input feature flag [spec:agent-runtime]
- [x] 5.2 新建 src/adapters/zcode/：ZCode 官方插件包生成（.zcode-plugin/plugin.json 清单 + agents/skills/.mcp.json + 自包含 MCP server bundle + 仓库根 marketplace.json），替代手动文件分发（不再落盘 ~/.zcode/agents 与 .zcode/config.json），默认无人值守 [spec:agent-runtime]
- [ ] 5.2.1 实测确认 zcode 子代理提问能力（design.md Open Questions 标注接入时实测；未实测前维持默认无人值守兜底） [spec:agent-runtime]
- [x] 5.3 package.json 导出结构改造（main 指内核、./opencode ./claude-code ./codex ./zcode ./mcp ./provider 子导出）；@opencode-ai/plugin 降为 optional peer [spec:agent-runtime]
- [x] 5.4 去 Bun：Bun.serve → node:http、Bun.Glob → node:fs、import.meta.dir 全部替换为 Node 兼容写法（import.meta.dirname 或 fileURLToPath；涉及 src/core/workflow/loader.ts 与 src/adapters/opencode/agents.ts）、运行时抽象 [spec:agent-runtime]
- [x] 5.5 scripts/sync-to-cache.sh 多目标同步；README.md 重写（包形态、配置入口、各 agent 接入指南） [spec:agent-runtime]
- [x] 5.6 验收：bun test 全绿、typecheck 通过、测试中无 @opencode-ai/plugin 导入、node 环境可运行

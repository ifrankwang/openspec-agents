## Why

当前 openspec-orchestrate 以 OpenCode 插件形态运行：6 个 opx_* 工具用 OpenCode 专属链式 API（tool.schema）定义，agent/skill 注入绑定 OpenCode 配置模型（config.agent / config.skills.paths），编排者角色 openspec-orchestrator 依赖 OpenCode 的 primary/subagent 模型与 task 分派工具。这导致工具无法接入 claude code、codex、zcode 等其他 agent。目标是把编排能力改造成 agent 无关的插件/工具，各 agent 通过统一契约接入同一套编排状态机与流程。

## What Changes

- **BREAKING** 状态存储目录从 `.opencode/.orchestrate_state/` 迁移为 `openspec/states/`（主状态、豁免清单、并发锁、worktree 指针随迁），提供旧目录自动迁移与双读兼容。
- **BREAKING** 取消独立编排者角色 openspec-orchestrator：编排者语义并入各 agent 工具的主代理（各 agent 默认都有主代理），内核以「编排视角」角色判定替代 agent 名字符串比较；原 orchestrator 的角色定位与行为准则迁移为新的编排主代理 skill。
- 新增 agent 无关的 Provider 抽象接口（工具注册、参数 schema、context 注入、agent/skill 注入、用户交互回调），工具参数 schema 由 OpenCode 链式 API 改为纯 JSON Schema。
- 新增通用 MCP Server 承载层承载 6 个 opx_* 工具（HTTP transport）；OpenCode 适配器从插件直载改为 MCP client + 配置注入（保留插件壳兼容过渡）。
- 新增 claude code、codex、zcode 三个适配器（agent 定义注入、MCP 注册配置分发、主代理 skill 注入）。
- 非 OpenCode agent（claude code、codex、zcode）走编排时默认开启无人值守模式（unattended），agent 自行决策，不向用户提问。
- 新增编排主代理 skill（orchestrator skill），承载编排者身份定位、行为准则、分派范式与无人值守行为约定，供各 agent 主代理加载。
- npm 包导出结构调整：主入口改为 agent 无关内核，OpenCode 插件移至 ./opencode 子导出，新增 ./claude-code、./codex、./zcode、./mcp、./provider 子导出；@opencode-ai/plugin 降为 optional peer 依赖。
- 去除生产代码中 Bun 专属 API（Bun.serve / Bun.Glob），兼容 Node 运行时。

## Capabilities

### New Capabilities
- `agent-runtime`: 内核 Provider 抽象接口（工具注册、JSON Schema、context 注入、agent/skill 注入、提问回调），npm 包多子导出结构，Bun 专属 API 去除后的运行时兼容。
- `state-layout`: 状态存储目录中性化（openspec/states/），旧 .opencode 目录自动迁移与双读兼容，worktree context.json 指针随新目录布局。
- `orchestrator-skill`: 编排主代理 skill 定义与注入（身份定位、行为准则、分派范式、无人值守行为约定）；内核「编排视角」角色判定替代 agent 名硬编码。
- `mcp-bridge`: 通用 MCP Server 承载 6 个 opx_* 工具（纯 JSON Schema 参数、HTTP transport）。
- `unattended-default`: 非 OpenCode agent 默认无人值守（适配层初始化时自动开启 unattended，编排主代理 skill 明确自行决策行为准则）。

### Modified Capabilities
无（当前无主线 spec，均为新能力）。

## Impact

- 核心代码：src/core/{constants,derive,tools/lifecycle,tools/submit,tools/types,workflow/status,state,paths}.ts 的编排视角判定、状态目录常量、Provider 接口新增。
- 适配层：src/adapters/opencode/{tools,schemas,agents,skills,dashboard,index}.ts 重构；新增 adapters/{mcp-common,claude-code,codex,zcode}/。
- 配置：assets/workflows/task.yaml（orchestrator 相关引用核查，预计无需改动）、assets/agents/*.md（orchestrator.md 转 skill）、assets/skills/ 新增 orchestrator skill。
- 测试：tests/helpers.ts 去 OpenCode 类型依赖；16 个测试文件（另含 1 个 helper）的 openspec-orchestrator 上下文迁移到「编排视角」角色机制。
- 依赖：@opencode-ai/plugin 由必需 peer 降为 optional；scripts/sync-to-cache.sh 发布目标改造。
- 文档：README.md 重写（包形态、配置入口、各 agent 接入指南）。

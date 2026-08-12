## Context

现状：内核 src/core/ 已完全 agent 无关（不 import 任何 @opencode-ai/*），OpenCode 绑定集中在 src/adapters/opencode/ 一层。硬编码点：(1) 6 个工具用 OpenCode 链式 schema API；(2) agent/skill 注入绑定 OpenCode 配置模型；(3) 状态目录名 .opencode 写死在 core；(4) 编排者身份 = 硬编码 agent 名字符串 openspec-orchestrator，共 13 处（含 src/core/index.ts 的导出，constants 1 + derive 3 + lifecycle 3 + status 5 + index 1）；(5) 生产代码用 Bun 专属 API；(6) 包入口只导出 OpenCode 插件。

外部事实（已调研确认）：claude code、codex、zcode、opencode 均支持 MCP client（stdio/HTTP）；claude code 子代理不能向用户提问（AskUserQuestion 仅主代理可用），codex 的 request_user_input 工具同样仅根线程（主代理）可用；pi 不支持子代理与内置 MCP（本轮已决定暂不接入 pi）；各 agent 自定义 agent 的注入格式互不通用（claude code .claude/agents/*.md、codex .codex/agents/*.toml）；zcode 官方插件机制（zcode.z.ai/en/docs/plugin）为一等公民——插件目录 + .zcode-plugin/plugin.json 清单可打包 subagents/skills/MCP servers/commands/hooks，经 marketplace.json 分发（source 支持 directory/github/git/url/npm），用户 GUI 安装即生效、禁用/卸载即全部组件消失，插件子代理为 read-only，MCP server key 自动命名空间 plugin:<name>:<server>，声明中可用模板变量 ${CLAUDE_PLUGIN_ROOT}/${CLAUDE_PROJECT_DIR}/${user_config.key}。

## Goals / Non-Goals

**Goals:**
- 一套内核契约，多 agent 适配器接入（opencode / claude code / codex / zcode）
- 工具层统一 MCP 承载；agent/skill 注入走各 agent 原生机制
- 编排者语义由各 agent 主代理承担（不保留独立 orchestrator 子代理角色）
- 状态目录中性化（openspec/states/）并兼容旧数据
- 非 OpenCode agent 默认无人值守，agent 自行决策

**Non-Goals:**
- 不改变 openspec-* agent 命名（名称与 openspec 绑定，与具体 agent 工具无关）
- 不引入 workflow yaml 按 agent 特化机制（以默认无人值守替代）
- 不接入 pi（本轮范围外）
- 不重写内核状态机语义（阶段流转、issue 状态机、blocking 口径、谁提谁裁定均保持）

## Decisions

- **D1 工具层统一 MCP**：6 个 opx_* 工具由通用 MCP Server（HTTP transport）承载，参数改为纯 JSON Schema；OpenCode 也走 MCP client（其原生支持），插件壳退化为配置注入并保留兼容入口。理由：opencode/claude code/codex/zcode 全部支持 MCP client，单一实现通吃。
- **D2 编排者 = 各 agent 主代理**：取消独立 openspec-orchestrator 角色。理由：(a) 各 agent 默认都有主代理且具备分派子代理能力；(b) claude code 与 codex 均限制只有主代理能向用户提问，独立子代理角色无法提问是硬阻塞。内核改动：ToolContext 增加「编排视角」角色字段，assertOrchestrator 与视图路由从 agent 名字符串比较改为角色判定；orchestrator.md 的内容迁移为 skill（身份定位、行为准则、分派范式、无人值守约定），frontmatter（mode/permission）留在各适配器的主代理注入定义，动态流转决策仍由 opx_status 权威产出。
- **D3 非 OpenCode agent 默认无人值守**：claude code / codex / zcode 适配器初始化会话时自动开启 unattended（state.unattended = true），编排主代理 skill 明确「无人值守时所有需拍板事项自行裁决、不向用户提问」；不引入 workflow 配置特化机制。注意事实约束：现有 unattended 语义仅影响 analyze 确认模式视图渲染与 agent 行为准则（不抑制检查点决策——检查点决策本身是 opx_agent_submit 工具调用，主代理可自行执行，不依赖提问）；同步校正 tools.ts 中 unattended 工具描述与实现一致。
- **D4 agent 名不变**：openspec-* 名称仅与 openspec 语义绑定，不随接入的 agent 工具变化；状态 JSON 中 metadata.source、tag 键、谁提谁裁定路由全部保持。
- **D5 状态目录 openspec/states/**：主仓库根下 openspec/states/ 存放 {changeId}.json、exemptions.json、{changeId}.review.lock/；worktree 指针为 <worktree>/openspec/states/context.json；读取时旧 .opencode/.orchestrate_state/ 双读兼容，首次新目录写入时自动迁移；gitignore 增加 openspec/states/。
- **D6 去 Bun 化**：Bun.serve → node:http、Bun.Glob → node:fs 扫描、import.meta.dir 替换为 Node 兼容写法（import.meta.dirname 或 path.dirname(fileURLToPath(import.meta.url))）；开发/测试运行时保留 bun。
- **D7 zcode 接入走官方插件包形态**：zcode 不沿用 claude code / codex 的手动文件分发（写 ~/.zcode 与项目根 .zcode/config.json），src/adapters/zcode/ 改为插件包生成器——产物 dist/zcode-plugin/ 含 .zcode-plugin/plugin.json 清单、agents/*.md（从 assets/agents 转换、排除主代理模板、frontmatter 仅保留 name/description）、skills/<名>/（含 orchestrator skill 与 reference/ 附属文件）、.mcp.json（stdio + --unattended，--worktree 取模板变量 ${CLAUDE_PROJECT_DIR} 指向当前打开项目根，server 入口为随插件分发的自包含 bundle），配套仓库根 marketplace.json（source 相对路径，作为本地安装源随仓库入库）；安装/启用/禁用/卸载均为 GUI 动作。分发边界：插件产物不入库（dist/ 已 gitignore），clone 后需先在目标环境运行 bun run zcode:plugin 生成产物再本地目录安装，团队分发（输出目录纳入版本管理或 github source）为未来评估项。理由：插件机制是 ZCode 官方一等公民，用户 GUI 安装即生效、整体装卸，server key 自动命名空间避免跨插件冲突，无需维护 ~/.zcode 落盘路径；GUI 安装动作为人工步骤、子代理提问能力仍待实测，默认无人值守兜底不变。
- **D8 claude code 接入走官方插件包形态**：claude code 不沿用手动文件分发（写 .claude/agents、.claude/skills 与项目根 .mcp.json），src/adapters/claude-code/ 改为插件包生成器，与 zcode 复用共享生成器（src/adapters/plugin-common/，差异仅清单目录名与 marketplace 文件位置）——产物 dist/claude-code-plugin/ 含 .claude-plugin/plugin.json 清单、agents/*.md（排除主代理模板、frontmatter 仅 name/description）、skills/<名>/、.mcp.json（stdio + 自包含 bundle 入口 ${CLAUDE_PLUGIN_ROOT}/.mcp-server/cli.mjs + --worktree ${CLAUDE_PROJECT_DIR} + --unattended）、.mcp-server/cli.mjs bundle，配套仓库根 .claude-plugin/marketplace.json（source 相对路径，本地安装源随仓库入库）。安装为 CLI/会话内动作：claude plugin marketplace add + claude plugin install（--scope project 写 .claude/settings.json 的 enabledPlugins，团队 git 共享自动启用），/plugin uninstall 即整体消失。理由：与 D7 相同——官方插件机制为一等公民，整体装卸、无落盘路径维护；Claude Code 插件格式与 ZCode 同构（插件目录 + 清单目录内 plugin.json，组件目录在插件根同级），MCP 模板变量一致，共享生成器即满足，避免两份重复实现。分发边界与 D7 一致（产物不入库、clone 后需本地生成安装、github source 为未来评估项）。已知限制：插件子代理为 read-only 且不支持 hooks/mcpServers/permissionMode frontmatter（本项目子代理本就只读，无冲突）；安装动作为人工步骤、插件实际加载与 MCP 连接未经端到端实测，默认无人值守兜底不变。

## Risks / Trade-offs

- 编排视角角色判定改造牵连 16 个测试文件（另含 1 个 helper）（makeCtx("openspec-orchestrator") 迁移），期间须保持状态机行为不变，靠现有集成测试兜底（orchestrate.flow / guards / status_dispatch 等）。
- claude code 子代理嵌套默认禁用、子代理内 AskUserQuestion 不可用：编排主代理由主代理承担后可提问，子代理问题返回主代理；接入时按实际版本验证。
- codex 的 request_user_input 默认仅 Plan Mode 可用（普通模式需 feature flag），codex exec 不可用：接入文档需注明开启方式。
- zcode 子代理能否提问未获官方确认（自定义子代理 Beta）：接入 zcode 时实测决定是否适用无人值守默认策略。
- 状态迁移需幂等且不破坏存量编排会话（OpenCode 用户迁移路径与旧数据兼容）。

## Migration Plan

1. 阶段 P1（内核契约，零破坏）：提取 src/core/tools/schemas.ts（纯 JSON Schema）+ src/core/provider.ts（Provider 接口），新增 ./provider 子导出。
2. 阶段 P2（状态目录）：openspec/states/ 配置化 + 双读兼容 + 幂等迁移 + gitignore。
3. 阶段 P3（编排主代理化）：ToolContext 角色字段、assertOrchestrator/视图路由角色判定、orchestrator-skill 创建与注入、agent 定义调整、16 个测试文件（另含 1 个 helper）迁移。
4. 阶段 P4（MCP + claude code 适配器）：mcp-common 通用 MCP Server、claude code 适配器（agent 注入 + MCP 配置分发 + 默认无人值守 + skill 注入），验证全流程。
5. 阶段 P5（多适配器 + 发布）：codex / zcode 适配器、npm 导出结构、scripts/sync-to-cache.sh 改造、README 重写。

## Open Questions

- zcode 子代理的提问能力与无人值守默认策略的适用性（接入时实测）。
- codex cloud 环境的自定义 agent 与 request_user_input 可用性（本地 CLI 已确认，cloud 未获官方明确资料）。
- OpenCode 插件壳与 MCP 形态过渡期是否双轨并行（兼容窗口时长）。

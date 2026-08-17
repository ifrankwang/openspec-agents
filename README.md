# openspec-agents

OpenSpec 流程的 Agent Team：面向实施阶段的多 Agent 工作流编排。

> 当前定位：把已确定的 OpenSpec change 落地为高质量代码。
> 未来方向：向前扩展「探索 + 方案制定」，覆盖 OpenSpec 更早期环节。

## 它解决什么问题

OpenSpec 把需求、设计、任务拆解成规范文档后，实施阶段仍然需要多步开发、验证、质量审查和收尾。本项目用一组 Agent 角色 + workflow 引擎，把这一过程编排成可重复、可审计的流水线：

`analyze → implement → verify_tool → verify_task → verify_quality → verify_cleanup → done`

主代理负责调度，子代理负责实施、审查、质量验证和清理；所有裁决通过统一 `opx_*` 工具提交，状态持久化到仓库内。

## 特色

- **Agent 无关**：内核不绑定具体 Agent，opencode / claude code / codex / zcode 通过各自原生插件/适配器接入同一套状态机。
- **Workflow 驱动**：步骤、角色、门禁在 workflow 中声明，`opx_status` 是下一步调度的唯一事实源。
- **多 Agent 团队**：主代理编排，子代理按角色分工，避免单一大模型从头写到尾失控。
- **强 Review 门禁**：tool / task / quality 三层审查 + 收尾验证，问题可回退、可豁免、可检查点决策。
- **隔离与安全**：每个 change 使用独立 git worktree、资源隔离命名空间，减少相互干扰。
- **可观测**：内置进度看板，状态/豁免/并发锁持久化到 `openspec/states/`。

## 优缺点

| | |
|---|---|
| 优点 | 产出代码质量高；有明确流程和门禁，结果不会太过偏离目标；过程可审计、可恢复 |
| 缺点 | 慢（多轮 Agent 调用 + 多级 review）；贵（token/API 消耗高于单 Agent 直接改） |

适合对质量、可控性要求高，且愿意用成本换稳定产出的实施场景。

## 使用方式

项目已为各 Agent 工具提供原生插件/适配器，普通使用时直接按对应工具的原生机制接入即可，无需手动拼装或启动 MCP Server。

依赖：Node.js ≥ 23.6（或 Bun）、git。

```bash
# 安装依赖
bun install

# 测试 / 类型检查
bun test
bun run typecheck
```

各 Agent 接入：

- **OpenCode**：以 npm 插件形式加载，自动注入 agent/skill 与 `opx_*` 工具。
- **Claude Code**：`bun run claude:plugin` 生成官方插件包，再通过 `claude plugin marketplace add ./` + `claude plugin install openspec-agents` 安装。
- **ZCode**：`bun run zcode:plugin` 生成官方插件包，再在 GUI 中添加 marketplace 并安装。
- **Codex**：调用 `injectCodexAgents(repoRoot)` 与 `injectCodexMcp(repoRoot, "<serverEntry>")` 注入原生 agent/MCP 配置。

## 常用命令

| 命令 | 说明 |
|------|------|
| `bun test` | 运行测试 |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun run claude:plugin` | 生成 Claude Code 插件包 |
| `bun run zcode:plugin` | 生成 ZCode 插件包 |
| `npm run sync` | 同步源码到本机安装缓存 |

## 项目结构

```
src/core/                  — Agent 无关内核（状态机、工具执行器、状态持久化）
src/adapters/              — opencode / claude-code / codex / zcode / mcp 适配层
assets/agents/             — Agent 定义
assets/skills/             — 内置 skill（含 orchestrator）
assets/workflows/          — workflow 定义
tests/                     — 测试
```

详细实现见 `AGENTS.md` 与 `src/core/`、`assets/workflows/`。

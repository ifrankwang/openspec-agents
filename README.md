# openspec-orchestrate

OpenCode 编排插件。提供 OpenSpec 任务组编排、阻塞升级、隔离开发与三层 Review 门禁。

## 架构

`Architect → Developer → Tool Review → Task Review → Quality Review → 收尾`

编排者（orchestrator）只负责分派子代理，不自已写代码、审查或测试。

### 整体流程

每个 task group 按序执行：

`task_analysis → dev_impl → review → completed`

| 阶段 | 目标 |
|------|------|
| task_analysis | 校验需求、设计、任务与实施前提 |
| dev_impl | 实施任务、验证改动 |
| review | 执行工具、任务与质量门禁 |
| completed | 合并任务组分支并清理资源 |

编排者只分派子代理，不编写代码、不审查、不测试。每次子代理返回后，编排者调用 `opx_status`；该工具是下一步调度的唯一事实源。

Review 依次执行 tool、task、quality 三层门禁；失败回开发修复。不可自主决策的需求、依赖或验收阻塞由架构师在 task_analysis 内就地处理，同环节继续复核至完成。

具体阶段流转、工具参数、状态与门禁规则以 `src/core/` 实现为准。README 不重复这些细节，避免文档与代码漂移。

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
4. 完成 task_analysis、dev_impl、review 与收尾

### 编排看板

插件加载时自动在 `http://127.0.0.1:4519` 启动编排进度看板。展示当前活跃 task group 的执行进度、Review 门禁状态、Task/Issue/Blocker 明细；Review 完成要求不存在未解决阻塞 Issue 与 Blocker。只读、2s 轮询刷新。端口被占用时自动递增探测。

## 命令

| 命令 | 用途 |
|------|------|
| `bun test` | 运行所有测试 |
| `bun run typecheck` | TypeScript 类型检查 |

## 项目结构

```
src/index.ts                  — 插件入口（向后兼容导出）
src/core/                     — 状态、门禁、视图、生命周期与 Review 逻辑（含 tools/ 编排工具）
src/dashboard/                — 编排进度看板服务
src/adapters/opencode/        — agent 配置注入与工具注册适配
src/skills/                   — 内置 skill 加载与注入
assets/agents/                — agent 定义
assets/skills/                — 内置 skill 定义
assets/dashboard/             — 看板页面
tests/                        — Bun 测试，使用 FakeGitRunner
```

## 核心特性

- **编排进度看板**：插件加载时启动 HTTP 看板服务，实时展示阶段进度、Review 门禁状态、Task/Issue 明细（2s 轮询、只读）
- **状态持久化**：状态文件按 changeId 拆分并写入主仓库；会话通过工具显式传入的 change_id 定位状态文件；worktree 内 session 通过 `context.json` 指针辅助解析
- **阻塞升级**：不可自主决策的问题持久化、暂停、用户恢复、架构复核
- **Worktree 隔离**：`git worktree` 分支隔离，自动合并清理。`opx_arch_submit` 检测到主仓库本 change 目录下的 openspec 文档污染时自动并入 worktree 分支并清理主仓库工作树
- **执行边界**：架构师限定 developer 的目录和包范围，reviewer 新报 issue 自动扩展
- **豁免机制**：issue → developer 申请豁免 → 对应维度 reviewer 通过 `exempt_issue_ids` 裁定
- **校验守卫**：多维度校验确保流程完整性
- **资源隔离命名空间**：每个 change 分配稳定隔离标识（SHA256(changeId) 前 6 位 hex），Agent 通过 `opx_status` 视图获取；隔离标识派生 SonarQube projectKey 后缀、docker compose 项目名与应用端口，并发 change 在外部共享资源（扫描项目、应用端口、容器）上互不冲突。历史进行中 change 的状态读取时自动补全隔离标识，无需手动迁移；旧 key 产生的扫描数据不可追溯，但 issue 清单已固化在 state，不影响继续编排

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

测试基于 `FakeGitRunner` 伪造 Git，零外部依赖。

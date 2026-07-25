---
name: code-efficiency
description: 代码效率工具：RTK（CLI 输出自动压缩）、Semble（语义搜索）、CodeGraph（知识图谱）。替代 grep/cat/ls/glob 等低效操作。
capabilities: ["efficiency"]
---

> **项目规范优先**：本 skill 所列约定为推荐标准。若项目已有明确规范且与本 skill 不一致，以项目规范为准。

# Code Efficiency — 硬约束协议

## 前置工具

本 skill 依赖以下工具，缺失时自动降级，不影响功能。

| 工具 | 检测方式 | 降级路径 |
|------|---------|---------|
| codegraph_explore MCP | 查可用工具列表 | → codegraph CLI → read/glob |
| codegraph CLI | `command -v codegraph` | → read/glob |
| semble CLI | `command -v semble` | → grep |
| rtk CLI | `command -v rtk` | git 输出不压缩 |

建议自行安装未有的工具以获得最佳体验：
- codegraph：`npm install -g codegraph` 或见 [codegraph 官网](https://github.com/your-org/codegraph)
- semble：`npm install -g @anthropic/semble` 或见 [semble 文档](https://docs.anthropic.com/semble)
- rtk：按项目 README 配置

## 工具可用性检测

加载本 skill 后立即执行以下检测。

### CodeGraph（三级降级）

1. 检查 `codegraph_explore` 是否在可用工具列表中 → 优先使用 MCP
2. MCP 不可用时，`command -v codegraph` → 成功则用 CLI
3. CLI 不可用时 → 回退 read/glob

### Semble（二级降级）

`command -v semble` → 成功则用；失败回退 grep。

### RTK

`command -v rtk` → 成功则标记可用；失败 git 输出不压缩。

## 强制决策表（持续生效）

以下规则在本 session 全程覆盖所有其他工具选择倾向。初始化仅是前置条件——后续所有代码操作必须按此表选择工具。

执行任何操作前，必须查此表：

| 你要做 | 禁止 | 必须 |
|--------|------|------|
| 搜索代码（按功能/自然语言描述） | `grep` / `rg` / 手动 Read 猜文件 | `codegraph_explore` MCP 或 `semble search "<描述>" <path>` |
| 理解代码架构/符号关系 | 手动 Read 多个文件拼接 | `codegraph_explore` MCP（一次返回源码+调用路径） |
| 查调用者/被调用者 | 手动搜引用 | `codegraph callers/callees "<符号>" -p .` |
| 查文件结构/项目布局 | `ls` / `find` / `glob` | `codegraph files -p .` |
| 查符号定义 | 猜文件名后 Read | `codegraph query "<符号>" -p . --kind class/function` |
| 改代码前评估影响 | 靠猜 | `codegraph impact "<符号>" -p . --depth 3` |
| 查看 git 变更/日志/推送 | 裸 `git diff/log/status/push` | hook 自动重写，直接写原生 git 命令 |

## 偏离纠正

如发现自己正使用 `grep` / `rg` / `ls` / `find` / glob / 裸 `git diff` / 逐个 Read 猜测文件——立即停止，改用上表对应工具。这是硬约束，非建议。

## 工具细则

### CodeGraph（MCP 优先）

`codegraph_explore` 已作为 MCP 工具注册。传 `projectPath` 参数指定项目绝对路径。使用前需确保目标项目已 `codegraph init`（worktree 环境每个 worktree 单独 init）。

MCP 不可用时用 CLI 回退：

```bash
codegraph explore "how does auth work" -p .
codegraph query "AuthService" -p . --kind class
codegraph impact "deleteUser" -p . --depth 3
codegraph callers "validateToken" -p .
codegraph files -p .
```

**首次使用需初始化**：`codegraph init <project_path>`。如提示 index 不存在，必须先 init。

**worktree 环境**：git worktree 不继承主仓库的 `.codegraph` 索引。每个 linked worktree 需单独执行 `codegraph init`。

### Semble

语义搜索，无需预建索引，首次搜索自动建立。

```bash
semble search "authentication flow" <path>
semble search "save_pretrained" <path> --top-k 10
semble find-related src/auth.py 42 <path>
```

搜索 yaml/json/md 等配置文件时加 `--include-text-files`。



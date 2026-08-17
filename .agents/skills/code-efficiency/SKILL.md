---
name: code-efficiency
description: Use when exploring, searching, or understanding code. 触发场景：搜索/定位代码、理解架构、查符号定义与调用者/被调用者、评估改动影响、查看项目结构与 git 变更、运行构建测试、读取大文件。当 agent 准备用 grep/rg/ls/find/逐个 Read 探索代码时，必须加载本 skill。替代低效探索，改用 codegraph/semble/rtk。
capabilities: ["efficiency"]
---

# Code Efficiency — 硬约束协议

> 核心规则：任何代码探索、搜索、理解、变更评估，第一步必须先查下方决策表，禁止直接 `grep` / `rg` / `ls` / `find` / glob / 逐个 Read 猜文件。这是硬约束，非建议。

## 触发场景（出现以下任一意图，必须先查决策表）

- 语义/符号搜索（按功能、自然语言、查定义与调用关系）
- 精确关键词全文匹配（含字符串/注释/测试数据/配置文件中的文本）
- 理解架构、符号定义、调用者/被调用者关系
- 改代码前评估影响面
- 查看项目结构 / 文件清单
- 查看 git 变更 / 日志 / 推送
- 运行构建 / 测试 / 静态检查
- 读取大文件 / 长输出
- 运行远程 / 云 / DB CLI 命令

## 工具可用性检测（加载本 skill 后立即执行）

| 工具 | 检测方式 | 降级路径 |
|------|---------|---------|
| codegraph | `command -v codegraph` | → read/glob |
| semble | `command -v semble` | → grep |
| rtk | `command -v rtk` | git/构建/文件/CLI 输出不压缩 |

- semble `--version` 不可用，仅以 `command -v` 判定存在性。
- rtk 是输出压缩层，不承担语义搜索；必须显式 `rtk <command>` 前缀，无自动 hook。`rtk grep` 等参数可能被 rtk 自身消费（返回 usage 文本），此时立即停止重试、回退原生命令并标注降级。

## 强制决策表（本 session 全程覆盖所有工具选择）

执行任何操作前，必须查此表：

| 你要做 | 禁止 | 必须 |
|--------|------|------|
| 语义/符号搜索（按功能/自然语言、查定义/调用关系） | `grep` / `rg` 猜文件、手动 Read 拼接 | `codegraph explore "<描述>" -p .` 或 `semble search "<描述>" <path>` |
| 精确关键词全文匹配（含字符串/注释/测试数据/配置文件） | 用 codegraph 查（只索引符号，会漏非符号文本） | `rtk rg <pattern>`，输出大时靠 rtk 压缩 |
| 理解代码架构/符号关系 | 手动 Read 多个文件拼接 | `codegraph explore "<描述>" -p .`（一次返回源码+调用路径） |
| 查调用者/被调用者 | 手动搜引用 | `codegraph callers/callees "<符号>" -p .` |
| 查符号定义 | 猜文件名后 Read | `codegraph query "<符号>" -p . --kind class/function` |
| 改代码前评估影响 | 靠猜 | `codegraph impact "<符号>" -p . --depth 3` |
| 查文件结构/项目布局 | `ls` / `find` / `glob` | `codegraph files -p .`；需压缩/树形输出时 `rtk ls/tree/find` |
| 查看 git 变更/日志/推送 | 裸 `git diff/log/status/push` | `rtk git diff/log/status/push`（显式前缀） |
| 本地构建/测试/静态检查 | 裸 test/tsc/lint 等全量输出 | `rtk test`（只看失败）/ `rtk tsc`（归并错误）/ `rtk lint` 等 |
| 精读大文件/长输出 | — | 输出量大时 `rtk read`（智能过滤/行号） |
| 远程/云/DB CLI 输出 | 裸 gh/aws/psql 全量输出 | `rtk gh/aws/psql` 等压缩输出 |
| 运行命令只看错误/警告 | 全量输出刷屏 | `rtk err <cmd>` |

### 判断标准：符号级还是全文级

- codegraph/semble **只索引符号**（类、函数、字段、调用关系），**搜不到**字符串字面量、注释、JSON/YAML/SQL 测试数据、配置文件里的文本。
- 目标 token 可能出现在非代码位置（如 `"loanType": "xxx"` 测试数据、SQL 列名、注释）→ 全文匹配，用 `rtk rg`，这是 rg 的合法场景。
- 目标明确是符号（定义在哪、被谁调用、改了影响谁）→ 符号级，用 codegraph。
- 混合需求（既找 `record LoanDetailDto` 定义、又找所有 `loanType` 出现）→ 两步走：`codegraph query` 拿符号 + `rtk rg` 拿全文出现。

## 偏离纠正

先判断需求是符号级还是全文级：符号级需求下发现自己正用 `grep` / `rg` / `ls` / `find` / glob / 逐个 Read 猜文件——立即停止，改用上表对应工具；全文级需求（含字符串/注释/测试数据/配置文件）用 `rtk rg` 是正确做法，不违规。这是硬约束，非建议。

rtk 一律显式前缀（`rtk git diff`），无自动 hook、不会自动压缩；若返回 usage/help 文本或结果持续异常（如多次 0 结果且与其它方式核实不符），立即停止重试，回退该场景的对应原生命令并标注降级，禁止尝试去掉 rtk 前缀调用原生命令或猜测包装方式。

## 组合使用场景示例

```bash
# 场景：架构复核确认"贷款类型"字段模型改动的真实影响面
# 1. 自然语言语义搜索：不依赖精确符号名，按功能描述定位相关代码
semble search "贷款类型 loanType 字段模型处理" src/
# 2. 符号影响评估：对语义命中确认的关键类，一次拿到调用链与影响面
codegraph impact "LoanFieldMerger" -p . --depth 3
# 3. 变更概览：压缩查看本 change 涉及的文件清单与统计，避免 diff 刷屏
rtk git diff --stat main..HEAD

# 场景：排查 loanType 字段的真实出现面（符号+全文两步走）
# 1. 符号级：查类型相关符号
codegraph query "LoanDetailDto" -p .
# 2. 全文级：查所有出现（含字符串/测试数据/注释，codegraph 搜不到）
rtk rg -n "loanType"
```

semble 负责自然语言定位、codegraph 负责符号级影响评估、rtk 负责输出压缩层，三者串起"定位→评估→确认"完整探索链。

## 工具细则

### CodeGraph（CLI）

```bash
# 查询类命令（-p 指定项目路径）
codegraph explore "how does auth work" -p .
codegraph query "AuthService" -p . --kind class
codegraph impact "deleteUser" -p . --depth 3
codegraph callers "validateToken" -p .
codegraph files -p .

# 索引类命令（路径是位置参数，不支持 -p）
codegraph init <project_path>
codegraph sync <project_path>
codegraph status <project_path>
```

判断是否首次：直接检查项目根目录是否存在 `.codegraph` 目录。不存在即为首次，执行 `codegraph init <project_path>`；已存在则执行 `codegraph sync <project_path>` 做增量同步（覆盖已有旧索引、他人初始化过、worktree 等场景），无需重建。

> 参数区别：`init` / `sync` / `status` / `index` / `uninit` 等索引类命令的路径是**位置参数**（`codegraph sync <path>`），传 `-p <path>` 会报 `unknown option '-p'`；`-p <path>` 只用于 `explore` / `query` / `callers` / `callees` / `impact` / `files` 等查询命令。

worktree 环境：git worktree 不继承主仓库的 `.codegraph` 索引，每个 linked worktree 需独立判断：worktree 内存在 `.codegraph` 目录则执行 `codegraph sync <worktree_path>`，不存在则执行 `codegraph init <worktree_path>`。

### Semble

语义搜索，无需预建索引，首次搜索自动建立。

```bash
semble search "authentication flow" <path>
semble search "save_pretrained" <path> --top-k 10
semble find-related src/auth.py 42 <path>
```

搜索 yaml/json/md 等配置文件时加 `--include-text-files`。

### RTK

输出压缩层，显式 `rtk <command>` 前缀，无自动 hook。按场景分类的完整清单：

- **Git**：`rtk git diff/log/status/show/add/commit/push/pull/branch/stash/worktree`
- **文件/目录**：`rtk ls/tree/find/read/wc`
- **搜索压缩**：`rtk rg/grep`
- **构建/测试/静态检查**：`rtk test` / `tsc` / `lint` / `prettier` / `format` / `vitest` / `jest` / `playwright` / `cargo` / `pnpm` / `npm` / `npx` / `next` / `dotnet`
- **远程/云/DB**：`rtk gh/glab/aws/psql/docker/kubectl/oc/curl/wget`
- **通用输出过滤**：`rtk err` / `summary` / `json` / `log` / `pipe` / `run` / `proxy`

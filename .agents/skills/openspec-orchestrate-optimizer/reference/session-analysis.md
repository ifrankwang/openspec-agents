# 模式 A：Session 分析

针对某个编排会话的事后复盘：导出 session、提取事件时间线、合规分析、5-Why 根因追溯、改进建议。

主代理负责编排分析流程与推理，子代理负责重 I/O 读取。

## Quick start

1. `scripts/export-session.sh <sessionID>` 导出并精简 session，返回 JSON 路径 + 摘要文件路径
2. 读取 AGENTS.md「治理原则」章节与 README.md 流程部分，提取约束清单与信号映射
3. 分派子代理按计划读取 session JSON（优先利用摘要文件制定分段策略），提取事件时间线
4. 基于约束清单与事件时间线，执行合规分析（含 5-Why），识别改进点
5. 读取目标文件，提出改进建议
6. 执行方案复核（主 SKILL.md「方案复核」章节）
7. 输出报告

## 详细流程

### 1. 导出 session

分派子代理（general）执行 `scripts/export-session.sh <sessionID>`，子代理返回 JSON 路径 + 摘要路径。脚本同时生成同名的 `.summary.jsonl` 摘要文件（每消息一行的结构化概览），供后续 Step 3 制定分段策略时快速查询。

如果 sessionID 未提供，向用户询问。如果子代理报告脚本报错（如 sessionID 不存在、jq 或 opencode 不可用），将错误信息展示给用户并确认后重试。

脚本内置的递归深度上限为 5 层，主 session 和所有子 session 的 messages 合并到同一个文件中。需要分析工具返回值作为状态转移证据时（如 opx_* 工具返回的 issue 列表、状态码），在分派子代理时令其设置环境变量 `KEEP_TOOL_OUTPUT=1` 以保留 tool output（reasoning 始终删除）。

### 2. 理解编排规范并制定分析计划

基于 Quick start 步骤 2 已读文档，完成以下三项输出：

a) **流程理解**：阶段划分、各阶段步骤、关键决策点、各角色职责
b) **约束清单**：从已读文档中提取所有可验证的约束。覆盖范围包括但不限于：禁止操作、行为约束、调度循环规则、状态机关联约束
c) **信号映射**：对每条约束，确定在 session JSON 中验证它需要观察的信号——检索特定 tool 名称、agent 类型（.info.agent）、时序关系、参数值、消息分组方式等

同时，基于流程理解，确定需要从 session JSON 中提取的**事件类型**及其信号特征。事件类型随着编排流程的版本不同而变化，不得预设固定列表。

### 3. 分派子代理读取 session 并提取事件

主代理**不直接读取**精简后的 JSON。按以下策略分派子代理：

- 估算 JSON 文件大小（`wc -c`）。若 ≤ 30KB，分派 1 个 explore agent 全文读取
- 若 > 30KB：先分派 1 个 explore agent 读取摘要文件（Step 1 脚本输出的 `<output>.summary.jsonl`），根据摘要中的 session 边界制定分段策略——优先按 sessionID 切分（主 session 独立成段，每个子 session 独立成段），若某段仍过大再按编排阶段（task_analysis / dev_impl / review）细分。避免纯按消息索引号机械切分
- 至少需覆盖：编排者 agent 的消息、子 session 中关键角色（openspec-architect、openspec-developer、openspec-reviewer-task）的响应

传给子代理的指令须包含：
- 文件路径 + 分段范围（若分段）
- Step 2 制定的事件类型及其信号特征（告诉子代理"找什么"）
- 返回格式要求——结构化关键事件时间线，不含原始 JSON。**每条事件使用以下固定格式**，确保多个子代理输出可直接合并：

```
[msg_idx] | session(前20字符) | agent | event_type | tool_name | key_params(简短, ≤80字符)
```

子代理只负责数据提取，不负责分析判断。
主 session 和子 session 已在 Step 1 中被合并到同一个文件中，子代理读取时通过 `.info.sessionID` 字段区分来源 session。

### 4. 合规分析

基于 Step 2 的约束清单 + Step 3 的事件时间线，逐条执行检查。

每条不合规项执行 5-Why 分析（内部追查），输出时只给根因结论，不给追问链条。根因必须落在系统性根因（skill/agent/工具设计层面），不得落在个案操作失误。推导出的根因若指向文件，须读对应章节交叉验证。

### 5. 改进分析

从合规分析结果和 session 行为模式中，识别需要改进的具体对象。**每条建议必须指名具体文件路径和章节/行号**（如 `openspec-reviewer-architecture.md` 的第 X 行、`assets/skills/*/SKILL.md` 的某个章节等）。

提出改进建议前，**必须读取目标文件的当前内容**。建议须基于文件现状的实际内容——指出当前内容的具体问题、给出针对性的修改方向。不得凭 session 事件推测文件内容后提出建议。

改进对象的覆盖范围包括但不限于：
- agents（`assets/agents/*.md` 中的哪个 agent 定义，哪部分指令）
- skills（`assets/skills/*/SKILL.md` 中的哪个 skill，哪个章节）
- tools（`src/tools/orchestrate.ts` 中的哪个工具，哪个校验/状态逻辑）
- 本 optimizer skill 自身（`openspec-orchestrate-optimizer` SKILL.md）
- plugins / prompts / 配置文件
- 本 skill 使用的脚本（`scripts/export-session.sh`）

优化方案优先在现有工具内部调整参数、返回值或状态转移逻辑；仅当现有工具语义确实无法承载时才考虑新增工具。

### 5.5 方案复核

按主 SKILL.md「方案复核」执行。子代理额外验证不合规项是否与约束清单逐一匹配。

### 6. 输出报告

纯段落格式，不落盘。按用户诉求逐条列：

```
## 编排会话分析报告
**Session**: <ID>

N. **<问题简述>**
   根因
   <结论>

   方案
   <改动意图>
```

报告输出后，如需对分析结果实施修复，按 `reference/remediation.md` 执行。

## 本模式特有约束

- 主代理不直接执行导出脚本，不直接读取 session JSON；导出与读取均通过子代理
- 子 session 递归深度上限 5 层
- 5-Why 推导的根因若指向文件，必须读文件对应章节交叉验证

## 本模式 Gotchas

- 脚本依赖 `jq` 和 `opencode` CLI，macOS 默认预装 jq；若缺失先提示用户安装
- 子 session 通过 `.state.output` 中的 `ses_` 前缀会话 ID 正则匹配发现
- 子 session 递归时若某子 session 导出失败，不影响主 session 分析，跳过即可
- 精简 JSON 中 tool output 和 reasoning 已被替换为 `[stripped]`，子代理读取时可直接跳过
- 大 session 分段读取时注意段间可能存在依赖（后续消息引用前序结果），分派子代理时告知相邻段范围即可
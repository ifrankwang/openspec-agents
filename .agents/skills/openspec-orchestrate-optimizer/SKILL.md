---
name: openspec-orchestrate-optimizer
description: 编排框架分析与优化。支持会话复盘与优化项分析两种入口。
  Use when user wants to analyze or review an orchestration session, optimize the
  orchestrate workflow, perform a retrospective, or 提出针对编排框架的优化项.
  Triggers on: "分析编排", "复盘 session", "优化 orchestrate", "审查编排质量",
  "找出编排问题", "orchestrate_optimizer", sessionID, 或优化诉求.
argument-hint: "[sessionID]"
---

编排框架分析与优化。主代理负责编排分析流程、推理与判断，子代理负责重 I/O 读取。分析阶段不修改文件。

## 两种入口

| 入口 | 触发 | 处理文档 |
|------|------|---------|
| 模式 A：Session 分析 | 用户提供 sessionID，或要求复盘/审查某次编排会话 | `reference/session-analysis.md` |
| 模式 B：优化项分析 | 用户直接提出针对编排框架的优化或问题诉求，未提供 sessionID | `reference/optimization-item-analysis.md` |

## 模式判断

收到用户请求时，依据以下信号分流：

- 提供了 sessionID（含 `ses_` 前缀）→ **模式 A**
- 触发词明显指向某次具体会话的复盘（"复盘那个 session""分析刚才的编排"）→ 向用户确认 sessionID 后走 **模式 A**
- 直接描述对编排框架的改进或问题诉求（"review 阶段太慢""审查员总报同一个问题""给 architect 加个边界约束"）→ **模式 B**
- 信号模糊（既像复盘诉求又像框架优化，或表述不清）→ 用 question 工具向用户澄清：你想分析某次具体会话的执行情况，还是直接对编排框架提一项优化？得到回答后再分流

确定模式后，**读取对应的 reference 文件**并按其完整流程执行：

- 进入模式 A：读取 `reference/session-analysis.md`
- 进入模式 B：读取 `reference/optimization-item-analysis.md`

## 方案复核（必须）

改进建议拟定后、输出报告前，必须执行方案复核。复核通过方可输出。

1. 主代理将改进建议清单（全文）+ AGENTS.md 治理原则约束清单 + 用户原始反馈打包
2. 分派全新 general 子代理（不与数据收集/读取子代理共用上下文）
3. 子代理逐条复核三个维度：
   - **方案合理性**：建议是否对症、解决根因/差距、可在目标文件中落地
   - **治理原则遵循**：是否违反 AGENTS.md 任一治理原则（尤其工具/agent 同步原则、职责边界、技术栈解耦）
   - **完整性**：用户反馈全量覆盖、每条明确指向文件路径+行号、根因经交叉验证
4. 通过→输出报告；违规→回退修正，迭代上限 2 次；超限→向用户报告，请求裁决

## 修复阶段（可选）

输出分析报告后，如需实施修复，按 `reference/remediation.md` 执行。

## 共用 Gotchas

- 子代理只负责数据提取，主代理负责分析与判断，不得把判断职责外包给子代理
- 改进建议涉及的文件改动常有多处联动，方案探索/影响评估时需列出受影响的 agent/skill/工具
- 工具逻辑以源码（`src/tools/orchestrate.ts`）为准时需注意：声明式行为与运行时行为可能存在差异，怀疑时结合实际调用结果或用户确认后再下结论

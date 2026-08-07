/**
 * 占位符插值 + common/step 语义渲染测试。
 *
 * 覆盖：
 * 1. interpolateText：白名单 key 替换（含 allowed_packages / notes）/ 未知 key 保留原文 / ctx 缺值降级不抛错
 * 2. step.id → 上下文渲染类型路由：5 类 step（analyze/implement/verify_tool/verify_task/verify_quality）渲染对应上下文
 * 3. common + step 约束合并渲染：common.constraints 在前、step.constraints 在后，经插值注入动态值
 * 4. implement 视图 allowed_directories + allowed_packages + notes 注入（有值替换 / 空值渲染为「无额外说明」）
 * 5. instructions 渲染：common.instructions 继承 + step.instructions 追加（编号步骤）
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { interpolateText } from "../src/core/views"
import { loadWorkflow } from "../src/core/workflow/loader"
import { renderWorkflowStatusView } from "../src/core/workflow/status"

// ─── 基建 ───

function makeItem(overrides: Record<string, unknown> = {}): any {
  return {
    id: "task:1",
    source: "openspec",
    type: "task",
    title: "t",
    description: "d",
    phase: "todo",
    suspended: false,
    currentStep: "analyze",
    tags: {},
    metadata: {},
    children: [],
    labels: [],
    ...overrides,
  }
}

function makeIssue(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id: `issue:${id}`,
    source: "openspec",
    type: "issue",
    title: `issue ${id}`,
    description: `issue ${id} 描述`,
    phase: "todo",
    suspended: false,
    currentStep: null,
    tags: {},
    metadata: { source_phase: "tool", dimension: "style" },
    children: [],
    labels: [],
    severity: "Low",
    ...overrides,
  }
}

function makeTask(id: string, title: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    source: "openspec",
    type: "task",
    title,
    description: "d",
    phase: "review",
    suspended: false,
    currentStep: null,
    tags: {},
    metadata: { specTrace: "spec-a" },
    children: [],
    labels: [],
    ...overrides,
  }
}

/** 直接渲染 working 视图（读取仓库 task.yaml，聚焦 status 渲染逻辑）。 */
function renderWorking(item: any, stepId: string, agent: string): string {
  const workflow = loadWorkflow(readFileSync(join(import.meta.dir, "../assets/workflows/task.yaml"), "utf8"))
  const state = {
    changeId: "cid", isolationNamespace: "ns", taskGroupId: "1", baseBranch: "main",
    workItems: [item], createdAt: "", updatedAt: "",
  }
  const tg = { worktreePath: "/wt", branchName: "b", baseRef: "base" }
  return renderWorkflowStatusView(
    item,
    workflow,
    { status: "recommend", stepId, agents: [agent] },
    agent,
    { state, tg } as any,
  )
}

// ═══════════════════════════════════════════════════
//  1. interpolateText 占位符插值
// ═══════════════════════════════════════════════════

describe("interpolateText 占位符插值", () => {
  test("白名单 key 替换为 ctx 值（含 allowed_packages / notes）", () => {
    expect(interpolateText("目录：{{allowed_directories}}｜包：{{allowed_packages}}｜notes：{{notes}}", {
      allowed_directories: "src, lib", allowed_packages: "com.t", notes: "坑位提醒",
    })).toBe("目录：src, lib｜包：com.t｜notes：坑位提醒")
    expect(
      interpolateText("{{worktree_path}}|{{change_id}}|{{step_id}}|{{phase}}|{{agent}}", {
        worktree_path: "/wt", change_id: "c1", step_id: "implement", phase: "in_progress", agent: "openspec-developer",
      })
    ).toBe("/wt|c1|implement|in_progress|openspec-developer")
  })

  test("未知 key 保留原文（不替换）", () => {
    expect(interpolateText("a {{secret}} b", { secret: "x" })).toBe("a {{secret}} b")
    expect(interpolateText("{{not_in_whitelist}}", {})).toBe("{{not_in_whitelist}}")
  })

  test("ctx 缺值降级不抛错，保留原文", () => {
    expect(interpolateText("允许目录：{{allowed_directories}}", {})).toBe("允许目录：{{allowed_directories}}")
    expect(interpolateText("{{worktree_path}}/{{change_id}}", { change_id: "c" })).toBe("{{worktree_path}}/c")
  })
})

// ═══════════════════════════════════════════════════
//  2. step.id 路由：5 类 step 渲染对应上下文
// ═══════════════════════════════════════════════════

describe("renderStepContext step.id 路由", () => {
  test("analyze（step.id=analyze）：渲染 Blocker 区块", () => {
    const item = makeItem({
      phase: "todo",
      currentStep: "analyze",
      metadata: {
        blockers: [{
          id: "b1", sourceRole: "openspec-architect", taskId: null, category: "architecture_design",
          description: "接口契约未定", evidence: "E", attemptedActions: "A", options: [],
          status: "awaiting_user", userResponse: null, architectConclusion: null,
        }],
      },
    })
    const out = renderWorking(item, "analyze", "openspec-architect")
    expect(out).toContain("## Blocker")
    expect(out).toContain("接口契约未定")
    expect(out).toContain("blocker_updates")
  })

  test("implement（step.id=implement）：渲染约束区块 + 待修复 children", () => {
    const item = makeItem({
      phase: "in_progress",
      currentStep: "implement",
      metadata: { execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } },
      children: [makeIssue("1", { severity: "Medium" })],
    })
    const out = renderWorking(item, "implement", "openspec-developer")
    expect(out).toContain("## 约束")
    expect(out).toContain("允许变更目录范围：src")
    expect(out).toContain("Issue (待修复 · Low 及以上，必办)")
  })

  test("verify_tool（step.id=verify_tool → review_tool）：渲染 tool 层 children 清单", () => {
    const item = makeItem({
      phase: "review",
      currentStep: "verify_tool",
      children: [
        makeIssue("1", { phase: "review", metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style" } }),
        makeIssue("2", { metadata: { source: "openspec-reviewer-tool", source_phase: "tool", dimension: "style", exempt_request: { requestedBy: "developer" } } }),
      ],
    })
    const out = renderWorking(item, "verify_tool", "openspec-reviewer-tool")
    expect(out).toContain("Issue (待复核)")
    expect(out).toContain("Issue (待裁定是否可豁免)")
  })

  test("verify_task（step.id=verify_task → review_task）：渲染待验证 Task 清单 + task 层 Issue 主区块", () => {
    const item = makeItem({
      phase: "review",
      currentStep: "verify_task",
      children: [
        makeTask("1", "Task one"),
        makeIssue("2", { phase: "review", metadata: { source: "openspec-reviewer-task", source_phase: "task", dimension: "style" } }),
      ],
    })
    const out = renderWorking(item, "verify_task", "openspec-reviewer-task")
    expect(out).toContain("Task (待验证)")
    expect(out).toContain("Task one")
    expect(out).toContain("## Issue (待复核)")
    expect(out).toContain("issue 2 描述")
  })

  test("verify_quality（step.id=verify_quality → review_quality）：按 ctxAgent 维度过滤渲染本维 children", () => {
    const item = makeItem({
      phase: "review",
      currentStep: "verify_quality",
      children: [
        makeIssue("1", { phase: "review", metadata: { source: "openspec-reviewer-style", source_phase: "quality", dimension: "style", file: "src/c.ts", line: 5 } }),
        makeIssue("2", { phase: "review", severity: "Critical", metadata: { source: "openspec-reviewer-architecture", source_phase: "quality", dimension: "architecture" } }),
      ],
    })
    const out = renderWorking(item, "verify_quality", "openspec-reviewer-style")
    expect(out).toContain("## Issue (待复核)")
    expect(out).toContain("issue 1 描述")
    // architecture 维度 child 不可见
    expect(out).not.toContain("issue 2 描述")
  })
})

// ═══════════════════════════════════════════════════
//  3. common + step 语义渲染（constraints / instructions）
// ═══════════════════════════════════════════════════

describe("common + step 语义渲染", () => {
  test("implement：common/step 约束合并（allowed_directories / allowed_packages / notes 有值替换）", () => {
    const item = makeItem({
      phase: "in_progress",
      currentStep: "implement",
      metadata: { execution_boundary: { allowed_directories: ["src", "lib"], allowed_packages: ["com.t"], notes: "坑位提醒" } },
    })
    const out = renderWorking(item, "implement", "openspec-developer")
    expect(out).toContain("## 约束")
    // common.constraints 在前（worktree_path 已插值）
    expect(out).toContain("所有 edit/write 操作限定在 /wt 内，严禁修改主仓库路径下的文件")
    expect(out).toContain("不跳步骤、不自行推断阶段流转，next-step 以 opx_status 为准")
    // step.constraints 在后（allowed_directories / allowed_packages / notes 注入）
    expect(out).toContain("允许变更目录范围：src, lib")
    expect(out).toContain("允许引用包范围：com.t")
    expect(out).toContain("实施前请注意遵守：坑位提醒")
    expect(out).not.toContain("{{allowed_directories}}")
    expect(out).not.toContain("{{allowed_packages}}")
    expect(out).not.toContain("{{notes}}")
    // 去重：opx_orch_* 禁令仅 common 一次（step 级重复短语已删除）
    expect(out.match(/opx_orch_\*/g)?.length).toBe(1)
  })

  test("implement：notes 留空 → 约束渲染为「无额外说明」，不出现字面 {{notes}}", () => {
    const item = makeItem({
      phase: "in_progress",
      currentStep: "implement",
      metadata: { execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } },
    })
    const out = renderWorking(item, "implement", "openspec-developer")
    expect(out).toContain("实施前请注意遵守：无额外说明")
    expect(out).not.toContain("{{notes}}")
  })

  test("implement：执行边界缺失 → 占位符保留原文", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    const out = renderWorking(item, "implement", "openspec-developer")
    expect(out).toContain("允许变更目录范围：{{allowed_directories}}")
    expect(out).toContain("允许引用包范围：{{allowed_packages}}")
    expect(out).toContain("实施前请注意遵守：{{notes}}")
    // common.constraints 中 worktree_path 有值 → 已插值
    expect(out).toContain("所有 edit/write 操作限定在 /wt 内")
  })

  test("instructions：common 继承 + step 追加（编号步骤）", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    const out = renderWorking(item, "implement", "openspec-developer")
    expect(out).toContain("## 操作指引")
    // common.instructions 继承（worktree_path 插值）
    expect(out).toContain("调用 opx_status 获取动态上下文（/wt、变更范围、上轮会话摘要）")
    expect(out).toContain("按 Skill 加载清单加载匹配的 skill 并遵循其全部规范")
    expect(out).toContain("完成后调用 opx_agent_submit 提交裁决或失败上报")
    // step.instructions 追加
    expect(out).toContain("按 Task 项顺序逐个实现，聚焦当前子任务，不超出执行边界")
    // 修复闭环指引（P1）：fixed_issue_ids 上报进入待复核 + blocking issue 全覆盖门禁
    expect(out).toContain("修复完成的 issue 经 fixed_issue_ids 上报后进入待复核（review）状态，终态由对应 reviewer 复核裁定")
    expect(out).toContain("提交 opx_agent_submit：passed 时存在未完成或被驳回（open/rejected）的子任务必须全部列入 completed_task_ids（数字 id 如 1、2，或任务编号如 1.1），全部子任务已验证时可省略；不可修 issue 申请豁免（exempt_issue_ids）")
    // 提交引导步骤仍在（硬编码收尾步骤）
    expect(out).toContain("全部完成 → commit →")
  })

  test("analyze：constraints（blocker 走 barrier 不入配置语义）+ instructions", () => {
    const item = makeItem({ phase: "todo", currentStep: "analyze" })
    const out = renderWorking(item, "analyze", "openspec-architect")
    // analyze 有自己的 constraints（与 common 合并）
    expect(out).toContain("## 约束")
    expect(out).toContain("仅可 edit 修复 md 文档；设计/架构验证问题与信息缺口一律走 blocker")
    expect(out).toContain("所有 edit/write 操作限定在 /wt 内")
    // instructions：common 继承 + step 追加
    expect(out).toContain("存在缺口时提交 blocker（category: architecture_design / info_gap），不以假设替代确认")
    expect(out).toContain("提交 opx_agent_submit，必传参数 execution_boundary")
    // 构建验证句不对 analyze 渲染
    expect(out).not.toContain("构建验证")
  })
})

// ═══════════════════════════════════════════════════
//  4. 操作层指引补全：文档读取 / 工具调用边界 / verdict 门禁
// ═══════════════════════════════════════════════════

describe("step 操作层指引补全", () => {
  test("common：文档读取路径 / AGENTS.md / opx_orch_* 禁令 / 变更范围命令", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    const out = renderWorking(item, "implement", "openspec-developer")
    expect(out).toContain("读取 `/wt/openspec/changes/cid/` 下的相关文档：tasks.md")
    expect(out).toContain("按行内 `[spec:xxx]` 溯源定位 specs/ 下相关 spec.md")
    expect(out).toContain("阅读 `/wt/AGENTS.md` 项目规范")
    expect(out).toContain("禁止调用任何 opx_orch_* 工具（编排者专属）")
    expect(out).toContain("以视图「变更范围」命令产出的文件清单作为本次工作范围")
    expect(out).not.toContain("<baseRef>")
    expect(out).toContain("git -C /wt diff --name-only")
  })

  test("analyze：按评估维度审查 / 用户确认模式 / 工具调用边界 / 只审当前任务组范围", () => {
    const item = makeItem({ phase: "todo", currentStep: "analyze" })
    const out = renderWorking(item, "analyze", "openspec-architect")
    expect(out).toContain("按评估维度逐项审查 design.md 并给出结论：architecture / api-design / db-design（无问题也需简要确认），不以假设替代确认")
    expect(out).toContain("需用户确认的缺口以 blocker 提交（正常模式由编排者向用户确认，无人值守模式由编排者自动裁决）")
    expect(out).toContain("工具调用边界：仅可调用 opx_status 与 opx_agent_submit")
    expect(out).toContain("只审当前任务组范围：除任务排列是否合理需阅览全部任务组标题外，其它检查聚焦当前任务组直接相关的文档章节")
    // notes 规范展开
    expect(out).toContain("notes 仅填实施建议（关键坑位/组件复用/边缘场景/框架应用/通用做法），不重复目录与包路径，无补充时留空")
  })

  test("implement：文档读取 / 环境问题代码层解决 / issue 修复范围 / blocker 字段", () => {
    const item = makeItem({
      phase: "in_progress",
      currentStep: "implement",
      metadata: { execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } },
    })
    const out = renderWorking(item, "implement", "openspec-developer")
    expect(out).toContain("tasks.md 当前任务组任务项 + `[spec:xxx]` 溯源 specs/ 下相关 spec.md（需求细节与验收标准）")
    expect(out).toContain("存在时读取 clarify.md（架构方向结论）")
    expect(out).toContain("环境/基础设施问题（schema 缺失、DDL 未执行、依赖未安装）应通过 migration/初始化脚本等代码层面解决")
    expect(out).toContain("仅生产级凭据、真实第三方资源、人工运维才走 blocker/豁免")
    expect(out).toContain("issue 指向文件的目录已并入执行边界，修复这些文件（含回归引入问题）不算越界")
    expect(out).toContain("reviewer 的 boundary_expansion 已并入边界")
    expect(out).toContain("以 verdict=failed 提交 blocker（含 source_role、task_id、category、description、evidence、attempted_actions、options）")
    // 禁改设计文档（step 级仅保留该专属约束，opx_orch_* 禁令已在 common）
    expect(out).toContain("禁用 edit/write 修改 `/wt/openspec/changes/` 下任何文档（spec/design/tasks/clarify）")
    expect(out).not.toContain("禁止调用任何 opx_orch_* 工具（编排者专属）；禁用")
  })

  test("verify_tool：工具检查全量 / 跨维归因 / 待裁定 / 工具边界 / passed 门禁", () => {
    const item = makeItem({ phase: "review", currentStep: "verify_tool" })
    const out = renderWorking(item, "verify_tool", "openspec-reviewer-tool")
    expect(out).toContain("顺序运行全部确定性工具检查（代码格式/架构约束/静态分析/单元测试编译/深度扫描）")
    expect(out).toContain("报 issue 时必须显式声明归因维度 dimension（style/architecture/performance/security/maintainability）")
    expect(out).toContain("非本轮变更文件的工具违规同样映射为 issue 提交，禁止因非本轮引入静默丢弃")
    expect(out).toContain("对视图「待裁定是否可豁免」区块中的豁免申请经 exempt_adjudications 裁定（dismissed/rejected）")
    expect(out).toContain("工具调用边界：仅可调用 opx_status、opx_agent_submit、question（需要用户协助处理时）")
    expect(out).not.toContain("；禁止 opx_orch_*")
    expect(out).toContain("即使无 issue 也必须提交 verdict=passed（不通过必须有至少一个 Low+ issue 作为理由）")
    expect(out).toContain("Info 级 issue 的 description/suggestion 禁止阶段/时机表述（如'可后续处理'）")
  })

  test("verify_task：四项验证 / failed_tasks 上报 / 待裁定豁免 / 资源缺失 Low", () => {
    const item = makeItem({ phase: "review", currentStep: "verify_task" })
    const out = renderWorking(item, "verify_task", "openspec-reviewer-task")
    expect(out).toContain("逐项验证：①task 产出完整性 ②启动服务并检查健康 ③独立执行全量 API 测试并审查质量 ④审查测试代码质量")
    expect(out).toContain("有 task 未通过时必须 verdict=failed 并经 failed_tasks 上报（task_id + reason）；passed 时不允许提供 failed_tasks")
    expect(out).toContain("对视图「待裁定是否可豁免」区块中的豁免申请经 exempt_adjudications 裁定")
    expect(out).toContain("design.md 的 API 定义（请求/响应结构、数据模型）")
    expect(out).toContain("specs/ 下相关 spec.md（需求细节与验收标准），用于准备测试数据与对照 API 合约")
    expect(out).toContain("工具调用边界：仅可调用 opx_status、opx_agent_submit；可 bash 启动服务/执行检查，但不得 edit/write 业务代码")
    // 严重级别判例归属 agent.md，约束中不重复
    expect(out).not.toContain("缺少验证所需真实资源时最低记 Low")
    expect(out).not.toContain("；禁止 opx_orch_*")
    expect(out).toContain("即使无 issue / 无待验证 task 也必须提交 verdict=passed（不通过必须有至少一个 Low+ issue 作为理由）")
  })

  test("verify_quality：拓展审查 / 既有 issue 去重 / 禁确定性工具 / passed=false 需本维 Low+", () => {
    const item = makeItem({
      phase: "review",
      currentStep: "verify_quality",
      children: [
        makeIssue("1", { metadata: { source_phase: "quality", dimension: "style", file: "src/c.ts", line: 5 } }),
      ],
    })
    const out = renderWorking(item, "verify_quality", "openspec-reviewer-style")
    expect(out).toContain("以本轮 diff/变更文件为锚点结合 skill 规范与领域知识做拓展审查（skill 仅为最低基准）")
    expect(out).toContain("顺带发现的非本轮缺陷按本维度严重级别标准报 issue，禁止静默丢弃")
    expect(out).toContain("审查新 issue 前先查看视图「待复核」区块中的既有 issue（仅本维度报源），避免语义重复")
    // 豁免裁定指引：verify_quality 新增与 tool/task 同口径
    expect(out).toContain("对视图「待裁定是否可豁免」区块中的豁免申请经 exempt_adjudications 裁定（dismissed/rejected）")
    // 工具化反思步骤：报 issue 前先判断能否经确定性扫描工具配置收敛
    expect(out).toContain("报本维度新 issue 前先判断该问题能否通过调整确定性质量扫描工具配置")
    expect(out).toContain("可工具化")
    expect(out).toContain("工具改进 issue")
    expect(out).toContain("[tool_eligible]")
    expect(out).toContain("禁止运行确定性工具检查（包括但不限于 linter/formatter/静态分析/编译/测试/架构约束检查等）")
    // 追加澄清句不破坏原文匹配（运行权归 tool review 层）
    expect(out).toContain("运行权归 tool review 层，本约束不排斥基于已加载 skill 做工具化可行性判断并提交工具改进 issue")
    expect(out).toContain("工具调用边界：仅可调用 opx_status、opx_agent_submit；不得 edit/write 任何文件，仅输出审查报告")
    expect(out).not.toContain("；禁止 opx_orch_*")
    expect(out).toContain("即使无 issue 也必须提交 verdict=passed；passed=false 时必须有至少一个归属本维度的 Low+ issue 作为理由")
  })
})

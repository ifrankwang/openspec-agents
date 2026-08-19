/**
 * simple 模式引擎门禁测试（变更组 2.4）：
 * - REVIEW_STEP_TO_LAYER 增加 quality_review → "quality"（2.1）
 * - stepCanPass 对 quality_review 按 quality 层口径：本层 blocking issue 终态才可 pass
 * - blockingStepChildren / recommendForItem（blocked 补交推导）对 quality_review 生效
 * - implement 失败自循环（on_fail: implement 同 phase）：applyTransition 同 phase 分支提前返回，
 *   不触发 clearStepTags / incrementRetry（与 design.md D4 描述差异核验，见测试注释），
 *   dev 重派由 recommendAgents 单 agent「非 passed 重派」分支保证
 * - quality_review 失败回 implement：跨 phase 回退 clearStepTags("implement") 清 developer passed tag，
 *   整步重审并重派 developer
 */
import { describe, expect, test } from "bun:test"
import { loadWorkflowFile, SIMPLE_WORKFLOW_PATH } from "../src/core/workflow/loader"
import {
  REVIEW_STEP_TO_LAYER, createInitialWorkItem, applyAgentVerdict, getStepVerdict,
  stepCanPass, blockingStepChildren, applyTransition, recommendForItem,
} from "../src/core/workflow/engine"
import type { WorkItem } from "../src/core/workflow/types"

const wf = loadWorkflowFile(SIMPLE_WORKFLOW_PATH)

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    ...createInitialWorkItem({
      id: "task:1",
      source: "openspec",
      type: "task",
      title: "组 1",
      description: "",
    }),
    phase: "in_progress",
    currentStep: "implement",
    ...overrides,
  }
}

/** quality 层 issue child（报源 openspec-reviewer → quality 层），默认 Low 级 todo 态。 */
function issueChild(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    ...createInitialWorkItem({
      id: "issue:1",
      source: "openspec-reviewer",
      externalId: "1",
      type: "issue",
      title: "问题",
      description: "desc",
      severity: "Low",
    }),
    metadata: { source: "openspec-reviewer", dimension: "style" },
    ...overrides,
  }
}

describe("2.1 REVIEW_STEP_TO_LAYER 扩展", () => {
  test("quality_review → quality；既有 verify step 映射不变", () => {
    expect(REVIEW_STEP_TO_LAYER["quality_review"]).toBe("quality")
    expect(REVIEW_STEP_TO_LAYER["verify_tool"]).toBe("tool")
    expect(REVIEW_STEP_TO_LAYER["verify_task"]).toBe("task")
    expect(REVIEW_STEP_TO_LAYER["verify_quality"]).toBe("quality")
    expect(REVIEW_STEP_TO_LAYER["implement"]).toBeUndefined()
  })
})

describe("stepCanPass：quality_review 按 quality 层口径门禁", () => {
  const step = wf.stepMap.get("quality_review")!.step

  test("本层（quality 报源）review 态 blocking child 阻塞（未复核不得 pass）", () => {
    const item = makeItem({ phase: "review", currentStep: "quality_review" })
    applyAgentVerdict(item, "quality_review", "openspec-reviewer", "passed")
    item.children.push(issueChild({ phase: "review" }))
    expect(stepCanPass(item, step)).toBe(false)
  })

  test("本层 blocking child 终态（done）放行", () => {
    const item = makeItem({ phase: "review", currentStep: "quality_review" })
    applyAgentVerdict(item, "quality_review", "openspec-reviewer", "passed")
    item.children.push(issueChild({ phase: "done" }))
    expect(stepCanPass(item, step)).toBe(true)
  })

  test("本层 todo 态（未修复）阻塞", () => {
    const item = makeItem({ phase: "review", currentStep: "quality_review" })
    applyAgentVerdict(item, "quality_review", "openspec-reviewer", "passed")
    item.children.push(issueChild({ phase: "todo" }))
    expect(stepCanPass(item, step)).toBe(false)
  })

  test("其他层（tool 报源）review 态 blocking child 不阻塞 quality_review", () => {
    const item = makeItem({ phase: "review", currentStep: "quality_review" })
    applyAgentVerdict(item, "quality_review", "openspec-reviewer", "passed")
    item.children.push(
      issueChild({ id: "issue:2", phase: "review", metadata: { source: "openspec-reviewer-tool", dimension: "style" } }),
    )
    expect(stepCanPass(item, step)).toBe(true)
  })
})

describe("blockingStepChildren：quality_review 只列本层非终态 blocking child", () => {
  test("本层 review/todo 态列出；终态、Info、其他层不列出", () => {
    const step = wf.stepMap.get("quality_review")!.step
    const item = makeItem({ phase: "review", currentStep: "quality_review" })
    item.children.push(
      issueChild({ phase: "review" }), // quality 层 review 态 → 列出
      issueChild({ id: "issue:2", phase: "todo" }), // quality 层 todo 态 → 列出
      issueChild({ id: "issue:3", phase: "done" }), // 终态 → 不列出
      issueChild({ id: "issue:4", phase: "todo", severity: "Info" }), // Info → 不列出
      issueChild({ id: "issue:5", phase: "review", metadata: { source: "openspec-reviewer-tool", dimension: "style" } }), // 其他层 → 不列出
    )
    expect(blockingStepChildren(item, step).map((c) => c.id)).toEqual(["issue:1", "issue:2"])
  })
})

describe("recommendForItem：quality_review blocked 推导与补交判定", () => {
  test("quality_review 全 passed 但本层 blocking 未终态 → blocked 且推导补交报源 reviewer", () => {
    const item = makeItem({ phase: "review", currentStep: "quality_review" })
    applyAgentVerdict(item, "quality_review", "openspec-reviewer", "passed")
    item.children.push(issueChild({ phase: "review" }))
    const rec = recommendForItem(item, wf)
    expect(rec.status).toBe("blocked")
    expect(rec.stepId).toBe("quality_review")
    expect(rec.agents).toEqual(["openspec-reviewer"])
    expect(rec.blockedReason).toMatch(/待复核/)
  })

  test("quality_review 全 passed 且本层 blocking 全终态 → terminal（沿 on_pass 推进）", () => {
    const item = makeItem({ phase: "review", currentStep: "quality_review" })
    applyAgentVerdict(item, "quality_review", "openspec-reviewer", "passed")
    item.children.push(issueChild({ phase: "done" }))
    const rec = recommendForItem(item, wf)
    expect(rec.status).toBe("terminal")
  })

  test("quality_review 待裁定豁免申请（exempt_request 标记）→ blocked 且推导补交报源 reviewer", () => {
    const item = makeItem({ phase: "review", currentStep: "quality_review" })
    applyAgentVerdict(item, "quality_review", "openspec-reviewer", "passed")
    item.children.push(issueChild({ phase: "review", metadata: { source: "openspec-reviewer", dimension: "style", exempt_request: { requestedBy: "openspec-developer" } } }))
    const rec = recommendForItem(item, wf)
    expect(rec.status).toBe("blocked")
    expect(rec.agents).toEqual(["openspec-reviewer"])
    expect(rec.blockedReason).toMatch(/豁免申请/)
  })
})

describe("implement 失败自循环（on_fail: implement 同 phase）", () => {
  test("applyTransition(fail) 同 phase 提前返回：advanced、target=implement，不清 implement tags", () => {
    const item = makeItem() // phase=in_progress, currentStep=implement
    applyAgentVerdict(item, "implement", "openspec-developer", "failed")
    const r = applyTransition(item, wf, "fail")
    expect(r.advanced).toBe(true)
    expect(r.target).toBe("implement")
    // 与 design.md D4 描述的差异核验：applyTransition 同 phase 分支（resolved.phaseName === item.phase）
    // 提前返回，不触发 clearStepTags / incrementRetry——implement:openspec-developer 的 failed tag 残留。
    // dev 重派不依赖 clearStepTags：recommendAgents 单 agent「非 passed 重派」分支仍返回 failed 的 developer。
    expect(getStepVerdict(item, "implement", "openspec-developer")).toBe("failed")
    expect(item.phase).toBe("in_progress")
    expect(item.currentStep).toBe("implement")
  })

  test("implement failed 后 recommendForItem 仍重派 developer（非 passed 单 agent 分支）", () => {
    const item = makeItem()
    applyAgentVerdict(item, "implement", "openspec-developer", "failed")
    const rec = recommendForItem(item, wf)
    expect(rec.status).toBe("recommend")
    expect(rec.stepId).toBe("implement")
    expect(rec.agents).toEqual(["openspec-developer"])
  })
})

describe("quality_review 失败回 implement 整步重审与重派", () => {
  test("跨 phase 回退：phase=in_progress、currentStep=implement、清 developer passed tag、重派 dev", () => {
    const item = makeItem({ phase: "review", currentStep: "quality_review" })
    applyAgentVerdict(item, "implement", "openspec-developer", "passed")
    applyAgentVerdict(item, "quality_review", "openspec-reviewer", "failed")
    const reviewChild = issueChild({ phase: "review" })
    item.children.push(reviewChild, issueChild({ id: "issue:2", phase: "todo" }))

    const r = applyTransition(item, wf, "fail")
    expect(r.advanced).toBe(true)
    expect(r.target).toBe("implement")
    expect(item.phase).toBe("in_progress")
    expect(item.currentStep).toBe("implement")
    // 跨 phase 回退分支 clearStepTags(resolved.step.id)：implement:openspec-developer passed tag 被清 → 整步重审
    expect(getStepVerdict(item, "implement", "openspec-developer")).toBe("pending")
    // rollbackChildren：review 态 child 保留（已由 dev 提交进入待复核），todo 态 child 重置为 todo
    expect(reviewChild.phase).toBe("review")
    // quality_review failed tag 残留：下次进入 quality_review 时审查者必然被重派（与 full 模式 failed 维重派语义一致）
    expect(getStepVerdict(item, "quality_review", "openspec-reviewer")).toBe("failed")

    const rec = recommendForItem(item, wf)
    expect(rec.status).toBe("recommend")
    expect(rec.agents).toEqual(["openspec-developer"])
  })
})

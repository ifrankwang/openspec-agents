/**
 * resetReviewTagsOnFix / dedupeNewChildren 分层重置测试（M1b）。
 *
 * 覆盖 resetReviewTagsOnFix 全分支：
 * 1. 任一 fixed → 清 verify_tool
 * 2. fixed 含 task 层 → 额外清 verify_task
 * 3. exempt 含 task 层 → 清 verify_tool + verify_task
 * 4. exempt 含 tool 层 → 清 verify_tool（不动 verify_task）
 * 5. quality 层 fixed/exempt 且维度 dim → 只清 verify_quality 对应 agent tag
 * 6. 纯豁免（无 tool/task 层）→ 不清 verify_tool/verify_task
 *
 * dedupeNewChildren：
 * 7. 与未终态 child 按 (sourcePhase/dimension/file/line/description) 判重返回 {accepted, dedupedCount}
 * 8. 已终态 child 不参与判重（允许 reviewer 重报已关闭问题）
 */
import { describe, expect, test } from "bun:test"
import {
  createInitialWorkItem, applyAgentVerdict, getStepVerdict,
  resetReviewTagsOnFix, dedupeNewChildren, resolveChildIssueFields,
} from "../src/core/workflow"
import type { WorkItem } from "../src/core/workflow/types"

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "w1",
    source: "openspec",
    type: "task",
    title: "T1",
    description: "d",
    phase: "in_progress",
    suspended: false,
    currentStep: "implement",
    tags: {},
    metadata: {},
    children: [],
    labels: [],
    ...overrides,
  }
}

/** 构造带全量 review 验证 tag 的 item（verify_tool/verify_task/verify_quality 各维度 agent 均已 passed）。 */
function itemWithReviewTags(): WorkItem {
  const item = makeItem()
  applyAgentVerdict(item, "verify_tool", "openspec-reviewer-tool", "passed")
  applyAgentVerdict(item, "verify_task", "openspec-reviewer-task", "passed")
  for (const agent of [
    "openspec-reviewer-style",
    "openspec-reviewer-architecture",
    "openspec-reviewer-performance",
    "openspec-reviewer-security",
    "openspec-reviewer-maintainability",
  ]) {
    applyAgentVerdict(item, "verify_quality", agent, "passed")
  }
  return item
}

function issueChild(overrides: Partial<WorkItem> = {}): WorkItem {
  const child = createInitialWorkItem({
    id: `issue:${overrides.id ?? "1"}`,
    source: "openspec",
    externalId: String(overrides.id ?? "1"),
    type: "issue",
    title: "I",
    description: "d",
    severity: "Low",
  })
  if (overrides.metadata?.source !== undefined) child.metadata["source"] = overrides.metadata.source as string
  child.metadata["source_phase"] = overrides.metadata?.source_phase ?? "tool"
  child.metadata["dimension"] = overrides.metadata?.dimension ?? "style"
  child.metadata["file"] = overrides.metadata?.file ?? ""
  child.metadata["line"] = overrides.metadata?.line ?? 0
  return child
}

describe("1. resetReviewTagsOnFix 分层重置", () => {
  test("任一 fixed（tool 层）→ 清 verify_tool，verify_task/verify_quality 保留", () => {
    const item = itemWithReviewTags()
    resetReviewTagsOnFix(item, { fixedSourcePhases: ["tool"], exemptSourcePhases: [], touchedQualityDims: [] })
    expect(getStepVerdict(item, "verify_tool", "openspec-reviewer-tool")).toBe("pending")
    expect(getStepVerdict(item, "verify_task", "openspec-reviewer-task")).toBe("passed")
    expect(getStepVerdict(item, "verify_quality", "openspec-reviewer-style")).toBe("passed")
  })

  test("fixed 含 task 层 → 额外清 verify_task", () => {
    const item = itemWithReviewTags()
    resetReviewTagsOnFix(item, { fixedSourcePhases: ["task"], exemptSourcePhases: [], touchedQualityDims: [] })
    expect(getStepVerdict(item, "verify_tool", "openspec-reviewer-tool")).toBe("pending")
    expect(getStepVerdict(item, "verify_task", "openspec-reviewer-task")).toBe("pending")
  })

  test("exempt 含 task 层 → 清 verify_tool + verify_task", () => {
    const item = itemWithReviewTags()
    resetReviewTagsOnFix(item, { fixedSourcePhases: [], exemptSourcePhases: ["task"], touchedQualityDims: [] })
    expect(getStepVerdict(item, "verify_tool", "openspec-reviewer-tool")).toBe("pending")
    expect(getStepVerdict(item, "verify_task", "openspec-reviewer-task")).toBe("pending")
  })

  test("exempt 含 tool 层 → 清 verify_tool，不动 verify_task", () => {
    const item = itemWithReviewTags()
    resetReviewTagsOnFix(item, { fixedSourcePhases: [], exemptSourcePhases: ["tool"], touchedQualityDims: [] })
    expect(getStepVerdict(item, "verify_tool", "openspec-reviewer-tool")).toBe("pending")
    expect(getStepVerdict(item, "verify_task", "openspec-reviewer-task")).toBe("passed")
  })

  test("quality 层 fixed 且维度 security → 清 verify_tool（任一 fixed 触发），且只清 verify_quality 的 security agent tag", () => {
    const item = itemWithReviewTags()
    resetReviewTagsOnFix(item, { fixedSourcePhases: ["quality"], exemptSourcePhases: [], touchedQualityDims: ["security"] })
    expect(getStepVerdict(item, "verify_quality", "openspec-reviewer-security")).toBe("pending")
    expect(getStepVerdict(item, "verify_quality", "openspec-reviewer-style")).toBe("passed")
    // 任一 fixed 即代码变更 → verify_tool 重跑；fixed 非 task 层 → verify_task 保留
    expect(getStepVerdict(item, "verify_tool", "openspec-reviewer-tool")).toBe("pending")
    expect(getStepVerdict(item, "verify_task", "openspec-reviewer-task")).toBe("passed")
  })

  test("quality 层 exempt 且维度 performance → 只清对应 agent tag", () => {
    const item = itemWithReviewTags()
    resetReviewTagsOnFix(item, { fixedSourcePhases: [], exemptSourcePhases: ["quality"], touchedQualityDims: ["performance"] })
    expect(getStepVerdict(item, "verify_quality", "openspec-reviewer-performance")).toBe("pending")
    expect(getStepVerdict(item, "verify_quality", "openspec-reviewer-security")).toBe("passed")
    expect(getStepVerdict(item, "verify_tool", "openspec-reviewer-tool")).toBe("passed")
    expect(getStepVerdict(item, "verify_task", "openspec-reviewer-task")).toBe("passed")
  })

  test("多维度同时 touched → 对应 agent 全部清空", () => {
    const item = itemWithReviewTags()
    resetReviewTagsOnFix(item, { fixedSourcePhases: ["quality"], exemptSourcePhases: [], touchedQualityDims: ["style", "architecture"] })
    expect(getStepVerdict(item, "verify_quality", "openspec-reviewer-style")).toBe("pending")
    expect(getStepVerdict(item, "verify_quality", "openspec-reviewer-architecture")).toBe("pending")
    expect(getStepVerdict(item, "verify_quality", "openspec-reviewer-performance")).toBe("passed")
  })

  test("纯豁免（exempt 仅 quality 层，无 tool/task 层代码变更）→ 不清 verify_tool/verify_task", () => {
    const item = itemWithReviewTags()
    resetReviewTagsOnFix(item, { fixedSourcePhases: [], exemptSourcePhases: ["quality"], touchedQualityDims: ["security"] })
    expect(getStepVerdict(item, "verify_tool", "openspec-reviewer-tool")).toBe("passed")
    expect(getStepVerdict(item, "verify_task", "openspec-reviewer-task")).toBe("passed")
    expect(getStepVerdict(item, "verify_quality", "openspec-reviewer-security")).toBe("pending")
  })

  test("空输入不产生任何变化", () => {
    const item = itemWithReviewTags()
    const snapshot = JSON.stringify(item.tags)
    resetReviewTagsOnFix(item, { fixedSourcePhases: [], exemptSourcePhases: [], touchedQualityDims: [] })
    expect(JSON.stringify(item.tags)).toBe(snapshot)
  })
})

describe("2. dedupeNewChildren 去重", () => {
  test("与未终态 child 按归因字段判重 → 丢弃并计数", () => {
    const item = makeItem()
    const existing = issueChild({ id: "1", metadata: { source_phase: "tool", dimension: "style", file: "src/a.java", line: 10 } })
    existing.description = "重复描述"
    item.children.push(existing)

    const dup = issueChild({ id: "2", metadata: { source_phase: "tool", dimension: "style", file: "src/a.java", line: 10 } })
    dup.description = "重复描述"
    const fresh = issueChild({ id: "3", metadata: { source_phase: "task", dimension: "style", file: "src/b.java", line: 5 } })

    const { accepted, dedupedCount } = dedupeNewChildren(item, [dup, fresh])
    expect(accepted.map((c) => c.externalId)).toEqual(["3"])
    expect(dedupedCount).toBe(1)
  })

  test("sourcePhase/dimension/file/line 任一不同 → 不判重", () => {
    const item = makeItem()
    const existing = issueChild({ id: "1", metadata: { source_phase: "tool", dimension: "style", file: "src/a.java", line: 10 } })
    item.children.push(existing)

    const sameDesc = (m: Record<string, unknown>) => {
      const c = issueChild({ metadata: m })
      c.description = existing.description
      return c
    }
    const variants = [
      sameDesc({ source_phase: "task", dimension: "style", file: "src/a.java", line: 10 }),
      sameDesc({ source_phase: "tool", dimension: "security", file: "src/a.java", line: 10 }),
      sameDesc({ source_phase: "tool", dimension: "style", file: "src/b.java", line: 10 }),
      sameDesc({ source_phase: "tool", dimension: "style", file: "src/a.java", line: 11 }),
    ]
    const { accepted, dedupedCount } = dedupeNewChildren(item, variants)
    expect(accepted.length).toBe(4)
    expect(dedupedCount).toBe(0)
  })

  test("已终态 child 不参与判重（允许 reviewer 重报已关闭问题）", () => {
    const item = makeItem()
    const doneChild = issueChild({ id: "1", metadata: { source_phase: "tool", dimension: "style", file: "src/a.java", line: 10 } })
    doneChild.phase = "done"
    item.children.push(doneChild)

    const reReported = issueChild({ id: "2", metadata: { source_phase: "tool", dimension: "style", file: "src/a.java", line: 10 } })
    reReported.description = doneChild.description
    const { accepted, dedupedCount } = dedupeNewChildren(item, [reReported])
    expect(accepted.length).toBe(1)
    expect(dedupedCount).toBe(0)
  })
})

describe("3. resolveChildIssueFields 报源层反推（source → source_phase 兜底 → tool）", () => {
  test("source 为 quality reviewer → 反推 quality，source_phase 值被忽略（source 优先）", () => {
    const child = issueChild({ metadata: { source: "openspec-reviewer-architecture", source_phase: "tool", dimension: "architecture" } })
    expect(resolveChildIssueFields(child).sourcePhase).toBe("quality")
  })

  test("source 为 tool/task reviewer → 反推 tool/task", () => {
    const tool = issueChild({ metadata: { source: "openspec-reviewer-tool", source_phase: "quality" } })
    expect(resolveChildIssueFields(tool).sourcePhase).toBe("tool")
    const task = issueChild({ metadata: { source: "openspec-reviewer-task" } })
    expect(resolveChildIssueFields(task).sourcePhase).toBe("task")
  })

  test("source 缺失/不可反推 → 回退 source_phase（历史 state 兼容）", () => {
    const legacy = issueChild({ metadata: { source_phase: "quality", dimension: "security" } })
    expect(resolveChildIssueFields(legacy).sourcePhase).toBe("quality")
  })

  test("source 与 source_phase 均不可用 → 缺省 tool", () => {
    const child = createInitialWorkItem({
      id: "issue:x", source: "openspec", type: "issue", title: "t", description: "d", severity: "Low",
    })
    expect(resolveChildIssueFields(child).sourcePhase).toBe("tool")
    expect(resolveChildIssueFields(child).dimension).toBe("style")
  })
})

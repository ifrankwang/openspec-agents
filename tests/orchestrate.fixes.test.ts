/**
 * 修复项测试（新流单轨改写）：
 * 2+3: 任务 rejectReason 清除（verify_task rejected → implement 重提 → verify_task verified）
 * 4: resetReviewTagsOnFix 分层重置精确性（tool 层遗留不影响 quality 层）
 * 6: dedupeNewChildren 跨层去重区分 sourcePhase
 */
import { describe, expect, test, afterAll } from "bun:test"
import { writeFileSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import { agent_submit } from "../src/adapters/opencode/tools"
import { setupWithFakeGit, teardown, readState } from "./helpers"
import {
  setupToAnalyze, driveToVerifyTask, taskListOf, taskItemOf,
} from "./helpers-workflow"
import { createInitialWorkItem, isTerminalPhase } from "../src/core/workflow/engine"
import { resetReviewTagsOnFix, dedupeNewChildren } from "../src/core/workflow/reset"
import { tagKey } from "../src/core/workflow/types"

const CID = "test-fixes"

afterAll(() => { __setGitRunner(null) })

/** 直接改写 state 的 review tag（模拟编排在任务驳回后重置复核标记，等价 checkpoint continue 清 tag）。 */
function clearReviewTags(wt: string): void {
  const p = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  const item = state.workItems.find((w: any) => w.id === "task:1")
  for (const key of Object.keys(item.tags)) {
    if (key.startsWith("verify_")) delete item.tags[key]
  }
  writeFileSync(p, JSON.stringify(state, null, 2))
}

// ─── 修复项 2+3: 任务 rejectReason 清除 ───

describe("修复项2+3: implement/verify_task 后 rejectReason 清除", () => {
  test("verify_task rejected（rejectReason 落盘）→ implement 重提清除 → verify_task verified 保持清除", async () => {
    const root = `/tmp/fix23-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      const { item: preTask } = await driveToVerifyTask(wt, CID)

      // verify_task 驳回 task 1
      const rReject = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "failed",
          verified_tasks: taskListOf(preTask).filter((t: any) => t.id !== "1").map((t: any) => t.id),
          failed_tasks: [{ task_id: "1", reason: "Incomplete" }],
        },
        ctx.taskR
      )
      expect(rReject).toContain("failed")

      let item = taskItemOf(readState(wt, CID)!)
      let t1 = taskListOf(item).find((t: any) => t.id === "1")
      expect(t1.status).toBe("rejected")
      expect(t1.rejectReason).toBe("Incomplete")
      // 驳回触发 on_fail 回 implement
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")

      // dev 重提被驳回的 task → status submitted + rejectReason 清除
      const rDev = await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1"] },
        ctx.dev
      )
      expect(rDev).toContain("passed")
      item = taskItemOf(readState(wt, CID)!)
      t1 = taskListOf(item).find((t: any) => t.id === "1")
      expect(t1.status).toBe("submitted")
      expect(t1.rejectReason).toBeNull()

      // 任务驳回回退不触发 issue 分层重置（无 fixed_issue_ids），旧 review tag 仍在；
      // 模拟编排重置复核标记后重走 verify_tool → verify_task，验证 verified 且 rejectReason 保持清除
      clearReviewTags(wt)
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)
      const rVerify = await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_task", verdict: "passed",
          verified_tasks: taskListOf(taskItemOf(readState(wt, CID)!)).map((t: any) => t.id),
        },
        ctx.taskR
      )
      expect(rVerify).toContain("passed")
      item = taskItemOf(readState(wt, CID)!)
      t1 = taskListOf(item).find((t: any) => t.id === "1")
      expect(t1.status).toBe("verified")
      expect(t1.rejectReason).toBeNull()
    } finally { teardown(root) }
  })
})

// ─── 修复项 4: resetReviewTagsOnFix 分层重置精确性 ───

describe("修复项4: resetReviewTagsOnFix 分层重置（tool 层遗留不影响 quality 层）", () => {
  function itemWithReviewTags(): any {
    const item = createInitialWorkItem({
      id: "task:1", source: "openspec", externalId: "1", type: "task",
      title: "G1", description: "G1",
    })
    item.tags[tagKey("verify_tool", "openspec-reviewer-tool")] = "passed"
    item.tags[tagKey("verify_task", "openspec-reviewer-task")] = "passed"
    item.tags[tagKey("verify_quality", "openspec-reviewer-style")] = "passed"
    item.tags[tagKey("verify_quality", "openspec-reviewer-architecture")] = "passed"
    return item
  }

  test("tool 层修复仅重置 verify_tool，verify_task/quality 不受影响", () => {
    const item = itemWithReviewTags()
    resetReviewTagsOnFix(item, { fixedSourcePhases: ["tool"], exemptSourcePhases: [], touchedQualityDims: [] })
    expect(item.tags[tagKey("verify_tool", "openspec-reviewer-tool")]).toBeUndefined()
    expect(item.tags[tagKey("verify_task", "openspec-reviewer-task")]).toBe("passed")
    expect(item.tags[tagKey("verify_quality", "openspec-reviewer-style")]).toBe("passed")
  })

  test("quality 层修复仅重置对应维度 quality tag（其余维度不受影响）", () => {
    const item = itemWithReviewTags()
    resetReviewTagsOnFix(item, {
      fixedSourcePhases: ["quality"], exemptSourcePhases: [], touchedQualityDims: ["style"],
    })
    expect(item.tags[tagKey("verify_quality", "openspec-reviewer-style")]).toBeUndefined()
    expect(item.tags[tagKey("verify_quality", "openspec-reviewer-architecture")]).toBe("passed")
    // 任一代码变更都要求 tool 层确定性检查重跑
    expect(item.tags[tagKey("verify_tool", "openspec-reviewer-tool")]).toBeUndefined()
  })

  test("task 层豁免重置 verify_tool + verify_task", () => {
    const item = itemWithReviewTags()
    resetReviewTagsOnFix(item, { fixedSourcePhases: [], exemptSourcePhases: ["task"], touchedQualityDims: [] })
    expect(item.tags[tagKey("verify_tool", "openspec-reviewer-tool")]).toBeUndefined()
    expect(item.tags[tagKey("verify_task", "openspec-reviewer-task")]).toBeUndefined()
    expect(item.tags[tagKey("verify_quality", "openspec-reviewer-style")]).toBe("passed")
  })
})

// ─── 修复项 6: dedupeNewChildren 跨层去重区分 sourcePhase ───

describe("修复项6: dedupeNewChildren 跨层去重区分 sourcePhase", () => {
  function issueChild(sourcePhase: string, overrides: Record<string, unknown> = {}): any {
    const c = createInitialWorkItem({
      id: "issue:9", source: "openspec", externalId: "9", type: "issue",
      title: "dup", description: "dup desc", severity: "Low",
    })
    c.metadata["source_phase"] = sourcePhase
    c.metadata["dimension"] = "style"
    c.metadata["file"] = "src/Dup.java"
    c.metadata["line"] = 10
    for (const [k, v] of Object.entries(overrides)) c.metadata[k] = v
    return c
  }

  test("同 file/line/description 不同 sourcePhase 不去重", () => {
    const item = createInitialWorkItem({
      id: "task:1", source: "openspec", externalId: "1", type: "task",
      title: "G1", description: "G1",
    })
    item.children.push(issueChild("tool"))

    const { accepted, dedupedCount } = dedupeNewChildren(item, [issueChild("quality")])
    expect(dedupedCount).toBe(0)
    expect(accepted).toHaveLength(1)
    expect(accepted[0].metadata["source_phase"]).toBe("quality")
  })

  test("同 file/line/description 同 sourcePhase 去重", () => {
    const item = createInitialWorkItem({
      id: "task:1", source: "openspec", externalId: "1", type: "task",
      title: "G1", description: "G1",
    })
    item.children.push(issueChild("tool"))

    const { accepted, dedupedCount } = dedupeNewChildren(item, [issueChild("tool")])
    expect(dedupedCount).toBe(1)
    expect(accepted).toHaveLength(0)
  })

  test("已终态 child 不参与判重（reviewer 可重报已关闭问题）", () => {
    const item = createInitialWorkItem({
      id: "task:1", source: "openspec", externalId: "1", type: "task",
      title: "G1", description: "G1",
    })
    const closed = issueChild("tool")
    closed.phase = "done"
    item.children.push(closed)

    const { accepted, dedupedCount } = dedupeNewChildren(item, [issueChild("tool")])
    expect(dedupedCount).toBe(0)
    expect(accepted).toHaveLength(1)
  })
})

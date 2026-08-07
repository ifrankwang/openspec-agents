/**
 * 参数归一化测试（新流 agent_submit 改写）：
 * N1: issue id 的 # 前缀归一化（fixed_issue_ids / exempt_issue_ids / exempt_adjudications 均接受带 # 的 tg.issue 序号引用）
 * N2: taskNumber → 数字 id 映射（implement completed_task_ids / verify_task verified_tasks）
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import { agent_submit } from "../src/adapters/opencode/tools"
import { setupWithFakeGit, teardown, readState } from "./helpers"
import {
  setupToAnalyze, driveToVerifyTool, driveToQuality,
  taskListOf, taskItemOf, taskIdsOf, rollbackQuality,
} from "./helpers-workflow"
import { taskGroupFromWorkItem } from "../src/core/derive"

const CID = "test-norm"
afterAll(() => { __setGitRunner(null) })

/** 构造 2 子任务 tasks.md（N2 用：1.1/1.2 全部覆盖，避免 setupWorkspace 的 3 任务漏覆盖门禁）。 */
function buildTwoTaskWt(wt: string): void {
  writeFileSync(
    join(wt, "openspec", "changes", CID, "tasks.md"),
    `## 1. G1\n\n- [ ] 1.1 T1\n- [ ] 1.2 T2\n`,
    "utf-8"
  )
}

const EB = { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }

// ── 1: issue id # 前缀归一化 ──

describe("N1. issue id # 前缀归一化", () => {
  test("dev fixed_issue_ids 带 # → 解析到 child 置 done，issue 同步 verified", async () => {
    const root = `/tmp/norm-fixed-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        ctx.arch
      )
      const item0 = taskItemOf(readState(wt, CID)!)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: taskIdsOf(item0) },
        ctx.dev
      )

      // tool 层报 Low issue → 回 implement，child 落盘 todo
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [{ id: "7", title: "Tool issue", description: "工具层问题", severity: "Low", dimension: "style" }],
        },
        ctx.toolR
      )
      expect(taskItemOf(readState(wt, CID)!).currentStep).toBe("implement")

      // dev 用 # 前缀修复
      const item1 = taskItemOf(readState(wt, CID)!)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "passed",
          completed_task_ids: taskIdsOf(item1), fixed_issue_ids: ["#7"],
        },
        ctx.dev
      )
      const item = taskItemOf(readState(wt, CID)!)
      const child = item.children.find((c: any) => c.externalId === "7")
      expect(child.phase).toBe("review")
      // issue 投影回 tg.issues → submitted（review 态 = 待复核，未终态）
      expect(taskGroupFromWorkItem(item).issues.find((i: any) => i.id === "7")?.status).toBe("submitted")
      // 修复后推进到 verify_tool 且 verify_tool tag 被重置（可重验）
      expect(item.currentStep).toBe("verify_tool")
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("dev exempt_issue_ids 带 # + 裁定 exempt_adjudications 带 # → child cancelled + issue exempted", async () => {
    const root = `/tmp/norm-exempt-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      const { item: preQ } = await driveToQuality(wt, CID)

      // style 维度报 Low issue → 其余维度通过后聚合回退 implement
      await rollbackQuality(ctx, CID, {
        failedDim: "style",
        newChildren: [{ id: "7", title: "不可修 issue", description: "第三方库限制", severity: "Low", dimension: "style" }],
      })
      expect(taskItemOf(readState(wt, CID)!).currentStep).toBe("implement")

      // dev 用 # 前缀申请豁免 → step 不推进
      const item1 = taskItemOf(readState(wt, CID)!)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: taskIdsOf(item1), exempt_issue_ids: ["#7"] },
        ctx.dev
      )
      let item = taskItemOf(readState(wt, CID)!)
      let child = item.children.find((c: any) => c.externalId === "7")
      expect(child.metadata["exempt_request"]).toBeDefined()
      // 豁免申请进入 review（待裁定），推进到 review/verify_quality（style 维 tag 按归因清空待重审）
      expect(item.currentStep).toBe("verify_quality")

      // 模拟编排将任务移回 review/verify_quality 供豁免复核
      const p = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
      const state = JSON.parse(require("node:fs").readFileSync(p, "utf-8"))
      const wi = state.workItems.find((w: any) => w.id === "task:1")
      wi.phase = "review"
      wi.currentStep = "verify_quality"
      require("node:fs").writeFileSync(p, JSON.stringify(state, null, 2))

      // quality（style）用 # 前缀裁定 dismissed
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "passed",
          exempt_adjudications: [{ issue_id: "#7", action: "dismissed" }],
        },
        ctx.dims["style"]
      )
      item = taskItemOf(readState(wt, CID)!)
      child = item.children.find((c: any) => c.externalId === "7")
      expect(child.phase).toBe("cancelled")
      expect(taskGroupFromWorkItem(item).issues.find((i: any) => i.id === "7")?.status).toBe("exempted")
    } finally { teardown(root) }
  })

  test("quality 层 issue dev 用 # 修复 → 对应维度 verify_quality tag 被重置", async () => {
    const root = `/tmp/norm-qfix-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      const { item: preQ } = await driveToQuality(wt, CID)
      expect(preQ.currentStep).toBe("verify_quality")

      // style 维度报 Low issue → 其余维度通过后聚合回退 implement
      await rollbackQuality(ctx, CID, {
        failedDim: "style",
        newChildren: [{ id: "7", title: "Style issue", description: "质量层问题", severity: "Low", dimension: "style" }],
      })

      // dev 用 # 修复 quality 层 issue
      const item1 = taskItemOf(readState(wt, CID)!)
      await agent_submit.execute(
        {
          change_id: CID, step_id: "implement", verdict: "passed",
          completed_task_ids: taskIdsOf(item1), fixed_issue_ids: ["#7"],
        },
        ctx.dev
      )
      const item = taskItemOf(readState(wt, CID)!)
      const child = item.children.find((c: any) => c.externalId === "7")
      expect(child.phase).toBe("review")
      // 修复按归因分层重置：仅 style 维度 quality tag 清除，其余已 passed 维度保留
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBeUndefined()
      expect(item.tags["verify_quality:openspec-reviewer-architecture"]).toBe("passed")
      expect(item.currentStep).toBe("verify_tool")
    } finally { teardown(root) }
  })
})

// ── 2: taskNumber → 数字 id 映射 ──

describe("N2. taskNumber 映射", () => {
  test("dev completed_task_ids 传任务编号 1.1/1.2 → 映射为数字 id 并全部提交", async () => {
    const root = `/tmp/norm-devnum-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      buildTwoTaskWt(wt)
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        ctx.arch
      )

      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1.1", "1.2"] },
        ctx.dev
      )
      const item = taskItemOf(readState(wt, CID)!)
      expect(taskListOf(item).every((t: any) => t.status === "submitted")).toBe(true)
    } finally { teardown(root) }
  })

  test("verify_task verified_tasks 传任务编号 → 映射并验证通过", async () => {
    const root = `/tmp/norm-verifynum-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      buildTwoTaskWt(wt)
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        ctx.arch
      )
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2"] },
        ctx.dev
      )
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)

      await agent_submit.execute(
        { change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["1.1", "1.2"] },
        ctx.taskR
      )
      const item = taskItemOf(readState(wt, CID)!)
      expect(taskListOf(item).every((t: any) => t.status === "verified")).toBe(true)
    } finally { teardown(root) }
  })

  test("非法 taskNumber → 报错", async () => {
    const root = `/tmp/norm-badnum-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      buildTwoTaskWt(wt)
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
        ctx.arch
      )

      // dev 层：非法编号
      await expect(
        agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["9.9"] }, ctx.dev)
      ).rejects.toThrow(/无效 task id/)

      // task 层：非法编号
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2"] },
        ctx.dev
      )
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)
      await expect(
        agent_submit.execute({ change_id: CID, step_id: "verify_task", verdict: "passed", verified_tasks: ["9.9"] }, ctx.taskR)
      ).rejects.toThrow(/非法 task id/)
    } finally { teardown(root) }
  })
})

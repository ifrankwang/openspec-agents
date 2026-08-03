/**
 * M1e-2a 新流测试基建自测。
 *
 * 验证 tests/helpers-workflow.ts 的驱动助手能真实推进状态机：
 * - setupToAnalyze：todo/analyze
 * - driveToImplement：in_progress/implement（analyze passed）
 * - driveToVerifyTool：review/verify_tool（implement passed）
 * - driveToVerifyTask / driveToQuality：逐层推进到 review/verify_quality
 * - 投影助手：taskItemOf/taskListOf/blockersOf/metaOf
 * - 参数门禁：execution_boundary / completed_task_ids / verified_tasks 自动补齐
 */
import { describe, expect, test, afterAll } from "bun:test"
import { rmSync } from "node:fs"
import { __setGitRunner } from "../src/core/git"
import { setupWithFakeGit, teardown } from "./helpers"
import {
  setupToAnalyze, driveToImplement, driveToVerifyTool,
  driveToVerifyTask, driveToQuality, submitQualityPassed,
  taskItemOf, taskListOf, blockersOf, metaOf, readItem,
} from "./helpers-workflow"

const CID = "helpers-wf"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string } {
  const root = `/tmp/opxhelpers-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree } = setupWithFakeGit(root, CID)
  return { wt: worktree, root }
}

describe("WorkItem 投影助手", () => {
  test("taskItemOf/taskListOf/blockersOf/metaOf 纯投影", () => {
    const state = {
      workItems: [{
        id: "task:1", metadata: {
          tasks: [{ id: "1", status: "open" }, { id: "2", status: "open" }],
          blockers: [{ id: "b1", status: "awaiting_user" }],
          execution_boundary: { allowed_directories: ["src"] },
        },
      }],
    }
    const item = taskItemOf(state, "1")
    expect(item.id).toBe("task:1")
    expect(taskListOf(item)).toHaveLength(2)
    expect(blockersOf(item)).toHaveLength(1)
    expect(metaOf(item, "execution_boundary")).toEqual({ allowed_directories: ["src"] })
    // 缺省 groupId="1"；缺失字段返回空
    expect(taskItemOf(state)).toBe(item)
    expect(taskListOf({})).toEqual([])
    expect(blockersOf({})).toEqual([])
    expect(metaOf({}, "x")).toBeUndefined()
  })
})

describe("阶段驱动助手", () => {
  test("setupToAnalyze：todo/analyze，workItems 构造", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      expect(ctx.orch.agent).toBe("openspec-orchestrator")
      expect(ctx.arch.agent).toBe("openspec-architect")
      expect(ctx.dev.agent).toBe("openspec-developer")
      expect(ctx.toolR.agent).toBe("openspec-reviewer-tool")
      expect(ctx.taskR.agent).toBe("openspec-reviewer-task")
      expect(ctx.dims["style"].agent).toBe("openspec-reviewer-style")

      const item = readItem(wt, CID)
      expect(item.phase).toBe("todo")
      expect(item.currentStep).toBe("analyze")
    } finally { teardown(root) }
  })

  test("driveToImplement：in_progress/implement，analyze passed 落地", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx, item } = await driveToImplement(wt, CID)
      expect(ctx.dev.agent).toBe("openspec-developer")
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      expect(taskListOf(item).every((t: any) => t.status === "open")).toBe(true)
    } finally { teardown(root) }
  })

  test("driveToVerifyTool：review/verify_tool，tasks 全 submitted", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx, item } = await driveToVerifyTool(wt, CID)
      expect(ctx.toolR.agent).toBe("openspec-reviewer-tool")
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_tool")
      expect(taskListOf(item).every((t: any) => t.status === "submitted")).toBe(true)
    } finally { teardown(root) }
  })

  test("driveToVerifyTask：review/verify_task", async () => {
    const { wt, root } = fresh()
    try {
      const { item } = await driveToVerifyTask(wt, CID)
      expect(item.currentStep).toBe("verify_task")
    } finally { teardown(root) }
  })

  test("driveToQuality + submitQualityPassed：推进到 verify_quality 后 5 维提交到 done", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx, item } = await driveToQuality(wt, CID)
      expect(item.currentStep).toBe("verify_quality")

      await submitQualityPassed(ctx, CID)
      const done = readItem(wt, CID)
      expect(done.phase).toBe("done")
      expect(done.currentStep).toBeNull()
    } finally { teardown(root) }
  })

  test("recovery=dev_impl：setupToAnalyze 后直接到 in_progress/implement", async () => {
    const { wt, root } = fresh()
    try {
      // 先初始化到 analyze，再带 recovery 重新初始化
      await setupToAnalyze(wt, CID)
      const ctx = await setupToAnalyze(wt, CID, { recovery: { phase: "dev_impl" } })
      const item = readItem(wt, CID)
      expect(ctx.dev.agent).toBe("openspec-developer")
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
    } finally { teardown(root) }
  })

  test("自定义 completedTaskIds：覆盖 setupWorkspace 的 3 个 task", async () => {
    const { wt, root } = fresh()
    try {
      const { item } = await driveToVerifyTool(wt, CID, { completedTaskIds: ["1", "2", "3"] })
      expect(item.currentStep).toBe("verify_tool")
      expect(taskListOf(item).every((t: any) => t.status === "submitted")).toBe(true)
    } finally { teardown(root) }
  })
})

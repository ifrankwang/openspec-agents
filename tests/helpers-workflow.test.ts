/**
 * M1e-2a 新流测试基建自测。
 *
 * 验证 tests/helpers-workflow.ts 的驱动助手能真实推进状态机（新流语义：首轮即 implement）：
 * - setupToImplement：in_progress/implement（analyze 仅 blocker 回退落点，不再是首轮步骤）
 * - driveToImplement：init 后即 implement，无 analyze 提交
 * - driveToVerifyTool：review/verify_tool（implement passed）
 * - driveToVerifyTask / driveToQuality：逐层推进到 review/verify_quality
 * - 投影助手：taskItemOf/taskListOf/blockersOf/metaOf
 * - 参数门禁：execution_boundary（clarify.md 夹具）/ completed_task_ids / verified_tasks 自动补齐
 */
import { describe, expect, test, afterAll } from "bun:test"
import { __setGitRunner } from "../src/core/git"
import { setupWithFakeGit, teardown } from "./helpers"
import {
  setupToImplement, setupToAnalyze, driveToImplement, driveToVerifyTool,
  driveToVerifyTask, driveToQuality, submitQualityPassed, submitCleanupPassed,
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
        id: "task:1",
        metadata: {
          blockers: [{ id: "b1", status: "awaiting_user" }],
          execution_boundary: { allowed_directories: ["src"] },
        },
        children: [
          { id: "1", type: "task", title: "T1", phase: "todo", externalId: "1.1", metadata: {} },
          { id: "2", type: "task", title: "T2", phase: "review", externalId: "1.2", metadata: {} },
        ],
      }],
    }
    const item = taskItemOf(state, "1")
    expect(item.id).toBe("task:1")
    expect(taskListOf(item)).toHaveLength(2)
    expect(taskListOf(item)[0].status).toBe("open")
    expect(taskListOf(item)[1].status).toBe("submitted")
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
  test("setupToImplement：init 直接落 in_progress/implement，workItems 构造", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToImplement(wt, CID)
      expect(ctx.orch.agent).toBe("primary")
      expect(ctx.orch.orchestrator).toBe(true)
      expect(ctx.arch.agent).toBe("openspec-architect")
      expect(ctx.dev.agent).toBe("openspec-developer")
      expect(ctx.toolR.agent).toBe("openspec-reviewer-tool")
      expect(ctx.taskR.agent).toBe("openspec-reviewer-task")
      expect(ctx.dims["style"].agent).toBe("openspec-reviewer-style")

      const item = readItem(wt, CID)
      // 新流：初始化落点不再是 todo/analyze（analyze 仅 blocker 回退落点）
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
    } finally { teardown(root) }
  })

  test("setupToAnalyze 为兼容别名：同样落 implement", async () => {
    const { wt, root } = fresh()
    try {
      await setupToAnalyze(wt, CID)
      const item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
    } finally { teardown(root) }
  })

  test("driveToImplement：in_progress/implement，tasks 全 open", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx, item } = await driveToImplement(wt, CID)
      expect(ctx.dev.agent).toBe("openspec-developer")
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      expect(taskListOf(item).every((t: any) => t.status === "open")).toBe(true)
    } finally { teardown(root) }
  })

  test("driveToImplement + clarify.md 边界夹具：metadata.execution_boundary 落地", async () => {
    const { wt, root } = fresh()
    try {
      const boundary = { allowed_directories: ["src/core"], allowed_packages: ["src/core/x"], notes: "限定核心目录" }
      const { item } = await driveToImplement(wt, CID, { boundary })
      expect(metaOf(item, "execution_boundary")).toEqual(boundary)
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

  test("driveToQuality + submitQualityPassed：推进到 verify_quality 后 5 维提交到 verify_cleanup，收尾验证后 done", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx, item } = await driveToQuality(wt, CID)
      expect(item.currentStep).toBe("verify_quality")

      await submitQualityPassed(ctx, CID)
      const atCleanup = readItem(wt, CID)
      expect(atCleanup.phase).toBe("review")
      expect(atCleanup.currentStep).toBe("verify_cleanup")

      await submitCleanupPassed(ctx, CID)
      const done = readItem(wt, CID)
      expect(done.phase).toBe("done")
      expect(done.currentStep).toBeNull()
    } finally { teardown(root) }
  })

  test("recovery=dev_impl：重复 init 带恢复参数仍落 in_progress/implement", async () => {
    const { wt, root } = fresh()
    try {
      await setupToImplement(wt, CID)
      const ctx = await setupToImplement(wt, CID, { recovery: { phase: "dev_impl" } })
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

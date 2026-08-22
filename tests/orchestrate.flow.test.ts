/**
 * 编排流程测试（M1e 新流单轨精简版）
 *
 * 旧流 19 组场景语义（happy path / 豁免 / recovery / 多任务组 / checkpoint /
 * boundary_expansion）已由 opx_agent_submit / orchestrate.guards /
 * opx_status_workflow / orchestrate.optimize 等新流测试文件覆盖，本文件只保留：
 * 1. init 相关绿用例（base_branch 自动推导 / 显式 base_branch / detached HEAD /
 *    isolationNamespace 生成与补全）——直接测 init 工具，与新流相关
 * 2. 新流完整端到端 happy path 回归（init→analyze→implement→verify_tool→verify_task→
 *    verify_quality→verify_cleanup→done→complete_task_group），覆盖全流程状态机推进
 *
 * 驱动统一走 helpers-workflow（经 opx_agent_submit 推进状态机），
 * 状态断言走 readItem / taskListOf / metadata。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { generateIsolationNamespace } from "../src/core/namespace"
import { init, set_worktree, complete_task_group } from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx, makeOrchCtx, setupWithFakeGit, teardown } from "./helpers"
import {
  setupToAnalyze, driveToQuality, submitQualityPassed, submitCleanupPassed, readItem, taskListOf,
} from "./helpers-workflow"

const CID = "test-flow"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/flow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID)
  return { wt: worktree, root, fakeGit }
}

function stateOf(wt: string): any {
  const p = join(wt, "openspec", "states", `${CID}.json`)
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null
}

describe("init 基础行为（base_branch 推导 / isolationNamespace）", () => {
  test("init 无 base_branch 自动推导当前分支", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.currentBranch = "develop"
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, o)
      expect(stateOf(wt).baseBranch).toBe("develop")
    } finally { teardown(root) }
  })

  test("init 显式传 base_branch 正确使用", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1", mode: "full", base_branch: "release/1.0" }, o)
      expect(stateOf(wt).baseBranch).toBe("release/1.0")
    } finally { teardown(root) }
  })

  test("init detached HEAD 报错", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.currentBranch = "HEAD"
      const o = makeOrchCtx(wt)
      const err = await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, o).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/detached HEAD|显式.*base_branch/)
    } finally { teardown(root) }
  })

  test("新建 init 生成确定性的 isolationNamespace", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, o)
      expect(stateOf(wt).isolationNamespace).toBe(generateIsolationNamespace(CID))
      expect(stateOf(wt).isolationNamespace).toMatch(/^[0-9a-f]{6}$/)
    } finally { teardown(root) }
  })

  test("旧 state 缺 isolationNamespace 时 init 补全；既有值保留", async () => {
    const { wt, root } = fresh()
    try {
      const stateDir = join(wt, "openspec", "states")
      mkdirSync(stateDir, { recursive: true })
      const legacyState = {
        changeId: CID,
        taskGroupId: "1",
        baseBranch: "main",
        taskGroups: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      writeFileSync(join(stateDir, `${CID}.json`), JSON.stringify(legacyState))

      const o = makeOrchCtx(wt)
      // 旧 state 缺 mode：不传 mode 继续沿用（读取时兜底 full，不写回）
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      expect(stateOf(wt).isolationNamespace).toBe(generateIsolationNamespace(CID))

      const s = stateOf(wt)
      s.isolationNamespace = "custom-ns"
      writeFileSync(join(stateDir, `${CID}.json`), JSON.stringify(s))
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      expect(stateOf(wt).isolationNamespace).toBe("custom-ns")
    } finally { teardown(root) }
  })
})

describe("新流端到端 happy path", () => {
  test("init→analyze→implement→verify_tool→verify_task→verify_quality→verify_cleanup→done→complete_task_group", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      expect(readItem(wt, CID).phase).toBe("todo")
      expect(readItem(wt, CID).currentStep).toBe("analyze")

      await set_worktree.execute({ change_id: CID }, ctx.orch)

      const { item } = await driveToQuality(wt, CID)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("verify_quality")

      await submitQualityPassed(ctx, CID)
      expect(readItem(wt, CID).phase).toBe("review")
      expect(readItem(wt, CID).currentStep).toBe("verify_cleanup")

      await submitCleanupPassed(ctx, CID)
      const done = readItem(wt, CID)
      expect(done.phase).toBe("done")
      expect(done.currentStep).toBeNull()
      expect(taskListOf(done).every((t: any) => t.status === "verified")).toBe(true)

      const r = await complete_task_group.execute({ change_id: CID }, ctx.orch)
      expect(r).toContain("任务组已完成并合并到")
      expect(readItem(wt, CID).metadata["completed_at"]).toBeDefined()
      expect(fakeGit.mergedBranches).toContain("task-group/test-flow/1")
    } finally { teardown(root) }
  })
})

/**
 * simple 模式生命周期测试（变更组 3.6）：
 * - 3.1 新建 item 初始 step 模式感知：simple init 后活跃组与非活跃组均落 in_progress/implement，
 *   无 phaseStepMismatch 状态异常（spec:workflow-mode#simple 流程步骤）
 * - 3.2 applyRecoveryState 模式感知：task_analysis / dev_impl 均落 in_progress/implement
 *   （task_analysis 重置 task children 全 todo，dev_impl 保留既有进度）；review 落
 *   review/quality_review——implement passed、quality_review failed tag 删除回 pending（passed 保留）、
 *   task children 缺省 done；reset_steps 按模式生效（simple 仅 quality_review，含该值时清空
 *   该 step 全部 tags），review_layer 在 simple 下接受但不生效（返回体警告）
 * - 收尾门禁保留：worktree 干净、blocking issue 终态、task 终态、blocker resolved
 * - 合并冲突返回 blocked 后 dev 解决冲突再重调 complete 完成收尾（spec:workflow-mode#收尾裸合并）
 */
import { describe, expect, test, afterAll } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { init, complete_task_group, agent_submit } from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx, makeOrchCtx, setupWorkspace, teardown, initSimpleWorktree } from "./helpers"
import { loadWorkflowFile, SIMPLE_WORKFLOW_PATH } from "../src/core/workflow/loader"
import { phaseStepMismatch } from "../src/core/workflow/engine"

const CID = "mode-lifecycle"
const DEV = "openspec-developer"
const REVIEWER = "openspec-reviewer"
const SIMPLE_WF = loadWorkflowFile(SIMPLE_WORKFLOW_PATH)

afterAll(() => { __setGitRunner(null) })

function fresh(): { root: string; wt: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/modelife-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const wt = setupWorkspace(root, CID)
  const fakeGit = new FakeGitRunner()
  __setGitRunner(fakeGit)
  return { root, wt, fakeGit }
}

function stateOf(wt: string): any {
  return JSON.parse(readFileSync(join(wt, "openspec", "states", `${CID}.json`), "utf-8"))
}

function writeState(wt: string, state: any): void {
  writeFileSync(join(wt, "openspec", "states", `${CID}.json`), JSON.stringify(state, null, 2))
}

function taskItemOf(wt: string): any {
  return stateOf(wt).workItems.find((w: any) => w.id === "task:1")
}

function rewriteItem(wt: string, fn: (item: any) => void): void {
  const state = stateOf(wt)
  fn(state.workItems.find((w: any) => w.id === "task:1"))
  writeState(wt, state)
}

/** 走完整 simple 流程到 done：implement passed → quality_review passed（全任务验证）→ done。 */
async function driveToDone(wt: string): Promise<void> {
  await agent_submit.execute(
    { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
    makeCtx(DEV, wt),
  )
  await agent_submit.execute(
    { change_id: CID, step_id: "quality_review", verdict: "passed", verified_tasks: ["1", "2", "3"] },
    makeCtx(REVIEWER, wt),
  )
  expect(taskItemOf(wt).phase).toBe("done")
}

describe("3.1 新建 item 初始 step 模式感知（无 phaseStepMismatch）", () => {
  test("simple init 后活跃组与非活跃组均落 in_progress/implement，phaseStepMismatch 恒 false", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      const state = stateOf(wt)
      // 3 个任务组全部初始化为 simple 初始态（含非活跃组 task:2 / task:3）
      for (const gid of ["1", "2", "3"]) {
        const item = state.workItems.find((w: any) => w.id === `task:${gid}`)
        expect(item).toBeDefined()
        expect(item.phase).toBe("in_progress")
        expect(item.currentStep).toBe("implement")
        expect(phaseStepMismatch(item, SIMPLE_WF)).toBe(false)
      }
    } finally { teardown(root) }
  })

  test("simple init 后 developer 状态视图可正常渲染（无状态异常拒绝）", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      const { status } = await import("../src/adapters/opencode/tools")
      const output = await status.execute({ change_id: CID }, makeCtx(DEV, wt))
      expect(output).toContain("# ✅ 当前轮到你执行")
      expect(output).not.toContain("状态异常")
      expect(output).toContain("implement")
    } finally { teardown(root) }
  })
})

describe("3.2 applyRecoveryState 模式感知：三阶段落位", () => {
  test("task_analysis → in_progress/implement + task children 全 todo（重置既有进度）+ tags 清空", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      // 注入既有进度：task child 1 置 review、item 残留 tags（恢复后应被清空）
      rewriteItem(wt, (item) => {
        item.children.find((c: any) => c.id === "1").phase = "review"
        item.tags["implement:openspec-developer"] = "passed"
      })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "task_analysis" } }, makeOrchCtx(wt))
      const item = taskItemOf(wt)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      expect(item.tags).toEqual({})
      // task children 全 todo（重置）
      for (const c of item.children.filter((c: any) => c.type === "task")) {
        expect(c.phase).toBe("todo")
      }
    } finally { teardown(root) }
  })

  test("dev_impl → in_progress/implement + task children 保留既有进度（无则 todo）", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      rewriteItem(wt, (item) => {
        item.children.find((c: any) => c.id === "1").phase = "review"
      })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "dev_impl" } }, makeOrchCtx(wt))
      const item = taskItemOf(wt)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      // 保留既有进度：child 1 仍 review，其余仍 todo
      const byId = new Map(item.children.filter((c: any) => c.type === "task").map((c: any) => [c.id, c]))
      expect(byId.get("1").phase).toBe("review")
      expect(byId.get("2").phase).toBe("todo")
      expect(byId.get("3").phase).toBe("todo")
    } finally { teardown(root) }
  })

  test("review → review/quality_review + implement passed + failed tag 删除回 pending + passed tag 保留", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      rewriteItem(wt, (item) => {
        item.phase = "review"
        item.currentStep = "quality_review"
        item.tags = {
          "implement:openspec-developer": "passed",
          "quality_review:openspec-reviewer": "failed",
        }
      })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review" } }, makeOrchCtx(wt))
      const item = taskItemOf(wt)
      expect(item.phase).toBe("review")
      expect(item.currentStep).toBe("quality_review")
      expect(item.tags["implement:openspec-developer"]).toBe("passed")
      // failed tag 删除回 pending（删除后 tag 键消失，审查者将被重派）
      expect(item.tags["quality_review:openspec-reviewer"]).toBeUndefined()
      expect(phaseStepMismatch(item, SIMPLE_WF)).toBe(false)
    } finally { teardown(root) }
  })

  test("review：quality_review passed tag 保留（已审查通过无需重跑）", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      rewriteItem(wt, (item) => {
        item.phase = "review"
        item.currentStep = "quality_review"
        item.tags = { "quality_review:openspec-reviewer": "passed" }
      })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review" } }, makeOrchCtx(wt))
      const item = taskItemOf(wt)
      expect(item.tags["implement:openspec-developer"]).toBe("passed")
      expect(item.tags["quality_review:openspec-reviewer"]).toBe("passed")
      expect(item.currentStep).toBe("quality_review")
    } finally { teardown(root) }
  })

  test("review：task children 缺省 done（无既有进度时新建 child 落 done）", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      // 移除全部 task children：recovery review 时按 tasks.md 重建，无既有进度 → 缺省 done
      rewriteItem(wt, (item) => {
        item.children = item.children.filter((c: any) => c.type !== "task")
      })
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review" } }, makeOrchCtx(wt))
      const tasks = taskItemOf(wt).children.filter((c: any) => c.type === "task")
      expect(tasks.length).toBe(3)
      for (const c of tasks) expect(c.phase).toBe("done")
    } finally { teardown(root) }
  })
})

describe("3.2 reset_steps / review_layer 在 simple 下按模式生效", () => {
  test("reset_steps: [quality_review] → quality_review tags 清空（passed 也清）、currentStep 落 quality_review、引擎重派 reviewer", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      // 注入「已通过但任务验证遗漏」的死锁残留态：quality_review passed + task child 卡 review
      rewriteItem(wt, (item) => {
        item.phase = "review"
        item.currentStep = "quality_review"
        item.tags = { "implement:openspec-developer": "passed", "quality_review:openspec-reviewer": "passed" }
        item.children.find((c: any) => c.id === "1").phase = "review"
      })
      await init.execute(
        { change_id: CID, task_group_id: "1", recovery: { phase: "review", reset_steps: ["quality_review"] } },
        makeOrchCtx(wt),
      )
      const item = taskItemOf(wt)
      expect(item.currentStep).toBe("quality_review")
      expect(item.tags["implement:openspec-developer"]).toBe("passed")
      // reset_steps 生效：quality_review 的 passed tag 也被清空（强制重审）
      expect(item.tags["quality_review:openspec-reviewer"]).toBeUndefined()
      expect(Object.keys(item.tags).some((k) => k.startsWith("verify_"))).toBe(false)
      // tag 清空后引擎重派 reviewer（recommend）
      const { recommendForItem } = await import("../src/core/workflow/engine")
      const rec = recommendForItem(item, SIMPLE_WF)
      expect(rec.status).toBe("recommend")
      expect(rec.stepId).toBe("quality_review")
      expect(rec.agents).toContain("openspec-reviewer")
    } finally { teardown(root) }
  })

  test("simple 下传 full 模式的 reset_steps 值 → 模式不匹配报错", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      const err = await init
        .execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review", reset_steps: ["verify_tool"] } }, makeOrchCtx(wt))
        .catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/verify_tool.*不属于当前会话形态（simple 模式）的审查 step/)
      const errQuality = await init
        .execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review", reset_steps: ["verify_quality"] } }, makeOrchCtx(wt))
        .catch((e: Error) => e)
      expect(errQuality).toBeInstanceOf(Error)
      expect(errQuality.message).toMatch(/verify_quality.*不属于当前会话形态（simple 模式）的审查 step/)
    } finally { teardown(root) }
  })

  test("review_layer: quality 接受但不生效，返回体含警告", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      const out = await init.execute(
        { change_id: CID, task_group_id: "1", recovery: { phase: "review", review_layer: "quality" } },
        makeOrchCtx(wt),
      )
      const item = taskItemOf(wt)
      expect(item.currentStep).toBe("quality_review")
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBeUndefined()
      // 返回体显式警告：simple 无 review 子层，该参数未生效
      expect(out).toContain("⚠️")
      expect(out).toContain("review_layer 参数未生效")
    } finally { teardown(root) }
  })

  test("非法 reset_steps 值仍报错（simple 模式值域校验）", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      const err = await init
        .execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review", reset_steps: ["bogus"] } }, makeOrchCtx(wt))
        .catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/reset_steps 中的 step "bogus" 不属于当前会话形态（simple 模式）/)
    } finally { teardown(root) }
  })

  test("dev_impl + review_layer 非法组合仍报错（组合校验不变）", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      const err = await init
        .execute({ change_id: CID, task_group_id: "1", recovery: { phase: "dev_impl", review_layer: "task" } }, makeOrchCtx(wt))
        .catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/review_layer 参数仅当 recovery.phase 为 review/)
    } finally { teardown(root) }
  })
})

describe("收尾门禁保留（completeTaskGroupExecute）", () => {
  test("worktree 不干净 → 拒绝收尾", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      fakeGit.dirtyPaths.add(join(wt, ".worktree", CID, "task-group-1"))
      const err = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt)).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未 commit 内容/)
      expect(taskItemOf(wt).metadata["completed_at"]).toBeUndefined()
    } finally { teardown(root) }
  })

  test("blocking issue 未终态 → 拒绝收尾", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      rewriteItem(wt, (item) => {
        item.children.push({
          id: "issue:i1", source: REVIEWER, externalId: "i1", type: "issue",
          title: "遗留问题", description: "desc", phase: "todo", suspended: false, currentStep: null,
          tags: {}, metadata: { source: REVIEWER, dimension: "style" },
          children: [], labels: [], severity: "High",
        })
      })
      const err = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt)).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未解决 issue/)
    } finally { teardown(root) }
  })

  test("task 未终态 → 拒绝收尾", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      rewriteItem(wt, (item) => {
        item.children.find((c: any) => c.id === "1").phase = "todo"
      })
      const err = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt)).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未完成 task/)
    } finally { teardown(root) }
  })

  test("blocker 未 resolved → 拒绝收尾；置 resolved 后放行", async () => {
    const { root, wt } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      rewriteItem(wt, (item) => {
        item.metadata["blockers"] = [{ id: "b1", status: "awaiting_user", category: "外部依赖", description: "d" }]
      })
      const err = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt)).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未解决 blocker/)
      // 置 resolved 后收尾放行
      rewriteItem(wt, (item) => {
        item.metadata["blockers"] = [{ id: "b1", status: "resolved", category: "外部依赖", description: "d" }]
      })
      const ok = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(ok).toContain("任务组已完成并合并到")
    } finally { teardown(root) }
  })

  test("全部门禁满足 → 收尾成功：分支合并、worktree 清理、completed_at 写入", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      // 主仓库检出非目标分支 → 目标分支无人检出，走 worktreeless 合并原路径
      fakeGit.currentBranch = "develop"
      const ok = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(ok).toContain("任务组已完成并合并到")
      const item = taskItemOf(wt)
      expect(item.metadata["completed_at"]).toBeDefined()
      // FakeGit 记录合并提交引用的源分支（commit-tree 消息）
      expect(fakeGit.mergeCommitBranches).toContain(`task-group/${CID}/1`)
      // worktree 与分支已清理
      expect(fakeGit.worktrees.has(join(wt, ".worktree", CID, "task-group-1"))).toBe(false)
    } finally { teardown(root) }
  })
})

describe("收尾裸合并：合并冲突由 dev 解决后直接收尾", () => {
  test("合并冲突返回 blocked（保留 worktree/分支）→ dev 解决冲突（重调 complete）→ 收尾完成", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      fakeGit.mergeTreeConflictOnNext = true
      const blocked = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(blocked).toContain("blocked")
      expect(blocked).toContain("merge_conflict")
      expect(blocked).toContain("未产生任何变更")
      // 冲突路径不写 completed_at、保留 worktree 与分支（供 dev 解决冲突）
      expect(taskItemOf(wt).metadata["completed_at"]).toBeUndefined()
      expect(fakeGit.worktrees.has(join(wt, ".worktree", CID, "task-group-1"))).toBe(true)
      // dev 在 worktree 内解决冲突并提交后，编排者重调 complete 完成收尾（裸合并、无额外验证）
      const ok = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(ok).toContain("任务组已完成并合并到")
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
    } finally { teardown(root) }
  })
})

/**
 * simple 模式端到端测试（变更组 6.3）：以 FakeGitRunner 驱动完整链路，覆盖
 * spec:workflow-mode（模式固化 / simple 三步流转 / implement 失败自循环 / 提交时工作区干净强检查 /
 * 收尾裸合并）与 spec:agent-identity（simple 审查者 issue 显式 dimension / 谁提谁裁定 / 名下清单可见）：
 *
 * 用例 1（happy path + 失败自循环 + 谁提谁裁定复核 + 收尾裸合并）：
 *   init 固化 simple → implement 工作区不干净拒绝（零状态变更）→ 干净后 passed 提交 →
 *   quality_review 清单可见（Task 待验证）→ 未声明 dimension 上报被拒 → 声明后 failed 上报成功
 *   （回 implement 自循环重试）→ dev 修复重进 quality_review → 报源 reviewer 复核通过 → done →
 *   complete_task_group 裸合并收尾（分支合并、worktree 清理）
 *
 * 用例 2（豁免裁定路径 + 合并冲突解决后直接收尾）：
 *   quality_review failed 报 issue → dev 申请豁免 → 报源 reviewer 视图「待裁定是否可豁免」可见 →
 *   exempt_adjudications 裁定 dismissed → passed 进 done → 收尾遇合并冲突返回 blocked（worktree/分支
 *   保留）→ dev 解决冲突后重调 complete 直接收尾（无额外验证）
 *
 * 附：simple 流程不自动勾选 tasks.md 复选框（复选框同步由 full 流程 verify_task 触发，见 README「simple 模式」）。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { init, set_worktree, status, agent_submit, complete_task_group } from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx, makeOrchCtx, setupWorkspace, teardown, initSimpleWorktree } from "./helpers"

const CID = "simple-e2e"
const DEV = "openspec-developer"
const REVIEWER = "openspec-reviewer"

afterAll(() => { __setGitRunner(null) })

function fresh(): { root: string; wt: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/simplee2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const wt = setupWorkspace(root, CID)
  const fakeGit = new FakeGitRunner()
  __setGitRunner(fakeGit)
  return { root, wt, fakeGit }
}

function stateOf(wt: string): any {
  return JSON.parse(readFileSync(join(wt, "openspec", "states", `${CID}.json`), "utf-8"))
}

function taskItemOf(wt: string): any {
  return stateOf(wt).workItems.find((w: any) => w.id === "task:1")
}

function tasksMd(wt: string): string {
  return readFileSync(join(wt, "openspec", "changes", CID, "tasks.md"), "utf-8")
}

/** implement passed 提交（simple 下须 worktree 干净，默认 FakeGit 干净）。 */
async function submitImplement(wt: string, extra: Record<string, unknown> = {}): Promise<void> {
  await agent_submit.execute(
    { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"], ...extra },
    makeCtx(DEV, wt),
  )
}

describe("simple 模式端到端：完整链路（失败自循环 + 谁提谁裁定复核 + 收尾裸合并）", () => {
  test("init 固化 → implement 干净强检查 → 清单可见/维度必填 → 自循环重试 → 复核通过 → 裸合并收尾", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      // ① init 固化 simple：新建 state 从 openspec/workflow.yaml 读取并写入 mode
      await initSimpleWorktree(wt, CID)
      expect(stateOf(wt).mode).toBe("simple")
      const item0 = taskItemOf(wt)
      expect(item0.phase).toBe("in_progress")
      expect(item0.currentStep).toBe("implement")

      // ② implement 提交工作区不干净强检查：拒绝、提示先 commit、零状态变更
      const wtPath = join(wt, ".worktree", CID, "task-group-1")
      fakeGit.dirtyPaths.add(wtPath)
      const err = await agent_submit
        .execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, makeCtx(DEV, wt))
        .catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/未提交内容/)
      const clean = taskItemOf(wt)
      expect(clean.tags["implement:openspec-developer"]).toBeUndefined()
      expect(clean.phase).toBe("in_progress")
      expect(clean.currentStep).toBe("implement")

      // ③ 干净后放行 → quality_review
      fakeGit.dirtyPaths.delete(wtPath)
      await submitImplement(wt)
      expect(taskItemOf(wt).phase).toBe("review")
      expect(taskItemOf(wt).currentStep).toBe("quality_review")

      // ④ quality_review 清单可见：Task(待验证) 区块（implement passed 后 task children 待验证）
      const view1 = await status.execute({ change_id: CID }, makeCtx(REVIEWER, wt))
      expect(view1).toContain("# ✅ 当前轮到你执行")
      expect(view1).toContain("## Task (待验证)")
      expect(view1).toContain("Task one")

      // ⑤ 未声明 dimension 上报被拒（spec:agent-identity#simple 审查者 issue 显式声明 dimension）
      const dimErr = await agent_submit
        .execute(
          {
            change_id: CID, step_id: "quality_review", verdict: "failed",
            new_children: [{ id: "i1", title: "问题", description: "desc", severity: "Low" }],
          },
          makeCtx(REVIEWER, wt),
        )
        .catch((e: Error) => e)
      expect(dimErr).toBeInstanceOf(Error)
      expect(dimErr.message).toMatch(/dimension/)
      expect(taskItemOf(wt).tags["quality_review:openspec-reviewer"]).toBeUndefined()

      // ⑥ 声明 dimension 后 failed 上报成功 → 回 implement 自循环重试（dev 重派由 recommendAgents
      //    非 passed 分支保证，同 phase 自循环不清 tags）
      await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "failed",
          new_children: [{ id: "i1", title: "问题", description: "desc", severity: "Low", dimension: "style" }],
        },
        makeCtx(REVIEWER, wt),
      )
      const retried = taskItemOf(wt)
      expect(retried.tags["quality_review:openspec-reviewer"]).toBe("failed")
      expect(retried.phase).toBe("in_progress")
      expect(retried.currentStep).toBe("implement")
      const issue1 = retried.children.find((c: any) => c.externalId === "i1")
      expect(issue1).toBeDefined()
      expect(issue1.phase).toBe("todo")
      expect(issue1.metadata.source).toBe(REVIEWER)

      // ⑦ dev 修复（fixed_issue_ids）→ 重进 quality_review，issue 进入待复核（review 态）
      await submitImplement(wt, { fixed_issue_ids: ["i1"] })
      expect(taskItemOf(wt).currentStep).toBe("quality_review")
      expect(taskItemOf(wt).children.find((c: any) => c.externalId === "i1").phase).toBe("review")

      // ⑧ 报源 reviewer 名下待复核清单可见（spec:agent-identity#simple 审查者名下清单可见）
      const view2 = await status.execute({ change_id: CID }, makeCtx(REVIEWER, wt))
      expect(view2).toContain("## Issue (待复核)")
      expect(view2).toContain("desc")

      // ⑨ 谁提谁裁定：报源 reviewer 复核通过（recheck passed）+ 任务全验证 → done
      await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "passed",
          recheck_adjudications: [{ issue_id: "i1", verdict: "passed" }],
          verified_tasks: ["1", "2", "3"],
        },
        makeCtx(REVIEWER, wt),
      )
      const done = taskItemOf(wt)
      expect(done.phase).toBe("done")
      expect(done.currentStep).toBeNull()
      expect(done.children.find((c: any) => c.externalId === "i1").phase).toBe("done")

      // ⑩ 收尾裸合并：直接合并分支并清理（无 verify_cleanup 环节）
      const ok = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(ok).toContain("任务组已完成并合并到")
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
      expect(fakeGit.mergedBranches).toContain(`task-group/${CID}/1`)
      expect(fakeGit.worktrees.has(wtPath)).toBe(false)

      // ⑪ simple 流程不自动勾选 tasks.md 复选框（复选框同步由 full 流程 verify_task 触发）
      expect(tasksMd(wt)).toContain("- [ ] 1.1 Task one")
      expect(tasksMd(wt)).toContain("- [ ] 1.2 Task two")
    } finally { teardown(root) }
  })
})

describe("simple 模式端到端：豁免裁定路径 + 合并冲突由 dev 解决后直接收尾", () => {
  test("quality_review failed 报 issue → dev 豁免申请 → 报源裁定 dismissed → done → 冲突 blocked → 解决后收尾", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      // ① implement → quality_review
      await submitImplement(wt)

      // ② reviewer failed 报 issue（显式 dimension）→ 回 implement
      await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "failed",
          new_children: [{ id: "i1", title: "问题", description: "desc", severity: "Low", dimension: "style" }],
        },
        makeCtx(REVIEWER, wt),
      )
      expect(taskItemOf(wt).currentStep).toBe("implement")

      // ③ dev 申请豁免（exempt_issue_ids）→ 重进 quality_review，issue 进入待裁定（exempt_request）
      await submitImplement(wt, { exempt_issue_ids: ["i1"] })
      expect(taskItemOf(wt).currentStep).toBe("quality_review")

      // ④ 报源 reviewer 视图「待裁定是否可豁免」区块可见
      const view = await status.execute({ change_id: CID }, makeCtx(REVIEWER, wt))
      expect(view).toContain("## Issue (待裁定是否可豁免)")
      expect(view).toContain("desc")
      expect(view).toContain("豁免申请中")

      // ⑤ 谁提谁裁定：报源 reviewer 裁定 dismissed + 任务全验证 → done（dismissed 为终态，本层 blocking 全终态）
      await agent_submit.execute(
        {
          change_id: CID, step_id: "quality_review", verdict: "passed",
          exempt_adjudications: [{ issue_id: "i1", action: "dismissed" }],
          verified_tasks: ["1", "2", "3"],
        },
        makeCtx(REVIEWER, wt),
      )
      const done = taskItemOf(wt)
      expect(done.phase).toBe("done")
      expect(done.children.find((c: any) => c.externalId === "i1").phase).toBe("cancelled")

      // ⑥ 收尾遇合并冲突 → blocked（保留 worktree/分支、不写 completed_at）
      fakeGit.mergeConflictOnNext = true
      const blocked = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(blocked).toContain("blocked")
      expect(blocked).toContain("merge_conflict")
      expect(taskItemOf(wt).metadata["completed_at"]).toBeUndefined()
      const wtPath = join(wt, ".worktree", CID, "task-group-1")
      expect(fakeGit.worktrees.has(wtPath)).toBe(true)

      // ⑦ dev 在 worktree 内解决冲突后（重调 complete）直接收尾——裸合并、无回归、无环境清理
      const ok = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(ok).toContain("任务组已完成并合并到")
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
      expect(fakeGit.worktrees.has(wtPath)).toBe(false)
    } finally { teardown(root) }
  })
})

describe("simple 模式端到端：full 模式既有流转不受身份逻辑化影响（回归快照）", () => {
  test("full 模式 init（无 workflow.yaml 缺省 full）→ analyze 正常推进", async () => {
    const { root, wt } = fresh()
    try {
      const orch = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1" }, orch)
      await set_worktree.execute({ change_id: CID }, orch)
      // 缺省 full：旧行为完整保留（analyze step 存在、初始态 todo/analyze）
      expect(stateOf(wt).mode).toBe("full")
      const item = taskItemOf(wt)
      expect(item.phase).toBe("todo")
      expect(item.currentStep).toBe("analyze")
      await agent_submit.execute(
        {
          change_id: CID, step_id: "analyze", verdict: "passed",
          execution_boundary: { allowed_directories: ["src"], allowed_packages: [], notes: "" },
        },
        makeCtx("openspec-architect", wt),
      )
      expect(taskItemOf(wt).currentStep).toBe("implement")
    } finally { teardown(root) }
  })
})

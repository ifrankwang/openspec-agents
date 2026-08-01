/**
 * 优化项回归测试：submit 工具重试检查点路径 completed 回置缺陷。
 *
 * 背景：toolReviewSubmitExecute / taskReviewSubmitExecute 在检查点（retryCount 为
 * MAX_RETRIES 整数倍，非无人值守）时直接返回，未回置对应层 completed=false，
 * 导致等待用户决策期间编排者视图误显示该层已完成。
 *
 * 验证：非无人值守模式下，tool / task 各自重试达到检查点后，状态文件中该层
 * completed 为 false。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import { MAX_RETRIES } from "../src/core/constants"
import {
  init, status, set_worktree, arch_submit, dev_submit,
  tool_review_submit, task_review_submit,
} from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx } from "./helpers"

const CID = "test-optimize-fix"

afterAll(() => { __setGitRunner(null) })

type Ctx = ReturnType<typeof makeCtx>

function readStateSync(wt: string, cid: string): any {
  const p = join(wt, ".opencode", ".orchestrate_state", `${cid}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8"))
}

function freshWt(root: string): string {
  const id = `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const wt = join(root, id, "w")
  mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
  writeFileSync(
    join(wt, "openspec", "changes", CID, "tasks.md"),
    `## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2 [spec:s2]\n\n## 2. G2\n\n- [ ] 2.1 T3\n`,
    "utf-8"
  )
  return wt
}

async function setupToReview(
  wt: string, ctx: { orch: Ctx; arch: Ctx; dev: Ctx }
): Promise<void> {
  await init.execute({ change_id: CID, task_group_id: "1" }, ctx.orch)
  await arch_submit.execute({ change_id: CID, outcome: "ready",
    execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } }, ctx.arch)
  await set_worktree.execute({ change_id: CID }, ctx.orch)
  await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, ctx.dev)
}

describe("改进项3：submit 工具检查点路径 completed 回置", () => {
  test("tool review 达到检查点（retryCount=MAX_RETRIES）后 tool.completed=false", async () => {
    const root = `/tmp/of1-tool-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt),
          a = makeCtx("openspec-architect", wt),
          d = makeCtx("openspec-developer", wt),
          toolR = makeCtx("openspec-reviewer-tool", wt)

    try {
      await setupToReview(wt, { orch: o, arch: a, dev: d })

      let prevIssue: string | undefined
      for (let round = 1; round <= MAX_RETRIES; round++) {
        await init.execute({ change_id: CID, task_group_id: "1",
          recovery: { phase: "review" } }, o)
        await set_worktree.execute({ change_id: CID }, o)
        if (round > 1) {
          await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"],
            fixed_issue_ids: prevIssue ? [prevIssue] : [] }, d)
        }
        const r = JSON.parse(await tool_review_submit.execute({ change_id: CID, passed: false,
          issues: [{ severity: "Low", file: "src/x.java", line: 1, dimension: "style" as any,
            description: "Tool issue", suggestion: "Fix" }],
          fixed_issue_ids: prevIssue ? [prevIssue] : [] }, toolR))
        expect(r.status).toBe("recorded")

        const state = readStateSync(wt, CID)
        const tg = state.taskGroups.find((g: any) => g.id === "1")
        prevIssue = tg.issues.length > 0 ? tg.issues[tg.issues.length - 1].id : undefined
      }

      const state = readStateSync(wt, CID)
      const tg = state.taskGroups.find((g: any) => g.id === "1")
      expect(tg.phases.review.retryCount).toBe(MAX_RETRIES)
      expect(tg.phases.review.tool.completed).toBe(false)
      expect(tg.status).toBe("review")

      const os = await status.execute({ change_id: CID }, o)
      expect(os).not.toContain("openspec-reviewer-tool")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("task review 达到检查点（retryCount=MAX_RETRIES）后 task.completed=false", async () => {
    const root = `/tmp/of2-task-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt),
          a = makeCtx("openspec-architect", wt),
          d = makeCtx("openspec-developer", wt),
          toolR = makeCtx("openspec-reviewer-tool", wt),
          taskR = makeCtx("openspec-reviewer-task", wt)

    try {
      await setupToReview(wt, { orch: o, arch: a, dev: d })
      await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)

      let prevIssue: string | undefined
      for (let round = 1; round <= MAX_RETRIES; round++) {
        await init.execute({ change_id: CID, task_group_id: "1",
          recovery: { phase: "review" } }, o)
        await set_worktree.execute({ change_id: CID }, o)
        if (round > 1) {
          await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"],
            fixed_issue_ids: prevIssue ? [prevIssue] : [] }, d)
          await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)
        }
        const r = JSON.parse(await task_review_submit.execute({ change_id: CID, passed: false,
          issues: [{ severity: "Low", file: "src/x.java", line: 1,
            description: `Task issue round ${round}`, suggestion: "Fix" }],
          verified_task_ids: ["1", "2"], failed_task_ids: [],
          fixed_issue_ids: prevIssue ? [prevIssue] : [] }, taskR))
        expect(r.status).toBe("recorded")

        const state = readStateSync(wt, CID)
        const tg = state.taskGroups.find((g: any) => g.id === "1")
        prevIssue = tg.issues.length > 0 ? tg.issues[tg.issues.length - 1].id : undefined
      }

      const state = readStateSync(wt, CID)
      const tg = state.taskGroups.find((g: any) => g.id === "1")
      expect(tg.phases.review.retryCount).toBe(MAX_RETRIES)
      expect(tg.phases.review.task.completed).toBe(false)
      expect(tg.status).toBe("review")

      const os = await status.execute({ change_id: CID }, o)
      expect(os).toContain("opx_orch_resolve_review")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
})

/**
 * tool review 检查点增量端到端用例（D4）。
 *
 * 覆盖：
 * 1. 首次进入 verify_tool：无检查点，用 base_ref 兜底，区间含代码变更 → 全量
 * 2. verify_tool passed 提交成功 → 写入 _tool_review_checkpoint（当前 HEAD）
 * 3. 纯文档重审直提：重置后检查点区间仅 openspec 文档变更 → 直提 passed（分支①）
 * 4. 多提交含代码 → 走全量（分支③）
 * 5. verify_tool failed 后 dev 修复回归：检查点区间含修复提交 → 走全量
 */
import { describe, expect, test, afterAll } from "bun:test"
import { __setGitRunner } from "../src/core/git"
import { init, agent_submit, status } from "../src/adapters/opencode/tools"
import { FakeGitRunner, setupWithFakeGit, teardown } from "./helpers"
import { driveToVerifyTool, readItem } from "./helpers-workflow"

const CID = "test-tool-checkpoint"
const BASE_REF = "base000000000000000000000000000000000001"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/tcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID)
  return { wt: worktree, root, fakeGit }
}

describe("tool review 检查点增量端到端", () => {
  test("首次全量 → 推进检查点 → 纯文档重审直提 → 多提交含代码走全量 → failed 后修复回归走全量", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      // 检查点 sha 序列：4 次 verify_tool 提交依次写入 cp-1..cp-4
      fakeGit.headShas = ["cp-1", "cp-2", "cp-3", "cp-4", "cp-5"]
      const { ctx } = await driveToVerifyTool(wt, CID)

      // ── 首次进入 verify_tool：无检查点 → base_ref 兜底，区间含代码 → 全量 ──
      fakeGit.diffNameOnlyByRange.set(`${BASE_REF}..HEAD`, "src/main/java/com/t/App.java")
      const firstView = await status.execute({ change_id: CID }, ctx.toolR)
      expect(firstView).toContain("顺序运行全部确定性工具检查")
      expect(firstView).not.toContain("无需运行全量工具检查")
      expect(readItem(wt, CID).metadata["_tool_review_checkpoint"]).toBeUndefined()

      // 首次提交 passed → 写入检查点 cp-1
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)
      expect(readItem(wt, CID).metadata["_tool_review_checkpoint"]).toBe("cp-1")

      // ── 纯文档重审直提：重置 verify_tool，检查点区间仅 openspec 文档变更 → 分支① 直提 ──
      await init.execute(
        { change_id: CID, task_group_id: "1", recovery: { phase: "review", reset_steps: ["verify_tool"] } },
        ctx.orch
      )
      fakeGit.diffNameOnlyByRange.set("cp-1..HEAD", "openspec/changes/cid/design.md")
      const docView = await status.execute({ change_id: CID }, ctx.toolR)
      expect(docView).toContain("无需运行全量工具检查")
      expect(docView).toContain('opx_agent_submit({ step_id: "verify_tool", verdict: "passed" })')
      expect(docView).not.toContain("顺序运行全部确定性工具检查")
      expect(docView).not.toContain("## Worktree")
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)
      expect(readItem(wt, CID).metadata["_tool_review_checkpoint"]).toBe("cp-2")

      // ── 多提交含代码 → 走全量（分支③）──
      await init.execute(
        { change_id: CID, task_group_id: "1", recovery: { phase: "review", reset_steps: ["verify_tool"] } },
        ctx.orch
      )
      fakeGit.diffNameOnlyByRange.set("cp-2..HEAD", "src/main/java/com/t/A.java\nsrc/main/java/com/t/B.java")
      const codeView = await status.execute({ change_id: CID }, ctx.toolR)
      expect(codeView).toContain("顺序运行全部确定性工具检查")
      expect(codeView).not.toContain("无需运行全量工具检查")

      // ── failed → 写入检查点 cp-3 并回退 implement ──
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [{ id: "9", title: "Tool issue", description: "d", severity: "Low", dimension: "style" }],
        },
        ctx.toolR
      )
      const afterFail = readItem(wt, CID)
      expect(afterFail.metadata["_tool_review_checkpoint"]).toBe("cp-3")
      expect(afterFail.currentStep).toBe("implement")

      // ── dev 修复 → 重新进入 verify_tool，检查点区间含修复提交 → 全量 ──
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: [], fixed_issue_ids: ["9"] },
        ctx.dev
      )
      expect(readItem(wt, CID).currentStep).toBe("verify_tool")
      fakeGit.diffNameOnlyByRange.set("cp-3..HEAD", "src/main/java/com/t/App.java")
      const fixView = await status.execute({ change_id: CID }, ctx.toolR)
      expect(fixView).toContain("顺序运行全部确定性工具检查")
      expect(fixView).not.toContain("无需运行全量工具检查")

      // reviewer 复核通过 → 检查点推进到 cp-4
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", recheck_adjudications: [{ issue_id: "9", verdict: "passed" }] },
        ctx.toolR
      )
      expect(readItem(wt, CID).metadata["_tool_review_checkpoint"]).toBe("cp-4")
    } finally { teardown(root) }
  })
})

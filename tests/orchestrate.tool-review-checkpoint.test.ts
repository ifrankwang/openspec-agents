/**
 * tool review 检查点增量端到端用例（D4）。
 *
 * 覆盖：
 * 1. 首次进入 verify_tool：无检查点，用 base_ref 兜底，区间含代码变更 → 全量
 * 2. verify_tool passed 提交成功 → 写入 _tool_review_checkpoint（当前 HEAD）
 * 3. 纯文档重审直提：重置后检查点区间仅 openspec 文档变更 → 直提 passed（分支①）
 * 4. 多提交含代码 → 走全量（分支③）
 * 5. verify_tool failed 后 dev 修复回归：检查点区间含修复提交 → 走全量
 * 6. 注释性变更裁量直提：有代码文件变更但审查证据后免全量 → 直接提交 passed，检查点推进
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

  test("注释性变更裁量直提：有代码文件变更但审查证据后免全量 → 直接提交 passed，检查点推进", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.headShas = ["cp-1", "cp-2"]
      const { ctx } = await driveToVerifyTool(wt, CID)

      // 首次进入 verify_tool：无检查点 → base_ref 兜底，区间含代码 → 全量
      fakeGit.diffNameOnlyByRange.set(`${BASE_REF}..HEAD`, "src/main/java/com/t/App.java")
      const firstView = await status.execute({ change_id: CID }, ctx.toolR)
      expect(firstView).toContain("顺序运行全部确定性工具检查")
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)
      expect(readItem(wt, CID).metadata["_tool_review_checkpoint"]).toBe("cp-1")

      // ── 重置 verify_tool：dev 只改代码注释（检查点区间含代码文件，hasNonDocChange=true → 分支③）──
      await init.execute(
        { change_id: CID, task_group_id: "1", recovery: { phase: "review", reset_steps: ["verify_tool"] } },
        ctx.orch
      )
      fakeGit.diffNameOnlyByRange.set("cp-1..HEAD", "src/main/java/com/t/App.java")
      const discretionView = await status.execute({ change_id: CID }, ctx.toolR)
      // 分支③视图：全量指引保留（原句不删）+ 本次变更证据区块（增量口径文件清单 + 检查点区间 diff 命令）+ 裁量语义操作指引
      expect(discretionView).toContain("顺序运行全部确定性工具检查")
      expect(discretionView).toContain("本次变更证据（自上次工具检查）")
      expect(discretionView).toContain("`src/main/java/com/t/App.java`")
      expect(discretionView).toContain("git -C")
      expect(discretionView).toContain("cp-1..HEAD")
      expect(discretionView).toContain("跳过全量工具检查")
      expect(discretionView).toContain("仅注释/文档性")
      // 有检查点形态口径标注：本次为「自上次工具检查（cp-1..HEAD）」增量区间，与「变更范围」baseRef..HEAD 累计口径不同
      expect(discretionView).toContain("自上次工具检查（cp-1..HEAD）")
      expect(discretionView).toContain("与上方「变更范围」（")
      expect(discretionView).toContain("累计口径）不同")
      // 未提交变更查看提示
      expect(discretionView).toContain("若存在未提交变更，另用 `git status` / `git diff` 查看工作区改动")

      // reviewer 审查证据后裁量：不运行工具直接提交 passed → 检查点推进到 cp-2
      await agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)
      expect(readItem(wt, CID).metadata["_tool_review_checkpoint"]).toBe("cp-2")
    } finally { teardown(root) }
  })

  test("failed → dev 只改文档 → 重进 verify_tool 走分支②（仅处理待复核项，不直提、不跑全量）", async () => {
    const { wt, root, fakeGit } = fresh()
    try {
      fakeGit.headShas = ["cp-1", "cp-2"]
      const { ctx } = await driveToVerifyTool(wt, CID)

      // 首次进入 verify_tool：无检查点 → base_ref 兜底，区间含代码 → 全量
      fakeGit.diffNameOnlyByRange.set(`${BASE_REF}..HEAD`, "src/main/java/com/t/App.java")
      const firstView = await status.execute({ change_id: CID }, ctx.toolR)
      expect(firstView).toContain("顺序运行全部确定性工具检查")

      // ── failed：报 issue（new_children），检查点已写 cp-1，回退 implement ──
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [{ id: "9", title: "Tool issue", description: "d", severity: "Low", dimension: "style" }],
        },
        ctx.toolR
      )
      const afterFail = readItem(wt, CID)
      expect(afterFail.metadata["_tool_review_checkpoint"]).toBe("cp-1")
      expect(afterFail.currentStep).toBe("implement")

      // ── dev 只修改 openspec 文档并修复 issue 9 → 重进 verify_tool（issue 9 置 review 待复核）──
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: [], fixed_issue_ids: ["9"] },
        ctx.dev
      )
      expect(readItem(wt, CID).currentStep).toBe("verify_tool")

      // 检查点区间仅 openspec 文档变更 + 本层存在 review 态待复核 issue → 分支②
      fakeGit.diffNameOnlyByRange.set("cp-1..HEAD", "openspec/changes/cid/design.md")
      const branch2View = await status.execute({ change_id: CID }, ctx.toolR)
      // 含待处理项清单与「不跑全量」语义指引
      expect(branch2View).toContain("无需运行全量工具检查")
      expect(branch2View).toContain("仅处理以下本层待复核 / 待裁定项")
      expect(branch2View).toContain("Issue (待复核)")
      expect(branch2View).toContain("Issue #9")
      expect(branch2View).toContain("描述：d")
      // 不含直提分支文案
      expect(branch2View).not.toContain("无需运行全量工具检查，直接调用")
      // 不含全量工具检查指令
      expect(branch2View).not.toContain("顺序运行全部确定性工具检查")

      // ── 提交复核结果：issue 9 done，检查点推进到 cp-2 ──
      await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", recheck_adjudications: [{ issue_id: "9", verdict: "passed" }] },
        ctx.toolR
      )
      const afterRecheck = readItem(wt, CID)
      expect(afterRecheck.metadata["_tool_review_checkpoint"]).toBe("cp-2")
      expect(afterRecheck.children.find((c: any) => c.externalId === "9")?.phase).toBe("done")
    } finally { teardown(root) }
  })
})

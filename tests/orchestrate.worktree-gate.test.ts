/**
 * worktree 就绪门禁测试：opx_status 视图（orchestrator 分派前置 / 子代理拒绝执行）+ opx_agent_submit 硬门禁。
 *
 * 覆盖：
 * 1. 子代理在 worktree 未就绪时调 opx_status → ⛔ 拒绝执行视图（不含操作指引 / "当前轮到你执行"）
 * 2. orchestrator 在 worktree 未就绪时调 opx_status → 分派视图不含"分派子代理"指令，提示先 set_worktree
 * 3. worktree 未就绪时 opx_agent_submit 提交 → 抛错拒绝
 * 4. reopenIssues 恢复清空 worktree_path 后，orchestrator 视图正确提示先 set_worktree
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import { init, set_worktree, status, agent_submit } from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx, setupWithFakeGit, teardown } from "./helpers"

const CID = "test-worktree-gate"
const EB = { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/wtg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID)
  return { wt: worktree, root, fakeGit }
}

/** 手动写 state 文件（构造 reopenIssues 前置等）。 */
function writeStateSync(wt: string, state: Record<string, unknown>): void {
  const dir = join(wt, ".opencode", ".orchestrate_state")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${CID}.json`), JSON.stringify(state, null, 2))
}

describe("worktree 就绪门禁：opx_status 视图", () => {
  test("子代理在 worktree 未就绪时查 status → ⛔ 拒绝执行视图（不含操作指引 / 当前轮到你执行）", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeCtx("openspec-orchestrator", wt)
      await init.execute({ change_id: CID, task_group_id: "1" }, o)

      const out = await status.execute({ change_id: CID }, makeCtx("openspec-architect", wt))
      expect(out).toContain("# ⛔ worktree 未就绪，当前拒绝执行")
      expect(out).toContain("opx_orch_set_worktree")
      expect(out).toContain("不调用 `opx_agent_submit`")
      // 不渲染 ✅ 执行视图内容
      expect(out).not.toContain("# ✅ 当前轮到你执行")
      expect(out).not.toContain("## 操作指引")
      expect(out).not.toContain("## Skill 加载清单")
      expect(out).not.toContain("**必须**调用 `opx_agent_submit()` 提交")
    } finally { teardown(root) }
  })

  test("orchestrator 在 worktree 未就绪时查 status → 不含分派指令，提示先 set_worktree", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeCtx("openspec-orchestrator", wt)
      await init.execute({ change_id: CID, task_group_id: "1" }, o)

      const out = await status.execute({ change_id: CID }, o)
      expect(out).toContain("## Worktree")
      expect(out).toContain("worktree 未就绪")
      expect(out).toContain("opx_orch_set_worktree")
      expect(out).toContain("## 下一步")
      // 有待分派 agent 但不输出"分派子代理"指令
      expect(out).not.toContain("分派子代理：")
      expect(out).toContain("分派前置条件未满足")
    } finally { teardown(root) }
  })

  test("set_worktree 后 orchestrator 视图恢复分派指令", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeCtx("openspec-orchestrator", wt)
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      await set_worktree.execute({ change_id: CID }, o)

      const out = await status.execute({ change_id: CID }, o)
      expect(out).toContain("## Worktree")
      expect(out).toContain("**路径**")
      expect(out).toContain("分派子代理：`openspec-architect`")
    } finally { teardown(root) }
  })
})

describe("worktree 就绪门禁：opx_agent_submit 硬门禁", () => {
  test("worktree 未就绪时提交 analyze → 抛错拒绝（指引先 set_worktree）", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeCtx("openspec-orchestrator", wt)
      await init.execute({ change_id: CID, task_group_id: "1" }, o)

      await expect(
        agent_submit.execute(
          { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB },
          makeCtx("openspec-architect", wt)
        )
      ).rejects.toThrow(/worktree 未就绪[\s\S]*opx_orch_set_worktree/)
      // 门禁抛错零状态变更：仍在 todo/analyze
      const out = await status.execute({ change_id: CID }, makeCtx("openspec-orchestrator", wt))
      expect(out).toContain("分派前置条件未满足")
    } finally { teardown(root) }
  })

  test("checkpoint_decision 决策路径绕过 worktree 门禁（不误伤）", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeCtx("openspec-orchestrator", wt)
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      // 手工构造检查点态（无 worktree_path）
      const item = {
        id: "task:1", source: "openspec", externalId: "1", type: "task",
        title: "First Task Group", description: "First Task Group",
        phase: "review", suspended: false, currentStep: "verify_tool",
        tags: { "verify_tool:openspec-reviewer-tool": "failed" },
        metadata: { _retryCount: 3, _checkpoint: true },
        children: [{
          id: "issue:7", source: "openspec", externalId: "7", type: "issue",
          title: "遗留", description: "d", phase: "todo", suspended: false,
          currentStep: null, tags: {}, metadata: {}, children: [], labels: [], severity: "Low",
        }],
        labels: [],
      }
      const state = {
        changeId: CID,
        isolationNamespace: "ns",
        taskGroupId: "1",
        baseBranch: "main",
        workItems: [item],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      writeStateSync(wt, state)

      const r = await agent_submit.execute(
        { change_id: CID, step_id: "verify_tool", verdict: "passed", checkpoint_decision: "continue" },
        makeCtx("openspec-reviewer-tool", wt)
      )
      expect(r).toContain("continue")
      expect(r).not.toContain("worktree 未就绪")
    } finally { teardown(root) }
  })
})

describe("worktree 就绪门禁：reopenIssues 清空 worktree_path 后恢复", () => {
  test("reopenIssues 置 worktree_path=null → orchestrator 视图提示先 set_worktree", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeCtx("openspec-orchestrator", wt)
      // 构造已完成组（done + worktree_path 已绑定）
      const done = {
        id: "task:1", source: "openspec", externalId: "1", type: "task",
        title: "First Task Group", description: "First Task Group",
        phase: "done", suspended: false, currentStep: null,
        tags: { "verify_quality:openspec-reviewer-style": "passed" },
        metadata: {
          worktree_path: join(wt, ".worktree", CID, "task-group-1"),
          branch_name: `task-group/${CID}/1`,
          base_ref: "base000000000000000000000000000000000001",
          completed_at: new Date().toISOString(),
        },
        children: [], labels: [],
      }
      writeStateSync(wt, {
        changeId: CID,
        isolationNamespace: "ns",
        taskGroupId: "1",
        baseBranch: "main",
        workItems: [done],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      // reopenIssues 恢复：清空 worktree 引用、回到 dev_impl
      await init.execute(
        { change_id: CID, task_group_id: "1", recovery: { phase: "dev_impl", reopenIssues: true } },
        o
      )

      const out = await status.execute({ change_id: CID }, o)
      expect(out).toContain("worktree 未就绪")
      expect(out).toContain("opx_orch_set_worktree")
      expect(out).not.toContain("分派子代理：")
      expect(out).toContain("分派前置条件未满足")
    } finally { teardown(root) }
  })
})

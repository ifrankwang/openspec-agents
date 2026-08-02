/**
 * 参数归一化测试：issue id 的 # 前缀归一化、taskNumber → 数字 id 映射
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import {
  init, set_worktree, arch_submit, dev_submit,
  tool_review_submit, task_review_submit, quality_review_submit
} from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx } from "./helpers"

const CID = "test-norm"
afterAll(() => { __setGitRunner(null) })

function setupWt(root: string, wt: string): string {
  mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
  writeFileSync(
    join(wt, "openspec", "changes", CID, "tasks.md"),
    `## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2\n`,
    "utf-8"
  )
  return wt
}

function readStateSync(wt: string): any {
  const p = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8"))
}

async function baseSetup(wt: string): Promise<void> {
  const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt)
  await init.execute({ change_id: CID, task_group_id: "1" }, o)
  await arch_submit.execute({change_id: CID, outcome: "ready",
    execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
  await set_worktree.execute({ change_id: CID }, o)
}

async function enterReview(wt: string): Promise<void> {
  const o = makeCtx("openspec-orchestrator", wt)
  await init.execute({
    change_id: CID, task_group_id: "1",
    recovery: { phase: "review" }}, o)
  await set_worktree.execute({ change_id: CID }, o)
}

async function toolAndTaskPass(wt: string): Promise<void> {
  await enterReview(wt)
  await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, makeCtx("openspec-reviewer-tool", wt))
  await task_review_submit.execute({ change_id: CID, passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, makeCtx("openspec-reviewer-task", wt))
}

// ── 1: issue id # 前缀归一化 ──

describe("N1. issue id # 前缀归一化", () => {
  test("dev_submit fixed_issue_ids 带 # 前缀 → issue 被接受置 submitted", async () => {
    const root = `/tmp/norm-fixed-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const d = makeCtx("openspec-developer", wt)

    await baseSetup(wt)
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    // quality 层报 Low issue（open）
    await toolAndTaskPass(wt)
    await quality_review_submit.execute({ change_id: CID, passed: false,
      issues: [{ severity: "Low", file: "x.java", line: 1, description: "Style", suggestion: "Fix" }]},
      makeCtx("openspec-reviewer-style", wt))

    // dev 用 # 前缀修复
    const result = await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"], fixed_issue_ids: ["#1"] }, d)
    expect(result).toContain("提交完成")

    const state = readStateSync(wt)
    const issue = state.taskGroups.find((g: any) => g.id === "1").issues[0]
    expect(issue.id).toBe("1")
    expect(issue.status).toBe("submitted")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("dev request_exempts 带 # + quality exempt_issue_ids 带 # → issue 置 exempted", async () => {
    const root = `/tmp/norm-exempt-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const d = makeCtx("openspec-developer", wt)

    await baseSetup(wt)
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    // quality 层报 Info issue（不阻塞，passed=true）
    await toolAndTaskPass(wt)
    await quality_review_submit.execute({ change_id: CID, passed: true,
      issues: [{ severity: "Info", file: "x.java", line: 1, description: "Info issue", suggestion: "Consider" }]},
      makeCtx("openspec-reviewer-style", wt))

    // dev 用 # 前缀申请豁免
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"],
      request_exempts: [{ issue_id: "#1", reason: "Lib" }]}, d)

    // quality（style）用 # 前缀裁定豁免
    await quality_review_submit.execute({ change_id: CID, passed: true, issues: [],
      exempt_issue_ids: ["#1"]}, makeCtx("openspec-reviewer-style", wt))

    const state = readStateSync(wt)
    const issue = state.taskGroups.find((g: any) => g.id === "1").issues[0]
    expect(issue.status).toBe("exempted")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("tool rejected_issue_ids 带 # 前缀 → issue 置 rejected", async () => {
    const root = `/tmp/norm-rejected-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const d = makeCtx("openspec-developer", wt)

    await baseSetup(wt)
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    // tool 层报 High issue → 回退 dev_impl
    await enterReview(wt)
    await tool_review_submit.execute({ change_id: CID, passed: false,
      issues: [{ severity: "High", file: "src/x.java", line: 1, dimension: "style" as any, description: "Tool issue", suggestion: "Fix" }],
      fixed_issue_ids: [] }, makeCtx("openspec-reviewer-tool", wt))

    // dev 用 # 前缀修复 → tool issue 置 submitted
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"], fixed_issue_ids: ["#1"] }, d)

    // tool 层用 # 前缀驳回
    await enterReview(wt)
    await tool_review_submit.execute({ change_id: CID, passed: false,
      issues: [], fixed_issue_ids: [],
      rejected_issue_ids: [{ issue_id: "#1", reason: "未达标准" }]},
      makeCtx("openspec-reviewer-tool", wt))

    const state = readStateSync(wt)
    const issue = state.taskGroups.find((g: any) => g.id === "1").issues[0]
    expect(issue.id).toBe("1")
    expect(issue.status).toBe("rejected")
    expect(issue.rejectReason).toBe("未达标准")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── 2: taskNumber → 数字 id 映射 ──

describe("N2. taskNumber 映射", () => {
  test("dev completed_task_ids 传任务编号 1.1/1.2 → 映射为数字 id 并全部提交", async () => {
    const root = `/tmp/norm-devnum-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const d = makeCtx("openspec-developer", wt)

    await baseSetup(wt)
    const result = await dev_submit.execute({ change_id: CID, completed_task_ids: ["1.1", "1.2"] }, d)
    expect(result).toContain("提交完成")

    const state = readStateSync(wt)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.tasks.every((t: any) => t.status === "submitted")).toBe(true)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("task_review_submit verified_task_ids 传任务编号 → 映射并验证通过", async () => {
    const root = `/tmp/norm-verifynum-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const d = makeCtx("openspec-developer", wt)

    await baseSetup(wt)
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
    await enterReview(wt)
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, makeCtx("openspec-reviewer-tool", wt))

    const result = await task_review_submit.execute({ change_id: CID, passed: true,
      verified_task_ids: ["1.1", "1.2"], failed_task_ids: [],
      fixed_issue_ids: [] }, makeCtx("openspec-reviewer-task", wt))
    expect(result).toContain("审核通过")

    const state = readStateSync(wt)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.tasks.every((t: any) => t.status === "verified")).toBe(true)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("非法 taskNumber → 报错", async () => {
    const root = `/tmp/norm-badnum-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const d = makeCtx("openspec-developer", wt)

    await baseSetup(wt)

    // dev 层：非法编号
    await expect(
      dev_submit.execute({ change_id: CID, completed_task_ids: ["9.9"] }, d)
    ).rejects.toThrow(/无效 task id/)

    // task 层：非法编号
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
    await enterReview(wt)
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, makeCtx("openspec-reviewer-tool", wt))
    await expect(
      task_review_submit.execute({ change_id: CID, passed: true,
        verified_task_ids: ["9.9"], failed_task_ids: [],
        fixed_issue_ids: [] }, makeCtx("openspec-reviewer-task", wt))
    ).rejects.toThrow(/非法 task id/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

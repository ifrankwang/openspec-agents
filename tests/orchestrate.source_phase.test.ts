/**
 * sourcePhase 过滤测试：tool/task 层放行门禁仅检本层 blocking issue
 *
 * 覆盖场景：
 * A. quality 层 blocking issue → tool 层正常通过
 * B. tool 层 blocking issue → tool 层回退 dev_impl，消息含 issue id
 * C. task 层 blocking issue → task 层抛错，消息含 issue id
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  init,
  set_worktree,
  arch_submit,
  dev_submit,
  tool_review_submit,
  task_review_submit,
  __setGitRunner} from "../src/tools/orchestrate"
import { FakeGitRunner, makeCtx } from "./helpers"

const CID = "test-sourcePhase"
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

function makeSeedIssue(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "i1",
    dimension: "style",
    sourcePhase: "quality",
    severity: "High",
    file: "d.md",
    line: 0,
    description: "Test blocking issue",
    suggestion: "Fix it",
    status: "open",
    refixCount: 0,
    rootCauseGuess: null,
    exemptReason: null,
    rejectReason: null,
    ...overrides,
  }
}

async function setupToReview(root: string, wt: string, fakeGit: FakeGitRunner) {
  const o = makeCtx("openspec-orchestrator", wt),
    a = makeCtx("openspec-architect", wt),
    d = makeCtx("openspec-developer", wt)

  await init.execute({ change_id: CID, task_group_id: "1" }, o)
  await arch_submit.execute({change_id: CID, outcome: "ready", issues: [],
    execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
  await set_worktree.execute({ change_id: CID }, o)
  fakeGit.diffs.set(wt, ["src/T.java"])
  await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

  const state = readStateSync(wt)
  const tg = state.taskGroups.find((g: any) => g.id === "1")
  await init.execute({
    change_id: CID, task_group_id: "1",
    recovery: { phase: "review" }}, o)
  await set_worktree.execute({ change_id: CID }, o)
}

// ── Scene A: quality blocking issue → tool layer passes ──

describe("sourcePhase A: quality blocking issue does not block tool layer", () => {
  test("tool layer with quality blocking issue + Info issues → passes", async () => {
    const root = `/tmp/sourcePhase-A-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    await setupToReview(root, wt, fakeGit)

    const state = readStateSync(wt)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    tg.issues.push(makeSeedIssue({
      id: "q1",
      dimension: "architecture",
      sourcePhase: "quality",
      severity: "High",
      description: "Architecture issue from quality review",
    }))
    writeFileSync(
      join(wt, ".opencode", ".orchestrate_state", `${CID}.json`),
      JSON.stringify(state), "utf-8"
    )

    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const raw = await tool_review_submit.execute({change_id: CID, passed: true,
      issues: [{ severity: "Info", file: "d.md", line: 1, dimension: "style" as any, description: "Minor style", suggestion: "Consider" }],
      fixed_issue_ids: [],}, toolR)
    const result = JSON.parse(typeof raw === "string" ? raw : raw.output)

    expect(result.status).toBe("ok")
    expect(result.passed !== false).toBe(true)
    expect(result.phase).toContain("tool=completed")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── Scene B: tool blocking issue → tool layer rolls back ──

describe("sourcePhase B: tool blocking issue causes tool rollback", () => {
  test("tool layer with tool blocking issue + passed=true → rolls back with issue id", async () => {
    const root = `/tmp/sourcePhase-B-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    await setupToReview(root, wt, fakeGit)

    const state = readStateSync(wt)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    tg.issues.push(makeSeedIssue({
      id: "t1",
      dimension: "tool",
      sourcePhase: "tool",
      severity: "High",
      description: "Tool-level compile error",
    }))
    writeFileSync(
      join(wt, ".opencode", ".orchestrate_state", `${CID}.json`),
      JSON.stringify(state), "utf-8"
    )

    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const raw = await tool_review_submit.execute({change_id: CID, passed: true,
      issues: [],
      fixed_issue_ids: [],}, toolR)
    const result = JSON.parse(typeof raw === "string" ? raw : raw.output)

    expect(result.status).toBe("recorded")
    expect(result.passed).toBe(false)
    expect(result.message).toContain("t1")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── Scene C: task blocking issue → task_review_submit throws ──

describe("sourcePhase C: task blocking issue causes task throw", () => {
  test("task_review_submit with task blocking issue → throws with issue id", async () => {
    const root = `/tmp/sourcePhase-C-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const toolR = makeCtx("openspec-reviewer-tool", wt),
      taskR = makeCtx("openspec-reviewer-task", wt)

    await setupToReview(root, wt, fakeGit)
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    const state = readStateSync(wt)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    tg.issues.push(makeSeedIssue({
      id: "tk1",
      dimension: "task",
      sourcePhase: "task",
      severity: "High",
      description: "Task-level verification failure",
    }))
    writeFileSync(
      join(wt, ".opencode", ".orchestrate_state", `${CID}.json`),
      JSON.stringify(state), "utf-8"
    )

    await expect(
      task_review_submit.execute({change_id: CID, passed: true,
        verified_task_ids: ["1", "2"], failed_task_ids: [],
        fixed_issue_ids: [],}, taskR)
    ).rejects.toThrow(/tk1/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

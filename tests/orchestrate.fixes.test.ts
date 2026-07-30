/**
 * 修复项测试：
 * 2+3: dev_submit / task_review_submit verified 清除 rejectReason
 * 4: finalizeQualityPhase 仅看 quality 层遗留 blocking issue
 * 6: deduplicateAndAddIssues 跨层去重区分 sourcePhase
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import {
  init, set_worktree, arch_submit, dev_submit,
  tool_review_submit, task_review_submit
} from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx } from "./helpers"
import { deduplicateAndAddIssues, finalizeQualityPhase } from "../src/core/review"
import type { OrchestrateState, TaskGroupState, IssueItem } from "../src/core/types"
import { REVIEW_DIMENSIONS } from "../src/core/types"

afterAll(() => { __setGitRunner(null) })

// ─── 公共 fixture ───

const CID = "test-fixes"

function setupWt(root: string, wt: string): string {
  mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
  writeFileSync(
    join(wt, "openspec", "changes", CID, "tasks.md"),
    `## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2\n`,
    "utf-8",
  )
  return wt
}

function readStateSync(wt: string): any {
  const p = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8"))
}

function mockStateForUnit(overrides?: Partial<OrchestrateState>): OrchestrateState {
  return {
    changeId: "fix-unit",
    taskGroupId: "1",
    baseBranch: "main",
    taskGroups: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as OrchestrateState
}

function mockTgForUnit(overrides?: Partial<TaskGroupState>): TaskGroupState {
  return {
    id: "1",
    name: "G1",
    taskCount: 2,
    worktreePath: null,
    branchName: null,
    baseRef: null,
    executionBoundary: null,
    relevantSpecs: [],
    lastFilesChanged: [],
    status: "review",
    phases: {
      architect_review: { completed: true },
      review: {
        retryCount: 0,
        lastResolvedRetryCount: 0,
        tool: { completed: true },
        task: { completed: true },
        quality: {
          progress: Object.fromEntries(REVIEW_DIMENSIONS.map((d) => [d, "pending"])) as TaskGroupState["phases"]["review"]["quality"]["progress"],
        },
      },
    },
    tasks: [],
    issues: [],
    blockers: [],
    ...overrides,
  } as TaskGroupState
}

function mockIssue(overrides: Partial<IssueItem>): IssueItem {
  return {
    id: "i1",
    dimension: "architecture",
    sourcePhase: "quality",
    severity: "High",
    file: "src/Foo.java",
    line: 1,
    description: "issue",
    suggestion: "fix",
    status: "open",
    refixCount: 0,
    rootCauseGuess: null,
    exemptReason: null,
    rejectReason: null,
    ...overrides,
  }
}

// ─── 修复项 2+3: rejectReason 清除 ───

describe("修复项2+3: dev_submit / task_review_submit verified 清除 rejectReason", () => {
  test("rejected → dev_submit(submitted) → task_review_submit(verified) rejectReason 为 null", async () => {
    const root = `/tmp/fix23-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt),
      a = makeCtx("openspec-architect", wt),
      d = makeCtx("openspec-developer", wt),
      toolR = makeCtx("openspec-reviewer-tool", wt),
      taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },}, a)
    await set_worktree.execute({ change_id: CID }, o)
    const devWt = readStateSync(wt).taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/T.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    let state = readStateSync(wt)
    let tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)

    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    await task_review_submit.execute({change_id: CID, passed: false,
      verified_task_ids: ["2"], failed_task_ids: [{ task_id: "1", reason: "Incomplete" }],
      issues: [], fixed_issue_ids: [],}, taskR)

    state = readStateSync(wt)
    const t1AfterReject = state.taskGroups.find((g: any) => g.id === "1").tasks.find((t: any) => t.id === "1")
    expect(t1AfterReject.status).toBe("rejected")
    expect(t1AfterReject.rejectReason).toBe("Incomplete")

    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1"] }, d)

    state = readStateSync(wt)
    const t1AfterDev = state.taskGroups.find((g: any) => g.id === "1").tasks.find((t: any) => t.id === "1")
    expect(t1AfterDev.status).toBe("submitted")
    expect(t1AfterDev.rejectReason).toBeNull()

    await task_review_submit.execute({change_id: CID, passed: true,
      verified_task_ids: ["1"], failed_task_ids: [],
      issues: [], fixed_issue_ids: [],}, taskR)

    state = readStateSync(wt)
    const t1AfterVerified = state.taskGroups.find((g: any) => g.id === "1").tasks.find((t: any) => t.id === "1")
    expect(t1AfterVerified.status).toBe("verified")
    expect(t1AfterVerified.rejectReason).toBeNull()

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ─── 修复项 4: finalizeQualityPhase 仅看 quality 层遗留 blocking ───

describe("修复项4: finalizeQualityPhase 不被 tool 层遗留 blocking issue 影响", () => {
  test("quality 全维度 passed + tool 层 open blocking issue → complete", async () => {
    const tmpRoot = `/tmp/fix4-${Date.now()}`
    mkdirSync(tmpRoot, { recursive: true })

    const tg = mockTgForUnit({
      issues: [mockIssue({ id: "t1", sourcePhase: "tool", dimension: "style", severity: "High", status: "open" })],
    })
    for (const d of REVIEW_DIMENSIONS) {
      tg.phases.review.quality.progress[d] = "passed"
    }
    const state = mockStateForUnit({ taskGroups: [tg] })

    const raw = await finalizeQualityPhase(state, tg, "architecture", true, tmpRoot)
    const result = JSON.parse(raw)

    expect(result.status).toBe("ok")
    expect(result.phase).toBe("review=completed")

    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  })

  test("quality 全维度 passed + quality 层 open blocking issue → 回退", async () => {
    const tmpRoot = `/tmp/fix4b-${Date.now()}`
    mkdirSync(tmpRoot, { recursive: true })

    const tg = mockTgForUnit({
      issues: [mockIssue({ id: "q1", sourcePhase: "quality", dimension: "style", severity: "High", status: "open" })],
    })
    for (const d of REVIEW_DIMENSIONS) {
      tg.phases.review.quality.progress[d] = "passed"
    }
    const state = mockStateForUnit({ taskGroups: [tg] })

    const raw = await finalizeQualityPhase(state, tg, "architecture", true, tmpRoot)
    const result = JSON.parse(raw)

    expect(result.status).toBe("recorded")
    expect(result.passed).toBe(false)

    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  })
})

// ─── 修复项 6: deduplicateAndAddIssues 跨层去重区分 sourcePhase ───

describe("修复项6: deduplicateAndAddIssues 跨层去重区分 sourcePhase", () => {
  test("同 file/line/description 不同 sourcePhase 不去重", () => {
    const existing: IssueItem[] = [mockIssue({
      id: "e1", dimension: "style", sourcePhase: "tool",
      file: "src/Dup.java", line: 10, description: "dup desc", status: "open",
    })]

    const res = deduplicateAndAddIssues(
      [{ severity: "Low", file: "src/Dup.java", line: 10, description: "dup desc", suggestion: "fix" }],
      existing, "style", "quality", 100,
    )

    expect(res.dedupedCount).toBe(0)
    expect(res.newIssues).toHaveLength(1)
    expect(res.newIssues[0].sourcePhase).toBe("quality")
    expect(res.nextIssueId).toBe(101)
  })

  test("同 file/line/description 同 sourcePhase 去重", () => {
    const existing: IssueItem[] = [mockIssue({
      id: "e1", dimension: "style", sourcePhase: "tool",
      file: "src/Dup.java", line: 10, description: "dup desc", status: "open",
    })]

    const res = deduplicateAndAddIssues(
      [{ severity: "Low", file: "src/Dup.java", line: 10, description: "dup desc", suggestion: "fix" }],
      existing, "style", "tool", 100,
    )

    expect(res.dedupedCount).toBe(1)
    expect(res.newIssues).toHaveLength(0)
    expect(res.nextIssueId).toBe(100)
  })
})

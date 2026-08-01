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

import { __setGitRunner } from "../src/core/git"
import {
  init, set_worktree, arch_submit, dev_submit,
  tool_review_submit, task_review_submit, quality_review_submit
} from "../src/adapters/opencode/tools"
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
    const raw = await tool_review_submit.execute({change_id: CID, passed: false,
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
    ).rejects.toThrow(/passed=true.*Low\+/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── Scene D: quality 层维度过滤（仅同维度 quality blocking issue 阻塞） ──

describe("sourcePhase D: quality 层按 dimension 过滤 blocking issue", () => {
  async function completeToolTask(wt: string): Promise<void> {
    const toolR = makeCtx("openspec-reviewer-tool", wt),
      taskR = makeCtx("openspec-reviewer-task", wt)
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({
      change_id: CID, passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: []
    }, taskR)
  }

  test("style failed 遗留 open issue 不阻塞 architecture passed=true（status=partial）", async () => {
    const root = `/tmp/sourcePhase-D1-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    await setupToReview(root, wt, fakeGit)
    await completeToolTask(wt)

    // style 维度先提交 passed=false 并报 1 个 Low+ quality issue
    const styleR = makeCtx("openspec-reviewer-style", wt)
    const raw1 = await quality_review_submit.execute({ change_id: CID, passed: false,
      issues: [{ severity: "Low", file: "d.md", line: 1, dimension: "style" as any,
        description: "Style residual issue", suggestion: "Fix naming" }],
      fixed_issue_ids: [] }, styleR)
    const r1 = JSON.parse(typeof raw1 === "string" ? raw1 : raw1.output)
    expect(r1.status).toBe("partial")

    // architecture 维度提交 passed=true 不应被 style 的 open issue 阻塞
    const archR = makeCtx("openspec-reviewer-architecture", wt)
    const raw2 = await quality_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, archR)
    const r2 = JSON.parse(typeof raw2 === "string" ? raw2 : raw2.output)
    expect(r2.status).toBe("partial")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("同维度遗留 open quality issue → passed=true rejects（抛错含 passed=true/Low+）", async () => {
    const root = `/tmp/sourcePhase-D2-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    await setupToReview(root, wt, fakeGit)
    await completeToolTask(wt)

    // 注入 architecture 同维度遗留 open quality issue
    const state = readStateSync(wt)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    tg.issues.push(makeSeedIssue({
      id: "a1",
      dimension: "architecture",
      sourcePhase: "quality",
      severity: "High",
      description: "Architecture residual issue",
    }))
    writeFileSync(
      join(wt, ".opencode", ".orchestrate_state", `${CID}.json`),
      JSON.stringify(state), "utf-8"
    )

    const archR = makeCtx("openspec-reviewer-architecture", wt)
    await expect(
      quality_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, archR)
    ).rejects.toThrow(/passed=true.*Low\+/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("同维度遗留 rejected quality issue → passed=true rejects（枚举 issue + 引导文案）", async () => {
    const root = `/tmp/sourcePhase-D2b-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    await setupToReview(root, wt, fakeGit)
    await completeToolTask(wt)

    const state = readStateSync(wt)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    tg.issues.push(makeSeedIssue({
      id: "a1",
      dimension: "architecture",
      sourcePhase: "quality",
      severity: "High",
      status: "rejected",
      rejectReason: "修复不达标",
      description: "Architecture rejected issue",
    }))
    writeFileSync(
      join(wt, ".opencode", ".orchestrate_state", `${CID}.json`),
      JSON.stringify(state), "utf-8"
    )

    const archR = makeCtx("openspec-reviewer-architecture", wt)
    await expect(
      quality_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, archR)
    ).rejects.toThrow(/passed=true.*Low\+.*#a1\(High\/rejected\/architecture\).*被驳回（rejected）的 issue 仍为未解决阻塞.*fixed_issue_ids/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("5 维 dispatch 完成（4 passed + style failed）→ retry 回 dev_impl，遗留 style issue 未逃逸", async () => {
    const root = `/tmp/sourcePhase-D3-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    await setupToReview(root, wt, fakeGit)
    await completeToolTask(wt)

    // style failed 报 1 个 Low+ issue
    const styleR = makeCtx("openspec-reviewer-style", wt)
    await quality_review_submit.execute({ change_id: CID, passed: false,
      issues: [{ severity: "Low", file: "d.md", line: 1, dimension: "style" as any,
        description: "Style residual issue", suggestion: "Fix naming" }],
      fixed_issue_ids: [] }, styleR)

    // 其余 4 维 passed=true
    for (const d of ["architecture", "performance", "security", "maintainability"]) {
      await quality_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, makeCtx(`openspec-reviewer-${d}`, wt))
    }

    const state = readStateSync(wt)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.status).toBe("dev_impl")
    expect(tg.phases.review.retryCount).toBe(1)
    const residual = tg.issues.find((i: any) => i.sourcePhase === "quality" && i.dimension === "style")
    expect(residual).toBeTruthy()
    expect(residual.status).toBe("open")
    expect(tg.phases.review.quality.progress.style).toBe("failed")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

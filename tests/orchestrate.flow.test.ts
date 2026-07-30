/**
 * 编排流程测试：完整端到端场景
 *
 * 每个场景独立运行，无共享状态。全部走 fake-git（零 git 依赖）。
 * 每步从磁盘读回 state.json 断言，验证状态机在实际编排流程中的正确迁移。
 *
 * 运行：bun test
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  init,
  status,
  set_worktree,
  arch_submit,
  dev_submit,
  tool_review_submit,
  task_review_submit,
  quality_review_submit,
  resolve_review,
  complete_task_group,
  MAX_RETRIES,
  __setGitRunner} from "../src/tools/orchestrate"
import { FakeGitRunner, makeCtx } from "./helpers"

const CID = "test-flow"

afterAll(() => { __setGitRunner(null) })

type Ctx = ReturnType<typeof makeCtx>

function readStateSync(wt: string, cid: string): any {
  const p = join(wt, ".opencode", ".orchestrate_state", `${cid}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8"))
}

const FORBIDDEN_ORCHESTRATION = [
  "从 tool 层", "从 task 层", "从 quality 层",
  "请分派", "请调用",
  "进入 review", "进入 quality", "进入 task", "进入 dev",
  "重新开始",
  "下一步：",
]

function expectNoOrchestration(msg: string | undefined) {
  expect(msg).toBeDefined()
  expect(typeof msg).toBe("string")
  for (const p of FORBIDDEN_ORCHESTRATION) {
    expect(msg!).not.toContain(p)
  }
  expect(msg).toContain("职责已完成，请立即结束当前会话")
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

async function setupThroughQualityReady(
  wt: string,
  fakeGit: FakeGitRunner,
  ctx: {
    orch: Ctx; arch: Ctx; dev: Ctx; toolReviewer: Ctx; taskReviewer: Ctx
  }
): Promise<void> {
  await init.execute({ change_id: CID, task_group_id: "1" }, ctx.orch)
  await arch_submit.execute({change_id: CID, outcome: "ready",
    execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, ctx.arch)
  await set_worktree.execute({ change_id: CID }, ctx.orch)
  const s1 = readStateSync(wt, CID)
  const devWt = s1.taskGroups.find((g: any) => g.id === "1").worktreePath
  fakeGit.diffs.set(devWt, ["src/F1.java"])
  await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, ctx.dev)

  const s2 = readStateSync(wt, CID)
  const tg = s2.taskGroups.find((g: any) => g.id === "1")
  if (!tg.phases.review.tool.completed) {
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, ctx.toolReviewer)
  }
  if (!tg.phases.review.task.completed) {
    await task_review_submit.execute({change_id: CID, passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [],
      fixed_issue_ids: []}, ctx.taskReviewer)
  }
}

/** 将当前状态推进到 review 阶段。传 exemptIds 可在 tool+task 层处理完整性门禁。 */
async function transitionToReview(
  wt: string, orch: Ctx, toolReviewer: Ctx, taskReviewer: Ctx,
  exemptIds?: string[]
): Promise<void> {
  const state = readStateSync(wt, CID)
  if (!state) return
  const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, orch)
    await set_worktree.execute({ change_id: CID }, orch)

  const s2 = readStateSync(wt, CID)
  const tg2 = s2.taskGroups.find((g: any) => g.id === "1")
  if (!tg2.phases.review.tool.completed) {
    await tool_review_submit.execute({change_id: CID, passed: true, issues: [],
      exempt_issue_ids: exemptIds || [],
      fixed_issue_ids: []}, toolReviewer)
  }
  if (!tg2.phases.review.task.completed) {
    await task_review_submit.execute({change_id: CID, passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [],
      fixed_issue_ids: []}, taskReviewer)
  }
}

// ═══════════════════════════════════════════════════
//  Scenario 1: 完整 Happy Path
// ═══════════════════════════════════════════════════

describe("1. Happy Path — 完整流程", () => {
  test("init → arch_submit → set_worktree → dev_submit → tool→task→5 dim quality → complete", async () => {
    const root = `/tmp/ft1-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    // 1. init
    const r0 = JSON.parse(await init.execute({ change_id: CID, task_group_id: "1" }, o))
    expect(r0.status).toBe("initialized")
    expect(r0.active_phase).toBe("task_analysis")
    expect(r0.current_task_group.id).toBe("1")
    expect(r0.task_group_count).toBe(2)

    let state = readStateSync(wt, CID)
    expect(state.taskGroupId).toBe("1")
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.status).toBe("task_analysis")
    expect(tg.phases.architect_review.completed).toBe(false)
    expect(tg.tasks).toHaveLength(2)

    // 2. arch_submit passed
    const r1 = JSON.parse(await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a))
    expect(r1.status).toBe("ok")
    expect(r1.phase).toBe("dev_impl")
    expectNoOrchestration(r1.message)

    state = readStateSync(wt, CID)
    const tg1 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg1.phases.architect_review.completed).toBe(true)
    expect(tg1.executionBoundary.allowed_directories).toContain("src")

    // 3. set_worktree
    const r2 = await set_worktree.execute({ change_id: CID }, o)
    expect(r2).toContain("已创建 worktree")
    expect(r2).toContain("**状态**")

    state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.status).toBe("dev_impl")
    expect(tg2.worktreePath).not.toBeNull()
    expect(tg2.baseRef).toBe(fakeGit.baseRef)

    // 4. dev_submit
    const devWt = tg2.worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    const r3 = JSON.parse(await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d))
    expect(r3.status).toBe("ok")
    expect(r3.active_phase).toBe("review")
    expectNoOrchestration(r3.message)

    state = readStateSync(wt, CID)
    const tg3 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg3.tasks.every((t: any) => t.status === "submitted")).toBe(true)
    expect(tg3.lastFilesChanged).toContain("src/F1.java")
    expect(tg3.status).toBe("review")



    const rr1 = JSON.parse(await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: []}, toolR))
    expect(rr1.status).toBe("ok")
    expect(rr1.phase).toBe("review(tool=completed)")
    expectNoOrchestration(rr1.message)

    const rr2 = JSON.parse(await task_review_submit.execute({change_id: CID, passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [],
      fixed_issue_ids: []}, taskR))
    expect(rr2.status).toBe("ok")
    expect(rr2.phase).toBe("review(task=completed)")
    expectNoOrchestration(rr2.message)

    state = readStateSync(wt, CID)
    const tg6 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg6.status).toBe("review")

    // 6. 5 dimension quality reviewers all pass (首轮)
    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const agent = `openspec-reviewer-${dims[i]}`
      const result = JSON.parse(await quality_review_submit.execute({ change_id: CID, passed: true, issues: []}, makeCtx(agent, wt)))
      if (i < dims.length - 1) {
        expect(result.status).toBe("partial")
        expectNoOrchestration(result.message)
      } else {
        expect(result.status).toBe("ok")
        expect(result.phase).toBe("review=completed")
        expectNoOrchestration(result.message)
      }
    }

    state = readStateSync(wt, CID)
    const tg7 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg7.phases.review.tool.completed).toBe(true)
    expect(tg7.phases.review.task.completed).toBe(true)
    for (const d of ["style", "architecture", "performance", "security", "maintainability"]) {
      expect(tg7.phases.review.quality.progress[d]).toBe("passed")
    }

    // 7. complete_task_group
    const r5 = JSON.parse(await complete_task_group.execute({ change_id: CID }, o))
    expect(r5.status).toBe("ok")
    expect(r5.completed_task_group).toBe("1")

    state = readStateSync(wt, CID)
    const tg8 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg8.status).toBe("completed")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 2: task reviewer 2 次驳回 → 修复 → 全部通过
// ═══════════════════════════════════════════════════

describe("2. 完整流程（无驳回）", () => {
  test("init → arch_submit → set_worktree → dev_submit → tool→task→5 dim → complete", async () => {
    const root = `/tmp/ft2-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)

    let state = readStateSync(wt, CID)
    expect(state.taskGroupId).toBe("1")
    let tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.status).toBe("task_analysis")
    expect(tg.phases.architect_review.completed).toBe(false)

    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)

    state = readStateSync(wt, CID)
    tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.phases.architect_review.completed).toBe(true)
    expect(tg.executionBoundary).toBeDefined()

    await set_worktree.execute({ change_id: CID }, o)

    state = readStateSync(wt, CID)
    const tgWt = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgWt.status).toBe("dev_impl")
    expect(tgWt.worktreePath).not.toBeNull()
    const devWt = tgWt.worktreePath

    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    state = readStateSync(wt, CID)
    const tgDev = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgDev.tasks.every((t: any) => t.status === "submitted")).toBe(true)

    await transitionToReview(wt, o, toolR, taskR)

    state = readStateSync(wt, CID)
    const tgReview = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgReview.phases.review.tool.completed).toBe(true)
    expect(tgReview.phases.review.task.completed).toBe(true)

    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const res = JSON.parse(await quality_review_submit.execute({ change_id: CID, passed: true, issues: []}, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      if (i === dims.length - 1) expect(res.status).toBe("ok")
    }

    state = readStateSync(wt, CID)
    const tgQ = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgQ.phases.review.tool.completed).toBe(true)
    expect(tgQ.phases.review.task.completed).toBe(true)
    for (const d of ["style", "architecture", "performance", "security", "maintainability"]) {
      expect(tgQ.phases.review.quality.progress[d]).toBe("passed")
    }

    await complete_task_group.execute({ change_id: CID }, o)
    state = readStateSync(wt, CID)
    const tgEnd = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgEnd.status).toBe("completed")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 3: 架构师复核驳回 → 修复 → 重新提交 → 完成全部流程
// ═══════════════════════════════════════════════════

describe("3. 架构师通过 → 完成全部流程", () => {
  test("init → arch_submit(passed=true) → set_worktree → dev → tool→task→5 dim → complete", async () => {
    const root = `/tmp/ft3-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)

    const r1 = JSON.parse(await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a))
    expect(r1.status).toBe("ok")

    let state = readStateSync(wt, CID)
    const tg1 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg1.phases.architect_review.completed).toBe(true)

    await set_worktree.execute({ change_id: CID }, o)
    state = readStateSync(wt, CID)
    fakeGit.diffs.set(state.taskGroups.find((g: any) => g.id === "1").worktreePath, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    await transitionToReview(wt, o, toolR, taskR)

    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const res = JSON.parse(await quality_review_submit.execute({ change_id: CID, passed: true, issues: []}, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      if (i < dims.length - 1) expect(res.status).toBe("partial")
      else expect(res.status).toBe("ok")
    }

    await complete_task_group.execute({ change_id: CID }, o)
    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").status).toBe("completed")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 4: 豁免裁定 — tool 层通过 exempt_issue_ids 授权
// ═══════════════════════════════════════════════════

describe("4. 豁免裁定 — tool 层通过 exempt_issue_ids 授权", () => {
  test("style quality 报 Info issue → dev 申请豁免 → tool 层 grant → exempted", async () => {
    const root = `/tmp/ft4-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await setupThroughQualityReady(wt, fakeGit, { orch: o, arch: a, dev: d, toolReviewer: toolR, taskReviewer: taskR })
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath

    // Quality all pass with Info issue (non-blocking → passed=true still works)
    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const args: any = { change_id: CID, task_group_id: "1", passed: true, issues: [] }
      if (i === 0) {
        args.issues = [{ severity: "Info", file: "src/x.java", line: 1, description: "Style info", suggestion: "Consider" }]
      }
      const res = JSON.parse(await quality_review_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      if (i < dims.length - 1) expect(res.status).toBe("partial")
      else expect(res.status).toBe("ok")
    }

    state = readStateSync(wt, CID)
    const issueId = state.taskGroups.find((g: any) => g.id === "1").issues[0].id

    // dev_submit in review: request exemption for Info issue
    fakeGit.diffs.set(devWt, [])
    await dev_submit.execute({change_id: CID, completed_task_ids: ["1", "2"], fixed_issue_ids: [issueId],
      request_exempts: [{ issue_id: issueId, reason: "Trivial" }]}, d)

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).status).toBe("exemption_requested")

    // dev_submit reset layers. Re-run with exemption handling.
    await transitionToReview(wt, o, toolR, taskR, [issueId])

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).status).toBe("exempted")

    // Quality re-run — only affected dim
    const res = JSON.parse(await quality_review_submit.execute({ change_id: CID, passed: true, issues: []}, makeCtx("openspec-reviewer-style", wt)))
    expect(res.status).toBe("ok")
    expect(res.phase).toBe("review=completed")

    try { rmSync(root, { recursive: true, force: true })} catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 5: Recovery — dev_impl 阶段
// ═══════════════════════════════════════════════════

describe("5. Recovery — dev_impl 阶段恢复", () => {
  test("init → arch_submit → set_worktree → dev_submit → re-init recovery → 验证状态保留", async () => {
    const root = `/tmp/ft5-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)

    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").tasks.every((t: any) => t.status === "submitted")).toBe(true)

    const r = JSON.parse(await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "dev_impl" }}, o))
    expect(r.status).toBe("initialized")
    expect(r.active_phase).toBe("dev_impl")
    await set_worktree.execute({ change_id: CID }, o)

    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.phases.architect_review.completed).toBe(true)
    expect(tg.tasks.every((t: any) => t.status === "submitted")).toBe(true)
    expect(tg.worktreePath).toBe(devWt)
    expect(tg.branchName).toBe("task-group/test-flow/1")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 6: Recovery — review 阶段（保留 issues）
// ═══════════════════════════════════════════════════

describe("6. Recovery — review 阶段恢复（保留 issues）", () => {
  test("setup through review → style fails → re-init recovery → 验证 issues 被保留", async () => {
    const root = `/tmp/ft6-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)
    const sCtx = makeCtx("openspec-reviewer-style", wt)

    await setupThroughQualityReady(wt, fakeGit, { orch: o, arch: a, dev: d, toolReviewer: toolR, taskReviewer: taskR })

    // Create an issue via quality review
    await quality_review_submit.execute({change_id: CID, passed: false,
      issues: [{ severity: "Low", file: "src/x.java", line: 1, description: "Style issue", suggestion: "Fix" }]}, sCtx)

    let state = readStateSync(wt, CID)
    const origIssueId = state.taskGroups.find((g: any) => g.id === "1").issues[0].id
    const origIssueDesc = state.taskGroups.find((g: any) => g.id === "1").issues[0].description

    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    const r = JSON.parse(await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o))
    expect(r.status).toBe("initialized")
    expect(r.active_phase).toBe("review")

    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.phases.architect_review.completed).toBe(true)
    expect(tg.issues).toHaveLength(1)
    expect(tg.issues[0].id).toBe(origIssueId)
    expect(tg.issues[0].status).toBe("open")
    expect(tg.issues[0].description).toBe(origIssueDesc)
    expect(tg.tasks.every((t: any) => t.status === "verified")).toBe(true)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 7: 多任务组 — 完成组1 → 初始化组2
// ═══════════════════════════════════════════════════

describe("7. 多任务组 — 完成 group1 → 初始化 group2", () => {
  test("init group1 → complete → init group2 → 验证 group2 独立", async () => {
    const root = `/tmp/ft7-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    let state = readStateSync(wt, CID)
    fakeGit.diffs.set(state.taskGroups.find((g: any) => g.id === "1").worktreePath, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    await transitionToReview(wt, o, toolR, taskR)

    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      await quality_review_submit.execute({ change_id: CID, passed: true, issues: []}, makeCtx(`openspec-reviewer-${dims[i]}`, wt))
    }

    await complete_task_group.execute({ change_id: CID }, o)

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").status).toBe("completed")
    expect(state.taskGroupId).toBe("1")

    const r2 = JSON.parse(await init.execute({ change_id: CID, task_group_id: "2" }, o))
    expect(r2.status).toBe("initialized")
    expect(r2.current_task_group.id).toBe("2")

    state = readStateSync(wt, CID)
    const g1 = state.taskGroups.find((g: any) => g.id === "1")
    expect(g1.status).toBe("completed")

    const g2 = state.taskGroups.find((g: any) => g.id === "2")
    expect(g2.status).toBe("task_analysis")
    expect(g2.phases.architect_review.completed).toBe(false)
    expect(g2.tasks).toHaveLength(1)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 8: Recovery — task_analysis 阶段
// ═══════════════════════════════════════════════════

describe("8. Recovery — task_analysis 阶段（回退）", () => {
  test("init → arch_submit → re-init recovery to task_analysis → 可重新提交 arch", async () => {
    const root = `/tmp/ft8-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)

    const r = JSON.parse(await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "task_analysis" }}, o))
    expect(r.status).toBe("initialized")
    expect(r.active_phase).toBe("task_analysis")

    let state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.status).toBe("task_analysis")
    expect(tg.phases.architect_review.completed).toBe(false)
    expect(tg.tasks.every((t: any) => t.status === "open")).toBe(true)

    const r2 = JSON.parse(await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a))
    expect(r2.status).toBe("ok")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 9: task 层豁免
// ═══════════════════════════════════════════════════

describe("9. 豁免裁定 — tool+task 层 via exempt_issue_ids", () => {
  test("task reviewer 报 issue → dev 申请豁免 → tool 层 grant → exempted", async () => {
    const root = `/tmp/ft9-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)

    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])

    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    // init recovery + tool pass + task reject + report issue
    const s1 = readStateSync(wt, CID)
    const tg1 = s1.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({change_id: CID, passed: false,
      verified_task_ids: ["2"], failed_task_ids: [{ task_id: "1", reason: "Incomplete" }],
      issues: [{ severity: "Info", file: "src/F1.java", line: 5, description: "Exceeds 80 col", suggestion: "Wrap" }],
      fixed_issue_ids: []}, taskR)

    state = readStateSync(wt, CID)
    const issueId = state.taskGroups.find((g: any) => g.id === "1").issues[0].id
    expect(issueId).toBeDefined()

    // Dev fixes + exemption via review phase dev_submit
    fakeGit.diffs.set(devWt, ["src/F1.java", "src/F2.java"])
    const s2 = readStateSync(wt, CID)
    const tg2 = s2.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)
    await dev_submit.execute({change_id: CID, completed_task_ids: ["1", "2"], fixed_issue_ids: [issueId],
      request_exempts: [{ issue_id: issueId, reason: "Team convention" }]}, d)

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).status).toBe("exemption_requested")
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).exemptReason).toBe("Team convention")

    // dev_submit reset layers. Re-run with exemption handled.
    await transitionToReview(wt, o, toolR, taskR, [issueId])

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).status).toBe("exempted")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("task reviewer 报 issue → dev 申请豁免 → tool 层 reject → rejected", async () => {
    const root = `/tmp/ft9b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)

    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])

    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    // init recovery + tool pass + task reject + issue
    const s1 = readStateSync(wt, CID)
    const tg1 = s1.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({change_id: CID, passed: false,
      verified_task_ids: ["2"], failed_task_ids: [{ task_id: "1", reason: "Incomplete" }],
      issues: [{ severity: "Info", file: "src/F1.java", line: 5, description: "Exceeds 80 col", suggestion: "Wrap" }],
      fixed_issue_ids: []}, taskR)

    state = readStateSync(wt, CID)
    const issueId = state.taskGroups.find((g: any) => g.id === "1").issues[0].id

    // Dev fixes + exemption via review phase
    fakeGit.diffs.set(devWt, ["src/F1.java", "src/F2.java"])
    const s2 = readStateSync(wt, CID)
    const tg2 = s2.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)
    await dev_submit.execute({change_id: CID, completed_task_ids: ["1", "2"], fixed_issue_ids: [issueId],
      request_exempts: [{ issue_id: issueId, reason: "Team convention" }]}, d)

    // dev_submit reset layers. Re-run: tool rejects, then task passes.
    const s3 = readStateSync(wt, CID)
    const tg3 = s3.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)
    await tool_review_submit.execute({change_id: CID, passed: true, issues: [], fixed_issue_ids: [],
      rejected_issue_ids: [{issue_id: issueId, reason: "Testing rejection reason"}]}, toolR)
    await task_review_submit.execute({change_id: CID, passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [],
      fixed_issue_ids: []}, taskR)

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).status).toBe("rejected")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 10: quality 层豁免
// ═══════════════════════════════════════════════════

describe("10. quality 层豁免 — quality reviewer 裁定", () => {
  test("style reports Info issue → dev 申请豁免 → tool 层 pass through → exempted", async () => {
    const root = `/tmp/ft10-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await setupThroughQualityReady(wt, fakeGit, { orch: o, arch: a, dev: d, toolReviewer: toolR, taskReviewer: taskR })
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath

    // Quality all pass with Info issue (non-blocking → passed=true still works)
    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const args: any = { change_id: CID, task_group_id: "1", passed: true, issues: [] }
      if (i === 0) {
        args.issues = [{ severity: "Info", file: "src/x.java", line: 1, description: "Style info", suggestion: "Consider" }]
      }
      const res = JSON.parse(await quality_review_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      if (i < dims.length - 1) expect(res.status).toBe("partial")
      else expect(res.status).toBe("ok")
    }

    state = readStateSync(wt, CID)
    const issueId = state.taskGroups.find((g: any) => g.id === "1").issues[0].id

    // dev_submit in review with exemption
    fakeGit.diffs.set(devWt, [])
    await dev_submit.execute({change_id: CID, completed_task_ids: ["1", "2"], fixed_issue_ids: [issueId],
      request_exempts: [{ issue_id: issueId, reason: "Trivial" }]}, d)

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).status).toBe("exemption_requested")

    // dev_submit reset layers. Re-run with exemption.
    await transitionToReview(wt, o, toolR, taskR, [issueId])

    // Quality — only affected dim, issue already exempted
    const res = JSON.parse(await quality_review_submit.execute({ change_id: CID, passed: true, issues: []}, makeCtx("openspec-reviewer-style", wt)))
    expect(res.status).toBe("ok")
    expect(res.phase).toBe("review=completed")

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).status).toBe("exempted")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 11: quality 层阻塞 issue 阻止完成
// ═══════════════════════════════════════════════════

describe("11. 守卫 — quality 阶段阻塞 issue", () => {
  test("quality review 中存在未解决阻塞 issue 时最后一维返回 rejected", async () => {
    const root = `/tmp/ft11-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await setupThroughQualityReady(wt, fakeGit, { orch: o, arch: a, dev: d, toolReviewer: toolR, taskReviewer: taskR })

    let lastResult: any
    const passDims = ["architecture", "performance", "security", "maintainability"]
    for (const d of passDims) {
      const res = JSON.parse(await quality_review_submit.execute({ change_id: CID, task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, makeCtx(`openspec-reviewer-${d}`, wt)))
    }
    // style 最后提交，此时已有阻塞 issue → passed=false 才合法
    lastResult = JSON.parse(await quality_review_submit.execute({ change_id: CID, task_group_id: "1", passed: false,
      issues: [{ severity: "High", file: "src/x.java", line: 1, description: "Critical issue", suggestion: "Fix it" }],
      fixed_issue_ids: [] }, makeCtx("openspec-reviewer-style", wt)))
    expect(lastResult.status).toBe("recorded")
    expectNoOrchestration(lastResult.message)
    expect(lastResult.failed_dimensions).toBeDefined()
    expect(lastResult.has_residual_blocking).toBe(true)

    const state = readStateSync(wt, CID)
    const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgAfter.phases.review.retryCount).toBe(1)
    expect(tgAfter.status).toBe("dev_impl")
    // 仅报 issue 的 style 维度 failed，其余维度正常 passed
    expect(tgAfter.phases.review.quality.progress.style).toBe("failed")
    expect(tgAfter.phases.review.quality.progress.architecture).toBe("passed")
    expect(tgAfter.phases.review.quality.progress.performance).toBe("passed")
    expect(tgAfter.phases.review.quality.progress.security).toBe("passed")
    expect(tgAfter.phases.review.quality.progress.maintainability).toBe("passed")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 12: resolve_review — continue / giveup
// ═══════════════════════════════════════════════════

describe("12. resolve_review — continue / giveup", () => {
  test("continue — tool 3 轮失败 → needs_user_decision → resolve_review(continue) → 可重新从 tool 开始", async () => {
    const root = `/tmp/ft12-continue-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt),
         a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt)

    try {
      // 1. init → arch → set_worktree → dev_submit
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      await arch_submit.execute({change_id: CID, outcome: "ready",
        execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
      await set_worktree.execute({ change_id: CID }, o)
      let state = readStateSync(wt, CID)
      const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
      fakeGit.diffs.set(devWt, ["src/F1.java"])
      await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

      // 2. ${MAX_RETRIES} 轮 tool 失败（审查重试达到检查点 retryCount=${MAX_RETRIES}）：
      //    - 前 ${MAX_RETRIES - 1} 轮 rejected（→dev_submit 修复）
      //    - 第 ${MAX_RETRIES} 轮 needs_user_decision
      // 每轮需通过 init(recovery to review)→dev_submit(review mode)
      // 重置 tool.completed 后才能再次提交 tool
      let prevIssue: string | undefined
      for (let round = 1; round <= MAX_RETRIES; round++) {
        state = readStateSync(wt, CID)
        const tg = state.taskGroups.find((g: any) => g.id === "1")
        await init.execute({
          change_id: CID, task_group_id: "1",
          recovery: { phase: "review" }}, o)
        await set_worktree.execute({ change_id: CID }, o)

        if (round > 1) {
          fakeGit.diffs.set(devWt, [`src/FR${round - 1}.java`])
          await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"],
            fixed_issue_ids: prevIssue ? [prevIssue] : [] }, d)
        }

        const r = JSON.parse(await tool_review_submit.execute({ change_id: CID, passed: false,
          issues: [{ severity: "Low", file: "src/x.java", line: 1, dimension: "style" as any, description: "Tool issue", suggestion: "Fix" }],
          fixed_issue_ids: prevIssue ? [prevIssue] : []}, toolR))

        expectNoOrchestration(r.message)
        if (round < MAX_RETRIES) {
          expect(r.status).toBe("recorded")
          expect(r.retry_count).toBe(round)
        } else {
          expect(r.status).toBe("recorded")
        }

        state = readStateSync(wt, CID)
        const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
        prevIssue = tgAfter.issues.length > 0 ? tgAfter.issues[tgAfter.issues.length - 1].id : undefined
      }

      // 3. resolve_review(continue) — 不再重置 retryCount
      const rc = JSON.parse(await resolve_review.execute({ change_id: CID, decision: "continue" }, o))
      expect(rc.status).toBe("ok")
      expect(rc.decision).toBe("continue")

      state = readStateSync(wt, CID)
      const tgS = state.taskGroups.find((g: any) => g.id === "1")
      expect(tgS.phases.review.retryCount).toBe(MAX_RETRIES)
      expect(tgS.phases.review.tool.completed).toBe(false)
      expect(tgS.phases.review.task.completed).toBe(false)
      expect(tgS.status).toBe("dev_impl")

      // 验证 developer opx_status 通过门禁
      const ds = await status.execute({ change_id: CID }, d)
      expect(ds).toContain("当前轮到你执行")

      // 4. 验证可重新从 tool 层开始
      fakeGit.diffs.set(devWt, ["src/F5.java"])
      await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"],
        fixed_issue_ids: prevIssue ? [prevIssue] : [] }, d)

      const r5 = JSON.parse(await tool_review_submit.execute({ change_id: CID, passed: true, issues: [],
        fixed_issue_ids: prevIssue ? [prevIssue] : []}, toolR))
      expect(r5.status).toBe("ok")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("giveup — quality 3 轮失败 → needs_user_decision → resolve_review(giveup) → blocking issue exempted + review completed", async () => {
    const root = `/tmp/ft12-giveup-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt),
         a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    try {
      // 1. 标准 setup 到 quality ready（tool + task pass）
      await setupThroughQualityReady(wt, fakeGit, { orch: o, arch: a, dev: d, toolReviewer: toolR, taskReviewer: taskR })
      let state = readStateSync(wt, CID)
      const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath

      // 2. Round 1: 5 维 quality 全提交，style 报阻塞 issue → retryCount=1
      let lastRes: any
      const passDimsG = ["architecture", "performance", "security", "maintainability"]
      for (const d of passDimsG) {
        await quality_review_submit.execute({ change_id: CID, task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, makeCtx(`openspec-reviewer-${d}`, wt))
      }
      lastRes = JSON.parse(await quality_review_submit.execute({ change_id: CID, task_group_id: "1", passed: false,
        issues: [{ severity: "Low", file: "src/x.java", line: 1, description: "Style blocking issue", suggestion: "Fix style" }],
        fixed_issue_ids: [] }, makeCtx("openspec-reviewer-style", wt)))
      expect(lastRes.status).toBe("recorded")
      expectNoOrchestration(lastRes.message)
      expect(lastRes.retry_count).toBe(1)

      // Rounds 2-5：recovery → dev_submit（重置 progress）→ quality submit（仅 style 维度）。
      for (let round = 2; round <= MAX_RETRIES; round++) {
        state = readStateSync(wt, CID)
        const tg = state.taskGroups.find((g: any) => g.id === "1")
        await init.execute({
          change_id: CID, task_group_id: "1",
          recovery: { phase: "review" }}, o)
        await set_worktree.execute({ change_id: CID }, o)

        // progress 不再自动清空，需 dev_submit 重置
        fakeGit.diffs.set(devWt, ["src/F1.java"])
        const prevState = readStateSync(wt, CID)
        const prevIssueId = prevState.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.status === "open")?.id
        await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"], fixed_issue_ids: prevIssueId ? [prevIssueId] : [] }, d)

        // quality reviewer 须裁定 dev 刚提交的 issue
        const afterDev = readStateSync(wt, CID)
        const submittedIssueId = afterDev.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.status === "submitted")?.id

        lastRes = JSON.parse(await quality_review_submit.execute({change_id: CID, passed: false,
          issues: [{ severity: "Low", file: "src/x.java", line: round, description: `Blocking issue round ${round}`, suggestion: "Fix" }],
          fixed_issue_ids: submittedIssueId ? [submittedIssueId] : []}, makeCtx("openspec-reviewer-style", wt)))

        expectNoOrchestration(lastRes.message)
        if (round < MAX_RETRIES) {
          expect(lastRes.status).toBe("recorded")
          expect(lastRes.retry_count).toBe(round)
        } else {
          expect(lastRes.status).toBe("recorded")
        }
      }

      // 3. resolve_review(giveup)
      const rg = JSON.parse(await resolve_review.execute({ change_id: CID, decision: "giveup" }, o))
      expect(rg.status).toBe("ok")
      expect(rg.decision).toBe("giveup")
      expect(rg.exempted_count).toBeGreaterThan(0)

      state = readStateSync(wt, CID)
      const tgG = state.taskGroups.find((g: any) => g.id === "1")
      // giveup 标记所有子层完成，确保 isReviewCompleted 放行
      expect(tgG.phases.review.tool.completed).toBe(true)
      expect(tgG.phases.review.task.completed).toBe(true)
      expect(tgG.phases.review.quality.progress.style).toBe("passed")
      // giveup 将所有 open/rejected/submitted/exemption_requested 的 blocking issue 置为 exempted
      for (const issue of tgG.issues) {
        expect(["exempted", "verified"]).toContain(issue.status)
      }
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 13: 去阶段化 — dev 在 dev_impl 状态下可见 review issue
// ═══════════════════════════════════════════════════

describe("13. 去阶段化 — dev 在 dev_impl 状态下可见 review issue", () => {
  test("quality 报 issue → status=dev_impl → dev opx_status 可见 issue → 修复提交后自动回 review", async () => {
    const root = `/tmp/ft13-${Date.now()}`
    const wt = (() => {
      const dir = root
      const w = root + "/w"
      mkdirSync(join(w, "openspec", "changes", CID), { recursive: true })
      writeFileSync(join(w, "openspec", "changes", CID, "tasks.md"),
        "## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2 [spec:s2]\n", "utf-8")
      return w
    })()
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    // --- 1. Setup through quality ready (tool+task pass) ---
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    // Transition to review (orchestrator does recovery)
    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ change_id: CID, passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

    // --- 2. Quality review fails with issues (5 维全提交，仅 style 失败) ---
    const passDims13 = ["architecture", "performance", "security", "maintainability"]
    for (const d of passDims13) {
      await quality_review_submit.execute({ change_id: CID, task_group_id: "1", passed: true, issues: [] }, makeCtx(`openspec-reviewer-${d}`, wt))
    }
    await quality_review_submit.execute({ change_id: CID, task_group_id: "1", passed: false,
      issues: [{ severity: "Low", file: "src/x.java", line: 1, description: "Fix naming", suggestion: "Rename" }] }, makeCtx("openspec-reviewer-style", wt))

    // --- 3. After quality fail, status should be dev_impl ---
    state = readStateSync(wt, CID)
    const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgAfter.status).toBe("dev_impl")

    // Issue should be in top-level issues[]
    expect(tgAfter.issues).toHaveLength(1)
    const issueId = tgAfter.issues[0].id
    expect(tgAfter.issues[0].status).toBe("open")

    // --- 4. Developer calls opx_status → should see the issue ---
    const devCtx = makeCtx("openspec-developer", wt)
    const viewText = await status.execute({ change_id: CID }, devCtx)
    expect(viewText).toContain("Issue (待修复")
    expect(viewText).toContain("Fix naming")

    // --- 5. Developer fixes the issue ---
    fakeGit.diffs.set(devWt, ["src/F1.java"]) // simulates new commit
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"], fixed_issue_ids: [issueId]}, d)

    // --- 6. After dev_submit with issues → status should be review (Option Y) ---
    state = readStateSync(wt, CID)
    const tgFinal = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgFinal.status).toBe("review")
    expect(tgFinal.phases.review.tool.completed).toBe(false)
    expect(tgFinal.phases.review.task.completed).toBe(true)
    expect(tgFinal.issues.find((i: any) => i.id === issueId).status).toBe("submitted")

    // Cleanup
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 14: Task review auto-skip — issue-fix round
// ═══════════════════════════════════════════════════

describe("14. Task review auto-skip — issue-fix round", () => {
  test("quality 报 issue → 修复提交 → task 层自动跳过", async () => {
    const root = `/tmp/ft14-${Date.now()}`
    const wt = (() => {
      const w = root + "/w"
      mkdirSync(join(w, "openspec", "changes", CID), { recursive: true })
      writeFileSync(join(w, "openspec", "changes", CID, "tasks.md"),
        "## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2 [spec:s2]\n", "utf-8")
      return w
    })()
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    // --- 1. First full review cycle: tool+task passed, quality style fails ---
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ change_id: CID, passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

    const passDims14 = ["architecture", "performance", "security", "maintainability"]
    for (const d of passDims14) {
      await quality_review_submit.execute({ change_id: CID, task_group_id: "1", passed: true, issues: [] }, makeCtx(`openspec-reviewer-${d}`, wt))
    }
    await quality_review_submit.execute({ change_id: CID, task_group_id: "1", passed: false,
      issues: [{ severity: "Low", file: "src/x.java", line: 1, description: "Fix naming", suggestion: "Rename" }] }, makeCtx("openspec-reviewer-style", wt))

    // --- 2. After quality fail → dev_impl ---
    state = readStateSync(wt, CID)
    const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgAfter.status).toBe("dev_impl")
    expect(tgAfter.issues).toHaveLength(1)
    const issueId = tgAfter.issues[0].id

    // --- 3. Developer fixes the issue → status=review, no submitted tasks ---
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"], fixed_issue_ids: [issueId] }, d)

    state = readStateSync(wt, CID)
    const tgFix = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgFix.status).toBe("review")
    expect(tgFix.phases.review.task.completed).toBe(true)
    expect(tgFix.phases.review.retryCount).toBe(1) // dev_submit 不再清零
    expect(tgFix.tasks.every((t: any) => t.status === "verified")).toBe(true)

    // --- 4. Tool review passes (with fixed issue) ---
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [issueId] }, toolR)

    // --- 5. Task review with no verified/failed tasks → auto-skip ---
    const result = JSON.parse(await task_review_submit.execute({ change_id: CID, passed: true }, taskR))
    expect(result.status).toBe("ok")
    expect(result.phase).toBe("review(task=completed)")
    expect(result.message).toContain("审核通过")

    // --- 6. State reflects auto-completed task layer ---
    state = readStateSync(wt, CID)
    const tgFinal = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgFinal.phases.review.task.completed).toBe(true)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  try { rmSync(root, { recursive: true, force: true }) } catch {}
})

// ═══════════════════════════════════════════════════
//  Scenario 15: base_branch 自动推导与异常
// ═══════════════════════════════════════════════════

describe("15. base_branch 自动推导与异常", () => {
  test("init 无 base_branch 自动推导当前分支", async () => {
    const root = `/tmp/ft15a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    fakeGit.currentBranch = "develop"
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    const state = readStateSync(wt, CID)
    expect(state.baseBranch).toBe("develop")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("init 显式传 base_branch 正确使用", async () => {
    const root = `/tmp/ft15b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1", base_branch: "release/1.0" }, o)
    const state = readStateSync(wt, CID)
    expect(state.baseBranch).toBe("release/1.0")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("init detached HEAD 报错", async () => {
    const root = `/tmp/ft15c-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    fakeGit.currentBranch = "HEAD"
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    const err = await init.execute({ change_id: CID, task_group_id: "1" }, o).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/detached HEAD|显式.*base_branch/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("complete_task_group 自动使用 baseBranch 合并", async () => {
    const root = `/tmp/ft15d-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt),
         a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1", base_branch: "develop" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    const state1 = readStateSync(wt, CID)
    const devWt = state1.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    const state2 = readStateSync(wt, CID)
    const tg = state2.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ change_id: CID, passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)
    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (const dim of dims) {
      await quality_review_submit.execute({ change_id: CID, passed: true, issues: [] }, makeCtx(`openspec-reviewer-${dim}`, wt))
    }

    const result = JSON.parse(await complete_task_group.execute({ change_id: CID }, o))
    expect(result.status).toBe("ok")
    expect(result.merge_target).toBe("develop")

    const finalState = readStateSync(wt, CID)
    expect(finalState.taskGroups.find((g: any) => g.id === "1").status).toBe("completed")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 16: line=0 + tool_eligible 边界扩展
// ═══════════════════════════════════════════════════

describe("16. line=0 + tool_eligible — 工具改进 issue 分离与边界扩展", () => {

  test("quality_review_submit 接受 line=0（工具改进 issue 指向配置文件）", async () => {
    const root = `/tmp/ft16a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)
    await setupThroughQualityReady(wt, fakeGit, { orch: o, arch: a, dev: d, toolReviewer: toolR, taskReviewer: taskR })

    // 提交含 line=0 的 issue（工具改进 issue：file 指向配置文件，Info 可伴随 passed=true）
    const res = JSON.parse(await quality_review_submit.execute({change_id: CID, passed: true,
      issues: [{
        severity: "Info",
        file: "pmd-rules.xml",
        line: 0,
        description: "Domain 层异常命名应被 PMD 拦截",
        suggestion: "新增 XPath 规则 [tool_eligible]"}]}, makeCtx("openspec-reviewer-style", wt)))
    expect(res.status).toBe("partial")

    // line=0 存入 state 无误
    const state = readStateSync(wt, CID)
    const issue = state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.file === "pmd-rules.xml")
    expect(issue).toBeDefined()
    expect(issue.line).toBe(0)

    // pmd-rules.xml（根文件）并入 executionBoundary
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.executionBoundary.allowed_directories).toContain("pmd-rules.xml")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("tool_review_submit 接受 line=0（Info 可伴随 passed=true）", async () => {
    const root = `/tmp/ft16b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt)
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    const s1 = readStateSync(wt, CID)
    const devWt = s1.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
    const s2 = readStateSync(wt, CID)
    const tg = s2.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)

    // tool review 提交 line=0 Info issue
    const res = JSON.parse(await tool_review_submit.execute({change_id: CID, passed: true,
      issues: [{ dimension: "style", severity: "Info", file: ".editorconfig", line: 0, description: "Indent 2", suggestion: "Set indent_style=space" }],
      fixed_issue_ids: []}, toolR))
    expect(res.status).toBe("ok")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("line=0 在 developer opx_status 显示中省略 :0", async () => {
    const root = `/tmp/ft16c-${Date.now()}`
    const wt = (() => {
      const dir = root
      const w = root + "/w"
      mkdirSync(join(w, "openspec", "changes", CID), { recursive: true })
      writeFileSync(join(w, "openspec", "changes", CID, "tasks.md"),
        "## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2 [spec:s2]\n", "utf-8")
      return w
    })()
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    // Transition to review
    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ change_id: CID, passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

    // Quality 5 维全提交，仅 style 携带 line=0 issue 且 passed=false
    const dims16 = ["architecture", "performance", "security", "maintainability"]
    for (const d of dims16) {
      await quality_review_submit.execute({ change_id: CID, task_group_id: "1", passed: true, issues: [] }, makeCtx(`openspec-reviewer-${d}`, wt))
    }
    await quality_review_submit.execute({ change_id: CID, task_group_id: "1", passed: false,
      issues: [{ severity: "Low", file: "pmd-rules.xml", line: 0, description: "Add XPath rule", suggestion: "XPath rule [tool_eligible]" }] }, makeCtx("openspec-reviewer-style", wt))

    // quality failed → 自动回 dev_impl
    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").status).toBe("dev_impl")

    // developer 调 status → 看到 line=0 issue 无 :0
    const viewText = await status.execute({ change_id: CID }, makeCtx("openspec-developer", wt))
    expect(viewText).toContain("pmd-rules.xml")
    expect(viewText).not.toContain("pmd-rules.xml:0")
    expect(viewText).toContain("Add XPath rule")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 17: Boundary expansion
// ═══════════════════════════════════════════════════

describe("17. boundary_expansion — reviewer 声明扩展执行边界", () => {

  test("tool_review_submit boundary_expansion 扩目录", async () => {
    const root = `/tmp/ft17a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt)
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    const s1 = readStateSync(wt, CID)
    const devWt = s1.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
    const s2 = readStateSync(wt, CID)
    const tg = s2.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)

    const res = JSON.parse(await tool_review_submit.execute({change_id: CID, passed: false,
      issues: [{ dimension: "style", severity: "Low", file: "src/app.ts", line: 5, description: "Bad", suggestion: "Fix" }],
      fixed_issue_ids: [],
      boundary_expansion: { allowed_directories: ["scripts"] }}, toolR))
    expect(res.status).toBe("recorded")

    const state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.executionBoundary.allowed_directories).toContain("scripts")
    expect(tg2.executionBoundary.allowed_directories).toContain("src")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("tool_review_submit boundary_expansion 扩包路径", async () => {
    const root = `/tmp/ft17b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt)
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    const s1 = readStateSync(wt, CID)
    const devWt = s1.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
    const s2 = readStateSync(wt, CID)
    const tg = s2.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)

    const res = JSON.parse(await tool_review_submit.execute({change_id: CID, passed: false,
      issues: [{ dimension: "style", severity: "Low", file: "src/app.ts", line: 5, description: "Bad", suggestion: "Fix" }],
      fixed_issue_ids: [],
      boundary_expansion: { allowed_packages: ["com.new"] }}, toolR))
    expect(res.status).toBe("recorded")

    const state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.executionBoundary.allowed_packages).toContain("com.new")
    expect(tg2.executionBoundary.allowed_packages).toContain("com.t")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("tool_review_submit passed=true + boundary_expansion → 报错", async () => {
    const root = `/tmp/ft17c-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt)
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    const s1 = readStateSync(wt, CID)
    const devWt = s1.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
    const s2 = readStateSync(wt, CID)
    const tg = s2.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)

    await expect(tool_review_submit.execute({change_id: CID, passed: true,
      issues: [],
      fixed_issue_ids: [],
      boundary_expansion: { allowed_directories: ["extra"] }}, toolR)).rejects.toThrow("passed=true 时不允许边界扩展")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("task_review_submit 自动扩目录", async () => {
    const root = `/tmp/ft17d-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    const s1 = readStateSync(wt, CID)
    const devWt = s1.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
    const s2 = readStateSync(wt, CID)
    const tg = s2.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)

    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    const res = JSON.parse(await task_review_submit.execute({change_id: CID, passed: false,
      verified_task_ids: ["1"], failed_task_ids: [{ task_id: "2", reason: "Not done" }],
      fixed_issue_ids: [],
      issues: [{ severity: "Low", file: "tests/test1.ts", line: 3, description: "Missing test", suggestion: "Add test" }]}, taskR))
    expect(res.status).toBe("recorded")

    const state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.executionBoundary.allowed_directories).toContain("tests")
    expect(tg2.executionBoundary.allowed_directories).toContain("src")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("task_review_submit boundary_expansion 扩目录", async () => {
    const root = `/tmp/ft17e-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    const s1 = readStateSync(wt, CID)
    const devWt = s1.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
    const s2 = readStateSync(wt, CID)
    const tg = s2.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)

    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    const res = JSON.parse(await task_review_submit.execute({change_id: CID, passed: false,
      verified_task_ids: ["1"], failed_task_ids: [{ task_id: "2", reason: "Not done" }],
      fixed_issue_ids: [],
      boundary_expansion: { allowed_directories: ["infra"] }}, taskR))
    expect(res.status).toBe("recorded")

    const state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.executionBoundary.allowed_directories).toContain("infra")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("quality_review_submit boundary_expansion 扩目录", async () => {
    const root = `/tmp/ft17f-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)
    await setupThroughQualityReady(wt, fakeGit, { orch: o, arch: a, dev: d, toolReviewer: toolR, taskReviewer: taskR })

    const res = JSON.parse(await quality_review_submit.execute({change_id: CID, passed: false,
      issues: [{ severity: "Low", file: "src/app.ts", line: 5, description: "Bad", suggestion: "Fix it" }],
      boundary_expansion: { allowed_directories: ["docs"] }}, makeCtx("openspec-reviewer-style", wt)))
    expect(res.status).toBe("partial")

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.executionBoundary.allowed_directories).toContain("docs")
    expect(tg.executionBoundary.allowed_directories).toContain("src")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("quality_review_submit passed=true + boundary_expansion → 报错", async () => {
    const root = `/tmp/ft17g-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)
    await setupThroughQualityReady(wt, fakeGit, { orch: o, arch: a, dev: d, toolReviewer: toolR, taskReviewer: taskR })

    await expect(quality_review_submit.execute({change_id: CID, passed: true,
      issues: [],
      boundary_expansion: { allowed_directories: ["extra"] }}, makeCtx("openspec-reviewer-style", wt))).rejects.toThrow("passed=true 时不允许边界扩展")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("boundary_expansion 与自动 dirname 扩展并存叠加（目录去重）", async () => {
    const root = `/tmp/ft17h-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt)
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    const s1 = readStateSync(wt, CID)
    const devWt = s1.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
    const s2 = readStateSync(wt, CID)
    const tg = s2.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({ change_id: CID }, o)

    const res = JSON.parse(await tool_review_submit.execute({change_id: CID, passed: false,
      issues: [{ dimension: "style", severity: "Low", file: "config/app.yml", line: 3, description: "YAML indent", suggestion: "Fix" }],
      fixed_issue_ids: [],
      boundary_expansion: { allowed_directories: ["scripts", "src"] }}, toolR))
    expect(res.status).toBe("recorded")

    const state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.executionBoundary.allowed_directories).toContain("config")
    expect(tg2.executionBoundary.allowed_directories).toContain("scripts")
    const srcCount = tg2.executionBoundary.allowed_directories.filter((d: string) => d === "src").length
    expect(srcCount).toBe(1)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 18: reopenIssues
// ═══════════════════════════════════════════════════

describe("18. reopenIssues — 完成后 reopen 继续修 issue", () => {

  test("Case 1: 正常流程 — completed → reopenIssues → dev_impl", async () => {
    const root = `/tmp/ft18a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    try {
      // 1. 完整流程到 completed
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      await arch_submit.execute({change_id: CID, outcome: "ready",
        execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
      await set_worktree.execute({ change_id: CID }, o)
      let state = readStateSync(wt, CID)
      const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
      fakeGit.diffs.set(devWt, ["src/F1.java"])
      await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
      await transitionToReview(wt, o, toolR, taskR)

      const dims = ["style", "architecture", "performance", "security", "maintainability"]
      for (let i = 0; i < dims.length; i++) {
        await quality_review_submit.execute({ change_id: CID, passed: true, issues: []}, makeCtx(`openspec-reviewer-${dims[i]}`, wt))
      }
      await complete_task_group.execute({ change_id: CID }, o)

      state = readStateSync(wt, CID)
      const tg = state.taskGroups.find((g: any) => g.id === "1")
      expect(tg.status).toBe("completed")

      // 2. 注入 issues：1 open + 1 verified
      const statePath = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
      tg.issues.push(
        { id: "iss-open-1", dimension: "style", sourcePhase: "quality", severity: "Low",
          file: "src/x.java", line: 5, description: "遗留问题", suggestion: "修复",
          status: "open", refixCount: 0, rootCauseGuess: null, exemptReason: null, rejectReason: null },
        { id: "iss-verified-1", dimension: "style", sourcePhase: "quality", severity: "Info",
          file: "src/y.java", line: 10, description: "已修问题", suggestion: "已处理",
          status: "verified", refixCount: 0, rootCauseGuess: null, exemptReason: null, rejectReason: null }
      )
      writeFileSync(statePath, JSON.stringify(state, null, 2))

      // 3. reopenIssues
      const r = JSON.parse(await init.execute({
        change_id: CID, task_group_id: "1",
        recovery: { phase: "dev_impl", reopenIssues: true }}, o))
      expect(r.status).toBe("initialized")
      expect(r.active_phase).toBe("dev_impl")

      state = readStateSync(wt, CID)
      const tg2 = state.taskGroups.find((g: any) => g.id === "1")
      expect(tg2.status).toBe("dev_impl")

      // open → rejected, verified 不变
      const openIssue = tg2.issues.find((i: any) => i.id === "iss-open-1")
      expect(openIssue.status).toBe("rejected")
      expect(openIssue.rejectReason).toContain("reopenIssues")
      const verifiedIssue = tg2.issues.find((i: any) => i.id === "iss-verified-1")
      expect(verifiedIssue.status).toBe("verified")

      // review 三层重置
      expect(tg2.phases.review.tool.completed).toBe(false)
      expect(tg2.phases.review.task.completed).toBe(false)
      for (const d of dims) {
        expect(tg2.phases.review.quality.progress[d]).toBe("pending")
      }
      expect(tg2.phases.review.retryCount).toBe(0)
      expect(tg2.phases.review.lastResolvedRetryCount).toBe(0)

      // worktreePath/branchName/baseRef = null
      expect(tg2.worktreePath).toBeNull()
      expect(tg2.branchName).toBeNull()
      expect(tg2.baseRef).toBeNull()
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("Case 2: 非 completed 组 + reopenIssues → 抛错", async () => {
    const root = `/tmp/ft18b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt)

    try {
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      await arch_submit.execute({change_id: CID, outcome: "ready",
        execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
      await set_worktree.execute({ change_id: CID }, o)
      let state = readStateSync(wt, CID)
      const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
      fakeGit.diffs.set(devWt, ["src/F1.java"])
      await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

      state = readStateSync(wt, CID)
      expect(state.taskGroups.find((g: any) => g.id === "1").status).toBe("review")

      const err = await init.execute({
        change_id: CID, task_group_id: "1",
        recovery: { phase: "dev_impl", reopenIssues: true }}, o).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toContain("reopenIssues 仅支持已完成")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("Case 3: reopenIssues + review_layer → 抛错", async () => {
    const root = `/tmp/ft18c-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    try {
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      await arch_submit.execute({change_id: CID, outcome: "ready",
        execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
      await set_worktree.execute({ change_id: CID }, o)
      let state = readStateSync(wt, CID)
      const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
      fakeGit.diffs.set(devWt, ["src/F1.java"])
      await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
      await transitionToReview(wt, o, toolR, taskR)

      const dims = ["style", "architecture", "performance", "security", "maintainability"]
      for (let i = 0; i < dims.length; i++) {
        await quality_review_submit.execute({ change_id: CID, passed: true, issues: []}, makeCtx(`openspec-reviewer-${dims[i]}`, wt))
      }
      await complete_task_group.execute({ change_id: CID }, o)

      state = readStateSync(wt, CID)
      expect(state.taskGroups.find((g: any) => g.id === "1").status).toBe("completed")

      const err = await init.execute({
        change_id: CID, task_group_id: "1",
        recovery: { phase: "dev_impl", reopenIssues: true, review_layer: "tool" }}, o).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/review_layer|互斥/)
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("Case 4: reopened 后 set_worktree 正常工作", async () => {
    const root = `/tmp/ft18d-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    try {
      // 同 Case 1 到 completed
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      await arch_submit.execute({change_id: CID, outcome: "ready",
        execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
      await set_worktree.execute({ change_id: CID }, o)
      let state = readStateSync(wt, CID)
      const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
      fakeGit.diffs.set(devWt, ["src/F1.java"])
      await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
      await transitionToReview(wt, o, toolR, taskR)

      const dims = ["style", "architecture", "performance", "security", "maintainability"]
      for (let i = 0; i < dims.length; i++) {
        await quality_review_submit.execute({ change_id: CID, passed: true, issues: []}, makeCtx(`openspec-reviewer-${dims[i]}`, wt))
      }
      await complete_task_group.execute({ change_id: CID }, o)

      // reopenIssues
      await init.execute({
        change_id: CID, task_group_id: "1",
        recovery: { phase: "dev_impl", reopenIssues: true }}, o)

      state = readStateSync(wt, CID)
      const tgBefore = state.taskGroups.find((g: any) => g.id === "1")
      expect(tgBefore.worktreePath).toBeNull()
      expect(tgBefore.branchName).toBeNull()
      expect(tgBefore.baseRef).toBeNull()

      // set_worktree
      const r = await set_worktree.execute({ change_id: CID }, o)
      expect(r).toContain("已创建 worktree")
      expect(r).toContain("**状态**")

      state = readStateSync(wt, CID)
      const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
      expect(tgAfter.worktreePath).not.toBeNull()
      expect(tgAfter.branchName).toBe("task-group/test-flow/1")
      expect(tgAfter.baseRef).toBe(fakeGit.baseRef)
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
})

/**
 * 验证编排 agent 通过 opx_status 能否正确获取到下一环节指引。
 *
 * 9 个场景，每个模拟状态推进到节点后调 opx_status(orchestrator) 断言渲染内容。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  init, status, set_worktree, arch_submit, dev_submit,
  tool_review_submit, task_review_submit, quality_review_submit,
  resolve_review, MAX_RETRIES, __setGitRunner} from "../src/tools/orchestrate"
import { FakeGitRunner, makeCtx } from "./helpers"

const CID = "test-orch-next"

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

/** 同 flow test 的 helper：tool+task pass 到 quality ready */
async function setupThroughQualityReady(
  wt: string,
  fakeGit: FakeGitRunner,
  ctx: { orch: Ctx; arch: Ctx; dev: Ctx; toolReviewer: Ctx; taskReviewer: Ctx }
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

// ═══════════════════════════════════════════════════
//  场景 1: arch_submit 通过后 → 期望 developer 指引
// ═══════════════════════════════════════════════════

describe("S1: arch_submit passed", () => {
  test("status 输出含 developer 分派指引", async () => {
    const root = `/tmp/osn1-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)

    const output = await status.execute({ change_id: CID }, o)
    expect(output).toContain("资源未就绪")
    expect(output).toContain("opx_orch_set_worktree")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  场景 2: dev_submit 后 → tool review 指引
// ═══════════════════════════════════════════════════

describe("S2: dev_submit 后", () => {
  test("status 输出含 openspec-reviewer-tool", async () => {
    const root = `/tmp/osn2-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)
    const d = makeCtx("openspec-developer", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    const state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    const output = await status.execute({ change_id: CID }, o)
    expect(output).toContain("openspec-reviewer-tool")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  场景 3: tool review 通过后 → task review 指引
// ═══════════════════════════════════════════════════

describe("S3: tool review passed", () => {
  test("status 输出含 openspec-reviewer-task", async () => {
    const root = `/tmp/osn3-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)
    const d = makeCtx("openspec-developer", wt)
    const toolR = makeCtx("openspec-reviewer-tool", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    const state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    const output = await status.execute({ change_id: CID }, o)
    expect(output).toContain("openspec-reviewer-task")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  场景 4: task review 通过后 → quality reviewer 指引
// ═══════════════════════════════════════════════════

describe("S4: task review passed", () => {
  test("status 输出含 5 维 quality reviewer", async () => {
    const root = `/tmp/osn4-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)
    const d = makeCtx("openspec-developer", wt)
    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    const state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({change_id: CID, passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [],
      fixed_issue_ids: []}, taskR)

    const output = await status.execute({ change_id: CID }, o)
    expect(output).toContain("openspec-reviewer-style")
    expect(output).toContain("openspec-reviewer-architecture")
    expect(output).toContain("openspec-reviewer-performance")
    expect(output).toContain("openspec-reviewer-security")
    expect(output).toContain("openspec-reviewer-maintainability")
    expect(output).toContain("并排分派")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  场景 5: quality 5 维全通过后 → complete_task_group 指引
// ═══════════════════════════════════════════════════

describe("S5: quality 5 dims all passed", () => {
  test("status 输出含 opx_orch_complete_task_group", async () => {
    const root = `/tmp/osn5-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)
    const d = makeCtx("openspec-developer", wt)
    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const taskR = makeCtx("openspec-reviewer-task", wt)

    await setupThroughQualityReady(wt, fakeGit, { orch: o, arch: a, dev: d, toolReviewer: toolR, taskReviewer: taskR })

    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      await quality_review_submit.execute({ change_id: CID, passed: true, issues: []}, makeCtx(`openspec-reviewer-${dims[i]}`, wt))
    }

    const output = await status.execute({ change_id: CID }, o)
    expect(output).toContain("opx_orch_complete_task_group")
    expect(output).toContain("收尾")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  场景 6: tool review 不通过（非检查点）→ developer 指引
// ═══════════════════════════════════════════════════

describe("S6: tool review failed (non-checkpoint)", () => {
  test("status 输出含 openspec-developer", async () => {
    const root = `/tmp/osn6-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)
    const d = makeCtx("openspec-developer", wt)
    const toolR = makeCtx("openspec-reviewer-tool", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    const state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
    await tool_review_submit.execute({ change_id: CID, passed: false,
      issues: [{ severity: "Low", file: "src/x.java", line: 1, dimension: "style" as any, description: "Tool issue", suggestion: "Fix" }],
      fixed_issue_ids: [] }, toolR)

    const output = await status.execute({ change_id: CID }, o)
    expect(output).toContain("openspec-developer")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  场景 7: task review 不通过（非检查点）→ developer 指引
// ═══════════════════════════════════════════════════

describe("S7: task review failed (non-checkpoint)", () => {
  test("status 输出含 openspec-developer", async () => {
    const root = `/tmp/osn7-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)
    const d = makeCtx("openspec-developer", wt)
    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    const state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)
    await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({change_id: CID, passed: false, verified_task_ids: ["1"], failed_task_ids: [{ task_id: "2", reason: "Incomplete" }],
      issues: [], fixed_issue_ids: []}, taskR)

    const output = await status.execute({ change_id: CID }, o)
    expect(output).toContain("openspec-developer")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  场景 8: quality 不通过（非检查点）→ developer 指引
// ═══════════════════════════════════════════════════

describe("S8: quality failed (non-checkpoint)", () => {
  test("status 输出含 openspec-developer", async () => {
    const root = `/tmp/osn8-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)
    const d = makeCtx("openspec-developer", wt)
    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const taskR = makeCtx("openspec-reviewer-task", wt)

    await setupThroughQualityReady(wt, fakeGit, { orch: o, arch: a, dev: d, toolReviewer: toolR, taskReviewer: taskR })

    // style pass, architecture pass, performance pass, security pass
    const passDims = ["architecture", "performance", "security", "maintainability"]
    for (const dim of passDims) {
      await quality_review_submit.execute({ change_id: CID, passed: true, issues: []}, makeCtx(`openspec-reviewer-${dim}`, wt))
    }
    // style fails with blocking issue → triggers fail (not checkpoint since retryCount=0→1 < MAX_RETRIES)
    await quality_review_submit.execute({change_id: CID, passed: false,
      issues: [{ severity: "Low", file: "src/x.java", line: 1, description: "Style issue", suggestion: "Fix" }]}, makeCtx("openspec-reviewer-style", wt))

    const output = await status.execute({ change_id: CID }, o)
    expect(output).toContain("openspec-developer")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  场景 9: 检查点（retryCount=${MAX_RETRIES}，needs_user_decision）
// ═══════════════════════════════════════════════════

describe("S9: checkpoint (${MAX_RETRIES} tool failures)", () => {
  test("status 输出含 resolve_review 指引", async () => {
    const root = `/tmp/osn9-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)
    const d = makeCtx("openspec-developer", wt)
    const toolR = makeCtx("openspec-reviewer-tool", wt)

    // 1. init → arch → set_worktree → dev_submit
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    // 2. ${MAX_RETRIES} 轮 tool 失败
    let prevIssueS9: string | undefined
    for (let round = 1; round <= MAX_RETRIES; round++) {
      state = readStateSync(wt, CID)
      const tg = state.taskGroups.find((g: any) => g.id === "1")
      // 第 2、3 轮需 recovery + dev_submit 重置 tool
      if (round > 1) {
        await init.execute({
          change_id: CID, task_group_id: "1",
          recovery: { phase: "review" }}, o)
        await set_worktree.execute({ change_id: CID }, o)
        fakeGit.diffs.set(devWt, [`src/FR${round - 1}.java`])
        await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"],
          fixed_issue_ids: prevIssueS9 ? [prevIssueS9] : [] }, d)
      }

      await tool_review_submit.execute({ change_id: CID, passed: false,
        issues: [{ severity: "Low", file: "src/x.java", line: 1, dimension: "style" as any, description: "Tool issue", suggestion: "Fix" }],
        fixed_issue_ids: prevIssueS9 ? [prevIssueS9] : []}, toolR)

      state = readStateSync(wt, CID)
      const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
      prevIssueS9 = tgAfter.issues.length > 0 ? tgAfter.issues[tgAfter.issues.length - 1].id : undefined
    }

    const output = await status.execute({ change_id: CID }, o)
    expect(output).toContain("opx_orch_resolve_review")
    expect(output).toContain("检查点")
    expect(output).toContain("continue / giveup")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  场景 10: resolve_review(continue) 后正常推进，opx_status 不误报异常
// ════════════════════════════════════════════════════════════════

describe("S10: resolve_review(continue) 后正常推进", () => {
  test("resolve_review(continue) 后 opx_status 不误报异常", async () => {
    const root = `/tmp/osn10-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)
    const d = makeCtx("openspec-developer", wt)
    const toolR = makeCtx("openspec-reviewer-tool", wt)

    // 1. init → arch → set_worktree → dev_submit
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({ change_id: CID }, o)
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    // 2. ${MAX_RETRIES} 轮 tool 失败（达到检查点，retryCount=${MAX_RETRIES}）
    let prevIssueS10: string | undefined
    for (let round = 1; round <= MAX_RETRIES; round++) {
      state = readStateSync(wt, CID)
      const tg = state.taskGroups.find((g: any) => g.id === "1")
      if (round > 1) {
        await init.execute({
          change_id: CID, task_group_id: "1",
          recovery: { phase: "review" }}, o)
        await set_worktree.execute({ change_id: CID }, o)
        fakeGit.diffs.set(devWt, [`src/FR${round - 1}.java`])
        await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"],
          fixed_issue_ids: prevIssueS10 ? [prevIssueS10] : [] }, d)
      }
      await tool_review_submit.execute({ change_id: CID, passed: false,
        issues: [{ severity: "Low", file: "src/x.java", line: 1, dimension: "style" as any, description: "Tool issue", suggestion: "Fix" }],
        fixed_issue_ids: prevIssueS10 ? [prevIssueS10] : []}, toolR)

      state = readStateSync(wt, CID)
      const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
      prevIssueS10 = tgAfter.issues.length > 0 ? tgAfter.issues[tgAfter.issues.length - 1].id : undefined
    }

    // 3. resolve_review(continue) → lastResolvedRetryCount=${MAX_RETRIES}, status=dev_impl
    await resolve_review.execute({ change_id: CID, decision: "continue" }, o)

    // 4. dev_submit → status=review, retryCount=${MAX_RETRIES}, lastResolvedRetryCount=${MAX_RETRIES}
    fakeGit.diffs.set(devWt, ["src/FR${MAX_RETRIES}.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"],
      fixed_issue_ids: prevIssueS10 ? [prevIssueS10] : [] }, d)

    // 5. opx_status 不应含 "以上状态异常" 和 "recovery"
    const output = await status.execute({ change_id: CID }, o)
    expect(output).not.toContain("以上状态异常")
    expect(output).not.toContain("recovery")
    expect(output).toContain("openspec-reviewer-tool")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import { MAX_RETRIES } from "../src/core/constants"
import {
  init, status, set_worktree, arch_submit, dev_submit,
  tool_review_submit, task_review_submit, quality_review_submit,
  set_unattended
} from "../src/adapters/opencode/tools"
import { handleRetryCheckpoint } from "../src/core/derive"
import {
  renderOrchestratorView, renderArchitectView, renderToolReviewView,
} from "../src/core/views"
import type { OrchestrateState, TaskGroupState } from "../src/core/types"
import { REVIEW_DIMENSIONS } from "../src/core/types"
import { FakeGitRunner, makeCtx } from "./helpers"

const CID = "test-unattended"

afterAll(() => { __setGitRunner(null) })

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

function makeState(overrides?: Partial<OrchestrateState>): OrchestrateState {
  return {
    changeId: CID,
    isolationNamespace: "a1b2c3",
    taskGroupId: "1",
    baseBranch: "main",
    taskGroups: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as OrchestrateState
}

function makeTg(overrides?: Partial<TaskGroupState>): TaskGroupState {
  return {
    id: "1",
    name: "Test Group",
    taskCount: 2,
    status: "task_analysis",
    worktreePath: null,
    branchName: null,
    baseRef: null,
    executionBoundary: null,
    relevantSpecs: [],
    lastFilesChanged: [],
    devSelfCheckResults: undefined,
    phases: {
      architect_review: { completed: false },
      review: {
        retryCount: 0,
        lastResolvedRetryCount: 0,
        tool: { completed: false },
        task: { completed: false },
        quality: {
          progress: Object.fromEntries(
            REVIEW_DIMENSIONS.map((d) => [d, "pending"])
          ) as TaskGroupState["phases"]["review"]["quality"]["progress"],
        },
      },
    },
    tasks: [],
    issues: [],
    blockers: [],
    ...overrides,
  }
}

// ───── Test 1: set_unattended sets/clears flag ─────

describe("T1: set_unattended tool", () => {
  test("sets unattended=true", async () => {
    const root = `/tmp/ut1-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await set_unattended.execute({ change_id: CID, enabled: true }, o)

    const state = readStateSync(wt, CID)
    expect(state.unattended).toBe(true)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("clears unattended=false", async () => {
    const root = `/tmp/ut2-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await set_unattended.execute({ change_id: CID, enabled: true }, o)
    await set_unattended.execute({ change_id: CID, enabled: false }, o)

    const state = readStateSync(wt, CID)
    expect(state.unattended).toBe(false)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("orchestrator-only: non-orchestrator gets error", async () => {
    const root = `/tmp/ut3-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const d = makeCtx("openspec-developer", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)

    try {
      await set_unattended.execute({ change_id: CID, enabled: true }, d)
      expect.unreachable("should have thrown")
    } catch (e: any) {
      expect(e.message).toContain("仅限编排者")
    }

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ───── Test 2: Unattended suppresses checkpoint in opx_status ─────

describe("T2: unattended suppresses checkpoint in status", () => {
  test("status does NOT contain resolve_review when unattended at checkpoint", async () => {
    const root = `/tmp/ut4-${Date.now()}`
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
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

    await set_unattended.execute({ change_id: CID, enabled: true }, o)

    let prevIssueT2: string | undefined
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
          fixed_issue_ids: prevIssueT2 ? [prevIssueT2] : [] }, d)
      }
      await tool_review_submit.execute({ change_id: CID, passed: false,
        issues: [{ severity: "Low", file: "src/x.java", line: 1, dimension: "style" as any, description: "Tool issue", suggestion: "Fix" }],
        fixed_issue_ids: prevIssueT2 ? [prevIssueT2] : [] }, toolR)

      state = readStateSync(wt, CID)
      const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
      prevIssueT2 = tgAfter.issues.length > 0 ? tgAfter.issues[tgAfter.issues.length - 1].id : undefined
    }

    const output = await status.execute({ change_id: CID }, o)
    expect(output).not.toContain("opx_orch_resolve_review")
    expect(output).not.toContain("检查点")
    expect(output).toContain("openspec-developer")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ───── Test 3: Unattended suppresses question prompts ─────

describe("T3: unattended mode suppresses question prompts", () => {
  test("architect view: '自行推断' present, '用 question' absent", () => {
    const state = makeState({ unattended: true })
    const tg = makeTg({ status: "task_analysis" })
    const output = renderArchitectView(state, tg)
    expect(output).toContain("自行推断")
    expect(output).not.toContain("缺用户答复用 question")
  })

  test("tool reviewer view: 'skipped' present, '用 question' absent", () => {
    const state = makeState({ unattended: true })
    const tg = makeTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      lastFilesChanged: ["src/Foo.java"],
    })
    const output = renderToolReviewView(state, tg)
    expect(output).toContain("skipped")
    expect(output).not.toContain("用 question 提请用户裁定")
  })
})

// ───── Test 4: Normal mode shows question prompts ─────

describe("T4: normal mode shows question prompts", () => {
  test("architect view: '用 question' present when unattended=false", () => {
    const state = makeState({ unattended: false })
    const tg = makeTg({ status: "task_analysis" })
    const output = renderArchitectView(state, tg)
    expect(output).toContain("缺用户答复用 question")
    expect(output).not.toContain("自行推断")
  })

  test("tool reviewer view: '用 question' present when unattended=false", () => {
    const state = makeState({ unattended: false })
    const tg = makeTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      lastFilesChanged: ["src/Foo.java"],
    })
    const output = renderToolReviewView(state, tg)
    expect(output).toContain("用 question 提请用户裁定")
    expect(output).not.toContain("skipped")
  })

  test("unattended undefined behaves like false", () => {
    const state = makeState()
    const tg = makeTg({ status: "task_analysis" })
    const output = renderArchitectView(state, tg)
    expect(output).toContain("缺用户答复用 question")
    expect(output).not.toContain("自行推断")
  })
})

// ───── Test 5: handleRetryCheckpoint behavior ─────

describe("T5: handleRetryCheckpoint unattended behavior", () => {
  function tgWithRetry(retryCount = 0): TaskGroupState {
    return makeTg({
      status: "review",
      phases: {
        architect_review: { completed: true },
        review: {
          retryCount,
          lastResolvedRetryCount: 0,
          tool: { completed: false },
          task: { completed: false },
          quality: {
            progress: Object.fromEntries(
              REVIEW_DIMENSIONS.map((d) => [d, "pending"])
            ) as TaskGroupState["phases"]["review"]["quality"]["progress"],
          },
        },
      },
    })
  }

  test("unattended=true returns checkpoint=false even at retryCount=5", () => {
    const tg = tgWithRetry(4)
    const result = handleRetryCheckpoint(tg, true)
    expect(result).not.toBeNull()
    expect(result!.checkpoint).toBe(false)
    expect(result!.retryCount).toBe(5)
  })

  test("unattended=true returns checkpoint=false at retryCount=0", () => {
    const tg = tgWithRetry(0)
    const result = handleRetryCheckpoint(tg, true)
    expect(result).not.toBeNull()
    expect(result!.checkpoint).toBe(false)
    expect(result!.retryCount).toBe(1)
  })

  test("unattended=false returns null at retryCount=5 (existing behavior)", () => {
    const tg = tgWithRetry(4)
    const result = handleRetryCheckpoint(tg, false)
    expect(result).toBeNull()
  })

  test("unattended=false returns result below MAX_RETRIES (existing behavior)", () => {
    const tg = tgWithRetry(2)
    const result = handleRetryCheckpoint(tg, false)
    expect(result).not.toBeNull()
    expect(result!.checkpoint).toBe(false)
    expect(result!.retryCount).toBe(3)
  })

  test("unattended=undefined returns null at retryCount=5 (backward compat)", () => {
    const tg = tgWithRetry(4)
    const result = handleRetryCheckpoint(tg)
    expect(result).toBeNull()
  })

  test("unattended=undefined returns result below MAX_RETRIES (backward compat)", () => {
    const tg = tgWithRetry(1)
    const result = handleRetryCheckpoint(tg)
    expect(result).not.toBeNull()
    expect(result!.retryCount).toBe(2)
  })
})

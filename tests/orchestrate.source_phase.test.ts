/**
 * source_phase 归因分层重置测试（新流）
 *
 * 原语义：sourcePhase 分层（tool/task/quality 各层 issue 只影响本层重置）。
 * 新流承载于 child.metadata.source_phase + workflow/reset.ts 的 resetReviewTagsOnFix：
 * dev 在 implement 提交 fixed/exempt 后按 issue 归因分层重置 review 验证标记。
 *
 * 覆盖场景：
 * A. tool 层 issue fixed → 清 verify_tool tag
 * B. task 层 issue fixed → 清 verify_tool + verify_task
 * C. quality 层 issue fixed（维度 dim）→ 清 verify_tool + 仅该 dim 的 verify_quality tag
 * D. quality 层 exempt（不改代码）→ 仅清该 dim 的 verify_quality tag（不动 verify_tool/verify_task）
 * E. task 层 exempt → 清 verify_tool + verify_task
 */
import { describe, expect, test, afterAll } from "bun:test"
import { readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import { agent_submit } from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx, setupWorkspace } from "./helpers"
import {
  setupToAnalyze, driveToVerifyTool, driveToVerifyTask, driveToQuality,
  taskListOf, readItem,
} from "./helpers-workflow"
import type { WorkItem } from "../src/core/workflow/types"

const CID = "test-sourcePhase"
afterAll(() => { __setGitRunner(null) })

const EB = { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }

function freshSetup(root: string): { wt: string; fakeGit: FakeGitRunner } {
  const wt = setupWorkspace(root, CID)
  const fakeGit = new FakeGitRunner()
  __setGitRunner(fakeGit)
  return { wt, fakeGit }
}

/** 注入带归因字段的 issue child（metadata.source_phase/dimension/file/line/suggestion）。 */
function injectChild(wt: string, child: any): void {
  const p = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  const item = state.workItems.find((w: any) => w.id === "task:1")
  item.children.push(child)
  writeFileSync(p, JSON.stringify(state, null, 2))
}

function makeChild(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id: `issue:${id}`,
    source: "openspec",
    externalId: id,
    type: "issue",
    title: `issue ${id}`,
    description: `issue ${id} 描述`,
    phase: "todo",
    suspended: false,
    currentStep: null,
    tags: {},
    metadata: { source_phase: "quality", dimension: "style", file: "d.md", line: 0 },
    children: [],
    labels: [],
    severity: "High",
    ...overrides,
  }
}

/** 把 review 验证 tag 全部置 passed（模拟已通过全部 review 子层）。 */
function seedReviewTags(wt: string): void {
  const p = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  const item = state.workItems.find((w: any) => w.id === "task:1")
  item.tags = {
    "analyze:openspec-architect": "passed",
    "implement:openspec-developer": "passed",
    "verify_tool:openspec-reviewer-tool": "passed",
    "verify_task:openspec-reviewer-task": "passed",
    "verify_quality:openspec-reviewer-style": "passed",
    "verify_quality:openspec-reviewer-architecture": "passed",
    "verify_quality:openspec-reviewer-performance": "passed",
    "verify_quality:openspec-reviewer-security": "passed",
    "verify_quality:openspec-reviewer-maintainability": "passed",
  }
  writeFileSync(p, JSON.stringify(state, null, 2))
}

/** 把 item 手动拉回 implement step（模拟 review 回退 dev 修复）。 */
function rewindToImplement(wt: string): void {
  const p = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  const item = state.workItems.find((w: any) => w.id === "task:1")
  item.phase = "in_progress"
  item.currentStep = "implement"
  writeFileSync(p, JSON.stringify(state, null, 2))
}

async function fixIssue(wt: string, fixedIds: string[]): Promise<string> {
  const item = readItem(wt, CID)
  return agent_submit.execute(
    { change_id: CID, step_id: "implement", verdict: "passed", fixed_issue_ids: fixedIds, completed_task_ids: taskListOf(item).map((t: any) => t.id) },
    makeCtx("openspec-developer", wt)
  )
}

// ── Scene A: tool 层 issue fixed → 清 verify_tool ──

describe("sourcePhase A: tool 层 issue fixed 只清 verify_tool", () => {
  test("tool source_phase fixed → verify_tool tag 清，verify_task/quality 保留", async () => {
    const root = `/tmp/sourcePhase-A-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, ctx.arch)
      injectChild(wt, makeChild("t1", { metadata: { source_phase: "tool", dimension: "style", file: "src/a.java", line: 1 } }))
      seedReviewTags(wt)

      await fixIssue(wt, ["t1"])
      const item = readItem(wt, CID)
      // tool 层 fixed → verify_tool 清
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      // verify_task 与 verify_quality 保留
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
      // child 终态
      expect(item.children.find((c: WorkItem) => c.externalId === "t1").phase).toBe("done")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ── Scene B: task 层 issue fixed → 清 verify_tool + verify_task ──

describe("sourcePhase B: task 层 issue fixed 清 verify_tool + verify_task", () => {
  test("task source_phase fixed → verify_tool + verify_task 清，verify_quality 保留", async () => {
    const root = `/tmp/sourcePhase-B-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, ctx.arch)
      injectChild(wt, makeChild("tk1", { metadata: { source_phase: "task", dimension: "style", file: "src/b.java", line: 2 } }))
      seedReviewTags(wt)

      await fixIssue(wt, ["tk1"])
      const item = readItem(wt, CID)
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBeUndefined()
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ── Scene C: quality 层 dim issue fixed → 清 verify_tool + 仅该 dim tag ──

describe("sourcePhase C: quality 层 dim issue fixed 只清该 dim tag", () => {
  test("quality style fixed → verify_tool + verify_quality:style 清，verify_task 与其他 dim 保留", async () => {
    const root = `/tmp/sourcePhase-C-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, ctx.arch)
      injectChild(wt, makeChild("q1", { metadata: { source_phase: "quality", dimension: "style", file: "src/c.java", line: 3 } }))
      seedReviewTags(wt)

      await fixIssue(wt, ["q1"])
      const item = readItem(wt, CID)
      // quality fixed 属代码变更 → verify_tool 清
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      // 仅该 dim 的 verify_quality tag 清
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBeUndefined()
      expect(item.tags["verify_quality:openspec-reviewer-architecture"]).toBe("passed")
      expect(item.tags["verify_quality:openspec-reviewer-performance"]).toBe("passed")
      // task 层不受影响
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ── Scene D: quality 层 exempt → 仅清该 dim tag（不改代码不动 verify_tool/verify_task）──

describe("sourcePhase D: quality 层 exempt 仅清该 dim tag", () => {
  test("quality exempt（dim=architecture）→ 仅 verify_quality:architecture 清，verify_tool/task 保留", async () => {
    const root = `/tmp/sourcePhase-D-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, ctx.arch)
      injectChild(wt, makeChild("a1", { metadata: { source_phase: "quality", dimension: "architecture", file: "src/d.java", line: 4 } }))
      seedReviewTags(wt)

      const item0 = readItem(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", exempt_issue_ids: ["a1"], completed_task_ids: taskListOf(item0).map((t: any) => t.id) },
        makeCtx("openspec-developer", wt)
      )
      const item = readItem(wt, CID)
      // exempt 不改代码 → verify_tool/verify_task 保留
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
      // 仅清该 dim
      expect(item.tags["verify_quality:openspec-reviewer-architecture"]).toBeUndefined()
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ── Scene E: task 层 exempt → 清 verify_tool + verify_task ──

describe("sourcePhase E: task 层 exempt 清 verify_tool + verify_task", () => {
  test("task exempt → verify_tool + verify_task 清", async () => {
    const root = `/tmp/sourcePhase-E-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, ctx.arch)
      injectChild(wt, makeChild("te1", { metadata: { source_phase: "task", dimension: "style", file: "src/e.java", line: 5 } }))
      seedReviewTags(wt)

      const item0 = readItem(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", exempt_issue_ids: ["te1"], completed_task_ids: taskListOf(item0).map((t: any) => t.id) },
        makeCtx("openspec-developer", wt)
      )
      const item = readItem(wt, CID)
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBeUndefined()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ── Scene F: 集成路径——review 回退 dev 修复后重置生效 ──

describe("sourcePhase F: 集成路径——review 回退 dev 修复后分层重置生效", () => {
  test("verify_quality failed 回退 implement，dev 修复 style 层 issue → 仅 style dim 重置，tool/task 验证标记保留", async () => {
    const root = `/tmp/sourcePhase-F-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // style reviewer 报 style 层 issue 并 failed → 回 implement
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "failed",
          new_children: [{ id: "q7", title: "Style residual", description: "风格遗留", severity: "Low", source_phase: "quality", dimension: "style", file: "src/f.java", line: 7, suggestion: "改命名" }],
        },
        ctx.dims["style"]
      )
      const back = readItem(wt, CID)
      expect(back.phase).toBe("in_progress")
      expect(back.currentStep).toBe("implement")

      // dev 修复 style 层 issue（代码变更）→ verify_tool 清 + 仅 style dim tag 清，verify_task 保留
      await fixIssue(wt, ["q7"])
      const item = readItem(wt, CID)
      // quality fixed 属代码变更 → verify_tool 清；verify_task 保留；仅 style dim tag 清
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBeUndefined()
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
      expect(item.children.find((c: WorkItem) => c.externalId === "q7").phase).toBe("done")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("tool 层 issue fixed 后 verify_tool 需重跑：re-submit 走 verify_tool 门禁路径", async () => {
    const root = `/tmp/sourcePhase-F2-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      // tool reviewer 报 tool 层 issue 并 failed → 回 implement
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [{ id: "t7", title: "Tool issue", description: "工具层问题", severity: "Low", source_phase: "tool", dimension: "style", file: "src/g.java", line: 8, suggestion: "修复" }],
        },
        ctx.toolR
      )
      // tool 层回退到 implement（rollbackChildren：verify_task/quality tag 被清）
      const item0 = readItem(wt, CID)
      expect(item0.phase).toBe("in_progress")
      expect(item0.currentStep).toBe("implement")
      expect(item0.tags["verify_task:openspec-reviewer-task"]).toBeUndefined()

      // dev 修复 tool 层 issue → 重置 verify_tool tag（此前已 failed 清空，此处保持）
      await fixIssue(wt, ["t7"])
      const item = readItem(wt, CID)
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(item.children.find((c: WorkItem) => c.externalId === "t7").phase).toBe("done")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

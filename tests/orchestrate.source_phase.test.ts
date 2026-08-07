/**
 * issue 报源层归因分层重置测试（新流）
 *
 * 报源层由 child.metadata.source 经 agentToReviewLayer 反推（source_phase 仅作历史 state 兜底），
 * 由 workflow/reset.ts 的 resetReviewTagsOnFix 按层重置：dev 在 implement 提交 fixed/exempt 后
 * 按 issue 报源层重置 review 验证标记；dimension 为归因标签（跨维 issue 修复后目标维 tag 一并清）。
 *
 * 覆盖场景：
 * A. tool 报源层 issue fixed → 清 verify_tool tag（无 dimension 不影响 quality 层）
 * B. task 报源层 issue fixed → 清 verify_tool + verify_task
 * C. quality 报源层 issue fixed（维度 dim）→ 清 verify_tool + 仅该 dim 的 verify_quality tag
 * D. quality 报源层 exempt（不改代码）→ 不清任何维度 tag（exempt=接受现状，已 passed 维度保留）
 * E. task 报源层 exempt → 清 verify_tool + verify_task
 * I. 跨维归因：tool 报源层 issue 带 dimension → fixed 后目标维 verify_quality tag 一并清（无论报源是谁）；
 *    exempt 不清目标维 tag（I2）
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
import { resolveChildIssueFields } from "../src/core/workflow/reset"
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

/** 注入带归因字段的 issue child（metadata.source/source_phase/dimension/file/line/suggestion）。 */
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

// ── Scene A: tool 报源层 issue fixed → 清 verify_tool ──

describe("sourcePhase A: tool 报源层 issue fixed 只清 verify_tool", () => {
  test("tool 报源层 fixed → verify_tool tag 清，verify_task/quality 保留（无 dimension 的 tool issue 不影响 quality 层）", async () => {
    const root = `/tmp/sourcePhase-A-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, ctx.arch)
      injectChild(wt, makeChild("t1", { metadata: { source_phase: "tool", file: "src/a.java", line: 1 } }))
      seedReviewTags(wt)

      await fixIssue(wt, ["t1"])
      const item = readItem(wt, CID)
      // tool 报源层 fixed → verify_tool 清
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      // verify_task 与 verify_quality 保留（tool 层 issue 无 dimension 不触发跨维清 tag）
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
      // child 终态
      expect(item.children.find((c: WorkItem) => c.externalId === "t1").phase).toBe("review")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ── Scene B: task 报源层 issue fixed → 清 verify_tool + verify_task ──

describe("sourcePhase B: task 报源层 issue fixed 清 verify_tool + verify_task", () => {
  test("task 报源层 fixed → verify_tool + verify_task 清，verify_quality 保留", async () => {
    const root = `/tmp/sourcePhase-B-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, ctx.arch)
      injectChild(wt, makeChild("tk1", { metadata: { source_phase: "task", file: "src/b.java", line: 2 } }))
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

// ── Scene D: quality 层 exempt → 不清维度 tag（exempt 不改代码，已 passed 维度保留）──

describe("sourcePhase D: quality 层 exempt 不清维度 tag", () => {
  test("quality exempt（dim=architecture）→ verify_tool/task 保留，verify_quality:architecture 也保留（exempt 不清维度 tag）", async () => {
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
      // exempt 不触发 quality 维度 tag 清除 → 维度 tag 保留 passed（无实际待办的重复调度不再发生）
      expect(item.tags["verify_quality:openspec-reviewer-architecture"]).toBe("passed")
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
      injectChild(wt, makeChild("te1", { metadata: { source_phase: "task", file: "src/e.java", line: 5 } }))
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
  test("verify_quality style failed 聚合回退 implement，dev 修复 style 层 issue → 仅清失败维度与 verify_tool，其余已 passed tag 保留", async () => {
    const root = `/tmp/sourcePhase-F-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // style reviewer 报 style 报源层 issue 并 failed → verify_quality 多 agent step 聚合等待，不立即回退
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "failed",
          new_children: [{ id: "q7", title: "Style residual", description: "风格遗留", severity: "Low", dimension: "style", file: "src/f.java", line: 7, suggestion: "改命名" }],
        },
        ctx.dims["style"]
      )
      let back = readItem(wt, CID)
      expect(back.phase).toBe("review")
      expect(back.currentStep).toBe("verify_quality")
      // 其余 4 维 passed → 全部已裁决 → 聚合回退 implement
      for (const d of ["architecture", "performance", "security", "maintainability"]) {
        await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims[d])
      }
      back = readItem(wt, CID)
      expect(back.phase).toBe("in_progress")
      expect(back.currentStep).toBe("implement")
      // fix2 新语义：review failed 不再全清 → 已 passed 的 verify_tool/verify_task 与其余维度 tag 保留
      expect(back.tags["verify_tool:openspec-reviewer-tool"]).toBe("passed")
      expect(back.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
      expect(back.tags["verify_quality:openspec-reviewer-style"]).toBe("failed")
      expect(back.tags["verify_quality:openspec-reviewer-architecture"]).toBe("passed")

      // dev 修复 style 层 issue（代码变更）→ reset 按归因清 verify_quality:style + verify_tool；verify_task 与其余维度保留
      await fixIssue(wt, ["q7"])
      const item = readItem(wt, CID)
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBeUndefined()
      expect(item.tags["verify_quality:openspec-reviewer-architecture"]).toBe("passed")
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
      expect(item.children.find((c: WorkItem) => c.externalId === "q7").phase).toBe("review")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("tool 层 issue fixed 后 verify_tool 需重跑：re-submit 走 verify_tool 门禁路径", async () => {
    const root = `/tmp/sourcePhase-F2-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      // tool reviewer 报 tool 报源层 issue 并 failed → 回 implement
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_tool", verdict: "failed",
          new_children: [{ id: "t7", title: "Tool issue", description: "工具层问题", severity: "Low", dimension: "style", file: "src/g.java", line: 8, suggestion: "修复" }],
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
      expect(item.children.find((c: WorkItem) => c.externalId === "t7").phase).toBe("review")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ── Scene G: 报源反推归因——quality reviewer 提报缺 source_phase 也归因 quality（死锁根因场景）──

describe("sourcePhase G: quality reviewer 提报 → 由 source 反推归因 quality → 回退重审期按维重置", () => {
  test("architecture reviewer 提报 issue → source 反推归因 quality → dev 修复后 verify_quality:architecture tag 被重置", async () => {
    const root = `/tmp/sourcePhase-G-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const { ctx } = await driveToQuality(wt, CID)
      // architecture reviewer 报 issue 只写 dimension，不写（已删除的）source_phase（死锁根因场景：归因 tool → 维 tag 永不清）
      await agent_submit.execute(
        {
          change_id: CID, step_id: "verify_quality", verdict: "failed",
          new_children: [{ id: "g1", title: "架构遗留", description: "缺 source_phase", severity: "Low", dimension: "architecture", file: "src/g1.java", line: 9, suggestion: "改设计" }],
        },
        ctx.dims["architecture"]
      )
      let item = readItem(wt, CID)
      const child = item.children.find((c: WorkItem) => c.externalId === "g1")
      // 报源反推归因：architecture reviewer 提报 → 报源层 quality（source 反查命中维度）
      expect(child.metadata["source"]).toBe("openspec-reviewer-architecture")
      expect(resolveChildIssueFields(child).sourcePhase).toBe("quality")

      // 其余 4 维 passed → 聚合回退 implement；architecture failed tag 残留
      for (const d of ["style", "performance", "security", "maintainability"]) {
        await agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims[d])
      }
      item = readItem(wt, CID)
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
      expect(item.tags["verify_quality:openspec-reviewer-architecture"]).toBe("failed")

      // dev 修复 → resetReviewTagsOnFix 按报源层 quality 归因清 architecture 维 tag（死锁打破）
      await fixIssue(wt, ["g1"])
      item = readItem(wt, CID)
      expect(item.tags["verify_quality:openspec-reviewer-architecture"]).toBeUndefined()
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
      expect(item.children.find((c: WorkItem) => c.externalId === "g1").phase).toBe("review")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ── Scene H: 报源兜底归因——历史 state（source 为 quality reviewer、无 source_phase）也按维重置 ──

describe("sourcePhase H: source 为 quality reviewer 的历史 child → 报源反推按维重置", () => {
  test("legacy child（metadata.source=architecture reviewer、无 source_phase）fixed → verify_quality:architecture tag 被重置", async () => {
    const root = `/tmp/sourcePhase-H-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, ctx.arch)
      // 模拟修复前遗留 state：报源为 quality reviewer（metadata.source）但 source_phase 缺失（历史格式）
      injectChild(wt, makeChild("h1", { metadata: { source: "openspec-reviewer-architecture", dimension: "architecture", file: "src/h.java", line: 10 } }))
      seedReviewTags(wt)

      await fixIssue(wt, ["h1"])
      const item = readItem(wt, CID)
      // 报源反推：source=architecture reviewer → quality 层 + 维度 architecture → 该维 tag 清
      expect(item.tags["verify_quality:openspec-reviewer-architecture"]).toBeUndefined()
      // 其余维度 tag 保留
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
      // 报源是 quality reviewer 而非 tool/task 层 → 不清 verify_tool 维度逻辑之外的层级（fixed 属代码变更仍清 verify_tool）
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      expect(item.children.find((c: WorkItem) => c.externalId === "h1").phase).toBe("review")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ── Scene I: 跨维归因——tool 报源层 issue 带 dimension → 修复后目标维 tag 一并清（无论报源是谁）──

describe("sourcePhase I: tool 跨维报 issue（带 dimension）→ dev 修复后目标维 verify_quality tag 清", () => {
  test("tool reviewer 报 dimension=security 的 issue → fixed 后 verify_tool 与 verify_quality:security 都清（防跨维死锁）", async () => {
    const root = `/tmp/sourcePhase-I-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, ctx.arch)
      // tool 报源层 issue 带 dimension（跨维归因标签）
      injectChild(wt, makeChild("i1", { metadata: { source_phase: "tool", dimension: "security", file: "src/i.java", line: 11 } }))
      seedReviewTags(wt)

      await fixIssue(wt, ["i1"])
      const item = readItem(wt, CID)
      // 报源层 tag 必清：tool 跨维 issue 修复后 verify_tool 重跑
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      // 归因维 tag 清：目标维 security 的 verify_quality tag 一并清（谁提谁裁定 + 跨维防御）
      expect(item.tags["verify_quality:openspec-reviewer-security"]).toBeUndefined()
      // 非目标维保留
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
      expect(item.children.find((c: WorkItem) => c.externalId === "i1").phase).toBe("review")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ── Scene I2: 跨维归因 exempt 镜像——tool 报源 + 显式 dimension + dev exempt → 目标维度 tag 保留 ──

describe("sourcePhase I2: tool 跨维报 issue（带 dimension）→ dev exempt 不清目标维 verify_quality tag", () => {
  test("tool reviewer 报 dimension=security 的 issue → exempt 后 verify_tool 清（谁提谁裁定）、verify_quality:security 保留（exempt 不改代码）", async () => {
    const root = `/tmp/sourcePhase-I2-${Date.now()}`
    const { wt } = freshSetup(root)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await agent_submit.execute({ change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: EB }, ctx.arch)
      // tool 报源层 issue 带 dimension（跨维归因标签）
      injectChild(wt, makeChild("i2", { metadata: { source_phase: "tool", dimension: "security", file: "src/i2.java", line: 12 } }))
      seedReviewTags(wt)

      const item0 = readItem(wt, CID)
      await agent_submit.execute(
        { change_id: CID, step_id: "implement", verdict: "passed", exempt_issue_ids: ["i2"], completed_task_ids: taskListOf(item0).map((t: any) => t.id) },
        makeCtx("openspec-developer", wt)
      )
      const item = readItem(wt, CID)
      // 报源层 tag 仍清：tool 报源 exempt 清 verify_tool——「谁提谁裁定」派发 tool reviewer 裁定豁免申请的通道，保持不动
      expect(item.tags["verify_tool:openspec-reviewer-tool"]).toBeUndefined()
      // exempt 不触发维度 tag 清除 → 目标维 security 保留（此前 fixed 场景会清，exempt 不清）
      expect(item.tags["verify_quality:openspec-reviewer-security"]).toBe("passed")
      // 其余维度与 task 层保留
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
      expect(item.tags["verify_task:openspec-reviewer-task"]).toBe("passed")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
